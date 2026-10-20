> **Package**: `blendsdk/codegen`

# codegen Core Concepts

This document is the deep dive into every major abstraction `blendsdk/codegen` exposes. Each concept follows the same shape: what it is, how it works, a complete example, and a reference table of its public methods and properties. For the package tour, see the Overview; for installation and a first end-to-end run, see Basic Usage.

| Concept | Work type | Primary exports |
| --- | --- | --- |
| Data-shape modeling | Authoring | `SchemaContainer`, `SchemaScope` |
| TypeScript type generation | Generating | `TypeGenerator` |
| Zod validation generation | Generating | `ZodGenerator` |
| Relation constant generation | Generating | `CTypeGenerator` |
| PostgreSQL schema modeling | Authoring | `DatabaseSchema`, `TableSchema`, `TableColumnSchema`, `IndexConstraint` |
| Bootstrap DDL (initializer) | Generating | `PostgreSQLSchemaGenerator` |
| Catalog introspection | Reading | `PostgreSQLIntrospector` |
| OpenAPI document generation | Generating | `OpenAPIGenerator` |
| API contract configuration | Configuring | `defineApiContract` |
| Typed API client generation | Generating / checking | `generateClient`, `checkClient` |
| Migration configuration | Configuring | `defineMigrationConfig` |
| Incremental migration generation | Generating | `generateMigration` |
| Baseline generation and adoption | Generating / recording | `generateBaseline`, `adoptBaseline` |
| Migration execution and status | Executing | `runMigrations`, `getMigrationStatus`, `validateMigrations` |
| Sanitized failures | Reporting | `MigrationError`, `formatMigrationError` |

---

## 1. Schema Modeling with `SchemaContainer` and `SchemaScope`

### What It Is

`SchemaContainer` and `SchemaScope` are the authoring model for **data shapes** — the objects, primitives, enums, and references that the TypeScript and Zod generators consume. They are plain in-memory builder objects: no file I/O, no database, no rendering. A shape is authored fluently, named, and then handed to a generator (see concepts 2–4).

### How It Works

The container is a registry; the scope is a factory over that registry.

- `SchemaContainer` keeps schema objects in creation order and indexes them by `scope + name`. Registering the same identity twice throws `Schema object already exists <scope>.<name>` — the identity is the pair, so `api_v1.user_request` and `api_v2.user_request` coexist.
- A `SchemaScope` (created with `container.scope(name?)`) creates one concrete schema class per call — `scope.string()` returns a `StringSchema`, `scope.object({...})` returns an `ObjectSchema` — applies the scope, registers it with the container, and returns it.
- `named(value)` is what gives an object an identity; `scope(value)` attaches a namespace. Until an object is named, it exists only to be used inline as a property.
- `ObjectSchema.properties(props)` tags every child with a `parent`. Generators refuse to render a *named* object that has a parent: a property cannot also be a root declaration, so a shared shape must be named at the root and pulled in with `scope.ref(shape)` wherever it is needed.
- Modifiers accumulate on the object and are interpreted by each generator in its own syntax: `optional()` → `?` in TypeScript and `.optional()` in Zod, `nullable()` → `| null` and `.nullable()`, `arrayed()` → `T[]`, `partial()` → `Partial<T>` / `.partial()`, `recordSet()` → `Record<string, T>`.

### Complete Example

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();

// One shared, named shape per scope.
const catalog = schema.scope('catalog');
const status = catalog.string().named('product_status').enum(['draft', 'published']);

const product = catalog
  .object({
    id: catalog.number(),
    name: catalog.string(),
    status: catalog.ref(status),
    nickname: catalog.string().nullable().optional(),
    tags: catalog.string().arrayed(),
  })
  .named('product');

// A second scope reuses the same shape identity without colliding.
const storefront = schema.scope('storefront');
storefront
  .object({
    featured: catalog.ref(product).arrayed(),
    total: catalog.number(),
  })
  .named('product_page');

const source: string = await new TypeGenerator().generate(schema);

console.log(schema.getAll().length); // 7 objects created through the container
console.log(schema.find('catalog', 'product') === product); // true
console.log(source);
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `scope` | `(name?: string) => SchemaScope` | Creates a factory whose objects are registered under `name`. |
| `find` | `(scope: string, name: string) => SchemaObject \| undefined` | Returns the object registered under the exact `scope + name` identity. |
| `getAll` | `() => SchemaObject[]` | Every object created through the container, in creation order. Generators walk this list. |
| `clear` | `() => this` | Empties both the object list and the name index. |
| `add` | `(obj: SchemaObject) => void` | Registers an object with the container. Called by every scope factory and by introspection. |
| `assert` | `(name: string, scope?: string) => void` | Throws when `scope + name` is already registered. Called by `named()`, `scope()`, and `add()`. |

| Name | Signature | Description |
| --- | --- | --- |
| `string` | `() => StringSchema` | Creates and registers a string schema. Supports `.enum([...])`. |
| `number` | `() => NumberSchema` | Creates and registers a number schema. Supports `.enum([...])`. |
| `bigint` | `() => BigIntSchema` | Creates a bigint schema (`BigInt` in TypeScript, `number` in Zod). |
| `boolean` | `() => BooleanSchema` | Creates and registers a boolean schema. |
| `date` | `() => DateSchema` | Creates a date schema (`Date` in TypeScript, `z.date()` in Zod). |
| `any` | `() => AnySchema` | Creates an untyped schema (`any` in TypeScript, `z.any()` in Zod). |
| `object` | `(properties: ObjectProps) => ObjectSchema` | Creates an object schema and marks every property as a child of it. |
| `ref` | `(obj: SchemaObject) => ReferenceSchema` | Creates a reference to an already authored shape. |
| `find` | `(name: string) => SchemaObject \| undefined` | Looks up an object in this scope only. |

| Name | Signature | Description |
| --- | --- | --- |
| `named` | `(value: string) => this` | Gives the object an identity; registers it and rejects duplicates. |
| `scope` | `(value?: string) => this` | Sets (or moves) the object's namespace. |
| `optional` | `() => this` | Marks the property optional. |
| `nullable` | `() => this` | Marks the value nullable. |
| `arrayed` | `() => this` | Wraps the value in an array. |
| `partial` | `() => this` | Renders the referenced/object type as `Partial<T>`. |
| `recordSet` | `() => this` | Renders the value as `Record<string, T>`. |
| `enum` | `(values: string[] \| number[]) => this` | Primitive schemas only: renders a literal union. |
| `description` | `(text: string \| string[], prefix?: boolean) => this` | Appends (or prepends) JSDoc text. |
| `metadata` | `(data: Record<string, unknown>) => void` | Attaches opaque metadata; introspection stores the raw catalog row here. |
| `getName` / `getScope` / `getNamedScoped` | `() => string \| undefined` / `() => string` | Identity accessors used by generators. |

---

## 2. TypeScript Type Generation with `TypeGenerator`

### What It Is

`TypeGenerator` turns a `SchemaContainer` into a single Prettier-formatted TypeScript source string containing interfaces and type aliases. It is the "types" half of the data-shape pipeline; `ZodGenerator` (concept 3) is the "validation" half.

### How It Works

- `generate(container)` resets every object's render flag, then walks the container in creation order. Only objects that have a name and no parent become declarations; everything else is rendered inline where it is referenced.
- Plain root objects render as `export interface Name { ... }`. Objects with modifiers (`partial`, `arrayed`, `nullable`) and root primitives render as `export type Name = ...`, because interfaces cannot express those wrappers.
- References resolve to the **already rendered** type alias: the naming pass renders a referenced root object first and stores its type name on the schema, so `ref` properties emit `OrderStatus`, never an inline duplicate.
- Modifier composition order inside a type expression is fixed: `Partial<T>` first, then `T[]`, then `Record<string, T>`, then `T | null`.
- Every declaration and property is preceded by a JSDoc block; `@type`, `@interface`, `@optional`, `@nullable`, `@array`, `@partial`, and `@memberOf {Parent}` are added automatically, and `description()` text is merged in (multi-line comments are wrapped).
- The joined source is passed through Prettier with `parser: 'typescript'`, so output is deterministic and stable across runs — the same container always produces the same bytes.

### Complete Example

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

const status = scope.string().named('order_status').enum(['pending', 'shipped']);

scope
  .object({
    id: scope.number(),
    status: scope.ref(status).description('Fulfilment state'),
    note: scope.string().nullable().optional(),
    lines: scope.number().arrayed(),
  })
  .named('order');

const source: string = await new TypeGenerator().generate(schema);

console.log(source);
```

The declarations in the generated file have this shape (each is preceded by a JSDoc block):

```typescript fragment
export type OrderStatus = 'pending' | 'shipped';

export interface Order {
  id: number;
  status: OrderStatus;
  note?: string | null;
  lines: number[];
}
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `constructor` | `(options?: TypeGeneratorOptions) => TypeGenerator` | `TypeGeneratorOptions` is reserved for future use; pass nothing today. |
| `generate` | `(container: SchemaContainer) => Promise<string>` | Walks the container and resolves with the Prettier-formatted TypeScript source. |

Output rules worth knowing:

| Situation | Emitted declaration |
| --- | --- |
| Root object, no modifiers | `export interface Name { ... }` |
| Root object with `partial()` / `arrayed()` / `nullable()` | `export type Name = Partial<...>[] ...` |
| Root primitive or enum | `export type Name = string;` / `export type Name = 'a' \| 'b';` |
| Reference in a property | The referenced type name (never an inline copy) |
| Property modifiers | `?`, `[]`, `Partial<>`, `Record<string,>`, `\| null`, composed in that fixed order |

---

## 3. Zod Validation Generation with `ZodGenerator`

### What It Is

`ZodGenerator` renders the same `SchemaContainer` as a **Zod v4 schema module** — one `export const <Name>Schema = z...` per named shape — so a single authored model can drive both compile-time types and runtime validation.

### How It Works

