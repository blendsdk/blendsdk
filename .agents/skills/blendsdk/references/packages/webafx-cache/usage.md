> **Package**: `blendsdk/webafx-cache`

# webafx-cache Core Concepts

This document is a deep dive into the building blocks of `blendsdk/webafx-cache`: the two abstract provider contracts, their four concrete backends, the message types, the configuration surface, and the WebAFX plugin layer. Each section explains **what the concept is**, **how it works**, shows a **complete runnable example**, and lists the **key methods and properties**. For the high-level picture, see the webafx-cache Overview for LLMs.

---

## CacheProvider — The Abstract Cache Contract

### What It Is

`CacheProvider` is the abstract base class that every cache backend in the package extends. It defines the complete cache contract — a Redis-like, fully async API (`set`, `get`, `delete`, `exists`, `expire`, `ttl`, `deletePattern`, `clear`, `health`, `shutdown`) plus the cache-aside helper `getOrSet()` — and implements everything that is identical for all backends: namespace prefixing via `rootKey`, TTL resolution with a `defaultTTL` fallback, configuration validation, and the service name used for WebAFX registration. Concrete providers (`MemoryCacheProvider`, `RedisCacheProvider`) only implement the abstract storage methods.

### How It Works

- **Construction and validation** — the constructor requires a non-empty `rootKey` and throws `CacheProvider: rootKey is required and cannot be empty` otherwise. It also fixes the provider's identity: `serviceName` (default `'cache'`, via `DEFAULT_SERVICE_NAME`) and `defaultTTL` (default `0` = no expiry, via `DEFAULT_TTL`).
- **Namespacing** — every operation passes its key through `buildKey()`, which returns `rootKey + KEY_SEPARATOR + key` (for example, `MyApp:user:123`). `buildPattern()` prefixes patterns for `deletePattern()`/`clear()` the same way, so two providers with different `rootKey` values can share one backend without key collisions.
- **TTL resolution** — `resolveTTL(ttlSeconds?)` returns `ttlSeconds` when given, otherwise `defaultTTL`, and collapses anything `<= 0` to `undefined`, which tells the backend "no expiry". This is why an explicit `0` overrides a non-zero `defaultTTL`.
- **Cache-aside** — `getOrSet()` is the only operation implemented in the base class, because its logic is backend-independent: try `get()`; on a hit, return the cached value; on a miss, await the factory, `set()` the result with the resolved TTL, and return it.
- **JSON serialization** — values are stored as JSON. Both backends serialize on write and deserialize on read, so the retrieved value is always a structural copy (standard JSON round-trip semantics, no shared references).
- **Uniform async API** — all ten abstract methods return promises; there is no synchronous variant, and the Redis and memory backends satisfy identical semantics (verified by shared contract suites — see Testing Strategy).
- **Application-wide singleton** — a provider is designed to be created once per application (or per concern), not per request.

### Complete Example

```typescript
import { CacheProvider, MemoryCacheProvider } from "blendsdk/webafx-cache";

interface UserProfile {
    id: string;
    displayName: string;
}

// Any CacheProvider implementation can be passed here — Redis or In-Memory
async function loadProfile(cache: CacheProvider, userId: string): Promise<UserProfile> {
    return cache.getOrSet<UserProfile>(
        `user:${userId}`,
        async () => ({ id: userId, displayName: `User ${userId}` }),
        120
    );
}

async function main(): Promise<void> {
    const cache = new MemoryCacheProvider({
        rootKey: "MyApp",
        serviceName: "user-cache",
        defaultTTL: 60,
    });

    console.log(cache.serviceName); // "user-cache"

    const profile = await loadProfile(cache, "42");
    console.log(profile.displayName); // "User 42"

    // Second call is a cache hit — the factory runs only once
    const cached = await loadProfile(cache, "42");
    console.log(cached.id); // "42"

    // The key "user:42" is stored internally as "MyApp:user:42"
    console.log(await cache.exists("user:42")); // true

    await cache.shutdown();

    // Constructor validation: rootKey must be a non-empty string
    try {
        new MemoryCacheProvider({ rootKey: "   " });
    } catch (error) {
        if (error instanceof Error) {
            console.log(error.message); // "CacheProvider: rootKey is required and cannot be empty"
        }
    }
}

await main();
```

### Key Methods and Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `serviceName` | `string` (getter) | Service container name; defaults to `'cache'`. |
| `rootKey` | `protected string` | Namespace prefix applied to every key. |
| `defaultTTL` | `protected number` | Fallback TTL in seconds; `0` means no expiry. |
| `constructor` | `(config: CacheProviderConfig)` | Validates `rootKey`; throws on empty/whitespace. |
| `buildKey` | `protected (key: string) => string` | Prefixes a key: `rootKey + ":" + key`. |
| `buildPattern` | `protected (pattern: string) => string` | Prefixes a pattern the same way. |
| `resolveTTL` | `protected (ttlSeconds?: number) => number \| undefined` | `ttlSeconds ?? defaultTTL`; values `<= 0` become `undefined`. |
| `getOrSet<T>` | `(key: string, factory: () => Promise<T>, ttlSeconds?: number) => Promise<T>` | Cache-aside: cached value, or run factory, store, and return its result. |
| `set<T>` *(abstract)* | `(key: string, value: T, ttlSeconds?: number) => Promise<void>` | JSON-serialize and store a value. |
| `get<T>` *(abstract)* | `(key: string) => Promise<T \| undefined>` | Deserialized value, or `undefined` on miss/expiry. |
| `delete` *(abstract)* | `(key: string) => Promise<boolean>` | `true` if the key existed and was removed. |
| `exists` *(abstract)* | `(key: string) => Promise<boolean>` | `true` if the key exists and is not expired. |
| `expire` *(abstract)* | `(key: string, ttlSeconds: number) => Promise<boolean>` | Replace the TTL without touching the value. |
| `ttl` *(abstract)* | `(key: string) => Promise<number>` | Remaining seconds; `-1` no expiry; `-2` missing. |
| `deletePattern` *(abstract)* | `(pattern: string) => Promise<number>` | Deletes matching keys (`*` wildcard); returns the count. |
| `clear` *(abstract)* | `() => Promise<void>` | Deletes all keys in this `rootKey` namespace only. |
| `health` *(abstract)* | `() => Promise<boolean>` | Backend liveness probe. |
| `shutdown` *(abstract)* | `() => Promise<void>` | Releases connections/resources. |

---

## MemoryCacheProvider — In-Process Caching

### What It Is

`MemoryCacheProvider` is the zero-dependency, in-process cache backend. It stores JSON-serialized entries in a `Map`, emulates Redis semantics for TTL and pattern operations so it is a drop-in replacement for `RedisCacheProvider` in development, tests, and single-instance deployments, and needs neither Redis nor Docker.

### How It Works

- **Storage** — each entry is stored as `{ value: <JSON string>, expiresAt: <ms timestamp | undefined> }` under the prefixed key. `set()` serializes with `JSON.stringify()` and converts the TTL into an absolute `expiresAt` timestamp; `get()` deserializes with `JSON.parse()`, so callers receive fresh copies (`JSON.parse` failures are treated as a cache miss).
- **Two-phase expiry** — lazy eviction on every access (`get`, `exists`, `ttl`, `expire` treat an expired entry as a miss and delete it), plus a periodic cleanup timer (`cleanupIntervalMs`, default `60_000`) that reclaims expired entries nobody has touched. The timer is created with `.unref()`, so it never keeps the Node.js process alive; `cleanupIntervalMs: 0` disables it entirely.
- **Redis-compatible TTL reporting** — `ttl()` returns `-2` for a missing (or expired) key, `-1` for a key without expiry, and the remaining seconds (rounded up) otherwise.
- **Pattern deletion** — `deletePattern()` translates the pattern into a regular expression; only `*` is a wildcard, and all other characters (including `?`) are matched literally.
- **Namespace-scoped clear** — `clear()` deletes only keys under this provider's `rootKey + ":"` prefix; other providers' namespaces in the same process are unaffected.
- **Lifecycle** — `health()` always returns `true` (the store lives inside the process); `shutdown()` stops the cleanup timer and empties the store.

### Complete Example

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

interface Session {
    userId: string;
    roles: string[];
}

async function main(): Promise<void> {
    const cache = new MemoryCacheProvider({
        rootKey: "MyApp",
        defaultTTL: 60,
        cleanupIntervalMs: 10_000,
    });

    await cache.set<Session>("session:abc", { userId: "u-1", roles: ["admin"] });
    const session = await cache.get<Session>("session:abc");
    console.log(session?.roles); // ["admin"]

    // TTL introspection follows Redis conventions
    console.log(await cache.ttl("session:abc")); // ~60 — remaining seconds
    await cache.expire("session:abc", 5);
    console.log(await cache.ttl("session:abc")); // ~5

    // deletePattern only touches keys under "MyApp:session:"
    await cache.set<Session>("session:def", { userId: "u-2", roles: [] });
    console.log(await cache.deletePattern("session:*")); // 2

    // clear() removes only this provider's namespace
    await cache.set("flag:beta", true);
    await cache.clear();
    console.log(await cache.exists("flag:beta")); // false

    await cache.shutdown();
}

