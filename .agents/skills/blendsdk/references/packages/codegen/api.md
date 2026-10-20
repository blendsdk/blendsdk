> **Package**: `blendsdk/codegen`

# codegen API Reference

`blendsdk/codegen` exposes five groups of symbols through its package root: data-shape schema authoring, the PostgreSQL schema model, PostgreSQL introspection, the code generators (TypeScript, Zod, constants, DDL, OpenAPI, typed client), and the PostgreSQL migration lifecycle. Everything below is importable from the package root; the assembled `blendsdk` package re-exports this module, so consumer projects can also import from `blendsdk/codegen`.

In the tables below, symbols typed as `SchemaObject`, `TableState`, or similar are the package's internal base/DTO types: they appear in signatures and can be used through inference, but they are not themselves re-exported from `src/index.ts`.

---

## Contents

| Section | Representative symbols |
|---------|------------------------|
| Data-shape schema | `SchemaContainer`, `SchemaScope`, `ObjectSchema`, `PrimitiveSchema`, `StringSchema`, `ReferenceSchema`, `SchemaUtils` |
| PostgreSQL schema model | `DatabaseSchema`, `TableSchema`, `TableColumnSchema`, `IndexConstraint`, `IndexMethod` |
| PostgreSQL introspection | `PostgreSQLIntrospector`, `ColumnMapper`, `ColumnIntrospection` |
| Generators | `TypeGenerator`, `ZodGenerator`, `CTypeGenerator`, `PostgreSQLSchemaGenerator` |
| OpenAPI generation | `OpenAPIGenerator`, `convertZodToJsonSchema`, `hoistDefinitions`, OpenAPI document types |
| Typed client generation | `generateClient`, `checkClient`, `ClientGeneratorOptions`, `GenerationResult` |
| API contract configuration | `defineApiContract`, `ApiContract`, `ResolvedApiContract` |
| PostgreSQL migrations | `defineMigrationConfig`, `generateMigration`, `runMigrations`, `adoptBaseline`, migration types |

---

## Data-Shape Schema APIs

A `SchemaContainer` holds every named schema node; a `SchemaScope` creates nodes pre-stamped with a scope. Nodes chain fluent modifiers (`nullable()`, `optional()`, `arrayed()`, `description()`, …) inherited from the internal schema base class, then `TypeGenerator` or `ZodGenerator` renders them.

### Shared schema methods

Every node returned by a scope exposes the following inherited fluent API. The base class itself (`SchemaObject`) is not re-exported; treat these members as the API available on every schema node.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `arrayed` | `arrayed(): this` | `this` | Marks the node as an array; generators wrap the rendered type in `[]`. |
| `description` | `description(text: string \| string[] \| undefined, prefix?: boolean): this` | `this` | Appends description lines; with `prefix: true` the lines are prepended. `undefined` is ignored. |
| `getData` | `getData(): SchemaObjectData` | `SchemaObjectData` | Returns the node's internal data record (type flags, modifiers, metadata, description). |
| `getName` | `getName(): string \| undefined` | `string \| undefined` | The node's registered name. |
| `getNamedScoped` | `getNamedScoped(): string` | `string` | Joins scope and name with `.`. |
| `getScope` | `getScope(): string \| undefined` | `string \| undefined` | The node's scope. |
| `hasParent` | `hasParent(): boolean` | `boolean` | Whether the node is used as an object property. |
| `isRendered` | `isRendered(): boolean` | `boolean` | Whether a generator has already rendered the node. |
| `metadata` | `metadata(data: Record<string, any>): void` | `void` | Merges a metadata record into the node (the introspector stores its source row under `introspect`). |
| `named` | `named(value: string): this` | `this` | Names the node and registers the identity; throws when the identity already exists. |
| `nullable` | `nullable(): this` | `this` | Marks the node nullable (`T \| null` / `.nullable()`). |
| `optional` | `optional(): this` | `this` | Marks the node optional (`prop?:` / `.optional()`). |
| `partial` | `partial(): this` | `this` | Wraps the node in `Partial<T>` / `.partial()`. |
| `recordSet` | `recordSet(): this` | `this` | Wraps the node in `Record<string, T>`. |
| `reset` | `reset(): void` | `void` | Clears the rendered flag; generators call this before rendering. |
| `scope` | `scope(value?: string): this` | `this` | Sets or clears the node's scope. |
| `setData` | `setData(data: SchemaObjectData): void` | `void` | Merges a data patch into the node. |

```typescript fragment
metadata(data: Record<string, any>): void
```

---

### `SchemaContainer`

Registry for named schema nodes. Every factory call on a scope registers its node; duplicate identities are rejected.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor()` | `SchemaContainer` | Creates an empty container and duplicate-identity index. |
| `getAll` | `getAll()` | `SchemaObject[]` | Returns every registered node, in registration order. |
| `clear` | `clear()` | `this` | Removes every node and resets the identity index. |
| `find` | `find(scope: string, name: string)` | `SchemaObject \| undefined` | Finds the node registered under this exact scope and name. |
| `add` | `add(obj: SchemaObject)` | `void` | Registers a node; throws when its identity already exists. |
| `assert` | `assert(name: string, scope: string \| undefined)` | `void` | Throws when the identity is already registered; unnamed nodes are skipped. |
| `scope` | `scope(name?: string)` | `SchemaScope` | Creates a node factory that stamps new nodes with `name`. |

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

scope
  .object({
    id: scope.number(),
    name: scope.string(),
  })
  .named('Product');

const source: string = await new TypeGenerator().generate(schema);

console.log(schema.getAll().length); // 3
console.log(source);
```

---

### `SchemaScope`

Creates and registers schema nodes. Instances are normally obtained from `SchemaContainer.scope()`.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(container: SchemaContainer, name?: string)` | `SchemaScope` | Prefer `new SchemaContainer().scope(name)`. |
| `bigint` | `bigint()` | `BigIntSchema` | Big-integer node (TypeScript `BigInt`). |
| `number` | `number()` | `NumberSchema` | Number node. |
| `string` | `string()` | `StringSchema` | String node. |
| `date` | `date()` | `DateSchema` | Date node. |
| `boolean` | `boolean()` | `BooleanSchema` | Boolean node. |
| `any` | `any()` | `AnySchema` | Node for an unknown shape; renders as the generators' permissive type. |
| `ref` | `ref(obj: SchemaObject)` | `ReferenceSchema` | Reference to another node; the target must be `named()` before generation. |
| `object` | `object(properties: ObjectProps)` | `ObjectSchema` | Object node whose property map is merged and parent-stamped immediately. |
| `find` | `find(name: string)` | `SchemaObject \| undefined` | Finds a node registered with this scope's name. |

```typescript
import { SchemaContainer } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const catalog = schema.scope('catalog');

const price = catalog.number().named('Price');

catalog
  .object({
    sku: catalog.string(),
    price: catalog.ref(price),
    keywords: catalog.string().arrayed().optional(),
  })
  .named('Item');
```

---

### `ObjectSchema` and `ObjectProps`

`ObjectProps` is the property-map type used by every object node.

```typescript fragment
type ObjectProps = Record<string, SchemaObject>;
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(container: SchemaContainer)` | `ObjectSchema` | Creates an object node; properties are usually supplied through `SchemaScope.object()`. |
| `properties` | `properties(props: ObjectProps)` | `void` | Merges `props` into the existing properties and stamps each property with this object as its parent. Returns `void`, so it cannot be chained. |
| `getProperties` | `getProperties(): ObjectProps` | `ObjectProps` | The merged property map. |

```typescript
import { ObjectSchema, SchemaContainer } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

const shape: ObjectSchema = scope.object({ id: scope.number() });
shape.properties({ name: scope.string() });

console.log(Object.keys(shape.getProperties())); // ['id', 'name']
```

---

### `PrimitiveSchema`

Abstract base for the primitive nodes that support enum values. Both `StringSchema` and `NumberSchema` (and `BigIntSchema`) extend it.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(container: SchemaContainer)` | `PrimitiveSchema` | Abstract; instantiate a concrete subclass. |
| `enum` | `enum(values: string[] \| number[]): this` | `this` | Replaces the rendered type with a union of quoted string literals or numeric literals. |
| `enumValue` | `protected abstract enumValue(value: any): string` | `string` | Subclass hook that renders one enum member. |

```typescript fragment
// PrimitiveSchema is abstract; use a concrete subclass.
const status = schema.scope().string().enum(['active', 'archived']);
const level = schema.scope().number().enum([1, 2, 3]);
```

---

### `StringSchema`