- The generated file begins with `import * as z from 'zod';`, so the output module requires `zod` wherever it is compiled or executed.
- Variable names are derived from the object's scoped name plus a configurable postfix (default `schema`): `order_status` → `OrderStatusSchema`, `catalog.product` → `CatalogProductSchema`.
- Primitives map through their `zodType`: `z.string()`, `z.number()`, `z.boolean()`, `z.date()`, `z.any()`.
- Objects render as `z.object({ prop: <inner>, ... })`; nested objects become inline `z.object(...)` values, and references reuse the referenced variable name, so a shared shape is emitted once and referenced everywhere.
- Modifier order is fixed by the generator, not by call order: `.partial()`, then `.optional()`, then `.nullable()`.
- The result is formatted through Prettier with `parser: 'typescript'`, keeping output byte-stable.

### Complete Example

```typescript
import { SchemaContainer, ZodGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

scope
  .object({
    id: scope.number(),
    email: scope.string(),
    nickname: scope.string().optional().nullable(),
  })
  .named('user');

const generator = new ZodGenerator({ zodVariablePostfix: 'schema' });
const source: string = await generator.generate(schema);

console.log(source);
```

Generated source (declarations shown as emitted):

```typescript fragment
import * as z from 'zod';

export const UserSchema = z.object({
  id: z.number(),
  email: z.string(),
  nickname: z.string().optional().nullable(),
});
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `constructor` | `(options?: ZodGeneratorOptions) => ZodGenerator` | `ZodGeneratorOptions` adds `zodVariablePostfix` (default `'schema'`). |
| `generate` | `(container: SchemaContainer) => Promise<string>` | Resolves with the Prettier-formatted Zod module, including the `zod` import. |

---

## 4. Relation Constant Generation with `CTypeGenerator`

### What It Is

`CTypeGenerator` renders a **constant map per relation** — `export const e<Relation> = { $TABLE: '...', COLUMN: 'column' }` — from the `ConstantType` shape produced by introspection. It exists so generated query code and templates can reference table and column names without string literals.

### How It Works

- The input is a `ConstantType`: a record whose keys are qualified relation names (`customer`, `inventory.item` for non-default scopes) and whose values are column-name lists.
- Each entry becomes one exported constant whose name is the relation name converted to PascalCase and prefixed with `e`; keys are uppercased column names, plus a `$TABLE` entry carrying the relation name itself.
- A JSDoc block (`Constant type for relation <name>`, `@export`, `@constant`) precedes each constant, and the file is Prettier-formatted.
- Pair it with `PostgreSQLIntrospector.introstectConstantTypes()` (concept 7) to derive the map from a live catalog, or build the record by hand.

### Complete Example

```typescript
import { CTypeGenerator, type ConstantType } from 'blendsdk/codegen';

const constants: ConstantType = {
  customer: ['id', 'email', 'display_name'],
  'inventory.item': ['sku', 'quantity'],
};

const source: string = await new CTypeGenerator().generate(constants);

console.log(source);
```

Generated source (declarations shown as emitted):

```typescript fragment
/**
 * Constant type for relation customer
 * @export
 * @constant
 */
export const eCustomer = {
  $TABLE: 'customer',
  ID: 'id',
  EMAIL: 'email',
  DISPLAY_NAME: 'display_name',
};

/**
 * Constant type for relation inventory.item
 * @export
 * @constant
 */
export const eInventoryItem = {
  $TABLE: 'inventory.item',
  SKU: 'sku',
  QUANTITY: 'quantity',
};
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `generate` | `(ctypes: ConstantType) => Promise<string>` | Renders one exported constant per relation and resolves with the Prettier-formatted source. |

`ConstantType` itself is `{ [relationName: string]: string[] }` — the record returned by `PostgreSQLIntrospector.introstectConstantTypes()`.

---

## 5. PostgreSQL Schema Modeling with `DatabaseSchema`

### What It Is

`DatabaseSchema` (with `TableSchema`, `TableColumnSchema`, and `IndexConstraint`) is the authoring model for a **desired PostgreSQL schema**: tables, columns, defaults, identity and generated columns, comments, primary/unique/check/foreign-key constraints, indexes, extensions, and regular or materialized views. It is consumed by three different consumers — the bootstrap DDL generator (concept 6), the migration differ (concept 12), and the baseline/adoption flow (concept 13).

### How It Works

- `new DatabaseSchema(name, defaultScope?)` creates the root. `defaultScope` defaults to `public`; every table and view created through the schema is scoped to it unless `scope()` overrides it, and `getName()` returns the qualified `schema.table` form.
- `table(name, builder?)` creates a `TableSchema`, applies the default scope, runs the optional builder, and registers it. `view(name)` creates a view definition whose `as(source)` holds developer-authored SQL verbatim.
- Column helpers on `TableSchema` return a `TableColumnSchema`, so column traits chain: `table.varchar('email', 255).unique().comment('...')`. Precision and scale are passed to the helper (`numeric('total', 12, 2)`); the standalone `size()` and `scale()` setters return `void`.
- Constraints are **owned by the table**, not the column. `column.primaryKey()`, `column.unique()`, `column.check(rule)`, and `column.references(table, column, onUpdate?, onDelete?)` register a constraint on the owning table and return the column for chaining.
- Indexes are authored through `table.index()`, which returns an `IndexConstraint` supporting expressions, `INCLUDE` columns, storage parameters, tablespaces, partial predicates (`where`), uniqueness, and concurrent creation.
- A column can carry at most one of `default`, `identity`, or `generated` — `identity()` clears the default and refuses to combine with `generated()`, and `generated(expr, 'VIRTUAL')` throws because PostgreSQL only supports stored generated columns.
- `identity()` on a `uuid` column switches semantics: it installs a UUID default (`gen_random_uuid()` by default, `uuid_generate_v4()`/`uuid_generate_v7()` for `'v4'`/`'v7'`, or a custom function name) and adds the matching extension.

### Complete Example

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('shop');

schema.extension('pgcrypto');

const customer = schema.table('customer', table => {
  table.serial('id').primaryKey();
  table.varchar('email', 255).unique();
  table.text('display_name').nullable().comment('Shown in the storefront');
  table.timestamptz('created_at').default('now()');
});

schema.table('invoice', table => {
  table.uuid('id').identity('ALWAYS');
  table.bigint('customer_id').references(customer, 'id', undefined, 'CASCADE');
  table.numeric('total', 12, 2);
  table.checkConstraint('total >= 0');
  table.index().indexName('invoice_customer_idx').column('customer_id').where('total > 0');
});

schema
  .view('invoice_summary')
  .as('SELECT customer_id, sum(total) AS total FROM invoice GROUP BY customer_id')
  .materialized(true)
  .comment('Per-customer totals');

console.log(schema.getDefaultSchema()); // 'public'
console.log(schema.getExtensions()); // ['pgcrypto']
console.log(schema.getTables().map(table => table.getName())); // ['public.customer', 'public.invoice']
console.log(schema.getViews().map(view => view.getName())); // ['public.invoice_summary']
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `constructor` | `(name: string, defaultScope?: string) => DatabaseSchema` | `defaultScope` defaults to `'public'`. |
| `table` | `(name: string, builder?: (table: TableSchema) => void) => TableSchema` | Creates, scopes, optionally configures, and registers a table. |
| `view` | `(name: string) => ViewSchema` | Creates a view definition scoped to the default schema. |
| `extension` | `(...extension: string[]) => this` | Records required extensions (rendered as `CREATE EXTENSION IF NOT EXISTS`). |
| `getTables` / `getViews` / `getExtensions` / `getDefaultSchema` | `() => TableSchema[]` / `=> ViewSchema[]` / `=> string[]` / `=> string` | Accessors used by every consumer of the model. |
| `comment` | `(comment: string) => this` | Attaches a comment to the schema object itself. |

| Name | Signature | Description |
| --- | --- | --- |
| `integer`, `smallint`, `bigint`, `serial`, `bigserial` | `(name: string) => TableColumnSchema` | Integer-family columns. |
| `varchar`, `char`, `time`, `timestamp`, `timestamptz` | `(name: string, size?: number) => TableColumnSchema` | Sized string/date-time columns. |
| `decimal`, `numeric` | `(name: string, size?: number, scale?: number) => TableColumnSchema` | Precise numeric columns. |
| `real`, `doublePrecision`, `text`, `boolean`, `date`, `json`, `jsonb`, `uuid`, `vector`, `tsvector` | `(name: string) => TableColumnSchema` | Remaining supported column types. |
| `primaryKey` | `() => PrimaryKeyConstraint` | Returns the single table primary key, creating it on first access. |
| `getPrimaryKey` | `() => PrimaryKeyConstraint \| undefined` | Read-only accessor that never creates a constraint as a side effect. |
| `uniqueConstraint` / `checkConstraint` | `() => UniqueConstraint` / `(rule: string) => TableSchema` | Registers a unique or check constraint on the table. |
| `foreignKeyConstraint` | `(toTable: TableSchema) => ForeignKeyConstraint` | Registers a foreign key; `from(...)`/`to(...)` name the column pairs. |
| `index` | `() => IndexConstraint` | Registers and returns a new index definition. |
| `findColumn` / `getColumns` / `getName(scope?)` / `getScope` / `comment` | see source | Column lookup, column list, qualified name (`getName(false)` returns the unqualified name), and comments. |

| Name | Signature | Description |
| --- | --- | --- |
| `primaryKey` | `() => this` | Adds the primary key and a matching unique constraint, and forces `NOT NULL`. |
| `unique` | `() => this` | Adds a single-column unique constraint. |
| `check` | `(rule: string) => this` | Adds a table check constraint with this column's rule. |
| `references` | `(toTable: TableSchema, column: string, onUpdate?, onDelete?) => this` | Adds a foreign key; actions accept `'CASCADE'`, `'RESTRICT'`, `'SET NULL'`, `'SET DEFAULT'`, `'NO ACTION'`. |
| `default` | `(value: string \| number \| boolean \| undefined, quote?: boolean) => this` | Sets the column default; pass `quote: true` to wrap the value in single quotes. |
| `nullable` | `() => this` | Marks the column nullable (columns are rendered `NOT NULL` otherwise). |
| `comment` | `(comment: string) => this` | Attaches a column comment. |
| `identity` | `(generationOrFunction?: 'ALWAYS' \| 'BY DEFAULT' \| 'v4' \| 'v7' \| string, options?) => this` | Adds an identity column (integer types) or a UUID default (uuid type) with optional sequence options. |
| `generated` | `(expression: string, stored?: 'STORED' \| 'VIRTUAL') => this` | Adds a stored generated column; `'VIRTUAL'` throws. |
| `getType` / `getSize` / `getScale` / `getDefault` / `getNullable` | `() => ...` | Accessors used by the DDL and migration renderers. |
| `isIdentity` / `getIdentityGeneration` / `getIdentityOptions` / `isGenerated` / `getGeneratedExpression` / `isGeneratedStored` | `() => ...` | Identity and generated-column introspection. |

