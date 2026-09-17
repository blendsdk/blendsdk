> **Package**: `blendsdk/webafx`

# webafx API Reference

Complete reference for every public symbol exported from the package root (`src/index.ts`): classes, functions, interfaces, types, and constants. Signatures match the package's TypeScript declarations; examples use ESM imports and are runnable under Node.js >= 22.

---

## API at a Glance

| Symbol | Kind | Summary |
| --- | --- | --- |
| `WebApplication` | Class | Application entry point: owns Express, configuration, registries, and lifecycle. |
| `ApplicationSettings` | Class | Zod-validated application configuration with file loading. |
| `ApplicationConfig` | Interface | Typed shape of standard configuration properties. |
| `CorsConfig` | Interface | CORS configuration options. |
| `BaseController` | Abstract class | Controller base with route builder and response helpers. |
| `StandardSuccessResponse<T>` | Interface | `{ success: true, data }` success envelope. |
| `PaginatedResponse<T>` | Interface | Success envelope with pagination metadata. |
| `RouteBuilder` | Class | Fluent builder producing `RouteDefinition` objects. |
| `RouteDefinition` | Interface | Final, complete route configuration. |
| `OpenAPIRouteMetadata` | Interface | Opt-in OpenAPI metadata for a route. |
| `OpenAPIResponseDefinition` | Interface | Response metadata for OpenAPI documentation. |
| `ResponseEnvelope` | Type | How a generated client reads a successful response body: `'data'` or `'body'`. |
| `HttpMethod` | Type | Supported route verbs. |
| `RouteHandler` | Type | Express handler signature used by routes. |
| `AuthorizeFunction<T>` | Type | Per-route authorization callback. |
| `ServiceContainer` | Class | Dependency-injection container (singletons + per-request services). |
| `ServiceDefinition<T>` | Interface | Blueprint for a service. |
| `ServiceRegistry` | Interface | Shared definitions and singleton cache for one application. |
| `SingletonFactory<T>` | Type | Factory signature for application-scoped services. |
| `PerRequestFactory<T>` | Type | Factory signature for request-scoped services. |
| `Plugin` | Interface | Plugin contract: `health`, `shutdown`, `terminal`. |
| `PluginDefinition` | Interface | Plugin registration: name, factory, priority. |
| `PluginTerminalParams` | Interface | Parameters passed to a plugin's `terminal` hook. |
| `PluginRegistry` | Class | Internal registry that installs and manages plugins. |
| `staticFilesPlugin` | Function | Factory for static file serving with optional SPA fallback. |
| `StaticFilesConfig` | Interface | Static files plugin configuration. |
| `rateLimitMiddleware` | Function | In-memory rate limiting middleware. |
| `RateLimitOptions` | Interface | Rate limiter configuration options. |
| `RequestContext` | Interface | Request-scoped context data (request ID, start time, custom keys). |
| `requestContextStorage` | Constant | Shared `AsyncLocalStorage` store for request context. |
| `getRequestContext` | Function | Returns the current request context. |
| `getRequestId` | Function | Returns the current request ID. |
| `preparseServiceNames` | Function (deprecated) | Legacy helper; use `as const` objects instead. |
| `Logger` | Interface | Common logging contract implemented by all loggers. |
| `LogLevel` | Type | `'ERROR' \| 'WARN' \| 'INFO' \| 'DEBUG'`. |
| `ConsoleLogger` | Class | Human-readable console logger. |
| `StructuredLogger` | Class | Single-line JSON logger. |
| `ApiError` | Class | Base class for typed HTTP errors. |
| `StandardErrorResponse` | Interface | Uniform error envelope. |
| `BadRequestError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `ValidationError`, `RateLimitError`, `InternalServerError`, `ServiceUnavailableError` | Classes | Typed HTTP error subclasses of `ApiError`. |

---

## Application

### WebApplication

The central class of the framework. A `WebApplication` instance owns its Express application, `ApplicationSettings`, service registry, plugin registry, controller registry, and HTTP server lifecycle. There is no global state — separate instances are fully isolated, which makes parallel testing straightforward.

```typescript fragment
class WebApplication {
  constructor(config?: ApplicationConfig);

  get express(): Express;

  getSettings(): ApplicationSettings;
  registerService(definition: ServiceDefinition): void;
  registerController(
    basePath: string,
    ControllerClass: new (settings: ApplicationSettings, services: ServiceContainer) => BaseController
  ): void;
  use(plugin: PluginDefinition): void;
  on(
    event: 'beforeStart' | 'afterStart' | 'beforeShutdown' | 'afterShutdown',
    handler: () => void | Promise<void>
  ): this;
  setLogger(logger: Logger): void;
  start(): Promise<() => Promise<void>>;
}
```

**Constructor parameters**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `config` | `ApplicationConfig` | No | `{}` | Initial configuration passed to `ApplicationSettings`. `ENV_MODE` defaults to `'production'`. |

**Properties**

| Property | Type | Description |
| --- | --- | --- |
| `express` | `Express` | Read-only getter for the underlying Express application instance. Identical before and after `start()`; use it to mount additional middleware or non-WebAFX routes. |

**Methods**

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `getSettings` | `getSettings(): ApplicationSettings` | `ApplicationSettings` | Returns the application's settings instance. |
| `registerService` | `registerService(definition: ServiceDefinition): void` | `void` | Registers a service definition with the application's service registry. Duplicate service names are rejected with an error. |
| `registerController` | `registerController(basePath: string, ControllerClass: new (settings: ApplicationSettings, services: ServiceContainer) => BaseController): void` | `void` | Registers a controller class under a base path; its routes are mounted during `start()`. Pass `''` to mount at the root. |
| `use` | `use(plugin: PluginDefinition): void` | `void` | Registers a plugin. Throws `Plugin "<name>" is already registered` when the name is taken. |
| `on` | `on(event: 'beforeStart' \| 'afterStart' \| 'beforeShutdown' \| 'afterShutdown', handler: () => void \| Promise<void>): this` | `this` | Registers a lifecycle hook. Chainable. |
| `setLogger` | `setLogger(logger: Logger): void` | `void` | Replaces the default `ConsoleLogger`. Log calls after this point use the new logger; the last call wins. Used by logger plugins (e.g., a Pino-backed plugin). |
| `start` | `start(): Promise<() => Promise<void>>` | `Promise<() => Promise<void>>` | Boots the application and returns an idempotent `shutdown()` function. Throws `Application already started` when called on a running instance. |

**Lifecycle hooks**

| Event | Fired when |
| --- | --- |
| `'beforeStart'` | Before plugins install and before the server starts listening. |
| `'afterStart'` | After the HTTP server is listening. |
| `'beforeShutdown'` | At the beginning of shutdown. |
| `'afterShutdown'` | After plugins and services have been shut down. |

Multiple hooks per event run in registration order; async hooks are awaited.

**Lifecycle summary**

1. Startup: `beforeStart` hooks → plugin factories (priority order, lower first) → controllers and `GET /health` → plugin terminal hooks → server listens → SIGTERM/SIGINT handlers registered → `afterStart` hooks.
2. Shutdown (via the returned function or a signal): `beforeShutdown` hooks → server stops accepting connections and drains in-flight requests (up to `SHUTDOWN_TIMEOUT` seconds) → plugin `shutdown` hooks and service disposers → `afterShutdown` hooks → signal handlers removed.

```typescript
import { BaseController, WebApplication } from 'blendsdk/webafx';
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

