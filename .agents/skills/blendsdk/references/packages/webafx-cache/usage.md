> **Package**: `blendsdk/webafx-cache`

# webafx-cache Core Concepts

This document is a deep dive into every major concept of `blendsdk/webafx-cache`: the two parallel abstraction hierarchies (`CacheProvider` and `PubSubProvider`), their Redis and in-memory implementations, the typed message model, the configuration surface, and the WebAFX plugin integration. Each concept follows the same structure — **What It Is**, **How It Works**, a complete runnable example, and a key methods/properties table. If you are new to the package, read the Overview and Basic Usage first, then return here for the internals.

## Concepts at a Glance

| Concept | Role |
|---------|------|
| `CacheProvider` | Abstract cache contract — key namespacing, TTL resolution, uniform async API |
| `getOrSet()` | Built-in cache-aside pattern (concrete method implemented once on `CacheProvider`) |
| `MemoryCacheProvider` | Zero-dependency, in-process cache backend |
| `RedisCacheProvider` | Production Redis cache backend (`ioredis`, SCAN-based invalidation) |
| `PubSubProvider` | Abstract messaging contract — channel prefixing, per-handler error isolation |
| Typed messages | `PubSubMessage<T>`, `MessageHandler<T>`, `SubscriptionDefinition<T>` |
| `MemoryPubSubProvider` | In-process pub/sub backend with glob matching and JSON round-trips |
| `RedisPubSubProvider` | Production Redis pub/sub backend (dedicated publisher + subscriber connections) |
| Configuration types & constants | Per-backend config interfaces, factory configs, exported defaults |
| Plugin builders | `createCachePlugin()`, `createPubSubPlugin()` — adapt any provider to WebAFX |
| Convenience factories | `redisCachePlugin()`, `memoryCachePlugin()`, `redisPubSubPlugin()`, `memoryPubSubPlugin()`, `createCache()`, `createPubSub()` |
| `/memory` subpath | Redis-free entry point that never loads `ioredis` |

---

## CacheProvider: The Abstract Cache Contract

### What It Is

`CacheProvider` is the abstract base class that every cache backend in the package derives from — `MemoryCacheProvider` and `RedisCacheProvider` both extend it — and the type application code should program against. It defines a fully asynchronous, Redis-like key/value API (`set`, `get`, `delete`, `exists`, `expire`, `ttl`, `deletePattern`, `clear`, `health`, `shutdown`), transparently namespaces every key under a configured `rootKey`, and implements the cache-aside helper `getOrSet()` exactly once for all backends.

### How It Works

- **Construction and defaults.** The base constructor requires a non-empty `rootKey` and throws `CacheProvider: rootKey is required and cannot be empty` when it is missing or whitespace-only. `serviceName` defaults to `DEFAULT_SERVICE_NAME` (`'cache'`), and `defaultTTL` defaults to `DEFAULT_TTL` (`0`, meaning no expiry).
- **Key namespacing.** The protected helper `buildKey(key)` returns `` `${rootKey}:${key}` `` (using `KEY_SEPARATOR`); `buildPattern(pattern)` does the same for invalidation patterns. Both are applied inside every operation, so consuming code always works with plain keys. Two providers with different `rootKey` values can never collide even on a shared Redis instance — `rootKey: 'MyApp'` plus `user:123` physically stores under `MyApp:user:123`.
- **TTL resolution.** The protected helper `resolveTTL(ttlSeconds)` picks the per-call TTL when provided, otherwise the provider's `defaultTTL`, and converts any value `<= 0` into `undefined` (no expiry). Consequences: a per-call TTL always beats `defaultTTL`, and passing `0` opts a single entry out of expiry even when a `defaultTTL` is configured.
- **Uniform async contract.** Every abstract method returns a `Promise` on every backend. Implementations serialize values with `JSON.stringify` on write and parse them on read, so consumers never receive references into the store. `ttl()` follows Redis conventions: positive = remaining seconds, `-1` = exists without expiry, `-2` = missing key.
- **Shared logic in the base class.** `getOrSet()` is implemented once in the base class (covered in the next section), so every backend behaves identically for the cache-aside pattern. Backends only supply storage mechanics — contract parity is enforced by shared contract test suites that run against both backends (see Testing Strategy).

### Complete Example

Program against the abstraction: a function that accepts any `CacheProvider` works unchanged with the memory backend today and with Redis in production.

```typescript
import { CacheProvider, MemoryCacheProvider } from 'blendsdk/webafx-cache';

interface SearchStats {
    term: string;
    hits: number;
}

/**
 * Works with ANY CacheProvider — the abstract contract is the only dependency.
 * The per-call TTL of 120s overrides the provider's defaultTTL of 300s.
 */
async function recordSearch(cache: CacheProvider, term: string): Promise<number> {
    const key = `stats:${term}`;
    const stats = await cache.getOrSet<SearchStats>(key, async () => ({ term, hits: 0 }), 120);
    stats.hits += 1;
    await cache.set(key, stats, 120);
    return stats.hits;
}

const analytics = new MemoryCacheProvider({ rootKey: 'Analytics', defaultTTL: 300 });

console.log(await recordSearch(analytics, 'typescript')); // 1
console.log(await recordSearch(analytics, 'typescript')); // 2
console.log(await analytics.ttl('stats:typescript')); // ~120 — per-call TTL wins

// Same logical keys, fully isolated namespaces:
const reports = new MemoryCacheProvider({ rootKey: 'Reports', defaultTTL: 300 });
await reports.set('stats:typescript', { term: 'typescript', hits: 99 });
console.log(await analytics.get<SearchStats>('stats:typescript')); // { term: 'typescript', hits: 2 }
console.log(await reports.get<SearchStats>('stats:typescript')); // { term: 'typescript', hits: 99 }

await analytics.shutdown();
await reports.shutdown();
```

### Key Methods & Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `constructor` | `(config: CacheProviderConfig)` | Validates `rootKey` (non-empty after trim); applies `serviceName` and `defaultTTL` defaults. |
| `serviceName` | `string` (getter) | Name used for WebAFX service registration; defaults to `'cache'`. |
| `set` | `set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>` | Abstract. JSON-serializes `value` under the prefixed key with the effective TTL. |
| `get` | `get<T>(key: string): Promise<T \| undefined>` | Abstract. Deserialized value, or `undefined` on miss/expiry/parse failure. |
| `delete` | `delete(key: string): Promise<boolean>` | Abstract. Resolves `true` when a key was removed. |
| `exists` | `exists(key: string): Promise<boolean>` | Abstract. `true` when the key exists and is not expired. |
| `expire` | `expire(key: string, ttlSeconds: number): Promise<boolean>` | Abstract. Resets the TTL without touching the value; `false` if the key is missing. |
| `ttl` | `ttl(key: string): Promise<number>` | Abstract. Remaining seconds, `-1` (no expiry), or `-2` (missing). |
| `deletePattern` | `deletePattern(pattern: string): Promise<number>` | Abstract. Wildcard (`*`) deletion within the namespace; resolves to the deleted count. |
| `clear` | `clear(): Promise<void>` | Abstract. Deletes every key under `rootKey` only. |
| `health` | `health(): Promise<boolean>` | Abstract. `true` when the backend is operational. |
| `shutdown` | `shutdown(): Promise<void>` | Abstract. Graceful resource release. |
| `getOrSet` | `getOrSet<T>(key: string, factory: () => Promise<T>, ttlSeconds?: number): Promise<T>` | Concrete (inherited by all backends). Cache-aside helper — see the next section. |

Protected members available to subclasses:

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `rootKey` | `string` | Namespace prefix applied to every key and pattern. |
| `defaultTTL` | `number` | Fallback TTL in seconds (`0` = no expiry). |
| `buildKey` | `(key: string) => string` | Returns `rootKey` + `KEY_SEPARATOR` + `key`. |
| `buildPattern` | `(pattern: string) => string` | Same prefixing for wildcard patterns. |
| `resolveTTL` | `(ttlSeconds?: number) => number \| undefined` | Per-call TTL ?? `defaultTTL`; `<= 0` becomes `undefined`. |

---

## Cache-Aside Caching with getOrSet()

### What It Is

`getOrSet()` is the cache-aside (read-through-with-populate) pattern built directly into `CacheProvider`: try the cache first; on a hit return the cached value; on a miss invoke your async factory, store its result with the requested TTL, and return it. Because the implementation lives once in the abstract base class, the semantics are identical on every backend.

### How It Works

1. `await this.get<T>(key)` is attempted first. If the result is anything other than `undefined`, it is returned and the factory is never invoked.
2. On `undefined` — a genuine miss or an expired entry — the `factory` function is awaited.
3. The produced value is passed to `set(key, value, ttlSeconds)`, where the normal TTL resolution applies: per-call TTL, then `defaultTTL`, then no expiry.
4. The value is returned to the caller.

Important semantics:

| Situation | Behavior |
|-----------|----------|
| Cache hit | Cached value returned; factory skipped. |
| Cache miss | Factory runs; its result is stored with the effective TTL and returned. |
| Factory rejects | The error propagates to the caller; nothing is written. |
| Stored `null` | Counts as a hit — only `undefined` signals a miss. |
| Factory resolves `undefined` | Not a cacheable value — a later read cannot observe it as a hit. |
| Concurrent misses | No stampede protection: each caller may run the factory; the last write wins. |

### Complete Example

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

interface UserProfile {
    id: number;
    name: string;
    plan: string;
}

let databaseQueries = 0;

/** Stand-in for an expensive database or API call. */
async function loadUserProfile(id: number): Promise<UserProfile> {
    databaseQueries += 1;
    return { id, name: `User ${id}`, plan: 'pro' };
}

const cache = new MemoryCacheProvider({ rootKey: 'MyApp', defaultTTL: 600 });

// First call — miss: the factory runs and the result is cached.
const first = await cache.getOrSet<UserProfile>('user:7', () => loadUserProfile(7));
console.log(first.name); // 'User 7'

