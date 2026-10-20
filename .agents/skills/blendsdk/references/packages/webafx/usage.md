> **Package**: `blendsdk/webafx`

# webafx Core Concepts

This document is a deep dive into every major concept, class, and abstraction that WebAFX exposes through its public API. Each section explains what the concept is, how it works internally, shows a complete runnable example, and ends with a reference table. For the big picture, see the Overview; for a step-by-step getting-started guide, see Basic Usage.

The concepts covered, in order:

- **WebApplication** — the lifecycle orchestrator that owns every registry
- **ApplicationSettings** — Zod-validated configuration
- **BaseController** — controllers and the standard response envelopes
- **RouteBuilder** — the fluent route-definition DSL
- **ServiceContainer** — singleton and per-request dependency injection
- **Plugin System** — priority-ordered extensions with health, shutdown, and terminal hooks
- **Request Context and Request IDs** — AsyncLocalStorage-based correlation
- **Error Handling** — typed errors and the standard error envelope
- **Logging** — the `Logger` interface with console and structured implementations
- **CSRF Protection** — token-guarded mutating requests
- **Rate Limiting** — per-key request throttling
- **Static Files and SPA Hosting** — the static files plugin with SPA fallback

---

## WebApplication

### What It Is

`WebApplication` is the single entry point of every WebAFX server. It owns the configuration, the service registry, the plugin registry, the controller registry, the logger, and the underlying Express instance, and it drives the complete lifecycle from `new WebApplication(config)` to `await app.start()` to graceful shutdown. Every other concept in this document is wired into the running server by this class.

### How It Works

`WebApplication` is a facade over Express — `app.express` remains available as an escape hatch — but it takes over the startup sequence entirely. When you call `start()`, the following happens in order:

1. Loads `.env.js` and `.env.local.js` configuration files from the current working directory
2. Runs the `beforeStart` lifecycle hooks
3. Installs core middleware: trust proxy, CORS (when configured), cookie parsing, JSON/urlencoded body parsing (`BODY_LIMIT`), request IDs with `AsyncLocalStorage`, request timing logs, and Helmet security headers (CSP and COEP deliberately left disabled for the application to configure)
4. Attaches a per-request `ServiceContainer` to `req.services`
5. Installs plugins in ascending `priority` order
6. Registers controller routes, each wrapped in the authentication → authorization → validation pipeline
7. Registers `GET /health`, which aggregates plugin health checks
8. Runs plugin terminal hooks — catch-all middleware that must not shadow controller routes
9. Registers the 404 handler (`NotFoundError`) and the error handler (stack traces only outside production)
10. Starts listening, installs SIGTERM/SIGINT handlers, and runs the `afterStart` hooks

`start()` resolves with a `shutdown()` function. Calling it — or receiving SIGTERM/SIGINT — drains in-flight connections, then runs `beforeShutdown` hooks, disposes singleton services, shuts down plugins, runs `afterShutdown` hooks, and removes the signal handlers. The function is idempotent, and in production it waits up to `SHUTDOWN_TIMEOUT` seconds (default `7`) before force-closing open connections.

### Complete Example

```typescript
import { BaseController, WebApplication } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class StatusController extends BaseController {
  routes(): RouteDefinition[] {
    return [this.route().get('/').handle(this.getStatus)];
  }

  private async getStatus(_req: Request, res: Response): Promise<void> {
    this.ok(res, { service: 'orders-api', version: '1.4.0' });
  }
}

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'development',
  LOG_LEVEL: 'INFO',
});

app.registerController('/api/status', StatusController);

let bootTime = 0;

app
  .on('beforeStart', async () => {
    bootTime = Date.now();
  })
  .on('afterStart', () => {
    console.log(`Orders API is accepting requests (boot took ${Date.now() - bootTime}ms)`);
  })
  .on('beforeShutdown', () => {
    console.log('Draining connections...');
  });

const shutdown = await app.start();
// GET http://localhost:3000/api/status
// → { "success": true, "data": { "service": "orders-api", "version": "1.4.0" } }

// Later — or automatically via SIGTERM/SIGINT:
await shutdown();
```

### Key Methods and Properties

| Name | Signature | Description |
|------|-----------|-------------|
| `constructor` | `constructor(config?: ApplicationConfig)` | Creates settings, the Express app, the shared service registry, and the default `ConsoleLogger`; `ENV_MODE` defaults to `'production'` |
| `on` | `on(event: 'beforeStart' \| 'afterStart' \| 'beforeShutdown' \| 'afterShutdown', hook: LifecycleHook): this` | Registers a sync or async lifecycle hook; chainable |
| `registerService` | `registerService(service: ServiceDefinition): this` | Adds a service definition to the application-owned registry; duplicate names throw |
| `registerController` | `registerController(basePath: string, ControllerClass: new (settings: ApplicationSettings, services: ServiceContainer) => BaseController): void` | Mounts all of the controller's routes under `basePath` at startup |
| `use` | `use(plugin: PluginDefinition): this` | Registers a plugin; duplicate plugin names throw immediately |
| `setLogger` | `setLogger(logger: Logger): void` | Replaces the application logger for subsequent log calls |
| `getSettings` | `getSettings<T extends ApplicationSettings>(): T` | Returns a shallow snapshot of the merged configuration |
| `express` | `get express(): Express` | Escape hatch to the underlying Express app (view engines, WebSockets, custom middleware) |
| `start` | `start(): Promise<() => Promise<void>>` | Initializes everything, listens on `PORT` (default `4000`), installs signal handlers; resolves with an idempotent `shutdown()` |

---

## ApplicationSettings

### What It Is

`ApplicationSettings` is the configuration store behind every `WebApplication`. It validates standard configuration keys against a Zod schema, accepts arbitrary custom keys, loads additional values from JavaScript config files, and exposes everything through typed accessors. Its default `ENV_MODE` is `'production'`, so an application is secure-by-default even before configuration is loaded.

### How It Works

- The constructor validates any provided configuration against a Zod schema covering `PORT`, `ENV_MODE`, `LOG_LEVEL`, `DEBUG`, `TRUST_PROXY`, `BODY_LIMIT`, `SHUTDOWN_TIMEOUT`, and `CORS`. Invalid values throw immediately with a field-by-field error message; unknown keys are allowed via `.passthrough()`.
- `WebApplication` loads `.env.js` and then `.env.local.js` from `process.cwd()` at startup. Each file exports either a default object or a named `config` object; its top-level keys are merged into the store, with later files winning for overlapping keys.
- `loadFromFile()` silently returns when the file does not exist, but throws `Configuration file error: <path>` (with `cause`) when the file exists and cannot be imported.
- `LOG_LEVEL` is normalized after loading: an explicit `LOG_LEVEL` wins, otherwise `DEBUG: true` or a non-production `ENV_MODE` selects `DEBUG`, and production falls back to `ERROR`.
- Configuration is the single source of truth — WebAFX never mutates `process.env`.
- `getAll()` returns a shallow copy, so mutating the returned object cannot change the internal store (nested objects are still referenced).

### Complete Example

```typescript
import { ApplicationSettings } from 'blendsdk/webafx';
import type { ApplicationConfig } from 'blendsdk/webafx';

const settings = new ApplicationSettings({
  ENV_MODE: 'development',
  PORT: 3000,
  DATABASE_URL: 'postgres://localhost:5432/app', // custom key, allowed by passthrough
});

// Merges keys from the file when it exists; silently skips when it does not.
await settings.loadFromFile('.env.local.js');

const config = settings.getAll<ApplicationConfig>();
const port = settings.get<number>('PORT', 4000);
const databaseUrl = settings.get<string>('DATABASE_URL', 'postgres://localhost:5432/dev');

console.log(`${config.ENV_MODE} on :${port} → ${databaseUrl}`);
console.log(`production mode: ${settings.isProduction()}`);
```

### Key Methods and Properties

| Name | Signature | Description |
|------|-----------|-------------|
| `constructor` | `constructor(config?: ApplicationConfig, logger?: ConsoleLogger)` | Validates the provided configuration; defaults `ENV_MODE` to `'production'` |
| `loadFromFile` | `loadFromFile(jsPath: string): Promise<void>` | Dynamic-imports a JS config module, merges its top-level keys, normalizes `LOG_LEVEL`, and re-validates; missing files are a no-op |
| `get` | `get<T>(key: keyof ApplicationConfig, defaultValue?: T): T` | Reads a single value and falls back to `defaultValue` when unset |
| `getAll` | `getAll<T extends ApplicationConfig>(): T` | Returns a shallow copy of the entire configuration |
| `isProduction` | `isProduction(): boolean` | `true` when `ENV_MODE === 'production'` |

Standard configuration keys:

| Key | Type | Default / Effect |
|-----|------|------------------|
| `PORT` | `number` | `4000` when omitted; validated to `0`–`65535` |
| `ENV_MODE` | `'production' \| 'development' \| 'test'` | `'production'`; drives Express env and error verbosity |
| `LOG_LEVEL` | `'ERROR' \| 'WARN' \| 'INFO' \| 'DEBUG'` | Normalized on config load; errors only by default |
| `DEBUG` | `boolean` | `true` selects the `DEBUG` log level when `LOG_LEVEL` is absent |
| `TRUST_PROXY` | `boolean` | `true`; sets Express `trust proxy` to `1` (nginx, load balancers) |
| `BODY_LIMIT` | `string` | `'10mb'`; applies to the JSON and urlencoded body parsers |
| `SHUTDOWN_TIMEOUT` | `number` | Seconds (`0`–`300`, default `7`); production connection-drain window |
| `CORS` | `boolean \| CorsConfig` | Disabled unless set; `true` enables permissive defaults (`origin: '*'`, credentials allowed) |

