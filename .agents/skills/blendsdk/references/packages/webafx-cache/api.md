> **Package**: `blendsdk/webafx-cache`

# webafx-cache API Reference

This document is the complete API reference for `blendsdk/webafx-cache` — the application-wide caching and pub/sub plugin for WebAFX. It documents every symbol re-exported from the package root (`src/index.ts`): six classes, eight factory functions, configuration and message types, and five constants.

---

## Overview

The package contains two independent abstraction hierarchies:

| Hierarchy | Abstract base | Concrete backends | Plugin factories |
|-----------|---------------|-------------------|------------------|
| Caching | `CacheProvider` | `MemoryCacheProvider`, `RedisCacheProvider` | `createCachePlugin()`, `redisCachePlugin()`, `memoryCachePlugin()`, `createCache()` |
| Pub/Sub | `PubSubProvider` | `MemoryPubSubProvider`, `RedisPubSubProvider` | `createPubSubPlugin()`, `redisPubSubPlugin()`, `memoryPubSubPlugin()`, `createPubSub()` |

Both backends of each hierarchy satisfy an identical async contract, so they can be swapped without changing calling code. Providers can be used standalone; the plugin factories integrate them with WebAFX and return a `PluginDefinition` (a type from `blendsdk/webafx`, the optional peer dependency).

The Redis backends are built on `ioredis` (the only runtime dependency). The in-memory backends have zero external dependencies.

---

## Export Summary

### Classes

| Class | Description |
|-------|-------------|
| `CacheProvider` | Abstract base class for all cache providers — Redis-like async API with key namespacing, TTL handling, and `getOrSet()`. |
| `MemoryCacheProvider` | In-memory cache backend with TTL, lazy eviction, and a periodic cleanup timer. Zero dependencies. |
| `RedisCacheProvider` | Redis-backed cache using `ioredis` — native TTL and `SCAN`-based pattern deletion. |
| `PubSubProvider` | Abstract base class for all pub/sub providers — typed JSON messaging with channel namespacing and pattern subscriptions. |
| `MemoryPubSubProvider` | In-process pub/sub backend with glob pattern support. Zero dependencies. |
| `RedisPubSubProvider` | Redis-backed pub/sub with two dedicated `ioredis` connections (publisher + subscriber). |

### Functions

| Function | Description |
|----------|-------------|
| `createCachePlugin` | Wraps any `CacheProvider` in a WebAFX plugin definition. |
| `redisCachePlugin` | One-liner: creates a `RedisCacheProvider` and wraps it in a WebAFX plugin. |
| `memoryCachePlugin` | One-liner: creates a `MemoryCacheProvider` and wraps it in a WebAFX plugin. |
| `createCache` | Factory returning a `RedisCacheProvider` or `MemoryCacheProvider` based on a `type` discriminator. |
| `createPubSubPlugin` | Wraps any `PubSubProvider` in a WebAFX plugin definition (supports declarative subscriptions). |
| `redisPubSubPlugin` | One-liner: creates a `RedisPubSubProvider` and wraps it in a WebAFX plugin. |
| `memoryPubSubPlugin` | One-liner: creates a `MemoryPubSubProvider` and wraps it in a WebAFX plugin. |
| `createPubSub` | Factory returning a `RedisPubSubProvider` or `MemoryPubSubProvider` based on a `type` discriminator. |

### Types

| Type | Kind | Description |
|------|------|-------------|
| `RedisConnectionConfig` | interface | Shared Redis connection options (`host`, `port`, `password`, `db`, `url`, `connectTimeout`, `maxRetriesPerRequest`). |
| `CacheProviderConfig` | interface | Base cache configuration (`rootKey`, `serviceName`, `defaultTTL`). |
| `RedisCacheConfig` | interface | `CacheProviderConfig` + `RedisConnectionConfig`. |
| `MemoryCacheConfig` | interface | `CacheProviderConfig` + `cleanupIntervalMs`. |
| `CacheFactoryConfig` | interface | Configuration for `createCache()` with a `type` discriminator. |
| `PubSubProviderConfig` | interface | Base pub/sub configuration (`channelPrefix`, `serviceName`). |
| `RedisPubSubConfig` | interface | `PubSubProviderConfig` + `RedisConnectionConfig`. |
| `MemoryPubSubConfig` | interface | `PubSubProviderConfig` with no additional members. |
| `PubSubFactoryConfig` | interface | Configuration for `createPubSub()` with a `type` discriminator. |
| `PubSubMessage<T>` | interface | Message envelope delivered to handlers (`channel`, `data`, optional `pattern`). |
| `MessageHandler<T>` | type alias | Handler signature: `(message: PubSubMessage<T>) => void \| Promise<void>`. |
| `SubscriptionDefinition<T>` | interface | Declarative subscription entry (`channel` or `pattern` plus `handler`). |
| `PubSubPluginOptions` | interface | Options for `createPubSubPlugin()` (`priority`, `subscriptions`). |

---

## Shared Contract

Every provider honors the following behavior, regardless of backend:

- **Async uniform API** — all cache and pub/sub operations return Promises. The only synchronous method is `activeSubscriptions()`.
- **Transparent namespacing** — cache keys are stored as `rootKey + ":" + key`. Pub/sub channels and patterns are prefixed with `channelPrefix + ":"` only when a `channelPrefix` is configured. `PubSubMessage.channel`, `PubSubMessage.pattern`, and `activeSubscriptions()` always report un-prefixed, user-facing names.
- **TTL semantics** — all TTLs are expressed in seconds. The effective TTL of an operation is `ttlSeconds ?? defaultTTL`; a resolved value of `0` (or less) means no expiry, even when `defaultTTL` is set. `ttl()` follows Redis conventions: positive = remaining seconds, `-1` = key exists with no expiry, `-2` = key does not exist.
- **JSON serialization** — cache values and pub/sub payloads are JSON-serialized on write and deserialized on read in both backends, so stored/delivered values never share references with the caller's object. JSON parse failures are treated as cache misses (`undefined`); in pub/sub they are logged to `console.error` and the message is dropped.
- **Handler error isolation (pub/sub)** — errors thrown by handlers (sync or async) are caught and logged by `safeInvoke()`; one failing handler never affects other subscribers or the subscriber connection.
- **Lifecycle** — every provider implements `health()` (used by WebAFX `/health` checks) and `shutdown()` (used by graceful shutdown). Each provider is an application-wide singleton, not a per-request object.

---

## Caching

### CacheProvider (Abstract Base Class)

Abstract base class for all cache implementations. `MemoryCacheProvider` and `RedisCacheProvider` extend this class and implement the abstract methods with backend-specific logic. It cannot be instantiated directly.

```typescript fragment
abstract class CacheProvider {
    protected rootKey: string;
    protected _serviceName: string;
    protected defaultTTL: number;

    constructor(config: CacheProviderConfig);

    get serviceName(): string;

    protected buildKey(key: string): string;
    protected buildPattern(pattern: string): string;
    protected resolveTTL(ttlSeconds?: number): number | undefined;

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

    getOrSet<T>(key: string, factory: () => Promise<T>, ttlSeconds?: number): Promise<T>;
}
```

