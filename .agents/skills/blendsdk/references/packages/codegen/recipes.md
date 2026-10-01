> **Package**: `blendsdk/codegen`

# codegen Advanced Patterns

These patterns combine the schema model, the generators, and the PostgreSQL toolchain into workflows that hold up in production: single-source-of-truth code generation, versioned API surfaces, drift-checked OpenAPI documents, live-database type export, disposable-database provisioning, one-time lineage adoption, and a deploy gate that refuses to guess.

Every example is complete and runnable: imports come from the package root (`blendsdk/codegen`) plus `zod`, `blendsdk/webafx`, and `blendsdk/postgresql` where the workflow crosses package boundaries. Generated output appears as abridged, Prettier-formatted excerpts.

---

## Pattern 1: Types and Validators from a Single Model

**Use it when** the same payloads need compile-time types *and* runtime validation — the classic case being an API package whose DTOs are declared once and consumed everywhere.

A `SchemaContainer` is the single source of truth. `TypeGenerator` renders it as exported interfaces and type aliases; `ZodGenerator` renders it as Zod v4 schemas. Both generators consume the same objects in the same run, so a renamed field or a new optional property cannot land in one artifact and miss the other.

### Implementation

```typescript
// scripts/generate-contracts.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SchemaContainer, TypeGenerator, ZodGenerator } from 'blendsdk/codegen';

const outputDirectory = join(process.cwd(), 'src', 'generated');

async function writeGenerated(fileName: string, source: string): Promise<void> {
  const target = join(outputDirectory, fileName);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source, 'utf8');
}

const schema = new SchemaContainer();
const scope = schema.scope();

const customer = scope
  .object({
    id: scope.number(),
    email: scope.string().description('Unique login address'),
    display_name: scope.string().optional(),
    created_at: scope.date(),
  })
  .named('customer');

scope
  .object({
    customer: scope.ref(customer),
    requested_at: scope.date(),
  })
  .named('customer_lookup');

const types = await new TypeGenerator().generate(schema);
const validation = await new ZodGenerator().generate(schema);

await Promise.all([
  writeGenerated('types.ts', types),
  writeGenerated('validation.ts', validation),
]);
```

Generated `types.ts` (abridged):

```typescript fragment
export interface Customer {
  id: number;
  /**
   * Unique login address
   */
  email: string;
  display_name?: string;
  created_at: Date;
}

export interface CustomerLookup {
  customer: Customer;
  requested_at: Date;
}
```

Generated `validation.ts`:

```typescript fragment
import * as z from "zod";

export const CustomerSchema = z.object({
  id: z.number(),
  email: z.string(),
  display_name: z.string().optional(),
  created_at: z.date(),
});

export const CustomerLookupSchema = z.object({
  customer: CustomerSchema,
  requested_at: z.date(),
});
```

### Why this pattern works

- **One edit, two artifacts.** `display_name` becomes `display_name?: string` in the interface and `z.string().optional()` in the validator from the same `.optional()` call. There is no second declaration to keep in sync.
- **References stay references.** `scope.ref(customer)` renders as `Customer` in the type module and as `CustomerSchema` in the validator module — the second object never copies the first.
- **Descriptions become JSDoc.** Text recorded with `.description(...)` lands in the generated type, so reviewers see the schema author's intent.
- **Declaration order is dependency order.** Referenced objects are declared in the container before the objects that use them, so the generated Zod module binds every constant before it is used.

### Caveats and performance notes

- **Run generators sequentially over one container.** Each `generate()` call resets render state on every schema object before rendering, which is what makes multiple generators over one container safe — but that state is shared mutable data, so never start two generators concurrently against the same container.
- **Only named, root-level objects are emitted.** Naming an object that is used as a property throws an error; create a named root type and reference it with `.ref()` instead.
- **Generated names are derived from schema names** (`customer` → `Customer`, `CustomerSchema`), so renaming a schema object is a breaking change for every consumer of the generated code.
- **`generate()` is asynchronous** because output is formatted with Prettier. Keep generation in the build step, not in request handling.
- **`zod` is required by the generated validators.** The emitted module imports Zod directly, so the consuming package must depend on Zod v4.
- Treat generated files as read-only: regenerate them in CI and review the diff instead of editing them by hand.

---

## Pattern 2: Versioned API Scopes over a Shared Domain Core

**Use it when** two or more API versions must be served from one codebase and their payload envelopes differ, but the underlying domain shapes are the same.

Hand-maintained version DTOs drift the moment the core model changes — v2 quietly keeps an old field list while v1 moves on. Scopes solve this with one core definition and one naming namespace per version: `schema.scope('api_v1')` prefixes every exported type name so both versions can live in a single generated module.

### Implementation

```typescript
// scripts/generate-api-types.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();

// ── Domain core: the canonical shapes, unscoped ─────────────────────────────
const core = schema.scope();

const user = core
  .object({
    id: core.number(),
    email: core.string(),
    display_name: core.string().nullable(),
  })
  .named('user');

const order = core
  .object({
    id: core.number(),
    total: core.number(),
    placed_at: core.date(),
  })
  .named('order');

// ── /api/v1: response envelopes, every field present ────────────────────────
const v1 = schema.scope('api_v1');

v1.object({
  data: v1.ref(user),
}).named('user_response');

v1.object({
  data: v1.ref(order).arrayed(),
  total: v1.number(),
}).named('order_page');

// ── /api/v2: flat payloads, sparse updates, lookup maps ─────────────────────
const v2 = schema.scope('api_v2');

v2.object({
  user: v2.ref(user).partial(),
}).named('user_patch');

v2.object({
  users_by_id: v2.ref(user).recordSet(),
}).named('user_directory');

const source = await new TypeGenerator().generate(schema);
await mkdir('src/generated', { recursive: true });
await writeFile('src/generated/api-types.ts', source, 'utf8');
```

Generated `api-types.ts` (abridged):

```typescript fragment
export interface User {
  id: number;
  email: string;
  display_name: string | null;
}

export interface Order {
  id: number;
  total: number;
  placed_at: Date;
}

export interface ApiV1UserResponse {
  data: User;
}

export interface ApiV1OrderPage {
  data: Order[];
  total: number;
}

export interface ApiV2UserPatch {
  user: Partial<User>;
}

export interface ApiV2UserDirectory {
  users_by_id: Record<string, User>;
}
```

### Why this pattern works

- **The core is declared once.** Both version surfaces reference `User` and `Order`, so a field added to the domain model appears in every version at the same time — deliberately, in one reviewable change.
- **Scope names are naming namespaces.** `api_v1` + `user_response` becomes `ApiV1UserResponse`, so multiple versions coexist in one module without symbol collisions or manual prefixes.
- **Modifiers express version semantics precisely.** `partial()` captures sparse PATCH payloads without re-listing fields, `recordSet()` captures lookup maps without a bespoke interface, and `arrayed()` composes lists — resolved into idiomatic `Partial<User>`, `Record<string, User>`, and `Order[]`.
- **Modifier order is fixed**, so output is predictable: `partial` → `arrayed` → `recordSet` → `nullable`. `ref(user).partial().arrayed().nullable()` renders as `Partial<User>[] | null`.

### Caveats and performance notes

- **A version scope renames types; it does not version behavior.** All versions are emitted into the same module, and the bundler decides what ships. Splitting versions into separate entry points is an application concern.
- **There is no "omit one field" modifier.** A version that must not expose a core field needs its own object definition. Do not model field hiding with `Partial` — that communicates "sparse input", not "redacted output".
- **Shared means shared.** If one version must be frozen while the core keeps moving, it needs a pinned copy of the shape rather than a reference.
- **Scope names are part of the public contract** because they appear in exported type names. Renaming `api_v1` is a breaking change for every importer.
- Prefer a small number of large core objects over many small ones: every reference pulls the referenced type into the bundle of every consumer.

---

## Pattern 3: A Drift-Checked OpenAPI Document from webafx Controllers

**Use it when** an HTTP API is served through `blendsdk/webafx` controllers and the published specification must never disagree with the routes that are actually registered.

`OpenAPIGenerator` reads the route definitions your controllers already build, converts Express-style `:param` paths to OpenAPI `{param}` paths, reuses Zod validation schemas for request bodies and query parameters, and emits a complete OpenAPI v3.1 document. Only routes annotated with `.openapi()` metadata are included — everything else stays invisible, which is the opt-in mechanism for internal endpoints.

### Implementation

```typescript
// src/api/products.controller.ts
import type { RouteDefinition } from 'blendsdk/webafx';
import { z } from 'zod';

/** The slice of the service container this controller calls from its handlers. */
export interface ProductsService {
  listProducts(): Promise<void>;
  getProduct(): Promise<void>;
  createProduct(): Promise<void>;
}

export class ProductsController {
  constructor(
    private readonly settings: unknown,
    private readonly services: { readonly products: ProductsService },
  ) {}

  routes(): RouteDefinition[] {
    // The OpenAPI generator instantiates controllers with empty settings and
    // services, so routes() must only describe the API surface — no database
    // access, no environment reads, no side effects.
    const { products } = this.services;

    return [
      {
        method: 'get',
        path: '/',
        validation: z.object({
          page: z.coerce.number().int().min(1).default(1),
          search: z.string().optional(),
        }),
        openapi: {
          summary: 'List products',
          tags: ['products'],
          operationId: 'listProducts',
          responses: [
            { statusCode: 200, description: 'A page of products' },
            { statusCode: 401, description: 'Authentication required' },
          ],
        },
        handler: async () => {
          await products.listProducts();
        },
      },
      {
        method: 'get',
        path: '/:id',
        openapi: {
          summary: 'Get a product',
          tags: ['products'],
          operationId: 'getProduct',
          pathParams: {
            id: { description: 'Product identifier', schema: z.coerce.number().int() },
          },
          responses: [
            { statusCode: 200, description: 'A product' },
            { statusCode: 404, description: 'Not found' },
          ],
        },
        handler: async () => {
          await products.getProduct();
        },
      },
      {
        method: 'post',
        path: '/',
        secure: true,
        validation: z.object({
          name: z.string().min(1),
          price: z.coerce.number().positive(),
        }),
        openapi: {
          summary: 'Create a product',
          tags: ['products'],
          operationId: 'createProduct',
          responses: [
            { statusCode: 201, description: 'Product created' },
            { statusCode: 400, description: 'Validation error' },
          ],
        },
        handler: async () => {
          await products.createProduct();
        },
      },
    ];
  }
}
```

