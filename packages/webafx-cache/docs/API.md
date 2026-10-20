# @blendsdk/webafx-cache — API Reference

> Complete API reference for `@blendsdk/webafx-cache` v5.32.0.
> For a step-by-step guide, see [TUTORIAL.md](TUTORIAL.md).
> For package overview, see [README.md](../README.md).

---

## Table of Contents

- [CacheProvider (Abstract Base Class)](#cacheprovider-abstract-base-class)
  - [Constructor](#constructor)
  - [Properties](#properties)
  - [Core Operations](#core-operations)
  - [TTL Operations](#ttl-operations)
  - [Pattern Operations](#pattern-operations)
  - [Lifecycle](#lifecycle)
  - [Concrete Methods](#concrete-methods)
  - [Protected Helpers](#protected-helpers)
- [MemoryCacheProvider](#memorycacheprovider)
  - [Constructor](#memorycacheprovider-constructor)
  - [Behavior Notes](#memory-behavior-notes)
- [RedisCacheProvider](#rediscacheprovider)
  - [Constructor](#rediscacheprovider-constructor)
  - [Behavior Notes](#redis-behavior-notes)
- [Plugin Factory Functions](#plugin-factory-functions)
  - [createCachePlugin()](#createcacheplugin)
  - [redisCachePlugin()](#rediscacheplugin)
  - [memoryCachePlugin()](#memorycacheplugin)
  - [createCache()](#createcache)
- [Types & Interfaces](#types--interfaces)
  - [CacheProviderConfig](#cacheproviderconfig)
  - [RedisCacheConfig](#rediscacheconfig)
  - [MemoryCacheConfig](#memorycacheconfig)
  - [CacheFactoryConfig](#cachefactoryconfig)
- [Constants](#constants)

---

## CacheProvider (Abstract Base Class)

```typescript
import { CacheProvider } from '@blendsdk/webafx-cache';
```

Abstract base class for all cache provider implementations. Provides a Redis-like API with transparent key namespacing via `rootKey` prefix. Both `RedisCacheProvider` and `MemoryCacheProvider` extend this class.

**Design principles:**
- Application-wide singleton (not per-request)
- Root key prefix isolates keys per application/concern
- Configurable `serviceName` for multi-cache scenarios
- JSON serialization for all stored values
- All methods are async for a uniform API

### Constructor

```typescript
constructor(config: CacheProviderConfig)
```

Initialize the cache provider with configuration.

| Parameter | Type | Description |
|-----------|------|-------------|
| `config` | `CacheProviderConfig` | Base configuration with rootKey, optional serviceName and defaultTTL |

**Throws:** `Error` if `rootKey` is empty or not provided.

### Properties

| Property | Type | Access | Description |
|----------|------|--------|-------------|
| `serviceName` | `string` | `get` (public) | Service name for WebAFX service container registration. Read-only accessor. |
| `rootKey` | `string` | `protected` | Root key prefix applied to all cache keys. |
| `_serviceName` | `string` | `protected` | Internal storage for the service name. |
| `defaultTTL` | `number` | `protected` | Default TTL in seconds (0 = no expiry). |

---

### Core Operations

#### `set<T>(key, value, ttlSeconds?)`

```typescript
abstract set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>
```

Set a value in the cache. The value is JSON-serialized before storage. The `rootKey` prefix is applied automatically to the key.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | `string` | Yes | Cache key (rootKey prefix applied automatically) |
| `value` | `T` | Yes | Value to store (will be JSON-serialized) |
| `ttlSeconds` | `number` | No | TTL in seconds. Uses `defaultTTL` if not provided. 0 = no expiry. |

**Returns:** `Promise<void>`

```typescript
await cache.set('user:123', { name: 'Alice', email: 'alice@example.com' });
await cache.set('session:abc', tokenData, 3600); // 1 hour TTL
```

---

#### `get<T>(key)`

```typescript
abstract get<T>(key: string): Promise<T | undefined>
```

Get a value from the cache. The stored JSON is deserialized before returning.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | `string` | Yes | Cache key (rootKey prefix applied automatically) |

**Returns:** `Promise<T | undefined>` — The deserialized value, or `undefined` if not found / expired.

```typescript
const user = await cache.get<User>('user:123');
if (user) {
    console.log(user.name); // 'Alice'
}
```

---

#### `delete(key)`

```typescript
abstract delete(key: string): Promise<boolean>
```

Delete a key from the cache.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | `string` | Yes | Cache key (rootKey prefix applied automatically) |

**Returns:** `Promise<boolean>` — `true` if the key was deleted, `false` if it didn't exist.

```typescript
const deleted = await cache.delete('user:123');
// deleted === true if the key existed
```

---

#### `exists(key)`

```typescript
abstract exists(key: string): Promise<boolean>
```

Check if a key exists in the cache (and is not expired).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | `string` | Yes | Cache key (rootKey prefix applied automatically) |

**Returns:** `Promise<boolean>` — `true` if the key exists and is not expired.

```typescript
if (await cache.exists('user:123')) {
    // Key is in cache and has not expired
}
```

---

### TTL Operations

#### `expire(key, ttlSeconds)`

```typescript
abstract expire(key: string, ttlSeconds: number): Promise<boolean>
```

Update the TTL on an existing key without changing its value.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | `string` | Yes | Cache key (rootKey prefix applied automatically) |
| `ttlSeconds` | `number` | Yes | New TTL in seconds |

**Returns:** `Promise<boolean>` — `true` if the key exists and TTL was updated, `false` otherwise.

```typescript
// Extend the TTL on a session to 30 more minutes
const updated = await cache.expire('session:abc', 1800);
```

---

#### `ttl(key)`

```typescript
abstract ttl(key: string): Promise<number>
```

Get the remaining TTL of a key in seconds. Follows Redis conventions for return values.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | `string` | Yes | Cache key (rootKey prefix applied automatically) |

**Returns:** `Promise<number>`

| Return Value | Meaning |
|-------------|---------|
| Positive number | Remaining TTL in seconds |
| `-1` | Key exists but has no expiry |
| `-2` | Key does not exist |

```typescript
const remaining = await cache.ttl('session:abc');
if (remaining === -2) {
    console.log('Key does not exist');
} else if (remaining === -1) {
    console.log('Key has no expiry');
} else {
    console.log(`Expires in ${remaining} seconds`);
}
```

---

### Pattern Operations

#### `deletePattern(pattern)`

```typescript
abstract deletePattern(pattern: string): Promise<number>
```

Delete all keys matching a pattern within this root namespace. Pattern uses `*` as wildcard.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | `string` | Yes | Pattern to match (rootKey prefix applied automatically) |

**Returns:** `Promise<number>` — Number of keys deleted.

**Pattern examples:**
- `'user:*'` matches `user:123`, `user:abc`
- `'*:session'` matches `admin:session`, `guest:session`

**Implementation notes:**
- **Redis:** Uses `SCAN` (not `KEYS`) to avoid blocking the server.
- **Memory:** Converts the pattern to a RegExp and iterates the store.

```typescript
// Delete all cached user data
const count = await cache.deletePattern('user:*');
console.log(`Deleted ${count} user cache entries`);
```

---

#### `clear()`

```typescript
abstract clear(): Promise<void>
```

Clear all keys under this root namespace. Only removes keys with this provider's `rootKey` prefix — does **NOT** flush the entire Redis database or clear other namespaces.

```typescript
// Clear all cache entries for this application
await cache.clear();
```

---

### Lifecycle

#### `health()`

```typescript
abstract health(): Promise<boolean>
```

Health check — returns `true` if the backend is operational.

| Backend | Behavior |
|---------|----------|
| Redis | Sends a `PING` command and checks for `PONG` response |
| Memory | Always returns `true` |

```typescript
const isHealthy = await cache.health();
```

---

#### `shutdown()`

```typescript
abstract shutdown(): Promise<void>
```

Graceful shutdown — close connections, clear intervals, release resources.

| Backend | Behavior |
|---------|----------|
| Redis | Calls `ioredis.quit()` — waits for pending commands to complete |
| Memory | Clears the cleanup interval and empties the store |

```typescript
// During application shutdown
await cache.shutdown();
```

---

### Concrete Methods

#### `getOrSet<T>(key, factory, ttlSeconds?)`

```typescript
async getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    ttlSeconds?: number
): Promise<T>
```

Cache-aside pattern: get a value if it exists, otherwise call the factory function to produce it, cache the result, and return it. Implemented once in the base class — works identically across all backends.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | `string` | Yes | Cache key (rootKey prefix applied automatically) |
| `factory` | `() => Promise<T>` | Yes | Async function that produces the value on cache miss |
| `ttlSeconds` | `number` | No | TTL in seconds for the cached value |

**Returns:** `Promise<T>` — The cached or freshly produced value.

```typescript
const user = await cache.getOrSet('user:123', async () => {
    // Only called on cache miss — expensive DB lookup
    return await db.fetchUser(123);
}, 300); // Cache for 5 minutes
```

---

### Protected Helpers

These methods are used internally by subclasses. They are `protected` and not part of the public API.

#### `buildKey(key)`

```typescript
protected buildKey(key: string): string
```

Build the actual storage key by prepending the root prefix.

| Input | Output (rootKey = `'MyApp'`) |
|-------|------|
| `'user:123'` | `'MyApp:user:123'` |
| `'session'` | `'MyApp:session'` |

---

#### `buildPattern(pattern)`

```typescript
protected buildPattern(pattern: string): string
```

Build a pattern key for pattern-based operations.

| Input | Output (rootKey = `'MyApp'`) |
|-------|------|
| `'user:*'` | `'MyApp:user:*'` |
| `'*'` | `'MyApp:*'` |

---

#### `resolveTTL(ttlSeconds?)`

```typescript
protected resolveTTL(ttlSeconds?: number): number | undefined
```

Resolve the effective TTL for an operation. Uses the provided TTL if given, otherwise falls back to `defaultTTL`. Returns `undefined` if the effective TTL is 0 (meaning no expiry).

---

## MemoryCacheProvider

```typescript
import { MemoryCacheProvider } from '@blendsdk/webafx-cache';
```

In-memory cache provider with TTL support. Zero external dependencies. Suitable for development, testing, and single-instance applications.

<h3 id="memorycacheprovider-constructor">Constructor</h3>

```typescript
constructor(config: MemoryCacheConfig)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `config` | `MemoryCacheConfig` | Memory cache configuration with rootKey and optional cleanup interval |

```typescript
const cache = new MemoryCacheProvider({
    rootKey: 'TestApp',
    defaultTTL: 60,
    cleanupIntervalMs: 5000,
});
```

<h3 id="memory-behavior-notes">Behavior Notes</h3>

| Aspect | Behavior |
|--------|----------|
| **Storage** | `Map<string, MemoryCacheEntry>` with JSON serialization |
| **TTL** | Stored as absolute expiration timestamps in milliseconds |
| **Eviction** | Lazy eviction on access + periodic cleanup interval |
| **Cleanup interval** | `setInterval` with `.unref()` so it doesn't prevent Node.js from exiting |
| **Pattern matching** | Converts glob patterns to RegExp (`*` → `.*`) |
| **`clear()`** | Only deletes keys under this `rootKey` (not the entire store) |
| **`health()`** | Always returns `true` |
| **`shutdown()`** | Clears the cleanup interval and empties the store |
| **TTL precision** | `Math.ceil()` on remaining seconds (rounds up, matches Redis behavior) |

**Protected properties (subclass access):**

| Property | Type | Description |
|----------|------|-------------|
| `store` | `Map<string, MemoryCacheEntry>` | Internal storage map (prefixed key → cache entry) |
| `cleanupInterval` | `ReturnType<typeof setInterval> \| undefined` | Handle for the periodic cleanup interval |
| `cleanupIntervalMs` | `number` | Cleanup interval in milliseconds |

**Protected methods:**

| Method | Description |
|--------|-------------|
| `patternToRegex(pattern: string): RegExp` | Convert a glob-style pattern (with `*` wildcards) to a RegExp |
| `startCleanup(): void` | Start periodic cleanup of expired entries |

---

## RedisCacheProvider

```typescript
import { RedisCacheProvider } from '@blendsdk/webafx-cache';
```

Redis-backed cache provider using [ioredis](https://github.com/redis/ioredis). Production-grade implementation with native TTL, SCAN-based pattern deletion, and connection health monitoring.

<h3 id="rediscacheprovider-constructor">Constructor</h3>

```typescript
constructor(config: RedisCacheConfig)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `config` | `RedisCacheConfig` | Redis configuration with connection details |

If `url` is provided, it takes precedence over individual `host`/`port`/`password`/`db` settings. The ioredis client is created immediately and begins connecting in the background.

```typescript
// Host/port connection
const cache = new RedisCacheProvider({
    rootKey: 'MyApp',
    host: 'localhost',
    port: 6379,
    defaultTTL: 300,
});

// URL connection
const cache = new RedisCacheProvider({
    rootKey: 'MyApp',
    url: 'redis://:password@redis-host:6379/0',
});
```

<h3 id="redis-behavior-notes">Behavior Notes</h3>

| Aspect | Behavior |
|--------|----------|
| **Client** | `ioredis` (`Redis` class) |
| **TTL** | Native Redis `SET ... EX` and `EXPIRE` commands |
| **Pattern ops** | `SCAN` with `MATCH` pattern + batch `DEL` (never `KEYS`) |
| **SCAN batch size** | 100 keys per iteration |
| **`health()`** | Sends `PING`, expects `PONG` response |
| **`shutdown()`** | Calls `ioredis.quit()` — waits for pending commands to complete |
| **`delete()`** | Uses `DEL` — returns `true` if exactly 1 key removed |
| **`exists()`** | Uses `EXISTS` — returns `true` if result is 1 |
| **`ttl()`** | Directly maps to Redis `TTL` command (native -1/-2 semantics) |
| **Connection** | URL takes precedence over host/port when both are provided |

**Protected properties (subclass access):**

| Property | Type | Description |
|----------|------|-------------|
| `client` | `Redis` (ioredis) | The ioredis client instance |

**Protected methods:**

| Method | Description |
|--------|-------------|
| `scanAndDelete(pattern: string): Promise<number>` | Use SCAN to find keys matching a pattern and delete them in batches. Non-blocking and production-safe. |

---

## Plugin Factory Functions

```typescript
import {
    createCachePlugin,
    redisCachePlugin,
    memoryCachePlugin,
    createCache,
} from '@blendsdk/webafx-cache';
```

These functions integrate cache providers with WebAFX applications. They return `PluginDefinition` objects that can be passed to `app.use()`.

> **Note:** These functions are the only part of `@blendsdk/webafx-cache` that imports from `@blendsdk/webafx`, which is why webafx is a **peer dependency**.

---

### `createCachePlugin()`

```typescript
function createCachePlugin(
    provider: CacheProvider,
    options?: { priority?: number }
): PluginDefinition
```

Create a WebAFX `PluginDefinition` from any `CacheProvider` instance. This is the core function that wires a cache provider into WebAFX.

**What it does:**
1. Registers the provider as a singleton service in the service container
2. Hooks the provider's `health()` into the `/health` endpoint
3. Hooks the provider's `shutdown()` into graceful shutdown

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `provider` | `CacheProvider` | Yes | Any CacheProvider instance (Redis, Memory, or custom) |
| `options` | `{ priority?: number }` | No | Optional overrides. Default priority: `30`. |

**Returns:** `PluginDefinition` — ready to pass to `app.use()`.

```typescript
const cache = new RedisCacheProvider({ rootKey: 'MyApp', host: 'localhost' });
app.use(createCachePlugin(cache));

// With custom priority
app.use(createCachePlugin(cache, { priority: 10 }));
```

---

### `redisCachePlugin()`

```typescript
function redisCachePlugin(config: RedisCacheConfig): PluginDefinition
```

One-liner: create a WebAFX cache plugin with a Redis backend. Creates a `RedisCacheProvider` internally.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `config` | `RedisCacheConfig` | Yes | Redis cache configuration |

**Returns:** `PluginDefinition`

```typescript
app.use(redisCachePlugin({
    rootKey: 'MyApp',
    host: 'localhost',
    port: 6379,
    defaultTTL: 300,
}));
```

---

### `memoryCachePlugin()`

```typescript
function memoryCachePlugin(config: MemoryCacheConfig): PluginDefinition
```

One-liner: create a WebAFX cache plugin with an In-Memory backend. Creates a `MemoryCacheProvider` internally. Ideal for development and testing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `config` | `MemoryCacheConfig` | Yes | Memory cache configuration |

**Returns:** `PluginDefinition`

```typescript
app.use(memoryCachePlugin({
    rootKey: 'MyApp',
    defaultTTL: 60,
}));
```

---

### `createCache()`

```typescript
function createCache(config: CacheFactoryConfig): CacheProvider
```

Environment-based factory. Creates the appropriate provider based on `config.type`. Use with `createCachePlugin()` to register in WebAFX.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `config` | `CacheFactoryConfig` | Yes | Factory configuration with type discriminator |

**Returns:** `CacheProvider` — A `RedisCacheProvider` or `MemoryCacheProvider` instance.

**Throws:** `Error` if `config.type` is not `'redis'` or `'memory'`.

```typescript
const cache = createCache({
    type: process.env.NODE_ENV === 'production' ? 'redis' : 'memory',
    rootKey: 'MyApp',
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    defaultTTL: 300,
});
app.use(createCachePlugin(cache));
```

---

## Types & Interfaces

```typescript
import type {
    CacheProviderConfig,
    RedisCacheConfig,
    MemoryCacheConfig,
    CacheFactoryConfig,
} from '@blendsdk/webafx-cache';
```

### CacheProviderConfig

Base configuration shared by all cache providers.

```typescript
interface CacheProviderConfig {
    rootKey: string;
    serviceName?: string;
    defaultTTL?: number;
}
```

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `rootKey` | `string` | **Yes** | — | Root key prefix for all cache keys (e.g., `'MyApp'`). Must be non-empty. |
| `serviceName` | `string` | No | `'cache'` | Service name for WebAFX service container registration. Use different names for multi-cache scenarios. |
| `defaultTTL` | `number` | No | `0` | Default TTL in seconds. `0` means no expiry. |

---

### RedisCacheConfig

Redis-specific configuration. Extends `CacheProviderConfig`.

```typescript
interface RedisCacheConfig extends CacheProviderConfig {
    host?: string;
    port?: number;
    password?: string;
    db?: number;
    url?: string;
    connectTimeout?: number;
    maxRetriesPerRequest?: number;
}
```

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `rootKey` | `string` | **Yes** | — | Root key prefix for namespace isolation |
| `serviceName` | `string` | No | `'cache'` | WebAFX service container name |
| `defaultTTL` | `number` | No | `0` | Default TTL in seconds |
| `host` | `string` | No | `'localhost'` | Redis host |
| `port` | `number` | No | `6379` | Redis port |
| `password` | `string` | No | — | Redis password |
| `db` | `number` | No | `0` | Redis database index (0–15) |
| `url` | `string` | No | — | Redis connection URL. **Overrides** host/port/password/db if provided. |
| `connectTimeout` | `number` | No | `5000` | Connection timeout in milliseconds |
| `maxRetriesPerRequest` | `number` | No | `3` | Maximum reconnection attempts per request |

> **URL format:** `redis://[:password@]host[:port][/db]`

---

### MemoryCacheConfig

In-memory specific configuration. Extends `CacheProviderConfig`.

```typescript
interface MemoryCacheConfig extends CacheProviderConfig {
    cleanupIntervalMs?: number;
}
```

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `rootKey` | `string` | **Yes** | — | Root key prefix for namespace isolation |
| `serviceName` | `string` | No | `'cache'` | WebAFX service container name |
| `defaultTTL` | `number` | No | `0` | Default TTL in seconds |
| `cleanupIntervalMs` | `number` | No | `60000` (1 min) | Cleanup interval for expired entries in milliseconds. Set to `0` or negative to disable periodic cleanup. |

---

### CacheFactoryConfig

Configuration for the `createCache()` environment-based factory. Determines which backend to create based on the `type` field.

```typescript
interface CacheFactoryConfig {
    type: 'redis' | 'memory';
    rootKey: string;
    serviceName?: string;
    defaultTTL?: number;
    // Redis-specific (only used when type === 'redis')
    host?: string;
    port?: number;
    password?: string;
    db?: number;
    url?: string;
    // Memory-specific (only used when type === 'memory')
    cleanupIntervalMs?: number;
}
```

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `type` | `'redis' \| 'memory'` | **Yes** | — | Cache backend type |
| `rootKey` | `string` | **Yes** | — | Root key prefix for all cache keys |
| `serviceName` | `string` | No | `'cache'` | WebAFX service container name |
| `defaultTTL` | `number` | No | `0` | Default TTL in seconds |
| `host` | `string` | No | `'localhost'` | Redis host (only when `type === 'redis'`) |
| `port` | `number` | No | `6379` | Redis port (only when `type === 'redis'`) |
| `password` | `string` | No | — | Redis password (only when `type === 'redis'`) |
| `db` | `number` | No | `0` | Redis database index (only when `type === 'redis'`) |
| `url` | `string` | No | — | Redis connection URL (only when `type === 'redis'`) |
| `cleanupIntervalMs` | `number` | No | `60000` | Cleanup interval in ms (only when `type === 'memory'`) |

---

## Constants

```typescript
import {
    DEFAULT_SERVICE_NAME,
    DEFAULT_TTL,
    KEY_SEPARATOR,
} from '@blendsdk/webafx-cache';
```

| Constant | Type | Value | Description |
|----------|------|-------|-------------|
| `DEFAULT_SERVICE_NAME` | `string` | `'cache'` | Default service name when `serviceName` is not specified in config |
| `DEFAULT_TTL` | `number` | `0` | Default TTL in seconds (0 = no expiry) |
| `KEY_SEPARATOR` | `string` | `':'` | Separator between `rootKey` and user-provided key (e.g., `MyApp:user:123`) |
| `DEFAULT_PUBSUB_SERVICE_NAME` | `string` | `'pubsub'` | Default service name for pub/sub providers |
| `CHANNEL_SEPARATOR` | `string` | `':'` | Separator between `channelPrefix` and user-provided channel name |

---

## Pub/Sub Classes

### PubSubProvider (Abstract Base Class)

```typescript
import { PubSubProvider } from '@blendsdk/webafx-cache';
```

Abstract base class for all pub/sub providers. Provides channel prefix management, safe handler invocation with error isolation, and defines the pub/sub contract.

**Properties:**

| Property | Type | Description |
|----------|------|-------------|
| `serviceName` | `string` (readonly) | Service name for WebAFX registration (default: `'pubsub'`) |

**Abstract Methods (implemented by subclasses):**

| Method | Signature | Description |
|--------|-----------|-------------|
| `publish` | `publish<T>(channel: string, data: T): Promise<number>` | Publish a message to a channel. Returns the number of receivers. |
| `subscribe` | `subscribe<T>(channel: string, handler: MessageHandler<T>): Promise<void>` | Subscribe to an exact channel with a typed handler. |
| `unsubscribe` | `unsubscribe(channel: string): Promise<void>` | Unsubscribe all handlers from an exact channel. |
| `psubscribe` | `psubscribe<T>(pattern: string, handler: MessageHandler<T>): Promise<void>` | Subscribe to a glob pattern (`*`, `?`). |
| `punsubscribe` | `punsubscribe(pattern: string): Promise<void>` | Unsubscribe all handlers from a glob pattern. |
| `activeSubscriptions` | `activeSubscriptions(): { channels: string[]; patterns: string[] }` | Get currently active subscriptions. |
| `health` | `health(): Promise<boolean>` | Check if the provider is operational. |
| `shutdown` | `shutdown(): Promise<void>` | Graceful shutdown — unsubscribe all and close connections. |

### RedisPubSubProvider

```typescript
import { RedisPubSubProvider } from '@blendsdk/webafx-cache';
```

Redis-backed pub/sub using two dedicated ioredis connections (publisher + subscriber). Production-grade with automatic JSON serialization, channel prefix support, and handler error isolation.

**Constructor:**

```typescript
new RedisPubSubProvider(config: RedisPubSubConfig)
```

### MemoryPubSubProvider

```typescript
import { MemoryPubSubProvider } from '@blendsdk/webafx-cache';
```

In-memory pub/sub with glob pattern matching via regex. Zero external dependencies. JSON round-trip on publish ensures serialization parity with Redis.

**Constructor:**

```typescript
new MemoryPubSubProvider(config?: MemoryPubSubConfig)
```

---

## Pub/Sub Plugin Functions

### createPubSubPlugin

```typescript
import { createPubSubPlugin } from '@blendsdk/webafx-cache';

function createPubSubPlugin(
    provider: PubSubProvider,
    options?: PubSubPluginOptions
): PluginDefinition;
```

Wire any `PubSubProvider` into WebAFX as a singleton service with health check and graceful shutdown. Supports optional declarative subscriptions.

### redisPubSubPlugin

```typescript
import { redisPubSubPlugin } from '@blendsdk/webafx-cache';

function redisPubSubPlugin(
    config: RedisPubSubConfig,
    options?: PubSubPluginOptions
): PluginDefinition;
```

One-liner Redis pub/sub plugin. Creates a `RedisPubSubProvider` internally.

### memoryPubSubPlugin

```typescript
import { memoryPubSubPlugin } from '@blendsdk/webafx-cache';

function memoryPubSubPlugin(
    config?: MemoryPubSubConfig,
    options?: PubSubPluginOptions
): PluginDefinition;
```

One-liner in-memory pub/sub plugin. Creates a `MemoryPubSubProvider` internally.

### createPubSub

```typescript
import { createPubSub } from '@blendsdk/webafx-cache';

function createPubSub(config: PubSubFactoryConfig): PubSubProvider;
```

Environment-based factory. Returns `RedisPubSubProvider` or `MemoryPubSubProvider` based on `config.type`.

---

## Pub/Sub Types

### PubSubProviderConfig

```typescript
interface PubSubProviderConfig {
    channelPrefix?: string;   // Optional prefix for all channels
    serviceName?: string;     // Default: 'pubsub'
}
```

### RedisPubSubConfig

```typescript
interface RedisPubSubConfig extends PubSubProviderConfig, RedisConnectionConfig {}
```

Includes all `RedisConnectionConfig` fields: `host`, `port`, `password`, `db`, `url`, `connectTimeout`, `maxRetriesPerRequest`.

### MemoryPubSubConfig

```typescript
interface MemoryPubSubConfig extends PubSubProviderConfig {}
```

### PubSubMessage\<T\>

```typescript
interface PubSubMessage<T = unknown> {
    channel: string;     // User-facing channel name (without prefix)
    data: T;             // Deserialized message payload
    pattern?: string;    // Present only for pattern-matched messages
}
```

### MessageHandler\<T\>

```typescript
type MessageHandler<T = unknown> = (message: PubSubMessage<T>) => void | Promise<void>;
```

### SubscriptionDefinition

```typescript
interface SubscriptionDefinition<T = unknown> {
    channel?: string;         // Exact channel (mutually exclusive with pattern)
    pattern?: string;         // Glob pattern (mutually exclusive with channel)
    handler: MessageHandler<T>;
}
```

### PubSubPluginOptions

```typescript
interface PubSubPluginOptions {
    priority?: number;                      // Plugin priority (default: 30)
    subscriptions?: SubscriptionDefinition[];  // Declarative subscriptions
}
```

### PubSubFactoryConfig

```typescript
interface PubSubFactoryConfig {
    type: 'redis' | 'memory';
    channelPrefix?: string;
    serviceName?: string;
    // Redis fields (ignored when type === 'memory'):
    host?: string;
    port?: number;
    password?: string;
    db?: number;
    url?: string;
}
```