| Name | Signature | Description |
| --- | --- | --- |
| `column` | `(...column: string[]) => this` | Adds index key columns (inherited from the constraint base). |
| `unique` | `() => this` | Makes the index unique. |
| `indexName` | `(name: string) => this` | Sets an explicit index name; otherwise a deterministic name is derived. |
| `using` | `(method: 'btree' \| 'hash' \| 'gist' \| 'gin' \| 'brin' \| 'spgist' \| 'bloom') => this` | Selects the index method. |
| `expression` | `(expr: string) => this` | Indexes an expression instead of a column list. |
| `where` | `(condition: string) => this` | Adds a partial-index predicate. |
| `include` | `(...columns: string[]) => this` | Adds non-key `INCLUDE` columns. |
| `with` | `(params: Record<string, string \| number>) => this` | Sets storage parameters. |
| `tablespace` | `(name: string) => this` | Places the index in a tablespace. |
| `concurrent` | `() => this` | Marks the index for `CREATE INDEX CONCURRENTLY` (the migration runner then runs it outside a transaction). |

---

## 6. Bootstrap DDL with `PostgreSQLSchemaGenerator`

### What It Is

`PostgreSQLSchemaGenerator` renders a complete, re-runnable **initializer script** from an authored `DatabaseSchema`. It is the "create this database from scratch" path — the script you keep for local development, test databases, and new-project setups.

It is deliberately **not** part of the migration workflow. It never reads the canonical snapshot, never consults the applied-migration ledger, and never computes a difference: it re-creates the whole authored schema (dropping first, by default). Changing a database that is already under migration control is the job of `generateMigration` (concept 12); bringing a brand-new project under that control starts with `generateBaseline` (concept 13). Keeping the two apart is what keeps migration history honest.

### How It Works

- `generate(params?)` returns the combined script in a fixed order: extensions, schema/table drops (when enabled), schema creation, tables, constraints, comments, indexes, then views and view comments.
- `generateGrouped(params?)` returns the same content split into `schema`, `indexes`, and `views` groups (plus `all`), so a deploy script can run index and view statements separately.
- `dropBeforeCreate` defaults to `true`. Keep it for disposable databases; pass `false` when you want a script that only creates.
- Drops never use `CASCADE`; only object kinds the model owns are dropped, and non-default schemas are dropped before tables.
- Identifier quoting is the model's responsibility at this layer: the initializer renders `getName()` output as authored, while the migration renderer (which touches live objects) always double-quotes every identifier. Mismatched casing in authored names therefore surfaces here.

### Complete Example

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const schema = new DatabaseSchema('shop');

schema.table('customer', table => {
  table.serial('id').primaryKey();
  table.varchar('email', 255).unique();
});

const generator = new PostgreSQLSchemaGenerator(schema);

// Non-destructive grouping for a fresh database.
const grouped = generator.generateGrouped({ dropBeforeCreate: false });

console.log(grouped.schema); // extensions + schemas + tables + constraints + comments
console.log(grouped.indexes); // CREATE INDEX statements
console.log(grouped.views); // CREATE VIEW / CREATE MATERIALIZED VIEW statements
console.log(grouped.all.length === generator.generate({ dropBeforeCreate: false }).length); // true
```

The `schema` group for the model above starts with:

```sql
CREATE TABLE public.customer (
	id serial NOT NULL,
	email varchar(255) NOT NULL
);
```

followed by the `ALTER TABLE ... ADD CONSTRAINT` statements for the primary key, the unique constraints, and any foreign keys, and then `COMMENT ON` statements.

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `constructor` | `(db: DatabaseSchema) => PostgreSQLSchemaGenerator` | Binds the generator to one authored schema. |
| `generate` | `(params?: GenerateOptions) => string` | Returns the full initializer script (equivalent to `generateGrouped(...).all`). |
| `generateGrouped` | `(params?: GenerateOptions) => GeneratedDDL` | Returns `{ schema, indexes, views, all }` for staged execution. |

| Name | Type | Description |
| --- | --- | --- |
| `GenerateOptions.dropBeforeCreate` | `boolean \| undefined` | When `true` (the default), emits `DROP SCHEMA IF EXISTS` / `DROP TABLE IF EXISTS` before creation. |
| `GeneratedDDL.schema` | `string` | Extensions, schemas, tables, constraints, and comments. |
| `GeneratedDDL.indexes` | `string` | All `CREATE INDEX` statements. |
| `GeneratedDDL.views` | `string` | View drops/creations and view comments. |
| `GeneratedDDL.all` | `string` | The three groups concatenated. |

---

## 7. Read-Only Catalog Introspection with `PostgreSQLIntrospector`

### What It Is

`PostgreSQLIntrospector` reads an existing PostgreSQL catalog and **populates a `SchemaContainer`** so the type generators can emit TypeScript for a database that was not authored in TypeScript. It also produces the `ConstantType` record consumed by `CTypeGenerator`. Introspection is read-only: it issues a single catalog query and never mutates the database.

### How It Works

- One query (`INTROSPECTION_SQL`) returns a flat row per column, plus synthetic rows for enum labels, hand-created composite types, and domain types. Public-schema objects lose the `public` prefix so generated names stay short.
- `introspect(schema, mapper?)` first creates enum objects, then composite types, then tables and views. Table columns become properties of a named `ObjectSchema` per relation; nullable columns get `.nullable().optional()`; array columns get `.arrayed()`; computed/unsupported mappings get an `any` schema marked `@deprecated` with a console warning.
- Column metadata is preserved as descriptions and metadata: `@default`, `@primaryKey`, `@unique`, and `@checkContraint` (as spelled by the generator) are appended to the property description, and the raw `ColumnIntrospection` row is stored under `metadata.introspect` so downstream generators can read catalog facts.
- The optional `ColumnMapper` runs **before** the built-in mapping and receives `(row, scope)`. Returning a schema from the scope overrides the default mapping for that column; returning `undefined` falls through to the built-in table (arrays are still wrapped afterward).
- `introstectConstantTypes()` is the lightweight alternative: it returns `{ 'schema.relation': ['col', ...] }` for tables, views, materialized views, and partitioned tables, without touching a container. (The method name spelling is part of the public API.)

### Complete Example

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import {
  CTypeGenerator,
  PostgreSQLIntrospector,
  SchemaContainer,
  TypeGenerator,
} from 'blendsdk/codegen';

export async function generateFromCatalog(
  db: PostgreSQLDatabase
): Promise<{ types: string; constants: string }> {
  const introspector = new PostgreSQLIntrospector(db);

  const schema = new SchemaContainer();
  await introspector.introspect(schema, (column, scope) =>
    !column.is_array && column.pg_type === 'numeric'
      ? scope.string().description('Exact decimal transported as text')
      : undefined
  );

  const constants = await introspector.introstectConstantTypes();

  return {
    types: await new TypeGenerator().generate(schema),
    constants: await new CTypeGenerator().generate(constants),
  };
}
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `constructor` | `(db: PostgreSQLDatabase) => PostgreSQLIntrospector` | The database handle is supplied by the caller (`blendsdk/postgresql`). |
| `introspect` | `(schema: SchemaContainer, mapper?: ColumnMapper) => Promise<void>` | Populates the container with enums, composites, tables, and views read from the catalog. |
| `introstectConstantTypes` | `() => Promise<ConstantType>` | Returns the relation → column-name map used by `CTypeGenerator`. |

| Type | Signature | Description |
| --- | --- | --- |
| `ColumnMapper` | `(row: ColumnIntrospection, scope: SchemaScope) => SchemaObject \| unknown` | Per-column override hook; return a scope-built schema to replace the built-in mapping. |
| `ColumnIntrospection` | interface | The raw catalog row: relation and column identity, kind, nullability, default, PostgreSQL type, array element type, length/precision/scale, key/unique/foreign-key/check flags, enum labels, and comments. |
| `ForeignKeyInfo` / `CheckConstraintInfo` | interface | Structural detail attached to `fk_info` and `check_constraints` columns. |
| `ConstantType` | `{ [name: string]: string[] }` | Qualified relation name → column names. |

---

## 8. OpenAPI Document Generation with `OpenAPIGenerator`

### What It Is

`OpenAPIGenerator` collects route definitions from `blendsdk/webafx` controllers and assembles an **OpenAPI 3.1.0 document** (`OpenAPIDocument`). It is the producer side of the API contract; the client generator (concept 10) is the consumer side, and the `blendsdk.api.ts` contract (concept 9) wires both together.

### How It Works

- Collection is opt-in: `addRoutes()` and `addController()` keep only routes that carry `.openapi()` metadata. Routes without it are silently excluded, so internal endpoints never leak into the published contract.
- `addController(basePath, ControllerClass)` instantiates the controller with empty mock `settings`/`services` and calls `routes()`. That is safe because `routes()` only builds route definition objects.
- Paths are combined (`basePath` + route path), Express `:param` segments are converted to OpenAPI `{param}`, and every path parameter becomes a required `in: 'path'` parameter. For `GET`/`DELETE` routes the route's Zod validation schema is split into per-property `in: 'query'` parameters; `POST`/`PUT`/`PATCH` validation schemas become the JSON request body.
- Zod v4 schemas convert through the native `z.toJSONSchema` converter. `'input'` direction is used for requests and `'output'` for responses, so defaults and transforms resolve on the correct side of the wire. The draft-2020-12 `$schema` marker is stripped, nullable unions are folded into JSON Schema type arrays (`['string', 'null']`), and reusable `.meta({ id })` definitions are hoisted from `$defs` into `components.schemas` with `#/$defs/...` references rewritten.
- Each operation records how a client reads its success body via the `x-blend-envelope` extension: `'data'` (default, unwraps the top-level `data` property) or `'body'` (returns the whole body, which paginated responses need).
- `secure: true` routes receive the configured `defaultSecurity`; unsecured routes carry no `security` field.
- The document is deterministic: path keys, their method keys, and `components.schemas` are sorted, so regeneration produces identical bytes.

