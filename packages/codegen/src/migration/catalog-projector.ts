import { MigrationError } from './errors.js';
import type { ColumnState, SchemaSnapshotV1, TableState } from './snapshot-types.js';
import { validateSchemaSnapshot } from './snapshot-types.js';

const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema'];

/** Minimal PostgreSQL query surface required by catalog projection. */
export interface CatalogQueryClient {
  /** Executes one fixed catalog query and returns untrusted provider rows. */
  query(sql: string, values?: unknown[]): Promise<{ readonly rows: unknown[] }>;
}

/**
 * Projects the supported PostgreSQL catalog subset into the canonical snapshot DTO.
 *
 * Queries read metadata only, exclude system schemas and the BlendSDK ledger, and use fixed SQL
 * with parameterized exclusion values. Returned rows are validated before they become trusted
 * canonical state.
 */
export async function projectPostgreSqlCatalog(
  client: CatalogQueryClient
): Promise<SchemaSnapshotV1> {
  // A pg client executes one query at a time. Explicit sequencing avoids relying on the driver's
  // deprecated query queue and keeps transaction boundaries straightforward.
  const defaultSchema = await readDefaultSchema(client);
  const extensions = await readExtensions(client);
  const schemas = await readSchemas(client);
  const relations = await readRelations(client);
  const columns = await readColumns(client);
  const constraints = await readConstraints(client);
  const indexes = await readIndexes(client);

  const tables = relations.tables.map(table => ({
    ...table,
    columns: columns.filter(column => sameTable(column, table)).map(column => column.value),
    ...tableConstraints(constraints.filter(item => sameTable(item, table))),
    indexes: indexes.filter(index => sameTable(index, table)).map(index => index.value),
  }));
  try {
    return validateSchemaSnapshot({
      formatVersion: 1,
      defaultSchema,
      extensions,
      schemas,
      tables,
      views: relations.views,
    });
  } catch {
    throw unsupportedCatalog('The PostgreSQL catalog contains unsupported modeled state.');
  }
}

/** Canonical table identity shared by grouped catalog records. */
interface TableIdentity {
  readonly schema: string;
  readonly name: string;
}

/** Canonical value associated with one table identity. */
interface TableValue<Value> extends TableIdentity {
  readonly value: Value;
}

/** Constraint kind and value associated with one table. */
interface ConstraintValue extends TableIdentity {
  readonly kind: 'primaryKey' | 'unique' | 'check' | 'foreignKey';
  readonly value:
    | NonNullable<TableState['primaryKey']>
    | TableState['uniqueConstraints'][number]
    | TableState['checkConstraints'][number]
    | TableState['foreignKeys'][number];
}

/** Reads the effective default schema used by unqualified application objects. */
async function readDefaultSchema(client: CatalogQueryClient): Promise<string> {
  const result = await client.query('SELECT current_schema() AS name');
  const row = record(result.rows[0], 'default schema');
  return text(row.name, 'default schema');
}

/** Reads user-managed extensions while excluding PostgreSQL-owned plpgsql. */
async function readExtensions(client: CatalogQueryClient): Promise<SchemaSnapshotV1['extensions']> {
  const result = await client.query(
    `SELECT extname AS name FROM pg_catalog.pg_extension WHERE extname <> $1 ORDER BY extname`,
    ['plpgsql']
  );
  return result.rows.map((row, index) => ({
    name: text(record(row, `extension ${index + 1}`).name, 'extension name'),
  }));
}

/** Reads non-system schemas in stable identity order. */
async function readSchemas(client: CatalogQueryClient): Promise<SchemaSnapshotV1['schemas']> {
  const result = await client.query(
    `
      SELECT nspname AS name
      FROM pg_catalog.pg_namespace
      WHERE nspname <> ALL($1::text[]) AND nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
      ORDER BY nspname
    `,
    [SYSTEM_SCHEMAS]
  );
  return result.rows.map((row, index) => ({
    name: text(record(row, `schema ${index + 1}`).name, 'schema name'),
  }));
}