await main();
```

### Key Methods and Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `store` | `protected Map<string, MemoryCacheEntry>` | Prefixed key → `{ value: string; expiresAt: number \| undefined }`. |
| `cleanupIntervalMs` | `protected number` | Cleanup timer period; default `60000`; `<= 0` disables cleanup. |
| `cleanupInterval` | `protected ReturnType<typeof setInterval> \| undefined` | Handle of the unref'd cleanup timer. |
| `constructor` | `(config: MemoryCacheConfig)` | Runs base validation, then starts the cleanup timer. |
| `set<T>` | `(key: string, value: T, ttlSeconds?: number) => Promise<void>` | `JSON.stringify` + absolute `expiresAt` computation. |
| `get<T>` | `(key: string) => Promise<T \| undefined>` | Lazily evicts expired entries; parse failure → `undefined`. |
| `delete` | `(key: string) => Promise<boolean>` | Deletes from the internal map. |
| `exists` | `(key: string) => Promise<boolean>` | Lazy expiry check. |
| `expire` | `(key: string, ttlSeconds: number) => Promise<boolean>` | Recomputes `expiresAt`; `false` if missing/expired. |
| `ttl` | `(key: string) => Promise<number>` | `-2` missing/expired; `-1` no expiry; else remaining seconds (rounded up). |
| `deletePattern` | `(pattern: string) => Promise<number>` | Glob (`*`) → regex; returns the deleted count. |
| `clear` | `() => Promise<void>` | Deletes keys starting with `rootKey + ":"`. |
| `health` | `() => Promise<boolean>` | Always `true`. |
| `shutdown` | `() => Promise<void>` | Stops the cleanup timer and clears the store. |
| `patternToRegex` | `protected (pattern: string) => RegExp` | Escapes regex specials, converts `*` to `.*`. |
| `startCleanup` | `protected () => void` | Creates the interval and calls `.unref()` on it. |

---

## RedisCacheProvider — Redis-Backed Caching

### What It Is

`RedisCacheProvider` is the production, Redis-backed cache implementation built on `ioredis`. It maps every `CacheProvider` operation onto native Redis commands (with automatic JSON serialization and `rootKey` prefixing), so keys created by different applications or concerns never collide in a shared Redis instance.

### How It Works

- **Connection** — the constructor creates an `ioredis` client immediately (connecting in the background; commands are queued until ready). A `url` in the config takes precedence over `host`/`port`/`password`/`db`; defaults are `localhost`, `6379`, db `0`, connect timeout `5000 ms`, and `3` retries per request.
- **Core commands** — `set()` issues `SET key value` and adds the `EX <seconds>` flag when an effective TTL exists; `get()` issues `GET` and JSON-parses the reply, treating a parse failure as a cache miss (matching the memory provider).
- **TTL and existence** — `delete()`, `exists()`, `expire()`, and `ttl()` map directly to the Redis commands of the same name, including their conventions: `EXPIRE` reports whether the key existed, and `TTL` returns `-1` (no expiry) or `-2` (missing).
- **Production-safe invalidation** — `deletePattern()` and `clear()` never use the blocking `KEYS` command. They iterate with `SCAN` (`MATCH` pattern, `COUNT 100`) and delete each batch with one multi-key `DEL`.
- **Lifecycle** — `health()` sends `PING` and returns `true` only for `PONG` (any error, including a closed connection, yields `false`); `shutdown()` calls `quit()` for a graceful disconnect that waits for pending commands.

### Complete Example

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";

interface Product {
    sku: string;
    price: number;
}

async function main(): Promise<void> {
    // Requires a reachable Redis instance (localhost:6379 by default)
    const cache = new RedisCacheProvider({
        rootKey: "MyApp",
        host: "localhost",
        port: 6379,
        defaultTTL: 300,
    });

    console.log(await cache.health()); // true once connected

    await cache.set<Product>("product:SKU-1", { sku: "SKU-1", price: 19.99 }, 600);
    const product = await cache.get<Product>("product:SKU-1");
    console.log(product?.price); // 19.99

    // Stored in Redis as the key "MyApp:product:SKU-1"
    console.log(await cache.ttl("product:SKU-1")); // ~600

    // SCAN-based invalidation — safe for production, never uses KEYS
    console.log(await cache.deletePattern("product:*")); // 1

    await cache.shutdown();
}

await main();
```

### Key Methods and Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `client` | `protected Redis` | The ioredis connection; created in the constructor. |
| `constructor` | `(config: RedisCacheConfig)` | `url` precedence; defaults `localhost`, `6379`, db `0`, timeout `5000`, `3` retries. |
| `set<T>` | `(key: string, value: T, ttlSeconds?: number) => Promise<void>` | `SET` with optional `EX` flag. |
| `get<T>` | `(key: string) => Promise<T \| undefined>` | `GET` + `JSON.parse`; parse failure → cache miss. |
| `delete` | `(key: string) => Promise<boolean>` | `DEL`; `true` when one key was removed. |
| `exists` | `(key: string) => Promise<boolean>` | `EXISTS`. |
| `expire` | `(key: string, ttlSeconds: number) => Promise<boolean>` | `EXPIRE`. |
| `ttl` | `(key: string) => Promise<number>` | `TTL` with native `-1`/`-2` conventions. |
| `deletePattern` | `(pattern: string) => Promise<number>` | `SCAN MATCH ... COUNT 100` + batched `DEL`. |
| `clear` | `() => Promise<void>` | `scanAndDelete("rootKey:*")`. |
| `health` | `() => Promise<boolean>` | `PING` must answer `PONG`; errors → `false`. |
| `shutdown` | `() => Promise<void>` | `quit()` — graceful, waits for pending commands. |
| `scanAndDelete` | `protected (pattern: string) => Promise<number>` | Cursor loop over `SCAN`, deleting each batch as found. |

---

## PubSubProvider — The Abstract Pub/Sub Contract

### What It Is

`PubSubProvider` is the abstract base class for the pub/sub half of the package — a hierarchy deliberately independent from `CacheProvider`. It defines a typed, JSON-serialized messaging contract (exact-channel and glob-pattern subscriptions, publish with receiver count, subscription introspection, health, shutdown) and implements the shared concerns: channel prefixing and prefix stripping, the `serviceName` used for WebAFX registration, and `safeInvoke()` handler error isolation.

### How It Works

- **Configuration** — the constructor accepts an optional `channelPrefix` and stores `serviceName` (default `'pubsub'`, via `DEFAULT_PUBSUB_SERVICE_NAME`).
- **Channel prefixing** — when a prefix is set, `buildChannel()` stores channels as `prefix:channel` and `buildChannelPattern()` does the same for patterns; without a prefix, names pass through unchanged. This lets multiple applications share one Redis instance safely.
- **Prefix stripping** — `stripPrefix()` reverses the transformation before delivery, so handlers and `activeSubscriptions()` always see user-facing channel and pattern names. Application code never deals with the internal prefix.
- **Error isolation** — `safeInvoke()` wraps every handler invocation in a try/catch. Synchronous throws and rejected promises are logged (`[PubSub] Handler error on channel "..."`) and swallowed; one failing handler can never break other subscribers or the subscriber connection.
- **Uniform async API** — `publish<T>()` returns the number of receivers, `subscribe()`/`unsubscribe()` manage exact channels, and `psubscribe()`/`punsubscribe()` manage glob patterns. `activeSubscriptions()` is the one synchronous method and returns `{ channels, patterns }` with prefix-stripped names.
- **Application-wide singleton** — like `CacheProvider`, a provider is created once per application and registered by `serviceName`; multiple independent pub/sub providers can coexist under different service names.

### Complete Example

```typescript
import { MemoryPubSubProvider, PubSubProvider } from "blendsdk/webafx-cache";

interface OrderEvent {
    orderId: string;
    total: number;
}

// Any PubSubProvider implementation can be passed here — Redis or In-Memory
async function publishOrder(pubsub: PubSubProvider, event: OrderEvent): Promise<void> {
    const receivers = await pubsub.publish<OrderEvent>("order:created", event);
    console.log(`delivered to ${receivers} handler(s)`);
}

async function main(): Promise<void> {
    const pubsub = new MemoryPubSubProvider({ channelPrefix: "MyApp" });

    await pubsub.subscribe<OrderEvent>("order:created", (message) => {
        console.log(`[${message.channel}] ${message.data.orderId} = ${message.data.total}`);
    });

    // A failing handler is logged and isolated — other subscribers still receive the message
    await pubsub.subscribe<OrderEvent>("order:created", () => {
        throw new Error("intentional handler failure");
    });

    await publishOrder(pubsub, { orderId: "o-1", total: 49.99 });
    // Console output (in order):
    //   [order:created] o-1 = 49.99
    //   [PubSub] Handler error on channel "order:created": intentional handler failure   (via console.error)
    //   delivered to 2 handler(s)

    // Channels are always reported without the internal prefix
    console.log(pubsub.activeSubscriptions().channels); // ["order:created"]

    await pubsub.shutdown();
}

await main();
```

