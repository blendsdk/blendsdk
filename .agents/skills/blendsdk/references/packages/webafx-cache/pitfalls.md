> **Package**: `blendsdk/webafx-cache`

# webafx-cache Best Practices

This document collects the do's, don'ts, and hard-won lessons for `blendsdk/webafx-cache`, drawn from the package's contract tests and the actual behavior of its Redis and in-memory backends. Each practice shows the wrong approach next to the correct one and explains *why* the wrong approach fails. Fragments (marked `typescript fragment`) elide non-essential context such as route harnesses and data-layer functions; complete examples include all imports and run as-is.

---

## Do / Don't Pairs

### 1. Create providers as application-wide singletons — don't instantiate them per request

A provider is not a lightweight handle: constructing one builds real state — an in-memory store plus a cleanup timer, or live ioredis connections (one for a cache provider, two for a pub/sub provider). A per-request provider starts *empty*, so every lookup is a guaranteed miss, and its resources are never released: cleanup timers accumulate, and Redis connections leak until the process runs out of file descriptors. The one-liner plugin factories (`redisCachePlugin()`, `memoryCachePlugin()`) create their provider eagerly at call time, so calling those inside handlers has exactly the same effect.

❌ Wrong:

```typescript fragment
// New provider — and, with Redis, a new connection — on every request.
// Nothing is ever cached, and resources are never released.
app.get('/products/:id', async (req, res) => {
    const cache = new MemoryCacheProvider({ rootKey: 'Products' });
    const product = await cache.get(`product:${req.params.id}`);
    res.json(product ?? null);
});
```

✅ Correct:

```typescript fragment
// Created once for the whole application and shared by every request
const cache = new MemoryCacheProvider({ rootKey: 'Products' });

app.get('/products/:id', async (req, res) => {
    const product = await cache.get(`product:${req.params.id}`);
    res.json(product ?? null);
});
```

In a WebAFX app, `app.use(memoryCachePlugin({ rootKey: 'Products' }))` does this once for you and additionally wires `health()` and `shutdown()` into the framework lifecycle.

### 2. Set TTLs deliberately — don't let entries live forever by omission

`DEFAULT_TTL` is `0`, which the providers interpret as *no expiry*. Entries without a TTL never reflect upstream changes (a deleted user stays "cached" indefinitely) and never release memory or Redis space — only an explicit `delete()`, `deletePattern()`, or `clear()` removes them. A TTL is the safety net for every invalidation call your code forgets to make, and it bounds both staleness and memory growth.

❌ Wrong:

```typescript fragment
// defaultTTL omitted → falls back to DEFAULT_TTL = 0 (no expiry).
// Every entry persists until someone deletes it manually.
const cache = new RedisCacheProvider({ rootKey: 'Users', host: 'localhost' });

await cache.set(`user:${id}`, user);
```

✅ Correct:

```typescript fragment
const cache = new RedisCacheProvider({
    rootKey: 'Users',
    host: 'localhost',
    defaultTTL: 300, // every entry expires after 5 minutes unless overridden
});

await cache.set(`user:${id}`, user);            // 300s
await cache.set(`user:${id}:stats`, stats, 30); // tighter TTL for fast-changing data
```

### 3. Let the provider namespace your keys — don't prepend `rootKey` yourself

`buildKey()` already prepends `rootKey` + `KEY_SEPARATOR` to every key, and `buildPattern()` does the same for patterns. Hand-prefixing double-namespaces entries (`MyApp:MyApp:user:123`) and makes correctness depend on every call site agreeing to prefix: the first un-prefixed `get()` reads a *different* key and always reports a miss. The bug fails silently — no error, just a cache that never hits (or two parallel entries for the same entity), plus confusing keys when you inspect Redis directly.

❌ Wrong:

```typescript fragment
const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });

await cache.set('MyApp:user:123', user); // stored as "MyApp:MyApp:user:123"

const cached = await cache.get('user:123'); // different key → always undefined
```

✅ Correct:

```typescript fragment
const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });

await cache.set('user:123', user); // stored as "MyApp:user:123"

const cached = await cache.get('user:123'); // hit
await cache.deletePattern('user:*');        // matches "MyApp:user:123"
```

### 4. Detect misses with one round trip (`get()` / `getOrSet()`) — don't probe with `exists()` + `get()`

`exists()` followed by `get()` doubles the round trips on every hit, and the two calls are not atomic: if the key expires (or another process deletes it) between them, `get()` returns `undefined` even though `exists()` just said `true`. `get()` alone answers hit-or-miss in one call, and `getOrSet()` implements the whole cache-aside flow — produce, store, return — through one code path. Note that `undefined` is not a storable value, so a read returning `undefined` is *always* a miss; factories passed to `getOrSet()` must return a concrete, JSON-serializable value.

❌ Wrong:

```typescript fragment
// Two round trips, plus a time-of-check/time-of-use race:
// the key can expire between the calls
if (await cache.exists(`user:${id}`)) {
    const cached = await cache.get(`user:${id}`);
    if (cached !== undefined) {
        return cached;
    }
}
return loadUserFromDatabase(id);
```

✅ Correct:

```typescript fragment
// One round trip on a hit; factory + store on a miss
return await cache.getOrSet(`user:${id}`, () => loadUserFromDatabase(id), 300);
```

### 5. Await every cache and pub/sub operation — don't fire-and-forget

Every provider method is async. Sequential **awaited** commands on the same provider are ordered, but a floating `cache.set()` is not: the next `get()` may run before the write is stored. Floating promises also swallow rejections — a failed Redis write disappears silently, and with Node's default unhandled-rejection behavior it can terminate the process. The same discipline applies to pub/sub: messages are only delivered once the subscription is actually registered, and `publish()`'s subscriber count is lost if you don't await it.

❌ Wrong:

```typescript fragment
cache.set(`user:${id}`, user); // floating — not necessarily stored yet

const fresh = await cache.get(`user:${id}`); // may miss the write just attempted
```

✅ Correct:

```typescript fragment
await cache.set(`user:${id}`, user, 300);

const fresh = await cache.get(`user:${id}`); // ordered after the write
```

### 6. Register subscriptions once at startup — don't subscribe/unsubscribe per request

Pub/sub is fire-and-forget: a message published a moment before your subscription is registered is gone forever, so per-request subscribing races with the very replies the request is waiting for. Worse, `unsubscribe(channel)` is not "remove my handler" — it removes **all** handlers for that channel on both backends (and, on Redis, sends `UNSUBSCRIBE` for the shared subscription). One request finishing its cleanup silently disables every other subscriber on that channel. Handlers registered per request and never removed simply accumulate in the handler map, leaking closures and fanning every message out to dead handlers.

❌ Wrong:

```typescript fragment
// Per-request subscribe: leaks a handler on every call, races with replies,
// and a single unsubscribe would kill all handlers on the channel
app.get('/orders/:id/status', async (req, res) => {
    const channel = `order:${req.params.id}:status`;
    await pubsub.subscribe(channel, (msg) => res.json(msg.data));
});
```

✅ Correct:

```typescript fragment
// Registered once at plugin install time — stable for the application's
// lifetime, no SUBSCRIBE/UNSUBSCRIBE churn, nothing to leak
app.use(
    redisPubSubPlugin(
        { host: 'localhost', channelPrefix: 'MyApp' },
        {
            subscriptions: [
                {
                    pattern: 'order:*:status',
                    handler: async (msg) => {
                        console.log(`Status update on ${msg.channel}:`, msg.data);
                    },
                },
            ],
        }
    )
);
```

### 7. Store JSON-safe, explicit shapes — don't cache live objects

Storage on both backends is a JSON round-trip. `Date` comes back as a string, `Map`/`Set` come back as `{}`, `undefined` and function properties are dropped, `BigInt` and circular references throw, and the returned object is always a fresh copy — never the same reference, never a class instance. Caching a "rich" object doesn't fail loudly; it silently stores a lossy copy and hands you corrupted data on the next read.

❌ Wrong:

```typescript fragment
await cache.set(`session:${id}`, {
    createdAt: new Date(),                        // read back as a string, not a Date
    roles: new Set(['admin']),                    // read back as {}
    touch: () => refreshSession(id),              // silently dropped by JSON
});
```

✅ Correct:

```typescript fragment
interface SessionRecord {
    createdAt: string; // ISO-8601 string
    roles: string[];   // plain array, not a Set
}

const record: SessionRecord = {
    createdAt: new Date().toISOString(),
    roles: ['admin'],
};

await cache.set(`session:${id}`, record);
```

On read, revive deliberately: `const createdAt = new Date(record.createdAt);`.

### 8. Degrade gracefully when the backend fails — don't make the cache a hard request dependency

Redis is a separate service on the network: it can time out, fail over, or reject commands, and the provider propagates those errors (which is correct — you need to know). But if request handlers don't catch them, a cache outage becomes a *full* outage even though the database — your source of truth — is healthy. Treat both reads and writes as best-effort accelerators, and keep `connectTimeout` low (default 5000 ms) so a dead Redis fails fast instead of stalling every request for seconds.

❌ Wrong:

```typescript fragment
// Any Redis hiccup rejects the whole request — the cache is now a SPOF
const user = await cache.get(`user:${id}`);
return user ?? await loadUserFromDatabase(id);
```

✅ Correct:

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

async function loadUserFromDatabase(id: number): Promise<User> {
    return { id, name: 'Alice' };
}

async function loadUser(id: number): Promise<User> {
    try {
        const cached = await cache.get<User>(`user:${id}`);
        if (cached !== undefined) {
            return cached;
        }
    } catch {
        // Cache read failed — fall through to the source of truth
    }

    const user = await loadUserFromDatabase(id);

    try {
        await cache.set(`user:${id}`, user);
    } catch {
        // Cache write failed — the request still succeeds
    }

    return user;
}
```

### 9. Own the lifecycle — call `shutdown()` once, or let the plugin do it

Redis providers hold open sockets (two for pub/sub). Without `shutdown()`, a standalone script or worker never exits, and long-lived processes leak connections whenever providers are recreated. `shutdown()` is one-shot: `quit()` on an already-closed ioredis connection rejects — which is exactly why test suites wrap their cleanup in try/catch. In WebAFX, the plugin already registers `shutdown()` as the service `dispose` *and* as the plugin shutdown hook; calling it yourself on top of that, or letting two subsystems both own the provider, produces double-close errors.

❌ Wrong:

```typescript fragment
const cache = new RedisCacheProvider({ rootKey: 'Worker', host: 'localhost' });
await cache.set('job:1', { status: 'done' });
// No shutdown: the ioredis socket keeps the process alive
```

✅ Correct:

```typescript fragment
const cache = new RedisCacheProvider({ rootKey: 'Worker', host: 'localhost' });
try {
    await cache.set('job:1', { status: 'done' });
} finally {
    await cache.shutdown(); // closed exactly once, even on failure
}
```

In a WebAFX app you don't call `shutdown()` at all — `app.use(redisCachePlugin(...))` wires disposal into the framework lifecycle.

---

## Anti-Patterns

These mistakes recur in consumer code and in the package's own test suites. Each one is subtle: it fails silently, or only in production.

### 1. Using `unsubscribe()` as per-handler cleanup

`unsubscribe(channel)` deletes the *entire* handler set for a channel on both backends — there is no per-handler removal API. Teams that treat it as "remove my callback" build features that disable each other: the first subsystem to shut down takes every other subscriber with it (and on Redis, drops the shared subscription, so nothing is delivered until someone re-subscribes). Treat handler registration as append-only for the application's lifetime, and route/filter messages *inside* the handler instead.

### 2. Treating pub/sub as a durable queue

`publish()` is fire-and-forget on both backends: with no subscriber connected, the message simply disappears and the call resolves with `0`. There is no replay, acknowledgment, or retry — and handler errors are deliberately swallowed by `safeInvoke` (logged, then execution continues), so a failed handler is never redelivered. Put work that must not be lost in a real queue or outbox, and use pub/sub for notifications where a missed message is recoverable from the source of truth.

### 3. Running broad invalidation in hot paths

`clear()` and wide patterns like `deletePattern('*')` are namespace-wide sweeps: on Redis they SCAN the keyspace in batches (100 keys per iteration) with batched `DEL`; in memory they iterate the entire store. Calling them from request handlers — or from timers that fire often — creates periodic latency spikes and guarantees misses for everything. Invalidate the smallest set you can: `delete('user:123')` → `deletePattern('user:123:*')` → only then consider `clear()` as an administrative reset.

### 4. Changing a cached value's shape under the same key

`get<T>()` is a compile-time assertion, not runtime validation — the stored JSON has no idea what `T` was when it was written. After a deploy renames a field or adds a required property, stale entries deserialize "successfully" into the new type and hand downstream code objects with `undefined` members. Version your keys (`user:v2:123`), or keep TTLs short enough that old shapes age out during deploys. (The contract tests sidestep this entire class of problem by giving every provider a unique `rootKey` per run.)

### 5. Running the memory backend across multiple instances

The in-memory providers are per-process: each replica has a private store and a private subscriber registry. Writes and invalidations on replica A are invisible to replica B, and published messages never leave the process — the classic symptom is "works locally, inconsistent behind the load balancer". Anything with more than one process (horizontal scaling, worker fleets, serverless) needs the Redis backend. Use `createCache()` / `createPubSub()` to choose the backend from configuration instead of hard-coding either one, so development and production don't diverge in behavior.

### 6. Sharing a `rootKey` / `channelPrefix` across environments or applications

Prefixes provide namespacing, not ownership. When staging and production point at the same Redis with the same `rootKey`, a staging `clear()` deletes production entries and both environments fight over the same keys; with a shared `channelPrefix`, a staging publish is delivered to production subscribers. Give every environment — and every independent application — its own prefix. The contract tests generate a unique `rootKey` and `channelPrefix` per run precisely because shared namespaces produce cross-contamination.

---

## Performance Tips

Each tip below explains the concrete cost it removes.

### 1. Keep cached values small and bounded

Redis processes commands on a single thread: a multi-megabyte value means that much data over the wire on every read and write, and blocks other clients while it transfers. In Node, every hit additionally pays a full `JSON.parse` — even if you only needed one field. Cache per-entity entries and small view models rather than whole result sets, and cap arrays (e.g., `slice(0, 100)`) before caching. This also keeps stampede recovery cheap when a key does expire.

### 2. Add jitter to TTLs

Many entries written in the same batch (cache warm-up after a deploy, a bulk import) with identical TTLs expire in the same second. The resulting synchronized misses — a cache avalanche — hammer the database all at once. Spread expirations by a small random window:

```typescript fragment
// 300s plus up to 30s of jitter so a whole batch does not expire together
const ttlSeconds = 300 + Math.floor(Math.random() * 30);
await cache.set(`user:${id}`, user, ttlSeconds);
```

### 3. Deduplicate concurrent misses with single-flight

`getOrSet()` has no locking: if a hot key expires and 200 requests miss simultaneously, the factory runs up to 200 times (a cache stampede). For expensive factories, wrap `getOrSet()` with an in-process in-flight map so concurrent misses share one invocation:

```typescript
import { CacheProvider } from 'blendsdk/webafx-cache';