/** Reads ordinary tables and views, including their comments and exact view source. */
async function readRelations(client: CatalogQueryClient): Promise<{
  readonly tables: readonly Omit<
    TableState,
    'columns' | 'primaryKey' | 'uniqueConstraints' | 'checkConstraints' | 'foreignKeys' | 'indexes'
  >[];
  readonly views: SchemaSnapshotV1['views'];
}> {
  const result = await client.query(
    `
      SELECT n.nspname AS schema_name, c.relname AS object_name, c.relkind,
             c.relpersistence, c.relispartition, c.relrowsecurity, c.relforcerowsecurity,
             EXISTS (SELECT 1 FROM pg_catalog.pg_inherits inh WHERE inh.inhrelid = c.oid) AS inherited,
             EXISTS (SELECT 1 FROM pg_catalog.pg_policy policy WHERE policy.polrelid = c.oid)
               AS has_policies,
             obj_description(c.oid, 'pg_class') AS comment,
             CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END AS source
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname <> ALL($1::text[])
        AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
        AND c.relkind IN ('r', 'v', 'm')
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_depend dep
          WHERE dep.classid = 'pg_catalog.pg_class'::regclass
            AND dep.objid = c.oid AND dep.deptype = 'e'
        )
        AND NOT (n.nspname = 'public' AND c.relname = 'blendsdk_migrations')
      ORDER BY n.nspname, c.relname
    `,
    [SYSTEM_SCHEMAS]
  );
  const tables: Array<
    Omit<
      TableState,
      | 'columns'
      | 'primaryKey'
      | 'uniqueConstraints'
      | 'checkConstraints'
      | 'foreignKeys'
      | 'indexes'
    >
  > = [];
  const views: Array<SchemaSnapshotV1['views'][number]> = [];
  for (const [index, row] of result.rows.entries()) {
    const value = record(row, `relation ${index + 1}`);
    const schema = text(value.schema_name, 'relation schema');
    const name = text(value.object_name, 'relation name');
    const kind = text(value.relkind, 'relation kind');
    const comment = optionalText(value.comment, 'relation comment');
    if (kind === 'r') {
      if (
        value.relpersistence !== 'p' ||
        value.relispartition !== false ||
        value.inherited !== false ||
        value.relrowsecurity !== false ||
        value.relforcerowsecurity !== false ||
        value.has_policies !== false
      ) {
        throw unsupportedCatalog(`Unsupported table semantics: ${schema}.${name}.`);
      }
      tables.push({ schema, name, ...(comment !== undefined ? { comment } : {}) });
    } else if (kind === 'v' || kind === 'm') {
      views.push({
        schema,
        name,
        source: text(value.source, 'view source'),
        materialized: kind === 'm',
        ...(comment !== undefined ? { comment } : {}),
      });
    } else {
      throw invalidCatalog('Unknown supported relation kind.');
    }
  }
  return { tables, views };
}