### Key Methods and Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `serviceName` | `string` (getter) | Service container name; defaults to `'pubsub'`. |
| `channelPrefix` | `protected string \| undefined` | Namespace prefix for channels/patterns; applied only when set. |
| `constructor` | `(config: PubSubProviderConfig)` | Stores prefix and service name; all async APIs are per-operation. |
| `buildChannel` | `protected (channel: string) => string` | Prefixes an exact channel name. |
| `buildChannelPattern` | `protected (pattern: string) => string` | Prefixes a glob pattern. |
| `stripPrefix` | `protected (fullChannel: string) => string` | Removes the prefix before delivery/introspection. |
| `safeInvoke` | `protected async (handler: MessageHandler<T>, message: PubSubMessage<T>) => Promise<void>` | Catches and logs handler errors; never rethrows. |
| `publish<T>` *(abstract)* | `(channel: string, data: T) => Promise<number>` | JSON-serialize and send; returns the receiver count. |
| `subscribe<T>` *(abstract)* | `(channel: string, handler: MessageHandler<T>) => Promise<void>` | Register a handler for an exact channel. |
| `unsubscribe` *(abstract)* | `(channel: string) => Promise<void>` | Remove all handlers for a channel. |
| `psubscribe<T>` *(abstract)* | `(pattern: string, handler: MessageHandler<T>) => Promise<void>` | Register a handler for a glob pattern. |
| `punsubscribe` *(abstract)* | `(pattern: string) => Promise<void>` | Remove all handlers for a pattern. |
| `activeSubscriptions` *(abstract)* | `() => { channels: string[]; patterns: string[] }` | Synchronous snapshot with prefix-stripped names. |
| `health` *(abstract)* | `() => Promise<boolean>` | Backend liveness probe. |
| `shutdown` *(abstract)* | `() => Promise<void>` | Unsubscribe all and release resources. |

---

## MemoryPubSubProvider — In-Process Messaging

### What It Is

`MemoryPubSubProvider` is the in-process pub/sub backend. It keeps handler registries in `Map`s and delivers messages within the same Node.js process — no network, no external dependencies — while matching Redis behavior (JSON round-trip, pattern semantics, error isolation) closely enough to be a drop-in replacement in development and tests.

### How It Works

- **Handler registries** — two maps: `handlers` (user channel → `Set<MessageHandler>`) and `patternHandlers` (user pattern → `Set<MessageHandler>`). Using `Set`s deduplicates identical handler references.
- **JSON round-trip** — `publish()` serializes the payload with `JSON.stringify()` and immediately parses it back, mirroring what Redis does over the wire. Handlers always receive a fresh, JSON-safe copy, and non-serializable payloads fail fast at the call site.
- **Fan-out and receiver count** — delivery goes to all exact-channel handlers first, then to every pattern whose glob matches; pattern deliveries include the matched `pattern` in the envelope. The return value is the total number of handlers invoked (exact + pattern).
- **Glob matching** — `matchGlob()` converts the pattern to a regex: `*` matches any sequence of characters and `?` matches exactly one; all other regex-special characters are escaped, so channel names can never inject regex syntax.
- **Error isolation** — invocations go through `safeInvoke()`, so a throwing (or rejecting) handler is logged and skipped without affecting others.
- **Prefix transparency** — routing happens in-process by user-facing names; a configured `channelPrefix` does not change the names handlers or `activeSubscriptions()` observe.
- **Lifecycle** — `health()` always returns `true`; `shutdown()` clears both handler maps.

### Complete Example

```typescript
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";

interface AuditEvent {
    actor: string;
    action: string;
}

async function main(): Promise<void> {
    const pubsub = new MemoryPubSubProvider({ channelPrefix: "MyApp" });

    await pubsub.psubscribe<AuditEvent>("audit:*", (message) => {
        console.log(`[${message.pattern}] ${message.channel} by ${message.data.actor}`);
    });

    await pubsub.subscribe<AuditEvent>("audit:login", (message) => {
        console.log(`exact handler: ${message.data.action}`);
    });

    const receivers = await pubsub.publish<AuditEvent>("audit:login", {
        actor: "alice",
        action: "signed in",
    });
    console.log(receivers); // 2 — one exact handler + one pattern handler

    const subs = pubsub.activeSubscriptions();
    console.log(subs.channels); // ["audit:login"]
    console.log(subs.patterns); // ["audit:*"]

    await pubsub.shutdown();
}

await main();
```

### Key Methods and Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `handlers` | `protected Map<string, Set<MessageHandler>>` | Exact-channel handlers, keyed by user-facing channel. |
| `patternHandlers` | `protected Map<string, Set<MessageHandler>>` | Pattern handlers, keyed by user-facing pattern. |
| `constructor` | `(config?: MemoryPubSubConfig)` | Config is optional; all defaults apply. |
| `publish<T>` | `(channel: string, data: T) => Promise<number>` | JSON round-trip; delivers to exact + matching pattern handlers; returns total invoked. |
| `subscribe<T>` | `(channel: string, handler: MessageHandler<T>) => Promise<void>` | Adds to the channel's handler `Set`. |
| `unsubscribe` | `(channel: string) => Promise<void>` | Removes all handlers for the channel. |
| `psubscribe<T>` | `(pattern: string, handler: MessageHandler<T>) => Promise<void>` | Glob pattern; supports `*` and `?`. |
| `punsubscribe` | `(pattern: string) => Promise<void>` | Removes all handlers for the pattern. |
| `activeSubscriptions` | `() => { channels: string[]; patterns: string[] }` | Synchronous snapshot of registered names. |
| `health` | `() => Promise<boolean>` | Always `true`. |
| `shutdown` | `() => Promise<void>` | Clears both handler maps. |
| `matchGlob` | `protected (channel: string, pattern: string) => boolean` | Glob → regex matching with escaping. |

---

## RedisPubSubProvider — Redis-Backed Messaging

### What It Is

`RedisPubSubProvider` is the production pub/sub implementation. Because a Redis connection that has entered subscriber mode cannot run regular commands, the provider opens two dedicated ioredis connections — a `publisher` for `PUBLISH` and a `subscriber` for `SUBSCRIBE`/`PSUBSCRIBE` — and routes incoming messages to in-process handlers.

### How It Works

- **Two connections** — the constructor creates both clients immediately (same URL-vs-host/port precedence and defaults as `RedisCacheProvider`) and wires two ioredis events on the subscriber: `message` for exact channels and `pmessage` for patterns.
- **Subscribe-once semantics** — `subscribe()`/`psubscribe()` first add the handler to a local `Map<userChannel, Set<MessageHandler>>` and only issue the Redis `SUBSCRIBE`/`PSUBSCRIBE` (with the prefixed name) when the **first** handler for that channel/pattern registers. Multiple in-process handlers therefore share a single Redis subscription and fan out in-process when a message arrives.
- **Unsubscribing** — `unsubscribe()`/`punsubscribe()` send the Redis unsubscribe command and remove all local handlers for that channel/pattern.
- **Publishing** — `publish()` sends the JSON-serialized payload over the publisher connection to the prefixed channel and returns the receiver count reported by Redis — the number of subscriptions (not local handlers) that received the message.
- **Incoming routing** — each event strips the channel prefix, looks up the handlers under the user-facing name, JSON-parses the payload (parse failures are logged and dropped), and fans out through `safeInvoke()`. Pattern deliveries carry the stripped `pattern` in the envelope.
- **Lifecycle** — `health()` pings both connections and returns `true` only if both answer `PONG`; `shutdown()` unsubscribes every channel and pattern, clears the maps, and closes both connections with `quit()` in parallel.

### Complete Example

```typescript
import { setTimeout as delay } from "node:timers/promises";
import { RedisPubSubProvider } from "blendsdk/webafx-cache";

interface OrderEvent {
    orderId: string;
    total: number;
}

async function main(): Promise<void> {
    // Requires a reachable Redis instance (localhost:6379 by default)
    const pubsub = new RedisPubSubProvider({
        channelPrefix: "MyApp",
        host: "localhost",
        port: 6379,
    });

    // Both local handlers share ONE Redis subscription for this channel
    await pubsub.subscribe<OrderEvent>("order:created", (message) => {
        console.log(`handler A: ${message.data.orderId}`);
    });
    await pubsub.subscribe<OrderEvent>("order:created", (message) => {
        console.log(`handler B: ${message.data.orderId}`);
    });

    await pubsub.psubscribe<OrderEvent>("audit:*", (message) => {
        console.log(`audit pattern matched ${message.channel}`);
    });

    // PUBLISH returns the number of Redis subscriptions — 1 for "MyApp:order:created"
    const receivers = await pubsub.publish<OrderEvent>("order:created", {
        orderId: "o-42",
        total: 99.5,
    });
    console.log(receivers); // 1

    // Redis delivery is asynchronous — wait briefly for the handler output above
    await delay(200);

    console.log(await pubsub.health()); // true

    await pubsub.shutdown();
}

await main();
```

