> **Package**: `blendsdk/webafx-cache`

# webafx-cache API Reference

> **Memory subpath**: `import { ... } from 'blendsdk/webafx-cache/memory'` — Redis-free subset

Complete reference for every class, function, type, and constant exported by `blendsdk/webafx-cache`. All signatures match the published type declarations (`src/index.ts` and `src/memory.ts` entry points).

---

## Exports at a Glance

### Provider Classes

| Export | Kind | Description |
|--------|------|-------------|
| `CacheProvider` | abstract class | Base class for all cache backends — Redis-like async API, `rootKey` namespacing, TTL resolution, `getOrSet()` |
| `PubSubProvider` | abstract class | Base class for all pub/sub backends — typed messaging, channel prefixing, handler error isolation |
| `MemoryCacheProvider` | class | In-memory cache backend with TTL, lazy + periodic eviction, zero dependencies |
| `RedisCacheProvider` | class | Redis cache backend on `ioredis` — native TTLs, `SCAN`-based pattern deletion |
| `MemoryPubSubProvider` | class | In-process pub/sub backend with glob pattern matching (`*`, `?`) |
| `RedisPubSubProvider` | class | Redis pub/sub backend with dedicated publisher and subscriber connections |

### Plugin Factories

| Export | Kind | Description |
|--------|------|-------------|
| `createCachePlugin` | function | Wrap any `CacheProvider` in a WebAFX `PluginDefinition` |
| `redisCachePlugin` | function | Create a Redis-backed cache plugin in one call |
| `memoryCachePlugin` | function | Create a memory-backed cache plugin in one call |
| `createCache` | function | Build a cache provider from a `type: "redis" \| "memory"` config |
| `createPubSubPlugin` | function | Wrap any `PubSubProvider` in a WebAFX `PluginDefinition` |
| `redisPubSubPlugin` | function | Create a Redis-backed pub/sub plugin in one call |
| `memoryPubSubPlugin` | function | Create a memory-backed pub/sub plugin in one call |
| `createPubSub` | function | Build a pub/sub provider from a `type: "redis" \| "memory"` config |

### Configuration and Message Types

| Export | Kind | Description |
|--------|------|-------------|
| `RedisConnectionConfig` | interface | Shared Redis connection options for cache and pub/sub |
| `CacheProviderConfig` | interface | Base cache configuration (`rootKey`, `serviceName`, `defaultTTL`) |
| `RedisCacheConfig` | interface | `CacheProviderConfig` + `RedisConnectionConfig` |
| `MemoryCacheConfig` | interface | `CacheProviderConfig` + `cleanupIntervalMs` |
| `CacheFactoryConfig` | interface | Configuration for `createCache()` with a type discriminator |
| `PubSubProviderConfig` | interface | Base pub/sub configuration (`channelPrefix`, `serviceName`) |
| `RedisPubSubConfig` | interface | `PubSubProviderConfig` + `RedisConnectionConfig` |
| `MemoryPubSubConfig` | interface | `PubSubProviderConfig` (no extra fields) |
| `PubSubFactoryConfig` | interface | Configuration for `createPubSub()` with a type discriminator |
| `PubSubMessage` | interface | Message envelope delivered to handlers (`channel`, `data`, optional `pattern`) |
| `MessageHandler` | type alias | Handler function type for pub/sub messages |
| `SubscriptionDefinition` | interface | Declarative subscription entry for plugin options |
| `PubSubPluginOptions` | interface | Pub/sub plugin options (`priority`, `subscriptions`) |

### Constants

| Export | Value |
|--------|-------|
| `DEFAULT_SERVICE_NAME` | `"cache"` |
| `DEFAULT_TTL` | `0` |
| `KEY_SEPARATOR` | `":"` |
| `DEFAULT_PUBSUB_SERVICE_NAME` | `"pubsub"` |
| `CHANNEL_SEPARATOR` | `":"` |

---

## Cache Hierarchy

### CacheProvider

Abstract base class for all cache backends. Both built-in implementations (`MemoryCacheProvider`, `RedisCacheProvider`) and any custom subclass share this contract: all operations are async, all values are JSON-serialized, and all keys are transparently prefixed with the provider's `rootKey`.

```typescript fragment
abstract class CacheProvider {
    constructor(config: CacheProviderConfig);

    // Public accessor
    get serviceName(): string;

    // Concrete method — implemented once for all backends
    getOrSet<T>(key: string, factory: () => Promise<T>, ttlSeconds?: number): Promise<T>;

    // Abstract methods — implemented by each backend
    abstract set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
    abstract get<T>(key: string): Promise<T | undefined>;
    abstract delete(key: string): Promise<boolean>;
    abstract exists(key: string): Promise<boolean>;
    abstract expire(key: string, ttlSeconds: number): Promise<boolean>;
    abstract ttl(key: string): Promise<number>;
    abstract deletePattern(pattern: string): Promise<number>;
    abstract clear(): Promise<void>;
    abstract health(): Promise<boolean>;
    abstract shutdown(): Promise<void>;

    // Protected — subclass surface
    protected rootKey: string;
    protected _serviceName: string;
    protected defaultTTL: number;
    protected buildKey(key: string): string;
    protected buildPattern(pattern: string): string;
    protected resolveTTL(ttlSeconds?: number): number | undefined;
}
```

#### Constructor

