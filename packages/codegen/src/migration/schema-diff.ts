import { validateRenameHints } from './rename-hints.js';
import type { RenameHint } from './rename-hints.js';
import type { MigrationSafety } from './types.js';
import type { ColumnState, SchemaSnapshotV1, TableState, ViewState } from './snapshot-types.js';

export type { RenameHint } from './rename-hints.js';

/** One bounded semantic change consumed by the PostgreSQL renderer. */
export interface SchemaChange {
  /** Stable object-specific change discriminator. */
  readonly kind:
    | 'extension.add'
    | 'extension.drop'
    | 'schema.add'
    | 'schema.drop'
    | 'table.add'
    | 'table.drop'
    | 'table.rename'
    | 'column.add'
    | 'column.drop'
    | 'column.rename'
    | 'column.type'
    | 'column.generated'
    | 'column.identity'
    | 'column.default'
    | 'column.nullability'
    | 'constraint.add'
    | 'constraint.drop'
    | 'index.add'
    | 'index.drop'
    | 'comment.set'
    | 'view.add'
    | 'view.drop'
    | 'view.replace';
  /** Required operator-safety classification. */
  readonly safety: MigrationSafety;
  /** Schema identity when applicable. */
  readonly schema?: string;
  /** Table identity when applicable. */
  readonly table?: string;
  /** Prior or added object name. */
  readonly name?: string;
  /** Approved rename target. */
  readonly newName?: string;
  /** Complete table definition for table creation. */
  readonly tableState?: TableState;
  /** Complete column definition for column operations. */
  readonly columnState?: ColumnState;
  /** Complete prior column definition for transitions. */
  readonly previousColumnState?: ColumnState;
  /** Complete view definition for view operations. */
  readonly viewState?: ViewState;
  /** Constraint or index data copied from the canonical snapshot. */
  readonly definition?: Readonly<Record<string, unknown>>;
  /** Human-readable reason when automatic SQL is intentionally blocked. */
  readonly guidance?: string;
}

/** Immutable semantic diff and safety-class totals. */
export interface SchemaDiffResult {
  /** Deterministically ordered modeled changes. */
  readonly changes: readonly SchemaChange[];
  /** Count of changes in each safety class. */
  readonly summary: Readonly<Record<MigrationSafety, number>>;
}

/**
 * Compares two canonical snapshots without generating SQL.
 *
 * @param previous - Last committed desired state.
 * @param desired - Newly normalized desired state.
 * @param renameHints - Explicit one-to-one table and column mappings.
 * @returns Typed changes plus safety totals.
 * @throws {MigrationError} When rename hints are malformed, cyclic, or do not match both states.
 */
export function diffSnapshots(
  previous: SchemaSnapshotV1,
  desired: SchemaSnapshotV1,
  renameHints: readonly RenameHint[] = []
): SchemaDiffResult {
  validateRenameHints(previous, desired, renameHints);
  const changes: SchemaChange[] = [];
  diffNamedSet(previous.extensions, desired.extensions, 'extension', changes);
  diffNamedSet(previous.schemas, desired.schemas, 'schema', changes, desired.defaultSchema);

  const previousTables = new Map(previous.tables.map(table => [tableIdentity(table), table]));
  const desiredTables = new Map(desired.tables.map(table => [tableIdentity(table), table]));
  const tableHints = renameHints.filter(hint => hint.kind === 'table');
  const hintedPriorTables = new Set(tableHints.map(hint => hint.from));
  const hintedDesiredTables = new Set(tableHints.map(hint => hint.to));

  for (const hint of tableHints) {
    const before = previousTables.get(hint.from);
    const after = desiredTables.get(hint.to);
    if (!before || !after) continue;
    changes.push({
      kind: 'table.rename',
      safety: 'safe',
      schema: before.schema,
      name: before.name,
      newName: after.name,
    });
    diffTable(before, after, renameHints, changes);
  }

  const removedTables = previous.tables.filter(
    table =>
      !desiredTables.has(tableIdentity(table)) && !hintedPriorTables.has(tableIdentity(table))
  );
  const addedTables = desired.tables.filter(
    table =>
      !previousTables.has(tableIdentity(table)) && !hintedDesiredTables.has(tableIdentity(table))
  );
  pairApparentTableRenames(removedTables, addedTables, changes);

  const ambiguousRemoved = new Set(
    changes
      .filter(change => change.kind === 'table.rename')
      .map(change => `${change.schema}.${change.name}`)
  );
  const ambiguousAdded = new Set(
    changes
      .filter(change => change.kind === 'table.rename')
      .map(change => `${change.schema}.${change.newName}`)
  );
  for (const table of removedTables) {
    if (!ambiguousRemoved.has(tableIdentity(table))) {
      changes.push({
        kind: 'table.drop',
        safety: 'destructive',
        schema: table.schema,
        name: table.name,
        definition: {
          referencedTables: table.foreignKeys.map(
            foreignKey => `${foreignKey.referencedSchema}.${foreignKey.referencedTable}`
          ),
        },
      });
    }
  }
  for (const table of addedTables) {
    if (!ambiguousAdded.has(tableIdentity(table))) {
      changes.push({
        kind: 'table.add',
        safety: 'safe',
        schema: table.schema,
        name: table.name,
        tableState: table,
      });
      appendNestedAdds(table, changes);
    }
  }
  for (const [identity, before] of previousTables) {
    const after = desiredTables.get(identity);
    if (after) diffTable(before, after, renameHints, changes);
  }

  diffViews(previous.views, desired.views, changes);
  changes.sort(compareChanges);
  return { changes, summary: summarize(changes) };
}

