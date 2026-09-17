> **Package**: `blendsdk/webafx`

# webafx Advanced Patterns

The patterns in this document combine multiple WebAFX features into complete, production-shaped solutions: multi-principal authentication, contract-first APIs, layered middleware pipelines, dependency-injection composition, priority-ordered plugins, SPA hosting, request-correlated logging, lifecycle automation, and isolation-first integration tests. Each pattern states the concrete problem it solves, shows a complete runnable example with its final output, and lists the caveats that matter in production.

**Conventions**

- Every `typescript` block is a complete ESM module that imports only from the package root, `express` (types), and `zod`.
- `typescript fragment` blocks are excerpts from larger files, not standalone modules.
- Response samples show the actual JSON envelopes produced by the framework's response helpers and error handler.

---

## Pattern 1: Multi-Principal Authentication in a Single API

**Use when:** one application serves more than one kind of caller — for example browser sessions for humans and API keys for machine clients — and every route must authenticate against the right kind of principal.

### Scenario

WebAFX resolves the authenticated principal from a *service* in the request container. The default service is named `'user'`, which is what no-argument `.secure()` and `this.authenticated()` resolve. When you pass a name — `.secure('client')` or `this.authenticated('client')` — the guard resolves that service instead and rejects the request with `401` if it yields no principal. A route is therefore always tied to exactly one principal type, and a credential for one type can never satisfy another.

### Complete example

```typescript
import {
  WebApplication,
  BaseController,
  UnauthorizedError,
} from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

/** Browser session principal, resolved by the default `user` service. */
interface SessionUser {
  id: number;
  email: string;
  role: 'member' | 'admin';
}

/** Machine client principal, resolved by the `client` service. */
interface ApiClient {
  clientId: string;
  scopes: string[];
}

const sessions = new Map<string, SessionUser>([
  ['sess-admin', { id: 1, email: 'admin@example.com', role: 'admin' }],
  ['sess-member', { id: 2, email: 'member@example.com', role: 'member' }],
]);

const apiClients = new Map<string, ApiClient>([
  ['key-reporting', { clientId: 'reporting-bot', scopes: ['export:read'] }],
]);

class AccountController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      // Default principal: the service named 'user'.
      this.authenticated()
        .get('/account/me')
        .handle(async (req, res) => {
          const user = req.services.getUser<SessionUser>();
          if (!user) {
            throw new UnauthorizedError('No active session for this request');
          }
          this.ok(res, { id: user.id, email: user.email });
        }),

      // Same principal, plus an authorization check.
      this.route()
        .get('/account/audit-log')
        .secure()
        .authorize((_req, user: SessionUser) => user.role === 'admin')
        .handle(async (_req, res) => {
          this.ok(res, { entries: [] });
        }),

      // Named principal: only the service named 'client' can satisfy this route.
      this.authenticated('client')
        .get('/account/export')
        .authorize((_req, client: ApiClient) => client.scopes.includes('export:read'))
        .handle(async (_req, res) => {
          this.ok(res, { export: 'ready' });
        }),
    ];
  }
}

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'production',
  TRUST_PROXY: true,
});

// Default principal service — must be named 'user'.
app.registerService({
  name: 'user',
  type: 'per-request',
  factory: (_container, _settings, req) => {
    const token = req.headers['authorization'];
    if (typeof token !== 'string' || !token.startsWith('Bearer ')) {
      return undefined;
    }
    return sessions.get(token.slice('Bearer '.length));
  },
});

// Named principal service for machine clients.
app.registerService({
  name: 'client',
  type: 'per-request',
  factory: (_container, _settings, req) => {
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string') {
      return undefined;
    }
    return apiClients.get(key);
  },
});

app.registerController('/api', AccountController);

const shutdown = await app.start();
```

Expected behavior:

```text
GET /api/account/me
Authorization: Bearer sess-member
→ 200 { "success": true, "data": { "id": 2, "email": "member@example.com" } }

GET /api/account/me                                  (no credentials)
→ 401 { "success": false, "error": { "code": "UNAUTHORIZED", "statusCode": 401, ... } }

GET /api/account/audit-log
Authorization: Bearer sess-member                    (authenticated, not an admin)
→ 403 { "success": false, "error": { "code": "FORBIDDEN", "statusCode": 403, ... } }

GET /api/account/audit-log
Authorization: Bearer sess-admin
→ 200 { "success": true, "data": { "entries": [] } }

GET /api/account/export
X-API-Key: key-reporting
→ 200 { "success": true, "data": { "export": "ready" } }

GET /api/account/export
Authorization: Bearer sess-admin                     (a session cannot satisfy the client route)
→ 401 { "success": false, "error": { "code": "UNAUTHORIZED", "statusCode": 401, ... } }
```

### Why this pattern works

- **One route, one principal.** Principal selection lives on the route definition, so authorization intent is visible exactly where reviewers look for it — no middleware stacks or path-prefix conventions to decode.
- **Fail-closed by construction.** An unresolvable or unregistered principal service produces a `401`, never a bypass. A machine credential presented to a session route (and vice versa) is simply not a principal for that route.
- **Authorization composes with authentication.** `.authorize()` runs only after a principal has been resolved and receives *that* principal, so admin checks and scope checks read naturally against concrete types.
- **The same registries work for every caller type.** Both principals are ordinary per-request services, so they resolve per request and are cached on that request's container.

### Caveats and performance notes

- The name passed to `.secure()` / `.authenticated()` must be the **principal service name** — when using an auth plugin, this is the plugin's configured `userServiceName`, not the provider singleton.
- `secure('')` or a whitespace-only name throws `secure() requires a non-empty user service name` at route-definition time; surrounding whitespace is trimmed before resolution.
- Principal services are typically `per-request`; resolving them fires one factory call per request and reuses the result.
- `getUser()` reads the default `'user'` service from the request container; for named principals use `await req.services.get<ApiClient>('client', undefined)`.
- `.authorize()` returning `false` produces `403` only because the principal was already present; an absent principal is always `401`.

---

## Pattern 2: Contract-First Routes with Validation and OpenAPI Metadata

**Use when:** public API endpoints must be validated at runtime *and* documented, and you want the two to come from a single source of truth instead of drifting schemas.

### Scenario

A product catalog API validates merged route input — path params, query string, and JSON body — with one Zod schema per route, and opts every public route into OpenAPI generation with `.openapi()`. Validation defaults and coercions (`z.coerce`) turn raw strings into typed values *before* the handler runs. Routes without `.openapi()` stay invisible, which keeps internal endpoints out of generated specifications.

### Complete example

```typescript
import {
  WebApplication,
  BaseController,
  NotFoundError,
} from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { z } from 'zod';

interface Product {
  id: number;
  name: string;
  category: string;
  price: number;
}

const products: Product[] = [
  { id: 1, name: 'Espresso Machine', category: 'kitchen', price: 249.0 },
  { id: 2, name: 'Pour-Over Kettle', category: 'kitchen', price: 89.5 },
  { id: 3, name: 'Desk Lamp', category: 'office', price: 45.0 },
];

const listProductsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  category: z.string().optional(),
});

const productParams = z.object({
  id: z.coerce.number().int().positive(),
});

class ProductController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/products')
        .openapi({
          summary: 'List products',
          tags: ['products'],
          // The handler returns paginated output, so a generated client must
          // read the whole body to keep `pagination`.
          envelope: 'body',
          responses: [
            { statusCode: 200, description: 'Paginated product list' },
          ],
        })
        .validate(listProductsQuery)
        .handle(async (req, res) => {
          const { page, limit, category } = req.services.getParams<{
            page: number;
            limit: number;
            category?: string;
          }>();

          const filtered = category
            ? products.filter(product => product.category === category)
            : products;
          const start = (page - 1) * limit;
          const pageItems = filtered.slice(start, start + limit);

          this.paginated(res, pageItems, filtered.length, page, limit);
        }),

      this.route()
        .get('/products/:id')
        .openapi({
          summary: 'Get a product by ID',
          operationId: 'getProductById',
          tags: ['products'],
          pathParams: {
            id: { schema: z.coerce.number().int().positive(), description: 'Product ID' },
          },
          responses: [
            { statusCode: 200, description: 'The product' },
            { statusCode: 404, description: 'Product not found' },
          ],
        })
        .validate(productParams)
        .handle(async (req, res) => {
          const { id } = req.services.getParams<{ id: number }>();
          const product = products.find(item => item.id === id);
          if (!product) {
            throw new NotFoundError(`Product ${id} not found`, { id });
          }
          this.ok(res, product);
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });
app.registerController('/api', ProductController);

const shutdown = await app.start();
```

Expected behavior:

```text
GET /api/products?limit=2
→ 200
{
  "success": true,
  "data": [
    { "id": 1, "name": "Espresso Machine", "category": "kitchen", "price": 249 },
    { "id": 2, "name": "Pour-Over Kettle", "category": "kitchen", "price": 89.5 }
  ],
  "pagination": { "total": 3, "page": 1, "limit": 2, "pages": 2 }
}

GET /api/products/99
→ 404
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Product 99 not found",
    "statusCode": 404,
    "details": { "id": 99 },
    "timestamp": "2025-06-01T10:00:00.000Z",
    "requestId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "path": "/api/products/99"
  }
}

GET /api/products/abc
→ 422
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation Failed",
    "statusCode": 422,
    "details": [ { "path": "id", "message": "Invalid input: expected number, received NaN" } ],
    "requestId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "path": "/api/products/abc"
  }
}
```

### Why this pattern works

- **One artifact, two consumers.** The `.validate()` schema guards the runtime; the `.openapi()` metadata describes the contract. Both hang off the same route definition, so documentation cannot silently drift from behavior.
- **Handlers never see invalid input.** Coercion and defaults run before the handler, so `page` is already a `number` and `limit` already falls back to `20` — no parsing boilerplate in business code.
- **Opt-in documentation.** Only routes with `.openapi()` appear in generated specs; internal or experimental routes stay hidden by default.
- **Paginated routes declare their envelope.** Setting `envelope: 'body'` keeps the `pagination` object for a generated client; the default `'data'` unwraps only `data`.
- **Errors are machine-readable.** `422 VALIDATION_ERROR` responses carry field-level details, and `404`s thrown as typed errors carry the same envelope for every client.

### Caveats and performance notes

- `.openapi()` is pure metadata — the actual specification is generated by `blendsdk/codegen`. WebAFX itself produces no OpenAPI files.
- The pipeline order is route middleware → `.secure()` → `.authorize()` → `.validate()` → handler. Validation failures for unauthenticated requests never leak field details because authentication runs first.
- Path params and query values arrive as strings; use `z.coerce.number()`, `z.coerce.boolean()`, and friends. JSON body values keep their native types.
- `.validate()` receives the **merged** `params + query + body` object. When the same key can appear in more than one source, use `req.services.getInput()` to keep the sources apart instead of relying on merge behavior.
- Defaults declared in the schema (`.default(1)`) are applied to the validated values — `req.services.getParams()` returns the parsed result, not the raw input.

---

## Pattern 3: Composable Middleware Pipelines with Rate Limiting

**Use when:** individual routes need their own middleware stack — throttling, auditing, instrumentation — and abuse protection must be scoped per client instead of per server.

### Scenario

A reporting API attaches three layers to one route: a per-API-key quota, an audit trail, and schema validation. Middleware declared with `.middleware()` runs first, in declaration order, so cheap rejections (quota checks) happen before authentication and validation work. Quotas are keyed by `X-API-Key` when present and fall back to the client IP — which is why `TRUST_PROXY` matters behind a load balancer.

### Complete example

```typescript
import {
  WebApplication,
  BaseController,
  rateLimitMiddleware,
} from 'blendsdk/webafx';
import type { RequestHandler } from 'express';
import type { RouteDefinition } from 'blendsdk/webafx';
import { z } from 'zod';

interface AuditEntry {
  method: string;
  path: string;
  at: string;
}

const auditTrail: AuditEntry[] = [];

/** Records every request that reaches a reporting route. */
const auditLog: RequestHandler = (req, _res, next) => {
  auditTrail.push({ method: req.method, path: req.path, at: new Date().toISOString() });
  next();
};

/** 20 report jobs per minute per API key — the counter is shared across all
 *  routes this middleware instance is attached to. */
const reportRateLimit = rateLimitMiddleware({
  maxRequests: 20,
  windowMs: 60_000,
  keyExtractor: req => {
    const apiKey = req.headers['x-api-key'];
    return typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : req.ip ?? 'unknown';
  },
  message: 'Report quota exceeded',
});

/** 10 searches per minute per client address — a separate, independent quota. */
const searchRateLimit = rateLimitMiddleware({
  maxRequests: 10,
  windowMs: 60_000,
  message: 'Search quota exceeded',
});

const reportSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  format: z.enum(['csv', 'json']),
});

let reportCounter = 0;

class ReportingController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .post('/reports')
        .middleware(reportRateLimit)
        .middleware(auditLog)
        .validate(reportSchema)
        .handle(async (req, res) => {
          const { from, to, format } = req.services.getParams<{
            from: string;
            to: string;
            format: 'csv' | 'json';
          }>();
          reportCounter += 1;
          this.created(res, {
            id: `report-${reportCounter}`,
            range: { from, to },
            format,
          });
        }),

      this.route()
        .get('/search')
        .middleware(searchRateLimit)
        .handle(async (req, res) => {
          const input = req.services.getInput<{ query: { q?: string } }>();
          this.ok(res, { query: input.query.q ?? '', results: [] });
        }),
    ];
  }
}

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'production',
  TRUST_PROXY: true,
});
app.registerController('/api', ReportingController);

const shutdown = await app.start();
```

Expected behavior:

```text
POST /api/reports        X-API-Key: key-reporting
{ "from": "2025-06-01", "to": "2025-06-30", "format": "csv" }
→ 201 { "success": true, "data": { "id": "report-1", "range": { ... }, "format": "csv" } }
   headers: X-RateLimit-Limit: 20, X-RateLimit-Remaining: 19, X-RateLimit-Reset: 1748764920

POST /api/reports        (21st request for the same API key within one minute)
→ 429
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Report quota exceeded",
    "statusCode": 429,
    "timestamp": "2025-06-01T10:00:00.000Z",
    "requestId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "path": "/api/reports"
  }
}
   headers: X-RateLimit-Remaining: 0
```

### Why this pattern works

