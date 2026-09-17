> **Package**: `blendsdk/webafx`

# webafx Core Concepts

This document is a deep dive into every core abstraction of `blendsdk/webafx`. Each section explains what the concept is, how it works, presents a complete runnable example, and closes with a reference table. Every example is a complete ESM module that imports only from the package root (`blendsdk/webafx`, plus `zod` where schemas are used). For the high-level tour, see the Overview; for a guided introduction, see Basic Usage.

---

## WebApplication

### What It Is

`WebApplication` is the entry point of every WebAFX program and the owner of the entire runtime: application settings, the Express instance, the HTTP server, the service registry, the plugin registry, the controller registry, and the lifecycle event system. One instance represents one fully isolated application — there is no global state, so multiple applications (or parallel test runs) can coexist in one process.

### How It Works

- The constructor builds `ApplicationSettings` from the given configuration (Zod-validated; `ENV_MODE` defaults to `'production'` for secure-by-default behavior) and creates a private Express application with the core middleware chain wired in a fixed order: trust proxy, CORS, cookie parsing, body parsing (bounded by `BODY_LIMIT`), request IDs with `AsyncLocalStorage` context, request timing, and Helmet security headers.
- Registration APIs — `use()` for plugins, `registerService()` for DI definitions, `registerController()` for controllers, `on()` for lifecycle hooks — are called **before** `start()`. Nothing is mounted until startup.
- `start()` runs a deterministic boot sequence: `beforeStart` hooks fire, plugin factories run in priority order, controller routes are mounted under their base paths, `GET /health` is added, plugin `terminal` hooks run (catch-all middleware that must not shadow controller routes), the 404 handler and error handler are installed, the HTTP server binds, `SIGTERM`/`SIGINT` handlers are registered, `afterStart` hooks fire, and the shutdown function is returned.
- The returned shutdown function fires `beforeShutdown`, drains in-flight requests (up to `SHUTDOWN_TIMEOUT` seconds), shuts plugins down in install order, disposes cached singleton services, removes signal handlers, and fires `afterShutdown`. Calling `start()` twice throws `Application already started`; calling the shutdown function twice is safe.
- `app.express` exposes the underlying Express instance — the exact same object used internally — for raw middleware or routes that do not need the controller abstraction.

### Complete Example

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

class InfoController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/info')
        .handle(async (_req, res) => {
          this.ok(res, {
            env: this.settings.get<string>('ENV_MODE', 'production'),
            uptimeSeconds: Math.round(process.uptime()),
          });
        }),
    ];
  }
}

const lifecycle: string[] = [];

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

app.on('beforeStart', () => {
  lifecycle.push('beforeStart');
})
  .on('afterStart', () => {
    lifecycle.push('afterStart');
  })
  .on('beforeShutdown', () => {
    lifecycle.push('beforeShutdown');
  })
  .on('afterShutdown', () => {
    lifecycle.push('afterShutdown');
  });

app.registerController('/api', InfoController);

// Boots the server, wires SIGTERM/SIGINT, and returns the shutdown function
const shutdown = await app.start();
// lifecycle → ['beforeStart', 'afterStart']
// GET /api/info → { "success": true, "data": { "env": "development", ... } }
// GET /health   → { "health": true, "timestamp": "..." }

// Programmatic stop — SIGTERM/SIGINT trigger the same path automatically
await shutdown();
// lifecycle → ['beforeStart', 'afterStart', 'beforeShutdown', 'afterShutdown']
```

### Key Methods & Properties

| Name | Signature | Description |
|------|-----------|-------------|
| `constructor` | `new WebApplication(config: ApplicationConfig)` | Creates the app: validated settings, Express instance, and per-application registries. |
| `start` | `start(): Promise<() => Promise<void>>` | Boots the server and returns the graceful shutdown function. Throws if already started. |
| `on` | `on(event: 'beforeStart' \| 'afterStart' \| 'beforeShutdown' \| 'afterShutdown', hook: () => void \| Promise<void>): this` | Registers a lifecycle hook. Multiple hooks per event run in registration order; returns `this` for chaining. |
| `use` | `use(definition: PluginDefinition): void` | Registers a plugin. Duplicate plugin names throw immediately. |
| `registerController` | `registerController(basePath: string, ControllerClass: new (settings: ApplicationSettings, services: ServiceContainer) => BaseController): void` | Mounts the controller's route definitions under `basePath`. |
| `registerService` | `registerService(definition: ServiceDefinition): void` | Registers a singleton or per-request service in the app-owned registry. |
| `express` | `get express(): Express` | The underlying Express instance — same instance used internally. |
| `getSettings` | `getSettings(): ApplicationSettings` | Returns the settings instance created from the constructor config. |
| `setLogger` | `setLogger(logger: Logger): void` | Replaces the application logger at runtime (used by logger plugins). Last call wins. |
| shutdown (returned) | `() => Promise<void>` | Graceful stop: drain, plugin shutdown, service disposal, shutdown hooks. Idempotent. |

---

## ApplicationSettings

### What It Is

`ApplicationSettings` is the typed, validated configuration container for an application. It replaces scattered `process.env` reads with a single source of truth: values from the constructor config and from optional JavaScript config files, validated by a Zod schema, and read through a typed accessor.

### How It Works

- `ENV_MODE` defaults to `'production'` — the secure default, so stack traces are never exposed if configuration loading fails.
- Configuration comes from two sources: the constructor argument and `loadFromFile()` — an async method that dynamically `import()`s a JavaScript file (for example `.env.js` or `.env.local.js`) and merges its `default` or `config` export over the current values. A file that does not exist is silently skipped; a file that exists but fails to load throws.
- Everything is validated against a Zod schema: `PORT` (integer, 0–65535), `ENV_MODE`, `LOG_LEVEL`, `DEBUG`, `TRUST_PROXY`, `BODY_LIMIT`, `SHUTDOWN_TIMEOUT` (0–300 seconds), and `CORS` (boolean or config object). The schema uses `.passthrough()`, so custom keys are allowed. Validation failures throw `Configuration validation failed:` with one line per invalid field — at construction and again after file loading.
- `LOG_LEVEL` normalization: an explicit `LOG_LEVEL` always wins; otherwise `DEBUG: true` or a non-production `ENV_MODE` yields `'DEBUG'`, and production without `DEBUG` yields `'ERROR'`.
- Loading never mutates `process.env` — the settings object is the single source of truth.

### Complete Example

```typescript
import { ApplicationSettings } from 'blendsdk/webafx';

const settings = new ApplicationSettings({
  ENV_MODE: 'development',
  PORT: 3000,
  TRUST_PROXY: true,
  CORS: {
    origin: ['https://app.example.com'],
    credentials: true,
    maxAge: 7200,
  },
  // Custom properties are allowed by the passthrough schema
  CUSTOM_FEATURE_FLAG: true,
});

// Dynamic import of a JS config file — silently skipped when the file is absent
await settings.loadFromFile('.env.local.js');

const port = settings.get<number>('PORT', 8080); // 3000
const featureEnabled = settings.get<boolean>('CUSTOM_FEATURE_FLAG', false); // true
const isProduction = settings.isProduction(); // false

const snapshot = settings.getAll();
snapshot.PORT = 9000; // Safe — getAll() returns a shallow copy
console.log(settings.get<number>('PORT')); // 3000 — the internal config is unchanged