/** Adds and removes extensions or schemas by exact identity. */
function diffNamedSet(
  previous: readonly { readonly name: string }[],
  desired: readonly { readonly name: string }[],
  kind: 'extension' | 'schema',
  changes: SchemaChange[],
  protectedName?: string
): void {
  const before = new Set(previous.map(item => item.name));
  const after = new Set(desired.map(item => item.name));
  for (const name of after)
    if (!before.has(name)) changes.push({ kind: `${kind}.add`, safety: 'safe', name });
  for (const name of before) {
    if (!after.has(name) && name !== protectedName)
      changes.push({ kind: `${kind}.drop`, safety: 'destructive', name });
  }
}

/** Finds structural table rename candidates without relying on name similarity. */
function pairApparentTableRenames(
  removed: readonly TableState[],
  added: readonly TableState[],
  changes: SchemaChange[]
): void {
  for (const before of removed) {
    const candidates = added.filter(after => sameTableShape(before, after));
    if (candidates.length === 1) {
      changes.push({
        kind: 'table.rename',
        safety: 'ambiguous',
        schema: before.schema,
        name: before.name,
        newName: candidates[0]?.name,
        guidance: 'Provide one explicit table rename hint.',
      });
    }
  }
}

/** Compares supported properties inside one matched table. */
function diffTable(
  before: TableState,
  after: TableState,
  hints: readonly RenameHint[],
  changes: SchemaChange[]
): void {
  if (before.name !== after.name && sameTableShape(before, after)) return;
  const beforeColumns = new Map(before.columns.map(column => [column.name, column]));
  const afterColumns = new Map(after.columns.map(column => [column.name, column]));
  const prefixBefore = `${before.schema}.${before.name}.`;
  const prefixAfter = `${after.schema}.${after.name}.`;
  const columnHints = hints.filter(
    hint =>
      hint.kind === 'column' &&
      hint.from.startsWith(prefixBefore) &&
      hint.to.startsWith(prefixAfter)
  );
  const hintedBefore = new Set(columnHints.map(hint => lastSegment(hint.from)));
  const hintedAfter = new Set(columnHints.map(hint => lastSegment(hint.to)));

  for (const hint of columnHints) {
    const priorName = lastSegment(hint.from);
    const desiredName = lastSegment(hint.to);
    const prior = beforeColumns.get(priorName);
    const desired = afterColumns.get(desiredName);
    if (!prior || !desired) continue;
    changes.push({
      kind: 'column.rename',
      safety: 'safe',
      schema: after.schema,
      table: after.name,
      name: priorName,
      newName: desiredName,
    });
    diffColumn(after, prior, desired, changes);
  }

  const removed = before.columns.filter(
    column => !afterColumns.has(column.name) && !hintedBefore.has(column.name)
  );
  const added = after.columns.filter(
    column => !beforeColumns.has(column.name) && !hintedAfter.has(column.name)
  );
  const pairedAdded = new Set<string>();
  for (const prior of removed) {
    const candidates = added.filter(column => sameColumnShape(prior, column));
    if (candidates.length === 1) {
      const candidate = candidates[0];
      if (candidate) {
        pairedAdded.add(candidate.name);
        changes.push({
          kind: 'column.rename',
          safety: 'ambiguous',
          schema: after.schema,
          table: after.name,
          name: prior.name,
          newName: candidate.name,
          guidance: 'Provide one explicit column rename hint.',
        });
        continue;
      }
    }
    changes.push({
      kind: 'column.drop',
      safety: 'destructive',
      schema: after.schema,
      table: after.name,
      name: prior.name,
    });
  }
  for (const column of added) {
    if (!pairedAdded.has(column.name)) {
      changes.push({
        kind: 'column.add',
        safety: column.nullable ? 'safe' : 'caution',
        schema: after.schema,
        table: after.name,
        name: column.name,
        columnState: column,
        ...(!column.nullable
          ? { guidance: 'Use a staged population strategy for a required column.' }
          : {}),
      });
      if (column.comment !== undefined) {
        changes.push({
          kind: 'comment.set',
          safety: 'safe',
          schema: after.schema,
          table: after.name,
          name: column.name,
          definition: { comment: column.comment },
        });
      }
    }
  }
  for (const [name, prior] of beforeColumns) {
    const desired = afterColumns.get(name);
    if (desired) diffColumn(after, prior, desired, changes);
  }
  if (before.name !== after.name) {
    if (!sameValue(collectionShape(before), collectionShape(after))) {
      changes.push({
        kind: 'constraint.add',
        safety: 'unsupported',
        schema: after.schema,
        table: after.name,
        guidance: 'Constraint or index changes combined with a table rename require manual SQL.',
      });
    }
  } else {
    diffTableCollections(before, after, changes);
  }
  if (before.comment !== after.comment) {
    changes.push({
      kind: 'comment.set',
      safety: 'safe',
      schema: after.schema,
      table: after.name,
      definition: { comment: after.comment ?? null },
    });
  }
}