### Complete Example

```typescript
import { z } from 'zod';
import type { RouteDefinition } from 'blendsdk/webafx';
import { OpenAPIGenerator } from 'blendsdk/codegen';

class ProductsController {
  routes(): RouteDefinition[] {
    return [
      {
        method: 'get',
        path: '/:id',
        handler: () => undefined,
        openapi: {
          operationId: 'getProduct',
          summary: 'Read one product',
          tags: ['products'],
          responses: [
            {
              statusCode: 200,
              description: 'The requested product',
              schema: z.object({ id: z.string(), name: z.string() }),
            },
          ],
        },
      },
      {
        method: 'post',
        path: '/',
        handler: () => undefined,
        secure: true,
        validation: z.object({ name: z.string() }),
        openapi: {
          operationId: 'createProduct',
          summary: 'Create a product',
          tags: ['products'],
          responses: [{ statusCode: 201, description: 'Created' }],
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
console.log(JSON.stringify(document.info)); // { title: 'Shop API', version: '1.0.0' }
console.log(document.paths['/api/products'].post?.security); // [{ bearerAuth: [] }]

generator.toFile('./openapi.json');
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `constructor` | `(config: OpenAPIGeneratorConfig) => OpenAPIGenerator` | `title` and `version` are required; `description`, `servers`, `securitySchemes`, and `defaultSecurity` are optional. |
| `addController` | `(basePath: string, ControllerClass: ControllerConstructor) => this` | Instantiates a controller class, collects its annotated routes, and is chainable. |
| `addRoutes` | `(basePath: string, routeDefinitions: RouteDefinition[]) => this` | Collects annotated route definitions directly, without a controller class. |
| `generate` | `() => OpenAPIDocument` | Assembles and returns the OpenAPI 3.1 document (with hoisted component schemas). |
| `toJSON` | `(indent?: number) => string` | Returns the document as formatted JSON text; `indent` defaults to `2`. |
| `toFile` | `(filePath: string) => void` | Writes the document to disk, creating parent directories as needed. |

---

## 9. API Contract Configuration with `defineApiContract`

### What It Is

`defineApiContract` is the identity function that types a project's `blendsdk.api.ts` file. That file is the single declaration of where the generated client lives, which controllers make up the public API, and which OpenAPI metadata and generator flags apply. The `blendsdk api generate` / `blendsdk api check` commands load exactly this file.

### How It Works

- The contract is a default-exported object. `defineApiContract` provides inference and validation-friendly typing without changing the value at runtime.
- `controllers` lists controller classes with the base path each is mounted at. The CLI instantiates each class, collects only its annotated routes, and rebuilds the document — the same code path as `OpenAPIGenerator` (concept 8), so the contract cannot drift from what the generator would produce.
- `outputDir` is required; `contractFile` defaults to `api.json`. Both are resolved relative to the directory containing the config file, and a relative path that escapes that directory is rejected.
- `generator` carries the client-generation flags (`splitByGroup`, `strict`, `clientName`, `runtimeImport`) but not `outputDir`, which is declared at the top level.
- After loading and validation the CLI works with a `ResolvedApiContract`: the same settings with absolute `configPath`, `outputDir`, and `contractFile` paths.
- `blendsdk api generate` writes the contract JSON and the client; `blendsdk api check` rebuilds both in memory and exits `1` listing any drifted file. Neither command writes anything when the contract is invalid (exit `2`).

### Complete Example

The complete `blendsdk.api.ts` file:

```typescript
import type { RouteDefinition } from 'blendsdk/webafx';
import { defineApiContract } from 'blendsdk/codegen';

class ProductsController {
  routes(): RouteDefinition[] {
    return [
      {
        method: 'get',
        path: '/',
        handler: () => undefined,
        openapi: {
          operationId: 'listProducts',
          summary: 'List every product',
          tags: ['products'],
          responses: [{ statusCode: 200, description: 'All products' }],
        },
      },
    ];
  }
}

export default defineApiContract({
  outputDir: 'src/api-client',
  contractFile: 'api.json',
  controllers: [{ basePath: '/api/products', controller: ProductsController }],
  openapi: { title: 'Shop API', version: '1.0.0' },
  generator: { splitByGroup: true, clientName: 'ShopClient' },
});
```

With that file in place, the two CLI commands back the drift gate:

```bash
# Rebuild the contract JSON and the typed client.
blendsdk api generate

# Fail when either committed artifact differs from a fresh rebuild.
blendsdk api check
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `defineApiContract` | `(contract: ApiContract) => ApiContract` | Types and returns the contract unchanged. |

| Name | Type | Description |
| --- | --- | --- |
| `ApiContract.outputDir` | `string` | Required output directory for the generated client, resolved relative to the config file. |
| `ApiContract.contractFile` | `string \| undefined` | Committed OpenAPI JSON path; defaults to `api.json`. |
| `ApiContract.controllers` | `ApiContractController[]` | Controller registrations made of `{ basePath, controller }`. |
| `ApiContract.openapi` | `OpenAPIGeneratorConfig` | Document metadata, servers, security schemes, and default security. |
| `ApiContract.generator` | `Omit<ClientGeneratorOptions, 'outputDir'> \| undefined` | `splitByGroup`, `strict`, `clientName`, and `runtimeImport`. |
| `ResolvedApiContract` | interface | Validated contract with absolute `configPath`, `outputDir`, and `contractFile` paths. |

---

## 10. Typed API Client Generation with `generateClient` and `checkClient`

### What It Is

`generateClient` turns an `OpenAPIDocument` into a typed TypeScript client; `checkClient` regenerates that client in memory and reports drift against the committed files. Together they are the mechanism behind `blendsdk api generate` and `blendsdk api check`.

### How It Works

- **Stable input, stable output.** Paths, methods, component schemas, and per-operation aliases are all sorted before emission, and every file is normalized through Prettier, so the same document always produces the same bytes.
- **File set.** The generator writes `types.ts` (component aliases plus `<Operation>Params` / `<Operation>Result` aliases), `client.ts`, and `index.ts`. With `splitByGroup: true` it writes `client.<group>.ts` per group plus a `client.ts` barrel instead of a single client.
- **Marker-based ownership.** Every generated file starts with `// Generated by \`blendsdk api generate\` — do not edit by hand.` Pruning only removes files that carry the marker: hand-written files in the output directory are left untouched, and symlinks and special files are never read or deleted.
- **Naming.** A group comes from the first tag, else the first path segment after `/api`; a method name comes from `operationId`. Reserved words get a trailing underscore (`delete` → `delete_`), and an operation without an `operationId` gets a deterministic fallback (`productsGetById`). Duplicate `operationId`s — or two operations resolving to the same `<group>.<method>` — throw `ClientGenerationError` instead of silently overwriting a method.
- **Parameters.** Path parameters, query parameters, and the JSON request body are flattened into one params object; a `$ref` object body is merged into the params, while any other body becomes a single `body` property. Header and cookie parameters are ignored because the runtime owns them.
- **Results.** A `$ref` success schema resolves to the component type; an inline schema gets a named `<Operation>Result` alias; a missing 2xx schema yields `unknown`. With the `body` envelope the result alias is wrapped in `PaginatedResponse<...>` imported from the runtime.
- **Strictness split.** `generateClient` reports escalatable problems (missing `operationId`, missing 2xx schema) as warnings and fails only when `strict: true`; `checkClient` always escalates them to errors and sets `drifted: true`, so a contract defect fails CI as well as a stale file.

### Complete Example