- **Deterministic composition.** `.middleware()` entries execute in declaration order before `.secure()`, `.authorize()`, `.validate()`, and the handler — the cheap quota check runs first, so over-quota traffic never touches auth or parsing.
- **Quotas per client, not per server.** `keyExtractor` turns any request attribute into the counter key: API key, session ID, tenant header. The default is the caller's IP.
- **Reusable quota objects.** One `rateLimitMiddleware()` call creates one counter store. Share the instance across routes to pool a quota; create separate instances for independent budgets.
- **Built-in client feedback.** Every limited response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` (Unix seconds), and over-limit requests throw `RateLimitError`, so `429` responses use the same envelope as every other error.
- **Auditing is just middleware.** The audit trail is a plain `RequestHandler`; it can short-circuit (respond without calling `next()`), pass errors via `next(error)`, or run after others.

### Caveats and performance notes

- The limiter is **in-memory** — counters live in one process. Multi-instance deployments need a shared store; the package expects a Redis-backed implementation delivered as a plugin.
- Behind a proxy, set `TRUST_PROXY: true` or every request shares the proxy's IP as the counter key.
- Fixed-window semantics: the window starts with the first request per key, resets after `windowMs`, and is not a sliding window — bursts at window boundaries can briefly exceed the average rate.
- The internal cleanup timer is `unref()`'d, so the limiter never keeps the process alive on its own.
- `keyExtractor` must return a non-empty string; keep it allocation-light because it runs on every request.

---

## Pattern 4: Composing Singletons and Per-Request Services with Dependency Injection

**Use when:** shared resources (stores, pools, caches) must be created once, request-scoped values must be derived from those resources, and everything must be released cleanly on shutdown — without module-level singletons.

### Scenario

A profile API layers three registrations: a `userStore` singleton with a `dispose` hook, a `userService` singleton that declares `dependencies: ['userStore']`, and a `caller` per-request service built on `userService` plus the incoming request headers. The container resolves declared dependencies before a factory runs, detects cycles with a readable chain, and rejects duplicate registrations. Service names are centralized in one `as const` map (the modern replacement for the deprecated `preparseServiceNames` helper).

### Complete example

```typescript
import {
  WebApplication,
  BaseController,
  NotFoundError,
  UnauthorizedError,
} from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

interface User {
  id: number;
  email: string;
  displayName: string;
}

class UserStore {
  private readonly users = new Map<number, User>([
    [1, { id: 1, email: 'ada@example.com', displayName: 'Ada' }],
    [2, { id: 2, email: 'linus@example.com', displayName: 'Linus' }],
  ]);

  async findById(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }

  async close(): Promise<void> {
    this.users.clear();
  }
}

interface UserService {
  getProfile(id: number): Promise<User>;
}

const ServiceNames = {
  USER_STORE: 'userStore',
  USER_SERVICE: 'userService',
  CALLER: 'caller',
} as const;

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

// Singleton store; dispose() releases it during application shutdown.
app.registerService({
  name: ServiceNames.USER_STORE,
  type: 'singleton',
  factory: () => new UserStore(),
  dispose: async (store: UserStore) => {
    await store.close();
  },
});

// Singleton service with a declared dependency: userStore resolves first.
app.registerService({
  name: ServiceNames.USER_SERVICE,
  type: 'singleton',
  dependencies: [ServiceNames.USER_STORE],
  factory: async container => {
    const store = await container.get<UserStore>(ServiceNames.USER_STORE);
    return {
      async getProfile(id: number): Promise<User> {
        const user = await store.findById(id);
        if (!user) {
          throw new NotFoundError(`User ${id} not found`, { userId: id });
        }
        return user;
      },
    } satisfies UserService;
  },
});

// Per-request service built on the singleton — resolved once per request
// and cached on that request's container.
app.registerService({
  name: ServiceNames.CALLER,
  type: 'per-request',
  dependencies: [ServiceNames.USER_SERVICE],
  factory: async (container, _settings, req) => {
    const userService = await container.get<UserService>(ServiceNames.USER_SERVICE);
    const header = req.headers['x-user-id'];
    if (typeof header !== 'string') {
      return undefined;
    }
    const id = Number(header);
    return Number.isInteger(id) ? userService.getProfile(id) : undefined;
  },
});

class ProfileController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/profiles/:id')
        .handle(async (req, res) => {
          const input = req.services.getInput<{ params: { id: string } }>();
          const userService = await req.services.get<UserService>(ServiceNames.USER_SERVICE);
          const profile = await userService.getProfile(Number(input.params.id));
          this.ok(res, profile);
        }),

      this.route()
        .get('/whoami')
        .handle(async (req, res) => {
          const caller = await req.services.get<User | undefined>(ServiceNames.CALLER);
          if (!caller) {
            throw new UnauthorizedError('Provide an X-User-ID header');
          }
          this.ok(res, caller);
        }),
    ];
  }
}

app.registerController('/api', ProfileController);

const shutdown = await app.start();
```

Expected behavior:

```text
GET /api/profiles/1
→ 200 { "success": true, "data": { "id": 1, "email": "ada@example.com", "displayName": "Ada" } }

GET /api/profiles/9
→ 404 { "success": false, "error": { "code": "NOT_FOUND", "message": "User 9 not found", "details": { "userId": 9 }, ... } }

GET /api/whoami           X-User-ID: 2
→ 200 { "success": true, "data": { "id": 2, "email": "linus@example.com", "displayName": "Linus" } }

GET /api/whoami           (no X-User-ID header)
→ 401 { "success": false, "error": { "code": "UNAUTHORIZED", "message": "Provide an X-User-ID header", ... } }
```

### Why this pattern works

- **Declared dependencies, automatic ordering.** `dependencies: ['userStore']` tells the container what to resolve first — factories receive a container whose dependencies are already available, so no hand-written init order exists to break.
- **The right lifecycle per resource.** Connection pools, caches, and stores are singletons; caller identity and request-derived state are per-request. The container enforces the boundary: touching a per-request service outside a request throws a descriptive error.
- **Central cleanup.** Singletons with a `dispose` hook are released during shutdown — the correct home for `close()`, `flush()`, and cache invalidation logic.
- **Isolation by default.** Each `WebApplication` owns its registry, so two applications (or two tests) never share instances. This also makes BlendSDK packages — database, cache, email, i18n — registrable as ordinary injectable services.
- **Typed resolution.** `get<T>()` makes every consumer explicit about what it expects, and a centralized `ServiceNames` map keeps names typo-proof.

### Caveats and performance notes

- `get()` is always asynchronous — `await` even for synchronous factories.
- A missing service throws `Service "name" is not registered`; pass a second argument to `get()` to receive a default instead.
- Circular dependencies fail fast with the full resolution chain, e.g. `Circular dependency detected: a -> b -> c -> a`.
- Per-request services throw `Service "name" is per-request and can only be accessed during HTTP request handling` when resolved outside a request (for example, in a `beforeStart` hook).
- Duplicate registrations are rejected with `Service "name" is already registered`; to intentionally replace a resolved instance inside a request, use `req.services.set(name, instance)`.
- Dispose hooks only run for singletons that were actually resolved during the application's lifetime.

---

## Pattern 5: Priority-Ordered Plugins with Health Checks and Ordered Teardown

**Use when:** cross-cutting capabilities — database pools, metrics, audit, feature modules — should be packaged as self-contained units with predictable ordering, health reporting, and shutdown behavior.

### Scenario

Two plugins form the operational layer of an application. The `db` plugin (priority `10`) registers a `dbPool` singleton and exposes the pool's health. The `metrics` plugin (priority `50`) counts requests and flushes metrics on shutdown. Even though the metrics plugin is registered first in code, the db plugin installs first — middleware ordering follows priorities, not source order. The built-in `/health` endpoint aggregates every plugin's health check, and shutdown hooks run in installation order.

### Complete example

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { PluginDefinition, RouteDefinition } from 'blendsdk/webafx';

interface DbPool {
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

function createDbPool(): DbPool {
  let open = true;
  return {
    async ping(): Promise<boolean> {
      return open;
    },
    async close(): Promise<void> {
      open = false;
    },
  };
}

const dbPlugin: PluginDefinition = {
  name: 'db',
  priority: 10,
  factory: async ({ app, logger }) => {
    const pool = createDbPool();

    app.registerService({
      name: 'dbPool',
      type: 'singleton',
      factory: () => pool,
    });

    await logger.info('Database pool registered');

    return {
      health: async () => pool.ping(),
      shutdown: async () => {
        await pool.close();
      },
    };
  },
};

interface RequestMetrics {
  total: number;
  serverErrors: number;
}

/** Stands in for an external metrics backend. */
const metricsSink: RequestMetrics[] = [];

const metricsPlugin: PluginDefinition = {
  name: 'metrics',
  priority: 50,
  factory: async ({ express, logger }) => {
    const metrics: RequestMetrics = { total: 0, serverErrors: 0 };

    express.use((_req, res, next) => {
      metrics.total += 1;
      res.on('finish', () => {
        if (res.statusCode >= 500) {
          metrics.serverErrors += 1;
        }
      });
      next();
    });

    await logger.info('Request metrics enabled');

    return {
      health: async () => metrics.serverErrors < 100,
      shutdown: async () => {
        metricsSink.push({ ...metrics });
      },
    };
  },
};

class StatusController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/api/status')
        .handle(async (req, res) => {
          const pool = await req.services.get<DbPool>('dbPool');
          this.ok(res, { database: (await pool.ping()) ? 'up' : 'down' });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

// Registered metrics first, but installed db (10) → metrics (50).
app.use(metricsPlugin);
app.use(dbPlugin);

app.registerController('', StatusController);

const shutdown = await app.start();
```

Expected behavior:

```text
Installation order: db (priority 10) → metrics (priority 50) → controllers → terminals

GET /api/status
→ 200 { "success": true, "data": { "database": "up" } }

GET /health
→ 200 { "health": true, "timestamp": "2025-06-01T10:00:00.000Z" }
```

Suggested priority conventions:

| Convention | Meaning |
|---|---|
| Priority `< 50` | Runs first — infrastructure and early guards (the `staticFilesPlugin` default is `20`) |
| Priority `50`–`99` | Ordered features — metrics, audit, domain middleware |
| Priority `100` (default) | No specific ordering requirement |
| `terminal` hook | Always mounted after controllers and `/health`, before the `404` handler |

### Why this pattern works

- **Ordering is explicit, not incidental.** Lower priority installs first, so middleware layers and shutdown order are determined by declared numbers instead of the accident of import order. Equal priorities keep registration order.
- **Plugins are operational units.** A plugin can register services, mount middleware, expose a `health` check that feeds `GET /health`, and clean up in `shutdown` — one file owns the whole lifecycle of a capability.
- **Factories receive the app.** `factory({ app, express, logger })` lets plugins register services and controllers (`app.registerService`, `app.registerController`), so a plugin can ship both its infrastructure and its endpoints.
- **Health is aggregate and free.** `/health` returns `true` only when every registered health check passes; plugins without checks don't affect the result.
- **Teardown is ordered.** Shutdown hooks run in installation order, so dependents release before the resources they rely on.

### Caveats and performance notes

