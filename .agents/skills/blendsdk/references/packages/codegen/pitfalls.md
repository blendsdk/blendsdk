> **Package**: `blendsdk/codegen`

# codegen Best Practices

This document covers the practices that keep `blendsdk/codegen` output trustworthy: one schema source, deterministic generators, a committed contract, and an auditable migration lineage. Every rule here exists because the alternative either breaks determinism (so drift checks stop working), silently drops type information, or turns a reviewed artifact into an unreviewable one.

---

## Do / Don't Pairs

### Schema authoring

**1. Build one container and generate every target from it.**

❌ Wrong

```typescript
import { SchemaContainer, TypeGenerator, ZodGenerator } from 'blendsdk/codegen';

// Types come from the old shape…
const typesContainer = new SchemaContainer();
const typesScope = typesContainer.scope();
typesScope.object({ email: typesScope.string() }).named('customer');

// …while the validator was updated to the new shape.
const zodContainer = new SchemaContainer();
const zodScope = zodContainer.scope();
zodScope.object({ email: zodScope.string(), phone: zodScope.string() }).named('customer');

const types = await new TypeGenerator().generate(typesContainer);
const validators = await new ZodGenerator().generate(zodContainer);
```

✅ Correct

```typescript
import { SchemaContainer, TypeGenerator, ZodGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

scope.object({ email: scope.string(), phone: scope.string() }).named('customer');

const types = await new TypeGenerator().generate(container);
const validators = await new ZodGenerator().generate(container);

console.log(types, validators);
```

**Why:** Generators are read-only visitors. `generate()` resets each object's `rendered` flag and re-walks the same graph, so running `TypeGenerator` and `ZodGenerator` over one container is safe and free of duplication. Two containers are two truths, and nothing in the package compares them — the compiler would accept a type that the runtime validator rejects.

---

**2. Create a separate schema object for each property.**

❌ Wrong

```typescript
import { SchemaContainer } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();
const reference = scope.string();

// `.optional()` mutates the shared instance, so BOTH properties become optional.
scope.object({ customerRef: reference.optional(), orderRef: reference }).named('link');
```

✅ Correct

```typescript
import { SchemaContainer } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

scope.object({ customerRef: scope.string().optional(), orderRef: scope.string() }).named('link');
```

**Why:** Schema objects are mutable builders. `optional()`, `nullable()`, `arrayed()`, `description()`, and the `parent` pointer all live in the instance's data bag. Sharing one instance across properties means one call site silently rewrites every usage — and only one of the two properties is recorded as the parent when a JSDoc `@memberOf` is emitted.

---

**3. Never name a property schema.**

❌ Wrong

```typescript
import { SchemaContainer } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

// Compiles, then throws at generate(): "Object properties cannot be named explicitly."
scope.object({ email: scope.string().named('email') }).named('customer');
```

✅ Correct

```typescript
import { SchemaContainer } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

// Promote the shape to a root type, then reference it.
const email = scope.string().pattern('^[^@\\s]+@[^@\\s]+$').named('email_address');

scope.object({ email: scope.ref(email) }).named('customer');
```

**Why:** `named()` both registers the object in the `SchemaContainer` (rejecting duplicates) and marks it as a renderable root type. A named object that also has a parent is contradictory — the generator refuses it rather than guessing whether to emit an alias or an inline property. Root types get names; properties get types.

---

**4. Prefer `scope.unknown()` to `scope.any()`.**

❌ Wrong

```typescript
import { SchemaContainer, ZodGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

// Emits `payload: any;` and `payload: z.any()`
scope.object({ payload: scope.any() }).named('event');

const validators = await new ZodGenerator().generate(container);
```

✅ Correct

```typescript
import { SchemaContainer, ZodGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

// Emits `payload: unknown;` and `payload: z.unknown()`
scope.object({ payload: scope.unknown() }).named('event');

const validators = await new ZodGenerator().generate(container);
```

**Why:** `any` disables checking at every downstream use of the generated type and produces a validator (`z.any()`) that accepts anything, so the type and the runtime agree only by accident. `unknown` forces an explicit narrowing at the boundary — which is exactly the intended contract for opaque values such as PostgreSQL `json`/`jsonb` columns.

---

**5. Encode string rules as constraints, not prose.**

❌ Wrong

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

// The rule lives only in a comment: TypeScript, Zod, and OpenAPI never see it.
scope.string().description('lowercase slug, 3–40 characters').named('project_name');

const types = await new TypeGenerator().generate(container);
```

✅ Correct

```typescript
import { SchemaContainer, TypeGenerator, ZodGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

scope
  .string()
  .pattern('^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$')
  .minLength(3)
  .maxLength(40)
  .named('project_name');

const types = await new TypeGenerator().generate(container);
const validators = await new ZodGenerator().generate(container);
```

Constraint authoring is validated immediately — an invalid regular expression, a flagged `RegExp`, or a `minLength` greater than an existing `maxLength` throws at the call site, naming the schema. The same rule then reaches all three artifacts:

| Authoring call | TypeScript JSDoc | Zod | OpenAPI 3.1 |
| --- | --- | --- | --- |
| `.pattern('^[a-z]+$')` | `@pattern ^[a-z]+$` | `.regex(new RegExp("^[a-z]+$"))` | `pattern: "^[a-z]+$"` |
| `.minLength(3)` | `@minLength 3` | `.min(3)` | `minLength: 3` |
| `.maxLength(40)` | `@maxLength 40` | `.max(40)` | `maxLength: 40` |

**Why:** A description is documentation; a constraint is a contract. Only constraints survive into the generated validator and the OpenAPI document, which is what stops client and server from disagreeing about a value that was "obviously" invalid.

---

### API contracts and typed clients

**6. Give every published operation a unique `operationId`.**

❌ Wrong

```typescript
import { generateClient, type OpenAPIDocument } from 'blendsdk/codegen';

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Shop', version: '1.0.0' },
  paths: {
    '/api/products': {
      get: { operationId: 'list', tags: ['products'], responses: { 200: { description: 'OK' } } },
    },
    '/api/orders': {
      // Same operationId: generation throws ClientGenerationError.
      get: { operationId: 'list', tags: ['orders'], responses: { 200: { description: 'OK' } } },
    },
  },
};

