> **Package**: `blendsdk/codegen`

# codegen Overview

---

## What It Is

`blendsdk/codegen` is the code-generation package of the BlendSDK monorepo. It models two authoring domains in TypeScript — data shapes and PostgreSQL databases — and deterministically turns those models into committed artifacts: TypeScript type declarations, Zod validation schemas, relation constants, PostgreSQL DDL, reviewable migration SQL with a canonical desired-state snapshot, and an OpenAPI 3.1 contract plus a typed API client. A companion database-backed surface then executes or inspects the result: a checksummed PostgreSQL migration runner, an existing-database baseline adoption flow, and a read-only catalog introspector. Generation is deterministic and Prettier-normalized, each generator has a matching `check`/`validate` path for CI, and every failure is reported as a typed, sanitized error — never as raw SQL, a connection string, or a partially written artifact.

| Area | Representative exports | What it produces |
| --- | --- | --- |
| Data-shape modeling | `SchemaContainer`, `SchemaScope`, `ObjectSchema`, `PrimitiveSchema`, `ReferenceSchema` | Named, scoped shapes used as generator input |
| Type & validation generation | `TypeGenerator`, `ZodGenerator`, `CTypeGenerator` | TypeScript types and interfaces, Zod schemas, relation constants |
| PostgreSQL modeling | `DatabaseSchema`, `TableSchema`, `TableColumnSchema`, `IndexConstraint` | Desired database state: tables, columns, constraints, indexes, views, extensions |
| PostgreSQL DDL | `PostgreSQLSchemaGenerator` | Bootstrap `CREATE`/`COMMENT` SQL in schema, index, and view groups |
| Introspection | `PostgreSQLIntrospector`, `ColumnMapper` | A type-generation schema model read from a live catalog |
| OpenAPI & client generation | `OpenAPIGenerator`, `generateClient`, `checkClient` | OpenAPI 3.1 document, typed client, drift report |
| API contract workflow | `ApiContract`, `defineApiContract` | A `blendsdk.api.ts` contract plus the `blendsdk api generate|check` drift gate |
| PostgreSQL migrations | `defineMigrationConfig`, `generateMigration`, `generateBaseline`, `adoptBaseline`, `runMigrations`, `getMigrationStatus`, `validateMigrations` | Reviewed `.up.sql` files, `schema.snapshot.json`, and an applied ledger |

---

## Key Features

- **Fluent, scoped authoring.** `SchemaContainer` + `SchemaScope` build data shapes — objects, strings, numbers, booleans, bigints, dates, references, enums, arrays, nullable, optional, partial, and record types — with automatic name registration that rejects duplicate identities.
- **Deterministic generated TypeScript.** `TypeGenerator` renders interfaces and type aliases with JSDoc, `ZodGenerator` renders matching Zod schemas, and `CTypeGenerator` renders relation/column constants; all of them format their output through Prettier for byte-stable diffs.
- **Complete PostgreSQL schema model.** `DatabaseSchema`, `TableSchema`, and `TableColumnSchema` express columns, defaults, identity and generated columns, comments, primary keys, foreign keys, unique and check constraints, indexes (methods, expressions, `INCLUDE`, storage parameters, tablespaces), extensions, and regular or materialized views.
- **Bootstrap and incremental SQL.** `PostgreSQLSchemaGenerator` renders re-runnable DDL for a fresh database, while `generateMigration` renders targeted SQL for the difference between the committed canonical snapshot and the desired schema.
- **Review-first, safety-classified migrations.** Every generated migration is an immutable `.up.sql` file with a strict five-line header, an exact-byte SHA-256 checksum, and explicit snapshot lineage; the next `schema.snapshot.json` is published atomically with it. The differ classifies each change as `safe`, `caution`, `destructive`, `ambiguous`, or `unsupported` and blocks anything it cannot prove.
- **Guarded execution.** `runMigrations` applies pending files under a per-database advisory lock with a fixed ledger (`public.blendsdk_migrations`), enforces lock/statement timeouts, distinguishes transactional from nontransactional migrations, durably marks uncertain outcomes, and re-verifies file checksums after the lock wait. Status is reported as `UP_TO_DATE`, `PENDING`, `INVALID_HISTORY`, `LOCKED`, or `UNKNOWN_OUTCOME`.
- **OpenAPI 3.1 from controllers.** `OpenAPIGenerator` collects only routes that opted in with `.openapi()` metadata, converts Zod v4 schemas natively, converts Express `:param` paths to `{param}`, hoists reusable definitions into `components.schemas`, and sorts output for reproducibility.
- **Typed client with a built-in drift gate.** `generateClient` writes a typed client (single file or one file per group, with stale generated files pruned and hand-written files untouched); `checkClient` regenerates in memory and reports drift without writing — the mechanism behind `blendsdk api check` in CI.
- **Read-only introspection.** `PostgreSQLIntrospector` maps tables, views, enums, composites, and domains into the schema model so `TypeGenerator` can emit types from an existing database; a `ColumnMapper` strategy overrides any column, and unmapped types fall back to a deprecated placeholder schema with a console warning.
- **Robust CLI surface.** `blendsdk api generate|check` and `blendsdk migrate ...` parse strict arguments, return stable exit codes (`0` success, `1` operational/drift failure, `2` usage or configuration failure), never call `process.exit` from library code, and redact database URLs, credentials, and SQL from error output.

