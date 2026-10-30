> **Package**: `blendsdk/codegen`

# codegen Advanced Patterns

The patterns below are compositions, not isolated API calls. Each one pairs two or more pieces of the package — the schema DSL with a generator, the introspector with a mapping strategy, the desired-state schema with the migration planner, or a generated artifact with the drift gate that protects it in CI. Every section states when to reach for the pattern, shows a complete example, explains the value, and lists the caveats that decide whether it survives production.

| # | Pattern | Combines | Reach for it when |
| --- | --- | --- | --- |
| 1 | Contract-first API with a drift gate | `defineApiContract`, `OpenAPIGenerator`, `generateClient`, `checkClient`, `blendsdk api` | The HTTP surface must be committed and verified, not regenerated silently |
| 2 | One schema, two artifacts | `SchemaContainer`, `TypeGenerator`, `ZodGenerator` | Compile-time types and runtime validators must never disagree |
| 3 | Catalog introspection with a mapping strategy | `PostgreSQLIntrospector`, `ColumnMapper`, both generators | Models are derived from an existing database you do not author by hand |
| 4 | Catalog-derived column constants | `introspectConstantTypes`, `CTypeGenerator` | Query code must stop embedding column names as string literals |
| 5 | Desired state to reviewed migration | `DatabaseSchema`, `defineMigrationConfig`, `generateMigration`, `runMigrations` | Schema changes must be reviewed SQL with a canonical snapshot |
| 6 | Baseline and brownfield adoption | `generateBaseline`, `adoptBaseline` | You are starting a lineage, or adopting a database that already exists |
| 7 | Disposable-database bootstrap DDL | `PostgreSQLSchemaGenerator.generateGrouped` | Tests and preview environments need the whole schema from nothing |
| 8 | Scoped composition across API versions | `container.scope`, `ref`, `partial`, `recordSet` | One canonical model feeds several wire shapes |
| 9 | A release gate on the public API | `checkClient`, `validateMigrations`, `formatOpenApiDocument` | Your CI pipeline should not shell out to a CLI it cannot unit test |
| 10 | One error boundary for every generator | `MigrationError`, `ClientGenerationError`, `formatMigrationError` | Several generators run in one script and must fail with one exit code |

---

## Pattern: Contract-first API with a drift gate

**When to use it** — the HTTP surface is a reviewed artifact. You want the OpenAPI document and the typed client committed to version control, and you want CI to fail when either one no longer matches the routes the controllers actually declare. This is the production default for any service that ships a generated client to another team.

### The contract file

The project authors exactly one `blendsdk.api.ts`. It is loaded with `jiti` (caches disabled) and validated field by field, so unknown keys and escaping paths are rejected before anything is written.

```typescript
import { defineApiContract } from 'blendsdk/codegen';
import { ProductsController } from './src/controllers/products-controller.js';

export default defineApiContract({
  outputDir: 'src/generated/api-client',
  contractFile: 'contracts/api.json',
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
    clientName: 'CatalogClient',
  },
});
```

### The controller the contract names

Only routes that carry `.openapi()` metadata are collected — that annotation is the opt-in mechanism.

```typescript
import type { RouteDefinition } from 'blendsdk/webafx';
import { z } from 'zod';

const productSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.enum(['active', 'archived']),
  })
  .meta({ id: 'Product' });

const listProductsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  search: z.string().optional(),
});

export class ProductsController {
  public constructor(_settings: unknown, _services: unknown) {}

  public routes(): RouteDefinition[] {
    return [
      {
        method: 'get',
        path: '/',
        handler: async () => undefined,
        validation: listProductsQuery,
        openapi: {
          operationId: 'listProducts',
          summary: 'List products',
          tags: ['products'],
          responses: [
            {
              statusCode: 200,
              description: 'One page of products',
              schema: z.array(productSchema),
            },
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
          summary: 'Read one product',
          tags: ['products'],
          pathParams: {
            id: { schema: z.string(), description: 'Product identifier' },
          },
          responses: [
            { statusCode: 200, description: 'The product', schema: productSchema },
            { statusCode: 404, description: 'No product with that identifier' },
          ],
        },
      },
    ];
  }
}
```

### Generate, then check

```bash
npx blendsdk api generate
```

```text
GENERATED client.products.ts client.ts index.ts types.ts api.json
```

```bash
npx blendsdk api check
```

`check` rebuilds the document and the client **in memory** and compares them byte for byte against what is committed. It writes nothing. A changed client file, a changed `api.json`, or a contract error exits `1` and names the drifted files on stderr:

```text
DRIFT: client.products.ts
```

The same two operations are available programmatically, which is how you write the contract file yourself and assert on the result inside a test:

```typescript
import { writeFile } from 'node:fs/promises';
import {
  OpenAPIGenerator,
  checkClient,
  formatOpenApiDocument,
  generateClient,
  type ClientGeneratorOptions,
  type OpenAPIDocument,
} from 'blendsdk/codegen';
import { ProductsController } from '../src/controllers/products-controller.js';

const options: ClientGeneratorOptions = {
  outputDir: 'src/generated/api-client',
  splitByGroup: true,
  clientName: 'CatalogClient',
};

const document: OpenAPIDocument = new OpenAPIGenerator({
  title: 'Catalog API',
  version: '1.0.0',
})
  .addController('/api/products', ProductsController)
  .generate();

await generateClient(document, options);
await writeFile('contracts/api.json', await formatOpenApiDocument(document), 'utf8');

const checked = await checkClient(document, options);
if (checked.drifted === true) {
  throw new Error(`DRIFT: ${(checked.driftedFiles ?? []).join(', ')}`);
}
```

The committed client is deterministic and marker-owned:

```text
src/generated/api-client/
├── client.products.ts
├── client.ts
├── index.ts
└── types.ts
```

```text
// Generated by `blendsdk api generate` — do not edit by hand.

export type Product = {
  id: string;
  name: string;
  status: 'active' | 'archived';
};

export type ProductsListProductsParams = { page?: number; search?: string };

export type ProductsListProductsResult = Product[];
```

### Why this pattern is valuable

The handwritten alternative rots quietly:

```typescript
// Before: a client that compiles today and lies tomorrow.
export interface ProductsClient {
  listProducts: (params: { page?: number }) => Promise<unknown>;
}
```

`check` converts that silent rot into a failed build. Because paths, methods, component schemas, and operations are sorted, and because every emitted file and the document itself are normalized through Prettier, running `generate` twice with an unchanged contract produces identical bytes — which is exactly the property a drift gate requires. The generator also only prunes files that start with the generated marker, so a hand-written file living in the same directory is never touched.

### Caveats and performance considerations

- **`generate` and `check` must receive the same generator options.** `splitByGroup`, `clientName`, and `runtimeImport` change the emitted bytes. A `check` that omits `splitByGroup: true` reports drift on a repository that is actually clean. Keep the options in one exported constant and pass it to both.
- **`check` is stricter than `generate`.** A missing `operationId` or a missing 2xx response schema is a warning during `generate` but an **error** during `check`. If you inherit a contract with those gaps, either fix the routes or run with `strict: false` on the generation side while you work through them.
- **A duplicate `operationId` is fatal, not a warning.** `generateClient` throws `ClientGenerationError` naming both offending method/path pairs, because one generated method would otherwise overwrite the other.
- **`envelope: 'body'` changes the return type.** Routes that opt into the body envelope (paginated endpoints) return `PaginatedResponse<T>` instead of the unwrapped `data` value, and the generated `types.ts` imports that type from the runtime specifier (`blendsdk/api-client` by default).
- **Discovery stops at `.git`.** `blendsdk.api.ts` is found by walking up from the working directory, and the walk refuses to cross a repository root, so a stray config above the project is never loaded.
- **Cost.** Generation is offline and CPU-bound on Prettier formatting; for a contract of a few dozen operations it completes in well under a second, so it belongs in pre-commit hooks as well as CI.

---

## Pattern: One schema, two artifacts

**When to use it** — a shape is consumed by both the compiler and the runtime. Server handlers need a TypeScript type; the request edge needs a validator. Authoring the two by hand is the classic source of "the type says `string`, the validator accepted `null`".

### Complete example

```typescript
import { SchemaContainer, TypeGenerator, ZodGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

const address = scope
  .object({
    line1: scope.string(),
    postal_code: scope.string().maxLength(16),
  })
  .named('address');

scope
  .object({
    id: scope.number(),
    slug: scope.string().pattern('^[a-z0-9-]{3,40}$'),
    nickname: scope.string().optional().nullable(),
    address: scope.ref(address),
  })
  .named('account');

const types = await new TypeGenerator().generate(container);
const validators = await new ZodGenerator().generate(container);

console.log(types);
console.log(validators);
```

The TypeScript generator emits an `interface` for plain root objects and a `type` alias for primitives, enums, references, and modified objects:

```text
/**
 * @interface
 */
export interface Address {
  /**
   * @memberOf {Address}
   */
  line1: string;
  /**
   * @maxLength 16
   * @memberOf {Address}
   */
  postal_code: string;
}

/**
 * @interface
 */
export interface Account {
  /**
   * @memberOf {Account}
   */
  id: number;
  /**
   * @pattern ^[a-z0-9-]{3,40}$
   * @memberOf {Account}
   */
  slug: string;
  /**
   * @optional
   * @nullable
   * @memberOf {Account}
   */
  nickname?: string | null;
  /**
   * @memberOf {Account}
   */
  address: Address;
}
```

The Zod generator emits the equivalent validator set, with the same string constraints expressed as runtime checks:

```text
import * as z from 'zod';

export const AddressSchema = z.object({
  line1: z.string(),
  postal_code: z.string().max(16),
});

export const AccountSchema = z.object({
  id: z.number(),
  slug: z.string().regex(new RegExp("^[a-z0-9-]{3,40}$")),
  nickname: z.string().optional().nullable(),
  address: AddressSchema,
});
```

### Why this pattern is valuable

Both artifacts come from **one** traversal of **one** graph. The string contract — `.pattern()`, `.minLength()`, `.maxLength()`) — is validated at authoring time (an invalid regex or a `minLength` above `maxLength` throws immediately, naming the schema) and then lands in three places without a second edit:

1. the TypeScript `JSDoc`, so the constraint is discoverable from the type;
2. the generated Zod expression, so it is enforced at the edge;
3. the OpenAPI document, whenever that live Zod schema is used as a route response, because `z.toJSONSchema` preserves `pattern`, `minLength`, and `maxLength`.

`JSDoc` escaping is handled for you: a pattern containing `*/` is emitted as `*\/`, so a hostile or merely unlucky regex cannot close the comment and turn the rest of the line into executable TypeScript.

### Caveats and performance considerations

- **The Zod generator covers `optional`, `partial`, and `nullable`.** Array (`arrayed()`) and index-signature (`recordSet()`) modifiers are rendered by `TypeGenerator`; review generated validators for array-typed columns and supply the array shape explicitly where it matters.
- **`partial()` renders a different declaration kind.** A root object carrying any modifier becomes `export type X = Partial<{ … }>`, not an interface — TypeScript allows interfaces to be extended and merged, type aliases do not, so consumer code that declaration-merges will stop compiling.
- **Names must be unique per scope.** `SchemaContainer.assert` throws on a duplicate name in the same scope, which is what prevents a reference from silently resolving to the wrong object. Reuse a name across scopes (`api_v1`, `api_v2`) instead of suffixing.
- **Rendering order follows registration order.** Both generators walk `container.getAll()`; declare the referenced type before the type that references it so the reference resolves to an already-rendered name.
- **Cost.** Both generators render text and run Prettier once per invocation — linear in the number of schemas, negligible for hundreds of objects.

---

## Pattern: Catalog introspection with a mapping strategy

**When to use it** — the models must describe a database you did not author. `PostgreSQLIntrospector` reads metadata only (never data), projects the catalog into a `SchemaContainer`, and hands you a `ColumnMapper` hook for the handful of columns whose TypeScript type the tool cannot guess.

