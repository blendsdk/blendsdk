> **Package**: `blendsdk/webafx-cache`

# webafx-cache Best Practices

This document collects the do's and don'ts, anti-patterns, performance tips, and security notes for `blendsdk/webafx-cache`. Every rule is grounded in how the package actually behaves — the abstract base classes (`CacheProvider`, `PubSubProvider`), the Redis and in-memory backends, and the WebAFX plugin factories. All examples are ESM, target Node.js >= 22, and import exclusively from the package root `blendsdk/webafx-cache`.

**Rules at a glance:**

- Create providers once at startup; share them as application-wide singletons.
- Await every cache and pub/sub operation.
- Cache JSON-safe data only. `null` is a cached value; `undefined` is a cache miss.
- Never prefix keys or channels yourself — `rootKey` / `channelPrefix` do it for you.
- Prefer `getOrSet()` over hand-rolled get → check → set logic.
- Treat pub/sub as at-most-once, fire-and-forget messaging.
- Give each provider exactly one shutdown owner.
- Plan for the cache being unavailable — decide fail-open vs fail-closed up front.

---

## Do / Don't Pairs

### 1. Create one provider per application and share it

**Why it matters**: `RedisCacheProvider` and `RedisPubSubProvider` open ioredis connections inside their constructors. Constructing a provider per call or per request means a TCP connect and handshake for every operation, `maxclients` exhaustion on the Redis side, and sockets that are never released because nobody owns `shutdown()`. This package is designed around application-wide singletons — `createCachePlugin()` registers the provider with `type: "singleton"` in the WebAFX service container.

❌ Wrong:

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";

// ❌ A brand-new TCP connection to Redis for every user lookup
async function getUserName(userId: string): Promise<string> {
    const cache = new RedisCacheProvider({
        rootKey: "MyApp",
        host: "localhost",
        port: 6379,
    });

    return await cache.getOrSet<string>(`user:${userId}:name`, async () => {
        return `User-${userId}`;
    });
}

console.log(await getUserName("123"));
```

✅ Correct:

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";

// ✅ One provider for the whole application, created at startup
const cache = new RedisCacheProvider({
    rootKey: "MyApp",
    host: "localhost",
    port: 6379,
    defaultTTL: 300,
});

async function getUserName(userId: string): Promise<string> {
    return await cache.getOrSet<string>(`user:${userId}:name`, async () => {
        return `User-${userId}`;
    });
}

try {
    console.log(await getUserName("123"));
} finally {
    await cache.shutdown();
}
```

> In a WebAFX application, `createCachePlugin(cache)` / `redisCachePlugin(...)` register the provider as a singleton service, so every consumer resolves the same connection. In plain Node.js, keep the provider at module scope or in your DI container.

---

### 2. Store JSON-safe values only — never `undefined`, never live class instances

**Why it matters**: both backends JSON-serialize on `set()` and parse on `get()`. Two consequences follow. First, `JSON.stringify(undefined)` produces `undefined`, which cannot be parsed back — both providers treat unparsable data as a miss, so a key written with `undefined` can never be read (and `getOrSet()` factories returning `undefined` recompute forever). Second, values do not round-trip structurally: `Date` becomes a string, `Set`/`Map` become `{}`, `NaN`/`Infinity` become `null`, and class instances lose their prototypes. `get<T>()` is a type assertion, not a reconstruction.

❌ Wrong:

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

interface Session {
    id: string;
    startedAt: Date;
    tags: Set<string>;
}

const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

const session: Session = {
    id: "s-1",
    startedAt: new Date("2026-01-01T00:00:00Z"),
    tags: new Set(["admin"]),
};

await cache.set(`session:${session.id}`, session, 3600);

// JSON mangled the payload: Date → string, Set → {}
// get<Session> only asserts the type; it does not restore it
const restored = await cache.get<Session>(`session:${session.id}`);
console.log(restored?.startedAt.toISOString()); // ❌ TypeError at runtime
```

✅ Correct:

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

// ✅ Plain, JSON-safe DTO — what goes in is exactly what comes out
interface SessionDto {
    id: string;
    startedAt: string;
    tags: string[];
}

const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

const session: SessionDto = {
    id: "s-1",
    startedAt: new Date().toISOString(),
    tags: ["admin"],
};

await cache.set(`session:${session.id}`, session, 3600);

const restored = await cache.get<SessionDto>(`session:${session.id}`);
if (restored !== undefined) {
    const startedAt = new Date(restored.startedAt); // revive at the boundary
    console.log(startedAt.toISOString());
}
```

The same round-trip rule answers the `undefined` question:

```typescript
// ❌ undefined cannot survive the JSON round-trip — the write "succeeds",
// but every subsequent get() reports a miss
await cache.set("user:1:phone", undefined);

// ✅ Cache null as the explicit "known to be empty" value;
// undefined stays reserved for "not cached"
await cache.set<string | null>("user:1:phone", null);
const phone = await cache.get<string | null>("user:1:phone"); // null
```

---

### 3. Let the provider namespace your keys — never prefix (or strip) manually

**Why it matters**: every key is stored as `rootKey + ":" + key` and every channel as `channelPrefix + ":" + channel` — this is applied automatically by `buildKey()` / `buildChannel()`. If you also add the prefix yourself, the key is double-namespaced (`MyApp:MyApp:user:123`), which makes it invisible to `deletePattern("user:*")` and to sibling code using the same provider with bare keys. On the pub/sub side, prefixes are stripped before handlers run, so subscriber code must always work with bare channel names.

❌ Wrong:

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

// ❌ Stored as "MyApp:MyApp:user:123" — pattern operations will never find it
await cache.set("MyApp:user:123", { name: "Alice" });

const deleted = await cache.deletePattern("user:*");
console.log(deleted); // 0 — the key was not deleted
```

✅ Correct:

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

// ✅ Stored as "MyApp:user:123" — patterns are relative to the namespace
await cache.set("user:123", { name: "Alice" });

const deleted = await cache.deletePattern("user:*");
console.log(deleted); // 1
```

The same rule applies to channels:

```typescript
// ❌ Prefixing channels yourself breaks the prefix contract —
// with channelPrefix "Shop" configured, this lands on "Shop:Shop:order:created"
await pubsub.publish("Shop:order:created", order);

// ✅ Publish to the bare channel; subscribers receive msg.channel === "order:created"
await pubsub.publish("order:created", order);
```

---

### 4. Await every cache and pub/sub operation

**Why it matters**: all methods are async. A non-awaited `set()` or `publish()` can fail (circular data in `JSON.stringify`, connection errors, non-serializable payloads) as an *unhandled rejection* — and since Node.js 15+ the default is to terminate the process on unhandled rejections. Even when no error occurs, fire-and-forget calls lose ordering: code that follows may run before the write lands. Never treat these methods as "fire and forget"; the one exception is `void`-style diagnostic publishing, and even that should be deliberate.

❌ Wrong:

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

interface TreeNode {
    id: string;
    parent: TreeNode | null;
}

const parent: TreeNode = { id: "root", parent: null };
const child: TreeNode = { id: "child", parent };
parent.parent = child; // cycle: child → parent → child

// ❌ Not awaited: JSON.stringify throws on the cycle, the rejection is
// unhandled, and the write silently never happens.
cache.set("tree:child", child);
```

✅ Correct:

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

interface TreeNode {
    id: string;
    parentId: string | null;
}

const child: TreeNode = { id: "child", parentId: "root" };

try {
    // ✅ Awaited: failures are observable, and the write completes
    // before the code that follows runs
    await cache.set("tree:child", child, 600);
    const stored = await cache.get<TreeNode>("tree:child");
    console.log(stored); // { id: "child", parentId: "root" }
} catch (error) {
    console.error("Cache write failed:", error instanceof Error ? error.message : error);
} finally {
    await cache.shutdown();
}
```

---

### 5. Prefer `getOrSet()` over hand-rolled get → check → set

**Why it matters**: the cache-aside pattern is implemented once in `CacheProvider.getOrSet()` with the correct miss test (`cached !== undefined` — not truthiness) and consistent TTL resolution. Hand-rolled variants repeatedly get the miss test wrong: a truthiness check re-runs the expensive factory for legitimately cached falsy values (`0`, `""`, `false`). Hand-rolling also duplicates TTL logic across call sites and drifts over time.

❌ Wrong:

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

const cache = new MemoryCacheProvider({ rootKey: "MyApp", defaultTTL: 300 });

async function runExpensiveCountQuery(date: string): Promise<number> {
    return date.endsWith("-01") ? 0 : 42;
}

async function getDailyReportCount(date: string): Promise<number> {
    const cached = await cache.get<number>(`report:${date}:count`);

    // ❌ Truthiness check — a legitimately cached 0 looks like a miss,
    // so the expensive query runs again on every call for quiet days.
    if (cached) {
        return cached;
    }

    const count = await runExpensiveCountQuery(date);
    await cache.set(`report:${date}:count`, count, 300);
    return count;
}

console.log(await getDailyReportCount("2026-01-01")); // 0 — query ran
console.log(await getDailyReportCount("2026-01-01")); // 0 — query ran again
```

✅ Correct:

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

const cache = new MemoryCacheProvider({ rootKey: "MyApp", defaultTTL: 300 });

async function runExpensiveCountQuery(date: string): Promise<number> {
    return date.endsWith("-01") ? 0 : 42;
}

async function getDailyReportCount(date: string): Promise<number> {
    // ✅ Correct miss test (`!== undefined`), TTL resolution, and
    // read/write ordering — implemented once in the base class
    return await cache.getOrSet<number>(
        `report:${date}:count`,
        () => runExpensiveCountQuery(date),
        300
    );
}

console.log(await getDailyReportCount("2026-01-01")); // 0 — served from cache on repeat calls
```

---

### 6. Keep pub/sub handlers small, idempotent, and self-logging

**Why it matters**: handlers are dispatched with `void safeInvoke(...)` — `publish()` resolves without waiting for handler completion, so handlers must not be relied on for sequencing. Errors thrown inside a handler are caught by the base class and logged via `console.error`, which protects the connection and other subscribers but bypasses your structured logging. Finally, Redis pub/sub is broadcast: every subscribing process (every replica) receives every message, so handlers must tolerate duplicate and concurrent execution.

❌ Wrong:

```typescript
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";

interface OrderEvent {
    orderId: string;
    total: number;
}

const pubsub = new MemoryPubSubProvider({ channelPrefix: "Shop" });

async function chargeCustomer(orderId: string, total: number): Promise<void> {
    console.log(`charged ${total} for ${orderId}`);
}

async function sendReceiptEmail(orderId: string): Promise<void> {
    console.log(`receipt sent for ${orderId}`);
}

// ❌ Long-running, non-idempotent work directly in the handler:
// failures land only in console.error, and a redelivery would double-charge
await pubsub.subscribe<OrderEvent>("order:created", async (msg) => {
    await chargeCustomer(msg.data.orderId, msg.data.total);
    await sendReceiptEmail(msg.data.orderId);
});

await pubsub.publish("order:created", { orderId: "o-1", total: 49.99 });
```

✅ Correct:

```typescript
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";

interface OrderEvent {
    orderId: string;
    total: number;
}

const pubsub = new MemoryPubSubProvider({ channelPrefix: "Shop" });

async function enqueueHandling(order: OrderEvent): Promise<void> {
    // Fast, idempotent hand-off to the system that owns retries and acks
    console.log(`queued: ${order.orderId}`);
}

// ✅ Small handler, idempotent side effect, own error context
await pubsub.subscribe<OrderEvent>("order:created", async (msg) => {
    try {
        await enqueueHandling(msg.data);
    } catch (error) {
        console.error(
            `order:created handler failed for ${msg.data.orderId}:`,
            error instanceof Error ? error.message : error
        );
    }
});

await pubsub.publish("order:created", { orderId: "o-1", total: 49.99 });
await pubsub.shutdown();
```

> If downstream code needs to know that an event was *processed*, have the handler signal completion (for example, by writing a result key to the cache) — waiting on `publish()` does not provide that guarantee.

---

### 7. Pick the backend for your deployment topology, not for convenience

**Why it matters**: the in-memory backends are per-process. In a load-balanced deployment, each instance builds its own private cache (inconsistent responses between requests) and pub/sub messages never leave the publishing process, so other replicas never see the event. Use `createCache()` / `createPubSub()` with the `type` discriminator so switching backends is configuration, not a code change.

❌ Wrong:

```typescript
import { memoryCachePlugin, memoryPubSubPlugin } from "blendsdk/webafx-cache";

// ❌ Hardcoded memory backends in a load-balanced production deployment:
// every instance caches independently, and "order:created" events only
// reach subscribers inside the publishing process.
const cachePlugin = memoryCachePlugin({ rootKey: "MyApp", defaultTTL: 300 });
const pubSubPlugin = memoryPubSubPlugin({ channelPrefix: "MyApp" });

console.log(cachePlugin.name, pubSubPlugin.name); // "cache", "pubsub"
```

✅ Correct:

```typescript
import { createCache, createPubSub } from "blendsdk/webafx-cache";

const useRedis = process.env.NODE_ENV === "production";

// ✅ One code path; the backend is a deployment decision
const cache = createCache({
    type: useRedis ? "redis" : "memory",
    rootKey: "MyApp",
    defaultTTL: 300,
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : undefined,
});

const pubsub = createPubSub({
    type: useRedis ? "redis" : "memory",
    channelPrefix: "MyApp",
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : undefined,
});

console.log(cache.serviceName, pubsub.serviceName); // "cache", "pubsub"
// Register with WebAFX via createCachePlugin(cache) / createPubSubPlugin(pubsub)
```

---

### 8. Give each provider exactly one shutdown owner

