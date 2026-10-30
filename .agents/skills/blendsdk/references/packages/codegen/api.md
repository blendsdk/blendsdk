> **Package**: `blendsdk/codegen`

# codegen API Reference

Install the umbrella package; this package is one subpath of it.

```bash
npm install blendsdk
```

PostgreSQL-backed operations (`introspect`, `up`, `down`, `status`, `validate`, `adopt-baseline`) additionally need the optional `pg` peer installed alongside the umbrella.

Every symbol in this reference is exported from the package root (`src/index.ts`). Classes, functions, and values are normal exports; interfaces and type aliases are type-only exports and must be imported with `import type` (or a mixed `import { type X }`) under `verbatimModuleSyntax`.

---

## Contents

| Section | Symbols |
|---------|---------|
| [Schema authoring](#schema-authoring) | `SchemaContainer`, `SchemaScope`, `SchemaUtils`, `AnySchema`, `BooleanSchema`, `DateSchema`, `ObjectSchema`, `ObjectProps`, `PrimitiveSchema`, `StringSchema`, `NumberSchema`, `BinarySchema`, `BigIntSchema`, `ReferenceSchema` |
| [Database model](#database-model) | `DatabaseSchema`, `TableSchema`, `TableColumnSchema`, `ForeignKeyConstraint`, `IndexConstraint`, `MakeTable`, `ColumnType`, `ReferentialAction`, `ForeignKeyDeferrability`, `IndexMethod`, `BeforeGenerateHook`, `DatabaseSchemaOptions` |
| [PostgreSQL introspection](#postgresql-introspection) | `PostgreSQLIntrospector`, `ColumnMapper`, `ConstantType`, `ColumnIntrospection`, `ForeignKeyInfo`, `CheckConstraintInfo` |
| [Type and validator generators](#type-and-validator-generators) | `TypeGenerator`, `TypeGeneratorOptions`, `ZodGenerator`, `ZodGeneratorOptions`, `SchemaUtils` |
| [SQL and constant generators](#sql-and-constant-generators) | `PostgreSQLSchemaGenerator`, `GenerateOptions`, `GeneratedDDL`, `CTypeGenerator` |
| [OpenAPI generation](#openapi-generation) | `OpenAPIGenerator`, `ControllerConstructor`, all `OpenAPI*` document types, `OpenAPIGeneratorConfig` |
| [Zod to OpenAPI conversion](#zod-to-openapi-conversion) | `convertZodToJsonSchema`, `convertZodToQueryParameters`, `hoistDefinitions`, `isZodSchema`, `sortByName` |
| [API client generation](#api-client-generation) | `generateClient`, `checkClient`, `formatOpenApiDocument`, `ClientGeneratorOptions`, `GeneratedOperation`, `ContractIssue`, `ContractIssueSeverity`, `GenerationResult`, `ClientGenerationError` |
| [API contract configuration](#api-contract-configuration) | `defineApiContract`, `ApiContract`, `ApiContractController`, `ResolvedApiContract` |
| [Migrations](#migrations) | `defineMigrationConfig`, `generateMigration`, `generateBaseline`, `adoptBaseline`, `runMigrations`, `getMigrationStatus`, `validateMigrations`, `MigrationError`, `formatMigrationError`, and all migration types |
| [Complete export index](#complete-export-index) | Flat list of every public name |

---

## Schema Authoring

The schema DSL is a registry of named schema objects plus a scope that creates them. Every object records generator-facing data (`tsType`, `zodType`, modifiers, constraints) that the generators read; nothing is written until a generator runs.

### SchemaContainer

Owns the registered schema objects and enforces unique `(scope, name)` identities.

```typescript fragment
class SchemaContainer {
  constructor();
  getAll(): SchemaObject[];
  clear(): this;
  find(scope: string | undefined, name: string): SchemaObject | undefined;
  add(obj: SchemaObject): void;
  assert(name: string, scope: string | undefined): void;
  scope(name?: string): SchemaScope;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor()` | `SchemaContainer` | Creates an empty registry with no registered names. |
| `getAll` | `getAll(): SchemaObject[]` | `SchemaObject[]` | All registered objects in registration order. |
| `clear` | `clear(): this` | `this` | Drops every registered object and resets the identity index. |
| `find` | `find(scope: string \| undefined, name: string): SchemaObject \| undefined` | `SchemaObject \| undefined` | Finds one object by scope and name. The default scope is `undefined`; pass `undefined` to match it. |
| `add` | `add(obj: SchemaObject): void` | `void` | Registers an object. Throws when a named object with the same scope already exists. |
| `assert` | `assert(name: string, scope: string \| undefined): void` | `void` | Validates that a `(scope, name)` pair is free; used internally by `named`/`scope` and safe to call before manual registration. |
| `scope` | `scope(name?: string): SchemaScope` | `SchemaScope` | Creates a builder bound to a scope. Omitting the name uses the default scope. |

`SchemaObject` is the internal abstract base class; it is not a named export. Values returned from this class are structurally typed, so `getName()`, `getScope()`, and `getData()` are always available.

**Example**

```typescript
import { SchemaContainer, SchemaUtils, TypeGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

scope
  .object({
    id: scope.number(),
    email: scope.string().pattern('^[^@\\s]+@[^@\\s]+$').maxLength(320),
    nickname: scope.string().optional(),
  })
  .named('customer');

const customer = container.find(undefined, 'customer');
if (!customer) {
  throw new Error('The customer schema was not registered.');
}

console.log(SchemaUtils.getTypeScriptName(customer)); // Customer
console.log(await new TypeGenerator().generate(container));
```

---

### SchemaScope

Factory for every schema object kind. Each factory registers the new object with the owning container and stamps it with the scope's name.

```typescript fragment
class SchemaScope {
  constructor(container: SchemaContainer, name?: string);
  bigint(): BigIntSchema;
  number(): NumberSchema;
  string(): StringSchema;
  binary(): BinarySchema;
  date(): DateSchema;
  boolean(): BooleanSchema;
  ref(obj: SchemaObject): ReferenceSchema;
  object(properties: ObjectProps): ObjectSchema;
  any(): AnySchema;
  unknown(): AnySchema;
  find(name: string): SchemaObject | undefined;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(container: SchemaContainer, name?: string)` | `SchemaScope` | Binds a new scope to a container. Prefer `container.scope(name?)`. |
| `bigint` | `bigint(): BigIntSchema` | `BigIntSchema` | Renders as `BigInt` (note the capital `I`, matching the source). |
| `number` | `number(): NumberSchema` | `NumberSchema` | Renders as `number`. |
| `string` | `string(): StringSchema` | `StringSchema` | Renders as `string`; supports `pattern`, `minLength`, `maxLength`, and `enum`. |
| `binary` | `binary(): BinarySchema` | `BinarySchema` | PostgreSQL `bytea`: TypeScript `Buffer`, Zod `z.instanceof(Buffer)`. |
| `date` | `date(): DateSchema` | `DateSchema` | Renders as `Date`. |
| `boolean` | `boolean(): BooleanSchema` | `BooleanSchema` | Renders as `boolean`. |
| `ref` | `ref(obj: SchemaObject): ReferenceSchema` | `ReferenceSchema` | A reference to another named schema; renders as that type name and supports `partial`/`arrayed`/`nullable`. |
| `object` | `object(properties: ObjectProps): ObjectSchema` | `ObjectSchema` | An inline object from a property map; every supplied property is marked as a child. |
| `any` | `any(): AnySchema` | `AnySchema` | TypeScript `any`, Zod `z.any()`. |
| `unknown` | `unknown(): AnySchema` | `AnySchema` | TypeScript `unknown`, Zod `z.unknown()` — the safe default for `json`/`jsonb`. |
| `find` | `find(name: string): SchemaObject \| undefined` | `SchemaObject \| undefined` | Looks up an object in this scope. |

---

### Schema object classes

Every class below shares the fluent members inherited from the internal `SchemaObject` base, plus the members listed per class.

#### Inherited fluent members

```typescript fragment
reset(): void;
metadata(data: Record<string, any>): void;
setData(data: SchemaObjectData): void;
hasParent(): boolean;
isRendered(): boolean;
arrayed(): this;
description(text: string | string[] | undefined, prefix?: boolean): this;
recordSet(): this;
partial(): this;
nullable(): this;
optional(): this;
named(value: string): this;
scope(value?: string): this;
getData(): SchemaObjectData;
getNamedScoped(): string;
getName(): string | undefined;
getScope(): string | undefined;
```

| Method | Returns | Description |
|--------|---------|-------------|
| `reset()` | `void` | Clears the `rendered` flag. Each generator calls this on every object before a pass. |
| `metadata(data)` | `void` | Merges caller metadata into `getData().metadata`. Never rendered; available to custom generators and mappers. |
| `setData(data)` | `void` | Merges generator data. This is the supported escape hatch for `ColumnMapper` overrides (`tsType`, `zodExpression`, …). |
| `hasParent()` | `boolean` | True when the object is a property of an `ObjectSchema`. Nested objects render inline. |
| `isRendered()` | `boolean` | True once a generator has emitted this object. |
| `arrayed()` | `this` | Renders `T[]`; arrays of unions are parenthesized in Zod→OpenAPI output. |
| `description(text, prefix?)` | `this` | Appends JSDoc lines; `prefix: true` prepends instead. `*/` inside text is escaped. |
| `recordSet()` | `this` | Wraps the type as `Record<string, T>`. |
| `partial()` | `this` | Wraps the type as `Partial<T>` / appends `.partial()` in Zod. |
| `nullable()` | `this` | Adds `\| null` / appends `.nullable()`. |
| `optional()` | `this` | Marks a property optional (`?`) / appends `.optional()`. |
| `named(value)` | `this` | Registers the name; throws when the identity is taken. Required for a root type. |
| `scope(value?)` | `this` | Assigns the scope used in `getNamedScoped()` and generated names. |
| `getData()` | `SchemaObjectData` | Current generator data. |
| `getNamedScoped()` | `string` | `scope.name`, or just `name` when there is no scope. |
| `getName()` / `getScope()` | `string \| undefined` | The registered identity parts. |

`SchemaObjectData` (the shape passed to `setData` and returned by `getData`) is not a named export. Its fields:

| Field | Type | Description |
|-------|------|-------------|
| `description` | `string[] \| undefined` | Accumulated JSDoc lines. |
| `primitive` | `boolean \| undefined` | True for leaf types. |
| `tsType` | `string \| undefined` | Rendered TypeScript type text. |
| `zodType` | `string \| undefined` | Zod constructor name, e.g. `string`. |
| `zodExpression` | `string \| undefined` | Full Zod expression overriding `z.<zodType>()`, e.g. `z.instanceof(Buffer)`. |
| `optional` / `nullable` / `partial` / `arrayed` / `recordOf` | `boolean \| undefined` | Modifier flags. |
| `parent` | `SchemaObject \| undefined` | Owning object for nested rendering. |
| `rendered` | `boolean \| undefined` | Emission guard. |
| `ref` | `SchemaObject \| undefined` | Reference target. |
| `declType` | `string \| undefined` | `interface` or `type`. |
| `metadata` | `Record<string, any>` | Caller metadata. |
| `pattern` / `minLength` / `maxLength` | `string` / `number` / `number` | String contract constraints. |

#### AnySchema

```typescript fragment
class AnySchema {
  constructor(container: SchemaContainer);
}
```

Renders TypeScript `any` / Zod `z.any()`. `SchemaScope.unknown()` also returns this class but overrides the data to `tsType: 'unknown'` and `zodType: 'unknown'`.

#### BooleanSchema

```typescript fragment
class BooleanSchema {
  constructor(container: SchemaContainer);
}
```

Renders `boolean` / `z.boolean()`.

#### DateSchema

```typescript fragment
class DateSchema {
  constructor(container: SchemaContainer);
}
```

Renders `Date` / `z.date()`.

#### ObjectSchema

```typescript fragment
class ObjectSchema {
  constructor(container: SchemaContainer);
  properties(props: ObjectProps): void;
  getProperties(): ObjectProps;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `properties` | `properties(props: ObjectProps): void` | `void` | Merges properties and marks each as a child. **Not chainable** — continue the chain from the object reference, not the call. |
| `getProperties` | `getProperties(): ObjectProps` | `ObjectProps` | Current property map. |

#### ObjectProps

```typescript fragment
type ObjectProps = Record<string, SchemaObject>;
```

#### PrimitiveSchema

Abstract base for `StringSchema`, `NumberSchema`, `BinarySchema`, and `BigIntSchema`.

```typescript fragment
abstract class PrimitiveSchema {
  constructor(container: SchemaContainer);
  enum(values: string[] | number[]): this;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `enum` | `enum(values: string[] \| number[]): this` | `this` | Replaces the rendered type with a literal union, e.g. `('up' \| 'down')`. Prettier normalizes quoting in output. |

#### StringSchema

```typescript fragment
class StringSchema {
  constructor(container: SchemaContainer);
  pattern(value: string | RegExp): this;
  minLength(value: number): this;
  maxLength(value: number): this;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `pattern` | `pattern(value: string \| RegExp): this` | `this` | Stores the regular-expression source. Throws for an empty or invalid pattern, or for a `RegExp` carrying flags (flags cannot be represented in Zod or OpenAPI). |
| `minLength` | `minLength(value: number): this` | `this` | Non-negative integer. Throws when it is not an integer, is negative, or exceeds an already-set `maxLength`. |
| `maxLength` | `maxLength(value: number): this` | `this` | Non-negative integer. Throws when it is not an integer, is negative, or is below an already-set `minLength`. |

Constraints reach all three targets: JSDoc in `TypeGenerator` (`@pattern`, `@minLength`, `@maxLength`), `.regex(new RegExp(...))` / `.min()` / `.max()` in `ZodGenerator`, and `pattern` / `minLength` / `maxLength` in the OpenAPI schema.

**Example**

```typescript
import { SchemaContainer, TypeGenerator, ZodGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

const projectName = scope
  .string()
  .pattern('^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$')
  .minLength(3)
  .maxLength(40)
  .named('project_name');

console.log(await new TypeGenerator().generate(container));
console.log(await new ZodGenerator().generate(container));
console.log(projectName.getName());
```

#### NumberSchema

```typescript fragment
class NumberSchema {
  constructor(container: SchemaContainer);
}
```

Renders `number` / `z.number()`.

#### BinarySchema

```typescript fragment
class BinarySchema {
  constructor(container: SchemaContainer);
}
```

Renders TypeScript `Buffer` and the Zod expression `z.instanceof(Buffer)`. Used for PostgreSQL `bytea`.

#### BigIntSchema

```typescript fragment
class BigIntSchema {
  constructor(container: SchemaContainer);
}
```

Renders `BigInt` / `z.number()`.

#### ReferenceSchema

```typescript fragment
class ReferenceSchema {
  constructor(container: SchemaContainer, refSchema: SchemaObject);
}
```

Points at another schema object. The reference target must be named; generators throw `Referenced schema is not named!` otherwise. A reference renders as the target's type name, so modifiers compose: `scope.ref(row).partial().arrayed()` → `Partial<Row>[]`.

---

### SchemaUtils

Static helpers shared by generators and available to custom emitters.

```typescript fragment
class SchemaUtils {
  static getTypeScriptName(obj: SchemaObject): string;
  static snakeToPascalCase(str: string): string;
  static formatMultilineComment(
    lines: string[],
    style?: 'jsdoc' | 'block' | 'line'
  ): string[];
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `getTypeScriptName` | `static getTypeScriptName(obj: SchemaObject): string` | `string` | PascalCase form of `getNamedScoped()`, with `.` treated as `_`. |
| `snakeToPascalCase` | `static snakeToPascalCase(str: string): string` | `string` | Converts `snake_case`, `dot.case`, and double underscores. Preserves casing when there is no separator beyond capitalizing the first character. |
| `formatMultilineComment` | `static formatMultilineComment(lines: string[], style?: 'jsdoc' \| 'block' \| 'line'): string[]` | `string[]` | Renders comment lines. Defaults to `jsdoc`. `*/` inside a line is escaped so a description or pattern cannot close the comment early. |

**Example**

```typescript
import { SchemaUtils } from 'blendsdk/codegen';

console.log(SchemaUtils.snakeToPascalCase('api_v1.user_request')); // ApiV1UserRequest
console.log(SchemaUtils.formatMultilineComment(['@export', '@constant']));
// ['/**', ' * @export', ' * @constant', ' */']
```

---

## Database Model

The database model is a second fluent layer that describes a PostgreSQL schema: extensions, schemas, tables, columns, constraints, indexes, and views. It is consumed by `PostgreSQLSchemaGenerator` (bootstrap DDL) and by the migration normalizer (canonical desired state).

### DatabaseSchema

```typescript fragment
class DatabaseSchema {
  constructor(name: string, defaultScope?: string);
  extension(...extension: string[]): this;
  table(name: string, builder?: MakeTable): TableSchema;
  view(name: string): ViewSchema;
  getExtensions(): string[];
  getTables(): TableSchema[];
  getViews(): ViewSchema[];
  getDefaultSchema(): string;
  comment(comment: string): this;
  getComment(): string | undefined;
  getName(): string;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(name: string, defaultScope?: string)` | `DatabaseSchema` | `defaultScope` defaults to `'public'`; unqualified tables and views receive it. |
| `extension` | `extension(...extension: string[]): this` | `this` | Declares extensions. Duplicates are collapsed when the DDL is rendered. |
| `table` | `table(name: string, builder?: MakeTable): TableSchema` | `TableSchema` | Creates and registers a table, applies the default scope, then runs the optional builder. |
| `view` | `view(name: string): ViewSchema` | `ViewSchema` | Creates and registers a view with the default scope. |
| `getExtensions` | `getExtensions(): string[]` | `string[]` | Declared extensions, falsy entries removed. |
| `getTables` | `getTables(): TableSchema[]` | `TableSchema[]` | Registration-order tables. |
| `getViews` | `getViews(): ViewSchema[]` | `ViewSchema[]` | Registration-order views. |
| `getDefaultSchema` | `getDefaultSchema(): string` | `string` | The default scope. |
| `comment` | `comment(comment: string): this` | `this` | Database-level comment. |
| `getComment` | `getComment(): string \| undefined` | `string \| undefined` | The stored comment. |
| `getName` | `getName(): string` | `string` | The database name. |

#### ViewSchema (returned by `DatabaseSchema.view`)

`ViewSchema` is not a named export, but the returned builder exposes:

```typescript fragment
as(source: string): this;
materialized(state: boolean): this;
isMaterialized(): boolean;
getSource(): string | undefined;
scope(name: string): this;
getName(scope?: boolean): string;
getScope(): string | undefined;
comment(comment: string): this;
getComment(): string | undefined;
```

`getName(scope?)` defaults to `true` and returns `scope.name`.

#### MakeTable

```typescript fragment
type MakeTable = (t: TableSchema) => void;
```

#### DatabaseSchemaOptions

```typescript fragment
interface DatabaseSchemaOptions {
  defaultSchema?: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `defaultSchema` | `string` (optional) | Intended default schema name. The `DatabaseSchema` constructor takes `defaultScope` directly. |

---

### TableSchema

```typescript fragment
class TableSchema {
  constructor(name: string, database: DatabaseSchema);
  foreignKeyConstraint(toTable: TableSchema): ForeignKeyConstraint;
  uniqueConstraint(): UniqueConstraint;
  checkConstraint(rule: string): this;
  index(): IndexConstraint;
  getForeignKeyConstrains(): ForeignKeyConstraint[];
  getCheckConstraints(): CheckConstraint[];
  getUniqueConstraints(): UniqueConstraint[];
  getIndexes(): IndexConstraint[];
  primaryKey(): PrimaryKeyConstraint;
  getPrimaryKey(): PrimaryKeyConstraint | undefined;

  integer(name: string): TableColumnSchema;
  varchar(name: string, size?: number): TableColumnSchema;
  serial(name: string): TableColumnSchema;
  bigserial(name: string): TableColumnSchema;
  smallint(name: string): TableColumnSchema;
  bigint(name: string): TableColumnSchema;
  decimal(name: string, size?: number, scale?: number): TableColumnSchema;
  numeric(name: string, size?: number, scale?: number): TableColumnSchema;
  real(name: string): TableColumnSchema;
  doublePrecision(name: string): TableColumnSchema;
  char(name: string, size?: number): TableColumnSchema;
  text(name: string): TableColumnSchema;
  boolean(name: string): TableColumnSchema;
  date(name: string): TableColumnSchema;
  time(name: string, size?: number): TableColumnSchema;
  timestamp(name: string, size?: number): TableColumnSchema;
  timestamptz(name: string, size?: number): TableColumnSchema;
  json(name: string): TableColumnSchema;
  jsonb(name: string): TableColumnSchema;
  bytea(name: string): TableColumnSchema;
  inet(name: string): TableColumnSchema;
  uuid(name: string): TableColumnSchema;
  vector(name: string): TableColumnSchema;
  tsvector(name: string): TableColumnSchema;

  scope(name: string): this;
  getName(scope?: boolean): string;
  getScope(): string | undefined;
  findColumn(name: string): TableColumnSchema | undefined;
  getColumns(): TableColumnSchema[];
  getDatabase(): DatabaseSchema;
  comment(comment: string): this;
  getComment(): string | undefined;
}
```

**Constraint and index factories**

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `foreignKeyConstraint` | `foreignKeyConstraint(toTable: TableSchema): ForeignKeyConstraint` | `ForeignKeyConstraint` | Creates and registers a foreign key. Configure with `.from(...)` / `.to(...)`. |
| `uniqueConstraint` | `uniqueConstraint(): UniqueConstraint` | `UniqueConstraint` | Creates and registers a unique constraint; add columns with `.column(...)`. |
| `checkConstraint` | `checkConstraint(rule: string): this` | `this` (the table) | Creates and registers a check constraint and returns the **table**, so chaining continues on the table. |
| `index` | `index(): IndexConstraint` | `IndexConstraint` | Creates and registers an index. |
| `getForeignKeyConstrains` | `getForeignKeyConstrains(): ForeignKeyConstraint[]` | `ForeignKeyConstraint[]` | Registered foreign keys (note the spelling in the source). |
| `getCheckConstraints` | `getCheckConstraints(): CheckConstraint[]` | `CheckConstraint[]` | Registered check constraints. |
| `getUniqueConstraints` | `getUniqueConstraints(): UniqueConstraint[]` | `UniqueConstraint[]` | Registered unique constraints. |
| `getIndexes` | `getIndexes(): IndexConstraint[]` | `IndexConstraint[]` | Registered indexes. |
| `primaryKey` | `primaryKey(): PrimaryKeyConstraint` | `PrimaryKeyConstraint` | Returns the table's primary key, creating it on first call. Add columns with `.column(...)`. |
| `getPrimaryKey` | `getPrimaryKey(): PrimaryKeyConstraint \| undefined` | `PrimaryKeyConstraint \| undefined` | Read-only accessor; never creates a primary key. |

`CheckConstraint`, `UniqueConstraint`, and `PrimaryKeyConstraint` are not named exports. All three extend a shared constraint base and expose:

```typescript fragment
column(...column: string[]): this;
hasColumns(): boolean;
getTable(): TableSchema;
getColumns(): ColumnSchema<TableSchema>[];
```

`column(...)` throws when a named column does not exist on the table. `getColumns()` returns column objects whose `getName()` yields the column name.

**Column helpers** — every method creates a column of the named PostgreSQL type, registers it, and returns the new `TableColumnSchema`. `varchar`, `decimal`, `numeric`, `char`, `time`, `timestamp`, and `timestamptz` accept an optional size/scale.

**Identity members** — `getName(scope?)` defaults to `true` and returns `scope.name`; `findColumn` matches on the unqualified name; `getColumns()` returns columns in declaration order.

```typescript fragment
type ColumnType =
  | 'serial' | 'bigserial' | 'smallint' | 'integer' | 'bigint'
  | 'decimal' | 'numeric' | 'real' | 'double precision'
  | 'varchar' | 'char' | 'text'
  | 'boolean'
  | 'date' | 'time' | 'timestamp' | 'timestamptz'
  | 'json' | 'jsonb'
  | 'bytea' | 'inet'
  | 'uuid'
  | 'vector' | 'tsvector';
```

---

### TableColumnSchema

```typescript fragment
class TableColumnSchema {
  references(
    toTable: TableSchema,
    column: string,
    onUpdate?: ReferentialAction,
    onDelete?: ReferentialAction
  ): this;
  scale(value: number): void;
  size(value: number): void;
  unique(): this;
  check(rule: string): this;
  primaryKey(): this;
  default(value: string | boolean | number | undefined, quote?: boolean): this;
  nullable(): this;
  type(type: ColumnType): this;
  getDefault(): string | boolean | number | undefined;
  getNullable(): boolean;
  getType(): ColumnType | undefined;
  getSize(): number | undefined;
  getScale(): number | undefined;
  generated(expression: string, stored?: 'STORED' | 'VIRTUAL'): this;
  getGeneratedExpression(): string | undefined;
  isGenerated(): boolean;
  isGeneratedStored(): boolean;
  identity(
    generationOrFunction?: 'ALWAYS' | 'BY DEFAULT' | 'v4' | 'v7' | string,
    options?: {
      start?: number;
      increment?: number;
      minValue?: number;
      maxValue?: number;
      cache?: number;
      cycle?: boolean;
    }
  ): this;
  getIdentityGeneration(): 'ALWAYS' | 'BY DEFAULT' | undefined;
  getIdentityOptions(): { start?: number; increment?: number; minValue?: number; maxValue?: number; cache?: number; cycle?: boolean } | undefined;
  isIdentity(): boolean;
  getName(): string;
  getComment(): string | undefined;
  comment(comment: string): this;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `references` | `references(toTable, column, onUpdate?, onDelete?): this` | `this` | Shorthand: creates a foreign key from this column to `toTable.column`. |
| `scale` | `scale(value: number): void` | `void` | Sets numeric scale. **Not chainable.** |
| `size` | `size(value: number): void` | `void` | Sets length or precision. **Not chainable.** |
| `unique` | `unique(): this` | `this` | Adds a single-column unique constraint. |
| `check` | `check(rule: string): this` | `this` | Adds a table-level check constraint with the given rule. |
| `primaryKey` | `primaryKey(): this` | `this` | Adds this column to the primary key, also marks it unique, and forces `NOT NULL`. |
| `default` | `default(value: string \| boolean \| number \| undefined, quote?: boolean): this` | `this` | Sets the default. With `quote: true` the value is single-quoted for SQL. |
| `nullable` | `nullable(): this` | `this` | Removes `NOT NULL`. |
| `type` | `type(type: ColumnType): this` | `this` | Overrides the column type. |
| `generated` | `generated(expression: string, stored?: 'STORED' \| 'VIRTUAL'): this` | `this` | Marks the column `GENERATED ALWAYS AS (expression) STORED`. Throws for `'VIRTUAL'` (PostgreSQL has no virtual generated columns) and clears any default. |
| `identity` | `identity(generationOrFunction?, options?): this` | `this` | Integer columns emit `GENERATED ALWAYS\|BY DEFAULT AS IDENTITY` with the optional sequence options. |
| `isIdentity` / `isGenerated` / `isGeneratedStored` | `(): boolean` | `boolean` | State predicates. |
| `getIdentityGeneration` / `getIdentityOptions` | see signature | value or `undefined` | Read-back for snapshot normalization. |
| `getDefault` / `getNullable` / `getType` / `getSize` / `getScale` / `getGeneratedExpression` | see signature | value | Read-back accessors. |

`identity()` on a `uuid` column takes a different path: it assigns a UUID default and returns `undefined` (not `this`), so do not chain after an identity call on a UUID column.

| UUID generator argument | SQL default | Extension registered |
|-------------------------|-------------|----------------------|
| `'v4'` | `uuid_generate_v4()` | `uuid-ossp` |
| `'v7'` | `uuid_generate_v7()` | `pg_uuidv7` |
| `undefined`, `'ALWAYS'`, `'BY DEFAULT'` | `gen_random_uuid()` | none (PostgreSQL 13+) |
| any other string | that string, verbatim | none |

`identity()` on a non-integer, non-UUID column throws `IDENTITY columns must be integer or uuid types`. On an integer column it clears any default, and it throws when the column is already `GENERATED`.

`ReferentialAction`:

```typescript fragment
type ReferentialAction = 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'SET DEFAULT' | 'NO ACTION';
```

---

### ForeignKeyConstraint

```typescript fragment
class ForeignKeyConstraint {
  constructor(table: TableSchema, refTable: TableSchema);
  deferrable(mode: ForeignKeyDeferrability): this;
  onUpdate(action: ReferentialAction | undefined): this;
  onDelete(action: ReferentialAction | undefined): this;
  to(...column: string[]): this;
  from(...column: string[]): this;
  column(...column: string[]): never;
  getRefTable(): TableSchema;
  getRefColumns(): TableColumnSchema[];
  getOnDelete(): ReferentialAction;
  getOnUpdate(): ReferentialAction;
  isDeferrable(): boolean;
  isInitiallyDeferred(): boolean;
  getColumns(): ColumnSchema<TableSchema>[];
  hasColumns(): boolean;
  getTable(): TableSchema;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `deferrable` | `deferrable(mode: ForeignKeyDeferrability): this` | `this` | Emits `DEFERRABLE INITIALLY DEFERRED` (for `'DEFERRED'`) or `INITIALLY IMMEDIATE`. Validated at runtime and throws for any other value. |
| `onUpdate` | `onUpdate(action: ReferentialAction \| undefined): this` | `this` | Sets the update action. Defaults to `'CASCADE'`; passing `undefined` keeps the current value. |
| `onDelete` | `onDelete(action: ReferentialAction \| undefined): this` | `this` | Sets the delete action. Defaults to `'RESTRICT'`; passing `undefined` keeps the current value. |
| `to` | `to(...column: string[]): this` | `this` | Referenced columns on the target table. Throws for an unknown column. |
| `from` | `from(...column: string[]): this` | `this` | Local columns on this table. Throws for an unknown column. |
| `column` | `column(...column: string[]): never` | never returns | Always throws `Use the from() and to()`. |
| `isDeferrable` / `isInitiallyDeferred` | `(): boolean` | `boolean` | Runtime state of the two deferrability flags. |
| `getOnUpdate` / `getOnDelete` / `getRefTable` / `getRefColumns` | see signature | value | Read-back accessors used by the DDL generator and the snapshot normalizer. |

```typescript fragment
type ForeignKeyDeferrability = 'DEFERRED' | 'IMMEDIATE';
```

---

### IndexConstraint

```typescript fragment
class IndexConstraint {
  constructor(table: TableSchema);
  unique(): this;
  using(method: IndexMethod): this;
  where(condition: string): this;
  indexName(name: string): this;
  concurrent(): this;
  include(...columns: string[]): this;
  expression(expr: string): this;
  with(params: Record<string, string | number>): this;
  tablespace(name: string): this;
  isUnique(): boolean;
  getMethod(): IndexMethod | undefined;
  getWhere(): string | undefined;
  getIndexName(): string | undefined;
  getConcurrent(): boolean;
  getInclude(): string[] | undefined;
  getExpression(): string | undefined;
  getStorageParams(): Record<string, string | number> | undefined;
  getTablespace(): string | undefined;
  column(...column: string[]): this;
  hasColumns(): boolean;
  getTable(): TableSchema;
  getColumns(): ColumnSchema<TableSchema>[];
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `unique` | `unique(): this` | `this` | Emits `CREATE UNIQUE INDEX`. |
| `using` | `using(method: IndexMethod): this` | `this` | Adds `USING <method>` (uppercased in SQL). |
| `where` | `where(condition: string): this` | `this` | Partial-index predicate, emitted after `WHERE`. |
| `indexName` | `indexName(name: string): this` | `this` | Explicit index name. When omitted, a deterministic name is derived from the table, columns, and a `idx`/`key` suffix. |
| `concurrent` | `concurrent(): this` | `this` | Adds `CONCURRENTLY` to bootstrapped DDL. Generation refuses to place a concurrent index inside a transactional migration. |
| `include` | `include(...columns: string[]): this` | `this` | Adds `INCLUDE (...)`. |
| `expression` | `expression(expr: string): this` | `this` | Replaces the column list with an expression, e.g. `lower(email)`. |
| `with` | `with(params: Record<string, string \| number>): this` | `this` | Storage parameters, emitted as `WITH (key = value, …)`. |
| `tablespace` | `tablespace(name: string): this` | `this` | `TABLESPACE` clause. |
| `isUnique` / `getMethod` / `getWhere` / `getIndexName` / `getConcurrent` / `getInclude` / `getExpression` / `getStorageParams` / `getTablespace` | see signature | value | Read-back accessors. |

```typescript fragment
type IndexMethod = 'btree' | 'hash' | 'gist' | 'gin' | 'brin' | 'spgist' | 'bloom';
```

---

### Database model types

```typescript fragment
type BeforeGenerateHook = (table: any, metadata: Record<string, any>) => void;
```

| Type | Kind | Description |
|------|------|-------------|
| `MakeTable` | type alias | `(t: TableSchema) => void` — the optional table builder. |
| `ColumnType` | type alias | The supported column type union listed under `TableSchema`. |
| `ReferentialAction` | type alias | `'CASCADE' \| 'RESTRICT' \| 'SET NULL' \| 'SET DEFAULT' \| 'NO ACTION'`. |
| `ForeignKeyDeferrability` | type alias | `'DEFERRED' \| 'IMMEDIATE'`. |
| `IndexMethod` | type alias | The seven supported index methods. |
| `BeforeGenerateHook` | type alias | Reserved hook signature; no public API currently invokes it. |
| `DatabaseSchemaOptions` | interface | `{ defaultSchema?: string }`. |

**Example**

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const database = new DatabaseSchema('shop');
database.extension('pgcrypto');

const customers = database.table('customers', table => {
  table.bigserial('id').primaryKey();
  table.varchar('email', 320).unique();
  table.text('display_name').nullable();
  table.timestamptz('created_at').default('now()');
});

const orders = database.table('orders', table => {
  table.bigserial('id').primaryKey();
  table.bigint('customer_id');
  table.numeric('total', 12, 2);
  table.index().column('customer_id').indexName('orders_customer_idx');
});

orders
  .foreignKeyConstraint(customers)
  .from('customer_id')
  .to('id')
  .onDelete('CASCADE')
  .deferrable('DEFERRED');

const { schema, indexes, all } = new PostgreSQLSchemaGenerator(database).generateGrouped();
console.log(schema);
console.log(indexes);
console.log(all);
```

---

## PostgreSQL Introspection

### PostgreSQLIntrospector

Reads a live catalog and projects it into a `SchemaContainer`, which the type and validator generators then consume. Read-only: the introspector issues one `SELECT` and never mutates the database.

```typescript fragment
class PostgreSQLIntrospector {
  constructor(db: PostgreSQLDatabase);
  introspectConstantTypes(): Promise<ConstantType>;
  introstectConstantTypes(): Promise<ConstantType>; // deprecated
  introspect(schema: SchemaContainer, mapper?: ColumnMapper): Promise<void>;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(db: PostgreSQLDatabase)` | `PostgreSQLIntrospector` | Accepts an existing database handle. The handle is stored, not owned — the caller closes it. |
| `introspectConstantTypes` | `introspectConstantTypes(): Promise<ConstantType>` | `Promise<ConstantType>` | Qualified relation → column-name map for tables, views, materialized views, and partitioned tables. Objects in `public` lose the schema prefix. |
| `introstectConstantTypes` | `introstectConstantTypes(): Promise<ConstantType>` | `Promise<ConstantType>` | Historical misspelling. |
| `introspect` | `introspect(schema: SchemaContainer, mapper?: ColumnMapper): Promise<void>` | `Promise<void>` | Populates the container: enum types first, then composite types, then tables/views. Each relation becomes a named `ObjectSchema`; each column becomes a property with nullability, default, primary-key, unique, and check metadata encoded as JSDoc directives. |

Column mapping rules (`mapPgTypeToTypescript`):

| PostgreSQL type | Schema object | TypeScript |
|-----------------|---------------|------------|
| `bool` | `boolean()` | `boolean` |
| `text`, `varchar`, `char`, `bpchar`, `name`, `uuid`, `inet`, `cidr`, `macaddr`, `macaddr8`, `money`, `bit`, `varbit`, `date`, `time`, `timetz`, `tsvector`, `tsquery`, `xid8`, `tid`, `pg_lsn`, `txid_snapshot`, `reg*` | `string()` | `string` |
| `json`, `jsonb` | `unknown()` | `unknown` |
| `outlinet2`, `int4`, `serial` | `number()` | `number` |
| `float4`, `float8` | `number()` | `number` |
| `numeric`, `decimal`, `int8`, `bigserial` | `string()` | `string` (precision/bigint preserved as text) |
| `timestamp`, `timestamptz` | `date()` | `Date` |
| `bytea` | `binary()` | `Buffer` |
| `oid`, `xid`, `cid` | `number()` | `number` |
| `xml`, `jsonpath`, `interval`, ranges, geometric types | `null` | falls back to `any` with a `@deprecated` warning |

Nullable columns become `.nullable().optional()`. Array columns become `.arrayed()`. An enum column resolves to a reference of the introspected enum schema. An unmappable type logs `[WARNING]: <schema> -> <relation> -> <pg_type> could not be mapped!` and renders as `any` with a `@deprecated` description.

```typescript fragment
type ColumnMapper = (r: ColumnIntrospection, s: SchemaScope) => SchemaObject | unknown;
```

Return a schema object created from the supplied scope to override the built-in mapping, or `undefined` to fall back. Because the declared return type includes `unknown`, annotate the mapper as `ColumnMapper` and always return a schema object or `undefined`.

**Example**

```typescript
import { PostgreSQLIntrospector, SchemaContainer, TypeGenerator } from 'blendsdk/codegen';
import type { ColumnMapper } from 'blendsdk/codegen';
import type { PostgreSQLDatabase } from 'blendsdk/postgresql';

export async function generateTypes(db: PostgreSQLDatabase): Promise<string> {
  const schema = new SchemaContainer();

  const mapper: ColumnMapper = (column, scope) => {
    if (column.pg_type !== 'jsonb' && column.pg_type !== 'json') {
      return undefined;
    }
    const mapped = scope.unknown();
    mapped.setData({
      tsType: 'Record<string, unknown>',
      zodExpression: 'z.record(z.string(), z.unknown())',
    });
    return mapped;
  };

  await new PostgreSQLIntrospector(db).introspect(schema, mapper);
  return new TypeGenerator().generate(schema);
}
```

---

### Introspection types

#### ColumnIntrospection

One row of the introspection query: a relation/column pair, or one synthetic row for an enum label, a composite member, or a domain.

| Property | Type | Description |
|----------|------|-------------|
| `database_name` | `string` | `current_database()`. |
| `schema_name` | `string` | Relation schema. `public` is normalized to `undefined` before mapping. |
| `relation_name` | `string` | Relation, type, or enum name. |
| `relation_kind` | `'table' \| 'view' \| 'materialized view' \| 'partitioned table' \| 'foreign table' \| 'enum type' \| 'composite type'` | Row category. The query also emits `'domain type'` rows, which are filtered before mapping. |
| `table_comment` | `string \| null` | Relation comment. |
| `column_name` | `string` | Column name; the enum label for enum rows. |
| `column_comment` | `string \| null` | Column comment. |
| `is_nullable` | `boolean` | `NOT attnotnull`. `null` for enum/domain rows. |
| `has_default` | `boolean` | Whether a default expression exists. |
| `column_default` | `string \| null` | The default expression. |
| `pg_type` | `string` | Undecorated PostgreSQL type name; the leading `_` of an array type is removed during mapping. |
| `formatted_type` | `string` | `format_type(...)` output. |
| `is_array` | `boolean` | Array type indicator. |
| `array_element_pg_type` | `string \| null` | Element type for arrays. |
| `array_element_formatted_type` | `string \| null` | Formatted element type for arrays. |
| `length` | `number \| null` | Character length for `varchar`/`bpchar`. |
| `precision` | `number \| null` | Numeric precision. |
| `scale` | `number \| null` | Numeric scale. |
| `is_primary_key` | `boolean` | Member of the primary-key index. |
| `is_unique` | `boolean` | Member of a unique index. |
| `is_foreign_key` | `boolean` | Member of a foreign key. |
| `fk_info` | `ForeignKeyInfo[] \| null` | Foreign-key descriptors for this column. |
| `is_check_constrained` | `boolean` | Member of a check constraint. |
| `check_constraints` | `CheckConstraintInfo[] \| null` | Declared as an array; the query actually produces a `string` of `AND`-joined `pg_get_constraintdef` output. |
| `is_enum` | `boolean` | Column type is an enum (or an array of one). |
| `enum_type_name` | `string \| null` | `schema.typename` of the enum. |
| `enum_labels` | `string[] \| string \| null` | Enum labels in sort order. |
| `type_oid` | `number` | PostgreSQL type OID. |

#### ForeignKeyInfo

| Property | Type | Description |
|----------|------|-------------|
| `constraint_name` | `string` | Constraint name. |
| `ref_schema` | `string` | Referenced schema. |
| `ref_table` | `string` | Referenced table. |
| `ref_columns` | `string[]` | Referenced columns in key order. |
| `column_positions` | `number[]` | Positional mapping of local to referenced columns. |
| `update_action` | `'NO ACTION' \| 'RESTRICT' \| 'CASCADE' \| 'SET NULL' \| 'SET DEFAULT'` | Update action. |
| `delete_action` | same union | Delete action. |
| `match_type` | `'SIMPLE' \| 'FULL' \| 'PARTIAL'` | Match type. |

The introspection query itself emits `{ constraint_name, schema, table, columns, referenced_columns }`; `ForeignKeyInfo` is the documented post-processing shape.

#### CheckConstraintInfo

| Property | Type | Description |
|----------|------|-------------|
| `constraint_name` | `string` | Constraint name. |
| `definition` | `string` | `pg_get_constraintdef` output. |

#### ConstantType

```typescript fragment
interface ConstantType {
  [name: string]: string[];
}
```

Maps a qualified relation name (or an unqualified name for `public`) to its ordered column names.

---

## Type and Validator Generators

### TypeGenerator

Emits TypeScript type text. Plain named objects become `export interface`; primitives, enums, references, and objects carrying `partial`/`nullable`/`arrayed` become `export type`.

```typescript fragment
class TypeGenerator {
  constructor(options?: TypeGeneratorOptions);
  generate(container: SchemaContainer): Promise<string>;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(options?: TypeGeneratorOptions)` | `TypeGenerator` | Options are reserved for future use. |
| `generate` | `generate(container: SchemaContainer): Promise<string>` | `Promise<string>` | Resets render state, emits every named root, and returns Prettier-formatted TypeScript. Properties of nested objects render inline; unnamed roots are skipped. |

`generate` throws when a named object is also a property (`Object properties cannot be named explicitly`), when a reference target is unnamed, or when the emitted text does not parse. On a format failure the raw source is logged before the error propagates.

Protected extension points (subclass with `protected` overrides): `renderReferenceSchema`, `renderObjectSchema`, `renderPrimitiveTypeSchema`, `modifiers`, `addDescription`, `getDeclaration`.

```typescript fragment
interface TypeGeneratorOptions {}
```

#### Declaration rules

| Object | Emitted declaration |
|--------|---------------------|
| Named plain object, no modifiers | `export interface Name { … }` |
| Named object with `partial`, `nullable`, or `arrayed` | `export type Name = <modified object>;` |
| Named primitive, enum, or reference root | `export type Name = <type>;` |
| Nested object | Inline object type in the parent |
| Reference property | Referenced type name |
| `recordSet()` | `Record<string, T>` |
| `partial()` | `Partial<T>` |
| `arrayed()` | `T[]` |
| `nullable()` | `T \| null` |

Modifiers apply in a fixed order: `Partial<T>`, then `T[]`, then `Record<string, T>`, then `T | null`.

**Example**

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

scope
  .object({
    username: scope.string(),
    password: scope.string(),
  })
  .named('user');

scope
  .object({
    user: scope.ref(container.find(undefined, 'user')!),
    roles: scope.string().arrayed(),
    nickname: scope.string().optional(),
  })
  .named('user_request');

console.log(await new TypeGenerator().generate(container));
```

---

### ZodGenerator

Emits an equivalent Zod validator per named schema. The first line of the output is always `import * as z from 'zod';`.

```typescript fragment
class ZodGenerator {
  constructor(options?: ZodGeneratorOptions);
  generate(container: SchemaContainer): Promise<string>;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(options?: ZodGeneratorOptions)` | `ZodGenerator` | `zodVariablePostfix` defaults to `'schema'`. |
| `generate` | `generate(container: SchemaContainer): Promise<string>` | `Promise<string>` | Emits one exported `const` per named root, formatted by Prettier. |

```typescript fragment
interface ZodGeneratorOptions {
  zodVariablePostfix?: string;
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `zodVariablePostfix` | `string` | `'schema'` | Suffix appended to the PascalCase name. `project_name` becomes `ProjectNameSchema`. |

Modifier order: string constraints first (`.regex`, `.min`, `.max`), then `.partial()`, then `.optional()`, then `.nullable()`. `StringSchema.pattern` is re-validated here and throws `Invalid pattern for schema <Name>: <pattern>` when a forced pattern is malformed.

Protected extension points: `getZodVariableName`, `renderReferenceSchema`, `renderObjectSchema`, `renderPrimitiveTypeSchema`, `renderStringConstraints`, `modifiers`.

**Example**

```typescript
import { SchemaContainer, ZodGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
container
  .scope()
  .string()
  .pattern('^[a-z0-9-]+$')
  .minLength(3)
  .maxLength(40)
  .optional()
  .named('project_name');

const source = await new ZodGenerator().generate(container);
// import * as z from 'zod';
// export const ProjectNameSchema = z.string().regex(new RegExp("^[a-z0-9-]+$")).min(3).max(40).optional();
console.log(source);
```

---

## SQL and Constant Generators

### PostgreSQLSchemaGenerator

Renders complete, idempotent PostgreSQL DDL from a `DatabaseSchema`. This is bootstrapping output for tests, local environments, and first deployments — not a migration mechanism.

```typescript fragment
class PostgreSQLSchemaGenerator {
  constructor(db: DatabaseSchema);
  generateGrouped(params?: GenerateOptions): GeneratedDDL;
  generate(params?: GenerateOptions): string;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(db: DatabaseSchema)` | `PostgreSQLSchemaGenerator` | The schema is read, never mutated. |
| `generateGrouped` | `generateGrouped(params?: GenerateOptions): GeneratedDDL` | `GeneratedDDL` | Returns four independent SQL groups. |
| `generate` | `generate(params?: GenerateOptions): string` | `string` | `generateGrouped(params).all`. |

```typescript fragment
interface GenerateOptions {
  dropBeforeCreate?: boolean;
}

interface GeneratedDDL {
  schema: string;
  indexes: string;
  views: string;
  all: string;
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dropBeforeCreate` | `boolean` | `true` | Emits `DROP SCHEMA` / `DROP TABLE … CASCADE` before creation. Set `false` for additive-only output. |

| Group | Contents |
|-------|----------|
| `schema` | Extensions, optional drops, `CREATE SCHEMA`, `CREATE TABLE`, `ALTER TABLE … ADD CONSTRAINT`, `COMMENT ON TABLE/COLUMN`. |
| `indexes` | `CREATE [UNIQUE] [CONCURRENTLY] INDEX … USING … INCLUDE … WITH … TABLESPACE … WHERE …`. |
| `views` | `DROP`/`CREATE [MATERIALIZED] VIEW`, then `COMMENT ON [MATERIALIZED] VIEW`. |
| `all` | `schema`, `indexes`, and `views` concatenated with blank-line separators. Empty groups are omitted. |

Emitted identifiers are quoted; constraint names derive from `table_columns_postfix` (lowercased); comments double single quotes; identity columns emit their sequence options; deferrable foreign keys emit `DEFERRABLE INITIALLY DEFERRED|IMMEDIATE`.

Protected extension points: `renderExtensions`, `dropTablesSQL`, `renderColumns`, `renderIdentityClause`, `renderTablesSQL`, `renderPrimaryKey`, `renderForeignKeyConstraints`, `renderUniqueConstraints`, `renderCheckConstraints`, `renderConstraintsSQL`, `constraintName`, `dropSchemasSQL`, `createSchemasSQL`, `escapeComment`, `renderCommentsSQL`, `renderViewCommentsSQL`, `renderIndexesSQL`, `generateIndexName`, `renderViewsSQL`.

**Example**

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const database = new DatabaseSchema('shop');
const products = database.table('products');
products.bigserial('id').primaryKey();
products.text('sku').unique();
products.numeric('price', 12, 2);

database.view('product_list').as('SELECT id, sku FROM public.products');

const ddl = new PostgreSQLSchemaGenerator(database).generate({ dropBeforeCreate: false });
console.log(ddl);
```

---

### CTypeGenerator

Emits a constant object per relation: a `$TABLE` prefix plus each column name in upper case. Used to avoid string literals in queries.

```typescript fragment
class CTypeGenerator {
  generate(ctypes: ConstantType): Promise<string>;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `generate` | `generate(ctypes: ConstantType): Promise<string>` | `Promise<string>` | One `export const e<Name>` per relation, JSDoc-commented, formatted by Prettier. Dots in the relation name become underscores before PascalCasing. |

`PostgreSQLIntrospector.introspectConstantTypes()` produces the input.

**Example**

```typescript
import { CTypeGenerator } from 'blendsdk/codegen';
import type { ConstantType } from 'blendsdk/codegen';

const ctypes: ConstantType = {
  'public.customers': ['id', 'email'],
  'public.orders': ['id', 'customer_id'],
};

const source = await new CTypeGenerator().generate(ctypes);
// export const ePublicCustomers = { $TABLE:'public.customers', ID:'id', EMAIL:'email' }
console.log(source);
```

---

## OpenAPI Generation

### OpenAPIGenerator

Collects webafx route definitions carrying `.openapi()` metadata and assembles one OpenAPI 3.1.0 document. Routes without metadata are excluded — annotation is the opt-in mechanism.

```typescript fragment
class OpenAPIGenerator {
  constructor(config: OpenAPIGeneratorConfig);
  addController(basePath: string, ControllerClass: ControllerConstructor): this;
  addRoutes(basePath: string, routeDefinitions: RouteDefinition[]): this;
  generate(): OpenAPIDocument;
  toJSON(indent?: number): string;
  toFile(filePath: string): void;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(config: OpenAPIGeneratorConfig)` | `OpenAPIGenerator` | Stores API metadata, servers, and security configuration. |
| `addController` | `addController(basePath: string, ControllerClass: ControllerConstructor): this` | `this` | Instantiates the controller with `({}, {})` and collects its routes. `routes()` must be side-effect free. |
| `addRoutes` | `addRoutes(basePath: string, routeDefinitions: RouteDefinition[]): this` | `this` | Adds route definitions directly, keeping only those with `openapi` metadata. |
| `generate` | `generate(): OpenAPIDocument` | `OpenAPIDocument` | Builds the document. Path keys and each path item's method keys are sorted; `$defs` are hoisted into `components.schemas`. |
| `toJSON` | `toJSON(indent?: number): string` | `string` | `JSON.stringify` of `generate()`. | 
| `toFile` | `toFile(filePath: string): void` | `void` | Writes indented JSON, creating parent directories when needed. |

| `toJSON` parameter | Type | Default | Description |
|--------------------|------|---------|-------------|
| `indent` | `number` | `2` | JSON indentation width. |

`generate()` always sets `x-blend-envelope` on every operation. `metadata.envelope` selects `'body'`; anything else yields `'data'`.

Operation assembly:

| Source | Emitted |
|--------|---------|
| `openapi.summary` / `.description` / `.tags` (non-empty) / `.operationId` / `.deprecated` | Copied when truthy. |
| Express `:param` segments in the combined path | `{param}` path parameters, always `required: true`; `openapi.pathParams[name].schema` supplies the schema, defaulting to `{ type: 'string' }`. |
| GET/DELETE `validation` | Query parameters via `convertZodToQueryParameters`. |
| POST/PUT/PATCH `validation` | `requestBody` with `required: true` and `application/json`. |
| `openapi.responses[]` | Status-code keyed responses with `description`, plus `content['application/json'].schema` in the `output` direction when a schema is given. |
| `secure` (truthy) | `config.defaultSecurity` when configured; otherwise an empty array (security required, no scheme named). |

Protected extension points: `buildPaths`, `buildFullPath`, `convertExpressPathToOpenAPI`, `extractPathParamNames`, `buildOperation`, `buildParameters`, `buildRequestBody`, `buildResponses`, `buildSecurity`, `isQueryParamMethod`, `convertZodToSchema`, `convertZodToQueryParameters`.

```typescript fragment
type ControllerConstructor = new (
  settings: any,
  services: any
) => {
  routes(): RouteDefinition[];
};
```

**Example**

```typescript
import { OpenAPIGenerator } from 'blendsdk/codegen';
import type { RouteDefinition } from 'blendsdk/webafx';

class ProductsController {
  public routes(): RouteDefinition[] {
    return [
      {
        method: 'get',
        path: '/',
        handler: () => undefined,
        openapi: {
          operationId: 'listProducts',
          tags: ['products'],
          responses: [{ statusCode: 200, description: 'The product list' }],
        },
      },
    ];
  }
}

const generator = new OpenAPIGenerator({
  title: 'Shop API',
  version: '1.0.0',
  servers: [{ url: 'https://api.example.com', description: 'Production' }],
  securitySchemes: {
    bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  },
  defaultSecurity: [{ bearerAuth: [] }],
});

generator.addController('/api/products', ProductsController);

const document = generator.generate();
console.log(Object.keys(document.paths)); // ['/api/products']
generator.toFile('./api.json');
```

---

### OpenAPI document types

All of the following are exported interfaces or type aliases.

#### OpenAPIInfo

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `title` | `string` | yes | API title. |
| `version` | `string` | yes | API version (not the OpenAPI specification version). |
| `description` | `string` | no | Markdown description. |

#### OpenAPIServer

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `url` | `string` | yes | Target host URL. |
| `description` | `string` | no | Server description. |

#### OpenAPISchema

| Property | Type | Description |
|----------|------|-------------|
| `type` | `string \| string[]` | A single type or a type array. OpenAPI 3.1 expresses nullability as `['string', 'null']`. |
| `description` | `string` | Schema description. |
| `format` | `string` | Format hint (`int32`, `date-time`, `email`, `uuid`, …). |
| `enum` | `unknown[]` | Allowed literal values. |
| `default` | `unknown` | Default value. |
| `properties` | `Record<string, OpenAPISchema>` | Object properties. |
| `required` | `string[]` | Required property names. |
| `additionalProperties` | `boolean \| OpenAPISchema` | Extra-property policy; an object becomes a `Record<string, T>` index signature. |
| `items` | `OpenAPISchema` | Array item schema. |
| `minimum` / `maximum` | `number` | Numeric bounds. |
| `minLength` / `maxLength` | `number` | String length bounds. |
| `minItems` / `maxItems` | `number` | Array length bounds. |
| `pattern` | `string` | Regular-expression constraint. |
| `allOf` / `anyOf` / `oneOf` | `OpenAPISchema[]` | Composition; renders as intersection / union. |
| `const` | `unknown` | Single allowed literal value. |
| `propertyNames` | `OpenAPISchema` | Property-name schema. |
| `prefixItems` | `OpenAPISchema[]` | Tuple item schemas. |
| `examples` / `example` | `unknown[]` / `unknown` | Example values. |
| `$defs` | `Record<string, OpenAPISchema>` | Pre-hoisting reusable definitions. |
| `$ref` | `string` | Reference, e.g. `#/components/schemas/Product`. |

#### OpenAPIParameter

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | `string` | yes | Parameter name. |
| `in` | `'query' \| 'header' \| 'path' \| 'cookie'` | yes | Parameter location. |
| `required` | `boolean` | no | Always `true` for path parameters. |
| `description` | `string` | no | Parameter description. |
| `schema` | `OpenAPISchema` | no | Type and constraints. |
| `deprecated` | `boolean` | no | Deprecation flag. |

#### OpenAPIRequestBody

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `description` | `string` | no | Body description. |
| `required` | `boolean` | no | Whether the body is mandatory. |
| `content` | `Record<string, OpenAPIMediaType>` | yes | Content keyed by media type. |

#### OpenAPIMediaType

| Property | Type | Description |
|----------|------|-------------|
| `schema` | `OpenAPISchema` | Structure of the media type. |

#### OpenAPIResponse

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `description` | `string` | yes | Required by the specification. |
| `content` | `Record<string, OpenAPIMediaType>` | no | Response body, when one exists. |

#### OpenAPIOperation

| Property | Type | Description |
|----------|------|-------------|
| `summary` | `string` | Short summary. |
| `description` | `string` | Markdown description. |
| `operationId` | `string` | Unique operation identifier; the client generator's method name source. |
| `tags` | `string[]` | Documentation grouping; the client generator's group source. |
| `parameters` | `OpenAPIParameter[]` | Path and query parameters. |
| `requestBody` | `OpenAPIRequestBody` | Request body. |
| `responses` | `Record<string, OpenAPIResponse>` | Responses keyed by status code. |
| `security` | `SecurityRequirement[]` | Security requirements. |
| `deprecated` | `boolean` | Deprecation flag. |
| `'x-blend-envelope'` | `'data' \| 'body'` | How a generated client reads a success body: `data` unwraps the `data` property, `body` returns the whole body. |

#### OpenAPIPathItem

| Property | Type | Description |
|----------|------|-------------|
| `get` / `post` / `put` / `patch` / `delete` | `OpenAPIOperation` | One operation per HTTP method. |

#### OpenAPISecurityScheme

| Property | Type | Description |
|----------|------|-------------|
| `type` | `'apiKey' \| 'http' \| 'oauth2' \| 'openIdConnect'` | Scheme type. |
| `description` | `string` | Scheme description. |
| `name` | `string` | Header, query, or cookie parameter name for `apiKey`. |
| `in` | `'query' \| 'header' \| 'cookie'` | API-key location. |
| `scheme` | `string` | HTTP authorization scheme, e.g. `bearer`. |
| `bearerFormat` | `string` | Bearer token format, e.g. `JWT`. |

#### SecurityRequirement

```typescript fragment
type SecurityRequirement = Record<string, string[]>;
```

Each key is a security scheme name; the value is the required scope list.

#### OpenAPIComponents

| Property | Type | Description |
|----------|------|-------------|
| `schemas` | `Record<string, OpenAPISchema>` | Reusable schemas; suffix-sorted. |
| `securitySchemes` | `Record<string, OpenAPISecurityScheme>` | Named schemes. |

#### OpenAPIDocument

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `openapi` | `'3.1.0'` | yes | Specification version literal. |
| `info` | `OpenAPIInfo` | yes | API metadata. |
| `servers` | `OpenAPIServer[]` | no | Present only when configured and non-empty. |
| `paths` | `Record<string, OpenAPIPathItem>` | yes | Operations keyed by path. |
| `components` | `OpenAPIComponents` | no | Present when security schemes or hoisted schemas exist. |

#### OpenAPIGeneratorConfig

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `title` | `string` | yes | API title. |
| `version` | `string` | yes | API version. |
| `description` | `string` | no | Markdown description. |
| `servers` | `OpenAPIServer[]` | no | Server list. |
| `securitySchemes` | `Record<string, OpenAPISecurityScheme>` | no | Schemes placed in `components.securitySchemes`. |
| `defaultSecurity` | `SecurityRequirement[]` | no | Applied to every route with a truthy `secure` flag. |

---

## Zod to OpenAPI Conversion

These functions wrap Zod 4's native `z.toJSONSchema` and normalize the result for OpenAPI 3.1 consumers.

### convertZodToJsonSchema

```typescript fragment
function convertZodToJsonSchema(
  schema: ZodType,
  direction: 'input' | 'output'
): OpenAPISchema;
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `schema` | `ZodType` | yes | Schema to convert. A non-Zod value yields `{ type: 'object' }`. |
| `direction` | `'input' \| 'output'` | yes | `input` for request shapes, `output` for response shapes, so defaults and transforms resolve on the correct side of the wire. |

**Returns** — a draft-2020-12 JSON Schema object normalized for OpenAPI 3.1: the `$schema` marker is dropped, and a two-branch nullable union (`anyOf: [inner, { type: 'null' }]`) is folded into a type array. Unions whose inner branch carries `enum` or `const` are left as `anyOf` so nullability is not silently lost. Unrepresentable Zod types become `{}` rather than throwing.

### convertZodToQueryParameters

```typescript fragment
function convertZodToQueryParameters(schema: ZodType): OpenAPIParameter[];
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `schema` | `ZodType` | yes | A query object schema. |

**Returns** — one `in: 'query'` parameter per top-level property. Required properties get `required: true`; optional and defaulted properties do not. A non-object, an empty object, or a non-Zod value yields `[]`.

### hoistDefinitions

```typescript fragment
function hoistDefinitions(document: OpenAPIDocument): OpenAPIDocument;
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `document` | `OpenAPIDocument` | yes | Document containing `$defs` collected from Zod conversion. |

**Returns** — the same document with every `$defs` map removed, its entries merged into `components.schemas` (sorted by name), and every `#/$defs/…` reference rewritten to `#/components/schemas/…`. Existing `components` entries such as `securitySchemes` are preserved.

Name collisions are resolved deterministically: an equal, reference-free definition is deduplicated; otherwise the newcomer is renamed `Name_2`, `Name_3`, … and references inside that operation are rewritten. Definition comparison uses canonical key-sorted JSON.

**Throws** — `Error` when a `#/$defs/` reference survives hoisting (an unresolvable reference must not reach a generated client).

### isZodSchema

```typescript fragment
function isZodSchema(value: unknown): value is ZodType;
```

Narrows an unknown value to a Zod schema (`instanceof z.ZodType`). Used by `OpenAPIGenerator` before delegating.

### sortByName

```typescript fragment
function sortByName<T extends object>(record: T): T;
```

Returns a copy of `record` with keys in ascending order. Used to keep the emitted OpenAPI document byte-stable.

**Example**

```typescript
import { convertZodToJsonSchema, hoistDefinitions } from 'blendsdk/codegen';
import type { OpenAPIDocument } from 'blendsdk/codegen';
import { z } from 'zod';

const product = z.object({ id: z.number(), name: z.string() }).meta({ id: 'Product' });
const schema = convertZodToJsonSchema(z.object({ items: z.array(product) }), 'output');

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Shop API', version: '1.0.0' },
  paths: {
    '/api/products': {
      get: {
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema } } },
        },
      },
    },
  },
};

const hoisted = hoistDefinitions(document);
console.log(Object.keys(hoisted.components?.schemas ?? {})); // ['Product']
```

---

## API Client Generation

### generateClient

Reads an OpenAPI 3.1 document and writes a typed client. Output is deterministic and idempotent: components and operations are sorted, files are Prettier-normalized, and stale marker-bearing files are pruned. Hand-written files without the marker are never touched.

```typescript fragment
function generateClient(
  document: OpenAPIDocument,
  options: ClientGeneratorOptions
): Promise<GenerationResult>;
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `document` | `OpenAPIDocument` | yes | Source document. |
| `options` | `ClientGeneratorOptions` | yes | Output directory and generation flags. |

**Returns** — `Promise<GenerationResult>` with `files` (sorted names written) and `issues`.

**Writes** — `types.ts`, `client.ts`, `index.ts`; with `splitByGroup`, `types.ts`, one `client.<group>.ts` per group, a `client.ts` barrel, and `index.ts`. Every file starts with:

```text
// Generated by `blendsdk api generate` — do not edit by hand.
```

**Throws** — `ClientGenerationError` when two operations share an `operationId` or resolve to the same `group.methodName`, and when `strict: true` escalates a warning-level problem.

### checkClient

Regenerates in memory and compares against the committed files. This is the CI drift gate.

```typescript fragment
function checkClient(
  document: OpenAPIDocument,
  options: ClientGeneratorOptions
): Promise<GenerationResult>;
```

**Returns** — `Promise<GenerationResult>` where `drifted` is `true` when any expected file differs, any marker file is stale, or any issue reached `error` severity; `driftedFiles` lists the differing names, sorted.

**Behavior** — every issue is finalized at strictness: escalating problems (missing `operationId`, missing 2xx response schema) become `error`, the rest become `warning`. Unlike `generateClient`, `checkClient` never writes or deletes files. It does throw on duplicate `operationId` / method name, because that contract cannot be represented at all.

### formatOpenApiDocument

```typescript fragment
function formatOpenApiDocument(document: OpenAPIDocument): Promise<string>;
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `document` | `OpenAPIDocument` | yes | Document to serialize. |

**Returns** — Prettier-formatted JSON with a trailing newline. This is the exact byte form `blendsdk api generate` writes and `blendsdk api check` compares.

---

### ClientGeneratorOptions

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `outputDir` | `string` | yes | — | Output directory, resolved relative to the config file. |
| `splitByGroup` | `boolean` | no | `false` | Emit one `client.<group>.ts` per tag instead of one combined `client.ts`. |
| `strict` | `boolean` | no | `false` | Treat escalating contract problems as errors instead of warnings. |
| `clientName` | `string` | no | `'AppClient'` | Base name of the generated client type. `create<ClientName>` is the factory. |
| `runtimeImport` | `string` | no | `'blendsdk/api-client'` | Runtime import specifier used by the generated files. |

### GeneratedOperation

| Property | Type | Description |
|----------|------|-------------|
| `operationId` | `string` | The OpenAPI `operationId`, or the deterministic fallback when it was missing. |
| `methodName` | `string` | Sanitized method name; equals `operationId` unless a reserved word forced a rename. |
| `method` | `string` | Lowercase HTTP method. |
| `path` | `string` | OpenAPI path with `{param}` placeholders. |
| `group` | `string` | Group name from the first tag, else the first path segment after `/api`. |
| `envelope` | `'data' \| 'body'` | How the runtime reads a successful response body. |
| `untypedResponse` | `boolean` | True when no 2xx schema exists, making the return type `unknown`. |

### ContractIssueSeverity

```typescript fragment
type ContractIssueSeverity = 'warning' | 'error';
```

`warning` is reported by both commands and never fails them; `error` fails `check` and, under `strict`, `generate`.

### ContractIssue

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `severity` | `ContractIssueSeverity` | yes | Warning or error. |
| `message` | `string` | yes | Concise description naming the method and path. |
| `operationId` | `string` | no | Present when the operation declares one. |
| `method` | `string` | no | HTTP method of the affected operation. |
| `path` | `string` | no | Path of the affected operation. |

### GenerationResult

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `files` | `string[]` | yes | File names written (`generate`) or compared (`check`), sorted. |
| `issues` | `ContractIssue[]` | yes | Contract problems found while reading the document. |
| `drifted` | `boolean` | no | `check` only: true when output differs or an error-level issue exists. |
| `driftedFiles` | `string[]` | no | `check` only: differing file names, sorted and de-duplicated. |

### ClientGenerationError

```typescript fragment
class ClientGenerationError extends Error {
  constructor(message: string);
  name: 'ClientGenerationError';
}
```

Raised when the contract cannot be turned into a client at all. The message names both offending locations for duplicate `operationId`s and duplicate resolved method names.

**Example**

```typescript
import { checkClient, generateClient } from 'blendsdk/codegen';
import type { OpenAPIDocument } from 'blendsdk/codegen';

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Shop API', version: '1.0.0' },
  paths: {
    '/api/products': {
      get: {
        operationId: 'listProducts',
        tags: ['products'],
        responses: {
          '200': {
            description: 'The product list',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Product' } },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Product: {
        type: 'object',
        properties: { id: { type: 'number' }, name: { type: 'string' } },
        required: ['id', 'name'],
      },
    },
  },
};

const options = { outputDir: 'src/api-client', clientName: 'ShopClient' };

const generated = await generateClient(document, options);
console.log(generated.files); // ['client.ts', 'index.ts', 'types.ts']

const drift = await checkClient(document, options);
if (drift.drifted) {
  throw new Error(`Generated client drifted: ${drift.driftedFiles?.join(', ')}`);
}
```

---

## API Contract Configuration

A project authors one default-exported `blendsdk.api.ts` contract. The `blendsdk api generate` and `blendsdk api check` commands read it; only the type helper is a package export.

### defineApiContract

```typescript fragment
function defineApiContract(contract: ApiContract): ApiContract;
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `contract` | `ApiContract` | yes | The user-authored settings. |

**Returns** — the same object, unchanged at runtime. The function exists purely for contextual typing.

### ApiContract

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `outputDir` | `string` | yes | Output directory for the generated client, relative to the config file. |
| `contractFile` | `string` | no | Committed OpenAPI JSON path, relative to the config file. Defaults to `api.json`. |
| `controllers` | `ApiContractController[]` | yes | Controllers to collect, with the base path each is mounted at. |
| `openapi` | `OpenAPIGeneratorConfig` | yes | Document metadata and security schemes. |
| `generator` | `Omit<ClientGeneratorOptions, 'outputDir'>` | no | Generator flags; `outputDir` comes from the sibling field. |

### ApiContractController

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `basePath` | `string` | yes | Mount path, e.g. `/api/products`. |
| `controller` | `unknown` | yes | The controller constructor. The loader rejects a value that is not a class. |

### ResolvedApiContract

Produced by the internal loader; exported so tooling and tests can type the resolved value.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `configPath` | `string` | yes | Absolute path of the loaded config file. |
| `outputDir` | `string` | yes | Absolute output directory. |
| `contractFile` | `string` | yes | Absolute path of the committed OpenAPI JSON. |
| `controllers` | `ApiContractController[]` | yes | Validated registrations. |
| `openapi` | `OpenAPIGeneratorConfig` | yes | Validated metadata and schemes. |
| `generator` | `Omit<ClientGeneratorOptions, 'outputDir'>` | no | Validated generator flags. |

**Example**

```typescript
import { defineApiContract } from 'blendsdk/codegen';
import { ProductsController } from './controllers/products.controller.js';

export default defineApiContract({
  outputDir: 'src/api-client',
  contractFile: 'api.json',
  controllers: [{ basePath: '/api/products', controller: ProductsController }],
  openapi: {
    title: 'Shop API',
    version: '1.0.0',
    servers: [{ url: 'https://api.example.com', description: 'Production' }],
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    defaultSecurity: [{ bearerAuth: [] }],
  },
  generator: { splitByGroup: true, strict: true, clientName: 'ShopClient' },
});
```

---

## Migrations

The migration surface is offline-first: `generateMigration` and `generateBaseline` read a configured schema module and never open a database connection; only `runMigrations`, `getMigrationStatus`, `validateMigrations`, and `adoptBaseline` touch PostgreSQL, and they import `pg` lazily.

### defineMigrationConfig

```typescript fragment
function defineMigrationConfig<const Config extends MigrationConfig>(
  config: Config
): Config;
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `config` | `Config extends MigrationConfig` | yes | User-authored settings. |

**Returns** — the same immutable object. Type inference only.

### generateMigration

```typescript fragment
function generateMigration(
  options: GenerateMigrationOptions
): Promise<GenerateMigrationResult>;
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `options` | `GenerateMigrationOptions` | yes | Name, config location, rename hints, destructive approval, clock. |

**Returns** — `GENERATED` with the published descriptor and the reviewed change list, or `UP_TO_DATE` with no file touched. On any blocked change it throws and writes nothing.

**Throws** — `MigrationError` with `kind: 'CONFIGURATION'` (invalid slug, unknown config key), `'INVALID_HISTORY'` (history without snapshot, out-of-order identifier, ambiguous/destructive/unsupported change), or `'UNSUPPORTED'` (change kind that cannot be rendered).

#### GenerateMigrationOptions

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | `string` | yes | Lowercase slug, `^[a-z][a-z0-9-]{0,62}$`. |
| `configPath` | `string` | no | Explicit config file or discovery directory. |
| `renameHints` | `readonly RenameHint[]` | no | Explicit one-to-one table/column renames. |
| `allowDestructive` | `boolean` | no | Approves destructive statements that the diff already classified as targeted. |
| `now` | `Date` | no | Deterministic clock for the timestamp prefix. |

#### GenerateMigrationResult

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `status` | `'GENERATED' \| 'UP_TO_DATE'` | yes | Whether a pair was published. |
| `migration` | `MigrationDescriptor` | no | The published migration; present only when `status` is `GENERATED`. |
| `previousSnapshot` | `string` | yes | SHA-256 of the prior comparison state. |
| `desiredSnapshot` | `string` | yes | SHA-256 of the desired state. |
| `changes` | `readonly SchemaChange[]` | yes | Reviewed semantic change list. |

### generateBaseline

```typescript fragment
function generateBaseline(
  options: GenerateBaselineOptions
): Promise<GenerateBaselineResult>;
```

| Parameter | Type | Required | Description |
|----------|------|----------|-------------|
| `options` | `GenerateBaselineOptions` | yes | Name, config location, clock. |

**Returns** — `status: 'GENERATED'` with the one published initial migration, its target snapshot hash, and the complete desired-state additions.

**Throws** — `MigrationError` (`INVALID_HISTORY`) when a snapshot or any up migration already exists, or when the name is not a lowercase slug. No database connection is opened.

#### GenerateBaselineOptions

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | `string` | yes | Lowercase baseline slug. |
| `configPath` | `string` | no | Explicit config file or discovery directory. |
| `now` | `Date` | no | Deterministic clock used by tests and embedding callers. |

#### GenerateBaselineResult

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `status` | `'GENERATED'` | yes | Successful baseline generation state. |
| `migration` | `MigrationDescriptor` | yes | The one published initial migration. |
| `snapshotHash` | `string` | yes | SHA-256 of the published canonical snapshot bytes. |
| `changes` | `readonly SchemaChange[]` | yes | Desired-state additions rendered into the baseline. |

### adoptBaseline

Proves supported catalog equality against the desired snapshot and records the initial lineage row **without executing the baseline SQL**. The caller must separately quiesce application and administrative DDL, then supply the exact `<database>/<baseline-id>` confirmation token.

```typescript fragment
function adoptBaseline(
  options: AdoptBaselineOptions,
  dependencies?: AdoptBaselineDependencies
): Promise<AdoptBaselineResult>;
```

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `options` | `AdoptBaselineOptions` | yes | Config location and optional confirmation token. |
| `dependencies` | `AdoptBaselineDependencies` | no | Preview hook, used by the CLI to display and collect confirmation. |

**Returns** — `status: 'ADOPTED'` plus the authoritative comparison, only after the ledger row commits.

**Throws** — `MigrationError` with `kind: 'CONFIGURATION'` (wrong or missing confirmation), `'INVALID_HISTORY'` (ledger present and non-empty, local baseline changed mid-flight, incompatible ledger shape), `'UNSUPPORTED'` (qualified structural mismatch or `UNSUPPORTED_FOR_ADOPTION` object), or `'DATABASE'` (connection or catalog-read failure). Nothing is written unless every check passes inside the repeatable-read transaction.

#### AdoptBaselineOptions

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `configPath` | `string` | no | Explicit config file or discovery directory. |
| `confirmation` | `string` | no | Exact `<database>/<baseline-id>` attestation. May be supplied by `afterPreview` instead. |

#### AdoptBaselineDependencies

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `afterPreview` | `(preview: AdoptionPreview) => string \| void \| Promise<string \| void>` | no | Receives the sanitized preview and may return the confirmation token. |

#### AdoptionPreview

| Property | Type | Description |
|----------|------|-------------|
| `host` | `string` | Target host, without password or query values. |
| `port` | `string` | Target PostgreSQL port (`'5432'` when unspecified). |
| `user` | `string` | Target role, decoded and without its password. |
| `database` | `string` | Target database name from `current_database()`. |
| `baselineId` | `string` | Initial migration identifier that will be recorded. |
| `comparison` | `readonly CatalogComparisonItem[]` | Stable comparison entries. Each has `classification` and `identity`. |

Comparison `classification` values: `'MATCH'`, `'MISSING'`, `'DIFFERENT'`, `'EXTRA_MODELED'`, `'UNMANAGED'`, `'UNSUPPORTED_FOR_ADOPTION'`. Only `MATCH` and `UNMANAGED` are compatible.

#### AdoptBaselineResult

| Property | Type | Description |
|----------|------|-------------|
| `status` | `'ADOPTED'` | Successful existing-database adoption. |
| `comparison` | `readonly CatalogComparisonItem[]` | Authoritative comparison including informational unmanaged objects. |

### runMigrations

```typescript fragment
function runMigrations(
  options: RunMigrationsOptions
): Promise<MigrationCommandResult>;
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `options` | `RunMigrationsOptions` | yes | Command, config location, safety flags, cancellation signal. |

**Returns** — a structured terminal state. Applying pending migrations ends at `UP_TO_DATE`; a dry run or a `down` reports `PENDING`; observational commands can also return `INVALID_HISTORY`, `LOCKED`, or `UNKNOWN_OUTCOME`.

**Throws** — `MigrationError` for any mutating failure: `'CONFIGURATION'` (exit 2, missing URL or bad config), `'LOCKED'`, `'INVALID_HISTORY'`, `'DATABASE'`, `'UNKNOWN_OUTCOME'`, `'UNSUPPORTED'` (down without confirmation), `'ABORTED'` (all exit 1 except configuration).

#### RunMigrationsOptions

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `command` | `Extract<MigrationCommand, 'up' \| 'down' \| 'status' \| 'validate'>` | yes | Execution or observation command. |
| `configPath` | `string` | no | Explicit config file or discovery directory. |
| `dryRun` | `boolean` | no | `up` only: report pending order and prove lock availability without mutation. |
| `allowDown` | `boolean` | no | `down` only: required guard for the single latest reversion. |
| `offline` | `boolean` | no | `validate` only: validate local files even when a database URL is configured. |
| `signal` | `AbortSignal` | no | Caller-owned cancellation. The library installs no global handlers. |

### getMigrationStatus

```typescript fragment
function getMigrationStatus(
  options?: GetMigrationStatusOptions
): Promise<MigrationCommandResult>;
```

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `configPath` | `string` | no | Explicit config file or discovery directory. |

Delegates to `runMigrations({ command: 'status' })`. It never creates the ledger and never retains the advisory lock; an empty history returns `UP_TO_DATE`. An absent ledger is treated as empty.

### validateMigrations

```typescript fragment
function validateMigrations(
  options?: ValidateMigrationsOptions
): Promise<MigrationCommandResult>;
```

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `configPath` | `string` | no | Explicit config file or discovery directory. |
| `offline` | `boolean` | no | Validate only local files and lineage without loading the `pg` driver. |

Delegates to `runMigrations({ command: 'validate' })`. Returns `UP_TO_DATE` when there is no database URL and no `offline` flag requested either — local validation still runs first, so an invalid local history returns `INVALID_HISTORY`.

### MigrationError

```typescript fragment
class MigrationError extends Error {
  constructor(options: MigrationErrorOptions);
  readonly kind: MigrationErrorKind;
  readonly exitCode: MigrationExitCode;
  name: 'MigrationError';
}
```

The message is sanitized at construction time. Complete PostgreSQL URLs become `[REDACTED_DATABASE_URL]` and `password=`/`pass=`/`secret=`/`token=` assignments become `[REDACTED]`. `sensitiveDetail` is accepted and deliberately not retained.

#### MigrationErrorOptions

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `kind` | `MigrationErrorKind` | yes | Stable machine-readable category. |
| `exitCode` | `MigrationExitCode` | yes | Process exit class for the CLI adapter. |
| `message` | `string` | yes | Concise message; redacted automatically. |
| `sensitiveDetail` | `string` | no | Must never appear in output; it is dropped. |

### formatMigrationError

```typescript fragment
function formatMigrationError(error: MigrationError): string;
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `error` | `MigrationError` | yes | Typed migration error to render. |

**Returns** — `"<KIND>: <sanitized message>"`, e.g. `CONFIGURATION: Missing config`. The message is redacted a second time.

---

### Migration configuration types

#### MigrationConfig

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `schema` | `string` | no | Module whose default export is the desired `DatabaseSchema`. Required by `generate`, `baseline`, and `adopt-baseline`. |
| `migrationsDir` | `string` | no | Directory of immutable SQL files. Defaults to `migrations` next to the config file. |
| `snapshotFile` | `string` | no | Canonical snapshot path. Defaults to `<migrationsDir>/schema.snapshot.json`. Must not use a `.up.sql` / `.down.sql` filename. |
| `databaseUrlEnv` | `string` | no | Environment variable holding the connection URL. Defaults to `DATABASE_URL`; must match `^[A-Z_][A-Z0-9_]*$`. |
| `lockTimeoutMs` | `number` | no | Advisory-lock wait. Defaults to `5000`; range 1–300000. |
| `statementTimeoutMs` | `number` | no | Per-migration statement timeout. Defaults to `900000`; range 1–86400000. |

Relative paths are resolved against the config directory and must not escape it; symlink segments are rejected.

#### ResolvedMigrationConfig

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `configPath` | `string` | yes | Absolute config file path. |
| `configDirectory` | `string` | yes | Absolute config directory. |
| `schema` | `string` | no | Absolute schema-module path, when needed by the command. |
| `migrationsDir` | `string` | yes | Absolute migrations directory. |
| `snapshotFile` | `string` | yes | Absolute snapshot path. |
| `databaseUrlEnv` | `string` | yes | Environment-variable name; never the URL itself. |
| `lockTimeoutMs` | `number` | yes | Resolved advisory-lock wait. |
| `statementTimeoutMs` | `number` | yes | Resolved statement timeout. |

#### MigrationCommand

```typescript fragment
type MigrationCommand =
  | 'generate' | 'create' | 'up' | 'down'
  | 'status' | 'validate' | 'baseline' | 'adopt-baseline';
```

#### MigrationStatus

```typescript fragment
type MigrationStatus =
  'UP_TO_DATE' | 'PENDING' | 'INVALID_HISTORY' | 'LOCKED' | 'UNKNOWN_OUTCOME';
```

`UNKNOWN_OUTCOME` requires operator investigation before another mutation is attempted.

#### MigrationSafety

```typescript fragment
type MigrationSafety =
  'safe' | 'caution' | 'destructive' | 'ambiguous' | 'unsupported';
```

| Value | Meaning |
|-------|---------|
| `safe` | Rendered automatically. |
| `caution` | Rendered only when it needs no staged population (e.g. nullable relaxation). Required addition or `SET NOT NULL` is blocked with guidance. |
| `destructive` | Blocked unless `allowDestructive` is set; rendered statements carry `-- destructive: reviewed and explicitly allowed`. |
| `ambiguous` | Apparent rename; requires an explicit `RenameHint`. |
| `unsupported` | Cannot be proven safe automatically; requires reviewed manual SQL. |

#### MigrationDescriptor

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `id` | `string` | yes | Sortable `YYYYMMDDHHMMSS_slug` identifier. |
| `upPath` | `string` | yes | Absolute path to the required up file. |
| `downPath` | `string` | no | Absolute path to the optional down file. |
| `checksum` | `string` | yes | Lowercase SHA-256 of the exact up-file bytes. |
| `downChecksum` | `string` | no | Lowercase SHA-256 of the exact down-file bytes. |
| `transactional` | `boolean` | yes | Whether the runner owns a transaction around the up file. |
| `downTransactional` | `boolean` | no | Same, for the down file. |
| `fromSnapshot` | `string` | no | Prior canonical snapshot hash; absent for manual/initial history. |
| `toSnapshot` | `string` | no | Resulting canonical snapshot hash; absent for manual history. |

#### MigrationCommandResult

| Property | Type | Description |
|----------|------|-------------|
| `status` | `MigrationStatus` | Terminal state observed by the command. |
| `migrations` | `readonly MigrationDescriptor[]` | Validated migrations relevant to the result, in application order. |

#### MigrationErrorKind

```typescript fragment
type MigrationErrorKind =
  | 'CONFIGURATION' | 'INVALID_HISTORY' | 'FILESYSTEM' | 'DATABASE'
  | 'LOCKED' | 'UNKNOWN_OUTCOME' | 'UNSUPPORTED' | 'ABORTED' | 'INTERNAL';
```

#### MigrationExitCode

```typescript fragment
type MigrationExitCode = 1 | 2;
```

`2` is a usage or configuration failure; `1` is an operational failure. Success is process exit code `0`.

#### RenameHint

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `kind` | `'table' \| 'column'` | yes | Modeled object kind being renamed. |
| `from` | `string` | yes | Fully qualified prior identity (`schema.table` or `schema.table.column`). |
| `to` | `string` | yes | Fully qualified desired identity. |

Hints must be one-to-one and acyclic, must stay inside one schema, and must map a removed identity to an added one. A cross-table column rename is accepted only when the same hint set also renames the source table to the target table.

#### SchemaChange

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `kind` | `SchemaChangeKind` (see below) | yes | Stable change discriminator. |
| `safety` | `MigrationSafety` | yes | Reviewer-facing classification. |
| `schema` | `string` | no | Schema identity. |
| `table` | `string` | no | Table identity. |
| `name` | `string` | no | Prior or added object name. |
| `newName` | `string` | no | Approved rename target. |
| `tableState` | `TableState` | no | Complete table definition for `table.add`. |
| `columnState` | `ColumnState` | no | Complete column definition for column operations. |
| `previousColumnState` | `ColumnState` | no | Prior column definition for transitions. |
| `viewState` | `ViewState` | no | Complete view definition for view operations. |
| `definition` | `Readonly<Record<string, unknown>>` | no | Constraint, index, or comment payload copied from the canonical snapshot. |
| `guidance` | `string` | no | Human-readable reason when automatic SQL is blocked. |

`TableState`, `ColumnState`, and `ViewState` are derived from `SchemaSnapshotV1` and are not separately exported.

```typescript fragment
type SchemaChangeKind =
  | 'extension.add' | 'extension.drop'
  | 'schema.add' | 'schema.drop'
  | 'table.add' | 'table.drop' | 'table.rename'
  | 'column.add' | 'column.drop' | 'column.rename'
  | 'column.type' | 'column.generated' | 'column.identity'
  | 'column.default' | 'column.nullability'
  | 'constraint.add' | 'constraint.drop'
  | 'index.add' | 'index.drop'
  | 'comment.set'
  | 'view.add' | 'view.drop' | 'view.replace';
```

#### SchemaDiffResult

| Property | Type | Description |
|----------|------|-------------|
| `changes` | `readonly SchemaChange[]` | Deterministically ordered modeled changes. |
| `summary` | `Readonly<Record<MigrationSafety, number>>` | Count per safety class, all five keys always present. |

**Example — configuration**

```typescript
import { defineMigrationConfig } from 'blendsdk/codegen';

export default defineMigrationConfig({
  schema: './src/database/schema.ts',
  migrationsDir: './migrations',
  snapshotFile: './migrations/schema.snapshot.json',
  databaseUrlEnv: 'DATABASE_URL',
  lockTimeoutMs: 5000,
  statementTimeoutMs: 900000,
});
```

**Example — generate, inspect, and apply**

```typescript
import { generateMigration, getMigrationStatus, runMigrations } from 'blendsdk/codegen';

const generated = await generateMigration({
  name: 'add-customer-status',
  renameHints: [
    { kind: 'column', from: 'public.customer.email', to: 'public.customer.email_address' },
  ],
});

if (generated.status === 'GENERATED' && generated.migration) {
  console.log(`Wrote ${generated.migration.upPath}`);
}
console.log(generated.changes.map(change => `${change.safety}:${change.kind}`));

const dryRun = await runMigrations({ command: 'up', dryRun: true });
console.log(dryRun.status, dryRun.migrations.map(migration => migration.id));

const status = await getMigrationStatus();
console.log(status.status);
```

**Example — guarded down with cancellation and error formatting**

```typescript
import { MigrationError, formatMigrationError, runMigrations } from 'blendsdk/codegen';

const controller = new AbortController();

try {
  const result = await runMigrations({
    command: 'down',
    allowDown: true,
    signal: controller.signal,
  });
  console.log(result.status);
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(formatMigrationError(error));
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}
```

**Example — adopt an existing database**

```typescript
import { adoptBaseline } from 'blendsdk/codegen';

const result = await adoptBaseline(
  {},
  {
    afterPreview: preview => {
      for (const item of preview.comparison) {
        console.log(`${item.classification} ${item.identity}`);
      }
      return `${preview.database}/${preview.baselineId}`;
    },
  }
);

console.log(result.status); // ADOPTED
```

---

## Command-line Surfaces

Both CLIs live behind the `blendsdk` executable shipped by the umbrella package; their entry points are not part of this package's export map.

| Command | Purpose |
|---------|---------|
| `blendsdk api generate` | Rebuild the OpenAPI document from configured controllers, write `api.json`, then write the typed client. |
| `blendsdk api check` | Rebuild in memory and fail on any drift from the committed `api.json` or client. |
| `blendsdk migrate generate <name>` | Generate reviewed SQL and the canonical snapshot from the configured schema. |
| `blendsdk migrate create <name>` | Create a manual no-op migration template (optionally with a down file). |
| `blendsdk migrate baseline <name>` | Create the initial offline migration lineage. |
| `blendsdk migrate adopt-baseline` | Prove catalog equality and record an existing database's baseline. |
| `blendsdk migrate up` | Apply pending migrations (supports `--dry-run`). |
| `blendsdk migrate down` | Revert exactly the latest migration (requires `--allow-down`). |
| `blendsdk migrate status` | Report `UP_TO_DATE`, `PENDING`, `LOCKED`, `INVALID_HISTORY`, or `UNKNOWN_OUTCOME`. |
| `blendsdk migrate validate` | Validate local (and, unless `--offline`, live) history. |

Exit codes: `0` success, `1` operational failure or drift, `2` usage or configuration failure.

---

## Complete Export Index

| Export | Kind | Section |
|--------|------|---------|
| `AnySchema` | class | [Schema authoring](#anySchema) |
| `BooleanSchema` | class | [Schema authoring](#booleanschema) |
| `DateSchema` | class | [Schema authoring](#dateschema) |
| `ObjectSchema` | class | [Schema authoring](#objectschema) |
| `ObjectProps` | type | [Schema authoring](#objectprops) |
| `PrimitiveSchema` | abstract class | [Schema authoring](#primitiveschema) |
| `StringSchema` | class | [Schema authoring](#stringschema) |
| `NumberSchema` | class | [Schema authoring](#numberschema) |
| `BinarySchema` | class | [Schema authoring](#binaryschema) |
| `BigIntSchema` | class | [Schema authoring](#bigintschema) |
| `ReferenceSchema` | class | [Schema authoring](#referenceschema) |
| `SchemaContainer` | class | [Schema authoring](#schemacontainer) |
| `SchemaScope` | class | [Schema authoring](#schemascope) |
| `SchemaUtils` | class | [SchemaUtils](#schemautils) |
| `DatabaseSchema` | class | [Database model](#databaseschema) |
| `TableSchema` | class | [Database model](#tableschema) |
| `TableColumnSchema` | class | [Database model](#tablecolumnschema) |
| `ForeignKeyConstraint` | class | [Database model](#foreignkeyconstraint) |
| `IndexConstraint` | class | [Database model](#indexconstraint) |
| `MakeTable` | type | [Database model](#maketable) |
| `ColumnType` | type | [Database model](#tableschema) |
| `ReferentialAction` | type | [Database model](#tablecolumnschema) |
| `ForeignKeyDeferrability` | type | [Database model](#foreignkeyconstraint) |
| `IndexMethod` | type | [Database model](#indexconstraint) |
| `BeforeGenerateHook` | type | [Database model types](#database-model-types) |
| `DatabaseSchemaOptions` | interface | [Database model types](#database-model-types) |
| `PostgreSQLIntrospector` | class | [Introspection](#postgresqlintrospector) |
| `ColumnMapper` | type | [Introspection](#postgresqlintrospector) |
| `ConstantType` | interface | [Introspection types](#constanttype) |
| `ColumnIntrospection` | interface | [Introspection types](#columnintrospection) |
| `ForeignKeyInfo` | interface | [Introspection types](#foreignkeyinfo) |
| `CheckConstraintInfo` | interface | [Introspection types](#checkconstraintinfo) |
| `TypeGenerator` | class | [Generators](#typegenerator) |
| `TypeGeneratorOptions` | interface | [Generators](#typegenerator) |
| `ZodGenerator` | class | [Generators](#zodgenerator) |
| `ZodGeneratorOptions` | interface | [Generators](#zodgenerator) |
| `PostgreSQLSchemaGenerator` | class | [SQL generators](#postgresqlschemagenerator) |
| `GenerateOptions` | interface | [SQL generators](#postgresqlschemagenerator) |
| `GeneratedDDL` | interface | [SQL generators](#postgresqlschemagenerator) |
| `CTypeGenerator` | class | [SQL generators](#ctypegenerator) |
| `OpenAPIGenerator` | class | [OpenAPI generation](#openapigenerator) |
| `ControllerConstructor` | type | [OpenAPI generation](#openapigenerator) |
| `OpenAPIGeneratorConfig` | interface | [OpenAPI types](#openapigeneratorconfig) |
| `OpenAPIInfo` | interface | [OpenAPI types](#openapiinfo) |
| `OpenAPIServer` | interface | [OpenAPI types](#openapiserver) |
| `OpenAPISchema` | interface | [OpenAPI types](#openapischema) |
| `OpenAPIParameter` | interface | [OpenAPI types](#openapiparameter) |
| `OpenAPIRequestBody` | interface | [OpenAPI types](#openapirequestbody) |
| `OpenAPIMediaType` | interface | [OpenAPI types](#openapimediatype) |
| `OpenAPIResponse` | interface | [OpenAPI types](#openapiresponse) |
| `OpenAPIOperation` | interface | [OpenAPI types](#openapioperation) |
| `OpenAPIPathItem` | interface | [OpenAPI types](#openapipathitem) |
| `OpenAPISecurityScheme` | interface | [OpenAPI types](#openapisecurityscheme) |
| `OpenAPIComponents` | interface | [OpenAPI types](#openapicomponents) |
| `OpenAPIDocument` | interface | [OpenAPI types](#openapidocument) |
| `SecurityRequirement` | type | [OpenAPI types](#securityrequirement) |
| `convertZodToJsonSchema` | function | [Zod to OpenAPI](#convertzodtojsonschema) |
| `convertZodToQueryParameters` | function | [Zod to OpenAPI](#convertzodtoqueryparameters) |
| `hoistDefinitions` | function | [Zod to OpenAPI](#hoistdefinitions) |
| `isZodSchema` | function | [Zod to OpenAPI](#iszodschema) |
| `sortByName` | function | [Zod to OpenAPI](#sortbyname) |
| `generateClient` | function | [Client generation](#generateclient) |
| `checkClient` | function | [Client generation](#checkclient) |
| `formatOpenApiDocument` | function | [Client generation](#formatopenapidocument) |
| `ClientGeneratorOptions` | interface | [Client generation](#clientgeneratoroptions) |
| `GeneratedOperation` | interface | [Client generation](#generatedoperation) |
| `ContractIssue` | interface | [Client generation](#contractissue) |
| `ContractIssueSeverity` | type | [Client generation](#contractissueseverity) |
| `GenerationResult` | interface | [Client generation](#generationresult) |
| `ClientGenerationError` | class | [Client generation](#clientgenerationerror) |
| `defineApiContract` | function | [API contracts](#defineapicontract) |
| `ApiContract` | interface | [API contracts](#apicontract) |
| `ApiContractController` | interface | [API contracts](#apicontractcontroller) |
| `ResolvedApiContract` | interface | [API contracts](#resolvedapicontract) |
| `defineMigrationConfig` | function | [Migrations](#definemigrationconfig) |
| `generateMigration` | function | [Migrations](#generatemigration) |
| `GenerateMigrationOptions` | interface | [Migrations](#generatemigrationoptions) |
| `GenerateMigrationResult` | interface | [Migrations](#generatemigrationresult) |
| `generateBaseline` | function | [Migrations](#generatebaseline) |
| `GenerateBaselineOptions` | interface | [Migrations](#generatebaselineoptions) |
| `GenerateBaselineResult` | interface | [Migrations](#generatebaselineresult) |
| `adoptBaseline` | function | [Migrations](#adoptbaseline) |
| `AdoptBaselineOptions` | interface | [Migrations](#adoptbaselineoptions) |
| `AdoptBaselineDependencies` | interface | [Migrations](#adoptbaselinedependencies) |
| `AdoptBaselineResult` | interface | [Migrations](#adoptbaselineresult) |
| `AdoptionPreview` | interface | [Migrations](#adoptionpreview) |
| `runMigrations` | function | [Migrations](#runmigrations) |
| `RunMigrationsOptions` | interface | [Migrations](#runmigrationsoptions) |
| `getMigrationStatus` | function | [Migrations](#getmigrationstatus) |
| `GetMigrationStatusOptions` | interface | [Migrations](#getmigrationstatus) |
| `validateMigrations` | function | [Migrations](#validatemigrations) |
| `ValidateMigrationsOptions` | interface | [Migrations](#validatemigrations) |
| `MigrationError` | class | [Migrations](#migrationerror) |
| `MigrationErrorOptions` | interface | [Migrations](#migrationerroroptions) |
| `formatMigrationError` | function | [Migrations](#formatmigrationerror) |
| `MigrationConfig` | interface | [Migration types](#migrationconfig) |
| `ResolvedMigrationConfig` | interface | [Migration types](#resolvedmigrationconfig) |
| `MigrationCommand` | type | [Migration types](#migrationcommand) |
| `MigrationStatus` | type | [Migration types](#migrationstatus) |
| `MigrationSafety` | type | [Migration types](#migrationsafety) |
| `MigrationDescriptor` | interface | [Migration types](#migrationdescriptor) |
| `MigrationCommandResult` | interface | [Migration types](#migrationcommandresult) |
| `MigrationErrorKind` | type | [Migration types](#migrationerrorkind) |
| `MigrationExitCode` | type | [Migration types](#migrationexitcode) |
| `RenameHint` | interface | [Migration types](#renamehint) |
| `SchemaChange` | interface | [Migration types](#schemachange) |
| `SchemaDiffResult` | interface | [Migration types](#schemadiffresult) |

**Not public.** `SchemaObject`, `SchemaObjectData`, `DataObjectSchema`, `RelationSchema`, `ColumnSchema`, `ConstraintBase`, `CheckConstraint`, `UniqueConstraint`, `PrimaryKeyConstraint`, `ViewSchema`, `Generator`, `GeneratorOptions`, the introspection SQL constant, the API/migration config loaders, both CLI `main` functions, the migration ledger, the catalog projector/diff, the artifact writer, and `generateInitialMigration` are internal. They are reachable only through the documented functions above.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
