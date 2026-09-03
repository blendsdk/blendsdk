import { z } from 'zod';

const identifierSchema = z
  .string()
  .min(1)
  .refine(value => !value.includes('\0'), 'Identifier contains NUL')
  .refine(value => !value.includes('.'), 'Dots are unsupported in version-one identities')
  .refine(value => Buffer.byteLength(value, 'utf8') <= 63, 'Identifier exceeds 63 bytes');
const sqlTextSchema = z
  .string()
  .min(1)
  .refine(value => value.trim().length > 0, 'SQL text is empty');
const identityOptionsSchema = z
  .object({
    start: z.number().int().optional(),
    increment: z.number().int().optional(),
    minValue: z.number().int().optional(),
    maxValue: z.number().int().optional(),
    cache: z.number().int().positive().optional(),
    cycle: z.boolean().optional(),
  })
  .strict();
const columnSchema = z
  .object({
    name: identifierSchema,
    type: identifierSchema,
    nullable: z.boolean(),
    size: z.number().int().positive().optional(),
    scale: z.number().int().nonnegative().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    comment: z.string().optional(),
    generatedExpression: sqlTextSchema.optional(),
    generatedStored: z.boolean().optional(),
    identityGeneration: z.enum(['ALWAYS', 'BY DEFAULT']).optional(),
    identityOptions: identityOptionsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.identityOptions && !value.identityGeneration) {
      context.addIssue({ code: 'custom', message: 'Identity options require identity generation' });
    }
    if (value.generatedStored !== undefined && !value.generatedExpression) {
      context.addIssue({ code: 'custom', message: 'Generated storage requires an expression' });
    }
    if (
      value.generatedExpression &&
      (value.identityGeneration !== undefined || value.default !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Generated columns exclude identity and default',
      });
    }
    if (value.identityGeneration && value.default !== undefined) {
      context.addIssue({ code: 'custom', message: 'Identity columns exclude defaults' });
    }
  });
const primaryKeySchema = z
  .object({
    kind: z.literal('primaryKey'),
    name: identifierSchema,
    columns: z.array(identifierSchema).min(1),
  })
  .strict();
const uniqueConstraintSchema = z
  .object({
    kind: z.literal('unique'),
    name: identifierSchema,
    columns: z.array(identifierSchema).min(1),
  })
  .strict();
const checkConstraintSchema = z
  .object({ kind: z.literal('check'), name: identifierSchema, expression: sqlTextSchema })
  .strict();
const foreignKeySchema = z
  .object({
    name: identifierSchema,
    kind: z.literal('foreignKey'),
    columns: z.array(identifierSchema).min(1),
    referencedSchema: identifierSchema,
    referencedTable: identifierSchema,
    referencedColumns: z.array(identifierSchema).min(1),
    onUpdate: z.enum(['CASCADE', 'RESTRICT', 'SET NULL', 'SET DEFAULT', 'NO ACTION']),
    onDelete: z.enum(['CASCADE', 'RESTRICT', 'SET NULL', 'SET DEFAULT', 'NO ACTION']),
  })
  .strict()
  .refine(value => value.columns.length === value.referencedColumns.length, {
    message: 'Foreign key column counts differ',
  });
const indexSchema = z
  .object({
    name: identifierSchema,
    columns: z.array(identifierSchema),
    unique: z.boolean(),
    method: z.enum(['btree', 'hash', 'gist', 'gin', 'brin', 'spgist', 'bloom']).optional(),
    where: sqlTextSchema.optional(),
    concurrent: z.boolean(),
    include: z.array(identifierSchema).optional(),
    expression: sqlTextSchema.optional(),
    storageParams: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    tablespace: identifierSchema.optional(),
  })
  .strict()
  .refine(value => value.columns.length > 0 || value.expression !== undefined, {
    message: 'Index requires columns or an expression',
  });
const tableSchema = z
  .object({
    schema: identifierSchema,
    name: identifierSchema,
    columns: z.array(columnSchema),
    primaryKey: primaryKeySchema.optional(),
    uniqueConstraints: z.array(uniqueConstraintSchema),
    checkConstraints: z.array(checkConstraintSchema),
    foreignKeys: z.array(foreignKeySchema),
    indexes: z.array(indexSchema),
    comment: z.string().optional(),
  })
  .strict();
