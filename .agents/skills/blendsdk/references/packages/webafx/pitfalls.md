> **Package**: `blendsdk/webafx`

# webafx Best Practices

`blendsdk/webafx` is deliberately opinionated: a managed lifecycle, a dependency-injection container, Zod validation, standard response envelopes, and security middleware wired in a fixed order. Most mistakes with the package come from working around those mechanisms instead of with them.

Each practice below shows a ❌ Wrong and a ✅ Correct approach, followed by why the wrong one is problematic. Focused excerpts are marked `typescript fragment`; complete, runnable programs use `typescript`.

## Reference application

Every example builds on this minimal application:

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class GreetingController extends BaseController {
  routes() {
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
app.registerController('/api', GreetingController);

const shutdown = await app.start();
// GET http://localhost:3000/api/greeting
//   → { "success": true, "data": { "message": "Hello from WebAFX" } }
// GET http://localhost:3000/health
//   → { "health": true, "timestamp": "..." }
//
// The server now runs. SIGTERM and SIGINT trigger the managed graceful
// shutdown (connection draining, plugin shutdown, service disposal).
// Call `await shutdown()` to stop it programmatically.
```

---

## Do / Don't Pairs

| # | Practice | Rule in one line |
|---|----------|------------------|
| 1 | Public imports | Import only from the package root |
| 2 | Error handling | Throw typed errors; let the built-in handler format responses |
| 3 | Validation | Validate with Zod and read the validated input |
| 4 | Success responses | Use `ok()`, `created()`, `paginated()`, `noContent()` |
| 5 | Services | Register and resolve everything through the container |
| 6 | Route security | Use `.secure()` / `.authorize()` instead of in-handler checks |
| 7 | Fallback middleware | Mount catch-alls in the plugin `terminal` phase |
| 8 | Configuration | Read from `ApplicationSettings`, not `process.env` |
| 9 | Request context | Use `getRequestId()` instead of plumbing IDs |

### 1. Import only from the package root

**❌ Wrong**

```typescript fragment
// Deep imports into dist/ (or the repo's src/) bypass the public API
// contract. Node resolves the package through its exports map and
// rejects them at runtime with ERR_PACKAGE_PATH_NOT_EXPORTED.
import { WebApplication } from 'blendsdk/webafx/dist/application/web-application.js';
import { errorHandlerMiddleware } from 'blendsdk/webafx/dist/application/error-handler-middleware.js';
```

**✅ Correct**

```typescript fragment
// The package root is the only supported entrypoint
import { WebApplication, BaseController, NotFoundError } from 'blendsdk/webafx';
```

**Why:** The package publishes a single `exports` entry (`"."`). Everything the framework intends you to use is re-exported there — including the error handler and the request-ID middleware, which `WebApplication` installs for you in a fixed order. Internal modules are private and free to move between releases; code that deep-imports them breaks on upgrades and can bypass the framework's middleware ordering.

### 2. Throw typed errors — never hand-write error responses

**❌ Wrong**

```typescript fragment
this.route()
  .get('/items/:id')
  .handle(async (req, res) => {
    const item = await items.findById(req.params.id);
    if (!item) {
      // Ad-hoc error shape: no logging, no request ID, no timestamp —
      // different from every other error the API returns
      res.status(404).json({ success: false, error: 'Item not found' });
      return;
    }
    this.ok(res, item);
  });
```

**✅ Correct**

```typescript fragment
this.route()
  .get('/items/:id')
  .handle(async (req, res) => {
    const item = await items.findById(req.params.id);
    if (!item) {
      // The built-in handler renders this as:
      // { success: false, error: { code: "NOT_FOUND", message: "Item not found",
      //   statusCode: 404, timestamp, requestId, path } }
      throw new NotFoundError('Item not found');
    }
    this.ok(res, item);
  });
```

**Why:** One central error handler gives every failure the same `StandardErrorResponse` envelope, logs it through the configured logger with the request ID, and applies production-safe masking: unknown errors become a generic `500 INTERNAL_SERVER_ERROR`, and raw messages plus stack traces are only included outside production. A hand-written response bypasses all of that, and clients end up parsing several error shapes. The handler is also resilient — if the logger itself throws, the client still receives the error response.

### 3. Validate with Zod and read the validated input

**❌ Wrong**

```typescript fragment
this.route().post('/users').handle(async (req, res) => {
  // Hand-rolled validation: duplicated in every handler, inconsistent
  // messages, and easy to under-check (body is untyped `any`)
  const { name, email } = req.body as { name?: string; email?: string };
  if (!name || !email) {
    throw new BadRequestError('name and email are required');
  }
  this.created(res, await users.create({ name, email }));
});
```

**✅ Correct**

```typescript fragment
import { z } from 'zod';

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});

this.route()
  .post('/users')
  .validate(createUserSchema) // runs before the handler; failures → 422
  .handle(async (req, res) => {
    // Read the validated, merged params/query/body — not raw req.body
    const input = req.services.getParams<{ name: string; email: string }>();
    this.created(res, await users.create(input));
  });
```

**Why:** `.validate()` validates the merged `params` + `query` + `body` before the handler runs and rejects with `422 VALIDATION_ERROR` plus field-level `details`, so the handler can trust what it reads. Hand-rolled checks are duplicated across handlers, drift in wording, and get forgotten on the next route. Reading `req.body` directly after declaring a schema re-introduces unvalidated input. Use `getInput()` instead of `getParams()` when you must keep the sources apart (see Security Considerations).

### 4. Use the response helpers for the standard envelope

**❌ Wrong**

```typescript fragment
this.route().get('/users').handle(async (_req, res) => {
  const rows = await users.page(2, 50);
  const total = await users.count();
  // Hand-rolled envelope: pagination metadata drifts handler by handler
  res.json({ success: true, data: rows, total });
});
```

**✅ Correct**

```typescript fragment
this.route().get('/users').handle(async (_req, res) => {
  const page = 2;
  const limit = 50;
  const rows = await users.page(page, limit);
  const total = await users.count();
  this.paginated(res, rows, total, page, limit);
  // → { success: true, data: [...], pagination: { total, page, limit, pages } }
});
```

**Why:** `ok()`, `created()`, `paginated()`, and `noContent()` produce one envelope shape for the whole API — `201` for `created()`, `204` with an empty body for `noContent()`, and `pages` computed consistently by `paginated()`. Hand-rolled envelopes drift handler by handler, which breaks typed clients and frontend parsers; a hand-rolled `204` also risks sending a body, which violates HTTP.

### 5. Register and resolve services through the container

**❌ Wrong**

```typescript fragment
// Module-scope singleton: created at import time, shared across every
// WebApplication in the process, impossible to replace in tests,
// and never disposed
const pool = createPool(process.env.DATABASE_URL as string);

class UsersController extends BaseController {
  routes() {
    return [
      this.route().get('/users').handle(async (_req, res) => {
        this.ok(res, await pool.query('SELECT * FROM users'));
      }),
    ];
  }
}
```

**✅ Correct**

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface DbPool {
  query(sql: string): Promise<Array<Record<string, unknown>>>;
  end(): Promise<void>;
}

// Stand-in for your real driver — replace with the actual pool implementation.
function createPool(_url: string): DbPool {
  return {
    query: async () => [{ id: 1, name: 'Ada' }],
    end: async () => undefined,
  };
}

class UsersController extends BaseController {
  routes() {
    return [
      this.route()
        .get('/users')
        .handle(async (req: Request, res: Response) => {
          const pool = await req.services.get<DbPool>('db-pool');
          this.ok(res, await pool.query('SELECT * FROM users'));
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

app.registerService({
  name: 'db-pool',
  type: 'singleton',
  factory: (_container, settings) =>
    createPool(settings.get<string>('DATABASE_URL', 'postgres://localhost/app')),
  dispose: pool => pool.end(),
});

app.registerController('/api', UsersController);

const shutdown = await app.start();
```

**Why:** The container is owned by the application: singletons are created once, shared across all request containers, and passed to `dispose` on shutdown; per-request services receive the live `req`/`res` context and are discarded with the request. A module-scope singleton bypasses all of that — it leaks state between `WebApplication` instances (and test runs), cannot be swapped per environment, and never runs cleanup code. Register definitions once, before `app.start()`, and resolve inside the request with `req.services.get<T>()`.

### 6. Protect routes with `.secure()` and `.authorize()`

**❌ Wrong**

```typescript fragment
this.route().get('/admin/report').handle(async (req, res) => {
  // Auth logic duplicated in every handler: easy to forget on a new
  // route, and the route is reachable before the check runs
  const user = req.services.getUser<{ role: string }>();
  if (!user) {
    throw new UnauthorizedError();
  }
  if (user.role !== 'admin') {
    throw new ForbiddenError();
  }
  this.ok(res, await reports.generate());
});
```

**✅ Correct**

```typescript fragment
this.route()
  .get('/admin/report')
  .secure() // 401 when no principal can be resolved
  .authorize((_req, user: { role: string }) => user.role === 'admin') // 403 when false
  .handle(async (_req, res) => {
    this.ok(res, await reports.generate());
  });
```

**Why:** The guard runs before the handler, so a secured route cannot execute without a resolved principal, and authorization failures produce consistent `401`/`403` responses from one place. In-handler checks are easy to forget (routes are public by default) and hard to audit — with the builder you can grep for `.secure(`. Applications that serve multiple caller types select the principal per route with `.secure('client')` or `this.authenticated('client')`.

### 7. Mount fallback middleware in the plugin terminal phase

**❌ Wrong**

```typescript fragment
app.use({
  name: 'spa-fallback',
  factory: async ({ express }) => {
    // Factory-phase middleware runs BEFORE controllers — this catch-all
    // answers every GET with index.html and swallows your API routes
    express.use((req, res, next) => {
      if (req.method === 'GET') {
        res.sendFile('index.html');
        return;
      }
      next();
    });
    return {};
  },
});
```

**✅ Correct**

```typescript fragment
app.use({
  name: 'spa-fallback',
  priority: 20,
  factory: async () => ({
    // Terminal hooks run AFTER controllers and /health, but BEFORE the
    // 404 handler — only genuinely unmatched routes reach this middleware
    terminal: ({ express }) => {
      express.use((req, res, next) => {
        if (req.method === 'GET' && req.accepts('html') && !req.path.includes('.')) {
          res.sendFile('index.html', { root: 'client/build' });
          return;
        }
        next();
      });
    },
  }),
});
```

**Why:** Middleware mounted in a plugin factory runs before controllers, so a catch-all silently shadows every controller route — including `/health` and routes like an OIDC login `GET` that look like HTML navigation. The `terminal` phase exists precisely to avoid that: it runs in plugin priority order after controllers are mounted. If you only need standard static serving or an SPA fallback, don't write this at all — `staticFilesPlugin({ root: './client/build', spa: true })` implements exactly the guards above (GET, `Accept: text/html`, extension-less path).

### 8. Read configuration from `ApplicationSettings` — never from `process.env`

**❌ Wrong**

```typescript fragment
// Scattered, unvalidated reads: a typo silently yields undefined,
// values diverge between config files, real env vars, and defaults,
// and tests must mutate process.env to change behavior.
// Note: webafx's switch is ENV_MODE — NODE_ENV is never consulted.
const port = Number(process.env.PORT ?? 3000);
const isProd = process.env.NODE_ENV === 'production';
const apiKey = process.env.API_KEY ?? '';
```

**✅ Correct**

```typescript fragment
// In application setup — values are Zod-validated at startup, and
// environment files (.env.js / .env.local.js) load into the same object
const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production', LOG_LEVEL: 'INFO' });

// In controllers and plugins (this.settings / injected ApplicationSettings)
const isProduction = this.settings.isProduction();
const apiKey = this.settings.get<string>('API_KEY', '');
```

**Why:** `ApplicationSettings` is validated with Zod the moment it is constructed or loaded: a bad `PORT` (`-1`, `70000`), an unknown `ENV_MODE`, or a non-boolean `DEBUG` throws at startup with a message naming every offending key — instead of failing mysteriously at runtime. The settings object is the single source of truth; `process.env` is never mutated, so multiple applications and test runs cannot interfere with each other. `get<T>()` is typed, `getAll()` returns a copy, and custom keys pass through for app-specific configuration.

### 9. Use the request context instead of threading IDs

**❌ Wrong**

```typescript fragment
this.route().get('/orders/:id').handle(async (req, res) => {
  // A client-controlled header copied into every function signature —
  // and there is no guarantee it is even a valid identifier
  const requestId = req.headers['x-request-id'] as string;
  await orderService.load(req.params.id, requestId);
  this.ok(res, { loaded: true });
});
```

**✅ Correct**

```typescript fragment
import { getRequestId } from 'blendsdk/webafx';

this.route().get('/orders/:id').handle(async (req, res) => {
  // The framework assigns a validated request ID and propagates it via
  // AsyncLocalStorage — nothing needs to be passed around
  await orderService.load(req.params.id);
  this.ok(res, { loaded: true, requestId: getRequestId() });
});

// Deeper in the async call chain, with any Logger instance:
logger.info('order loaded', { requestId: getRequestId() });
```

**Why:** The framework installs a request-ID middleware for you: an incoming `X-Request-ID` is reused only when it is a valid UUID, otherwise a fresh one is generated — malformed or hostile values can never propagate into logs and downstream systems. The ID is stored in `AsyncLocalStorage` and exposed via `getRequestId()`/`getRequestContext()` anywhere in the request's async chain, the response always carries `X-Request-ID`, and error bodies include `requestId` automatically.

---

## Anti-Patterns

### Reaching for the deprecated `preparseServiceNames()`

```typescript fragment
// ❌ Deprecated: prints "[WebAFX DEPRECATION WARNING]" on every call
// and is scheduled for removal in the next major version
class ServiceNames {
  static CACHE: string;
  static DATABASE: string;
}
preparseServiceNames(ServiceNames);

// ✅ Plain const object: nothing to execute, literal types,
// autocompletion, and no warning
export const ServiceNames = {
  CACHE: 'CACHE',
  DATABASE: 'DATABASE',
} as const;
```

The function still works, but it warns at runtime and will disappear. A const object with `as const` gives the same ergonomics with literal union types and zero runtime cost.

### Expecting duplicate registrations to overwrite