String primitive node (`tsType: 'string'`, `zodType: 'string'`). Enum members are emitted as quoted literals.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(container: SchemaContainer)` | `StringSchema` | Creates the node. |
| `enum` | `enum(values: string[] \| number[]): this` | `this` | Emits a union of quoted string literals, for example `'draft' \| 'published'`. |

```typescript
import { SchemaContainer, StringSchema, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

const status: StringSchema = scope.string().enum(['draft', 'published']).named('Status');

const source: string = await new TypeGenerator().generate(schema);
console.log(source);
```

---

### `NumberSchema`

Number primitive node (`tsType: 'number'`, `zodType: 'number'`). Enum members are emitted as numeric literals.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(container: SchemaContainer)` | `NumberSchema` | Creates the node. |
| `enum` | `enum(values: string[] \| number[]): this` | `this` | Emits a union of numeric literals, for example `1 \| 2 \| 3`. |

```typescript fragment
const quantity = schema.scope().number().enum([1, 2, 3]);
```

---

### `BigIntSchema`

Big-integer node (`tsType: 'BigInt'`, `zodType: 'number'`).

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(container: SchemaContainer)` | `BigIntSchema` | Creates the node. |
| `enum` | `enum(values: string[] \| number[]): this` | `this` | Emits a union of numeric literals. |

```typescript fragment
const identifier = schema.scope().bigint();
```

---

### `BooleanSchema`

Boolean node (`tsType: 'boolean'`, `zodType: 'boolean'`).

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(container: SchemaContainer)` | `BooleanSchema` | Creates the node. |

```typescript fragment
const active = schema.scope().boolean();
```

---

### `DateSchema`

Date node (`tsType: 'Date'`, `zodType: 'date'`). Timestamp columns introspected from PostgreSQL map to this node.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(container: SchemaContainer)` | `DateSchema` | Creates the node. |

```typescript fragment
const createdAt = schema.scope().date();
```

---

### `AnySchema`

Permissive node for shapes with no mapped type (`tsType: 'any'`, `zodType: 'any'`). The introspector falls back to this node when a PostgreSQL type has no built-in mapping.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(container: SchemaContainer)` | `AnySchema` | Creates the node. |

```typescript fragment
const payload = schema.scope().any();
```

---

### `ReferenceSchema`

Inline reference to another node. Generators render the referenced node's type name (TypeScript) or variable name (Zod); the target must be named before generation.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(container: SchemaContainer, refSchema: SchemaObject)` | `ReferenceSchema` | Prefer `SchemaScope.ref(obj)`. |

```typescript
import { ReferenceSchema, SchemaContainer } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

const id = scope.number().named('Id');
const reference: ReferenceSchema = scope.ref(id);

console.log(reference.getData().ref === id); // true
```

---

### `SchemaUtils`

Static helpers shared by the generators.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `getTypeScriptName` | `static getTypeScriptName(obj: SchemaObject): string` | `string` | PascalCase identifier for a node built from its scoped name. |
| `snakeToPascalCase` | `static snakeToPascalCase(str: string): string` | `string` | Converts `snake_case`, dotted, or plain names to PascalCase. A plain name gets only its first character capitalized. |
| `formatMultilineComment` | `static formatMultilineComment(lines: string[], style: 'jsdoc' \| 'block' \| 'line' = 'jsdoc'): string[]` | `string[]` | Formats text lines as comment lines in the requested style. |

```typescript
import { SchemaUtils } from 'blendsdk/codegen';

console.log(SchemaUtils.snakeToPascalCase('user_profile')); // 'UserProfile'
console.log(SchemaUtils.formatMultilineComment(['Line one']));
// ['/**', ' * Line one', ' */']
```

---

## PostgreSQL Schema Model

The fluent model for desired database state: schemas, tables, columns, constraints, indexes, extensions, and views. This model feeds both `PostgreSQLSchemaGenerator` (bootstrap DDL) and `generateMigration` (incremental migrations).

### `DatabaseSchema`

Root of the model. Every table and view created through it inherits the default schema (scope).

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(name: string, defaultScope?: string)` | `DatabaseSchema` | Creates the model. `defaultScope` defaults to `'public'`. |
| `extension` | `extension(...extension: string[]): this` | `this` | Registers one or more PostgreSQL extensions. |
| `table` | `table(name: string, builder?: MakeTable): TableSchema` | `TableSchema` | Creates a table, optionally runs `builder`, registers it, and returns it. |
| `view` | `view(name: string): ViewSchema` | `ViewSchema` | Creates and registers a view builder. The `ViewSchema` class is not re-exported; chain its methods (see below). |
| `getExtensions` | `getExtensions(): string[]` | `string[]` | Registered extension names (falsy entries filtered out). |
| `getTables` | `getTables(): TableSchema[]` | `TableSchema[]` | Registered tables in declaration order. |
| `getViews` | `getViews(): ViewSchema[]` | `ViewSchema[]` | Registered views in declaration order. |
| `getDefaultSchema` | `getDefaultSchema(): string` | `string` | The default scope for new objects. |
| `comment` | `comment(comment: string): this` | `this` | Sets the schema comment (inherited from the internal data-object base). |
| `getComment` | `getComment(): string \| undefined` | `string \| undefined` | The schema comment. |
| `getName` | `getName(): string` | `string` | The schema name. |

```typescript fragment
type MakeTable = (t: TableSchema) => void;
```

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const database = new DatabaseSchema('app');

database.extension('pgcrypto');

const customer = database.table('customer', table => {
  table.bigint('id').primaryKey();
  table.varchar('email', 255).unique();
  table.text('name').nullable().comment('Display name');
});

database.table('order', table => {
  table.bigint('id').primaryKey();
  table.bigint('customer_id').references(customer, 'id', undefined, 'CASCADE');
  table.timestamp('created_at', 6).default('now()');
});

database
  .view('customer_names')
  .as('SELECT id, name FROM public.customer')
  .materialized(true)
  .comment('Materialized name lookup');
```

**View builder (returned by `view()`)**

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `as` | `as(source: string): this` | `this` | Sets the view's SQL source. |
| `materialized` | `materialized(state: boolean): this` | `this` | Marks the view as materialized (`true` unless explicitly `false`). |
| `comment` | `comment(comment: string): this` | `this` | Sets the view comment. |
| `scope` | `scope(name: string): this` | `this` | Overrides the view's schema. |
| `getName` | `getName(scope?: boolean): string` | `string` | Scoped (`schema.name`) or bare name; scoped is the default. |
| `getScope` | `getScope(): string \| undefined` | `string \| undefined` | The view's schema. |
| `getSource` | `getSource(): string \| undefined` | `string \| undefined` | The view's SQL source. |
| `isMaterialized` | `isMaterialized(): boolean` | `boolean` | Whether the view is materialized. |
| `getComment` | `getComment(): string \| undefined` | `string \| undefined` | The view comment. |

---

### `TableSchema`

Table builder. Column helpers create and register `TableColumnSchema` instances; constraint helpers register primary key, unique, check, foreign key, and index definitions.

**Column helpers** — every helper takes a column name (`varchar`, `decimal`, `numeric`, `char`, `time`, `timestamp`, and `timestamptz` also take size/scale arguments) and returns the new column:

| Method | Signature | Returns | Column type |
|--------|-----------|---------|-------------|
| `integer` | `integer(name: string)` | `TableColumnSchema` | `integer` |
| `varchar` | `varchar(name: string, size?: number)` | `TableColumnSchema` | `varchar` |
| `serial` | `serial(name: string)` | `TableColumnSchema` | `serial` |
| `bigserial` | `bigserial(name: string)` | `TableColumnSchema` | `bigserial` |
| `smallint` | `smallint(name: string)` | `TableColumnSchema` | `smallint` |
| `bigint` | `bigint(name: string)` | `TableColumnSchema` | `bigint` |
| `decimal` | `decimal(name: string, size?: number, scale?: number)` | `TableColumnSchema` | `decimal` |
| `numeric` | `numeric(name: string, size?: number, scale?: number)` | `TableColumnSchema` | `numeric` |
| `real` | `real(name: string)` | `TableColumnSchema` | `real` |
| `doublePrecision` | `doublePrecision(name: string)` | `TableColumnSchema` | `double precision` |
| `char` | `char(name: string, size?: number)` | `TableColumnSchema` | `char` |
| `text` | `text(name: string)` | `TableColumnSchema` | `text` |
| `boolean` | `boolean(name: string)` | `TableColumnSchema` | `boolean` |
| `date` | `date(name: string)` | `TableColumnSchema` | `date` |
| `time` | `time(name: string, size?: number)` | `TableColumnSchema` | `time` |
| `timestamp` | `timestamp(name: string, size?: number)` | `TableColumnSchema` | `timestamp` |
| `timestamptz` | `timestamptz(name: string, size?: number)` | `TableColumnSchema` | `timestamptz` |
| `json` | `json(name: string)` | `TableColumnSchema` | `json` |
| `jsonb` | `jsonb(name: string)` | `TableColumnSchema` | `jsonb` |
| `uuid` | `uuid(name: string)` | `TableColumnSchema` | `uuid` |
| `vector` | `vector(name: string)` | `TableColumnSchema` | `vector` |
| `tsvector` | `tsvector(name: string)` | `TableColumnSchema` | `tsvector` |

**Constraint and index methods:**

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(name: string, database: DatabaseSchema)` | `TableSchema` | Prefer `DatabaseSchema.table()`. |
| `primaryKey` | `primaryKey(): PrimaryKeyConstraint` | `PrimaryKeyConstraint` | Returns the table's primary-key builder, creating it on first use. |
| `getPrimaryKey` | `getPrimaryKey(): PrimaryKeyConstraint \| undefined` | `PrimaryKeyConstraint \| undefined` | Returns the configured primary key without creating one as a read side effect. |
| `uniqueConstraint` | `uniqueConstraint(): UniqueConstraint` | `UniqueConstraint` | Creates and registers a unique constraint builder. |
| `checkConstraint` | `checkConstraint(rule: string): this` | `this` | Creates and registers a check constraint with the given SQL rule. |
| `foreignKeyConstraint` | `foreignKeyConstraint(toTable: TableSchema): ForeignKeyConstraint` | `ForeignKeyConstraint` | Creates and registers a foreign-key builder targeting `toTable`. |
| `index` | `index(): IndexConstraint` | `IndexConstraint` | Creates and registers an index builder. |
| `getForeignKeyConstrains` | `getForeignKeyConstrains(): ForeignKeyConstraint[]` | `ForeignKeyConstraint[]` | Registered foreign keys (note the source spelling). |
| `getCheckConstraints` | `getCheckConstraints(): CheckConstraint[]` | `CheckConstraint[]` | Registered check constraints. |
| `getUniqueConstraints` | `getUniqueConstraints(): UniqueConstraint[]` | `UniqueConstraint[]` | Registered unique constraints. |
| `getIndexes` | `getIndexes(): IndexConstraint[]` | `IndexConstraint[]` | Registered indexes. |
| `scope` | `scope(name: string): this` | `this` | Overrides the table's schema. |
| `getName` | `getName(scope?: boolean): string` | `string` | Scoped (`schema.name`) or bare name; scoped is the default. |
| `getScope` | `getScope(): string \| undefined` | `string \| undefined` | The table's schema. |
| `findColumn` | `findColumn(name: string)` | `TableColumnSchema \| undefined` | Finds a column by name. |
| `getColumns` | `getColumns(): TableColumnSchema[]` | `TableColumnSchema[]` | All columns in declaration order. |
| `getDatabase` | `getDatabase(): DatabaseSchema` | `DatabaseSchema` | The owning database model. |

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const database = new DatabaseSchema('app');
const customer = database.table('customer');

customer.bigint('id').primaryKey();
customer.varchar('email', 255).unique().comment('Sign-in address');
customer.timestamp('created_at', 6).default('now()');

customer.index().indexName('customer_email_idx').column('email');
```

**Constraint builders returned by this class**

These builder classes are not re-exported from the package root, but their methods are the API you call on the returned objects. All of them inherit `column(...column: string[]): this`, `hasColumns(): boolean`, `getTable(): TableSchema`, and `getColumns(): TableColumnSchema[]` from the internal constraint base.

| Builder | Extra methods | Description |
|---------|---------------|-------------|
| `PrimaryKeyConstraint` (from `primaryKey()`) | — | Column list via the inherited `column(...)`. |
| `UniqueConstraint` (from `uniqueConstraint()`) | — | Column list via the inherited `column(...)`. |
| `CheckConstraint` (from `checkConstraint()` — returned by the internal factory, the table returns `this`) | `getRule(): string` | The SQL rule supplied at creation. |
| `ForeignKeyConstraint` (from `foreignKeyConstraint()` / `TableColumnSchema.references()`) | `from(...column: string[]): this`, `to(...column: string[]): this`, `onUpdate(action?: ReferentialAction): this`, `onDelete(action?: ReferentialAction): this`, `column(...column: string[]): this` (throws — use `from`/`to`), `getRefTable(): TableSchema`, `getRefColumns(): TableColumnSchema[]`, `getOnDelete(): ReferentialAction`, `getOnUpdate(): ReferentialAction` | Defaults: `ON UPDATE CASCADE`, `ON DELETE RESTRICT`; passing `undefined` keeps the default. `to(...)` targets columns of the referenced table, `from(...)` the local columns. |

`ReferentialAction` values accepted by the foreign-key builders: `'CASCADE'`, `'RESTRICT'`, `'SET NULL'`, `'SET DEFAULT'`, `'NO ACTION'`.

---

### `TableColumnSchema`

Column builder returned by the `TableSchema` helpers. Instances are also constructible directly, but the helpers are the normal entry point.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(name: string, relation: TableSchema)` | `TableColumnSchema` | Prefer the `TableSchema` column helpers. |
| `references` | `references(toTable: TableSchema, column: string, onUpdate?: ReferentialAction, onDelete?: ReferentialAction): this` | `this` | Creates a foreign key from this column to `toTable.column` and returns this column. |
| `type` | `type(type: ColumnType): this` | `this` | Sets the column's modeled PostgreSQL type. |
| `size` | `size(value: number)` | `void` | Sets the length/precision modifier. |
| `scale` | `scale(value: number)` | `void` | Sets the numeric scale. |
| `default` | `default(value: string \| boolean \| number \| undefined, quote?: boolean): this` | `this` | Sets a default expression; with `quote: true` the value is wrapped in single quotes. |
| `nullable` | `nullable(): this` | `this` | Marks the column nullable. |
| `unique` | `unique(): this` | `this` | Registers a unique constraint on this column and returns the column. |
| `check` | `check(rule: string): this` | `this` | Registers a table-level check constraint and returns the column. |
| `primaryKey` | `primaryKey(): this` | `this` | Registers the primary key, adds a unique constraint, and marks the column `NOT NULL`. |
| `generated` | `generated(expression: string, stored: 'STORED' \| 'VIRTUAL' = 'STORED'): this` | `this` | Marks the column `GENERATED ALWAYS AS (expr) STORED`; `'VIRTUAL'` throws (PostgreSQL only supports stored), and any default is cleared. |
| `identity` | `identity(generationOrFunction?: 'ALWAYS' \| 'BY DEFAULT' \| 'v4' \| 'v7' \| string, options?: { start?: number; increment?: number; minValue?: number; maxValue?: number; cache?: number; cycle?: boolean }): this` | `this` | Integer types get a real `GENERATED … AS IDENTITY` clause; `uuid` columns get a default generator function instead (see below). |
| `comment` | `comment(comment: string): this` | `this` | Sets the column comment. |
| `getName` | `getName(): string` | `string` | The column name. |
| `getType` | `getType(): ColumnType \| undefined` | `ColumnType \| undefined` | The modeled type. |
| `getSize` | `getSize(): number \| undefined` | `number \| undefined` | The length/precision modifier. |
| `getScale` | `getScale(): number \| undefined` | `number \| undefined` | The numeric scale. |
| `getDefault` | `getDefault(): string \| boolean \| number \| undefined` | `string \| boolean \| number \| undefined` | The default expression. |
| `getNullable` | `getNullable(): boolean` | `boolean` | True only after `nullable()` was called. |
| `getGeneratedExpression` | `getGeneratedExpression(): string \| undefined` | `string \| undefined` | The generated-column expression. |
| `isGenerated` | `isGenerated(): boolean` | `boolean` | Whether a generated expression is set. |
| `isGeneratedStored` | `isGeneratedStored(): boolean` | `boolean` | Whether the generated column is stored. |
| `getIdentityGeneration` | `getIdentityGeneration(): 'ALWAYS' \| 'BY DEFAULT' \| undefined` | `'ALWAYS' \| 'BY DEFAULT' \| undefined` | The identity generation mode. |
| `getIdentityOptions` | `getIdentityOptions()` | `{ start?, increment?, minValue?, maxValue?, cache?, cycle? } \| undefined` | The identity sequence options. |
| `isIdentity` | `isIdentity(): boolean` | `boolean` | Whether an integer identity clause is set. |
| `getComment` | `getComment(): string \| undefined` | `string \| undefined` | The column comment. |

`identity()` behavior:

- For `smallint`, `integer`, and `bigint`, the column becomes a PostgreSQL identity column (`ALWAYS` when no mode is passed); any default is cleared, and a column that already has a generated expression throws.
- For `uuid`, the column instead receives a default function: `'v4'` uses `uuid_generate_v4()` and registers the `uuid-ossp` extension, `'v7'` uses `uuid_generate_v7()` and registers `pg_uuidv7`, no argument (or `'ALWAYS'`/`'BY DEFAULT'`) uses the built-in `gen_random_uuid()`, and any other string is used verbatim.
- Any other column type throws (`IDENTITY columns must be integer or uuid types`).

`ColumnType` values accepted by `type()`: `'serial'`, `'bigserial'`, `'smallint'`, `'integer'`, `'bigint'`, `'decimal'`, `'numeric'`, `'real'`, `'double precision'`, `'varchar'`, `'char'`, `'text'`, `'boolean'`, `'date'`, `'time'`, `'timestamp'`, `'timestamptz'`, `'json'`, `'jsonb'`, `'uuid'`, `'vector'`, `'tsvector'`.

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const database = new DatabaseSchema('app');
const order = database.table('order');

order.bigint('id').identity('ALWAYS', { start: 1, increment: 1 });
order.uuid('public_id').identity('v4');
order.decimal('total', 12, 2).default(0);
order.text('note').nullable().comment('Free-form note');
```

---

### `IndexConstraint` and `IndexMethod`

Index builder returned by `TableSchema.index()`. Inherits `column(...column: string[]): this`, `hasColumns(): boolean`, `getTable(): TableSchema`, and `getColumns(): TableColumnSchema[]` from the internal constraint base.

```typescript fragment
type IndexMethod =
  | 'btree'    // Default, good for equality and range queries
  | 'hash'     // Only equality comparisons
  | 'gist'     // Generalized Search Tree (geometric, full-text)
  | 'gin'      // Generalized Inverted Index (arrays, jsonb, full-text)
  | 'brin'     // Block Range Index (very large tables)
  | 'spgist'   // Space-partitioned GIST (non-balanced structures)
  | 'bloom';   // Bloom filter (multi-column equality)
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(table: TableSchema)` | `IndexConstraint` | Prefer `TableSchema.index()`. |
| `column` | `column(...column: string[]): this` | `this` | Adds key columns (inherited from the constraint base). |
| `unique` | `unique(): this` | `this` | Creates a unique index. |
| `using` | `using(method: IndexMethod): this` | `this` | Sets the index method. |
| `where` | `where(condition: string): this` | `this` | Sets a partial-index predicate. |
| `indexName` | `indexName(name: string): this` | `this` | Sets an explicit index name. |
| `concurrent` | `concurrent(): this` | `this` | Emits `CREATE INDEX CONCURRENTLY` (the generated migration then runs outside a transaction). |
| `include` | `include(...columns: string[]): this` | `this` | Adds non-key `INCLUDE` columns. |
| `expression` | `expression(expr: string): this` | `this` | Uses a raw index expression instead of key columns. |
| `with` | `with(params: Record<string, string \| number>): this` | `this` | Sets `WITH (...)` storage parameters. |
| `tablespace` | `tablespace(name: string): this` | `this` | Sets the index tablespace. |
| `isUnique` | `isUnique(): boolean` | `boolean` | Whether the index is unique. |
| `getMethod` | `getMethod(): IndexMethod \| undefined` | `IndexMethod \| undefined` | The index method. |
| `getWhere` | `getWhere(): string \| undefined` | `string \| undefined` | The partial-index predicate. |
| `getIndexName` | `getIndexName(): string \| undefined` | `string \| undefined` | The explicit index name. |
| `getConcurrent` | `getConcurrent(): boolean` | `boolean` | Whether `CONCURRENTLY` was requested. |
| `getInclude` | `getInclude(): string[] \| undefined` | `string[] \| undefined` | The `INCLUDE` columns. |
| `getExpression` | `getExpression(): string \| undefined` | `string \| undefined` | The index expression. |
| `getStorageParams` | `getStorageParams(): Record<string, string \| number> \| undefined` | `Record<string, string \| number> \| undefined` | The storage parameters. |
| `getTablespace` | `getTablespace(): string \| undefined` | `string \| undefined` | The tablespace. |

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';
import type { IndexMethod } from 'blendsdk/codegen';

const method: IndexMethod = 'gin';

const database = new DatabaseSchema('app');
const item = database.table('item');

item.bigint('id').primaryKey();
item.jsonb('metadata').nullable();

const index = item.index();
index.indexName('item_metadata_idx').using(method).column('metadata');
```

---

## PostgreSQL Introspection

Read-only projection of a live PostgreSQL catalog into the schema model, so `TypeGenerator` can emit TypeScript declarations for an existing database.

### `PostgreSQLIntrospector`

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(db: PostgreSQLDatabase)` | `PostgreSQLIntrospector` | Takes an `blendsdk/postgresql` database. |
| `introspect` | `introspect(schema: SchemaContainer, mapper?: ColumnMapper): Promise<void>` | `Promise<void>` | Reads the catalog and registers table/view/enum/composite nodes into `schema`. |
| `introstectConstantTypes` | `introstectConstantTypes(): Promise<ConstantType>` | `Promise<ConstantType>` | Reads tables, views, materialized views, and partitioned tables as relation → column-name lists (note the source spelling). |

**Protected hooks** (for subclasses):

```typescript fragment
protected createTypes(
  schema: SchemaContainer,
  records: ColumnIntrospection[],
  mapper: ColumnMapper | undefined,
  index: TypesIndex
): void
protected createEnumTypes(schema: SchemaContainer, records: ColumnIntrospection[]): void
protected mapPgTypeToTypescript(data: ColumnIntrospection, s: SchemaScope): SchemaObject | null
```

`TypesIndex` is an internal alias for `Record<string, SchemaObject>`.

`introspect()` behavior:

- Runs the bundled introspection query through `PostgreSQLIntrospector`'s database, then normalizes the `public` schema name to no scope.
- Registers enum types first, composite types second (through the mapper), then tables, views, materialized views, and partitioned tables.
- Uses the `ColumnMapper` when supplied; falls back to enum references, then to a built-in PostgreSQL → TypeScript type map; an unmapped type becomes a permissive node whose description carries a `@deprecated` warning, and a warning is printed.
- Marks array columns as `arrayed()`, nullable columns as `nullable().optional()`, stores the raw row under `metadata({ introspect: row })`, and records `@default`, `@primaryKey`, `@unique`, and `@checkContraint` annotations in the generated descriptions.

```typescript
import { PostgreSQLIntrospector, SchemaContainer, TypeGenerator } from 'blendsdk/codegen';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

async function generateTypes(db: PostgreSQLDatabase): Promise<string> {
  const schema = new SchemaContainer();
  await new PostgreSQLIntrospector(db).introspect(schema);
  return new TypeGenerator().generate(schema);
}
```

```typescript
import { CTypeGenerator, PostgreSQLIntrospector } from 'blendsdk/codegen';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

async function generateConstants(db: PostgreSQLDatabase): Promise<string> {
  const constants = await new PostgreSQLIntrospector(db).introstectConstantTypes();
  return new CTypeGenerator().generate(constants);
}
```

---

### `ColumnMapper`

Strategy function used by `PostgreSQLIntrospector.introspect()` to override the mapping of one introspected column.

```typescript fragment
type ColumnMapper = (r: ColumnIntrospection, s: SchemaScope) => SchemaObject | unknown;
```

Return a schema node created from the supplied scope to override the built-in mapping; return a falsy value to fall back to the default mapping.

```typescript
import { PostgreSQLIntrospector, SchemaContainer } from 'blendsdk/codegen';
import type { ColumnMapper } from 'blendsdk/codegen';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const mapper: ColumnMapper = (column, scope) => {
  if (column.pg_type === 'bytea') {
    return scope.any().description('Binary column');
  }
  return undefined;
};

async function introspectWithOverrides(db: PostgreSQLDatabase): Promise<void> {
  const schema = new SchemaContainer();
  await new PostgreSQLIntrospector(db).introspect(schema, mapper);
}
```

---

### `ConstantType`

Relation → column-name map produced by `PostgreSQLIntrospector.introstectConstantTypes()` and consumed by `CTypeGenerator`.

```typescript fragment
interface ConstantType {
  [name: string]: string[];
}
```

```typescript
import { CTypeGenerator } from 'blendsdk/codegen';
import type { ConstantType } from 'blendsdk/codegen';

const constants: ConstantType = {
  'public.customer': ['id', 'email', 'name'],
  orders: ['id', 'total'],
};

const source: string = await new CTypeGenerator().generate(constants);
console.log(source);
```

---

### `ColumnIntrospection`

One row of catalog introspection passed to a `ColumnMapper`.

| Property | Type | Description |
|----------|------|-------------|
| `database_name` | `string` | Database the row was read from. |
| `schema_name` | `string` | Object's schema. |
| `relation_name` | `string` | Table, view, composite, or enum name. |
| `relation_kind` | `'table' \| 'view' \| 'materialized view' \| 'partitioned table' \| 'foreign table' \| 'enum type' \| 'composite type'` | Kind of catalog object the row belongs to. |
| `table_comment` | `string \| null` | Comment on the relation. |
| `column_name` | `string` | Column (or enum label) name. |
| `column_comment` | `string \| null` | Comment on the column. |
| `is_nullable` | `boolean` | Whether the column accepts NULL. |
| `has_default` | `boolean` | Whether the column has a default. |
| `column_default` | `string \| null` | The rendered default expression. |
| `pg_type` | `string` | PostgreSQL type name as reported by the catalog. |
| `formatted_type` | `string` | Fully formatted type (including modifiers). |
| `is_array` | `boolean` | Whether the column is an array. |
| `array_element_pg_type` | `string \| null` | Element type name for arrays. |
| `array_element_formatted_type` | `string \| null` | Formatted element type for arrays. |
| `length` | `number \| null` | Character maximum length, when applicable. |
| `precision` | `number \| null` | Numeric precision, when applicable. |
| `scale` | `number \| null` | Numeric scale, when applicable. |
| `is_primary_key` | `boolean` | Whether the column participates in the primary key. |
| `is_unique` | `boolean` | Whether the column participates in a unique index. |
| `is_foreign_key` | `boolean` | Whether the column participates in a foreign key. |
| `fk_info` | `ForeignKeyInfo[] \| null` | Foreign-key details, when present. |
| `is_check_constrained` | `boolean` | Whether the column has a check constraint. |
| `check_constraints` | `CheckConstraintInfo[] \| null` | Check-constraint details, when present. |
| `is_enum` | `boolean` | Whether the column uses an enum type. |
| `enum_type_name` | `string \| null` | Qualified enum type name. |
| `enum_labels` | `string[] \| string \| null` | Enum labels for the column's type. |
| `type_oid` | `number` | OID of the column's type. |

---

### `ForeignKeyInfo`

| Property | Type | Description |
|----------|------|-------------|
| `constraint_name` | `string` | Constraint name. |
| `ref_schema` | `string` | Referenced schema. |
| `ref_table` | `string` | Referenced table. |
| `ref_columns` | `string[]` | Referenced columns. |
| `column_positions` | `number[]` | Local column positions. |
| `update_action` | `'NO ACTION' \| 'RESTRICT' \| 'CASCADE' \| 'SET NULL' \| 'SET DEFAULT'` | `ON UPDATE` action. |
| `delete_action` | `'NO ACTION' \| 'RESTRICT' \| 'CASCADE' \| 'SET NULL' \| 'SET DEFAULT'` | `ON DELETE` action. |
| `match_type` | `'SIMPLE' \| 'FULL' \| 'PARTIAL'` | Foreign-key match type. |

---

### `CheckConstraintInfo`

| Property | Type | Description |
|----------|------|-------------|
| `constraint_name` | `string` | Constraint name. |
| `definition` | `string` | Rendered check definition. |

---

## Generators

### `TypeGenerator` and `TypeGeneratorOptions`

Renders the schema model as Prettier-formatted TypeScript: interfaces for plain objects, type aliases for modified or nested shapes.

```typescript fragment
interface TypeGeneratorOptions {
  // Currently empty; reserved for future options.
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(options?: TypeGeneratorOptions)` | `TypeGenerator` | Creates a generator. |
| `generate` | `generate(container: SchemaContainer): Promise<string>` | `Promise<string>` | Renders every named, unrendered node and formats the result with Prettier. |
| `renderReferenceSchema` | `protected renderReferenceSchema(obj: ReferenceSchema): string` | `string` | Renders a reference inline (property) or as an exported alias. |
| `renderObjectSchema` | `protected renderObjectSchema(obj: ObjectSchema): string` | `string` | Renders an interface or type alias for an object node. |
| `renderPrimitiveTypeSchema` | `protected renderPrimitiveTypeSchema(obj: SchemaObject): string` | `string` | Renders a primitive alias or inline property type. |
| `modifiers` | `protected modifiers(target: string \| undefined, obj: SchemaObject)` | `string \| undefined` | Applies `Partial<T>`, `T[]`, `Record<string, T>`, and `T \| null` in that order. |
| `addDescription` | `protected addDescription(obj: SchemaObject, lines: string[], isProp?: boolean): void` | `void` | Emits JSDoc annotations (`@interface`/`@type`, `@partial`, `@array`, `@optional`, `@nullable`, `@memberOf {Parent}`). |
| `getDeclaration` | `protected getDeclaration(obj: SchemaObject)` | `{ declType: string; equalSign: string; type_declaration: boolean }` | Chooses `interface` for plain root objects and `type` otherwise. |

Nested properties may not be named explicitly; naming a property forces a separate root type referenced with `ref()` (the generator throws otherwise).

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

scope
  .object({
    id: scope.number(),
    name: scope.string(),
    tags: scope.string().arrayed(),
    note: scope.string().nullable().optional(),
  })
  .named('Product');

const source: string = await new TypeGenerator().generate(schema);

console.log(source);
```

---

### `ZodGenerator` and `ZodGeneratorOptions`

Renders the schema model as Prettier-formatted Zod schemas.

```typescript fragment
interface ZodGeneratorOptions {
  /** Postfix appended to each generated variable name. Defaults to `'schema'`. */
  zodVariablePostfix?: string;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(options?: ZodGeneratorOptions)` | `ZodGenerator` | Creates a generator and seeds the generated output with `import * as z from 'zod';`. Default postfix: `'schema'`. |
| `generate` | `generate(container: SchemaContainer): Promise<string>` | `Promise<string>` | Renders every named node and formats the result with Prettier. |
| `getZodVariableName` | `protected getZodVariableName(obj: SchemaObject): string` | `string` | PascalCase variable name derived from the scoped node name plus `zodVariablePostfix`. |
| `renderReferenceSchema` | `protected renderReferenceSchema(obj: ReferenceSchema): string` | `string` | Renders the referenced variable, with modifiers. |
| `renderObjectSchema` | `protected renderObjectSchema(obj: ObjectSchema): string` | `string` | Renders `z.<zodType>({ ... })`. |
| `renderPrimitiveTypeSchema` | `protected renderPrimitiveTypeSchema(obj: SchemaObject): string` | `string` | Renders `z.<zodType>()`. |
| `modifiers` | `protected modifiers(target: string \| undefined, obj: SchemaObject)` | `string \| undefined` | Applies `.partial()`, `.optional()`, and `.nullable()` in that order. |

```typescript
import { SchemaContainer, ZodGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

scope
  .object({
    id: scope.number(),
    name: scope.string(),
    nickname: scope.string().nullable().optional(),
  })
  .named('Product');

const source: string = await new ZodGenerator().generate(schema);

console.log(source);
```

The generated source:

```typescript
import * as z from 'zod';

export const ProductSchema = z.object({
  id: z.number(),
  name: z.string(),
  nickname: z.string().optional().nullable(),
});
```

---

### `CTypeGenerator`

Renders relation constants — one exported object per relation with a `$TABLE` key and one uppercase key per column.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `generate` | `generate(ctypes: ConstantType): Promise<string>` | `Promise<string>` | Renders one JSDoc-annotated `e<Relation>` constant per entry and formats the result with Prettier. |

```typescript
import { CTypeGenerator } from 'blendsdk/codegen';
import type { ConstantType } from 'blendsdk/codegen';

const constants: ConstantType = {
  'public.customer': ['id', 'email'],
};

const source: string = await new CTypeGenerator().generate(constants);

console.log(source);
```

The generated source:

```typescript
/**
 * Constant type for relation public.customer
 * @export
 * @constant
 */
export const ePublicCustomer = {
  $TABLE: 'public.customer',
  ID: 'id',
  EMAIL: 'email',
};
```

---

### `PostgreSQLSchemaGenerator`, `GenerateOptions`, and `GeneratedDDL`

Renders re-runnable bootstrap DDL for a fresh database from a `DatabaseSchema`.

```typescript fragment
interface GenerateOptions {
  /** Emit DROP statements before CREATE statements. Defaults to `true`. */
  dropBeforeCreate?: boolean;
}

interface GeneratedDDL {
  /** Extensions + schemas + tables + constraints + comments. */
  schema: string;
  /** All indexes. */
  indexes: string;
  /** All views (regular and materialized) plus view comments. */
  views: string;
  /** schema + indexes + views combined. */
  all: string;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(db: DatabaseSchema)` | `PostgreSQLSchemaGenerator` | Takes the desired database model. |
| `generateGrouped` | `generateGrouped(params?: GenerateOptions): GeneratedDDL` | `GeneratedDDL` | Renders the four groups separately (indexes and views last, so callers can run them with different locking). |
| `generate` | `generate(params?: GenerateOptions): string` | `string` | Renders everything as one string (`generateGrouped(...).all`). |

Rendering details:

- The `schema` group is ordered extensions, optional `DROP SCHEMA`/`DROP TABLE ... CASCADE` statements, `CREATE SCHEMA IF NOT EXISTS`, `CREATE TABLE`, `ALTER TABLE` constraints, then comments.
- Constraint and index names are derived deterministically from the table, columns, and a suffix (`pkey`, `fkey`, `unique`, `check`, `idx`, `key`) when not set explicitly.
- Views are always emitted as `DROP ... IF EXISTS` followed by `CREATE` (or `CREATE MATERIALIZED VIEW`), then view comments.
- Output is raw SQL text; unlike the TypeScript generators it is not Prettier-formatted.

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';
import type { GeneratedDDL } from 'blendsdk/codegen';

const database = new DatabaseSchema('app');
const customer = database.table('customer');
customer.bigint('id').primaryKey();
customer.varchar('email', 255).unique();

const generator = new PostgreSQLSchemaGenerator(database);
const grouped: GeneratedDDL = generator.generateGrouped({ dropBeforeCreate: true });

console.log(grouped.schema);
console.log(grouped.indexes);
console.log(grouped.views);
```

---

## OpenAPI Generation

### `OpenAPIGenerator` and `ControllerConstructor`

Collects annotated controller routes and assembles a deterministic OpenAPI 3.1.0 document. Only routes carrying `.openapi()` metadata are included (the opt-in mechanism).

```typescript fragment
type ControllerConstructor = new (
  settings: any,
  services: any
) => { routes(): RouteDefinition[] };
```

`RouteDefinition` is imported from `blendsdk/webafx`. Controllers are instantiated with empty settings and services objects because `routes()` only builds route definitions; it does not touch the database or the network.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(config: OpenAPIGeneratorConfig)` | `OpenAPIGenerator` | Takes API metadata, servers, security schemes, and default security. |
| `addController` | `addController(basePath: string, ControllerClass: ControllerConstructor): this` | `this` | Instantiates the controller and collects its annotated routes. |
| `addRoutes` | `addRoutes(basePath: string, routeDefinitions: RouteDefinition[]): this` | `this` | Collects only the definitions that carry OpenAPI metadata. |
| `generate` | `generate(): OpenAPIDocument` | `OpenAPIDocument` | Assembles the document, sorts paths and methods, and hoists reusable definitions into `components.schemas`. |
| `toJSON` | `toJSON(indent?: number): string` | `string` | Serializes the generated document; `indent` defaults to `2`. |
| `toFile` | `toFile(filePath: string): void` | `void` | Writes the document as JSON, creating parent directories when needed. |

**Protected extension points:**

```typescript fragment
protected buildPaths(): Record<string, OpenAPIPathItem>
protected buildFullPath(basePath: string, routePath: string): string
protected convertExpressPathToOpenAPI(expressPath: string): string
protected extractPathParamNames(expressPath: string): string[]
protected buildOperation(definition: RouteDefinition): OpenAPIOperation
protected buildParameters(definition: RouteDefinition): OpenAPIParameter[]
protected buildRequestBody(definition: RouteDefinition): { description?: string; required?: boolean; content: Record<string, { schema?: any }> } | undefined
protected buildResponses(definition: RouteDefinition): Record<string, OpenAPIResponse>
protected buildSecurity(definition: RouteDefinition): SecurityRequirement[] | undefined
protected isQueryParamMethod(method: HttpMethod): boolean
protected convertZodToSchema(zodSchema: unknown, direction: 'input' | 'output'): OpenAPISchema
protected convertZodToQueryParameters(zodSchema: unknown): OpenAPIParameter[]
```

Behavior notes:

- Express `:param` segments become OpenAPI `{param}` path parameters (always `required: true`).
- `GET` and `DELETE` routes with a validation schema emit per-property query parameters; `POST`, `PUT`, and `PATCH` routes with a validation schema emit an `application/json` request body.
- `secure: true` routes receive the configured `defaultSecurity`; a secure route without configured default security gets an empty security array.
- Every operation records `x-blend-envelope` (`'data'` by default, or the route's declared envelope) so the client generator knows how to read a success body.

```typescript
import { OpenAPIGenerator } from 'blendsdk/codegen';
import { ProductsController } from './controllers/products.controller.js';

const generator = new OpenAPIGenerator({
  title: 'My API',
  version: '1.0.0',
  description: 'Product catalog API',
  servers: [{ url: 'http://localhost:3000', description: 'Local development' }],
  securitySchemes: {
    bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  },
  defaultSecurity: [{ bearerAuth: [] }],
});

generator.addController('/api/products', ProductsController);

const document = generator.generate();
generator.toFile('./openapi/api.json');
```

---

### `convertZodToJsonSchema`

```typescript fragment
function convertZodToJsonSchema(
  schema: ZodType,
  direction: 'input' | 'output'
): OpenAPISchema
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `schema` | `ZodType` | Yes | — | The Zod schema to convert. |
| `direction` | `'input' \| 'output'` | Yes | — | Which side of the wire the schema describes. `'input'` resolves request-side defaults and transforms; `'output'` resolves response-side ones. |

**Returns**: `OpenAPISchema` — a draft-2020-12 JSON Schema normalized for OpenAPI 3.1: the root `$schema` marker is dropped, and simple nullable unions become type arrays such as `['string', 'null']`. A value that is not a Zod schema converts to `{ type: 'object' }`.

```typescript
import { convertZodToJsonSchema } from 'blendsdk/codegen';
import { z } from 'zod';

const schema = convertZodToJsonSchema(
  z.object({ nickname: z.string().nullable() }),
  'input'
);

console.log(JSON.stringify(schema, null, 2));
```

---

### `convertZodToQueryParameters`

```typescript fragment
function convertZodToQueryParameters(schema: ZodType): OpenAPIParameter[]
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `schema` | `ZodType` | Yes | — | The route's query object schema. |

**Returns**: `OpenAPIParameter[]` — one `in: 'query'` parameter per top-level property. Required properties are marked required; optional and defaulted properties are not. A non-object schema (or a non-Zod value) returns `[]`.

```typescript
import { convertZodToQueryParameters } from 'blendsdk/codegen';
import { z } from 'zod';

const parameters = convertZodToQueryParameters(
  z.object({ page: z.coerce.number().default(1), search: z.string().optional() })
);

console.log(parameters.map(parameter => parameter.name)); // ['page', 'search']
```

---

### `hoistDefinitions`

```typescript fragment
function hoistDefinitions(document: OpenAPIDocument): OpenAPIDocument
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `document` | `OpenAPIDocument` | Yes | — | The in-progress document whose `$defs` maps should be moved. |

**Returns**: `OpenAPIDocument` — the same document with every `#/$defs/Name` reference rewritten to `#/components/schemas/Name` and the definitions merged (sorted) into `components.schemas`. Existing component entries such as `securitySchemes` are preserved; same-named-but-different definitions are deterministically renamed (`Name_2`, …); a surviving local `$defs` reference throws.

```typescript
import { convertZodToJsonSchema, hoistDefinitions } from 'blendsdk/codegen';
import type { OpenAPIDocument } from 'blendsdk/codegen';
import { z } from 'zod';

const product = z.object({ id: z.number(), name: z.string() }).meta({ id: 'Product' });
const schema = convertZodToJsonSchema(z.object({ a: product, b: product }), 'input');

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Catalog', version: '1.0.0' },
  paths: {
    '/api/products': {
      get: {
        operationId: 'listProducts',
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema } } },
        },
      },
    },
  },
};

const hoisted = hoistDefinitions(document);

console.log(Object.keys(hoisted.components?.schemas ?? {})); // ['Product']
```

---

### `isZodSchema`

```typescript fragment
function isZodSchema(value: unknown): value is ZodType
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `value` | `unknown` | Yes | — | The value to inspect. |

**Returns**: `value is ZodType` — a type predicate that narrows `value` when it is a Zod schema.

```typescript
import { isZodSchema } from 'blendsdk/codegen';
import { z } from 'zod';

const value: unknown = z.string();

if (isZodSchema(value)) {
  console.log(value.safeParse('ok').success); // true
}
```

---

### `sortByName`

```typescript fragment
function sortByName<T extends object>(record: T): T
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `record` | `T extends object` | Yes | — | The record whose keys should be sorted. |

**Returns**: `T` — a new record with the same values and ascending code-point key order. Deterministic key order keeps generated documents byte-stable.

```typescript
import { sortByName } from 'blendsdk/codegen';

const sorted = sortByName({ zeta: 1, alpha: 2 });

console.log(Object.keys(sorted)); // ['alpha', 'zeta']
```

---

### OpenAPI document types

#### `OpenAPIDocument`

```typescript fragment
interface OpenAPIDocument {
  openapi: '3.1.0';
  info: OpenAPIInfo;
  servers?: OpenAPIServer[];
  paths: Record<string, OpenAPIPathItem>;
  components?: OpenAPIComponents;
}
```

#### `OpenAPIInfo`

| Property | Type | Description |
|----------|------|-------------|
| `title` | `string` | API title. |
| `version` | `string` | API version (not the OpenAPI specification version). |
| `description` | `string` | Optional API description (Markdown supported). |

#### `OpenAPIServer`

| Property | Type | Description |
|----------|------|-------------|
| `url` | `string` | Target host URL. |
| `description` | `string` | Optional description. |

#### `OpenAPISchema`

| Property | Type | Description |
|----------|------|-------------|
| `type` | `string \| string[]` | Data type; an array expresses nullability, for example `['string', 'null']`. |
| `description` | `string` | Description of this schema. |
| `format` | `string` | Format hint (`'int32'`, `'date-time'`, `'email'`, `'uuid'`, …). |
| `enum` | `unknown[]` | Allowed enumeration values. |
| `default` | `unknown` | Default value. |
| `properties` | `Record<string, OpenAPISchema>` | Object property definitions. |
| `required` | `string[]` | Required property names. |
| `additionalProperties` | `boolean \| OpenAPISchema` | Whether / which additional properties are allowed. |
| `items` | `OpenAPISchema` | Array item schema. |
| `minimum` | `number` | Minimum value. |
| `maximum` | `number` | Maximum value. |
| `minLength` | `number` | Minimum length (string) or minimum items (array). |
| `maxLength` | `number` | Maximum length (string) or maximum items (array). |
| `minItems` | `number` | Minimum number of items (array). |
| `maxItems` | `number` | Maximum number of items (array). |
| `pattern` | `string` | Regex pattern for strings. |
| `allOf` | `OpenAPISchema[]` | All listed schemas must match. |
| `anyOf` | `OpenAPISchema[]` | Any listed schema must match. |
| `oneOf` | `OpenAPISchema[]` | Exactly one listed schema must match. |
| `const` | `unknown` | Single allowed constant value (JSON Schema 2020-12). |
| `propertyNames` | `OpenAPISchema` | Schema applied to an object's property names. |
| `prefixItems` | `OpenAPISchema[]` | Tuple items (JSON Schema 2020-12). |
| `examples` | `unknown[]` | Example values. |
| `$defs` | `Record<string, OpenAPISchema>` | Reusable definitions before hoisting. |
| `example` | `unknown` | Example value. |
| `$ref` | `string` | Reference to another schema. |

#### `OpenAPIParameter`

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Parameter name. |
| `in` | `'query' \| 'header' \| 'path' \| 'cookie'` | Parameter location. |
| `required` | `boolean` | Whether the parameter is required (path parameters are always required). |
| `description` | `string` | Description. |
| `schema` | `OpenAPISchema` | Type and constraints. |
| `deprecated` | `boolean` | Whether the parameter is deprecated. |

#### `OpenAPIRequestBody` and `OpenAPIMediaType`

| Property (request body) | Type | Description |
|-------------------------|------|-------------|
| `description` | `string` | Description. |
| `required` | `boolean` | Whether the body is required. |
| `content` | `Record<string, OpenAPIMediaType>` | Body content keyed by media type. |

| Property (media type) | Type | Description |
|-----------------------|------|-------------|
| `schema` | `OpenAPISchema` | Schema defining the content structure. |

#### `OpenAPIResponse`

| Property | Type | Description |
|----------|------|-------------|
| `description` | `string` | Response description (required). |
| `content` | `Record<string, OpenAPIMediaType>` | Response content keyed by media type. |

#### `OpenAPIOperation`

| Property | Type | Description |
|----------|------|-------------|
| `summary` | `string` | Short summary. |
| `description` | `string` | Verbose description (Markdown supported). |
| `operationId` | `string` | Unique operation identifier. |
| `tags` | `string[]` | Grouping tags. |
| `parameters` | `OpenAPIParameter[]` | Operation parameters. |
| `requestBody` | `OpenAPIRequestBody` | Request body. |
| `responses` | `Record<string, OpenAPIResponse>` | Responses keyed by status code. |
| `security` | `SecurityRequirement[]` | Security requirements. |
| `deprecated` | `boolean` | Whether the operation is deprecated. |
| `'x-blend-envelope'` | `'data' \| 'body'` | How a generated client reads a success body: `'data'` unwraps the top-level `data` property, `'body'` returns the whole body. |

#### `OpenAPIPathItem`

| Property | Type | Description |
|----------|------|-------------|
| `get` | `OpenAPIOperation` | GET operation. |
| `post` | `OpenAPIOperation` | POST operation. |
| `put` | `OpenAPIOperation` | PUT operation. |
| `patch` | `OpenAPIOperation` | PATCH operation. |
| `delete` | `OpenAPIOperation` | DELETE operation. |

#### `OpenAPISecurityScheme`

| Property | Type | Description |
|----------|------|-------------|
| `type` | `'apiKey' \| 'http' \| 'oauth2' \| 'openIdConnect'` | Scheme type. |
| `description` | `string` | Description. |
| `name` | `string` | Header, query, or cookie name (for `apiKey`). |
| `in` | `'query' \| 'header' \| 'cookie'` | API-key location. |
| `scheme` | `string` | HTTP authorization scheme (for `http`, for example `'bearer'`). |
| `bearerFormat` | `string` | Bearer token format (for example `'JWT'`). |

#### `SecurityRequirement`

```typescript fragment
type SecurityRequirement = Record<string, string[]>;
```

Each key is a security scheme name; each value lists the required scopes.

#### `OpenAPIComponents`

| Property | Type | Description |
|----------|------|-------------|
| `schemas` | `Record<string, OpenAPISchema>` | Reusable schema definitions. |
| `securitySchemes` | `Record<string, OpenAPISecurityScheme>` | Security scheme definitions. |

#### `OpenAPIGeneratorConfig`

| Property | Type | Description |
|----------|------|-------------|
| `title` | `string` | API title (required). |
| `version` | `string` | API version (required). |
| `description` | `string` | Optional API description (Markdown supported). |
| `servers` | `OpenAPIServer[]` | Server definitions. |
| `securitySchemes` | `Record<string, OpenAPISecurityScheme>` | Security schemes placed under `components`. |
| `defaultSecurity` | `SecurityRequirement[]` | Requirements applied to operations with `secure: true`. |

---

## Typed Client Generation

### `generateClient`

```typescript fragment
function generateClient(
  document: OpenAPIDocument,
  options: ClientGeneratorOptions
): Promise<GenerationResult>
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `document` | `OpenAPIDocument` | Yes | — | The OpenAPI 3.1 document to consume. |
| `options` | `ClientGeneratorOptions` | Yes | — | Output location and generation flags. |

**Returns**: `Promise<GenerationResult>` — the sorted file names written and any contract issues.

**Throws**: `ClientGenerationError` when two operations share an `operationId` (or a resolved group/method pair collides), or when `strict` is set and the contract has an escalation-level problem.

Behavior:

- Writes `types.ts`, `client.ts`, and `index.ts` (or `client.<group>.ts` per group plus a barrel when `splitByGroup` is set), each starting with the generated marker comment.
- Normalizes every file with Prettier and prunes marker-bearing files that are no longer generated; files without the marker are left untouched.
- Is deterministic and idempotent: components and operations are sorted, so the same document produces byte-identical output.

```typescript
import { generateClient } from 'blendsdk/codegen';
import type { GenerationResult, OpenAPIDocument } from 'blendsdk/codegen';

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Catalog', version: '1.0.0' },
  paths: {
    '/api/products': {
      get: {
        operationId: 'listProducts',
        tags: ['products'],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': { schema: { type: 'array', items: { type: 'object' } } },
            },
          },
        },
      },
    },
  },
};