```typescript
import { z } from 'zod';
import type { RouteDefinition } from 'blendsdk/webafx';
import {
  OpenAPIGenerator,
  checkClient,
  generateClient,
  type GenerationResult,
} from 'blendsdk/codegen';

class ProductsController {
  routes(): RouteDefinition[] {
    return [
      {
        method: 'get',
        path: '/',
        handler: () => undefined,
        openapi: {
          operationId: 'listProducts',
          summary: 'List every product',
          tags: ['products'],
          responses: [
            {
              statusCode: 200,
              description: 'All products',
              schema: z.array(z.object({ id: z.string(), name: z.string() })),
            },
          ],
        },
      },
    ];
  }
}

const document = new OpenAPIGenerator({ title: 'Shop API', version: '1.0.0' })
  .addController('/api/products', ProductsController)
  .generate();

const generated: GenerationResult = await generateClient(document, {
  outputDir: 'src/api-client',
  runtimeImport: 'blendsdk/api-client',
  clientName: 'ShopClient',
});

console.log(generated.files); // ['client.ts', 'index.ts', 'types.ts']

const drift: GenerationResult = await checkClient(document, {
  outputDir: 'src/api-client',
  runtimeImport: 'blendsdk/api-client',
  clientName: 'ShopClient',
});

if (drift.drifted) {
  console.error(`Out-of-date client files: ${(drift.driftedFiles ?? []).join(', ')}`);
}

for (const issue of drift.issues) {
  console.warn(`${issue.severity}: ${issue.message}`);
}
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `generateClient` | `(document: OpenAPIDocument, options: ClientGeneratorOptions) => Promise<GenerationResult>` | Writes the client files, prunes stale marker-bearing files, and resolves with the written names and issues. |
| `checkClient` | `(document: OpenAPIDocument, options: ClientGeneratorOptions) => Promise<GenerationResult>` | Regenerates in memory, compares with the committed files, and reports `drifted` / `driftedFiles` without writing. |
| `formatOpenApiDocument` | `(document: OpenAPIDocument) => Promise<string>` | Produces the byte-stable JSON text that `generate` writes and `check` compares. |
| `ClientGenerationError` | `class extends Error` | Thrown for duplicate `operationId`s or duplicate resolved method names, and when `strict` is set and the contract has an error. |

| Name | Type | Description |
| --- | --- | --- |
| `ClientGeneratorOptions.outputDir` | `string` | Output directory for generated files, resolved relative to the config file. |
| `ClientGeneratorOptions.splitByGroup` | `boolean \| undefined` | Emits one file per group plus a barrel instead of a single `client.ts`. |
| `ClientGeneratorOptions.strict` | `boolean \| undefined` | Escalates contract warnings to errors so generation fails instead of warning. |
| `ClientGeneratorOptions.clientName` | `string \| undefined` | Base name of the generated client type; defaults to `AppClient`. |
| `ClientGeneratorOptions.runtimeImport` | `string \| undefined` | Runtime module imported by generated clients; defaults to `blendsdk/api-client`. |
| `GenerationResult.files` | `string[]` | File names written (`generate`) or compared (`check`). |
| `GenerationResult.issues` | `ContractIssue[]` | Warnings and errors found while reading the contract. |
| `GenerationResult.drifted` / `driftedFiles` | `boolean \| undefined` / `string[] \| undefined` | Drift status and the offending file names, set by `checkClient`. |
| `ContractIssue` | `{ severity, message, operationId?, method?, path? }` | One contract problem, with `severity` of `'warning'` or `'error'`. |
| `GeneratedOperation` | interface | The resolved shape of one operation: `operationId`, `methodName`, `method`, `path`, `group`, `envelope`, `untypedResponse`. |

---

## 11. Migration Configuration with `defineMigrationConfig`

### What It Is

`defineMigrationConfig` types a project's `blendsdk.migrations.ts` file — the settings every `blendsdk migrate` command and every migration service call reads. It names the schema module, the artifact locations, the environment variable that holds the database URL, and the safety timeouts.

### How It Works

- The config is default-exported and loaded through the same on-disk TypeScript loader used for `blendsdk.api.ts`, with caching disabled so edits are always picked up. Discovery searches upward for `blendsdk.migrations.ts` from the working directory, and a `--config` file or directory overrides that.
- Relative artifact paths resolve against the config file's directory and may not escape it; absolute paths are trusted, but a filesystem root and any symbolic-link segment are rejected.
- The database URL is never part of the config — only the **name of the environment variable** that holds it. Secrets therefore cannot leak through a logged or serialized configuration, and the URL is read as late as possible by the operations that actually connect.
- The schema module is loaded only for commands that need modeled state (`generate`, `baseline`, `adopt-baseline`). Execution-only commands (`up`, `down`, `status`, `validate`) never import application code.
- Every field is validated against an allowlist: unknown keys, wrong types, out-of-range timeouts, and invalid environment-variable names are rejected as configuration errors (exit code `2`) before anything is written or connected.
- The resolved form — `ResolvedMigrationConfig` — carries absolute paths and the effective defaults, and is safe to log.

### Complete Example

The complete `blendsdk.migrations.ts` file:

```typescript
import { defineMigrationConfig } from 'blendsdk/codegen';

export default defineMigrationConfig({
  // Desired-state module; its default export must be a DatabaseSchema.
  schema: './src/database/schema.ts',
  migrationsDir: './migrations',
  snapshotFile: './migrations/schema.snapshot.json',
  // The URL itself lives in the environment, never in the repository.
  databaseUrlEnv: 'DATABASE_URL',
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 900_000,
});
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `defineMigrationConfig` | `<const Config extends MigrationConfig>(config: Config) => Config` | Types and returns the configuration unchanged. |

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `schema` | `string \| undefined` | — | Module whose default export is the desired `DatabaseSchema`; required for `generate`, `baseline`, and `adopt-baseline`. |
| `migrationsDir` | `string \| undefined` | `migrations` | Directory holding immutable `.up.sql` / `.down.sql` files. |
| `snapshotFile` | `string \| undefined` | `<migrationsDir>/schema.snapshot.json` | Canonical desired-state snapshot; must not use a migration SQL filename. |
| `databaseUrlEnv` | `string \| undefined` | `DATABASE_URL` | Uppercase environment-variable name holding the PostgreSQL URL. |
| `lockTimeoutMs` | `number \| undefined` | `5000` | Maximum wait for the migration advisory lock (1 – 300000). |
| `statementTimeoutMs` | `number \| undefined` | `900000` | Maximum execution time for one migration (1 – 86400000). |
| `ResolvedMigrationConfig` | interface | — | `configPath`, `configDirectory`, absolute `schema`, `migrationsDir`, `snapshotFile`, plus the effective environment name and timeouts. |

---

## 12. Incremental Migration Generation with `generateMigration`

### What It Is

`generateMigration` produces one **reviewable migration** for the difference between the committed canonical snapshot and the desired schema, and atomically publishes it together with the next snapshot. It is the incremental path: unchanged state yields `UP_TO_DATE` and writes nothing, and every change is classified before any SQL is rendered.

This is a different mechanism from the bootstrap initializer in concept 6: the initializer re-creates a whole schema and knows nothing about history, while `generateMigration` never renders a full schema — it renders only the targeted statements that move the committed snapshot to the desired one.

### How It Works

- The operation is **offline**: it loads the configured schema module and reads the committed snapshot, but never opens a database connection. Whether the live catalog matches is the runner's and `adoptBaseline`'s concern.
- `normalizeDatabaseSchema` projects the authored `DatabaseSchema` into a canonical, sorted, data-only snapshot. Normalization copies before sorting, never mutates the authoring model, and derives stable constraint and index names when the author omitted them.
- The semantic diff classifies every change: `safe` (targeted, mechanical), `caution` (blocks until staged manually, e.g. adding a required column), `destructive` (needs `allowDestructive`), `ambiguous` (needs an explicit rename hint), and `unsupported` (needs hand-written SQL, e.g. a type change or a view body change).
- Renames are never guessed silently: an apparent rename is reported as `ambiguous` until one-to-one `RenameHint`s are supplied, and the hints themselves are validated (exact `from`/`to` identities, one-to-one, acyclic, both identities must exist, and cross-schema renames are rejected).
- Non-blocked changes are rendered as deterministic, targeted SQL ordered by dependency phases; every identifier is double-quoted, and destructive statements are annotated with an approval comment. Nothing uses `CASCADE`.
- On success, the migration file and the replacement snapshot are written through a failure-safe publication: both are written and flushed to private files first, the immutable migration name is claimed exclusively, and a caught failure rolls the migration back and leaves the prior snapshot untouched.
- The published file carries the strict version-one header (`-- blendsdk-migration: 1`, `-- id:`, `-- transaction:`, `-- from-snapshot:`, `-- to-snapshot:`), and the result exposes the computed SHAs so the CLI and tests can verify lineage.

### Complete Example

```typescript
import { generateMigration, type SchemaChange } from 'blendsdk/codegen';

const result = await generateMigration({
  name: 'add-customer-status',
  renameHints: [
    { kind: 'column', from: 'public.customer.nickname', to: 'public.customer.display_name' },
  ],
  allowDestructive: false,
});

if (result.status === 'UP_TO_DATE') {
  console.log('The committed snapshot already matches the desired schema.');
} else {
  console.log(`Generated ${result.migration?.id}`);
  console.log(`from ${result.previousSnapshot} to ${result.desiredSnapshot}`);
}

for (const change of result.changes) {
  const location = [change.schema, change.table, change.name].filter(Boolean).join('.');
  console.log(`${change.safety.padEnd(12)} ${change.kind} ${location}`);
}

const blocked: SchemaChange | undefined = result.changes.find(
  change => change.safety === 'unsupported' || change.safety === 'ambiguous'
);

if (blocked) {
  console.warn(blocked.guidance ?? `Manual SQL required for ${blocked.kind}`);
}
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `generateMigration` | `(options: GenerateMigrationOptions) => Promise<GenerateMigrationResult>` | Diffs the committed snapshot against the desired schema and publishes one migration plus the next snapshot, or returns `UP_TO_DATE`. |

| Name | Type | Description |
| --- | --- | --- |
| `GenerateMigrationOptions.name` | `string` | Lowercase slug (`^[a-z][a-z0-9-]{0,62}$`) used in the migration filename. |
| `GenerateMigrationOptions.configPath` | `string \| undefined` | Explicit config file or discovery directory. |
| `GenerateMigrationOptions.renameHints` | `readonly RenameHint[] \| undefined` | Explicit one-to-one table/column renames; `{ kind, from, to }`. |
| `GenerateMigrationOptions.allowDestructive` | `boolean \| undefined` | Allows only changes the differ already classified as `destructive`. |
| `GenerateMigrationOptions.now` | `Date \| undefined` | Deterministic clock for the sortable migration identifier. |
| `GenerateMigrationResult.status` | `'GENERATED' \| 'UP_TO_DATE'` | Whether a pair was published or nothing changed. |
| `GenerateMigrationResult.migration` | `MigrationDescriptor \| undefined` | The published descriptor: `id`, `upPath`, `checksum`, `transactional`, and snapshot lineage. |
| `GenerateMigrationResult.previousSnapshot` / `desiredSnapshot` | `string` | SHA-256 hashes of the prior and new canonical snapshot bytes. |
| `GenerateMigrationResult.changes` | `readonly SchemaChange[]` | Complete reviewed change list (`kind`, `safety`, identities, and `guidance` when blocked). |
| `MigrationSafety` | `'safe' \| 'caution' \| 'destructive' \| 'ambiguous' \| 'unsupported'` | Classification attached to every change. |

---

## 13. Baseline Generation and Existing-Database Adoption

### What It Is

Two operations start or join a migration lineage:

- `generateBaseline` creates the **first immutable migration** of a brand-new project — the whole desired schema in one file, plus its canonical snapshot — offline, without touching a database.
- `adoptBaseline` records that same baseline against an **existing database** whose structure already matches, without executing the baseline SQL.

Both are distinct from the bootstrap initializer (concept 6) and from incremental generation (concept 12): a baseline is a real migration file that the normal runner applies exactly once; adoption writes only history.

### How It Works

`generateBaseline`:

- Requires that no snapshot and no `.up.sql` history exist; otherwise it fails as an invalid history and leaves every existing artifact byte-identical.
- Uses the same normalizer, renderer, and paired publication as incremental generation, so the header, checksum, transaction flag, and lineage are identical in form. The `from-snapshot` header is `none`; `to-snapshot` is the hash of the snapshot published with it.
- Never opens a database connection, so it runs in CI or a fresh checkout with no `DATABASE_URL`.

`adoptBaseline`:

- Requires exactly one locally valid baseline migration whose `to-snapshot` matches the current canonical snapshot bytes, both before and after acquiring the database lock (`Local baseline history changed during adoption` otherwise).
- Acquires the same database-scoped advisory lock the runner uses, applies the configured lock/statement timeouts, reads a sanitized target preview (host, port, user, database, baseline id), and offers it to `afterPreview` before any mutation.
- Then requires the exact `<database>/<baseline-id>` confirmation token, which is the operator's attestation that application and administrative DDL is quiesced. A mismatch is a configuration error (exit `2`) and nothing is recorded.
- Compares the desired snapshot with the live catalog by canonical object identity. Modeled differences are classified `MISSING`, `DIFFERENT`, or `EXTRA_MODELED`; unmodeled functions, triggers, enums, and domains are reported as `UNMANAGED` and preserved; anything the snapshot model cannot prove — raw SQL defaults, check or index expressions, view bodies, unsupported relation shapes, deferrable constraints, non-default indexes, drifted serial sequences, row-level security — is `UNSUPPORTED_FOR_ADOPTION` and blocks the operation.
- Repeats the comparison inside one `REPEATABLE READ` transaction, verifies the ledger is absent or empty, creates the ledger, inserts the baseline row, and commits. A preview followed by a concurrent catalog change therefore rolls back rather than recording a false baseline.

### Complete Example

Starting a brand-new project:

```typescript
import { generateBaseline } from 'blendsdk/codegen';