/**
 * Single-flight wrapper around getOrSet: concurrent misses for the same key
 * share one factory invocation instead of each running their own.
 */
function createSingleFlight(cache: CacheProvider) {
    const inFlight = new Map<string, Promise<unknown>>();

    return function getOrSetOnce<T>(
        key: string,
        factory: () => Promise<T>,
        ttlSeconds?: number
    ): Promise<T> {
        const existing = inFlight.get(key);
        if (existing !== undefined) {
            return existing as Promise<T>;
        }

        const pending = cache.getOrSet<T>(key, factory, ttlSeconds).finally(() => {
            inFlight.delete(key);
        });

        inFlight.set(key, pending);
        return pending;
    };
}
```

If the factory rejects, all waiters see the rejection and the key is cleaned up, so the next attempt retries. Note this deduplicates **per process**; with N replicas, up to N factory calls can still run — jittered TTLs (tip 2) reduce how often that happens.

### 4. Issue independent operations concurrently

Every `get`/`set` is an independent command; sequentially awaiting ten of them pays ten full network round trips. When the results don't depend on each other, overlap them:

```typescript fragment
// Three independent lookups — one round trip of latency, not three
const [user1, user2, user3] = await Promise.all([
    cache.get('user:1'),
    cache.get('user:2'),
    cache.get('user:3'),
]);
```

There is no multi-key (`MGET`-style) API in this package, so `Promise.all` is the way to batch. Keep it to genuinely independent operations and bounded concurrency — don't fan out thousands of commands per request.

### 5. Subscribe once, and keep patterns narrow

Registering three handlers for one channel sends a single `SUBSCRIBE` and fans out locally through a `Set` — no extra network traffic per handler. But per-request `SUBSCRIBE`/`UNSUBSCRIBE` churn costs round trips and risks dropped messages, and an overly broad pattern (e.g., `psubscribe('*')`) makes the client receive and `JSON.parse` *every* message in the namespace, including ones it will ignore. Prefer exact channel subscriptions for high-volume streams; use `psubscribe('order:*')`-style patterns for genuinely cross-cutting needs like audit trails.

### 6. Import the Redis-free subpath where Redis isn't needed

Tests, CLIs, and single-instance tools that use the in-memory providers should import from `blendsdk/webafx-cache/memory`. The main entry evaluates `ioredis` at load time; the subpath never loads it — this is verified by the package's own specification test (ST-38). The result is faster startup and a smaller dependency graph.

```typescript fragment
// Never loads ioredis
import { MemoryCacheProvider, memoryCachePlugin } from 'blendsdk/webafx-cache/memory';
```

### 7. Keep the memory cleanup sweep enabled in long-running processes

`MemoryCacheProvider` reclaims expired entries two ways: lazily on access, and via a periodic sweep (`cleanupIntervalMs`, default 60 000 ms). Keys that expire but are *never read again* are only reclaimed by the sweep — disable it (`cleanupIntervalMs: 0`) and they accumulate forever. Setting `0` is useful in tests for deterministic behavior, but leave the default in servers. The sweep timer is `unref()`ed, so it never keeps the Node.js process alive.

```typescript fragment
// Default behavior: expired-but-unread entries are swept every minute
const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });
```

---

## Security Considerations

The providers are a transparent layer over Redis (or process memory): they add no authentication, encryption, or payload validation. Everything below is the application's responsibility.

### Cached data is stored in plaintext

Values are JSON strings — no encryption, masking, or redaction. Anything you cache is readable by anyone with access to the backend. Keep credentials, session tokens, and unnecessary PII out of the cache; when sensitive data must be cached, require an authenticated, network-isolated Redis (use `password`, and a `rediss://` URL for TLS) and short TTLs to bound the exposure window.

### Never log raw connection configuration

`RedisConnectionConfig` can carry a `password` and a `url` that embeds credentials (`redis://:secret@host:6379`). Log the host and port — never the config object or the URL.

```typescript fragment
// Safe: credentials never reach the log
console.info(`Cache backend: ${config.host ?? 'localhost'}:${config.port ?? 6379}`);
```

### `rootKey` and `channelPrefix` are collision-avoidance, not access control

Any client connected to the same Redis instance can read and write every key and publish to every channel regardless of prefix — and Redis database indexes (`db`) are not a security boundary either. If two trust domains must share an instance, isolate them with separate instances, ACL-restricted users, or network segmentation; a clever prefix is not isolation.

### Never interpolate untrusted input into keys or patterns

Keys and patterns are structural, not just strings: a `*` that reaches `deletePattern()` deletes everything it matches, and `:` characters let user input masquerade as part of your key scheme. Validate every dynamic component against an allowlist before composing a key or pattern.

```typescript fragment
if (!/^[A-Za-z0-9_-]+$/.test(userId)) {
    throw new Error('Invalid user id for cache key');
}
await cache.deletePattern(`sessions:${userId}:*`);
```

### Treat cache hits and pub/sub payloads as untrusted input

Cache values can be stale, written by a previous deploy, or injected by any client that can reach the backend — `get<T>()` validates nothing. In particular, don't make authorization decisions from entries keyed only by resource ID: a per-user visibility decision cached as `authz:doc:42` leaks between users. Key by subject (`authz:user:1:doc:42`) and prefer TTL-bounded revalidation. Likewise, pub/sub handlers see messages from *any* publisher on the channel; validate the payload shape before acting on it.

### Keep secrets out of channel and key names

Handler errors are logged by `safeInvoke` together with the channel name, and channel/key names surface in Redis tooling and monitoring. Don't embed tokens, email addresses, or other sensitive identifiers in channel or key names.

---

# webafx-cache Testing Patterns

This document explains how `blendsdk/webafx-cache` is tested — and how you should test code that uses it. Every pattern here is taken from the package's own suite under `tests/`, which is the source of truth. Two tiers exist: a **unit tier** that runs entirely on the in-memory backends with zero infrastructure, and an **integration tier** that runs against dockerized Redis and self-skips when the container is unavailable.

---

## Test Setup

### Test Suite Layout

| File | Covers | Requires Docker? |
|------|--------|------------------|
| `tests/abstract-contract.test.ts` | Full `CacheProvider` contract, run against both Memory and Redis backends | Redis suite auto-skips without Docker |
| `tests/ttl-behavior.test.ts` | Ten TTL timing scenarios against both cache backends | Redis suite auto-skips |
| `tests/memory-cache-provider.test.ts` | `MemoryCacheProvider` unit tests: JSON types, namespacing, cleanup interval | No |
| `tests/redis-cache-provider.test.ts` | `RedisCacheProvider` integration: raw key layout, SCAN batching, URL connections, lifecycle | Yes (auto-skips) |
| `tests/pubsub-contract.test.ts` | Full `PubSubProvider` contract, run against both Memory and Redis backends | Redis suite auto-skips |
| `tests/memory-pubsub.test.ts` | `MemoryPubSubProvider` unit tests: glob matching, fan-out, error isolation, prefix transparency | No |
| `tests/redis-pubsub.test.ts` | `RedisPubSubProvider` integration: real delivery, `psubscribe`, fan-out, shutdown | Yes (auto-skips) |
| `tests/cache-plugin.test.ts` | Cache plugin builders and the `createCache()` factory | No |
| `tests/pubsub-plugin.test.ts` | Pub/Sub plugin builders and the `createPubSub()` factory | No |
| `tests/memory-subpath.spec.test.ts` | `./memory` subpath loads without evaluating `ioredis` | No |
| `tests/memory-subpath.impl.test.ts` | `./memory` subpath re-export identity and plugin wiring | No |

### Running the Tests

| Script | Command | Purpose |
|--------|---------|---------|
| `test:fast` | `vitest run --reporter=verbose` | Unit tier only — Redis suites self-skip |
| `test:watch` | `vitest watch --reporter=verbose` | Watch mode |
| `test:coverage` | `vitest run --coverage` | V8 coverage via `@vitest/coverage-v8` (start Docker for full Redis coverage) |
| `test` | `docker:down` → `docker:up` → `vitest run` → `docker:down` | Full suite with the complete Docker lifecycle |
| `docker:up` / `docker:down` / `docker:logs` | `docker-compose -p webafx-cache -f ./docker/docker-compose${MODE}.yml ...` | Manage the `redis-test` container; `MODE` selects a compose variant |

### Docker Dependency

The Redis integration suites connect to **dockerized Redis on port 6399** — the compose file maps the container there so it never clashes with a local Redis on 6379. `docker:up` starts the `redis-test` service and sleeps 5 seconds before Vitest runs; `docker:down` tears the container down with `-v --remove-orphans`. `docker:logs` streams the `redis-test` service log for debugging.