#### Constructor

```typescript fragment
constructor(config: CacheProviderConfig);
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `CacheProviderConfig` | Yes | — | Base cache configuration. `config.rootKey` is validated in the constructor. |

**Throws:** `Error` with the message `CacheProvider: rootKey is required and cannot be empty` when `config.rootKey` is missing, empty, or whitespace-only.

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

try {
    const cache = new MemoryCacheProvider({ rootKey: "" });
    await cache.shutdown();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    // CacheProvider: rootKey is required and cannot be empty
}
```

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `serviceName` | `string` | Read-only getter. Service name used for WebAFX service container registration. Set from `config.serviceName`; defaults to `'cache'`. |

#### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `set` | `set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>` | `Promise<void>` | Abstract. Stores `value` (JSON-serialized) under the key namespaced by `rootKey`. `ttlSeconds` overrides `defaultTTL`; an effective TTL of `0` means no expiry. |
| `get` | `get<T>(key: string): Promise<T \| undefined>` | `Promise<T \| undefined>` | Abstract. Returns the deserialized value, or `undefined` on a cache miss or after expiry. |
| `delete` | `delete(key: string): Promise<boolean>` | `Promise<boolean>` | Abstract. Returns `true` if the key existed and was deleted. |
| `exists` | `exists(key: string): Promise<boolean>` | `Promise<boolean>` | Abstract. Returns `true` if the key exists and has not expired. |
| `expire` | `expire(key: string, ttlSeconds: number): Promise<boolean>` | `Promise<boolean>` | Abstract. Sets a new TTL on an existing key without changing its value. Returns `false` if the key does not exist. |
| `ttl` | `ttl(key: string): Promise<number>` | `Promise<number>` | Abstract. Remaining TTL in seconds. Redis conventions: `-1` = exists without expiry, `-2` = does not exist. |
| `deletePattern` | `deletePattern(pattern: string): Promise<number>` | `Promise<number>` | Abstract. Deletes all keys in this namespace matching a `*` wildcard pattern (e.g., `'user:*'`). Returns the number of keys deleted. |
| `clear` | `clear(): Promise<void>` | `Promise<void>` | Abstract. Deletes all keys under this provider's `rootKey` namespace only — other namespaces are not touched. |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | Abstract. Returns `true` if the backend is operational. |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Abstract. Releases connections and resources (closes the Redis client, stops cleanup timers). |
| `getOrSet` | `getOrSet<T>(key: string, factory: () => Promise<T>, ttlSeconds?: number): Promise<T>` | `Promise<T>` | Concrete — shared by all backends. Cache-aside: returns the cached value on a hit; otherwise awaits `factory()`, caches the result with `ttlSeconds`, and returns it. |

#### Protected Members

Available to subclasses implementing a custom backend.

| Member | Type / Signature | Description |
|--------|------------------|-------------|
| `rootKey` | `string` | Root key prefix applied to all cache keys. |
| `_serviceName` | `string` | Backing field for the `serviceName` getter. |
| `defaultTTL` | `number` | Default TTL in seconds (`0` = no expiry). |
| `buildKey(key)` | `(key: string): string` | Prefixes a user key: `rootKey + ':' + key`. |
| `buildPattern(pattern)` | `(pattern: string): string` | Prefixes a pattern: `rootKey + ':' + pattern`. |
| `resolveTTL(ttlSeconds)` | `(ttlSeconds?: number): number \| undefined` | Resolves the effective TTL: `ttlSeconds ?? defaultTTL`; returns `undefined` when the result is not positive (no expiry). |

#### Example

`CacheProvider` is abstract — use it through a concrete backend. A custom backend extends this class and implements the abstract methods; the protected helpers and `getOrSet()` are inherited.

```typescript
import { MemoryCacheProvider, type CacheProvider } from "blendsdk/webafx-cache";

interface User {
    id: string;
    name: string;
}

const cache: CacheProvider = new MemoryCacheProvider({ rootKey: "MyApp" });

await cache.set<User>("user:123", { id: "123", name: "Alice" }, 300);
const user = await cache.get<User>("user:123");
console.log(user?.name); // "Alice"

await cache.shutdown();
```

---

### MemoryCacheProvider

In-memory cache backend with TTL support. Uses a `Map` for storage and JSON serialization to match Redis behavior, so both cache backends are interchangeable. Expired entries are evicted lazily on access and proactively by a periodic cleanup timer.

```typescript fragment
class MemoryCacheProvider extends CacheProvider {
    protected store: Map<string, MemoryCacheEntry>;
    protected cleanupInterval: ReturnType<typeof setInterval> | undefined;
    protected cleanupIntervalMs: number;

    constructor(config: MemoryCacheConfig);

    set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
    get<T>(key: string): Promise<T | undefined>;
    delete(key: string): Promise<boolean>;
    exists(key: string): Promise<boolean>;
    expire(key: string, ttlSeconds: number): Promise<boolean>;
    ttl(key: string): Promise<number>;
    deletePattern(pattern: string): Promise<number>;
    clear(): Promise<void>;
    health(): Promise<boolean>;
    shutdown(): Promise<void>;

    protected patternToRegex(pattern: string): RegExp;
    protected startCleanup(): void;
}
```

`getOrSet()` is inherited from `CacheProvider`. `MemoryCacheEntry` is an internal storage record (JSON string plus optional `expiresAt` timestamp) and is not exported.

#### Constructor

