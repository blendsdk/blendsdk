> **Package**: `blendsdk/webafx`

# webafx Best Practices

WebAFX rewards the framework's own conventions: controllers that respond through the shared envelope, services whose lifecycle matches their state, validation at the route boundary, and extension through plugins. The pairs below contrast the tempting shortcut with the supported pattern — each "wrong" example produces the stated failure. Import everything from the package root (`blendsdk/webafx`); `src/` and `dist/` paths are internals.

---

## Do / Don't Pairs

### 1. Keep request state in per-request services

#### ❌ Wrong

```typescript fragment
import { BaseController, type RouteDefinition } from 'blendsdk/webafx';

// ❌ The controller instance is created once at startup and reused for every
// request, so `items` is shared mutable state across concurrent users.
class CartController extends BaseController {
  private items: string[] = [];

  routes(): RouteDefinition[] {
    return [
      this.route()
        .post('/cart/:sku')
        .handle(async (req, res) => {
          this.items.push(req.params.sku);
          this.ok(res, { items: this.items });
        }),
    ];
  }
}
```

#### ✅ Correct

```typescript fragment
import { BaseController, WebApplication, type RouteDefinition } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000 });

app.registerService({
  name: 'cart',
  type: 'per-request',
  factory: () => ({ items: [] as string[] }),
});

// ✅ A fresh cart per request, resolved from the request's own container.
class CartController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .post('/cart/:sku')
        .handle(async (req, res) => {
          const cart = await req.services.get<{ items: string[] }>('cart');
          cart.items.push(req.params.sku);
          this.ok(res, { items: cart.items });
        }),
    ];
  }
}

app.registerController('/api', CartController);
```

**Why:** `setupControllers()` creates **one controller instance per application** and reuses it for every request, and `singleton` services are cached in the application-wide registry. Any mutable field on either is visible to all concurrent requests — one user's cart can appear in another user's response. A `per-request` service is created once per request (with `req`, `res`, and `next` available to its factory) and cached only inside that request's `ServiceContainer`. Reserve `singleton` for request-independent infrastructure such as a database pool.

---

### 2. Throw typed errors instead of hand-rolling error responses

#### ❌ Wrong

```typescript fragment
// ❌ A hand-rolled error body: no `code`, no `requestId` correlation, and the
// error never reaches the application logger.
this.route()
  .get('/orders/:id')
  .handle(async (req, res) => {
    const orders = await req.services.get<{
      find(id: string): Promise<{ id: string } | undefined>;
    }>('orders');

    const order = await orders.find(req.params.id);
    if (!order) {
      res.status(404).json({ success: false, error: { message: 'Order not found' } });
      return;
    }
    this.ok(res, order);
  });
```

#### ✅ Correct

```typescript fragment
import { NotFoundError } from 'blendsdk/webafx';

// ✅ Throwing an ApiError subclass: the central error handler logs it and
// renders the standard envelope with status, code, timestamp, and requestId.
this.route()
  .get('/orders/:id')
  .handle(async (req, res) => {
    const orders = await req.services.get<{
      find(id: string): Promise<{ id: string } | undefined>;
    }>('orders');

    const order = await orders.find(req.params.id);
    if (!order) {
      throw new NotFoundError('Order not found', { id: req.params.id });
    }
    this.ok(res, order);
  });
```

**Why:** the error handler serializes `ApiError` subclasses into the standard `{ success: false, error }` envelope with `code`, `message`, `statusCode`, `timestamp`, `requestId`, and `path`, logs them through the application logger, and strips stack traces outside development. Manual responses bypass all of that: clients cannot correlate failures with logs, monitoring sees no error, and the ad-hoc shape forces every consumer to special-case it. A plain `throw new Error('...')` becomes a generic `500 INTERNAL_SERVER_ERROR` — use an `ApiError` subclass whenever you know the correct status.

---

### 3. Mark routes secure and resolve the right principal

#### ❌ Wrong

```typescript fragment
// ❌ Nothing marks the route as secure: it is public, and the handler quietly
// returns `{ user: undefined }` to anonymous callers.
this.route()
  .get('/profile')
  .handle(async (req, res) => {
    const user = await req.services.get('user', undefined);
    this.ok(res, { user });
  });
```

#### ✅ Correct

```typescript fragment
// ✅ secure() makes the wrapper resolve the principal first: no principal,
// no handler — the request is rejected with a 401 envelope.
this.route()
  .get('/profile')
  .secure()
  .handle(async (req, res) => {
    const user = await req.services.get('user', undefined);
    this.ok(res, { user });
  });
```

```typescript fragment
// Machine clients authenticate against a separate principal service.
// Name the principal service (the auth plugin's `userServiceName`),
// not the provider singleton.
this.authenticated('client')
  .get('/export')
  .handle(this.exportData);
```

**Why:** a route is secure only when `secure` is `true` or names a service; omitting it silently leaves the route public. `secure()` (and the `authenticated()` shorthand) makes the route wrapper resolve the principal service once, throw `UnauthorizedError` (→ 401) when it is absent, and pass the same principal to `authorize()` for 403 decisions. A named principal must be the service that actually holds the principal; naming anything else — or a service that is not registered — fails closed with a 401 on every request instead of silently opening the route.

---

### 4. Validate at the route boundary and read the parsed input

#### ❌ Wrong

```typescript fragment
import { ValidationError } from 'blendsdk/webafx';

// ❌ Hand-rolled validation: rules drift from the client contract, error
// details use an ad-hoc shape, and coercions are applied case by case.
this.route()
  .post('/users')
  .handle(async (req, res) => {
    const { email, age } = req.body as { email?: string; age?: number };
    if (typeof email !== 'string' || !email.includes('@')) {
      throw new ValidationError('Validation failed', { email: 'Invalid email' });
    }
    const years = Number(age);
    if (!Number.isInteger(years) || years < 18) {
      throw new ValidationError('Validation failed', { age: 'Must be 18 or older' });
    }
    this.ok(res, { email, age: years });
  });
```

#### ✅ Correct

```typescript fragment
import { z } from 'zod';

// ✅ One schema drives validation (422 with field-level details), typing,
// and the OpenAPI metadata for the route.
const createUserSchema = z.object({
  email: z.string().email(),
  age: z.coerce.number().int().min(18),
});

this.route()
  .post('/users')
  .validate(createUserSchema)
  .handle(async (req, res) => {
    const { email, age } = req.services.getParams<z.infer<typeof createUserSchema>>();
    this.ok(res, { email, age });
  });
```

**Why:** `.validate()` runs before the handler; the framework parses the merged `params` + `query` + `body` and converts failures into a `422 VALIDATION_ERROR` whose `details` carry a `{ path, message, code }` entry per issue — no per-handler error plumbing. The parsed result (including `z.coerce` transforms) is stored in the container as `request-params` (merged) and `request-input` (separated), which is what `getParams()` and `getInput()` return. Reading raw `req.body` after validation discards those transforms, and merged input can collide keys across sources (`params.id` vs `body.id`) — use `getInput()` when you need the sources apart.

---

### 5. Treat configuration as the single source of truth

#### ❌ Wrong

```typescript fragment
// ❌ Scattered environment reads: no validation, inconsistent defaults, and
// the value can never be overridden by an ApplicationConfig in tests.
this.route()
  .get('/report')
  .handle(async (req, res) => {
    const limit = Number(process.env.REPORT_LIMIT ?? 100);
    const isDebug = process.env.DEBUG === 'true';
    this.ok(res, { limit, isDebug });
  });
```

#### ✅ Correct

```typescript fragment
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({
  PORT: 8080,
  REPORT_LIMIT: 100, // custom properties pass through the Zod schema
});

// Inside the controller:
this.route()
  .get('/report')
  .handle(async (req, res) => {
    const limit = this.settings.get<number>('REPORT_LIMIT', 100);
    this.ok(res, { limit, isDebug: !this.settings.isProduction() });
  });
```

**Why:** `ApplicationSettings` validates the standard keys at construction (for example `PORT` must be an integer between 0 and 65535), merges the optional `.env.js` / `.env.local.js` JavaScript config files at startup, and is shared with controllers and service factories. WebAFX never mutates `process.env` for configuration and does not read it to configure the application, so environment-based expectations silently disagree with the running server. One `ApplicationConfig` object per app also means tests can vary settings without touching global state.

---

### 6. Respond through the BaseController helpers

#### ❌ Wrong

```typescript fragment
// ❌ Ad-hoc response shape: clients (and SDKs generated from the OpenAPI
// metadata) can no longer rely on the standard envelope.
this.route()
  .post('/users')
  .handle(async (req, res) => {
    res.status(201).json({ user: { id: 'u_1', name: 'Ada' } });
  });
```

#### ✅ Correct

```typescript fragment
// ✅ Standard envelope: { success: true, data: ... } with the correct status.
this.route()
  .post('/users')
  .handle(async (req, res) => {
    this.created(res, { id: 'u_1', name: 'Ada' });
  });
```

**Why:** every helper produces the contract clients depend on: `ok()` → 200 `{ success: true, data }`, `created()` → 201, `noContent()` → a real 204 with an empty body, and `paginated()` → `{ success: true, data, pagination }` with `pages` computed from `total`/`limit`. Ad-hoc `res.json()` shapes force consumers — including generated clients and the `envelope: 'data'` default in route metadata — to special-case endpoints, and they break the symmetry with errors, which always arrive as `{ success: false, error }`.

---

### 7. Mark paginated responses with the `body` envelope

#### ❌ Wrong

```typescript fragment
// ❌ `listProducts` sends { success, data, pagination } via this.paginated(),
// but the metadata lets the generated client read only `data` (the default).
this.route()
  .get('/products')
  .openapi({ summary: 'List products' })
  .handle(this.listProducts);
```

#### ✅ Correct

```typescript fragment
// ✅ `envelope: 'body'` tells generated clients to keep the whole response,
// so `pagination` survives the round trip.
this.route()
  .get('/products')
  .openapi({ summary: 'List products', envelope: 'body' })
  .handle(this.listProducts);
```

**Why:** `.openapi()` metadata is consumed by `blendsdk/codegen`, and its default (`envelope: 'data'`) unwraps the top-level `data` property — correct for every plain `ok()`/`created()` route. A paginated route also carries `pagination`, so without `envelope: 'body'` the generated client silently drops it and pages cannot be traversed. Routes without `.openapi()` stay out of the generated spec; that opt-in is intentional, so only annotate what you want published.

---

### 8. Serve SPA fallbacks through the static files plugin — never a catch-all

#### ❌ Wrong

```typescript fragment
import path from 'node:path';
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000 });

// ❌ Mounted through app.express, this runs before every controller route and
// /health, so it swallows API endpoints that look like page navigations
// (GET /api/oidc/login) — and answers POSTs with index.html too.
app.express.use((req, res) => {
  res.sendFile(path.resolve('client/dist/index.html'));
});

await app.start();
```

#### ✅ Correct

```typescript fragment
import { WebApplication, staticFilesPlugin } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000 });

// ✅ The plugin serves real files immediately and defers the SPA fallback to
// the terminal phase — after controllers and /health, before the 404 handler.
app.use(staticFilesPlugin({
  root: './client/dist',
  spa: true,
}));

await app.start();
```

**Why:** the terminal plugin phase exists precisely so a catch-all cannot shadow controller routes. `staticFilesPlugin({ spa: true })` registers its fallback there and guards it three ways: only `GET` requests, only paths without a file extension, and only clients that accept `text/html`. Controllers (including OIDC-style login navigations) and `/health` always win; missing assets like `/styles.css` still 404, and JSON clients get a real 404 instead of an HTML page.

---

### 9. Install extension middleware through plugins, not `app.express`

#### ❌ Wrong

```typescript fragment
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000 });

// ❌ Middleware mounted via app.express before start() runs at the very front
// of the stack — before the body parsers and before req.services exists, so
// `req.body` is undefined here.
app.express.use((req, res, next) => {
  console.log('audit', req.method, req.path, req.body);
  next();
});

await app.start();
```

#### ✅ Correct

```typescript fragment
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000 });

// ✅ Plugin factories run AFTER the core middleware and the per-request
// service container, so parsed bodies and req.services are available.
// Lower priorities install first, making ordering explicit.
app.use({
  name: 'audit-log',
  priority: 10,
  factory: async ({ express }) => {
    express.use((req, res, next) => {
      console.log('audit', req.method, req.path, req.body);
      next();
    });
  },
});

await app.start();
```

**Why:** Express executes middleware in registration order, and `app.express.use()` calls made before `start()` land ahead of everything the framework installs during initialization — trust proxy, CORS, cookies, body parsers, request IDs, and Helmet. A middleware that needs parsed input, a request ID, or `req.services`, or that short-circuits with a response (missing security headers, since Helmet has not run yet), belongs in a plugin factory, which executes after the core stack in priority order. Keep `app.express` for the escape-hatch cases WebAFX does not model.

---

### 10. Rely on graceful shutdown instead of racing it

#### ❌ Wrong

```typescript fragment
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000 });
await app.start();

// ❌ A second SIGTERM handler races the framework's graceful shutdown:
// process.exit(0) aborts connection draining, so in-flight requests are
// dropped and singleton disposal / plugin shutdown hooks never run.
process.on('SIGTERM', () => process.exit(0));
```

#### ✅ Correct

```typescript fragment
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000, SHUTDOWN_TIMEOUT: 15 });

// Singletons support an optional dispose() callback that runs during
// graceful shutdown — release pools, clients, and timers there.
app.registerService({
  name: 'cache',
  type: 'singleton',
  factory: () => new Map<string, string>(),
});

// ✅ start() already installs SIGTERM/SIGINT handlers: stop accepting new
// connections, wait for in-flight requests (bounded by SHUTDOWN_TIMEOUT),
// dispose singletons, run plugin shutdown hooks, then afterShutdown hooks.
await app.start();
```

**Why:** `start()` registers its own signal handlers that drive a single-flight shutdown sequence — `server.close`, forced close of stragglers after `SHUTDOWN_TIMEOUT` seconds (1 second in development), `beforeShutdown` hooks, `disposeAll()` on singletons, plugin `shutdown()` hooks, and `afterShutdown` hooks — then removes the listeners. A competing `process.exit(0)` cuts that sequence short mid-drain. Long-running initialization belongs in `beforeStart`/`afterStart` hooks or service factories, not at module top level, and `start()` throws `Application already started` on a second call — capture the returned `shutdown()` function once.

---

## Anti-Patterns

### Reaching into framework internals

The package's own tests show the mistake: `supertest((app as any).expressApp)` and similar bracket-access to `protected` fields. Internals are not API — they can be renamed or restructured without notice.

```typescript fragment
import supertest from 'supertest';

// ❌ Protected field access — not part of the public API.
supertest(app['expressApp']);

// ✅ The public getter used for HTTP-level tests and escape-hatch middleware.
supertest(app.express);
```

### Duplicate plugin or service registration

Both registries reject duplicates immediately: `Plugin "static-files:/assets" is already registered`, `Service "alpha" is already registered`. This bites most often when two plugins that share a derived name (for example two `staticFilesPlugin` instances with the same `prefix`) are registered, or when a module is imported twice. Register once; for an intentional per-container replacement of a resolved instance, `container.set(name, instance)` is the supported override.