/** Reads supported column properties through stable information-schema fields. */
async function readColumns(
  client: CatalogQueryClient
): Promise<readonly TableValue<ColumnState>[]> {
  const result = await client.query(
    `
      SELECT col.table_schema AS schema_name, col.table_name, col.column_name,
             col.data_type, col.udt_name, col.is_nullable,
             col.character_maximum_length::text, col.numeric_precision::text,
             col.numeric_scale::text, col.datetime_precision::text, col.column_default,
             col.is_generated, col.generation_expression, col.is_identity,
             col.identity_generation, col.identity_start, col.identity_increment,
             col.identity_minimum, col.identity_maximum, col.identity_cycle,
             CASE WHEN col.is_identity = 'YES' THEN (
               SELECT seq.seqcache::text
               FROM pg_catalog.pg_sequence seq
               WHERE seq.seqrelid = to_regclass(pg_get_serial_sequence(
                 format('%I.%I', col.table_schema, col.table_name), col.column_name
               ))
             ) END AS identity_cache,
             pg_get_serial_sequence(
               format('%I.%I', col.table_schema, col.table_name), col.column_name
             ) AS owned_sequence,
             col.column_default ~ '^nextval\\(''.+''::regclass\\)$'
               AND EXISTS (
                 SELECT 1
                 FROM pg_catalog.pg_attrdef definition
                 JOIN pg_catalog.pg_depend dependency
                   ON dependency.classid = 'pg_catalog.pg_attrdef'::regclass
                  AND dependency.objid = definition.oid
                  AND dependency.refclassid = 'pg_catalog.pg_class'::regclass
                 WHERE definition.adrelid = cls.oid
                   AND definition.adnum = attr.attnum
                   AND dependency.refobjid = owned_sequence.seqrelid
               ) AS uses_owned_sequence,
             owned_sequence.seqtypid::regtype::text AS owned_sequence_type,
             owned_sequence.seqstart::text AS owned_sequence_start,
             owned_sequence.seqincrement::text AS owned_sequence_increment,
             owned_sequence.seqmax::text AS owned_sequence_maximum,
             owned_sequence.seqmin::text AS owned_sequence_minimum,
             owned_sequence.seqcache::text AS owned_sequence_cache,
             owned_sequence.seqcycle AS owned_sequence_cycle,
             attr.attcollation = typ.typcollation AS default_collation,
             col_description(cls.oid, attr.attnum) AS comment
      FROM information_schema.columns col
      JOIN pg_catalog.pg_namespace n ON n.nspname = col.table_schema
      JOIN pg_catalog.pg_class cls ON cls.relnamespace = n.oid AND cls.relname = col.table_name
      JOIN pg_catalog.pg_attribute attr
        ON attr.attrelid = cls.oid AND attr.attname = col.column_name
      JOIN pg_catalog.pg_type typ ON typ.oid = attr.atttypid
      LEFT JOIN LATERAL (
        SELECT sequence.*
        FROM pg_catalog.pg_sequence sequence
        WHERE sequence.seqrelid = to_regclass(pg_get_serial_sequence(
          format('%I.%I', col.table_schema, col.table_name), col.column_name
        ))
      ) owned_sequence ON true
      WHERE col.table_schema <> ALL($1::text[])
        AND col.table_schema NOT LIKE 'pg\\_%' ESCAPE '\\'
        AND cls.relkind = 'r'
        AND NOT (col.table_schema = 'public' AND col.table_name = 'blendsdk_migrations')
      ORDER BY col.table_schema, col.table_name, col.ordinal_position
    `,
    [SYSTEM_SCHEMAS]
  );
  return result.rows.map((row, index) => parseColumn(record(row, `column ${index + 1}`)));
}

/** Converts one validated information-schema row into a canonical column. */
function parseColumn(row: Readonly<Record<string, unknown>>): TableValue<ColumnState> {
  const dataType = text(row.data_type, 'column type');
  const defaultExpression = optionalText(row.column_default, 'column default');
  if (row.default_collation !== true) {
    throw unsupportedCatalog('Explicit column collations are unsupported for adoption.');
  }
  const type = canonicalType(
    dataType,
    text(row.udt_name, 'column UDT'),
    defaultExpression,
    isCanonicalSerialSequence(dataType, row)
  );
  const identity = row.is_identity === 'YES';
  const generated = row.is_generated !== 'NEVER';
  const sizeScale = typeModifiers(type, row);
  return {
    schema: text(row.schema_name, 'column schema'),
    name: text(row.table_name, 'column table'),
    value: {
      name: text(row.column_name, 'column name'),
      type,
      nullable: row.is_nullable === 'YES',
      ...sizeScale,
      ...(!identity && !generated && !isSerialType(type) && defaultExpression !== undefined
        ? { default: canonicalDefault(defaultExpression) }
        : {}),
      ...(generated
        ? {
            generatedExpression: text(row.generation_expression, 'generated expression'),
            generatedStored: true,
          }
        : {}),
      ...(identity
        ? {
            identityGeneration: identityGeneration(row.identity_generation),
            ...identityOptions(type, row),
          }
        : {}),
      ...(optionalText(row.comment, 'column comment') !== undefined
        ? { comment: optionalText(row.comment, 'column comment') }
        : {}),
    },
  };
}