**Why it matters**: `shutdown()` on a Redis provider closes the ioredis connection(s) via `quit()`. A second shutdown on an already-closed connection rejects — the package's own test suites avoid double shutdown for exactly this reason. Calling `shutdown()` manually on a provider that a WebAFX plugin owns creates that collision, because `createCachePlugin()` / `createPubSubPlugin()` already wire `dispose` and `shutdown` hooks into the application lifecycle. Conversely, *never* shutting down a standalone provider leaves connections (and, for memory, a cleanup timer) alive.

❌ Wrong:

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";

const cache = new RedisCacheProvider({ rootKey: "MyApp", host: "localhost", port: 6379 });

// ... application runs; in a WebAFX app the plugin already owns shutdown ...

// ❌ Second shutdown: the connection is already closed,
// so this call rejects ("Connection is closed")
await cache.shutdown();
await cache.shutdown();
```

✅ Correct:

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";

const cache = new RedisCacheProvider({ rootKey: "MyApp", host: "localhost", port: 6379 });

try {
    await cache.set("user:123", { name: "Alice" }, 300);
    console.log(await cache.get<{ name: string }>("user:123"));
} finally {
    // ✅ Exactly one shutdown per provider
    await cache.shutdown();
}
```

> In a WebAFX application, simply pass the provider to `createCachePlugin(provider)` / `createPubSubPlugin(provider)` and do **not** call `shutdown()` yourself — let the framework own it.

---

### 9. Decide (and code) how the app behaves when Redis is down

**Why it matters**: every operation against a Redis backend rejects when the server is unreachable and retries are exhausted. If the cache sits on the critical request path with no fallback, a Redis outage becomes an application outage. A common, defensible policy is fail-open for reads (fall back to the source of truth) and fail-closed only where data consistency demands it — with the degradation logged so health dashboards can see it.

❌ Wrong:

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";

interface Product {
    id: string;
    name: string;
}

const cache = new RedisCacheProvider({ rootKey: "MyApp", host: "localhost", port: 6379 });

async function loadProduct(id: string): Promise<Product> {
    return { id, name: `Product-${id}` };
}

// ❌ No fallback: a Redis outage rejects this function even though
// the database behind it is perfectly healthy
async function getProduct(id: string): Promise<Product> {
    return await cache.getOrSet<Product>(`product:${id}`, () => loadProduct(id), 300);
}

console.log(await getProduct("p-1"));
```

✅ Correct:

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";

interface Product {
    id: string;
    name: string;
}

const cache = new RedisCacheProvider({ rootKey: "MyApp", host: "localhost", port: 6379 });

async function loadProduct(id: string): Promise<Product> {
    return { id, name: `Product-${id}` };
}

// ✅ Fail-open: cache trouble degrades to the source of truth,
// with the outage logged for observability
async function getProduct(id: string): Promise<Product> {
    try {
        return await cache.getOrSet<Product>(`product:${id}`, () => loadProduct(id), 300);
    } catch (error) {
        console.error(
            "Cache unavailable, serving from source:",
            error instanceof Error ? error.message : error
        );
        return await loadProduct(id);
    }
}

console.log((await getProduct("p-1")).name);
```

---

## Anti-Patterns

### Assuming `await publish()` means handlers have finished

Both providers dispatch handlers with `void safeInvoke(...)`; `publish()` resolves once the message is handed to the memory handler maps or acknowledged by the Redis broker — not once your handler ran. Never sequence downstream logic (tests, state assertions, follow-up publishes) on the resolution of `publish()`.

### Treating the return value of `publish()` as a business signal

The two backends count different things: `MemoryPubSubProvider.publish()` returns the number of **in-process handlers** invoked, while `RedisPubSubProvider.publish()` returns the number of **subscribed Redis connections** (which includes other replicas, and is not your handler count). Use the value for diagnostics only.

### Expecting exactly-once or durable delivery

Pub/sub is fire-and-forget. Messages published while a subscriber is disconnected are gone (no buffering, no replay), and with Redis every subscribing process receives every message — it is a broadcast, not a work queue. Never use pub/sub as a system of record, and never build retry-until-ack job processing directly on it without a persistence layer.

### Treating the cache as a system of record

Cache entries expire, are evicted, or vanish when a process restarts (memory backend). Non-null-asserting `get()` results, or making authoritative decisions from cached state, produce intermittent production bugs that vanish under load testing. Handle `undefined` at every read; make the miss path the normal path (`getOrSet()` was built for this).

### Unbounded, never-invalidated caches

`defaultTTL` is `0` (no expiry) unless you set it, and nothing evicts unexpired entries. One permanent key per user, request, or URL grows the process heap (memory backend) or pushes Redis toward `maxmemory` eviction, which silently drops *unrelated* keys:

```typescript
// ❌ One permanent key per URL — grows without bound
await cache.set(`page:${url}`, html);

// ✅ Bounded lifetime
await cache.set(`page:${url}`, html, 600);
```

Reserve `TTL 0` for small, genuinely static lookup tables.

### Copying test-only settings into production

The package's own tests use settings that are wrong for long-running applications: `cleanupIntervalMs: 0` disables proactive eviction (deterministic for tests, but expired-but-never-read entries then occupy memory indefinitely), and `maxRetriesPerRequest: 0` fails fast on any transient hiccup (deliberate in tests, harmful in production).

```typescript
// ❌ Lifted from test setup — wrong defaults for a long-running app
const testCache = new MemoryCacheProvider({
    rootKey: "MyApp",
    cleanupIntervalMs: 0, // expired entries are only freed on access
});

// ✅ Production default: periodic cleanup every 60 s (timer is unref'd)
const productionCache = new MemoryCacheProvider({ rootKey: "MyApp" });
```

For Redis, leave `maxRetriesPerRequest` at its default (`3`) unless you have a specific reason to change it.

### Non-deterministic or colliding namespaces

Test files generate namespaces like `` `RedisTest_${Date.now()}` `` to isolate runs — in production that pattern is a bug: every deploy gets a fresh cold namespace and the old keys linger forever, bloating Redis. Likewise, two unrelated features sharing one `rootKey` can wipe each other with a single `clear()`.

```typescript
// ❌ Test pattern leaked into production: a fresh namespace every run
const volatileCache = new RedisCacheProvider({
    rootKey: `RedisTest_${Date.now()}`,
    host: "localhost",
});

// ✅ Stable, concern-scoped namespace (with the environment in the name)
const stableCache = new RedisCacheProvider({ rootKey: "shop-prod" });
```

Use one `rootKey` / `channelPrefix` per concern, and distinct `serviceName` registrations when a single application needs multiple independent caches or buses.

### Caching `undefined` results through `getOrSet()`

A factory that returns `undefined` writes a value that can never be read back (see section 2), so the key behaves as a permanent miss and the factory runs on *every* call — the worst of both worlds. Use `null` as the cached "known to be absent" sentinel.

---

## Performance Tips

### Batch independent operations

Each Redis-backed call is a network round trip; sequential awaits multiply latency. Parallel calls overlap on the shared connection:

```typescript
// ❌ N sequential round trips
for (const product of products) {
    await cache.set(`product:${product.id}`, product, 300);
}

// ✅ Issued in parallel — wall-clock time of one round trip batch
await Promise.all(products.map((p) => cache.set(`product:${p.id}`, p, 300)));
```

### Know that `getOrSet()` is not single-flight

`getOrSet()` performs a non-atomic read-then-write: when a hot key is cold or just expired, every concurrent caller that misses runs the factory. For expensive factories, deduplicate in-process (one shared promise per key) and/or add TTL jitter (below). Assuming `cache` (a `CacheProvider`) and `loadUser(id)` are in scope:

```typescript
// One shared recomputation per key, per process
const inFlight = new Map<string, Promise<User>>();

async function getUser(id: string): Promise<User> {
    const key = `user:${id}`;
    const pending = inFlight.get(key);
    if (pending) {
        return await pending;
    }

    const load = cache.getOrSet<User>(key, () => loadUser(id), 300);
    inFlight.set(key, load);
    try {
        return await load;
    } finally {
        inFlight.delete(key);
    }
}
```

For cross-instance stampedes, combine this with an application-level Redis `SET NX` lock around the recomputation.

### Add TTL jitter to bulk-populated keys

If you warm thousands of keys with the same TTL during deploy, they expire within the same second and trigger a synchronized recomputation wave every TTL period. Spread expirations:

```typescript
const baseTTL = 300;
const jitter = Math.floor(Math.random() * 60); // 0–59 s
await cache.set(`product:${id}`, product, baseTTL + jitter);
```

### Invalidate narrowly instead of blasting namespaces

`deletePattern()` on Redis uses `SCAN` with `MATCH` — non-blocking, but `MATCH` filters *after* scanning, so the whole keyspace is still iterated. `clear()` is literally `deletePattern("*")`. Design keys for the smallest invalidation set (`user:123:*` rather than `user:*`), or version keys (`report:v5:...`) and let old versions expire instead of deleting them.

### Keep values small

Every operation JSON-serializes or parses the full payload in-process, and Redis transfers the whole string per `get()`. Multi-hundred-KB blobs are CPU cost on every read/write. Cache IDs and handles, split large structures into multiple keys, or compress before caching when payload size is unavoidable.

### Use exact channel subscriptions where you can

Multiple local handlers on one channel cost only one Redis `SUBSCRIBE` (handlers fan out in-process), but every `psubscribe()` pattern adds server-side matching work for each published message. Prefer exact channels when the set of names is known; reserve patterns for genuine channel families (`order:*`, `audit:*`).

### Keep the memory provider's cleanup timer enabled

The cleanup interval (default 60 s) frees expired entries that are never read again, bounding heap growth; it is `unref()`-ed so it never keeps the Node.js process alive. Disable it (`cleanupIntervalMs: 0`) **only** in tests, as the package's own suites do. Also avoid health-polling Redis per request — `health()` is wired into the WebAFX `/health` endpoint by the plugins; use that instead of hot-path `PING`s.

---

## Security Considerations

### Use TLS and credential hygiene for Redis connections

The connection configuration is passed straight to ioredis, so a `rediss://` URL enables TLS. Keep credentials out of source code — read them from the environment or a secret manager — and never log connection URLs, which embed passwords.

```typescript
// ✅ TLS + credentials from the environment
const cache = new RedisCacheProvider({
    rootKey: "MyApp",
    url: process.env.REDIS_URL, // rediss://user:password@host:6380/0
});
```

### Namespaces are collision guards, not access control

`rootKey` and `channelPrefix` isolate keys and channels by convention — any client holding Redis credentials can read, overwrite, or clear every namespace. Enforce isolation at the Redis level: use ACLs to grant specific key patterns (`~shop-prod:*`) and channels (`&shop-prod:*`) per service, and use separate databases or instances where tenant isolation matters. Treat `serviceName` as a registration detail, never as a security boundary.

### Validate data read back from the cache

`get<T>()` is a type assertion, not a decoder — values are simply `JSON.parse`d and returned. If the cache is shared with other services (or otherwise writable by someone else), a corrupt or malicious writer can poison your process with unexpected shapes. Runtime-validate before use:

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

interface Account {
    id: string;
    balance: number;
}

const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

function decodeAccount(raw: unknown): Account | undefined {
    if (typeof raw !== "object" || raw === null) {
        return undefined;
    }
    if (!("id" in raw) || !("balance" in raw)) {
        return undefined;
    }
    const { id, balance } = raw;
    if (typeof id === "string" && typeof balance === "number") {
        return { id, balance };
    }
    return undefined;
}

await cache.set("account:acc-1", { id: "acc-1", balance: 125.5 });

// get<T>() asserts; decodeAccount() actually validates
const account = decodeAccount(await cache.get<unknown>("account:acc-1"));
if (account !== undefined) {
    console.log(account.balance); // 125.5
}
```

### Treat cached content and published messages as plaintext

Redis stores cache values as plain JSON strings, visible in `RDB`/`AOF` snapshots, replicas, backups, and memory dumps — and pub/sub messages are delivered in plaintext to every ACL-authorized subscriber. Avoid caching raw secrets or PII when a token or handle will do; put short TTLs on anything sensitive; encrypt at the application layer when the data classification demands it.

### Guard key and pattern interpolation against glob injection

`deletePattern()` interprets `*` and `?` as wildcards (Redis `SCAN MATCH` glob semantics; the memory backend converts them to regex equivalents). If a key segment is built from untrusted input, a crafted value can broaden a pattern-based invalidation and delete keys outside the intended set. Allow-list or encode segments before they reach a pattern — note that `encodeURIComponent()` does **not** escape `*`:

```typescript
// ❌ `tenantId` comes from a request — "*" would match every tenant's keys
await cache.deletePattern(`tenant:${tenantId}:*`);

// ✅ Allow-list the segment before it reaches a pattern
if (!/^[A-Za-z0-9_-]+$/.test(tenantId)) {
    throw new Error(`Invalid tenant id: "${tenantId}"`);
}
await cache.deletePattern(`tenant:${tenantId}:*`);
```

### Isolate environments by instance and namespace

Point dev, staging, and production at different Redis instances (or at minimum different databases **and** different `rootKey` prefixes). A shared instance with a shared namespace means a staging `clear()` can wipe production cache data — and a staging publisher can trigger production handlers on the same channel.

---

## See Also

- `00-overview.md` — architecture, feature list, and the minimum example for `blendsdk/webafx-cache`.
- `07-testing-strategy.md` — contract tests and TTL behavior tests; several practices in this document (double-shutdown avoidance, `cleanupIntervalMs: 0`, unique root keys) are visible in that suite as *test-only* techniques not to be copied into production code.

---

# webafx-cache Testing Patterns

How to test code that uses `blendsdk/webafx-cache`. The patterns below are derived from the package's own test files — the contract suites, plugin factory tests, TTL timing suites, and provider tests — and are written against the public import surface (`blendsdk/webafx-cache`), exactly as a consumer project would use them.

The central testing fact about this package: **both hierarchies have two interchangeable backends that honor the same abstract contract**. The in-memory backends are real, fast, and dependency-free, so the vast majority of tests need no Docker, no Redis, and no mocks — you test against `MemoryCacheProvider` / `MemoryPubSubProvider` and let the package's contract suites guarantee that Redis behaves identically.

---

## Test Setup

### Framework and Configuration

The package's suites use **Vitest 4.x** with `@vitest/coverage-v8`, running on **Node.js >= 22** with ESM-only TypeScript test files (relative imports use the `.js` extension). No build step is required — Vitest transforms TypeScript on the fly.

A configuration that matches how the package's suites behave:

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // The providers are backend libraries — no DOM is needed
        environment: "node",
        include: ["tests/**/*.test.ts"],
        // TTL tests use real delays (1–3 s TTLs plus safety margins)
        testTimeout: 15_000,
        hookTimeout: 15_000,
    },
});
```

