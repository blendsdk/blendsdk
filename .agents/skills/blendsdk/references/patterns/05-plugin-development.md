# Plugin Development Pattern

> Create reusable WebAFX plugins that add services, middleware, health checks, and shutdown handlers.

**Packages:** `webafx`

---

## Problem

How do I encapsulate reusable cross-cutting concerns (auth, metrics, logging) as a WebAFX plugin?

## Solution

### Plugin Structure

```typescript
import type { PluginDefinition, Plugin } from 'blendsdk/webafx';

const myPlugin: PluginDefinition = {
  name: 'my-plugin',           // Unique name (used in logs and health)
  priority: 50,                // Lower = installs first (default: 100)

  factory: async ({ app, express, logger }) => {
    // app      — WebApplication: registerService(), getSettings()
    // express  — Express app: use() for global middleware
    // logger   — ConsoleLogger: pre-configured with plugin prefix

    await logger.info('Plugin initializing...');

    // 1. Register services
    app.registerService({
      name: 'myService',
      type: 'singleton',
      factory: () => new MyService(),
    });

    // 2. Add global middleware
    express.use((req, res, next) => {
      // Custom middleware logic
      next();
    });

    // 3. Register lifecycle hooks
    app.on('beforeShutdown', async () => {
      await logger.info('Cleaning up...');
    });

    await logger.info('Plugin ready');

    // Return Plugin object with health check and shutdown
    return {
      health: async () => true,
      shutdown: async () => {
        await logger.info('Plugin shutting down');
      },
    };
  },
};
```

### Example: Request Metrics Plugin

```typescript
import type { PluginDefinition } from 'blendsdk/webafx';
import { Request, Response, NextFunction } from 'express';

export const metricsPlugin: PluginDefinition = {
  name: 'metrics',
  priority: 20, // Install early to capture all requests

  factory: async ({ app, express, logger }) => {
    let totalRequests = 0;
    let totalDuration = 0;
    const statusCodes: Record<number, number> = {};

    // Add timing middleware
    express.use((req: Request, res: Response, next: NextFunction) => {
      totalRequests++;
      const start = Date.now();
      res.on('finish', () => {
        totalDuration += Date.now() - start;
        statusCodes[res.statusCode] = (statusCodes[res.statusCode] || 0) + 1;
      });
      next();
    });

    // Register metrics as a service
    app.registerService({
      name: 'metrics',
      type: 'singleton',
      factory: () => ({
        getSummary: () => ({
          totalRequests,
          avgDuration: totalRequests > 0 ? Math.round(totalDuration / totalRequests) : 0,
          statusCodes,
        }),
      }),
    });

    await logger.info('Metrics tracking enabled');

    return {
      health: async () => true,
      shutdown: async () => {
        await logger.info('Final metrics', {
          totalRequests,
          avgDuration: totalRequests > 0 ? Math.round(totalDuration / totalRequests) : 0,
        } as any);
      },
    };
  },
};
```

### Plugin Priority Guidelines

| Priority | Use Case |
|----------|----------|
| 1-20 | Core infrastructure (auth, logging, security) |
| 21-50 | Feature services (cache, metrics, rate limiting) |
| 51-99 | Application-specific plugins |
| 100+ | Low-priority plugins (default) |

### Registering and Using Plugins

```typescript
const app = new WebApplication({ PORT: 3000 });

// Plugins install in priority order during app.start()
app.use(authPlugin);      // priority: 10
app.use(metricsPlugin);   // priority: 20
app.use(cachePlugin);     // priority: 50

const shutdown = await app.start();
// Installation order: authPlugin → metricsPlugin → cachePlugin
```

## Key Points

- **Priority matters** — auth plugins should install before feature plugins
- **Always return `health()`** — it powers the `/health` endpoint aggregation
- **Always return `shutdown()`** — clean up connections, intervals, caches
- **Use the provided `logger`** — it's pre-configured with `Plugin:<name>` prefix
- **Register services via `app.registerService()`** not directly on Express
- Health returns `false` → `/health` returns `503 Service Unavailable`
- Plugins shut down in **registration order** during graceful shutdown