`CorsConfig` fields: `origin` (`string | string[] | callback`), `methods`, `allowedHeaders`, `exposedHeaders`, `credentials`, and `maxAge` (preflight cache, in seconds).

---

## BaseController

### What It Is

`BaseController` is the abstract base class for all controllers. Subclasses implement `routes()` to declare their endpoints using the `RouteBuilder`, and use the protected response helpers (`ok`, `created`, `paginated`, `noContent`) to emit the standard success envelopes. It also gives every handler access to the application settings and the service container.

### How It Works

- At startup, `WebApplication` instantiates each registered controller with the application settings and the application-level `ServiceContainer` — both available as protected properties on the subclass.
- `routes()` is called exactly once during startup and must return an array of `RouteDefinition` objects (typically created by the `route()` builder).
- Each handler is invoked with the controller bound as `this` (`route.handler.call(controller, ...)`), so controller methods can be passed directly to `.handle(this.someMethod)` without manual binding.
- Inside handlers, use `req.services` for the per-request container — never the constructor-injected container, which has no request context.
- Response helpers wrap payloads in the standard envelopes:

```typescript fragment
// StandardSuccessResponse<T>   { success: true, data: T }
// PaginatedResponse<T>         { success: true, data: T[], pagination: { total, page, limit, pages } }
```

### Complete Example

```typescript
import { BaseController, NotFoundError, WebApplication } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface Product {
  id: number;
  name: string;
}

class ProductController extends BaseController {
  private readonly products: Product[] = [
    { id: 1, name: 'Keyboard' },
    { id: 2, name: 'Mouse' },
  ];

  routes(): RouteDefinition[] {
    return [
      this.route().get('/').handle(this.list),
      this.route().get('/:id').handle(this.getOne),
      this.authenticated().post('/').handle(this.create),
      this.route().delete('/:id').handle(this.remove),
    ];
  }

  private async list(_req: Request, res: Response): Promise<void> {
    // 200 { success: true, data: [...], pagination: { total, page, limit, pages } }
    this.paginated(res, this.products, 148, 1, 20);
  }

  private async getOne(req: Request, res: Response): Promise<void> {
    const product = this.products.find(p => p.id === Number(req.params.id));
    if (!product) {
      throw new NotFoundError(`Product ${req.params.id} not found`);
    }
    this.ok(res, product);
  }

  private async create(req: Request, res: Response): Promise<void> {
    const body = req.body as Omit<Product, 'id'>;
    this.created(res, { id: this.products.length + 1, name: body.name });
  }

  private async remove(_req: Request, res: Response): Promise<void> {
    this.noContent(res);
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api/products', ProductController);

const shutdown = await app.start();
// POST /api/products requires an authenticated principal in the default 'user'
// service (registered by an auth plugin); otherwise it answers 401.
```

### Key Methods and Properties

| Name | Signature | Description |
|------|-----------|-------------|
| `routes` | `abstract routes(): RouteDefinition[]` | Declares every endpoint of the controller; called once at startup |
| `route` | `protected route(): RouteBuilder` | Starts a new fluent route definition |
| `authenticated` | `protected authenticated(userServiceName?: string): RouteBuilder` | Shorthand for `route().secure(userServiceName)`; resolves the `'user'` principal by default |
| `ok` | `protected ok<T>(res: Response, data: T): void` | Sends `200` with `{ success: true, data }` |
| `created` | `protected created<T>(res: Response, data: T): void` | Sends `201` with `{ success: true, data }` |
| `paginated` | `protected paginated<T>(res: Response, data: T[], total: number, page: number, limit: number): void` | Sends `200` with `data` plus `pagination: { total, page, limit, pages }` |
| `noContent` | `protected noContent(res: Response): void` | Sends `204` with an empty body |
| `settings` | `protected settings: ApplicationSettings` | Application configuration injected by `WebApplication` |
| `services` | `protected services: ServiceContainer` | Application-level container injected by `WebApplication` |

---

## RouteBuilder

### What It Is

`RouteBuilder` is the fluent DSL for defining HTTP routes. It captures the HTTP method, path, security requirements, authorization callback, middleware, validation schema, and OpenAPI metadata, and finishes with `handle()` to produce a plain `RouteDefinition` object consumed by `WebApplication`.

### How It Works

- Every builder method returns the builder (`this`) until `handle()` terminates the chain and returns a complete `RouteDefinition`. `handle()` throws when the method or path is missing, or when the handler is not a function.
- At startup, `WebApplication` wraps each definition in a request pipeline that runs in this order:
  1. Route-level middleware (added via `.middleware()`, in registration order)
  2. Principal resolution — when the route is secure or has an `authorize` callback, the principal service is resolved (default `'user'`, or the name given to `.secure('name')`)
  3. Authentication — a secure route without a principal fails with `401 UNAUTHORIZED`
  4. Authorization — an `authorize` callback returning `false` fails with `403 FORBIDDEN`
  5. Validation — the Zod schema parses the merged `params` + `query` + `body` (body wins on key collisions); failure produces `422 VALIDATION_ERROR` with `{ path, message, code }` details per issue
  6. The validated data is stored in the service container as `request-params` (merged) and `request-input` (separated sources), then the handler runs
- A route is secure when `secure` is `true` or a string. Hand-built definitions with a blank string still count as secure and fail closed with `401`.
- `.openapi()` is pure opt-in metadata — routes without it are excluded from generated specs. WebAFX stores the data only; spec and client generation happens in `blendsdk/codegen`. For paginated responses returned through `paginated()`, set `envelope: 'body'` so generated clients keep the `pagination` object.

### Complete Example

```typescript
import { BaseController, WebApplication, rateLimitMiddleware } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { z } from 'zod';
import type { Request, Response } from 'express';

const createInvoiceSchema = z.object({
  customerId: z.string().min(1),
  amount: z.number().positive(),
});

interface Principal {
  sub: string;
  role: 'admin' | 'member';
}

class InvoiceController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/:id')
        .openapi({
          summary: 'Get an invoice',
          tags: ['invoices'],
          pathParams: { id: { schema: z.string().min(1), description: 'Invoice ID' } },
          responses: [
            { statusCode: 200, description: 'Invoice details' },
            { statusCode: 404, description: 'Invoice not found' },
          ],
        })
        .handle(this.getInvoice),

      this.authenticated()
        .post('/')
        .middleware(rateLimitMiddleware({ maxRequests: 20, windowMs: 60_000 }))
        .validate(createInvoiceSchema)
        .openapi({
          summary: 'Create an invoice',
          operationId: 'createInvoice',
          responses: [{ statusCode: 201, description: 'Invoice created' }],
        })
        .handle(this.createInvoice),

      this.route()
        .delete('/:id')
        .secure('client')
        .authorize((_req, principal: Principal) => principal.role === 'admin')
        .handle(this.deleteInvoice),
    ];
  }

  private async getInvoice(req: Request, res: Response): Promise<void> {
    this.ok(res, { id: req.params.id, status: 'open' });
  }

  private async createInvoice(req: Request, res: Response): Promise<void> {
    // Params validated by createInvoiceSchema before this runs.
    const input = req.services.getParams<{ customerId: string; amount: number }>();
    this.created(res, { id: 'inv_42', ...input });
  }

  private async deleteInvoice(req: Request, res: Response): Promise<void> {
    this.noContent(res);
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api/invoices', InvoiceController);

const shutdown = await app.start();
// DELETE /api/invoices/:id resolves the 'client' principal service; without a
// registered client principal (e.g. from an auth plugin) it answers 401.
```

A paginated route opts into the full-body envelope so generated clients keep the pagination metadata:

```typescript fragment
this.route()
  .get('/')
  .openapi({
    summary: 'List invoices',
    envelope: 'body', // 'data' (default) unwraps data; 'body' keeps pagination
    responses: [{ statusCode: 200, description: 'Paginated invoices' }],
  })
  .handle(this.list);
```

### Key Methods and Properties

| Name | Signature | Description |
|------|-----------|-------------|
| `get` / `post` / `put` / `patch` / `delete` | `(path: string): this` | Sets the HTTP method and path |
| `secure` | `secure(userServiceName?: string): this` | Requires authentication; resolves the `'user'` service by default or the named principal service; a blank name throws |
| `authorize` | `authorize(fn: AuthorizeFunction): this` | Adds an authorization check that receives the resolved principal; `false` → `403` |
| `middleware` | `middleware(fn: RequestHandler): this` | Appends Express middleware (callable repeatedly); runs in order before the handler |
| `validate` | `validate<TSchema extends ZodType>(schema: TSchema): RouteBuilder` | Parses the merged `params` + `query` + `body`; failure → `422 VALIDATION_ERROR` |
| `openapi` | `openapi(meta: OpenAPIRouteMetadata): this` | Attaches spec metadata (summary, tags, `operationId`, `pathParams`, `responses`, `envelope`, ...); opt-in |
| `handle` | `handle(handler: RouteHandler): RouteDefinition` | Terminates the chain and returns the definition; throws when method/path is missing or the handler is invalid |

---

## ServiceContainer

### What It Is

`ServiceContainer` is the dependency injection container. It supports two lifecycles — `singleton` services created once per application, and `per-request` services created fresh for every HTTP request with access to `req`/`res`/`next` — plus dependency resolution, circular-dependency detection, and shutdown disposal. Each `WebApplication` owns its own registry, so there is no global state and parallel application instances (or test runs) stay isolated.

### How It Works

