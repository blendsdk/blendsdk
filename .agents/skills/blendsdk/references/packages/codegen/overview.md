> **Package**: `blendsdk/codegen`

# codegen Overview

---

## What It Is

`blendsdk/codegen` is the BlendSDK package for schema-driven code generation and PostgreSQL schema tooling. A project defines its data shapes once — either as data-shape schemas through `SchemaContainer`/`SchemaScope`, or as a relational model through `DatabaseSchema` — and the package derives everything downstream from that single source of truth: TypeScript types and interfaces, Zod validators, constant types, OpenAPI v3.1 documents, complete PostgreSQL initializer DDL, and reviewable, checksummed migrations whose applied history is verified against the live database. The package is ESM-only, targets Node.js >= 22, is written in strict TypeScript, and is MIT licensed; PostgreSQL is the only supported database dialect.

---

## Key Features

- **Fluent schema authoring** — `SchemaContainer` and named `SchemaScope`s create primitives (`string()`, `number()`, `boolean()`, `date()`, `any()`), objects, enums, and references (`ref()`), with `.optional()`, `.nullable()`, `.arrayed()`, `.partial()`, and `.recordSet()` modifiers; descriptions and metadata flow into generated output, and named scopes (`scope('api_v1')`) produce prefixed, collision-free type names.
- **TypeScript type generation** — `TypeGenerator` emits exported `interface`/`type` declarations with JSDoc comments, `Partial<T>`, array types, nullable unions, and named references; results are Prettier-formatted.
- **Zod validation generation** — `ZodGenerator` emits Zod v4 schemas (`z.object(...)`, `z.string()`, ...) from the same schema model, keeping runtime validation aligned with generated types.
- **Constant type generation** — `CTypeGenerator` emits `e<Name>` constant objects mapping `$TABLE` and uppercase column names for type-safe query code.
- **OpenAPI 3.1 generation** — `OpenAPIGenerator` documents `blendsdk/webafx` routes that opt in via `.openapi()` metadata: `:param` paths become `{param}`, POST/PUT/PATCH Zod validation becomes the request body, GET/DELETE validation becomes query parameters, secure routes pick up configured security schemes, and `generate()`, `toJSON()`, and `toFile()` produce the document.
- **Zod → JSON Schema conversion** — `convertZodToJsonSchema(schema, direction)` and `convertZodToQueryParameters(schema)` convert Zod v4 schemas with Zod's native `z.toJSONSchema` (input/output aware, `draft-2020-12`); request bodies and query schemas use `'input'`, response schemas use `'output'`.
- **Typed client generation** — `defineApiContract` declares the controllers and output, `generateClient` writes a typed TypeScript client from the OpenAPI 3.1 document, and `checkClient` fails when the committed client drifts from the controllers.
- **PostgreSQL relational model** — `DatabaseSchema` describes schema scopes, tables, and typed columns (numeric, text, uuid, jsonb, vector, tsvector, and more) with primary keys, unique/check/foreign-key constraints, indexes (unique, partial, expression, `INCLUDE`, storage parameters, tablespace, concurrent creation), comments, extensions, and regular or materialized views.
- **PostgreSQL schema generator** — `PostgreSQLSchemaGenerator` renders a desired-state `DatabaseSchema` as complete, deterministic bootstrap (initializer) DDL grouped into schema, index, and view sections for provisioning fresh databases.
- **PostgreSQL introspection** — `PostgreSQLIntrospector.introspect()` reads an existing catalog (tables, partitioned tables, views, materialized views, composite types, enum types, domains) into a `SchemaContainer` so `TypeGenerator` can emit types; a `ColumnMapper` hook overrides individual column mappings, and unmappable types fall back to a deprecated `any` schema with a warning.
- **Snapshot-based migration generation** — `defineMigrationConfig`, `generateBaseline`, and `generateMigration` compare the desired schema against a committed canonical snapshot and publish immutable, versioned SQL migrations with lineage headers plus the next snapshot; ambiguous renames, unsafe changes, and unsupported transitions are blocked with guidance instead of being guessed.
- **Checksummed migration execution** — `runMigrations`, `getMigrationStatus`, and `validateMigrations` verify local files against the applied ledger prefix by exact checksum, serialize concurrent runs with a database-scoped PostgreSQL advisory lock, support dry-run previews, guard `down` behind explicit confirmation, and track nontransactional runs through durable dirty markers with `MigrationStatus` values `UP_TO_DATE`, `PENDING`, `INVALID_HISTORY`, `LOCKED`, and `UNKNOWN_OUTCOME`.
- **Baseline adoption** — `adoptBaseline` records the initial lineage of an existing database only after a structural catalog comparison proves it matches the generated baseline; drift, unsupported shapes, and nonempty history are rejected without mutation.
- **Lifecycle CLI** — the `blendsdk migrate` executable exposes exactly eight commands (`baseline`, `generate`, `create`, `up`, `down`, `status`, `validate`, `adopt-baseline`), maps outcomes to exit codes 0/1/2, and redacts credentials and SQL from diagnostics.

