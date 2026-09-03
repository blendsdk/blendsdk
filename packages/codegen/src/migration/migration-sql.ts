import { MigrationError } from './errors.js';
import type { SchemaChange } from './schema-diff.js';
import type { ColumnState, TableState } from './snapshot-types.js';

/** Options controlling explicitly approved destructive SQL. */
export interface RenderMigrationSqlOptions {
  /** Allows only already-targeted destructive changes. */
  readonly allowDestructive?: boolean;
}

/**
 * Renders approved semantic changes as deterministic targeted PostgreSQL SQL.
 *
 * @param changes - Typed changes returned by the semantic diff.
 * @param options - Explicit destructive approval.
 * @returns LF-terminated SQL ordered by fixed dependency phases.
 * @throws {MigrationError} When any change still needs a hint, staged strategy, or manual SQL.
 */
export function renderMigrationSql(
  changes: readonly SchemaChange[],
  options: RenderMigrationSqlOptions = {}
): string {
  const blocked = changes.find(
    change =>
      change.safety === 'ambiguous' ||
      change.safety === 'unsupported' ||
      change.safety === 'caution' ||
      (change.safety === 'destructive' && !options.allowDestructive)
  );
  if (blocked) {
    throw new MigrationError({
      kind: blocked.safety === 'unsupported' ? 'UNSUPPORTED' : 'INVALID_HISTORY',
      exitCode: 1,
      message:
        blocked.guidance ??
        (blocked.safety === 'destructive'
          ? 'Destructive migration changes require explicit approval.'
          : `Migration change ${blocked.kind} requires manual review.`),
    });
  }

  const ordered = orderChanges(changes);
  const statements = ordered.flatMap(renderChange);
  return statements.length === 0 ? '' : `${statements.join('\n')}\n`;
}