const result: GenerationResult = await generateClient(document, { outputDir: 'src/api-client' });

console.log(result.files); // ['client.ts', 'index.ts', 'types.ts']
```

---

### `checkClient`

```typescript fragment
function checkClient(
  document: OpenAPIDocument,
  options: ClientGeneratorOptions
): Promise<GenerationResult>
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `document` | `OpenAPIDocument` | Yes | — | The committed OpenAPI document. |
| `options` | `ClientGeneratorOptions` | Yes | — | Output location and generation flags; nothing is written. |

**Returns**: `Promise<GenerationResult>` — `drifted` is true when a committed file differs or a contract problem escalates to an error; `driftedFiles` lists the differing files.

**Throws**: `ClientGenerationError` when two operations share an `operationId`.

`checkClient` regenerates the client in memory and escalates every escalation-level issue to an error, which is the mechanism behind the `blendsdk api check` CI drift gate.

```typescript
import { checkClient } from 'blendsdk/codegen';
import type { OpenAPIDocument } from 'blendsdk/codegen';

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Catalog', version: '1.0.0' },
  paths: {
    '/api/products': {
      get: {
        operationId: 'listProducts',
        tags: ['products'],
        responses: {
          200: {
            description: 'OK',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
  },
};

const result = await checkClient(document, { outputDir: 'src/api-client' });

if (result.drifted) {
  console.error(`Drift: ${(result.driftedFiles ?? []).join(', ')}`);
}
```

