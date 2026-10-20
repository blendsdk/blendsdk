> **Package**: `blendsdk/codegen`

# codegen Advanced Patterns

This document covers patterns that combine several `blendsdk/codegen` features into complete workflows. Each pattern states when to use it, shows a complete example, explains the value, and lists the caveats that matter in production.

Every pattern builds on the same package contract:

- **Authoring models are plain builders.** `SchemaContainer` / `SchemaScope` (data shapes) and `DatabaseSchema` (PostgreSQL) hold no I/O; they are inputs to generators.
- **Every generator has a verification path.** `checkClient` verifies the generated client, `validateMigrations({ offline: true })` verifies migration history, and the schema generators are verified by regenerating and comparing bytes.
- **Committed artifacts are compared byte-for-byte**, so generated files are never hand-edited — they are regenerated.
- **Failures are typed and sanitized.** `ClientGenerationError` and `MigrationError` carry a category and, for migrations, a process exit class (`1` operational, `2` usage/configuration). Messages never contain SQL or connection credentials.
- **The packaged commands mirror the APIs.** `blendsdk api generate|check` and `blendsdk migrate <command>` call the same services shown here, so scripts and CLI stay consistent.

---

## Pattern 1 — Contract-first API pipeline with a drift gate

**When to use it.** Your routes live in `blendsdk/webafx` controllers, you commit the OpenAPI document and the generated client to the repository, and CI must fail the moment either artifact falls behind the controllers.

### Example

In a project, one contract file drives `blendsdk api generate` and `blendsdk api check`:

```typescript
// blendsdk.api.ts
import { defineApiContract } from 'blendsdk/codegen';
import { OrdersController } from './src/controllers/orders.controller.js';
import { ProductsController } from './src/controllers/products.controller.js';

export default defineApiContract({
  outputDir: 'src/api-client',
  contractFile: 'api.json',
  controllers: [
    { basePath: '/api/products', controller: ProductsController },
    { basePath: '/api/orders', controller: OrdersController },
  ],
  openapi: {
    title: 'Catalog API',
    version: '1.0.0',
    servers: [{ url: 'https://api.example.com', description: 'Production' }],
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    defaultSecurity: [{ bearerAuth: [] }],
  },
  generator: {
    splitByGroup: true,
    clientName: 'CatalogClient',
    runtimeImport: 'blendsdk/api-client',
  },
});
```

When you need the same pipeline inside your own tooling — a test, a build step, or a release job — build the document and drive generation directly. This script reproduces `generate` and `check` programmatically:

```typescript
// scripts/api-contract.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  checkClient,
  ClientGenerationError,
  formatOpenApiDocument,
  generateClient,
  OpenAPIGenerator,
  type ClientGeneratorOptions,
  type OpenAPIDocument,
} from 'blendsdk/codegen';
import type { RouteDefinition } from 'blendsdk/webafx';

const Product = z.object({ id: z.number(), name: z.string() });

class ProductsController {
  public constructor(_settings: unknown, _services: unknown) {}

  public routes(): RouteDefinition[] {
    return [
      {
        method: 'get',
        path: '/',
        handler: () => undefined,
        openapi: {
          operationId: 'listProducts',
          summary: 'List products',
          tags: ['products'],
          responses: [
            { statusCode: 200, description: 'Product list', schema: z.array(Product) },
          ],
        },
      } as RouteDefinition,
    ];
  }
}

const contractPath = 'api.json';

const generatorOptions: ClientGeneratorOptions = {
  outputDir: 'src/api-client',
  splitByGroup: true,
  clientName: 'CatalogClient',
  runtimeImport: 'blendsdk/api-client',
};

function buildDocument(): OpenAPIDocument {
  return new OpenAPIGenerator({
    title: 'Catalog API',
    version: '1.0.0',
    servers: [{ url: 'https://api.example.com', description: 'Production' }],
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    defaultSecurity: [{ bearerAuth: [] }],
  })
    .addController('/api/products', ProductsController)
    .generate();
}

async function run(action: 'generate' | 'check'): Promise<number> {
  const document = buildDocument();
  const contractText = await formatOpenApiDocument(document);

  try {
    if (action === 'generate') {
      await mkdir(dirname(contractPath), { recursive: true });
      await writeFile(contractPath, contractText, 'utf8');
      const result = await generateClient(document, generatorOptions);
      for (const issue of result.issues) {
        console.log(`${issue.severity.toUpperCase()}: ${issue.message}`);
      }
      console.log(`GENERATED ${contractPath} ${result.files.join(' ')}`);
      return 0;
    }

    const committed = await readFile(contractPath, 'utf8').catch(() => undefined);
    const result = await checkClient(document, generatorOptions);
    const drifted = new Set(result.driftedFiles ?? []);
    if (committed !== contractText) {
      drifted.add(contractPath);
    }
    for (const issue of result.issues.filter(issue => issue.severity === 'error')) {
      console.error(`ERROR: ${issue.message}`);
    }
    if (drifted.size > 0 || result.drifted === true) {
      console.error(`DRIFT: ${[...drifted].sort().join(', ')}`);
      return 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof ClientGenerationError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

process.exitCode = await run(process.argv[2] === 'check' ? 'check' : 'generate');
```

Running the script with `generate` prints the emitted file list, and committing `api.json` plus `src/api-client/` makes the `check` run exit `0`. Every generated file starts with the marker line, and `types.ts` holds the named aliases the client refers to:

```typescript
// Generated by `blendsdk api generate` — do not edit by hand.

export type ProductsListProductsResult = { id: number; name: string }[];
```

### Why this pattern is valuable

The document and the client are rebuilt from the controllers on every run and compared by exact bytes, so there is no window in which they disagree. Because components, paths, and methods are sorted and the output is Prettier-normalized, a change produces a small, reviewable diff instead of a reshuffled file. Duplicate `operationId`s are a hard, named error — the generator refuses to silently overwrite one generated method with another. And because the entry point returns an exit code instead of exiting the process, the same code can run as a CI step, a pre-commit hook, or a Vitest assertion.

### Caveats and performance notes

- Routes opt in with `.openapi()` metadata. A route without it never reaches the document — there is no warning for omission.
- Provide an `operationId` and at least one 2xx response schema per operation. `generate` warns; `check` escalates both to errors. With `strict: true`, `generate` fails too.
- Two operations that resolve to the same group and method name (for example `delete` and `delete_` after reserved-word escaping) throw `ClientGenerationError` naming both locations. Fix the route names, not the generator.
- `outputDir` and `contractFile` are resolved against the configuration file and cannot escape its directory; a traversal is a configuration failure (exit `2`).
- Only files starting with the generated marker are overwritten or pruned. Keep hand-written code out of the generated directory — the next `generate` deletes stale marker files.
- Commit `api.json` and the generated client in the same change, and run `check` before the build in CI.

---

## Pattern 2 — One shape model, two generated artifacts

**When to use it.** The same DTOs must exist as compile-time TypeScript types for the client and as runtime validation for the server. You want one authoring point instead of a hand-maintained pair that drifts.

### Example

Author the shapes once in a factory. The factory matters: the generators record render state on the model objects, so each generation run gets a fresh model.

```typescript
// src/models/customer-shapes.ts
import { SchemaContainer } from 'blendsdk/codegen';

export function buildCustomerShapes(): SchemaContainer {
  const shapes = new SchemaContainer();
  const scope = shapes.scope();

  const address = scope
    .object({
      street: scope.string(),
      city: scope.string(),
      postalCode: scope.string().optional(),
    })
    .named('Address');

  scope
    .object({
      id: scope.number().description('Database identifier'),
      name: scope.string(),
      active: scope.boolean(),
      address: scope.ref(address).nullable(),
    })
    .named('Customer');

  return shapes;
}
```

A generation script renders both artifacts from the factory:

```typescript
// scripts/generate-shapes.ts
import { writeFile } from 'node:fs/promises';
import { TypeGenerator, ZodGenerator } from 'blendsdk/codegen';
import { buildCustomerShapes } from '../src/models/customer-shapes.js';

const types = await new TypeGenerator().generate(buildCustomerShapes());
const validators = await new ZodGenerator().generate(buildCustomerShapes());

await writeFile('src/generated/customer.types.ts', types, 'utf8');
await writeFile('src/generated/customer.validation.ts', validators, 'utf8');
```

`TypeGenerator` renders interfaces with JSDoc provenance for every member — the annotations record which modifiers produced each line:

```typescript
/**
 * @interface
 */
export interface Address {
  /**
   * @memberOf {Address}
   */
  street: string;
  /**
   * @memberOf {Address}
   */
  city: string;
  /**
   * @optional
   * @memberOf {Address}
   */
  postalCode?: string;
}

/**
 * @interface
 */
export interface Customer {
  /**
   * Database identifier
   * @memberOf {Customer}
   */
  id: number;
  /**
   * @memberOf {Customer}
   */
  name: string;
  /**
   * @memberOf {Customer}
   */
  active: boolean;
  /**
   * @nullable
   * @memberOf {Customer}
   */
  address: Address | null;
}
```

`ZodGenerator` renders the matching runtime schemas from the same model:

```typescript
import * as z from 'zod';

export const AddressSchema = z.object({
  street: z.string(),
  city: z.string(),
  postalCode: z.string().optional(),
});

export const CustomerSchema = z.object({
  id: z.number(),
  name: z.string(),
  active: z.boolean(),
  address: AddressSchema.nullable(),
});
```

### Why this pattern is valuable

The type and the validator are two renderings of one model, so the classic bug — the interface says `string` while the validator accepts numbers — cannot happen. The generated JSDoc gives reviewers a direct trace from each emitted member back to the modifier that produced it (`@optional`, `@nullable`, `@array`, `@memberOf {Parent}`), which makes generated files reviewable rather than opaque. Both generators format through Prettier, so the artifacts are stable and diff-friendly.

### Caveats and performance notes

- Build a fresh model for every generation run. The generators mark render state on the model objects, and reusing a container can duplicate the JSDoc annotations the generator appends (`@interface`, `@memberOf`).
- The Zod generator's surface is the intersection of what both sides express: objects, primitives, and references with `partial`, `optional`, and `nullable`. It does not reflect `arrayed` or `recordSet` modifiers, and enum declarations render as their base primitive. Keep array- and enum-heavy shapes in the TypeScript output and validate them explicitly.
- Zod declarations are `const`s in model creation order. A shape that references another must be declared after it; author references to shapes you created earlier.
- Keep references as object members (the common case). A standalone named top-level `scope.ref(...)` has no meaningful Zod declaration.
- These generators normalize with Prettier's default options (double quotes, 80-column width), which differs from the client generator's repository style. Do not "fix" generated files by hand — regenerate.

---

## Pattern 3 — Database-first types and column constants from one introspection pass

**When to use it.** You have an existing PostgreSQL database and want typed access without hand-writing declarations: TypeScript interfaces plus `UPPER_SNAKE` column constants that remove magic strings from queries.

### Example

The introspector reads through a `PostgreSQLDatabase` from `blendsdk/postgresql`. The `ColumnMapper` is the extension point that overrides the built-in per-type mapping for individual columns:

```typescript
// src/database/introspect-types.ts
import {
  CTypeGenerator,
  PostgreSQLIntrospector,
  SchemaContainer,
  TypeGenerator,
  type ColumnMapper,
} from 'blendsdk/codegen';
import type { PostgreSQLDatabase } from 'blendsdk/postgresql';

export interface DatabaseArtifacts {
  readonly types: string;
  readonly constants: string;
}

export async function generateDatabaseArtifacts(
  database: PostgreSQLDatabase
): Promise<DatabaseArtifacts> {
  const introspector = new PostgreSQLIntrospector(database);
  const schema = new SchemaContainer();
  const scope = schema.scope();

  const settings = scope
    .object({
      theme: scope.string(),
      locale: scope.string(),
    })
    .named('Settings');

  const mapper: ColumnMapper = (column, columnScope) => {
    if (column.pg_type === 'jsonb' && column.column_name === 'settings') {
      return columnScope.ref(settings);
    }
    return undefined;
  };

  await introspector.introspect(schema, mapper);
  const constants = await new CTypeGenerator().generate(
    await introspector.introstectConstantTypes()
  );

  return {
    types: await new TypeGenerator().generate(schema),
    constants,
  };
}
```

Given a table `public.account(id bigint primary key, settings jsonb, created_at timestamptz)` with the comment `Customer accounts`, the type output is (columns are emitted in name order for stable diffs):

```typescript
/**
 * @interface
 */
export interface Settings {
  /**
   * @memberOf {Settings}
   */
  theme: string;
  /**
   * @memberOf {Settings}
   */
  locale: string;
}

/**
 * Customer accounts
 * @primaryKey id
 * @interface
 */
export interface Account {
  /**
   * @optional
   * @nullable
   * @memberOf {Account}
   */
  created_at?: Date | null;
  /**
   * @primaryKey
   * @memberOf {Account}
   */
  id: string;
  /**
   * @optional
   * @nullable
   * @memberOf {Account}
   */
  settings?: Settings | null;
}
```

The constants pass turns the same metadata into relation constants that keep column names out of query strings:

```typescript
/**
 * Constant type for relation account
 * @export
 * @constant
 */
export const eAccount = {
  $TABLE: "account",
  CREATED_AT: "created_at",
  ID: "id",
  SETTINGS: "settings",
};
```

### Why this pattern is valuable

Introspection reads the catalog once and produces code, so a database that predates your TypeScript project still gets typed access with no hand-written declarations. The mapper is the documented escape hatch for the types the built-in mapping cannot know — an unmapped type falls back to a permissive schema marked `@deprecated` and logs a warning, which makes coverage gaps visible instead of silent. The mappings reflect what the driver actually returns, not what looks nicer: `bigint` and `numeric` become `string` so precision is never lost through a JavaScript number.

### Caveats and performance notes

- Introspection is read-only and never issues DDL, but it does query the target database; point it at a replica if catalog reads during business hours matter.
- The constants method is named `introstectConstantTypes` — match the spelling exactly.
- Return `undefined` from the mapper to fall through to enum detection, then the built-in mapping, then the deprecated fallback.
- Output type names are derived from schema and relation names (`sales.order` becomes `SalesOrder`); `public` is the implicit default schema.
- The generated file is a snapshot of the database at generation time. Regenerate when the schema changes and review the diff like any other code change.

---

## Pattern 4 — Bootstrap DDL and incremental migrations from one desired-state model

**When to use it.** You want a disposable development database that resets from one file, production migrations that are reviewed like code, and no second source of truth between the two.

### Example

Everything starts from the authored model. The `blendsdk.migrations.ts` file points at this module; the bootstrap script imports it directly:

```typescript
// src/database/schema.ts
import { DatabaseSchema } from 'blendsdk/codegen';

const database = new DatabaseSchema('public');

const customer = database.table('customer');
customer.bigint('id').identity('BY DEFAULT').primaryKey();
customer.text('email').unique();
customer.text('tier').nullable();
customer.timestamptz('created_at').default('now()');

const orderLine = database.table('order_line');
orderLine.bigint('id').identity('BY DEFAULT').primaryKey();
orderLine.bigint('customer_id').references(customer, 'id', 'CASCADE', 'RESTRICT');
orderLine.integer('quantity');
orderLine.timestamptz('created_at').default('now()');

export default database;
```

```typescript
// blendsdk.migrations.ts
import { defineMigrationConfig } from 'blendsdk/codegen';

export default defineMigrationConfig({
  schema: './src/database/schema.ts',
  migrationsDir: './migrations',
  databaseUrlEnv: 'DATABASE_URL',
});
```

The bootstrap script renders re-runnable DDL for a fresh or disposable database. By default it drops what it owns first:

```typescript
// scripts/bootstrap-database.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { PostgreSQLSchemaGenerator } from 'blendsdk/codegen';
import database from '../src/database/schema.js';

const ddl = new PostgreSQLSchemaGenerator(database).generate();
await mkdir('db', { recursive: true });
await writeFile('db/bootstrap.sql', ddl, 'utf8');
console.log(`bootstrap DDL written (${ddl.length} characters)`);
```

The first statements of `db/bootstrap.sql` are:

```sql
DROP TABLE IF EXISTS public.customer CASCADE;
DROP TABLE IF EXISTS public.order_line CASCADE;
CREATE TABLE public.customer (
	id bigint GENERATED BY DEFAULT AS IDENTITY,
	email text NOT NULL,
	tier text,
	created_at timestamptz NOT NULL DEFAULT now()
);
```

For committed history, add the change to the model (here, `customer.text('tier').nullable()`) and generate a migration. Generation is offline — it never connects to a database:

```typescript
// scripts/generate-migration.ts
import { generateMigration } from 'blendsdk/codegen';

const result = await generateMigration({
  name: 'add-customer-tier',
  configPath: './blendsdk.migrations.ts',
});

if (result.status === 'UP_TO_DATE') {
  console.log('Desired state is already committed; nothing to generate.');
} else {
  console.log(`GENERATED ${result.migration?.id ?? ''}`);
  console.log(`changes: ${result.changes.map(change => change.kind).join(', ')}`);
}
```

The published migration is an immutable file with a strict five-line header and explicit snapshot lineage; the next `schema.snapshot.json` is published atomically with it:

```sql
-- blendsdk-migration: 1
-- id: 20260901103000_add-customer-tier
-- transaction: true
-- from-snapshot: 8a41d0c9b7e2f4a6c1d3e5f7091b2a4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e2f4a
-- to-snapshot: 3c6f9b2e5a8d1f4b7e0c3a6d9f2b5e8c1a4d7f0b3e6c9a2d5f8b1e4c7a0d3f6b
ALTER TABLE "public"."customer" ADD COLUMN "tier" text;
```

CI verifies the committed history without a database, using checksums and snapshot lineage:

```typescript
// scripts/verify-migrations.ts
import { validateMigrations } from 'blendsdk/codegen';

const result = await validateMigrations({
  configPath: './blendsdk.migrations.ts',
  offline: true,
});

if (result.status !== 'UP_TO_DATE') {
  console.error(`Migration history failed validation: ${result.status}`);
  process.exitCode = 1;
}
```

When a rename is intended rather than a drop-and-add, declare it so the differ renders `ALTER ... RENAME` instead of blocking on an ambiguous change:

```typescript
const renamed = await generateMigration({
  name: 'rename-customer-to-account',
  configPath: './blendsdk.migrations.ts',
  renameHints: [{ kind: 'table', from: 'public.customer', to: 'public.account' }],
});
```

### Why this pattern is valuable

One typed model drives both the disposable-database reset and the production lineage, so a table can never exist in one world and be missing in the other. The diff classifies every change and only renders what it can prove — targeted `ALTER` statements, never `CASCADE`, never a rebuild-and-copy. Anything it cannot prove (type changes, identity changes, same-name replacements, view replacements) is blocked with guidance instead of guessed at, and destructive statements require explicit `allowDestructive` approval before they are written. The offline validation gate catches hand-edited or torn history in CI, long before a deployment touches a database.

### Caveats and performance notes

- The bootstrap generator emits identifiers as authored; it does not quote table and column names. Author plain lowercase identifiers, or use only the migration pipeline (which quotes every identifier) for names outside that set.
- `generateGrouped()` splits the same output into `schema`, `indexes`, and `views` groups when your tooling applies them in phases; `generate()` with the default `dropBeforeCreate: true` is for disposable databases only.
- Migration names must be lowercase slugs, and identifiers are time-ordered and immutable once committed. Never edit a migration that has been applied.
- A required column addition and `SET NOT NULL` are classified `caution` and blocked; use a staged population strategy. Ambiguous renames need `renameHints`; destructive changes need `allowDestructive: true`.
- Generated migrations are review artifacts. Read them before committing; the next run refuses to proceed if the snapshot and history disagree.

---

## Pattern 5 — Bringing an existing database under migration control without re-running DDL

**When to use it.** A production database already has the right structure and rows, and you need BlendSDK history to start from a recorded baseline — without executing the baseline SQL against it.

### Example

First create the offline baseline: exactly one initial migration plus its canonical snapshot, produced from the authored model. No database connection is opened.

```typescript
// scripts/adopt-existing-database.ts
import {
  adoptBaseline,
  formatMigrationError,
  generateBaseline,
  MigrationError,
  type AdoptionPreview,
} from 'blendsdk/codegen';

const configPath = './blendsdk.migrations.ts';

async function main(): Promise<number> {
  const baseline = await generateBaseline({ name: 'initial', configPath });
  console.log(`GENERATED ${baseline.migration.id} ${baseline.snapshotHash}`);

  try {
    const adoption = await adoptBaseline(
      { configPath },
      {
        afterPreview: (preview: AdoptionPreview): string => {
          console.log(
            `TARGET ${preview.user}@${preview.host}:${preview.port}/${preview.database}`
          );
          for (const item of preview.comparison) {
            console.log(`${item.classification} ${item.identity}`);
          }
          return `${preview.database}/${preview.baselineId}`;
        },
      }
    );
    console.log(`ADOPTED (${adoption.comparison.length} compared objects)`);
    return 0;
  } catch (error) {
    if (error instanceof MigrationError) {
      console.error(formatMigrationError(error));
      return error.exitCode;
    }
    throw error;
  }
}

process.exitCode = await main();
```

Before pointing it at production, verify the baseline against a scratch database with the normal runner — the migration applies like any other:

```typescript
import { runMigrations } from 'blendsdk/codegen';

const applied = await runMigrations({ command: 'up', configPath });
console.log(`${applied.status}: ${applied.migrations.map(migration => migration.id).join(', ')}`);
```

### Why this pattern is valuable

Adoption proves the live catalog is structurally equal to the authored desired state — object by object, with qualified identities — and then records one ledger row. It runs no migration SQL, so existing data is untouched; the comparison is re-proved inside a repeatable-read transaction before the ledger row commits, so a change that sneaks in between preview and confirmation aborts the adoption. The preview is sanitized (host, port, user, database — never credentials), and the exact `<database>/<baseline-id>` confirmation token makes adopting the wrong database or the wrong baseline a configuration error rather than a data incident.