### Key Methods and Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `publisher` | `protected Redis` | Dedicated connection for `PUBLISH`. |
| `subscriber` | `protected Redis` | Dedicated connection for `SUBSCRIBE`/`PSUBSCRIBE`. |
| `handlers` | `protected Map<string, Set<MessageHandler>>` | Exact-channel handlers, keyed by user-facing channel. |
| `patternHandlers` | `protected Map<string, Set<MessageHandler>>` | Pattern handlers, keyed by user-facing pattern. |
| `constructor` | `(config: RedisPubSubConfig)` | Creates both connections and wires `message`/`pmessage` routing. |
| `publish<T>` | `(channel: string, data: T) => Promise<number>` | `PUBLISH` to the prefixed channel; returns the Redis subscriber count. |
| `subscribe<T>` | `(channel: string, handler: MessageHandler<T>) => Promise<void>` | First handler per channel triggers Redis `SUBSCRIBE`; later handlers reuse it. |
| `unsubscribe` | `(channel: string) => Promise<void>` | Redis `UNSUBSCRIBE` + removes all local handlers. |
| `psubscribe<T>` | `(pattern: string, handler: MessageHandler<T>) => Promise<void>` | Same first-handler rule with `PSUBSCRIBE`. |
| `punsubscribe` | `(pattern: string) => Promise<void>` | Redis `PUNSUBSCRIBE` + removes all local handlers. |
| `activeSubscriptions` | `() => { channels: string[]; patterns: string[] }` | Synchronous, prefix-stripped. |
| `health` | `() => Promise<boolean>` | `PING` on both connections; both must answer `PONG`. |
| `shutdown` | `() => Promise<void>` | Unsubscribes all, clears maps, `quit()`s both connections. |
| `createRedisClient` | `protected (config: RedisPubSubConfig) => Redis` | Shared client factory (URL precedence). |
| `setupMessageHandlers` | `protected () => void` | Wires the `message`/`pmessage` listeners. |

---

## Message Envelope and Handlers

### What It Is

`PubSubMessage<T>` is the envelope every subscription handler receives, and `MessageHandler<T>` is the function type handlers must satisfy. Together they are the typed boundary of the messaging layer: publishers send `T`, handlers receive `PubSubMessage<T>` with a deserialized payload and metadata — regardless of which backend is in use.

### How It Works

- **Stable channel names** — `channel` is always the user-facing channel name (any configured `channelPrefix` is already stripped). `pattern` is present only on deliveries that came through a pattern subscription and contains the matched pattern, also prefix-stripped.
- **Deserialized payload** — `data` is the deserialized payload. Both backends serialize on publish and deserialize before delivery, so handlers never share object references with the publisher.
- **Sync or async handlers** — `MessageHandler<T>` may return `void` or `Promise<void>`. Whatever a handler throws or rejects is caught by `safeInvoke()` and logged; delivery to other handlers continues.
- **Backend parity** — `MemoryPubSubProvider` (in-process) and `RedisPubSubProvider` (over the wire) produce the same envelope shape, so handler code is written once and works with either backend.

### Complete Example

```typescript
import {
    MemoryPubSubProvider,
    type MessageHandler,
    type PubSubMessage,
} from "blendsdk/webafx-cache";

interface OrderEvent {
    orderId: string;
    total: number;
}

// message.channel is always user-facing — any channelPrefix is already stripped
const orderLogger: MessageHandler<OrderEvent> = (message: PubSubMessage<OrderEvent>) => {
    console.log(`[${message.channel}] order ${message.data.orderId} (${message.data.total})`);
};

// Handlers may be async — their rejections are isolated like sync throws
const auditLogger: MessageHandler<OrderEvent> = async (message) => {
    const record = await formatAuditRecord(message);
    console.log(record);
};

async function formatAuditRecord(message: PubSubMessage<OrderEvent>): Promise<string> {
    return `audit(${message.pattern}): ${message.channel} :: ${message.data.orderId}`;
}

async function main(): Promise<void> {
    const pubsub = new MemoryPubSubProvider({ channelPrefix: "MyApp" });

    await pubsub.subscribe<OrderEvent>("order:created", orderLogger);
    await pubsub.psubscribe<OrderEvent>("order:*", auditLogger);

    await pubsub.publish<OrderEvent>("order:created", { orderId: "o-7", total: 12.5 });
    // orderLogger prints:  [order:created] order o-7 (12.5)
    // auditLogger prints:  audit(order:*): order:created :: o-7

    await pubsub.shutdown();
}

await main();
```

### Key Types and Properties

| Type | Signature | Description |
|------|-----------|-------------|
| `PubSubMessage<T>` | `{ channel: string; data: T; pattern?: string }` | Envelope passed to every subscription handler. |
| `MessageHandler<T>` | `(message: PubSubMessage<T>) => void \| Promise<void>` | Handler contract; sync or async; errors are isolated by `safeInvoke()`. |

| Property | Type | Description |
|----------|------|-------------|
| `channel` | `string` | The channel the message was published to (prefix stripped). |
| `data` | `T` | The deserialized message payload. |
| `pattern` | `string \| undefined` | The matched pattern, present only for pattern-subscription deliveries (prefix stripped). |

---

## Configuration Types and Constants

### What It Is

The package's construction surface: base configs (`CacheProviderConfig`, `PubSubProviderConfig`), the shared Redis connection block (`RedisConnectionConfig`), backend-specific configs (`RedisCacheConfig`, `MemoryCacheConfig`, `RedisPubSubConfig`, `MemoryPubSubConfig`), environment-switching factory configs (`CacheFactoryConfig`, `PubSubFactoryConfig`), and the exported constants that encode naming and separator defaults.

### How It Works

- **Base configs** — non-Redis fields live in the bases: `rootKey` (required for caches) + `serviceName` + `defaultTTL` for caching; `channelPrefix` + `serviceName` for pub/sub.
- **Composition by interface extension** — `RedisCacheConfig extends CacheProviderConfig, RedisConnectionConfig` and `RedisPubSubConfig extends PubSubProviderConfig, RedisConnectionConfig`. The shared connection block exists so the cache and pub/sub providers expose identical Redis options without duplication.
- **URL precedence** — everywhere, `url` wins over `host`/`port`/`password`/`db`.
- **Memory-specific tuning** — `MemoryCacheConfig` adds `cleanupIntervalMs`; the pub/sub memory config adds no fields at all.
- **Factory configs** — add a `type: "redis" | "memory"` discriminator plus a superset of backend fields; Redis-only fields are ignored for `"memory"` and vice versa. `createCache()` and `createPubSub()` throw a descriptive error for unknown types.
- **Constants** — `DEFAULT_SERVICE_NAME` (`'cache'`), `DEFAULT_TTL` (`0` = no expiry), `DEFAULT_PUBSUB_SERVICE_NAME` (`'pubsub'`), and the separators `KEY_SEPARATOR`/`CHANNEL_SEPARATOR` (both `':'`, kept identical for consistency).

### Complete Example

```typescript
import {
    DEFAULT_PUBSUB_SERVICE_NAME,
    DEFAULT_SERVICE_NAME,
    DEFAULT_TTL,
    KEY_SEPARATOR,
    createCache,
    type CacheFactoryConfig,
} from "blendsdk/webafx-cache";

const config: CacheFactoryConfig = {
    type: process.env.NODE_ENV === "production" ? "redis" : "memory",
    rootKey: "MyApp",
    defaultTTL: 300,
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT ?? "6379"),
};

async function main(): Promise<void> {
    console.log(DEFAULT_SERVICE_NAME); // "cache"
    console.log(DEFAULT_PUBSUB_SERVICE_NAME); // "pubsub"
    console.log(DEFAULT_TTL); // 0
    console.log(KEY_SEPARATOR); // ":"

    const cache = createCache(config);
    console.log(cache.serviceName); // "cache"

    await cache.set("greeting", "hello");
    console.log(await cache.get<string>("greeting")); // "hello"

    await cache.shutdown();
}

await main();
```

### Key Configuration Types

| Interface | Definition | Purpose |
|-----------|------------|---------|
| `CacheProviderConfig` | `{ rootKey: string; serviceName?: string; defaultTTL?: number }` | Base config for all cache providers. |
| `RedisConnectionConfig` | `{ host?: string; port?: number; password?: string; db?: number; url?: string; connectTimeout?: number; maxRetriesPerRequest?: number }` | Shared Redis connection block, mixed into both Redis configs. |
| `RedisCacheConfig` | `CacheProviderConfig & RedisConnectionConfig` | Config for `RedisCacheProvider` / `redisCachePlugin()`. |
| `MemoryCacheConfig` | `CacheProviderConfig & { cleanupIntervalMs?: number }` | Config for `MemoryCacheProvider` / `memoryCachePlugin()`. |
| `CacheFactoryConfig` | `{ type: "redis" \| "memory"; rootKey: string; serviceName?; defaultTTL?; host?; port?; password?; db?; url?; cleanupIntervalMs? }` | Config for `createCache()` (environment-based switching). |
| `PubSubProviderConfig` | `{ channelPrefix?: string; serviceName?: string }` | Base config for all pub/sub providers. |
| `RedisPubSubConfig` | `PubSubProviderConfig & RedisConnectionConfig` | Config for `RedisPubSubProvider` / `redisPubSubPlugin()`. |
| `MemoryPubSubConfig` | `PubSubProviderConfig` | Config for `MemoryPubSubProvider` / `memoryPubSubPlugin()`. |
| `PubSubFactoryConfig` | `PubSubProviderConfig & { type: "redis" \| "memory"; host?; port?; password?; db?; url? }` | Config for `createPubSub()` (environment-based switching). |