/** Reads supported primary, unique, check, and foreign-key constraints. */
async function readConstraints(client: CatalogQueryClient): Promise<readonly ConstraintValue[]> {
  const result = await client.query(
    `
      SELECT n.nspname AS schema_name, c.relname AS table_name, con.conname,
             con.contype, con.condeferrable, con.condeferred, con.convalidated, con.connoinherit,
             con.confmatchtype, COALESCE(constraint_index.indnullsnotdistinct, false)
               AS connullsnotdistinct,
             con.confdelsetcols,
             pg_get_expr(con.conbin, con.conrelid, true) AS expression,
             ARRAY(
               SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY key(attnum, position)
               JOIN pg_catalog.pg_attribute a
                 ON a.attrelid = con.conrelid AND a.attnum = key.attnum
               ORDER BY key.position
             ) AS columns,
             rn.nspname AS referenced_schema, rc.relname AS referenced_table,
             ARRAY(
               SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY key(attnum, position)
               JOIN pg_catalog.pg_attribute a
                 ON a.attrelid = con.confrelid AND a.attnum = key.attnum
               ORDER BY key.position
             ) AS referenced_columns,
             con.confupdtype, con.confdeltype
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid
      LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
      LEFT JOIN pg_catalog.pg_index constraint_index
        ON constraint_index.indexrelid = con.conindid
      WHERE n.nspname <> ALL($1::text[])
        AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
        AND NOT (n.nspname = 'public' AND c.relname = 'blendsdk_migrations')
      ORDER BY n.nspname, c.relname, con.conname
    `,
    [SYSTEM_SCHEMAS]
  );
  return result.rows.map((row, index) => parseConstraint(record(row, `constraint ${index + 1}`)));
}

/** Converts one supported constraint row without interpreting expression SQL. */
function parseConstraint(row: Readonly<Record<string, unknown>>): ConstraintValue {
  const base = {
    schema: text(row.schema_name, 'constraint schema'),
    name: text(row.table_name, 'constraint table'),
  };
  const constraintName = text(row.conname, 'constraint name');
  const columns = textArray(row.columns, 'constraint columns');
  const kind = text(row.contype, 'constraint kind');
  if (
    row.condeferrable !== false ||
    row.condeferred !== false ||
    row.convalidated !== true ||
    row.confdelsetcols !== null ||
    (kind === 'c' && row.connoinherit !== false) ||
    ((kind === 'p' || kind === 'u') && row.connullsnotdistinct !== false) ||
    (kind === 'f' && row.confmatchtype !== 's')
  ) {
    throw unsupportedCatalog(`Unsupported constraint semantics: ${base.schema}.${constraintName}.`);
  }
  switch (kind) {
    case 'p':
      return {
        ...base,
        kind: 'primaryKey',
        value: { kind: 'primaryKey', name: constraintName, columns },
      };
    case 'u':
      return { ...base, kind: 'unique', value: { kind: 'unique', name: constraintName, columns } };
    case 'c':
      return {
        ...base,
        kind: 'check',
        value: {
          kind: 'check',
          name: constraintName,
          expression: text(row.expression, 'check expression'),
        },
      };
    case 'f':
      return {
        ...base,
        kind: 'foreignKey',
        value: {
          kind: 'foreignKey',
          name: constraintName,
          columns,
          referencedSchema: text(row.referenced_schema, 'referenced schema'),
          referencedTable: text(row.referenced_table, 'referenced table'),
          referencedColumns: textArray(row.referenced_columns, 'referenced columns'),
          onUpdate: referentialAction(row.confupdtype),
          onDelete: referentialAction(row.confdeltype),
        },
      };
    default:
      throw unsupportedCatalog(`Unsupported constraint kind: ${base.schema}.${constraintName}.`);
  }
}