The package's own `package.json` scripts show the intended workflow:

| Script | Purpose |
|--------|---------|
| `yarn test:fast` | Unit tests only — **no Docker required** (Redis suites auto-skip) |
| `yarn test:watch` | Re-run on change |
| `yarn test:coverage` | Coverage run via `@vitest/coverage-v8` |
| `yarn docker:up` | Start the test Redis via docker-compose (host port **6399**) |
| `yarn docker:down` | Stop the test Redis and remove volumes |
| `yarn docker:logs` | Follow the Redis container logs |
| `yarn test` | Full lifecycle: `docker:down` → `docker:up` → `vitest run` → `docker:down` |

### When Docker Is Needed

The test Redis runs on **port 6399** (`docker-compose` maps `6399` → container `6379`) specifically so it never collides with a developer's local Redis on 6379.

| Suite type | Backend | Docker needed |
|------------|---------|---------------|
| Consumer unit tests | `MemoryCacheProvider` / `MemoryPubSubProvider` | No |
| Plugin factory tests | Memory (Redis factories only assert metadata) | No |
| Contract suites (`abstract-contract`, `pubsub-contract`) | Both — Redis part auto-skips | Optional |
| TTL behavior suite | Both — Redis part auto-skips | Optional |
| Redis integration suites (`redis-cache-provider`, `redis-pubsub`) | `RedisCacheProvider` / `RedisPubSubProvider` | Yes |

For a consumer project, the equivalent of `docker:up` is:

```bash
docker run --rm -d -p 6399:6379 --name webafx-cache-redis redis:7-alpine
```

### Required Imports

All test imports come from the package root. The symbols most useful in tests:

| Import | Kind | Typical use |
|--------|------|-------------|
| `MemoryCacheProvider` | class | Unit tests, contract tests, Docker-free CI |
| `RedisCacheProvider` | class | Integration tests |
| `MemoryPubSubProvider` | class | Unit tests for messaging |
| `RedisPubSubProvider` | class | Integration tests for messaging |
| `CacheProvider` | abstract class | Dependency-injection type, contract-suite factory return, custom stubs |
| `PubSubProvider` | abstract class | Same role for pub/sub |
| `createCachePlugin`, `memoryCachePlugin`, `redisCachePlugin`, `createCache` | functions | Cache plugin factory tests |
| `createPubSubPlugin`, `memoryPubSubPlugin`, `redisPubSubPlugin`, `createPubSub` | functions | Pub/sub plugin factory tests |
| `PubSubMessage`, `MessageHandler`, `SubscriptionDefinition` | types | Handler typing, envelope assertions, declarative subscription fixtures |
| `RedisCacheConfig`, `MemoryCacheConfig`, `RedisPubSubConfig`, `MemoryPubSubConfig`, `CacheFactoryConfig`, `PubSubFactoryConfig` | types | Fixture configuration objects |
| `DEFAULT_SERVICE_NAME`, `DEFAULT_PUBSUB_SERVICE_NAME`, `DEFAULT_TTL`, `KEY_SEPARATOR`, `CHANNEL_SEPARATOR` | constants | Asserting defaults instead of hardcoding `'cache'`, `'pubsub'`, `':'` |
| `PubSubPluginOptions` | type | Typed plugin options in fixtures |

Note that `ioredis` is a runtime dependency of `blendsdk/webafx-cache`; the integration helpers below import `Redis` from it directly. If your package manager does not hoist transitive dependencies, add `ioredis` to your devDependencies.

### Test Helper Module

These helpers mirror the ones the package's suites define inline. Put them in a shared module so every suite can reuse them:

```typescript
// tests/helpers/cache-test-helpers.ts
import { Redis } from "ioredis";
import type { PubSubMessage, MessageHandler } from "blendsdk/webafx-cache";

/** Redis test connection config — matches the package's docker-compose (port 6399). */
export const REDIS_TEST_CONFIG = {
    host: "localhost",
    port: 6399,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
};

/** Pause the current test for the given number of milliseconds. */
export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Give pub/sub subscriptions time to establish (Redis) or handlers a tick to run (memory). */
export function settle(ms = 150): Promise<void> {
    return delay(ms);
}

/** Probe the test Redis once so suites can auto-skip when Docker is not running. */
export async function isRedisAvailable(): Promise<boolean> {
    const probe = new Redis({
        host: REDIS_TEST_CONFIG.host,
        port: REDIS_TEST_CONFIG.port,
        lazyConnect: true,
        maxRetriesPerRequest: 0,
    });

    try {
        await probe.connect();
        return (await probe.ping()) === "PONG";
    } catch {
        return false;
    } finally {
        try {
            await probe.quit();
        } catch {
            // The probe never connected — there is nothing to close.
        }
    }
}

/** A promise/handler pair that resolves on the next message received by the handler. */
export function waitForMessage<T = unknown>(timeoutMs = 2000): {
    promise: Promise<PubSubMessage<T>>;
    handler: MessageHandler<T>;
} {
    let deliver: (message: PubSubMessage<T>) => void = () => undefined;
    const promise = new Promise<PubSubMessage<T>>((resolve, reject) => {
        deliver = resolve;
        setTimeout(() => reject(new Error("Timeout waiting for a pub/sub message")), timeoutMs);
    });
    const handler: MessageHandler<T> = (message) => {
        deliver(message);
    };
    return { promise, handler };
}

/** A promise/handler pair that resolves after collecting `count` messages. */
export function collectMessages<T = unknown>(count: number, timeoutMs = 2000): {
    promise: Promise<PubSubMessage<T>[]>;
    handler: MessageHandler<T>;
} {
    const messages: PubSubMessage<T>[] = [];
    let deliver: (messages: PubSubMessage<T>[]) => void = () => undefined;
    const promise = new Promise<PubSubMessage<T>[]>((resolve, reject) => {
        deliver = resolve;
        setTimeout(
            () => reject(new Error(`Timeout: received ${messages.length}/${count} messages`)),
            timeoutMs
        );
    });
    const handler: MessageHandler<T> = (message) => {
        messages.push(message);
        if (messages.length >= count) {
            deliver(messages);
        }
    };
    return { promise, handler };
}
```

### Redis Availability Detection

Redis suites never fail when Docker is down. A `beforeAll` probe runs once, and every Redis test carries a guard clause:

```typescript
import { beforeAll } from "vitest";
import { isRedisAvailable } from "./helpers/cache-test-helpers.js";

let redisAvailable = false;

beforeAll(async () => {
    redisAvailable = await isRedisAvailable();
    if (!redisAvailable) {
        console.warn("Redis is not available on port 6399 — skipping Redis integration tests");
    }
});
```

Inside each Redis test, the guard is a plain early return:

```typescript
import { describe, it, expect } from "vitest";

describe("Redis gating", () => {
    it("should skip gracefully when Docker is not running", async () => {
        // The check must happen inside the test body — availability is only
        // known after beforeAll has run, not at test-collection time.
        if (!redisAvailable) return;

        expect(redisAvailable).toBe(true);
    });
});
```

This is exactly the approach the package's suites use (`shouldSkip` callbacks in the contract runners, `if (!redisAvailable) return;` in individual tests). The test reports as passing when skipped — which is what keeps `yarn test:fast` green on machines without Docker.

### Isolation and Timing Rules

The package's suites follow these rules; adopt them in consumer tests:

1. **Use a unique `rootKey` / `channelPrefix` per suite or per test run.** The contract suites append counters and `Date.now()` (`Contract_Redis_${++redisCounter}_${Date.now()}`). This makes parallel test files and leftover keys from crashed runs harmless.
2. **Disable the memory cleanup timer in tests** with `cleanupIntervalMs: 0`. TTL correctness then relies purely on lazy eviction at `get`/`exists`/`ttl` time — fully deterministic, no background timer involved.
3. **Track every provider and shut it down in `afterEach`.** Wrap Redis shutdowns in `try/catch`; calling `quit()` on an already-closed connection rejects.
4. **Never shut a Redis provider down twice.** The contract suite creates a dedicated provider for shutdown tests precisely to avoid a double `shutdown()` in `afterEach`.
5. **Clear between Redis tests**: `await cache.clear()` in `beforeEach` and `afterEach` — key namespaces are unique, but clearing keeps the database tidy.
6. **All provider methods are async — except `activeSubscriptions()`.** Always `await` cache and messaging operations; call `activeSubscriptions()` without `await`.
7. **Use real delays with generous margins for TTL tests** — 1–3 second TTLs checked after TTL + ~200 ms. Never fake timers (see [Why Fake Timers Don't Work Here](#why-fake-timers-dont-work-here)).

---

## Unit Testing

Unit tests exercise *consumer code* (services, repositories, handlers) that receives a provider. Use the in-memory backends: they implement the same contract as Redis — the package proves this with its contract suites — so you get realistic behavior with zero infrastructure.

### Depend on the Abstract Provider Types

Have application code depend on `CacheProvider` / `PubSubProvider` (the abstract classes), not on a concrete backend. Tests then inject the memory implementation. Example service:

```typescript
// src/user-service.ts
import type { CacheProvider } from "blendsdk/webafx-cache";

export interface User {
    id: string;
    name: string;
}

export class UserService {
    constructor(
        private readonly cache: CacheProvider,
        private readonly loadFromDatabase: (id: string) => Promise<User>
    ) {}

    async getUser(id: string): Promise<User> {
        return await this.cache.getOrSet<User>(`user:${id}`, () => this.loadFromDatabase(id), 300);
    }

    async invalidateUser(id: string): Promise<void> {
        await this.cache.delete(`user:${id}`);
    }
}
```

Its unit test — no Docker, no mocks of the cache:

```typescript
// tests/user-service.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MemoryCacheProvider } from "blendsdk/webafx-cache";
import { UserService } from "../src/user-service.js";
import type { User } from "../src/user-service.js";

describe("UserService", () => {
    let cache: MemoryCacheProvider;
    let service: UserService;

    const alice: User = { id: "123", name: "Alice" };

    beforeEach(() => {
        cache = new MemoryCacheProvider({
            rootKey: "UserServiceTests",
            cleanupIntervalMs: 0,
        });
        service = new UserService(cache, async () => alice);
    });

    afterEach(async () => {
        await cache.shutdown();
    });

    it("should produce a value on a cache miss", async () => {
        expect(await service.getUser("123")).toEqual(alice);
    });

    it("should reuse the cached value without invoking the loader twice", async () => {
        const load = vi.fn(async () => alice);
        const cachedService = new UserService(cache, load);

        await cachedService.getUser("123");
        await cachedService.getUser("123");

        expect(load).toHaveBeenCalledTimes(1);
    });

    it("should reload after invalidation", async () => {
        const load = vi.fn(async () => alice);
        const cachedService = new UserService(cache, load);

        await cachedService.getUser("123");
        await cachedService.invalidateUser("123");
        await cachedService.getUser("123");

        expect(load).toHaveBeenCalledTimes(2);
    });
});
```

### Synchronous Assertions

A few parts of the surface are synchronous and should be asserted without `await`:

- **Constructor validation** — an empty or whitespace-only `rootKey` throws immediately.
- **`activeSubscriptions()`** — returns `{ channels, patterns }` synchronously on both backends.
- **Plugin metadata** — `plugin.name` and `plugin.priority` are plain properties.

```typescript
import { describe, it, expect } from "vitest";
import { MemoryCacheProvider, MemoryPubSubProvider } from "blendsdk/webafx-cache";

describe("synchronous assertions", () => {
    it("should reject an empty rootKey synchronously", () => {
        expect(() => new MemoryCacheProvider({ rootKey: "" })).toThrow(
            "rootKey is required and cannot be empty"
        );
        expect(() => new MemoryCacheProvider({ rootKey: "   " })).toThrow(
            "rootKey is required and cannot be empty"
        );
    });

    it("should report active subscriptions synchronously", async () => {
        const pubsub = new MemoryPubSubProvider({ channelPrefix: "SyncCheck" });
        await pubsub.subscribe("ch1", () => undefined);
        await pubsub.psubscribe("pat:*", () => undefined);

        const subscriptions = pubsub.activeSubscriptions();

        expect(subscriptions.channels).toEqual(["ch1"]);
        expect(subscriptions.patterns).toEqual(["pat:*"]);

        await pubsub.shutdown();
    });
});
```

### Contract Assertions Quick Reference

The package's own contract suites (run identically against both backends) pin down what consumer tests can assert with confidence:

| Operation | Contract assertions |
|-----------|--------------------|
| `set` / `get` | Round-trips every JSON shape (`string`, `number`, `float`, `boolean`, `null`, object, array, nested structures); missing key → `undefined`; overwrite replaces the prior value; stored values are detached copies (JSON boundary, no shared references). |
| `delete` | `true` when the key existed, `false` otherwise; the key is unreadable afterwards. |
| `exists` | `true`/`false`; `false` after TTL expiry. |
| `expire` | `true` on an existing key; `false` on a missing or already-expired key; updates the remaining TTL. |
| `ttl` | `-1` = exists without expiry; `-2` = missing; positive seconds otherwise (Redis semantics on both backends). |
| `deletePattern` | Returns the deleted count; matching keys are gone; non-matching keys untouched; wildcards work in the middle (`api:*:active`). |
| `clear` | Removes only keys under this provider's `rootKey` — other namespaces survive. |
| `getOrSet` | Factory runs once on a miss, is skipped on a hit, and the produced value is cached with the requested TTL. |
| `health` | `true` while operational; `false` after a Redis provider is shut down. |
| `publish` | Receiver count — exact handler count on memory, connected-subscriber count on Redis. |
| `subscribe` / `psubscribe` | Delivery to exact and glob channels; `activeSubscriptions()` reflects (un-prefixed) registrations. |
| `shutdown` | Redis connections closed; memory store cleared; all subscriptions removed. |

One serialization caveat to remember when writing assertions: values must be JSON-serializable. Per `JSON.stringify` semantics, `undefined` object properties and functions are dropped, and `Date` instances come back as ISO strings.

---

## Integration Testing

Integration tests run against a real Redis instance on **port 6399**. They verify command behavior (native TTLs, SCAN-based deletion, raw key formats) and end-to-end pub/sub delivery — things the memory backend can only emulate.

### Gating on Availability

Use the `beforeAll` probe from [Redis Availability Detection](#redis-availability-detection) and guard every test. Combined with the full lifecycle script (`yarn test`), Redis suites run in CI and skip gracefully on machines without Docker.

### Complete Integration Example

```typescript
// tests/redis-cache.integration.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { Redis } from "ioredis";
import { RedisCacheProvider } from "blendsdk/webafx-cache";
import { REDIS_TEST_CONFIG, delay, isRedisAvailable } from "./helpers/cache-test-helpers.js";

let redisAvailable = false;

beforeAll(async () => {
    redisAvailable = await isRedisAvailable();
    if (!redisAvailable) {
        console.warn("Redis is not available on port 6399 — skipping Redis integration tests");
    }
});

describe("RedisCacheProvider (integration)", () => {
    let cache: RedisCacheProvider;
    let rootKey: string;

    beforeEach(async () => {
        if (!redisAvailable) return;
        rootKey = `IntegrationTest_${Date.now()}`;
        cache = new RedisCacheProvider({ ...REDIS_TEST_CONFIG, rootKey });
        await cache.clear();
    });

    afterEach(async () => {
        if (!redisAvailable) return;
        try {
            await cache.clear();
            await cache.shutdown();
        } catch {
            // The connection may already be closed — ignore cleanup failures.
        }
    });

    it("should store values under the rootKey namespace in Redis", async () => {
        if (!redisAvailable) return;

        await cache.set("mykey", "value");

        const rawClient = new Redis(REDIS_TEST_CONFIG);
        try {
            // Keys are stored as `<rootKey>:<key>` and JSON-serialized
            expect(await rawClient.get(`${rootKey}:mykey`)).toBe('"value"');
        } finally {
            await rawClient.quit();
        }
    });

    it("should expire values with Redis-native TTLs", async () => {
        if (!redisAvailable) return;

        await cache.set("temp", "value", 1);
        expect(await cache.get<string>("temp")).toBe("value");

        // 1 s TTL + 200 ms margin — the same margin the package's TTL suite uses
        await delay(1200);

        expect(await cache.get("temp")).toBeUndefined();
        expect(await cache.ttl("temp")).toBe(-2);
    });

    it("should isolate keys between providers with different rootKeys", async () => {
        if (!redisAvailable) return;

        const other = new RedisCacheProvider({
            ...REDIS_TEST_CONFIG,
            rootKey: `Other_${Date.now()}`,
        });

        try {
            await cache.set("shared-key", "from-cache");
            await other.set("shared-key", "from-other");

            await cache.clear();

            expect(await cache.get("shared-key")).toBeUndefined();
            expect(await other.get<string>("shared-key")).toBe("from-other");
        } finally {
            await other.clear();
            await other.shutdown();
        }
    });
});
```

### Pub/Sub Integration Considerations

Redis pub/sub adds two timing facts that the memory backend does not have:

1. **`SUBSCRIBE`/`PSUBSCRIBE` must round-trip before `PUBLISH` is sent** — otherwise the message is simply not delivered. The package's suites wait ~100 ms after subscribing (`settle(100)`).
2. **Delivery is a network round-trip** — use `waitForMessage()` (with its 2000 ms timeout) rather than asserting immediately after `publish()`.

The package's suites also assert that `publish()` returns `>= 1` rather than an exact count against Redis, because the count is the number of connected Redis subscribers — unless your `channelPrefix` is unique to the test, exact counts are safe.

```typescript
it("should deliver pattern messages over Redis pub/sub", async () => {
    if (!redisAvailable) return;

    const pubsub = new RedisPubSubProvider({
        ...REDIS_TEST_CONFIG,
        channelPrefix: `IntegrationPubSub_${Date.now()}`,
    });

    try {
        const { promise, handler } = waitForMessage<{ orderId: number }>();
        await pubsub.psubscribe("order:*", handler);

        // Let the PSUBSCRIBE round-trip complete before publishing
        await settle(100);

        await pubsub.publish("order:created", { orderId: 1 });

        const message = await promise;
        expect(message.channel).toBe("order:created");
        expect(message.pattern).toBe("order:*");
        expect(message.data.orderId).toBe(1);
    } finally {
        await pubsub.shutdown();
    }
});
```

*The snippet above is a `typescript fragment` — it assumes the `redisAvailable` probe, imports, and `REDIS_TEST_CONFIG` from the setup shown earlier in this section.*

The package's Redis suites additionally verify production-safety properties worth replicating for critical paths: `deletePattern` against 150+ keys (exercising multiple SCAN iterations, never `KEYS`), URL-based connections via `redis://localhost:6399`, and `health()` returning `false` after `shutdown()` closes the connection.

---

## Mocking & Stubbing

Because `MemoryCacheProvider` and `MemoryPubSubProvider` are real implementations of the same contract as the Redis backends, **most consumer tests should use them instead of mocks**. Reserve mocks and stubs for three boundaries: spying on provider calls, simulating infrastructure failure, and testing WebAFX plugin wiring.

### Spying on Provider Methods

`vi.spyOn` records calls while the provider keeps working — ideal for asserting how consumer code uses the cache:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

describe("spying on a provider", () => {
    const cache = new MemoryCacheProvider({ rootKey: "Spy", cleanupIntervalMs: 0 });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should record the calls made by the code under test", async () => {
        const setSpy = vi.spyOn(cache, "set");

        await cache.getOrSet("k", async () => "value", 60);

        expect(setSpy).toHaveBeenCalledTimes(1);
        expect(setSpy).toHaveBeenCalledWith("k", "value", 60);
    });
});
```

### Simulating Backend Failures

Subclass a memory provider and override the method you want to fail. This lets you test the consumer's degraded path (fallbacks, error handling) without a broken Redis:

```typescript
import { describe, it, expect } from "vitest";
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

class FlakyCacheProvider extends MemoryCacheProvider {
    failNextGet = false;

    override async get<T>(key: string): Promise<T | undefined> {
        if (this.failNextGet) {
            this.failNextGet = false;
            throw new Error("Cache backend unavailable");
        }
        return await super.get<T>(key);
    }
}

describe("cache failure fallback", () => {
    it("should fall back to the loader when the cache read fails", async () => {
        const cache = new FlakyCacheProvider({ rootKey: "Flaky", cleanupIntervalMs: 0 });

        const loadUser = async (id: string): Promise<{ id: string; name: string }> => ({
            id,
            name: "Alice",
        });

        const getUser = async (id: string): Promise<{ id: string; name: string }> => {
            try {
                const cached = await cache.get<{ id: string; name: string }>(`user:${id}`);
                if (cached !== undefined) {
                    return cached;
                }
            } catch {
                // Cache is down — degrade to the source of truth
            }
            return await loadUser(id);
        };

        cache.failNextGet = true;

        expect(await getUser("123")).toEqual({ id: "123", name: "Alice" });

        await cache.shutdown();
    });
});
```

The same technique covers pub/sub: extend `MemoryPubSubProvider` and override `health()` or make a handler the test subject of error-isolation assertions.

### Mocking the WebAFX Plugin Context

Plugin factories only touch two things on the WebAFX plugin context: `app.registerService` and `logger.info`. Mock both and invoke `plugin.factory(...)` directly — this is exactly what the package's own `cache-plugin.test.ts` and `pubsub-plugin.test.ts` do:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { MemoryCacheProvider, createCachePlugin } from "blendsdk/webafx-cache";

describe("createCachePlugin registration", () => {
    let provider: MemoryCacheProvider;

    afterEach(async () => {
        await provider.shutdown();
    });

    it("should register a singleton service and expose health/shutdown hooks", async () => {
        provider = new MemoryCacheProvider({ rootKey: "PluginMock", cleanupIntervalMs: 0 });
        const plugin = createCachePlugin(provider);

        const mockContext = {
            app: { registerService: vi.fn() },
            express: {},
            logger: { info: vi.fn().mockResolvedValue(undefined) },
        };

        // The mock implements only the part of the WebAFX context the adapter
        // touches; `as never` bypasses the full context typecheck — the same
        // cast the package's own plugin tests use.
        const hooks = await plugin.factory(mockContext as never);

        expect(mockContext.app.registerService).toHaveBeenCalledTimes(1);
        expect(await hooks.health()).toBe(true);
        expect(typeof hooks.shutdown).toBe("function");
    });
});
```

### Module-Level Mocking of Plugin Factories

When bootstrap code calls a plugin factory internally (e.g., `app.use(memoryCachePlugin(...))`), wrap the factory with `vi.mock` to assert *what configuration* the bootstrap produced — without creating real providers or background Redis connections:

```typescript
import { describe, it, expect, vi } from "vitest";
import { memoryCachePlugin } from "blendsdk/webafx-cache";

vi.mock("blendsdk/webafx-cache", async (importOriginal) => {
    const actual = await importOriginal<typeof import("blendsdk/webafx-cache")>();
    return {
        ...actual,
        memoryCachePlugin: vi.fn(actual.memoryCachePlugin),
    };
});

/** Minimal bootstrap under test — in a real project this lives in src/. */
function registerCache() {
    return memoryCachePlugin({ rootKey: "MyApp" });
}

describe("application bootstrap", () => {
    it("should create the cache plugin with the expected configuration", () => {
        const plugin = registerCache();

        expect(vi.mocked(memoryCachePlugin)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(memoryCachePlugin)).toHaveBeenCalledWith({ rootKey: "MyApp" });
        expect(plugin.name).toBe("cache");
    });
});
```

The spread of `actual` keeps every other export intact; wrapping `actual.memoryCachePlugin` in `vi.fn(...)` preserves real behavior while recording calls.

### Why Fake Timers Don't Work Here

`vi.useFakeTimers()` replaces `setTimeout`/`setInterval`, but:

- The memory cache compares expiry against **`Date.now()`** wall-clock time, which fake timers do not patch by default.
- Redis manages TTL **server-side** — there is nothing local to advance.

The package's TTL suites deliberately use **real delays with short TTLs** (1–3 s plus a ~200 ms margin). Follow the same approach. Because eviction is lazy on access (and the test provider runs with `cleanupIntervalMs: 0`), a plain `delay(TTL + margin)` is all you need.

---

## Test Patterns by Feature

### Cache: Core Operations and JSON Round-Trips

Cover the full JSON surface in one table-driven test and pin the serialization boundary (detached copies, no shared references):

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

describe("cache core operations", () => {
    let cache: MemoryCacheProvider;

    beforeEach(() => {
        cache = new MemoryCacheProvider({ rootKey: "CoreOps", cleanupIntervalMs: 0 });
    });

    afterEach(async () => {
        await cache.shutdown();
    });

    it("should round-trip every JSON-serializable shape", async () => {
        const values = {
            string: "hello world",
            number: 42,
            float: 3.14,
            boolean: true,
            nil: null as null,
            object: { name: "John", nested: { active: true } },
            array: [1, "two", { three: 3 }, [4, 5]],
        };

        for (const [key, value] of Object.entries(values)) {
            await cache.set(key, value);
            expect(await cache.get(key)).toEqual(value);
        }
    });

    it("should return undefined for a missing key", async () => {
        expect(await cache.get("missing")).toBeUndefined();
    });

    it("should store a detached copy (JSON boundary, no shared references)", async () => {
        const original = { items: [1, 2, 3] };
        await cache.set("k", original);

        original.items.push(4);

        const cached = await cache.get<typeof original>("k");
        expect(cached).toEqual({ items: [1, 2, 3] });
        expect(cached).not.toBe(original);
    });

    it("should report delete results and update exists() accordingly", async () => {
        await cache.set("k", "v");

        expect(await cache.exists("k")).toBe(true);
        expect(await cache.delete("k")).toBe(true);
        expect(await cache.delete("k")).toBe(false);
        expect(await cache.exists("k")).toBe(false);
    });
});
```

### Cache: TTL, expire(), and defaultTTL

TTL is real time — use short TTLs and generous margins (the package's `ttl-behavior.test.ts` uses 1–3 second TTLs with +200 ms margins and runs against both backends):

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { MemoryCacheProvider } from "blendsdk/webafx-cache";
import { delay } from "./helpers/cache-test-helpers.js";

describe("TTL behavior", () => {
    let cache: MemoryCacheProvider;

    afterEach(async () => {
        await cache.shutdown();
    });

    it("should expire a value after its TTL elapses", async () => {
        cache = new MemoryCacheProvider({ rootKey: "TtlA", cleanupIntervalMs: 0 });
        await cache.set("key", "value", 1);

        expect(await cache.get<string>("key")).toBe("value");

        await delay(1200);
        expect(await cache.get("key")).toBeUndefined();
    });

    it("should extend a short TTL with expire()", async () => {
        cache = new MemoryCacheProvider({ rootKey: "TtlB", cleanupIntervalMs: 0 });
        await cache.set("key", "value", 1);
        expect(await cache.expire("key", 3)).toBe(true);

        // Outlive the original 1-second TTL
        await delay(1200);
        expect(await cache.get<string>("key")).toBe("value");
    });

    it("should shorten a long TTL with expire()", async () => {
        cache = new MemoryCacheProvider({ rootKey: "TtlC", cleanupIntervalMs: 0 });
        await cache.set("key", "value", 10);
        expect(await cache.expire("key", 1)).toBe(true);

        await delay(1200);
        expect(await cache.get("key")).toBeUndefined();
    });

    it("should apply defaultTTL when no explicit TTL is given", async () => {
        cache = new MemoryCacheProvider({ rootKey: "TtlD", defaultTTL: 2, cleanupIntervalMs: 0 });
        await cache.set("key", "value");

        const ttl = await cache.ttl("key");
        expect(ttl).toBeGreaterThanOrEqual(1);
        expect(ttl).toBeLessThanOrEqual(2);
    });

    it("should treat an explicit TTL of 0 as no expiry, overriding defaultTTL", async () => {
        cache = new MemoryCacheProvider({ rootKey: "TtlE", defaultTTL: 1, cleanupIntervalMs: 0 });
        await cache.set("key", "value", 0);

        await delay(1500);
        expect(await cache.get<string>("key")).toBe("value");
        expect(await cache.ttl("key")).toBe(-1);
    });

    it("should follow Redis ttl() conventions", async () => {
        cache = new MemoryCacheProvider({ rootKey: "TtlF", cleanupIntervalMs: 0 });

        await cache.set("forever", "value");
        expect(await cache.ttl("forever")).toBe(-1); // exists, no expiry
        expect(await cache.ttl("missing")).toBe(-2); // does not exist
    });
});
```

### Cache: Pattern Deletion, clear(), and Namespace Isolation

Anchor both wildcard matching and the namespace guarantee — `clear()` must never touch another provider's keys:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

describe("pattern deletion and namespace isolation", () => {
    const providers: MemoryCacheProvider[] = [];

    afterEach(async () => {
        for (const provider of providers) {
            await provider.shutdown();
        }
        providers.length = 0;
    });

    function createCache(rootKey: string): MemoryCacheProvider {
        const cache = new MemoryCacheProvider({ rootKey, cleanupIntervalMs: 0 });
        providers.push(cache);
        return cache;
    }

    it("should delete only wildcard-matching keys and report the count", async () => {
        const cache = createCache("Patterns");

        await cache.set("user:1", "a");
        await cache.set("user:2", "b");
        await cache.set("product:1", "x");

        expect(await cache.deletePattern("user:*")).toBe(2);
        expect(await cache.exists("user:1")).toBe(false);
        expect(await cache.exists("product:1")).toBe(true);
    });

    it("should support a wildcard in the middle of the pattern", async () => {
        const cache = createCache("MidWildcard");

        await cache.set("api:users:active", "a");
        await cache.set("api:products:active", "b");
        await cache.set("api:users:inactive", "c");

        expect(await cache.deletePattern("api:*:active")).toBe(2);
        expect(await cache.exists("api:users:inactive")).toBe(true);
    });

    it("should keep clear() scoped to its own rootKey", async () => {
        const appA = createCache("AppA");
        const appB = createCache("AppB");

        await appA.set("shared-key", "from-A");
        await appB.set("shared-key", "from-B");

        await appA.clear();

        expect(await appA.get("shared-key")).toBeUndefined();
        expect(await appB.get<string>("shared-key")).toBe("from-B");
    });
});
```

### Cache: getOrSet (Cache-Aside)

The canonical pattern: assert the factory runs exactly once on a miss, is skipped on a hit, and the cached value respects its TTL.

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { MemoryCacheProvider } from "blendsdk/webafx-cache";
import { delay } from "./helpers/cache-test-helpers.js";

describe("getOrSet (cache-aside)", () => {
    let cache: MemoryCacheProvider;

    afterEach(async () => {
        await cache.shutdown();
    });

    it("should invoke the factory once on a miss and serve from cache afterwards", async () => {
        cache = new MemoryCacheProvider({ rootKey: "GetOrSet", cleanupIntervalMs: 0 });

        let factoryCalls = 0;
        const factory = async (): Promise<{ id: number }> => {
            factoryCalls++;
            return { id: 123 };
        };

        const first = await cache.getOrSet("user:123", factory);
        const second = await cache.getOrSet("user:123", factory);

        expect(factoryCalls).toBe(1);
        expect(second).toEqual(first);
    });

    it("should honour the TTL passed to getOrSet", async () => {
        cache = new MemoryCacheProvider({ rootKey: "GetOrSetTtl", cleanupIntervalMs: 0 });

        await cache.getOrSet("temp", async () => "value", 1);
        expect(await cache.get<string>("temp")).toBe("value");

        await delay(1200);
        expect(await cache.get("temp")).toBeUndefined();
    });
});
```

### Pub/Sub: Delivery, Fan-Out, and Receiver Counts

Memory delivery is effectively same-tick, so `waitForMessage()` works without settling; mock-call assertions still yield a tick (`delay(10)`) as the package's tests do. `publish()` resolves to the number of handlers that received the message.

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";
import { waitForMessage, collectMessages, delay } from "./helpers/cache-test-helpers.js";

describe("pub/sub delivery and fan-out", () => {
    const providers: MemoryPubSubProvider[] = [];

    afterEach(async () => {
        for (const provider of providers) {
            await provider.shutdown();
        }
        providers.length = 0;
    });

    function createPubSub(channelPrefix: string): MemoryPubSubProvider {
        const pubsub = new MemoryPubSubProvider({ channelPrefix });
        providers.push(pubsub);
        return pubsub;
    }

    it("should deliver a typed message to an exact-channel subscriber", async () => {
        const pubsub = createPubSub("Delivery");
        const { promise, handler } = waitForMessage<{ id: number; total: number }>();

        await pubsub.subscribe("order:new", handler);
        await pubsub.publish("order:new", { id: 1, total: 49.99 });

        const message = await promise;
        expect(message.channel).toBe("order:new");
        expect(message.data.total).toBe(49.99);
    });

    it("should fan out to every handler and report the receiver count", async () => {
        const pubsub = createPubSub("FanOut");

        await pubsub.subscribe("events", vi.fn());
        await pubsub.subscribe("events", vi.fn());
        await pubsub.subscribe("events", vi.fn());

        expect(await pubsub.publish("events", "broadcast")).toBe(3);
    });

    it("should return 0 when nobody is subscribed", async () => {
        const pubsub = createPubSub("Nobody");
        expect(await pubsub.publish("void", "data")).toBe(0);
    });

    it("should stop delivery after unsubscribe", async () => {
        const pubsub = createPubSub("Unsub");
        const handler = vi.fn();

        await pubsub.subscribe("ch", handler);
        await pubsub.unsubscribe("ch");
        await pubsub.publish("ch", "data");
        await delay(10);

        expect(handler).not.toHaveBeenCalled();
    });

    it("should collect a sequence of pattern messages in order", async () => {
        const pubsub = createPubSub("Collect");
        const { promise, handler } = collectMessages(2);

        await pubsub.psubscribe("order:*", handler);
        await pubsub.publish("order:created", { id: 1 });
        await pubsub.publish("order:updated", { id: 2 });

        const messages = await promise;
        expect(messages.map((m) => m.channel)).toEqual(["order:created", "order:updated"]);
    });
});
```

### Pub/Sub: Patterns, Prefix Transparency, and Envelopes

Three guarantees to test: glob matching (`*` and `?` on the memory backend), the `pattern` field appearing only on pattern-matched messages, and channel prefixes being invisible to subscribers.

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";
import type { PubSubMessage } from "blendsdk/webafx-cache";
import { waitForMessage, delay } from "./helpers/cache-test-helpers.js";

describe("pub/sub patterns and prefixes", () => {
    const providers: MemoryPubSubProvider[] = [];

    afterEach(async () => {
        for (const provider of providers) {
            await provider.shutdown();
        }
        providers.length = 0;
    });

    it("should match the * wildcard to any sequence", async () => {
        const pubsub = new MemoryPubSubProvider({ channelPrefix: "Star" });
        providers.push(pubsub);

        const star = waitForMessage();
        await pubsub.psubscribe("order:*", star.handler);

        await pubsub.publish("order:created", { id: 1 });

        expect((await star.promise).channel).toBe("order:created");
    });

    it("should match the ? wildcard to exactly one character", async () => {
        const pubsub = new MemoryPubSubProvider({ channelPrefix: "Question" });
        providers.push(pubsub);

        const received: PubSubMessage[] = [];
        await pubsub.psubscribe("slot:?", (message) => {
            received.push(message);
        });

        await pubsub.publish("slot:a", "matches");
        await pubsub.publish("slot:b", "matches");
        await pubsub.publish("slot:ab", "does-not-match");
        await delay(10);

        expect(received).toHaveLength(2);
    });

    it("should set the pattern field only on pattern-matched messages", async () => {
        const pubsub = new MemoryPubSubProvider({ channelPrefix: "Envelope" });
        providers.push(pubsub);

        const exact = waitForMessage();
        const pattern = waitForMessage();

        await pubsub.subscribe("audit:login", exact.handler);
        await pubsub.psubscribe("audit:*", pattern.handler);
        await pubsub.publish("audit:login", { userId: 1 });

        expect((await exact.promise).pattern).toBeUndefined();
        expect((await pattern.promise).pattern).toBe("audit:*");
        expect((await pattern.promise).channel).toBe("audit:login");
    });

    it("should keep channel prefixes invisible to subscribers", async () => {
        const pubsub = new MemoryPubSubProvider({ channelPrefix: "MyApp" });
        providers.push(pubsub);

        const { promise, handler } = waitForMessage();

        await pubsub.subscribe("events", handler);
        await pubsub.publish("events", "payload");

        expect((await promise).channel).toBe("events");
        // activeSubscriptions() is synchronous — no await
        expect(pubsub.activeSubscriptions().channels).toEqual(["events"]);
    });
});
```

### Pub/Sub: Handler Error Isolation

Handlers are invoked through `safeInvoke()`: errors are caught and logged to `console.error`, and one failing handler never blocks the others. Spy on `console.error` to keep test output clean and assert the isolation:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";
import type { MessageHandler } from "blendsdk/webafx-cache";
import { delay } from "./helpers/cache-test-helpers.js";

describe("handler error isolation", () => {
    let pubsub: MemoryPubSubProvider;

    afterEach(async () => {
        await pubsub.shutdown();
    });

    it("should keep delivering to healthy handlers when one handler throws", async () => {
        pubsub = new MemoryPubSubProvider({ channelPrefix: "Errors" });
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const goodHandler = vi.fn();

        const badHandler: MessageHandler = () => {
            throw new Error("handler boom");
        };

        await pubsub.subscribe("events", badHandler);
        await pubsub.subscribe("events", goodHandler);

        await pubsub.publish("events", { id: 1 });
        await delay(10);

        expect(goodHandler).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
    });
});
```

The package's suites run the same test with an **async throwing** handler (`async () => { throw ... }`) and a longer yield (`delay(50)`) to let the rejected promise surface — replicate both variants if your handlers are async.

### Plugins: Factories, Priorities, and Declarative Subscriptions

Plugin tests are pure metadata and wiring checks — no Docker. Assert the plugin `name` (from `provider.serviceName`), the default priority of `30` (and that an explicit `0` is preserved), custom priorities, the `factory` shape, and the returned `health`/`shutdown` hooks.

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import {
    createCache,
    createCachePlugin,
    memoryCachePlugin,
    redisCachePlugin,
    MemoryCacheProvider,
    RedisCacheProvider,
} from "blendsdk/webafx-cache";
import type { CacheProvider } from "blendsdk/webafx-cache";

describe("cache plugin factories", () => {
    const providers: CacheProvider[] = [];

    afterEach(async () => {
        vi.restoreAllMocks();
        for (const provider of providers) {
            try {
                await provider.shutdown();
            } catch {
                // Redis connections may already be closed — ignore.
            }
        }
        providers.length = 0;
    });

    it("should expose serviceName, priority, and factory on the plugin definition", () => {
        const provider = new MemoryCacheProvider({
            rootKey: "PluginMeta",
            serviceName: "my-cache",
            cleanupIntervalMs: 0,
        });
        providers.push(provider);

        const plugin = createCachePlugin(provider, { priority: 10 });

        expect(plugin.name).toBe("my-cache");
        expect(plugin.priority).toBe(10);
        expect(typeof plugin.factory).toBe("function");
    });

    it("should default the priority to 30 (an explicit 0 stays 0)", () => {
        const provider = new MemoryCacheProvider({ rootKey: "PluginPriority", cleanupIntervalMs: 0 });
        providers.push(provider);

        expect(createCachePlugin(provider).priority).toBe(30);
        expect(createCachePlugin(provider, { priority: 0 }).priority).toBe(0);
    });

    it("should build a memory plugin in one line", () => {
        const plugin = memoryCachePlugin({ rootKey: "OneLiner" });

        expect(plugin.name).toBe("cache");
        expect(plugin.priority).toBe(30);
    });

    it("should expose metadata for the redis one-liner without connecting", () => {
        // Creates a background connection attempt — maxRetriesPerRequest: 0
        // keeps it from retrying, exactly as the package's own tests do.
        const plugin = redisCachePlugin({
            rootKey: "RedisOneLiner",
            host: "localhost",
            port: 6399,
            maxRetriesPerRequest: 0,
        });

        expect(plugin.name).toBe("cache");
    });

    it("should discriminate createCache() by its type field", () => {
        const memory = createCache({ type: "memory", rootKey: "Factory" });
        providers.push(memory);
        expect(memory).toBeInstanceOf(MemoryCacheProvider);

        const redis = createCache({
            type: "redis",
            rootKey: "Factory",
            host: "localhost",
            port: 6399,
            maxRetriesPerRequest: 0,
        });
        providers.push(redis);
        expect(redis).toBeInstanceOf(RedisCacheProvider);
    });

    it("should throw a descriptive error for unsupported types", () => {
        // The cast deliberately violates the discriminated union to
        // exercise the runtime guard.
        expect(() => createCache({ type: "postgres" as "redis", rootKey: "Factory" })).toThrow(
            'Unknown cache type: "postgres"'
        );
    });
});
```

For pub/sub, the plugin adds one behavior over the cache plugin: **declarative subscriptions** registered when the factory runs. Invoke the factory with the mocked context and then publish through the provider to prove the wiring:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import {
    createPubSub,
    createPubSubPlugin,
    MemoryPubSubProvider,
    RedisPubSubProvider,
} from "blendsdk/webafx-cache";
import type { PubSubProvider } from "blendsdk/webafx-cache";
import { delay } from "./helpers/cache-test-helpers.js";

describe("pub/sub plugin factories", () => {
    const providers: PubSubProvider[] = [];

    afterEach(async () => {
        for (const provider of providers) {
            try {
                await provider.shutdown();
            } catch {
                // Redis connections may already be closed — ignore.
            }
        }
        providers.length = 0;
    });

    it("should register declarative channel and pattern subscriptions when the factory runs", async () => {
        const provider = new MemoryPubSubProvider({ channelPrefix: "Declarative" });
        providers.push(provider);

        const onOrder = vi.fn();
        const onAudit = vi.fn();

        const plugin = createPubSubPlugin(provider, {
            subscriptions: [
                { channel: "order:new", handler: onOrder },
                { pattern: "audit:*", handler: onAudit },
            ],
        });

        await plugin.factory({
            app: { registerService: vi.fn() },
            express: {},
            logger: { info: vi.fn().mockResolvedValue(undefined) },
        } as never);

        await provider.publish("order:new", { id: 1 });
        await provider.publish("audit:login", { userId: 1 });
        await delay(10);

        expect(onOrder).toHaveBeenCalledTimes(1);
        expect(onAudit).toHaveBeenCalledTimes(1);
        expect(provider.activeSubscriptions().channels).toContain("order:new");
        expect(provider.activeSubscriptions().patterns).toContain("audit:*");
    });

    it("should discriminate createPubSub() by its type field", () => {
        const memory = createPubSub({ type: "memory" });
        providers.push(memory);
        expect(memory).toBeInstanceOf(MemoryPubSubProvider);

        const redis = createPubSub({
            type: "redis",
            host: "localhost",
            port: 6399,
            maxRetriesPerRequest: 0,
        });
        providers.push(redis);
        expect(redis).toBeInstanceOf(RedisPubSubProvider);
    });

    it("should throw a descriptive error for unsupported types", () => {
        expect(() => createPubSub({ type: "kafka" as "redis" })).toThrow(
            'Unknown pub/sub type: "kafka"'
        );
    });
});
```

### Lifecycle: health() and shutdown()

`health()` is `true` while operational (`false` for a Redis provider after its connection closes); `shutdown()` clears stores, stops cleanup timers, and removes all subscriptions:

```typescript
import { describe, it, expect } from "vitest";
import { MemoryCacheProvider, MemoryPubSubProvider } from "blendsdk/webafx-cache";

describe("lifecycle", () => {
    it("should report healthy and clear subscriptions on shutdown", async () => {
        const pubsub = new MemoryPubSubProvider({ channelPrefix: "Lifecycle" });
        await pubsub.subscribe("ch", () => undefined);
        await pubsub.psubscribe("pat:*", () => undefined);

        expect(await pubsub.health()).toBe(true);

        await pubsub.shutdown();

        expect(pubsub.activeSubscriptions()).toEqual({ channels: [], patterns: [] });
    });

    it("should clear the memory store on shutdown", async () => {
        const cache = new MemoryCacheProvider({ rootKey: "Lifecycle", cleanupIntervalMs: 0 });
        await cache.set("k", "v");

        await cache.shutdown();

        expect(await cache.get("k")).toBeUndefined();
        expect(await cache.health()).toBe(true);
    });
});
```

The Redis-specific counterpart — health fails once the connection is closed — looks like this:

```typescript
it("should fail the health check after the Redis connection is closed", async () => {
    if (!redisAvailable) return;

    const cache = new RedisCacheProvider({ ...REDIS_TEST_CONFIG, rootKey: `Lifecycle_${Date.now()}` });
    expect(await cache.health()).toBe(true);

    await cache.shutdown();

    expect(await cache.health()).toBe(false);
});
```

*The snippet above is a `typescript fragment` — it assumes the `redisAvailable` probe and `REDIS_TEST_CONFIG` from the integration setup, and that this provider is not shut down again in `afterEach`.*

### Cross-Backend Contract Testing

The package's most important testing pattern: **one shared suite, run against every backend**, proving behavioral equivalence. `tests/abstract-contract.test.ts` does this for caches, `tests/pubsub-contract.test.ts` for messaging, and `tests/ttl-behavior.test.ts` for timing semantics. If you implement a custom `CacheProvider` or `PubSubProvider` (e.g., wrapping another store), mirror this pattern to prove conformance.

```typescript
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { MemoryCacheProvider, RedisCacheProvider } from "blendsdk/webafx-cache";
import type { CacheProvider } from "blendsdk/webafx-cache";
import { REDIS_TEST_CONFIG, delay, isRedisAvailable } from "./helpers/cache-test-helpers.js";

let redisAvailable = false;

beforeAll(async () => {
    redisAvailable = await isRedisAvailable();
});

/**
 * Shared contract suite — runs against every CacheProvider implementation.
 * If both backends pass, consumers can swap them without behavior changes.
 */
function runCacheContractTests(
    name: string,
    createProvider: () => CacheProvider,
    cleanupProvider: (provider: CacheProvider) => Promise<void>,
    shouldSkip?: () => boolean
): void {
    describe(`CacheProvider contract: ${name}`, () => {
        let provider: CacheProvider;

        beforeEach(() => {
            if (shouldSkip?.()) return;
            provider = createProvider();
        });

        afterEach(async () => {
            if (shouldSkip?.()) return;
            await cleanupProvider(provider);
        });

        it("should round-trip values and treat missing keys as undefined", async () => {
            if (shouldSkip?.()) return;

            await provider.set("user:1", { name: "Alice", scores: [10, 20] });
            expect(await provider.get("user:1")).toEqual({ name: "Alice", scores: [10, 20] });
            expect(await provider.get("missing")).toBeUndefined();
        });

        it("should follow Redis ttl() conventions", async () => {
            if (shouldSkip?.()) return;

            await provider.set("forever", "value");
            expect(await provider.ttl("forever")).toBe(-1);
            expect(await provider.ttl("missing")).toBe(-2);
        });

        it("should expire a value after its TTL", async () => {
            if (shouldSkip?.()) return;

            await provider.set("temp", "value", 1);
            await delay(1200);

            expect(await provider.get("temp")).toBeUndefined();
            expect(await provider.ttl("temp")).toBe(-2);
        });

        it("should delete wildcard matches and leave other keys alone", async () => {
            if (shouldSkip?.()) return;

            await provider.set("user:1", "a");
            await provider.set("user:2", "b");
            await provider.set("product:1", "x");

            expect(await provider.deletePattern("user:*")).toBe(2);
            expect(await provider.exists("product:1")).toBe(true);
        });

        it("should cache the getOrSet factory result", async () => {
            if (shouldSkip?.()) return;

            let calls = 0;
            const factory = async (): Promise<string> => {
                calls++;
                return "produced";
            };

            await provider.getOrSet("k", factory);
            await provider.getOrSet("k", factory);

            expect(calls).toBe(1);
        });
    });
}

let memoryCounter = 0;
let redisCounter = 0;

// --- MemoryCacheProvider: always runs, unique rootKey per test ---
runCacheContractTests(
    "MemoryCacheProvider",
    () =>
        new MemoryCacheProvider({
            rootKey: `Contract_Mem_${++memoryCounter}`,
            cleanupIntervalMs: 0,
        }),
    async (provider) => {
        await provider.shutdown();
    }
);

// --- RedisCacheProvider: runs only when Docker Redis is available ---
runCacheContractTests(
    "RedisCacheProvider",
    () =>
        new RedisCacheProvider({
            ...REDIS_TEST_CONFIG,
            rootKey: `Contract_Redis_${++redisCounter}_${Date.now()}`,
        }),
    async (provider) => {
        await provider.clear();
        await provider.shutdown();
    },
    () => !redisAvailable
);
```

Key properties of this pattern:

- **Fresh provider per test** via the `createProvider` factory — no state leaks between tests, and the memory version increments a `rootKey` counter for extra isolation.
- **Backend-specific cleanup** via `cleanupProvider` — memory just shuts down; Redis also clears its namespace.
- **Guard-based skipping** via `shouldSkip` — checked in `beforeEach`, `afterEach`, and every test body, because availability is only known after `beforeAll`.
- **Identical assertions for both backends** — the entire point: if Redis and memory both pass, calling code can switch backends without test changes.

---

# webafx-cache Troubleshooting

This guide covers the errors you are most likely to hit with `blendsdk/webafx-cache`, how to diagnose them, and the subtle behaviors — namespacing, TTL semantics, JSON serialization, pub/sub delivery — behind most "it works locally but not in production" reports. All fixes assume the ESM-only, Node.js >= 22 environment and import exclusively from the package root.

---

## Common Errors

### Module Loading and Project Setup

#### `error TS1479: The current file is a CommonJS module whose imports will produce 'require' calls; however, the referenced file is an ECMAScript module and cannot be imported with 'require'.`

> `error TS1479: The current file is a CommonJS module whose imports will produce 'require' calls; however, the referenced file is an ECMAScript module and cannot be imported with 'require'. Consider writing a dynamic 'import("...")' call instead.`
>
> Depending on your Node.js version and configuration, the runtime equivalent is `Error [ERR_REQUIRE_ESM]: require() of ES Module .../blendsdk/webafx-cache/dist/index.js ... not supported.`

**Cause:** The package is ESM-only — its `exports` map exposes only an `import` condition (`"types"` + `"import"`, no `"require"`). A CommonJS module cannot `require()` it.

**Fix:** Make your project an ES module so TypeScript emits `import` statements, or load the package with a dynamic `import()` if you must stay CommonJS.

1. Set `"type": "module"` in your `package.json` and compile with `module: nodenext`:

```json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2022"
  }
}
```

```typescript
// Works as-is in an ESM project ("type": "module")
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