### Creating middleware instances per request

`rateLimitMiddleware()` and `csrfMiddleware()` build closure state — the rate limiter owns an in-memory `Map` and a cleanup interval. Created inside a handler or a per-request factory, every request gets a fresh store, so limits never accumulate and intervals keep piling up. Create them at module scope or inside `routes()`, which runs once at startup.

```typescript fragment
import { rateLimitMiddleware } from 'blendsdk/webafx';

// ✅ Created once when routes() runs during startup — one store, one policy.
this.route()
  .get('/api/search')
  .middleware(rateLimitMiddleware({ maxRequests: 10, windowMs: 60_000 }))
  .handle(this.search);
```

### Fire-and-forget `services.get()`

`get()` is async. Forgetting `await` yields a Promise, which is always truthy — the guard never fires.

```typescript fragment
// ❌ `user` is a Promise object — always truthy, even when unauthenticated.
const user = req.services.get('user', undefined);
if (!user) {
  throw new UnauthorizedError('Authentication required');
}
```

```typescript fragment
// ✅ Await first; the guard now sees the resolved principal or undefined.
const user = await req.services.get('user', undefined);
if (!user) {
  throw new UnauthorizedError('Authentication required');
}
```

The synchronous accessors (`getUser()`, `getParams()`, `getInput()`) only read values already stored in the container — they do not run factories. And per-request services throw when resolved outside a request (`Service "x" is per-request and can only be accessed during HTTP request handling`), so never resolve them from lifecycle hooks or at startup.

### Mutating `getAll()` snapshots

`getAll()` returns a **shallow** copy: assigning top-level keys is safe, but nested objects (for example the `CORS` configuration) are still the same references the application is using — mutating them changes live behavior at runtime. Treat the snapshot as read-only and read values with `get()`.

### Hand-built `RouteDefinition` objects

The `RouteBuilder` validates as it builds: `handle()` throws if the handler is not a function or if method/path are missing, and `secure('')` throws `secure() requires a non-empty user service name`. Definitions pushed straight into `routes()` skip all checks — and a blank `secure: ''` marks the route secure while resolving no principal, so every request fails closed with a 401 for no apparent reason. Use `this.route()` and `this.authenticated()` exclusively.

### Assuming registration order controls plugin install order

Plugins install in ascending `priority` (default `100`); ties keep registration order. If audit middleware must wrap auth middleware, give them explicit priorities (10 vs 50) instead of relying on the order of `app.use()` calls, which a refactor can silently break.

### Test apps that listen on real ports or never shut down

Every started application holds a server and process signal handlers; a forgotten `await shutdown()` leaves open handles and can hang the test run. The canonical shape:

```typescript fragment
const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });
const shutdown = await app.start();

// In afterEach:
await shutdown();
```

`PORT: 0` avoids port collisions, `ENV_MODE: 'test'` keeps stack traces on for debugging assertions, and `LOG_LEVEL: 'ERROR'` silences per-request logging. Because each `WebApplication` owns its own service registry, parallel test apps cannot leak state into each other — keep it that way by registering services per app, not at module scope.

### Using the deprecated `preparseServiceNames`

`preparseServiceNames()` emits a `[WebAFX DEPRECATION WARNING]` and patches static class properties at runtime. Replace it with a const object:

```typescript fragment
// ✅ Literal types, no runtime patching, no warning.
export const ServiceNames = {
  LOGGER: 'LOGGER',
  DATABASE: 'DATABASE',
} as const;
```

---

## Performance Tips

### Match service lifecycle to cost

| Lifecycle | Factory runs | Shared with | Use for |
|-----------|--------------|-------------|---------|
| `singleton` | Once, at first resolution | Every request and container | Pools, HTTP clients, caches |
| `per-request` | Once per request | Only that request's container | Auth principal, request state |

A singleton's instance is stored in `registry.singletons` and reused by every container, so expensive setup (connection pools, warmed caches) happens exactly once; `await get()` afterwards is a cache hit. Per-request factories execute on every request — keep them to cheap object assembly. Give singletons a `dispose()` callback so graceful shutdown releases their resources instead of leaking pools and timers across deploys.

### Prefer `settings.get()` over `settings.getAll()` on the hot path

`getAll()` allocates a new object on every call, while `get('PORT')` is a direct property read. In per-request code, use `get()` — or resolve configuration values once and pass them along.

### Define Zod schemas once, at module scope

`routes()` is invoked once during startup, so a schema constant referenced there is built once. A schema literal created inside a `handle` callback is rebuilt on every request, and the same constants can be referenced again from `.openapi()` response metadata instead of defining the shape twice.

### Cache static assets aggressively — with hashed filenames

Browser caching is the largest possible offload for SPA bundles. `staticFilesPlugin({ root, maxAge: '1y', immutable: true })` lets clients serve repeat requests without revalidation — safe only for content-hashed filenames (`main.abc123.js`) that change when content changes. Express's `etag` and `lastModified` defaults (both on) already handle revalidation for everything else.

### Pick the right logger and level for production

Both loggers check the level before formatting output, but the `data` payload you pass is still built at the call site, and `StructuredLogger` JSON-serializes every emitted entry. Per-request timing logs fire through the standard logger, so `DEBUG` in production means constant serialization and noise. Use `StructuredLogger` with INFO/WARN when logs are aggregated, and ERROR-level console output otherwise; swap implementations with `app.setLogger()` from a plugin.

### Reuse rate-limiter instances and know their scope

Each `rateLimitMiddleware()` call owns a store and a cleanup interval (unref'd, so it will not hold the process open). One instance attached to several routes shares a single bucket — usually the intent for an API-wide quota; a separate instance per route creates independent buckets. Be deliberate about which you want, and remember the store is per process: behind N replicas the effective allowance is N × `maxRequests` unless a shared (Redis-backed) store fronts it — see the security notes.

---

## Security Considerations

### Configure `TRUST_PROXY` for your actual topology

`TRUST_PROXY` defaults to `true`, which sets Express `trust proxy` to 1 hop. That is correct behind exactly one trusted reverse proxy or load balancer — and wrong when the app is directly reachable, because a client-supplied `X-Forwarded-For` can then determine `req.ip`. Since `req.ip` keys rate limiting and appears in logs, spoofing defeats per-IP limits and poisons audit trails. Set `TRUST_PROXY: false` when nothing fronts the app.

### Protect cookie-authenticated mutations with CSRF

Cookies are attached by the browser automatically, so any site can trigger a mutating request against a cookie-authenticated endpoint. Register CSRF protection application-wide (the plugin installs before controllers) or per route:

| Mode | Option | Strength |
|------|--------|----------|
| Session-bound | `expectedToken` | Strong — token derived from the authenticated session |
| Double-submit cookie | `cookie: { name }` | Defence in depth — unsigned, not session-bound |
| Neither | — | Fails closed: every mutating request is rejected |

```typescript fragment
import { csrfPlugin } from 'blendsdk/webafx';
import type { Request } from 'express';

interface Session {
  csrfToken: string;
}

const sessions = new Map<string, Session>();

const loadSession = (req: Request): Session | undefined => {
  const id = req.cookies['session'] as string | undefined;
  return id ? sessions.get(id) : undefined;
};

app.use(
  csrfPlugin({
    expectedToken: (req) => loadSession(req)?.csrfToken,
  })
);
```

Safe methods (`GET`, `HEAD`, `OPTIONS`) pass through, and the tokens are compared in constant time. Keep `exempt` entries to exact `"METHOD /path"` strings (such as pre-auth webhooks) — they are matched precisely, so a broad exemption cannot be created by accident.

### Keep production error hygiene — and keep secrets out of `details`

`ENV_MODE` drives `includeStack`: production strips stack traces and replaces unknown-error messages with `Internal Server Error`, while every other mode includes them. Running production with a development `ENV_MODE` "to debug" leaks internals to clients — debug through logs using the `requestId` that appears in both responses and log entries. Note that `ApiError.details` is always serialized to the client: pass identifiers, never credentials, tokens, or full records. The same rule applies to log payloads.

### Add your own Content-Security-Policy

Helmet is enabled with sensible defaults, but WebAFX deliberately disables `contentSecurityPolicy` and `crossOriginEmbedderPolicy` so applications can define them. That means there is no CSP unless you add one — mount your own CSP middleware (for example in a plugin factory) sized to the SPA and API you serve.

### Rate-limit credential endpoints — with a shared store if you scale out

Apply `rateLimitMiddleware()` to login, token, and password-reset endpoints, not just broadly. The built-in store is in-memory and per process: on N replicas each process allows `maxRequests`, so the effective limit multiplies; for anything security-critical, back it with a shared store (Redis) — the middleware's `keyExtractor` contract makes a drop-in replacement straightforward. When keying by `req.ip`, correctness depends on the `TRUST_PROXY` setting above, or all clients behind a proxy share one bucket.

### Get CORS-with-credentials right

`CORS: true` uses a wildcard origin, which browsers refuse to combine with credentials — fine for public, cookie-less APIs but useless for cookie-auth flows. Enumerate exact origins instead:

```typescript fragment
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({
  PORT: 3000,
  CORS: {
    origin: ['https://app.example.com'],
    credentials: true,
  },
});
```

With credentials enabled, any origin on the list can read authenticated responses, so keep the list tight and never reflect arbitrary request origins.

### Validate and bound all input

Route inputs go through `.validate()` before handlers run, static file serving defaults to `dotfiles: 'ignore'`, and `BODY_LIMIT` (default `'10mb'`) caps payload sizes. For a JSON API, lower `BODY_LIMIT` to what your largest legitimate payload needs — a smaller limit means rejected bodies cost less parsing and memory before your code ever runs.

---

# webafx Testing Patterns

This guide shows how to test applications built on WebAFX. All patterns mirror the package's own Vitest + supertest suite: applications are started on an ephemeral port (`PORT: 0`) and driven through `supertest(app.express)` against the real middleware pipeline — no internal mocks of Express required.

---

## Test Setup

WebAFX tests need no Docker containers and no external services: the rate limiter is in-memory, request IDs are generated in-process, and static-file tests use temporary directories on disk. The entire application pipeline (middleware, plugins, controllers, error handling) runs in the test worker.

### Installing test dependencies

Install the runtime packages once (WebAFX ships inside the `blendsdk` umbrella package; `express` and `zod` are its peer dependencies), plus the test tooling:

```bash
npm install blendsdk express zod

npm install --save-dev vitest supertest @types/supertest @types/express @vitest/coverage-v8
```

### Vitest configuration

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Restore console spies and env stubs automatically between tests
    restoreMocks: true,
    unstubEnvs: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
});
```

TypeScript strict mode applies to test files as well:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src", "tests"]
}
```

Package scripts that match the WebAFX convention:

```json
{
  "scripts": {
    "test": "vitest run --reporter=verbose",
    "test:watch": "vitest watch --reporter=verbose",
    "test:coverage": "vitest run --coverage"
  }
}
```

### Recommended test layout

```
tests/
  helpers.ts          # shared helpers (below)
  app.test.ts         # lifecycle, plugins, health
  routes.test.ts      # controllers, validation, auth
  middleware.test.ts  # CORS, CSRF, rate limiting
  static.test.ts      # static files and SPA fallback
```

### Shared test helpers

Create one helper module that starts a fully configured application per test. This is the single most valuable pattern in the suite — every test gets an isolated app instance (each `WebApplication` owns its own plugin, controller, and service registries, so nothing leaks between tests).

```typescript
// tests/helpers.ts
import supertest from 'supertest';
import { BaseController, WebApplication } from 'blendsdk/webafx';
import type {
  ApplicationConfig,
  ApplicationSettings,
  PluginDefinition,
  ServiceContainer,
  ServiceDefinition,
} from 'blendsdk/webafx';

/** Constructor signature shared by every controller registered with WebApplication. */
export type TestControllerClass = new (
  settings: ApplicationSettings,
  services: ServiceContainer
) => BaseController;

export interface TestAppOptions {
  /** Configuration merged over the test defaults (PORT 0, test environment, quiet logs). */
  config?: ApplicationConfig;
  /** Services registered before startup. */
  services?: ServiceDefinition[];
  /** Plugins installed before startup. */
  plugins?: PluginDefinition[];
  /** Controllers registered before startup. */
  controllers?: Array<{ basePath: string; ControllerClass: TestControllerClass }>;
}

export interface TestApp {
  app: WebApplication;
  agent: supertest.Agent;
  shutdown: () => Promise<void>;
}

/**
 * Starts a real WebApplication on an ephemeral port and returns a supertest
 * agent plus the shutdown function. Always `await shutdown()` when done — the
 * function is idempotent, so a blanket afterEach hook is safe.
 */
export async function startTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const app = new WebApplication({
    PORT: 0,
    ENV_MODE: 'test',
    LOG_LEVEL: 'ERROR',
    ...options.config,
  });

  for (const service of options.services ?? []) {
    app.registerService(service);
  }
  for (const plugin of options.plugins ?? []) {
    app.use(plugin);
  }
  for (const { basePath, ControllerClass } of options.controllers ?? []) {
    app.registerController(basePath, ControllerClass);
  }

  const shutdown = await app.start();
  const agent = supertest.agent(app.express);

  return { app, agent, shutdown };
}
```

| Helper option | Purpose |
|---------------|---------|
| `config` | Overrides merged over `{ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' }` — e.g. `{ ENABLE_FEATURE: true }` or `{ ENV_MODE: 'production' }` |
| `services` | `ServiceDefinition[]` registered before startup (singletons, per-request factories, `dispose` hooks) |
| `plugins` | `PluginDefinition[]` installed in ascending `priority` order |
| `controllers` | Controllers mounted at the given `basePath` |
| `agent` | `supertest.Agent` bound to `app.express` (keeps cookies between requests) |
| `shutdown` | Graceful shutdown: drains connections, disposes singletons, shuts down plugins |

### Test conventions

- **Always start the app** — `app.start()` runs the full initialization (middleware, plugins, controllers, `/health`, terminal phase, 404 and error handlers). Calling `supertest(app.express)` without starting skips all of it.
- **Use `PORT: 0`** — the OS assigns a random free port, so parallel test files never collide.
- **Use `LOG_LEVEL: 'ERROR'`** — keeps the verbose per-request logging out of test output.
- **Shut down in `afterEach`** — an un-stopped app keeps sockets and signal handlers alive inside the worker.
- **Prefer real instances over mocks** — WebAFX is deterministic in-process; per-app registries give you isolation for free.

### Which surface to test at which level

| WebAFX surface | Recommended level | Section |
|----------------|-------------------|---------|
| `ApplicationSettings`, `RouteBuilder`, error classes | Unit | Unit Testing |
| `ServiceContainer` lifecycles | Unit + integration | Unit Testing, Services and Dependency Injection |
| Controllers & response helpers | Integration (supertest) | Controllers and Response Envelopes |
| CORS, CSRF, rate limiting | Integration (supertest) | CORS, CSRF Protection, Rate Limiting |
| Plugins, terminals, `/health` | Integration | Plugins |
| Loggers | Unit with console spies | Logging and Observability |
| Request context | Unit + integration | Request Context |
| Static files & SPA fallback | Integration with temp-dir fixtures | Static Files and SPA Fallback |
| Lifecycle hooks & shutdown | Integration | Lifecycle Hooks and Graceful Shutdown |