Registering a second plugin or service under an existing name fails immediately — `Plugin "x" is already registered` / `Service "x" is already registered` — at registration time, not at request time. This is fail-fast by design: silent overwrites used to hide real bugs, such as two plugins fighting over the same middleware. A rejected duplicate leaves the original definition in place; for an intentional instance override use `ServiceContainer.set(name, instance)`, and give everything distinct names. Note that `staticFilesPlugin` derives its name from the prefix:

```typescript fragment
app.use(staticFilesPlugin({ root: './public', prefix: '/assets' }));
app.use(staticFilesPlugin({ root: './public', prefix: '/assets' }));
// → Error: Plugin "static-files:/assets" is already registered
```

### Storing per-request data in singletons

```typescript fragment
// ❌ Singleton + request-scoped data: the cached instance is shared by
// every later request — the first caller's identity leaks everywhere.
// If resolved outside a request it instead throws:
// 'Service "user" is per-request and can only be accessed during HTTP request handling'
app.registerService({
  name: 'audit-logger',
  type: 'singleton',
  factory: async container => {
    const user = await container.get('user');
    return { user, entries: [] as string[] };
  },
});

// ✅ Per-request service: a fresh instance per request, built with that
// request's principal and discarded with it
app.registerService({
  name: 'audit-logger',
  type: 'per-request',
  factory: async container => {
    const user = await container.get('user');
    return { user, entries: [] as string[] };
  },
});
```

Per-request services can only be resolved while a request is being handled. If a service does not actually need request data, make it a `singleton`; if it does, keep it `per-request` and resolve it from `req.services`.

### Assuming the in-memory rate limiter is a cluster-wide limit

`rateLimitMiddleware` stores counters in a per-process `Map` (suitable for single-instance deployments, as its documentation states). Behind a load balancer with N instances, each instance counts independently, so the effective limit is N × `maxRequests`, and a restart resets the counters — back it with Redis via a plugin when the limit must be global. The key matters too: the default is `req.ip`, which without `TRUST_PROXY: true` is the proxy address, so every client shares one bucket (blindly trusting — and re-emitting — `X-Forwarded-For` instead lets clients spoof their bucket). A custom `keyExtractor` should use values you can verify, ideally an authenticated identity — client-supplied headers alone are not trustworthy.

### Fire-and-forget async work in handlers

```typescript fragment
// ❌ Not awaited: a rejection never reaches the error handler, and the
// client is told "created" even when the notification failed
sendConfirmationEmail(email);
this.created(res, { queued: true });

// ✅ Await critical work so failures produce a proper error response
await sendConfirmationEmail(email);
this.created(res, { queued: true });
```

Express 5 forwards rejected promises from async handlers to the error middleware — but only if you await them. A floating promise's rejection becomes an unhandled rejection, which by default terminates the Node process. If the work must not block the response, hand it to a durable queue and await the enqueue step.

### Leaking servers and signal handlers in tests

```typescript fragment
import { afterEach, test } from 'vitest';

// ❌ No cleanup: the started server and its SIGTERM/SIGINT listeners
// survive the test, leaking handles and ports into later runs
test('greets without cleanup', async () => {
  const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
  await app.start();
});

// ✅ Capture the shutdown function and always call it
let shutdown: (() => Promise<void>) | undefined;

afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
});

test('greets with cleanup', async () => {
  const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
  shutdown = await app.start();
});
```

`start()` returns the shutdown function and throws `Application already started` if called twice; `shutdown()` is idempotent and removes the signal handlers it registered — but only if you call it. Capture it in `afterEach` or `finally` so a failing assertion cannot leak the app.

---

## Performance Tips

### Choose service lifetimes deliberately

```typescript fragment
// ✅ Expensive and shared: one pool for the whole process,
// disposed once on shutdown
app.registerService({
  name: 'db-pool',
  type: 'singleton',
  factory: () => createPool(),
  dispose: pool => pool.end(),
});

// ✅ Cheap and request-bound: created per request, discarded with it
app.registerService({
  name: 'request-meta',
  type: 'per-request',
  factory: (_container, _settings, req) => ({ ip: req.ip }),
});
```

A singleton factory runs at most once — the instance is cached in the application's registry and shared by every request container. A per-request factory runs once per request that resolves it. Making an expensive resource per-request means a new pool/client per request; making request-scoped data a singleton means cross-request leakage. Treat `routes()` as startup code: it runs once when the controller mounts, so define Zod schemas and middleware factories there (or at module scope), never inside handlers.

### Keep the event loop free

```typescript fragment
// ❌ Blocks the process — every concurrent request waits for this read
const template = readFileSync('./templates/email.html', 'utf8');

// ✅ Yields to the event loop while the disk works
const template = await readFile('./templates/email.html', 'utf8');
```

Node serves all requests on one thread. Synchronous work in a handler — `readFileSync`, large synchronous JSON processing, CPU-heavy hashing — blocks every other request, delays `/health`, and stalls graceful shutdown, since connection draining cannot complete while the loop is blocked. Use async I/O and push heavy CPU work to worker threads or a queue.

### Cache static assets on purpose

```typescript fragment
// Hashed build artifacts: cache for a year, never revalidate
app.use(staticFilesPlugin({
  root: './client/build/assets',
  prefix: '/assets',
  maxAge: '1y',
  immutable: true,
}));

// index.html + SPA fallback: default caching so deploys take effect
app.use(staticFilesPlugin({ root: './client/build', spa: true }));
```

`staticFilesPlugin` maps `maxAge` to `Cache-Control` (time strings like `'1d'` become `max-age=86400`) and applies `immutable` for permanent caching — safe only for content-hashed filenames (`main.4f8a1c.js`), where repeat visits then transfer no bytes at all. For files you cannot hash, rely on the defaults: ETag and Last-Modified are enabled, so browsers revalidate cheaply and receive `304` responses without bodies. Serving hashed assets with `max-age=0` and caching `index.html` as immutable are both common — and expensive — mistakes.

### Log at the right level

| `LOG_LEVEL` | Emitted |
|-------------|---------|
| `'ERROR'` (default) | Errors |
| `'WARN'` | Errors + warnings |
| `'INFO'` | Errors + warnings + info |
| `'DEBUG'` (or `DEBUG=true`) | Everything, including debug |

The logger checks the level before formatting, so suppressed lines cost only a numeric comparison — but every emitted line pays a `JSON.stringify` for its data payload. The default is `ERROR`; set `LOG_LEVEL: 'INFO'` in production when you want lifecycle visibility, and never enable `DEBUG=true` there (it force-enables debug lines regardless of level). Use `StructuredLogger` when log aggregators parse your output — it emits one JSON object per line.

### Fail fast with validation

Attach `.validate()` to every route that accepts input. The schema rejects malformed requests with a `422` before the handler runs, so bad input never triggers database round trips, cache misses, or partial side effects. Because `routes()` executes once at startup, schema parsing is the only per-request cost — boundary validation is cheaper than defending against malformed data deeper in the stack.

### Keep `/health` checks shallow

Every `GET /health` awaits all registered plugin `health()` functions. Probes typically run every few seconds on every instance, so a deep check (test query, external ping) turns health checking into steady background load. Make checks cheap status reads — a "pool connected" flag rather than a live query. Plugins without a `health` function are excluded entirely, and when no plugin defines one, the health check returns healthy without doing any work.

---

## Security Considerations

### Keep the secure defaults

| Area | Default | Security effect |
|------|---------|-----------------|
| Environment mode | `ENV_MODE: 'production'` | Secure even before configuration loads; a failed config load cannot leak stack traces |
| Stack traces | Included only outside production | Implementation details stay server-side |
| Unknown errors | Generic `Internal Server Error`, `500` | Internal messages are not disclosed in production |
| HTTP headers | Helmet enabled; `X-Powered-By` removed | Baseline hardening headers on every response |
| Request IDs | Non-UUID `X-Request-ID` values replaced | Log-injection and spoofed values never propagate |
| Static dotfiles | `dotfiles: 'ignore'` | `.env`-style files are treated as non-existent |

Development and test modes intentionally include real error messages and stack traces — useful while building, unsafe in production. Keep `ENV_MODE: 'production'` in production and never enable `DEBUG` there.

### Never put sensitive data into `ApiError` messages or details

`ApiError` messages are sent to clients as-is in every environment (only stacks are environment-gated), and `details` — including `ValidationError` details — are serialized into the response body. Field-level context (which field failed, why) is fine; credentials, tokens, session IDs, connection strings, full request bodies, and PII are not. If you need internal context, log it via the request ID instead of attaching it to the error.

### Validate at the boundary; keep input sources apart

`.validate()` plus `getParams()`/`getInput()` means you never operate on raw `req.body` or `req.query`. Where the distinction matters, use `getInput()`: the merged view is `{ ...params, ...query, ...body }`, so a body field named `id` overwrites the URL param in the merged data — harmless for storage schemas, dangerous when an `id` drives authorization or resource selection.

```typescript fragment
interface UpdateInput {
  params: { id: string };
  query: { dryRun?: string };
  body: { name?: string };
}

const input = req.services.getInput<UpdateInput>();
// input.params.id is always the URL segment — the body cannot overwrite it
```

### Secure routes explicitly — the builder is the safety net

Routes are public unless marked. `.secure()` (or the `authenticated()` shorthand) requires a resolved principal and rejects with `401`; `.authorize(fn)` adds per-route checks and rejects with `403` when the principal is present but not permitted. Multi-caller systems select the principal per route (`.secure('client')`), and the builder validates inputs (`secure('')` throws). Hand-built `RouteDefinition` objects bypass that validation: the guard still fails closed for a blank `secure` value (401, never an open route), but omitting the field leaves the route public — prefer the builder and re-check any manual definitions.

### CORS narrows browsers, it does not authorize

```typescript fragment
const app = new WebApplication({
  PORT: 3000,
  CORS: {
    origin: ['https://app.example.com', 'https://admin.example.com'],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 7200,
  },
});
```

CORS is enforced by browsers, not by your server: a disallowed origin simply receives no `Access-Control-Allow-Origin` header, but the request still executes — never treat CORS as access control. Keep authorization in `.secure()`/`.authorize()`. Use explicit origin lists, or a dynamic callback that validates against an allowlist and calls `callback(null, false)` for everything else; reflecting arbitrary origins (`origin: true`) together with `credentials: true` lets any site issue credentialed cross-origin requests from a victim's browser. Use `CORS: false` for same-origin-only APIs.

### Proxies, rate limiting, and client identity

```typescript fragment
const app = new WebApplication({
  PORT: 3000,
  TRUST_PROXY: true, // behind nginx / a load balancer: req.ip is the real client
});
```

`rateLimitMiddleware` keys on `req.ip` by default. Behind a load balancer without `TRUST_PROXY: true`, every client appears as the proxy address and shares a single bucket — and any IP-based logic becomes meaningless. With it enabled, ensure the proxy is actually the one terminating connections and setting forwarding headers. Prefer `keyExtractor` keys you can verify (an authenticated identity) over client-supplied headers, and remember the built-in store is per-instance (see Anti-Patterns).

### Log request IDs — the validated ones

The request-ID middleware sanitizes `X-Request-ID`: it reuses the value only when it matches UUID format, otherwise generating a fresh UUID, and always returns `X-Request-ID` on the response. Use `getRequestId()` for correlation in your own logs, and don't echo unvalidated client-supplied strings into responses or log lines — the framework's validated ID is the one that ties an error response, the access logs, and your application logs together.

---

# webafx Testing Patterns

This guide shows how to test applications and code that use `blendsdk/webafx`. Every pattern mirrors the package's own suite in `packages/webafx/tests/`: unit-test the public building blocks directly, run a real `WebApplication` in-process behind `supertest` for integration coverage, and stub only the edges (services, logger, environment). All examples import exclusively from the package root — never from `src/` or `dist/` paths.

---

## Test Setup

### Test Dependencies

| Package | Purpose |
|---------|---------|
| `vitest` | Test runner, assertions, `vi` mocks, coverage runner |
| `supertest` | HTTP assertions against the Express app without binding a known port |
| `@types/supertest` | Type definitions for supertest |
| `@vitest/coverage-v8` | V8 coverage provider used by `vitest run --coverage` |

```bash
yarn add -D vitest supertest @types/supertest @vitest/coverage-v8
```

`express` and `zod` must also be installed in the consuming project — they are peer dependencies of `blendsdk/webafx`.

### Vitest Configuration