// Second call — hit: the factory is skipped entirely.
const second = await cache.getOrSet<UserProfile>('user:7', () => loadUserProfile(7));
console.log(second.name); // 'User 7'

console.log(databaseQueries); // 1 — the database was touched exactly once
console.log(await cache.ttl('user:7')); // ~600 — provider defaultTTL applied

await cache.shutdown();
```

### Key Methods & Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `getOrSet` | `getOrSet<T>(key: string, factory: () => Promise<T>, ttlSeconds?: number): Promise<T>` | Returns the cached value when present; otherwise awaits `factory`, caches the result, and returns it. |
| `factory` parameter | `() => Promise<T>` | Produces the value on a cache miss. May reject — the error propagates and nothing is cached. |
| `ttlSeconds` parameter | `number` (optional) | Per-call TTL for the populated entry; falls back to `defaultTTL`. |

---

## MemoryCacheProvider: The In-Process Backend

### What It Is

`MemoryCacheProvider` is the zero-dependency, in-process implementation of `CacheProvider`, backed by a `Map<string, MemoryCacheEntry>` where each entry holds the JSON-serialized value plus an optional expiry timestamp. It is the right backend for unit tests, local development, and single-instance applications, and it mimics Redis behavior closely enough — TTL conventions, `-1`/`-2` semantics, wildcard invalidation, JSON round-trips — that switching to Redis later requires no code changes.

### How It Works

- **Storage shape.** TTLs given in seconds are converted to absolute `expiresAt` timestamps in milliseconds on write; the providers store full prefixed keys (via `buildKey`), so the store is already namespaced.
- **Lazy eviction plus periodic cleanup.** Expired entries are evicted lazily whenever `get`, `exists`, `expire`, or `ttl` touches them, and proactively by a `setInterval` running every `cleanupIntervalMs` (default `60000`). The interval is `unref()`ed so a running cache never keeps the Node.js event loop alive; setting `cleanupIntervalMs` to `0` (or negative) disables the timer — the test suite does exactly this for deterministic timing.
- **JSON round-trip.** Values are serialized on write and parsed on read, so callers always receive deep copies: mutating the original object after `set()` never affects the cached value. A parse failure is treated as a cache miss, matching the Redis provider.
- **Redis-compatible semantics.** `ttl()` rounds remaining time up to whole seconds (`Math.ceil`) and returns `-1` for no expiry and `-2` for missing/expired keys. `deletePattern()` converts `*` wildcards into an anchored regular expression and deletes matching keys. `clear()` removes only keys carrying this provider's `rootKey` prefix.
- **Lifecycle.** `health()` always resolves `true` (there is no external dependency to check); `shutdown()` stops the cleanup interval and empties the store.
- Verified by the shared backend contract tests plus dedicated unit tests (see Testing Strategy).

### Complete Example

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

interface Session {
    token: string;
    roles: string[];
}

const cache = new MemoryCacheProvider({
    rootKey: 'Sessions',
    serviceName: 'session-cache',
    defaultTTL: 60,
    cleanupIntervalMs: 5_000,
});

const session: Session = { token: 'abc123', roles: ['admin'] };
await cache.set('user:42', session);

// Values are JSON round-tripped — mutating the source object afterwards
// does not leak into the cache.
session.roles.push('editor');
const stored = await cache.get<Session>('user:42');
console.log(stored?.roles); // ['admin']

console.log(await cache.ttl('user:42')); // ~60 — defaultTTL applied

const guestSession: Session = { token: 'xyz', roles: ['guest'] };
await cache.set('user:99', guestSession);

// Wildcard invalidation is scoped to the 'Sessions' namespace.
console.log(await cache.deletePattern('user:*')); // 2

await cache.shutdown();
```

### Key Methods & Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `constructor` | `(config: MemoryCacheConfig)` | Validates `rootKey` (inherited), defaults `cleanupIntervalMs` to `60000`, and starts the cleanup timer. |
| `set` | `set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>` | Serializes the value and stores it with an absolute expiry timestamp (or none). |
| `get` | `get<T>(key: string): Promise<T \| undefined>` | Lazy-evicts expired entries; returns a fresh copy parsed from JSON. |
| `delete` / `exists` | `delete(key: string): Promise<boolean>` / `exists(key: string): Promise<boolean>` | Map operations with lazy expiry checks. |
| `expire` / `ttl` | `expire(key: string, ttlSeconds: number): Promise<boolean>` / `ttl(key: string): Promise<number>` | Update/read the expiry timestamp; `-1`/`-2` follow Redis conventions. |
| `deletePattern` / `clear` | `deletePattern(pattern: string): Promise<number>` / `clear(): Promise<void>` | Wildcard deletion and namespace-scoped clearing. |
| `health` | `health(): Promise<boolean>` | Always resolves `true`. |
| `shutdown` | `shutdown(): Promise<void>` | Stops the cleanup interval and empties the store. |
| `cleanupIntervalMs` (config) | `number` (optional) | Cleanup timer interval; `0` or negative disables periodic cleanup. |

---

## RedisCacheProvider: The Redis Backend

### What It Is

`RedisCacheProvider` is the production backend: a `CacheProvider` implementation that maps every cache operation onto Redis commands through a single `ioredis` connection. It is the right choice for multi-instance deployments where every node must observe the same cache, and for workloads that need Redis' native TTL handling and memory management.

### How It Works

- **Connection.** The constructor creates the ioredis client immediately; it begins connecting in the background. When `url` is provided it takes precedence over `host`/`port`/`password`/`db`. Defaults: `host` `'localhost'`, `port` `6379`, `db` `0`, `connectTimeout` `5000` ms, `maxRetriesPerRequest` `3`.
- **Command mapping.** `set` → `SET key value [EX seconds]` (the `EX` flag only when an effective TTL exists); `get` → `GET` (`null` maps to `undefined`, unparseable JSON is treated as a cache miss); `delete` → `DEL` (resolves `true` when one key was removed); `exists` → `EXISTS`; `expire` → `EXPIRE`; `ttl` → native `TTL` (the `-1`/`-2` conventions come straight from Redis). Physical keys are `rootKey:key`.
- **Pattern invalidation is production-safe.** `deletePattern()` and `clear()` never call `KEYS`. They iterate with `SCAN MATCH <pattern> COUNT 100` and delete each batch with a single `DEL`, repeating until the cursor returns to `0` — the server stays responsive, and only the provider's namespace is touched.
- **Lifecycle.** `health()` sends `PING` and checks for the `PONG` reply, returning `false` on any failure; `shutdown()` calls `quit()` for a graceful disconnect that lets pending commands complete. After `shutdown()`, `health()` returns `false`.
- **Multi-instance isolation.** Any number of applications and processes can share one Redis server safely: the `rootKey` prefix is applied to every physical key by the base class, so namespaces never collide.

### Complete Example

```typescript
import { RedisCacheProvider } from 'blendsdk/webafx-cache';

interface Product {
    sku: string;
    price: number;
}

const cache = new RedisCacheProvider({
    rootKey: 'Catalog',
    host: 'localhost',
    port: 6379,
    defaultTTL: 300,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 3,
});

// Stored in Redis under the physical key "Catalog:product:1001".
const product: Product = { sku: 'SKU-1001', price: 49.99 };
await cache.set<Product>('product:1001', product, 600);
console.log((await cache.get<Product>('product:1001'))?.price); // 49.99

// SCAN-based invalidation (never KEYS), scoped to the namespace.
console.log(await cache.deletePattern('product:*')); // 1

console.log(await cache.health()); // true — PING answered PONG

await cache.shutdown();
```

### Key Methods & Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `constructor` | `(config: RedisCacheConfig)` | Creates the ioredis client (URL takes precedence over host/port/password/db) and connects in the background. |
| `set` | `set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>` | `SET` with JSON payload; adds `EX` when an effective TTL exists. |
| `get` | `get<T>(key: string): Promise<T \| undefined>` | `GET` + JSON parse; `null` or parse failure → `undefined`. |
| `delete` / `exists` / `expire` | `delete(key): Promise<boolean>` / `exists(key): Promise<boolean>` / `expire(key, ttlSeconds): Promise<boolean>` | Direct `DEL` / `EXISTS` / `EXPIRE` mappings. |
| `ttl` | `ttl(key: string): Promise<number>` | Native Redis `TTL` — positive seconds, `-1`, or `-2`. |
| `deletePattern` | `deletePattern(pattern: string): Promise<number>` | `SCAN MATCH` + batched `DEL`; resolves to the deleted count. |
| `clear` | `clear(): Promise<void>` | Same mechanism with pattern `rootKey:*`. |
| `health` | `health(): Promise<boolean>` | `PING`/`PONG` connectivity check; `false` after `shutdown()`. |
| `shutdown` | `shutdown(): Promise<void>` | Graceful `quit()` of the connection. |

---

## PubSubProvider: The Abstract Messaging Contract

### What It Is

`PubSubProvider` is the abstract base class of the messaging hierarchy — a fully independent abstraction that is parallel to, and shares no implementation with, `CacheProvider`. It defines the typed, JSON-serialized pub/sub contract (`publish`, `subscribe`, `unsubscribe`, `psubscribe`, `punsubscribe`, `activeSubscriptions`, `health`, `shutdown`), manages transparent channel prefixing, and isolates handler errors so one faulty subscriber can never break the others. `MemoryPubSubProvider` and `RedisPubSubProvider` implement it.

### How It Works

- **Construction.** Unlike the cache hierarchy, no field is mandatory: `channelPrefix` and `serviceName` (default `'pubsub'`) are both optional. Without a `channelPrefix`, channels are used verbatim.
- **Channel prefixing.** The protected `buildChannel('order:new')` returns `'MyApp:order:new'` when a prefix is configured (joined with `CHANNEL_SEPARATOR`); `buildChannelPattern()` does the same for glob patterns; `stripPrefix()` removes the prefix on inbound paths. Handlers and `activeSubscriptions()` therefore always observe the original, user-facing channel and pattern names.
- **Handler error isolation.** Every handler invocation goes through the protected `safeInvoke()` helper: a throwing or rejecting handler is caught and logged with `console.error` — it can never break sibling handlers or the underlying subscriber connection.
- **Delivery counts.** `publish()` resolves to the number of receivers. The precise meaning is backend-specific: the memory backend counts matching local handlers, while Redis counts subscriber connections that received the message. (Each backend section documents the exact semantics.)
- **Subscriptions.** Multiple handlers can be registered per channel or pattern; `activeSubscriptions()` is synchronous and returns `{ channels, patterns }` with unprefixed names. `health()` and `shutdown()` follow the same lifecycle contract as the cache hierarchy.