---

### `formatOpenApiDocument`

```typescript fragment
function formatOpenApiDocument(document: OpenAPIDocument): Promise<string>
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `document` | `OpenAPIDocument` | Yes | — | The document to serialize. |

**Returns**: `Promise<string>` — Prettier-formatted JSON with a trailing newline: the byte-stable text that `generate` writes and `check` compares.

```typescript
import { formatOpenApiDocument } from 'blendsdk/codegen';
import type { OpenAPIDocument } from 'blendsdk/codegen';

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Catalog', version: '1.0.0' },
  paths: {},
};

const text: string = await formatOpenApiDocument(document);

console.log(text.startsWith('{'));
```

---

### `ClientGeneratorOptions`

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `outputDir` | `string` | Yes | — | Output directory for generated files, resolved relative to the config file. |
| `splitByGroup` | `boolean` | No | `false` | Emit one `client.<group>.ts` file per group plus a barrel instead of a single `client.ts`. |
| `strict` | `boolean` | No | `false` | Treat contract problems as errors: with `true`, a missing `operationId` or 2xx schema fails generation instead of warning. |
| `clientName` | `string` | No | `'AppClient'` | Base name of the generated client type. |
| `runtimeImport` | `string` | No | `'blendsdk/api-client'` | Runtime import specifier used by generated clients. |

### `GeneratedOperation`

| Property | Type | Description |
|----------|------|-------------|
| `operationId` | `string` | OpenAPI operationId, or the deterministic fallback when it was missing. |
| `methodName` | `string` | Method name; equals `operationId` unless a reserved name forced a rename or the operationId was missing. |
| `method` | `string` | Lowercase HTTP method. |
| `path` | `string` | OpenAPI path with `{param}` placeholders. |
| `group` | `string` | Group name derived tag-first, else from the first path segment after `/api`. |
| `envelope` | `'data' \| 'body'` | How the runtime reads a success body. |
| `untypedResponse` | `boolean` | True when no 2xx response schema exists, so the return type is `unknown`. |

### `ContractIssueSeverity`

```typescript fragment
type ContractIssueSeverity = 'warning' | 'error';
```

`warning` is reported by `generate` and does not stop it; `error` is reported by `check`, which then fails.

### `ContractIssue`

| Property | Type | Description |
|----------|------|-------------|
| `severity` | `ContractIssueSeverity` | Whether the problem is a warning or an error. |
| `message` | `string` | Concise, human-readable description with the operation location. |
| `operationId` | `string` | The operationId, when the operation has one. |
| `method` | `string` | HTTP method of the affected operation. |
| `path` | `string` | Path of the affected operation. |

### `GenerationResult`

| Property | Type | Description |
|----------|------|-------------|
| `files` | `string[]` | File names written (`generate`) or compared (`check`). |
| `issues` | `ContractIssue[]` | Problems found while reading the contract. |
| `drifted` | `boolean` | True when `check` found a difference or a contract error. |
| `driftedFiles` | `string[]` | The files that differ from the committed ones. |

### `ClientGenerationError`

Raised when the contract cannot be turned into a client at all; the only current cause is a duplicate `operationId`, which would otherwise silently overwrite one generated method with another.

| Member | Signature | Description |
|--------|-----------|-------------|
| `constructor` | `constructor(message: string)` | Creates the error; `name` is set to `'ClientGenerationError'`. |

```typescript
import { ClientGenerationError, generateClient } from 'blendsdk/codegen';
import type { OpenAPIDocument } from 'blendsdk/codegen';

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Catalog', version: '1.0.0' },
  paths: {
    '/api/a': { get: { operationId: 'duplicate', responses: {} } },
    '/api/b': { post: { operationId: 'duplicate', responses: {} } },
  },
};