await cache.set("key1", "value");
console.log(await cache.get<string>("key1"));

await cache.shutdown();
```

2. If the project cannot be converted to ESM, use a real dynamic import:

```typescript fragment
// Inside an async CommonJS function
const { MemoryCacheProvider } = await import("blendsdk/webafx-cache");
```

#### `error TS2307: Cannot find module 'blendsdk/webafx-cache' or its corresponding type declarations.`

**Cause:** Your `tsconfig.json` uses a legacy resolution mode (`"moduleResolution": "node"` or `"node10"`) that does not read the `exports` map. The package has no top-level `types` field — types are only declared through `exports["."].types`.

**Fix:** Use a resolution mode that understands `exports`:

```json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext"
  }
}
```

`"moduleResolution": "bundler"` works as well for bundler-based projects. After changing the setting, the import resolves:

```typescript fragment
import { RedisCacheProvider } from "blendsdk/webafx-cache";
```

#### `Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './dist/index.js' is not defined by "exports"`

**Cause:** The `exports` map only defines the package root (`"."`). Any deep import — `blendsdk/webafx-cache/dist/index.js`, `blendsdk/webafx-cache/src/types.js`, etc. — is rejected for both Node.js and TypeScript.

**Fix:** Import every symbol from the package root. All public API (providers, plugin factories, types, constants) is re-exported there:

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";

const cache = new RedisCacheProvider({
    rootKey: "MyApp",
    host: "localhost",
    port: 6379,
});

console.log(cache.serviceName); // "cache"

await cache.shutdown();
```