const baseline = await generateBaseline({ name: 'initial' });

console.log(baseline.status); // 'GENERATED'
console.log(baseline.migration?.id); // e.g. '20260827090000_initial'
console.log(baseline.snapshotHash);
console.log(baseline.changes.map(change => `${change.kind}`));

// The baseline is a normal migration: the runner applies it once.
```

Bringing an existing database under control:

```typescript
import { adoptBaseline } from 'blendsdk/codegen';

const adopted = await adoptBaseline(
  { confirmation: undefined },
  {
    afterPreview: preview => {
      console.log(
        `TARGET ${preview.user}@${preview.host}:${preview.port}/${preview.database} (${preview.baselineId})`
      );
      for (const item of preview.comparison) {
        console.log(`${item.classification} ${item.identity}`);
      }
      // Attest that application and administrative DDL is quiesced.
      return `${preview.database}/${preview.baselineId}`;
    },
  }
);

console.log(adopted.status); // 'ADOPTED'
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `generateBaseline` | `(options: GenerateBaselineOptions) => Promise<GenerateBaselineResult>` | Creates the first migration and snapshot offline; fails if any snapshot or up history exists. |
| `adoptBaseline` | `(options: AdoptBaselineOptions, dependencies?: AdoptBaselineDependencies) => Promise<AdoptBaselineResult>` | Proves structural equality and records the baseline in the ledger without running its SQL. |

| Name | Type | Description |
| --- | --- | --- |
| `GenerateBaselineOptions.name` / `.configPath` / `.now` | `string` / `string \| undefined` / `Date \| undefined` | Baseline slug, optional config location, optional deterministic clock. |
| `GenerateBaselineResult.status` | `'GENERATED'` | Terminal state of a successful baseline generation. |
| `GenerateBaselineResult.migration` | `MigrationDescriptor` | The single published initial migration. |
| `GenerateBaselineResult.snapshotHash` | `string` | SHA-256 of the published canonical snapshot bytes. |
| `GenerateBaselineResult.changes` | `readonly SchemaChange[]` | The complete desired-state additions rendered into the baseline. |
| `AdoptBaselineOptions.confirmation` | `string \| undefined` | Exact `<database>/<baseline-id>` token; `afterPreview` may return it instead. |
| `AdoptBaselineDependencies.afterPreview` | `(preview: AdoptionPreview) => string \| void \| Promise<string \| void>` | Displays the sanitized target preview and may collect the confirmation. |
| `AdoptionPreview` | interface | `host`, `port`, `user`, `database`, `baselineId`, and the `comparison` entries (`classification`, `identity`) — never a password or URL query value. |
| `AdoptBaselineResult.status` | `'ADOPTED'` | Returned only after the ledger row commits. |

---

## 14. Migration Execution, Status, and Sanitized Errors

### What It Is

`runMigrations` executes or observes migration history against PostgreSQL; `getMigrationStatus` and `validateMigrations` are the read-only and validation conveniences over the same code path. Every failure is a `MigrationError` with a stable `kind` and process exit class, rendered for operators with `formatMigrationError`.

### How It Works

- **One ordered prefix.** Local files are discovered, strictly parsed, checksummed, and lineage-verified; the applied ledger must be an exact prefix of that list. An edited applied file, a missing file, an inserted file, or a reordered pair all report `INVALID_HISTORY` before any SQL is sent.
- **One session, one lock.** A dedicated pool client takes a database-scoped advisory lock (`pg_try_advisory_lock` with a timeout), and the discovered history is re-verified after the lock wait so a file edited while waiting cannot be executed with stale metadata. Lock and statement timeouts are applied to the session, and the client is destroyed rather than returned to the pool if the session broke.
- **Transactional vs nontransactional.** Transactional migrations run inside a runner-owned transaction with their ledger insert, and roll back completely on failure. Nontransactional migrations first commit a durable `NONTRANSACTIONAL_DIRTY` marker, then execute; an interrupted outcome is reported as `UNKNOWN_OUTCOME` and requires operator investigation before anything else may run — the runner has no repair, force, or fake command.
- **Down is guarded.** `down` reverts exactly the latest applied migration, requires explicit `allowDown` confirmation, and requires that migration's `.down.sql` file.
- **Status values.** `runMigrations` and `getMigrationStatus` return a `MigrationStatus` plus the validated `MigrationDescriptor`s relevant to it. `validateMigrations({ offline: true })` proves local files and lineage without a database URL.
- **Typed, sanitized failures.** `MigrationError` carries `kind` and `exitCode`; its message is redacted at construction so a PostgreSQL URL or a `password=...` fragment cannot leak, and provider/SQL detail is never retained. `MigrationErrorKind` covers `CONFIGURATION`, `INVALID_HISTORY`, `FILESYSTEM`, `DATABASE`, `LOCKED`, `UNKNOWN_OUTCOME`, `UNSUPPORTED`, `ABORTED`, and `INTERNAL`; exit codes are `1` for operational failures and `2` for usage/configuration failures. The CLI maps these directly: `0` success, `1` operational or drift failure, `2` usage or configuration failure.

### Complete Example

```typescript
import {
  MigrationError,
  formatMigrationError,
  getMigrationStatus,
  runMigrations,
} from 'blendsdk/codegen';

try {
  const status = await getMigrationStatus();
  console.log(`Status: ${status.status}`); // UP_TO_DATE | PENDING | INVALID_HISTORY | LOCKED | UNKNOWN_OUTCOME

  if (status.status === 'PENDING') {
    const preview = await runMigrations({ command: 'up', dryRun: true });
    for (const migration of preview.migrations) {
      console.log(`Would apply ${migration.id}`);
    }

    const applied = await runMigrations({ command: 'up' });
    console.log(`Applied: ${applied.migrations.map(migration => migration.id).join(', ')}`);
  }
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(formatMigrationError(error));
    console.error(`kind=${error.kind} exitCode=${error.exitCode}`);
  } else {
    throw error;
  }
}
```

Constructing and formatting a failure without a database:

```typescript
import { MigrationError, formatMigrationError } from 'blendsdk/codegen';

const error = new MigrationError({
  kind: 'INVALID_HISTORY',
  exitCode: 1,
  message: 'Connection postgres://admin:super-secret@db.internal/app checksum mismatch.',
});

console.log(error.kind); // 'INVALID_HISTORY'
console.log(error.exitCode); // 1
console.log(formatMigrationError(error));
// 'INVALID_HISTORY: Connection [REDACTED_DATABASE_URL] checksum mismatch.'
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `runMigrations` | `(options: RunMigrationsOptions) => Promise<MigrationCommandResult>` | Runs `'up'`, `'down'`, `'status'`, or `'validate'` with cancellation, dry-run, and down-confirmation flags. |
| `getMigrationStatus` | `(options?: GetMigrationStatusOptions) => Promise<MigrationCommandResult>` | Reads history without mutating PostgreSQL. |
| `validateMigrations` | `(options?: ValidateMigrationsOptions) => Promise<MigrationCommandResult>` | Validates local (and, unless `offline`, live) history. |
| `formatMigrationError` | `(error: MigrationError) => string` | Renders `KIND: sanitized message` for operator output. |

| Name | Type | Description |
| --- | --- | --- |
| `RunMigrationsOptions.command` | `'up' \| 'down' \| 'status' \| 'validate'` | The operation to perform. |
| `RunMigrationsOptions.dryRun` | `boolean \| undefined` | Reports pending order while proving lock availability, without mutating the database. |
| `RunMigrationsOptions.allowDown` | `boolean \| undefined` | Required confirmation for `down`. |
| `RunMigrationsOptions.offline` | `boolean \| undefined` | `validate` only: skip the database even when the URL variable is set. |
| `RunMigrationsOptions.signal` | `AbortSignal \| undefined` | Caller-owned cancellation; the library installs no global handlers. |
| `MigrationCommandResult.status` | `MigrationStatus` | `'UP_TO_DATE' \| 'PENDING' \| 'INVALID_HISTORY' \| 'LOCKED' \| 'UNKNOWN_OUTCOME'`. |
| `MigrationCommandResult.migrations` | `readonly MigrationDescriptor[]` | The validated migrations relevant to the reported state. |
| `MigrationDescriptor` | interface | `id`, `upPath`, optional `downPath`, `checksum`, `downChecksum`, `transactional`, and snapshot lineage. |
| `MigrationError.kind` / `.exitCode` | `MigrationErrorKind` / `1 \| 2` | Stable machine-readable category and process exit class. |

---

Together these concepts cover the full `blendsdk/codegen` surface: author a model, generate deterministic artifacts from it, commit them, and gate them in CI (`checkClient`, `generateMigration`, `validateMigrations`) before executing anything against a database. For hands-on setup and a first run, continue with Basic Usage.

---

# codegen Basic Usage

This guide goes from install to a first working result for each pipeline the package provides: data-shape models, generated TypeScript and Zod schemas, PostgreSQL DDL, an OpenAPI 3.1 contract, a typed API client with a drift gate, and reviewable migrations.

---

## Installation

Requirements:

- **Node.js >= 22.0.0**
- **TypeScript in strict mode**, with ESM imports only — the package exposes a single `import` entry and no CommonJS build.

`blendsdk/codegen` is a private workspace package. It is distributed inside the assembled `blendsdk` package, which also provides the `blendsdk` executable (`blendsdk migrate ...`, `blendsdk api ...`).

```bash
# npm
npm install blendsdk