---

## Unit Testing

Pure classes and utilities can be tested directly, without starting a server. Keep this level focused on validation rules, builders, error contracts, and container behavior — route handlers and middleware belong in integration tests.

### Synchronous unit tests: ApplicationSettings

```typescript
// tests/settings.test.ts
import { describe, expect, it } from 'vitest';
import { ApplicationSettings } from 'blendsdk/webafx';

describe('ApplicationSettings', () => {
  it('defaults to production for secure-by-default behavior', () => {
    const settings = new ApplicationSettings();

    expect(settings.get('ENV_MODE')).toBe('production');
    expect(settings.isProduction()).toBe(true);
  });

  it('applies the provided configuration', () => {
    const settings = new ApplicationSettings({
      PORT: 3000,
      ENV_MODE: 'development',
      DEBUG: true,
    });

    expect(settings.get<number>('PORT')).toBe(3000);
    expect(settings.isProduction()).toBe(false);
  });

  it('returns defaults for missing keys', () => {
    const settings = new ApplicationSettings();

    expect(settings.get('PORT')).toBeUndefined();
    expect(settings.get<number>('PORT', 4000)).toBe(4000);
  });

  it('rejects out-of-range PORT values', () => {
    expect(() => new ApplicationSettings({ PORT: -1 })).toThrow(
      /Configuration validation failed/
    );
    expect(() => new ApplicationSettings({ PORT: 70000 })).toThrow(
      /Configuration validation failed/
    );
    expect(() => new ApplicationSettings({ PORT: 3.14 })).toThrow(
      /Configuration validation failed/
    );
  });

  it('allows custom passthrough properties', () => {
    const settings = new ApplicationSettings({ CUSTOM_API_KEY: 'secret' });

    expect(settings.get<string>('CUSTOM_API_KEY')).toBe('secret');
  });

  it('returns a defensive copy from getAll()', () => {
    const settings = new ApplicationSettings({ PORT: 3000 });
    const config = settings.getAll();

    config.PORT = 5000;

    expect(settings.get('PORT')).toBe(3000);
  });

  it('lists every failing field in the validation error', () => {
    let message = '';
    try {
      new ApplicationSettings({ PORT: -1, SHUTDOWN_TIMEOUT: 500 });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toContain('PORT');
    expect(message).toContain('SHUTDOWN_TIMEOUT');
  });
});
```

### Synchronous unit tests: RouteBuilder

```typescript
// tests/route-builder.test.ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RouteBuilder } from 'blendsdk/webafx';

/** Handlers are exercised in integration tests; here only the definition matters. */
const noop = async () => {};

describe('RouteBuilder', () => {
  it('records method, path, and handler', () => {
    const route = new RouteBuilder().get('/users/:id').handle(noop);

    expect(route.method).toBe('get');
    expect(route.path).toBe('/users/:id');
    expect(route.handler).toBe(noop);
  });

  it('stores secure() with the default principal service', () => {
    const route = new RouteBuilder().get('/me').secure().handle(noop);

    expect(route.secure).toBe(true);
  });

  it('stores a named principal service', () => {
    const route = new RouteBuilder().get('/export').secure('client').handle(noop);

    expect(route.secure).toBe('client');
  });

  it('rejects a blank principal service name', () => {
    expect(() => new RouteBuilder().get('/me').secure('   ')).toThrow(
      'secure() requires a non-empty user service name'
    );
  });

  it('attaches a Zod validation schema', () => {
    const schema = z.object({ name: z.string() });

    const route = new RouteBuilder().post('/users').validate(schema).handle(noop);

    expect(route.validation).toBe(schema);
  });

  it('collects middleware in call order', () => {
    const first = (_req: unknown, _res: unknown, next: () => void) => next();
    const second = (_req: unknown, _res: unknown, next: () => void) => next();

    const route = new RouteBuilder()
      .get('/admin')
      .middleware(first)
      .middleware(second)
      .handle(noop);

    expect(route.middleware).toEqual([first, second]);
  });

  it('records OpenAPI metadata, including the response envelope', () => {
    const route = new RouteBuilder()
      .get('/products')
      .openapi({ summary: 'List products', tags: ['products'], envelope: 'body' })
      .handle(noop);

    expect(route.openapi?.summary).toBe('List products');
    expect(route.openapi?.tags).toEqual(['products']);
    expect(route.openapi?.envelope).toBe('body');
  });

  it('throws when the method or path is missing', () => {
    expect(() => new RouteBuilder().handle(noop)).toThrow('Route method must be set');
  });
});
```

### Synchronous unit tests: error classes

```typescript
// tests/errors.test.ts
import { describe, expect, it } from 'vitest';
import {
  ApiError,
  BadRequestError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from 'blendsdk/webafx';

describe('HTTP error classes', () => {
  it('carries status, code, message, and details', () => {
    const error = new BadRequestError('Invalid input', { field: 'email' });

    expect(error).toBeInstanceOf(ApiError);
    expect(error.name).toBe('BadRequestError');
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toBe('Invalid input');
    expect(error.details).toEqual({ field: 'email' });
  });

  it('serializes to the standard error envelope', () => {
    const error = new NotFoundError('User not found');
    const json = error.toJSON();

    expect(json).toMatchObject({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'User not found',
        statusCode: 404,
        timestamp: expect.any(String),
      },
    });
  });

  it('exposes the documented code per subclass', () => {
    expect(new RateLimitError().code).toBe('RATE_LIMIT_EXCEEDED');
    expect(new ValidationError().code).toBe('VALIDATION_ERROR');
  });
});
```

### Asynchronous unit tests: ServiceContainer

`ServiceContainer` is public API and can be driven directly with a fresh `ServiceRegistry` — perfect for lifecycle rules that are awkward to provoke over HTTP (circular dependencies, defaults, per-request guards).

```typescript
// tests/service-container.test.ts
import { describe, expect, it } from 'vitest';
import { ApplicationSettings, ServiceContainer } from 'blendsdk/webafx';
import type { ServiceDefinition, ServiceRegistry } from 'blendsdk/webafx';

function createContainer(): ServiceContainer {
  const registry: ServiceRegistry = { definitions: {}, singletons: {} };
  return new ServiceContainer(registry, new ApplicationSettings());
}

describe('ServiceContainer', () => {
  it('resolves a singleton once and caches it', async () => {
    const container = createContainer();
    let factoryCalls = 0;

    container.registerService({
      name: 'cache',
      type: 'singleton',
      factory: () => {
        factoryCalls += 1;
        return { hits: 0 };
      },
    });

    const first = await container.get<{ hits: number }>('cache');
    const second = await container.get<{ hits: number }>('cache');

    expect(factoryCalls).toBe(1);
    expect(first).toBe(second);
  });

  it('resolves dependencies before the dependent service', async () => {
    const container = createContainer();
    const order: string[] = [];

    container.registerService({
      name: 'database',
      type: 'singleton',
      factory: () => {
        order.push('database');
        return { connected: true };
      },
    });

    container.registerService({
      name: 'repository',
      type: 'singleton',
      dependencies: ['database'],
      factory: async (c: ServiceContainer) => {
        order.push('repository');
        const database = await c.get<{ connected: boolean }>('database');
        return { database };
      },
    });

    const repository = await container.get<{ database: { connected: boolean } }>('repository');

    expect(order).toEqual(['database', 'repository']);
    expect(repository.database.connected).toBe(true);
  });

  it('detects circular dependencies', async () => {
    const container = createContainer();

    const definition = (name: string, dependency: string): ServiceDefinition => ({
      name,
      type: 'singleton',
      dependencies: [dependency],
      factory: () => ({ name }),
    });

    container.registerService(definition('a', 'b'));
    container.registerService(definition('b', 'a'));

    await expect(container.get('a')).rejects.toThrow(/Circular dependency detected/);
  });

  it('rejects duplicate service names', () => {
    const container = createContainer();
    const definition: ServiceDefinition = {
      name: 'cache',
      type: 'singleton',
      factory: () => ({ hits: 0 }),
    };

    container.registerService(definition);

    expect(() => container.registerService(definition)).toThrow(
      'Service "cache" is already registered'
    );
  });

  it('throws for unregistered services and returns defaults when provided', async () => {
    const container = createContainer();

    await expect(container.get('missing')).rejects.toThrow(
      'Service "missing" is not registered'
    );
    await expect(container.get('missing', 'fallback')).resolves.toBe('fallback');
  });

  it('rejects per-request services outside a request', async () => {
    const container = createContainer();

    container.registerService({
      name: 'current-user',
      type: 'per-request',
      factory: () => ({ id: 1 }),
    });

    await expect(container.get('current-user')).rejects.toThrow(
      'Service "current-user" is per-request and can only be accessed during HTTP request handling'
    );
  });

  it('disposes resolved singletons', async () => {
    const container = createContainer();
    const disposed: string[] = [];

    container.registerService({
      name: 'pool',
      type: 'singleton',
      factory: () => ({ open: true }),
      dispose: () => {
        disposed.push('pool');
      },
    });

    await container.get('pool');
    await container.disposeAll();

    expect(disposed).toEqual(['pool']);
  });
});
```

### Unit testing consumer logic

Keep controllers thin and push business logic into plain services or functions — those are the cheapest units to test:

```typescript
// tests/pricing.test.ts
import { describe, expect, it } from 'vitest';

interface CartLine {
  unitPrice: number;
  quantity: number;
}

export class PricingService {
  total(lines: CartLine[]): number {
    return lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  }
}

describe('PricingService', () => {
  it('sums line totals', () => {
    const pricing = new PricingService();

    expect(pricing.total([{ unitPrice: 10, quantity: 2 }])).toBe(20);
    expect(pricing.total([{ unitPrice: 10, quantity: 2 }, { unitPrice: 5, quantity: 1 }])).toBe(25);
  });

  it('returns zero for an empty cart', () => {
    expect(new PricingService().total([])).toBe(0);
  });
});
```

Inject the tested service into the application via `registerService` and cover the HTTP wiring in an integration test.

---

## Integration Testing

Integration tests exercise the real pipeline: core middleware, plugins, controllers, validation, error handling, and the terminal phase. Start a fresh app per test (or per describe block for read-only apps) and drive it with supertest.

### The canonical lifecycle pattern

```typescript
// tests/users.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { startTestApp } from './helpers.js';
import type { TestApp } from './helpers.js';

class UserController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/users/:id')
        .handle(async (req, res) => {
          this.ok(res, { id: req.params.id, name: `User ${req.params.id}` });
        }),
      this.route()
        .post('/users')
        .handle(async (req, res) => {
          this.created(res, { id: 'u-1', input: req.body });
        }),
    ];
  }
}

describe('Users API', () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    if (testApp) {
      await testApp.shutdown();
      testApp = undefined;
    }
  });

  it('returns a single user with the success envelope', async () => {
    testApp = await startTestApp({
      controllers: [{ basePath: '/api', ControllerClass: UserController }],
    });

    const res = await testApp.agent.get('/api/users/7').expect(200);

    expect(res.body).toEqual({
      success: true,
      data: { id: '7', name: 'User 7' },
    });
  });

  it('echoes the request body on creation with status 201', async () => {
    testApp = await startTestApp({
      controllers: [{ basePath: '/api', ControllerClass: UserController }],
    });

    const res = await testApp.agent
      .post('/api/users')
      .send({ name: 'Ada' })
      .expect(201);

    expect(res.body).toEqual({
      success: true,
      data: { id: 'u-1', input: { name: 'Ada' } },
    });
  });

  it('returns the standard 404 envelope for unknown routes', async () => {
    testApp = await startTestApp({
      controllers: [{ basePath: '/api', ControllerClass: UserController }],
    });

    const res = await testApp.agent.get('/api/nope').expect(404);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('reports application health', async () => {
    testApp = await startTestApp();

    const res = await testApp.agent.get('/health').expect(200);

    expect(res.body).toEqual({ health: true, timestamp: expect.any(Number) });
  });
});
```

### Fixed-port variants

Use `PORT: 0` in almost all cases. Switch to a fixed port only when something outside the test process must reach the server:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import type { TestApp } from './helpers.js';

describe('external-client smoke test', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    // A fixed port (e.g. 4100) is only needed when the client connects
    // over the network instead of through supertest's in-process agent.
    testApp = await startTestApp({ config: { PORT: 4100 } });
  });

  afterAll(async () => {
    await testApp.shutdown();
  });

  it('answers /health', async () => {
    const res = await testApp.agent.get('/health').expect(200);
    expect(res.body.health).toBe(true);
  });
});
```

For read-only apps that are expensive to build, share one instance with `beforeAll`/`afterAll` as shown above. Otherwise, prefer a fresh app per test — shutdown is fast and isolation is automatic because every `WebApplication` owns its plugin, controller, and service registries.

---

## Mocking & Stubbing

WebAFX is deliberately injection-friendly: configuration, services, plugins, and the logger are all replaceable, so most tests need no module mocking at all. Reserve mocks for the boundaries you do not control — the console and `process.env`.

### Spying on console output

Both built-in loggers write to `console.log` (WARN/INFO/DEBUG) and `console.error` (ERROR). Spy on them to assert logging behavior:

```typescript
// tests/logging-spies.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleLogger } from 'blendsdk/webafx';

describe('ConsoleLogger output', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('logs warnings to console.log and errors to console.error', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const logger = new ConsoleLogger('Worker', 'WARN');

    await logger.warn('Queue is slow');
    await logger.error('Queue is down');

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ERROR:WORKER]: Queue is down')
    );
  });
});
```

With `restoreMocks: true` and `unstubEnvs: true` in `vitest.config.ts`, the `afterEach` cleanup is automatic — include it explicitly only if you do not set those options.

### Stubbing environment variables

`ConsoleLogger` and `StructuredLogger` fall back to `process.env.LOG_LEVEL` and honor `process.env.DEBUG`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { ConsoleLogger } from 'blendsdk/webafx';

describe('environment-driven configuration', () => {
  it('reads LOG_LEVEL from the environment when no level is passed', async () => {
    vi.stubEnv('LOG_LEVEL', 'warn');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new ConsoleLogger('Worker');

    await logger.warn('Emitted');
    await logger.info('Suppressed');

    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('treats an unknown LOG_LEVEL as ERROR-only', async () => {
    vi.stubEnv('LOG_LEVEL', 'VERBOSE');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const logger = new ConsoleLogger('Worker');

    await logger.info('Suppressed');
    await logger.error('Visible');

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
```

### Swapping the application logger

`app.setLogger()` replaces the default `ConsoleLogger` — the exact hook logger plugins use. A typed mock `Logger` verifies the wiring without touching console output:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { WebApplication } from 'blendsdk/webafx';
import type { Logger } from 'blendsdk/webafx';

function createMockLogger() {
  return {
    info: vi.fn(async (_message: string) => {}),
    warn: vi.fn(async (_message: string) => {}),
    error: vi.fn(async (_message: string) => {}),
    debug: vi.fn(async (_message: string) => {}),
  } satisfies Logger;
}