### Caveats and performance notes

- Quiesce application and administrative DDL first; the confirmation token is an attestation that the structure stopped changing. The CLI equivalent requires it too: `blendsdk migrate adopt-baseline --confirm-adoption <database>/<baseline-id>`.
- Only structurally comparable properties adopt. String defaults (including function defaults such as `now()`), check constraints, expression or predicate indexes, and every view are classified `UNSUPPORTED_FOR_ADOPTION` — adoption fails closed rather than accepting a semantic guess. Numeric and boolean literal defaults compare structurally.
- The ledger must be absent or empty, and local history must be exactly one generated baseline whose checksum matches the committed snapshot. Adoption is not a general-purpose import.
- Unmanaged functions, triggers, enums, and domains are reported as `UNMANAGED` and do not block; unsupported relation shapes and desired dependencies on unmanaged types do block.
- `pg` is imported dynamically for this command; install it wherever adoption runs. Credentials only ever come from the configured environment variable (`databaseUrlEnv`).

---

## Pattern 6 — Zero-downtime index rollout through the nontransactional protocol

**When to use it.** A hot table needs a new index, and a plain `CREATE INDEX` (which holds a write lock for the whole build) is not acceptable.

### Example

Continuing the model from Pattern 4, declare the index with the creation-only `concurrent` flag:

```typescript
// src/database/schema.ts
import { DatabaseSchema } from 'blendsdk/codegen';

const database = new DatabaseSchema('public');

const orderLine = database.table('order_line');
orderLine.bigint('id').identity('BY DEFAULT').primaryKey();
orderLine.bigint('customer_id');
orderLine.timestamptz('created_at').default('now()');
orderLine
  .index()
  .indexName('order_line_customer_id_idx')
  .column('customer_id')
  .concurrent();

export default database;
```

Generation detects the concurrent index and marks the whole migration nontransactional — `CREATE INDEX CONCURRENTLY` cannot run inside a transaction:

```sql
-- blendsdk-migration: 1
-- id: 20260902091500_index-order-line-customer
-- transaction: false
-- from-snapshot: 8a41d0c9b7e2f4a6c1d3e5f7091b2a4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e2f4a
-- to-snapshot: 3c6f9b2e5a8d1f4b7e0c3a6d9f2b5e8c1a4d7f0b3e6c9a2d5f8b1e4c7a0d3f6b
CREATE INDEX CONCURRENTLY "order_line_customer_id_idx" ON "public"."order_line" ("customer_id");
```

Apply it and treat an unknown outcome as an incident, never a retry:

```typescript
// scripts/index-order-line-customer.ts
import {
  formatMigrationError,
  generateMigration,
  getMigrationStatus,
  MigrationError,
  runMigrations,
} from 'blendsdk/codegen';

const configPath = './blendsdk.migrations.ts';

const generated = await generateMigration({ name: 'index-order-line-customer', configPath });
if (generated.migration) {
  console.log(`GENERATED ${generated.migration.id} (transactional: ${generated.migration.transactional})`);
}

try {
  const applied = await runMigrations({ command: 'up', configPath });
  console.log(`${applied.status}: ${applied.migrations.map(migration => migration.id).join(', ')}`);
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(formatMigrationError(error));
    if (error.kind === 'UNKNOWN_OUTCOME') {
      const status = await getMigrationStatus({ configPath });
      console.error(`Ledger state: ${status.status}`);
    }
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}
```

### Why this pattern is valuable

The build runs without blocking writes, and the bookkeeping is fail-closed: the runner commits a durable `NONTRANSACTIONAL_DIRTY` marker before dispatching the SQL, then promotes it to `APPLIED` only after the statement succeeds. A lost session after dispatch leaves `UNKNOWN_OUTCOME` — every later `up` or `down` stops until an operator establishes what actually happened. The runner never silently re-executes a statement whose effect is unknown, and the CLI deliberately offers no `force`, `fake`, or `repair` bypass.

### Caveats and performance notes

- Isolate concurrent indexes: one concurrent index makes the entire file nontransactional, so keep such migrations to a single change. A failure then leaves a minimal, well-understood partial state instead of half-applied DDL.
- Raise `statementTimeoutMs` (and keep `lockTimeoutMs` reasonable) for large tables; the defaults (15 minutes statement, 5 seconds lock) may be too small for a large concurrent build.
- If a concurrent build is interrupted, PostgreSQL can leave the index behind in an invalid state. Investigate and repair the database state by hand before continuing — the dirty ledger row stays until the incident is resolved.
- `concurrent` is creation-only; catalog comparison normalizes it out, so it never causes drift on adoption or status checks.
- Concurrent index builds are slower than regular builds. Use the pattern only where write availability matters more than build time.

---

## Pattern 7 — A release step with fail-closed states and stable exit codes

**When to use it.** A deployment job applies migrations. It must never act on an unhealthy history, must be safe to interrupt, and must report failures in a way CI and operators can act on.

### Example

The script validates first, dry-runs to prove order and lock availability, then applies with signal-based cancellation. The library never prints and never exits — the script owns both:

```typescript
// scripts/deploy-migrations.ts
import {
  formatMigrationError,
  MigrationError,
  runMigrations,
  validateMigrations,
} from 'blendsdk/codegen';

const configPath = './blendsdk.migrations.ts';

async function main(): Promise<number> {
  const validation = await validateMigrations({ configPath });
  if (validation.status !== 'UP_TO_DATE' && validation.status !== 'PENDING') {
    console.error(`Migration history is not releasable: ${validation.status}`);
    return 1;
  }

  const dryRun = await runMigrations({ command: 'up', configPath, dryRun: true });
  if (dryRun.status === 'UP_TO_DATE') {
    console.log('No pending migrations.');
    return 0;
  }
  console.log(`Applying ${dryRun.migrations.map(migration => migration.id).join(', ')}`);

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const applied = await runMigrations({
      command: 'up',
      configPath,
      signal: controller.signal,
    });
    console.log(`${applied.status}: ${applied.migrations.map(migration => migration.id).join(', ')}`);
    return 0;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(formatMigrationError(error));
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}
```

Map the observed states to reactions instead of parsing message text:

| Observed value | Where it appears | Meaning | Reaction |
| --- | --- | --- | --- |
| `UP_TO_DATE` | `status`, `validate`, `up`, `down` results | The ledger is the exact ordered prefix of local history; nothing is pending. | Nothing to do. |
| `PENDING` | `status`, `validate`, `up` results | Validated pending files exist. | Apply with `up`, after a dry run. |
| `LOCKED` | `status`/`validate` result; thrown by `up`/`down` | Another session holds the per-database advisory lock. | Wait and retry; never force. |
| `INVALID_HISTORY` | `status`/`validate` result; thrown by mutating commands | A checksum, order, or lineage mismatch between files and ledger. | Stop and investigate; there is no automatic repair. |
| `UNKNOWN_OUTCOME` | `status`/`validate` result; thrown by `up`/`down` | The final ledger row is `NONTRANSACTIONAL_DIRTY`. | Stop; establish the actual database state manually. |
| `ABORTED` (error kind) | thrown when the signal aborts | Cancellation observed at a safe boundary; transactional work rolled back. | Safe to re-run. |
| `CONFIGURATION` (error kind, exit `2`) | thrown by any command | Invalid config or invocation, for example a missing database URL environment variable. | Fix the input and retry. |
| `DATABASE` (error kind, exit `1`) | thrown by `up`/`down` | A SQL or provider failure; the message is sanitized. | Read the message and fix forward. |

### Why this pattern is valuable

Validation happens before any mutation, so a checksum drift or a torn lineage stops the deployment instead of half-applying it. The dry run proves the pending order and that the advisory lock is available — a concurrent deploy fails fast with `LOCKED` rather than queueing. Cancellation is cooperative: the runner asks PostgreSQL to cancel the running statement, a transactional migration rolls back cleanly, and a nontransactional one reports `UNKNOWN_OUTCOME` instead of pretending to know. Everything an operator sees is sanitized by `formatMigrationError` — safe to paste into an incident channel because SQL and credentials are redacted at construction time.

### Caveats and performance notes

- Run one migration process per database. The database-scoped advisory lock serializes runners, but parallel deploy jobs still burn their `lockTimeoutMs` waiting.
- Tune `lockTimeoutMs` and `statementTimeoutMs` in `blendsdk.migrations.ts` to the deployment: a short lock timeout for fast failure, a generous statement timeout for large builds.
- Cancellation is best-effort after dispatch. Acknowledge signals only where the operation is safe to abandon; the runner's own boundary handling decides between `ABORTED` and `UNKNOWN_OUTCOME`.
- Do not import `runMigrations` into a long-lived request process. It creates and closes its own pool per call; this is a job-level operation.
- Keep the database URL only in the configured environment variable. Nothing in the result objects or error messages carries it.

---

## Pattern 8 — Grouped clients for large API surfaces

**When to use it.** The API has grown to dozens of operations and one generated client file has become unreviewable. You want the client split along its resource boundaries, with drift reported per file.

### Example

Enable `splitByGroup` and name the client. Each group becomes its own file, plus a barrel that keeps call sites stable:

```typescript
import {
  checkClient,
  generateClient,
  type ClientGeneratorOptions,
} from 'blendsdk/codegen';
import type { OpenAPIDocument } from 'blendsdk/codegen';

declare const document: OpenAPIDocument;

const options: ClientGeneratorOptions = {
  outputDir: 'src/api-client',
  splitByGroup: true,
  clientName: 'CatalogClient',
  strict: true,
  runtimeImport: 'blendsdk/api-client',
};

const generated = await generateClient(document, options);
console.log(generated.files.join('\n'));

const checked = await checkClient(document, options);
if (checked.drifted === true) {
  for (const file of checked.driftedFiles ?? []) {
    console.log(`drifted: ${file}`);
  }
  process.exitCode = 1;
}
```

For a document with `products` and `orders` groups, `generate` writes a sorted, pruned set:

```
client.orders.ts
client.products.ts
client.ts
index.ts
types.ts
```

The barrel is generated in the same run and is what application code imports:

```typescript
// Generated by `blendsdk api generate` — do not edit by hand.

import { createApiClient, type ApiClientOptions } from 'blendsdk/api-client';
import { createOrdersClient, type OrdersClient } from './client.orders.js';
import { createProductsClient, type ProductsClient } from './client.products.js';

export interface CatalogClient {
  orders: OrdersClient;
  products: ProductsClient;
}

export function createCatalogClient(options: ApiClientOptions): CatalogClient {
  const runtime = createApiClient(options);
  return {
    orders: createOrdersClient(runtime),
    products: createProductsClient(runtime),
  };
}
```

Call sites keep their shape — `client.products.listProducts(...)` — while each group's deep import stays small enough to review.

### Why this pattern is valuable

Grouping follows the contract's own boundaries (the first tag, or the first path segment after `/api`), so the generated file layout mirrors how the API is discussed. A change to one resource produces a diff in one group file plus the shared `types.ts` — reviewers see the blast radius immediately, and `driftedFiles` names exactly which files are stale. Renaming or deleting a tag removes the old group file automatically, because only marker-bearing files are pruned; hand-written files in the same directory are never touched. The barrel keeps consumers decoupled from the file-level layout.