A minimal configuration is sufficient; webafx is a server-side framework, so the Node environment (Vitest's default) is the right one.

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node environment (default) — no DOM/JSdom needed
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
```

Tests import `describe`, `test`, `expect`, `vi`, and lifecycle hooks explicitly from `vitest` — the package's own suite never relies on globals.

### Running the Tests

| Script | Command | Purpose |
|--------|---------|---------|
| `yarn test:fast` | `vitest run --reporter=verbose` | Run the whole suite without Docker |
| `yarn test:watch` | `vitest watch --reporter=verbose` | Watch mode for local development |
| `yarn test:coverage` | `vitest run --coverage` | Run with V8 coverage |
| `yarn test` | `yarn docker:down && yarn docker:up && yarn test:fast` | Full run with the Docker Compose stack |
| `yarn docker:up` | `docker-compose -p webafx -f ./docker/docker-compose${MODE}.yml up -d && sleep 5` | Bring up backing services |
| `yarn docker:down` | `docker-compose ... down -v --remove-orphans` | Tear down backing services |

**Docker dependencies**: `packages/webafx/docker/` contains a Docker Compose stack used by the full `test` script. It is started with the project name `webafx`, and the `MODE` environment variable selects an alternative compose file (`docker-compose${MODE}.yml`, e.g. `MODE=.local` → `docker-compose.local.yml`). The unit and HTTP integration patterns shown in this document are self-contained — they run unchanged under `yarn test:fast` with no Docker.

### Test File Conventions

The package's suite uses three filename flavors; adopting them keeps intent obvious in a growing codebase:

| Pattern | Purpose |
|---------|---------|
| `*.test.ts` | Feature and integration suites (`cors.test.ts`, `http-integration.test.ts`, `service-container.test.ts`) |
| `*.spec.test.ts` | Specification tests derived from the requirements — a failure means the implementation is wrong, not the test |
| `*.impl.test.ts` | Implementation-detail tests for internals not covered by specification tests |

### Required Imports

```typescript
// typescript fragment — the public surface most test suites need
import {
  ApplicationSettings,
  BaseController,
  ConsoleLogger,
  RouteBuilder,
  ServiceContainer,
  StructuredLogger,
  WebApplication,
  rateLimitMiddleware,
  staticFilesPlugin,
  getRequestContext,
  getRequestId,
  requestContextStorage,
  ApiError,
  BadRequestError,
  NotFoundError,
  ValidationError,
} from 'blendsdk/webafx';
import type {
  ApplicationConfig,
  Logger,
  LogLevel,
  Plugin,
  PluginDefinition,
  RouteDefinition,
  ServiceDefinition,
  ServiceRegistry,
} from 'blendsdk/webafx';
```

Inside the monorepo, the package's own tests import from `../src/index.js`; consumer tests always import from `blendsdk/webafx`, which re-exports the `application/` and `errors/` modules.

### Shared Test Helpers

Keep the recurring helpers in a single `tests/helpers.ts` module:

```typescript
// tests/helpers.ts
import { vi } from 'vitest';
import { ApplicationSettings, ServiceContainer, WebApplication } from 'blendsdk/webafx';
import type { ApplicationConfig, Logger, ServiceRegistry } from 'blendsdk/webafx';

/**
 * Creates a bootable application with test-safe defaults:
 * - PORT: 0         → ephemeral port, no collisions between parallel tests
 * - ENV_MODE: 'test' → non-production behavior (stack traces in errors, etc.)
 * - LOG_LEVEL: 'ERROR' → quiet output unless something fails
 */
export function createTestApp(overrides: ApplicationConfig = {}): WebApplication {
  return new WebApplication({
    PORT: 0,
    ENV_MODE: 'test',
    LOG_LEVEL: 'ERROR',
    ...overrides,
  });
}

/** A ServiceContainer backed by a fresh, empty registry — isolates service state per test. */
export function freshContainer(): ServiceContainer {
  const registry: ServiceRegistry = { definitions: {}, singletons: {} };
  return new ServiceContainer(registry, new ApplicationSettings());
}

/** A Logger that records calls instead of writing to the console. */
export function createMockLogger() {
  return {
    error: vi.fn(async () => {}),
    warn: vi.fn(async () => {}),
    info: vi.fn(async () => {}),
    debug: vi.fn(async () => {}),
  } satisfies Logger;
}
```

Every integration suite follows one non-negotiable lifecycle rule: whatever `app.start()` returned must be awaited in `afterEach`, because `start()` opens a real server and registers `SIGTERM`/`SIGINT` process handlers.

---

## Unit Testing

Configuration, route definitions, error classes, and the service container are all testable directly against the public API — no server, no HTTP. Prefer synchronous tests where possible and `async/await` only where resolution or dynamic loading actually happens.

### ApplicationSettings

```typescript
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationSettings } from 'blendsdk/webafx';

describe('ApplicationSettings', () => {
  test('defaults ENV_MODE to production (secure by default)', () => {
    const settings = new ApplicationSettings();

    expect(settings.get('ENV_MODE')).toBe('production');
    expect(settings.isProduction()).toBe(true);
  });

  test('get() returns typed values with fallbacks', () => {
    const settings = new ApplicationSettings({ PORT: 3000, ENV_MODE: 'test' });

    expect(settings.get<number>('PORT', 4000)).toBe(3000);
    expect(settings.get<boolean>('DEBUG', false)).toBe(false);
  });

  test('getAll() returns a copy that cannot mutate internal state', () => {
    const settings = new ApplicationSettings({ PORT: 3000 });
    const config = settings.getAll();

    config.PORT = 9999;

    expect(settings.get('PORT')).toBe(3000);
  });

  test('the Zod schema rejects out-of-range values at construction time', () => {
    expect(() => new ApplicationSettings({ PORT: 70000 })).toThrow(/validation failed/i);
    expect(() => new ApplicationSettings({ SHUTDOWN_TIMEOUT: 400 })).toThrow(/validation failed/i);
  });

  test('custom properties pass through the schema', () => {
    const settings = new ApplicationSettings({
      PORT: 3000,
      CUSTOM_API_KEY: 'secret-key',
    });

    expect(settings.get('CUSTOM_API_KEY')).toBe('secret-key');
  });
});

describe('ApplicationSettings.loadFromFile', () => {
  let fixtureDir: string;

  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'webafx-config-'));

    // loadFromFile() uses dynamic import(), so fixtures must be loadable as
    // ESM modules — an .mjs extension guarantees that outside a package.
    writeFileSync(
      join(fixtureDir, 'valid.env.mjs'),
      'export default { PORT: 3100, ENV_MODE: "development" };'
    );
    writeFileSync(
      join(fixtureDir, 'invalid.env.mjs'),
      'export default { DEBUG: "true" };'
    );
  });

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('merges and validates a configuration file', async () => {
    const settings = new ApplicationSettings();

    await settings.loadFromFile(join(fixtureDir, 'valid.env.mjs'));

    expect(settings.get('PORT')).toBe(3100);
    expect(settings.get('ENV_MODE')).toBe('development');
    expect(settings.isProduction()).toBe(false);
  });

  test('rejects a configuration file with values that fail the schema', async () => {
    const settings = new ApplicationSettings();

    await expect(
      settings.loadFromFile(join(fixtureDir, 'invalid.env.mjs'))
    ).rejects.toThrow('Configuration file error');
  });

  test('silently ignores a missing configuration file', async () => {
    const settings = new ApplicationSettings();

    await expect(
      settings.loadFromFile(join(fixtureDir, 'missing.env.mjs'))
    ).resolves.toBeUndefined();
    expect(settings.get('PORT')).toBeUndefined();
  });
});
```

The invalid fixture demonstrates why runtime validation exists: values coming from a config file are invisible to the compiler, but the schema still rejects them. Note that a JSON-shaped config file cannot express an invalid `DEBUG`, which is precisely what `loadFromFile()` guards against.

### RouteBuilder

```typescript
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { RouteBuilder } from 'blendsdk/webafx';

/** Minimal handler — the builder only stores it. */
const handler = async (): Promise<void> => {};

describe('RouteBuilder', () => {
  test('builds a fully configured route definition', () => {
    const schema = z.object({ id: z.coerce.number() });
    const authorize = () => true;

    const route = new RouteBuilder()
      .get('/items/:id')
      .secure()
      .authorize(authorize)
      .validate(schema)
      .openapi({
        summary: 'Get item by ID',
        tags: ['items'],
        responses: [{ statusCode: 200, description: 'Item details' }],
      })
      .handle(handler);

    expect(route).toMatchObject({
      method: 'get',
      path: '/items/:id',
      secure: true,
      handler,
    });
    expect(route.authorize).toBe(authorize);
    expect(route.validation).toBe(schema);
    expect(route.openapi?.summary).toBe('Get item by ID');
  });

  test('secure() selects and normalizes a named principal service', () => {
    const route = new RouteBuilder().get('/export').secure('  client  ').handle(handler);

    expect(route.secure).toBe('client');
  });

  test('routes without .openapi() carry no metadata (excluded from generated specs)', () => {
    const route = new RouteBuilder().get('/internal').handle(handler);

    expect(route.openapi).toBeUndefined();
  });

  test('secure() rejects a blank service name', () => {
    expect(() => new RouteBuilder().get('/export').secure('   ')).toThrow(
      'secure() requires a non-empty user service name'
    );
  });

  test('handle() requires a method before finalizing', () => {
    expect(() => new RouteBuilder().handle(handler)).toThrow('Route method must be set');
  });
});
```

Actual OpenAPI spec generation is covered in `blendsdk/codegen`; in webafx tests, simply assert that metadata is attached (or absent).

### Controllers: Assert on Route Definitions, Not Internals

```typescript
import { describe, expect, test } from 'vitest';
import { ApplicationSettings, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { freshContainer } from './helpers.js';

class PingController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route().get('/ping').handle(async (_req, res) => {
        this.ok(res, { pong: true });
      }),
      this.authenticated().get('/me').handle(async (_req, res) => {
        this.ok(res, { me: true });
      }),
    ];
  }
}

describe('PingController', () => {
  test('declares one public and one secured route', () => {
    const controller = new PingController(
      new ApplicationSettings({ ENV_MODE: 'test' }),
      freshContainer()
    );

    const routes = controller.routes();

    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({ method: 'get', path: '/ping' });
    expect(routes[0].secure).toBeUndefined();
    expect(routes[1].secure).toBe(true);
  });
});
```

### ServiceContainer

```typescript
import { describe, expect, test } from 'vitest';
import { ApplicationSettings, ServiceContainer } from 'blendsdk/webafx';
import type { ServiceDefinition, ServiceRegistry } from 'blendsdk/webafx';
import { freshContainer } from './helpers.js';

describe('ServiceContainer', () => {
  test('singleton factories run once and are shared across containers', async () => {
    const registry: ServiceRegistry = { definitions: {}, singletons: {} };
    const settings = new ApplicationSettings();
    let factoryCalls = 0;

    const first = new ServiceContainer(registry, settings);
    first.registerService({
      name: 'counter',
      type: 'singleton',
      factory: () => {
        factoryCalls += 1;
        return { count: 0 };
      },
    });

    const second = new ServiceContainer(registry, settings);
    const fromFirst = await first.get<{ count: number }>('counter');
    const fromSecond = await second.get<{ count: number }>('counter');

    expect(factoryCalls).toBe(1);
    expect(fromFirst).toBe(fromSecond);
  });

  test('per-request services cannot be resolved outside a request', async () => {
    const container = freshContainer();
    container.registerService({
      name: 'request-scoped',
      type: 'per-request',
      factory: () => ({ ok: true }),
    });

    await expect(container.get('request-scoped')).rejects.toThrow(
      'Service "request-scoped" is per-request and can only be accessed during HTTP request handling'
    );
  });

  test('circular dependencies are detected with the dependency chain', async () => {
    const container = freshContainer();
    const definition = (name: string, dependency: string): ServiceDefinition => ({
      name,
      type: 'singleton',
      dependencies: [dependency],
      factory: async () => ({ name }),
    });

    container.registerService(definition('a', 'b'));
    container.registerService(definition('b', 'a'));

    await expect(container.get('a')).rejects.toThrow(/a -> b -> a/);
  });

  test('duplicate service names are rejected instead of silently overwriting', () => {
    const container = freshContainer();
    container.registerService({ name: 'alpha', type: 'singleton', factory: () => ({}) });

    expect(() =>
      container.registerService({ name: 'alpha', type: 'singleton', factory: () => ({}) })
    ).toThrow('Service "alpha" is already registered');
  });
});
```

### Error Classes

```typescript
import { describe, expect, test } from 'vitest';
import {
  ApiError,
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from 'blendsdk/webafx';

describe('HTTP error classes', () => {
  test('subclasses map to status codes, error codes, and default messages', () => {
    expect(new BadRequestError()).toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
      message: 'Bad Request',
    });
    expect(new UnauthorizedError()).toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
    expect(new NotFoundError()).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    expect(new ValidationError()).toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
  });

  test('toJSON() produces the standard error envelope', () => {
    const error = new ApiError(404, 'NOT_FOUND', 'Resource not found', { id: 123 });

    expect(error.toJSON()).toMatchObject({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found',
        statusCode: 404,
        details: { id: 123 },
        timestamp: expect.any(String),
      },
    });
  });

  test('all subclasses extend ApiError', () => {
    expect(new BadRequestError()).toBeInstanceOf(ApiError);
    expect(new NotFoundError()).toBeInstanceOf(ApiError);
    expect(new ValidationError()).toBeInstanceOf(ApiError);
  });
});
```

Never assert on exact `timestamp` values — match with `expect.any(String)` or the ISO-8601 regex `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/` as the package's own tests do.

---

## Integration Testing

### The Lifecycle Harness

Integration tests boot a real `WebApplication` and drive it with `supertest` against `app.express`. The standard harness — track `shutdown` in a module-scoped variable, await it in `afterEach`:

```typescript
import { afterEach, describe, expect, test } from 'vitest';
import supertest from 'supertest';
import { WebApplication } from 'blendsdk/webafx';
import { createTestApp } from './helpers.js';

describe('application lifecycle', () => {
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = undefined;
    }
  });

  test('start() boots the server and returns an idempotent shutdown function', async () => {
    const app = createTestApp();

    const stop = await app.start();
    shutdown = stop;

    const health = await supertest(app.express).get('/health').expect(200);
    expect(health.body).toHaveProperty('health', true);
    expect(health.body).toHaveProperty('timestamp');

    await stop();
    // shutdown() is idempotent — calling it a second time is safe
    await expect(stop()).resolves.toBeUndefined();

    shutdown = undefined;
  });

  test('lifecycle hooks fire in order around start() and shutdown()', async () => {
    const events: string[] = [];
    const app = createTestApp();

    app
      .on('beforeStart', () => events.push('beforeStart'))
      .on('afterStart', () => events.push('afterStart'))
      .on('beforeShutdown', () => events.push('beforeShutdown'))
      .on('afterShutdown', () => events.push('afterShutdown'));

    shutdown = await app.start();
    await shutdown();
    shutdown = undefined;

    expect(events).toEqual(['beforeStart', 'afterStart', 'beforeShutdown', 'afterShutdown']);
  });

  test('start() cannot run twice', async () => {
    const app = createTestApp();
    shutdown = await app.start();

    await expect(app.start()).rejects.toThrow('Application already started');
  });
});
```

Key rules distilled from the package's suite:

- **Always `await app.start()` before making requests.** Controllers, plugins, middleware, and services are wired during `start()`.
- **Use `PORT: 0` and a fresh `WebApplication` per test.** Each instance owns its registries — there is no global state to reset.
- **Use `supertest(app.express)`, never `fetch`.** With an ephemeral port you cannot construct a URL; supertest dispatches directly into the Express app.
- **Always shut down.** `start()` registers `SIGTERM`/`SIGINT` process handlers and opens a server; leaking them across tests causes hangs and listener warnings.

```typescript
// typescript fragment — shutdown removes the process signal handlers start() registered
await app.start();
const during = process.listenerCount('SIGINT');

await shutdown();
const after = process.listenerCount('SIGINT');