describe('setLogger', () => {
  it('routes framework logs through the replacement logger', async () => {
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'INFO' });
    const logger = createMockLogger();
    app.setLogger(logger);

    const shutdown = await app.start();
    expect(logger.info).toHaveBeenCalled();

    await shutdown();
  });
});
```

### Replacing services with test doubles

Instead of mocking modules, register predictable doubles in the container:

```typescript
// typescript fragment — inside a test
testApp = await startTestApp({
  services: [
    {
      name: 'email-client',
      type: 'singleton',
      factory: () => ({
        send: async (_to: string, _subject: string) => ({ queued: true }),
      }),
    },
  ],
  controllers: [{ basePath: '/api', ControllerClass: NotificationController }],
});
```

For request-dependent behavior (authentication, tenancy), use a `per-request` factory that derives the double from headers — see [Authentication and Principal Selection](#authentication-and-principal-selection).

### Mocking rules of thumb

- **Do not hand-mock `req`/`res`** for route or middleware tests — start a real app and use supertest. The pipeline is fast and deterministic.
- **Do not `vi.mock()` WebAFX internals** — everything a consumer touches (config, services, plugins, logger) is injectable.
- **No global state resets needed** — per-app registries isolate parallel test files.
- **Use `vi.fn()` for hook spies** — e.g. `app.on('beforeStart', hookSpy)` to assert hook invocation counts.

---

## Test Patterns by Feature

### Controllers and Response Envelopes

Every response helper (`ok`, `created`, `paginated`, `noContent`) has a fixed contract — assert the full envelope:

```typescript
// tests/controllers.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { startTestApp } from './helpers.js';
import type { TestApp } from './helpers.js';

class ProductController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/products')
        .handle(async (_req, res) => {
          this.paginated(res, [{ id: 1 }, { id: 2 }], 42, 1, 2);
        }),
      this.route()
        .post('/products')
        .handle(async (_req, res) => {
          this.created(res, { id: 3, name: 'Keyboard' });
        }),
      this.route()
        .get('/status')
        .handle(async (_req, res) => {
          this.ok(res, { status: 'ok' });
        }),
      this.route()
        .delete('/products/:id')
        .handle(async (_req, res) => {
          this.noContent(res);
        }),
    ];
  }
}

describe('ProductController', () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    if (testApp) {
      await testApp.shutdown();
      testApp = undefined;
    }
  });

  it('wraps list responses with pagination metadata', async () => {
    testApp = await startTestApp({
      controllers: [{ basePath: '/api', ControllerClass: ProductController }],
    });

    const res = await testApp.agent.get('/api/products').expect(200);

    expect(res.body).toEqual({
      success: true,
      data: [{ id: 1 }, { id: 2 }],
      pagination: { total: 42, page: 1, limit: 2, pages: 21 },
    });
  });

  it('returns 201 with the success envelope for created resources', async () => {
    testApp = await startTestApp({
      controllers: [{ basePath: '/api', ControllerClass: ProductController }],
    });

    const res = await testApp.agent.post('/api/products').expect(201);

    expect(res.body).toEqual({
      success: true,
      data: { id: 3, name: 'Keyboard' },
    });
  });

  it('returns an empty 204 for deletions', async () => {
    testApp = await startTestApp({
      controllers: [{ basePath: '/api', ControllerClass: ProductController }],
    });

    const res = await testApp.agent.delete('/api/products/3').expect(204);

    expect(res.text).toBe('');
  });
});
```

### Request Validation

Zod failures become `422 VALIDATION_ERROR` responses with per-field details. Cover both the happy path and the failure shape:

```typescript
// tests/validation.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { startTestApp } from './helpers.js';
import type { TestApp } from './helpers.js';

const createProductSchema = z.object({
  name: z.string().min(1),
  price: z.number().positive(),
});

class ProductController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .post('/products')
        .validate(createProductSchema)
        .handle(async (req, res) => {
          const input = req.services.getParams<{ name: string; price: number }>();
          this.created(res, input);
        }),
    ];
  }
}

describe('request validation', () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    if (testApp) {
      await testApp.shutdown();
      testApp = undefined;
    }
  });

  it('passes validated input to the handler', async () => {
    testApp = await startTestApp({
      controllers: [{ basePath: '/api', ControllerClass: ProductController }],
    });

    const res = await testApp.agent
      .post('/api/products')
      .send({ name: 'Keyboard', price: 99 })
      .expect(201);

    expect(res.body).toEqual({
      success: true,
      data: { name: 'Keyboard', price: 99 },
    });
  });

  it('returns 422 with field-level details for invalid input', async () => {
    testApp = await startTestApp({
      controllers: [{ basePath: '/api', ControllerClass: ProductController }],
    });

    const res = await testApp.agent
      .post('/api/products')
      .send({ name: '', price: -1 })
      .expect(422);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'name' }),
        expect.objectContaining({ path: 'price' }),
      ])
    );
  });
});
```

### Services and Dependency Injection

Singletons accumulate state across requests within one app; per-request services are fresh every time; `dispose` hooks run during shutdown.

```typescript
// tests/services.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { BaseController } from 'blendsdk/webafx';
import type {
  PerRequestFactory,
  RouteDefinition,
  SingletonFactory,
} from 'blendsdk/webafx';
import { startTestApp } from './helpers.js';
import type { TestApp } from './helpers.js';

const poolFactory: SingletonFactory<{ open: boolean }> = () => ({ open: true });
const counterFactory: SingletonFactory<{ count: number }> = () => ({ count: 0 });

let requestSequence = 0;
const requestScopeFactory: PerRequestFactory<{ id: number }> = () => ({
  id: ++requestSequence,
});

class ServiceController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/counters')
        .handle(async (req, res) => {
          const pool = await req.services.get<{ open: boolean }>('pool');
          const counter = await req.services.get<{ count: number }>('counter');
          counter.count += 1;
          const scope = await req.services.get<{ id: number }>('request-scope');

          this.ok(res, { poolOpen: pool.open, count: counter.count, requestId: scope.id });
        }),
    ];
  }
}

describe('service lifecycles over HTTP', () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    if (testApp) {
      await testApp.shutdown();
      testApp = undefined;
    }
  });

  it('shares singletons across requests and isolates per-request services', async () => {
    const disposed: string[] = [];

    testApp = await startTestApp({
      services: [
        {
          name: 'pool',
          type: 'singleton',
          factory: poolFactory,
          dispose: () => {
            disposed.push('pool');
          },
        },
        { name: 'counter', type: 'singleton', factory: counterFactory },
        { name: 'request-scope', type: 'per-request', factory: requestScopeFactory },
      ],
      controllers: [{ basePath: '/api', ControllerClass: ServiceController }],
    });

    const first = await testApp.agent.get('/api/counters').expect(200);
    const second = await testApp.agent.get('/api/counters').expect(200);
    const third = await testApp.agent.get('/api/counters').expect(200);

    // Singleton accumulates; per-request id differs on every request
    expect(first.body.data.count).toBe(1);
    expect(second.body.data.count).toBe(2);
    expect(third.body.data.count).toBe(3);

    const ids = [first.body.data.requestId, second.body.data.requestId, third.body.data.requestId];
    expect(new Set(ids).size).toBe(3);
  });

  it('disposes resolved singletons during shutdown', async () => {
    const disposed: string[] = [];

    const localApp = await startTestApp({
      services: [
        {
          name: 'pool',
          type: 'singleton',
          factory: poolFactory,
          dispose: () => {
            disposed.push('pool');
          },
        },
        { name: 'counter', type: 'singleton', factory: counterFactory },
        { name: 'request-scope', type: 'per-request', factory: requestScopeFactory },
      ],
      controllers: [{ basePath: '/api', ControllerClass: ServiceController }],
    });

    await localApp.agent.get('/api/counters').expect(200);
    await localApp.shutdown();

    expect(disposed).toEqual(['pool']);
  });
});
```

### Authentication and Principal Selection

Model authentication as a per-request principal service. Routes using `secure()` resolve the default `'user'` service; `secure('client')` (or `this.authenticated('client')`) resolves a different one — a missing or empty principal is always a `401`, a failing `authorize` is always a `403`.

```typescript
// tests/auth.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { BaseController } from 'blendsdk/webafx';
import type { PerRequestFactory, RouteDefinition, ServiceDefinition } from 'blendsdk/webafx';
import { startTestApp } from './helpers.js';
import type { TestApp } from './helpers.js';

interface Principal {
  sub: string;
  kind: 'user' | 'client';
}

const userPrincipalFactory: PerRequestFactory<Principal | undefined> = (
  _container,
  _settings,
  req
) => (req.headers['x-user'] === 'ok' ? { sub: 'user-1', kind: 'user' } : undefined);

const clientPrincipalFactory: PerRequestFactory<Principal | undefined> = (
  _container,
  _settings,
  req
) => (req.headers['x-client'] === 'ok' ? { sub: 'client-1', kind: 'client' } : undefined);

const principalServices: ServiceDefinition[] = [
  { name: 'user', type: 'per-request', factory: userPrincipalFactory },
  { name: 'client', type: 'per-request', factory: clientPrincipalFactory },
];

class SecureController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/me')
        .secure()
        .handle(async (req, res) => {
          const user = await req.services.get<Principal | undefined>('user', undefined);
          this.ok(res, { sub: user?.sub });
        }),
      this.authenticated('client')
        .get('/export')
        .handle(async (req, res) => {
          const client = await req.services.get<Principal | undefined>('client', undefined);
          this.ok(res, { sub: client?.sub });
        }),
      this.route()
        .get('/admin')
        .secure()
        .authorize((_req, principal: Principal) => principal.sub === 'user-1')
        .handle(async (_req, res) => {
          this.ok(res, { admin: true });
        }),
      this.route()
        .get('/reports')
        .secure()
        .authorize(() => false)
        .handle(async (_req, res) => {
          this.ok(res, { reached: true });
        }),
    ];
  }
}

describe('authentication and authorization', () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    if (testApp) {
      await testApp.shutdown();
      testApp = undefined;
    }
  });

  it('rejects a secure route without a principal', async () => {
    testApp = await startTestApp({
      services: principalServices,
      controllers: [{ basePath: '/api', ControllerClass: SecureController }],
    });

    const res = await testApp.agent.get('/api/me').expect(401);

    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('authenticates through the default user service', async () => {
    testApp = await startTestApp({
      services: principalServices,
      controllers: [{ basePath: '/api', ControllerClass: SecureController }],
    });

    const res = await testApp.agent.get('/api/me').set('x-user', 'ok').expect(200);

    expect(res.body.data).toEqual({ sub: 'user-1' });
  });

  it('resolves a named principal service instead of the default', async () => {
    testApp = await startTestApp({
      services: principalServices,
      controllers: [{ basePath: '/api', ControllerClass: SecureController }],
    });

    // The user credential does not authenticate the client route
    await testApp.agent.get('/api/export').set('x-user', 'ok').expect(401);

    const res = await testApp.agent.get('/api/export').set('x-client', 'ok').expect(200);
    expect(res.body.data).toEqual({ sub: 'client-1' });
  });

  it('lets the authorize callback decide between 200 and 403', async () => {
    testApp = await startTestApp({
      services: principalServices,
      controllers: [{ basePath: '/api', ControllerClass: SecureController }],
    });

    await testApp.agent.get('/api/admin').set('x-user', 'ok').expect(200);

    const res = await testApp.agent.get('/api/reports').set('x-user', 'ok').expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
```

### Plugins

Plugins install in ascending `priority` order, contribute to `GET /health`, run `shutdown` hooks on teardown, and may mount catch-all middleware in the terminal phase — after controllers, so fallbacks never shadow routes.

```typescript
// tests/plugins.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { BaseController, WebApplication } from 'blendsdk/webafx';
import type { PluginDefinition, RouteDefinition } from 'blendsdk/webafx';
import { startTestApp } from './helpers.js';
import type { TestApp } from './helpers.js';

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

describe('plugin system', () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    if (testApp) {
      await testApp.shutdown();
      testApp = undefined;
    }
  });

  it('installs plugins in ascending priority order', async () => {
    const installOrder: string[] = [];

    const tracker = (name: string, priority: number): PluginDefinition => ({
      name,
      priority,
      factory: async () => {
        installOrder.push(name);
        return {};
      },
    });

    testApp = await startTestApp({
      plugins: [tracker('metrics', 50), tracker('auth', 10), tracker('static', 20)],
    });

    expect(installOrder).toEqual(['auth', 'static', 'metrics']);
  });

  it('aggregates plugin health into GET /health', async () => {
    testApp = await startTestApp({
      plugins: [
        { name: 'cache', factory: async () => ({ health: async () => true }) },
      ],
    });

    const healthy = await testApp.agent.get('/health').expect(200);
    expect(healthy.body).toEqual({ health: true, timestamp: expect.any(Number) });
  });

  it('returns 503 when a plugin reports unhealthy', async () => {
    testApp = await startTestApp({
      plugins: [
        { name: 'database', factory: async () => ({ health: async () => false }) },
      ],
    });

    const res = await testApp.agent.get('/health').expect(503);
    expect(res.body.health).toBe(false);
  });

  it('runs plugin shutdown hooks during application shutdown', async () => {
    const shutdownOrder: string[] = [];

    const plugin = (name: string, priority: number): PluginDefinition => ({
      name,
      priority,
      factory: async () => ({
        shutdown: async () => {
          shutdownOrder.push(name);
        },
      }),
    });

    const localApp = await startTestApp({
      plugins: [plugin('first', 10), plugin('second', 20)],
    });

    await localApp.shutdown();

    expect(shutdownOrder).toEqual(['first', 'second']);
  });

  it('rejects duplicate plugin names immediately', () => {
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });
    const plugin: PluginDefinition = { name: 'metrics', factory: async () => ({}) };

    app.use(plugin);

    expect(() => app.use(plugin)).toThrow('Plugin "metrics" is already registered');
  });

  it('keeps terminal catch-alls from shadowing controller routes', async () => {
    const fallback: PluginDefinition = {
      name: 'fallback',
      factory: async () => ({
        terminal: async ({ express }) => {
          express.use((_req, res) => {
            res.send('fallback');
          });
        },
      }),
    };

    testApp = await startTestApp({
      plugins: [fallback],
      controllers: [{ basePath: '/api', ControllerClass: PingController }],
    });

    // The controller wins even though the catch-all is mounted globally
    const apiRes = await testApp.agent.get('/api/ping').expect(200);
    expect(apiRes.body).toEqual({ success: true, data: { pong: true } });

    // Genuinely unmatched requests reach the terminal middleware, not the 404 handler
    const fallbackRes = await testApp.agent.get('/nope').expect(200);
    expect(fallbackRes.text).toBe('fallback');
  });
});
```

### Error Handling

Assert the full `StandardErrorResponse` envelope: `code`, `message`, `statusCode`, `timestamp`, `requestId`, `path`, and optional `details`/`stack`. Stack traces and raw messages appear only outside production.

```typescript
// tests/error-handling.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { BadRequestError, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { startTestApp } from './helpers.js';
import type { TestApp } from './helpers.js';

class ErrorController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/bad')
        .handle(async () => {
          throw new BadRequestError('Invalid input', { field: 'email' });
        }),
      this.route()
        .get('/boom')
        .handle(async () => {
          throw new Error('Database connection failed');
        }),
    ];
  }
}

