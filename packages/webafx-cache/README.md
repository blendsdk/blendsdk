# @blendsdk/webafx-cache

Application-wide caching and pub/sub plugin for WebAFX with Redis and In-Memory backends.

## Overview

`@blendsdk/webafx-cache` provides two independent service abstractions for BlendSDK applications:

### Caching

Abstract `CacheProvider` base class with two production-ready implementations:

- **`RedisCacheProvider`** — Distributed caching via [ioredis](https://github.com/redis/ioredis). Best for production, multi-instance deployments.
- **`MemoryCacheProvider`** — Zero-dependency in-memory caching. Best for development, testing, and single-instance apps.

### Pub/Sub Messaging

Abstract `PubSubProvider` base class with two production-ready implementations:

- **`RedisPubSubProvider`** — Distributed pub/sub via [ioredis](https://github.com/redis/ioredis) with dedicated publisher/subscriber connections.
- **`MemoryPubSubProvider`** — In-process pub/sub with glob pattern matching. Best for development and testing.

Both caching and pub/sub backends implement identical APIs per abstraction, ensuring you can swap backends without any code changes.

## Installation

```bash
yarn add @blendsdk/webafx-cache
```

For WebAFX plugin integration:
```bash
yarn add @blendsdk/webafx-cache @blendsdk/webafx
```

## Quick Start

### Standalone Usage (without WebAFX)

```typescript
import { MemoryCacheProvider, RedisCacheProvider } from '@blendsdk/webafx-cache';

// In-memory (development / testing)
const cache = new MemoryCacheProvider({
    rootKey: 'MyApp',
    defaultTTL: 300, // 5 minutes default
});

// Redis (production)
const cache = new RedisCacheProvider({
    rootKey: 'MyApp',
    host: 'localhost',
    port: 6379,
    defaultTTL: 300,
});

// Set a value (JSON-serialized automatically)
await cache.set('user:123', { name: 'Alice', email: 'alice@example.com' }, 600);

// Get a value (deserialized automatically)
const user = await cache.get<{ name: string; email: string }>('user:123');

// Cache-aside pattern (most common usage)
const product = await cache.getOrSet('product:42', async () => {
    return await database.fetchProduct(42);
}, 300);

// Check existence / TTL
const exists = await cache.exists('user:123');  // true
const ttl = await cache.ttl('user:123');        // ~600

// Delete
await cache.delete('user:123');

// Pattern operations
await cache.deletePattern('user:*');  // Delete all user keys
await cache.clear();                  // Delete all keys under rootKey

// Cleanup
await cache.shutdown();
```

### WebAFX Plugin (one-liner)

```typescript
import { redisCachePlugin, memoryCachePlugin } from '@blendsdk/webafx-cache';
import { WebApplication } from '@blendsdk/webafx';

const app = new WebApplication({ port: 3000 });

// Redis backend (production)
app.use(redisCachePlugin({
    rootKey: 'MyApp',
    host: 'localhost',
    port: 6379,
    defaultTTL: 300,
}));

// OR: In-memory backend (development)
app.use(memoryCachePlugin({
    rootKey: 'MyApp',
    defaultTTL: 300,
}));
```

### Environment-Based Switching

```typescript
import { createCache, createCachePlugin } from '@blendsdk/webafx-cache';

const cache = createCache({
    type: process.env.NODE_ENV === 'production' ? 'redis' : 'memory',
    rootKey: 'MyApp',
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    defaultTTL: 300,
});

app.use(createCachePlugin(cache));
```

### Accessing Cache in Controllers

```typescript
import { CacheProvider } from '@blendsdk/webafx-cache';

// In any controller or service:
const cache = await req.services.get<CacheProvider>('cache');
const user = await cache.getOrSet('user:123', () => db.fetchUser(123), 300);
```

### Multi-Cache (multiple instances)

```typescript
app.use(redisCachePlugin({
    rootKey: 'Sessions',
    host: 'redis-sessions',
    serviceName: 'session-cache',
}));

app.use(redisCachePlugin({
    rootKey: 'Products',
    host: 'redis-products',
    serviceName: 'product-cache',
}));

// In controllers:
const sessions = await req.services.get<CacheProvider>('session-cache');
const products = await req.services.get<CacheProvider>('product-cache');
```

## Pub/Sub Quick Start

### Standalone Usage

```typescript
import { RedisPubSubProvider, MemoryPubSubProvider } from '@blendsdk/webafx-cache';

// Redis (production — uses two dedicated connections)
const pubsub = new RedisPubSubProvider({
    host: 'localhost',
    port: 6379,
    channelPrefix: 'MyApp',
});

// In-memory (development / testing)
const pubsub = new MemoryPubSubProvider({ channelPrefix: 'MyApp' });

// Subscribe to exact channel
await pubsub.subscribe<Order>('order:created', async (msg) => {
    console.log(`New order on "${msg.channel}":`, msg.data);
});

// Subscribe to pattern (glob wildcards)
await pubsub.psubscribe('audit:*', async (msg) => {
    console.log(`Audit event on "${msg.channel}" (pattern: ${msg.pattern}):`, msg.data);
});

// Publish a message (returns number of receivers)
const count = await pubsub.publish('order:created', { id: 1, total: 99.99 });

// Lifecycle
const isHealthy = await pubsub.health();
await pubsub.shutdown();
```

### WebAFX Plugin (one-liner)

```typescript
import { redisPubSubPlugin, memoryPubSubPlugin } from '@blendsdk/webafx-cache';

// Redis backend
app.use(redisPubSubPlugin({
    host: 'localhost',
    port: 6379,
    channelPrefix: 'MyApp',
}));

// OR with declarative subscriptions
app.use(redisPubSubPlugin(
    { host: 'localhost', channelPrefix: 'MyApp' },
    {
        subscriptions: [
            { channel: 'order:created', handler: handleNewOrder },
            { pattern: 'audit:*', handler: handleAuditEvent },
        ]
    }
));
```

### Accessing Pub/Sub in Controllers

```typescript
import { PubSubProvider } from '@blendsdk/webafx-cache';

const pubsub = await req.services.get<PubSubProvider>('pubsub');
await pubsub.publish('order:created', orderData);
```

### Combined Cache + Pub/Sub

```typescript
// Same Redis, different services (different connections)
app.use(redisCachePlugin({ rootKey: 'MyApp', host: 'localhost' }));
app.use(redisPubSubPlugin({ channelPrefix: 'MyApp', host: 'localhost' }));

// In controller:
const cache = await req.services.get<CacheProvider>('cache');
const pubsub = await req.services.get<PubSubProvider>('pubsub');

await cache.set(`order:${id}`, order, 300);
await pubsub.publish('order:created', order);
```

## API Reference

### CacheProvider (Abstract Base Class)

| Method | Signature | Description |
|--------|-----------|-------------|
| `set` | `set<T>(key, value, ttlSeconds?): Promise<void>` | Store a value with optional TTL |
| `get` | `get<T>(key): Promise<T \| undefined>` | Retrieve a value (undefined if missing/expired) |
| `delete` | `delete(key): Promise<boolean>` | Delete a key (true if deleted) |
| `exists` | `exists(key): Promise<boolean>` | Check if key exists and is not expired |
| `expire` | `expire(key, ttlSeconds): Promise<boolean>` | Update TTL on existing key |
| `ttl` | `ttl(key): Promise<number>` | Get remaining TTL (-1 no expiry, -2 missing) |
| `deletePattern` | `deletePattern(pattern): Promise<number>` | Delete keys matching wildcard pattern |
| `clear` | `clear(): Promise<void>` | Delete all keys under rootKey namespace |
| `health` | `health(): Promise<boolean>` | Check backend is operational |
| `shutdown` | `shutdown(): Promise<void>` | Graceful shutdown and cleanup |
| `getOrSet` | `getOrSet<T>(key, factory, ttlSeconds?): Promise<T>` | Cache-aside: get or produce and cache |

### PubSubProvider (Abstract Base Class)

| Method | Signature | Description |
|--------|-----------|-------------|
| `publish` | `publish<T>(channel, data): Promise<number>` | Publish a message (returns receiver count) |
| `subscribe` | `subscribe<T>(channel, handler): Promise<void>` | Subscribe to exact channel |
| `unsubscribe` | `unsubscribe(channel): Promise<void>` | Unsubscribe from exact channel |
| `psubscribe` | `psubscribe<T>(pattern, handler): Promise<void>` | Subscribe to glob pattern |
| `punsubscribe` | `punsubscribe(pattern): Promise<void>` | Unsubscribe from glob pattern |
| `activeSubscriptions` | `activeSubscriptions(): { channels, patterns }` | Get active subscriptions |
| `health` | `health(): Promise<boolean>` | Check backend is operational |
| `shutdown` | `shutdown(): Promise<void>` | Graceful shutdown and cleanup |

### Cache Plugin Factory Functions

| Function | Description |
|----------|-------------|
| `redisCachePlugin(config)` | One-liner Redis cache plugin for WebAFX |
| `memoryCachePlugin(config)` | One-liner In-Memory cache plugin for WebAFX |
| `createCachePlugin(provider, options?)` | Wire any CacheProvider into WebAFX |
| `createCache(config)` | Environment-based factory (returns CacheProvider) |

### Pub/Sub Plugin Factory Functions

| Function | Description |
|----------|-------------|
| `redisPubSubPlugin(config, options?)` | One-liner Redis pub/sub plugin for WebAFX |
| `memoryPubSubPlugin(config?, options?)` | One-liner In-Memory pub/sub plugin for WebAFX |
| `createPubSubPlugin(provider, options?)` | Wire any PubSubProvider into WebAFX |
| `createPubSub(config)` | Environment-based factory (returns PubSubProvider) |

### Configuration

```typescript
// Base config (shared by all providers)
interface CacheProviderConfig {
    rootKey: string;          // Required — namespace prefix for all keys
    serviceName?: string;     // Default: 'cache'
    defaultTTL?: number;      // Default: 0 (no expiry)
}

// Redis-specific
interface RedisCacheConfig extends CacheProviderConfig {
    host?: string;            // Default: 'localhost'
    port?: number;            // Default: 6379
    password?: string;
    db?: number;              // Default: 0
    url?: string;             // Overrides host/port/password/db
    connectTimeout?: number;  // Default: 5000ms
    maxRetriesPerRequest?: number; // Default: 3
}

// In-memory specific
interface MemoryCacheConfig extends CacheProviderConfig {
    cleanupIntervalMs?: number; // Default: 60000 (1 min)
}

// Pub/Sub base config
interface PubSubProviderConfig {
    channelPrefix?: string;   // Optional — prefix for all channels
    serviceName?: string;     // Default: 'pubsub'
}

// Pub/Sub Redis-specific (extends RedisConnectionConfig)
interface RedisPubSubConfig extends PubSubProviderConfig {
    host?: string;            // Default: 'localhost'
    port?: number;            // Default: 6379
    password?: string;
    db?: number;              // Default: 0
    url?: string;             // Overrides host/port/password/db
    connectTimeout?: number;  // Default: 5000ms
    maxRetriesPerRequest?: number; // Default: 3
}
```

## Key Design Decisions

| Decision | Outcome |
|----------|---------|
| **Root Key / Channel Prefix** | All keys/channels automatically prefixed for namespace isolation |
| **JSON Serialization** | Values and messages JSON-serialized (no reference sharing) |
| **Redis Pattern Ops** | Cache uses SCAN (never KEYS); pub/sub uses native Redis PSUBSCRIBE |
| **Two Redis Connections** | Pub/sub uses dedicated publisher + subscriber connections (Redis requirement) |
| **Handler Error Isolation** | Pub/sub catches handler errors per-handler — one failure won't affect others |
| **Application-wide** | Singleton services, not per-request — one instance for the entire app |
| **WebAFX Optional** | `@blendsdk/webafx` is a peer dependency — only needed for plugin integration |

## Testing

```bash
# Unit tests (no Docker required)
cd packages/webafx-cache && yarn test:fast

# Full tests including Redis integration (requires Docker)
cd packages/webafx-cache && yarn test
```

## License

MIT — TrueSoftware B.V.