- Plugin names are unique: registering the same name twice throws `Plugin "name" is already registered` — including `staticFilesPlugin` instances that share a prefix.
- A throwing plugin factory rejects `app.start()`; nothing listens afterward, which makes failures obvious in deployment logs.
- Health checks run on every `/health` request; keep them cheap (use the plugin's in-memory state rather than hitting a database unless that is the intended semantics).
- The `logger` passed to a factory is scoped (`Plugin:<name>`), so plugin log lines are attributable out of the box.
- Terminal hooks run in the same priority order (lower first) and exist specifically for catch-all middleware that must not shadow controllers — see Pattern 6.

---

## Pattern 6: Serving an SPA and Its API from One Process

**Use when:** a React/Vue/Angular build and its JSON API should live on one origin — no CORS in production, one deployable, one health endpoint — while client-side routes (`/about`, `/settings/profile`) resolve to `index.html`.

### Scenario

`staticFilesPlugin()` wraps Express's static middleware with a typed config. The static serving mounts with the plugin (before controllers, so assets are found fast), while the **SPA fallback** is registered as a plugin *terminal*: it runs after controllers and `/health`, before the `404` handler. That placement is the whole point — a fallback mounted earlier would swallow `GET /api/...` and `GET /health` for any HTML-accepting client. The fallback itself is guarded: only `GET` requests, only when `Accept` includes `text/html`, and only when the last path segment has no file extension.

### The naive approach (before)

```typescript
// typescript fragment
// BEFORE — a catch-all mounted in a plugin factory runs BEFORE controllers,
// so every unmatched request (including /api/* and /health) renders index.html.
app.use({
  name: 'spa-fallback',
  priority: 20,
  factory: async ({ express }) => {
    express.use((_req, res) => {
      res.sendFile(path.resolve('client/dist/index.html'));
    });
  },
});
```

### The terminal-phase approach (after)

```typescript
import {
  WebApplication,
  BaseController,
  NotFoundError,
  staticFilesPlugin,
} from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

interface Doc {
  slug: string;
  title: string;
}

const docs: Doc[] = [
  { slug: 'getting-started', title: 'Getting Started' },
  { slug: 'deployment', title: 'Deployment' },
];

class DocsApiController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/docs/:slug')
        .handle(async (req, res) => {
          const doc = docs.find(item => item.slug === req.params.slug);
          if (!doc) {
            throw new NotFoundError(`Unknown doc: ${req.params.slug}`);
          }
          this.ok(res, doc);
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

app.registerController('/api', DocsApiController);

// Fingerprinted build assets: long-lived, immutable caching.
// Register this plugin first so it wins for /assets/* requests.
app.use(staticFilesPlugin({
  root: './client/dist/assets',
  prefix: '/assets',
  maxAge: '1y',
  immutable: true,
}));

// SPA hosting: serves files from ./client/dist and falls back to index.html
// via the terminal phase — after controllers and /health.
app.use(staticFilesPlugin({
  root: './client/dist',
  spa: true,
}));

const shutdown = await app.start();
```

Request routing in this setup:

| Request | Result |
|---|---|
| `GET /api/docs/deployment` | Controller — `{ "success": true, "data": { ... } }` |
| `GET /api/unknown` (`Accept: application/json`) | JSON `404` envelope — never `index.html` |
| `GET /assets/main.abc123.js` | Static file — `Cache-Control: max-age=31536000, immutable` |
| `GET /docs/getting-started` (`Accept: text/html`) | SPA fallback → `index.html` (terminal phase) |
| `GET /missing.css` | `404` — a file request never triggers the fallback |
| `GET /health` | Aggregated plugin health JSON |

### Configuration reference

| Option | Type | Default | Purpose |
|---|---|---|---|
| `root` | `string` | *(required)* | Directory served; resolved from `process.cwd()` and validated at startup |
| `prefix` | `string` | `'/'` | URL mount point (`'/assets'`, `'/static'`) |
| `maxAge` | `string \| number` | `0` | `Cache-Control` max-age (`'1d'`, `'1y'`, milliseconds) |
| `immutable` | `boolean` | `false` | Adds `immutable` — use only for hashed filenames |
| `dotfiles` | `'ignore' \| 'allow' \| 'deny'` | `'ignore'` | Dotfile handling (`404`, serve, `403`) |
| `index` | `string \| false` | `'index.html'` | Directory index file |
| `etag` | `boolean` | `true` | ETag generation |
| `lastModified` | `boolean` | `true` | `Last-Modified` header |
| `spa` | `boolean` | `false` | Registers the `index.html` fallback in the terminal phase |
| `priority` | `number` | `20` | Plugin install priority |

### Why this pattern works

- **The terminal phase resolves the classic conflict.** The SPA fallback can neither shadow controller routes nor be forgotten behind them — the framework mounts it at exactly one point: after routes, before `404`.
- **Route-aware fallback guards.** JSON clients still receive JSON errors; only HTML navigations fall back. Tools that request `/missing.css` get a real `404` instead of a mysterious HTML page.
- **Per-file-class caching.** Hashed assets get `immutable` long-lived caching; other files can use conservative values. A missing `root` aborts startup with the resolved path in the message, so typos fail the deploy instead of silently serving nothing.
- **Everything is one origin.** The SPA calls `/api` with relative URLs; no CORS configuration, no second deployment, one `/health` for the orchestrator.

### Caveats and performance notes

- The SPA fallback is skipped for non-`GET` requests, for requests whose `Accept` header does not include `text/html`, and for paths whose last segment contains a file extension.
- `immutable: true` should accompany fingerprinted filenames only; renaming a non-hashed file will not invalidate clients that cached it.
- Two `staticFilesPlugin` instances must use distinct prefixes — the plugin name is derived from the prefix, and duplicates throw at registration.
- Instances share the default priority `20`, so the registration order (assets plugin before SPA plugin) is preserved; assign explicit priorities if the ordering must not rely on source order.
- Root directories are validated once at install time — the check does not repeat per request, so directory contents can change freely at runtime.

---

## Pattern 7: Request-Correlated Structured Logging Across the Async Stack

**Use when:** production logs must be JSON, machine-aggregated, and correlated to requests — without threading a `requestId` parameter through every service and helper.

### Scenario

WebAFX assigns every request a UUID (reusing a valid `X-Request-ID` header when present) and stores it in `AsyncLocalStorage`, which follows the async call chain. A single `StructuredLogger` is given a *context function* that reads `getRequestId()` on every log call. The result: a service invoked three layers deep inside a request automatically stamps its log lines with the correct request ID, and the framework's own logs use the same logger once `app.setLogger()` is called.

### Complete example

```typescript
import {
  WebApplication,
  BaseController,
  StructuredLogger,
  getRequestId,
} from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

// One logger for the whole application. The context function runs on every
// log call and injects the current request ID from AsyncLocalStorage — even
// when the call comes from deep inside a service that never saw the request.
const logger = new StructuredLogger('api', 'INFO', () => {
  const requestId = getRequestId();
  return requestId ? { requestId } : {};
});

interface Invoice {
  id: string;
  amountCents: number;
}

class InvoiceService {
  async send(invoice: Invoice): Promise<void> {
    await logger.info('Sending invoice', {
      invoiceId: invoice.id,
      amountCents: invoice.amountCents,
    });
  }
}

class InvoiceController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .post('/invoices/:id/send')
        .handle(async (req, res) => {
          const input = req.services.getInput<{ params: { id: string } }>();
          const invoices = await req.services.get<InvoiceService>('invoiceService');
          await invoices.send({ id: input.params.id, amountCents: 4200 });
          this.ok(res, { sent: true });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

app.setLogger(logger);

app.registerService({
  name: 'invoiceService',
  type: 'singleton',
  factory: () => new InvoiceService(),
});

app.registerController('/api', InvoiceController);

const shutdown = await app.start();
```

Expected log line for `POST /api/invoices/INV-42/send`:

```json
{"timestamp":"2025-06-01T10:00:00.000Z","level":"INFO","message":"Sending invoice","prefix":"api","data":{"invoiceId":"INV-42","amountCents":4200},"requestId":"6ba7b810-9dad-11d1-80b4-00c04fd430c8"}
```

Additional per-request context can be attached once and is then available to every later log line:

```typescript
// typescript fragment
import { getRequestContext } from 'blendsdk/webafx';

const context = getRequestContext();
if (context) {
  context.tenantId = 'acme';
}
```

### Why this pattern works

- **Correlation without plumbing.** The request ID reaches every log line through `AsyncLocalStorage`, so no function signature carries a `requestId` just to make logs joinable.
- **Structured by default.** Each entry is one JSON object with `timestamp`, `level`, `message`, optional `prefix`, optional `data`, and any context fields flattened at the top level — ready for aggregators.
- **Framework logs included.** `app.setLogger()` replaces the application's logger, so startup, plugin, and shutdown messages flow through the same pipeline. This is also the integration point for logger plugins such as `webafx-pino`.
- **Levels stay operator-friendly.** Constructor log levels override `LOG_LEVEL`; `DEBUG=true` can force debug output independently, and `INFO` is a sensible production baseline.

### Caveats and performance notes

- `getRequestId()` returns `undefined` outside a request — the context function returns `{}` and background jobs log without a request ID, which is correct behavior.
- The context function executes for **every** log call; keep it cheap (reading `AsyncLocalStorage` is fast, but avoid allocations beyond the returned object).
- Context follows the async chain — including timers scheduled inside a request — but does not cross worker threads or detached process boundaries.
- `getRequestContext()` also exposes `startTime`, which supports elapsed-time fields, and accepts custom properties (tenant, user, feature flags) added during the request.
- `ERROR`-level entries are routed to `console.error`, everything else to `console.log`; container log collectors typically treat those streams differently.

---

## Pattern 8: Deterministic Boot and Graceful Shutdown Orchestration

**Use when:** deployments must fail fast on misconfiguration, warm up after the listener is ready, and drain in-flight requests on `SIGTERM` without dropping work or leaking resources.

### Scenario

Lifecycle hooks run at four fixed points — `beforeStart`, `afterStart`, `beforeShutdown`, `afterShutdown` — in registration order, with async hooks awaited. `SIGTERM` and `SIGINT` are wired to the same shutdown path that `shutdown()` uses, and `SHUTDOWN_TIMEOUT` bounds connection draining. This replaces hand-rolled signal handlers whose cleanup races against in-flight requests.

### The hand-rolled approach (before)

```typescript
// typescript fragment
// BEFORE — shutdown wired by hand; ordering and draining are on you.
process.on('SIGTERM', () => {
  server.close();
  database.close();
  process.exit(0);
});
```

### The managed lifecycle (after)

```typescript
import { WebApplication, ConsoleLogger } from 'blendsdk/webafx';

const bootstrapLogger = new ConsoleLogger('bootstrap', 'INFO');

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'production',
  SHUTDOWN_TIMEOUT: 30,
});

app
  .on('beforeStart', async () => {
    const databaseUrl = app.getSettings().get<string>('DATABASE_URL');
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required to start the application');
    }
    await bootstrapLogger.info('Configuration verified');
  })
  .on('afterStart', async () => {
    await bootstrapLogger.info('Server listening — warm-up checks can run now');
  })
  .on('beforeShutdown', async () => {
    await bootstrapLogger.info('Draining in-flight requests');
  })
  .on('afterShutdown', async () => {
    await bootstrapLogger.info('Shutdown complete — all resources released');
  });

const shutdown = await app.start();

// SIGTERM and SIGINT are already wired to the same shutdown path; the returned
// function exists for programmatic use (tests, CLI tools, custom admin hooks).
```

Full lifecycle ordering:

| Phase | What runs | Trigger |
|---|---|---|
| Boot 1 | `beforeStart` hooks (registration order, awaited) | `app.start()` |
| Boot 2 | Plugin factories (priority order) | `app.start()` |
| Boot 3 | Server begins listening; `afterStart` hooks | `app.start()` |
| Runtime | Requests served; `GET /health` | — |
| Stop 1 | `beforeShutdown` hooks | `SIGTERM` / `SIGINT` / `shutdown()` |
| Stop 2 | Plugin `shutdown` hooks (installation order) | same |
| Stop 3 | Singleton `dispose` hooks | same |
| Stop 4 | `afterShutdown` hooks; signal listeners removed | same |

### Why this pattern works

- **Fail fast, fail clean.** A throwing `beforeStart` hook rejects `app.start()` before the server listens — nothing serves traffic with a missing `DATABASE_URL`, and the deploy rolls back on a clear error.
- **Warm-up has a defined moment.** `afterStart` runs when the listener is ready, which is the correct trigger for cache warm-up, readiness notifications, or registering with service discovery.
- **Teardown has ordering guarantees.** Plugins shut down before singletons are disposed, and `afterShutdown` runs last — buffers flush before connections close, never the other way around.
- **The process behaves well under orchestration.** `SHUTDOWN_TIMEOUT` bounds the drain (seconds, `0`–`300`), signal handlers are removed after shutdown, and `shutdown()` is idempotent — safe for tests, restarts, and double signals.

### Caveats and performance notes

- Hooks do not retry: a failing `beforeStart` aborts boot; design validation hooks to be deterministic.
- Keep `SHUTDOWN_TIMEOUT` below the orchestrator's kill grace period (for Kubernetes, comfortably under `terminationGracePeriodSeconds`) so the process exits before being `SIGKILL`ed.
- Multiple hooks per event are supported and run in registration order; `app.on()` returns the application for chaining.
- Calling `start()` twice on the same instance rejects with `Application already started`; construct a new `WebApplication` for a fresh lifecycle.
- `beforeShutdown` runs before in-flight requests are drained — use it for signaling, not for work that must wait for requests to finish (plugins' `shutdown` hooks and `dispose` run after the drain begins).

---

## Pattern 9: Isolation-First Integration Testing

**Use when:** you need fast, parallel-safe integration tests that exercise the full stack — routing, validation, services, error envelopes — without shared global state between test cases.

### Scenario

WebAFX owns every registry per `WebApplication` instance, so each test builds its own application, starts it on an ephemeral port (`PORT: 0`), and drives it through the public `app.express` getter with supertest. A shared `shutdown` variable in `afterEach` guarantees the server, signal handlers, and singletons are released even when assertions fail. Service factories seeded per test replace what would otherwise be shared fixtures.

### Complete example

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { z } from 'zod';

interface Order {
  id: number;
  sku: string;
  quantity: number;
}

interface OrderInput {
  sku: string;
  quantity: number;
}

const orderSchema = z.object({
  sku: z.string().min(1),
  quantity: z.number().int().min(1).max(100),
});

class OrdersController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .post('/orders')
        .validate(orderSchema)
        .handle(async (req, res) => {
          const { sku, quantity } = req.services.getParams<OrderInput>();
          const store = await req.services.get<Map<number, Order>>('orders');
          const id = store.size + 1;
          const order: Order = { id, sku, quantity };
          store.set(id, order);
          this.created(res, order);
        }),

      this.route()
        .get('/orders')
        .handle(async (req, res) => {
          const store = await req.services.get<Map<number, Order>>('orders');
          this.ok(res, [...store.values()]);
        }),
    ];
  }
}

function createTestApp(seed?: Map<number, Order>): WebApplication {
  const app = new WebApplication({
    PORT: 0,
    ENV_MODE: 'test',
    LOG_LEVEL: 'ERROR',
    CORS: false,
  });

  app.registerService({
    name: 'orders',
    type: 'singleton',
    factory: () => (seed ? new Map(seed) : new Map<number, Order>()),
  });

  app.registerController('/api', OrdersController);
  return app;
}

describe('Orders API', () => {
  let app: WebApplication;
  let shutdown: (() => Promise<void>) | undefined;

  beforeEach(() => {
    app = createTestApp();
  });

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = undefined;
    }
  });

  test('creates an order', async () => {
    shutdown = await app.start();

    const response = await supertest(app.express)
      .post('/api/orders')
      .send({ sku: 'coffee-beans', quantity: 2 })
      .expect(201);

    expect(response.body).toEqual({
      success: true,
      data: { id: 1, sku: 'coffee-beans', quantity: 2 },
    });
  });

  test('rejects invalid orders with field details', async () => {
    shutdown = await app.start();

    const response = await supertest(app.express)
      .post('/api/orders')
      .send({ sku: '', quantity: 0 })
      .expect(422);

    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details).toBeDefined();
  });

  test('lists seeded orders', async () => {
    const seeded = new Map<number, Order>([
      [1, { id: 1, sku: 'seeded', quantity: 1 }],
    ]);
    app = createTestApp(seeded);
    shutdown = await app.start();

    const response = await supertest(app.express).get('/api/orders').expect(200);

    expect(response.body.data).toEqual([{ id: 1, sku: 'seeded', quantity: 1 }]);
  });

  test('app instances never share state', async () => {
    const first = createTestApp();
    const second = createTestApp();

    const firstShutdown = await first.start();
    const secondShutdown = await second.start();

    try {
      await supertest(first.express)
        .post('/api/orders')
        .send({ sku: 'coffee-beans', quantity: 1 })
        .expect(201);

      const firstList = await supertest(first.express).get('/api/orders').expect(200);
      const secondList = await supertest(second.express).get('/api/orders').expect(200);

      expect(firstList.body.data).toHaveLength(1);
      expect(secondList.body.data).toEqual([]);
    } finally {
      await firstShutdown();
      await secondShutdown();
    }
  });
});
```

### Why this pattern works

- **Zero global state.** Each `WebApplication` owns its settings, services, plugins, and controllers; two apps in the same process cannot leak state into each other, so tests can run in parallel without coordination.
- **The public surface is testable.** `app.express` plugs directly into supertest, and `PORT: 0` binds an ephemeral port when a real server is needed — no fixed-port collisions in CI.
- **Contract-level assertions.** Tests assert the actual envelopes (`success`, `data`, `pagination`, error `code`s), which makes the response format itself part of the verified contract.
- **Deterministic cleanup.** `afterEach` shutdown releases the server, signal handlers, plugins, and singletons — even after failed assertions — keeping suites fast and leak-free.

### Caveats and performance notes

- Always `await app.start()` before issuing requests: plugin middleware and terminal-phase hooks mount during startup, and requests made earlier would not see them.
- Use the public `app.express` getter rather than reaching into internal fields; it is the supported integration point.
- Keep `LOG_LEVEL: 'ERROR'` and `CORS: false` in test configs to reduce noise unless the test targets those behaviors specifically.
- Replace real dependencies through service factories with test doubles (seeded maps, fakes) registered before `start()`; the container makes them indistinguishable from production services to the code under test.
- `shutdown()` is idempotent, so cleanup logic does not need to guard against double invocation — but tracking the returned function in a shared variable keeps `afterEach` simple and reliable.

---

## Pattern Selection Guide

| Problem | Pattern | Core APIs |
|---|---|---|
| One API, multiple caller types (sessions + machine clients) | [Pattern 1](#pattern-1-multi-principal-authentication-in-a-single-api) | `.secure(name)`, `authenticated(name)`, per-request services |
| Endpoints must be validated and documented from one source | [Pattern 2](#pattern-2-contract-first-routes-with-validation-and-openapi-metadata) | `.validate()`, `.openapi()`, `getParams()`, `blendsdk/codegen` |
| Abuse protection and per-route pipelines | [Pattern 3](#pattern-3-composable-middleware-pipelines-with-rate-limiting) | `.middleware()`, `rateLimitMiddleware()` |
| Shared resources plus request-scoped identity | [Pattern 4](#pattern-4-composing-singletons-and-per-request-services-with-dependency-injection) | `registerService`, `dependencies`, `dispose` |
| Cross-cutting features with predictable ordering | [Pattern 5](#pattern-5-priority-ordered-plugins-with-health-checks-and-ordered-teardown) | `app.use()`, `priority`, `health`, `shutdown` |
| SPA and API on one origin without route shadowing | [Pattern 6](#pattern-6-serving-an-spa-and-its-api-from-one-process) | `staticFilesPlugin({ spa: true })`, terminal phase |
| Correlated JSON logs without plumbing a request ID | [Pattern 7](#pattern-7-request-correlated-structured-logging-across-the-async-stack) | `StructuredLogger`, `getRequestId()`, `setLogger()` |
| Fail-fast boot and graceful teardown | [Pattern 8](#pattern-8-deterministic-boot-and-graceful-shutdown-orchestration) | `app.on(...)`, `SHUTDOWN_TIMEOUT` |
| Fast, isolated full-stack tests | [Pattern 9](#pattern-9-isolation-first-integration-testing) | `PORT: 0`, `app.express`, supertest |

The patterns compose: a production SPA deployment typically combines Pattern 6 (hosting), Pattern 7 (logging), Pattern 8 (lifecycle), and Pattern 9 (tests), while API-heavy services add Patterns 1–4 as their surface grows.

---

# webafx Common Scenarios

This document answers the most common "How do I…?" questions for `blendsdk/webafx`, ordered from the simplest setup to advanced integration. Every scenario is self-contained: the code is complete, runnable TypeScript (ESM, Node.js 22+) with all imports included, and every symbol is imported from the package root. Examples assume `express` (`^5`) and `zod` (`^4`) are installed — both are peer dependencies of the package.

---

## How do I create and start a minimal WebAFX application?

**Solution:** Create a `WebApplication` with a configuration object and `await` its `start()` method. `start()` boots the Express server, registers SIGTERM/SIGINT handlers, and resolves to a `shutdown()` function for graceful, programmatic shutdown. A built-in `GET /health` endpoint answers health checks.

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'development',
  LOG_LEVEL: 'INFO',
});

// start() boots the HTTP server and returns the shutdown function
const shutdown = await app.start();

// GET http://localhost:3000/health
//   → { "health": true, "timestamp": "2025-06-01T10:15:30.123Z" }

// Graceful shutdown: drains connections, runs plugin shutdowns and
// singleton disposal, then fires the shutdown lifecycle hooks.
// SIGTERM/SIGINT trigger this same sequence automatically.
await shutdown();
```