try {
  await generateClient(document, { outputDir: 'src/api-client' });
} catch (error) {
  if (error instanceof ClientGenerationError) {
    console.error(error.message); // names both offending operations
  }
}
```

---

## API Contract Configuration

### `defineApiContract`

```typescript fragment
function defineApiContract(contract: ApiContract): ApiContract
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `contract` | `ApiContract` | Yes | — | The user-authored contract settings. |

**Returns**: `ApiContract` — the same object; the helper only provides type inference.

The contract is the default export of a `blendsdk.api.ts` file. The `blendsdk api generate` command rebuilds the document and writes the contract JSON plus the client; `blendsdk api check` performs the same rebuild in memory and fails on drift (exit `1`), while usage or configuration problems exit `2`.

```typescript
import { defineApiContract } from 'blendsdk/codegen';
import { ProductsController } from './controllers/products.controller.js';

export default defineApiContract({
  outputDir: 'src/api-client',
  contractFile: 'openapi/api.json',
  controllers: [{ basePath: '/api/products', controller: ProductsController }],
  openapi: { title: 'Product API', version: '1.0.0' },
  generator: { splitByGroup: true, strict: true },
});
```

---

### `ApiContract`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `outputDir` | `string` | Yes | Output directory for the generated client, resolved relative to the config file. |
| `contractFile` | `string` | No | OpenAPI JSON to write and compare, relative to the config file. Defaults to `api.json`. |
| `controllers` | `ApiContractController[]` | Yes | Controllers to collect, with the base path each is mounted at. |
| `openapi` | `OpenAPIGeneratorConfig` | Yes | OpenAPI document metadata and security schemes passed to the generator. |
| `generator` | `Omit<ClientGeneratorOptions, 'outputDir'>` | No | Generator flags, excluding `outputDir` which is set above. |

