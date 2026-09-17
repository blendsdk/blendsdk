> **Package**: `blendsdk/webafx-cache`

# webafx-cache Advanced Patterns

---

This document goes beyond the basics of `CacheProvider` and `PubSubProvider`: every pattern below combines multiple features of `blendsdk/webafx-cache` — both abstraction hierarchies, the exported abstract base classes, the constants, and the plugin factories — into a design you can lift directly into a production codebase.

**Conventions used in this document:**

- Reusable logic is presented as a **module block** (save it under the shown file name, e.g. `two-tier-cache-provider.ts`) followed by a **usage block** that imports it through its ESM path (`./two-tier-cache-provider.js`).
- All blocks are ESM, strict-mode TypeScript with full imports. Redis-backed examples assume a Redis instance on `localhost:6379`; demos that run on the in-memory backends need no infrastructure at all.
- WebAFX bootstrap lines (`app.use(...)`) appear as clearly marked `typescript fragment` blocks — everything else is complete, runnable code.

## Pattern Index

| # | Pattern | Combines | Problem it solves |
|---|---------|----------|-------------------|
| 1 | Two-tier caching (Memory L1 + Redis L2) | `CacheProvider` (extended), `MemoryCacheProvider`, `RedisCacheProvider`, `createCachePlugin()` | Redis round-trips on every hot read; total failure when Redis blips |
| 2 | Cross-instance cache invalidation | `CacheProvider` + `PubSubProvider` + plugin factories | Per-instance caches serving stale data after updates |
| 3 | Single-flight cache-aside | `getOrSet()` semantics + in-process coordination | Concurrent misses hammering the source of truth |
| 4 | Stale-while-revalidate | Payload versioning + TTL tiers + background refresh | Refresh latency spikes at TTL boundaries |
| 5 | Idempotent event consumption | `PubSubProvider` + cache markers | Duplicate deliveries executing business logic twice |
| 6 | Type-safe event catalog | Generics + `PubSubMessage<T>` + declarative `subscriptions` | Stringly-typed channels and payload drift |
| 7 | Rolling cache namespaces | `rootKey` + `clear()` + provider lifecycle | Schema changes and rollbacks colliding on shared Redis keys |

---

## Pattern 1 — Two-Tier Caching: Memory L1 in Front of Redis L2

Hot keys hit Redis on every read, which costs a network round-trip (fractions of a millisecond on-box, several milliseconds across availability zones) and adds load to the shared Redis instance. Worse, when Redis is briefly unreachable, every read *and* write starts to fail even though the process could still serve a perfectly good in-process copy of the data.

This pattern layers a `MemoryCacheProvider` (L1) in front of a `RedisCacheProvider` (L2) behind a single custom `CacheProvider` subclass. Reads come from L1 when hot and are backfilled from L2 on a miss; writes go to both tiers. When the Redis tier is unreachable, operations degrade to L1 with a logged warning instead of throwing.

**Before → after.** Every read of a hot key pays a Redis round-trip and fails during a Redis blip → only the first read per key per L1-TTL window touches Redis, and Redis outages degrade latency instead of availability.

**When to use it.**

- The same keys are read many times per second per process (configuration, feature flags, catalog snapshots).
- Read availability matters more than absolute freshness: a Redis outage should not take pages down.
- Your staleness budget is at least `l1TTLSeconds` — if it is shorter, invalidate actively with Pattern 2.

**The building block.** Save this file as `two-tier-cache-provider.ts`:

```typescript
import { CacheProvider, MemoryCacheProvider, RedisCacheProvider } from "blendsdk/webafx-cache";
import type { RedisCacheConfig } from "blendsdk/webafx-cache";

/** Redis connection settings plus L1 tuning. */
export interface TwoTierCacheConfig extends RedisCacheConfig {
    /** How long L1 entries may live, in seconds. Keep it short to bound staleness. Default: 30. */
    l1TTLSeconds?: number;
    /** L1 cleanup interval in milliseconds. Default: 60000. */
    l1CleanupIntervalMs?: number;
}

/**
 * CacheProvider that places an in-process MemoryCacheProvider (L1) in front of
 * a RedisCacheProvider (L2). Reads are served from L1 when hot, backfilled from
 * L2 on a miss, and keep working (from L1) when Redis is unreachable.
 */
export class TwoTierCacheProvider extends CacheProvider {
    private readonly l1: MemoryCacheProvider;
    private readonly l2: RedisCacheProvider;
    private readonly l1TTLSeconds: number;

    constructor(config: TwoTierCacheConfig) {
        super(config);
        this.l1TTLSeconds = config.l1TTLSeconds ?? 30;
        this.l1 = new MemoryCacheProvider({
            rootKey: config.rootKey,
            cleanupIntervalMs: config.l1CleanupIntervalMs ?? 60_000,
        });
        this.l2 = new RedisCacheProvider(config);
    }

    async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
        // L1 always uses the short L1 TTL; L2 keeps the caller's TTL (or its defaultTTL).
        await this.l1.set(key, value, this.l1TTLSeconds);
        await this.attemptVoid(async () => {
            await this.l2.set(key, value, ttlSeconds);
        });
    }

    async get<T>(key: string): Promise<T | undefined> {
        const local = await this.l1.get<T>(key);
        if (local !== undefined) {
            return local;
        }

        const remote = await this.attemptValue(() => this.l2.get<T>(key), undefined);
        if (remote !== undefined) {
            // Backfill L1 so the next read of this key stays in-process.
            await this.l1.set(key, remote, this.l1TTLSeconds);
        }
        return remote;
    }

    async delete(key: string): Promise<boolean> {
        const localDeleted = await this.l1.delete(key);
        const remoteDeleted = await this.attemptValue(() => this.l2.delete(key), false);
        return localDeleted || remoteDeleted;
    }

    async exists(key: string): Promise<boolean> {
        if (await this.l1.exists(key)) {
            return true;
        }
        return await this.attemptValue(() => this.l2.exists(key), false);
    }

    async expire(key: string, ttlSeconds: number): Promise<boolean> {
        const localExtended = await this.l1.expire(key, Math.min(ttlSeconds, this.l1TTLSeconds));
        const remoteExtended = await this.attemptValue(
            () => this.l2.expire(key, ttlSeconds),
            false
        );
        return localExtended || remoteExtended;
    }

    async ttl(key: string): Promise<number> {
        try {
            // L2 is authoritative for TTLs.
            return await this.l2.ttl(key);
        } catch (error) {
            this.reportDegraded(error);
            return await this.l1.ttl(key);
        }
    }

    async deletePattern(pattern: string): Promise<number> {
        const localDeleted = await this.l1.deletePattern(pattern);
        try {
            // Report the namespace-wide L2 count when Redis is reachable.
            return await this.l2.deletePattern(pattern);
        } catch (error) {
            this.reportDegraded(error);
            return localDeleted;
        }
    }

    async clear(): Promise<void> {
        await this.l1.clear();
        await this.attemptVoid(async () => {
            await this.l2.clear();
        });
    }

    async health(): Promise<boolean> {
        // Deliberately strict: false when the Redis tier is down, so operators are
        // alerted even though requests keep succeeding from L1.
        return (await this.l1.health()) && (await this.l2.health());
    }

    async shutdown(): Promise<void> {
        await Promise.all([this.l1.shutdown(), this.l2.shutdown()]);
    }

    /** Run a Redis read, falling back to `fallback` when the Redis tier is unreachable. */
    private async attemptValue<V>(operation: () => Promise<V>, fallback: V): Promise<V> {
        try {
            return await operation();
        } catch (error) {
            this.reportDegraded(error);
            return fallback;
        }
    }

    /** Run a Redis write that has no return value. */
    private async attemptVoid(operation: () => Promise<void>): Promise<void> {
        try {
            await operation();
        } catch (error) {
            this.reportDegraded(error);
        }
    }

    /** Log a degraded-tier event — never rethrow. */
    private reportDegraded(error: unknown): void {
        console.error(
            "[TwoTierCache] Redis tier unavailable — continuing with L1:",
            error instanceof Error ? error.message : error
        );
    }
}
```

**Using it.** Save this file as `shop-warm.ts` next to the module:

```typescript
import { TwoTierCacheProvider } from "./two-tier-cache-provider.js";

interface Product {
    sku: string;
    price: number;
}

async function main(): Promise<void> {
    const cache = new TwoTierCacheProvider({
        rootKey: "Shop",
        host: "localhost",
        port: 6379,
        defaultTTL: 300,  // L2 keeps values for 5 minutes
        l1TTLSeconds: 15, // L1 serves repeats for up to 15 seconds
    });

    await cache.set("product:42", { sku: "A-42", price: 19.99 });

    const first = await cache.get<Product>("product:42");  // L1 hit
    const second = await cache.get<Product>("product:42"); // L1 hit — no Redis round-trip

    console.log(first?.price);  // 19.99
    console.log(second?.sku);   // "A-42"

    await cache.shutdown();
}

await main();
```

Registration in a WebAFX application is identical to the built-in providers, because the composite still *is* a `CacheProvider`:

```typescript fragment
// import { createCachePlugin } from "blendsdk/webafx-cache";
const cache = new TwoTierCacheProvider({ rootKey: "Shop", host: "localhost" });
app.use(createCachePlugin(cache)); // health() covers both tiers, shutdown() closes both
```

**Why this pattern is valuable.** The second read of `product:42` never leaves the process — latency drops from *network + Redis* to a `Map` lookup, and the shared Redis instance only sees one read per key per L1 window. Restarts repopulate L1 lazily: the first read per key pays one Redis round-trip (and backfills L1), then stays in-process for the L1 TTL. During a Redis incident, reads keep succeeding from L1 and writes land in L1, so the application stays up. Because `TwoTierCacheProvider` extends the exported base class, the inherited `getOrSet()` automatically operates on both tiers, and `createCachePlugin()` wires `/health` and graceful shutdown for the whole composite.

**Caveats and performance considerations.**

- **L1 is per-instance.** Another instance's update is invisible here until the L1 TTL expires — pair this pattern with Pattern 2 for near-instant convergence, or keep `l1TTLSeconds` ≤ your staleness budget.
- **The memory backend has no size cap.** Every distinct key gets an L1 copy for its TTL, so avoid routing unbounded-cardinality keys (per-user sessions, per-request keys) through L1 — either exclude them via a predicate in `get()`/`set()` or run a separate Redis-only provider for those namespaces.
- **Degraded writes are local-only.** While Redis is down, `set()` lands in L1 only; other instances will not see it, and `delete()` can return `false` for keys that exist solely in the unreachable L2. This is an availability-over-consistency trade-off — make it consciously.
- **`deletePattern()`/`clear()` report L2 counts** (namespace-wide) and always invalidate L1 too; when Redis is down they fall back to the L1 count.
- **`health()` is deliberately strict** (false when Redis is down). If your platform aggressively removes "unhealthy" instances, relax it to report L1 health only and monitor Redis separately.

---

## Pattern 2 — Cross-Instance Cache Invalidation over Pub/Sub

TTLs bound staleness but never eliminate it: with twelve instances each memoizing "the active pricing rules", a 60-second TTL means an admin edit can take a full minute to appear. The pub/sub hierarchy is a natural invalidation bus: after the authoritative write commits, the writer broadcasts the affected keys, and every subscribed instance — including the writer — drops its copies.

**Before → after.** Updates converge only after the TTL elapses per instance → staleness collapses to one message round-trip, letting you raise TTLs safely (fewer rebuilds, less load).

**When to use it.**

- Multiple instances keep local state that must reflect updates much sooner than any acceptable TTL (feature flags, pricing, tenant configuration).
- You pair it with Pattern 1: the same handler drops L1 and L2 copies via the composite's `delete()`.
- You already run Redis for caching or messaging — no extra infrastructure.

**The building block.** Save this file as `cache-invalidation.ts`:

```typescript
import type { CacheProvider, PubSubProvider } from "blendsdk/webafx-cache";

/** Payload broadcast on the invalidation channel. Provide `keys`, `pattern`, or both. */
export interface CacheInvalidation {
    /** Exact logical cache keys to drop (e.g., "product:42"). */
    keys?: string[];
    /** Glob pattern of logical keys to drop (e.g., "product:list:*"). */
    pattern?: string;
}

/** Channel name used for cache invalidation broadcasts. */
export const CACHE_INVALIDATION_CHANNEL = "cache:invalidate";

/**
 * Publish an invalidation so every instance drops its copies.
 * Call this AFTER the authoritative write (database) has committed.
 */
export async function broadcastInvalidation(
    pubsub: PubSubProvider,
    event: CacheInvalidation
): Promise<number> {
    return await pubsub.publish(CACHE_INVALIDATION_CHANNEL, event);
}

/**
 * Subscribe to invalidation broadcasts and drop matching entries from the
 * shared cache. `evictLocal` runs first — that is where you clear per-instance
 * state (plain Maps, computed values) that lives outside the cache provider.
 */
export async function listenForInvalidations(
    pubsub: PubSubProvider,
    cache: CacheProvider,
    evictLocal: (event: CacheInvalidation) => void | Promise<void>
): Promise<void> {
    await pubsub.subscribe<CacheInvalidation>(CACHE_INVALIDATION_CHANNEL, async (message) => {
        const event = message.data;
        await evictLocal(event);

        if (event.keys) {
            for (const key of event.keys) {
                await cache.delete(key);
            }
        }

        if (event.pattern) {
            await cache.deletePattern(event.pattern);
        }
    });
}
```

**Using it.** Save this file as `shop-pricing.ts`. The demo uses the in-memory backends so it runs without infrastructure; in production, swap in `RedisPubSubProvider` and `RedisCacheProvider` with the same wiring — that is the entire change:

```typescript
import { MemoryCacheProvider, MemoryPubSubProvider } from "blendsdk/webafx-cache";
import { broadcastInvalidation, listenForInvalidations } from "./cache-invalidation.js";

interface Product {
    id: string;
    name: string;
    price: number;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
    // Production equivalent: new RedisPubSubProvider({ channelPrefix: "Shop", host, port })
    const pubsub = new MemoryPubSubProvider({ channelPrefix: "Shop" });
    const cache = new MemoryCacheProvider({ rootKey: "Shop", defaultTTL: 300 });

    // Per-instance memo — the state that TTLs alone leave stale for too long.
    const memo = new Map<string, Product>();

    await listenForInvalidations(pubsub, cache, (event) => {
        if (event.keys) {
            for (const key of event.keys) {
                memo.delete(key);
            }
        }
    });

    // --- Admin update on this instance (other instances run the same wiring) ---
    const updated: Product = { id: "42", name: "Widget Pro", price: 29.99 };
    memo.set("product:42", updated);
    await cache.set("product:42", updated, 300);

    // After the authoritative write, tell every instance to drop its copies.
    await broadcastInvalidation(pubsub, {
        keys: ["product:42"],
        pattern: "product:list:*",
    });

    await delay(20); // async delivery
    console.log(memo.has("product:42")); // false — every instance dropped its copy

    await pubsub.shutdown();
    await cache.shutdown();
}

await main();
```

In a WebAFX application the two providers registered as plugins keep their lifecycle managed while the invalidation wiring stays in your bootstrap:

```typescript fragment
// assuming: cache, pubsub, and a local Map<string, Product> named localMemo are in scope
app.use(createCachePlugin(cache));   // provider lifecycle + /health
app.use(createPubSubPlugin(pubsub)); // provider lifecycle + /health

await listenForInvalidations(pubsub, cache, (event) => {
    for (const key of event.keys ?? []) {
        localMemo.delete(key);
    }
});
```

**Why this pattern is valuable.** It turns "stale until TTL" into "stale until the next message" — single-digit milliseconds on a healthy Redis — and because invalidations are *delete, not update*, you never propagate partially written data: the next read rebuilds from the source of truth. The same handler covers every tier: with Pattern 1's composite, `cache.delete(key)` drops L1 and L2 in one call. Channels are namespaced by `channelPrefix`, so several applications can share one Redis instance without cross-talk, and the publisher's own subscription receives the broadcast, keeping the writer consistent with readers.

**Caveats and performance considerations.**

- **Fire-and-forget.** An instance that is restarting misses every message sent while it was down; its stale state survives until TTL. Keep memo TTLs finite (the demo uses 300 s) and treat broadcast as speed, TTL as the safety net.
- **Broadcast strictly after the authoritative write commits** — otherwise another instance can rebuild from pre-commit data and re-cache it.
- **The writer re-rebuilds.** It receives its own invalidation and deletes the value it just cached; the next read rebuilds it. If that extra rebuild is expensive, stamp events with an instance id and skip self — for most systems one rebuild is cheaper than inconsistent state.
- **Keep invalidations selective.** `deletePattern('product:list:*')` walks the keyspace with `SCAN` on Redis; exact key lists are cheaper. Batch invalidations from bulk edits into a single message.
- **Handler errors are isolated** by the provider's `safeInvoke()` — logged, never thrown. Alert on those logs: a silently failing invalidation handler looks exactly like "no update happened".

---

## Pattern 3 — Single-Flight Cache-Aside: Coalescing Concurrent Misses

A cold key that is expensive to build and suddenly popular is the classic cache stampede: N concurrent requests all miss, all call the factory, and the source of truth receives N identical expensive queries. `getOrSet()` already caches the result — but every caller that arrives before the first `set()` completes still runs its own factory invocation.

This pattern wraps any `CacheProvider` with per-key request coalescing: the first caller to miss becomes the leader and runs the factory; all concurrent callers for the same key await the leader and read the value it stored.

**Before → after.** 100 concurrent misses on a cold key → 100 factory executions; with `SingleFlightCache` → 1.

**When to use it.**

- Factories are expensive: database queries, external API calls, aggregations.
- Traffic arrives in bursts on the same key (front page, scheduled flag flip).
- You expect cold-start bursts — deploys, or a fresh namespace from Pattern 7.

**The building block and usage.** Save this file as `single-flight-cache.ts`:

```typescript
import type { CacheProvider } from "blendsdk/webafx-cache";
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

/**
 * getOrSet with request coalescing: concurrent misses for the same key run the
 * factory exactly once; every caller receives that single result.
 */
export class SingleFlightCache {
    private readonly cache: CacheProvider;
    private readonly inFlight = new Map<string, Promise<unknown>>();

    constructor(cache: CacheProvider) {
        this.cache = cache;
    }

    async getOrSet<T>(key: string, factory: () => Promise<T>, ttlSeconds?: number): Promise<T> {
        const cached = await this.cache.get<T>(key);
        if (cached !== undefined) {
            return cached;
        }

        const leader = this.inFlight.get(key);
        if (leader !== undefined) {
            // Wait for the leader, then read the value it stored.
            // If the leader failed, this await rethrows its error to this caller too.
            await leader;
            const settled = await this.cache.get<T>(key);
            if (settled !== undefined) {
                return settled;
            }
        }

        // Become the leader. The check-and-register below runs in one synchronous
        // block (no await in between), so exactly one caller wins the race.
        const operation = this.produce(key, factory, ttlSeconds);
        this.inFlight.set(key, operation);
        try {
            return await operation;
        } finally {
            if (this.inFlight.get(key) === operation) {
                this.inFlight.delete(key);
            }
        }
    }

    private async produce<T>(key: string, factory: () => Promise<T>, ttlSeconds?: number): Promise<T> {
        const value = await factory();
        await this.cache.set(key, value, ttlSeconds);
        return value;
    }
}

// --- Demo: 100 concurrent requests, one factory execution ---

interface Report {
    generatedAt: number;
    rows: number;
}

async function main(): Promise<void> {
    const provider = new MemoryCacheProvider({ rootKey: "Reports" });
    const cache = new SingleFlightCache(provider);

    let factoryCalls = 0;
    const buildReport = async (): Promise<Report> => {
        factoryCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50)); // simulated slow query
        return { generatedAt: Date.now(), rows: 1200 };
    };

    const results = await Promise.all(
        Array.from({ length: 100 }, () => cache.getOrSet("report:2024", buildReport, 60))
    );

    console.log(factoryCalls);    // 1 — all 100 callers shared one factory execution
    console.log(results[0].rows); // 1200

    await provider.shutdown();
}

await main();
```

**Why this pattern is valuable.** The leader's single expensive result is fanned out to every concurrent caller, so the source of truth sees one query instead of a hundred. Failures are not cached and propagate to all waiting callers consistently — nobody receives a silently swallowed error. The bookkeeping is a single `Map` cleaned up in a `finally` block, and because the wrapper accepts any `CacheProvider`, it composes with the Redis, memory, and two-tier (Pattern 1) providers unchanged.

**Caveats and performance considerations.**

- **Per-process scope.** With K instances, a cold key can still trigger up to K factory calls (one leader per process). That is usually a 100× improvement; true cross-process coalescing needs distributed locking, which this package deliberately does not provide.
- **Never return `undefined` from factories.** `undefined` is indistinguishable from "not cached" throughout the API — a follower re-read would find nothing and start a new leader.
- **A hanging leader hangs its followers.** Put timeouts inside the factory or the cache client (`connectTimeout`, `maxRetriesPerRequest` are part of the Redis config).
- **You still think about TTLs.** This dedupes misses *at a moment*; it does not smooth repeated refreshes at TTL boundaries — Pattern 4 handles that.
- **Follower latency equals leader latency.** Coalescing protects the origin, not the client; it does not make the first response faster.

---

## Pattern 4 — Stale-While-Revalidate: Instant Reads with Background Refresh

Classic cache-aside has a sharp edge: the moment a popular key expires, the unlucky request at the boundary pays the full load cost. Stale-while-revalidate flips the model — readers never wait for a refresh. The cache stores a versioned payload with its store time; reads younger than a soft threshold return immediately; reads older than it return the stale value *immediately* and kick off a deduplicated background refresh that updates the entry for the next reader.

**Before → after.** Every TTL expiry forces a synchronous reload per boundary request → boundary reads return instantly while exactly one refresh runs in the background.

**When to use it.**

- Feeds, catalogs, and reports where sub-second staleness is acceptable.
- High-read, low-write endpoints where TTL boundaries otherwise cause latency spikes.
- You want reads to keep working through origin outages (until the hard TTL).

**The building block.** Save this file as `stale-while-revalidate-cache.ts`:

```typescript
import type { CacheProvider } from "blendsdk/webafx-cache";

/** Stored payload wrapper: the value plus the timestamp used to judge freshness. */
interface StaleWhileRevalidateEntry<T> {
    value: T;
    storedAt: number; // epoch milliseconds
}

/** Tuning for stale-while-revalidate reads. Keep `staleAfterSeconds` below `hardTtlSeconds`. */
export interface SwrOptions {
    /** After this many seconds the entry is gone and the next read reloads synchronously. */
    hardTtlSeconds: number;
    /** After this many seconds the entry is served as-is and refreshed in the background. */
    staleAfterSeconds: number;
    /** Optional hook for background refresh failures (logging, alerting). */
    onRefreshError?: (error: unknown) => void;
}

/**
 * Cache-aside reads that never block on a refresh: fresh entries return
 * immediately, stale entries return immediately and refresh in the background
 * (single-flight per key), hard-expired entries reload synchronously.
 */
export class StaleWhileRevalidateCache {
    private readonly cache: CacheProvider;
    private readonly refreshing = new Map<string, Promise<unknown>>();

    constructor(cache: CacheProvider) {
        this.cache = cache;
    }

    async get<T>(key: string, factory: () => Promise<T>, options: SwrOptions): Promise<T> {
        const entry = await this.cache.get<StaleWhileRevalidateEntry<T>>(key);

        if (entry === undefined) {
            // Cold miss or hard expiry — this caller pays the load cost.
            return await this.reload(key, factory, options.hardTtlSeconds);
        }

        const ageSeconds = (Date.now() - entry.storedAt) / 1000;
        if (ageSeconds > options.staleAfterSeconds) {
            this.refreshInBackground(key, factory, options);
        }

        return entry.value;
    }

    /** Synchronous reload — also the unit of work executed by background refresh. */
    private async reload<T>(key: string, factory: () => Promise<T>, hardTtlSeconds: number): Promise<T> {
        const value = await factory();
        const entry: StaleWhileRevalidateEntry<T> = { value, storedAt: Date.now() };
        await this.cache.set(key, entry, hardTtlSeconds);
        return value;
    }

    /** Fire-and-forget refresh, deduplicated per key within this process. */
    private refreshInBackground<T>(key: string, factory: () => Promise<T>, options: SwrOptions): void {
        if (this.refreshing.has(key)) {
            return; // a refresh for this key is already running
        }

        const operation = this.reload(key, factory, options.hardTtlSeconds);
        this.refreshing.set(key, operation);

        void operation
            .catch((error: unknown) => {
                options.onRefreshError?.(error);
            })
            .finally(() => {
                if (this.refreshing.get(key) === operation) {
                    this.refreshing.delete(key);
                }
            });
    }
}
```