// Invalid values are rejected up front:
// new ApplicationSettings({ PORT: -1 });
// → throws Error: "Configuration validation failed:\n  - PORT: ..."
```

### Key Methods & Properties

| Name | Signature | Description |
|------|-----------|-------------|
| `constructor` | `new ApplicationSettings(config?: ApplicationConfig, logger?: ConsoleLogger)` | Merges the config over defaults (`ENV_MODE: 'production'`) and validates it. |
| `loadFromFile` | `loadFromFile(jsPath: string): Promise<void>` | Dynamically imports a JS config file and merges its export. Missing files are ignored; load errors throw. |
| `get` | `get<T>(key: keyof ApplicationConfig, defaultValue?: T): T` | Returns the value for `key`, or `defaultValue` when unset. |
| `getAll` | `getAll<T extends ApplicationConfig>(): T` | Shallow copy of the whole config; mutations do not affect internal state. |
| `isProduction` | `isProduction(): boolean` | `true` when `ENV_MODE === 'production'`. |

**Standard configuration keys:**

| Key | Type | Description |
|-----|------|-------------|
| `PORT` | `number` | TCP port, 0–65535. `0` binds an ephemeral port (useful in tests). |
| `ENV_MODE` | `'production' \| 'development' \| 'test'` | Drives production behavior (error verbosity, log normalization). Default: `'production'`. |
| `LOG_LEVEL` | `'ERROR' \| 'WARN' \| 'INFO' \| 'DEBUG'` | Explicit logger threshold. |
| `DEBUG` | `boolean` | When `true`, normalizes `LOG_LEVEL` to `'DEBUG'` and enables debug logging. |
| `TRUST_PROXY` | `boolean` | Trust `X-Forwarded-*` headers (nginx/load balancers); affects `req.ip` and rate-limit keys. |
| `BODY_LIMIT` | `string` | Request body size limit for the body parsers (for example `'1mb'`). |
| `SHUTDOWN_TIMEOUT` | `number` | Graceful-shutdown drain budget in seconds, 0–300. |
| `CORS` | `boolean \| CorsConfig` | `false` disables CORS, `true` allows all origins, an object enables custom rules. |
| custom keys | `string \| number \| boolean` | Additional properties pass the passthrough schema and are readable via `get()`. |

---

## BaseController

### What It Is

`BaseController` is the abstract base class for every HTTP controller. A subclass implements a single `routes()` method that declares its endpoints, and inherits response helpers that emit the package's standard success envelopes — so every endpoint in the application answers with the same JSON shape.

### How It Works

- `WebApplication` instantiates each registered controller class (passing `ApplicationSettings` and a `ServiceContainer`) and calls `routes()` at startup. Each returned `RouteDefinition` is mounted at `basePath + route.path`.
- Handler functions run inside the class, so they lean on two protected members: `this.settings` (configuration) and route-building helpers (`route()`, `authenticated()`). Per-request state — validated input, resolved services, the authenticated principal — is read from the per-request container at `req.services`.
- Response helpers wrap payloads in the standard envelope: `ok()` → 200 `{ success: true, data }`, `created()` → 201 with the same shape, `paginated()` → adds `pagination: { total, page, limit, pages }` where `pages = Math.ceil(total / limit)`, and `noContent()` → 204 with an empty body. The envelope types are exported as `StandardSuccessResponse<T>` and `PaginatedResponse<T>`.
- Route construction itself is fluent — every detail of the builder chain lives in [RouteBuilder](#routebuilder).

### Complete Example

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

interface User {
  id: number;
  name: string;
}

const users: User[] = [
  { id: 1, name: 'Ada' },
  { id: 2, name: 'Grace' },
];

class UserController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      // 200 { success: true, data: { users: [...] } }
      this.route()
        .get('/users')
        .handle(async (_req, res) => {
          this.ok(res, { users });
        }),

      // 201 { success: true, data: { id: 3, name: 'Linus' } }
      this.route()
        .post('/users')
        .handle(async (req, res) => {
          const input = req.services.getInput<{ body: { name?: string } }>();
          const user: User = { id: users.length + 1, name: input.body.name ?? 'Anonymous' };
          users.push(user);
          this.created(res, user);
        }),

      // 200 { success: true, data: [...], pagination: { total: 150, page: 2, limit: 50, pages: 3 } }
      this.route()
        .get('/users/page')
        .handle(async (_req, res) => {
          this.paginated<User>(res, users, 150, 2, 50);
        }),

      // 204 — empty body
      this.route()
        .delete('/users/:id')
        .handle(async (_req, res) => {
          this.noContent(res);
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api', UserController);

const shutdown = await app.start();
// GET    /api/users      → 200 { success: true, data: { users: [...] } }
// POST   /api/users      → 201 { success: true, data: { id: 3, name: 'Linus' } }
// GET    /api/users/page → 200 with pagination metadata
// DELETE /api/users/1    → 204, no body
```

### Key Methods & Properties

| Name | Signature | Description |
|------|-----------|-------------|
| `constructor` | `(settings: ApplicationSettings, services: ServiceContainer)` | Provided by `WebApplication` when the controller is instantiated; exposed to subclasses as `this.settings`. |
| `routes` | `abstract routes(): RouteDefinition[]` | Declares the controller's endpoints. Must be implemented. |
| `route` | `route(): RouteBuilder` | Creates a new builder for one route definition. |
| `authenticated` | `authenticated(userServiceName?: string): RouteBuilder` | Shorthand for `route().secure(userServiceName)`. No argument → default `'user'` principal. |
| `ok` | `ok<T>(res: Response, data: T): void` | 200 `{ success: true, data }`. |
| `created` | `created<T>(res: Response, data: T): void` | 201 with the same envelope. |
| `paginated` | `paginated<T>(res: Response, data: T[], total: number, page: number, limit: number): void` | 200 with `pagination: { total, page, limit, pages }`. |
| `noContent` | `noContent(res: Response): void` | 204 with an empty body. |

---

## RouteBuilder

### What It Is

`RouteBuilder` is the fluent API that turns a chain of method calls into a complete `RouteDefinition`. Controllers create builders via `this.route()`; each chain picks an HTTP method and path, optionally adds modifiers, and terminates with a handler.

### How It Works