```typescript fragment
constructor(config: CacheProviderConfig)
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `CacheProviderConfig` | Yes | — | Base configuration; `rootKey` is validated |
| `config.rootKey` | `string` | Yes | — | Non-empty root key prefix for namespace isolation |
| `config.serviceName` | `string` | No | `"cache"` | Service name used for WebAFX service container registration |
| `config.defaultTTL` | `number` | No | `0` | Default TTL in seconds; 0 = no expiry |

**Throws**: `Error` — `"CacheProvider: rootKey is required and cannot be empty"` when `rootKey` is empty or whitespace-only.

#### Public Properties

| Property | Type | Description |
|----------|------|-------------|
| `serviceName` | `string` (getter, read-only) | Service name for WebAFX service container registration; defaults to `"cache"` |

#### Concrete Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `getOrSet` | `getOrSet<T>(key: string, factory: () => Promise<T>, ttlSeconds?: number): Promise<T>` | `Promise<T>` | Cache-aside pattern: returns the cached value if present; otherwise invokes `factory`, caches the produced value, and returns it. Implemented once in the base class — identical for every backend. |

#### Abstract Methods (Backend Contract)

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `set` | `set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>` | `Promise<void>` | Stores a JSON-serialized value. Uses `defaultTTL` when `ttlSeconds` is omitted; effective TTL of 0 means no expiry. |
| `get` | `get<T>(key: string): Promise<T \| undefined>` | `Promise<T \| undefined>` | Returns the deserialized value, or `undefined` on cache miss / expiry. |
| `delete` | `delete(key: string): Promise<boolean>` | `Promise<boolean>` | Deletes the key; `true` if it existed. |
| `exists` | `exists(key: string): Promise<boolean>` | `Promise<boolean>` | `true` if the key exists and is not expired. |
| `expire` | `expire(key: string, ttlSeconds: number): Promise<boolean>` | `Promise<boolean>` | Resets the TTL without changing the value; `true` if the key existed. |
| `ttl` | `ttl(key: string): Promise<number>` | `Promise<number>` | Remaining TTL in seconds. Redis conventions: positive = remaining seconds, `-1` = exists without expiry, `-2` = missing key. |
| `deletePattern` | `deletePattern(pattern: string): Promise<number>` | `Promise<number>` | Deletes all keys matching `rootKey:<pattern>` (`*` wildcard) and returns the number of keys deleted. |
| `clear` | `clear(): Promise<void>` | `Promise<void>` | Removes **only** keys under this provider's `rootKey` namespace; never flushes other namespaces or the whole Redis database. |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | Backend health check (Redis: `PING`; Memory: always `true`). |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Graceful shutdown — closes connections / stops timers and releases resources. |

#### Protected Members (Subclass Surface)

| Member | Type / Signature | Description |
|--------|------------------|-------------|
| `rootKey` | `string` | Root key prefix applied to every key |
| `_serviceName` | `string` | Backing field for the `serviceName` getter |
| `defaultTTL` | `number` | Default TTL in seconds (0 = no expiry) |
| `buildKey` | `protected buildKey(key: string): string` | Returns the prefixed storage key, e.g. `"MyApp:user:123"` (uses `KEY_SEPARATOR`) |
| `buildPattern` | `protected buildPattern(pattern: string): string` | Returns the prefixed pattern, e.g. `"MyApp:user:*"` |
| `resolveTTL` | `protected resolveTTL(ttlSeconds?: number): number \| undefined` | Effective TTL for an operation (`ttlSeconds ?? defaultTTL`); returns `undefined` when the effective TTL is 0 |

#### Example

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

interface User {
    id: number;
    name: string;
}

const cache = new MemoryCacheProvider({ rootKey: 'MyApp', defaultTTL: 300 });

// set / get — values are JSON-serialized under the hood
await cache.set<User>('user:123', { id: 123, name: 'Alice' });
const user = await cache.get<User>('user:123');
console.log(user?.name); // 'Alice'

// getOrSet is implemented once in CacheProvider for every backend
const other = await cache.getOrSet<User>('user:456', async () => {
    return { id: 456, name: 'Bob' };
}, 60);
console.log(other.name); // 'Bob'

await cache.shutdown();
```

---

### MemoryCacheProvider

In-memory cache backend with TTL support. Zero external dependencies. Uses a `Map` store with JSON serialization to match Redis behavior. Expired entries are lazily evicted on access and proactively removed by a periodic cleanup timer.

```typescript fragment
class MemoryCacheProvider extends CacheProvider {
    constructor(config: MemoryCacheConfig);
    protected store: Map<string, MemoryCacheEntry>;
    protected cleanupInterval: ReturnType<typeof setInterval> | undefined;
    protected cleanupIntervalMs: number;
    protected patternToRegex(pattern: string): RegExp;
    protected startCleanup(): void;
}
```

#### Constructor

```typescript fragment
constructor(config: MemoryCacheConfig)
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `MemoryCacheConfig` | Yes | — | Memory cache configuration |
| `config.rootKey` | `string` | Yes | — | Root key prefix (non-empty; validated by the base class) |
| `config.serviceName` | `string` | No | `"cache"` | Service name for WebAFX registration |
| `config.defaultTTL` | `number` | No | `0` | Default TTL in seconds; 0 = no expiry |
| `config.cleanupIntervalMs` | `number` | No | `60000` (1 min) | Cleanup interval for expired entries in milliseconds; `<= 0` disables the timer |

**Throws**: `Error` — `"CacheProvider: rootKey is required and cannot be empty"` when `rootKey` is empty or whitespace-only.

The constructor starts the periodic cleanup timer immediately. The timer is `unref()`'d so it never prevents the Node.js process from exiting.

#### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `set` | `set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>` | `Promise<void>` | JSON-serializes the value and stores it under `rootKey:key`. TTL is stored as an absolute expiration timestamp (`Date.now() + ttl × 1000`). |
| `get` | `get<T>(key: string): Promise<T \| undefined>` | `Promise<T \| undefined>` | Deserializes the stored JSON. Returns `undefined` on miss, expiration (lazy eviction), or JSON parse failure. |
| `delete` | `delete(key: string): Promise<boolean>` | `Promise<boolean>` | Removes the entry; `true` when the key existed. |
| `exists` | `exists(key: string): Promise<boolean>` | `Promise<boolean>` | `true` when present and not expired; expired entries are evicted on access. |
| `expire` | `expire(key: string, ttlSeconds: number): Promise<boolean>` | `Promise<boolean>` | Resets the expiration timestamp; `false` when the key is missing or already expired. |
| `ttl` | `ttl(key: string): Promise<number>` | `Promise<number>` | Remaining seconds (rounded up to match Redis); `-1` = no expiry; `-2` = missing/expired. |
| `deletePattern` | `deletePattern(pattern: string): Promise<number>` | `Promise<number>` | Converts `rootKey:<pattern>` (`*` wildcard) to a regex and deletes every match; returns the deleted count. |
| `clear` | `clear(): Promise<void>` | `Promise<void>` | Deletes all keys stored under this provider's `rootKey` prefix only. |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | Always `true` — no external dependencies to verify. |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Stops the cleanup interval and empties the store. |
| `getOrSet` | `getOrSet<T>(key: string, factory: () => Promise<T>, ttlSeconds?: number): Promise<T>` | `Promise<T>` | Cache-aside — inherited from `CacheProvider`. |

#### Protected Members

| Member | Type / Signature | Description |
|--------|------------------|-------------|
| `store` | `Map<string, MemoryCacheEntry>` | Internal storage: prefixed key → serialized value + optional `expiresAt` timestamp. `MemoryCacheEntry` is internal and not exported. |
| `cleanupInterval` | `ReturnType<typeof setInterval> \| undefined` | Cleanup timer handle; `undefined` after `shutdown()` or when cleanup is disabled |
| `cleanupIntervalMs` | `number` | Cleanup interval in milliseconds |
| `patternToRegex` | `protected patternToRegex(pattern: string): RegExp` | Converts a glob pattern (`*` → `.*`, other regex specials escaped) to an anchored `RegExp` |
| `startCleanup` | `protected startCleanup(): void` | Starts the periodic expiry sweep; no-op when `cleanupIntervalMs <= 0`; the interval is `unref()`'d |

#### Example

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({
    rootKey: 'TestApp',
    defaultTTL: 60,
    cleanupIntervalMs: 5000,
});

await cache.set('session:42', { userId: 42, roles: ['admin'] }, 120);
console.log(await cache.ttl('session:42')); // ~120

const deleted = await cache.deletePattern('session:*');
console.log(deleted); // 1

await cache.shutdown();
```

---

### RedisCacheProvider