```typescript
// scripts/generate-openapi.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { OpenAPIGenerator } from 'blendsdk/codegen';
import { ProductsController } from '../src/api/products.controller.js';

const specPath = join(process.cwd(), 'openapi.json');

/** True when a caught error is the ENOENT of a spec that was never generated. */
function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

const generator = new OpenAPIGenerator({
  title: 'Storefront API',
  version: '2.1.0',
  description: 'Product catalog API.',
  servers: [{ url: 'https://api.example.com', description: 'Production' }],
  securitySchemes: {
    bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  },
  defaultSecurity: [{ bearerAuth: [] }],
}).addController('/api/products', ProductsController);

const spec = generator.toJSON(2);

let committed: string | undefined;
try {
  committed = await readFile(specPath, 'utf8');
} catch (error) {
  if (!isMissingFile(error)) throw error;
}

if (committed === spec) {
  console.log('openapi.json is up to date.');
} else {
  await mkdir(dirname(specPath), { recursive: true });
  await writeFile(specPath, spec, 'utf8');
  console.log('openapi.json changed - review and commit the diff.');
}
```

Excerpt of the generated document:

```json
{
  "/api/products": {
    "get": {
      "summary": "List products",
      "tags": ["products"],
      "operationId": "listProducts",
      "parameters": [
        { "name": "page", "in": "query", "schema": { "type": "integer", "minimum": 1, "default": 1 } },
        { "name": "search", "in": "query", "schema": { "type": "string" } }
      ],
      "responses": {
        "200": { "description": "A page of products" },
        "401": { "description": "Authentication required" }
      }
    },
    "post": {
      "summary": "Create a product",
      "tags": ["products"],
      "operationId": "createProduct",
      "requestBody": {
        "required": true,
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "properties": {
                "name": { "type": "string", "minLength": 1 },
                "price": { "type": "number", "minimum": 0 }
              },
              "required": ["name", "price"]
            }
          }
        }
      },
      "responses": {
        "201": { "description": "Product created" },
        "400": { "description": "Validation error" }
      },
      "security": [{ "bearerAuth": [] }]
    }
  },
  "/api/products/{id}": {
    "get": {
      "summary": "Get a product",
      "tags": ["products"],
      "operationId": "getProduct",
      "parameters": [
        { "name": "id", "in": "path", "required": true, "description": "Product identifier", "schema": { "type": "integer" } }
      ],
      "responses": {
        "200": { "description": "A product" },
        "404": { "description": "Not found" }
      }
    }
  }
}
```

### Verifying conversions in isolation

The two conversion helpers behind the generator are public, which makes it easy to check exactly what a schema will produce without running a full generation:

```typescript
import { convertZodToJsonSchema, convertZodToQueryParameters } from 'blendsdk/codegen';
import { z } from 'zod';

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  search: z.string().optional(),
});

const parameters = convertZodToQueryParameters(listQuery);
const bodySchema = convertZodToJsonSchema(
  z.object({
    name: z.string().min(1),
    price: z.coerce.number().positive(),
  }),
  'input',
);

console.log(JSON.stringify({ parameters, bodySchema }, null, 2));
```

### Why this pattern works

- **The spec is derived from the routes themselves**, not from a parallel YAML file, so the document cannot describe an endpoint that does not exist.
- **Validation is reused.** One Zod schema parses the request at runtime *and* defines the documented request body or query parameters, so validation tightening is reflected in the spec automatically.
- **Opt-in metadata keeps the contract intentional.** Internal or experimental routes simply omit `.openapi()` and never leak into the published document.
- **The drift check turns drift into a diff.** Committing `openapi.json` and comparing bytes in CI means a forgotten regeneration fails the build instead of shipping a stale contract.

### Caveats and performance notes

- **Controllers are instantiated with empty settings and services.** `routes()` must be a pure description of the API surface; reading configuration or opening a database connection there produces `undefined` at generation time.
- **Path parameters are always `{ type: 'string' }` unless you provide `pathParams` metadata** with a schema and description.
- **GET and DELETE validations become query parameters; POST, PUT, and PATCH validations become the request body.** The same schema is interpreted differently depending on the method.
- **Transformed schemas are documented by their input type.** `z.string().transform(value => value.split(','))` is documented as `{ "type": "string" }` because that is what an API consumer actually sends; the transform is a server-side concern.
- **A `secure` route with no `defaultSecurity` configured gets `security: []`** — a signal that security is required but no scheme was declared. Configure `defaultSecurity` to emit real requirements.
- **Output is deterministic.** Paths and operations follow registration order, so reordering `addController` calls produces a large but harmless diff; keep the order stable to keep reviews small.

---

## Pattern 4: Types and Query Constants from a Live Catalog

**Use it when** an existing PostgreSQL database — created by another team, an older application, or a migration tool — must get typed access code without being redefined by hand.

`PostgreSQLIntrospector` reads the catalog (tables, partitioned tables, views, materialized views, composite types, enum types) into a `SchemaContainer` that `TypeGenerator` can render. The same introspector produces the constant-type input for `CTypeGenerator`, so one pass yields both `Customer` interfaces and `eCustomer` constant objects for query building. A `ColumnMapper` is the extension point for the columns PostgreSQL's defaults cannot express.

### Implementation

```typescript
// scripts/generate-from-database.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PostgreSQLDatabase } from 'blendsdk/postgresql';
import {
  CTypeGenerator,
  PostgreSQLIntrospector,
  SchemaContainer,
  TypeGenerator,
} from 'blendsdk/codegen';
import type { ColumnMapper } from 'blendsdk/codegen';

/**
 * Owns exactly the columns the built-in mapping cannot express.
 * Returning `undefined` for everything else keeps enum bindings and the
 * standard pg -> TypeScript mapping intact.
 */
const mapper: ColumnMapper = (column, scope) => {
  if (column.relation_name === 'customer' && column.column_name === 'settings') {
    return scope.object({
      locale: scope.string(),
      marketing: scope.boolean(),
    });
  }

  switch (column.pg_type) {
    case 'interval':
    case 'bytea':
      return scope.string();
    default:
      return undefined;
  }
};

async function writeSource(outputPath: string, source: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, source, 'utf8');
}

/**
 * Emits TypeScript types and query constants for a connected database.
 * The connection is created with blendsdk/postgresql by the caller.
 */
export async function generateDatabaseAccess(
  db: PostgreSQLDatabase,
  typesPath: string,
  constantsPath: string,
): Promise<void> {
  const introspector = new PostgreSQLIntrospector(db);

  // Each call runs the catalog query once: take both artifacts from one pass.
  const constants = await introspector.introstectConstantTypes();

  const schema = new SchemaContainer();
  await introspector.introspect(schema, mapper);

  const types = await new TypeGenerator().generate(schema);
  const constantSource = await new CTypeGenerator().generate(constants);

  await Promise.all([
    writeSource(typesPath, types),
    writeSource(constantsPath, constantSource),
  ]);
}
```

Generated `types.ts` for a `customer` table with an `account_status` enum, a nullable `varchar`, a `jsonb` column, and an `interval` (abridged):

```typescript fragment
export type AccountStatus = "active" | "suspended";

export interface Customer {
  created_at: Date;
  display_name?: string | null;
  email: string;
  id: string;
  retention?: string | null;
  settings?: {
    locale: string;
    marketing: boolean;
  } | null;
  status: AccountStatus;
}
```

Generated `constants.ts`:

```typescript fragment
/**
 * Constant type for relation customer
 * @export
 * @constant
 */
export const eCustomer = {
  $TABLE: "customer",
  CREATED_AT: "created_at",
  DISPLAY_NAME: "display_name",
  EMAIL: "email",
  ID: "id",
  RETENTION: "retention",
  SETTINGS: "settings",
  STATUS: "status",
};
```

The built-in column mapping, which the `ColumnMapper` can override per column:

| Catalog source | Generated TypeScript | Notes |
| --- | --- | --- |
| `bool` | `boolean` | |
| `int2`, `int4`, `serial`, `oid`, `xid`, `cid` | `number` | |
| `int8`, `bigserial` | `string` | `pg` returns `bigint` as a string to preserve precision |
| `numeric`, `decimal` | `string` | `pg` returns `numeric` as a string to preserve precision |
| `float4`, `float8` | `number` | |
| `text`, `varchar`, `char`, `uuid`, `inet`, `tsvector`, `regclass`, `money`, `bit`, … | `string` | |
| `date`, `time`, `timetz` | `string` | `pg` returns these as strings |
| `timestamp`, `timestamptz` | `Date` | |
| user-defined enum | named union (`AccountStatus`) | built from the catalog's enum labels |
| any `is_array` column | `T[]` | the array modifier is applied *after* the mapper returns |
| `json`, `jsonb`, `xml`, `bytea`, `interval`, ranges, geometry | *unmapped* | falls back to a deprecated `any` property plus a console warning — handle these in the `ColumnMapper` |

### Why this pattern works

- **Existing databases become first-class.** No hand-written DTO per table, and no risk of a transcription error between the catalog and the TypeScript model.
- **Types and query constants come from one pass**, so `eCustomer.EMAIL` and `Customer['email']` are guaranteed to describe the same column.
- **The mapper is surgical.** Deviations are explicit, per column, and reviewable — everything else follows the catalog exactly.
- **Column names keep their database spelling** (`display_name`, not `displayName`), which makes generated access code line up with the SQL that runs.

### Caveats and performance notes

- **The mapper runs first; return `undefined` unless you intend to own the column.** A mapper that returns a schema for an enum column shadows the named enum binding, and one that returns a schema for an array column must not add `.arrayed()` itself — the introspector applies the array modifier after the mapper returns.
- **Unmapped types do not fail the run.** They become a deprecated `any` property and print a warning. Treat the warning as a to-do list: every unmapped column is a hole in the generated types.
- **Descriptions come from column comments.** Set `COMMENT ON COLUMN` in the database if the generated types should carry explanations; the introspector also attaches primary-key, unique, and default hints as JSDoc annotations.
- **Each introspector call executes the catalog query.** Call `introspect()` and `introstectConstantTypes()` once per generation run — note the exact public spelling of `introstectConstantTypes()` — and regenerate on schema change rather than at application startup.
- **Views and materialized views become interfaces too**, so regenerate after view changes or the generated types will describe the previous definition.
- **Columns typed with a PostgreSQL domain map through the domain's base type**, and the domain itself is not emitted as a named type.

---

## Pattern 5: Fresh-Database Bootstrap from the Desired-State Model

**Use it when** a disposable database — CI, a local development container, a preview environment — must match the application's model exactly, with no migration history involved.