describe('error handling', () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    if (testApp) {
      await testApp.shutdown();
      testApp = undefined;
    }
  });

  it('maps ApiError subclasses to their envelope with request metadata', async () => {
    testApp = await startTestApp({
      controllers: [{ basePath: '/api', ControllerClass: ErrorController }],
    });

    const res = await testApp.agent.get('/api/bad').expect(400);

    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'Invalid input',
        statusCode: 400,
        timestamp: expect.any(String),
        requestId: expect.any(String),
        path: '/api/bad',
        details: { field: 'email' },
      },
    });
  });

  it('exposes unknown error details outside production', async () => {
    testApp = await startTestApp({
      controllers: [{ basePath: '/api', ControllerClass: ErrorController }],
    });

    const res = await testApp.agent.get('/api/boom').expect(500);

    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(res.body.error.message).toBe('Database connection failed');
    expect(res.body.error.stack).toBeDefined();
  });

  it('hides unknown error details in production', async () => {
    testApp = await startTestApp({
      config: { ENV_MODE: 'production' },
      controllers: [{ basePath: '/api', ControllerClass: ErrorController }],
    });

    const res = await testApp.agent.get('/api/boom').expect(500);

    expect(res.body.error.message).toBe('Internal Server Error');
    expect(res.body.error.stack).toBeUndefined();
  });
});
```

### CORS

Configure CORS explicitly on every test app — the default (`CORS` undefined) is *no CORS middleware*:

```typescript
// tests/cors.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { startTestApp } from './helpers.js';
import type { TestApp } from './helpers.js';

class TestController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/test')
        .handle(async (_req, res) => {
          this.ok(res, { message: 'CORS test' });
        }),
    ];
  }
}

describe('CORS middleware', () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    if (testApp) {
      await testApp.shutdown();
      testApp = undefined;
    }
  });

  it('echoes an allowed origin and sets credentials', async () => {
    testApp = await startTestApp({
      config: { CORS: { origin: 'https://myapp.com', credentials: true } },
      controllers: [{ basePath: '/api', ControllerClass: TestController }],
    });

    const res = await testApp.agent
      .get('/api/test')
      .set('Origin', 'https://myapp.com')
      .expect(200);

    expect(res.headers['access-control-allow-origin']).toBe('https://myapp.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('omits CORS headers for a disallowed origin', async () => {
    testApp = await startTestApp({
      config: { CORS: { origin: 'https://myapp.com' } },
      controllers: [{ basePath: '/api', ControllerClass: TestController }],
    });

    const res = await testApp.agent
      .get('/api/test')
      .set('Origin', 'https://evil.example')
      .expect(200);

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers preflight requests with 204', async () => {
    testApp = await startTestApp({
      config: { CORS: true },
      controllers: [{ basePath: '/api', ControllerClass: TestController }],
    });

    const res = await testApp.agent
      .options('/api/test')
      .set('Origin', 'http://example.com')
      .set('Access-Control-Request-Method', 'GET')
      .expect(204);

    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toBeDefined();
  });

  it('sends no CORS headers when disabled', async () => {
    testApp = await startTestApp({
      config: { CORS: false },
      controllers: [{ basePath: '/api', ControllerClass: TestController }],
    });

    const res = await testApp.agent
      .get('/api/test')
      .set('Origin', 'https://myapp.com')
      .expect(200);

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
```

### CSRF Protection

Test the pure comparison helper directly, then exercise the middleware end-to-end through `csrfPlugin`. Mutating requests without a valid token must return the `csrf_invalid` envelope without reaching the handler.

```typescript
// tests/csrf.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { BaseController, constantTimeTokenMatch, csrfPlugin } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { startTestApp } from './helpers.js';
import type { TestApp } from './helpers.js';

describe('constantTimeTokenMatch', () => {
  it('accepts identical tokens and rejects everything else', () => {
    expect(constantTimeTokenMatch('abc123', 'abc123')).toBe(true);
    expect(constantTimeTokenMatch('abc123', 'abc124')).toBe(false);
    expect(constantTimeTokenMatch('abc', 'abc123')).toBe(false);
    expect(constantTimeTokenMatch(undefined, 'abc123')).toBe(false);
    expect(constantTimeTokenMatch('abc123', undefined)).toBe(false);
    expect(constantTimeTokenMatch('abc123', '')).toBe(false);
  });
});

class NotesController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/notes')
        .handle(async (_req, res) => {
          this.ok(res, []);
        }),
      this.route()
        .post('/notes')
        .handle(async (_req, res) => {
          this.created(res, { saved: true });
        }),
      this.route()
        .post('/webhooks')
        .handle(async (_req, res) => {
          this.ok(res, { accepted: true });
        }),
    ];
  }
}

describe('csrfPlugin (session-bound mode)', () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    if (testApp) {
      await testApp.shutdown();
      testApp = undefined;
    }
  });

  const sessionBoundPlugin = () =>
    csrfPlugin({
      // Stands in for a session lookup — the expected token is bound to the session.
      expectedToken: (req) => {
        const token = req.headers['x-session'];
        return typeof token === 'string' ? token : undefined;
      },
    });

  it('rejects a mutating request without a token', async () => {
    testApp = await startTestApp({
      plugins: [sessionBoundPlugin()],
      controllers: [{ basePath: '/api', ControllerClass: NotesController }],
    });

    const res = await testApp.agent.post('/api/notes').send({ text: 'hi' }).expect(403);

    expect(res.body).toEqual({
      success: false,
      error: { code: 'csrf_invalid', message: 'Invalid or missing CSRF token' },
    });
  });

  it('accepts a mutating request with the matching token', async () => {
    testApp = await startTestApp({
      plugins: [sessionBoundPlugin()],
      controllers: [{ basePath: '/api', ControllerClass: NotesController }],
    });

    await testApp.agent
      .post('/api/notes')
      .set('x-session', 'session-abc')
      .set('x-csrf-token', 'session-abc')
      .send({ text: 'hello' })
      .expect(201);
  });

  it('passes safe methods through untouched', async () => {
    testApp = await startTestApp({
      plugins: [sessionBoundPlugin()],
      controllers: [{ basePath: '/api', ControllerClass: NotesController }],
    });

    await testApp.agent.get('/api/notes').expect(200);
  });

  it('honors exact method-and-path exemptions', async () => {
    testApp = await startTestApp({
      plugins: [
        csrfPlugin({
          expectedToken: () => 'expected',
          exempt: ['POST /api/webhooks'],
        }),
      ],
      controllers: [{ basePath: '/api', ControllerClass: NotesController }],
    });

    await testApp.agent.post('/api/webhooks').send({ event: 'ping' }).expect(200);
  });
});

describe('csrfPlugin (double-submit cookie mode)', () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    if (testApp) {
      await testApp.shutdown();
      testApp = undefined;
    }
  });

  it('accepts matching cookie and header values', async () => {
    testApp = await startTestApp({
      plugins: [csrfPlugin({ cookie: { name: 'csrf' } })],
      controllers: [{ basePath: '/api', ControllerClass: NotesController }],
    });

    await testApp.agent
      .post('/api/notes')
      .set('Cookie', 'csrf=abc123')
      .set('x-csrf-token', 'abc123')
      .send({ text: 'hello' })
      .expect(201);
  });

  it('rejects mismatched cookie and header values', async () => {
    testApp = await startTestApp({
      plugins: [csrfPlugin({ cookie: { name: 'csrf' } })],
      controllers: [{ basePath: '/api', ControllerClass: NotesController }],
    });

    await testApp.agent
      .post('/api/notes')
      .set('Cookie', 'csrf=abc123')
      .set('x-csrf-token', 'different')
      .send({ text: 'hello' })
      .expect(403);
  });
});
```

### Rate Limiting

Each `rateLimitMiddleware()` call owns its own in-memory window — a fresh app per test therefore starts with a fresh counter. Use short real windows for reset tests (fake timers do not interleave well with supertest).

```typescript
// tests/rate-limit.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { BaseController, rateLimitMiddleware } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { startTestApp } from './helpers.js';
import type { TestApp } from './helpers.js';

class SearchController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/search')
        .middleware(rateLimitMiddleware({ maxRequests: 2, windowMs: 60_000 }))
        .handle(async (_req, res) => {
          this.ok(res, { results: [] });
        }),
      this.route()
        .get('/per-user')
        .middleware(
          rateLimitMiddleware({
            maxRequests: 1,
            windowMs: 60_000,
            keyExtractor: (req) => {
              const userId = req.headers['x-user-id'];
              return typeof userId === 'string' ? userId : 'anonymous';
            },
          })
        )
        .handle(async (_req, res) => {
          this.ok(res, { scoped: true });
        }),
    ];
  }
}

describe('rateLimitMiddleware', () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    if (testApp) {
      await testApp.shutdown();
      testApp = undefined;
    }
  });

  it('allows requests within the window and sets headers', async () => {
    testApp = await startTestApp({
      controllers: [{ basePath: '/api', ControllerClass: SearchController }],
    });

    const first = await testApp.agent.get('/api/search').expect(200);
    expect(first.headers['x-ratelimit-limit']).toBe('2');
    expect(first.headers['x-ratelimit-remaining']).toBe('1');

    const second = await testApp.agent.get('/api/search').expect(200);
    expect(second.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('returns 429 once the window is exhausted', async () => {
    testApp = await startTestApp({
      controllers: [{ basePath: '/api', ControllerClass: SearchController }],
    });

    await testApp.agent.get('/api/search').expect(200);
    await testApp.agent.get('/api/search').expect(200);

    const res = await testApp.agent.get('/api/search').expect(429);
    expect(res.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('scopes limits by the key extractor', async () => {
    testApp = await startTestApp({
      controllers: [{ basePath: '/api', ControllerClass: SearchController }],
    });

    await testApp.agent.get('/api/per-user').set('X-User-Id', 'user-a').expect(200);

    // user-a is now exhausted; user-b has its own bucket
    await testApp.agent.get('/api/per-user').set('X-User-Id', 'user-a').expect(429);
    await testApp.agent.get('/api/per-user').set('X-User-Id', 'user-b').expect(200);
  });

  it('resets after the window expires', async () => {
    class ShortWindowController extends BaseController {
      routes(): RouteDefinition[] {
        return [
          this.route()
            .get('/short')
            .middleware(rateLimitMiddleware({ maxRequests: 1, windowMs: 50 }))
            .handle(async (_req, res) => {
              this.ok(res, { ok: true });
            }),
        ];
      }
    }

    testApp = await startTestApp({
      controllers: [{ basePath: '/api', ControllerClass: ShortWindowController }],
    });

    await testApp.agent.get('/api/short').expect(200);
    await testApp.agent.get('/api/short').expect(429);

    await new Promise((resolve) => setTimeout(resolve, 80));

    await testApp.agent.get('/api/short').expect(200);
  });
});
```

### Logging and Observability

Cover level filtering for `ConsoleLogger`, JSON shape for `StructuredLogger`, and the `setLogger` replacement hook.

```typescript
// tests/logging.test.ts
import { describe, expect, it, vi } from 'vitest';
import { ConsoleLogger, StructuredLogger } from 'blendsdk/webafx';
import type { LogEntry } from 'blendsdk/webafx';

describe('ConsoleLogger', () => {
  it('logs errors with an uppercased prefix', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new ConsoleLogger('Payments', 'ERROR');

    await logger.error('Charge failed', { chargeId: 'ch_1' });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ERROR:PAYMENTS]: Charge failed')
    );
  });

  it('suppresses INFO when the level is ERROR', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new ConsoleLogger('Payments', 'ERROR');

    await logger.info('Not emitted');

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('emits WARN and INFO when the level is INFO', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new ConsoleLogger('Payments', 'INFO');

    await logger.warn('Slow');
    await logger.info('Processed');
    await logger.debug('Suppressed');

    expect(logSpy).toHaveBeenCalledTimes(2);
  });
});

describe('StructuredLogger', () => {
  it('emits parseable JSON entries with timestamp, level, and data', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new StructuredLogger('API', 'INFO');

    await logger.info('User login', { userId: 42 });

    const raw = String(logSpy.mock.calls[0]?.[0]);
    const entry = JSON.parse(raw) as LogEntry;

    expect(entry).toMatchObject({
      level: 'INFO',
      message: 'User login',
      prefix: 'API',
      data: { userId: 42 },
    });
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('adds dynamic context from the context function to every entry', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const contextFn = vi.fn(() => ({ requestId: 'req-1' }));
    const logger = new StructuredLogger('API', 'INFO', contextFn);

    await logger.info('First');
    await logger.info('Second');

    expect(contextFn).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as LogEntry;
    expect(first.requestId).toBe('req-1');
  });

  it('routes ERROR to console.error and the rest to console.log', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new StructuredLogger('API', 'DEBUG');

    await logger.error('e');
    await logger.warn('w');
    await logger.info('i');
    await logger.debug('d');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(3);
  });
});
```

### Request Context

The request ID is generated per request, exposed via `AsyncLocalStorage`, and echoed in the `X-Request-ID` header. Test the storage primitives directly and the end-to-end behavior through a controller:

```typescript
// tests/request-context.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  BaseController,
  getRequestContext,
  getRequestId,
  requestContextStorage,
} from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { startTestApp } from './helpers.js';
import type { TestApp } from './helpers.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('request context storage', () => {
  it('is undefined outside a request scope', () => {
    expect(getRequestContext()).toBeUndefined();
    expect(getRequestId()).toBeUndefined();
  });

  it('propagates through async work inside the scope', async () => {
    await requestContextStorage.run(
      { requestId: 'req-1', startTime: Date.now() },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(getRequestId()).toBe('req-1');
      }
    );
  });
});

class TraceController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/trace')
        .handle(async (_req, res) => {
          this.ok(res, {
            requestId: getRequestId(),
            started: getRequestContext()?.startTime !== undefined,
          });
        }),
    ];
  }
}

describe('request id over HTTP', () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    if (testApp) {
      await testApp.shutdown();
      testApp = undefined;
    }
  });

  it('generates a UUID and mirrors it in the response header', async () => {
    testApp = await startTestApp({
      controllers: [{ basePath: '', ControllerClass: TraceController }],
    });

    const res = await testApp.agent.get('/trace').expect(200);

    expect(res.body.data.requestId).toMatch(UUID_PATTERN);
    expect(res.headers['x-request-id']).toBe(res.body.data.requestId);
    expect(res.body.data.started).toBe(true);
  });

  it('reuses a valid upstream request id', async () => {
    testApp = await startTestApp({
      controllers: [{ basePath: '', ControllerClass: TraceController }],
    });

    const upstream = '550e8400-e29b-41d4-a716-446655440000';
    const res = await testApp.agent.get('/trace').set('X-Request-ID', upstream).expect(200);

    expect(res.body.data.requestId).toBe(upstream);
  });

  it('replaces a malformed upstream request id', async () => {
    testApp = await startTestApp({
      controllers: [{ basePath: '', ControllerClass: TraceController }],
    });

    const res = await testApp.agent.get('/trace').set('X-Request-ID', 'not-a-uuid').expect(200);

    expect(res.body.data.requestId).not.toBe('not-a-uuid');
    expect(res.body.data.requestId).toMatch(UUID_PATTERN);
  });
});
```

### Static Files and SPA Fallback

Build fixtures in a temp directory (`beforeAll`), remove them afterwards (`afterAll`), and assert the three SPA guards (GET only, no file extension, `Accept: text/html`) plus the terminal-phase guarantee that controller routes are never swallowed.

```typescript
// tests/static.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseController, staticFilesPlugin, WebApplication } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { startTestApp } from './helpers.js';
import type { TestApp } from './helpers.js';

