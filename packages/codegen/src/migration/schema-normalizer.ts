import { createHash } from 'node:crypto';
import type { ConstraintBase } from '../database/schema/constraint-base.js';
import type { DatabaseSchema } from '../database/schema/database-schema.js';
import type { IndexConstraint } from '../database/schema/index-constraint.js';
import type { TableColumnSchema } from '../database/schema/table-column-schema.js';
import type { TableSchema } from '../database/schema/table-schema.js';
import type { ViewSchema } from '../database/schema/view-schema.js';
import { MigrationError } from './errors.js';
import type { ColumnState, SchemaSnapshotV1, TableState, ViewState } from './snapshot-types.js';
import { validateSchemaSnapshot } from './snapshot-types.js';

/**
 * Copies the public schema graph into deterministic, versioned, data-only state.
 *
 * Input collections are copied before sorting. The function never calls mutating builder methods
 * and never stores the database name, paths, credentials, or runtime values.
 *
 * @param database - Desired schema authored through the existing BlendSDK schema API.
 * @returns Strict canonical version-one data.
 * @throws {MigrationError} When modeled identities or properties are ambiguous or unsupported.
 */
export function normalizeDatabaseSchema(database: DatabaseSchema): SchemaSnapshotV1 {
  const defaultSchema = validIdentifier(database.getDefaultSchema(), 'default schema');
  const tables = database.getTables().map(normalizeTable).sort(compareQualified);
  const views = database.getViews().map(normalizeView).sort(compareQualified);
  assertUnique(tables.map(qualifiedName), 'table');
  assertUnique(views.map(qualifiedName), 'view');

  const extensions = [...database.getExtensions()]
    .map(name => ({ name: validIdentifier(name, 'extension') }))
    .sort(compareName);
  assertUnique(
    extensions.map(item => item.name),
    'extension'
  );

  const schemaNames = new Set<string>([defaultSchema]);
  for (const table of tables) schemaNames.add(table.schema);
  for (const view of views) schemaNames.add(view.schema);

  try {
    return validateSchemaSnapshot({
      formatVersion: 1,
      defaultSchema,
      extensions,
      schemas: [...schemaNames].sort(compareText).map(name => ({ name })),
      tables,
      views,
    });
  } catch {
    throw invalidSchema('Desired schema contains an unsupported canonical value.');
  }
}

/** Copies one table and all supported nested objects. */
function normalizeTable(table: TableSchema): TableState {
  const schema = validIdentifier(table.getScope(), 'table schema');
  const name = validIdentifier(table.getName(false), 'table');
  const columns = table.getColumns().map(normalizeColumn).sort(compareName);
  assertUnique(
    columns.map(column => column.name),
    `column in ${schema}.${name}`
  );

  const primaryKey = table.getPrimaryKey();
  const primaryColumns = primaryKey ? constraintColumns(primaryKey) : [];
  const uniqueConstraints = table
    .getUniqueConstraints()
    .map(constraint => {
      const constraintColumnNames = constraintColumns(constraint);
      return {
        kind: 'unique' as const,
        name: stableName(name, constraintColumnNames, 'key'),
        columns: constraintColumnNames,
      };
    })
    .sort(compareName);
  const checkConstraints = table
    .getCheckConstraints()
    .map(constraint => ({
      kind: 'check' as const,
      name: stableExpressionName(name, constraint.getRule(), 'check'),
      expression: validSql(constraint.getRule(), 'check expression'),
    }))
    .sort(compareName);
  const foreignKeys = table
    .getForeignKeyConstrains()
    .map(constraint => {
      const referencedTable = constraint.getRefTable();
      const constraintColumnNames = constraintColumns(constraint);
      const referencedColumns = constraint.getRefColumns().map(column => column.getName());
      return {
        kind: 'foreignKey' as const,
        name: stableName(name, constraintColumnNames, 'fkey'),
        columns: constraintColumnNames,
        referencedSchema: validIdentifier(referencedTable.getScope(), 'referenced schema'),
        referencedTable: validIdentifier(referencedTable.getName(false), 'referenced table'),
        referencedColumns,
        onUpdate: constraint.getOnUpdate(),
        onDelete: constraint.getOnDelete(),
      };
    })
    .sort(compareName);
  const indexes = table
    .getIndexes()
    .map(index => normalizeIndex(name, index))
    .sort(compareName);

  return {
    schema,
    name,
    columns,
    ...(primaryColumns.length > 0
      ? {
          primaryKey: {
            kind: 'primaryKey',
            name: stableName(name, primaryColumns, 'pkey'),
            columns: primaryColumns,
          },
        }
      : {}),
    uniqueConstraints,
    checkConstraints,
    foreignKeys,
    indexes,
    ...(table.getComment() !== undefined ? { comment: table.getComment() } : {}),
  };
}