app.on('afterStart', () => {
  console.log('Server is ready');
});

const shutdown = await app.start();
// GET http://localhost:3000/api/greeting
//   → { "success": true, "data": { "message": "Hello from WebAFX" } }
// GET http://localhost:3000/health
//   → { "health": true, "timestamp": "..." }

// Stop programmatically — SIGTERM/SIGINT trigger the same path.
await shutdown();
```

---

### ApplicationSettings

Manages application configuration with Zod validation. Configuration can be supplied as a constructor object and/or loaded from a JavaScript configuration file. `process.env` is never mutated — the configuration object is the single source of truth.

```typescript fragment
class ApplicationSettings {
  constructor(config?: ApplicationConfig, logger?: ConsoleLogger);

  loadFromFile(jsPath: string): Promise<void>;
  getAll<T extends ApplicationConfig>(): T;
  get<T = any>(key: keyof ApplicationConfig, defaultValue?: T): T;
  isProduction(): boolean;
}
```

**Constructor parameters**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `config` | `ApplicationConfig` | No | `{}` | Initial configuration. `ENV_MODE` defaults to `'production'` (secure by default). Validated immediately when provided. |
| `logger` | `ConsoleLogger` | No | `new ConsoleLogger('Settings')` | Logger used for configuration loading messages. |

**Methods**

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `loadFromFile` | `loadFromFile(jsPath: string): Promise<void>` | `Promise<void>` | Loads configuration from a JavaScript file via dynamic `import()`. Supports a default export or a named `config` export. Silently returns when the path is empty or the file does not exist; throws `Configuration file error: <path>` when the file exists but cannot be loaded or parsed. |
| `getAll` | `getAll<T extends ApplicationConfig>(): T` | `T` | Returns a shallow copy of the configuration (mutating the copy does not affect internal state). |
| `get` | `get<T = any>(key: keyof ApplicationConfig, defaultValue?: T): T` | `T` | Returns a configuration value, or the default when the key is not set. |
| `isProduction` | `isProduction(): boolean` | `boolean` | `true` when `ENV_MODE === 'production'`. |

**Behavior notes**

- Validation runs in the constructor (when config is provided) and after every `loadFromFile()`. Failures throw `Configuration validation failed:` followed by one `  - key: message` line per issue.
- After a file load: `ENV_MODE` falls back to `'production'`; `LOG_LEVEL` is normalized — an explicit `LOG_LEVEL` wins, otherwise `'DEBUG'` when `DEBUG === true` or `ENV_MODE !== 'production'`, else `'ERROR'`.
- Keys not defined in the schema are passed through (`.passthrough()`), so custom properties are supported.

```typescript
import { ApplicationSettings } from 'blendsdk/webafx';

const settings = new ApplicationSettings({
  PORT: 3000,
  ENV_MODE: 'development',
  LOG_LEVEL: 'INFO',
});

// Optional: merge values from an ESM config file (silently skipped when missing).
await settings.loadFromFile('.env.local.js');

const port = settings.get<number>('PORT', 4000);
const isProduction = settings.isProduction();
const all = settings.getAll();

console.log(port, isProduction, all.ENV_MODE);
```

---

### ApplicationConfig

Typed shape of the standard configuration properties. Custom properties are allowed via a passthrough index signature.

| Property | Type | Description |
| --- | --- | --- |
| `DEBUG` | `boolean` | Enable debug mode. |
| `ENV_MODE` | `'production' \| 'development' \| 'test'` | Environment mode. Defaults to `'production'`. |
| `LOG_LEVEL` | `'ERROR' \| 'WARN' \| 'INFO' \| 'DEBUG'` | Minimum log level. |
| `PORT` | `number` | Server port — integer between 0 and 65535. |
| `TRUST_PROXY` | `boolean` | Trust proxy headers (for nginx, load balancers). |
| `BODY_LIMIT` | `string` | Request body size limit (e.g., `'1mb'`). |
| `SHUTDOWN_TIMEOUT` | `number` | Graceful shutdown timeout in seconds (0–300). |
| `CORS` | `boolean \| CorsConfig` | `false` disables CORS, `true` enables defaults, object for custom configuration. |
| `[key: string]` | `string \| number \| boolean \| undefined \| any` | Additional custom properties are permitted (`.passthrough()` validation). |

---

### CorsConfig

CORS configuration options used when `ApplicationConfig.CORS` is an object.

| Property | Type | Description |
| --- | --- | --- |
| `origin` | `string \| string[] \| ((origin: string \| undefined, callback: (err: Error \| null, allowed: boolean) => void) => void)` | Allowed origins: a single origin, a list, or a dynamic callback. |
| `methods` | `string[]` | Allowed HTTP methods. |
| `allowedHeaders` | `string[]` | Allowed request headers. |
| `exposedHeaders` | `string[]` | Response headers exposed to the browser. |
| `credentials` | `boolean` | Allow credentials (cookies, authorization headers). |
| `maxAge` | `number` | Preflight cache duration in seconds. |

---

## Controllers

### BaseController

Abstract base class for all controllers. Provides the route builder, authentication shorthand, consistent response envelopes, and access to application settings and services.

```typescript fragment
abstract class BaseController {
  constructor(settings: ApplicationSettings, services: ServiceContainer);

  abstract routes(): RouteDefinition[];

  protected route(): RouteBuilder;
  protected authenticated(userServiceName?: string): RouteBuilder;

