> **Package**: `blendsdk/codegen`

# codegen Best Practices

`blendsdk/codegen` derives every artifact — TypeScript types, Zod validators, constant types, OpenAPI v3.1 documents, PostgreSQL bootstrap DDL, and reviewable migrations — from models you author in code. The practices below keep those artifacts trustworthy: author once, review generated output like any other code, and let the pipeline's safety rails do their job.

---

## Do / Don't Pairs

### 1. Author the schema once and generate every artifact from it

**Why:** Two handwritten definitions drift the moment one side changes — the interface below is already missing `email`, and nothing fails until a consumer breaks or production validation rejects a valid payload. A `SchemaContainer` is the single source: types, validators, constant types, and API schemas are all derived from the same model, so they cannot disagree.

**❌ Wrong**

```typescript
// ❌ Wrong — the interface and the validator are two handwritten definitions
// that must be kept in sync by hand. (This interface is already missing `email`.)
import { z } from 'zod';

export interface User {
  id: number;
  name: string;
}

export const userSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string().optional(),
});
```

**✅ Correct**

```typescript
import { SchemaContainer, TypeGenerator, ZodGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

scope
  .object({
    id: scope.number(),
    name: scope.string(),
    email: scope.string().optional(),
  })
  .named('User');

const types = await new TypeGenerator().generate(schema);
const validators = await new ZodGenerator().generate(schema);

console.log(types);
console.log(validators);
```

### 2. Name root objects and reference them with `ref()` — never name a property object

**Why:** Only root schema objects may be named. A named object attached as a property has a parent, and `generate()` rejects the whole document with `Object properties cannot be named explicitly.` Conversely, `ref()` refuses unnamed targets (`Referenced schema is not named!`), so shared shapes must be declared once as named roots and referenced — never duplicated inline. When the same logical name is needed in two contexts, declare it under separate scopes (`schema.scope('api_v1')` and `schema.scope('api_v2')` produce `ApiV1UserRequest` / `ApiV2UserRequest`) instead of inventing prefixed names.

**❌ Wrong**

```typescript
// ❌ Wrong — an object that is used as a property is given an explicit name.
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

scope
  .object({
    address: scope.object({ city: scope.string() }).named('Address'),
  })
  .named('Customer');

// Throws while generating: "Object properties cannot be named explicitly."
await new TypeGenerator().generate(schema);
```

**✅ Correct**

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

const address = scope
  .object({
    city: scope.string(),
  })
  .named('Address');

scope
  .object({
    address: scope.ref(address),
  })
  .named('Customer');

const types = await new TypeGenerator().generate(schema);
console.log(types);
```

### 3. Choose `.optional()` and `.nullable()` deliberately

**Why:** They are not interchangeable. `.optional()` changes whether a property may be absent (`email?: string`, Zod `.optional()`); `.nullable()` changes the value domain (`string | null`, Zod `.nullable()`). Modeling an optional field as nullable forces every caller to pass an explicit `null`; modeling a database-nullable column as optional hides the null case from the type. Use both where both apply — `.nullable().optional()` is exactly what introspection applies to nullable columns. For PATCH-style update payloads, reference the full type with `.partial()` instead of declaring a second all-optional object.

**❌ Wrong**

```typescript fragment
// ❌ Wrong — an optional field modeled as nullable
scope.object({ email: scope.string().nullable() }).named('User');
// Generated: email: string | null;
// Callers must now send an explicit null for a field they should simply omit.
```

**✅ Correct**

```typescript fragment
// ✅ Correct — an optional field modeled as optional
scope.object({ email: scope.string().optional() }).named('User');
// Generated: email?: string;
```

### 4. Map unmapped PostgreSQL types with a `ColumnMapper`

**Why:** The built-in PostgreSQL → TypeScript mapping covers common types only; `json`, `jsonb`, `bytea`, `interval`, and range/geometric types have no default mapping. Without a `ColumnMapper`, each such column becomes a deprecated `any` property reported only as a `console.log` warning — the generated types compile but give up all checking. The mapper runs before the built-in switch, so return `undefined` for anything the defaults should handle.

**❌ Wrong**

```typescript fragment
// ❌ Wrong — no mapper. Every column type the built-in switch does not know
// (jsonb, bytea, interval, ranges, ...) becomes a deprecated `any` property,
// signalled only by a console warning that is easy to miss.
const introspector = new PostgreSQLIntrospector(db);
await introspector.introspect(schema);
```

**✅ Correct**

```typescript
import { PostgreSQLIntrospector, SchemaContainer } from 'blendsdk/codegen';
import type { ColumnMapper } from 'blendsdk/codegen';
import type { PostgreSQLDatabase } from 'blendsdk/postgresql';

const mapUnsupported: ColumnMapper = (record, scope) => {
  if (record.pg_type === 'jsonb' || record.pg_type === 'json') {
    return scope.any().description('JSON payload — refine this property by hand');
  }
  return undefined; // fall through to the built-in PostgreSQL → TypeScript mapping
};

async function readTypes(db: PostgreSQLDatabase) {
  const schema = new SchemaContainer();
  await new PostgreSQLIntrospector(db).introspect(schema, mapUnsupported);
  return schema;
}
```

When the shape is known, return a typed object from the mapper instead of `any` — either inline (`scope.object({ x: scope.number(), y: scope.number() })`) or as a `ref()` to a named root.

### 5. Use bootstrap DDL for fresh databases and migrations for databases with data

**Why:** `PostgreSQLSchemaGenerator.generate()` renders complete bootstrap DDL from the desired-state model, and with default options it starts with `DROP SCHEMA ... CASCADE` / `DROP TABLE ... CASCADE` — it is built to provision a fresh database, not to evolve a populated one. Applying that output to a live database destroys data and leaves nothing to review. Databases with data evolve through generated, reviewable, committed migrations.

**❌ Wrong**

```typescript fragment
// ❌ Wrong — treating bootstrap DDL as an application migration.
// With the default options, generate() includes CASCADE drops before the
// CREATE statements; running it against a populated database destroys data.
const ddl = new PostgreSQLSchemaGenerator(schema).generate();
```

**✅ Correct**

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

// Bootstrapping a fresh database (ephemeral CI database, new install):
const schema = new DatabaseSchema('app');
const customer = schema.table('customer');
customer.bigint('id').primaryKey();
customer.text('name').nullable();

const bootstrapDdl = new PostgreSQLSchemaGenerator(schema).generate();
console.log(bootstrapDdl);
```

And for a database that already holds data — the same model, applied through the migration pipeline:

```typescript fragment
import { generateMigration, runMigrations } from 'blendsdk/codegen';

const configPath = './blendsdk.migrations.ts';

// Offline: writes the next migration file and the replacement snapshot.
await generateMigration({ name: 'add-customer-status', configPath });

// Checked apply: verifies checksums and the applied prefix, then executes.
await runMigrations({ command: 'up', configPath });
```

A brand-new project starts the lineage with `generateBaseline({ name: 'initial' })` (or `blendsdk migrate baseline initial`) before the first `generateMigration`.

### 6. Keep migration history append-only

**Why:** A migration file's identity is its exact bytes: the runner stores a SHA-256 checksum in the ledger and requires applied rows to be a checksum-verified, ordered prefix of local history. Editing an applied file fails closed — `validate`, `status`, and `up` all report `INVALID_HISTORY` before any SQL executes, and the database stays untouched until an operator reconciles the difference. Snapshots are the same: canonical, hash-referenced bytes — regenerate them, never hand-edit.

**❌ Wrong**

```sql
-- ❌ Wrong — an applied migration is edited in place to "fix" it.
-- The file's bytes are its identity; the ledger stores a checksum of
-- exactly these bytes.
-- migrations/20260827120000_add-customer-status.up.sql
ALTER TABLE "public"."customer" ADD COLUMN "status" text NOT NULL;
```

**✅ Correct**

```sql
-- ✅ Correct — ship a new migration; history stays append-only.
-- migrations/20260828090000_backfill-customer-status.up.sql
UPDATE "public"."customer" SET "status" = 'active' WHERE "status" IS NULL;
ALTER TABLE "public"."customer" ALTER COLUMN "status" SET NOT NULL;
```

For modeled changes run `generateMigration` (`blendsdk migrate generate <name>`); for data-only work create a manual migration with `blendsdk migrate create <name>` — manual migrations carry `from-snapshot: none` lineage and coexist with generated ones.

### 7. Preview with `dryRun`, then branch on typed results and errors

**Why:** The runner reports through data, not prose: `MigrationCommandResult.status` (`UP_TO_DATE`, `PENDING`, `INVALID_HISTORY`, `LOCKED`, `UNKNOWN_OUTCOME`) and typed `MigrationError.kind` values. Swallowing or string-matching errors collapses states that need different responses — `LOCKED` means retry later, `INVALID_HISTORY` means stop and inspect, `UNKNOWN_OUTCOME` demands manual recovery. A dry-run preview executes no SQL and does not create the ledger, so it is always safe to run first.

**❌ Wrong**

```typescript fragment
// ❌ Wrong — fire-and-forget. Errors are swallowed, so a LOCKED result,
// an INVALID_HISTORY state, and success are indistinguishable.
await runMigrations({ command: 'up', configPath }).catch(() => {});
```

**✅ Correct**

```typescript
import { MigrationError, formatMigrationError, runMigrations } from 'blendsdk/codegen';

const configPath = './blendsdk.migrations.ts';

// Preview first: dryRun executes no SQL and does not create or modify the ledger.
const preview = await runMigrations({ command: 'up', configPath, dryRun: true });
console.log(`${preview.status}: ${preview.migrations.length} pending migration(s)`);

if (preview.status === 'PENDING') {
  try {
    await runMigrations({ command: 'up', configPath });
  } catch (error) {
    if (error instanceof MigrationError) {
      // formatMigrationError renders a stable classification and never
      // includes credentials or SQL bodies.
      console.error(formatMigrationError(error));
      process.exitCode = error.exitCode;
    } else {
      throw error;
    }
  }
}
```

Reserve `down` for development: it reverts exactly the latest migration, requires explicit confirmation (`allowDown: true`), and is never the production rollback path — in production, recover forward with a new reviewed migration.

### 8. Opt routes into the OpenAPI document deliberately

**Why:** Publication is opt-in per route: a route appears in the document only when it carries `.openapi()` metadata (even an empty object counts). A forgotten annotation means a served endpoint is silently absent from the published contract, while intentionally private routes stay excluded simply by not being annotated. The metadata you attach is the contract — stable `operationId`s, summaries, tags, and response descriptions — and validation schemas drive it too: POST/PUT/PATCH schemas become request bodies, GET/DELETE schemas become query parameters, and secure routes pick up `defaultSecurity`.

**❌ Wrong**

```typescript fragment
// ❌ Wrong — a public endpoint that never opts in. Routes without
// `.openapi()` metadata are excluded, so the published contract silently
// lacks an endpoint the API actually serves.
routes() {
  return [
    { method: 'get', path: '/products', handler: this.listProducts },
  ];
}
```

**✅ Correct**

```typescript fragment
import { z } from 'zod';

// GET/DELETE routes document their validation schema as query parameters.
const listProductsQuery = z.object({
  page: z.coerce.number().default(1),
  search: z.string().optional(),
});
```

```typescript fragment
// The same controller route, now opted in with reviewed metadata.
routes() {
  return [
    {
      method: 'get',
      path: '/products',
      handler: this.listProducts,
      validation: listProductsQuery,
      openapi: {
        summary: 'List products',
        operationId: 'listProducts',
        tags: ['products'],
        responses: [{ statusCode: 200, description: 'Paginated product list' }],
      },
    },
  ];
}
```

---

## Anti-Patterns

1. **Patching generated output.** Editing emitted TypeScript, validators, or constant types that the next `generate()` overwrites. Fix the model instead — `.description()`, `.nullable()`, a `ref()`, or a `ColumnMapper` — and regenerate. Files under `dist/` are build output, never edit sources of truth there.
2. **Using `down` as the production rollback strategy.** `down` exists for development, reverts exactly the latest migration, and requires explicit confirmation. Reverting a released migration can lose data that later migrations assume still exists; recover forward with a new, reviewed migration.
3. **Forcing a baseline adoption.** `adoptBaseline` records initial lineage only after a structural comparison proves the database matches the generated baseline and the operator confirms the exact target token. Editing the snapshot — or the database — to make the comparison pass bypasses the check that protects real data. Resolve the reported `MISSING` / `DIFFERENT` / `EXTRA_MODELED` / `UNSUPPORTED_FOR_ADOPTION` items and retry.
4. **Expecting read-only commands to mutate state.** `status`, `validate`, and dry-run previews execute no SQL and never create the ledger; an absent ledger is treated as empty. Only `up`, `down`, baseline generation, and adoption change anything.
5. **Passing non-Zod values where Zod schemas are expected.** Route `validation`, `pathParams[].schema`, and response schemas must be real Zod v4 schemas — `convertZodToJsonSchema()` falls back to a generic `{ type: 'object' }` for anything else, while `convertZodToQueryParameters()` returns an empty array. The published contract silently loses detail instead of failing loudly.
6. **Expecting the model to manage every database object.** Grants, row-level security policies, triggers, and functions are not part of the model. Comparison reports them as `UNMANAGED` and preserves them, but desired state that depends on unmanaged objects — or state the model cannot express on modeled tables, such as row-level security — blocks adoption. Track those objects in manual migrations or provisioning steps.

---

## Performance Tips