- A `ServiceRegistry` (`definitions` + `singletons`) is created per `WebApplication`. A middleware installs one `ServiceContainer` per request that shares this registry and is attached to `req.services`.
- `get(name)` first returns a container-local instance, then looks up the definition. Unregistered names either return the provided default or throw. Declared `dependencies` are resolved before the factory runs, and circular chains are detected via a resolution set (`a -> b -> c -> a`).
- Singleton factories run at most once per application; the instance is cached in the registry and shared by every container. Per-request factories run once per request and throw if accessed outside HTTP request handling.
- `registerService()` rejects duplicate names — replacement of a single resolved instance is done with `set()` instead.
- During graceful shutdown, `disposeAll()` invokes each live singleton's `dispose()` (awaiting async disposers) and clears the singleton cache.
- Route wrappers store validated data for handlers: `getParams()` returns the merged `params` + `query` + `body` (body wins on collisions), while `getInput()` keeps the three sources separate — the type-safe way to avoid collisions.

### Complete Example

```typescript
import { BaseController, WebApplication } from 'blendsdk/webafx';
import type { RouteDefinition, ServiceDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface Database {
  findReports(): Promise<Array<{ id: number }>>;
  close(): Promise<void>;
}

const databaseService: ServiceDefinition<Database> = {
  name: 'database',
  type: 'singleton',
  factory: () => ({
    findReports: async () => [{ id: 1 }, { id: 2 }],
    close: async () => undefined,
  }),
  dispose: async (db: Database) => {
    await db.close();
  },
};

interface Tenant {
  tenantId: string;
}

const tenantService: ServiceDefinition<Tenant> = {
  name: 'tenant',
  type: 'per-request',
  factory: (_container, _settings, req) => ({
    tenantId: String(req.headers['x-tenant-id'] ?? 'public'),
  }),
};

class ReportController extends BaseController {
  routes(): RouteDefinition[] {
    return [this.route().get('/').handle(this.list)];
  }

  private async list(req: Request, res: Response): Promise<void> {
    const db = await req.services.get<Database>('database');
    const tenant = await req.services.get<Tenant>('tenant');
    const reports = await db.findReports();
    this.ok(res, { tenant: tenant.tenantId, reports });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerService(databaseService);
app.registerService(tenantService);
app.registerController('/api/reports', ReportController);

const shutdown = await app.start();
// await shutdown() disposes the singleton database via its dispose() hook.
```

Service names should be declared as const objects. The legacy `preparseServiceNames()` helper (which rewrote class statics) is deprecated and logs a warning:

```typescript fragment
export const ServiceNames = {
  DATABASE: 'database',
  TENANT: 'tenant',
} as const;
```

### Key Methods and Properties

| Name | Signature | Description |
|------|-----------|-------------|
| `get` | `get<T = unknown>(name: string, defaultValue?: T): Promise<T>` | Resolves a definition or cached instance; resolves `dependencies` first; detects circular dependencies; throws for unknown names without a default and for per-request services outside a request |
| `set` | `set(name: string, service: unknown): void` | Places an instance into this container, overriding resolved values |
| `getUser` | `getUser<T = unknown>(): T \| undefined` | Returns the `'user'` service — the authenticated principal |
| `getParams` | `getParams<T = unknown>(): T` | Merged, validated `params` + `query` + `body` for the current route |
| `getInput` | `getInput<T>(): T` | Separated `{ params, query, body }` sources without merging |
| `registerService` | `registerService(service: ServiceDefinition): void` | Registers a definition; duplicate names throw |
| `isRegistered` | `isRegistered(name: string): boolean` | `true` when a definition exists in the registry |
| `getRegisteredServices` | `getRegisteredServices(): string[]` | Returns all registered service names |
| `disposeAll` | `disposeAll(): Promise<void>` | Calls each live singleton's `dispose()` and clears the singleton cache; rejects if a disposer throws |

Service definition fields:

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Unique registration key |
| `type` | `'singleton' \| 'per-request'` | Lifecycle of the created instance |
| `factory` | `SingletonFactory<T> \| PerRequestFactory<T>` | `(container, settings)` for singletons; additionally `(req, res, next)` for per-request services |
| `dependencies` | `string[]` (optional) | Service names resolved before the factory runs |
| `dispose` | `(instance: T) => void \| Promise<void>` (optional) | Shutdown hook, invoked for singletons by `disposeAll()` |

---

## Plugin System

### What It Is

Plugins are the extension mechanism of `WebApplication`. A `PluginDefinition` pairs a unique name and a factory with a `priority`, and its factory can add Express middleware, register services, and return a `Plugin` object with optional `health()`, `shutdown()`, and `terminal()` hooks. Everything from auth to metrics to static hosting is packaged this way.

### How It Works

- Plugins install in ascending priority order (default `100`, stable for equal priorities). Duplicate names throw immediately at `app.use()`.
- The factory receives `{ app, express, logger }` — a scoped `ConsoleLogger` prefixed `Plugin:<name>`. Returning `void` is allowed for plugins that only add middleware.
- Health: each plugin's `health()` is aggregated by `GET /health`, which answers `200 { health: true, timestamp }` when all plugins are healthy and `503` otherwise. A plugin without health checks counts as healthy.
- Shutdown: `shutdown()` hooks run during graceful shutdown in installation order, after singleton services are disposed.
- The optional `terminal` hook is a distinct phase. The factory's middleware runs *before* controllers and can swallow controller routes; terminal middleware runs *after* controllers and `/health*, but *before* the 404 handler — the correct place for catch-all fallbacks (for example an SPA `index.html`). Multiple terminal hooks run in plugin priority order.

```typescript fragment
const legacyRedirectPlugin: PluginDefinition = {
  name: 'legacy-redirect',
  factory: async () => ({
    terminal: async ({ express }) => {
      express.use((req, res, next) => {
        if (req.path.startsWith('/legacy/')) {
          res.redirect(308, req.path.replace('/legacy', '/api'));
          return;
        }
        next();
      });
    },
  }),
};
```

### Complete Example

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { Plugin, PluginDefinition } from 'blendsdk/webafx';

const requestCounterPlugin: PluginDefinition = {
  name: 'request-counter',
  priority: 50,
  factory: async ({ express, logger }) => {
    let requests = 0;
    let accepting = true;

    express.use((_req, _res, next) => {
      requests += 1;
      next();
    });

    await logger.info('Request counter installed');

    const plugin: Plugin = {
      health: async () => accepting,
      shutdown: async () => {
        accepting = false;
        await logger.info(`Request counter stopped after ${requests} requests`);
      },
    };

    return plugin;
  },
};

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });
app.use(requestCounterPlugin);

const shutdown = await app.start();
// GET /health → 200 { "health": true, "timestamp": ... } while the plugin is healthy
// await shutdown() → the plugin's shutdown hook runs after services are disposed
```

### Key Properties and Hooks

`PluginDefinition` (registration):

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Unique name; a duplicate throws at `app.use()` |
| `priority` | `number` (optional) | Default `100`; lower numbers install first |
| `factory` | `(params: { app: WebApplication; express: Express; logger: Logger }) => Promise<Plugin \| void>` | Installs middleware, registers services, and returns optional hooks |

`Plugin` (returned by the factory):

| Field | Type | Description |
|-------|------|-------------|
| `health` | `() => Promise<boolean>` (optional) | Aggregated by `GET /health` — `200` when all healthy, `503` otherwise |
| `shutdown` | `() => Promise<void>` (optional) | Runs during graceful shutdown, in installation order |
| `terminal` | `(params: PluginTerminalParams) => void \| Promise<void>` (optional) | Mounts catch-all middleware after controllers and `/health`, before the 404 handler |

---

## Request Context and Request IDs

### What It Is

WebAFX assigns every request a correlation ID and propagates it — together with a start timestamp — through `AsyncLocalStorage`. Any function in the async call chain can read the context with `getRequestContext()` or `getRequestId()` without threading parameters through every call. This is the backbone of request tracing and structured logging.

### How It Works

- The built-in request ID middleware runs early in the core middleware stack, before plugins and controllers.
- An incoming `X-Request-ID` header is reused only when it is a valid UUID; malformed or malicious values are replaced with a fresh `randomUUID()` to prevent log corruption.
- The ID is attached to `req.id`, echoed back in the `X-Request-ID` response header, and stored as `{ requestId, startTime }` in `AsyncLocalStorage` for the remainder of the request.
- Each request runs in its own storage scope, so concurrent requests never see each other's context. The context object carries an index signature, so additional request-scoped values can be added dynamically.
- Because the middleware calls `next()` inside `requestContextStorage.run()`, helpers like `getRequestId()` work inside middleware, controllers, services, and any async operation they await.

### Complete Example

```typescript
import { BaseController, WebApplication, getRequestContext, getRequestId } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

/** Stand-in for a repository call that needs correlation. */
async function saveOrder(orderId: string): Promise<void> {
  const requestId = getRequestId() ?? 'outside-request';
  const context = getRequestContext();
  const elapsed = context ? Date.now() - context.startTime : 0;
  console.log(`[${requestId}] saving ${orderId} (${elapsed}ms into request)`);
}

class OrderController extends BaseController {
  routes(): RouteDefinition[] {
    return [this.route().post('/').handle(this.create)];
  }