  protected ok<T>(res: Response, data: T): void;
  protected created<T>(res: Response, data: T): void;
  protected paginated<T>(
    res: Response,
    data: T[],
    total: number,
    page: number,
    limit: number
  ): void;
  protected noContent(res: Response): void;
}
```

**Constructor parameters**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `settings` | `ApplicationSettings` | Yes | — | Application settings, exposed to subclasses as protected `this.settings`. |
| `services` | `ServiceContainer` | Yes | — | Application-level service container, exposed as protected `this.services`. |

**Methods**

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `routes` | `abstract routes(): RouteDefinition[]` | `RouteDefinition[]` | Must be implemented by every subclass. Called once during `start()` to mount the controller's routes. |
| `route` | `route(): RouteBuilder` | `RouteBuilder` | Creates a new route builder. |
| `authenticated` | `authenticated(userServiceName?: string): RouteBuilder` | `RouteBuilder` | Shorthand for `route().secure(userServiceName)`. Defaults to the `'user'` principal service. |
| `ok` | `ok<T>(res: Response, data: T): void` | `void` | Sends `200` with `{ success: true, data }`. |
| `created` | `created<T>(res: Response, data: T): void` | `void` | Sends `201` with `{ success: true, data }`. |
| `paginated` | `paginated<T>(res: Response, data: T[], total: number, page: number, limit: number): void` | `void` | Sends `200` with a page of items plus `pagination` metadata. `pages` is computed as `Math.ceil(total / limit)`. |
| `noContent` | `noContent(res: Response): void` | `void` | Sends `204` with an empty body. |

```typescript
import { BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

interface Todo {
  id: number;
  title: string;
}

class TodoController extends BaseController {
  private todos: Todo[] = [{ id: 1, title: 'Ship the API reference' }];

  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/todos')
        .handle(async (_req: Request, res: Response) => {
          this.paginated(res, this.todos, this.todos.length, 1, 20);
        }),

      this.route()
        .post('/todos')
        .handle(async (req: Request, res: Response) => {
          const todo: Todo = { id: this.todos.length + 1, title: String(req.body.title) };
          this.todos.push(todo);
          this.created(res, todo);
        }),

      this.route()
        .delete('/todos/:id')
        .handle(async (req: Request, res: Response) => {
          this.todos = this.todos.filter((todo) => todo.id !== Number(req.params.id));
          this.noContent(res);
        }),
    ];
  }
}
```

---

### StandardSuccessResponse

Standard success envelope produced by `ok()`, `created()`, and `paginated()`.

| Property | Type | Description |
| --- | --- | --- |
| `success` | `true` | Always `true`. |
| `data` | `T` | Response payload. |

```typescript fragment
interface StandardSuccessResponse<T = unknown> {
  success: true;
  data: T;
}
```

---

### PaginatedResponse

Paginated success envelope produced by `paginated()`.

| Property | Type | Description |
| --- | --- | --- |
| `success` | `true` | Always `true`. |
| `data` | `T[]` | Items on the current page. |
| `pagination.total` | `number` | Total number of items across all pages. |
| `pagination.page` | `number` | Current page (1-indexed). |
| `pagination.limit` | `number` | Items per page. |
| `pagination.pages` | `number` | Total number of pages (`Math.ceil(total / limit)`). |

```typescript fragment
interface PaginatedResponse<T = unknown> {
  success: true;
  data: T[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
}
```

---

## Routing

### RouteBuilder

Fluent builder for defining HTTP routes. Obtain an instance from `BaseController.route()`, `BaseController.authenticated()`, or by constructing one directly. The chain ends with `handle()`, which validates the definition and returns a `RouteDefinition`.

```typescript fragment
class RouteBuilder {
  get(path: string): this;
  post(path: string): this;
  put(path: string): this;
  patch(path: string): this;
  delete(path: string): this;

  secure(userServiceName?: string): this;
  authorize(authorizeFn: AuthorizeFunction): this;
  middleware(fn: RequestHandler): this;
  openapi(meta: OpenAPIRouteMetadata): this;
  validate<TSchema extends ZodType>(schema: TSchema): RouteBuilder;