expect(after).toBeLessThan(during);
```

### Supertest Essentials

```typescript
// typescript fragment
// One request per call:
await supertest(app.express).get('/health').expect(200);

// Reuse a single agent when a test makes several requests:
const agent = supertest.agent(app.express);
await agent.get('/api/items').expect(200);
await agent.post('/api/items').send({ name: 'Widget' }).expect(201);
```

### Response Envelope Reference

Every webafx response follows one of these shapes — assert them exactly:

| Source | Status | Body |
|--------|--------|------|
| `this.ok(res, data)` | 200 | `{ success: true, data }` |
| `this.created(res, data)` | 201 | `{ success: true, data }` |
| `this.paginated(res, data, total, page, limit)` | 200 | `{ success: true, data, pagination: { total, page, limit, pages } }` |
| `this.noContent(res)` | 204 | empty body |
| thrown `ApiError` subclass | `error.statusCode` | `{ success: false, error: { code, message, statusCode, timestamp, requestId, path, details?, stack? } }` |
| unknown `Error` | 500 | same error envelope with `INTERNAL_SERVER_ERROR` |

A full example of asserting each helper is in [Routing & response envelopes](#routing--response-envelopes).

---

## Mocking & Stubbing

`WebApplication` instances are cheap, isolated, and start in milliseconds — prefer the real thing and stub only what leaves the process: databases, external APIs, the logger, and the environment.

### Stub Services Through the Registry

Register a fake service with the same name the production code resolves. This replaces a database, mailer, or HTTP client without touching framework internals.

```typescript
import { afterEach, describe, expect, test, vi } from 'vitest';
import supertest from 'supertest';
import { BaseController, NotFoundError } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { createTestApp } from './helpers.js';

interface UserRepository {
  findById(id: string): { id: string; name: string } | undefined;
}

class UsersController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route().get('/users/:id').handle(async (req, res) => {
        const repository = await req.services.get<UserRepository>('user-repository');
        const user = repository.findById(req.params.id);

        if (!user) {
          throw new NotFoundError('User not found');
        }

        this.ok(res, user);
      }),
    ];
  }
}

describe('UsersController', () => {
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = undefined;
    }
  });

  /** Boots the app with a stubbed repository instead of a real database. */
  async function startApp(repository: UserRepository): Promise<ReturnType<typeof createTestApp>> {
    const app = createTestApp();

    app.registerService({
      name: 'user-repository',
      type: 'singleton',
      factory: () => repository,
    });
    app.registerController('/api', UsersController);

    shutdown = await app.start();
    return app;
  }

  test('serves the record returned by the stub and records the lookup', async () => {
    const findById = vi.fn((id: string) => ({ id, name: 'Ada Lovelace' }));
    const app = await startApp({ findById });

    const response = await supertest(app.express).get('/api/users/u-1').expect(200);

    expect(response.body).toEqual({
      success: true,
      data: { id: 'u-1', name: 'Ada Lovelace' },
    });
    expect(findById).toHaveBeenCalledWith('u-1');
  });

  test('translates a missing record into a 404 envelope', async () => {
    const app = await startApp({ findById: vi.fn(() => undefined) });

    const response = await supertest(app.express).get('/api/users/none').expect(404);

    expect(response.body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND' },
    });
  });
});
```

### Replace the Application Logger

`app.setLogger()` swaps the default `ConsoleLogger` for any `Logger` implementation. Call it **before** `start()` so startup and error logging are captured too.

```typescript
import { afterEach, describe, expect, test } from 'vitest';
import supertest from 'supertest';
import { BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { createMockLogger, createTestApp } from './helpers.js';

class CrashController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route().get('/crash').handle(async () => {
        throw new Error('boom');
      }),
    ];
  }
}

describe('replacing the application logger', () => {
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = undefined;
    }
  });

  test('framework errors are reported through the installed logger', async () => {
    const app = createTestApp();
    const logger = createMockLogger();
    app.setLogger(logger);
    app.registerController('/api', CrashController);

    shutdown = await app.start();
    await supertest(app.express).get('/api/crash').expect(500);

    expect(logger.error).toHaveBeenCalled();
  });
});
```

### Spy on Console Output

When testing the default `ConsoleLogger` behavior itself, spy on `console.log` / `console.error`. Levels are thresholds: a logger configured at `ERROR` emits errors only; `DEBUG` messages also require the `DEBUG` environment variable (or level `DEBUG`).

```typescript
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConsoleLogger } from 'blendsdk/webafx';

describe('ConsoleLogger output', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  test('formats messages as [LEVEL:PREFIX]: message - data', async () => {
    const logger = new ConsoleLogger('Orders', 'INFO');

    await logger.info('order processed', { orderId: 42 });

    expect(console.log).toHaveBeenCalledWith(
      '[INFO:ORDERS]: order processed - {"orderId":42}'
    );
  });

  test('ERROR goes to console.error and lower levels follow the threshold', async () => {
    const logger = new ConsoleLogger('Orders', 'ERROR');

    await logger.error('failed');
    await logger.warn('careful');
    await logger.info('fyi');

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();
  });

  test('DEBUG can be enabled through the environment regardless of the level', async () => {
    vi.stubEnv('DEBUG', 'true');
    const logger = new ConsoleLogger('Orders', 'ERROR');

    await logger.debug('verbose');

    expect(console.log).toHaveBeenCalledTimes(1);
  });
});
```

For the JSON `StructuredLogger`, parse the captured argument directly:

```typescript
// typescript fragment — capture and parse one structured log entry
const entry = JSON.parse(String(vi.mocked(console.log).mock.calls[0][0]));
```

### Control the Environment

`vi.stubEnv()` + `vi.unstubAllEnvs()` is the only safe way to manipulate `process.env` in tests. Note that `ApplicationSettings` deliberately ignores `process.env` at construction — environment variables only affect `ConsoleLogger` (and its `DEBUG` handling).

```typescript
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApplicationSettings, ConsoleLogger } from 'blendsdk/webafx';

describe('environment stubs', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test('LOG_LEVEL is read by ConsoleLogger when no explicit level is given', async () => {
    vi.stubEnv('LOG_LEVEL', 'INFO');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const logger = new ConsoleLogger('TEST');

    await logger.info('visible');
    await logger.debug('hidden');

    expect(console.log).toHaveBeenCalledTimes(1);
  });

  test('ApplicationSettings ignores process.env at construction', () => {
    vi.stubEnv('DEBUG', 'true');

    expect(new ApplicationSettings().get('DEBUG')).toBeUndefined();
  });
});
```

After startup, the effective configuration is available through `app.getSettings()`:

```typescript
// typescript fragment — inspect the effective configuration of a booted app
const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
expect(app.getSettings().ENV_MODE).toBe('test');
```

### Mock Express Objects for Per-Request Factories

Per-request service factories receive `(container, settings, req, res, next)`. To unit-test one without a server, build minimal request/response doubles — only presence is required for `res`/`next`:

```typescript
import { describe, expect, test, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { ApplicationSettings, ServiceContainer } from 'blendsdk/webafx';
import type { ServiceRegistry } from 'blendsdk/webafx';

describe('per-request service factories', () => {
  test('receive the Express request context', async () => {
    const registry: ServiceRegistry = { definitions: {}, singletons: {} };
    const settings = new ApplicationSettings();

    const req = { headers: { 'x-api-key': 'secret' }, method: 'GET' } as Request;
    const res = {} as Response;
    const next = vi.fn() as NextFunction;

    const container = new ServiceContainer(registry, settings, req, res, next);
    container.registerService({
      name: 'api-client',
      type: 'per-request',
      factory: (_container: ServiceContainer, _settings: ApplicationSettings, request: Request) => ({
        key: request.headers['x-api-key'],
      }),
    });

    const client = await container.get<{ key: string | string[] | undefined }>('api-client');

    expect(client.key).toBe('secret');
  });
});
```

For middleware-level unit tests, the same technique with a request/response/next triple works:

```typescript
// typescript fragment — minimal doubles for unit-testing middleware
import { vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

function createMockReqResNext(headers: Record<string, string> = {}) {
  const req = { headers, method: 'GET' } as Request;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as Response;

  const next = vi.fn() as NextFunction;

  return { req, res, next };
}
```

### Waiting for Time-Based Behavior

Windows and timers run on real time in these tests — wait for them explicitly rather than with fake timers:

```typescript
// typescript fragment — wait out a rate-limit window
await new Promise((resolve) => setTimeout(resolve, 150));
```

---

## Test Patterns by Feature

| Feature | Section |
|---------|---------|
| Routing & response envelopes | [below](#routing--response-envelopes) |
| Request validation (Zod) | [below](#request-validation) |
| Authentication & authorization | [below](#authentication--authorization) |
| Services & dependency injection | [below](#services--dependency-injection-over-http) |
| Plugins, lifecycle & terminals | [below](#plugins-lifecycle--terminals) |
| Static files & SPA | [below](#static-files--spa) |
| CORS, security headers & rate limiting | [below](#cors-security-headers--rate-limiting) |
| Error handling | [below](#error-handling) |
| Request tracing & observability | [below](#request-tracing--observability) |
| Configuration | [Unit Testing → ApplicationSettings](#applicationsettings) |

### Routing & Response Envelopes

```typescript
import { afterEach, describe, expect, test } from 'vitest';
import type { Request, Response } from 'express';
import supertest from 'supertest';
import { BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { createTestApp } from './helpers.js';

class ItemsController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route().get('/items/:id').handle(async (req: Request, res: Response) => {
        this.ok(res, { id: req.params.id, name: `Item ${req.params.id}` });
      }),
      this.route().post('/items').handle(async (req: Request, res: Response) => {
        this.created(res, { id: 'new-1', name: req.body.name });
      }),
      this.route().get('/items').handle(async (_req: Request, res: Response) => {
        this.paginated(res, [{ id: '1' }, { id: '2' }], 42, 2, 2);
      }),
      this.route().delete('/items/:id').handle(async (_req: Request, res: Response) => {
        this.noContent(res);
      }),
    ];
  }
}

describe('Items HTTP API', () => {
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = undefined;
    }
  });

  async function startApp(): Promise<ReturnType<typeof createTestApp>> {
    const app = createTestApp();
    app.registerController('/api', ItemsController);
    shutdown = await app.start();
    return app;
  }

  test('ok() and created() wrap data in the success envelope', async () => {
    const app = await startApp();
    const agent = supertest(app.express);

    const fetched = await agent.get('/api/items/42').expect(200);
    expect(fetched.body).toEqual({ success: true, data: { id: '42', name: 'Item 42' } });

    const createdResponse = await agent.post('/api/items').send({ name: 'Widget' }).expect(201);
    expect(createdResponse.body).toEqual({
      success: true,
      data: { id: 'new-1', name: 'Widget' },
    });
  });

  test('paginated() adds pagination metadata', async () => {
    const app = await startApp();

    const response = await supertest(app.express).get('/api/items').expect(200);

    expect(response.body).toEqual({
      success: true,
      data: [{ id: '1' }, { id: '2' }],
      pagination: { total: 42, page: 2, limit: 2, pages: 21 },
    });
  });

  test('noContent() sends an empty 204', async () => {
    const app = await startApp();

    const response = await supertest(app.express).delete('/api/items/42').expect(204);

    expect(response.text).toBe('');
  });
});
```

Assert whole envelopes with `toEqual` so accidental shape changes (renamed fields, missing pagination) fail loudly.

### Request Validation

Attach a Zod schema with `.validate()`; the framework validates merged `params` + `query` + `body` before the handler runs, and the handler reads the validated values through `req.services.getParams()`.

```typescript
import { afterEach, describe, expect, test } from 'vitest';
import type { Request, Response } from 'express';
import supertest from 'supertest';
import { z } from 'zod';
import { BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { createTestApp } from './helpers.js';

const createItemSchema = z.object({
  name: z.string().min(1),
  price: z.number().positive(),
});

class CatalogController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .post('/products')
        .validate(createItemSchema)
        .handle(async (req: Request, res: Response) => {
          const product = req.services.getParams<{ name: string; price: number }>();
          this.created(res, product);
        }),
    ];
  }
}

describe('product validation', () => {
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = undefined;
    }
  });

  async function startApp(): Promise<ReturnType<typeof createTestApp>> {
    const app = createTestApp();
    app.registerController('/api', CatalogController);
    shutdown = await app.start();
    return app;
  }

  test('valid payloads reach the handler', async () => {
    const app = await startApp();

    const response = await supertest(app.express)
      .post('/api/products')
      .send({ name: 'Widget', price: 9.99 })
      .expect(201);

    expect(response.body.data).toEqual({ name: 'Widget', price: 9.99 });
  });

  test('invalid payloads fail with 422 before the handler runs', async () => {
    const app = await startApp();

    const response = await supertest(app.express)
      .post('/api/products')
      .send({ name: '', price: -5 })
      .expect(422);

    expect(response.body).toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR', statusCode: 422 },
    });
  });
});
```

Also see the [Input Separation](https://github.com/blendsdk/blendsdk) patterns: `getParams()` returns the merged view (params, then query, then body), while `getInput()` keeps the three sources separate when keys collide.

### Authentication & Authorization

Test auth by registering principal services with the names your routes select — `'user'` by default, or a named service per route. This keeps the full 401/403 flow exercised without any auth framework in the test.

```typescript
import { afterEach, describe, expect, test } from 'vitest';
import type { Request, Response } from 'express';
import supertest from 'supertest';
import { ApplicationSettings, BaseController, ServiceContainer } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { createTestApp } from './helpers.js';

interface Principal {
  sub: string;
  kind: 'user' | 'client';
}

class ReportsController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      // Default principal: the 'user' service
      this.authenticated().get('/reports').handle(async (req: Request, res: Response) => {
        const user = await req.services.get<Principal>('user', undefined);
        this.ok(res, { requestedBy: user?.sub });
      }),

      // Named principal: the 'client' service, plus an authorization check
      this.authenticated('client')
        .get('/exports')
        .authorize((_req: Request, client: Principal) => client.sub.startsWith('svc-'))
        .handle(async (_req: Request, res: Response) => {
          this.ok(res, { export: true });
        }),
    ];
  }
}