**Using it.** Save this file as `catalog-feed.ts` next to the module:

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";
import { StaleWhileRevalidateCache } from "./stale-while-revalidate-cache.js";
import type { SwrOptions } from "./stale-while-revalidate-cache.js";

interface Catalog {
    version: number;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
    const provider = new MemoryCacheProvider({ rootKey: "Catalog" });
    const cache = new StaleWhileRevalidateCache(provider);

    let loads = 0;
    const loadCatalog = async (): Promise<Catalog> => {
        await delay(5); // simulated origin latency
        loads += 1;
        return { version: loads };
    };

    const options: SwrOptions = {
        hardTtlSeconds: 60,
        staleAfterSeconds: 0.05,
        onRefreshError: (error) => {
            console.error("background refresh failed:", error);
        },
    };

    const cold = await cache.get("catalog:all", loadCatalog, options);
    console.log(cold.version, loads); // 1 1 — synchronous load on a cold miss

    await delay(80); // entry is now older than staleAfterSeconds

    const stale = await cache.get("catalog:all", loadCatalog, options);
    console.log(stale.version, loads); // 1 1 — stale value returned instantly

    await delay(20); // let the background refresh finish

    const fresh = await cache.get("catalog:all", loadCatalog, options);
    console.log(fresh.version, loads); // 2 2 — refreshed in the background
}

await main();
```

**Why this pattern is valuable.** Read latency at TTL boundaries stays flat: instead of one unlucky request (and its parallel siblings) paying the reload cost, everyone gets an instant answer while a single background refresh — deduplicated per key — updates the entry. If the origin keeps failing, stale values are served until the hard TTL, so reads survive origin incidents. The wrapper works on top of any provider, including Pattern 1's composite, and `onRefreshError` gives you a hook for alerting without ever throwing into request paths.

**Caveats and performance considerations.**

- **Bounded staleness, by definition.** In the worst case (origin failing continuously) readers see data up to `hardTtlSeconds` old — pick the hard TTL accordingly and do not use this for data that must be strongly fresh.
- **Payloads are wrapped** as `{ value, storedAt }`; the unwrapping is invisible but slightly increases stored size, and freshness is judged with the writer's clock (minor multi-instance skew).
- **Background refreshes are flush-aware enough, not flush-aware.** Failures are caught and reported via `onRefreshError`; provide one so refresh failures are visible. Refreshes racing an ongoing shutdown simply fail into that hook.
- **Cold/hard-expired reads are still synchronous** and can stampede — route them through Pattern 3's `SingleFlightCache` when that matters.
- **`staleAfterSeconds` must be smaller than `hardTtlSeconds`** — the soft threshold only smooths *expirations*; it cannot resurrect an entry that no longer exists.

---

## Pattern 5 — Idempotent Event Consumption with a Deduplication Cache

Pub/sub is fire-and-forget, and every realistic system delivers the same logical event more than once eventually: a publisher retries after a timeout, an operator replays a batch, a producer redeploys and re-emits. For pure handlers that is harmless; for "send the confirmation email" or "charge the card" it is an incident. This pattern deduplicates deliveries with a marker in the cache, written **after** the handler succeeds.

**Before → after.** A redelivered event runs the handler again → the first delivery is processed, every redelivery is skipped as `"duplicate"`, and failed attempts remain retryable because no marker is written on error.

**When to use it.**

- Business events with side effects: notifications, billing, provisioning.
- Replay/retry pipelines where the same `eventId` may arrive twice.
- Combined with Pattern 6: the typed bus gives compile-time safety, markers give runtime safety.

**The building block.** Save this file as `idempotent-consumer.ts`:

```typescript
import type { CacheProvider, PubSubProvider } from "blendsdk/webafx-cache";

/** Every business event carries a stable, unique id used for deduplication. */
export interface IdentifiedEvent {
    eventId: string;
}

/**
 * Run `handler` only if `eventId` has not been processed before. The marker is
 * written AFTER the handler succeeds, so failed attempts stay retryable and
 * successful ones are skipped on redelivery. Returns "duplicate" when skipped.
 */
export async function processOnce(
    cache: CacheProvider,
    eventId: string,
    handler: () => Promise<void>,
    markerTtlSeconds = 86_400
): Promise<"processed" | "duplicate"> {
    const markerKey = `event:processed:${eventId}`;

    if (await cache.exists(markerKey)) {
        return "duplicate";
    }

    await handler();
    await cache.set(markerKey, { processedAt: new Date().toISOString() }, markerTtlSeconds);
    return "processed";
}

/**
 * Subscribe to a channel and process every message with `processOnce`,
 * using the event's `eventId` for deduplication.
 */
export async function subscribeOnce<T extends IdentifiedEvent>(
    pubsub: PubSubProvider,
    cache: CacheProvider,
    channel: string,
    handler: (event: T) => void | Promise<void>,
    markerTtlSeconds = 86_400
): Promise<void> {
    await pubsub.subscribe<T>(channel, async (message) => {
        const event = message.data;
        await processOnce(
            cache,
            event.eventId,
            async () => {
                await handler(event);
            },
            markerTtlSeconds
        );
    });
}
```

**Using it.** Save this file as `order-notifications.ts` next to the module:

```typescript
import { MemoryCacheProvider, MemoryPubSubProvider } from "blendsdk/webafx-cache";
import { subscribeOnce } from "./idempotent-consumer.js";

interface OrderPlaced {
    eventId: string;
    orderId: string;
    total: number;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
    const pubsub = new MemoryPubSubProvider({ channelPrefix: "Shop" });
    const cache = new MemoryCacheProvider({ rootKey: "Shop", defaultTTL: 0 });

    const sent: string[] = [];

    await subscribeOnce<OrderPlaced>(pubsub, cache, "order:placed", async (event) => {
        sent.push(event.orderId);
        console.log(`Confirmation sent for order ${event.orderId} (total ${event.total})`);
    });

    const event: OrderPlaced = { eventId: "evt-9001", orderId: "ord-17", total: 49.99 };

    await pubsub.publish("order:placed", event); // first delivery — processed
    await delay(50);
    await pubsub.publish("order:placed", event); // redelivery — skipped
    await delay(50);

    console.log(sent); // ["ord-17"] — the handler ran exactly once

    await pubsub.shutdown();
    await cache.shutdown();
}

await main();
```

**Why this pattern is valuable.** Mark-after-success gives you effectively-once processing for the duplicate that actually happens in practice — sequential redelivery — while keeping genuine failures retryable (no marker is written when the handler throws). Because markers live in the shared cache, *any* instance that receives the redelivery skips it, not just the original processor; a Redis-backed marker therefore deduplicates across the whole fleet. The TTL bounds marker memory automatically: retention is a tunable trade-off between storage and the longest plausible redelivery delay.

**Caveats and performance considerations.**

- **The check-then-act is not atomic across processes.** Two instances processing the same event simultaneously can both pass the `exists` check. Sequential duplicates — retries, replays — are fully covered; if concurrent duplicates are possible in-process, wrap the handler with Pattern 3's single-flight; for strict cross-process claims you need an atomic primitive (a unique database index or a `SET NX`-style claim), which this package's API deliberately does not expose.
- **The deduplication window is the marker TTL.** Events redelivered later than the TTL are reprocessed — choose the TTL from your pipeline's worst-case retry horizon.
- **Decide the failure mode deliberately.** If the cache is unreachable, `exists` throws, the handler never runs, and `safeInvoke()` logs the error — the delivery is dropped. If dropping is worse than double-processing for your domain, wrap the marker check in try/catch and process anyway (fail-open).
- **`eventId` must be stable and unique** across all retries and instances — generate it once at the producer, never inside the consumer.
- **Marker keys add cardinality** to the cache; the TTL plus the `event:processed:` prefix keep them isolated and self-cleaning.

---

## Pattern 6 — A Type-Safe Event Catalog and Bus Facade

Channel names as loose strings and payloads as `any`-shaped objects drift apart silently until production breaks. This pattern builds a thin, fully typed facade over any `PubSubProvider`: one central `AppEvents` map ties every channel to its payload type, so publishing to a wrong channel, sending a wrong payload, or reading a mistyped field becomes a compile-time error.

**Before → after.** `pubsub.publish("order:created", { ... })` accepts any JSON → a single catalog makes channel/payload drift impossible to compile.

**When to use it.**

- More than a handful of channels, or more than one team/module producing and consuming events.
- You want one place that documents every domain event in the system.
- You want compile-time safety while still swapping providers (memory in tests, Redis in production).

**The building block and usage.** Save this file as `typed-event-bus.ts`:

```typescript
import type { PubSubMessage, PubSubProvider } from "blendsdk/webafx-cache";

/** Central catalog: channel name → payload type. Replace with your domain events. */
export interface AppEvents {
    "order:created": { eventId: string; orderId: string; total: number };
    "order:shipped": { eventId: string; orderId: string; carrier: string };
    "user:registered": { eventId: string; userId: string; email: string };
}

/**
 * Thin typed facade over PubSubProvider. Channel names are restricted to
 * `keyof AppEvents` and payloads must match the mapped type — typos and
 * shape drift become compile-time errors instead of silent runtime bugs.
 */
export class TypedEventBus {
    private readonly pubsub: PubSubProvider;

    constructor(pubsub: PubSubProvider) {
        this.pubsub = pubsub;
    }

    async publish<K extends keyof AppEvents>(channel: K, data: AppEvents[K]): Promise<number> {
        return await this.pubsub.publish(channel, data);
    }

    async subscribe<K extends keyof AppEvents>(
        channel: K,
        handler: (message: PubSubMessage<AppEvents[K]>) => void | Promise<void>
    ): Promise<void> {
        await this.pubsub.subscribe<AppEvents[K]>(channel, handler);
    }

    async unsubscribe<K extends keyof AppEvents>(channel: K): Promise<void> {
        await this.pubsub.unsubscribe(channel);
    }
}

// --- Demo: fully typed publish and subscribe ---

import { MemoryPubSubProvider } from "blendsdk/webafx-cache";

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
    const pubsub = new MemoryPubSubProvider({ channelPrefix: "Shop" });
    const events = new TypedEventBus(pubsub);

    await events.subscribe("order:created", (message) => {
        // message.data is fully typed — orderId is string, total is number
        console.log(`Order ${message.data.orderId}: ${message.data.total}`);
    });

    await events.publish("order:created", { eventId: "e-1", orderId: "o-9", total: 49.99 });

    await delay(20);

    await pubsub.shutdown();
}

await main();
```

The compiler rejects payload drift before anything reaches the wire:

```typescript fragment
// The compiler rejects payload drift:
//   events.publish("order:created", { eventId: "e-1", orderId: "o-9", total: "49.99" });
//   → error TS2345: 'total' is `string` but AppEvents["order:created"] expects `number`
```

For startup-time registration, the plugin's declarative `subscriptions` option works alongside the bus. Its array is homogeneous (`SubscriptionDefinition[]`), so payloads arrive typed as `unknown` — validate and narrow them with a type guard, which is exactly what you want at a system boundary:

```typescript fragment
// import { createPubSubPlugin } from "blendsdk/webafx-cache";
// assuming AppEvents from typed-event-bus.ts is imported