### Constants and Defaults

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_SERVICE_NAME` | `"cache"` | Default cache `serviceName`. |
| `DEFAULT_TTL` | `0` | Default TTL — `0` means no expiry. |
| `KEY_SEPARATOR` | `":"` | Separator between `rootKey` and the user key. |
| `DEFAULT_PUBSUB_SERVICE_NAME` | `"pubsub"` | Default pub/sub `serviceName`. |
| `CHANNEL_SEPARATOR` | `":"` | Separator between `channelPrefix` and the channel name. |

| Setting | Default | Applies to |
|---------|---------|------------|
| `serviceName` | `'cache'` / `'pubsub'` | Cache / pub-sub providers. |
| `defaultTTL` | `0` (no expiry) | Cache providers. |
| `channelPrefix` | `undefined` (no prefix) | Pub/sub providers. |
| `cleanupIntervalMs` | `60000` ms | `MemoryCacheProvider`. |
| `host` / `port` / `db` | `localhost` / `6379` / `0` | Both Redis providers (ignored when `url` is set). |
| `connectTimeout` / `maxRetriesPerRequest` | `5000` ms / `3` | Both Redis providers. |

---

## WebAFX Plugin Integration

### What It Is

The adapter layer that turns any provider into a WebAFX `PluginDefinition` you pass to `app.use()`. Cache plugins: `createCachePlugin()`, `redisCachePlugin()`, `memoryCachePlugin()`, plus the `createCache()` factory. Pub/sub plugins: `createPubSubPlugin()`, `redisPubSubPlugin()`, `memoryPubSubPlugin()`, plus the `createPubSub()` factory. This is the only part of the package that imports `blendsdk/webafx` (an optional peer dependency) — providers themselves stay framework-free.

### How It Works

- Every plugin factory returns a `PluginDefinition` whose `name` is the provider's `serviceName`, whose `priority` defaults to `30`, and whose `factory` performs the wiring when WebAFX installs the plugin:
  1. Registers the provider itself via `app.registerService({ name, type: 'singleton', factory: () => provider, dispose: () => provider.shutdown() })` — the same instance is resolved by `serviceName` for the entire application lifetime.
  2. For pub/sub, registers the declarative subscriptions from the options — each `channel` through `subscribe()`, each `pattern` through `psubscribe()` — logging each registration.
  3. Logs plugin initialization and returns hooks that connect `provider.health()` to the `/health` endpoint and `provider.shutdown()` to graceful shutdown.
- **One-liner variants** — `redisCachePlugin()`/`memoryCachePlugin()` and `redisPubSubPlugin()`/`memoryPubSubPlugin()` construct the provider internally so registration is a single call. The provider-based variants (`createCachePlugin()`, `createPubSubPlugin()`) accept any custom `CacheProvider`/`PubSubProvider` subclass.
- **Environment switching** — `createCache()`/`createPubSub()` select the backend from a `type` discriminator (typically wired to `NODE_ENV` against the environment), and the resulting provider is passed to `createCachePlugin()`/`createPubSubPlugin()` — see Basic Usage for the full registration flow.
- **Multi-instance support** — several caches or pub/sub providers can coexist on one application using distinct `serviceName` values (and typically distinct `rootKey`/`channelPrefix` namespaces). Cache and pub/sub plugins are fully independent of each other.

### Complete Example

```typescript
import {
    createCache,
    createCachePlugin,
    createPubSub,
    createPubSubPlugin,
} from "blendsdk/webafx-cache";

async function main(): Promise<void> {
    // Environment-based provider selection
    const cache = createCache({
        type: "memory",
        rootKey: "MyApp",
        defaultTTL: 300,
    });

    const cachePlugin = createCachePlugin(cache);
    console.log(cachePlugin.name); // "cache"
    console.log(cachePlugin.priority); // 30

    const pubsub = createPubSub({
        type: "memory",
        channelPrefix: "MyApp",
    });

    const pubsubPlugin = createPubSubPlugin(pubsub, {
        subscriptions: [
            {
                channel: "order:created",
                handler: (message) => {
                    console.log(`order created event on ${message.channel}`);
                },
            },
            {
                pattern: "audit:*",
                handler: (message) => {
                    console.log(`audit event on ${message.channel}`);
                },
            },
        ],
    });
    console.log(pubsubPlugin.name); // "pubsub"

    // In a WebAFX application these definitions are passed to the app:
    //   app.use(cachePlugin);
    //   app.use(pubsubPlugin);
    // — the factories register each provider as a singleton service with
    //   /health and graceful-shutdown hooks.

    await cache.shutdown();
    await pubsub.shutdown();
}

await main();
```

### Key Functions

| Function | Type/Signature | Description |
|----------|----------------|-------------|
| `createCachePlugin` | `(provider: CacheProvider, options?: { priority?: number }) => PluginDefinition` | Wires any cache provider into WebAFX (singleton + health + shutdown). |
| `redisCachePlugin` | `(config: RedisCacheConfig) => PluginDefinition` | One-liner: creates a `RedisCacheProvider` and returns its plugin. |
| `memoryCachePlugin` | `(config: MemoryCacheConfig) => PluginDefinition` | One-liner: creates a `MemoryCacheProvider` and returns its plugin. |
| `createCache` | `(config: CacheFactoryConfig) => CacheProvider` | Backend factory by `type` discriminator; pass the result to `createCachePlugin()`. |
| `createPubSubPlugin` | `(provider: PubSubProvider, options?: PubSubPluginOptions) => PluginDefinition` | Wires any pub/sub provider, including declarative subscriptions. |
| `redisPubSubPlugin` | `(config: RedisPubSubConfig, options?: PubSubPluginOptions) => PluginDefinition` | One-liner: creates a `RedisPubSubProvider` and returns its plugin. |
| `memoryPubSubPlugin` | `(config?: MemoryPubSubConfig, options?: PubSubPluginOptions) => PluginDefinition` | One-liner: creates a `MemoryPubSubProvider` (config optional) and returns its plugin. |
| `createPubSub` | `(config: PubSubFactoryConfig) => PubSubProvider` | Backend factory by `type` discriminator; pass the result to `createPubSubPlugin()`. |

### Plugin Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `priority` | `number` | `30` | Plugin installation priority (both cache and pub/sub plugins). |
| `subscriptions` | `SubscriptionDefinition[]` | — | Declarative subscriptions registered at plugin install time (pub/sub only). |

| `SubscriptionDefinition` Field | Type | Description |
|-------------------------------|------|-------------|
| `channel` | `string` (optional) | Exact channel to subscribe to (`SUBSCRIBE`). Mutually exclusive with `pattern`. |
| `pattern` | `string` (optional) | Glob pattern to subscribe to (`PSUBSCRIBE`). Mutually exclusive with `channel`. |
| `handler` | `MessageHandler<T>` | Function invoked when a matching message arrives. |

---

# webafx-cache Basic Usage

This guide takes you from installation to a working cache and pub/sub setup: a minimal Quick Start, then progressive fundamentals that add one concept at a time, followed by reference tables for every configuration option and the error behavior you can expect.

---

## Installation

Install the package with npm or yarn:

```bash
# npm
npm install blendsdk/webafx-cache

# yarn
yarn add blendsdk/webafx-cache
```

**Requirements**

| Requirement | Details |
|-------------|---------|
| Node.js | `>= 22.0.0` |
| Module system | ESM only — use `import`, never `require()` |
| TypeScript | Strict mode recommended; declaration files ship with the package (`dist/index.d.ts`) |
| Redis | Only needed for the `RedisCacheProvider` / `RedisPubSubProvider` backends (default `localhost:6379`) |
| WebAFX | Optional peer dependency — install `blendsdk/webafx` only if you use the plugin factory functions |

`ioredis` is the only runtime dependency and is installed automatically.

> **Note**: `blendsdk/webafx-cache` is part of the BlendSDK monorepo and is marked `private` in its own `package.json`; consumer projects receive it through the `blendsdk` umbrella distribution, while monorepo workspaces resolve it locally.

---

## Quick Start

The smallest working program — an in-memory cache with a default TTL:

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

const cache = new MemoryCacheProvider({ rootKey: "MyApp", defaultTTL: 300 });

await cache.set("greeting", { text: "Hello, World!" });
const greeting = await cache.get<{ text: string }>("greeting");

console.log(greeting?.text); // "Hello, World!"

await cache.shutdown();
```

What each part does:

