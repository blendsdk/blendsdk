> **Package**: `blendsdk/codegen`

# codegen Core Concepts

`blendsdk/codegen` is built from a small set of models that feed independent pipelines: data shapes produce TypeScript, Zod, const maps, and API documentation; a relational model produces PostgreSQL DDL and snapshots; and reviewed migrations drive the database lifecycle. This document explains each concept from the inside out — what it is, how the mechanism works, a complete example, and the members you will use most.

For the shortest end-to-end walkthrough, see Basic Usage; for the feature map, see Overview.

| Layer | Concepts covered below |
| --- | --- |
| Data shapes | `SchemaContainer`/`SchemaScope`, schema objects and modifiers, the generator pipeline, `TypeGenerator`, `ZodGenerator`, `CTypeGenerator` |
| API documentation | `OpenAPIGenerator`, Zod → OpenAPI conversion |
| Relational model | `DatabaseSchema`/`TableSchema`, `TableColumnSchema`, constraints and indexes, views, `PostgreSQLSchemaGenerator`, `PostgreSQLIntrospector` |
| Migrations | configuration, generation and snapshots, runner and ledger, baseline adoption, errors and statuses, the `blendsdk migrate` CLI |

---

## 1. SchemaContainer and SchemaScope

### What It Is

`SchemaContainer` is the root of the data-shape model, and `SchemaScope` is the namespace inside it that creates schema objects. One container describes one generation unit; scopes partition that unit so that identically named types in different scopes (`api_v1.user_request` and `api_v2.user_request`) generate collision-free declarations. Every data-shape generator consumes a `SchemaContainer`, and `PostgreSQLIntrospector` writes into one.

### How It Works

1. `new SchemaContainer()` creates an empty model.
2. `container.scope()` returns the default namespace; `container.scope('api_v1')` returns a named namespace.
3. The scope exposes factory methods — `string()`, `number()`, `boolean()`, `date()`, `any()`, `object(props)`, and `ref(target)` — that return schema objects.
4. Objects become top-level declarations only when they are `.named(...)`. A scoped name is converted to PascalCase and prefixed with the scope name: `scope('api_v1')` plus `.named('user_request')` becomes `ApiV1UserRequest` (or `ApiV1UserRequestSchema` for the Zod generator).
5. `container.getAll()` returns every object in creation order; generators render named roots and skip unnested, unnamed helpers.

### Complete Example

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const api = schema.scope('api_v1');

const user = api
  .object({
    id: api.number(),
    email: api.string(),
    displayName: api.string().optional(),
  })
  .named('user');

api
  .object({
    user: api.ref(user).nullable(),
    requestedAt: api.date(),
  })
  .named('user_request');

const source = await new TypeGenerator().generate(schema);
console.log(source);
```

The generated source contains two scoped declarations (`ApiV1User` and `ApiV1UserRequest`); the properties resolve through the reference instead of being inlined.

### Key Methods and Properties

| Member | Type / Signature | Description |
| --- | --- | --- |
| `SchemaContainer.scope(name?)` | `(name?: string) => SchemaScope` | Returns the namespace used to create objects; omit `name` for the default namespace |
| `SchemaContainer.getAll()` | `() => SchemaObject[]` | All objects in creation order — the input every data-shape generator walks |
| `SchemaContainer.find(scope, name)` | `(scope: string \| undefined, name: string) => SchemaObject \| undefined` | Looks up an already-created root object by scope and name |
| `SchemaContainer.clear()` | `() => void` | Removes all objects and scopes |
| `SchemaScope.string()` | `() => StringSchema` | String primitive |
| `SchemaScope.number()` | `() => NumberSchema` | Number primitive |
| `SchemaScope.boolean()` | `() => BooleanSchema` | Boolean primitive |
| `SchemaScope.date()` | `() => DateSchema` | Date primitive |
| `SchemaScope.any()` | `() => AnySchema` | Unconstrained value |
| `SchemaScope.object(properties)` | `(properties: Record<string, SchemaObject>) => ObjectSchema` | Object built from named properties created in the same scope |
| `SchemaScope.ref(target)` | `(target: SchemaObject) => ReferenceSchema` | Reference to another (usually named) object instead of a copy |

---

## 2. Schema Objects and Type Modifiers

### What It Is

A schema object is one unit of the data-shape model: a primitive, an object, a reference, or a primitive narrowed to enumeration values. Each object carries a name, an optional scope, a description, optional metadata, and modifier flags that every generator translates into its own dialect.

### How It Works

- `.named()` promotes an object to a declaration; unnamed objects may only appear as properties.
- Modifiers are applied in a fixed order by the TypeScript generator: `partial` → `arrayed` → `recordSet` → `nullable`. `optional` is not a type wrapper — it becomes the `?` marker on a property.
- `.enum([...])` narrows a string or number primitive into a literal union (`"up" | "down"` or `1 | 2 | 3`).
- `.description(text)` appends description and annotation lines that the type generator emits as JSDoc; the introspector uses this to attach facts such as `@primaryKey` and `@default`.
- `.metadata(data)` attaches non-rendered data. `PostgreSQLIntrospector` stores the raw catalog row under `metadata({ introspect: column })`.

### Complete Example

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

const row = scope
  .object({
    id: scope.number(),
    name: scope.string(),
  })
  .named('row');

const direction = scope.string().named('sort_direction').enum(['asc', 'desc']);

scope
  .object({
    rows: scope.ref(row).arrayed(),
    archive: scope.ref(row).partial().recordSet(),
    sort: scope.ref(direction),
  })
  .named('query_request');

const source = await new TypeGenerator().generate(schema);
console.log(source);
```

The generated declarations show the modifier pipeline:

```typescript fragment
export interface Row {
  id: number;
  name: string;
}

export type SortDirection = "asc" | "desc";

export interface QueryRequest {
  rows: Row[];
  archive: Record<string, Partial<Row>>;
  sort: SortDirection;
}
```

### Key Methods and Properties

| Member | Type / Signature | Description |
| --- | --- | --- |
| `.named(name)` | `(name: string) => this` | Promotes the object to a top-level declaration with a stable type name |
| `.description(text)` | `(text: string) => this` | Appends a description/annotation line; rendered as JSDoc by `TypeGenerator` |
| `.metadata(data)` | `(data: Record<string, unknown>) => this` | Attaches metadata that generators do not render (introspection stores the source row here) |
| `.optional()` | `() => this` | Property becomes `name?: T` and is excluded from `required` in generated Zod/OpenAPI output |
| `.nullable()` | `() => this` | Type becomes `T \| null`; Zod output gains `.nullable()` |
| `.arrayed()` | `() => this` | Type becomes `T[]` |
| `.partial()` | `() => this` | Type becomes `Partial<T>`; Zod output gains `.partial()` |
| `.recordSet()` | `() => this` | Type becomes `Record<string, T>` |
| `.enum(values)` | `(values: (string \| number)[]) => this` | Restricts a string or number primitive to a literal union |
| `.getName()` | `() => string \| undefined` | The object's own name, without scope |
| `.getScope()` | `() => string \| undefined` | The scope the object was created in |
| `.getNamedScoped()` | `() => string \| undefined` | Combined scoped identity used for generated names |
| `.getData()` / `.isRendered()` / `.reset()` | render state accessors | Used by custom traversal; `generate()` resets every object before rendering |

---

## 3. The Generator Pipeline

### What It Is

The generator pipeline is the contract shared by every generator that consumes a `SchemaContainer`: walk the container, render each named root exactly once, join the results, and return one Prettier-formatted TypeScript source string. `TypeGenerator` and `ZodGenerator` implement it; the other generators (`CTypeGenerator`, `PostgreSQLSchemaGenerator`, `OpenAPIGenerator`) accept different inputs and follow the same output discipline without extending the base class.

### How It Works

1. `generate(container)` collects `container.getAll()` and calls `.reset()` on every object, so each call starts from a clean render state (the same container can be rendered by several generators in sequence).
2. Objects without a name are skipped at the top level — they are rendered inline as properties.
3. Naming a nested property object is rejected: generation throws and tells you to create a separate named root and reference it with `.ref()`. This keeps one declaration per type instead of duplicating inline literals.
4. Rendering is dispatched by kind: objects, references, and primitives each have a dedicated rendering hook in each generator.
5. Rendered declarations are joined with blank lines, trimmed, and run through Prettier's TypeScript parser. If formatting fails, the unformatted source is logged and the original error is rethrown.

### Complete Example

```typescript
import { SchemaContainer, TypeGenerator, ZodGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

const user = scope
  .object({
    id: scope.number(),
    email: scope.string(),
    displayName: scope.string().optional(),
  })
  .named('user');

// Reference the named root — nesting a *named* property object is rejected.
scope
  .object({
    user: scope.ref(user),
    authenticated: scope.boolean(),
  })
  .named('session');

const types = await new TypeGenerator().generate(schema);
const validators = await new ZodGenerator().generate(schema);

console.log(types);
console.log(validators);
```

The same container, rendered by the Zod generator, produces:

```typescript fragment
import * as z from 'zod';

export const UserSchema = z.object({
  id: z.number(),
  email: z.string(),
  displayName: z.string().optional(),
});

export const SessionSchema = z.object({
  user: UserSchema,
  authenticated: z.boolean(),
});
```

### Key Members

| Member | Type / Signature | Description |
| --- | --- | --- |
| `generate(container)` | `(container: SchemaContainer) => Promise<string>` | Renders all named roots and returns Prettier-formatted TypeScript |
| `TypeGenerator` | class | Schema container → TypeScript interfaces and type aliases |
| `ZodGenerator` | class | Schema container → Zod v4 schema declarations |
| `CTypeGenerator` | class | `ConstantType` map → exported constant objects (separate input) |
| `PostgreSQLSchemaGenerator` | class | `DatabaseSchema` → PostgreSQL DDL (separate input) |
| `OpenAPIGenerator` | class | webafx route definitions → OpenAPI 3.1 document (separate input) |
| `defineApiContract` | function | Type-checks a `blendsdk.api.ts` contract naming controllers and output |
| `generateClient` / `checkClient` | function | OpenAPI 3.1 document → typed TypeScript client (separate input); `checkClient` reports drift against committed output |

---

## 4. TypeGenerator

### What It Is

`TypeGenerator` converts a schema container into exported TypeScript declarations: `interface` for plain root objects, `type` aliases for primitives, enums, references, and objects that carry structural modifiers.

### How It Works

1. Plain root objects (no `partial`, `arrayed`, or `nullable`) become `export interface Name { ... }`.
2. Root objects with structural modifiers become `export type Name = Partial<{ ... }>`, `Name[]`, or unions with `null`, applied in the order `partial` → `arrayed` → `recordSet` → `nullable`.
3. Nested objects are rendered inline as anonymous object types; properties keep their optional marker (`displayName?: string;`).
4. Enum values become literal unions: `export type SortDirection = "asc" | "desc";`.
5. References render as `export type X = Referenced;` at the root, or as the referenced type name (rendering the target first if necessary) when used as a property.
6. Descriptions and modifier state are emitted as JSDoc annotations (`@interface`, `@partial`, `@array`, `@optional`, `@nullable`, `@memberOf {Parent}`), and the final source is Prettier-formatted.

### Complete Example

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const api = schema.scope('api_v2');