await generateClient(document, { outputDir: 'src/api-client' });
```

✅ Correct

```typescript
import { generateClient, checkClient, type OpenAPIDocument } from 'blendsdk/codegen';

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Shop', version: '1.0.0' },
  paths: {
    '/api/products': {
      get: {
        operationId: 'listProducts',
        tags: ['products'],
        responses: {
          200: {
            description: 'Product page',
            content: {
              'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Product' } } },
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
          200: {
            description: 'Order page',
            content: {
              'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Product: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      Order: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
};

await generateClient(document, { outputDir: 'src/api-client' });

const diff = await checkClient(document, { outputDir: 'src/api-client' });
if (diff.drifted) {
  console.error(`DRIFT: ${diff.driftedFiles?.join(', ') ?? 'contract'}`);
  process.exitCode = 1;
}
```

**Why:** `operationId` becomes the method name. A duplicate is a hard `ClientGenerationError` because one generated method would overwrite the other. A *missing* `operationId` is worse at review time: `generate` only warns, `check` escalates it to an error, and the method name falls back to the path shape (e.g. `productsGetById`) — stable, but unreadable and easy to break by moving a route. Declaring the id keeps the client intentional.

---

**7. Publish routes deliberately with `.openapi()`.**

❌ Wrong

```typescript
// ❌ No `.openapi()` metadata: the route exists at runtime but is absent from api.json,
//    so the generated client has no method for it.
routes(): RouteDefinition[] {
  return [{ method: 'get', path: '/internal/metrics', handler: this.metrics }];
}
```

✅ Correct

```typescript
// ✅ Opt-in: only annotated routes enter the contract.
routes(): RouteDefinition[] {
  return [
    {
      method: 'get',
      path: '/',
      handler: this.list,
      openapi: {
        operationId: 'listProducts',
        tags: ['products'],
        summary: 'List products',
        responses: [{ statusCode: 200, description: 'Product page', schema: ProductPageSchema }],
      },
    },
  ];
}
```

**Why:** Documentation is opt-in by design. A route without `.openapi()` is filtered out during collection, which is correct for internal endpoints — but it means "the client is missing a method" is almost always an un-annotated route, not a generator bug. Annotate the routes you intend to publish, and leave the rest unannotated on purpose.

---

**8. Keep controller constructors free of side effects.**

❌ Wrong

```typescript
// ❌ addController instantiates the class with `{}` settings and services.
class ProductsController {
  public constructor(_settings: unknown, _services: unknown) {
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }

  public routes(): RouteDefinition[] {
    return this.buildRoutes(this.pool); // Empty mock dependencies at generation time.
  }
}
```

✅ Correct

```typescript
// ✅ The constructor only stores dependencies; routes() only builds route definitions.
class ProductsController {
  private readonly service: ProductService;

  public constructor(_settings: unknown, services: { products: ProductService }) {
    this.service = services.products;
  }

  public routes(): RouteDefinition[] {
    return [
      { method: 'get', path: '/', handler: this.service.list, openapi: { operationId: 'listProducts' } },
    ];
  }
}
```

**Why:** `OpenAPIGenerator.addController` constructs the controller with empty objects because document generation must run offline in CI. A constructor that opens a connection, reads configuration, or eagerly resolves services makes `blendsdk api generate` either fail or — worse — succeed with a half-configured route list that disagrees with production.

---

**9. Write generated clients into a dedicated directory.**

❌ Wrong

```typescript
import { defineApiContract } from 'blendsdk/codegen';
import { ProductsController } from './controllers/products.controller.js';

export default defineApiContract({
  // Generated index.ts / types.ts / client.ts land next to hand-written modules.
  outputDir: 'src',
  controllers: [{ basePath: '/api/products', controller: ProductsController }],
  openapi: { title: 'Shop', version: '1.0.0' },
});
```

✅ Correct

```typescript
import { defineApiContract } from 'blendsdk/codegen';
import { ProductsController } from './controllers/products.controller.js';

export default defineApiContract({
  outputDir: 'src/api-client',
  contractFile: 'api.json',
  controllers: [{ basePath: '/api/products', controller: ProductsController }],
  openapi: { title: 'Shop', version: '1.0.0' },
  generator: { splitByGroup: true, strict: true },
});
```

**Why:** Pruning is conservative — only files that start with the generated marker are deleted — but *writing* is not. A generated `index.ts`, `types.ts`, or `client.ts` overwrites a same-named hand-written file deterministically, and nothing warns you. A dedicated directory makes the generated surface obvious in review and lets you re-export it from your own barrel on your terms.

---

**10. Mark paginated operations with the `body` envelope.**

❌ Wrong

```typescript
import { generateClient, type OpenAPIDocument } from 'blendsdk/codegen';

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Shop', version: '1.0.0' },
  paths: {
    '/api/orders': {
      get: {
        operationId: 'listOrders',
        tags: ['orders'],
        // Default `data` envelope: the client returns Order[] and the pagination
        // metadata around it is unreachable from the type system.
        responses: {
          200: {
            description: 'Order page',
            content: {
              'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: { Order: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  },
};

await generateClient(document, { outputDir: 'src/api-client' });
```

✅ Correct

```typescript
import { generateClient, type OpenAPIDocument } from 'blendsdk/codegen';

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Shop', version: '1.0.0' },
  paths: {
    '/api/orders': {
      get: {
        operationId: 'listOrders',
        tags: ['orders'],
        'x-blend-envelope': 'body',
        responses: {
          200: {
            description: 'Order page',
            content: {
              'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: { Order: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  },
};

await generateClient(document, { outputDir: 'src/api-client' });
```

**Why:** The envelope is how the runtime knows where the payload lives. With `'body'` the generator emits `export type OrdersListOrdersResult = PaginatedResponse<Order[]>;` and imports it from the runtime; with the default `'data'` it emits `Order[]` and the runtime unwraps the top-level `data` property, discarding the cursor/page fields entirely. Losing pagination is a silent, runtime-only failure — the compiler is happy.

---

**11. Pair `secure: true` with a configured security scheme.**

❌ Wrong

```typescript
import { defineApiContract } from 'blendsdk/codegen';
import { ProductsController } from './controllers/products.controller.js';

export default defineApiContract({
  outputDir: 'src/api-client',
  controllers: [{ basePath: '/api/products', controller: ProductsController }],
  // No securitySchemes and no defaultSecurity.
  openapi: { title: 'Shop', version: '1.0.0' },
});
```

```typescript
// A secure route then produces `security: []` — "security required, scheme undefined".
{ method: 'post', path: '/', secure: true, openapi: { operationId: 'createProduct', tags: ['products'] } }
```

✅ Correct

```typescript
import { defineApiContract } from 'blendsdk/codegen';
import { ProductsController } from './controllers/products.controller.js';

export default defineApiContract({
  outputDir: 'src/api-client',
  controllers: [{ basePath: '/api/products', controller: ProductsController }],
  openapi: {
    title: 'Shop',
    version: '1.0.0',
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    defaultSecurity: [{ bearerAuth: [] }],
  },
});
```

**Why:** `secure: true` copies `defaultSecurity` onto the operation. If none is configured, the operation is emitted with an empty `security` array, which is valid OpenAPI meaning "security is required but no scheme is named" — a contract every consumer reads differently. Declaring both the scheme and the default keeps the document self-describing.

---

**12. Make the drift check part of CI.**

❌ Wrong

```bash
# Regenerate and move on: nothing notices a stale committed contract or a hand-edited client.
blendsdk api generate
```

✅ Correct

```bash
# Rebuild in memory and fail on any difference from the committed artifacts.
blendsdk api check
```

```typescript
import { checkClient, type OpenAPIDocument } from 'blendsdk/codegen';

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Shop', version: '1.0.0' },
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
  console.error(`DRIFT: ${result.driftedFiles?.join(', ') ?? 'contract'}`);
  process.exitCode = 1;
}
```

**Why:** `check` is the gate; `generate` is the writer. `check` escalates every contract warning — missing `operationId`, missing 2xx schema — to an error and compares both `api.json` and every marker-bearing client file, so a hand edit or a forgotten regeneration fails the build instead of shipping. Exit codes are stable: `0` clean, `1` drift or operational failure, `2` usage or configuration.

---

### PostgreSQL migrations

**13. Keep the connection URL in an environment variable.**

❌ Wrong

```typescript
// blendsdk.migrations.ts — a secret in a committed, loggable file.
export default {
  schema: './src/database/schema.ts',
  databaseUrl: 'postgresql://app:secret@db.internal:5432/app',
};
```

✅ Correct

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

**Why:** The config loader rejects unknown keys, so a stray `databaseUrl` is a `CONFIGURATION` failure rather than a slow leak — but the intent matters more: `ResolvedMigrationConfig` is deliberately credential-free (it contains an env-var *name*, not a secret), so it can be printed, logged, or asserted in a test. Only the runner reads `process.env`, and only at the moment it opens a pool.

---

**14. Commit the migration and its snapshot as one immutable pair.**

❌ Wrong

```bash
# Rewriting applied history: the ledger checksum no longer matches the file.
vim migrations/20260827120000_add-status.up.sql
blendsdk migrate validate
# INVALID_HISTORY: Migration prefix or checksum mismatch at position 1.
```

✅ Correct

```bash
# Add the change forward, then commit both artifacts together.
blendsdk migrate generate add-status-note
git add migrations/20260827120000_add-status.up.sql migrations/schema.snapshot.json
```

**Why:** Every migration file records the previous and resulting snapshot SHA-256, and the runner re-verifies the exact bytes after it acquires the advisory lock — even a one-byte edit to an *applied* file fails `validate`, `status`, and `up` before any SQL executes. The snapshot is the comparison base for the next `generate`; editing it by hand severs that lineage and produces a torn pair that the package reports rather than repairs.

---

**15. Supply explicit rename hints instead of accepting a guessed rename.**

❌ Wrong

```bash
# The table was renamed; without a hint this is an ambiguous change and generation stops.
blendsdk migrate generate rename-customer-to-account
# INVALID_HISTORY: Provide one explicit table rename hint.
```

✅ Correct

```bash
blendsdk migrate generate rename-customer-to-account \
  --rename-table public.customer=public.account

# Column renames use the three-part identity.
blendsdk migrate generate rename-label \
  --rename-column public.customer.label=public.account.display_name
```

**Why:** A rename and a drop-plus-add are indistinguishable from two snapshots alone, and the difference is data loss. Hints are validated before diffing — one-to-one, acyclic, same schema, mapping an existing prior identity to an existing desired identity, and a cross-table column hint requires a matching table hint. Only then does the planner emit `ALTER TABLE … RENAME` instead of `DROP` + `CREATE`.

---

**16. Approve destructive changes deliberately, and only destructive ones.**

❌ Wrong

```typescript
import { generateMigration } from 'blendsdk/codegen';

// A standing script that approves every drop, forever.
await generateMigration({ name: 'drop-legacy-orders', allowDestructive: true });
```

✅ Correct

```typescript
import { generateMigration } from 'blendsdk/codegen';

const result = await generateMigration({ name: 'add-status-note' });

if (result.status === 'GENERATED' && result.migration) {
  console.log(result.migration.id, `${result.changes.length} change(s)`);
}
```

**Why:** `allowDestructive` is an approval boundary for reviewed drops, not a general override. A required-column add (`caution`), a type change or generated/identity transition (`unsupported`), and an unhinted rename (`ambiguous`) still throw with guidance telling you to write reviewed manual SQL. Hiding that behind a flag turns a review step into a build step.

---

**17. Keep the schema module a pure, default-exported `DatabaseSchema`.**

❌ Wrong

```typescript
// ❌ schema.ts — connects on import and does not default-export a DatabaseSchema.
import { Pool } from 'pg';

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export default async function loadSchema(): Promise<readonly string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    'SELECT table_name FROM information_schema.tables'
  );
  return rows.map(row => row.table_name);
}
```

✅ Correct

```typescript
// ✅ schema.ts — pure authoring, no I/O, one default export.
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');
const customer = schema.table('customer');
customer.bigint('id').primaryKey();
customer.text('email');

export default schema;
```

**Why:** The module is imported through `jiti` by `generate`, `baseline`, and `adopt-baseline`, all of which must work without a database. A top-level connection makes generation depend on a live catalog, and a non-`DatabaseSchema` default export is rejected with `CONFIGURATION: The schema module must default-export one DatabaseSchema instance.` Execution-only commands (`up`, `down`, `status`, `validate`) never import it at all.

---

**18. Choose baseline vs adoption by database history.**

❌ Wrong

```bash
# 'baseline' on a database that already has the tables:
# it is offline, refuses existing snapshot/history, and its DDL would recreate objects.
blendsdk migrate baseline initial
```

✅ Correct

```bash
# New project: one complete initial lineage.
blendsdk migrate baseline initial

# Existing database: quiesce application and admin DDL, then prove equality and record lineage.
blendsdk migrate adopt-baseline --confirm-adoption app/20260827090000_initial
```

**Why:** `generateBaseline` writes a fresh initial migration plus canonical snapshot and never opens a connection. `adoptBaseline` is the existing-database path: it compares every supported catalog object against the desired snapshot inside a repeatable-read transaction, refuses unsupported or differing state, and records the baseline row *without executing its SQL*. Using the wrong one either produces redundant DDL or overwrites a lineage that already maps to real data.

---

**19. Reserve nontransactional migrations for statements that require them.**

❌ Wrong

```bash
# A plain backfill does not need transaction-control exceptions.
blendsdk migrate create backfill-customer-status --no-transaction
```

✅ Correct

```bash
# Let the runner own the transaction for ordinary DDL and data changes.
blendsdk migrate create backfill-customer-status

# Opt out only when PostgreSQL forbids the transaction, e.g. CREATE INDEX CONCURRENTLY.
blendsdk migrate create add-order-index --no-transaction
```

**Why:** A transactional migration commits — or rolls back — its SQL and its ledger row together. A nontransactional one commits a durable `NONTRANSACTIONAL_DIRTY` marker first, then runs the SQL outside a transaction; if the session is lost the outcome is unknowable and the operator gets `UNKNOWN_OUTCOME`, not a rollback. That is a recovery procedure, not a convenience flag.

---

**20. Recover forward; treat `down` as a local tool.**

❌ Wrong

```bash
# Production rollback plan = revert the affected migration?
blendsdk migrate down --allow-down
# Down reverts exactly the latest applied migration, needs a matching down file,
# and a nontransactional down can itself leave an unknown outcome.
```

✅ Correct

```bash
# Ship a new forward migration and keep the history linear and applied.
blendsdk migrate generate fix-order-total-default
blendsdk migrate up --dry-run
blendsdk migrate up
```

**Why:** `down` is guarded (`--allow-down` is required), reverts exactly one migration, and requires an optional `*.down.sql` whose lineage is the exact inverse of the up file. In production, re-applying forward is the only path that keeps the ledger a truthful prefix of local history; a reverted-and-rewritten history destroys the evidence the runner depends on.

---

### Commands and errors

**21. Call the library API instead of spawning the executable.**

❌ Wrong

```typescript
import { execFileSync } from 'node:child_process';

// Parses human-readable text, pays a process start, and inherits CLI exit semantics.
const output = execFileSync('blendsdk', ['migrate', 'status'], { encoding: 'utf8' });
if (!output.startsWith('UP_TO_DATE')) {
  throw new Error(`Unexpected migration state: ${output}`);
}
```

✅ Correct

```typescript
import { getMigrationStatus } from 'blendsdk/codegen';

const result = await getMigrationStatus();

if (result.status !== 'UP_TO_DATE') {
  console.error(
    `${result.status}: ${result.migrations.map(migration => migration.id).join(', ')}`
  );
  process.exitCode = 1;
}
```

**Why:** The executable is a thin shell around these functions: it parses arguments and sets `process.exitCode`. The functions return a typed `MigrationCommandResult` whose `status` is a stable union (`UP_TO_DATE`, `PENDING`, `INVALID_HISTORY`, `LOCKED`, `UNKNOWN_OUTCOME`) — no text parsing, no second Node process, and no dependency on CLI output formatting.

---

**22. Branch on `kind` and report through `formatMigrationError`.**

❌ Wrong

```typescript
import { runMigrations } from 'blendsdk/codegen';

try {
  await runMigrations({ command: 'up' });
} catch (error) {
  // ❌ Matching on prose: the message is redacted and may not contain the word you grep for.
  if (error instanceof Error && error.message.includes('lock')) {
    console.log('Retrying later');
  }
  throw error;
}
```

✅ Correct

```typescript
import { formatMigrationError, MigrationError, runMigrations } from 'blendsdk/codegen';

try {
  await runMigrations({ command: 'up' });
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(formatMigrationError(error));
    if (error.kind === 'LOCKED') {
      console.error('Another migration process holds the database lock.');
    }
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}
```

**Why:** `kind` (`CONFIGURATION`, `INVALID_HISTORY`, `FILESYSTEM`, `DATABASE`, `LOCKED`, `UNKNOWN_OUTCOME`, `UNSUPPORTED`, `ABORTED`, `INTERNAL`) and `exitCode` (`1` operational, `2` usage/configuration) are stable contracts; message text is prose and is deliberately rewritten at construction time. `formatMigrationError` prints `KIND: message` with connection URLs and credential assignments removed and never includes SQL.

---

## Anti-Patterns

| Anti-pattern | What goes wrong | Do instead |
| --- | --- | --- |
| Naming a property schema with `.named()` | `generate()` throws `Object properties cannot be named explicitly` | Name only root types and reference them with `scope.ref()` |
| Reusing one schema instance across properties | `.optional()`, `.nullable()`, and descriptions are shared, so one usage rewrites the others | Create a fresh `scope.string()` / `scope.number()` per property |
| Reaching for `scope.any()` to satisfy the compiler | Generated TypeScript contains `any` and generated Zod is `z.any()`; neither layer checks anything | Use `scope.unknown()` and narrow at the edge |
| Hand-editing a generated client file | Overwritten by the next `generate`; reported as drift by `check` | Change the controller or the contract, then regenerate |
| Pointing `outputDir` at a source directory | Generated `index.ts`, `types.ts`, `client.ts` are written unconditionally and clobber name-sakes | Dedicate an output directory and re-export from your own barrel |
| Mirroring one schema in two containers | Type and validator drift apart with no detection | One container, every generator |
| Editing an applied migration or `schema.snapshot.json` | Checksum or lineage mismatch fails `validate`, `status`, and `up` before any SQL runs | Add a forward migration and commit the pair |
| Treating `PostgreSQLSchemaGenerator` as the migration path | Bootstrap DDL recreates objects instead of evolving reviewed state | Use `PostgreSQLSchemaGenerator` for disposable/local bootstrap; `generateMigration` + reviewed SQL for real history |
| Expecting `allowDestructive` to unblock everything | `caution`, `ambiguous`, and `unsupported` changes still throw | Read the guidance and write reviewed manual SQL |
| Deleting a `NONTRANSACTIONAL_DIRTY` ledger row | Erases the only record of an unknown outcome; the next run may re-apply or mis-sequence | Investigate the catalog, then reconcile deliberately |
| Calling `introspect()` twice on one container | The second pass re-registers names and throws `Schema object already exists` | Introspect into a fresh `SchemaContainer` |
| Leaving custom PostgreSQL types unmapped | Unmapped `xml`, `jsonpath`, `interval`, range, and geometry columns fall back to a deprecated `any` plus a `console.log` warning | Supply a `ColumnMapper` that returns a scoped schema object |
| Using `introstectConstantTypes()` | Deprecated misspelled alias | Call `introspectConstantTypes()` |
| Expecting `status` or `validate` to create the ledger | Observation commands never mutate; the ledger stays absent | Let `up` (or `adoptBaseline`) create and write it |

---

## Performance Tips

**Generate once per build, not per request.** Every generator ends with a Prettier pass over the entire output (`TypeGenerator`, `ZodGenerator`, `generateClient`). Formatting dominates the cost; calling `generate()` in a request handler pays it repeatedly for identical input. Generate at build time and ship the artifacts.

**Reuse one container across generators.** `generate()` resets `rendered` flags on every object, so a second generator pass re-walks the graph but avoids rebuilding and re-registering it. Constructing a second container costs more and risks the drift described above.

**`SchemaContainer.find()` is a linear scan.** It searches the object array by scope and name, and the introspector calls it once per enum column — so a catalog with many enum-typed columns grows super-linearly. Introspect once into a dedicated container, and cache lookup results when writing your own `ColumnMapper` loops.

**Use `introspectConstantTypes()` when you only need column names.** It runs the same catalog query but builds a plain `relation → column[]` map instead of constructing and registering schema objects for every column.

**Keep the client output directory small and dedicated.** `generateClient` calls `pruneStaleFiles`, which lists the directory and *reads every regular file* to test for the generated marker (non-regular files are skipped so a FIFO read cannot block). A directory holding the whole source tree makes every generation proportional to that tree.

**Keep the migrations directory free of unrelated files.** `discoverMigrations` reads and SHA-256s every `*.sql` file, rejects unknown names, and a mutating `up` re-discovers after acquiring the lock and re-reads the pending file — two full passes per run. The package's own budget is 100 no-op migrations discovered in under two seconds; keep that linear by not co-locating notes, backups, or scratch SQL. The same scaling holds for diffing: 500 newly added tables normalize and diff in under two seconds with well under 256 MB of additional RSS.

**Tune the two timeouts instead of waiting.** `lockTimeoutMs` defaults to 5 000 ms (max 300 000) and is polled every 20 ms; a small value in CI surfaces contention as `LOCKED` instead of a hung job. `statementTimeoutMs` defaults to 900 000 ms (max 86 400 000) and is applied per session, bounding a runaway migration without a manual kill.

**Spend `check` once.** `checkClient` regenerates every file in memory and formats it, so a drift check costs roughly the same as a generation. Run it once per CI job rather than in a per-file watch loop; use `generate` locally while iterating.

**Choose `splitByGroup` for review, not speed.** Splitting by tag produces one `client.<group>.ts` per group plus a barrel — more files to write and format, but far smaller diffs and no whole-file churn when one group changes.

---

## Security Considerations

**Credentials belong in the environment, never in configuration.** `MigrationConfig` accepts `databaseUrlEnv` — an environment-variable *name* — precisely so `ResolvedMigrationConfig` can be logged safely. The runner reads the value only when it needs a pool, and passes it to `pg` without copying it into results or error objects.

**Redaction is a backstop, not a license.** `MigrationError` rewrites complete `postgres://` / `postgresql://` URLs and `password=`, `pass=`, `secret=`, `token=` assignments at construction time, and `sensitiveDetail` is accepted but intentionally discarded. Any other secret shape — a bearer token in a free-form sentence, a private key fragment — is not covered. Never interpolate secrets or SQL text into a message.

**Surface errors through `formatMigrationError`.** It emits a stable `KIND: sanitized message`, never SQL and never a connection string, and `exitCode` tells the caller whether the failure was operational (`1`) or usage/configuration (`2`). Print the formatted line; rethrow anything that is not a `MigrationError` rather than flattening it into a string.

**Do not widen the path rules.** Configured relative paths may not escape the configuration directory, filesystem roots are rejected, and existing symbolic-link segments are refused for the migrations directory, the snapshot file, and the schema module. Migration discovery additionally rejects symlinked `*.sql` files and requires the snapshot to be a regular file. These checks exist so a `blendsdk.migrations.ts` cannot be turned into an arbitrary-file writer.

**Treat the adoption confirmation as an interlock.** `adoptBaseline` requires the exact `<database>/<baseline-id>` token after application and administrative DDL has been quiesced, re-compares the catalog inside its transaction, and re-reads local history to detect a file changed during the preview. Never compute that token automatically in a pipeline that could resolve to a different database — the token is what binds the approval to a specific target.

**Know what the advisory lock covers.** The database-scoped lock serializes *BlendSDK migration processes* on the same database. It does not stop another tool, a manual `psql` session, or autoscaling DDL from changing the catalog. Pair the runner with your own single-writer discipline.

**Treat `allowDestructive` as an approval, not a capability.** Keep it off in standing automation and pass it only in the single reviewed invocation that drops an object. Destructive statements are additionally annotated with a conspicuous review comment in the generated SQL.

**Never delete uncertainty markers.** A `NONTRANSACTIONAL_DIRTY` row means the runner committed intent before dispatching SQL it could not roll back. Deleting it hides an unknown outcome and can cause a migration to be re-applied; investigate the catalog first, then reconcile the row deliberately.

**Generated client code is escaped by construction.** Operation IDs and property names are sanitized into identifiers, string literals are JSON-escaped, reserved words get a deterministic suffix, and `satisfies OperationDescriptor` keeps the descriptor shape checked. Never hand-concatenate route or operation text into a generated file — you would be replacing an escaping boundary with string interpolation.

**Install `pg` deliberately.** It is an optional peer so that schema authoring, generation, and OpenAPI work without a database driver. When you do install it, keep the connection string in the environment and let `statement_timeout` bound anything the driver executes.

---

# codegen Testing Patterns

`blendsdk/codegen` is unusually testable: every generator is a pure function from an in-memory schema to normalized text, every artifact is written to a directory you choose, and the database-backed operations are reached through explicit entry points. Most of the surface can be tested without a database, without mocks, and without process-global state. The parts that do need PostgreSQL need a *disposable* database, not a shared one.

Three tiers cover the package:

| Tier | What it proves | Typical cost |
| --- | --- | --- |
| Unit | Schema authoring rules, generated text, Zod/JSON Schema conversion, naming decisions | Milliseconds |
| Filesystem | Typed clients, `api.json`, migration SQL, canonical snapshots | Tens of milliseconds |
| Database | Introspection, migration runner, baseline adoption | Seconds |

The package itself splits tests along the same seam: `*.spec.test.ts` files pin externally observable behaviour, and `*.impl.test.ts` files reach into internal modules for edge cases. Consumer tests only need the behaviour tier — every example below imports from the package root.

---

## Test Setup

### Install

The library ships inside the `blendsdk` umbrella. Database-backed suites additionally need the optional `pg` peer.

```bash
npm install blendsdk
npm install --save-dev vitest typescript @types/node
# Only for the PostgreSQL-backed suites:
npm install blendsdk pg
npm install --save-dev @types/pg
```

### Vitest configuration

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Database suites share one PostgreSQL instance and the migration advisory
    // lock, so files must not run concurrently.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts'],
    },
  },
});
```

`fileParallelism: false` is equivalent to the package's `vitest run --no-file-parallelism`. Within a file, database suites should still use `describe.sequential(...)` so individual tests do not race each other.

```json
{
  "scripts": {
    "test:fast": "vitest run --reporter=verbose --no-file-parallelism --testTimeout=30000",
    "test:watch": "vitest watch --reporter=verbose",
    "test:coverage": "vitest run --coverage",
    "db:up": "docker-compose -p codegen -f ./docker/docker-compose.yml up -d",
    "db:down": "docker-compose -p codegen -f ./docker/docker-compose.yml down -v --remove-orphans",
    "test": "npm run db:down && npm run db:up && npm run test:fast && npm run db:down"
  }
}
```

### Directory layout

```text
tests/
  support/                 shared fixtures and cleanup
    temporary-directory.ts
    openapi-fixtures.ts
    evaluate-zod.ts
    cli-runner.ts
    migration-project.ts
  unit/
    schema-dsl.test.ts
    string-constraints.test.ts
    openapi-generator.test.ts
  integration/
    client-generator.test.ts
    api-cli.test.ts
    introspection.test.ts
    migrations.test.ts
```

### Required imports

| Suite | From `blendsdk/codegen` | Other packages |
| --- | --- | --- |
| Schema authoring | `SchemaContainer`, `SchemaUtils`, `ObjectSchema` | — |
| Type generation | `SchemaContainer`, `TypeGenerator` | — |
| Zod generation | `SchemaContainer`, `ZodGenerator` | `zod` |
| DDL generation | `DatabaseSchema`, `PostgreSQLSchemaGenerator` | — |
| OpenAPI documents | `OpenAPIGenerator`, `convertZodToJsonSchema`, `convertZodToQueryParameters`, `hoistDefinitions`, `OpenAPIDocument`, `OpenAPISchema` | `zod` |
| Typed clients | `generateClient`, `checkClient`, `ClientGenerationError`, `ClientGeneratorOptions` | — |
| Introspection | `PostgreSQLIntrospector`, `SchemaContainer`, `ColumnMapper` | `blendsdk/postgresql` |
| Migrations | `defineMigrationConfig`, `generateMigration`, `generateBaseline`, `runMigrations`, `getMigrationStatus`, `validateMigrations`, `adoptBaseline`, `MigrationError`, `formatMigrationError` | `pg` for database suites |

### Test helpers

#### Temporary directories

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporaryDirectories: string[] = [];

/**
 * Creates a unique directory that `removeTemporaryDirectories` deletes later.
 *
 * Pass `process.cwd()` as the parent when the directory will contain a
 * `blendsdk.api.ts` or `blendsdk.migrations.ts` file that imports the package:
 * Node then resolves `node_modules` by walking up the project tree.
 */
export async function temporaryDirectory(
  parent: string = tmpdir(),
  prefix = 'blendsdk-'
): Promise<string> {
  const directory = await mkdtemp(join(parent, prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/** Removes every directory created through `temporaryDirectory`. */
export async function removeTemporaryDirectories(): Promise<void> {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
}
```

```typescript
import { afterEach, expect, test } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { removeTemporaryDirectories, temporaryDirectory } from '../support/temporary-directory.js';

afterEach(removeTemporaryDirectories);

test('helpers remove every directory the suite created', async () => {
  const directory = await temporaryDirectory();
  await writeFile(join(directory, 'probe.txt'), 'ok\n', 'utf8');

  expect(await readFile(join(directory, 'probe.txt'), 'utf8')).toBe('ok\n');
});
```

#### OpenAPI document builders

```typescript
import type { OpenAPIDocument, OpenAPIResponse, OpenAPISchema } from 'blendsdk/codegen';

/** Builds one successful JSON response, with an optional 2xx schema. */
export function jsonSuccess(schema?: OpenAPISchema): Record<string, OpenAPIResponse> {
  return {
    200: {
      description: 'Success',
      ...(schema ? { content: { 'application/json': { schema } } } : {}),
    },
  };
}

/** Builds a minimal, complete OpenAPI 3.1 document. */
export function openApiDocument(
  paths: OpenAPIDocument['paths'],
  schemas?: Record<string, OpenAPISchema>
): OpenAPIDocument {
  return {
    openapi: '3.1.0',
    info: { title: 'Test API', version: '1.0.0' },
    paths,
    ...(schemas ? { components: { schemas } } : {}),
  };
}
```

#### Evaluating generated Zod source

Text assertions cannot prove that a validator *works*. Generated source is a single `import` plus exported constants, so a test can execute it with the real `zod`.

```typescript
import { z } from 'zod';

/**
 * Executes generated Zod source so a test asserts runtime behaviour, not text.
 * The source is generated inside the test; never evaluate foreign input.
 */
export function evaluateZodSchema(source: string, variableName: string): z.ZodType {
  const body = source.replace(/^import .*$/gmu, '').replace(/\bexport\b/gu, '');
  const factory = new Function('z', `${body}\nreturn ${variableName};`);
  return factory(z) as z.ZodType;
}
```

#### CLI runner

```typescript
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

/** Project-local executable installed by the `blendsdk` umbrella package. */
export const blendsdkBin = join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'blendsdk.cmd' : 'blendsdk'
);

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one CLI invocation and normalizes both success and non-zero exits. */
export async function runCli(args: readonly string[], cwd = process.cwd()): Promise<CliResult> {
  try {
    const result = await executeFile(blendsdkBin, args, { cwd, timeout: 30_000 });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (!isExecFailure(error)) throw error;
    return { exitCode: readExitCode(error), stdout: error.stdout, stderr: error.stderr };
  }
}

interface ExecFailure {
  readonly stdout: string;
  readonly stderr: string;
}

function isExecFailure(value: unknown): value is ExecFailure {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'stdout' in value &&
    typeof value.stdout === 'string' &&
    'stderr' in value &&
    typeof value.stderr === 'string'
  );
}

function readExitCode(error: ExecFailure): number {
  return 'code' in error && typeof error.code === 'number' ? error.code : 1;
}
```

#### Migration project with a disposable database

Migration configuration and schema modules are loaded by `jiti`, so fixtures must live where `blendsdk/codegen` resolves — under the project root, not `os.tmpdir()`.

```typescript
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Pool } from 'pg';
import { expect } from 'vitest';
import { MigrationError } from 'blendsdk/codegen';

const ADMIN_URL = 'postgresql://postgres:postgres@127.0.0.1:5597/postgres';

const projects: MigrationProject[] = [];
const directories: string[] = [];
const databaseNames: string[] = [];
const environmentNames: string[] = [];
let adminPool: Pool | undefined;

export interface MigrationProject {
  readonly databaseUrl: string;
  readonly configPath: string;
  readonly migrationsDir: string;
  readonly pool: Pool;
}

/** Opens the administrative pool used only to create and drop test databases. */
export function openAdminPool(): void {
  adminPool = new Pool({ connectionString: ADMIN_URL, max: 2 });
}

/**
 * Creates one isolated database and one migration project.
 *
 * The fixture lives under `process.cwd()` because jiti loads
 * `blendsdk.migrations.ts` and `schema.ts` and they must resolve
 * `blendsdk/codegen` through the project's `node_modules`.
 */
export async function createMigrationProject(
  options: { readonly lockTimeoutMs?: number; readonly statementTimeoutMs?: number } = {}
): Promise<MigrationProject> {
  if (!adminPool) throw new Error('Call openAdminPool() in beforeAll.');
  const databaseName = `blendsdk_test_${randomUUID().replaceAll('-', '')}`;
  const environmentName = `BLENDSDK_TEST_${databaseName.toUpperCase()}_URL`;
  await adminPool.query(`CREATE DATABASE "${databaseName}"`);
  databaseNames.push(databaseName);

  const directory = await mkdtemp(join(process.cwd(), '.tmp-migrations-'));
  directories.push(directory);
  const migrationsDir = join(directory, 'migrations');
  await mkdir(migrationsDir);

  const configPath = join(directory, 'blendsdk.migrations.ts');
  await writeFile(
    configPath,
    `export default ${JSON.stringify({
      schema: './schema.ts',
      databaseUrlEnv: environmentName,
      lockTimeoutMs: options.lockTimeoutMs ?? 500,
      statementTimeoutMs: options.statementTimeoutMs ?? 30_000,
    })};\n`,
    'utf8'
  );

  const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:5597/${databaseName}`;
  process.env[environmentName] = databaseUrl;
  environmentNames.push(environmentName);

  const project: MigrationProject = {
    databaseUrl,
    configPath,
    migrationsDir,
    pool: new Pool({ connectionString: databaseUrl, max: 4 }),
  };
  projects.push(project);
  return project;
}

/** Writes the desired-schema module next to the migration configuration. */
export async function writeSchema(project: MigrationProject, body: string): Promise<void> {
  await writeFile(
    join(dirname(project.configPath), 'schema.ts'),
    `import { DatabaseSchema } from 'blendsdk/codegen';\n${body}\n`,
    'utf8'
  );
}

/** Writes one strict, reviewable migration fixture. */
export async function writeMigrationFixture(
  project: MigrationProject,
  id: string,
  body: string,
  options: { readonly transaction?: boolean; readonly downBody?: string } = {}
): Promise<string> {
  const upPath = join(project.migrationsDir, `${id}.up.sql`);
  await writeFile(upPath, migrationFile(id, body, options.transaction), 'utf8');
  if (options.downBody !== undefined) {
    await writeFile(
      join(project.migrationsDir, `${id}.down.sql`),
      migrationFile(id, options.downBody, options.transaction),
      'utf8'
    );
  }
  return upPath;
}

function migrationFile(id: string, body: string, transaction = true): string {
  return [
    '-- blendsdk-migration: 1',
    `-- id: ${id}`,
    `-- transaction: ${transaction}`,
    '-- from-snapshot: none',
    '-- to-snapshot: none',
    body.trimEnd(),
    '',
  ].join('\n');
}

/** Captures a typed failure and pins its kind and process exit class. */
export async function expectMigrationError(
  action: () => Promise<unknown>,
  expected: { readonly kind: MigrationError['kind']; readonly exitCode: 1 | 2 }
): Promise<MigrationError> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof MigrationError)) throw error;
    expect(error.kind).toBe(expected.kind);
    expect(error.exitCode).toBe(expected.exitCode);
    return error;
  }
  throw new Error('Expected a typed MigrationError.');
}

/** Ends owned pools, removes fixtures, and drops owned databases. */
export async function cleanupMigrationProjects(): Promise<void> {
  await Promise.all(projects.splice(0).map(project => project.pool.end().catch(() => undefined)));
  for (const name of environmentNames.splice(0)) delete process.env[name];
  await Promise.all(
    directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
  if (!adminPool) return;
  for (const databaseName of databaseNames.splice(0).reverse()) {
    await adminPool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [
      databaseName,
    ]);
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  }
}

/** Closes the administrative pool after the suite owns no databases. */
export async function closeAdminPool(): Promise<void> {
  await adminPool?.end();
  adminPool = undefined;
}
```

### PostgreSQL fixture (Docker)

The package's compose file starts a single `postgres-test` service:

| Setting | Value |
| --- | --- |
| Host | `127.0.0.1` (`localhost` also works) |
| Port | `5597` |
| Maintenance database | `postgres` |
| Introspection database | `introspect` |
| User / password | `testdb` / `testdb` |

Introspection tests read connection overrides from the environment so a suite can point at a different instance:

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const introspectDatabase = {
  host: process.env.CODEGEN_PG_HOST ?? 'localhost',
  port: Number(process.env.CODEGEN_PG_PORT ?? 5597),
  database: process.env.CODEGEN_PG_DATABASE ?? 'introspect',
  user: process.env.CODEGEN_PG_USER ?? 'testdb',
  pass: process.env.CODEGEN_PG_PASSWORD ?? 'testdb',
};

const db = new PostgreSQLDatabase(introspectDatabase);
```

Migration suites use the administrative `postgres` database only to create and drop *per-test* databases, so tests never share state.

---

## Unit Testing

Unit tests here are text-in/text-out. The most valuable assertion is either the exact contract-bearing line (`export interface Customer`, `ALTER TABLE "public"."customer"`) or a structural property of the output (`startsWith` the generated marker). Generators return Prettier-formatted source, so assert on stable fragments rather than incidental whitespace.

### A synchronous unit test

The schema DSL validates at authoring time and throws synchronously. This is the cheapest possible test and pins the registry rules.

```typescript
import { describe, expect, test } from 'vitest';
import { SchemaContainer } from 'blendsdk/codegen';

describe('schema authoring', () => {
  test('rejects a duplicate identity inside one scope', () => {
    const container = new SchemaContainer();
    container.scope().string().named('status');

    expect(() => container.scope().string().named('status')).toThrow(/already exists/u);
  });

  test('allows the same identity in different scopes', () => {
    const container = new SchemaContainer();
    container.scope().string().named('status');
    container.scope('audit').string().named('status');

    expect(container.scope('audit').find('status')).toBeDefined();
  });
});
```

### An asynchronous unit test

Generators are asynchronous because they normalize their output through Prettier. Await them and assert on the formatted text.

```typescript
import { describe, expect, test } from 'vitest';
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

describe('type generation', () => {
  test('emits an interface for a plain object and a type alias for a modified one', async () => {
    const container = new SchemaContainer();
    const scope = container.scope();

    scope.object({ id: scope.number(), label: scope.string().optional() }).named('Customer');
    scope.object({ id: scope.number() }).named('CustomerPatch').partial();

    const source = await new TypeGenerator().generate(container);

    expect(source).toContain('export interface Customer {');
    expect(source).toContain('label?: string;');
    expect(source).toContain('export type CustomerPatch = Partial<{');
  });
});
```

### Asserting modifier order

Modifiers compose in a fixed order (`Partial` → array → `Record` → nullable), so one test should pin it rather than sprinkling order assumptions everywhere.

```typescript
import { expect, test } from 'vitest';
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

test('applies array before nullable', async () => {
  const container = new SchemaContainer();
  container.scope().string().arrayed().nullable().named('tags');

  const source = await new TypeGenerator().generate(container);

  expect(source).toContain('export type Tags = string[] | null;');
});
```

### What *not* to assert

| Avoid | Assert instead |
| --- | --- |
| Full generated files in ordinary feature tests | The contract-bearing line (`export interface Customer {`) |
| Whitespace such as tabs or blank lines | Token presence with `toContain` / regex |
| Ordering that the generator does not guarantee | Ordering the generator sorts (components, paths, columns) |

Full-file equality belongs in the determinism tests, where it is the point.

---

## Integration Testing

### Filesystem: generate, then check

The client generator is a filesystem contract: it writes a fixed file set, stamps a marker, and later regenerates in memory to detect drift. Test both halves against a real temporary directory.

```typescript
import { afterEach, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkClient, generateClient } from 'blendsdk/codegen';
import { jsonSuccess, openApiDocument } from '../support/openapi-fixtures.js';
import { removeTemporaryDirectories, temporaryDirectory } from '../support/temporary-directory.js';

const GENERATED_MARKER = '// Generated by `blendsdk api generate` — do not edit by hand.';

afterEach(removeTemporaryDirectories);

function productsDocument() {
  return openApiDocument(
    {
      '/api/products': {
        get: {
          operationId: 'listProducts',
          tags: ['products'],
          responses: jsonSuccess({ type: 'array', items: { type: 'object' } }),
        },
      },
    },
    { Product: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } }
  );
}

test('writes the documented file set and reports no drift immediately after', async () => {
  const directory = await temporaryDirectory();
  const document = productsDocument();

  const generated = await generateClient(document, { outputDir: directory });

  expect(generated.files).toEqual(['client.ts', 'index.ts', 'types.ts']);
  const client = await readFile(join(directory, 'client.ts'), 'utf8');
  expect(client.startsWith(GENERATED_MARKER)).toBe(true);
  expect(client).toContain('listProducts');

  const checked = await checkClient(document, { outputDir: directory });
  expect(checked.drifted).toBe(false);
  expect(checked.issues).toEqual([]);
});
```

### PostgreSQL: one disposable database per test

Database tests follow a fixed lifecycle: open the admin pool once, create an isolated database and project per test, use it, then drop it. Never share a database between tests; never reuse one across files.

```typescript
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { generateBaseline, runMigrations } from 'blendsdk/codegen';
import {
  cleanupMigrationProjects,
  closeAdminPool,
  createMigrationProject,
  openAdminPool,
  writeSchema,
} from '../support/migration-project.js';

beforeAll(openAdminPool);
afterEach(cleanupMigrationProjects);
afterAll(closeAdminPool);

describe.sequential('baseline through the runner', () => {
  test('applies the baseline SQL and records the exact ledger row', async () => {
    const project = await createMigrationProject();
    await writeSchema(
      project,
      `const schema = new DatabaseSchema('app');
const customer = schema.table('customer');
customer.bigint('id').primaryKey();
customer.text('email').nullable();
export default schema;`
    );

    const baseline = await generateBaseline({
      name: 'initial',
      configPath: project.configPath,
      now: new Date('2026-08-27T09:00:00Z'),
    });
    expect(baseline.status).toBe('GENERATED');

    const applied = await runMigrations({ command: 'up', configPath: project.configPath });

    expect(applied.status).toBe('UP_TO_DATE');
    expect(applied.migrations.map(migration => migration.id)).toEqual([baseline.migration.id]);
    const table = await project.pool.query<{ name: string | null }>(
      "SELECT to_regclass('public.customer') AS name"
    );
    expect(table.rows[0]?.name).toBe('customer');
  });
});
```

`describe.sequential` matters: two tests in the same file must not compete for the advisory lock or for the same database.

### CLI: run the real executable

The `blendsdk api` and `blendsdk migrate` commands are best tested in a subprocess because their exit codes *are* the contract. Keep the fixture inside the project tree so `jiti` can resolve `blendsdk/codegen`.

```typescript
import { afterEach, expect, test } from 'vitest';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from '../support/cli-runner.js';
import { removeTemporaryDirectories, temporaryDirectory } from '../support/temporary-directory.js';

afterEach(removeTemporaryDirectories);

function apiContractSource(): string {
  return `
import { defineApiContract } from 'blendsdk/codegen';

class ProductsController {
  routes() {
    return [
      {
        method: 'get',
        path: '/',
        handler: () => undefined,
        openapi: {
          operationId: 'listProducts',
          tags: ['products'],
          responses: [{ statusCode: 200, description: 'Success', schema: {} }],
        },
      },
    ];
  }
}

export default defineApiContract({
  outputDir: 'client',
  contractFile: 'api.json',
  controllers: [{ basePath: '/api/products', controller: ProductsController }],
  openapi: { title: 'CLI API', version: '1.0.0' },
});
`;
}

test('generate writes both artifacts, check passes, and drift fails with exit 1', async () => {
  const directory = await temporaryDirectory(process.cwd(), '.tmp-api-');
  const configPath = join(directory, 'blendsdk.api.ts');
  await writeFile(configPath, apiContractSource(), 'utf8');

  const generated = await runCli(['api', 'generate', '--config', configPath]);
  expect(generated.exitCode).toBe(0);
  expect(await readFile(join(directory, 'api.json'), 'utf8')).toContain('"openapi": "3.1.0"');

  const clean = await runCli(['api', 'check', '--config', configPath]);
  expect(clean.exitCode).toBe(0);

  await appendFile(join(directory, 'client', 'client.ts'), '\n// hand edit\n', 'utf8');
  const drifted = await runCli(['api', 'check', '--config', configPath]);

  expect(drifted.exitCode).toBe(1);
  expect(drifted.stderr).toContain('client.ts');
});
```

### Release-gate smoke test

The strongest integration check packs the publishable umbrella and exercises the extracted tarball:

1. `npm pack` the assembled package into a temporary directory.
2. `tar -xzf` the archive and rename the extracted `package/` directory to `node_modules/blendsdk`.
3. Link only the runtime dependencies the package declares.
4. Import `dist/codegen/index.js` and assert the public entry points exist.
5. Run `node_modules/.bin/blendsdk migrate --help`.

This proves the executable, the shebang target, and the public re-exports without a database driver installed. Keep it out of the fast suite — it shells out to `npm` and `tar`.

---

## Mocking & Stubbing

The package is deliberately shaped so most tests need no mocks:

- Generators take in-memory input and return strings.
- Filesystem writers take an explicit `outputDir`; use a temporary directory instead of mocking `node:fs`.
- The CLIs return exit codes and write through caller-owned functions.
- `pg` is imported lazily inside the functions that connect, so generation and offline validation never load a driver.
- Time is injected (`now`) rather than read from the clock.

| Situation | Recommended technique |
| --- | --- |
| Generated file output | Real temporary directory |
| PostgreSQL behaviour | Real disposable database |
| Migration timestamps | Pass `now: new Date(...)` |
| Database URL | `process.env` or `vi.stubEnv` |
| Introspection fallback warnings | `vi.spyOn(console, 'log')` |
| Optional driver absence | Test only the offline code paths |

### Stubbing the clock

Two generations in the same second would collide on the second-resolution migration identifier. Inject `now` and the test is deterministic.

```typescript
import { expect, test } from 'vitest';
import { generateMigration } from 'blendsdk/codegen';
import {
  cleanupMigrationProjects,
  closeAdminPool,
  createMigrationProject,
  openAdminPool,
  writeSchema,
} from '../support/migration-project.js';
import { afterAll, afterEach, beforeAll } from 'vitest';

beforeAll(openAdminPool);
afterEach(cleanupMigrationProjects);
afterAll(closeAdminPool);

test('derives the migration identifier from the injected clock', async () => {
  const project = await createMigrationProject();
  await writeSchema(
    project,
    `const schema = new DatabaseSchema('app');
schema.table('widget').bigint('id').primaryKey();
export default schema;`
  );

  const result = await generateMigration({
    name: 'add-widget',
    configPath: project.configPath,
    now: new Date('2026-08-27T10:00:00Z'),
  });

  expect(result.status).toBe('GENERATED');
  expect(result.migration?.id).toBe('20260827100000_add-widget');
});
```

### Spying on introspection warnings

`PostgreSQLIntrospector` logs a warning when a PostgreSQL type has no mapping and falls back to `any` with an `@deprecated` description. That fallback is observable through `console.log`, so spy on it and restore in `finally`.

```typescript
import { afterEach, expect, test, vi } from 'vitest';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { PostgreSQLIntrospector, SchemaContainer } from 'blendsdk/codegen';

const connection = {
  host: process.env.CODEGEN_PG_HOST ?? 'localhost',
  port: Number(process.env.CODEGEN_PG_PORT ?? 5597),
  database: process.env.CODEGEN_PG_DATABASE ?? 'introspect',
  user: process.env.CODEGEN_PG_USER ?? 'testdb',
  pass: process.env.CODEGEN_PG_PASSWORD ?? 'testdb',
};

const databases: PostgreSQLDatabase[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map(database => database.disconnect()));
});

test('warns once for a PostgreSQL type it cannot map', async () => {
  const db = new PostgreSQLDatabase(connection);
  databases.push(db);
  const table = `interval_probe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  try {
    await db.executeQuery(`CREATE TABLE public."${table}" (duration interval)`);
    await new PostgreSQLIntrospector(db).introspect(new SchemaContainer());

    const warnings = log.mock.calls
      .map(args => String(args[0]))
      .filter(line => line.includes(table) && line.includes('could not be mapped'));

    expect(warnings).toHaveLength(1);
  } finally {
    log.mockRestore();
    await db.executeQuery(`DROP TABLE IF EXISTS public."${table}"`);
  }
});
```

### Environment variables

Use `vi.stubEnv` for a single test, or `process.env` in a fixture whose cleanup you control. Either way, clean up so a failure cannot leak credentials into the next test.

```typescript
import { afterEach, expect, test, vi } from 'vitest';
import { validateMigrations } from 'blendsdk/codegen';
import {
  cleanupMigrationProjects,
  closeAdminPool,
  createMigrationProject,
  openAdminPool,
  writeMigrationFixture,
} from '../support/migration-project.js';
import { afterAll, beforeAll } from 'vitest';

