> **Package**: `blendsdk/codegen`

# codegen Core Concepts

This document is the deep dive. It walks each public abstraction in turn: what it is, how the mechanism works, a complete example, and a reference table. The Overview is the map; this is the territory.

Two naming collisions are worth resolving before anything else:

- **"Schema" means two different things.** `SchemaContainer` / `SchemaScope` author *data shapes* (the input to `TypeGenerator` and `ZodGenerator`). `DatabaseSchema` authors a *desired PostgreSQL database* (the input to `PostgreSQLSchemaGenerator` and to migration generation). They share no base class.
- **Bootstrapping is not migrating.** `PostgreSQLSchemaGenerator` renders complete DDL from scratch and knows nothing about prior state. The incremental migration workflow (`generateMigration` → reviewed SQL → `runMigrations`) diffs a committed snapshot against the desired model and never rewrites applied history. Read [PostgreSQLSchemaGenerator — Bootstrap DDL](#postgresschemagenerator--bootstrap-ddl-not-a-migration) and [Incremental Migration Generation](#incremental-migration-generation) as separate, non-interchangeable concepts.

| Layer | Concepts in this document |
| --- | --- |
| Shape authoring | Schema Container and Scopes · Schema Objects and Modifiers · `TypeGenerator` · `ZodGenerator` |
| Database authoring | The `DatabaseSchema` Authoring Model · `PostgreSQLSchemaGenerator` |
| Catalog reading | `PostgreSQLIntrospector` · `CTypeGenerator` |
| HTTP contracts | `OpenAPIGenerator` · Zod → OpenAPI Conversion · Typed API Client Generation · The API Contract |
| Migrations | Migration Configuration · Incremental Migration Generation · The Migration Runner · Baseline Generation and Adoption · `MigrationError` and Exit Codes |

---

## Schema Container and Scopes

### What It Is

`SchemaContainer` is the registry that owns every schema object you create, and `SchemaScope` is the factory you create them through. A container is the single argument to every generator in the package: you build a graph once, then render it as TypeScript and as Zod without re-describing anything. Scopes give the same shape different identities in different namespaces — `api_v1.user_request` and `api_v2.user_request` can coexist, render as `ApiV1UserRequest` and `ApiV2UserRequest`, and never collide.

### How It Works

`container.scope(name?)` returns a `SchemaScope` bound to `name`. Every factory method on the scope (`string()`, `object()`, `ref()`, …) creates a schema object, stamps it with that scope, and **immediately registers it** in the container — naming is a separate step.

- `named(value)` calls `container.assert(value, scope)` first, so a duplicate identity inside the same scope throws instead of silently shadowing. Only after the assert does it set the name.
- The **default scope is `undefined`**, not `"public"`. `container.find(undefined, 'customer')` is how you look up an unscoped object; `scope.find('customer')` is the scoped shorthand.
- Unnamed objects are legal and common: a property of an object is an unnamed schema object that only renders inline. Generators skip unnamed objects at the top level and render them through their parent.
- `getNamedScoped()` joins scope and name with `.`; generators PascalCase that joined string (dots and underscores become word boundaries), which is where `ApiV1UserRequest` comes from.

### Complete Example

```typescript
import { SchemaContainer } from 'blendsdk/codegen';

const container = new SchemaContainer();
const base = container.scope();
const apiV1 = container.scope('api_v1');

const customer = base
  .object({
    id: base.number(),
    email: base.string(),
  })
  .named('customer');

apiV1
  .object({
    customer: apiV1.ref(customer).nullable(),
  })
  .named('customer_response');

const named = container
  .getAll()
  .filter(schema => schema.getName() !== undefined)
  .map(schema => schema.getNamedScoped());

console.log(named); // [ 'customer', 'api_v1.customer_response' ]
console.log(container.find(undefined, 'customer') === customer); // true
console.log(container.find('api_v1', 'customer') === customer); // false
```

Repeating `base.object({ ... }).named('customer')` throws `Schema object already exists customer`. That failure is the feature: a reference can never resolve to the wrong shape.

### Key Methods and Properties

**`SchemaContainer`**

| Name | Signature | Description |
| --- | --- | --- |
| `scope` | `scope(name?: string): SchemaScope` | Creates a factory bound to `name`; omit for the default scope |
| `find` | `find(scope: string \| undefined, name: string)` | Returns the registered object or `undefined` |
| `getAll` | `getAll()` | Every registered object, in creation order, named or not |
| `clear` | `clear()` | Empties the registry and its identity index |
| `add` | `add(obj)` | Registers an object and enforces its identity |
| `assert` | `assert(name, scope)` | Throws when `<scope>.<name>` is already taken |

**`SchemaScope`**

| Name | Signature | Description |
| --- | --- | --- |
| `string` / `number` / `boolean` / `date` / `bigint` | `(): <PrimitiveSchema>` | Primitive factories; the returned object is already registered |
| `binary` | `binary(): BinarySchema` | PostgreSQL `bytea` shape — TypeScript `Buffer`, Zod `z.instanceof(Buffer)` |
| `any` / `unknown` | `(): AnySchema` | `any` / `unknown`; `unknown` is the default for `json` and `jsonb` |
| `object` | `object(properties: ObjectProps): ObjectSchema` | Object with inline properties |
| `ref` | `ref(obj): ReferenceSchema` | Alias to an existing named object |
| `find` | `find(name: string)` | `container.find(this._scope, name)` |

---

## Schema Objects and Modifiers

### What It Is

Every value in a container is a schema object — a small fluent record carrying a TypeScript type, a Zod type, and a set of modifier flags. Modifiers do not change the underlying type; they change how the generators wrap it. That separation is why one authored shape renders correctly into both a compile-time type and a runtime validator.

### How It Works

The concrete classes are `StringSchema`, `NumberSchema`, `BooleanSchema`, `DateSchema`, `BinarySchema`, `BigIntSchema`, `ObjectSchema`, `ReferenceSchema`, and `AnySchema`. Each carries internal `tsType` / `zodType` data plus flags: `optional`, `nullable`, `partial`, `arrayed`, `recordOf`, `parent`, `rendered`.

Modifiers are applied in a fixed order by every generator:

```text
Partial<T>   →   T[]   →   Record<string, T>   →   T | null
    partial        arrayed        recordSet           nullable
```

`optional` is different — it only affects how an *object property* is emitted (`name?:`). On a root alias it has no effect, because there is no property to mark.

`StringSchema` additionally validates its constraints at authoring time rather than at generation time: `pattern` compiles the source (and rejects an empty pattern or a flagged `RegExp`), `minLength` / `maxLength` reject non-integers and reject a minimum above an existing maximum. Those constraints then flow into three artifacts: JSDoc in TypeScript, `.regex()` / `.min()` / `.max()` in Zod, and `pattern` / `minLength` / `maxLength` in OpenAPI.

### Complete Example

```typescript
import { SchemaContainer, TypeGenerator, ZodGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

const slug = scope.string().pattern('^[a-z0-9-]+$').minLength(3).maxLength(40);

scope
  .object({
    slug,
    tags: scope.string().arrayed(),
    settings: scope.unknown().recordSet(),
    profile: scope
      .object({
        displayName: scope.string().optional(),
        website: scope.string().nullable(),
      })
      .partial(),
  })
  .named('workspace');

const types = await new TypeGenerator().generate(container);
const validators = await new ZodGenerator().generate(container);

console.log(types);
console.log(validators);
```

`types` contains `export interface Workspace` whose `tags` is `string[]`, `settings` is `Record<string, unknown>`, and `profile` is an inline `Partial<{ displayName?: string; website: string | null; }>` with `@pattern ^[a-z0-9-]+$`, `@minLength 3`, and `@maxLength 40` recorded on `slug`.

### Key Methods and Properties

**Shared modifiers (`SchemaObject`)**

| Name | Signature | Description |
| --- | --- | --- |
| `optional` | `optional(): this` | Emits `name?:` for a property; no effect on a root alias |
| `nullable` | `nullable(): this` | Wraps the type as `T \| null` |
| `arrayed` | `arrayed(): this` | Wraps the type as `T[]` |
| `partial` | `partial(): this` | Wraps the type as `Partial<T>` |
| `recordSet` | `recordSet(): this` | Wraps the type as `Record<string, T>` |
| `description` | `description(text: string \| string[], prefix?: boolean): this` | Appends (or prepends) JSDoc lines |
| `named` | `named(value: string): this` | Asserts uniqueness in the current scope, then names the object |
| `scope` | `scope(value?: string): this` | Moves the object into another scope (asserted) |
| `metadata` | `metadata(data: Record<string, unknown>): void` | Attaches generator-specific metadata (no chaining) |
| `getName` / `getScope` / `getNamedScoped` | `(): string \| undefined` / `(): string \| undefined` / `(): string` | Identity accessors |

**`StringSchema` constraints**

| Name | Signature | Description |
| --- | --- | --- |
| `pattern` | `pattern(value: string \| RegExp): this` | Stores the regex **source**; throws on an empty or invalid pattern, or on a flagged `RegExp` |
| `minLength` | `minLength(value: number): this` | Non-negative integer; cannot exceed an existing `maxLength` |
| `maxLength` | `maxLength(value: number): this` | Non-negative integer; cannot fall below an existing `minLength` |
| `enum` | `enum(values: string[] \| number[]): this` | Replaces the rendered type with a literal union |

---

## TypeGenerator

### What It Is

`TypeGenerator` renders a `SchemaContainer` into a formatted TypeScript module. It is the compile-time half of the "one source, two artifacts" story: the interface it emits is what the compiler checks against, so a shape change breaks the build rather than a request at 3 a.m.

### How It Works

Generation is a single pass over `container.getAll()`:

1. Every object's `rendered` flag is reset.
2. Objects are visited in creation order. An object renders at the top level only when it **has a name and has not already been rendered**.
3. A named object with a parent throws — you cannot name a property; create a separate root shape and `.ref()` it instead.
4. Unnamed property objects are rendered inline by their parent, recursively.

The declaration form follows one rule: a root-level `ObjectSchema` with no `partial` / `arrayed` / `nullable` modifier becomes `export interface`; everything else — primitives, enums, references, modified objects, and nested objects — becomes `export type`. References render as an alias to the target's type name and mark the target rendered, so a shared shape appears once.

Descriptions accumulate into a JSDoc block that always records the declaration kind and every applied modifier (`@interface`, `@type`, `@optional`, `@nullable`, `@array`, `@partial`, `@pattern`, `@minLength`, `@maxLength`, `@memberOf {Type}`). Comment terminators inside a description or pattern are escaped, so a hostile pattern cannot close the comment and escape into code.

The joined output is handed to Prettier with the repository's options, which is why two runs over the same graph are byte-identical.

### Complete Example

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

const status = scope.string().enum(['draft', 'published']).named('status');

scope
  .object({
    id: scope.number(),
    status: scope.ref(status),
    tags: scope.string().arrayed(),
    address: scope.object({
      line1: scope.string(),
      line2: scope.string().optional(),
    }),
  })
  .named('article');

const source = await new TypeGenerator().generate(container);

console.log(source);
```

The emitted module declares `export type Status = 'draft' | 'published';` first (an enum is just a literal union), then `export interface Article` whose `status` references `Status`, whose `address` is inlined, and whose JSDoc block records `@interface`.

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `generate` | `generate(container: SchemaContainer): Promise<string>` | Renders and Prettier-formats the whole container |
| `TypeGeneratorOptions` | `interface TypeGeneratorOptions extends GeneratorOptions {}` | Reserved; currently empty |

| Authored shape | Emitted declaration |
| --- | --- |
| Root object, no modifiers | `export interface Name { … }` |
| Root object with `.partial()` / `.arrayed()` / `.nullable()` | `export type Name = Partial<{…}>` (or the equivalent wrapper) |
| Root primitive or enum | `export type Name = string;` / `export type Name = 'a' \| 'b';` |
| Root reference | `export type Name = TargetType;` |
| Unnamed object property | Inline `{ … }` in the parent |

---

## ZodGenerator

### What It Is

`ZodGenerator` renders the same `SchemaContainer` into a Zod validator module. Where `TypeGenerator` produces a promise the compiler enforces, `ZodGenerator` produces a promise the runtime enforces — the same field names, the same optionality, the same string constraints, evaluated against real payloads at the edge.

### How It Works

The constructor seeds the output with `import * as z from 'zod';`. Each named schema becomes `export const <PascalScoped>Schema = …`, where the suffix comes from the `zodVariablePostfix` option (default `schema`). Traversal, naming, and inline rendering mirror `TypeGenerator` exactly.

Modifier order matters and is fixed: string constraints first, then `.partial()`, `.optional()`, then `.nullable()`. Applying `.optional()` before `.regex()` would produce a Zod type whose regex is unreachable, so the ordering is a correctness guarantee, not a style choice.

Two primitives deserve attention:

- `scope.binary()` renders as `z.instanceof(Buffer)`, because `pg` returns a Node `Buffer` for `bytea`. It cannot be expressed as `z.<type>()`, so the schema carries a raw Zod expression instead.
- `scope.unknown()` renders as `z.unknown()` — the default for `json` and `jsonb`, where the shape is genuinely unknown and inventing one would be a lie.

A stored pattern that no longer compiles is reported with the generated variable name, so the diagnostic points at the schema you wrote rather than at a bare regex.

### Complete Example

```typescript
import { SchemaContainer, ZodGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

scope
  .object({
    email: scope.string().pattern('^[^@\\s]+@[^@\\s]+$').maxLength(320),
    nickname: scope.string().optional().nullable(),
    avatar: scope.binary().optional(),
    preferences: scope.unknown(),
  })
  .named('profile');

const source = await new ZodGenerator().generate(container);

console.log(source);
```

The emitted module imports `zod` as a namespace, then declares `ProfileSchema` with `z.string().regex(new RegExp('^[^@\\s]+@[^@\\s]+$')).max(320)` for `email`, `z.string().optional().nullable()` for `nickname`, `z.instanceof(Buffer).optional()` for `avatar`, and `z.unknown()` for `preferences`.

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `generate` | `generate(container: SchemaContainer): Promise<string>` | Renders and Prettier-formats the validator module |
| `ZodGeneratorOptions.zodVariablePostfix` | `string` (default `'schema'`) | Suffix appended to the PascalCase identity of each variable |

| Authored shape | Emitted expression |
| --- | --- |
| `scope.string()` with constraints | `z.string().regex(new RegExp("…")).min(n).max(n)` |
| `scope.number()` / `boolean()` / `date()` | `z.number()` / `z.boolean()` / `z.date()` |
| `scope.unknown()` | `z.unknown()` |
| `scope.binary()` | `z.instanceof(Buffer)` |
| `scope.object({ … })` | `z.object({ … })` |
| reference property | The referenced `<Name>Schema` constant |

---

## The DatabaseSchema Authoring Model

### What It Is

`DatabaseSchema` is the fluent model of a desired PostgreSQL database: schemas, extensions, tables, columns, primary keys, unique/check/foreign-key constraints, indexes, and views. It is the single input to bootstrap DDL rendering and to incremental migration generation, which means a table you describe once is both creatable from scratch and diffable against a committed snapshot.

### How It Works

`new DatabaseSchema(name, defaultScope?)` sets a default scope (`'public'` when omitted). `table(name, builder?)` creates a `TableSchema`, applies the default scope, runs the optional builder, then appends it — so a builder can call column helpers without holding a reference. `view(name)` does the same for `ViewSchema`. `extension(...names)` records extensions requested by the model; `identity('v4')` on a `uuid` column appends `uuid-ossp` automatically.

Columns are created through typed table helpers (`text`, `varchar`, `bigserial`, `numeric`, `jsonb`, `bytea`, `inet`, `uuid`, …) which set the type and return a `TableColumnSchema` for chaining. Constraints are created through the table (`foreignKeyConstraint`, `uniqueConstraint`, `checkConstraint`, `index`, `primaryKey`) and configured through the returned constraint object.

Two details are worth pinning:

- **Deferrability is explicit and validated.** `foreignKeyConstraint(t).from(...).to(...).deferrable('DEFERRED')` marks the constraint `DEFERRABLE INITIALLY DEFERRED`; `'IMMEDIATE'` marks it `DEFERRABLE INITIALLY IMMEDIATE`. The mode is validated at call time because the value is rendered into DDL and may arrive from untyped JavaScript.
- **Primary keys are read without side effects.** `primaryKey()` creates the constraint if absent (the authoring path); `getPrimaryKey()` only reads it (the normalization path). That split is what lets the migration normalizer inspect a schema without mutating it.

Foreign-key default actions are `ON DELETE RESTRICT` and `ON UPDATE CASCADE` unless you override them.

### Complete Example

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const database = new DatabaseSchema('shop', 'public');
database.extension('pgcrypto');

const customers = database.table('customers').comment('Customer records');
customers.bigserial('id').primaryKey();
customers.text('email').unique();
customers.timestamptz('created_at').default('now()');
customers.text('nickname').nullable();

const orders = database.table('orders').comment('Placed orders');
orders.bigserial('id').primaryKey();
orders.bigint('customer_id');
orders.numeric('total', 12, 2);
orders.text('status').default('draft', true);
orders.checkConstraint('total >= 0');
orders.uniqueConstraint().column('customer_id', 'status');
orders
  .foreignKeyConstraint(customers)
  .from('customer_id')
  .to('id')
  .onDelete('CASCADE')
  .deferrable('DEFERRED');
orders.index().indexName('orders_customer_idx').column('customer_id').where('total > 0');

database.table('audit_log', table => {
  table.bigserial('id').primaryKey();
  table.text('action');
});

database
  .view('open_orders')
  .as('SELECT id, total FROM public.orders WHERE status IS NOT NULL')
  .comment('Orders awaiting completion');

console.log(database.getTables().map(table => table.getName()));
console.log(database.getExtensions());
```

### Key Methods and Properties

**`DatabaseSchema`**

| Name | Signature | Description |
| --- | --- | --- |
| `table` | `table(name: string, builder?: (table: TableSchema) => void): TableSchema` | Creates, scopes, builds, and appends a table |
| `view` | `view(name: string): ViewSchema` | Creates and scopes a view |
| `extension` | `extension(...names: string[]): this` | Records required extensions; duplicates are collapsed at render time |
| `getTables` / `getViews` / `getExtensions` | `(): TableSchema[]` / `(): ViewSchema[]` / `(): string[]` | Authoring collections |
| `getDefaultSchema` | `(): string` | The default scope used for new tables and views |

**`TableSchema`**

| Name | Signature | Description |
| --- | --- | --- |
| `integer` / `varchar` / `serial` / `bigserial` / `smallint` / `bigint` / `decimal` / `numeric` / `real` / `doublePrecision` / `char` / `text` / `boolean` / `date` / `time` / `timestamp` / `timestamptz` / `json` / `jsonb` / `bytea` / `inet` / `uuid` / `vector` / `tsvector` | `(name: string, …args): TableColumnSchema` | Column factories; width/precision arguments are positional |
| `primaryKey` | `primaryKey(): PrimaryKeyConstraint` | Creates or returns the table's primary key |
| `getPrimaryKey` | `getPrimaryKey(): PrimaryKeyConstraint \| undefined` | Reads without creating |
| `foreignKeyConstraint` | `foreignKeyConstraint(toTable: TableSchema): ForeignKeyConstraint` | Creates and appends a foreign key |
| `uniqueConstraint` | `uniqueConstraint(): UniqueConstraint` | Creates and appends a unique constraint |
| `checkConstraint` | `checkConstraint(rule: string): this` | Appends a table-level `CHECK` |
| `index` | `index(): IndexConstraint` | Creates and appends an index |
| `getForeignKeyConstrains` | `(): ForeignKeyConstraint[]` | Historical spelling of the getter |
| `getUniqueConstraints` / `getCheckConstraints` / `getIndexes` | `(): …[]` | Authoring collections |

**`TableColumnSchema`**

| Name | Signature | Description |
| --- | --- | --- |
| `primaryKey` | `primaryKey(): this` | Adds the column to the primary key, adds a unique constraint, forces `NOT NULL` |
| `unique` | `unique(): this` | Adds a single-column unique constraint |
| `nullable` | `nullable(): this` | Drops `NOT NULL` |
| `default` | `default(value: string \| number \| boolean, quote?: boolean): this` | `quote: true` wraps a string in single quotes |
| `references` | `references(toTable: TableSchema, column: string, onUpdate?, onDelete?): this` | Convenience foreign key; actions are `CASCADE \| RESTRICT \| SET NULL \| SET DEFAULT \| NO ACTION` |
| `generated` | `generated(expression: string, stored?: 'STORED' \| 'VIRTUAL'): this` | PostgreSQL only supports `STORED`; `VIRTUAL` throws |
| `identity` | `identity(generation?: 'ALWAYS' \| 'BY DEFAULT' \| 'v4' \| 'v7' \| string, options?): this` | Integer identity, or a UUID default (`gen_random_uuid()`, `uuid_generate_v4()`, `uuid_generate_v7()`) |
| `size` / `scale` | `(value: number): void` | Width and scale; these do **not** return `this` |
| `getType` / `getSize` / `getScale` / `getDefault` / `getNullable` | `()` | Read accessors used by generators |
| `isGenerated` / `isGeneratedStored` / `isIdentity` / `getIdentityGeneration` / `getIdentityOptions` | `()` | Identity and generated-column introspection |

**`ForeignKeyConstraint`** / **`IndexConstraint`** / **`ViewSchema`**

| Name | Signature | Description |
| --- | --- | --- |
| `from` | `from(...columns: string[]): this` | Local columns (foreign key) |
| `to` | `to(...columns: string[]): this` | Referenced columns |
| `onUpdate` / `onDelete` | `(action?: ReferentialAction): this` | Referential actions |
| `deferrable` | `deferrable(mode: 'DEFERRED' \| 'IMMEDIATE'): this` | `DEFERRABLE INITIALLY <mode>`; invalid modes throw |
| `isDeferrable` / `isInitiallyDeferred` | `(): boolean` | Read accessors |
| `unique` / `using` / `where` / `indexName` / `concurrent` / `include` / `expression` / `with` / `tablespace` | `(…): this` | Index configuration, rendered in that order |
| `as` / `materialized` / `scope` / `comment` | `(…): this` | View definition, materialization, scope, comment |

---

## PostgreSQLSchemaGenerator — Bootstrap DDL, Not a Migration

### What It Is

`PostgreSQLSchemaGenerator` turns a `DatabaseSchema` into complete PostgreSQL DDL. It is a **schema initializer**: it renders the full `CREATE EXTENSION` / `CREATE SCHEMA` / `CREATE TABLE` / `ALTER TABLE … ADD CONSTRAINT` / `CREATE INDEX` / view script for a database that does not exist yet — a disposable test database, a local environment, or a first deploy.

It is **not** a migration tool. It holds no prior state, computes no diff, records no history, and has no concept of a ledger, checksum, or snapshot. Its default mode drops what it is about to create (`dropBeforeCreate: true`), which is exactly right for a throwaway database and exactly wrong for one holding data. For an existing database, use the incremental workflow: see [Incremental Migration Generation](#incremental-migration-generation).

### How It Works

`generateGrouped()` assembles four sections from the model:

| Section | Contents |
| --- | --- |
| `schema` | Extensions, optional drops, schema creation, tables, constraints, table and column comments |
| `indexes` | `CREATE [UNIQUE] INDEX [CONCURRENTLY] … USING … INCLUDE … WITH … TABLESPACE … WHERE …` |
| `views` | `DROP VIEW` / `DROP MATERIALIZED VIEW`, then `CREATE [MATERIALIZED] VIEW …` and view comments |
| `all` | `schema`, `indexes`, and `views` joined in that order |

Everything is deterministic: extensions are de-duplicated, columns and constraints render in authoring order, and constraint names are derived from table, columns, and kind (`customers_email_key`, `orders_customer_id_fkey`). Identifiers are emitted as written — no implicit quoting — so the model is expected to use SQL-safe names. Comments are escaped by doubling single quotes. Views drop before they are created because `CREATE OR REPLACE VIEW` cannot change a column list; materialized views are recreated outright, since `OR REPLACE` is not available for them.

### Complete Example

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const database = new DatabaseSchema('shop');
database.extension('pgcrypto');

const customers = database.table('customers');
customers.bigserial('id').primaryKey();
customers.text('email').unique();

const orders = database.table('orders');
orders.bigserial('id').primaryKey();
orders.bigint('customer_id');
orders.foreignKeyConstraint(customers).from('customer_id').to('id').onDelete('CASCADE');
orders.index().indexName('orders_customer_idx').column('customer_id');

database.view('customer_emails').as('SELECT id, email FROM public.customers');

const generator = new PostgreSQLSchemaGenerator(database);

const bootstrap = generator.generateGrouped({ dropBeforeCreate: false });
console.log(bootstrap.schema); // CREATE EXTENSION … / CREATE TABLE …
console.log(bootstrap.indexes); // CREATE INDEX orders_customer_idx …
console.log(bootstrap.views); // DROP VIEW … / CREATE OR REPLACE VIEW …

console.log(generator.generate() === bootstrap.all); // true
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `generate` | `generate(params?: GenerateOptions): string` | Full script (`generateGrouped().all`) |
| `generateGrouped` | `generateGrouped(params?: GenerateOptions): GeneratedDDL` | `{ schema, indexes, views, all }` |
| `GenerateOptions.dropBeforeCreate` | `boolean` (default `true`) | Emits `DROP TABLE … CASCADE` and `DROP SCHEMA … CASCADE` before creating |
| `GeneratedDDL.schema` | `string` | Extensions, schemas, tables, constraints, comments |
| `GeneratedDDL.indexes` | `string` | All indexes |
| `GeneratedDDL.views` | `string` | All views and view comments |
| `GeneratedDDL.all` | `string` | `schema` + `indexes` + `views` |

**How the four "create a database from a model" tools differ**

| Tool | Direction | Reads | Writes | Use it for |
| --- | --- | --- | --- | --- |
| `PostgreSQLSchemaGenerator` | Model → full DDL | The model only | A string | Disposable databases, local setup, first deploy |
| `generateBaseline` | Model → first *migration* + snapshot | The model and the local directory | `*.up.sql` + `schema.snapshot.json` | Starting a reviewable lineage |
| `generateMigration` | Snapshot diff → targeted SQL | Model + committed snapshot | `*.up.sql` + snapshot | Everyday schema changes |
| `adoptBaseline` | Live catalog → ledger row | Desired snapshot + live catalog | One ledger row | Existing databases with no history |

---

## PostgreSQLIntrospector

### What It Is

`PostgreSQLIntrospector` reads an existing PostgreSQL catalog and projects it into a `SchemaContainer`, so an existing database can feed `TypeGenerator` and `ZodGenerator` without anyone hand-writing the shapes. It is strictly read-only: it issues one metadata query and never mutates the database.

### How It Works

A single SQL statement (`INTROSPECTION_SQL`) unions four row families — relations (tables, views, materialized views, partitioned tables, foreign tables), standalone composite types, enum types, and domains — into one uniform column-level shape. The introspector then processes them in three passes:

1. **Enums** become named string (or number) schemas with `.enum(labels)`.
2. **Composite types** become object schemas.
3. **Relations** become object schemas, one property per column.

Objects in `public` lose the schema prefix so the generated names match the authoring DSL. Each column is mapped by a `ColumnMapper` first (if provided), then by an enum reference, then by the built-in type table; anything still unmapped becomes `any` with a `@deprecated` description and a single operator-visible warning. Nullable columns get `.nullable().optional()`, array columns get `.arrayed()`, and defaults, primary keys, uniqueness, and check constraints are appended as `@default`, `@primaryKey`, `@unique`, and `@checkContraint` notes.

`introspectConstantTypes()` returns the qualified relation → column-name map consumed by `CTypeGenerator`; `introstectConstantTypes()` is a deprecated alias kept for compatibility.

### Complete Example

```typescript
import {
  PostgreSQLIntrospector,
  SchemaContainer,
  TypeGenerator,
  type ColumnMapper,
} from 'blendsdk/codegen';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const database = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'shop',
  user: 'app',
  pass: 'secret',
});

const container = new SchemaContainer();

const mapper: ColumnMapper = (column, scope) => {
  if (column.pg_type !== 'jsonb') {
    return undefined;
  }
  const typed = scope.any();
  typed.setData({
    tsType: 'Record<string, unknown>',
    zodExpression: 'z.record(z.string(), z.unknown())',
  });
  return typed;
};

try {
  const introspector = new PostgreSQLIntrospector(database);

  await introspector.introspect(container, mapper);

  const constants = await introspector.introspectConstantTypes();

  console.log(await new TypeGenerator().generate(container));
  console.log(Object.keys(constants));
} finally {
  await database.disconnect();
}
```

`PostgreSQLDatabase` is the connection surface from BlendSDK's PostgreSQL package, which ships in the same umbrella install; the introspector only needs its `executeQuery` method.

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `constructor` | `new PostgreSQLIntrospector(db: PostgreSQLDatabase)` | Binds the introspector to a connection wrapper |
| `introspect` | `introspect(schema: SchemaContainer, mapper?: ColumnMapper): Promise<void>` | Projects the catalog into the container |
| `introspectConstantTypes` | `introspectConstantTypes(): Promise<ConstantType>` | Qualified relation → column names |
| `introstectConstantTypes` | `introstectConstantTypes(): Promise<ConstantType>` | Deprecated historical spelling |
| `ColumnMapper` | `(column: ColumnIntrospection, scope: SchemaScope) => SchemaObject \| unknown` | Per-column override hook |

**Default PostgreSQL → TypeScript mapping**

| PostgreSQL type | Generated shape |
| --- | --- |
| `bool` | `boolean` |
| `text`, `varchar`, `char`, `bpchar`, `name`, `uuid`, `inet`, `cidr`, `macaddr`, `money`, `bit`, `varbit`, `tsvector`, `date`, `time`, `reg*`, `pg_lsn` | `string` |
| `int2`, `int4`, `serial`, `float4`, `float8`, `oid`, `xid`, `cid` | `number` |
| `numeric`, `decimal`, `int8`, `bigserial` | `string` (precision preserved, as `pg` returns them) |
| `timestamp`, `timestamptz` | `Date` |
| `json`, `jsonb` | `unknown` |
| `bytea` | `Buffer` (`z.instanceof(Buffer)`) |
| `xml`, `jsonpath`, `interval`, ranges, geometric types | Unmapped → `any` with a `@deprecated` warning |

---

## CTypeGenerator

### What It Is

`CTypeGenerator` turns a `ConstantType` map — qualified relation name → column names — into a TypeScript module of `as const`-style object literals. It exists so query code can reference `ePublicCustomers.EMAIL` instead of the string `'email'`: a typo becomes a compile error instead of an empty result set.

### How It Works

For each entry it derives a constant name by replacing dots with underscores, PascalCasing the result, and prefixing `e`. The object always carries `$TABLE` with the original qualified name, then one uppercase key per column whose value is the exact column name. Each constant gets a JSDoc block recording the source relation, `@export`, and `@constant`. The joined source is Prettier-formatted.

The natural producer of the input map is `PostgreSQLIntrospector.introspectConstantTypes()`; the generator itself accepts any conforming record, which makes it usable for hand-maintained mappings too.

### Complete Example

```typescript
import { CTypeGenerator, type ConstantType } from 'blendsdk/codegen';

const constants: ConstantType = {
  'public.customers': ['id', 'email', 'created_at'],
  'public.orders': ['id', 'customer_id', 'total', 'status'],
};

const source = await new CTypeGenerator().generate(constants);

console.log(source);
```

The module declares `export const ePublicCustomers = { $TABLE: 'public.customers', ID: 'id', EMAIL: 'email', CREATED_AT: 'created_at' }` followed by `ePublicOrders`.

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `generate` | `generate(ctypes: ConstantType): Promise<string>` | Renders and Prettier-formats one constant per relation |
| `ConstantType` | `{ [name: string]: string[] }` | Qualified relation name mapped to its column names |

---

## OpenAPIGenerator

### What It Is

`OpenAPIGenerator` collects annotated `webafx` controller routes and produces an OpenAPI 3.1 document. Routes opt in by carrying `.openapi()` metadata — everything else is invisible to the generator — so documenting an endpoint is a deliberate annotation, not a side effect of registering a route.

### How It Works

`addController(basePath, ControllerClass)` instantiates the controller with empty settings and services and calls `routes()`. That is safe by contract: `routes()` builds `RouteDefinition` objects and performs no I/O. `addRoutes(basePath, definitions)` accepts route definitions directly, which is what tests and hand-built documents use. Both are chainable, and both filter on `definition.openapi` being present.

For each collected route the generator:

- Joins `basePath` and `path`, normalizing slashes.
- Converts Express parameters (`:id`) to OpenAPI parameters (`{id}`) and emits each as a required `in: 'path'` parameter, enriched by `openapi.pathParams`.
- For `GET`/`DELETE` with a validation schema, splits the query object into one `in: 'query'` parameter per top-level property.
- For `POST`/`PUT`/`PATCH` with a validation schema, emits a required `application/json` request body converted in the **input** direction.
- Converts each declared response schema in the **output** direction, so defaults and transforms resolve to what the server actually returns.
- Records `x-blend-envelope` — `'data'` (the default, unwrapping the top-level `data` property) or `'body'` (the whole body, which paginated responses need).
- Applies `defaultSecurity` when the route is `secure`; a secure route with no configured default emits `security: []` to record "secured, scheme unspecified".

Path keys and each path item's method keys are sorted before the document is returned, and Zod `$defs` are hoisted into `components.schemas`, so the emitted JSON is byte-stable — the property the drift check depends on.

### Complete Example

```typescript
import { OpenAPIGenerator } from 'blendsdk/codegen';
import { z } from 'zod';

const generator = new OpenAPIGenerator({
  title: 'Catalog API',
  version: '1.0.0',
  servers: [{ url: 'http://localhost:3000', description: 'Local development' }],
  securitySchemes: {
    bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  },
  defaultSecurity: [{ bearerAuth: [] }],
});

generator.addRoutes('/api/products', [
  {
    method: 'get',
    path: '/',
    handler: () => {},
    validation: z.object({
      search: z.string().optional(),
      page: z.coerce.number().default(1),
    }),
    openapi: {
      operationId: 'listProducts',
      tags: ['products'],
      summary: 'List products',
      responses: [
        {
          statusCode: 200,
          description: 'A page of products',
          schema: z.object({ items: z.array(z.object({ id: z.number() })) }),
        },
      ],
    },
  },
  {
    method: 'post',
    path: '/',
    handler: () => {},
    secure: true,
    validation: z.object({ name: z.string().min(1) }),
    openapi: {
      operationId: 'createProduct',
      tags: ['products'],
      summary: 'Create a product',
      responses: [
        { statusCode: 201, description: 'Created', schema: z.object({ id: z.number() }) },
      ],
    },
  },
]);

const document = generator.generate();
const pathItem = document.paths['/api/products'];

console.log(Object.keys(document.paths)); // [ '/api/products' ]
console.log(pathItem?.get?.parameters?.map(parameter => parameter.name)); // [ 'search', 'page' ]
console.log(pathItem?.post?.security); // [ { bearerAuth: [] } ]
console.log(document.paths['/api/products'].get?.['x-blend-envelope']); // 'data'
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `addController` | `addController(basePath: string, ControllerClass: ControllerConstructor): this` | Instantiates the controller and collects annotated routes |
| `addRoutes` | `addRoutes(basePath: string, routeDefinitions: RouteDefinition[]): this` | Collects route definitions directly |
| `generate` | `generate(): OpenAPIDocument` | Builds, sorts, and hoists the document |
| `toJSON` | `toJSON(indent?: number): string` | `JSON.stringify` of `generate()` |
| `toFile` | `toFile(filePath: string): void` | Writes the document, creating parent directories |
| `ControllerConstructor` | `new (settings: any, services: any) => { routes(): RouteDefinition[] }` | Structural controller contract |

**`OpenAPIGeneratorConfig`**

| Field | Type | Description |
| --- | --- | --- |
| `title` / `version` | `string` | Required `info` fields |
| `description` | `string?` | Optional `info.description`, Markdown supported |
| `servers` | `OpenAPIServer[]?` | Emitted only when non-empty |
| `securitySchemes` | `Record<string, OpenAPISecurityScheme>?` | Emitted into `components.securitySchemes` |
| `defaultSecurity` | `SecurityRequirement[]?` | Applied to every `secure` route |

---

## Zod → OpenAPI Conversion

### What It Is

The conversion module is the seam between Zod schemas and OpenAPI 3.1. It uses Zod 4's native `z.toJSONSchema` rather than introspecting Zod internals, then normalizes the result into the shape OpenAPI consumers expect. It also owns `$defs` hoisting — the step that turns Zod's per-conversion local definitions into `components.schemas`.

### How It Works

`convertZodToJsonSchema(schema, direction)` calls `z.toJSONSchema` with `target: 'draft-2020-12'`, `cycles: 'ref'`, `reused: 'ref'`, `metadata: z.globalRegistry`, and `unrepresentable: 'any'`, then normalizes:

- The draft-2020-12 `$schema` marker is dropped, because the schema is embedded in a document that declares its own version.
- A simple nullable union — one `{ type: 'null' }` branch plus one named-type branch — folds into a JSON Schema type array, `type: ['string', 'null']`. That is what OpenAPI 3.1 consumers understand; the 3.0 `nullable` keyword is gone. Branches carrying `enum` or `const` are left as `anyOf`, because a type array would not relax those keywords and nullability would be silently lost.

The `direction` argument matters: `'input'` describes what a caller sends (defaults may be absent), `'output'` describes what the server returns (defaults and transforms resolved).

`convertZodToQueryParameters(schema)` converts in the input direction and splits the top-level object into `in: 'query'` parameters, marking `required` only for properties in the schema's `required` array — so optional and defaulted properties become optional parameters.

`hoistDefinitions(document)` walks the document, removes every `$defs` map, and merges definitions into `components.schemas` under collision-safe names. A same-named definition with identical content is deduplicated — but only when neither definition contains a local `#/$defs/` reference, since textually equal definitions can resolve those references differently. Otherwise the newcomer is renamed `Name_2`, `Name_3`, … and the references inside that operation are rewritten. Any surviving `#/$defs/` reference throws, because it would produce an unresolvable reference in the generated client.

`isZodSchema` narrows unknown values; `sortByName` returns a key-sorted copy.

### Complete Example

```typescript
import {
  convertZodToJsonSchema,
  convertZodToQueryParameters,
  hoistDefinitions,
  type OpenAPIDocument,
} from 'blendsdk/codegen';
import { z } from 'zod';

const product = z.object({ id: z.number(), name: z.string() }).meta({ id: 'Product' });

const page = z.object({
  items: z.array(product),
  featured: product,
  nextCursor: z.string().nullable(),
});

const schema = convertZodToJsonSchema(page, 'output');
const query = convertZodToQueryParameters(
  z.object({ page: z.coerce.number().default(1), search: z.string().optional() })
);

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Catalog API', version: '1.0.0' },
  paths: {
    '/api/products': {
      get: {
        operationId: 'listProducts',
        parameters: query,
        responses: {
          '200': {
            description: 'A page of products',
            content: { 'application/json': { schema } },
          },
        },
      },
    },
  },
};

hoistDefinitions(document);

console.log(query.map(parameter => `${parameter.name}:${parameter.required === true}`));
// [ 'page:false', 'search:false' ]
console.log(Object.keys(document.components?.schemas ?? {}));
// [ 'Product' ]
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `convertZodToJsonSchema` | `(schema: ZodType, direction: 'input' \| 'output'): OpenAPISchema` | Native conversion plus nullable folding |
| `convertZodToQueryParameters` | `(schema: ZodType): OpenAPIParameter[]` | One `in: 'query'` parameter per top-level property |
| `hoistDefinitions` | `(document: OpenAPIDocument): OpenAPIDocument` | Moves `$defs` into `components.schemas` and rewrites refs in place |
| `isZodSchema` | `(value: unknown): value is ZodType` | Narrows a runtime value to a Zod schema |
| `sortByName` | `<T extends object>(record: T): T` | Key-sorted shallow copy, for stable output |

---

## Typed API Client Generation

### What It Is

`generateClient` reads an OpenAPI 3.1 document and writes a typed TypeScript client whose methods mirror the server's operations. `checkClient` regenerates in memory and compares against the committed files without writing — the CI drift gate. Both are pure functions over a document plus options; neither reads a controller or touches a database.

### How It Works

**Determinism first.** Paths are visited in sorted order and methods in the fixed sequence `get post put patch delete`; component schemas are sorted; every file is normalized with Prettier; `formatOpenApiDocument` serializes the contract with the same options. Regenerating unchanged input produces identical bytes.

**Files written.** `types.ts` (component aliases plus per-operation `…Params` and `…Result` aliases), `client.ts` (grouped client interface plus `create<ClientName>`), and `index.ts`. With `splitByGroup`, `client.ts` becomes a barrel and each group gets `client.<group>.ts`. Every file starts with `// Generated by \`blendsdk api generate\` — do not edit by hand.`

**Pruning.** After writing, files in the output directory that start with the marker but are no longer generated are deleted. Files without the marker are never touched, and only regular files are read — a symlink or FIFO in the directory is skipped rather than followed.

**Naming.** A group is the first tag, else the first path segment after `/api`, PascalCased then lower-camel-cased and sanitized (`product-catalog` → `productCatalog`). A method is the sanitized `operationId`; reserved words (`delete`, `class`, `__proto__`, TypeScript type keywords) get a trailing underscore and a warning. A missing `operationId` produces a deterministic fallback — `<group><Method><PathSegments>`, with `{id}` becoming `ById`, giving `productsGetById`.

**Parameters.** The client flattens path parameters, query parameters, and the JSON body into one params object, mirroring the server's merged validation object. A `$ref` body that resolves to an object is flattened property by property; any other body becomes a single `body` property. Header and cookie parameters are ignored because the runtime owns them. A duplicate name is dropped with a warning, and the path or query parameter wins over the body property.

**Result types.** A `$ref` in a `data` envelope resolves to the component type. An inline schema gets a named `<Group><Method>Result` alias. A missing 2xx schema becomes `unknown` plus an issue. A `body` envelope wraps the inner type in `PaginatedResponse<T>`.

**Failure modes.** Two operations sharing an `operationId` — or two operations resolving to the same `<group>.<method>` after sanitization — throw `ClientGenerationError`, naming both locations. A missing `operationId` or 2xx schema is a *warning* under `generate` and an *error* under `check` (or under `generate` with `strict: true`).

**Drift.** `checkClient` compares expected bytes to committed bytes for every generated name, and flags marker files that should no longer exist. Any mismatch, any missing file, or any error-severity issue sets `drifted: true` and lists the offending names.

### Complete Example

```typescript
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkClient, generateClient, type OpenAPIDocument } from 'blendsdk/codegen';

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Catalog API', version: '1.0.0' },
  paths: {
    '/api/products': {
      get: {
        operationId: 'listProducts',
        tags: ['products'],
        responses: {
          '200': {
            description: 'A page of products',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Product' } },
              },
            },
          },
        },
      },
      post: {
        operationId: 'createProduct',
        tags: ['products'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Product' } },
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

const outputDir = await mkdtemp(join(tmpdir(), 'blendsdk-client-'));

const generated = await generateClient(document, {
  outputDir,
  clientName: 'CatalogClient',
  splitByGroup: true,
});

const checked = await checkClient(document, {
  outputDir,
  clientName: 'CatalogClient',
  splitByGroup: true,
});

console.log(generated.files); // [ 'client.products.ts', 'client.ts', 'index.ts', 'types.ts' ]
console.log(generated.issues.map(issue => issue.severity)); // []
console.log(checked.drifted); // false
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `generateClient` | `(document: OpenAPIDocument, options: ClientGeneratorOptions): Promise<GenerationResult>` | Writes files, prunes stale marker files |
| `checkClient` | `(document: OpenAPIDocument, options: ClientGeneratorOptions): Promise<GenerationResult>` | Regenerates in memory, reports drift, writes nothing |
| `formatOpenApiDocument` | `(document: OpenAPIDocument): Promise<string>` | The byte-stable JSON text written and compared |
| `ClientGenerationError` | `class extends Error` | Duplicate `operationId` or duplicate resolved method |

**`ClientGeneratorOptions`**

| Field | Type | Description |
| --- | --- | --- |
| `outputDir` | `string` | Required output directory, resolved by the caller |
| `splitByGroup` | `boolean?` | One `client.<group>.ts` per group plus a barrel |
| `strict` | `boolean?` | Escalates contract warnings to errors in `generate` (ignored by `check`, which always escalates) |
| `clientName` | `string?` | Base name of the generated client type; defaults to `AppClient` |
| `runtimeImport` | `string?` | Runtime import specifier in generated code; defaults to the `blendsdk/api-client` subpath |

**`GenerationResult`**

| Field | Type | Description |
| --- | --- | --- |
| `files` | `string[]` | Written (generate) or compared (check) file names, sorted |
| `issues` | `ContractIssue[]` | Warnings and errors found while reading the contract |
| `drifted` | `boolean?` | `check` only: whether anything differs or an error was found |
| `driftedFiles` | `string[]?` | `check` only: the differing file names, sorted |

**`ContractIssue`**

| Field | Type | Description |
| --- | --- | --- |
| `severity` | `'warning' \| 'error'` | Warning under `generate`, error under `check` |
| `message` | `string` | Human-readable description with the operation location |
| `operationId` / `method` / `path` | `string?` | Operation coordinates when known |

---

## The API Contract

### What It Is

A `blendsdk.api.ts` file is the contract that binds controllers, the committed OpenAPI document, and the generated client together. `defineApiContract` gives that object type inference at zero runtime cost, and the `blendsdk api generate` / `blendsdk api check` commands operate on it. `generate` rebuilds both artifacts and writes them; `check` rebuilds in memory and fails when either differs from what is committed.

### How It Works

**Discovery.** `--config <path>` may name a file or a directory; without it the loader searches upward for `blendsdk.api.ts` and **stops at the repository root** — a `.git` entry terminates the search, so a configuration planted above the project is never loaded. The file is loaded with `jiti` with both caches disabled, so an edit is always observed.

**Validation is strict and closed.** Unknown top-level keys and unknown `generator` keys are configuration errors, not ignored extras. `outputDir` is required; `contractFile` defaults to `api.json`. Relative paths resolve against the configuration directory and must not escape it; absolute paths are treated as developer-authored and trusted, matching the migration loader.

**Generation order.** `generate` rebuilds the document from the controllers, writes the formatted contract JSON first, then the client (which prunes stale marker files), and reports issues. `check` performs the same rebuild in memory and compares both artifacts byte for byte.

**Exit codes.** The command never calls `process.exit`; it returns a code.

### Complete Example

```typescript
import { defineApiContract } from 'blendsdk/codegen';
import { z } from 'zod';

class ProductsController {
  public constructor(_settings: unknown, _services: unknown) {}

  public routes() {
    return [
      {
        method: 'get' as const,
        path: '/',
        handler: () => {},
        validation: z.object({ search: z.string().optional() }),
        openapi: {
          operationId: 'listProducts',
          tags: ['products'],
          responses: [
            {
              statusCode: 200,
              description: 'A page of products',
              schema: z.object({ items: z.array(z.object({ id: z.number() })) }),
            },
          ],
        },
      },
    ];
  }
}

export default defineApiContract({
  outputDir: 'src/api-client',
  contractFile: 'api.json',
  controllers: [{ basePath: '/api/products', controller: ProductsController }],
  openapi: { title: 'Catalog API', version: '1.0.0' },
  generator: { splitByGroup: true, clientName: 'CatalogClient' },
});
```

```bash
npx blendsdk api generate --config blendsdk.api.ts
npx blendsdk api check --config blendsdk.api.ts
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `defineApiContract` | `<T extends ApiContract>(contract: T): T` | Identity function for inference; no runtime effect |

**`ApiContract`**

| Field | Type | Description |
| --- | --- | --- |
| `outputDir` | `string` | Required client output directory |
| `contractFile` | `string?` | Committed document path; defaults to `api.json` |
| `controllers` | `ApiContractController[]` | `{ basePath, controller }` registrations |
| `openapi` | `OpenAPIGeneratorConfig` | Document metadata and security schemes |
| `generator` | `Omit<ClientGeneratorOptions, 'outputDir'>?` | `splitByGroup`, `strict`, `clientName`, `runtimeImport` only |

**Exit codes**

| Code | Meaning |
| --- | --- |
| `0` | Success; for `check`, no drift |
| `1` | Drift (`DRIFT: <files>`) or an operational failure |
| `2` | Usage error or invalid/missing configuration |

---

## Migration Configuration

### What It Is

`blendsdk.migrations.ts` is the single file that tells the migration workflow where the desired schema lives, where migrations and the snapshot are committed, which environment variable holds the connection URL, and how long to wait for locks and statements. `defineMigrationConfig` provides inference without changing the object.

### How It Works

**Credentials are never in the file.** The configuration names an environment variable (`databaseUrlEnv`), not a URL, so the resolved configuration is safe to log and safe to serialize.

**Discovery.** `--config <path>` may be a file or a directory; otherwise the loader searches upward for `blendsdk.migrations.ts` and stops at the filesystem root. Symbolic-link segments between the discovered configuration and every configured path are rejected, so an artifact directory cannot be redirected outside the project.

**Bounds.** Relative paths resolve against the configuration directory and must not escape it. A filesystem root is rejected. `snapshotFile` may not use a migration SQL filename. `lockTimeoutMs` is bounded to 1–300000 and `statementTimeoutMs` to 1–86400000; both must be integers — numeric coercion is not accepted. `databaseUrlEnv` must be an uppercase environment-variable name.

**Schema is loaded lazily.** Loading the configuration never imports the schema module. Only the commands that need desired state (`generate`, `baseline`, `adopt-baseline`) load it, which is why `validate`, `status`, `up`, and `down` run without executing application schema code.

### Complete Example

```typescript
// blendsdk.migrations.ts
import { defineMigrationConfig } from 'blendsdk/codegen';

export default defineMigrationConfig({
  schema: './src/database/schema.ts',
  migrationsDir: './migrations',
  databaseUrlEnv: 'DATABASE_URL',
  lockTimeoutMs: 10_000,
  statementTimeoutMs: 120_000,
});
```

```typescript
// src/database/schema.ts
import { DatabaseSchema } from 'blendsdk/codegen';

const database = new DatabaseSchema('shop');

const customers = database.table('customers');
customers.bigserial('id').primaryKey();
customers.text('email').unique();

export default database;
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `defineMigrationConfig` | `<const Config extends MigrationConfig>(config: Config): Config` | Identity function for inference |

**`MigrationConfig`** (and the defaults used by `ResolvedMigrationConfig`)

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `schema` | `string?` | — | Module whose default export is the desired `DatabaseSchema`; required by `generate`, `baseline`, and `adopt-baseline` |
| `migrationsDir` | `string?` | `migrations` | Directory of immutable `*.up.sql` / `*.down.sql` files |
| `snapshotFile` | `string?` | `<migrationsDir>/schema.snapshot.json` | Canonical desired-state snapshot |
| `databaseUrlEnv` | `string?` | `DATABASE_URL` | Environment variable holding the connection URL |
| `lockTimeoutMs` | `number?` | `5000` | Advisory-lock deadline, 1–300000 |
| `statementTimeoutMs` | `number?` | `900000` | Per-migration statement deadline, 1–86400000 |

`ResolvedMigrationConfig` adds `configPath` and `configDirectory` and resolves every path to an absolute one.

---

## Incremental Migration Generation

### What It Is

`generateMigration` turns an edited `DatabaseSchema` into a reviewable SQL file plus a replacement canonical snapshot, entirely offline. It is the everyday workflow: edit the model, generate, read the SQL, commit the pair. It never opens a database connection, so it works in CI, on a plane, and before the target database exists.

### How It Works

1. The configured schema module is loaded and **normalized** into a versioned, data-only snapshot: collections sorted, identities validated (no dots, no NUL, ≤63 bytes), constraint and index names derived deterministically, aliases canonicalized. The normalizer copies arrays before sorting and never calls a mutating builder method, so it cannot corrupt the authoring model.
2. The committed `schema.snapshot.json` is read and its exact bytes hashed. A missing snapshot starts from an empty state; history without a snapshot is an `INVALID_HISTORY` error.
3. The two snapshots are diffed into typed `SchemaChange` records, each carrying a `MigrationSafety` class.
4. If nothing changed, the command returns `UP_TO_DATE` and leaves every file byte-identical.
5. Otherwise the changes are rendered to targeted SQL in fixed dependency phases, and the SQL file plus the new snapshot are published atomically.

**Safety is the gate.** Only `safe` changes render automatically. `caution` (a required column add, a `SET NOT NULL`), `ambiguous` (an unhinted plausible rename), `unsupported` (type changes, identity or generated-column transitions, view replacements, same-name constraint replacements, cross-schema renames), and unapproved `destructive` changes all stop generation with a `MigrationError` and guidance. `allowDestructive: true` unlocks only the already-classified destructive statements, and each one is preceded by `-- destructive: reviewed and explicitly allowed`.

**File contract.** Generated files are LF-terminated UTF-8 without a BOM and start with a strict five-line header:

```text
-- blendsdk-migration: 1
-- id: 20260827120000_add-customer-status
-- transaction: true
-- from-snapshot: <sha256|none>
-- to-snapshot: <sha256>
```

`transaction` is `false` only when the migration contains `CREATE INDEX CONCURRENTLY`, which cannot run inside a transaction block. Transactional bodies may not contain transaction control statements; that is detected lexically, honoring comments, quoted strings, prefixed strings, and dollar quotes.

**Atomic publication.** Both files are written to private dot-prefixed siblings, flushed, and re-read for verification before either public name changes. The migration is claimed with an exclusive hard link (never overwriting an existing name), then the snapshot is renamed into place. If the second step fails, the migration created by *this* invocation is removed — matched by inode, so a concurrently replaced file is left alone — and the prior snapshot survives untouched. A crash between the two renames leaves a detectable torn pair rather than a silent inconsistency.

### Complete Example

```typescript
import { generateMigration, type RenameHint } from 'blendsdk/codegen';

const renames: RenameHint[] = [
  {
    kind: 'column',
    from: 'public.customers.display_name',
    to: 'public.customers.full_name',
  },
];

const result = await generateMigration({
  name: 'rename-display-name',
  configPath: './blendsdk.migrations.ts',
  renameHints: renames,
});

console.log(result.status); // 'GENERATED'

if (result.status === 'GENERATED' && result.migration) {
  console.log(result.migration.id); // '20260827120000_rename-display-name'
  console.log(result.migration.upPath); // …/migrations/20260827120000_rename-display-name.up.sql
  console.log(result.previousSnapshot, result.desiredSnapshot);
}

for (const change of result.changes) {
  console.log(`${change.safety} ${change.kind} ${change.name ?? ''}`.trim());
}
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `generateMigration` | `(options: GenerateMigrationOptions): Promise<GenerateMigrationResult>` | Offline generation; publishes SQL and snapshot or returns `UP_TO_DATE` |

**`GenerateMigrationOptions`**

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Lowercase slug, `^[a-z][a-z0-9-]{0,62}$`, becomes the file suffix |
| `configPath` | `string?` | Explicit config file or discovery directory |
| `renameHints` | `RenameHint[]?` | Explicit one-to-one table/column renames |
| `allowDestructive` | `boolean?` | Approves already-classified destructive statements only |
| `now` | `Date?` | Deterministic clock for tests and embedding callers |

**`GenerateMigrationResult`**

| Field | Type | Description |
| --- | --- | --- |
| `status` | `'GENERATED' \| 'UP_TO_DATE'` | Whether artifacts were published |
| `migration` | `MigrationDescriptor?` | Present when generated |
| `previousSnapshot` / `desiredSnapshot` | `string` | SHA-256 of the prior and resulting canonical snapshot bytes |
| `changes` | `SchemaChange[]` | The reviewed semantic change list |

**`MigrationSafety`**

| Class | Meaning | Automatic SQL |
| --- | --- | --- |
| `safe` | Additive, non-destructive | Yes |
| `caution` | Requires a staged population strategy (required column add, `SET NOT NULL`) | No — manual |
| `destructive` | Drops data (column, table, constraint, index, extension, schema) | Only with `allowDestructive` |
| `ambiguous` | A plausible rename that needs an explicit hint | No — hint required |
| `unsupported` | Cannot be proven safe structurally (type change, identity/generated transition, view replacement) | No — manual |

**`SchemaChange`**

| Field | Type | Description |
| --- | --- | --- |
| `kind` | `extension.*`, `schema.*`, `table.*`, `column.*`, `constraint.*`, `index.*`, `comment.set`, `view.*` | Object-specific discriminator |
| `safety` | `MigrationSafety` | Required classification |
| `schema` / `table` / `name` / `newName` | `string?` | Qualified identity parts |
| `tableState` / `columnState` / `previousColumnState` / `viewState` | structured? | Full definitions for the affected object |
| `definition` | `Record<string, unknown>?` | Constraint or index payload copied from the snapshot |
| `guidance` | `string?` | Human-readable reason when automatic SQL is blocked |

**`RenameHint`**

| Field | Type | Description |
| --- | --- | --- |
| `kind` | `'table' \| 'column'` | Object kind being renamed |
| `from` / `to` | `string` | Fully qualified identities; same schema, one-to-one, acyclic |

**`MigrationDescriptor`**

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | `<YYYYMMDDHHMMSS>_<slug>` |
| `upPath` / `downPath` | `string` | Absolute paths |
| `checksum` / `downChecksum` | `string` | Lowercase SHA-256 of the exact file bytes |
| `transactional` / `downTransactional` | `boolean` | Whether the runner owns a transaction |
| `fromSnapshot` / `toSnapshot` | `string?` | Lineage hashes; `undefined` for manual history |

---

## The Migration Runner

### What It Is

`runMigrations` applies, reverts, or observes committed migration files against PostgreSQL, and `getMigrationStatus` / `validateMigrations` are the read-only entry points for the same machinery. The runner is the only part of the migration workflow that talks to a database — and it consumes files; it never generates schema changes from a live catalog.

### How It Works

**Lazy driver.** `pg` is imported inside the function that needs it. Importing the package, generating migrations, and validating history offline never load a driver, so a project without `pg` installed still builds.

**One database-scoped lock.** The runner acquires `pg_try_advisory_lock(hashtext(current_database()), hashtext('blendsdk:migrations:v1'))` on a dedicated session, retrying until `lockTimeoutMs`, and sets `application_name = 'blendsdk-migrations'`. The lock is released once, on the owning session; a broken session is destroyed so PostgreSQL releases the lock by closing the connection.

**Revalidation under the lock.** Discovery happens before the lock and again after it. The whole descriptor set — ids, paths, checksums, transaction flags, lineage — is compared, because waiting for the lock is an edit window for both pending and already-applied files. The exact bytes are then re-read and re-parsed immediately before execution, so a file changed after discovery is rejected instead of executed.

**History is an exact prefix.** The ledger (`public.blendsdk_migrations`) must be the ordered beginning of local history. A missing file, an inserted file, a reordering, or a one-byte checksum drift is `INVALID_HISTORY`. The ledger's own shape is verified too — columns, primary key, and the three check constraints — before any row is read or written, because an empty incompatible table cannot be detected from rows alone.

**Transactional vs nontransactional.** A transactional migration runs its SQL and its ledger insert in one transaction: either both commit or neither does. A nontransactional migration first commits a `NONTRANSACTIONAL_DIRTY` marker, runs the SQL outside a transaction, then promotes the row to `APPLIED`. A session loss after dispatch leaves the marker in place, and every later command reports `UNKNOWN_OUTCOME` until an operator resolves it — the runner never guesses.

**Cancellation.** An `AbortSignal` cancels before the next migration, and an in-flight statement is cancelled through a second connection (`pg_cancel_backend`), after which a transactional migration rolls back. A cancel *after* a nontransactional dispatch is an unknown outcome, not a rollback.

**`down` is guarded twice.** It requires `allowDown: true` and a down file for the latest applied migration; it reverts exactly one migration.

### Complete Example

```typescript
import {
  formatMigrationError,
  getMigrationStatus,
  MigrationError,
  runMigrations,
  validateMigrations,
} from 'blendsdk/codegen';

const configPath = './blendsdk.migrations.ts';

try {
  const status = await getMigrationStatus({ configPath });
  console.log(status.status, status.migrations.map(migration => migration.id));

  const plan = await runMigrations({ command: 'up', configPath, dryRun: true });
  console.log(plan.status, plan.migrations.length);

  const validation = await validateMigrations({ configPath, offline: true });
  console.log(validation.status);
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(formatMigrationError(error));
  } else {
    throw error;
  }
}
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `runMigrations` | `(options: RunMigrationsOptions): Promise<MigrationCommandResult>` | Applies, reverts, or observes |
| `getMigrationStatus` | `(options?: GetMigrationStatusOptions): Promise<MigrationCommandResult>` | `runMigrations({ command: 'status' })` |
| `validateMigrations` | `(options?: ValidateMigrationsOptions): Promise<MigrationCommandResult>` | `runMigrations({ command: 'validate' })` |

**`RunMigrationsOptions`**

| Field | Type | Description |
| --- | --- | --- |
| `command` | `'up' \| 'down' \| 'status' \| 'validate'` | Execution or observation |
| `configPath` | `string?` | Explicit config file or discovery directory |
| `dryRun` | `boolean?` | Reports the pending order without mutation (only meaningful for `up`) |
| `allowDown` | `boolean?` | Required confirmation for `down` |
| `offline` | `boolean?` | `validate` only: local files and lineage, no database |
| `signal` | `AbortSignal?` | Caller-owned cancellation; the library installs no global handlers |

**`MigrationStatus`**

| Status | Meaning |
| --- | --- |
| `UP_TO_DATE` | No pending local migrations |
| `PENDING` | Local migrations remain after the applied prefix |
| `INVALID_HISTORY` | Ledger and files disagree, or the ledger shape is unsupported |
| `LOCKED` | Another session holds the advisory lock (observation commands only) |
| `UNKNOWN_OUTCOME` | The newest ledger row is `NONTRANSACTIONAL_DIRTY` |

`status` and `validate` return these as data. Mutating commands (`up`, `down`) throw a `MigrationError` instead — a lock timeout is `kind: 'LOCKED'`, an edited file is `kind: 'INVALID_HISTORY'`, and an uncertain nontransactional outcome is `kind: 'UNKNOWN_OUTCOME'`.

---

## Baseline Generation and Adoption

### What It Is

These are the two ways to start a lineage.

- `generateBaseline` creates the **first** migration artifact plus its canonical snapshot, offline, for a project that has no history. It is a migration generator, not an initializer: the artifact it writes is the ordinary `*.up.sql` file that `runMigrations` will apply.
- `adoptBaseline` records the **existing** database as already at that baseline, proving structural equality first and **never executing the baseline SQL**. It is the on-ramp for a database that already exists.

### How It Works

**`generateBaseline`** runs the same pipeline as `generateMigration` with one extra precondition: it refuses to proceed if a snapshot or any up migration already exists. The rendered body contains the complete desired state as additive `CREATE` statements — no `DROP`, no `CASCADE`. Publication is the same atomic pair. The result carries the migration descriptor and the snapshot hash that the migration's `to-snapshot` line references.

**`adoptBaseline`** is transactional where it matters:

1. It reads exactly one locally valid baseline migration whose `to-snapshot` matches the canonical snapshot bytes.
2. It acquires the normal advisory lock, then re-reads the local baseline and rejects any change observed while waiting.
3. It projects the live catalog into the same canonical model and compares object by object. Supported modeled state must match exactly. Anything PostgreSQL can rewrite — view SQL, column defaults, check expressions, expression or partial indexes — is classified `UNSUPPORTED_FOR_ADOPTION` rather than string-compared, because a false match would be worse than a refusal.
4. Unmanaged objects (functions, triggers, enums, domains) are reported as informational `UNMANAGED`, unless they occupy a modeled identity or the desired schema depends on an unmodeled type, in which case they block.
5. It shows a sanitized preview — host, port, user, database, baseline id, and the comparison — then requires the exact `<database>/<baseline-id>` token, which the caller must collect only after application and administrative DDL have been quiesced.
6. It re-verifies catalog and local files inside a `REPEATABLE READ` transaction, requires an absent or empty ledger, creates and inserts exactly one `APPLIED` row, and commits.

The confirmation token binds the attestation to one target and one baseline. It is not a generic "yes": a wrong database or a different baseline id fails as a configuration error before anything is written.

### Complete Example

```typescript
import { adoptBaseline, generateBaseline, type AdoptionPreview } from 'blendsdk/codegen';

// 1. Start the lineage offline. No database connection is opened.
const baseline = await generateBaseline({
  name: 'initial',
  configPath: './blendsdk.migrations.ts',
});

console.log(baseline.status); // 'GENERATED'
console.log(baseline.migration.id); // '20260827090000_initial'
console.log(baseline.snapshotHash);
console.log(baseline.changes.map(change => change.kind)); // [ 'schema.add', 'table.add', … ]

// 2. Later, for a database that already exists, record it as adopted.
const adopted = await adoptBaseline(
  { configPath: './blendsdk.migrations.ts' },
  {
    afterPreview: (preview: AdoptionPreview) => {
      console.log(`${preview.user}@${preview.host}:${preview.port}/${preview.database}`);
      for (const item of preview.comparison) {
        console.log(`${item.classification} ${item.identity}`);
      }
      return `${preview.database}/${preview.baselineId}`;
    },
  }
);

console.log(adopted.status); // 'ADOPTED'
console.log(adopted.comparison.length);
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `generateBaseline` | `(options: GenerateBaselineOptions): Promise<GenerateBaselineResult>` | Offline; refuses any existing snapshot or up history |
| `adoptBaseline` | `(options: AdoptBaselineOptions, dependencies?: AdoptBaselineDependencies): Promise<AdoptBaselineResult>` | Proves catalog equality, then records the ledger row |

**Options**

| Field | Type | Description |
| --- | --- | --- |
| `GenerateBaselineOptions.name` | `string` | Lowercase slug for the baseline migration |
| `GenerateBaselineOptions.configPath` | `string?` | Explicit config file or discovery directory |
| `GenerateBaselineOptions.now` | `Date?` | Deterministic clock |
| `AdoptBaselineOptions.configPath` | `string?` | Explicit config file or discovery directory |
| `AdoptBaselineOptions.confirmation` | `string?` | Exact `<database>/<baseline-id>` token, when not collected via `afterPreview` |
| `AdoptBaselineDependencies.afterPreview` | `(preview: AdoptionPreview) => string \| void \| Promise<string \| void>` | Shows the sanitized preview and may return the token |

**Results**

| Field | Type | Description |
| --- | --- | --- |
| `GenerateBaselineResult.status` | `'GENERATED'` | Successful baseline generation |
| `GenerateBaselineResult.migration` | `MigrationDescriptor` | The one published initial migration |
| `GenerateBaselineResult.snapshotHash` | `string` | SHA-256 of the published snapshot bytes |
| `GenerateBaselineResult.changes` | `SchemaChange[]` | The additive changes rendered into the baseline |
| `AdoptBaselineResult.status` | `'ADOPTED'` | Returned only after the ledger row commits |
| `AdoptBaselineResult.comparison` | `readonly CatalogComparisonItem[]` | Authoritative per-object comparison, including `UNMANAGED` entries |

**`AdoptionPreview`**

| Field | Type | Description |
| --- | --- | --- |
| `host` / `port` / `user` | `string` | Target identity, without password or URL query values |
| `database` | `string` | Target database name |
| `baselineId` | `string` | The initial migration identifier that will be recorded |
| `comparison` | `readonly CatalogComparisonItem[]` | Stable per-object classification and qualified identity |

---

## MigrationError and Exit Codes

### What It Is

`MigrationError` is the one error type the migration workflow throws for expected failures, and `formatMigrationError` renders it for operator output. Its purpose is to make failures **machine-classifiable and safe to print**: no connection URL, no credentials, no SQL body.

### How It Works

Every instance carries a stable `kind` and a process `exitCode`. The message is redacted **at construction time**, so ordinary error logging cannot leak a secret even if the caller never calls the formatter. Redaction removes complete `postgres://` / `postgresql://` URLs (which covers embedded credentials, query-string secrets, and certificate paths) and common `password=` / `pass=` / `secret=` / `token=` assignments. Sensitive provider detail is accepted as an option but never retained on the instance.

`formatMigrationError` renders `<KIND>: <redacted message>` and redacts again, so a message constructed elsewhere cannot bypass the rule.

### Complete Example

```typescript
import { formatMigrationError, MigrationError } from 'blendsdk/codegen';

function describeFailure(error: unknown): string {
  if (error instanceof MigrationError) {
    return `${formatMigrationError(error)} (exit ${error.exitCode})`;
  }
  return error instanceof Error ? error.message : 'unknown failure';
}

const failure = new MigrationError({
  kind: 'CONFIGURATION',
  exitCode: 2,
  message: 'Cannot reach postgres://app:secret@db.example/shop with password=second-secret',
});

console.log(describeFailure(failure));
// CONFIGURATION: Cannot reach [REDACTED_DATABASE_URL] with password=[REDACTED] (exit 2)
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `constructor` | `new MigrationError(options: MigrationErrorOptions)` | Redacts `options.message` before storing it |
| `kind` | `MigrationErrorKind` | Stable category for branching |
| `exitCode` | `1 \| 2` | Process class used by the command-line adapter |
| `formatMigrationError` | `(error: MigrationError): string` | `<KIND>: <redacted message>` |

**`MigrationErrorKind`**

| Kind | Typical exit code | Raised when |
| --- | --- | --- |
| `CONFIGURATION` | 2 | Unknown config key, unset URL variable, invalid rename hint, unconfirmed adoption |
| `INVALID_HISTORY` | 1 | Checksum drift, non-prefix ledger, malformed file header, torn lineage |
| `FILESYSTEM` | 1 | Unsafe path, existing immutable migration, failed publication |
| `DATABASE` | 1 | Provider failure, failed SQL, lost session |
| `LOCKED` | 1 | Advisory lock not acquired before the deadline |
| `UNKNOWN_OUTCOME` | 1 | Nontransactional dispatch whose result cannot be confirmed |
| `UNSUPPORTED` | 1 | A change requiring manual SQL, or a catalog shape v1 cannot model |
| `ABORTED` | 1 | Caller cancellation at a safe runner boundary |
| `INTERNAL` | 1 | An internal invariant was violated (e.g. a negative duration) |

**Exit codes**

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Operational failure: history, filesystem, database, lock, unknown outcome, unsupported change |
| `2` | Usage or configuration failure |

See [Migration Runner](#the-migration-runner) for the statuses that are returned as data rather than thrown, and [Incremental Migration Generation](#incremental-migration-generation) for the safety classes that decide whether SQL is generated at all.

---

# codegen Basic Usage

---

## Installation

BlendSDK ships as a single npm package; the codegen entry point is part of it. Install the umbrella once and import from `blendsdk/codegen`.

```bash
npm install blendsdk
```

```bash
yarn add blendsdk
```

```bash
pnpm add blendsdk
```

Database-backed operations — `PostgreSQLIntrospector`, `runMigrations`, `getMigrationStatus`, `validateMigrations`, and `adoptBaseline` — need the optional `pg` driver. Generation, validation, and diffing never do.

```bash
npm install blendsdk pg
```

Examples that build Zod schemas import `zod` directly; add it alongside the umbrella.

```bash
npm install blendsdk zod
```

| Requirement | Value |
| --- | --- |
| Node.js | `>= 22.0.0` |
| Module system | ESM only (`"type": "module"`) |
| TypeScript | 5.x with `strict: true` |
| PostgreSQL | 13+ (only for introspection, migrations, and baseline adoption) |

Two details make local setup cheap:

- `blendsdk.migrations.ts` and `blendsdk.api.ts` are loaded by `jiti`, so configuration files are TypeScript with **no build step**.
- Every generator returns a formatted string. Nothing is written until you write it, so you can generate in memory in a test.

Examples use top-level `await`, which requires an ES module (`.ts` with `"type": "module"`, `.mts`, or `"module": "nodenext"`).

---

## Quick Start

Seven lines describe a shape, register it under a name, and render TypeScript.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

scope.object({ id: scope.number(), name: scope.string() }).named('Product');

console.log(await new TypeGenerator().generate(container));
```

```text
/**
 * @interface
 */
export interface Product {
  id: number;
  name: string;
}
```

`SchemaContainer` owns every schema object. `container.scope()` returns a `SchemaScope` that creates schema objects in one scope, and `.named()` gives the object the identity the generators use.

---

## Fundamentals

Each subsection adds one concept: describe a shape, render it, model a database, publish a contract, generate a client, and plan migrations.

### 1. Describe a shape

Start with a single named primitive. `.named()` is what makes a schema renderable.

```typescript
import { SchemaContainer } from 'blendsdk/codegen';

const container = new SchemaContainer();
container.scope().string().named('Email');

console.log(container.find(undefined, 'Email')?.getName()); // 'Email'
```

`find(scope, name)` takes `undefined` for the default scope. Passing `'public'` would not match, because the default scope is represented by no scope at all.

The next level combines modifiers, string constraints, enums, arrays, and references. Properties are created from the same scope and **must stay unnamed** — a property is rendered inline, so naming it is rejected by the generators.

```typescript
import { SchemaContainer } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

const status = scope.string().enum(['active', 'suspended']).named('CustomerStatus');

const address = scope
  .object({
    street: scope.string().minLength(1).maxLength(120),
    postalCode: scope.string().pattern('^[0-9]{4}[A-Z]{2}$'),
  })
  .named('Address');

scope
  .object({
    id: scope.number(),
    email: scope.string().pattern('^[^@\\s]+@[^@\\s]+$').maxLength(320),
    status: scope.ref(status),
    addresses: scope.ref(address).arrayed(),
    deletedAt: scope.date().nullable(),
    metadata: scope.unknown(),
  })
  .named('Customer');
```

| Modifier | Effect on the rendered type | Effect on the rendered validator |
| --- | --- | --- |
| `.optional()` | `prop?: T` | `.optional()` |
| `.nullable()` | `T \| null` | `.nullable()` |
| `.arrayed()` | `T[]` | no change (arrays come from `z.array`) |
| `.partial()` | `Partial<T>` | `.partial()` |
| `.recordSet()` | `Record<string, T>` | — |
| `.description(text)` | JSDoc on the declaration or property | — |

`scope.unknown()` is the safe choice for values whose shape is genuinely unknown — it renders `unknown` and `z.unknown()`, never `any`. `.metadata(data)` attaches arbitrary data for a custom generator without changing the output.

### 2. Render types and validators

`generate()` returns formatted source text. The simple case is a single primitive rendered twice from one container.

```typescript
import { SchemaContainer, TypeGenerator, ZodGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
container.scope().string().named('Email');

const types = await new TypeGenerator().generate(container);
const validators = await new ZodGenerator().generate(container);

console.log(types);
console.log(validators);
```

```text
/**
 * @type
 */
export type Email = string;
```

```text
import * as z from 'zod';

export const EmailSchema = z.string();
```

The next level renders the `Customer` object from the previous subsection. `TypeGenerator` chooses `interface` for plain root objects and `type` for primitives, enums, references, and objects carrying modifiers; `ZodGenerator` emits one exported `const` per named schema, suffixed with `schema` by default.

```typescript
import { writeFile } from 'node:fs/promises';
import { SchemaContainer, TypeGenerator, ZodGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

scope
  .object({
    id: scope.number(),
    email: scope.string().pattern('^[^@\\s]+@[^@\\s]+$').maxLength(320),
    nickname: scope.string().optional(),
  })
  .named('Customer');

const types = await new TypeGenerator().generate(container);
const validators = await new ZodGenerator().generate(container);

await writeFile('src/generated/customer.ts', types, 'utf8');
await writeFile('src/generated/customer.schema.ts', validators, 'utf8');
```

Abridged generated TypeScript — the pattern and length contract become JSDoc that survives into the consumer's editor:

```text
/**
 * @interface
 */
export interface Customer {
  id: number;
  /**
   * @pattern ^[^@\s]+@[^@\s]+$
   * @maxLength 320
   * @memberOf {Customer}
   */
  email: string;
  /**
   * @optional
   * @memberOf {Customer}
   */
  nickname?: string;
}
```

Abridged generated validator — the same contract becomes runtime enforcement:

```text
import * as z from 'zod';

export const CustomerSchema = z.object({
  id: z.number(),
  email: z.string().regex(new RegExp("^[^@\\s]+@[^@\\s]+$")).max(320),
  nickname: z.string().optional(),
});
```

Both generators can run against the same container in either order. `generate()` renders every named object once and then returns the whole document, so one call produces a complete file.

### 3. Model a PostgreSQL database

`DatabaseSchema` models tables, columns, constraints, indexes, and views. It is a description only — nothing connects to a database.

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');
schema.extension('pgcrypto');

const customer = schema.table('customer');
customer.bigserial('id').primaryKey();
customer.varchar('email', 320).unique();
customer.text('display_name').nullable();
customer.timestamptz('created_at').default('now()');

const orders = schema.table('orders');
orders.bigserial('id').primaryKey();
orders.bigint('customer_id');
orders.foreignKeyConstraint(customer).from('customer_id').to('id').onDelete('CASCADE');
orders.numeric('total', 12, 2);
orders.text('status').default('open', true);
orders.index().indexName('orders_customer_id_idx').column('customer_id');

schema.view('active_customers').as('SELECT id, email FROM public.customer');

const ddl = new PostgreSQLSchemaGenerator(schema).generateGrouped();

console.log(ddl.schema);
console.log(ddl.indexes);
console.log(ddl.views);
```

Abridged `ddl.schema` — the first table, in declaration order:

```text
CREATE TABLE public.customer (
	id bigserial NOT NULL,
	email varchar(320) NOT NULL,
	display_name text,
	created_at timestamptz NOT NULL DEFAULT now()
);
```

`generateGrouped()` returns four strings so callers can apply them in dependency order:

| Field | Contains |
| --- | --- |
| `schema` | `CREATE EXTENSION`, schema creation, `CREATE TABLE`, `ALTER TABLE … ADD CONSTRAINT`, and `COMMENT ON` statements |
| `indexes` | Every `CREATE INDEX`, including `USING`, `INCLUDE`, `WITH`, `TABLESPACE`, and `WHERE` |
| `views` | `DROP VIEW` / `CREATE OR REPLACE VIEW` / `CREATE MATERIALIZED VIEW` plus view comments |
| `all` | `schema`, then `indexes`, then `views` |

`generate()` returns `all`. Pass `{ dropBeforeCreate: false }` when the target already owns its tables: the default drops schemas and tables first, which is right for a disposable database and wrong for a shared one.

### 4. Publish an API contract

A project declares one default-exported contract in `blendsdk.api.ts`. It names the controllers to collect, where to write the artifacts, and the document metadata.

```typescript
// blendsdk.api.ts
import { z } from 'zod';
import { defineApiContract } from 'blendsdk/codegen';

const product = z.object({ id: z.number(), name: z.string() });

class ProductsController {
  public routes() {
    return [
      {
        method: 'get' as const,
        path: '/',
        handler: () => undefined,
        openapi: {
          operationId: 'listProducts',
          tags: ['products'],
          responses: [
            { statusCode: 200, description: 'Product list', schema: z.array(product) },
          ],
        },
      },
    ];
  }
}

export default defineApiContract({
  outputDir: 'src/api-client',
  controllers: [{ basePath: '/api/products', controller: ProductsController }],
  openapi: { title: 'Catalog API', version: '1.0.0' },
});
```

Only routes carrying `.openapi()` metadata reach the document; that is the opt-in mechanism. `defineApiContract` is an identity function that gives the literal type inference — validation happens when the contract is loaded.

```bash
# Rebuild api.json and the typed client from the configured controllers.
blendsdk api generate

# Rebuild in memory and fail when either artifact differs from the committed one.
blendsdk api check
```

`generate` writes `api.json` first, then the client. `check` writes nothing: it reports every drifting file and returns a non-zero exit code, which is what makes it usable as a CI gate. Both accept `--config <path>`.

The same pipeline is available in code. `OpenAPIGenerator` collects the routes and produces the document; `generateClient` then consumes it (next subsection).

```typescript fragment
import { OpenAPIGenerator } from 'blendsdk/codegen';

const generator = new OpenAPIGenerator({ title: 'Catalog API', version: '1.0.0' });
generator.addController('/api/products', ProductsController);

const document = generator.generate();
```

| Method | Purpose |
| --- | --- |
| `addController(basePath, ControllerClass)` | Instantiates the controller with empty settings/services, calls `routes()`, and keeps only annotated routes |
| `addRoutes(basePath, routeDefinitions)` | Adds route definitions you already hold |
| `generate()` | Returns the `OpenAPIDocument` |
| `toJSON(indent?)` | Returns formatted JSON (default two spaces) |
| `toFile(path)` | Writes the JSON and creates parent directories |

### 5. Generate a typed client

`generateClient` reads an OpenAPI 3.1 document and writes TypeScript whose method names and result types come from the operations. It only needs public types, so a committed `api.json` is enough.

```typescript
import { checkClient, generateClient, type OpenAPIDocument } from 'blendsdk/codegen';

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Catalog API', version: '1.0.0' },
  paths: {
    '/api/products/{id}': {
      get: {
        operationId: 'getProduct',
        tags: ['products'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'A single product',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Product' } },
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

const generated = await generateClient(document, {
  outputDir: 'src/api-client',
  clientName: 'CatalogClient',
});

console.log(generated.files); // ['client.ts', 'index.ts', 'types.ts']

const drift = await checkClient(document, { outputDir: 'src/api-client' });
console.log(drift.drifted); // false
```

Every generated file starts with a fixed marker line. On each run the generator prunes marker-bearing files it no longer produces and never touches a file without the marker, so hand-written helpers can live beside generated output.

| Grouping | Files |
| --- | --- |
| `splitByGroup: false` (default) | `types.ts`, `client.ts`, `index.ts` |
| `splitByGroup: true` | `types.ts`, one `client.<group>.ts` per tag, a `client.ts` barrel, `index.ts` |

| Result field | Meaning |
| --- | --- |
| `files` | File names written (`generate`) or compared (`check`) |
| `issues` | Contract problems with `severity`, `message`, and the operation location |
| `drifted` | `check` only: `true` when a file differs or a contract error exists |
| `driftedFiles` | `check` only: the files that differ |

### 6. Plan and apply migrations

Migrations are offline-first: `generateMigration` compares the configured `DatabaseSchema` against the committed snapshot and writes one immutable `*.up.sql` plus a new canonical `schema.snapshot.json`. It never reads a database.

```typescript
// blendsdk.migrations.ts
import { defineMigrationConfig } from 'blendsdk/codegen';

export default defineMigrationConfig({
  schema: './src/database/schema.ts',
  migrationsDir: './migrations',
});
```

```typescript
// src/database/schema.ts
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');

const customer = schema.table('customer');
customer.bigserial('id').primaryKey();
customer.varchar('email', 320).unique();

export default schema;
```

```bash
# Create the first lineage: one migration plus the canonical snapshot.
blendsdk migrate baseline initial

# Apply pending migrations. Set DATABASE_URL (or the configured variable) first.
blendsdk migrate up

# Observe without mutating.
blendsdk migrate status
```

After editing `src/database/schema.ts`, generate the next migration and validate the history:

```bash
blendsdk migrate generate add-customer-display-name
blendsdk migrate validate --offline
```

The same operations are public functions.

```typescript
import { generateMigration, runMigrations, getMigrationStatus } from 'blendsdk/codegen';

const planned = await generateMigration({ name: 'add-customer-display-name' });

if (planned.status === 'GENERATED' && planned.migration) {
  console.log(`Wrote ${planned.migration.id}`);
  console.log(`${planned.changes.length} change(s) across ${planned.changes.length} statement(s)`);
} else {
  console.log('Desired schema is already current; nothing was written.');
}

const before = await getMigrationStatus();
console.log(before.status); // 'PENDING'

const applied = await runMigrations({ command: 'up' });
console.log(applied.status); // 'UP_TO_DATE'
```

| Command | Purpose | Notable options |
| --- | --- | --- |
| `generate <name>` | Offline diff against the snapshot; writes SQL + snapshot | `--allow-destructive`, `--rename-table`, `--rename-column` |
| `create <name>` | Manual no-op template for reviewed SQL | `--with-down`, `--no-transaction` |
| `up` | Apply pending migrations under one advisory lock | `--dry-run` |
| `down` | Revert exactly the latest migration | `--allow-down` (required) |
| `status` | Observe state without mutation | — |
| `validate` | Validate local and live history | `--offline` |
| `baseline <name>` | Create the first lineage; refuses existing history | — |
| `adopt-baseline` | Record an existing database after proving structural equality | `--confirm-adoption <database>/<baseline-id>` |

Every planned change carries a safety class. `safe` and `destructive` changes can render SQL (the latter only with `--allow-destructive`); `caution`, `ambiguous`, and `unsupported` changes stop generation and carry a `guidance` string instead of guessing.

| Safety | Example | Rendering |
| --- | --- | --- |
| `safe` | Nullable column add, index add, comment | Rendered |
| `caution` | Required column add, `SET NOT NULL` | Blocked: needs a staged strategy |
| `destructive` | Column drop, table drop, constraint drop | Rendered only with explicit approval |
| `ambiguous` | Apparent table or column rename | Blocked: supply a rename hint |
| `unsupported` | Type change, generated/identity transition, view replacement | Blocked: reviewed manual SQL |

---

## Configuration

Configuration lives in two optional files discovered from the working directory upward, plus options passed directly to a generator.

### `blendsdk.migrations.ts`

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `schema` | `string` | — (required by `generate`, `baseline`, `adopt-baseline`) | Module whose default export is one `DatabaseSchema` |
| `migrationsDir` | `string` | `migrations` | Directory for immutable SQL files; resolved against the config file |
| `snapshotFile` | `string` | `<migrationsDir>/schema.snapshot.json` | Canonical desired-state snapshot; must not use a `.up.sql` / `.down.sql` name |
| `databaseUrlEnv` | `string` | `DATABASE_URL` | Uppercase environment-variable name holding the PostgreSQL URL; the URL itself is never stored in config |
| `lockTimeoutMs` | `number` | `5000` | Advisory-lock deadline, integer `1`–`300000` |
| `statementTimeoutMs` | `number` | `900000` | Per-migration statement deadline, integer `1`–`86400000` |

### `blendsdk.api.ts`

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `outputDir` | `string` | — (required) | Directory for the generated client |
| `contractFile` | `string` | `api.json` | Committed OpenAPI document |
| `controllers` | `ApiContractController[]` | — (required) | `{ basePath, controller }` pairs to collect |
| `openapi` | `OpenAPIGeneratorConfig` | — (required) | Document metadata; `title` and `version` are required |
| `generator` | `Omit<ClientGeneratorOptions, 'outputDir'>` | `{}` | Client flags; unknown keys are rejected |

### `ClientGeneratorOptions`

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `outputDir` | `string` | — (required) | Where generated files are written |
| `splitByGroup` | `boolean` | `false` | Emit one file per tag plus a barrel |
| `strict` | `boolean` | `false` | Promote contract problems to errors during `generate` |
| `clientName` | `string` | `AppClient` | Base name of the generated client type and its `create…` factory |
| `runtimeImport` | `string` | `blendsdk/api-client` | Import specifier used by generated clients |

### `OpenAPIGeneratorConfig`

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `title` | `string` | — (required) | `info.title` |
| `version` | `string` | — (required) | `info.version` |
| `description` | `string` | — | `info.description`, Markdown allowed |
| `servers` | `OpenAPIServer[]` | — | Emitted only when the array is non-empty |
| `securitySchemes` | `Record<string, OpenAPISecurityScheme>` | — | Emitted under `components.securitySchemes` |
| `defaultSecurity` | `SecurityRequirement[]` | — | Applied to routes marked `secure` |

### Generator constructors

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `DatabaseSchema(name, defaultScope?)` | constructor | `defaultScope = 'public'` | Scope assigned to tables created without `.scope()` |
| `ZodGeneratorOptions.zodVariablePostfix` | `string` | `'schema'` | Suffix for every generated validator constant |
| `PostgreSQLSchemaGenerator.generate({ dropBeforeCreate })` | option | `true` | Emit `DROP SCHEMA` / `DROP TABLE` before creating |

### Discovery and path rules

| Rule | `blendsdk.migrations.ts` | `blendsdk.api.ts` |
| --- | --- | --- |
| Explicit path | `--config <file-or-directory>` | `--config <file-or-directory>` |
| Upward search | Stops at the filesystem root | Stops at the first `.git` entry |
| Relative paths | Resolved against the config directory; may not escape it | Resolved against the config directory; may not escape it |
| Absolute paths | Trusted (developer-authored file) | Trusted (developer-authored file) |
| Filesystem root | Rejected | Rejected |

Both loaders reject unknown keys instead of ignoring them, so a typo fails immediately with a configuration error rather than silently falling back to a default.

---

## Error Handling

The package uses three error surfaces, each matching the operation that failed.

| Surface | Raised by | Shape |
| --- | --- | --- |
| `MigrationError` | `generateMigration`, `generateBaseline`, `runMigrations`, `getMigrationStatus`, `validateMigrations`, `adoptBaseline` | `kind`, `exitCode`, sanitized `message` |
| `ClientGenerationError` | `generateClient`, `checkClient` | `name`, `message` naming both conflicting operations |
| `Error` | Schema DSL and generator authoring | Plain `Error` with an actionable message |

### Migration failures

`MigrationError` carries a stable `kind` so callers can branch without parsing text, and an `exitCode` that the CLI returns unchanged.

| `kind` | `exitCode` | Raised when |
| --- | --- | --- |
| `CONFIGURATION` | `2` | Config missing, unknown key, bad path, missing database URL variable, malformed rename hint |
| `INVALID_HISTORY` | `1` | Filename, header, checksum, lineage, or applied-prefix mismatch; missing down file; ledger shape mismatch |
| `FILESYSTEM` | `1` | Unsafe target, existing migration file, or a failed write, sync, or rename |
| `DATABASE` | `1` | PostgreSQL connection or execution failure (message sanitized) |
| `LOCKED` | `1` | The advisory lock was not acquired before `lockTimeoutMs` |
| `UNKNOWN_OUTCOME` | `1` | A nontransactional migration was interrupted after dispatch |
| `UNSUPPORTED` | `1` | A change needs reviewed manual SQL, or the catalog shape is unsupported |
| `ABORTED` | `1` | The caller's `AbortSignal` fired |
| `INTERNAL` | `1` | An internal invariant was violated |

```typescript
import { MigrationError, formatMigrationError, generateMigration } from 'blendsdk/codegen';

try {
  const result = await generateMigration({ name: 'add-customer-display-name' });
  console.log(result.status);
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(formatMigrationError(error)); // 'UNSUPPORTED: Populate and validate existing rows…'
    console.error(error.kind, error.exitCode); // 'UNSUPPORTED' 1
  } else {
    throw error;
  }
}
```

Messages are redacted at construction time: a full `postgresql://…` URL becomes `[REDACTED_DATABASE_URL]` and `password=…` becomes `password=[REDACTED]`, so ordinary error logging cannot leak credentials. SQL text is never included; `sensitiveDetail` is accepted but not retained.

Pass an `AbortSignal` to cancel a run. Cancellation is reported as `ABORTED`, and a cancellation after a nontransactional migration was dispatched is `UNKNOWN_OUTCOME`, not `ABORTED`.

```typescript
import { MigrationError, runMigrations } from 'blendsdk/codegen';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

try {
  const result = await runMigrations({ command: 'up', signal: controller.signal });
  console.log(result.status);
} catch (error) {
  if (error instanceof MigrationError && error.kind === 'ABORTED') {
    console.warn('Migration cancelled; committed migrations remain applied.');
  } else {
    throw error;
  }
}
```

### Client generation failures

`generateClient` throws `ClientGenerationError` for a duplicate `operationId`, and for two operations that resolve to the same group and method name after sanitization. It fails before writing anything, so a broken contract cannot leave partial output.

```typescript
import { ClientGenerationError, generateClient, type OpenAPIDocument } from 'blendsdk/codegen';

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Catalog API', version: '1.0.0' },
  paths: {
    '/api/a': {
      get: {
        operationId: 'listItems',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/b': {
      get: {
        operationId: 'listItems',
        responses: { '200': { description: 'OK' } },
      },
    },
  },
};

try {
  await generateClient(document, { outputDir: 'src/api-client' });
} catch (error) {
  if (error instanceof ClientGenerationError) {
    console.error(error.message); // names GET /api/a and GET /api/b
  } else {
    throw error;
  }
}
```

Problems that do not prevent generation are returned as `issues` instead of thrown: a missing `operationId`, a reserved method name that had to be escaped, a duplicated parameter name, or a missing 2xx response schema. They are `warning` during `generate` and become `error` under `strict: true` or during `checkClient`.

### Authoring errors

The schema DSL validates at the call site, so a bad contract fails where it is written rather than inside the generator.

```typescript
import { SchemaContainer } from 'blendsdk/codegen';

const scope = new SchemaContainer().scope();

try {
  scope.string().pattern('[');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid pattern.');
}

try {
  scope.string().minLength(3).maxLength(2);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Inconsistent bounds.');
}
```

| Call | Rejected input |
| --- | --- |
| `.pattern()` | Empty source, invalid regular expression, or a `RegExp` carrying flags |
| `.minLength()` / `.maxLength()` | Negative or non-integer values, or a bound that contradicts the other |
| `.deferrable()` | Anything other than `'DEFERRED'` or `'IMMEDIATE'` |
| `.identity()` | A non-integer, non-`uuid` type, or a column that is already generated |
| `.generated(expr, 'VIRTUAL')` | PostgreSQL has no virtual generated columns |
| `.named()` | A name already registered in the same scope |
| `.column()` on a constraint | A column that does not exist on the table |
| `TypeGenerator` / `ZodGenerator` | A reference to an unnamed schema, or a named property |

### CLI exit codes

Both command groups return the same three exit classes, and neither calls `process.exit` — the executable wrapper assigns `process.exitCode`.

| Code | `blendsdk api` | `blendsdk migrate` |
| --- | --- | --- |
| `0` | Artifacts written (`generate`) or already current (`check`) | Command completed |
| `1` | Drift detected, or an operational failure | Operational failure (history, database, lock, unknown outcome) |
| `2` | Usage or configuration error | Usage or configuration error |

Because `check` and `validate` report through the exit code, a CI step is a single command:

```bash
blendsdk api check && blendsdk migrate validate --offline
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