1. **Generate during builds, never at request time.** Every `generate()` call walks all schema objects and runs the complete output through Prettier. Paying that cost at process start or per request burns CPU for output that only changes when the model changes.
2. **Run each generator once per build.** A container can feed many generators, but a second `generate()` call re-renders and re-formats the entire document. Generate once and reuse the returned string for every destination (file, stdout, bundler input).
3. **Introspect once per database.** `PostgreSQLIntrospector.introspect()` reads tables, views, enums, composites, and domains in a single catalog query, and `introstectConstantTypes()` is one additional whole-catalog scan. Both are all-or-nothing operations — call them once and reuse the results instead of looping per relation.
4. **Validate migration history offline.** `runMigrations({ command: 'validate', configPath })` performs all local checks — file contracts, identifiers, ordering, lineage — with no `DATABASE_URL` required (`blendsdk migrate validate --offline` does the same from the CLI). Run it on every change instead of provisioning a database just to lint migration history.
5. **Prefer read-only operations for preflight.** `status` and dry-run previews never write: they do not execute migration SQL and do not create the ledger. The same principle applies to generation — when the model already matches the snapshot, `generateMigration` reports `UP_TO_DATE` and writes nothing, so it is cheap to run often.
6. **Use `.concurrent()` for indexes on large, busy tables.** A plain `CREATE INDEX` blocks writes for the duration of the build; authoring the index with `.concurrent()` requests `CREATE INDEX CONCURRENTLY` in emitted DDL, and catalog comparison treats concurrency as a creation-time property (it is not re-diffed after creation). PostgreSQL does not allow concurrent builds inside explicit transactions, so verify the generated migration's `transaction:` header before applying to a busy production table.

---

## Security Considerations

1. **Keep the database URL out of configuration and artifacts.** The config file names the environment variable (`databaseUrlEnv`), never the URL itself, and canonical snapshots are data-only JSON — no timestamps, no connection strings — so committing them is safe.

   ```typescript
   import { defineMigrationConfig } from 'blendsdk/codegen';

   export default defineMigrationConfig({
     schema: './schema.ts',
     migrationsDir: './migrations',
     databaseUrlEnv: 'DATABASE_URL',
   });
   ```

2. **Keep logs inside the redaction boundary.** `MigrationError` strips database URLs and credential assignments at construction, and `formatMigrationError` prints a stable classification without credentials or SQL bodies. Any detail passed via `sensitiveDetail` is retained on the error but omitted from formatted output.

   ```typescript
   import { MigrationError, formatMigrationError } from 'blendsdk/codegen';

   const failure = new MigrationError({
     kind: 'CONFIGURATION',
     exitCode: 2,
     message: 'Cannot reach postgres://admin:super-secret@db.example/app',
     sensitiveDetail: 'ALTER TABLE "customer" ADD COLUMN "password" text;',
   });

   console.log(formatMigrationError(failure));
   // Prints a CONFIGURATION line with the URL redacted and no SQL body.
   ```

3. **Treat raw-SQL model fields as reviewed code.** `checkConstraint(rule)`, `index().where(condition)`, `index().expression(expr)`, `view.as(source)`, and column defaults are copied verbatim into generated artifacts — they are not parameterized or validated, so never build them from untrusted input. `default(value, true)` applies naive single-quoting with no escaping; use it only for literal, quote-free constants and pass an explicit SQL string for anything else.
4. **Declare OpenAPI security honestly.** `secure: true` only copies `defaultSecurity` into an operation's `security` field — enforcement belongs to webafx middleware. Configure `securitySchemes`, `defaultSecurity`, and the actual middleware together so the published contract states real requirements.

   ```typescript
   import { OpenAPIGenerator } from 'blendsdk/codegen';

   const generator = new OpenAPIGenerator({
     title: 'Catalog API',
     version: '1.0.0',
     servers: [{ url: 'https://api.example.com', description: 'Production' }],
     securitySchemes: {
       bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
     },
     defaultSecurity: [{ bearerAuth: [] }],
   });

   generator.toFile('./dist/openapi.json');
   ```

5. **Do not script around the adoption confirmation gate.** `adoptBaseline` shows a sanitized target preview (host, port, user, database — never the password), then performs the authoritative comparison inside the advisory lock before inserting any ledger rows. The confirmation token is exact (`<database>/<baseline-id>`) so a copied command cannot adopt the wrong database; on failure, fix the reported differences instead of editing around the check.
6. **Bound execution.** Keep `lockTimeoutMs` and `statementTimeoutMs` finite — defaults are 5,000 ms (lock wait ends with `LOCKED` instead of hanging) and 900,000 ms. Long-running commands accept an `AbortSignal`: a cancelled run rolls back what is in flight and releases the lock, while already-completed migrations stay recorded.
7. **Keep artifact paths inside the project.** The configuration loader rejects `migrationsDir` / `snapshotFile` values that escape the config directory (`../`), point at filesystem roots, or resolve through symlinks; the publisher also refuses symlinked snapshot targets and never overwrites an existing migration. Do not work around these checks — keep `migrations/` a real directory inside the repository.

---

# codegen Testing Patterns

This guide explains how to test code that uses `blendsdk/codegen`: schema authoring and the code generators, the PostgreSQL relational model and initializer DDL, OpenAPI document generation, and the snapshot-driven migration lifecycle. The patterns mirror the package's own suite under `tests/` — pure generators are asserted directly, while database-backed behavior runs against a disposable PostgreSQL instance created per test.

---

## Test Setup

### Test Framework

The package's suite runs on Vitest with ESM and strict TypeScript. `vitest` runs, but *does not typecheck* — the package typechecks through its `tsc` build and through compile-only `*.compile-spec.ts` files.

| Script | Command | Purpose |
| --- | --- | --- |
| `test:fast` | `vitest run --reporter=verbose --no-file-parallelism --testTimeout=30000` | Single run, verbose, serial files |
| `test:watch` | `vitest watch --reporter=verbose` | Local iteration |
| `test:coverage` | `vitest run --coverage` | Coverage via `@vitest/coverage-v8` |
| `db:up` / `db:down` / `db:logs` | `docker-compose -p codegen -f ./docker/docker-compose${MODE}.yml ...` | Disposable PostgreSQL (`postgres-test`) |
| `test` | `yarn db:down && yarn db:up && yarn test:fast && yarn db:down` | Full reset cycle |

Two flags matter:

- `--no-file-parallelism` — the database-backed suites share one PostgreSQL server and assert advisory-lock timing; serial file execution keeps lock windows deterministic. Within a file, the same suites use `describe.sequential`.
- `--testTimeout=30000` — lock waits, statement timeouts, and abort windows need generous per-test budgets.

`db:up` starts the compose service from `./docker/docker-compose${MODE}.yml` (the `MODE` environment variable selects the file) and waits 5 seconds for readiness. `db:down` removes the volume (`-v --remove-orphans`), so every reset starts from a clean cluster.

### What Requires a Database

| Area under test | PostgreSQL (`yarn db:up`) required |
| --- | --- |
| `SchemaContainer`, `TypeGenerator`, `ZodGenerator`, `CTypeGenerator` | No |
| `convertZodToJsonSchema`, `convertZodToQueryParameters`, `OpenAPIGenerator` | No |
| `DatabaseSchema`, `TableSchema`, `TableColumnSchema`, `IndexConstraint`, `PostgreSQLSchemaGenerator` | No |
| `generateBaseline`, `generateMigration`, and `runMigrations({ command: 'validate' })` with no configured database URL | No — these are offline by design |
| `PostgreSQLIntrospector` | Yes |
| `runMigrations` (`up`, `down`, `status`) and `adoptBaseline` | Yes |

Tests that need PostgreSQL connect to the admin URL of the disposable instance:

```text
postgresql://postgres:postgres@127.0.0.1:5597/postgres
```

### Test File Conventions

The package's suite distinguishes test intent by filename suffix. Helper files are named so Vitest's include pattern never collects them.

| Suffix | Role | Collected by Vitest |
| --- | --- | --- |
| `*.test.ts` (including `*.spec.test.ts`) | Behavior and contract tests — often database-backed | Yes |
| `*.impl.test.ts` | White-box implementation tests for internal units | Yes |
| `*.integration.test.ts` | Packed-artifact and cross-process tests | Yes |
| `*.test-support.ts` | Shared fixtures and helpers | No |
| `*.compile-spec.ts` | Compile-time public API surface checks (run through `tsc`) | No |

### Importing the Package

Tests import the package root only — never a `src/` or `dist/` path. In the assembled distribution the same API is available under the `blendsdk/codegen` entry point.

```typescript
import { afterEach, describe, expect, test } from 'vitest';
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';
```

Symbols most used by tests:

| Group | Symbols |
| --- | --- |
| Data shapes | `SchemaContainer`, `TypeGenerator`, `ZodGenerator`, `CTypeGenerator` |
| OpenAPI | `OpenAPIGenerator`, `convertZodToJsonSchema`, `convertZodToQueryParameters`, `ControllerConstructor` + the `OpenAPI*` document types |
| Relational model | `DatabaseSchema`, `TableSchema`, `TableColumnSchema`, `IndexConstraint` (+ `IndexMethod`), `PostgreSQLSchemaGenerator`, `PostgreSQLIntrospector`, `ColumnMapper`, `ColumnIntrospection` |
| Migrations | `MigrationError`, `formatMigrationError`, `defineMigrationConfig`, `generateBaseline`, `generateMigration`, `runMigrations`, `getMigrationStatus`, `validateMigrations`, `adoptBaseline` |
| Migration types | `MigrationCommand`, `MigrationCommandResult`, `MigrationConfig`, `ResolvedMigrationConfig`, `RunMigrationsOptions`, `MigrationDescriptor`, `MigrationStatus`, `MigrationSafety`, `MigrationErrorKind`, `MigrationExitCode` |

### Vitest Configuration

The package configures Vitest from its scripts. The equivalent configuration is:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
```

The include pattern deliberately skips `*.test-support.ts` and `*.compile-spec.ts` files.

### Shared Test Helpers

Put generic helpers in one support module. This module provides temporary directories, deterministic cleanup, and the typed migration-error assertion used throughout this document.

```typescript
// tests/test-support.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { MigrationError } from 'blendsdk/codegen';
import type { MigrationErrorKind } from 'blendsdk/codegen';

const temporaryDirectories: string[] = [];

/** Creates one isolated directory and registers deterministic cleanup. */
export async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'blendsdk-codegen-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** Removes every directory created through temporaryDirectory(). */
export async function cleanupTemporaryDirectories(): Promise<void> {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
}

/** Captures one typed migration failure without depending on message prose. */
export async function expectMigrationError(
  action: () => unknown | Promise<unknown>,
  expected: { readonly kind: MigrationErrorKind; readonly exitCode: 1 | 2 }
): Promise<MigrationError> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof MigrationError)) throw error;
    expect(error.kind).toBe(expected.kind);
    expect(error.exitCode).toBe(expected.exitCode);
    return error;
  }
  throw new Error('Expected a typed migration error.');
}
```

Wire the cleanup into each test file:

```typescript
import { afterEach } from 'vitest';
import { cleanupTemporaryDirectories } from './test-support.js';

afterEach(cleanupTemporaryDirectories);
```

Assert failures through `kind` and `exitCode` (or `formatMigrationError(error)` for rendered output) — never through message prose, because messages intentionally redact credentials and SQL.

---

## Unit Testing

Everything that is a pure function of a model — schema authoring, every generator, and offline migration validation — is unit tested in memory, with no database and no filesystem beyond temporary project directories.

### Schema Models and Generators

Create a fresh `SchemaContainer` per test, build the smallest model that exercises the behavior, and assert on generated source with stable substrings. Generator output is formatted with Prettier before it is returned, so the formatted snippets below are stable.

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

describe('TypeGenerator', () => {
  let schema: SchemaContainer;
  let typeGenerator: TypeGenerator;

  beforeEach(() => {
    schema = new SchemaContainer();
    typeGenerator = new TypeGenerator();
  });

  afterEach(() => {
    schema.clear();
  });

  test('renders string enums as literal unions and keeps references arrayed', async () => {
    const scope = schema.scope();
    const directions = scope.string().named('directions').enum(['up', 'down']);
    scope.object({ dir: scope.ref(directions).arrayed() }).named('object1');

    const source = await typeGenerator.generate(schema);

    expect(source).toContain('export type Directions = "up" | "down";');
    expect(source).toContain('dir: Directions[];');
  });

  test('applies nullable and partial modifiers', async () => {
    const scope = schema.scope();
    scope.string().named('string3').nullable();
    scope.object({ prop: scope.string() }).named('object2').partial();

    const source = await typeGenerator.generate(schema);

    expect(source).toContain('export type String3 = string | null;');
    expect(source).toContain('export type Object2 = Partial<{');
  });
});
```

### Zod → OpenAPI Conversion

`convertZodToJsonSchema` and `convertZodToQueryParameters` are synchronous and return plain JSON Schema objects — assert them with `toEqual` rather than string matching.

```typescript
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { convertZodToJsonSchema, convertZodToQueryParameters } from 'blendsdk/codegen';

describe('Zod → OpenAPI conversion', () => {
  test('maps constraints, formats, and optionality into JSON Schema', () => {
    const schema = z.object({
      name: z.string().min(1),
      email: z.string().email(),
      age: z.number().int().optional(),
      role: z.enum(['admin', 'user']).default('user'),
      tags: z.array(z.string()),
    });

    const result = convertZodToJsonSchema(schema, 'input');

    expect(result.properties!.name).toEqual({ type: 'string', minLength: 1 });
    expect(result.properties!.email).toEqual({ type: 'string', format: 'email' });
    expect(result.properties!.age).toEqual({ type: 'integer' });
    expect(result.properties!.role).toEqual({
      type: 'string',
      enum: ['admin', 'user'],
      default: 'user',
    });
    expect(result.properties!.tags).toEqual({ type: 'array', items: { type: 'string' } });
    expect(result.required).toEqual(['name', 'email', 'tags']);
  });

  test('documents transformed schemas by their input type', () => {
    const tags = z.string().transform(value => value.split(','));

    expect(convertZodToJsonSchema(tags, 'input')).toEqual({ type: 'string' });
  });

  test('turns object properties into query parameters', () => {
    const parameters = convertZodToQueryParameters(
      z.object({
        page: z.coerce.number().default(1),
        search: z.string().optional(),
      })
    );

    expect(parameters).toContainEqual({
      name: 'page',
      in: 'query',
      schema: { type: 'number', default: 1 },
    });
    expect(parameters).toContainEqual({
      name: 'search',
      in: 'query',
      schema: { type: 'string' },
    });
  });
});
```

### OpenAPI Document Assembly

`OpenAPIGenerator` is synchronous, never performs I/O until `toFile()` is called, and filters routes by the presence of `.openapi()` metadata. Test routes are built from a small factory that fills the required fields and casts to `RouteDefinition`.