### Caveats and performance notes

- A tag rename is a file rename: the old `client.<group>.ts` is pruned and a new one appears in the same commit. Treat it as an API change and update call sites together.
- Drift is reported per file, not per line. Use the generator's deterministic ordering and Prettier normalization to keep diffs small so the per-file granularity is actionable.
- `clientName` changes the barrel interface and factory name (`CatalogClient`, `createCatalogClient`) across files; coordinate the rename with consumers.
- The generated code imports the runtime module (`blendsdk/api-client` by default, overridable with `runtimeImport`). That module must be installed wherever the generated client compiles or runs.
- `strict: true` makes local `generate` fail on the same contract problems that CI's `check` treats as errors, so drift never reaches the gate.

---

## Pattern Selection Guide

| Goal | Pattern | Primary APIs |
| --- | --- | --- |
| Keep the committed contract and client in step with controllers | 1, 8 | `OpenAPIGenerator`, `generateClient`, `checkClient`, `defineApiContract` |
| Generate DTO types and runtime validation from one shape model | 2 | `SchemaContainer`, `TypeGenerator`, `ZodGenerator` |
| Produce types and column constants for an existing database | 3 | `PostgreSQLIntrospector`, `ColumnMapper`, `CTypeGenerator` |
| Bootstrap disposable databases and ship incremental migrations from one model | 4 | `DatabaseSchema`, `PostgreSQLSchemaGenerator`, `generateMigration`, `validateMigrations` |
| Bring an existing database under migration control without re-running DDL | 5 | `generateBaseline`, `adoptBaseline` |
| Add indexes on hot tables without blocking writes | 6 | `IndexConstraint.concurrent`, `generateMigration`, `runMigrations` |
| Deploy migrations with fail-closed states and stable exit codes | 7 | `runMigrations`, `getMigrationStatus`, `MigrationError`, `formatMigrationError` |
| Make a large generated client reviewable | 8 | `splitByGroup`, `clientName`, `driftedFiles` |

The patterns compose. A typical mature setup uses Pattern 4 for the database workflow, Pattern 1 (or 8) for the API contract, Pattern 3 for any database whose types are consumed outside the migration model, and Pattern 7 as the deployment entry point — with `checkClient` and `validateMigrations({ offline: true })` as the two CI gates that protect every committed artifact.

---

# codegen Common Scenarios

Task-oriented answers to the questions that come up most often when working with `blendsdk/codegen`. Each scenario is self-contained — every example includes its imports, and the generated output is shown where it makes the result concrete. The scenarios move from data-shape and code generation up through the OpenAPI contract and the PostgreSQL migration workflow.

---

## How do I generate TypeScript types from a data-shape schema?

**Solution.** Model the shape once with `SchemaContainer` and `SchemaScope` — objects, primitives, references, enums, and modifiers such as `.nullable()`, `.optional()`, `.arrayed()`, and `.partial()` — then pass the container to `TypeGenerator`. The generator returns Prettier-formatted TypeScript, and root declarations carry the `@type` / `@interface` tags it used to render them.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const s = schema.scope();

s.object({
  id: s.number(),
  email: s.string(),
  displayName: s.string().nullable().optional(),
})
  .named('customer');

const source: string = await new TypeGenerator().generate(schema);

console.log(source);
```

The generated source:

```typescript
/**
 * @interface
 */

export interface Customer {
  /**
   * @memberOf {Customer}
   */
  id: number;
  /**
   * @memberOf {Customer}
   */
  email: string;
  /**
   * @optional
   * @nullable
   * @memberOf {Customer}
   */
  displayName?: string | null;
}
```

Scoping with `schema.scope('billing')` prefixes generated names (`BillingCustomer`), which keeps the same shape usable in more than one API version.

---

## How do I generate Zod validation schemas from the same shape?

**Solution.** `ZodGenerator` walks the same `SchemaContainer` and emits matching Zod schemas. It imports Zod itself, appends `.optional()` and `.nullable()` for the same modifiers, and names each schema after the modeled object plus a configurable postfix (default `schema`).

```typescript
import { SchemaContainer, ZodGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const s = schema.scope();

s.object({
  id: s.number(),
  email: s.string(),
  displayName: s.string().nullable().optional(),
})
  .named('customer');

const source: string = await new ZodGenerator().generate(schema);

console.log(source);
```

The generated source:

```typescript
import * as z from "zod";

export const CustomerSchema = z.object({
  id: z.number(),
  email: z.string(),
  displayName: z.string().optional().nullable(),
});
```

Pass `new ZodGenerator({ zodVariablePostfix: 'input' })` when you want request-side names such as `CustomerInput`.

---

## How do I generate relation and column constants?

**Solution.** `CTypeGenerator` turns a `ConstantType` map — the shape `PostgreSQLIntrospector.introstectConstantTypes()` produces from a live database — into one exported constant per relation, with a `$TABLE` marker and one member per column.

```typescript
import { CTypeGenerator, type ConstantType } from 'blendsdk/codegen';

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
  $TABLE: "public.customer",
  ID: "id",
  EMAIL: "email",
};
```

Use the constant instead of raw strings when you build queries: `ePublicCustomer.EMAIL` compiles, a typo does not.

---

## How do I generate PostgreSQL DDL from an authored schema?

**Solution.** Build a `DatabaseSchema` with the fluent table API, then hand it to `PostgreSQLSchemaGenerator`. Use `generateGrouped()` to get deployment-ready parts (`schema`, `indexes`, `views`, and the combined `all`), or `generate()` for the single combined script. Generation never connects to a database.

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator, type GeneratedDDL } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');

const customer = schema.table('customer');
customer.bigint('id').primaryKey();
customer.varchar('email', 255).nullable().unique();
customer.text('display_name').nullable().comment('Shown in the storefront');

customer.index().indexName('customer_email_idx').column('email');

schema
  .view('customer_summary')
  .as('SELECT count(*) AS customers FROM public.customer')
  .comment('One row with the total customer count');

const ddl: GeneratedDDL = new PostgreSQLSchemaGenerator(schema).generateGrouped();

console.log(ddl.schema);
console.log(ddl.indexes);
console.log(ddl.views);
```

The three parts:

```sql
-- ddl.schema
DROP TABLE IF EXISTS public.customer CASCADE;

CREATE TABLE public.customer (
	id bigint NOT NULL,
	email varchar(255),
	display_name text
);

ALTER TABLE public.customer
	ADD CONSTRAINT customer_id_pkey PRIMARY KEY ( id ),
	ADD CONSTRAINT customer_email_unique UNIQUE ( email )
;

COMMENT ON COLUMN public.customer.display_name IS 'Shown in the storefront';

-- ddl.indexes
CREATE INDEX customer_email_idx ON public.customer (email);

-- ddl.views
DROP VIEW IF EXISTS public.customer_summary CASCADE;
CREATE OR REPLACE VIEW public.customer_summary AS SELECT count(*) AS customers FROM public.customer;

COMMENT ON VIEW public.customer_summary IS 'One row with the total customer count';
```

Pass `{ dropBeforeCreate: false }` to omit the leading `DROP` statements, and use `generate()` when you want `ddl.all` directly.

---

## How do I generate an OpenAPI 3.1 document from controller routes?

**Solution.** Create an `OpenAPIGenerator` with your API metadata and security settings, then collect routes — individually with `addRoutes`, or from controllers with `addController`. Only routes that opted in with `.openapi()` metadata appear in the document, so internal routes stay out of the contract.

```typescript
import { OpenAPIGenerator, type OpenAPIDocument } from 'blendsdk/codegen';
import type { RouteDefinition } from 'blendsdk/webafx';

const productRoutes: RouteDefinition[] = [
  {
    method: 'get',
    path: '/',
    handler: async () => undefined,
    openapi: {
      operationId: 'listProducts',
      tags: ['products'],
      summary: 'List products',
      responses: [
        { statusCode: 200, description: 'The product list.' },
        { statusCode: 401, description: 'Unauthenticated.' },
      ],
    },
  },
  {
    method: 'get',
    path: '/:id',
    secure: true,
    handler: async () => undefined,
    openapi: {
      operationId: 'getProduct',
      tags: ['products'],
      summary: 'Get one product',
      responses: [{ statusCode: 200, description: 'The product.' }],
    },
  },
];

const generator = new OpenAPIGenerator({
  title: 'Catalog API',
  version: '1.0.0',
  servers: [{ url: 'https://api.example.com', description: 'Production' }],
  securitySchemes: {
    bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  },
  defaultSecurity: [{ bearerAuth: [] }],
});

generator.addRoutes('/api/products', productRoutes);

const document: OpenAPIDocument = generator.generate();

console.log(Object.keys(document.paths));
// ['/api/products', '/api/products/{id}']

generator.toFile('openapi.json');
```

`addController('/api/products', ProductsController)` is the usual entry point: the controller is instantiated with empty settings/services and its routes are filtered the same way. Express-style `:id` segments become `{id}`, and routes marked `secure: true` receive `defaultSecurity`.

---

## How do I convert Zod schemas to OpenAPI?

**Solution.** The converter delegates to Zod 4's native `z.toJSONSchema`, so you call `convertZodToJsonSchema` with the correct wire direction (`'input'` for request bodies, `'output'` for responses). For GET/DELETE query objects, `convertZodToQueryParameters` splits the object into one `in: 'query'` parameter per property.

```typescript
import {
  convertZodToJsonSchema,
  convertZodToQueryParameters,
  type OpenAPIParameter,
  type OpenAPISchema,
} from 'blendsdk/codegen';
import { z } from 'zod';

const createProduct = z.object({
  name: z.string(),
  price: z.number(),
  tags: z.array(z.string()).optional(),
  status: z.enum(['draft', 'published']).default('draft'),
});

const bodySchema: OpenAPISchema = convertZodToJsonSchema(createProduct, 'input');

console.log(bodySchema.type); // 'object'
console.log(bodySchema.required); // ['name', 'price']
console.log(bodySchema.properties?.status);
// { type: 'string', enum: ['draft', 'published'], default: 'draft' }

const listQuery = z.object({
  page: z.coerce.number().default(1),
  search: z.string().optional(),
});

const parameters: OpenAPIParameter[] = convertZodToQueryParameters(listQuery);

console.log(JSON.stringify(parameters, null, 2));
```

The query parameters:

```json
[
  {
    "name": "page",
    "in": "query",
    "schema": { "type": "number", "default": 1 }
  },
  {
    "name": "search",
    "in": "query",
    "schema": { "type": "string" }
  }
]
```

Nullable fields become JSON Schema type arrays — `z.string().nullable()` converts to `{ "type": ["string", "null"] }` — which is what OpenAPI 3.1 consumers understand. Reusable schemas declared with `.meta({ id })` land in `components.schemas`.

---

## How do I generate a typed API client from an OpenAPI document?

**Solution.** `generateClient` reads an OpenAPI 3.1 document and writes a typed client whose methods mirror the server's operations. The output is deterministic: components and operations are sorted, files are Prettier-normalized, and stale generated files (identified by the marker comment) are pruned while hand-written files are left untouched.