### Complete example

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import {
  ObjectSchema,
  PostgreSQLIntrospector,
  SchemaContainer,
  TypeGenerator,
  ZodGenerator,
  type ColumnMapper,
} from 'blendsdk/codegen';

const database = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'app',
  user: 'app',
  pass: process.env.PGPASSWORD ?? '',
});

/**
 * Maps every json/jsonb column to an explicit record instead of the safe
 * `unknown` default. Returning undefined defers to the built-in mapping.
 */
const jsonAsRecord: ColumnMapper = (column, scope) => {
  if (column.pg_type !== 'json' && column.pg_type !== 'jsonb') {
    return undefined;
  }
  const mapped = scope.unknown();
  mapped.setData({
    tsType: 'Record<string, unknown>',
    zodExpression: 'z.record(z.string(), z.unknown())',
  });
  return mapped;
};

const container = new SchemaContainer();

try {
  await new PostgreSQLIntrospector(database).introspect(container, jsonAsRecord);
} finally {
  await database.disconnect();
}

// Audit what the mapping actually produced before generating anything.
for (const table of container.getAll()) {
  if (!(table instanceof ObjectSchema) || table.getName() === undefined) {
    continue;
  }
  console.log(table.getNamedScoped());
  for (const [column, schema] of Object.entries(table.getProperties())) {
    const data = schema.getData();
    const nullability = data.nullable === true ? 'nullable' : 'required';
    console.log(`  ${column.padEnd(20)} ${(data.tsType ?? 'unknown').padEnd(24)} ${nullability}`);
  }
}

const types = await new TypeGenerator().generate(container);
const validators = await new ZodGenerator().generate(container);

console.log(types);
console.log(validators);
```

The audit loop prints the projection contract before a single line is generated:

```text
public.accounts
  id                   string                   required
  email                string                   required
  payload              Record<string, unknown>  nullable
```

### Why this pattern is valuable

Introspection is where a code generator either earns trust or loses it. Three details make this one safe:

- **Only metadata is read.** The introspection query filters to `relkind` values for tables, views, materialized views, partitioned tables, and foreign tables, excludes `pg_catalog` and `information_schema`, and never selects row data.
- **Enums become real schemas first.** Enum types are registered before tables, so an enum column resolves to a `ref()` of the generated enum instead of an inline union duplicated per table.
- **Unmapped types fail loudly, not silently.** A column type the built-in switch does not recognize becomes `any` **with a `@deprecated` description carrying the warning**. It compiles, it is visible in the generated source, and it does not silently acquire a wrong type. `json`/`jsonb` deliberately map to `unknown` — the honest type — which is why the mapper above exists.

The `ColumnMapper` is the extension point that keeps the tool honest for domain-specific columns. It receives the raw `ColumnIntrospection` record (including `formatted_type`, `length`, `precision`, `scale`, and the `fk_info` array) and the current `SchemaScope`, so a mapper can build a completely different schema object and register it in the right scope.

### Caveats and performance considerations

- **`pass` in source is a smell.** Prefer environment injection as shown; `PostgreSQLDatabase` is a thin wrapper over `pg`, which also honors `PGPASSWORD`.
- **The mapper runs per column, and its result is registered in the container.** Creating the schema object with `scope.*()` inside the mapper is required — constructing one outside the scope detaches it from the container.
- **Introspection mutates the record it receives.** `pg_type` loses its array prefix (`_varchar` → `varchar`) before mapping, and `schema_name` is cleared for `public`. Key your mapper on the normalized `pg_type`, not the raw catalog spelling.
- **Composite and domain types are projected too.** Composite types render as objects, domain types as a single `(base)` pseudo-column, and enum types as string/number unions. Review the audit output for the ones you did not expect.
- **Cost.** Introspection is a single query plus in-memory projection. On a catalog with a few hundred tables it dominates the run time of type generation; the generators themselves are cheap.

---

## Pattern: Catalog-derived column constants

**When to use it** — query builders, raw SQL fragments, and test fixtures keep embedding column names as string literals, and a rename breaks them at runtime rather than at compile time. This pattern turns the live catalog into a constant object per relation.

### Complete example

```typescript
import { writeFile } from 'node:fs/promises';
import { CTypeGenerator, PostgreSQLIntrospector } from 'blendsdk/codegen';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const database = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'app',
  user: 'app',
  pass: process.env.PGPASSWORD ?? '',
});

try {
  const introspector = new PostgreSQLIntrospector(database);
  const relations = await introspector.introspectConstantTypes();
  const source = await new CTypeGenerator().generate(relations);
  await writeFile('src/generated/column-names.ts', source, 'utf8');
  console.log(`Wrote ${Object.keys(relations).length} constant types.`);
} finally {
  await database.disconnect();
}
```

The generated module looks like this — one frozen mapping of qualified relation to column name, formatted by Prettier:

```text
/**
 * Constant type for relation accounts
 * @export
 * @constant
 */
export const eAccounts = { $TABLE: "accounts", EMAIL: "email", ID: "id" };
```

Consumers then write `eAccounts.EMAIL` where they used to write `'email'`:

```typescript
import { eAccounts } from './generated/column-names.js';

const projection = `${eAccounts.ID}, ${eAccounts.EMAIL}`;
console.log(`SELECT ${projection} FROM ${eAccounts.$TABLE}`);
```

### Why this pattern is valuable

`introspectConstantTypes()` returns a plain `ConstantType` — `Record<string, string[]>` keyed by qualified relation name — with three deliberate properties:

- **Views and materialized views are included**, so reporting queries get the same guarantee as write paths.
- **The `public` schema is dropped from the key**, matching the authoring DSL, so `app.accounts` and `accounts` never both exist.
- **Generation is purely textual.** `CTypeGenerator` takes the map and returns formatted source; it never touches a database, which means a CI job can regenerate and diff the file without credentials.

The historical alias `introstectConstantTypes()` still exists for backward compatibility, but it delegates to the corrected spelling — use `introspectConstantTypes()` in new code.

### Caveats and performance considerations

- **This is not a snapshot of the schema.** It is a column-name map. Nullability, types, and constraints do not appear, so it complements rather than replaces the type generators.
- **Column order is alphabetical**, because the introspection query orders by `schema_name, relation_name, column_name`. Do not derive `INSERT` column order from these constants.
- **`$TABLE` is the qualified name as written**, so a table in a non-default schema yields `'billing.invoices'` — quote it when interpolating into SQL.
- **Cost.** Same single catalog query as full introspection, minus the schema projection; the generator itself is a string join plus one Prettier pass.

---

## Pattern: Desired state to reviewed migration

**When to use it** — schema changes must be read by a human before they run. You author the desired state once, generate targeted SQL plus a canonical snapshot, review both in the pull request, and then apply the reviewed files. Nothing diffs a live database and fixes it behind your back.

### Step 1 — author the desired schema

Every builder call returns the receiver, so the whole schema is one chain per table.

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const app = new DatabaseSchema('app');

const accounts = app.table('accounts').comment('Customer accounts');
accounts.uuid('id');
accounts.primaryKey().column('id');
accounts.varchar('email', 320).unique();
accounts.text('display_name').nullable();
accounts.timestamptz('created_at', 6).default('now()');

const secrets = app.table('account_secrets');
secrets.bigserial('id');
secrets.primaryKey().column('id');
secrets.uuid('account_id');
secrets.bytea('ciphertext');
secrets
  .foreignKeyConstraint(accounts)
  .from('account_id')
  .to('id')
  .onDelete('CASCADE')
  .deferrable('IMMEDIATE');
secrets.index().indexName('account_secrets_account_idx').using('hash').column('account_id');

export default app;
```

### Step 2 — describe where the artifacts live

```typescript
import { defineMigrationConfig } from 'blendsdk/codegen';

export default defineMigrationConfig({
  schema: './src/database/app-schema.ts',
  migrationsDir: './migrations',
  databaseUrlEnv: 'DATABASE_URL',
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 900_000,
});
```

### Step 3 — generate, then review

```typescript
import {
  generateMigration,
  type MigrationSafety,
  type SchemaChange,
} from 'blendsdk/codegen';

const result = await generateMigration({
  name: 'add-account-secrets',
  configPath: './blendsdk.migrations.ts',
  allowDestructive: false,
});

if (result.status === 'UP_TO_DATE') {
  console.log('Desired state already matches the committed snapshot.');
} else {
  console.log(`GENERATED ${result.migration?.id ?? ''}`);
  const bySafety = new Map<MigrationSafety, SchemaChange[]>();
  for (const change of result.changes) {
    const bucket = bySafety.get(change.safety) ?? [];
    bucket.push(change);
    bySafety.set(change.safety, bucket);
  }
  for (const [safety, changes] of bySafety) {
    console.log(`${safety}: ${changes.map(change => change.kind).join(', ')}`);
  }
}
```

| Safety | Change | Object |
| --- | --- | --- |
| `safe` | `constraint.add` | `app.accounts.accounts_email_key` |
| `safe` | `constraint.add` | `app.accounts.accounts_id_pkey` |
| `safe` | `constraint.add` | `app.account_secrets.account_secrets_account_id_fkey` |
| `safe` | `index.add` | `app.account_secrets.account_secrets_account_idx` |
| `safe` | `table.add` | `app.accounts` |
| `safe` | `table.add` | `app.account_secrets` |
| `safe` | `comment.set` | `app.accounts` |

The published file carries a five-line header that binds it to the snapshot it came from:

```text
-- blendsdk-migration: 1
-- id: 20260901090000_add-account-secrets
-- transaction: true
-- from-snapshot: none
-- to-snapshot: <sha256 of the new schema.snapshot.json>
```

### Step 4 — evolve, using hints for renames

Renaming a column is the change a diff can never infer safely. Without a hint the planner reports an `ambiguous` change and refuses to render SQL:

```typescript
import { generateMigration } from 'blendsdk/codegen';

const renamed = await generateMigration({
  name: 'rename-display-name',
  configPath: './blendsdk.migrations.ts',
  renameHints: [
    { kind: 'column', from: 'app.accounts.display_name', to: 'app.accounts.nickname' },
  ],
});

console.log(renamed.changes.map(change => change.kind).join(', '));
// column.rename
```

The rendered statement targets the new name and never drops a column:

```text
ALTER TABLE "app"."accounts" RENAME COLUMN "display_name" TO "nickname";
```

### Step 5 — apply

```typescript
import { runMigrations } from 'blendsdk/codegen';

const applied = await runMigrations({
  command: 'up',
  configPath: './blendsdk.migrations.ts',
});

console.log(`${applied.status} (${applied.migrations.length} applied)`);
```

### Why this pattern is valuable

- **The plan and the SQL are separated.** `changes` is a typed list (`safe`, `caution`, `destructive`, `ambiguous`, `unsupported`); `renderMigrationSql` only emits statements for classes it can prove. Anything needing a human is refused with guidance instead of guessed.
- **Ordering is principled, not incidental.** The renderer applies fixed dependency phases — extensions, schemas, renames, tables and columns, constraints (referenced tables before foreign keys), indexes, comments, views, then the reverse order for drops — with table drops ordered child-before-parent.
- **The snapshot is canonical.** Serialized as two-space JSON with LF endings and a final LF, and re-parsed byte-exactly on read. Any non-canonical formatting is rejected, so a stray editor save cannot masquerade as a schema change.
- **Identities are quoted everywhere**, including embedded double quotes, and `CASCADE` is never emitted.

### Caveats and performance considerations

- **`caution` and `unsupported` block generation entirely.** A required (`NOT NULL`) column addition, a type change, a generated-column transition, and same-name constraint replacement all demand reviewed manual SQL — the planner will not invent a backfill.
- **`destructive` requires `allowDestructive: true`**, and each destructive statement is preceded by `-- destructive: reviewed and explicitly allowed`. Grant it in the command, not in the config.
- **Renames are one-to-one and acyclic.** Cross-schema renames, cross-table column renames without a matching table rename, duplicate sources, and hints that point at an identity which still exists in both snapshots all throw.
- **`changes` is sorted by kind, the SQL is sorted by phase.** Do not assume the array order matches the statement order in the file.
- **Cost.** Normalization and diffing are in-memory and linear in the size of the schema; a five-hundred-table comparison completes well inside a second, and the two files are published atomically.