```typescript
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { RouteDefinition } from 'blendsdk/webafx';
import { OpenAPIGenerator } from 'blendsdk/codegen';

/** Builds a route-shaped test double; only the fields under test need real values. */
function route(overrides: Partial<RouteDefinition>): RouteDefinition {
  return { method: 'get', path: '/', handler: () => {}, ...overrides } as RouteDefinition;
}

describe('OpenAPI document assembly', () => {
  test('converts Express-style paths and collects only opt-in routes', () => {
    const generator = new OpenAPIGenerator({ title: 'Test API', version: '1.0.0' });
    generator.addRoutes('/api/products', [
      route({ method: 'get', path: '/:id', openapi: { summary: 'Get product' } }),
      route({ method: 'get', path: '/internal' }),
    ]);

    const document = generator.generate();

    expect(document.paths).toHaveProperty('/api/products/{id}');
    expect(document.paths).not.toHaveProperty('/api/products/internal');
    expect(document.paths['/api/products/{id}'].get!.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  });

  test('builds request bodies and query parameters from validation schemas', () => {
    const generator = new OpenAPIGenerator({ title: 'Test API', version: '1.0.0' });
    generator.addRoutes('/api/products', [
      route({
        method: 'post',
        path: '/',
        validation: z.object({ name: z.string().min(1), price: z.number() }),
        openapi: { summary: 'Create product' },
      }),
      route({
        method: 'get',
        path: '/',
        validation: z.object({ page: z.coerce.number().default(1) }),
        openapi: { summary: 'List products' },
      }),
    ]);

    const document = generator.generate();
    const operation = document.paths['/api/products'];

    expect(operation.post!.requestBody).toEqual({
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { name: { type: 'string', minLength: 1 }, price: { type: 'number' } },
            required: ['name', 'price'],
          },
        },
      },
    });
    expect(operation.get!.parameters).toEqual([
      { name: 'page', in: 'query', schema: { type: 'number', default: 1 } },
    ]);
    expect(operation.get!.requestBody).toBeUndefined();
  });
});
```

### Relational Model Authoring

`DatabaseSchema` authoring is synchronous. Assert both the recorded state (types, defaults, constraints, extensions) and the validation errors the fluent API throws.

```typescript
import { describe, expect, test } from 'vitest';
import { DatabaseSchema } from 'blendsdk/codegen';

describe('DatabaseSchema authoring', () => {
  test('records a primary-key column as non-nullable', () => {
    const schema = new DatabaseSchema('app');
    const table = schema.table('customer');
    const id = table.bigint('id').primaryKey();

    expect(id.getType()).toBe('bigint');
    expect(id.getNullable()).toBe(false);
    expect(table.getPrimaryKey()?.getColumns().map(column => column.getName())).toEqual(['id']);
  });

  test('uuid identity selects the extension that provides the generator', () => {
    const schema = new DatabaseSchema('app');
    const table = schema.table('device');
    table.uuid('id').identity('v7');

    expect(schema.getExtensions()).toContain('pg_uuidv7');
    expect(table.findColumn('id')?.getDefault()).toBe('uuid_generate_v7()');
  });

  test('rejects identity on non-integer, non-uuid columns', () => {
    const schema = new DatabaseSchema('app');
    const table = schema.table('customer');

    expect(() => table.text('label').identity()).toThrow(/integer or uuid/);
  });
});
```

### Initializer DDL

`PostgreSQLSchemaGenerator` renders complete bootstrap DDL for fresh databases. Pass `dropBeforeCreate: false` when asserting bootstrap output so drop statements are excluded.

```typescript
import { describe, expect, test } from 'vitest';
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

describe('PostgreSQLSchemaGenerator', () => {
  test('renders deterministic bootstrap DDL without drop statements', () => {
    const schema = new DatabaseSchema('app');
    const table = schema.table('customer');
    table.bigint('id').primaryKey();
    table.varchar('email', 255).nullable();

    const generator = new PostgreSQLSchemaGenerator(schema);
    const ddl = generator.generate({ dropBeforeCreate: false });

    expect(ddl).toContain('CREATE TABLE public.customer');
    expect(ddl).toContain('PRIMARY KEY');
    expect(ddl).not.toContain('DROP TABLE');
    expect(generator.generate({ dropBeforeCreate: false })).toBe(ddl);

    const grouped = generator.generateGrouped({ dropBeforeCreate: false });
    expect(grouped.all).toBe(ddl);
  });
});
```

### Offline Migration Validation

`runMigrations({ command: 'validate' })` validates local history without a database connection when the configured URL environment variable is unset. Valid history returns `UP_TO_DATE`; byte-level damage returns `INVALID_HISTORY` instead of throwing.

```typescript
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { runMigrations } from 'blendsdk/codegen';
import { cleanupTemporaryDirectories, temporaryDirectory } from './test-support.js';

afterEach(cleanupTemporaryDirectories);

describe('offline migration validation', () => {
  test('validates local history and rejects edited bytes without a database', async () => {
    const projectDirectory = await temporaryDirectory();
    const migrationsDir = join(projectDirectory, 'migrations');
    await mkdir(migrationsDir);
    const id = '20260827120100_offline';
    const migrationPath = join(migrationsDir, `${id}.up.sql`);
    await writeFile(
      migrationPath,
      [
        '-- blendsdk-migration: 1',
        `-- id: ${id}`,
        '-- transaction: true',
        '-- from-snapshot: none',
        '-- to-snapshot: none',
        'SELECT 1;',
        '',
      ].join('\n'),
      'utf8'
    );
    const configPath = join(projectDirectory, 'blendsdk.migrations.ts');
    await writeFile(
      configPath,
      "export default { databaseUrlEnv: 'BLENDSDK_OFFLINE_TEST_URL' };\n",
      'utf8'
    );
    delete process.env.BLENDSDK_OFFLINE_TEST_URL;

    const valid = await runMigrations({ command: 'validate', configPath });
    expect(valid.status).toBe('UP_TO_DATE');

    const bytes = await readFile(migrationPath, 'utf8');
    await writeFile(migrationPath, bytes.trimEnd(), 'utf8');

    const invalid = await runMigrations({ command: 'validate', configPath });
    expect(invalid).toEqual({ status: 'INVALID_HISTORY', migrations: [] });
  });
});
```

---

## Integration Testing

Migration `up`/`down`/`status`, baseline adoption, and catalog introspection require a real PostgreSQL instance. The suite strategy is: one disposable database per test, one temporary migration project per test, deterministic teardown.

### PostgreSQL Test Support Module

This module is the reusable core of the package's database-backed suites. It creates an isolated database via an administrative pool, writes a strict migration configuration, tracks environment variables and temporary paths, and cleans everything up after each test.

Projects that carry a fixture schema module are created *inside the repository* so the fixture's `blendsdk/codegen` import resolves through `node_modules`; database-only projects use the OS temporary directory. Add the generated directory pattern (`tmp-schema-project-*`) to `.gitignore`.

```typescript
// tests/migrations/runner.test-support.ts
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect } from 'vitest';
import { MigrationError } from 'blendsdk/codegen';
import type { MigrationDescriptor, MigrationErrorKind } from 'blendsdk/codegen';

/** Fixed qualified name of the runner-owned ledger. */
export const ledgerName = 'public.blendsdk_migrations';

/** Disposable PostgreSQL instance started by `yarn db:up`. */
const adminUrl = 'postgresql://postgres:postgres@127.0.0.1:5597/postgres';

const temporaryDirectories: string[] = [];
const databaseNames: string[] = [];
const databaseUrlEnvironments: string[] = [];
let adminPool: Pool | undefined;

/** Isolated database and migration project owned by one test. */
export interface TestProject {
  readonly databaseUrl: string;
  readonly databaseUrlEnvironment: string;
  readonly configPath: string;
  readonly migrationsDir: string;
  readonly pool: Pool;
}

/** Options for one isolated migration project. */
export interface TestProjectOptions {
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  /** When provided, a `schema.ts` fixture and its config entry are written. */
  readonly schemaBody?: string;
}

/** Optional metadata and down body used to write a migration fixture. */
export interface MigrationFixtureOptions {
  readonly transactional?: boolean;
  readonly fromSnapshot?: string;
  readonly toSnapshot?: string;
  readonly downBody?: string;
}

/** Opens the administrative pool used only for owned test-database lifecycle. */
export function setupRunnerTests(): void {
  adminPool = new Pool({ connectionString: adminUrl, max: 2 });
}

/**
 * Creates one isolated PostgreSQL database and one local migration project.
 *
 * Schema-bearing projects live inside the repository so the fixture module's
 * `blendsdk/codegen` import resolves through `node_modules`.
 */
export async function createProject(options: TestProjectOptions = {}): Promise<TestProject> {
  if (!adminPool) throw new Error('Runner test support has not been initialized.');
  const databaseName = `blend_runner_${randomUUID().replaceAll('-', '')}`;
  const databaseUrlEnvironment = `BLENDSDK_RUNNER_${databaseName.toUpperCase()}_URL`;
  await adminPool.query(`CREATE DATABASE "${databaseName}"`);
  databaseNames.push(databaseName);

  const projectDirectory = options.schemaBody
    ? await mkdtemp(join(import.meta.dirname, 'tmp-schema-project-'))
    : await mkdtemp(join(tmpdir(), 'blendsdk-runner-'));
  temporaryDirectories.push(projectDirectory);
  const migrationsDir = join(projectDirectory, 'migrations');
  await mkdir(migrationsDir);
  if (options.schemaBody) {
    await writeFile(
      join(projectDirectory, 'schema.ts'),
      `import { DatabaseSchema } from 'blendsdk/codegen';\n${options.schemaBody}\n`,
      'utf8'
    );
  }
  const configPath = join(projectDirectory, 'blendsdk.migrations.ts');
  await writeFile(
    configPath,
    `export default ${JSON.stringify({
      databaseUrlEnv: databaseUrlEnvironment,
      lockTimeoutMs: options.lockTimeoutMs ?? 500,
      statementTimeoutMs: options.statementTimeoutMs ?? 30_000,
      ...(options.schemaBody ? { schema: './schema.ts' } : {}),
    })};\n`,
    'utf8'
  );
  const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:5597/${databaseName}`;
  process.env[databaseUrlEnvironment] = databaseUrl;
  databaseUrlEnvironments.push(databaseUrlEnvironment);
  return {
    databaseUrl,
    databaseUrlEnvironment,
    configPath,
    migrationsDir,
    pool: new Pool({ connectionString: databaseUrl, max: 4 }),
  };
}

/** Renders and writes one valid immutable migration file pair. */
export async function writeMigration(
  project: TestProject,
  id: string,
  body: string,
  options: MigrationFixtureOptions = {}
): Promise<MigrationDescriptor> {
  const upPath = join(project.migrationsDir, `${id}.up.sql`);
  const upBytes = Buffer.from(
    migrationSql(id, body, {
      transactional: options.transactional,
      fromSnapshot: options.fromSnapshot,
      toSnapshot: options.toSnapshot,
    })
  );
  await writeFile(upPath, upBytes);
  if (options.downBody) {
    await writeFile(
      join(project.migrationsDir, `${id}.down.sql`),
      migrationSql(id, options.downBody, {
        transactional: options.transactional,
        fromSnapshot: options.toSnapshot,
        toSnapshot: options.fromSnapshot,
      })
    );
  }
  return {
    id,
    upPath,
    checksum: createHash('sha256').update(upBytes).digest('hex'),
    transactional: options.transactional ?? true,
    fromSnapshot: options.fromSnapshot,
    toSnapshot: options.toSnapshot,
  };
}

/** Produces exact version-one SQL bytes with nullable snapshot lineage. */
function migrationSql(
  id: string,
  body: string,
  options: {
    readonly transactional?: boolean;
    readonly fromSnapshot?: string;
    readonly toSnapshot?: string;
  }
): string {
  return [
    '-- blendsdk-migration: 1',
    `-- id: ${id}`,
    `-- transaction: ${options.transactional ?? true}`,
    `-- from-snapshot: ${options.fromSnapshot ?? 'none'}`,
    `-- to-snapshot: ${options.toSnapshot ?? 'none'}`,
    body.trimEnd(),
    '',
  ].join('\n');
}

/** Creates the fixed ledger shape for deliberately constructed history states. */
export async function createLedger(project: TestProject): Promise<void> {
  await project.pool.query(`
    CREATE TABLE public.blendsdk_migrations (
      id text PRIMARY KEY,
      checksum char(64) NOT NULL,
      from_snapshot char(64),
      to_snapshot char(64),
      state text NOT NULL CHECK (state IN ('APPLIED', 'NONTRANSACTIONAL_DIRTY')),
      applied_at timestamptz,
      execution_ms bigint CHECK (execution_ms >= 0),
      CHECK (
        (state = 'APPLIED' AND applied_at IS NOT NULL AND execution_ms IS NOT NULL) OR
        (state = 'NONTRANSACTIONAL_DIRTY' AND applied_at IS NULL AND execution_ms IS NULL)
      )
    )
  `);
}