Redis-backed cache provider using `ioredis`. All operations map directly to Redis commands (`SET ... EX`, `GET`, `DEL`, `EXISTS`, `EXPIRE`, `TTL`). Pattern operations use `SCAN` with batched `DEL` — never `KEYS`, so the server is never blocked.

```typescript fragment
class RedisCacheProvider extends CacheProvider {
    constructor(config: RedisCacheConfig);
    protected client: Redis; // ioredis
    protected scanAndDelete(pattern: string): Promise<number>;
}
```

#### Constructor

```typescript fragment
constructor(config: RedisCacheConfig)
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `RedisCacheConfig` | Yes | — | Redis cache configuration |
| `config.rootKey` | `string` | Yes | — | Root key prefix (non-empty; validated by the base class) |
| `config.serviceName` | `string` | No | `"cache"` | Service name for WebAFX registration |
| `config.defaultTTL` | `number` | No | `0` | Default TTL in seconds; 0 = no expiry |
| `config.host` | `string` | No | `"localhost"` | Redis host |
| `config.port` | `number` | No | `6379` | Redis port |
| `config.password` | `string` | No | — | Redis password |
| `config.db` | `number` | No | `0` | Redis database index (0–15) |
| `config.url` | `string` | No | — | Redis connection URL; **takes precedence** over host/port/password/db |
| `config.connectTimeout` | `number` | No | `5000` | Connection timeout in milliseconds |
| `config.maxRetriesPerRequest` | `number` | No | `3` | Maximum number of reconnection attempts |

**Throws**: `Error` — `"CacheProvider: rootKey is required and cannot be empty"` when `rootKey` is empty or whitespace-only.

The ioredis client is created immediately and begins connecting in the background.

#### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `set` | `set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>` | `Promise<void>` | `SET` with the `EX` flag when an effective TTL applies; otherwise plain `SET`. Value is JSON-serialized. |
| `get` | `get<T>(key: string): Promise<T \| undefined>` | `Promise<T \| undefined>` | `GET`, then JSON-parse. Redis `null` reply → `undefined`; parse failure → `undefined` (treated as a miss). |
| `delete` | `delete(key: string): Promise<boolean>` | `Promise<boolean>` | `DEL`; returns `true` when exactly one key was removed. |
| `exists` | `exists(key: string): Promise<boolean>` | `Promise<boolean>` | `EXISTS`; `true` when the key exists. |
| `expire` | `expire(key: string, ttlSeconds: number): Promise<boolean>` | `Promise<boolean>` | `EXPIRE`; `true` when the TTL was set on an existing key. |
| `ttl` | `ttl(key: string): Promise<number>` | `Promise<number>` | Raw Redis `TTL` reply: remaining seconds, `-1` (no expiry), `-2` (missing key). |
| `deletePattern` | `deletePattern(pattern: string): Promise<number>` | `Promise<number>` | `SCAN MATCH rootKey:<pattern> COUNT 100` with batched `DEL` per iteration. Non-blocking, production-safe. Returns total deleted. |
| `clear` | `clear(): Promise<void>` | `Promise<void>` | `SCAN` over `rootKey:*` with batched `DEL` — namespace-scoped only. |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | `PING`; `true` only when the reply is `PONG`; `false` on any connection error. |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | `QUIT` — graceful disconnect after pending commands complete. |
| `getOrSet` | `getOrSet<T>(key: string, factory: () => Promise<T>, ttlSeconds?: number): Promise<T>` | `Promise<T>` | Cache-aside — inherited from `CacheProvider`. |

#### Protected Members

| Member | Type / Signature | Description |
|--------|------------------|-------------|
| `client` | `Redis` | The `ioredis` client instance used for all commands |
| `scanAndDelete` | `protected scanAndDelete(pattern: string): Promise<number>` | `SCAN` + batched `DEL` for an already-prefixed pattern; returns the number of keys deleted |

#### Example

```typescript
import { RedisCacheProvider } from 'blendsdk/webafx-cache';

interface User {
    id: number;
    name: string;
}

const cache = new RedisCacheProvider({
    rootKey: 'MyApp',
    host: 'localhost',
    port: 6379,
    defaultTTL: 300,
});

await cache.set<User>('user:123', { id: 123, name: 'Alice' }, 600);
const user = await cache.get<User>('user:123');
console.log(user?.name); // 'Alice'

await cache.shutdown();
```

---

## Pub/Sub Hierarchy

### PubSubProvider

Abstract base class for all pub/sub backends. Completely independent from the cache hierarchy. Provides typed, JSON-serialized messaging with transparent channel prefixing; both built-in implementations share this contract.

```typescript fragment
abstract class PubSubProvider {
    constructor(config: PubSubProviderConfig);

    // Public accessor
    get serviceName(): string;

    // Abstract methods — implemented by each backend
    abstract publish<T>(channel: string, data: T): Promise<number>;
    abstract subscribe<T = unknown>(channel: string, handler: MessageHandler<T>): Promise<void>;
    abstract unsubscribe(channel: string): Promise<void>;
    abstract psubscribe<T = unknown>(pattern: string, handler: MessageHandler<T>): Promise<void>;
    abstract punsubscribe(pattern: string): Promise<void>;
    abstract activeSubscriptions(): { channels: string[]; patterns: string[] };
    abstract health(): Promise<boolean>;
    abstract shutdown(): Promise<void>;

    // Protected — subclass surface
    protected channelPrefix: string | undefined;
    protected _serviceName: string;
    protected buildChannel(channel: string): string;
    protected buildChannelPattern(pattern: string): string;
    protected stripPrefix(fullChannel: string): string;
    protected safeInvoke<T>(handler: MessageHandler<T>, message: PubSubMessage<T>): Promise<void>;
}
```

#### Constructor

```typescript fragment
constructor(config: PubSubProviderConfig)
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `PubSubProviderConfig` | Yes | — | Base pub/sub configuration |
| `config.channelPrefix` | `string` | No | — | Channel prefix for namespace isolation; when omitted, channels are used as-is |
| `config.serviceName` | `string` | No | `"pubsub"` | Service name used for WebAFX service container registration |

#### Public Properties

| Property | Type | Description |
|----------|------|-------------|
| `serviceName` | `string` (getter, read-only) | Service name for WebAFX service container registration; defaults to `"pubsub"` |

#### Abstract Methods (Backend Contract)

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `publish` | `publish<T>(channel: string, data: T): Promise<number>` | `Promise<number>` | Publishes a JSON-serialized payload; returns the number of subscribers that received the message. |
| `subscribe` | `subscribe<T = unknown>(channel: string, handler: MessageHandler<T>): Promise<void>` | `Promise<void>` | Subscribes a typed handler to an exact channel. Multiple handlers per channel are allowed. |
| `unsubscribe` | `unsubscribe(channel: string): Promise<void>` | `Promise<void>` | Removes all handlers for the channel and unsubscribes from the transport. |
| `psubscribe` | `psubscribe<T = unknown>(pattern: string, handler: MessageHandler<T>): Promise<void>` | `Promise<void>` | Subscribes a typed handler to a glob pattern (`*` = any sequence, `?` = single character). |
| `punsubscribe` | `punsubscribe(pattern: string): Promise<void>` | `Promise<void>` | Removes all handlers for the pattern and unsubscribes from the transport. |
| `activeSubscriptions` | `activeSubscriptions(): { channels: string[]; patterns: string[] }` | `{ channels: string[]; patterns: string[] }` | **Synchronous** (not a Promise). Returns user-facing names with the prefix stripped. |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | Backend health check (Redis: `PING` on both connections; Memory: always `true`). |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Graceful shutdown — unsubscribes all, closes connections, releases resources. |