---

## Pattern: Baseline and brownfield adoption

**When to use it** — you are creating the first migration for a project, or you have a database that already exists and you want it to become the managed starting point without executing the baseline DDL twice.

### Starting a lineage offline

```typescript
import { generateBaseline } from 'blendsdk/codegen';

const baseline = await generateBaseline({
  name: 'initial',
  configPath: './blendsdk.migrations.ts',
  now: new Date('2026-09-01T09:00:00Z'),
});

console.log(`${baseline.status} ${baseline.migration.id}`);
console.log(`snapshot ${baseline.snapshotHash}`);
console.log(`${baseline.changes.length} modeled change(s) in the baseline`);
```

`generateBaseline` refuses to proceed when a snapshot or an up migration already exists — either condition means the lineage has started and a second baseline would be ambiguous.

### Adopting a database that already exists

```typescript
import { adoptBaseline, type AdoptionPreview } from 'blendsdk/codegen';

const adopted = await adoptBaseline(
  { configPath: './blendsdk.migrations.ts' },
  {
    afterPreview: (preview: AdoptionPreview): string => {
      console.log(`TARGET ${preview.user}@${preview.host}:${preview.port}/${preview.database}`);
      for (const item of preview.comparison) {
        console.log(`${item.classification} ${item.identity}`);
      }
      // The exact "<database>/<baseline-id>" DDL-quiescence attestation.
      return `${preview.database}/${preview.baselineId}`;
    },
  }
);

console.log(`${adopted.status} with ${adopted.comparison.length} comparison entries`);
```

```text
TARGET app@db.internal:5432/app
MATCH database.defaultSchema
MATCH schema.app
MATCH table.app.accounts
UNMANAGED public.audit_touch()
ADOPTED with 42 comparison entries
```

### Why this pattern is valuable

Adoption is the moment a tool can silently corrupt a production database, so this one proves its work:

- **Baseline DDL is never executed.** The ledger row is inserted; the SQL file is not run.
- **Comparison is structural, per object.** Each modeled object gets a stable qualified identity (`table.app.accounts`, `column.app.accounts.email`, `index.…`) and a classification of `MATCH`, `MISSING`, `DIFFERENT`, `EXTRA_MODELED`, `UNMANAGED`, or `UNSUPPORTED_FOR_ADOPTION`.
- **SQL-backed properties fail closed.** A default, check constraint, view source, index predicate, or index expression cannot be proven semantically equal, because PostgreSQL rewrites equivalent expressions. Those are reported as unsupported rather than compared as strings.
- **Unmanaged objects are reported, not deleted.** Functions, triggers, enums, and domains that the model does not describe appear as `UNMANAGED` and do not block adoption.
- **The authoritative check is repeated inside the transaction**, under the same advisory lock, after the confirmation is collected — so a schema changed between preview and commit is detected.

### Caveats and performance considerations

- **Adoption requires exactly one local baseline migration** whose recorded snapshot hash matches the canonical snapshot file, byte for byte.
- **The ledger must be absent or empty.** A non-empty ledger is rejected; adoption records the first row, it does not merge with existing history.
- **The confirmation token is target-bound.** It must be exactly `<current_database>/<baseline-id>`. Anything else exits with a configuration error before any ledger mutation.
- **`pg` is loaded lazily.** `generateBaseline` works with no driver installed; `adoptBaseline` reports a typed database error if the driver is missing.
- **Cost.** Catalog projection issues a fixed set of metadata queries and validates every returned row; on a large catalog the comparison is the dominant cost and is performed twice by design (preview + commit).

---

## Pattern: Disposable-database bootstrap DDL

**When to use it** — a test suite or preview environment needs the entire schema created from nothing, fast, and deterministically. This is the one generator that is *not* the migration planner: it renders the full desired state rather than a delta.

### The schema module

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const app = new DatabaseSchema('app');
app.extension('pgcrypto');

const accounts = app.table('accounts').comment('Customer accounts');
accounts.uuid('id');
accounts.primaryKey().column('id');
accounts.varchar('email', 320).unique();
accounts.timestamptz('created_at', 6).default('now()');

app.view('active_accounts').as("SELECT id, email FROM app.accounts");

export default app;
```

### The bootstrap helper

```typescript
import { PostgreSQLSchemaGenerator } from 'blendsdk/codegen';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import app from '../../src/database/app-schema.js';

/**
 * Recreates the complete schema. Groups are executed in dependency order:
 * schema objects, then indexes, then views.
 */
export async function resetTestDatabase(database: PostgreSQLDatabase): Promise<void> {
  const ddl = new PostgreSQLSchemaGenerator(app).generateGrouped({ dropBeforeCreate: true });

  for (const group of [ddl.schema, ddl.indexes, ddl.views]) {
    if (group.length > 0) {
      await database.executeQuery(group);
    }
  }
}
```

For a first deployment, keep the drops out and emit only the creation statements:

```typescript
import { PostgreSQLSchemaGenerator } from 'blendsdk/codegen';
import app from './src/database/app-schema.js';

const firstDeploy = new PostgreSQLSchemaGenerator(app).generateGrouped({
  dropBeforeCreate: false,
});