  private async create(_req: Request, res: Response): Promise<void> {
    await saveOrder('ord_1001');
    this.created(res, { id: 'ord_1001' });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api/orders', OrderController);

const shutdown = await app.start();
// The response carries X-Request-ID; every log line inside the request can read it.
```

### Key Methods and Properties

| Name | Signature | Description |
|------|-----------|-------------|
| `getRequestContext` | `getRequestContext(): RequestContext \| undefined` | Returns the full context (`requestId`, `startTime`, custom keys), or `undefined` outside a request |
| `getRequestId` | `getRequestId(): string \| undefined` | Shorthand for `getRequestContext()?.requestId` |
| `requestContextStorage` | `AsyncLocalStorage<RequestContext>` | The underlying storage; `requestContextStorage.run(ctx, fn)` lets background code adopt a captured context |
| `req.id` | `string \| undefined` | The request ID attached to the Express request (augmented by WebAFX) |
| `RequestContext.requestId` | `string` | Unique identifier for tracing |
| `RequestContext.startTime` | `number` | Request start time in milliseconds since epoch |

---

## Error Handling

### What It Is

WebAFX standardizes error reporting around a small class hierarchy: `ApiError` carries an HTTP status, a machine-readable code, a message, and optional structured details; nine ready-made subclasses cover the common HTTP statuses. Every failure — thrown errors, validation failures, unmatched routes — is serialized by the built-in error handler into the same `StandardErrorResponse` envelope.

### How It Works

- Handlers (and route middleware) may throw. The route wrapper catches everything and forwards it to the error handler via `next(error)`.
- An `ApiError` instance produces its own `statusCode` and `code`. Any other `Error` becomes `500 INTERNAL_SERVER_ERROR`; its message and stack are only exposed outside production — in production the client sees the generic `'Internal Server Error'`.
- Every error response includes `timestamp`, `requestId` (from the request context), and `path`, plus `details` when present. Zod failures raised by `.validate()` arrive as `422 VALIDATION_ERROR` with a per-issue `details` array of `{ path, message, code }`.
- Unmatched routes are converted into `NotFoundError` by the 404 handler, so clients always receive the same envelope.
- Error logging is resilient: if the configured logger itself throws while logging an error, the response is still sent.

```typescript fragment
interface StandardErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    statusCode: number;
    details?: unknown;
    timestamp: string;
    requestId?: string;
    path?: string;
    stack?: string;
  };
}
```

### Complete Example

```typescript
import { ApiError, BaseController, WebApplication } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class PaymentRequiredError extends ApiError {
  constructor(message = 'Payment required for this resource') {
    super(402, 'PAYMENT_REQUIRED', message, {
      upgradeUrl: 'https://example.com/upgrade',
    });
  }
}

class BillingController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route().post('/charge').handle(this.charge),
      this.route().get('/invoices/:id').handle(this.getInvoice),
    ];
  }

  private async charge(_req: Request, _res: Response): Promise<void> {
    throw new PaymentRequiredError();
  }

  private async getInvoice(req: Request, res: Response): Promise<void> {
    if (req.params.id === 'missing') {
      throw new ApiError(404, 'NOT_FOUND', `Invoice ${req.params.id} not found`);
    }
    this.ok(res, { id: req.params.id, status: 'paid' });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });
app.registerController('/api/billing', BillingController);

const shutdown = await app.start();
// POST /api/billing/charge
// → 402 { "success": false, "error": { "code": "PAYMENT_REQUIRED",
//     "message": "Payment required for this resource", "statusCode": 402,
//     "details": { "upgradeUrl": "..." }, "timestamp": "...",
//     "requestId": "...", "path": "/api/billing/charge" } }
// GET /api/billing/invoices/missing → 404 { "success": false, "error": { "code": "NOT_FOUND", ... } }
```

### Key Methods and Properties

`ApiError`:

| Name | Signature | Description |
|------|-----------|-------------|
| `constructor` | `constructor(statusCode: number, code: string, message: string, details?: unknown)` | Creates an operational error with an HTTP status and stable code |
| `statusCode` | `number` | HTTP status used in the response |
| `code` | `string` | Machine-readable error code |
| `details` | `unknown` (optional) | Structured payload added to the envelope |
| `toJSON` | `toJSON(): StandardErrorResponse` | Converts the error into the standard envelope with a fresh timestamp |

Built-in subclasses:

| Class | Status | Code |
|-------|--------|------|
| `BadRequestError` | 400 | `BAD_REQUEST` |
| `UnauthorizedError` | 401 | `UNAUTHORIZED` |
| `ForbiddenError` | 403 | `FORBIDDEN` |
| `NotFoundError` | 404 | `NOT_FOUND` |
| `ConflictError` | 409 | `CONFLICT` |
| `ValidationError` | 422 | `VALIDATION_ERROR` |
| `RateLimitError` | 429 | `RATE_LIMIT_EXCEEDED` |
| `InternalServerError` | 500 | `INTERNAL_SERVER_ERROR` |
| `ServiceUnavailableError` | 503 | `SERVICE_UNAVAILABLE` |

---

## Logging

### What It Is

Logging is defined by the async `Logger` interface (`info`, `warn`, `error`, `debug`). WebAFX ships two implementations: `ConsoleLogger` for human-readable development output, and `StructuredLogger` for one-JSON-object-per-line output suitable for log aggregation systems. `WebApplication` uses a `ConsoleLogger` by default, and `app.setLogger()` lets a plugin replace it.

### How It Works

- Levels are ranked `ERROR` (1) < `WARN` (2) < `INFO` (3) < `DEBUG` (4). The configured level is a threshold: messages at or below it are emitted. `ERROR` therefore logs only errors, while `DEBUG` logs everything.
- The level resolves in order: constructor argument → `process.env.LOG_LEVEL` (case-insensitive, unknown values fall back to `ERROR`) → `ERROR`. `DEBUG` messages are also emitted whenever `process.env.DEBUG === 'true'`.
- `ConsoleLogger` formats lines as `[LEVEL:PREFIX]: message - {json data}`; `ERROR` goes to `console.error`, the rest to `console.log`.
- `StructuredLogger` writes `LogEntry` objects (`timestamp`, `level`, `message`, optional `prefix`, and any `data`/context properties). Its optional `contextFn` runs for every entry — pair it with `getRequestId()` to stamp every log line with the current request.
- `WebApplication` creates its logger as `ConsoleLogger('APP', LOG_LEVEL)` and plugins receive a scoped logger named `Plugin:<plugin name>`. `setLogger()` affects subsequent calls only.

### Complete Example

```typescript
import { StructuredLogger, WebApplication, getRequestId } from 'blendsdk/webafx';

const logger = new StructuredLogger('API', 'INFO', () => ({
  requestId: getRequestId(),
}));

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production', LOG_LEVEL: 'INFO' });
app.setLogger(logger);

const shutdown = await app.start();

await logger.info('Order created', { orderId: 'ord_123' });
// {"timestamp":"2026-01-15T10:00:00.000Z","level":"INFO","message":"Order created",
//  "prefix":"API","data":{"orderId":"ord_123"}}
// Inside a request, the same call also carries the request ID from AsyncLocalStorage.
```

For local development, the console variant is easier to read:

```typescript fragment
const devLogger = new ConsoleLogger('APP', 'DEBUG');
await devLogger.debug('Query finished', { rows: 42 });
// [DEBUG:APP]: Query finished - {"rows":42}
```

### Key Methods and Properties

| Name | Signature | Description |
|------|-----------|-------------|
| `Logger` | `interface Logger` | `info`, `warn`, `error`, `debug` — all `(message: string, data?: Record<string, unknown>) => Promise<void>` |
| `LogLevel` | `'ERROR' \| 'WARN' \| 'INFO' \| 'DEBUG'` | Severity ranking used for threshold filtering |
| `ConsoleLogger` | `constructor(prefix?: string, logLevel?: LogLevel)` | Human-readable output; `[LEVEL:PREFIX]: message - {...}` |
| `StructuredLogger` | `constructor(prefix?: string, logLevel?: LogLevel, contextFn?: () => Record<string, unknown>)` | One JSON object per line; `ERROR` to stderr, others to stdout |
| `LogEntry` | `{ timestamp, level, message, prefix?, requestId?, data?, ... }` | The JSON shape produced by `StructuredLogger` |

---

## CSRF Protection

### What It Is

`csrfMiddleware()` and `csrfPlugin()` protect cookie-authenticated applications from cross-site request forgery. Browsers attach cookies to requests from any site, so a mutating endpoint that trusts a session cookie can be triggered cross-site; a CSRF token that a foreign site cannot read or set closes that gap. Tokens are compared in constant time.

### How It Works

- Safe methods (default `['GET', 'HEAD', 'OPTIONS']`) and exactly matching `exempt` entries (`` `${METHOD} ${path}` ``) pass through without a check.
- Two comparison modes:
  - **Session-bound (recommended):** `expectedToken(req)` derives the expected value from the authenticated session — for example a token stored server-side and exposed to the client through an authenticated endpoint. The resolver may be async.
  - **Double-submit cookie:** `cookie: { name }` compares the `x-csrf-token` header against the named cookie. This is unsigned and therefore defence in depth, not a substitute for session binding.
- The header name is matched case-insensitively, because Express lower-cases incoming header names.
- Failures answer `403` with `{ success: false, error: { code: 'csrf_invalid', message: 'Invalid or missing CSRF token' } }`, and the handler is never called.
- The middleware fails closed: with neither `expectedToken` nor `cookie`, every mutating request is rejected because there is nothing to compare against. `constantTimeTokenMatch()` uses `timingSafeEqual`, fails fast on length mismatch, and always rejects a missing or empty expected token.
- `csrfPlugin()` mounts the middleware application-wide through the plugin system (priority `50`, before default-priority plugins). Use `csrfMiddleware()` directly as route middleware when only selected routes need protection. Cookie parsing is available automatically because the core middleware stack installs `cookie-parser`.

### Complete Example

```typescript
import { BaseController, WebApplication, csrfPlugin } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class ProfileController extends BaseController {
  routes(): RouteDefinition[] {
    return [this.route().post('/profile').handle(this.update)];
  }

  private async update(req: Request, res: Response): Promise<void> {
    const body = req.body as { displayName: string };
    this.ok(res, { displayName: body.displayName });
  }
}

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'production',
  CORS: { origin: 'https://app.example.com', credentials: true },
});