```typescript
import { generateClient, type GenerationResult, type OpenAPIDocument } from 'blendsdk/codegen';

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
            description: 'The product list.',
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

const result: GenerationResult = await generateClient(document, {
  outputDir: 'src/api-client',
  runtimeImport: 'blendsdk/api-client',
});

console.log(result.files); // ['client.ts', 'index.ts', 'types.ts']
console.log(result.issues); // warnings for contract problems, if any
```

The interesting lines of `types.ts`:

```typescript fragment
export type Product = { id: number; name: string };
export type ProductsListProductsResult = Product[];
```

A missing `operationId` or a 2xx response without a schema becomes a `warning` (and a deterministic fallback method name). Two operations sharing an `operationId` throw a `ClientGenerationError` instead — fix the source route rather than the generated file.

---

## How do I split the generated client by group and fail CI on drift?

**Solution.** Set `splitByGroup: true` to emit one `client.<group>.ts` per tag (or first path segment) plus a `client.ts` barrel, and use `checkClient` to regenerate everything in memory and compare it against the committed files. `checkClient` never writes; it reports the drifted file names so your CI job can print them and exit non-zero.

```typescript
import {
  checkClient,
  generateClient,
  type ClientGeneratorOptions,
  type GenerationResult,
  type OpenAPIDocument,
} from 'blendsdk/codegen';

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
            description: 'The product list.',
            content: {
              'application/json': { schema: { type: 'array', items: { type: 'string' } } },
            },
          },
        },
      },
    },
    '/api/orders': {
      get: {
        operationId: 'listOrders',
        tags: ['orders'],
        responses: {
          '200': {
            description: 'The order list.',
            content: {
              'application/json': { schema: { type: 'array', items: { type: 'string' } } },
            },
          },
        },
      },
    },
  },
};

const options: ClientGeneratorOptions = {
  outputDir: 'src/api-client',
  splitByGroup: true,
  strict: true,
  clientName: 'CatalogClient',
};

const written: GenerationResult = await generateClient(document, options);

// ['client.orders.ts', 'client.products.ts', 'client.ts', 'index.ts', 'types.ts']
console.log(written.files);

const drift: GenerationResult = await checkClient(document, options);

if (drift.drifted) {
  console.error(`Contract drift: ${(drift.driftedFiles ?? []).join(', ')}`);
  process.exitCode = 1;
}
```

`generateClient` warns about contract problems by default; `strict: true` makes it fail instead. `checkClient` always escalates warnings to errors, so a missing `operationId` fails the gate even though generation would still succeed. When a group disappears from the contract, its `client.<group>.ts` file is pruned automatically.

---

## How do I define the `blendsdk.api.ts` contract and run the API drift gate?

**Solution.** Author one default-exported contract with `defineApiContract` — controllers, artifact locations, OpenAPI metadata, and generator flags. The `blendsdk api` commands discover the file by searching upward from the current directory (stopping at the repository root) or via `--config`.

```typescript
// blendsdk.api.ts
import { defineApiContract } from 'blendsdk/codegen';
import { ProductsController } from './controllers/products.controller.js';

export default defineApiContract({
  outputDir: 'src/api-client',
  contractFile: 'api.json',
  controllers: [{ basePath: '/api/products', controller: ProductsController }],
  openapi: {
    title: 'Catalog API',
    version: '1.0.0',
    servers: [{ url: 'https://api.example.com', description: 'Production' }],
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    defaultSecurity: [{ bearerAuth: [] }],
  },
  generator: {
    splitByGroup: true,
    strict: true,
    clientName: 'CatalogClient',
    runtimeImport: 'blendsdk/api-client',
  },
});
```

```bash
# Rebuild api.json and the typed client from the controllers.
blendsdk api generate

# CI drift gate: rebuild in memory and fail if either artifact differs.
blendsdk api check

# Point at a non-conventional config location.
blendsdk api check --config ./packages/catalog/blendsdk.api.ts
```

`outputDir` and `contractFile` resolve relative to the config file and must not escape its directory. Exit codes:

| Exit code | Meaning |
| --- | --- |
| `0` | The artifacts are current (or were written successfully). |
| `1` | Drift detected, or an operational failure occurred; the drifted file names are printed. |
| `2` | Usage or configuration failure (missing/invalid config, bad arguments). |

---

## How do I generate TypeScript types for an existing PostgreSQL database?

**Solution.** `PostgreSQLIntrospector` reads the live catalog — tables, views, enums, composite and domain types — into a `SchemaContainer`, and `TypeGenerator` renders TypeScript from it. A `ColumnMapper` lets you override any column that the built-in type mapping cannot express.

```typescript
import {
  PostgreSQLIntrospector,
  SchemaContainer,
  TypeGenerator,
  type ColumnMapper,
} from 'blendsdk/codegen';
import type { PostgreSQLDatabase } from 'blendsdk/postgresql';

export async function generateTypesForDatabase(database: PostgreSQLDatabase): Promise<string> {
  const mapColumns: ColumnMapper = (column, scope) => {
    if (column.pg_type === 'jsonb') {
      return scope.any();
    }
    return undefined;
  };

  const schema = new SchemaContainer();
  const introspector = new PostgreSQLIntrospector(database);

  await introspector.introspect(schema, mapColumns);

  return new TypeGenerator().generate(schema);
}
```

Return `undefined` from the mapper for columns you do not want to override. Columns with no mapping and no override fall back to a placeholder type annotated `@deprecated` so the gap is visible in the generated output. The same introspector exposes `introstectConstantTypes()`, whose result feeds directly into `CTypeGenerator`.

---

## How do I configure PostgreSQL migrations and generate one?

**Solution.** Author a `blendsdk.migrations.ts` file with `defineMigrationConfig` — it points at the desired-schema module and the artifact locations — then call `generateMigration`. Generation is offline: it compares the committed snapshot with your schema module and publishes the reviewed `.up.sql` file and the next `schema.snapshot.json` atomically.

```typescript
// blendsdk.migrations.ts
import { defineMigrationConfig } from 'blendsdk/codegen';

export default defineMigrationConfig({
  schema: './src/database/schema.ts',
  migrationsDir: './migrations',
  databaseUrlEnv: 'DATABASE_URL',
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 900_000,
});
```

```typescript
import { generateMigration, type GenerateMigrationResult } from 'blendsdk/codegen';

const result: GenerateMigrationResult = await generateMigration({ name: 'add-customer-email' });

if (result.status === 'GENERATED') {
  console.log(`Wrote ${result.migration?.id}.up.sql`);
} else {
  console.log('Desired schema already matches the committed snapshot.');
}
```

The schema module referenced by `schema` is the same `DatabaseSchema` built for DDL generation. The equivalent CLI command is `blendsdk migrate generate add-customer-email`. When nothing changed, the command reports `UP_TO_DATE` and rewrites nothing.

---

## How do I rename a table or column without dropping data?

**Solution.** Names alone cannot prove intent, so supply explicit one-to-one `renameHints`. The differ then emits `ALTER TABLE ... RENAME` statements instead of a drop plus a create, and all subsequent column and constraint changes target the post-rename name.

```typescript
import { generateMigration, type GenerateMigrationResult, type RenameHint } from 'blendsdk/codegen';

const renameHints: RenameHint[] = [
  { kind: 'table', from: 'public.customer', to: 'public.account' },
  { kind: 'column', from: 'public.customer.name', to: 'public.account.display_name' },
];

const result: GenerateMigrationResult = await generateMigration({
  name: 'rename-customer-to-account',
  renameHints,
});

for (const change of result.changes) {
  console.log(`${change.safety} ${change.kind} ${change.name ?? ''}`);
}
```

Without hints, an apparent rename is classified as `ambiguous` and generation refuses with guidance. Hints must reference a prior identity and a desired identity, be one-to-one, acyclic, and within one schema — cross-schema renames require reviewed manual SQL.

---

## How do I approve a reviewed destructive change?

**Solution.** Passing `allowDestructive: true` to `generateMigration` permits only the specific removals the diff already classified as `destructive` — for example dropping a column or table. Every destructive statement is emitted with a conspicuous approval marker so the reviewer sees it in the diff.

```typescript
import { generateMigration, type GenerateMigrationResult } from 'blendsdk/codegen';

const result: GenerateMigrationResult = await generateMigration({
  name: 'drop-legacy-column',
  allowDestructive: true,
});

for (const change of result.changes) {
  console.log(`${change.safety} ${change.kind} ${change.name ?? ''}`);
}
```

Without the flag, the same generation throws a `MigrationError` with guidance and writes nothing — the snapshot and migration directory remain byte-identical. Changes classified `caution` (such as adding a required column) or `unsupported` (type changes, identity transitions, view rewrites) are never auto-approved: write those by hand and commit them with `blendsdk migrate create <name>`.

---

## How do I apply migrations and inspect status?

**Solution.** `runMigrations` applies pending `.up.sql` files under a per-database advisory lock with strict checksum verification; `getMigrationStatus` and `validateMigrations` observe without mutating. Use `dryRun` to preview order (it still proves lock availability), and `offline: true` to validate local files in CI without a database URL.

```typescript
import {
  getMigrationStatus,
  runMigrations,
  validateMigrations,
  type MigrationCommandResult,
} from 'blendsdk/codegen';

// Preview what would run, without touching the database.
const preview: MigrationCommandResult = await runMigrations({ command: 'up', dryRun: true });
console.log(preview.status); // 'PENDING'
console.log(preview.migrations.map(migration => migration.id));

// Apply pending migrations.
const applied: MigrationCommandResult = await runMigrations({ command: 'up' });
console.log(applied.status); // 'UP_TO_DATE'

// Read status without mutating anything.
const status: MigrationCommandResult = await getMigrationStatus();
console.log(status.status);

// Validate local files and lineage only — no database URL required.
const validation: MigrationCommandResult = await validateMigrations({ offline: true });
console.log(validation.status);

// Revert exactly the latest applied migration (needs a down file).
await runMigrations({ command: 'down', allowDown: true });
```

Terminal statuses you can branch on:

| Status | Meaning |
| --- | --- |
| `UP_TO_DATE` | Every local migration is applied. |
| `PENDING` | Local migrations exist that are not applied yet. |
| `INVALID_HISTORY` | A checksum, order, or lineage mismatch — fail closed and investigate. |
| `LOCKED` | Another session holds the migration advisory lock. |
| `UNKNOWN_OUTCOME` | A nontransactional migration was dispatched but its result could not be confirmed. |

---

## How do I create the first migration for a new project?

**Solution.** `generateBaseline` creates exactly one initial migration plus the canonical snapshot, and refuses if any snapshot or up-migration history already exists. It never opens a database connection — the baseline is applied later by the normal runner.

```typescript
import { generateBaseline, type GenerateBaselineResult } from 'blendsdk/codegen';

const result: GenerateBaselineResult = await generateBaseline({ name: 'initial' });

console.log(result.status); // 'GENERATED'
console.log(result.migration.id); // e.g. '20260827090000_initial'
console.log(result.snapshotHash); // SHA-256 of the published schema.snapshot.json
```