console.log(firstDeploy.schema);
console.log(firstDeploy.indexes);
console.log(firstDeploy.views);
```

### Why this pattern is valuable

`generateGrouped()` returns four strings — `schema`, `indexes`, `views`, and `all` — instead of one blob. That split matters:

- **Ordering is explicit.** Extensions, non-default schemas, tables, constraints, and comments belong to `schema`; indexes are separate so a test can defer them; views come last because they may depend on tables and on each other.
- **Drops are opt-in and scoped.** `dropBeforeCreate` emits `DROP SCHEMA` for non-default schemas and `DROP TABLE` per table — never a blanket `DROP SCHEMA public CASCADE`.
- **Comments survive.** Table and column comments are escaped (single quotes doubled) and re-emitted, so a local database matches production metadata.
- **Deferrable foreign keys and identity columns render fully.** `DEFERRABLE INITIALLY DEFERRED|IMMEDIATE` and `GENERATED ALWAYS AS IDENTITY (START WITH … CACHE … CYCLE)` appear exactly as authored, and generated (`STORED`) columns suppress any conflicting default.

### Caveats and performance considerations

- **This is not a migration.** It cannot evolve an existing database and it does not record history. Running it against a database with data and `dropBeforeCreate: true` destroys that data.
- **`generate()` is the concatenation of the groups** in the order `schema`, `indexes`, `views`. Use `generateGrouped()` when you need to interleave your own statements — for example, seeding between tables and indexes.
- **A named index is required for stable diffs.** Unnamed indexes get a derived name at normalization time; when you author DDL by hand and also track the schema in migrations, name every index explicitly.
- **Cost.** Linear in the number of columns, constraints, and indexes; a few hundred tables render in milliseconds because everything is string assembly followed by no formatting pass.

---

## Pattern: Scoped composition across API versions

**When to use it** — one canonical model is exposed through several wire shapes: an internal record, a public v1 response, and a v2 response that adds fields and relaxes others. Scopes keep the names distinct without duplicating the model.

### Complete example

```typescript
import { SchemaContainer, TypeGenerator, ZodGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();

const core = container.scope('billing');
const customer = core
  .object({
    id: core.string(),
    email: core.string().maxLength(320),
    internal_notes: core.string().nullable(),
  })
  .named('customer');

const v1 = container.scope('api_v1');
v1.object({
  customer: v1.ref(customer).partial(),
  include_orders: v1.boolean().optional(),
}).named('customer_request');

const v2 = container.scope('api_v2');
v2.object({
  customer: v2.ref(customer).partial(),
  include_orders: v2.boolean().optional(),
  cursor: v2.string().nullable(),
}).named('customer_request');

const types = await new TypeGenerator().generate(container);
const validators = await new ZodGenerator().generate(container);

console.log(types);
console.log(validators);
```

The TypeScript output keeps every name distinct by deriving identifiers from `scope.name`:

```text
/**
 * @interface
 */
export interface BillingCustomer {
  /**
   * @memberOf {BillingCustomer}
   */
  id: string;
  /**
   * @maxLength 320
   * @memberOf {BillingCustomer}
   */
  email: string;
  /**
   * @nullable
   * @memberOf {BillingCustomer}
   */
  internal_notes: string | null;
}

/**
 * @interface
 */
export interface ApiV1CustomerRequest {
  /**
   * @memberOf {ApiV1CustomerRequest}
   */
  customer: Partial<BillingCustomer>;
  /**
   * @optional
   * @memberOf {ApiV1CustomerRequest}
   */
  include_orders?: boolean;
}

/**
 * @interface
 */
export interface ApiV2CustomerRequest {
  /**
   * @memberOf {ApiV2CustomerRequest}
   */
  customer: Partial<BillingCustomer>;
  /**
   * @optional
   * @memberOf {ApiV2CustomerRequest}
   */
  include_orders?: boolean;
  /**
   * @nullable
   * @memberOf {ApiV2CustomerRequest}
   */
  cursor: string | null;
}
```

The Zod output mirrors it with one validator per scoped name, and the reference resolves to the already-rendered validator:

```text
import * as z from 'zod';

export const BillingCustomerSchema = z.object({
  id: z.string(),
  email: z.string().max(320),
  internal_notes: z.string().nullable(),
});

export const ApiV1CustomerRequestSchema = z.object({
  customer: BillingCustomerSchema.partial(),
  include_orders: z.boolean().optional(),
});

export const ApiV2CustomerRequestSchema = z.object({
  customer: BillingCustomerSchema.partial(),
  include_orders: z.boolean().optional(),
  cursor: z.string().nullable(),
});
```

### Why this pattern is valuable

A scope is a namespace, not a copy. `container.scope('api_v1')` registers objects under a separate identity, and `ref()` points at the one canonical object. Three consequences:

- **`partial()` and `nullable()` compose on the reference, not the source.** `v1.ref(customer).partial()` changes only the v1 field type; `BillingCustomer` itself is untouched, so the v2 request and the internal record stay consistent with each other.
- **Duplicate detection is scope-aware.** `api_v1.customer_request` and `api_v2.customer_request` coexist; two objects named `customer_request` inside `api_v1` throw immediately.
- **Identifier derivation is stable.** `SchemaUtils.snakeToPascalCase` maps `api_v2.customer_request` to `ApiV2CustomerRequest` and `billing.customer` to `BillingCustomer`, so adding a scope never renames an existing type.

`recordSet()` composes on the same axis: `scope.number().recordSet()` renders `Record<string, number>`, which is the escape hatch when the map keys are runtime data rather than declared properties.

### Caveats and performance considerations

- **Registration order still governs rendering order.** References are resolved against an already-rendered `tsType`; registering the `api_v2` request before `billing.customer` produces an error rather than a forward reference.
- **`recordSet()` renders in TypeScript only.** The Zod generator models `optional`, `partial`, and `nullable`; a record-typed field needs an explicit validator.
- **Compare shapes, not names, in tests.** `ApiV1CustomerRequest` and `ApiV2CustomerRequest` are structurally similar by design; asserting on the derived name is what proves the scoping worked.
- **Cost.** Scoping adds no traversal cost — the container is a flat list with a scope-aware index, so both generators still make a single pass.

---

## Pattern: A release gate on the public API

**When to use it** — CI must prove both generated artifacts at once: the API client matches its contract, and the local migration history is internally consistent. Building the gate on the public functions keeps it unit-testable, gives you structured results instead of parsing CLI text, and avoids shelling out from a Node process.

### `src/contract/document.ts`

```typescript
import { OpenAPIGenerator, type OpenAPIDocument } from 'blendsdk/codegen';
import { ProductsController } from '../controllers/products-controller.js';

/** Rebuilds the contract document from the annotated controller routes. */
export function buildDocument(): OpenAPIDocument {
  return new OpenAPIGenerator({
    title: 'Catalog API',
    version: '1.0.0',
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    defaultSecurity: [{ bearerAuth: [] }],
  })
    .addController('/api/products', ProductsController)
    .generate();
}
```

### `scripts/release-gate.ts`

```typescript
import {
  checkClient,
  validateMigrations,
  type ClientGeneratorOptions,
  type ContractIssue,
} from 'blendsdk/codegen';
import { buildDocument } from '../src/contract/document.js';

/** Must match the options used by `blendsdk api generate` exactly. */
const CLIENT_OPTIONS: ClientGeneratorOptions = {
  outputDir: 'src/generated/api-client',
  splitByGroup: true,
  clientName: 'CatalogClient',
};

/** Routes one contract issue to the matching stream. */
function report(issue: ContractIssue): void {
  const line = `${issue.severity.toUpperCase()}: ${issue.message}`;
  if (issue.severity === 'error') {
    console.error(line);
    return;
  }
  console.warn(line);
}

/** Returns `0` only when both the client and the local history are clean. */
async function releaseGate(): Promise<number> {
  let failed = false;

  const client = await checkClient(buildDocument(), CLIENT_OPTIONS);
  for (const issue of client.issues) {
    report(issue);
  }
  if (client.drifted === true) {
    console.error(`DRIFT: ${(client.driftedFiles ?? []).join(', ')}`);
    failed = true;
  }

  const history = await validateMigrations({
    offline: true,
    configPath: './blendsdk.migrations.ts',
  });
  if (history.status !== 'UP_TO_DATE') {
    console.error(`MIGRATIONS: ${history.status}`);
    failed = true;
  }

  return failed ? 1 : 0;
}

process.exitCode = await releaseGate();
```

```text
ERROR: Operation GET /api/products/{id} has no operationId; a deterministic method name was generated.
DRIFT: client.products.ts, types.ts
MIGRATIONS: INVALID_HISTORY
```

### Why this pattern is valuable

The gate returns data, not prose. `checkClient` gives you `drifted`, `driftedFiles`, and a `ContractIssue[]` that already carries `severity`, `operationId`, `method`, and `path`, so a CI job can annotate a pull request instead of grepping stderr. `validateMigrations({ offline: true })` validates headers, checksums, filename/identifier agreement, and generated lineage entirely from local files — **no database and no driver** — which makes it safe on a fork build.

Both operations are deterministic, so a green gate on an unchanged repository stays green indefinitely:

- `checkClient` regenerates in memory through the same emitter and the same Prettier options used by `generate`, then compares bytes.
- The offline validator re-parses every migration file and rejects BOMs, CRLF, missing final newlines, reordered headers, and torn snapshot lineage.

Emitting exit codes through `process.exitCode` rather than `process.exit()` lets pending output flush — the library CLIs are built the same way.

### Caveats and performance considerations

- **Option parity is the whole game.** A gate that passes different `ClientGeneratorOptions` than the generator reports drift forever. Export the constant from one module and import it in both places.
- **`checkClient` always escalates contract problems**, independent of the `strict` option. A route missing a 2xx response schema fails the gate even though `generate` accepted it as a warning.
- **Offline validation returns `UP_TO_DATE` or `INVALID_HISTORY` only.** `PENDING` and `LOCKED` require a database, so this gate proves internal consistency, not that the database is migrated. Add a separate deployment step running `runMigrations({ command: 'up', dryRun: true })` against the target.
- **Cost.** One in-memory generation plus one Prettier pass per file, and one file parse per migration. Hundreds of operations and a hundred migrations stay comfortably under a second.

---

## Pattern: One error boundary for every generator

**When to use it** — a single script drives several generators: emit the client, generate a migration, maybe render bootstrap DDL. Each failure mode carries a different exit class, and an operator needs to see a category rather than a stack trace with a connection URL in it.

### Complete example

```typescript
import {
  ClientGenerationError,
  MigrationError,
  formatMigrationError,
  generateClient,
  generateMigration,
  type ClientGeneratorOptions,
  type OpenAPIDocument,
} from 'blendsdk/codegen';

const CLIENT_OPTIONS: ClientGeneratorOptions = {
  outputDir: 'src/generated/api-client',
  splitByGroup: true,
  clientName: 'CatalogClient',
};

/**
 * Runs the generation pipeline and maps every typed failure to a process
 * exit class: 2 for a configuration problem, 1 for anything operational.
 */
export async function generateEverything(document: OpenAPIDocument): Promise<number> {
  try {
    const client = await generateClient(document, CLIENT_OPTIONS);
    console.log(`CLIENT ${client.files.join(' ')}`);

    const migration = await generateMigration({
      name: 'sync-schema',
      configPath: './blendsdk.migrations.ts',
    });
    console.log(`MIGRATION ${migration.status} ${migration.migration?.id ?? 'none'}`);

    return 0;
  } catch (error) {
    if (error instanceof MigrationError) {
      console.error(formatMigrationError(error));
      return error.exitCode;
    }
    if (error instanceof ClientGenerationError) {
      console.error(`GENERATION: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
```

```text
CONFIGURATION: Could not find blendsdk.migrations.ts.
```

### Why this pattern is valuable

Three distinct guarantees come out of one `catch`:

- **`MigrationError` carries its own exit class.** `kind` is a stable machine-readable category (`CONFIGURATION`, `INVALID_HISTORY`, `FILESYSTEM`, `DATABASE`, `LOCKED`, `UNKNOWN_OUTCOME`, `UNSUPPORTED`, `ABORTED`, `INTERNAL`) and `exitCode` is `1` or `2`, so the caller never re-derives the mapping from message text.
- **Secrets are redacted at construction, not at print time.** The message is scrubbed as the error is built — complete `postgres://` and `postgresql://` URLs are replaced with `[REDACTED_DATABASE_URL]`, and `password=`/`secret=`/`token=` assignments with `[REDACTED]`. `sensitiveDetail` is accepted for signature compatibility but never retained, so SQL bodies and credentials cannot leak through an error log.
- **`ClientGenerationError` signals "this contract cannot become a client."** It is reserved for structural impossibility — currently a duplicate `operationId`, or two operations resolving to the same group/method pair — and its message names both conflicting locations so the fix is obvious.

`formatMigrationError` then renders the operator-facing line as `KIND: message`, which is stable enough to assert on in a test and safe enough to paste into an incident channel.

### Caveats and performance considerations

- **Do not re-throw a typed error to "preserve the stack".** The stack for a typed migration failure often contains provider frames the redaction intentionally removed from the message.
- **`UNKNOWN_OUTCOME` is not a failure you may retry blindly.** It means a nontransactional migration was dispatched and its result could not be confirmed. The ledger row remains in `NONTRANSACTIONAL_DIRTY` and every subsequent mutating command fails until an operator resolves it; treat the exit code as "stop", not "retry".
- **`ClientGenerationError` has no `exitCode`.** Map it to `1`, or to `2` if your pipeline treats a malformed contract as a configuration error — the class deliberately does not decide.
- **Contract-level problems are not exceptions.** Missing `operationId` and missing 2xx schemas arrive in `issues`, not as errors, unless `strict` (generation) or `check` (always) escalates them. A boundary that only catches exceptions will miss them.
- **Cost.** Negligible — this pattern adds no generation work, only classification.

---

## Combining the patterns

The patterns are designed to be layered rather than chosen exclusively:

1. Author the schema once (Pattern 2) and generate the desired-state `DatabaseSchema` beside it (Pattern 5).
2. Derive models from the same catalog the migrations target (Pattern 3) when the database is authoritative instead.
3. Publish the contract and the client as committed artifacts (Pattern 1) and gate both artifacts in CI (Pattern 9).
4. Bootstrap disposable databases from the schema (Pattern 7) so tests exercise the exact tables the migrations produce.
5. Keep one error boundary around the whole pipeline (Pattern 10) so a failing step reports a category and a redacted message instead of a stack trace.

What makes the composition safe is the invariant underneath all ten: every generator is deterministic, every artifact is normalized, and every plan is classified before it becomes SQL. When output is a pure function of committed input, "check" and "validate" are meaningful verbs rather than hopeful ones.

---

# codegen Common Scenarios

Each scenario is a self-contained answer: a short explanation and a complete TypeScript module using only public exports from the package root. Scenarios are ordered from the smallest schema task to the full migration lifecycle. Database-backed examples need the optional `pg` driver and the connection environment variable named by your configuration (`DATABASE_URL` by default); examples that build Zod schemas import `zod` directly.

---

## How do I generate TypeScript types and Zod validators from one schema?

Author the shape once in a `SchemaContainer`, then run `TypeGenerator` and `ZodGenerator` over the same container. Both generators walk the same graph, so the compile-time type and the runtime validator cannot drift apart.

```typescript
import { writeFile } from 'node:fs/promises';
import { SchemaContainer, TypeGenerator, ZodGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

scope
  .object({
    id: scope.number(),
    email: scope.string(),
    nickname: scope.string().optional(),
  })
  .named('Customer');

const types = await new TypeGenerator().generate(container);
const validators = await new ZodGenerator().generate(container);

await writeFile('customer.types.ts', types, 'utf8');
await writeFile('customer.validators.ts', validators, 'utf8');

console.log(types);
console.log(validators);
```

The container registers `Customer`, so the output contains `export interface Customer` with `nickname?: string`, and `export const CustomerSchema = z.object({ … })` with `nickname: z.string().optional()`.

---

## How do I enforce a pattern and length limits on a string field?

Chain `.pattern()`, `.minLength()`, and `.maxLength()` on a string schema. Each call is validated at authoring time, and the constraints flow into generated TypeScript as JSDoc and into generated Zod as `.regex()`, `.min()`, and `.max()`.

```typescript
import { SchemaContainer, TypeGenerator, ZodGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();

container
  .scope()
  .string()
  .pattern('^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$')
  .minLength(3)
  .maxLength(40)
  .named('project_name');

const types = await new TypeGenerator().generate(container);
const validators = await new ZodGenerator().generate(container);

console.log(types);
console.log(validators);

// An invalid pattern fails at the call site, not in generated code.
try {
  container.scope().string().named('broken').pattern('[');
} catch (error) {
  console.error((error as Error).message);
}
```

Use a plain source string or an unflagged `RegExp`; flagged expressions are rejected because flags cannot be represented in the schema model or the OpenAPI output. Minimum and maximum bounds must be non-negative integers and must not contradict each other.

---

## How do I model a PostgreSQL schema and generate bootstrap DDL?

Build a `DatabaseSchema` with tables, columns, constraints, indexes, and views, then render it with `PostgreSQLSchemaGenerator`. `generateGrouped()` returns `schema`, `indexes`, `views`, and the combined `all`; `generate()` returns the combined script only.

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const database = new DatabaseSchema('app');

const customer = database.table('customer').comment('Customer records');
customer.bigserial('id').primaryKey();
customer.text('email').unique();
customer.text('display_name').nullable();
customer.timestamp('created_at').default('now()');

const order = database.table('customer_order');
order.bigserial('id').primaryKey();
order.bigint('customer_id');
order.numeric('total', 12, 2).default(0);
order
  .foreignKeyConstraint(customer)
  .from('customer_id')
  .to('id')
  .onUpdate('CASCADE')
  .onDelete('RESTRICT')
  .deferrable('DEFERRED');
order.index().indexName('customer_order_customer_id_idx').column('customer_id');

database
  .view('customer_summary')
  .as('SELECT customer_id, SUM(total) AS total FROM public.customer_order GROUP BY customer_id');

const ddl = new PostgreSQLSchemaGenerator(database).generateGrouped();

console.log(ddl.schema);
console.log(ddl.indexes);
console.log(ddl.views);
```

By default the grouped output begins with `DROP TABLE` / `DROP SCHEMA` statements for disposable databases; pass `generateGrouped({ dropBeforeCreate: false })` to omit them. The deferred foreign key renders as `DEFERRABLE INITIALLY DEFERRED`.

---

## How do I generate types from an existing PostgreSQL database?

Point `PostgreSQLIntrospector` at a live database and let it project the catalog into a `SchemaContainer`, then run the same generators you use for authored schemas. Introspection is read-only: it queries catalog metadata and never changes the database.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import {
  PostgreSQLIntrospector,
  SchemaContainer,
  TypeGenerator,
  ZodGenerator,
} from 'blendsdk/codegen';

const password = process.env.PGPASSWORD;
if (!password) {
  throw new Error('Set PGPASSWORD before introspecting the database.');
}

const database = new PostgreSQLDatabase({
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? 'app',
  user: process.env.PGUSER ?? 'app',
  pass: password,
});

const container = new SchemaContainer();

try {
  await new PostgreSQLIntrospector(database).introspect(container);

  const types = await new TypeGenerator().generate(container);
  const validators = await new ZodGenerator().generate(container);

  console.log(types);
  console.log(validators);
} finally {
  await database.disconnect();
}
```

`PostgreSQLDatabase` is the BlendSDK PostgreSQL driver that the introspector consumes; it is the same connection surface the migration runner uses.

---

## How do I give a JSON or JSONB column a concrete type?

`json` and `jsonb` map to `unknown` by default. Supply a `ColumnMapper` that returns a schema object carrying the TypeScript type and the raw Zod expression you want emitted for those columns.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import {
  PostgreSQLIntrospector,
  SchemaContainer,
  TypeGenerator,
  type ColumnMapper,
} from 'blendsdk/codegen';

const mapper: ColumnMapper = (column, scope) => {
  if (column.pg_type !== 'json' && column.pg_type !== 'jsonb') {
    return undefined;
  }
  const mapped = scope.unknown();
  mapped.setData({
    tsType: 'Record<string, unknown>',
    zodExpression: 'z.record(z.string(), z.unknown())',
  });
  return mapped;
};

const password = process.env.PGPASSWORD;
if (!password) {
  throw new Error('Set PGPASSWORD before introspecting the database.');
}

const database = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'app',
  user: 'app',
  pass: password,
});

const container = new SchemaContainer();

try {
  await new PostgreSQLIntrospector(database).introspect(container, mapper);
  console.log(await new TypeGenerator().generate(container));
} finally {
  await database.disconnect();
}
```

Returning `undefined` from the mapper falls back to the built-in mapping, so the same mapper can target only specific tables by also checking `column.relation_name`.

---

## How do I generate an OpenAPI 3.1 document from my controller routes?

Annotate routes with `.openapi()` metadata and register the controller with `OpenAPIGenerator`. Only annotated routes are included (the opt-in rule); Zod validation schemas become request bodies and query parameters, and `:id` path segments become `{id}`.

```typescript
import { z } from 'zod';
import { OpenAPIGenerator } from 'blendsdk/codegen';

type ControllerRoutes = Parameters<OpenAPIGenerator['addRoutes']>[1];

class ProductsController {
  routes(): ControllerRoutes {
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
            {
              statusCode: 200,
              description: 'The product list',
              schema: z.array(z.object({ id: z.string(), name: z.string() })),
            },
          ],
        },
      },
      {
        method: 'post',
        path: '/',
        handler: () => undefined,
        secure: true,
        validation: z.object({ name: z.string(), price: z.number() }),
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
  title: 'Product API',
  version: '1.0.0',
  servers: [{ url: 'https://api.example.com', description: 'Production' }],
  securitySchemes: {
    bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  },
  defaultSecurity: [{ bearerAuth: [] }],
});

generator.addController('/api/products', ProductsController);
generator.toFile('./api.json');

const document = generator.generate();
console.log(Object.keys(document.paths)); // [ '/api/products' ]
```

Every operation records an `x-blend-envelope` value (`data` by default, or `body` when a route opts into `envelope: 'body'`), which is the signal the generated client uses to read a successful response.

---

## How do I generate a typed API client from an OpenAPI document?

Call `generateClient` with the committed document and an output directory. It writes marker-stamped `types.ts`, `client.ts`, and `index.ts`, formats everything with Prettier, and prunes stale marker files while leaving hand-written files untouched.

```typescript
import { generateClient, type OpenAPIDocument } from 'blendsdk/codegen';

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Product API', version: '1.0.0' },
  paths: {
    '/api/products': {
      get: {
        operationId: 'listProducts',
        tags: ['products'],
        responses: {
          '200': {
            description: 'The product list',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Product' } },
              },
            },
          },
        },
      },
    },
    '/api/products/{id}': {
      get: {
        operationId: 'getProduct',
        tags: ['products'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'One product',
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
        properties: { id: { type: 'string' }, name: { type: 'string' } },
        required: ['id', 'name'],
      },
    },
  },
};

