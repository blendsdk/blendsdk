> **Package**: `blendsdk/webafx`

# webafx API Reference

`blendsdk/webafx` is a web application framework built on Express for the BlendSDK ecosystem. This document is the complete reference for every symbol exported from the package root: applications, configuration, controllers, routing, dependency injection, plugins, static file hosting, security middleware, logging, request context, and errors.

Install the umbrella package together with its peer dependencies:

```bash
npm install blendsdk express zod
```

The package is ESM-only and requires Node.js 22 or newer. All examples are complete, import their dependencies, and follow strict TypeScript conventions.

---

## Public API Summary

| Symbol | Kind | Summary |
|--------|------|---------|
| `WebApplication` | Class | Main application class: lifecycle, registries, start/shutdown |
| `LifecycleHook` | Type | `() => void \| Promise<void>` hook signature |
| `ApplicationSettings` | Class | Zod-validated configuration with file loading |
| `ApplicationConfig` | Interface | Standard configuration properties plus custom passthrough |
| `CorsConfig` | Interface | CORS options for `ApplicationConfig.CORS` |
| `BaseController` | Class | Base class for controllers; route building and response helpers |
| `StandardSuccessResponse<T>` | Interface | `{ success: true, data }` success envelope |
| `PaginatedResponse<T>` | Interface | Success envelope with `pagination` metadata |
| `RouteBuilder` | Class | Fluent API for defining routes |
| `RouteDefinition` | Interface | Fully built route: method, path, handler, flags, metadata |
| `HttpMethod` | Type | `'get' \| 'post' \| 'put' \| 'patch' \| 'delete'` |
| `RouteHandler` | Type | Express-style route handler signature |
| `AuthorizeFunction<T>` | Type | `(req, user) => boolean \| Promise<boolean>` |
| `OpenAPIRouteMetadata` | Interface | Opt-in OpenAPI documentation metadata |
| `OpenAPIResponseDefinition` | Interface | One documented response for a route |
| `ResponseEnvelope` | Type | `'data' \| 'body'` client response-reading mode |
| `ServiceContainer` | Class | Per-request DI container (`req.services`) |
| `ServiceDefinition<T>` | Interface | Service blueprint: factory, type, dependencies, dispose |
| `ServiceRegistry` | Interface | Shared definitions and singleton cache |
| `SingletonFactory<T>` | Type | Singleton factory signature |
| `PerRequestFactory<T>` | Type | Per-request factory signature |
| `PluginDefinition` | Interface | Plugin registration object: name, factory, priority |
| `Plugin` | Interface | Installed plugin hooks: `health`, `shutdown`, `terminal` |
| `PluginTerminalParams` | Interface | Parameters passed to the terminal hook |
| `PluginRegistry` | Class | Priority-ordered plugin installation registry (internal) |
| `staticFilesPlugin` | Function | Static files + SPA plugin factory |
| `StaticFilesConfig` | Interface | Static file serving configuration |
| `csrfMiddleware` | Function | CSRF protection request handler |
| `csrfPlugin` | Function | CSRF protection as an application-wide plugin |
| `CsrfOptions` | Interface | CSRF configuration: header, exemptions, token strategy |
| `constantTimeTokenMatch` | Function | Timing-safe CSRF token comparison |
| `rateLimitMiddleware` | Function | In-memory rate limiting middleware |
| `RateLimitOptions` | Interface | Rate limit configuration |
| `Logger` | Interface | Async logging interface implemented by all loggers |
| `LogLevel` | Type | `'ERROR' \| 'WARN' \| 'INFO' \| 'DEBUG'` |
| `ConsoleLogger` | Class | Human-readable console logger |
| `StructuredLogger` | Class | JSON logger for log aggregation |
| `LogEntry` | Interface | Structured log entry shape |
| `RequestContext` | Interface | Request-scoped context data |
| `requestContextStorage` | Const | Shared `AsyncLocalStorage<RequestContext>` instance |
| `getRequestContext` | Function | Returns the current request context |
| `getRequestId` | Function | Returns the current request ID |
| `ApiError` | Class | Base API error with `statusCode`, `code`, `details`, `toJSON()` |
| `BadRequestError` | Class | 400 `BAD_REQUEST` |
| `UnauthorizedError` | Class | 401 `UNAUTHORIZED` |
| `ForbiddenError` | Class | 403 `FORBIDDEN` |
| `NotFoundError` | Class | 404 `NOT_FOUND` |
| `ConflictError` | Class | 409 `CONFLICT` |
| `ValidationError` | Class | 422 `VALIDATION_ERROR` |
| `RateLimitError` | Class | 429 `RATE_LIMIT_EXCEEDED` |
| `InternalServerError` | Class | 500 `INTERNAL_SERVER_ERROR` |
| `ServiceUnavailableError` | Class | 503 `SERVICE_UNAVAILABLE` |
| `StandardErrorResponse` | Interface | Standard error envelope |
| `ErrorResponse` | Interface | Deprecated legacy error envelope |
| `ValidationErrorDetail` | Interface | Field-level validation error detail |
| `preparseServiceNames` | Function | Deprecated service-name helper |

---

## WebApplication

The main application class. A single `WebApplication` instance owns the Express application, the configuration, the service registry, the plugin registry, and the controller registry, and coordinates the full startup and shutdown lifecycle.

```typescript fragment
class WebApplication {
  constructor(config?: ApplicationConfig);

  on(event: 'beforeStart' | 'afterStart' | 'beforeShutdown' | 'afterShutdown', hook: LifecycleHook): this;
  registerService(service: ServiceDefinition): this;
  registerController(basePath: string, ControllerClass: new (settings: ApplicationSettings, services: ServiceContainer) => any): void;
  getSettings<T extends ApplicationSettings>(): T;
  use(plugin: PluginDefinition): this;
  setLogger(logger: Logger): void;
  get express(): Express;
  start(): Promise<() => Promise<void>>;
}
```

### Constructor

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(config?: ApplicationConfig)` | `WebApplication` | Creates a new application. Configuration is validated immediately; `ENV_MODE` defaults to `'production'`. Throws if the provided configuration fails validation. |

### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `on` | `on(event, hook: LifecycleHook): this` | `this` | Registers a lifecycle hook. Multiple hooks per event run sequentially in registration order. |
| `registerService` | `registerService(service: ServiceDefinition): this` | `this` | Registers a service in the application's dependency injection container. Throws if a service with the same name is already registered. |
| `registerController` | `registerController(basePath: string, ControllerClass: new (settings: ApplicationSettings, services: ServiceContainer) => any): void` | `void` | Registers a controller class under a base URL path. Controllers are instantiated once at startup with the application settings and the application-level service container. |
| `getSettings` | `getSettings<T extends ApplicationSettings>(): T` | `T` | Returns all configuration values as a shallow copy. The returned value is the raw configuration object, not an `ApplicationSettings` instance; use the generic parameter to describe the expected shape (typically an intersection with your custom keys). |
| `use` | `use(plugin: PluginDefinition): this` | `this` | Registers a plugin. Throws if a plugin with the same name is already registered. |
| `setLogger` | `setLogger(logger: Logger): void` | `void` | Replaces the application logger. Typically called by logger plugins during installation; messages logged before the call still use the previous logger. |
| `start` | `start(): Promise<() => Promise<void>>` | `Promise<() => Promise<void>>` | Initializes and starts the HTTP server. Resolves with an idempotent `shutdown()` function that drains connections, disposes singleton services, and shuts down plugins. Throws `Application already started` on a second call. |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `express` | `Express` | Getter that returns the underlying Express application — the escape hatch for features WebAFX does not wrap (static middleware, view engines, WebSocket upgrades, custom routes). |

### Lifecycle Events

| Event | Fires when |
|-------|------------|
| `'beforeStart'` | After configuration files are loaded, before core middleware, plugins, and controllers are set up. Ideal for initializing databases or caches. |
| `'afterStart'` | After the HTTP server is listening and signal handlers are installed. Ideal for warm-up tasks that need a running server. |
| `'beforeShutdown'` | At the beginning of shutdown, before singleton services are disposed and plugins are shut down. |
| `'afterShutdown'` | After services and plugins have been disposed. |

```typescript fragment
type LifecycleHook = () => void | Promise<void>;
```

### Runtime Behavior

- `GET /health` is always registered and responds with `{ health: boolean, timestamp: number }` — `200` when every plugin health check passes, `503` otherwise.
- `SIGTERM` and `SIGINT` trigger the same graceful shutdown returned by `start()`; handlers are removed after shutdown.
- Shutdown drains connections within `SHUTDOWN_TIMEOUT` seconds in production (1 second otherwise) before force-closing.
- Request logging, request IDs, security headers (Helmet), CORS, cookie parsing, and body parsing are wired up automatically before plugins and controllers.
- Protected members (`settings`, `expressApp`, `services`, `plugins`, `logger`, …) are implementation internals and are not part of the supported public surface.

### Example

```typescript
import { BaseController, WebApplication } from 'blendsdk/webafx';
import type { Request, Response } from 'express';
import type { RouteDefinition } from 'blendsdk/webafx';