### Complete Example

```typescript
import { MemoryPubSubProvider, type PubSubProvider } from 'blendsdk/webafx-cache';

interface OrderEvent {
    orderId: number;
    total: number;
}

/** Accepts any backend — MemoryPubSubProvider or RedisPubSubProvider. */
async function announceOrder(pubsub: PubSubProvider, order: OrderEvent): Promise<void> {
    const receivers = await pubsub.publish<OrderEvent>('order:created', order);
    console.log(`delivered to ${receivers} receiver(s)`);
}

const pubsub = new MemoryPubSubProvider({ channelPrefix: 'Shop', serviceName: 'order-events' });

await pubsub.subscribe<OrderEvent>('order:created', (message) => {
    console.log(`order ${message.data.orderId}: $${message.data.total}`);
});

await announceOrder(pubsub, { orderId: 123, total: 49.99 });
// logs: order 123: $49.99
// logs: delivered to 1 receiver(s)

console.log(pubsub.activeSubscriptions()); // { channels: ['order:created'], patterns: [] }
console.log(pubsub.serviceName); // 'order-events'

await pubsub.shutdown();
```

### Key Methods & Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `constructor` | `(config: PubSubProviderConfig)` | Optional `channelPrefix` and `serviceName`; defaults `serviceName` to `'pubsub'`. |
| `serviceName` | `string` (getter) | Name used for WebAFX service registration. |
| `publish` | `publish<T>(channel: string, data: T): Promise<number>` | Abstract. JSON-serializes `data`; resolves to the receiver count (backend-specific). |
| `subscribe` | `subscribe<T = unknown>(channel: string, handler: MessageHandler<T>): Promise<void>` | Abstract. Exact-channel subscription; multiple handlers allowed. |
| `unsubscribe` | `unsubscribe(channel: string): Promise<void>` | Abstract. Removes all handlers for the channel and drops the underlying subscription. |
| `psubscribe` | `psubscribe<T = unknown>(pattern: string, handler: MessageHandler<T>): Promise<void>` | Abstract. Glob-pattern subscription (`*` = any sequence, `?` = one character). |
| `punsubscribe` | `punsubscribe(pattern: string): Promise<void>` | Abstract. Removes all handlers for the pattern. |
| `activeSubscriptions` | `(): { channels: string[]; patterns: string[] }` | Synchronous. Currently registered names, prefix-stripped. |
| `health` | `health(): Promise<boolean>` | Abstract. Backend connectivity check. |
| `shutdown` | `shutdown(): Promise<void>` | Abstract. Unsubscribes everything and releases connections. |

Protected members available to subclasses:

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `channelPrefix` | `string \| undefined` | Namespace prefix for all channel names. |
| `buildChannel` | `(channel: string) => string` | Prefixes an exact channel name. |
| `buildChannelPattern` | `(pattern: string) => string` | Prefixes a glob pattern. |
| `stripPrefix` | `(fullChannel: string) => string` | Removes the prefix from inbound channel names. |
| `safeInvoke` | `(handler: MessageHandler<T>, message: PubSubMessage<T>) => Promise<void>` | Invokes a handler with try/catch and logs errors. |

---

## Typed Messages: PubSubMessage, MessageHandler, SubscriptionDefinition

### What It Is

Three exported type contracts make pub/sub type-safe: `PubSubMessage<T>` — the envelope delivered to handlers; `MessageHandler<T>` — the handler signature; and `SubscriptionDefinition<T>` — a channel-or-pattern + handler pair used for declarative subscription registration. All three are available from the package root and from the `/memory` subpath.

### How It Works

- **Envelope.** `PubSubMessage<T>` carries `channel` (user-facing, prefix already stripped), `data` (the deserialized payload, re-created from JSON so handlers never share references), and `pattern` (present only on pattern deliveries — exact-channel messages leave it `undefined`). Because every payload makes a JSON round-trip, it must be JSON-serializable.
- **Handler.** `MessageHandler<T>` returns `void | Promise<void>`, so synchronous and asynchronous handlers are equally supported. All invocations are routed through `safeInvoke()`, which isolates errors per handler.
- **Type parameter defaults.** `subscribe<T = unknown>()` and `psubscribe<T = unknown>()` default to `unknown`; supply an explicit type argument — or build the handler through `SubscriptionDefinition<T>` — to type `message.data`.
- **SubscriptionDefinition.** Exactly one of `channel` or `pattern` plus a `handler`. This is the same shape accepted by `PubSubPluginOptions.subscriptions`, letting handlers be registered declaratively at plugin-install time (see the plugin builders section).

### Complete Example

```typescript
import {
    MemoryPubSubProvider,
    type PubSubMessage,
    type SubscriptionDefinition,
} from 'blendsdk/webafx-cache';

interface AuditEvent {
    actor: string;
    action: string;
}

const auditSubscriptions: SubscriptionDefinition<AuditEvent>[] = [
    {
        channel: 'audit:login',
        handler: (message: PubSubMessage<AuditEvent>) => {
            console.log(`login by ${message.data.actor}`);
        },
    },
    {
        pattern: 'audit:*',
        handler: (message: PubSubMessage<AuditEvent>) => {
            console.log(`${message.pattern} matched ${message.channel} → ${message.data.action}`);
        },
    },
];

const pubsub = new MemoryPubSubProvider({ channelPrefix: 'Security' });

for (const { channel, pattern, handler } of auditSubscriptions) {
    if (channel !== undefined) {
        await pubsub.subscribe<AuditEvent>(channel, handler);
    } else if (pattern !== undefined) {
        await pubsub.psubscribe<AuditEvent>(pattern, handler);
    }
}

await pubsub.publish<AuditEvent>('audit:login', { actor: 'alice', action: 'login' });
// logs: login by alice
// logs: audit:* matched audit:login → login

await pubsub.shutdown();
```

### Key Types & Properties

| Type | Signature | Description |
|------|-----------|-------------|
| `PubSubMessage<T>` | `{ channel: string; data: T; pattern?: string }` | Message envelope; `pattern` is set only for pattern deliveries. |
| `MessageHandler<T>` | `(message: PubSubMessage<T>) => void \| Promise<void>` | Handler function; sync or async; errors isolated via `safeInvoke`. |
| `SubscriptionDefinition<T>` | `{ channel?: string; pattern?: string; handler: MessageHandler<T> }` | Declarative subscription; exactly one of `channel` or `pattern`. |

`PubSubMessage` fields in detail:

| Field | Type | Description |
|-------|------|-------------|
| `channel` | `string` | The channel the message was published to, with the prefix stripped. |
| `data` | `T` | The deserialized payload — a fresh object, never a shared reference. |
| `pattern` | `string \| undefined` | The glob pattern that matched (pattern subscriptions only). |

---

## MemoryPubSubProvider: In-Process Messaging

### What It Is

`MemoryPubSubProvider` is the in-process implementation of `PubSubProvider`: handler maps plus synchronous, same-process delivery with a full JSON round-trip. There are no network connections and no external dependencies, making it ideal for unit tests and local development — while remaining contract-compatible with the Redis backend.

### How It Works

- **Storage.** Two maps: `Map<userChannel, Set<MessageHandler>>` for exact channels and `Map<userPattern, Set<MessageHandler>>` for patterns. The `Set` deduplicates identical handler references. The constructor config is optional; `channelPrefix` and `serviceName` behave per the shared contract (handlers always see unprefixed names).
- **Delivery.** `publish()` performs a `JSON.stringify` → `JSON.parse` round-trip, so handlers receive a fresh copy and non-serializable payloads fail fast. Every exact-channel handler runs first, followed by every handler whose pattern matches the channel. Delivery is immediate: synchronous handlers complete as part of the `publish()` call; async handlers are started and error-isolated through `safeInvoke()`.
- **Return value.** `publish()` resolves to the number of matching local handlers invoked — with two handlers on one channel, it resolves `2`. This differs from the Redis backend, which reports Redis subscriber counts instead.
- **Glob matching.** `matchGlob()` converts the pattern into an anchored regular expression: `*` → `.*` (any sequence), `?` → `.` (single character). All other regex-special characters are escaped, so channel names cannot inject regex behavior.
- **Lifecycle.** `health()` always resolves `true`; `shutdown()` clears both handler maps, after which publishes reach no handlers and resolve `0`.

### Complete Example

```typescript
import { MemoryPubSubProvider } from 'blendsdk/webafx-cache';

interface Metric {
    name: string;
    value: number;
}

const pubsub = new MemoryPubSubProvider({ channelPrefix: 'Telemetry' });

await pubsub.subscribe<Metric>('metric:cpu', (message) => {
    // message.channel is 'metric:cpu' — the prefix never leaks to handlers.
    console.log(`cpu = ${message.data.value}`);
});

await pubsub.psubscribe<Metric>('metric:*', (message) => {
    console.log(`pattern "${message.pattern}" matched "${message.channel}"`);
});

const receivers = await pubsub.publish<Metric>('metric:cpu', { name: 'cpu', value: 0.42 });
console.log(receivers); // 2 — one exact handler + one pattern handler

await pubsub.shutdown();
```