const result = await generateClient(document, {
  outputDir: './src/api-client',
  clientName: 'ProductClient',
});

console.log(result.files); // [ 'client.ts', 'index.ts', 'types.ts' ]
console.log(result.issues); // contract warnings such as a missing operationId
```

The generated `ProductClient` groups methods by tag (or by the first path segment after `/api`), names them from `operationId`, flattens path, query, and JSON body properties into one `params` object, and imports the runtime from `blendsdk/api-client` unless you set `runtimeImport`.

---

## How do I split the generated client into one file per tag?

Set `splitByGroup: true`. Each group gets its own `client.<group>.ts`, and `client.ts` becomes a barrel that wires the groups into one client.

```typescript
import { generateClient, type OpenAPIDocument } from 'blendsdk/codegen';

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Shop API', version: '1.0.0' },
  paths: {
    '/api/products': {
      get: {
        operationId: 'listProducts',
        tags: ['products'],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } },
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
            description: 'OK',
            content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } },
          },
        },
      },
    },
  },
};

const result = await generateClient(document, {
  outputDir: './src/api-client',
  splitByGroup: true,
});

console.log(result.files);
// [ 'client.orders.ts', 'client.products.ts', 'client.ts', 'index.ts', 'types.ts' ]
```

Group names are sanitized into camelCase identifiers (`product-catalog` becomes `productCatalog`), and groups that disappear from the contract have their stale generated files pruned on the next run.

---

## How do I fail CI when the generated API artifacts drift?

Use `checkClient` instead of `generateClient` in the pipeline. It regenerates in memory, compares every expected file plus leftover marker files, escalates contract warnings to errors, and reports exactly which files differ.

```typescript
import { checkClient, generateClient, type OpenAPIDocument } from 'blendsdk/codegen';

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Shop API', version: '1.0.0' },
  paths: {
    '/api/health': {
      get: {
        operationId: 'getHealth',
        tags: ['health'],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { status: { type: 'string' } },
                  required: ['status'],
                },
              },
            },
          },
        },
      },
    },
  },
};

const outputDir = './src/api-client';

await generateClient(document, { outputDir });

const result = await checkClient(document, { outputDir });

if (result.drifted) {
  for (const file of result.driftedFiles ?? []) {
    console.error(`DRIFT ${file}`);
  }
  process.exitCode = 1;
} else {
  console.log(`IN SYNC ${result.files.join(', ')}`);
}

for (const issue of result.issues) {
  console.error(`${issue.severity.toUpperCase()} ${issue.message}`);
}
```

`checkClient` treats a missing `operationId` or a missing 2xx schema as an error; `generateClient` records those as warnings unless you pass `strict: true`. The equivalent command-line gate is `blendsdk api check`.

---

## How do I declare the `blendsdk.api.ts` contract used by `blendsdk api generate` and `blendsdk api check`?

Author one default-exported contract with `defineApiContract`. It names the controllers to collect, where the OpenAPI JSON and client go, the document metadata, and the generator flags. `blendsdk api generate` rebuilds the document and writes both artifacts; `blendsdk api check` rebuilds in memory and exits `1` on drift, `2` on configuration problems.

```typescript
// blendsdk.api.ts
import { z } from 'zod';
import { defineApiContract, type OpenAPIGenerator } from 'blendsdk/codegen';

type ControllerRoutes = Parameters<OpenAPIGenerator['addRoutes']>[1];

class ProductsController {
  routes(): ControllerRoutes {
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
            {
              statusCode: 200,
              description: 'The product list',
              schema: z.array(z.object({ id: z.string(), name: z.string() })),
            },
          ],
        },
      },
    ];
  }
}

export default defineApiContract({
  outputDir: './src/api-client',
  contractFile: './api.json',
  controllers: [{ basePath: '/api/products', controller: ProductsController }],
  openapi: {
    title: 'Product API',
    version: '1.0.0',
    servers: [{ url: 'https://api.example.com' }],
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    defaultSecurity: [{ bearerAuth: [] }],
  },
  generator: { splitByGroup: true, clientName: 'ProductClient' },
});
```

- The file is discovered upward from the working directory (or passed with `--config <path>`); discovery stops at the repository root.
- Paths are resolved against the configuration directory and may not escape it; `contractFile` defaults to `api.json`.
- Unknown top-level keys and unknown `generator` keys are rejected, so a typo fails with exit code `2` instead of being silently ignored.
- `generator` accepts `splitByGroup`, `strict`, `clientName`, and `runtimeImport`; `outputDir` is set once at the top level.

---

## How do I configure snapshot-based migrations?

Create a `blendsdk.migrations.ts` file with `defineMigrationConfig`, and point `schema` at the module that default-exports your desired `DatabaseSchema`. The loader never reads the database URL and never imports the schema module for execution-only commands.

```typescript
// blendsdk.migrations.ts
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

```typescript
// src/database/schema.ts
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');

const customer = schema.table('customer');
customer.bigserial('id').primaryKey();
customer.text('email').unique();
customer.text('display_name').nullable();

export default schema;
```

- Defaults: `migrationsDir` is `migrations`, `snapshotFile` is `<migrationsDir>/schema.snapshot.json`, `databaseUrlEnv` is `DATABASE_URL`, lock timeout `5000`, statement timeout `900000`.
- `databaseUrlEnv` must be an uppercase environment-variable name; credentials never live in the configuration file.
- Create the first lineage with `blendsdk migrate baseline initial` (or the `generateBaseline` API) and later changes with `blendsdk migrate generate <slug>`; commit the generated `*.up.sql` together with the updated `schema.snapshot.json`.

---

## How do I generate a migration and review what changed?

Call `generateMigration` after editing the desired schema. The returned `changes` list carries a safety class per change, and the new `.up.sql` file is written atomically together with the canonical snapshot. Read the file, review it, and commit both artifacts.

```typescript
import { readFile } from 'node:fs/promises';
import { generateMigration } from 'blendsdk/codegen';

const result = await generateMigration({ name: 'add-customer-status' });

if (result.status === 'UP_TO_DATE') {
  console.log('The desired schema matches the committed snapshot; nothing was written.');
} else if (result.migration) {
  console.log(`GENERATED ${result.migration.id}`);
  for (const change of result.changes) {
    console.log(`${change.safety.padEnd(11)} ${change.kind}`);
  }
  console.log(await readFile(result.migration.upPath, 'utf8'));
}
```

Changes classified `safe` render automatically (nullable column adds, defaults, comments, supported constraints and indexes). `destructive` changes such as drops require `allowDestructive: true` after review, while `caution`, `ambiguous`, and `unsupported` changes block generation with a `MigrationError` carrying manual guidance. Use the `now` option when you need a deterministic migration timestamp in tests.

---

## How do I record a table or column rename instead of a drop and create?

Pass explicit `renameHints`. Without them, a structurally identical drop/add pair is classified `ambiguous` and generation is blocked, because the planner refuses to guess which table should be renamed.

```typescript
import { generateMigration } from 'blendsdk/codegen';

const result = await generateMigration({
  name: 'rename-customer-to-client',
  renameHints: [
    { kind: 'table', from: 'public.customer', to: 'public.client' },
    { kind: 'column', from: 'public.customer.email', to: 'public.client.email_address' },
  ],
});

if (result.migration) {
  console.log(`GENERATED ${result.migration.id}`);
}
```

