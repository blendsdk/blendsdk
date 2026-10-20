# @blendsdk/webafx — API Reference

> **Package**: `@blendsdk/webafx`
> **Back to**: [README](./README.md)

Complete API reference for all exported classes, interfaces, types, and functions.

---

## Classes

### WebApplication

Main application class. Manages the complete lifecycle of an Express application.

```typescript
import { WebApplication } from '@blendsdk/webafx';
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `(config?: ApplicationConfig)` | `WebApplication` | Create application with optional config |
| `registerService` | `(service: ServiceDefinition): this` | `this` | Register a DI service |
| `registerController` | `(basePath: string, Controller: Class): void` | `void` | Register a controller at a path |
| `use` | `(plugin: PluginDefinition): this` | `this` | Register a plugin |
| `on` | `(event: LifecycleEvent, hook: LifecycleHook): this` | `this` | Register lifecycle hook |
| `start` | `(): Promise<() => Promise<void>>` | Shutdown fn | Start server, return shutdown function |
| `getSettings` | `<T>(): T` | Settings | Get all settings |
| `express` | (getter) | `Express` | Access underlying Express app |

**Lifecycle Events**: `'beforeStart'` | `'afterStart'` | `'beforeShutdown'` | `'afterShutdown'`

---

### BaseController

Abstract base class for controllers. Provides route building and response helpers.

```typescript
import { BaseController } from '@blendsdk/webafx';
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `(settings: ApplicationSettings, services: ServiceContainer)` | — | Called by WebApplication |
| `routes` | `(): RouteDefinition[]` | Routes | **Abstract** — define controller routes |
| `route` | `(): RouteBuilder` | Builder | Create a new route builder |
| `authenticated` | `(): RouteBuilder` | Builder | Shorthand for `route().secure()` |
| `ok` | `<T>(res: Response, data: T): void` | — | Send 200 with `{ success: true, data }` |
| `created` | `<T>(res: Response, data: T): void` | — | Send 201 with `{ success: true, data }` |
| `paginated` | `<T>(res, data: T[], total, page, limit): void` | — | Send 200 with pagination metadata |
| `noContent` | `(res: Response): void` | — | Send 204 No Content |

**Protected properties**: `settings: ApplicationSettings`, `services: ServiceContainer`

---

### RouteBuilder

Fluent API for defining HTTP routes. Create via `this.route()` in controllers.

```typescript
import { RouteBuilder } from '@blendsdk/webafx';
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `get` | `(path: string): this` | `this` | Define GET route |
| `post` | `(path: string): this` | `this` | Define POST route |
| `put` | `(path: string): this` | `this` | Define PUT route |
| `patch` | `(path: string): this` | `this` | Define PATCH route |
| `delete` | `(path: string): this` | `this` | Define DELETE route |
| `secure` | `(): this` | `this` | Require authentication |
| `authorize` | `(fn: AuthorizeFunction): this` | `this` | Add authorization check |
| `middleware` | `(fn: RequestHandler): this` | `this` | Add route middleware (repeatable) |
| `validate` | `(schema: ZodType): this` | `this` | Add Zod validation |
| `handle` | `(handler: RouteHandler): RouteDefinition` | Definition | Set handler (must be last) |

---

### ServiceContainer

Dependency injection container. Attached to every request as `req.services`.

```typescript
import { ServiceContainer } from '@blendsdk/webafx';
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `get` | `<T>(name: string, defaultValue?: T): Promise<T>` | `T` | Resolve service (lazy creation) |
| `set` | `(name: string, service: unknown): void` | — | Manually set a value |
| `getUser` | `<T>(): T \| undefined` | `T?` | Get authenticated user |
| `getParams` | `<T>(): T` | `T` | Get validated request params (merged) |
| `getInput` | `<T>(): T` | `T` | Get separated `{ params, query, body }` |
| `registerService` | `(service: ServiceDefinition): void` | — | Register a service definition |
| `isRegistered` | `(name: string): boolean` | `boolean` | Check if service exists |
| `getRegisteredServices` | `(): string[]` | Names | List all registered service names |
| `disposeAll` | `(): Promise<void>` | — | Dispose all singletons (shutdown) |

---

### ApplicationSettings

Configuration management with Zod validation.