**Notes:**
- `ENV_MODE` defaults to `'production'` when omitted (secure by default — stack traces are never leaked).
- `SHUTDOWN_TIMEOUT` (seconds, `0`–`300`) bounds how long shutdown waits for open connections to drain.

---

## How do I define a controller with routes?

**Solution:** Extend `BaseController`, implement `routes(): RouteDefinition[]`, and register the class under a base path with `app.registerController()`. Each route is built with the fluent `RouteBuilder` — pick an HTTP method (`.get()`, `.post()`, `.put()`, `.patch()`, `.delete()`) and finish the chain with `.handle()`.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

class GreetingController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/greeting')
        .handle(async (_req, res) => {
          this.ok(res, { message: 'Hello from WebAFX' });
        }),

      this.route()
        .get('/greeting/:name')
        .handle(async (req, res) => {
          this.ok(res, { message: `Hello, ${req.params.name}!` });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api', GreetingController);
await app.start();

// GET /api/greeting      → { success: true, data: { message: 'Hello from WebAFX' } }
// GET /api/greeting/Ada  → { success: true, data: { message: 'Hello, Ada!' } }
```

**Notes:**
- Handler parameters are contextually typed — no manual `Request`/`Response` annotations or imports are required.
- `this.route()` returns a fresh `RouteBuilder`; `this.authenticated()` is the same builder with the security flag preset (covered later).

---

## How do I send standardized success responses?

**Solution:** Use the response helpers inherited from `BaseController`: `this.ok()` (200), `this.created()` (201), `this.paginated()` (200 with metadata), and `this.noContent()` (204). They all emit the uniform `{ success: true, … }` envelope, so every successful response has the same shape.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

class ProductController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      // 200 → { success: true, data: { products: [...] } }
      this.route()
        .get('/products')
        .handle(async (_req, res) => {
          this.ok(res, { products: [{ id: 1, name: 'Widget' }] });
        }),

      // 201 → { success: true, data: { id: 101, ...request body } }
      this.route()
        .post('/products')
        .handle(async (req, res) => {
          this.created(res, { id: 101, ...req.body });
        }),

      // 200 → { success: true, data: [...], pagination: { total, page, limit, pages } }
      this.route()
        .get('/products/paged')
        .handle(async (_req, res) => {
          const page = [
            { id: 51, name: 'Widget 51' },
            { id: 52, name: 'Widget 52' },
          ];
          this.paginated(res, page, 150, 2, 50); // total=150, page=2, limit=50 → pages=3
        }),

      // 204 → empty body
      this.route()
        .delete('/products/:id')
        .handle(async (_req, res) => {
          this.noContent(res);
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api', ProductController);
await app.start();
```

| Helper | Status | Response shape |
|---|---|---|
| `ok(res, data)` | 200 | `{ success: true, data }` |
| `created(res, data)` | 201 | `{ success: true, data }` |
| `paginated(res, data, total, page, limit)` | 200 | `{ success: true, data, pagination: { total, page, limit, pages } }` |
| `noContent(res)` | 204 | *(empty body)* |

**Notes:**
- `paginated()` computes `pages` as `Math.ceil(total / limit)`.
- All helpers are `protected` on `BaseController` — call them from handler methods (or arrow functions inside `routes()`, which capture the controller instance).

---

## How do I read configuration values inside a controller?

**Solution:** `WebApplication` injects its `ApplicationSettings` into every controller as the protected `settings` property. Read values with the typed `get<T>(key, defaultValue?)` helper — standard keys are Zod-validated, and custom keys pass through untouched.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

class ConfigController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/config')
        .handle(async (_req, res) => {
          const port = this.settings.get<number>('PORT', 3000);
          const greeting = this.settings.get<string>('CUSTOM_GREETING', 'hello');
          const isProduction = this.settings.isProduction();

          this.ok(res, { port, greeting, isProduction });
        }),
    ];
  }
}

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'development',
  CUSTOM_GREETING: 'hallo', // custom keys are allowed and preserved
});

app.registerController('/api', ConfigController);
await app.start();

// GET /api/config
//   → { success: true, data: { port: 3000, greeting: 'hallo', isProduction: false } }
```

**Notes:**
- Known keys (`PORT`, `ENV_MODE`, `LOG_LEVEL`, `CORS`, `SHUTDOWN_TIMEOUT`, …) are validated by a Zod schema; invalid values throw at construction time with a detailed message.
- `getAll()` returns a shallow copy of the whole configuration — mutating it never affects the internal state. `isProduction()` is a shortcut for `ENV_MODE === 'production'`.

---

## How do I validate incoming request data with Zod?

**Solution:** Attach a Zod schema to the route with `.validate()`. The merged `params` + `query` + `body` payload is checked before the handler runs, and the parsed result is available through `req.services.getParams<T>()`; failures are converted to a `422 VALIDATION_ERROR` with field-level details.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { z } from 'zod';

const createUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  age: z.coerce.number().int().min(0).max(150),
});

type CreateUserInput = z.infer<typeof createUserSchema>;

class UserController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .post('/users')
        .validate(createUserSchema)
        .handle(async (req, res) => {
          // params + query + body were merged and validated before this runs
          const input = req.services.getParams<CreateUserInput>();
          this.created(res, { id: 1, ...input });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api', UserController);
await app.start();

// POST /api/users  { "name": "Ada", "email": "ada@example.com", "age": 36 }
//   → 201 { success: true, data: { id: 1, name: "Ada", email: "ada@example.com", age: 36 } }
// POST /api/users  { "email": "not-an-email" }
//   → 422 { success: false, error: { code: "VALIDATION_ERROR", details: [...] } }
```

**Notes:**
- Use `z.coerce.*` for URL params and query values — they always arrive as strings.
- Failed validation never reaches the handler; per-field problems appear in `error.details`.
- `getInput<T>()` (next scenario) still returns the three raw sources when you need the unmerged view.

---

## How do I access URL params, query strings, and the request body separately?

**Solution:** Call `req.services.getInput<T>()` to receive an object with `params`, `query`, and `body` kept separate. This avoids the classic collision problem where a body field silently overwrites a URL parameter in the merged view (`getParams<T>()`).

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

interface SearchInput {
  params: { tenantId: string };
  query: { q?: string; page?: string };
  body: { filters?: string[] };
}