Hints must be one-to-one and acyclic, must stay inside one schema, and must map an identity that exists in the prior snapshot to an identity that exists in the desired schema. A column that moves between tables needs the matching table rename hint. The generated SQL then uses `ALTER TABLE … RENAME TO` and `RENAME COLUMN`; the command-line equivalents are `--rename-table from=to` and `--rename-column from=to`.

---

## How do I apply pending migrations and report status?

Use `runMigrations`, `getMigrationStatus`, and `validateMigrations` from the package root. Execution validates local history against the checksummed ledger, takes a database-scoped advisory lock, and runs each migration in its own transaction unless the file is marked nontransactional.

```typescript
import {
  getMigrationStatus,
  runMigrations,
  validateMigrations,
} from 'blendsdk/codegen';

const status = await getMigrationStatus();
console.log(`STATUS ${status.status}`);

const plan = await runMigrations({ command: 'up', dryRun: true });
console.log(`PENDING ${plan.migrations.map(migration => migration.id).join(', ') || 'none'}`);

if (plan.status === 'PENDING') {
  const applied = await runMigrations({ command: 'up' });
  console.log(`APPLIED ${applied.migrations.map(migration => migration.id).join(', ')}`);
}

const validation = await validateMigrations();
console.log(`VALIDATE ${validation.status}`);
```

- `status` and `validate` never create the ledger or mutate PostgreSQL; `validate` accepts `offline: true` to check local files and lineage without a database URL.
- `down` requires `allowDown: true` and reverts exactly the newest applied migration; it refuses when that migration has no down file.
- Every mutating command accepts `signal` for caller-owned cancellation; aborting an in-flight transaction cancels the backend and rolls back without recording success.
- Pass `configPath` to select a configuration explicitly when discovery from the working directory is not what you want.

---

## How do I adopt an existing database into the migration ledger?

Generate the local baseline lineage first (offline), then call `adoptBaseline` against the existing database. It compares the supported catalog with the canonical snapshot, reports unmanaged functions, triggers, and types as informational entries, and — only after the exact target confirmation — records the baseline row *without executing the baseline SQL*.

```typescript
import { adoptBaseline, formatMigrationError, MigrationError } from 'blendsdk/codegen';

const confirmation = process.env.BLENDSDK_ADOPT_CONFIRMATION;
if (!confirmation) {
  throw new Error(
    'Set BLENDSDK_ADOPT_CONFIRMATION to <database>/<baseline-id> after quiescing all DDL.'
  );
}

try {
  const result = await adoptBaseline(
    { confirmation },
    {
      afterPreview: preview => {
        console.log(`TARGET ${preview.user}@${preview.host}:${preview.port}/${preview.database}`);
        console.log(`BASELINE ${preview.baselineId}`);
        for (const item of preview.comparison) {
          console.log(`${item.classification} ${item.identity}`);
        }
        return confirmation;
      },
    }
  );

  console.log(result.status); // ADOPTED
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(formatMigrationError(error));
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}
```

The preview is informational and sanitized (no password, no URL query values). The authoritative comparison repeats inside the ledger transaction, so a raced catalog change or a modified local migration aborts adoption before any row is inserted. Mismatches report a qualified identity such as `column.public.customer.name`, never SQL text.

---

## How do I find out why generation was blocked?

Expected failures are typed. `MigrationError` carries a stable `kind` (`CONFIGURATION`, `INVALID_HISTORY`, `UNSUPPORTED`, `LOCKED`, `UNKNOWN_OUTCOME`, `ABORTED`, `FILESYSTEM`, `INTERNAL`), a process `exitCode` of `1` or `2`, and a message that is redacted at construction time. `formatMigrationError` renders the category and still-redacted message for operator output.

```typescript
import { formatMigrationError, generateMigration, MigrationError } from 'blendsdk/codegen';

try {
  await generateMigration({ name: 'drop-legacy-column' });
} catch (error) {
  if (error instanceof MigrationError) {
    // Example: "UNSUPPORTED: Destructive migration changes require explicit approval."
    console.error(formatMigrationError(error));
    console.error(`kind=${error.kind} exit=${error.exitCode}`);
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}
```

- A blocked change reports the first unsafe change's guidance; nothing is written and the committed snapshot stays byte-identical.
- PostgreSQL URLs and `password=`/`secret=`/`token=` assignments are removed from the message, and provider detail such as SQL text is never retained.
- `generateClient` has its own fatal error, `ClientGenerationError`, thrown when two operations share an `operationId` or resolve to the same group/method pair; the message names both conflicting locations. Contract problems that are not fatal are returned in `GenerationResult.issues` with `warning` or `error` severity.
- The command-line adapters return the same classes of exit code: `0` success, `1` drift or operational failure, `2` usage or configuration failure.

---

# codegen Examples Library

This library is a categorized set of copy-paste ready examples for `blendsdk/codegen`. Every example is a complete ESM module: it includes all imports, uses strict TypeScript types, and relies on top-level `await` (run it with `tsx`, `node --experimental-strip-types`, or any ESM-aware runner).

Install the umbrella package once with `npm install blendsdk`. The database-backed examples (introspection, migrations, baseline adoption) additionally need the optional `pg` peer: `npm install blendsdk pg`. All generation, validation, and diffing examples run fully offline.

Examples are ordered from simple to complex inside each category:

- Schema Definition and TypeScript Types
- Zod Validators and String Constraints
- PostgreSQL Schema Authoring and DDL
- Database Introspection
- OpenAPI Documents
- API Client Generation
- Migrations
- Constant Column Types

---

## Schema Definition and TypeScript Types

### Generate an interface from an object schema

`TypeGenerator` renders one named object schema as a TypeScript `interface` and records the structural annotations as JSDoc.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

scope
  .object({
    id: scope.number(),
    email: scope.string(),
    nickname: scope.string().optional(),
  })
  .named('Customer');

const source = await new TypeGenerator().generate(container);

console.log(source);

// Output:
// /**
//  * @interface
//  */
// export interface Customer {
//   /**
//    * @memberOf {Customer}
//    */
//   id: number;
//   /**
//    * @memberOf {Customer}
//    */
//   email: string;
//   /**
//    * @optional
//    * @memberOf {Customer}
//    */
//   nickname?: string;
// }
```

---

### Optional, nullable, array, and partial modifiers

Modifiers compose in a fixed order — `Partial<T>`, then `T[]`, then `Record<string, T>`, then `T | null` — so the rendered type is predictable.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

scope.string().named('plain_text');
scope.string().nullable().named('nullable_text');
scope.string().arrayed().named('text_list');
scope.number().arrayed().nullable().named('nullable_numbers');
scope.object({ active: scope.boolean() }).partial().named('patch');

const source = await new TypeGenerator().generate(container);

console.log(source);

// JSDoc annotations omitted for brevity. The generated declarations are:
// export type PlainText = string;
// export type NullableText = string | null;
// export type TextList = string[];
// export type NullableNumbers = number[] | null;
// export type Patch = Partial<{
//   active: boolean;
// }>;
```

`.optional()` on a root alias has no `?` to attach to; it only changes a property when the schema is used inside an object.

---

### Scope the same shape into distinct types

`container.scope(name)` prefixes every schema created through that scope, so two versions of the same request type can live in one container without colliding.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const base = container.scope();

const user = base
  .object({
    username: base.string(),
    password: base.string(),
  })
  .named('user');

const v1 = container.scope('api_v1');
v1.object({ user: base.ref(user).nullable() }).named('user_request');

const v2 = container.scope('api_v2');
v2.object({ user: base.ref(user) }).named('user_request');

const source = await new TypeGenerator().generate(container);

console.log(source);

// export interface User {
//   username: string;
//   password: string;
// }
//
// export interface ApiV1UserRequest {
//   user: User | null;
// }
//
// export interface ApiV2UserRequest {
//   user: User;
// }
```

---

### Emit literal unions from enums

`.enum()` turns a string or number schema into a literal union while `.ref()` keeps a single named identity that other schemas can reuse.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

const direction = scope.string().enum(['up', 'down']).named('direction');
const level = scope.number().enum([1, 2, 3]).named('level');

scope
  .object({
    heading: scope.ref(direction),
    levels: scope.ref(level).arrayed(),
  })
  .named('movement');

const source = await new TypeGenerator().generate(container);

console.log(source);

// export type Direction = "up" | "down";
// export type Level = 1 | 2 | 3;
//
// export interface Movement {
//   heading: Direction;
//   levels: Level[];
// }
```

---

### Record and partial reference types

`.recordSet()` wraps a type in `Record<string, T>`, and it composes with `.partial()` on a reference so a map of partial rows is a single chain.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

scope.unknown().recordSet().named('metadata_map');

const row = scope
  .object({
    id: scope.string().optional(),
    name: scope.string(),
  })
  .named('Row');

scope
  .object({
    labels: scope.string().recordSet(),
    rows: scope.ref(row).partial().recordSet(),
  })
  .named('payload');

const source = await new TypeGenerator().generate(container);

console.log(source);