#### `error TS2307: Cannot find module 'blendsdk/webafx' or its corresponding type declarations.`

**Cause:** `blendsdk/webafx` is an **optional peer dependency**. Only the plugin factory modules reference its `PluginDefinition` type. If you import `createCachePlugin`, `redisCachePlugin`, `memoryCachePlugin`, `createPubSubPlugin`, `redisPubSubPlugin`, or `memoryPubSubPlugin` without the peer installed, TypeScript cannot resolve that type.

**Fix:** Either install the peer, or use the providers standalone (which never touches WebAFX):

```bash
npm install blendsdk/webafx@^5.x
```

```typescript
// Standalone usage — no WebAFX required
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

await cache.set("key", "value");
console.log(await cache.get<string>("key"));

await cache.shutdown();
```

### Provider Construction and Factory Errors

#### `Error: CacheProvider: rootKey is required and cannot be empty`

**Cause:** Every cache provider constructor validates `rootKey` and throws synchronously when it is missing, an empty string, or whitespace-only (`"   "`). A `rootKey` is mandatory because it provides namespace isolation in shared backends.

**Fix:** Always supply a non-empty `rootKey`. When reading it from configuration, validate before constructing:

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

const rootKey = process.env.CACHE_ROOT_KEY?.trim();

if (!rootKey) {
    throw new Error("CACHE_ROOT_KEY environment variable is not set");
}

const cache = new MemoryCacheProvider({ rootKey, defaultTTL: 300 });

await cache.set("user:123", { name: "Alice" });
console.log(await cache.get<{ name: string }>("user:123"));