let publicDir = '';

beforeAll(() => {
  publicDir = mkdtempSync(join(tmpdir(), 'webafx-test-'));
  writeFileSync(join(publicDir, 'index.html'), '<!DOCTYPE html><html><body>SPA_ROOT</body></html>');
  writeFileSync(join(publicDir, 'app.js'), 'console.log("bundle");');
  mkdirSync(join(publicDir, 'sub'));
  writeFileSync(join(publicDir, 'sub', 'nested.txt'), 'nested');
});

afterAll(() => {
  rmSync(publicDir, { recursive: true, force: true });
});

class StatusController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/status')
        .handle(async (_req, res) => {
          this.ok(res, { marker: 'CONTROLLER' });
        }),
    ];
  }
}

describe('staticFilesPlugin', () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    if (testApp) {
      await testApp.shutdown();
      testApp = undefined;
    }
  });

  it('exposes a deterministic plugin name for duplicate detection', () => {
    const plugin = staticFilesPlugin({ root: publicDir, prefix: '/assets' });

    expect(plugin.name).toBe('static-files:/assets');
    expect(plugin.priority).toBe(20);
  });

  it('serves files from the root directory', async () => {
    testApp = await startTestApp({
      plugins: [staticFilesPlugin({ root: publicDir })],
    });

    const res = await testApp.agent.get('/app.js').expect(200);

    expect(res.text).toBe('console.log("bundle");');
  });

  it('applies cache headers from maxAge', async () => {
    testApp = await startTestApp({
      plugins: [staticFilesPlugin({ root: publicDir, maxAge: '1d' })],
    });

    const res = await testApp.agent.get('/app.js').expect(200);

    expect(res.headers['cache-control']).toContain('max-age=86400');
  });

  it('serves index.html for unmatched client-side routes in SPA mode', async () => {
    testApp = await startTestApp({
      plugins: [staticFilesPlugin({ root: publicDir, spa: true })],
    });

    const res = await testApp.agent
      .get('/settings/profile')
      .set('Accept', 'text/html')
      .expect(200);

    expect(res.text).toContain('SPA_ROOT');
  });

  it('does not swallow controller routes that look like navigation', async () => {
    testApp = await startTestApp({
      plugins: [staticFilesPlugin({ root: publicDir, spa: true })],
      controllers: [{ basePath: '/api', ControllerClass: StatusController }],
    });

    const res = await testApp.agent.get('/api/status').set('Accept', 'text/html').expect(200);

    expect(res.body).toEqual({ success: true, data: { marker: 'CONTROLLER' } });
    expect(res.text).not.toContain('SPA_ROOT');
  });

  it('lets missing assets 404 instead of serving index.html', async () => {
    testApp = await startTestApp({
      plugins: [staticFilesPlugin({ root: publicDir, spa: true })],
    });

    await testApp.agent.get('/missing.css').set('Accept', 'text/html').expect(404);
  });

  it('lets JSON clients 404 instead of serving index.html', async () => {
    testApp = await startTestApp({
      plugins: [staticFilesPlugin({ root: publicDir, spa: true })],
    });

    await testApp.agent.get('/api/unknown').set('Accept', 'application/json').expect(404);
  });

  it('fails fast when the root directory does not exist', async () => {
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });
    app.use(staticFilesPlugin({ root: join(publicDir, 'does-not-exist') }));

    await expect(app.start()).rejects.toThrow('Static files root directory does not exist');
  });
});
```

### Lifecycle Hooks and Graceful Shutdown

Verify hook ordering, async hook support, double-start protection, and shutdown idempotency. `shutdown()` drains connections, disposes services, and shuts down plugins before `afterShutdown` hooks run — and calling it twice is safe.

```typescript
// tests/lifecycle.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebApplication } from 'blendsdk/webafx';

describe('application lifecycle', () => {
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = undefined;
    }
  });

  it('fires hooks in lifecycle order', async () => {
    const events: string[] = [];
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });

    app
      .on('beforeStart', async () => {
        events.push('beforeStart');
      })
      .on('afterStart', () => {
        events.push('afterStart');
      })
      .on('beforeShutdown', () => {
        events.push('beforeShutdown');
      })
      .on('afterShutdown', () => {
        events.push('afterShutdown');
      });

    shutdown = await app.start();
    expect(events).toEqual(['beforeStart', 'afterStart']);

    await shutdown();
    shutdown = undefined;

    expect(events).toEqual([
      'beforeStart',
      'afterStart',
      'beforeShutdown',
      'afterShutdown',
    ]);
  });

  it('invokes hook spies exactly once', async () => {
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });
    const beforeStart = vi.fn(async () => {});

    app.on('beforeStart', beforeStart);

    shutdown = await app.start();

    expect(beforeStart).toHaveBeenCalledTimes(1);
  });

  it('supports multiple hooks for the same event in registration order', async () => {
    const order: string[] = [];
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });

    app.on('beforeStart', () => {
      order.push('first');
    });
    app.on('beforeStart', () => {
      order.push('second');
    });

    shutdown = await app.start();

    expect(order).toEqual(['first', 'second']);
  });

  it('rejects a second start', async () => {
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });
    shutdown = await app.start();

    await expect(app.start()).rejects.toThrow('Application already started');
  });

  it('is idempotent when shutdown runs twice', async () => {
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });
    shutdown = await app.start();

    await expect(shutdown()).resolves.toBeUndefined();
    await expect(shutdown()).resolves.toBeUndefined();
    shutdown = undefined;
  });
});
```

---

# webafx Troubleshooting

This document covers the errors, debugging procedures, and subtle pitfalls you are most likely to hit when building on `blendsdk/webafx` (WebAFX). Every quoted error message is taken from the shipped source, and every fix includes a working example.

Install the umbrella package together with the required peer dependencies before reading further:

```bash
npm install blendsdk express zod
npm install -D typescript @types/node @types/express
```

---

## Common Errors

### Configuration

#### `Configuration validation failed:`

**Symptom**

```
Configuration validation failed:
  - PORT: Too big: expected number to be <=65535
  - ENV_MODE: Invalid option: expected one of "production"|"development"|"test"
```

**Cause** — `ApplicationSettings` validates the configuration with a Zod schema whenever you pass a config object to `new WebApplication(config)` or `new ApplicationSettings(config)`, and again after every `.env.js` file load. Typical triggers: passing strings where the schema expects numbers or booleans (`PORT: '3000'`, `DEBUG: 'true'`), values out of range (`PORT` must be an integer between 0 and 65535, `SHUTDOWN_TIMEOUT` between 0 and 300), or an `ENV_MODE` that is not exactly `'production'`, `'development'`, or `'test'`. Custom keys are allowed — only the standard fields are checked.

**Fix** — pass correctly typed values:

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({
  PORT: 3000,                 // number, integer, 0-65535
  ENV_MODE: 'development',    // 'production' | 'development' | 'test'
  LOG_LEVEL: 'INFO',          // 'ERROR' | 'WARN' | 'INFO' | 'DEBUG'
  DEBUG: false,               // boolean — not 'false'
  TRUST_PROXY: true,          // boolean
  BODY_LIMIT: '10mb',         // string
  SHUTDOWN_TIMEOUT: 30,       // seconds, 0-300
  CUSTOM_FLAG: true,          // custom keys pass through the schema
});
```

The same schema applies to `.env.js` files. Those files are JavaScript — not `process.env` — so they must use real numbers and booleans, never strings.

---

#### `Configuration file error: /abs/path/.env.js`

**Symptom**

```
Error: Configuration file error: /srv/app/.env.js
    at ApplicationSettings.loadFromFile (application-settings.ts:...)
  [cause]: SyntaxError: Unexpected token '}'
```

**Cause** — the file exists, but importing it failed. `loadFromFile()` logs the underlying error, then rethrows `Configuration file error: <resolved path>` with the original error attached as `cause`. Common reasons: a syntax error in the file, a top-level throw, a CommonJS file (`module.exports = {}`) in an ESM project, or an `import` of a module that is not installed.

**Fix** — surface the `cause` to see the real failure:

```typescript
import { ApplicationSettings } from 'blendsdk/webafx';

const settings = new ApplicationSettings();

try {
  await settings.loadFromFile('./.env.js');
} catch (error) {
  const cause = error instanceof Error ? error.cause : undefined;
  console.error(
    'Could not load .env.js:',
    cause instanceof Error ? cause.message : String(error)
  );
  process.exitCode = 1;
}
```

---

#### Environment file values are silently ignored

**Symptom** — the application starts, but nothing from `.env.js` takes effect. `ENV_MODE` stays `production`, and no configuration error is raised.

**Cause** — two silent behaviors combine here:

1. `loadFromFile()` reads `module.default || module.config`. A file that only uses named exports (`export const PORT = 3000`) imports successfully but contributes nothing.
2. A path that does not resolve to an existing file is skipped without an error. A typo in the filename means the app quietly runs with defaults.

`WebApplication` loads exactly `<cwd>/.env.js` and `<cwd>/.env.local.js` — not `.env`, and not environment variables.

**Fix** — export a default object (or a named `config` object) and verify you can read the values back.

`.env.js`:

```javascript
export default {
  PORT: 3000,
  ENV_MODE: 'development',
  LOG_LEVEL: 'INFO',
};
```

Verification:

```typescript
import { ApplicationSettings } from 'blendsdk/webafx';

const settings = new ApplicationSettings();
await settings.loadFromFile('./.env.js');

console.log(settings.getAll().ENV_MODE); // 'development' only when the export shape is right
```

---

### Startup and Lifecycle

#### `Application already started`

**Symptom** — `await app.start()` rejects with `Error: Application already started` (typically in tests, or when two bootstrap modules both start the app).

**Cause** — `WebApplication.start()` refuses to run twice; the internal `started` flag is only cleared by the shutdown function.

**Fix** — treat the shutdown function as the single source of truth and guard startup:

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000 });
let shutdown: (() => Promise<void>) | undefined;

async function ensureStarted(): Promise<() => Promise<void>> {
  if (!shutdown) {
    shutdown = await app.start();
  }
  return shutdown;
}

async function stop(): Promise<void> {
  if (shutdown) {
    const stopFn = shutdown;
    shutdown = undefined;
    await stopFn(); // safe to call more than once — shutdown is idempotent
  }
}

await ensureStarted();
```

---

#### `Plugin "<name>" is already registered`

**Symptom** — registration throws before the server starts:

```
Error: Plugin "static-files:/assets" is already registered
```

**Cause** — `app.use()` rejects duplicate plugin names. Each plugin needs a unique `name` per application. `staticFilesPlugin` derives its name from the prefix: `static-files` for `/`, or `static-files:<prefix>` otherwise — so two static plugins on the same prefix collide.

**Fix** — give each plugin a distinct prefix or name:

```typescript
import { WebApplication, staticFilesPlugin } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000 });

// Distinct prefixes produce distinct plugin names: "static-files:/assets", "static-files:/media"
app.use(staticFilesPlugin({ root: './public', prefix: '/assets' }));
app.use(staticFilesPlugin({ root: './uploads', prefix: '/media' }));

const shutdown = await app.start();
```

---

#### `Static files root directory does not exist: <path>`

**Symptom** — `await app.start()` rejects during plugin installation:

```
Error: Static files root directory does not exist: /srv/app/public
```

**Cause** — `staticFilesPlugin` resolves `root` against `process.cwd()` at install time and fails fast when the directory is missing. Relative paths break whenever the working directory differs (different start scripts, systemd `WorkingDirectory`, Docker `WORKDIR`). The error message always contains the fully resolved path — compare it with the actual filesystem.

**Fix** — anchor the root to the module rather than the working directory:

```typescript
import path from 'node:path';
import { WebApplication, staticFilesPlugin } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000 });

app.use(staticFilesPlugin({
  root: path.join(import.meta.dirname, 'public'),
}));

const shutdown = await app.start();
```

---

### Routing

#### `Route handler must be a function, received: <type>. Path: <path>, Method: <method>`

**Symptom**

```
Error: Route handler must be a function, received: undefined. Path: /users, Method: get
```

**Cause** — `.handle()` was given something that is not a function. The overwhelmingly common case is a typo or missing method: `handle(this.listUser)` when the method is named `listUsers`, or referencing a method that exists on a different class. The error message tells you exactly which route is broken.

**Fix** — reference methods that exist on the controller:

```typescript
import { BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class UsersController extends BaseController {
  routes() {
    return [
      this.route().get('/').handle(this.listUsers),   // method exists
      this.route().post('/').handle(this.createUser), // method exists
    ];
  }

  private async listUsers(_req: Request, res: Response): Promise<void> {
    this.ok(res, { users: [] });
  }

  private async createUser(_req: Request, res: Response): Promise<void> {
    this.created(res, { id: 1 });
  }
}
```

---

#### `Route method must be set before calling handle()` / `Route path must be set before calling handle()`

**Symptom** — one of:

```
Error: Route method must be set before calling handle()
Error: Route path must be set before calling handle()
```

**Cause** — `.handle()` is the final call of the fluent chain; it requires an HTTP method and a path to have been set first. Calling `.handle()` on a fresh `RouteBuilder`, or after building the route in the wrong order, throws.

**Fix** — always start the chain with `get`/`post`/`put`/`patch`/`delete`:

```typescript
import { RouteBuilder } from 'blendsdk/webafx';

const definition = new RouteBuilder()
  .get('/status')                 // method + path first
  .handle(async (_req, res) => {
    res.json({ ok: true });
  });
```

---

#### `secure() requires a non-empty user service name`

**Symptom**

```
Error: secure() requires a non-empty user service name
```

**Cause** — `secure('')` or a whitespace-only string was passed. WebAFX trims the name and rejects blanks rather than silently creating an unauthenticated route. This typically happens when a service name comes from an unset environment variable or config key.

**Fix** — omit the argument for the default `'user'` principal, or pass a real service name:

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class ReportsController extends BaseController {
  routes() {
    return [
      this.route().get('/mine').secure().handle(this.mine),           // default 'user'
      this.route().get('/client').secure('client').handle(this.forClient),
    ];
  }

  private async mine(_req: Request, res: Response): Promise<void> {
    this.ok(res, { scope: 'user' });
  }

  private async forClient(_req: Request, res: Response): Promise<void> {
    this.ok(res, { scope: 'client' });
  }
}

const app = new WebApplication({ PORT: 3000 });
app.registerController('/reports', ReportsController);
const shutdown = await app.start();
```

---

#### 404 `NOT_FOUND` on a path you know you registered

**Symptom**

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Cannot GET /api/items",
    "statusCode": 404,
    "timestamp": "2026-01-15T09:30:00.000Z",
    "requestId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "path": "/api/items"
  }
}
```

**Cause** — the usual suspect is a doubled prefix: `registerController('/api', …)` mounts everything under `/api`, and a route defined as `/api/items` inside the controller becomes `/api/api/items`. Requests to `/api/items` then fall through to the 404 handler. The same symptom appears if `registerController` was never called, or was called after `app.start()` (registration happens once, during startup).

**Fix** — decide where the prefix lives and put it in exactly one place:

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class ItemsController extends BaseController {
  routes() {
    return [this.route().get('/items').handle(this.list)]; // → GET /api/items
  }

  private async list(_req: Request, res: Response): Promise<void> {
    this.ok(res, []);
  }
}

const app = new WebApplication({ PORT: 3000 });
app.registerController('/api', ItemsController); // prefix lives here only
const shutdown = await app.start();
```