// export type MetadataMap = Record<string, unknown>;
//
// export interface Row {
//   id?: string;
//   name: string;
// }
//
// export interface Payload {
//   labels: Record<string, string>;
//   rows: Record<string, Partial<Row>>;
// }
```

---

## Zod Validators and String Constraints

### Generate Zod validators from the same schema

`ZodGenerator` walks the identical schema graph as `TypeGenerator`, so the compile-time type and the runtime validator can never describe different shapes.

```typescript
import { SchemaContainer, ZodGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

scope
  .object({
    id: scope.number(),
    email: scope.string(),
    nickname: scope.string().optional(),
  })
  .named('customer');

const source = await new ZodGenerator().generate(container);

console.log(source);

// import * as z from 'zod';
//
// export const CustomerSchema = z.object({
//   id: z.number(),
//   email: z.string(),
//   nickname: z.string().optional(),
// });
```

---

### Constrain a string with a pattern and length bounds

`.pattern()`, `.minLength()`, and `.maxLength()` are validated when you author them and then carried into generated TypeScript (JSDoc), generated Zod (`.regex`, `.min`, `.max`), and generated OpenAPI (`pattern`, `minLength`, `maxLength`).

```typescript
import { SchemaContainer, TypeGenerator, ZodGenerator } from 'blendsdk/codegen';

const PROJECT_NAME_PATTERN = '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$';

const container = new SchemaContainer();
container
  .scope()
  .string()
  .pattern(PROJECT_NAME_PATTERN)
  .minLength(3)
  .maxLength(40)
  .named('project_name');

console.log(await new TypeGenerator().generate(container));
console.log(await new ZodGenerator().generate(container));

// /**
//  * @type
//  * @pattern ^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$
//  * @minLength 3
//  * @maxLength 40
//  */
// export type ProjectName = string;
//
// import * as z from 'zod';
//
// export const ProjectNameSchema = z
//   .string()
//   .regex(new RegExp("^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$"))
//   .min(3)
//   .max(40);

// Invalid authoring input fails immediately, before any file is written.
try {
  container.scope().string().pattern('[');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  // Invalid pattern for schema (unnamed): [
}
```

At runtime the generated module is imported and used directly:

```typescript
// typescript fragment — ProjectNameSchema comes from the generated validators module.
ProjectNameSchema.safeParse('abc').success; // true
ProjectNameSchema.safeParse('ab').success; // false — below minLength 3
ProjectNameSchema.safeParse('ABC').success; // false — pattern violation
```

---

### Binary and unknown values

`scope.binary()` maps PostgreSQL `bytea` to `Buffer` with `z.instanceof(Buffer)`, and `scope.unknown()` is the safe default for `json`/`jsonb`.

```typescript
import { SchemaContainer, TypeGenerator, ZodGenerator } from 'blendsdk/codegen';

const container = new SchemaContainer();
const scope = container.scope();

scope.binary().named('binary_payload');
scope.unknown().named('json_document');

console.log(await new TypeGenerator().generate(container));
console.log(await new ZodGenerator().generate(container));

// export type BinaryPayload = Buffer;
// export type JsonDocument = unknown;
//
// export const BinaryPayloadSchema = z.instanceof(Buffer);
// export const JsonDocumentSchema = z.unknown();
```

---

## PostgreSQL Schema Authoring and DDL

### Model tables, keys, and foreign keys

`DatabaseSchema` is the desired-state authoring API consumed by both the initializer generator and the migration planner.

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const db = new DatabaseSchema('app');

const customer = db.table('customer');
customer.bigserial('id').primaryKey();
customer.varchar('email', 255).unique();
customer.text('display_name').nullable();
customer.timestamptz('created_at').default('now()');

const purchase = db.table('purchase');
purchase.bigserial('id').primaryKey();
purchase.bigint('customer_id');
purchase.decimal('total', 12, 2);
purchase
  .foreignKeyConstraint(customer)
  .from('customer_id')
  .to('id')
  .onUpdate('RESTRICT')
  .onDelete('CASCADE')
  .deferrable('DEFERRED');

console.log(db.getTables().map(table => table.getName()));
console.log(purchase.getForeignKeyConstrains()[0]?.isDeferrable());

// [ 'public.customer', 'public.purchase' ]
// true
```

---

### Generate bootstrap DDL

`PostgreSQLSchemaGenerator` renders complete DDL for tests, local environments, or a first deployment, and `generateGrouped()` splits it into reviewable sections.

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const db = new DatabaseSchema('app');
db.extension('pgcrypto');

const account = db.table('account');
account.bigserial('id').primaryKey();
account.varchar('email', 255).unique();
account.text('display_name').nullable().comment('Shown in the UI');

db.view('account_email').as('SELECT id, email FROM public.account');

const generator = new PostgreSQLSchemaGenerator(db);
const ddl = generator.generateGrouped({ dropBeforeCreate: false });

console.log(ddl.schema);
console.log(ddl.views);
console.log(ddl.all === `${ddl.schema}${ddl.indexes}${ddl.views}` || ddl.all.includes(ddl.schema));

// ddl.schema (excerpt):
// CREATE EXTENSION IF NOT EXISTS "pgcrypto";
//
// CREATE TABLE public.account (
//   id bigserial NOT NULL,
//   email varchar(255) NOT NULL,
//   display_name text
// );
//
// ALTER TABLE public.account
//   ADD CONSTRAINT account_id_pkey PRIMARY KEY (id),
//   ...
// COMMENT ON COLUMN public.account.display_name IS 'Shown in the UI';
//
// ddl.views:
// DROP VIEW IF EXISTS public.account_email CASCADE;
// CREATE OR REPLACE VIEW public.account_email AS SELECT id, email FROM public.account;
```

`generate()` returns the same content as one combined string. Passing `{ dropBeforeCreate: true }` (the default) prefixes `DROP TABLE … CASCADE` statements.

---

### Add indexes, checks, and unique constraints

Indexes support expressions, predicates, included columns, storage parameters, and tablespaces; checks and unique constraints are emitted as `ALTER TABLE … ADD CONSTRAINT`.

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const db = new DatabaseSchema('app');
const product = db.table('product');
product.bigserial('id').primaryKey();
product.text('sku').check('length(sku) > 0');
product.text('name');
product.integer('price_cents');
product.index().indexName('product_sku_idx').column('sku').unique();
product
  .index()
  .indexName('product_lower_name_idx')
  .expression('lower(name)')
  .where('price_cents > 0');

const ddl = new PostgreSQLSchemaGenerator(db).generateGrouped({ dropBeforeCreate: false });

console.log(ddl.indexes);

// CREATE UNIQUE INDEX product_sku_idx ON public.product (sku);
// CREATE INDEX product_lower_name_idx ON public.product (lower(name)) WHERE price_cents > 0;

console.log(ddl.schema.includes('ADD CONSTRAINT product_check_0 CHECK (length(sku) > 0)'));

// true
```

---

### Identity columns, defaults, extensions, and views

`identity()` supports integer sequences with explicit options and UUID defaults, automatically registering the extension a UUID generator needs.

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const db = new DatabaseSchema('app', 'billing');

const invoice = db.table('invoice');
invoice.uuid('id').identity('v4');
invoice.text('reference');
invoice.integer('sequence').identity('BY DEFAULT', { start: 100, increment: 5, cache: 10 });
invoice.timestamptz('created_at').default('now()');

db.view('invoice_summary').as('SELECT reference FROM billing.invoice');

const ddl = new PostgreSQLSchemaGenerator(db).generateGrouped({ dropBeforeCreate: false });

console.log(ddl.schema);
console.log(ddl.views);

// ddl.schema (excerpt):
// CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
//
// CREATE TABLE billing.invoice (
//   id uuid NOT NULL DEFAULT uuid_generate_v4(),
//   reference text NOT NULL,
//   sequence integer GENERATED BY DEFAULT AS IDENTITY (START WITH 100 INCREMENT BY 5 CACHE 10),
//   created_at timestamptz NOT NULL DEFAULT now()
// );
//
// ddl.views:
// DROP VIEW IF EXISTS billing.invoice_summary CASCADE;
// CREATE OR REPLACE VIEW billing.invoice_summary AS SELECT reference FROM billing.invoice;
```

---

## Database Introspection

### Introspect a live database into TypeScript

`PostgreSQLIntrospector` reads catalog metadata only — it never mutates the database — and projects each relation into a named schema object.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import {
  PostgreSQLIntrospector,
  SchemaContainer,
  TypeGenerator,
  ZodGenerator,
} from 'blendsdk/codegen';

const database = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'app',
  user: 'app',
  pass: 'app',
});

const container = new SchemaContainer();

try {
  await new PostgreSQLIntrospector(database).introspect(container);

  console.log(await new TypeGenerator().generate(container));
  console.log(await new ZodGenerator().generate(container));
} finally {
  await database.disconnect();
}

// For public.customer (id bigint NOT NULL PRIMARY KEY, email varchar(255) NOT NULL, nickname text):
// export interface Customer {
//   id: string;                 // bigint is returned as a string by pg
//   email: string;              // @primaryKey / @unique are recorded in JSDoc
//   nickname?: string | null;   // nullable columns become optional and null
// }
//
// export const CustomerSchema = z.object({
//   id: z.string(),
//   email: z.string(),
//   nickname: z.string().optional().nullable(),
// });
```

---

### Map JSON columns and read column-name constants

A `ColumnMapper` overrides the default mapping for specific columns, and `introspectConstantTypes()` returns the qualified relation → column-name map used by `CTypeGenerator`.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import {
  PostgreSQLIntrospector,
  SchemaContainer,
  TypeGenerator,
  type ColumnMapper,
} from 'blendsdk/codegen';

const database = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'app',
  user: 'app',
  pass: 'app',
});

const container = new SchemaContainer();

const mapJsonColumns: ColumnMapper = (column, scope) => {
  if (column.pg_type !== 'json' && column.pg_type !== 'jsonb') {
    return undefined;
  }
  const mapped = scope.any();
  mapped.setData({
    tsType: 'Record<string, unknown>',
    zodExpression: 'z.record(z.string(), z.unknown())',
  });
  return mapped;
};

try {
  const introspector = new PostgreSQLIntrospector(database);
  await introspector.introspect(container, mapJsonColumns);

  const columns = await introspector.introspectConstantTypes();
  console.log(columns['customer']); // [ 'id', 'email', 'payload' ]

  console.log(await new TypeGenerator().generate(container));
} finally {
  await database.disconnect();
}

// export interface Customer {
//   id: string;
//   email: string;
//   payload?: Record<string, unknown> | null;
// }
```

---

## OpenAPI Documents

### Generate an OpenAPI 3.1 document from a controller

`OpenAPIGenerator` collects only the routes that carry `.openapi()` metadata, converts their Zod schemas with native `z.toJSONSchema`, and applies `defaultSecurity` to every `secure` route.

```typescript
import { z } from 'zod';
import type { RouteDefinition } from 'blendsdk/webafx';
import { OpenAPIGenerator } from 'blendsdk/codegen';

const ProductSchema = z.object({ id: z.number(), name: z.string() });

class ProductsController {
  routes(): RouteDefinition[] {
    return [
      {
        method: 'get',
        path: '/',
        handler: () => undefined,
        openapi: {
          operationId: 'listProducts',
          tags: ['products'],
          summary: 'List products',
          responses: [
            { statusCode: 200, description: 'Products', schema: z.array(ProductSchema) },
          ],
        },
      },
      {
        method: 'post',
        path: '/',
        secure: true,
        validation: z.object({ name: z.string().min(1) }),
        handler: () => undefined,
        openapi: {
          operationId: 'createProduct',
          tags: ['products'],
          summary: 'Create a product',
          responses: [{ statusCode: 201, description: 'Created', schema: ProductSchema }],
        },
      },
    ];
  }
}

const generator = new OpenAPIGenerator({
  title: 'Catalog API',
  version: '1.0.0',
  servers: [{ url: 'http://localhost:3000', description: 'Local' }],
  securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
  defaultSecurity: [{ bearerAuth: [] }],
});

generator.addController('/api/products', ProductsController);

const document = generator.generate();

console.log(Object.keys(document.paths)); // [ '/api/products' ]
console.log(document.paths['/api/products'].post?.security); // [ { bearerAuth: [] } ]
console.log(document.paths['/api/products'].get?.['x-blend-envelope']); // 'data'

generator.toFile('./artifacts/api.json');
```

---

### Convert Zod schemas to JSON Schema and query parameters

`convertZodToJsonSchema` normalizes nullable unions into JSON Schema type arrays, `convertZodToQueryParameters` splits an object into one parameter per property, and `hoistDefinitions` moves `$defs` into `components.schemas`.

```typescript
import { z } from 'zod';
import {
  convertZodToJsonSchema,
  convertZodToQueryParameters,
  hoistDefinitions,
  type OpenAPIDocument,
} from 'blendsdk/codegen';

const body = convertZodToJsonSchema(
  z.object({
    name: z.string(),
    nickname: z.string().nullable(),
    tags: z.array(z.string()),
  }),
  'input'
);

console.log(body);
// {
//   type: 'object',
//   properties: {
//     name: { type: 'string' },
//     nickname: { type: ['string', 'null'] },
//     tags: { type: 'array', items: { type: 'string' } },
//   },
//   required: ['name', 'tags'],
// }

const query = z.object({ page: z.coerce.number().default(1), search: z.string().optional() });