#### Protected Members (Subclass Surface)

| Member | Type / Signature | Description |
|--------|------------------|-------------|
| `channelPrefix` | `string \| undefined` | Channel prefix; `undefined` = no prefixing |
| `_serviceName` | `string` | Backing field for the `serviceName` getter |
| `buildChannel` | `protected buildChannel(channel: string): string` | Returns the prefixed channel, e.g. `"MyApp:order:new"` (uses `CHANNEL_SEPARATOR`) |
| `buildChannelPattern` | `protected buildChannelPattern(pattern: string): string` | Returns the prefixed pattern, e.g. `"MyApp:order:*"` |
| `stripPrefix` | `protected stripPrefix(fullChannel: string): string` | Removes the channel prefix so handlers always see user-facing names |
| `safeInvoke` | `protected safeInvoke<T>(handler: MessageHandler<T>, message: PubSubMessage<T>): Promise<void>` | Invokes a handler inside `try/catch`; errors are logged via `console.error` and never break other subscribers |

#### Example

```typescript
import { MemoryPubSubProvider } from 'blendsdk/webafx-cache';
import type { PubSubMessage } from 'blendsdk/webafx-cache';

interface OrderEvent {
    orderId: number;
    total: number;
}

const pubsub = new MemoryPubSubProvider({ channelPrefix: 'MyApp' });

await pubsub.subscribe<OrderEvent>('order:new', (msg: PubSubMessage<OrderEvent>) => {
    console.log(`Order ${msg.data.orderId} for $${msg.data.total}`);
});

// Pattern handler receives the same envelope plus the matched pattern
await pubsub.psubscribe('order:*', (msg: PubSubMessage) => {
    console.log(`Matched ${msg.pattern} on ${msg.channel}`);
});

await pubsub.publish('order:new', { orderId: 123, total: 49.99 });

await pubsub.shutdown();
```

---

### MemoryPubSubProvider

In-process pub/sub provider for development and testing. Delivers messages synchronously within the same event loop tick. No network connections; health is always `true`.

```typescript fragment
class MemoryPubSubProvider extends PubSubProvider {
    constructor(config?: MemoryPubSubConfig);
    protected handlers: Map<string, Set<MessageHandler>>;
    protected patternHandlers: Map<string, Set<MessageHandler>>;
    protected matchGlob(channel: string, pattern: string): boolean;
}
```

#### Constructor

```typescript fragment
constructor(config?: MemoryPubSubConfig)
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `MemoryPubSubConfig` | No | `{}` | Optional configuration |
| `config.channelPrefix` | `string` | No | — | Channel prefix for namespace isolation |
| `config.serviceName` | `string` | No | `"pubsub"` | Service name for WebAFX registration |

#### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `publish` | `publish<T>(channel: string, data: T): Promise<number>` | `Promise<number>` | Performs a JSON round-trip (handlers receive a fresh copy, no shared references) and delivers to all exact-channel handlers plus matching pattern handlers. Returns the number of local handlers invoked. |
| `subscribe` | `subscribe<T = unknown>(channel: string, handler: MessageHandler<T>): Promise<void>` | `Promise<void>` | Registers a handler for an exact channel. Multiple handlers per channel; a `Set` deduplicates identical function references. |
| `unsubscribe` | `unsubscribe(channel: string): Promise<void>` | `Promise<void>` | Removes all handlers for the channel. |
| `psubscribe` | `psubscribe<T = unknown>(pattern: string, handler: MessageHandler<T>): Promise<void>` | `Promise<void>` | Registers a glob pattern handler: `*` matches any sequence, `?` matches exactly one character. |
| `punsubscribe` | `punsubscribe(pattern: string): Promise<void>` | `Promise<void>` | Removes all handlers for the pattern. |
| `activeSubscriptions` | `activeSubscriptions(): { channels: string[]; patterns: string[] }` | `{ channels: string[]; patterns: string[] }` | **Synchronous.** Exact channels and glob patterns with active handlers. |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | Always `true` — there are no external connections to verify. |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Clears all channel and pattern handlers. |

#### Protected Members

| Member | Type / Signature | Description |
|--------|------------------|-------------|
| `handlers` | `Map<string, Set<MessageHandler>>` | Exact channel handlers keyed by user-facing channel name |
| `patternHandlers` | `Map<string, Set<MessageHandler>>` | Pattern handlers keyed by user-facing pattern |
| `matchGlob` | `protected matchGlob(channel: string, pattern: string): boolean` | Glob match converting `*` → `.*` and `?` → `.`; all other regex specials are escaped |

#### Example

```typescript
import { MemoryPubSubProvider } from 'blendsdk/webafx-cache';

const pubsub = new MemoryPubSubProvider({ channelPrefix: 'Test' });

const received: string[] = [];
await pubsub.subscribe<string>('greet', (msg) => {
    received.push(msg.data);
});

await pubsub.publish('greet', 'Hello!');
console.log(received); // ['Hello!'] — memory delivery is synchronous

await pubsub.shutdown();
```

---

### RedisPubSubProvider

Redis-backed pub/sub provider using `ioredis`. Creates **two** dedicated connections: a `publisher` for `PUBLISH` commands and a `subscriber` for `SUBSCRIBE`/`PSUBSCRIBE` (Redis requires a dedicated connection once a client enters subscriber mode). Multiple in-process handlers for the same channel/pattern share a single Redis subscription.

```typescript fragment
class RedisPubSubProvider extends PubSubProvider {
    constructor(config: RedisPubSubConfig);
    protected publisher: Redis;   // ioredis — PUBLISH commands
    protected subscriber: Redis;  // ioredis — SUBSCRIBE/PSUBSCRIBE + message events
    protected handlers: Map<string, Set<MessageHandler>>;
    protected patternHandlers: Map<string, Set<MessageHandler>>;
    protected createRedisClient(config: RedisPubSubConfig): Redis;
    protected setupMessageHandlers(): void;
}
```

#### Constructor

```typescript fragment
constructor(config: RedisPubSubConfig)
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `RedisPubSubConfig` | Yes | — | Redis pub/sub configuration |
| `config.channelPrefix` | `string` | No | — | Channel prefix for namespace isolation |
| `config.serviceName` | `string` | No | `"pubsub"` | Service name for WebAFX registration |
| `config.host` | `string` | No | `"localhost"` | Redis host |
| `config.port` | `number` | No | `6379` | Redis port |
| `config.password` | `string` | No | — | Redis password |
| `config.db` | `number` | No | `0` | Redis database index |
| `config.url` | `string` | No | — | Redis connection URL; **takes precedence** over host/port/password/db |
| `config.connectTimeout` | `number` | No | `5000` | Connection timeout in milliseconds |
| `config.maxRetriesPerRequest` | `number` | No | `3` | Maximum number of reconnection attempts |

