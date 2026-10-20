> **Package**: `blendsdk/webafx`

# webafx Advanced Patterns

This document collects advanced, composable patterns for `blendsdk/webafx`. Each pattern solves a concrete production problem by combining several WebAFX subsystems — the application lifecycle, controllers and the fluent `RouteBuilder`, the service container, plugins, request context, and the standard response envelopes. The examples build on the fundamentals described in the Overview (install the umbrella package with its peers: `npm install blendsdk express zod`) and every example is complete, ESM-only, and strict-mode TypeScript.

Patterns covered:

- **Feature Modules as Plugins** — ship a controller, its services, health reporting, and teardown as one installable unit.
- **Multi-Principal Authentication** — serve human users and machine clients from one application, each with its own principal service.
- **Layered Route Protection** — compose CSRF, rate limiting, authentication, and validation in a predictable order.
- **Request-Scoped Observability** — JSON logs correlated by request ID across app logs, service calls, and error envelopes.
- **Graceful Shutdown Orchestration** — an ordered, idempotent teardown of hooks, singleton services, and plugins.
- **Paginated Endpoints, Documented End-to-End** — the metadata contract that `blendsdk/codegen` turns into clients that keep pagination data.
- **SPA and API Co-Hosting** — a client-side routing fallback that can never swallow API routes or `/health`.
- **Domain Error Translation** — a single boundary where business errors become the standard error envelope.

---

## Feature Modules as Plugins

A `PluginDefinition` can do more than add middleware: it can register services, register controllers, contribute health checks, and own teardown. That makes a plugin the natural packaging unit for a whole feature — "notifications", "billing", "audit" — that applications add with a single `app.use(...)` call.

### When to use it

- You ship functionality reused across applications, or you want a hard boundary between feature teams.
- A feature owns long-lived resources (queues, timers, connections) that must be closed on shutdown.
- You want `GET /health` and graceful shutdown to reflect the feature automatically, with no wiring in the host application.

### Implementation

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Plugin, PluginDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

// --- Feature internals -------------------------------------------------------

interface NotificationQueue {
  publish(topic: string, payload: Record<string, unknown>): Promise<void>;
  deliveredCount(): number;
  isHealthy(): boolean;
  close(): Promise<void>;
}

class InMemoryNotificationQueue implements NotificationQueue {
  private readonly delivered: Array<{ topic: string; payload: Record<string, unknown> }> = [];
  private closed = false;

  async publish(topic: string, payload: Record<string, unknown>): Promise<void> {
    if (this.closed) {
      throw new Error('Notification queue is closed');
    }
    this.delivered.push({ topic, payload });
  }

  deliveredCount(): number {
    return this.delivered.length;
  }

  isHealthy(): boolean {
    return !this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class NotificationsController extends BaseController {
  routes() {
    return [this.route().post('/send').handle(this.send)];
  }

  private async send(req: Request, res: Response): Promise<void> {
    const queue = await req.services.get<NotificationQueue>('notifications.queue');
    const payload: Record<string, unknown> = req.body;
    await queue.publish('user-events', payload);
    this.created(res, { queued: true });
  }
}

// --- The installable unit ------------------------------------------------------

export function notificationsPlugin(): PluginDefinition {
  return {
    name: 'notifications',
    priority: 30,

    factory: async ({ app, logger }) => {
      const queue = new InMemoryNotificationQueue();

      // 1. Singleton service with disposal — closed during graceful shutdown.
      app.registerService({
        name: 'notifications.queue',
        type: 'singleton',
        factory: () => queue,
        dispose: async () => {
          await queue.close();
        },
      });

      // 2. Controllers registered by plugins are collected right after all
      //    plugin factories have finished.
      app.registerController('/api/notifications', NotificationsController);

      await logger.info('Notifications feature installed');

      // 3. Health + teardown travel with the feature.
      const plugin: Plugin = {
        health: async () => queue.isHealthy(),
        shutdown: async () => {
          // Singleton services are disposed before this runs, so the queue is
          // already closed — report the final count and stop.
          await logger.info(`Notifications stopped (${queue.deliveredCount()} delivered)`);
        },
      };
      return plugin;
    },
  };
}

// --- Host application -----------------------------------------------------------

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });
app.use(notificationsPlugin());

const shutdown = await app.start();
// POST /api/notifications/send {"subject":"Welcome"}
//   → 201 { "success": true, "data": { "queued": true } }
// GET /health → { "health": true, "timestamp": ... }  (queue health included)
// await shutdown(); → queue.close() via dispose, then the plugin's shutdown hook
```

### Why it matters

The plugin is a single unit of composition with the application lifecycle already wired in: the service container handles creation and disposal, the health endpoint aggregates the feature's `health()` result, the shutdown sequence calls its `shutdown()`, and duplicate registration is rejected loudly instead of silently overwriting (both plugin names and service names are unique per application). Feature authors iterate on one folder; host applications opt in or out with one line.

### Caveats

- Plugin factories run **before** controllers are registered, so `app.registerController()` from a factory works — but factories should not assume other plugins' runtime behavior, only their install order via `priority` (lower installs first, default 100).
- A factory error aborts `app.start()` — validate required configuration in the factory and fail fast.
- Singleton `dispose` callbacks run **before** plugin `shutdown()` hooks. Once a service is disposed, its `shutdown` consumers must not touch it.
- Registering the same plugin or service name twice throws (`Plugin "x" is already registered` / `Service "x" is already registered`). Use `app.use()` once per feature; intentionally replacing one container's resolved instance is what `ServiceContainer.set()` is for.
- Registering a controller is safe from any plugin, but keep base paths disjoint — Express matches them in registration order.

---

## Multi-Principal Authentication

One application often serves more than one kind of caller: browser users with sessions, machine clients with API keys, and maybe internal services. WebAFX supports this directly — a route declares **which service holds its principal**, and authentication, authorization, and handler code all work against that same principal.

### When to use it

- Your API is consumed by both humans and machines, with different credential types and different capabilities.
- You run more than one auth provider (for example OIDC for users, static keys for integrations) in the same process.
- You want 401/403 semantics to stay automatic and route-scoped instead of hand-rolled per endpoint.

### Implementation

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { ApplicationSettings, ServiceContainer } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

// --- Principals ------------------------------------------------------------------

interface UserPrincipal {
  readonly kind: 'user';
  readonly id: string;
  readonly role: 'member' | 'admin';
}

interface ClientPrincipal {
  readonly kind: 'client';
  readonly clientId: string;
  readonly scopes: readonly string[];
}

const CLIENTS = new Map<string, { clientId: string; scopes: readonly string[] }>([
  ['demo-client-key', { clientId: 'cli_77', scopes: ['export', 'reports'] }],
  ['demo-readonly-key', { clientId: 'cli_78', scopes: ['reports'] }],
]);

// Demo resolvers — production code verifies a signed session / hashed key.
function resolveUser(req: Request): UserPrincipal | undefined {
  const session: unknown = req.cookies?.['session'];
  if (session !== 'demo-user-session') {
    return undefined;
  }
  return { kind: 'user', id: 'usr_1001', role: 'member' };
}

function resolveClient(req: Request): ClientPrincipal | undefined {
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey !== 'string') {
    return undefined;
  }
  const client = CLIENTS.get(apiKey);
  if (client === undefined) {
    return undefined;
  }
  return { kind: 'client', clientId: client.clientId, scopes: client.scopes };
}

// --- Routes choose their principal service ------------------------------------------

class ReportExportController extends BaseController {
  routes() {
    return [
      // Browser users: the default 'user' principal.
      this.authenticated()
        .get('/me/export')
        .handle(this.exportOwnData),

      // Machine clients: the 'client' principal plus a scope check.
      // authorize() receives the very principal this route selected.
      this.authenticated('client')
        .get('/clients/export')
        .authorize((_req: Request, client: ClientPrincipal) => client.scopes.includes('export'))
        .handle(this.exportForClient),
    ];
  }

  private async exportOwnData(req: Request, res: Response): Promise<void> {
    const user = req.services.getUser<UserPrincipal>();
    this.ok(res, { format: 'csv', requestedBy: user?.id });
  }

  private async exportForClient(req: Request, res: Response): Promise<void> {
    const client = await req.services.get<ClientPrincipal>('client', undefined);
    this.ok(res, { format: 'csv', requestedBy: client?.clientId });
  }
}

// --- Application wiring ---------------------------------------------------------------

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

app.registerService({
  name: 'user',
  type: 'per-request',
  factory: (_container: ServiceContainer, _settings: ApplicationSettings, req: Request) =>
    resolveUser(req),
});

app.registerService({
  name: 'client',
  type: 'per-request',
  factory: (_container: ServiceContainer, _settings: ApplicationSettings, req: Request) =>
    resolveClient(req),
});

app.registerController('/api/reports', ReportExportController);

const shutdown = await app.start();

// GET /api/reports/me/export       Cookie: session=demo-user-session  → 200
// GET /api/reports/me/export       (no credentials)                   → 401
// GET /api/reports/clients/export  X-API-Key: demo-client-key         → 200
// GET /api/reports/clients/export  X-API-Key: demo-readonly-key       → 403 (missing 'export' scope)
// GET /api/reports/clients/export  (no credentials)                   → 401
```

### Why it matters

The route definition is the single source of truth for how a request is authenticated. The guard resolves exactly the service the route named, rejects with 401 when the principal is absent, and hands the *same* principal to `authorize()` before your handler runs — no global middleware ordering games, no `req.user` vs `req.client` ambiguity, no way for a route to accidentally fall back to a different identity. `authenticated(name)` is a shorthand for `route().secure(name)`, so controllers stay readable.

### Caveats

- Principal services must be `per-request`. A mutable singleton would leak one caller's identity into other requests.
- The guard runs before validation: on a secure route, a missing credential yields 401 before a malformed body could yield 422.
- Fail-closed by design: a secure route naming an **unregistered** service rejects every request with 401 — it can never silently become public. Catch typos with a test rather than at runtime.
- `secure(' client ')` trims surrounding whitespace; a blank name throws synchronously while the route is being built.
- 401 vs 403: no principal → 401 (`UNAUTHORIZED`); principal present but `authorize` returns false → 403 (`FORBIDDEN`).
- `getUser<T>()` reads only the default `'user'` service. Named principals are read with `await req.services.get<T>('client', undefined)`.

---

## Layered Route Protection

Production mutations need several protections at once: a CSRF token that a cross-site page cannot forge, a rate limit that survives brute force, and authentication that is never bypassed by the order of middleware. WebAFX provides each mechanism separately; this pattern shows how to layer them so each one sits exactly where it belongs.

### When to use it

- You authenticate with cookies (browser sessions), so mutating endpoints are CSRF-relevant.
- Login, password reset, or search endpoints need stricter budgets than the rest of the API.
- You want one protection policy applied application-wide, with minimal per-route noise.

### Implementation

```typescript
import { z } from 'zod';
import {
  WebApplication,
  BaseController,
  csrfPlugin,
  rateLimitMiddleware,
  UnauthorizedError,
} from 'blendsdk/webafx';
import type { ApplicationSettings, ServiceContainer } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface Session {
  userId: string;
  csrfToken: string;
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

class AuthController extends BaseController {
  routes() {
    return [
      // Pre-auth endpoint: CSRF-exempt (see plugin config below) and
      // deliberately rate limited to stop credential stuffing.
      this.route()
        .post('/login')
        .middleware(rateLimitMiddleware({ maxRequests: 5, windowMs: 60_000 }))
        .validate(loginSchema)
        .handle(this.login),

      // Authenticated mutation: session-bound CSRF + its own write budget.
      this.authenticated()
        .put('/profile')
        .middleware(rateLimitMiddleware({ maxRequests: 30, windowMs: 60_000 }))
        .handle(this.updateProfile),
    ];
  }

  private async login(req: Request, res: Response): Promise<void> {
    const { email } = req.services.getParams<{ email: string }>();
    if (email !== 'ada@example.com') {
      throw new UnauthorizedError('Invalid credentials');
    }
    this.ok(res, { session: 'demo-session-token', csrfToken: 'csrf-6f1c9a4e' });
  }

  private async updateProfile(req: Request, res: Response): Promise<void> {
    const session = req.services.getUser<Session>();
    this.ok(res, { userId: session?.userId, updated: true });
  }
}

// --- Application wiring ---------------------------------------------------------

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'production',
  TRUST_PROXY: true, // req.ip honours X-Forwarded-For behind a load balancer
  CORS: { origin: 'https://app.example.com', credentials: true },
});

app.registerService({
  name: 'user',
  type: 'per-request',
  factory: (_container: ServiceContainer, _settings: ApplicationSettings, req: Request) => {
    const cookies: Record<string, unknown> = req.cookies ?? {};
    if (cookies['session'] !== 'demo-session-token') {
      return undefined;
    }
    return { userId: 'usr_1001', csrfToken: 'csrf-6f1c9a4e' } satisfies Session;
  },
});

// Layer 1: CSRF for every mutating request, with an exact-match exemption
// list. The expected token is derived from the authenticated session.
app.use(
  csrfPlugin({
    expectedToken: async req => {
      const session = await req.services.get<Session | undefined>('user', undefined);
      return session?.csrfToken;
    },
    exempt: ['POST /api/auth/login'],
  })
);

app.registerController('/api/auth', AuthController);

const shutdown = await app.start();
```

Runtime pipeline for `PUT /api/auth/profile`:

```
csrfPlugin (403 csrf_invalid) → rateLimitMiddleware (429 RATE_LIMIT_EXCEEDED)
  → authentication (401) → validation (422) → handler → 200
```

Observed behavior:

| Scenario | Result |
|----------|--------|
| `POST /api/auth/login` with a valid body | `200 { success: true, data: { session, csrfToken } }` |
| 6th login attempt within a minute | `429 RATE_LIMIT_EXCEEDED` with `X-RateLimit-Limit/Remaining/Reset` |
| `PUT /api/auth/profile` with session cookie + `X-CSRF-Token: csrf-6f1c9a4e` | `200` |
| `PUT /api/auth/profile` with session but no token | `403 { code: "csrf_invalid" }` |
| `PUT /api/auth/profile` with no session at all | `403 { code: "csrf_invalid" }` — CSRF runs application-wide, before route authentication |