describe('principal selection', () => {
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = undefined;
    }
  });

  async function startApp(): Promise<ReturnType<typeof createTestApp>> {
    const app = createTestApp();

    app.registerService({
      name: 'user',
      type: 'per-request',
      factory: (_container: ServiceContainer, _settings: ApplicationSettings, req: Request) =>
        req.headers['x-user'] === 'ok'
          ? ({ sub: 'user-1', kind: 'user' } satisfies Principal)
          : undefined,
    });

    app.registerService({
      name: 'client',
      type: 'per-request',
      factory: (_container: ServiceContainer, _settings: ApplicationSettings, req: Request) => {
        const header = req.headers['x-client'];
        if (header === 'ok') {
          return { sub: 'svc-42', kind: 'client' } satisfies Principal;
        }
        if (header === 'blocked') {
          return { sub: 'intern-1', kind: 'client' } satisfies Principal;
        }
        return undefined;
      },
    });

    app.registerController('/api', ReportsController);
    shutdown = await app.start();
    return app;
  }

  test('secure routes resolve the default user principal', async () => {
    const app = await startApp();

    const response = await supertest(app.express)
      .get('/api/reports')
      .set('x-user', 'ok')
      .expect(200);

    expect(response.body.data).toEqual({ requestedBy: 'user-1' });
  });

  test('missing principals are rejected with 401', async () => {
    const app = await startApp();

    await supertest(app.express).get('/api/reports').expect(401);

    // Presenting the wrong principal service does not satisfy the route
    await supertest(app.express).get('/api/exports').set('x-user', 'ok').expect(401);
  });

  test('the route-selected principal drives authorize(): 200 vs 403', async () => {
    const app = await startApp();

    await supertest(app.express).get('/api/exports').set('x-client', 'ok').expect(200);
    await supertest(app.express).get('/api/exports').set('x-client', 'blocked').expect(403);
  });
});
```

### Services & Dependency Injection over HTTP

Singletons persist across requests; per-request services are rebuilt each time. Assert both behaviors with counters and identifiers.

```typescript
import { afterEach, describe, expect, test } from 'vitest';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { createTestApp } from './helpers.js';

class ServiceDemoController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route().get('/singleton').handle(async (req: Request, res: Response) => {
        const counter = await req.services.get<{ count: number }>('counter');
        counter.count += 1;
        this.ok(res, { count: counter.count });
      }),
      this.route().get('/per-request').handle(async (req: Request, res: Response) => {
        const token = await req.services.get<{ id: string }>('request-token');
        this.ok(res, { token: token.id });
      }),
    ];
  }
}

describe('service lifecycles over HTTP', () => {
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = undefined;
    }
  });

  async function startApp(): Promise<ReturnType<typeof createTestApp>> {
    const app = createTestApp();

    app.registerService({
      name: 'counter',
      type: 'singleton',
      factory: () => ({ count: 0 }),
    });
    app.registerService({
      name: 'request-token',
      type: 'per-request',
      factory: () => ({ id: randomUUID() }),
    });

    app.registerController('/api', ServiceDemoController);
    shutdown = await app.start();
    return app;
  }

  test('singleton services are shared across requests', async () => {
    const app = await startApp();

    const first = await supertest(app.express).get('/api/singleton').expect(200);
    const second = await supertest(app.express).get('/api/singleton').expect(200);

    expect(first.body.data.count).toBe(1);
    expect(second.body.data.count).toBe(2);
  });

  test('per-request services are created fresh for every request', async () => {
    const app = await startApp();

    const first = await supertest(app.express).get('/api/per-request').expect(200);
    const second = await supertest(app.express).get('/api/per-request').expect(200);

    expect(first.body.data.token).toBeTruthy();
    expect(first.body.data.token).not.toBe(second.body.data.token);
  });
});
```

### Plugins, Lifecycle & Terminals

```typescript
import { afterEach, describe, expect, test } from 'vitest';
import type { Response } from 'express';
import supertest from 'supertest';
import { BaseController } from 'blendsdk/webafx';
import type { PluginDefinition, RouteDefinition } from 'blendsdk/webafx';
import { createTestApp } from './helpers.js';

class PingController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route().get('/ping').handle(async (_req, res) => {
        this.ok(res, { pong: true });
      }),
    ];
  }
}

describe('plugins and terminals', () => {
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = undefined;
    }
  });

  test('plugins install in priority order (lower first, default 100)', async () => {
    const app = createTestApp();
    const installed: string[] = [];
    const plugin = (name: string, priority: number): PluginDefinition => ({
      name,
      priority,
      factory: async () => {
        installed.push(name);
        return {};
      },
    });

    app.use(plugin('metrics', 200));
    app.use(plugin('auth', 10));
    app.use(plugin('static', 20));

    shutdown = await app.start();

    expect(installed).toEqual(['auth', 'static', 'metrics']);
  });

  test('terminal middleware runs after controllers and /health, before the 404 handler', async () => {
    const app = createTestApp();

    app.use({
      name: 'catch-all',
      factory: async () => ({
        terminal: ({ express }) => {
          express.use((_req, res) => {
            res.status(200).send('fallback');
          });
        },
      }),
    });
    app.registerController('', PingController);

    shutdown = await app.start();

    // Controllers still win
    const ping = await supertest(app.express).get('/ping').expect(200);
    expect(ping.body.data).toEqual({ pong: true });

    // /health is not swallowed either
    const health = await supertest(app.express).get('/health').expect(200);
    expect(health.body).toHaveProperty('health', true);

    // Only genuinely unmatched requests reach the terminal
    const fallback = await supertest(app.express).get('/client/route').expect(200);
    expect(fallback.text).toBe('fallback');
  });

  test('plugin shutdown hooks run when the application shuts down', async () => {
    const app = createTestApp();
    const events: string[] = [];

    app.use({
      name: 'worker',
      factory: async () => ({
        shutdown: async () => {
          events.push('worker-shutdown');
        },
      }),
    });

    const stop = await app.start();
    await stop();

    expect(events).toEqual(['worker-shutdown']);
  });
});
```

### Static Files & SPA

Static file tests need a real directory on disk — build one per suite with `mkdtempSync` and remove it in `afterAll`. The SPA fallback guards: unmatched **GET** requests with an HTML `Accept` header receive `index.html`; requests that look like files (path has an extension) or expect JSON fall through to 404.

```typescript
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supertest from 'supertest';
import { staticFilesPlugin } from 'blendsdk/webafx';
import { createTestApp } from './helpers.js';

let siteDir: string;

beforeAll(() => {
  siteDir = mkdtempSync(join(tmpdir(), 'webafx-site-'));
  writeFileSync(join(siteDir, 'index.html'), '<!DOCTYPE html><html><body>SPA</body></html>');
  writeFileSync(join(siteDir, 'app.js'), 'console.log("bundle");');
});

afterAll(() => {
  rmSync(siteDir, { recursive: true, force: true });
});

describe('staticFilesPlugin', () => {
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = undefined;
    }
  });

  test('serves static assets and falls back to index.html for SPA routes', async () => {
    const app = createTestApp();
    app.use(staticFilesPlugin({ root: siteDir, spa: true }));
    shutdown = await app.start();
    const agent = supertest.agent(app.express);

    const asset = await agent.get('/app.js').expect(200);
    expect(asset.text).toContain('bundle');

    const clientRoute = await agent.get('/settings/profile').set('Accept', 'text/html').expect(200);
    expect(clientRoute.text).toContain('SPA');
  });

  test('file requests and JSON accepts are not swallowed by the fallback', async () => {
    const app = createTestApp();
    app.use(staticFilesPlugin({ root: siteDir, spa: true }));
    shutdown = await app.start();

    await supertest(app.express).get('/missing.css').set('Accept', 'text/html').expect(404);
    await supertest(app.express).get('/api/data').set('Accept', 'application/json').expect(404);
  });

  test('throws at startup when the root directory does not exist', async () => {
    const app = createTestApp();
    app.use(staticFilesPlugin({ root: './definitely-missing-dir' }));

    await expect(app.start()).rejects.toThrow('Static files root directory does not exist');
  });
});
```

The plugin factory is pure — its name and priority can be asserted without a server:

```typescript
// typescript fragment
const plugin = staticFilesPlugin({ root: './public', prefix: '/assets' });

expect(plugin.name).toBe('static-files:/assets');
expect(plugin.priority).toBe(20);
```

### CORS, Security Headers & Rate Limiting

```typescript
import { afterEach, describe, expect, test } from 'vitest';
import supertest from 'supertest';
import { BaseController, rateLimitMiddleware } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { createTestApp } from './helpers.js';

class SearchController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/search')
        .middleware(rateLimitMiddleware({ maxRequests: 3, windowMs: 60_000 }))
        .handle(async (_req, res) => {
          this.ok(res, { results: [] });
        }),
    ];
  }
}

describe('security middleware', () => {
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = undefined;
    }
  });

  async function startApp(): Promise<ReturnType<typeof createTestApp>> {
    const app = createTestApp({
      CORS: { origin: 'https://app.example.com', credentials: true },
    });
    app.registerController('/api', SearchController);
    shutdown = await app.start();
    return app;
  }

  test('CORS headers are emitted for allowed origins only', async () => {
    const app = await startApp();

    const allowed = await supertest(app.express)
      .get('/api/search')
      .set('Origin', 'https://app.example.com')
      .expect(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const blocked = await supertest(app.express)
      .get('/api/search')
      .set('Origin', 'https://evil.example.com')
      .expect(200);
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('rate limit headers track the window and excess requests are rejected', async () => {
    const app = await startApp();
    const agent = supertest.agent(app.express);

    const first = await agent.get('/api/search').expect(200);
    expect(first.headers['x-ratelimit-limit']).toBe('3');
    expect(first.headers['x-ratelimit-remaining']).toBe('2');

    await agent.get('/api/search').expect(200);
    await agent.get('/api/search').expect(200);

    await agent.get('/api/search').expect(429);
  });

  test('helmet security headers are enabled and X-Powered-By is removed', async () => {
    const app = await startApp();

    const response = await supertest(app.express).get('/health').expect(200);

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers).toHaveProperty('x-frame-options');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
```

For window expiry, use the real-time wait pattern from [Mocking & Stubbing](#waiting-for-time-based-behavior) — start a fresh app per test so the in-memory limiter never leaks state between cases.

### Error Handling

Assert the standard error envelope for `ApiError` subclasses, the production/development split for unknown errors, and the per-request fields (`requestId`, `path`).

```typescript
import { afterEach, describe, expect, test } from 'vitest';
import supertest from 'supertest';
import { BaseController, NotFoundError } from 'blendsdk/webafx';
import type { ApplicationConfig, RouteDefinition } from 'blendsdk/webafx';
import { createTestApp } from './helpers.js';

class ErrorController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route().get('/missing').handle(async () => {
        throw new NotFoundError('Item not found');
      }),
      this.route().get('/crash').handle(async () => {
        throw new Error('Database exploded');
      }),
    ];
  }
}

describe('error responses', () => {
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = undefined;
    }
  });

  async function startApp(envMode: ApplicationConfig['ENV_MODE']): Promise<ReturnType<typeof createTestApp>> {
    const app = createTestApp({ ENV_MODE: envMode });
    app.registerController('/api', ErrorController);
    shutdown = await app.start();
    return app;
  }

  test('ApiError subclasses drive the standard error envelope', async () => {
    const app = await startApp('test');

    const response = await supertest(app.express).get('/api/missing').expect(404);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Item not found',
        statusCode: 404,
        path: '/api/missing',
        requestId: expect.any(String),
        timestamp: expect.any(String),
      },
    });
  });

  test('unknown errors are opaque in production', async () => {
    const app = await startApp('production');

    const response = await supertest(app.express).get('/api/crash').expect(500);

    expect(response.body).toMatchObject({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal Server Error' },
    });
    expect(response.body.error.stack).toBeUndefined();
  });

  test('unknown errors expose message and stack in development', async () => {
    const app = await startApp('development');

    const response = await supertest(app.express).get('/api/crash').expect(500);

    expect(response.body.error.message).toBe('Database exploded');
    expect(response.body.error.stack).toBeDefined();
  });
});
```

### Request Tracing & Observability

Every request gets a UUID request ID — exposed as the `X-Request-ID` response header, embedded in error envelopes, and available anywhere in the request's async call chain through `getRequestId()`.

```typescript
import { afterEach, describe, expect, test } from 'vitest';
import supertest from 'supertest';
import { BaseController, getRequestId } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { createTestApp } from './helpers.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class TraceController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route().get('/trace').handle(async (_req, res) => {
        // AsyncLocalStorage makes the request ID available anywhere in the chain
        this.ok(res, { requestId: getRequestId() });
      }),
      this.route().get('/fail').handle(async () => {
        throw new Error('boom');
      }),
    ];
  }
}

describe('request tracing', () => {
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = undefined;
    }
  });

  async function startApp(): Promise<ReturnType<typeof createTestApp>> {
    const app = createTestApp();
    app.registerController('/api', TraceController);
    shutdown = await app.start();
    return app;
  }

  test('every response carries a UUID X-Request-ID header', async () => {
    const app = await startApp();

    const response = await supertest(app.express).get('/health').expect(200);

    expect(response.headers['x-request-id']).toMatch(UUID_REGEX);
  });

  test('a valid incoming X-Request-ID is preserved; malformed values are replaced', async () => {
    const app = await startApp();
    const validId = '550e8400-e29b-41d4-a716-446655440000';

    const preserved = await supertest(app.express)
      .get('/health')
      .set('X-Request-ID', validId)
      .expect(200);
    expect(preserved.headers['x-request-id']).toBe(validId);

    const replaced = await supertest(app.express)
      .get('/health')
      .set('X-Request-ID', 'not-a-uuid')
      .expect(200);
    expect(replaced.headers['x-request-id']).not.toBe('not-a-uuid');
    expect(replaced.headers['x-request-id']).toMatch(UUID_REGEX);
  });

  test('handlers and error envelopes see the same request ID', async () => {
    const app = await startApp();

    const trace = await supertest(app.express).get('/api/trace').expect(200);
    expect(trace.body.data.requestId).toBe(trace.headers['x-request-id']);

    const failed = await supertest(app.express).get('/api/fail').expect(500);
    expect(failed.body.error.requestId).toBe(failed.headers['x-request-id']);
  });
});
```

`getRequestId()` and `getRequestContext()` are safe anywhere — outside a request they simply return `undefined`:

```typescript
// typescript fragment — request-scoped logging anywhere in the async chain
const requestId = getRequestId();