class SearchController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .post('/tenants/:tenantId/search')
        .handle(async (req, res) => {
          const input = req.services.getInput<SearchInput>();

          this.ok(res, {
            tenantId: input.params.tenantId, // always the URL value
            q: input.query.q ?? '',
            page: Number(input.query.page ?? '1'),
            filters: input.body.filters ?? [],
          });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api', SearchController);
await app.start();

// POST /api/tenants/123/search?q=shoes  { "filters": ["sale"] }
//   → { success: true, data: { tenantId: '123', q: 'shoes', page: 1, filters: ['sale'] } }
```

**Notes:**
- In the merged view (`getParams()`), later sources win on key collisions (`body` beats `query` beats `params`) — `getInput()` sidesteps this entirely.
- A source with no input is returned as an empty object, so destructuring is always safe.
- The generic parameter is an assertion — shape it to match what your route actually receives.

---

## How do I return structured errors to clients?

**Solution:** Throw an error inside a handler and the framework's error handler converts it into the standard `{ success: false, error: { … } }` envelope — no manual `res.status().json()` needed. Use the built-in error classes for common cases, or `ApiError` for custom status codes.

```typescript
import {
  ApiError,
  BaseController,
  ConflictError,
  NotFoundError,
  WebApplication,
} from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

class UserController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/users/:id')
        .handle(async (req, res) => {
          const user = this.findUser(req.params.id);

          if (!user) {
            throw new NotFoundError('User not found', { userId: req.params.id });
          }

          this.ok(res, { user });
        }),

      this.route()
        .post('/users')
        .handle(async (req, res) => {
          if (req.body.email === 'taken@example.com') {
            throw new ConflictError('Email already exists');
          }

          // Custom status code and error code
          throw new ApiError(400, 'SIGNUP_CLOSED', 'Signups are currently closed');
        }),
    ];
  }

  private findUser(id: string): { id: string; name: string } | undefined {
    return id === '1' ? { id, name: 'Ada Lovelace' } : undefined;
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api', UserController);
await app.start();
```

A `GET /api/users/999` request produces:

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "User not found",
    "statusCode": 404,
    "timestamp": "2025-06-01T10:15:30.123Z",
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "path": "/api/users/999",
    "details": { "userId": "999" }
  }
}
```

| Class | Status | Code |
|---|---|---|
| `BadRequestError` | 400 | `BAD_REQUEST` |
| `UnauthorizedError` | 401 | `UNAUTHORIZED` |
| `ForbiddenError` | 403 | `FORBIDDEN` |
| `NotFoundError` | 404 | `NOT_FOUND` |
| `ConflictError` | 409 | `CONFLICT` |
| `ValidationError` | 422 | `VALIDATION_ERROR` |
| `RateLimitError` | 429 | `RATE_LIMIT_EXCEEDED` |
| `InternalServerError` | 500 | `INTERNAL_SERVER_ERROR` |
| `ServiceUnavailableError` | 503 | `SERVICE_UNAVAILABLE` |

**Notes:**
- Unknown (non-`ApiError`) errors are rendered as `500 INTERNAL_SERVER_ERROR`; the real message and stack trace are only revealed when the app runs with `ENV_MODE: 'development'`.
- Every error envelope carries `requestId` and `path` for correlation.

---

## How do I register and resolve services (singleton and per-request)?

**Solution:** Register services with `app.registerService({ name, type, factory })` and resolve them inside handlers with `await req.services.get<T>(name)`. `singleton` services are created once per application; `per-request` services are created fresh for each request and receive access to the request objects.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

interface HitCounter {
  count: number;
}

class MetricsController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/metrics')
        .handle(async (req, res) => {
          // Singleton — the same instance serves every request
          const hits = await req.services.get<HitCounter>('hits');
          hits.count += 1;

          // Per-request — a brand-new instance on every request
          const session = await req.services.get<{ startedAt: string }>('session');

          this.ok(res, { hits: hits.count, startedAt: session.startedAt });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

// Created once and shared for the application lifetime;
// dispose() runs during graceful shutdown
app.registerService({
  name: 'hits',
  type: 'singleton',
  factory: (): HitCounter => ({ count: 0 }),
  dispose: (instance) => {
    const hits = instance as HitCounter;
    console.log(`Hit counter disposed after ${hits.count} hits`);
  },
});

// Created fresh for every request; factories receive (container, settings, req, res, next)
app.registerService({
  name: 'session',
  type: 'per-request',
  factory: (): { startedAt: string } => ({ startedAt: new Date().toISOString() }),
});

app.registerController('/api', MetricsController);
await app.start();

// GET /api/metrics → hits: 1, then 2, then 3... (shared counter)
// GET /api/metrics → startedAt changes on every request
```

**Notes:**
- Declare `dependencies: ['database', …]` on a definition to guarantee resolution order; dependency cycles throw a `Circular dependency detected` error instead of hanging.
- `await req.services.get('name', fallback)` returns the fallback instead of throwing — use it for optional services.
- Per-request services can only be resolved while a request is in flight; resolving one outside request handling throws.
- Service names are unique per application — registering a duplicate throws rather than silently overwriting. For shared name constants, prefer `const ServiceNames = { … } as const` (the `preparseServiceNames()` helper is deprecated).

---

## How do I require authentication on a route?

**Solution:** Add `.secure()` to a route — or use the `this.authenticated()` shorthand — to require a signed-in principal. The guard resolves a service named `'user'` and returns `401 UNAUTHORIZED` when it yields no principal; supply the principal by registering that service, usually as a per-request factory that inspects incoming credentials.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { PerRequestFactory, RouteDefinition } from 'blendsdk/webafx';

interface User {
  id: number;
  name: string;
  role: 'user' | 'admin';
}

const userFactory: PerRequestFactory<User | undefined> = (_container, _settings, req) => {
  if (req.headers.authorization === 'Bearer secret-token') {
    return { id: 1, name: 'Ada Lovelace', role: 'admin' };
  }
  return undefined;
};

class ProfileController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      // Public — no guard
      this.route()
        .get('/public')
        .handle(async (_req, res) => {
          this.ok(res, { public: true });
        }),

      // Requires a principal — 401 without one
      this.authenticated()
        .get('/me')
        .handle(async (req, res) => {
          const user = req.services.getUser<User>();
          this.ok(res, { user });
        }),

      // `.secure()` is the explicit equivalent of `.authenticated()`
      this.route()
        .get('/me/settings')
        .secure()
        .handle(async (req, res) => {
          const user = await req.services.get<User>('user', undefined);
          this.ok(res, { theme: user?.role === 'admin' ? 'dark' : 'light' });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

// The default guard looks for a service named 'user'
app.registerService({
  name: 'user',
  type: 'per-request',
  factory: userFactory,
});

app.registerController('/api', ProfileController);
await app.start();

// GET /api/me                        → 401 UNAUTHORIZED (no principal)
// GET /api/me (Bearer secret-token)  → 200 { success: true, data: { user: {...} } }
```

**Notes:**
- The guard fails closed: if the named principal service is not registered or returns no value, the route responds `401` — never open.
- `this.authenticated()` is exactly `this.route().secure()`; both accept an optional principal service name (see the next scenario).

---

## How do I add role checks and use a different principal per route?

**Solution:** Chain `.authorize(fn)` to check the resolved principal after authentication — returning `false` produces `403 FORBIDDEN`. To protect a route with a different principal service (for example machine clients instead of users), pass its name to `.secure(name)` or `this.authenticated(name)`.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { PerRequestFactory, RouteDefinition } from 'blendsdk/webafx';

interface User {
  id: number;
  role: 'user' | 'admin';
}

interface MachineClient {
  clientId: string;
  scopes: string[];
}

const userFactory: PerRequestFactory<User | undefined> = (_container, _settings, req) =>
  req.headers['x-user'] === 'ok' ? { id: 1, role: 'admin' } : undefined;

const clientFactory: PerRequestFactory<MachineClient | undefined> = (_container, _settings, req) =>
  req.headers['x-client'] === 'ok' ? { clientId: 'svc-42', scopes: ['export'] } : undefined;

class AdminController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      // Authenticated AND authorized — role check, otherwise 403
      this.authenticated()
        .get('/admin/stats')
        .authorize((_req, user: User) => user.role === 'admin')
        .handle(async (_req, res) => {
          this.ok(res, { stats: { activeUsers: 42 } });
        }),

      // A second principal service: machine clients, not users
      this.route()
        .get('/export')
        .secure('client')
        .authorize((_req, client: MachineClient) => client.scopes.includes('export'))
        .handle(async (_req, res) => {
          this.ok(res, { export: 'ready' });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

app.registerService({ name: 'user', type: 'per-request', factory: userFactory });
app.registerService({ name: 'client', type: 'per-request', factory: clientFactory });

app.registerController('/api', AdminController);
await app.start();

// GET /api/admin/stats (anonymous)  → 401 UNAUTHORIZED (guard fails)
// GET /api/admin/stats (x-user: ok) → 200 (role check passes)
// GET /api/export (x-client: ok)    → 200 (scope check passes)
// A present principal that fails .authorize() → 403 FORBIDDEN
```

**Notes:**
- Authorization runs only after successful authentication, and the callback receives the principal selected by the route's guard.
- Naming an unregistered principal service fails closed with `401` — never open.

---

## How do I add route-level middleware such as rate limiting?

**Solution:** Chain `.middleware(fn)` before `.handle()`; middleware execute in the order they are added, ahead of the handler. `rateLimitMiddleware()` ships with the package for per-route throttling; middleware may also short-circuit (by responding directly) or forward errors with `next(err)`.

```typescript
import { WebApplication, BaseController, BadRequestError, rateLimitMiddleware } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

class SearchController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/search')
        // Middleware run in the order they are added, before the handler
        .middleware((req, _res, next) => {
          if (req.headers['x-api-version'] === undefined) {
            next(new BadRequestError('X-API-Version header is required'));
            return;
          }
          next();
        })
        // In-memory limit: 10 requests per 60s window, keyed by API key (or IP)
        .middleware(
          rateLimitMiddleware({
            maxRequests: 10,
            windowMs: 60_000,
            keyExtractor: (req) => {
              const apiKey = req.headers['x-api-key'];
              return typeof apiKey === 'string' ? apiKey : req.ip ?? 'unknown';
            },
          })
        )
        .handle(async (req, res) => {
          this.ok(res, { query: req.query.q ?? '' });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api', SearchController);
await app.start();

// Responses carry X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset
// Exceeding the limit → 429 RATE_LIMIT_EXCEEDED
```

| Option | Type | Default | Description |
|---|---|---|---|
| `maxRequests` | `number` | `100` | Maximum requests allowed per window |
| `windowMs` | `number` | `60000` | Window duration in milliseconds |
| `keyExtractor` | `(req: Request) => string` | client IP | Derives the bucket key for each request |
| `message` | `string` | `'Rate limit exceeded'` | Error message when the limit is exceeded |

**Notes:**
- Counters are kept in memory (per process) — for multi-instance deployments, back the limiter with Redis via a plugin.
- Errors passed to `next(err)` flow into the standard error handler, so responses keep the `{ success: false, error: { … } }` shape.

---

## How do I register a plugin with priority, health checks, and shutdown?

**Solution:** Register a `PluginDefinition` with `app.use()`: a unique `name`, an optional `priority` (lower numbers install first; default 100), and a `factory({ app, express, logger })` that can mount middleware and return `health`, `shutdown`, and `terminal` hooks. Plugin health results are aggregated by `GET /health`, and `shutdown()` runs during graceful shutdown.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { Plugin, PluginDefinition } from 'blendsdk/webafx';

const requestCounterPlugin: PluginDefinition = {
  name: 'request-counter',
  // Lower priority installs first; plugins without a priority default to 100
  priority: 50,
  factory: async ({ express, logger }): Promise<Plugin> => {
    let requests = 0;

    express.use((_req, _res, next) => {
      requests += 1;
      next();
    });

    await logger.info('Request counter plugin installed');

    return {
      // Aggregated by the built-in GET /health endpoint
      health: async () => requests < 1_000_000,
      // Runs during graceful shutdown
      shutdown: async () => {
        await logger.info(`Request counter stopped after ${requests} requests`);
      },
    };
  },
};

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.use(requestCounterPlugin);
await app.start();
```

**Notes:**
- Plugins install in ascending priority order; equal priorities keep registration order, and a duplicate `name` throws at registration time.
- Middleware mounted in the factory runs before controllers. For catch-all middleware that must not shadow routes (like an SPA fallback), return a `terminal` hook instead — it runs after controllers and `/health`, but before the 404 handler.
- A factory that throws rejects `app.start()` — plugins fail fast at boot.

---

## How do I run code at startup and shutdown (lifecycle hooks)?

**Solution:** Register async hooks with `app.on('beforeStart' | 'afterStart' | 'beforeShutdown' | 'afterShutdown', fn)` — registration is chainable and multiple hooks per event run in registration order. Startup runs `beforeStart` → plugin installation → `afterStart`; shutdown runs `beforeShutdown` → plugin shutdowns → `afterShutdown`, with singleton disposals during the same sequence.

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

app
  .on('beforeStart', async () => {
    // Runs first — before plugins install and before the server binds.
    // Use it for initialization the rest of the app depends on.
    console.log('wiring up dependencies...');
  })
  .on('afterStart', async () => {
    // Runs after plugins and controllers are mounted and the server
    // is listening — warm caches or signal readiness here.
    console.log('ready for requests');
  })
  .on('beforeShutdown', async () => {
    // Runs first during shutdown — stop accepting new work.
    console.log('draining...');
  })
  .on('afterShutdown', async () => {
    // Runs last during shutdown — final cleanup.
    console.log('done');
  });

const shutdown = await app.start();

// Trigger graceful shutdown manually; SIGTERM/SIGINT do the same automatically
await shutdown();
```

**Notes:**
- Hooks may be sync or async — asynchronous hooks are awaited before the lifecycle proceeds.
- Multiple hooks for the same event run in the order they were registered, and `.on()` chains.

---

## How do I configure CORS?

**Solution:** Set the `CORS` option: `false` disables CORS handling, `true` enables permissive defaults (`Access-Control-Allow-Origin: *`), and an object configures an explicit policy. Requests from disallowed origins are still processed but receive no `Access-Control-Allow-Origin` header, so browsers block the response.

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'development',
  CORS: {
    origin: ['https://app.example.com', 'https://admin.example.com'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-Total-Count'],
    credentials: true,
    maxAge: 7200,
  },
});

await app.start();

// Preflight OPTIONS from an allowed origin → 204 with CORS headers
// Allowed origin: Access-Control-Allow-Origin echoes the requesting origin
// Other origins:  no Access-Control-Allow-Origin header is set (browser blocks it)
```

| Option | Type | Description |
|---|---|---|
| `origin` | `string \| string[] \| callback` | Allowed origin(s); use the callback form for dynamic decisions |
| `methods` | `string[]` | Methods advertised in preflight responses |
| `allowedHeaders` | `string[]` | Request headers the browser may send |
| `exposedHeaders` | `string[]` | Response headers readable by browser JavaScript |
| `credentials` | `boolean` | Emits `Access-Control-Allow-Credentials: true` |
| `maxAge` | `number` | Preflight cache duration in seconds |

For dynamic origin decisions, use the callback form:

```typescript fragment
import type { CorsConfig } from 'blendsdk/webafx';

const cors: CorsConfig = {
  origin: (origin: string | undefined, callback: (err: Error | null, allowed: boolean) => void) => {
    // Allow non-browser requests (no Origin header) and any *.mycompany.com subdomain
    callback(null, origin === undefined || origin.endsWith('.mycompany.com'));
  },
};
```

**Notes:**
- Preflight `OPTIONS` requests are answered with `204`.
- With `credentials: true`, browsers require explicit origins — the wildcard `*` is rejected for credentialed requests.

---

## How do I serve static files and a single-page application?

**Solution:** Register `staticFilesPlugin()` for each directory you serve, using `prefix` to mount it at a URL path and `spa: true` to serve `index.html` for unmatched client-side routes. The SPA fallback is terminal-phase middleware — it runs after controllers and `/health`, so it can never shadow your API routes.

```typescript
import { WebApplication, staticFilesPlugin } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

// Hashed build assets — safe to cache forever
app.use(
  staticFilesPlugin({
    root: './client/build/assets',
    prefix: '/assets',
    maxAge: '1y',
    immutable: true,
  })
);

// The SPA itself — unmatched HTML navigations fall back to index.html
app.use(
  staticFilesPlugin({
    root: './client/build',
    spa: true,
  })
);

await app.start();

// GET /assets/main.abc123.js → the hashed file, cached for one year
// GET /settings/profile      → index.html (the client-side router takes over)
// GET /api/users             → controllers still win; never index.html
```

| Option | Type | Default | Description |
|---|---|---|---|
| `root` | `string` | — *(required)* | Directory to serve, resolved from `process.cwd()` |
| `prefix` | `string` | `'/'` | URL prefix to mount at |
| `maxAge` | `string \| number` | `0` | Cache-Control max-age (`'1d'`, `'1h'`, or milliseconds) |
| `immutable` | `boolean` | `false` | Adds `immutable` to Cache-Control (for hashed filenames) |
| `dotfiles` | `'ignore' \| 'allow' \| 'deny'` | `'ignore'` | Dotfile handling policy |
| `index` | `string \| false` | `'index.html'` | Directory index file |
| `spa` | `boolean` | `false` | Serve `index.html` for unmatched HTML navigations |
| `priority` | `number` | `20` | Plugin install priority |

**Notes:**
- The SPA fallback only answers `GET` requests whose path has no file extension and whose `Accept` header includes `text/html` — JSON API calls correctly fall through to 404.
- The root directory is validated at startup; a missing directory makes `app.start()` reject with a clear error.
- Two instances registered at the same prefix collide (the plugin name is `static-files:<prefix>`) — registering both throws.

---

## How do I get the request ID in my handlers?

**Solution:** Call `getRequestId()` or `getRequestContext()` anywhere in the async call chain — the framework assigns each request a UUID and propagates a `RequestContext` (`requestId` + `startTime`) via `AsyncLocalStorage`. The ID is echoed in the `X-Request-ID` response header and included in error envelopes; a valid incoming `X-Request-ID` is reused for cross-service tracing.

```typescript
import { BaseController, WebApplication, getRequestContext, getRequestId } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

class ReportController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/report')
        .handle(async (_req, res) => {
          // Available anywhere in the async call chain — no need to thread req through
          const requestId = getRequestId();
          const context = getRequestContext();

          this.ok(res, {
            requestId,
            elapsedMs: context ? Date.now() - context.startTime : 0,
          });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api', ReportController);
await app.start();

// Every response carries an X-Request-ID header; error envelopes repeat it as error.requestId
```

**Notes:**
- Malformed or malicious incoming `X-Request-ID` values are discarded and replaced with a fresh UUID — never trusted.
- Outside a request scope (for example in `beforeStart`), both helpers return `undefined`.
- The context object is extensible (`[key: string]: unknown`), so additional request-scoped fields can travel alongside `requestId` and `startTime`.

---

## How do I emit structured JSON logs?

**Solution:** Create a `StructuredLogger` and install it with `app.setLogger()` before `start()`. Each entry is a single JSON line — `level`, `message`, `timestamp`, optional `prefix`, plus a `data` object and any fields returned by a context function such as the current request ID.

```typescript
import { WebApplication, StructuredLogger, getRequestId } from 'blendsdk/webafx';

// Runs for every log entry — context fields land at the top level of the JSON line
const logger = new StructuredLogger('ORDERS', 'INFO', () => ({
  service: 'orders-api',
  requestId: getRequestId(),
}));

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });
app.setLogger(logger);

await logger.info('orders-api starting');
const shutdown = await app.start();

await shutdown();
```

Inside a request, a log line looks like this:

```json
{"level":"INFO","message":"order created","timestamp":"2025-06-01T10:15:30.123Z","prefix":"ORDERS","service":"orders-api","requestId":"550e8400-e29b-41d4-a716-446655440000","data":{"orderId":"ord_123"}}
```

| Level | Priority | Logs | Output stream |
|---|---|---|---|
| `ERROR` | 1 | errors only | `console.error` |
| `WARN` | 2 | errors + warnings | `console.log` |
| `INFO` | 3 | errors, warnings + info | `console.log` |
| `DEBUG` | 4 | everything | `console.log` |

**Notes:**
- Level resolution order: constructor argument → `LOG_LEVEL` environment variable → `'ERROR'`; setting `DEBUG=true` additionally enables debug entries.
- The default logger is `ConsoleLogger` (plain text with `[LEVEL:PREFIX]` tags); `app.setLogger()` replaces it, which is also how logger plugins integrate.

---

## How do I document routes for OpenAPI generation?

**Solution:** Chain `.openapi({ … })` onto a route to attach opt-in documentation metadata: summary, description, tags, operation ID, path parameters, response definitions, and the response `envelope` a generated client should read. WebAFX only carries the metadata; `blendsdk/codegen` builds the spec, and routes without `.openapi()` stay hidden from it.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { z } from 'zod';

const productResponse = z.object({
  id: z.number(),
  name: z.string(),
});

class ProductController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/products/:id')
        .openapi({
          summary: 'Get product by ID',
          tags: ['products'],
          operationId: 'getProductById',
          pathParams: {
            id: { schema: z.coerce.number().int().positive(), description: 'Product ID' },
          },
          responses: [
            { statusCode: 200, description: 'Product details', schema: productResponse },
            { statusCode: 404, description: 'Product not found' },
          ],
        })
        .handle(async (req, res) => {
          this.ok(res, { id: Number(req.params.id), name: 'Widget' });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api', ProductController);
await app.start();
```

**Notes:**
- `.openapi()` is pure metadata — behavior is unchanged when it is omitted, and it can be chained anywhere before `.handle()`.
- Opt-in keeps internal routes out of the published specification automatically.
- A paginated route sets `envelope: 'body'` so a generated client keeps the `pagination` object; the default `'data'` unwraps only the `data` property.

---

## How do I test my application with supertest?

**Solution:** Create and start a `WebApplication` per test with `PORT: 0` and point supertest at the public `app.express` getter. Because every application owns its registries, tests are fully isolated — just shut the app down in teardown.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import supertest from 'supertest';
import { afterEach, expect, test } from 'vitest';

class PingController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/ping')
        .handle(async (_req, res) => {
          this.ok(res, { pong: true });
        }),
    ];
  }
}

let shutdown: (() => Promise<void>) | undefined;

afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
});

test('GET /api/ping returns the success envelope', async () => {
  // PORT 0 → random free port; LOG_LEVEL ERROR keeps test output quiet
  const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });
  app.registerController('/api', PingController);

  shutdown = await app.start();

  const response = await supertest(app.express).get('/api/ping').expect(200);

  expect(response.body).toEqual({ success: true, data: { pong: true } });
});
```

**Notes:**
- `app.express` exposes the underlying Express app for supertest — no port number needs to be known.
- Singleton services never leak between tests because each `WebApplication` owns its own service registry.
- The `shutdown()` function is idempotent, so it is safe to call in `afterEach` even when a test fails early.

---

# webafx Examples Library

Every example in this library is a complete, copy-paste-ready ESM module built directly from WebAFX's own test suite and source documentation. All examples assume a TypeScript project with strict mode and Node.js >= 22.

**Conventions used throughout:**

- Examples are ESM modules (`"type": "module"`) and use top-level `await`.
- `express` and `zod` must be installed in the consuming project — they are peer dependencies.
- Server examples listen on fixed ports (`3000`, `3100`) so the trailing `fetch` calls can reach them; change `PORT` if those ports are taken.
- Only package-root imports are used — no `dist/` or `src/` paths.
- The testing example additionally requires `vitest` and `supertest` as dev dependencies.

| What you need | Import |
|---------------|--------|
| Core classes (`WebApplication`, `BaseController`, `ApplicationSettings`, `ServiceContainer`, `ConsoleLogger`, `StructuredLogger`, `rateLimitMiddleware`, `staticFilesPlugin`, `getRequestId`, `getRequestContext`) | `import { ... } from 'blendsdk/webafx';` |
| Types (`RouteDefinition`, `PluginDefinition`, `OpenAPIRouteMetadata`, `LogLevel`, `AuthorizeFunction`) | `import type { ... } from 'blendsdk/webafx';` |
| HTTP errors (`ApiError`, `BadRequestError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `ValidationError`, `RateLimitError`, `InternalServerError`, `ServiceUnavailableError`) | `import { ... } from 'blendsdk/webafx';` |
| Express types (`Request`, `Response`, `NextFunction`) | `import type { ... } from 'express';` |

---

## Getting Started

### Minimal WebAFX Application

The smallest useful WebAFX program: one controller, one route, the built-in health check, and a graceful shutdown.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class GreetingController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/greeting')
        .handle(async (_req: Request, res: Response) => {
          this.ok(res, { message: 'Hello from WebAFX' });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

// registerController mounts every route the controller declares under this base path.
app.registerController('/api', GreetingController);

// start() boots the HTTP server and returns the shutdown function.
const shutdown = await app.start();

const greeting = await fetch('http://localhost:3000/api/greeting');
console.log(await greeting.json());
// { success: true, data: { message: 'Hello from WebAFX' } }

const health = await fetch('http://localhost:3000/health');
console.log(await health.json());
// { health: true, timestamp: '2024-01-15T10:30:00.000Z' }

await shutdown();
```

---

### A Controller with All Five HTTP Methods

A single controller declaring GET, POST, PUT, PATCH, and DELETE routes, using the `ok()`, `created()`, and `noContent()` response helpers.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class UsersController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      // GET /api/users
      this.route()
        .get('/users')
        .handle(async (_req: Request, res: Response) => {
          this.ok(res, [{ id: 1, name: 'Ada Lovelace' }]);
        }),

      // POST /api/users
      this.route()
        .post('/users')
        .handle(async (_req: Request, res: Response) => {
          this.created(res, { id: 2, name: 'Grace Hopper' });
        }),

      // PUT /api/users/:id
      this.route()
        .put('/users/:id')
        .handle(async (req: Request, res: Response) => {
          const { id } = req.services.getInput<{ params: { id: string } }>().params;
          this.ok(res, { id, name: 'Ada Lovelace (updated)' });
        }),

      // PATCH /api/users/:id
      this.route()
        .patch('/users/:id')
        .handle(async (req: Request, res: Response) => {
          const { id } = req.services.getInput<{ params: { id: string } }>().params;
          this.ok(res, { id, patched: true });
        }),

      // DELETE /api/users/:id
      this.route()
        .delete('/users/:id')
        .handle(async (_req: Request, res: Response) => {
          this.noContent(res);
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api', UsersController);
const shutdown = await app.start();

// GET    /api/users      → 200 { "success": true, "data": [ { "id": 1, ... } ] }
// POST   /api/users      → 201 { "success": true, "data": { "id": 2, ... } }
// PUT    /api/users/1    → 200 { "success": true, "data": { "id": "1", ... } }
// PATCH  /api/users/1    → 200 { "success": true, "data": { "id": "1", "patched": true } }
// DELETE /api/users/1    → 204 (no body)

await shutdown();
```

---

## Routing & Request Handling

### Route-Level Middleware

Middleware added with `.middleware()` runs in registration order before the handler. It can short-circuit by sending a response, or abort through the error handler with `next(err)`.

```typescript
import { BaseController, UnauthorizedError, WebApplication } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { NextFunction, Request, Response } from 'express';

// Runs first — observes the request, then passes control along.
const requestLogger = (req: Request, _res: Response, next: NextFunction): void => {
  console.log(`[request] ${req.method} ${req.path}`);
  next();
};

// Runs second — rejects the request when the API key is missing or wrong.
const requireApiKey = (req: Request, _res: Response, next: NextFunction): void => {
  if (req.header('x-api-key') !== 'secret') {
    next(new UnauthorizedError('API key required'));
    return;
  }
  next();
};

class OrdersController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .post('/orders')
        .middleware(requestLogger)
        .middleware(requireApiKey)
        .handle(async (_req: Request, res: Response) => {
          this.ok(res, { queued: true });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'ERROR' });
app.registerController('/api', OrdersController);
const shutdown = await app.start();

const unauthorized = await fetch('http://localhost:3000/api/orders', { method: 'POST' });
console.log(unauthorized.status);
// [request] POST /api/orders
// 401 → { "success": false, "error": { "code": "UNAUTHORIZED", "message": "API key required", ... } }

const authorized = await fetch('http://localhost:3000/api/orders', {
  method: 'POST',
  headers: { 'x-api-key': 'secret' },
});
console.log(authorized.status);
// [request] POST /api/orders
// 200

await shutdown();
```

---

### Typed Access to Params, Query, and Body

`req.services.getInput()` exposes `params`, `query`, and `body` as separate, fully typed sources; `req.services.getParams()` returns the merged view. Body values can never clobber params or query values.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class UsersController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .patch('/users/:id')
        .handle(async (req: Request, res: Response) => {
          const input = req.services.getInput<{
            params: { id: string };
            query: { notify?: string };
            body: { name?: string; email?: string };
          }>();

          this.ok(res, {
            id: input.params.id,
            notify: input.query.notify === 'true',
            changes: input.body,
          });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api', UsersController);
const shutdown = await app.start();

// PATCH /api/users/123?notify=true   body: { "name": "Ada" }
// → 200 { "success": true, "data": { "id": "123", "notify": true, "changes": { "name": "Ada" } } }

await shutdown();
```

---

### Paginated Collection Endpoint

Use `this.paginated()` to send a uniform list envelope with `total`, `page`, `limit`, and computed `pages` metadata.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

const allUsers = Array.from({ length: 150 }, (_, index) => ({
  id: index + 1,
  name: `User ${index + 1}`,
}));

class UsersController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/users')
        .handle(async (req: Request, res: Response) => {
          const { page: pageParam, limit: limitParam } = req.services.getInput<{
            query: { page?: string; limit?: string };
          }>().query;

          const page = Number(pageParam ?? 1);
          const limit = Number(limitParam ?? 50);
          const start = (page - 1) * limit;

          this.paginated(res, allUsers.slice(start, start + limit), allUsers.length, page, limit);
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api', UsersController);
const shutdown = await app.start();

// GET /api/users?page=2&limit=50
// {
//   "success": true,
//   "data": [ { "id": 51, "name": "User 51" }, ..., { "id": 100, "name": "User 100" } ],
//   "pagination": { "total": 150, "page": 2, "limit": 50, "pages": 3 }
// }

await shutdown();
```

---

## Request Validation

### Zod Request Validation

Attach a Zod schema with `.validate()`; WebAFX validates the merged params + query + body before the handler runs and rejects invalid requests with a structured `422` envelope.

```typescript
import { BaseController, WebApplication } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';
import { z } from 'zod';

const createUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  age: z.coerce.number().int().min(18).optional(),
});

// The validated, coerced output type — use it for getParams() typing.
type CreateUserInput = z.infer<typeof createUserSchema>;

class UsersController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .post('/users')
        .validate(createUserSchema)
        .handle(async (req: Request, res: Response) => {
          const input = req.services.getParams<CreateUserInput>();
          this.created(res, { id: 123, ...input });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api', UsersController);
const shutdown = await app.start();

// Valid:   { "name": "Ada", "email": "ada@example.com" }
// → 201 { "success": true, "data": { "id": 123, "name": "Ada", "email": "ada@example.com" } }
//
// Invalid: { "name": "", "email": "not-an-email" }
// → 422 {
//     "success": false,
//     "error": {
//       "code": "VALIDATION_ERROR",
//       "statusCode": 422,
//       "details": [ /* one entry per failing field: path, message, code */ ]
//     }
//   }
//   (the handler never runs)

await shutdown();
```

---

## Error Handling

### Throwing Typed Errors

Throw the built-in HTTP error classes from handlers; WebAFX renders them as the standard error envelope with the right status code, `code`, and optional `details`.

```typescript
import {
  BaseController,
  ConflictError,
  NotFoundError,
  ValidationError,
  WebApplication,
} from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface User {
  id: string;
  email: string;
}

class UsersController extends BaseController {
  private readonly users = new Map<string, User>([['1', { id: '1', email: 'ada@example.com' }]]);

  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/users/:id')
        .handle(async (req: Request, res: Response) => {
          const { id } = req.services.getInput<{ params: { id: string } }>().params;

          const user = this.users.get(id);
          if (!user) {
            throw new NotFoundError(`User ${id} does not exist`, { id });
          }
          this.ok(res, user);
        }),

      this.route()
        .post('/users')
        .handle(async (req: Request, res: Response) => {
          const { email } = req.services.getInput<{ body: { email?: string } }>().body;

          if (!email) {
            throw new ValidationError('Validation Failed', { email: 'Email is required' });
          }

          const exists = [...this.users.values()].some((user) => user.email === email);
          if (exists) {
            throw new ConflictError('Email is already registered');
          }

          this.created(res, { id: String(this.users.size + 1), email });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'ERROR' });
app.registerController('/api', UsersController);
const shutdown = await app.start();

// GET  /api/users/1  → 200 { "success": true, "data": { "id": "1", "email": "ada@example.com" } }
//
// GET  /api/users/9  → 404 {
//     "success": false,
//     "error": { "code": "NOT_FOUND", "message": "User 9 does not exist",
//                "statusCode": 404, "details": { "id": "9" }, "requestId": "...", "path": "/api/users/9" }
//   }
//
// POST /api/users  { "email": "ada@example.com" }
//   → 409 { "success": false, "error": { "code": "CONFLICT", "message": "Email is already registered" } }

await shutdown();
```

For fully custom status/code pairs, throw the base class directly:

```typescript fragment
throw new ApiError(402, 'PAYMENT_REQUIRED', 'Subscription is past due');
```

---

### Development vs. Production Error Detail

Unknown errors (anything that is not an `ApiError`) are always a `500` — but the detail level depends on `ENV_MODE`. Development exposes the real message and stack; production returns a generic message with no stack, while still including `requestId` and `path` for correlation.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

class BoomController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/boom')
        .handle(async () => {
          throw new Error('Database connection failed');
        }),
    ];
  }
}

const devApp = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'ERROR' });
devApp.registerController('/api', BoomController);
const devShutdown = await devApp.start();

const prodApp = new WebApplication({ PORT: 3100, ENV_MODE: 'production', LOG_LEVEL: 'ERROR' });
prodApp.registerController('/api', BoomController);
const prodShutdown = await prodApp.start();

console.log(await (await fetch('http://localhost:3000/api/boom')).json());
// Development — real message + stack:
// {
//   "success": false,
//   "error": {
//     "code": "INTERNAL_SERVER_ERROR",
//     "message": "Database connection failed",
//     "statusCode": 500,
//     "requestId": "550e8400-e29b-41d4-a716-446655440000",
//     "path": "/api/boom",
//     "timestamp": "2024-01-15T10:30:00.000Z",
//     "stack": "Error: Database connection failed\n    at ..."
//   }
// }

console.log(await (await fetch('http://localhost:3100/api/boom')).json());
// Production — generic message, no stack:
// {
//   "success": false,
//   "error": {
//     "code": "INTERNAL_SERVER_ERROR",
//     "message": "Internal Server Error",
//     "statusCode": 500,
//     "requestId": "...",
//     "path": "/api/boom",
//     "timestamp": "..."
//   }
// }

await devShutdown();
await prodShutdown();
```

---

## Services & Dependency Injection

### Singleton vs. Per-Request Services

`singleton` services are created once and shared across every request; `per-request` services are built fresh for each HTTP request. Register both on the application, then resolve them from `req.services`.

```typescript
import { randomUUID } from 'node:crypto';
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'ERROR' });

// Singleton — created once, shared by every request.
app.registerService({
  name: 'counter',
  type: 'singleton',
  factory: () => ({ count: 0 }),
});

// Per-request — created fresh for each HTTP request.
app.registerService({
  name: 'requestId',
  type: 'per-request',
  factory: () => ({ id: randomUUID() }),
});

class StatsController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/stats')
        .handle(async (req: Request, res: Response) => {
          const counter = await req.services.get<{ count: number }>('counter');
          counter.count += 1;

          const requestId = await req.services.get<{ id: string }>('requestId');

          this.ok(res, { count: counter.count, requestId: requestId.id });
        }),
    ];
  }
}

app.registerController('/api', StatsController);
const shutdown = await app.start();

const first = await fetch('http://localhost:3000/api/stats');
console.log(await first.json());
// { success: true, data: { count: 1, requestId: '2f9c8a...' } }

const second = await fetch('http://localhost:3000/api/stats');
console.log(await second.json());
// { success: true, data: { count: 2, requestId: '8a11f0...' } }
//   ↑ count persists (singleton)      ↑ requestId changes (per-request)

await shutdown();
```

Service names must be unique — registering the same name twice throws `Service "counter" is already registered`. Per-request services accessed outside a request scope throw as well.

---

### Service Dependencies and Disposal

Declare `dependencies` so a service resolves after everything it needs; add a `dispose` hook to release resources during application shutdown. Cycles are detected and reported with the offending chain.

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'ERROR' });

app.registerService({
  name: 'config',
  type: 'singleton',
  factory: () => ({ dbUrl: 'postgres://localhost/app' }),
});

// 'config' is resolved before this factory runs.
app.registerService({
  name: 'database',
  type: 'singleton',
  dependencies: ['config'],
  factory: async (container) => {
    const config = await container.get<{ dbUrl: string }>('config');
    return {
      url: config.dbUrl,
      connected: true,
    };
  },
  // Called during application shutdown for singletons that were created.
  dispose: async () => {
    console.log('database: connection pool released');
  },
});

// Transitive dependency — follows the chain config -> database -> users.
app.registerService({
  name: 'users',
  type: 'singleton',
  dependencies: ['database'],
  factory: async (container) => {
    const db = await container.get<{ url: string; connected: boolean }>('database');
    return { db, count: 2 };
  },
});

const shutdown = await app.start();
await shutdown();
// Output during shutdown:
// database: connection pool released
```

A cyclic chain throws at resolution time, e.g. `Circular dependency detected: service-a -> service-b -> service-a`.

---

## Authentication & Authorization

### Securing Routes with a Principal Service

Mark routes as secure with `.secure()` or the `authenticated()` shorthand. The guard resolves the default `'user'` service from the container for every secure route — return the authenticated principal object from that service, or `undefined` to reject with `401`.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface User {
  id: number;
  name: string;
  role: 'user' | 'admin';
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'ERROR' });

// The default principal service — replace the token check with real
// session/JWT verification (typically provided by an auth plugin).
app.registerService({
  name: 'user',
  type: 'per-request',
  factory: (_container, _settings, req) => {
    const token = req.header('authorization');
    if (token === 'Bearer valid-token') {
      return { id: 1, name: 'Test User', role: 'user' };
    }
    if (token === 'Bearer admin-token') {
      return { id: 2, name: 'Admin User', role: 'admin' };
    }
    return undefined;
  },
});

class AccountController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      // Public route — no principal required.
      this.route()
        .get('/status')
        .handle(async (_req: Request, res: Response) => {
          this.ok(res, { service: 'account', public: true });
        }),

      // Secure route — 401 when the 'user' service yields no principal.
      this.authenticated()
        .get('/profile')
        .handle(async (req: Request, res: Response) => {
          const user = req.services.getUser<User>();
          this.ok(res, { profile: user });
        }),
    ];
  }
}

app.registerController('/api/account', AccountController);
const shutdown = await app.start();

// curl http://localhost:3000/api/account/profile
//   → 401 { "success": false, "error": { "code": "UNAUTHORIZED", "statusCode": 401, ... } }
//
// curl -H "Authorization: Bearer valid-token" http://localhost:3000/api/account/profile
//   → 200 { "success": true, "data": { "profile": { "id": 1, "name": "Test User", "role": "user" } } }

await shutdown();
```

---

### Supporting Multiple Principals

When an application serves more than one caller type, register each principal under its own service name and select it per route: `.secure('client')` (or `authenticated('client')`) resolves the named service instead of the default `'user'`.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface Principal {
  sub: string;
  kind: 'user' | 'client';
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'ERROR' });

// Browser-session principal — the default 'user' service.
app.registerService({
  name: 'user',
  type: 'per-request',
  factory: (_container, _settings, req) => {
    if (req.header('x-user') === 'ok') {
      return { sub: 'user-1', kind: 'user' };
    }
    return undefined;
  },
});

// Machine-client principal — a second, independent auth provider.
app.registerService({
  name: 'client',
  type: 'per-request',
  factory: (_container, _settings, req) => {
    if (req.header('x-client') === 'ok') {
      return { sub: 'client-1', kind: 'client' };
    }
    return undefined;
  },
});

class PortalController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      // Default principal — resolves the 'user' service.
      this.authenticated()
        .get('/session')
        .handle(async (req: Request, res: Response) => {
          const user = req.services.getUser<Principal>();
          this.ok(res, user);
        }),

      // Named principal — resolves the 'client' service instead.
      this.authenticated('client')
        .get('/export')
        .handle(async (req: Request, res: Response) => {
          const client = await req.services.get<Principal>('client', undefined);
          this.ok(res, { exportedBy: client?.sub ?? 'unknown' });
        }),
    ];
  }
}

app.registerController('/api/portal', PortalController);
const shutdown = await app.start();

// curl -H "x-user: ok"   http://localhost:3000/api/portal/session
//   → 200 { "success": true, "data": { "sub": "user-1", "kind": "user" } }
//
// curl                   http://localhost:3000/api/portal/export
//   → 401 (no client principal present)
//
// curl -H "x-client: ok" http://localhost:3000/api/portal/export
//   → 200 { "success": true, "data": { "exportedBy": "client-1" } }

await shutdown();
```

A secure route that names an unregistered service also fails closed with `401`.

---

### Role Checks with authorize()

`.authorize(fn)` runs after authentication with the resolved principal. Returning `false` produces a `403`; the principal is whatever the route's selected service provided.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface User {
  id: number;
  role: 'user' | 'admin';
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'ERROR' });

app.registerService({
  name: 'user',
  type: 'per-request',
  factory: (_container, _settings, req) => {
    if (req.header('authorization') === 'Bearer admin-token') {
      return { id: 2, role: 'admin' };
    }
    if (req.header('authorization') === 'Bearer user-token') {
      return { id: 1, role: 'user' };
    }
    return undefined;
  },
});

class AdminController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.authenticated()
        .get('/admin/stats')
        .authorize((_req: Request, user: User) => user.role === 'admin')
        .handle(async (_req: Request, res: Response) => {
          this.ok(res, { users: 1204, revenue: 52750 });
        }),
    ];
  }
}

app.registerController('/api', AdminController);
const shutdown = await app.start();

// curl                                           http://localhost:3000/api/admin/stats
//   → 401 (no principal — authentication failed)
//
// curl -H "Authorization: Bearer user-token"     http://localhost:3000/api/admin/stats
//   → 403 { "success": false, "error": { "code": "FORBIDDEN", ... } }   (authorize returned false)
//
// curl -H "Authorization: Bearer admin-token"    http://localhost:3000/api/admin/stats
//   → 200 { "success": true, "data": { "users": 1204, "revenue": 52750 } }

await shutdown();
```

---

## Plugins

### Writing a Plugin

A plugin is a named, prioritized factory that receives `{ app, express, logger }` and returns optional `health` and `shutdown` hooks. Health results are aggregated into `GET /health`; shutdown hooks run in installation order.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { PluginDefinition } from 'blendsdk/webafx';
import type { NextFunction, Request, Response } from 'express';

const metricsPlugin: PluginDefinition = {
  name: 'metrics',
  priority: 50, // optional — defaults to 100
  factory: async ({ express, logger }) => {
    let requestCount = 0;

    express.use((_req: Request, _res: Response, next: NextFunction): void => {
      requestCount += 1;
      next();
    });

    await logger.info('Metrics plugin installed');

    return {
      // Aggregated into GET /health — return false to report unhealthy.
      health: async () => true,
      shutdown: async () => {
        await logger.info('Metrics plugin shut down');
      },
    };
  },
};

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'ERROR' });
app.use(metricsPlugin);

const shutdown = await app.start();

const health = await fetch('http://localhost:3000/health');
console.log(await health.json());
// { "health": true, "timestamp": "2024-01-15T10:30:00.000Z" }

await shutdown();
// Runs the plugin's shutdown hook as part of the graceful sequence.
```

Plugin names must be unique — registering `metrics` twice throws `Plugin "metrics" is already registered`.

---

### Plugin Priority Ordering

Plugins install in ascending priority order (lower numbers first); when priorities are equal, registration order is preserved. Since plugin factories usually mount middleware, priority determines middleware order.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { PluginDefinition } from 'blendsdk/webafx';

const installOrder: string[] = [];

const tracked = (name: string, priority?: number): PluginDefinition => ({
  name,
  priority,
  factory: async () => {
    installOrder.push(name);
    return {};
  },
});

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'ERROR' });

app.use(tracked('auth', 10)); // installs first
app.use(tracked('metrics', 50));
app.use(tracked('docs')); // no priority → defaults to 100

const shutdown = await app.start();
console.log(installOrder);
// [ 'auth', 'metrics', 'docs' ]

await shutdown();
```

---

### The Terminal Phase: Catch-All Middleware

A plugin's `terminal` hook mounts middleware after controllers and `/health`, but before the 404 handler — the correct place for catch-all behavior (like an HTML 404 page) that must never shadow real routes.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { PluginDefinition, RouteDefinition } from 'blendsdk/webafx';
import type { NextFunction, Request, Response } from 'express';

const htmlNotFoundPlugin: PluginDefinition = {
  name: 'html-404',
  factory: async () => ({
    terminal: async ({ express, logger }) => {
      express.use((req: Request, res: Response, next: NextFunction): void => {
        // Only HTML navigations get the pretty page; API clients fall
        // through to the JSON 404 handler.
        if (req.method === 'GET' && req.accepts('html')) {
          res.status(404).send('<!DOCTYPE html><html><body><h1>Page not found</h1></body></html>');
          return;
        }
        next();
      });
      await logger.info('HTML 404 terminal mounted');
    },
  }),
};

class HelloController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/hello')
        .handle(async (_req: Request, res: Response) => {
          this.ok(res, { message: 'Hello' });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'ERROR' });
app.use(htmlNotFoundPlugin);
app.registerController('/api', HelloController);

const shutdown = await app.start();

// GET /api/hello (any Accept)                  → 200 JSON (controllers always win)
// GET /health (Accept: text/html)              → 200 JSON (health is registered before terminals)
// GET /api/missing (Accept: application/json)  → 404 { "success": false, "error": { "code": "NOT_FOUND", ... } }
// GET /missing-page (Accept: text/html)        → 404 HTML page

await shutdown();
```

---

## Application Lifecycle

### Lifecycle Hooks

Register async or sync hooks for the four lifecycle events. `beforeStart` runs before plugins install, `afterStart` once the server is ready; `beforeShutdown` runs before plugins shut down, `afterShutdown` last. Hooks chain and multiple hooks per event run in registration order.

```typescript
import { WebApplication } from 'blendsdk/webafx';

const events: string[] = [];

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'ERROR' });

app
  .on('beforeStart', async () => {
    events.push('beforeStart'); // e.g. validate external dependencies
  })
  .on('afterStart', () => {
    events.push('afterStart'); // e.g. start background workers
  })
  .on('beforeShutdown', () => {
    events.push('beforeShutdown');
  })
  .on('afterShutdown', () => {
    events.push('afterShutdown');
  });

app.use({
  name: 'worker',
  factory: async () => ({
    shutdown: async () => {
      events.push('worker-plugin-shutdown');
    },
  }),
});

const shutdown = await app.start();
await shutdown();

console.log(events);
// [ 'beforeStart', 'afterStart', 'beforeShutdown', 'worker-plugin-shutdown', 'afterShutdown' ]
```

---

### Graceful Shutdown

`start()` returns a shutdown function and installs `SIGTERM`/`SIGINT` handlers automatically. `SHUTDOWN_TIMEOUT` (seconds, 0–300) bounds how long connections may drain before the process closes.

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'production',
  SHUTDOWN_TIMEOUT: 30, // seconds allowed for draining connections (0–300)
});

const shutdown = await app.start();

// start() installed SIGTERM / SIGINT handlers. When the process receives
// either signal (Ctrl+C, `docker stop`, Kubernetes pod termination) or you
// call shutdown(), the framework runs the graceful sequence:
//   1. beforeShutdown hooks
//   2. plugin shutdown hooks, singleton dispose hooks, connection draining
//   3. afterShutdown hooks
//   4. signal handlers are removed

await shutdown();

// Idempotent — a second call is a safe no-op.
await shutdown();

// Starting the same instance twice throws:
//   await app.start(); // → Error: Application already started
```

---

## Security

### CORS Configuration

Configure CORS globally in the application config: `CORS: false` disables it, `CORS: true` allows all origins with defaults, or pass an object for full control. Disallowed origins still receive a response — the middleware simply omits the CORS headers, and the browser blocks it.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'production',
  LOG_LEVEL: 'ERROR',
  CORS: {
    origin: ['https://app.example.com', 'https://admin.example.com'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-Total-Count'],
    credentials: true,
    maxAge: 7200,
  },
});

class HelloController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/hello')
        .handle(async (_req: Request, res: Response) => {
          res.setHeader('X-Total-Count', '1');
          this.ok(res, { message: 'Hello' });
        }),
    ];
  }
}

app.registerController('/api', HelloController);
const shutdown = await app.start();

// Allowed origin:
//   curl -i -H "Origin: https://app.example.com" http://localhost:3000/api/hello
//   → access-control-allow-origin: https://app.example.com
//   → access-control-allow-credentials: true
//   → access-control-expose-headers: X-Total-Count
//
// Disallowed origin — request succeeds, but no CORS headers are set:
//   curl -i -H "Origin: https://evil.example.com" http://localhost:3000/api/hello
//   → (no access-control-allow-origin header)
//
// Preflight:
//   curl -i -X OPTIONS -H "Origin: https://app.example.com" \
//     -H "Access-Control-Request-Method: GET" http://localhost:3000/api/hello
//   → 204 with access-control-allow-methods and access-control-max-age: 7200

await shutdown();
```

For pattern-based origins, pass a callback instead of a list:

```typescript fragment
CORS: {
  origin: (origin, callback) => {
    // Allow any subdomain of example.com (and requests without an Origin header).
    if (!origin || origin.endsWith('.example.com')) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
}
```

---

### Rate Limiting

`rateLimitMiddleware()` works globally on `app.express` or per route, accepts a custom `keyExtractor`, and emits `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers on every response. Exceeding the limit produces a `429` via `RateLimitError`.

```typescript
import { WebApplication, BaseController, rateLimitMiddleware } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production', LOG_LEVEL: 'ERROR' });

// Global limit — 100 requests per minute per IP address.
app.express.use(rateLimitMiddleware({ maxRequests: 100, windowMs: 60_000 }));

class SearchController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/search')
        .middleware(
          rateLimitMiddleware({
            maxRequests: 10,
            windowMs: 60_000,
            keyExtractor: (req: Request) => req.header('x-api-key') ?? req.ip ?? 'unknown',
          })
        )
        .handle(async (_req: Request, res: Response) => {
          this.ok(res, { results: ['a', 'b', 'c'] });
        }),
    ];
  }
}

app.registerController('/api', SearchController);
const shutdown = await app.start();

for (let attempt = 1; attempt <= 11; attempt += 1) {
  const response = await fetch('http://localhost:3000/api/search');
  console.log(attempt, response.status, response.headers.get('x-ratelimit-remaining'));
}
// 1..10 → 200 with remaining counting down from '9' to '0'
// 11    → 429 with remaining '0' and body:
//   { "success": false, "error": { "code": "RATE_LIMIT_EXCEEDED",
//                                  "message": "Rate limit exceeded", "statusCode": 429 } }

await shutdown();
```

Storage is in-memory — suitable for single-instance deployments. In a clustered setup, provide a shared (e.g. Redis-backed) limiter via a plugin instead.

---

### Default Security Headers

Helmet security headers are applied by default and `X-Powered-By` is removed — no configuration required.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production', LOG_LEVEL: 'ERROR' });

class HelloController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/hello')
        .handle(async (_req: Request, res: Response) => {
          this.ok(res, { message: 'Hello' });
        }),
    ];
  }
}

