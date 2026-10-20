> **Package**: `blendsdk/webafx-cache`

# webafx-cache Overview

> **License**: MIT (TrueSoftware B.V.)

---

## What It Is

`blendsdk/webafx-cache` is the application-wide caching and pub/sub messaging package for WebAFX applications. It ships two completely independent abstraction hierarchies — `CacheProvider` for key/value caching with TTL and namespace isolation, and `PubSubProvider` for typed, JSON-serialized publish/subscribe messaging — each with two interchangeable backends: a Redis implementation built on `ioredis` for production and multi-instance deployments, and a zero-dependency in-memory implementation for development, testing, and single-instance applications. Providers can be used standalone or registered in a WebAFX application through plugin factory functions that install them as application-wide singleton services with health-check and graceful-shutdown hooks.

---

## Key Features

### Caching (`CacheProvider` hierarchy)

- **Redis-like, fully async cache API** — `set`, `get`, `delete`, `exists`, `expire`, `ttl`, `deletePattern`, `clear`, plus `health` and `shutdown`; every method returns a Promise on every backend.
- **Cache-aside built in** — `getOrSet(key, factory, ttl?)` returns the cached value or produces, caches, and returns a new one; implemented once in the abstract base class.
- **TTL everywhere** — seconds-based TTLs with per-call overrides, a configurable `defaultTTL`, and Redis-convention `ttl()` semantics (`-1` = no expiry, `-2` = missing key).
- **Namespace isolation** — every key is transparently prefixed with the provider's `rootKey` (e.g. `MyApp:user:123`); `deletePattern()` and `clear()` are scoped strictly to that namespace and never touch other keys.
- **JSON-serialized values** — stored data is serialized on write and deserialized on read, so backends behave identically and consumers never share references with the store.

### Pub/Sub messaging (`PubSubProvider` hierarchy)

- **Typed messaging** — generic `PubSubMessage<T>` envelopes (`channel`, `data`, optional `pattern`) and `MessageHandler<T>` handlers that may be synchronous or asynchronous.
- **Exact and pattern subscriptions** — `subscribe()` / `unsubscribe()` for exact channels; `psubscribe()` / `punsubscribe()` for glob patterns (`*` = any sequence, `?` = single character).
- **Multiple handlers per channel** — fan-out to every registered handler; on Redis, a channel is subscribed once per process and shared by all local handlers.
- **Handler error isolation** — a throwing handler is caught and logged (via `safeInvoke`) and can never break other subscribers or the subscriber connection.
- **Transparent channel prefixing** — `channelPrefix` namespaces all channels while handlers and `activeSubscriptions()` always see unprefixed, user-facing names.

### Backends and WebAFX integration

- **Interchangeable, contract-tested backends** — Redis (`RedisCacheProvider`, `RedisPubSubProvider` via `ioredis`) and in-memory (`MemoryCacheProvider`, `MemoryPubSubProvider`, zero dependencies) share identical contracts, pinned by cross-backend contract test suites.
- **Production-safe Redis behavior** — pattern deletion uses `SCAN` with batched `DEL` (never `KEYS`); pub/sub runs on two dedicated connections (publisher + subscriber), as Redis requires.
- **One-liner plugins** — `redisCachePlugin()`, `memoryCachePlugin()`, `redisPubSubPlugin()`, `memoryPubSubPlugin()`; generic builders `createCachePlugin()` / `createPubSubPlugin()` accept any provider instance, including custom subclasses.
- **Environment-based factories** — `createCache()` and `createPubSub()` build a provider from a config object with a `type: 'redis' | 'memory'` discriminator; unknown types throw a descriptive error.
- **Declarative subscriptions** — `PubSubPluginOptions.subscriptions` registers channel/pattern handlers at plugin install time.
- **Multi-service support** — distinct `serviceName` values register multiple independent cache or pub/sub services in one application.
- **Lifecycle integration** — plugin installation registers the provider as an application-wide singleton, wires `health()` into the WebAFX health endpoint and `shutdown()` into graceful shutdown (default plugin priority: 30, overrideable).
- **Redis-free subpath** — `blendsdk/webafx-cache/memory` exposes the memory providers and Redis-free plugin builders without ever loading `ioredis`.