/** Copies one column while preserving explicit falsy defaults. */
function normalizeColumn(column: TableColumnSchema): ColumnState {
  const type = column.getType();
  if (!type) throw invalidSchema(`Column ${column.getName()} has no type.`);
  const defaultValue = column.getDefault();
  const identityOptions = column.getIdentityOptions();
  return {
    name: validIdentifier(column.getName(), 'column'),
    type,
    nullable: column.getNullable(),
    ...(column.getSize() !== undefined ? { size: column.getSize() } : {}),
    ...(column.getScale() !== undefined ? { scale: column.getScale() } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...(column.getComment() !== undefined ? { comment: column.getComment() } : {}),
    ...(column.getGeneratedExpression() !== undefined
      ? {
          generatedExpression: validSql(column.getGeneratedExpression(), 'generated expression'),
          generatedStored: column.isGeneratedStored(),
        }
      : {}),
    ...(column.getIdentityGeneration()
      ? { identityGeneration: column.getIdentityGeneration() }
      : {}),
    ...(identityOptions ? { identityOptions: orderedIdentityOptions(identityOptions) } : {}),
  };
}

/** Copies one index and derives a stable name only when the author omitted one. */
function normalizeIndex(tableName: string, index: IndexConstraint): TableState['indexes'][number] {
  const columns = constraintColumns(index);
  const expression = index.getExpression();
  const name =
    index.getIndexName() ??
    (columns.length > 0
      ? stableName(tableName, columns, 'idx')
      : stableExpressionName(tableName, expression ?? '', 'idx'));
  const storageParams = index.getStorageParams();
  return {
    name: validIdentifier(name, 'index'),
    columns,
    unique: index.isUnique(),
    concurrent: index.getConcurrent(),
    ...(index.getMethod() ? { method: index.getMethod() } : {}),
    ...(index.getWhere() ? { where: validSql(index.getWhere(), 'index predicate') } : {}),
    ...(index.getInclude() ? { include: [...(index.getInclude() ?? [])] } : {}),
    ...(expression ? { expression: validSql(expression, 'index expression') } : {}),
    ...(storageParams ? { storageParams: orderedRecord(storageParams) } : {}),
    ...(index.getTablespace()
      ? { tablespace: validIdentifier(index.getTablespace(), 'tablespace') }
      : {}),
  };
}

/** Copies one view without interpreting developer-authored SQL. */
function normalizeView(view: ViewSchema): ViewState {
  return {
    schema: validIdentifier(view.getScope(), 'view schema'),
    name: validIdentifier(view.getName(false), 'view'),
    source: validSql(view.getSource(), 'view source'),
    materialized: view.isMaterialized(),
    ...(view.getComment() !== undefined ? { comment: view.getComment() } : {}),
  };
}

/** Reads composite constraint columns in their declared semantic order. */
function constraintColumns(constraint: ConstraintBase): string[] {
  const columns = constraint
    .getColumns()
    .map(column => validIdentifier(column.getName(), 'constraint column'));
  if (columns.length === 0) throw invalidSchema('Constraint requires at least one column.');
  return columns;
}

/** Produces a conventional stable name from its table and ordered columns. */
function stableName(table: string, columns: readonly string[], suffix: string): string {
  return boundedDerivedName(`${table}_${columns.join('_')}_${suffix}`);
}

/** Produces a compact stable name for expression-backed objects. */
function stableExpressionName(table: string, expression: string, suffix: string): string {
  const hash = createHash('sha256').update(validSql(expression, suffix)).digest('hex').slice(0, 10);
  return boundedDerivedName(`${table}_${hash}_${suffix}`);
}

/** Truncates derived names with a hash while preserving PostgreSQL's 63-byte identity limit. */
function boundedDerivedName(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= 63) return value;
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 10);
  let prefix = value;
  while (Buffer.byteLength(`${prefix}_${hash}`, 'utf8') > 63) prefix = prefix.slice(0, -1);
  return `${prefix}_${hash}`;
}

/** Copies identity options in one explicit serialization order. */
function orderedIdentityOptions(
  options: NonNullable<ReturnType<TableColumnSchema['getIdentityOptions']>>
) {
  return {
    ...(options.start !== undefined ? { start: options.start } : {}),
    ...(options.increment !== undefined ? { increment: options.increment } : {}),
    ...(options.minValue !== undefined ? { minValue: options.minValue } : {}),
    ...(options.maxValue !== undefined ? { maxValue: options.maxValue } : {}),
    ...(options.cache !== undefined ? { cache: options.cache } : {}),
    ...(options.cycle !== undefined ? { cycle: options.cycle } : {}),
  };
}

/** Copies record entries in stable key order. */
function orderedRecord(
  record: Readonly<Record<string, string | number>>
): Record<string, string | number> {
  for (const [key, value] of Object.entries(record)) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(key)) throw invalidSchema('Invalid index storage parameter.');
    if (typeof value === 'string' && !/^[A-Za-z0-9_.-]+$/u.test(value)) {
      throw invalidSchema('Invalid index storage parameter value.');
    }
  }
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => compareText(left, right))
  );
}

/** Rejects missing, blank, or NUL-containing PostgreSQL identities. */
function validIdentifier(value: string | undefined, label: string): string {
  if (
    !value ||
    value.includes('\0') ||
    value.includes('.') ||
    Buffer.byteLength(value, 'utf8') > 63
  ) {
    throw invalidSchema(`Invalid ${label}.`);
  }
  return value;
}

/** Rejects missing or blank trusted SQL fragments before storing them as opaque text. */
function validSql(value: string | undefined, label: string): string {
  if (!value || value.trim().length === 0 || value.includes('\0')) {
    throw invalidSchema(`Invalid ${label}.`);
  }
  return value;
}

/** Rejects duplicate semantic identities after deterministic projection. */
function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw invalidSchema(`Duplicate ${label} identity: ${value}.`);
    seen.add(value);
  }
}

/** Returns one fully qualified canonical identity. */
function qualifiedName(value: { readonly schema: string; readonly name: string }): string {
  return `${value.schema}.${value.name}`;
}

/** Stable code-point ordering independent of process locale. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Sorts objects carrying one unqualified name. */
function compareName(left: { readonly name: string }, right: { readonly name: string }): number {
  return compareText(left.name, right.name);
}

/** Sorts PostgreSQL objects by schema then name. */
function compareQualified(
  left: { readonly schema: string; readonly name: string },
  right: { readonly schema: string; readonly name: string }
): number {
  return compareText(qualifiedName(left), qualifiedName(right));
}

/** Creates a stable unsupported desired-schema error. */
function invalidSchema(message: string): MigrationError {
  return new MigrationError({ kind: 'UNSUPPORTED', exitCode: 1, message });
}