app.registerController('/api', HelloController);
const shutdown = await app.start();

const response = await fetch('http://localhost:3000/api/hello');
console.log({
  contentTypeOptions: response.headers.get('x-content-type-options'),        // 'nosniff'
  frameOptions: response.headers.get('x-frame-options'),                      // 'SAMEORIGIN'
  strictTransportSecurity: response.headers.get('strict-transport-security'), // 'max-age=31536000; includeSubDomains'
  poweredBy: response.headers.get('x-powered-by'),                            // null — header removed
});

await shutdown();
```

---

## Configuration

### ApplicationSettings: Typed Configuration

`ApplicationSettings` validates configuration with a Zod schema on construction (including constructor input), supports generic typed reads, and passes through custom keys. Omitted `ENV_MODE` defaults to `'production'` — secure by default.

```typescript
import { ApplicationSettings } from 'blendsdk/webafx';

const settings = new ApplicationSettings({
  PORT: 8080,
  ENV_MODE: 'development',
  LOG_LEVEL: 'INFO',
  SHUTDOWN_TIMEOUT: 15,
  CORS: { origin: 'http://localhost:5173', credentials: true },
  FEATURE_FLAG_NEW_UI: true, // custom properties are allowed
});

const port = settings.get<number>('PORT', 3000);     // 8080
const debug = settings.get<boolean>('DEBUG', false); // false
const isProduction = settings.isProduction();        // false
const config = settings.getAll();                    // shallow copy — safe to mutate