```typescript fragment
constructor(config: MemoryCacheConfig);
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `MemoryCacheConfig` | Yes | — | Memory cache configuration. `rootKey` is required; `cleanupIntervalMs` defaults to `60000`. |

The constructor starts the periodic cleanup timer immediately. Set `cleanupIntervalMs` to `0` to disable the timer.

#### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `set` | `set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>` | `Promise<void>` | JSON-serializes `value` and stores it under the namespaced key with an absolute expiration computed from the effective TTL. |
| `get` | `get<T>(key: string): Promise<T \| undefined>` | `Promise<T \| undefined>` | Returns the deserialized value. Expired entries are evicted lazily; a JSON parse failure is treated as a miss (`undefined`). |
| `delete` | `delete(key: string): Promise<boolean>` | `Promise<boolean>` | `true` when the entry existed and was removed. |
| `exists` | `exists(key: string): Promise<boolean>` | `Promise<boolean>` | `true` when the entry exists and has not expired; expired entries are evicted. |
| `expire` | `expire(key: string, ttlSeconds: number): Promise<boolean>` | `Promise<boolean>` | Sets a new absolute expiry. `false` for missing or already-expired entries. |
| `ttl` | `ttl(key: string): Promise<number>` | `Promise<number>` | Remaining seconds (rounded up); `-1` = no expiry; `-2` = missing or expired. |
| `deletePattern` | `deletePattern(pattern: string): Promise<number>` | `Promise<number>` | Glob matching where `*` matches any sequence; returns the number of removed entries. |
| `clear` | `clear(): Promise<void>` | `Promise<void>` | Removes every entry whose prefixed key starts with `rootKey + ':'`. |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | Always `true` while the process is running. |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Stops the cleanup timer and clears the store. |
| `getOrSet` | `getOrSet<T>(key: string, factory: () => Promise<T>, ttlSeconds?: number): Promise<T>` | `Promise<T>` | Inherited from `CacheProvider`. |

#### Protected Members

| Member | Type / Signature | Description |
|--------|------------------|-------------|
| `store` | `Map<string, MemoryCacheEntry>` | Entry store keyed by the prefixed key. |
| `cleanupInterval` | `ReturnType<typeof setInterval> \| undefined` | Handle of the periodic cleanup timer (`undefined` when disabled or stopped). |
| `cleanupIntervalMs` | `number` | Cleanup interval in milliseconds. |
| `patternToRegex(pattern)` | `(pattern: string): RegExp` | Converts a glob pattern to a regex: `*` becomes `.*`, all other regex-special characters are escaped. |
| `startCleanup()` | `(): void` | Starts the periodic cleanup timer (calls `unref()` so it never keeps the Node.js process alive). No-op when `cleanupIntervalMs <= 0`. |

#### Notes

- TTLs are stored as absolute `expiresAt` timestamps in milliseconds.
- Expired entries are removed in two ways: lazily on `get`, `exists`, `expire`, and `ttl` calls, and proactively by the cleanup timer.
- The cleanup timer is `unref()`'d — it does not prevent the Node.js process from exiting.

#### Example

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

const cache = new MemoryCacheProvider({
    rootKey: "TestApp",
    defaultTTL: 60,
    cleanupIntervalMs: 5000,
});

await cache.set("key", { data: true });
const value = await cache.get<{ data: boolean }>("key");
console.log(value?.data); // true

await cache.shutdown();
```

---

### RedisCacheProvider

Redis-backed cache provider using `ioredis`. All cache operations map directly to Redis commands for optimal performance; pattern-based deletion uses `SCAN` (never `KEYS`) to avoid blocking the Redis server.

```typescript fragment
class RedisCacheProvider extends CacheProvider {
    protected client: Redis;

    constructor(config: RedisCacheConfig);

    set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
    get<T>(key: string): Promise<T | undefined>;
    delete(key: string): Promise<boolean>;
    exists(key: string): Promise<boolean>;
    expire(key: string, ttlSeconds: number): Promise<boolean>;
    ttl(key: string): Promise<number>;
    deletePattern(pattern: string): Promise<number>;
    clear(): Promise<void>;
    health(): Promise<boolean>;
    shutdown(): Promise<void>;

    protected scanAndDelete(pattern: string): Promise<number>;
}
```

`getOrSet()` is inherited from `CacheProvider`.

#### Constructor

```typescript fragment
constructor(config: RedisCacheConfig);
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `RedisCacheConfig` | Yes | — | Redis cache configuration. `rootKey` is required; connection fields are optional. |

The `ioredis` client is created immediately and begins connecting in the background. When `config.url` is provided it takes precedence over `host`/`port`/`password`/`db`. Connection defaults: `host` `'localhost'`, `port` `6379`, `db` `0`, `connectTimeout` `5000` ms, `maxRetriesPerRequest` `3`.

#### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `set` | `set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>` | `Promise<void>` | Issues `SET key value EX ttl` when an effective TTL applies, plain `SET` otherwise. |
| `get` | `get<T>(key: string): Promise<T \| undefined>` | `Promise<T \| undefined>` | Issues `GET`; returns `undefined` for missing keys and JSON parse failures. |
| `delete` | `delete(key: string): Promise<boolean>` | `Promise<boolean>` | Issues `DEL`; `true` when the key was removed. |
| `exists` | `exists(key: string): Promise<boolean>` | `Promise<boolean>` | Issues `EXISTS`; `true` when the key exists. |
| `expire` | `expire(key: string, ttlSeconds: number): Promise<boolean>` | `Promise<boolean>` | Issues `EXPIRE`; `true` when the TTL was set. |
| `ttl` | `ttl(key: string): Promise<number>` | `Promise<number>` | Issues `TTL` — native Redis return values: remaining seconds, `-1` (no expiry), `-2` (missing). |
| `deletePattern` | `deletePattern(pattern: string): Promise<number>` | `Promise<number>` | Uses `SCAN` (with `COUNT 100`) to find matching keys and deletes them in batched `DEL` commands. Never uses `KEYS`. |
| `clear` | `clear(): Promise<void>` | `Promise<void>` | `SCAN` + `DEL` limited to the `rootKey:*` namespace. |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | Sends `PING`; `true` when the response is `PONG`, `false` on connection errors. |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Issues `QUIT` — a graceful disconnect that waits for pending commands to complete. After shutdown, `health()` returns `false`. |
| `getOrSet` | `getOrSet<T>(key: string, factory: () => Promise<T>, ttlSeconds?: number): Promise<T>` | `Promise<T>` | Inherited from `CacheProvider`. |

#### Protected Members

| Member | Type / Signature | Description |
|--------|------------------|-------------|
| `client` | `Redis` | The `ioredis` client instance (the `Redis` type comes from `ioredis`). |
| `scanAndDelete(pattern)` | `(pattern: string): Promise<number>` | Scans for keys matching the full pattern (prefix already applied) and batch-deletes them; returns the number of keys deleted. |

#### Example

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";

interface User {
    name: string;
}

const cache = new RedisCacheProvider({
    rootKey: "MyApp",
    host: "localhost",
    port: 6379,
    defaultTTL: 300,
});

await cache.set("user:123", { name: "Alice" }, 600);
const user = await cache.get<User>("user:123");
console.log(user?.name); // "Alice"

await cache.shutdown();
```

---

## Pub/Sub

### PubSubProvider (Abstract Base Class)

Abstract base class for all pub/sub implementations. Provides typed, JSON-serialized messaging with transparent channel prefix management. `MemoryPubSubProvider` and `RedisPubSubProvider` extend this class. It cannot be instantiated directly.

```typescript fragment
abstract class PubSubProvider {
    protected channelPrefix: string | undefined;
    protected _serviceName: string;

    constructor(config: PubSubProviderConfig);

    get serviceName(): string;

    protected buildChannel(channel: string): string;
    protected buildChannelPattern(pattern: string): string;
    protected stripPrefix(fullChannel: string): string;
    protected safeInvoke<T>(handler: MessageHandler<T>, message: PubSubMessage<T>): Promise<void>;

    abstract publish<T>(channel: string, data: T): Promise<number>;
    abstract subscribe<T = unknown>(channel: string, handler: MessageHandler<T>): Promise<void>;
    abstract unsubscribe(channel: string): Promise<void>;
    abstract psubscribe<T = unknown>(pattern: string, handler: MessageHandler<T>): Promise<void>;
    abstract punsubscribe(pattern: string): Promise<void>;
    abstract activeSubscriptions(): { channels: string[]; patterns: string[] };
    abstract health(): Promise<boolean>;
    abstract shutdown(): Promise<void>;
}
```

#### Constructor