const schemaSnapshotV1Schema = z
  .object({
    formatVersion: z.literal(1),
    defaultSchema: identifierSchema,
    extensions: z.array(z.object({ name: identifierSchema }).strict()),
    schemas: z.array(z.object({ name: identifierSchema }).strict()),
    tables: z.array(tableSchema),
    views: z.array(
      z
        .object({
          schema: identifierSchema,
          name: identifierSchema,
          source: sqlTextSchema,
          materialized: z.boolean(),
          comment: z.string().optional(),
        })
        .strict()
    ),
  })
  .strict()
  .superRefine((value, context) => {
    reportDuplicates(
      value.extensions.map(item => item.name),
      ['extensions'],
      context
    );
    reportDuplicates(
      value.schemas.map(item => item.name),
      ['schemas'],
      context
    );
    reportDuplicates(
      value.tables.map(item => `${item.schema}.${item.name}`),
      ['tables'],
      context
    );
    reportDuplicates(
      value.views.map(item => `${item.schema}.${item.name}`),
      ['views'],
      context
    );

    const schemas = new Set(value.schemas.map(item => item.name));
    const tables = new Map(value.tables.map(table => [`${table.schema}.${table.name}`, table]));
    if (!schemas.has(value.defaultSchema)) addRelationshipIssue(context, ['defaultSchema']);
    reportDuplicates(
      [
        ...value.tables.map(item => `${item.schema}.${item.name}`),
        ...value.views.map(item => `${item.schema}.${item.name}`),
      ],
      ['relations'],
      context
    );
    for (const [tableIndex, table] of value.tables.entries()) {
      if (!schemas.has(table.schema))
        addRelationshipIssue(context, ['tables', tableIndex, 'schema']);
      reportDuplicates(
        table.columns.map(column => column.name),
        ['tables', tableIndex, 'columns'],
        context
      );
      reportDuplicates(
        [
          ...(table.primaryKey ? [table.primaryKey.name] : []),
          ...table.uniqueConstraints.map(item => item.name),
          ...table.checkConstraints.map(item => item.name),
          ...table.foreignKeys.map(item => item.name),
        ],
        ['tables', tableIndex, 'constraints'],
        context
      );
      reportDuplicates(
        table.indexes.map(item => item.name),
        ['tables', tableIndex, 'indexes'],
        context
      );
      const localColumns = new Set(table.columns.map(column => column.name));
      const localGroups = [
        ...(table.primaryKey ? [table.primaryKey.columns] : []),
        ...table.uniqueConstraints.map(item => item.columns),
        ...table.foreignKeys.map(item => item.columns),
        ...table.indexes.map(item => [...item.columns, ...(item.include ?? [])]),
      ];
      if (localGroups.some(columns => columns.some(column => !localColumns.has(column)))) {
        addRelationshipIssue(context, ['tables', tableIndex]);
      }
      for (const [foreignKeyIndex, foreignKey] of table.foreignKeys.entries()) {
        const referenced = tables.get(
          `${foreignKey.referencedSchema}.${foreignKey.referencedTable}`
        );
        const referencedColumns = new Set(referenced?.columns.map(column => column.name) ?? []);
        const localColumnByName = new Map(table.columns.map(column => [column.name, column]));
        const referencedColumnByName = new Map(
          referenced?.columns.map(column => [column.name, column]) ?? []
        );
        const referencedKeyMatches = referenced
          ? [
              ...(referenced.primaryKey ? [referenced.primaryKey.columns] : []),
              ...referenced.uniqueConstraints.map(constraint => constraint.columns),
            ].some(
              columns =>
                columns.length === foreignKey.referencedColumns.length &&
                columns.every((column, index) => column === foreignKey.referencedColumns[index])
            )
          : false;
        const referencedTypesMatch = foreignKey.columns.every((localName, index) => {
          const local = localColumnByName.get(localName);
          const target = referencedColumnByName.get(foreignKey.referencedColumns[index] ?? '');
          return (
            local !== undefined &&
            target !== undefined &&
            local.type === target.type &&
            local.size === target.size &&
            local.scale === target.scale
          );
        });
        if (
          !referenced ||
          foreignKey.referencedColumns.some(column => !referencedColumns.has(column)) ||
          !referencedKeyMatches ||
          !referencedTypesMatch
        ) {
          addRelationshipIssue(context, ['tables', tableIndex, 'foreignKeys', foreignKeyIndex]);
        }
      }
    }
    for (const [viewIndex, view] of value.views.entries()) {
      if (!schemas.has(view.schema)) addRelationshipIssue(context, ['views', viewIndex, 'schema']);
    }
  });

/** Adds one stable duplicate-identity validation issue. */
function reportDuplicates(
  values: readonly string[],
  path: readonly PropertyKey[],
  context: z.RefinementCtx
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate canonical identity', path: [...path] });
  }
}

/** Adds one stable missing-reference validation issue. */
function addRelationshipIssue(context: z.RefinementCtx, path: readonly PropertyKey[]): void {
  context.addIssue({ code: 'custom', message: 'Missing canonical relationship', path: [...path] });
}

/** Recursively marks parsed canonical data immutable to migration consumers. */
type DeepReadonly<Value> = Value extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value;

/** Version-one data-only desired PostgreSQL schema snapshot. */
export type SchemaSnapshotV1 = DeepReadonly<z.infer<typeof schemaSnapshotV1Schema>>;

/** One canonical table state. */
export type TableState = SchemaSnapshotV1['tables'][number];

/** One canonical column state. */
export type ColumnState = TableState['columns'][number];

/** One canonical view state. */
export type ViewState = SchemaSnapshotV1['views'][number];

/**
 * Strictly validates unknown JSON-compatible data as a version-one snapshot.
 *
 * @param value - Untrusted parsed JSON value.
 * @returns Validated data containing only supported version-one keys and primitives.
 * @throws {z.ZodError} When a key, value, or relationship is invalid.
 */
export function validateSchemaSnapshot(value: unknown): SchemaSnapshotV1 {
  return schemaSnapshotV1Schema.parse(value);
}