console.log({ port, debug, isProduction, config });
// { port: 8080, debug: false, isProduction: false, config: { ENV_MODE: 'development', ... } }

// Validation fails fast on construction:
try {
  new ApplicationSettings({ PORT: 70000 });
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message);
    // "Configuration validation failed:" followed by one line per invalid setting
  }
}
```

---

### Loading Configuration from a File

`loadFromFile()` merges an ESM config file over the initial configuration. Missing files are silently ignored (safe to call unconditionally); files that exist but fail to load or validate throw `Configuration file error: <path>`.

```typescript
// .env.local.js (project root) — export a default object or a named `config` export.
export default {
  PORT: 3100,
  ENV_MODE: 'development',
  LOG_LEVEL: 'DEBUG',
  CORS: { origin: 'http://localhost:5173' },
};
```

```typescript
import { ApplicationSettings } from 'blendsdk/webafx';

const settings = new ApplicationSettings({ PORT: 3000, ENV_MODE: 'production' });

// Missing files are ignored — safe to call unconditionally.
await settings.loadFromFile('.env.local.js');

settings.get<number>('PORT');     // 3100 — file values override constructor values
settings.get<string>('ENV_MODE'); // 'development'

// Log level normalization after loading: when LOG_LEVEL is not set anywhere,
// DEBUG=true or a non-production ENV_MODE upgrades it to 'DEBUG';
// otherwise it stays 'ERROR'.
```

---

## Logging & Observability

### ConsoleLogger: Levels and Prefixes

`ConsoleLogger` provides prefixed, leveled console output. The configured level is a threshold: `ERROR` (1) → `WARN` (2) → `INFO` (3) → `DEBUG` (4) — a message logs when its level is at or below the configured one. Errors go to `console.error`, everything else to `console.log`.

```typescript
import { ConsoleLogger } from 'blendsdk/webafx';