### Why it matters

The layers protect different things and stay independently testable: CSRF proves the request came from your own origin (a cross-site page cannot send the custom header), the rate limiter bounds damage from automated abuse, and authentication/validation happen only after both gates pass. Because the CSRF plugin resolves the session through the *service container*, the token binding stays session-based rather than trusting a client-controlled cookie value alone. Rate-limit headers are set before the error is thrown, so well-behaved clients can back off using `X-RateLimit-Reset` instead of retrying blindly.

### Caveats

- `rateLimitMiddleware` uses in-memory storage: budgets are per-process. Behind multiple instances, back it with a shared store (or a plugin using Redis) — the middleware itself is best for single-instance deployments and defense in depth.
- Exemptions are exact `` `${METHOD} ${path}` `` matches (`POST /api/auth/login`); the method is upper-cased and the path is matched without query strings. There is no prefix matching.
- If neither `expectedToken` nor `cookie` is configured, the CSRF middleware **fails closed** and rejects every mutating request — there is nothing to compare against.
- The double-submit-cookie mode (`cookie: { name: ... }`) is unsigned and therefore defence in depth; prefer session-bound tokens when you have a session store.
- Route middleware runs **before** the route wrapper's authentication step. Anything that depends on `req.services.getUser()` being populated should read the service explicitly (as `expectedToken` does) rather than assume the guard has already run.
- If another plugin populates session state in middleware (for example `express-session`), install it with a lower priority so CSRF's `expectedToken` sees the session.

---

## Request-Scoped Observability

When an incident happens in production, the question is never "what did the code do" — it is "what happened for *this* request". WebAFX gives every request a validated UUID (`X-Request-ID`), propagates it through `AsyncLocalStorage`, and lets you swap the application logger for a JSON backend that stamps every line with that ID.

### When to use it

- Logs ship to an aggregator (ELK, CloudWatch, Loki, Datadog) that expects structured JSON.
- You need to correlate application logs, error envelopes, and downstream service calls by one identifier.
- You want this without threading `requestId` parameters through every service signature.

### Implementation

```typescript
import {
  WebApplication,
  BaseController,
  StructuredLogger,
  getRequestId,
} from 'blendsdk/webafx';
import type { LogLevel, PluginDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

// --- 1. Logger plugin: JSON output + request correlation -----------------------

export function structuredLoggingPlugin(): PluginDefinition {
  return {
    name: 'structured-logging',
    priority: 5, // run before feature plugins; the application logger is swapped immediately
    factory: async ({ app }) => {
      const settings = app.getSettings();
      const level = settings.get<LogLevel>('LOG_LEVEL', 'INFO');

      const logger = new StructuredLogger('APP', level, () => {
        // Runs on every log call. Inside a request this reads the
        // AsyncLocalStorage context; outside one it contributes nothing.
        const requestId = getRequestId();
        return requestId ? { requestId } : {};
      });

      app.setLogger(logger);
    },
  };
}

// --- 2. Request-scoped enrichment anywhere in the call chain ---------------------

class AnalyticsService {
  private readonly logger = new StructuredLogger('AUDIT', 'INFO', () => {
    const requestId = getRequestId();
    return requestId ? { requestId } : {};
  });

  async track(name: string, properties: Record<string, unknown> = {}): Promise<void> {
    // No request object in sight — the correlation ID travels with the async context.
    await this.logger.info(name, properties);
  }
}

class CheckoutController extends BaseController {
  routes() {
    return [this.route().post('/').handle(this.checkout)];
  }

  private async checkout(req: Request, res: Response): Promise<void> {
    const analytics = await req.services.get<AnalyticsService>('analytics');
    await analytics.track('checkout_started', { cartSize: 3 });
    this.ok(res, { orderId: 'ord_501' });
  }
}

// --- 3. Application wiring ---------------------------------------------------------

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'production',
  LOG_LEVEL: 'INFO',
});

app.use(structuredLoggingPlugin());

app.registerService({
  name: 'analytics',
  type: 'singleton',
  factory: () => new AnalyticsService(),
});

app.registerController('/api/checkout', CheckoutController);

const shutdown = await app.start();
```

Startup log (outside a request — no correlation ID):

```json
{"timestamp":"2026-05-12T09:14:19.001Z","level":"INFO","message":"Server listening on http://localhost:3000 (production)","prefix":"APP"}
```

Audit log emitted inside `POST /api/checkout` (correlation ID injected by the context function):

```json
{"timestamp":"2026-05-12T09:14:21.118Z","level":"INFO","message":"checkout_started","prefix":"AUDIT","requestId":"550e8400-e29b-41d4-a716-446655440000","data":{"cartSize":3}}
```

### Why it matters

The request ID is minted once per request, validated if it arrives from an upstream proxy (malformed values are replaced, not trusted), echoed back in the `X-Request-ID` header, embedded in every error envelope by the error handler, and available anywhere in the async call chain via `getRequestId()`. Replacing the logger is a one-line operation for plugins, and because every log entry already carries `level`, `prefix`, `requestId`, and a structured `data` object, your aggregator can index and alert on any of them without parsing prose. Even fire-and-forget async work started inside a handler still observes the same context.

### Caveats

- `getRequestId()` returns `undefined` outside request scope (startup, shutdown, module-level timers) — context functions must handle that, as shown.
- Context functions run on every log call. Keep them cheap; avoid allocations beyond the small object they return.
- Messages logged before `app.setLogger()` — constructor messages and the core middleware setup — still go through `ConsoleLogger`, as does the plugin registry's own install logging. Plugin priority 5 minimizes the window but cannot remove it.
- Pass the configured `LOG_LEVEL` into the logger constructor so settings stay authoritative; the environment variable is only consulted when no constructor level is given. `DEBUG=true` still forces debug entries.
- Do not hold `AsyncLocalStorage` contexts alive beyond the request (long-lived timers, queues). For background jobs, copy the request ID into the job payload instead of relying on context propagation.

---

## Graceful Shutdown Orchestration

Rolling deploys and container orchestrators send `SIGTERM` and expect the process to drain in-flight requests, release resources, and exit — in that order. WebAFX runs this sequence for you: stop accepting connections, drain (with a timeout), run hooks, dispose singletons, shut down plugins. This pattern wires each teardown concern to the right phase.

### When to use it

- Your application holds stateful resources: database pools, message consumers, background pollers, cache clients.
- You deploy in Kubernetes, ECS, or any environment that sends `SIGTERM` before killing the process.
- You need teardown to be ordered, idempotent, and observable.

### Implementation

```typescript
import { WebApplication } from 'blendsdk/webafx';

class DatabasePool {
  private closed = false;
  private readonly log: string[] = [];

  async connect(): Promise<void> {
    this.log.push('CONNECT');
  }

  async query(sql: string): Promise<void> {
    if (this.closed) {
      throw new Error('Pool is closed');
    }
    this.log.push(sql);
  }

  async end(): Promise<void> {
    this.closed = true;
  }

  statements(): readonly string[] {
    return this.log;
  }
}

class JobPoller {
  private timer: NodeJS.Timeout | undefined;
  private polls = 0;

  start(): void {
    this.timer = setInterval(() => {
      this.polls += 1;
    }, 10_000);
    this.timer.unref(); // never keep the process alive just for polling
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  isRunning(): boolean {
    return this.timer !== undefined;
  }

  pollCount(): number {
    return this.polls;
  }
}

const pool = new DatabasePool();
const poller = new JobPoller();

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'production',
  SHUTDOWN_TIMEOUT: 15, // seconds — how long in-flight requests may drain
});

// Phase 1: singleton with disposal — created once, closed during shutdown.
app.registerService({
  name: 'database',
  type: 'singleton',
  factory: () => pool,
  dispose: async () => {
    await pool.end();
  },
});

// Phase 2: lifecycle hooks around the sequence.
app
  .on('beforeStart', async () => {
    await pool.connect(); // never start serving without the database
  })
  .on('beforeShutdown', async () => {
    await pool.query('NOTIFY workers shutdown'); // signal in-flight work to stop
  });

// Phase 3: plugin-owned resource with its own teardown.
app.use({
  name: 'job-poller',
  factory: async () => {
    poller.start();
    return {
      health: async () => poller.isRunning(),
      shutdown: async () => {
        poller.stop();
      },
    };
  },
});

const shutdown = await app.start();

// SIGTERM/SIGINT run exactly this sequence automatically; calling it directly
// is the programmatic equivalent (useful for tests and CLI entrypoints).
await shutdown();

// Idempotent — a second call (for example racing a signal) is a no-op.
await shutdown();
```

What happens when `SIGTERM` arrives:

| # | Phase | Detail |
|---|-------|--------|
| 1 | Stop accepting | `server.close()` — existing requests continue |
| 2 | Drain | Idle and active connections are force-closed after the timeout (`SHUTDOWN_TIMEOUT` seconds in production) |
| 3 | `beforeShutdown` hooks | Awaitable, sequential, in registration order — stop producing new work |
| 4 | Singleton disposal | Every instantiated service's `dispose` callback (started together, awaited with `Promise.all`) |
| 5 | Plugin `shutdown()` | Sequential, in plugin install order (lower priority first) |
| 6 | `afterShutdown` hooks | Final bookkeeping after everything else is torn down |

### Why it matters

Teardown order matters more than teardown effort: closing the database pool while a request still queries it turns a clean deploy into 500s, and stopping the HTTP listener while a queue consumer still writes turns at-least-once into data loss. Each concern has exactly one home here — pre-flight in `beforeStart`, "stop producing" in `beforeShutdown`, pools in `dispose`, plugin internals in `shutdown` — and the framework guarantees the sequence, cleans up its own signal handlers afterwards (no duplicate shutdown on repeated signals), and keeps `SIGINT` working identically in development.

### Caveats

- `SHUTDOWN_TIMEOUT` only applies when `ENV_MODE` is `production`. In development and test the drain window is capped at 1 second, so local Ctrl+C stays snappy.
- The drain window is a hard budget: connections still active when it expires are force-closed (`closeIdleConnections` + `closeAllConnections`). Size it above your slowest critical request.
- Singleton `dispose` callbacks run concurrently — do not rely on one service being disposed before another. Cross-resource sequencing belongs in a `beforeShutdown` hook.
- Plugin `shutdown()` runs in **forward** install order (lowest priority first), not reversed. Invert dependencies explicitly if you need the opposite.
- `beforeShutdown` hooks run after the server has stopped accepting connections — they signal backend collaborators (queues, databases), not in-flight clients.
- The drain timer is armed when shutdown begins and is not cancelled when draining finishes early; a process relying on natural event-loop exit may linger until that timer fires. Applications that exit explicitly after `await shutdown()` are unaffected.

---

## Paginated Endpoints, Documented End-to-End

`BaseController.paginated()` produces the `{ success, data, pagination }` envelope. But `blendsdk/codegen` generates clients from your `.openapi()` route metadata — and a generated client that unwraps only `data` silently throws `pagination` away. This pattern makes pagination a first-class, documented contract from schema to generated client.

### When to use it

- Any list endpoint you expect third parties or other teams to consume through a generated client.
- Whenever you want query parameters validated (coerced, defaulted, capped) before the handler runs.

### Implementation

```typescript
import { z } from 'zod';
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

const listProductsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).optional(),
});

interface Product {
  id: string;
  name: string;
  priceCents: number;
}

const catalog: Product[] = [
  { id: 'prd_1', name: 'Mechanical Keyboard', priceCents: 12900 },
  { id: 'prd_2', name: 'Trackball Mouse', priceCents: 8900 },
  { id: 'prd_3', name: '27 inch Monitor', priceCents: 34900 },
];

class ProductsController extends BaseController {
  routes() {
    return [
      this.route()
        .get('/')
        .openapi({
          summary: 'List products',
          tags: ['products'],
          operationId: 'listProducts',
          // Keep the whole response body in generated clients, so the
          // pagination metadata survives alongside data.
          envelope: 'body',
          responses: [
            { statusCode: 200, description: 'Paginated product list' },
          ],
        })
        .validate(listProductsQuery)
        .handle(this.list),
    ];
  }

  private async list(req: Request, res: Response): Promise<void> {
    // getParams() returns the *validated* result: page and limit are numbers
    // with defaults applied, search is trimmed — never the raw query strings.
    const { page, limit, search } = req.services.getParams<
      z.infer<typeof listProductsQuery>
    >();

    const matches =
      search === undefined
        ? catalog
        : catalog.filter(product =>
            product.name.toLowerCase().includes(search.toLowerCase())
          );

    const start = (page - 1) * limit;
    const pageItems = matches.slice(start, start + limit);

    this.paginated(res, pageItems, matches.length, page, limit);
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });
app.registerController('/api/products', ProductsController);

const shutdown = await app.start();
```

`GET /api/products?page=2&limit=2` produces:

```json
{
  "success": true,
  "data": [
    { "id": "prd_3", "name": "27 inch Monitor", "priceCents": 34900 }
  ],
  "pagination": { "total": 3, "page": 2, "limit": 2, "pages": 2 }
}
```

The metadata contract for `blendsdk/codegen`:

```typescript
// ❌ Before — default 'data' envelope: generated clients unwrap `data`
//    and silently drop the `pagination` object.
this.route().get('/').openapi({ summary: 'List products' }).validate(listProductsQuery).handle(this.list);

// ✅ After — declared body envelope: generated clients return the whole
//    response `{ data, pagination }` for this operation.
this.route().get('/').openapi({ summary: 'List products', envelope: 'body' }).validate(listProductsQuery).handle(this.list);
```

### Why it matters

The endpoint has one definition of truth for its contract: the Zod schema governs what arrives (coercion from query strings, defaults, a hard `limit` cap of 100), `paginated()` governs what leaves, and `.openapi()` metadata governs what generated clients do with it. WebAFX stores only the metadata — spec generation happens in `blendsdk/codegen` — and routes without `.openapi()` stay out of the spec entirely, so this is a deliberate opt-in per endpoint rather than a leak of every internal route.