  handle(handler: RouteHandler): RouteDefinition;
}
```

**Methods**

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `get` | `get(path: string): this` | `this` | Defines a GET route. |
| `post` | `post(path: string): this` | `this` | Defines a POST route. |
| `put` | `put(path: string): this` | `this` | Defines a PUT route. |
| `patch` | `patch(path: string): this` | `this` | Defines a PATCH route. |
| `delete` | `delete(path: string): this` | `this` | Defines a DELETE route. |
| `secure` | `secure(userServiceName?: string): this` | `this` | Marks the route as requiring authentication. Without a name, the default `'user'` principal service is resolved; with a name, that service is resolved instead. The name is trimmed; a blank name throws `secure() requires a non-empty user service name`. |
| `authorize` | `authorize(authorizeFn: AuthorizeFunction): this` | `this` | Adds an authorization check, executed after authentication. Returning `false` rejects the request with `403`; a missing principal rejects with `401`. |
| `middleware` | `middleware(fn: RequestHandler): this` | `this` | Appends route-level middleware. May be called multiple times; middleware runs in the order added, before the handler. |
| `openapi` | `openapi(meta: OpenAPIRouteMetadata): this` | `this` | Attaches OpenAPI metadata. Routes without this metadata are excluded from generated specs (opt-in). |
| `validate` | `validate<TSchema extends ZodType>(schema: TSchema): RouteBuilder` | `RouteBuilder` | Attaches a Zod schema. The merged `params` + `query` + `body` is validated before the handler runs; failures produce a `422 ValidationError`. |
| `handle` | `handle(handler: RouteHandler): RouteDefinition` | `RouteDefinition` | Finalizes the route. Throws when the handler is not a function, when no method is set (`Route method must be set before calling handle()`), or when no path is set (`Route path must be set before calling handle()`). |

```typescript
import { RouteBuilder } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';

const route: RouteDefinition = new RouteBuilder()
  .get('/users/:id')
  .secure()
  .authorize((_req, user: { id: number }) => user.id > 0)
  .handle(async (_req, res) => {
    res.json({ ok: true });
  });

console.log(route.method); // 'get'
console.log(route.path);   // '/users/:id'
console.log(route.secure); // true
```

---

### RouteDefinition

Complete route configuration produced by `RouteBuilder.handle()`.

| Property | Type | Description |
| --- | --- | --- |
| `method` | `HttpMethod` | HTTP verb. |
| `path` | `string` | Express path (supports `:param` segments). |
| `handler` | `RouteHandler` | Handler function, executed last in the route chain. |
| `validation?` | `ZodType` | Zod schema validating merged `params` + `query` + `body`. |
| `secure?` | `boolean \| string` | `true` resolves the default `'user'` principal; a string resolves that service name (the auth plugin's `userServiceName`, not the provider singleton). Omitted or `false` leaves the route public. A blank value fails closed with `401`. |
| `authorize?` | `AuthorizeFunction` | Authorization check running after authentication. |
| `middleware?` | `RequestHandler[]` | Route-level middleware, executed in order. |
| `openapi?` | `OpenAPIRouteMetadata` | OpenAPI documentation metadata. |

```typescript fragment
interface RouteDefinition {
  method: HttpMethod;
  path: string;
  handler: RouteHandler;
  validation?: ZodType;
  secure?: boolean | string;
  authorize?: AuthorizeFunction;
  middleware?: RequestHandler[];
  openapi?: OpenAPIRouteMetadata;
}
```

---

### OpenAPIRouteMetadata

Optional OpenAPI metadata attached with `.openapi()`. This is pure data — specification generation happens in `blendsdk/codegen`.

| Property | Type | Description |
| --- | --- | --- |
| `summary?` | `string` | Short summary of the route (appears in path listings). |
| `description?` | `string` | Detailed description (supports markdown). |
| `tags?` | `string[]` | Tags for grouping routes (e.g., `'products'`, `'auth'`). |
| `operationId?` | `string` | Unique operation identifier. |
| `deprecated?` | `boolean` | Marks the route as deprecated in the spec. |
| `envelope?` | `ResponseEnvelope` | How a generated client reads the success body. Defaults to `'data'` (unwrap `data`); set `'body'` for a paginated route so the client keeps `pagination`. |
| `pathParams?` | `Record<string, { schema: ZodType; description?: string }>` | Schemas for path parameters not covered by the validation schema. |
| `responses?` | `OpenAPIResponseDefinition[]` | Possible responses from this endpoint. |

```typescript fragment
interface OpenAPIRouteMetadata {
  summary?: string;
  description?: string;
  tags?: string[];
  operationId?: string;
  deprecated?: boolean;
  envelope?: ResponseEnvelope;
  pathParams?: Record<string, { schema: ZodType; description?: string }>;
  responses?: OpenAPIResponseDefinition[];
}
```

---

### OpenAPIResponseDefinition

Describes one possible response of a documented route.

| Property | Type | Description |
| --- | --- | --- |
| `statusCode` | `number` | HTTP status code (e.g., 200, 201, 400, 404). |
| `description` | `string` | Human-readable description of the response. |
| `schema?` | `ZodType` | Optional Zod schema describing the response body. |

```typescript fragment
interface OpenAPIResponseDefinition {
  statusCode: number;
  description: string;
  schema?: ZodType;
}
```

---

### ResponseEnvelope

Controls how a generated client reads the body of a successful response. It is declared per route through `OpenAPIRouteMetadata.envelope` and is carried into the generated OpenAPI document; WebAFX itself does not change the response it sends.

| Value | Client result |
| --- | --- |
| `'data'` (default) | The client returns only `body.data` from the standard `{ success: true, data }` envelope. |
| `'body'` | The client returns the entire body, so a paginated response keeps its `pagination` object. |

Set `'body'` on any route that sends paginated output through `BaseController.paginated()`; with the default, the generated client would return only `data` and silently drop `pagination`.

```typescript fragment
type ResponseEnvelope = 'data' | 'body';
```

---

### HttpMethod

Supported HTTP methods for routes.

| Value | Description |
| --- | --- |
| `'get'` | GET |
| `'post'` | POST |
| `'put'` | PUT |
| `'patch'` | PATCH |
| `'delete'` | DELETE |

```typescript fragment
type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
```

---

### RouteHandler

Handler function signature for route endpoints. May be synchronous or asynchronous.

```typescript fragment
type RouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<void> | void;
```

---

### AuthorizeFunction

Authorization callback run after authentication on secure routes. Receives the principal resolved from the route's principal service.

```typescript fragment
type AuthorizeFunction<T = any> = (req: Request, user: T) => boolean | Promise<boolean>;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `req` | `Request` | Yes | Express request object. |
| `user` | `T` | Yes | Authenticated principal resolved from the route's principal service. |

**Returns**: `boolean | Promise<boolean>` — `true` allows the request; `false` rejects it with `403 Forbidden`.

---

## Dependency Injection

### ServiceContainer

Dependency-injection container managing service lifecycles. Supports `singleton` (application-scoped) and `per-request` services, declared dependencies with ordered resolution and cycle detection, manual overrides, and disposal on shutdown. Each container is bound to a `ServiceRegistry` owned by one `WebApplication` — there is no global state. During HTTP handling, the per-request container is accessible as `req.services`.

```typescript fragment
class ServiceContainer {
  constructor(
    registry: ServiceRegistry,
    settings: ApplicationSettings,
    req?: Request,
    res?: Response,
    next?: NextFunction
  );

  getUser<T = unknown>(): T | undefined;
  getParams<T = unknown>(): T;
  getInput<
    T = {
      params: Record<string, unknown>;
      query: Record<string, unknown>;
      body: Record<string, unknown>;
    }
  >(): T;

  set(name: string, service: unknown): void;
  get<T = unknown>(name: string, defaultValue?: T): Promise<T>;
  registerService(service: ServiceDefinition): void;
  isRegistered(name: string): boolean;
  getRegisteredServices(): string[];
  disposeAll(): Promise<void>;
}
```

**Constructor parameters**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `registry` | `ServiceRegistry` | Yes | — | Shared definitions and singleton cache. |
| `settings` | `ApplicationSettings` | Yes | — | Application settings passed to service factories. |
| `req` | `Request` | No | — | Express request; required for per-request services. |
| `res` | `Response` | No | — | Express response; required for per-request services. |
| `next` | `NextFunction` | No | — | Express next function; required for per-request services. |

**Methods**

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `getUser` | `getUser<T = unknown>(): T \| undefined` | `T \| undefined` | Returns the authenticated principal stored under `'user'`, or `undefined`. |
| `getParams` | `getParams<T = unknown>(): T` | `T` | Returns validated request parameters merged from params, query, and body (`{}` when unset). |
| `getInput` | `getInput<T = { params: Record<string, unknown>; query: Record<string, unknown>; body: Record<string, unknown> }>(): T` | `T` | Returns input sources as separate objects — no key collisions between params, query, and body. |
| `set` | `set(name: string, service: unknown): void` | `void` | Manually sets a service instance in this container (overrides resolved instances). |
| `get` | `get<T = unknown>(name: string, defaultValue?: T): Promise<T>` | `Promise<T>` | Resolves a service. Throws when not registered and no default is provided, on circular dependencies, and when a per-request service is accessed outside request handling. |
| `registerService` | `registerService(service: ServiceDefinition): void` | `void` | Registers a definition. Throws `Service "<name>" is already registered` on duplicates. |
| `isRegistered` | `isRegistered(name: string): boolean` | `boolean` | Whether the service is registered on this container's registry. |
| `getRegisteredServices` | `getRegisteredServices(): string[]` | `string[]` | Names of all registered services. |
| `disposeAll` | `disposeAll(): Promise<void>` | `Promise<void>` | Invokes the `dispose` hook of every instantiated singleton, then clears the singleton cache. |

**Error contracts**

| Condition | Message |
| --- | --- |
| Unregistered service, no default | `Service "<name>" is not registered` |
| Circular dependency | `Circular dependency detected: a -> b -> c -> a` |
| Per-request service without request context | `Service "<name>" is per-request and can only be accessed during HTTP request handling` |
| Duplicate registration | `Service "<name>" is already registered` |

```typescript
import { ApplicationSettings, ServiceContainer } from 'blendsdk/webafx';
import type { ServiceRegistry } from 'blendsdk/webafx';

interface Clock {
  now(): Date;
}

const registry: ServiceRegistry = {
  definitions: {},
  singletons: {},
};

const container = new ServiceContainer(registry, new ApplicationSettings({ ENV_MODE: 'test' }));

container.registerService({
  name: 'clock',
  type: 'singleton',
  factory: (): Clock => ({ now: () => new Date() }),
});

const clock = await container.get<Clock>('clock');
console.log(clock.now());
```

---

### ServiceDefinition

Blueprint for a service registered with a container.

| Property | Type | Description |
| --- | --- | --- |
| `name` | `string` | Unique service name. |
| `factory` | `SingletonFactory<T> \| PerRequestFactory<T>` | Called to create the instance (may be async). |
| `type` | `'singleton' \| 'per-request'` | Lifecycle. Singletons are cached per registry; per-request instances are created for every request. |
| `dependencies?` | `string[]` | Names of services resolved before this one is created. |
| `dispose?` | `(instance: T) => void \| Promise<void>` | Cleanup hook invoked by `disposeAll()` during shutdown. |

```typescript fragment
interface ServiceDefinition<T = unknown> {
  name: string;
  factory: SingletonFactory<T> | PerRequestFactory<T>;
  type: 'singleton' | 'per-request';
  dependencies?: string[];
  dispose?: (instance: T) => void | Promise<void>;
}
```

---

### ServiceRegistry

Per-application registry holding service blueprints and cached singleton instances. Containers created with the same registry share singleton state; different registries are fully isolated.

| Property | Type | Description |
| --- | --- | --- |
| `definitions` | `Record<string, ServiceDefinition>` | Service blueprints. |
| `singletons` | `Record<string, unknown>` | Cached singleton instances. |

```typescript fragment
interface ServiceRegistry {
  definitions: Record<string, ServiceDefinition>;
  singletons: Record<string, unknown>;
}
```

---

### SingletonFactory

Factory invoked once per registry when a singleton service is first resolved.

```typescript fragment
type SingletonFactory<T = unknown> = (
  container: ServiceContainer,
  settings: ApplicationSettings
) => T | Promise<T>;
```

---

### PerRequestFactory

Factory invoked for every HTTP request when a per-request service is resolved. `req`, `res`, and `next` are always provided during request handling — they are required, not optional.

```typescript fragment
type PerRequestFactory<T = unknown> = (
  container: ServiceContainer,
  settings: ApplicationSettings,
  req: Request,
  res: Response,
  next: NextFunction
) => T | Promise<T>;
```

---

## Plugins

### Plugin

A plugin is the optional object returned by a plugin factory. All members are optional.

| Property | Type | Description |
| --- | --- | --- |
| `health?` | `() => Promise<boolean>` | Health check aggregated by `GET /health`. |
| `shutdown?` | `() => Promise<void>` | Cleanup called during application shutdown. |
| `terminal?` | `(params: PluginTerminalParams) => void \| Promise<void>` | Terminal hook — mounts middleware **after** controllers and `/health`, but **before** the 404 handler. Use it for catch-all middleware (e.g., an SPA `index.html` fallback) that must not shadow controller routes. Multiple terminals run in plugin priority order (lower first). |

```typescript fragment
interface Plugin {
  health?: () => Promise<boolean>;
  shutdown?: () => Promise<void>;
  terminal?: (params: PluginTerminalParams) => void | Promise<void>;
}
```

---

### PluginDefinition

Registration object passed to `app.use()`.

| Property | Type | Description |
| --- | --- | --- |
| `name` | `string` | Unique plugin name; duplicates are rejected. |
| `factory` | `(params: { app: WebApplication; express: Express; logger: Logger }) => Promise<Plugin \| void>` | Called during `start()` to create and initialize the plugin. May return a `Plugin` or nothing. |
| `priority?` | `number` | Install order — lower numbers install first. Default: `100`. Plugins with equal priority keep registration order. |

```typescript fragment
interface PluginDefinition {
  name: string;
  factory: (params: {
    app: WebApplication;
    express: Express;
    logger: Logger;
  }) => Promise<Plugin | void>;
  priority?: number;
}
```

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { Plugin } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000 });