### Key Methods & Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `constructor` | `(config?: MemoryPubSubConfig)` | Config is optional; initializes empty handler maps. |
| `publish` | `publish<T>(channel: string, data: T): Promise<number>` | JSON round-trip; delivers to exact then pattern handlers; resolves to the number of local handlers invoked. |
| `subscribe` / `unsubscribe` | `subscribe<T = unknown>(channel: string, handler: MessageHandler<T>): Promise<void>` / `unsubscribe(channel: string): Promise<void>` | Adds/removes all handlers for an exact channel. |
| `psubscribe` / `punsubscribe` | `psubscribe<T = unknown>(pattern: string, handler: MessageHandler<T>): Promise<void>` / `punsubscribe(pattern: string): Promise<void>` | Adds/removes all handlers for a glob pattern. |
| `activeSubscriptions` | `(): { channels: string[]; patterns: string[] }` | Synchronous; derived from the handler maps. |
| `health` | `health(): Promise<boolean>` | Always resolves `true`. |
| `shutdown` | `shutdown(): Promise<void>` | Clears both handler maps. |

---

## RedisPubSubProvider: Redis Messaging

### What It Is

`RedisPubSubProvider` is the production pub/sub backend, delivering messages across processes and instances through Redis. It creates **two** dedicated `ioredis` connections — Redis requires a dedicated connection once a client enters subscriber mode, and such a connection can no longer issue regular commands like `PUBLISH`.

### How It Works

- **Two connections.** `publisher` handles `PUBLISH`; `subscriber` handles `SUBSCRIBE`/`PSUBSCRIBE` and receives the inbound message events. Both are created immediately from the same config, with the same defaults and `url`-precedence rules as `RedisCacheProvider` (`localhost`, `6379`, db `0`, `connectTimeout` `5000` ms, `maxRetriesPerRequest` `3`).
- **Message routing.** Inbound messages arrive on the subscriber connection as ioredis `message(channel, payload)` and `pmessage(pattern, channel, payload)` events. The provider strips the prefix from the channel (and pattern), looks up the handler set by user-facing name, `JSON.parse`s the payload (logging and dropping unparseable messages), and fans out to every handler through `safeInvoke()`. Pattern deliveries carry both `channel` and `pattern` in the envelope.
- **Subscription sharing.** The `SUBSCRIBE`/`PSUBSCRIBE` command is sent only when the *first* local handler for a channel or pattern is registered; additional handlers share that single Redis subscription. In return, `unsubscribe()`/`punsubscribe()` remove **all** local handlers and drop the Redis subscription.
- **Delivery count.** `publish()` resolves to the count reported by Redis itself — the number of Redis subscriber connections that received the message. One process with three local handlers on a single channel still counts as one subscriber (compare with the memory backend, which counts local handlers).
- **Lifecycle.** `health()` pings both connections and requires `PONG` from each; `shutdown()` unsubscribes all channels and patterns, clears the handler maps, then calls `quit()` on both connections.

### Complete Example

```typescript
import { setTimeout as delay } from 'node:timers/promises';
import { RedisPubSubProvider } from 'blendsdk/webafx-cache';

interface OrderEvent {
    orderId: number;
    total: number;
}

const pubsub = new RedisPubSubProvider({
    host: 'localhost',
    port: 6379,
    channelPrefix: 'Shop',
});

await pubsub.subscribe<OrderEvent>('order:created', (message) => {
    console.log(`order ${message.data.orderId}: $${message.data.total}`);
});

// Give SUBSCRIBE a moment to reach Redis before publishing.
await delay(100);

const receivers = await pubsub.publish<OrderEvent>('order:created', { orderId: 123, total: 49.99 });
console.log(receivers); // 1 — one Redis subscriber connection received the message

console.log(await pubsub.health()); // true — both connections answered PING
await pubsub.shutdown();
```

### Key Methods & Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `constructor` | `(config: RedisPubSubConfig)` | Creates the publisher and subscriber ioredis connections; wires the message event handlers. |
| `publish` | `publish<T>(channel: string, data: T): Promise<number>` | `PUBLISH` on the publisher connection; resolves to the Redis subscriber count. |
| `subscribe` | `subscribe<T = unknown>(channel: string, handler: MessageHandler<T>): Promise<void>` | `SUBSCRIBE` is sent only on the first handler for the channel; extra handlers share it. |
| `unsubscribe` | `unsubscribe(channel: string): Promise<void>` | Removes all local handlers and unsubscribes the Redis channel. |
| `psubscribe` | `psubscribe<T = unknown>(pattern: string, handler: MessageHandler<T>): Promise<void>` | `PSUBSCRIBE` on the first handler for the pattern; extra handlers share it. |
| `punsubscribe` | `punsubscribe(pattern: string): Promise<void>` | Removes all local handlers and drops the Redis pattern subscription. |
| `activeSubscriptions` | `(): { channels: string[]; patterns: string[] }` | Synchronous; local handler keys, prefix-stripped. |
| `health` | `health(): Promise<boolean>` | `PING` on both connections; `true` only when both reply `PONG`. |
| `shutdown` | `shutdown(): Promise<void>` | Unsubscribes everything, clears maps, and `quit()`s both connections. |

---

## Configuration Types and Constants

### What It Is

The package's configuration model is a set of exported interfaces composed from shared bases — `CacheProviderConfig`, `PubSubProviderConfig`, and `RedisConnectionConfig` — plus the discriminator-based factory configs `CacheFactoryConfig` and `PubSubFactoryConfig`, and the exported constants `DEFAULT_SERVICE_NAME`, `DEFAULT_TTL`, `KEY_SEPARATOR`, `DEFAULT_PUBSUB_SERVICE_NAME`, and `CHANNEL_SEPARATOR`.

### How It Works

- **Composition over duplication.** `RedisCacheConfig` is `CacheProviderConfig` combined with `RedisConnectionConfig`; `RedisPubSubConfig` is `PubSubProviderConfig` combined with the same base. Both hierarchies therefore share one Redis connection shape, and a single URL or host/port pair can drive both services of an application.
- **Defaults applied at construction.** Providers apply fallbacks with `??` as they initialize: service names (`'cache'` / `'pubsub'`), `defaultTTL` (`0` = no expiry), Redis connection defaults, and the memory cleanup interval (`60000` ms). Interfaces describe what you *may* pass; defaults live in the implementations.
- **Factory configs are flat unions.** `CacheFactoryConfig` and `PubSubFactoryConfig` carry the base fields plus Redis-only fields (`host`, `port`, `password`, `db`, `url`) and, for cache, the memory-only `cleanupIntervalMs`. Redis-only fields are simply ignored by the memory branch. Neither factory config exposes `connectTimeout`/`maxRetriesPerRequest` — to tune those, construct `RedisCacheProvider`/`RedisPubSubProvider` directly or use the Redis plugin factories with a full `RedisCacheConfig`/`RedisPubSubConfig`.
- **Constants.** `KEY_SEPARATOR` and `CHANNEL_SEPARATOR` are both `':'` and are used by the base classes when building prefixed keys and channels; they are exported for consumers building composed keys or tooling.

### Complete Example

```typescript
import {
    DEFAULT_PUBSUB_SERVICE_NAME,
    DEFAULT_SERVICE_NAME,
    DEFAULT_TTL,
    KEY_SEPARATOR,
    MemoryCacheProvider,
    MemoryPubSubProvider,
    type MemoryCacheConfig,
    type RedisCacheConfig,
} from 'blendsdk/webafx-cache';

const cacheConfig: MemoryCacheConfig = {
    rootKey: 'MyApp',
    serviceName: 'app-cache',
    defaultTTL: 120,
    cleanupIntervalMs: 60_000,
};

// Redis configs share one connection shape across both hierarchies.
const redisConfig: RedisCacheConfig = {
    rootKey: 'Shared',
    url: 'redis://localhost:6379',
    connectTimeout: 5_000,
    maxRetriesPerRequest: 3,
};

const cache = new MemoryCacheProvider(cacheConfig);
const pubsub = new MemoryPubSubProvider({ channelPrefix: 'MyApp' });

console.log(cache.serviceName); // 'app-cache' — from config
console.log(pubsub.serviceName); // 'pubsub' — DEFAULT_PUBSUB_SERVICE_NAME
console.log(DEFAULT_SERVICE_NAME); // 'cache'
console.log(DEFAULT_TTL); // 0 — no expiry
console.log(`${redisConfig.rootKey}${KEY_SEPARATOR}user:123`); // 'Shared:user:123'

await pubsub.shutdown();
await cache.shutdown();
```

### Key Interfaces

Cache configuration:

| Interface | Field | Type | Default / Notes |
|-----------|-------|------|-----------------|
| `CacheProviderConfig` | `rootKey` | `string` (required) | Namespace prefix for all keys. |
| `CacheProviderConfig` | `serviceName` | `string` (optional) | Default `'cache'`. |
| `CacheProviderConfig` | `defaultTTL` | `number` (optional) | Default `0` (no expiry). |
| `RedisCacheConfig` | Redis fields | `host`, `port`, `password`, `db`, `url`, `connectTimeout`, `maxRetriesPerRequest` | Defaults `localhost`, `6379`, `—`, `0`, `—` (URL wins), `5000`, `3`. |
| `MemoryCacheConfig` | `cleanupIntervalMs` | `number` (optional) | Default `60000`; `0` or negative disables periodic cleanup. |

Pub/Sub configuration:

| Interface | Field | Type | Default / Notes |
|-----------|-------|------|-----------------|
| `PubSubProviderConfig` | `channelPrefix` | `string` (optional) | No prefix when omitted. |
| `PubSubProviderConfig` | `serviceName` | `string` (optional) | Default `'pubsub'`. |
| `RedisPubSubConfig` | Redis fields | Same shared `RedisConnectionConfig` fields as the cache backend | Two connections are created from this config. |
| `MemoryPubSubConfig` | — | — | No additional fields beyond the base. |

Factory configs:

| Interface | Required fields | Optional fields |
|-----------|-----------------|-----------------|
| `CacheFactoryConfig` | `type: 'redis' \| 'memory'`, `rootKey` | `serviceName`, `defaultTTL`, `host`, `port`, `password`, `db`, `url`, `cleanupIntervalMs` |
| `PubSubFactoryConfig` | `type: 'redis' \| 'memory'` | `channelPrefix`, `serviceName`, `host`, `port`, `password`, `db`, `url` |