Both connections are created immediately, begin connecting in the background, and the subscriber has ioredis `message` / `pmessage` listeners wired up for routing.

#### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `publish` | `publish<T>(channel: string, data: T): Promise<number>` | `Promise<number>` | JSON-serializes the payload and sends `PUBLISH` on the publisher connection. Returns the number of Redis subscribers that received the message (as reported by Redis — includes subscribers in other processes). |
| `subscribe` | `subscribe<T = unknown>(channel: string, handler: MessageHandler<T>): Promise<void>` | `Promise<void>` | Registers a local handler; sends `SUBSCRIBE` on the subscriber connection only on the **first** handler for that channel. |
| `unsubscribe` | `unsubscribe(channel: string): Promise<void>` | `Promise<void>` | Sends `UNSUBSCRIBE` and removes all local handlers for the channel. |
| `psubscribe` | `psubscribe<T = unknown>(pattern: string, handler: MessageHandler<T>): Promise<void>` | `Promise<void>` | Registers a local pattern handler; sends `PSUBSCRIBE` only on the first handler for that pattern. |
| `punsubscribe` | `punsubscribe(pattern: string): Promise<void>` | `Promise<void>` | Sends `PUNSUBSCRIBE` and removes all local handlers for the pattern. |
| `activeSubscriptions` | `activeSubscriptions(): { channels: string[]; patterns: string[] }` | `{ channels: string[]; patterns: string[] }` | **Synchronous.** User-facing channel and pattern names (prefix stripped). |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | `PING` on both connections in parallel; `true` only when both reply `PONG`. |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Unsubscribes all channels and patterns, clears handler maps, then `QUIT`s both connections in parallel. |

#### Protected Members

| Member | Type / Signature | Description |
|--------|------------------|-------------|
| `publisher` | `Redis` | ioredis connection used exclusively for `PUBLISH` |
| `subscriber` | `Redis` | ioredis connection in subscriber mode; source of `message` / `pmessage` events |
| `handlers` | `Map<string, Set<MessageHandler>>` | Exact channel handlers keyed by user-facing channel name |
| `patternHandlers` | `Map<string, Set<MessageHandler>>` | Pattern handlers keyed by user-facing pattern |
| `createRedisClient` | `protected createRedisClient(config: RedisPubSubConfig): Redis` | Creates an ioredis client; honors `url` precedence over individual connection fields |
| `setupMessageHandlers` | `protected setupMessageHandlers(): void` | Wires `message`/`pmessage` events: strips the prefix, JSON-parses the payload, and fans out to handlers via `safeInvoke` |

#### Example

```typescript
import { RedisPubSubProvider } from 'blendsdk/webafx-cache';
import type { PubSubMessage } from 'blendsdk/webafx-cache';

interface OrderEvent {
    orderId: number;
    total: number;
}

const pubsub = new RedisPubSubProvider({
    channelPrefix: 'MyApp',
    host: 'localhost',
    port: 6379,
});

await pubsub.subscribe<OrderEvent>('order:new', (msg: PubSubMessage<OrderEvent>) => {
    console.log('New order:', msg.data.orderId);
});
await pubsub.psubscribe('audit:*', (msg: PubSubMessage) => {
    console.log('Audit event:', msg.channel);
});

await pubsub.publish('order:new', { orderId: 123, total: 49.99 });

await pubsub.shutdown();
```

---

## Cache Plugin Factories

All plugin factories return a WebAFX `PluginDefinition` — the object consumed by `app.use()`. The package sets:

- **`name`** — the provider's `serviceName` (`"cache"` by default, or the configured/custom name).
- **`priority`** — `options?.priority ?? 30` (default 30: installs after most core plugins).
- **`factory`** — an async initializer that registers the provider as a **singleton** service (with `dispose` calling `provider.shutdown()`), logs initialization through the WebAFX logger, and returns `{ health, shutdown }` hooks that wire the provider into the WebAFX health endpoint and graceful shutdown.

`blendsdk/webafx` is an **optional peer dependency** — it is only needed to feed these `PluginDefinition`s into a WebAFX application. `redisCachePlugin` additionally loads the Redis provider; use the `./memory` subpath if `ioredis` must never be evaluated.

---

### createCachePlugin

```typescript fragment
function createCachePlugin(
    provider: CacheProvider,
    options?: { priority?: number }
): PluginDefinition;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `provider` | `CacheProvider` | Yes | — | Any cache provider instance: `RedisCacheProvider`, `MemoryCacheProvider`, or a custom subclass |
| `options` | `{ priority?: number }` | No | — | Optional plugin overrides |
| `options.priority` | `number` | No | `30` | Plugin installation priority |

**Returns**: `PluginDefinition` — named after `provider.serviceName`, priority from options, with a factory that registers the provider as a singleton service and returns `health` / `shutdown` hooks.

#### Example

```typescript
import { createCachePlugin, MemoryCacheProvider } from 'blendsdk/webafx-cache';

const provider = new MemoryCacheProvider({ rootKey: 'MyApp' });

const plugin = createCachePlugin(provider, { priority: 20 });

console.log(plugin.name);     // 'cache' — from provider.serviceName
console.log(plugin.priority); // 20

await provider.shutdown();
```

---

### redisCachePlugin

```typescript fragment
function redisCachePlugin(config: RedisCacheConfig): PluginDefinition;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `RedisCacheConfig` | Yes | — | Redis cache configuration — `rootKey` plus connection options (`host`, `port`, `password`, `db`, `url`, `connectTimeout`, `maxRetriesPerRequest`), `serviceName`, `defaultTTL` |

**Returns**: `PluginDefinition`. Creates a `RedisCacheProvider` internally and delegates to `createCachePlugin()` with default options — the user never instantiates the provider manually.

#### Example

```typescript fragment
app.use(redisCachePlugin({
    rootKey: 'MyApp',
    host: 'localhost',
    port: 6379,
    defaultTTL: 300,
}));
```

Multi-cache with different service names:

```typescript fragment
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
```

---

### memoryCachePlugin

```typescript fragment
function memoryCachePlugin(config: MemoryCacheConfig): PluginDefinition;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `MemoryCacheConfig` | Yes | — | Memory cache configuration — `rootKey`, optional `serviceName`, `defaultTTL`, `cleanupIntervalMs` |

**Returns**: `PluginDefinition`. Creates a `MemoryCacheProvider` internally and delegates to `createCachePlugin()`. Exported from both the main entry and the Redis-free `./memory` subpath.

#### Example

```typescript
import { memoryCachePlugin } from 'blendsdk/webafx-cache';

const plugin = memoryCachePlugin({ rootKey: 'MyApp', defaultTTL: 300 });

console.log(plugin.name);     // 'cache'
console.log(plugin.priority); // 30