/** Inserts an exact applied or dirty ledger row without invoking migration SQL. */
export async function insertLedgerRow(
  project: TestProject,
  migration: MigrationDescriptor,
  state: 'APPLIED' | 'NONTRANSACTIONAL_DIRTY' = 'APPLIED'
): Promise<void> {
  await project.pool.query(
    `INSERT INTO ${ledgerName}
      (id, checksum, from_snapshot, to_snapshot, state, applied_at, execution_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      migration.id,
      migration.checksum,
      migration.fromSnapshot ?? null,
      migration.toSnapshot ?? null,
      state,
      state === 'APPLIED' ? new Date() : null,
      state === 'APPLIED' ? 0 : null,
    ]
  );
}

/** Reports whether the runner-owned ledger currently exists. */
export async function ledgerExists(project: TestProject): Promise<boolean> {
  const result = await project.pool.query<{ exists: boolean }>(
    `SELECT to_regclass('public.blendsdk_migrations') IS NOT NULL AS exists`
  );
  return result.rows[0]?.exists === true;
}

/** Returns stable ledger state without client-side bigint coercion. */
export async function ledgerRows(project: TestProject) {
  const result = await project.pool.query<{
    id: string;
    checksum: string;
    from_snapshot: string | null;
    to_snapshot: string | null;
    state: string;
    applied: boolean;
    execution_ms: string | null;
  }>(`
    SELECT id, checksum, from_snapshot, to_snapshot, state,
           applied_at IS NOT NULL AS applied, execution_ms::text
    FROM ${ledgerName}
    ORDER BY id
  `);
  return result.rows;
}

/** Captures one typed runner failure and verifies its operational exit class. */
export async function expectRunnerError(
  action: () => unknown | Promise<unknown>,
  kind?: MigrationErrorKind
): Promise<MigrationError> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof MigrationError)) throw error;
    if (kind) expect(error.kind).toBe(kind);
    expect(error.exitCode).toBe(1);
    return error;
  }
  throw new Error(`Expected ${kind ?? 'typed'} migration failure.`);
}

/** Removes all files, environment values, and databases owned by the current test. */
export async function cleanupRunnerTest(): Promise<void> {
  if (!adminPool) return;
  for (const environmentName of databaseUrlEnvironments.splice(0)) {
    delete process.env[environmentName];
  }
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
  for (const databaseName of databaseNames.splice(0).reverse()) {
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
      [databaseName]
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  }
}

/** Closes the administrative pool after the suite owns no databases. */
export async function teardownRunnerTests(): Promise<void> {
  await adminPool?.end();
  adminPool = undefined;
}
```

Each test owns its `project.pool` and ends it with `await project.pool.end()`; the support module only owns the administrative pool and the databases.

### Suite Wiring and a Happy Path

```typescript
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { runMigrations } from 'blendsdk/codegen';
import {
  cleanupRunnerTest,
  createProject,
  ledgerRows,
  setupRunnerTests,
  teardownRunnerTests,
  writeMigration,
} from './runner.test-support.js';

beforeAll(setupRunnerTests);
afterEach(cleanupRunnerTest);
afterAll(teardownRunnerTests);

describe.sequential('migration runner', () => {
  test('applies pending SQL and records exact ledger metadata', async () => {
    const project = await createProject();
    const migration = await writeMigration(
      project,
      '20260827120100_create-customer',
      'CREATE TABLE customer (id bigint PRIMARY KEY);'
    );

    await runMigrations({ command: 'up', configPath: project.configPath });

    const table = await project.pool.query<{ name: string | null }>(
      `SELECT to_regclass('public.customer') AS name`
    );
    expect(table.rows[0]?.name).toBe('customer');
    expect(await ledgerRows(project)).toEqual([
      expect.objectContaining({
        id: migration.id,
        checksum: migration.checksum,
        state: 'APPLIED',
        applied: true,
      }),
    ]);
    await project.pool.end();
  });
});
```

### Checksum Guard

Applied files are trusted by exact bytes: editing even one word after `up` must fail closed before any SQL executes.

```typescript
import { readFile, writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { formatMigrationError, runMigrations } from 'blendsdk/codegen';
import {
  cleanupRunnerTest,
  createProject,
  expectRunnerError,
  setupRunnerTests,
  teardownRunnerTests,
  writeMigration,
} from './runner.test-support.js';

beforeAll(setupRunnerTests);
afterEach(cleanupRunnerTest);
afterAll(teardownRunnerTests);

describe.sequential('runner history guards', () => {
  test('rejects an edited applied file before executing any SQL', async () => {
    const project = await createProject();
    const migration = await writeMigration(
      project,
      '20260827120000_edit-guard',
      'CREATE TABLE edit_guard (id integer);'
    );
    await runMigrations({ command: 'up', configPath: project.configPath });

    const original = await readFile(migration.upPath, 'utf8');
    await writeFile(migration.upPath, original.replace('integer', 'bigint'), 'utf8');

    for (const command of ['validate', 'status'] as const) {
      const result = await runMigrations({ command, configPath: project.configPath });
      expect(result.status).toBe('INVALID_HISTORY');
    }

    const error = await expectRunnerError(
      () => runMigrations({ command: 'up', configPath: project.configPath }),
      'INVALID_HISTORY'
    );
    const rendered = formatMigrationError(error);
    expect(rendered).toMatch(/checksum/iu);
    expect(rendered).not.toContain('CREATE TABLE');
    await project.pool.end();
  });
});
```

### Advisory Lock

Runner concurrency is serialized with a database-scoped PostgreSQL advisory lock. Hold the lock yourself with a second client to exercise the locked path deterministically.

```typescript
test('reports LOCKED while another session holds the migration advisory lock', async () => {
  const project = await createProject({ lockTimeoutMs: 50 });
  await writeMigration(project, '20260827120100_locked', 'CREATE TABLE lock_guard (id integer);');
  const lockClient = await project.pool.connect();
  await lockClient.query(
    `SELECT pg_advisory_lock(hashtext(current_database()), hashtext('blendsdk:migrations:v1'))`
  );

  const result = await runMigrations({ command: 'status', configPath: project.configPath });
  expect(result.status).toBe('LOCKED');

  await lockClient.query(
    `SELECT pg_advisory_unlock(hashtext(current_database()), hashtext('blendsdk:migrations:v1'))`
  );
  lockClient.release();
  expect(
    (await project.pool.query(`SELECT to_regclass('public.lock_guard') AS name`)).rows[0]?.name
  ).toBeNull();
  await project.pool.end();
});
```

### Cancellation

`runMigrations` accepts an `AbortSignal`. Abort an active transaction and assert both the typed error and the rolled-back effects.

```typescript
test('rolls back an active transaction when aborted', async () => {
  const project = await createProject({ statementTimeoutMs: 10_000 });
  await writeMigration(
    project,
    '20260827120100_abort-active',
    'CREATE TABLE abort_active (id integer); SELECT pg_sleep(5);'
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 80);
  try {
    await expectRunnerError(
      () =>
        runMigrations({
          command: 'up',
          configPath: project.configPath,
          signal: controller.signal,
        }),
      'ABORTED'
    );
  } finally {
    clearTimeout(timer);
  }

  expect(
    (await project.pool.query(`SELECT to_regclass('public.abort_active') AS name`)).rows[0]?.name
  ).toBeNull();
  expect(await ledgerExists(project)).toBe(false);
  await project.pool.end();
});
```

### Ledger State Machine

Construct ledger states directly with SQL and drive `status` across the observable discriminators.

```typescript
test('derives INVALID_HISTORY and UNKNOWN_OUTCOME from ledger state', async () => {
  const project = await createProject();
  const migration = await writeMigration(project, '20260827120100_state', 'SELECT 1;');
  await createLedger(project);
  await insertLedgerRow(project, migration);

  const readStatus = async () =>
    (await runMigrations({ command: 'status', configPath: project.configPath })).status;
  expect(await readStatus()).toBe('UP_TO_DATE');

  await project.pool.query(`UPDATE ${ledgerName} SET checksum = $1`, ['f'.repeat(64)]);
  expect(await readStatus()).toBe('INVALID_HISTORY');

  await project.pool.query(
    `UPDATE ${ledgerName}
       SET checksum = $1, state = 'NONTRANSACTIONAL_DIRTY', applied_at = NULL, execution_ms = NULL`,
    [migration.checksum]
  );
  expect(await readStatus()).toBe('UNKNOWN_OUTCOME');
  await project.pool.end();
});
```

### Scenario Reference

Outcomes to assert for the full runner surface, all exercised by the package's database-backed suites:

| Scenario | Setup | Expected outcome |
| --- | --- | --- |
| Successful run | pending valid file, fresh database | SQL applied, one `APPLIED` ledger row, result status `UP_TO_DATE` |
| Edited applied file | change bytes after `up` | `validate`/`status` return `INVALID_HISTORY`; `up` throws `INVALID_HISTORY`; no SQL executes |
| Prefix violation | local history no longer matches the applied ordered prefix | `INVALID_HISTORY` for validate/status/up |
| Concurrent runners | two `up` calls on one database | one wins; the other throws `LOCKED`; a single ledger row exists |
| External lock holder | hold `pg_advisory_lock(hashtext(current_database()), hashtext('blendsdk:migrations:v1'))` | `status` returns `LOCKED`; `up` throws `LOCKED` |
| Failing transactional SQL | body calls a missing function | throws `DATABASE`; effects rolled back; ledger untouched |
| Abort mid-transaction | `AbortSignal` during `pg_sleep` | throws `ABORTED`; transaction rolled back; retry reports `PENDING` |
| Nontransactional session loss | `transaction: false` plus `pg_terminate_backend(pg_backend_pid())` | throws `UNKNOWN_OUTCOME`; durable `NONTRANSACTIONAL_DIRTY` row retained |
| Dry run | `dryRun: true` with pending files | returns `PENDING` with ordered descriptors; no ledger, no SQL |
| `down` without approval | omit `allowDown: true` | fails without touching the database |

---

## Mocking & Stubbing

### Prefer Real Models

The package's own suite contains no module mocks for the package itself. Schemas, generators, converters, and the OpenAPI assembler are deterministic pure functions of their inputs — instantiate them for real. Database-backed APIs are tested against a disposable real database because mocking the catalog or the ledger would only assert the mock.

### Route and Controller Doubles

For OpenAPI generation, routes are the test doubles. `addController` instantiates the controller with empty `settings` and `services` objects, so a route-only controller is a complete stub — but its `routes()` method must be side-effect free (no database access, no HTTP calls) for this to stay true.

```typescript
import { describe, expect, test } from 'vitest';
import type { RouteDefinition } from 'blendsdk/webafx';
import { OpenAPIGenerator } from 'blendsdk/codegen';

/** Route-only controller double: `addController` supplies empty settings and services. */
class StubProductsController {
  constructor(_settings: unknown, _services: unknown) {}

  routes(): RouteDefinition[] {
    return [
      {
        method: 'get',
        path: '/',
        handler: () => {},
        openapi: { summary: 'List products' },
      } as RouteDefinition,
    ];
  }
}

describe('controller stubs', () => {
  test('collects only documented routes from a controller class', () => {
    const generator = new OpenAPIGenerator({ title: 'Test API', version: '1.0.0' });
    generator.addController('/api/products', StubProductsController);

    const document = generator.generate();

    expect(document.paths['/api/products'].get!.summary).toBe('List products');
  });
});
```

### Configuration and Environment Isolation

Do not mock configuration loading — isolate it. Every test project gets:

- a unique `databaseUrlEnv` variable name (`BLENDSDK_RUNNER_<RANDOM>_URL`), set through `process.env` and deleted during cleanup;
- its own `blendsdk.migrations.ts`;
- its own temporary project directory.

This lets tests exercise real configuration validation (unknown keys, invalid environment names, path traversal) without touching the developer's environment. When a test needs to simulate "no database configured" (the offline validate path), delete the project's own environment variable.

### Deterministic Time

Migration identifiers embed timestamps. Both `generateBaseline` and `generateMigration` accept a `now` option — pass a fixed `Date` so filenames, header ids, and assertions are deterministic.

```typescript
const result = await generateBaseline({
  name: 'initial',
  configPath,
  now: new Date('2026-08-27T09:00:00Z'),
});

expect(result.status).toBe('GENERATED');
// → "20260827090000_initial.up.sql"
```

### Database Doubles vs. Disposable Databases

Preferred order:

1. **Disposable real database** — for `runMigrations`, `adoptBaseline`, and `PostgreSQLIntrospector`. `createProject()` in the support module creates and drops a database per test.
2. **Deliberate ledger manipulation** — use raw SQL through the test's own pool (`createLedger`, `insertLedgerRow`, `UPDATE`) to construct states the public API cannot produce on its own, such as weakened constraints or `NONTRANSACTIONAL_DIRTY` rows.
3. **Narrow interfaces in your own code** — when you inject collaborators around the package, define the narrowest interface your code needs (for example, a single `query` method) and fake that instead of mocking package classes.

Avoid `vi.mock('blendsdk/codegen')` and `vi.mock('pg')`: the package's behavior is versioned by its file contracts (checksums, canonical snapshots, lock keys), and driver-level mocks silently drift from those contracts.

### Global Process State

When your code wraps the runner with signal handling or sets `process.exitCode`, snapshot global state before and after. The package's own CLI tests use exactly this technique:

```typescript fragment
/** Captures the two process listener counts your cancellation wrapper temporarily owns. */
function signalListenerCounts(): readonly [number, number] {
  return [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
}
```

- Capture `process.exitCode` and both listener counts before the call; assert equality afterwards for both success and failure paths.
- Use `vi.spyOn(process, 'once')` to prove that paths which do not support cancellation never install signal listeners, and restore the spy with `mockRestore()`.

### What Not to Mock

- The clock — inject `now` instead.
- Environment variables — set and delete the project's dedicated variable.
- The filesystem — use the temporary project helpers, including failure states you can create through the public API (pre-existing migration files, symlinked snapshots) rather than injected rename failures.
- The advisory lock — acquire it manually with a second `pg` client; that is a real, deterministic lockholder.

---

## Test Patterns by Feature

| Feature | Level | PostgreSQL | Representative assertion |
| --- | --- | --- | --- |
| `TypeGenerator`, `ZodGenerator`, `CTypeGenerator` | Unit | No | Generated source contains expected declarations |
| `convertZodToJsonSchema`, `convertZodToQueryParameters` | Unit | No | Converted schema objects match `toEqual` |
| `OpenAPIGenerator` | Unit | No | Paths, parameters, request bodies, security |
| `DatabaseSchema` authoring | Unit | No | Recorded state and thrown validation errors |
| `PostgreSQLSchemaGenerator` | Unit | No | Deterministic bootstrap DDL |
| `PostgreSQLIntrospector` | Integration | Yes | Introspected container feeds `TypeGenerator` |
| `generateBaseline`, `generateMigration` | Unit (offline) | No | Published files, statuses, preserved artifacts |
| `runMigrations`, `getMigrationStatus`, `validateMigrations` | Integration | Yes | Tables, ledger rows, statuses, typed errors |
| `adoptBaseline` | Integration | Yes | `ADOPTED` or typed rejection, no partial history |
| `blendsdk migrate` CLI | Integration | For DB commands | Exit codes 0/1/2, sanitized output |

### TypeScript, Zod, and Constant-Type Generators

- One fresh `SchemaContainer` per test (`beforeEach`), cleared in `afterEach` (`schema.clear()`).
- Build the smallest model that exercises the rule: scoped names (`scope('api_v1')` prefixes generated type names), `enum`, `optional`, `nullable`, `arrayed`, `partial`, `recordSet`, `ref`.
- Assert on stable formatted substrings of the generated source with `toContain` — for example `export type Directions = "up" | "down";`, `dir: Directions[];`, `export type String3 = string | null;`, `export type Object2 = Partial<{`.
- `ZodGenerator` emits a `zod` import plus exported validator constants; assert on the constant name and the `z.object({`/`z.string()` fragments:

```typescript
import { describe, expect, test } from 'vitest';
import { SchemaContainer, ZodGenerator } from 'blendsdk/codegen';

describe('ZodGenerator', () => {
  test('emits an exported validator constant for a named object', async () => {
    const schema = new SchemaContainer();
    const scope = schema.scope();
    scope.object({ name: scope.string() }).named('user');

    const source = await new ZodGenerator().generate(schema);

    expect(source).toContain("import * as z from 'zod';");
    expect(source).toContain('export const UserSchema = z.object({');
    expect(source).toContain('name: z.string()');
  });
});
```

- `CTypeGenerator.generate(ctypes)` takes the constant-type map produced by introspection (`PostgreSQLIntrospector.introstectConstantTypes()`); unit test it by passing a plain `ConstantType` map and asserting the `e<Name>` constants:

```typescript
import { describe, expect, test } from 'vitest';
import { CTypeGenerator } from 'blendsdk/codegen';

describe('CTypeGenerator', () => {
  test('emits table and column constants for each relation', async () => {
    const source = await new CTypeGenerator().generate({
      'public.customer': ['id', 'name'],
    });

    expect(source).toContain('export const ePublicCustomer = {');
    expect(source).toContain("$TABLE:'public.customer'");
    expect(source).toContain("ID:'id'");
    expect(source).toContain("NAME:'name'");
  });
});
```

### Zod → OpenAPI and OpenAPI Documents

Conversion expectations worth pinning (all asserted in the package's sync unit tests):

| Zod input | OpenAPI output |
| --- | --- |
| `z.string().min(1).max(100)` | `{ type: 'string', minLength: 1, maxLength: 100 }` |
| `z.string().email()` / `.url()` / `.uuid()` | `{ type: 'string', format: 'email' \| 'url' \| 'uuid' }` |
| `z.number().int()` | `{ type: 'integer' }` |
| `z.number().min(0).max(100)` | `{ type: 'number', minimum: 0, maximum: 100 }` |
| `z.enum(['a', 'b'])` | `{ type: 'string', enum: ['a', 'b'] }` |
| `z.array(z.string()).min(1)` | `{ type: 'array', items: { type: 'string' }, minItems: 1 }` |
| `z.string().optional()` in an object | property converted, omitted from `required` |
| `z.string().default('x')` in an object | `{ type: 'string', default: 'x' }`, omitted from `required` |
| `z.string().nullable()` | inner schema in a JSON Schema type array (`type: ['string', 'null']`) |
| `z.union([z.string(), z.number()])` | `{ anyOf: [{ type: 'string' }, { type: 'number' }] }` |
| `z.string().transform(...)` | the *input* type, `{ type: 'string' }` |

For the document assembler: `.openapi()` presence is the opt-in filter, `:param` paths convert to `{param}`, GET/DELETE validation becomes query parameters, POST/PUT/PATCH validation becomes the `application/json` request body, and `secure: true` (or a named principal string) applies `defaultSecurity`. Security config variants are worth a dedicated test file — secure, unsecured, mixed routes, and a secure route with no `defaultSecurity` (which yields `security: []`).

### PostgreSQL Relational Model and Initializer DDL

- Assert model state through accessors: `getColumns()`, `findColumn()`, `getType()`, `getNullable()`, `getDefault()`, `getPrimaryKey()`, `getForeignKeyConstrains()`, `getUniqueConstraints()`, `getIndexes()`, `getExtensions()`, `getTables()`, `getViews()`.
- Assert validation errors with `toThrow(/pattern/)`: identity on non-integer/non-uuid columns, `generated(..., 'VIRTUAL')`, and `references()`/`column()` on unknown columns.
- `PostgreSQLSchemaGenerator` is a bootstrap renderer — never conflate it with the migration pipeline. Test it with `generate({ dropBeforeCreate: false })`, or `generateGrouped()` to assert the `schema`/`indexes`/`views` sections, and assert determinism by calling it twice.

### Catalog Introspection

Introspection reads a live catalog, so test it against a disposable database: create the objects you want to introspect with plain SQL, then run the introspector and assert through the generators:

```typescript fragment
// `database` is an open PostgreSQLDatabase connection.
const introspector = new PostgreSQLIntrospector(database);
const schema = new SchemaContainer();
await introspector.introspect(schema);
const source = await new TypeGenerator().generate(schema);
```

- `introspect(schema, mapper?)` accepts a `ColumnMapper` — test it as a strategy seam by passing a mapper that returns a fixed schema object for a known column and asserting the generated output reflects it.
- Column mappings that cannot be resolved fall back to a deprecated `any` schema and log a warning; assert the fallback through the generated `@deprecated` description rather than by mocking `console`.
- `introstectConstantTypes()` returns the constant-type map (`schema.relation` → column names) used by `CTypeGenerator`; feed the result directly into a `CTypeGenerator` test.

### Migration Configuration, Files, and Offline Generation

- Configuration errors are asserted through the public API (`runMigrations({ command: 'validate', configPath })` or generation) using `expectMigrationError(..., { kind: 'CONFIGURATION', exitCode: 2 })`: unknown keys, zero lock timeouts, invalid `databaseUrlEnv` names, and paths that escape the config directory.
- The version-one migration file format is byte-strict: a header of exactly five lines, no BOM, no CRLF, exactly one trailing LF, and a filename id that matches the header id. Table-driving rejects `%s` cases with `test.each` is the compact way to cover the contract.
- `generateBaseline` is offline and must never open a connection. Test: exactly one `.up.sql` plus `schema.snapshot.json`, snapshot bytes starting with `{\n  "formatVersion": 1,`, no `CASCADE`/`DROP` statements in the baseline, and preservation (byte-identical files) when a snapshot or migration already exists — the failure surfaces as `INVALID_HISTORY`.
- `generateMigration` compares against the committed snapshot: `UP_TO_DATE` leaves artifacts byte-identical; `GENERATED` publishes one migration whose header carries `-- from-snapshot: <previous hash>` and `-- to-snapshot: <new hash>`, plus the replaced snapshot; blocked changes (required-column adds, unsupported transitions) throw and write nothing.

```typescript
test('publishes one migration and the next snapshot, then reports UP_TO_DATE', async () => {
  const project = await createProject({ schemaBody: customerSchema });
  await generateBaseline({
    name: 'initial',
    configPath: project.configPath,
    now: new Date('2026-08-27T09:00:00Z'),
  });
  await writeFile(
    join(dirname(project.configPath), 'schema.ts'),
    `import { DatabaseSchema } from 'blendsdk/codegen';
const schema = new DatabaseSchema('app');
const customer = schema.table('customer');
customer.bigint('id').primaryKey();
customer.text('name').nullable();
customer.text('nickname').nullable();
export default schema;
`,
    'utf8'
  );

  const result = await generateMigration({
    name: 'add-nickname',
    configPath: project.configPath,
    now: new Date('2026-08-27T10:00:00Z'),
  });
  const migrationPath = join(project.migrationsDir, '20260827100000_add-nickname.up.sql');
  const sql = await readFile(migrationPath, 'utf8');

  expect(result.status).toBe('GENERATED');
  expect(sql).toMatch(/-- from-snapshot: [a-f0-9]{64}/);
  expect(sql).toContain('ALTER TABLE "public"."customer" ADD COLUMN "nickname" text;');

  const upToDate = await generateMigration({
    name: 'nothing',
    configPath: project.configPath,
    now: new Date('2026-08-27T11:00:00Z'),
  });
  expect(upToDate.status).toBe('UP_TO_DATE');
  await project.pool.end();
});
```

### Migration Execution and Ledger States

Use the scenario reference in Integration Testing as the assertion matrix. Additional patterns:

- After a successful `up`, `runMigrations` returns `UP_TO_DATE`; a dry run with pending files returns `PENDING` with the ordered `migrations` descriptors while creating neither a ledger nor SQL effects.
- `down` requires `allowDown: true`; reverting the latest migration must leave earlier rows and tables intact and delete exactly one ledger row.
- Nontransactional migrations (`transaction: false`) leave a durable `NONTRANSACTIONAL_DIRTY` marker if the session is lost; assert the marker survives and that `status` reports `UNKNOWN_OUTCOME`.
- Redaction is a contract: assert that `formatMigrationError(error)` never contains credentials, SQL bodies, or literal secrets (`'sql-secret'`, `'db-secret'`).

### Baseline Adoption

`adoptBaseline` records history only after proving the live catalog structurally matches the generated baseline. The confirmation token is `<database-name>/<baseline-id>`.

```typescript
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { adoptBaseline, generateBaseline } from 'blendsdk/codegen';
import type { MigrationDescriptor } from 'blendsdk/codegen';
import {
  cleanupRunnerTest,
  createProject,
  expectRunnerError,
  ledgerExists,
  ledgerRows,
  setupRunnerTests,
  teardownRunnerTests,
  type TestProject,
} from './runner.test-support.js';

const baselineInstant = new Date('2026-08-27T09:00:00Z');

/** One compact supported schema as a fixture-module body. */
const customerSchema = `
const schema = new DatabaseSchema('app');
const customer = schema.table('customer');
customer.bigint('id').primaryKey();
customer.text('name').nullable();
export default schema;`;

/** Returns only executable SQL after the strict five-line migration header. */
async function migrationBody(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).split('\n').slice(5).join('\n');
}

/** Returns the confirmation token tied to one exact database and baseline identifier. */
function confirmationToken(project: TestProject, baselineId: string): string {
  return `${new URL(project.databaseUrl).pathname.slice(1)}/${baselineId}`;
}

/** Narrows a successful baseline result to its required immutable migration. */
function requiredMigration(result: {
  readonly migration?: MigrationDescriptor;
}): MigrationDescriptor {
  if (!result.migration) throw new Error('Baseline fixture is missing its migration.');
  return result.migration;
}

beforeAll(setupRunnerTests);
afterEach(cleanupRunnerTest);
afterAll(teardownRunnerTests);

describe.sequential('baseline adoption', () => {
  test('adopts an exact matching database after confirmation without running baseline DDL', async () => {
    const project = await createProject({ schemaBody: customerSchema });
    const baseline = await generateBaseline({
      name: 'initial',
      configPath: project.configPath,
      now: baselineInstant,
    });
    const migration = requiredMigration(baseline);
    await project.pool.query(await migrationBody(migration.upPath));
    await project.pool.query(`INSERT INTO public.customer (id, name) VALUES (7, 'preserve me')`);

    const result = await adoptBaseline({
      configPath: project.configPath,
      confirmation: confirmationToken(project, migration.id),
    });

    expect(result.status).toBe('ADOPTED');
    const rows = await project.pool.query<{ name: string }>(
      `SELECT name FROM public.customer WHERE id = 7`
    );
    expect(rows.rows).toEqual([{ name: 'preserve me' }]);
    expect(await ledgerRows(project)).toEqual([
      expect.objectContaining({ id: migration.id, checksum: migration.checksum, state: 'APPLIED' }),
    ]);
    await project.pool.end();
  });

  test('rejects a database that does not match the baseline and leaves no history', async () => {
    const project = await createProject({ schemaBody: customerSchema });
    const baseline = await generateBaseline({
      name: 'initial',
      configPath: project.configPath,
      now: baselineInstant,
    });
    const migration = requiredMigration(baseline);

    const error = await expectRunnerError(
      () =>
        adoptBaseline({
          configPath: project.configPath,
          confirmation: confirmationToken(project, migration.id),
        }),
      'UNSUPPORTED'
    );

    expect(error.message).toContain('MISSING');
    expect(error.message).toMatch(/public\.customer/);
    expect(await ledgerExists(project)).toBe(false);
    await project.pool.end();
  });
});
```

| Existing database state | `adoptBaseline` outcome |
| --- | --- |
| Exact structural match plus confirmation | `{ status: 'ADOPTED' }` and one `APPLIED` ledger row; existing rows preserved |
| Missing, different, or extra modeled objects | throws `UNSUPPORTED` naming the qualified object; ledger untouched |
| Desired raw SQL that cannot be proven structurally equivalent | throws `UNSUPPORTED` (`UNSUPPORTED_FOR_ADOPTION`) |
| Unmanaged functions or triggers present | still adopted; reported as `UNMANAGED` comparisons and preserved |
| Nonempty ledger | throws `INVALID_HISTORY`; nothing changes |
| Wrong confirmation token | throws `CONFIGURATION` (exit code 2); ledger untouched |

For the preview-before-confirmation flow, `adoptBaseline` accepts a second, hook-style argument. Return the confirmation token from `afterPreview` to model an operator who inspects the sanitized preview first.

### CLI

The migration CLI is the `blendsdk migrate` executable of the assembled SDK. Test it as a subprocess; assert output and exit codes rather than internals.

| Exit code | Meaning | Example |
| --- | --- | --- |
| 0 | Success | `migrate --help`, `--version`, `migrate validate --offline` with valid history |
| 1 | Operational failure | invalid history, checksum mismatch, `DATABASE`, `LOCKED`, `UNKNOWN_OUTCOME` |
| 2 | Usage or configuration | unknown command, missing name argument, invalid `blendsdk.migrations.ts` |

```typescript
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanupTemporaryDirectories, temporaryDirectory } from './test-support.js';

const executeFile = promisify(execFile);

/** Installed executable of the assembled SDK that hosts the migration CLI. */
const blendsdkCli = join(process.cwd(), 'node_modules', '.bin', 'blendsdk');

afterEach(cleanupTemporaryDirectories);

describe('blendsdk migrate CLI', () => {
  test('documents exactly the eight lifecycle commands', async () => {
    const { stdout } = await executeFile(blendsdkCli, ['migrate', '--help']);

    for (const command of [
      'generate',
      'create',
      'up',
      'down',
      'status',
      'validate',
      'baseline',
      'adopt-baseline',
    ]) {
      expect(stdout).toContain(command);
    }
    expect(stdout).not.toMatch(/\b(force|fake|repair)\b/iu);
  });

  test('validates local history offline and prints UP_TO_DATE', async () => {
    const projectDirectory = await temporaryDirectory();
    const migrationsDir = join(projectDirectory, 'migrations');
    await mkdir(migrationsDir);
    const id = '20260827120000_cli-offline';
    await writeFile(
      join(migrationsDir, `${id}.up.sql`),
      [
        '-- blendsdk-migration: 1',
        `-- id: ${id}`,
        '-- transaction: true',
        '-- from-snapshot: none',
        '-- to-snapshot: none',
        'SELECT 1;',
        '',
      ].join('\n'),
      'utf8'
    );
    const configPath = join(projectDirectory, 'blendsdk.migrations.ts');
    await writeFile(configPath, "export default { migrationsDir: './migrations' };\n", 'utf8');

    const result = await executeFile(blendsdkCli, [
      'migrate',
      'validate',
      '--offline',
      '--config',
      configPath,
    ]);

    expect(result.stdout).toContain('UP_TO_DATE');
    expect(result.stderr).toBe('');
  });

  test('maps unknown commands to the usage exit code', async () => {
    await expect(executeFile(blendsdkCli, ['migrate', 'repair'])).rejects.toMatchObject({
      code: 2,
    });
  });
});
```

Additional CLI contracts worth pinning: help for every command exits 0 without running a migration; `--help` output never mentions force/fake/repair style bypasses and documents the 0/1/2 exit classes; operational failures print the status token (`INVALID_HISTORY`) on stdout with empty stderr; and diagnostics never echo payloads (option-to-SQL injection, path traversal).

### Public API Surface (Compile Spec)

Keep a compile-only file that imports the public types, assigns representative values, and sinks them with `void`. It fails `tsc` when an export or type drifts, without executing anything at test time.

```typescript
// tests/migrations/public-exports.compile-spec.ts
import {
  formatMigrationError,
  MigrationError,
  runMigrations,
  type MigrationCommandResult,
  type MigrationDescriptor,
  type MigrationStatus,
  type RunMigrationsOptions,
} from 'blendsdk/codegen';

const descriptor: MigrationDescriptor = {
  id: '20260827120000_add-customer-status',
  upPath: '/project/migrations/20260827120000_add-customer-status.up.sql',
  checksum: '1'.repeat(64),
  transactional: true,
  fromSnapshot: '2'.repeat(64),
  toSnapshot: '3'.repeat(64),
};

const status: MigrationStatus = 'PENDING';

const options: RunMigrationsOptions = {
  command: 'up',
  configPath: './blendsdk.migrations.ts',
  dryRun: true,
};
const result: Promise<MigrationCommandResult> = runMigrations(options);

const rendered: string = formatMigrationError(
  new MigrationError({ kind: 'INVALID_HISTORY', exitCode: 1, message: 'History mismatch.' })
);

void descriptor;
void status;
void result;
void rendered;
```

### Packed Distribution (Integration)

Release validation packs the assembled `blendsdk` package and exercises the exact publishable bytes in a scratch consumer directory:

1. Run `npm pack --ignore-scripts` into a temporary pack directory (with a 30-second timeout).
2. Extract the tarball and move `package/` to `node_modules/blendsdk`.
3. Symlink the runtime dependencies (`jiti`, `prettier`, `zod`) and `node_modules/.bin/blendsdk` to keep the test offline.
4. Assert packaging metadata: `bin.blendsdk`, declared dependencies, and that `pg` is *not* shipped (it is an optional peer dependency).
5. Import the packed entry point and assert the public functions (`generateMigration`, `runMigrations`, `validateMigrations`) exist.
6. Run `blendsdk migrate --help` from the consumer directory; assert the banner and empty stderr.
7. Smoke the full playground workflow through the assembled CLI (`yarn workspace blendsdk/playground migrations:smoke` with `BLENDSDK_PLAYGROUND_ADMIN_URL` pointing at the disposable PostgreSQL) and assert `GENERATED`, `CREATED`, `PENDING`, and `UP_TO_DATE` lines with empty stderr. This step requires the Docker database.

---

---

# codegen Troubleshooting

This document covers the errors you are most likely to hit while generating code and while running the PostgreSQL migration lifecycle. Every migration failure is reported as a typed `MigrationError` with a stable `kind` and an exit classification, so diagnostics never depend on message text — and message text is redacted, so credentials and SQL bodies never appear in output. Handle errors structurally:

```typescript
import { formatMigrationError, MigrationError, runMigrations } from 'blendsdk/codegen';

try {
  const result = await runMigrations({ command: 'up', configPath: './blendsdk.migrations.ts' });
  console.log(result.status);
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(error.kind, error.exitCode, formatMigrationError(error));
  } else {
    throw error;
  }
}
```

Each issue below follows the same shape: the exact error message or symptom, why it happens, and how to fix it with working code.

---

## Common Errors

### Schema Authoring and Relational Model Errors

The relational model is authored through `DatabaseSchema`, `TableSchema`, and `TableColumnSchema`. Its errors are thrown eagerly, at authoring time — long before any generator runs.

#### `Error: Column email does not exit in public.customer`

**Cause.** Constraints resolve column names through `RelationSchema.findColumn()`, which compares the exact column name against columns that have already been added to the table. A typo, a case mismatch, or a constraint declared before its column all produce this message. The verb "exit" is a typo in the thrown text — grep for it exactly as written.

**Fix.** Declare all columns first, then declare constraints.

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');
const customer = schema.table('customer');
customer.bigint('id').primaryKey();
customer.varchar('email', 255).nullable();

const order = schema.table('order');
order.bigint('id').primaryKey();
order.bigint('customer_id');

// Columns exist before the constraint references them.
order.foreignKeyConstraint(customer).from('customer_id').to('id').onDelete('CASCADE');
```

#### `Error: Use the from() and to()`

**Cause.** `ForeignKeyConstraint` intentionally overrides `column()` and throws. A foreign key always has two sides — the local columns (`from()`) and the referenced columns (`to()`) — so the single-sided `column()` form used by unique and check constraints is not valid here.

**Fix.** Build foreign keys with `from()`/`to()`, or use the `references()` shorthand on the column.

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');
const customer = schema.table('customer');
customer.bigint('id').primaryKey();

const order = schema.table('order');
order.bigint('id').primaryKey();

// Shorthand: registers the foreign key constraint in one call.
order.bigint('customer_id').references(customer, 'id', 'CASCADE', 'RESTRICT');

// Explicit form with explicit referential actions.
const fk = order.foreignKeyConstraint(customer);
fk.from('customer_id').to('id').onUpdate('CASCADE').onDelete('RESTRICT');
```

#### `Error: IDENTITY columns must be integer or uuid types`

**Cause.** `TableColumnSchema.identity()` accepts only `smallint`, `integer`, `bigint`, and `uuid`. `serial` and `bigserial` are rejected even though they are integer-family types, because a serial column *is already* a sequence-backed default — and the column's type must have been set (via a table helper) before `identity()` is called.

**Fix.** Model identity columns with the plain integer types, not the serial shorthands.

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');
const item = schema.table('item');

item.integer('id').primaryKey().identity('ALWAYS', { start: 100, increment: 1 });
item.text('label').nullable();

const ddl = new PostgreSQLSchemaGenerator(schema).generateGrouped();
console.log(ddl.schema);
```

#### `Error: Column cannot be both IDENTITY and GENERATED`

**Cause.** A column may be an identity column or a generated column, never both. The guard is checked when `intyo identity()` runs while a generated expression is already recorded on the column — so the error appears on the `.identity(...)` call after `.generated(...)`, not the other way around. Both mechanisms also silently clear any previously configured `DEFAULT`, because PostgreSQL forbids defaults on identity and generated columns.

**Fix.** Pick one mechanism per column and configure it once.

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');
const item = schema.table('item');

// Correct: one mechanism per column.
item.integer('id').identity('BY DEFAULT');
const doubled = item.integer('doubled');
doubled.generated('amount * 2');

// Wrong: throws "Column cannot be both IDENTITY and GENERATED".
// doubled.identity('ALWAYS');
```

#### `Error: PostgreSQL only supports STORED generated columns`

**Cause.** `.generated(expression, 'VIRTUAL')` throws immediately. PostgreSQL has no virtual generated columns — stored is the only supported form.

**Fix.** Use the default `'STORED'` form (or omit the second argument).

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');
const item = schema.table('item');
item.numeric('amount', 12, 2);

const total = item.numeric('total', 12, 2);

try {
  total.generated('amount * 1.0', 'VIRTUAL');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  // PostgreSQL only supports STORED generated columns
}

// Fix: stored form.
total.generated('amount * 1.0');
```

#### `TS2339: Property 'nullable' does not exist on type 'void'`

**Cause.** `TableColumnSchema.size()` and `TableColumnSchema.scale()` are setters that return `void` — they are the only two column methods that are not chainable. Chaining anything after them fails to compile.

**Fix.** Pass size and scale through the table helpers (preferred), or configure the column in separate statements.

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');
const item = schema.table('item');

// Preferred: helpers take size and scale as arguments and return the column.
item.varchar('sku', 32).nullable();
item.numeric('amount', 12, 2);

// Alternative: standalone statements for the two void-returning setters.
const code = item.varchar('code');
code.size(8);
code.nullable();
```

### Code Generation Errors

`TypeGenerator`, `ZodGenerator`, and `CTypeGenerator` share one traversal in the abstract `Generator` base: it resets the container, renders every **named** root, joins the buffer, and formats it with Prettier.

#### `Error: Object properties cannot be named explicitly. Create a seperate root type (<Name>) and use .ref() as the property.`

**Cause.** A schema object that is a property of another object (it has a parent) must be rendered inline and therefore must not carry its own name. Naming an inline property trips the generator's root check. Note the verb "seperate" — it is spelled that way in the thrown text.

**Fix.** Lift the nested shape to a named root and reference it with `.ref()`.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

const address = scope
  .object({
    street: scope.string(),
    city: scope.string(),
  })
  .named('Address');

scope
  .object({
    name: scope.string(),
    address: scope.ref(address),
  })
  .named('Customer');

const source = await new TypeGenerator().generate(schema);
console.log(source);
```

#### `Error: Referenced schema is not named!`

**Cause.** `.ref()` targets must be named. Both `TypeGenerator` and `ZodGenerator` look up `getName()` on the referenced schema while rendering; an anonymous target (for example `scope.ref(scope.string())`) throws.

**Fix.** Name the target before referencing it.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

const status = scope.string().named('Status').enum(['active', 'inactive']);

scope
  .object({
    status: scope.ref(status),
  })
  .named('Account');

const source = await new TypeGenerator().generate(schema);
console.log(source);
```

#### Generator output is empty or missing declarations

**Symptom.** `await generator.generate(schema)` resolves successfully but returns an empty string (or an output that omits a type you expected). No error is thrown.

**Cause.** `Generator.generate()` iterates every schema object and renders only those where `obj.getName()` is set — unnamed roots are skipped silently. The same is true for zoo schemas you never attach anywhere.

**Fix.** Call `.named(...)` on every root you want exported, and verify by printing the source.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

scope.object({ id: scope.number() }); // unnamed root — silently skipped
scope.object({ id: scope.number() }).named('Product');

const source = await new TypeGenerator().generate(schema);
console.log(source); // contains only the Product declaration
```

#### Prettier failure that dumps the entire generated buffer

**Symptom.** `generate()` rejects with a formatting error, and the complete unformatted source appears on the console immediately before the stack trace.

**Cause.** `Generator.generate()` formats the assembled buffer with Prettier (`parser: 'typescript'`). When the emitted text is not parseable, the generator prints the raw buffer with `console.log(src)` and rethrows. This is a feature: the dump is the exact unformatted source. The trigger is almost always in the schema input — names and description text flow directly into declarations, JSDoc blocks, and member positions.

**Fix.** Read the printed buffer top-down, find the first line Prettier rejects, and correct the schema input that produced it; then regenerate.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();
scope.object({ id: scope.number() }).named('Product');

try {
  const source = await new TypeGenerator().generate(schema);
  console.log(source);
} catch (error) {
  // Generator.generate() already printed the raw buffer with console.log
  // immediately before rethrowing — locate the first invalid line there
  // and fix the schema input that produced it.
  console.error('Formatting failed for the printed buffer:', error);
}
```

### PostgreSQL Introspection Issues

#### `[WARNING]: public -> attachments -> jsonb could not be mapped!`

**Symptom.** Introspection logs a warning per column, and the generated TypeScript type for those columns is `any` annotated with `@deprecated`.

**Cause.** `PostgreSQLIntrospector.mapPgTypeToTypescript()` deliberately returns `null` for types it does not translate — `json`, `jsonb`, `bytea`, `interval`, range types, and geometric types among them. `createTypes()` then logs the warning and falls back to a deprecated `any` schema so introspection never fails hard on an unknown type.

**Fix.** Pass a `ColumnMapper` to `introspect()` that claims the columns you care about; return `undefined` to fall back to the built-in mapping.

```typescript fragment
import type { ColumnMapper } from 'blendsdk/codegen';

const columnMapper: ColumnMapper = (record, scope) => {
  switch (record.formatted_type) {
    case 'json':
    case 'jsonb':
      return scope.any().description('Decoded JSON value');
    case 'bytea':
      return scope.any().description('Raw binary data');
    default:
      return undefined; // fall back to the built-in PostgreSQL -> TypeScript mapping
  }
};

await introspector.introspect(schema, columnMapper);
```

### OpenAPI Generation Issues

#### Endpoints are missing from the generated OpenAPI document

**Symptom.** `generator.generate()` returns `paths: {}` — or omits individual routes — even though the controller registers them.

**Cause.** Inclusion is strictly opt-in: `addRoutes()` collects only route definitions that carry `.openapi()` metadata. Two related traps: an empty `openapi: {}` *is* enough to opt in, and registering the same method + full path twice silently overwrites the earlier operation (the last registration wins).

**Fix.** Annotate every route you want documented and keep method + path pairs unique.

```typescript
import { OpenAPIGenerator } from 'blendsdk/codegen';
import type { RouteDefinition } from 'blendsdk/webafx';
import { z } from 'zod';

class ProductsController {
  routes(): RouteDefinition[] {
    return [
      {
        method: 'get',
        path: '/',
        validation: z.object({ page: z.coerce.number().default(1) }),
        handler: () => undefined,
        openapi: { summary: 'List products' },
      },
      {
        method: 'get',
        path: '/internal',
        handler: () => undefined,
        // No .openapi() metadata — this route is excluded from the document.
      },
    ];
  }
}

const generator = new OpenAPIGenerator({ title: 'Catalog API', version: '1.0.0' });
generator.addController('/api/products', ProductsController);

console.log(Object.keys(generator.generate().paths));
// [ '/api/products' ]
```

#### `TypeError: Cannot read properties of undefined` while adding a controller

**Symptom.** `generator.addController(...)` throws a `TypeError` from inside the controller constructor.

**Cause.** `addController()` instantiates the controller with empty mock objects — `new ControllerClass({}, {})` — because `routes()` is expected to only build `RouteDefinition` objects. Any constructor that reads or calls into settings or services fails during generation.

**Fix.** Keep constructors side-effect free: store nothing derived from the mock dependencies and build all route definitions in `routes()`.

```typescript
import { OpenAPIGenerator } from 'blendsdk/codegen';
import type { RouteDefinition } from 'blendsdk/webafx';

class AuditController {
  // Generation constructs controllers with empty settings/services objects.
  // Do not dereference dependencies here — build routes in routes() instead.
  routes(): RouteDefinition[] {
    return [
      {
        method: 'get',
        path: '/events',
        handler: () => undefined,
        openapi: { summary: 'List audit events' },
      },
    ];
  }
}

const generator = new OpenAPIGenerator({ title: 'Catalog API', version: '1.0.0' });
generator.addController('/api/audit', AuditController);
console.log(Object.keys(generator.generate().paths));
```

#### Query parameters are missing for GET/DELETE operations

**Symptom.** A GET or DELETE route with a `validation` schema produces an operation with no `parameters` (or only path parameters).

**Cause.** `convertZodToQueryParameters()` expands a top-level object schema only — optionally wrapped by optional/nullable/default/pipe. Any other schema shape returns `[]` silently. Nested objects are not flattened into parameters.

**Fix.** Validate GET/DELETE input with `z.object(...)` whose properties are scalars, and confirm the conversion directly.

```typescript
import { z } from 'zod';
import { convertZodToQueryParameters } from 'blendsdk/codegen';

const query = z.object({
  page: z.coerce.number().default(1),
  search: z.string().optional(),
});

console.log(convertZodToQueryParameters(query));

// A non-object schema yields no parameters at all — silently.
console.log(convertZodToQueryParameters(z.string())); // []
```

#### Secure operations serialize as `"security": []`

**Symptom.** The generated JSON contains `"security": []` for routes marked `secure: true`.

**Cause.** `buildSecurity()` returns an empty array when the route is secure but the generator config has no `defaultSecurity`. Per OpenAPI semantics, `[]` means *no security requirement*, so the document contradicts the route intent.

**Fix.** Configure `securitySchemes` and `defaultSecurity` together.

```typescript
import { OpenAPIGenerator } from 'blendsdk/codegen';
import type { RouteDefinition } from 'blendsdk/webafx';

class AdminController {
  routes(): RouteDefinition[] {
    return [
      {
        method: 'get',
        path: '/settings',
        secure: true,
        handler: () => undefined,
        openapi: { summary: 'Read settings' },
      },
    ];
  }
}

const generator = new OpenAPIGenerator({
  title: 'Catalog API',
  version: '1.0.0',
  securitySchemes: {
    bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  },
  defaultSecurity: [{ bearerAuth: [] }],
});

generator.addController('/api/admin', AdminController);
console.log(JSON.stringify(generator.generate().paths['/api/admin/settings'].get?.security));
// [{"bearerAuth":[]}]
```

### Migration Configuration and CLI Errors

#### `USAGE: Run \`blendsdk migrate --help\` for the supported commands.` / `USAGE: Invalid migration command arguments.`

**Symptom.** Either message on stderr, no stdout, exit code 2.

**Cause.** The CLI accepted the argv but rejected its shape: empty argv, a bare `migrate`, an unknown command, `generate`/`create`/`baseline` without a name, `status` with a stray positional argument, or `down` without its confirmation argument.

**Fix.** Use one of the eight lifecycle commands with the correct arity; `--help` is available on every command.

```bash
blendsdk migrate --help
blendsdk migrate status --config ./blendsdk.migrations.ts
blendsdk migrate validate --offline --config ./blendsdk.migrations.ts
blendsdk migrate generate add-customer-status
blendsdk migrate down --help
```

| Command | Argument | Exit classes used |
| --- | --- | --- |
| `baseline` | name | 0, 1, 2 |
| `generate` | name | 0, 1, 2 |
| `create` | name | 0, 1, 2 |
| `up` | — | 0, 1, 2 |
| `down` | confirmation | 0, 1, 2 |
| `status` | — | 0, 1, 2 |
| `validate` | `--offline` supported | 0, 1, 2 |
| `adopt-baseline` | — | 0, 1, 2 |

#### `CONFIGURATION: ...` on stderr, exit code 2

**Symptom.** The CLI exits 2 with a single `CONFIGURATION:` line; API calls throw `MigrationError` with `kind: 'CONFIGURATION'` and `exitCode: 2`.

**Cause.** Configuration loading rejects all of the following, before any database or file outside the config directory is touched:

- a missing config file, or a default export that is not an object
- unknown configuration keys
- `lockTimeoutMs: 0` (and other out-of-range numeric options)
- `databaseUrlEnv` values that are not environment-variable-style names (for example `database-url`)
- `migrationsDir` values that traverse (`../outside`), point at a filesystem root (`/`), or resolve through a symlink

**Fix.** Keep the configuration minimal and local — paths are resolved relative to the config file, and credentials stay out of it (only the environment variable *name* is stored).

```typescript
import { defineMigrationConfig } from 'blendsdk/codegen';

export default defineMigrationConfig({
  schema: './src/database/schema.ts',
  migrationsDir: './migrations',
  databaseUrlEnv: 'DATABASE_URL',
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 900_000,
});
```

### Migration Execution Errors

#### `INVALID_HISTORY` after editing an applied migration

**Symptom.** `status`/`validate` report `INVALID_HISTORY`, and `up` throws a `MigrationError` with `kind: 'INVALID_HISTORY'`. `formatMigrationError(error)` mentions the checksum.

**Cause.** The ledger stores the SHA-256 of the exact migration bytes, and the runner requires the applied ledger rows to be the exact ordered prefix of local history. Any byte change to a committed migration — even whitespace — breaks the match. The runner never repairs history automatically.

**Fix.** Restore the committed bytes from version control and never edit an applied migration; make a new migration for the change.

```typescript
import { formatMigrationError, MigrationError, runMigrations } from 'blendsdk/codegen';

const configPath = './blendsdk.migrations.ts';

const check = await runMigrations({ command: 'validate', configPath });
if (check.status === 'INVALID_HISTORY') {
  console.error('Restore the committed migration bytes (for example: git checkout -- migrations/).');
}

try {
  await runMigrations({ command: 'up', configPath });
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(formatMigrationError(error));
  }
}
```

#### `INVALID_HISTORY` from migration file parsing or discovery

**Symptom.** Any migrate command fails with `INVALID_HISTORY` (exit 1) before any SQL is sent, with no database connection involved.

**Cause.** The version-one file contract is byte-exact, and discovery is strict. Typical triggers:

- a UTF-8 BOM added by an editor, CRLF line endings, or a missing final newline
- reordered, duplicated, or unknown header lines; a header id that disagrees with the filename
- a comment-only SQL body
- a stray `.sql` file in the migrations directory, a `*.down.sql` without its up file, or a differently cased duplicate id
- a migration file that is a symbolic link

Discovery also rejects malformed quoted strings or unterminated comments when validating transactional bodies — it fails closed rather than forwarding ambiguous SQL.

**Fix.** Regenerate files instead of hand-editing them, and keep exactly the up/down pairs in the directory. A valid file has five header lines in fixed order, LF endings, a final newline, and a nonempty body:

```sql
-- blendsdk-migration: 1
-- id: 20260827120000_add-customer-status
-- transaction: true
-- from-snapshot: none
-- to-snapshot: 6f1f0c2f6a2f6f1f0c2f6a2f6f1f0c2f6a2f6f1f0c2f6a2f6f1f0c2f6a2f6f1f
ALTER TABLE "public"."customer" ADD COLUMN "status" text;
```

#### `LOCKED`

**Symptom.** `MigrationError` with `kind: 'LOCKED'`, exit 1 — or `status` returning `LOCKED`. No SQL has run.

**Cause.** The runner serializes on a database-scoped PostgreSQL advisory lock. Another session holds it (usually a concurrent `blendsdk migrate up`), and `lockTimeoutMs` elapsed while waiting. The lock is scoped per database, so two different databases never contend.

**Fix.** Find the holder, let it finish (or decide deliberately to terminate it), then re-run.

```sql
SELECT pid, application_name, state, query
FROM pg_stat_activity
WHERE datname = current_database()
  AND application_name = 'blendsdk-migrations';
```

```typescript
import { runMigrations } from 'blendsdk/codegen';

const result = await runMigrations({ command: 'status', configPath: './blendsdk.migrations.ts' });

if (result.status === 'LOCKED') {
  console.error('Another blendsdk migrate process holds the database lock; retry after it finishes.');
}
```

If your migrations are legitimately slow, raise `lockTimeoutMs` — but do not run two runners against the same database.

#### `UNKNOWN_OUTCOME` with a `NONTRANSACTIONAL_DIRTY` ledger row

**Symptom.** `MigrationError` with `kind: 'UNKNOWN_OUTCOME'`, or `status` returning `UNKNOWN_OUTCOME`, together with a ledger row whose `state` is `NONTRANSACTIONAL_DIRTY`.

**Cause.** Nontransactional migrations (`-- transaction: false`) write a durable dirty marker *before* dispatching SQL. If the session is lost mid-flight — or a nontransactional `down` fails — the true outcome cannot be known. This state is deliberate and never auto-repaired: the CLI has no force/fake/repair command.

**Fix.** Inspect the ledger row and the database, repair partial effects manually, reconcile the row, and only then run again.

```sql
SELECT id, checksum, from_snapshot, to_snapshot, state, applied_at, execution_ms
FROM public.blendsdk_migrations
ORDER BY id;
```

```typescript
import { formatMigrationError, MigrationError, runMigrations } from 'blendsdk/codegen';

try {
  await runMigrations({ command: 'up', configPath: './blendsdk.migrations.ts' });
} catch (error) {
  if (error instanceof MigrationError && error.kind === 'UNKNOWN_OUTCOME') {
    console.error(formatMigrationError(error));
    // Inspect the printed migration id, verify or repair its effects in the database,
    // reconcile public.blendsdk_migrations, and only then run up again.
  }
}
```

#### `DATABASE` errors, or a body rejected for containing transaction control

**Symptom.** `MigrationError` with `kind: 'DATABASE'` (exit 1, transactional effects rolled back) — often after the server rejected a statement, or `statementTimeoutMs` elapsed. Alternatively, a migration file fails validation because its body contains `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `SET TRANSACTION`, or similar at statement level.

**Cause.** Two distinct rules. SQL that fails in a transactional migration rolls back atomically — nothing partial survives. And the runner owns the transaction boundary, so transactional bodies may not contain transaction control statements; the lexical guard rejects them (and fails closed on unbalanced quotes or unterminated comments).

**Fix.** Remove transaction control from migration bodies. If a body legitimately needs to run outside a transaction, mark the migration nontransactional (`-- transaction: false`) and accept `UNKNOWN_OUTCOME` semantics on interruption. Raise the statement timeout for long-running DDL through configuration.

```sql
-- Correct: no transaction control — the runner owns the transaction.
CREATE TABLE "public"."audit_log" ("id" bigint PRIMARY KEY, "note" text);
```

```typescript
import { defineMigrationConfig } from 'blendsdk/codegen';

export default defineMigrationConfig({
  schema: './src/database/schema.ts',
  statementTimeoutMs: 1_800_000,
});
```

### Artifact Publication and Snapshot Errors

#### `FILESYSTEM` errors from artifact publication

**Symptom.** `generateMigration`/`generateBaseline` throw `MigrationError` with `kind: 'FILESYSTEM'`, exit 1. Exact messages you can encounter:

- `Migration target already exists: <file>.`
- `Migration directory must be a real directory.` / `Snapshot directory must be a real directory.`
- `Snapshot target must be a regular file.`
- `Artifact verification failed: <file>.`
- `Migration and snapshot targets must be different files.`
- `a target already exists`, `permission denied`, `a required path does not exist`, `filesystem operation failed`

**Cause.** Artifact publication is deliberately strict: the migration file is immutable and claimed atomically, so an existing migration is never overwritten; symlinked parent directories and non-regular snapshot targets are rejected; both files are written, flushed, and re-read before either public path changes. Two concurrent generators against the same project: exactly one wins, the other fails with `FILESYSTEM`.

**Fix.** Ensure the migrations directory exists as a real directory, delete the conflicting untracked file (or regenerate so a fresh id is chosen), fix permissions, and re-run.

```typescript
import { formatMigrationError, generateMigration, MigrationError } from 'blendsdk/codegen';

try {
  const result = await generateMigration({
    name: 'add-customer-status',
    configPath: './blendsdk.migrations.ts',
  });
  console.log(result.status);
} catch (error) {
  if (error instanceof MigrationError && error.kind === 'FILESYSTEM') {
    console.error(formatMigrationError(error));
  }
}
```

#### `INVALID_HISTORY` reporting a torn migration/snapshot pair

**Symptom.** A migration file exists whose `-- to-snapshot` hash is not the hash of the committed `schema.snapshot.json`. The rendered error tells you to remove the orphan migration or restore the snapshot from version control, and explicitly offers no automatic repair.

**Cause.** The writer rolls back *caught* publication failures — but a process killed between publishing the migration and replacing the snapshot leaves the pair torn. The lineage check detects this at the next run and fails closed.

**Fix.** Decide manually which side is authoritative: if the migration was never applied, delete the orphan migration (the old snapshot is still correct); if it was applied, restore the previous snapshot from version control and reconcile the ledger. Then generate again.

```typescript
import { formatMigrationError, MigrationError, runMigrations } from 'blendsdk/codegen';

try {
  await runMigrations({ command: 'up', configPath: './blendsdk.migrations.ts' });
} catch (error) {
  if (error instanceof MigrationError && error.kind === 'INVALID_HISTORY') {
    console.error(formatMigrationError(error));
    // Follow the printed guidance: remove the orphan migration or restore
    // the committed snapshot — never edit artifacts in place.
  }
}
```

### Baseline Adoption Errors

#### `UNSUPPORTED` during `adoptBaseline`

**Symptom.** `MigrationError` with `kind: 'UNSUPPORTED'`, exit 1. The message contains a classification and a qualified identity — for example `DIFFERENT public.customer`, `MISSING public.customer`, `EXTRA_MODELED public.extra_modeled`, or `UNSUPPORTED_FOR_ADOPTION`.

**Cause.** Adoption proves structural equivalence between the live catalog and the generated baseline *before* recording history. It rejects drift (`MISSING`, `DIFFERENT`, `EXTRA_MODELED`), unsupported relation shapes, deferrable constraints, index orderings the model cannot express, row-level security, drifted sequences behind serial shorthand, and desired raw SQL properties that cannot be verified (reported as `UNSUPPORTED_FOR_ADOPTION`). Unmanaged functions and triggers are reported as `UNMANAGED` and preserved — they do not block adoption on their own. A wrong confirmation token exits as `CONFIGURATION` (2), not `UNSUPPORTED`.

**Fix.** Reconcile the database manually so it matches the baseline structurally, then adopt with the exact `<database>/<baseline-id>` confirmation token.

```typescript
import { adoptBaseline, formatMigrationError, MigrationError } from 'blendsdk/codegen';

try {
  const result = await adoptBaseline({
    configPath: './blendsdk.migrations.ts',
    confirmation: 'appdb/20260827090000_initial',
  });
  console.log(result.status); // 'ADOPTED'
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(formatMigrationError(error));
  }
}
```

### Packaging and Import Errors

#### `TS2305: Module '"blendsdk/codegen"' has no exported member 'publishArtifactPair'.`

**Cause.** Only the documented surface is re-exported from `src/index.ts`. Internals such as `publishArtifactPair`, `readMigrationLedger`, `generateInitialMigration`, and `projectPostgreSqlCatalog` exist in the source tree but are not part of the public contract — importing them by name fails at compile time.

**Fix.** Import documented symbols from the package root only.

```typescript
import {
  adoptBaseline,
  defineMigrationConfig,
  formatMigrationError,
  generateBaseline,
  generateMigration,
  getMigrationStatus,
  MigrationError,
  runMigrations,
  validateMigrations,
  type MigrationStatus,
} from 'blendsdk/codegen';

const publicMigrationApi = [
  defineMigrationConfig,
  generateMigration,
  generateBaseline,
  runMigrations,
  getMigrationStatus,
  validateMigrations,
  adoptBaseline,
];

console.log(publicMigrationApi.map(entry => typeof entry));
console.log(MigrationError.name, formatMigrationError.length);
const statuses: MigrationStatus[] = [
  'UP_TO_DATE',
  'PENDING',
  'INVALID_HISTORY',
  'LOCKED',
  'UNKNOWN_OUTCOME',
];
console.log(statuses.join(', '));
```

#### `TS2307: Cannot find module 'blendsdk/codegen'` in a fresh checkout

**Cause.** The package is workspace-internal (`"private": true`) and ships only `dist`. Its `exports` map points at `./dist/index.js` and `./dist/index.d.ts`, so nothing resolves until the package is built. External consumers never install this package directly — it is distributed through the assembled `blendsdk` package.

**Fix.** Build the package (or keep a watch running while developing), and use the umbrella entry for consumption outside the monorepo.

```bash
# In packages/codegen
yarn build     # one-shot tsc build, produces dist/
yarn dev       # tsc --watch while iterating
```

```typescript
// Outside the monorepo, consume the assembled package:
import { runMigrations } from 'blendsdk/codegen';
```

#### `ERR_REQUIRE_ESM` or `TS1479` when consuming from CommonJS

**Symptom.** `Error [ERR_REQUIRE_ESM]: require() of ES Module ... not supported`, or the compiler reports that a CommonJS module cannot import an ECMAScript module.

**Cause.** The package is ESM-only: `"type": "module"`, and the `exports` map defines only an `import` condition (with `types`). There is no `require` entry point.

**Fix.** Consume it as ESM: use `import` syntax and configure TypeScript for Node.js ESM resolution.

```json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2022",
    "strict": true
  }
}
```

```typescript
// Consuming project package.json must be "type": "module"
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();
scope.object({ id: scope.number() }).named('Product');