const logger = new StructuredLogger('API', 'INFO', () => ({ requestId }));
await logger.info('request handled', { path: '/api/items' });
```

---

# webafx Troubleshooting

This guide covers the errors you are most likely to encounter when building with `blendsdk/webafx`: the exact messages the framework throws, why they occur, and how to fix them. It then walks through step-by-step debugging strategies and closes with subtle pitfalls that are easy to miss. Each fix contains a complete, runnable example built only from the package's public API.

---

## Common Errors

Errors are grouped by the phase in which they surface:

- **Startup and configuration** — settings, config files, registrations, plugins
- **Route definition** — mistakes in `RouteBuilder` chains
- **Service container** — dependency-injection resolution failures
- **Authentication and security** — 401/403, rate limits, CORS
- **Request and response** — 404/422/500 handling
- **Logging and observability** — missing log output
- **TypeScript and module errors** — compiler and ESM resolution problems

---

### Startup and Configuration Errors

#### Configuration validation failed

**Symptom**

```text
Error: Configuration validation failed:
  - ENV_MODE: Invalid option: expected one of "production"|"development"|"test"
  - DEBUG: Invalid input: expected boolean, received string
```

The `Configuration validation failed:` wrapper and the `  - <key>: <message>` layout come from WebAFX; the individual detail lines are produced by Zod.

**Cause**

`ApplicationSettings` validates constructor config — and every config file loaded via `loadFromFile()` — against a strict Zod schema. Any type or range mismatch throws. The accepted values are:

| Key | Accepted values |
|-----|-----------------|
| `PORT` | integer `0`–`65535` (number, not string) |
| `ENV_MODE` | `'production'` \| `'development'` \| `'test'` |
| `LOG_LEVEL` | `'ERROR'` \| `'WARN'` \| `'INFO'` \| `'DEBUG'` |
| `DEBUG`, `TRUST_PROXY` | boolean (not `'true'` / `1`) |
| `BODY_LIMIT` | string such as `'100kb'` or `'1mb'` |
| `SHUTDOWN_TIMEOUT` | number `0`–`300` (seconds) |
| `CORS` | boolean or a config object |

Custom properties are allowed (the schema is passthrough), so only the standard keys above are enforced.

**Fix**

Pass correctly typed values. If a value arrives from an external source (env var, CLI, file), coerce it before constructing settings:

```typescript
import { ApplicationSettings } from 'blendsdk/webafx';
import type { ApplicationConfig } from 'blendsdk/webafx';

const config: ApplicationConfig = {
  PORT: 3000,                 // number between 0 and 65535 — not "3000"
  ENV_MODE: 'development',    // 'production' | 'development' | 'test'
  LOG_LEVEL: 'INFO',          // 'ERROR' | 'WARN' | 'INFO' | 'DEBUG'
  DEBUG: false,               // boolean — not 'false'
  TRUST_PROXY: true,
  BODY_LIMIT: '1mb',
  SHUTDOWN_TIMEOUT: 30,       // seconds, 0–300
  CORS: { origin: 'https://app.example.com' },
};

const settings = new ApplicationSettings(config);

const port = settings.get<number>('PORT', 3000);
console.log(`Configured for port ${port}, production: ${settings.isProduction()}`);
```

---

#### Configuration file error: /srv/app/.env.local.js

**Symptom**

```text
Error: Configuration file error: /srv/app/.env.local.js
    at ApplicationSettings.loadFromFile (...)
  [cause]: ReferenceError: DATABASE_URL is not defined
```

**Cause**

`loadFromFile()` dynamically imports the config file. If the module fails to evaluate (syntax error, error thrown at import time, undefined reference), WebAFX wraps the original error in `new Error('Configuration file error: <resolved path>', { cause })`. Note the reverse case: if the file simply does **not exist**, `loadFromFile()` silently returns — a typo'd path produces no error at all.

**Fix**

1. Read the wrapped `cause` — that is the original failure.
2. Make sure the file is valid ESM and exports either a default object or a named `config` object:

```javascript
// .env.local.js
export default {
  PORT: 3000,
  ENV_MODE: 'development',
  LOG_LEVEL: 'INFO',
};
```

3. Load it with error handling and confirm the resolved path:

```typescript
import { ApplicationSettings } from 'blendsdk/webafx';

const settings = new ApplicationSettings({ ENV_MODE: 'production' });

try {
  await settings.loadFromFile('.env.local.js');
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message);
    if (error.cause instanceof Error) {
      console.error('Original cause:', error.cause.message);
    }
  }
  process.exit(1);
}

const logLevel = settings.get<string>('LOG_LEVEL', 'ERROR');
console.log(`Log level: ${logLevel}`);
```

4. Remember the path is resolved with `path.resolve(jsPath)` — relative to `process.cwd()`, not to the importing file.

---

#### Application already started

**Symptom**

```text
Error: Application already started
```

**Cause**

`app.start()` was awaited more than once on the same `WebApplication` instance — typically because a bootstrap module and a test helper both start the same app.

**Fix**

Call `start()` exactly once per application instance and keep the returned shutdown function. The shutdown function itself is idempotent — calling it twice is safe.

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

// start() boots the HTTP server and wires SIGTERM/SIGINT handling.
const shutdown = await app.start();

// Programmatic stop — idempotent, safe to call multiple times:
await shutdown();

// Do not call start() again on the same instance; create a new
// WebApplication if you need a fresh server.
```

---

#### Plugin "..." is already registered

**Symptom**

```text
Error: Plugin "static-files:/assets" is already registered
```

**Cause**

`app.use()` registers plugins by unique name and rejects duplicates immediately (synchronously, not at `start()`). `staticFilesPlugin()` derives its name from the mount prefix — `static-files` for `/`, or `static-files:<prefix>` otherwise — so two static mounts sharing a prefix collide.

**Fix**

Give each plugin instance a unique prefix (or name). For static files, mount distinct prefixes:

```typescript
import { WebApplication, staticFilesPlugin } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

// ✅ Distinct prefixes → distinct plugin names:
//    'static-files:/app' and 'static-files:/docs'
app.use(staticFilesPlugin({ root: './public/app', prefix: '/app' }));
app.use(staticFilesPlugin({ root: './public/docs', prefix: '/docs' }));
```

Only one static plugin can own the default `/` prefix — combine directories into a single root instead of mounting twice.

---

#### Service "..." is already registered

**Symptom**

```text
Error: Service "user-repository" is already registered
```

**Cause**

`registerService()` rejects duplicate names instead of silently overwriting. This is deliberate fail-fast behavior so two parts of a codebase cannot fight over the same name — it usually means a module-level registration and a bootstrap function both ran.

**Fix**

Register each service name exactly once, before `start()`:

```typescript
import { WebApplication } from 'blendsdk/webafx';

interface UserRepository {
  findById(id: string): { id: string; name: string } | undefined;
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

// ✅ Registered exactly once, before start().
app.registerService({
  name: 'user-repository',
  type: 'singleton',
  factory: (): UserRepository => ({
    findById: (id: string) => (id === '1' ? { id: '1', name: 'Ada' } : undefined),
  }),
});
```

If you need to swap an *instance* — for example, a fake in a test — override it with `container.set(name, instance)` instead of re-registering the definition.

---

#### Static files root directory does not exist: /srv/app/publicx

**Symptom**

```text
Error: Static files root directory does not exist: /srv/app/publicx
```

**Cause**

`staticFilesPlugin` resolves `root` against `process.cwd()` and validates it when the plugin is installed during `app.start()` — not at `app.use()` time. Typos, missing build output, or running the process from a different working directory all trigger this.

**Fix**

1. Ensure the directory exists before startup (check your build-step order).
2. Prefer absolute paths computed from the module location so the result does not depend on `process.cwd()`:

```typescript
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebApplication, staticFilesPlugin } from 'blendsdk/webafx';

// ESM replacement for __dirname — stable regardless of the working directory.
const currentDir = path.dirname(fileURLToPath(import.meta.url));

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

app.use(staticFilesPlugin({
  root: path.join(currentDir, '..', 'public'),
}));
```

---

### Route Definition Errors

#### Route handler must be a function, received: undefined

**Symptom**

```text
Error: Route handler must be a function, received: undefined. Path: /items, Method: get
```

(The `received` part reflects `typeof handler` — you may see `object`, `string`, etc.)

**Cause**

`.handle(fn)` received something that is not a function. Typical triggers: a typo'd or renamed method reference (`this.listItems` where only `listItemsOld` exists), passing the *result* of calling the handler (`this.listItems()` — a Promise, so `received: object`), or passing a string.

**Fix**

Pass a function reference. Declare the handler as an arrow-function class property so `this` stays bound to the controller when Express invokes it:

```typescript
import { BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class ItemController extends BaseController {
  routes() {
    return [
      // ✅ A function reference — not this.listItems(), not 'listItems'
      this.route().get('/items').handle(this.listItems),
    ];
  }

  private listItems = async (_req: Request, res: Response): Promise<void> => {
    this.ok(res, { items: [] });
  };
}
```

---

#### Route method must be set before calling handle() / Route path must be set before calling handle()

**Symptom**

```text
Error: Route method must be set before calling handle()
```

```text
Error: Route path must be set before calling handle()
```

**Cause**

`handle()` requires a completed chain: an HTTP verb method (`.get('...')`, `.post('...')`, …) sets both the method and the path. Calling `.handle()` on a builder that never received a verb fails validation.

**Fix**

Always begin the chain with a verb and a path:

```typescript
import { BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class PingController extends BaseController {
  routes() {
    // ✅ The chain always starts with a verb + path: .get('/ping')
    return [
      this.route()
        .get('/ping')
        .handle(async (_req: Request, res: Response): Promise<void> => {
          this.ok(res, { pong: true });
        }),
    ];
  }
}
```

---

#### secure() requires a non-empty user service name

**Symptom**

```text
Error: secure() requires a non-empty user service name
```

**Cause**

`.secure('')` or `.secure('   ')` — a blank principal service name. `secure()` trims its argument and rejects names that are empty after trimming, because a blank name would resolve no service and fail closed with a 401. This is a mistake guard, not a validation of service existence.

**Fix**

Omit the argument for the default `'user'` principal, or pass a real service name:

```typescript
import { BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class ExportController extends BaseController {
  routes() {
    return [
      // ✅ No argument → default principal service 'user'
      this.authenticated()
        .get('/export')
        .handle(async (_req: Request, res: Response): Promise<void> => {
          this.ok(res, { scope: 'user' });
        }),

      // ✅ Named principal service — must not be blank
      this.authenticated('client')
        .get('/machine-export')
        .handle(async (_req: Request, res: Response): Promise<void> => {
          this.ok(res, { scope: 'client' });
        }),
    ];
  }
}
```

---

### Service Container Errors

#### Service "..." is not registered

**Symptom**

```text
Error: Service "cache" is not registered
```

**Cause**

`container.get(name)` throws when the name is not in the registry **and** no default value was supplied. Common causes: registering the service after `start()`, a typo in the name, resolving from the wrong application's container, or simply forgetting registration.

**Fix**

1. Register before `start()`; names must match exactly.
2. Pass a default value when the dependency is optional:

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface CacheService {
  get(key: string): string | undefined;
}