---

## When To Use

- **Application-wide caching in a WebAFX app** — memoize expensive database queries, external API calls, or computed results across requests and controllers.
- **Backend parity between environments** — the same application code runs on the in-memory backend in development/tests and on Redis in production; `createCache()` / `createPubSub()` select the backend from configuration.
- **Multi-instance deployments** — a shared Redis cache and cross-instance pub/sub so every node sees the same cached data and events.
- **Event-driven decoupling** — publish domain events (e.g. `order:created`, `audit:*`) and let any number of services react in real time with typed handlers.
- **Namespaced multi-tenancy or multi-concern setups** — isolate keys with `rootKey` and channels with `channelPrefix`; register several independent instances via distinct `serviceName` values.
- **Invalidation-heavy workloads** — targeted `delete()`, wildcard `deletePattern()`, and namespace-scoped `clear()`.
- **Tests without infrastructure** — the memory providers (or the `./memory` subpath) behave contract-identically to Redis, with no Docker or `ioredis` required.

**When it is not the right tool:**

- **Durable queues / guaranteed delivery** — pub/sub is fire-and-forget: messages published while no matching subscriber is connected are dropped and never replayed.
- **System-of-record storage** — cache entries expire, evict, or get cleared at any time; always keep authoritative data in a database.

---

## Architecture

The package deliberately ships two **parallel and completely independent** hierarchies. Caching is not built on pub/sub, and pub/sub does not use the cache — they share only the package, its conventions (JSON serialization, transparent prefixing, async APIs), and the plugin mechanics.

```text
blendsdk/webafx-cache  (main entry)
│
├── Caching hierarchy
│   ├── CacheProvider (abstract base)
│   │     · rootKey prefixing (buildKey / buildPattern)
│   │     · TTL resolution (resolveTTL)
│   │     · getOrSet() — cache-aside, implemented once for all backends
│   ├── MemoryCacheProvider      Map store · lazy + periodic eviction · zero dependencies
│   └── RedisCacheProvider       ioredis client · native SET ... EX / EXPIRE · SCAN + DEL
│
└── Pub/Sub hierarchy  (completely independent from caching)
    ├── PubSubProvider (abstract base)
    │     · channel prefixing and prefix stripping
    │     · safeInvoke() — handler error isolation
    ├── MemoryPubSubProvider     in-process handler maps · glob matching (*, ?) · JSON round-trip
    └── RedisPubSubProvider      two ioredis connections (publisher + subscriber) · native PSUBSCRIBE

Plugin factories (WebAFX integration):
    createCache()                  createPubSub()
    createCachePlugin(provider)    createPubSubPlugin(provider, options?)
    redisCachePlugin(config)       redisPubSubPlugin(config, options?)
    memoryCachePlugin(config)      memoryPubSubPlugin(config?, options?)

Redis-free subpath: blendsdk/webafx-cache/memory
    CacheProvider · PubSubProvider · MemoryCacheProvider · MemoryPubSubProvider
    createCachePlugin · createPubSubPlugin · memoryCachePlugin · memoryPubSubPlugin
    (importing this subpath never loads ioredis)
```

### Design Patterns

| Pattern | Where | Purpose |
|---------|-------|---------|
| **Template Method** | `CacheProvider`, `PubSubProvider` | Abstract base classes define the full contract and implement shared logic (`getOrSet`, `safeInvoke`, key/channel builders, TTL resolution); subclasses supply only backend-specific behavior. |
| **Strategy** | Redis vs. Memory providers | Interchangeable implementations behind one abstract interface — swapping backends changes no consuming code. Shared contract test suites pin identical behavior. |
| **Factory Method** | `createCache()`, `createPubSub()`, the one-liner plugin factories | Construct the right provider/plugin from a config object; `type` acts as the discriminator. |
| **Adapter** | `createCachePlugin()`, `createPubSubPlugin()` | Adapt any provider instance to the WebAFX plugin model: singleton service registration plus `health()` and `shutdown()` hooks. |
| **Singleton** | Plugin registration | One provider instance per `serviceName` serves the entire application — never per-request. |