beforeAll(openAdminPool);
afterEach(() => {
  cleanupMigrationProjects();
  vi.unstubAllEnvs();
});
afterAll(closeAdminPool);

test('offline validation needs no database URL', async () => {
  const project = await createMigrationProject();
  await writeMigrationFixture(project, '20260827120000_offline', 'SELECT 1;');
  vi.stubEnv('BLENDSDK_TEST_URL', '');

  const result = await validateMigrations({ configPath: project.configPath, offline: true });

  expect(result.status).toBe('UP_TO_DATE');
});
```

### What not to mock

- **Do not mock `pg`.** A fake driver proves nothing about the ledger, lock, or transaction behaviour. Test the offline path or use a disposable database.
- **Do not mock `node:fs`.** The artifact writer's guarantees (exclusive create, rollback of the file it created, no symlink follow) are exactly the behaviours worth proving against a real filesystem.
- **Do not use fake timers** for migration execution. The runner uses monotonic time for durations and real PostgreSQL timeouts; inject `now` for identifiers instead.

---

## Test Patterns by Feature

### 1. Schema DSL and the registry

The registry owns names and scopes. Test duplicate rejection, scope isolation, and reference resolution.

```typescript
import { describe, expect, test } from 'vitest';
import { ObjectSchema, SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

describe('schema registry', () => {
  test('resolves a reference to the same scoped object', async () => {
    const container = new SchemaContainer();
    const scope = container.scope();
    const address = scope.object({ street: scope.string() }).named('Address');
    scope.object({ shipping: scope.ref(address).nullable() }).named('Order');

    const source = await new TypeGenerator().generate(container);

    expect(source).toContain('export interface Address {');
    expect(source).toContain('shipping: Address | null;');
  });

  test('stores object properties and marks them as children', () => {
    const container = new SchemaContainer();
    const scope = container.scope();
    scope.object({ id: scope.number() }).named('Row');

    const row = container.find(undefined, 'Row');
    expect(row).toBeInstanceOf(ObjectSchema);
    if (!(row instanceof ObjectSchema)) throw new Error('Expected an object schema.');
    expect(row.getProperties().id?.hasParent()).toBe(true);
  });
});
```

### 2. String constraints

Constraints exist in three artifacts: authoring validation, generated JSDoc, generated Zod, and converted OpenAPI. Test all four.

```typescript
import { describe, expect, test } from 'vitest';
import { SchemaContainer, TypeGenerator, ZodGenerator, convertZodToJsonSchema } from 'blendsdk/codegen';
import { evaluateZodSchema } from '../support/evaluate-zod.js';

const PROJECT_NAME_PATTERN = '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$';

function projectNameContainer(): SchemaContainer {
  const container = new SchemaContainer();
  container
    .scope()
    .string()
    .pattern(PROJECT_NAME_PATTERN)
    .minLength(3)
    .maxLength(40)
    .named('project_name');
  return container;
}

describe('string constraints', () => {
  test('rejects malformed input at authoring time', () => {
    const container = new SchemaContainer();
    const value = container.scope().string();

    expect(() => value.pattern('[')).toThrow(/invalid pattern/iu);
    expect(() => value.pattern(/abc/iu)).toThrow(/flags/u);
    expect(() => value.minLength(-1)).toThrow(/non-negative integer/u);
    expect(() => value.maxLength(2.5)).toThrow(/non-negative integer/u);
  });

  test('documents the contract in the generated TypeScript', async () => {
    const source = await new TypeGenerator().generate(projectNameContainer());

    expect(source).toContain(`@pattern ${PROJECT_NAME_PATTERN}`);
    expect(source).toContain('@minLength 3');
    expect(source).toContain('@maxLength 40');
  });

  test('generated Zod enforces the contract at runtime', async () => {
    const source = await new ZodGenerator().generate(projectNameContainer());
    const schema = evaluateZodSchema(source, 'ProjectNameSchema');

    expect(schema.safeParse('a1-b2').success).toBe(true);
    expect(schema.safeParse('ab').success).toBe(false);
    expect(schema.safeParse('ABC').success).toBe(false);
    expect(schema.safeParse('a'.repeat(41)).success).toBe(false);
  });

  test('the same contract becomes OpenAPI keywords', async () => {
    const source = await new ZodGenerator().generate(projectNameContainer());
    const schema = evaluateZodSchema(source, 'ProjectNameSchema');
    const json = convertZodToJsonSchema(schema, 'input') as {
      pattern?: string;
      minLength?: number;
      maxLength?: number;
    };

    expect(json).toMatchObject({
      pattern: PROJECT_NAME_PATTERN,
      minLength: 3,
      maxLength: 40,
    });
  });
});
```

A pattern can contain `*/`. The generator escapes it inside the JSDoc; pin that so generated TypeScript cannot be broken by a developer-supplied pattern.

```typescript
import { expect, test } from 'vitest';
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

test('a pattern cannot terminate the generated JSDoc', async () => {
  const container = new SchemaContainer();
  container.scope().string().pattern('[*/; globalThis.pwned = 1; /*]').named('danger');

  const source = await new TypeGenerator().generate(container);
  const patternLine = source.split('\n').find(line => line.includes('@pattern'));

  expect(patternLine).toBeDefined();
  expect(patternLine).toContain('*\\/');
});
```

### 3. TypeScript type generation

Assert the declaration form (`interface` versus `type`) and the modifier suffixes.

```typescript
import { expect, test } from 'vitest';
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

test('uses scoped names for type identifiers', async () => {
  const container = new SchemaContainer();
  const v1 = container.scope('api_v1');
  v1.object({ id: v1.number() }).named('user_request');
  const v2 = container.scope('api_v2');
  v2.object({ id: v2.string() }).named('user_request');

  const source = await new TypeGenerator().generate(container);

  expect(source).toContain('export interface ApiV1UserRequest {');
  expect(source).toContain('export interface ApiV2UserRequest {');
});

test('emits a literal union for enum values', async () => {
  const container = new SchemaContainer();
  container.scope().string().enum(['up', 'down']).named('direction');

  const source = await new TypeGenerator().generate(container);

  expect(source).toContain('export type Direction = ( \'up\' | \'down\' );');
});
```

The last assertion is intentionally tolerant of the parenthesized union the emitter produces; if you only care that the literals are present, assert `toContain("'up' | 'down'")`.

### 4. Zod generation

The Zod generator mirrors the type output. Test the optional/nullable ordering and the binary expression.

```typescript
import { describe, expect, test } from 'vitest';
import { SchemaContainer, ZodGenerator } from 'blendsdk/codegen';

describe('zod generation', () => {
  test('applies optional before nullable on properties', async () => {
    const container = new SchemaContainer();
    const scope = container.scope();
    scope
      .object({ source_ip: scope.string().optional().nullable(), payload: scope.binary() })
      .named('Row');

    const source = await new ZodGenerator().generate(container);

    expect(source).toContain('source_ip: z.string().optional().nullable()');
    expect(source).toContain('payload: z.instanceof(Buffer)');
  });

  test('renders a standalone unknown primitive', async () => {
    const container = new SchemaContainer();
    container.scope().unknown().named('payload');

    const source = await new ZodGenerator().generate(container);

    expect(source).toContain('export const PayloadSchema = z.unknown();');
  });
});
```

### 5. PostgreSQL DDL

`PostgreSQLSchemaGenerator` emits bootstrap DDL, not migrations. Assert on the statements, and use `generateGrouped()` when you need sections separately.

```typescript
import { describe, expect, test } from 'vitest';
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

function inventorySchema() {
  const schema = new DatabaseSchema('app');
  const item = schema.table('item');
  item.bigint('id').primaryKey();
  item.text('sku').unique();
  item.index().indexName('item_sku_idx').column('sku');
  schema.view('item_view').as('SELECT id FROM item').comment('items');
  return schema;
}

describe('bootstrap DDL', () => {
  test('separates schema, indexes, and views', () => {
    const grouped = new PostgreSQLSchemaGenerator(inventorySchema()).generateGrouped();

    expect(grouped.schema).toContain('CREATE TABLE public.item');
    expect(grouped.indexes).toContain('CREATE INDEX item_sku_idx ON public.item');
    expect(grouped.views).toContain('CREATE OR REPLACE VIEW public.item_view');
    expect(grouped.all).toContain('CREATE TABLE public.item');
    expect(grouped.all).toContain('CREATE INDEX item_sku_idx');
  });

  test('omits drop statements when requested', () => {
    const ddl = new PostgreSQLSchemaGenerator(inventorySchema()).generateGrouped({
      dropBeforeCreate: false,
    });

    expect(ddl.schema).not.toContain('DROP TABLE');
  });
});
```

Deferrable foreign keys are a package-level feature with a single source of truth: the authored mode.

```typescript
import { expect, test } from 'vitest';
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

test('renders the authored deferrability mode', () => {
  const schema = new DatabaseSchema('app');
  const secrets = schema.table('secrets');
  secrets.bigint('id').primaryKey();
  const versions = schema.table('secret_versions');
  versions.bigint('id').primaryKey();
  versions.bigint('secret_id');
  versions.foreignKeyConstraint(secrets).from('secret_id').to('id').deferrable('DEFERRED');

  const ddl = new PostgreSQLSchemaGenerator(schema).generate();

  expect(ddl).toContain('DEFERRABLE INITIALLY DEFERRED');
  expect(ddl).not.toMatch(/CASCADE/u);
});
```

`deferrable()` validates its runtime argument, so an untyped JavaScript caller cannot emit invalid DDL:

```typescript
import { expect, test } from 'vitest';
import { DatabaseSchema } from 'blendsdk/codegen';

test('rejects an unsupported deferrability mode at runtime', () => {
  const schema = new DatabaseSchema('app');
  const parent = schema.table('parent');
  parent.bigint('id').primaryKey();
  const child = schema.table('child');
  child.bigint('parent_id');
  const constraint = child.foreignKeyConstraint(parent).from('parent_id').to('id');

  expect(() => constraint.deferrable('SOMETIMES' as 'DEFERRED')).toThrow(
    /Unsupported foreign key deferrability/u
  );
});
```

### 6. OpenAPI documents

`OpenAPIGenerator` is opt-in: only routes carrying `openapi` metadata appear in the document. Test filtering, path conversion, parameters, request bodies, security, and the response envelope.

```typescript
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { RouteDefinition } from 'blendsdk/webafx';
import { OpenAPIGenerator } from 'blendsdk/codegen';

function route(overrides: Partial<RouteDefinition>): RouteDefinition {
  return { method: 'get', path: '/', handler: () => undefined, ...overrides } as RouteDefinition;
}

describe('openapi generation', () => {
  test('includes only routes that opt in', () => {
    const generator = new OpenAPIGenerator({ title: 'Test API', version: '1.0.0' });
    generator.addRoutes('/api/products', [
      route({ path: '/', openapi: { summary: 'List products' } }),
      route({ path: '/internal' }),
    ]);

    const document = generator.generate();

    expect(Object.keys(document.paths)).toEqual(['/api/products']);
    expect(document.paths['/api/products'].get?.['x-blend-envelope']).toBe('data');
  });

  test('converts Express parameters and only builds bodies for POST/PUT/PATCH', () => {
    const generator = new OpenAPIGenerator({ title: 'Test API', version: '1.0.0' });
    generator.addRoutes('/api/products', [
      route({
        method: 'post',
        path: '/',
        validation: z.object({ name: z.string().min(1), price: z.number().positive() }),
        openapi: { summary: 'Create product' },
      }),
      route({
        method: 'get',
        path: '/:id',
        validation: z.object({ page: z.coerce.number().default(1) }),
        openapi: { summary: 'Get product' },
      }),
    ]);

    const document = generator.generate();
    const post = document.paths['/api/products'].post;
    const get = document.paths['/api/products/{id}'].get;

    expect(post?.requestBody?.required).toBe(true);
    expect(post?.requestBody?.content['application/json']?.schema).toMatchObject({ type: 'object' });
    expect(get?.requestBody).toBeUndefined();
    expect(get?.parameters?.map(parameter => parameter.name)).toEqual(['id', 'page']);
  });

  test('applies the configured default security to secure routes only', () => {
    const generator = new OpenAPIGenerator({
      title: 'Test API',
      version: '1.0.0',
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      defaultSecurity: [{ bearerAuth: [] }],
    });
    generator.addRoutes('/api', [
      route({ path: '/admin', secure: true, openapi: { summary: 'Admin' } }),
      route({ path: '/public', openapi: { summary: 'Public' } }),
    ]);

    const document = generator.generate();

    expect(document.paths['/api/admin'].get?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/api/public'].get?.security).toBeUndefined();
  });
});
```

### 7. Zod to JSON Schema and `$defs` hoisting

`convertZodToJsonSchema` normalizes draft-2020-12 output for OpenAPI 3.1. Pin the nullability shape: OpenAPI 3.1 consumers read `type: ['string', 'null']`, not `nullable: true`.

```typescript
import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  convertZodToJsonSchema,
  convertZodToQueryParameters,
  hoistDefinitions,
} from 'blendsdk/codegen';
import type { OpenAPIDocument } from 'blendsdk/codegen';

test('converts nullable fields to a type array', () => {
  expect(convertZodToJsonSchema(z.string().nullable(), 'input')).toEqual({
    type: ['string', 'null'],
  });
  expect(convertZodToJsonSchema(z.object({ nickname: z.string().nullable() }), 'input')).toMatchObject({
    properties: { nickname: { type: ['string', 'null'] } },
  });
});

test('splits a query object into required and optional parameters', () => {
  const parameters = convertZodToQueryParameters(
    z.object({ page: z.coerce.number().default(1), search: z.string().optional() })
  );

  expect(parameters.find(parameter => parameter.name === 'page')).toMatchObject({
    in: 'query',
    schema: { type: 'number', default: 1 },
  });
  expect(parameters.find(parameter => parameter.name === 'search')?.required).toBeUndefined();
});

test('hoists reusable definitions into components.schemas', () => {
  const product = z.object({ id: z.number(), name: z.string() }).meta({ id: 'Product' });
  const schema = convertZodToJsonSchema(z.object({ a: product, b: product }), 'input');
  const document: OpenAPIDocument = {
    openapi: '3.1.0',
    info: { title: 'Test API', version: '1.0.0' },
    paths: {
      '/products': {
        get: {
          responses: {
            200: {
              description: 'Success',
              content: { 'application/json': { schema } },
            },
          },
        },
      },
    },
  };

  const hoisted = hoistDefinitions(document);

  expect(hoisted.components?.schemas?.Product).toBeDefined();
  expect(JSON.stringify(hoisted)).not.toContain('$defs');
  expect(Object.keys(hoisted.components?.schemas ?? {})).toEqual(
    Object.keys(hoisted.components?.schemas ?? {}).sort()
  );
});
```

### 8. Typed API clients

Test the consumer-visible file contract: the file set, the marker, the method names, deterministic output, pruning, and the strictness split between `generate` and `check`.

```typescript
import { afterEach, describe, expect, test } from 'vitest';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ClientGenerationError, checkClient, generateClient } from 'blendsdk/codegen';
import { jsonSuccess, openApiDocument } from '../support/openapi-fixtures.js';
import { removeTemporaryDirectories, temporaryDirectory } from '../support/temporary-directory.js';