```typescript fragment
constructor(config: PubSubProviderConfig);
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `PubSubProviderConfig` | Yes | — | Base configuration. `channelPrefix` is optional; `serviceName` defaults to `'pubsub'`. |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `serviceName` | `string` | Read-only getter. Service name used for WebAFX service container registration. Set from `config.serviceName`; defaults to `'pubsub'`. |

#### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `publish` | `publish<T>(channel: string, data: T): Promise<number>` | `Promise<number>` | Abstract. Publishes `data` (JSON-serialized) to `channel`; returns the number of receivers. |
| `subscribe` | `subscribe<T = unknown>(channel: string, handler: MessageHandler<T>): Promise<void>` | `Promise<void>` | Abstract. Subscribes a typed handler to an exact channel. Multiple handlers per channel are supported. |
| `unsubscribe` | `unsubscribe(channel: string): Promise<void>` | `Promise<void>` | Abstract. Unsubscribes the channel and removes all of its handlers. |
| `psubscribe` | `psubscribe<T = unknown>(pattern: string, handler: MessageHandler<T>): Promise<void>` | `Promise<void>` | Abstract. Subscribes a handler to a glob channel pattern (e.g., `'order:*'`). |
| `punsubscribe` | `punsubscribe(pattern: string): Promise<void>` | `Promise<void>` | Abstract. Unsubscribes the pattern and removes all of its handlers. |
| `activeSubscriptions` | `activeSubscriptions(): { channels: string[]; patterns: string[] }` | `{ channels: string[]; patterns: string[] }` | Abstract (synchronous). Lists active subscriptions with user-facing (un-prefixed) names. |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | Abstract. Returns `true` if the backend is operational. |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Abstract. Unsubscribes everything and releases connections/resources. |

#### Protected Members

Available to subclasses implementing a custom backend.

| Member | Type / Signature | Description |
|--------|------------------|-------------|
| `channelPrefix` | `string \| undefined` | Channel prefix for namespace isolation (`undefined` when not configured). |
| `_serviceName` | `string` | Backing field for the `serviceName` getter. |
| `buildChannel(channel)` | `(channel: string): string` | Prefixes a channel name (`prefix + ':' + channel`); returns the channel unchanged when no prefix is configured. |
| `buildChannelPattern(pattern)` | `(pattern: string): string` | Prefixes a glob pattern the same way. |
| `stripPrefix(fullChannel)` | `(fullChannel: string): string` | Removes the configured prefix from a full channel name so handlers see the original name. |
| `safeInvoke(handler, message)` | `(handler: MessageHandler<T>, message: PubSubMessage<T>): Promise<void>` | Invokes a handler inside a try/catch; errors are logged to `console.error` (`` [PubSub] Handler error on channel "..." ``) and never propagated. |

#### Example

`PubSubProvider` is abstract — use it through a concrete backend. A custom backend extends this class and implements the abstract methods; the protected helpers and `safeInvoke()` are inherited.

```typescript
import { MemoryPubSubProvider, type PubSubProvider } from "blendsdk/webafx-cache";

interface OrderEvent {
    orderId: number;
    total: number;
}

const pubsub: PubSubProvider = new MemoryPubSubProvider({ channelPrefix: "MyApp" });

await pubsub.subscribe<OrderEvent>("order:new", (message) => {
    console.log("New order:", message.data.orderId); // New order: 123
});

await pubsub.publish("order:new", { orderId: 123, total: 49.99 });

await pubsub.shutdown();
```

---

### MemoryPubSubProvider

In-process pub/sub backend for development and testing. Delivers messages synchronously within the same event loop tick using in-process handler maps. No network connections and no external dependencies.

```typescript fragment
class MemoryPubSubProvider extends PubSubProvider {
    protected handlers: Map<string, Set<MessageHandler>>;
    protected patternHandlers: Map<string, Set<MessageHandler>>;

    constructor(config?: MemoryPubSubConfig);

    publish<T>(channel: string, data: T): Promise<number>;
    subscribe<T = unknown>(channel: string, handler: MessageHandler<T>): Promise<void>;
    unsubscribe(channel: string): Promise<void>;
    psubscribe<T = unknown>(pattern: string, handler: MessageHandler<T>): Promise<void>;
    punsubscribe(pattern: string): Promise<void>;
    activeSubscriptions(): { channels: string[]; patterns: string[] };
    health(): Promise<boolean>;
    shutdown(): Promise<void>;

    protected matchGlob(channel: string, pattern: string): boolean;
}
```

#### Constructor

```typescript fragment
constructor(config?: MemoryPubSubConfig);
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `MemoryPubSubConfig` | No | `{}` | Optional configuration with `channelPrefix` and `serviceName`. |

#### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `publish` | `publish<T>(channel: string, data: T): Promise<number>` | `Promise<number>` | Performs a JSON round-trip of `data` (handlers receive a deserialized copy with no shared reference to the published object; throws if `data` is not JSON-serializable) and delivers to all exact-channel and matching pattern handlers. Returns the number of handlers invoked. |
| `subscribe` | `subscribe<T = unknown>(channel: string, handler: MessageHandler<T>): Promise<void>` | `Promise<void>` | Registers a handler for an exact channel. Duplicate handler references are deduplicated (backed by a `Set`). |
| `unsubscribe` | `unsubscribe(channel: string): Promise<void>` | `Promise<void>` | Removes all handlers for the channel. Does not error when the channel is not subscribed. |
| `psubscribe` | `psubscribe<T = unknown>(pattern: string, handler: MessageHandler<T>): Promise<void>` | `Promise<void>` | Registers a pattern handler. Glob supports `*` (any sequence) and `?` (exactly one character). |
| `punsubscribe` | `punsubscribe(pattern: string): Promise<void>` | `Promise<void>` | Removes all handlers for the pattern. |
| `activeSubscriptions` | `activeSubscriptions(): { channels: string[]; patterns: string[] }` | `{ channels: string[]; patterns: string[] }` | Synchronous. Returns user-facing (un-prefixed) channel and pattern names. |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | Always `true` — there are no external connections to verify. |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Clears all channel and pattern handlers. |

#### Protected Members

| Member | Type / Signature | Description |
|--------|------------------|-------------|
| `handlers` | `Map<string, Set<MessageHandler>>` | Exact-channel handlers keyed by user-facing channel name. |
| `patternHandlers` | `Map<string, Set<MessageHandler>>` | Pattern handlers keyed by user-facing pattern. |
| `matchGlob(channel, pattern)` | `(channel: string, pattern: string): boolean` | Converts glob syntax to a regex (`*` → `.*`, `?` → `.`; all other regex-special characters escaped) and tests the channel against it. |

#### Notes

- Delivery is in-process and synchronous within the same event loop tick; async handlers run without blocking the publisher.
- Messages delivered via a pattern subscription include the `pattern` field in the envelope.
- Handler errors are isolated by the inherited `safeInvoke()` — logged and never propagated.

#### Example

```typescript
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";

const pubsub = new MemoryPubSubProvider({ channelPrefix: "Test" });

await pubsub.subscribe<string>("greet", (message) => {
    console.log(message.data); // "Hello!"
});
await pubsub.publish("greet", "Hello!");

await pubsub.shutdown();
```