1. `MemoryCacheProvider` runs fully in-process — no Redis, no Docker, no WebAFX required.
2. `rootKey` is the only required option; it namespaces every key (`greeting` is stored as `MyApp:greeting`).
3. `defaultTTL: 300` gives entries a 5-minute lifetime unless a call overrides it.
4. All operations are async and JSON-serialize values, so objects round-trip safely.
5. `shutdown()` releases resources — call it once when your application stops.

Moving to Redis later is a one-line change: replace `MemoryCacheProvider` with `RedisCacheProvider` and add `host`/`port`. The API is identical.

---

## Fundamentals

The package contains two independent hierarchies — caching and pub/sub — that share nothing but the package. This section walks through the cache API first, then pub/sub, then WebAFX integration. Every example is standalone.

### Creating a Provider

Start with the in-memory backend — it needs no infrastructure and is ideal for development and unit tests:

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

await cache.set("hello", "world");
console.log(await cache.get<string>("hello")); // "world"
console.log(cache.serviceName); // "cache"

await cache.shutdown();
```

When you need shared state across processes, switch to the Redis backend — same methods, plus connection options:

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";

const cache = new RedisCacheProvider({
    rootKey: "MyApp",
    host: "localhost",
    port: 6379,
    defaultTTL: 300,
});

await cache.set("hello", "world");
console.log(await cache.get<string>("hello")); // "world"

await cache.shutdown();
```

For environment-based switching, `createCache()` returns the right provider from one configuration shape:

```typescript
import { createCache } from "blendsdk/webafx-cache";

const cache = createCache({
    type: process.env.NODE_ENV === "production" ? "redis" : "memory",
    rootKey: "MyApp",
    defaultTTL: 300,
    // Redis-only options — ignored when type is "memory"
    host: "localhost",
    port: 6379,
});

await cache.set("hello", "world");
console.log(await cache.get<string>("hello")); // "world"

await cache.shutdown();
```

`rootKey` is required and must be a non-empty string — the constructor throws otherwise (see Error Handling). Every key you pass is transparently stored as `rootKey + ":" + key`, so multiple applications can share one Redis instance without collisions.

### Reading and Writing Values

`set()` stores any JSON-serializable value and `get()` reads it back with full type information:

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

interface User {
    id: string;
    name: string;
    roles: string[];
}

const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

// Objects, arrays, primitives, and null are all serialized transparently
await cache.set<User>("user:u-1", { id: "u-1", name: "Alice", roles: ["admin"] });
await cache.set<number>("attempts", 3);
await cache.set<string[]>("tags", ["alpha", "beta"]);
await cache.set<null>("empty-result", null);

const user = await cache.get<User>("user:u-1");
console.log(user?.name); // "Alice"
console.log(user?.roles); // ["admin"]
console.log(await cache.get<number>("attempts")); // 3
console.log(await cache.get<string[]>("tags")); // ["alpha", "beta"]
console.log(await cache.get<null>("empty-result")); // null

// A missing key resolves to undefined — get() never throws for a miss
console.log(await cache.get<User>("user:unknown")); // undefined

await cache.shutdown();
```

Things to know about stored values:

- **Misses resolve, they don't throw.** `get()` returns `undefined` for keys that are missing or expired. A stored `null` is a valid value, not a miss.
- **Values are JSON round-tripped** on every write and read, in both backends. Reads return fresh objects (no shared references), and class instances come back as plain data — store DTOs, and expect `Date` values as ISO strings.
- **Every method is async** on both backends, so swapping backends never introduces sync/async differences in your calling code.

### Expiration with TTL

TTL is always expressed in seconds. Three ways control it: the `defaultTTL` option, a per-call argument, and `expire()`:

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

const cache = new MemoryCacheProvider({ rootKey: "MyApp", defaultTTL: 60 });

// No explicit TTL: uses defaultTTL (60 seconds)
await cache.set("session:abc", { userId: "u-1" });

// Explicit TTL overrides the default (600 seconds)
await cache.set("catalog:featured", { productIds: ["p-1", "p-2"] }, 600);

// TTL 0 disables expiry for this key, regardless of defaultTTL
await cache.set("flags:dark-mode", true, 0);

console.log(await cache.ttl("session:abc")); // ~60 — seconds remaining
console.log(await cache.ttl("flags:dark-mode")); // -1 — exists, no expiry
console.log(await cache.ttl("missing")); // -2 — key does not exist

// Change the TTL of an existing key without touching its value
await cache.expire("session:abc", 3600);

await cache.shutdown();
```

| Call | Effective TTL |
|------|---------------|
| `await cache.set(key, value)` | uses `defaultTTL` |
| `await cache.set(key, value, 600)` | expires after 600 seconds |
| `await cache.set(key, value, 0)` | never expires (overrides `defaultTTL`) |
| `await cache.expire(key, 120)` | resets an existing key's TTL; resolves `false` if the key is missing |
| `await cache.ttl(key)` | remaining seconds, `-1` (no expiry), or `-2` (missing) |

Under the hood, Redis uses native key expiry. The memory backend stores an expiration timestamp and evicts lazily on access, plus a background sweep every `cleanupIntervalMs` (default 60 000 ms) that reclaims memory from never-accessed entries. The sweep timer is unref'd, so it never keeps your Node.js process alive.

### Deleting Keys and Pattern Invalidation

Single-key removal and whole-family invalidation are both async and return useful counts:

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

await cache.set("user:1", { name: "Alice" });
await cache.set("user:2", { name: "Bob" });
await cache.set("product:1", { name: "Keyboard" });

// delete() reports whether the key existed
console.log(await cache.delete("user:1")); // true
console.log(await cache.delete("user:1")); // false — already deleted

// exists() checks presence (expired keys count as absent)
console.log(await cache.exists("user:2")); // true

// deletePattern() removes a key family and returns the deleted count
console.log(await cache.deletePattern("user:*")); // 1 — only user:2 remained
console.log(await cache.exists("product:1")); // true — untouched

// clear() removes everything in this provider's namespace — and nothing else
await cache.clear();
console.log(await cache.exists("product:1")); // false

await cache.shutdown();
```

- `deletePattern()` accepts `*` as a wildcard (`"user:*"`, `"api:*:active"`). On Redis it runs with `SCAN` + batched `DEL` — never `KEYS` — so it is safe on production servers.
- `clear()` removes only keys under this provider's `rootKey`. It does not flush the Redis database or touch other namespaces, so it is safe even when other apps share the instance.

### Cache-Aside with getOrSet

The most common caching pattern is available as a single call: return a cached value if present, otherwise produce it with a factory function, cache it, and return it.

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

interface UserProfile {
    id: string;
    name: string;
}

async function loadProfileFromDatabase(id: string): Promise<UserProfile> {
    await new Promise((resolve) => setTimeout(resolve, 250)); // stand-in for a slow query
    return { id, name: "Alice" };
}

const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

let databaseCalls = 0;
const loadProfile = async (): Promise<UserProfile> => {
    databaseCalls++;
    return loadProfileFromDatabase("u-1");
};

// Cache miss → the factory runs → its result is cached for 300 seconds
const profile = await cache.getOrSet<UserProfile>("profile:u-1", loadProfile, 300);

// Cache hit → the factory is skipped entirely
const cached = await cache.getOrSet<UserProfile>("profile:u-1", loadProfile, 300);

console.log(profile.name); // "Alice"
console.log(cached.name); // "Alice"
console.log(databaseCalls); // 1 — the "database" was hit only once

await cache.shutdown();
```

The signature is:

```typescript fragment
getOrSet<T>(key: string, factory: () => Promise<T>, ttlSeconds?: number): Promise<T>
```

`getOrSet()` is implemented once in the abstract base class, so it behaves identically on every backend. If the factory rejects, the error propagates to the caller and nothing is written to the cache.

### Health Checks and Graceful Shutdown

Every provider exposes the same lifecycle methods, used by monitoring and teardown:

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

// health() probes the backend; it never throws — false means "not operational"
console.log(await cache.health()); // true

// shutdown() releases everything the provider holds
await cache.shutdown();
```

| Provider | `health()` | `shutdown()` |
|----------|------------|--------------|
| `MemoryCacheProvider` | always `true` | stops the cleanup timer and clears the store |
| `RedisCacheProvider` | sends `PING`; `false` if Redis is unreachable | closes the ioredis connection gracefully (`quit()`) |
| `MemoryPubSubProvider` | always `true` | removes all handlers |
| `RedisPubSubProvider` | `PING` on both the publisher and subscriber connections | unsubscribes everything and closes both connections |

Call `shutdown()` once during application teardown. When you register a provider through a WebAFX plugin, the plugin wires both methods in for you (see Registering with WebAFX).

### Publishing and Subscribing

Pub/sub is the second, independent hierarchy in the package — caching and messaging share no state or configuration. Start with the in-memory backend:

```typescript
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";

interface OrderEvent {
    orderId: string;
    total: number;
}

const pubsub = new MemoryPubSubProvider({ channelPrefix: "MyApp" });

