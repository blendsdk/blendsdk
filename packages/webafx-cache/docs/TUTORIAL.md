# @blendsdk/webafx-cache — Tutorial

A step-by-step guide to using `@blendsdk/webafx-cache` in your WebAFX applications.

This tutorial walks through every feature of the caching package, from basic
setup to advanced multi-cache scenarios. Each section builds on the previous
one, so following in order is recommended.

---

## Table of Contents

1. [Installation & Setup](#1-installation--setup)
2. [Basic Usage — In-Memory (Development)](#2-basic-usage--in-memory-development)
3. [Basic Usage — Redis (Production)](#3-basic-usage--redis-production)
4. [Environment-Based Backend Switching](#4-environment-based-backend-switching)
5. [Using Cache in Controllers](#5-using-cache-in-controllers)
6. [Advanced — Multiple Cache Instances](#6-advanced--multiple-cache-instances)
7. [Advanced — Pattern Operations](#7-advanced--pattern-operations)
8. [Testing with Cache](#8-testing-with-cache)
9. [Configuration Reference](#9-configuration-reference)

---

## 1. Installation & Setup

### Installing the Package

```bash
yarn add @blendsdk/webafx-cache
```

### Peer Dependency

`@blendsdk/webafx-cache` uses `@blendsdk/webafx` as a **peer dependency** for its
plugin integration. If you are using the WebAFX plugin system (recommended),
make sure `@blendsdk/webafx` is also installed:

```bash
yarn add @blendsdk/webafx-cache @blendsdk/webafx
```

> **Note:** If you only need standalone cache usage (no WebAFX plugin
> integration), the `@blendsdk/webafx` peer dependency is optional — you
> can instantiate `MemoryCacheProvider` or `RedisCacheProvider` directly.

### TypeScript Configuration

`@blendsdk/webafx-cache` is written in strict TypeScript with ESM-only exports.
Your `tsconfig.json` should include:

```jsonc
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "strict": true
  }
}
```

### Redis (for production use)

If you plan to use the Redis backend, you need a running Redis server.
The easiest way during development is Docker:

```bash
docker run -d --name my-redis -p 6379:6379 redis:7-alpine
```

---

## 2. Basic Usage — In-Memory (Development)

The in-memory backend is perfect for local development and testing. It
requires zero external dependencies and works out of the box.

### Creating a Memory Cache Plugin

The simplest way to add caching to a WebAFX application is the one-liner
`memoryCachePlugin()` function:

```typescript
import { WebApplication } from "@blendsdk/webafx";
import { memoryCachePlugin } from "@blendsdk/webafx-cache";

const app = new WebApplication({ port: 3000 });

// Register the cache plugin — one line is all you need
app.use(
    memoryCachePlugin({
        rootKey: "MyApp",
        defaultTTL: 300, // 5 minutes default TTL
    })
);
```

This registers an in-memory cache as a singleton service named `"cache"` in the
WebAFX service container. It also wires up health checks and graceful shutdown.

### Setting and Getting Values

Once the plugin is registered, you can access it from any controller via
`req.services`:

```typescript
import type { CacheProvider } from "@blendsdk/webafx-cache";

// Inside a controller handler:
const cache = await req.services.get<CacheProvider>("cache");

// Store a value (JSON-serialized automatically)
await cache.set("user:123", { name: "Alice", role: "admin" });

// Retrieve the value (deserialized automatically)
const user = await cache.get<{ name: string; role: string }>("user:123");
console.log(user); // { name: 'Alice', role: 'admin' }
```

### Using TTL

Every `set()` call accepts an optional TTL (time-to-live) in **seconds**:

```typescript
// Cache for 60 seconds
await cache.set("session:abc", { userId: 42 }, 60);

// After 60 seconds, the value is automatically expired
const session = await cache.get("session:abc"); // undefined (after expiry)
```

If you don't provide a TTL, the `defaultTTL` from your config is used.
If `defaultTTL` is `0` (the default), keys never expire.

### Verifying via /health Endpoint

The cache plugin integrates with WebAFX's health check system. When you
visit your app's `/health` endpoint, the cache provider's health status
is included automatically:

```bash
curl http://localhost:3000/health
# Response includes cache health status
```

For in-memory, health is always `true`. For Redis, it performs a `PING`
command to verify connectivity.

---

## 3. Basic Usage — Redis (Production)

The Redis backend provides distributed caching suitable for production
environments, multi-instance deployments, and persistence across restarts.

### Redis Prerequisites

You need a running Redis instance. Options:

```bash
# Option A: Docker (development)
docker run -d --name my-redis -p 6379:6379 redis:7-alpine

# Option B: Docker Compose (see packages/webafx-cache/docker/docker-compose.yml)
cd packages/webafx-cache && docker compose -f docker/docker-compose.yml up -d

# Option C: System-installed Redis
redis-server
```

### Creating a Redis Cache Plugin

```typescript
import { WebApplication } from "@blendsdk/webafx";
import { redisCachePlugin } from "@blendsdk/webafx-cache";

const app = new WebApplication({ port: 3000 });

app.use(
    redisCachePlugin({
        rootKey: "MyApp",
        host: "localhost",
        port: 6379,
        defaultTTL: 300,
    })
);
```

### Connection Configuration Options

Redis supports two connection styles:

**Host/port (most common):**

```typescript
redisCachePlugin({
    rootKey: "MyApp",
    host: "redis.mycompany.com",
    port: 6379,
    password: "secret",
    db: 0, // Redis database index (0-15)
})
```

**URL-based (takes precedence over host/port):**

```typescript
redisCachePlugin({
    rootKey: "MyApp",
    url: "redis://:secret@redis.mycompany.com:6379/0",
})
```

### Setting and Getting Values with Redis

The API is identical to the in-memory backend — that's the whole point.
You can swap backends without changing any application code:

```typescript
const cache = await req.services.get<CacheProvider>("cache");

// Works exactly the same as in-memory
await cache.set("product:42", { name: "Widget", price: 9.99 }, 600);
const product = await cache.get<{ name: string; price: number }>("product:42");
```

All values are JSON-serialized before being stored in Redis and
deserialized on retrieval, ensuring consistent behavior across backends.

---

## 4. Environment-Based Backend Switching

In real applications, you typically want in-memory caching during development
and Redis in production. The `createCache()` factory makes this easy.

### Using createCache() with Config-Driven Type

```typescript
import { createCache, createCachePlugin } from "@blendsdk/webafx-cache";
import { WebApplication } from "@blendsdk/webafx";

const app = new WebApplication({ port: 3000 });

// The 'type' field determines which backend is created
const cache = createCache({
    type: process.env.NODE_ENV === "production" ? "redis" : "memory",
    rootKey: "MyApp",
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT ?? 6379),
    defaultTTL: 300,
});

app.use(createCachePlugin(cache));
```

### Development vs. Production Setup

**Development** (no environment variables set):
- `type` defaults to `"memory"` — no Redis needed
- `host` and `port` are ignored by the memory provider

**Production** (with environment variables):
- Set `NODE_ENV=production` to switch to Redis
- Set `REDIS_HOST` and `REDIS_PORT` for your Redis instance

### Example Configuration File Pattern

A clean approach is to centralize your cache config in a dedicated file:

```typescript
// src/config.ts
import type { CacheFactoryConfig } from "@blendsdk/webafx-cache";

export function getCacheConfig(): CacheFactoryConfig {
    const isProduction = process.env.NODE_ENV === "production";

    return {
        type: isProduction ? "redis" : "memory",
        rootKey: "MyApp",
        defaultTTL: isProduction ? 600 : 60,

        // Redis-specific (ignored when type === 'memory')
        host: process.env.REDIS_HOST ?? "localhost",
        port: Number(process.env.REDIS_PORT ?? 6379),
        password: process.env.REDIS_PASSWORD,
    };
}
```

Then in your app entry point:

```typescript
// src/main.ts
import { createCache, createCachePlugin } from "@blendsdk/webafx-cache";
import { getCacheConfig } from "./config.js";

const cache = createCache(getCacheConfig());
app.use(createCachePlugin(cache));
```

---

## 5. Using Cache in Controllers

This section covers everyday cache operations you'll use in your WebAFX
controllers.

### Accessing Cache via req.services

In any route handler, resolve the cache from the service container:

```typescript
import type { CacheProvider } from "@blendsdk/webafx-cache";
import type { Request, Response } from "@blendsdk/webafx";

// Inside a route handler:
const cache = await req.services.get<CacheProvider>("cache");
```

The service name `"cache"` is the default. If you registered with a custom
`serviceName`, use that instead (see [Section 6](#6-advanced--multiple-cache-instances)).

### set / get / delete / exists Operations

```typescript
// SET — store a value with optional TTL (seconds)
await cache.set("user:123", { name: "Alice", email: "alice@example.com" }, 300);

// GET — retrieve a value (undefined if missing or expired)
const user = await cache.get<{ name: string; email: string }>("user:123");
if (user) {
    console.log(user.name); // "Alice"
}

// DELETE — remove a key (returns true if deleted, false if not found)
const wasDeleted = await cache.delete("user:123");

// EXISTS — check if a key exists and is not expired
const exists = await cache.exists("user:123"); // false (we just deleted it)
```

### Using getOrSet — Cache-Aside Pattern

The most common caching pattern is "cache-aside" (also called "lazy loading"):
check the cache first, and if there's a miss, compute the value, cache it,
and return it. `getOrSet()` implements this in one call:

```typescript
// First call: cache miss → factory runs → result cached → returned
const product = await cache.getOrSet(
    "product:42",
    async () => {
        // This only runs on cache miss
        return await database.fetchProduct(42);
    },
    300 // Cache for 5 minutes
);

// Second call: cache hit → factory skipped → cached result returned instantly
const sameProduct = await cache.getOrSet(
    "product:42",
    async () => {
        // This does NOT run — value is already cached
        return await database.fetchProduct(42);
    },
    300
);
```

This is the recommended way to use caching in most scenarios — it prevents
cache stampedes and keeps your code concise.

### TTL Management with expire and ttl

You can inspect and update TTLs on existing keys:

```typescript
// Check remaining TTL (in seconds)
const remaining = await cache.ttl("user:123");
// Positive number → seconds remaining
// -1 → key exists but has no expiry
// -2 → key does not exist

// Update TTL without changing the value
const updated = await cache.expire("user:123", 600); // Extend to 10 minutes
// true → TTL was updated
// false → key doesn't exist
```

### Complete Controller Example

Here's a realistic controller that uses caching:

```typescript
import { BaseController } from "@blendsdk/webafx";
import type { Request, Response } from "@blendsdk/webafx";
import type { CacheProvider } from "@blendsdk/webafx-cache";

export class ProductController extends BaseController {
    routes() {
        this.route()
            .get("/api/products/:id")
            .handle(async (req: Request, res: Response) => {
                const cache = await req.services.get<CacheProvider>("cache");
                const productId = req.params.id;

                // Cache-aside: fetch from cache or database
                const product = await cache.getOrSet(
                    `product:${productId}`,
                    async () => await this.fetchProductFromDB(productId),
                    300 // 5 minute TTL
                );

                this.ok(res, product);
            });

        this.route()
            .delete("/api/products/:id")
            .handle(async (req: Request, res: Response) => {
                const cache = await req.services.get<CacheProvider>("cache");
                const productId = req.params.id;

                // Delete from database...
                await this.deleteProductFromDB(productId);

                // ...then invalidate the cache
                await cache.delete(`product:${productId}`);

                this.ok(res, { deleted: true });
            });
    }

    protected async fetchProductFromDB(id: string) {
        // Simulated database query
        return { id, name: "Widget", price: 9.99 };
    }

    protected async deleteProductFromDB(id: string) {
        // Simulated database delete
    }
}
```

---

## 6. Advanced — Multiple Cache Instances

You can run multiple independent cache instances in the same application,
each with its own backend, namespace, and service name.

### Different serviceName for Each Cache

By default, the cache plugin registers under the service name `"cache"`.
To register multiple caches, give each a unique `serviceName`:

```typescript
import { redisCachePlugin, memoryCachePlugin } from "@blendsdk/webafx-cache";

// Session cache — Redis for persistence across instances
app.use(
    redisCachePlugin({
        rootKey: "Sessions",
        host: "redis-sessions",
        serviceName: "session-cache",
        defaultTTL: 3600, // 1 hour
    })
);

// Data cache — Redis for frequently accessed data
app.use(
    redisCachePlugin({
        rootKey: "Data",
        host: "redis-data",
        serviceName: "data-cache",
        defaultTTL: 300, // 5 minutes
    })
);
```

### Different rootKey for Namespace Isolation

Even if two caches share the same Redis server, different `rootKey` values
ensure their keys never collide:

```typescript
// Both connect to the same Redis, but keys are isolated:
// "Sessions:user:abc" vs "Data:product:42"
app.use(
    redisCachePlugin({
        rootKey: "Sessions",
        host: "localhost",
        serviceName: "session-cache",
    })
);

app.use(
    redisCachePlugin({
        rootKey: "Data",
        host: "localhost",
        serviceName: "data-cache",
    })
);
```

### Accessing Multiple Caches in Controllers

Resolve each cache by its service name:

```typescript
import type { CacheProvider } from "@blendsdk/webafx-cache";

// In a route handler:
const sessionCache = await req.services.get<CacheProvider>("session-cache");
const dataCache = await req.services.get<CacheProvider>("data-cache");

// Use each independently
await sessionCache.set("user:abc", { userId: 42, role: "admin" }, 3600);
const product = await dataCache.getOrSet("product:42", fetchProduct, 300);
```

### Use Cases for Multiple Caches

| Cache Instance | rootKey | Backend | TTL | Purpose |
|----------------|---------|---------|-----|---------|
| `session-cache` | `Sessions` | Redis | 3600s | User sessions, auth tokens |
| `data-cache` | `Data` | Redis | 300s | Product catalog, user profiles |
| `temp-cache` | `Temp` | Memory | 30s | Request deduplication, rate limiting |

---

## 7. Advanced — Pattern Operations

Pattern operations let you delete multiple keys at once using wildcard
matching. This is essential for cache invalidation strategies.

### deletePattern() — Bulk Invalidation

Delete all keys matching a glob-style pattern (using `*` as wildcard):

```typescript
const cache = await req.services.get<CacheProvider>("cache");

// Delete all user-related cache entries
const deleted = await cache.deletePattern("user:*");
console.log(`Deleted ${deleted} user cache entries`);

// Delete all entries for a specific feature
await cache.deletePattern("product:category:electronics:*");

// Delete entries matching a suffix
await cache.deletePattern("*:session");
```

> **Redis safety note:** Pattern operations use `SCAN` (not `KEYS`) under
> the hood. `SCAN` is non-blocking and safe for production use, even with
> millions of keys.

### clear() — Namespace-Level Reset

`clear()` deletes **all keys** under this cache's `rootKey` namespace:

```typescript
// Delete every key under the "MyApp:" namespace
await cache.clear();
```

> **Important:** `clear()` only removes keys belonging to this cache's
> `rootKey`. It does NOT flush the entire Redis database or affect other
> namespaces. If you have multiple caches with different root keys, clearing
> one does not affect the others.

### When to Use Each

| Operation | Use When |
|-----------|----------|
| `delete(key)` | Invalidating a single known key |
| `deletePattern(pattern)` | Invalidating a group of related keys (e.g., all products in a category) |
| `clear()` | Full cache reset (e.g., after a major data migration or deployment) |

### Cache Invalidation Example

```typescript
// When a user updates their profile, invalidate all their cached data
async function onUserProfileUpdate(userId: string) {
    const cache = await req.services.get<CacheProvider>("cache");

    // Remove the specific user cache entry
    await cache.delete(`user:${userId}`);

    // Also remove any derived/computed caches for this user
    await cache.deletePattern(`user:${userId}:*`);
}
```

---

## 8. Testing with Cache

The in-memory provider makes testing cache-dependent code straightforward —
no Docker or Redis needed.

### Using MemoryCacheProvider in Tests

Create a standalone memory cache for each test:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { MemoryCacheProvider } from "@blendsdk/webafx-cache";

describe("ProductService", () => {
    let cache: MemoryCacheProvider;

    // Fresh cache for each test — no leakage between tests
    beforeEach(() => {
        cache = new MemoryCacheProvider({
            rootKey: "Test",
            defaultTTL: 60,
        });
    });

    afterEach(async () => {
        await cache.shutdown();
    });

    it("should cache product lookups", async () => {
        const service = new ProductService(cache);

        // First call — cache miss, hits "database"
        const product = await service.getProduct("42");
        expect(product).toEqual({ id: "42", name: "Widget" });

        // Verify it's now cached
        const cached = await cache.get("product:42");
        expect(cached).toEqual({ id: "42", name: "Widget" });
    });

    it("should invalidate cache on product delete", async () => {
        const service = new ProductService(cache);

        // Populate cache
        await cache.set("product:42", { id: "42", name: "Widget" });

        // Delete should clear cache
        await service.deleteProduct("42");

        const cached = await cache.get("product:42");
        expect(cached).toBeUndefined();
    });
});
```

### Creating Test Cache Instances

For services that depend on `CacheProvider`, pass a `MemoryCacheProvider`
directly — no mocking needed:

```typescript
import { MemoryCacheProvider } from "@blendsdk/webafx-cache";
import type { CacheProvider } from "@blendsdk/webafx-cache";

class ProductService {
    constructor(protected cache: CacheProvider) {}

    async getProduct(id: string) {
        return await this.cache.getOrSet(`product:${id}`, async () => {
            // Simulated database fetch
            return { id, name: "Widget" };
        }, 300);
    }

    async deleteProduct(id: string) {
        // Delete from database...
        await this.cache.delete(`product:${id}`);
    }
}

// In test — use real MemoryCacheProvider, no mocks
const cache = new MemoryCacheProvider({ rootKey: "Test" });
const service = new ProductService(cache);
```

### Verifying Cache Behavior in Integration Tests

You can also verify TTL behavior and pattern operations in your tests:

```typescript
it("should expire cached data after TTL", async () => {
    await cache.set("temp", "value", 1); // 1 second TTL

    // Value available immediately
    expect(await cache.get("temp")).toBe("value");

    // Wait for expiry
    await new Promise(resolve => setTimeout(resolve, 1100));

    // Value expired
    expect(await cache.get("temp")).toBeUndefined();
});

it("should clear all keys in namespace", async () => {
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.set("c", 3);

    await cache.clear();

    expect(await cache.exists("a")).toBe(false);
    expect(await cache.exists("b")).toBe(false);
    expect(await cache.exists("c")).toBe(false);
});
```

---

## 9. Configuration Reference

### RedisCacheConfig

Configuration for `redisCachePlugin()` and `new RedisCacheProvider()`:

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `rootKey` | `string` | **(required)** | Root key prefix for all cache keys |
| `serviceName` | `string` | `"cache"` | Service name for WebAFX service container |
| `defaultTTL` | `number` | `0` | Default TTL in seconds (0 = no expiry) |
| `host` | `string` | `"localhost"` | Redis server hostname |
| `port` | `number` | `6379` | Redis server port |
| `password` | `string` | `undefined` | Redis password (AUTH) |
| `db` | `number` | `0` | Redis database index (0–15) |
| `url` | `string` | `undefined` | Redis URL (overrides host/port/password/db) |
| `connectTimeout` | `number` | `5000` | Connection timeout in milliseconds |
| `maxRetriesPerRequest` | `number` | `3` | Max reconnection attempts per request |

### MemoryCacheConfig

Configuration for `memoryCachePlugin()` and `new MemoryCacheProvider()`:

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `rootKey` | `string` | **(required)** | Root key prefix for all cache keys |
| `serviceName` | `string` | `"cache"` | Service name for WebAFX service container |
| `defaultTTL` | `number` | `0` | Default TTL in seconds (0 = no expiry) |
| `cleanupIntervalMs` | `number` | `60000` | Interval for periodic expired-entry cleanup (ms) |

### CacheFactoryConfig

Configuration for `createCache()` factory function:

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `type` | `"redis" \| "memory"` | **(required)** | Backend type to create |
| `rootKey` | `string` | **(required)** | Root key prefix for all cache keys |
| `serviceName` | `string` | `"cache"` | Service name for WebAFX service container |
| `defaultTTL` | `number` | `0` | Default TTL in seconds (0 = no expiry) |
| `host` | `string` | `"localhost"` | Redis host (only when type = `"redis"`) |
| `port` | `number` | `6379` | Redis port (only when type = `"redis"`) |
| `password` | `string` | `undefined` | Redis password (only when type = `"redis"`) |
| `db` | `number` | `0` | Redis database index (only when type = `"redis"`) |
| `url` | `string` | `undefined` | Redis URL (only when type = `"redis"`) |
| `cleanupIntervalMs` | `number` | `60000` | Cleanup interval (only when type = `"memory"`) |

### Default Values Summary

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_SERVICE_NAME` | `"cache"` | Default service registration name |
| `DEFAULT_TTL` | `0` | No expiry by default |
| `KEY_SEPARATOR` | `":"` | Separator between rootKey and user key |

---

---

## Part 2: Pub/Sub Messaging

### 10. Pub/Sub Basics

Pub/sub (publish/subscribe) enables decoupled, event-driven communication between services. Publishers send messages to named channels, and subscribers receive them — neither needs to know about the other.

**When to use pub/sub vs caching:**
- **Caching**: Store and retrieve data (request/response pattern)
- **Pub/Sub**: Broadcast events in real-time (fire-and-forget pattern)

```typescript
import { MemoryPubSubProvider, RedisPubSubProvider } from '@blendsdk/webafx-cache';

// Memory (development/testing)
const pubsub = new MemoryPubSubProvider({ channelPrefix: 'MyApp' });

// Redis (production — two dedicated connections)
const pubsub = new RedisPubSubProvider({
    host: 'localhost',
    channelPrefix: 'MyApp',
});
```

### 11. Publishing and Subscribing

```typescript
// Define typed message
interface OrderEvent { id: number; total: number; }

// Subscribe (app-scoped — done at startup, not per-request)
await pubsub.subscribe<OrderEvent>('order:created', async (msg) => {
    console.log(`Channel: ${msg.channel}, Data:`, msg.data);
});

// Publish (can be done from controllers, services, etc.)
const receiverCount = await pubsub.publish('order:created', { id: 1, total: 99.99 });
// receiverCount = number of handlers that received the message
```

### 12. Pattern Subscriptions

Use glob patterns to subscribe to multiple channels at once:

```typescript
// * matches any sequence of characters
await pubsub.psubscribe('order:*', async (msg) => {
    console.log(`Pattern: ${msg.pattern}, Channel: ${msg.channel}`);
});

// Matches: order:created, order:updated, order:cancelled
// Does NOT match: user:created

// ? matches exactly one character
await pubsub.psubscribe('slot:?', handler);
// Matches: slot:a, slot:b — NOT slot:ab
```

### 13. WebAFX Plugin Integration

```typescript
import { redisPubSubPlugin, memoryPubSubPlugin, createPubSub, createPubSubPlugin } from '@blendsdk/webafx-cache';

// Pattern A: Simple one-liner
app.use(redisPubSubPlugin({ host: 'localhost', channelPrefix: 'MyApp' }));

// Pattern B: With declarative subscriptions
app.use(redisPubSubPlugin(
    { host: 'localhost', channelPrefix: 'MyApp' },
    { subscriptions: [
        { channel: 'order:created', handler: handleOrder },
        { pattern: 'audit:*', handler: handleAudit },
    ]}
));

// Pattern C: Environment-based switching
const pubsub = createPubSub({
    type: process.env.NODE_ENV === 'production' ? 'redis' : 'memory',
    host: process.env.REDIS_HOST,
    channelPrefix: 'MyApp',
});
app.use(createPubSubPlugin(pubsub));
```

### 14. Error Handling

Handler errors are isolated — one failing handler won't affect others:

```typescript
await pubsub.subscribe('events', async (msg) => {
    throw new Error('This error is caught and logged');
});

await pubsub.subscribe('events', async (msg) => {
    // This handler still receives the message
    console.log('Got:', msg.data);
});
```

Messages are JSON-serialized. Non-serializable data (e.g., circular references) will throw on `publish()`.

### 15. Combined Cache + Pub/Sub

Cache and pub/sub are independent services that can coexist:

```typescript
app.use(redisCachePlugin({ rootKey: 'MyApp', host: 'localhost' }));
app.use(redisPubSubPlugin({ channelPrefix: 'MyApp', host: 'localhost' }));

// In controller:
const cache = req.services.get<CacheProvider>('cache');
const pubsub = req.services.get<PubSubProvider>('pubsub');

// Cache the data AND notify subscribers
await cache.set(`order:${id}`, order, 300);
await pubsub.publish('order:created', order);
```

---

## Next Steps

- **API Reference** — See [API.md](API.md) for complete method signatures and type definitions
- **README** — See [../README.md](../README.md) for quick start and installation overview