class ProfileController extends BaseController {
  routes() {
    return [
      this.route().get('/profile').handle(async (req: Request, res: Response): Promise<void> => {
        // Throws `Service "cache" is not registered` when omitted and no
        // default is provided — pass undefined for an optional dependency.
        const cache = await req.services.get<CacheService>('cache', undefined);
        const cached = cache?.get('user:profile') ?? null;
        this.ok(res, { cached });
      }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

// ✅ Register before start() so every request can resolve it.
app.registerService({
  name: 'cache',
  type: 'singleton',
  factory: (): CacheService => {
    const store = new Map<string, string>();
    return { get: (key: string) => store.get(key) };
  },
});

app.registerController('/api', ProfileController);
```

---

#### Service "..." is per-request and can only be accessed during HTTP request handling

**Symptom**

```text
Error: Service "session" is per-request and can only be accessed during HTTP request handling
```

**Cause**

A `type: 'per-request'` service was resolved outside a request scope — for example in a `beforeStart` hook, a plugin factory, a singleton factory, or module-level code. Per-request factories receive `req`, `res`, and `next`; those only exist while an HTTP request is being handled.

**Fix**

Resolve per-request services only inside request handling (handlers, route middleware), or switch the service to `type: 'singleton'` when it does not actually depend on the request:

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { ApplicationSettings, ServiceContainer } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface SessionService {
  id: string;
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

app.registerService({
  name: 'session',
  type: 'per-request',
  factory: (
    _container: ServiceContainer,
    _settings: ApplicationSettings,
    req: Request
  ): SessionService => {
    const header = req.headers['x-session-id'];
    return { id: typeof header === 'string' ? header : 'anonymous' };
  },
});

class SessionController extends BaseController {
  routes() {
    return [
      this.route().get('/whoami').handle(async (req: Request, res: Response): Promise<void> => {
        // ✅ Resolved during request handling — the request context exists here.
        const session = await req.services.get<SessionService>('session');
        this.ok(res, { sessionId: session.id });
      }),
    ];
  }
}

app.registerController('/api', SessionController);
```

---

#### Circular dependency detected: users -> audit -> users

**Symptom**

```text
Error: Circular dependency detected: users -> audit -> users
```

**Cause**

While resolving a service, resolving its dependencies encountered a service that is already being resolved. The chain in the message shows the cycle in resolution order. Cycles come from `dependencies` arrays or from factories that call `container.get()` on each other.

**Fix**

Break the cycle: extract the shared behavior into a third service, or make one edge lazy (a callback resolved at call time instead of a construction-time dependency):

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { ApplicationSettings, ServiceContainer } from 'blendsdk/webafx';

interface Logger {
  log(message: string): void;
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

// ✅ A shared dependency with no outgoing edges turns the cycle into a tree.
app.registerService({
  name: 'logger',
  type: 'singleton',
  factory: (): Logger => ({ log: (message: string) => console.log(message) }),
});

app.registerService({
  name: 'users',
  type: 'singleton',
  dependencies: ['logger'],
  factory: async (
    container: ServiceContainer,
    _settings: ApplicationSettings
  ): Promise<{ find(id: string): string }> => {
    const logger = await container.get<Logger>('logger');
    return {
      find: (id: string) => {
        logger.log(`users.find(${id})`);
        return `user-${id}`;
      },
    };
  },
});

app.registerService({
  name: 'audit',
  type: 'singleton',
  dependencies: ['logger'],
  factory: async (
    container: ServiceContainer,
    _settings: ApplicationSettings
  ): Promise<{ record(event: string): void }> => {
    const logger = await container.get<Logger>('logger');
    return { record: (event: string) => logger.log(`audit: ${event}`) };
  },
});
```

If two services genuinely need each other, introduce a lazy accessor (for example `getOther: () => container.get('other')`) so the reference is resolved at call time, not construction time.

---

### Authentication and Security Errors

#### 401 UNAUTHORIZED on a secure route

**Symptom**

```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Unauthorized",
    "statusCode": 401,
    "timestamp": "2025-01-01T00:00:00.000Z",
    "requestId": "3f0c2f4e-0a4b-4a67-9b0e-1c3d5e7f9a11",
    "path": "/api/me"
  }
}
```

**Cause**

The guard for `.secure()` / `.authenticated()` resolves the principal service from the request's service container — under `'user'` by default, or under the name passed to `secure(name)`. When the resolution yields nothing, the request is rejected with 401. Specific causes:

1. No principal service is registered under that name — the guard fails closed, even for a typo in the name; there is never a bypass.
2. The principal factory returned `undefined` for this request (missing or invalid credentials).
3. The route selects one principal service while the credentials populate another (for example `.secure('client')` while only `'user'` exists).

**Fix**

Register a per-request principal service and select the correct name on the route:

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { ApplicationSettings, ServiceContainer } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface Principal {
  sub: string;
  roles: string[];
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

// The guard resolves this service by name; returning undefined rejects the
// request with 401, so credentials are validated exactly once, here.
app.registerService({
  name: 'user',
  type: 'per-request',
  factory: (
    _container: ServiceContainer,
    _settings: ApplicationSettings,
    req: Request
  ): Principal | undefined => {
    if (req.headers.authorization === 'Bearer valid-token') {
      return { sub: 'user-1', roles: ['reader'] };
    }
    return undefined;
  },
});

class MeController extends BaseController {
  routes() {
    return [
      // Default principal service 'user'
      this.authenticated()
        .get('/me')
        .handle(async (req: Request, res: Response): Promise<void> => {
          const user = req.services.getUser<Principal>();
          this.ok(res, { user });
        }),
    ];
  }
}

app.registerController('/api', MeController);
```

Verify with a real request:

```bash
curl -i http://localhost:3000/api/me -H "Authorization: Bearer valid-token"
```

---

#### 403 FORBIDDEN from an authorize callback

**Symptom**

```json
{ "success": false, "error": { "code": "FORBIDDEN", "message": "Forbidden", "statusCode": 403 } }
```

**Cause**

The principal was resolved successfully, but the route's `.authorize(fn)` callback returned `false` (or the handler threw a `ForbiddenError`). Typical reasons: wrong role or claim names, an empty `roles` array, or a bug in the predicate. Remember that `authorize` runs against the principal chosen by `.secure()` / `.authenticated()` — if you authorized against a different service than the route selected, the check sees the wrong identity.

**Fix**

Inspect the principal inside the callback to see why the check fails, then return a real boolean:

```typescript
import { BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface Principal {
  sub: string;
  roles: string[];
}

class AdminController extends BaseController {
  routes() {
    return [
      this.authenticated()
        .get('/admin')
        .authorize((_req: Request, user: Principal): boolean => {
          // Temporary diagnostics: log the principal shape to find the cause.
          console.log('authorize principal:', JSON.stringify(user));
          return user.roles.includes('admin');
        })
        .handle(async (_req: Request, res: Response): Promise<void> => {
          this.ok(res, { admin: true });
        }),
    ];
  }
}
```

---

#### 429 RATE_LIMIT_EXCEEDED / missing X-RateLimit headers

**Symptom**

```text
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1767225600
```

```json
{ "success": false, "error": { "code": "RATE_LIMIT_EXCEEDED", "message": "Rate limit exceeded", "statusCode": 429 } }
```

**Cause**

`rateLimitMiddleware()` counted more requests than `maxRequests` (default `100`) within `windowMs` (default `60_000` ms) for the request's key (default: `req.ip`). Recurring causes:

- Every limiter instance keeps its own in-memory counter; two limiters on the same route do not share state.
- Behind a proxy or load balancer, `req.ip` is the proxy's address unless `TRUST_PROXY: true` is set — all clients share one key and throttle each other.
- The store is per-process; horizontally scaled deployments allow roughly `N × maxRequests` and produce inconsistent windows.

**Fix**

Tune the limiter per route, choose a meaningful key, and enable `TRUST_PROXY` behind a proxy:

```typescript
import { WebApplication, BaseController, rateLimitMiddleware } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'production',
  TRUST_PROXY: true,
});

class SearchController extends BaseController {
  routes() {
    return [
      this.route()
        .get('/search')
        .middleware(rateLimitMiddleware({
          maxRequests: 10,
          windowMs: 60_000,
          keyExtractor: (req: Request): string => {
            const apiKey = req.headers['x-api-key'];
            return typeof apiKey === 'string' ? apiKey : req.ip ?? 'unknown';
          },
          message: 'Too many searches — retry in a minute',
        }))
        .handle(async (_req: Request, res: Response): Promise<void> => {
          this.ok(res, { results: [] });
        }),
    ];
  }
}

app.registerController('/api', SearchController);
```

For multi-instance deployments, replace the in-memory limiter with a shared store (for example a Redis-backed middleware) via a plugin.

---

#### Missing CORS headers / the browser blocks requests

**Symptom**

Browser console: `Access to fetch at 'http://localhost:3000/api/test' from origin 'https://app.example.com' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.` Server-side the same request returns 200 via curl, but with no `access-control-allow-*` headers for the browser's origin.

**Cause**

- `CORS: false` disables CORS entirely — no headers are emitted, by design.
- A custom `origin` configuration that does not match the browser's origin: the middleware lets the request through but omits the allow header, so the browser blocks the response.
- A dynamic origin callback calling `callback(null, false)` for that origin.
- Using `origin: '*'` together with `credentials: true` — browsers reject credentialed responses for the wildcard origin.

**Fix**

Configure explicit origins (or a dynamic callback) and verify with a preflight:

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { CorsConfig } from 'blendsdk/webafx';

const corsConfig: CorsConfig = {
  origin: (origin: string | undefined, callback: (err: Error | null, allowed: boolean) => void): void => {
    // Allow same-origin/non-browser requests (no Origin header) and any
    // subdomain of the company domain; deny everything else.
    if (!origin || origin.endsWith('.mycompany.com')) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  exposedHeaders: ['X-Total-Count'],
  maxAge: 7200,
};

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production', CORS: corsConfig });
```

For a small fixed set of origins, `origin: ['https://app.example.com', 'https://admin.example.com']` works the same way. Verify the preflight:

```bash
curl -i -X OPTIONS http://localhost:3000/api/test \
  -H "Origin: https://app.example.com" \
  -H "Access-Control-Request-Method: GET"
# Expect: HTTP/1.1 204 with Access-Control-Allow-Origin: https://app.example.com
```

Once enabled, CORS headers are applied to error responses as well — if they are missing even from local 500s, the CORS configuration itself is not active.

---

### Request and Response Errors

#### 422 VALIDATION_ERROR

**Symptom**

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "statusCode": 422,
    "details": { "email": "Email is required" }
  }
}
```

**Cause**

Your handler threw `ValidationError` with a details object, or a `.validate(schema)` guard rejected the merged request input. The `details` value is whatever you passed as the second constructor argument.

**Fix**

Choose one validation style — declarative `.validate(zodSchema)` on the route, or manual checks with `ValidationError` — and make sure clients can render `error.details`:

```typescript
import { BaseController, ValidationError } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class UserController extends BaseController {
  routes() {
    return [
      this.route()
        .post('/users')
        .handle(async (req: Request, res: Response): Promise<void> => {
          const body = req.body as { name?: string; email?: string };
          const details: Record<string, string> = {};

          if (!body.name) {
            details.name = 'Name is required';
          }
          if (!body.email) {
            details.email = 'Email is required';
          }

          if (Object.keys(details).length > 0) {
            // → 422 { success: false, error: { code: 'VALIDATION_ERROR', details } }
            throw new ValidationError('Validation failed', details);
          }

          this.created(res, { name: body.name, email: body.email });
        }),
    ];
  }
}
```

When using `.validate(schema)`, check that the schema matches the actual payload shape — it validates the merged `params`, `query`, and `body` input.

---

#### 500 with a generic "Internal Server Error" message

**Symptom**

In production, responses look like this — no original message, no stack:

```json
{ "success": false, "error": { "code": "INTERNAL_SERVER_ERROR", "message": "Internal Server Error", "statusCode": 500 } }
```

In development the same failure shows the real message and stack.

**Cause**

An error that is not an `ApiError` escaped a handler or middleware. The error handler masks unknown errors in production: the message becomes `"Internal Server Error"` and the stack is omitted so nothing internal leaks. The original error only lands in the logs, keyed by `requestId`.

**Fix**

1. Find the log entry by `error.requestId` and read the original message.
2. Convert expected failures into typed `ApiError` subclasses so clients receive meaningful envelopes:

```typescript
import { BaseController, InternalServerError, NotFoundError } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class InvoiceController extends BaseController {
  routes() {
    return [
      this.route().get('/invoices/:id').handle(async (req: Request, res: Response): Promise<void> => {
        try {
          const invoice = await this.fetchInvoice(req.params.id);
          if (!invoice) {
            // → 404 with a client-safe message and details
            throw new NotFoundError('Invoice not found', { id: req.params.id });
          }
          this.ok(res, invoice);
        } catch (error) {
          if (error instanceof NotFoundError) {
            throw error;
          }
          // → 500 with a client-safe message; the original error stays in the logs
          throw new InternalServerError('Invoice lookup failed', {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    ];
  }

  private fetchInvoice = async (id: string): Promise<{ id: string; total: number } | undefined> => {
    return id === '1' ? { id: '1', total: 99 } : undefined;
  };
}
```

3. Locally, set `ENV_MODE: 'development'` (or `'test'`) to see original messages and stacks in responses. Keep production masking in place — it is intentional.

---

### Logging and Observability Errors

#### Expected log output is missing

**Symptom**

`await logger.info('...')` produces no output. WARN and DEBUG lines are silent. Plugin install messages never appear.

**Cause**

`ConsoleLogger` and `StructuredLogger` filter by level, and the default level is `ERROR`:

- Level resolution: constructor argument → else `process.env.LOG_LEVEL` (case-insensitive) → else `ERROR`.
- Unknown `LOG_LEVEL` values fall back to `ERROR`.
- Thresholds: `ERROR` logs only errors; `WARN` adds warnings; `INFO` adds info; `DEBUG` adds debug.
- `logger.debug()` additionally prints when `process.env.DEBUG === 'true'`, regardless of level.
- When a config file is loaded, `ApplicationSettings` normalizes `LOG_LEVEL` as `LOG_LEVEL ?? (DEBUG === true ? 'DEBUG' : ENV_MODE !== 'production' ? 'DEBUG' : 'ERROR')` — in production, a loaded config yields `ERROR` unless you set `LOG_LEVEL` (or `DEBUG`) explicitly.

**Fix**

Pick the level you need, per logger instance or via environment:

| To see | Configure |
|--------|-----------|
| ERROR only (default) | nothing |
| WARN + ERROR | `LOG_LEVEL=WARN` |
| INFO + WARN + ERROR | `LOG_LEVEL=INFO` |
| DEBUG + everything | `LOG_LEVEL=DEBUG` (or `DEBUG=true` for debug lines only) |

```typescript
import { ConsoleLogger, StructuredLogger } from 'blendsdk/webafx';

// ✅ Explicit constructor level wins over process.env.LOG_LEVEL.
const consoleLogger = new ConsoleLogger('API', 'INFO');
await consoleLogger.info('Server starting'); // printed
await consoleLogger.debug('Cache warmed');  // not printed at INFO

// ✅ Structured (JSON) variant for log pipelines — one JSON object per line.
const structuredLogger = new StructuredLogger('API', 'DEBUG');
await structuredLogger.info('Server starting', { port: 3000 });
```

Two related details when piping logs: `ERROR` entries are written via `console.error` (stderr), while WARN/INFO/DEBUG go to `console.log` (stdout). You can also replace the application logger at runtime with `app.setLogger(customLogger)` (the hook logger plugins use) — handy for asserting log calls in tests.

---

### TypeScript and Module Errors

#### Cannot find module 'blendsdk/webafx' or its corresponding type declarations

**Symptom**

```text
error TS2307: Cannot find module 'blendsdk/webafx' or its corresponding type declarations.
```

**Cause**

WebAFX is ESM-only with an `exports` map that points at `./dist/index.js` / `./dist/index.d.ts`. TypeScript only honors `exports` under `node16` / `nodenext` / `bundler` module resolution — a legacy `module: commonjs` + `moduleResolution: node10` setup cannot resolve it. A missing dependency installation produces the same message.

**Fix**

Use a modern tsconfig and install the peer dependencies (`express ^5`, `zod ^4`) alongside the package:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"]
  }
}
```

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
console.log('App created:', app.express !== undefined);
```

If you get `Cannot find name 'process'` instead, install `@types/node` or add `"types": ["node"]` as shown above.

---

#### error TS1479 — importing an ES module from a CommonJS file

**Symptom**

```text
error TS1479: The current file is a CommonJS module whose imports will produce 'require' calls;
however, the referenced file is an ECMAScript module and cannot be imported with 'require'.
```

**Cause**

The importing file is compiled as CommonJS (no `"type": "module"` in your `package.json`, a `.cts` extension, or `module: commonjs`), but `blendsdk/webafx` is ESM-only.

**Fix**

Make the importer an ES module: add `"type": "module"` to your `package.json` and keep NodeNext resolution — then use normal static imports:

```json
{
  "name": "my-app",
  "type": "module",
  "dependencies": {
    "blendsdk/webafx": "^1.0.0",
    "express": "^5.0.0",
    "zod": "^4.0.0"
  }
}
```

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
console.log('App created:', app.express !== undefined);
```

If the importer must stay CommonJS, use a dynamic `await import('blendsdk/webafx')` instead of a static import.

---

#### ERR_PACKAGE_PATH_NOT_EXPORTED — deep imports are blocked

**Symptom**

```text
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './dist/index.js' is not defined by "exports"
in /app/node_modules/blendsdk/webafx/package.json
```

The same happens for any deep path such as `'blendsdk/webafx/application'`.

**Cause**

The package `exports` map exposes exactly one entry: `"."`. Deep imports into `dist/` or `src/` are blocked by Node.js — by design, since they bypass the public API.

**Fix**

Import everything from the package root:

```typescript
// ✅ Root import — the only public entry point
import { WebApplication, BaseController, staticFilesPlugin } from 'blendsdk/webafx';
```

If a symbol you need is not re-exported from the root, it is intentionally internal — avoid reaching for it and request the feature instead.

---

#### 'error' is of type 'unknown'

**Symptom**

```text
error TS18046: 'error' is of type 'unknown'.
```

**Cause**

`strict` mode implies `useUnknownInCatchVariables`: `catch` bindings are typed `unknown`, so accessing `.message` directly is rejected.

**Fix**

Narrow the value before reading it. WebAFX wraps original errors with `{ cause }`, so check that too:

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

try {
  const shutdown = await app.start();
  await shutdown();
} catch (error) {
  // ✅ Narrow the unknown value before reading properties.
  if (error instanceof Error) {
    console.error('Startup failed:', error.message);
    if (error.cause instanceof Error) {
      console.error('Caused by:', error.cause.message);
    }
  } else {
    console.error('Startup failed with a non-Error value:', String(error));
  }
  process.exit(1);
}
```

---

#### Type 'string | undefined' is not assignable to type 'string'

**Symptom**

```text
error TS2322: Type 'string | undefined' is not assignable to type 'string'.
```

At a call such as `trackRequest(getRequestId())` or `const id: string = getRequestId();`.

**Cause**

`getRequestId()` and `getRequestContext()` return `undefined` outside an active request scope — strict mode forces you to handle that.

**Fix**

Provide a fallback or guard the value:

```typescript
import { getRequestContext, getRequestId } from 'blendsdk/webafx';

function log(message: string): void {
  // ✅ Fallback for code that may run outside a request.
  const requestId = getRequestId() ?? 'no-request';
  console.log(`[${requestId}] ${message}`);
}

function describeScope(): string {
  const context = getRequestContext();
  if (!context) {
    return 'outside request scope';
  }
  const elapsedMs = Date.now() - context.startTime;
  return `request ${context.requestId} (${elapsedMs}ms elapsed)`;
}
```

---

#### Argument is not assignable to parameter of type 'ZodType'

**Symptom**

A compile error when calling `.validate(...)` with something that is not a Zod schema, for example:

```text
error TS2345: Argument of type 'Schema' is not assignable to parameter of type 'ZodType'.
```

**Cause**

`.validate(schema)` accepts Zod schemas only. Common triggers: passing a JSON Schema, a schema from another validation library, or a Zod v3 schema while the project resolves Zod v4. Zod is also a peer dependency — a duplicate install (for example, your app on `zod@3` and WebAFX on `zod@4`) produces type mismatches even for valid Zod code.

**Fix**

Define the schema with Zod 4 and make sure your app installs `zod@^4.0.0` so a single zod instance is shared:

```typescript
import { z } from 'zod';
import { BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

const searchSchema = z.object({
  q: z.string().min(1),
  page: z.coerce.number().int().min(1).default(1),
});

class SearchController extends BaseController {
  routes() {
    return [
      this.route()
        .get('/search')
        .validate(searchSchema)
        .handle(async (_req: Request, res: Response): Promise<void> => {
          this.ok(res, { results: [] });
        }),
    ];
  }
}
```

---

## Debugging Strategies

### 1. Reproduce failures in a supertest harness

The fastest way to isolate any framework issue is the pattern the WebAFX test suite itself uses: `PORT: 0` (OS-assigned port), `ENV_MODE: 'test'`, `LOG_LEVEL: 'ERROR'`, and supertest against `app.express`.

1. Build the smallest possible app — register only the controller or service under investigation.
2. Start it with `await app.start()` and capture the shutdown function.
3. Drive requests with supertest against `app.express` — no real port or network needed.
4. Always call shutdown in teardown; a leaked server keeps the process alive.

```typescript
import { afterEach, describe, expect, test } from 'vitest';
import supertest from 'supertest';
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class PingController extends BaseController {
  routes() {
    return [
      this.route().get('/ping').handle(async (_req: Request, res: Response): Promise<void> => {
        this.ok(res, { pong: true });
      }),
    ];
  }
}

describe('ping endpoint', () => {
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = undefined;
    }
  });

  test('responds with the success envelope', async () => {
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });
    app.registerController('/api', PingController);
    shutdown = await app.start();

    const res = await supertest(app.express).get('/api/ping').expect(200);

    expect(res.body).toEqual({ success: true, data: { pong: true } });
  });
});
```

### 2. Triage startup failures by exact message

Startup failures are grouped by when they are raised. Read the message and jump straight to the check:

| Message | Raised during | First check |
|---------|---------------|-------------|
| `Configuration validation failed: ...` | settings construction / file load | value types and ranges (see table above) |
| `Configuration file error: <path>` | config file load | file exists, valid ESM, inspect `error.cause` |
| `Plugin "..." is already registered` | `app.use()` (synchronous) | duplicate plugin names / static prefixes |
| `Service "..." is already registered` | `registerService()` | duplicate registration calls |
| `Static files root directory does not exist: ...` | `start()` (plugin install) | resolved path vs `process.cwd()` |
| `Route handler must be a function, received: ...` | `start()` (route build) | handler reference in the controller |

### 3. Jump from the status code to the failing phase

Every error response uses the same envelope — start with `error.code`, then use `error.requestId` to find the server-side log line:

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Not Found",
    "statusCode": 404,
    "timestamp": "2025-01-01T00:00:00.000Z",
    "requestId": "3f0c2f4e-0a4b-4a67-9b0e-1c3d5e7f9a11",
    "path": "/api/missing"
  }
}
```

| Status | `error.code` | Meaning | First place to look |
|--------|--------------|---------|---------------------|
| 401 | `UNAUTHORIZED` | no principal resolved for a secure route | principal service registration and request credentials |
| 403 | `FORBIDDEN` | `authorize()` denied the resolved principal | predicate logic, role/claim names |
| 404 | `NOT_FOUND` | no controller route matched (or an explicit `NotFoundError`) | `basePath` + route path + HTTP method |
| 422 | `VALIDATION_ERROR` | validation rejected the input | `error.details`, schema vs payload |
| 429 | `RATE_LIMIT_EXCEEDED` | limiter window exceeded | window config, key extractor, `TRUST_PROXY` |
| 500 | `INTERNAL_SERVER_ERROR` | unhandled error (masked in production) | server logs via `error.requestId` |

### 4. Follow a single request with its ID

1. Send a known UUID in the `X-Request-ID` header — WebAFX reuses it only if it is a valid UUID; otherwise it generates a fresh one.
2. Read `X-Request-ID` from the response headers: that is the canonical ID for the request.
3. Stamp your own logs with `getRequestId()` inside handlers and services.
4. On failures, match `error.requestId` in the JSON envelope to the log lines.

```typescript
import { getRequestId } from 'blendsdk/webafx';