### `ApiContractController`

| Property | Type | Description |
|----------|------|-------------|
| `basePath` | `string` | The base path the controller is mounted at, for example `/api/products`. |
| `controller` | `unknown` | The controller constructor. |

### `ResolvedApiContract`

A validated contract with absolute artifact paths.

| Property | Type | Description |
|----------|------|-------------|
| `configPath` | `string` | Absolute path of the loaded configuration file. |
| `outputDir` | `string` | Absolute output directory for generated files. |
| `contractFile` | `string` | Absolute path of the committed OpenAPI JSON document. |
| `controllers` | `ApiContractController[]` | The controller registrations. |
| `openapi` | `OpenAPIGeneratorConfig` | The OpenAPI document metadata and security schemes. |
| `generator` | `Omit<ClientGeneratorOptions, 'outputDir'>` | Generator flags, when configured. |

---

## PostgreSQL Migrations

The migration API turns `DatabaseSchema` changes into immutable, reviewable `.up.sql` files plus a canonical `schema.snapshot.json`, and executes or inspects those files against PostgreSQL. Generation is offline; execution is guarded by a per-database advisory lock and a fixed `public.blendsdk_migrations` ledger.

### `defineMigrationConfig`

```typescript fragment
function defineMigrationConfig<const Config extends MigrationConfig>(config: Config): Config
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `Config extends MigrationConfig` | Yes | — | The user-authored migration settings. |

**Returns**: `Config` — the same configuration object; the helper only provides type inference.

The configuration is the default export of a `blendsdk.migrations.ts` file. It never contains the database URL itself — only the name of the environment variable that holds it.

```typescript
import { defineMigrationConfig } from 'blendsdk/codegen';