---

## When To Use

- Generating TypeScript types and interfaces for API payloads, DTOs, and domain models from a single schema definition instead of hand-maintaining `interface` files.
- Keeping Zod runtime validation, TypeScript types, and OpenAPI v3.1 documentation in lockstep for a webafx-based API.
- Managing a PostgreSQL database as code: model the desired schema, generate reviewable SQL from a committed snapshot, and apply only committed migrations.
- Bootstrapping fresh databases, test environments, or CI databases from the same desired-state model.
- Producing TypeScript types from an existing PostgreSQL database read-only — before or without adopting the migration workflow.
- Emitting table and column name constant objects for query code.
- Avoid it when the need is runtime behavior — query execution, connection management, and ORM semantics belong to the other BlendSDK database packages; this package's job is to generate artifacts and run reviewed migrations.

---

## Architecture

The package is organized into four module groups, all re-exported from the single public entry point. Two independent pipelines share the same authoring models: schema → generated source, and database schema → migrations.

```text
blendsdk/codegen
│
├── schema/       data-shape authoring: SchemaContainer → SchemaScope → SchemaObject
│      │          (primitives, objects, references, enums, modifiers)
│      ▼
├── generator/    → TypeGenerator · ZodGenerator · CTypeGenerator
│                 → OpenAPIGenerator + zod-to-openapi (from webafx routes)
│                 → generateClient / checkClient (OpenAPI document → typed client)
│                 → PostgreSQLSchemaGenerator (from DatabaseSchema)
│
├── database/     relational authoring: DatabaseSchema → TableSchema → columns,
│                 constraints, IndexConstraint, views
│                 PostgreSQLIntrospector: live catalog → SchemaContainer
│      │
│      ▼
└── migration/    config → canonical snapshot → semantic diff → SQL → published
                  artifacts → ledger-backed, lock-serialized execution
```

### Module Layout

- `schema/` — the data-shape model: `SchemaContainer` owns scopes, `SchemaScope` creates schema objects (`string()`, `object()`, `ref()`, ...), and every object carries naming, description, and modifier state that generators consume.
- `generator/` — emission classes and their inputs. An internal abstract `Generator` base class fixes traversal and formatting for `TypeGenerator`, `ZodGenerator`, and `CTypeGenerator` (which consume a `SchemaContainer`). `PostgreSQLSchemaGenerator` (consumes `DatabaseSchema`), `OpenAPIGenerator` plus the Zod→OpenAPI converter (consume webafx routes and Zod schemas), and the typed client generator (`generateClient`/`checkClient`, consuming an OpenAPI document) deliberately do not extend that base class.
- `database/` — the relational authoring model (`DatabaseSchema`, `TableSchema`, `TableColumnSchema`, `IndexConstraint`, views) and `PostgreSQLIntrospector` with its catalog SQL and `ColumnMapper` strategy.
- `migration/` — the PostgreSQL-only lifecycle: configuration loading, canonical snapshot normalization and hashing, semantic diffing with rename hints, deterministic SQL rendering, atomic artifact publication, and an advisory-lock-serialized runner with ledger verification, driven by the `blendsdk migrate` CLI.