app.use({
  name: 'audit-logger',
  priority: 50,
  factory: async ({ logger }): Promise<Plugin> => {
    await logger.info('Audit logger installed');
    return {
      health: async () => true,
      shutdown: async () => {
        await logger.info('Audit logger stopped');
      },
    };
  },
});
```

---

### PluginTerminalParams

Parameters passed to a plugin's `terminal` hook. Mirrors the factory parameter shape so terminals have a consistent API and a scoped logger.

| Property | Type | Description |
| --- | --- | --- |
| `app` | `WebApplication` | The owning application instance. |
| `express` | `Express` | The underlying Express application instance. |
| `logger` | `Logger` | A logger scoped to the plugin (`Plugin:<name>`). |

```typescript fragment
interface PluginTerminalParams {
  app: WebApplication;
  express: Express;
  logger: Logger;
}
```

---

### PluginRegistry

Registry that installs plugins, runs terminal hooks, aggregates health checks, and shuts plugins down in order. Exported for advanced and testing scenarios — `WebApplication` drives it automatically.

```typescript fragment
class PluginRegistry {
  constructor();

  register(def: PluginDefinition): void;
  install(app: WebApplication, express: Express): Promise<void>;
  installTerminals(app: WebApplication, express: Express): Promise<void>;
  health(): Promise<boolean>;
  shutdown(): Promise<void>;
}
```

**Methods**

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `register` | `register(def: PluginDefinition): void` | `void` | Registers a definition. Throws `Plugin "<name>" is already registered` on duplicates. |
| `install` | `install(app: WebApplication, express: Express): Promise<void>` | `Promise<void>` | Runs all factories in priority order (lower first) and collects `shutdown`, `health`, and `terminal` hooks. |
| `installTerminals` | `installTerminals(app: WebApplication, express: Express): Promise<void>` | `Promise<void>` | Runs collected terminal hooks in priority order. Called after controllers and `/health`, before the 404 handler. |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | `true` when every registered health check passes; `true` when none are registered. |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Invokes all collected `shutdown` hooks in installation order. |

```typescript
import { PluginRegistry } from 'blendsdk/webafx';