export default defineMigrationConfig({
  schema: './src/database/schema.ts',
  migrationsDir: './migrations',
  databaseUrlEnv: 'DATABASE_URL',
});
```

---

### `MigrationConfig`

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `schema` | `string` | No | — | Module whose default export is the desired `DatabaseSchema`. Required by `generate`, `baseline`, and `adopt-baseline`. |
| `migrationsDir` | `string` | No | `'migrations'` | Directory containing immutable migration SQL files. |
| `snapshotFile` | `string` | No | `<migrationsDir>/schema.snapshot.json` | Canonical desired-state snapshot file. |
| `databaseUrlEnv` | `string` | No | `'DATABASE_URL'` | Uppercase environment-variable name containing the PostgreSQL connection URL. |
| `lockTimeoutMs` | `number` | No | `5000` | Maximum time (1–300000) to wait for the migration advisory lock. |
| `statementTimeoutMs` | `number` | No | `900000` | Maximum execution time (1–86400000) for one migration. |

### `ResolvedMigrationConfig`

| Property | Type | Description |
|----------|------|-------------|
| `configPath` | `string` | Absolute path of the loaded configuration file. |
| `configDirectory` | `string` | Absolute directory containing the configuration file. |
| `schema` | `string` | Absolute schema-module path, when the command needs desired schema state. |
| `migrationsDir` | `string` | Absolute directory containing migration SQL files. |
| `snapshotFile` | `string` | Absolute canonical snapshot path. |
| `databaseUrlEnv` | `string` | Environment variable containing the PostgreSQL connection URL. |
| `lockTimeoutMs` | `number` | Maximum advisory-lock wait in milliseconds. |
| `statementTimeoutMs` | `number` | Maximum statement execution time in milliseconds. |

### `MigrationCommand`

```typescript fragment
type MigrationCommand =
  | 'generate'
  | 'create'
  | 'up'
  | 'down'
  | 'status'
  | 'validate'
  | 'baseline'
  | 'adopt-baseline';
```

Generation commands (`generate`, `create`, `baseline`) operate on committed files; database commands consume those files and never generate schema changes from a live database.

### `MigrationStatus`

| Value | Description |
|-------|-------------|
| `UP_TO_DATE` | Local history is fully applied (or an offline validation/no-op run succeeded). |
| `PENDING` | Validated pending migrations exist (`down` reports the reverted migration). |
| `INVALID_HISTORY` | Local files or ledger rows disagree with the applied ordered prefix. |
| `LOCKED` | Another session currently holds the migration advisory lock. |
| `UNKNOWN_OUTCOME` | The final nontransactional migration has an uncertain outcome; investigate before mutating. |

### `MigrationSafety`

| Value | Description |
|-------|-------------|
| `safe` | Supported change that renders automatic SQL. |
| `caution` | Supported change with a data-dependent risk (for example a required column add). |
| `destructive` | Targeted removal; requires explicit generation-time approval. |
| `ambiguous` | Apparent rename that needs an explicit hint. |
| `unsupported` | Cannot be proven automatically; requires reviewed manual SQL. |

### `MigrationErrorKind`

```typescript fragment
type MigrationErrorKind =
  | 'CONFIGURATION'
  | 'INVALID_HISTORY'
  | 'FILESYSTEM'
  | 'DATABASE'
  | 'LOCKED'
  | 'UNKNOWN_OUTCOME'
  | 'UNSUPPORTED'
  | 'ABORTED'
  | 'INTERNAL';
```

### `MigrationExitCode`

```typescript fragment
type MigrationExitCode = 1 | 2;
```

Stable failure exit classes used by the command-line adapter; success returns process exit code `0`.

### `MigrationDescriptor`

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Sortable migration identifier (`YYYYMMDDHHMMSS_slug`). |
| `upPath` | `string` | Absolute path to the required up migration. |
| `downPath` | `string` | Absolute path to the optional down migration. |
| `checksum` | `string` | Lowercase SHA-256 of the exact up-file bytes. |
| `downChecksum` | `string` | Lowercase SHA-256 of the exact optional down-file bytes. |
| `transactional` | `boolean` | Whether the runner must own a transaction around the migration. |
| `downTransactional` | `boolean` | Whether an optional down file must run transactionally. |
| `fromSnapshot` | `string` | Prior canonical snapshot hash, or absent for manual/initial history. |
| `toSnapshot` | `string` | Resulting canonical snapshot hash, or absent for manual history. |

### `MigrationCommandResult`

| Property | Type | Description |
|----------|------|-------------|
| `status` | `MigrationStatus` | Terminal state observed by the command. |
| `migrations` | `MigrationDescriptor[]` | Validated migrations relevant to the result, in application order. |

---

### `generateMigration`

```typescript fragment
function generateMigration(
  options: GenerateMigrationOptions
): Promise<GenerateMigrationResult>
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `options` | `GenerateMigrationOptions` | Yes | — | Name, config, hints, approval, and optional deterministic clock. |

**Returns**: `Promise<GenerateMigrationResult>` — generated artifact metadata, or `UP_TO_DATE` without rewriting files.

**Throws**: `MigrationError` when input, history, or a requested automatic change is unsafe.

The operation is offline: it imports the configured schema module but never opens a database connection. It publishes the reviewed SQL and the next canonical snapshot atomically.

```typescript
import { generateMigration } from 'blendsdk/codegen';
import type { GenerateMigrationResult } from 'blendsdk/codegen';

const result: GenerateMigrationResult = await generateMigration({
  name: 'add-customer-email',
  configPath: './blendsdk.migrations.ts',
});

if (result.migration) {
  console.log(`GENERATED ${result.migration.id}`);
} else {
  console.log('The desired state is already committed.');
}
```

### `GenerateMigrationOptions`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | `string` | Yes | Lowercase migration slug (`^[a-z][a-z0-9-]{0,62}$`). |
| `configPath` | `string` | No | Explicit configuration file or discovery directory. |
| `renameHints` | `readonly RenameHint[]` | No | Explicit one-to-one table or column renames. |
| `allowDestructive` | `boolean` | No | Allows only targeted changes already classified as destructive. |
| `now` | `Date` | No | Deterministic clock used by tests and embedding callers. |

### `GenerateMigrationResult`

| Property | Type | Description |
|----------|------|-------------|
| `status` | `'GENERATED' \| 'UP_TO_DATE'` | Whether a pair was published or desired state was already current. |
| `migration` | `MigrationDescriptor` | Published migration descriptor when state changed. |
| `previousSnapshot` | `string` | Hash of the prior comparison state. |
| `desiredSnapshot` | `string` | Hash of the desired comparison state. |
| `changes` | `readonly SchemaChange[]` | Complete reviewed semantic change list. |

---

### `generateBaseline`

```typescript fragment
function generateBaseline(
  options: GenerateBaselineOptions
): Promise<GenerateBaselineResult>
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `options` | `GenerateBaselineOptions` | Yes | — | Baseline name, config location, and optional deterministic clock. |

**Returns**: `Promise<GenerateBaselineResult>` — the one published initial migration, its snapshot hash, and the rendered changes.

**Throws**: `MigrationError` when a snapshot or up history already exists, or when generation input is invalid.

Creates one complete offline baseline migration and canonical snapshot. The operation refuses any existing snapshot or up history and never opens a database connection.

```typescript
import { generateBaseline } from 'blendsdk/codegen';

const baseline = await generateBaseline({ name: 'initial' });

console.log(`${baseline.status} ${baseline.migration.id} ${baseline.snapshotHash}`);
```

### `GenerateBaselineOptions`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | `string` | Yes | Lowercase baseline slug. |
| `configPath` | `string` | No | Explicit configuration file or discovery directory. |
| `now` | `Date` | No | Deterministic clock used by tests and embedding callers. |

### `GenerateBaselineResult`

| Property | Type | Description |
|----------|------|-------------|
| `status` | `'GENERATED'` | Successful baseline generation state. |
| `migration` | `MigrationDescriptor` | The one published initial migration. |
| `snapshotHash` | `string` | SHA-256 of the published canonical snapshot bytes. |
| `changes` | `readonly SchemaChange[]` | Complete desired-state additions rendered into the baseline. |

---

### `adoptBaseline`

```typescript fragment
function adoptBaseline(
  options: AdoptBaselineOptions,
  dependencies?: AdoptBaselineDependencies
): Promise<AdoptBaselineResult>
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `options` | `AdoptBaselineOptions` | Yes | — | Config location and optional confirmation token. |
| `dependencies` | `AdoptBaselineDependencies` | No | `{}` | Optional preview seam used to display the target and collect confirmation. |