await cache.shutdown();
```

#### `Error: Unknown cache type: "postgres". Supported types: "redis", "memory".`

**Cause:** `createCache()` received a `type` value outside the `"redis" | "memory"` union. This is typically triggered by an unvalidated environment variable combined with a type assertion such as `process.env.CACHE_BACKEND as "redis"` — the cast silences the compiler but the runtime check still fires.

**Fix:** Validate the string against the union instead of casting. Type the helper's return value as `CacheFactoryConfig["type"]` so TypeScript keeps you honest:

```typescript
import { createCache } from "blendsdk/webafx-cache";
import type { CacheFactoryConfig } from "blendsdk/webafx-cache";

function parseCacheType(value: string | undefined): CacheFactoryConfig["type"] {
    if (value === "redis" || value === "memory") {
        return value;
    }
    return "memory";
}

const cache = createCache({
    type: parseCacheType(process.env.CACHE_BACKEND),
    rootKey: "MyApp",
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT ?? 6379),
});

console.log(cache.constructor.name);

await cache.shutdown();
```

#### `Error: Unknown pub/sub type: "kafka". Supported types: "redis", "memory".`

**Cause:** Same as above, but from `createPubSub()`. The type discriminator was not (or could not be) validated.

**Fix:** Validate against `PubSubFactoryConfig["type"]`:

```typescript
import { createPubSub } from "blendsdk/webafx-cache";
import type { PubSubFactoryConfig } from "blendsdk/webafx-cache";

function parsePubSubType(value: string | undefined): PubSubFactoryConfig["type"] {
    return value === "redis" ? "redis" : "memory";
}

const pubsub = createPubSub({
    type: parsePubSubType(process.env.PUBSUB_BACKEND),
    channelPrefix: "MyApp",
});

console.log(pubsub.serviceName); // "pubsub"

await pubsub.shutdown();
```

#### `error TS2511: Cannot create an instance of an abstract class 'CacheProvider'.`

**Cause:** `CacheProvider` (and `PubSubProvider`) are abstract base classes. They define the contract and shared logic but cannot be instantiated directly.

**Fix:** Instantiate a concrete provider (`MemoryCacheProvider`, `RedisCacheProvider`, `MemoryPubSubProvider`, `RedisPubSubProvider`) or use the factory functions. The abstract class is still useful as a type annotation:

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";
import type { CacheProvider } from "blendsdk/webafx-cache";

function createAppCache(): CacheProvider {
    return new MemoryCacheProvider({ rootKey: "MyApp", defaultTTL: 60 });
}

const cache = createAppCache();

await cache.set("key", "value");
console.log(await cache.get<string>("key"));

await cache.shutdown();
```

### Redis Connection Problems

#### `MaxRetriesPerRequestError: Reached the max retries per request limit (which is 3). Refer to "maxRetriesPerRequest" option for details.`

**Cause:** Redis is not reachable (not running, wrong host/port, or blocked). The provider constructor never throws and never blocks — the ioredis client starts connecting in the background. While disconnected, commands queue; once the retry limit is exhausted, queued commands reject with this error. On the network level you typically see `Error: connect ECONNREFUSED 127.0.0.1:6379` in ioredis error events first.