The command writes `migrations/<timestamp>_initial.up.sql` and `migrations/schema.snapshot.json`; the migration carries a `none` from-snapshot and the new hash as its target. Apply it with `runMigrations({ command: 'up' })` or `blendsdk migrate baseline initial` followed by `blendsdk migrate up`.

---

## How do I bring an existing database under migration control?

**Solution.** `adoptBaseline` proves that the live catalog structurally matches a locally generated baseline and then records the lineage — without executing the baseline SQL, so existing data is preserved. It shows a sanitized target preview first and requires an exact `<database>/<baseline-id>` DDL-quiescence confirmation before the ledger transaction begins.

```typescript
import { adoptBaseline, type AdoptBaselineResult, type AdoptionPreview } from 'blendsdk/codegen';

const result: AdoptBaselineResult = await adoptBaseline(
  {},
  {
    afterPreview: (preview: AdoptionPreview): string => {
      console.log(`Target ${preview.user}@${preview.host}:${preview.port}/${preview.database}`);
      console.log(`Baseline ${preview.baselineId}`);
      for (const item of preview.comparison) {
        console.log(`${item.classification} ${item.identity}`);
      }
      // Return the confirmation token that binds the adoption to this target.
      return `${preview.database}/${preview.baselineId}`;
    },
  }
);

console.log(result.status); // 'ADOPTED'
```

Adoption requires exactly one locally valid baseline migration matched to the canonical snapshot, an absent or empty migration ledger, and a catalog where every modeled object is a `MATCH` (unmanaged functions, triggers, and enums are reported as informational `UNMANAGED`). If anything differs, the operation stops with a qualified mismatch and changes nothing.

---

## How do I report migration failures safely?

**Solution.** Every expected failure is a typed `MigrationError` with a stable `kind` and a process exit class; `formatMigrationError` renders it without leaking SQL, credentials, or connection URLs (they are redacted at construction time).

```typescript
import { formatMigrationError, MigrationError, runMigrations } from 'blendsdk/codegen';

try {
  await runMigrations({ command: 'up' });
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(formatMigrationError(error));
    console.error(`Exit code: ${error.exitCode}`);
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}
```

Handle failures by `kind`, not by message text: `CONFIGURATION` and `INVALID_HISTORY` usually mean fix the config or the committed files, `LOCKED` means retry later, and `UNKNOWN_OUTCOME` means investigate the last migration manually before attempting any further mutation.

---

# codegen Examples Library

This document is a categorized, copy-paste ready tour of `blendsdk/codegen`. Every TypeScript example is a complete ES module that imports only public symbols from the package root and shows its expected output where the result is deterministic. Shell examples run in a project that has the `blendsdk` package installed. Database-backed examples read the connection URL from the environment variable configured for migrations (`DATABASE_URL` by default) and need the optional `pg` driver.

---

## Data-Shape Modeling

### Create an object shape with primitives and modifiers

Model a record with the fluent schema API; modifiers mark members optional, nullable, or repeated.

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
    addedAt: scope.date(),
  })
  .named('Product');

console.log(product.getName()); // Product
console.log(Object.keys(product.getProperties()).join(', '));
// id, name, tags, nickname, addedAt
```

---

### Share shapes with references and enums

References reuse one named shape in several places, and `enum()` narrows a primitive to a literal union.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

const status = scope.string().named('Status').enum(['draft', 'published', 'archived']);

const article = scope
  .object({
    id: scope.number(),
    status: scope.ref(status),
    history: scope.ref(status).arrayed(),
  })
  .named('Article');

const source = await new TypeGenerator().generate(schema);
console.log(source);
```

Generated source (JSDoc annotations omitted for brevity):

```typescript
export type Status = "draft" | "published" | "archived";

export interface Article {
  id: number;
  status: Status;
  history: Status[];
}
```

---

### Version models with scopes

A scope namespaces shapes so `api_v1` and `api_v2` can both define a `user_request` shape; using the same name twice in one scope throws.

```typescript
import { SchemaContainer } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

const user = scope
  .object({
    username: scope.string(),
    password: scope.string(),
  })
  .named('user');

const apiV1 = schema.scope('api_v1');
apiV1.object({ user: scope.ref(user).nullable() }).named('user_request');

const apiV2 = schema.scope('api_v2');
apiV2.object({ user: scope.ref(user) }).named('user_request');

console.log(
  schema
    .getAll()
    .filter(object => object.getName() === 'user_request')
    .map(object => object.getNamedScoped())
    .join(', ')
);
// api_v1.user_request, api_v2.user_request
```

---

## Type and Validation Generation

### Generate TypeScript types

`TypeGenerator` turns a schema container into a formatted TypeScript module. Every declaration and member carries JSDoc annotations for editor tooling.

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
  .named('User');

const source = await new TypeGenerator().generate(schema);
console.log(source);
```

Generated source:

```typescript
/**
 * @interface
 */
export interface User {
  /**
   * @memberOf {User}
   */
  id: number;
  /**
   * @memberOf {User}
   */
  name: string;
  /**
   * @array
   * @memberOf {User}
   */
  tags: string[];
  /**
   * @optional
   * @nullable
   * @memberOf {User}
   */
  nickname?: string | null;
}
```

---

### Interfaces, type aliases, and nested objects

Plain objects become `interface` declarations; partials, arrays, nullable types, and nested objects become `type` aliases with the matching wrapper.

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
    id: scope.number(),
    address: scope.object({
      street: scope.string(),
      city: scope.string(),
    }),
    previous: scope.ref(address).partial().arrayed(),
  })
  .named('Customer');

const source = await new TypeGenerator().generate(schema);
console.log(source);
```

Generated source (JSDoc annotations omitted for brevity):

```typescript
export interface Address {
  street: string;
  city: string;
}

export interface Customer {
  id: number;
  address: {
    street: string;
    city: string;
  };
  previous: Partial<Address>[];
}
```

---

### Generate Zod schemas

`ZodGenerator` emits a matching Zod module, so the same schema drives runtime validation. The output always starts with `import * as z from 'zod';`.

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
  .named('user');

const source = await new ZodGenerator().generate(schema);
console.log(source);
```

Generated source (the variable name is the PascalCase shape name plus the `schema` postfix):

```typescript
import * as z from 'zod';

export const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
  nickname: z.string().optional().nullable(),
});
```

---

### Generate relation constants

`CTypeGenerator` turns a relation-to-columns map into `$TABLE`/column constant objects, the conventional way to reference table and column names in queries.

```typescript
import { CTypeGenerator } from 'blendsdk/codegen';
import type { ConstantType } from 'blendsdk/codegen';

const constants: ConstantType = {
  'public.customer': ['id', 'email', 'created_at'],
  'reporting.order_summary': ['id', 'total'],
};

const source = await new CTypeGenerator().generate(constants);
console.log(source);
```

Generated source:

```typescript
/**
 * Constant type for relation public.customer
 * @export
 * @constant
 */
export const ePublicCustomer = {
  $TABLE: "public.customer",
  ID: "id",
  EMAIL: "email",
  CREATED_AT: "created_at",
};

/**
 * Constant type for relation reporting.order_summary
 * @export
 * @constant
 */
export const eReportingOrderSummary = {
  $TABLE: "reporting.order_summary",
  ID: "id",
  TOTAL: "total",
};
```

---

## PostgreSQL Schema Modeling

### Define tables and columns

`DatabaseSchema` is the desired-state model. Column helpers cover the supported PostgreSQL types; `default(value, quote?)` renders a raw expression or a quoted string literal.

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const database = new DatabaseSchema('store');

const customer = database.table('customer');
customer.bigint('id').primaryKey();
customer.varchar('email', 255).unique();
customer.varchar('status', 20).default('new', true);
customer.boolean('active').default(true);
customer.timestamptz('created_at', 6).default('now()');
customer.text('note').nullable();

console.log(customer.getColumns().map(column => column.getName()).join(', '));
// id, email, status, active, created_at, note
console.log(customer.findColumn('status')?.getDefault());
// 'new'
```

---

### Declare constraints and foreign keys

Foreign keys are declared from the column with `references(table, column, onUpdate?, onDelete?)`; unique and check constraints are declared on the table.

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const database = new DatabaseSchema('store');

const customer = database.table('customer');
customer.bigint('id').primaryKey();
customer.varchar('email', 255).unique();

const order = database.table('order');
order.bigint('id').primaryKey();
order.bigint('customer_id').references(customer, 'id', 'NO ACTION', 'CASCADE');
order.integer('quantity').default(1);
order.timestamptz('placed_at').default('now()');
order.checkConstraint('quantity > 0');
order.uniqueConstraint().column('customer_id', 'placed_at');

console.log(order.getForeignKeyConstrains().length); // 1
console.log(order.getUniqueConstraints()[0]?.getColumns().map(column => column.getName()).join(', '));
// customer_id, placed_at
```

---

### Create indexes

Indexes support unique and concurrent creation, access methods, partial predicates, expressions, `INCLUDE` columns, storage parameters, and tablespaces.

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const database = new DatabaseSchema('store');

const product = database.table('product');
product.bigint('id').primaryKey();
product.text('sku');
product.jsonb('attributes');
product.timestamptz('created_at');

product.index().indexName('product_sku_key').column('sku').unique();
product.index().indexName('product_attributes_gin').column('attributes').using('gin');
product.index().indexName('product_created_idx').column('created_at').where('created_at IS NOT NULL');
product.index().indexName('product_sku_lower_idx').expression('lower(sku)');
product.index().indexName('product_covering_idx').column('created_at').include('sku').with({
  fillfactor: 90,
});

console.log(product.getIndexes().map(index => index.getIndexName()).join(', '));
// product_sku_key, product_attributes_gin, product_created_idx, product_sku_lower_idx, product_covering_idx
```

---

### Use identity and generated columns

Integer identity columns render `GENERATED ... AS IDENTITY` with optional sequence settings. UUID columns accept `'v4'`, `'v7'`, or a custom function and register the extension they need. Generated columns compute their value from an expression and are always `STORED`.

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const database = new DatabaseSchema('store');

const invoice = database.table('invoice');
invoice.bigint('id').identity('ALWAYS', { start: 1000 });
invoice.uuid('public_id').identity('v7');

const line = database.table('invoice_line');
line.bigint('id').primaryKey();
line.numeric('quantity', 10, 2);
line.numeric('unit_price', 10, 2);
line.numeric('total', 12, 2).generated('quantity * unit_price');

console.log(invoice.findColumn('id')?.isIdentity()); // true
console.log(invoice.findColumn('public_id')?.getDefault()); // uuid_generate_v7()
console.log(line.findColumn('total')?.getGeneratedExpression()); // quantity * unit_price
console.log(database.getExtensions().join(', ')); // pg_uuidv7
```

---

### Add views and extensions

Regular and materialized views carry their source SQL verbatim; extensions are emitted once, ahead of every other statement.

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const database = new DatabaseSchema('store');
database.extension('pgcrypto');

const order = database.table('order');
order.bigint('id').primaryKey();
order.numeric('total', 12, 2).default(0);

const summary = database.view('order_summary');
summary.scope('reporting');
summary.as('SELECT id, total FROM public."order"');
summary.comment('One row per order with its total.');

const totals = database.view('order_totals');
totals.scope('reporting');
totals.materialized(true);
totals.as('SELECT sum(total) AS grand_total FROM public."order"');

console.log(database.getViews().map(view => `${view.getName()}:${view.isMaterialized()}`).join(', '));
// reporting.order_summary:false, reporting.order_totals:true
console.log(database.getExtensions().join(', ')); // pgcrypto
```