console.log(await new TypeGenerator().generate(schema));
```

### Test Environment Issues

#### `AggregateError [ECONNREFUSED]: connect ECONNREFUSED 127.0.0.1:5597`

**Symptom.** Database-backed Vitest suites fail immediately while trying to connect to PostgreSQL on port 5597.

**Cause.** The database-backed suites run against a disposable PostgreSQL instance started from `docker/docker-compose${MODE}.yml` on port 5597. `yarn test:fast` assumes that instance is already running; only the full `yarn test` script brings it up and tears it down itself.

**Fix.** Start the database container before the fast suite and inspect its logs if startup fails.

```bash
yarn db:up        # docker-compose up + 5s settle time
yarn test:fast    # run against the running instance
yarn db:logs      # follow postgres-test logs if the suite cannot connect
yarn db:down      # stop and remove the volume (full reset)

# Full run: db:down -> db:up -> test:fast -> db:down, always starting clean
yarn test
```

---

## Debugging Strategies

### 1. Reproduce without external systems first

1. Build the package so `dist/` matches `src/` (`yarn build` in `packages/codegen`). Most "stale behavior" reports are stale build output.
2. Shrink schema problems to a minimal `SchemaContainer` and print the raw generator output.
3. Shrink migration-history problems to an offline check: `runMigrations({ command: 'validate' })` — and the CLI's `validate --offline` — never need a database URL.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();
scope.object({ id: scope.number(), name: scope.string() }).named('Probe');

console.log(await new TypeGenerator().generate(schema));
```

