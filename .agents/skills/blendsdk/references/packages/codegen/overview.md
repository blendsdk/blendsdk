> **Package**: `blendsdk/codegen`

# codegen Overview

---

## What It Is

`blendsdk/codegen` is BlendSDK's schema-first generation package. A project describes a schema once — a document shape through a fluent TypeScript schema DSL, or a PostgreSQL database through `DatabaseSchema` — and the package renders the artifacts that are actually shipped and reviewed: TypeScript types, Zod validators, bootstrap DDL, an OpenAPI 3.1 document, a typed API client, and targeted SQL migrations paired with a canonical snapshot. Every renderer is deterministic: collections are sorted, identities are quoted, keys are canonical, and output is normalized through Prettier, so re-running a command with unchanged input produces identical bytes. That property is what makes the package's `check` and `validate` operations usable as CI drift gates. Generators and the migration planner run fully offline; only the introspection and migration runner commands touch PostgreSQL, and they load the `pg` driver lazily.

---

## Key Features

**Schema authoring**

- Fluent, chainable builder for named schema objects: `container.scope()` returns a `SchemaScope` that creates strings, numbers, booleans, dates, `Buffer`, `BigInt`, arbitrary objects, references, and unknown values.
- Modifiers that compose predictably onto the rendered type: `.optional()`, `.nullable()`, `.arrayed()`, `.partial()`, `.recordSet()`.
- String contract constraints — `.pattern()`, `.minLength()`, `.maxLength()` — validated at authoring time and carried into generated TypeScript (JSDoc), generated Zod (`.regex`/`.min`/`.max`), and generated OpenAPI (`pattern`, `minLength`, `maxLength`).
- A `SchemaContainer` registry that owns names and scopes and rejects duplicate identities, so a reference can never silently resolve to the wrong object.

**Generators**

- `TypeGenerator` — emits `export interface` for plain objects and `export type` for primitives, enums, references, and modified objects.
- `ZodGenerator` — emits an equivalent `zod` validator per named schema, including `z.instanceof(Buffer)` for binary columns.
- `PostgreSQLSchemaGenerator` — emits bootstrap DDL (`schema`, `indexes`, `views`, or everything combined) from a `DatabaseSchema`, including extensions, schemas, comments, deferrable foreign keys, and identity columns.
- `CTypeGenerator` — emits constant unions of qualified relation → column names.
- `OpenAPIGenerator` — collects webafx controller routes that carry `.openapi()` metadata and produces an OpenAPI 3.1 document, converting Zod with native `z.toJSONSchema` and hoisting reusable `$defs` into `components.schemas`.

**Typed API clients**

- `generateClient` writes a marker-stamped, Prettier-formatted client (`types.ts`, `client.ts`, `index.ts`, or one `client.<group>.ts` per tag with `splitByGroup`), prunes stale marker files, and never touches hand-written files.
- `checkClient` regenerates in memory and reports drift for a CI gate; `blendsdk api generate` / `blendsdk api check` wrap both behind a `blendsdk.api.ts` contract file.

**PostgreSQL tooling**

- `PostgreSQLIntrospector` projects an existing catalog into a `SchemaContainer` for type generation, with a `ColumnMapper` strategy hook and `introspectConstantTypes()` for column-name maps.
- Snapshot-based migrations: `defineMigrationConfig`, `generateMigration`, `generateBaseline`, `runMigrations`, `getMigrationStatus`, `validateMigrations`, and `adoptBaseline`, backed by a checksummed ledger, a database-scoped advisory lock, and caught-failure atomic publication of the SQL file and snapshot.
- Safety classification on every planned change (`safe`, `caution`, `destructive`, `ambiguous`, `unsupported`), with destructive SQL requiring explicit approval and ambiguous changes requiring explicit rename hints.

---

## When To Use

- **You want one source of truth for types and validation.** Model a shape once and emit TypeScript for the compiler plus Zod for the runtime edge, instead of hand-maintaining two definitions that drift.
- **You have a PostgreSQL database and want typed models for it.** Use `PostgreSQLIntrospector` as a read-only type-generation step; it never mutates the database.
- **You want a contract-first HTTP surface.** Annotate controller routes with `.openapi()`, commit the generated `api.json` and client, and fail CI when either drifts from the source routes.
- **You need reviewable migrations, not automatic schema sync.** Commit the generated `*.up.sql` and `schema.snapshot.json` together, run the reviewed SQL in production, and keep forward recovery as the default.
- **You need disposable-database bootstrapping.** `PostgreSQLSchemaGenerator` renders complete DDL for tests, local environments, or a first deployment.
- **You are adopting an existing database into a managed lineage.** `adoptBaseline` proves structural equality against the desired snapshot before recording history, without executing the baseline SQL.

**Not the right fit for:** being an ORM or runtime row mapper (generated types are compile-time artifacts), or a live “diff the database and fix it” tool — generation is always offline from a committed snapshot, and applied history is never rewritten.

---

## Architecture

The package is five cooperating layers around one in-memory schema model.