### Key Design Invariants

- **All operations are async** on both hierarchies, giving every backend a uniform API.
- **Everything is JSON-serialized** — cache values and pub/sub payloads — so Memory and Redis behave identically and consumers never receive shared references.
- **Namespacing is transparent** — `rootKey` / `channelPrefix` are applied on write paths and stripped on read paths; user code always works with plain key and channel names.
- **Failures degrade safely** — unparseable cached JSON is treated as a cache miss; pub/sub handler errors are caught and logged per handler.
- **Redis operations are production-safe** — `SCAN`-based pattern deletion (never `KEYS`), batched `DEL`, and a dedicated subscriber connection (a cache provider uses one connection; a pub/sub provider uses two).
- **WebAFX is optional** — only the plugin integration modules reference `blendsdk/webafx` (type-only); providers work standalone.

### Entry Points

| Entry point | Exposes | Loads `ioredis`? |
|-------------|---------|------------------|
| `blendsdk/webafx-cache` | Full API: both hierarchies, Redis + Memory providers, all factories and plugin builders | Yes |
| `blendsdk/webafx-cache/memory` | Redis-free subset: `CacheProvider`, `PubSubProvider`, `MemoryCacheProvider`, `MemoryPubSubProvider`, `createCachePlugin`, `createPubSubPlugin`, `memoryCachePlugin`, `memoryPubSubPlugin`, and the memory/plugin types | No |

---

## Dependencies

### Runtime Dependencies

| Dependency | Kind | Version | Notes |
|------------|------|---------|-------|
| `ioredis` | dependency | `^6.0.0` | Used only by `RedisCacheProvider` and `RedisPubSubProvider`. It is evaluated when the **main entry** is imported; importing `blendsdk/webafx-cache/memory` never loads it. |
| `blendsdk/webafx` | peer dependency (**optional**) | internal (monorepo) | Needed only for the plugin integration APIs (functions returning `PluginDefinition`). Marked optional via `peerDependenciesMeta` — standalone provider usage requires no WebAFX. |

No other runtime dependencies: the in-memory backends are pure TypeScript with zero external packages.

### What Depends on It

- **Applications** consume the package directly to add caching and pub/sub to WebAFX apps or plain Node services.
- It is a **leaf package** in the BlendSDK monorepo — no other `blendsdk/*` library depends on it.

### Runtime and Toolchain

| Aspect | Value |
|--------|-------|
| Node.js | `>= 22.0.0` |
| Module system | ESM only (`"type": "module"`) |
| Build | `tsc` (TypeScript `^7.0.2`, strict mode) |
| Tests | Vitest `^4.1.10` (V8 coverage); Redis integration tests require Docker (Redis on port 6399) |
| Node types | `@types/node` `^26.1.2` |

---

## Minimum Example

The shortest complete, runnable program — a standalone in-memory cache using the cache-aside pattern. No WebAFX, no Redis, no Docker required (ESM with top-level await):

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

interface User {
    id: number;
    name: string;
}

const cache = new MemoryCacheProvider({ rootKey: 'MyApp', defaultTTL: 300 });

// Cache-aside: on a miss the factory runs (stand-in for a DB query);
// on a hit the cached value is returned and the factory is skipped.
const user = await cache.getOrSet<User>('user:123', async () => {
    return { id: 123, name: 'Alice' };
});

console.log(user.name); // 'Alice'
console.log(await cache.ttl('user:123')); // ~300

await cache.shutdown();
```

Inside a WebAFX application, the same capability is registered with a one-liner plugin instead (Redis-backed variant shown):

```typescript fragment
app.use(redisCachePlugin({
    rootKey: 'MyApp',
    host: 'localhost',
    port: 6379,
    defaultTTL: 300,
}));
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