/** Reads standalone indexes while excluding indexes owned by constraints. */
async function readIndexes(
  client: CatalogQueryClient
): Promise<readonly TableValue<TableState['indexes'][number]>[]> {
  const result = await client.query(
    `
      SELECT n.nspname AS schema_name, c.relname AS table_name, idx.relname AS index_name,
             am.amname AS method, i.indisunique, i.indnkeyatts, i.indnatts,
             i.indisvalid, i.indisready, i.indislive, i.indnullsnotdistinct,
             NOT EXISTS (
               SELECT 1 FROM generate_subscripts(i.indclass, 1) position
               JOIN pg_catalog.pg_opclass opc ON opc.oid = i.indclass[position]
               WHERE position <= i.indnkeyatts AND NOT opc.opcdefault
             ) AS default_opclasses,
             NOT EXISTS (
               SELECT 1 FROM generate_subscripts(i.indkey, 1) position
               JOIN pg_catalog.pg_attribute key_attribute
                 ON key_attribute.attrelid = c.oid
                AND key_attribute.attnum = i.indkey[position]
               WHERE position <= i.indnkeyatts
                 AND (i.indoption[position] <> 0
                      OR i.indcollation[position] <> key_attribute.attcollation)
             ) AS default_key_semantics,
             ARRAY(
               SELECT a.attname::text
               FROM unnest(i.indkey::smallint[]) WITH ORDINALITY key(attnum, position)
               JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = key.attnum
               WHERE key.position <= i.indnkeyatts
               ORDER BY key.position
             ) AS columns,
             ARRAY(
               SELECT a.attname::text
               FROM unnest(i.indkey::smallint[]) WITH ORDINALITY key(attnum, position)
               JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = key.attnum
               WHERE key.position > i.indnkeyatts
               ORDER BY key.position
             ) AS include_columns,
             pg_get_expr(i.indexprs, i.indrelid, true) AS expression,
             pg_get_expr(i.indpred, i.indrelid, true) AS predicate,
             idx.reloptions, ts.spcname AS tablespace
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
      JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_am am ON am.oid = idx.relam
      LEFT JOIN pg_catalog.pg_tablespace ts ON ts.oid = idx.reltablespace
      WHERE n.nspname <> ALL($1::text[])
        AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con WHERE con.conindid = i.indexrelid)
      ORDER BY n.nspname, c.relname, idx.relname
    `,
    [SYSTEM_SCHEMAS]
  );
  return result.rows.map((row, index) => parseIndex(record(row, `index ${index + 1}`)));
}

/** Converts one standalone index row into the bounded canonical model. */
function parseIndex(
  row: Readonly<Record<string, unknown>>
): TableValue<TableState['indexes'][number]> {
  const include = textArray(row.include_columns, 'included columns');
  if (
    row.indisvalid !== true ||
    row.indisready !== true ||
    row.indislive !== true ||
    row.indnullsnotdistinct !== false ||
    row.default_opclasses !== true ||
    row.default_key_semantics !== true
  ) {
    throw unsupportedCatalog('The catalog contains unsupported index semantics.');
  }
  const expression = optionalText(row.expression, 'index expression');
  const storageParams = optionalTextArray(row.reloptions, 'index storage parameters');
  return {
    schema: text(row.schema_name, 'index schema'),
    name: text(row.table_name, 'index table'),
    value: {
      name: text(row.index_name, 'index name'),
      columns: textArray(row.columns, 'index columns'),
      unique: boolean(row.indisunique, 'index uniqueness'),
      concurrent: false,
      ...(row.method === 'btree' ? {} : { method: indexMethod(row.method) }),
      ...(include.length > 0 ? { include } : {}),
      ...(expression !== undefined ? { expression } : {}),
      ...(optionalText(row.predicate, 'index predicate') !== undefined
        ? { where: optionalText(row.predicate, 'index predicate') }
        : {}),
      ...(storageParams && storageParams.length > 0
        ? { storageParams: Object.fromEntries(storageParams.map(parseStorageParameter)) }
        : {}),
      ...(optionalText(row.tablespace, 'index tablespace') !== undefined
        ? { tablespace: optionalText(row.tablespace, 'index tablespace') }
        : {}),
    },
  };
}

/** Groups typed constraint values into one table's canonical collections. */
function tableConstraints(
  items: readonly ConstraintValue[]
): Pick<TableState, 'primaryKey' | 'uniqueConstraints' | 'checkConstraints' | 'foreignKeys'> {
  const primary = items.flatMap(item =>
    item.kind === 'primaryKey' && item.value.kind === 'primaryKey' ? [item.value] : []
  );
  if (primary.length > 1) throw invalidCatalog('Table has multiple primary keys.');
  return {
    ...(primary[0] ? { primaryKey: primary[0] } : {}),
    uniqueConstraints: items.flatMap(item =>
      item.kind === 'unique' && item.value.kind === 'unique' ? [item.value] : []
    ),
    checkConstraints: items.flatMap(item =>
      item.kind === 'check' && item.value.kind === 'check' ? [item.value] : []
    ),
    foreignKeys: items.flatMap(item =>
      item.kind === 'foreignKey' && item.value.kind === 'foreignKey' ? [item.value] : []
    ),
  };
}

/** Compares one grouped catalog record with a table identity. */
function sameTable(value: TableIdentity, table: TableIdentity): boolean {
  return value.schema === table.schema && value.name === table.name;
}