class HelloController extends BaseController {
  routes(): RouteDefinition[] {
    return [this.route().get('/hello').handle(this.hello)];
  }

  private hello = async (_req: Request, res: Response): Promise<void> => {
    this.ok(res, { message: 'Hello, World!' });
  };
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

app.use({
  name: 'timing',
  factory: async ({ logger }) => {
    await logger.info('Timing plugin installed');
  },
});

app.registerController('/api', HelloController);

const shutdown = await app.start();
// GET /api/hello → 200 { "success": true, "data": { "message": "Hello, World!" } }

await shutdown();
```

---

## Configuration

### ApplicationSettings

Manages application configuration. Supports loading values from JavaScript configuration files via dynamic ESM `import()` and provides validated, type-safe access to configuration values.

```typescript fragment
class ApplicationSettings {
  constructor(config?: ApplicationConfig, logger?: ConsoleLogger);

  loadFromFile(jsPath: string): Promise<void>;
  getAll<T extends ApplicationConfig>(): T;
  get<T = any>(key: keyof ApplicationConfig, defaultValue?: T): T;
  isProduction(): boolean;

  protected config: ApplicationConfig;
  protected logger: ConsoleLogger;
}
```

#### Constructor

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `ApplicationConfig` | No | `{}` | Initial configuration values. When provided, the values are validated immediately. |
| `logger` | `ConsoleLogger` | No | `new ConsoleLogger('Settings')` | Logger used for configuration loading messages. |

#### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `loadFromFile` | `loadFromFile(jsPath: string): Promise<void>` | `Promise<void>` | Dynamically imports a JavaScript configuration file and merges its exports into the configuration. Reads the module's `default` export, then its `config` export. Returns silently when the path is empty or the file does not exist. Throws `Configuration file error: <path>` when the file exists but cannot be loaded or fails validation. |
| `getAll` | `getAll<T extends ApplicationConfig>(): T` | `T` | Returns a shallow copy of the configuration. Mutating the copy does not affect internal state; nested objects are referenced, not cloned. |
| `get` | `get<T = any>(key: keyof ApplicationConfig, defaultValue?: T): T` | `T` | Returns the value for a key, or `defaultValue` when the key is `undefined`. |
| `isProduction` | `isProduction(): boolean` | `boolean` | Returns `true` when `ENV_MODE` is `'production'`. |

#### Validation and Normalization

- The configuration is validated against a Zod schema after construction (when config is provided) and after every `loadFromFile()` call. Invalid values throw an `Error` whose message begins with `Configuration validation failed:` and lists each failing property.
- On file load, `LOG_LEVEL` is derived when not set: `'DEBUG'` when `DEBUG` is `true` or `ENV_MODE` is not `'production'`, otherwise `'ERROR'`.
- Configuration is the single source of truth — `process.env` is never mutated.

#### Example

```typescript
import { ApplicationSettings, WebApplication } from 'blendsdk/webafx';

const settings = new ApplicationSettings({
  PORT: 3000,
  ENV_MODE: 'development',
  CUSTOM_FEATURE_FLAG: true,
});

// Loads additional values if .env.local.js exists; silently skipped otherwise
await settings.loadFromFile('.env.local.js');

const port = settings.get<number>('PORT', 4000);
const flag = settings.get<boolean>('CUSTOM_FEATURE_FLAG', false);

console.log(port, flag, settings.isProduction()); // 3000 true false

const snapshot = settings.getAll();
snapshot.PORT = 5000; // does not affect the internal configuration
console.log(settings.get<number>('PORT')); // 3000

const app = new WebApplication(settings.getAll());
const shutdown = await app.start();
await shutdown();
```

---

### ApplicationConfig

Defines the standard configuration properties with type safety. Additional custom properties are allowed via an index signature and are preserved by validation (passthrough).

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `DEBUG` | `boolean` | `undefined` | Enables debug mode. When loading from a file, `DEBUG: true` derives `LOG_LEVEL: 'DEBUG'`. |
| `ENV_MODE` | `'production' \| 'development' \| 'test'` | `'production'` | Environment mode. Controls stack traces in error responses (non-production includes them) and the shutdown grace period. Also passed to Express as its `env` setting. |
| `LOG_LEVEL` | `'ERROR' \| 'WARN' \| 'INFO' \| 'DEBUG'` | Derived | Minimum log level for framework loggers. Derived on file load; see `ApplicationSettings`. |
| `PORT` | `number` | `4000` | HTTP listener port. Must be an integer between `0` and `65535` (`0` picks a random free port, useful for tests). |
| `TRUST_PROXY` | `boolean` | `true` | When enabled, sets Express `trust proxy` to `1` (correct client IPs behind nginx or load balancers). |
| `BODY_LIMIT` | `string` | `'10mb'` | Size limit for JSON and URL-encoded request bodies. |
| `SHUTDOWN_TIMEOUT` | `number` | `7` | Graceful shutdown timeout in seconds. Must be between `0` and `300`. Applied in production only; non-production uses 1 second. |
| `CORS` | `boolean \| CorsConfig` | `undefined` | CORS middleware configuration. The middleware is installed only when the value is not `false` and not `undefined`. `true` installs permissive defaults (`origin: '*'`, credentials, 204 preflight). |
| `[key: string]` | `string \| number \| boolean \| undefined \| any` | — | Additional custom properties are permitted and passed through validation. |

#### Validation Rules

| Property | Constraint |
|----------|------------|
| `PORT` | Integer, `0`–`65535` |
| `ENV_MODE` | One of `'production'`, `'development'`, `'test'` |
| `LOG_LEVEL` | One of `'ERROR'`, `'WARN'`, `'INFO'`, `'DEBUG'` |
| `DEBUG` | `boolean` |
| `TRUST_PROXY` | `boolean` |
| `BODY_LIMIT` | `string` |
| `SHUTDOWN_TIMEOUT` | Number, `0`–`300` |
| `CORS` | `boolean` or a plain object |
| Additional keys | Accepted without validation |

---

### CorsConfig

CORS configuration options used by `ApplicationConfig.CORS`. All properties are optional.

| Property | Type | Description |
|----------|------|-------------|
| `origin` | `string \| string[] \| ((origin: string \| undefined, callback: (err: Error \| null, allowed: boolean) => void) => void)` | Allowed origins. A single string is converted to an exact-match validation function; arrays and callbacks are passed through to the `cors` package. When omitted, all origins are allowed (`'*'`). |
| `methods` | `string[]` | Allowed HTTP methods for preflight responses. |
| `allowedHeaders` | `string[]` | Headers the browser may send. |
| `exposedHeaders` | `string[]` | Response headers exposed to the browser. |
| `credentials` | `boolean` | Whether to send `Access-Control-Allow-Credentials: true`. |
| `maxAge` | `number` | How long (in seconds) preflight results may be cached. |

---

## Controllers

### BaseController

Abstract base class for all application controllers. Provides route building via `RouteBuilder`, consistent response helpers, and access to application settings and services.

```typescript fragment
abstract class BaseController {
  constructor(settings: ApplicationSettings, services: ServiceContainer);