You never need to make Docker mandatory: every Redis suite probes availability first and **self-skips** when the container is down (see [Integration Testing](#integration-testing)). That is why `test:fast` works with no infrastructure at all.

No custom Vitest configuration is required — tests live in `tests/*.test.ts`, run in the default Node environment, and Vitest's default 5-second per-test timeout is sufficient because the timing-sensitive suites use 1–3 second TTLs with explicit margins.

### Required Imports

| Symbol | Module | Used for |
|--------|--------|----------|
| `describe`, `it`, `expect`, `beforeEach`, `afterEach`, `beforeAll`, `vi` | `vitest` | Suite structure, assertions, lifecycle, spies and mocks |
| `Redis` | `ioredis` | Redis availability probe and raw key inspection |
| `CacheProvider`, `MemoryCacheProvider`, `RedisCacheProvider` | `blendsdk/webafx-cache` | Cache suites |
| `PubSubProvider`, `MemoryPubSubProvider`, `RedisPubSubProvider` | `blendsdk/webafx-cache` | Pub/Sub suites |
| `PubSubMessage`, `MessageHandler` (type-only) | `blendsdk/webafx-cache` | Typed handler signatures |
| `createCachePlugin`, `createPubSubPlugin`, `memoryCachePlugin`, `memoryPubSubPlugin`, `redisCachePlugin`, `redisPubSubPlugin`, `createCache`, `createPubSub` | `blendsdk/webafx-cache` | Plugin and factory suites |

A representative top-of-file import block:

```typescript
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { Redis } from "ioredis";
import {
    CacheProvider,
    MemoryCacheProvider,
    RedisCacheProvider,
} from "blendsdk/webafx-cache";
```

> **In-repo note**: The suites shipped inside this package import implementation files directly (for example `../src/abstract-cache-provider.js`) because they run against sources. The examples in this document import from the public entry points — `blendsdk/webafx-cache` and `blendsdk/webafx-cache/memory` — which is what consumer tests should use.

### Test Helpers

These helpers appear throughout the suite. The examples in later sections assume they are available in the same test file.

#### delay()

Real-time TTL testing uses a plain promise-based delay — no fake timers anywhere, because Redis manages TTL server-side and the memory provider compares against `Date.now()`:

```typescript
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
```

#### Unique Namespace Keys

Every provider instance created during a test run gets a unique `rootKey` (or channel prefix) so tests never interfere with each other — even when the Redis contract suites run concurrently. A per-suite counter is combined with `Date.now()` for Redis:

```typescript
let memoryCounter = 0;
let redisCounter = 0;

const memoryProvider = new MemoryCacheProvider({
    rootKey: `Contract_Mem_${++memoryCounter}`,
    cleanupIntervalMs: 0,
});

const redisProvider = new RedisCacheProvider({
    host: "localhost",
    port: 6399,
    rootKey: `Contract_Redis_${++redisCounter}_${Date.now()}`,
});
```

#### Cleanup Registry

Providers that create timers and connections must always be shut down. The suites keep a registry array and drain it in `afterEach`, tolerating errors because a connection may already be closed:

```typescript
const providersToCleanup: CacheProvider[] = [];

afterEach(async () => {
    for (const provider of providersToCleanup) {
        try {
            await provider.shutdown();
        } catch {
            // Ignore shutdown errors in cleanup
        }
    }
    providersToCleanup.length = 0;
});
```

#### Awaiting Pub/Sub Delivery

Pub/Sub tests cannot assert synchronously. Three helpers cover all delivery-awaiting scenarios. `settle()` flushes pending microtasks/timers and gives Redis time to establish subscriptions:

```typescript
function settle(ms = 150): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
```

`waitForMessage()` resolves with the first delivered envelope, and rejects on timeout so a hung test fails instead of passing silently:

```typescript
function waitForMessage<T = unknown>(timeout = 2000): {
    promise: Promise<PubSubMessage<T>>;
    handler: MessageHandler<T>;
} {
    let resolve: (msg: PubSubMessage<T>) => void;
    const promise = new Promise<PubSubMessage<T>>((r, reject) => {
        resolve = r;
        setTimeout(() => reject(new Error("Timeout waiting for message")), timeout);
    });
    const handler: MessageHandler<T> = (msg) => resolve!(msg);
    return { promise, handler };
}
```

`collectMessages()` accumulates a fixed number of messages and resolves once the expected count arrives:

```typescript
function collectMessages<T = unknown>(count: number, timeout = 2000): {
    promise: Promise<PubSubMessage<T>[]>;
    handler: MessageHandler<T>;
} {
    const messages: PubSubMessage<T>[] = [];
    let resolve: (msgs: PubSubMessage<T>[]) => void;
    const promise = new Promise<PubSubMessage<T>[]>((r, reject) => {
        resolve = r;
        setTimeout(() => reject(new Error(`Timeout: received ${messages.length}/${count}`)), timeout);
    });
    const handler: MessageHandler<T> = (msg) => {
        messages.push(msg);
        if (messages.length >= count) resolve!(messages);
    };
    return { promise, handler };
}
```

---

## Unit Testing

The unit tier runs with **zero infrastructure** on the in-memory backends. Both `MemoryCacheProvider` and `MemoryPubSubProvider` are pure TypeScript with no external dependencies, and they behave contract-identically to their Redis counterparts (pinned by the cross-backend contract suites described later). Because they perform a JSON round-trip like Redis, values returned from the cache are fresh copies — a property unit tests should actively verify.

Three rules keep unit tests deterministic:

1. **Disable the cleanup interval** — pass `cleanupIntervalMs: 0` to `MemoryCacheProvider`. The provider then relies on lazy eviction only (checked on `get`/`exists`/`ttl`/`expire`), so tests never race a periodic timer.
2. **Use real timers with short TTLs** — TTL tests use 1–3 second TTLs plus roughly +200 ms margins. Fake timers are not used anywhere in the suite.
3. **Always shut down providers** — `shutdown()` stops the cleanup timer and clears the store; the cleanup registry above takes care of this.

### Unit Testing Consumer Code

When testing a service that depends on a cache, inject a real `MemoryCacheProvider` — do not mock the class. Assert observable behavior: what landed in the cache and what the service returns on a hit.

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryCacheProvider } from "blendsdk/webafx-cache";
import type { CacheProvider } from "blendsdk/webafx-cache";

interface User {
    id: number;
    name: string;
}

class UserRepository {
    constructor(private readonly cache: CacheProvider) {}

    async getUser(id: number): Promise<User> {
        return this.cache.getOrSet<User>(
            `user:${id}`,
            async () => {
                // Stand-in for an expensive database query
                return { id, name: "Alice" };
            },
            60
        );
    }
}

describe("UserRepository", () => {
    let cache: MemoryCacheProvider;
    let repository: UserRepository;

    beforeEach(() => {
        cache = new MemoryCacheProvider({
            rootKey: "UserRepoTest",
            cleanupIntervalMs: 0,
        });
        repository = new UserRepository(cache);
    });

    afterEach(async () => {
        await cache.shutdown();
    });

    it("should cache the produced user under the user:<id> key", async () => {
        const user = await repository.getUser(123);

        expect(user).toEqual({ id: 123, name: "Alice" });
        // The value really is in the cache under the plain (unprefixed) key
        expect(await cache.get<User>("user:123")).toEqual(user);
    });

    it("should serve a subsequent call from the cache", async () => {
        await cache.set<User>("user:123", { id: 123, name: "FromCache" });

        const user = await repository.getUser(123);

        expect(user.name).toBe("FromCache");
    });
});
```

### Unit Testing the Providers Directly

Provider-level unit tests use a shared fixture object covering every JSON-serializable type. The same fixture is reused by the Redis integration suites, which is how backend parity is enforced:

```typescript
const TEST_VALUES = {
    string: "hello world",
    number: 42,
    float: 3.14,
    boolean: true,
    null: null as null,
    object: { name: "John", age: 30, nested: { active: true } },
    array: [1, "two", { three: 3 }, [4, 5]],
};
```

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

describe("MemoryCacheProvider", () => {
    let cache: MemoryCacheProvider;

    beforeEach(() => {
        cache = new MemoryCacheProvider({ rootKey: "Test", cleanupIntervalMs: 0 });
    });

    afterEach(async () => {
        await cache.shutdown();
    });

    it("should round-trip an object value", async () => {
        await cache.set("key1", { name: "John", age: 30 });
        const result = await cache.get<{ name: string; age: number }>("key1");
        expect(result).toEqual({ name: "John", age: 30 });
    });

    it("should return a deep copy via JSON serialization", async () => {
        const original = { count: 1, items: [1, 2, 3] };
        await cache.set("key1", original);

        // Mutating the original must not affect the cached value
        original.count = 999;
        original.items.push(4);

        const result = await cache.get<typeof original>("key1");
        expect(result).toEqual({ count: 1, items: [1, 2, 3] });
    });
});
```

---

## Integration Testing

### The Redis Availability Gate

Every Redis suite follows the same pattern: a single `beforeAll` probe checks whether the dockerized Redis on port 6399 responds, and a module-scoped `redisAvailable` flag gates the tests. When Docker is down, the suites skip instead of failing — this is what makes `test:fast` usable without infrastructure.

```typescript
import { beforeAll } from "vitest";
import { Redis } from "ioredis";

const REDIS_CONFIG = {
    host: "localhost",
    port: 6399,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
};

let redisAvailable = false;

beforeAll(async () => {
    const probe = new Redis({ ...REDIS_CONFIG, lazyConnect: true, maxRetriesPerRequest: 0 });
    try {
        await probe.connect();
        redisAvailable = (await probe.ping()) === "PONG";
    } catch {
        redisAvailable = false;
    } finally {
        try {
            await probe.quit();
        } catch {
            // Ignore quit errors during availability probing
        }
    }

    if (!redisAvailable) {
        console.warn("Redis not available on port 6399 — skipping Redis integration tests");
    }
});
```

> **Note**: The probe imports `ioredis` directly to use raw connection semantics — `lazyConnect` and `maxRetriesPerRequest: 0` — so an unreachable Redis fails fast instead of retrying in the background. If you don't want that import in a consumer project, you can gate on `await new RedisCacheProvider({ ...REDIS_CONFIG, rootKey: "Probe" }).health()` instead.

### Gating Styles

Two guard styles are used, depending on structure:

- **Per-test early return** — regular `describe` blocks start each Redis test with `if (!redisAvailable) return;`, and `beforeEach`/`afterEach` return early too.
- **Suite-level `shouldSkip`** — the parameterized contract suites (see below) accept a `shouldSkip?: () => boolean` parameter and check it in the lifecycle hooks and each test.

### Full Redis Integration Example

```typescript
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { Redis } from "ioredis";
import { RedisCacheProvider } from "blendsdk/webafx-cache";

const REDIS_CONFIG = {
    host: "localhost",
    port: 6399,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
};

let redisAvailable = false;

beforeAll(async () => {
    const probe = new Redis({ ...REDIS_CONFIG, lazyConnect: true, maxRetriesPerRequest: 0 });
    try {
        await probe.connect();
        redisAvailable = (await probe.ping()) === "PONG";
    } catch {
        redisAvailable = false;
    } finally {
        try {
            await probe.quit();
        } catch {
            // Ignore quit errors during availability probing
        }
    }
});

describe("RedisCacheProvider (integration)", () => {
    let cache: RedisCacheProvider;

    beforeEach(async () => {
        if (!redisAvailable) return;
        cache = new RedisCacheProvider({
            ...REDIS_CONFIG,
            rootKey: `IT_${Date.now()}`,
        });
        // Clean up any leftover keys from previous test runs
        await cache.clear();
    });

    afterEach(async () => {
        if (!redisAvailable) return;
        try {
            await cache.clear();
            await cache.shutdown();
        } catch {
            // Ignore cleanup errors — the connection may already be closed
        }
    });

    it("should remove keys matching a wildcard pattern and report the count", async () => {
        if (!redisAvailable) return;

        await cache.set("user:1", "a");
        await cache.set("user:2", "b");
        await cache.set("product:1", "x");

        expect(await cache.deletePattern("user:*")).toBe(2);
        expect(await cache.exists("user:1")).toBe(false);
        expect(await cache.exists("product:1")).toBe(true);
    });
});
```

### Verifying the Raw Redis Key Layout

Integration tests are the only place where internal key namespacing can be verified end-to-end. A second, raw `ioredis` client inspects the actual keys written by the provider:

```typescript
it("should store keys under the rootKey prefix in Redis", async () => {
    if (!redisAvailable) return;

    const rootKey = `Prefix_${Date.now()}`;
    const cache = new RedisCacheProvider({ ...REDIS_CONFIG, rootKey });
    const rawClient = new Redis(REDIS_CONFIG);

    try {
        await cache.set("mykey", "value");

        // The actual Redis key is the prefixed one; the value is JSON-serialized
        expect(await rawClient.get(`${rootKey}:mykey`)).toBe('"value"');
    } finally {
        await cache.clear();
        await cache.shutdown();
        await rawClient.quit();
    }
});
```

### Verifying SCAN Batching

Pattern deletion must never use `KEYS`. To prove the SCAN loop works across multiple pages (batch size is 100), the suite populates more keys than one SCAN iteration can return:

```typescript
it("should delete keys across multiple SCAN iterations", async () => {
    if (!redisAvailable) return;

    const cache = new RedisCacheProvider({ ...REDIS_CONFIG, rootKey: `Scan_${Date.now()}` });
    try {
        const writes: Promise<void>[] = [];
        for (let i = 0; i < 150; i++) {
            writes.push(cache.set(`bulk:${i}`, `val-${i}`));
        }
        await Promise.all(writes);

        expect(await cache.deletePattern("bulk:*")).toBe(150);
    } finally {
        await cache.clear();
        await cache.shutdown();
    }
});
```

### Redis Pub/Sub: Settlement Delays

Redis delivery is asynchronous over a network round-trip, and `SUBSCRIBE`/`PSUBSCRIBE` commands must be established before the first `PUBLISH` is sent. The suite therefore `settle(100)`s after subscribing and uses `waitForMessage()` to await delivery:

```typescript
import { describe, it, expect } from "vitest";
import { RedisPubSubProvider } from "blendsdk/webafx-cache";

let redisAvailable = false; // Set by the availability probe in beforeAll

describe("RedisPubSubProvider (integration)", () => {
    it("should deliver a published message to the subscribed handler", async () => {
        if (!redisAvailable) return;

        const pubsub = new RedisPubSubProvider({
            host: "localhost",
            port: 6399,
            channelPrefix: `IT_${Date.now()}`,
            maxRetriesPerRequest: 1,
            connectTimeout: 3000,
        });

        const { promise, handler } = waitForMessage<string>();
        await pubsub.subscribe<string>("order:new", handler);

        // Give Redis time to establish the SUBSCRIBE before publishing
        await settle(100);

        await pubsub.publish("order:new", "order-1");
        const message = await promise;

        expect(message.channel).toBe("order:new");
        expect(message.data).toBe("order-1");

        await pubsub.shutdown();
    });
});
```

The accompanying unsubscribe tests pair `settle(100)` after subscribing, `settle(50)` after unsubscribing, and `settle(200)` after publishing before asserting that a `vi.fn()` handler was **not** called — generous margins keep these tests stable on slow CI machines.

### Timing & Flakiness Guidelines

- **Real timers only.** No `vi.useFakeTimers()` anywhere in the suite — Redis expires keys server-side and the memory provider compares timestamps against the real clock.
- **Short TTLs, wide margins.** Use 1–3 second TTLs and wait TTL + ~200 ms (for example `delay(1200)` for a 1-second TTL, `delay(1500)` for the contract suites' expiry waits).
- **Assert TTL ranges, never exact values.** A 10-second TTL asserts `>= 8 && <= 10` in contract tests to tolerate execution time; the TTL behavior suite uses tighter bands such as `>= 1 && <= 2` at the midpoint of a 3-second TTL.
- **Stay under the 5-second Vitest timeout.** The longest waits in the suite are ~2.2 seconds (defaultTTL of 2 s + 200 ms margin).
- **Unique prefixes everywhere.** Channel prefixes use a counter plus `Date.now()` (for example `RedisPubSubTest_${++testCounter}_${Date.now()}`) since Redis pub/sub has no deletion API for stale channels.

---

## Mocking & Stubbing

The suite mocks sparingly. Because the memory backends are contract-identical drop-in doubles for Redis, most "mocking" in this package is really **backend substitution**. Mocks and spies are reserved for four purposes: counting handler invocations, suppressing expected console output, standing in for the WebAFX plugin host, and proving module-load behavior.

### Spying on console.error for Error Isolation

Handler errors are logged, not thrown — so tests that intentionally break handlers spy on `console.error`, assert it was called, and restore it:

```typescript
import { describe, it, expect, vi } from "vitest";
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";
import type { MessageHandler } from "blendsdk/webafx-cache";

describe("handler error isolation", () => {
    it("should catch handler errors and still deliver to other handlers", async () => {
        const pubsub = new MemoryPubSubProvider();
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const goodHandler = vi.fn();

        const badHandler: MessageHandler = () => {
            throw new Error("handler boom");
        };

        await pubsub.subscribe("ch", badHandler);
        await pubsub.subscribe("ch", goodHandler);

        await pubsub.publish("ch", "data");
        await settle(10);

        expect(goodHandler).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalled();

        errorSpy.mockRestore();
        await pubsub.shutdown();
    });
});
```

The same pattern covers **async** handler rejections — the suite uses a 50 ms settle in that case to let the rejected promise propagate through `safeInvoke`.

### Mocking the WebAFX App and Logger

Plugin factories receive a WebAFX context (`app`, `express`, `logger`). The suite calls the factory directly with hand-rolled mocks — `vi.fn()` for `registerService`, and async `info` on the logger — casting each field `as never` because the full WebAFX host type is intentionally not reproduced in a unit test:

```typescript
import { describe, it, expect, vi } from "vitest";
import { MemoryPubSubProvider, createPubSubPlugin } from "blendsdk/webafx-cache";

describe("createPubSubPlugin", () => {
    it("should register a singleton service and return health/shutdown hooks", async () => {
        const provider = new MemoryPubSubProvider({ channelPrefix: "Test" });
        const plugin = createPubSubPlugin(provider);

        expect(plugin.name).toBe("pubsub"); // Default serviceName
        expect(plugin.priority).toBe(30); // Default priority

        const mockApp = { registerService: vi.fn() };
        const mockLogger = { info: vi.fn().mockResolvedValue(undefined) };

        const hooks = await plugin.factory({
            app: mockApp as never,
            express: {} as never,
            logger: mockLogger as never,
        });

        expect(mockApp.registerService).toHaveBeenCalledTimes(1);
        expect(typeof hooks.health).toBe("function");
        expect(typeof hooks.shutdown).toBe("function");
        expect(await hooks.health()).toBe(true);

        await hooks.shutdown();
    });
});
```

### Asserting the Registered Singleton

To verify which provider instance was registered, inspect the captured `registerService` call and invoke the registered factory — it must return the exact provider instance (application-wide singleton, never per-request):

```typescript
const registration = mockApp.registerService.mock.calls[0][0] as {
    factory: () => unknown;
};

expect(registration.factory()).toBe(provider);
```

The registration object also carries `name` (the `serviceName`) and a `dispose` callback wired to `provider.shutdown()` — both are exercised implicitly by the plugin suites.

### Mocking ioredis to Prove Import Purity

The `./memory` subpath's core guarantee is that importing it **never evaluates `ioredis`**. The spec suite proves this by mocking the module with a factory that records whether it was loaded; `vi.hoisted` is required because `vi.mock` factories are hoisted above imports:

```typescript
import { describe, expect, it, vi } from "vitest";

const { recordRedisLoad } = vi.hoisted(() => ({
    recordRedisLoad: vi.fn(),
}));

vi.mock("ioredis", () => {
    recordRedisLoad();
    return { Redis: class RedisStub {} };
});

describe("memory subpath — specification", () => {
    it("should import without loading ioredis", async () => {
        await import("blendsdk/webafx-cache/memory");

        expect(recordRedisLoad).not.toHaveBeenCalled();
    });
});
```

### Prefer Real Memory Providers over Class Mocks

Because the contract suites pin Memory and Redis to identical behavior, the recommended substitution strategy in consumer tests is:

1. **Inject `MemoryCacheProvider` / `MemoryPubSubProvider`** wherever your production code accepts a `CacheProvider` / `PubSubProvider` — deterministic, fast, no cleanup of external state.
2. **Import from `blendsdk/webafx-cache/memory`** in tests so `ioredis` never loads at all (relevant for edge runtimes and speed).
3. **Spy instead of write fakes** when you must assert on interactions — for example `vi.spyOn(cache, "deletePattern")` on a real memory provider verifies both the call and its effect:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

describe("cache invalidation", () => {
    let cache: MemoryCacheProvider;

    beforeEach(() => {
        cache = new MemoryCacheProvider({ rootKey: "SpyTest", cleanupIntervalMs: 0 });
    });

    afterEach(async () => {
        await cache.shutdown();
    });

    it("should invalidate only the user namespace", async () => {
        await cache.set("user:1", { id: 1 });
        await cache.set("product:1", { id: 1 });

        const spy = vi.spyOn(cache, "deletePattern");
        const deleted = await cache.deletePattern("user:*");

        expect(spy).toHaveBeenCalledWith("user:*");
        expect(deleted).toBe(1);
        expect(await cache.exists("user:1")).toBe(false);
        expect(await cache.exists("product:1")).toBe(true);
    });
});
```

---

## Test Patterns by Feature

The snippets below reuse the helpers from [Test Setup](#test-helpers) (`settle`, `waitForMessage`, the availability gate, unique root keys).

### Cache Core Operations

| Behavior | Test recipe | Assertion |
|----------|-------------|-----------|
| Round-trip every JSON type | `set(key, value)` then `get<T>(key)` | `toBe` for primitives, `toEqual` for objects/arrays, `toBeNull` for `null` |
| Miss | `get("missing")` on an empty provider | `undefined` |
| Overwrite | `set(k, "first")` then `set(k, "second")` | `get` returns `"second"` |
| Deep copy | Mutate the original after `set` | Cached value is unchanged (JSON round-trip) |
| Delete | `delete(k)` for existing and missing keys | `true` / `false`; subsequent `get` is `undefined` |
| Exists | `exists(k)` for existing, missing, and expired keys | `true` / `false` / `false` |

The full type matrix (`string`, `number`, `float`, `boolean`, `null`, `object`, `array`) runs identically against both backends in `tests/abstract-contract.test.ts` and individually in `tests/memory-cache-provider.test.ts` / `tests/redis-cache-provider.test.ts`.

### TTL & Expiration

The dedicated `tests/ttl-behavior.test.ts` suite runs ten scenarios against both backends:

| Scenario | Recipe | Assertion |
|----------|--------|-----------|
| Immediate availability | `set(k, v, 3)`, read immediately | Value present |
| Value at 50% of TTL | `set(k, v, 2)`, `delay(1000)` | Value present |
| After expiry | `set(k, v, 1)`, `delay(1200)` | `undefined` |
| Countdown | `set(k, v, 3)`, read `ttl()`, `delay(1000)`, read again | Decreasing, within bands (`2–3` then `1–2`) |
| `expire()` extends | `set(k, v, 1)`, `expire(k, 3)`, `delay(1200)` | Still present; `ttl() >= 1` |
| `expire()` shortens | `set(k, v, 10)`, `expire(k, 1)`, `delay(1200)` | `undefined` |
| `defaultTTL` applied | Provider built with `defaultTTL: 2`, `set` without TTL | `ttl()` ≈ 2; gone after `delay(2200)` |
| Explicit TTL overrides default | `defaultTTL: 10`, `set(k, v, 1)` | Gone after `delay(1200)` |
| TTL `0` means no expiry | `defaultTTL: 1`, `set(k, v, 0)`, `delay(1500)` | Present; `ttl()` is `-1` |
| `getOrSet` TTL | `getOrSet(k, factory, 1)` | Cached, `ttl()` ≈ 1, gone after `delay(1200)` |

Representative test (the TTL-extend scenario):

```typescript
it("should extend lifetime when expire resets TTL from short to long", async () => {
    const provider = new MemoryCacheProvider({ rootKey: "TtlExtend", cleanupIntervalMs: 0 });

    try {
        await provider.set("key", "extend-me", 1);
        expect(await provider.expire("key", 3)).toBe(true);

        // Past the original 1-second TTL — the value must still exist
        await delay(1200);
        expect(await provider.get<string>("key")).toBe("extend-me");
        expect(await provider.ttl("key")).toBeGreaterThanOrEqual(1);
    } finally {
        await provider.shutdown();
    }
});
```

Redis convention values are asserted directly: `ttl()` returns `-1` for a key with no expiry, `-2` for a missing or expired key, and a positive remaining-seconds count otherwise.

### Pattern Invalidation (`deletePattern` / `clear`)

| Behavior | Assertion |
|----------|-----------|
| Wildcard at the end (`user:*`) | Deletes all matches, returns the count; non-matching keys survive |
| Wildcard in the middle (`api:*:active`) | Deletes both matches; `api:users:inactive` survives |
| No match | Returns `0` |
| `clear()` scoping | Removes everything under the provider's `rootKey`; other namespaces untouched |
| Redis batching | 150 keys (> SCAN batch size of 100) are all deleted |

```typescript
it("should delete wildcard matches across positions and keep the rest", async () => {
    const cache = new MemoryCacheProvider({ rootKey: "PatternTest", cleanupIntervalMs: 0 });

    try {
        await cache.set("api:users:active", "a");
        await cache.set("api:products:active", "b");
        await cache.set("api:users:inactive", "c");

        expect(await cache.deletePattern("api:*:active")).toBe(2);
        expect(await cache.exists("api:users:inactive")).toBe(true);
    } finally {
        await cache.shutdown();
    }
});
```

> **Isolation caveat**: Two memory providers have separate `Map` stores, so a memory-based `clear()` test cannot prove shared-backend isolation. That is proven against Redis: two providers with different `rootKey`s write to the same instance, one `clear()` leaves the other's keys intact. Per-test unique `rootKey`s in the contract suites provide the same guarantee by construction.

### Cache-Aside (`getOrSet`)

| Scenario | Assertion |
|----------|-----------|
| Cache miss | Factory is invoked once; result returned |
| Cache hit | Factory is **not** invoked; cached value returned |
| Repeat calls | Factory invocation count stays at 1 |
| TTL respected | Cached value expires after the specified TTL |

```typescript
it("should call the factory exactly once across repeated calls", async () => {
    const cache = new MemoryCacheProvider({ rootKey: "GetOrSet", cleanupIntervalMs: 0 });

    let factoryCalls = 0;
    const factory = async (): Promise<string> => {
        factoryCalls++;
        return "expensive-value";
    };

    try {
        await cache.getOrSet("key1", factory);
        const second = await cache.getOrSet("key1", factory);

        expect(factoryCalls).toBe(1);
        expect(second).toBe("expensive-value");
    } finally {
        await cache.shutdown();
    }
});
```

### Namespace Isolation (`rootKey`)

For memory providers, verify per-provider views (separate stores); for Redis, verify the actual prefixed key names with a raw client (see [Verifying the Raw Redis Key Layout](#verifying-the-raw-redis-key-layout)).

```typescript
it("should isolate keys between providers with different rootKeys", async () => {
    const cacheA = new MemoryCacheProvider({ rootKey: "AppA", cleanupIntervalMs: 0 });
    const cacheB = new MemoryCacheProvider({ rootKey: "AppB", cleanupIntervalMs: 0 });

    try {
        await cacheA.set("key", "from-A");
        await cacheB.set("key", "from-B");

        expect(await cacheA.get<string>("key")).toBe("from-A");
        expect(await cacheB.get<string>("key")).toBe("from-B");
    } finally {
        await cacheA.shutdown();
        await cacheB.shutdown();
    }
});
```

### Health & Shutdown

| Backend | `health()` operational | After `shutdown()` |
|---------|------------------------|--------------------|
| Memory | Always `true` | Still `true`; store cleared, cleanup interval stopped |
| Redis (cache) | `true` while connected | `false` — the connection is closed and `PING` no longer succeeds |
| Redis (pub/sub) | `true` only when **both** connections answer `PONG` | Subscriptions cleared; both connections quit |

The cache lifecycle test asserts exactly the Redis transition:

```typescript
it("should close the Redis connection gracefully", async () => {
    if (!redisAvailable) return;

    const provider = new RedisCacheProvider({
        host: "localhost",
        port: 6399,
        maxRetriesPerRequest: 1,
        connectTimeout: 3000,
        rootKey: `Shutdown_${Date.now()}`,
    });

    expect(await provider.health()).toBe(true);
    await provider.shutdown();
    expect(await provider.health()).toBe(false);
});
```

For the Redis pub/sub shutdown test, the suite creates a provider **outside** the cleanup registry (to avoid double-shutdown), subscribes one channel and one pattern, calls `shutdown()`, and asserts `activeSubscriptions()` returns empty arrays.

### Pub/Sub Delivery

| Feature | Scenarios | Assertions |
|---------|-----------|------------|
| Exact subscribe | Single handler delivery | Envelope `channel` + `data`; `pattern` undefined |
| Receiver count | n handlers; zero handlers | `publish()` return value (`n` / `0`) |
| Fan-out | Multiple handlers, and exact + pattern together | Each handler called once; count is the sum |
| Unsubscribe | After `unsubscribe()` | Handler never called |
| JSON round-trip | Objects through publishing | `toEqual` and `not.toBe(original)` — a fresh object |

Fan-out with receiver counting:

```typescript
import { describe, it, expect, vi } from "vitest";
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";

describe("fan-out", () => {
    it("should deliver to every handler and count receivers", async () => {
        const pubsub = new MemoryPubSubProvider();
        const handler1 = vi.fn();
        const handler2 = vi.fn();

        await pubsub.subscribe("events", handler1);
        await pubsub.subscribe("events", handler2);

        const count = await pubsub.publish("events", "data");
        await settle(10);

        expect(count).toBe(2);
        expect(handler1).toHaveBeenCalledTimes(1);
        expect(handler2).toHaveBeenCalledTimes(1);

        await pubsub.shutdown();
    });
});
```

### Pattern Subscriptions

| Pattern | Matches | Does not match |
|---------|---------|----------------|
| `order:*` | `order:created`, `order:updated` | `user:created` |
| `slot:?` | `slot:a`, `slot:b` | `slot:ab` |
| `audit:*` | `audit:login` (envelope gains `pattern: "audit:*"`) | — |

```typescript
import { describe, it, expect } from "vitest";
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";
import type { PubSubMessage } from "blendsdk/webafx-cache";

interface AuditEvent {
    userId: number;
}

describe("pattern subscriptions", () => {
    it("should include the pattern in the message envelope", async () => {
        const pubsub = new MemoryPubSubProvider({ channelPrefix: "MyApp" });
        const received: PubSubMessage<AuditEvent>[] = [];

        await pubsub.psubscribe<AuditEvent>("audit:*", (msg) => received.push(msg));
        await pubsub.publish("audit:login", { userId: 1 });
        await settle(10);

        expect(received[0].pattern).toBe("audit:*");
        expect(received[0].channel).toBe("audit:login");
        expect(received[0].data).toEqual({ userId: 1 });

        await pubsub.shutdown();
    });
});
```

### Handler Error Isolation

Covered fully in [Mocking & Stubbing](#spying-on-consoleerror-for-error-isolation). Both suites (memory and the Redis contract) verify that a throwing synchronous handler **and** a rejecting async handler do not prevent other handlers from receiving the message, and that `console.error` is invoked.

### Channel Prefix Transparency and `activeSubscriptions`

The leak test for prefix handling: even with a prefix configured, handlers and `activeSubscriptions()` see only user-facing names.

```typescript
it("should report unprefixed subscription names and deliver unprefixed channels", async () => {
    const pubsub = new MemoryPubSubProvider({ channelPrefix: "MyApp" });

    const received: PubSubMessage<string>[] = [];
    await pubsub.subscribe<string>("order:new", (msg) => received.push(msg));
    await pubsub.psubscribe("audit:*", () => undefined);

    await pubsub.publish("order:new", "hello");
    await settle(10);

    expect(received[0].channel).toBe("order:new"); // Not "MyApp:order:new"

    const subs = pubsub.activeSubscriptions();
    expect(subs.channels).toEqual(["order:new"]);
    expect(subs.patterns).toEqual(["audit:*"]);

    await pubsub.shutdown();
});
```

After `unsubscribe()` / `punsubscribe()` / `shutdown()`, the corresponding arrays are empty, and after `shutdown()` no further messages are delivered.

### Plugin Factories & Environment Factories

| Factory | Covered assertions |
|---------|--------------------|
| `createCachePlugin(provider)` | Plugin `name` from `provider.serviceName` (default `"cache"`); default priority `30`; custom priority including `0`; singleton registration; `health`/`shutdown` hooks returned |
| `createPubSubPlugin(provider, options?)` | Same as above with `"pubsub"` default; declarative `subscriptions` registered during factory execution |
| `memoryCachePlugin(config)` / `memoryPubSubPlugin(config?, options?)` | Valid `PluginDefinition`; respects custom `serviceName` |
| `redisCachePlugin(config)` / `redisPubSubPlugin(config, options?)` | Valid `PluginDefinition` without calling `factory()` — clients are created but never used; `maxRetriesPerRequest: 0` keeps background connection attempts from retrying |
| `createCache(config)` / `createPubSub(config)` | Correct instance type per `type`; `serviceName`/`defaultTTL`/`channelPrefix` pass-through; descriptive `Unknown ... type` errors |

Declarative subscriptions are verified by publishing after factory execution:

```typescript
import { describe, it, expect, vi } from "vitest";
import { MemoryPubSubProvider, createPubSubPlugin } from "blendsdk/webafx-cache";

describe("declarative subscriptions", () => {
    it("should register channel and pattern subscriptions at install time", async () => {
        const provider = new MemoryPubSubProvider();
        const channelHandler = vi.fn();
        const patternHandler = vi.fn();

        const plugin = createPubSubPlugin(provider, {
            subscriptions: [
                { channel: "order:new", handler: channelHandler },
                { pattern: "audit:*", handler: patternHandler },
            ],
        });

        const mockApp = { registerService: vi.fn() };
        const mockLogger = { info: vi.fn().mockResolvedValue(undefined) };

        await plugin.factory({
            app: mockApp as never,
            express: {} as never,
            logger: mockLogger as never,
        });

        await provider.publish("order:new", { id: 1 });
        await provider.publish("audit:login", { userId: 1 });
        await settle(10);

        expect(channelHandler).toHaveBeenCalledTimes(1);
        expect(patternHandler).toHaveBeenCalledTimes(1);

        await provider.shutdown();
    });
});
```

Environment factory error messages are pinned with `toThrow` — the intentional `as "redis"` cast bypasses the union so the runtime guard can be tested:

```typescript
import { describe, it, expect } from "vitest";
import { createCache } from "blendsdk/webafx-cache";

describe("createCache", () => {
    it("should throw a descriptive error for unknown types", () => {
        expect(() =>
            createCache({ type: "postgres" as "redis", rootKey: "TestApp" })
        ).toThrow('Unknown cache type: "postgres"');
    });

    it("should list the supported types in the error", () => {
        expect(() =>
            createCache({ type: "invalid" as "redis", rootKey: "TestApp" })
        ).toThrow('Supported types: "redis", "memory"');
    });
});
```

### Redis-Free Subpath

Three guarantees are tested for `blendsdk/webafx-cache/memory`: it loads without evaluating `ioredis` (see the mock example in [Mocking & Stubbing](#mocking-ioredis-to-prove-import-purity)), it exposes the same class and factory **identities** as the main entry, and it does not leak the Redis providers.

```typescript
import { describe, expect, it } from "vitest";

describe("memory subpath — identity", () => {
    it("should share provider and builder identities with the main entry", async () => {
        const memory = await import("blendsdk/webafx-cache/memory");
        const main = await import("blendsdk/webafx-cache");

        expect(memory.MemoryCacheProvider).toBe(main.MemoryCacheProvider);
        expect(memory.MemoryPubSubProvider).toBe(main.MemoryPubSubProvider);
        expect(memory.CacheProvider).toBe(main.CacheProvider);
        expect(memory.PubSubProvider).toBe(main.PubSubProvider);
        expect(memory.createCachePlugin).toBe(main.createCachePlugin);
        expect(memory.createPubSubPlugin).toBe(main.createPubSubPlugin);
        expect(memory.memoryCachePlugin).toBe(main.memoryCachePlugin);
        expect(memory.memoryPubSubPlugin).toBe(main.memoryPubSubPlugin);
    });

    it("should not expose the Redis providers", async () => {
        const memory = await import("blendsdk/webafx-cache/memory");

        expect("RedisCacheProvider" in memory).toBe(false);
        expect("RedisPubSubProvider" in memory).toBe(false);
    });

    it("should expose a usable MemoryCacheProvider", async () => {
        const { MemoryCacheProvider, CacheProvider } = await import("blendsdk/webafx-cache/memory");

        const provider = new MemoryCacheProvider({ rootKey: "Test", cleanupIntervalMs: 0 });
        expect(provider).toBeInstanceOf(CacheProvider);
        await provider.shutdown();
    });
});
```

The implementation suite also drives `memoryPubSubPlugin().factory()` with a mocked WebAFX context and asserts the registered factory returns a `MemoryPubSubProvider` instance.

### Cross-Backend Contract Suites

The most important structural pattern in this package: behavior is tested **once** and executed against **every** backend, so a new backend can be added by wiring it into two runners. The cache contract suite is parameterized as:

```typescript
function runContractTests(
    name: string,
    createProvider: () => CacheProvider,
    cleanupProvider: (p: CacheProvider) => Promise<void>,
    shouldSkip?: () => boolean
): void
```

Each runner creates a fresh provider in `beforeEach` (skipping when `shouldSkip()` is true), cleans up in `afterEach`, and every test starts with the same guard:

```typescript
describe("set and get", () => {
    it("should round-trip a string", async () => {
        if (shouldSkip?.()) return;
        await provider.set("str", "hello");
        expect(await provider.get<string>("str")).toBe("hello");
    });
});
```

Wiring both backends into the runner — note the unique root keys and the Redis skip predicate:

```typescript
let memoryCounter = 0;
let redisCounter = 0;

runContractTests(
    "MemoryCacheProvider",
    () =>
        new MemoryCacheProvider({
            rootKey: `Contract_Mem_${++memoryCounter}`,
            cleanupIntervalMs: 0,
        }),
    async (p) => await p.shutdown()
);

runContractTests(
    "RedisCacheProvider",
    () =>
        new RedisCacheProvider({
            host: "localhost",
            port: 6399,
            maxRetriesPerRequest: 1,
            connectTimeout: 3000,
            rootKey: `Contract_Redis_${++redisCounter}_${Date.now()}`,
        }),
    async (p) => {
        await p.clear();
        await p.shutdown();
    },
    () => !redisAvailable
);
```

The pub/sub contract suite follows the same shape with `runPubSubContractTests(name, createProvider, cleanupProvider, shouldSkip?)` — its factory includes a unique `channelPrefix` (`ContractMem_${++memoryCounter}` / `ContractRedis_${++redisCounter}_${Date.now()}`) since pub/sup channels cannot be cleaned up, and its `shouldSkip` gates the Redis runner on the availability probe. The TTL suite uses an extended signature — `runTTLBehaviorTests(name, createProvider, createProviderWithDefaultTTL, cleanupProvider, shouldSkip?)` — because several scenarios need a provider constructed with a specific `defaultTTL`.

---

*Testing patterns source files: `tests/abstract-contract.test.ts`, `tests/ttl-behavior.test.ts`, `tests/memory-cache-provider.test.ts`, `tests/redis-cache-provider.test.ts`, `tests/pubsub-contract.test.ts`, `tests/memory-pubsub.test.ts`, `tests/redis-pubsub.test.ts`, `tests/cache-plugin.test.ts`, `tests/pubsub-plugin.test.ts`, `tests/memory-subpath.spec.test.ts`, `tests/memory-subpath.impl.test.ts`*

---

# webafx-cache Troubleshooting

Most failures in `blendsdk/webafx-cache` trace back to one of four design invariants: **everything is JSON-serialized** (cache values and pub/sub payloads), **namespaces are transparent** (`rootKey` / `channelPrefix` are applied and stripped automatically), **backends are interchangeable** (the memory providers match Redis behavior by contract), and **errors are contained** (handler errors are logged, never thrown). This document catalogs the exact errors you will encounter, how to diagnose them step by step, and the subtle pitfalls that are easy to miss.

## Quick Reference — Exact Package Errors

| Error message | Thrown / logged by |
|---|---|
| `CacheProvider: rootKey is required and cannot be empty` | `CacheProvider` constructor (`new MemoryCacheProvider`, `new RedisCacheProvider`, `createCache`) |
| `Unknown cache type: "<type>". Supported types: "redis", "memory".` | `createCache()` |
| `Unknown pub/sub type: "<type>". Supported types: "redis", "memory".` | `createPubSub()` |
| `[PubSub] Handler error on channel "<channel>":` | `PubSubProvider.safeInvoke()` (`console.error`) |
| `[PubSub] Failed to parse message on "<channel>"` | `RedisPubSubProvider` message routing (`console.error`) |

---

## Common Errors

### Configuration Errors

#### `CacheProvider: rootKey is required and cannot be empty`

**Error message**

```text
Error: CacheProvider: rootKey is required and cannot be empty
```

**Symptom**

Constructing any cache provider throws immediately: `new MemoryCacheProvider({ rootKey: '' })`, `new RedisCacheProvider(...)`, or anything routed through `createCache()`.

**Cause**

The shared `CacheProvider` base constructor rejects a missing, empty, or whitespace-only `rootKey`. The most common trigger is feeding an unset environment variable into the config — `rootKey: process.env.CACHE_ROOT as string` compiles fine but passes `undefined` at runtime.

**Fix**

1. Validate the raw value before constructing the provider.
2. Fail fast with a message that names the variable so misconfiguration is obvious in logs.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

const rootKey = (process.env.CACHE_ROOT ?? 'MyApp').trim();
if (rootKey.length === 0) {
    throw new Error('CACHE_ROOT is set but empty — provide a non-empty rootKey');
}

const cache = new MemoryCacheProvider({ rootKey });

await cache.set('probe', 'ok');
console.log(await cache.get<string>('probe')); // 'ok'

await cache.shutdown();
```

#### `Unknown cache type` / `Unknown pub/sub type`

**Error message**

```text
Error: Unknown cache type: "postgres". Supported types: "redis", "memory".
Error: Unknown pub/sub type: "kafka". Supported types: "redis", "memory".
```

**Symptom**

`createCache()` or `createPubSub()` throws while building the provider, typically right after configuration is loaded from environment variables.

**Cause**

Both factories switch on the `type` discriminator and throw from an exhaustive `default` branch. TypeScript prevents invalid literals at compile time — this error only reaches runtime through untyped, JSON-driven, or environment-driven config. Common culprits: `"Redis"` (capitalized), `"memcached"`, or a typo.

**Fix**

1. Normalize and validate the raw string before handing it to the factory.
2. Fall back to a safe default (`memory`) when the variable is absent.

```typescript
import { createCache, type CacheFactoryConfig } from 'blendsdk/webafx-cache';

type CacheType = 'redis' | 'memory';

function resolveType(raw: string | undefined): CacheType {
    const normalized = raw?.trim().toLowerCase();
    if (normalized === 'redis' || normalized === 'memory') {
        return normalized;
    }
    throw new Error(`Invalid cache type "${String(raw)}" — expected "redis" or "memory"`);
}

const config: CacheFactoryConfig = {
    type: resolveType(process.env.CACHE_TYPE ?? 'memory'),
    rootKey: 'MyApp',
};

const cache = createCache(config);
await cache.set('k', 'v');
console.log(await cache.get<string>('k')); // 'v'

await cache.shutdown();
```

The same pattern applies to `createPubSub()` with `PubSubFactoryConfig`.

#### `TypeError: Cannot read properties of undefined (reading 'rootKey')`

**Error message**

```text
TypeError: Cannot read properties of undefined (reading 'rootKey')
```

**Symptom**

Calling `new MemoryCacheProvider()` or `new RedisCacheProvider()` with no argument (or `undefined`). In TypeScript you would instead see the compiler error `TS2554: Expected 1 arguments, but got 0` — the runtime `TypeError` appears in plain JavaScript or when an untyped/`any`-cast config is passed.

**Cause**

Cache providers require a config object (`{ rootKey }` at minimum). `MemoryPubSubProvider` is the one exception — its config parameter is optional and defaults to `{}`.

**Fix**

1. Pass a config object to every cache provider.
2. For `MemoryPubSubProvider`, call it with no config when defaults are fine.

```typescript
import { MemoryCacheProvider, MemoryPubSubProvider } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({ rootKey: 'MyApp' }); // config object required
const pubsub = new MemoryPubSubProvider();                   // config optional — defaults apply

console.log(cache.serviceName);  // 'cache'
console.log(pubsub.serviceName); // 'pubsub'

await cache.shutdown();
await pubsub.shutdown();
```

### Serialization Errors

#### `TypeError: Converting circular structure to JSON` / `TypeError: Do not know how to serialize a BigInt`

**Error messages**

```text
TypeError: Converting circular structure to JSON
TypeError: Do not know how to serialize a BigInt
```

**Symptom**

`cache.set(...)` or `pubsub.publish(...)` throws/rejects and nothing is written. With the Redis provider the failure surfaces from the awaited operation; with the memory providers it throws synchronously inside the method body.

**Cause**

Everything stored or published is passed through `JSON.stringify` before it reaches the backend. Values with cyclic references throw; `bigint` primitives throw; functions and symbols are silently dropped. The stored representation must be JSON.

**Fix**

1. Map entities to plain, JSON-safe DTOs before caching or publishing.
2. Replace `bigint` with `number` or `string`.
3. Convert `Date` to ISO strings, and break object cycles before serialization.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

interface AccountDto {
    id: number;
    name: string;
    createdAt: string; // ISO-8601 string, not a Date
}

interface AccountEntity {
    id: bigint;
    name: string;
    createdAt: Date;
}

const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });

const entity: AccountEntity = {
    id: 1n,
    name: 'Alice',
    createdAt: new Date('2025-01-01T00:00:00Z'),
};

// Map to a JSON-safe DTO before caching — BigInt and Date cannot round-trip.
const dto: AccountDto = {
    id: Number(entity.id),
    name: entity.name,
    createdAt: entity.createdAt.toISOString(),
};

await cache.set('account:1', dto);
console.log(await cache.get<AccountDto>('account:1'));
// { id: 1, name: 'Alice', createdAt: '2025-01-01T00:00:00.000Z' }

await cache.shutdown();
```

### Connection and Lifecycle Errors

#### `connect ECONNREFUSED` and `MaxRetriesPerRequestError`

**Error messages**

```text
Error: connect ECONNREFUSED 127.0.0.1:6379
MaxRetriesPerRequestError: Reached the max retries per request limit (which is 3). Refer to "maxRetriesPerRequest" option for details.
```

**Symptom**

The first cache or pub/sub operation rejects with a connection error, while `await cache.health()` / `await pubsub.health()` returns `false` instead of throwing.

**Cause**

The ioredis clients are created in the constructor and connect in the background. While the server is unreachable, each command retries up to `maxRetriesPerRequest` (default `3`) and then rejects; `health()` swallows the failure and reports `false`. Typical triggers: Redis is not running, wrong host/port, the container was not started, a missing password, or using port 6379 against the package's development Redis (the repo's Docker setup maps test Redis to port **6399**).

**Fix**

1. Make host/port explicit configuration rather than relying on defaults.
2. Probe `health()` and fail fast with an actionable message before serving traffic.
3. For local development against the package repo, start Redis with `pnpm run docker:up` (see the Debugging Strategies section).

```typescript
import { RedisCacheProvider } from 'blendsdk/webafx-cache';