Constants:

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEFAULT_SERVICE_NAME` | `'cache'` | Default cache service container name. |
| `DEFAULT_TTL` | `0` | Default TTL meaning "no expiry". |
| `KEY_SEPARATOR` | `':'` | Separator between `rootKey` and user keys. |
| `DEFAULT_PUBSUB_SERVICE_NAME` | `'pubsub'` | Default pub/sub service container name. |
| `CHANNEL_SEPARATOR` | `':'` | Separator between `channelPrefix` and channel names. |

---

## Plugin Builders: createCachePlugin and createPubSubPlugin

### What It Is

`createCachePlugin(provider, options?)` and `createPubSubPlugin(provider, options?)` adapt any provider instance — Redis, memory, or a custom subclass — into a WebAFX `PluginDefinition`. They are the generic bridge between the standalone provider world and the WebAFX application lifecycle; the one-liner factories in the next section are thin wrappers around them.

### How It Works

- **Plugin shape.** Each builder returns `{ name, priority, factory }`. `name` is taken from `provider.serviceName`; `priority` defaults to `30` (installs after most core plugins) and can be overridden — including with `0`.
- **Installation.** When WebAFX executes the plugin factory:
  1. The provider is registered as a **singleton** service under `provider.serviceName` — one instance serving the entire application (never per-request). The registration's `dispose` hook calls `provider.shutdown()`.
  2. Initialization is logged through the WebAFX logger, including the provider class name.
  3. The factory returns hooks that wire `provider.health()` into the WebAFX health endpoint and `provider.shutdown()` into graceful shutdown.
- **Declarative subscriptions** (pub/sub only). `PubSubPluginOptions.subscriptions` accepts `SubscriptionDefinition[]`; entries with a `channel` are registered via `subscribe()`, entries with a `pattern` via `psubscribe()`, in order, each logged at install time.
- **Redis-free by design.** Both builder modules import only provider types and never `ioredis` — which is what makes the `/memory` subpath possible without loading the Redis client.
- **Multi-service support.** Distinct `serviceName` values produce distinct plugins and services, so one application can register several independent caches or pub/sub instances side by side.

### Complete Example

```typescript
import {
    MemoryCacheProvider,
    MemoryPubSubProvider,
    createCachePlugin,
    createPubSubPlugin,
} from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({ rootKey: 'MyApp', serviceName: 'app-cache' });
const pubsub = new MemoryPubSubProvider({ channelPrefix: 'MyApp', serviceName: 'app-pubsub' });

const cachePlugin = createCachePlugin(cache, { priority: 25 });
const pubsubPlugin = createPubSubPlugin(pubsub, {
    subscriptions: [
        {
            channel: 'user:registered',
            handler: (message) => {
                console.log('registration event received:', message.data);
            },
        },
        {
            pattern: 'audit:*',
            handler: (message) => {
                console.log(`audit pattern "${message.pattern}" matched "${message.channel}"`);
            },
        },
    ],
});

console.log(cachePlugin.name); // 'app-cache'
console.log(cachePlugin.priority); // 25
console.log(pubsubPlugin.name); // 'app-pubsub'
console.log(pubsubPlugin.priority); // 30 — default

await cache.shutdown();
await pubsub.shutdown();
```

Register the finished plugins on a WebAFX application (the framework then owns their lifecycle):

```typescript fragment
app.use(cachePlugin);
app.use(pubsubPlugin);
```

### Key Methods & Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `createCachePlugin` | `(provider: CacheProvider, options?: { priority?: number }) => PluginDefinition` | Wraps any cache provider; registers it as a singleton with `health()`/`shutdown()` hooks. |
| `createPubSubPlugin` | `(provider: PubSubProvider, options?: PubSubPluginOptions) => PluginDefinition` | Wraps any pub/sub provider; additionally registers declarative subscriptions. |
| `PubSubPluginOptions.priority` | `number` (optional) | Plugin install priority; default `30` per builder. |
| `PubSubPluginOptions.subscriptions` | `SubscriptionDefinition[]` (optional) | Channel/pattern handlers registered at install time, in order. |

Plugin lifecycle behavior:

| Hook / registration | Wired to |
|---------------------|----------|
| Singleton service named `provider.serviceName` | `factory: () => provider` (same instance every time) |
| `dispose` of the service registration | `provider.shutdown()` |
| Health endpoint hook | `provider.health()` |
| Graceful shutdown hook | `provider.shutdown()` |

---

## Convenience Factories: One-Liners and Backend Selection

### What It Is

The shortcut layer on top of the plugin builders: one-liner plugin factories (`redisCachePlugin`, `memoryCachePlugin`, `redisPubSubPlugin`, `memoryPubSubPlugin`) that construct a provider and wrap it into a plugin in a single call, plus environment-switching factories (`createCache`, `createPubSub`) that return a bare provider chosen by a `type` discriminator.

### How It Works

- **One-liner plugins.** `redisCachePlugin(config: RedisCacheConfig)` creates a `RedisCacheProvider` internally and returns `createCachePlugin(provider)`; `memoryCachePlugin` does the memory equivalent. `redisPubSubPlugin(config, options?)` and `memoryPubSubPlugin(config?, options?)` follow the same pattern for pub/sub, forwarding `PubSubPluginOptions`.
- **Backend selection.** `createCache(config: CacheFactoryConfig): CacheProvider` switches on `config.type`: `'redis'` builds a `RedisCacheProvider` (forwarding `rootKey`, `serviceName`, `defaultTTL`, `host`, `port`, `password`, `db`, `url`), `'memory'` builds a `MemoryCacheProvider` (forwarding `rootKey`, `serviceName`, `defaultTTL`, `cleanupIntervalMs`). An unknown type throws `Unknown cache type: "<type>". Supported types: "redis", "memory".`
- **Pub/Sub selection.** `createPubSub(config: PubSubFactoryConfig): PubSubProvider` follows the same discriminator pattern (forwarding `channelPrefix` and `serviceName` to both backends) and throws `Unknown pub/sub type: ...` for unknown types.
- **Typical usage.** Choose the backend from environment variables once at startup, then register the provider with WebAFX through `createCachePlugin()` / `createPubSubPlugin()` — exactly what the one-liners do, just with an explicit provider in between.

### Complete Example

```typescript
import { setTimeout as delay } from 'node:timers/promises';
import { createCache, createPubSub } from 'blendsdk/webafx-cache';

const isProduction = process.env.NODE_ENV === 'production';

// One configuration shape, two possible backends — the same code path runs
// on the in-memory providers locally and on Redis in production.
const cache = createCache({
    type: isProduction ? 'redis' : 'memory',
    rootKey: 'MyApp',
    serviceName: 'app-cache',
    defaultTTL: 300,
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : undefined,
});

const pubsub = createPubSub({
    type: isProduction ? 'redis' : 'memory',
    channelPrefix: 'MyApp',
    serviceName: 'app-pubsub',
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : undefined,
});

await cache.set('boot', { at: Date.now() });
console.log(await cache.exists('boot')); // true

await pubsub.subscribe<string>('boot', (message) => {
    console.log(`boot event: ${message.data}`);
});
await delay(100); // lets SUBSCRIBE reach Redis when the Redis backend is selected
await pubsub.publish('boot', 'ready');
console.log(pubsub.activeSubscriptions()); // { channels: ['boot'], patterns: [] }

await pubsub.shutdown();
await cache.shutdown();
```

Wrapping the same providers for WebAFX:

```typescript fragment
app.use(createCachePlugin(cache));
app.use(createPubSubPlugin(pubsub));
```

### Key Methods & Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `redisCachePlugin` | `(config: RedisCacheConfig) => PluginDefinition` | One-liner: creates a `RedisCacheProvider` and wraps it in a plugin. |
| `memoryCachePlugin` | `(config: MemoryCacheConfig) => PluginDefinition` | One-liner: creates a `MemoryCacheProvider` and wraps it in a plugin. |
| `redisPubSubPlugin` | `(config: RedisPubSubConfig, options?: PubSubPluginOptions) => PluginDefinition` | One-liner: creates a `RedisPubSubProvider`; supports declarative subscriptions. |
| `memoryPubSubPlugin` | `(config?: MemoryPubSubConfig, options?: PubSubPluginOptions) => PluginDefinition` | One-liner memory pub/sub plugin; config is optional. |
| `createCache` | `(config: CacheFactoryConfig) => CacheProvider` | Backend selection by `type`; throws on unknown types. |
| `createPubSub` | `(config: PubSubFactoryConfig) => PubSubProvider` | Backend selection by `type`; throws on unknown types. |

---

## The Redis-Free /memory Subpath

### What It Is

`blendsdk/webafx-cache/memory` is a first-class, Redis-free entry point that exposes the two abstractions, the in-memory providers, the generic plugin builders, the memory plugin factories, and the memory/plugin types. Applications that never use Redis — tests, single-instance deployments — can import from this subpath so that `ioredis` is never loaded into the process.

### How It Works

- **Why it exists.** The main entry re-exports the Redis providers, whose modules import `ioredis` at load time. The subpath instead pulls only `memory.ts` and its dependency chain (the abstract providers, the memory providers, the two Redis-free plugin builders, and `types.ts`) — none of which import `ioredis`. A specification test asserts that importing the subpath never evaluates the Redis client module.
- **Shared identities.** The subpath re-exports the very same class objects as the main entry (`memory.MemoryCacheProvider === main.MemoryCacheProvider`), so mixing imports from both entry points is safe — there are no duplicate class copies and `instanceof` checks keep working.
- **What it exports:** `CacheProvider`, `PubSubProvider`, `MemoryCacheProvider`, `MemoryPubSubProvider`, `createCachePlugin`, `createPubSubPlugin`, `memoryCachePlugin`, `memoryPubSubPlugin`, and the types `CacheProviderConfig`, `MemoryCacheConfig`, `MemoryPubSubConfig`, `PubSubPluginOptions`, `PubSubMessage`, `MessageHandler`, `SubscriptionDefinition`.
- **What it deliberately does not export:** the Redis providers and Redis-specific factories (`RedisCacheProvider`, `RedisPubSubProvider`, `redisCachePlugin`, `redisPubSubPlugin`, `createCache`, `createPubSub`). Importing one of those from the subpath is a compile-time error — use the main entry for them.
- **First-class specifier.** `./memory` is declared in the package's `exports` map with its own types and ESM build output; it is a supported public entry point, not a deep import into build artifacts.

### Complete Example

```typescript
import {
    MemoryCacheProvider,
    MemoryPubSubProvider,
    createCachePlugin,
    memoryCachePlugin,
} from 'blendsdk/webafx-cache/memory';

