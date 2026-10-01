# @blendsdk/webafx

A production-ready Express.js framework with dependency injection, plugin architecture, controller-based routing, and built-in security features.

## Features

- ✅ **Type-Safe** — Full TypeScript support with generics
- ✅ **Service Container** — Dependency injection with singleton and per-request lifecycles
- ✅ **Controller-Based Routing** — Clean, testable route definitions with fluent API
- ✅ **Plugin System** — Extensible architecture with priority ordering, health checks, and shutdown
- ✅ **Validation** — Built-in Zod schema validation for request data
- ✅ **Security** — CORS, Helmet security headers, request ID tracking
- ✅ **Rate Limiting** — Built-in in-memory rate limiter with standard headers
- ✅ **Graceful Shutdown** — Proper connection draining and cleanup on SIGTERM/SIGINT
- ✅ **Structured Logging** — Console and JSON loggers with configurable levels
- ✅ **Request Context** — AsyncLocalStorage-based request context propagation
- ✅ **Error Handling** — Typed HTTP errors with standardized JSON responses
- ✅ **Static Files & SPA** — Serve static files and Single Page Applications with typed config
- ✅ **Lifecycle Hooks** — beforeStart, afterStart, beforeShutdown, afterShutdown

## Installation

```bash
yarn add @blendsdk/webafx express zod
yarn add -D @types/express
```

## Quick Start

```typescript
import { WebApplication, BaseController } from '@blendsdk/webafx';
import { Request, Response } from 'express';
import { z } from 'zod';

// 1. Define a controller
class HelloController extends BaseController {
  routes() {
    return [
      this.route()
        .get('/')
        .handle(this.hello),

      this.route()
        .post('/')
        .validate(z.object({
          name: z.string().min(1),
          email: z.string().email(),
        }))
        .handle(this.create),
    ];
  }

  async hello(req: Request, res: Response) {
    res.json({ message: 'Hello, World!' });
  }

  async create(req: Request, res: Response) {
    const params = req.services.getParams<{ name: string; email: string }>();
    res.status(201).json({ user: params });
  }
}

// 2. Create and configure application
const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'development',
  LOG_LEVEL: 'INFO',
});

// 3. Register controller
app.registerController('/api/hello', HelloController);

// 4. Start server
const shutdown = await app.start();
// Server listening on http://localhost:3000

// Graceful shutdown (automatic on SIGTERM/SIGINT)
// await shutdown();
```

## Documentation

| Document | Description |
|----------|-------------|
| **[README.md](./README.md)** | This file — overview, quick start, and core concepts |
| **[docs/CONFIGURATION.md](./docs/CONFIGURATION.md)** | Configuration reference and environment setup |
| **[docs/CONTROLLERS.md](./docs/CONTROLLERS.md)** | Controllers, routing, validation, and response helpers |
| **[docs/SERVICES.md](./docs/SERVICES.md)** | Service container, dependency injection, and lifecycles |
| **[docs/PLUGINS.md](./docs/PLUGINS.md)** | Plugin development guide with examples |
| **[docs/SECURITY.md](./docs/SECURITY.md)** | Security features — CORS, CSRF, rate limiting, headers |
| **[docs/ERRORS.md](./docs/ERRORS.md)** | Error handling, error classes, and response format |
| **[docs/LOGGING.md](./docs/LOGGING.md)** | Logging system — ConsoleLogger, StructuredLogger |
| **[docs/MIDDLEWARE.md](./docs/MIDDLEWARE.md)** | Built-in and custom middleware |
| **[docs/STATIC-FILES.md](./docs/STATIC-FILES.md)** | Static file serving and SPA fallback |
| **[docs/TESTING.md](./docs/TESTING.md)** | Testing patterns with Vitest and supertest |
| **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** | System architecture and request lifecycle |
| **[API.md](./API.md)** | Complete API reference for all classes and interfaces |

## Core Concepts

### Application Lifecycle

```
new WebApplication(config)
  ↓
app.registerService(...)     // Register DI services
app.use(plugin)              // Register plugins
app.registerController(...)  // Register controllers
app.on('beforeStart', ...)   // Register lifecycle hooks
  ↓
await app.start()
  ↓
1. Load .env.js / .env.local.js configuration
2. Run beforeStart hooks
3. Setup core middleware (CORS, body parsers, request ID, Helmet)
4. Attach service container to each request
5. Install plugins (in priority order)
6. Register controller routes
7. Setup /health endpoint
8. Setup 404 handler
9. Setup error handler
10. Start HTTP server
11. Run afterStart hooks
  ↓
Server running...
  ↓
SIGTERM/SIGINT received → shutdown()
  ↓
1. Run beforeShutdown hooks
2. Stop accepting new connections
3. Wait for in-flight requests (with timeout)
4. Dispose singleton services
5. Shutdown plugins
6. Run afterShutdown hooks
```