- Chain grammar: HTTP method + path → optional modifiers (`middleware`, `secure`, `authorize`, `openapi`, `validate`) → `handle(handler)`, which validates the definition and returns it. `handle()` fails loudly on mistakes: a non-function handler, a missing method, or a missing path throws with the route's path and method in the message.
- `.middleware(fn)` accumulates handlers in call order. Middleware runs before the route handler; the full per-route order is: route middleware → `.secure()` guard → `.authorize()` check → `.validate()` schema → handler.
- `.secure()` records authentication intent — `true` for the default principal, or a (trimmed) service name for a named one. A blank name throws. A route is secure when the value is `true` or a string; omitted or `false` routes stay public. See [Authentication and Authorization](#authentication-and-authorization) for the runtime semantics.
- `.openapi(meta)` attaches pure documentation metadata (summary, tags, operationId, deprecated flag, path parameter schemas, response definitions, and the response `envelope` a generated client should read). It is the opt-in mechanism: only routes with `.openapi()` appear in generated OpenAPI specs. Generation itself lives in `blendsdk/codegen` — WebAFX only carries the metadata.
- `.validate(schema)` attaches a Zod schema for the request input — details are in [Request Validation](#request-validation).

### Complete Example

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { z } from 'zod';

const listProductsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

class ProductController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/products')
        .openapi({
          summary: 'List products',
          tags: ['products'],
          // Paginated output carries `pagination`; 'body' tells a generated
          // client to keep the whole body instead of only `data`.
          envelope: 'body',
          responses: [{ statusCode: 200, description: 'Paginated product list' }],
        })
        .validate(listProductsSchema)
        .handle(async (req, res) => {
          const { page, limit } = req.services.getParams<{ page: number; limit: number }>();
          const firstId = (page - 1) * limit;
          const products = Array.from({ length: limit }, (_, index) => ({
            id: firstId + index + 1,
            name: `Product ${firstId + index + 1}`,
          }));
          this.paginated(res, products, 250, page, limit);
        }),

      this.route()
        .get('/products/:id')
        .openapi({
          summary: 'Get a product by id',
          tags: ['products'],
          pathParams: {
            id: { schema: z.coerce.number().int(), description: 'Product id' },
          },
          responses: [
            { statusCode: 200, description: 'Product details' },
            { statusCode: 404, description: 'Product not found' },
          ],
        })
        .handle(async (req, res) => {
          this.ok(res, { id: req.params.id, name: `Product ${req.params.id}` });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api', ProductController);

const shutdown = await app.start();
// GET /api/products?page=2&limit=10 → 200 with pagination metadata
// GET /api/products/5              → 200 { success: true, data: { id: '5', ... } }
```

### Key Methods & Properties

| Name | Signature | Description |
|------|-----------|-------------|
| `get` / `post` / `put` / `patch` / `delete` | `(path: string): this` | Sets the HTTP method and path. Must come before `handle()`. |
| `secure` | `(userServiceName?: string): this` | Requires authentication. Omitted → default `'user'` principal; a string selects a named principal service (trimmed; blank throws). |
| `authorize` | `(fn: (req: Request, user: T) => boolean \| Promise<boolean>): this` | Runs after authentication; returning `false` produces 403. |
| `middleware` | `(fn: RequestHandler): this` | Appends a per-route middleware; runs in registration order before the handler. |
| `openapi` | `(meta: OpenAPIRouteMetadata): this` | Attaches documentation metadata; opt-in for generated OpenAPI specs. |
| `validate` | `(schema: ZodType): RouteBuilder` | Attaches a Zod schema for merged request input; invalid input → 422 before the handler runs. |
| `handle` | `(handler: RouteHandler): RouteDefinition` | Terminates the chain and returns the definition. Throws on an invalid handler, missing method, or missing path. |

The produced `RouteDefinition` carries `method`, `path`, `handler`, plus the optional `validation`, `secure`, `authorize`, `middleware`, and `openapi` fields.

A route that sends paginated output sets `envelope: 'body'` in its `.openapi()` metadata, so a generated client keeps the `pagination` object; the default `'data'` unwraps only the `data` property.

---

## Request Validation

### What It Is

Request validation is the framework's Zod-powered input gate: a route declares a schema with `.validate()`, and the framework parses the request's `params`, `query`, and `body` before the handler runs. Invalid requests never reach the handler — they receive a structured `422 VALIDATION_ERROR` response.

### How It Works

- The framework merges `req.params`, `req.query`, and `req.body` into one input object and parses it with the route's schema. This lets a single schema cover path parameters, query strings, and body fields at once.
- On success, the per-request service container carries two derived entries: the merged result (`request-params`, read via `req.services.getParams<T>()`) and the separated sources (`request-input`, read via `req.services.getInput<T>()`, shaped `{ params, query, body }`). Both are available whether or not a schema was declared — `.validate()` guarantees conformance before the handler executes.
- Zod transforms and coercion apply: `z.coerce` turns query strings and URL parameters into numbers, and `.default()` fills in omitted values — the handler reads the parsed result, fully typed.
- On failure, the framework throws a `ValidationError`: HTTP 422 with `error.code === 'VALIDATION_ERROR'` and field-level `details` describing each failing input.
- Prefer `getParams` / `getInput` over reading `req.body` directly — they are the typed access paths.

### Complete Example

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { z } from 'zod';

const createUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  age: z.coerce.number().int().min(18),
});

interface CreateUserInput {
  name: string;
  email: string;
  age: number;
}

const userParamsSchema = z.object({
  id: z.string().min(1),
  include: z.enum(['posts', 'comments']).optional(),
});

class UserController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .post('/users')
        .validate(createUserSchema)
        .handle(async (req, res) => {
          // Parsed, coerced, and complete thanks to the schema defaults
          const input = req.services.getParams<CreateUserInput>();
          this.created(res, { id: 'u-1', ...input });
        }),

      this.route()
        .get('/users/:id')
        .validate(userParamsSchema)
        .handle(async (req, res) => {
          // Separated sources: path params and query stay distinct
          const input = req.services.getInput<{
            params: { id: string };
            query: { include?: 'posts' | 'comments' };
          }>();
          this.ok(res, { id: input.params.id, include: input.query.include ?? null });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api', UserController);

const shutdown = await app.start();
// POST /api/users { "name": "Ada", "email": "ada@example.com", "age": 36 }
//   → 201 { success: true, data: { id: 'u-1', name: 'Ada', ... } }
// POST /api/users { "name": "", "email": "not-an-email", "age": 12 }
//   → 422 { success: false, error: { code: 'VALIDATION_ERROR', details: [ ... ] } }
// GET /api/users/42?include=posts
//   → 200 { success: true, data: { id: '42', include: 'posts' } }
```

### Key Methods & Properties

| Name | Signature | Description |
|------|-----------|-------------|
| `validate` (RouteBuilder) | `(schema: ZodType): RouteBuilder` | Declares the schema for merged params/query/body. Failure → 422 before the handler. |
| `getParams` (ServiceContainer) | `getParams<T>(): T` | Merged `params` + `query` + `body`; validated when the route declares `.validate()`; `{}` when nothing is present. |
| `getInput` (ServiceContainer) | `getInput<T>(): T` | Separated `{ params, query, body }` — default shape when nothing is present. |
| failure behavior | — | `422` with `code: 'VALIDATION_ERROR'` and field-level `details`. |

---

## Authentication and Authorization

### What It Is

Authentication inspects which kind of caller may reach a route; authorization decides whether that specific caller may perform the action. WebAFX models both at the route level: `.secure()` (or `authenticated()`) demands an authenticated principal, and `.authorize(fn)` runs a per-route permission check against it. The framework does not dictate how credentials are verified — the principal is produced by a regular service you register.

### How It Works

- A route is secure when its `secure` value is `true` or a string. Before the handler runs (and after route middleware), the guard resolves the authenticated principal from the per-request service container under `'user'` by default — or under the named service, for example `'client'`. That name must be the principal service name, which allows two auth providers (browser sessions and machine clients) to coexist in one application.
- If no principal is present — or the named service is not registered — the guard fails closed with `401 UNAUTHORIZED`.
- When the route declares `.authorize(fn)`, the guard passes the resolved principal to `fn(req, principal)`. A `false` result means the caller authenticated but lacks permission: `403 FORBIDDEN`.
- Principal services are ordinary registrations, typically `type: 'per-request'` so each request resolves its own principal: the factory inspects the request (headers, cookies, tokens) and returns the principal object or `undefined`. Auth plugins in the BlendSDK ecosystem ship such services and strategies.
- On the controller side, `this.authenticated(name?)` is shorthand for `this.route().secure(name)`.

### Complete Example

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

interface Principal {
  sub: string;
  kind: 'user' | 'client';
}

class AccountController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      // Default principal: the guard resolves the 'user' service
      this.authenticated()
        .get('/me')
        .handle(async (req, res) => {
          const user = await req.services.get<Principal>('user');
          this.ok(res, { sub: user.sub });
        }),

      // Named principal: resolves the 'client' service, then checks permissions
      this.authenticated('client')
        .get('/export')
        .authorize((_req, principal: Principal) => principal.kind === 'client')
        .handle(async (req, res) => {
          const client = await req.services.get<Principal>('client');
          this.ok(res, { exportedFor: client.sub });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

app.registerService({
  name: 'user',
  type: 'per-request',
  factory: (_container, _settings, req) => {
    const token = req.headers.authorization;
    return token === 'Bearer user-token' ? { sub: 'user-1', kind: 'user' } : undefined;
  },
});

app.registerService({
  name: 'client',
  type: 'per-request',
  factory: (_container, _settings, req) => {
    const token = req.headers.authorization;
    return token === 'Bearer client-token' ? { sub: 'client-1', kind: 'client' } : undefined;
  },
});

app.registerController('/api', AccountController);

const shutdown = await app.start();
// GET /api/me     + Authorization: Bearer user-token   → 200 { sub: 'user-1' }
// GET /api/me     + no token                           → 401 UNAUTHORIZED
// GET /api/export + Authorization: Bearer client-token → 200 { exportedFor: 'client-1' }
// GET /api/export + Authorization: Bearer user-token   → 401 (no 'client' principal)
```

### Key Methods & Properties

| Name | Signature | Description |
|------|-----------|-------------|
| `secure` (RouteBuilder) | `(userServiceName?: string): this` | Requires a principal. Omitted → `'user'`; a string selects the named principal service (trimmed; blank throws). |
| `authenticated` (BaseController) | `(userServiceName?: string): RouteBuilder` | Shorthand for `route().secure(userServiceName)`. |
| `authorize` (RouteBuilder) | `(fn: (req: Request, user: T) => boolean \| Promise<boolean>): this` | Runs after authentication with the resolved principal; `false` → 403. |
| missing principal | — | `401 UNAUTHORIZED` — including when a named service is not registered (fail closed). |
| failed authorization | — | `403 FORBIDDEN` — the principal was present but the check returned `false`. |

---

## ServiceContainer (Dependency Injection)

### What It Is

`ServiceContainer` is the dependency-injection system of WebAFX. Application code registers named service definitions with factories; at runtime, services are resolved on demand under one of two lifecycles: `singleton` (created once per application) or `per-request` (created fresh for every HTTP request). The container attached to the current request is available as `req.services`, so both controllers and plugins resolve dependencies through the same mechanism.

### How It Works

- Definitions live in a registry owned by the `WebApplication` — there is no global state, so two application instances never share services. A container wraps one registry and is created per request, exposed as `req.services`; all containers of one application share the registry, which is what makes singletons application-wide while per-request services stay isolated.
- `get(name)` returns a cached instance when one exists. Otherwise it looks up the definition, resolves and awaits every entry in `dependencies` first, invokes the factory, and caches the result: singletons in the shared registry (created exactly once), per-request instances in the container only.
- Factory signatures: singletons receive `(container, settings)`; per-request factories receive `(container, settings, req, res, next)` and throw if resolved outside a request scope.
- Cyclic dependencies are detected during resolution and reported with the full chain (`a -> b -> c -> a`). Declared `dependencies` also give deterministic creation order.
- Registering a duplicate service name throws; `set(name, value)` deliberately overrides an instance in a single container. `get(name, defaultValue)` returns the default for unregistered names instead of throwing.
- Convenience accessors: `getUser<T>()` returns the `'user'` principal, `getParams<T>()` the merged validated input, and `getInput<T>()` the separated `{ params, query, body }`.
- On application shutdown, `disposeAll()` runs each created singleton's optional `dispose(instance)` hook and clears the singleton cache — the place to close database pools, flush buffers, and release handles.
- Legacy note: the exported `preparseServiceNames()` helper is deprecated — use `as const` objects for service-name maps instead.

### Complete Example

```typescript
import { WebApplication, BaseController, NotFoundError } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

interface UserRecord {
  id: string;
  name: string;
}

class UserRepository {
  private readonly users = new Map<string, UserRecord>([['1', { id: '1', name: 'Ada' }]]);

  findById(id: string): UserRecord | undefined {
    return this.users.get(id);
  }

  close(): void {
    this.users.clear();
  }
}

class UserController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/users/:id')
        .handle(async (req, res) => {
          const repository = await req.services.get<UserRepository>('userRepository');
          const requestInfo = await req.services.get<{ startedAt: number }>('requestInfo');

          const user = repository.findById(req.params.id);
          if (!user) {
            throw new NotFoundError(`User ${req.params.id} not found`);
          }

          this.ok(res, { name: user.name, handledAfterMs: Date.now() - requestInfo.startedAt });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

// Singleton — created once, shared by every request, disposed on shutdown
app.registerService({
  name: 'userRepository',
  type: 'singleton',
  factory: () => new UserRepository(),
  dispose: (instance) => {
    // Narrow the untyped instance before use
    if (instance instanceof UserRepository) {
      instance.close();
    }
  },
});

// Per-request — created fresh for every request
app.registerService({
  name: 'requestInfo',
  type: 'per-request',
  factory: () => ({ startedAt: Date.now() }),
});

app.registerController('/api', UserController);

const shutdown = await app.start();
// GET /api/users/1 → 200 { success: true, data: { name: 'Ada', handledAfterMs: 0 } }
// GET /api/users/9 → 404 NOT_FOUND
```

### Key Methods & Properties

| Name | Signature | Description |
|------|-----------|-------------|
| `get` | `get<T>(name: string, defaultValue?: T): Promise<T>` | Resolves or creates a service. Returns `defaultValue` when unregistered; throws on cycles or per-request access outside a request. |
| `set` | `set(name: string, service: unknown): void` | Sets/overrides an instance in this container. |
| `getUser` | `getUser<T>(): T \| undefined` | The `'user'` entry (authenticated principal), if present. |
| `getParams` | `getParams<T>(): T` | Merged validated input (`{}` when absent). |
| `getInput` | `getInput<T>(): T` | Separated `{ params, query, body }`. |
| `registerService` | `registerService(def: ServiceDefinition): void` | Adds a definition to the app-owned registry; duplicate names throw. |
| `isRegistered` | `isRegistered(name: string): boolean` | Whether a definition exists in this app's registry. |
| `getRegisteredServices` | `getRegisteredServices(): string[]` | All registered definition names. |
| `disposeAll` | `disposeAll(): Promise<void>` | Runs `dispose` for each created singleton and clears the cache; invoked automatically on shutdown. |

**`ServiceDefinition` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Unique key used with `get()`. |
| `type` | `'singleton' \| 'per-request'` | Lifecycle. |
| `factory` | `(container, settings[, req, res, next]) => T \| Promise<T>` | Creation function. |
| `dependencies` | `string[]` (optional) | Resolved and awaited before the factory runs. |
| `dispose` | `(instance: T) => void \| Promise<void>` (optional) | Cleanup hook for singletons during `disposeAll()`. |

---

## Plugin System

### What It Is

The plugin system is how WebAFX packages cross-cutting concerns: anything that adds middleware, contributes health checks, needs ordered cleanup, or must mount catch-all behavior is expressed as a plugin. A plugin is a `PluginDefinition` — a unique name, a priority, and a factory that runs during startup.

### How It Works

- `app.use(definition)` registers `{ name, priority?, factory }`. Names must be unique — registering a duplicate throws immediately, at registration time, not at startup. `priority` defaults to `100`; lower numbers install first, and plugins with equal priority keep registration order.
- At startup, each factory runs with `{ app, express, logger }` — the logger is scoped to `Plugin:<name>` — and may mount Express middleware directly. A factory error aborts `start()`.
- The factory may return a `Plugin` object with three optional hooks:
  - `health()` — aggregated by `GET /health`. When no plugin declares a health check, the system considers itself healthy.
  - `shutdown()` — called during graceful shutdown, in install order.
  - `terminal({ app, express, logger })` — the catch-all phase: terminal middleware mounts **after** controllers and `/health`, but **before** the 404 handler. This exists so fallback middleware (for example an SPA `index.html` fallback) can serve genuinely unmatched requests without ever shadowing controller routes. Terminal hooks run in priority order, exactly like install order.
- The static files plugin is the canonical `terminal` user — see [Static Files and SPA](#static-files-and-spa).

### Complete Example

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

class StatusController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/status')
        .handle(async (_req, res) => {
          this.ok(res, { ok: true });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

// Priority 10 — installs before default-priority (100) plugins
app.use({
  name: 'request-counter',
  priority: 10,
  factory: async ({ express, logger }) => {
    let requests = 0;

    express.use((_req, _res, next) => {
      requests += 1;
      next();
    });

    await logger.info('Request counter middleware mounted');

    return {
      health: async () => true,
      shutdown: async () => {
        await logger.info(`Request counter stopping after ${requests} requests`);
      },
    };
  },
});

// Terminal hook — catch-all middleware mounted AFTER controllers and /health,
// but BEFORE the 404 handler
app.use({
  name: 'app-shell',
  priority: 80,
  factory: async () => ({
    terminal: ({ express: instance }) => {
      instance.use((req, res, next) => {
        if (req.method === 'GET' && !req.path.includes('.') && req.accepts('html')) {
          res.type('html').send('<!DOCTYPE html><html><body><div id="app"></div></body></html>');
          return;
        }
        next();
      });
    },
  }),
});

app.registerController('/api', StatusController);

const shutdown = await app.start();
// GET /api/status → controller JSON (the terminal never shadows it)
// GET /health     → health JSON
// GET /dashboard  → the inline app shell HTML (genuinely unmatched route)
// GET /logo.png   → 404 (file request — the terminal passes through)
```

### Key Methods & Properties

| Name | Signature | Description |
|------|-----------|-------------|
| `PluginDefinition.name` | `string` | Unique plugin name; duplicates throw at `app.use()`. |
| `PluginDefinition.priority` | `number` (default `100`) | Install order — lower first, ties keep registration order. |
| `PluginDefinition.factory` | `({ app, express, logger }) => Promise<Plugin \| void>` | Runs at startup; mounts middleware; returns optional hooks. |
| `Plugin.health` | `() => Promise<boolean>` | Aggregated by `GET /health`; no checks at all → healthy. |
| `Plugin.shutdown` | `() => Promise<void>` | Called during graceful shutdown, in install order. |
| `Plugin.terminal` | `({ app, express, logger }) => void \| Promise<void>` | Catch-all middleware phase: after controllers and `/health`, before 404; priority order. |

---

## Error Handling

### What It Is

WebAFX ships a typed error hierarchy — `ApiError` plus a subclass per common HTTP status — and an error middleware that converts anything thrown during a request into a uniform JSON envelope. Handlers throw; clients always receive a well-formed `{ success: false, error }` response.

### How It Works

- Throw an `ApiError` (or any subclass) in a handler or middleware — or call `next(error)`. Express 5 propagates rejected promises, so plain `throw` inside an async handler is enough.
- The built-in error middleware formats a `StandardErrorResponse`: `{ success: false, error: { code, message, statusCode, timestamp, requestId, path, details?, stack? } }`. `requestId` comes from the request-ID middleware and `path` from the request, so clients and logs can correlate failures.
- Errors that are **not** `ApiError` instances become `500 INTERNAL_SERVER_ERROR`. In development the real message and stack are exposed; in production the message is the generic `Internal Server Error` and no stack is included. `ApiError` messages are intentional and always sent.
- Resilience: even if the error-logging callback itself throws, the response is still delivered.
- `error.toJSON()` renders the same standard shape for manual serialization, and custom domain errors simply extend `ApiError` with a status code, a machine-readable code, and a name.

### Complete Example

```typescript
import { WebApplication, BaseController, ApiError, NotFoundError } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

interface Product {
  id: string;
  name: string;
  plan: 'free' | 'enterprise';
}

// Custom domain error — extends the built-in hierarchy
class PaymentRequiredError extends ApiError {
  constructor(feature: string) {
    super(402, 'PAYMENT_REQUIRED', `Upgrade required to access the ${feature} feature`, {
      feature,
    });
    this.name = 'PaymentRequiredError';
  }
}

const products = new Map<string, Product>([
  ['p-1', { id: 'p-1', name: 'Analytics', plan: 'enterprise' }],
  ['p-2', { id: 'p-2', name: 'Reports', plan: 'free' }],
]);

class ProductController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/products/:id')
        .handle(async (req, res) => {
          const product = products.get(req.params.id);
          if (!product) {
            throw new NotFoundError(`Product ${req.params.id} not found`);
          }
          if (product.plan === 'enterprise') {
            throw new PaymentRequiredError(product.name);
          }
          this.ok(res, product);
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });
app.registerController('/api', ProductController);

const shutdown = await app.start();
// GET /api/products/p-2 → 200 { success: true, data: { id: 'p-2', ... } }
// GET /api/products/p-1 → 402
//   { success: false, error: { code: 'PAYMENT_REQUIRED',
//     message: 'Upgrade required to access the Analytics feature',
//     statusCode: 402, details: { feature: 'Analytics' },
//     timestamp: '...', requestId: '...', path: '/api/products/p-1' } }
// GET /api/products/nope → 404 { success: false, error: { code: 'NOT_FOUND', ... } }
```

### Key Methods & Properties

| Name | Signature | Description |
|------|-----------|-------------|
| `ApiError` | `new ApiError(statusCode: number, code: string, message: string, details?)` | Base class for all deliberate HTTP errors. |
| `statusCode` | `number` | HTTP status used in the response. |
| `code` | `string` | Machine-readable error code (for example `'NOT_FOUND'`). |
| `message` | `string` | Human-readable message; always sent to clients. |
| `details` | optional | Extra structured context (failing fields, offending values). |
| `toJSON()` | `StandardErrorResponse` | Renders the standard envelope for manual use. |

**Built-in subclasses** — each accepts an optional `(message?, details?)` and sets its own name, status, and code:

| Error | Status | Code | Default message |
|-------|--------|------|-----------------|
| `BadRequestError` | 400 | `BAD_REQUEST` | Bad Request |
| `UnauthorizedError` | 401 | `UNAUTHORIZED` | Unauthorized |
| `ForbiddenError` | 403 | `FORBIDDEN` | Forbidden |
| `NotFoundError` | 404 | `NOT_FOUND` | Not Found |
| `ConflictError` | 409 | `CONFLICT` | Conflict |
| `ValidationError` | 422 | `VALIDATION_ERROR` | Validation Failed |
| `RateLimitError` | 429 | `RATE_LIMIT_EXCEEDED` | Rate Limit Exceeded |
| `InternalServerError` | 500 | `INTERNAL_SERVER_ERROR` | Internal Server Error |
| `ServiceUnavailableError` | 503 | `SERVICE_UNAVAILABLE` | Service Unavailable |

Standard error envelope fields: `error.code`, `error.message`, `error.statusCode`, `error.timestamp` (ISO 8601), `error.requestId`, `error.path`, plus optional `error.details` and `error.stack` (development only).

---

## Logging and Observability

### What It Is

Observability in WebAFX has two halves: pluggable loggers (`ConsoleLogger` for humans, `StructuredLogger` for log pipelines, any custom `Logger` implementation) and a request-scoped context built on `AsyncLocalStorage` that makes the request ID — and anything else you attach — readable from anywhere in the async call chain.

### How It Works

- All loggers implement the `Logger` interface: async `error`, `warn`, `info`, and `debug` methods. The configured level acts as a threshold — setting `WARN` logs `ERROR` and `WARN`, but suppresses `INFO` and `DEBUG`. `ConsoleLogger` resolves its level from the constructor argument, then the `LOG_LEVEL` environment variable (case-insensitive), then defaults to `ERROR`; `DEBUG=true` additionally enables debug output.
- `ConsoleLogger` writes human-readable lines: `[LEVEL:PREFIX]: message - {json data}`.
- `StructuredLogger` writes one JSON object per entry with `level`, `message`, `timestamp` (ISO 8601), optional `prefix` and `data`, plus any fields returned by its `contextFn` — a function evaluated for every entry, ideal for injecting the current `requestId`.
- Request correlation is automatic: the built-in request-ID middleware reads an inbound `X-Request-ID` — reusing it only when it is a valid UUID, so malformed values cannot pollute logs — generates a fresh UUID otherwise, stores it on `req.id`, echoes it as the `X-Request-ID` response header, and runs the rest of the request inside an `AsyncLocalStorage` context carrying `{ requestId, startTime }` (plus any custom fields you add).
- `getRequestId()` and `getRequestContext()` read that context from handlers, services, loggers, or any downstream async function — no prop drilling. Outside a request they return `undefined`. The underlying `requestContextStorage` instance is exported for advanced use.
- `app.setLogger(logger)` swaps the application logger at runtime; the last call wins. Logger plugins (for example a pino adapter) use exactly this hook.

### Complete Example

```typescript
import {
  WebApplication,
  BaseController,
  StructuredLogger,
  getRequestId,
} from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

// contextFn runs for every log entry — requestId is picked up from AsyncLocalStorage
const logger = new StructuredLogger('API', 'INFO', () => ({
  requestId: getRequestId(),
}));

class ReportController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/reports/:id')
        .handle(async (req, res) => {
          await logger.info('Generating report', { reportId: req.params.id });
          this.ok(res, {
            reportId: req.params.id,
            requestId: getRequestId(),
            generatedAt: new Date().toISOString(),
          });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });
app.setLogger(logger);
app.registerController('/api', ReportController);

const shutdown = await app.start();
// GET /api/reports/r-42 →
//   response header X-Request-ID: 3f1c1b0e-...  (or the valid upstream UUID)
//   stdout (single JSON line):
//   {"level":"INFO","message":"Generating report","timestamp":"...","prefix":"API",
//    "data":{"reportId":"r-42"},"requestId":"3f1c1b0e-..."}
```

### Key Methods & Properties

| Name | Signature | Description |
|------|-----------|-------------|
| `ConsoleLogger` | `new ConsoleLogger(prefix?: string, logLevel?: LogLevel)` | Human-readable output. Level resolution: constructor → `LOG_LEVEL` env → `ERROR`. |
| `StructuredLogger` | `new StructuredLogger(prefix?: string, logLevel?: LogLevel, contextFn?: () => Record<string, unknown>)` | One JSON object per entry; `contextFn` results merged into every entry. |
| log methods | `error \| warn \| info \| debug (message: string, data?) => Promise<void>` | Level-filtered logging; `DEBUG=true` additionally enables debug output. |
| `LogLevel` | `'ERROR' \| 'WARN' \| 'INFO' \| 'DEBUG'` | Threshold type accepted by both loggers. |
| `getRequestId` | `getRequestId(): string \| undefined` | Current request UUID from `AsyncLocalStorage`; `undefined` outside a request. |
| `getRequestContext` | `getRequestContext(): RequestContext \| undefined` | Full context: `{ requestId, startTime, ...custom }`. |
| `setLogger` | `setLogger(logger: Logger): void` | Replaces the application logger; last call wins. |

---

## Security Middleware

### What It Is

WebAFX hardens every application by default: Helmet security headers with `X-Powered-By` removal, configuration-driven CORS, and an in-memory rate limiter. All three are wired without additional dependencies — Helmet and CORS from settings, the rate limiter as a middleware factory you attach globally or per route.

### How It Works

- Helmet runs on every response automatically: `X-Content-Type-Options: nosniff`, `X-Frame-Options`, `Strict-Transport-Security` (with `max-age`), `X-Download-Options: noopen`, and `X-Permitted-Cross-Domain-Policies: none`. The `X-Powered-By` header is removed.
- CORS is controlled through the `CORS` setting: `false` disables the middleware entirely, `true` allows all origins (`Access-Control-Allow-Origin: *`), and an object enables full `CorsConfig` rules — `origin` (string, string array, or dynamic `(origin, callback) => void`), `methods`, `allowedHeaders`, `exposedHeaders`, `credentials`, and `maxAge`. Preflight `OPTIONS` requests answer `204`. CORS headers are applied to error responses too, and disallowed origins receive no `Access-Control-Allow-Origin` header.
- `rateLimitMiddleware(options)` implements an in-memory fixed-window limiter. The first request in a window creates the counter for its key; every request increments it; exceeding `maxRequests` throws `RateLimitError` (429). Each response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` (window reset, epoch seconds). Defaults: 100 requests per 60 000 ms, keyed by `req.ip` — combine with `TRUST_PROXY: true` behind a reverse proxy so the real client IP is used. The store is in-memory: appropriate for single-instance deployments; multi-instance setups should use a shared store via a plugin.
- Attach it per route with `.middleware(...)`, or globally via `app.express.use(rateLimitMiddleware(...))` before `start()`.

### Complete Example

```typescript
import { WebApplication, BaseController, rateLimitMiddleware } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

class SearchController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/search')
        .middleware(rateLimitMiddleware({ maxRequests: 30, windowMs: 60_000 }))
        .handle(async (req, res) => {
          const query = typeof req.query.q === 'string' ? req.query.q : '';
          this.ok(res, { query, results: [] });
        }),

      this.route()
        .post('/login')
        .middleware(
          rateLimitMiddleware({
            maxRequests: 5,
            windowMs: 5 * 60_000,
            message: 'Too many login attempts, try again later',
          })
        )
        .handle(async (_req, res) => {
          this.ok(res, { authenticated: true });
        }),
    ];
  }
}

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'production',
  TRUST_PROXY: true, // req.ip reflects the client behind a reverse proxy
  CORS: {
    origin: ['https://app.example.com'],
    credentials: true,
    maxAge: 7200,
  },
});

app.registerController('/api', SearchController);

const shutdown = await app.start();
// Every response: Helmet headers, no X-Powered-By, CORS headers for allowed origins
// GET /api/search → X-RateLimit-Limit: 30, X-RateLimit-Remaining: 29, X-RateLimit-Reset: <epoch s>
// 31st request in the window → 429 RATE_LIMIT_EXCEEDED
// Disallowed Origin → no Access-Control-Allow-Origin header
```

### Key Methods & Properties

| Name | Signature | Description |
|------|-----------|-------------|
| `rateLimitMiddleware` | `rateLimitMiddleware(options?: RateLimitOptions)` | Returns Express middleware enforcing the fixed-window limit. |
| `maxRequests` | `number` (default `100`) | Maximum requests per window, per key. |
| `windowMs` | `number` (default `60000`) | Window duration in milliseconds. |
| `keyExtractor` | `(req: Request) => string` (default: `req.ip`) | Derives the counter key — for example an API key header or user ID. |
| `message` | `string` | Message carried by the thrown `RateLimitError`. |

- Rate limit headers: `X-RateLimit-Limit` (max per window), `X-RateLimit-Remaining` (left in the window), `X-RateLimit-Reset` (reset time, epoch seconds).
- CORS (via `ApplicationSettings`): `CORS: false` off, `CORS: true` allow-all, or `CorsConfig` with `origin`, `methods`, `allowedHeaders`, `exposedHeaders`, `credentials`, `maxAge`.
- Helmet (automatic): security headers on every response; `X-Powered-By` removed.

---

## Static Files and SPA

### What It Is

`staticFilesPlugin()` serves a directory of files over HTTP and, in SPA mode, makes client-side-routed single-page applications work: unmatched browser navigations receive `index.html` while API routes, health checks, and file requests keep behaving normally. It is a typed wrapper around Express's built-in `express.static()` — zero additional dependencies.

### How It Works

- The factory returns a `PluginDefinition` for `app.use()`, named `static-files` — or `static-files:<prefix>` when a custom prefix is set, so multiple instances stay distinguishable. Default install priority is `20` (before most plugins). Registering two instances with the same prefix throws.
- `root` is resolved against `process.cwd()` and validated at install time: a missing directory aborts `app.start()` with `Static files root directory does not exist: <resolved path>` instead of silently serving nothing.
- Files are served under `prefix` (default `/`). `maxAge` accepts a duration string (`'1d'`, `'1h'`) or milliseconds and becomes the `Cache-Control` `max-age`; `immutable` adds the `immutable` directive for hashed filenames. `dotfiles` controls dotfile access (`'ignore'`, `'allow'`, `'deny'`), and `index` sets the directory index (default `'index.html'`).
- With `spa: true`, the plugin registers a `terminal` hook — mounted after controllers and `/health`, before the 404 handler (see [Plugin System](#plugin-system)). A request triggers the fallback only when: it is a `GET`, its path does not look like a file request (no extension in the last segment), and its `Accept` header includes HTML. Everything else falls through to 404 — so `/api/data` with `Accept: application/json` is never answered with HTML.
- Because terminals run after controller routes, a controller like `GET /api/oidc/login` is never shadowed by the SPA fallback, even for browser navigation requests.

### Complete Example

```typescript
import { WebApplication, BaseController, staticFilesPlugin } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

class ProfileController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/profile')
        .handle(async (_req, res) => {
          this.ok(res, { name: 'Ada' });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

// SPA frontend: client-side routes fall back to index.html.
// The directory must exist when the app starts.
app.use(staticFilesPlugin({
  root: './client/build',
  spa: true,
  maxAge: '1h',
}));

// Versioned assets at /static with long-lived immutable caching
app.use(staticFilesPlugin({
  root: './public/assets',
  prefix: '/static',
  maxAge: '1y',
  immutable: true,
}));

app.registerController('/api', ProfileController);

const shutdown = await app.start();
// GET /api/profile      → controller JSON (the SPA fallback never shadows it)
// GET /                 → ./client/build/index.html
// GET /settings/profile → ./client/build/index.html (SPA fallback)
// GET /static/logo.svg  → ./public/assets/logo.svg with long-lived immutable Cache-Control
// GET /missing.css      → 404 (file request — no SPA fallback)
```

### Key Methods & Properties

| Name | Signature | Description |
|------|-----------|-------------|
| `staticFilesPlugin` | `staticFilesPlugin(config: StaticFilesConfig): PluginDefinition` | Creates the plugin; pass it to `app.use()`. |
| `root` | `string` (required) | Directory to serve, resolved against `process.cwd()`; must exist at startup. |
| `prefix` | `string` (default `'/'`) | URL mount point. |
| `maxAge` | `string \| number` (default `0`) | `Cache-Control` max-age (`'1d'`, `'1h'`, or milliseconds). |
| `immutable` | `boolean` (default `false`) | Adds the `immutable` directive for hashed filenames. |
| `dotfiles` | `'ignore' \| 'allow' \| 'deny'` (default `'ignore'`) | Dotfile policy. |
| `index` | `string \| false` (default `'index.html'`) | Directory index file; `false` disables directory indexing. |
| `etag` | `boolean` (default `true`) | ETag generation. |
| `lastModified` | `boolean` (default `true`) | `Last-Modified` header. |
| `spa` | `boolean` (default `false`) | Enables the terminal-phase SPA fallback for unmatched HTML navigations. |
| `priority` | `number` (default `20`) | Plugin install priority. |

---

# webafx Basic Usage

This guide takes you from installation to a running WebAFX application: booting the server, defining controllers and routes, reading request data, validating input with Zod, registering services, securing routes, extending the framework with plugins, and handling errors consistently.

---

## Installation

Install the package together with its peer dependencies, `express` 5 and `zod` 4:

```bash
# npm
npm install blendsdk/webafx express zod

# yarn
yarn add blendsdk/webafx express zod
```

**Requirements**

| Requirement | Value |
|-------------|-------|
| Node.js | `>= 22.0.0` |
| TypeScript | 5.x, strict mode |
| Module system | ESM only — set `"type": "module"` in `package.json` and `"module": "NodeNext"` in `tsconfig.json` |
| `express` (peer) | `^5.0.0` |
| `zod` (peer) | `^4.0.0` |

Install `express` and `zod` explicitly in your project so a single copy of each is shared with WebAFX. The package has no CommonJS entry point — `require()` is not supported.

---

## Quick Start

The smallest useful application boots a managed HTTP server with a built-in health endpoint:

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'development',
});

const shutdown = await app.start();

// The server is now listening:
//   GET http://localhost:3000/health
//   → { "health": true, "timestamp": "2026-01-01T00:00:00.000Z" }

// Call shutdown() — or send SIGINT/SIGTERM — to stop the server gracefully.
```

`start()` only resolves once the server is accepting connections. The next sections add routes, validation, and services on top of this skeleton.

---

## Fundamentals

The following subsections build up a small API step by step. Each one introduces exactly one concept.

### Creating an Application

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'development',
  LOG_LEVEL: 'INFO',
});

const shutdown = await app.start();
```

Key points:

- Each `WebApplication` instance owns its own settings, Express app, and service/plugin/controller registries. There is no global state, so multiple applications can run — or be tested — in the same process without interfering.
- `start()` initializes middleware, installs plugins, mounts controllers, and begins listening. It resolves to a `shutdown()` function that stops the server gracefully; `SIGTERM` and `SIGINT` trigger the same sequence automatically.
- A `GET /health` endpoint is always available and aggregates the health checks of all installed plugins.

For anything the framework does not cover, the `app.express` getter exposes the underlying Express instance before the server starts:

```typescript
// typescript fragment
app.express.use((_req, _res, next) => {
  next(); // custom Express middleware, runs for every request
});
```

### Adding Your First Controller

Controllers extend `BaseController` and implement `routes()`. Routes are declared with the fluent `RouteBuilder` and finalized with `.handle()`:

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
app.registerController('/api', GreetingController);

await app.start();

// GET http://localhost:3000/api/greeting
// → { "success": true, "data": { "message": "Hello from WebAFX" } }
```

- The full URL is the controller's base path plus the route path: `/api` + `/greeting` = `/api/greeting`.
- `routes()` runs once at startup and returns one `RouteDefinition` per endpoint.
- `.handle()` must be the last call in the chain. Handlers may be async; throwing inside them is how failures are reported (see [Error Handling](#error-handling)).
- The framework constructs every controller for you, passing `(settings, services)` to the constructor — never instantiate controllers yourself.

A controller typically serves multiple endpoints. Every HTTP verb has a builder method, and paths support Express `:param` placeholders:

```typescript
import { BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class ItemController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/items')
        .handle(async (_req: Request, res: Response) => {
          this.ok(res, { items: [] });
        }),

      this.route()
        .get('/items/:id')
        .handle(async (req: Request, res: Response) => {
          this.ok(res, { id: req.params.id, name: 'Sample item' });
        }),

      this.route()
        .post('/items')
        .handle(async (_req: Request, res: Response) => {
          this.created(res, { id: 1, name: 'New item' });
        }),
    ];
  }
}
```

### Reading Request Data

Raw Express access works as usual — `req.params` for path placeholders, `req.query` for the query string, `req.body` for the parsed payload:

```typescript
import { BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class ItemController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/items/:id')
        .handle(async (req: Request, res: Response) => {
          const { id } = req.params; // always a string
          const { filter } = req.query; // query string value(s)

          this.ok(res, { id, filter: filter ?? null });
        }),
    ];
  }
}
```

All URL-sourced values arrive as strings (or arrays of strings). For typed, structured access to the three input sources, use the per-request service container attached to every request as `req.services`:

```typescript
// typescript fragment
this.route()
  .post('/items/:id')
  .handle(async (req: Request, res: Response) => {
    const input = req.services.getInput<{
      params: { id: string };
      query: { sort: string };
      body: { name: string; price: number };
    }>();

    this.created(res, {
      id: input.params.id,
      sort: input.query.sort,
      ...input.body,
    });
  });
```

- `req.services.getInput<T>()` returns the three sources separated — a body field can never shadow a route param.
- `req.services.getParams<T>()` returns a merged view (`{ ...params, ...query, ...body }`). When the route declares a validation schema, this returns the validated (and coerced) data instead.

### Sending Responses

Use the controller's response helpers so every client sees the same envelope instead of hand-rolled `res.json` calls:

| Helper | Status | Response body |
|--------|--------|---------------|
| `this.ok(res, data)` | 200 | `{ success: true, data }` |
| `this.created(res, data)` | 201 | `{ success: true, data }` |
| `this.paginated(res, data, total, page, limit)` | 200 | `{ success: true, data, pagination: { total, page, limit, pages } }` |
| `this.noContent(res)` | 204 | *(empty body)* |

```typescript
import { BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class ReportController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/reports')
        .handle(async (req: Request, res: Response) => {
          const page = Number(req.query.page ?? 1);
          const limit = Number(req.query.limit ?? 50);
          const reports = [{ id: 'r-1', title: 'Monthly summary' }];

          this.paginated(res, reports, 150, page, limit);
          // → {
          //     "success": true,
          //     "data": [{ "id": "r-1", "title": "Monthly summary" }],
          //     "pagination": { "total": 150, "page": 1, "limit": 50, "pages": 3 }
          //   }
        }),
    ];
  }
}
```

`this.paginated()` computes `pages` for you as `ceil(total / limit)`.

### Validating Input with Zod

Attach a Zod schema with `.validate()`. The framework merges `params`, `query`, and `body` into a single object, validates it before the handler runs, and hands you the parsed result:

```typescript
import { BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';
import { z } from 'zod';

const createItemSchema = z.object({
  name: z.string().min(1).max(100),
  price: z.number().positive(),
  tags: z.array(z.string()).optional(),
});

class ItemController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .post('/items')
        .validate(createItemSchema)
        .handle(async (req: Request, res: Response) => {
          const input = req.services.getParams<z.infer<typeof createItemSchema>>();
          this.created(res, { id: 1, ...input });
        }),
    ];
  }
}
```

- On success, the coerced values are available via `req.services.getParams<T>()`.
- On failure, the handler is skipped and the client receives a `422` `VALIDATION_ERROR` with `details` describing each failed field.
- Use `z.coerce` for path and query values, which arrive as strings:

```typescript
// typescript fragment
const itemIdSchema = z.object({ id: z.coerce.number().int().positive() });

this.route()
  .get('/items/:id')
  .validate(itemIdSchema)
  .handle(async (req: Request, res: Response) => {
    const { id } = req.services.getParams<{ id: number }>();
    this.ok(res, { id }); // id is a number, converted from the URL string
  });
```

### Registering Services

Register services on the application and resolve them inside handlers through the request's container. Singleton services are created once and shared across all requests:

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface UserRepository {
  findById(id: string): Promise<{ id: string; name: string }>;
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

app.registerService({
  name: 'user-repository',
  type: 'singleton',
  factory: (): UserRepository => ({
    async findById(id: string) {
      return { id, name: 'Ada Lovelace' };
    },
  }),
});

class UserController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/users/:id')
        .handle(async (req: Request, res: Response) => {
          const repository = await req.services.get<UserRepository>('user-repository');
          const user = await repository.findById(req.params.id);

          this.ok(res, user);
        }),
    ];
  }
}

app.registerController('/api', UserController);

await app.start();
```

Per-request services receive the full request context and are created fresh for every request:

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { ApplicationSettings, ServiceContainer } from 'blendsdk/webafx';
import type { Request } from 'express';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

app.registerService({
  name: 'request-info',
  type: 'per-request',
  factory: (_container: ServiceContainer, _settings: ApplicationSettings, req: Request) => ({
    receivedAt: new Date().toISOString(),
    userAgent: req.headers['user-agent'] ?? 'unknown',
  }),
});
```

Key points:

- `type: 'singleton'` — one instance per application, shared across requests, optional `dispose(instance)` hook runs at shutdown.
- `type: 'per-request'` — a new instance per request; the factory receives `(container, settings, req, res, next)`. Resolving one outside request handling throws.
- `dependencies: ['other-service']` resolves other services before the factory runs; circular chains throw `Circular dependency detected: a -> b -> a`.
- `await req.services.get('name', defaultValue)` returns the default instead of throwing when the service is not registered.
- Duplicate service names on the same application are rejected with `Service "name" is already registered`.

### Securing Routes

Mark a route with `.secure()` to require an authenticated principal. The principal is resolved from the container service named `'user'` by default — normally supplied by an authentication plugin or your own per-request service. Use `.authorize()` to add a per-route permission check:

```typescript
import { BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class AccountController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/public')
        .handle(async (_req: Request, res: Response) => {
          this.ok(res, { public: true });
        }),

      this.authenticated()
        .get('/me')
        .handle(async (req: Request, res: Response) => {
          const user = req.services.getUser<{ id: string; email: string }>();
          this.ok(res, { user });
        }),

      this.route()
        .get('/admin/stats')
        .secure()
        .authorize((_req: Request, user: { role?: string }) => user.role === 'admin')
        .handle(async (_req: Request, res: Response) => {
          this.ok(res, { stats: { users: 42 } });
        }),
    ];
  }
}
```

- `this.authenticated()` is shorthand for `this.route().secure()`; both resolve the default `'user'` principal.
- `.secure('client')` (or `this.authenticated('client')`) selects a different principal service — useful when one application serves multiple caller types.
- No principal present → `401 UNAUTHORIZED` before the handler runs. An `authorize` callback returning `false` → `403 FORBIDDEN`.
- Access the resolved principal in handlers with the synchronous `req.services.getUser<T>()`.

### Extending with Plugins

Plugins package cross-cutting middleware, health checks, and cleanup. Register them with `app.use()` before `start()`:

```typescript
import { WebApplication, staticFilesPlugin } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

app.use({
  name: 'request-timer',
  priority: 50,
  factory: async ({ express, logger }) => {
    express.use((req, res, next) => {
      const startedAt = Date.now();

      res.on('finish', () => {
        void logger.info(`${req.method} ${req.originalUrl}`, {
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
        });
      });

      next();
    });

    return {
      health: async () => true,
      shutdown: async () => {
        await logger.info('request-timer shut down');
      },
    };
  },
});

app.use(staticFilesPlugin({
  root: './public',
  prefix: '/static',
  maxAge: '1d',
}));

await app.start();
```

**`PluginDefinition` fields**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | — (required) | Unique plugin name; duplicates throw `Plugin "name" is already registered`. |
| `priority` | `number` | `100` | Install order — lower numbers install first. Equal priorities keep registration order. |
| `factory` | `async ({ app, express, logger }) => Plugin \| void` | — (required) | Runs during startup; mount middleware on `express` here. `logger` is scoped to the plugin. |

The object returned by a factory may provide:

- `health(): Promise<boolean>` — aggregated by the built-in `GET /health` endpoint.
- `shutdown(): Promise<void>` — called during graceful shutdown, in install order.
- `terminal({ app, express, logger })` — mounts catch-all middleware **after** controllers and `/health`, but **before** the 404 handler, so it cannot shadow real routes.

The bundled `staticFilesPlugin()` uses the terminal phase for its SPA fallback:

```typescript
// typescript fragment
app.use(staticFilesPlugin({ root: './client/dist', spa: true }));
```

With `spa: true`, unmatched HTML navigations get `index.html` while API routes and `/health` keep working. The plugin validates that `root` exists at startup and fails fast otherwise.

### Lifecycle Events

React to application startup and shutdown with lifecycle hooks. Hooks may be async, may be registered multiple times per event, and run in registration order:

```typescript
import { ConsoleLogger, WebApplication } from 'blendsdk/webafx';

const logger = new ConsoleLogger('BOOT', 'INFO');

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

app
  .on('beforeStart', async () => {
    await logger.info('Running startup tasks');
  })
  .on('afterStart', async () => {
    await logger.info('Server is accepting connections');
  })
  .on('beforeShutdown', async () => {
    await logger.info('Starting graceful shutdown');
  })
  .on('afterShutdown', async () => {
    await logger.info('Shutdown complete');
  });

const shutdown = await app.start();
await shutdown();
```

| Event | Fires |
|-------|-------|
| `beforeStart` | Before plugins are installed and before the server starts |
| `afterStart` | After the server is accepting connections |
| `beforeShutdown` | When shutdown begins, before plugins and services are torn down |
| `afterShutdown` | After plugins and services have been fully shut down |

`SIGTERM` and `SIGINT` trigger the same shutdown sequence automatically, and the function returned by `start()` is safe to call more than once.

---

## Configuration

Configuration is a plain object passed to the `WebApplication` constructor. Provide `PORT` to control where the server listens — everything else is optional and has sensible defaults:

```typescript
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'production',
  LOG_LEVEL: 'WARN',
  TRUST_PROXY: true,
  BODY_LIMIT: '1mb',
  SHUTDOWN_TIMEOUT: 10,
  CORS: {
    origin: ['https://app.example.com', 'https://admin.example.com'],
    credentials: true,
    maxAge: 3600,
  },
});
```

**Common options**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `PORT` | `number` | — | TCP port for the HTTP server (0–65535). `0` binds a random free port — useful in tests. |
| `ENV_MODE` | `'production' \| 'development' \| 'test'` | `'production'` | Runtime mode. Outside production, unknown errors expose their real message and stack trace. |
| `LOG_LEVEL` | `'ERROR' \| 'WARN' \| 'INFO' \| 'DEBUG'` | `'ERROR'` | Minimum level the console logger emits. Use `INFO` or `DEBUG` during development. |
| `DEBUG` | `boolean` | `false` | Enables debug mode; raises logging to `DEBUG` when `LOG_LEVEL` is not set. |
| `TRUST_PROXY` | `boolean` | `false` | Trust `X-Forwarded-*` headers — enable when running behind a reverse proxy or load balancer. |
| `BODY_LIMIT` | `string` | Express default (`'100kb'`) | Maximum request body size passed to the body parser, e.g. `'1mb'`. |
| `SHUTDOWN_TIMEOUT` | `number` | — | Graceful shutdown timeout in seconds (0–300) for draining in-flight connections. |
| `CORS` | `boolean \| CorsConfig` | — | `false` disables CORS, `true` enables permissive defaults, or pass a `CorsConfig` object for full control. |

**`CorsConfig` fields**

| Field | Type | Description |
|-------|------|-------------|
| `origin` | `string \| string[] \| (origin, callback) => void` | Allowed origin(s) or a dynamic callback |
| `methods` | `string[]` | Allowed HTTP methods for preflight responses |
| `allowedHeaders` | `string[]` | Headers the client may send |
| `exposedHeaders` | `string[]` | Headers the browser may read from the response |
| `credentials` | `boolean` | Allow cookies and `Authorization` headers |
| `maxAge` | `number` | Preflight cache duration in seconds |

Read configuration values inside controllers through `this.settings`. Custom properties pass through validation and are fully supported:

```typescript
import { BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class InfoController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/info')
        .handle(async (_req: Request, res: Response) => {
          this.ok(res, {
            envMode: this.settings.get<string>('ENV_MODE', 'production'),
            isProduction: this.settings.isProduction(),
            maxUploadMb: this.settings.get<number>('MAX_UPLOAD_MB', 10),
          });
        }),
    ];
  }
}
```

```typescript
// typescript fragment
const app = new WebApplication({
  PORT: 3000,
  MAIL_HOST: 'smtp.example.com', // custom properties pass through
  MAIL_PORT: 587,
});
```

Additional notes:

- Configuration is validated with Zod at construction. Invalid values (for example `PORT: -1`, `ENV_MODE: 'staging'`, or `LOG_LEVEL: 'TRACE'`) throw an error starting with `Configuration validation failed:` followed by one line per invalid field.
- WebAFX treats configuration as explicit input: it does not read from or mutate `process.env`. Only the console logger honors `LOG_LEVEL` and `DEBUG` environment variables as fallbacks.
- `ApplicationSettings` (exported publicly) also supports loading additional values from a JavaScript configuration file via `loadFromFile()` — e.g. `.env.local.js` — re-validating after loading.
- Need structured JSON logs instead of human-readable lines? Replace the logger before `start()`:

```typescript
import { StructuredLogger, WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production', LOG_LEVEL: 'INFO' });

app.setLogger(new StructuredLogger('APP', 'INFO'));
```

---

## Error Handling

WebAFX catches every error thrown during request handling — in route handlers, route middleware, or plugin middleware — logs it, and renders one standard JSON envelope. Typed `ApiError` instances keep their status code and message; anything else becomes a `500`.

### Throwing typed errors

```typescript
import { BaseController, ConflictError, NotFoundError, WebApplication } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface Report {
  id: string;
  title: string;
}

const reports = new Map<string, Report>([
  ['r-1', { id: 'r-1', title: 'Monthly summary' }],
]);

const publishedReports = new Set<string>();

async function publishReport(report: Report): Promise<void> {
  if (publishedReports.has(report.id)) {
    throw new Error('Report already published');
  }
  publishedReports.add(report.id);
}

class ReportController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/reports/:id')
        .handle(async (req: Request, res: Response) => {
          const report = reports.get(req.params.id);

          if (!report) {
            throw new NotFoundError('Report not found', { reportId: req.params.id });
          }

          this.ok(res, report);
        }),

      this.route()
        .post('/reports/:id/publish')
        .handle(async (req: Request, res: Response) => {
          const report = reports.get(req.params.id);

          if (!report) {
            throw new NotFoundError('Report not found');
          }

          try {
            await publishReport(report);
          } catch (error) {
            if (error instanceof Error && error.message === 'Report already published') {
              throw new ConflictError('Report has already been published');
            }
            // Anything unrecognized bubbles up and becomes a 500
            throw error;
          }

          this.ok(res, { published: true });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api', ReportController);
await app.start();
```

### The error response envelope

Every failure — including the automatic `404` for unknown routes — uses this shape:

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Report not found",
    "statusCode": 404,
    "timestamp": "2026-01-01T00:00:00.000Z",
    "requestId": "9c5f5c0e-6e62-4e33-8a58-2d0b8b7f3f1e",
    "path": "/api/reports/missing",
    "details": { "reportId": "missing" }
  }
}
```

- `details` is present only when the error carries them.
- `stack` is present only outside production.
- `requestId` matches the `X-Request-ID` response header, so clients and logs can be correlated.

### Built-in error types

All built-in errors extend `ApiError` and accept `(message?, details?)` in their constructor. `ApiError` itself takes `(statusCode, code, message, details?)`.

| Error class | Status | Code | Meaning |
|-------------|--------|------|---------|
| `BadRequestError` | 400 | `BAD_REQUEST` | Malformed or invalid request |
| `UnauthorizedError` | 401 | `UNAUTHORIZED` | Authentication missing or failed |
| `ForbiddenError` | 403 | `FORBIDDEN` | Authenticated, but not permitted |
| `NotFoundError` | 404 | `NOT_FOUND` | The requested resource does not exist |
| `ConflictError` | 409 | `CONFLICT` | Request conflicts with current state (e.g. duplicates) |
| `ValidationError` | 422 | `VALIDATION_ERROR` | Input failed validation — thrown automatically by `.validate()` |
| `RateLimitError` | 429 | `RATE_LIMIT_EXCEEDED` | Thrown by `rateLimitMiddleware()` when a client exceeds its quota |
| `InternalServerError` | 500 | `INTERNAL_SERVER_ERROR` | Unexpected failure — also the fallback for every non-`ApiError` |
| `ServiceUnavailableError` | 503 | `SERVICE_UNAVAILABLE` | Temporarily unavailable or under maintenance |

For domain-specific failures, construct an `ApiError` directly:

```typescript
import { ApiError } from 'blendsdk/webafx';

throw new ApiError(402, 'PAYMENT_REQUIRED', 'Subscription expired', {
  plan: 'free',
  renewUrl: '/billing/renew',
});
```

### Production vs. development behavior

- `ENV_MODE: 'production'` (the default): unknown errors respond with `500` and the generic message `Internal Server Error`, without a stack trace. The real error is still passed to the logger.
- `ENV_MODE: 'development'`: unknown errors include the real message and stack trace for debugging.
- Typed `ApiError` responses always keep their status, code, message, and `details` in every mode — they are safe to expose by design.
- Invalid configuration throws synchronously at construction, and duplicate plugin/service names throw at registration or startup — both fail fast rather than at request time.

### Guidelines

- Throw `ApiError` subclasses instead of building error payloads with `res.status(...).json(...)` — the error handler keeps every response consistent.
- Wrap calls in `try/catch` only when you can translate the failure (like the `ConflictError` above) or add context; otherwise rethrow and let the framework render it.
- Validation failures (`422`) and authentication failures (`401`/`403`) are raised by the framework itself — you never need to handle them manually.
- Use `getRequestId()` from `blendsdk/webafx` anywhere in the async call chain to attach the current request's correlation ID to your own logs; it returns `undefined` outside request handling.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