const cache = new RedisCacheProvider({
    rootKey: 'MyApp',
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    connectTimeout: 5000,
    maxRetriesPerRequest: 3,
});

if (!(await cache.health())) {
    await cache.shutdown();
    throw new Error('Redis unreachable — start the server or fix host/port/password');
}

await cache.set('startup:probe', { ok: true }, 60);
console.log(await cache.get<{ ok: boolean }>('startup:probe'));

await cache.shutdown();
```

#### `Error: Connection is closed.`

**Error message**

```text
Error: Connection is closed.
```

**Symptom**

After `await cache.shutdown()` (or `await pubsub.shutdown()`), every subsequent Redis operation rejects. With the in-memory providers, the same code path does **not** reject — it silently answers from a cleared store.

**Cause**

`shutdown()` closes the ioredis connections via `quit()`. The provider object remains usable but its transport is gone. The memory providers only clear their store and stop the cleanup timer, so a shut-down memory provider appears to keep working (with an empty cache and still-accepting writes), which hides lifecycle bugs until the code runs on Redis.

**Fix**

1. Treat `shutdown()` as terminal: call it exactly once, at teardown, and never use the provider afterwards.
2. Inside WebAFX, this is handled for you — the plugin factories register `dispose` and a shutdown hook that call `provider.shutdown()` during application shutdown.
3. For standalone scripts, structure teardown in a `finally` block.

```typescript
import { RedisCacheProvider } from 'blendsdk/webafx-cache';