---

## When To Use

Reach for `blendsdk/codegen` when:

- You want one TypeScript-authored source of truth for data shapes, with TypeScript types and/or Zod validation schemas generated from it.
- You want a PostgreSQL schema expressed with a fluent TypeScript model — either as one-shot bootstrap DDL or as incremental, reviewable migrations committed next to the code.
- You want a CI gate that fails when the committed OpenAPI contract (`api.json`) or the generated API client is out of date with the controllers.
- You need TypeScript declarations for an existing PostgreSQL database, read-only through the introspector.
- You need to bring an existing, structurally matching PostgreSQL database under migration control without executing its baseline SQL (`adoptBaseline`).

It is the wrong tool when:

- You need an ORM or a runtime data-access layer — this package produces code and SQL; it does not read or write application rows on its own.
- You need the full OpenAPI or JSON Schema surface — the generator and its types cover the subset the package emits and consumes for OpenAPI 3.1 documents.
- You target a database other than PostgreSQL — the schema model (DDL), migrations, and introspection are PostgreSQL-only.

---

## Architecture

Everything in the package follows one shape: **model → generate → commit (→ execute)**. Models are plain TypeScript builder objects with no I/O. Generators are stateless traversals that render normalized text — they sort, deduplicate, and format so the same input always produces the same bytes. CLI adapters own argument parsing and exit codes, while the underlying services (`generateClient`, `generateMigration`, `runMigrations`) can be called directly from code with identical behavior.

```
┌───────────────────────────── Authoring models ─────────────────────────────┐
│ SchemaContainer + SchemaScope (data shapes)                                │
│ DatabaseSchema (tables, columns, constraints, indexes, views, extensions)  │
│ blendsdk.api.ts (ApiContract)      blendsdk.migrations.ts (MigrationConfig)│
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼─────────────────────────────────────────┐
│ Generators (deterministic, Prettier-normalized)                            │
│ TypeGenerator · ZodGenerator · CTypeGenerator                              │
│ PostgreSQLSchemaGenerator · OpenAPIGenerator                               │
│ generateClient / checkClient · generateMigration / generateBaseline        │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼─────────────────────────────────────────┐
│ Outputs and execution                                                      │
│ Committed:  *.ts types · DDL SQL · api.json + generated client             │
│             *.up.sql migrations · schema.snapshot.json                     │
│ Live:       blendsdk migrate up/down/status/validate · adopt-baseline      │
│             blendsdk api check (drift gate) · PostgreSQLIntrospector (read)│
└────────────────────────────────────────────────────────────────────────────┘
```

Key design patterns used throughout:

| Pattern | Where it appears |
| --- | --- |
| Builder / fluent interface | `SchemaScope.string()`, `DatabaseSchema.table(...)`, `TableColumnSchema.primaryKey()`, `IndexConstraint.with(...).tablespace(...)` |
| Registry | `SchemaContainer` tracks named, scoped objects and rejects duplicate identities; `DatabaseSchema` exposes its tables, views, and extensions |
| Template method | `Generator.generate()` drives traversal while subclasses implement `renderObjectSchema`, `renderReferenceSchema`, and `renderPrimitiveTypeSchema` |
| Strategy | `ColumnMapper` for introspection overrides; `runtimeImport` selects the generated client's runtime module |
| Factory with type inference | `defineApiContract`, `defineMigrationConfig`, and the `SchemaScope` create-and-register helpers |
| Generate / check pair | `generateClient` ↔ `checkClient`; `blendsdk api generate` ↔ `blendsdk api check` |
| Ports and adapters | `ApiCliIo` and `MigrationCliIo` output boundaries; `main(argv, io)` returns an exit code instead of exiting the process |
| Canonical serialization | Snapshots serialize to exact bytes hashed with SHA-256; generators sort and Prettier-normalize so artifacts are byte-stable |

---

## Dependencies

### Runtime dependencies

| Dependency | Purpose |
| --- | --- |
| `blendsdk/cmdline` | Strict command parsing for the migration CLI |
| `blendsdk/dbcore` | Core database abstractions shared with the other BlendSDK database packages |
| `blendsdk/postgresql` | Connection layer used by `PostgreSQLIntrospector` |
| `blendsdk/webafx` | `RouteDefinition` and controller types consumed by `OpenAPIGenerator` |
| `jiti` | Loads the TypeScript config files (`blendsdk.api.ts`, `blendsdk.migrations.ts`) at runtime with caches disabled |
| `pg` | PostgreSQL driver, imported dynamically by database-backed commands |
| `postgres-array` | Decodes PostgreSQL array values during introspection |
| `zod` | Internal contract validation and the native `z.toJSONSchema` converter behind `OpenAPIGenerator` |

### Peer / runtime requirements

The package manifest declares no `peerDependencies`, but two external requirements behave like peers:

- **`pg` (optional).** Database-backed commands (`up`, `down`, `status`, `validate` against a live database, `adopt-baseline`) import `pg` dynamically and fail with a clear typed error when it is unavailable. In the published `blendsdk` umbrella it is declared as an optional peer dependency.
- **API client runtime.** Generated clients import a runtime module — `blendsdk/api-client` by default, overridable per contract with the `runtimeImport` generator option. Consumers must provide that runtime wherever generated clients compile or run.

### What depends on it

- The assembled **`blendsdk`** package re-exports `blendsdk/codegen` (consumer projects import it as `blendsdk/codegen`) and distributes the `blendsdk` executable that hosts `blendsdk migrate` and `blendsdk api`.
- Committed artifacts — generated clients, `api.json`, migration `.up.sql` files, and `schema.snapshot.json` — depend on this package's output contracts, and the `check`/`validate` operations compare against them byte-for-byte in CI.

---

## Minimum Example

The shortest end-to-end flow authors a data shape and generates TypeScript from it:

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

scope
  .object({
    id: scope.number(),
    name: scope.string(),
    tags: scope.string().arrayed(),
    nickname: scope.string().nullable().optional(),
  })
  .named('Product');

const source: string = await new TypeGenerator().generate(schema);

console.log(source);
```

The generated source (after Prettier formatting):

```typescript
export interface Product {
  id: number;
  name: string;
  tags: string[];
  nickname?: string | null;
}
```

The other pipelines expose the same single-call shape from their own model or config:

```typescript fragment
// PostgreSQL bootstrap DDL from an authored DatabaseSchema
const ddl: string = new PostgreSQLSchemaGenerator(database).generate();

// OpenAPI 3.1 document collected from annotated controller routes
const spec: OpenAPIDocument = new OpenAPIGenerator({ title: 'My API', version: '1.0.0' })
  .addController('/api/products', ProductsController)
  .generate();

// One reviewable migration plus the next canonical snapshot
const result: GenerateMigrationResult = await generateMigration({ name: 'add-customer-status' });
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