function isOrderCreated(value: unknown): value is AppEvents["order:created"] {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    if (!("eventId" in value) || !("orderId" in value) || !("total" in value)) {
        return false;
    }
    return (
        typeof value.eventId === "string" &&
        typeof value.orderId === "string" &&
        typeof value.total === "number"
    );
}

app.use(
    createPubSubPlugin(pubsub, {
        subscriptions: [
            {
                channel: "order:created",
                handler: (message) => {
                    if (isOrderCreated(message.data)) {
                        console.log(`Handling order ${message.data.orderId}`);
                    }
                },
            },
        ],
    })
);
```

**Why this pattern is valuable.** The `AppEvents` map is simultaneously documentation and a compile-time contract: renaming a channel or a field updates every producer and consumer through one edit, and a typo like `"order:create"` simply does not type-check. The facade adds zero runtime behavior — it delegates straight to the provider — so it works over memory and Redis backends alike, and it composes with the plugin: the plugin manages the provider's lifecycle while the bus is your typed view of the same instance. Handlers registered through `bus.subscribe` stay fully typed end to end.

**Caveats and performance considerations.**

- **Types end at the process boundary.** Another service publishing `"order:created"` sends JSON, not your TypeScript type — validate at the edges (as the declarative example does) even though your own producers are checked. This is doubly important when producers and consumers deploy at different times.
- **Keep the event-map module dependency-free** (types only) to avoid import cycles between domain modules that all need the catalog.
- **Treat the catalog like an API version.** Adding entries is safe; removing or reshaping entries is a breaking change across every service that shares the map.
- **No delivery guarantees are added.** The facade sits on top of fire-and-forget semantics with isolated handler errors — pair side-effectful handlers with Pattern 5's idempotency markers.
- **One bus, many modules.** Construct one `TypedEventBus` per provider instance and pass it around (or export it) — per-module `new TypedEventBus(pubsub)` instances are harmless but easy to lose track of.

---

## Pattern 7 — Rolling Cache Namespaces for Deploy-Safe Schema Changes

Deploys change cached payload shapes: `Product` gains `displayName`, a field is renamed, a type narrows. During a rolling deploy, old and new instances share the same Redis keys — whichever version writes last decides what the other version reads, and a rollback makes it worse. This pattern versions the entire namespace: the `rootKey` carries a schema version, each deployment gets a fresh key space, and the previous namespace is reclaimed deliberately, once the rollout is stable.

**Before → after.** Mixed payload shapes collide under one prefix during (and after) a rollout → every deployment version reads and writes only its own keys, and rollback is instant while the old namespace stays warm.

**When to use it.**

- Cached payload shapes change between releases while old instances are still draining.
- You want affordable rollbacks: the previous namespace still holds valid pre-rollback data.
- You operate a shared Redis used by several deployments and want a clean cutover path.

**The building block.** Save this file as `versioned-namespace.ts`:

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";
import type { RedisCacheConfig } from "blendsdk/webafx-cache";

/** Bump on any cached-payload schema change, or inject per deployment. */
export const CACHE_SCHEMA_VERSION = process.env.CACHE_SCHEMA_VERSION ?? "1";

/** Redis connection settings without the rootKey — the version supplies it. */
export type CacheConnectionConfig = Omit<RedisCacheConfig, "rootKey">;

/** Compose the versioned root key, e.g. "Shop:v2". */
export function versionedRootKey(base: string, version: string): string {
    return `${base}:v${version}`;
}

/** Create a cache whose keys live under `<base>:v<CACHE_SCHEMA_VERSION>`. */
export function createVersionedCache(
    base: string,
    connection: CacheConnectionConfig
): RedisCacheProvider {
    return new RedisCacheProvider({
        ...connection,
        rootKey: versionedRootKey(base, CACHE_SCHEMA_VERSION),
    });
}

/**
 * Delete every key of a previous deployment's namespace. Run it from a deploy
 * job after the old deployment is fully drained — it only touches the old
 * prefix and never affects the current namespace.
 */
export async function clearNamespace(
    base: string,
    version: string,
    connection: CacheConnectionConfig
): Promise<void> {
    const previous = new RedisCacheProvider({
        ...connection,
        rootKey: versionedRootKey(base, version),
    });
    try {
        await previous.clear();
    } finally {
        await previous.shutdown();
    }
}
```

**Using it.** Save this file as `rolling-deploy.ts` next to the module (runs against a live Redis):

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";
import { clearNamespace, createVersionedCache, versionedRootKey } from "./versioned-namespace.js";

async function main(): Promise<void> {
    const connection = { host: "localhost", port: 6379, defaultTTL: 300 };

    // An instance still running the previous deployment...
    const previous = new RedisCacheProvider({
        ...connection,
        rootKey: versionedRootKey("Shop", "0"),
    });
    // ...and an instance of the new deployment.
    const current = createVersionedCache("Shop", connection);

    await previous.set("product:1", { sku: "A-1" });
    await current.set("product:1", { sku: "A-1", displayName: "Widget" });

    console.log(await current.get<{ sku: string; displayName: string }>("product:1"));
    // { sku: 'A-1', displayName: 'Widget' } — new schema, untouched by old writes
    console.log(await previous.get<{ sku: string }>("product:1"));
    // { sku: 'A-1' } — old schema, untouched by new writes

    // Once the old deployment is fully drained, reclaim its memory.
    await clearNamespace("Shop", "0", connection);

    console.log(await previous.exists("product:1")); // false — old namespace cleared
    console.log(await current.exists("product:1"));  // true — new namespace intact

    await previous.shutdown();
    await current.shutdown();
}

await main();
```

In a WebAFX application, the versioned provider registers exactly like any other cache:

```typescript fragment
// import { createCachePlugin, createVersionedCache } from ... (see module above);
const cache = createVersionedCache("Shop", { host: "redis.internal", port: 6379 });
app.use(createCachePlugin(cache)); // /health and shutdown wired as usual
```

**Why this pattern is valuable.** Deploys become boring: each schema version owns an isolated key space (`Shop:v1:product:1` is invisible to a `Shop:v2` provider), so mixed-version traffic during a rollout can never misread payloads, and older instances keep their warm cache instead of degrading. Rollbacks are instant — while the old namespace has not been cleared, the previous deployment resumes with a fully populated cache. Because only `clear()` on the *old* root key is needed for cleanup, the operation is safe to run online: it walks and deletes only that prefix (via `SCAN` on Redis) and never touches the current deployment's data.

**Caveats and performance considerations.**

- **A version bump means a cold cache.** Plan for the burst: pair rollouts with Pattern 3's coalescing, or warm hot keys at startup via `getOrSet()` before serving traffic.
- **Old namespaces consume Redis memory until cleared.** With the default `defaultTTL` of 0, keys never expire on their own — run the cleanup step deliberately after each rollout stabilizes, and consider a finite `defaultTTL` as a backstop.
- **Do not run `clearNamespace` too early.** Rolling back *after* the old namespace was cleared yields a cold start for the old deployment — sequence cleanup after you are confident in the new release.
- **Centralize the version, never hand-write it.** Operators flip one environment variable (`CACHE_SCHEMA_VERSION`); every key flows through `versionedRootKey`, so there is exactly one place to change.
- **Colons in the base are fine, ambiguity is not.** `rootKey` and keys are joined with `:` (the package's `KEY_SEPARATOR`); pick a base like `Shop` (no trailing colon) so the versioned prefix stays unambiguous.

---

## Composing the Patterns

The patterns were designed to interlock — each building block is small, typed, and accepts the package's abstract types (`CacheProvider`, `PubSubProvider`), so they stack without modification:

| Composition | What it gives you |
|-------------|-------------------|
| 1 + 2 | Fast in-process reads (L1) with near-instant cross-instance invalidation on every write |
| 3 + 7 | Coalesced cold starts after a namespace rollover — one factory call per key, not one per request |
| 4 + 3 | Reads that never wait for a refresh, plus coalesced synchronous reloads on hard expiry |
| 5 + 6 | Compile-time-safe events that are also safe to redeliver |

A capstone bootstrap that wires most of the document together:

```typescript fragment
// Assumes the module files from Patterns 1, 2, 5 and 6 are in scope, e.g.:
//   import { TwoTierCacheProvider } from "./two-tier-cache-provider.js";
//   import { listenForInvalidations } from "./cache-invalidation.js";
//   import { processOnce } from "./idempotent-consumer.js";
//   import { TypedEventBus } from "./typed-event-bus.js";

const cache = new TwoTierCacheProvider({ rootKey: "Shop", host: "redis.internal", port: 6379 });
const pubsub = new RedisPubSubProvider({ channelPrefix: "Shop", host: "redis.internal" });
const events = new TypedEventBus(pubsub);
const memo = new Map<string, unknown>();

app.use(createCachePlugin(cache));   // L1 + L2 health and shutdown
app.use(createPubSubPlugin(pubsub)); // pub/sub health and shutdown

// Pattern 2 — every instance drops stale copies on invalidation broadcasts
await listenForInvalidations(pubsub, cache, (event) => {
    for (const key of event.keys ?? []) {
        memo.delete(key);
    }
});

// Patterns 5 + 6 — typed events, processed at most once per marker window
await events.subscribe("order:created", async (message) => {
    await processOnce(cache, message.data.eventId, async () => {
        console.log(`Reserving stock for order ${message.data.orderId}`);
    });
});
```

Start with the pattern that addresses your most pressing bottleneck, keep the building block small, and let each subsequent pattern attach to the same provider instance — because every abstraction in `blendsdk/webafx-cache` converges on two pluggable types (`CacheProvider` and `PubSubProvider`), the compositions above survive backend swaps, service-name changes, and the move from memory in development to Redis in production without touching calling code.

---

# webafx-cache Common Scenarios

This document answers the most common "How do I…" questions about `blendsdk/webafx-cache`, ordered from simple to advanced. Every scenario includes a complete, runnable TypeScript example with full imports.

A few conventions used throughout: cache examples use `MemoryCacheProvider` when no infrastructure is needed and `RedisCacheProvider` when the scenario concerns a shared Redis instance (assumed at `localhost:6379`). Every provider is created with a `rootKey` (cache) or `channelPrefix` (pub/sub) for namespace isolation. WebAFX integration examples type the application minimally — any object with a `use(plugin)` method — so they remain self-contained.

---

## How do I start caching values with the in-memory provider?

**Solution** — Create a `MemoryCacheProvider` with a `rootKey` and use the async `set()` / `get()` pair. Values are JSON-serialized automatically and keys are transparently namespaced as `rootKey:key`, so the API is identical to the Redis backend. The `rootKey` is required — an empty or whitespace-only value throws `CacheProvider: rootKey is required and cannot be empty` at construction time.

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

async function main(): Promise<void> {
    const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

    // Store JSON-serializable values — keys become "MyApp:greeting" internally
    await cache.set("greeting", "hello");
    await cache.set("hits", 42);

    // Retrieve with the expected type; undefined means a cache miss
    console.log(await cache.get<string>("greeting")); // "hello"
    console.log(await cache.get<number>("hits")); // 42
    console.log(await cache.get<string>("missing")); // undefined

    // Release resources when done — clears the store and stops the cleanup timer
    await cache.shutdown();
}

await main();
```

---

## How do I cache the result of an expensive operation?

**Solution** — Use `getOrSet()`, the built-in cache-aside helper. On a miss it awaits your factory, stores the result with the given TTL (or the provider's `defaultTTL`), and returns it; on a hit the factory is never invoked. The logic lives in the `CacheProvider` base class, so it behaves identically on both backends — and if the factory throws, the error propagates without caching anything.

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

interface Stats {
    totalOrders: number;
}

/** Stand-in for an expensive aggregation query. */
async function computeStats(): Promise<Stats> {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
    });
    return { totalOrders: 1234 };
}

async function main(): Promise<void> {
    const cache = new MemoryCacheProvider({ rootKey: "MyApp", defaultTTL: 300 });
    let factoryCalls = 0;

    const loadStats = async (): Promise<Stats> => {
        factoryCalls++;
        return await computeStats();
    };

    // First call — cache miss: the factory runs and the result is cached
    const first = await cache.getOrSet<Stats>("stats:total", loadStats);
    console.log(first.totalOrders, factoryCalls); // 1234 1

    // Second call — cache hit: the factory is skipped entirely
    const second = await cache.getOrSet<Stats>("stats:total", loadStats);
    console.log(second.totalOrders, factoryCalls); // 1234 1

    // The cached entry honors defaultTTL (300 s); pass a third argument to override:
    // await cache.getOrSet("stats:total", loadStats, 60);

    await cache.shutdown();
}

