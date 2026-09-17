> **Package**: `blendsdk/webafx-cache`

# webafx-cache Overview

---

## What It Is

`blendsdk/webafx-cache` is an application-wide caching and pub/sub (publish/subscribe) plugin for WebAFX, published by TrueSoftware B.V. as part of the BlendSDK monorepo. It provides two independent abstraction hierarchies in a single package: a `CacheProvider` hierarchy for namespaced key/value caching with TTL, and a `PubSubProvider` hierarchy for typed, JSON-serialized messaging. Each hierarchy ships with two interchangeable backends that satisfy the same async contract — a production-grade Redis implementation built on `ioredis` (`RedisCacheProvider`, `RedisPubSubProvider`) and a zero-dependency in-memory implementation for development, testing, and single-instance deployments (`MemoryCacheProvider`, `MemoryPubSubProvider`). Providers can be used completely standalone, or registered in a WebAFX application through plugin factory functions that install them as application-wide singleton services with health-check and graceful-shutdown integration.

---

## Key Features

- **Two independent hierarchies in one package** — caching (`CacheProvider`) and pub/sub (`PubSubProvider`) are parallel abstractions with no coupling; you can adopt either or both.
- **Interchangeable backends with an identical API** — Redis and in-memory implementations honor the same abstract contract (verified by shared contract tests), so swapping backends never changes calling code.
- **Production Redis backends** — `RedisCacheProvider` and `RedisPubSubProvider` use `ioredis`; the pub/sub provider maintains two dedicated connections (publisher + subscriber).
- **Zero-dependency in-memory backends** — `MemoryCacheProvider` and `MemoryPubSubProvider` run without Redis or Docker; ideal for development, unit tests, and single-instance apps.
- **Transparent namespace isolation** — every cache key is prefixed with `rootKey` and every channel with `channelPrefix`, so multiple apps or concerns can safely share one Redis instance; prefixes are stripped before handlers see messages.
- **Automatic JSON serialization** — cache values and pub/sub messages are serialized on write and deserialized on read in both backends, guaranteeing behavior parity and no shared references.
- **TTL management** — per-operation TTL in seconds with a `defaultTTL` fallback (`0` = no expiry); Redis uses native expiry, memory uses lazy eviction plus a periodic cleanup timer (unref'd, default 60 s).
- **Cache-aside helper** — `getOrSet(key, factory, ttl?)` gets a cached value or produces, caches, and returns it; implemented once in the abstract base class.
- **Pattern operations** — `deletePattern('user:*')` on Redis uses `SCAN` + batched `DEL` (never `KEYS`); pub/sub supports glob subscriptions via `psubscribe()` with `*` and `?` wildcards.
- **Resilient message delivery** — pub/sub handler errors (sync or async) are caught and logged by `safeInvoke()`; one failing handler never affects other subscribers or the connection.
- **First-class WebAFX integration** — one-liner plugins (`redisCachePlugin()`, `memoryCachePlugin()`, `redisPubSubPlugin()`, `memoryPubSubPlugin()`), provider plugins (`createCachePlugin()`, `createPubSubPlugin()`), environment factories (`createCache()`, `createPubSub()`), declarative subscriptions, `/health` hooks, and graceful shutdown.
- **Multi-instance support** — a configurable `serviceName` (defaults: `'cache'`, `'pubsub'`) allows several independent caches or pub/sub providers in one application.
- **Strict, generic TypeScript API, ESM-only** — typed as `get<T>()`, `set<T>()`, `subscribe<T>()`, `publish<T>()`; no `any` in the public surface; requires Node.js >= 22.

---

## When To Use

Use `blendsdk/webafx-cache` when you need:

- **Expensive results cached once and reused** — database queries, external API calls, computed aggregations. `getOrSet()` is the canonical cache-aside pattern.
- **Shared state across processes** — sessions, tokens, feature flags, or counters in a multi-instance deployment. Use the Redis backends so all instances share the same cache.
- **Local development and tests without infrastructure** — the in-memory backends are drop-in replacements; unit tests require no Docker or Redis.
- **Environment-based backend switching** — one configuration shape (`createCache()`, `createPubSub()` with a `type` discriminator) moves the app from memory in development to Redis in production.
- **Event-driven communication** — broadcasting events (order created, audit events, cache invalidation) to many subscribers without coupling publishers to subscribers, in-process or across instances.
- **Pattern-based invalidation and fan-in** — deleting groups of related keys (`deletePattern('product:category:*')`) or subscribing to whole channel families (`psubscribe('audit:*')`).
- **Multiple isolated caches or topics per application** — separate `rootKey` namespaces and `serviceName` registrations (e.g., `session-cache` + `data-cache`).
- **Standalone (non-WebAFX) usage** — providers work without WebAFX; `blendsdk/webafx` is only needed for the plugin factory functions.

**When not to use it:** this package is not a durable data store and not a guaranteed-delivery message queue. Cache entries may expire or be evicted at any time, and pub/sub is fire-and-forget — messages published while a subscriber is disconnected are not retained.

---

## Architecture

The package is organized as two parallel hierarchy trees that are deliberately independent: there is no coupling between the caching side and the pub/sub side. Each tree follows the same shape — an abstract base class defines the full contract and implements all backend-agnostic logic once, while concrete subclasses provide only the backend-specific operations. On top of each tree sits a thin plugin layer (the only code that imports `blendsdk/webafx`) that adapts a provider into a WebAFX `PluginDefinition`.

```text
blendsdk/webafx-cache
│
├── CACHING — independent hierarchy
│   ├── CacheProvider (abstract base)
│   │     ├── MemoryCacheProvider — Map store + TTL cleanup timer, zero dependencies
│   │     └── RedisCacheProvider  — ioredis, native TTL, SCAN-based pattern delete
│   └── plugin factories → createCachePlugin / redisCachePlugin / memoryCachePlugin / createCache
│
└── PUB/SUB — independent hierarchy
    ├── PubSubProvider (abstract base)
    │     ├── MemoryPubSubProvider — in-process handler maps, glob matching
    │     └── RedisPubSubProvider  — two ioredis connections (publisher + subscriber)
    └── plugin factories → createPubSubPlugin / redisPubSubPlugin / memoryPubSubPlugin / createPubSub

Both hierarchies converge on a WebAFX PluginDefinition passed to app.use():
the provider is registered as an application-wide singleton service with
/health and graceful-shutdown hooks wired in automatically.
```

### Key Design Patterns

| Pattern | Where | Purpose |
|---------|-------|---------|
| **Template Method** | `CacheProvider`, `PubSubProvider` abstract classes | Define the complete contract and implement shared logic once (`getOrSet()`, key/channel building, TTL resolution, `safeInvoke()` error isolation); subclasses fill in backend specifics. |
| **Strategy** | `MemoryCacheProvider` / `RedisCacheProvider` (and pub/sub equivalents) | Interchangeable backends behind one async interface — choosing a backend is a construction-time decision, not a code change. |
| **Factory Method / Abstract Factory** | `createCache()`, `createPubSub()`, `redisCachePlugin()`, `createCachePlugin()`, etc. | Construct the right provider (and plugin) from configuration, including environment-based switching via a `type` discriminator. |
| **Singleton** | WebAFX service container registration | Each provider is one application-wide instance resolved by `serviceName` (`'cache'`, `'pubsub'`, or a custom name) — not a per-request object. |
| **Observer / Publish–Subscribe** | `PubSubProvider` hierarchy | Fan-out delivery of typed, JSON-serialized messages to multiple handlers, plus glob pattern subscriptions. |
| **Adapter / Facade** | Redis and memory providers | Redis providers adapt ioredis commands (`SET EX`, `EXPIRE`, `SCAN` + `DEL`, `PUBLISH`, `SUBSCRIBE`); memory providers emulate Redis semantics (JSON round-trip, `ttl()` returning `-1`/`-2`, glob matching) so both satisfy the same contract. |

### Behaviors the Architecture Guarantees

- All cache and pub/sub operations are **async** on both backends — there is no sync/async split to worry about.
- Namespacing is transparent: keys are stored as `rootKey + ":" + key`; channels as `channelPrefix + ":" + channel`. `activeSubscriptions()` and `PubSubMessage.channel` always report un-prefixed, user-facing names.
- Redis pub/sub uses **two dedicated ioredis connections**: `publisher` for `PUBLISH`, `subscriber` for `SUBSCRIBE`/`PSUBSCRIBE` (Redis requires a dedicated connection once it enters subscriber mode).
- Redis pattern deletion never uses `KEYS`; it uses `SCAN` (COUNT 100) with batched `DEL`, which is non-blocking and production-safe.
- Multiple handlers per channel **fan out in-process**; only the first handler registration for a channel triggers the underlying Redis `SUBSCRIBE`.
- Memory cache eviction is two-phase: lazy checks on access plus a periodic cleanup timer created with `.unref()` so it never keeps the Node.js process alive (`cleanupIntervalMs: 0` disables cleanup).
- Every provider implements `health()` (Redis: `PING`; memory: always `true`) and `shutdown()` (Redis: `quit()`; memory: clear store/timers) — both are wired into WebAFX by the plugins.

---

## Dependencies

### At a Glance

| Relationship | Package | Version | Required? | Purpose |
|--------------|---------|---------|-----------|---------|
| Runtime dependency | `ioredis` | `^6.0.0` | Yes | The only third-party runtime dependency; used exclusively by `RedisCacheProvider` and `RedisPubSubProvider`. |
| Peer dependency | `blendsdk/webafx` | `^5.x` | Optional (`peerDependenciesMeta`) | Needed only for the plugin factory functions. Standalone provider usage never touches it. |

### Details

- **`ioredis`** — the caching and pub/sub layers that talk to Redis are thin adapters over ioredis commands. The in-memory backends and both abstract base classes have zero third-party dependencies.
- **`blendsdk/webafx` (optional peer)** — declared via `peerDependenciesMeta.optional: true`. Only `cache-plugin.ts` and `pubsub-plugin.ts` import from it (they consume the `PluginDefinition` type). If you construct providers directly and never use `app.use(...)`, you do not need WebAFX installed.
- **No other `blendsdk/*` packages** are runtime dependencies — the two hierarchies are self-contained.

### What Depends On It (Consumers)

- **WebAFX applications** that register caching or pub/sub as plugin services (`app.use(redisCachePlugin(...))`, `app.use(createPubSubPlugin(...))`, etc.).
- **Any Node.js application** using the providers standalone, without WebAFX.
- The package is an internal workspace package (`"private": true` in the BlendSDK monorepo) and is distributed through the `blendsdk` umbrella package on npm rather than being published independently.

### Environment

- **Node.js >= 22.0.0**
- **ESM-only** (`"type": "module"`, `exports` map with `import` + `types` conditions) — there is no CommonJS entry point
- **TypeScript strict mode** — the public API is fully typed with generics; no `any` in the exported surface

### Development and Testing

- Unit and integration tests run on **vitest**; the repository maintains **contract test suites** that execute the identical test set against both backends to prove behavioral equivalence.
- `yarn test:fast` runs unit tests with **no Docker required**; `yarn test` starts a Docker-hosted Redis (port `6399` via docker-compose), runs the full suite including Redis integration tests, then tears it down.

---

## Minimum Example

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

interface User {
    id: string;
    name: string;
}

async function main(): Promise<void> {
    const cache = new MemoryCacheProvider({ rootKey: "MyApp", defaultTTL: 300 });

    // Cache-aside: fetches from the "database" only on a cache miss
    const user = await cache.getOrSet<User>("user:123", async () => {
        return { id: "123", name: "Alice" };
    });
    console.log(user.name); // "Alice"

    // Direct set/get; keys are namespaced as "MyApp:user:456"
    await cache.set("user:456", { id: "456", name: "Bob" });
    const cached = await cache.get<User>("user:456");
    console.log(cached?.name); // "Bob"

    await cache.shutdown();
}

await main();
```

This example is fully runnable as-is (Node.js >= 22, ESM). To move to a distributed backend, swap `MemoryCacheProvider` for `RedisCacheProvider` (add `host`/`port` or `url`) — the API is identical. To register the cache in a WebAFX application instead, pass the provider to `createCachePlugin(cache)`, or use the one-liner `memoryCachePlugin()` / `redisCachePlugin()`; the pub/sub hierarchy follows exactly the same pattern with `MemoryPubSubProvider` / `RedisPubSubProvider`, `subscribe()` / `publish()`, and `createPubSubPlugin()`.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