/** Applies fixed phases plus child-before-parent ordering for table removals. */
function orderChanges(changes: readonly SchemaChange[]): SchemaChange[] {
  const ordered = [...changes].sort(compareRenderOrder);
  const drops = ordered.filter(change => change.kind === 'table.drop');
  if (drops.length < 2) return ordered;
  const byIdentity = new Map(drops.map(change => [`${change.schema}.${change.name}`, change]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const parentFirst: SchemaChange[] = [];

  const visit = (change: SchemaChange): void => {
    const identity = `${change.schema}.${change.name}`;
    if (visited.has(identity)) return;
    if (visiting.has(identity)) {
      throw renderError('Cyclic table removals require reviewed constraint-drop SQL.');
    }
    visiting.add(identity);
    for (const dependency of optionalStringArray(change.definition ?? {}, 'referencedTables') ??
      []) {
      const parent = byIdentity.get(dependency);
      if (parent) visit(parent);
    }
    visiting.delete(identity);
    visited.add(identity);
    parentFirst.push(change);
  };
  for (const drop of drops) visit(drop);
  const childFirst = parentFirst.reverse();
  let dropIndex = 0;
  return ordered.map(change =>
    change.kind === 'table.drop' ? (childFirst[dropIndex++] ?? change) : change
  );
}

/** Renders one already-approved change without consulting external state. */
function renderChange(change: SchemaChange): readonly string[] {
  switch (change.kind) {
    case 'extension.add':
      return [
        `CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(required(change.name, 'extension'))};`,
      ];
    case 'extension.drop':
      return destructive(`DROP EXTENSION ${quoteIdentifier(required(change.name, 'extension'))};`);
    case 'schema.add':
      return [`CREATE SCHEMA ${quoteIdentifier(required(change.name, 'schema'))};`];
    case 'schema.drop':
      return destructive(`DROP SCHEMA ${quoteIdentifier(required(change.name, 'schema'))};`);
    case 'table.add':
      return [renderTable(requiredObject(change.tableState, 'table definition'))];
    case 'table.drop':
      return destructive(`DROP TABLE ${qualified(change.schema, change.name)};`);
    case 'table.rename':
      return [
        `ALTER TABLE ${qualified(change.schema, change.name)} RENAME TO ${quoteIdentifier(required(change.newName, 'new table name'))};`,
      ];
    case 'column.add':
      return [
        `ALTER TABLE ${qualified(change.schema, change.table)} ADD COLUMN ${renderColumn(requiredObject(change.columnState, 'column definition'))};`,
      ];
    case 'column.drop':
      return destructive(
        `ALTER TABLE ${qualified(change.schema, change.table)} DROP COLUMN ${quoteIdentifier(required(change.name, 'column'))};`
      );
    case 'column.rename':
      return [
        `ALTER TABLE ${qualified(change.schema, change.table)} RENAME COLUMN ${quoteIdentifier(required(change.name, 'column'))} TO ${quoteIdentifier(required(change.newName, 'new column name'))};`,
      ];
    case 'column.type':
    case 'column.generated':
    case 'column.identity':
      return [];
    case 'column.default':
      return [renderDefaultChange(change)];
    case 'column.nullability':
      return [renderNullabilityChange(change)];
    case 'constraint.add':
      return [renderConstraint(change)];
    case 'constraint.drop':
      return destructive(
        `ALTER TABLE ${qualified(change.schema, change.table)} DROP CONSTRAINT ${quoteIdentifier(required(change.name, 'constraint'))};`
      );
    case 'index.add':
      return [renderIndex(change)];
    case 'index.drop':
      return destructive(`DROP INDEX ${qualified(change.schema, change.name)};`);
    case 'comment.set':
      return [renderComment(change)];
    case 'view.add':
      return [renderView(change)];
    case 'view.drop':
      return destructive(
        `DROP ${change.viewState?.materialized ? 'MATERIALIZED ' : ''}VIEW ${qualified(change.schema, change.name)};`
      );
    case 'view.replace':
      return [];
  }
}

/** Renders a new table without calling the initializer generator. */
function renderTable(table: TableState): string {
  const columns = table.columns.map(column => `  ${renderColumn(column)}`).join(',\n');
  return `CREATE TABLE ${qualified(table.schema, table.name)} (\n${columns}\n);`;
}

/** Renders one supported column definition. */
function renderColumn(column: ColumnState): string {
  const fragments = [quoteIdentifier(column.name), renderType(column)];
  if (column.generatedExpression) {
    fragments.push(`GENERATED ALWAYS AS (${column.generatedExpression}) STORED`);
  } else if (column.identityGeneration) {
    fragments.push(
      `GENERATED ${column.identityGeneration} AS IDENTITY${renderIdentityOptions(column)}`
    );
  } else if (column.default !== undefined) {
    fragments.push(`DEFAULT ${renderDefault(column.default)}`);
  }
  if (!column.nullable) fragments.push('NOT NULL');
  return fragments.join(' ');
}

/** Renders the bounded PostgreSQL identity option subset. */
function renderIdentityOptions(column: ColumnState): string {
  const options = column.identityOptions;
  if (!options) return '';
  const fragments = [
    ...(options.start !== undefined ? [`START WITH ${options.start}`] : []),
    ...(options.increment !== undefined ? [`INCREMENT BY ${options.increment}`] : []),
    ...(options.minValue !== undefined ? [`MINVALUE ${options.minValue}`] : []),
    ...(options.maxValue !== undefined ? [`MAXVALUE ${options.maxValue}`] : []),
    ...(options.cache !== undefined ? [`CACHE ${options.cache}`] : []),
    ...(options.cycle !== undefined ? [options.cycle ? 'CYCLE' : 'NO CYCLE'] : []),
  ];
  return fragments.length > 0 ? ` (${fragments.join(' ')})` : '';
}

/** Adds supported length/precision modifiers to one trusted modeled type. */
function renderType(column: ColumnState): string {
  if (column.size !== undefined && column.scale !== undefined) {
    return `${column.type}(${column.size}, ${column.scale})`;
  }
  if (column.size !== undefined) return `${column.type}(${column.size})`;
  return column.type;
}

/** Renders a default primitive or trusted developer-authored SQL string. */
function renderDefault(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

/** Renders a default transition. */
function renderDefaultChange(change: SchemaChange): string {
  const column = requiredObject(change.columnState, 'column definition');
  const prefix = `ALTER TABLE ${qualified(change.schema, change.table)} ALTER COLUMN ${quoteIdentifier(required(change.name, 'column'))}`;
  return column.default === undefined
    ? `${prefix} DROP DEFAULT;`
    : `${prefix} SET DEFAULT ${renderDefault(column.default)};`;
}

/** Renders a nullable transition; unsafe SET NOT NULL never reaches this function. */
function renderNullabilityChange(change: SchemaChange): string {
  const column = requiredObject(change.columnState, 'column definition');
  return `ALTER TABLE ${qualified(change.schema, change.table)} ALTER COLUMN ${quoteIdentifier(required(change.name, 'column'))} ${column.nullable ? 'DROP' : 'SET'} NOT NULL;`;
}

/** Renders one canonical constraint definition. */
function renderConstraint(change: SchemaChange): string {
  const definition = requiredObject(change.definition, 'constraint definition');
  const name = required(change.name, 'constraint');
  const prefix = `ALTER TABLE ${qualified(change.schema, change.table)} ADD CONSTRAINT ${quoteIdentifier(name)} `;
  const kind = stringProperty(definition, 'kind');
  const expression = stringProperty(definition, 'expression');
  if (kind === 'check' && expression) return `${prefix}CHECK (${expression});`;
  const columns = stringArrayProperty(definition, 'columns').map(quoteIdentifier).join(', ');
  const referencedTable = stringProperty(definition, 'referencedTable');
  if (kind === 'foreignKey' && referencedTable) {
    const referencedSchema = required(
      stringProperty(definition, 'referencedSchema'),
      'referenced schema'
    );
    const referencedColumns = stringArrayProperty(definition, 'referencedColumns')
      .map(quoteIdentifier)
      .join(', ');
    const onUpdate = required(stringProperty(definition, 'onUpdate'), 'ON UPDATE');
    const onDelete = required(stringProperty(definition, 'onDelete'), 'ON DELETE');
    return `${prefix}FOREIGN KEY (${columns}) REFERENCES ${qualified(referencedSchema, referencedTable)} (${referencedColumns}) ON UPDATE ${onUpdate} ON DELETE ${onDelete};`;
  }
  if (kind === 'primaryKey') return `${prefix}PRIMARY KEY (${columns});`;
  if (kind === 'unique') return `${prefix}UNIQUE (${columns});`;
  throw renderError('Unsupported canonical constraint kind.');
}

/** Renders one canonical PostgreSQL index. */
function renderIndex(change: SchemaChange): string {
  const definition = requiredObject(change.definition, 'index definition');
  const unique = definition.unique === true ? 'UNIQUE ' : '';
  const concurrent = definition.concurrent === true ? 'CONCURRENTLY ' : '';
  const method = stringProperty(definition, 'method');
  const expression = stringProperty(definition, 'expression');
  const columns =
    expression ?? stringArrayProperty(definition, 'columns').map(quoteIdentifier).join(', ');
  const include = optionalStringArray(definition, 'include');
  const where = stringProperty(definition, 'where');
  const storageParams = recordProperty(definition, 'storageParams');
  const tablespace = stringProperty(definition, 'tablespace');
  return [
    `CREATE ${unique}INDEX ${concurrent}${quoteIdentifier(required(change.name, 'index'))} ON ${qualified(change.schema, change.table)}`,
    method ? ` USING ${method}` : '',
    ` (${columns})`,
    include?.length ? ` INCLUDE (${include.map(quoteIdentifier).join(', ')})` : '',
    storageParams
      ? ` WITH (${Object.entries(storageParams)
          .map(([key, value]) => `${key} = ${String(value)}`)
          .join(', ')})`
      : '',
    tablespace ? ` TABLESPACE ${quoteIdentifier(tablespace)}` : '',
    where ? ` WHERE ${where}` : '',
    ';',
  ].join('');
}

/** Renders a table comment using a PostgreSQL string literal. */
function renderComment(change: SchemaChange): string {
  const definition = requiredObject(change.definition, 'comment definition');
  const comment = definition.comment;
  const target =
    definition.target === 'view' || definition.target === 'materializedView'
      ? `${definition.target === 'materializedView' ? 'MATERIALIZED ' : ''}VIEW ${qualified(change.schema, change.name)}`
      : change.name
        ? `COLUMN ${qualified(change.schema, change.table)}.${quoteIdentifier(change.name)}`
        : `TABLE ${qualified(change.schema, change.table)}`;
  return `COMMENT ON ${target} IS ${comment === null ? 'NULL' : quoteLiteral(requiredString(comment, 'comment'))};`;
}

/** Narrows an optional canonical record property. */
function recordProperty(
  record: Readonly<Record<string, unknown>>,
  key: string
): Readonly<Record<string, string | number>> | undefined {
  const value = record[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([, item]) => typeof item === 'string' || typeof item === 'number')) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

/** Renders one independent view creation. */
function renderView(change: SchemaChange): string {
  const view = requiredObject(change.viewState, 'view definition');
  return `CREATE ${view.materialized ? 'MATERIALIZED ' : ''}VIEW ${qualified(view.schema, view.name)} AS ${view.source};`;
}

/** Adds a conspicuous approval marker to each destructive statement. */
function destructive(statement: string): readonly string[] {
  return ['-- destructive: reviewed and explicitly allowed', statement];
}

/** Quotes each PostgreSQL identifier segment without accepting NUL. */
function quoteIdentifier(identifier: string): string {
  if (identifier.includes('\0')) throw renderError('PostgreSQL identifier contains NUL.');
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Quotes a developer-authored comment as a PostgreSQL string literal. */
function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Quotes one two-segment PostgreSQL identity. */
function qualified(schema: string | undefined, name: string | undefined): string {
  return `${quoteIdentifier(required(schema, 'schema'))}.${quoteIdentifier(required(name, 'object name'))}`;
}

/** Requires one nonempty modeled string. */
function required(value: string | undefined, label: string): string {
  if (!value) throw renderError(`Missing ${label}.`);
  return value;
}

/** Requires one object already validated by the canonical model. */
function requiredObject<Value extends object>(value: Value | undefined, label: string): Value {
  if (!value) throw renderError(`Missing ${label}.`);
  return value;
}

/** Reads an optional string property from a canonical definition. */
function stringProperty(
  record: Readonly<Record<string, unknown>>,
  key: string
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** Reads a required array of strings from a canonical definition. */
function stringArrayProperty(
  record: Readonly<Record<string, unknown>>,
  key: string
): readonly string[] {
  const value = optionalStringArray(record, key);
  if (!value) throw renderError(`Missing ${key}.`);
  return value;
}

/** Narrows an optional unknown property to a string array. */
function optionalStringArray(
  record: Readonly<Record<string, unknown>>,
  key: string
): readonly string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return undefined;
  return value;
}

/** Narrows an unknown property to one string. */
function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw renderError(`Missing ${label}.`);
  return value;
}

/** Orders SQL by fixed dependency phase and then exact identity. */
function compareRenderOrder(left: SchemaChange, right: SchemaChange): number {
  const leftKey = `${renderPhase(left)}:${left.schema ?? ''}.${left.table ?? ''}.${left.name ?? ''}`;
  const rightKey = `${renderPhase(right)}:${right.schema ?? ''}.${right.table ?? ''}.${right.name ?? ''}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

/** Maps a change to the intentionally small PostgreSQL dependency sequence. */
function renderPhase(change: SchemaChange): number {
  if (change.kind === 'extension.add') return 0;
  if (change.kind === 'schema.add') return 1;
  if (change.kind.endsWith('.rename')) return 2;
  if (change.kind === 'table.add' || change.kind === 'column.add') return 3;
  if (change.kind.startsWith('column.') && change.kind !== 'column.drop') return 4;
  if (change.kind === 'constraint.add') {
    return change.definition?.referencedTable ? 55 : 50;
  }
  if (change.kind === 'index.add') return 60;
  if (change.kind === 'comment.set') {
    return change.definition?.target === 'view' || change.definition?.target === 'materializedView'
      ? 81
      : 70;
  }
  if (change.kind === 'view.add') return 80;
  if (change.kind === 'view.drop') return 900;
  if (change.kind === 'index.drop') return 910;
  if (change.kind === 'constraint.drop') return 920;
  if (change.kind === 'column.drop') return 930;
  if (change.kind === 'table.drop') return 940;
  if (change.kind === 'schema.drop') return 950;
  if (change.kind === 'extension.drop') return 960;
  return 970;
}

/** Creates a stable renderer failure without exposing SQL expressions. */
function renderError(message: string): MigrationError {
  return new MigrationError({ kind: 'UNSUPPORTED', exitCode: 1, message });
}