await main();
```

---

## How do I store and retrieve complex objects with full type safety?

**Solution** — Define an interface and pass it to the generic `set<T>()` / `get<T>()` methods. Values cross a JSON boundary in both backends, so `get()` always returns a detached deep copy — mutating the original object after `set()` never changes the cached value, and `null` round-trips faithfully (`undefined` is reserved for misses). Store plain data, not class instances — JSON serialization does not preserve prototypes or methods.

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

interface OrderLine {
    sku: string;
    quantity: number;
}

interface Order {
    id: string;
    total: number;
    lines: OrderLine[];
    note: string | null;
}

async function main(): Promise<void> {
    const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

    const order: Order = {
        id: "ORD-1",
        total: 149.97,
        lines: [
            { sku: "SKU-A", quantity: 2 },
            { sku: "SKU-B", quantity: 1 },
        ],
        note: null,
    };

    await cache.set<Order>("order:ORD-1", order);

    // Mutating the original afterwards does not affect the cached copy
    order.lines.push({ sku: "SKU-C", quantity: 99 });

    const cached = await cache.get<Order>("order:ORD-1");
    if (cached !== undefined) {
        console.log(cached.lines.length); // 2 — the extra line was never cached
        console.log(cached.note); // null — round-trips faithfully
    }

    // Only undefined signals "not cached"
    console.log(await cache.get<Order>("order:ORD-404")); // undefined

    await cache.shutdown();
}

await main();
```

---

## How do I make cached values expire automatically?

**Solution** — Pass a TTL in seconds to `set()` / `getOrSet()`, or configure a provider-wide `defaultTTL` — an explicit TTL always wins, and `0` means no expiry (as does leaving `defaultTTL` unset). `expire()` updates the lifetime of an existing key and `ttl()` reads it with Redis conventions: positive = remaining seconds, `-1` = exists without expiry, `-2` = missing. Expired entries behave as missing everywhere; the in-memory backend also sweeps them periodically (`cleanupIntervalMs`, default 60 000 ms, `unref()`-ed timer — set `0` to disable), while Redis expires them server-side.

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

async function main(): Promise<void> {
    // defaultTTL applies whenever an operation has no explicit TTL
    const cache = new MemoryCacheProvider({ rootKey: "MyApp", defaultTTL: 300 });

    await cache.set("session:1", { userId: "u1" }); // ~300 s (default)
    await cache.set("otp:1", "123456", 30); // ~30 s (explicit override)
    await cache.set("flags", { darkMode: true }, 0); // 0 overrides defaultTTL → no expiry

    console.log(await cache.ttl("session:1")); // ~300
    console.log(await cache.ttl("otp:1")); // ~30
    console.log(await cache.ttl("flags")); // -1 — exists, no expiry
    console.log(await cache.ttl("ghost")); // -2 — does not exist

    // Extend (or shorten) the lifetime of an existing key
    console.log(await cache.expire("otp:1", 60)); // true
    console.log(await cache.ttl("otp:1")); // ~60
    console.log(await cache.expire("ghost", 60)); // false — nothing to update

    await cache.shutdown();
}

await main();
```

---

## How do I check whether a key exists or delete it?

**Solution** — `exists()` returns a boolean and `delete()` returns `true` only when a key was actually removed — deleting a missing key is a harmless no-op. Expired entries behave exactly like missing keys in both methods.

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

async function main(): Promise<void> {
    const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

    await cache.set("session:42", { userId: "42" });

    console.log(await cache.exists("session:42")); // true
    console.log(await cache.delete("session:42")); // true — key removed

    console.log(await cache.exists("session:42")); // false
    console.log(await cache.delete("session:42")); // false — nothing to remove

    // Expired entries are reported as missing
    await cache.set("token", "temporary", 1);
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 1200);
    });
    console.log(await cache.exists("token")); // false
    console.log(await cache.delete("token")); // false

    await cache.shutdown();
}

await main();
```

---

## How do I invalidate all keys that match a pattern?

**Solution** — Call `deletePattern()` with a glob pattern; `*` matches any sequence and may appear anywhere in the pattern. It returns the number of keys deleted, and the pattern is automatically prefixed with the provider's `rootKey`, so it can only ever touch this cache's namespace. On Redis, matching uses `SCAN` with batched `DEL` — never `KEYS` — so it is safe for production.

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

async function main(): Promise<void> {
    const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

    await cache.set("product:1:price", 9.99);
    await cache.set("product:1:stock", 25);
    await cache.set("product:2:price", 19.99);
    await cache.set("user:1", { name: "Alice" });

    // Delete every entry for product 1 — returns the number of keys deleted
    console.log(await cache.deletePattern("product:1:*")); // 2

    // Unrelated keys are untouched
    console.log(await cache.exists("user:1")); // true

    // Wildcards can appear in the middle too
    console.log(await cache.deletePattern("product:*")); // 1
    console.log(await cache.deletePattern("nomatch:*")); // 0

    await cache.shutdown();
}

await main();
```

---

## How do I clear a cache without touching another application's data?

**Solution** — `clear()` deletes only the keys under the provider's own `rootKey` — it never runs `FLUSHDB` or drops other namespaces. Combined with automatic key prefixing, this means multiple applications (or multiple caches in one application) can safely share a single Redis database: the same logical key `user:1` is physically `Sessions:user:1` for one provider and `Products:user:1` for another.

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";

async function main(): Promise<void> {
    // Two providers against the SAME Redis database, isolated by rootKey
    const sessionCache = new RedisCacheProvider({
        rootKey: "Sessions",
        host: "localhost",
        port: 6379,
    });
    const productCache = new RedisCacheProvider({
        rootKey: "Products",
        host: "localhost",
        port: 6379,
    });

    await sessionCache.set("user:1", { token: "abc123" });
    await productCache.set("user:1", { name: "Widget" });

    // clear() removes only "Sessions:*" keys
    await sessionCache.clear();

    console.log(await sessionCache.get("user:1")); // undefined — cleared
    console.log(await productCache.get("user:1")); // { name: "Widget" } — untouched

    await productCache.clear();
    await sessionCache.shutdown();
    await productCache.shutdown();
}

await main();
```

---

## How do I switch between in-memory and Redis based on the environment?

**Solution** — Use `createCache()` with a `type` discriminator: it returns a `MemoryCacheProvider` for `'memory'` and a `RedisCacheProvider` for `'redis'`, both as `CacheProvider`, so calling code never changes. Redis-only fields (`host`, `port`, `password`, `db`, `url`) are ignored by the memory backend, an unsupported `type` throws `Unknown cache type: "…"` at construction time, and the result can be passed straight to `createCachePlugin()` for WebAFX.

```typescript
import { createCache } from "blendsdk/webafx-cache";

async function main(): Promise<void> {
    const cache = createCache({
        type: process.env.NODE_ENV === "production" ? "redis" : "memory",
        rootKey: "MyApp",
        defaultTTL: 300,
        // Redis-only options — ignored when type is "memory"
        host: process.env.REDIS_HOST ?? "localhost",
        port: 6379,
        password: process.env.REDIS_PASSWORD,
    });

    await cache.set("feature:flags", { darkMode: true });
    const flags = await cache.get<{ darkMode: boolean }>("feature:flags");
    console.log(flags?.darkMode); // true

    await cache.shutdown();
}

await main();
```

When a single connection URL is available, `url` takes precedence over the individual connection fields:

```typescript
// typescript fragment
import { createCache } from "blendsdk/webafx-cache";

const cache = createCache({
    type: "redis",
    rootKey: "MyApp",
    url: process.env.REDIS_URL, // overrides host/port/password/db
});
```

---

## How do I register a cache as a WebAFX plugin?

**Solution** — Pass a plugin definition to `app.use()`. The one-liners `redisCachePlugin()` and `memoryCachePlugin()` create the provider for you; `createCachePlugin(provider)` wraps any existing `CacheProvider` (including `createCache()` results or custom implementations). The plugin registers the provider as an application-wide singleton service (name defaults to `'cache'`, override with `serviceName`), wires `health()` into the `/health` endpoint, and `shutdown()` into graceful shutdown. Plugins install with priority `30` by default — override it via `createCachePlugin(provider, { priority })`.

```typescript
import { redisCachePlugin } from "blendsdk/webafx-cache";
import type { PluginDefinition } from "blendsdk/webafx";

function installCache(app: { use(plugin: PluginDefinition): void }): void {
    // Creates a RedisCacheProvider internally and registers it as the
    // singleton service 'cache' — no manual provider management required
    app.use(
        redisCachePlugin({
            rootKey: "MyApp",
            host: "localhost",
            port: 6379,
            defaultTTL: 300,
        })
    );
}

export { installCache };
```

---

## How do I run multiple independent caches in one application?

**Solution** — Register one plugin per cache, each with its own `serviceName` (the default name `'cache'` may be used only once, so extra caches need distinct names) and its own `rootKey` namespace. Each is an independent singleton service in the container with its own health check and shutdown hook.

```typescript
import { redisCachePlugin } from "blendsdk/webafx-cache";
import type { PluginDefinition } from "blendsdk/webafx";

function installCaches(app: { use(plugin: PluginDefinition): void }): void {
    // Registered as the "session-cache" service — keys live under "Sessions:*"
    app.use(
        redisCachePlugin({
            rootKey: "Sessions",
            host: "redis-sessions",
            serviceName: "session-cache",
        })
    );

    // Registered as the "product-cache" service — keys live under "Products:*"
    app.use(
        redisCachePlugin({
            rootKey: "Products",
            host: "redis-products",
            serviceName: "product-cache",
            defaultTTL: 600,
        })
    );
}

export { installCaches };
```

---

## How do I publish and subscribe to messages in-process?

**Solution** — Use `MemoryPubSubProvider`. `subscribe<T>()` registers a typed handler (multiple handlers per channel fan out to all of them); `publish()` returns the number of handlers that received the message — `0` when nobody is listening, which is not an error and nothing is buffered. In production, swap in `RedisPubSubProvider` (same API), or pick a backend from configuration with `createPubSub({ type: "redis" | "memory", ... })`.

```typescript
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";

interface OrderEvent {
    orderId: number;
    total: number;
}

async function main(): Promise<void> {
    const pubsub = new MemoryPubSubProvider({ channelPrefix: "MyApp" });

    // Handlers may be sync or async; the payload is typed via the generic
    await pubsub.subscribe<OrderEvent>("order:new", (message) => {
        console.log(`order ${message.data.orderId}: ${message.data.total}`);
    });

    // publish() returns how many handlers received the message
    console.log(
        await pubsub.publish<OrderEvent>("order:new", { orderId: 1001, total: 49.99 })
    ); // 1

    // Publishing with no subscribers returns 0 — nothing is buffered
    console.log(await pubsub.publish("order:cancelled", { orderId: 1002, total: 0 })); // 0

    await pubsub.shutdown();
}

await main();
```

---

## How do I subscribe to a family of channels with wildcards?

**Solution** — Use `psubscribe()` with a glob pattern: `*` matches any sequence of characters, `?` matches exactly one. Pattern handlers receive a `PubSubMessage` whose `pattern` field names the matching pattern. Exact and pattern subscriptions coexist — a message can be delivered to both, and all matching handlers count toward the return value of `publish()`. Remove a pattern subscription with `punsubscribe()`.