afterEach(removeTemporaryDirectories);

function sampleDocument() {
  return openApiDocument(
    {
      '/api/products': {
        get: {
          operationId: 'listProducts',
          tags: ['products'],
          responses: jsonSuccess({ type: 'array', items: { type: 'object' } }),
        },
      },
      '/api/orders': {
        get: {
          operationId: 'listOrders',
          tags: ['orders'],
          responses: jsonSuccess({ type: 'object' }),
        },
      },
    },
    { Product: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } }
  );
}

describe('client generation', () => {
  test('is independent of declaration order', async () => {
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();
    const document = sampleDocument();
    const reversed = openApiDocument(
      { '/api/orders': document.paths['/api/orders'], '/api/products': document.paths['/api/products'] },
      document.components?.schemas
    );

    await generateClient(document, { outputDir: first });
    await generateClient(reversed, { outputDir: second });

    expect(await readFile(join(first, 'client.ts'), 'utf8')).toBe(
      await readFile(join(second, 'client.ts'), 'utf8')
    );
    expect(await readFile(join(first, 'types.ts'), 'utf8')).toBe(
      await readFile(join(second, 'types.ts'), 'utf8')
    );
  });

  test('prunes a generated group file that is no longer produced', async () => {
    const directory = await temporaryDirectory();
    const document = sampleDocument();
    await generateClient(document, { outputDir: directory, splitByGroup: true });
    expect(existsSync(join(directory, 'client.orders.ts'))).toBe(true);

    const reduced = openApiDocument({ '/api/products': document.paths['/api/products'] });
    await generateClient(reduced, { outputDir: directory, splitByGroup: true });

    expect(existsSync(join(directory, 'client.orders.ts'))).toBe(false);
  });

  test('never deletes a hand-written file', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'handwritten.ts'), 'export const keep = true;\n', 'utf8');

    await generateClient(sampleDocument(), { outputDir: directory });

    expect(existsSync(join(directory, 'handwritten.ts'))).toBe(true);
  });

  test('refuses two operations that share an operationId', async () => {
    const directory = await temporaryDirectory();
    const document = openApiDocument({
      '/api/a': {
        get: {
          operationId: 'duplicate',
          tags: ['a'],
          responses: jsonSuccess({ type: 'object' }),
        },
      },
      '/api/b': {
        post: {
          operationId: 'duplicate',
          tags: ['b'],
          responses: jsonSuccess({ type: 'object' }),
        },
      },
    });

    await expect(generateClient(document, { outputDir: directory })).rejects.toBeInstanceOf(
      ClientGenerationError
    );
  });
});