app.use(csrfPlugin({ cookie: { name: 'csrf' } }));
app.registerController('/api', ProfileController);

const shutdown = await app.start();
// The browser sends the CSRF token in both the `csrf` cookie and the `x-csrf-token` header.
// A mutating request without the matching header → 403 { "success": false, "error": { "code": "csrf_invalid" } }
```

The stronger, session-bound mode derives the expected token from the authenticated principal:

```typescript fragment
app.use(
  csrfPlugin({
    expectedToken: async (req) => {
      const user = await req.services.get<{ csrfToken?: string } | undefined>('user', undefined);
      return user?.csrfToken;
    },
  })
);
```

### Key Functions and Options

| Name | Signature | Description |
|------|-----------|-------------|
| `csrfMiddleware` | `csrfMiddleware(options?: CsrfOptions): RequestHandler` | Guards mutating requests; safe methods and exemptions pass; failures → `403 csrf_invalid` |
| `csrfPlugin` | `csrfPlugin(options?: CsrfOptions): PluginDefinition` | Installs the middleware application-wide (plugin priority `50`) |
| `constantTimeTokenMatch` | `constantTimeTokenMatch(provided: string \| undefined, expected: string \| undefined): boolean` | Constant-time comparison; `false` for missing, empty, or length-mismatched tokens |

`CsrfOptions`:

| Option | Type | Description |
|--------|------|-------------|
| `header` | `string` | Header carrying the client token; default `'x-csrf-token'` |
| `safeMethods` | `string[]` | Methods exempt from the check; default `['GET', 'HEAD', 'OPTIONS']` |
| `exempt` | `string[]` | Exact `` `${METHOD} ${path}` `` requests exempt, e.g. `'POST /webhooks'` |
| `expectedToken` | `(req: Request) => string \| undefined \| Promise<string \| undefined>` | Session-bound mode: derive the expected token from the authenticated session |
| `cookie` | `{ name: string }` | Unsigned double-submit mode: compare the header against the named cookie |

---

## Rate Limiting

### What It Is

`rateLimitMiddleware()` is an in-memory request throttle. It counts requests per key (the client IP by default) inside a rolling window and rejects excess traffic with `429 RATE_LIMIT_EXCEEDED`, while reporting the current quota through standard `X-RateLimit-*` headers.

### How It Works

- Requests are counted per key within a fixed window. The first request (or the first after a window expires) opens a new window; each subsequent request increments the counter.
- Every response receives `X-RateLimit-Limit`, `X-RateLimit-Remaining` (never below zero), and `X-RateLimit-Reset` (window end as a Unix timestamp in seconds).
- Exceeding `maxRequests` throws `RateLimitError(message)`, which the error handler renders as the standard `429` envelope with the quota headers set to their final values.
- Storage is a `Map` in the current process with a periodic cleanup interval (unref'd so it never keeps the process alive). This is suitable for single-instance deployments; for multi-instance deployments, use a Redis-backed implementation via a plugin.
- Attach the middleware globally (`app.express.use(...)`) or per route with `.middleware(...)`; a custom `keyExtractor` can key by API token, user ID, or any other request attribute.

### Complete Example

```typescript
import { BaseController, WebApplication, rateLimitMiddleware } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class SearchController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/search')
        .middleware(rateLimitMiddleware({ maxRequests: 10, windowMs: 60_000 }))
        .handle(this.search),
    ];
  }

  private async search(req: Request, res: Response): Promise<void> {
    this.ok(res, { results: [], query: String(req.query.q ?? '') });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });
app.registerController('/api', SearchController);

const shutdown = await app.start();
// First 10 requests per IP per minute → 200 with X-RateLimit-Limit: 10, X-RateLimit-Remaining: N
// Next request → 429 { "success": false, "error": { "code": "RATE_LIMIT_EXCEEDED", ... } }
```

### Key Functions and Options

| Name | Signature | Description |
|------|-----------|-------------|
| `rateLimitMiddleware` | `rateLimitMiddleware(options?: RateLimitOptions): RequestHandler` | Returns a middleware that throttles requests per key and emits `X-RateLimit-*` headers |

`RateLimitOptions`:

| Option | Type | Description |
|--------|------|-------------|
| `maxRequests` | `number` | Maximum requests per window; default `100` |
| `windowMs` | `number` | Window duration in milliseconds; default `60000` |
| `keyExtractor` | `(req: Request) => string` | Derives the bucket key; defaults to the request IP (`'unknown'` fallback) |
| `message` | `string` | Message used in the `RateLimitError`; default `'Rate limit exceeded'` |

---

## Static Files and SPA Hosting

### What It Is

`staticFilesPlugin()` wraps Express's built-in `express.static` with a typed configuration surface (`root`, `prefix`, `maxAge`, `immutable`, `dotfiles`, `spa`, ...) and optional SPA fallback. With `spa: true`, unmatched client-side routes are served `index.html` for frameworks like React, Vue, or Angular — without swallowing API routes or `/health`.

### How It Works

- The plugin validates `root` (resolved against `process.cwd()`) at install time and throws `Static files root directory does not exist: <path>` when the directory is missing — fail fast instead of silently serving nothing.
- Real files are served by `express.static` mounted in the plugin factory phase, i.e. before controllers; serving an existing file early never shadows a route.
- With `spa: true`, the SPA fallback is registered as a **terminal hook**: it mounts after controllers and `/health` but before the 404 handler, so controller routes always win.
- The fallback applies three guards before serving `index.html`:
  1. **Method guard** — only `GET` requests are handled; API mutations pass through
  2. **File extension guard** — paths whose last segment has an extension (e.g. `/styles.css`) are missing files, not client routes, and fall through to `404`
  3. **Accept guard** — only requests accepting `text/html` are served the page; JSON clients get a proper 404
- The plugin name defaults to `static-files` and becomes `static-files:<prefix>` for non-root prefixes, so multiple instances are distinguishable in logs and duplicates with the same prefix are rejected.

### Complete Example

```typescript
import { WebApplication, staticFilesPlugin } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production', LOG_LEVEL: 'ERROR' });

app.use(
  staticFilesPlugin({
    root: './dist/client',
    maxAge: '1y',
    immutable: true,
    spa: true,
  })
);

const shutdown = await app.start();
// GET /assets/main.abc123.js → served by express.static, cached for 1 year (immutable)
// GET /settings/profile       → no file, HTML navigation → index.html (SPA fallback, terminal phase)
// GET /styles.css             → missing file (has extension) → 404
// GET /api/missing with Accept: application/json → 404 (Accept guard), never index.html
```

### Key Configuration Options

| Field | Type | Description |
|-------|------|-------------|
| `root` | `string` | Required. Directory to serve, resolved from `process.cwd()`; must exist at install time |
| `prefix` | `string` | URL prefix to mount at; default `'/'` |
| `maxAge` | `string \| number` | `Cache-Control` max-age (milliseconds or `'1d'`, `'1h'`, `'30m'`); default `0` |
| `immutable` | `boolean` | Adds the `immutable` directive (use with hashed filenames); default `false` |
| `dotfiles` | `'ignore' \| 'allow' \| 'deny'` | Dotfile handling; default `'ignore'` (404) |
| `index` | `string \| false` | Directory index file; default `'index.html'`, `false` disables indexing |
| `etag` | `boolean` | Enable ETag generation; default `true` (Express default) |
| `lastModified` | `boolean` | Enable `Last-Modified` header; default `true` (Express default) |
| `spa` | `boolean` | Serve `index.html` for unmatched HTML navigation via the terminal phase; default `false` |
| `priority` | `number` | Plugin priority; default `20` |

---

# webafx Basic Usage

This guide takes you from an empty project to a running WebAFX application. You will install the package, boot your first server, and then walk through the core building blocks — controllers, request input, validation, services, authentication, middleware, and plugins — before covering configuration and error handling. Every example is complete, ESM, strict-mode TypeScript.

---

## Installation

WebAFX ships inside the `blendsdk` umbrella package and requires Express and Zod as peer dependencies:

```bash
# npm
npm install blendsdk express zod

# yarn
yarn add blendsdk express zod

# pnpm
pnpm add blendsdk express zod
```

Requirements:

- **Node.js >= 22.0.0**
- **ESM project** — the package is ESM-only (`"type": "module"`)
- **TypeScript** with a `moduleResolution` that understands package `exports` (`node16`, `nodenext`, or `bundler`)
- Peer versions: `express` `^5.0.0` and `zod` `^4.4.3`

All code imports from the `blendsdk/webafx` subpath:

```typescript
import { WebApplication } from 'blendsdk/webafx';
```

There is nothing else to install — `blendsdk/webafx` is an import path provided by the installed `blendsdk` package, not a package of its own.

---

## Quick Start

Create a minimal API with one controller, register it, and start the server:

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class HelloController extends BaseController {
  routes() {
    return [this.route().get('/').handle(this.hello)];
  }

  private async hello(_req: Request, res: Response): Promise<void> {
    this.ok(res, { message: 'Hello, World!' });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api/hello', HelloController);

await app.start();
```

1. Save the file as `src/server.ts`.
2. Compile it with your TypeScript setup (`tsc`) and run the emitted JavaScript with Node.js.
3. Call the endpoint:

```bash
curl http://localhost:3000/api/hello
```