const cache = new RedisCacheProvider({ rootKey: 'MyApp', host: 'localhost', port: 6379 });

try {
    await cache.set('session:1', { userId: 42 });
    console.log(await cache.get<{ userId: number }>('session:1'));
} finally {
    // Call exactly once, at teardown. Do not use the provider afterwards.
    await cache.shutdown();
}
```

### Pub/Sub Errors

#### `publish()` resolves but handlers never fire (return value `0`)

**Symptom**

`await pubsub.publish('order:new', payload)` completes without error, yet no handler runs. `activeSubscriptions()` may be empty. Across processes, messages published before a subscriber connects are never seen.

**Cause**

Three distinct causes produce the same symptom:

1. **No subscriber connected** — pub/sub is fire-and-forget with no persistence. A message published while nobody is subscribed is dropped and never replayed. The return value of `publish()` is the tell: `0` means nobody received it.
2. **Channel prefix mismatch** — publisher and subscriber must agree on `channelPrefix`. A prefix on one side changes the real channel (`MyApp:order:new` vs `order:new`), so the two never meet.
3. **Subscription race** — an un-awaited `subscribe()` call (`void pubsub.subscribe(...)`) can lose to a publish in the same tick. On Redis, a publish from another process can beat the remote `SUBSCRIBE` itself.

**Fix**

1. Always `await` subscribe calls, or register subscriptions declaratively at plugin install time (before any traffic can publish).
2. Align `channelPrefix` on every publisher and subscriber that must communicate.
3. During development, log the return value of `publish()` — `0` is a reliable "nobody heard this" warning.

```typescript
import { MemoryPubSubProvider, type PubSubMessage } from 'blendsdk/webafx-cache';

interface OrderEvent {
    orderId: number;
    total: number;
}

const pubsub = new MemoryPubSubProvider({ channelPrefix: 'MyApp' });

// Await the subscription so it is active before the first publish.
await pubsub.subscribe<OrderEvent>('order:new', (message: PubSubMessage<OrderEvent>) => {
    console.log(`new order ${message.data.orderId}`);
});

// The return value is the receiver count — 0 means the message was dropped.
const receivers = await pubsub.publish('order:new', { orderId: 1, total: 49.99 });
console.log(receivers); // 1