### Controllers & Routing

Controllers organize related routes. Extend `BaseController` and implement `routes()`:

```typescript
class UserController extends BaseController {
  routes() {
    return [
      // Public route
      this.route().get('/').handle(this.list),

      // Validated route
      this.route()
        .post('/')
        .validate(z.object({ name: z.string(), email: z.string().email() }))
        .handle(this.create),

      // Authenticated route
      this.route().get('/me').secure().handle(this.getMe),

      // Authorized route with middleware
      this.route()
        .delete('/:id')
        .secure()
        .authorize(async (req, user) => user?.role === 'admin')
        .middleware(rateLimitMiddleware({ maxRequests: 10 }))
        .handle(this.delete),
    ];
  }
}

app.registerController('/api/users', UserController);
```

See **[docs/CONTROLLERS.md](./docs/CONTROLLERS.md)** for the complete guide.

### Service Container (Dependency Injection)

Register singleton or per-request services:

```typescript
// Singleton — created once, shared across all requests
app.registerService({
  name: 'db',
  type: 'singleton',
  factory: async (container, settings) => {
    const db = new DatabaseClient(settings.get('DATABASE_URL'));
    await db.connect();
    return db;
  },
  dispose: async (db) => await db.disconnect(),
});

// Per-request — created fresh for each HTTP request
app.registerService({
  name: 'currentUser',
  type: 'per-request',
  factory: async (container, settings, req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    return token ? await verifyJWT(token) : null;
  },
});

// Access in controllers
class MyController extends BaseController {
  async handler(req: Request, res: Response) {
    const db = await req.services.get<DatabaseClient>('db');
    const user = req.services.getUser();
    const params = req.services.getParams<{ id: string }>();
  }
}
```

See **[docs/SERVICES.md](./docs/SERVICES.md)** for the complete guide.

### Plugins

Extend the application with reusable plugins:

```typescript
import { PluginDefinition } from '@blendsdk/webafx';

const metricsPlugin: PluginDefinition = {
  name: 'metrics',
  priority: 50, // Lower = installs first (default: 100)

  factory: async ({ app, express, logger }) => {
    await logger.info('Metrics plugin initialized');

    express.use((req, res, next) => {
      // Add metrics middleware
      next();
    });

    return {
      health: async () => true,
      shutdown: async () => {
        await logger.info('Metrics flushed');
      },
    };
  },
};

app.use(metricsPlugin);
```

See **[docs/PLUGINS.md](./docs/PLUGINS.md)** for the complete guide.

### Error Handling

Throw typed HTTP errors anywhere — they're caught and formatted automatically:

```typescript
import { NotFoundError, UnauthorizedError, ValidationError } from '@blendsdk/webafx';

// In a controller handler:
async getUser(req: Request, res: Response) {
  const user = await db.findById(req.params.id);
  if (!user) throw new NotFoundError('User not found');
  res.json({ user });
}
```

Error response format:

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "User not found",
    "statusCode": 404,
    "timestamp": "2026-02-09T10:00:00.000Z",
    "requestId": "abc-123",
    "path": "/api/users/999"
  }
}
```

See **[docs/ERRORS.md](./docs/ERRORS.md)** for all error classes.

### Health Checks

Automatic `/health` endpoint aggregates plugin health:

```bash
curl http://localhost:3000/health
# { "health": true, "timestamp": 1234567890 }
```

## Testing

```typescript
import { describe, test, expect } from 'vitest';
import supertest from 'supertest';
import { WebApplication } from '@blendsdk/webafx';

describe('UserController', () => {
  test('GET /api/users returns 200', async () => {
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
    app.registerController('/api/users', UserController);

    const shutdown = await app.start();
    try {
      const res = await supertest(app.express)
        .get('/api/users')
        .expect(200);

      expect(res.body).toHaveProperty('success', true);
    } finally {
      await shutdown();
    }
  });
});
```

See **[docs/TESTING.md](./docs/TESTING.md)** for comprehensive testing patterns.

## Examples

See the **[playground demo app](../playground/src/demo-app/)** for a complete REST API application demonstrating all WebAFX features including:

- Authentication (JWT) and authorization
- CRUD controllers with validation
- Service container with database integration
- Plugins (auth, caching, metrics)
- Custom middleware
- Rate limiting
- Error handling patterns

## License

MIT