/** Classifies supported single-column transitions. */
function diffColumn(
  table: TableState,
  before: ColumnState,
  after: ColumnState,
  changes: SchemaChange[]
): void {
  const base = {
    schema: table.schema,
    table: table.name,
    name: after.name,
    columnState: after,
    previousColumnState: before,
  };
  if (before.type !== after.type || before.size !== after.size || before.scale !== after.scale) {
    changes.push({
      kind: 'column.type',
      safety: 'unsupported',
      ...base,
      guidance: 'Provide reviewed manual SQL with an explicit USING expression.',
    });
  }
  if (
    before.generatedExpression !== after.generatedExpression ||
    before.generatedStored !== after.generatedStored
  ) {
    changes.push({
      kind: 'column.generated',
      safety: 'unsupported',
      ...base,
      guidance: 'Generated-column transitions require reviewed manual SQL.',
    });
  }
  if (
    before.identityGeneration !== after.identityGeneration ||
    !sameValue(before.identityOptions, after.identityOptions)
  ) {
    changes.push({
      kind: 'column.identity',
      safety: 'unsupported',
      ...base,
      guidance: 'Identity transitions require reviewed manual SQL.',
    });
  }
  if (before.default !== after.default)
    changes.push({ kind: 'column.default', safety: 'safe', ...base });
  if (before.nullable !== after.nullable) {
    changes.push({
      kind: 'column.nullability',
      safety: after.nullable ? 'safe' : 'caution',
      ...base,
      ...(!after.nullable
        ? { guidance: 'Populate and validate existing rows before SET NOT NULL.' }
        : {}),
    });
  }
  if (before.comment !== after.comment) {
    changes.push({
      kind: 'comment.set',
      safety: 'safe',
      schema: table.schema,
      table: table.name,
      name: after.name,
      definition: { comment: after.comment ?? null },
    });
  }
}