### Design Patterns

- **Builder** — chainable authoring across schema objects, `DatabaseSchema.table(...)`, column helpers, constraints, `IndexConstraint`, and views.
- **Factory Method** — scope factories (`scope.string()`, `scope.object()`) and table helpers (`table.varchar()`, `table.index()`) create pre-configured model objects.
- **Template Method** — the abstract generator base fixes traversal, named-root filtering, and Prettier formatting; subclasses implement object, reference, and primitive rendering.
- **Strategy** — `ColumnMapper` overrides introspection mapping per column; generator option objects configure emission; rename hints steer snapshot diffing.
- **Facade** — `SchemaContainer` fronts scope/object creation, `PostgreSQLIntrospector` fronts catalog SQL, and `runMigrations` fronts configuration, locking, ledger, and execution behind one public call.

### Operational Design

Generated code and snapshots are deterministic: the schema model is normalized into canonical, ordered bytes, snapshots are hashed with SHA-256, and emitted source is run through Prettier. The migration pipeline is fail-closed: local files and ledger rows must match as an exact prefix before any SQL executes; artifacts are written, flushed, verified, and only then published, so a failed run never leaves a new migration paired with an old snapshot; and failures surface as typed `MigrationError` values with credentials and SQL body content redacted. The package never auto-repairs migration history — torn states are reported with manual, auditable recovery options only.

---

## Dependencies

`blendsdk/codegen` is a workspace-internal package (`"private": true`). It is distributed through the assembled `blendsdk` package, which re-exports the same public API under its `blendsdk/codegen` entry point and ships this package's CLI as the `blendsdk migrate` executable.

| Dependency | Type | Used for |
| --- | --- | --- |
| `blendsdk/cmdline` | Internal runtime | Argument parsing for the migration CLI |
| `blendsdk/dbcore` | Internal runtime | Shared database core utilities |
| `blendsdk/postgresql` | Internal runtime | `PostgreSQLDatabase` client used by `PostgreSQLIntrospector` |
| `blendsdk/webafx` | Internal runtime | `RouteDefinition` and `HttpMethod` types consumed by `OpenAPIGenerator` |
| `jiti` | External runtime | Loading TypeScript configuration and schema modules at runtime |
| `pg` | External runtime | PostgreSQL driver for introspection and the migration runner/ledger |
| `postgres-array` | External runtime | Parsing PostgreSQL array results during introspection |
| `zod` | External runtime | Zod v4 schemas and the native `z.toJSONSchema` converter used by the OpenAPI layer |

**Formatting.** Emitted source is formatted with Prettier before it is returned; the assembled `blendsdk` distribution declares Prettier as a runtime dependency.

**Peer dependencies.** `blendsdk/codegen` declares no peer dependencies itself. When installed through the assembled `blendsdk` package, `pg` is an optional peer dependency: the executable and non-database APIs load without a PostgreSQL driver, and database-backed commands require `pg` in the consuming project.

**Depended on by.** The assembled `blendsdk` package (public re-export and CLI) and, inside the monorepo, the database-migrations playground and documentation packages. Database-backed test suites run under Vitest against a disposable PostgreSQL instance.

---

## Minimum Example

The shortest complete flow — define a data shape and generate TypeScript from it:

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

scope
  .object({
    id: scope.number(),
    name: scope.string(),
    email: scope.string().optional(),
  })
  .named('User');

const source = await new TypeGenerator().generate(schema);
console.log(source);
```

The generated `source` is formatted TypeScript:

```typescript fragment
export interface User {
  id: number;
  name: string;
  email?: string;
}
```

Later documents cover the schema model, each generator, the relational model, introspection, and the migration lifecycle in detail.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