// In a WebAFX application: app.use(plugin)
```

---

### createCache

```typescript fragment
function createCache(config: CacheFactoryConfig): CacheProvider;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `CacheFactoryConfig` | Yes | — | Factory configuration; the `type` discriminator selects the backend |
| `config.type` | `"redis" \| "memory"` | Yes | — | Backend to create |
| `config.rootKey` | `string` | Yes | — | Root key prefix for all cache keys |
| `config.serviceName` | `string` | No | `"cache"` | Service name passed through to the provider |
| `config.defaultTTL` | `number` | No | `0` | Default TTL passed through to the provider |
| `config.host` / `port` / `password` / `db` / `url` | — | No | — | Redis-only fields; used only when `type: "redis"` |
| `config.cleanupIntervalMs` | `number` | No | `60000` | Memory-only field; used only when `type: "memory"` |

**Returns**: `CacheProvider` — a `RedisCacheProvider` when `type` is `"redis"`, a `MemoryCacheProvider` when `type` is `"memory"`.

**Throws**: `Error` — `Unknown cache type: "<type>". Supported types: "redis", "memory".` for any other type value.

#### Example

```typescript
import { createCache } from 'blendsdk/webafx-cache';

const cache = createCache({
    type: process.env.NODE_ENV === 'production' ? 'redis' : 'memory',
    rootKey: 'MyApp',
    host: 'localhost',
    port: 6379,
    defaultTTL: 300,
});

await cache.set('greeting', 'hello');
console.log(await cache.get<string>('greeting')); // 'hello'

await cache.shutdown();
```

---

## Pub/Sub Plugin Factories

These factories return the same `PluginDefinition` shape as the cache factories, with one addition: pub/sub plugins support **declarative subscriptions** via `options.subscriptions`, registered at plugin install time (`channel` → `provider.subscribe()`, `pattern` → `provider.psubscribe()`, in order). When an entry provides both `channel` and `pattern`, the `channel` branch is used.

---

### createPubSubPlugin

```typescript fragment
function createPubSubPlugin(
    provider: PubSubProvider,
    options?: PubSubPluginOptions
): PluginDefinition;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `provider` | `PubSubProvider` | Yes | — | Any pub/sub provider instance: `RedisPubSubProvider`, `MemoryPubSubProvider`, or a custom subclass |
| `options` | `PubSubPluginOptions` | No | — | Plugin overrides and declarative subscriptions |
| `options.priority` | `number` | No | `30` | Plugin installation priority |
| `options.subscriptions` | `SubscriptionDefinition[]` | No | — | Subscriptions registered during the plugin factory execution |

**Returns**: `PluginDefinition` — named after `provider.serviceName`, with a factory that registers the provider as a singleton service, registers declarative subscriptions, and returns `health` / `shutdown` hooks.

#### Example

```typescript
import { createPubSubPlugin, MemoryPubSubProvider } from 'blendsdk/webafx-cache';
import type { PubSubMessage } from 'blendsdk/webafx-cache';

const provider = new MemoryPubSubProvider({ channelPrefix: 'MyApp' });

const plugin = createPubSubPlugin(provider, {
    subscriptions: [
        {
            channel: 'order:created',
            handler: (msg: PubSubMessage) => console.log(msg.channel, msg.data),
        },
    ],
});

console.log(plugin.name); // 'pubsub'

await provider.shutdown();
```

---

### redisPubSubPlugin

```typescript fragment
function redisPubSubPlugin(
    config: RedisPubSubConfig,
    options?: PubSubPluginOptions
): PluginDefinition;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `RedisPubSubConfig` | Yes | — | Redis pub/sub configuration — connection options (`host`, `port`, `password`, `db`, `url`, `connectTimeout`, `maxRetriesPerRequest`), `channelPrefix`, `serviceName` |
| `options` | `PubSubPluginOptions` | No | — | Plugin overrides and declarative subscriptions (`priority`, `subscriptions`) |

**Returns**: `PluginDefinition`. Creates a `RedisPubSubProvider` internally (two connections) and delegates to `createPubSubPlugin()`.

#### Example

```typescript fragment
app.use(redisPubSubPlugin(
    { host: 'localhost', port: 6379, channelPrefix: 'MyApp' },
    {
        subscriptions: [
            { channel: 'order:created', handler: handleOrderCreated },
            { pattern: 'audit:*', handler: handleAuditEvent },
        ],
    }
));
```

---

### memoryPubSubPlugin

```typescript fragment
function memoryPubSubPlugin(
    config?: MemoryPubSubConfig,
    options?: PubSubPluginOptions
): PluginDefinition;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `MemoryPubSubConfig` | No | `{}` | Optional memory pub/sub configuration (`channelPrefix`, `serviceName`) |
| `options` | `PubSubPluginOptions` | No | — | Plugin overrides and declarative subscriptions |

**Returns**: `PluginDefinition`. Creates a `MemoryPubSubProvider` internally and delegates to `createPubSubPlugin()`. Exported from both the main entry and the Redis-free `./memory` subpath.

#### Example

```typescript
import { memoryPubSubPlugin } from 'blendsdk/webafx-cache';
import type { PubSubMessage } from 'blendsdk/webafx-cache';

const plugin = memoryPubSubPlugin(
    { channelPrefix: 'MyApp' },
    {
        subscriptions: [
            { pattern: 'audit:*', handler: (msg: PubSubMessage) => console.log(msg.channel) },
        ],
    }
);

console.log(plugin.name);     // 'pubsub'
console.log(plugin.priority); // 30
```

---

### createPubSub

```typescript fragment
function createPubSub(config: PubSubFactoryConfig): PubSubProvider;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `PubSubFactoryConfig` | Yes | — | Factory configuration; the `type` discriminator selects the backend |
| `config.type` | `"redis" \| "memory"` | Yes | — | Backend to create |
| `config.channelPrefix` | `string` | No | — | Channel prefix passed through to the provider |
| `config.serviceName` | `string` | No | `"pubsub"` | Service name passed through to the provider |
| `config.host` / `password` / `db` / `url` | — | No | — | Redis-only fields; used only when `type: "redis"` |
| `config.port` | `number` | No | `6379` | Redis-only field; used only when `type: "redis"` |

**Returns**: `PubSubProvider` — a `RedisPubSubProvider` when `type` is `"redis"`, a `MemoryPubSubProvider` when `type` is `"memory"`.

**Throws**: `Error` — `Unknown pub/sub type: "<type>". Supported types: "redis", "memory".` for any other type value.

#### Example

```typescript
import { createPubSub } from 'blendsdk/webafx-cache';
import type { PubSubMessage } from 'blendsdk/webafx-cache';

interface OrderEvent {
    orderId: number;
    total: number;
}

const pubsub = createPubSub({
    type: process.env.NODE_ENV === 'production' ? 'redis' : 'memory',
    channelPrefix: 'MyApp',
});

await pubsub.subscribe<OrderEvent>('order:new', (msg: PubSubMessage<OrderEvent>) => {
    console.log('New order:', msg.data.orderId);
});

await pubsub.publish('order:new', { orderId: 1, total: 9.99 });

await pubsub.shutdown();
```