**Returns**: `Promise<AdoptBaselineResult>` — the successful adoption state and the authoritative comparison.

**Throws**: `MigrationError` when the live catalog is incompatible, the confirmation token does not match the target, the ledger is nonempty, or the database cannot be reached.

Proves supported catalog equality and records one baseline without executing its SQL. The caller must separately quiesce application and administrative DDL, then provide the exact `<database>/<baseline-id>` confirmation token; the comparison is repeated inside the ledger transaction.

```typescript
import { adoptBaseline } from 'blendsdk/codegen';
import type { AdoptionPreview } from 'blendsdk/codegen';

const result = await adoptBaseline(
  {},
  {
    afterPreview: (preview: AdoptionPreview): string => {
      console.log(`Target ${preview.user}@${preview.host}:${preview.port}/${preview.database}`);
      return `${preview.database}/${preview.baselineId}`;
    },
  }
);

console.log(result.status); // 'ADOPTED'
```

### `AdoptBaselineOptions`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `configPath` | `string` | No | Explicit configuration file or discovery directory. |
| `confirmation` | `string` | No | Exact `<database>/<baseline-id>` DDL-quiescence confirmation token; return it from `afterPreview` instead of passing it here when you want the preview first. |

### `AdoptBaselineDependencies`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `afterPreview` | `(preview: AdoptionPreview) => string \| void \| Promise<string \| void>` | No | Displays the preview and may return the target-bound confirmation collected from the user. |

### `AdoptionPreview`

| Property | Type | Description |
|----------|------|-------------|
| `host` | `string` | Target host without password or URL query values. |
| `port` | `string` | Target PostgreSQL port. |
| `user` | `string` | Target role name without its password. |
| `database` | `string` | Target database name without host credentials or URL query values. |
| `baselineId` | `string` | Initial migration identifier that will be recorded. |
| `comparison` | `readonly CatalogComparisonItem[]` | Stable supported and unmanaged catalog comparison. |

### `AdoptBaselineResult`

| Property | Type | Description |
|----------|------|-------------|
| `status` | `'ADOPTED'` | Successful existing-database adoption state. |
| `comparison` | `readonly CatalogComparisonItem[]` | Authoritative comparison, including informational unmanaged objects. |

**Comparison entries** (`CatalogComparisonItem`; the interface itself is not re-exported) have the shape `{ readonly classification; readonly identity: string }`:

| Classification | Description |
|----------------|-------------|
| `MATCH` | Desired and live objects agree. |
| `MISSING` | A modeled object is absent from the live catalog. |
| `DIFFERENT` | The object exists with different supported properties. |
| `EXTRA_MODELED` | The live catalog has a modeled object that the desired state does not. |
| `UNMANAGED` | Unmodeled object reported for information only. |
| `UNSUPPORTED_FOR_ADOPTION` | Structure or raw SQL whose equivalence cannot be proven; blocks adoption. |

---

### `runMigrations`

```typescript fragment
function runMigrations(
  options: RunMigrationsOptions
): Promise<MigrationCommandResult>
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `options` | `RunMigrationsOptions` | Yes | — | Command, configuration location, safety flags, and cancellation signal. |

**Returns**: `Promise<MigrationCommandResult>` — a structured terminal state and the migrations relevant to that state.

**Throws**: `MigrationError` when a mutating command cannot complete safely.

Validates local history and runs or observes PostgreSQL migrations. Execution holds a dedicated advisory-lock session, re-verifies file checksums after the lock wait, applies declared lock/statement timeouts, and promotes or clears the ledger row inside the same transaction as the migration SQL (nontransactional migrations use a durable dirty marker instead).

```typescript
import { runMigrations } from 'blendsdk/codegen';
import type { MigrationCommandResult } from 'blendsdk/codegen';

const dryRun: MigrationCommandResult = await runMigrations({ command: 'up', dryRun: true });

for (const migration of dryRun.migrations) {
  console.log(`pending: ${migration.id}`);
}
```

### `RunMigrationsOptions`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `command` | `'up' \| 'down' \| 'status' \| 'validate'` | Yes | Execution or observation command. |
| `configPath` | `string` | No | Explicit configuration file or discovery directory. |
| `dryRun` | `boolean` | No | Reports pending order while proving lock availability, without database mutation. |
| `allowDown` | `boolean` | No | Explicitly permits one guarded down migration. |
| `offline` | `boolean` | No | Performs `validate` against local files only, even when the URL environment variable is set. |
| `signal` | `AbortSignal` | No | Caller-owned cancellation signal; the library installs no global handlers. |

---

### `getMigrationStatus`

```typescript fragment
function getMigrationStatus(
  options?: GetMigrationStatusOptions
): Promise<MigrationCommandResult>
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `options` | `GetMigrationStatusOptions` | No | `{}` | Configuration location. |

**Returns**: `Promise<MigrationCommandResult>` — reads the current migration status without mutating PostgreSQL; a held lock reports `LOCKED`.

```typescript
import { getMigrationStatus } from 'blendsdk/codegen';

const { status } = await getMigrationStatus({ configPath: './blendsdk.migrations.ts' });

console.log(status);
```

### `GetMigrationStatusOptions`

| Property | Type | Description |
|----------|------|-------------|
| `configPath` | `string` | Explicit configuration file or discovery directory. |

---

### `validateMigrations`

```typescript fragment
function validateMigrations(
  options?: ValidateMigrationsOptions
): Promise<MigrationCommandResult>
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `options` | `ValidateMigrationsOptions` | No | `{}` | Configuration location and the offline switch. |

**Returns**: `Promise<MigrationCommandResult>` — validates local and, unless offline, live PostgreSQL migration history, returning `UP_TO_DATE`, `PENDING`, or `INVALID_HISTORY`.

```typescript
import { validateMigrations } from 'blendsdk/codegen';

const result = await validateMigrations({ offline: true });

console.log(result.status); // 'UP_TO_DATE'
```

### `ValidateMigrationsOptions`

| Property | Type | Description |
|----------|------|-------------|
| `configPath` | `string` | Explicit configuration file or discovery directory. |
| `offline` | `boolean` | Validates only local files and lineage without loading the PostgreSQL driver. |

---

### `MigrationError` and `formatMigrationError`

Typed failure raised for expected migration configuration, history, filesystem, and database problems. The public message is sanitized at construction time, so ordinary error logging cannot expose a PostgreSQL connection URL.

| Member | Signature | Description |
|--------|-----------|-------------|
| `constructor` | `constructor(options: MigrationErrorOptions)` | Creates one sanitized migration error; `name` is set to `'MigrationError'`. |
| `kind` | `MigrationErrorKind` | Stable machine-readable category (readonly property). |
| `exitCode` | `MigrationExitCode` | Process exit class used by the command-line adapter (readonly property). |

```typescript fragment
function formatMigrationError(error: MigrationError): string
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `error` | `MigrationError` | Yes | — | Typed migration error to render. |

**Returns**: `string` — stable category and sanitized message without SQL or credentials, for example `CONFIGURATION: Missing config`.

```typescript
import { formatMigrationError, MigrationError } from 'blendsdk/codegen';

function report(error: unknown): string {
  if (error instanceof MigrationError) {
    return formatMigrationError(error);
  }
  return 'Unexpected failure.';
}
```

### `MigrationErrorOptions`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `kind` | `MigrationErrorKind` | Yes | Stable machine-readable category. |
| `exitCode` | `MigrationExitCode` | Yes | Process exit class used by the command-line adapter. |
| `message` | `string` | Yes | Concise human-readable message; database URLs are redacted automatically. |
| `sensitiveDetail` | `string` | No | Sensitive SQL or provider detail that must never appear in normal output; it is accepted for caller intent and intentionally not retained on the error. |

---

### `RenameHint`

Explicit table or column rename supplied for one generation command; validated for syntax, existence, cardinality, and cycles before diffing.

| Property | Type | Description |
|----------|------|-------------|
| `kind` | `'table' \| 'column'` | Modeled object kind being renamed. |
| `from` | `string` | Fully qualified prior identity (for example `public.customer` or `public.customer.email`). |
| `to` | `string` | Fully qualified desired identity. |

```typescript fragment
const hints: readonly RenameHint[] = [
  { kind: 'table', from: 'public.customer', to: 'public.account' },
  { kind: 'column', from: 'public.customer.email', to: 'public.account.email_address' },
];
```

---

### `SchemaChange`

One bounded semantic change consumed by the migration renderer.

| Property | Type | Description |
|----------|------|-------------|
| `kind` | see the kinds table below | Stable object-specific change discriminator. |
| `safety` | `MigrationSafety` | Required operator-safety classification. |
| `schema` | `string` | Schema identity, when applicable. |
| `table` | `string` | Table identity, when applicable. |
| `name` | `string` | Prior or added object name. |
| `newName` | `string` | Approved rename target. |
| `tableState` | `TableState` | Complete table definition for table creation. |
| `columnState` | `ColumnState` | Complete column definition for column operations. |
| `previousColumnState` | `ColumnState` | Complete prior column definition for transitions. |
| `viewState` | `ViewState` | Complete view definition for view operations. |
| `definition` | `Readonly<Record<string, unknown>>` | Constraint or index data copied from the canonical snapshot. |
| `guidance` | `string` | Human-readable reason when automatic SQL is intentionally blocked. |

`TableState`, `ColumnState`, and `ViewState` are canonical snapshot DTOs; they are not re-exported from the package root.

| `kind` | Meaning |
|--------|---------|
| `extension.add`, `extension.drop` | Extension added to / removed from the desired state. |
| `schema.add`, `schema.drop` | Non-default schema added / removed. |
| `table.add`, `table.drop`, `table.rename` | Table created, removed, or renamed. |
| `column.add`, `column.drop`, `column.rename` | Column created, removed, or renamed. |
| `column.type` | Column type (or size/scale) changed; requires manual SQL with a `USING` expression. |
| `column.generated` | Generated-column expression changed; requires manual SQL. |
| `column.identity` | Identity mode or options changed; requires manual SQL. |
| `column.default` | Default expression changed. |
| `column.nullability` | Nullability changed. |
| `constraint.add`, `constraint.drop` | Primary key, unique, check, or foreign key added / removed. |
| `index.add`, `index.drop` | Index created / removed. |
| `comment.set` | Comment set or cleared on a table, column, view, or materialized view. |
| `view.add`, `view.drop`, `view.replace` | View created, removed, or changed. |

### `SchemaDiffResult`

| Property | Type | Description |
|----------|------|-------------|
| `changes` | `readonly SchemaChange[]` | Deterministically ordered modeled changes. |
| `summary` | `Readonly<Record<MigrationSafety, number>>` | Count of changes in each safety class. |

---

*All signatures in this reference are derived from the package source and match the public exports of `src/index.ts`.*

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