/** Maps information-schema type names to BlendSDK's supported PostgreSQL spelling. */
function canonicalType(
  dataType: string,
  udtName: string,
  defaultExpression: string | undefined,
  ownsSequence: boolean
): ColumnState['type'] {
  if (ownsSequence && defaultExpression?.startsWith('nextval(')) {
    if (dataType === 'integer') return 'serial';
    if (dataType === 'bigint') return 'bigserial';
  }
  const aliases: Readonly<Record<string, string>> = {
    'character varying': 'varchar',
    character: 'char',
    'timestamp without time zone': 'timestamp',
    'timestamp with time zone': 'timestamptz',
    'time without time zone': 'time',
    'USER-DEFINED': udtName,
  };
  return aliases[dataType] ?? dataType;
}

/** Recognizes sequence-backed shorthand types whose defaults are part of the type itself. */
function isSerialType(type: string): boolean {
  return type === 'serial' || type === 'bigserial';
}

/** Proves an owned sequence still has the exact definition implied by serial shorthand. */
function isCanonicalSerialSequence(
  dataType: string,
  row: Readonly<Record<string, unknown>>
): boolean {
  const maximumDefaults: Readonly<Record<string, string>> = {
    integer: '2147483647',
    bigint: '9223372036854775807',
  };
  const maximum = maximumDefaults[dataType];
  return (
    maximum !== undefined &&
    row.owned_sequence !== null &&
    row.uses_owned_sequence === true &&
    row.owned_sequence_type === dataType &&
    row.owned_sequence_start === '1' &&
    row.owned_sequence_increment === '1' &&
    row.owned_sequence_minimum === '1' &&
    row.owned_sequence_maximum === maximum &&
    row.owned_sequence_cache === '1' &&
    row.owned_sequence_cycle === false
  );
}

/**
 * Retains only identity sequence options that differ from PostgreSQL's positive-sequence defaults.
 *
 * Omitting implicit values makes live projection match the authoring model, which also omits
 * options the developer did not specify. Unsupported negative or out-of-range forms fail closed.
 */
function identityOptions(
  type: string,
  row: Readonly<Record<string, unknown>>
): Pick<ColumnState, 'identityOptions'> {
  const increment = integerText(row.identity_increment, 'identity increment');
  if (increment <= 0) {
    throw unsupportedCatalog('Descending identity sequences are unsupported for adoption.');
  }
  const maximumDefaults: Readonly<Record<string, string>> = {
    smallint: '32767',
    integer: '2147483647',
    bigint: '9223372036854775807',
  };
  const maximumDefault = maximumDefaults[type];
  if (!maximumDefault) throw unsupportedCatalog(`Unsupported identity type: ${type}.`);
  const start = integerText(row.identity_start, 'identity start');
  const minimum = integerText(row.identity_minimum, 'identity minimum');
  const maximumText = requiredIntegerString(row.identity_maximum, 'identity maximum');
  const cache = integerText(row.identity_cache, 'identity cache');
  const cycle = row.identity_cycle === 'YES';
  const options = {
    ...(start !== 1 ? { start } : {}),
    ...(increment !== 1 ? { increment } : {}),
    ...(minimum !== 1 ? { minValue: minimum } : {}),
    ...(maximumText !== maximumDefault
      ? { maxValue: safeIntegerString(maximumText, 'identity maximum') }
      : {}),
    ...(cache !== 1 ? { cache } : {}),
    ...(cycle ? { cycle: true } : {}),
  };
  return Object.keys(options).length === 0 ? {} : { identityOptions: options };
}

/** Requires a signed PostgreSQL integer represented as text without converting it. */
function requiredIntegerString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^-?\d+$/u.test(value)) {
    throw invalidCatalog(`Invalid ${label}.`);
  }
  return value;
}

/** Converts a previously validated integer string only when JavaScript can preserve it exactly. */
function safeIntegerString(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw unsupportedCatalog(`${label} exceeds JavaScript range.`);
  return parsed;
}