const registry = new PluginRegistry();

registry.register({
  name: 'metrics',
  priority: 50,
  factory: async () => ({
    health: async () => true,
  }),
});
```

---

### staticFilesPlugin

Creates a plugin that serves static files (wrapping `express.static()`) with optional SPA fallback support. The root directory is validated at install time — an error is thrown during `app.start()` if it does not exist. Zero additional dependencies.

```typescript fragment
function staticFilesPlugin(config: StaticFilesConfig): PluginDefinition;
```

**Parameters**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `config` | `StaticFilesConfig` | Yes | — | Static file serving configuration. |

**Returns**: `PluginDefinition` — ready to pass to `app.use()`.

**Behavior notes**

- Plugin name is `'static-files'` for the default prefix, or `'static-files:<prefix>'` otherwise. Registering two plugins with the same prefix throws `Plugin "<name>" is already registered` at `app.use()`.
- When `spa: true`, a terminal hook serves `index.html` for unmatched **GET** requests that accept `text/html` and whose last path segment has no file extension. File requests (e.g., `/styles.css`) and API/JSON requests fall through to 404. Because it runs in the terminal phase, it never shadows controller routes.
- `maxAge` accepts a number of milliseconds or a time string (`'1d'`, `'1h'`, `'30m'`, `'1y'`). Combine with `immutable: true` for hashed asset filenames.

```typescript
import { WebApplication, staticFilesPlugin } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

// Production assets with permanent caching.
app.use(
  staticFilesPlugin({
    root: './public',
    prefix: '/static',
    maxAge: '1y',
    immutable: true,
  })
);

// SPA build with client-side routing fallback.
app.use(
  staticFilesPlugin({
    root: './client/build',
    spa: true,
  })
);
```

---

### StaticFilesConfig

Configuration for the static files plugin.

| Property | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `root` | `string` | Yes | — | Directory to serve files from, resolved relative to `process.cwd()`. Must exist at install time. |
| `prefix` | `string` | No | `'/'` | URL prefix to mount at (e.g., `'/static'`). |
| `maxAge` | `string \| number` | No | `0` | `Cache-Control` max-age — milliseconds or a time string (`'1d'`, `'1h'`, `'30m'`). |
| `immutable` | `boolean` | No | `false` | Adds the `immutable` directive for hashed filenames. |
| `dotfiles` | `'ignore' \| 'allow' \| 'deny'` | No | `'ignore'` | Dotfile policy: pretend they don't exist (404), serve normally, or respond 403. |
| `index` | `string \| false` | No | `'index.html'` | Directory index file; `false` disables directory indexing. |
| `etag` | `boolean` | No | `true` | Enable ETag generation. |
| `lastModified` | `boolean` | No | `true` | Enable the `Last-Modified` header. |
| `spa` | `boolean` | No | `false` | Enables the SPA `index.html` fallback for unmatched GET requests. |
| `priority` | `number` | No | `20` | Plugin install priority. |

```typescript fragment
interface StaticFilesConfig {
  root: string;
  prefix?: string;
  maxAge?: string | number;
  immutable?: boolean;
  dotfiles?: 'ignore' | 'allow' | 'deny';
  index?: string | false;
  etag?: boolean;
  lastModified?: boolean;
  spa?: boolean;
  priority?: number;
}
```

---

## Middleware & Request Utilities

### rateLimitMiddleware

Creates an in-memory rate limiting middleware suitable for single-instance deployments. For multi-instance deployments, use a Redis-backed implementation via a plugin.

```typescript fragment
function rateLimitMiddleware(
  options?: RateLimitOptions
): (req: Request, res: Response, next: NextFunction) => void;
```

**Parameters**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `options` | `RateLimitOptions` | No | `{}` | Rate limiting configuration. |

**Returns**: Express middleware `(req: Request, res: Response, next: NextFunction) => void`.

**Behavior**

- Sets `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` (Unix timestamp in seconds) on every response.
- When the limit is exceeded, throws `RateLimitError` (`429`) with the configured message (default `'Rate limit exceeded'`).
- Storage is an in-memory `Map` keyed by IP (default), with an unref'd periodic cleanup interval.

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
        .handle(async (_req: Request, res: Response) => {
          this.ok(res, { results: [] });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });
app.registerController('/api', SearchController);

const shutdown = await app.start();
console.log('Search API protected by rate limiting');
await shutdown();
```

---

### RateLimitOptions

| Property | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `maxRequests` | `number` | No | `100` | Maximum requests per window. |
| `windowMs` | `number` | No | `60000` | Window duration in milliseconds. |
| `keyExtractor` | `(req: Request) => string` | No | `req.ip \|\| 'unknown'` | Partition key extractor (e.g., per API key). |
| `message` | `string` | No | `'Rate limit exceeded'` | Message used for the thrown `RateLimitError`. |

```typescript fragment
interface RateLimitOptions {
  maxRequests?: number;
  windowMs?: number;
  keyExtractor?: (req: Request) => string;
  message?: string;
}
```

---

### RequestContext

Request-scoped context propagated through async operations via `AsyncLocalStorage`. Each request runs in its own context, preventing cross-request contamination. Established automatically by the built-in request ID middleware, which also validates and reuses an incoming `X-Request-ID` header when it is a valid UUID (malformed values are replaced with a fresh UUID).