const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });
await cache.set('greeting', 'hello');
console.log(await cache.get<string>('greeting')); // 'hello'

const pubsub = new MemoryPubSubProvider({ channelPrefix: 'MyApp' });
await pubsub.subscribe<string>('greetings', (message) => {
    console.log(message.data); // 'hi'
});
await pubsub.publish('greetings', 'hi');

// The Redis-free builders and factories are exposed here too:
console.log(createCachePlugin(cache).name); // 'cache'
console.log(memoryCachePlugin({ rootKey: 'Other', serviceName: 'other-cache' }).name); // 'other-cache'

await pubsub.shutdown();
await cache.shutdown();
```

### Key Entry Points

| Entry point | Import specifier | Loads `ioredis`? |
|-------------|------------------|------------------|
| Main | `blendsdk/webafx-cache` | Yes — the Redis providers are re-exported from the root. |
| Memory | `blendsdk/webafx-cache/memory` | No — the subpath's dependency graph never touches the Redis modules. |

Subpath exports:

| Export | Kind | Description |
|--------|------|-------------|
| `CacheProvider`, `PubSubProvider` | Abstract classes | Base contracts, safe to import anywhere. |
| `MemoryCacheProvider`, `MemoryPubSubProvider` | Concrete classes | In-memory backends with zero external dependencies. |
| `createCachePlugin`, `createPubSubPlugin` | Functions | Redis-free plugin builders for any provider instance. |
| `memoryCachePlugin`, `memoryPubSubPlugin` | Functions | Memory plugin factories with no Redis code path. |
| `CacheProviderConfig`, `MemoryCacheConfig`, `MemoryPubSubConfig`, `PubSubPluginOptions`, `PubSubMessage`, `MessageHandler`, `SubscriptionDefinition` | Types | Configuration and messaging types. |

---

## Related Documentation

- Overview — package identity, feature list, architecture diagram, and dependencies.
- Basic Usage — step-by-step setup and first working examples.
- Testing Strategy — the shared contract test suites that pin identical backend behavior.

---

# webafx-cache Basic Usage

> **License**: MIT (TrueSoftware B.V.)

This guide takes you from installation to a working cache and pub/sub setup, then walks through the API one concept at a time, followed by the full configuration reference and the package's error model. Every example is complete and runs in an ESM project on Node.js >= 22.

---

## Installation

Install the package with your preferred package manager:

```bash
# npm
npm install blendsdk

# yarn
yarn add blendsdk

# pnpm
pnpm add blendsdk
```

### Requirements

| Requirement | Value |
|-------------|-------|
| Node.js | `>= 22.0.0` |
| Module system | ESM only (`"type": "module"`) — use `import`, never `require()` |
| TypeScript | 5.x, strict mode recommended; the package ships its own type definitions |

### Notes

- `ioredis` is installed automatically as a dependency. It is only *loaded* when the Redis providers are imported — importing the `blendsdk/webafx-cache/memory` subpath never loads it.
- `blendsdk/webafx` is an **optional peer dependency**. You only need it for the WebAFX plugin integration functions (`redisCachePlugin()`, `createCachePlugin()`, etc.). Standalone provider usage requires no WebAFX. Install it alongside when building a WebAFX app:

```bash
npm install blendsdk
```

---

## Quick Start

The smallest possible program — an in-memory cache with a default TTL of 5 minutes:

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({ rootKey: 'MyApp', defaultTTL: 300 });

await cache.set('greeting', { message: 'Hello, BlendSDK!' });
const greeting = await cache.get<{ message: string }>('greeting');

console.log(greeting?.message); // 'Hello, BlendSDK!'

await cache.shutdown();
```

That is the entire setup: create a provider, `set` a value, `get` it back, and call `shutdown()` when the process stops. No server, no configuration files — the in-memory backend needs nothing but the `rootKey`.

Two things to remember as you continue:

- Swapping to `RedisCacheProvider` (plus connection options) changes nothing else in your code — both backends implement the same contract.
- Call `shutdown()` on application stop. It releases Redis connections and stops the in-memory cleanup timer.

---

## Fundamentals

The following subsections build up one concept at a time. In-memory examples run anywhere; the Redis examples assume a Redis server reachable on `localhost:6379`.

### Creating a provider

Every provider is created by instantiating its class with a configuration object. The only required option for a cache provider is `rootKey` — the namespace that prefixes every key, so multiple applications can safely share one Redis instance.

```typescript
import { MemoryCacheProvider, RedisCacheProvider } from 'blendsdk/webafx-cache';

// In-memory backend — zero dependencies, ideal for development and tests
const memoryCache = new MemoryCacheProvider({ rootKey: 'MyApp' });

// Redis backend — same base options plus connection details
const redisCache = new RedisCacheProvider({
    rootKey: 'MyApp',
    host: 'localhost',
    port: 6379,
    defaultTTL: 300,
});

console.log(memoryCache.serviceName); // 'cache'
console.log(redisCache.serviceName);  // 'cache'

await memoryCache.shutdown();
await redisCache.shutdown();
```

How namespacing works:

- With `rootKey: 'MyApp'`, storing the key `'user:123'` actually writes the key `'MyApp:user:123'` in the backend. The `:` separator is the exported constant `KEY_SEPARATOR`.
- Two providers with different `rootKey` values never see each other's keys — even in the same Redis database.
- Both cache classes share the base options (`rootKey`, `serviceName`, `defaultTTL`); `RedisCacheProvider` adds connection options (`host`, `port`, `url`, …).

### Storing and reading values

`set()` and `get()` work with any JSON-serializable value. The generic type parameter on `get<T>()` gives you a typed result, and a cache miss resolves to `undefined` instead of throwing.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

interface User {
    id: number;
    name: string;
    roles: string[];
}

const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });

// Store any JSON-serializable value
await cache.set<User>('user:123', { id: 123, name: 'Alice', roles: ['admin'] });
await cache.set<number>('page:views', 1042);
await cache.set<boolean>('feature:enabled', true);

// Read back with the same type parameter
const user = await cache.get<User>('user:123');
console.log(user?.name); // 'Alice'

const views = await cache.get<number>('page:views');
console.log(views); // 1042

// A cache miss resolves to undefined — it never throws
const missing = await cache.get<User>('user:999');
console.log(missing); // undefined

await cache.shutdown();
```

Key points about values:

- Values are JSON-serialized on write and deserialized on read on **both** backends, so what you get back is always a deep copy — mutating it does not change the stored value.
- Because of serialization, values must be JSON-serializable: objects, arrays, strings, numbers, booleans, `null`. For an explicit empty value, store `null` rather than `undefined`. Circular references and `BigInt` values reject with a `TypeError` (see [Error Handling](#error-handling)).
- Keys are plain strings — organize them with your own convention, e.g. `'user:123'`, `'product:42'`. The `rootKey` prefix is added and stripped automatically.

### Expiring entries with TTL

Every `set()` accepts an optional TTL in seconds. If you omit it, the provider's `defaultTTL` applies; setting `0` explicitly means "no expiry", even when a `defaultTTL` is configured.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({ rootKey: 'MyApp', defaultTTL: 300 });

await cache.set('greeting', 'hello');        // no TTL passed -> defaultTTL (300s)
await cache.set('otp', '482913', 60);        // explicit TTL (60s) overrides the default
await cache.set('config', { theme: 'dark' }, 0); // TTL 0 -> never expires

// Inspect remaining TTL using Redis conventions
console.log(await cache.ttl('greeting')); // ~300
console.log(await cache.ttl('otp'));      // ~60
console.log(await cache.ttl('config'));   // -1 (exists, no expiry)
console.log(await cache.ttl('unknown'));  // -2 (key does not exist)

// Change the TTL of an existing key without touching its value
const updated = await cache.expire('otp', 120);
console.log(updated); // true
console.log(await cache.ttl('otp')); // ~120

await cache.shutdown();
```

| `ttl()` result | Meaning |
|----------------|---------|
| `> 0` | Remaining seconds before expiry |
| `-1` | Key exists and never expires |
| `-2` | Key does not exist (never set, or already expired) |

Notes:

- `expire(key, seconds)` returns `true` when the key existed and the TTL was updated, `false` otherwise.
- Expired entries are treated as missing by `get()`, `exists()`, and `ttl()`.

### Cache-aside with getOrSet

The most common caching pattern — "return the cached value, or produce, cache, and return a new one" — is built in as `getOrSet(key, factory, ttlSeconds?)`.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

interface Product {
    id: number;
    name: string;
    price: number;
}

async function loadProduct(id: number): Promise<Product> {
    // Stand-in for an expensive database query or external API call
    return { id, name: `Product ${id}`, price: 19.99 };
}

const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });

// First call — cache miss: the factory runs and the result is cached for 300 seconds
const first = await cache.getOrSet<Product>('product:42', async () => {
    return await loadProduct(42);
}, 300);

console.log(first.name); // 'Product 42'

// Second call — cache hit: the factory is skipped entirely
const second = await cache.getOrSet<Product>('product:42', async () => {
    throw new Error('This factory never runs on a cache hit');
}, 300);

console.log(second.name); // 'Product 42'