# yarn
yarn add blendsdk

# pnpm
pnpm add blendsdk
```

Two pieces are optional and installed only when you need them:

```bash
# The PostgreSQL driver, required by database-backed commands
# (up, down, status, validate, adopt-baseline) and by the introspector.
npm install pg

# The API client runtime that generated clients import
# (`blendsdk/api-client` by default; override with the `runtimeImport` option).
npm install blendsdk
```

Yarn and pnpm syntax is identical for both: `yarn add pg` / `pnpm add pg`.

Inside the BlendSDK repository, depend on the package directly instead: add `"blendsdk/codegen": "workspace:*"` to the consumer package's dependencies and run the workspace install.

```bash
pnpm install
```

Every example in this guide imports from the package entry point:

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';
```

---

## Quick Start

Model a shape and generate TypeScript from it:

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

scope.object({ id: scope.number(), name: scope.string() }).named('Product');

const source: string = await new TypeGenerator().generate(schema);

console.log(source);
```

The returned string is Prettier-formatted, deterministic TypeScript:

```typescript
export interface Product {
  id: number;
  name: string;
}
```

That is the whole pattern every pipeline in this package follows: **build a model, hand it to a generator, write or inspect the returned text**.

---

## Fundamentals

Each subsection below introduces one new concept, starting from an in-memory shape and ending with committed migration artifacts.

### Modeling a shape

A shape lives in a `SchemaContainer`, and a `SchemaScope` is the factory that creates and registers objects in it. Names must be unique per container: naming a second object `Product` throws instead of silently overwriting the first.

```typescript
import { SchemaContainer } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

const product = scope
  .object({
    id: scope.number(),
    name: scope.string(),
    tags: scope.string().arrayed(),
    nickname: scope.string().nullable().optional(),
  })
  .named('Product');

const status = scope.string().named('ProductStatus').enum(['draft', 'published', 'archived']);

const page = scope
  .object({
    items: scope.ref(product).arrayed(),
    status: scope.ref(status),
  })
  .named('ProductPage');
```

Key rules:

- Only **root** objects are named. A reusable shape is created once as a named root and attached elsewhere with `scope.ref(...)`; naming an object that is used as a property is rejected.
- Modifiers are chainable and compose: `.arrayed()`, `.nullable()`, `.optional()`, `.partial()`, and `.recordSet()`.
- `.enum([...])` on a string or number schema narrows the generated type to a literal union.

### Generating TypeScript types

`TypeGenerator` is the first consumer of that model. It renders interfaces for objects and type aliases for everything else, and it never mutates the model.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

const product = scope
  .object({
    id: scope.number(),
    name: scope.string(),
    tags: scope.string().arrayed(),
    nickname: scope.string().nullable().optional(),
  })
  .named('Product');

scope.object({ items: scope.ref(product).arrayed() }).named('ProductPage');

const source: string = await new TypeGenerator().generate(schema);

console.log(source);
```

Output (type structure only — see the note below):

```typescript
export interface Product {
  id: number;
  name: string;
  tags: string[];
  nickname?: string | null;
}

export interface ProductPage {
  items: Product[];
}
```

Modifiers map onto TypeScript predictably: `.arrayed()` becomes `T[]`, `.nullable()` adds `| null`, `.optional()` adds `?`, and `.partial()` wraps the type in `Partial<T>`.

> **Note:** generated declarations and members also carry JSDoc annotations — `@interface`, `@memberOf`, `@optional`, `@nullable`, `@array`, plus any text you set with `.description(...)`. The listings here show only the type structure.

### Generating Zod schemas

The same model drives runtime validation. `ZodGenerator` walks the identical container and emits Zod v4 schemas with matching `optional`, `nullable`, and `partial` modifiers, so types and validation can never disagree about the source shape.

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

Output:

```typescript
import * as z from 'zod';

export const ProductSchema = z.object({
  id: z.number(),
  name: z.string(),
  nickname: z.string().optional().nullable(),
});
```

The variable name is derived from the schema name plus a `Schema` postfix (`zodVariablePostfix` in `ZodGeneratorOptions`).

### Modeling a PostgreSQL schema and generating DDL

`DatabaseSchema` is the fluent model for PostgreSQL. Tables, columns, constraints, indexes, and views are declared with the same builder style, then rendered as SQL by `PostgreSQLSchemaGenerator`.

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';
import type { GeneratedDDL } from 'blendsdk/codegen';

const database = new DatabaseSchema('app');

const customer = database.table('customer');
customer.bigint('id').primaryKey();
customer.varchar('email', 255).unique();
customer.text('nickname').nullable();
customer.boolean('active').default(true);

const orders = database.table('orders');
orders.bigint('id').primaryKey();
orders.bigint('customer_id').references(customer, 'id');
orders.numeric('total', 10, 2);
orders.index().indexName('orders_customer_idx').column('customer_id');

const generated: GeneratedDDL = new PostgreSQLSchemaGenerator(database).generateGrouped({
  dropBeforeCreate: false,
});

console.log(generated.schema);
console.log(generated.indexes);
```

The `schema` group contains the create statements:

```sql
CREATE TABLE public.customer (
  id bigint NOT NULL,
  email varchar(255) NOT NULL,
  nickname text,
  active boolean NOT NULL DEFAULT true
);
```

…plus the `ALTER TABLE ... ADD CONSTRAINT` statements for the primary key, the unique constraint on `email`, and the `orders.customer_id → customer.id` foreign key.

The `indexes` group contains standalone indexes:

```sql
CREATE INDEX orders_customer_idx ON public.orders (customer_id);
```

Two behaviors worth knowing up front: columns are emitted `NOT NULL` unless you call `.nullable()`, and `.primaryKey()` also marks the column `NOT NULL`. `generateGrouped()` returns `{ schema, indexes, views, all }` so a bootstrap script can apply schema first and indexes second; `.generate()` returns the concatenation.

### Generating an OpenAPI 3.1 document

`OpenAPIGenerator` collects routes from controllers and produces an OpenAPI 3.1 document. It only collects routes that opted in with `.openapi()` metadata, so internal routes stay out of the contract. Zod schemas are converted natively, controller order does not affect output, and reusable named schemas are hoisted into `components.schemas`.

```typescript
import { OpenAPIGenerator } from 'blendsdk/codegen';
import type { OpenAPIDocument } from 'blendsdk/codegen';
import type { RouteDefinition } from 'blendsdk/webafx';
import { z } from 'zod';

const product = z.object({ id: z.number(), name: z.string() }).meta({ id: 'Product' });

class ProductsController {
  public routes(): RouteDefinition[] {
    return [
      {
        method: 'get',
        path: '/',
        handler: async () => undefined,
        validation: z.object({ limit: z.coerce.number().optional() }),
        openapi: {
          operationId: 'listProducts',
          tags: ['products'],
          summary: 'List products',
          responses: [
            {
              statusCode: 200,
              description: 'The product catalog',
              schema: z.array(product),
            },
          ],
        },
      },
    ];
  }
}

const generator = new OpenAPIGenerator({ title: 'Catalog API', version: '1.0.0' });
generator.addController('/api/products', ProductsController);

const document: OpenAPIDocument = generator.generate();
generator.toFile('api.json');
```

The resulting document contains `/api/products` with a `limit` query parameter (split from the route's `validation` schema), a `200` response whose items are `{ $ref: '#/components/schemas/Product' }`, and the hoisted `Product` schema under `components.schemas`. `toFile()` writes the JSON; `toJSON(indent?)` returns it as a string.

### Generating a typed client and checking for drift

`generateClient` turns that document into a typed client, and `checkClient` regenerates it in memory and reports differences — the CI gate that fails when a committed client is stale. Generation is deterministic and idempotent: only files carrying the generated marker are pruned, and hand-written files are never touched.

```typescript
import { readFile } from 'node:fs/promises';
import { checkClient, generateClient } from 'blendsdk/codegen';
import type { GenerationResult, OpenAPIDocument } from 'blendsdk/codegen';

const contractText: string = await readFile('api.json', 'utf8');
const document = JSON.parse(contractText) as OpenAPIDocument;

const generated: GenerationResult = await generateClient(document, {
  outputDir: 'src/api-client',
});

console.log(generated.files.join(', '));

for (const issue of generated.issues) {
  console.warn(`${issue.severity}: ${issue.message}`);
}

const drift: GenerationResult = await checkClient(document, { outputDir: 'src/api-client' });

if (drift.drifted) {
  console.error(`Stale generated files: ${(drift.driftedFiles ?? []).join(', ')}`);
  process.exitCode = 1;
}
```

A single-file run writes `types.ts`, `client.ts`, and `index.ts`. Set `splitByGroup: true` to write one `client.<group>.ts` per controller tag plus a barrel `client.ts`. Contract problems (a missing `operationId` or a missing 2xx schema) are reported as warnings by `generateClient` and become errors under `strict: true` — while `checkClient` always treats them as errors.

### Generating and applying migrations

Migrations are generated offline from the desired schema and applied with a guarded runner. The workflow needs one config file and one schema module.

```typescript
import { defineMigrationConfig } from 'blendsdk/codegen';

