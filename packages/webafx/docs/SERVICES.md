# Service Container (Dependency Injection)

> **Package**: `@blendsdk/webafx`
> **Back to**: [README](../README.md)

## Overview

WebAFX includes a built-in dependency injection container that supports two service lifecycles: **singleton** (application-scoped) and **per-request** (request-scoped). Services are registered before the application starts and resolved lazily on first access.

## Service Lifecycles

### Singleton Services

Created **once** when first requested. Shared across all HTTP requests. Ideal for database connections, external API clients, and caches.

```typescript
app.registerService({
  name: 'db',
  type: 'singleton',
  factory: async (container, settings) => {
    const db = new PostgreSQLDatabase({
      host: settings.get('DB_HOST', 'localhost'),
      port: settings.get('DB_PORT', 5432),
      database: settings.get('DB_NAME', 'myapp'),
    });
    await db.connect();
    return db;
  },
  // Optional: cleanup on application shutdown
  dispose: async (db) => {
    await db.disconnect();
  },
});
```

**Factory signature**: `(container: ServiceContainer, settings: ApplicationSettings) => T | Promise<T>`

### Per-Request Services

Created **fresh for each HTTP request**. Have access to the Express `req`, `res`, and `next` objects. Ideal for request-scoped data like the authenticated user.

```typescript
app.registerService({
  name: 'currentUser',
  type: 'per-request',
  factory: async (container, settings, req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return null;

    try {
      const payload = jwt.verify(token, settings.get('JWT_SECRET'));
      return payload;
    } catch {
      return null;
    }
  },
});
```

**Factory signature**: `(container: ServiceContainer, settings: ApplicationSettings, req: Request, res: Response, next: NextFunction) => T | Promise<T>`

## ServiceDefinition Interface

```typescript
interface ServiceDefinition<T = unknown> {
  /** Unique service name */
  name: string;
  /** Service lifecycle type */
  type: 'singleton' | 'per-request';
  /** Factory function to create the service */
  factory: SingletonFactory<T> | PerRequestFactory<T>;
  /** Optional: names of services this depends on */
  dependencies?: string[];
  /** Optional: cleanup function called on application shutdown (singletons only) */
  dispose?: (instance: T) => void | Promise<void>;
}
```

## Accessing Services

### In Route Handlers

Every request has a `req.services` container with resolved singletons and per-request services:

```typescript
class MyController extends BaseController {
  async handler(req: Request, res: Response) {
    // Resolve a service (async — may trigger lazy creation)
    const db = await req.services.get<Database>('db');

    // Get with fallback value (returns fallback if service not registered)
    const cache = await req.services.get<Cache>('cache', null);

    // Get validated request parameters
    const params = req.services.getParams<{ id: string; name: string }>();

    // Get separated input sources (params, query, body)
    const input = req.services.getInput<{
      params: { id: string };
      query: { sort: string };
      body: { name: string };
    }>();

    // Get authenticated user (set by auth plugin/middleware)
    const user = req.services.getUser<User>();
  }
}
```

### Built-in Service Keys

These service keys are managed by WebAFX internally:

| Key | Type | Description |
|-----|------|-------------|
| `user` | Per-request | Authenticated user (set by auth plugins via `req.services.set('user', user)`) |
| `request-params` | Per-request | Validated and merged request parameters (auto-set by route handler) |
| `request-input` | Per-request | Separated request input `{ params, query, body }` (auto-set by route handler) |
| `logger` | Singleton | Default logger (ConsoleLogger, used as fallback in error handler) |

### Setting Values Manually

```typescript
// In middleware or plugins:
req.services.set('user', authenticatedUser);
req.services.set('tenant', tenantInfo);

// Later in handlers:
const user = req.services.getUser();
const tenant = await req.services.get('tenant');
```

## Service Dependencies

Services can declare dependencies on other services. Dependencies are resolved automatically before the factory is called:

```typescript
app.registerService({
  name: 'userService',
  type: 'singleton',
  dependencies: ['db'], // 'db' will be resolved first
  factory: async (container, settings) => {
    const db = await container.get<Database>('db');
    return new UserService(db);
  },
});
```

### Circular Dependency Detection

WebAFX detects circular dependencies at resolution time and throws an error:

```
Error: Circular dependency detected: serviceA -> serviceB -> serviceA
```

## Service Disposal

Singleton services with a `dispose` function are cleaned up during graceful shutdown:

```typescript
app.registerService({
  name: 'db',
  type: 'singleton',
  factory: async () => {
    const pool = new Pool(config);
    return pool;
  },
  dispose: async (pool) => {
    await pool.end(); // Close all connections
  },
});
```

**Disposal order**: All singletons are disposed concurrently via `Promise.all()`, then plugins are shut down.

## ServiceContainer API

```typescript
class ServiceContainer {
  // Resolve a service by name (lazy creation)
  get<T>(name: string, defaultValue?: T): Promise<T>;

  // Manually set a service value
  set(name: string, service: unknown): void;

  // Get authenticated user
  getUser<T>(): T | undefined;

  // Get validated request parameters (merged)
  getParams<T>(): T;

  // Get separated request input
  getInput<T>(): T;

  // Register a new service definition
  registerService(service: ServiceDefinition): void;

  // Check if a service is registered
  isRegistered(name: string): boolean;

  // List all registered service names
  getRegisteredServices(): string[];

  // Dispose all singleton services (called during shutdown)
  disposeAll(): Promise<void>;
}
```

## Patterns

### Database Service

```typescript
app.registerService({
  name: 'db',
  type: 'singleton',
  factory: async (container, settings) => {
    const db = new PostgreSQLDatabase({
      host: settings.get('DB_HOST'),
      database: settings.get('DB_NAME'),
    });
    await db.connect();
    return db;
  },
  dispose: async (db) => await db.disconnect(),
});
```

### Cache Service

```typescript
app.registerService({
  name: 'cache',
  type: 'singleton',
  factory: () => new Map<string, { value: unknown; expires: number }>(),
  dispose: (cache) => cache.clear(),
});
```

### Request Logger

```typescript
app.registerService({
  name: 'requestLogger',
  type: 'per-request',
  factory: (container, settings, req) => {
    return new ConsoleLogger(`REQ:${req.id}`, settings.get('LOG_LEVEL'));
  },
});
```

## Isolation

Each `WebApplication` instance owns its own `ServiceRegistry`, ensuring complete isolation between application instances. This is critical for testing — multiple test apps can run concurrently without state leakage.

---

**Back to**: [README](../README.md) | **Prev**: [Controllers](./CONTROLLERS.md) | **Next**: [Plugins](./PLUGINS.md)