await pubsub.subscribe<OrderEvent>("order:created", (message) => {
    console.log(`channel: ${message.channel}`); // "order:created"
    console.log(`order: ${message.data.orderId}`); // "o-1"
});

// publish() resolves to the number of subscribers that received the message
const receivers = await pubsub.publish<OrderEvent>("order:created", {
    orderId: "o-1",
    total: 49.99,
});

console.log(`delivered to ${receivers} subscriber(s)`); // "delivered to 1 subscriber(s)"

await pubsub.shutdown();
```

The Redis backend has the same API and adds fan-out: every handler registered for a channel receives every message.

```typescript
import { RedisPubSubProvider } from "blendsdk/webafx-cache";

const pubsub = new RedisPubSubProvider({
    host: "localhost",
    port: 6379,
    channelPrefix: "MyApp",
});

// Multiple handlers per channel fan out — all of them receive the message
await pubsub.subscribe<string>("deploy:finished", (message) => {
    console.log("notifier:", message.data);
});

await pubsub.subscribe<string>("deploy:finished", (message) => {
    console.log("audit-log:", message.data);
});

await pubsub.publish("deploy:finished", "v5.54.0");

// unsubscribe() removes all handlers for the channel
await pubsub.unsubscribe("deploy:finished");

await pubsub.shutdown();
```

The handler receives a `PubSubMessage<T>` envelope:

| Property | Type | Description |
|----------|------|-------------|
| `channel` | `string` | The channel the message was published to — with the prefix stripped |
| `data` | `T` | The deserialized payload |
| `pattern` | `string \| undefined` | Present only for pattern-matched messages (see below) |

Key behaviors:

- Payloads are JSON round-tripped, so handlers receive fresh copies — no shared references with the publisher.
- The `channelPrefix` is applied on the wire (Redis) and stripped before delivery, so `message.channel` is always the name you wrote in `subscribe()`.
- Handler errors never propagate to `publish()` — one failing handler cannot break other subscribers or the connection (see Error Handling).
- The Redis backend maintains **two** dedicated connections: one for publishing, one for subscribing (Redis requires a dedicated connection once it enters subscriber mode). `shutdown()` closes both.

For environment-based switching, `createPubSub()` mirrors `createCache()`:

```typescript
import { createPubSub } from "blendsdk/webafx-cache";

const pubsub = createPubSub({
    type: process.env.NODE_ENV === "production" ? "redis" : "memory",
    channelPrefix: "MyApp",
    host: "localhost",
    port: 6379,
});

await pubsub.subscribe<string>("greet", (message) => console.log(message.data));
await pubsub.publish("greet", "hello");

await pubsub.shutdown();
```

### Pattern Subscriptions

`psubscribe()` subscribes to a whole channel family using glob patterns: `*` matches any sequence of characters, `?` matches exactly one character.

```typescript
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";

const pubsub = new MemoryPubSubProvider({ channelPrefix: "MyApp" });

// Glob patterns: * matches any sequence, ? matches exactly one character
await pubsub.psubscribe("order:*", (message) => {
    console.log(`pattern "${message.pattern}" matched channel "${message.channel}"`);
});

// Exact and pattern subscribers both receive a matching message
await pubsub.subscribe("order:created", (message) => {
    console.log(`exact subscriber got "${message.channel}"`);
});

await pubsub.publish("order:created", { orderId: "o-1" }); // both handlers fire
await pubsub.publish("order:charged", { orderId: "o-1" }); // pattern handler only

// Inspect what is currently subscribed (prefix-stripped names)
const active = pubsub.activeSubscriptions();
console.log(active.channels); // ["order:created"]
console.log(active.patterns); // ["order:*"]

// Remove pattern handlers with punsubscribe()
await pubsub.punsubscribe("order:*");

await pubsub.shutdown();
```

Notes:

- `activeSubscriptions()` is synchronous and returns user-facing names: `{ channels: string[]; patterns: string[] }`.
- Pattern-delivered messages include the `pattern` field in the envelope, alongside the concrete `channel`.
- `shutdown()` removes all channel and pattern subscriptions.

### Registering with WebAFX

The plugin factories adapt any provider into a WebAFX `PluginDefinition` that registers it as an application-wide singleton service — with `/health` and graceful-shutdown hooks wired in automatically. These functions are the only part of the package that needs `blendsdk/webafx` (an optional peer dependency).

```typescript
import {
    createCachePlugin,
    createPubSubPlugin,
    MemoryCacheProvider,
    MemoryPubSubProvider,
} from "blendsdk/webafx-cache";

const cache = new MemoryCacheProvider({ rootKey: "MyApp", defaultTTL: 300 });
const pubsub = new MemoryPubSubProvider({ channelPrefix: "MyApp" });

// Accepts ANY provider instance — memory, Redis, or a custom subclass
const cachePlugin = createCachePlugin(cache);

const pubsubPlugin = createPubSubPlugin(pubsub, {
    subscriptions: [
        {
            channel: "order:created",
            handler: (message) => console.log("order created on", message.channel),
        },
        {
            pattern: "audit:*",
            handler: (message) => console.log("audit event on", message.channel),
        },
    ],
});

// cachePlugin and pubsubPlugin are PluginDefinition objects, ready for app.use()
```

```typescript fragment
// `app` is your WebAFX application instance
app.use(cachePlugin);
app.use(pubsubPlugin);
```

```typescript fragment
import {
    memoryCachePlugin,
    memoryPubSubPlugin,
    redisCachePlugin,
    redisPubSubPlugin,
} from "blendsdk/webafx-cache";

// One-liners: create the provider AND the plugin in a single call
app.use(memoryCachePlugin({ rootKey: "MyApp", defaultTTL: 300 }));
app.use(memoryPubSubPlugin({ channelPrefix: "MyApp" }));
app.use(redisCachePlugin({ rootKey: "MyApp", host: "localhost", port: 6379 }));
app.use(redisPubSubPlugin({ channelPrefix: "MyApp", host: "localhost", port: 6379 }));
```

What the plugin does at install time:

- Registers the provider as a **singleton service** named `provider.serviceName` (default `'cache'` / `'pubsub'`) in the service container.
- Hooks `provider.health()` into the `/health` endpoint.
- Hooks `provider.shutdown()` into graceful shutdown — you do not call `shutdown()` yourself when using plugins.
- Registers any declarative `subscriptions` (either `channel` or `pattern` per entry) on the pub/sub provider.
- Uses a default plugin priority of `30`, overridable via the options argument.

Multiple isolated providers use distinct `serviceName` and namespace values:

```typescript fragment
app.use(redisCachePlugin({ rootKey: "Sessions", serviceName: "session-cache", host: "localhost" }));
app.use(redisCachePlugin({ rootKey: "Products", serviceName: "product-cache", host: "localhost" }));
```

---

## Configuration

Every cache provider accepts base options plus backend-specific fields. A fully annotated Redis example:

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";

const cache = new RedisCacheProvider({
    rootKey: "MyApp",        // required — all keys become "MyApp:*"
    serviceName: "cache",    // default; used by the WebAFX service container
    defaultTTL: 300,         // default 0 = no expiry
    host: "localhost",       // default
    port: 6379,              // default
    db: 0,                   // default
    connectTimeout: 5000,    // default (ms)
    maxRetriesPerRequest: 3, // default
});

await cache.set("key", "value");
console.log(await cache.get<string>("key")); // "value"

await cache.shutdown();
```

### Cache Options

**Base options — `CacheProviderConfig` (accepted by every cache provider):**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `rootKey` | `string` | — (required) | Namespace prefix for all keys; must be a non-empty string. Stored keys look like `rootKey:key`. |
| `serviceName` | `string` | `"cache"` (`DEFAULT_SERVICE_NAME`) | Name used when the provider is registered in the WebAFX service container. Use distinct names for multiple caches. |
| `defaultTTL` | `number` | `0` (`DEFAULT_TTL`) | Fallback TTL in seconds for `set()` calls without an explicit TTL. `0` means no expiry. |

**Memory backend — `MemoryCacheConfig` (adds):**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `cleanupIntervalMs` | `number` | `60000` | Interval for the background sweep that removes expired entries (ms). `0` or negative disables the sweep; lazy eviction on access still applies. The timer is unref'd. |

**Redis backend — `RedisCacheConfig` (adds, via the shared `RedisConnectionConfig`):**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `host` | `string` | `"localhost"` | Redis server host. |
| `port` | `number` | `6379` | Redis server port. |
| `password` | `string` | — | Redis password; omit when the server requires no auth. |
| `db` | `number` | `0` | Redis database index (0–15). |
| `url` | `string` | — | Full connection URL (e.g. `redis://:secret@localhost:6379/0`). When set, it takes precedence over `host`/`port`/`password`/`db`. |
| `connectTimeout` | `number` | `5000` | Connection timeout in milliseconds. |
| `maxRetriesPerRequest` | `number` | `3` | Command retries before an operation fails. Set to `1` to fail fast. |

### Pub/Sub Options