```typescript
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";

async function main(): Promise<void> {
    const pubsub = new MemoryPubSubProvider({ channelPrefix: "MyApp" });

    // '*' matches any sequence — receives every order:* message
    await pubsub.psubscribe("order:*", (message) => {
        console.log(`[${message.pattern}] ${message.channel}`);
    });

    // '?' matches exactly one character — audit:1 matches, audit:10 does not
    await pubsub.psubscribe("audit:?", (message) => {
        console.log("audit event:", message.data);
    });

    await pubsub.publish("order:created", { id: 1 });
    await pubsub.publish("order:shipped", { id: 1 });
    await pubsub.publish("audit:1", { action: "login" });
    await pubsub.publish("audit:10", { action: "logout" }); // no pattern matches

    // Inspect and remove subscriptions — names never include the internal prefix
    console.log(pubsub.activeSubscriptions().patterns); // [ 'order:*', 'audit:?' ]
    await pubsub.punsubscribe("audit:?");
    console.log(pubsub.activeSubscriptions().patterns); // [ 'order:*' ]

    await pubsub.shutdown();
}

await main();
```

---

## How do I keep pub/sub channels isolated between applications?

**Solution** — Configure a `channelPrefix`. Every channel and pattern is stored with the prefix applied (`AppA` + `events` becomes Redis channel `AppA:events`), so applications sharing one Redis instance never cross-talk — yet handlers always see the un-prefixed, user-facing names: `PubSubMessage.channel`, `PubSubMessage.pattern`, and `activeSubscriptions()` all report `events`, never `AppA:events`.

```typescript
import { RedisPubSubProvider } from "blendsdk/webafx-cache";

async function main(): Promise<void> {
    const appA = new RedisPubSubProvider({ host: "localhost", port: 6379, channelPrefix: "AppA" });
    const appB = new RedisPubSubProvider({ host: "localhost", port: 6379, channelPrefix: "AppB" });

    let receivedByB = 0;

    await appA.subscribe("events", (message) => {
        console.log("AppA received on", message.channel); // "events" — prefix stripped
    });
    await appB.subscribe("events", () => {
        receivedByB += 1;
    });

    // PUBLISHes to Redis channel "AppA:events" only — AppB's "AppB:events" is untouched
    console.log(await appA.publish("events", { type: "update" })); // 1
    console.log(receivedByB); // 0 — AppB never sees AppA's traffic

    await appA.shutdown();
    await appB.shutdown();
}

await main();
```

---

## How do I stop one failing message handler from breaking other subscribers?

**Solution** — You do not need defensive wrappers: every handler invocation is wrapped in an internal try/catch, so synchronous throws and async rejections are logged with `console.error` and isolated — remaining handlers still receive the message, the subscription stays active, and the underlying subscriber connection is unaffected. If a handler keeps failing, fix it or remove it with `unsubscribe()` / `punsubscribe()`.

```typescript
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";

async function main(): Promise<void> {
    const pubsub = new MemoryPubSubProvider({ channelPrefix: "MyApp" });

    // A handler that always throws…
    await pubsub.subscribe("events", () => {
        throw new Error("handler boom");
    });

    // …does not prevent other handlers from receiving the same message
    await pubsub.subscribe("events", (message) => {
        console.log("still delivered:", message.data);
    });

    const receivers = await pubsub.publish("events", { type: "update" });
    // Console output:
    // [PubSub] Handler error on channel "events": handler boom
    // still delivered: { type: "update" }

    console.log(receivers); // 2 — both handlers were invoked

    await pubsub.shutdown();
}

await main();
```

---

## How do I register pub/sub subscriptions declaratively in WebAFX?

**Solution** — Pass a `subscriptions` array to `createPubSubPlugin()` or the one-liners `redisPubSubPlugin()` / `memoryPubSubPlugin()`. Each entry supplies exactly one of `channel` (exact subscribe) or `pattern` (glob subscribe) plus a `handler`; subscriptions are established while the plugin installs, and the provider itself is registered as a singleton service (default name `'pubsub'`) with health and shutdown hooks. Declarative handlers are typed as `MessageHandler<unknown>` — if you need a fully typed payload, hold a reference to the provider and use the generic `subscribe<T>()` / `psubscribe<T>()` instead.

```typescript
import { redisPubSubPlugin } from "blendsdk/webafx-cache";
import type { PubSubMessage } from "blendsdk/webafx-cache";
import type { PluginDefinition } from "blendsdk/webafx";

function handleNewOrder(message: PubSubMessage): void {
    console.log(`new order on ${message.channel}:`, message.data);
}

function handleAuditEvent(message: PubSubMessage): void {
    console.log(`audit on ${message.channel} (matched ${message.pattern ?? "n/a"})`);
}

function installMessaging(app: { use(plugin: PluginDefinition): void }): void {
    app.use(
        redisPubSubPlugin(
            { host: "localhost", port: 6379, channelPrefix: "MyApp" },
            {
                subscriptions: [
                    { channel: "order:created", handler: handleNewOrder },
                    { pattern: "audit:*", handler: handleAuditEvent },
                ],
            }
        )
    );
}

export { installMessaging };
```

---

## How do I check provider health and shut down cleanly?

**Solution** — Every provider implements `health()` (Redis: `PING` on the connection(s); memory: always `true`) and `shutdown()` (Redis: graceful `quit()`; memory: clears the store/handlers and stops the cleanup timer). Registering via a WebAFX plugin wires both up automatically — `/health` and app teardown — so manual calls are only needed for standalone usage; always shut down providers you created yourself.

```typescript
import { RedisCacheProvider, MemoryPubSubProvider } from "blendsdk/webafx-cache";

async function main(): Promise<void> {
    const cache = new RedisCacheProvider({ rootKey: "MyApp", host: "localhost", port: 6379 });
    const pubsub = new MemoryPubSubProvider({ channelPrefix: "MyApp" });

    // Health checks are safe to call at any time
    console.log(await cache.health()); // true — Redis answered PING
    console.log(await pubsub.health()); // true — in-memory is always healthy

    // Graceful shutdown: close connections, clear state, release timers
    await cache.shutdown();
    await pubsub.shutdown();

    // A shut-down Redis provider reports unhealthy
    console.log(await cache.health()); // false
}

await main();
```

---

## How do I test code that uses the cache without Redis?