/** Emits additions/removals for canonical constraints and indexes. */
function diffTableCollections(
  before: TableState,
  after: TableState,
  changes: SchemaChange[]
): void {
  const beforeConstraints = constraintMap(before);
  const afterConstraints = constraintMap(after);
  if (before.primaryKey && after.primaryKey && !sameValue(before.primaryKey, after.primaryKey)) {
    beforeConstraints.delete(before.primaryKey.name);
    afterConstraints.delete(after.primaryKey.name);
    changes.push({
      kind: 'constraint.add',
      safety: 'unsupported',
      schema: after.schema,
      table: after.name,
      name: after.primaryKey.name,
      definition: after.primaryKey,
      guidance: 'Primary-key replacements require reviewed manual SQL.',
    });
  }
  diffDefinitions(beforeConstraints, afterConstraints, 'constraint', after, changes);
  diffDefinitions(
    new Map(before.indexes.map(item => [item.name, item])),
    new Map(after.indexes.map(item => [item.name, item])),
    'index',
    after,
    changes
  );
}

/** Emits independent additions/removals and blocks same-name replacements. */
function diffDefinitions(
  before: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  after: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  kind: 'constraint' | 'index',
  table: TableState,
  changes: SchemaChange[]
): void {
  for (const [name, definition] of before) {
    const desired = after.get(name);
    if (!desired) {
      changes.push({
        kind: `${kind}.drop`,
        safety: 'destructive',
        schema: table.schema,
        table: table.name,
        name,
        definition,
      });
    }
  }
  for (const [name, definition] of after) {
    const prior = before.get(name);
    if (!prior) {
      changes.push({
        kind: `${kind}.add`,
        safety: 'safe',
        schema: table.schema,
        table: table.name,
        name,
        definition,
      });
    } else if (!sameValue(prior, definition)) {
      changes.push({
        kind: `${kind}.add`,
        safety: 'unsupported',
        schema: table.schema,
        table: table.name,
        name,
        definition,
        guidance: `Same-name ${kind} replacements require reviewed manual SQL.`,
      });
    }
  }
}

/** Emits all nested objects after a new table's base definition. */
function appendNestedAdds(table: TableState, changes: SchemaChange[]): void {
  for (const [name, definition] of constraintMap(table)) {
    changes.push({
      kind: 'constraint.add',
      safety: 'safe',
      schema: table.schema,
      table: table.name,
      name,
      definition,
    });
  }
  for (const definition of table.indexes) {
    changes.push({
      kind: 'index.add',
      safety: 'safe',
      schema: table.schema,
      table: table.name,
      name: definition.name,
      definition,
    });
  }
  if (table.comment !== undefined) {
    changes.push({
      kind: 'comment.set',
      safety: 'safe',
      schema: table.schema,
      table: table.name,
      definition: { comment: table.comment },
    });
  }
  for (const column of table.columns) {
    if (column.comment !== undefined) {
      changes.push({
        kind: 'comment.set',
        safety: 'safe',
        schema: table.schema,
        table: table.name,
        name: column.name,
        definition: { comment: column.comment },
      });
    }
  }
}

/** Compares views conservatively because arbitrary dependency SQL is opaque. */
function diffViews(
  before: readonly ViewState[],
  after: readonly ViewState[],
  changes: SchemaChange[]
): void {
  const prior = new Map(before.map(view => [viewIdentity(view), view]));
  const desired = new Map(after.map(view => [viewIdentity(view), view]));
  const addedViews = after.filter(view => !prior.has(viewIdentity(view)));
  const removedViews = before.filter(view => !desired.has(viewIdentity(view)));
  for (const view of before)
    if (!desired.has(viewIdentity(view)))
      changes.push({
        kind: 'view.drop',
        safety: removedViews.length === 1 && before.length === 1 ? 'destructive' : 'unsupported',
        schema: view.schema,
        name: view.name,
        viewState: view,
        ...(removedViews.length === 1 && before.length === 1
          ? {}
          : { guidance: 'View removal dependencies require reviewed manual SQL.' }),
      });
  for (const view of after) {
    const existing = prior.get(viewIdentity(view));
    if (!existing) {
      changes.push({
        kind: 'view.add',
        safety: addedViews.length === 1 ? 'safe' : 'unsupported',
        schema: view.schema,
        name: view.name,
        viewState: view,
        ...(addedViews.length === 1
          ? {}
          : { guidance: 'Multiple view dependencies require reviewed manual SQL.' }),
      });
      if (view.comment !== undefined && addedViews.length === 1) {
        changes.push({
          kind: 'comment.set',
          safety: 'safe',
          schema: view.schema,
          name: view.name,
          definition: {
            comment: view.comment,
            target: view.materialized ? 'materializedView' : 'view',
          },
        });
      }
    } else if (!sameValue(existing, view))
      changes.push({
        kind: 'view.replace',
        safety: 'unsupported',
        schema: view.schema,
        name: view.name,
        viewState: view,
        guidance: 'View dependency order requires reviewed manual SQL.',
      });
  }
}