```typescript
import { ApplicationSettings } from '@blendsdk/webafx';
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `(config?: ApplicationConfig, logger?: ConsoleLogger)` | — | Create with optional config |
| `get` | `<T>(key: string, defaultValue?: T): T` | `T` | Get config value by key |
| `getAll` | `<T extends ApplicationConfig>(): T` | `T` | Get all settings (shallow copy) |
| `isProduction` | `(): boolean` | `boolean` | Check if `ENV_MODE === 'production'` |
| `loadFromFile` | `(jsPath: string): Promise<void>` | — | Load config from JS file |

---

### ConsoleLogger

Human-readable logger for development.

```typescript
import { ConsoleLogger } from '@blendsdk/webafx';
```

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor` | `(prefix?: string, logLevel?: LogLevel)` | Create logger |
| `error` | `(message: string, data?: Record<string, any>): Promise<void>` | Log error |
| `warn` | `(message: string, data?: Record<string, any>): Promise<void>` | Log warning |
| `info` | `(message: string, data?: Record<string, any>): Promise<void>` | Log info |
| `debug` | `(message: string, data?: Record<string, any>): Promise<void>` | Log debug |

**Output**: `[LEVEL:PREFIX]: message - {"key":"value"}`

---

### StructuredLogger

JSON logger for production / log aggregation.

```typescript
import { StructuredLogger } from '@blendsdk/webafx';
```

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor` | `(prefix?: string, logLevel?: LogLevel, contextFn?: () => Record<string, unknown>)` | Create logger |
| `error` | `(message: string, data?: Record<string, unknown>): Promise<void>` | Log error as JSON |
| `warn` | `(message: string, data?: Record<string, unknown>): Promise<void>` | Log warning as JSON |
| `info` | `(message: string, data?: Record<string, unknown>): Promise<void>` | Log info as JSON |
| `debug` | `(message: string, data?: Record<string, unknown>): Promise<void>` | Log debug as JSON |

**Output**: `{"timestamp":"...","level":"INFO","message":"...","prefix":"...","data":{...}}`

---

### ApiError

Base error class for all HTTP errors.

```typescript
import { ApiError } from '@blendsdk/webafx';
```

| Property | Type | Description |
|----------|------|-------------|
| `statusCode` | `number` | HTTP status code |
| `code` | `string` | Machine-readable error code |
| `message` | `string` | Human-readable message |
| `details` | `any?` | Optional additional details |

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `(statusCode, code, message, details?)` | — | Create error |
| `toJSON` | `(): StandardErrorResponse` | JSON | Convert to standard response format |

---

## Error Classes

All extend `ApiError`. Import from `@blendsdk/webafx`:

```typescript
import {
  BadRequestError,        // 400 BAD_REQUEST
  UnauthorizedError,      // 401 UNAUTHORIZED
  ForbiddenError,         // 403 FORBIDDEN
  NotFoundError,          // 404 NOT_FOUND
  ConflictError,          // 409 CONFLICT
  ValidationError,        // 422 VALIDATION_ERROR
  RateLimitError,         // 429 RATE_LIMIT_EXCEEDED
  InternalServerError,    // 500 INTERNAL_SERVER_ERROR
  ServiceUnavailableError // 503 SERVICE_UNAVAILABLE
} from '@blendsdk/webafx';
```

All constructors: `(message?: string, details?: any)`

---

## Interfaces

### ApplicationConfig

```typescript
interface ApplicationConfig {
  DEBUG?: boolean;
  ENV_MODE?: 'production' | 'development' | 'test';
  LOG_LEVEL?: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
  PORT?: number;
  TRUST_PROXY?: boolean;
  BODY_LIMIT?: string;
  SHUTDOWN_TIMEOUT?: number;
  CORS?: boolean | CorsConfig;
  [key: string]: any; // Custom properties allowed
}
```

### CorsConfig

```typescript
interface CorsConfig {
  origin?: string | string[] | ((origin: string | undefined, callback: Function) => void);
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}
```

### ServiceDefinition

```typescript
interface ServiceDefinition<T = unknown> {
  name: string;
  type: 'singleton' | 'per-request';
  factory: SingletonFactory<T> | PerRequestFactory<T>;
  dependencies?: string[];
  dispose?: (instance: T) => void | Promise<void>;
}
```

### PluginDefinition

```typescript
interface PluginDefinition {
  name: string;
  factory: (params: {
    app: WebApplication;
    express: Express;
    logger: Logger;
  }) => Promise<Plugin | void>;
  priority?: number; // Default: 100
}
```

### Plugin

```typescript
interface Plugin {
  health?: () => Promise<boolean>;
  shutdown?: () => Promise<void>;
}
```

### RouteDefinition

```typescript
interface RouteDefinition {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  handler: RouteHandler;
  validation?: ZodType;
  secure?: boolean;
  authorize?: AuthorizeFunction;
  middleware?: RequestHandler[];
}
```

### Logger

```typescript
interface Logger {
  info(message: string, data?: Record<string, any>): Promise<void>;
  error(message: string, data?: Record<string, any>): Promise<void>;
  warn(message: string, data?: Record<string, any>): Promise<void>;
  debug(message: string, data?: Record<string, any>): Promise<void>;
}
```

### StandardErrorResponse

```typescript
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