const logger = new ConsoleLogger('APP', 'INFO');

await logger.info('Server started', { port: 3000 });
await logger.warn('Cache miss', { key: 'users:42' });
await logger.error('Upstream timeout', { code: 'DB_TIMEOUT' });
await logger.debug('Suppressed at INFO level');

// [INFO:APP]: Server started - {"port":3000}
// [WARN:APP]: Cache miss - {"key":"users:42"}
// [ERROR:APP]: Upstream timeout - {"code":"DB_TIMEOUT"}
// (DEBUG is not printed — the configured level is the threshold)
```

When no explicit level is passed, the logger falls back to `process.env.LOG_LEVEL` (default `ERROR`). Framework-created loggers honor the same environment variables; setting `DEBUG=true` additionally enables debug messages.

---

### Structured JSON Logging

`StructuredLogger` emits one JSON object per line — ideal for log aggregators. An optional context function runs for every entry and merges its fields into the output (for example the current request ID). Install it as the application logger with `app.setLogger()`.

```typescript
import { StructuredLogger, WebApplication, getRequestId } from 'blendsdk/webafx';

const logger = new StructuredLogger('API', 'INFO', () => ({
  // The active request ID inside a request scope; null otherwise.
  requestId: getRequestId() ?? null,
}));

await logger.info('User signed in', { userId: 42 });
// {"timestamp":"2024-01-15T10:30:00.000Z","level":"INFO","prefix":"API","message":"User signed in","data":{"userId":42},"requestId":null}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'ERROR' });

// Replace the default ConsoleLogger — subsequent framework log calls use this logger.
app.setLogger(logger);
```

Calling `setLogger()` again replaces the logger — the last installed instance wins.

---

### Request IDs and Async Context

Every request receives a UUID stored in an `AsyncLocalStorage` context, so `getRequestId()` and `getRequestContext()` work anywhere in the async call chain — no need to pass the request around. The ID also echoes in the `X-Request-ID` response header; a valid UUID supplied in the incoming `X-Request-ID` header is reused for cross-service correlation, while malformed values are replaced.

```typescript
import { BaseController, WebApplication, getRequestContext, getRequestId } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class DiagnosticsController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/request-info')
        .handle(async (_req: Request, res: Response) => {
          const context = getRequestContext();

          this.ok(res, {
            requestId: getRequestId(),
            elapsedMs: context ? Date.now() - context.startTime : null,
          });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'ERROR' });
app.registerController('/api', DiagnosticsController);
const shutdown = await app.start();

const response = await fetch('http://localhost:3000/api/request-info');
console.log(response.headers.get('x-request-id'));
// '550e8400-e29b-41d4-a716-446655440000' (freshly generated)
console.log(JSON.stringify(await response.json(), null, 2));
// { "success": true, "data": { "requestId": "550e8400-...", "elapsedMs": 0 } }

// A valid UUID sent upstream is reused for correlation:
const correlated = await fetch('http://localhost:3000/api/request-info', {
  headers: { 'x-request-id': '9c1f0d5a-1a7b-4c3f-9d4e-8b2a6f1e0c11' },
});
console.log(JSON.stringify(await correlated.json(), null, 2));
// data.requestId is '9c1f0d5a-1a7b-4c3f-9d4e-8b2a6f1e0c11'

await shutdown();
```

Outside a request scope both functions return `undefined`.

---

## Static Files & SPA

### Serving Static Files with Cache Control

`staticFilesPlugin()` mounts a directory with `express.static()` under any URL prefix, with cache-control, dotfile policies, and startup validation of the root directory.

```typescript
import { WebApplication, staticFilesPlugin } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production', LOG_LEVEL: 'ERROR' });

app.use(
  staticFilesPlugin({
    root: './public',    // resolved against process.cwd()
    prefix: '/static',   // → http://localhost:3000/static/*
    maxAge: '1y',        // '1d' / '1h' / '30m' or milliseconds
    immutable: true,     // for hashed asset filenames, e.g. app.7f3c2a.js
    dotfiles: 'ignore',  // '.env' and friends pretend not to exist
  })
);

// The root directory is validated at startup — fail fast instead of serving nothing:
//   app.use(staticFilesPlugin({ root: './missing' }));
//   await app.start(); // → Error: Static files root directory does not exist: /.../missing

const shutdown = await app.start();

const asset = await fetch('http://localhost:3000/static/logo.svg');
console.log(asset.status);                       // 200
console.log(asset.headers.get('cache-control')); // 'public, max-age=31536000, immutable'

const hidden = await fetch('http://localhost:3000/static/.env');
console.log(hidden.status);                      // 404 (dotfiles ignored)

await shutdown();
```

The plugin installs at priority 20 by default; multiple instances must use distinct prefixes (each instance is named `static-files` or `static-files:<prefix>`).

---

### SPA Fallback Without Shadowing Routes

With `spa: true`, unmatched GET requests that look like page navigations are served `index.html` — via the plugin's terminal hook, after controllers and `/health`. Requests that look like files, non-GET requests, and non-HTML API calls fall through to the normal JSON 404.

```typescript
import { WebApplication, BaseController, staticFilesPlugin } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production', LOG_LEVEL: 'ERROR' });

// Real files are served by express.static; unmatched HTML routes fall back
// to index.html via the plugin's terminal hook.
app.use(staticFilesPlugin({ root: './client/build', spa: true }));

class ApiController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/users')
        .handle(async (_req: Request, res: Response) => {
          this.ok(res, [{ id: 1, name: 'Ada' }]);
        }),
    ];
  }
}

app.registerController('/api', ApiController);
const shutdown = await app.start();

// GET /app.js                                 → 200 — the built JS asset from ./client/build
// GET /api/users                              → 200 JSON from the controller
// GET /health (Accept: text/html)             → 200 JSON — never replaced by index.html
// GET /settings/profile (Accept: text/html)   → 200 index.html (client-side route)
// GET /missing.css                            → 404 (file request — no SPA fallback)
// GET /api/missing (Accept: application/json) → 404 JSON envelope

await shutdown();
```

---

## OpenAPI Metadata

### Documenting Routes for Codegen

`.openapi()` attaches metadata to a route and is the opt-in mechanism for API documentation: only annotated routes appear in generated specs. WebAFX carries the metadata; `blendsdk/codegen` performs the generation.

```typescript
import { BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';
import { z } from 'zod';

const productSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  price: z.number().nonnegative(),
});

class ProductsController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/:id')
        .openapi({
          summary: 'Get product by ID',
          description: 'Returns a single product. Used by the storefront and the admin console.',
          tags: ['products'],
          operationId: 'getProductById',
          deprecated: false,
          pathParams: {
            id: { schema: z.coerce.number().int(), description: 'Numeric product ID' },
          },
          responses: [
            { statusCode: 200, description: 'Product found', schema: productSchema },
            { statusCode: 404, description: 'Product not found' },
          ],
        })
        .handle(async (_req: Request, res: Response) => {
          this.ok(res, { id: 1, name: 'Espresso Machine', price: 249.0 });
        }),
    ];
  }
}

// Routes without .openapi() — internal endpoints, health probes, debug routes —
// are excluded from the generated specification entirely.
```

---

## Testing

### Integration Testing with Supertest

WebAFX's own suite tests applications with `vitest` + `supertest` against `app.express`. The pattern: create the app with `PORT: 0`, register routes, `await app.start()` to mount everything, and always await the shutdown function to clean up.

```typescript
import { afterEach, describe, expect, test } from 'vitest';
import supertest from 'supertest';
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class PingController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/ping')
        .handle(async (_req: Request, res: Response) => {
          this.ok(res, { pong: true });
        }),
    ];
  }
}

describe('Ping API', () => {
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = undefined;
    }
  });

  test('GET /api/ping returns pong', async () => {
    // PORT: 0 lets the OS pick a free port — ideal for parallel test runs.
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });
    app.registerController('/api', PingController);

    shutdown = await app.start();

    const response = await supertest(app.express).get('/api/ping').expect(200);

    expect(response.body).toEqual({ success: true, data: { pong: true } });
  });

  test('unknown routes return the standard 404 envelope', async () => {
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });
    app.registerController('/api', PingController);

    shutdown = await app.start();

    const response = await supertest(app.express).get('/api/missing').expect(404);

    expect(response.body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND', statusCode: 404 },
    });
  });
});
```

Because every `WebApplication` owns its own registries and server, multiple applications can start and stop in the same test process — or run in parallel — with no shared state.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