---

### RedisPubSubProvider

Redis-backed pub/sub provider using `ioredis`. Creates **two** dedicated connections: a `publisher` for `PUBLISH` commands and a `subscriber` for `SUBSCRIBE`/`PSUBSCRIBE`. Redis requires a dedicated connection once a client enters subscriber mode — a subscriber connection cannot execute regular commands.

Handler maps are keyed by user-facing (un-prefixed) channel names. Multiple in-process handlers for the same channel share a single Redis subscription: `SUBSCRIBE` is only sent on the first handler registration, and `UNSUBSCRIBE` on removal.

```typescript fragment
class RedisPubSubProvider extends PubSubProvider {
    protected publisher: Redis;
    protected subscriber: Redis;
    protected handlers: Map<string, Set<MessageHandler>>;
    protected patternHandlers: Map<string, Set<MessageHandler>>;

    constructor(config: RedisPubSubConfig);

    publish<T>(channel: string, data: T): Promise<number>;
    subscribe<T = unknown>(channel: string, handler: MessageHandler<T>): Promise<void>;
    unsubscribe(channel: string): Promise<void>;
    psubscribe<T = unknown>(pattern: string, handler: MessageHandler<T>): Promise<void>;
    punsubscribe(pattern: string): Promise<void>;
    activeSubscriptions(): { channels: string[]; patterns: string[] };
    health(): Promise<boolean>;
    shutdown(): Promise<void>;

    protected createRedisClient(config: RedisPubSubConfig): Redis;
    protected setupMessageHandlers(): void;
}
```

#### Constructor

```typescript fragment
constructor(config: RedisPubSubConfig);
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `RedisPubSubConfig` | Yes | — | Redis pub/sub configuration. Connection fields are optional; `channelPrefix` and `serviceName` are optional. |

Two `ioredis` connections are created immediately and begin connecting in the background. When `config.url` is provided it takes precedence over `host`/`port`/`password`/`db`. Connection defaults: `host` `'localhost'`, `port` `6379`, `db` `0`, `connectTimeout` `5000` ms, `maxRetriesPerRequest` `3`.

#### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `publish` | `publish<T>(channel: string, data: T): Promise<number>` | `Promise<number>` | JSON-serializes `data` and issues `PUBLISH` on the publisher connection. Returns the number of Redis subscribers that received the message (as reported by Redis). |
| `subscribe` | `subscribe<T = unknown>(channel: string, handler: MessageHandler<T>): Promise<void>` | `Promise<void>` | Adds the handler to the local per-channel set; issues `SUBSCRIBE` only for the first handler of a channel. All in-process handlers receive the message via fan-out. |
| `unsubscribe` | `unsubscribe(channel: string): Promise<void>` | `Promise<void>` | Issues `UNSUBSCRIBE` for the prefixed channel and removes all local handlers for it. |
| `psubscribe` | `psubscribe<T = unknown>(pattern: string, handler: MessageHandler<T>): Promise<void>` | `Promise<void>` | Adds the pattern handler; issues `PSUBSCRIBE` only for the first handler of a pattern. |
| `punsubscribe` | `punsubscribe(pattern: string): Promise<void>` | `Promise<void>` | Issues `PUNSUBSCRIBE` and removes all local handlers for the pattern. |
| `activeSubscriptions` | `activeSubscriptions(): { channels: string[]; patterns: string[] }` | `{ channels: string[]; patterns: string[] }` | Synchronous. Returns user-facing (un-prefixed) channel and pattern names. |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | Pings both connections with `PING`; `true` only when both reply `PONG`. |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Unsubscribes all channels and patterns, clears the handler maps, then issues `quit()` on both connections (graceful — waits for pending commands). |

#### Protected Members

| Member | Type / Signature | Description |
|--------|------------------|-------------|
| `publisher` | `Redis` | Dedicated connection for `PUBLISH` commands. |
| `subscriber` | `Redis` | Dedicated connection for `SUBSCRIBE`/`PSUBSCRIBE` (enters subscriber mode). |
| `handlers` | `Map<string, Set<MessageHandler>>` | Exact-channel handlers keyed by user-facing channel name. |
| `patternHandlers` | `Map<string, Set<MessageHandler>>` | Pattern handlers keyed by user-facing pattern. |
| `createRedisClient(config)` | `(config: RedisPubSubConfig): Redis` | Creates an `ioredis` client from the config (`url` takes precedence over individual fields). Called once per connection. |
| `setupMessageHandlers()` | `(): void` | Wires the `message` and `pmessage` listeners on the subscriber connection: strips the channel prefix, JSON-parses the payload (parse failures are logged and dropped), and fans out to all registered handlers via `safeInvoke()`. |

#### Example

```typescript
import { RedisPubSubProvider } from "blendsdk/webafx-cache";

interface OrderEvent {
    orderId: number;
    total: number;
}

const pubsub = new RedisPubSubProvider({
    channelPrefix: "MyApp",
    host: "localhost",
    port: 6379,
});

await pubsub.subscribe<OrderEvent>("order:new", (message) => {
    console.log("New order:", message.data.orderId);
});

await pubsub.publish("order:new", { orderId: 123, total: 49.99 });

await pubsub.shutdown();
```

---

## Configuration Types — Cache

### RedisConnectionConfig

Shared Redis connection configuration used by both `RedisCacheProvider` and `RedisPubSubProvider`.

| Property | Type | Description |
|----------|------|-------------|
| `host` | `string` | Optional. Redis host. Default: `'localhost'`. |
| `port` | `number` | Optional. Redis port. Default: `6379`. |
| `password` | `string` | Optional. Redis password. |
| `db` | `number` | Optional. Redis database index (`0`–`15`). Default: `0`. |
| `url` | `string` | Optional. Redis connection URL (e.g., `redis://localhost:6379`). When provided, takes precedence over `host`, `port`, `password`, and `db`. |
| `connectTimeout` | `number` | Optional. Connection timeout in milliseconds. Default: `5000`. |
| `maxRetriesPerRequest` | `number` | Optional. Maximum retries per request (`ioredis` `maxRetriesPerRequest`). Default: `3`. |

### CacheProviderConfig

Base configuration shared by all cache providers. Every cache provider requires at minimum a `rootKey` for namespace isolation.

| Property | Type | Description |
|----------|------|-------------|
| `rootKey` | `string` | Required. Root key prefix for all cache keys (e.g., `'MyApp'`). Must be a non-empty, non-whitespace string — the constructor throws otherwise. |
| `serviceName` | `string` | Optional. Service name for WebAFX service container registration. Use different names for multi-cache scenarios. Default: `'cache'`. |
| `defaultTTL` | `number` | Optional. Default TTL in seconds. `0` means no expiry. Default: `0`. |

### RedisCacheConfig

Redis-specific cache configuration. Extends `CacheProviderConfig` and `RedisConnectionConfig` with no additional members.