### Caveats

- `envelope: 'body'` changes generated-client behavior only; the server always sends `{ success, data, pagination }`.
- Forgetting `envelope: 'body'` on a paginated route is not a server bug — the JSON is correct — but generated clients lose `pagination`, which is easy to misdiagnose as a client bug. Make it part of your route review checklist.
- `getParams()` returns validated values (`page: 2` as a number); `getInput().query` returns the raw strings (`page: '2'`). Choose deliberately.
- Validation merges `params`, then `query`, then `body` — later sources win. Keep field names distinct across sources to avoid surprising precedence.
- The in-memory slice is illustrative; paginate in the data source (SQL `LIMIT`/`OFFSET` or keyset pagination) for real datasets.
- `pages` is computed as `Math.ceil(total / limit)` — the schema's `limit >= 1` guard is what keeps that division sane.

---

## SPA and API Co-Hosting

Serving a React/Vue/Angular build and a JSON API from one process is convenient — and famously easy to get wrong: a naive `index.html` fallback swallows API routes that look like navigation (for example `GET /api/oidc/login`). WebAFX's static files plugin runs its SPA fallback in the **terminal phase**, after controllers and `/health`, so fallbacks can never shadow real routes.

### When to use it

- You deploy a client-side-rendered frontend and its API as a single artifact (one container, one domain, no CORS).
- You want hashed build assets cached aggressively while `index.html` stays fresh.
- You need `/health` and API endpoints to keep returning JSON even when a browser sends `Accept: text/html`.

### Implementation

```typescript
import { WebApplication, BaseController, staticFilesPlugin } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class CatalogApiController extends BaseController {
  routes() {
    return [
      this.route()
        .get('/products')
        .handle(async (_req: Request, res: Response) => {
          this.ok(res, { products: ['Keyboard', 'Monitor'] });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

// 1. Hashed build assets — cache aggressively. No index fallback here.
app.use(
  staticFilesPlugin({
    root: './client/dist/assets',
    prefix: '/assets',
    maxAge: '1y',
    immutable: true,
    index: false,
  })
);

// 2. SPA entry points — default (no) caching so deploys are picked up,
//    plus an index.html fallback for client-side routes.
app.use(
  staticFilesPlugin({
    root: './client/dist',
    spa: true,
  })
);

app.registerController('/api', CatalogApiController);

const shutdown = await app.start();
```

Request outcomes after startup:

| Request | Result |
|---------|--------|
| `GET /api/products` (`Accept: application/json`) | 200 JSON from the controller |
| `GET /api/oidc/login` (`Accept: text/html`) | Reaches the controller — the terminal-phase fallback cannot swallow it |
| `GET /health` | JSON health payload, never `index.html` |
| `GET /assets/main.abc123.js` | 200 with `Cache-Control: max-age=31536000, immutable` |
| `GET /settings/profile` (`Accept: text/html`) | `index.html` served — client-side router takes over |
| `GET /missing.css` | 404 — file-extension guard (missing files are missing files) |
| `POST /about` | 404 — method guard (mutations never receive `index.html`) |
| `GET /api/data` (`Accept: application/json`) | 404 JSON envelope — Accept guard (API clients get API-shaped errors) |

### Why it matters

The fallback middleware is designed to intercept only genuine client-side navigation: it handles `GET` only, skips paths whose last segment has a file extension, and responds only when the `Accept` header includes `text/html`. Combined with the terminal mounting point — after controllers, `/health`, and before the 404 handler — this yields an ordering that is otherwise painful to achieve with hand-mounted middleware: real routes always win, real files are served by `express.static`, client routes get the SPA shell, and everything else gets a correct 404 in the standard error envelope. Two plugin instances (assets and SPA root) coexist because their prefixes produce distinct plugin names.

### Caveats

- The root directory is validated when the plugin installs — if it does not exist, `app.start()` rejects with the resolved path in the message. That fail-fast check catches missing build steps in CI.
- `dotfiles` defaults to `'ignore'` (dotfiles 404). Change only if you deliberately serve them.
- Do not apply a long `maxAge` to the plugin serving `index.html` — stale shells delay deploys. That is why the example caches only the hashed `/assets` tree.
- The fallback serves `index.html` directly at the requested URL (no redirect), which is what history-API routers expect.
- Helmet's Content-Security-Policy is disabled by default in WebAFX so applications can define their own; if your SPA uses restrictive CSP, configure it explicitly on `app.express`.

---

## Domain Error Translation

Business code should not speak HTTP. A wallet service knows about "insufficient funds", not about status code 409 — but clients deserve the standard error envelope with correct status codes, `requestId`, and `details`. This pattern keeps the domain layer framework-agnostic and translates once, at the HTTP boundary.

### When to use it

- You have (or want) a testable domain/core layer whose unit tests never import Express.
- One domain error maps to a specific API contract (`code`, status, `details`) that consumers rely on.
- You want a single, greppable place to review what error information leaves the process.

### Implementation

```typescript
import { z } from 'zod';
import { WebApplication, BaseController, ApiError, NotFoundError } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

// --- Domain layer: pure business errors, no HTTP concepts -----------------------

class WalletNotFoundError extends Error {
  constructor(public readonly walletId: string) {
    super(`Wallet ${walletId} not found`);
    this.name = 'WalletNotFoundError';
  }
}

class InsufficientFundsError extends Error {
  constructor(
    public readonly availableCents: number,
    public readonly requestedCents: number
  ) {
    super('Insufficient funds');
    this.name = 'InsufficientFundsError';
  }
}

class WalletService {
  private readonly balances = new Map<string, number>([
    ['wlt_1', 5000],
    ['wlt_2', 250000],
  ]);

  withdraw(walletId: string, amountCents: number): number {
    const balance = this.balances.get(walletId);
    if (balance === undefined) {
      throw new WalletNotFoundError(walletId);
    }
    if (amountCents > balance) {
      throw new InsufficientFundsError(balance, amountCents);
    }
    const remaining = balance - amountCents;
    this.balances.set(walletId, remaining);
    return remaining;
  }
}

// --- HTTP boundary: one translation point -------------------------------------------

function toHttpError(error: unknown): ApiError {
  if (error instanceof WalletNotFoundError) {
    return new NotFoundError('Wallet not found', { walletId: error.walletId });
  }
  if (error instanceof InsufficientFundsError) {
    return new ApiError(409, 'INSUFFICIENT_FUNDS', 'Not enough funds for this withdrawal', {
      availableCents: error.availableCents,
      requestedCents: error.requestedCents,
    });
  }
  // Unknown errors keep their 500 + generic message semantics.
  throw error;
}

const withdrawSchema = z.object({
  amountCents: z.coerce.number().int().positive(),
});

class WalletController extends BaseController {
  routes() {
    return [
      this.route()
        .post('/:id/withdraw')
        .validate(withdrawSchema)
        .handle(this.withdraw),
    ];
  }

  private async withdraw(req: Request, res: Response): Promise<void> {
    const walletId = req.params['id'];
    const { amountCents } = req.services.getParams<{ amountCents: number }>();

    try {
      const wallet = await req.services.get<WalletService>('wallet');
      const remainingCents = wallet.withdraw(walletId, amountCents);
      this.ok(res, { walletId, remainingCents });
    } catch (error) {
      throw toHttpError(error);
    }
  }
}

// --- Wiring ----------------------------------------------------------------------------

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

app.registerService({
  name: 'wallet',
  type: 'singleton',
  factory: () => new WalletService(),
});

app.registerController('/api/wallets', WalletController);

const shutdown = await app.start();
```

`POST /api/wallets/wlt_1/withdraw` with `{ "amountCents": 7500 }` fails against the `wlt_1` balance of 5000 cents and produces:

```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_FUNDS",
    "message": "Not enough funds for this withdrawal",
    "statusCode": 409,
    "details": { "availableCents": 5000, "requestedCents": 7500 },
    "timestamp": "2026-05-12T09:20:44.502Z",
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "path": "/api/wallets/wlt_1/withdraw"
  }
}
```

If the domain layer is allowed to depend on WebAFX, an alternative removes the translation function entirely — let the error *be* an `ApiError`:

```typescript
import { ApiError } from 'blendsdk/webafx';

export class InsufficientFundsError extends ApiError {
  constructor(availableCents: number, requestedCents: number) {
    super(409, 'INSUFFICIENT_FUNDS', 'Not enough funds for this withdrawal', {
      availableCents,
      requestedCents,
    });
  }
}
// Services can then `throw new InsufficientFundsError(...)` directly and the
// error handler formats it — at the cost of importing the framework into
// your domain layer.
```

### Why it matters

Everything the error handler adds — `timestamp`, `requestId`, `path`, production stack suppression, and resilience to a failing logger — is applied for free to any `ApiError` you throw. The translation boundary gives you a reviewed list of what `details` may leave the process, keeps unit tests for `WalletService` free of HTTP imports, and makes the mapping greppable in one place when an API contract changes.

### Caveats

- Only `ApiError` instances (and subclasses) carry a status code and error code. Anything else becomes `500 INTERNAL_SERVER_ERROR`.
- `ENV_MODE` defaults to `production`, which is secure by default: non-`ApiError` failures return the generic message without `stack`. Development mode includes the real message and stack for debuggability.
- `details` is serialized straight into the response — never place secrets, SQL, or internal identifiers intended only for logs there.
- `.validate()` failures arrive as `ValidationError` with details shaped as `[{ path, message, code }]`; your own `details` shapes pass through untouched.
- Throwing from route middleware, handlers, or awaited service calls is equivalent — all paths funnel into the same formatter, and the 404 handler raises `NotFoundError` for unknown routes automatically.
- If the error logger itself throws, the response is still sent — error reporting never blocks the client.

---

Each pattern above is independently adoptable; combined, they form the production shape of a WebAFX application: features packaged as plugins, principals resolved per route, protection layered in a fixed order, correlation IDs flowing through structured logs, an ordered shutdown, a codegen-ready API surface, an SPA that coexists with the API, and one translation boundary where domain failures become consistent, client-safe error envelopes.

---

# webafx Common Scenarios

Answers to the tasks WebAFX developers run into most often — from starting a server to plugins, security, observability, and testing. Every scenario is self-contained: a short solution followed by a complete, strict-mode TypeScript example. All imports come from the public API — `import { ... } from 'blendsdk/webafx'` — together with types from `express` and `zod`.

---

## How do I start a minimal WebAFX application?