---

## Configuration Types

### RedisConnectionConfig

Shared Redis connection options used by both `RedisCacheConfig` and `RedisPubSubConfig`. When `url` is provided, it takes precedence over `host`/`port`/`password`/`db`.

```typescript fragment
interface RedisConnectionConfig {
    host?: string;
    port?: number;
    password?: string;
    db?: number;
    url?: string;
    connectTimeout?: number;
    maxRetriesPerRequest?: number;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `host` | `string` | Redis host. Default: `"localhost"` |
| `port` | `number` | Redis port. Default: `6379` |
| `password` | `string` | Redis password (optional) |
| `db` | `number` | Redis database index (0–15). Default: `0` |
| `url` | `string` | Redis connection URL; overrides `host`/`port`/`password`/`db` if provided |
| `connectTimeout` | `number` | Connection timeout in milliseconds. Default: `5000` |
| `maxRetriesPerRequest` | `number` | Maximum number of reconnection attempts. Default: `3` |

---

### CacheProviderConfig

Base configuration shared by all cache providers. Every provider requires at minimum a `rootKey` for namespace isolation.

```typescript fragment
interface CacheProviderConfig {
    rootKey: string;
    serviceName?: string;
    defaultTTL?: number;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `rootKey` | `string` | **Required.** Root key prefix for all cache keys (e.g. `"MyApp"`) |
| `serviceName` | `string` | Service name for WebAFX service container registration. Default: `"cache"`; use different names for multi-cache scenarios |
| `defaultTTL` | `number` | Default TTL in seconds; 0 means no expiry. Default: `0` |

---

### RedisCacheConfig

Redis cache configuration — extends `CacheProviderConfig` with `RedisConnectionConfig`. Exposes the same fields as both bases combined (a non-breaking composition).

```typescript fragment
interface RedisCacheConfig extends CacheProviderConfig, RedisConnectionConfig {}
```

| Property | Type | Description |
|----------|------|-------------|
| `rootKey` | `string` | **Required.** Root key prefix for all cache keys |
| `serviceName` | `string` | Service name for WebAFX registration. Default: `"cache"` |
| `defaultTTL` | `number` | Default TTL in seconds; 0 = no expiry. Default: `0` |
| `host` / `port` / `password` / `db` / `url` / `connectTimeout` / `maxRetriesPerRequest` | — | Redis connection options — see `RedisConnectionConfig` |

---

### MemoryCacheConfig

In-memory cache configuration — extends `CacheProviderConfig` with memory management options.

```typescript fragment
interface MemoryCacheConfig extends CacheProviderConfig {
    cleanupIntervalMs?: number;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `rootKey` | `string` | **Required.** Root key prefix for all cache keys |
| `serviceName` | `string` | Service name for WebAFX registration. Default: `"cache"` |
| `defaultTTL` | `number` | Default TTL in seconds; 0 = no expiry. Default: `0` |
| `cleanupIntervalMs` | `number` | Cleanup interval for expired entries in milliseconds. Default: `60000` (1 min); `<= 0` disables the cleanup timer |

---

### CacheFactoryConfig

Configuration for the `createCache()` environment-based factory. The `type` field determines the backend; Redis-only fields are used only when `type: "redis"` and memory-only fields only when `type: "memory"`.

```typescript fragment
interface CacheFactoryConfig {
    type: "redis" | "memory";
    rootKey: string;
    serviceName?: string;
    defaultTTL?: number;
    host?: string;
    port?: number;
    password?: string;
    db?: number;
    url?: string;
    cleanupIntervalMs?: number;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `type` | `"redis" \| "memory"` | **Required.** Cache backend type |
| `rootKey` | `string` | **Required.** Root key prefix for all cache keys |
| `serviceName` | `string` | Service name for WebAFX service container. Default: `"cache"` |
| `defaultTTL` | `number` | Default TTL in seconds. Default: `0` |
| `host` | `string` | Redis-only: Redis host |
| `port` | `number` | Redis-only: Redis port |
| `password` | `string` | Redis-only: Redis password |
| `db` | `number` | Redis-only: Redis database index |
| `url` | `string` | Redis-only: Redis connection URL |
| `cleanupIntervalMs` | `number` | Memory-only: cleanup interval in milliseconds |

---

### PubSubProviderConfig

Base configuration shared by all pub/sub providers. The `channelPrefix` provides namespace isolation — all channels are automatically prefixed so multiple applications can share one Redis instance without channel collisions.

```typescript fragment
interface PubSubProviderConfig {
    channelPrefix?: string;
    serviceName?: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `channelPrefix` | `string` | Channel prefix applied to all channels automatically. Example: prefix `"MyApp"` turns channel `"order:new"` into `"MyApp:order:new"` |
| `serviceName` | `string` | Service name for WebAFX service container registration. Default: `"pubsub"`; use different names for multi-pubsub scenarios |

---

### RedisPubSubConfig

Redis pub/sub configuration — extends `PubSubProviderConfig` with `RedisConnectionConfig`. The provider creates **two** ioredis connections internally: one for publishing and one for subscribing.

```typescript fragment
interface RedisPubSubConfig extends PubSubProviderConfig, RedisConnectionConfig {}
```

| Property | Type | Description |
|----------|------|-------------|
| `channelPrefix` | `string` | Channel prefix for namespace isolation |
| `serviceName` | `string` | Service name for WebAFX registration. Default: `"pubsub"` |
| `host` / `port` / `password` / `db` / `url` / `connectTimeout` / `maxRetriesPerRequest` | — | Redis connection options — see `RedisConnectionConfig` |

---

### MemoryPubSubConfig

In-memory pub/sub configuration — no additional fields beyond the base config.

```typescript fragment
interface MemoryPubSubConfig extends PubSubProviderConfig {}
```

| Property | Type | Description |
|----------|------|-------------|
| `channelPrefix` | `string` | Channel prefix for namespace isolation |
| `serviceName` | `string` | Service name for WebAFX registration. Default: `"pubsub"` |

---

### PubSubFactoryConfig

Configuration for the `createPubSub()` environment-based factory. Redis-only fields are used only when `type: "redis"`.

```typescript fragment
interface PubSubFactoryConfig extends PubSubProviderConfig {
    type: "redis" | "memory";
    host?: string;
    port?: number;
    password?: string;
    db?: number;
    url?: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `type` | `"redis" \| "memory"` | **Required.** Pub/sub backend type |
| `channelPrefix` | `string` | Channel prefix passed through to the provider |
| `serviceName` | `string` | Service name passed through to the provider. Default: `"pubsub"` |
| `host` | `string` | Redis-only: Redis host |
| `port` | `number` | Redis-only: Redis port |
| `password` | `string` | Redis-only: Redis password |
| `db` | `number` | Redis-only: Redis database index |
| `url` | `string` | Redis-only: Redis connection URL |

---

## Message Types and Plugin Options

### PubSubMessage

Message envelope delivered to subscription handlers. Contains the deserialized payload and metadata about the channel and (for pattern subscriptions) the pattern that matched. The `channel` field always contains the user-facing name — the prefix is stripped.

```typescript fragment
interface PubSubMessage<T = unknown> {
    channel: string;
    data: T;
    pattern?: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `channel` | `string` | The channel the message was published to (prefix stripped) |
| `data` | `T` | The deserialized message payload |
| `pattern` | `string` | For pattern subscriptions: the pattern that matched (prefix stripped). `undefined` for exact-channel deliveries |

---

### MessageHandler

Handler function type for pub/sub messages. Can be synchronous or asynchronous. Errors thrown by handlers are caught and logged (via `safeInvoke`) — they never break other subscribers or crash the subscriber connection.

```typescript fragment
type MessageHandler<T = unknown> = (message: PubSubMessage<T>) => void | Promise<void>;
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `message` | `PubSubMessage<T>` | The message envelope with the deserialized payload |

**Returns**: `void | Promise<void>`

---

### SubscriptionDefinition

Subscription entry for declarative registration via plugin options. Exactly one of `channel` or `pattern` should be provided: `channel` subscribes to an exact channel (`SUBSCRIBE`), `pattern` subscribes to a glob pattern (`PSUBSCRIBE`). If both are present, the `channel` branch is used.

```typescript fragment
interface SubscriptionDefinition<T = unknown> {
    channel?: string;
    pattern?: string;
    handler: MessageHandler<T>;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `channel` | `string` | Exact channel name (mutually exclusive with `pattern`) |
| `pattern` | `string` | Channel pattern with glob wildcards (mutually exclusive with `channel`) |
| `handler` | `MessageHandler<T>` | **Required.** Handler function invoked when a matching message arrives |

---

### PubSubPluginOptions

Options for `createPubSubPlugin()`, `redisPubSubPlugin()`, and `memoryPubSubPlugin()`.

```typescript fragment
interface PubSubPluginOptions {
    priority?: number;
    subscriptions?: SubscriptionDefinition[];
}
```

| Property | Type | Description |
|----------|------|-------------|
| `priority` | `number` | Plugin installation priority. Default: `30` |
| `subscriptions` | `SubscriptionDefinition[]` | Declarative subscriptions registered at plugin install time. Each entry specifies a `channel` (exact) or `pattern` (glob) with a handler; subscriptions are registered in order during the plugin factory execution |

---

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_SERVICE_NAME` | `"cache"` | Default service name for cache providers and cache plugins when no `serviceName` is configured |
| `DEFAULT_TTL` | `0` | Default TTL in seconds; 0 means no expiry |
| `KEY_SEPARATOR` | `":"` | Separator between `rootKey` and a user-provided cache key (e.g. `"MyApp:user:123"`) |
| `DEFAULT_PUBSUB_SERVICE_NAME` | `"pubsub"` | Default service name for pub/sub providers and pub/sub plugins when no `serviceName` is configured |
| `CHANNEL_SEPARATOR` | `":"` | Separator between `channelPrefix` and a channel name (same as `KEY_SEPARATOR` for consistency) |

---

## Memory Subpath (`blendsdk/webafx-cache/memory`)

Redis-free entry point. The main entry point exports the Redis providers, whose modules import `ioredis` at load time. Applications that only need the in-memory providers — tests, single-instance deployments — can import from this subpath instead, and `ioredis` is never evaluated.

### Exported Values

| Export | Kind | Notes |
|--------|------|-------|
| `CacheProvider` | abstract class | Same object identity as the main entry |
| `PubSubProvider` | abstract class | Same object identity as the main entry |
| `MemoryCacheProvider` | class | Same object identity as the main entry |
| `MemoryPubSubProvider` | class | Same object identity as the main entry |
| `createCachePlugin` | function | Redis-free plugin builder — same function as the main entry |
| `createPubSubPlugin` | function | Redis-free plugin builder — same function as the main entry |
| `memoryCachePlugin` | function | Memory cache plugin factory — see `memoryCachePlugin()` |
| `memoryPubSubPlugin` | function | Memory pub/sub plugin factory — see `memoryPubSubPlugin()` |

### Exported Types

| Export | Kind |
|--------|------|
| `CacheProviderConfig` | interface |
| `MemoryCacheConfig` | interface |
| `MemoryPubSubConfig` | interface |
| `PubSubPluginOptions` | interface |
| `PubSubMessage` | interface |
| `MessageHandler` | type alias |
| `SubscriptionDefinition` | interface |

The Redis providers (`RedisCacheProvider`, `RedisPubSubProvider`) are deliberately **not** exposed by this subpath.

### Example

```typescript
import { MemoryCacheProvider, memoryCachePlugin } from 'blendsdk/webafx-cache/memory';

const cache = new MemoryCacheProvider({ rootKey: 'Edge' });
await cache.set('health', { ok: true });
console.log(await cache.get<{ ok: boolean }>('health')); // { ok: true }
await cache.shutdown();

const plugin = memoryCachePlugin({ rootKey: 'Edge' });
console.log(plugin.name); // 'cache'
```

---

## Behavioral Notes and Error Semantics

| Behavior | Detail |
|----------|--------|
| **Root key validation** | Constructing any cache provider (`CacheProvider`, `MemoryCacheProvider`, `RedisCacheProvider`) with an empty or whitespace-only `rootKey` throws `Error: "CacheProvider: rootKey is required and cannot be empty"`. Pub/sub providers do not validate their config. |
| **Unknown factory types** | `createCache()` throws `Unknown cache type: "<type>". Supported types: "redis", "memory".`; `createPubSub()` throws `Unknown pub/sub type: "<type>". Supported types: "redis", "memory".` |
| **Cache misses** | `get()` returns `undefined` for missing keys, expired entries, and stored values that fail JSON parsing — a corrupt value is treated exactly like a miss. |
| **TTL semantics** | Effective TTL is `ttlSeconds ?? defaultTTL`; an effective TTL of `0` means no expiry. `ttl()` follows Redis conventions: positive seconds, `-1` (no expiry), `-2` (missing). |
| **Namespace scoping** | `deletePattern()` and `clear()` only ever touch keys under the provider's own `rootKey` prefix — shared Redis databases are safe. |
| **Publish without subscribers** | `publish()` never throws for missing subscribers; it returns `0`. |
| **Handler error isolation** | Pub/sub handler errors (sync or async) are caught per handler and logged via `console.error`; other handlers and the subscriber connection are unaffected. |
| **Fan-out counts** | `MemoryPubSubProvider.publish()` returns the number of local handlers invoked (exact + matching pattern handlers). `RedisPubSubProvider.publish()` returns Redis's subscriber count, which may include subscribers in other processes. |
| **Shared subscriptions** | `RedisPubSubProvider` sends `SUBSCRIBE`/`PSUBSCRIBE` only when the first local handler for a channel/pattern is registered; additional local handlers share that single Redis subscription. |
| **Connection lifecycle** | Redis providers create their ioredis client(s) in the constructor and connect in the background; `health()` returns `false` after `shutdown()` because the connection is closed. `MemoryCacheProvider`'s cleanup timer is `unref()`'d and never keeps the process alive. |

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
