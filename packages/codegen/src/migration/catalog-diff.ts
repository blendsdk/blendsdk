import type { UnmanagedCatalogObject } from './unmanaged-catalog.js';
import type { SchemaSnapshotV1, TableState } from './snapshot-types.js';

/** Stable classification for one baseline-adoption comparison entry. */
export type CatalogClassification =
  'MATCH' | 'MISSING' | 'DIFFERENT' | 'EXTRA_MODELED' | 'UNMANAGED' | 'UNSUPPORTED_FOR_ADOPTION';

/** One sanitized, qualified structural comparison result. */
export interface CatalogComparisonItem {
  /** Whether the desired and live objects agree, or why adoption cannot continue. */
  readonly classification: CatalogClassification;
  /** Stable qualified object identity without SQL text or connection data. */
  readonly identity: string;
}

/** Complete structural comparison used by preview and authoritative adoption checks. */
export interface CatalogComparison {
  /** Stable object-by-object comparison, including informational unmanaged objects. */
  readonly items: readonly CatalogComparisonItem[];
  /** True only when no entry prevents baseline adoption. */
  readonly compatible: boolean;
}

interface ComparableObject {
  readonly identity: string;
  readonly value: string;
}

/**
 * Compares desired and live supported PostgreSQL state by canonical object identity.
 *
 * SQL-backed desired properties are rejected rather than parsed semantically. PostgreSQL can
 * rewrite equivalent SQL expressions, so string comparison would create unsafe false matches.
 */
export function compareCatalogs(
  desired: SchemaSnapshotV1,
  live: SchemaSnapshotV1,
  unmanaged: readonly UnmanagedCatalogObject[] = []
): CatalogComparison {
  const unsupported = unsupportedDesiredObjects(desired);
  const desiredObjects = modeledObjects(desired);
  const liveObjects = modeledObjects(live);
  const desiredByIdentity = new Map(desiredObjects.map(item => [item.identity, item]));
  const liveByIdentity = new Map(liveObjects.map(item => [item.identity, item]));
  const identities = [...new Set([...desiredByIdentity.keys(), ...liveByIdentity.keys()])].sort();
  const items: CatalogComparisonItem[] = [...unsupported];

  for (const identity of identities) {
    const desiredObject = desiredByIdentity.get(identity);
    const liveObject = liveByIdentity.get(identity);
    if (!desiredObject) items.push({ classification: 'EXTRA_MODELED', identity });
    else if (!liveObject) items.push({ classification: 'MISSING', identity });
    else {
      items.push({
        classification: desiredObject.value === liveObject.value ? 'MATCH' : 'DIFFERENT',
        identity,
      });
    }
  }

  for (const object of unmanaged) {
    items.push({
      classification:
        object.blocksAdoption || desiredUsesUnmanagedType(desired, object)
          ? 'UNSUPPORTED_FOR_ADOPTION'
          : 'UNMANAGED',
      identity: object.identity,
    });
  }
  items.sort((left, right) =>
    left.identity === right.identity
      ? left.classification.localeCompare(right.classification)
      : left.identity.localeCompare(right.identity)
  );
  return {
    items,
    compatible: items.every(
      item => item.classification === 'MATCH' || item.classification === 'UNMANAGED'
    ),
  };
}

/** Blocks adoption when modeled columns rely on a type outside the v1 snapshot model. */
function desiredUsesUnmanagedType(
  desired: SchemaSnapshotV1,
  object: UnmanagedCatalogObject
): boolean {
  if (object.kind !== 'type') return false;
  const separator = object.identity.lastIndexOf('.');
  const type = object.identity.slice(separator + 1);
  return desired.tables.some(table =>
    table.columns.some(column => column.type === object.identity || column.type === type)
  );
}

/** Flattens canonical state so extra nested objects retain their own classifications. */
function modeledObjects(snapshot: SchemaSnapshotV1): readonly ComparableObject[] {
  const objects: ComparableObject[] = [
    comparable('database.defaultSchema', snapshot.defaultSchema),
    ...snapshot.extensions.map(extension => comparable(`extension.${extension.name}`, extension)),
    ...snapshot.schemas.map(schema => comparable(`schema.${schema.name}`, schema)),
    ...snapshot.views.map(view => comparable(`view.${view.schema}.${view.name}`, view)),
  ];
  for (const table of snapshot.tables) objects.push(...tableObjects(table));
  return objects;
}