**Solution** — Inject the in-memory providers as drop-in stand-ins: they satisfy the same contract as the Redis backends (verified by the package's shared contract test suites), so tests written against them also pass against Redis. Give each test a unique `rootKey` / `channelPrefix` for isolation, disable the cleanup timer with `cleanupIntervalMs: 0` for determinism, and `shutdown()` in teardown.

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

let counter = 0;

/** Fresh, isolated cache for a single test — no Redis, no background timer. */
function createTestCache(): MemoryCacheProvider {
    counter += 1;
    return new MemoryCacheProvider({
        rootKey: `Test_${counter}`,
        cleanupIntervalMs: 0,
    });
}

test("caches a session and reports its TTL", async (t) => {
    const cache = createTestCache();

    t.after(async () => {
        await cache.shutdown();
    });

    // Misses are undefined
    assert.equal(await cache.get("session:1"), undefined);

    await cache.set("session:1", { userId: "u1" }, 60);

    assert.deepEqual(await cache.get("session:1"), { userId: "u1" });
    assert.ok((await cache.ttl("session:1")) > 0);
});
```

---

# webafx-cache Examples Library

This document is a categorized collection of copy-paste-ready examples for `blendsdk/webafx-cache`. Every example is a complete ESM TypeScript module with all required imports — no pseudo-code, no placeholders. Examples built on `MemoryCacheProvider` and `MemoryPubSubProvider` run without any infrastructure; examples that use Redis assume a server reachable at `localhost:6379` and say so explicitly.

To run an example, save it to a `.ts` file in an ESM project (Node.js >= 22) and execute it with a TypeScript runner, for example `npx tsx example.ts`. Compare the printed output with the `// Output:` block at the end of each code block.

### Category Index

| Category | Examples | Focus |
|----------|----------|-------|
| Caching Basics | 1–4 | `set`/`get` round-trips, cache-aside with `getOrSet()`, default TTL, `delete`/`exists` |
| TTL Management | 5–6 | `ttl()` sentinel values, `expire()`, real expiration timing |
| Pattern Operations & Key Namespacing | 7–8 | `deletePattern()`, `clear()`, `rootKey` isolation |
| Redis Caching | 9–11 | Host/port and URL connections, multi-cache with `serviceName` |
| Pub/Sub Basics | 12–17 | `subscribe`/`publish`, typed payloads, `psubscribe`, fan-out, error isolation, `activeSubscriptions` |
| Redis Pub/Sub | 18 | Two-connection Redis messaging |
| WebAFX Plugin Integration | 19–24 | Plugin one-liners, provider wrapping, declarative subscriptions, multi-cache setup |
| Environment-Based Factories | 25–26 | `createCache()`, `createPubSub()` |
| Lifecycle: Health, Shutdown & Cleanup | 27–29 | `health()`, graceful `shutdown()`, memory cleanup timer |
| Advanced Patterns | 30–31 | Backend-agnostic code, cross-instance cache invalidation |

---

## Caching Basics

### 1. Store and Retrieve Values

The simplest cache round-trip. Values are JSON-serialized on write and deserialized on read, and the `rootKey` is applied automatically — `product:1` is stored as `MyApp:product:1` internally.

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

interface Product {
    id: string;
    name: string;
    price: number;
}

async function main(): Promise<void> {
    const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

    await cache.set<Product>("product:1", {
        id: "1",
        name: "Mechanical Keyboard",
        price: 89.99,
    });

    const product = await cache.get<Product>("product:1");
    console.log(product?.name);

    const missing = await cache.get<Product>("product:999");
    console.log(missing);

    await cache.shutdown();
}

await main();

// Output:
// Mechanical Keyboard
// undefined
```

### 2. Cache-Aside with getOrSet

`getOrSet()` returns the cached value on a hit, or runs the factory, caches the result, and returns it on a miss. The factory executes only once per key/TTL window.

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

interface Article {
    id: number;
    title: string;
}

let databaseQueries = 0;

async function fetchArticleFromDatabase(id: number): Promise<Article> {
    databaseQueries++;
    return { id, title: "Introduction to Caching" };
}

async function main(): Promise<void> {
    const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

    const first = await cache.getOrSet<Article>(
        "article:42",
        () => fetchArticleFromDatabase(42),
        300
    );

    const second = await cache.getOrSet<Article>(
        "article:42",
        () => fetchArticleFromDatabase(42),
        300
    );

    console.log(first.title);
    console.log(second.title);
    console.log(databaseQueries);

    await cache.shutdown();
}

await main();

// Output:
// Introduction to Caching
// Introduction to Caching
// 1
```

### 3. Configure a Default TTL

A `defaultTTL` (in seconds) applies whenever `set()` receives no explicit TTL. An explicit `0` overrides the default and means the entry never expires.

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

async function main(): Promise<void> {
    const cache = new MemoryCacheProvider({
        rootKey: "MyApp",
        defaultTTL: 60, // seconds — used whenever set() gets no explicit TTL
    });

    await cache.set("config:theme", "dark");            // uses defaultTTL (60s)
    await cache.set("session:abc", { userId: 7 }, 900); // explicit 15-minute TTL
    await cache.set("feature:beta", true, 0);           // explicit 0 — never expires

    console.log(await cache.ttl("config:theme"));
    console.log(await cache.ttl("session:abc"));
    console.log(await cache.ttl("feature:beta"));

    await cache.shutdown();
}

await main();

// Output:
// 60
// 900
// -1
```

### 4. Delete Keys and Check Existence

`delete()` reports whether a key was actually removed, while `exists()` tells you if a key is present and not expired.

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

async function main(): Promise<void> {
    const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

    await cache.set("user:1", { name: "Alice" });

    console.log(await cache.exists("user:1")); // key present
    console.log(await cache.delete("user:1")); // first delete removes it
    console.log(await cache.delete("user:1")); // second delete finds nothing
    console.log(await cache.exists("user:1"));

    await cache.shutdown();
}

await main();

// Output:
// true
// true
// false
// false
```

---

## TTL Management

### 5. Inspect and Extend TTLs

`ttl()` follows Redis conventions: a positive number is the remaining seconds, `-1` means the key exists without expiry, and `-2` means the key does not exist. `expire()` resets a key's TTL without touching its value.

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

async function main(): Promise<void> {
    const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

    await cache.set("token", "abc123", 30);
    console.log(await cache.ttl("token"));

    // Extend the token's lifetime without changing its value
    console.log(await cache.expire("token", 120));
    console.log(await cache.ttl("token"));

    await cache.set("persistent", "value"); // no TTL
    console.log(await cache.ttl("persistent")); // exists, no expiry
    console.log(await cache.ttl("missing"));    // never stored

    await cache.shutdown();
}

await main();

// Output:
// 30
// true
// 120
// -1
// -2
```

### 6. Watch a Key Expire

Entries disappear once their TTL elapses — `get()` returns `undefined`, `exists()` returns `false`, and `ttl()` reports the missing-key sentinel `-2`.

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

interface Sale {
    discountPercent: number;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
    const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

    await cache.set<Sale>("flash-sale", { discountPercent: 25 }, 1);

    console.log(await cache.get<Sale>("flash-sale"));

    await delay(1200); // 1-second TTL + margin

    console.log(await cache.get("flash-sale"));
    console.log(await cache.exists("flash-sale"));
    console.log(await cache.ttl("flash-sale"));

    await cache.shutdown();
}

await main();

// Output:
// { discountPercent: 25 }
// undefined
// false
// -2
```

---

## Pattern Operations & Key Namespacing

### 7. Invalidate Related Keys with deletePattern

`deletePattern()` removes every key matching a glob pattern within the provider's namespace and returns the number of keys deleted. Wildcards may appear anywhere in the pattern (e.g. `api:*:active`). On Redis this is implemented with `SCAN` plus batched `DEL` — production-safe and never `KEYS`.

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

async function main(): Promise<void> {
    const cache = new MemoryCacheProvider({ rootKey: "MyApp" });

    await cache.set("user:1", "Alice");
    await cache.set("user:2", "Bob");
    await cache.set("user:3", "Carol");
    await cache.set("product:1", "Keyboard");

    const deleted = await cache.deletePattern("user:*");
    console.log(deleted);

    console.log(await cache.exists("user:1"));
    console.log(await cache.exists("product:1"));

    await cache.shutdown();
}

await main();

// Output:
// 3
// false
// true
```

### 8. Isolate and Clear Namespaces with rootKey

Two providers with different `rootKey` values never see each other's keys — even when they share the same Redis server. `clear()` removes only the keys under the provider's own namespace.

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

async function main(): Promise<void> {
    const sessions = new MemoryCacheProvider({ rootKey: "Sessions" });
    const products = new MemoryCacheProvider({ rootKey: "Products" });

    // Same key name, two isolated namespaces
    await sessions.set("user:42", { userId: 42 });
    await products.set("user:42", { productId: "abc" });

    console.log(await sessions.get("user:42"));
    console.log(await products.get("user:42"));

    // clear() only touches the "Sessions" namespace
    await sessions.clear();
    console.log(await sessions.get("user:42"));
    console.log(await products.get("user:42"));

    await sessions.shutdown();
    await products.shutdown();
}

await main();

// Output:
// { userId: 42 }
// { productId: 'abc' }
// undefined
// { productId: 'abc' }
```

---

## Redis Caching

The examples in this section require a running Redis server (assumed at `localhost:6379`). In the package's own docker-compose test setup, the mapped port is `6399`.

### 9. Connect with Host and Port

The standard connection shape: `rootKey` for namespace isolation plus Redis connection options. When `url` is omitted, `host`/`port`/`password`/`db` are used.

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";

interface UserProfile {
    id: number;
    name: string;
}

async function main(): Promise<void> {
    const cache = new RedisCacheProvider({
        rootKey: "MyApp",
        host: "localhost",
        port: 6379,
        db: 0,
        defaultTTL: 300,
    });

    await cache.set<UserProfile>("user:123", { id: 123, name: "Alice" }, 600);

    const user = await cache.get<UserProfile>("user:123");
    console.log(user?.name);
    console.log(await cache.ttl("user:123"));

    await cache.shutdown();
}

await main();

// Output:
// Alice
// 600
```

### 10. Connect with a Redis URL

When `url` is provided, it takes precedence over `host`, `port`, `password`, and `db`.

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";

async function main(): Promise<void> {
    const cache = new RedisCacheProvider({
        rootKey: "MyApp",
        url: "redis://localhost:6379",
        connectTimeout: 3000,
    });

    await cache.set("greeting", "hello");
    console.log(await cache.get<string>("greeting"));

    await cache.shutdown();
}

await main();

// Output:
// hello
```

### 11. Run Multiple Caches with serviceName

`serviceName` names each cache for WebAFX service-container registration (default: `"cache"`). Different `rootKey` namespaces keep the data apart even on a single Redis instance.

```typescript
import { RedisCacheProvider } from "blendsdk/webafx-cache";

interface Session {
    userId: number;
    refreshToken: string;
}

async function main(): Promise<void> {
    const sessionCache = new RedisCacheProvider({
        rootKey: "Sessions",
        serviceName: "session-cache",
        host: "localhost",
        port: 6379,
        defaultTTL: 1800,
    });

    const productCache = new RedisCacheProvider({
        rootKey: "Products",
        serviceName: "product-cache",
        host: "localhost",
        port: 6379,
        defaultTTL: 300,
    });

    console.log(sessionCache.serviceName);
    console.log(productCache.serviceName);

    await sessionCache.set<Session>("user:7", { userId: 7, refreshToken: "rt_9f2a1b" });
    await productCache.set("sku:123", { name: "Keyboard" });

    // Actual Redis keys: "Sessions:user:7" and "Products:sku:123"
    console.log(await sessionCache.get<Session>("user:7"));
    console.log(await productCache.get("sku:123"));

    await sessionCache.shutdown();
    await productCache.shutdown();
}

await main();

// Output:
// session-cache
// product-cache
// { userId: 7, refreshToken: 'rt_9f2a1b' }
// { name: 'Keyboard' }
```

---

## Pub/Sub Basics

### 12. Publish and Subscribe

Subscribe a handler to an exact channel, then publish. `publish()` returns the number of handlers that received the message.

```typescript
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";
import type { PubSubMessage } from "blendsdk/webafx-cache";

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
    const pubsub = new MemoryPubSubProvider();

    await pubsub.subscribe<string>("greetings", (message: PubSubMessage<string>) => {
        console.log(`Received on "${message.channel}": ${message.data}`);
    });

    const receivers = await pubsub.publish("greetings", "hello world");
    await delay(10);

    console.log(`Delivered to ${receivers} handler(s)`);

    await pubsub.shutdown();
}

await main();

// Output:
// Received on "greetings": hello world
// Delivered to 1 handler(s)
```

### 13. Deliver Typed Payloads

Generics flow through `subscribe<T>()` and `publish<T>()`, so handlers see fully typed `PubSubMessage<T>` envelopes. Note that with a `channelPrefix` configured, handlers still see the un-prefixed channel name.

```typescript
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";
import type { PubSubMessage } from "blendsdk/webafx-cache";

interface OrderCreated {
    orderId: number;
    total: number;
    customer: string;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
    const pubsub = new MemoryPubSubProvider({ channelPrefix: "MyApp" });

    await pubsub.subscribe<OrderCreated>("order:created", (message: PubSubMessage<OrderCreated>) => {
        const order = message.data;
        console.log(`Order #${order.orderId} for ${order.customer}: $${order.total}`);
        console.log(message.channel); // prefix is stripped for handlers
    });

    await pubsub.publish<OrderCreated>("order:created", {
        orderId: 1042,
        total: 99.99,
        customer: "Alice",
    });

    await delay(10);
    await pubsub.shutdown();
}

await main();

// Output:
// Order #1042 for Alice: $99.99
// order:created
```

### 14. Pattern Subscriptions with psubscribe

`psubscribe()` matches a whole channel family using glob wildcards (`*` for any sequence, `?` for a single character). Pattern-matched envelopes include the `pattern` field.

```typescript
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";
import type { PubSubMessage } from "blendsdk/webafx-cache";

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
    const pubsub = new MemoryPubSubProvider();

    await pubsub.psubscribe("audit:*", (message: PubSubMessage) => {
        console.log(`[${message.pattern}] ${message.channel}`);
    });

    await pubsub.publish("audit:login", { userId: 1 });
    await pubsub.publish("audit:logout", { userId: 1 });
    await pubsub.publish("order:created", { orderId: 2 }); // does not match "audit:*"

    await delay(10);
    await pubsub.shutdown();
}

await main();

// Output:
// [audit:*] audit:login
// [audit:*] audit:logout
```

### 15. Fan Out to Multiple Handlers

Multiple handlers can be registered on the same channel; every handler receives every message, and `publish()` counts all of them.

```typescript
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";
import type { PubSubMessage } from "blendsdk/webafx-cache";

interface CacheInvalidation {
    key: string;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
    const pubsub = new MemoryPubSubProvider();

    await pubsub.subscribe<CacheInvalidation>("cache:invalidate", (message: PubSubMessage<CacheInvalidation>) => {
        console.log(`Handler A — drop local cache for "${message.data.key}"`);
    });

    await pubsub.subscribe<CacheInvalidation>("cache:invalidate", (message: PubSubMessage<CacheInvalidation>) => {
        console.log(`Handler B — record audit entry for "${message.data.key}"`);
    });

    const receivers = await pubsub.publish<CacheInvalidation>("cache:invalidate", { key: "user:1" });
    await delay(10);

    console.log(`Delivered to ${receivers} handlers`);

    await pubsub.shutdown();
}

await main();

// Output:
// Handler A — drop local cache for "user:1"
// Handler B — record audit entry for "user:1"
// Delivered to 2 handlers
```

### 16. Isolate Handler Errors

A throwing handler (sync or async) is caught and logged by the built-in error isolation — other handlers on the same channel still receive the message and the subscriber connection stays healthy.

```typescript
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";
import type { MessageHandler } from "blendsdk/webafx-cache";

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
    const pubsub = new MemoryPubSubProvider();

    const badHandler: MessageHandler = () => {
        throw new Error("handler is broken");
    };

    await pubsub.subscribe("events", badHandler);
    await pubsub.subscribe<string>("events", (message) => {
        console.log(`Healthy handler received: ${message.data}`);
    });

    await pubsub.publish("events", "payload");
    await delay(10);

    await pubsub.shutdown();
}

await main();

// Output:
// [PubSub] Handler error on channel "events": handler is broken
// Healthy handler receives: payload
```

### 17. Inspect and Clean Up Subscriptions

`activeSubscriptions()` is synchronous and reports the user-facing (un-prefixed) channel and pattern names. `unsubscribe()`/`punsubscribe()` remove all handlers for a channel or pattern.

```typescript
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";

async function main(): Promise<void> {
    const pubsub = new MemoryPubSubProvider();

    await pubsub.subscribe("orders", () => {});
    await pubsub.subscribe("users", () => {});
    await pubsub.psubscribe("audit:*", () => {});

    console.log(pubsub.activeSubscriptions());

    await pubsub.unsubscribe("orders");
    await pubsub.punsubscribe("audit:*");

    console.log(pubsub.activeSubscriptions());

    await pubsub.shutdown();

    console.log(pubsub.activeSubscriptions());
}

await main();

// Output:
// { channels: [ 'orders', 'users' ], patterns: [ 'audit:*' ] }
// { channels: [ 'users' ], patterns: [] }
// { channels: [], patterns: [] }
```

---

## Redis Pub/Sub

### 18. Cross-Process Messaging with Redis

`RedisPubSubProvider` maintains two dedicated ioredis connections — one for publishing, one for subscribing (Redis requires a dedicated connection once a client enters subscriber mode). Any process on the same Redis instance receives published messages.

```typescript
import { RedisPubSubProvider } from "blendsdk/webafx-cache";
import type { PubSubMessage } from "blendsdk/webafx-cache";

interface OrderCreated {
    orderId: number;
    total: number;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
    const pubsub = new RedisPubSubProvider({
        host: "localhost",
        port: 6379,
        channelPrefix: "MyApp",
    });

    await pubsub.subscribe<OrderCreated>("order:created", (message: PubSubMessage<OrderCreated>) => {
        console.log(`Order #${message.data.orderId} — $${message.data.total}`);
    });

    await delay(100); // allow the subscriber connection to confirm SUBSCRIBE