**Fix:** Check connectivity with `health()` before issuing commands, start Redis, or fall back to the memory backend in development. Lowering `maxRetriesPerRequest` makes failures surface faster (the package's own tests use `1`):

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";

const cache = new RedisCacheProvider({
    rootKey: "MyApp",
    host: "localhost",
    port: 6379,
    connectTimeout: 5000,
    maxRetriesPerRequest: 3,
});

const healthy = await cache.health();

if (!healthy) {
    console.error("Redis is not reachable — start the server or check host, port, and credentials.");
    process.exitCode = 1;
} else {
    await cache.set("probe", { ok: true }, 30);
    console.log("Round-trip OK:", (await cache.get<{ ok: boolean }>("probe"))?.ok === true);
}

await cache.shutdown();
```

#### `Error: connect ECONNREFUSED 127.0.0.1:6379` — connections target the wrong host, port, or database

**Symptom:** The provider connects to an unexpected instance, or fails against `localhost:6379` although Redis runs elsewhere (for example the package's test Redis listens on port `6399`, not the default `6379`).

**Cause:** `host` defaults to `"localhost"`, `port` to `6379`, and `db` to `0` when omitted. Additionally, when a `url` is provided, it takes precedence over `host`/`port`/`password`/`db` — mixing `url` with individual fields can silently connect somewhere else than intended.

**Fix:** Pick one configuration style and pass it explicitly:

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";

// Option A — explicit host/port
const byHost = new RedisCacheProvider({
    rootKey: "MyApp",
    host: "redis.internal",
    port: 6399,
});

// Option B — connection URL, takes precedence over host/port/password/db
const byUrl = new RedisCacheProvider({
    rootKey: "MyApp",
    url: "redis://:secret@redis.internal:6399/1",
});

console.log(await byHost.health());
console.log(await byUrl.health());

await byHost.shutdown();
await byUrl.shutdown();
```

### Serialization Errors

#### `TypeError: Do not know how to serialize a BigInt`

**Cause:** Both `set()` and `publish()` serialize values with `JSON.stringify()`. JSON has no `BigInt` representation, so the promise rejects before anything reaches the backend.

**Fix:** Store big integers as strings (or numbers when precision allows) and convert back on read:

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

interface AccountSnapshot {
    id: string;
    balance: string; // BigInt stored as string — JSON has no BigInt
}

const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

const balance = 9007199254740993n;
const snapshot: AccountSnapshot = { id: "acc-1", balance: balance.toString() };

await cache.set("account:acc-1", snapshot);

const cached = await cache.get<AccountSnapshot>("account:acc-1");
if (cached) {
    console.log("balance:", BigInt(cached.balance));
}

await cache.shutdown();
```

#### `TypeError: Converting circular structure to JSON`

**Cause:** The value (or published message) contains a cyclic object graph — commonly ORM entities with bidirectional relations (`user.posts[i].author === user`). `JSON.stringify()` throws, and `set()`/`publish()` rejects.

**Fix:** Serialize a plain DTO instead of the graph. Cut the back-references and keep only IDs:

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

interface EmployeeDto {
    id: string;
    name: string;
    managerId?: string;
}

class Employee {
    readonly directReports: Employee[] = [];

    constructor(
        readonly id: string,
        readonly name: string,
        readonly manager?: Employee
    ) {}

    toDto(): EmployeeDto {
        return { id: this.id, name: this.name, managerId: this.manager?.id };
    }
}

const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

const boss = new Employee("1", "Boss");
const report = new Employee("2", "Report", boss);
boss.directReports.push(report);

// Serializing `boss` directly would be circular (boss <-> report); the DTO is flat
await cache.set("employee:1", boss.toDto());
console.log(await cache.get<EmployeeDto>("employee:1"));

await cache.shutdown();
```

### Pub/Sub Delivery Problems

#### `[PubSub] Handler error on channel "order:new": <message>`

**Symptom:** `console.error` output appears, but `publish()` resolves normally and no error propagates to the publisher. Other handlers on the same channel still run.

**Cause:** This is by design. `safeInvoke()` wraps every handler invocation in a try/catch and logs the error so one failing subscriber can never break other subscribers or the subscriber connection. The failure is *isolated*, not silent-by-accident — but it never rejects anything you can await.

**Fix:** Treat handlers as untrusted boundaries: validate the payload before using it, and keep risky work inside the handler's own try/catch so you can log with more context (order id, tenant, etc.) than the generic `[PubSub]` line provides:

```typescript
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";
import type { PubSubMessage } from "blendsdk/webafx-cache";

interface OrderEvent {
    orderId: string;
    total: number;
}

function isOrderEvent(value: unknown): value is OrderEvent {
    return (
        typeof value === "object" &&
        value !== null &&
        "orderId" in value &&
        "total" in value &&
        typeof value.orderId === "string" &&
        typeof value.total === "number"
    );
}

const pubsub = new MemoryPubSubProvider({ channelPrefix: "MyApp" });

await pubsub.subscribe<OrderEvent>("order:new", (message: PubSubMessage<OrderEvent>) => {
    if (!isOrderEvent(message.data)) {
        console.error("Discarding malformed order event:", message.data);
        return;
    }
    console.log(`Order ${message.data.orderId} totaling ${message.data.total}`);
});

await pubsub.publish("order:new", { orderId: "o-1", total: 49.99 });

await pubsub.shutdown();
```

#### `[PubSub] Failed to parse message on "order:new"` / `[PubSub] Failed to parse message on "audit:login" (pattern: "audit:*")`

**Symptom:** Messages are visible in Redis (`MONITOR`, `PSUBSCRIBE`) but handlers never run; the subscriber logs a parse failure and drops the message.

**Cause:** The payload on the channel is not valid JSON. This happens when something other than this SDK publishes to the channel — for example a raw `redis-cli PUBLISH 'MyApp:order:new' hello` sends the bare word `hello`, which `JSON.parse()` rejects. Remember that strings must be *JSON-encoded*, including the surrounding quotes.

**Fix:** Ensure every producer serializes through the SDK, or emits valid JSON from the CLI (`'"all systems nominal"'` for a string):

```typescript
import { RedisPubSubProvider } from "blendsdk/webafx-cache";
import type { PubSubMessage } from "blendsdk/webafx-cache";

const pubsub = new RedisPubSubProvider({
    host: "localhost",
    port: 6379,
    channelPrefix: "MyApp",
});

await pubsub.subscribe<string>("status:line", (message: PubSubMessage<string>) => {
    console.log("status:", message.data);
});

// Correct: the SDK JSON-encodes the payload
await pubsub.publish("status:line", "all systems nominal");

// Equivalent raw redis-cli command — note the inner JSON quotes:
// redis-cli -p 6379 PUBLISH 'MyApp:status:line' '"all systems nominal"'

await pubsub.shutdown();
```

#### Messages are published but no handler ever runs

**Symptom:** `publish()` returns `0`, or messages flow on Redis but a specific subscriber stays silent.

**Cause:** One of four things, in order of likelihood:

1. **Channel prefix mismatch** — publisher and subscriber use different `channelPrefix` values (or one has none), so they operate on different Redis channels (`MyApp:order:new` vs `order:new`).
2. **Different process / different backend** — `MemoryPubSubProvider` only delivers *within its own process*; cross-process delivery requires the Redis backend (and both sides must use the same Redis instance).
3. **Race at startup** — messages published before the subscription is established are lost (pub/sub is fire-and-forget; nothing is retained).
4. **Shut down** — the subscriber provider was already `shutdown()`, which clears all handlers.

**Fix:** Make prefixes symmetric, verify with `activeSubscriptions()`, let the subscription settle before publishing, and check `health()`:

```typescript
import { RedisPubSubProvider } from "blendsdk/webafx-cache";
import type { PubSubMessage } from "blendsdk/webafx-cache";

interface OrderEvent {
    orderId: string;
}

const subscriber = new RedisPubSubProvider({
    host: "localhost",
    port: 6379,
    channelPrefix: "MyApp", // MUST match the publisher
});

const publisher = new RedisPubSubProvider({
    host: "localhost",
    port: 6379,
    channelPrefix: "MyApp",
});

await subscriber.subscribe<OrderEvent>("order:new", (message: PubSubMessage<OrderEvent>) => {
    console.log("received on", message.channel, message.data.orderId);
});

// Verify locally what the subscriber believes it is subscribed to
console.log(subscriber.activeSubscriptions()); // { channels: ['order:new'], patterns: [] }

// Give the subscription a moment to be confirmed on the wire before publishing
await new Promise<void>((resolve) => setTimeout(resolve, 100));

const receivers = await publisher.publish<OrderEvent>("order:new", { orderId: "o-1" });
console.log(`delivered to ${receivers} subscription(s)`);

await publisher.shutdown();
await subscriber.shutdown();
```

### TypeScript Usage Errors

#### `error TS2571: Object is of type 'unknown'.`

**Cause:** The generic type argument was omitted on a read path. `get<T>()` has no default type parameter — with no inference source, `T` falls back to `unknown`, and consuming the value fails. `subscribe<T>()` and `psubscribe<T>()` default to `unknown` for the same reason.

**Fix:** Pass the payload type explicitly at every call site:

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

interface User {
    id: string;
    name: string;
}

const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

await cache.set<User>("user:123", { id: "123", name: "Alice" });

// Without <User>, `user` would be `unknown` and `user?.name` would not compile
const user = await cache.get<User>("user:123");
console.log(user?.name);

await cache.shutdown();
```

#### `error TS2345: ... Property 'rootKey' is missing in type ... but required in type 'CacheFactoryConfig'.`

**Cause:** The factory config is a strictly typed discriminated union — `type` must be exactly `"redis" | "memory"` and `rootKey` is required. Hand-built config literals frequently miss `rootKey` or contain an invalid `type` literal (which only becomes a runtime error through a cast — see the `Unknown cache type` entry above).

**Fix:** Declare the config object with the exported type so the compiler validates it up front:

```typescript
import { createCache } from "blendsdk/webafx-cache";
import type { CacheFactoryConfig } from "blendsdk/webafx-cache";

const config: CacheFactoryConfig = {
    type: "memory",
    rootKey: "MyApp",
    defaultTTL: 300,
};

const cache = createCache(config);

console.log(cache.serviceName);

await cache.shutdown();
```

### WebAFX Plugin Integration

#### Two plugins register under the same service name

**Symptom:** You register two caches (for example a session cache and a product cache) — or a cache and a pub/sub provider — and resolving the service by name becomes ambiguous or one provider shadows the other. Both cache plugins default to the service name `cache`; both pub/sub plugins default to `pubsub`.

**Cause:** The plugin name is taken from `provider.serviceName`. With defaults, multiple providers in one application are indistinguishable to the service container.

**Fix:** Give each provider a unique `serviceName`. The plugin (`createCachePlugin(provider).name`) and the service registration both use that name:

```typescript
import { MemoryCacheProvider, createCachePlugin } from "blendsdk/webafx-cache";

const sessionCache = new MemoryCacheProvider({
    rootKey: "Sessions",
    serviceName: "session-cache",
});

const productCache = new MemoryCacheProvider({
    rootKey: "Products",
    serviceName: "product-cache",
});

const sessionPlugin = createCachePlugin(sessionCache);
const productPlugin = createCachePlugin(productCache);

console.log(sessionPlugin.name); // "session-cache"
console.log(productPlugin.name); // "product-cache"
```

The same rule applies to `createPubSubPlugin()`, `redisPubSubPlugin()`, and `memoryPubSubPlugin()`.

---

## Debugging Strategies

### 1. Verify which provider is actually running

Before debugging behavior, confirm the backend. Environment-based factories are the most common source of "it worked in dev" surprises:

```typescript
import { createCache } from "blendsdk/webafx-cache";

const cache = createCache({
    type: process.env.NODE_ENV === "production" ? "redis" : "memory",
    rootKey: "MyApp",
});

console.log(`${cache.constructor.name} (service "${cache.serviceName}")`);

await cache.shutdown();
```

### 2. Check `health()` before anything else

If `health()` is `false`, no cache-logic debugging is meaningful — fix connectivity first. The Redis check sends `PING`; the memory check always returns `true`:

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";

const cache = new RedisCacheProvider({ rootKey: "MyApp", host: "localhost", port: 6379 });

const healthy = await cache.health();

console.log(healthy ? "backend reachable" : "backend unreachable — fix connectivity, not cache logic");

await cache.shutdown();
```

### 3. Inspect the active subscriptions

`activeSubscriptions()` returns the user-facing names (prefix stripped). If a channel/pattern is missing here, the subscription was never registered — or was removed by `unsubscribe()`/`shutdown()`:

```typescript fragment
console.log(subscriber.activeSubscriptions());
// { channels: ['order:new', 'order:paid'], patterns: ['audit:*'] }
```

### 4. Reproduce with the memory backend to isolate the layer

Run the same probe against both backends. If the bug reproduces on `MemoryCacheProvider`, it is usage or logic; if it only reproduces on Redis, suspect connectivity, namespaces, or shared state:

```typescript
import { MemoryCacheProvider, RedisCacheProvider } from "blendsdk/webafx-cache";
import type { CacheProvider } from "blendsdk/webafx-cache";

async function probe(provider: CacheProvider): Promise<void> {
    await provider.set("debug:probe", { ok: true }, 30);
    console.log(provider.constructor.name, "→", await provider.get<{ ok: boolean }>("debug:probe"));
    console.log(provider.constructor.name, "→ ttl:", await provider.ttl("debug:probe"));
}

const memory = new MemoryCacheProvider({ rootKey: "MyApp", cleanupIntervalMs: 0 });
const redis = new RedisCacheProvider({ rootKey: "MyApp", host: "localhost", port: 6379 });

await probe(memory);
await probe(redis);

await memory.shutdown();
await redis.shutdown();
```

### 5. Inspect raw Redis data

Keys are stored as `rootKey + ":" + key`, and values are JSON — so strings appear quoted. Use `--scan` (the package itself never uses `KEYS`; don't start now):

```bash
# List every key in the namespace
redis-cli -p 6379 --scan --pattern 'MyApp:*'

# Inspect one entry (JSON-encoded value)
redis-cli -p 6379 GET 'MyApp:user:123'

# Check expiry: positive = seconds left, -1 = no expiry, -2 = missing
redis-cli -p 6379 TTL 'MyApp:user:123'
```

### 6. Watch live pub/sub traffic

Subscribe to the prefixed channel family from a separate terminal to see exactly what the SDK is sending and receiving:

```bash
# Watch everything this namespace receives (pattern subscription)
redis-cli -p 6379 PSUBSCRIBE 'MyApp:*'

# In another terminal, publish a JSON payload the SDK can parse
redis-cli -p 6379 PUBLISH 'MyApp:order:new' '{"orderId":"o-1","total":49.99}'
```

For a full command stream, `redis-cli -p 6379 MONITOR` shows every `SET`, `SCAN`, `SUBSCRIBE`, and `PUBLISH` the providers issue.

### 7. Probe TTL behavior directly

TTL bugs are almost always unit confusion or default fallthrough. Probe with a known TTL:

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

const cache = new MemoryCacheProvider({ rootKey: "TTLDebug", defaultTTL: 0, cleanupIntervalMs: 0 });

await cache.set("probe", "value", 10);

console.log("exists:", await cache.exists("probe")); // true
console.log("ttl:", await cache.ttl("probe"));       // ~10 (seconds)
console.log("value:", await cache.get<string>("probe"));

await cache.shutdown();
```

### 8. Surface ioredis connection errors

The ioredis client is `protected`, not public — subclass the provider to attach an error listener. This turns otherwise-invisible background connection errors into log lines:

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";
import type { RedisCacheConfig } from "blendsdk/webafx-cache";

class VerboseRedisCacheProvider extends RedisCacheProvider {
    constructor(config: RedisCacheConfig) {
        super(config);
        this.client.on("error", (error: Error) => {
            console.error(`[redis-cache] ${error.message}`);
        });
    }
}

const cache = new VerboseRedisCacheProvider({
    rootKey: "MyApp",
    host: "localhost",
    port: 6379,
    maxRetriesPerRequest: 1,
});

console.log(await cache.health());
await cache.shutdown();
```

### 9. Ensure every provider is shut down

A Node.js process or test run that "hangs" after completion is almost always holding open Redis connections. Each Redis provider holds one connection; each `RedisPubSubProvider` holds two (publisher + subscriber). Always call `shutdown()` in a `finally` block:

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";

async function main(): Promise<void> {
    const cache = new RedisCacheProvider({ rootKey: "MyApp", host: "localhost", port: 6379 });

    try {
        await cache.set("key", "value");
        console.log(await cache.get<string>("key"));
    } finally {
        await cache.shutdown();
    }
}

await main();
```

The in-memory cache's cleanup timer is `.unref()`'d, so it never keeps the process alive — if the process hangs, look for Redis clients, not for the memory provider.

### 10. Run the package's own test suite against Docker

When you work inside the BlendSDK repository, the fastest way to separate "my code" from "the SDK" is the package's own suites:

```bash
yarn test:fast   # unit + contract tests against memory backends — no Docker needed
yarn test        # starts Docker Redis on port 6399, runs everything, tears Docker down
yarn docker:logs # tail the Redis test container logs while debugging
```

Redis-backed tests skip themselves when nothing listens on port 6399 — the integration suite prints `⚠️  Redis not available on port 6399 — skipping Redis integration tests`. If you see that warning, your Docker container is not up and the "passing" run proved nothing about Redis.

---

## Known Pitfalls

1. **TTLs are in seconds, not milliseconds.** Every `ttlSeconds` parameter (`set()`, `expire()`, `defaultTTL`, `getOrSet()`) is seconds:

    ```typescript fragment
    await cache.set("user:123", user, 300);      // 5 minutes — correct
    await cache.set("user:123", user, 300_000);  // 300,000 seconds ≈ 3.5 days — a millisecond value passed by mistake
    ```

2. **Any TTL <= 0 means "no expiry".** `resolveTTL()` uses the value only when it is `> 0`. An explicit `0` therefore *overrides* a non-zero `defaultTTL` and stores the key forever:

    ```typescript fragment
    // With defaultTTL: 300 configured, this still stores with NO expiry
    await cache.set("config:flags", flags, 0);
    ```

3. **`ttl()` sentinel values trip up existence checks.** `if (remaining)` is truthy for `-1` and `-2`:

    | Return | Meaning | Suggested handling |
    |--------|---------|--------------------|
    | positive number | seconds remaining | expiry is active |
    | `-1` | key exists, no expiry | optionally call `expire()` |
    | `-2` | key does not exist | treat as a cache miss |

    Use `exists()` for existence questions and compare `remaining > 0` explicitly.

4. **The memory backend is per-process *and* per-instance.** Two `MemoryCacheProvider` instances share nothing — even with identical `rootKey` — and nothing is shared across worker threads, cluster workers, or pods. If a value must be visible in more than one place, use the Redis backend:

    ```typescript fragment
    const cacheA = new MemoryCacheProvider({ rootKey: "MyApp" });
    const cacheB = new MemoryCacheProvider({ rootKey: "MyApp" });

    await cacheA.set("key1", "value");
    await cacheB.get<string>("key1"); // undefined — separate stores
    ```

5. **Pub/sub is fire-and-forget.** There is no persistence, no acknowledgement, and no replay. Messages published while a subscriber is disconnected (or not yet subscribed) are lost. The memory provider delivers only within its own process. Do not use pub/sub as a work queue for events that must not be lost.

6. **Pattern syntax is not identical across backends.** Only `*` behaves the same everywhere:

    | Wildcard | Memory `deletePattern` | Redis `deletePattern` | Memory `psubscribe` | Redis `psubscribe` |
    |----------|------------------------|-----------------------|---------------------|--------------------|
    | `*` (any sequence) | Supported | Supported | Supported | Supported |
    | `?` (single character) | Literal character | Supported | Supported | Supported |
    | `[...]` (character class) | Literal characters | Supported | Literal characters | Supported |

    If you might swap backends, restrict cache patterns to `*` and pub/sub patterns to `*` and `?`.

7. **Overlapping `rootKey` namespaces delete each other's keys on shared Redis.** `clear()` and `deletePattern()` match with wildcards, so `rootKey: "App"` (`SCAN MATCH App:*`) also matches keys owned by `rootKey: "App:Sub"`. Never make one `rootKey` a prefix of another on the same Redis instance:

    ```typescript fragment
    new RedisCacheProvider({ rootKey: "App" });     // clear() deletes "App:*" — including the next one
    new RedisCacheProvider({ rootKey: "App:Sub" }); // its keys also match "App:*"
    ```

8. **`publish()` counts have different meanings per backend.** Memory counts *local handlers* (exact plus matching pattern handlers); Redis counts *Redis clients that received the message* (all processes, including pattern subscriptions). Never assert on the count for "did my handler run":

    ```typescript fragment
    const localReceivers = await memoryPubsub.publish("order:new", event); // local handlers only
    const redisReceivers = await redisPubsub.publish("order:new", event);  // all Redis clients, across processes
    ```

9. **Handler failures are isolated and only logged.** A throwing handler produces a `[PubSub] Handler error on channel "..."` line on `console.error` and nothing else — `publish()` resolves, no promise rejects, no retry occurs. If nobody watches the console, failures are invisible; add your own logging inside critical handlers.

10. **`getOrSet()` has no stampede protection.** Two concurrent callers that both miss will both run the factory before either stores a value:

    ```typescript fragment
    // Both calls miss before either caches — the factory runs twice
    const [first, second] = await Promise.all([
        cache.getOrSet("report:2024", () => buildExpensiveReport()),
        cache.getOrSet("report:2024", () => buildExpensiveReport()),
    ]);
    ```

11. **Never cache `undefined`.** `undefined` is the cache-miss sentinel used by `getOrSet()`, and `JSON.stringify(undefined)` produces no payload at all — the memory backend stores an entry that can never be read back, and the Redis `SET` cannot send a valid payload. Return a sentinel, return `null` (which *is* a valid cached value), or throw:

    ```typescript
    import { MemoryCacheProvider } from "blendsdk/webafx-cache";

    interface UserResult {
        found: boolean;
        name: string;
    }

    const cache = new MemoryCacheProvider({ rootKey: "MyApp", defaultTTL: 300 });

    const result = await cache.getOrSet<UserResult>("user:404", async () => ({
        found: false,
        name: "",
    }));

    console.log(`found: ${result.found} — the negative result is cached too`);

    await cache.shutdown();
    ```

12. **`unsubscribe()` is all-or-nothing per channel.** `unsubscribe(channel)` and `punsubscribe(pattern)` remove **every** handler for that channel/pattern — there is no per-handler removal API. If independent consumers share a channel, model them as separate channels or guard inside the handler.

13. **`shutdown()` is not idempotent on Redis.** Calling it twice can reject because the ioredis connections are already closed. The WebAFX plugins already wire `shutdown()` into the application lifecycle, so call it exactly once yourself. Also note the post-shutdown asymmetry: `health()` returns `false` after `shutdown()` on Redis, but always `true` on the memory provider (there are no connections to check).

14. **JSON round-trips change types.** `Date` becomes an ISO string, `Map`/`Set` become `{}`, `undefined` object properties are dropped, `NaN`/`Infinity` become `null`, class instances lose their prototype methods, and integers beyond `2^53 - 1` lose precision (store large IDs as strings):

    ```typescript fragment
    await cache.set("session:1", { expiresAt: new Date(), tags: new Set(["a"]) });
    const cached = await cache.get<{ expiresAt: string; tags: object }>("session:1");
    // cached.expiresAt is an ISO string; cached.tags is {} — hydrate on read
    ```

15. **Keys without a TTL live forever — including orphaned ones.** If nothing sets `defaultTTL` and no per-call TTL is passed, entries persist until deleted. Changing a `rootKey` (for example versioning a namespace) leaves the old keys in Redis indefinitely; clean them up with `clear()` or `deletePattern("*")` before decommissioning a namespace.

16. **One-liner plugins connect immediately.** `redisCachePlugin(config)` and `redisPubSubPlugin(config)` construct the provider — and therefore open ioredis connections (two, for pub/sub) — at call time, not when the plugin factory runs during app startup:

    ```typescript fragment
    const plugin = redisCachePlugin({ rootKey: "MyApp", host: "localhost" });
    // The connection to localhost:6379 is already opening here — not at app startup
    ```

    Avoid creating these at module import time in tests unless you shut the providers down afterward.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
