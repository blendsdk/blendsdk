# Plugin Development Guide

> **Package**: `@blendsdk/webafx`
> **Back to**: [README](../README.md)

## Overview

Plugins extend WebAFX with reusable functionality. They can add middleware, register services, set up background tasks, and provide health checks and shutdown handlers. Plugins are installed in priority order during application startup.

## Plugin Structure

```typescript
import { PluginDefinition, Plugin } from '@blendsdk/webafx';

const myPlugin: PluginDefinition = {
  /** Unique plugin name (used in logs and health reports) */
  name: 'my-plugin',

  /** Lower priority installs first. Default: 100 */
  priority: 50,

  /**
   * Factory function called during app.start().
   * Receives app instance, Express instance, and a logger.
   * Returns a Plugin object with optional health/shutdown hooks.
   */
  factory: async ({ app, express, logger }) => {
    // Setup logic here...
    await logger.info('Plugin initialized');

    // Return Plugin object (or void if no hooks needed)
    return {
      /** Called by GET /health — return true if healthy */
      health: async () => {
        return true;
      },

      /** Called during graceful shutdown */
      shutdown: async () => {
        await logger.info('Plugin shutting down');
      },
    };
  },
};
```

## Interfaces

### PluginDefinition

```typescript
interface PluginDefinition {
  /** Unique plugin name */
  name: string;
  /** Factory function that creates and initializes the plugin */
  factory: (params: {
    app: WebApplication;
    express: Express;
    logger: Logger;
  }) => Promise<Plugin | void>;
  /** Plugin priority. Lower numbers install first. Default: 100 */
  priority?: number;
}
```

### Plugin

```typescript
interface Plugin {
  /** Optional health check — aggregated into /health endpoint */
  health?: () => Promise<boolean>;
  /** Optional shutdown handler — called during graceful shutdown */
  shutdown?: () => Promise<void>;
}
```

## Registering Plugins

```typescript
const app = new WebApplication({ PORT: 3000 });

app.use(authPlugin);     // priority: 10 — installs first
app.use(cachePlugin);    // priority: 50
app.use(metricsPlugin);  // priority: 100 (default)
```

Plugins install in ascending priority order. Use low priorities for foundational plugins (auth, logging) and higher priorities for feature plugins.

## Plugin Factory Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `app` | `WebApplication` | The application instance. Use for `registerService()`, `getSettings()`. |
| `express` | `Express` | The Express app instance. Use for adding middleware via `express.use()`. |
| `logger` | `Logger` | A pre-configured logger with prefix `Plugin:<name>`. |

## Example Plugins

### JWT Authentication Plugin

```typescript
import { PluginDefinition } from '@blendsdk/webafx';
import jwt from 'jsonwebtoken';

const jwtAuthPlugin: PluginDefinition = {
  name: 'jwt-auth',
  priority: 10, // Install early so other plugins can access user

  factory: async ({ app, express, logger }) => {
    const settings = app.getSettings();
    const secret = settings.get<string>('JWT_SECRET');

    // Add middleware to extract JWT from Authorization header
    express.use(async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        try {
          const token = authHeader.substring(7);
          const payload = jwt.verify(token, secret);
          req.services.set('user', payload);
        } catch {
          // Invalid token — don't set user, let .secure() routes handle it
        }
      }
      next();
    });

    await logger.info('JWT authentication enabled');

    return {
      health: async () => !!secret, // Healthy if secret is configured
    };
  },
};
```

### Cache Plugin

```typescript
import { PluginDefinition } from '@blendsdk/webafx';

interface CacheEntry {
  value: unknown;
  expires: number;
}

const cachePlugin: PluginDefinition = {
  name: 'cache',
  priority: 50,

  factory: async ({ app, logger }) => {
    const cache = new Map<string, CacheEntry>();

    // Register cache as a singleton service
    app.registerService({
      name: 'cache',
      type: 'singleton',
      factory: () => ({
        get: (key: string) => {
          const entry = cache.get(key);
          if (!entry || entry.expires < Date.now()) {
            cache.delete(key);
            return undefined;
          }
          return entry.value;
        },
        set: (key: string, value: unknown, ttlMs: number) => {
          cache.set(key, { value, expires: Date.now() + ttlMs });
        },
        delete: (key: string) => cache.delete(key),
        clear: () => cache.clear(),
        size: () => cache.size,
      }),
    });

    await logger.info('Cache plugin initialized');

    return {
      health: async () => true,
      shutdown: async () => {
        cache.clear();
        await logger.info('Cache cleared');
      },
    };
  },
};
```

### Request Metrics Plugin

```typescript
import { PluginDefinition } from '@blendsdk/webafx';

const metricsPlugin: PluginDefinition = {
  name: 'metrics',
  priority: 20,

  factory: async ({ express, logger }) => {
    const metrics = {
      totalRequests: 0,
      statusCodes: {} as Record<number, number>,
      avgResponseTime: 0,
    };
    let totalDuration = 0;

    express.use((req, res, next) => {
      const start = Date.now();
      metrics.totalRequests++;

      res.on('finish', () => {
        const duration = Date.now() - start;
        totalDuration += duration;
        metrics.avgResponseTime = totalDuration / metrics.totalRequests;
        metrics.statusCodes[res.statusCode] =
          (metrics.statusCodes[res.statusCode] || 0) + 1;
      });

      next();
    });

    await logger.info('Metrics tracking enabled');

    return {
      health: async () => true,
      shutdown: async () => {
        await logger.info(`Final metrics: ${JSON.stringify(metrics)}`);
      },
    };
  },
};
```

## Priority Guidelines

| Priority Range | Use Case |
|---------------|----------|
| 1-20 | Core infrastructure (auth, logging, security) |
| 21-50 | Feature services (cache, metrics, rate limiting) |
| 51-99 | Application-specific plugins |
| 100+ | Low-priority plugins (default) |

## Health Checks

Plugin health checks are aggregated into the `/health` endpoint:

```bash
curl http://localhost:3000/health
# { "health": true, "timestamp": 1234567890 }
```

- Returns `200` with `{ health: true }` if **all** plugin health checks pass
- Returns `503` with `{ health: false }` if **any** plugin health check fails
- If no plugins have health checks, returns `true` (healthy by default)

## Shutdown Order

During graceful shutdown, plugins are shut down in registration order:

```
1. beforeShutdown hooks
2. Singleton service disposal (all in parallel)
3. Plugin shutdown (in registration order)
4. afterShutdown hooks
```

## Best Practices

1. **Set appropriate priority** — Auth plugins should install before feature plugins
2. **Always implement health checks** — They power the `/health` endpoint
3. **Always implement shutdown** — Clean up resources (connections, intervals, caches)
4. **Use the provided logger** — It's pre-configured with your plugin name
5. **Handle errors gracefully** — Don't let plugin errors crash the application
6. **Register services via `app.registerService()`** — Not directly on the Express app

---

**Back to**: [README](../README.md) | **Prev**: [Services](./SERVICES.md) | **Next**: [Security](./SECURITY.md)