    const receivers = await pubsub.publish<OrderCreated>("order:created", {
        orderId: 1042,
        total: 99.99,
    });

    await delay(200); // allow the message to round-trip through Redis
    console.log(`Redis reported ${receivers} subscriber(s)`);

    await pubsub.shutdown();
}

await main();

// Output:
// Order #1042 — $99.99
// Redis reported 1 subscriber(s)
```

---

## WebAFX Plugin Integration

The plugin factory functions below return a WebAFX `PluginDefinition`. Register it with `app.use(plugin)` in your WebAFX application, which installs the provider as an application-wide singleton service and wires its `health()` and `shutdown()` into the application lifecycle. The examples build and inspect the plugin definitions themselves; the `app.use(...)` line is shown as a comment since application setup lives outside this package.

### 19. Register an In-Memory Cache Plugin

The one-liner for an in-memory cache — no configuration beyond the usual cache options. Default priority is `30`.

```typescript
import { memoryCachePlugin } from "blendsdk/webafx-cache";

const plugin = memoryCachePlugin({
    rootKey: "MyApp",
    defaultTTL: 60,
});

console.log(plugin.name);
console.log(plugin.priority);

// app.use(plugin);
```

// Output:
// cache
// 30

### 20. Register a Redis Cache Plugin

The one-liner for a Redis-backed cache. The provider (and its ioredis client) is created internally — you never instantiate it manually.

```typescript
import { redisCachePlugin } from "blendsdk/webafx-cache";

// Requires a running Redis server
const plugin = redisCachePlugin({
    rootKey: "MyApp",
    host: "localhost",
    port: 6379,
    defaultTTL: 300,
});

console.log(plugin.name);
console.log(plugin.priority);

// app.use(plugin);
```

// Output:
// cache
// 30

### 21. Wrap Your Own Provider with createCachePlugin

Any `CacheProvider` instance — including custom subclasses — can be adapted with `createCachePlugin()`. The plugin name comes from `provider.serviceName`, and the optional `priority` overrides the default of `30`.

```typescript
import { MemoryCacheProvider, createCachePlugin } from "blendsdk/webafx-cache";

const provider = new MemoryCacheProvider({
    rootKey: "Reports",
    serviceName: "report-cache",
});

const plugin = createCachePlugin(provider, { priority: 10 });

console.log(plugin.name);
console.log(plugin.priority);

// app.use(plugin);
```

// Output:
// report-cache
// 10

### 22. Register a Pub/Sub Plugin

`memoryPubSubPlugin()` needs no arguments at all; `redisPubSubPlugin()` takes the same connection options as the Redis provider. A custom `serviceName` disambiguates multiple pub/sub providers.

```typescript
import { memoryPubSubPlugin, redisPubSubPlugin } from "blendsdk/webafx-cache";

// Development / single-instance — works with zero configuration
const devPlugin = memoryPubSubPlugin({ channelPrefix: "MyApp" });

// Production / multi-instance — shared across every application process
const prodPlugin = redisPubSubPlugin({
    host: "localhost",
    port: 6379,
    channelPrefix: "MyApp",
    serviceName: "events",
});

console.log(devPlugin.name);
console.log(prodPlugin.name);
```

// Output:
// pubsub
// events

### 23. Declarative Pub/Sub Subscriptions

Subscriptions can be declared in the plugin options and are registered in order when the plugin installs. Handlers on `SubscriptionDefinition` entries receive `PubSubMessage<unknown>`, so narrow `message.data` inside the handler — or use the imperative `subscribe<T>()` API for strongly typed payloads.

```typescript
import { redisPubSubPlugin } from "blendsdk/webafx-cache";
import type { PubSubMessage, SubscriptionDefinition } from "blendsdk/webafx-cache";

function handleOrderCreated(message: PubSubMessage): void {
    console.log("order:created →", message.data);
}

function handleAuditEvent(message: PubSubMessage): void {
    console.log(`${message.pattern} → ${message.channel}`);
}

const subscriptions: SubscriptionDefinition[] = [
    { channel: "order:created", handler: handleOrderCreated },
    { pattern: "audit:*", handler: handleAuditEvent },
];

const plugin = redisPubSubPlugin(
    { host: "localhost", port: 6379, channelPrefix: "MyApp" },
    { subscriptions }
);

console.log(plugin.name);

// app.use(plugin);
// On install, WebAFX invokes the factory, which calls subscribe()/psubscribe()
// for every definition above.
```

// Output:
// pubsub

### 24. Multi-Cache Application Setup

Two independent caches in one application: distinct `rootKey` namespaces keep data apart, while distinct `serviceName` values let the service container resolve each one.

```typescript
import { redisCachePlugin } from "blendsdk/webafx-cache";

const sessionCache = redisCachePlugin({
    rootKey: "Sessions",
    serviceName: "session-cache",
    host: "localhost",
    port: 6379,
    defaultTTL: 1800,
});

const productCache = redisCachePlugin({
    rootKey: "Products",
    serviceName: "product-cache",
    host: "localhost",
    port: 6379,
    defaultTTL: 300,
});

console.log(sessionCache.name);
console.log(productCache.name);

// app.use(sessionCache);
// app.use(productCache);
```

// Output:
// session-cache
// product-cache

---

## Environment-Based Factories

### 25. Switch Cache Backends with createCache

`createCache()` selects the backend from a `type` discriminator, which makes environment-driven configuration a one-liner. An unknown `type` throws an `Error` listing the supported backends (`"redis"`, `"memory"`).

```typescript
import { createCache, createCachePlugin } from "blendsdk/webafx-cache";

const cache = createCache({
    type: process.env.NODE_ENV === "production" ? "redis" : "memory",
    rootKey: "MyApp",
    defaultTTL: 300,
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : undefined,
});

console.log(cache.constructor.name); // "RedisCacheProvider" in production

const plugin = createCachePlugin(cache);

console.log(plugin.name);

// app.use(plugin);
```

// Output (development):
// MemoryCacheProvider
// cache

### 26. Switch Pub/Sub Backends with createPubSub

`createPubSub()` mirrors `createCache()`: the same configuration shape drives either a `MemoryPubSubProvider` or a `RedisPubSubProvider` depending on `type`.

```typescript
import { createPubSub, createPubSubPlugin } from "blendsdk/webafx-cache";

const pubsub = createPubSub({
    type: process.env.NODE_ENV === "production" ? "redis" : "memory",
    channelPrefix: "MyApp",
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : undefined,
});

console.log(pubsub.serviceName);

const plugin = createPubSubPlugin(pubsub);

console.log(plugin.name);

// app.use(plugin);
```

// Output:
// pubsub
// pubsub

---

## Lifecycle: Health, Shutdown & Cleanup

### 27. Health Checks

`health()` never throws — it returns a boolean. In-memory providers are always healthy; Redis providers send `PING` (the pub/sub provider pings both its publisher and subscriber connections). When a plugin is registered, this check is automatically wired into the application's `/health` endpoint.

```typescript
import {
    MemoryCacheProvider,
    MemoryPubSubProvider,
    RedisCacheProvider,
    RedisPubSubProvider,
} from "blendsdk/webafx-cache";

async function main(): Promise<void> {
    // In-memory providers are always healthy
    const memoryCache = new MemoryCacheProvider({ rootKey: "MyApp" });
    const memoryPubSub = new MemoryPubSubProvider();

    console.log(await memoryCache.health());
    console.log(await memoryPubSub.health());

    await memoryCache.shutdown();
    await memoryPubSub.shutdown();

    // Redis providers require a running server; false on any connection failure
    const redisCache = new RedisCacheProvider({ rootKey: "MyApp", host: "localhost", port: 6379 });
    const redisPubSub = new RedisPubSubProvider({ host: "localhost", port: 6379 });

    console.log(await redisCache.health());
    console.log(await redisPubSub.health());

    await redisCache.shutdown();
    await redisPubSub.shutdown();
}

await main();

// Output (with Redis running):
// true
// true
// true
// true
```

### 28. Graceful Shutdown

`shutdown()` releases everything: Redis connections are closed gracefully via `quit()` after unsubscribing, and in-memory providers stop their cleanup timer and empty the store. On Redis providers, a subsequent `health()` returns `false` because the connection is closed; in-memory providers stay "healthy" since they hold no external connection.

```typescript
import { RedisCacheProvider, RedisPubSubProvider } from "blendsdk/webafx-cache";

async function main(): Promise<void> {
    const cache = new RedisCacheProvider({ rootKey: "MyApp", host: "localhost", port: 6379 });
    const pubsub = new RedisPubSubProvider({ host: "localhost", port: 6379 });

    await pubsub.subscribe("events", () => {});
    await cache.set("status", "online");

    // Unsubscribes everything and closes both pub/sub connections;
    // waits for pending cache commands before quitting the cache connection.
    await pubsub.shutdown();
    await cache.shutdown();

    console.log(await cache.health());
}

await main();

// Output:
// false
```

### 29. Periodic Cleanup in the Memory Backend

The memory backend reclaims expired entries with a periodic timer (default: every 60 s), in addition to lazy eviction on access. The timer is created with `.unref()`, so it never keeps the Node.js process alive; set `cleanupIntervalMs: 0` to disable it entirely.

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
    // Expired entries are reclaimed every 500 ms instead of waiting for a read
    const cache = new MemoryCacheProvider({
        rootKey: "MyApp",
        cleanupIntervalMs: 500,
    });

    await cache.set("short-lived", "value", 1);

    console.log(await cache.exists("short-lived"));

    await delay(1600); // TTL + cleanup interval + margin

    console.log(await cache.exists("short-lived"));

    await cache.shutdown(); // stops the cleanup timer
}

await main();

// Output:
// true
// false
```

---

## Advanced Patterns

### 30. Backend-Agnostic Code with the CacheProvider Type

Write helpers against the abstract `CacheProvider` type and they work unchanged with the memory backend, Redis, or any custom subclass. Swapping backends becomes a construction-time decision.

```typescript
import { MemoryCacheProvider, RedisCacheProvider } from "blendsdk/webafx-cache";
import type { CacheProvider } from "blendsdk/webafx-cache";

async function warmUp(cache: CacheProvider): Promise<void> {
    const value = await cache.getOrSet("welcome-message", async () => "hello", 300);
    console.log(value);
}

async function main(): Promise<void> {
    const memoryCache = new MemoryCacheProvider({ rootKey: "MyApp" });
    await warmUp(memoryCache);
    await memoryCache.shutdown();

    // Requires a running Redis server
    const redisCache = new RedisCacheProvider({
        rootKey: "MyApp",
        host: "localhost",
        port: 6379,
    });
    await warmUp(redisCache);
    await redisCache.shutdown();
}

await main();

// Output:
// hello
// hello
```

### 31. Cross-Instance Cache Invalidation with Pub/Sub

Combine both hierarchies: every application instance subscribes to an invalidation channel, and whichever instance mutates data publishes the event so all instances drop the matching keys.

```typescript
import { RedisCacheProvider, RedisPubSubProvider } from "blendsdk/webafx-cache";

interface InvalidationEvent {
    pattern: string;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
    const cache = new RedisCacheProvider({ rootKey: "MyApp", host: "localhost", port: 6379 });
    const pubsub = new RedisPubSubProvider({
        host: "localhost",
        port: 6379,
        channelPrefix: "MyApp",
    });

    // In a real deployment every instance subscribes to this channel; the
    // instance that mutates data publishes the invalidation event.
    await pubsub.subscribe<InvalidationEvent>("cache:invalidate", async (message) => {
        const deleted = await cache.deletePattern(message.data.pattern);
        console.log(`Invalidated ${deleted} keys matching "${message.data.pattern}"`);
    });

    await delay(100); // let the subscription establish

    await cache.set("product:1", { name: "Keyboard" });
    await cache.set("product:2", { name: "Mouse" });

    await pubsub.publish<InvalidationEvent>("cache:invalidate", { pattern: "product:*" });
    await delay(200); // let the message round-trip through Redis

    await pubsub.shutdown();
    await cache.shutdown();
}

await main();

// Output:
// Invalidated 2 keys matching "product:*"
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