### 2. Read the generator's dumped buffer before believing the error

When Prettier rejects generated source, the complete unformatted buffer is printed immediately *above* the stack trace. Start debugging from that buffer, not from the error object — find the first line that is not valid TypeScript, then trace it back to the schema input (a name or description that produced it).

### 3. Prove generation is deterministic and lineage is intact

1. Run generation twice and check that the second run is a no-op:
   ```bash
   yarn blendsdk migrate generate add-note
   git status --porcelain
   ```
2. For every committed migration, verify the header chain: the first migration's `-- from-snapshot` is `none`, each `-- to-snapshot` equals the next migration's `-- from-snapshot`, and the last `-- to-snapshot` equals the SHA-256 of the committed `schema.snapshot.json`.
3. If a file looks off, restore it from version control instead of editing it — artifacts are immutable by design.

### 4. Inspect the ledger and the advisory lock directly

The runner's state is fully observable in the database. For a stuck or confusing run:

```sql
-- Applied history, in order. `state` is APPLIED or NONTRANSACTIONAL_DIRTY.
SELECT id, checksum, from_snapshot, to_snapshot, state, applied_at, execution_ms
FROM public.blendsdk_migrations
ORDER BY id;

-- Which sessions are (or were) migration runners?
SELECT pid, application_name, state, wait_event_type, query
FROM pg_stat_activity
WHERE datname = current_database()
  AND application_name = 'blendsdk-migrations';
```