await pubsub.shutdown();
```

For application code, prefer declarative subscriptions so handlers exist from startup onward:

```typescript fragment
// Declarative subscriptions are registered when the plugin installs,
// which happens during application startup — before any request can publish.
app.use(createPubSubPlugin(provider, {
    subscriptions: [
        { channel: 'order:created', handler: handleNewOrder },
        { pattern: 'audit:*', handler: handleAuditEvent },
    ],
}));
```

#### `[PubSub] Handler error on channel "..."` — handler errors never propagate

**Log output**

```text
[PubSub] Handler error on channel "order:new": handler boom
```

**Symptom**

Handlers throw, but nothing rejects: `publish()` resolves normally, the process stays up, and other handlers keep firing. Without watching `console.error`, the failure is invisible.

**Cause**

This is by design. `safeInvoke()` catches every handler error and logs it, so one broken subscriber can never break other subscribers or crash the subscriber connection. Nothing is propagated to the publisher — which, on Redis, may be a completely different process anyway.

**Fix**

1. Handle failures inside the handler, not by relying on exceptions reaching the publisher.
2. Route caught errors to your own logging/monitoring pipeline.

```typescript
import { MemoryPubSubProvider, type PubSubMessage } from 'blendsdk/webafx-cache';

interface OrderEvent {
    orderId: number;
}

function reportToMonitoring(error: unknown): void {
    if (error instanceof Error) {
        console.error(`[monitoring] ${error.message}`);
        return;
    }
    console.error(`[monitoring] ${String(error)}`);
}

async function processOrder(orderId: number): Promise<void> {
    if (orderId <= 0) {
        throw new Error(`Invalid order id: ${orderId}`);
    }
    console.log(`processed order ${orderId}`);
}

const pubsub = new MemoryPubSubProvider();

await pubsub.subscribe<OrderEvent>('order:new', async (message: PubSubMessage<OrderEvent>) => {
    try {
        await processOrder(message.data.orderId);
    } catch (error) {
        reportToMonitoring(error); // safeInvoke would only log to console.error
    }
});

await pubsub.publish('order:new', { orderId: -1 }); // handler reports the failure
await pubsub.publish('order:new', { orderId: 42 }); // 'processed order 42'

await pubsub.shutdown();
```

#### `[PubSub] Failed to parse message on "..."` — payloads dropped at deserialization

**Log output**

```text
[PubSub] Failed to parse message on "audit:login"
[PubSub] Failed to parse message on "audit:login" (pattern: "audit:*")
```

**Symptom**

Messages exist on the Redis channel, but the handler never runs; the subscriber logs a parse failure. Only the Redis provider hits this path — the memory provider's own publishes always round-trip cleanly.

**Cause**

The Redis provider `JSON.parse`s every incoming payload. If any producer publishes non-JSON text to the channel (a raw `PUBLISH` from another service, a CLI, or a legacy publisher), the message cannot be deserialized and is dropped for that subscriber. A related trap is **double-encoding**: publishing `JSON.stringify(value)` through the provider parses fine, but the handler receives a `string` instead of the object.

**Fix**

1. Make every producer on those channels write JSON — publish through `PubSubProvider` (which serializes for you) or apply `JSON.stringify` before raw publishes.
2. Publish values, not pre-stringified JSON.
3. If foreign producers share the channel namespace, audit them first — a channel-prefix collision with another app is a common source of stray non-JSON traffic.

```typescript
import { MemoryPubSubProvider, type PubSubMessage } from 'blendsdk/webafx-cache';

interface AuditEvent {
    userId: number;
}

const pubsub = new MemoryPubSubProvider({ channelPrefix: 'MyApp' });

await pubsub.subscribe<AuditEvent>('audit:login', (message: PubSubMessage<AuditEvent>) => {
    console.log(typeof message.data); // 'object' — the provider delivers the parsed value
    console.log(message.data.userId); // 42
});

// Always publish values through the provider — it applies JSON.stringify for you.
await pubsub.publish('audit:login', { userId: 42 });

await pubsub.shutdown();
```

### TypeScript Compiler Errors

#### `'x' is of type 'unknown'.` (TS18046)

**Symptom**

`const user = await cache.get('user:123');` compiles, but `user.name` fails with `'user' is of type 'unknown'.` — or `message.data.someField` inside a subscription handler hits the same error.

**Cause**

`get<T>()` and `subscribe<T>()` are generic. When no type argument is supplied, `T` resolves to `unknown`, and strict mode forbids property access on `unknown` without narrowing.

**Fix**

1. Supply the type argument at the call site.
2. The compiler then types the returned value and the handler payload.

```typescript
import { MemoryCacheProvider, MemoryPubSubProvider, type PubSubMessage } from 'blendsdk/webafx-cache';

interface User {
    id: number;
    name: string;
}

interface OrderEvent {
    orderId: number;
    total: number;
}

const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });

await cache.set('user:123', { id: 123, name: 'Alice' });
const user = await cache.get<User>('user:123'); // T = User, not unknown

if (user) {
    console.log(user.name.toUpperCase()); // 'ALICE'
}

const pubsub = new MemoryPubSubProvider();

await pubsub.subscribe<OrderEvent>('order:new', (message: PubSubMessage<OrderEvent>) => {
    console.log(message.data.orderId); // typed — no narrowing required
});

await pubsub.publish('order:new', { orderId: 7, total: 49.99 });

await cache.shutdown();
await pubsub.shutdown();
```

#### `Property 'store' is protected and only accessible within class 'MemoryCacheProvider' and its subclasses.` (TS2445)

**Symptom**

Debugging or testing code tries to read `cache.store`, `cache.rootKey`, or other internals and fails to compile.

**Cause**

`rootKey`, `defaultTTL`, `store`, `cleanupInterval`, `buildKey()`, `buildPattern()`, and `patternToRegex()` are `protected` — deliberately outside the public API. The supported observable surface is the abstract methods plus `serviceName`.

**Fix**

1. Prefer the public API (`exists`, `ttl`, `activeSubscriptions`, …) whenever it can answer the question.
2. When you genuinely need internals — test helpers, debug tooling — subclass the provider and expose narrow accessors.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

class InspectableMemoryCache extends MemoryCacheProvider {
    /** Test/debug helper: list stored (prefixed) keys matching a pattern. */
    storedKeys(pattern = '*'): string[] {
        const regex = this.patternToRegex(this.buildPattern(pattern));
        return Array.from(this.store.keys()).filter((key) => regex.test(key));
    }
}

const cache = new InspectableMemoryCache({ rootKey: 'MyApp', cleanupIntervalMs: 0 });

await cache.set('user:1', { id: 1 });
await cache.set('product:1', { id: 2 });

console.log(cache.storedKeys('user:*')); // ['MyApp:user:1']

await cache.shutdown();
```

#### `Cannot find module 'blendsdk/webafx'` (TS2307 / ERR_MODULE_NOT_FOUND)

**Symptom**

Compile or runtime failure when using the plugin APIs. Standalone provider usage is unaffected.

**Cause**

`blendsdk/webafx` is an **optional peer dependency**. It is required only for the plugin integration APIs (`createCachePlugin`, `createPubSubPlugin`, `redisCachePlugin`, `memoryCachePlugin`, `redisPubSubPlugin`, `memoryPubSubPlugin`). The provider classes themselves never import it.

**Fix**

1. In a WebAFX application, the `blendsdk/webafx` peer is already present — no extra install is needed.
2. If you only need caching/pub-sub primitives, skip the plugin layer entirely — providers run standalone.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

// No WebAFX import anywhere — this runs standalone.
const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });

await cache.set('config:feature-flags', { darkMode: true }, 300);
console.log(await cache.get<{ darkMode: boolean }>('config:feature-flags'));

await cache.shutdown();
```

### Module and Import Errors

#### `Cannot find module 'blendsdk/webafx-cache/memory'` / `ERR_REQUIRE_ESM`

**Error messages**

```text
error TS2307: Cannot find module 'blendsdk/webafx-cache/memory' or its corresponding type declarations.
Error [ERR_REQUIRE_ESM]: require() of ES Module ... not supported
Error [ERR_MODULE_NOT_FOUND]: Cannot find module ...
```

**Symptom**

The main entry imports fine, but the Redis-free subpath does not resolve — or a CommonJS consumer crashes when loading the package.

**Cause**

The package is ESM-only with an `exports` map (`"."` and `"./memory"`). Subpath exports require `moduleResolution` set to `node16`, `nodenext`, or `bundler` — the legacy `"node"` resolution never reads them. And because the package is ESM, `require()` from CommonJS cannot load it directly.

**Fix**

1. Set modern module settings in `tsconfig.json`.
2. Use ESM `import` (the package is ESM-first, as is Node.js >= 22).

```json
{
    "compilerOptions": {
        "module": "nodenext",
        "moduleResolution": "nodenext",
        "target": "es2023",
        "strict": true
    }
}
```

```typescript
import { MemoryCacheProvider, MemoryPubSubProvider } from 'blendsdk/webafx-cache/memory';

// The subpath never loads ioredis — ideal for tests and single-instance deployments.
const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });
const pubsub = new MemoryPubSubProvider({ channelPrefix: 'MyApp' });

await cache.set('k', 'v');
console.log(await cache.get<string>('k')); // 'v'
console.log(pubsub.serviceName); // 'pubsub'

await cache.shutdown();
await pubsub.shutdown();
```

---

## Debugging Strategies

The following procedures narrow down problems from "something is wrong somewhere" to a specific cause. Run them in order — each step rules out an entire category.

### 1. Reproduce the problem on the in-memory backend first

Both backends are contract-tested to behave identically, so isolating the backend instantly classifies the bug:

- The problem **reproduces on memory** → it is in your code: types, TTLs, patterns, or lifecycle usage.
- The problem **only happens on Redis** → it is infrastructure or cross-process behavior: connectivity, keyspace, prefixes, or subscriber timing.

1. Swap the provider for `MemoryCacheProvider` with the same `rootKey` and options.
2. Run the exact failing operations and compare results.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({ rootKey: 'Debug', cleanupIntervalMs: 0 });

await cache.set('user:1', { id: 1 });
console.log('get    :', await cache.get<{ id: number }>('user:1'));
console.log('ttl    :', await cache.ttl('user:1'));   // -1 → exists, no expiry
console.log('missing:', await cache.ttl('nope'));     // -2 → key missing
console.log('exists :', await cache.exists('user:1'));

await cache.shutdown();
```

### 2. Check `health()` before blaming your code

`health()` never throws — it returns a boolean. A `false` result means the transport is the problem, not your logic.

1. Call `health()` on the provider that misbehaves.
2. For Redis providers, remember what is being probed: `RedisCacheProvider` pings its single connection; `RedisPubSubProvider` pings **both** the publisher and subscriber connections and returns `true` only if both answer `PONG`.

```typescript
import { RedisPubSubProvider } from 'blendsdk/webafx-cache';

const pubsub = new RedisPubSubProvider({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    channelPrefix: 'MyApp',
});

console.log('pubsub healthy:', await pubsub.health()); // false → fix connectivity first

await pubsub.shutdown();
```

### 3. Inspect the actual keyspace in Redis

Everything is namespaced: the full Redis key is always `<rootKey>:<your-key>` (the separator constant is `:`), and values are stored as JSON strings — so `GET` output is quoted.

1. Compute the expected full key for a failing operation.
2. Inspect it with `redis-cli`. The repo's development Redis is exposed on port **6399**; your app default is 6379.

```bash
# Session against the Redis used by your app (the package's own dev Redis maps to 6399)
redis-cli -h localhost -p 6379

> SCAN 0 MATCH 'MyApp:*' COUNT 100
> TTL MyApp:user:123
> GET MyApp:user:123
> PUBSUB CHANNELS 'MyApp:*'
> PUBSUB NUMSUB MyApp:order:new
```

If `SCAN` shows no keys under your expected prefix, check for a wrong `rootKey` or a different Redis database (`db` option). If `PUBSUB NUMSUB` returns `0` for a channel you expect subscribers on, you have a prefix mismatch or a subscriber that never connected (see step 6).

### 4. Diagnose TTL behavior with `ttl()`

`ttl()` follows Redis conventions — positive = remaining seconds, `-1` = exists without expiry, `-2` = missing — on **both** backends.

1. Set one key with an explicit TTL and one without, then read their TTLs.
2. If an "omitted TTL" value expires unexpectedly early or late, check the provider's `defaultTTL`.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({ rootKey: 'TTLDebug', defaultTTL: 60, cleanupIntervalMs: 0 });

await cache.set('explicit-short', 'value', 5);
await cache.set('uses-default', 'value');

console.log(await cache.ttl('explicit-short')); // ~5  (per-call override)
console.log(await cache.ttl('uses-default'));   // ~60 (defaultTTL)
console.log(await cache.ttl('never-set'));      // -2  (missing key)