**Base options — `PubSubProviderConfig`:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `channelPrefix` | `string` | — (no prefix) | Prefix applied to every channel and pattern (e.g. `MyApp:order:created`). Handlers always see the un-prefixed name. |
| `serviceName` | `string` | `"pubsub"` (`DEFAULT_PUBSUB_SERVICE_NAME`) | WebAFX service-container name. Use distinct names for multiple pub/sub providers. |

**Redis backend — `RedisPubSubConfig` (adds the same connection fields and defaults as `RedisCacheConfig`):**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `host` | `string` | `"localhost"` | Redis host for both connections. |
| `port` | `number` | `6379` | Redis port for both connections. |
| `password` | `string` | — | Redis password. |
| `db` | `number` | `0` | Redis database index. |
| `url` | `string` | — | Connection URL; overrides `host`/`port`/`password`/`db`. |
| `connectTimeout` | `number` | `5000` | Connection timeout in milliseconds. |
| `maxRetriesPerRequest` | `number` | `3` | Retries per command before failing. |

The Redis pub/sub provider opens **two** dedicated ioredis connections — one for `PUBLISH`, one for `SUBSCRIBE`/`PSUBSCRIBE` (Redis requires a dedicated connection once it enters subscriber mode). `health()` pings both; `shutdown()` closes both.

**Memory backend — `MemoryPubSubConfig`:** adds no options beyond the base configuration.

### Factory Options

`createCache()` and `createPubSub()` accept a flat configuration that combines the base options with backend-specific fields. Fields that do not match the selected `type` are ignored.

**`CacheFactoryConfig`:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `type` | `"redis" \| "memory"` | — (required) | Backend to construct. Any other value throws. |
| `rootKey` | `string` | — (required) | Same as `CacheProviderConfig.rootKey`. |
| `serviceName` | `string` | `"cache"` | Same as `CacheProviderConfig.serviceName`. |
| `defaultTTL` | `number` | `0` | Same as `CacheProviderConfig.defaultTTL`. |
| `host` / `port` / `password` / `db` / `url` | Redis connection fields | Redis defaults | Used only when `type` is `"redis"`. |
| `cleanupIntervalMs` | `number` | `60000` | Used only when `type` is `"memory"`. |

**`PubSubFactoryConfig`:**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `type` | `"redis" \| "memory"` | — (required) | Backend to construct. Any other value throws. |
| `channelPrefix` | `string` | — | Same as `PubSubProviderConfig.channelPrefix`. |
| `serviceName` | `string` | `"pubsub"` | Same as `PubSubProviderConfig.serviceName`. |
| `host` / `port` / `password` / `db` / `url` | Redis connection fields | Redis defaults | Used only when `type` is `"redis"`. |

### Plugin Options

`createCachePlugin(provider, options?)` accepts one option: `priority` — `number`, default `30` — the installation priority in the WebAFX plugin pipeline.

`createPubSubPlugin(provider, options?)` accepts `PubSubPluginOptions`:

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `priority` | `number` | `30` | Installation priority in the WebAFX plugin pipeline. |
| `subscriptions` | `SubscriptionDefinition[]` | `[]` | Declarative subscriptions registered when the plugin is installed. |

Each `SubscriptionDefinition` contains:

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `channel` | `string` | — | Exact channel to subscribe to. Mutually exclusive with `pattern`. |
| `pattern` | `string` | — | Glob pattern to `psubscribe` to. Mutually exclusive with `channel`. |
| `handler` | `MessageHandler<T>` | — (required) | Called for every matching message. |

### Exported Constants

All constants are exported from the package root, so you can reference the same defaults the providers use:

```typescript
import {
    CHANNEL_SEPARATOR,
    DEFAULT_PUBSUB_SERVICE_NAME,
    DEFAULT_SERVICE_NAME,
    DEFAULT_TTL,
    KEY_SEPARATOR,
} from "blendsdk/webafx-cache";

console.log(DEFAULT_SERVICE_NAME); // "cache"
console.log(DEFAULT_TTL); // 0
console.log(KEY_SEPARATOR); // ":"
console.log(DEFAULT_PUBSUB_SERVICE_NAME); // "pubsub"
console.log(CHANNEL_SEPARATOR); // ":"
```

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_SERVICE_NAME` | `"cache"` | Default `serviceName` for cache providers. |
| `DEFAULT_TTL` | `0` | Default `defaultTTL` — no expiry. |
| `KEY_SEPARATOR` | `":"` | Separator between `rootKey` and the user key. |
| `DEFAULT_PUBSUB_SERVICE_NAME` | `"pubsub"` | Default `serviceName` for pub/sub providers. |
| `CHANNEL_SEPARATOR` | `":"` | Separator between `channelPrefix` and the channel name. |

---

## Error Handling

The package defines **no custom error classes**. Errors fall into three categories:

1. **Configuration errors** — thrown synchronously by constructors and factory functions. Plain `Error` instances with fixed messages.
2. **Backend errors** — rejected promises propagated from ioredis (connection failures, command timeouts). `health()` is the exception: it catches everything and resolves `false`.
3. **Isolated handler errors** — pub/sub handler exceptions are caught by the base class, logged, and never reach the publisher.

**Errors you can catch:**

| Error type | Thrown by | Message / meaning |
|------------|-----------|-------------------|
| `Error` | `CacheProvider` constructor (`MemoryCacheProvider`, `RedisCacheProvider`, and custom subclasses) | `CacheProvider: rootKey is required and cannot be empty` — `rootKey` was missing, empty, or whitespace-only. |
| `Error` | `createCache()` | `Unknown cache type: "<value>". Supported types: "redis", "memory".` — invalid `type` discriminator. |
| `Error` | `createPubSub()` | `Unknown pub/sub type: "<value>". Supported types: "redis", "memory".` — invalid `type` discriminator. |
| `Error` (from ioredis) | Redis provider operations | Connection failures and timeouts reject the promise after `maxRetriesPerRequest` attempts. |
| `TypeError` | `set()` / `publish()` | The value is not JSON-serializable (for example, a circular reference) — thrown by `JSON.stringify`. |

**Conditions that are deliberately not errors:**

| Situation | Behavior |
|-----------|----------|
| `get()` on a missing or expired key | resolves `undefined` |
| `get()` on a value that cannot be parsed | resolves `undefined` (treated as a cache miss) |
| `expire()` / `delete()` on a missing key | resolves `false` |
| `health()` while Redis is unreachable | resolves `false` — never rejects |
| Pub/sub handler throws (sync or async) | logged to `console.error` as `[PubSub] Handler error on channel "<channel>": ...`; other handlers still run; `publish()` is unaffected |
| Redis pub/sub message that fails JSON parsing | logged as `[PubSub] Failed to parse message on "<channel>"`; the message is dropped |

**Catch configuration errors at startup (fail fast):**

```typescript
import { createCache } from "blendsdk/webafx-cache";

try {
    const cache = createCache({
        type: "memory",
        rootKey: process.env.CACHE_ROOT_KEY ?? "",
    });

    await cache.set("startup:check", "ok");
    console.log(await cache.get<string>("startup:check")); // "ok"

    await cache.shutdown();
} catch (error) {
    // With no CACHE_ROOT_KEY set: "CacheProvider: rootKey is required and cannot be empty"
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Cache configuration is invalid: ${message}`);
}
```

**Degrade gracefully when Redis is unavailable:**

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";

interface User {
    id: string;
    name: string;
}

const cache = new RedisCacheProvider({
    rootKey: "MyApp",
    host: "localhost",
    port: 6379,
    maxRetriesPerRequest: 1, // surface connection failures fast
});

async function readCachedUser(id: string): Promise<User | undefined> {
    try {
        return await cache.get<User>(`user:${id}`);
    } catch (error) {
        // Redis unreachable — treat the read as a cache miss and use the source of truth
        console.error(`Cache read failed: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}

const user = await readCachedUser("u-1");
console.log(user ?? "not in cache — load from the database");

// health() is the safe readiness probe: it never throws, it resolves false
console.log(`Cache healthy: ${await cache.health()}`);

await cache.shutdown();
```

**Handler errors are isolated from publishers:**

```typescript
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";

const pubsub = new MemoryPubSubProvider({ channelPrefix: "MyApp" });

await pubsub.subscribe("events", () => {
    throw new Error("subscriber defect");
});

await pubsub.subscribe("events", (message) => {
    console.log("healthy handler still received:", message.data);
});

// The first handler's error is caught and logged — publish() resolves normally
const receivers = await pubsub.publish("events", { type: "heartbeat" });
console.log(`delivered to ${receivers} handlers`); // 2

await pubsub.shutdown();
```

Practical guidelines:

1. Create providers during startup so `rootKey` and `type` validation fails fast and visibly.
2. Treat cache failures as misses — a cache must never take down the request path. Wrap Redis operations in `try/catch` or consult `health()` for readiness checks.
3. Only cache JSON-serializable data; sanitize payloads before `set()` and `publish()` to avoid `TypeError` from circular structures.
4. Add `try/catch` inside a pub/sub handler only if you need custom recovery beyond the built-in logging.
5. Call `shutdown()` exactly once during teardown — or let a WebAFX plugin do it for you.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