/** Flattens one table while retaining qualified identities for its nested objects. */
function tableObjects(table: TableState): readonly ComparableObject[] {
  const tableIdentity = `${table.schema}.${table.name}`;
  const tableShell = {
    schema: table.schema,
    name: table.name,
    ...(table.comment !== undefined ? { comment: table.comment } : {}),
  };
  return [
    comparable(`table.${tableIdentity}`, tableShell),
    ...table.columns.map(column =>
      comparable(`column.${tableIdentity}.${column.name}`, comparableColumn(column))
    ),
    ...(table.primaryKey
      ? [comparable(`constraint.${tableIdentity}.${table.primaryKey.name}`, table.primaryKey)]
      : []),
    ...table.uniqueConstraints.map(constraint =>
      comparable(`constraint.${tableIdentity}.${constraint.name}`, constraint)
    ),
    ...table.checkConstraints.map(constraint =>
      comparable(`constraint.${tableIdentity}.${constraint.name}`, constraint)
    ),
    ...table.foreignKeys.map(constraint =>
      comparable(`constraint.${tableIdentity}.${constraint.name}`, constraint)
    ),
    ...table.indexes.map(index =>
      comparable(`index.${tableIdentity}.${index.name}`, comparableIndex(index))
    ),
  ];
}

/** Normalizes PostgreSQL aliases and implicit identity defaults for structural equality. */
function comparableColumn(column: TableState['columns'][number]): unknown {
  const identityOptions = column.identityOptions;
  const type = column.type === 'decimal' ? 'numeric' : column.type;
  const implicitSize =
    (type === 'char' && (column.size === undefined || column.size === 1)) ||
    ((type === 'time' || type === 'timestamp' || type === 'timestamptz') &&
      (column.size === undefined || column.size === 6));
  const maximumDefaults: Readonly<Record<string, number>> = {
    smallint: 32767,
    integer: 2147483647,
  };
  const normalizedOptions = identityOptions
    ? {
        ...(identityOptions.start !== undefined && identityOptions.start !== 1
          ? { start: identityOptions.start }
          : {}),
        ...(identityOptions.increment !== undefined && identityOptions.increment !== 1
          ? { increment: identityOptions.increment }
          : {}),
        ...(identityOptions.minValue !== undefined && identityOptions.minValue !== 1
          ? { minValue: identityOptions.minValue }
          : {}),
        ...(identityOptions.maxValue !== undefined &&
        identityOptions.maxValue !== maximumDefaults[column.type]
          ? { maxValue: identityOptions.maxValue }
          : {}),
        ...(identityOptions.cache !== undefined && identityOptions.cache !== 1
          ? { cache: identityOptions.cache }
          : {}),
        ...(identityOptions.cycle === true ? { cycle: true } : {}),
      }
    : undefined;
  return {
    ...column,
    type,
    size: implicitSize ? undefined : column.size,
    identityOptions:
      normalizedOptions && Object.keys(normalizedOptions).length > 0
        ? normalizedOptions
        : undefined,
  };
}

/** Removes creation-only concurrency and normalizes implicit index values. */
function comparableIndex(index: TableState['indexes'][number]): unknown {
  return {
    ...index,
    concurrent: undefined,
    method: index.method === 'btree' ? undefined : index.method,
    storageParams: index.storageParams
      ? Object.fromEntries(
          Object.entries(index.storageParams).map(([key, value]) => [key, String(value)])
        )
      : undefined,
  };
}

/** Serializes already-canonical data for exact structural comparison. */
function comparable(identity: string, value: unknown): ComparableObject {
  return { identity, value: JSON.stringify(value) };
}

/** Finds desired SQL-backed properties whose semantic equivalence cannot be proven structurally. */
function unsupportedDesiredObjects(snapshot: SchemaSnapshotV1): readonly CatalogComparisonItem[] {
  const items: CatalogComparisonItem[] = snapshot.views.map(view => ({
    classification: 'UNSUPPORTED_FOR_ADOPTION',
    identity: `view.${view.schema}.${view.name}`,
  }));
  for (const table of snapshot.tables) {
    const tableIdentity = `${table.schema}.${table.name}`;
    for (const column of table.columns) {
      if (typeof column.default === 'string' || column.generatedExpression !== undefined) {
        items.push({
          classification: 'UNSUPPORTED_FOR_ADOPTION',
          identity: `column.${tableIdentity}.${column.name}`,
        });
      }
    }
    for (const constraint of table.checkConstraints) {
      items.push({
        classification: 'UNSUPPORTED_FOR_ADOPTION',
        identity: `constraint.${tableIdentity}.${constraint.name}`,
      });
    }
    for (const index of table.indexes) {
      if (index.expression !== undefined || index.where !== undefined) {
        items.push({
          classification: 'UNSUPPORTED_FOR_ADOPTION',
          identity: `index.${tableIdentity}.${index.name}`,
        });
      }
    }
  }
  return items;
}