describe('naming and contract issues', () => {
  test('escapes a reserved operationId and reports a warning', async () => {
    const directory = await temporaryDirectory();
    const document = openApiDocument({
      '/api/products/{id}': {
        delete: {
          operationId: 'delete',
          tags: ['products'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: jsonSuccess({ type: 'object' }),
        },
      },
    });

    const result = await generateClient(document, { outputDir: directory });

    expect(await readFile(join(directory, 'client.ts'), 'utf8')).toMatch(/\bdelete_\b/u);
    expect(result.issues.some(issue => issue.severity === 'warning')).toBe(true);
  });

  test('derives a deterministic method name and a camelCase group', async () => {
    const directory = await temporaryDirectory();
    const document = openApiDocument({
      '/api/product-catalog/{id}': {
        get: {
          tags: ['product-catalog'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: jsonSuccess({ type: 'object' }),
        },
      },
    });

    const result = await generateClient(document, { outputDir: directory });
    const client = await readFile(join(directory, 'client.ts'), 'utf8');

    expect(client).toContain('productCatalog');
    expect(client).toContain('productsGetById');
    expect(result.issues.some(issue => issue.severity === 'warning')).toBe(true);
  });

  test('check escalates a missing operationId to an error, generate warns', async () => {
    const directory = await temporaryDirectory();
    const document = openApiDocument({
      '/api/products': {
        get: { tags: ['products'], responses: jsonSuccess({ type: 'object' }) },
      },
    });

    const generated = await generateClient(document, { outputDir: directory });
    expect(generated.issues.some(issue => issue.severity === 'warning')).toBe(true);

    const checked = await checkClient(document, { outputDir: directory });
    expect(checked.issues.some(issue => issue.severity === 'error')).toBe(true);
  });

  test('strict generation throws instead of warning', async () => {
    const directory = await temporaryDirectory();
    const document = openApiDocument({
      '/api/products': {
        get: { tags: ['products'], responses: jsonSuccess({ type: 'object' }) },
      },
    });

    await expect(
      generateClient(document, { outputDir: directory, strict: true })
    ).rejects.toBeInstanceOf(ClientGenerationError);
  });
});

describe('drift detection', () => {
  test('detects an edited committed file', async () => {
    const directory = await temporaryDirectory();
    const document = sampleDocument();
    await generateClient(document, { outputDir: directory });
    await appendFile(join(directory, 'client.ts'), '\n// hand edit\n', 'utf8');

    const result = await checkClient(document, { outputDir: directory });

    expect(result.drifted).toBe(true);
    expect(result.driftedFiles).toContain('client.ts');
  });
});
```

An operation name is data, never code. Pin that with an injection attempt:

```typescript
import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateClient } from 'blendsdk/codegen';
import { jsonSuccess, openApiDocument } from '../support/openapi-fixtures.js';
import { removeTemporaryDirectories, temporaryDirectory } from '../support/temporary-directory.js';
import { afterEach } from 'vitest';

afterEach(removeTemporaryDirectories);

test('an operationId cannot become a statement', async () => {
  const directory = await temporaryDirectory();
  const document = openApiDocument({
    "/api/evil'}": {
      get: {
        operationId: "evil'); process.exit(1); //",
        tags: ['evil'],
        responses: jsonSuccess({ type: 'object' }),
      },
    },
  });

  await generateClient(document, { outputDir: directory });

  expect(await readFile(join(directory, 'client.ts'), 'utf8')).not.toMatch(/^\s*process\.exit/mu);
  expect(await readFile(join(directory, 'types.ts'), 'utf8')).not.toMatch(/^\s*process\.exit/mu);
});
```

### 9. `blendsdk api` contract CLI

Exit codes are the contract: `0` success, `1` drift, `2` usage or configuration failure.

```typescript
import { afterEach, expect, test } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from '../support/cli-runner.js';
import { removeTemporaryDirectories, temporaryDirectory } from '../support/temporary-directory.js';

afterEach(removeTemporaryDirectories);

async function writeContract(directory: string): Promise<string> {
  const configPath = join(directory, 'blendsdk.api.ts');
  await writeFile(
    configPath,
    `
import { defineApiContract } from 'blendsdk/codegen';

class ProductsController {
  routes() {
    return [
      {
        method: 'get',
        path: '/',
        handler: () => undefined,
        openapi: {
          operationId: 'listProducts',
          tags: ['products'],
          responses: [{ statusCode: 200, description: 'Success', schema: {} }],
        },
      },
    ];
  }
}

export default defineApiContract({
  outputDir: 'client',
  contractFile: 'api.json',
  controllers: [{ basePath: '/api/products', controller: ProductsController }],
  openapi: { title: 'CLI API', version: '1.0.0' },
});
`,
    'utf8'
  );
  return configPath;
}

test('a missing configuration is a usage error and writes nothing', async () => {
  const directory = await temporaryDirectory(process.cwd(), '.tmp-api-');
  const missing = join(directory, 'missing.ts');

  const result = await runCli(['api', 'generate', '--config', missing]);

  expect(result.exitCode).toBe(2);
  await expect(readFile(join(directory, 'api.json'), 'utf8')).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

test('check reports contract drift and client drift separately', async () => {
  const directory = await temporaryDirectory(process.cwd(), '.tmp-api-');
  const configPath = await writeContract(directory);
  expect((await runCli(['api', 'generate', '--config', configPath])).exitCode).toBe(0);

  const contractPath = join(directory, 'api.json');
  const contract = JSON.parse(await readFile(contractPath, 'utf8')) as { info: { title: string } };
  contract.info.title = 'Changed title';
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');

  const result = await runCli(['api', 'check', '--config', configPath]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('api.json');
});
```

### 10. PostgreSQL introspection

Introspection is read-only against a real database. Use a unique table name so a shared fixture database cannot collide.

```typescript
import { afterEach, describe, expect, test } from 'vitest';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import {
  ObjectSchema,
  PostgreSQLIntrospector,
  SchemaContainer,
  TypeGenerator,
  ZodGenerator,
} from 'blendsdk/codegen';

const connection = {
  host: process.env.CODEGEN_PG_HOST ?? 'localhost',
  port: Number(process.env.CODEGEN_PG_PORT ?? 5597),
  database: process.env.CODEGEN_PG_DATABASE ?? 'introspect',
  user: process.env.CODEGEN_PG_USER ?? 'testdb',
  pass: process.env.CODEGEN_PG_PASSWORD ?? 'testdb',
};

const databases: PostgreSQLDatabase[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map(database => database.disconnect()));
});

function uniqueTableName(): string {
  return `json_probe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

describe('introspection', () => {
  test('maps json and jsonb to unknown', async () => {
    const db = new PostgreSQLDatabase(connection);
    databases.push(db);
    const table = uniqueTableName();
    const container = new SchemaContainer();

    try {
      await db.executeQuery(
        `CREATE TABLE public."${table}" (payload jsonb NOT NULL, metadata json)`
      );
      await new PostgreSQLIntrospector(db).introspect(container);

      const object = container.find(undefined, table);
      if (!(object instanceof ObjectSchema)) throw new Error('Expected an object schema.');
      expect(object.getProperties().payload?.getData().tsType).toBe('unknown');
      expect(object.getProperties().metadata?.getData().tsType).toBe('unknown');

      const types = await new TypeGenerator().generate(container);
      const validators = await new ZodGenerator().generate(container);
      expect(types).toContain('payload: unknown;');
      expect(validators).toContain('payload: z.unknown()');
    } finally {
      await db.executeQuery(`DROP TABLE IF EXISTS public."${table}"`);
    }
  });

  test('exposes qualified relation to column names', async () => {
    const db = new PostgreSQLDatabase(connection);
    databases.push(db);
    const table = uniqueTableName();

    try {
      await db.executeQuery(`CREATE TABLE public."${table}" (id text NOT NULL, payload jsonb)`);

      const types = await new PostgreSQLIntrospector(db).introspectConstantTypes();

      expect(types[table]).toEqual(['id', 'payload']);
    } finally {
      await db.executeQuery(`DROP TABLE IF EXISTS public."${table}"`);
    }
  });
});
```

`ColumnMapper` is the supported extension point. A mapper returns a schema object or `undefined` to fall through to the built-in mapping.

```typescript
import { expect, test } from 'vitest';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { PostgreSQLIntrospector, SchemaContainer, TypeGenerator } from 'blendsdk/codegen';
import type { ColumnMapper } from 'blendsdk/codegen';

test('a ColumnMapper can narrow a jsonb column', async () => {
  const db = new PostgreSQLDatabase({
    host: 'localhost',
    port: 5597,
    database: 'introspect',
    user: 'testdb',
    pass: 'testdb',
  });
  const table = `mapped_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const container = new SchemaContainer();

  try {
    await db.executeQuery(`CREATE TABLE public."${table}" (payload jsonb NOT NULL)`);
    const mapper: ColumnMapper = (column, scope) => {
      if (column.relation_name !== table || column.pg_type !== 'jsonb') return undefined;
      const mapped = scope.any();
      mapped.setData({
        tsType: 'Record<string, unknown>',
        zodExpression: 'z.record(z.string(), z.unknown())',
      });
      return mapped;
    };

    await new PostgreSQLIntrospector(db).introspect(container, mapper);

    expect(await new TypeGenerator().generate(container)).toContain(
      'payload: Record<string, unknown>;'
    );
  } finally {
    await db.executeQuery(`DROP TABLE IF EXISTS public."${table}"`);
    await db.disconnect();
  }
});
```

Binary and network columns round-trip through DDL, introspection, and snapshots:

```typescript
import { expect, test } from 'vitest';
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

test('emits bytea and inet columns', () => {
  const schema = new DatabaseSchema('app');
  const secrets = schema.table('secret_versions');
  secrets.bigserial('id').primaryKey();
  secrets.bytea('ciphertext').nullable();
  secrets.inet('source_ip').nullable();

  const ddl = new PostgreSQLSchemaGenerator(schema).generate();

  expect(ddl).toMatch(/ciphertext bytea/u);
  expect(ddl).toMatch(/source_ip inet/u);
});
```

### 11. Migration generation and snapshots

Generation is offline and deterministic. Test the artifacts that will be committed: the `*.up.sql` file and the canonical `schema.snapshot.json`.

```typescript
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { generateMigration } from 'blendsdk/codegen';
import {
  cleanupMigrationProjects,
  closeAdminPool,
  createMigrationProject,
  openAdminPool,
  writeSchema,
} from '../support/migration-project.js';

const FIRST = new Date('2026-08-27T09:00:00Z');
const LATER = new Date('2026-08-27T10:00:00Z');

function customerSchema(extra = ''): string {
  return `const schema = new DatabaseSchema('app');
const customer = schema.table('customer');
customer.bigint('id').primaryKey();
customer.text('email').nullable();
${extra}
export default schema;`;
}

beforeAll(openAdminPool);
afterEach(cleanupMigrationProjects);
afterAll(closeAdminPool);

describe.sequential('migration generation', () => {
  test('produces byte-identical snapshots regardless of declaration order', async () => {
    const first = await createMigrationProject();
    const second = await createMigrationProject();
    await writeSchema(
      first,
      `const schema = new DatabaseSchema('app');
schema.table('zebra').bigint('id').primaryKey();
schema.table('account').bigint('id').primaryKey();
export default schema;`
    );
    await writeSchema(
      second,
      `const schema = new DatabaseSchema('app');
schema.table('account').bigint('id').primaryKey();
schema.table('zebra').bigint('id').primaryKey();
export default schema;`
    );

    await generateMigration({ name: 'initial', configPath: first.configPath, now: FIRST });
    await generateMigration({ name: 'initial', configPath: second.configPath, now: FIRST });

    const snapshotName = 'schema.snapshot.json';
    expect(await readFile(join(first.migrationsDir, snapshotName), 'utf8')).toBe(
      await readFile(join(second.migrationsDir, snapshotName), 'utf8')
    );
  });

  test('renders a targeted ALTER for one nullable column', async () => {
    const project = await createMigrationProject();
    await writeSchema(project, customerSchema());
    await generateMigration({ name: 'initial', configPath: project.configPath, now: FIRST });

    await writeSchema(project, customerSchema(`customer.text('nickname').nullable();`));
    const result = await generateMigration({
      name: 'add-nickname',
      configPath: project.configPath,
      now: LATER,
    });

    if (!result.migration) throw new Error('Expected a generated migration.');
    const sql = await readFile(result.migration.upPath, 'utf8');

    expect(sql).toContain('ALTER TABLE "public"."customer" ADD COLUMN "nickname" text;');
    expect(sql).not.toMatch(/CASCADE|DROP TABLE|DROP SCHEMA/iu);
    expect(sql).toContain(`-- from-snapshot: ${result.previousSnapshot}`);
    expect(sql).toContain(`-- to-snapshot: ${result.desiredSnapshot}`);
  });

  test('reports UP_TO_DATE and rewrites nothing when the schema is unchanged', async () => {
    const project = await createMigrationProject();
    await writeSchema(project, customerSchema());
    await generateMigration({ name: 'initial', configPath: project.configPath, now: FIRST });
    const before = (await readdir(project.migrationsDir)).sort();

    const result = await generateMigration({
      name: 'nothing',
      configPath: project.configPath,
      now: LATER,
    });

    expect(result.status).toBe('UP_TO_DATE');
    expect((await readdir(project.migrationsDir)).sort()).toEqual(before);
  });

  test('writes no artifact when a required column needs a staged population', async () => {
    const project = await createMigrationProject();
    await writeSchema(project, customerSchema());
    await generateMigration({ name: 'initial', configPath: project.configPath, now: FIRST });

    await writeSchema(project, customerSchema(`customer.text('status');`));

    const error = await expectMigrationError(
      () => generateMigration({ name: 'add-status', configPath: project.configPath, now: LATER }),
      { kind: 'INVALID_HISTORY', exitCode: 1 }
    );

    expect(error.message).toMatch(/staged|population|manual/iu);
  });

  test('requires explicit approval for a destructive change', async () => {
    const project = await createMigrationProject();
    await writeSchema(project, customerSchema(`customer.text('nickname').nullable();`));
    await generateMigration({ name: 'initial', configPath: project.configPath, now: FIRST });

    await writeSchema(project, customerSchema());

    await expectMigrationError(
      () => generateMigration({ name: 'drop-nickname', configPath: project.configPath, now: LATER }),
      { kind: 'INVALID_HISTORY', exitCode: 1 }
    );

    const allowed = await generateMigration({
      name: 'drop-nickname',
      configPath: project.configPath,
      now: LATER,
      allowDestructive: true,
    });
    if (!allowed.migration) throw new Error('Expected a generated migration.');
    const sql = await readFile(allowed.migration.upPath, 'utf8');

    expect(sql).toContain('-- destructive: reviewed and explicitly allowed');
    expect(sql).toContain('DROP COLUMN "nickname"');
  });

  test('blocks an apparent table rename until a hint is supplied', async () => {
    const project = await createMigrationProject();
    await writeSchema(project, customerSchema());
    await generateMigration({ name: 'initial', configPath: project.configPath, now: FIRST });

    await writeSchema(project, customerSchema().replace(/'customer'/u, "'account'".replace('account', 'customer')));
    // Rewrite the table identity explicitly so the diff sees an apparent rename.
    await writeSchema(
      project,
      `const schema = new DatabaseSchema('app');
const account = schema.table('account');
account.bigint('id').primaryKey();
account.text('email').nullable();
export default schema;`
    );

    await expectMigrationError(
      () => generateMigration({ name: 'rename', configPath: project.configPath, now: LATER }),
      { kind: 'INVALID_HISTORY', exitCode: 1 }
    );

    const hinted = await generateMigration({
      name: 'rename',
      configPath: project.configPath,
      now: LATER,
      renameHints: [{ kind: 'table', from: 'public.customer', to: 'public.account' }],
    });
    if (!hinted.migration) throw new Error('Expected a generated migration.');

    const sql = await readFile(hinted.migration.upPath, 'utf8');
    expect(sql).toContain('ALTER TABLE "public"."customer" RENAME TO "account";');
    expect(sql).not.toMatch(/DROP TABLE|CREATE TABLE/iu);
  });
});
```

The canonical snapshot is a plain JSON file with a strict, stable shape. Assert the parts a reviewer cares about:

```typescript
import { afterEach, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateMigration } from 'blendsdk/codegen';
import {
  cleanupMigrationProjects,
  closeAdminPool,
  createMigrationProject,
  openAdminPool,
  writeSchema,
} from '../support/migration-project.js';
import { afterAll, beforeAll } from 'vitest';

beforeAll(openAdminPool);
afterEach(cleanupMigrationProjects);
afterAll(closeAdminPool);

test('snapshot bytes are canonical, LF-only, and free of runtime data', async () => {
  const project = await createMigrationProject();
  await writeSchema(
    project,
    `const schema = new DatabaseSchema('app');
const item = schema.table('item');
item.integer('zero').default(0);
item.boolean('disabled').default(false);
export default schema;`
  );

  await generateMigration({
    name: 'initial',
    configPath: project.configPath,
    now: new Date('2026-08-27T09:00:00Z'),
  });

  const text = await readFile(join(project.migrationsDir, 'schema.snapshot.json'), 'utf8');

  expect(text.endsWith('\n')).toBe(true);
  expect(text).not.toContain('\r');
  expect(text).not.toMatch(/createdAt|timestamp|postgres(?:ql)?:\/\//iu);
  const parsed = JSON.parse(text) as {
    formatVersion: number;
    tables: Array<{ columns: Array<{ name: string; default?: unknown }> }>;
  };
  expect(parsed.formatVersion).toBe(1);
  expect(parsed.tables[0]?.columns.map(column => [column.name, column.default])).toEqual([
    ['disabled', false],
    ['zero', 0],
  ]);
});
```

### 12. Baseline and existing-database adoption

`generateBaseline` creates exactly one initial migration and one snapshot, and refuses to run when either already exists.

```typescript
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { generateBaseline } from 'blendsdk/codegen';
import {
  cleanupMigrationProjects,
  closeAdminPool,
  createMigrationProject,
  openAdminPool,
  writeSchema,
} from '../support/migration-project.js';
import { expectMigrationError } from '../support/migration-project.js';

const FIXED_NOW = new Date('2026-08-27T09:00:00Z');

beforeAll(openAdminPool);
afterEach(cleanupMigrationProjects);
afterAll(closeAdminPool);

describe.sequential('baseline', () => {
  test('creates one complete migration and one canonical snapshot', async () => {
    const project = await createMigrationProject();
    await writeSchema(
      project,
      `const schema = new DatabaseSchema('app');
const customer = schema.table('customer');
customer.bigint('id').primaryKey();
customer.text('email').nullable();
export default schema;`
    );

    const result = await generateBaseline({
      name: 'initial',
      configPath: project.configPath,
      now: FIXED_NOW,
    });

    expect(result.status).toBe('GENERATED');
    expect((await readdir(project.migrationsDir)).sort()).toEqual([
      '20260827090000_initial.up.sql',
      'schema.snapshot.json',
    ]);
    const sql = await readFile(result.migration.upPath, 'utf8');
    expect(sql).toContain('CREATE TABLE "public"."customer"');
    expect(sql).not.toMatch(/CASCADE|DROP TABLE|DROP SCHEMA/iu);
  });

  test('preserves existing artifacts instead of overwriting them', async () => {
    const project = await createMigrationProject();
    await writeSchema(project, `const schema = new DatabaseSchema('app');\nexport default schema;`);
    await generateBaseline({ name: 'initial', configPath: project.configPath, now: FIXED_NOW });
    const before = (await readdir(project.migrationsDir)).sort();

    await expectMigrationError(
      () => generateBaseline({ name: 'again', configPath: project.configPath, now: FIXED_NOW }),
      { kind: 'INVALID_HISTORY', exitCode: 1 }
    );

    expect((await readdir(project.migrationsDir)).sort()).toEqual(before);
  });
});
```

Adoption proves an existing database equals the desired snapshot and then records history — it never executes the baseline SQL.

```typescript
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { adoptBaseline, generateBaseline } from 'blendsdk/codegen';
import {
  cleanupMigrationProjects,
  closeAdminPool,
  createMigrationProject,
  expectMigrationError,
  openAdminPool,
  writeSchema,
} from '../support/migration-project.js';

beforeAll(openAdminPool);
afterEach(cleanupMigrationProjects);
afterAll(closeAdminPool);

test('adopts an exact existing catalog after target confirmation', async () => {
  const project = await createMigrationProject();
  await writeSchema(
    project,
    `const schema = new DatabaseSchema('app');
const customer = schema.table('customer');
customer.bigint('id').primaryKey();
customer.text('email').nullable();
export default schema;`
  );
  const baseline = await generateBaseline({
    name: 'initial',
    configPath: project.configPath,
    now: new Date('2026-08-27T09:00:00Z'),
  });

  // Apply the baseline yourself: adoption must never execute it.
  const sql = await readFile(baseline.migration.upPath, 'utf8');
  await project.pool.query(sql.split('\n').slice(5).join('\n'));

  const database = new URL(project.databaseUrl).pathname.slice(1);
  const result = await adoptBaseline({
    configPath: project.configPath,
    confirmation: `${database}/${baseline.migration.id}`,
  });

  expect(result.status).toBe('ADOPTED');
  expect(result.comparison.every(item => item.classification === 'MATCH')).toBe(true);
});

test('reports a qualified mismatch and inserts no history', async () => {
  const project = await createMigrationProject();
  await writeSchema(
    project,
    `const schema = new DatabaseSchema('app');
const customer = schema.table('customer');
customer.bigint('id').primaryKey();
customer.text('email').nullable();
export default schema;`
  );
  const baseline = await generateBaseline({
    name: 'initial',
    configPath: project.configPath,
    now: new Date('2026-08-27T09:00:00Z'),
  });
  const sql = await readFile(baseline.migration.upPath, 'utf8');
  await project.pool.query(sql.split('\n').slice(5).join('\n'));
  await project.pool.query('ALTER TABLE public.customer ALTER COLUMN email TYPE varchar(40)');

  const database = new URL(project.databaseUrl).pathname.slice(1);
  const error = await expectMigrationError(
    () =>
      adoptBaseline({
        configPath: project.configPath,
        confirmation: `${database}/${baseline.migration.id}`,
      }),
    { kind: 'UNSUPPORTED', exitCode: 1 }
  );

  expect(error.message).toContain('DIFFERENT');
  expect(error.message).toContain('public.customer');
});
```

### 13. Migration runner

The runner has the richest set of observable states. Test each one through `runMigrations`, `getMigrationStatus`, and `validateMigrations`, and let a real PostgreSQL instance provide the truth.

```typescript
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { getMigrationStatus, runMigrations, validateMigrations } from 'blendsdk/codegen';
import {
  cleanupMigrationProjects,
  closeAdminPool,
  createMigrationProject,
  expectMigrationError,
  openAdminPool,
  writeMigrationFixture,
} from '../support/migration-project.js';

beforeAll(openAdminPool);
afterEach(cleanupMigrationProjects);
afterAll(closeAdminPool);

describe.sequential('migration runner', () => {
  test('reports PENDING, applies, then reports UP_TO_DATE', async () => {
    const project = await createMigrationProject();
    await writeMigrationFixture(
      project,
      '20260827120100_first',
      'CREATE TABLE first_table (id integer);'
    );

    expect((await getMigrationStatus({ configPath: project.configPath })).status).toBe('PENDING');

    const applied = await runMigrations({ command: 'up', configPath: project.configPath });
    expect(applied.status).toBe('UP_TO_DATE');

    expect((await getMigrationStatus({ configPath: project.configPath })).status).toBe('UP_TO_DATE');
    expect((await validateMigrations({ configPath: project.configPath })).status).toBe('UP_TO_DATE');
  });

  test('a dry run reports pending order without touching the database', async () => {
    const project = await createMigrationProject();
    await writeMigrationFixture(
      project,
      '20260827120100_first',
      'CREATE TABLE dry_run_guard (id integer);'
    );

    const result = await runMigrations({
      command: 'up',
      configPath: project.configPath,
      dryRun: true,
    });

    expect(result.status).toBe('PENDING');
    expect(result.migrations.map(migration => migration.id)).toEqual([
      '20260827120100_first',
    ]);
    const table = await project.pool.query<{ name: string | null }>(
      "SELECT to_regclass('public.dry_run_guard') AS name"
    );
    expect(table.rows[0]?.name).toBeNull();
  });

  test('rolls back a failing transactional migration and stops before the next file', async () => {
    const project = await createMigrationProject();
    await writeMigrationFixture(
      project,
      '20260827120100_broken',
      'CREATE TABLE rolled_back (id integer); SELECT missing_function();'
    );
    await writeMigrationFixture(
      project,
      '20260827120200_later',
      'CREATE TABLE not_attempted (id integer);'
    );

    await expectMigrationError(
      () => runMigrations({ command: 'up', configPath: project.configPath }),
      { kind: 'DATABASE', exitCode: 1 }
    );

    for (const name of ['rolled_back', 'not_attempted']) {
      const result = await project.pool.query<{ name: string | null }>(
        'SELECT to_regclass($1) AS name',
        [`public.${name}`]
      );
      expect(result.rows[0]?.name).toBeNull();
    }
  });

  test('down requires confirmation and reverts exactly the latest migration', async () => {
    const project = await createMigrationProject();
    await writeMigrationFixture(
      project,
      '20260827120100_first',
      'CREATE TABLE down_first (id integer);',
      { downBody: 'DROP TABLE down_first;' }
    );
    await writeMigrationFixture(
      project,
      '20260827120200_second',
      'CREATE TABLE down_second (id integer);',
      { downBody: 'DROP TABLE down_second;' }
    );
    await runMigrations({ command: 'up', configPath: project.configPath });

    await expectMigrationError(
      () => runMigrations({ command: 'down', configPath: project.configPath }),
      { kind: 'UNSUPPORTED', exitCode: 1 }
    );

    await runMigrations({ command: 'down', configPath: project.configPath, allowDown: true });

    const first = await project.pool.query<{ name: string | null }>(
      "SELECT to_regclass('public.down_first') AS name"
    );
    const second = await project.pool.query<{ name: string | null }>(
      "SELECT to_regclass('public.down_second') AS name"
    );
    expect(first.rows[0]?.name).toBe('down_first');
    expect(second.rows[0]?.name).toBeNull();
  });
});
```

Concurrency is tested with real sessions, not mocks:

```typescript
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { runMigrations } from 'blendsdk/codegen';
import {
  cleanupMigrationProjects,
  closeAdminPool,
  createMigrationProject,
  expectMigrationError,
  openAdminPool,
  writeMigrationFixture,
} from '../support/migration-project.js';

beforeAll(openAdminPool);
afterEach(cleanupMigrationProjects);
afterAll(closeAdminPool);

test('only one runner executes while the advisory lock is held', async () => {
  const project = await createMigrationProject({ lockTimeoutMs: 80, statementTimeoutMs: 30_000 });
  await writeMigrationFixture(
    project,
    '20260827120100_lock-race',
    'CREATE TABLE lock_race (id integer); SELECT pg_sleep(0.4);'
  );

  const first = runMigrations({ command: 'up', configPath: project.configPath });
  await new Promise(resolve => setTimeout(resolve, 40));
  const second = expectMigrationError(
    () => runMigrations({ command: 'up', configPath: project.configPath }),
    { kind: 'LOCKED', exitCode: 1 }
  );

  await first;
  await second;
  const rows = await project.pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM public.blendsdk_migrations"
  );
  expect(rows.rows[0]?.count).toBe(1);
});
```

Cancellation uses a real `AbortSignal`; the runner cancels the PostgreSQL backend and rolls back the open transaction.

```typescript
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { runMigrations } from 'blendsdk/codegen';
import {
  cleanupMigrationProjects,
  closeAdminPool,
  createMigrationProject,
  expectMigrationError,
  openAdminPool,
  writeMigrationFixture,
} from '../support/migration-project.js';

beforeAll(openAdminPool);
afterEach(cleanupMigrationProjects);
afterAll(closeAdminPool);

test('aborting an active migration rolls back and records nothing', async () => {
  const project = await createMigrationProject({ statementTimeoutMs: 10_000 });
  await writeMigrationFixture(
    project,
    '20260827120100_abort',
    'CREATE TABLE abort_active (id integer); SELECT pg_sleep(5);'
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 80);

  await expectMigrationError(
    () =>
      runMigrations({
        command: 'up',
        configPath: project.configPath,
        signal: controller.signal,
      }),
    { kind: 'ABORTED', exitCode: 1 }
  );
  clearTimeout(timer);

  const table = await project.pool.query<{ name: string | null }>(
    "SELECT to_regclass('public.abort_active') AS name"
  );
  expect(table.rows[0]?.name).toBeNull();
  expect((await getMigrationStatus({ configPath: project.configPath })).status).toBe('PENDING');
});
```

### 14. Error contract

Every expected migration failure is a `MigrationError` with a stable `kind` and process exit class. Pin both, and pin that operator output never leaks connection strings or SQL bodies.

```typescript
import { describe, expect, test } from 'vitest';
import { MigrationError, formatMigrationError } from 'blendsdk/codegen';

describe('migration error contract', () => {
  test('redacts database URLs and credential assignments', () => {
    const error = new MigrationError({
      kind: 'DATABASE',
      exitCode: 1,
      message:
        'Connection postgresql://operator:secret@example.test/db failed with password=second-secret',
    });

    const rendered = formatMigrationError(error);

    expect(rendered.startsWith('DATABASE: ')).toBe(true);
    expect(rendered).not.toContain('operator');
    expect(rendered).not.toContain('secret');
    expect(rendered).toContain('[REDACTED_DATABASE_URL]');
  });

  test('never retains the sensitive detail it is given', () => {
    const error = new MigrationError({
      kind: 'UNSUPPORTED',
      exitCode: 1,
      message: 'The change requires reviewed manual SQL.',
      sensitiveDetail: 'ALTER TABLE customer ADD COLUMN password text;',
    });

    expect(JSON.stringify(error)).not.toContain('ALTER TABLE');
    expect(error.message).not.toContain('password');
  });
});
```

### 15. Constant type generation

`CTypeGenerator` turns a qualified relation-to-column map into constant objects. It takes plain data, so it is a pure unit test.

```typescript
import { expect, test } from 'vitest';
import { CTypeGenerator } from 'blendsdk/codegen';

test('emits one constant object per relation', async () => {
  const source = await new CTypeGenerator().generate({
    'public.customer': ['id', 'email', 'created_at'],
  });

  expect(source).toContain('export const ePublicCustomer = {');
  expect(source).toContain("$TABLE: 'public.customer'");
  expect(source).toContain("CREATED_AT: 'created_at'");
});
```

---

## Test Matrix

| Feature | Entry points under test | Requires PostgreSQL | Requires filesystem |
| --- | --- | --- | --- |
| Schema authoring | `SchemaContainer`, `SchemaScope`, schema classes | No | No |
| Type generation | `TypeGenerator` | No | No |
| Zod generation | `ZodGenerator`, `evaluateZodSchema` helper | No | No |
| String constraints | `StringSchema`, both generators, `convertZodToJsonSchema` | No | No |
| Bootstrap DDL | `DatabaseSchema`, `PostgreSQLSchemaGenerator` | No | No |
| OpenAPI documents | `OpenAPIGenerator` | No | No |
| Zod → JSON Schema | `convertZodToJsonSchema`, `convertZodToQueryParameters`, `hoistDefinitions` | No | No |
| Typed clients | `generateClient`, `checkClient` | No | Yes |
| Contract CLI | `blendsdk api generate\|check` | No | Yes (subprocess) |
| Introspection | `PostgreSQLIntrospector` | Yes | No |
| Migration generation | `generateMigration`, `generateBaseline` | No | Yes |
| Runner and status | `runMigrations`, `getMigrationStatus`, `validateMigrations` | Yes | Yes |
| Baseline adoption | `adoptBaseline` | Yes | Yes |
| Constant types | `CTypeGenerator` | No | No |

Two rules keep the suite fast and trustworthy:

1. **Push every assertion down to the cheapest tier that can prove it.** A generated validator's behaviour belongs in a unit test; only the ledger, lock, and transaction semantics need a database.
2. **Assert what the consumer sees.** File sets, exit codes, generated markers, exact SQL statements, and typed error kinds survive refactoring; internal helper calls do not.

---

# codegen Troubleshooting

This document covers the failures you are most likely to hit while authoring schemas, generating types and validators, producing OpenAPI documents and API clients, and planning or running PostgreSQL migrations. Each entry names the exact message the package emits, explains why it happens, and gives a fix you can apply directly.

Two error surfaces exist, and they behave differently:

- **Library calls** throw typed errors: `MigrationError` (with a machine-readable `kind` and `exitCode`) and `ClientGenerationError`. Schema authoring throws plain `Error` with a specific message.
- **Command-line runs** print `KIND: message` (migrations) or `ERROR:`/`WARNING:`/`DRIFT:`/`USAGE:` lines (API commands) and return a process exit code. Neither CLI calls `process.exit`; the wrapper sets `process.exitCode`.

---

## Common Errors

### Quick reference

| Error kind / type | Exit code | Raised by | Typical cause |
| --- | --- | --- | --- |
| `Error` (plain) | — | Schema DSL, generators | Invalid identity, missing name, invalid constraint |
| `ClientGenerationError` | — (API CLI maps to `1`) | `generateClient`, `checkClient` | Duplicate `operationId`, duplicate resolved method |
| `ApiCliError` | `2` | `blendsdk api` | Missing/invalid `blendsdk.api.ts`, usage |
| `ApiCliError` | `1` | `blendsdk api check` | Drift, contract errors escalated by `check` |
| `CONFIGURATION` | `2` | Migration config, CLI | Missing config, bad option, unresolvable path, unset URL env |
| `INVALID_HISTORY` | `1` | Migrations | Malformed file, checksum mismatch, torn lineage, unapproved destructive change |
| `UNSUPPORTED` | `1` | Migrations | Change that must be hand-written SQL; unsupported catalog state |
| `FILESYSTEM` | `1` | Artifact publication | Existing target, symlink parent, rename failure |
| `DATABASE` | `1` | Runner, adoption | SQL failure, statement timeout, missing `pg` |
| `LOCKED` | `1` | Runner | Another session holds the advisory lock |
| `UNKNOWN_OUTCOME` | `1` | Runner | Nontransactional migration interrupted after dispatch |
| `ABORTED` | `1` | Runner, CLI | `AbortSignal` fired |
| `INTERNAL` | `1` | Runner guards | Timeout/duration outside supported range |

| Contract issue severity | `generate` (default) | `generate` (`strict: true`) | `check` |
| --- | --- | --- | --- |
| Missing `operationId` | `WARNING:` | `ERROR:` (fails) | `ERROR:` (fails) |
| Missing 2xx response schema | `WARNING:` | `ERROR:` (fails) | `ERROR:` (fails) |
| Reserved name renamed | `WARNING:` | `WARNING:` | `WARNING:` |
| Duplicate body/path parameter | `WARNING:` | `WARNING:` | `WARNING:` |
| Duplicate `operationId` | throws | throws | throws |

---

### Schema authoring and validation

#### `Schema object already exists <scope.>Name`

**Symptom.** `TypeGenerator` or `ZodGenerator` rejects the container before emitting anything, or the error appears the moment you call `.named()` a second time.

**Cause.** `SchemaContainer` keeps an index of `scope + name`. Calling `.named('Customer')` twice with the same effective scope throws:

```text
Schema object already exists Customer
Schema object already exists public.Customer
```

The index key is the concatenation of scope and name, so `public.Customer` and `Customer` (default scope) are distinct entries — but rendering both produces colliding TypeScript names.

**Fix.** Create each named object once and hold the reference; use `.ref()` for reuse.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

const customerId = scope.string().named('CustomerId');
const customer = scope
  .object({
    id: scope.ref(customerId),
    email: scope.string(),
  })
  .named('Customer');

scope.object({ billing: scope.ref(customer) }).named('Invoice');

console.log(await new TypeGenerator().generate(container));
```

If you truly need two objects with the same short name, give them distinct scopes (`container.scope('api_v1')`), and remember the generated type name is derived from `scope.name`.

---

#### `Object properties cannot be named explicitly. Create a seperate root type (<name>) and use .ref() as the property.`

**Symptom.** The generator throws after emitting nothing for the offending object. The word `seperate` is a typo that exists in the source message — grep for it verbatim when searching logs.

**Cause.** A schema object used as a property already has an inline rendering path. Naming it makes the generator treat it as a top-level declaration too, which would emit the same type twice with different shapes.

```typescript fragment
const scope = container.scope();

// ❌ the property is named
scope.object({ street: scope.string().named('Street') }).named('Address');
```

**Fix.** Name only root objects; leave properties unnamed, or promote the property to a root object and reference it.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

const address = scope.object({ street: scope.string() }).named('Address');
scope.object({ billing: scope.ref(address) }).named('Customer');

console.log(await new TypeGenerator().generate(container));
```

---

#### `Referenced schema is not named!`

**Cause.** `.ref(obj)` points at a schema object that was never named. The generators can only emit the reference target as a named type.

```typescript fragment
const address = scope.object({ street: scope.string() }); // never named
scope.object({ billing: scope.ref(address) }).named('Customer'); // ❌
```

**Fix.** Call `.named()` on the target before (or at the same statement as) creating the reference.

```typescript
import { SchemaContainer, ZodGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

const address = scope.object({ street: scope.string() }).named('Address');
scope.object({ billing: scope.ref(address).nullable() }).named('Customer');

console.log(await new ZodGenerator().generate(container));
```

---

#### String constraint errors

**Messages.**

```text
String pattern must not be empty.
Invalid pattern for schema broken_name: [
RegExp flags are not supported; pass an unflagged RegExp or a source string.
minLength must be a non-negative integer.
maxLength must be a non-negative integer.
minLength 5 must not exceed maxLength 3.
maxLength 2 must not be below minLength 3.
```

A second, generator-time variant exists when the stored pattern is forced past authoring validation:

```text
Invalid pattern for schema BrokenNameSchema: [
```

**Cause.** String constraints are validated at authoring time so the contract is trustworthy before it is rendered. `pattern()` compiles the source immediately; length setters reject non-integers and inconsistent bounds; `RegExp` objects with flags are rejected because flags cannot be represented in the schema model or in OpenAPI output.

**Fix.** Pass a valid, empty-free regular expression source (or an unflagged `RegExp`), use non-negative integers, and set bounds that do not contradict each other. Order does not matter — `minLength`/`maxLength` cross-check each other in both directions.

```typescript
import { SchemaContainer, TypeGenerator, ZodGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

scope
  .string()
  .pattern('^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$')
  .minLength(3)
  .maxLength(40)
  .named('project_name');

console.log(await new TypeGenerator().generate(container));
console.log(await new ZodGenerator().generate(container));
```

The constraints appear in three places: `@pattern`, `@minLength`, `@maxLength` in generated JSDoc; `.regex()`/`.min()`/`.max()` in generated Zod; and `pattern`/`minLength`/`maxLength` in the OpenAPI schema.

---

#### `Column <name> does not exit in <table>` / `Use the from() and to()`

**Messages.**

```text
Column nickname does not exit in public.customer
Column id does not exit in public.secrets
Use the from() and to()
```

Note `exit` is the spelling used in the source; the intent is “exist”.

**Cause.** Constraint builders resolve column names against the table’s already-declared columns. Adding a constraint before declaring the column (or typing a name that does not match) fails. `Use the from() and to()` appears when `.column()` is called on a `ForeignKeyConstraint`, which has its own directional API.

**Fix.** Declare columns first, then build constraints, and use `from()`/`to()` for foreign keys.

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const database = new DatabaseSchema('app');

const secrets = database.table('secrets');
secrets.bigserial('id').primaryKey();

const versions = database.table('secret_versions');
versions.bigserial('id').primaryKey();
versions.bigint('secret_id');

versions
  .foreignKeyConstraint(secrets)
  .from('secret_id')
  .to('id')
  .onDelete('CASCADE');

console.log(new PostgreSQLSchemaGenerator(database).generate());
```

---

#### `Unsupported foreign key deferrability: <value>. Use "DEFERRED" or "IMMEDIATE".`

**Cause.** `deferrable()` validates at runtime because the value is rendered straight into DDL and may arrive from JavaScript outside the type checker (config files, untyped callers).

**Fix.** Pass exactly `'DEFERRED'` or `'IMMEDIATE'`; both produce `DEFERRABLE`, and only the initial timing differs.

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const database = new DatabaseSchema('app');

const parent = database.table('parent');
parent.bigint('id').primaryKey();

const child = database.table('child');
child.bigint('parent_id');
child.foreignKeyConstraint(parent).from('parent_id').to('id').deferrable('DEFERRED');

const ddl = new PostgreSQLSchemaGenerator(database).generate();
console.log(ddl.includes('DEFERRABLE INITIALLY DEFERRED'));
```

The canonical snapshot records `deferrable: true` and `initiallyDeferred: true`; a non-deferrable key omits both keys entirely.

---

#### Identity and generated column errors

**Messages.**

```text
IDENTITY columns must be integer or uuid types
Column cannot be both IDENTITY and GENERATED
PostgreSQL only supports STORED generated columns
```

**Cause.** `identity()` is only meaningful for `smallint`, `integer`, `bigint`, or `uuid`; `generated()` replaces the default expression, so combining it with `identity()` or a `default()` is contradictory; PostgreSQL has no `VIRTUAL` generated columns.

**Fix.** Pick one generation strategy per column and use a supported type.

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const database = new DatabaseSchema('app');
const item = database.table('item');

item.bigint('id').identity('BY DEFAULT', { start: 1, increment: 1 });
item.uuid('external_id').identity('v7');
item.text('label');
item.text('label_upper').generated('upper(label)');

console.log(new PostgreSQLSchemaGenerator(database).generate());
```

`identity('v4')` adds the `uuid-ossp` extension and `uuid_generate_v4()`; `identity('v7')` adds `pg_uuidv7`; the default path uses the built-in `gen_random_uuid()` (PostgreSQL 13+), so required extensions are emitted for you.

---

### Generators and TypeScript compiler errors

#### Prettier fails and the raw generated source is dumped to stdout

**Symptom.** A Prettier parser error is thrown, preceded by an unformatted block of generated TypeScript printed to the console.

**Cause.** Generators emit type text directly (no AST) and then normalize it with `format(...)`. When a schema renders to text Prettier cannot parse — most often a union-typed value used where a type alias name is required, or an unnamed reference — the generator deliberately prints the source before rethrowing so you can see which declaration broke.

**Fix.** Read the dumped source, find the first line Prettier rejects, and trace it back to the schema that produced it. Then render that schema alone.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

scope.string().enum(['up', 'down']).named('Direction');

try {
  const source = await new TypeGenerator().generate(container);
  console.log(source);
} catch (error) {
  console.error('Generation failed; inspect the dumped source above.');
  throw error;
}
```

A quick isolation trick is to render each named object through its own container, so the failing declaration is the only one in the output.

---

#### `TS2322: Type 'Promise<string>' is not assignable to type 'string'`

**Cause.** `Generator.generate()` is asynchronous (it awaits Prettier). Assigning the call directly to a `string` — or template-interpolating it — captures a `Promise`.

```typescript fragment
const source: string = new TypeGenerator().generate(container); // ❌
console.log(`${new ZodGenerator().generate(container)}`);        // ❌ prints "[object Promise]"
```

**Fix.** `await` the call and make the surrounding function `async`.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

async function renderTypes(): Promise<string> {
  const container = new SchemaContainer();
  container.scope().string().named('Label');
  return new TypeGenerator().generate(container);
}

console.log(await renderTypes());
```

---

#### `TS2339: Property 'scale' does not exist on type 'void'` and `TS18048: 'x' is possibly 'undefined'`

**Cause.** Two fluent-API exceptions break naïve chains:

1. `TableColumnSchema.size()` and `.scale()` return `void`, so they cannot be chained.
2. `RelationSchema.findColumn()` returns `ColumnType | undefined`, which strict mode forces you to narrow.

```typescript fragment
const amount = table.decimal('amount');
amount.size(10).scale(2);                    // ❌ TS2339

const column = table.findColumn('nickname');
column.nullable();                           // ❌ TS18048
```

**Fix.** Use the typed factory parameters for decimals, and narrow the lookup result.

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const database = new DatabaseSchema('app');
const invoice = database.table('invoice');

invoice.decimal('amount', 12, 2);
invoice.text('nickname').nullable();

const found = invoice.findColumn('nickname');
if (found) {
  found.nullable();
}

console.log(invoice.getColumns().map(column => column.getName()));
```

---

#### `TS2345: Argument of type '<value>' is not assignable to parameter of type 'SchemaObject'`

**Cause.** The fluent DSL takes schema objects, not primitives or plain literals. Passing `'Name'`, `42`, or a hand-written `{ type: 'string' }` into `.object()`, `.ref()`, or a constraint builder fails.

```typescript fragment
scope.object({ id: scope.ref('CustomerId') }).named('Order'); // ❌ string, not a schema
```

**Fix.** Create the target through a scope and pass the object.

```typescript
import { SchemaContainer, ZodGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

const customerId = scope.string().named('CustomerId');
scope.object({ id: scope.ref(customerId) }).named('Order');

console.log(await new ZodGenerator().generate(container));
```

---

### OpenAPI document and client generation

#### `Duplicate operationId "<id>" used by GET <path> and POST <path>. OpenAPI operationIds must be unique.`

**Symptom.** `generateClient` and `checkClient` both throw `ClientGenerationError`; no files are written.

**Cause.** The generated client exposes one method per `operationId`. Two operations sharing an id would silently overwrite each other, so the generator fails before emitting anything.

**Fix.** Give every annotated route a unique `operationId` in its `.openapi()` metadata, then regenerate.

```typescript
import { generateClient } from 'blendsdk/codegen';
import type { OpenAPIDocument } from 'blendsdk/codegen';

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Catalog', version: '1.0.0' },
  paths: {
    '/api/products': {
      get: {
        operationId: 'listProducts',
        tags: ['products'],
        responses: { '200': { description: 'OK' } },
      },
      post: {
        operationId: 'createProduct',
        tags: ['products'],
        responses: { '200': { description: 'OK' } },
      },
    },
  },
};

const result = await generateClient(document, { outputDir: 'src/api-client' });
console.log(result.files);
```

---

#### `Duplicate method "<group>.<method>" produced by GET <path> and POST <path>. Rename one operationId or tag.`

**Cause.** Two distinct `operationId`s can sanitize to the same identifier (for example `delete` and `delete_` both resolving to `delete_`), or two routes can land in the same tag-derived group with the same method name.

**Fix.** Rename one of them so the sanitized identifier differs, or move one to a different tag/group (`splitByGroup` gives each group its own file, but the group+method pair must still be unique).

```typescript fragment
// 1st route
openapi: { operationId: 'delete', tags: ['products'] }
// 2nd route — resolves to "delete_" after reserved-word escaping
openapi: { operationId: 'delete_', tags: ['products'] }
```

The deterministic fix is to rename the second operation, not to rely on the escaping behavior.

---

#### `The contract has errors:` (missing `operationId` or 2xx schema)

**Symptom.**

```text
The contract has errors:
- Operation GET /api/products has no operationId; a deterministic method name was generated.
- Operation GET /api/orders has no 2xx response schema; its result type is unknown.
```

**Cause.** `generateClient` only escalates these issues to errors when `strict: true`; `checkClient` always escalates. That asymmetry means `generate` can succeed and `check` can still fail on the same contract.

**Fix.** Annotate every included route with an `operationId` and a 2xx response schema. Use `envelope: 'body'` for paginated responses so the client returns `PaginatedResponse<T>` instead of unwrapping `data`.

```typescript
import { z } from 'zod';

class OrdersController {
  public routes() {
    return [
      {
        method: 'get' as const,
        path: '/',
        handler: (): void => undefined,
        openapi: {
          operationId: 'listOrders',
          tags: ['orders'],
          envelope: 'body' as const,
          responses: [
            {
              statusCode: 200,
              description: 'Paginated orders',
              schema: z.object({ items: z.array(z.object({ id: z.string() })) }),
            },
          ],
        },
      },
    ];
  }
}

export { OrdersController };
```

If you deliberately want warnings to fail generation too, set `strict: true` so local and CI behavior match.

---

#### `DRIFT: api.json, client.ts`

**Symptom.** `blendsdk api check` prints the drift line to stderr and exits `1`.

**Cause.** One or more committed artifacts differ byte-for-byte from what the configured controllers produce now. Both the OpenAPI JSON and every generated client file are compared after Prettier formatting, so a hand edit, a stale commit, or a Prettier version change all report drift.

**Fix.** Regenerate, review the diff, and commit both artifacts together.

```bash
npx blendsdk api generate
git diff -- api.json src/api-client
npx blendsdk api check
```

Drift is also reported when a marker-bearing file exists that the generator no longer produces (for example `client.orders.ts` after the last `orders` route was removed).

---

#### `TS2307: Cannot find module 'blendsdk/api-client' or its corresponding type declarations.`

**Cause.** Generated clients import the runtime from `blendsdk/api-client` by default. TypeScript only resolves that subpath when the package is installed **and** the project uses a module resolution mode that honors `exports` (`node16`, `nodenext`, or `bundler`).

**Fix.** Install the umbrella package and confirm resolution; if your runtime lives elsewhere, point the generator at it.

```typescript
import { generateClient } from 'blendsdk/codegen';
import type { OpenAPIDocument } from 'blendsdk/codegen';

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Catalog', version: '1.0.0' },
  paths: {},
};

await generateClient(document, {
  outputDir: 'src/api-client',
  runtimeImport: 'blendsdk/api-client',
});
```

```json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext"
  }
}
```

```bash
npm install blendsdk
```

---

### `blendsdk api` configuration and commands

#### `USAGE: Run \`blendsdk api --help\` for the supported commands.` (exit `2`)

**Cause.** The fixed route is `api <generate|check> [--config <path>]`. Anything else — a missing action, an unknown flag, or `--config` with no value — is a usage error. Help is only recognized as exactly `api --help` or `api -h`.

**Fix.** Use one of the supported forms.

```bash
npx blendsdk api --help
npx blendsdk api generate
npx blendsdk api generate --config ./packages/app/blendsdk.api.ts
npx blendsdk api check --config ./packages/app/blendsdk.api.ts
```

---

#### `API configuration was not found at <path>.` / `Could not find blendsdk.api.ts in this project.`

**Cause.** With `--config <file>` the loader requires an existing file or directory. Without it, discovery walks upward from the working directory and **stops at the first directory containing a `.git` entry** — a config planted above the repository root is never loaded.

**Fix.** Place `blendsdk.api.ts` at or below the repository root, or pass an explicit path. Both artifact paths resolve relative to the config file.

```typescript
import { defineApiContract } from 'blendsdk/codegen';

class ProductsController {
  public routes() {
    return [
      {
        method: 'get' as const,
        path: '/',
        handler: (): void => undefined,
        openapi: {
          operationId: 'listProducts',
          tags: ['products'],
          responses: [{ statusCode: 200, description: 'OK' }],
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
});
```

---

#### `Unknown API configuration key: <key>.` / `Unknown generator option: <key>.`

**Cause.** Both the contract and its `generator` block are validated against closed allowlists. `ALLOWED_KEYS` is `outputDir`, `contractFile`, `controllers`, `openapi`, `generator`; `ALLOWED_GENERATOR_KEYS` is `splitByGroup`, `strict`, `clientName`, `runtimeImport`.

**Fix.** Remove the extra key, or move it to the correct location. `outputDir` belongs at the top level, not inside `generator`.

```typescript fragment
export default defineApiContract({
  outputDir: 'src/api-client',        // top level, not in generator
  generator: { splitByGroup: true },  // only the four allowed flags
  // ...
});
```

---

#### `outputDir must not escape the configuration directory.`

**Cause.** Relative paths are resolved against the config directory and rejected when they leave it; filesystem roots are also rejected. Absolute paths are treated as trusted (this is a developer-authored file, not untrusted input).

```typescript fragment
outputDir: '../outside'   // ❌ escapes
outputDir: '/'            // ❌ filesystem root
```

**Fix.** Keep relative paths inside the project, or use an absolute path deliberately.

```typescript fragment
outputDir: 'src/api-client'
outputDir: './generated/api'
```

---

#### `The controller for <basePath> is not a controller class.`

**Cause.** The loader validates that each `controllers[].controller` is a function. Exporting an instance, a factory result, or a `undefined` re-export produces this error at generate time.

**Fix.** Export the class itself and register it directly.

```typescript
import { defineApiContract } from 'blendsdk/codegen';

export class ProductsController {
  public routes() {
    return [
      {
        method: 'get' as const,
        path: '/',
        handler: (): void => undefined,
        openapi: {
          operationId: 'listProducts',
          tags: ['products'],
          responses: [{ statusCode: 200, description: 'OK' }],
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

---

### Migration configuration

#### `CONFIGURATION: Could not find blendsdk.migrations.ts.`

**Cause.** Discovery walks upward from the working directory to the filesystem root. Unlike the API loader, the migration loader does **not** stop at `.git`.

**Fix.** Add `blendsdk.migrations.ts` at the project root or pass `--config`.

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

---

#### `CONFIGURATION: Database URL environment variable DATABASE_URL is not set.`

**Cause.** Only `generate`, `baseline`, `adopt-baseline`, `up`, `down`, and online `validate` need a database. `validate --offline` and `status` without a URL behave differently: `--offline` never loads the driver, while `status` requires a URL because it reads the ledger.

**Fix.** Export the variable named by `databaseUrlEnv` (default `DATABASE_URL`) in the environment that runs the command, or run the offline forms.

```bash
export DATABASE_URL='postgresql://app:secret@localhost:5432/app'
npx blendsdk migrate validate --offline    # no URL needed
npx blendsdk migrate status                # URL required
```

Never place the URL in `blendsdk.migrations.ts` — the config deliberately stores only the variable name so resolved config is safe to log.

---

#### `CONFIGURATION: The generate command requires a schema module.` / `The schema module must default-export one DatabaseSchema instance.`

**Cause.** `generate`, `baseline`, and `adopt-baseline` need the desired schema; other commands never import it. The schema module is loaded with `jiti` (caches disabled), so module-level side effects run on every invocation.

**Fix.** Point `schema` at a module whose default export is a `DatabaseSchema`, and make sure it has no import-time database access.

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const database = new DatabaseSchema('app');

const customer = database.table('customer');
customer.bigserial('id').primaryKey();
customer.text('name');

export default database;
```

---

#### `CONFIGURATION: <field> must not escape the configuration directory.` / `Configured path must not contain a symbolic link: <path>.`

**Cause.** Every configured path (`migrationsDir`, `snapshotFile`, `schema`) is resolved against the config directory and rejected if it escapes, equals a filesystem root, or passes through any symbolic link.

**Fix.** Keep artifacts inside the project and use real directories. In monorepos with linked workspace folders, run the command from the workspace that owns the real files.

```bash
npx blendsdk migrate validate --offline --config ./packages/app/blendsdk.migrations.ts
```

---

### Migration files and snapshots

#### `INVALID_HISTORY: Invalid migration filename: <name>.`

**Cause.** Filenames must match `^(\d{14})_([a-z][a-z0-9-]{0,62})\.(up|down)\.sql$`, and the fourteen-digit prefix must be a real UTC timestamp that round-trips (`20260827120000`). A slug with uppercase letters or underscores, or a shorter timestamp, is rejected. A filename whose embedded `-- id:` header disagrees produces `Migration header ID must match its filename.`

**Fix.** Let `blendsdk migrate create` generate the name, then edit the body only.

```bash
npx blendsdk migrate create add-customer-status --with-down
```

---

#### `INVALID_HISTORY: Migration must use LF endings and end with LF: <file>.` (and BOM/UTF-8 variants)

**Messages.**

```text
Migration must not contain a UTF-8 BOM: <file>.
Migration is not valid UTF-8: <file>.
Migration must use LF endings and end with LF: <file>.
Migration must contain the v1 header and SQL body.
Invalid migration version header.
Missing or reordered migration header: -- transaction:.
```

**Cause.** Migration files are immutable, checksummed artifacts. The parser enforces exact UTF-8, no BOM, LF-only line endings, a trailing newline, the five fixed header lines in order, and at least one non-comment token in the body.

**Fix.** Restore the file from version control rather than reformatting it. If you are authoring it, keep the canonical shape.

```text
-- blendsdk-migration: 1
-- id: 20260827120000_add-customer-status
-- transaction: true
-- from-snapshot: none
-- to-snapshot: none
ALTER TABLE "public"."customer" ADD COLUMN "status" text;
```

Configure your editor to write LF and a final newline for `*.sql` in the migrations directory. Never edit a file that is already applied — its checksum is recorded in the ledger.

---

#### `INVALID_HISTORY: Transactional migration SQL must not control transactions.`

**Cause.** The runner owns the transaction. The SQL scanner rejects statement-leading `BEGIN`, `START TRANSACTION`, `COMMIT`, `END`, `ROLLBACK`, `ABORT`, `SAVEPOINT`, `RELEASE`, `PREPARE TRANSACTION`, and `SET TRANSACTION`. It correctly ignores those words inside comments, quoted strings, and dollar-quoted bodies.

**Fix.** Remove the transaction control; if the statement genuinely cannot run inside a transaction (for example `CREATE INDEX CONCURRENTLY`), mark the migration nontransactional instead.

```bash
npx blendsdk migrate create add-customer-index --no-transaction
```

The generator does this automatically when a planned change is an `index.add` with `concurrent: true`.

---

#### `INVALID_HISTORY: Unexpected SQL file in migration directory: <name>.`

**Cause.** Discovery treats every non-dot `*.sql` entry in the migrations directory as a migration. Notes files, scratch scripts, and directories named `*.sql` fail the contract (`Migration SQL must be a regular file`). Dot-prefixed paths are ignored, which is how in-flight temporary files are hidden.

**Fix.** Move scratch SQL out of the migrations directory (or dot-prefix it while it is in flight).

```bash
mkdir -p ./scratch
mv ./migrations/notes.sql ./scratch/notes.sql
npx blendsdk migrate validate --offline
```

---

#### `INVALID_HISTORY: Snapshot bytes are not in canonical version-one form.`

**Cause.** The snapshot is compared byte-for-byte after serialization: two-space JSON indentation, keys in the serializer’s order, LF endings, exactly one trailing LF, no BOM. Reformatting it in an editor, converting line endings, or hand-editing keys breaks canonical form even if the JSON is semantically equal.

**Fix.** Regenerate the snapshot with `generateMigration` (or restore it from version control) and commit the pair together.

```bash
git checkout -- migrations/schema.snapshot.json
npx blendsdk migrate generate add-customer-status
git diff -- migrations
```

A structural mismatch instead reports `Snapshot does not match the strict version-one schema.`, and an unknown version reports `UNSUPPORTED: Snapshot format version is unsupported; upgrade BlendSDK before rewriting it.`

---

#### `INVALID_HISTORY: Migration/snapshot lineage is torn. Remove the orphan migration or restore the snapshot from version control.`

**Cause.** Each generated migration records `from-snapshot`/`to-snapshot` hashes. When the newest generated `to-snapshot` does not equal the current snapshot bytes, the pair is torn — typically because a process crashed between publishing the migration and replacing the snapshot, or because one of the two files was edited or discarded.

**Fix.** The package never repairs lineage automatically. Choose one auditable recovery:

1. **The migration is an orphan** (it was published but the snapshot was not replaced): delete the migration file and regenerate.
2. **The snapshot was lost or reverted**: restore it from version control so its bytes match the recorded `to-snapshot`.

```bash
git status -- migrations
rm migrations/20260827120000_orphan.up.sql
npx blendsdk migrate validate --offline
```

`Generated snapshot lineage is disconnected at <id>.` means an intermediate generated migration records a `from-snapshot` that does not follow the previous generated `to-snapshot`. `Down migration lineage does not invert its up migration: <id>.` means a `.down.sql` file’s hashes are not the exact inverse.

---

### Generating migrations

#### `INVALID_HISTORY: Destructive migration changes require explicit approval.`

**Cause.** Targeted drops (`column.drop`, `table.drop`, `constraint.drop`, `index.drop`, `schema.drop`, `extension.drop`, `view.drop`) are classified `destructive`. `renderMigrationSql` refuses to emit them without explicit approval, and each emitted statement carries the marker `-- destructive: reviewed and explicitly allowed`.

**Fix.** Review the change list, then regenerate with `--allow-destructive`. Approval applies only to changes already classified as destructive; it never unblocks `caution`, `ambiguous`, or `unsupported` changes.

```typescript
import { generateMigration, formatMigrationError, MigrationError } from 'blendsdk/codegen';

try {
  const result = await generateMigration({
    name: 'drop-customer-nickname',
    allowDestructive: true,
  });
  for (const change of result.changes) {
    console.log(`${change.safety}\t${change.kind}`);
  }
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(formatMigrationError(error));
  } else {
    throw error;
  }
}
```

---

#### `UNSUPPORTED: Provide reviewed manual SQL with an explicit USING expression.`

**Cause.** Some changes cannot be generated safely from the model alone and are always blocked:

| Change | Guidance emitted |
| --- | --- |
| `column.type` (any type/size/scale change) | `Provide reviewed manual SQL with an explicit USING expression.` |
| `column.generated` | `Generated-column transitions require reviewed manual SQL.` |
| `column.identity` | `Identity transitions require reviewed manual SQL.` |
| `column.nullability` (`SET NOT NULL`) | `Populate and validate existing rows before SET NOT NULL.` |
| `column.add` (required column) | `Use a staged population strategy for a required column.` |
| `constraint.add` (same-name replacement) | `Same-name constraint replacements require reviewed manual SQL.` |
| `view.replace` / multi-view add/remove | `View dependency order requires reviewed manual SQL.` |

**Fix.** Write the transition as a manual migration and keep the snapshot updated so the next `generate` starts from the right state.

```bash
npx blendsdk migrate create widen-customer-status
```

```text
-- blendsdk-migration: 1
-- id: 20260827130000_widen-customer-status
-- transaction: true
-- from-snapshot: none
-- to-snapshot: none
ALTER TABLE "public"."customer"
  ALTER COLUMN "status" TYPE varchar(40) USING "status"::varchar(40);
```

For a required column, use three steps: add it nullable, backfill, then add the `NOT NULL` constraint in a later migration.

---

#### Rename-hint errors

**Messages.**

```text
CONFIGURATION: Rename hint identity does not match its kind.
CONFIGURATION: Rename hints must be one-to-one and acyclic.
CONFIGURATION: Rename hint must reference one prior and one desired identity.
CONFIGURATION: Rename hint must map one removed identity to one added identity.
CONFIGURATION: Cross-schema renames require reviewed manual SQL.
CONFIGURATION: Cross-table column renames require a matching table rename hint.
```

**Cause.** Without a hint, a shape-compatible rename is classified `ambiguous` (`Provide one explicit table rename hint.` / `Provide one explicit column rename hint.`). Hints must be fully qualified, same-schema, one-to-one, acyclic, and must map exactly one removed identity to one added identity.

**Fix.** Pass exact `from=to` pairs on the command line, or typed `RenameHint` objects through the API.

```bash
npx blendsdk migrate generate rename-customer-to-account \
  --rename-table public.customer=public.account \
  --rename-column public.customer.label=public.account.display_name
```

```typescript
import { generateMigration } from 'blendsdk/codegen';
import type { RenameHint } from 'blendsdk/codegen';

const renameHints: RenameHint[] = [
  { kind: 'table', from: 'public.customer', to: 'public.account' },
  { kind: 'column', from: 'public.customer.label', to: 'public.account.display_name' },
];

const result = await generateMigration({ name: 'rename-customer-to-account', renameHints });
console.log(result.status);
```

---

#### `UNSUPPORTED: Duplicate table identity: public.customer.` / `INVALID_HISTORY: New migration identifiers must follow existing history.`

**Cause.** Normalization rejects duplicate qualified identities (two tables with the same scope and name, two constraints with the same name). Separately, a new migration id must sort **after** the newest existing id; a clock that runs behind, or a back-dated `now`, produces a lexically earlier id.

**Fix.** Remove the duplicate table/constraint, or generate with a timestamp that follows history.

```typescript
import { generateMigration } from 'blendsdk/codegen';

const result = await generateMigration({
  name: 'add-customer-status',
  now: new Date('2026-08-27T12:00:00Z'),
});

console.log(result.status, result.migration?.id);
```

---

### Running migrations

#### `LOCKED: The PostgreSQL migration lock is held by another session.`

**Cause.** `up` and `down` take a database-scoped advisory lock (`hashtext(current_database())`, `hashtext('blendsdk:migrations:v1')`) before touching anything. If it is held elsewhere, the runner retries until `lockTimeoutMs` elapses and then fails with `LOCKED`. `status`/`validate` report `LOCKED` without waiting.

**Fix.** Find and stop the competing session, or raise `lockTimeoutMs` (maximum 300 000 ms).

```bash
psql "$DATABASE_URL" -c "select pid, application_name, state, query from pg_stat_activity where application_name = 'blendsdk-migrations'"
```

```typescript fragment
export default defineMigrationConfig({
  schema: './src/database/schema.ts',
  lockTimeoutMs: 30_000,
});
```

Different databases never block each other, because the lock key includes `current_database()`.

---

#### `DATABASE: The optional pg package is required for database migration commands.`

**Cause.** `pg` is an optional peer, imported lazily inside the functions that need it. Generation, `validate --offline`, and `blendsdk api` work without it; `up`, `down`, `status`, online `validate`, and `adopt-baseline` do not.

**Fix.** Install the driver in the project that runs migrations, and keep it external if you bundle.

```bash
npm install blendsdk pg
```

```json
{
  "peerDependenciesMeta": {
    "pg": { "optional": true }
  }
}
```

---

#### `INVALID_HISTORY: Migration prefix or checksum mismatch at position <n>.`

**Cause.** The ledger must be the exact ordered prefix of local history — same ids, same byte checksums, same lineage, same order. Editing an applied file by even one byte, inserting an older id, or reordering files produces this error. `status`/`validate` return `INVALID_HISTORY`; `up` throws before executing anything.

**Fix.** Restore the applied file from version control. Never edit a migration that may have been applied.

```bash
git checkout -- migrations/20260827120000_create-customer.up.sql
npx blendsdk migrate validate --offline
```

The related `Local migration history changed while waiting for the migration lock.` means a file changed between discovery and lock acquisition; re-run after the working tree settles.

---

#### `INVALID_HISTORY: The existing migration ledger is not compatible with version one.`

**Cause.** The runner verifies the ledger structurally, not just by row shape: exact columns in order, `text` primary key on `id`, no defaults, no identity, and the three `CHECK` constraints intact. Column names alone are not sufficient — a weakened predicate (`... OR true`) fails this check, and an empty incompatible table is still rejected.

**Fix.** Point the project at a database whose `public.blendsdk_migrations` was created by BlendSDK, or drop the incompatible table only if it contains no history you need.

```bash
psql "$DATABASE_URL" -c "\d+ public.blendsdk_migrations"
```

---

#### `UNKNOWN_OUTCOME` after a nontransactional migration

**Messages.**

```text
The latest nontransactional migration has an unknown outcome.
Migration <id> lost its session after dispatch.
Migration <id> was cancelled after dispatch.
Migration <id> completed but its ledger could not be finalized.
```

**Cause.** Nontransactional migrations (`-- transaction: false`) write a `NONTRANSACTIONAL_DIRTY` row before dispatching SQL. If the session is lost, the command is cancelled, or the ledger cannot be finalized afterwards, the outcome is genuinely uncertain and the runner refuses to continue. Only the final ledger row may be dirty (`Only the final ledger row may have an uncertain outcome.`).

**Fix.** Inspect the database and the dirty row, decide what actually happened, then reconcile by hand — the runner will not guess.

```bash
psql "$DATABASE_URL" -c "select id, state, applied_at, execution_ms from public.blendsdk_migrations order by id"
npx blendsdk migrate status
```

---

#### `UNSUPPORTED: Down requires explicit allowDown confirmation.` / `INVALID_HISTORY: The latest applied migration has no down file.`

**Cause.** `down` reverts exactly one migration and is guarded twice: the CLI requires the `--allow-down` flag, and the library requires `allowDown: true`. The newest applied migration must also have a matching `.down.sql` with inverted lineage.

**Fix.** Pass the flag, and create down files with `create --with-down` before you need them.

```bash
npx blendsdk migrate down --allow-down
```

---

#### `DATABASE: Migration <id> failed and was rolled back.`

**Cause.** SQL failed inside the runner-owned transaction, and the runner rolled back. The provider message is deliberately not forwarded; if the session died during rollback you instead see `Migration <id> failed and its session was lost.` A common trigger is `statementTimeoutMs` (default 900 000 ms) expiring during a long backfill.

**Fix.** Reproduce the statement with `psql`, fix the SQL, then raise `statementTimeoutMs` for legitimately long statements (maximum 86 400 000 ms).

```typescript fragment
export default defineMigrationConfig({
  schema: './src/database/schema.ts',
  statementTimeoutMs: 3_600_000,
});
```

Failures after the transaction commits appear as `INVALID_HISTORY` or `UNKNOWN_OUTCOME`, never as `DATABASE … rolled back`, because nothing can be rolled back at that point.

---

#### `ABORTED: Migration operation was cancelled.`

**Cause.** The `AbortSignal` passed to `runMigrations` fired. `up`/`down` stop at the next safe boundary; an in-flight statement is cancelled with `pg_cancel_backend` from a second pool connection, and a transactional migration is rolled back before the lock is released.

**Fix.** This is expected behavior — no action needed. Note that aborting *after* a nontransactional statement was dispatched produces `UNKNOWN_OUTCOME` instead, because the statement may have committed.

---

### Baseline adoption

#### `UNSUPPORTED: <CLASSIFICATION>: <identity>. Baseline adoption was not changed.`

**Classifications.**

```text
MISSING              — desired object absent from the live catalog
DIFFERENT            — same identity, different canonical structure
EXTRA_MODELED        — live object the desired snapshot does not model
UNMANAGED            — informational; adoption continues
UNSUPPORTED_FOR_ADOPTION — cannot be proven structurally equal
```

**Cause.** Adoption records history **without running the baseline SQL**, so it must prove the existing database already matches the desired snapshot. Classifications are structural and deterministic. `UNSUPPORTED_FOR_ADOPTION` covers anything whose SQL the model cannot compare semantically: views, column defaults that are raw SQL expressions, check constraints, expression or partial indexes, unmanaged types used by modeled columns, RLS-enabled tables, deferrable primary/unique keys, and non-default sequence options.

**Fix.** Bring the database into the desired state (or the desired state into the database), then re-run. Anything classified `UNSUPPORTED_FOR_ADOPTION` must be removed or modeled away first.

```bash
npx blendsdk migrate adopt-baseline --confirm-adoption 'app/20260827090000_initial'
```

Adoption also re-checks the catalog and the local baseline **inside** the ledger transaction, so a change between preview and commit fails safely with no history written.

---

#### `CONFIGURATION: Adoption requires exact target confirmation after application and admin DDL is quiesced.` / `INVALID_HISTORY: Baseline adoption requires an absent or empty migration ledger.`

**Cause.** Adoption demands the exact token `<database>/<baseline-id>` and an absent or empty ledger. A wrong token, a different database, or any existing history row fails closed before mutation.

**Fix.** Read the database name and baseline id from the preview, produce the exact token, and adopt into a database with no recorded history.

```typescript
import { adoptBaseline } from 'blendsdk/codegen';

const result = await adoptBaseline(
  { confirmation: undefined },
  {
    afterPreview: (preview) => {
      for (const item of preview.comparison) {
        console.log(`${item.classification}\t${item.identity}`);
      }
      return `${preview.database}/${preview.baselineId}`;
    },
  }
);

console.log(result.status);
```

---

### Introspection

#### `[WARNING]: public -> <table> -> <pg_type> could not be mapped!`

**Cause.** `PostgreSQLIntrospector` maps a fixed set of PostgreSQL types. Types it maps to `null` — `xml`, `jsonpath`, `interval`, ranges, and geometric types — fall through to the warning, producing a deprecated `any`-typed property. The same warning appears for any unrecognized user-defined type that is not an enum or composite.

**Fix.** Supply a `ColumnMapper` that returns a schema object for those types. The mapper runs before array/nullability handling, so return a plain schema and let the introspector add the modifiers.

```typescript
import { SchemaContainer } from 'blendsdk/codegen';
import { PostgreSQLIntrospector, TypeGenerator } from 'blendsdk/codegen';
import type { ColumnMapper } from 'blendsdk/codegen';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const database = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'app',
  user: 'app',
  pass: 'app',
});

const container = new SchemaContainer();
const mapper: ColumnMapper = (column, scope) => {
  if (column.pg_type === 'xml' || column.pg_type === 'interval') {
    return scope.string();
  }
  if (column.pg_type === 'json' || column.pg_type === 'jsonb') {
    return scope.unknown();
  }
  return undefined;
};

const introspector = new PostgreSQLIntrospector(database);
await introspector.introspect(container, mapper);

console.log(await new TypeGenerator().generate(container));
await database.disconnect();
```

JSON and JSONB map to `unknown` out of the box and do **not** produce this warning; a mapper is only needed when you want a narrower shape.

---

## Debugging Strategies

### 1. Read `kind` and `exitCode` before reading the message

`MigrationError` carries a stable category and a process exit class, and its message is sanitized (PostgreSQL URLs and `password=`-style assignments are redacted at construction time). Branch on `kind`; use `formatMigrationError` only for operator output.

```typescript
import { formatMigrationError, generateMigration, MigrationError } from 'blendsdk/codegen';

try {
  await generateMigration({ name: 'add-customer-status' });
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(formatMigrationError(error));
    console.error(`kind=${error.kind} exit=${error.exitCode}`);
  } else {
    throw error;
  }
}
```

| If `kind` is… | Look at… |
| --- | --- |
| `CONFIGURATION` | `blendsdk.migrations.ts`, `--config`, environment variables |
| `INVALID_HISTORY` | `migrations/*.sql`, `schema.snapshot.json`, ledger rows |
| `UNSUPPORTED` | The `changes` list and its `guidance` strings |
| `FILESYSTEM` | Target existence, symlink parents, permissions |
| `DATABASE` | The SQL statement, `statementTimeoutMs`, connectivity |
| `LOCKED` | `pg_stat_activity` |
| `UNKNOWN_OUTCOME` | The dirty ledger row and the actual database state |

### 2. Reproduce without a database

Every generation path is offline: `generateClient`, `checkClient`, `generateMigration`, `generateBaseline`, `TypeGenerator`, `ZodGenerator`, `PostgreSQLSchemaGenerator`, `OpenAPIGenerator`, and `validate --offline`. If a failure reproduces here, it is not a database problem.

```bash
npx blendsdk migrate validate --offline
npx blendsdk api check
```

### 3. Inspect the planned changes before publishing them

`generateMigration` returns the full classified change list, and it publishes artifacts on success. Run it in a scratch worktree (or expect to review the diff), then read `result.changes`.

```typescript
import { generateMigration } from 'blendsdk/codegen';

const result = await generateMigration({ name: 'inspect-only' });

console.log(result.status); // 'GENERATED' | 'UP_TO_DATE'
for (const change of result.changes) {
  const identity = [change.schema, change.table, change.name].filter(Boolean).join('.');
  console.log(`${change.safety}\t${change.kind}\t${identity}`);
  if (change.guidance) {
    console.log(`  guidance: ${change.guidance}`);
  }
}
```

If `status` is `UP_TO_DATE`, the desired schema and the committed snapshot already agree, and nothing was written.

### 4. Confirm drift without writing

`checkClient` regenerates in memory and reports exactly which files differ, which is the fastest way to tell a formatting problem from a contract problem.

```typescript
import { readFile } from 'node:fs/promises';
import { checkClient } from 'blendsdk/codegen';
import type { OpenAPIDocument } from 'blendsdk/codegen';

const raw = await readFile('api.json', 'utf8');
const document = JSON.parse(raw) as OpenAPIDocument;
const result = await checkClient(document, { outputDir: 'src/api-client' });

console.log(result.drifted, result.driftedFiles);
for (const issue of result.issues) {
  console.log(`${issue.severity}\t${issue.message}`);
}
```

### 5. Read the ledger, do not guess

The ledger is authoritative. Query it read-only first; never repair it by hand before you understand the dirty state.

```bash
psql "$DATABASE_URL" -c "select id, checksum, from_snapshot, to_snapshot, state, applied_at, execution_ms from public.blendsdk_migrations order by id"
psql "$DATABASE_URL" -c "\d+ public.blendsdk_migrations"
npx blendsdk migrate status
```

### 6. Locate a competing lock holder

```bash
psql "$DATABASE_URL" -c "select pid, application_name, state, wait_event_type, wait_event, query from pg_stat_activity where application_name = 'blendsdk-migrations'"
```

A stuck `up` from a crashed shell keeps the advisory lock until its connection closes.

### 7. Isolate a single generator on a fresh container

Generators reset each object’s `rendered` flag but keep their own emitted lines. When output looks duplicated or a declaration is missing, build a fresh `SchemaContainer` and a fresh generator and render one named object at a time.

```typescript
import { SchemaContainer, TypeGenerator, ZodGenerator } from 'blendsdk/codegen';

function renderOne(name: string): { types: string; zod: string } | undefined {
  const container = new SchemaContainer();
  const scope = container.scope();
  scope.object({ id: scope.string() }).named(name);

  return {
    types: 'pending',
    zod: 'pending',
  };
}

const isolated = renderOne('Probe');
console.log(isolated);

const container = new SchemaContainer();
container.scope().object({ id: container.scope().string() }).named('Probe');
console.log(await new TypeGenerator().generate(container));
console.log(await new ZodGenerator().generate(container));
```

### 8. Verify which entry point you are running

Both CLIs have stable help output that lists their commands and exit classes.

```bash
npx blendsdk migrate --help
npx blendsdk api --help
npx blendsdk migrate validate --offline
```

### 9. Check generated-file ownership before deleting anything

Only files whose first line is the marker are generated and only those are pruned. Confirm ownership before removing a suspicious file.

```bash
head -n 1 src/api-client/*.ts
```

---

## Known Pitfalls

### The fluent API has deliberate exceptions

Most builder methods return `this`, but a few do not:

| Call | Returns | Consequence |
| --- | --- | --- |
| `TableColumnSchema.size()` / `.scale()` | `void` | Cannot be chained; use `decimal(name, size, scale)` |
| `TableColumnSchema.check(rule)` | The column | Adds a **table-level** check with no bound columns |
| `TableSchema.checkConstraint(rule)` | The table | Cannot chain `.column()`; check constraints always render with an empty column segment in DDL names |
| `TableSchema.primaryKey()` | The primary key (created on demand) | Inspecting a table mutates it — see below |

### `primaryKey()` creates a constraint; `getPrimaryKey()` only reads

`renderPrimaryKey` and any inspection code that calls `table.primaryKey()` will attach an empty `PrimaryKeyConstraint` to a table that had none. Nothing is emitted (`hasColumns()` is false), but the model changed. The migration normalizer uses `getPrimaryKey()` precisely to avoid this side effect.

```typescript fragment
const table = database.table('customer');
table.bigint('id').primaryKey();

const existing = table.getPrimaryKey();     // ✅ read-only
const created = table.primaryKey();         // ⚠️ creates on a table without a key
```

### Reusing a generator instance appends instead of replacing

`Generator.generate()` does not clear its accumulated lines, and `ZodGenerator` writes its `import * as z from 'zod';` line in the constructor. Calling `generate()` twice on the same instance duplicates the output. Create one generator per run.

```typescript fragment
const generator = new ZodGenerator();
await generator.generate(container);
await generator.generate(container); // ❌ every declaration twice
```

### `generate` and `check` disagree about strictness

`generateClient` escalates contract issues only when `strict: true`; `checkClient` always escalates. Without `strict`, a local `generate` can succeed and the CI `check` on the same contract can still fail. Set `strict: true` so both paths agree.

```typescript fragment
generator: { strict: true }
```

### Reserved `operationId`s are renamed, not rejected

`delete`, `constructor`, `__proto__`, `string`, and other reserved words and prototype names get a trailing underscore (`delete` → `delete_`). A warning is emitted, but the generated method name no longer matches the contract’s `operationId`. If callers use the operation id to invoke methods, pick a name that survives sanitization.

### Object request bodies are flattened into params

A `$ref` body that resolves to an object is merged into the params object with path and query parameters. A body property whose name collides with a path or query parameter is **dropped**, with a warning (`the path or query parameter wins over the body property`). Rename the body field or wrap the body in a single non-object schema so it becomes a `body` property.

### The response envelope defaults to `data`

`OpenAPIGenerator` records `x-blend-envelope: 'data'` unless the route metadata says otherwise. A paginated endpoint that returns the whole body must opt into `envelope: 'body'`; otherwise the generated client unwraps `data` and the pagination metadata disappears from the result type.

### `adoptBaseline` cannot prove SQL it does not model

Defaults that are raw SQL expressions, check constraints, expression or partial indexes, views, RLS-enabled tables, and non-default sequence options are all `UNSUPPORTED_FOR_ADOPTION`. This is intentional: PostgreSQL rewrites equivalent expressions, so string comparison would create unsafe false matches. Model those objects differently, or keep them out of adoption scope.

### Snapshot bytes are a contract, not a file format suggestion

`schema.snapshot.json` is compared byte-for-byte. Editor reformatting, CRLF conversion, a BOM, or a missing final newline all produce `Snapshot bytes are not in canonical version-one form.` — even when the JSON is semantically identical. Never format it; regenerate it.

### Migration ids are ordered strings

Ids sort lexically (`YYYYMMDDHHMMSS_slug`). A clock that runs behind the newest id, or a fixed `now` in the past, produces `New migration identifiers must follow existing history.` Pin `now` only in tests, and remember that `--now` does not exist on the CLI — use the API.

### `down` is single-step and cannot be replayed

`down` reverts exactly the newest applied migration. There is no `down --to <id>`, no `force`, no `repair`, and no fake-apply. Recovery is always forward: write a new migration. The absence of these commands is a documented design decision, not a missing feature.

### `check()` on a column is a table-level check

`column.check(rule)` delegates to `table.checkConstraint(rule)` and returns the column. The resulting constraint has no bound columns, so derived DDL names contain an empty segment (`customer__check`). Prefer expressing column-level invariants through the column type, or accept the table-level name and set it explicitly where you can.

### `introspect()` mutates the rows it reads

The introspector rewrites `schema_name` to `undefined` for the `public` schema and strips the leading underscore from array types in place on the returned records. A mapper that stores the record for later use sees the post-mutation values, not the raw catalog row.

### `introstectConstantTypes` is a historical alias

`PostgreSQLIntrospector.introstectConstantTypes()` still works but is deprecated; it delegates to `introspectConstantTypes()`. Use the corrected spelling in new code — the misspelling exists only for backward compatibility.

### `pg` is optional at import time and required at run time

Nothing in the package imports `pg` at module scope, so type generation and offline validation work in projects without a driver. The first database-backed call fails with `DATABASE: The optional pg package is required …`. If you bundle the library for a serverless target, mark `pg` external or install it explicitly.

### Generated clients and Prettier are version-coupled

Drift is computed on Prettier-formatted bytes. Upgrading Prettier without regenerating produces a drift report on files nobody edited. Pin Prettier in the project that runs `blendsdk api check`, or regenerate in the same change as the version bump.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