const product = api
  .object({
    id: api.number(),
    name: api.string(),
    price: api.number(),
    discontinued: api.boolean().optional(),
  })
  .named('product');

api
  .object({
    items: api.ref(product).arrayed(),
    total: api.number(),
  })
  .named('product_page');

const generator = new TypeGenerator();
const source = await generator.generate(schema);

console.log(source);
```

Representative declarations from the output:

```typescript fragment
export interface ApiV2Product {
  id: number;
  name: string;
  price: number;
  discontinued?: boolean;
}

export interface ApiV2ProductPage {
  items: ApiV2Product[];
  total: number;
}
```

### Key Methods and Properties

| Member | Type / Signature | Description |
| --- | --- | --- |
| `new TypeGenerator(options?)` | `(options?: TypeGeneratorOptions) => TypeGenerator` | Creates the generator; options are reserved for future use |
| `generate(container)` | `(container: SchemaContainer) => Promise<string>` | Returns formatted TypeScript for all named roots |
| Declaration rule | plain root object | Emits `export interface` |
| Declaration rule | modified root object | Emits `export type` with `Partial<...>`, `T[]`, or `... \| null` |
| Declaration rule | primitive / enum | Emits `export type Name = string;` or a literal union |
| Declaration rule | reference | Emits `export type Name = Target;` at the root, `Target` inline as a property |

---

## 5. ZodGenerator

### What It Is

`ZodGenerator` emits Zod v4 validator declarations from the same schema model, keeping runtime validation in lockstep with generated TypeScript types. It is the generator that turns a `.optional()` property into `.optional()` in a validator and a `.ref()` into a validator reference.

### How It Works

1. The generated file starts with `import * as z from 'zod';`.
2. Each named root becomes `export const <PascalCase(name)><postfix> = ...`, where the postfix defaults to `schema` (so `user` becomes `UserSchema`).
3. Primitive schemas render as `z.<type>()` calls; objects render as `z.object({ property: <schema>, ... })`; references render as the referenced validator's variable name.
4. Modifiers are appended in the order `partial` → `optional` → `nullable`: `z.object({...}).partial()`, `z.string().optional()`, `AddressSchema.nullable()`.
5. The `zodVariablePostfix` option renames the suffix — for example `validator` produces `UserValidator`.

### Complete Example

```typescript
import { SchemaContainer, ZodGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

const address = scope
  .object({
    street: scope.string(),
    city: scope.string(),
    postalCode: scope.string().optional(),
  })
  .named('address');

scope
  .object({
    billing: scope.ref(address),
    shipping: scope.ref(address).nullable(),
    note: scope.string().optional(),
  })
  .named('checkout');

const validators = await new ZodGenerator({ zodVariablePostfix: 'validator' }).generate(schema);
console.log(validators);
```

The generated validators:

```typescript fragment
import * as z from 'zod';

export const AddressValidator = z.object({
  street: z.string(),
  city: z.string(),
  postalCode: z.string().optional(),
});

export const CheckoutValidator = z.object({
  billing: AddressValidator,
  shipping: AddressValidator.nullable(),
  note: z.string().optional(),
});
```

### Key Methods and Properties

| Member | Type / Signature | Description |
| --- | --- | --- |
| `new ZodGenerator(options?)` | `(options?: ZodGeneratorOptions) => ZodGenerator` | Creates the generator and seeds the `zod` import |
| `options.zodVariablePostfix` | `string` (default `'schema'`) | Suffix used when building validator variable names |
| `generate(container)` | `(container: SchemaContainer) => Promise<string>` | Returns formatted Zod v4 source for all named roots |
| `.partial()` mapping | schema object | Appends `.partial()` to the emitted validator |
| `.optional()` mapping | schema object | Appends `.optional()` to the emitted validator |
| `.nullable()` mapping | schema object | Appends `.nullable()` to the emitted validator |

---

## 6. CTypeGenerator

### What It Is

`CTypeGenerator` turns a `ConstantType` map — one entry per relation, each listing its column names — into exported constant objects. Query code uses these objects instead of hard-coded table and column strings.

### How It Works

1. `ConstantType` is a plain record: `{ [relation: string]: string[] }`. Keys may include a scope (`billing.invoices`).
2. For every relation, the generator emits `export const e<PascalCaseName> = { ... }`, where dots become underscores before case conversion: `billing.invoices` → `eBillingInvoices`.
3. Each object contains `$TABLE` with the relation key and one uppercase entry per column (`created_at` → `CREATED_AT`).
4. Every constant is preceded by a `Constant type for relation ...` JSDoc block, and the whole file is Prettier-formatted.
5. `PostgreSQLIntrospector.introstectConstantTypes()` (spelling as in the API) produces this map from a live database.

### Complete Example

```typescript
import { CTypeGenerator } from 'blendsdk/codegen';
import type { ConstantType } from 'blendsdk/codegen';

const constants: ConstantType = {
  users: ['id', 'email', 'created_at'],
  'billing.invoices': ['id', 'amount'],
};

const source = await new CTypeGenerator().generate(constants);
console.log(source);
```

Generated output:

```typescript fragment
/**
 * Constant type for relation users
 * @export
 * @constant
 */
export const eUsers = {
  $TABLE: 'users',
  ID: 'id',
  EMAIL: 'email',
  CREATED_AT: 'created_at',
};

/**
 * Constant type for relation billing.invoices
 * @export
 * @constant
 */
export const eBillingInvoices = {
  $TABLE: 'billing.invoices',
  ID: 'id',
  AMOUNT: 'amount',
};
```

### Key Methods and Properties

| Member | Type / Signature | Description |
| --- | --- | --- |
| `new CTypeGenerator()` | `() => CTypeGenerator` | Creates the generator |
| `generate(ctypes)` | `(ctypes: ConstantType) => Promise<string>` | Returns formatted constant declarations |
| `ConstantType` | `{ [relation: string]: string[] }` | Relation name → column names; produced by the introspector |
| Generated name | `e` + PascalCase | `billing.invoices` → `eBillingInvoices` |
| Generated members | `$TABLE` + uppercase columns | `$TABLE: 'billing.invoices'`, `CREATED_AT: 'created_at'` |

---

## 7. DatabaseSchema and TableSchema

### What It Is

`DatabaseSchema` is the desired-state relational model of a PostgreSQL database: schema scopes, extensions, tables, and views. `TableSchema` describes one table — its columns, constraints, indexes, comments, and scope.

### How It Works

1. `new DatabaseSchema(name, defaultScope?)` creates the model; `defaultScope` defaults to `public`.
2. `schema.extension(...names)` registers PostgreSQL extensions used by the model.
3. `schema.table(name, builder?)` creates a table in the default scope and returns it; `.scope('billing')` moves a table into another schema.
4. Typed column helpers (`bigint`, `varchar`, `text`, `timestamptz`, `jsonb`, ...) create a `TableColumnSchema`, push it into the table, and return it for chaining.
5. `table.getName()` returns the qualified `scope.name`; `table.getName(false)` returns the bare name. `getTables()`, `getViews()`, `getExtensions()`, and `getDefaultSchema()` expose the model to generators.

### Complete Example

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');

const users = schema.table('users');
users.bigint('id').primaryKey();
users.varchar('email', 255).unique();
users.text('display_name').nullable();

const invoices = schema.table('invoices').scope('billing').comment('Customer invoices');
invoices.bigint('id');
invoices.decimal('total', 12, 2);

for (const table of schema.getTables()) {
  const columns = table.getColumns().map(column => `${column.getName()} ${column.getType()}`);
  console.log(table.getName(), columns);
}
```

### Key Methods and Properties

| Member | Type / Signature | Description |
| --- | --- | --- |
| `new DatabaseSchema(name, defaultScope?)` | `(name: string, defaultScope?: string) => DatabaseSchema` | Creates the model; the default scope is `public` |
| `extension(...names)` | `(...names: string[]) => this` | Registers extensions; duplicates are collapsed at render time |
| `table(name, builder?)` | `(name: string, builder?: MakeTable) => TableSchema` | Creates and registers a table in the default scope |
| `view(name)` | `(name: string) => ViewSchema` | Creates and registers a view |
| `getTables()` / `getViews()` / `getExtensions()` | accessors | Model contents used by generators |
| `getDefaultSchema()` | `() => string` | The scope applied to tables and views that do not set one |
| `TableSchema.scope(name)` | `(name: string) => this` | Assigns the table to another SQL schema |
| `TableSchema.comment(text)` | `(text: string) => this` | Table comment, emitted as `COMMENT ON TABLE` |
| `TableSchema.getName(scope?)` | `(scope?: boolean) => string` | Qualified name by default; pass `false` for the bare name |

| Column family | Helper signatures | Column type |
| --- | --- | --- |
| Numeric | `serial`, `bigserial`, `smallint`, `integer`, `bigint`, `decimal(size?, scale?)`, `numeric(size?, scale?)`, `real`, `doublePrecision` | Integer and decimal family |
| Text | `varchar(size?)`, `char(size?)`, `text` | Character types |
| Boolean | `boolean` | `boolean` |
| Date / time | `date`, `time(size?)`, `timestamp(size?)`, `timestamptz(size?)` | Date and timestamp types |
| JSON | `json`, `jsonb` | JSON storage |
| Identifiers | `uuid` | UUID columns (see identity shorthands in [TableColumnSchema](#8-tablecolumnschema)) |
| Search / vector | `vector`, `tsvector` | Vector and full-text search columns |

---

## 8. TableColumnSchema

### What It Is

`TableColumnSchema` is the fluent column builder returned by every table helper. It holds the column's type, size/scale, nullability, default, generated expression, identity configuration, and the constraints it registers against its table.

### How It Works

- **Columns are `NOT NULL` by default.** Nullability is opt-in via `.nullable()`; the schema generator emits `NOT NULL` for every column that has not opted out. The same is true for snapshot normalization, so a forgotten `.nullable()` is a real change, not a no-op.
- `.primaryKey()` registers a primary-key constraint, adds a unique constraint, and forces the column to `NOT NULL`.
- `.unique()` and `.check(rule)` register table-level constraints targeting this column and return the column for further chaining.
- `.references(table, column, onUpdate?, onDelete?)` builds a foreign key from this column to the target column. When the actions are omitted, the foreign key keeps its defaults: `ON UPDATE CASCADE` and `ON DELETE RESTRICT`. Use `.foreignKeyConstraint(...)` for composite keys.
- `.default(value, quote?)` stores the default expression; pass `quote: true` for string literals so they render as `'value'`.
- `.generated(expression, stored?)` marks the column as `GENERATED ALWAYS AS (...) STORED`; `'VIRTUAL'` throws because PostgreSQL only supports stored generated columns, and generated columns cannot also have a default.
- `.identity(generation?, options?)` supports integer identity columns (`'ALWAYS'` or `'BY DEFAULT'`, with optional sequence options) and UUID shorthand: `'v4'` uses `uuid_generate_v4()` and registers `uuid-ossp`, `'v7'` uses `uuid_generate_v7()` and registers `pg_uuidv7`, and the default uses the built-in `gen_random_uuid()`.
- `.size(value)` and `.scale(value)` set length/precision but return `void` — prefer the helper signatures (`varchar(name, size)`, `decimal(name, size, scale)`), which apply them during creation.

### Complete Example

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');
const orders = schema.table('orders');

orders.bigint('id').identity('BY DEFAULT', { start: 1000, increment: 1 });
orders.uuid('public_id').identity(); // gen_random_uuid()
orders.varchar('number', 24).unique();
orders.decimal('total', 12, 2).default(0);
orders.text('note').nullable();
orders.text('number_upper').generated('upper(number)');
orders.boolean('is_paid').default(false);
orders.timestamptz('created_at').default('now()');

for (const column of orders.getColumns()) {
  console.log(
    column.getName(),
    column.getType(),
    column.getNullable() ? 'NULL' : 'NOT NULL',
    column.isIdentity() ? `IDENTITY ${column.getIdentityGeneration()}` : ''
  );
}
```

### Key Methods and Properties

| Member | Type / Signature | Description |
| --- | --- | --- |
| `.type(type)` | `(type: ColumnType) => this` | Sets the PostgreSQL type directly (normally done by a helper) |
| `.size(value)` | `(value: number) => void` | Sets length for character types; use `varchar(name, size)` instead of chaining |
| `.scale(value)` | `(value: number) => void` | Sets decimal scale; use `decimal(name, size, scale)` instead of chaining |
| `.nullable()` | `() => this` | Opts the column out of `NOT NULL` |
| `.default(value, quote?)` | `(value: string \| boolean \| number \| undefined, quote?: boolean) => this` | Sets the default expression; `quote` wraps the value in single quotes |
| `.primaryKey()` | `() => this` | Registers a primary key, a unique constraint, and `NOT NULL` |
| `.unique()` | `() => this` | Registers a table-level unique constraint for this column |
| `.check(rule)` | `(rule: string) => this` | Registers a table-level check constraint |
| `.references(table, column, onUpdate?, onDelete?)` | `(table: TableSchema, column: string, onUpdate?: ReferentialAction, onDelete?: ReferentialAction) => this` | Creates a foreign key; defaults are `CASCADE` / `RESTRICT` |
| `.generated(expression, stored?)` | `(expression: string, stored?: 'STORED' \| 'VIRTUAL') => this` | Generated column expression; `'VIRTUAL'` throws |
| `.identity(generation?, options?)` | `(generation?: 'ALWAYS' \| 'BY DEFAULT' \| 'v4' \| 'v7' \| string, options?: { start?, increment?, minValue?, maxValue?, cache?, cycle? }) => this` | Integer identity or UUID default generator |
| `getType()` / `getSize()` / `getScale()` / `getDefault()` | accessors | Column configuration, used by generators |
| `getNullable()` | `() => boolean` | `true` only after `.nullable()` |
| `isIdentity()` / `getIdentityGeneration()` / `getIdentityOptions()` | accessors | Identity state |
| `isGenerated()` / `getGeneratedExpression()` | accessors | Generated-column state |
| `.comment(text)` / `.getName()` | inherited from the column base | Column comment and name |

---

## 9. Constraints and Indexes

### What It Is

Constraints and indexes are table-level members declared on `TableSchema`: primary keys, unique constraints, check constraints, foreign keys, and `IndexConstraint` for `CREATE INDEX` options. The migration differ knows each kind, orders them by dependency, and requires explicit decisions for replacements it cannot prove.

### How It Works

1. `table.primaryKey()` lazily creates (and returns) the primary-key constraint; `table.getPrimaryKey()` reads it without creating one. Constraint columns are referenced by name and validated — an unknown column throws.
2. `table.uniqueConstraint()` and `table.checkConstraint(rule)` register unique and check constraints. `checkConstraint` returns the table, so several rules can be chained.
3. `table.foreignKeyConstraint(refTable)` opens a foreign key; use `.from(...columns)` for local columns and `.to(...columns)` for referenced columns. Calling `.column()` on a foreign key throws, because the two sides must be explicit; defaults are `ON UPDATE CASCADE` and `ON DELETE RESTRICT`.
4. `table.index()` returns an `IndexConstraint` supporting unique indexes, `USING` methods (`btree`, `hash`, `gist`, `gin`, `brin`, `spgist`, `bloom`), partial `WHERE` clauses, custom names, concurrent creation, `INCLUDE` columns, expression indexes, `WITH` storage parameters, and a tablespace.
5. Constraint names are derived deterministically as `<table>_<columns>_<postfix>` (lowercased); indexes default to `<table>_<columns>_idx` (`_key` when unique, `expr` prefix for expressions, a numeric suffix for repeats) unless `.indexName()` is set.

### Complete Example

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');

const users = schema.table('users');
users.bigint('id').primaryKey();
users.varchar('email', 255);
users.text('status').nullable();

users.checkConstraint(`"status" IN ('active', 'disabled')`);
users.uniqueConstraint().column('email');
users.index().indexName('users_email_lower_idx').expression('lower(email)');

const audit = schema.table('audit').scope('audit');
audit.bigint('id');
audit.bigint('user_id');
audit.foreignKeyConstraint(users).from('user_id').to('id').onDelete('CASCADE').onUpdate('RESTRICT');
audit.index().indexName('audit_user_id_idx').column('user_id').include('id');

const ddl = new PostgreSQLSchemaGenerator(schema).generateGrouped();
console.log(ddl.schema);
console.log(ddl.indexes);
```

Representative SQL from the rendered constraints and indexes:

```sql fragment
ALTER TABLE audit.users
	ADD CONSTRAINT users_id_pkey PRIMARY KEY (id),
	ADD CONSTRAINT users_email_unique_0 UNIQUE (email),
	ADD CONSTRAINT users_check_0 CHECK ("status" IN ('active', 'disabled')),
	ADD CONSTRAINT audit_user_id_fk_0 FOREIGN KEY (user_id) REFERENCES audit.users (id) ON DELETE CASCADE ON UPDATE RESTRICT
;
```

```sql fragment
CREATE INDEX users_email_lower_idx ON public.users ((lower(email)));
CREATE INDEX audit_user_id_idx ON audit.audit (user_id) INCLUDE (id);
```

### Key Methods and Properties

| Member | Type / Signature | Description |
| --- | --- | --- |
| `table.primaryKey()` | `() => PrimaryKeyConstraint` | Creates or returns the primary-key constraint |
| `table.getPrimaryKey()` | `() => PrimaryKeyConstraint \| undefined` | Read accessor that never creates a constraint |
| `table.uniqueConstraint()` | `() => UniqueConstraint` | Creates and registers a unique constraint |
| `table.checkConstraint(rule)` | `(rule: string) => TableSchema` | Registers a check constraint and returns the table |
| `table.foreignKeyConstraint(refTable)` | `(refTable: TableSchema) => ForeignKeyConstraint` | Creates and registers a foreign key |
| `constraint.column(...names)` | `(...names: string[]) => this` | Adds table columns to a constraint; throws for unknown columns |
| `constraint.hasColumns()` / `.getColumns()` / `.getTable()` | accessors | Constraint state used by generators |
| `fk.from(...columns)` / `fk.to(...columns)` | `(...columns: string[]) => this` | Local and referenced columns of a foreign key |
| `fk.onUpdate(action)` / `fk.onDelete(action)` | `(action: ReferentialAction \| undefined) => this` | Referential actions; defaults `CASCADE` / `RESTRICT` |
| `fk.getOnUpdate()` / `fk.getOnDelete()` / `fk.getRefTable()` / `fk.getRefColumns()` | accessors | Foreign-key state |
| `table.index()` | `() => IndexConstraint` | Creates and registers an index definition |
| `index.unique()` / `.concurrent()` | `() => this` | Unique index; `CREATE INDEX CONCURRENTLY` |
| `index.using(method)` | `(method: IndexMethod) => this` | Index method: `btree`, `hash`, `gist`, `gin`, `brin`, `spgist`, `bloom` |
| `index.where(condition)` | `(condition: string) => this` | Partial-index predicate |
| `index.indexName(name)` | `(name: string) => this` | Explicit index name; otherwise derived deterministically |
| `index.include(...columns)` | `(...columns: string[]) => this` | Non-key `INCLUDE` columns |
| `index.expression(expr)` | `(expr: string) => this` | Expression index body |
| `index.with(params)` | `(params: Record<string, string \| number>) => this` | `WITH (...)` storage parameters |
| `index.tablespace(name)` | `(name: string) => this` | Target tablespace |

---

## 10. Views

### What It Is

A view in the relational model is a named SQL query — regular or materialized — declared with `schema.view(name)` and configured through `ViewSchema`. Views carry comments, a scope, and a materialization flag.

### How It Works

1. `schema.view('name')` creates and registers the view; `.scope('analytics')` assigns it to a schema.
2. `.as(source)` stores the raw SQL body; `.materialized(true)` marks it materialized, `.materialized(false)` marks it regular. Without a call, the view is regular.
3. The schema generator drops every view first (`DROP VIEW` / `DROP MATERIALIZED VIEW` with `CASCADE`), then recreates regular views with `CREATE OR REPLACE VIEW` and materialized views with `CREATE MATERIALIZED VIEW`.
4. View comments render as `COMMENT ON VIEW` / `COMMENT ON MATERIALIZED VIEW`.
5. View bodies are opaque SQL. Because dependencies cannot be proven, the migration differ reports changed or removed views as unsupported and blocks them — replace them deliberately with a manual migration.

### Complete Example

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');

const users = schema.table('users');
users.bigint('id').primaryKey();
users.text('status').nullable();

schema
  .view('active_users')
  .as(`SELECT id FROM public.users WHERE status = 'active'`)
  .comment('Users currently enabled');

schema
  .view('user_stats')
  .materialized(true)
  .as(`SELECT count(*) AS total FROM public.users`);

const views = new PostgreSQLSchemaGenerator(schema).generateGrouped().views;
console.log(views);
```

Rendered view SQL:

```sql fragment
DROP VIEW IF EXISTS public.active_users CASCADE;
DROP MATERIALIZED VIEW IF EXISTS public.user_stats CASCADE;
CREATE OR REPLACE VIEW public.active_users AS SELECT id FROM public.users WHERE status = 'active';
CREATE MATERIALIZED VIEW public.user_stats AS SELECT count(*) AS total FROM public.users;

COMMENT ON VIEW public.active_users IS 'Users currently enabled';
```

### Key Methods and Properties

| Member | Type / Signature | Description |
| --- | --- | --- |
| `DatabaseSchema.view(name)` | `(name: string) => ViewSchema` | Creates and registers a view in the default scope |
| `.as(source)` | `(source: string) => this` | Sets the view's SQL body |
| `.materialized(state?)` | `(state?: boolean) => this` | Marks the view materialized (anything except `false` enables it) |
| `.isMaterialized()` | `() => boolean` | Whether the view renders as `CREATE MATERIALIZED VIEW` |
| `.getSource()` | `() => string \| undefined` | The stored SQL body |
| `.scope(name)` | `(name: string) => this` | SQL schema for the view |
| `.getName(scope?)` | `(scope?: boolean) => string` | Qualified name by default; `false` for the bare name |
| `.comment(text)` | `(text: string) => this` | View comment; single quotes are escaped when rendered |

---

## 11. PostgreSQLSchemaGenerator

### What It Is

`PostgreSQLSchemaGenerator` renders a `DatabaseSchema` into complete PostgreSQL DDL — the desired-state bootstrap script used to provision fresh databases, test databases, and CI environments. It is deterministic: unchanged models always render byte-identical SQL.

### How It Works

1. `generateGrouped(params?)` builds four strings: `schema` (extensions, drops, schemas, tables, constraints, comments), `indexes`, `views` (views plus view comments), and `all` (everything joined).
2. Section order is fixed: `CREATE EXTENSION IF NOT EXISTS` → schema drops → table drops → `CREATE SCHEMA IF NOT EXISTS` → `CREATE TABLE` → `ALTER TABLE ... ADD CONSTRAINT` → `COMMENT ON TABLE/COLUMN` → `CREATE INDEX` → view drops/creates → `COMMENT ON VIEW`.
3. `dropBeforeCreate` defaults to `true`: every table is dropped with `CASCADE`, and non-default scopes are dropped before creation. Use this generator only against databases you intend to rebuild — production schema changes belong to the snapshot-based [migration pipeline](#16-migration-generation-and-canonical-snapshots).
4. Constraint and index names are derived deterministically when not set explicitly, and comments escape single quotes by doubling them.
5. `generate(params?)` is the convenience form that returns `generateGrouped(params).all` as one string.

### Complete Example

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');
schema.extension('pgcrypto');

const users = schema.table('users').comment('Application users');
users.bigint('id').primaryKey();
users.text('email').unique();
users.timestamptz('created_at').default('now()');

schema.view('active_users').as(`SELECT id FROM public.users`).comment('Enabled users');

const generator = new PostgreSQLSchemaGenerator(schema);
const ddl = generator.generateGrouped();

console.log(ddl.schema);
console.log(ddl.indexes);
console.log(ddl.views);
```

The `schema` section contains the bootstrap statements:

```sql fragment
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DROP TABLE IF EXISTS public.users CASCADE;

CREATE TABLE public.users (
	id bigint NOT NULL,
	email text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.users
	ADD CONSTRAINT users_id_pkey PRIMARY KEY (id),
	ADD CONSTRAINT users_email_unique_0 UNIQUE (email)
;

COMMENT ON TABLE public.users IS 'Application users';
```

### Key Methods and Properties

| Member | Type / Signature | Description |
| --- | --- | --- |
| `new PostgreSQLSchemaGenerator(db)` | `(db: DatabaseSchema) => PostgreSQLSchemaGenerator` | Creates the generator for one desired-state model |
| `generate(params?)` | `(params?: GenerateOptions) => string` | Complete DDL as a single string |
| `generateGrouped(params?)` | `(params?: GenerateOptions) => GeneratedDDL` | DDL split into `schema`, `indexes`, `views`, and `all` |
| `GenerateOptions.dropBeforeCreate` | `boolean` (default `true`) | Emits `DROP TABLE`/`DROP SCHEMA` with `CASCADE` before creating |
| `GeneratedDDL.schema` | `string` | Extensions, schemas, tables, constraints, and comments |
| `GeneratedDDL.indexes` | `string` | All `CREATE INDEX` statements |
| `GeneratedDDL.views` | `string` | View drops/creates and view comments |
| `GeneratedDDL.all` | `string` | `schema` + `indexes` + `views` |

---

## 12. PostgreSQLIntrospector

### What It Is

`PostgreSQLIntrospector` reads a live PostgreSQL catalog into a `SchemaContainer`, so an existing database can produce TypeScript types and validators through the same generators used for hand-authored schemas. It also produces relation/column constant maps for `CTypeGenerator`.

### How It Works

1. `new PostgreSQLIntrospector(db)` wraps a connected `PostgreSQLDatabase` client; `introspect(schema, mapper?)` executes one catalog query covering tables, partitioned tables, views, materialized views, foreign tables, standalone composite types, enum types, and domains.
2. Enum types become string or number primitives restricted with `.enum([...])` (numeric labels are detected automatically); columns of enum type become `.ref()` calls to those types.
3. A `ColumnMapper` runs for every column and may return a schema object to override the built-in mapping, or a falsy value to fall back. For array columns the leading `_` type prefix is stripped before the mapper runs, and `.arrayed()` is applied afterwards.
4. When no override and no built-in mapping applies, the column becomes an unconstrained schema marked with a `@deprecated` warning and a message is logged — supply a mapper for `jsonb`, `bytea`, `interval`, and the range/geometry families to avoid this.
5. Nullable columns receive `.nullable().optional()`; key, uniqueness, default, and check-constraint facts are attached as annotations; the raw catalog row is preserved via `metadata({ introspect: row })`.
6. Objects from the `public` schema are unscoped; other schemas become scopes.

### Complete Example

```typescript
import { PostgreSQLIntrospector, SchemaContainer, TypeGenerator } from 'blendsdk/codegen';
import type { ColumnMapper } from 'blendsdk/codegen';
import type { PostgreSQLDatabase } from 'blendsdk/postgresql';

/** Resolves the column types the built-in mapping deliberately leaves to the application. */
const mapper: ColumnMapper = (column, scope) => {
  switch (column.pg_type) {
    case 'bytea':
      return scope.string().description('Binary payload, returned as a Buffer');
    case 'interval':
      return scope.string().description('PostgreSQL interval literal');
    default:
      return undefined;
  }
};

export async function generateTypesFromDatabase(db: PostgreSQLDatabase): Promise<string> {
  const schema = new SchemaContainer();
  await new PostgreSQLIntrospector(db).introspect(schema, mapper);
  return new TypeGenerator().generate(schema);
}
```

### Key Methods and Properties

| Member | Type / Signature | Description |
| --- | --- | --- |
| `new PostgreSQLIntrospector(db)` | `(db: PostgreSQLDatabase) => PostgreSQLIntrospector` | Creates the introspector for one database client |
| `introspect(schema, mapper?)` | `(schema: SchemaContainer, mapper?: ColumnMapper) => Promise<void>` | Reads the catalog into the container, creating enum types first |
| `introstectConstantTypes()` | `() => Promise<ConstantType>` | Returns relation → column names for `CTypeGenerator` (spelling as in the API) |
| `ColumnMapper` | `(column: ColumnIntrospection, scope: SchemaScope) => SchemaObject \| unknown` | Per-column override; a falsy return falls back to built-in mapping |
| `ColumnIntrospection.relation_kind` | `'table' \| 'view' \| 'materialized view' \| 'partitioned table' \| 'foreign table' \| 'enum type' \| 'composite type'` | What the row describes |
| `ColumnIntrospection.pg_type` | `string` | Normalized PostgreSQL type name (array prefix stripped before mapping) |
| `ColumnIntrospection.is_array` / `.is_nullable` / `.has_default` | `boolean` | Array, nullability, and default flags applied by the introspector |
| `ColumnIntrospection.column_default` | `string \| null` | Default expression, attached as an annotation |
| `ColumnIntrospection.is_primary_key` / `.is_unique` / `.is_foreign_key` | `boolean` | Key and constraint facts |
| `ColumnIntrospection.enum_labels` | `string[] \| string \| null` | Enum values used to build enum types and references |

---

## 13. OpenAPIGenerator

### What It Is

`OpenAPIGenerator` assembles an OpenAPI v3.1.0 document from `blendsdk/webafx` route definitions. Documentation is opt-in: only routes that carry `.openapi()` metadata are included, so internal endpoints stay out of the published specification.

### How It Works

1. `new OpenAPIGenerator(config)` takes API metadata (`title`, `version`, `description`), optional `servers`, `securitySchemes`, and `defaultSecurity`.
2. `addController(basePath, ControllerClass)` instantiates the controller with empty settings/services — `routes()` must only build route definitions — and collects routes. `addRoutes(basePath, routes)` accepts definitions directly. Both are chainable.
3. Paths are built by combining the base path and the route path (no double slashes; a `/` route uses the base path alone) and converting Express `:param` segments to OpenAPI `{param}` segments.
4. Operations receive metadata from `.openapi()` — summary, description, tags, operationId, deprecated, and responses (`statusCode` keys with optional JSON content schemas). Path parameters are extracted from the URL and are always `required`.
5. GET and DELETE routes with a validation schema produce query parameters; POST, PUT, and PATCH routes with a validation schema produce a required JSON request body.
6. Routes marked `secure: true` (or with a named principal service string) receive the configured `defaultSecurity`; a secure route without configured default security renders `security: []`. Routes without the flag are public.
7. Output through `generate()`, `toJSON(indent)`, or `toFile(path)` — the last creates parent directories when needed.

### Complete Example

```typescript
import { OpenAPIGenerator } from 'blendsdk/codegen';
import type { RouteDefinition } from 'blendsdk/webafx';
import { z } from 'zod';

/** Builds a route definition; only routes with openapi metadata are documented. */
function route(definition: Omit<RouteDefinition, 'handler'>): RouteDefinition {
  return { ...definition, handler: async () => undefined } as RouteDefinition;
}

const generator = new OpenAPIGenerator({
  title: 'Catalog API',
  version: '1.0.0',
  description: 'Product catalog endpoints',
  servers: [{ url: 'http://localhost:3000', description: 'Local development' }],
  securitySchemes: {
    bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  },
  defaultSecurity: [{ bearerAuth: [] }],
});

generator.addRoutes('/api/products', [
  route({
    method: 'get',
    path: '/',
    validation: z.object({
      page: z.coerce.number().default(1),
      search: z.string().optional(),
    }),
    openapi: {
      summary: 'List products',
      tags: ['products'],
      operationId: 'listProducts',
      responses: [{ statusCode: 200, description: 'Paginated product list' }],
    },
  }),
  route({
    method: 'post',
    path: '/',
    secure: true,
    validation: z.object({ name: z.string().min(1), price: z.number() }),
    openapi: {
      summary: 'Create a product',
      operationId: 'createProduct',
      responses: [{ statusCode: 201, description: 'Product created' }],
    },
  }),
]);

const document = generator.generate();
console.log(document.openapi, Object.keys(document.paths));

generator.toFile('./openapi.json');
```

### Key Methods and Properties

| Member | Type / Signature | Description |
| --- | --- | --- |
| `new OpenAPIGenerator(config)` | `(config: OpenAPIGeneratorConfig) => OpenAPIGenerator` | Creates the generator with API metadata and security configuration |
| `addController(basePath, ControllerClass)` | `(basePath: string, ControllerClass: ControllerConstructor) => this` | Instantiates a controller and collects its opted-in routes |
| `addRoutes(basePath, routeDefinitions)` | `(basePath: string, routeDefinitions: RouteDefinition[]) => this` | Adds route definitions directly, filtering out routes without `.openapi()` |
| `generate()` | `() => OpenAPIDocument` | Builds the complete OpenAPI v3.1.0 document |
| `toJSON(indent?)` | `(indent = 2) => string` | Returns the document as formatted JSON |
| `toFile(path)` | `(filePath: string) => void` | Writes the JSON document, creating parent directories |
| `OpenAPIGeneratorConfig.title` / `.version` | `string` | Required API metadata |
| `OpenAPIGeneratorConfig.servers` | `OpenAPIServer[]` | Server list emitted on the document |
| `OpenAPIGeneratorConfig.securitySchemes` | `Record<string, OpenAPISecurityScheme>` | Schemes placed in `components.securitySchemes` |
| `OpenAPIGeneratorConfig.defaultSecurity` | `SecurityRequirement[]` | Security applied to routes marked `secure` |

---

## 14. Zod to OpenAPI Conversion

### What It Is

`convertZodToJsonSchema(schema, direction)` and `convertZodToQueryParameters(schema)` convert Zod v4 schemas into OpenAPI 3.1 JSON Schema objects and query-parameter arrays. They are the conversion layer behind `OpenAPIGenerator` and are exported for direct use — useful for documenting hand-written schemas or validating the generated contract in tests.

### How It Works

1. The converter builds on Zod's native `z.toJSONSchema` (`draft-2020-12`) instead of introspecting Zod internals or relying on third-party converters, which do not support Zod v4.
2. `convertZodToJsonSchema(schema, direction)` selects the wire direction with `io`: pass `'input'` for request bodies and query schemas (the shape a caller sends) and `'output'` for response schemas (the shape the server returns), so defaults and transforms resolve on the correct side.
3. The returned schema drops the root `$schema` marker and folds a simple nullable union (`anyOf: [inner, { type: 'null' }]`) into a JSON Schema type array such as `type: ['string', 'null']`, which OpenAPI 3.1 understands; the 3.0 `nullable` keyword is not emitted.
4. Optional and defaulted properties are excluded from `required`; default values are preserved on the property schema.
5. Pipes and transforms — created by `.transform()` and `.pipe()` — are documented by their **input** schema when `direction` is `'input'`, because that is what the API consumer must send. `z.string().transform(v => v.split(','))` is documented as a string, not as the array the handler receives.
6. `convertZodToQueryParameters()` converts a query object with `direction: 'input'` and emits one parameter per top-level property with `in: 'query'`; a parameter is required only when it is neither optional nor defaulted. A non-object schema produces no parameters.

### Complete Example

```typescript
import { convertZodToJsonSchema, convertZodToQueryParameters } from 'blendsdk/codegen';
import { z } from 'zod';

const productSchema = z.object({
  name: z.string().min(1).max(120),
  price: z.number().min(0),
  tags: z.string().transform(value => value.split(',').map(tag => tag.trim())),
  status: z.enum(['draft', 'published']).default('draft'),
});

const jsonSchema = convertZodToJsonSchema(productSchema, 'input');

const querySchema = z.object({
  page: z.coerce.number().default(1),
  search: z.string().optional(),
});
const parameters = convertZodToQueryParameters(querySchema);

console.log(JSON.stringify({ jsonSchema, parameters }, null, 2));
```

The converted request schema — note `tags` documented as the string the client sends, and `status` excluded from `required` because it has a default:

```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string", "minLength": 1, "maxLength": 120 },
    "price": { "type": "number", "minimum": 0 },
    "tags": { "type": "string" },
    "status": { "type": "string", "enum": ["draft", "published"], "default": "draft" }
  },
  "required": ["name", "price", "tags"]
}
```

And the query parameters:

```json
[
  { "name": "page", "in": "query", "schema": { "type": "number", "default": 1 } },
  { "name": "search", "in": "query", "schema": { "type": "string" } }
]
```

### Key Methods and Properties

| Member | Type / Signature | Description |
| --- | --- | --- |
| `convertZodToJsonSchema(schema, direction)` | `(zodSchema: ZodType, direction: 'input' \| 'output') => OpenAPISchema` | Converts any Zod v4 schema into an OpenAPI 3.1 JSON Schema object with `z.toJSONSchema`; `direction` selects request (`'input'`) or response (`'output'`) semantics |
| `convertZodToQueryParameters(schema)` | `(zodSchema: ZodType) => OpenAPIParameter[]` | Converts an object schema into `in: 'query'` parameters |
| `OpenAPISchema` | interface | Output shape: `type`, `format`, `enum`, `default`, `properties`, `required`, `items`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `pattern`, `allOf`/`anyOf`/`oneOf`, `$ref`; nullable values use a JSON Schema type array |
| `.optional()` / `.default(v)` | Zod wrappers | Unwrapped; property omitted from `required` (defaults preserved) |
| `.nullable()` | Zod wrapper | Folded into a JSON Schema type array (for example `type: ['string', 'null']`) |
| `z.union([...])` | Zod union | Converted to `{ anyOf: [...] }` |
| `.transform()` / `.pipe()` | Zod pipes | Converted using the input schema — the client-facing contract |

---

## 15. Migration Configuration

### What It Is

`blendsdk.migrations.ts` is the project-level configuration module for the entire migration lifecycle. It is discovered automatically by searching upward from the working directory, or supplied explicitly with `--config`, and it is resolved relative to its own directory. `defineMigrationConfig` provides type checking for the authored file.

### How It Works

1. Every command loads the configuration first; invalid configuration is a `CONFIGURATION` failure with exit code `2`.
2. Validation is strict: unknown keys are rejected, `lockTimeoutMs` must be positive, `databaseUrlEnv` must be a valid environment-variable name, and `migrationsDir` may not escape the config directory, point at a filesystem root, or resolve through a symlink.
3. Resolution produces absolute paths and defaults — `ResolvedMigrationConfig` includes `configPath`, `configDirectory`, the configured `schema` path (when set), `migrationsDir`, `snapshotFile`, `databaseUrlEnv`, `lockTimeoutMs`, and `statementTimeoutMs`.
4. The connection URL itself is never stored in the configuration — only the name of the environment variable that holds it. Resolved configuration and rendered errors never contain credentials.
5. Execution-only commands (`up`, `down`, `status`, `validate`, `adopt-baseline`) do not import the configured `schema` module; only generation commands execute application schema code.

### Complete Example

```typescript
// blendsdk.migrations.ts
import { defineMigrationConfig } from 'blendsdk/codegen';

export default defineMigrationConfig({
  schema: './schema.ts',
  migrationsDir: './migrations',
  databaseUrlEnv: 'DATABASE_URL',
});
```

```typescript
// schema.ts
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');
const customer = schema.table('customer');
customer.bigint('id').primaryKey();
customer.text('name').nullable();

export default schema;
```

### Key Methods and Properties

| Member | Type / Signature | Description |
| --- | --- | --- |
| `defineMigrationConfig(config)` | `(config: MigrationConfig) => MigrationConfig` | Declares a type-checked configuration module |
| `MigrationConfig.schema` | `string` | Path to the schema module exporting a `DatabaseSchema` as its default export |
| `MigrationConfig.migrationsDir` | `string` (default `./migrations`) | Directory for immutable migration files and the snapshot |
| `MigrationConfig.databaseUrlEnv` | `string` (default `'DATABASE_URL'`) | Environment variable holding the PostgreSQL connection URL |
| `MigrationConfig.lockTimeoutMs` | `number` (default `5000`) | Advisory-lock wait budget; must be greater than zero |
| `MigrationConfig.statementTimeoutMs` | `number` (default `900000`) | Per-statement timeout applied to migration sessions |
| `ResolvedMigrationConfig.configPath` / `.configDirectory` | `string` | Absolute config file and its directory |
| `ResolvedMigrationConfig.snapshotFile` | `string` | Canonical snapshot path (`<migrationsDir>/schema.snapshot.json`) |
| `ResolvedMigrationConfig.schema` | `string` | Absolute schema module path, present when configured |

---

## 16. Migration Generation and Canonical Snapshots

### What It Is

Generation is the offline half of the migration lifecycle. `generateBaseline` creates the first immutable migration and canonical snapshot for a project with no history; `generateMigration` diffs the desired schema against the committed snapshot and publishes exactly one new migration plus the next snapshot. Nothing in this step needs a database connection.

### How It Works

1. The desired `DatabaseSchema` is normalized into a canonical, data-only snapshot: unordered collections are ordered by identity, defaults and falsy values are preserved, and the exact bytes are hashed with SHA-256. Generation refuses to run when migration history exists without its snapshot (`INVALID_HISTORY`).
2. `generateMigration({ name })` compares the snapshot with the desired state, classifies every change, renders ordered SQL, and writes `<timestamp>_<slug>.up.sql` plus the replacement snapshot. When there is nothing to change, it reports `UP_TO_DATE` and leaves every file byte-identical.
3. Renames, removals, and transitions the model cannot express are never guessed. Generation fails with guidance instead of writing a lossy migration; the remedy is a manual migration created with `blendsdk migrate create`.
4. Publication is failure-safe: both artifacts are written to private temporary names, flushed, verified byte-for-byte, and only then published — if publishing the snapshot fails, the new migration is removed and the previous snapshot stays untouched.
5. Every migration file carries a strict five-line header that later tooling validates byte-for-byte (no BOM, no CRLF, no unknown headers).

```sql fragment
-- blendsdk-migration: 1
-- id: 20260827120000_add-nickname
-- transaction: true
-- from-snapshot: 1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809
-- to-snapshot: 9f3a6c1e8b2d4f70a5c9e2d7b4f81a360d5e9c2b7f4a1d8e6b3c0f9a2d7e4b18
ALTER TABLE "public"."customer" ADD COLUMN "nickname" text;
```

### Complete Example

```typescript
import { generateBaseline, generateMigration } from 'blendsdk/codegen';

const baseline = await generateBaseline({
  name: 'initial',
  configPath: './blendsdk.migrations.ts',
});

console.log(baseline.migration.id, baseline.snapshotHash);

const generated = await generateMigration({
  name: 'add-nickname',
  configPath: './blendsdk.migrations.ts',
});

if (generated.status === 'GENERATED' && generated.migration) {
  console.log(`Published ${generated.migration.upPath}`);
} else {
  console.log('No schema changes to migrate.');
}
```

### Key Methods and Properties

| Member | Type / Signature | Description |
| --- | --- | --- |
| `generateBaseline(options)` | `(options: GenerateBaselineOptions) => Promise<GenerateBaselineResult>` | Offline: creates one complete baseline migration and one canonical snapshot |
| `GenerateBaselineOptions.name` | `string` | Lowercase baseline slug used in the migration id |
| `GenerateBaselineOptions.configPath` / `.now` | `string` / `Date` | Explicit config file; deterministic clock for tests and embedding |
| `GenerateBaselineResult` | `{ status: 'GENERATED'; migration: MigrationDescriptor; snapshotHash: string; changes: SchemaChange[] }` | The published baseline and its lineage |
| `generateMigration(options)` | `(options) => Promise<{ status: 'GENERATED' \| 'UP_TO_DATE'; migration?: MigrationDescriptor }>` | Diffs desired state against the snapshot and publishes one migration |
| `MigrationDescriptor` | `{ id, upPath, downPath?, checksum, transactional, fromSnapshot?, toSnapshot? }` | Immutable metadata for one migration file |
| `MigrationSafety` | `'safe' \| 'caution' \| 'destructive' \| 'ambiguous' \| 'unsupported'` | Change classification: safe changes apply, caution/ambiguous/unsupported are blocked with guidance, destructive removals are marked when explicitly allowed |
| Lineage | `from-snapshot` / `to-snapshot` | Snapshot hash before and after; `none` means the migration is not snapshot-backed (manual migrations) |

---

## 17. Migration Runner and Ledger

### What It Is

`runMigrations` executes the reviewed local history against the target database and records what it did in the `public.blendsdk_migrations` ledger. `getMigrationStatus` and `validateMigrations` are the read-only entry points built on the same machinery. Local files and ledger rows must agree exactly — as an ordered prefix — before any SQL runs.

### How It Works

1. Commands are `up`, `down`, `status`, and `validate`. Every command except dry runs and read-only commands opens a pooled session using the URL from `databaseUrlEnv`.
2. **Verification.** Local migrations and applied ledger rows must match as an exact prefix by checksum. Edits, insertions, deletions, reordering, invalid ledger rows, or a wrong-shaped ledger table all fail with `INVALID_HISTORY` before SQL executes. Files are revalidated after the lock wait, because another process may have changed them.
3. **Locking.** Runs serialize on a database-scoped PostgreSQL advisory lock with the configured wait budget; contention beyond the budget reports `LOCKED` without creating a ledger or executing SQL.
4. **Transactional migrations.** The migration SQL and its ledger row commit together; a failure rolls both back and stops the run before the next file.
5. **Nontransactional migrations.** A durable `NONTRANSACTIONAL_DIRTY` marker is written before dispatch. Success promotes the row to `APPLIED`; a known failure or a lost session leaves the marker and reports `UNKNOWN_OUTCOME` for a human to inspect.
6. **Down.** Refuses to run without explicit confirmation and reverts exactly the latest migration and its row in one transaction. Cancellation via an `AbortSignal` cancels active SQL, rolls back the open transaction, and reports `ABORTED` while keeping completed rows.
7. Read-only commands and dry runs treat an absent ledger as empty history and never create it.

### Complete Example

```typescript
import { runMigrations } from 'blendsdk/codegen';

const preview = await runMigrations({
  command: 'up',
  configPath: './blendsdk.migrations.ts',
  dryRun: true,
});

console.log(preview.status, preview.migrations.map(migration => migration.id));

if (preview.status === 'PENDING') {
  await runMigrations({ command: 'up', configPath: './blendsdk.migrations.ts' });
}

const status = await runMigrations({
  command: 'status',
  configPath: './blendsdk.migrations.ts',
});
console.log(status.status);
```

### Key Methods and Properties

| Member | Type / Signature | Description |
| --- | --- | --- |
| `runMigrations(options)` | `(options: RunMigrationsOptions) => Promise<MigrationCommandResult>` | Runs `up`, `down`, `status`, or `validate` under lock and verification |
| `RunMigrationsOptions.command` | `MigrationCommand` | The lifecycle command to execute |
| `RunMigrationsOptions.configPath` | `string` | Explicit config file instead of upward discovery |
| `RunMigrationsOptions.dryRun` | `boolean` | Reports pending order without executing SQL or creating the ledger |
| `RunMigrationsOptions.allowDown` | `boolean` | Required confirmation for the destructive `down` command |
| `RunMigrationsOptions.signal` | `AbortSignal` | Cancels active SQL; the open transaction rolls back with `ABORTED` |
| `MigrationCommandResult` | `{ status: MigrationStatus; migrations: MigrationDescriptor[] }` | Status plus the migrations relevant to that status |
| `MigrationStatus` | `'UP_TO_DATE' \| 'PENDING' \| 'INVALID_HISTORY' \| 'LOCKED' \| 'UNKNOWN_OUTCOME'` | The five observable lifecycle states |
| `getMigrationStatus(...)` | `(options) => Promise<MigrationCommandResult>` | Reports status for the configured project |
| `validateMigrations(...)` | `(options) => Promise<MigrationCommandResult>` | Validates local history and applied ledger (also usable offline) |
| Ledger table | `public.blendsdk_migrations (id, checksum, from_snapshot, to_snapshot, state, applied_at, execution_ms)` | Fixed shape; states are `APPLIED` and `NONTRANSACTIONAL_DIRTY` |

---

## 18. Baseline Adoption

### What It Is

`adoptBaseline` records the initial lineage of a database that already matches the generated baseline — for example a database provisioned from the desired-state DDL — without re-running any baseline SQL and without touching existing data. It is the bridge from "database exists" to "database is managed by migrations".

### How It Works

1. The local baseline must exist, and the ledger must be absent, empty, or empty-but-compatible. A nonempty ledger fails with `INVALID_HISTORY` and is never modified.
2. Adoption takes the same advisory lock as the runner, so it can never race an `up` on the same database.
3. The live catalog is projected into canonical form and compared with the baseline's desired state entry by entry. Any `MISSING`, `DIFFERENT`, or `EXTRA_MODELED` structure fails with `UNSUPPORTED` and a qualified identity in the message; unmanaged functions and triggers unrelated to the model are reported as `UNMANAGED` and preserved.
4. Desired state that cannot be proven structurally — raw SQL defaults, deferrable constraints, index ordering the model does not express, row-level security, redirected sequences — is reported as `UNSUPPORTED_FOR_ADOPTION` rather than adopted on trust.
5. A target-specific confirmation token (`<database>/<baselineId>`) confirms that DDL is quiesced on that exact database. The authoritative catalog is re-verified inside the transaction; if either the database or the local baseline changed since the preview, adoption aborts without inserting history.
6. On success, the baseline row is inserted as `APPLIED` and repeated `adoptBaseline` calls are refused because history now exists.

### Complete Example

```typescript
import { adoptBaseline } from 'blendsdk/codegen';

const result = await adoptBaseline({
  configPath: './blendsdk.migrations.ts',
  confirmation: 'app/20260827090000_initial',
});

console.log(result.status);

for (const item of result.comparison) {
  console.log(item.classification, item.identity);
}
```

### Key Methods and Properties

| Member | Type / Signature | Description |
| --- | --- | --- |
| `adoptBaseline(options, hooks?)` | `(options: AdoptBaselineOptions, hooks?) => Promise<{ status: 'ADOPTED'; comparison: readonly CatalogComparisonItem[] }>` | Proves the live catalog matches the baseline and records the initial lineage |
| `AdoptBaselineOptions.configPath` | `string` | Explicit config file for the local baseline and target database |
| `AdoptBaselineOptions.confirmation` | `string` | Exact `<database>/<baselineId>` DDL-quiescence confirmation token |
| `afterPreview(preview)` hook | `(preview: AdoptionPreview) => void \| string \| Promise<void \| string>` | Runs after the preview is computed and before history is mutated; may return the confirmation token |
| `AdoptionPreview` | `{ host, port, user, database, baselineId }` | Sanitized target preview without passwords or URL query values |
| `MATCH` / `MISSING` / `DIFFERENT` / `EXTRA_MODELED` | classification | Modeled structures; anything except `MATCH` blocks adoption |
| `UNMANAGED` | classification | Unrelated functions/triggers reported and preserved |
| `UNSUPPORTED_FOR_ADOPTION` | classification | Structurally unprovable desired state; adoption is refused |

---

## 19. Migration Errors and Statuses

### What It Is

Every operational failure in the migration pipeline surfaces as a typed `MigrationError` with a stable `kind` and an `exitCode` class. `formatMigrationError` renders those errors for humans with credentials and SQL bodies redacted, so diagnostics are safe to paste into tickets and logs.

### How It Works

1. Throw sites classify failures: configuration and usage problems are `CONFIGURATION` (exit `2`); everything that happens against the repository or database is an operational failure (exit `1`).
2. Messages are sanitized at construction: connection URLs are replaced with `[REDACTED_DATABASE_URL]`, credential assignments with `[REDACTED]`, and SQL bodies supplied as `sensitiveDetail` are retained on the error object but never rendered.
3. `formatMigrationError` renders the stable `KIND: message` form used by the CLI's stderr output, which never includes stack traces.
4. Read-only commands report lifecycle state instead of throwing: `UP_TO_DATE`, `PENDING`, `INVALID_HISTORY`, `LOCKED`, and `UNKNOWN_OUTCOME` are the five discriminators returned in results.

### Complete Example

```typescript
import { formatMigrationError, MigrationError, runMigrations } from 'blendsdk/codegen';

try {
  await runMigrations({ command: 'up', configPath: './blendsdk.migrations.ts' });
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(formatMigrationError(error));
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}
```

Rendered output for a database failure looks like:

```text
DATABASE: Connection [REDACTED_DATABASE_URL] failed with password=[REDACTED]
```

### Key Methods and Properties

| Member | Type / Signature | Description |
| --- | --- | --- |
| `MigrationError` | `new ({ kind, exitCode, message, sensitiveDetail? }) => MigrationError` | Typed error carrying classification, exit class, and a redacted message |
| `MigrationError.kind` | `MigrationErrorKind` | Stable category used for programmatic handling |
| `MigrationError.exitCode` | `MigrationExitCode` (`0 \| 1 \| 2`) | Exit class: `0` success, `1` operational failure, `2` usage/configuration |
| `formatMigrationError(error)` | `(error: MigrationError) => string` | Renders `KIND: message` with credentials and SQL redacted |
| `CONFIGURATION` | kind (exit `2`) | Invalid or missing configuration |
| `INVALID_HISTORY` | kind (exit `1`) | Local files, snapshot lineage, ledger rows, or ledger shape do not match |
| `DATABASE` | kind (exit `1`) | Connection loss, SQL failure, timeout |
| `LOCKED` | kind (exit `1`) | Advisory lock could not be acquired within the budget |
| `UNKNOWN_OUTCOME` | kind (exit `1`) | A nontransactional run could not be confirmed committed or rolled back |
| `ABORTED` | kind (exit `1`) | Cancellation through an `AbortSignal` |
| `UNSUPPORTED` | kind (exit `1`) | A change or database shape cannot be migrated or adopted safely |
| `FILESYSTEM` | kind (exit `1`) | Artifact publication or discovery failed |
| `MigrationStatus` | union of five values | `UP_TO_DATE`, `PENDING`, `INVALID_HISTORY`, `LOCKED`, `UNKNOWN_OUTCOME` |

---

## 20. The Migration CLI

### What It Is

`blendsdk migrate` is the lifecycle executable shipped with the assembled `blendsdk` package. It exposes exactly eight commands — with no force, fake, or repair bypass — and maps every outcome to a documented exit code, which makes it safe to script in CI and runbooks.

### How It Works

1. `blendsdk migrate --help` lists the eight commands and the exit-code contract; every command supports `--help` without running a migration. `blendsdk --version` prints the package version.
2. `baseline`, `generate`, and `create` take a name argument; the other five commands do not.
3. Configuration is discovered upward from the working directory or supplied with `--config <path>`; `validate` additionally supports `--offline` for credentials-free CI checks.
4. Caller-supplied values are validated before use — path traversal and argument-to-SQL payloads are rejected, and rejected payloads are never echoed back in output.
5. Output is split: normal status on stdout (`GENERATED`, `CREATED`, `PENDING`, `UP_TO_DATE`, ...), sanitized diagnostics on stderr. Exit code `0` means success, `1` an operational failure, `2` a usage or configuration failure.

### Complete Example

```bash
# Create the initial baseline migration and snapshot (no database connection required)
blendsdk migrate baseline initial

# Apply pending migrations, then inspect status
blendsdk migrate up
blendsdk migrate status

# Turn a schema edit into one reviewable migration
blendsdk migrate generate add-nickname

# Write manual SQL for ambiguous or unsupported changes
blendsdk migrate create backfill-customer-status

# Validate local history without credentials, then adopt an existing database
blendsdk migrate validate --offline --config ./blendsdk.migrations.ts
blendsdk migrate adopt-baseline
```

### Key Methods and Properties

| Command | Name argument | Description |
| --- | --- | --- |
| `baseline` | required | Creates the initial migration and canonical snapshot for a project with no history |
| `generate` | required | Diffs the desired schema against the snapshot and publishes one migration plus the next snapshot |
| `create` | required | Creates an empty up (and optionally down) migration for manual SQL |
| `up` | — | Verifies history under lock and applies pending migrations |
| `down` | — | Reverts the latest migration; refuses without explicit confirmation |
| `status` | — | Reports `UP_TO_DATE`, `PENDING`, `INVALID_HISTORY`, `LOCKED`, or `UNKNOWN_OUTCOME` |
| `validate` | — | Validates local history and applied ledger; `--offline` works without a database URL |
| `adopt-baseline` | — | Records initial lineage for an existing database after a structural match and quiescence confirmation |
| Global flags | `--help`, `--version`, `--config <path>` | Discover or point at configuration; help never executes a migration |
| Exit codes | `0` success / `1` operational / `2` usage or configuration | Stable contract for scripts and runbooks |

---

# codegen Basic Usage

This guide walks from installation to a first working example of each main pipeline in `blendsdk/codegen`: authoring data shapes, generating TypeScript/Zod/constant/OpenAPI artifacts, rendering PostgreSQL DDL, and generating plus applying reviewed migrations.

---

## Installation

```bash
npm install blendsdk
```

```bash
yarn add blendsdk
```

**Requirements**

- **Node.js** `>= 22.0.0` — the package is ESM-only (`"type": "module"`).
- **TypeScript** 5.x with `strict` enabled.
- **`pg`** — an optional peer dependency, required only by the database-backed APIs (`PostgreSQLIntrospector`, the migration runner). Type, Zod, constant, OpenAPI, and DDL generation work without it.

`blendsdk/codegen` is a workspace-internal package (`"private": true`). It is distributed through the assembled `blendsdk` package (MIT), which re-exports the same public API and ships the migration executable:

| Surface | Import / command |
| --- | --- |
| Assembled package (npm consumers) | `import { ... } from 'blendsdk/codegen'` |
| Workspace package (BlendSDK monorepo) | `import { ... } from 'blendsdk/codegen'` |
| Migration CLI | `npx blendsdk migrate <command>` |

The examples in this document use the `blendsdk/codegen` import path; the API is identical when imported from `blendsdk/codegen`.

---

## Quick Start

Define a data shape once and generate TypeScript from it:

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

scope.object({
  id: scope.number(),
  name: scope.string(),
  email: scope.string().optional(),
}).named('User');

const source = await new TypeGenerator().generate(schema);
console.log(source);
```

`generate()` is asynchronous because the emitted source is formatted before it is returned:

```typescript fragment
export interface User {
  id: number;
  name: string;
  email?: string;
}
```

---

## Fundamentals

### Defining a Data Shape

`SchemaContainer` is the root of the data-shape model. `schema.scope()` creates a `SchemaScope` whose factory methods produce schema objects: primitives (`string()`, `number()`, `boolean()`, `date()`, `any()`), `object({...})`, and `ref(other)` references. Root types are marked with `.named(...)`; modifiers such as `.optional()`, `.nullable()`, `.arrayed()`, and `.partial()` shape the generated output.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

const role = scope
  .object({
    id: scope.number(),
    label: scope.string(),
  })
  .named('Role');

const user = scope
  .object({
    id: scope.number(),
    displayName: scope.string(),
    email: scope.string().nullable(),
    roles: scope.ref(role).arrayed(),
    tags: scope.string().arrayed(),
  })
  .named('User');

const source = await new TypeGenerator().generate(schema);
console.log(source);
```

Key rules of the authoring model:

- Objects passed directly into `object({...})` are **inline properties**; they are rendered in place and may not be explicitly named.
- A `ref()` target must be a **named root object** — the generators throw `Referenced schema is not named!` otherwise.
- Call `.enum([...])` on a named primitive to emit a union: `scope.string().named('Status').enum(['active', 'inactive'])` generates `export type Status = "active" | "inactive";`.
- Call `.description('...')` on any object to carry documentation into every generated artifact.

### Generating TypeScript Types

Named scopes (`schema.scope('api_v1')`) prefix generated type names, so the same logical model can exist once per API version without collisions. Generated declarations carry JSDoc annotations (`@interface`, `@optional`, `@nullable`, `@partial`, `@memberOf`) that mirror the schema modifiers.

```typescript
import { mkdir, writeFile } from 'node:fs/promises';
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const api = schema.scope('api_v1');

api
  .object({
    userId: api.number(),
    displayName: api.string(),
    email: api.string().optional(),
  })
  .named('user_patch');

const source = await new TypeGenerator().generate(schema);

await mkdir('src/generated', { recursive: true });
await writeFile('src/generated/user-patch.ts', source, 'utf8');
```

The file written above contains:

```typescript fragment
export interface ApiV1UserPatch {
  userId: number;
  displayName: string;
  email?: string;
}
```

Modifier-to-TypeScript mapping:

| Schema modifier | Generated TypeScript |
| --- | --- |
| `.optional()` | `prop?: T` |
| `.nullable()` | `T \| null` |
| `.arrayed()` | `T[]` |
| `.partial()` | `Partial<T>` |
| `.recordSet()` | `Record<string, T>` |
| `.enum([...])` | union of literal values |
| `ref(named)` | reference to the named type |

`TypeGenerator` currently accepts no options; `TypeGeneratorOptions` is reserved for future use.

### Generating Zod Validators

`ZodGenerator` produces Zod v4 schemas from the same model, keeping runtime validation aligned with the generated types. The emitted source starts with `import * as z from 'zod';`, and each named object becomes an exported camel-cased constant.

```typescript
import { SchemaContainer, ZodGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

scope.object({
  id: scope.number(),
  email: scope.string().optional(),
}).named('User');

const source = await new ZodGenerator().generate(schema);
console.log(source);
```

The generated module looks like this:

```typescript fragment
import * as z from 'zod';
export const UserSchema = z.object({
  id: z.number(),
  email: z.string().optional(),
});
```

The variable suffix is configurable through `ZodGeneratorOptions.zodVariablePostfix` (default `'schema'`):

```typescript
import { ZodGenerator } from 'blendsdk/codegen';

const generator = new ZodGenerator({ zodVariablePostfix: 'validator' });
// A named object `User` now emits `export const UserValidator = ...`
```

### Generating Column Constants

`CTypeGenerator` emits `e<Name>` constant objects that map `$TABLE` and every column name for type-safe query code. It consumes a `ConstantType` map — typically collected by the introspector (see *Introspecting an Existing Database*), but any map of relation names to column lists works.

```typescript
import { CTypeGenerator, type ConstantType } from 'blendsdk/codegen';

const constants: ConstantType = {
  customer: ['id', 'email', 'status'],
};

const source = await new CTypeGenerator().generate(constants);
console.log(source);
```

Output:

```typescript fragment
export const eCustomer = {
  $TABLE: 'customer',
  ID: 'id',
  EMAIL: 'email',
  STATUS: 'status',
};
```

### Generating an OpenAPI Document

`OpenAPIGenerator` documents `blendsdk/webafx` routes as an OpenAPI v3.1 document. Controllers are added with `addController(basePath, ControllerClass)`; only routes that carry `.openapi()` metadata are included — the opt-in mechanism.

```typescript
import { OpenAPIGenerator } from 'blendsdk/codegen';
import { ProductsController } from './controllers/products.controller.js';

const generator = new OpenAPIGenerator({
  title: 'Catalog API',
  version: '1.0.0',
  description: 'Product catalog endpoints.',
  servers: [{ url: 'https://api.example.com', description: 'Production' }],
  securitySchemes: {
    bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  },
  defaultSecurity: [{ bearerAuth: [] }],
});

generator.addController('/api/products', ProductsController);
generator.toFile('./openapi.json');
```

How routes are mapped:

- `:param` path segments become `{param}`, and each path parameter is emitted as a required `path` parameter.
- POST/PUT/PATCH validation schemas become the JSON request body; GET/DELETE validation schemas become query parameters. Properties with Zod defaults are not required.
- Zod transforms are documented by their **input** type — what the API consumer actually sends.
- Routes marked `secure` receive the configured `defaultSecurity`; unsecured routes get no `security` entry.
- `generate()` returns the document object, `toJSON(indent?)` returns a JSON string, and `toFile(path)` writes it (creating parent directories). Route arrays built elsewhere can be added with `addRoutes(basePath, routeDefinitions)`.

### Modeling a PostgreSQL Database

`DatabaseSchema` is the relational authoring model. Table helpers create typed columns, and the fluent constraint and index APIs attach keys, checks, foreign keys, and indexes.

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const database = new DatabaseSchema('app');

const customer = database.table('customer', table => {
  table.bigint('id').primaryKey();
  table.varchar('email', 255).unique();
  table.text('status').default('active', true);
  table.timestamp('created_at').default('now()');
});

database.table('order', table => {
  table.bigint('id').primaryKey();
  table.bigint('customer_id').references(customer, 'id', 'CASCADE', 'CASCADE');
  table.decimal('total', 12, 2);
  table.index().column('customer_id').indexName('order_customer_idx');
});

console.log(customer.getName());
```

Additional model capabilities:

- Column helpers exist for every supported PostgreSQL type (`integer`, `serial`, `bigserial`, `numeric`, `uuid`, `jsonb`, `tsvector`, `vector`, and more).
- `table.scope('inventory')` places a table in a named schema; `database.table(...)` uses the default scope (`public` unless you pass a second constructor argument).
- `column.check('...')` adds a check constraint, `column.identity('ALWAYS', {...})` declares an identity column, and `column.generated('...')` declares a stored generated column.
- `.comment('...')` on tables, columns, and views flows into `COMMENT ON` statements.

```typescript fragment
database.extension('pgcrypto');
database
  .view('active_customer')
  .scope('reporting')
  .as("SELECT id, email FROM customer WHERE status = 'active'");
```

### Rendering Initializer DDL

`PostgreSQLSchemaGenerator` renders the desired state of a `DatabaseSchema` as complete, deterministic DDL for provisioning a fresh database — the initializer used for local, test, and CI environments. Existing databases evolve through the snapshot-based workflow covered in the later sections.

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const database = new DatabaseSchema('app');

const customer = database.table('customer');
customer.bigint('id').primaryKey();
customer.varchar('email', 255).unique();

const generator = new PostgreSQLSchemaGenerator(database);

const { schema, indexes, views } = generator.generateGrouped();
console.log(schema);
console.log(indexes);
console.log(views);
```

- `generateGrouped()` returns `{ schema, indexes, views, all }` so each DDL section can be applied or reviewed separately.
- `generate()` returns everything as one string (equivalent to `generateGrouped().all`).
- Tables and non-default schemas are dropped before creation unless you pass `{ dropBeforeCreate: false }`.

### Introspecting an Existing Database

`PostgreSQLIntrospector` reads a live catalog — tables, partitioned tables, views, materialized views, composite types, enum types, and domains — into a `SchemaContainer`, so the existing generators can run against a database you did not model by hand. It requires a `PostgreSQLDatabase` connection from `blendsdk/postgresql` and the `pg` peer dependency.

```typescript fragment
const schema = new SchemaContainer();
const introspector = new PostgreSQLIntrospector(db);

await introspector.introspect(schema);

const types = await new TypeGenerator().generate(schema);
```

`db` is a connected `PostgreSQLDatabase` from `blendsdk/postgresql`. Columns whose PostgreSQL type has no built-in mapping are emitted as a deprecated `any` alias with a console warning; pass a `ColumnMapper` as the second argument to `introspect()` to override the mapping per column:

```typescript fragment
const mapper: ColumnMapper = (column, scope) =>
  column.pg_type === 'interval' ? scope.string().description('PostgreSQL interval') : undefined;

await introspector.introspect(schema, mapper);
```

The same instance also collects column-name constants for the `CTypeGenerator`:

```typescript fragment
const constants = await introspector.introstectConstantTypes();
const source = await new CTypeGenerator().generate(constants);
```

### Generating and Applying Migrations

Migrations are the reviewed, checksummed path for evolving an existing database. Start with two files: a configuration and a schema module that exports the desired state.

**1. Author the configuration and schema**

`blendsdk.migrations.ts`:

```typescript
import { defineMigrationConfig } from 'blendsdk/codegen';

export default defineMigrationConfig({
  schema: './schema.ts',
  migrationsDir: './migrations',
  databaseUrlEnv: 'DATABASE_URL',
});
```

`schema.ts`:

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');
const customer = schema.table('customer');

customer.bigint('id').primaryKey();
customer.text('email');
customer.text('status').default('active', true);

export default schema;
```

The configuration is discovered by searching upward for the nearest `blendsdk.migrations.ts`, or passed explicitly with `--config`.

**2. Run the lifecycle from the CLI**

```bash
# Create the first migration and canonical snapshot for a new lineage.
npx blendsdk migrate baseline initial

# Apply pending migrations (dataset-scoped advisory lock, checksummed history).
npx blendsdk migrate up

# Inspect state without changing anything.
npx blendsdk migrate status
npx blendsdk migrate validate --offline
```

The daily loop is: edit the schema, run `blendsdk migrate generate <name>`, review the generated SQL, and commit the migration together with the refreshed snapshot.

| Command | Purpose |
| --- | --- |
| `blendsdk migrate baseline <name>` | Create the first offline migration and canonical snapshot for a new lineage. |
| `blendsdk migrate generate <name>` | Diff the desired schema against the snapshot and publish the next immutable migration. |
| `blendsdk migrate create <name>` | Create an empty, hand-written migration pair with null lineage. |
| `blendsdk migrate up` | Apply all pending migrations under the database-scoped advisory lock. |
| `blendsdk migrate down` | Revert the latest migration; requires explicit confirmation. |
| `blendsdk migrate status` | Print the current lifecycle status. |
| `blendsdk migrate validate` | Validate local history against applied rows; `--offline` skips connecting to PostgreSQL. |
| `blendsdk migrate adopt-baseline` | Record initial history for an existing database after a structural comparison proves it matches the baseline; requires explicit confirmation. |

**3. Or drive the same lifecycle from TypeScript**

```typescript
import { generateMigration, runMigrations } from 'blendsdk/codegen';

const configPath = './blendsdk.migrations.ts';

const generated = await generateMigration({ name: 'add-customer-status', configPath });
console.log(generated.status); // 'GENERATED' when a migration was published, 'UP_TO_DATE' otherwise

const preview = await runMigrations({ command: 'up', configPath, dryRun: true });
console.log(preview.migrations.map(migration => migration.id));

const applied = await runMigrations({ command: 'up', configPath });
console.log(applied.status);
```

Public migration APIs:

| Function | Purpose |
| --- | --- |
| `runMigrations(options)` | Run a lifecycle command (`up`, `down`, `status`, `validate`) with `dryRun`, `allowDown`, and `signal` options. |
| `generateMigration(options)` | Compare the desired schema with the committed snapshot and publish the next migration plus refreshed snapshot. |
| `generateBaseline(options)` | Create the first offline migration and canonical snapshot for a new lineage. |
| `adoptBaseline(options)` | Prove an existing database matches the baseline and record its initial history. |
| `getMigrationStatus(options)` | Read the current lifecycle status (programmatic form of `migrate status`). |
| `validateMigrations(options)` | Validate local history (programmatic form of `migrate validate`). |
| `defineMigrationConfig(config)` | Author a typed `blendsdk.migrations.ts` configuration. |
| `formatMigrationError(error)` | Render a sanitized, single-line diagnostic. |

---

## Configuration

### Migration Configuration

Authored with `defineMigrationConfig` in `blendsdk.migrations.ts`:

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `schema` | `string` | — | Module (usually a TypeScript file) whose default export is the desired-state `DatabaseSchema`. Resolved relative to the config file; required by generation commands. |
| `migrationsDir` | `string` | `<configDirectory>/migrations` | Directory that stores immutable migration files. Must resolve inside the config directory. |
| `snapshotFile` | `string` | `<configDirectory>/migrations/schema.snapshot.json` | Canonical desired-state snapshot that generation diffs against. |
| `databaseUrlEnv` | `string` | `'DATABASE_URL'` | Name of the environment variable holding the PostgreSQL connection string. Credentials are never stored in the config file. |
| `lockTimeoutMs` | `number` | `5000` | Maximum wait for the database-scoped advisory lock before a run fails with `LOCKED`. |
| `statementTimeoutMs` | `number` | `900000` | Per-statement timeout applied to the migration connection. |

Unknown keys, non-positive timeouts, invalid environment variable names, and artifact paths that escape the config directory (including through symlinks) are rejected as configuration errors with exit code `2`.

### Generator Options

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `ZodGeneratorOptions.zodVariablePostfix` | `string` | `'schema'` | Suffix appended to generated Zod variable names (`User` → `UserSchema`). |
| `GenerateOptions.dropBeforeCreate` | `boolean` | `true` | Include `DROP SCHEMA` / `DROP TABLE` statements before creation in generated initializer DDL. |
| `OpenAPIGeneratorConfig.title` | `string` | — | Required API title placed in the document's `info` section. |
| `OpenAPIGeneratorConfig.version` | `string` | — | Required API version. |
| `OpenAPIGeneratorConfig.description` | `string` | omitted | Optional API description (Markdown supported). |
| `OpenAPIGeneratorConfig.servers` | `OpenAPIServer[]` | omitted | Server entries; an empty array omits the `servers` section entirely. |
| `OpenAPIGeneratorConfig.securitySchemes` | `Record<string, OpenAPISecurityScheme>` | omitted | Reusable security schemes; when omitted, no `components` section is emitted. |
| `OpenAPIGeneratorConfig.defaultSecurity` | `SecurityRequirement[]` | omitted | Security applied to routes marked `secure`; without it, secure routes receive an empty requirement array. |
| `TypeGeneratorOptions` | `GeneratorOptions` | `{}` | Reserved for future use; the TypeScript and constant-type generators take no options today. |

### Environment

| Variable | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` (or the name set in `databaseUrlEnv`) | `PostgreSQLIntrospector`, `up`, `down`, `status`, `validate` (without `--offline`), `adopt-baseline` | PostgreSQL connection string. Never written to generated artifacts, and credentials are redacted from every diagnostic. |

---

## Error Handling

`blendsdk/codegen` has two failure families:

- **Typed migration failures** — the migration APIs throw `MigrationError` (or report a soft status, see below). Every instance exposes `kind`, `exitCode` (`1` for operational failures, `2` for usage/configuration errors), and an already-sanitized `message`.
- **Authoring and generation errors** — building an invalid model or generating from it throws ordinary `Error`. Examples: a foreign key pointing at a column that does not exist, requesting `VIRTUAL` generated columns (PostgreSQL only supports `STORED`), referencing an unnamed schema, or explicitly naming an object used as a property.

### Migration Error Kinds

| Kind | Exit code | Meaning |
| --- | --- | --- |
| `CONFIGURATION` | `2` | The migration config could not be loaded or is invalid: unknown keys, unsupported paths, invalid environment variable names, invalid timeouts, or a missing confirmation token for adoption. |
| `INVALID_HISTORY` | `1` | Local artifacts and applied history are not an exact, checksummed prefix: malformed headers, a missing snapshot, an edited applied file, torn lineage, or invalid ledger rows. |
| `FILESYSTEM` | `1` | An artifact could not be published safely: an existing migration target, a symlinked or unsafe path, a failed write/flush/verify, or a failed snapshot rename. |
| `DATABASE` | `1` | PostgreSQL rejected or lost the migration work: failing SQL, a statement timeout, or a dropped connection. Transactional work is rolled back. |
| `LOCKED` | `1` | Another migration run holds the database-scoped advisory lock and did not release it within `lockTimeoutMs`. |
| `UNKNOWN_OUTCOME` | `1` | A nontransactional migration lost its session after dispatch; the ledger keeps a `NONTRANSACTIONAL_DIRTY` marker that requires manual verification. |
| `ABORTED` | `1` | The run was cancelled through the `signal` option (for example `SIGINT`/`SIGTERM` in the CLI). |
| `UNSUPPORTED` | `1` | A structural step cannot be performed automatically — an adoption comparison mismatch, an opaque view change, or a blocked transition such as a type change that needs a manual `USING` clause. |

### Soft Statuses

`status`, `validate`, and dry-run `up` report through the returned `MigrationCommandResult.status` instead of throwing:

| Status | Meaning | Typical handling |
| --- | --- | --- |
| `UP_TO_DATE` | Local history and the applied ledger prefix match; nothing is pending. | No action. |
| `PENDING` | One or more migrations are not applied yet; `migrations` lists them in order. | Run `up`, or inspect with `dryRun` first. |
| `INVALID_HISTORY` | Local files and applied rows disagree, or artifacts are malformed. | Stop. Remove the orphaned artifact or restore the snapshot from version control; never hand-edit applied rows. |
| `LOCKED` | Another migration run holds the advisory lock. | Retry after the competing run finishes. |
| `UNKNOWN_OUTCOME` | A nontransactional migration needs manual verification. | Verify the effects manually before doing anything else. |

### Handling a Typed Failure

```typescript
import { MigrationError, formatMigrationError, runMigrations } from 'blendsdk/codegen';

async function applyMigrations(): Promise<void> {
  try {
    const result = await runMigrations({
      command: 'up',
      configPath: './blendsdk.migrations.ts',
    });
    console.log(`Migration run finished with status ${result.status}.`);
  } catch (error) {
    if (error instanceof MigrationError) {
      console.error(formatMigrationError(error));
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }
}

await applyMigrations();
```

### Handling an Authoring Error

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');
const customer = schema.table('customer');
customer.bigint('id').primaryKey();

try {
  // `status` is not a column of `customer`, so the foreign key cannot be created.
  customer.bigint('status_id').references(customer, 'status');
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message);
  }
}
```

### Diagnostics Are Safe by Design

- Connection URLs are replaced with `[REDACTED_DATABASE_URL]` and `password=` values with `[REDACTED]`; SQL bodies are never included in messages.
- `formatMigrationError(error)` renders `KIND: message` on a single line, suitable for logs and CI output.
- The CLI prints results to stdout, prints a single sanitized diagnostic to stderr for failures, and maps outcomes to exit codes `0` (success), `1` (operational failure), and `2` (usage or configuration error).
- The package never auto-repairs migration history. Recovery is always an explicit, auditable manual step — the CLI deliberately has no force/fake/repair bypass.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