Create a `WebApplication` with a configuration object, register at least one controller, and call `await app.start()`. `start()` loads configuration, installs middleware, plugins, and routes, begins listening, and returns a `shutdown()` function that drains connections and releases resources.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class HelloController extends BaseController {
  routes() {
    return [this.route().get('/').handle(this.sayHello)];
  }

  private async sayHello(_req: Request, res: Response): Promise<void> {
    this.ok(res, { message: 'Hello, World!' });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api/hello', HelloController);

// Starts listening on http://localhost:3000 and installs SIGTERM/SIGINT handlers.
const shutdown = await app.start();

// GET http://localhost:3000/api/hello
// → 200 { "success": true, "data": { "message": "Hello, World!" } }

// Gracefully stop the server (idempotent — calling it twice is safe):
await shutdown();
```

- A `GET /health` endpoint is always registered and reports plugin health.
- `ENV_MODE: 'production'` hides internal error messages and stack traces; other environments include them.
- Calling `start()` twice throws `Application already started`.
- In production, shutdown waits up to `SHUTDOWN_TIMEOUT` seconds (default 7) before force-closing connections; non-production environments use a 1-second window.
- SIGTERM/SIGINT trigger the same graceful shutdown automatically — no manual signal handling needed.

---

## How do I define routes with the RouteBuilder?

Implement `routes()` on a controller and build each endpoint with `this.route()`, an HTTP method, and `handle()` — which must be the last call in the chain. Paths are relative to the base path passed to `app.registerController()`.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class WidgetController extends BaseController {
  routes() {
    return [
      this.route().get('/').handle(this.list),
      this.route().get('/:id').handle(this.byId),
      this.route().post('/').handle(this.create),
      this.route().put('/:id').handle(this.replace),
      this.route().patch('/:id').handle(this.update),
      this.route().delete('/:id').handle(this.remove),
    ];
  }

  private async list(_req: Request, res: Response): Promise<void> {
    this.ok(res, [{ id: 'w1', name: 'Sprocket' }]);
  }

  private async byId(req: Request, res: Response): Promise<void> {
    this.ok(res, { id: req.params.id, name: 'Sprocket' });
  }

  private async create(_req: Request, res: Response): Promise<void> {
    this.created(res, { id: 'w2', name: 'Cog' });
  }

  private async replace(req: Request, res: Response): Promise<void> {
    this.ok(res, { id: req.params.id, name: 'Replaced' });
  }

  private async update(req: Request, res: Response): Promise<void> {
    this.ok(res, { id: req.params.id, patched: true });
  }

  private async remove(_req: Request, res: Response): Promise<void> {
    this.noContent(res);
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api/widgets', WidgetController);

await app.start();
```

- Supported methods: `get`, `post`, `put`, `patch`, `delete`.
- Path parameters use Express syntax (`:id`) and arrive on `req.params`.
- `handle()` throws during startup if the method, path, or handler is missing — configuration mistakes surface before the server accepts traffic.

---

## How do I send standardized success responses?

Every `BaseController` exposes response helpers that produce the WebAFX envelopes: `ok()` (200), `created()` (201), `paginated()` (200 with a `pagination` object), and `noContent()` (204). Using them keeps every endpoint consistent for clients.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface User {
  id: string;
  name: string;
}

class UserController extends BaseController {
  private readonly users: User[] = [
    { id: 'u_1', name: 'Ada' },
    { id: 'u_2', name: 'Grace' },
  ];

  routes() {
    return [
      this.route().get('/:id').handle(this.getUser),
      this.route().post('/').handle(this.createUser),
      this.route().get('/').handle(this.listUsers),
      this.route().delete('/:id').handle(this.deleteUser),
    ];
  }

  private async getUser(req: Request, res: Response): Promise<void> {
    // 200 { success: true, data: { id, name } }
    this.ok(res, { id: req.params.id, name: 'Grace' });
  }

  private async createUser(_req: Request, res: Response): Promise<void> {
    // 201 { success: true, data: { id: 'u_3', name: 'New user' } }
    this.created(res, { id: 'u_3', name: 'New user' });
  }

  private async listUsers(_req: Request, res: Response): Promise<void> {
    // 200 { success: true, data: [...], pagination: { total, page, limit, pages } }
    this.paginated(res, this.users, 42, 1, 10);
  }

  private async deleteUser(_req: Request, res: Response): Promise<void> {
    // 204 with an empty body
    this.noContent(res);
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api/users', UserController);

await app.start();
```

- `paginated(res, data, total, page, limit)` computes `pages` as `Math.ceil(total / limit)`.
- Error responses use a matching `{ success: false, error }` envelope — see "How do I return structured HTTP errors?".

---

## How do I validate request data with Zod?

Chain `.validate(schema)` on a route before `.handle()`. WebAFX merges `params`, `query`, and `body` into one object, parses it with the schema, and stores the result for the handler. Invalid input never reaches the handler — it becomes a `422 VALIDATION_ERROR` response with per-field details.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import { z } from 'zod';
import type { Request, Response } from 'express';

const createUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  age: z.number().int().min(18).optional(),
});

type CreateUserInput = z.infer<typeof createUserSchema>;

class UserController extends BaseController {
  routes() {
    return [
      this.route().post('/').validate(createUserSchema).handle(this.createUser),
    ];
  }

  private async createUser(req: Request, res: Response): Promise<void> {
    // Typed access to the validated, parsed data:
    const input = req.services.getParams<CreateUserInput>();
    this.created(res, { id: 'u_101', ...input });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api/users', UserController);

await app.start();

// POST /api/users with an invalid body responds 422:
// { success: false, error: { code: 'VALIDATION_ERROR', message: 'Validation failed',
//   statusCode: 422, details: [ { path: 'name', message: '...', code: '...' }, ... ] } }
```

- Values from `params` and `query` arrive as strings — use `z.coerce.number()` and similar coercions for numeric route or query parameters.
- Zod object schemas strip unknown keys by default, so extra fields from other sources do not fail the request.
- On secured routes, authentication and authorization run before validation.
- Read individual sources (params vs. query vs. body) with `req.services.getInput()` — see "How do I access request input without field collisions?".

---

## How do I return structured HTTP errors?

Throw one of the built-in HTTP error classes — or a custom `ApiError` — from a handler or middleware. The framework formats it into the `StandardErrorResponse` envelope with `code`, `message`, `statusCode`, `timestamp`, `requestId`, and `path`, and never leaks internals in production.

```typescript
import { ApiError, BaseController, NotFoundError, WebApplication } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class InvoiceController extends BaseController {
  routes() {
    return [
      this.route().get('/:id').handle(this.readInvoice),
      this.route().post('/:id/charge').handle(this.chargeInvoice),
    ];
  }

  private async readInvoice(req: Request, res: Response): Promise<void> {
    if (req.params.id !== 'inv_1') {
      throw new NotFoundError(`Invoice ${req.params.id} not found`, {
        invoiceId: req.params.id,
      });
    }
    this.ok(res, { id: 'inv_1', total: 199 });
  }

  private async chargeInvoice(_req: Request, res: Response): Promise<void> {
    // Use ApiError directly when no built-in class matches the situation:
    throw new ApiError(402, 'PAYMENT_REQUIRED', 'Card was declined', {
      retryAfterSeconds: 60,
    });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api/invoices', InvoiceController);

await app.start();

// GET /api/invoices/nope → 404
// {
//   "success": false,
//   "error": {
//     "code": "NOT_FOUND",
//     "message": "Invoice nope not found",
//     "statusCode": 404,
//     "details": { "invoiceId": "nope" },
//     "timestamp": "2026-02-08T18:30:00.000Z",
//     "requestId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
//     "path": "/api/invoices/nope"
//   }
// }
```

| Class | Status | Code |
| --- | --- | --- |
| `BadRequestError` | 400 | `BAD_REQUEST` |
| `UnauthorizedError` | 401 | `UNAUTHORIZED` |
| `ForbiddenError` | 403 | `FORBIDDEN` |
| `NotFoundError` | 404 | `NOT_FOUND` |
| `ConflictError` | 409 | `CONFLICT` |
| `ValidationError` | 422 | `VALIDATION_ERROR` |
| `RateLimitError` | 429 | `RATE_LIMIT_EXCEEDED` |
| `InternalServerError` | 500 | `INTERNAL_SERVER_ERROR` |
| `ServiceUnavailableError` | 503 | `SERVICE_UNAVAILABLE` |

- The second constructor argument becomes the `details` field in the response.
- Unknown errors become `500 INTERNAL_SERVER_ERROR`; in production the message is replaced with `"Internal Server Error"`.
- Non-production environments include the `stack` property in the error response.

---

## How do I document routes for OpenAPI generation?

Attach `.openapi({...})` metadata to a route. Only routes with this metadata appear in generated specs — it is the opt-in mechanism that keeps internal routes hidden. WebAFX stores pure data; actual spec generation happens in `blendsdk/codegen`.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import { z } from 'zod';
import type { Request, Response } from 'express';

class ProductController extends BaseController {
  routes() {
    return [
      this.route()
        .get('/')
        .openapi({
          summary: 'List products',
          tags: ['products'],
          responses: [{ statusCode: 200, description: 'Paginated product list' }],
          // Paginated responses also carry a `pagination` object, so generated
          // clients must read the whole body instead of just `data`.
          envelope: 'body',
        })
        .handle(this.list),
      this.route()
        .get('/:id')
        .openapi({
          summary: 'Get a product by ID',
          tags: ['products'],
          pathParams: {
            id: { schema: z.coerce.number(), description: 'Product ID' },
          },
          responses: [
            { statusCode: 200, description: 'Product details' },
            { statusCode: 404, description: 'Product not found' },
          ],
        })
        .handle(this.getOne),
    ];
  }

  private async list(_req: Request, res: Response): Promise<void> {
    this.paginated(res, [{ id: 1, name: 'Sprocket' }], 42, 1, 10);
  }

  private async getOne(req: Request, res: Response): Promise<void> {
    this.ok(res, { id: req.params.id, name: 'Sprocket' });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api/products', ProductController);

await app.start();
```

- Metadata fields: `summary`, `description`, `tags`, `operationId`, `deprecated`, `pathParams`, `responses`, `envelope`.
- `envelope: 'data'` (the default) means the generated client unwraps the top-level `data` property.
- Use `envelope: 'body'` for routes that respond through `paginated()` — otherwise the client returns only `data` and drops `pagination`.

---

## How do I protect a route with authentication?

Mark routes with `.secure()` (or `this.authenticated()`). The framework resolves the authenticated principal from the service container under the name `user`, and rejects the request with `401 UNAUTHORIZED` before the handler runs when no principal exists. Register a per-request `user` service — for example, from an auth plugin — that verifies the request.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { ApplicationSettings, ServiceContainer } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface User {
  id: string;
  name: string;
}

class ProfileController extends BaseController {
  routes() {
    return [
      this.route().get('/public').handle(this.readPublic),
      this.authenticated().get('/me').handle(this.readMe),
    ];
  }

  private async readPublic(_req: Request, res: Response): Promise<void> {
    this.ok(res, { message: 'Anyone can read this' });
  }

  private async readMe(req: Request, res: Response): Promise<void> {
    // Shortcut for req.services.get<User>('user'):
    const user = req.services.getUser<User>();
    this.ok(res, { user });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

// The default principal service is named 'user'. Resolve it per request;
// replace the token check with real verification (JWT validation, session lookup).
app.registerService({
  name: 'user',
  type: 'per-request',
  factory: (
    _container: ServiceContainer,
    _settings: ApplicationSettings,
    req: Request
  ): User | undefined => {
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    return token === 'valid-token' ? { id: 'u_1', name: 'Ada' } : undefined;
  },
});

app.registerController('/api/profile', ProfileController);

await app.start();

// GET /api/profile/me with Authorization: Bearer valid-token → 200
// GET /api/profile/me without a principal                     → 401 UNAUTHORIZED
```

- `authenticated()` is shorthand for `route().secure()` — both resolve the default `user` service.
- If the principal service is not registered or yields no principal, secure routes fail closed with 401.
- `getUser<T>()` returns `T | undefined`; `req.services.get<T>('user')` throws if the service is not registered.

---

## How do I restrict a route to specific users?

Chain `.authorize(fn)` after `.secure()` / `authenticated()`. The callback receives the request and the resolved principal and returns (or resolves to) a boolean; returning `false` produces `403 FORBIDDEN` with the message `Access denied`.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { ApplicationSettings, ServiceContainer } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface User {
  id: string;
  role: 'user' | 'admin';
}

class AdminController extends BaseController {
  routes() {
    return [
      this.authenticated()
        .get('/dashboard')
        .authorize((_req: Request, user: User) => user.role === 'admin')
        .handle(this.dashboard),
    ];
  }

  private async dashboard(_req: Request, res: Response): Promise<void> {
    this.ok(res, { metrics: { activeUsers: 42 } });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

app.registerService({
  name: 'user',
  type: 'per-request',
  factory: (
    _container: ServiceContainer,
    _settings: ApplicationSettings,
    req: Request
  ): User | undefined => {
    const role = req.headers['x-role'];
    return role === 'admin' || role === 'user' ? { id: 'u_1', role } : undefined;
  },
});

app.registerController('/api/admin', AdminController);

await app.start();

// GET /api/admin/dashboard with x-role: admin       → 200
// GET /api/admin/dashboard with x-role: user        → 403 FORBIDDEN
// GET /api/admin/dashboard without a principal      → 401 UNAUTHORIZED
```

- Authorization runs after authentication, so 401 and 403 are clearly separated.
- The principal passed to `authorize` is the one the route selected — see the next scenario for routes with a different principal service.

---

## How do I authenticate different principal types (e.g., users and machine clients)?

Pass a service name to `secure()` / `authenticated('name')` to select which service container holds the principal. One application can run a `user` service for humans and, for example, a `client` service for API keys — each route resolves only its own principal and fails closed when that service is unregistered or empty.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { ApplicationSettings, ServiceContainer } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface User {
  id: string;
  name: string;
}

interface MachineClient {
  clientId: string;
  scopes: string[];
}

class DataController extends BaseController {
  routes() {
    return [
      // Human users authenticate against the default 'user' service.
      this.authenticated().get('/me').handle(this.me),
      // Machine clients authenticate against the 'client' service.
      this.authenticated('client')
        .get('/export')
        .authorize((_req: Request, client: MachineClient) =>
          client.scopes.includes('export')
        )
        .handle(this.exportData),
    ];
  }

  private async me(req: Request, res: Response): Promise<void> {
    const user = req.services.getUser<User>();
    this.ok(res, { user });
  }

  private async exportData(req: Request, res: Response): Promise<void> {
    const client = await req.services.get<MachineClient | undefined>('client');
    this.ok(res, { exportedBy: client?.clientId });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

app.registerService({
  name: 'user',
  type: 'per-request',
  factory: (
    _container: ServiceContainer,
    _settings: ApplicationSettings,
    req: Request
  ): User | undefined =>
    req.headers['x-user'] === 'ok' ? { id: 'u_1', name: 'Ada' } : undefined,
});

app.registerService({
  name: 'client',
  type: 'per-request',
  factory: (
    _container: ServiceContainer,
    _settings: ApplicationSettings,
    req: Request
  ): MachineClient | undefined =>
    req.headers['x-api-key'] === 'secret'
      ? { clientId: 'svc-reporting', scopes: ['export'] }
      : undefined,
});

app.registerController('/api', DataController);

await app.start();

// GET /api/me with x-user: ok and an 'export' scope on /api/export → 200
// GET /api/export with x-api-key: secret                          → 200
// GET /api/export without a client principal                      → 401
```

- The name must be the principal service name (the auth plugin's `userServiceName`), not the provider singleton.
- Secure routes naming an unregistered service are rejected with 401 — a typo cannot silently make a route public.
- Each route's `authorize` callback receives the principal its route selected.

---

## How do I register and inject services?

Register services with `app.registerService()`. `singleton` services are created once and shared across all requests (ideal for connection pools); `per-request` services are built fresh for each request with the full request context. Resolve them anywhere via `req.services.get<T>(name)`.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { ApplicationSettings, ServiceContainer } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface User {
  id: string;
  name: string;
}

interface DatabasePool {
  findUsers(): Promise<User[]>;
  close(): Promise<void>;
}

class UserController extends BaseController {
  routes() {
    return [
      this.route().get('/').handle(this.list),
      this.route().get('/whoami').handle(this.whoami),
    ];
  }

  private async list(req: Request, res: Response): Promise<void> {
    const db = await req.services.get<DatabasePool>('db');
    this.ok(res, await db.findUsers());
  }

  private async whoami(req: Request, res: Response): Promise<void> {
    const requestInfo = await req.services.get<{ id: string; ip: string }>('request-info');
    this.ok(res, requestInfo);
  }
}

let pool: DatabasePool | undefined;

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

// Singleton: created once and shared by every request.
app.registerService({
  name: 'db',
  type: 'singleton',
  factory: async (): Promise<DatabasePool> => {
    const created: DatabasePool = {
      findUsers: async () => [
        { id: 'u_1', name: 'Ada' },
        { id: 'u_2', name: 'Grace' },
      ],
      close: async () => {},
    };
    pool = created;
    return created;
  },
  dispose: async () => {
    // Runs during shutdown, after beforeShutdown hooks and before plugins stop.
    await pool?.close();
    pool = undefined;
  },
});

// Per-request: a fresh instance per request, with the full request context.
app.registerService({
  name: 'request-info',
  type: 'per-request',
  factory: (
    _container: ServiceContainer,
    _settings: ApplicationSettings,
    req: Request
  ): { id: string; ip: string } => ({
    id: req.id ?? 'unknown',
    ip: req.ip ?? 'unknown',
  }),
});

app.registerController('/api/users', UserController);

await app.start();
```

- `dispose` callbacks run for every created singleton during shutdown; both sync and async disposers are awaited.
- List other service names in `dependencies` to resolve them first — circular dependencies are detected at resolution time and reported with the full chain (for example `a -> b -> c -> a`).
- `await container.get('name', fallback)` returns the fallback when the service is not registered.
- Registering two services with the same name throws; use `container.set('name', instance)` to override a resolved instance for one container.
- `per-request` services can only be resolved during request handling — accessing one outside a request throws.

---

## How do I access request input without field collisions?

Use `req.services.getInput<T>()` for separated `params`, `query`, and `body` objects, or `req.services.getParams<T>()` for the merged view. The merged view resolves collisions in the order params < query < body, so a body field that shares a name with a path parameter wins — `getInput()` keeps them apart.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class CartController extends BaseController {
  routes() {
    return [
      this.route().patch('/cart/:id').handle(this.updateCart),
      this.route().get('/cart/:id').handle(this.readCart),
    ];
  }

  private async updateCart(req: Request, res: Response): Promise<void> {
    // Separated sources — the path value cannot be confused with the body.
    const input = req.services.getInput<{
      params: { id: string };
      query: { source?: string };
      body: { id?: string; quantity: number };
    }>();

    this.ok(res, {
      cartIdFromPath: input.params.id,
      cartIdFromBody: input.body.id,
      source: input.query.source,
      quantity: input.body.quantity,
    });
  }

  private async readCart(req: Request, res: Response): Promise<void> {
    // Merged view — later sources win: params < query < body.
    const merged = req.services.getParams<{ id: string }>();
    this.ok(res, { id: merged.id });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api', CartController);

await app.start();

// PATCH /api/cart/42?source=app with body { "id": "from-body", "quantity": 3 }
// updateCart() sees params.id = '42' and body.id = 'from-body' side by side.
// readCart() uses the merged view, where body.id would win over params.id.
```

- When `.validate()` is used, `getParams()` returns the parsed (and, by default, stripped) schema output; `getInput()` always exposes the raw separated sources.
- When no input is present, `getInput()` returns `{ params: {}, query: {}, body: {} }`.

---

## How do I write a plugin with health checks and cleanup?

Register a `PluginDefinition` with `app.use()`. Its `factory` receives `{ app, express, logger }` and can install middleware, register services, and return a `Plugin` object with `health()` and `shutdown()` hooks. Plugins install in ascending `priority` order (default `100`) before controllers are wired.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { Plugin, PluginDefinition } from 'blendsdk/webafx';
import type { NextFunction, Request, Response } from 'express';

function metricsPlugin(): PluginDefinition {
  let requests = 0;

  return {
    name: 'metrics',
    priority: 30, // Lower numbers install first; default is 100.
    factory: async ({ express: expressApp, logger }): Promise<Plugin> => {
      expressApp.use((_req: Request, _res: Response, next: NextFunction): void => {
        requests += 1;
        next();
      });

      await logger.info('Metrics middleware installed');

      return {
        health: async () => true,
        shutdown: async () => {
          await logger.info(`Stopping after ${requests} requests`);
        },
      };
    },
  };
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.use(metricsPlugin());

await app.start();
```

- `GET /health` returns `200 { health: true }` only when every plugin's `health()` resolves to `true`; otherwise it returns `503`.
- `shutdown()` hooks run in installation order during graceful shutdown (after singleton services are disposed).
- Middleware added in the `factory` runs before controllers. For catch-all middleware that must not shadow controller routes (for example an SPA fallback), return a `terminal` hook instead — it mounts after controllers and `/health`, but before the 404 handler.
- Registering two plugins with the same name throws; prefix-aware plugins (like the static files plugin) include the prefix in their name so multiple instances can coexist.

---

## How do I run code at startup and shutdown?

Register lifecycle hooks with `app.on()`. Hooks may be async — they are awaited — and multiple hooks for the same event run in registration order. `on()` returns the app, so hooks can be chained.

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

app
  .on('beforeStart', async () => {
    // Configuration is already loaded. Runs before middleware, plugins, and
    // controllers are installed — a good place to validate dependencies.
    console.log('beforeStart: validating upstream dependencies');
  })
  .on('afterStart', async () => {
    // The server is listening — safe to start background jobs.
    console.log('afterStart: server is accepting connections');
  })
  .on('beforeShutdown', async () => {
    // Runs before singleton services are disposed and plugins are shut down.
    console.log('beforeShutdown: draining background work');
  })
  .on('afterShutdown', async () => {
    // The final step of the shutdown sequence.
    console.log('afterShutdown: done');
  });

const shutdown = await app.start();

// Later — or automatically on SIGTERM/SIGINT:
await shutdown();
```

| Hook | Runs |
| --- | --- |
| `beforeStart` | After configuration is loaded, before middleware, plugins, and routes are installed |
| `afterStart` | Once the server is listening |
| `beforeShutdown` | Before singleton services are disposed and plugins are shut down |
| `afterShutdown` | After everything has been released |

- If a `beforeStart` hook throws, `start()` rejects and the server never begins listening — useful for fail-fast environment checks.

---

## How do I rate limit endpoints?

Apply `rateLimitMiddleware()` globally or per route with `.middleware()`. Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers, and requests over the limit fail with `429 RATE_LIMIT_EXCEEDED` in the standard error envelope.

```typescript
import { WebApplication, BaseController, rateLimitMiddleware } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class SearchController extends BaseController {
  routes() {
    return [
      this.route()
        .get('/search')
        .middleware(rateLimitMiddleware({ maxRequests: 10, windowMs: 60_000 }))
        .handle(this.search),
      this.route()
        .get('/autocomplete')
        .middleware(
          rateLimitMiddleware({
            maxRequests: 100,
            windowMs: 60_000,
            keyExtractor: (req: Request) => {
              const apiKey = req.headers['x-api-key'];
              return typeof apiKey === 'string' ? apiKey : req.ip ?? 'anonymous';
            },
          })
        )
        .handle(this.autocomplete),
    ];
  }

  private async search(_req: Request, res: Response): Promise<void> {
    this.ok(res, { results: [] });
  }

  private async autocomplete(_req: Request, res: Response): Promise<void> {
    this.ok(res, { suggestions: [] });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api', SearchController);

await app.start();
```

- Defaults: 100 requests per 60,000 ms window, keyed by `req.ip` (which respects the trust-proxy setting).
- Pass `message` to customize the 429 error message, and `keyExtractor` to key limits by API key, user ID, or anything else.
- Storage is in-memory and per process — suitable for single-instance deployments. For multiple instances, back the limiter with a shared store via a plugin.
- For a global limit, register the middleware once through a plugin factory or `app.express.use()`.

---

## How do I add CSRF protection?

Install `csrfPlugin()` at the application level, or use `csrfMiddleware()` on selected routes. Mutating requests must present a token in the `x-csrf-token` header that matches either the derived expected token (session-bound mode) or a cookie value (double-submit mode) — compared in constant time.

```typescript
import { WebApplication, BaseController, csrfPlugin } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class TransferController extends BaseController {
  routes() {
    return [this.route().post('/transfer').handle(this.transfer)];
  }

  private async transfer(_req: Request, res: Response): Promise<void> {
    this.ok(res, { transferred: true });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

// Double-submit mode: the 'x-csrf-token' header must equal the 'csrf_token' cookie.
// Mismatches and missing tokens are rejected with 403 before the handler runs.
app.use(csrfPlugin({ cookie: { name: 'csrf_token' } }));

app.registerController('/api', TransferController);

await app.start();

// POST /api/transfer without a valid token → 403
// { "success": false, "error": { "code": "csrf_invalid", "message": "Invalid or missing CSRF token" } }
```

- Safe methods (`GET`, `HEAD`, `OPTIONS`) and exact `METHOD /path` entries in `exempt` (for example `'POST /webhooks'`) pass through without a token.
- Customize the header with `header: 'x-custom-csrf'`; the name is matched case-insensitively.
- Session-bound mode: pass `expectedToken(req)` returning the token stored in the authenticated session — this is stronger than the unsigned double-submit cookie.
- The middleware fails closed: if no expected token can be derived, every mutating request is rejected.

---

## How do I configure CORS?

Provide a `CORS` value in the constructor configuration. `true` enables permissive defaults (wildcard origin); an options object gives you explicit control over origins, methods, headers, credentials, and preflight caching. Without a `CORS` value, no CORS headers are added.

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'development',
  CORS: {
    origin: ['https://app.example.com', 'https://admin.example.com'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-Request-ID'],
    credentials: true,
    maxAge: 7200,
  },
});

await app.start();
```

- A single string origin is matched exactly; an array reflects the matching request origin; `CORS: false` disables the middleware entirely.
- Dynamic rules use a callback:

```typescript
// typescript fragment — allow any subdomain of example.com
CORS: {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allowed: boolean) => void
  ) => {
    callback(null, !origin || origin.endsWith('.example.com'));
  },
},
```

- Preflight `OPTIONS` requests respond with `204` and the `Access-Control-Allow-*` headers.
- When using `credentials: true`, list explicit origins — browsers reject the `*` wildcard for credentialed requests.

---

## How do I serve static files and single-page apps?

Register `staticFilesPlugin()` with `spa: true`. The plugin wraps `express.static` with typed options and mounts an `index.html` fallback in the terminal phase — after controllers and `/health`, so it can never shadow API routes.

```typescript
import { WebApplication, staticFilesPlugin } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

app.use(
  staticFilesPlugin({
    root: './client/build',
    spa: true,
  })
);

await app.start();

// GET /                → index.html
// GET /settings/profile → index.html (client-side route)
// GET /assets/missing.css → 404 (missing files are not masked by the fallback)
```

- `root` is resolved against `process.cwd()`; `start()` throws `Static files root directory does not exist` when it is missing.
- `prefix` mounts the files under a URL segment (default `/`); `maxAge` (for example `'1d'`, `'1h'`, or milliseconds) and `immutable` control caching — use long immutable caching for hashed asset filenames via a second plugin instance with its own `prefix` and `root`.
- The SPA fallback only applies to `GET` requests whose path has no file extension and whose `Accept` header includes `text/html` — API clients sending `application/json` still receive proper 404 responses.
- Files themselves are served in the plugin factory (before controllers); only the catch-all fallback runs in the terminal phase.

---

## How do I correlate logs with the request ID?

WebAFX assigns every request a UUID, exposes it as `req.id` and the `X-Request-ID` header, and propagates it through `AsyncLocalStorage` — accessible anywhere in the async call chain with `getRequestId()` or `getRequestContext()`. Pair that with `StructuredLogger` and `app.setLogger()` for JSON logs that include the request ID.

```typescript
import {
  WebApplication,
  BaseController,
  StructuredLogger,
  getRequestId,
} from 'blendsdk/webafx';
import type { Logger } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

const logger: Logger = new StructuredLogger('APP', 'INFO', () => ({
  requestId: getRequestId(),
}));

class OrderController extends BaseController {
  routes() {
    return [this.route().post('/').handle(this.createOrder)];
  }

  private async createOrder(req: Request, res: Response): Promise<void> {
    await logger.info('Creating order');
    this.created(res, { id: 'o_1', requestId: req.id });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production', LOG_LEVEL: 'INFO' });

// Replace the default ConsoleLogger with JSON logging. Messages logged before
// this call (very early startup) still go through ConsoleLogger.
app.setLogger(logger);

app.registerController('/api/orders', OrderController);

await app.start();

// POST /api/orders emits a JSON log line:
// { "timestamp": "...", "level": "INFO", "message": "Creating order",
//   "prefix": "APP", "requestId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8" }
```

- An incoming `X-Request-ID` is reused only when it is a valid UUID; malformed values are replaced with a freshly generated UUID to prevent log corruption.
- The framework logs one line per request (method, URL, status, duration) through the active logger; `LOG_LEVEL` (`ERROR` < `WARN` < `INFO` < `DEBUG`) and `DEBUG: true` filter output.
- `getRequestContext()` returns the full context (`requestId`, `startTime`, plus any properties added during the request).
- `ConsoleLogger` (human-readable) and `StructuredLogger` (JSON) both implement the async `Logger` interface — implement it yourself for other backends.

---

## How do I test my application with supertest?

Start a `WebApplication` with `PORT: 0` (an ephemeral port), pass `app.express` to supertest, and shut down in `afterEach`. Each application owns its own service and plugin registries, so tests never share state and can run in parallel.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import supertest from 'supertest';

class PingController extends BaseController {
  routes() {
    return [this.route().get('/ping').handle(this.ping)];
  }

  private async ping(_req: Request, res: Response): Promise<void> {
    this.ok(res, { pong: true });
  }
}

describe('GET /api/ping', () => {
  let app: WebApplication;
  let shutdown: (() => Promise<void>) | undefined;

  beforeEach(() => {
    app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });
    app.registerController('/api', PingController);
  });

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = undefined;
    }
  });

  test('responds with the standard success envelope', async () => {
    shutdown = await app.start();

    const res = await supertest(app.express).get('/api/ping').expect(200);

    expect(res.body).toEqual({ success: true, data: { pong: true } });
  });
});
```

- Routes, plugins, and services are wired during `start()` — register everything before calling it.
- `PORT: 0` avoids port conflicts when tests run in parallel.
- `LOG_LEVEL: 'ERROR'` keeps test output quiet; non-production environments include error stack traces in responses.
- Always call `shutdown()` in `afterEach` (even when a test fails) to release the server and registered signal handlers.

---

# webafx Examples Library

Every example below is a complete, copy-paste ready ESM module. They assume Node.js >= 22 and top-level `await`. Install the umbrella package together with its peer dependencies first:

```bash
npm install blendsdk express zod
```

The umbrella install provides the `blendsdk/webafx` import path used by every example. Expected responses and log lines are shown as comments at the end of each code block.

---

## Application Basics

Bootstrap a `WebApplication`, load configuration, and manage its full lifecycle.

### Hello World Web Application

The smallest complete WebAFX server: one controller, one route, one response helper.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class HelloController extends BaseController {
  routes() {
    return [this.route().get('/').handle(this.sayHello)];
  }

  private async sayHello(_req: Request, res: Response): Promise<void> {
    this.ok(res, { message: 'Hello, World!' });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api/hello', HelloController);

// `start()` begins listening and returns a shutdown function.
// SIGTERM / SIGINT trigger the same graceful shutdown automatically.
await app.start();

// GET http://localhost:3000/api/hello
// 200 ->
// {
//   "success": true,
//   "data": { "message": "Hello, World!" }
// }
```

### Validated Application Configuration

`ApplicationSettings` validates standard properties with a Zod schema while allowing custom keys, and can merge configuration from a JavaScript file.

```typescript
import { ApplicationSettings } from 'blendsdk/webafx';

const settings = new ApplicationSettings({
  PORT: 3000,
  ENV_MODE: 'development',
  LOG_LEVEL: 'INFO',
  BODY_LIMIT: '5mb',
  SHUTDOWN_TIMEOUT: 10,
  CUSTOM_FEATURE_FLAG: true, // Custom properties are allowed (passthrough)
});

// Loads and merges additional config; silently returns if the file is absent.
await settings.loadFromFile('.env.local.js');

const port = settings.get<number>('PORT', 4000);
const logLevel = settings.get<string>('LOG_LEVEL', 'ERROR');
const featureEnabled = settings.get<boolean>('CUSTOM_FEATURE_FLAG', false);

console.log(port);           // 3000
console.log(logLevel);       // 'INFO'
console.log(featureEnabled); // true
console.log(settings.isProduction()); // false

// Invalid values are rejected at construction time:
try {
  new ApplicationSettings({ PORT: 70000 });
} catch (error) {
  // Configuration validation failed:
  //   - PORT: Too big: expected number to be <=65535
  console.error(error instanceof Error ? error.message : String(error));
}
```

### Starting and Stopping the Server

`start()` resolves once the server is listening and returns an idempotent shutdown function that drains connections gracefully.

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'production',
  LOG_LEVEL: 'INFO',
  SHUTDOWN_TIMEOUT: 15, // seconds to drain connections before force-closing
});

const shutdown = await app.start();
// [INFO:APP]: Server listening on http://localhost:3000 (production)

// The returned function performs a graceful shutdown.
// SIGTERM and SIGINT are wired to it automatically.
await shutdown();
// [INFO:APP]: Shutting down gracefully (timeout: 15s)...
// [INFO:APP]: Shutdown complete.
```

### Lifecycle Hooks

Register `beforeStart`, `afterStart`, `beforeShutdown`, and `afterShutdown` hooks to run initialization and cleanup around the server lifecycle.

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

app
  .on('beforeStart', async () => {
    console.log('beforeStart: initializing resources');
  })
  .on('afterStart', async () => {
    console.log('afterStart: server is listening');
  })
  .on('beforeShutdown', async () => {
    console.log('beforeShutdown: releasing resources');
  })
  .on('afterShutdown', () => {
    console.log('afterShutdown: cleanup complete');
  });

const shutdown = await app.start();
await shutdown();

// beforeStart: initializing resources         (runs before middleware and plugins)
// afterStart: server is listening
// beforeShutdown: releasing resources         (runs before services are disposed)
// afterShutdown: cleanup complete
```

---

## Controllers and Routing

Define HTTP endpoints with `BaseController` and the fluent `RouteBuilder`, and respond through consistent envelope helpers.

### REST Controller with Response Helpers

A CRUD controller exercising `ok()`, `created()`, `noContent()`, path parameters, and request validation.

```typescript
import { WebApplication, BaseController, NotFoundError } from 'blendsdk/webafx';
import type { Request, Response } from 'express';
import { z } from 'zod';

interface Product {
  id: number;
  name: string;
  price: number;
}

const products = new Map<number, Product>();
let nextId = 1;

const createProductSchema = z.object({
  name: z.string().min(1),
  price: z.number().positive(),
});

class ProductController extends BaseController {
  routes() {
    return [
      this.route().get('/').handle(this.list),
      this.route().post('/').validate(createProductSchema).handle(this.create),
      this.route().get('/:id').handle(this.getById),
      this.route().delete('/:id').handle(this.remove),
    ];
  }

  private async list(_req: Request, res: Response): Promise<void> {
    this.ok(res, Array.from(products.values()));
  }

  private async create(req: Request, res: Response): Promise<void> {
    const { name, price } = req.services.getParams<{ name: string; price: number }>();
    const product: Product = { id: nextId++, name, price };
    products.set(product.id, product);
    this.created(res, product);
  }

  private async getById(req: Request, res: Response): Promise<void> {
    const product = products.get(Number(req.params.id));
    if (!product) {
      throw new NotFoundError(`Product ${req.params.id} not found`);
    }
    this.ok(res, product);
  }

  private async remove(req: Request, res: Response): Promise<void> {
    const deleted = products.delete(Number(req.params.id));
    if (!deleted) {
      throw new NotFoundError(`Product ${req.params.id} not found`);
    }
    this.noContent(res);
  }
}

const app = new WebApplication({ PORT: 3000 });
app.registerController('/api/products', ProductController);
await app.start();

// GET    /api/products     -> 200 { "success": true, "data": [ ... ] }
// POST   /api/products     -> 201 { "success": true, "data": { "id": 1, "name": "Widget", "price": 9.99 } }
// GET    /api/products/999 -> 404 NOT_FOUND
// DELETE /api/products/1   -> 204 (no body)
```

### Paginated Endpoint

`paginated()` adds a `pagination` object alongside the data so clients can render page controls.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface Customer {
  id: number;
  name: string;
}

const customers: Customer[] = Array.from({ length: 137 }, (_, index) => ({
  id: index + 1,
  name: `Customer ${index + 1}`,
}));

class CustomerController extends BaseController {
  routes() {
    return [this.route().get('/').handle(this.list)];
  }

  private async list(req: Request, res: Response): Promise<void> {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const limit = Math.max(1, Number(req.query.limit ?? 50));
    const start = (page - 1) * limit;
    const pageItems = customers.slice(start, start + limit);

    this.paginated(res, pageItems, customers.length, page, limit);
  }
}

const app = new WebApplication({ PORT: 3000 });
app.registerController('/api/customers', CustomerController);
await app.start();

// GET /api/customers?page=2&limit=50
// 200 ->
// {
//   "success": true,
//   "data": [ { "id": 51, "name": "Customer 51" }, ... ],
//   "pagination": { "total": 137, "page": 2, "limit": 50, "pages": 3 }
// }
```

### Route-Level Middleware

Attach middleware to individual routes with `.middleware()`. Multiple calls run in registration order, before the handler.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { NextFunction, Request, Response } from 'express';

const auditLog: string[] = [];

function auditMiddleware(req: Request, _res: Response, next: NextFunction): void {
  auditLog.push(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
}

class ReportController extends BaseController {
  routes() {
    return [
      this.route().get('/daily').middleware(auditMiddleware).handle(this.daily),
      this.route().get('/weekly').middleware(auditMiddleware).handle(this.weekly),
    ];
  }

  private async daily(_req: Request, res: Response): Promise<void> {
    this.ok(res, { report: 'daily', rows: 42 });
  }

  private async weekly(_req: Request, res: Response): Promise<void> {
    this.ok(res, { report: 'weekly', rows: 301 });
  }
}

const app = new WebApplication({ PORT: 3000 });
app.registerController('/api/reports', ReportController);
await app.start();

// GET /api/reports/daily -> 200 { "success": true, "data": { "report": "daily", "rows": 42 } }
// auditLog now contains one entry for the request:
// "2026-01-15T10:30:00.000Z GET /daily"
```

### Multiple Controllers and the Health Endpoint

Register as many controllers as you need on separate base paths. WebAFX also exposes `GET /health` automatically.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class UserController extends BaseController {
  routes() {
    return [this.route().get('/').handle(this.list)];
  }

  private async list(_req: Request, res: Response): Promise<void> {
    this.ok(res, [{ id: 1, name: 'Ada' }]);
  }
}

class OrderController extends BaseController {
  routes() {
    return [this.route().get('/:id').handle(this.getOne)];
  }

  private async getOne(req: Request, res: Response): Promise<void> {
    this.ok(res, { orderId: req.params.id, status: 'shipped' });
  }
}

const app = new WebApplication({ PORT: 3000 });

app.registerController('/api/users', UserController);
app.registerController('/api/orders', OrderController);

await app.start();

// GET /api/users    -> 200 { "success": true, "data": [ { "id": 1, "name": "Ada" } ] }
// GET /api/orders/7 -> 200 { "success": true, "data": { "orderId": "7", "status": "shipped" } }
// GET /health       -> 200 { "health": true, "timestamp": 1739385000000 }
```

---

## Dependency Injection

Register singleton and per-request services on the application's `ServiceContainer` and resolve them with `req.services`.

### Singleton Service

Singleton factories run once; the instance is shared by every request for the lifetime of the application.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface Counter {
  count: number;
}

class CounterController extends BaseController {
  routes() {
    return [this.route().get('/increment').handle(this.increment)];
  }

  private async increment(req: Request, res: Response): Promise<void> {
    const counter = await req.services.get<Counter>('counter');
    counter.count += 1;
    this.ok(res, { count: counter.count });
  }
}

const app = new WebApplication({ PORT: 3000 });

app.registerService({
  name: 'counter',
  type: 'singleton',
  factory: (): Counter => ({ count: 0 }),
});

app.registerController('/api', CounterController);
await app.start();

// The same instance serves every request:
// GET /api/increment -> 200 { "success": true, "data": { "count": 1 } }
// GET /api/increment -> 200 { "success": true, "data": { "count": 2 } }
// GET /api/increment -> 200 { "success": true, "data": { "count": 3 } }
```

### Per-Request Service

Per-request factories run for every HTTP request and receive the full Express request context.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { ApplicationSettings, ServiceContainer } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface RequestInfo {
  method: string;
  path: string;
  receivedAt: number;
}

class InfoController extends BaseController {
  routes() {
    return [this.route().get('/info').handle(this.getInfo)];
  }

  private async getInfo(req: Request, res: Response): Promise<void> {
    const info = await req.services.get<RequestInfo>('request-info');
    this.ok(res, info);
  }
}

const app = new WebApplication({ PORT: 3000 });

app.registerService({
  name: 'request-info',
  type: 'per-request',
  // Per-request factories receive the container, settings, and Express context.
  factory: (
    _container: ServiceContainer,
    _settings: ApplicationSettings,
    req: Request
  ): RequestInfo => ({
    method: req.method,
    path: req.path,
    receivedAt: Date.now(),
  }),
});

app.registerController('/api', InfoController);
await app.start();

// A fresh instance is built for every request:
// GET /api/info -> 200
// {
//   "success": true,
//   "data": { "method": "GET", "path": "/api/info", "receivedAt": 1739385000000 }
// }
```

### Service Dependencies

Declare `dependencies` so the container resolves prerequisite services before a factory runs. Circular chains are detected and rejected at resolution time.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { ServiceContainer } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface UserRecord {
  id: number;
  email: string;
}

interface Database {
  findUserByEmail(email: string): Promise<UserRecord | undefined>;
}

interface UserRepository {
  getUser(email: string): Promise<UserRecord | undefined>;
}

class UserController extends BaseController {
  routes() {
    return [this.route().get('/:email').handle(this.getByEmail)];
  }

  private async getByEmail(req: Request, res: Response): Promise<void> {
    const repository = await req.services.get<UserRepository>('user-repository');
    const user = await repository.getUser(req.params.email);
    this.ok(res, user ?? null);
  }
}

const app = new WebApplication({ PORT: 3000 });

// 1. The database singleton
app.registerService({
  name: 'database',
  type: 'singleton',
  factory: (): Database => ({
    findUserByEmail: async (email: string) => ({ id: 1, email }),
  }),
});

// 2. A repository that declares a dependency on the database.
//    Dependencies are resolved before the factory runs.
app.registerService({
  name: 'user-repository',
  type: 'singleton',
  dependencies: ['database'],
  factory: async (container: ServiceContainer): Promise<UserRepository> => {
    const database = await container.get<Database>('database');
    return {
      getUser: (email: string) => database.findUserByEmail(email),
    };
  },
});

app.registerController('/api/users', UserController);
await app.start();

// GET /api/users/ada@example.com
// 200 -> { "success": true, "data": { "id": 1, "email": "ada@example.com" } }
//
// Misconfigured dependency graphs fail fast:
// "Circular dependency detected: a -> b -> c -> a"
```

### Disposal During Shutdown

Provide a `dispose` callback to release resources when the application shuts down. Disposal runs after `beforeShutdown` hooks and before plugin shutdown.

```typescript
import { WebApplication } from 'blendsdk/webafx';

class InMemoryCache {
  private entries = new Map<string, string>();

  set(key: string, value: string): void {
    this.entries.set(key, value);
  }

  flush(): void {
    this.entries.clear();
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

app.registerService({
  name: 'cache',
  type: 'singleton',
  factory: (): InMemoryCache => new InMemoryCache(),
  // Called during graceful shutdown. The resolved instance arrives typed as
  // `unknown`, so narrow it before use.
  dispose: async (instance) => {
    if (instance instanceof InMemoryCache) {
      instance.flush();
    }
  },
});

const shutdown = await app.start();
await shutdown();
// The dispose callback ran during shutdown and flushed the cache.
```

---

## Request Validation

Parse and validate request input with Zod before handlers run; invalid requests never reach your code.

### Validating Requests with Zod

`.validate(schema)` merges `params`, `query`, and `body`, parses them through the schema, and stores the result for the handler. Failures produce a `422 VALIDATION_ERROR` with field-level details.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';
import { z } from 'zod';

const createUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  age: z.number().int().min(18),
});

interface NewUser {
  name: string;
  email: string;
  age: number;
}

class UserController extends BaseController {
  routes() {
    return [this.route().post('/').validate(createUserSchema).handle(this.create)];
  }

  private async create(req: Request, res: Response): Promise<void> {
    // The parsed (and type-coerced) data replaces the merged params bag.
    const input = req.services.getParams<NewUser>();
    this.created(res, input);
  }
}

const app = new WebApplication({ PORT: 3000 });
app.registerController('/api/users', UserController);
await app.start();

// POST /api/users  { "name": "Ada", "email": "ada@example.com", "age": 36 }
// 201 -> { "success": true, "data": { "name": "Ada", "email": "ada@example.com", "age": 36 } }
//
// POST /api/users  { "name": "Ada", "email": "not-an-email", "age": 36 }
// 422 ->
// {
//   "success": false,
//   "error": {
//     "code": "VALIDATION_ERROR",
//     "message": "Validation failed",
//     "statusCode": 422,
//     "details": [
//       { "path": "email", "message": "Invalid email address", "code": "invalid_format" }
//     ]
//   }
// }
```

### Separated Input Sources

When a route merges colliding names from different sources, read them individually with `getInput()` instead of the merged `getParams()` view.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface RouteInput {
  params: { id: string };
  query: { sort?: string };
  body: { comment: string };
}

class CommentController extends BaseController {
  routes() {
    return [this.route().post('/:id/comments').handle(this.addComment)];
  }

  private async addComment(req: Request, res: Response): Promise<void> {
    const { params, query, body } = req.services.getInput<RouteInput>();
    this.created(res, {
      articleId: params.id,
      sort: query.sort ?? 'newest',
      comment: body.comment,
    });
  }
}

const app = new WebApplication({ PORT: 3000 });
app.registerController('/api/articles', CommentController);
await app.start();

// POST /api/articles/42/comments?sort=oldest  { "comment": "Nice post!" }
// 201 ->
// {
//   "success": true,
//   "data": { "articleId": "42", "sort": "oldest", "comment": "Nice post!" }
// }
//
// getParams() still returns the merged { ...params, ...query, ...body } view
// for handlers that do not need the separation.
```

---

## Authentication and Authorization

Guard routes, choose which service holds the authenticated principal, and gate access with custom rules.

### Protecting Routes with secure()

`.secure()` (or `this.authenticated()`) rejects requests that cannot resolve a principal from the default `user` service with a `401`.

```typescript
import { WebApplication, BaseController, UnauthorizedError } from 'blendsdk/webafx';
import type { ApplicationSettings, ServiceContainer } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface AuthenticatedUser {
  id: number;
  name: string;
}

class ProfileController extends BaseController {
  routes() {
    return [
      this.route().get('/public').handle(this.publicProfile),
      this.authenticated().get('/me').handle(this.myProfile),
    ];
  }

  private async publicProfile(_req: Request, res: Response): Promise<void> {
    this.ok(res, { message: 'Anyone can see this' });
  }

  private async myProfile(req: Request, res: Response): Promise<void> {
    const user = req.services.getUser<AuthenticatedUser>();
    if (!user) {
      // Defensive: secure() already rejected unauthenticated requests.
      throw new UnauthorizedError('Authentication required');
    }
    this.ok(res, { user });
  }
}

const app = new WebApplication({ PORT: 3000 });

// A per-request service named 'user' provides the principal that the
// default secure() guard checks. An auth plugin would register this;
// this example verifies a static token instead.
app.registerService({
  name: 'user',
  type: 'per-request',
  factory: (
    _container: ServiceContainer,
    _settings: ApplicationSettings,
    req: Request
  ): AuthenticatedUser | undefined =>
    req.headers.authorization === 'Bearer valid-token'
      ? { id: 1, name: 'Ada' }
      : undefined,
});

app.registerController('/api/profile', ProfileController);
await app.start();

// GET /api/profile/public  (no token)           -> 200 { "success": true, "data": { "message": "Anyone can see this" } }
// GET /api/profile/me      (no token)           -> 401 UNAUTHORIZED
// GET /api/profile/me      (Bearer valid-token) -> 200 { "success": true, "data": { "user": { "id": 1, "name": "Ada" } } }
```

### Multiple Principal Services

A route can authenticate against a named principal service instead of the default — pass the service name to `secure()` or `authenticated()`. This lets one application keep user sessions and machine clients apart.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { ApplicationSettings, ServiceContainer } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface Principal {
  sub: string;
  kind: 'user' | 'client';
}

class DataController extends BaseController {
  routes() {
    return [
      // Default principal — resolves the 'user' service
      this.authenticated().get('/me').handle(this.me),
      // Machine clients — resolves the 'client' service instead
      this.authenticated('client').get('/export').handle(this.exportData),
    ];
  }

  private async me(req: Request, res: Response): Promise<void> {
    const user = await req.services.get<Principal>('user', undefined);
    this.ok(res, { caller: user?.sub, kind: user?.kind });
  }

  private async exportData(req: Request, res: Response): Promise<void> {
    const client = await req.services.get<Principal>('client', undefined);
    this.ok(res, { caller: client?.sub, kind: client?.kind, rows: 1200 });
  }
}

const app = new WebApplication({ PORT: 3000 });

// Two independent principal services (an auth plugin would register these)
app.registerService({
  name: 'user',
  type: 'per-request',
  factory: (
    _container: ServiceContainer,
    _settings: ApplicationSettings,
    req: Request
  ): Principal | undefined =>
    req.headers['x-user'] === 'ok' ? { sub: 'user-1', kind: 'user' } : undefined,
});

app.registerService({
  name: 'client',
  type: 'per-request',
  factory: (
    _container: ServiceContainer,
    _settings: ApplicationSettings,
    req: Request
  ): Principal | undefined =>
    req.headers['x-client'] === 'ok' ? { sub: 'client-1', kind: 'client' } : undefined,
});

app.registerController('/api', DataController);
await app.start();

// GET /api/me     with X-User: ok    -> 200 { "success": true, "data": { "caller": "user-1", "kind": "user" } }
// GET /api/export with X-Client: ok  -> 200 { "success": true, "data": { "caller": "client-1", "kind": "client", "rows": 1200 } }
// GET /api/export without X-Client   -> 401 (the route checks the 'client' service only)
// A secure route naming an unregistered service also returns 401 — it fails closed.
```

### Custom Authorization Rules

`.authorize()` runs after authentication and receives the principal the route selected. Returning `false` produces a `403 FORBIDDEN`.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { ApplicationSettings, ServiceContainer } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface User {
  id: number;
  role: 'admin' | 'member';
}

class AdminController extends BaseController {
  routes() {
    return [
      this.route()
        .get('/dashboard')
        .secure()
        .authorize((_req: Request, user: User) => user.role === 'admin')
        .handle(this.dashboard),
    ];
  }

  private async dashboard(_req: Request, res: Response): Promise<void> {
    this.ok(res, { stats: { users: 128, orders: 456 } });
  }
}

const app = new WebApplication({ PORT: 3000 });

app.registerService({
  name: 'user',
  type: 'per-request',
  factory: (
    _container: ServiceContainer,
    _settings: ApplicationSettings,
    req: Request
  ): User | undefined => {
    const role = req.headers['x-role'];
    if (role === 'admin') return { id: 1, role: 'admin' };
    if (role === 'member') return { id: 2, role: 'member' };
    return undefined;
  },
});

app.registerController('/api/admin', AdminController);
await app.start();

// GET /api/admin/dashboard with X-Role: admin   -> 200 { "success": true, "data": { "stats": { "users": 128, "orders": 456 } } }
// GET /api/admin/dashboard with X-Role: member  -> 403 FORBIDDEN ("Access denied")
// GET /api/admin/dashboard without X-Role       -> 401 UNAUTHORIZED
```

---

## Error Handling

Throw typed errors from handlers; the framework renders them through the standard error envelope.

### Throwing Typed HTTP Errors

All nine built-in HTTP error classes extend `ApiError` and automatically carry the right status code, machine-readable code, and optional details.

```typescript
import {
  WebApplication,
  BaseController,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class AccountController extends BaseController {
  routes() {
    return [
      this.route().post('/').handle(this.createAccount),
      this.route().get('/:id').handle(this.getAccount),
    ];
  }

  private async createAccount(req: Request, res: Response): Promise<void> {
    const email = req.query.email;
    if (typeof email !== 'string') {
      throw new BadRequestError('The email query parameter is required');
    }
    if (email === 'taken@example.com') {
      throw new ConflictError('An account with this email already exists', { email });
    }
    this.created(res, { id: 1, email });
  }

  private async getAccount(req: Request, res: Response): Promise<void> {
    if (req.params.id !== '1') {
      throw new NotFoundError(`Account ${req.params.id} not found`, { id: req.params.id });
    }
    this.ok(res, { id: 1, email: 'ada@example.com' });
  }
}

const app = new WebApplication({ PORT: 3000 });
app.registerController('/api/accounts', AccountController);
await app.start();

// GET /api/accounts/99
// 404 ->
// {
//   "success": false,
//   "error": {
//     "code": "NOT_FOUND",
//     "message": "Account 99 not found",
//     "statusCode": 404,
//     "timestamp": "2026-01-15T10:30:00.000Z",
//     "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
//     "path": "/api/accounts/99",
//     "details": { "id": "99" }
//   }
// }
```

### Custom Error Class with ApiError

Extend `ApiError` to model domain-specific failures while keeping the standardized envelope.

```typescript
import { ApiError, WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class PaymentRequiredError extends ApiError {
  constructor(message = 'Payment is required to access this resource', details?: unknown) {
    super(402, 'PAYMENT_REQUIRED', message, details);
  }
}

const hasActiveSubscription = false;

class BillingController extends BaseController {
  routes() {
    return [this.route().get('/invoice').handle(this.getInvoice)];
  }

  private async getInvoice(_req: Request, res: Response): Promise<void> {
    if (!hasActiveSubscription) {
      throw new PaymentRequiredError('Your subscription has expired', {
        renewAt: 'https://example.com/billing',
      });
    }
    this.ok(res, { status: 'active' });
  }
}

const app = new WebApplication({ PORT: 3000 });
app.registerController('/api/billing', BillingController);
await app.start();

// GET /api/billing/invoice
// 402 ->
// {
//   "success": false,
//   "error": {
//     "code": "PAYMENT_REQUIRED",
//     "message": "Your subscription has expired",
//     "statusCode": 402,
//     "details": { "renewAt": "https://example.com/billing" }
//   }
// }
```

### Wrapping External Errors

Re-throw `ApiError` instances unchanged and convert unexpected failures into typed errors. Wrapped messages are always shown to clients, unlike raw `Error` messages which are hidden in production.

```typescript
import {
  ApiError,
  WebApplication,
  BaseController,
  InternalServerError,
} from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class SearchIndexUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchIndexUnavailableError';
  }
}

async function searchIndex(query: string): Promise<Array<{ id: number; title: string }>> {
  if (query === 'boom') {
    throw new SearchIndexUnavailableError('Index node unreachable');
  }
  return [{ id: 1, title: `Result for "${query}"` }];
}

class SearchController extends BaseController {
  routes() {
    return [this.route().get('/').handle(this.search)];
  }

  private async search(req: Request, res: Response): Promise<void> {
    try {
      const results = await searchIndex(String(req.query.q ?? ''));
      this.ok(res, results);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error; // Already a typed API error — rethrow unchanged
      }
      throw new InternalServerError('Search is temporarily unavailable', {
        cause: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}

const app = new WebApplication({ PORT: 3000 });
app.registerController('/api/search', SearchController);
await app.start();

// GET /api/search?q=books
// 200 -> { "success": true, "data": [ { "id": 1, "title": "Result for \"books\"" } ] }
//
// GET /api/search?q=boom
// 500 ->
// {
//   "success": false,
//   "error": {
//     "code": "INTERNAL_SERVER_ERROR",
//     "message": "Search is temporarily unavailable",
//     "statusCode": 500,
//     "details": { "cause": "Index node unreachable" }
//   }
// }
```

---

## Plugins

Package middleware, health checks, and cleanup into priority-ordered plugins.

### Creating a Plugin

A plugin factory receives the application, the Express instance, and a scoped logger. Plugins install in ascending `priority` order, before controllers register their routes.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { NextFunction, Request, Response } from 'express';

const app = new WebApplication({ PORT: 3000, LOG_LEVEL: 'INFO' });

app.use({
  name: 'request-timer',
  priority: 30, // lower values install first (default: 100)
  factory: async ({ express, logger }) => {
    express.use((req: Request, res: Response, next: NextFunction) => {
      const startedAt = Date.now();
      res.on('finish', async () => {
        await logger.debug(
          `${req.method} ${req.path} -> ${res.statusCode} in ${Date.now() - startedAt}ms`
        );
      });
      next();
    });

    await logger.info('Request timer installed');
    return {};
  },
});

await app.start();

// [INFO:PLUGIN:REQUEST-TIMER]: Request timer installed
// The scoped logger is prefixed `Plugin:request-timer`, uppercased in the
// output. The middleware is mounted before controllers, so it observes
// every request.
```

### Plugin Health Checks and Shutdown

A plugin can return `health()` — aggregated by `GET /health` — and `shutdown()`, which runs during graceful shutdown after singleton services are disposed.

```typescript
import { WebApplication } from 'blendsdk/webafx';

let databaseConnected = false;

const app = new WebApplication({ PORT: 3000, LOG_LEVEL: 'INFO' });

app.use({
  name: 'database',
  priority: 20,
  factory: async ({ logger }) => {
    databaseConnected = true;
    await logger.info('Database pool created');

    return {
      // Aggregated into GET /health; if any plugin is unhealthy the
      // endpoint responds 503 instead of 200.
      health: async () => databaseConnected,
      shutdown: async () => {
        databaseConnected = false;
        await logger.info('Database pool closed');
      },
    };
  },
});

const shutdown = await app.start();

// GET /health -> 200 { "health": true, "timestamp": 1739385000000 }
// If the health check returned false: 503 { "health": false, "timestamp": 1739385000000 }

await shutdown();
// [INFO:APP]: Shutting down gracefully (timeout: 7s)...
// [INFO:PLUGINS]: Shutting down database plugin.
// [INFO:PLUGIN:DATABASE]: Database pool closed
// [INFO:APP]: Shutdown complete.
```

### Catch-All Fallbacks in the Terminal Phase

A plugin's optional `terminal` hook mounts middleware after controllers, `/health`, and after all other plugins' terminals (in priority order), but before the 404 handler — so fallbacks never shadow real routes.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { NextFunction, Request, Response } from 'express';

class ApiController extends BaseController {
  routes() {
    return [this.route().get('/status').handle(this.status)];
  }

  private async status(_req: Request, res: Response): Promise<void> {
    this.ok(res, { status: 'ok' });
  }
}

const app = new WebApplication({ PORT: 3000 });

// Middleware added in the factory would run BEFORE controllers and could
// swallow them; the terminal phase exists to prevent exactly that. This is
// the same phase staticFilesPlugin({ spa: true }) uses for its index.html
// fallback.
app.use({
  name: 'legacy-redirects',
  priority: 90,
  factory: async () => ({
    terminal: async ({ express, logger }) => {
      express.use((req: Request, res: Response, next: NextFunction) => {
        if (req.method === 'GET' && req.path.startsWith('/legacy/')) {
          res.redirect(301, req.path.replace('/legacy/', '/api/'));
          return;
        }
        next();
      });
      await logger.info('Legacy redirects mounted');
    },
  }),
});

app.registerController('/api', ApiController);
await app.start();

// GET /api/status    -> 200 { "success": true, "data": { "status": "ok" } } (controller wins)
// GET /legacy/status -> 301 Location: /api/status
// GET /unknown       -> 404 (falls through to the framework 404 handler)
```

---

## Security

CORS, CSRF protection, and rate limiting.

### CORS Configuration

Control cross-origin access through the `CORS` setting: `false` disables it, `true` allows every origin, or pass a configuration object.

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({
  PORT: 3000,
  CORS: {
    origin: ['https://app.example.com', 'https://admin.example.com'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    maxAge: 7200, // cache preflight results for 2 hours
  },
});

await app.start();

// Origin: https://app.example.com
// -> Access-Control-Allow-Origin: https://app.example.com
// -> Access-Control-Allow-Credentials: true
//
// Origin: https://evil.example.com
// -> no Access-Control-Allow-Origin header (the browser blocks the response)
//
// Preflight: OPTIONS /any-route -> 204 with
// Access-Control-Allow-Methods: GET,POST,PUT,DELETE
// and Access-Control-Allow-Headers: Content-Type,Authorization
```

For dynamic origin rules, configure `origin` as a callback instead of a string or array; it receives the request origin and decides whether to allow it.

### CSRF Protection

`csrfMiddleware` rejects mutating requests that present a missing or wrong token, compared in constant time. Supply `expectedToken` to derive the value from the session, or `cookie: { name }` for unsigned double-submit mode.

```typescript
import {
  WebApplication,
  BaseController,
  csrfMiddleware,
} from 'blendsdk/webafx';
import type { Request, Response } from 'express';

/** In-memory session store for the example — use a real store in production. */
const sessions = new Map<string, { csrfToken: string }>();

class SessionController extends BaseController {
  routes() {
    return [
      // Safe method — issues the session and its CSRF token
      this.route().get('/csrf-token').handle(this.issueToken),

      // Mutating route — requires the token in the X-CSRF-Token header
      this.route()
        .post('/transfer')
        .middleware(
          csrfMiddleware({
            expectedToken: (req: Request) => {
              const sessionId = req.headers['x-session-id'];
              return typeof sessionId === 'string'
                ? sessions.get(sessionId)?.csrfToken
                : undefined;
            },
          })
        )
        .handle(this.transfer),
    ];
  }

  private async issueToken(_req: Request, res: Response): Promise<void> {
    const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
    const csrfToken = `tok-${Math.random().toString(36).slice(2)}`;
    sessions.set(sessionId, { csrfToken });
    res.setHeader('X-Session-Id', sessionId);
    this.ok(res, { csrfToken });
  }

  private async transfer(_req: Request, res: Response): Promise<void> {
    this.ok(res, { transferred: true });
  }
}

const app = new WebApplication({ PORT: 3000 });
app.registerController('/api/session', SessionController);
await app.start();

// 1. GET /api/session/csrf-token
//    -> 200 { "success": true, "data": { "csrfToken": "tok-a1b2c3" } } plus an X-Session-Id header
//
// 2. POST /api/session/transfer with matching X-Session-Id and X-CSRF-Token headers
//    -> 200 { "success": true, "data": { "transferred": true } }
//
// 3. POST /api/session/transfer without the X-CSRF-Token header
//    -> 403 { "success": false, "error": { "code": "csrf_invalid", "message": "Invalid or missing CSRF token" } }
```

For application-wide protection, mount the same middleware through the plugin instead — for example:

```typescript fragment
app.use(csrfPlugin({ cookie: { name: 'csrf' } }));
```

### Rate Limiting

`rateLimitMiddleware` caps requests per window and sets `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers. Exceeding the limit produces a `429 RATE_LIMIT_EXCEEDED`.

```typescript
import { WebApplication, BaseController, rateLimitMiddleware } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class AuthController extends BaseController {
  routes() {
    return [
      this.route()
        .post('/login')
        .middleware(
          rateLimitMiddleware({
            maxRequests: 5,
            windowMs: 60_000,
            message: 'Too many login attempts, try again in a minute',
          })
        )
        .handle(this.login),
    ];
  }

  private async login(_req: Request, res: Response): Promise<void> {
    // In a real application, verify credentials here.
    this.ok(res, { authenticated: true });
  }
}

const app = new WebApplication({ PORT: 3000 });
app.registerController('/api/auth', AuthController);
await app.start();

// Requests 1-5 within a minute:
// 200 with X-RateLimit-Limit: 5, X-RateLimit-Remaining: 4..0, X-RateLimit-Reset: <epoch seconds>
//
// 6th request within the window:
// 429 ->
// {
//   "success": false,
//   "error": {
//     "code": "RATE_LIMIT_EXCEEDED",
//     "message": "Too many login attempts, try again in a minute",
//     "statusCode": 429
//   }
// }
//
// The default key is the client IP; pass keyExtractor to key on something
// else, e.g. (req: Request) => String(req.headers['x-api-key'] ?? req.ip).
```

---

## Logging and Observability

Human-readable and structured logging, plus request correlation IDs propagated through `AsyncLocalStorage`.

### Console Logging

`ConsoleLogger` writes prefixed, human-readable lines. The configured level acts as a verbosity threshold: `ERROR` (1) < `WARN` (2) < `INFO` (3) < `DEBUG` (4).

```typescript
import { ConsoleLogger } from 'blendsdk/webafx';

const logger = new ConsoleLogger('Orders', 'INFO');

await logger.info('Order created', { orderId: 'ord-123', total: 42.5 });
await logger.warn('Payment retry scheduled', { attempt: 2 });
await logger.error('Payment failed', { orderId: 'ord-123' });
await logger.debug('Cache lookup missed', { key: 'order:ord-123' });

// Output (stdout, except ERROR which uses stderr):
// [INFO:ORDERS]: Order created - {"orderId":"ord-123","total":42.5}
// [WARN:ORDERS]: Payment retry scheduled - {"attempt":2}
// [ERROR:ORDERS]: Payment failed - {"orderId":"ord-123"}
//
// The DEBUG line is suppressed because the configured level is INFO.
```

### Structured JSON Logging

`StructuredLogger` emits one JSON object per line for log aggregation, and can attach dynamic context such as the current request ID. Use `app.setLogger()` — typically from a logging plugin — to replace the framework's default logger.

```typescript
import { WebApplication, StructuredLogger, getRequestId } from 'blendsdk/webafx';

// 1. A standalone structured logger with dynamic request context.
//    (Shown output assumes it is called inside a request.)
const requestLogger = new StructuredLogger('Orders', 'INFO', () => ({
  requestId: getRequestId(),
}));

await requestLogger.info('Order created', { orderId: 'ord-123' });
// {"timestamp":"2026-01-15T10:30:00.000Z","level":"INFO","message":"Order created","prefix":"Orders","requestId":"f47ac10b-58cc-4372-a567-0e02b2c3d479","data":{"orderId":"ord-123"}}

// 2. Replace the application logger (a logging plugin would do this in
//    its factory). Subsequent framework logs are emitted as JSON.
const app = new WebApplication({ PORT: 3000, LOG_LEVEL: 'INFO' });
app.setLogger(new StructuredLogger('APP', 'INFO'));

await app.start();
// {"timestamp":"2026-01-15T10:30:00.000Z","level":"INFO","message":"Server listening on http://localhost:3000 (production)","prefix":"APP"}
```

### Request IDs and Context Propagation

WebAFX assigns every request a UUID v4 request ID — reusing an incoming `X-Request-ID` only when it is a valid UUID — and exposes it anywhere in the async call chain via `getRequestId()` and `getRequestContext()`.

```typescript
import {
  WebApplication,
  BaseController,
  getRequestContext,
  getRequestId,
} from 'blendsdk/webafx';
import type { Request, Response } from 'express';

async function writeAuditLog(action: string): Promise<void> {
  // Works anywhere in the async call chain — no need to pass the ID around.
  const requestId = getRequestId() ?? 'no-request';
  console.log(`[${requestId}] ${action}`);
}

class OrderController extends BaseController {
  routes() {
    return [this.route().post('/').handle(this.create)];
  }

  private async create(_req: Request, res: Response): Promise<void> {
    await writeAuditLog('order.create');
    const context = getRequestContext();
    this.created(res, { orderId: 1, startedAt: context?.startTime });
  }
}

const app = new WebApplication({ PORT: 3000 });
app.registerController('/api/orders', OrderController);
await app.start();

// Every response carries an X-Request-ID header, and error responses
// include the same ID in `error.requestId`.
//
// POST /api/orders
// 201 -> { "success": true, "data": { "orderId": 1, "startedAt": 1739385000000 } }
// stdout: [f47ac10b-58cc-4372-a567-0e02b2c3d479] order.create
```

---

## Static Files and SPA Hosting

Serve files and client-side routes with `staticFilesPlugin` — no extra dependencies beyond Express.

### Serving Static Files

The plugin validates that `root` exists at startup and wraps `express.static` with typed options.

```typescript
import { WebApplication, staticFilesPlugin } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000 });

// `root` is resolved relative to process.cwd(); startup throws if it
// does not exist.
app.use(
  staticFilesPlugin({
    root: './public',
    prefix: '/assets',
    maxAge: '1d',
    dotfiles: 'ignore',
  })
);

await app.start();

// ./public/logo.png    -> GET /assets/logo.png     -> 200, Cache-Control: public, max-age=86400
// ./public/.env        -> GET /assets/.env         -> 404 (dotfiles are ignored)
// ./public/missing.png -> GET /assets/missing.png  -> 404
```

### SPA Hosting with Cache Headers

With `spa: true`, unmatched GET requests that look like client-side routes (no file extension, `Accept: text/html`) receive `index.html`. API routes and `/health` are never shadowed.

```typescript
import { WebApplication, BaseController, staticFilesPlugin } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class ApiController extends BaseController {
  routes() {
    return [this.route().get('/users').handle(this.listUsers)];
  }

  private async listUsers(_req: Request, res: Response): Promise<void> {
    this.ok(res, [{ id: 1 }]);
  }
}

const app = new WebApplication({ PORT: 3000 });

// Host the built SPA and fall back to index.html for client-side routes.
// `immutable` caching is safe for content-hashed asset filenames.
app.use(
  staticFilesPlugin({
    root: './client/dist',
    spa: true,
    maxAge: '1y',
    immutable: true,
  })
);

app.registerController('/api', ApiController);
await app.start();

// GET /assets/main.abc123.js -> 200 (served from client/dist)
// GET /api/users             -> 200 { "success": true, "data": [ { "id": 1 } ] } (controller wins)
// GET /settings/profile      -> 200 index.html (SPA fallback, text/html requests only)
// GET /missing.png           -> 404 (file-like paths are never rewritten)
// GET /health                -> 200 { "health": true, "timestamp": 1739385000000 }
```

---

## OpenAPI Metadata

Document routes for `blendsdk/codegen`, which generates the OpenAPI spec and typed clients.

### Documenting Routes for Code Generation

`.openapi()` records pure metadata on a route definition. Routes without it are excluded from generated specs — documentation is strictly opt-in. WebAFX stores the data only; spec generation happens in `blendsdk/codegen`.

```typescript
import { WebApplication, BaseController, NotFoundError } from 'blendsdk/webafx';
import type { Request, Response } from 'express';
import { z } from 'zod';

interface Product {
  id: number;
  name: string;
  price: number;
}

const catalog: Product[] = [
  { id: 1, name: 'Widget', price: 9.99 },
  { id: 2, name: 'Gadget', price: 24.5 },
];

class ProductController extends BaseController {
  routes() {
    return [
      this.route()
        .get('/')
        .openapi({
          summary: 'List products',
          tags: ['products'],
          operationId: 'listProducts',
          // Paginated responses carry a `pagination` object, so generated
          // clients must read the whole body, not just `data`.
          envelope: 'body',
          responses: [{ statusCode: 200, description: 'Paginated product list' }],
        })
        .handle(this.list),

      this.route()
        .get('/:id')
        .openapi({
          summary: 'Get a product by ID',
          tags: ['products'],
          operationId: 'getProduct',
          pathParams: {
            id: { schema: z.coerce.number().int(), description: 'Product ID' },
          },
          responses: [
            { statusCode: 200, description: 'Product details' },
            { statusCode: 404, description: 'Product not found' },
          ],
        })
        .handle(this.getOne),
    ];
  }

  private async list(_req: Request, res: Response): Promise<void> {
    this.paginated(res, catalog, catalog.length, 1, 20);
  }

  private async getOne(req: Request, res: Response): Promise<void> {
    const product = catalog.find(item => item.id === Number(req.params.id));
    if (!product) {
      throw new NotFoundError(`Product ${req.params.id} not found`);
    }
    this.ok(res, product);
  }
}

const app = new WebApplication({ PORT: 3000 });
app.registerController('/api/products', ProductController);
await app.start();

// GET /api/products     -> 200 (paginated envelope; `envelope: 'body'` tells codegen
//                          to return the full body including `pagination`)
// GET /api/products/42  -> 404 NOT_FOUND
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