Remember the semantics when reading rows: applied history must be the *exact ordered prefix* of local files — a missing, inserted, or reordered row makes every command report `INVALID_HISTORY`.

### 5. Switch on status and kind unions, never on message text

Migration messages are redacted by design (`[REDACTED_DATABASE_URL]`, `[REDACTED]`, no SQL bodies), so they are useless for branching. Use `MigrationStatus` and `MigrationError['kind']`:

```typescript
import {
  formatMigrationError,
  MigrationError,
  runMigrations,
  type MigrationStatus,
} from 'blendsdk/codegen';

function describe(status: MigrationStatus): string {
  switch (status) {
    case 'UP_TO_DATE':
      return 'Nothing to apply.';
    case 'PENDING':
      return 'Migrations are waiting to be applied.';
    case 'INVALID_HISTORY':
      return 'Local history does not match the applied ledger.';
    case 'LOCKED':
      return 'Another migration process holds the database lock.';
    case 'UNKNOWN_OUTCOME':
      return 'A nontransactional migration has an unknown outcome.';
  }
}

try {
  const result = await runMigrations({ command: 'status', configPath: './blendsdk.migrations.ts' });
  console.log(describe(result.status));
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(error.kind, error.exitCode, formatMigrationError(error));
  } else {
    throw error;
  }
}
```