`PostgreSQLSchemaGenerator` renders a `DatabaseSchema` into a complete bootstrap script: extensions, schemas, tables, constraints, comments, indexes, and views. The generator splits its output into groups so that indexes are created after constraints and views after both, and the views section is always generated so it can be reapplied. This script provisions new databases; existing databases are evolved by the migration pipeline, never by this script.

### Implementation

```typescript
// scripts/bootstrap-database.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const bootstrapDirectory = join(process.cwd(), 'bootstrap');

export function buildSchema(): DatabaseSchema {
  const schema = new DatabaseSchema('storefront');

  schema.extension('pgcrypto');

  const customer = schema.table('customer').comment('Customer accounts');
  customer.bigint('id').primaryKey();
  customer.text('email').unique();
  customer.text('display_name').nullable();
  customer.timestamptz('created_at').default('now()');

  const order = schema.table('customer_order');
  order.bigint('id').primaryKey();
  order.text('status').default('pending', true);
  order.bigint('customer_id').references(customer, 'id', undefined, 'CASCADE');
  order.numeric('total', 12, 2);

  order
    .index()
    .indexName('customer_order_customer_idx')
    .column('customer_id')
    .with({ fillfactor: 90 });

  schema
    .view('order_summary')
    .as('SELECT customer_id, count(*) AS order_count FROM public.customer_order GROUP BY customer_id')
    .comment('Order counts per customer');

  return schema;
}

async function writeBootstrapSql(): Promise<void> {
  const generator = new PostgreSQLSchemaGenerator(buildSchema());
  const { schema, indexes, views } = generator.generateGrouped({ dropBeforeCreate: true });

  await mkdir(bootstrapDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(bootstrapDirectory, '01-schema.sql'), schema, 'utf8'),
    writeFile(join(bootstrapDirectory, '02-indexes.sql'), indexes, 'utf8'),
    writeFile(join(bootstrapDirectory, '03-views.sql'), views, 'utf8'),
  ]);
}

await writeBootstrapSql();
```

Applying the three files in order, with failures treated as fatal:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f bootstrap/01-schema.sql \
  -f bootstrap/02-indexes.sql \
  -f bootstrap/03-views.sql
```

Excerpts of the generated groups (`01-schema.sql`, then `02-indexes.sql`, then `03-views.sql`):

```sql fragment
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE public.customer (
	id bigint NOT NULL,
	email text NOT NULL,
	display_name text,
	created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.customer
	ADD CONSTRAINT customer_id_pkey PRIMARY KEY (id),
	ADD CONSTRAINT customer_email_unique UNIQUE (email);

CREATE TABLE public.customer_order (
	id bigint NOT NULL,
	status text NOT NULL DEFAULT 'pending',
	customer_id bigint NOT NULL,
	total numeric(12,2) NOT NULL
);

ALTER TABLE public.customer_order
	ADD CONSTRAINT customer_order_customer_id_fk FOREIGN KEY (customer_id) REFERENCES public.customer (id) ON DELETE CASCADE ON UPDATE CASCADE;

COMMENT ON TABLE public.customer IS 'Customer accounts';
```

```sql fragment
CREATE INDEX customer_order_customer_idx ON public.customer_order (customer_id) WITH (fillfactor = 90);
```

```sql fragment
DROP VIEW IF EXISTS public.order_summary CASCADE;
CREATE OR REPLACE VIEW public.order_summary AS SELECT customer_id, count(*) AS order_count FROM public.customer_order GROUP BY customer_id;
COMMENT ON VIEW public.order_summary IS 'Order counts per customer';
```

### Why this pattern works

- **The model is the script.** Editing `buildSchema()` and re-running the generator replaces a hand-maintained SQL dump with a reviewable TypeScript diff.
- **Groups match the required apply order.** Schema first, then indexes (after constraints exist), then views — so bulk loads and index creation are not fighting each other.
- **The same model can feed the migration pipeline.** A `schema.ts` module that exports the `DatabaseSchema` is both the bootstrap source and the migration source of truth, so bootstrapped and migrated databases converge on the same structure.
- **Reruns are cheap and predictable** on disposable databases: `dropBeforeCreate` removes owned schemas and tables before recreating them, so a broken run never needs manual cleanup.

### Caveats and performance notes

- **`dropBeforeCreate` is destructive on purpose.** It emits `DROP SCHEMA ... CASCADE` and `DROP TABLE ... CASCADE`. Never point it at a database whose data matters; production evolution goes through generated, reviewed migrations.
- **Identifiers are rendered unquoted**, so avoid PostgreSQL reserved words in schema, table, and column names (`customer_order`, not `order`).
- **Falsy defaults do not render a `DEFAULT` clause.** When a column must default to `0` or `false`, pass the literal as a string (`column.default('0')`) and verify the generated DDL.
- **The views group always begins with `DROP ... VIEW IF EXISTS ... CASCADE`**, even when `dropBeforeCreate` is disabled, so views can be replaced without touching tables.
- **`generateGrouped()` is the granular API; `generate()` returns all groups concatenated.** Use the grouped form when a runner applies the files separately, and the concatenated form when a single script is convenient.
- Keep the generated SQL out of the repository if it is only consumed by ephemeral environments; commit it when reviewers should see the exact provisioning statements.

---

## Pattern 6: Adopting an Existing Production Database

**Use it when** a database already exists — created by hand, by another tool, or by a previous team — and you want to bring it under migration control without recreating it.

Adoption is a two-step, fail-closed procedure. `generateBaseline` creates the initial lineage offline: one immutable migration and the canonical snapshot. `adoptBaseline` then compares the live catalog with that baseline and records the initial ledger row *only* if every modeled object matches, leaving all data untouched. The same advisory lock that serializes `up` also serializes adoption, so a competing deploy cannot mutate history at the same time.

### Implementation

```typescript
// blendsdk.migrations.ts — migration configuration
import { defineMigrationConfig } from 'blendsdk/codegen';

export default defineMigrationConfig({
  schema: './schema.ts',
  migrationsDir: './migrations',
  databaseUrlEnv: 'DATABASE_URL',
});
```

```typescript
// schema.ts — the migration source of truth (the module loaded by the generator)
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('storefront');

const customer = schema.table('customer');
customer.bigint('id').primaryKey();
customer.text('email').unique().comment('Unique login address');
customer.text('display_name').nullable();
customer.timestamptz('created_at').default('now()');

const order = schema.table('customer_order');
order.bigint('id').primaryKey();
order.text('status').default('pending', true);
order.bigint('customer_id').references(customer, 'id', undefined, 'CASCADE');

export default schema;
```

```typescript
// scripts/adopt-existing-database.ts
import {
  MigrationError,
  adoptBaseline,
  formatMigrationError,
  generateBaseline,
  runMigrations,
} from 'blendsdk/codegen';

const configPath = './blendsdk.migrations.ts';

async function adopt(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL must point at the database being adopted.');
  }
  const databaseName = new URL(connectionString).pathname.slice(1);

  // 1) One-time, fully offline: create the initial migration and the canonical snapshot.
  const baseline = await generateBaseline({ name: 'initial', configPath });

  // 2) Prove the catalog matches the desired state, then record the initial lineage.
  //    The confirmation token is `<database>/<baseline-id>`; nothing is written
  //    when any modeled object is missing, different, or extra.
  const result = await adoptBaseline({
    configPath,
    confirmation: `${databaseName}/${baseline.migration.id}`,
  });

  for (const item of result.comparison) {
    if (item.classification === 'UNMANAGED') {
      console.log(`left untouched: ${item.identity}`);
    }
  }

  const status = await runMigrations({ command: 'status', configPath });
  console.log(`${result.status} ${baseline.migration.id} -> ${status.status}`);
}

try {
  await adopt();
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(formatMigrationError(error));
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}
```

The same flow is available from the command line:

| Command | Purpose |
| --- | --- |
| `blendsdk migrate baseline initial` | Creates the initial migration and canonical snapshot offline |
| `blendsdk migrate adopt-baseline` | Prints a sanitized target preview, collects the confirmation, and records the lineage |
| `blendsdk migrate status` | Reports the current lifecycle status |
| `blendsdk migrate generate add-display-name` | Diffs the model against the snapshot and publishes a new migration |
| `blendsdk migrate up` | Applies pending migrations |
| `blendsdk migrate create backfill-status` | Creates a hand-written migration for data-only work |

### Why this pattern works

- **No downtime and no recreation.** Adoption never runs the baseline DDL; it verifies structure and records metadata. Existing rows are untouched.
- **The check is structural, not textual.** Column types, nullability, keys, constraints, index definitions, and view definitions are compared; a database that only *looks* similar is rejected with a qualified, classifiable mismatch.
- **Unmanaged objects do not block adoption.** Functions and triggers that the model does not describe are reported as `UNMANAGED` and preserved, so adoption does not force you to model everything on day one.
- **The confirmation token binds the operation to one target.** Adoption is refused when the token does not match the exact database and baseline, which prevents recording a baseline against the wrong environment.

### Caveats and performance notes

- **Adoption runs once.** It requires an empty or absent ledger; a nonempty history is rejected without mutation.
- **Mismatches are fatal by design.** The error names the classification (`MISSING`, `DIFFERENT`, `EXTRA_MODELED`, `UNSUPPORTED_FOR_ADOPTION`) and the qualified object (for example `public.customer`); fix the model or the database and re-run.
- **Some shapes are unsupported for adoption**: deferrable constraints, row-level security on modeled tables, sequences that were drifted or redirected behind `serial` shorthand, index ordering the model cannot express, and non-structural raw SQL defaults. These need a manual decision rather than an automatic ledger row.
- **Local artifacts are re-verified before the ledger changes.** If the baseline file is edited after the preview, adoption aborts instead of recording a checksum that no longer matches.
- **Credentials never leak.** The database URL comes from the configured environment variable (default `DATABASE_URL`), TLS requirements are honored, and errors redact credentials and SQL bodies.
- **After adoption the daily loop is unchanged**: edit `schema.ts`, run `generate`, review and commit the SQL and snapshot, then deploy with `up`. Hand-written migrations created with `create` coexist and carry null lineage, so the next generated migration still diffs against the last modeled snapshot.

---

## Pattern 7: A Fail-Closed Deploy Gate

**Use it when** migrations ship from CI/CD and a deploy must stop — not guess — when history is invalid, when a previous run's outcome is unproven, or when another runner already holds the lock.

The runner's status values are designed to be gates. `validate` works without a database connection and catches edited, inserted, removed, or malformed local history; a dry-run `up` previews the pending order without creating the ledger or executing SQL; and a real `up` applies pending migrations while a per-database advisory lock keeps concurrent deploys from interleaving.

### Implementation

```typescript
// scripts/deploy-gate.ts
import { MigrationError, formatMigrationError, runMigrations } from 'blendsdk/codegen';
import type { MigrationStatus } from 'blendsdk/codegen';