### StandardSuccessResponse

```typescript
interface StandardSuccessResponse<T = unknown> {
  success: true;
  data: T;
}
```

### PaginatedResponse

```typescript
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

### RequestContext

```typescript
interface RequestContext {
  requestId: string;
  startTime: number;
  [key: string]: unknown;
}
```

### RateLimitOptions

```typescript
interface RateLimitOptions {
  maxRequests?: number;    // Default: 100
  windowMs?: number;       // Default: 60000
  keyExtractor?: (req: Request) => string;
  message?: string;
}
```

### ServiceRegistry

```typescript
interface ServiceRegistry {
  definitions: Record<string, ServiceDefinition>;
  singletons: Record<string, unknown>;
}
```

---

## Types

### LogLevel

```typescript
type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
```

### HttpMethod

```typescript
type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
```

### LifecycleHook

```typescript
type LifecycleHook = () => void | Promise<void>;
```

### RouteHandler

```typescript
type RouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<void> | void;
```

### AuthorizeFunction

```typescript
type AuthorizeFunction<T = any> = (req: Request, user: T) => boolean | Promise<boolean>;
```

### SingletonFactory

```typescript
type SingletonFactory<T = unknown> = (
  container: ServiceContainer,
  settings: ApplicationSettings
) => T | Promise<T>;
```

### PerRequestFactory

```typescript
type PerRequestFactory<T = unknown> = (
  container: ServiceContainer,
  settings: ApplicationSettings,
  req: Request,
  res: Response,
  next: NextFunction
) => T | Promise<T>;
```

---

## Functions

### rateLimitMiddleware

```typescript
function rateLimitMiddleware(options?: RateLimitOptions): RequestHandler;
```

Creates an in-memory rate limiting middleware. Sets `X-RateLimit-*` headers.

### requestIdMiddleware

```typescript
function requestIdMiddleware(): RequestHandler;
```

Generates UUID v4 request IDs, validates incoming `X-Request-ID`, creates AsyncLocalStorage context.

### getRequestContext

```typescript
function getRequestContext(): RequestContext | undefined;
```

Gets the current request context from AsyncLocalStorage.

### getRequestId

```typescript
function getRequestId(): string | undefined;
```

Gets the current request ID from AsyncLocalStorage.

### isValidUUID

```typescript
function isValidUUID(id: string): boolean;
```

Validates whether a string matches UUID v4 format.

### errorHandlerMiddleware

```typescript
function errorHandlerMiddleware(
  logger: (req: Request, error: Error, data: Record<any, string>) => Promise<void>,
  includeStack: boolean
): ErrorRequestHandler;
```

Creates error handling middleware that formats errors into StandardErrorResponse.

### preparseServiceNames (Deprecated)

```typescript
function preparseServiceNames(clazz: any): void;
```

**Deprecated.** Use `const ServiceNames = { KEY: 'KEY' } as const` instead.

---

## Express Augmentation

WebAFX extends the Express `Request` interface:

```typescript
declare global {
  namespace Express {
    interface Request {
      services: ServiceContainer;  // DI container for this request
      id?: string;                  // UUID request ID
    }
  }
}
```

---

## Exports

Everything is exported from the package root:

```typescript
import {
  // Application
  WebApplication,
  BaseController,
  RouteBuilder,
  ServiceContainer,
  ApplicationSettings,

  // Plugins
  PluginDefinition,
  Plugin,
  PluginRegistry,

  // Logging
  ConsoleLogger,
  StructuredLogger,
  Logger,
  LogLevel,

  // Middleware
  rateLimitMiddleware,
  requestIdMiddleware,
  errorHandlerMiddleware,
  getRequestContext,
  getRequestId,
  requestContextStorage,
  isValidUUID,

  // Errors
  ApiError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  RateLimitError,
  InternalServerError,
  ServiceUnavailableError,

  // Types
  ApplicationConfig,
  CorsConfig,
  ServiceDefinition,
  ServiceRegistry,
  SingletonFactory,
  PerRequestFactory,
  RouteDefinition,
  RouteHandler,
  HttpMethod,
  AuthorizeFunction,
  LifecycleHook,
  RateLimitOptions,
  RequestContext,
  StandardErrorResponse,
  StandardSuccessResponse,
  PaginatedResponse,
  LogEntry,
} from '@blendsdk/webafx';
```

---

**Back to**: [README](./README.md)