// Anywhere inside the request lifecycle (handlers, services, route middleware):
const requestId = getRequestId() ?? 'outside-request';
console.log(`[${requestId}] doing work`);
```

```bash
# Reuse a known ID across client and server logs (must be a valid UUID):
curl -i http://localhost:3000/api/orders \
  -H "X-Request-ID: 550e8400-e29b-41d4-a716-446655440000"
```

### 5. Trace startup and plugin order with verbose logs

1. Create the app with `LOG_LEVEL: 'DEBUG'` (add `DEBUG: true` if you want `debug()` output regardless of level).
2. Start the app and read stdout/stderr for these messages:
   - `[INFO:SETTINGS]: .env.js loaded` — a config file was loaded
   - `[INFO:PLUGINS]: Plugin <name> installed.` — install order (lower priority first, default 100)
   - `[INFO:PLUGINS]: Plugin <name> terminal installed.` — terminals run after controllers
   - `[INFO:PLUGINS]: Shutting down <name> plugin.` — shutdown order
3. Confirm your plugin order matches expectations, then lower the level before committing.

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'development',
  LOG_LEVEL: 'DEBUG',
});

const shutdown = await app.start();
await shutdown();
```

To prove ordering with a scratch plugin, register a low-priority probe that logs in both phases:

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'INFO' });

app.use({
  name: 'probe',
  priority: 10,
  factory: async ({ logger }) => {
    await logger.info('probe factory — runs before controllers');
    return {
      terminal: async ({ logger: terminalLogger }) => {
        await terminalLogger.info('probe terminal — runs after controllers, before 404');
      },
    };
  },
});
```

### 6. Probe health, CORS, and limits over HTTP

1. Check the aggregate health endpoint — the payload reports plugin health:

```bash
curl -s http://localhost:3000/health
# {"health":true,"timestamp":"..."}
```

If `health` is `false`, at least one plugin's `health()` returned false; run with `LOG_LEVEL: 'DEBUG'` to see `<name> plugin is not healthy` in the logs and fix that plugin first.

2. Check CORS preflight behavior for the exact origin your browser uses (see the CORS fix above). Allowed origins return `204` with `Access-Control-Allow-Origin`; disallowed origins get no allow header.

3. Check rate limiting by sending a burst against a limited route and watching the `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` response headers — they update on every response, not only on 429s.

---

## Known Pitfalls

- **`ENV_MODE` defaults to `production`.** Even with no configuration at all, `ApplicationSettings` starts in production mode: unknown errors are masked (`"Internal Server Error"`, no stack) and stack traces never leak. If behavior seems "silently broken", set `ENV_MODE: 'development'` (or `'test'`) before you debug anything else.

- **Configuration never reads or writes `process.env`.** Settings come from the constructor object and `loadFromFile()` only — an environment variable like `PORT=3000` has no effect on WebAFX, and WebAFX never mutates `process.env` while loading config.

- **A missing config file is not an error.** `loadFromFile()` silently returns when the path does not exist; only a file that exists but fails to evaluate throws. With INFO logs off by default, a typo'd path looks like "the config was ignored". Verify the path (it is resolved against `process.cwd()`) or watch for the `<file> loaded` info line.

- **Production turns the log volume down.** When a config file is loaded, `LOG_LEVEL` resolves to `LOG_LEVEL ?? (DEBUG === true ? 'DEBUG' : ENV_MODE !== 'production' ? 'DEBUG' : 'ERROR')`. A production deployment with a config file logs ERROR only unless you set the level explicitly.

- **Plugin factory middleware runs before controllers.** Anything mounted in a plugin's `factory` can swallow controller routes — the classic mistake is an SPA fallback or wildcard middleware added in the factory phase. Use the `terminal` hook for catch-all middleware: it runs after controllers and `/health`, but before the 404 handler. `staticFilesPlugin({ spa: true })` already does this correctly.

- **`staticFilesPlugin` names collide by prefix.** The plugin name is `static-files` for `/` or `static-files:<prefix>` otherwise — one instance per prefix. Reusing a prefix throws `Plugin "static-files:/assets" is already registered` synchronously at `app.use()` time.

- **The static root is resolved against `process.cwd()`.** Running the process from a different directory (service managers, monorepo scripts, IDE runners) breaks relative roots. Pass absolute paths computed from the module location.

- **The SPA fallback has guards by design.** It serves `index.html` only for GET requests, only when the `Accept` header includes `text/html`, only for extension-less paths, and only when `spa: true` is set. A client-side `fetch()` without an HTML Accept header gets a 404 — not `index.html`.

- **Duplicate registrations are fatal — there is no overwrite.** Plugin and service names must be unique per application. For intentional instance replacement (for example fakes in tests), use `container.set(name, instance)` instead of re-registering the definition.

- **Per-request services are never disposed.** Resolving a per-request service outside a request throws; and on shutdown, `disposeAll()` invokes `dispose` for singleton services only. If a service needs cleanup, make it a singleton with a `dispose` function.

- **Security guards fail closed.** A route secured against an unregistered or misspelled service name returns 401 — never a bypass. A blank name passed to `.secure('')` throws at route-build time (`secure() requires a non-empty user service name`).

- **Malformed upstream `X-Request-ID` headers are replaced.** WebAFX reuses an incoming request ID only when it is a valid UUID; anything else (gateway-specific trace formats, prefixed IDs) is replaced by a fresh UUID that is also returned in the `X-Request-ID` response header. Design dashboards and log correlation around that value.

- **`getRequestId()` / `getRequestContext()` are `undefined` outside a request.** Timers, `beforeStart` hooks, and plugin factories run outside the request scope — guard or default the value (strict mode will make you).

- **`getAll()` returns a shallow copy.** Top-level keys are safe to mutate, but nested objects (for example the `CORS` config) are shared references — mutating them mutates the live settings.

- **Merged request input collapses duplicate keys across `params`, `query`, and `body`.** `getParams()` is a convenience merge; when a key can legitimately appear in more than one source, use `req.services.getInput()` to keep the sources separate.

- **The error handler tolerates broken loggers by design.** If your logger throws while an error is being logged, the client still receives the correct error response, but the log line is lost silently. A "responses are fine, error logs are missing" symptom usually means the logger itself is misbehaving — verify it in isolation.

- **Raw `res.json()` bypasses the response envelope.** Handlers that respond manually skip the `{ success, data }` shape that `this.ok()`, `this.created()`, `this.paginated()`, and `this.noContent()` produce. Clients written against the envelope break if only some routes deviate.

- **`preparseServiceNames()` is deprecated.** It still works but prints `[WebAFX DEPRECATION WARNING] preparseServiceNames() is deprecated. Use const objects instead: const ServiceNames = { KEY: "KEY" } as const;`. Switch to plain `as const` objects.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