const configPath = './blendsdk.migrations.ts';

/** Statuses that must stop a deployment instead of being retried blindly. */
const blockingStatuses: readonly MigrationStatus[] = [
  'INVALID_HISTORY',
  'UNKNOWN_OUTCOME',
  'LOCKED',
];

async function deployGate(): Promise<void> {
  // 1) Offline history check: no database connection, no SQL.
  const validation = await runMigrations({ command: 'validate', configPath });
  if (blockingStatuses.includes(validation.status)) {
    throw new Error(`Refusing to deploy: migration history is ${validation.status}.`);
  }

  // 2) Preview the pending order without touching the ledger.
  const preview = await runMigrations({ command: 'up', configPath, dryRun: true });
  for (const migration of preview.migrations) {
    const mode = migration.transactional ? 'transactional' : 'nontransactional';
    console.log(`pending ${migration.id} (${mode})`);
  }

  // 3) Apply, with cancellation wired to the deployment supervisor.
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());

  const applied = await runMigrations({
    command: 'up',
    configPath,
    signal: controller.signal,
  });
  console.log(`migrations applied: ${applied.status}`);
}

try {
  await deployGate();
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(formatMigrationError(error));
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}
```

How each status should be handled by the gate:

| Status | Reported when | Gate action |
| --- | --- | --- |
| `UP_TO_DATE` | The ledger matches local history exactly | Deploy |
| `PENDING` | History is valid and committed migrations are unapplied | Apply with `up`, or require a human approval step |
| `INVALID_HISTORY` | Local files and the ledger are not an exact prefix — edited, inserted, removed, or malformed | Stop; fix forward, never rewrite applied files |
| `LOCKED` | Another runner holds the per-database advisory lock | Retry after the other run finishes |
| `UNKNOWN_OUTCOME` | A nontransactional migration was dispatched and its outcome is unproven | Stop and inspect the durable dirty marker; never auto-repair |

### Why this pattern works

- **The gate fails closed.** Every ambiguous state blocks the deploy, and no `force`, `fake`, or `repair` command exists to bypass it — history is only ever extended.
- **Validation runs without credentials**, so the same script works in a pull request check and in the release job.
- **The dry-run preview is a review artifact.** Logging `pending <id> (transactional)` before applying turns the deploy output into an auditable record of what ran.
- **Cancellation is safe.** Aborting between migrations preserves the rows already recorded, and aborting during a transactional migration rolls it back — the next run simply continues from the same point.
- **Diagnostics are safe to ship.** `formatMigrationError` redacts credentials and SQL bodies, so failing pipelines do not leak secrets into build logs.

### Caveats and performance notes

- **Exit codes are part of the contract:** `0` for success, `1` for operational failures (`INVALID_HISTORY`, `LOCKED`, `DATABASE`, `UNKNOWN_OUTCOME`), and `2` for usage and configuration errors. `MigrationError.exitCode` carries the same value when you call the API directly.
- **`up` throws on `LOCKED` while `status` returns it.** Treat a thrown `LOCKED` as retryable and a returned `LOCKED` as informational.
- **Nontransactional migrations deserve their own review gate.** They cannot be rolled back, so a failure after dispatch leaves a durable marker that surfaces as `UNKNOWN_OUTCOME` on every subsequent run until a human resolves it.
- **The advisory lock is scoped per database**, so parallel deploys against different databases do not contend for it.
- **`runMigrations` covers every command.** When a script only needs one answer, the dedicated read-only entry points — `getMigrationStatus` for status and `validateMigrations` for the history check — return the same status values without going through a command dispatch.
- **The ledger is not the only output.** Local files and the committed snapshot are the review surface; the ledger only records what was applied, so keep both in version control and let the gate compare them.

---

## Choosing a Pattern

| If you need to… | Use | Built on |
| --- | --- | --- |
| Keep compile-time types and runtime validation in lockstep | Pattern 1 | `SchemaContainer`, `TypeGenerator`, `ZodGenerator` |
| Serve several API versions from one domain model | Pattern 2 | `scope()`, `ref()`, `partial()`, `arrayed()`, `recordSet()` |
| Publish a spec that cannot drift from the registered routes | Pattern 3 | `OpenAPIGenerator`, webafx route metadata, Zod validation |
| Type an existing database without touching it | Pattern 4 | `PostgreSQLIntrospector`, `ColumnMapper`, `CTypeGenerator` |
| Recreate the schema for CI or a fresh environment | Pattern 5 | `DatabaseSchema`, `PostgreSQLSchemaGenerator` |
| Bring an existing database under migration control | Pattern 6 | `generateBaseline`, `adoptBaseline`, `MigrationError` |
| Stop a deploy on invalid or unproven history | Pattern 7 | `runMigrations` (`validate`, `dryRun`, `up`), `MigrationStatus` |

The patterns compose. A typical repository runs patterns 1–5 in a single generate step (types, validators, spec, database types, bootstrap SQL), commits the artifacts plus the snapshot, and runs patterns 6 and 7 in the deploy step — adoption once, and the gate on every release.

---

# codegen Common Scenarios

Answers to the "How do I…?" questions that come up most often when working with `blendsdk/codegen` — from generating the first TypeScript interface to running reviewed PostgreSQL migrations. Every scenario is complete, uses strict TypeScript, and includes all of its imports.

---

## How do I generate TypeScript types from a schema?

Define the shape with `SchemaContainer` and a `SchemaScope`, then pass the container to `TypeGenerator`. Named root objects become exported declarations, and the returned source is already Prettier-formatted.

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
  .named('user');

const source = await new TypeGenerator().generate(schema);
console.log(source);
```

The example prints the exported interface for the named root object:

```typescript fragment
export interface User {
  id: number;
  name: string;
  email?: string;
}
```

---

## How do I define string and number enums?

Call `.enum([...])` on a named string or number schema, then reference it with `.ref()` wherever it is needed. Number enums render as literal unions and string enums render as quoted unions.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

const direction = scope.number().named('direction').enum([1, 2, 3]);
const status = scope.string().named('status').enum(['active', 'inactive']);

scope
  .object({
    direction: scope.ref(direction),
    status: scope.ref(status).arrayed(),
  })
  .named('filter');

const source = await new TypeGenerator().generate(schema);
console.log(source);
```

Output:

```typescript fragment
export type Direction = 1 | 2 | 3;
export type Status = "active" | "inactive";
export interface Filter {
  direction: Direction;
  status: Status[];
}
```

---

## How do I make a property optional, nullable, or an array?

Chain `.optional()`, `.nullable()`, and `.arrayed()` on any schema object before using it as a property. Modifiers compose in a fixed order — `Partial<T>` innermost, then array brackets, then the `null` union — so `.partial().arrayed().nullable()` renders as `Partial<T>[] | null`.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

scope
  .object({
    id: scope.string(),
    nickname: scope.string().optional(),
    deletedAt: scope.string().nullable(),
    tags: scope.string().arrayed(),
  })
  .named('account');

const source = await new TypeGenerator().generate(schema);
console.log(source);
```

Output:

```typescript fragment
export interface Account {
  id: string;
  nickname?: string;
  deletedAt: string | null;
  tags: string[];
}
```

---

## How do I reuse one schema across models and build map types?

Reference a named schema with `.ref()` instead of duplicating it, and apply the same modifiers you would use on any object. `.recordSet()` turns a reference or primitive into a string-keyed map, which is handy for lookups such as `Record<string, Partial<Address>>`.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

const address = scope
  .object({
    street: scope.string(),
    city: scope.string(),
  })
  .named('address');

scope
  .object({
    name: scope.string(),
    shippingAddress: scope.ref(address),
    previousAddresses: scope.ref(address).arrayed().partial(),
    addressesByLabel: scope.ref(address).partial().recordSet(),
  })
  .named('customer');

const source = await new TypeGenerator().generate(schema);
console.log(source);
```

Output:

```typescript fragment
export interface Address {
  street: string;
  city: string;
}

export interface Customer {
  name: string;
  shippingAddress: Address;
  previousAddresses: Partial<Address>[];
  addressesByLabel: Record<string, Partial<Address>>;
}
```

---

## How do I organize schemas into scopes for versioned APIs?

Create additional scopes with `schema.scope(name)`. Names inside a scope are prefixed with the Pascal-cased scope name (`api_v1` + `user_request` → `ApiV1UserRequest`), so the same shared model can appear in several API versions without collisions.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const shared = schema.scope();

const user = shared
  .object({
    username: shared.string(),
    password: shared.string(),
  })
  .named('user');

const v1 = schema.scope('api_v1');
v1.object({
  user: shared.ref(user).nullable(),
}).named('user_request');

const v2 = schema.scope('api_v2');
v2.object({
  user: shared.ref(user),
}).named('user_request');

const source = await new TypeGenerator().generate(schema);
console.log(source);
```

Output:

```typescript fragment
export interface User {
  username: string;
  password: string;
}

export interface ApiV1UserRequest {
  user: User | null;
}

export interface ApiV2UserRequest {
  user: User;
}
```

---

## How do I generate Zod validators from the same schema?

Run `ZodGenerator` over the same `SchemaContainer` you feed to `TypeGenerator`. It emits `import * as z from 'zod'` followed by one exported schema constant per named root; the constant suffix is configurable with the `zodVariablePostfix` option (default `schema`).

```typescript
import { SchemaContainer, ZodGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

scope
  .object({
    username: scope.string(),
    email: scope.string().optional(),
    deletedAt: scope.string().nullable(),
  })
  .named('user');

const source = await new ZodGenerator().generate(schema);
console.log(source);
```

Output:

```typescript fragment
import * as z from 'zod';

export const UserSchema = z.object({
  username: z.string(),
  email: z.string().optional(),
  deletedAt: z.string().nullable(),
});
```

---

## How do I generate constant types for tables and columns?

`CTypeGenerator` converts a `ConstantType` map — relation name to column names — into `e<Name>` constant objects with a `$TABLE` key and uppercased column keys. Build the map by hand, or produce it from a live database with the introspector.

```typescript
import { CTypeGenerator, type ConstantType } from 'blendsdk/codegen';

const tables: ConstantType = {
  customer: ['id', 'name', 'email'],
  invoice: ['id', 'customer_id', 'amount'],
};

const source = await new CTypeGenerator().generate(tables);
console.log(source);
```

Output:

```typescript fragment
export const eCustomer = {
  $TABLE: 'customer',
  ID: 'id',
  NAME: 'name',
  EMAIL: 'email',
};

export const eInvoice = {
  $TABLE: 'invoice',
  ID: 'id',
  CUSTOMER_ID: 'customer_id',
  AMOUNT: 'amount',
};
```

---

## How do I model a PostgreSQL database schema?

Build a `DatabaseSchema` from tables and chainable column helpers, then attach primary keys, unique, check, and foreign-key constraints, indexes, and views. Tables default to the `public` scope — call `.scope('audit')` on a table for another schema, and register extensions with `db.extension('pgcrypto')`.

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const db = new DatabaseSchema('shop');

const customers = db.table('customer');
customers.bigserial('id').primaryKey();
customers.varchar('email', 255).unique();
customers.text('name').nullable();
customers.timestamptz('created_at').default('now()');

const invoices = db.table('invoice');
invoices.bigserial('id').primaryKey();
invoices.bigint('customer_id').references(customers, 'id', 'CASCADE', 'CASCADE');
invoices.numeric('amount', 12, 2).check('amount >= 0');
invoices.index().indexName('invoice_customer_id_idx').column('customer_id');

db.view('customer_email')
  .as('SELECT id, email FROM public.customer')
  .comment('customer email lookup');

console.log(db.getTables().map(table => table.getName()));
console.log(db.getViews().map(view => view.getName()));
```

The example prints the fully scoped identities:

```text
[ 'public.customer', 'public.invoice' ]
[ 'public.customer_email' ]
```

---

## How do I generate the DDL to bootstrap a fresh database?

`PostgreSQLSchemaGenerator` renders the desired-state model as complete bootstrap DDL. `generateGrouped()` splits the output into `schema`, `indexes`, and `views` sections for review; `generate()` returns the same content as one string, and both accept `{ dropBeforeCreate: false }` to omit the DROP statements.

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const db = new DatabaseSchema('shop');

const customers = db.table('customer');
customers.bigserial('id').primaryKey();
customers.varchar('email', 255).unique();

const invoices = db.table('invoice');
invoices.bigserial('id').primaryKey();
invoices.bigint('customer_id').references(customers, 'id');
invoices.index().indexName('invoice_customer_id_idx').column('customer_id');

db.view('customer_email')
  .as('SELECT id, email FROM public.customer')
  .comment('customer email lookup');

const generator = new PostgreSQLSchemaGenerator(db);
const ddl = generator.generateGrouped();

console.log(ddl.schema);
console.log(ddl.indexes);
console.log(ddl.views);
```

The `schema` section contains tables, constraints, and comments:

```sql
DROP TABLE IF EXISTS public.customer CASCADE;
DROP TABLE IF EXISTS public.invoice CASCADE;

CREATE TABLE public.customer (
  id bigserial NOT NULL,
  email varchar(255) NOT NULL
);

CREATE TABLE public.invoice (
  id bigserial NOT NULL,
  customer_id bigint NOT NULL
);

ALTER TABLE public.customer
  ADD CONSTRAINT customer_id_pkey PRIMARY KEY (id),
  ADD CONSTRAINT customer_email_unique UNIQUE (email);

ALTER TABLE public.invoice
  ADD CONSTRAINT invoice_id_pkey PRIMARY KEY (id),
  ADD CONSTRAINT invoice_customer_id_fk FOREIGN KEY (customer_id) REFERENCES public.customer (id) ON DELETE RESTRICT ON UPDATE CASCADE;
```

The `indexes` section contains every `CREATE INDEX` statement:

```sql
CREATE INDEX invoice_customer_id_idx ON public.invoice (customer_id);
```

The `views` section contains view definitions and their comments:

```sql
DROP VIEW IF EXISTS public.customer_email CASCADE;
CREATE OR REPLACE VIEW public.customer_email AS SELECT id, email FROM public.customer;

COMMENT ON VIEW public.customer_email IS 'customer email lookup';
```

---

## How do I generate TypeScript types from an existing PostgreSQL database?

`PostgreSQLIntrospector` reads the live catalog through a `PostgreSQLDatabase` connection into a `SchemaContainer`, so the regular `TypeGenerator`/`ZodGenerator` pipeline can run over real tables, views, enums, and composite types. Pass the connection your application already owns.

```typescript
import { PostgreSQLIntrospector, SchemaContainer, TypeGenerator } from 'blendsdk/codegen';
import type { PostgreSQLDatabase } from 'blendsdk/postgresql';

export async function generateTypesFromDatabase(db: PostgreSQLDatabase): Promise<string> {
  const schema = new SchemaContainer();
  const introspector = new PostgreSQLIntrospector(db);

  await introspector.introspect(schema);

  return new TypeGenerator().generate(schema);
}
```

An optional `ColumnMapper` — `introspect(schema, (record, scope) => ...)` — can override how an individual column is mapped; return `undefined` to keep the default mapping. For table and column constants instead of types, call `introspector.introstectConstantTypes()` and pass the result to `CTypeGenerator`.

---

## How do I generate an OpenAPI 3.1 document for my webafx routes?

Create an `OpenAPIGenerator` with your API metadata and add controllers that expose `routes()`. Only route definitions carrying `.openapi()` metadata are documented; Zod validation schemas become request bodies or query parameters, `:id` path segments become `{id}`, and routes marked `secure: true` receive `defaultSecurity`.

```typescript
import { OpenAPIGenerator } from 'blendsdk/codegen';
import type { RouteDefinition } from 'blendsdk/webafx';
import { z } from 'zod';

class ProductsController {
  constructor(_settings: unknown, _services: unknown) {}

  routes(): RouteDefinition[] {
    return [
      {
        method: 'get',
        path: '/',
        handler: async () => undefined,
        validation: z.object({
          page: z.coerce.number().default(1),
          search: z.string().optional(),
        }),
        openapi: {
          summary: 'List products',
          operationId: 'listProducts',
          tags: ['products'],
          responses: [{ statusCode: 200, description: 'Paginated product list' }],
        },
      },
      {
        method: 'post',
        path: '/',
        secure: true,
        handler: async () => undefined,
        validation: z.object({
          name: z.string().min(1),
          price: z.number().min(0),
        }),
        openapi: {
          summary: 'Create a product',
          operationId: 'createProduct',
          tags: ['products'],
          responses: [
            { statusCode: 201, description: 'Product created' },
            { statusCode: 400, description: 'Validation error' },
          ],
        },
      },
    ];
  }
}

const generator = new OpenAPIGenerator({
  title: 'Shop API',
  version: '1.0.0',
  servers: [{ url: 'https://api.example.com' }],
  securitySchemes: {
    bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  },
  defaultSecurity: [{ bearerAuth: [] }],
});

generator.addController('/api/products', ProductsController);
generator.toFile('openapi.json');
```

Call `generate()` for the document object, `toJSON()` for a formatted string, or `toFile()` to write the JSON to disk. If your definitions live elsewhere, `addRoutes(basePath, definitions)` accepts the same route objects directly. The document is OpenAPI 3.1 (`draft-2020-12`).

A route can set `envelope: 'body'` to tell a generated client to return the whole response body instead of unwrapping the top-level `data` property. The generator carries that choice as the `x-blend-envelope` extension. Use `'body'` for paginated responses so the `pagination` field survives unwrapping; the default is `'data'`.

---

## How do I generate and consume a typed API client?

Annotate controller routes with `.openapi()` metadata, declare the controllers in a `blendsdk.api.ts` contract, and run the API CLI. `generate` rebuilds the OpenAPI document, writes `api.json`, then writes the client; `check` rebuilds both in memory and fails on any drift, so a committed client can never fall behind the controllers.

```typescript
import { defineApiContract } from 'blendsdk/codegen';
import { ProductsController } from './src/controllers/products.controller.js';

export default defineApiContract({
  outputDir: 'src/api-client',
  contractFile: 'api.json',
  controllers: [{ basePath: '/api/products', controller: ProductsController }],
  openapi: { title: 'Shop API', version: '1.0.0' },
  generator: { runtimeImport: 'blendsdk/api-client' },
});
```

```bash
blendsdk api generate --config blendsdk.api.ts   # write api.json, then the client
blendsdk api check    --config blendsdk.api.ts   # exit 1 on any drift
```

The generator writes `types.ts`, `client.ts`, and `index.ts`. `client.ts` exports a `createAppClient(options)` factory with one namespace per operation group; methods are named from the `operationId`, and the parameter and result types come from the contract. Generated files carry a marker and are pruned when stale; a file without the marker is never touched.

```typescript
import { createAppClient } from './api-client/index.js';

const client = createAppClient({ baseUrl: 'http://localhost:4000' });
const product = await client.products.getProduct({ id: 42 });
```

The client imports the shared runtime from `runtimeImport` (`blendsdk/api-client` by default), which provides the auth strategies and typed errors. For the runtime API and end-to-end walkthrough, see the api-client package reference.

---

## How do I convert Zod schemas into OpenAPI schemas and query parameters?

Call `convertZodToJsonSchema()` for request bodies and responses, and `convertZodToQueryParameters()` to flatten a `z.object()` schema into individual `query` parameters. Both use Zod's native `z.toJSONSchema` with the input representation, so fields wrapped in `.transform()` or `.pipe()` are described by their input type — the shape the client sends — and a comma-separated `tags` string maps to `{ "type": "string" }`, not an array.

```typescript
import { convertZodToJsonSchema, convertZodToQueryParameters } from 'blendsdk/codegen';
import { z } from 'zod';

const listQuery = z.object({
  page: z.coerce.number().default(1),
  search: z.string().optional(),
  tags: z
    .string()
    .transform(value =>
      value
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean)
    ),
});

console.log(JSON.stringify(convertZodToQueryParameters(listQuery), null, 2));

const createBody = z.object({
  name: z.string().min(1).max(120),
  price: z.number().min(0),
});

console.log(JSON.stringify(convertZodToJsonSchema(createBody, 'input'), null, 2));
```

The first call prints one parameter per object property — optional properties are not required, defaults are preserved:

```json
[
  {
    "name": "page",
    "in": "query",
    "schema": {
      "type": "number",
      "default": 1
    }
  },
  {
    "name": "search",
    "in": "query",
    "schema": {
      "type": "string"
    }
  },
  {
    "name": "tags",
    "in": "query",
    "schema": {
      "type": "string"
    },
    "required": true
  }
]
```

The second call prints the equivalent JSON Schema for the body:

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "price": {
      "type": "number",
      "minimum": 0
    }
  },
  "required": ["name", "price"]
}
```

---

## How do I create the first migration for a new project?

Point a `blendsdk.migrations.ts` config at your schema module and call `generateBaseline`. It renders the whole desired schema into one immutable `..._initial.up.sql` migration plus the canonical `schema.snapshot.json`, entirely offline — and refuses to run if any migration or snapshot already exists.

```typescript
import { generateBaseline } from 'blendsdk/codegen';