```text
schema DSL                      database model
src/schema                      src/database
  SchemaContainer                 DatabaseSchema → TableSchema → columns,
  SchemaScope → schema objects                     constraints, indexes, views
        │                              │
        └──────────────┬───────────────┘
                       ▼
generators (src/generator)
  TypeGenerator ─────────────────► TypeScript types
  ZodGenerator ──────────────────► Zod validators ──► JSON Schema
  PostgreSQLSchemaGenerator ─────► bootstrap DDL
  OpenAPIGenerator (webafx) ─────► api.json ──► generateClient / checkClient
                                                     │
contracts (src/api)                     blendsdk.api.ts ──► `blendsdk api generate|check`
migrations (src/migration)   DatabaseSchema ──► normalize ──► schema.snapshot.json
                             diffSnapshots ──► renderMigrationSql ──► *.up.sql
                             runMigrations ──► ledger · advisory lock · checksums
```

| Pattern | Where it appears | What it buys |
| --- | --- | --- |
| Builder / fluent interface | `SchemaScope`, `TableSchema`, `TableColumnSchema`, constraint classes | Chainable authoring where each call returns the receiver |
| Registry | `SchemaContainer.add` / `find` / `assert` | Named identity, scope-aware lookup, duplicate detection |
| Template method | `TypeGenerator` and `ZodGenerator` render hooks | One traversal of the schema graph, per-target emission |
| Strategy | `ColumnMapper`, `ReferenceResolver`, `ApiCliIo`, CLI `io` boundaries | Swappable mapping and injectable output without forking the library |
| Visitor / normalizer | Zod → JSON Schema normalization, `$defs` hoisting | Stable OpenAPI output from native Zod conversion |
| Factory function | `createAppClient` in generated clients; `defineApiContract` / `defineMigrationConfig` | Type inference for authors at zero runtime cost |
| Command object | `main(argv, io)` in both CLIs | Testable commands that return an exit code instead of calling `process.exit` |
| Plan → review → apply | `diffSnapshots` → `renderMigrationSql` → `runMigrations` | Human-reviewed SQL, classified safety, fail-closed history |
| Text emission (no AST) | All generators | Small dependency surface, byte-stable output normalized by Prettier |

Invariants the package maintains across every layer:

- **Determinism.** Paths, methods, components, operations, columns, and JSON keys are sorted; snapshots are canonical JSON with LF endings and a final LF.
- **Lineage.** Each generated migration records the previous and resulting snapshot SHA-256, and a torn pair is reported instead of repaired automatically.
- **Ownership boundaries.** Generated files carry a marker and only marker files are pruned; migration files are immutable and never overwritten; only paths created by the current process are rolled back.
- **Optional database driver.** `pg` is imported inside the functions that need it, so imports, generation, and validation work without a driver installed.

---

## Dependencies

Install the umbrella package once; this package is published inside it. Database-backed commands additionally need the optional `pg` peer.

```bash
npm install blendsdk
npm install blendsdk pg
```

| Dependency | Kind | Used for |
| --- | --- | --- |
| `blendsdk/cmdline` | internal | Strict command and option parsing behind `blendsdk migrate` |
| `blendsdk/dbcore` | internal | Shared database primitives |
| `blendsdk/postgresql` | internal | `PostgreSQLDatabase`, the query surface consumed by `PostgreSQLIntrospector` |
| `blendsdk/webafx` | internal | `RouteDefinition` route metadata read by `OpenAPIGenerator` |
| `jiti` | runtime | Loads `blendsdk.migrations.ts` and `blendsdk.api.ts` TypeScript without a build step, with caches disabled |
| `pg` | runtime, optional peer | PostgreSQL connections for introspection, migrations, and baseline adoption; imported lazily |
| `postgres-array` | runtime | Array literal parsing for PostgreSQL values |
| `zod` | runtime | Schema definitions, generated validators, and native `z.toJSONSchema` conversion |
| `prettier` | formatting | Normalizes every generated file and the OpenAPI JSON so output is byte-stable |

| Depends on this package | How |
| --- | --- |
| `packages/blendsdk` (published umbrella) | Re-exports this surface at the `blendsdk/codegen` subpath and routes the `blendsdk` executable (`migrate …`, `api …`) into the CLIs declared here |
| `packages/playground/database-migrations` | Copyable baseline-only example driven entirely by public migration commands |
| Application projects | Consume committed generated types, validators, clients, and reviewed migration SQL |
| `blendsdk/webafx-auth` | Test-only fixture: its OIDC controller routes are used to verify document generation |

Requirements: Node.js >= 22, ESM only (`"type": "module"`, single `.` export subpath), TypeScript 5.x in strict mode, and PostgreSQL 13+ for the database-backed commands.

---

## Minimum Example

One schema produces both the compile-time type and the runtime validator. Nothing here touches a database.

```typescript
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

console.log(types);
console.log(validators);
```

`types` is formatted TypeScript containing `export interface Customer` with `nickname?: string` and the pattern and length contract recorded as JSDoc on `email`. `validators` is the equivalent `export const CustomerSchema = z.object({ … })`, where `email` is constrained with `.regex(...)` and `.max(320)`.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