  abstract routes(): RouteDefinition[];

  protected route(): RouteBuilder;
  protected authenticated(userServiceName?: string): RouteBuilder;
  protected ok<T>(res: Response, data: T): void;
  protected created<T>(res: Response, data: T): void;
  protected paginated<T>(res: Response, data: T[], total: number, page: number, limit: number): void;
  protected noContent(res: Response): void;

  protected settings: ApplicationSettings;
  protected services: ServiceContainer;
}
```

#### Constructor

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `settings` | `ApplicationSettings` | Yes | — | Application settings, passed by `WebApplication` at startup. |
| `services` | `ServiceContainer` | Yes | — | Application-level service container, passed by `WebApplication` at startup. Per-request work uses `req.services` instead. |

#### Abstract Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `routes` | `abstract routes(): RouteDefinition[]` | `RouteDefinition[]` | Must be implemented by subclasses; returns the routes this controller exposes. Called once at startup. |

#### Protected Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `route` | `protected route(): RouteBuilder` | `RouteBuilder` | Creates a new route builder. |
| `authenticated` | `protected authenticated(userServiceName?: string): RouteBuilder` | `RouteBuilder` | Shorthand for `route().secure(userServiceName)`. Without an argument, the default `'user'` principal service is used; pass a service name to authenticate against a different principal (for example machine clients). |
| `ok` | `protected ok<T>(res: Response, data: T): void` | `void` | Sends `200` with `{ success: true, data }`. |
| `created` | `protected created<T>(res: Response, data: T): void` | `void` | Sends `201` with `{ success: true, data }`. |
| `paginated` | `protected paginated<T>(res: Response, data: T[], total: number, page: number, limit: number): void` | `void` | Sends `200` with `{ success: true, data, pagination }`. `pagination.pages` is computed as `Math.ceil(total / limit)`. |
| `noContent` | `protected noContent(res: Response): void` | `void` | Sends `204` with an empty body. |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `settings` | `ApplicationSettings` | Application settings passed from `WebApplication`. |
| `services` | `ServiceContainer` | Application-level service container. |

#### Example

```typescript
import { BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';
import type { RouteDefinition } from 'blendsdk/webafx';

interface Todo {
  id: number;
  title: string;
}

class TodoController extends BaseController {
  private todos: Todo[] = [{ id: 1, title: 'Write the API reference' }];

  routes(): RouteDefinition[] {
    return [
      this.route().get('/').handle(this.list),
      this.route().post('/').handle(this.create),
      this.authenticated().delete('/:id').handle(this.remove),
    ];
  }

  private list = async (_req: Request, res: Response): Promise<void> => {
    this.paginated(res, this.todos, this.todos.length, 1, 20);
  };

  private create = async (req: Request, res: Response): Promise<void> => {
    const todo: Todo = { id: this.todos.length + 1, title: String(req.body.title) };
    this.todos.push(todo);
    this.created(res, todo);
  };

  private remove = async (req: Request, res: Response): Promise<void> => {
    this.todos = this.todos.filter(todo => todo.id !== Number(req.params.id));
    this.noContent(res);
  };
}
```

---

### StandardSuccessResponse

The success envelope produced by `ok()` and `created()`.

```typescript fragment
interface StandardSuccessResponse<T = unknown> {
  success: true;
  data: T;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `success` | `true` | Literal discriminator for success responses. |
| `data` | `T` | The response payload. |

---

### PaginatedResponse

The paginated envelope produced by `paginated()`.

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

| Property | Type | Description |
|----------|------|-------------|
| `success` | `true` | Literal discriminator for success responses. |
| `data` | `T[]` | Items on the current page. |
| `pagination.total` | `number` | Total number of items across all pages. |
| `pagination.page` | `number` | Current page number (1-indexed). |
| `pagination.limit` | `number` | Items per page. |
| `pagination.pages` | `number` | Total number of pages: `Math.ceil(total / limit)`. |

---

## Routing

### RouteBuilder

Fluent builder for defining HTTP routes. Methods can be chained in any order before `handle()`, which finalizes and returns the `RouteDefinition`.

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

#### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `get` | `get(path: string): this` | `this` | Defines a GET route. |
| `post` | `post(path: string): this` | `this` | Defines a POST route. |
| `put` | `put(path: string): this` | `this` | Defines a PUT route. |
| `patch` | `patch(path: string): this` | `this` | Defines a PATCH route. |
| `delete` | `delete(path: string): this` | `this` | Defines a DELETE route. |
| `secure` | `secure(userServiceName?: string): this` | `this` | Marks the route as requiring authentication. Without an argument, the default `'user'` principal service is used. A custom name must be the principal service name (such as an auth plugin's `userServiceName`). Surrounding whitespace is trimmed; a blank name throws `secure() requires a non-empty user service name`. |
| `authorize` | `authorize(authorizeFn: AuthorizeFunction): this` | `this` | Adds an authorization check, executed after authentication. Returning `false` yields a `403 FORBIDDEN` response. |
| `middleware` | `middleware(fn: RequestHandler): this` | `this` | Appends route-level middleware. Can be called multiple times; middleware runs in registration order, before authentication, authorization, validation, and the handler. |
| `openapi` | `openapi(meta: OpenAPIRouteMetadata): this` | `this` | Attaches OpenAPI metadata. Routes without this call are excluded from generated specs — the opt-in mechanism for API documentation. |
| `validate` | `validate<TSchema extends ZodType>(schema: TSchema): RouteBuilder` | `RouteBuilder` | Attaches a Zod schema that validates the merged `params` + `query` + `body` before the handler runs. Failures produce `422 VALIDATION_ERROR`. |
| `handle` | `handle(handler: RouteHandler): RouteDefinition` | `RouteDefinition` | Sets the handler and finalizes the route. Must be the last call. Throws if the handler is not a function, or if the method or path has not been set. |

#### Route Security Semantics

A route is secure when `secure` is `true` or a non-empty string; a public route has `secure` omitted or `false`.

- Secure routes resolve the principal from the named service container (default: `'user'`) via `req.services.get(name, undefined)`. A missing principal — including an unknown or blank service name — fails closed with `401 UNAUTHORIZED` (`Authentication required`).
- `authorize(fn)` runs after authentication. The callback receives the same principal the route selected; returning a falsy value produces `403 FORBIDDEN` (`Access denied`). On non-secure routes with an `authorize` callback, the principal may be `undefined`.
- When both `secure` and `authorize` are present, the principal is resolved only once and shared.

#### Route Execution Pipeline

1. Route-level middleware (registration order)
2. Authentication (`secure`) → `401` when no principal
3. Authorization (`authorize`) → `403` when rejected
4. Validation (`validate`) → `422` with field-level details
5. Input storage — `request-params` (validated, merged) and `request-input` (raw separated sources)
6. Handler
7. Any thrown error flows to the error handler

#### Example

```typescript
import { RouteBuilder } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { z } from 'zod';

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});

const route: RouteDefinition = new RouteBuilder()
  .post('/users')
  .openapi({
    summary: 'Create a user',
    tags: ['users'],
    responses: [{ statusCode: 201, description: 'User created' }],
  })
  .validate(createUserSchema)
  .handle(async (req, res) => {
    res.status(201).json({ name: req.body.name });
  });

console.log(route.method); // 'post'
console.log(route.path);   // '/users'
```

---

### RouteDefinition

The complete, finalized route object returned by `RouteBuilder.handle()`.

| Property | Type | Description |
|----------|------|-------------|
| `method` | `HttpMethod` | HTTP verb for the route. |
| `path` | `string` | Express-style path (may contain `:param` segments), relative to the controller's base path. |
| `handler` | `RouteHandler` | The final request handler. |
| `validation` | `ZodType` | Optional Zod schema for request validation. |
| `secure` | `boolean \| string` | Authentication requirement. `true` uses the default `'user'` principal service; a string names the principal service to resolve. Omitted or `false` means the route is public. |
| `authorize` | `AuthorizeFunction` | Optional authorization callback executed after authentication. |
| `middleware` | `RequestHandler[]` | Optional route-level middleware, executed in order before the wrapped handler. |
| `openapi` | `OpenAPIRouteMetadata` | Optional OpenAPI metadata. Routes without it are excluded from generated specs. |

---

### Route Handler Types

```typescript fragment
type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

type RouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<void> | void;

type AuthorizeFunction<T = any> = (req: Request, user: T) => boolean | Promise<boolean>;
```

| Type | Description |
|------|-------------|
| `HttpMethod` | The five HTTP verbs supported by `RouteBuilder`. |
| `RouteHandler` | Express-compatible handler signature; may be sync or async. |
| `AuthorizeFunction<T>` | Decides whether the authenticated user (or resolved principal) may proceed. Returning `false` (or a promise resolving to `false`) yields `403`. |

---

## OpenAPI Route Metadata

`OpenAPIRouteMetadata` is pure data stored on the `RouteDefinition`. WebAFX performs no spec generation — `blendsdk/codegen` consumes this metadata to build OpenAPI documents. Only routes that call `.openapi()` are included.

### OpenAPIRouteMetadata

All properties are optional.

| Property | Type | Description |
|----------|------|-------------|
| `summary` | `string` | Short summary of the route (appears in path listings). |
| `description` | `string` | Detailed description; supports markdown. |
| `tags` | `string[]` | Tags for grouping routes in the spec (for example `'products'`, `'auth'`). |
| `operationId` | `string` | Unique operation identifier for the route. |
| `deprecated` | `boolean` | Marks the route as deprecated in the spec. |
| `envelope` | `ResponseEnvelope` | How a generated client reads a successful response body. Defaults to `'data'` at generation time. |
| `pathParams` | `Record<string, { schema: ZodType; description?: string }>` | Schemas and descriptions for path parameters not covered by the validation schema. Keys match the Express `:param` names in the path. |
| `responses` | `OpenAPIResponseDefinition[]` | Documented possible responses from this endpoint. |

### OpenAPIResponseDefinition

| Property | Type | Description |
|----------|------|-------------|
| `statusCode` | `number` | HTTP status code (for example `200`, `201`, `404`). |
| `description` | `string` | Human-readable description of this response. |
| `schema` | `ZodType` | Optional Zod schema describing the response body structure. |

### ResponseEnvelope

```typescript fragment
type ResponseEnvelope = 'data' | 'body';
```

| Value | Meaning |
|-------|---------|
| `'data'` | Default. The response is `{ success: true, data }`, so a generated client returns the `data` value. |
| `'body'` | The client returns the entire response body. Required for paginated responses that also carry a `pagination` object, which would otherwise be dropped. |

### Example

```typescript
import { RouteBuilder } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { z } from 'zod';

const getProduct: RouteDefinition = new RouteBuilder()
  .get('/:id')
  .openapi({
    summary: 'Get product by ID',
    tags: ['products'],
    operationId: 'getProductById',
    pathParams: {
      id: { schema: z.coerce.number(), description: 'Product ID' },
    },
    responses: [
      { statusCode: 200, description: 'Product details' },
      { statusCode: 404, description: 'Product not found' },
    ],
  })
  .handle(async (req, res) => {
    res.json({ id: Number(req.params.id) });
  });

const listProducts: RouteDefinition = new RouteBuilder()
  .get('/')
  .openapi({
    summary: 'List products',
    tags: ['products'],
    envelope: 'body', // paginated response — keep the pagination object
    responses: [{ statusCode: 200, description: 'Paginated product list' }],
  })
  .handle(async (_req, res) => {
    res.json({ success: true, data: [], pagination: { total: 0, page: 1, limit: 20, pages: 0 } });
  });

export { getProduct, listProducts };
```

---

## Dependency Injection

### ServiceContainer

Dependency injection container managing the lifecycle of application services. Each HTTP request receives its own container attached as `req.services`, sharing one registry (definitions plus singleton cache) per `WebApplication` instance.

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
  getInput<T = {
    params: Record<string, unknown>;
    query: Record<string, unknown>;
    body: Record<string, unknown>;
  }>(): T;
  set(name: string, service: unknown): void;
  get<T = unknown>(name: string, defaultValue?: T): Promise<T>;
  registerService(service: ServiceDefinition): void;
  isRegistered(name: string): boolean;
  getRegisteredServices(): string[];
  disposeAll(): Promise<void>;
}
```

#### Constructor

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `registry` | `ServiceRegistry` | Yes | — | Shared registry of service definitions and singleton instances. |
| `settings` | `ApplicationSettings` | Yes | — | Application settings passed to service factories. |
| `req` | `Request` | No | `undefined` | Express request; required for per-request services. |
| `res` | `Response` | No | `undefined` | Express response; required for per-request services. |
| `next` | `NextFunction` | No | `undefined` | Express next function; required for per-request services. |

#### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `getUser` | `getUser<T = unknown>(): T \| undefined` | `T \| undefined` | Returns the authenticated user stored under the `'user'` service, or `undefined`. |
| `getParams` | `getParams<T = unknown>(): T` | `T` | Returns the merged, validated request parameters (params + query + body). Returns `{}` when none were stored. |
| `getInput` | `getInput<T>(): T` | `T` | Returns the separated input sources `{ params, query, body }` (raw, unmerged). Returns empty objects when none were stored. |
| `set` | `set(name: string, service: unknown): void` | `void` | Manually sets a service instance in this container, overriding any resolved value. |
| `get` | `get<T = unknown>(name: string, defaultValue?: T): Promise<T>` | `Promise<T>` | Resolves a service, creating it if needed and resolving its `dependencies` first. Returns `defaultValue` when the service is not registered (and a default was provided); otherwise throws. |
| `registerService` | `registerService(service: ServiceDefinition): void` | `void` | Registers a service definition. Throws `Service "<name>" is already registered` on duplicates; use `set()` to replace an instance. |
| `isRegistered` | `isRegistered(name: string): boolean` | `boolean` | Whether a definition exists for the name. |
| `getRegisteredServices` | `getRegisteredServices(): string[]` | `string[]` | Names of all registered services. |
| `disposeAll` | `disposeAll(): Promise<void>` | `Promise<void>` | Runs each created singleton's optional `dispose()` function, then clears the singleton cache. |

#### Errors Thrown by `get()`

| Condition | Message |
|-----------|---------|
| Service not registered, no default | `Service "<name>" is not registered` |
| Circular dependency detected | `Circular dependency detected: a -> b -> c -> a` |
| Per-request service accessed without request context | `Service "<name>" is per-request and can only be accessed during HTTP request handling` |

#### Example

```typescript
import { BaseController, WebApplication } from 'blendsdk/webafx';
import type { Request, Response } from 'express';
import type { RouteDefinition, ServiceDefinition } from 'blendsdk/webafx';

interface GreetingService {
  greet(name: string): Promise<string>;
}

interface RequestInfo {
  params: { name: string };
}

const greeterService: ServiceDefinition<GreetingService> = {
  name: 'greeter',
  type: 'singleton',
  factory: () => ({
    greet: async (name: string) => `Hello, ${name}!`,
  }),
  dispose: () => {
    console.log('greeter disposed');
  },
};

class GreetingController extends BaseController {
  routes(): RouteDefinition[] {
    return [this.route().get('/greet/:name').handle(this.greet)];
  }

  private greet = async (req: Request, res: Response): Promise<void> => {
    const greeter = await req.services.get<GreetingService>('greeter');
    const input = req.services.getInput<RequestInfo>();
    const message = await greeter.greet(input.params.name);
    this.ok(res, { message });
  };
}

const app = new WebApplication({ PORT: 3000 });
app.registerService(greeterService);
app.registerController('/api', GreetingController);

const shutdown = await app.start();
// GET /api/greet/Ada → { "success": true, "data": { "message": "Hello, Ada!" } }
await shutdown();
```

---

### ServiceDefinition

Blueprint for a service. Register it with `app.registerService()` or `container.registerService()` before the application starts.

```typescript fragment
interface ServiceDefinition<T = unknown> {
  name: string;
  factory: SingletonFactory<T> | PerRequestFactory<T>;
  type: 'singleton' | 'per-request';
  dependencies?: string[];
  dispose?: (instance: T) => void | Promise<void>;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Unique service name. Duplicate registration is rejected. |
| `factory` | `SingletonFactory<T> \| PerRequestFactory<T>` | Creates the service instance. The parameter shape depends on `type`. |
| `type` | `'singleton' \| 'per-request'` | Lifecycle. Singles are created once per registry; per-request services are created fresh for every request. |
| `dependencies` | `string[]` | Service names resolved before the factory runs. Cycles are detected and rejected. |
| `dispose` | `(instance: T) => void \| Promise<void>` | Optional cleanup for created singletons; called by `disposeAll()` during application shutdown. |

---

### ServiceRegistry

The shared registry object owned by a `WebApplication` instance and passed to every `ServiceContainer`.

| Property | Type | Description |
|----------|------|-------------|
| `definitions` | `Record<string, ServiceDefinition>` | Registered service blueprints. |
| `singletons` | `Record<string, unknown>` | Cache of already-created singleton instances. |

---

### Factory Types

```typescript fragment
type SingletonFactory<T = unknown> = (
  container: ServiceContainer,
  settings: ApplicationSettings
) => T | Promise<T>;

type PerRequestFactory<T = unknown> = (
  container: ServiceContainer,
  settings: ApplicationSettings,
  req: Request,
  res: Response,
  next: NextFunction
) => T | Promise<T>;
```

| Type | Description |
|------|-------------|
| `SingletonFactory<T>` | Called once per singleton; the result is cached in the registry and shared across all containers and requests. |
| `PerRequestFactory<T>` | Called for each request with the full request context (`req`, `res`, `next`). Can only run during HTTP request handling. |

---

## Plugins

### PluginDefinition

Registration object passed to `WebApplication.use()`.

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

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Unique plugin name. Duplicate registration throws `Plugin "<name>" is already registered`. |
| `factory` | `(params) => Promise<Plugin \| void>` | Called at startup with the application, the Express instance, and a plugin-scoped logger. May add middleware, register services, and return a `Plugin` object (or nothing). |
| `priority` | `number` | Install order. Lower numbers install first. Default: `100`. Plugins with equal priority keep registration order. |

### Plugin

Optional hooks an installed plugin may return.

```typescript fragment
interface Plugin {
  health?: () => Promise<boolean>;
  shutdown?: () => Promise<void>;
  terminal?: (params: PluginTerminalParams) => void | Promise<void>;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `health` | `() => Promise<boolean>` | Aggregated into `GET /health`. Returns `200` only when every plugin health check passes; otherwise `503`. |
| `shutdown` | `() => Promise<void>` | Called during graceful shutdown, after singleton services are disposed. Plugins shut down in install order. |
| `terminal` | `(params: PluginTerminalParams) => void \| Promise<void>` | Mounts catch-all middleware after controllers and `/health` but before the 404 handler, so fallbacks (such as an SPA `index.html`) never shadow controller routes. Runs in priority order. |

### PluginTerminalParams

```typescript fragment
interface PluginTerminalParams {
  app: WebApplication;
  express: Express;
  logger: Logger;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `app` | `WebApplication` | The owning application instance. |
| `express` | `Express` | The underlying Express application. |
| `logger` | `Logger` | Logger scoped to the plugin (`Plugin:<name>`). |

### Example

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { PluginDefinition } from 'blendsdk/webafx';

const requestCounterPlugin: PluginDefinition = {
  name: 'request-counter',
  priority: 30,
  factory: async ({ express, logger }) => {
    let count = 0;

    express.use((_req, res, next) => {
      count += 1;
      res.setHeader('X-Request-Count', String(count));
      next();
    });

    await logger.info('Request counter installed');

    return {
      health: async () => true,
      shutdown: async () => {
        await logger.info(`Request counter stopped after ${count} requests`);
      },
    };
  },
};

const app = new WebApplication({ PORT: 3000 });
app.use(requestCounterPlugin);

const shutdown = await app.start();
await shutdown();
```

---

### PluginRegistry

Internal registry powering plugin installation, health aggregation, and shutdown. Exported for completeness; most applications interact with plugins through `WebApplication.use()`.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `register` | `register(def: PluginDefinition): void` | `void` | Registers a plugin definition. Throws on duplicate names. |
| `install` | `install(app: WebApplication, express: Express): Promise<void>` | `Promise<void>` | Installs all registered plugins in priority order, collecting `health`, `shutdown`, and `terminal` hooks. |
| `installTerminals` | `installTerminals(app: WebApplication, express: Express): Promise<void>` | `Promise<void>` | Runs collected terminal hooks in priority order, after controllers and `/health`. |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | Runs every plugin health check; `true` only if all pass (or none are registered). |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Invokes every plugin shutdown hook in install order. |

---

## Static Files and SPA Hosting

### staticFilesPlugin

Creates a plugin that serves static files via Express's built-in `express.static()` middleware, with optional SPA fallback for client-side routing.

```typescript fragment
function staticFilesPlugin(config: StaticFilesConfig): PluginDefinition;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `StaticFilesConfig` | Yes | — | Static file serving configuration. |

**Returns**: `PluginDefinition` — ready to pass to `app.use()`.

Behavior notes:

- The plugin name is `static-files` (or `static-files:<prefix>` when a non-root prefix is set), so multiple instances with different prefixes coexist; identical prefixes are rejected as duplicates.
- The root directory is validated at install time. A missing directory throws `Static files root directory does not exist: <resolved path>` out of `app.start()`.
- The SPA fallback is registered in the terminal phase. It serves `index.html` only for `GET` requests whose path has no file extension and whose `Accept` header includes `text/html` — API calls and missing assets fall through to the 404 handler.

### StaticFilesConfig

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `root` | `string` | Yes | — | Directory to serve files from, resolved relative to `process.cwd()`. Must exist at startup. |
| `prefix` | `string` | No | `'/'` | URL prefix to mount at (for example `'/assets'`). |
| `maxAge` | `string \| number` | No | `0` (no caching) | `Cache-Control` max-age directive; accepts milliseconds or a time string like `'1d'`, `'1h'`, `'30m'`. |
| `immutable` | `boolean` | No | `false` | Adds the `immutable` directive to `Cache-Control`. Use with hashed filenames. |
| `dotfiles` | `'ignore' \| 'allow' \| 'deny'` | No | `'ignore'` | Dotfile handling: pretend they don't exist (404), serve normally, or respond `403`. |
| `index` | `string \| false` | No | `'index.html'` | Directory index file; `false` disables directory indexing. |
| `etag` | `boolean` | No | `true` | Enable ETag generation. |
| `lastModified` | `boolean` | No | `true` | Enable the `Last-Modified` header. |
| `spa` | `boolean` | No | `false` | When `true`, unmatched GET requests that look like client-side routes serve `index.html` (terminal phase). |
| `priority` | `number` | No | `20` | Plugin install priority; lower runs first. |

### Example

```typescript
import { WebApplication, staticFilesPlugin } from 'blendsdk/webafx';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

// Serve the SPA build at /app with long-lived, immutable caching.
// The ./client/build directory must exist before start().
app.use(
  staticFilesPlugin({
    root: './client/build',
    prefix: '/app',
    maxAge: '1y',
    immutable: true,
    spa: true,
  })
);

const shutdown = await app.start();
await shutdown();
```

---

## Security

### csrfMiddleware

Creates an Express middleware that rejects state-changing requests with a missing or wrong CSRF token. Designed for cookie-authenticated applications: a cookie is sent automatically by the browser, so mutating endpoints must require a token a cross-site form cannot read or set.

```typescript fragment
function csrfMiddleware(options?: CsrfOptions): RequestHandler;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `options` | `CsrfOptions` | No | `{}` | Header, exemptions, and token-resolution strategy. |

**Returns**: `RequestHandler` — an Express request handler.

**Behavior**:

- Safe methods pass through; unsafe methods are checked.
- Exact `exempt` entries (`` `${METHOD} ${path}` ``, for example `'POST /webhooks'`) pass through.
- The expected token is resolved from `expectedToken(req)` when provided; otherwise from the named cookie (`cookie` option).
- The client token is read from the configured header (first value when repeated). Header names are matched case-insensitively.
- Comparison is performed by `constantTimeTokenMatch`: it fails when either token is absent, when the expected token is empty, or on any length/content mismatch.
- Failures respond `403` with `{ success: false, error: { code: 'csrf_invalid', message: 'Invalid or missing CSRF token' } }`; safe methods and exempt requests continue to `next()`.
- With neither `expectedToken` nor `cookie` configured, every mutating request is rejected — there is nothing to compare against, so the middleware fails closed.

### CsrfOptions

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `header` | `string` | `'x-csrf-token'` | Header carrying the client token. |
| `safeMethods` | `string[]` | `['GET', 'HEAD', 'OPTIONS']` | Methods exempt because they do not change state. |
| `exempt` | `string[]` | `[]` | Exact `` `${METHOD} ${path}` `` requests that skip the check (for example pre-auth endpoints). |
| `expectedToken` | `(req: Request) => string \| undefined \| Promise<string \| undefined>` | — | Session-bound mode: resolves the expected token for the request (for example from a server-side session). |
| `cookie` | `{ name: string }` | — | Double-submit-cookie mode: compares the header against the named cookie. This is unsigned — defence in depth, not a substitute for binding the token to the session. |

### Example

```typescript
import { WebApplication, csrfPlugin } from 'blendsdk/webafx';
import type { Request } from 'express';

/** Minimal server-side session store for the example. */
const sessionStore = new Map<string, { csrfToken: string }>([
  ['session-1', { csrfToken: 'token-for-session-1' }],
]);

function expectedToken(req: Request): string | undefined {
  const sessionId = req.headers['x-session-id'];
  if (typeof sessionId !== 'string') {
    return undefined;
  }
  return sessionStore.get(sessionId)?.csrfToken;
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

// Every mutating request must present the session's token in x-csrf-token
app.use(csrfPlugin({ expectedToken }));

const shutdown = await app.start();
await shutdown();
```

---

### csrfPlugin

Installs CSRF protection application-wide as a WebAFX plugin. The plugin mounts `csrfMiddleware` through the underlying Express application before controllers are registered, so every mutating request is checked. Plugin priority is `50`.

```typescript fragment
function csrfPlugin(options?: CsrfOptions): PluginDefinition;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `options` | `CsrfOptions` | No | `{}` | Header, exemptions, and token-resolution strategy. |

**Returns**: `PluginDefinition` — pass it to `app.use()`. Use `csrfMiddleware` directly instead when only selected routes need protection (attach it with `RouteBuilder.middleware()`).

---

### constantTimeTokenMatch

Compares two token strings without leaking their contents through timing. A length mismatch fails immediately (the length itself is not secret); an absent or empty expected token always fails, so a request is never accepted because the server had nothing to compare against.

```typescript fragment
function constantTimeTokenMatch(
  provided: string | undefined,
  expected: string | undefined
): boolean;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `provided` | `string \| undefined` | Yes | — | Token sent by the client. |
| `expected` | `string \| undefined` | Yes | — | Token the request must present. |

**Returns**: `boolean` — `true` only when both tokens are present, non-empty (expected), and byte-for-byte equal.

#### Example

```typescript
import { constantTimeTokenMatch } from 'blendsdk/webafx';

console.log(constantTimeTokenMatch('token-123', 'token-123')); // true
console.log(constantTimeTokenMatch('token-123', 'token-124')); // false
console.log(constantTimeTokenMatch(undefined, 'token-123'));   // false
```

---

### rateLimitMiddleware

Creates a rate limiting middleware with in-memory storage — suitable for single-instance deployments. For multi-instance deployments, use a Redis-backed implementation via a plugin. Exceeding the limit throws `RateLimitError` (`429` via the error handler).

```typescript fragment
function rateLimitMiddleware(options?: RateLimitOptions): RequestHandler;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `options` | `RateLimitOptions` | No | `{}` | Rate limiting configuration. |

**Returns**: Express middleware (`RequestHandler`).

**Behavior**:

- Each key (by default the client IP from `req.ip`, falling back to `'unknown'`) gets a fixed window of `windowMs`.
- Every response receives `X-RateLimit-Limit`, `X-RateLimit-Remaining` (never below `0`), and `X-RateLimit-Reset` (Unix timestamp in seconds) headers.
- Once a key exceeds `maxRequests` within its window, the middleware throws `new RateLimitError(message)`, producing a `429` response through the error handler.
- Expired entries are removed by a periodic cleanup interval that does not keep the process alive.

### RateLimitOptions

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `maxRequests` | `number` | `100` | Maximum requests allowed per window. |
| `windowMs` | `number` | `60000` | Window duration in milliseconds. |
| `keyExtractor` | `(req: Request) => string` | `(req) => req.ip \|\| 'unknown'` | Derives the rate-limit key from the request. |
| `message` | `string` | `'Rate limit exceeded'` | Message used for the rate limit error. |

#### Example

```typescript
import { BaseController, WebApplication, rateLimitMiddleware } from 'blendsdk/webafx';
import type { Request, Response } from 'express';
import type { RouteDefinition } from 'blendsdk/webafx';

class SearchController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get('/search')
        .middleware(rateLimitMiddleware({ maxRequests: 10, windowMs: 60_000 }))
        .handle(this.search),
    ];
  }

  private search = async (_req: Request, res: Response): Promise<void> => {
    this.ok(res, { results: [] });
  };
}

const app = new WebApplication({ PORT: 3000 });
app.registerController('/api', SearchController);

const shutdown = await app.start();
await shutdown();
```

---

## Logging

### Logger

Interface implemented by all loggers. Every method is async so logging backends can be awaited. `WebApplication.setLogger()` accepts any implementation.

```typescript fragment
interface Logger {
  info: (message: string, data?: Record<string, any>) => Promise<void>;
  error: (message: string, data?: Record<string, any>) => Promise<void>;
  warn: (message: string, data?: Record<string, any>) => Promise<void>;
  debug: (message: string, data?: Record<string, any>) => Promise<void>;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `info` | `(message: string, data?: Record<string, any>) => Promise<void>` | Log an informational message. |
| `error` | `(message: string, data?: Record<string, any>) => Promise<void>` | Log an error message. |
| `warn` | `(message: string, data?: Record<string, any>) => Promise<void>` | Log a warning message. |
| `debug` | `(message: string, data?: Record<string, any>) => Promise<void>` | Log a debug message. |

---

### LogLevel

```typescript fragment
type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
```

Levels act as a threshold; lower numbers are higher priority.

| Level | Numeric value | Logs |
|-------|---------------|------|
| `'ERROR'` | 1 | Errors only |
| `'WARN'` | 2 | Errors and warnings |
| `'INFO'` | 3 | Errors, warnings, and info |
| `'DEBUG'` | 4 | All messages including debug |

---

### ConsoleLogger

Human-readable console logger with configurable level and prefix. Level precedence: constructor argument → `process.env.LOG_LEVEL` (case-insensitive) → `'ERROR'`. `debug()` additionally logs when `process.env.DEBUG === 'true'`. Errors go to `console.error`; all other levels go to `console.log`. Message format: `[LEVEL:PREFIX]: message - {"data":...}`.

```typescript fragment
class ConsoleLogger implements Logger {
  constructor(prefix?: string, logLevel?: LogLevel);

  error(message: string, data?: Record<string, any>): Promise<void>;
  warn(message: string, data?: Record<string, any>): Promise<void>;
  info(message: string, data?: Record<string, any>): Promise<void>;
  debug(message: string, data?: Record<string, any>): Promise<void>;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(prefix?: string, logLevel?: LogLevel)` | `ConsoleLogger` | `prefix` appears uppercased in output (for example `'APP'`, `'Plugin:Auth'`). |
| `error` | `error(message: string, data?: Record<string, any>): Promise<void>` | `Promise<void>` | Logs at ERROR level via `console.error`. |
| `warn` | `warn(message: string, data?: Record<string, any>): Promise<void>` | `Promise<void>` | Logs at WARN level. |
| `info` | `info(message: string, data?: Record<string, any>): Promise<void>` | `Promise<void>` | Logs at INFO level. |
| `debug` | `debug(message: string, data?: Record<string, any>): Promise<void>` | `Promise<void>` | Logs at DEBUG level; also fires when `DEBUG=true` is set in the environment. |

#### Example

```typescript
import { ConsoleLogger } from 'blendsdk/webafx';

const logger = new ConsoleLogger('API', 'INFO');

await logger.info('Server started');
await logger.warn('Slow query detected', { durationMs: 1200 });
// [WARN:API]: Slow query detected - {"durationMs":1200}

await logger.debug('Verbose detail');
// Not printed: the configured level is INFO
```

---

### StructuredLogger

JSON logger for production environments with log aggregation (ELK, CloudWatch, and similar). Every entry is a single JSON line. Level precedence matches `ConsoleLogger`; `ERROR` entries go to `console.error`, all other levels to `console.log`.

```typescript fragment
class StructuredLogger implements Logger {
  constructor(
    prefix?: string,
    logLevel?: LogLevel,
    contextFn?: () => Record<string, unknown>
  );

  error(message: string, data?: Record<string, unknown>): Promise<void>;
  warn(message: string, data?: Record<string, unknown>): Promise<void>;
  info(message: string, data?: Record<string, unknown>): Promise<void>;
  debug(message: string, data?: Record<string, unknown>): Promise<void>;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(prefix?: string, logLevel?: LogLevel, contextFn?: () => Record<string, unknown>)` | `StructuredLogger` | `contextFn` is called for every entry; its keys are merged into the log object (for example to attach `getRequestId()`). |
| `error` | `error(message: string, data?: Record<string, unknown>): Promise<void>` | `Promise<void>` | Writes an ERROR entry via `console.error`. |
| `warn` | `warn(message: string, data?: Record<string, unknown>): Promise<void>` | `Promise<void>` | Writes a WARN entry. |
| `info` | `info(message: string, data?: Record<string, unknown>): Promise<void>` | `Promise<void>` | Writes an INFO entry. |
| `debug` | `debug(message: string, data?: Record<string, unknown>): Promise<void>` | `Promise<void>` | Writes a DEBUG entry; also fires when `DEBUG=true` is set in the environment. |

### LogEntry

The JSON shape written by `StructuredLogger`.

| Property | Type | Description |
|----------|------|-------------|
| `timestamp` | `string` | ISO 8601 timestamp. |
| `level` | `'ERROR' \| 'WARN' \| 'INFO' \| 'DEBUG'` | Log level. |
| `message` | `string` | Log message. |
| `prefix` | `string` | Logger prefix, when set. |
| `requestId` | `string` | Optional request ID from async context (typically supplied through `contextFn`). |
| `data` | `Record<string, unknown>` | Additional data, when provided. |
| `[key: string]` | `unknown` | Any additional context contributed by `contextFn`. |

#### Example

```typescript
import { StructuredLogger, WebApplication, getRequestId } from 'blendsdk/webafx';

const logger = new StructuredLogger('APP', 'INFO', () => ({
  requestId: getRequestId() ?? 'no-request',
}));

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });
app.setLogger(logger);

await logger.info('Structured logging enabled');
// {"timestamp":"2026-02-08T18:30:00.000Z","level":"INFO","message":"Structured logging enabled","prefix":"APP","requestId":"no-request"}

await logger.info('User login', { userId: 42 });
// {"timestamp":"...","level":"INFO","message":"User login","prefix":"APP","requestId":"no-request","data":{"userId":42}}

const shutdown = await app.start();
await shutdown();
```

---

## Request Context

### RequestContext

Request-scoped data propagated through async operations via `AsyncLocalStorage`. WebAFX creates one context per request; it is accessible anywhere in the async call chain without passing parameters.

| Property | Type | Description |
|----------|------|-------------|
| `requestId` | `string` | Unique request ID for tracing. Mirrored on `req.id` and the `X-Request-ID` response header. |
| `startTime` | `number` | Request start time in milliseconds since the epoch. |
| `[key: string]` | `unknown` | Additional context properties can be added dynamically. |

---

### requestContextStorage

The shared `AsyncLocalStorage` instance holding the current request context.

```typescript fragment
const requestContextStorage: AsyncLocalStorage<RequestContext>;
```

Use `requestContextStorage.run(context, callback)` to execute code inside a request scope — for example when running background work that should inherit the current request's context. Most applications read context through `getRequestContext()` or `getRequestId()` instead.

---

### getRequestContext

Returns the current request context if the caller is inside a request scope.

```typescript fragment
function getRequestContext(): RequestContext | undefined;
```

**Returns**: `RequestContext | undefined` — `undefined` when called outside a request (for example in a background job or before startup completes).

---

### getRequestId

Returns the current request ID if the caller is inside a request scope.

```typescript fragment
function getRequestId(): string | undefined;
```

**Returns**: `string | undefined` — shorthand for `getRequestContext()?.requestId`.

#### Example

```typescript
import { getRequestContext, getRequestId } from 'blendsdk/webafx';

function logProgress(message: string): void {
  const context = getRequestContext();
  const requestId = getRequestId() ?? 'no-request';

  if (context) {
    console.log(`[${requestId}] ${message} (${Date.now() - context.startTime}ms elapsed)`);
  } else {
    console.log(`[background] ${message}`);
  }
}

logProgress('Outside a request scope'); // [background] Outside a request scope
```

---

## Errors

### ApiError

Base class for all API errors. Extend it to create custom error types; the built-in error handler serializes every `ApiError` instance with its own status code and code.

```typescript fragment
class ApiError extends Error {
  constructor(statusCode: number, code: string, message: string, details?: any);

  statusCode: number;
  code: string;
  message: string;
  details?: any;
  name: string;
  toJSON(): StandardErrorResponse;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `statusCode` | `number` | HTTP status code sent to the client. |
| `code` | `string` | Machine-readable error code (for example `'NOT_FOUND'`). |
| `message` | `string` | Human-readable message. |
| `details` | `any` | Optional structured details (for example field-level validation errors). |
| `name` | `string` | Set to the concrete class name automatically. |

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `toJSON` | `toJSON(): StandardErrorResponse` | `StandardErrorResponse` | Converts the error into the standard error envelope, including an ISO timestamp and, when present, the details object. |

#### Example

```typescript
import { ApiError } from 'blendsdk/webafx';

try {
  throw new ApiError(402, 'PAYMENT_REQUIRED', 'Subscription expired', {
    renewalUrl: 'https://example.com/billing',
  });
} catch (error) {
  if (error instanceof ApiError) {
    const body = error.toJSON();
    console.log(body.error.code);       // 'PAYMENT_REQUIRED'
    console.log(body.error.statusCode); // 402
  }
}
```

---

### HTTP Error Classes

Nine ready-made error classes covering common HTTP statuses. Each extends `ApiError` and shares the same constructor shape:

```typescript fragment
class <HttpError> extends ApiError {
  constructor(message?: string, details?: any);
}
```

| Class | Status | `code` | Default `message` |
|-------|--------|--------|-------------------|
| `BadRequestError` | 400 | `'BAD_REQUEST'` | `'Bad Request'` |
| `UnauthorizedError` | 401 | `'UNAUTHORIZED'` | `'Unauthorized'` |
| `ForbiddenError` | 403 | `'FORBIDDEN'` | `'Forbidden'` |
| `NotFoundError` | 404 | `'NOT_FOUND'` | `'Not Found'` |
| `ConflictError` | 409 | `'CONFLICT'` | `'Conflict'` |
| `ValidationError` | 422 | `'VALIDATION_ERROR'` | `'Validation Failed'` |
| `RateLimitError` | 429 | `'RATE_LIMIT_EXCEEDED'` | `'Rate Limit Exceeded'` |
| `InternalServerError` | 500 | `'INTERNAL_SERVER_ERROR'` | `'Internal Server Error'` |
| `ServiceUnavailableError` | 503 | `'SERVICE_UNAVAILABLE'` | `'Service Unavailable'` |

#### How Errors Reach the Client

Handlers throw; `WebApplication`'s built-in error handler catches and serializes:

- `ApiError` subclasses keep their `statusCode`, `code`, `message`, and `details`.
- Any other `Error` becomes `500 INTERNAL_SERVER_ERROR`. The real message and stack are included only outside production; in production the message is `'Internal Server Error'` and the stack is omitted.
- Every error response carries a `timestamp` plus the request's `requestId` and `path`.
- Logger failures never prevent a response — the error handler still answers the client.

#### Example

```typescript
import { BaseController, ConflictError, WebApplication } from 'blendsdk/webafx';
import type { Request, Response } from 'express';
import type { RouteDefinition } from 'blendsdk/webafx';

class UserController extends BaseController {
  routes(): RouteDefinition[] {
    return [this.route().post('/users').handle(this.createUser)];
  }

  private createUser = async (req: Request, res: Response): Promise<void> => {
    if (req.body.email === 'taken@example.com') {
      throw new ConflictError('Email is already registered', {
        email: req.body.email,
      });
    }
    this.created(res, { id: 1, email: req.body.email });
  };
}

const app = new WebApplication({ PORT: 3000 });
app.registerController('/api', UserController);

const shutdown = await app.start();
// POST /api/users with a taken email → 409
// { "success": false, "error": { "code": "CONFLICT", "message": "Email is already registered", "statusCode": 409, ... } }
await shutdown();
```

---

### StandardErrorResponse

Standard error envelope used consistently across the application.

```typescript fragment
{
  success: false,
  error: {
    code: 'NOT_FOUND',
    message: 'Cannot GET /api/missing',
    statusCode: 404,
    timestamp: '2026-02-08T18:30:00.000Z',
    requestId: '550e8400-e29b-41d4-a716-446655440000',
    path: '/api/missing'
  }
}
```

| Property | Type | Description |
|----------|------|-------------|
| `success` | `false` | Literal discriminator for error responses. |
| `error` | `object` | The error description (see below). |

#### `error` object

| Property | Type | Description |
|----------|------|-------------|
| `code` | `string` | Machine-readable error code. |
| `message` | `string` | Human-readable message. |
| `statusCode` | `number` | HTTP status code. |
| `details` | `unknown` | Optional structured details (for example validation issues). |
| `timestamp` | `string` | ISO 8601 timestamp of the error. |
| `requestId` | `string` | Request ID when the request context is available. |
| `path` | `string` | Request path that produced the error. |
| `stack` | `string` | Stack trace, included only outside production. |

---

### ErrorResponse

Legacy error response format. Kept for backward compatibility.

| Property | Type | Description |
|----------|------|-------------|
| `error` | `object` | Legacy single-level envelope: `{ code, message, details?, statusCode, timestamp?, requestId?, path?, stack? }`. |

**Deprecated**: use `StandardErrorResponse` (produced automatically by the framework) instead.

---

### ValidationErrorDetail

Field-level validation error detail.

| Property | Type | Description |
|----------|------|-------------|
| `field` | `string` | Name of the offending field. |
| `message` | `string` | What is wrong with the field. |
| `value` | `any` | Optional rejected value. |

---

## Express Request Augmentation

Importing `blendsdk/webafx` augments the global Express `Request` interface so `req.services` and `req.id` are available with full type safety inside every handler and middleware.

```typescript fragment
declare global {
  namespace Express {
    interface Request {
      services: ServiceContainer;
      id?: string;
    }
  }
}
```

| Property | Type | Description |
|----------|------|-------------|
| `services` | `ServiceContainer` | Per-request dependency injection container, attached before plugin middleware and controller routes run. |
| `id` | `string` | Unique request ID for tracing, also sent as the `X-Request-ID` response header. A valid incoming UUID in the `X-Request-ID` request header is reused; anything else is replaced with a new UUID. |

### Example

```typescript
import type { Request } from 'express';

async function resolveUser(req: Request): Promise<unknown> {
  const requestId = req.id ?? 'unknown';
  console.log(`resolving user for request ${requestId}`);
  return req.services.get('user', undefined);
}
```

---

## Deprecated Exports

### preparseServiceNames

Assigns each key of a class to itself, producing string constants for legacy service-name classes. Kept for backward compatibility.

```typescript fragment
function preparseServiceNames(clazz: any): void;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `clazz` | `any` | Yes | — | Class whose keys are converted to string constants. |

**Returns**: `void`

**Deprecated**: emits a `[WebAFX DEPRECATION WARNING]` to the console. Use `as const` objects instead; this function will be removed in the next major version.

```typescript fragment
// OLD (deprecated):
class MyServiceNames {
  static LOGGER_SERVICE: string;
  static SOME_SERVICE: string;
}
preparseServiceNames(MyServiceNames);

// NEW (recommended):
export const ServiceNames = {
  LOGGER_SERVICE: 'LOGGER_SERVICE',
  SOME_SERVICE: 'SOME_SERVICE',
} as const;
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