const baseline = await generateBaseline({
  name: 'initial',
  configPath: './blendsdk.migrations.ts',
});

console.log(baseline.status); // 'GENERATED'
console.log(baseline.migration.id); // '20260827090000_initial'
console.log(baseline.snapshotHash); // SHA-256 of the published snapshot bytes
```

The config file default-exports `{ schema: './schema.ts', databaseUrlEnv: 'DATABASE_URL' }`, where `schema.ts` default-exports your `DatabaseSchema`; the package also exports a `defineMigrationConfig` helper for typed authoring. The same step is available in a terminal as `blendsdk migrate baseline initial`.

---

## How do I generate a migration after changing the schema?

Edit `schema.ts`, then call `generateMigration` with the same config. It diffs the desired model against the committed snapshot, renders only the delta, and publishes the new immutable migration and the replacement snapshot as a failure-safe pair. When nothing changed it reports `UP_TO_DATE` and writes nothing.

```typescript
import { generateMigration } from 'blendsdk/codegen';

const result = await generateMigration({
  name: 'add-invoice-amount',
  configPath: './blendsdk.migrations.ts',
});

if (result.status === 'GENERATED' && result.migration) {
  console.log(`Generated ${result.migration.id}`);
  console.log(`Rendered changes: ${result.changes.length}`);
} else {
  console.log('UP_TO_DATE — schema.ts already matches the snapshot');
}
```

Review the generated SQL, commit the migration and the snapshot together, then apply it with `runMigrations` (or `blendsdk migrate up`).

---

## How do I handle a schema change the generator refuses to guess at — for example a rename?

Generation is fail-closed: ambiguous renames, destructive drops, required-column additions, type changes, and opaque view replacements raise a `MigrationError` and write nothing to disk. Author those changes as an explicit manual migration instead, then apply it with `up`.

```typescript
import { MigrationError, formatMigrationError, generateMigration } from 'blendsdk/codegen';

try {
  await generateMigration({
    name: 'rename-customer-to-account',
    configPath: './blendsdk.migrations.ts',
  });
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(formatMigrationError(error));
  } else {
    throw error;
  }
}
```

Create the manual template with `blendsdk migrate create rename-customer-to-account`, write the `ALTER TABLE ... RENAME ...` SQL yourself, review it, and apply it. Manual migrations carry no snapshot lineage, and the next generated migration still diffs against the committed snapshot.

---

## How do I apply and verify migrations?

`runMigrations` drives the whole lifecycle. `validate` checks local history offline, a dry run previews the pending order without executing SQL, and `up` applies everything behind the database-scoped advisory lock. Local files must match the applied ledger prefix by exact checksum before any SQL runs.

```typescript
import { runMigrations } from 'blendsdk/codegen';

// Validate local history offline — no database connection required.
const validation = await runMigrations({
  command: 'validate',
  configPath: './blendsdk.migrations.ts',
});
console.log(validation.status); // 'UP_TO_DATE' | 'PENDING' | 'INVALID_HISTORY'

// Preview the exact pending order without executing any SQL.
const preview = await runMigrations({
  command: 'up',
  configPath: './blendsdk.migrations.ts',
  dryRun: true,
});
console.log(preview.migrations.map(migration => migration.id));

// Apply every pending migration and promote the ledger to UP_TO_DATE.
const applied = await runMigrations({
  command: 'up',
  configPath: './blendsdk.migrations.ts',
});
console.log(applied.status); // 'UP_TO_DATE'
```

Use `command: 'status'` to classify the current state as `UP_TO_DATE`, `PENDING`, `INVALID_HISTORY`, `LOCKED`, or `UNKNOWN_OUTCOME`; `down` reverts only the latest migration and additionally requires `allowDown: true`. The dedicated `getMigrationStatus` and `validateMigrations` helpers expose status and validation programmatically, and the CLI mirrors every command: `blendsdk migrate up|status|validate|down`.

---

## How do I adopt an existing database into the migration history?

If a database was created before the migration workflow, generate the offline baseline for the desired schema and then call `adoptBaseline` with a confirmation token (`<database>/<baseline-id>`). Adoption proves the live catalog structurally matches the baseline before recording the initial history — it never executes the baseline DDL, and any mismatch throws without touching the ledger.

```typescript
import { adoptBaseline, generateBaseline } from 'blendsdk/codegen';

const baseline = await generateBaseline({
  name: 'initial',
  configPath: './blendsdk.migrations.ts',
});

const adoption = await adoptBaseline({
  configPath: './blendsdk.migrations.ts',
  confirmation: `appdb/${baseline.migration.id}`,
});

console.log(adoption.status); // 'ADOPTED'
console.log(adoption.comparison.every(item => item.classification === 'MATCH')); // true
```

The comparison classifies each modeled item as `MATCH`, `DIFFERENT`, `MISSING`, or `EXTRA_MODELED`; unsupported shapes (deferrable constraints, drifted sequences, row security) and a nonempty ledger block adoption. Unrelated functions and triggers are reported as `UNMANAGED` and preserved. The CLI exposes the same flow as `blendsdk migrate adopt-baseline`.

---

# codegen Examples Library

Every example on this page is a complete, self-contained module — imports, types, and expected output included. The examples follow the same patterns exercised by the package's own test suite, so what you see here is the behavior verified in CI. Categories run from simple to advanced: data-shape schemas and their generators, the PostgreSQL relational model, introspection, OpenAPI generation, and the migration lifecycle.

---

## Data-Shape Schemas

Define a data shape once with a `SchemaContainer` and `SchemaScope`, then generate TypeScript types, Zod validators, and constant maps from the same model.

### Generate TypeScript Types from a Data Shape

Create a schema with a few properties and render it as an exported TypeScript interface.

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

`source` is Prettier-formatted TypeScript:

```typescript fragment
export interface User {
  id: number;
  name: string;
  email?: string;
}
```

### Compose Types with References and Modifiers

Named types can be referenced from other objects and decorated with modifiers. Modifiers are applied in a fixed order: `Partial<T>` first, then array notation, then the nullable union.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

const account = scope
  .object({
    id: scope.number(),
    displayName: scope.string(),
  })
  .named('Account');

scope
  .object({
    owner: scope.ref(account).nullable(),
    members: scope.ref(account).arrayed(),
    drafts: scope.ref(account).arrayed().partial(),
  })
  .named('Team');

const source = await new TypeGenerator().generate(schema);
console.log(source);
```

Output:

```typescript fragment
export interface Account {
  id: number;
  displayName: string;
}

export interface Team {
  owner: Account | null;
  members: Account[];
  drafts: Partial<Account>[];
}
```

### Model String and Numeric Enums

Enums become literal union types in the generated TypeScript.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

const direction = scope.string().named('direction').enum(['north', 'south']);
const priority = scope.number().named('priority').enum([1, 2, 3]);

scope
  .object({
    direction: scope.ref(direction),
    priority: scope.ref(priority),
    stops: scope.ref(direction).arrayed(),
  })
  .named('Route');

const source = await new TypeGenerator().generate(schema);
console.log(source);
```

Output:

```typescript fragment
export type Direction = "north" | "south";

export type Priority = 1 | 2 | 3;

export interface Route {
  direction: Direction;
  priority: Priority;
  stops: Direction[];
}
```

### Avoid Name Collisions with Scoped Schemas

Two objects with the same name in different scopes produce differently prefixed type names — handy for versioned API payloads.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const root = schema.scope();

const user = root
  .object({
    username: root.string(),
    password: root.string(),
  })
  .named('user');

const v1 = schema.scope('api_v1');
v1.object({
  user: root.ref(user).nullable(),
}).named('user_request');

const v2 = schema.scope('api_v2');
v2.object({
  user: root.ref(user),
}).named('user_request');

const source = await new TypeGenerator().generate(schema);
console.log(source);
```

Output:

```typescript fragment
export interface User {
  username: string;
  password: string;
}

export interface ApiV1UserRequest {
  user: User | null;
}

export interface ApiV2UserRequest {
  user: User;
}
```

### Build Dictionary Types with `recordSet()`

Applying `recordSet()` to an object reference produces a `Record<string, T>` property.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

const row = scope
  .object({
    id: scope.string().optional(),
    name: scope.string(),
  })
  .named('Row');

scope
  .object({
    rows: scope.ref(row).partial().recordSet(),
  })
  .named('RowIndex');

const source = await new TypeGenerator().generate(schema);
console.log(source);
```

Output:

```typescript fragment
export interface Row {
  id?: string;
  name: string;
}

export interface RowIndex {
  rows: Record<string, Partial<Row>>;
}
```

### Generate Zod Validators from the Same Schema

`ZodGenerator` emits runtime validators that stay in sync with the generated types. The variable name is `<Name>Schema` by default; change the suffix with `new ZodGenerator({ zodVariablePostfix: 'validator' })`.

```typescript
import { SchemaContainer, ZodGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

scope
  .object({
    id: scope.number(),
    name: scope.string(),
    email: scope.string().optional(),
  })
  .named('User');

const source = await new ZodGenerator().generate(schema);
console.log(source);
```

Output:

```typescript fragment
import * as z from 'zod';

export const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string().optional(),
});
```

### Emit Table and Column Constants

`CTypeGenerator` turns a set of relation names and columns (a `ConstantType`) into `e<Name>` constants used by type-safe query code. See [Constant Types from a Live Database](#extract-constant-types-from-a-live-database) for producing this input by introspection.

```typescript
import { CTypeGenerator } from 'blendsdk/codegen';
import type { ConstantType } from 'blendsdk/codegen';

const constantTypes: ConstantType = {
  customer: ['id', 'name', 'email'],
  'inventory.item': ['id', 'sku'],
};

const source = await new CTypeGenerator().generate(constantTypes);
console.log(source);
```

Output:

```typescript fragment
/**
 * Constant type for relation customer
 * @export
 * @constant
 */
export const eCustomer = {
  $TABLE: 'customer',
  ID: 'id',
  NAME: 'name',
  EMAIL: 'email',
};

/**
 * Constant type for relation inventory.item
 * @export
 * @constant
 */