await cache.shutdown();
```

`getOrSet()` is implemented once in the abstract base class, so it behaves identically on every backend.

### Deleting and checking keys

`delete()` removes a key and tells you whether it existed; `exists()` tells you whether a key is currently present.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });

await cache.set('session:abc', { userId: 7 });

console.log(await cache.exists('session:abc')); // true
console.log(await cache.delete('session:abc')); // true — the key existed
console.log(await cache.delete('session:abc')); // false — already gone
console.log(await cache.exists('session:abc')); // false

await cache.shutdown();
```

- Both methods account for TTL: an expired entry counts as missing, so `delete()` returns `false` on it.
- `delete()` is the targeted single-key invalidation tool.

### Invalidating many keys at once

Use `deletePattern()` with a `*` wildcard to invalidate a group of keys, and `clear()` to wipe everything under the provider's `rootKey`.

```typescript
import { RedisCacheProvider } from 'blendsdk/webafx-cache';

const cache = new RedisCacheProvider({ rootKey: 'MyApp', host: 'localhost', port: 6379 });

await cache.set('user:1', { name: 'Alice' });
await cache.set('user:2', { name: 'Bob' });
await cache.set('product:1', { name: 'Chair' });

// Delete every key matching 'user:*' within the 'MyApp' namespace
const deleted = await cache.deletePattern('user:*');
console.log(deleted); // 2

// Only the product key remains
console.log(await cache.exists('product:1')); // true

// clear() removes everything under the rootKey — and nothing outside it
await cache.clear();

await cache.shutdown();
```

- The wildcard can appear anywhere: `'api:*:active'` matches `api:users:active` and `api:products:active`.
- On Redis, pattern deletion uses `SCAN` with batched `DEL` — never `KEYS` — so it is safe for production.
- `clear()` is scoped strictly to the provider's `rootKey` namespace. It does **not** flush the Redis database or touch other applications' keys.
- `deletePattern()` resolves to the number of keys deleted (`0` when nothing matched).

### Publishing and subscribing

The pub/sub hierarchy is independent from caching. Channels are strings; payloads are typed and JSON-serialized. Handlers may be synchronous or asynchronous and receive a `PubSubMessage<T>` envelope.

```typescript
import { MemoryPubSubProvider } from 'blendsdk/webafx-cache';
import type { PubSubMessage } from 'blendsdk/webafx-cache';

interface OrderEvent {
    orderId: number;
    total: number;
}

const pubsub = new MemoryPubSubProvider({ channelPrefix: 'MyApp' });

await pubsub.subscribe<OrderEvent>('order:new', (message: PubSubMessage<OrderEvent>) => {
    console.log(`Order ${message.data.orderId} — total ${message.data.total}`);
    console.log(message.channel); // 'order:new' (the prefix is hidden)
});

const receivers = await pubsub.publish('order:new', { orderId: 1001, total: 49.99 });
console.log(`Delivered to ${receivers} handler(s)`); // "Delivered to 1 handler(s)"

await pubsub.shutdown();
```

The envelope delivered to handlers:

| Field | Type | Description |
|-------|------|-------------|
| `channel` | `string` | The channel the message was published to, with the prefix stripped |
| `data` | `T` | The deserialized payload |
| `pattern` | `string \| undefined` | Set only for pattern subscriptions — the pattern that matched |

Notes:

- `channelPrefix` works like `rootKey` does for cache keys: it namespaces channels (e.g. `MyApp:order:new`) so multiple applications can share one Redis instance.
- `publish()` resolves to the number of receivers — local handler count on the memory backend, Redis subscriber count on the Redis backend. With no subscribers it resolves to `0`.
- Delivery is fire-and-forget: messages published while no matching subscriber is connected are dropped, never replayed.

### Pattern subscriptions

`psubscribe()` subscribes to a glob pattern instead of an exact channel; `punsubscribe()` removes it.

```typescript
import { MemoryPubSubProvider } from 'blendsdk/webafx-cache';

interface AuditEvent {
    userId: number;
    action: string;
}

const pubsub = new MemoryPubSubProvider({ channelPrefix: 'MyApp' });

await pubsub.psubscribe<AuditEvent>('audit:*', (message) => {
    console.log(`[${message.pattern}] ${message.channel}: ${message.data.action}`);
});

await pubsub.publish('audit:login', { userId: 7, action: 'login' });
// Console: [audit:*] audit:login: login

await pubsub.publish('audit:logout', { userId: 7, action: 'logout' });
// Console: [audit:*] audit:logout: logout

await pubsub.shutdown();
```

- Portable glob subset: `*` matches any sequence of characters, `?` matches exactly one character. Stick to these two for identical behavior on both backends.
- The `pattern` field is present in the message envelope for pattern-matched deliveries.
- Exact and pattern subscriptions overlap by design: a message on `order:new` reaches both an exact `order:new` handler and an `order:*` pattern handler.

### Managing subscriptions

Multiple handlers can be registered per channel (fan-out). `unsubscribe()` removes **all** handlers for a channel, and `activeSubscriptions()` reports what is currently registered — always with user-facing, unprefixed names.

```typescript
import { MemoryPubSubProvider } from 'blendsdk/webafx-cache';

const pubsub = new MemoryPubSubProvider({ channelPrefix: 'MyApp' });

await pubsub.subscribe('order:new', () => {
    console.log('handler A received an order');
});
await pubsub.subscribe('order:new', () => {
    console.log('handler B received an order');
});
await pubsub.psubscribe('audit:*', () => {
    console.log('audit handler');
});

// Inspect active subscriptions (no prefix in the returned names)
const { channels, patterns } = pubsub.activeSubscriptions();
console.log(channels); // ['order:new']
console.log(patterns); // ['audit:*']

// Publishing fans out to every handler registered for the channel
const receivers = await pubsub.publish('order:new', { orderId: 1 });
console.log(receivers); // 2

// unsubscribe() removes all handlers for the channel
await pubsub.unsubscribe('order:new');
await pubsub.punsubscribe('audit:*');

console.log(pubsub.activeSubscriptions()); // { channels: [], patterns: [] }

await pubsub.shutdown();
```

- On Redis, a channel is subscribed once per process (`SUBSCRIBE` is sent on the first handler) and shared by all local handlers.
- `shutdown()` unsubscribes everything and closes connections; handler maps are cleared.

### Registering providers with WebAFX

Inside a WebAFX application, register a provider with a plugin factory in a single call. The plugin registers the provider as an application-wide singleton service (one instance for the whole app, never per-request), wires `health()` into the health endpoint, and wires `shutdown()` into graceful shutdown.

The simplest variant uses the in-memory backend:

```typescript fragment
import { memoryCachePlugin, memoryPubSubPlugin } from 'blendsdk/webafx-cache';

app.use(memoryCachePlugin({ rootKey: 'MyApp', defaultTTL: 300 }));
app.use(memoryPubSubPlugin({ channelPrefix: 'MyApp' }));
```

The Redis variants — the pub/sub plugin additionally supports declarative subscriptions registered at install time:

```typescript fragment
import { redisCachePlugin, redisPubSubPlugin } from 'blendsdk/webafx-cache';

app.use(redisCachePlugin({
    rootKey: 'MyApp',
    host: 'localhost',
    port: 6379,
    defaultTTL: 300,
}));

app.use(redisPubSubPlugin(
    { host: 'localhost', port: 6379, channelPrefix: 'MyApp' },
    {
        subscriptions: [
            { channel: 'order:created', handler: handleNewOrder },
            { pattern: 'audit:*', handler: handleAuditEvent },
        ],
    }
));
```

For custom or pre-built provider instances — including your own `CacheProvider` subclasses — use the generic builders, which also accept a plugin `priority` (default `30`, lower installs earlier):

```typescript fragment
import { MemoryCacheProvider, createCachePlugin } from 'blendsdk/webafx-cache';

const sessionCache = new MemoryCacheProvider({
    rootKey: 'Sessions',
    serviceName: 'session-cache',
});

app.use(createCachePlugin(sessionCache, { priority: 20 }));
```

- The service name comes from `provider.serviceName` (`'cache'` or `'pubsub'` by default).
- Register multiple independent providers by giving each a distinct `serviceName` (e.g. `'session-cache'` and `'product-cache'`).
- `createPubSubPlugin(provider, options?)` is the pub/sub counterpart of `createCachePlugin()`.

### Switching backends at runtime

`createCache()` and `createPubSub()` build the right provider from a single config object with a `type` discriminator — the standard pattern for "Redis in production, memory everywhere else":

```typescript
import { createCache } from 'blendsdk/webafx-cache';

const cache = createCache({
    type: process.env.NODE_ENV === 'production' ? 'redis' : 'memory',
    rootKey: 'MyApp',
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT ?? 6379),
    defaultTTL: 300,
});

await cache.set('feature:enabled', true);
console.log(await cache.get<boolean>('feature:enabled')); // true

await cache.shutdown();
```

```typescript
import { createPubSub } from 'blendsdk/webafx-cache';

const pubsub = createPubSub({
    type: process.env.NODE_ENV === 'production' ? 'redis' : 'memory',
    channelPrefix: 'MyApp',
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT ?? 6379),
});

await pubsub.subscribe<string>('greet', (message) => {
    console.log(message.data); // 'hello'
});

await pubsub.publish('greet', 'hello');

await pubsub.shutdown();
```

Both factories return plain provider instances — use them directly or pass them to `createCachePlugin()` / `createPubSubPlugin()`. Any `type` other than `'redis'` or `'memory'` throws a descriptive error (see below).

### Importing the Redis-free memory entry point

If you only need in-memory providers — tests, local development, single-instance deployments — import from the `/memory` subpath. It exposes the same provider classes and plugin builders, but never loads `ioredis`:

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache/memory';

const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });

await cache.set('key', 'value');
console.log(await cache.get<string>('key')); // 'value'

await cache.shutdown();
```

```typescript fragment
import { memoryCachePlugin, memoryPubSubPlugin } from 'blendsdk/webafx-cache/memory';