---

#### A catch-all fallback swallows controller routes

**Symptom** — a controller route that looks like a page navigation (`GET` request, no file extension, `Accept: text/html`) returns your SPA's `index.html` or a custom fallback instead of the controller's JSON. Other endpoints work fine.

**Cause** — middleware mounted inside a plugin's `factory` runs before controllers are registered, so any catch-all registered there matches every request that reaches it first. This is why WebAFX has the terminal phase: `terminal` hooks run after controllers and `/health`, but before the 404 handler.

**Fix** — serve single-page applications with `staticFilesPlugin({ root, spa: true })` (its fallback is already mounted in the terminal phase). For a custom fallback, return it from the plugin's `terminal` hook:

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { NextFunction, Request, Response } from 'express';

const app = new WebApplication({ PORT: 3000 });

app.use({
  name: 'spa-fallback',
  priority: 20,
  factory: async () => ({
    // `terminal` runs AFTER controllers and /health, BEFORE the 404 handler
    terminal: ({ express }) => {
      express.use((req: Request, res: Response, next: NextFunction) => {
        const accept = req.headers.accept ?? '';
        if (req.method !== 'GET' || !accept.includes('text/html')) {
          next();
          return;
        }
        res.sendFile('/srv/app/public/index.html');
      });
    },
  }),
});

const shutdown = await app.start();
```

---

### Authentication and Validation

#### 401 `UNAUTHORIZED` — `Authentication required`

**Symptom**

```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required",
    "statusCode": 401,
    "requestId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "path": "/secure/me"
  }
}
```

**Cause** — the route is marked secure (`secure()` / `authenticated()`), but the principal service resolved to nothing. The guard looks up a service by name — `'user'` by default, or the name passed to `secure(name)` — and rejects with 401 when the service is not registered or its factory returns a falsy value. An unregistered or blank name never crashes and never opens the route; it fails closed with 401.

**Fix** — register a principal service under the expected name. A per-request factory is the typical pattern:

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class SecureController extends BaseController {
  routes() {
    return [this.route().get('/me').secure().handle(this.me)];
  }

  private async me(req: Request, res: Response): Promise<void> {
    const user = await req.services.get<{ id: number; name: string } | undefined>('user', undefined);
    this.ok(res, { user });
  }
}

const app = new WebApplication({ PORT: 3000 });

app.registerService({
  name: 'user',
  type: 'per-request',
  factory: (_container, _settings, req) => {
    if (req.headers.authorization === 'Bearer valid-token') {
      return { id: 1, name: 'Ada Lovelace' };
    }
    return undefined; // → 401
  },
});

app.registerController('/secure', SecureController);
const shutdown = await app.start();
```

If the route uses `secure('client')`, the service must be registered under exactly that name — otherwise every request is rejected with 401 even when credentials are valid.

---

#### 403 `FORBIDDEN` — `Access denied`

**Symptom**

```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Access denied",
    "statusCode": 403,
    "requestId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "path": "/admin"
  }
}
```

**Cause** — the route's `authorize()` callback returned `false` (or a falsy value). Authorization runs after authentication, with the principal of the service the route selected.

**Fix** — make the callback explicit about the principal type, and remember it can receive `undefined` on routes that use `authorize()` without `secure()`:

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface User {
  id: number;
  role: 'admin' | 'member';
}

class AdminController extends BaseController {
  routes() {
    return [
      this.route()
        .get('/admin')
        .secure()
        .authorize((_req, user: User | undefined) => user?.role === 'admin')
        .handle(this.admin),
    ];
  }

  private async admin(_req: Request, res: Response): Promise<void> {
    this.ok(res, { admin: true });
  }
}

const app = new WebApplication({ PORT: 3000 });
app.registerController('/admin', AdminController);
const shutdown = await app.start();
```

The guard always uses the fixed message `Access denied`. For a custom 403 message, do the check inside the handler and throw a `ForbiddenError`:

```typescript
import { ForbiddenError } from 'blendsdk/webafx';

if (user?.role !== 'admin') {
  throw new ForbiddenError('Insufficient permissions');
}
```

---

#### 422 `VALIDATION_ERROR` with a `details` array

**Symptom**

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "statusCode": 422,
    "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "path": "/items",
    "details": [
      { "path": "page", "message": "Invalid input: expected number, received string", "code": "invalid_type" }
    ]
  }
}
```

**Cause** — `.validate(schema)` parses the merged `{ ...params, ...query, ...body }` object and the schema rejected it. The most frequent trigger: URL params and query values are always **strings**, so plain `z.number()` rejects `?page=2`. A second frequent trigger: `z.strictObject()` (or schemas that forbid extra keys) rejects fields that came in through the other merged sources.

**Fix** — coerce string inputs and keep schemas non-strict; read the parsed result via `getParams()`:

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import { z } from 'zod';
import type { Request, Response } from 'express';

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['asc', 'desc']).default('asc'),
});

type ListInput = z.infer<typeof listSchema>;

class ItemsController extends BaseController {
  routes() {
    return [
      this.route()
        .get('/items')
        .validate(listSchema)
        .handle(this.list),
    ];
  }

  private async list(req: Request, res: Response): Promise<void> {
    const { page, limit, sort } = req.services.getParams<ListInput>();
    this.ok(res, { page, limit, sort });
  }
}

const app = new WebApplication({ PORT: 3000 });
app.registerController('/api', ItemsController);
const shutdown = await app.start();
```

Note that `details` entries use `path` (the dotted field path, e.g. `"user.email"`), `message`, and `code` — even though the exported `ValidationErrorDetail` interface names the first field `field`.

---

### Services and Dependency Injection

#### `Service "<name>" is not registered`

**Symptom** — thrown from `container.get('name')` or `await req.services.get('name')` with no default provided.

**Cause** — the service was never registered, the name has a typo, or it was registered after `start()` (registration is read at startup). When you pass a default (even `undefined`) as the second argument, `get()` returns that default instead of throwing.

**Fix** — register services before starting the app; use the default argument when a service is optional:

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000 });

app.registerService({
  name: 'mailer',
  type: 'singleton',
  factory: async () => ({
    async send(to: string, subject: string): Promise<void> {
      console.log(`mail to ${to}: ${subject}`);
    },
  }),
});

const shutdown = await app.start();

// Inside a handler:
// const mailer = await req.services.get<Mailer>('mailer', undefined); // no throw if missing
```

---

#### `Circular dependency detected: a -> b -> c -> a`

**Symptom**

```
Error: Circular dependency detected: a -> b -> c -> a
```

**Cause** — service `dependencies` arrays form a cycle, and the message shows the full resolution chain. The container detects the cycle at resolution time — the first `get()` of any service in the cycle fails.

**Fix** — break the cycle so dependencies only point one direction. `dependencies` lists what the factory will resolve; the factory must fetch each dependency itself:

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000 });

app.registerService({
  name: 'database',
  type: 'singleton',
  factory: async () => ({
    query: async (sql: string): Promise<unknown[]> => [{ sql }],
  }),
});

app.registerService({
  name: 'users',
  type: 'singleton',
  dependencies: ['database'],
  factory: async (container) => {
    const database = await container.get<{ query: (sql: string) => Promise<unknown[]> }>('database');
    return {
      async all(): Promise<unknown[]> {
        return database.query('SELECT * FROM users');
      },
    };
  },
});

const shutdown = await app.start();
```

If two services genuinely need each other, resolve one of them lazily at call time (inside a method, after both factories have finished) instead of at construction time.

---

#### `Service "<name>" is per-request and can only be accessed during HTTP request handling`

**Symptom** — thrown at startup (lifecycle hook, plugin factory, or singleton factory) when resolving a `'per-request'` service:

```
Error: Service "current-user" is per-request and can only be accessed during HTTP request handling
```

**Cause** — per-request factories need `req`/`res`/`next`, so the container refuses to resolve them outside a request scope. Startup code has no request to bind to.

**Fix** — resolve per-request services inside handlers, or make the service a singleton if it does not need request data:

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class ProfileController extends BaseController {
  routes() {
    return [this.route().get('/me').handle(this.me)];
  }

  private async me(req: Request, res: Response): Promise<void> {
    // Resolved inside the request — allowed
    const user = await req.services.get<{ id: number; name: string } | undefined>('user', undefined);
    this.ok(res, { user });
  }
}

const app = new WebApplication({ PORT: 3000 });

app.registerService({
  name: 'user',
  type: 'per-request',
  factory: (_container, _settings, req) =>
    req.headers['x-user'] === 'ok' ? { id: 1, name: 'Ada' } : undefined,
});

app.registerController('/profile', ProfileController);
const shutdown = await app.start();
```

---

#### `Service "<name>" is already registered`

**Symptom** — `registerService()` throws immediately, before the app starts:

```
Error: Service "database" is already registered
```

**Cause** — duplicate registration is rejected by design; a second definition never silently overwrites the first. This most often happens when two modules both "own" the same service name.

**Fix** — use unique names, and override instances deliberately per container with `set()`:

```typescript fragment
// For a single request scope (e.g. tests), replace the resolved instance:
req.services.set('database', fakeDatabase);

// Application-wide replacement is a rename/refactor — registration names must be unique.
```

---

### Security Middleware

#### 403 `csrf_invalid` — `Invalid or missing CSRF token`

**Symptom**

```json
{
  "success": false,
  "error": {
    "code": "csrf_invalid",
    "message": "Invalid or missing CSRF token"
  }
}
```

**Cause** — a mutating request (`POST`, `PUT`, `PATCH`, `DELETE`) reached the CSRF middleware without a token that matches the expected value. Also note the fail-closed default: `csrfPlugin()` with **no options** has nothing to compare against and rejects every mutating request, including legitimate ones.

**Fix** — pick a token strategy and make the client present it. Double-submit cookie (the middleware compares the header against a cookie; your app sets the cookie, for example at login):

```typescript
import { WebApplication, csrfPlugin } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000 });

// Compares the `x-csrf-token` header (case-insensitive) with the `csrf` cookie
app.use(csrfPlugin({ cookie: { name: 'csrf' } }));

const shutdown = await app.start();
```

Session-bound mode derives the expected token from the session:

```typescript fragment
app.use(csrfPlugin({
  expectedToken: req => getSession(req)?.csrfToken,
  exempt: ['POST /webhooks/stripe'], // exact "METHOD /path" entries only
}));
```

Safe methods (`GET`, `HEAD`, `OPTIONS`) always pass through and can be customized with `safeMethods`.

---

#### 429 `RATE_LIMIT_EXCEEDED`

**Symptom** — after a number of requests, responses switch to:

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Rate limit exceeded",
    "statusCode": 429,
    "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "path": "/api/search"
  }
}
```

with `X-RateLimit-Remaining: 0`, and `X-RateLimit-Reset` holding the Unix timestamp (seconds) when the window resets.

**Cause** — more than `maxRequests` requests arrived in `windowMs` from the same key (by default `req.ip`). Counters are stored in an in-memory `Map` per middleware instance — shared across requests of one process, never across processes.

**Fix** — scope the limiter to the expensive route and tune the limits; use a custom `keyExtractor` for per-user limits:

```typescript
import { WebApplication, BaseController, rateLimitMiddleware } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class SearchController extends BaseController {
  routes() {
    return [
      this.route()
        .get('/search')
        .middleware(
          rateLimitMiddleware({
            maxRequests: 10,
            windowMs: 60_000,
            keyExtractor: (req: Request) => (req.headers['x-user-id'] as string) || req.ip || 'unknown',
          })
        )
        .handle(this.search),
    ];
  }

  private async search(_req: Request, res: Response): Promise<void> {
    this.ok(res, { results: [] });
  }
}

const app = new WebApplication({ PORT: 3000 });
app.registerController('/api', SearchController);
const shutdown = await app.start();
```

For multi-instance deployments, replace this with a shared-store (for example Redis-backed) middleware via a plugin.

---

#### No `Access-Control-Allow-Origin` header (browser CORS errors)

**Symptom** — the browser blocks responses with "No 'Access-Control-Allow-Origin' header is present on the requested resource", while `curl` sees normal responses.

**Cause** — CORS middleware is only installed when the `CORS` config is set (`true` or a config object). With `CORS` unset or `false`, no CORS headers are emitted. Additionally, a **string** origin is compared with exact equality — `https://www.example.com` does not match a configured `https://example.com`.

**Fix** — configure CORS explicitly, using an array or callback for multiple origins:

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({
  PORT: 3000,
  CORS: {
    origin: ['https://app.example.com', 'https://admin.example.com'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  },
});

const shutdown = await app.start();
```

Preflight (`OPTIONS`) requests are answered with `204`, and disallowed origins simply receive no `Access-Control-Allow-Origin` header (the request itself still returns 200 — the browser enforces the block client-side).

---

### Error Responses and Middleware

#### 500 `INTERNAL_SERVER_ERROR` hides the real error

**Symptom** — in production mode (or whenever `ENV_MODE` is unset, since it defaults to `production`) unexpected errors produce a generic body:

```json
{
  "success": false,
  "error": {
    "code": "INTERNAL_SERVER_ERROR",
    "message": "Internal Server Error",
    "statusCode": 500,
    "requestId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "path": "/api/items"
  }
}
```

while development mode shows the original message and a `stack` property. Malformed JSON bodies and oversized payloads surface this way too — a body-parser failure is not an `ApiError`, so it maps to 500 instead of 400/413.

**Cause** — `errorHandlerMiddleware` is configured with `includeStack = !isProduction()`. Non-`ApiError` errors always become 500; the message and stack are only exposed outside production.

**Fix** — locally, run with `ENV_MODE: 'development'` to see the real message and stack. In production, log raw errors and translate expected parser failures with a terminal-phase error middleware:

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { NextFunction, Request, Response } from 'express';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

app.use({
  name: 'raw-error-observer',
  priority: 5,
  factory: async () => ({
    terminal: ({ express, logger }) => {
      express.use((err: Error, req: Request, res: Response, next: NextFunction) => {
        // Full message and stack, before the framework formats the response
        void logger.error(`Unhandled error at ${req.method} ${req.path}: ${err.message}`, {
          stack: err.stack ?? '',
        });

        // Translate body-parser failures, which are not ApiErrors
        const bodyParserError = err as Error & { type?: string };
        if (bodyParserError.type === 'entity.too.large') {
          res.status(413).json({
            success: false,
            error: {
              code: 'PAYLOAD_TOO_LARGE',
              message: 'Request body too large',
              statusCode: 413,
              timestamp: new Date().toISOString(),
            },
          });
          return;
        }

        next(err); // hand everything else to the built-in error handler
      });
    },
  }),
});

const shutdown = await app.start();
```

For failures your business logic expects (missing row, conflict), throw the typed errors (`NotFoundError`, `ConflictError`, …) instead of plain `Error` — those always produce proper status codes, messages, and details in every environment.

---

### TypeScript Compiler Errors

#### TS1479 / `ERR_REQUIRE_ESM` — CommonJS project imports WebAFX

**Symptom**

```
error TS1479: The current file is a CommonJS module whose imports will produce 'require' calls;
however, the referenced file is an ECMAScript module and cannot be imported with 'require'.
```

or at runtime:

```
Error [ERR_REQUIRE_ESM]: require() of ES Module ... not supported
```

**Cause** — WebAFX is ESM-only. A CommonJS consumer cannot `import`/`require` it when the module graph uses top-level await.

**Fix** — switch the project to ESM and use `NodeNext` module resolution:

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2023",
    "strict": true
  }
}
```

```json
{
  "type": "module"
}
```

If a full migration is not possible, load WebAFX through a dynamic import instead of a static one:

```typescript fragment
const { WebApplication } = await import('blendsdk/webafx');
```

---

#### TS2307 — `Cannot find module 'express' or its corresponding type declarations`

**Symptom** — the editor and `tsc` cannot resolve `express`, `zod`, or their types after installing only the umbrella package.

**Cause** — `express` and `zod` are peer dependencies of WebAFX; the application must install them itself, together with the Express type declarations.

**Fix**

```bash
npm install blendsdk express zod
npm install -D @types/express
```

Then import from the public entry points only:

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';
import { z } from 'zod';
```