| Property | Type | Description |
| --- | --- | --- |
| `requestId` | `string` | Unique request ID for tracing (also sent as the `X-Request-ID` response header). |
| `startTime` | `number` | Request start time (milliseconds since epoch). |
| `[key: string]` | `unknown` | Additional context properties can be added dynamically. |

```typescript fragment
interface RequestContext {
  requestId: string;
  startTime: number;
  [key: string]: unknown;
}
```

---

### requestContextStorage

| Constant | Type | Description |
| --- | --- | --- |
| `requestContextStorage` | `AsyncLocalStorage<RequestContext>` | Shared `AsyncLocalStorage` instance for request context propagation. Use `.run()` directly for advanced scenarios (e.g., background jobs that need a synthetic context). |

```typescript fragment
const requestContextStorage: AsyncLocalStorage<RequestContext>;
```

---

### getRequestContext

Returns the current request context if called inside a request scope.

```typescript fragment
function getRequestContext(): RequestContext | undefined;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| — | — | — | This function takes no parameters. |

**Returns**: `RequestContext | undefined` — the active context, or `undefined` when called outside a request scope.

```typescript
import { getRequestContext } from 'blendsdk/webafx';

const context = getRequestContext();
if (context) {
  console.log(`Request ${context.requestId} started at ${context.startTime}`);
}
```

---

### getRequestId

Returns the current request ID if called inside a request scope.

```typescript fragment
function getRequestId(): string | undefined;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| — | — | — | This function takes no parameters. |

**Returns**: `string | undefined` — the current request ID, or `undefined` when called outside a request scope.

```typescript
import { getRequestId } from 'blendsdk/webafx';

const requestId = getRequestId();
if (requestId) {
  console.log(`Handling request ${requestId}`);
}
```

---

### preparseServiceNames

**Deprecated.** Assigns each enumerable own key of the given class its own name as value, so `static` members act as service name constants. Emits a `[WebAFX DEPRECATION WARNING]` to the console on every call. Use `as const` objects instead — they are the supported replacement and will remain.

```typescript fragment
function preparseServiceNames(clazz: any): void;
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `clazz` | `any` | Yes | Class (or object) whose enumerable keys are assigned their own names as values. |

**Returns**: `void`

```typescript
// Recommended replacement for preparseServiceNames():
export const ServiceNames = {
  LOGGER_SERVICE: 'LOGGER_SERVICE',
  CACHE_SERVICE: 'CACHE_SERVICE',
} as const;
```

---

## Logging

### Logger

Common logging contract implemented by `ConsoleLogger`, `StructuredLogger`, and custom loggers installed via `WebApplication.setLogger()`. All methods are asynchronous and resolve when the message has been emitted.

```typescript fragment
interface Logger {
  error(message: string, data?: Record<string, any>): Promise<void>;
  warn(message: string, data?: Record<string, any>): Promise<void>;
  info(message: string, data?: Record<string, any>): Promise<void>;
  debug(message: string, data?: Record<string, any>): Promise<void>;
}
```

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `error` | `error(message: string, data?: Record<string, any>): Promise<void>` | `Promise<void>` | Logs an error message. |
| `warn` | `warn(message: string, data?: Record<string, any>): Promise<void>` | `Promise<void>` | Logs a warning message. |
| `info` | `info(message: string, data?: Record<string, any>): Promise<void>` | `Promise<void>` | Logs an informational message. |
| `debug` | `debug(message: string, data?: Record<string, any>): Promise<void>` | `Promise<void>` | Logs a debug message. |

---

### LogLevel

| Value | Numeric priority | Description |
| --- | --- | --- |
| `'ERROR'` | 1 | Errors only (highest priority). |
| `'WARN'` | 2 | Errors and warnings. |
| `'INFO'` | 3 | Errors, warnings, and info. |
| `'DEBUG'` | 4 | All messages including debug. |

The configured level acts as a threshold: a message is emitted when its level number is less than or equal to the configured level.

```typescript fragment
type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
```

---

### ConsoleLogger

Console-based logger producing human-readable, prefixed messages. Format: `[LEVEL:PREFIX]: message - {"key":"value"}` with the prefix uppercased. `ERROR` goes to `console.error`; `WARN`, `INFO`, and `DEBUG` go to `console.log`.

```typescript fragment
class ConsoleLogger implements Logger {
  constructor(prefix?: string, logLevel?: LogLevel);

  error(message: string, data?: Record<string, any>): Promise<void>;
  warn(message: string, data?: Record<string, any>): Promise<void>;
  info(message: string, data?: Record<string, any>): Promise<void>;
  debug(message: string, data?: Record<string, any>): Promise<void>;
}
```

**Constructor parameters**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `prefix` | `string` | No | — | Prefix shown in messages (e.g., `'APP'`, `'Plugin:Auth'`); uppercased in output. |
| `logLevel` | `LogLevel` | No | `process.env.LOG_LEVEL` (uppercased) or `'ERROR'` | Threshold level. A constructor value overrides the environment; unknown environment values fall back to `ERROR`; matching is case-insensitive. |

**Level behavior**

| Configured level | `error` | `warn` | `info` | `debug` |
| --- | --- | --- | --- | --- |
| `ERROR` | ✅ | — | — | — |
| `WARN` | ✅ | ✅ | — | — |
| `INFO` | ✅ | ✅ | ✅ | — |
| `DEBUG` | ✅ | ✅ | ✅ | ✅ |

`debug` messages are also emitted when `process.env.DEBUG === 'true'`, regardless of the configured level.

```typescript
import { ConsoleLogger } from 'blendsdk/webafx';

const logger = new ConsoleLogger('APP', 'INFO');

await logger.info('Server booting');
await logger.error('Something failed', { requestId: 'abc-123' });
// [INFO:APP]: Server booting
// [ERROR:APP]: Something failed - {"requestId":"abc-123"}
```

---

### StructuredLogger

JSON logger emitting one single-line JSON object per entry — suitable for log aggregation pipelines. Same level filtering as `ConsoleLogger`. `ERROR` entries go to `console.error`; all others go to `console.log`.

```typescript fragment
class StructuredLogger implements Logger {
  constructor(prefix?: string, logLevel?: LogLevel, contextFn?: () => Record<string, unknown>);