export const eInventoryItem = {
  $TABLE: 'inventory.item',
  ID: 'id',
  SKU: 'sku',
};
```

---

## PostgreSQL Relational Model

Author the desired database schema as code. `DatabaseSchema` is the single source of truth for generated DDL, snapshots, and migrations.

### Define Tables, Columns, and Constraints

The fluent table API covers the common column types, primary keys, unique constraints, and foreign keys. Table names resolve to their scope-qualified form (`public` by default).

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');

const customer = schema.table('customer');
customer.bigint('id').primaryKey();
customer.text('name').nullable().comment('Customer display name');
customer.varchar('email', 255).unique();

const orders = schema.table('orders');
orders.bigint('id').primaryKey();
orders.bigint('customer_id').references(customer, 'id');
orders.decimal('total', 10, 2);
orders.timestamptz('created_at', 6).default('now()');

console.log(schema.getTables().map(table => table.getName()));
```

Output:

```text
[ 'public.customer', 'public.orders' ]
```

Foreign keys default to `ON UPDATE CASCADE` and `ON DELETE RESTRICT`; pass the actions explicitly with `references(customer, 'id', 'CASCADE', 'SET NULL')` to change them.

### Create Indexes

Indexes support unique, partial, expression, storage-parameter, `INCLUDE`, and `CONCURRENTLY` creation options.

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');

const item = schema.table('item');
item.bigint('id').primaryKey();
item.text('sku');
item.varchar('status', 32);
item.timestamptz('created_at', 6);

item.index().indexName('item_sku_key').unique().column('sku');
item.index().indexName('item_sku_lower_idx').expression('lower(sku)');
item.index().indexName('item_active_idx').column('status').where("status <> 'retired'");
item.index().indexName('item_created_at_idx').using('brin').column('created_at').with({ fillfactor: 90 });
```

The index section rendered by `PostgreSQLSchemaGenerator`:

```sql fragment
CREATE UNIQUE INDEX item_sku_key ON public.item (sku);
CREATE INDEX item_sku_lower_idx ON public.item (lower(sku));
CREATE INDEX item_active_idx ON public.item (status) WHERE status <> 'retired';
CREATE INDEX item_created_at_idx ON public.item USING BRIN (created_at) WITH (fillfactor = 90);
```

### Define Regular and Materialized Views

Views are declared with `.as()` and optionally made materialized.

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');

const customer = schema.table('customer');
customer.bigint('id').primaryKey();
customer.text('name').nullable();
customer.boolean('active').default(true);

schema
  .view('active_customers')
  .scope('reporting')
  .comment('Customers that are currently active')
  .as('SELECT id, name FROM public.customer WHERE active');

schema
  .view('customer_rollup')
  .materialized(true)
  .comment('Materialized customer rollup')
  .as('SELECT count(*) AS total FROM public.customer');

console.log(schema.getViews().map(view => view.getName()));
```

Output:

```text
[ 'reporting.active_customers', 'public.customer_rollup' ]
```

### Use Identity and Generated Columns

`identity()` configures PostgreSQL identity columns for integer types and UUID generators for `uuid` columns (which also register the required extension). `generated()` declares stored generated columns.

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');

const user = schema.table('user');
user.uuid('id').primaryKey().identity('v4');
user.text('email').unique();
user.text('first_name');
user.text('last_name');
user.text('display_name').generated("first_name || ' ' || last_name");

const counter = schema.table('counter');
counter.integer('id').primaryKey();
counter.integer('sequence').identity('ALWAYS', {
  start: 1,
  increment: 1,
  minValue: 1,
  cache: 1,
  cycle: false,
});

console.log(schema.getExtensions());
```

Output:

```text
[ 'uuid-ossp' ]
```

For UUID columns, `identity('v4')` uses `uuid_generate_v4()` (adds `uuid-ossp`) and `identity('v7')` uses `uuid_generate_v7()` (adds `pg_uuidv7`). Without an argument it uses the built-in `gen_random_uuid()`.

### Generate Initializer DDL

`PostgreSQLSchemaGenerator` renders the whole desired schema as deterministic bootstrap SQL. `generateGrouped()` returns `schema`, `indexes`, and `views` sections plus a combined `all` string.

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');
schema.extension('pgcrypto');

const customer = schema.table('customer');
customer.bigint('id').primaryKey();
customer.text('name').nullable();
customer.index().indexName('customer_name_idx').column('name');

const generator = new PostgreSQLSchemaGenerator(schema);
const grouped = generator.generateGrouped({ dropBeforeCreate: false });

console.log(grouped.schema);
console.log(grouped.indexes);
```

`grouped.schema` contains extensions, tables, constraints, and comments:

```sql fragment
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE public.customer (
	id bigint NOT NULL,
	name text
);

ALTER TABLE public.customer
	ADD CONSTRAINT customer_id_pkey PRIMARY KEY (id);
```

`grouped.indexes` contains the index statements:

```sql fragment
CREATE INDEX customer_name_idx ON public.customer (name);
```

With the default options (`dropBeforeCreate: true`) the generator also emits `DROP` statements, and `generate()` returns the combined string — use `dropBeforeCreate: false` for reviewable, create-only SQL.

---

## PostgreSQL Introspection

Read an existing catalog into the same data-shape model so the source generators can run against a live database.

### Introspect a Database into TypeScript Types

`PostgreSQLIntrospector.introspect()` reads tables, views, materialized views, composite types, enum types, and domains. An optional `ColumnMapper` overrides the mapping for individual columns; unmappable types fall back to a deprecated `any` schema with a console warning.

```typescript
import type { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { PostgreSQLIntrospector, SchemaContainer, TypeGenerator } from 'blendsdk/codegen';
import type { ColumnIntrospection, ColumnMapper } from 'blendsdk/codegen';

export async function generateTypesFromDatabase(db: PostgreSQLDatabase): Promise<string> {
  const schema = new SchemaContainer();

  const mapper: ColumnMapper = (column: ColumnIntrospection, scope) => {
    if (column.pg_type === 'jsonb' || column.pg_type === 'json') {
      return scope.string();
    }
    return undefined;
  };

  await new PostgreSQLIntrospector(db).introspect(schema, mapper);

  return new TypeGenerator().generate(schema);
}
```

Call `generateTypesFromDatabase(db)` with a connected `PostgreSQLDatabase` instance from `blendsdk/postgresql`. For a nullable `name text` column and a `bigint` primary key, the generated output looks like this (PostgreSQL `bigint` is mapped to `string` to preserve precision):

```typescript fragment
export interface Customer {
  id: string;
  name?: string | null;
}
```

### Extract Constant Types from a Live Database

`introstectConstantTypes()` collects table, view, and materialized-view columns into a `ConstantType` ready for `CTypeGenerator`.

```typescript
import type { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { CTypeGenerator, PostgreSQLIntrospector } from 'blendsdk/codegen';

export async function generateConstantTypes(db: PostgreSQLDatabase): Promise<string> {
  const introspector = new PostgreSQLIntrospector(db);
  const constantTypes = await introspector.introstectConstantTypes();
  return new CTypeGenerator().generate(constantTypes);
}
```