---

#### TS2339 — `Property 'services' does not exist on type 'Request<...>'`

**Symptom** — a handler typed with Express's `Request` cannot access `req.services`:

```
error TS2339: Property 'services' does not exist on type 'Request<ParamsDictionary, any, any, ParsedQs, Record<string, any>>'.
```

**Cause** — `req.services` and `req.id` come from a global Express augmentation that ships with the package types (`type.ts` contains `declare global { namespace Express { interface Request { … } } }`). The augmentation is only in effect when the WebAFX types are loaded in your program and when the project resolves a single copy of the Express type declarations. Duplicate `@types/express` versions (for example, pulled in transitively) break the merge.

**Fix** — import from the package in every file that uses `req.services` (any symbol import is enough to load the types), and check for duplicates:

```bash
npm ls @types/express   # must resolve to a single v5 copy
```

```typescript
import { BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class UsersController extends BaseController {
  routes() {
    return [this.route().get('/').handle(this.list)];
  }

  private async list(req: Request, res: Response): Promise<void> {
    const { query } = req.services.getInput<{ query: { page?: string } }>();
    this.ok(res, { page: query.page ?? '1' });
  }
}
```

---

#### TS2515 — `Non-abstract class 'X' does not implement inherited abstract member 'routes' from class 'BaseController'`

**Symptom**

```
error TS2515: Non-abstract class 'UsersController' does not implement inherited abstract member 'routes' from class 'BaseController'.
```

**Cause** — `BaseController.routes()` is abstract; a subclass compiles only after implementing it and returning `RouteDefinition[]`.

**Fix** — implement `routes()` and register the controller:

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class UsersController extends BaseController {
  routes() {
    return [this.route().get('/').handle(this.list)];
  }

  private async list(_req: Request, res: Response): Promise<void> {
    this.ok(res, { users: [] });
  }
}

const app = new WebApplication({ PORT: 3000 });
app.registerController('/users', UsersController);
const shutdown = await app.start();
```

---

#### TS2339 — `Property 'get' does not exist on type 'RouteDefinition'`

**Symptom** — chaining after `handle()` fails to compile:

```
error TS2339: Property 'get' does not exist on type 'RouteDefinition'.
```

**Cause** — `handle()` finalizes and returns a plain `RouteDefinition`, not the builder. Nothing is chainable after it — put `handle()` last:

```typescript fragment
// ❌ this.route().get('/a').handle(this.a).get('/b') — RouteDefinition has no .get()
// ✅ one builder per route:
return [
  this.route().get('/a').handle(this.a),
  this.route().get('/b').handle(this.b),
];
```

---

## Debugging Strategies

### 1. Reproduce the failing request in isolation with supertest

1. Create a throwaway script that boots the same controllers.
2. Use `PORT: 0` and `ENV_MODE: 'test'` so the app never binds a fixed port.
3. Send the request with supertest against `app.express` — no network involved.
4. Inspect `status` and `body`, then always shut the app down in a `finally`.

```typescript
import supertest from 'supertest';
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class ItemsController extends BaseController {
  routes() {
    return [this.route().get('/items').handle(this.list)];
  }

  private async list(_req: Request, res: Response): Promise<void> {
    this.ok(res, { items: [] });
  }
}

const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });
app.registerController('/api', ItemsController);

const shutdown = await app.start();
try {
  const response = await supertest(app.express).get('/api/items?page=2');
  console.log(response.status);
  console.log(JSON.stringify(response.body, null, 2));
} finally {
  await shutdown();
}
```

### 2. Turn up framework logging

1. Set `LOG_LEVEL: 'INFO'` (or `'DEBUG'`) in application config. The application logger is constructed with the configured level and defaults to `ERROR`, so startup and routing information is invisible until you raise it.
2. Run with `DEBUG=true` in the environment to force `debug()` output (such as per-route wiring lines) even when the configured level would suppress it.
3. Look for these exact lines — they tell you what was actually mounted:

| Level | Line | Meaning |
|-------|------|---------|
| INFO | `3 routes registered for ItemsController.` | Controller contributed routes (a `0 routes` line means `routes()` returned an empty array) |
| INFO | `Total: 3 routes registered.` | All controllers combined |
| INFO | `Server listening on http://localhost:3000 (development)` | Server is up, with the effective env mode |
| INFO | `Setting ENV to development` / `CORS is enabled` / `Request BODY_LIMIT is set to 10mb` | Core middleware configuration |
| DEBUG | `Routing /api/items through get->ItemsController->list` | Exact method, class, and handler wiring per route |

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'development',
  LOG_LEVEL: 'DEBUG',
});
```

```bash
DEBUG=true node ./dist/server.js
```

### 3. Run in development mode to see real errors and stacks

1. Set `ENV_MODE: 'development'` while debugging.
2. Reproduce the failing request and inspect the error envelope: `error.message` is the real message, `error.stack` is included, `error.requestId` and `error.path` pinpoint the request.
3. Never enable this in production — stacks leak internals.

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
const shutdown = await app.start();
// Errors now return { success: false, error: { message: '<real message>', stack: '...' } }
```

### 4. Correlate requests with request IDs

1. Send any request and read the `X-Request-ID` response header.
2. Inside handlers, `getRequestId()` returns the same value anywhere in the async call chain (it is propagated through `AsyncLocalStorage`, no parameter passing needed).
3. Plug a `StructuredLogger` with a `contextFn` so every log entry carries the request ID automatically.

```typescript
import {
  WebApplication,
  BaseController,
  StructuredLogger,
  getRequestContext,
} from 'blendsdk/webafx';
import type { Request, Response } from 'express';

const logger = new StructuredLogger('API', 'INFO', () => {
  const context = getRequestContext();
  return context ? { requestId: context.requestId } : {};
});

class PingController extends BaseController {
  routes() {
    return [this.route().get('/ping').handle(this.ping)];
  }

  private async ping(_req: Request, res: Response): Promise<void> {
    await logger.info('ping received');
    this.ok(res, { pong: true });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.setLogger(logger);
app.registerController('/api', PingController);
const shutdown = await app.start();
// Every log line and every error envelope now carries the same requestId
// that is returned in the X-Request-ID response header.
```

### 5. Observe raw errors before the framework formats them

1. Build a plugin whose `terminal` hook mounts a 4-argument (error) middleware — this position sees errors from controller routes and body parsers.
2. Log `err.message` and `err.stack` (this works even when `ENV_MODE` is `production`).
3. Always call `next(err)` so the built-in error handler still produces the client response.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { NextFunction, Request, Response } from 'express';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

app.use({
  name: 'error-observer',
  priority: 5,
  factory: async () => ({
    terminal: ({ express, logger }) => {
      express.use((err: Error, req: Request, _res: Response, next: NextFunction) => {
        void logger.error(`Unhandled error at ${req.method} ${req.path}: ${err.message}`, {
          stack: err.stack ?? '',
        });
        next(err);
      });
    },
  }),
});

const shutdown = await app.start();
```

### 6. Audit registrations and health inside a running app

1. Register a temporary diagnostics controller that reports service registration state.
2. Hit `GET /__debug/services` to see which services exist — the most common auth bug is a missing or misspelled principal service.
3. Hit `GET /health`: it returns `{ "health": true, "timestamp": ... }` when every plugin health check passes, or `503` with `{ "health": false, ... }` when one fails. Only plugins that expose `health()` are aggregated.
4. Remove the diagnostics controller before production.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class DiagnosticsController extends BaseController {
  routes() {
    return [
      this.route()
        .get('/services')
        .handle(async (req: Request, res: Response) => {
          this.ok(res, {
            registered: req.services.getRegisteredServices(),
            hasUserService: req.services.isRegistered('user'),
          });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/__debug', DiagnosticsController);
const shutdown = await app.start();
```

### 7. Verify middleware behavior over HTTP with curl

1. CORS — send an allowed `Origin` and check for the allow header:

```bash
curl -s -i -H "Origin: https://app.example.com" http://localhost:3000/api/items | grep -i access-control
```

2. Rate limiting — check the quota headers:

```bash
curl -s -i http://localhost:3000/api/search | grep -i x-ratelimit
```

3. CSRF (double-submit mode) — header must equal the cookie:

```bash
curl -s -i -X POST http://localhost:3000/api/items \
  -H "Content-Type: application/json" \
  -H "x-csrf-token: token-value" \
  -b "csrf=token-value" \
  -d '{"name":"Widget"}'
```

---

## Known Pitfalls

- **`ENV_MODE` defaults to `production`.** If you never set it, `isProduction()` returns `true`: error responses hide messages and stacks, and shutdown uses `SHUTDOWN_TIMEOUT`. Set `ENV_MODE: 'development'` locally so you are not debugging blind.

- **`process.env` is never read for configuration.** `PORT`, `DEBUG`, and `SHUTDOWN_TIMEOUT` in the shell do nothing — only the constructor config and `.env.js` / `.env.local.js` files count. Bridge explicitly if you need env vars: `PORT: Number(process.env.PORT ?? 3000)`.

- **The app logger starts at `ERROR`.** Startup, route registration, and request timing lines are all INFO; you see them only with `LOG_LEVEL: 'INFO'` (or higher) in config. `DEBUG=true` forces `debug()` output only — it does not raise the INFO threshold. Some framework-internal loggers fall back to the `LOG_LEVEL` environment variable, so setting both is the safest way to get a verbose run.

- **Register plugins and controllers before `start()`.** Plugin installation and route mounting happen once, inside `start()`. Calling `app.use()` or `registerController()` afterwards has no effect — routes 404 and plugin middleware never runs.

- **Route middleware runs before validation and param storage.** The per-route chain is `[...route.middleware, guard]`, and the guard is what authenticates, authorizes, validates, and stores `request-params` / `request-input`. Inside route (or plugin/global) middleware, `getParams()` is `{}` and `getInput()` is empty. Move logic that needs validated input into the handler.

- **Merged validation data has precedence and is lossy.** `.validate()` parses `{ ...params, ...query, ...body }` — body wins over query, query wins over params. The parsed (Zod) result replaces the merged value, so unknown keys are stripped by default. Use `getInput()` to keep the three raw sources.

- **`dependencies` orders resolution; it does not inject.** Listing `dependencies: ['database']` makes the container resolve `database` first, but the factory must still call `await container.get('database')` itself.

- **Principal services fail closed.** `secure()` resolves the default `'user'` service; `secure('client')` resolves that name. Missing or falsy principal → 401. A blank name is rejected at build time and fails closed at request time — it never makes a route public.

- **`getUser()` only reads the already-resolved `user` entry.** It is synchronous and never triggers resolution, and it ignores custom principal names. On secure routes the guard resolves the principal first; elsewhere use `await req.services.get<Principal>('name', undefined)`.

- **Static roots resolve against `process.cwd()`, and dotfiles are ignored.** A relative `root` breaks in any environment with a different working directory. The default `dotfiles: 'ignore'` means `.well-known/acme-challenge` and friends return 404 — set `dotfiles: 'allow'` when you need them.

- **Body parsers cover JSON and URL-encoded only.** Multipart form posts yield an empty `req.body` (surfacing later as "required field" validation errors). Malformed JSON or payloads above `BODY_LIMIT` (default `10mb`) become 500 `INTERNAL_SERVER_ERROR`, not 400/413 — translate them with a terminal error middleware if clients need accurate codes.

- **CORS is off until configured — and `CORS: true` pairs a wildcard origin with credentials.** Browsers reject `Access-Control-Allow-Origin: *` for credentialed requests, so use explicit origins whenever `credentials: true`. String origins are exact-match only.

- **The rate limiter is per-process and keyed by `req.ip`.** Counts are not shared between instances or cluster workers, so each process allows the full quota. `req.ip` follows the `trust proxy` setting (enabled by default, one hop) — misconfigured proxies let clients spoof the key.

- **`SHUTDOWN_TIMEOUT` only applies in production.** In development and test, the connection drain delay is fixed at 1 second regardless of the setting, so slow requests may be force-closed sooner than expected.

- **Upstream `X-Request-ID` values must be valid UUIDs.** Anything else (wrong length, non-hex characters, injected markup) is discarded and replaced with a fresh UUIDv4 — if your gateway emits non-UUID trace IDs, correlation breaks by design.

- **The SPA fallback is intentionally narrow.** It serves `index.html` only for `GET` requests whose path has no file extension and whose `Accept` header includes `text/html`. JSON API calls and missing `.css`/`.js` files still return proper 404 JSON. Do not widen these guards to "fix" a fallback — add a route or serve the real file.

- **Paginated routes need `envelope: 'body'` in `.openapi()`.** Without it, `blendsdk/codegen` clients unwrap the top-level `data` property and silently drop `pagination`. Set `envelope: 'body'` on any route that uses `BaseController.paginated()`.

- **`csrfPlugin()` with no options rejects every mutating request.** Fail-closed is by design — there is nothing to compare against. Configure `expectedToken` or `cookie`. In double-submit mode, the middleware only compares; your application must set the cookie.

- **A throwing `dispose()` rejects `shutdown()`.** `disposeAll()` runs all disposals via `Promise.all`, so one rejected disposal fails the shutdown. Wrap cleanup work in `try/catch` inside `dispose` to guarantee the rest of the shutdown sequence runs.

- **Express 5 rejects bare `*` wildcard patterns.** Adding `app.express.get('*', ...)` fails at registration with a path-to-regexp "Missing parameter name" error. Use `app.use()` catch-alls (or the plugin `terminal` phase) instead; route-level wildcards need named forms such as `/{*splat}`.

- **`preparseServiceNames()` logs a deprecation warning.** The exact text is `[WebAFX DEPRECATION WARNING] preparseServiceNames() is deprecated. Use const objects instead: const ServiceNames = { KEY: "KEY" } as const;`. Replace static-class-property name holders with `as const` objects to silence it.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