console.log(convertZodToQueryParameters(query));
// [
//   { name: 'page', in: 'query', schema: { type: 'number', default: 1 } },
//   { name: 'search', in: 'query', schema: { type: 'string' } },
// ]

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Catalog API', version: '1.0.0' },
  paths: {
    '/api/products': {
      get: {
        operationId: 'listProducts',
        responses: {
          200: {
            description: 'Products',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { product: { $ref: '#/$defs/Product' } },
                  $defs: {
                    Product: {
                      type: 'object',
                      properties: { id: { type: 'number' } },
                      required: ['id'],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const hoisted = hoistDefinitions(document);

console.log(Object.keys(hoisted.components?.schemas ?? {})); // [ 'Product' ]
console.log(JSON.stringify(hoisted).includes('$defs')); // false
```

---

## API Client Generation

### Generate a typed client from a document

`generateClient` writes marker-stamped, Prettier-formatted files and prunes only files that carry the marker, so hand-written modules in the same directory are never touched.

```typescript
import { generateClient, type OpenAPIDocument } from 'blendsdk/codegen';

const document: OpenAPIDocument = {
  openapi: '3.1.0',
  info: { title: 'Catalog API', version: '1.0.0' },
  paths: {
    '/api/products': {
      get: {
        operationId: 'listProducts',
        tags: ['products'],
        responses: {
          200: {
            description: 'Products',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Product' } },
              },
            },
          },
        },
      },
    },
    '/api/products/{id}': {
      get: {
        operationId: 'getProduct',
        tags: ['products'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'Product',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } },
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

const result = await generateClient(document, {
  outputDir: 'src/api-client',
  clientName: 'CatalogClient',
  runtimeImport: 'blendsdk/api-client',
});

console.log(result.files); // [ 'client.ts', 'index.ts', 'types.ts' ]
console.log(result.issues); // []

// types.ts contains the component alias plus per-operation aliases:
// export type Product = { id: number; name: string; };
// export type ProductsGetProductParams = { id: string; };
// export type ProductsListProductsResult = Product[];
//
// client.ts declares the grouped client:
// export interface CatalogClient {
//   products: {
//     listProducts: (options?: RequestOptions) => Promise<ProductsListProductsResult>;
//     getProduct: (params: ProductsGetProductParams, options?: RequestOptions) => Promise<Product>;
//   };
// }
// export function createCatalogClient(options: ApiClientOptions): CatalogClient
```

---

### Enforce the client drift gate in CI

`checkClient` regenerates everything in memory and reports the files that differ from the committed ones — the same comparison the `blendsdk api check` command performs.

```typescript
import { readFile } from 'node:fs/promises';
import { checkClient, type OpenAPIDocument } from 'blendsdk/codegen';

const document = JSON.parse(await readFile('api.json', 'utf8')) as OpenAPIDocument;

const result = await checkClient(document, { outputDir: 'src/api-client', strict: true });

for (const issue of result.issues) {
  const location = `${issue.method?.toUpperCase() ?? ''} ${issue.path ?? ''}`.trim();
  console.error(`${issue.severity.toUpperCase()}: ${issue.message} (${location})`);
}

if (result.drifted) {
  console.error(`DRIFT: ${(result.driftedFiles ?? []).join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('Generated client matches the committed contract.');
}

// Clean run:  'Generated client matches the committed contract.'
// Stale run:  'DRIFT: client.ts'  and process.exitCode === 1
```

With `strict: true`, a missing `operationId` or a missing 2xx response schema is reported as an `error` and marks the run as drifted.

---

### Configure `blendsdk.api.ts` and run the API commands

A project authors one default-exported contract file; the `blendsdk api` commands discover it, rebuild the document from the controllers, and write or check both artifacts.

```typescript
import { z } from 'zod';
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
          tags: ['products'],
          summary: 'List products',
          responses: [
            {
              statusCode: 200,
              description: 'Products',
              schema: z.array(z.object({ id: z.number(), name: z.string() })),
            },
          ],
        },
      },
      {
        method: 'post',
        path: '/',
        secure: true,
        validation: z.object({ name: z.string().min(1) }),
        handler: () => undefined,
        openapi: {
          operationId: 'createProduct',
          tags: ['products'],
          summary: 'Create a product',
          responses: [
            {
              statusCode: 201,
              description: 'Created',
              schema: z.object({ id: z.number(), name: z.string() }),
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
    title: 'Catalog API',
    version: '1.0.0',
    servers: [{ url: 'http://localhost:3000', description: 'Local' }],
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    defaultSecurity: [{ bearerAuth: [] }],
  },
  generator: { splitByGroup: true, strict: true, clientName: 'CatalogClient' },
});
```

Run the two commands from the project root:

1. `npx blendsdk api generate` — rebuilds the document, writes `api.json`, then writes the client into `src/api-client`.
2. `npx blendsdk api check` — rebuilds in memory only and reports `DRIFT: …` when either artifact differs from the committed one.

| Exit code | Meaning |
| --- | --- |
| `0` | Success, or a clean check |
| `1` | Drift detected, or an operational failure |
| `2` | Usage error, or an invalid/missing configuration |

---

## Migrations

### Configure the migration workflow

`defineMigrationConfig` keeps the configuration credential-free: the database URL is referenced by environment-variable *name*, never stored.

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

Paths are resolved relative to the configuration file and may not escape it; unknown keys, numeric coercions, and lowercase environment names are rejected with a `CONFIGURATION` error (exit code `2`).

---

### Generate a migration and review its changes

`generateMigration` is fully offline: it imports the configured schema, normalizes it, diffs it against the committed snapshot, and atomically publishes the SQL file and the new snapshot.

```typescript
import { generateMigration, type SchemaChange } from 'blendsdk/codegen';

const result = await generateMigration({ name: 'add-customer-nickname' });

console.log(result.status); // 'GENERATED' (or 'UP_TO_DATE')
console.log(result.migration?.id); // 20260827120000_add-customer-nickname
console.log(result.migration?.upPath); // /project/migrations/20260827120000_add-customer-nickname.up.sql
console.log(result.previousSnapshot); // sha256 of the committed snapshot
console.log(result.desiredSnapshot); // sha256 written to schema.snapshot.json

const risky: SchemaChange[] = result.changes.filter(
  change => change.safety === 'destructive' || change.safety === 'caution'
);

console.log(risky.map(change => `${change.safety}:${change.kind}`)); // []

for (const change of result.changes) {
  console.log(`${change.safety.padEnd(11)} ${change.kind} ${change.name ?? ''}`);
}

// safe        column.add nickname
```

Ambiguous and unsupported changes throw a `MigrationError` with manual-review guidance instead of guessing SQL:

```typescript
// typescript fragment — hints must reference one prior and one desired identity.
const renamed = await generateMigration({
  name: 'rename-customer-to-account',
  renameHints: [{ kind: 'table', from: 'public.customer', to: 'public.account' }],
  allowDestructive: false,
});
```

---

### Create the initial baseline migration

`generateBaseline` produces the single first migration and canonical snapshot for a new lineage, and refuses to run when any snapshot or up-file history already exists.

```typescript
import { generateBaseline } from 'blendsdk/codegen';

const result = await generateBaseline({ name: 'initial' });

console.log(result.status); // 'GENERATED'
console.log(result.migration.id); // 20260827090000_initial
console.log(result.snapshotHash); // sha256 of the canonical snapshot bytes
console.log(result.changes.length); // one entry per desired addition

// migrations/
//   20260827090000_initial.up.sql
//   schema.snapshot.json
```

The baseline SQL contains only additive DDL: no `DROP TABLE`, no `DROP SCHEMA`, and no `CASCADE`.

---

### Run pending migrations

`runMigrations({ command: 'up' })` proves the local history prefix, takes the database-scoped advisory lock, and applies each pending migration with its ledger row in one transaction.

```typescript
import { runMigrations } from 'blendsdk/codegen';

const result = await runMigrations({ command: 'up' });

console.log(result.status); // 'UP_TO_DATE'
console.log(result.migrations.map(migration => migration.id)); // applied in order
```

---

### Dry-run and cancel a migration run

A dry run reports the pending order while proving lock availability and creating nothing; the signal cancels the run at a safe boundary.

```typescript
import { runMigrations } from 'blendsdk/codegen';

const controller = new AbortController();
const onSigint = () => controller.abort();
process.once('SIGINT', onSigint);

try {
  const planned = await runMigrations({
    command: 'up',
    dryRun: true,
    signal: controller.signal,
  });

  console.log(planned.status); // 'PENDING'
  console.log(planned.migrations.map(migration => migration.id));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  process.removeListener('SIGINT', onSigint);
}
```

---

### Report status and validate history

`getMigrationStatus()` observes the live ledger without mutating it, while `validateMigrations({ offline: true })` checks local files and lineage only — no database connection required.

```typescript
import { getMigrationStatus, validateMigrations } from 'blendsdk/codegen';

const status = await getMigrationStatus();

console.log(status.status);
// 'UP_TO_DATE' | 'PENDING' | 'INVALID_HISTORY' | 'LOCKED' | 'UNKNOWN_OUTCOME'

const offline = await validateMigrations({ offline: true });

console.log(offline.status); // 'UP_TO_DATE' — files and lineage are valid
```

---

### Revert exactly the latest migration

`down` is refused unless `allowDown` is set, and it only reverts the newest applied migration whose row is the exact final ledger entry.

```typescript
import { runMigrations } from 'blendsdk/codegen';

const reverted = await runMigrations({ command: 'down', allowDown: true });

console.log(reverted.migrations.map(migration => migration.id)); // the reverted migration
console.log(reverted.status); // 'PENDING' — the previous migration is now latest
```

Without `allowDown`, the call throws a `MigrationError` with kind `UNSUPPORTED` and exit code `1`, and nothing is executed.

---

### Adopt an existing database baseline

`adoptBaseline` proves structural equality between the live catalog and the desired snapshot, then records the baseline ledger row **without** executing the migration SQL. The preview is informational; the authoritative comparison happens again inside the ledger transaction.

```typescript
import { adoptBaseline, type AdoptionPreview } from 'blendsdk/codegen';

const confirmation = process.env.BLENDSDK_ADOPT_CONFIRMATION;

const result = await adoptBaseline(
  { ...(confirmation ? { confirmation } : {}) },
  {
    afterPreview: (preview: AdoptionPreview) => {
      console.log(`${preview.user}@${preview.host}:${preview.port}/${preview.database}`);
      console.log(`baseline: ${preview.baselineId}`);

      for (const item of preview.comparison) {
        console.log(`${item.classification} ${item.identity}`);
      }

      // Must be exactly `<database>/<baseline-id>` for this target.
      return confirmation;
    },
  }
);

console.log(result.status); // 'ADOPTED'
console.log(result.comparison.every(item => item.classification === 'MATCH')); // true
```

The CLI equivalent is `npx blendsdk migrate adopt-baseline --confirm-adoption <database>/<baseline-id>`. Related unmanaged functions, triggers, enums, and domains are reported as `UNMANAGED` and do not block adoption; incompatible relation shapes, row security, or desired SQL properties that cannot be proven structurally are reported as `UNSUPPORTED_FOR_ADOPTION` and abort before any ledger mutation.

---

### Handle typed migration failures

Every migration API throws `MigrationError`, which carries a stable `kind` and the process exit class, and `formatMigrationError` renders a sanitized message that never includes a connection URL or SQL body.

```typescript
import { MigrationError, formatMigrationError, runMigrations } from 'blendsdk/codegen';

try {
  await runMigrations({ command: 'up' });
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(formatMigrationError(error)); // 'INVALID_HISTORY: Migration prefix or checksum mismatch at position 1.'
    console.error(error.kind); // 'INVALID_HISTORY'
    console.error(error.exitCode); // 1
  } else {
    throw error;
  }
}
```

| `kind` | Meaning |
| --- | --- |
| `CONFIGURATION` | Missing or invalid configuration, or a missing confirmation token |
| `INVALID_HISTORY` | Local files, lineage, or ledger prefix do not agree |
| `FILESYSTEM` | Artifact publication or discovery failed safely |
| `DATABASE` | PostgreSQL rejected or lost the operation |
| `LOCKED` | Another session holds the migration advisory lock |
| `UNKNOWN_OUTCOME` | A nontransactional migration was dispatched but not confirmed |
| `UNSUPPORTED` | The change needs reviewed manual SQL |
| `ABORTED` | The caller's signal cancelled the operation |
| `INTERNAL` | A guard in the library itself was violated |

---

## Constant Column Types

### Generate constant column-name unions

`CTypeGenerator` turns the qualified relation → column-name map into `as const`-style objects, which is what makes column names type-checked in query code.

```typescript
import { CTypeGenerator, type ConstantType } from 'blendsdk/codegen';

const columns: ConstantType = {
  customer: ['id', 'email', 'display_name'],
  'billing.invoice': ['id', 'total'],
};

console.log(await new CTypeGenerator().generate(columns));

// /**
//  * Constant type for relation customer
//  * @export
//  * @constant
//  */
// export const eCustomer = {
//   $TABLE: "customer",
//   ID: "id",
//   EMAIL: "email",
//   DISPLAY_NAME: "display_name",
// };
//
// /**
//  * Constant type for relation billing.invoice
//  * @export
//  * @constant
//  */
// export const eBillingInvoice = {
//   $TABLE: "billing.invoice",
//   ID: "id",
//   TOTAL: "total",
// };
```

The input type matches `PostgreSQLIntrospector.introspectConstantTypes()`, so the introspected map can be passed to `generate()` directly:

```typescript
// typescript fragment — introspector is an already-connected PostgreSQLIntrospector.
const columns = await introspector.introspectConstantTypes();
const source = await new CTypeGenerator().generate(columns);
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