  error(message: string, data?: Record<string, any>): Promise<void>;
  warn(message: string, data?: Record<string, any>): Promise<void>;
  info(message: string, data?: Record<string, any>): Promise<void>;
  debug(message: string, data?: Record<string, any>): Promise<void>;
}
```

**Constructor parameters**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `prefix` | `string` | No | — | Logger prefix included in each entry. |
| `logLevel` | `LogLevel` | No | `process.env.LOG_LEVEL` or `'ERROR'` | Threshold level (constructor value overrides the environment). |
| `contextFn` | `() => Record<string, unknown>` | No | — | Called for every entry; its properties are merged into the JSON output (e.g., the current request ID). |

**JSON output fields**

| Field | Type | Description |
| --- | --- | --- |
| `timestamp` | `string` | ISO-8601 UTC timestamp. |
| `level` | `LogLevel` | Log level of the entry. |
| `message` | `string` | Log message. |
| `prefix` | `string` (optional) | Present when a prefix was configured. |
| `data` | `Record<string, unknown>` (optional) | Present when data was passed to the log call. |
| _(context)_ | `unknown` | Properties returned by `contextFn`, merged at the top level. |

```typescript
import { StructuredLogger, getRequestId } from 'blendsdk/webafx';

const logger = new StructuredLogger('API', 'INFO', () => ({
  requestId: getRequestId(),
}));

await logger.info('Request completed', { status: 200 });
// {"timestamp":"2025-01-01T12:00:00.000Z","level":"INFO","message":"Request completed","prefix":"API","data":{"status":200},"requestId":"..."}
```

---

## Errors

### ApiError

Base class for all typed HTTP errors. Extends `Error` and carries an HTTP status code, a stable machine-readable error code, a human-readable message, and optional structured details. `WebApplication`'s built-in error handling renders `ApiError` instances as a `StandardErrorResponse`; unknown errors become `500` responses whose message and stack are revealed only outside production.

```typescript fragment
class ApiError extends Error {
  constructor(statusCode: number, code: string, message: string, details?: unknown);

  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  toJSON(): StandardErrorResponse;
}
```

**Constructor parameters**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `statusCode` | `number` | Yes | — | HTTP status code used for the response. |
| `code` | `string` | Yes | — | Machine-readable error code (e.g., `'NOT_FOUND'`). |
| `message` | `string` | Yes | — | Human-readable message. |
| `details` | `unknown` | No | — | Optional structured details (e.g., validation issues); included in the response when present. |

**Properties**

| Property | Type | Description |
| --- | --- | --- |
| `statusCode` | `number` | HTTP status code. |
| `code` | `string` | Machine-readable error code. |
| `details` | `unknown` | Structured details, or `undefined`. |
| `message` | `string` | Message inherited from `Error`. |
| `name` | `string` | Always `'ApiError'`. |
| `stack` | `string \| undefined` | Stack trace inherited from `Error`. |

**Methods**

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `toJSON` | `toJSON(): StandardErrorResponse` | `StandardErrorResponse` | Serializes to the standard error envelope: `{ success: false, error: { code, message, statusCode, timestamp } }`, plus `details` when present. |

```typescript
import { ApiError } from 'blendsdk/webafx';

try {
  throw new ApiError(402, 'PAYMENT_REQUIRED', 'Insufficient credits', { balance: 0 });
} catch (error) {
  if (error instanceof ApiError) {
    console.log(error.statusCode); // 402
    console.log(error.code);       // 'PAYMENT_REQUIRED'
    console.log(error.toJSON());
    // { success: false, error: { code: 'PAYMENT_REQUIRED', message: 'Insufficient credits',
    //   details: { balance: 0 }, statusCode: 402, timestamp: '...' } }
  }
}
```

---

### StandardErrorResponse

Uniform error envelope produced by `ApiError.toJSON()` and by the framework's error handler. The error handler additionally always includes `requestId` and `path`.

| Property | Type | Description |
| --- | --- | --- |
| `success` | `false` | Always `false`. |
| `error.code` | `string` | Machine-readable error code. |
| `error.message` | `string` | Human-readable message. |
| `error.statusCode` | `number` | HTTP status code. |
| `error.timestamp` | `string` | ISO-8601 UTC timestamp. |
| `error.requestId?` | `string` | Request correlation ID (`X-Request-ID` header value or generated UUID). Always present on error-handler responses. |
| `error.path?` | `string` | Request path. Always present on error-handler responses. |
| `error.details?` | `unknown` | Optional structured details (e.g., field-level validation issues). |
| `error.stack?` | `string` | Stack trace — included only when the application is not running in production mode. |

```typescript fragment
interface StandardErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    statusCode: number;
    timestamp: string;
    requestId?: string;
    path?: string;
    details?: unknown;
    stack?: string;
  };
}
```

---

### HTTP Error Classes

Nine ready-made subclasses of `ApiError` covering the common HTTP error cases. Each has a default message and a fixed `statusCode` and `code`.

```typescript fragment
constructor(message?: string, details?: unknown);
```

| Class | Status | Code | Default message |
| --- | --- | --- | --- |
| `BadRequestError` | `400` | `BAD_REQUEST` | `Bad Request` |
| `UnauthorizedError` | `401` | `UNAUTHORIZED` | `Unauthorized` |
| `ForbiddenError` | `403` | `FORBIDDEN` | `Forbidden` |
| `NotFoundError` | `404` | `NOT_FOUND` | `Not Found` |
| `ConflictError` | `409` | `CONFLICT` | `Conflict` |
| `ValidationError` | `422` | `VALIDATION_ERROR` | `Validation Failed` |
| `RateLimitError` | `429` | `RATE_LIMIT_EXCEEDED` | `Rate Limit Exceeded` |
| `InternalServerError` | `500` | `INTERNAL_SERVER_ERROR` | `Internal Server Error` |
| `ServiceUnavailableError` | `503` | `SERVICE_UNAVAILABLE` | `Service Unavailable` |

All subclasses accept an optional custom message and optional details, inherit `statusCode`, `code`, `details`, and `toJSON()` from `ApiError`, and set `name` to their own class name.

```typescript
import { BaseController, NotFoundError, ValidationError } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class AccountController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/accounts/:id')
        .handle(async (req: Request, res: Response) => {
          const id = String(req.params.id);

          if (id.length === 0) {
            throw new ValidationError('Validation failed', [
              { path: 'id', message: 'Account id is required', code: 'too_small' },
            ]);
          }

          if (id === 'unknown') {
            throw new NotFoundError('Account not found', { accountId: id });
          }

          this.ok(res, { id, balance: 42 });
        }),
    ];
  }
}
```

Thrown errors are rendered by the framework as `StandardErrorResponse` with the matching status code, including `requestId`, `path`, and (outside production) stack traces.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