/** Maps every canonical constraint by stable name. */
function constraintMap(table: TableState): Map<string, Readonly<Record<string, unknown>>> {
  const values: Readonly<Record<string, unknown>>[] = [
    ...(table.primaryKey ? [table.primaryKey] : []),
    ...table.uniqueConstraints,
    ...table.checkConstraints,
    ...table.foreignKeys,
  ];
  return new Map(values.map(value => [String(value.name), value]));
}

/** Compares table structure while ignoring only its identity. */
function sameTableShape(before: TableState, after: TableState): boolean {
  return sameValue(tableShape(before), tableShape(after));
}

/** Removes identity-derived names while retaining every modeled table property. */
function tableShape(table: TableState): Readonly<Record<string, unknown>> {
  return {
    columns: table.columns,
    ...collectionShape(table),
    comment: table.comment,
  };
}

/** Removes identity-derived names from constraints and indexes for rename comparison. */
function collectionShape(table: TableState): Readonly<Record<string, unknown>> {
  return {
    primaryKey: table.primaryKey?.columns,
    uniqueConstraints: table.uniqueConstraints.map(item => item.columns),
    checkConstraints: table.checkConstraints.map(item => item.expression),
    foreignKeys: table.foreignKeys.map(item => ({
      columns: item.columns,
      referencedSchema: item.referencedSchema,
      referencedTable: item.referencedTable === table.name ? '<self>' : item.referencedTable,
      referencedColumns: item.referencedColumns,
      onUpdate: item.onUpdate,
      onDelete: item.onDelete,
    })),
    indexes: table.indexes.map(item => ({
      columns: item.columns,
      unique: item.unique,
      method: item.method,
      where: item.where,
      concurrent: item.concurrent,
      include: item.include,
      expression: item.expression,
      storageParams: item.storageParams,
      tablespace: item.tablespace,
    })),
  };
}

/** Compares column structure while ignoring only its identity. */
function sameColumnShape(before: ColumnState, after: ColumnState): boolean {
  return sameValue({ ...before, name: '' }, { ...after, name: '' });
}

/** Canonical data has stable key ordering, making JSON equality deterministic. */
function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Returns the final qualified-name segment. */
function lastSegment(identity: string): string {
  return identity.slice(identity.lastIndexOf('.') + 1);
}

/** Returns one table identity. */
function tableIdentity(table: TableState): string {
  return `${table.schema}.${table.name}`;
}

/** Returns one view identity. */
function viewIdentity(view: ViewState): string {
  return `${view.schema}.${view.name}`;
}

/** Stable ordering by renderer phase then qualified identity. */
function compareChanges(left: SchemaChange, right: SchemaChange): number {
  const phase = (change: SchemaChange) => change.kind.split('.')[0] ?? '';
  const leftKey = `${phase(left)}:${left.schema ?? ''}.${left.table ?? ''}.${left.name ?? ''}`;
  const rightKey = `${phase(right)}:${right.schema ?? ''}.${right.table ?? ''}.${right.name ?? ''}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

/** Counts every safety class without dropping zero values. */
function summarize(changes: readonly SchemaChange[]): Readonly<Record<MigrationSafety, number>> {
  const summary: Record<MigrationSafety, number> = {
    safe: 0,
    caution: 0,
    destructive: 0,
    ambiguous: 0,
    unsupported: 0,
  };
  for (const change of changes) summary[change.safety] += 1;
  return summary;
}