app.use(memoryCachePlugin({ rootKey: 'MyApp' }));
app.use(memoryPubSubPlugin({ channelPrefix: 'MyApp' }));
```

The subpath exports: `CacheProvider`, `PubSubProvider`, `MemoryCacheProvider`, `MemoryPubSubProvider`, `createCachePlugin`, `createPubSubPlugin`, `memoryCachePlugin`, `memoryPubSubPlugin`, and the memory/plugin configuration types.

---

## Configuration

All configuration is passed as plain objects. Only `rootKey` (cache providers) and `type` (factories) are required — every other field has a default.

### Cache provider options

Base options shared by `MemoryCacheProvider` and `RedisCacheProvider` (`CacheProviderConfig`):

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `rootKey` | `string` | — (required) | Namespace prefix for every key (`'MyApp'` → `MyApp:user:123`). Missing, empty, or whitespace-only values throw. |
| `serviceName` | `string` | `'cache'` | Service name used when the provider is registered in WebAFX. |
| `defaultTTL` | `number` | `0` | Default TTL in seconds applied by `set()` when no explicit TTL is passed. `0` = no expiry. |

Additional option for `MemoryCacheProvider` (`MemoryCacheConfig`):

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `cleanupIntervalMs` | `number` | `60000` | Interval (ms) for sweeping expired entries from the store. `0` disables the periodic sweep — expired entries are still evicted lazily on access. |

### Pub/Sub provider options

Base options shared by `MemoryPubSubProvider` and `RedisPubSubProvider` (`PubSubProviderConfig`):

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `channelPrefix` | `string` | `undefined` | Prefix applied to every channel (`'MyApp'` → `MyApp:order:new`). Omit for unprefixed channels. |
| `serviceName` | `string` | `'pubsub'` | Service name used when the provider is registered in WebAFX. |

### Redis connection options (shared)

`RedisCacheProvider` and `RedisPubSubProvider` extend their base config with the shared Redis connection options (`RedisConnectionConfig`):

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `host` | `string` | `'localhost'` | Redis host. |
| `port` | `number` | `6379` | Redis port. |
| `password` | `string` | `undefined` | Redis password, if the server requires one. |
| `db` | `number` | `0` | Redis database index. |
| `url` | `string` | `undefined` | Connection URL (e.g. `redis://…`). When set, takes precedence over `host`/`port`/`password`/`db`. |
| `connectTimeout` | `number` | `5000` | Connection timeout in milliseconds. |
| `maxRetriesPerRequest` | `number` | `3` | Maximum retries per request. |

Note: `RedisPubSubProvider` creates **two** connections from this configuration — one for `PUBLISH`, one for `SUBSCRIBE`/`PSUBSCRIBE`, as Redis requires a dedicated subscriber connection.

### Factory options

`createCache()` — `CacheFactoryConfig`:

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `type` | `'redis' \| 'memory'` | — (required) | Backend discriminator. Any other value throws. |
| `rootKey` | `string` | — (required) | Passed to the created provider. |
| `serviceName` | `string` | `'cache'` | Passed to the created provider. |
| `defaultTTL` | `number` | `0` | Passed to the created provider. |
| `host`, `port`, `password`, `db`, `url` | see Redis table | Redis defaults | Only used when `type` is `'redis'`. |
| `cleanupIntervalMs` | `number` | `60000` | Only used when `type` is `'memory'`. |

`createPubSub()` — `PubSubFactoryConfig`:

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `type` | `'redis' \| 'memory'` | — (required) | Backend discriminator. Any other value throws. |
| `channelPrefix` | `string` | `undefined` | Passed to the created provider. |
| `serviceName` | `string` | `'pubsub'` | Passed to the created provider. |
| `host`, `port`, `password`, `db`, `url` | see Redis table | Redis defaults | Only used when `type` is `'redis'`. |

### Plugin options

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `priority` | `number` | `30` | Plugin installation priority (lower installs earlier). Available on `createCachePlugin(provider, options)` and `createPubSubPlugin(provider, options)`. |
| `subscriptions` | `SubscriptionDefinition[]` | `undefined` | Pub/sub only: declarative subscriptions registered at plugin install time. |

Each `SubscriptionDefinition` entry:

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `channel` | `string` | `undefined` | Subscribe to an exact channel. Mutually exclusive with `pattern`. |
| `pattern` | `string` | `undefined` | Subscribe to a glob pattern (`*`, `?`). Mutually exclusive with `channel`. |
| `handler` | `MessageHandler<T>` | — (required) | Called for every matching message; sync or async. |

### Constants

All constants are importable from the package root:

```typescript fragment
import {
    DEFAULT_SERVICE_NAME,
    DEFAULT_TTL,
    KEY_SEPARATOR,
    DEFAULT_PUBSUB_SERVICE_NAME,
    CHANNEL_SEPARATOR,
} from 'blendsdk/webafx-cache';
```

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_SERVICE_NAME` | `'cache'` | Default cache service name. |
| `DEFAULT_TTL` | `0` | Default TTL (no expiry). |
| `KEY_SEPARATOR` | `':'` | Separator between `rootKey` and the user key. |
| `DEFAULT_PUBSUB_SERVICE_NAME` | `'pubsub'` | Default pub/sub service name. |
| `CHANNEL_SEPARATOR` | `':'` | Separator between `channelPrefix` and the channel. |

---

## Error Handling

### Error model

The package has no custom error classes — it keeps its error surface deliberately small:

- **Configuration errors** are thrown **synchronously** as plain `Error` objects (invalid `rootKey`, unknown `type` in a factory).
- **Backend errors** (Redis connection refused, timeouts, closed connections) reject the returned promise of the operation — standard `ioredis` behavior.
- **Serialization errors** reject with the native `TypeError` from `JSON.stringify()` when a value cannot be serialized.
- Everything else **degrades safely** — cache misses, parse failures, and pub/sub handler errors are never thrown at you.

### Errors thrown by the package

| Message / error | Thrown by | When |
|-----------------|-----------|------|
| `CacheProvider: rootKey is required and cannot be empty` | Cache provider constructors (`new MemoryCacheProvider()`, `new RedisCacheProvider()`) | `rootKey` is missing, empty, or whitespace-only — synchronous |
| `Unknown cache type: "<value>". Supported types: "redis", "memory".` | `createCache()` | `type` is not `'redis'` or `'memory'` — synchronous |
| `Unknown pub/sub type: "<value>". Supported types: "redis", "memory".` | `createPubSub()` | `type` is not `'redis'` or `'memory'` — synchronous |
| `ioredis` errors (connection refused, timeouts, `Connection is closed.`) | Any Redis operation (`set`, `get`, `deletePattern`, `publish`, …) | Backend unreachable or connection already closed — rejects the promise |
| `TypeError` from `JSON.stringify()` | `set()`, `getOrSet()` on a miss, `publish()` | Value/payload is not JSON-serializable (circular reference, `BigInt`) — rejects the promise |

### Behavior that never throws

| Scenario | Behavior |
|----------|----------|
| Cache miss or expired entry | `get()` resolves `undefined` |
| Stored JSON cannot be parsed | Treated as a miss — `get()` resolves `undefined` |
| Redis unavailable during `health()` | Resolves `false` (never rejects) |
| `deletePattern()` matches nothing | Resolves `0` |
| `publish()` with no subscribers | Resolves `0` |
| Pub/sub handler throws or rejects | Caught and logged via `console.error`; other handlers still receive the message |
| Received pub/sub message fails to parse | Logged; the message is dropped |

### Example: configuration errors

Configuration mistakes surface immediately — wrap provider/factory creation in `try`/`catch` when config comes from outside your type system:

```typescript
import { createCache, MemoryCacheProvider } from 'blendsdk/webafx-cache';

// 1. Provider configuration errors are thrown synchronously
try {
    const cache = new MemoryCacheProvider({ rootKey: '' });
    console.log(cache.serviceName);
} catch (error) {
    if (error instanceof Error) {
        console.error(error.message);
        // 'CacheProvider: rootKey is required and cannot be empty'
    }
}

// 2. Factory configuration errors too — here with an invalid type
//    (simulating a value arriving from an untyped configuration source)
try {
    const cache = createCache({ type: 'postgres' as 'redis', rootKey: 'MyApp' });
    console.log(cache.serviceName);
} catch (error) {
    if (error instanceof Error) {
        console.error(error.message);
        // 'Unknown cache type: "postgres". Supported types: "redis", "memory".'
    }
}
```

### Example: backend errors (Redis)

Redis operations reject when the server is unreachable. Catch around them and degrade gracefully — continue serving requests without the cache:

```typescript
import { RedisCacheProvider } from 'blendsdk/webafx-cache';

const cache = new RedisCacheProvider({ rootKey: 'MyApp', host: 'localhost', port: 6379 });

try {
    // A cache miss is not an error — but an unreachable server rejects the operation
    await cache.set('user:123', { name: 'Alice' });
    const user = await cache.get<{ name: string }>('user:123');
    console.log(user?.name); // 'Alice'
} catch (error) {
    if (error instanceof Error) {
        console.error('Cache operation failed:', error.message);
    }
} finally {
    try {
        await cache.shutdown();
    } catch {
        // The connection may already be closed
    }
}
```

For a non-throwing probe, use `health()` — it resolves `false` instead of rejecting:

```typescript fragment
if (!(await cache.health())) {
    console.error('Cache backend is not available — continuing without cache');
}
```

### Example: pub/sub handler errors

Handler errors are isolated per handler. A throwing handler is caught and logged by the provider; every other handler still receives the message:

```typescript
import { MemoryPubSubProvider } from 'blendsdk/webafx-cache';

const pubsub = new MemoryPubSubProvider({ channelPrefix: 'MyApp' });

await pubsub.subscribe('order:new', () => {
    throw new Error('handler failed');
});

await pubsub.subscribe('order:new', (message) => {
    console.log('still delivered:', message.channel); // 'still delivered: order:new'
});

// The provider logs '[PubSub] Handler error on channel "order:new": handler failed'
// and continues — the second handler above is still invoked.
await pubsub.publish('order:new', { orderId: 1 });

await pubsub.shutdown();
```

Async handler rejections are handled the same way — wrap handler logic in your own `try`/`catch` only if you need custom reporting or retry behavior inside a handler.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