```json
{
  "success": true,
  "data": {
    "message": "Hello, World!"
  }
}
```

The framework also exposes `GET /health` → `{ "health": true, "timestamp": ... }`. Stopping the process with Ctrl+C (SIGINT) or your platform's SIGTERM triggers a graceful shutdown automatically.

---

## Fundamentals

The subsections below build on each other. Each one introduces a single new concept.

### Creating and Starting the Application

`WebApplication` is the entry point. The constructor validates its configuration immediately (via Zod), and `start()` performs the complete server setup: loading config files, running `beforeStart` hooks, installing core middleware (trust proxy, CORS, cookie parsing, body parsing, request IDs, timing, security headers), attaching a per-request service container, installing plugins, registering controller routes and `GET /health`, wiring 404 and error handling, and finally listening on `PORT`.

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'development',
  LOG_LEVEL: 'INFO',
});

app.on('beforeStart', () => {
  console.log('Wiring up the application...');
});

app.on('afterStart', () => {
  console.log('Server is accepting requests on http://localhost:3000');
});

const shutdown = await app.start();

// SIGTERM (deploys) and SIGINT (Ctrl+C) trigger shutdown automatically.
// Call the returned function to stop the server yourself:
await shutdown();
```

Lifecycle hooks let you run code at defined points:

| Hook | Runs |
|------|------|
| `beforeStart` | After config files load, before middleware/plugins/controllers are set up |
| `afterStart` | After the server is listening |
| `beforeShutdown` | When shutdown begins, before services and plugins are torn down |
| `afterShutdown` | After services and plugins have been disposed |

Multiple hooks for the same event run in registration order and are awaited, so async hooks are supported.

Notes:

- `start()` can be called once per application. A second call throws `Application already started`.
- The returned `shutdown()` function is idempotent — calling it twice is safe.
- `app.express` exposes the underlying Express application for anything WebAFX does not wrap directly. Add custom middleware there before `start()`.

### Controllers and Routes

A controller extends `BaseController`, implements `routes()`, and returns an array of route definitions built with the fluent `RouteBuilder`. Register the class with a base path and every route is mounted under it.

```typescript
import { BaseController, WebApplication } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface Greeting {
  id: number;
  name: string;
}

const greetings: Greeting[] = [
  { id: 1, name: 'Ada' },
  { id: 2, name: 'Grace' },
];