| Property | Type | Description |
|----------|------|-------------|
| `rootKey` | `string` | Required. Root key prefix for all cache keys. |
| `serviceName` | `string` | Optional. WebAFX service name. Default: `'cache'`. |
| `defaultTTL` | `number` | Optional. Default TTL in seconds (`0` = no expiry). Default: `0`. |
| `host` | `string` | Optional. Redis host. Default: `'localhost'`. |
| `port` | `number` | Optional. Redis port. Default: `6379`. |
| `password` | `string` | Optional. Redis password. |
| `db` | `number` | Optional. Redis database index. Default: `0`. |
| `url` | `string` | Optional. Redis connection URL — takes precedence over `host`/`port`/`password`/`db`. |
| `connectTimeout` | `number` | Optional. Connection timeout in ms. Default: `5000`. |
| `maxRetriesPerRequest` | `number` | Optional. Maximum retries per request. Default: `3`. |

### MemoryCacheConfig

In-memory specific cache configuration. Extends `CacheProviderConfig` with memory management options.

| Property | Type | Description |
|----------|------|-------------|
| `rootKey` | `string` | Required. Root key prefix for all cache keys. |
| `serviceName` | `string` | Optional. WebAFX service name. Default: `'cache'`. |
| `defaultTTL` | `number` | Optional. Default TTL in seconds (`0` = no expiry). Default: `0`. |
| `cleanupIntervalMs` | `number` | Optional. Interval in milliseconds for the periodic cleanup of expired entries. `0` or negative disables cleanup. Default: `60000` (1 minute). |

### CacheFactoryConfig

Configuration for the `createCache()` environment-based factory. The `type` field determines which backend is created; Redis-specific fields are only used when `type === 'redis'`, memory-specific fields only when `type === 'memory'`.

| Property | Type | Description |
|----------|------|-------------|
| `type` | `"redis" \| "memory"` | Required. Cache backend type discriminator. |
| `rootKey` | `string` | Required. Root key prefix for all cache keys. |
| `serviceName` | `string` | Optional. Service name for the WebAFX service container. Default: `'cache'`. |
| `defaultTTL` | `number` | Optional. Default TTL in seconds. Default: `0`. |
| `host` | `string` | Optional. Redis host (used when `type === 'redis'`). |
| `port` | `number` | Optional. Redis port (used when `type === 'redis'`). |
| `password` | `string` | Optional. Redis password (used when `type === 'redis'`). |
| `db` | `number` | Optional. Redis database index (used when `type === 'redis'`). |
| `url` | `string` | Optional. Redis connection URL (used when `type === 'redis'`). |
| `cleanupIntervalMs` | `number` | Optional. Memory cleanup interval in ms (used when `type === 'memory'`). |

> **Note:** `CacheFactoryConfig` does not include `connectTimeout` or `maxRetriesPerRequest` — `createCache()` forwards only the fields above, so the provider defaults (`5000` ms and `3`) apply. Construct `RedisCacheProvider` directly to customize those options.

---

## Configuration Types — Pub/Sub

### PubSubProviderConfig

Base configuration shared by all pub/sub providers. The `channelPrefix` provides namespace isolation — all channels are automatically prefixed so multiple applications can share the same Redis instance without channel name collisions.

| Property | Type | Description |
|----------|------|-------------|
| `channelPrefix` | `string` | Optional. Prefix applied to every channel and pattern. Example: with `prefix = 'MyApp'`, channel `order:new` becomes `MyApp:order:new`. Handlers always see un-prefixed names. |
| `serviceName` | `string` | Optional. Service name for WebAFX service container registration. Use different names for multi-pubsub scenarios. Default: `'pubsub'`. |

### RedisPubSubConfig

Redis-specific pub/sub configuration. Extends `PubSubProviderConfig` and `RedisConnectionConfig` with no additional members. The provider creates two `ioredis` connections internally — one for publishing, one for subscribing.

| Property | Type | Description |
|----------|------|-------------|
| `channelPrefix` | `string` | Optional. Channel prefix for namespace isolation. |
| `serviceName` | `string` | Optional. WebAFX service name. Default: `'pubsub'`. |
| `host` | `string` | Optional. Redis host. Default: `'localhost'`. |
| `port` | `number` | Optional. Redis port. Default: `6379`. |
| `password` | `string` | Optional. Redis password. |
| `db` | `number` | Optional. Redis database index. Default: `0`. |
| `url` | `string` | Optional. Redis connection URL — takes precedence over `host`/`port`/`password`/`db`. |
| `connectTimeout` | `number` | Optional. Connection timeout in ms. Default: `5000`. |
| `maxRetriesPerRequest` | `number` | Optional. Maximum retries per request. Default: `3`. |

### MemoryPubSubConfig

In-memory specific pub/sub configuration. Extends `PubSubProviderConfig` with no additional fields.

| Property | Type | Description |
|----------|------|-------------|
| `channelPrefix` | `string` | Optional. Channel prefix for namespace isolation. |
| `serviceName` | `string` | Optional. WebAFX service name. Default: `'pubsub'`. |

### PubSubFactoryConfig

Configuration for the `createPubSub()` environment-based factory. The `type` field determines which backend is created; Redis-specific fields are only used when `type === 'redis'`.

| Property | Type | Description |
|----------|------|-------------|
| `type` | `"redis" \| "memory"` | Required. Pub/sub backend type discriminator. |
| `channelPrefix` | `string` | Optional. Channel prefix for namespace isolation. |
| `serviceName` | `string` | Optional. Service name for the WebAFX service container. Default: `'pubsub'`. |
| `host` | `string` | Optional. Redis host (used when `type === 'redis'`). |
| `port` | `number` | Optional. Redis port (used when `type === 'redis'`). |
| `password` | `string` | Optional. Redis password (used when `type === 'redis'`). |
| `db` | `number` | Optional. Redis database index (used when `type === 'redis'`). |
| `url` | `string` | Optional. Redis connection URL (used when `type === 'redis'`). |

> **Note:** `PubSubFactoryConfig` does not include `connectTimeout` or `maxRetriesPerRequest`. Construct `RedisPubSubProvider` directly to customize those options.

---

## Message Types

### PubSubMessage<T>

Message envelope delivered to subscription handlers. Contains the deserialized payload and metadata about the channel and (for pattern subscriptions) the pattern that matched. The `channel` and `pattern` fields always contain user-facing names (prefix stripped), never the internal prefixed names.

**Type parameter:** `T` — the payload type. Default: `unknown`.

```typescript fragment
interface PubSubMessage<T = unknown> {
    channel: string;
    data: T;
    pattern?: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `channel` | `string` | The channel the message was published to, with the prefix stripped (user-facing name). |
| `data` | `T` | The deserialized message payload. |
| `pattern` | `string \| undefined` | Optional. Set only for pattern subscriptions — the glob pattern that matched, with the prefix stripped. `undefined` for exact-channel deliveries. |

### MessageHandler<T>

Handler function for pub/sub messages. Can be synchronous or asynchronous. Errors thrown by handlers are caught and logged by `safeInvoke()` — they do not break other subscribers or crash the subscriber connection.

**Type parameter:** `T` — the payload type. Default: `unknown`.

```typescript fragment
type MessageHandler<T = unknown> = (message: PubSubMessage<T>) => void | Promise<void>;
```

```typescript
import { MemoryPubSubProvider, type MessageHandler, type PubSubMessage } from "blendsdk/webafx-cache";