await cache.shutdown();
```

### 5. Isolate pattern-matching problems

1. Set two keys you know must be deleted and one that must survive.
2. Remember the pattern is applied **after** the root prefix — `deletePattern('user:*')` becomes `<rootKey>:user:*`.
3. Compare the returned delete count against expectations.
4. Use only `*` wildcards (see the pattern-portability pitfall below).

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({ rootKey: 'PatternDebug', cleanupIntervalMs: 0 });

await cache.set('user:1', 'a');
await cache.set('user:profile:1', 'b');
await cache.set('users:1', 'c');

console.log(await cache.deletePattern('user:*')); // 2 — 'user:1' and 'user:profile:1'
console.log(await cache.exists('users:1'));       // true — 'users:*' is a different namespace

await cache.shutdown();
```

### 6. Trace pub/sub delivery end to end

1. Print `activeSubscriptions()` — it returns user-facing (prefix-stripped) channel and pattern names.
2. Add a temporary logging handler and check `publish()`'s return count.
3. Confirm every process that must communicate uses the **same** `channelPrefix`.
4. Watch the console for `[PubSub]` error lines. To prove messages actually reach Redis, run `SUBSCRIBE MyApp:order:new` or `PUBSUB NUMSUB MyApp:order:new` in `redis-cli` while publishing.

```typescript
import { MemoryPubSubProvider } from 'blendsdk/webafx-cache';

const pubsub = new MemoryPubSubProvider({ channelPrefix: 'Debug' });

await pubsub.subscribe('order:new', (message) => {
    console.log('[trace] delivered:', message.channel, message.data);
});

console.log('[trace] active:', pubsub.activeSubscriptions());
// { channels: ['order:new'], patterns: [] }

const receivers = await pubsub.publish('order:new', { orderId: 1 });
console.log('[trace] receivers:', receivers); // 1 — 0 means nothing was delivered

await pubsub.shutdown();
```

### 7. Verify WebAFX plugin wiring and read the startup logs

1. Check that `plugin.name` equals `provider.serviceName` — that is the name the provider is registered under, and the name you must use to resolve it later. Defaults are `'cache'` and `'pubsub'`.
2. Read the startup logs. A correctly installed plugin logs `Cache plugin "cache" initialized (MemoryCacheProvider)` or `PubSub plugin "pubsub" initialized (RedisPubSubProvider)`. Declarative subscriptions log `PubSub: subscribed to channel "order:created"` / `PubSub: subscribed to pattern "audit:*"`. If these lines are missing, the plugin factory never ran.

```typescript
import { MemoryCacheProvider, createCachePlugin } from 'blendsdk/webafx-cache';

const provider = new MemoryCacheProvider({ rootKey: 'MyApp', serviceName: 'session-cache' });
const plugin = createCachePlugin(provider);

console.log(plugin.name);     // 'session-cache' — resolve the service under this name
console.log(plugin.priority); // 30

await provider.shutdown();
```

### 8. Use the package's own test suites as a reference environment

1. Run `pnpm run test:fast` — the memory-only suites run without Docker. If your app fails but these pass, compare your usage against the harness (contract tests, TTL tests, pub/sub tests).
2. Run `pnpm test` — it starts the Dockerized Redis on port **6399**, runs the full suite, and tears the container down.
3. Use `pnpm run test:watch` for iteration and `pnpm run docker:logs` to watch the Redis container while tests run.
4. Beware silent skips: when Redis on 6399 is unreachable, the integration suites print `⚠️  Redis not available on port 6399 — skipping Redis integration tests` and then pass anyway. A fully green run with that warning did **not** exercise Redis.

---

## Known Pitfalls

### `undefined` can never be cached

`JSON.stringify(undefined)` returns `undefined` — not a string. Depending on the backend, an `undefined` value is either stored as garbage that never parses back (so `get()` always returns `undefined`, indistinguishable from a miss) or rejected by the transport; the memory backend's `exists()`/`ttl()` may even report the key as present. In `getOrSet()`, a factory that produces `undefined` runs again on every call, defeating the cache entirely. Represent "nothing" as `null` (which serializes to the literal `"null"` and caches correctly) or as a sentinel object.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({ rootKey: 'Pitfalls', cleanupIntervalMs: 0 });

async function findUser(id: number): Promise<{ id: number; name: string } | null> {
    return id === 1 ? { id: 1, name: 'Alice' } : null;
}

// "Not found" is represented as null — it caches cleanly as the JSON literal "null".
const user = await cache.getOrSet('user:999', async () => findUser(999), 60);
console.log(user); // null — and the factory will NOT run again while the entry lives

await cache.shutdown();
```

### `getOrSet()` has no stampede protection

On concurrent misses for the same key, every caller runs the factory — the method is get → produce → set, with no locking. For expensive factories, de-duplicate in-flight loads yourself:

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

interface User {
    id: number;
    name: string;
}

const cache = new MemoryCacheProvider({ rootKey: 'Pitfalls', cleanupIntervalMs: 0 });
const inFlight = new Map<string, Promise<User>>();

async function loadUserOnce(key: string, factory: () => Promise<User>, ttlSeconds?: number): Promise<User> {
    const existing = inFlight.get(key);
    if (existing) {
        return existing;
    }
    const pending = cache.getOrSet<User>(key, factory, ttlSeconds);
    inFlight.set(key, pending);
    try {
        return await pending;
    } finally {
        inFlight.delete(key);
    }
}

let dbCalls = 0;
const factory = async (): Promise<User> => {
    dbCalls++;
    return { id: 1, name: 'Alice' };
};

const [a, b, c] = await Promise.all([
    loadUserOnce('user:1', factory, 60),
    loadUserOnce('user:1', factory, 60),
    loadUserOnce('user:1', factory, 60),
]);

console.log(dbCalls, a.name, b.name, c.name); // 1 Alice Alice Alice

await cache.shutdown();
```

### Omitting a TTL falls back to `defaultTTL`; only explicit `0` disables expiry

`set(key, value)` uses the provider's `defaultTTL` when configured, and `set(key, value, 0)` means "no expiry" even when a `defaultTTL` is set. Values mysteriously disappearing is often just a `defaultTTL` you forgot — and a `defaultTTL: 0` provider never expires anything unless a per-call TTL is given.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({ rootKey: 'Pitfalls', defaultTTL: 300, cleanupIntervalMs: 0 });

await cache.set('omitted-ttl', 'value');      // inherits defaultTTL → 300 s
await cache.set('explicit-zero', 'value', 0); // 0 disables expiry entirely

console.log(await cache.ttl('omitted-ttl'));   // ~300
console.log(await cache.ttl('explicit-zero')); // -1 — no expiry

await cache.shutdown();
```

### JSON round-trip changes value types (and drops parts of them)

What you store is not exactly what you get back. `Date` becomes an ISO string, `Map`/`Set` become `{}`, `NaN`/`Infinity` become `null`, `undefined` properties vanish, class instances lose their prototypes, and the generic parameter you pass to `get<T>()` is an assertion — TypeScript cannot verify what deserialization actually produced. Cache plain DTOs and treat the round-trip as a contract.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({ rootKey: 'Pitfalls', cleanupIntervalMs: 0 });

interface EventPayload {
    at: Date;
    tags: Set<string>;
    ratio: number;
}

const payload: EventPayload = {
    at: new Date('2025-01-01T00:00:00Z'),
    tags: new Set(['a', 'b']),
    ratio: Number.NaN,
};

await cache.set('event', payload);
const restored = await cache.get<EventPayload>('event');

console.log(restored?.at instanceof Date); // false — Date serialized to an ISO string
console.log(restored?.tags);               // {} — Set has no enumerable properties
console.log(restored?.ratio);              // null — NaN is not valid JSON

await cache.shutdown();
```

### `unsubscribe()` removes ALL handlers for a channel

There is no per-handler removal. When one module tears down its subscription, every other subscriber on that channel in the same process goes silent — on Redis, the shared underlying `SUBSCRIBE` is dropped too.

```typescript
import { MemoryPubSubProvider } from 'blendsdk/webafx-cache';

const pubsub = new MemoryPubSubProvider();
let auditCount = 0;
let metricsCount = 0;

await pubsub.subscribe('order:new', () => { auditCount++; });
await pubsub.subscribe('order:new', () => { metricsCount++; });

// The audit module tears down — this removes the metrics handler too!
await pubsub.unsubscribe('order:new');

await pubsub.publish('order:new', { orderId: 1 });
console.log(auditCount, metricsCount); // 0 0 — both silenced

await pubsub.shutdown();
```

If independent components share a channel, keep the subscription alive for the provider's lifetime instead of unsubscribing per component.

### `publish()` receiver counts differ between backends

The memory provider counts **local handlers invoked**; the Redis provider returns Redis's subscriber count — **client connections that received the message**. A single process with five handlers on a channel still counts as `1` on Redis. Never assert exact counts in backend-agnostic code; treat `> 0` as "at least one subscriber received this".

### Only `*` is portable in patterns

The cache's `deletePattern()` and pub/sub `psubscribe()` accept glob wildcards, but the backends are not fully equivalent: Redis `SCAN`/`PSUBSCRIBE` support `?` and `[...]` character classes, while the memory cache treats `?` and brackets as literal characters, and the memory pub/sub supports `?` but not brackets. Standardize on plain `*` wildcards for code that must run on both backends.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({ rootKey: 'Patterns', cleanupIntervalMs: 0 });

await cache.set('user:1', 'a');

// '?' is Redis single-character syntax — the memory backend treats it literally
console.log(await cache.deletePattern('user:?')); // 0 (Redis would delete 1)
console.log(await cache.deletePattern('user:*')); // 1 — portable

await cache.shutdown();
```

### Nested `rootKey` / `channelPrefix` values overlap

Namespaces are plain string prefixes followed by `:`. If one `rootKey` is another `rootKey` plus `:` plus anything (`App` and `App:sub`), then `clear()` and `deletePattern()` on the outer namespace reach into the nested one on Redis, because both share the same database and `App:*` matches `App:sub:key`. Use flat, sibling names (`app-sessions`, `app-products`) instead of nesting.

```typescript
import { RedisCacheProvider } from 'blendsdk/webafx-cache';

const outer = new RedisCacheProvider({ rootKey: 'App', host: 'localhost', port: 6379 });
const nested = new RedisCacheProvider({ rootKey: 'App:sub', host: 'localhost', port: 6379 });

await nested.set('key', 'nested-value');

// outer.clear() SCANs for 'App:*' — which also matches 'App:sub:key'
await outer.clear();

console.log(await nested.get('key')); // undefined — deleted by the outer namespace

await outer.shutdown();
await nested.shutdown();
```

### In-memory backends are per-process

`MemoryCacheProvider` state lives in one Node process, and `MemoryPubSubProvider` delivers only within that process. In a multi-instance deployment you get stale reads, duplicated work, and `publish()` returning `0` for cross-instance listeners — the message never leaves the process. Switch to `type: 'redis'` for anything beyond a single instance.

```typescript
import { createCache, type CacheFactoryConfig } from 'blendsdk/webafx-cache';

const config: CacheFactoryConfig = {
    type: process.env.NODE_ENV === 'production' ? 'redis' : 'memory',
    rootKey: 'MyApp',
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : undefined,
};

const cache = createCache(config);
console.log('backend:', cache.constructor.name); // MemoryCacheProvider | RedisCacheProvider

await cache.shutdown();
```

### Forgetting `shutdown()` keeps Node.js processes alive

The ioredis connections of Redis providers hold the event loop open — scripts can hang after their last statement until `shutdown()` is called. The memory provider's cleanup timer is `unref()`'d, so it never keeps the process alive. Inside WebAFX the plugin wires shutdown into the application lifecycle automatically; standalone scripts must call it explicitly.

```typescript
import { RedisCacheProvider } from 'blendsdk/webafx-cache';

const cache = new RedisCacheProvider({ rootKey: 'MyApp', host: 'localhost', port: 6379 });

await cache.set('k', 'v');
console.log(await cache.get<string>('k'));

// Without this line the process may stay alive — ioredis keeps sockets open.
await cache.shutdown();
```

### Custom `serviceName` changes the name you look the service up by

The plugin's name **is** the provider's `serviceName` — `'cache'` and `'pubsub'` by default. When you register multiple providers (or rename one), the service must be resolved by the exact configured name, not the default. Keep names unique per application.

```typescript fragment
// Two independent cache services — each plugin registers under its own name.
app.use(redisCachePlugin({ rootKey: 'Sessions', serviceName: 'session-cache', host: 'localhost' }));
app.use(redisCachePlugin({ rootKey: 'Products', serviceName: 'product-cache', host: 'localhost' }));

// Retrieve them by the configured names ('session-cache' / 'product-cache'),
// never the default 'cache'.
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