class GreetingController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route().get('/').handle(this.list),
      this.route().get('/:name').handle(this.greet),
    ];
  }

  private async list(_req: Request, res: Response): Promise<void> {
    this.ok(res, greetings);
  }

  private async greet(req: Request, res: Response): Promise<void> {
    this.ok(res, { greeting: `Hello, ${req.params.name}!` });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api/greetings', GreetingController);

await app.start();
```

- `GET /api/greetings` returns the list; `GET /api/greetings/Ada` returns the greeting.
- Every chain starts with `this.route()`, picks an HTTP method (`get`, `post`, `put`, `patch`, `delete`), and ends with `.handle(handler)`.
- Handlers have the standard Express signature `(req, res, next)` and can be declared as private methods or inline functions.
- `handle()` must be the last call in the chain and validates that a method, a path, and a function handler were provided — see [Error Handling](#error-handling).

### Response Helpers

`BaseController` provides four response helpers so that every endpoint returns the same envelope. Clients can rely on the `success` flag on every response.

| Helper | Status | Body |
|--------|--------|------|
| `ok(res, data)` | 200 | `{ success: true, data }` |
| `created(res, data)` | 201 | `{ success: true, data }` |
| `paginated(res, items, total, page, limit)` | 200 | `{ success: true, data, pagination }` |
| `noContent(res)` | 204 | *(empty)* |

```typescript
import { BaseController, WebApplication } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface Item {
  id: number;
  name: string;
}

const items: Item[] = [
  { id: 1, name: 'Keyboard' },
  { id: 2, name: 'Mouse' },
  { id: 3, name: 'Monitor' },
];

class ItemController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route().get('/').handle(this.list),
      this.route().post('/').handle(this.create),
      this.route().delete('/:id').handle(this.remove),
    ];
  }

  private async list(_req: Request, res: Response): Promise<void> {
    // 57 items exist in total; this response carries page 1 with 20 per page.
    this.paginated(res, items, 57, 1, 20);
  }

  private async create(_req: Request, res: Response): Promise<void> {
    this.created(res, { id: 4, name: 'Webcam' } satisfies Item);
  }

  private async remove(_req: Request, res: Response): Promise<void> {
    this.noContent(res);
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api/items', ItemController);

await app.start();
```

`GET /api/items` responds with pagination metadata:

```json
{
  "success": true,
  "data": [
    { "id": 1, "name": "Keyboard" },
    { "id": 2, "name": "Mouse" },
    { "id": 3, "name": "Monitor" }
  ],
  "pagination": {
    "total": 57,
    "page": 1,
    "limit": 20,
    "pages": 3
  }
}
```

### Reading Request Input

Express populates `req.params`, `req.query`, and `req.body` before your handler runs. For the simplest case you can read them directly:

```typescript fragment
// Simplest form — read the Express request directly:
const id = req.params.id;          // path parameter, always a string
const rawSearch = req.query.search; // query values arrive as strings
```

Because `req.query` and `req.body` are not typed, WebAFX stores the input in the request service container so you can describe the shape you expect. `getInput<T>()` returns the **separated** sources — useful when `params`, `query`, and `body` could collide on the same key. `getParams<T>()` returns a **merged** view (`params`, then `query`, then `body` — later sources win), and is replaced by the validated data when the route uses `.validate()`.

| Accessor | Contents |
|----------|----------|
| `req.params` | Route parameters (`/:id`) |
| `req.query` | Query string values (strings) |
| `req.body` | Parsed JSON / URL-encoded body (untyped) |
| `req.services.getParams<T>()` | Merged `params` + `query` + `body` |
| `req.services.getInput<T>()` | Separated `{ params, query, body }` |

```typescript
import { BaseController, WebApplication } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface ReviewInput {
  params: { id: string };
  query: { sort?: string };
  body: Record<string, never>;
}

interface AddReviewInput {
  params: { id: string };
  query: Record<string, never>;
  body: { rating: number; comment: string };
}

class ProductController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route().get('/:id/reviews').handle(this.listReviews),
      this.route().post('/:id/reviews').handle(this.addReview),
    ];
  }

  private async listReviews(req: Request, res: Response): Promise<void> {
    const { params, query } = req.services.getInput<ReviewInput>();

    this.ok(res, {
      productId: params.id,
      sort: query.sort ?? 'newest',
      reviews: [],
    });
  }

  private async addReview(req: Request, res: Response): Promise<void> {
    const { params, body } = req.services.getInput<AddReviewInput>();

    this.created(res, { productId: params.id, ...body });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api/products', ProductController);

await app.start();
```

The next level of safety is validating the input instead of trusting the declared types — that is the next section.

### Validating Requests with Zod

Add `.validate(schema)` to a route to validate the request with a Zod schema before the handler runs. `params`, `query`, and `body` are **merged into one object** for validation, so a single schema can describe a path parameter and body fields together. On success, the parsed (and typed) result is what `getParams<T>()` returns; on failure the framework responds with `422 VALIDATION_ERROR` and field-level details.

```typescript
import { BaseController, WebApplication } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';
import { z } from 'zod';

// Params, query, and body are merged before validation — one schema for all.
const updateProfileSchema = z.object({
  id: z.coerce.number().int().positive(), // from /users/:id (string → number)
  displayName: z.string().min(1, 'Display name is required').max(80), // JSON body
  tags: z.array(z.string()).max(5).optional(), // JSON body
});

type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

class UserController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .put('/:id')
        .validate(updateProfileSchema)
        .handle(this.updateProfile),
    ];
  }

  private async updateProfile(req: Request, res: Response): Promise<void> {
    const input = req.services.getParams<UpdateProfileInput>();

    this.ok(res, {
      id: input.id,
      displayName: input.displayName,
      tags: input.tags ?? [],
    });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api/users', UserController);

await app.start();
```

Key points:

- **Use `z.coerce` for path parameters and query values** — they arrive as strings. The `id` above is coerced from `"42"` to `42`.
- **Unknown keys are stripped.** Any body/query keys not declared in the schema are removed before the handler sees the data.
- **Raw input remains available.** `getInput()` still returns the unparsed, separated sources.
- **Failures are automatic.** A request with an empty `displayName` returns:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "statusCode": 422,
    "details": [
      {
        "path": "displayName",
        "message": "Display name is required",
        "code": "too_small"
      }
    ],
    "timestamp": "2026-02-08T18:30:00.000Z",
    "requestId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "path": "/api/users/42"
  }
}
```

### Services and Dependency Injection

Register services with `app.registerService()` and resolve them per request through `req.services`. There are two lifecycles:

| `type` | Created | Shared with |
|--------|---------|-------------|
| `'singleton'` | On first `get`, once per application | Every request (and supports `dispose()` on shutdown) |
| `'per-request'` | On first `get` within a request | That request only; the factory receives `req`, `res`, `next` |

```typescript
import { BaseController, WebApplication } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface User {
  id: number;
  name: string;
}

class UserController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route().get('/').handle(this.list),
      this.route().get('/whoami').handle(this.whoami),
    ];
  }

  private async list(req: Request, res: Response): Promise<void> {
    const users = await req.services.get<{ list: () => User[] }>('users');
    this.ok(res, users.list());
  }

  private async whoami(req: Request, res: Response): Promise<void> {
    const tenant = await req.services.get<{ id: string }>('tenant');
    this.ok(res, { tenant: tenant.id });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

// Singleton — created once and shared by every request.
// (A real application would hold a database pool or cache client here.)
app.registerService({
  name: 'users',
  type: 'singleton',
  factory: () => {
    const users: User[] = [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ];
    return { list: (): User[] => users };
  },
});

// Per-request — created for each HTTP request with the Express context.
app.registerService({
  name: 'tenant',
  type: 'per-request',
  factory: (_container, _settings, req) => {
    const header = req.headers['x-tenant'];
    return { id: typeof header === 'string' ? header : 'public' };
  },
});

app.registerController('/api/users', UserController);

await app.start();
```

Resolution is lazy — a service is created the first time it is requested. Services can declare `dependencies: ['other-service']`, which are resolved before the factory runs; circular dependencies throw `Circular dependency detected: ...`. Singletons can clean themselves up on shutdown:

```typescript fragment
app.registerService({
  name: 'cache',
  type: 'singleton',
  factory: () => new Map<string, string>(),
  dispose: (cache: Map<string, string>) => cache.clear(),
});
```

Prefer a shared `const` object for service names instead of scattering string literals:

```typescript fragment
export const ServiceNames = {
  USERS: 'users',
  TENANT: 'tenant',
} as const;
```

The legacy `preparseServiceNames()` helper for static class properties is deprecated and scheduled for removal — use the `const` pattern above.

### Authentication and Authorization

Routes opt in to authentication with `.secure()` (or its shorthand `.authenticated()`). The framework resolves the authenticated principal from a service named `user`, and rejects the request with `401 UNAUTHORIZED` when no principal is present — before the handler runs. `.authorize(fn)` adds a check that runs with the same principal; returning `false` produces `403 FORBIDDEN`.

Authentication plugins register the `user` service for you. Without one, your application provides it:

```typescript
import { BaseController, WebApplication } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface UserPrincipal {
  id: number;
  role: 'user' | 'admin';
}

interface ClientPrincipal {
  id: number;
  name: string;
}

class ReportController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      // Public — anyone can call this.
      this.route().get('/status').handle(this.status),

      // Requires an authenticated 'user' principal → 401 otherwise.
      this.authenticated().get('/me').handle(this.me),

      // Requires the principal AND a passing authorization check → 403 otherwise.
      this.route()
        .get('/admin/summary')
        .secure()
        .authorize((_req, user: UserPrincipal) => user.role === 'admin')
        .handle(this.adminSummary),

      // Machine clients authenticate against a different principal service.
      this.authenticated('client').get('/export').handle(this.exportData),
    ];
  }

  private async status(_req: Request, res: Response): Promise<void> {
    this.ok(res, { status: 'ok' });
  }

  private async me(req: Request, res: Response): Promise<void> {
    const user = await req.services.get<UserPrincipal>('user');
    this.ok(res, { id: user.id, role: user.role });
  }

  private async adminSummary(_req: Request, res: Response): Promise<void> {
    this.ok(res, { summary: { openTickets: 3 } });
  }

  private async exportData(req: Request, res: Response): Promise<void> {
    const client = await req.services.get<ClientPrincipal>('client');
    this.ok(res, { exportedBy: client.name });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

// The default principal service. An auth plugin would register this instead.
app.registerService({
  name: 'user',
  type: 'per-request',
  factory: (_container, _settings, req): UserPrincipal | undefined => {
    const header = req.headers['x-user'];
    if (header === 'admin') return { id: 1, role: 'admin' };
    if (header === 'ada') return { id: 2, role: 'user' };
    return undefined;
  },
});

// A second principal service for non-browser clients.
app.registerService({
  name: 'client',
  type: 'per-request',
  factory: (_container, _settings, req): ClientPrincipal | undefined => {
    const header = req.headers['x-client'];
    if (header === 'partner-1') return { id: 100, name: 'partner-1' };
    return undefined;
  },
});

app.registerController('/api/reports', ReportController);

await app.start();
```

Behavior:

- `GET /api/reports/status` → 200 for everyone.
- `GET /api/reports/me` with `x-user: ada` → 200; without the header → `401 UNAUTHORIZED`.
- `GET /api/reports/admin/summary` with `x-user: admin` → 200; with `x-user: ada` → `403 FORBIDDEN`.
- `GET /api/reports/export` with `x-client: partner-1` → 200; without → 401.

The name passed to `.secure('client')` / `.authenticated('client')` must be the principal service name (what an auth plugin would call its `userServiceName`), so multiple credential types can coexist in one application.

### Route-Level Middleware

`.middleware(fn)` attaches standard Express middleware to a single route. Middleware runs in the order added, before authentication, validation, and the handler; it can short-circuit by sending a response, or forward errors with `next(error)`.

```typescript
import { BaseController, UnauthorizedError, WebApplication, rateLimitMiddleware } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response, RequestHandler } from 'express';

const requireApiKey: RequestHandler = (req, _res, next) => {
  if (req.headers['x-api-key'] !== 'demo-key') {
    next(new UnauthorizedError('Invalid or missing API key'));
    return;
  }
  next();
};

class ReportController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/reports')
        .middleware(requireApiKey)
        .middleware(rateLimitMiddleware({ maxRequests: 20, windowMs: 60_000 }))
        .handle(this.listReports),
    ];
  }

  private async listReports(_req: Request, res: Response): Promise<void> {
    this.ok(res, { reports: [] });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api', ReportController);

await app.start();
```

- `rateLimitMiddleware` is built in. It stores counters in memory (single-instance deployments), sets `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers on each response, and throws a `RateLimitError` → `429 RATE_LIMIT_EXCEEDED` when the window is exhausted. Use `keyExtractor` to limit by something other than IP.
- Errors passed to `next()` land in the same error handler that produces the standard error envelope.
- For application-wide middleware, use a plugin (next section) or add it to the underlying Express app before `start()`:

```typescript fragment
app.express.use(rateLimitMiddleware({ maxRequests: 100 }));
```

### Plugins and Static Files

Plugins are registered with `app.use(definition)` before `start()` and installed in ascending `priority` order (default `100`). A factory receives `{ app, express, logger }` and may return a `Plugin` with `health()` (aggregated into `GET /health`) and `shutdown()` (called during graceful shutdown, after singleton services are disposed).

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { PluginDefinition } from 'blendsdk/webafx';

const metricsPlugin: PluginDefinition = {
  name: 'metrics',
  priority: 50,
  factory: async ({ express, logger }) => {
    let requests = 0;

    express.use((_req, _res, next) => {
      requests += 1;
      next();
    });

    await logger.info('Metrics middleware installed');

    return {
      health: async () => true,
      shutdown: async () => {
        await logger.info(`Shutting down; saw ${requests} requests`);
      },
    };
  },
};

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.use(metricsPlugin);

await app.start();
```

Registering two plugins with the same name throws `Plugin "name" is already registered`. Plugins may also implement an optional `terminal()` hook — middleware mounted *after* controllers and `/health` but before the 404 handler — which is how catch-all behavior (like an SPA fallback) avoids shadowing API routes.

`staticFilesPlugin` is the built-in plugin for serving static files and SPAs, wrapping Express's static middleware:

```typescript
import { WebApplication, staticFilesPlugin } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

// Serve a built single-page application: real files first,
// index.html for unrecognized client-side routes.
app.use(
  staticFilesPlugin({
    root: './client/dist',
    spa: true,
  })
);

// Hashed assets with long-lived immutable caching.
app.use(
  staticFilesPlugin({
    root: './client/dist/assets',
    prefix: '/assets',
    maxAge: '1y',
    immutable: true,
  })
);

await app.start();
```

Key options: `root` (required — must exist at startup or `start()` rejects), `prefix` (mount path, default `'/'`), `maxAge` (e.g. `'1y'`, `'1d'`), `immutable`, `dotfiles`, `index`, `spa`, and `priority`. With `spa: true`, `index.html` is served only for `GET` requests that accept HTML and do not look like file requests — JSON calls and API routes still reach controllers or 404 as usual.

---

## Configuration

### Configuration Sources

Configuration comes from three places, merged in this order (later sources win):

1. **Constructor object** — `new WebApplication({ PORT: 3000 })`, validated immediately.
2. **`.env.js`** — loaded from the current working directory when `start()` runs.
3. **`.env.local.js`** — loaded after `.env.js`; use it for machine-specific values and secrets (keep it out of version control).

```javascript
// .env.js — loaded automatically from the current working directory at start()
export default {
  PORT: 3000,
  ENV_MODE: 'development',
  LOG_LEVEL: 'INFO',
  CORS: { origin: 'https://app.example.com', credentials: true },
  REPORTS_BUCKET: 'reports-dev',
};
```

A file may export the object as `default` (or as a named `config` export). Missing files are skipped silently; a file that exists but fails to load rejects `start()` with `Configuration file error: <path>`. Values are never copied into `process.env` — the configuration object is the single source of truth.

### Options Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `PORT` | `number` | `4000` | Listen port. `0` asks the OS for a free port (useful in tests). Validated: integer `0`–`65535`. |
| `ENV_MODE` | `'production' \| 'development' \| 'test'` | `'production'` | Environment mode. Non-production includes error messages and stack traces in responses and shortens the shutdown drain to 1 second. |
| `LOG_LEVEL` | `'ERROR' \| 'WARN' \| 'INFO' \| 'DEBUG'` | `'ERROR'` | Threshold for the built-in console logger. |
| `DEBUG` | `boolean` | `undefined` | Convenience switch for debug logging. |
| `TRUST_PROXY` | `boolean` | `true` | Express `trust proxy` — required behind nginx/load balancers so client IPs, secure cookies, and rate-limit keys are correct. |
| `BODY_LIMIT` | `string` | `'10mb'` | Maximum size of JSON and URL-encoded request bodies. |
| `SHUTDOWN_TIMEOUT` | `number` | `7` | Maximum seconds to drain connections during shutdown (production). Validated: `0`–`300`. Non-production uses 1 second. |
| `CORS` | `boolean \| CorsConfig` | `undefined` (middleware disabled) | `true` enables permissive defaults (wildcard origin); a `CorsConfig` object enables tailored CORS; `false` or absent leaves the CORS middleware uninstalled. |
| custom keys | `string \| number \| boolean` | — | Any additional key is accepted (schema passthrough) and readable through `settings.get(...)`. |

When configuration is loaded from files, an explicit `LOG_LEVEL` wins; otherwise `DEBUG: true` or a non-production `ENV_MODE` resolves the level to `DEBUG`, and production defaults to `ERROR`.

A full constructor example:

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({
  PORT: 8080,
  ENV_MODE: 'production',
  LOG_LEVEL: 'WARN',
  BODY_LIMIT: '2mb',
  SHUTDOWN_TIMEOUT: 15,
  TRUST_PROXY: true,
  CORS: {
    origin: ['https://app.example.com', 'https://admin.example.com'],
    credentials: true,
    maxAge: 3600,
  },
  FEATURE_FLAGS_URL: 'https://flags.example.com',
});

await app.start();
```

Invalid values fail fast with a detailed error:

```
Configuration validation failed:
  - PORT: Too big: expected number to be <=65535
  - ENV_MODE: Invalid option: expected one of "production"|"development"|"test"
```

Read individual values with `settings.get(key, fallback)`, which is typed and safe to call anywhere the settings object is available:

```typescript fragment
// Inside a controller — BaseController provides the protected `settings`:
const bodyLimit = this.settings.get<string>('BODY_LIMIT', '10mb');

// Inside a service factory — settings is the second parameter:
app.registerService({
  name: 'reports',
  type: 'singleton',
  factory: (_container, settings) => ({
    bucket: settings.get<string>('REPORTS_BUCKET', 'default'),
  }),
});
```

### CORS

Set `CORS: true` for wildcard defaults, or provide a `CorsConfig`:

| Option | Type | Description |
|--------|------|-------------|
| `origin` | `string \| string[] \| callback` | Allowed origin(s); a callback receives `(origin, callback)` for dynamic decisions |
| `methods` | `string[]` | Allowed HTTP methods |
| `allowedHeaders` | `string[]` | Request headers allowed during preflight |
| `exposedHeaders` | `string[]` | Response headers exposed to browser clients |
| `credentials` | `boolean` | Allow cookies / credentials |
| `maxAge` | `number` | Preflight cache duration in seconds |

---

## Error Handling

### How Request Errors Are Turned Into Responses

Throw an error anywhere in the request pipeline — a handler, route middleware, or service factory — and WebAFX's error middleware converts it into a JSON envelope:

- Errors that extend `ApiError` keep their `statusCode`, `code`, `message`, and optional `details`.
- Any other error becomes `500 INTERNAL_SERVER_ERROR`. In production (`ENV_MODE: 'production'`) the message is replaced with `"Internal Server Error"` and no stack trace is included; outside production, the real message and stack are included to speed up debugging.
- Every error is logged through the application logger (replaceable via `app.setLogger()`); even if the logger itself fails, the client still receives the error response.
- The response echoes the request ID (UUID, also sent as the `X-Request-ID` header) and the request path for tracing.

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "User 42 not found",
    "statusCode": 404,
    "timestamp": "2026-02-08T18:30:00.000Z",
    "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "path": "/api/users/42"
  }
}
```

| Field | Description |
|-------|-------------|
| `code` | Stable, machine-readable error code |
| `message` | Human-readable message (masked for unknown errors in production) |
| `statusCode` | HTTP status code |
| `details` | Optional extra payload (e.g. validation issues) |
| `timestamp` | ISO 8601 time of the response |
| `requestId` | Correlation UUID — same value as the `X-Request-ID` header |
| `path` | Request path |
| `stack` | Included only outside production |

### Error Classes

All HTTP errors extend `ApiError`, constructed as `new ApiError(statusCode, code, message, details?)`. The concrete classes are:

| Class | Status | `code` | Default message |
|-------|--------|--------|-----------------|
| `BadRequestError` | 400 | `BAD_REQUEST` | Bad Request |
| `UnauthorizedError` | 401 | `UNAUTHORIZED` | Unauthorized |
| `ForbiddenError` | 403 | `FORBIDDEN` | Forbidden |
| `NotFoundError` | 404 | `NOT_FOUND` | Not Found |
| `ConflictError` | 409 | `CONFLICT` | Conflict |
| `ValidationError` | 422 | `VALIDATION_ERROR` | Validation Failed |
| `RateLimitError` | 429 | `RATE_LIMIT_EXCEEDED` | Rate Limit Exceeded |
| `InternalServerError` | 500 | `INTERNAL_SERVER_ERROR` | Internal Server Error |
| `ServiceUnavailableError` | 503 | `SERVICE_UNAVAILABLE` | Service Unavailable |

Each accepts an optional custom `message` and `details`. `ApiError` itself is usable for any other status/code pair.

### Errors the Framework Raises Automatically

You never write these yourself — they are produced by the framework:

- **404 `NOT_FOUND`** — unmatched route (`Cannot GET /nope`).
- **401 `UNAUTHORIZED`** — a `.secure()` / `.authenticated()` route without a principal.
- **403 `FORBIDDEN`** — an `.authorize()` callback returned `false`.
- **422 `VALIDATION_ERROR`** — a `.validate()` schema rejected the input; `details` lists `{ path, message, code }` per issue.
- **429 `RATE_LIMIT_EXCEEDED`** — the rate limiter's window is exhausted.

### Throwing Errors from Handlers

Because the route wrapper catches everything, handlers simply throw:

```typescript
import { BaseController, ConflictError, NotFoundError, WebApplication } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface User {
  id: number;
  email: string;
}

const users = new Map<number, User>();

class UserController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route().get('/:id').handle(this.getUser),
      this.route().post('/').handle(this.createUser),
    ];
  }

  private async getUser(req: Request, res: Response): Promise<void> {
    const id = Number(req.params.id);
    const user = users.get(id);
    if (!user) {
      throw new NotFoundError(`User ${id} not found`);
    }
    this.ok(res, user);
  }

  private async createUser(req: Request, res: Response): Promise<void> {
    // In practice this route would validate the body first — see Fundamentals.
    const { email } = req.services.getParams<{ email: string }>();
    const exists = [...users.values()].some(existing => existing.email === email);
    if (exists) {
      throw new ConflictError('Email already registered', { email });
    }
    const user: User = { id: users.size + 1, email };
    users.set(user.id, user);
    this.created(res, user);
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api/users', UserController);

await app.start();
```

Use `try/catch` when you want to **translate** an unexpected failure into a meaningful one:

```typescript fragment
try {
  const cache = await req.services.get<Map<string, string>>('cache');
  cache.set('last-seen', new Date().toISOString());
} catch (error) {
  throw new ServiceUnavailableError('Cache unavailable', {
    reason: error instanceof Error ? error.message : 'unknown error',
  });
}
```

In route middleware, forward errors with `next(error)` instead of throwing — they reach the same error handler.

### Defining Custom Errors

Extend `ApiError` when your domain needs its own code and status:

```typescript
import { ApiError } from 'blendsdk/webafx';

/**
 * 402 Payment Required — application-specific error code.
 * Serialized with the same envelope as the built-in errors.
 */
export class PaymentRequiredError extends ApiError {
  constructor(message = 'Payment required', details?: unknown) {
    super(402, 'PAYMENT_REQUIRED', message, details);
  }
}
```

Throw it like any other error — `instanceof ApiError` is all the error middleware needs to preserve its status code, code, and details:

```typescript fragment
throw new PaymentRequiredError('Subscription expired', { plan: 'free' });
```

### Startup and Registration Errors

Failures that happen while wiring or starting the application are not HTTP errors — they are thrown (or reject `start()`) so the process fails fast. Wrap startup in a `try/catch` in your entry point:

```typescript
import { WebApplication } from 'blendsdk/webafx';

try {
  const app = new WebApplication({
    PORT: 3000,
    ENV_MODE: 'development',
    LOG_LEVEL: 'INFO',
  });

  // Rejects on invalid config files, failing plugin factories,
  // a missing static-files root, or a second start() call.
  await app.start();
  console.log('Server is ready');
} catch (error) {
  console.error('Failed to start the application:', error);
  process.exitCode = 1;
}
```

Common startup and registration errors:

| Situation | Error |
|-----------|-------|
| Invalid configuration value | `Configuration validation failed:` followed by one line per invalid key (constructor and `start()`) |
| Broken config file | `Configuration file error: <path>` (rejects `start()`) |
| Duplicate plugin name | `Plugin "name" is already registered` (thrown by `app.use()`) |
| Duplicate service name | `Service "name" is already registered` (thrown by `registerService()`) |
| Missing static files root | `Static files root directory does not exist: <path>` (rejects `start()`) |
| `start()` called twice | `Application already started` |
| Malformed route chain | `Route method must be set before calling handle()` / `Route handler must be a function, received: ...` |
| Missing service at request time | `Service "name" is not registered` (from `get()` without a fallback — usually a bug → 500) |
| Service dependency cycle | `Circular dependency detected: a -> b -> a` |

Treat these as deployment blockers rather than recoverable conditions: they indicate bad configuration or a programming error, not a client mistake.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