/** Extracts supported size and scale values without inventing implicit PostgreSQL defaults. */
function typeModifiers(
  type: string,
  row: Readonly<Record<string, unknown>>
): Pick<ColumnState, 'size' | 'scale'> {
  if (type === 'varchar' || type === 'char') {
    const size = optionalIntegerText(row.character_maximum_length, 'character size');
    return size === undefined ? {} : { size };
  }
  if (type === 'numeric' || type === 'decimal') {
    const size = optionalIntegerText(row.numeric_precision, 'numeric precision');
    const scale = optionalIntegerText(row.numeric_scale, 'numeric scale');
    return {
      ...(size !== undefined ? { size } : {}),
      ...(scale !== undefined ? { scale } : {}),
    };
  }
  if (type === 'time' || type === 'timestamp' || type === 'timestamptz') {
    const size = optionalIntegerText(row.datetime_precision, 'datetime precision');
    return size === undefined || size === 6 ? {} : { size };
  }
  return {};
}

/** Converts simple literal defaults and retains other expressions for conservative comparison. */
function canonicalDefault(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return Number(value);
  return value;
}

/** Converts PostgreSQL foreign-key action codes to the public canonical words. */
function referentialAction(value: unknown): TableState['foreignKeys'][number]['onUpdate'] {
  const actions: Readonly<Record<string, TableState['foreignKeys'][number]['onUpdate']>> = {
    a: 'NO ACTION',
    r: 'RESTRICT',
    c: 'CASCADE',
    n: 'SET NULL',
    d: 'SET DEFAULT',
  };
  const action = typeof value === 'string' ? actions[value] : undefined;
  if (!action) throw invalidCatalog('Unknown foreign-key action.');
  return action;
}

/** Narrows a supported PostgreSQL index method. */
function indexMethod(value: unknown): TableState['indexes'][number]['method'] {
  const method = text(value, 'index method');
  switch (method) {
    case 'btree':
    case 'hash':
    case 'gist':
    case 'gin':
    case 'brin':
    case 'spgist':
    case 'bloom':
      return method;
    default:
      throw unsupportedCatalog(`Unsupported PostgreSQL index method: ${method}.`);
  }
}

/** Converts one `key=value` reloption into a canonical storage parameter. */
function parseStorageParameter(value: string): readonly [string, string] {
  const separator = value.indexOf('=');
  if (separator <= 0) throw invalidCatalog('Invalid index storage parameter.');
  return [value.slice(0, separator), value.slice(separator + 1)];
}

/** Narrows an identity generation discriminator. */
function identityGeneration(value: unknown): 'ALWAYS' | 'BY DEFAULT' {
  if (value === 'ALWAYS' || value === 'BY DEFAULT') return value;
  throw invalidCatalog('Invalid identity generation mode.');
}

/** Requires one unknown row to be a plain property record. */
function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw invalidCatalog(`Invalid ${label} row.`);
  }
  return value;
}

/** Narrows unknown PostgreSQL driver output to a property record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Requires a nonempty text catalog field. */
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw invalidCatalog(`Invalid ${label}.`);
  return value;
}

/** Reads a nullable text catalog field. */
function optionalText(value: unknown, label: string): string | undefined {
  if (value === null) return undefined;
  return text(value, label);
}

/** Requires one native boolean catalog field. */
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidCatalog(`Invalid ${label}.`);
  return value;
}

/** Requires one PostgreSQL text array. */
function textArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw invalidCatalog(`Invalid ${label}.`);
  }
  return [...value];
}

/** Reads one nullable PostgreSQL text array. */
function optionalTextArray(value: unknown, label: string): string[] | undefined {
  return value === null ? undefined : textArray(value, label);
}

/** Parses a required safe integer returned as PostgreSQL text. */
function integerText(value: unknown, label: string): number {
  const parsed = optionalIntegerText(value, label);
  if (parsed === undefined) throw invalidCatalog(`Missing ${label}.`);
  return parsed;
}

/** Parses a nullable safe integer returned as PostgreSQL text. */
function optionalIntegerText(value: unknown, label: string): number | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'string' || !/^-?\d+$/u.test(value)) {
    throw invalidCatalog(`Invalid ${label}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw unsupportedCatalog(`${label} exceeds JavaScript range.`);
  return parsed;
}

/** Creates a sanitized incompatible-catalog failure. */
function invalidCatalog(message: string): MigrationError {
  return new MigrationError({ kind: 'INVALID_HISTORY', exitCode: 1, message });
}

/** Creates a sanitized unsupported-catalog failure. */
function unsupportedCatalog(message: string): MigrationError {
  return new MigrationError({ kind: 'UNSUPPORTED', exitCode: 1, message });
}