### 6. Diagnose introspection surprises by listing what was seen

Before generation, ask the introspector what it discovered. `introstectConstantTypes()` (the spelling is intentional) returns the relations and columns it found, and a logging `ColumnMapper` shows every column record as it is mapped.

```typescript fragment
const discovered = await introspector.introstectConstantTypes();
for (const [relation, columns] of Object.entries(discovered)) {
  console.log(relation, columns.join(', '));
}
```

If a column appears here but produced `any` in the output, check the `[WARNING]: ... could not be mapped!` line for that column and handle it with a `ColumnMapper`.

### 7. Focus a failing suite with the disposable database up

1. `yarn db:up` to start the test instance.
2. Run a single Vitest file instead of the whole suite:
   ```bash
   yarn vitest run tests/migrations/runner.spec.test.ts --no-file-parallelism
   ```
3. Keep the `--no-file-parallelism` flag from `test:fast` — suites share the disposable PostgreSQL instance, and serial execution keeps diagnostics readable.
4. `yarn db:logs` shows server-side errors; `yarn db:down` resets everything, including the data volume.

### 8. Capture the adoption preview before confirming

Adoption supports an `afterPreview` callback that receives the sanitized target details (host, port, user, database, baseline id) before any authoritative comparison starts. Use it to log exactly what you are about to adopt — and, if you return the confirmation token, to drive adoption from a script.

```typescript fragment
await adoptBaseline(
  { configPath: './blendsdk.migrations.ts' },
  {
    afterPreview: preview => {
      console.log(preview.host, preview.port, preview.user, preview.database, preview.baselineId);
      return `${preview.database}/${preview.baselineId}`;
    },
  }
);
```

---

## Known Pitfalls

- **Exact spelling matters.** The thrown messages contain typos — `does not exit`, `seperate` — and the introspection helper is `introstectConstantTypes`. Grep for the strings exactly as they appear in this document or in the source, or you will not find them.
- **Unnamed roots are silently skipped.** Generators render only named, non-property schema objects. A forgotten `.named(...)` produces empty or partial output with no error — see the "Generator output is empty" entry.
- **`public` disappears from scoped names.** The introspector normalizes the `public` schema to an unnamed scope, so types from `public` carry no prefix while other schemas produce PascalCase-prefixed names (`ApiV1UserRequest`). Two same-named tables in different non-public schemas are kept apart by that prefix.
- **Objects created outside `DatabaseSchema.table()`/`.view()` have no scope.** `getName()` renders `${scope}.${name}` by default, and an unset scope renders literally as `undefined.<name>` in generated DDL.
- **`size()` and `scale()` are void.** They are the only non-chainable `TableColumnSchema` setters; chain-breaking TypeScript errors after them are by design, not a bug.
- **UUID identity is a default, not an identity.** `.identity('v4')`/`.identity('v7')` on a `uuid` column installs a `DEFAULT` function (`uuid_generate_v4()`/`uuid_generate_v7()`, adding the required extension) and returns `void` — do not chain after it, and do not expect `GENERATED ... AS IDENTITY` in the DDL. Later `.generated(...)` and `.identity(...)` calls also silently clear earlier defaults.
- **`primaryKey()` implies `unique()`.** The column helper registers both a primary key and a unique constraint; do not add a redundant `.unique()` on the same column.
- **Prettier formatting uses default options.** Generated source is formatted with `{ parser: 'typescript' }` and nothing else, so output does not follow your project's `.prettierrc`. Run your own formatter afterward if the emitted style must match local conventions.
- **OpenAPI is opt-in everywhere.** A route without `.openapi()` is excluded; an empty `openapi: {}` includes it; registering the same method + path twice silently replaces the first operation. Transformed Zod schemas (`z.string().transform(...)`) are documented by their *input* type, and `secure: true` without `defaultSecurity` produces `"security": []`.
- **Controllers are constructed with mock dependencies.** `addController()` instantiates controllers with empty settings/services objects. Any constructor that touches them fails generation — build routes lazily instead.
- **Migration artifacts are immutable, and pairs move together.** Baselines refuse to run when any snapshot or up file already exists; the snapshot must be committed with its migration. A migration whose `to-snapshot` does not match the committed snapshot is reported as a torn pair with manual recovery guidance.
- **The runner re-validates after waiting for the lock.** Editing — or reformatting — a migration file while another run waits on the advisory lock is detected as `INVALID_HISTORY` once the lock is acquired. Do not touch files during a migration window.
- **Transactional bodies are lexically guarded and fail closed.** Statement-leading transaction control is rejected outright, and unbalanced quotes or unterminated comments are treated as errors rather than passed to PostgreSQL.
- **`UNKNOWN_OUTCOME` is a terminal state, not a bug.** There is no force/fake/repair command by design; recover manually and forward.
- **Adoption is intentionally narrow.** Empty compatible ledgers are allowed, nonempty ones are rejected; unmanaged functions and triggers are reported as `UNMANAGED` and preserved; deferrable constraints, index ordering, row-level security, and drifted sequences block adoption until reconciled.
- **Errors are redacted.** Expect `[REDACTED_DATABASE_URL]` and `password=[REDACTED]` instead of connection details, and never the failing SQL. Add your own logging around migrations when you need the statement text.
- **`validate --offline` never connects.** A passing offline validation says nothing about the live database — run `status` (or a dry-run `up`) when you need applied-history verification.
- **The full `test` script resets the database.** `yarn test` ends with `db:down`, which removes the compose volume; anything you created in the test instance is gone after every full run.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