The result is the same `e<Name>` constant object format shown in [Emit Table and Column Constants](#emit-table-and-column-constants), keyed by each relation in the database.

---

## OpenAPI Generation

Turn `blendsdk/webafx` routes into an OpenAPI v3.1 document. Only routes annotated with `.openapi()` metadata are included — that is the opt-in mechanism.

### Generate a Document from a Controller

The generator instantiates each controller, collects its routes, and produces the document. GET/DELETE validation schemas become query parameters.

```typescript
import { OpenAPIGenerator } from 'blendsdk/codegen';
import type { RouteDefinition } from 'blendsdk/webafx';
import { z } from 'zod';

function route(definition: Partial<RouteDefinition>): RouteDefinition {
  return {
    method: 'get',
    path: '/',
    handler: () => undefined,
    ...definition,
  } as RouteDefinition;
}

class ProductsController {
  routes(): RouteDefinition[] {
    return [
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
    ];
  }
}

const generator = new OpenAPIGenerator({
  title: 'Product API',
  version: '1.0.0',
  description: 'Product catalog API',
  servers: [{ url: 'http://localhost:3000', description: 'Local development' }],
});

generator.addController('/api/products', ProductsController);

const document = generator.generate();
console.log(Object.keys(document.paths));
generator.toFile('./openapi.json');
```

Output:

```text
[ '/api/products' ]
```

The written `openapi.json` (abridged to the single route):

```json
{
  "openapi": "3.1.0",
  "info": { "title": "Product API", "version": "1.0.0", "description": "Product catalog API" },
  "servers": [{ "url": "http://localhost:3000", "description": "Local development" }],
  "paths": {
    "/api/products": {
      "get": {
        "summary": "List products",
        "tags": ["products"],
        "operationId": "listProducts",
        "parameters": [
          { "name": "page", "in": "query", "schema": { "type": "number", "default": 1 } },
          { "name": "search", "in": "query", "schema": { "type": "string" } }
        ],
        "responses": { "200": { "description": "Paginated product list" } }
      }
    }
  }
}
```

### Path Parameters, Request Bodies, and Security

`:param` paths become `{param}`. POST/PUT/PATCH validation schemas become the request body, `pathParams` metadata enriches path parameters, and `secure: true` applies the configured `defaultSecurity`.

```typescript
import { OpenAPIGenerator } from 'blendsdk/codegen';
import type { RouteDefinition } from 'blendsdk/webafx';
import { z } from 'zod';

function route(definition: Partial<RouteDefinition>): RouteDefinition {
  return {
    method: 'get',
    path: '/',
    handler: () => undefined,
    ...definition,
  } as RouteDefinition;
}

const generator = new OpenAPIGenerator({
  title: 'Product API',
  version: '1.0.0',
  securitySchemes: {
    bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  },
  defaultSecurity: [{ bearerAuth: [] }],
});

generator.addRoutes('/api/products', [
  route({
    method: 'get',
    path: '/:id',
    secure: true,
    openapi: {
      summary: 'Get a product',
      description: 'Returns a single product by its identifier.',
      tags: ['products'],
      operationId: 'getProduct',
      pathParams: {
        id: { schema: z.coerce.number().int(), description: 'Product identifier' },
      },
      responses: [
        { statusCode: 200, description: 'The product' },
        { statusCode: 404, description: 'Product not found' },
      ],
    },
  }),
  route({
    method: 'post',
    path: '/',
    secure: true,
    validation: z.object({
      name: z.string().min(1),
      price: z.number(),
    }),
    openapi: {
      summary: 'Create a product',
      tags: ['products'],
      operationId: 'createProduct',
      responses: [{ statusCode: 201, description: 'Product created' }],
    },
  }),
]);

const document = generator.generate();

const operation = document.paths['/api/products/{id}'].get;
console.log(JSON.stringify(operation, null, 2));
console.log(JSON.stringify(document.paths['/api/products'].post?.requestBody?.content, null, 2));
```

The GET operation:

```json
{
  "summary": "Get a product",
  "description": "Returns a single product by its identifier.",
  "tags": ["products"],
  "operationId": "getProduct",
  "parameters": [
    {
      "name": "id",
      "in": "path",
      "required": true,
      "description": "Product identifier",
      "schema": { "type": "integer" }
    }
  ],
  "responses": {
    "200": { "description": "The product" },
    "404": { "description": "Product not found" }
  },
  "security": [{ "bearerAuth": [] }]
}
```

The POST request body, converted from the Zod validation schema:

```json
{
  "application/json": {
    "schema": {
      "type": "object",
      "properties": {
        "name": { "type": "string", "minLength": 1 },
        "price": { "type": "number" }
      },
      "required": ["name", "price"]
    }
  }
}
```

### Convert a Zod Schema to a JSON Schema

`convertZodToJsonSchema()` is the same converter the generator uses internally — it builds on Zod's native `z.toJSONSchema` — and is useful when producing schema fragments for other tooling. Pass `'input'` for request schemas (or `'output'` for responses).

```typescript
import { convertZodToJsonSchema } from 'blendsdk/codegen';
import { z } from 'zod';

const createUser = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  age: z.number().int().optional(),
  role: z.enum(['admin', 'user']).default('user'),
  tags: z.array(z.string()),
});

const converted = convertZodToJsonSchema(createUser, 'input');
console.log(JSON.stringify(converted, null, 2));
```

Output:

```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string", "minLength": 1 },
    "email": { "type": "string", "format": "email" },
    "age": { "type": "integer" },
    "role": { "type": "string", "enum": ["admin", "user"], "default": "user" },
    "tags": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["name", "email", "tags"]
}
```

Optional properties and properties with defaults are excluded from `required`.

### Transformed Schemas Are Documented by Their Input Type

Pipes and `.transform()` calls are documented using the **input** schema — that is what an API consumer actually sends. This matters for the common CSV-to-array pattern.

```typescript
import { convertZodToJsonSchema } from 'blendsdk/codegen';
import { z } from 'zod';

const csvTags = z
  .string()
  .transform(value => value.split(',').map(tag => tag.trim()).filter(Boolean));

console.log(JSON.stringify(convertZodToJsonSchema(csvTags, 'input')));
// {"type":"string"} — the input type, not the transformed string[]
```

### Convert an Object Schema to Query Parameters

`convertZodToQueryParameters()` converts each top-level property of a Zod object into an `in: 'query'` parameter. Optional properties and properties with defaults are not marked required.

```typescript
import { convertZodToQueryParameters } from 'blendsdk/codegen';
import { z } from 'zod';

const listQuery = z.object({
  category: z.string(),
  search: z.string().optional(),
  page: z.coerce.number().default(1),
  sort: z.enum(['asc', 'desc']).default('asc'),
});

console.log(JSON.stringify(convertZodToQueryParameters(listQuery), null, 2));
```

Output:

```json
[
  { "name": "category", "in": "query", "schema": { "type": "string" }, "required": true },
  { "name": "search", "in": "query", "schema": { "type": "string" } },
  { "name": "page", "in": "query", "schema": { "type": "number", "default": 1 } },
  { "name": "sort", "in": "query", "schema": { "type": "string", "enum": ["asc", "desc"], "default": "asc" } }
]
```

---

## Migration Lifecycle

The daily loop is: edit the schema module → `generate` → review the SQL → commit → `up`. Everything is driven by a committed canonical snapshot and a checksummed, lock-serialized runner.

### Configure the Migration Workflow

`blendsdk.migrations.ts` is discovered by searching upward from the working directory. `defineMigrationConfig` is an optional typed helper; a plain `export default { ... }` object works as well. Secrets never belong in this file — only the *name* of the environment variable that holds the connection URL.

```typescript
// blendsdk.migrations.ts
import { defineMigrationConfig } from 'blendsdk/codegen';

export default defineMigrationConfig({
  schema: './schema.ts',
  migrationsDir: './migrations',
  databaseUrlEnv: 'DATABASE_URL',
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 900_000,
});
```

```typescript
// schema.ts — the desired-state model consumed by generation
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');
// ... tables, indexes, and views
export default schema;
```

Defaults: `migrationsDir` is `<configDir>/migrations`, the snapshot lives at `<migrationsDir>/schema.snapshot.json`, `databaseUrlEnv` is `DATABASE_URL`, `lockTimeoutMs` is 5000, and `statementTimeoutMs` is 900000.

### Create a Baseline

`generateBaseline()` writes the first migration plus the canonical snapshot. It is fully offline and refuses to run when a snapshot or existing migration history is present.

```typescript
import { generateBaseline } from 'blendsdk/codegen';

const result = await generateBaseline({ name: 'initial' });

console.log(result.status); // 'GENERATED'
console.log(result.migration.id); // e.g. '20260827090000_initial'
console.log(result.snapshotHash); // SHA-256 of the canonical snapshot bytes
```

Pass `now: new Date('2026-08-27T09:00:00Z')` to pin the generated timestamp for reproducible test fixtures.

### Generate a Migration from a Schema Change

After editing the schema module, `generateMigration()` diffs the desired schema against the committed snapshot and publishes a reviewable migration. Ambiguous renames, required column additions, and unsupported transitions are blocked with guidance instead of being guessed — nothing is written when generation is blocked.

```typescript
import { generateMigration } from 'blendsdk/codegen';

const result = await generateMigration({ name: 'add-nickname' });

if (result.status === 'UP_TO_DATE') {
  console.log('No schema changes detected — nothing was written.');
} else {
  console.log('Generated a new migration and updated schema.snapshot.json.');
}
```

### Apply Pending Migrations

Previewing with `dryRun` executes nothing and does not create the ledger. A real `up` verifies every local file against the applied ledger prefix, acquires the database-scoped advisory lock, and applies pending migrations in order.

```typescript
import { runMigrations } from 'blendsdk/codegen';

// Preview — nothing is executed and the ledger is not created
const preview = await runMigrations({ command: 'up', dryRun: true });

if (preview.status === 'PENDING') {
  console.log(preview.migrations.map(migration => migration.id));
  // [ '20260827120000_add-customer-status' ]
}

// Apply all pending migrations under the advisory lock
const applied = await runMigrations({ command: 'up' });
console.log(applied.status); // 'UP_TO_DATE'
```

### Inspect Status and Validate Local History

`status` compares local files against the applied ledger and returns one of five typed discriminators. `validate` checks only the local history and does not require a database connection.

```typescript
import { runMigrations } from 'blendsdk/codegen';
import type { MigrationStatus } from 'blendsdk/codegen';

const result = await runMigrations({ command: 'status' });

const descriptions: Record<MigrationStatus, string> = {
  UP_TO_DATE: 'Every local migration is applied.',
  PENDING: 'Local migrations are waiting to be applied.',
  INVALID_HISTORY: 'Local files and the applied ledger disagree.',
  LOCKED: 'Another migration process holds the advisory lock.',
  UNKNOWN_OUTCOME: 'A nontransactional migration needs manual review.',
};

console.log(descriptions[result.status]);

const validation = await runMigrations({ command: 'validate' });
console.log(validation.status); // 'UP_TO_DATE' | 'PENDING' | 'INVALID_HISTORY'
```

### Roll Back the Latest Migration

`down` reverts exactly the latest applied migration. It requires a matching `<id>.down.sql` file and the explicit `allowDown` confirmation.

```typescript
import { runMigrations } from 'blendsdk/codegen';

// Reverts exactly the latest applied migration.
// Requires its <id>.down.sql file and the explicit allowDown confirmation.
await runMigrations({ command: 'down', allowDown: true });
```

If a nontransactional `down` fails or loses its session, a durable `NONTRANSACTIONAL_DIRTY` marker is retained and subsequent `status` calls report `UNKNOWN_OUTCOME` until the state is reviewed manually.

### Adopt an Existing Database

`adoptBaseline()` records the initial lineage of an existing database — without running the baseline DDL — only after a structural comparison proves the live catalog matches the generated baseline. The confirmation token is `<database>/<baseline-id>`.

```typescript
import { adoptBaseline } from 'blendsdk/codegen';

const result = await adoptBaseline({
  // `<database>/<baseline-id>` — the DDL-quiescence confirmation for the target
  confirmation: 'appdb/20260827090000_initial',
});

console.log(result.status); // 'ADOPTED'
console.log(result.comparison.every(item => item.classification === 'MATCH')); // true
```

Mismatches throw a `MigrationError` with kind `'UNSUPPORTED'` (qualified identities in the message) and insert no history. A nonempty ledger is rejected with `'INVALID_HISTORY'`.

### Handle Migration Failures

All migration failures are typed `MigrationError` values with a stable `kind`, an exit class, and redacted diagnostics — credentials and SQL bodies never appear in rendered output.

```typescript
import { formatMigrationError, MigrationError, runMigrations } from 'blendsdk/codegen';

try {
  await runMigrations({ command: 'up' });
} catch (error) {
  if (!(error instanceof MigrationError)) {
    throw error;
  }

  // Stable, redacted single-line diagnostic, e.g. "LOCKED: ..."
  console.error(formatMigrationError(error));

  // Typed handling without parsing text
  if (error.kind === 'LOCKED') {
    console.error('Another process is migrating; retry after it finishes.');
  }

  process.exitCode = error.exitCode; // 1 = operational failure, 2 = usage/configuration
}
```

### Drive the Lifecycle from the CLI

The assembled `blendsdk` package ships the `blendsdk migrate` executable with exactly eight lifecycle commands and no repair bypass.

```bash
# Show all lifecycle commands and the exit-code contract
blendsdk migrate --help

# New project: create the baseline migration and canonical snapshot (offline)
blendsdk migrate baseline initial

# After editing schema.ts: generate a reviewable migration from the snapshot diff
blendsdk migrate generate add-customer-status

# Create an empty manual migration (for data backfills)
blendsdk migrate create seed-customer-status

# Apply, inspect, and check
blendsdk migrate up
blendsdk migrate status
blendsdk migrate validate --offline

# Point at a non-default configuration
blendsdk migrate up --config ./services/billing/blendsdk.migrations.ts

# Roll back is guarded — inspect its required arguments first
blendsdk migrate down --help
```

Sample output:

```text
$ blendsdk migrate generate add-customer-status
GENERATED 20260828010203_add-customer-status

$ blendsdk migrate validate --offline
UP_TO_DATE
```

Exit codes:

| Exit code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Operational failure (invalid history, database error, lock contention, unknown outcome) |
| `2` | Usage or configuration error |

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