---

## PostgreSQL DDL Generation

### Generate bootstrap DDL

`PostgreSQLSchemaGenerator` renders re-runnable bootstrap SQL for a fresh database. `generateGrouped()` splits the output into `schema`, `indexes`, and `views` sections; `generate()` returns everything as one string.

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const database = new DatabaseSchema('store');

const customer = database.table('customer');
customer.bigint('id').primaryKey();
customer.varchar('email', 255).unique();
customer.varchar('status', 20).default('new', true);
customer.boolean('active').default(true);

const generator = new PostgreSQLSchemaGenerator(database);

const grouped = generator.generateGrouped();
console.log(Object.keys(grouped).join(', ')); // schema, indexes, views, all

const ddl = generator.generate();
console.log(ddl);
```

Generated DDL (whitespace normalized for readability):

```sql
DROP TABLE IF EXISTS public.customer CASCADE;

CREATE TABLE public.customer (
	id bigint NOT NULL,
	email varchar(255) NOT NULL,
	status varchar(20) NOT NULL DEFAULT 'new',
	active boolean NOT NULL DEFAULT true
);

ALTER TABLE public.customer
	ADD CONSTRAINT customer_id_pkey PRIMARY KEY (id),
	ADD CONSTRAINT customer_email_unique UNIQUE (email);
```

Bootstrap DDL drops before it creates. For incremental, reviewable changes use migrations instead.

---

## OpenAPI Document Generation

### Generate a document from a controller

`OpenAPIGenerator` instantiates each controller and collects only the routes that opted in with `.openapi()` metadata. Zod validation schemas become request bodies and query parameters, and `secure: true` routes receive the configured default security.

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
        handler: () => undefined,
        validation: z.object({ page: z.coerce.number().default(1) }),
        secure: true,
        openapi: {
          summary: 'List products',
          operationId: 'listProducts',
          tags: ['products'],
          responses: [
            {
              statusCode: 200,
              description: 'OK',
              schema: z.array(z.object({ id: z.number(), name: z.string() })),
            },
          ],
        },
      },
    ];
  }
}

const generator = new OpenAPIGenerator({
  title: 'Products API',
  version: '1.0.0',
  servers: [{ url: 'https://api.example.com', description: 'Production' }],
  securitySchemes: {
    bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  },
  defaultSecurity: [{ bearerAuth: [] }],
});

generator.addController('/api/products', ProductsController);

const document = generator.generate();

console.log(Object.keys(document.paths).join(', ')); // /api/products
console.log(document.paths['/api/products'].get?.operationId); // listProducts
console.log(JSON.stringify(document.paths['/api/products'].get?.security));
// [{"bearerAuth":[]}]
```

---

### Add routes directly and write the document

Routes can be added without a controller class. Express `:param` placeholders become `{param}`, and path parameters are detected automatically.

```typescript
import { OpenAPIGenerator, formatOpenApiDocument } from 'blendsdk/codegen';
import type { RouteDefinition } from 'blendsdk/webafx';
import { writeFile } from 'node:fs/promises';

const routes: RouteDefinition[] = [
  {
    method: 'get',
    path: '/:id',
    handler: () => undefined,
    openapi: {
      summary: 'Get one product',
      operationId: 'getProduct',
      tags: ['products'],
      responses: [
        { statusCode: 200, description: 'OK' },
        { statusCode: 404, description: 'Not found' },
      ],
    },
  },
];

const generator = new OpenAPIGenerator({ title: 'Products API', version: '1.0.0' });
generator.addRoutes('/api/products', routes);

const document = generator.generate();

// A quick JSON dump; parent directories are created when needed.
generator.toFile('./build/openapi.json');

// The canonical text that `blendsdk api check` compares against.
await writeFile('./api.json', await formatOpenApiDocument(document), 'utf8');

console.log(Object.keys(document.paths).join(', ')); // /api/products/{id}
console.log(document.paths['/api/products/{id}'].get?.parameters?.length); // 1
```

---

### Convert Zod schemas to OpenAPI 3.1 JSON Schema

`convertZodToJsonSchema` uses Zod's native converter with `io: 'input'` for request schemas and `io: 'output'` for response schemas. Nullable fields become JSON Schema type arrays, never the OpenAPI 3.0 `nullable` keyword.

```typescript
import { convertZodToJsonSchema } from 'blendsdk/codegen';
import { z } from 'zod';

console.log(JSON.stringify(convertZodToJsonSchema(z.string().nullable(), 'input')));
// {"type":["string","null"]}

console.log(JSON.stringify(convertZodToJsonSchema(z.number().nullable(), 'input')));
// {"type":["number","null"]}

console.log(JSON.stringify(convertZodToJsonSchema(z.enum(['a', 'b']).nullable(), 'input')));
// {"anyOf":[{"type":"string","enum":["a","b"]},{"type":"null"}]}
```

A nullable enum keeps its `null` branch instead of losing nullability, because a type array cannot relax an `enum`.

---

### Split a query schema into OpenAPI parameters

For GET and DELETE routes, `convertZodToQueryParameters` turns each top-level property of a Zod object into one `in: 'query'` parameter. Optional and defaulted properties are not marked required.

```typescript
import { convertZodToQueryParameters } from 'blendsdk/codegen';
import { z } from 'zod';

const parameters = convertZodToQueryParameters(
  z.object({
    page: z.coerce.number().default(1),
    category: z.string(),
    search: z.string().optional(),
  })
);

console.log(parameters.map(parameter => parameter.name).join(', '));
// page, category, search
console.log(parameters.find(parameter => parameter.name === 'category')?.required); // true
```

The result:

```typescript
// [
//   { name: 'page', in: 'query', schema: { default: 1, type: 'number' } },
//   { name: 'category', in: 'query', required: true, schema: { type: 'string' } },
//   { name: 'search', in: 'query', schema: { type: 'string' } },
// ]
```

---

### Hoist reusable definitions into components

Zod emits reusable schemas under `$defs`. `hoistDefinitions` moves them into `components.schemas`, rewrites every `#/$defs/...` reference, and deterministically renames collisions - throwing rather than leaving an unresolvable reference. `OpenAPIGenerator.generate()` calls it for you.

```typescript
import { convertZodToJsonSchema, hoistDefinitions } from 'blendsdk/codegen';
import type { OpenAPIDocument } from 'blendsdk/codegen';
import { z } from 'zod';

const product = z.object({ id: z.number(), name: z.string() }).meta({ id: 'Product' });
const schema = convertZodToJsonSchema(z.object({ first: product, second: product }), 'input');

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Products API', version: '1.0.0' },
  paths: {
    '/api/products': {
      get: {
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema } } },
        },
      },
    },
  },
};

const hoisted = hoistDefinitions(document);

console.log(Object.keys(hoisted.components?.schemas ?? {}).join(', ')); // Product
console.log(JSON.stringify(hoisted).includes('$defs')); // false
```

---

## Typed Client Generation and Drift Checks

### Generate a typed client

`generateClient` writes a typed client whose methods mirror the OpenAPI operations. Every generated file starts with a marker; stale generated files are pruned while hand-written files are left untouched.

```typescript
import { generateClient, OpenAPIGenerator } from 'blendsdk/codegen';
import type { RouteDefinition } from 'blendsdk/webafx';
import { z } from 'zod';

const routes: RouteDefinition[] = [
  {
    method: 'get',
    path: '/',
    handler: () => undefined,
    openapi: {
      summary: 'List products',
      operationId: 'listProducts',
      tags: ['products'],
      responses: [
        {
          statusCode: 200,
          description: 'OK',
          schema: z.array(z.object({ id: z.number(), name: z.string() })),
        },
      ],
    },
  },
];

const generator = new OpenAPIGenerator({ title: 'Products API', version: '1.0.0' });
generator.addRoutes('/api/products', routes);
const document = generator.generate();

const result = await generateClient(document, { outputDir: 'src/api-client' });

console.log(result.files.join(', '));
// client.ts, index.ts, types.ts
console.log(result.issues.length); // 0

// One file per group plus a barrel:
const grouped = await generateClient(document, {
  outputDir: 'src/api-client',
  splitByGroup: true,
});

console.log(grouped.files.join(', '));
// client.products.ts, client.ts, index.ts, types.ts
```

Excerpt from the generated `src/api-client/client.ts` (default single-file mode, default `clientName`):

```typescript
export interface AppClient {
  products: {
    listProducts: (options?: RequestOptions) => Promise<ProductsListProductsResult>;
  };
}
```

A duplicate `operationId` throws `ClientGenerationError` naming both locations. `strict: true` turns contract warnings (a missing `operationId` or 2xx schema) into errors.

---

### Detect drift with checkClient

`checkClient` regenerates the client in memory and compares it against the committed files without writing anything - the mechanism behind `blendsdk api check` in CI.

```typescript
import { checkClient, generateClient, OpenAPIGenerator } from 'blendsdk/codegen';
import type { RouteDefinition } from 'blendsdk/webafx';
import { appendFile } from 'node:fs/promises';
import { z } from 'zod';

const routes: RouteDefinition[] = [
  {
    method: 'get',
    path: '/',
    handler: () => undefined,
    openapi: {
      operationId: 'listProducts',
      tags: ['products'],
      responses: [
        {
          statusCode: 200,
          description: 'OK',
          schema: z.array(z.object({ id: z.number(), name: z.string() })),
        },
      ],
    },
  },
];

const generator = new OpenAPIGenerator({ title: 'Products API', version: '1.0.0' });
generator.addRoutes('/api/products', routes);
const document = generator.generate();

await generateClient(document, { outputDir: 'src/api-client' });

const clean = await checkClient(document, { outputDir: 'src/api-client' });
console.log(clean.drifted); // false

await appendFile('src/api-client/client.ts', '\n// hand edit\n');

const stale = await checkClient(document, { outputDir: 'src/api-client' });
console.log(stale.drifted); // true
console.log(stale.driftedFiles?.join(', ')); // client.ts
```

`checkClient` also reports a stale generated file that is no longer produced and escalates contract warnings to errors.

---

## API Contract and CLI

### Define a blendsdk.api.ts contract

A project authors one default-exported contract file named `blendsdk.api.ts`. It names the controllers to collect, where to write the OpenAPI document and the client, and the generator flags. Discovery searches upward from the working directory and stops at the repository root.