export default defineMigrationConfig({
  schema: './src/database/schema.ts',
  migrationsDir: './migrations',
  snapshotFile: './migrations/schema.snapshot.json',
});
```

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');
const customer = schema.table('customer');
customer.bigint('id').primaryKey();
customer.varchar('email', 255);

export default schema;
```

`generateMigration` diffs the schema against the committed snapshot and publishes a reviewed `*.up.sql` file together with the next `schema.snapshot.json`:

```typescript
import { generateMigration } from 'blendsdk/codegen';
import type { GenerateMigrationResult } from 'blendsdk/codegen';

const result: GenerateMigrationResult = await generateMigration({ name: 'add-customer-status' });

if (result.status === 'GENERATED' && result.migration) {
  console.log(`GENERATED ${result.migration.id}`);
  for (const change of result.changes) {
    console.log(`${change.safety} ${change.kind}`);
  }
} else {
  console.log('UP_TO_DATE');
}
```

Every change is classified as `safe`, `caution`, `destructive`, `ambiguous`, or `unsupported`. Ambiguous changes (an apparent rename) are never guessed — pass `renameHints: [{ kind: 'table', from: 'public.customer', to: 'public.account' }]` — and destructive changes need `allowDestructive: true` after review. Generation is all-or-nothing: nothing is written when a change cannot be rendered safely.

When a database is available, apply pending files and observe history with the same model:

```typescript
import { getMigrationStatus, runMigrations } from 'blendsdk/codegen';
import type { MigrationCommandResult } from 'blendsdk/codegen';

const status: MigrationCommandResult = await getMigrationStatus();
console.log(status.status);

await runMigrations({ command: 'up' });
```

`runMigrations` re-reads and re-verifies every file after acquiring a per-database advisory lock, runs transactional and nontransactional migrations through distinct paths, and records each result in `public.blendsdk_migrations`. It needs the `pg` driver and the connection URL in the configured environment variable (`DATABASE_URL` by default). For an existing database, `PostgreSQLIntrospector` fills a `SchemaContainer` from a live catalog so `TypeGenerator` can emit TypeScript for tables that were not authored with the schema model.

---

## Configuration

Generators take options at the call site. The two committed config files below let the CLI commands run without inline arguments; both are TypeScript files loaded through `jiti` with caching disabled, and both are searched upward from the working directory. Paths inside them must stay inside the config directory and must not contain symlinks.

### Client generator options

Passed to `generateClient` / `checkClient`, or under `generator` in `blendsdk.api.ts`.

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `outputDir` | `string` | — (required) | Where generated files are written. Relative paths resolve from the working directory (or from the contract file when read from `blendsdk.api.ts`). |
| `splitByGroup` | `boolean` | `false` | Write one `client.<group>.ts` per tag plus a `client.ts` barrel instead of a single `client.ts`. |
| `strict` | `boolean` | `false` | Escalate contract problems (missing `operationId`, missing 2xx schema) to errors. `checkClient` always escalates them. |
| `clientName` | `string` | `'AppClient'` | Base name of the generated client interface and its `create…` factory. |
| `runtimeImport` | `string` | `'blendsdk/api-client'` | Module specifier that generated files import the API client runtime from. |

### DDL generation options

Passed to `PostgreSQLSchemaGenerator.generateGrouped()` or `.generate()`.

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `dropBeforeCreate` | `boolean` | `true` | Prefix the script with `DROP SCHEMA ... CASCADE` and `DROP TABLE ... CASCADE` so it can be re-applied to an existing database. |

### Migration config (`blendsdk.migrations.ts`)

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `schema` | `string` | — | Module whose default export is the desired `DatabaseSchema`. Required by `generate`, `baseline`, and `adopt-baseline`. |
| `migrationsDir` | `string` | `'migrations'` | Directory holding immutable `.up.sql` / `.down.sql` files. |
| `snapshotFile` | `string` | `<migrationsDir>/schema.snapshot.json` | Committed canonical desired-state snapshot. |
| `databaseUrlEnv` | `string` | `'DATABASE_URL'` | Environment variable holding the PostgreSQL URL (uppercase name; never the URL itself). |
| `lockTimeoutMs` | `number` | `5000` | Maximum wait for the migration advisory lock; integer `1`–`300000`. |
| `statementTimeoutMs` | `number` | `900000` | Maximum execution time for one migration; integer `1`–`86400000`. |

### API contract (`blendsdk.api.ts`)

```typescript
import { defineApiContract } from 'blendsdk/codegen';
import { ProductsController } from './src/controllers/products.controller.js';

export default defineApiContract({
  outputDir: 'src/api-client',
  contractFile: 'api.json',
  controllers: [{ basePath: '/api/products', controller: ProductsController }],
  openapi: { title: 'Catalog API', version: '1.0.0' },
  generator: { splitByGroup: true },
});
```

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `outputDir` | `string` | — (required) | Client output directory, resolved relative to the contract file. |
| `contractFile` | `string` | `'api.json'` | Committed OpenAPI JSON that `generate` writes and `check` compares. |
| `controllers` | `ApiContractController[]` | — (required) | `{ basePath, controller }` registrations collected into the document. |
| `openapi` | `OpenAPIGeneratorConfig` | — (required) | Document metadata and security (see below). |
| `generator` | `Omit<ClientGeneratorOptions, 'outputDir'>` | — | Generator flags: `splitByGroup`, `strict`, `clientName`, `runtimeImport`. |

The `openapi` block accepts:

- `title` (required) and `version` (required) — document info.
- `description` — Markdown-enabled API description.
- `servers` — `{ url, description? }` entries.
- `securitySchemes` — `apiKey`, `http`, `oauth2`, or `openIdConnect` schemes.
- `defaultSecurity` — requirements applied to every route marked `secure: true`.

---

## Error Handling

The package separates two kinds of failure. **Expected failures** are typed errors that carry machine-readable categories; **contract problems** are reported as data (`issues`, `drifted`) whenever a run can continue. Modeling mistakes are plain `Error` instances, because they are programming errors rather than runtime conditions.

| Error | Thrown by | Meaning |
| --- | --- | --- |
| `ClientGenerationError` | `generateClient`, `checkClient` | The contract cannot produce a deterministic client — two operations share an `operationId` (or resolve to the same group/method name) — or `strict` is set and a contract problem is an error. The message names both offending HTTP method/path pairs. |
| `MigrationError` | migration functions | Configuration, history, filesystem, lock, database, or cancellation failure. Carries `kind` and `exitCode` (`1` operational, `2` usage/configuration); the message is sanitized at construction. |
| `Error` | `TypeGenerator.generate`, `ZodGenerator.generate`, `OpenAPIGenerator` | A modeling mistake (a named object used as a property, a reference to an unnamed schema) or a formatting/conversion failure. |

### Handling migration errors

Migration failures are sanitized: PostgreSQL URLs, credential assignments, and SQL bodies are redacted before they reach your output.

```typescript
import { formatMigrationError, generateMigration, MigrationError } from 'blendsdk/codegen';

try {
  const result = await generateMigration({ name: 'add-customer-status' });
  if (result.status === 'GENERATED' && result.migration) {
    console.log(`GENERATED ${result.migration.id}`);
  } else {
    console.log('UP_TO_DATE');
  }
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(formatMigrationError(error));
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}
```

Branch on `error.kind` when the caller must react differently:

| Kind | Meaning |
| --- | --- |
| `CONFIGURATION` | Config file missing or malformed, an option out of range (exit `2`), or a required confirmation missing. |
| `INVALID_HISTORY` | Migration files, snapshot lineage, or the applied ledger do not match (exit `1`). |
| `FILESYSTEM` | An artifact path is unsafe, a migration target already exists, or publication failed (exit `1`). |
| `DATABASE` | A PostgreSQL operation failed (exit `1`). |
| `LOCKED` | Another session holds the migration advisory lock (exit `1`). |
| `UNKNOWN_OUTCOME` | A nontransactional migration may or may not have applied; investigate before mutating again (exit `1`). |
| `UNSUPPORTED` | The requested change cannot be generated or executed safely (exit `1`). |
| `ABORTED` | The caller's `AbortSignal` cancelled the run (exit `1`). |
| `INTERNAL` | An internal invariant was violated (exit `1`). |

Observation commands do not throw for bad history: `getMigrationStatus()` and `validateMigrations()` return a `MigrationCommandResult` whose `status` is `UP_TO_DATE`, `PENDING`, `INVALID_HISTORY`, `LOCKED`, or `UNKNOWN_OUTCOME`.

### Handling contract errors

`generateClient` throws only when it must; everything else is reported in `GenerationResult.issues`:

```typescript
import { ClientGenerationError, generateClient } from 'blendsdk/codegen';
import type { OpenAPIDocument } from 'blendsdk/codegen';

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Catalog API', version: '1.0.0' },
  paths: {
    '/api/products': {
      get: {
        operationId: 'listProducts',
        tags: ['products'],
        responses: {
          '200': { description: 'The product catalog' },
        },
      },
    },
  },
};

// The missing 2xx schema is a warning, so generation still succeeds.
const report = await generateClient(document, { outputDir: 'src/api-client' });
for (const issue of report.issues) {
  console.warn(`${issue.severity}: ${issue.message}`);
}

// Under `strict`, the same problem is an error and nothing is written.
try {
  await generateClient(document, { outputDir: 'src/api-client', strict: true });
} catch (error) {
  if (error instanceof ClientGenerationError) {
    console.error(`The contract cannot be generated: ${error.message}`);
  } else {
    throw error;
  }
}
```

Modeling mistakes surface as plain errors from `generate()`:

```typescript fragment
// A named object cannot also be a property: name it at the root and attach it
// from other shapes with scope.ref(...).
const row = scope.object({ id: scope.string() }).named('Row');
scope.object({ row: scope.ref(row) }).named('RowHolder');
```

### Command-line exit codes

Both CLI surfaces return stable exit codes instead of exiting from library code:

| Exit code | Meaning |
| --- | --- |
| `0` | Success — artifacts written, no drift. |
| `1` | Drift or operational failure (invalid history, lock timeout, database error, unknown outcome). |
| `2` | Usage or configuration failure (unknown command, malformed option, invalid config file). |

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