interface OrderEvent {
    orderId: number;
}

const handleOrder: MessageHandler<OrderEvent> = (message: PubSubMessage<OrderEvent>) => {
    console.log(message.data.orderId);
};

const pubsub = new MemoryPubSubProvider();
await pubsub.subscribe("order:new", handleOrder);
await pubsub.publish("order:new", { orderId: 7 });

await pubsub.shutdown();
```

### SubscriptionDefinition<T>

Subscription definition for declarative registration via plugin config. Exactly one of `channel` or `pattern` must be provided. In `createPubSubPlugin()`, entries with a `channel` are registered via `subscribe()` and entries with a `pattern` via `psubscribe()`; if both are set, `channel` takes precedence.

**Type parameter:** `T` — the payload type. Default: `unknown`.

```typescript fragment
interface SubscriptionDefinition<T = unknown> {
    channel?: string;
    pattern?: string;
    handler: MessageHandler<T>;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `channel` | `string \| undefined` | Optional. Exact channel name (mutually exclusive with `pattern`). |
| `pattern` | `string \| undefined` | Optional. Channel pattern with glob wildcards (mutually exclusive with `channel`). |
| `handler` | `MessageHandler<T>` | Required. Handler function invoked when a matching message arrives. |

---

## WebAFX Plugin Integration

The functions in this section are the only part of the package that imports `blendsdk/webafx` (an optional peer dependency). They adapt providers into WebAFX `PluginDefinition` objects passed to `app.use()`. Each plugin registers its provider as an application-wide singleton service under `provider.serviceName` and wires `health()` into `/health` and `shutdown()` into graceful shutdown.

### PubSubPluginOptions

Options for pub/sub plugin creation. Allows overriding the plugin priority and registering declarative subscriptions that are set up at plugin installation time.

| Property | Type | Description |
|----------|------|-------------|
| `priority` | `number` | Optional. Plugin installation priority. Default: `30`. |
| `subscriptions` | `SubscriptionDefinition[]` | Optional. Declarative subscriptions to register at plugin install time (via `subscribe()` / `psubscribe()`). |

### createCachePlugin()

Creates a WebAFX `PluginDefinition` from any `CacheProvider` instance. The core cache integration function:

1. Registers the provider as a singleton service in the WebAFX service container under `provider.serviceName`.
2. Hooks `provider.health()` into the `/health` endpoint.
3. Hooks `provider.shutdown()` into graceful shutdown (`dispose` also calls `shutdown()`).

```typescript fragment
function createCachePlugin(
    provider: CacheProvider,
    options?: { priority?: number }
): PluginDefinition;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `provider` | `CacheProvider` | Yes | — | Any cache provider instance — `RedisCacheProvider`, `MemoryCacheProvider`, or a custom subclass. |
| `options` | `{ priority?: number }` | No | — | Optional overrides. |
| `options.priority` | `number` | No | `30` | Plugin installation priority. `0` is a valid value. |

**Returns:** `PluginDefinition` — a WebAFX plugin definition whose `name` is `provider.serviceName`, with a `factory` that registers the service and returns `{ health, shutdown }` hooks.

```typescript
import { MemoryCacheProvider, createCachePlugin } from "blendsdk/webafx-cache";

const provider = new MemoryCacheProvider({ rootKey: "MyApp", cleanupIntervalMs: 0 });
const plugin = createCachePlugin(provider, { priority: 25 });

console.log(plugin.name);     // "cache"
console.log(plugin.priority); // 25

await provider.shutdown();
```

### redisCachePlugin()

Creates a WebAFX cache plugin with a Redis backend in one line. Internally creates a `RedisCacheProvider` from `config` and delegates to `createCachePlugin()`. The plugin name is `config.serviceName` (default `'cache'`); the priority is always the default `30` — use `createCachePlugin()` if you need a custom priority.

```typescript fragment
function redisCachePlugin(config: RedisCacheConfig): PluginDefinition;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `RedisCacheConfig` | Yes | — | Redis cache configuration (`rootKey` required; connection fields optional). |

**Returns:** `PluginDefinition` — ready to pass to `app.use()`.

```typescript
import { redisCachePlugin } from "blendsdk/webafx-cache";

const plugin = redisCachePlugin({
    rootKey: "MyApp",
    host: "localhost",
    port: 6379,
    defaultTTL: 300,
});

console.log(plugin.name);     // "cache"
console.log(plugin.priority); // 30
```

Multi-cache registration with different service names and namespaces:

```typescript fragment
app.use(redisCachePlugin({
    rootKey: "Sessions",
    host: "redis-sessions",
    serviceName: "session-cache",
}));
app.use(redisCachePlugin({
    rootKey: "Products",
    host: "redis-products",
    serviceName: "product-cache",
}));
```

### memoryCachePlugin()

Creates a WebAFX cache plugin with an in-memory backend in one line. Internally creates a `MemoryCacheProvider` from `config` and delegates to `createCachePlugin()`. Ideal for development, testing, and single-instance applications. The plugin name is `config.serviceName` (default `'cache'`); the priority is always the default `30`.

```typescript fragment
function memoryCachePlugin(config: MemoryCacheConfig): PluginDefinition;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `MemoryCacheConfig` | Yes | — | Memory cache configuration (`rootKey` required). |

**Returns:** `PluginDefinition` — ready to pass to `app.use()`.

```typescript
import { memoryCachePlugin } from "blendsdk/webafx-cache";

const plugin = memoryCachePlugin({
    rootKey: "MyApp",
    defaultTTL: 60,
});

console.log(plugin.name);     // "cache"
console.log(plugin.priority); // 30
```

### createCache()

Creates a `CacheProvider` based on a configuration type — the factory for environment-based backend switching. Use with `createCachePlugin()` to register the result in WebAFX.

```typescript fragment
function createCache(config: CacheFactoryConfig): CacheProvider;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `CacheFactoryConfig` | Yes | — | Cache factory configuration with a `type` discriminator. |

**Returns:** `CacheProvider` — a `RedisCacheProvider` when `type === 'redis'`, or a `MemoryCacheProvider` when `type === 'memory'`.

**Throws:** `Error` with the message `Unknown cache type: "<type>". Supported types: "redis", "memory".` when `config.type` is neither `'redis'` nor `'memory'`.

Behavior:

- `type: 'redis'` → forwards `rootKey`, `serviceName`, `defaultTTL`, `host`, `port`, `password`, `db`, and `url` to `RedisCacheProvider`.
- `type: 'memory'` → forwards `rootKey`, `serviceName`, `defaultTTL`, and `cleanupIntervalMs` to `MemoryCacheProvider`.

Environment-based switching:

```typescript fragment
const cache = createCache({
    type: process.env.NODE_ENV === "production" ? "redis" : "memory",
    rootKey: "MyApp",
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
});
```

```typescript
import { createCache } from "blendsdk/webafx-cache";

interface CachedValue {
    value: number;
}

const cache = createCache({
    type: "memory",
    rootKey: "MyApp",
    defaultTTL: 120,
});

await cache.set<CachedValue>("key", { value: 42 });
const cached = await cache.get<CachedValue>("key");
console.log(cached?.value); // 42

await cache.shutdown();
```

### createPubSubPlugin()

Creates a WebAFX `PluginDefinition` from any `PubSubProvider` instance:

1. Registers the provider as a singleton service under `provider.serviceName`.
2. Registers any declarative subscriptions from `options.subscriptions` (using `subscribe()` for `channel` entries and `psubscribe()` for `pattern` entries).
3. Hooks `provider.health()` into the `/health` endpoint.
4. Hooks `provider.shutdown()` into graceful shutdown (`dispose` also calls `shutdown()`).

```typescript fragment
function createPubSubPlugin(
    provider: PubSubProvider,
    options?: PubSubPluginOptions
): PluginDefinition;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `provider` | `PubSubProvider` | Yes | — | Any pub/sub provider instance — `RedisPubSubProvider`, `MemoryPubSubProvider`, or a custom subclass. |
| `options` | `PubSubPluginOptions` | No | — | Optional plugin options. |
| `options.priority` | `number` | No | `30` | Plugin installation priority. `0` is a valid value. |
| `options.subscriptions` | `SubscriptionDefinition[]` | No | — | Declarative subscriptions registered during plugin installation. |

**Returns:** `PluginDefinition` — a WebAFX plugin definition whose `name` is `provider.serviceName`, with a `factory` that registers the service, subscribes any declarative handlers, and returns `{ health, shutdown }` hooks.

```typescript
import { MemoryPubSubProvider, createPubSubPlugin } from "blendsdk/webafx-cache";

const provider = new MemoryPubSubProvider({ channelPrefix: "MyApp" });

const plugin = createPubSubPlugin(provider, {
    subscriptions: [
        {
            channel: "order:created",
            handler: (message) => {
                console.log("Order created:", message.data);
            },
        },
        {
            pattern: "audit:*",
            handler: (message) => {
                console.log("Audit event:", message.pattern, message.channel);
            },
        },
    ],
});

console.log(plugin.name); // "pubsub"

await provider.shutdown();
```

### redisPubSubPlugin()

Creates a WebAFX pub/sub plugin with a Redis backend in one line. Internally creates a `RedisPubSubProvider` from `config` and delegates to `createPubSubPlugin()` with `options`.

```typescript fragment
function redisPubSubPlugin(
    config: RedisPubSubConfig,
    options?: PubSubPluginOptions
): PluginDefinition;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `RedisPubSubConfig` | Yes | — | Redis pub/sub configuration (`host`, `port`, `channelPrefix`, etc.). |
| `options` | `PubSubPluginOptions` | No | — | Optional plugin options (priority, declarative subscriptions). |

**Returns:** `PluginDefinition` — ready to pass to `app.use()`.

```typescript
import { redisPubSubPlugin } from "blendsdk/webafx-cache";

const plugin = redisPubSubPlugin(
    {
        host: "localhost",
        port: 6379,
        channelPrefix: "MyApp",
    },
    {
        subscriptions: [
            {
                channel: "order:created",
                handler: (message) => {
                    console.log("Order created:", message.data);
                },
            },
            {
                pattern: "audit:*",
                handler: (message) => {
                    console.log("Audit event:", message.channel);
                },
            },
        ],
    }
);

console.log(plugin.name); // "pubsub"
```

### memoryPubSubPlugin()

Creates a WebAFX pub/sub plugin with an in-memory backend in one line. Both parameters are optional — `memoryPubSubPlugin()` with no arguments registers a default in-memory provider named `'pubsub'`. Ideal for development, testing, and single-instance applications.

```typescript fragment
function memoryPubSubPlugin(
    config?: MemoryPubSubConfig,
    options?: PubSubPluginOptions
): PluginDefinition;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `MemoryPubSubConfig` | No | `{}` | Optional memory pub/sub configuration (`channelPrefix`, `serviceName`). |
| `options` | `PubSubPluginOptions` | No | — | Optional plugin options (priority, declarative subscriptions). |

**Returns:** `PluginDefinition` — ready to pass to `app.use()`.

```typescript
import { memoryPubSubPlugin } from "blendsdk/webafx-cache";

const plugin = memoryPubSubPlugin();
console.log(plugin.name);     // "pubsub"
console.log(plugin.priority); // 30
```

### createPubSub()

Creates a `PubSubProvider` based on a configuration type — the factory for environment-based backend switching. Use with `createPubSubPlugin()` to register the result in WebAFX.

```typescript fragment
function createPubSub(config: PubSubFactoryConfig): PubSubProvider;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `PubSubFactoryConfig` | Yes | — | Pub/sub factory configuration with a `type` discriminator. |

**Returns:** `PubSubProvider` — a `RedisPubSubProvider` when `type === 'redis'`, or a `MemoryPubSubProvider` when `type === 'memory'`.

**Throws:** `Error` with the message `Unknown pub/sub type: "<type>". Supported types: "redis", "memory".` when `config.type` is neither `'redis'` nor `'memory'`.

Behavior:

- `type: 'redis'` → forwards `channelPrefix`, `serviceName`, `host`, `port`, `password`, `db`, and `url` to `RedisPubSubProvider`.
- `type: 'memory'` → forwards `channelPrefix` and `serviceName` to `MemoryPubSubProvider`.

```typescript
import { createPubSub } from "blendsdk/webafx-cache";

const pubsub = createPubSub({
    type: "memory",
    channelPrefix: "MyApp",
});

await pubsub.subscribe<string>("greet", (message) => {
    console.log(message.data); // "hello"
});
await pubsub.publish("greet", "hello");

await pubsub.shutdown();
```

---

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_SERVICE_NAME` | `"cache"` | Default cache `serviceName` when not specified in config. Applied by the `CacheProvider` constructor. |
| `DEFAULT_TTL` | `0` | Default TTL in seconds when `defaultTTL` is not specified (`0` = no expiry). Applied by the `CacheProvider` constructor. |
| `KEY_SEPARATOR` | `":"` | Separator placed between `rootKey` and the user-provided key when building storage keys. |
| `DEFAULT_PUBSUB_SERVICE_NAME` | `"pubsub"` | Default pub/sub `serviceName` when not specified in config. Applied by the `PubSubProvider` constructor. |
| `CHANNEL_SEPARATOR` | `":"` | Separator placed between `channelPrefix` and the channel name/pattern when building full channel names. |

```typescript
import {
    DEFAULT_SERVICE_NAME,
    DEFAULT_TTL,
    KEY_SEPARATOR,
    DEFAULT_PUBSUB_SERVICE_NAME,
    CHANNEL_SEPARATOR,
} from "blendsdk/webafx-cache";

console.log(DEFAULT_SERVICE_NAME);        // "cache"
console.log(DEFAULT_TTL);                 // 0
console.log(KEY_SEPARATOR);               // ":"
console.log(DEFAULT_PUBSUB_SERVICE_NAME); // "pubsub"
console.log(CHANNEL_SEPARATOR);           // ":"
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