```typescript
import { defineApiContract } from 'blendsdk/codegen';
import type { RouteDefinition } from 'blendsdk/webafx';
import { z } from 'zod';

class ProductsController {
  routes(): RouteDefinition[] {
    return [
      {
        method: 'get',
        path: '/',
        handler: () => undefined,
        openapi: {
          summary: 'List products',
          operationId: 'listProducts',
          tags: ['products'],
          responses: [
            {
              statusCode: 200,
              description: 'OK',
              schema: z.array(z.object({ id: z.number(), name: z.string() })),
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
  openapi: {
    title: 'Store API',
    version: '1.0.0',
    servers: [{ url: 'https://api.example.com', description: 'Production' }],
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    defaultSecurity: [{ bearerAuth: [] }],
  },
  generator: {
    splitByGroup: true,
    clientName: 'StoreClient',
    runtimeImport: 'blendsdk/api-client',
  },
});
```

---

### Run the API drift gate

`blendsdk api generate` rebuilds the contract JSON and the typed client, then they are committed. `blendsdk api check` performs the same rebuild without writing and fails on any difference - run it in CI.

```bash
# Rebuild api.json and the client, then commit the result.
blendsdk api generate
# GENERATED client.products.ts client.ts index.ts types.ts api.json

# CI: rebuild in memory and fail on drift.
blendsdk api check
# DRIFT: client.ts        (exit code 1)

# Point at a specific configuration file or directory.
blendsdk api generate --config ./packages/server/blendsdk.api.ts
```

Exit codes: `0` success, `1` drift or operational failure, `2` usage or configuration failure. The contract also accepts `strict`, which makes missing `operationId` or 2xx schemas a `check` error instead of a warning.

---

## PostgreSQL Migrations

### Define a migration config

A `blendsdk.migrations.ts` file default-exports the validated settings. `defineMigrationConfig` provides type inference without runtime behavior, and the connection URL is referenced by environment-variable name so resolved configuration is safe to log.

```typescript
import { defineMigrationConfig } from 'blendsdk/codegen';

export default defineMigrationConfig({
  schema: './src/database/schema.ts',
  migrationsDir: './migrations',
  snapshotFile: './migrations/schema.snapshot.json',
  databaseUrlEnv: 'DATABASE_URL',
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 900_000,
});
```

Only `generate`, `baseline`, and `adopt-baseline` load the schema module; execution commands never import application schema code.

---

### Generate a migration

`generateMigration` diffs the committed canonical snapshot against the normalized desired schema, classifies every change, renders targeted SQL, and atomically publishes both the new `.up.sql` file and the next `schema.snapshot.json`.

```typescript
import { generateMigration } from 'blendsdk/codegen';

const result = await generateMigration({ name: 'add-customer-status' });

console.log(result.status);
// GENERATED
console.log(result.migration?.id);
// 20260828090000_add-customer-status (the timestamp prefix comes from the clock)
console.log(result.changes.map(change => `${change.safety} ${change.kind}`).join(', '));
// safe column.add

// Explicit one-to-one renames resolve what would otherwise be ambiguous:
const renamed = await generateMigration({
  name: 'rename-customer-to-account',
  renameHints: [{ kind: 'table', from: 'public.customer', to: 'public.account' }],
});
console.log(renamed.changes.map(change => change.kind).join(', '));
// table.rename

// Targeted removals require explicit approval:
const cleaned = await generateMigration({
  name: 'drop-legacy-token',
  allowDestructive: true,
});
```

When nothing changed the result is `UP_TO_DATE` and no files are touched. Ambiguous or unsupported changes throw a `MigrationError` with guidance instead of writing anything.

---

### Create the initial baseline

`generateBaseline` creates the first immutable migration and its canonical snapshot for a new project. It refuses any existing snapshot or up history and never opens a database connection.

```typescript
import { generateBaseline } from 'blendsdk/codegen';

const result = await generateBaseline({ name: 'initial' });

console.log(result.status); // GENERATED
console.log(result.migration.id); // 20260827090000_initial
console.log(result.snapshotHash); // SHA-256 of the committed schema.snapshot.json
console.log(result.changes.length); // every desired-state addition, in render order
```

The generated baseline is afterwards applied through the normal runner:

```typescript
import { runMigrations } from 'blendsdk/codegen';

await runMigrations({ command: 'up' });
```

---

### Adopt an existing database

`adoptBaseline` brings a structurally matching database under migration control without executing its baseline SQL. The catalog is compared object by object; any `MISSING`, `DIFFERENT`, `EXTRA_MODELED`, or `UNSUPPORTED_FOR_ADOPTION` entry stops adoption before anything is written.

```typescript
import { adoptBaseline } from 'blendsdk/codegen';

// Non-interactive: pass the exact `<database>/<baseline-id>` confirmation token.
const result = await adoptBaseline({
  confirmation: 'production/20260827090000_initial',
});
console.log(result.status); // ADOPTED

// Interactive: inspect the target preview and return the confirmation token.
const previewed = await adoptBaseline(
  {},
  {
    afterPreview: preview => {
      console.log(`TARGET ${preview.user}@${preview.host}:${preview.port}/${preview.database}`);
      for (const item of preview.comparison) {
        console.log(`${item.classification} ${item.identity}`);
      }
      return `${preview.database}/${preview.baselineId}`;
    },
  }
);
```

Preview output:

```
TARGET postgres@db.internal:5432/production
MATCH database.defaultSchema
MATCH schema.public
MATCH table.public.customer
MATCH column.public.customer.id
UNMANAGED public.audit_log()
ADOPTED
```

Unmanaged functions, triggers, enums, and domains are reported as `UNMANAGED` and preserved. Adoption requires application and administrative DDL to be quiesced before the confirmation is supplied.

---

### Apply and revert migrations

`runMigrations` applies pending files under a per-database advisory lock. `dryRun` previews pending order while proving the lock is available, and `down` reverts exactly the latest migration behind the required `allowDown` confirmation.

```typescript
import { runMigrations } from 'blendsdk/codegen';

const preview = await runMigrations({ command: 'up', dryRun: true });
console.log(preview.status); // PENDING
console.log(preview.migrations.map(migration => migration.id).join(', '));
// 20260828090000_add-customer-status

const applied = await runMigrations({ command: 'up' });
console.log(applied.status); // UP_TO_DATE
console.log(applied.migrations.map(migration => migration.id).join(', '));
// 20260828090000_add-customer-status

const reverted = await runMigrations({ command: 'down', allowDown: true });
console.log(reverted.status); // PENDING
console.log(reverted.migrations.map(migration => migration.id).join(', '));
// 20260828090000_add-customer-status (the migration that was reverted)
```

Requires a PostgreSQL connection URL in the configured environment variable. A migration is transactional unless it contains a concurrent index; nontransactional migrations are durably marked before dispatch so an interruption surfaces as `UNKNOWN_OUTCOME` instead of a silent half-state.

---

### Observe status and validate

`getMigrationStatus` observes history without mutating anything; `validateMigrations` verifies local files and, unless `offline` is set, the live ordered prefix. With no configured URL, `validateMigrations` falls back to local-only validation.

```typescript
import { getMigrationStatus, validateMigrations } from 'blendsdk/codegen';

const status = await getMigrationStatus();
console.log(status.status);
// 'UP_TO_DATE' | 'PENDING' | 'INVALID_HISTORY' | 'LOCKED' | 'UNKNOWN_OUTCOME'

const offline = await validateMigrations({ offline: true });
console.log(offline.status); // UP_TO_DATE — local files and snapshot lineage are valid

const live = await validateMigrations();
console.log(live.status); // PENDING — pending migrations exist on the target database
```

Both operations report uniformly: `LOCKED` means another session holds the migration lock, `UNKNOWN_OUTCOME` means the latest nontransactional migration must be investigated before further mutation.

---

### Handle migration errors safely

Every expected failure is a typed `MigrationError` with a stable `kind` and `exitCode`. Error messages are sanitized at construction time, so database URLs, credentials, and SQL never leak into ordinary output.

```typescript
import { formatMigrationError, MigrationError, runMigrations } from 'blendsdk/codegen';

try {
  await runMigrations({ command: 'up' });
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(formatMigrationError(error));
    // INVALID_HISTORY: Migration prefix or checksum mismatch at position 1.
    console.error(`kind=${error.kind} exitCode=${error.exitCode}`);
    // kind=INVALID_HISTORY exitCode=1
  } else {
    throw error;
  }
}

const secretive = new MigrationError({
  kind: 'DATABASE',
  exitCode: 1,
  message: 'Connection postgresql://operator:secret@example.test/db failed with password=second-secret',
});
console.log(formatMigrationError(secretive));
// DATABASE: Connection [REDACTED_DATABASE_URL] failed with password=[REDACTED]
```

---

## Migration CLI

### Run the migration lifecycle from the command line

The `blendsdk migrate` commands drive the same services with strict argument parsing and stable exit codes (`0` success, `1` operational failure, `2` usage or configuration failure).

```bash
# Create the first immutable migration for a new project.
blendsdk migrate baseline initial
# GENERATED 20260827090000_initial

# After editing the schema, generate one reviewable migration.
blendsdk migrate generate add-customer-status
# GENERATED 20260828090000_add-customer-status

# Create a hand-written data-backfill migration template.
blendsdk migrate create backfill-status --with-down
# CREATED 20260828103000_backfill-status

# Preview and apply pending migrations.
blendsdk migrate up --dry-run
# PENDING 20260828090000_add-customer-status
blendsdk migrate up
# UP_TO_DATE 20260828090000_add-customer-status

# Inspect history, locally or against the database.
blendsdk migrate status
# PENDING 20260828090000_add-customer-status
blendsdk migrate validate --offline
# UP_TO_DATE

# Revert exactly the latest migration (guarded).
blendsdk migrate down --allow-down
# PENDING 20260828090000_add-customer-status

# Record an exactly matching existing database without running its baseline SQL.
blendsdk migrate adopt-baseline --confirm-adoption production/20260827090000_initial
# ADOPTED
```

There is deliberately no force or repair command: a torn migration/snapshot lineage fails closed with instructions to remove the orphan migration or restore the snapshot from version control.

---

## Database Introspection

### Generate types from a live database

`PostgreSQLIntrospector` reads a connection's catalog - tables, views, enums, composites, and domains - into the same schema model the other generators consume. A `ColumnMapper` overrides how any column maps; return `undefined` to fall back to the built-in PostgreSQL-to-TypeScript mapping.

```typescript
import { PostgreSQLIntrospector, SchemaContainer, TypeGenerator } from 'blendsdk/codegen';
import type { ColumnMapper } from 'blendsdk/codegen';
import type { PostgreSQLDatabase } from 'blendsdk/postgresql';

const mapper: ColumnMapper = (column, scope) => {
  // jsonb payloads are application-defined; type them as free-form.
  if (column.pg_type === 'jsonb') {
    return scope.any();
  }
  return undefined;
};

export async function generateTypesFromDatabase(database: PostgreSQLDatabase): Promise<string> {
  const schema = new SchemaContainer();
  const introspector = new PostgreSQLIntrospector(database);

  await introspector.introspect(schema, mapper);

  return new TypeGenerator().generate(schema);
}
```

The result is the same formatted TypeScript that `TypeGenerator` produces in-process. Introspection reads metadata only; unmapped column types fall back to a deprecated placeholder schema with a console warning.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
