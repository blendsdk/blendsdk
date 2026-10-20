> **Package**: `blendsdk/webafx-cache`

# webafx-cache Advanced Patterns

This document covers advanced usage patterns for `blendsdk/webafx-cache` — compositions of the cache hierarchy, the pub/sub hierarchy, the WebAFX plugin integration, and the Redis-free memory entry point that solve concrete production problems. Because the Redis and in-memory providers are pinned to identical behavior by cross-backend contract tests, every pattern below works unchanged on either backend: examples use Redis where cross-instance coordination is essential, and in-memory providers where local state is the point.

| Pattern | Combines | Use when |
|---------|----------|----------|
| Cross-instance cache invalidation | `CacheProvider` + `PubSubProvider` | Several instances must not serve stale data after a write |
| Two-tier caching | Memory L1 + Redis L2 + pub/sub | Read latency and Redis load matter |
| Graceful degradation | Cache API + `health()` / `shutdown()` | Cache outages must not become request failures |
| Named multi-service registration | Plugin factories + `serviceName` / `rootKey` / `channelPrefix` | The app has several independent caching or messaging concerns |
| Environment-portable backends | `createCache()` / `createPubSub()` + `/memory` subpath | Dev/test/prod parity, tests without infrastructure |
| Declarative subscriptions | `createPubSubPlugin()` options | Subscription wiring should live in one startup-time place |

---

## Pattern: Cross-Instance Cache Invalidation via Pub/Sub

Use this pattern when several instances of the same application share one Redis-backed cache and a write on any instance must not leave stale entries behind on the others. The writer publishes a typed invalidation event through `PubSubProvider`; every instance — including the writer — purges the affected keys, and the normal `getOrSet()` read path refills the cache lazily.

### Implementation

```typescript
import type { PluginDefinition } from 'blendsdk/webafx';
import {
    createCachePlugin,
    createPubSubPlugin,
    RedisCacheProvider,
    RedisPubSubProvider,
} from 'blendsdk/webafx-cache';

// ---------------------------------------------------------------------------
// Domain and event types (shared by read path, write path, and subscriber)
// ---------------------------------------------------------------------------

interface Product {
    id: number;
    name: string;
    price: number;
}

/** Payload published on `cache:invalidate:*` channels. */
interface CacheInvalidation {
    /** Exact cache keys to delete on every instance. */
    keys?: string[];
    /** Wildcard patterns to delete on every instance (e.g. 'product:list:*'). */
    patterns?: string[];
}

/** Minimal structural view of the WebAFX application — keeps the example self-contained. */
interface App {
    use(plugin: PluginDefinition): void;
}

// ---------------------------------------------------------------------------
// Stand-ins for the real database layer
// ---------------------------------------------------------------------------

const database = new Map<number, Product>();

async function loadProduct(id: number): Promise<Product> {
    const product = database.get(id);
    if (!product) {
        throw new Error(`Product ${id} not found`);
    }
    return product;
}

async function persistProduct(product: Product): Promise<void> {
    database.set(product.id, product);
}

// ---------------------------------------------------------------------------
// Wiring — called once during application startup, on every instance
// ---------------------------------------------------------------------------

export interface CatalogServices {
    cache: RedisCacheProvider;
    pubsub: RedisPubSubProvider;
}

export async function registerCatalogServices(app: App): Promise<CatalogServices> {
    const cache = new RedisCacheProvider({
        rootKey: 'Catalog',
        url: process.env.REDIS_URL,
        defaultTTL: 300,
    });

    const pubsub = new RedisPubSubProvider({
        channelPrefix: 'Catalog',
        url: process.env.REDIS_URL,
    });

    // One pattern subscription covers every entity type ('cache:invalidate:product',
    // 'cache:invalidate:user', ...). The publisher receives its own events too —
    // purging is idempotent, so duplicate delivery is harmless.
    await pubsub.psubscribe<CacheInvalidation>('cache:invalidate:*', async (message) => {
        const { keys = [], patterns = [] } = message.data;

        await Promise.all(keys.map((key) => cache.delete(key)));

        for (const pattern of patterns) {
            await cache.deletePattern(pattern);
        }
    });

    app.use(createCachePlugin(cache));
    app.use(createPubSubPlugin(pubsub));

    // Returned for end-to-end usage in this example; a full WebAFX application
    // resolves both services by name from the container instead.
    return { cache, pubsub };
}

// ---------------------------------------------------------------------------
// Read path — cache-aside; a miss repopulates from the database
// ---------------------------------------------------------------------------

export async function getProduct(cache: RedisCacheProvider, id: number): Promise<Product> {
    const product = await cache.getOrSet<Product>(`product:${id}`, () => loadProduct(id), 300);
    return product;
}

// ---------------------------------------------------------------------------
// Write path — persist, then invalidate on every instance
// ---------------------------------------------------------------------------

export async function updateProduct(
    cache: RedisCacheProvider,
    pubsub: RedisPubSubProvider,
    product: Product
): Promise<void> {
    const key = `product:${product.id}`;

    // Persist FIRST, then invalidate. Invalidation must never precede the write,
    // or a concurrent reader could refill the cache with the old row.
    await persistProduct(product);

    await cache.delete(key);
    await pubsub.publish<CacheInvalidation>('cache:invalidate:product', {
        keys: [key],
        patterns: ['product:list:*'],
    });
}
```

End-to-end flow — the sequence after startup:

```typescript fragment
const { cache, pubsub } = await registerCatalogServices(app);

const product = await getProduct(cache, 42); // miss → database → cached as 'Catalog:product:42'
await updateProduct(cache, pubsub, { id: 42, name: 'Renamed', price: 24.99 });
// 'product:42' deleted locally · 'product:list:*' invalidated · every other
// instance purges on the cache:invalidate:product event and refills on next read
```

### Why it works

- **Freshness on every node**: after the write, each instance purges its copy the moment the event arrives; the next read repopulates with new data. Staleness is bounded by event latency (typically milliseconds on a local Redis) instead of the full TTL.
- **Writers stay decoupled from cache topology**: `updateProduct()` doesn't know how many instances or derived keys exist; it publishes one event. New caches subscribe to the same topic without touching writers.
- **One subscription, many entity types**: the glob topic convention (`cache:invalidate:<entity>`) plus the `keys` / `patterns` payload keeps a single handler per instance — adding `cache:invalidate:user` requires no new subscription code.
- **Both hierarchies at work**: the cache provides read acceleration; pub/sub provides coordination. Swapping in `MemoryCacheProvider` / `MemoryPubSubProvider` keeps the same code for single-instance apps and tests (in-process delivery makes invalidation synchronous).

### Caveats and performance

- **Fire-and-forget delivery**: an instance that is down, restarting, or reconnecting when an event fires never learns about it. Keep finite TTLs (`defaultTTL: 300` above) so a missed invalidation is self-healing — never combine this pattern with no-expiry keys.
- **The classic repopulate race is narrowed, not eliminated**: a reader that loaded the old row just before the write can store it just after the invalidation passes. The TTL is the standard backstop.
- **`deletePattern()` cost scales with the fleet**: every event triggers `SCAN`-based deletion on every instance, and every pattern fans that work out fleet-wide. Prefer explicit keys, keep patterns narrow (`product:list:*`, never `*`).
- **Handlers must be idempotent**: self-delivery and overlapping events are normal. Simple deletes are naturally idempotent; anything with side effects needs care.

---

## Pattern: Two-Tier Caching — Memory L1 in Front of Redis L2

Use this pattern when reads are hot and even a single Redis round-trip per read is the dominant cost. A per-process `MemoryCacheProvider` (L1) absorbs the hottest reads with zero network traffic; a shared `RedisCacheProvider` (L2) keeps the fleet coherent and shields the database; pub/sub evicts remote L1 copies after writes. All three providers come from this package and compose through `getOrSet()` and pattern subscriptions.

### Implementation

```typescript
import {
    MemoryCacheProvider,
    RedisCacheProvider,
    RedisPubSubProvider,
    type CacheProvider,
    type PubSubProvider,
} from 'blendsdk/webafx-cache';

interface Product {
    id: number;
    name: string;
    price: number;
}

/** Payload published on `cache:invalidate:*` channels. */
interface CacheInvalidation {
    keys: string[];
}

/** L1 entries are intentionally short-lived — see caveats. */
const L1_TTL_SECONDS = 5;

/** L2 is the cross-instance tier: longer TTL, shared by every instance. */
const L2_TTL_SECONDS = 300;

// ---------------------------------------------------------------------------
// Stand-ins for the real database layer
// ---------------------------------------------------------------------------

const database = new Map<number, Product>();

async function loadFromDatabase(id: number): Promise<Product> {
    const product = database.get(id);
    if (!product) {
        throw new Error(`Product ${id} not found`);
    }
    return product;
}

async function persistToDatabase(product: Product): Promise<void> {
    database.set(product.id, product);
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class ProductRepository {
    constructor(
        private readonly l1: CacheProvider,
        private readonly l2: CacheProvider,
        private readonly pubsub: PubSubProvider
    ) {}

    /**
     * Subscribe to invalidation events. Call once at startup, on every instance.
     */
    async start(): Promise<void> {
        await this.pubsub.psubscribe<CacheInvalidation>('cache:invalidate:*', async (message) => {
            // L2 is already fresh (write-through) — only this instance's L1 is stale.
            for (const key of message.data.keys) {
                await this.l1.delete(key);
            }
        });
    }

    /**
     * L1 → L2 → database. A miss in a tier backfills that tier through getOrSet().
     */
    async getProduct(id: number): Promise<Product> {
        const key = `product:${id}`;

        const product = await this.l1.getOrSet<Product>(
            key,
            () => this.l2.getOrSet<Product>(key, () => loadFromDatabase(id), L2_TTL_SECONDS),
            L1_TTL_SECONDS
        );

        return product;
    }

    /**
     * Write-through update: refresh the shared tier, purge this instance's L1,
     * then broadcast so every other instance purges its own L1.
     */
    async updateProduct(product: Product): Promise<void> {
        const key = `product:${product.id}`;

        await persistToDatabase(product);
        await this.l2.set(key, product, L2_TTL_SECONDS);  // shared tier is now fresh
        await this.l1.delete(key);                        // this instance is now fresh
        await this.pubsub.publish<CacheInvalidation>('cache:invalidate:product', { keys: [key] });
    }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export async function createProductRepository(): Promise<ProductRepository> {
    const l1 = new MemoryCacheProvider({
        rootKey: 'CatalogL1',
        cleanupIntervalMs: 5_000,
    });

    const l2 = new RedisCacheProvider({
        rootKey: 'CatalogL2',
        url: process.env.REDIS_URL,
        defaultTTL: L2_TTL_SECONDS,
    });

    const pubsub = new RedisPubSubProvider({
        channelPrefix: 'Catalog',
        url: process.env.REDIS_URL,
    });

    const repository = new ProductRepository(l1, l2, pubsub);
    await repository.start();
    return repository;
}
```

Observed behavior of the three call paths:

```typescript fragment
const repository = await createProductRepository();

const product = await repository.getProduct(42); // L1 miss → L2 miss → database
const again = await repository.getProduct(42);   // L1 hit — no network involved

await repository.updateProduct({ id: 42, name: 'Renamed', price: 24.99 });
// L2 refreshed · this instance's L1 purged · every other instance purges on the event
```

In a WebAFX application, pass the same `l1`, `l2`, and `pubsub` instances to `createCachePlugin()` / `createPubSubPlugin()` so their `health()` checks and `shutdown()` hooks join the app lifecycle.

| Tier | Provider | Scope | TTL in example | Read cost |
|------|----------|-------|----------------|-----------|
| L1 | `MemoryCacheProvider` | One process | 5 seconds | In-process `Map` lookup |
| L2 | `RedisCacheProvider` | All instances | 300 seconds | One Redis round-trip |

### Why it works

- **Most reads never touch the network**: the hot working set lives in-process, so per-instance read latency is a plain map lookup.
- **L2 keeps the fleet coherent and shields the database**: an L1 miss usually costs one Redis read, not a database query.
- **L1 is disposable**: losing it (restart, redeploy) costs nothing — it refills from L2.
- **`getOrSet()` nesting backfills each tier automatically** on a miss, with no extra bookkeeping code: the outer call populates L1 with whatever the inner call returned (L2 hit or database load).

### Caveats and performance

- **L1 has no eviction policy beyond expiry**: `MemoryCacheProvider` reclaims only expired entries (lazy eviction + periodic cleanup) — there is no LRU or size cap. Keep L1 TTLs short and the L1 keyspace bounded to genuinely hot entities.
- **Consistency window = invalidation latency, bounded by `L1_TTL_SECONDS`** whenever an event is missed (pub/sub is fire-and-forget). That bound is exactly why L1 TTLs must stay small — it is the design's safety net.
- **L1 must be a `MemoryCacheProvider`** — putting a Redis-backed provider in the L1 slot defeats the purpose (same network cost, double configuration).
- **Write-through vs delete-through for L2**: `updateProduct()` refreshes L2 immediately. If updates can also originate outside this service (direct SQL, sibling services), delete L2 in the invalidation path instead and accept one refill.
- **Memory budget**: every instance holds its own L1 copy — size TTLs against the number of hot keys per process, not per fleet.

---

## Pattern: Graceful Degradation for Cache Failures

Use this pattern on request paths where the cache is an optimization and the database (or upstream service) is the source of truth. A cache outage should degrade to uncached reads — not turn every request into a 500. The provider API makes the distinction possible: cache failures are caught and reported, loader failures keep propagating.

### Implementation

Consider the naive version first:

```typescript fragment
// Before — when Redis is down, this line rejects and the request fails,
// even though the database is perfectly healthy.
const profile = await cache.getOrSet(`profile:${id}`, () => queryUserProfile(id));

// After — the same outage degrades to uncached reads.
const profile = await getWithCache<UserProfile>(cache, `profile:${id}`, () => queryUserProfile(id));
```

The helper behind it:

```typescript
import { RedisCacheProvider, type CacheProvider } from 'blendsdk/webafx-cache';

interface UserProfile {
    id: number;
    displayName: string;
    email: string;
}

/** Stand-in for the authoritative database query. */
async function queryUserProfile(id: number): Promise<UserProfile> {
    return {
        id,
        displayName: `user-${id}`,
        email: `user-${id}@example.com`,
    };
}

function reportCacheFailure(operation: string, key: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    // Replace with the application logger in production.
    console.warn(`[cache] ${operation} failed for "${key}": ${message}`);
}

/**
 * Cache-aside that treats the cache as an optimization, not a dependency:
 * - a failing cache READ falls through to the loader (the source of truth);
 * - a failing cache WRITE is swallowed — the loaded value is still returned;
 * - loader errors propagate untouched, so real data-layer failures are never masked.
 */
async function getWithCache<T>(
    cache: CacheProvider,
    key: string,
    loader: () => Promise<T>,
    ttlSeconds?: number
): Promise<T> {
    let cached: T | undefined;

    try {
        cached = await cache.get<T>(key);
    } catch (error) {
        reportCacheFailure('read', key, error);
    }

    if (cached !== undefined) {
        return cached;
    }

    const value = await loader();

    try {
        await cache.set(key, value, ttlSeconds);
    } catch (error) {
        reportCacheFailure('write', key, error);
    }

    return value;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export async function getUserProfile(cache: CacheProvider, id: number): Promise<UserProfile> {
    const profile = await getWithCache<UserProfile>(
        cache,
        `profile:${id}`,
        () => queryUserProfile(id),
        300
    );
    return profile;
}

const cache = new RedisCacheProvider({
    rootKey: 'MyApp',
    url: process.env.REDIS_URL,
    defaultTTL: 300,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
});

const profile = await getUserProfile(cache, 7);
console.log(profile.displayName);

// Standalone applications must close connections themselves — the WebAFX
// plugins wire shutdown() and health() into the application automatically.
await cache.shutdown();
```

Standalone services should also expose the degradation on their readiness endpoint:

```typescript fragment
// Healthy cache → full-speed path. Unhealthy cache → degraded, requests still
// served, every read falls through to the database.
const cacheIsHealthy = await cache.health();
```

### Why it works

- **The failure mode it prevents is common**: Redis blips, and every request 500s because `getOrSet()` rejected — even though the database is fine. This pattern inverts the dependency: the cache accelerates but never blocks.
- **It deliberately does not wrap `getOrSet()`**: a blanket `try/catch` around `getOrSet()` cannot distinguish a cache failure from a loader failure — see the first caveat below. The helper separates the two paths explicitly.
- **It is still cache-aside**: on a healthy cache the behavior is identical to `getOrSet()` — read, miss, load, store, return.

### Caveats and performance

- **Why not `try { return await cache.getOrSet(...) } catch { return loader(); }`**: if the *loader* (not the cache) throws, that catch swallows the real error and runs the loader a second time; if only the cache *write* failed after the loader succeeded, the loader also runs twice. The helper above keeps loader execution single-shot and loader errors propagating.
- **A dead cache means completely uncached traffic**: protect the database with rate limiting or backpressure, or fall back to a standby `MemoryCacheProvider` for short-TTL local deduplication while Redis recovers.
- **Surface the degradation**: log with context (as above) and reflect `health()` on the readiness endpoint — silent fallbacks hide incidents.
- **Fail fast**: choose `maxRetriesPerRequest` / `connectTimeout` so `get` rejects quickly instead of queuing behind a reconnecting client. The provider defaults are 3 retries and a 5000 ms connect timeout; latency-sensitive paths should lower them (as shown).
- **When the cache *is* a hard dependency** (e.g. a session store), this pattern is wrong — use plain `getOrSet()` and let failures propagate to your normal error handling.

---

## Pattern: Named Multi-Service Registration

Use this pattern when a single application has several independent caching or messaging concerns that must not share keyspaces, TTL policies, health reporting, or blast radius. Each concern gets its own provider instance, `rootKey`, and `serviceName`; the plugin factories register them as distinct application-wide services.

### Implementation

```typescript
import type { PluginDefinition } from 'blendsdk/webafx';
import {
    memoryCachePlugin,
    redisCachePlugin,
    redisPubSubPlugin,
} from 'blendsdk/webafx-cache';

/** Minimal structural view of the WebAFX application. */
interface App {
    use(plugin: PluginDefinition): void;
}

export function registerApplicationServices(app: App): void {
    // Sessions: long TTLs, high churn, its own Redis instance.
    app.use(redisCachePlugin({
        rootKey: 'Sessions',
        serviceName: 'session-cache',
        url: process.env.SESSION_REDIS_URL,
        defaultTTL: 3600,
    }));

    // Product catalog: shorter TTLs, bulk-invalidated as a unit.
    app.use(redisCachePlugin({
        rootKey: 'Catalog',
        serviceName: 'catalog-cache',
        url: process.env.CATALOG_REDIS_URL,
        defaultTTL: 300,
    }));

    // Per-instance values (feature flags, computed config): no network hop,
    // never shared between instances, recreated on restart.
    app.use(memoryCachePlugin({
        rootKey: 'Local',
        serviceName: 'local-cache',
        defaultTTL: 30,
    }));

    // Domain events: one namespaced channel prefix on the catalog Redis.
    app.use(redisPubSubPlugin({
        channelPrefix: 'CatalogEvents',
        serviceName: 'events',
        url: process.env.CATALOG_REDIS_URL,
    }));
}
```

| Service name | Factory | Backend | Namespace | TTL |
|--------------|---------|---------|-----------|-----|
| `session-cache` | `redisCachePlugin` | Redis | keys `Sessions:*` | 3600 s |
| `catalog-cache` | `redisCachePlugin` | Redis | keys `Catalog:*` | 300 s |
| `local-cache` | `memoryCachePlugin` | Memory | keys `Local:*` | 30 s |
| `events` | `redisPubSubPlugin` | Redis | channels `CatalogEvents:*` | — |

The cache one-liners take no options. When you need a custom plugin priority, construct the provider and use the generic builder:

```typescript fragment
import { createCachePlugin, RedisCacheProvider } from 'blendsdk/webafx-cache';

const auditCache = new RedisCacheProvider({
    rootKey: 'Audit',
    serviceName: 'audit-cache',
    url: process.env.CATALOG_REDIS_URL,
});

app.use(createCachePlugin(auditCache, { priority: 50 }));
```

### Why it works

- **Independent blast radius**: every namespace is isolated — `clear()` or `deletePattern()` on the catalog cache cannot touch sessions, even when both live on the same Redis server. That is the difference between separate providers and one shared provider with ad-hoc key conventions.
- **Independent policies**: TTLs, backends, and Redis URLs are chosen per concern — sessions on a dedicated Redis, feature flags in-process.
- **Independent operations**: each service name reports `health()` separately, so a session-store outage does not mark the entire application unhealthy.
- **Discoverability**: application code resolves services by name from the WebAFX container rather than importing singletons across module boundaries.

### Caveats and performance

- **`serviceName` must be unique per provider**: the defaults (`cache`, `pubsub`) collide when you register more than one of the same kind — always set distinct names.
- **Connection budget**: every Redis provider owns its own connection(s) — one per cache, two per pub/sub (a dedicated publisher and a dedicated subscriber, as Redis requires). The example above opens four Redis connections (session ×1 + catalog ×1 + events ×2). Consolidate URLs where physical isolation isn't required.
- **Don't over-fragment**: a handful of concerns per app is healthy; a dozen providers is usually a symptom of missing key conventions. Distinct `rootKey`s on one Redis give the same logical isolation with fewer connections.
- **Priority**: all plugins default to priority 30. Override with `createCachePlugin(provider, { priority })` or `createPubSubPlugin(provider, { priority })` — the pub/sub one-liners accept options as their second argument, the cache one-liners do not.

---

## Pattern: Environment-Portable Backends and the Redis-Free Memory Subpath

Use this pattern to run the same application code in development, test, and production while swapping backends per environment — and to keep tests free of Redis, Docker, and `ioredis`. `createCache()` / `createPubSub()` build the right provider from a config object; `blendsdk/webafx-cache/memory` provides the same providers without ever loading the Redis client.

### Implementation

```typescript
// src/config/services.ts — the only place in the application that knows environments.
import type { PluginDefinition } from 'blendsdk/webafx';
import {
    createCache,
    createCachePlugin,
    createPubSub,
    createPubSubPlugin,
    type CacheFactoryConfig,
    type PubSubFactoryConfig,
} from 'blendsdk/webafx-cache';

/** Minimal structural view of the WebAFX application. */
interface App {
    use(plugin: PluginDefinition): void;
}

const isProduction = process.env.NODE_ENV === 'production';

function buildCacheConfig(): CacheFactoryConfig {
    if (isProduction) {
        return {
            type: 'redis',
            rootKey: 'MyApp',
            defaultTTL: 300,
            url: process.env.REDIS_URL,
        };
    }

    return {
        type: 'memory',
        rootKey: 'MyApp',
        defaultTTL: 300,
        cleanupIntervalMs: 30_000,
    };
}

function buildPubSubConfig(): PubSubFactoryConfig {
    return {
        type: isProduction ? 'redis' : 'memory',
        channelPrefix: 'MyApp',
        serviceName: 'events',
        url: process.env.REDIS_URL,
    };
}

export function registerServices(app: App): void {
    app.use(createCachePlugin(createCache(buildCacheConfig())));
    app.use(createPubSubPlugin(createPubSub(buildPubSubConfig())));
}
```

Before and after — what the factory replaces:

```typescript fragment
// Before — environment branching at construction sites, and a hard dependency
// on the Redis classes everywhere the app is set up or tested.
import { MemoryCacheProvider, RedisCacheProvider, type CacheProvider } from 'blendsdk/webafx-cache';

const cache: CacheProvider = process.env.NODE_ENV === 'production'
    ? new RedisCacheProvider({ rootKey: 'MyApp', url: process.env.REDIS_URL })
    : new MemoryCacheProvider({ rootKey: 'MyApp' });
```

```typescript fragment
// After — one factory call; the environment lives in the config.
app.use(createCachePlugin(createCache(buildCacheConfig())));
```

Tests import from the `/memory` subpath, so `ioredis` never enters the process:

```typescript
// tests/checkout.test.ts — the /memory subpath never evaluates ioredis.
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { MemoryCacheProvider, type CacheProvider } from 'blendsdk/webafx-cache/memory';

describe('checkout total caching', () => {
    let cache: CacheProvider;

    beforeEach(() => {
        cache = new MemoryCacheProvider({ rootKey: 'CheckoutTests', cleanupIntervalMs: 0 });
    });

    afterEach(async () => {
        await cache.clear();
        await cache.shutdown();
    });

    it('computes a cart total once and reuses it', async () => {
        let computations = 0;

        const computeTotal = async (): Promise<number> => {
            computations += 1;
            return 49.95;
        };

        const first = await cache.getOrSet<number>('cart:user-1', computeTotal, 60);
        const second = await cache.getOrSet<number>('cart:user-1', computeTotal, 60);

        expect(first).toBe(49.95);
        expect(second).toBe(49.95);
        expect(computations).toBe(1);
    });
});
```

| Environment | Cache | Pub/sub | `ioredis` loaded |
|-------------|-------|---------|------------------|
| Development | `MemoryCacheProvider` | `MemoryPubSubProvider` | Only via the main entry |
| Test (Vitest) | memory via `/memory` subpath | memory via `/memory` subpath | Never |
| Production | `RedisCacheProvider` | `RedisPubSubProvider` | Yes |

### Why it works

- **One decision point**: swapping backends is a config change — no other module branches on the environment.
- **Contract-tested parity**: the memory and Redis providers behave identically per the package's contract suites, so development and tests exercise the same call graph production uses; only the backing store differs.
- **Hermetic tests**: importing `/memory` never evaluates `ioredis` (the package's own specification tests assert this), so there are no connection attempts, no Docker requirement, and no lingering sockets or timers — `cleanupIntervalMs: 0` disables the memory provider's cleanup timer entirely.

### Caveats and performance

- **Bootstrap-time decision**: providers are application-wide singletons — decide the backend at startup, never per request.
- **Memory backend semantics in production**: state is per-process, lost on restart, and never shared across instances; it is only appropriate for single-instance deployments.
- **`createCache()` throws on unknown `type`** with a message listing the supported values — fail fast at startup when the type comes from an environment variable.
- **Redis providers connect eagerly**: constructing one (directly or through a factory) starts a background connection and reconnection timers. In tests, build providers through the `/memory` subpath to keep `ioredis` out of the process entirely.
- **The factory configs don't expose every connection knob**: `CacheFactoryConfig` / `PubSubFactoryConfig` carry `host`, `port`, `password`, `db`, and `url`, but not `connectTimeout` or `maxRetriesPerRequest` — construct `RedisCacheProvider` / `RedisPubSubProvider` directly when you need those (see the graceful degradation pattern above).

---

## Pattern: Declarative Subscriptions at Plugin Install Time

Use this pattern to register every application-level subscription in one place, at startup, instead of scattering `subscribe()` calls across modules. `createPubSubPlugin()` accepts a `subscriptions` list, and the plugin registers each entry — in order — while its factory executes during startup, before the application begins serving requests.

### Implementation

```typescript
import type { PluginDefinition } from 'blendsdk/webafx';
import { redisPubSubPlugin, type PubSubMessage } from 'blendsdk/webafx-cache';

/** Minimal structural view of the WebAFX application. */
interface App {
    use(plugin: PluginDefinition): void;
}

interface OrderCreated {
    orderId: number;
    customerId: number;
    total: number;
}

interface AuditEvent {
    actor: string;
    action: string;
    occurredAt: string;
}

// ---------------------------------------------------------------------------
// Handlers — plain functions with typed envelopes, unit-testable in isolation
// ---------------------------------------------------------------------------

async function projectOrderCreated(message: PubSubMessage<OrderCreated>): Promise<void> {
    const { orderId, customerId, total } = message.data;
    // Stand-in for the real projection write.
    console.log(`[projection] order ${orderId} for customer ${customerId} — total ${total}`);
}

async function persistAuditEvent(message: PubSubMessage<AuditEvent>): Promise<void> {
    const { actor, action, occurredAt } = message.data;
    console.log(`[audit] ${actor} performed ${action} at ${occurredAt} (channel: ${message.channel})`);
}

// ---------------------------------------------------------------------------
// Wiring — all subscriptions in one place, registered during plugin install
// ---------------------------------------------------------------------------

export function registerEventHandlers(app: App): void {
    app.use(redisPubSubPlugin(
        {
            channelPrefix: 'MyApp',
            serviceName: 'events',
            url: process.env.REDIS_URL,
        },
        {
            subscriptions: [
                { channel: 'order:created', handler: projectOrderCreated },
                { pattern: 'audit:*', handler: persistAuditEvent },
            ],
        }
    ));
}
```

The same declarative list works on the memory backend — used by tests and single-instance deployments, with identical user-facing behavior:

```typescript fragment
app.use(memoryPubSubPlugin(
    { channelPrefix: 'MyApp' },
    {
        subscriptions: [
            { channel: 'order:created', handler: projectOrderCreated },
            { pattern: 'audit:*', handler: persistAuditEvent },
        ],
    }
));
```

### Why it works

- **One wiring point**: every subscription the app depends on is declared where the plugin is installed — no hunting for `subscribe()` calls buried in module side effects.
- **Live before traffic**: the plugin factory runs during startup and registers the entries in order, so subscriptions are active by the time requests are served.
- **Reuses the full pub/sub feature set**: channel prefixing, glob patterns (`*` matches any sequence, `?` matches one character), typed envelopes (`PubSubMessage<T>` with `pattern` set for pattern matches), and handler error isolation — each entry is invoked through `safeInvoke`, which catches and logs errors with the channel name without affecting other handlers or the subscriber connection.
- **Handlers are ordinary functions**: test them by calling them directly with a fabricated `PubSubMessage<T>` — no broker required.

### Caveats and performance

- **Exactly one of `channel` / `pattern` per entry**: when both are set, the `channel` branch wins; when neither is set, the entry is silently skipped.
- **At-most-once semantics**: published messages are not persisted or replayed; a handler that must not lose events should enqueue durable work (a database write or queue) as its first action.
- **Handler failures are isolated, not retried**: `safeInvoke` catches the error, logs it, and moves on. Make handlers idempotent and observable, and put retry logic inside the handler when required.
- **Publishers receive their own messages** when the same process is subscribed to the channel or pattern — fine for projections and audit logs, but guard handlers that must not react to their own events (or simply make them idempotent).
- **Wiring is fixed at install time**: the declarative list is static. Topics discovered at runtime can still be added through the provider itself (`pubsub.subscribe(...)` / `pubsub.psubscribe(...)`) after registration.
- **Priority**: `PubSubPluginOptions.priority` (default 30) controls install ordering relative to other plugins when startup order matters.

---

# webafx-cache Common Scenarios

This document collects common "How do I..." solutions for `blendsdk/webafx-cache`. Unless noted otherwise, examples use the in-memory backend and are complete, runnable ESM programs (top-level `await`, strict TypeScript). Redis examples assume a server reachable at `redis://localhost:6379`.

---

## How do I store and retrieve a typed value in the cache?

**Solution** — Use `set()` with any JSON-serializable value and `get<T>()` with the expected type. Values are JSON-serialized on write, so reads return a fresh deep copy rather than a shared reference.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

interface UserProfile {
    id: number;
    name: string;
    roles: string[];
}

const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });

const profile: UserProfile = {
    id: 123,
    name: 'Alice',
    roles: ['admin', 'editor'],
};

await cache.set('user:123', profile);

const cached = await cache.get<UserProfile>('user:123');
console.log(cached?.name); // 'Alice'

// Values are JSON-serialized — the cache holds a deep copy, not a reference
profile.name = 'Changed after caching';
const untouched = await cache.get<UserProfile>('user:123');
console.log(untouched?.name); // 'Alice'

await cache.shutdown();
```

---

## How do I cache the result of an expensive operation?

**Solution** — Use `getOrSet()` (the cache-aside pattern). On a cache miss it calls your async factory, stores the result with the given TTL, and returns it; on a hit the factory is never invoked.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

interface Product {
    id: number;
    name: string;
    price: number;
}

const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });

let databaseCalls = 0;

async function loadProductFromDatabase(id: number): Promise<Product> {
    databaseCalls += 1;
    return { id, name: `Product ${id}`, price: 49.99 };
}

async function getProduct(id: number): Promise<Product> {
    return cache.getOrSet<Product>(
        `product:${id}`,
        () => loadProductFromDatabase(id),
        300 // cache for 5 minutes
    );
}

const first = await getProduct(1);
const second = await getProduct(1);

console.log(first.name);    // 'Product 1'
console.log(second.price);  // 49.99
console.log(databaseCalls); // 1 — the second call was served from the cache
console.log(await cache.ttl('product:1')); // ~300

await cache.shutdown();
```

---

## How do I control how long cache entries live?

**Solution** — TTLs are in seconds. Set a `defaultTTL` at construction, override it per `set()` call, and pass `0` to opt out of expiry entirely for a specific entry.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({
    rootKey: 'MyApp',
    defaultTTL: 60, // applied to every entry unless overridden
});

await cache.set('uses-default', { data: 1 });   // expires after 60 seconds
await cache.set('short-lived', { data: 2 }, 5); // expires after 5 seconds
await cache.set('permanent', { data: 3 }, 0);   // TTL 0 = never expires

console.log(await cache.ttl('uses-default')); // ~60
console.log(await cache.ttl('short-lived'));  // ~5
console.log(await cache.ttl('permanent'));    // -1 (no expiry)

await cache.shutdown();
```

---

## How do I check for, inspect, and delete cache entries?

**Solution** — `exists()` tells you whether a key is present, `delete()` removes it (returning `true` only when a key was actually removed), and `ttl()` reports the remaining lifetime using Redis conventions: positive seconds, `-1` for no expiry, `-2` for a missing key.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });

await cache.set('session:abc', { userId: 42 }, 60);

console.log(await cache.exists('session:abc')); // true
console.log(await cache.ttl('session:abc'));    // ~60

const wasDeleted = await cache.delete('session:abc');
console.log(wasDeleted);                        // true
console.log(await cache.exists('session:abc')); // false
console.log(await cache.ttl('session:abc'));    // -2 (key does not exist)

await cache.set('persistent', 'value');
console.log(await cache.ttl('persistent'));     // -1 (exists, but no expiry)

await cache.shutdown();
```

---

## How do I extend or shorten the TTL of an already-cached entry?

**Solution** — Use `expire(key, ttlSeconds)` to reset a key's TTL without touching its value. It returns `true` when the key existed and the TTL was updated, `false` otherwise.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });

// A session starts with a short TTL
await cache.set('session:abc', { userId: 42 }, 60);

// The user interacts — extend the session to one hour
console.log(await cache.expire('session:abc', 3600)); // true
console.log(await cache.ttl('session:abc'));          // ~3600

// Or shorten it — e.g. to force re-authentication soon
console.log(await cache.expire('session:abc', 30));   // true
console.log(await cache.ttl('session:abc'));          // ~30

// expire() returns false when the key does not exist
await cache.delete('session:abc');
console.log(await cache.expire('session:abc', 60));   // false

await cache.shutdown();
```

---

## How do I invalidate every cache entry matching a pattern?

**Solution** — Use `deletePattern()` with a glob pattern (`*` matches any sequence of characters, including in the middle of a pattern). It returns the number of keys deleted and only ever touches keys inside the provider's own `rootKey` namespace.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });

await cache.set('user:1:profile', { name: 'Alice' });
await cache.set('user:1:sessions', ['session-a', 'session-b']);
await cache.set('user:2:profile', { name: 'Bob' });

// Invalidate everything cached for user 1
console.log(await cache.deletePattern('user:1:*')); // 2
console.log(await cache.exists('user:2:profile'));  // true — untouched

// The * wildcard also works in the middle of a pattern
await cache.set('api:users:active', 10);
await cache.set('api:products:active', 7);
await cache.set('api:users:inactive', 3);
console.log(await cache.deletePattern('api:*:active')); // 2
console.log(await cache.exists('api:users:inactive'));  // true

await cache.shutdown();
```

---

## How do I clear my application's cache without touching other applications?

**Solution** — Every provider prefixes its keys with its `rootKey`, and `clear()` only removes keys under that prefix (on Redis via non-blocking `SCAN` + batched `DEL` — never `KEYS`, never `FLUSHDB`). This makes one shared Redis instance safe for multiple applications.

```typescript
import { RedisCacheProvider } from 'blendsdk/webafx-cache';

// Two applications sharing one Redis instance, isolated by their rootKey
const shopCache = new RedisCacheProvider({
    rootKey: 'Shop',
    url: 'redis://localhost:6379',
});

const blogCache = new RedisCacheProvider({
    rootKey: 'Blog',
    url: 'redis://localhost:6379',
});

await shopCache.set('product:1', { name: 'Widget' });
await blogCache.set('post:1', { title: 'Hello world' });

// The shop app redeploys — clear only the Shop namespace
await shopCache.clear();

console.log(await shopCache.exists('product:1')); // false — Shop keys are gone
console.log(await blogCache.exists('post:1'));    // true — Blog data is untouched

await shopCache.shutdown();
await blogCache.shutdown();
```

---

## How do I run two independent caches in the same application?

**Solution** — Give each cache its own `rootKey` (namespace isolation) and `serviceName` (distinct container registration). Each provider keeps its own `defaultTTL` and configuration.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

// Two caches with separate namespaces, service names, and default TTLs
const sessionCache = new MemoryCacheProvider({
    rootKey: 'Sessions',
    serviceName: 'session-cache',
    defaultTTL: 3600,
});

const productCache = new MemoryCacheProvider({
    rootKey: 'Products',
    serviceName: 'product-cache',
    defaultTTL: 300,
});

await sessionCache.set('abc', { userId: 42 });
await productCache.set('1', { name: 'Widget' });

console.log(sessionCache.serviceName); // 'session-cache'
console.log(productCache.serviceName); // 'product-cache'

// Each provider applies its own defaultTTL
console.log(await sessionCache.ttl('abc')); // ~3600
console.log(await productCache.ttl('1'));   // ~300

// Keys are namespaced per provider — 'Sessions:abc' vs 'Products:1'
console.log(await productCache.get('abc')); // undefined

await sessionCache.shutdown();
await productCache.shutdown();
```

In a WebAFX application, register both providers as separate plugins — the service container resolves each by its own `serviceName`:

```typescript fragment
app.use(createCachePlugin(sessionCache)); // registers service 'session-cache'
app.use(createCachePlugin(productCache)); // registers service 'product-cache'
```

---

## How do I switch between the memory and Redis backends based on the environment?

**Solution** — Use `createCache()` with a `type: 'redis' | 'memory'` discriminator. Redis-only fields are ignored by the memory backend, so a single configuration object works for both; an unsupported `type` throws a descriptive `Unknown cache type: "..."` error.

```typescript
import { createCache } from 'blendsdk/webafx-cache';
import type { CacheProvider } from 'blendsdk/webafx-cache';

const isProduction = process.env.NODE_ENV === 'production';

// One configuration object; the 'type' field selects the backend
const cache: CacheProvider = createCache({
    type: isProduction ? 'redis' : 'memory',
    rootKey: 'MyApp',
    defaultTTL: 300,
    // Redis-only fields are simply ignored by the memory backend
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
});

await cache.set('feature-flags', { newCheckout: true });
const flags = await cache.get<{ newCheckout: boolean }>('feature-flags');

console.log(flags?.newCheckout); // true

await cache.shutdown();
```

---

## How do I configure the Redis connection (URL, host/port, password, database)?

**Solution** — Pass either a connection `url` or individual `host`/`port`/`password`/`db` fields. When both are present, `url` takes precedence over the individual fields.

```typescript
import { RedisCacheProvider } from 'blendsdk/webafx-cache';

// A single connection URL — convenient for environment variables
const cache = new RedisCacheProvider({
    rootKey: 'MyApp',
    url: process.env.REDIS_URL ?? 'redis://localhost:6379/0',
    connectTimeout: 5000,
    maxRetriesPerRequest: 3,
});

await cache.set('greeting', 'hello');
console.log(await cache.get<string>('greeting')); // 'hello'

// health() sends a PING and returns false on any connection failure
console.log(await cache.health()); // true

await cache.clear();
await cache.shutdown();
```

Equivalent configuration using individual connection fields:

```typescript fragment
const cache = new RedisCacheProvider({
    rootKey: 'MyApp',
    host: 'localhost',
    port: 6379,
    password: process.env.REDIS_PASSWORD,
    db: 2,
});
```

---

## How do I publish and subscribe to typed messages?

**Solution** — Use `subscribe<T>()` with a `MessageHandler<T>` and `publish<T>()` with the payload. Multiple handlers per channel are supported (fan-out), and `publish()` resolves with the number of handlers that received the message.

```typescript
import { MemoryPubSubProvider } from 'blendsdk/webafx-cache';
import type { PubSubMessage } from 'blendsdk/webafx-cache';

interface OrderCreated {
    orderId: number;
    total: number;
}

const pubsub = new MemoryPubSubProvider({ channelPrefix: 'MyApp' });

// Two independent handlers receive every message on the channel (fan-out)
await pubsub.subscribe<OrderCreated>('order:created', (message: PubSubMessage<OrderCreated>) => {
    console.log(`Order ${message.data.orderId}: ${message.data.total}`);
});

await pubsub.subscribe<OrderCreated>('order:created', (message) => {
    console.log(`[audit] order ${message.data.orderId} recorded`);
});

// publish() returns how many handlers received the message
const receivers = await pubsub.publish<OrderCreated>('order:created', {
    orderId: 123,
    total: 49.99,
});
console.log(receivers); // 2

// Give asynchronous handlers a moment before shutting down
await new Promise((resolve) => setTimeout(resolve, 10));

await pubsub.shutdown();
```

Swap `MemoryPubSubProvider` for `RedisPubSubProvider` to deliver messages across processes and machines with the exact same API.

---

## How do I subscribe to a whole family of channels with a wildcard?

**Solution** — Use `psubscribe()` with a glob pattern (`*` matches any sequence, `?` matches exactly one character). Pattern-delivered messages include a `pattern` field in the envelope alongside the real `channel` name.

```typescript
import { MemoryPubSubProvider } from 'blendsdk/webafx-cache';
import type { PubSubMessage } from 'blendsdk/webafx-cache';

interface AuditEvent {
    userId: number;
    action: string;
}

const pubsub = new MemoryPubSubProvider({ channelPrefix: 'MyApp' });

const auditLog: string[] = [];

await pubsub.psubscribe<AuditEvent>('audit:*', (message: PubSubMessage<AuditEvent>) => {
    auditLog.push(`${message.channel}: ${message.data.action} (pattern ${message.pattern})`);
});

await pubsub.publish<AuditEvent>('audit:login', { userId: 42, action: 'login' });
await pubsub.publish<AuditEvent>('audit:logout', { userId: 42, action: 'logout' });
await pubsub.publish('order:created', { orderId: 1 }); // does not match 'audit:*'

await new Promise((resolve) => setTimeout(resolve, 10));

console.log(auditLog);
// ['audit:login: login (pattern audit:*)', 'audit:logout: logout (pattern audit:*)']

await pubsub.punsubscribe('audit:*');

await pubsub.shutdown();
```

---

## How do I keep pub/sub channels isolated between applications?

**Solution** — Set a distinct `channelPrefix` per application. The prefix is applied automatically on publish and subscribe and stripped before handlers run, so your code always sees plain channel names — two applications sharing one Redis instance never see each other's messages.

```typescript
import { RedisPubSubProvider } from 'blendsdk/webafx-cache';

// Two applications sharing one Redis instance, isolated by channelPrefix
const appA = new RedisPubSubProvider({
    channelPrefix: 'AppA',
    url: 'redis://localhost:6379',
});

const appB = new RedisPubSubProvider({
    channelPrefix: 'AppB',
    url: 'redis://localhost:6379',
});

await appB.subscribe<{ orderId: number }>('order:created', (message) => {
    console.log(`AppB received on "${message.channel}": order ${message.data.orderId}`);
});

// Allow the Redis SUBSCRIBE to reach the server
await new Promise((resolve) => setTimeout(resolve, 100));

// AppA's event lands on the channel "AppA:order:created" — AppB never receives it
await appA.publish('order:created', { orderId: 1 });

// AppB's own event lands on "AppB:order:created" and is delivered
await appB.publish('order:created', { orderId: 2 });

await new Promise((resolve) => setTimeout(resolve, 200));

// activeSubscriptions() and message envelopes use unprefixed, user-facing names
console.log(appB.activeSubscriptions());
// { channels: ['order:created'], patterns: [] }

await appA.shutdown();
await appB.shutdown();
```

---

## How do I stop one failing handler from breaking other subscribers?

**Solution** — You don't need to do anything: every handler invocation is wrapped in error isolation. A throwing (or rejecting) handler is caught and logged to `console.error`; other handlers on the channel and the subscriber connection are unaffected.

```typescript
import { MemoryPubSubProvider } from 'blendsdk/webafx-cache';

interface SystemEvent {
    type: string;
}

const pubsub = new MemoryPubSubProvider();

// A misbehaving handler...
await pubsub.subscribe<SystemEvent>('events', () => {
    throw new Error('downstream service unavailable');
});

// ...must never prevent other handlers from receiving the message
await pubsub.subscribe<SystemEvent>('events', (message) => {
    console.log('still delivered:', message.data.type);
});

const receivers = await pubsub.publish<SystemEvent>('events', { type: 'ping' });
console.log(receivers); // 2 — both handlers were invoked

await new Promise((resolve) => setTimeout(resolve, 10));

// Console output:
// [PubSub] Handler error on channel "events": downstream service unavailable
// still delivered: ping

await pubsub.shutdown();
```

---

## How do I register caching and pub/sub plugins in a WebAFX application?

**Solution** — Build a plugin (or use a one-liner factory that creates the provider for you), then install it with `app.use()`. Installation registers the provider as an application-wide singleton service, wires `health()` into the health endpoint and `shutdown()` into graceful teardown, and — for pub/sub — registers any declarative `subscriptions` from the options.

| Factory | Creates provider | Options |
|---------|------------------|---------|
| `createCachePlugin(provider, options?)` | No — you pass one | `priority` |
| `memoryCachePlugin(config)` | Yes (memory) | — |
| `redisCachePlugin(config)` | Yes (Redis) | — |
| `createPubSubPlugin(provider, options?)` | No — you pass one | `priority`, `subscriptions` |
| `memoryPubSubPlugin(config?, options?)` | Yes (memory) | `priority`, `subscriptions` |
| `redisPubSubPlugin(config, options?)` | Yes (Redis) | `priority`, `subscriptions` |

```typescript
import {
    createPubSubPlugin,
    memoryCachePlugin,
    MemoryPubSubProvider,
} from 'blendsdk/webafx-cache';
import type { MessageHandler, PubSubPluginOptions } from 'blendsdk/webafx-cache';

// Handlers registered declaratively receive the standard message envelope
const handleOrderCreated: MessageHandler = (message) => {
    console.log(`order created on channel "${message.channel}"`);
};

const handleAuditEvent: MessageHandler = (message) => {
    console.log(`audit event on "${message.channel}" (pattern: ${message.pattern})`);
};

// One-liner cache plugin — creates and manages its own provider
const cachePlugin = memoryCachePlugin({
    rootKey: 'MyApp',
    defaultTTL: 300,
});

// Pub/sub plugin built around an existing provider, with declarative subscriptions
const pubsubProvider = new MemoryPubSubProvider({ channelPrefix: 'MyApp' });

const pubsubOptions: PubSubPluginOptions = {
    priority: 30,
    subscriptions: [
        { channel: 'order:created', handler: handleOrderCreated },
        { pattern: 'audit:*', handler: handleAuditEvent },
    ],
};

const pubsubPlugin = createPubSubPlugin(pubsubProvider, pubsubOptions);

console.log(cachePlugin.name);      // 'cache'
console.log(cachePlugin.priority);  // 30
console.log(pubsubPlugin.name);     // 'pubsub'

await pubsubProvider.shutdown();
// Inside a WebAFX app the plugin's shutdown hook performs this during teardown.
```

Inside a WebAFX application, the built plugins install with a single call each:

```typescript fragment
app.use(cachePlugin);
app.use(pubsubPlugin);
```

Redis-backed variants follow the same shapes: `app.use(redisCachePlugin({ rootKey: 'MyApp', host: 'localhost', port: 6379 }))` and `app.use(redisPubSubPlugin({ host: 'localhost', channelPrefix: 'MyApp' }, { subscriptions: [...] }))`.

---

## How do I use the in-memory providers without loading `ioredis`?

**Solution** — Import from the `blendsdk/webafx-cache/memory` subpath. It exposes the memory providers and the Redis-free plugin builders, and never loads `ioredis` — ideal for tests, CI, and single-instance deployments.

| Export from `/memory` | Kind |
|-----------------------|------|
| `CacheProvider`, `PubSubProvider` | Abstract base classes |
| `MemoryCacheProvider`, `MemoryPubSubProvider` | In-memory providers |
| `createCachePlugin`, `createPubSubPlugin` | Generic plugin builders (no Redis) |
| `memoryCachePlugin`, `memoryPubSubPlugin` | Memory plugin one-liners |

```typescript
import {
    MemoryCacheProvider,
    memoryCachePlugin,
} from 'blendsdk/webafx-cache/memory';

// cleanupIntervalMs: 0 disables the periodic sweep — handy for tests
const cache = new MemoryCacheProvider({ rootKey: 'TestApp', cleanupIntervalMs: 0 });

await cache.set('config', { featureFlags: ['beta'] });
const config = await cache.get<{ featureFlags: string[] }>('config');

console.log(config?.featureFlags); // ['beta']

const plugin = memoryCachePlugin({ rootKey: 'TestApp' });
console.log(plugin.name); // 'cache'

await cache.shutdown();
```

Importing the main entry point, by contrast, evaluates the Redis provider modules (and therefore `ioredis`) at load time — choose `blendsdk/webafx-cache/memory` whenever Redis is not needed.

---

# webafx-cache Examples Library

This library collects complete, copy-paste ready examples for `blendsdk/webafx-cache`, organized by feature area. Every example is a self-contained ESM module with full imports — top-level `await` is used throughout, and expected output is shown as comments. Examples built on the in-memory backends run anywhere with zero infrastructure; examples using Redis assume a reachable server on `localhost:6379` (the package's own test suite runs Redis via Docker on port `6399`).

---

## Cache Fundamentals

Start here: the core caching API with the zero-dependency `MemoryCacheProvider`. The exact same API — same methods, same semantics — is provided by every backend, so these examples double as a tour of `RedisCacheProvider` as well.

### Creating a Cache and Storing Values

Create a cache with a `rootKey` namespace, store typed values, and read them back. Values are JSON-serialized on write, so cached data is always a safe snapshot with no shared references.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

interface User {
    id: number;
    name: string;
}

const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });

await cache.set<User>('user:123', { id: 123, name: 'Alice' });
await cache.set('counter', 42);
await cache.set('flags', ['beta', 'dark-mode']);

const user = await cache.get<User>('user:123');
console.log(user?.name); // 'Alice'

const counter = await cache.get<number>('counter');
console.log(counter); // 42

const flags = await cache.get<string[]>('flags');
console.log(flags); // [ 'beta', 'dark-mode' ]

// Stored values are snapshots — mutating the original has no effect
const session = { token: 'abc' };
await cache.set('session', session);
session.token = 'changed';
console.log(await cache.get<{ token: string }>('session')); // { token: 'abc' }

await cache.shutdown();
```

### The Cache-Aside Pattern with getOrSet()

`getOrSet()` returns the cached value when it exists and otherwise runs the factory function, caches the result with a TTL, and returns it. On a cache hit the factory is never invoked.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

interface User {
    id: number;
    name: string;
}

const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });

let databaseQueries = 0;

async function loadUserFromDatabase(id: number): Promise<User> {
    databaseQueries++; // stand-in for an expensive query
    return { id, name: 'Alice' };
}

// First call — cache miss: the factory runs and the result is cached for 300 seconds
const first = await cache.getOrSet<User>('user:123', () => loadUserFromDatabase(123), 300);

// Second call — cache hit: the factory is skipped entirely
const second = await cache.getOrSet<User>('user:123', () => loadUserFromDatabase(123), 300);

console.log(first.name);  // 'Alice'
console.log(second.name); // 'Alice'
console.log(databaseQueries); // 1 — the database was queried only once
console.log(await cache.ttl('user:123')); // 300

await cache.shutdown();
```

### Time-to-Live and Expiration

Every entry can carry a TTL in seconds. `ttl()` follows Redis conventions: a positive number is the remaining TTL, `-1` means the key exists with no expiry, and `-2` means the key does not exist.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });

// Store a verification code that expires in one second
await cache.set('code:8842', '123456', 1);

console.log(await cache.get<string>('code:8842')); // '123456'
console.log(await cache.ttl('code:8842')); // 1 — seconds remaining

// TTL conventions: -1 = exists with no expiry, -2 = does not exist
await cache.set('persistent', 'no-expiry');
console.log(await cache.ttl('persistent')); // -1
console.log(await cache.ttl('missing'));    // -2

// Give the one-second TTL time to lapse
await new Promise((resolve) => setTimeout(resolve, 1200));

console.log(await cache.get<string>('code:8842')); // undefined — expired
console.log(await cache.exists('code:8842'));      // false

await cache.shutdown();
```

---

## Cache Operations

The day-to-day operations: removing entries, adjusting TTLs after the fact, invalidating whole key groups, and clearing a namespace.

### Deleting Entries and Checking Existence

`delete()` reports whether the key existed (`true`/`false`), while `exists()` performs expiration-aware membership checks.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });

await cache.set('session:abc', { userId: 1 });

console.log(await cache.exists('session:abc')); // true
console.log(await cache.delete('session:abc')); // true — the key existed
console.log(await cache.delete('session:abc')); // false — already gone
console.log(await cache.exists('session:abc')); // false
console.log(await cache.get<string>('session:abc')); // undefined

await cache.shutdown();
```

### Extending or Shortening TTL with expire()

`expire()` updates the TTL of an existing key without touching its value — useful when an operation is still in progress. It returns `false` when the key does not exist (or has already expired).

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });

// A short-lived entry...
await cache.set('upload:token', 'token-value', 60);
console.log(await cache.ttl('upload:token')); // 60

// ...gets extended while the upload is still running
console.log(await cache.expire('upload:token', 600)); // true
console.log(await cache.ttl('upload:token')); // 600

// The same call can shorten a TTL
await cache.expire('upload:token', 30);
console.log(await cache.ttl('upload:token')); // 30

// Keys that do not exist cannot be updated
console.log(await cache.expire('missing', 60)); // false

await cache.shutdown();
```

### Invalidating Groups of Keys with deletePattern()

`deletePattern()` removes every key matching a glob pattern (with `*` as the wildcard) and returns the number of keys deleted. The pattern can place wildcards anywhere: `user:*`, `*:session`, or `api:*:active`.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });

await cache.set('user:1', { name: 'Alice' });
await cache.set('user:2', { name: 'Bob' });
await cache.set('user:3', { name: 'Carol' });
await cache.set('product:1', { name: 'Widget' });

const deleted = await cache.deletePattern('user:*');

console.log(deleted);                         // 3
console.log(await cache.exists('user:1'));    // false
console.log(await cache.exists('product:1')); // true — untouched

await cache.shutdown();
```

On the Redis backend this operation is implemented with `SCAN` plus batched `DEL` — never the blocking `KEYS` command — so it is safe to run on production servers.

### Clearing a Namespace with clear()

`clear()` removes every key under the provider's `rootKey`. It is namespace-scoped: it never flushes the entire Redis database and never touches other namespaces.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });

await cache.set('a', 1);
await cache.set('user:1', { name: 'Alice' });
await cache.set('user:2', { name: 'Bob' });

await cache.clear();

console.log(await cache.exists('a'));      // false
console.log(await cache.exists('user:1')); // false
console.log(await cache.exists('user:2')); // false

await cache.shutdown();
```

### Default TTL and Per-Call Overrides

A provider-level `defaultTTL` applies to every `set()` that does not specify one. An explicit TTL overrides the default, and an explicit `0` disables expiry for that entry.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({
    rootKey: 'MyApp',
    defaultTTL: 300, // every set() without an explicit TTL lives 5 minutes
});

await cache.set('config', { theme: 'dark' }); // uses defaultTTL
console.log(await cache.ttl('config')); // 300

await cache.set('one-time-token', 'abc', 60); // explicit override
console.log(await cache.ttl('one-time-token')); // 60

await cache.set('permanent', 'value', 0); // 0 overrides the default with "no expiry"
console.log(await cache.ttl('permanent')); // -1

await cache.shutdown();
```

---

## Namespaces and Multiple Caches

Namespacing is how several applications — or several concerns inside one application — share a single backend without key collisions.

### Isolating Keys with rootKey

Every key is transparently prefixed with the provider's `rootKey`; user code always works with plain keys. Both `clear()` and `deletePattern()` are strictly scoped to one namespace.

```typescript
import { MemoryCacheProvider } from 'blendsdk/webafx-cache';

// Two independent namespaces — user code uses the same plain keys in both
const sessions = new MemoryCacheProvider({ rootKey: 'Sessions' });
const products = new MemoryCacheProvider({ rootKey: 'Products' });

await sessions.set('user:1', { token: 'abc123' });
await products.set('user:1', { name: 'Widget' });

// Both entries coexist — the rootKey keeps them apart
console.log(await sessions.get<{ token: string }>('user:1')); // { token: 'abc123' }
console.log(await products.get<{ name: string }>('user:1')); // { name: 'Widget' }

// clear() affects only the calling provider's namespace
await sessions.clear();
console.log(await sessions.exists('user:1')); // false
console.log(await products.exists('user:1')); // true

await sessions.shutdown();
await products.shutdown();
```

With `RedisCacheProvider` the same isolation applies on a shared Redis server: the actual Redis keys become `Sessions:user:1` and `Products:user:1`.

### Multiple Independent Caches with serviceName

When registering caches as WebAFX plugins, the `serviceName` is the name under which the provider is registered in the service container. Distinct names allow several independent caches in one application.

```typescript
import { memoryCachePlugin } from 'blendsdk/webafx-cache';

// Each plugin registers its own singleton service — lookups are by name
const sessionCache = memoryCachePlugin({
    rootKey: 'Sessions',
    serviceName: 'session-cache',
});

const productCache = memoryCachePlugin({
    rootKey: 'Products',
    serviceName: 'product-cache',
});

console.log(sessionCache.name); // 'session-cache'
console.log(productCache.name); // 'product-cache'
console.log(sessionCache.priority); // 30
```

Inside a WebAFX application:

```typescript fragment
import { memoryCachePlugin } from 'blendsdk/webafx-cache';

app.use(memoryCachePlugin({ rootKey: 'Sessions', serviceName: 'session-cache' }));
app.use(memoryCachePlugin({ rootKey: 'Products', serviceName: 'product-cache' }));
```

---

## Redis-Backed Caching

The production backend. Connect to Redis, use the identical cache API, monitor health, and shut down gracefully. These examples require a reachable Redis server and assume `localhost:6379`.

### Connecting to Redis

`RedisCacheProvider` connects via host/port configuration. The client is created immediately and connects in the background — operations await the connection automatically.

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

await cache.set<User>('user:123', { id: 123, name: 'Alice' });

const user = await cache.get<User>('user:123');
console.log(user?.name); // 'Alice'

// Held in Redis under the namespaced key 'MyApp:user:123'
console.log(await cache.ttl('user:123')); // ~300

await cache.shutdown();
```

### URL-Based Redis Connections

Managed Redis providers usually hand you a single connection string. When `url` is provided it takes precedence over the individual `host`/`port`/`password`/`db` fields.

```typescript
import { RedisCacheProvider } from 'blendsdk/webafx-cache';

const cache = new RedisCacheProvider({
    rootKey: 'MyApp',
    url: 'redis://localhost:6379/1', // URL wins; database index 1
});

await cache.set('greeting', 'hello');
console.log(await cache.get<string>('greeting')); // 'hello'

await cache.shutdown();
```

### Redis Health Checks and Graceful Shutdown

`health()` pings the server and returns `false` instead of throwing when Redis is unreachable. `shutdown()` waits for pending commands to finish, then closes the connection.

```typescript
import { RedisCacheProvider } from 'blendsdk/webafx-cache';

const cache = new RedisCacheProvider({
    rootKey: 'MyApp',
    host: 'localhost',
    port: 6379,
});

// PING round-trip against the server
console.log(await cache.health()); // true

// Graceful disconnect — waits for in-flight commands
await cache.shutdown();

// The connection is closed now, so health() reports false
console.log(await cache.health()); // false
```

The WebAFX plugin factory wires both of these into the application automatically: `health()` feeds the `/health` endpoint and `shutdown()` runs during graceful shutdown.

---

## Pub/Sub Fundamentals

`MemoryPubSubProvider` delivers messages in-process with zero infrastructure — ideal for development, tests, and single-instance apps. Messages are JSON round-tripped on publish, so handlers always receive a fresh copy of the payload.

### Publishing and Subscribing

Subscribe a typed handler to an exact channel and publish a payload to it. `publish()` resolves with the number of handlers that received the message.

```typescript
import { MemoryPubSubProvider } from 'blendsdk/webafx-cache';

interface OrderEvent {
    orderId: number;
    total: number;
}

const pubsub = new MemoryPubSubProvider({ channelPrefix: 'MyApp' });

await pubsub.subscribe<OrderEvent>('order:new', (message) => {
    console.log(`New order #${message.data.orderId} for $${message.data.total}`);
    console.log(`Received on channel: ${message.channel}`);
});

const receivers = await pubsub.publish('order:new', { orderId: 9001, total: 149.5 });

console.log(`Delivered to ${receivers} handler(s)`);

await pubsub.shutdown();

// Output (printed in order):
// New order #9001 for $149.5
// Received on channel: order:new
// Delivered to 1 handler(s)
```

Note that the handler sees the user-facing channel name (`order:new`) — the internal `channelPrefix` (`MyApp:`) is applied and stripped transparently.

### Fan-Out: Multiple Handlers and Receiver Counts

Any number of handlers can subscribe to the same channel; each one receives every message. The value returned by `publish()` counts each delivery.

```typescript
import { MemoryPubSubProvider } from 'blendsdk/webafx-cache';

const pubsub = new MemoryPubSubProvider({ channelPrefix: 'MyApp' });

await pubsub.subscribe<{ userId: number }>('user:registered', (message) => {
    console.log(`[welcome-email] user ${message.data.userId}`);
});

await pubsub.subscribe<{ userId: number }>('user:registered', (message) => {
    console.log(`[analytics] user ${message.data.userId}`);
});

await pubsub.subscribe<{ userId: number }>('user:registered', (message) => {
    console.log(`[audit-log] user ${message.data.userId}`);
});

// Resolves with the number of handlers that received the message
const receivers = await pubsub.publish('user:registered', { userId: 42 });
console.log(`[publisher] delivered to ${receivers} handlers`);

await pubsub.shutdown();

// Output (printed in order):
// [welcome-email] user 42
// [analytics] user 42
// [audit-log] user 42
// [publisher] delivered to 3 handlers
```

Handlers are stored per channel in a `Set`, so registering the *same function reference* twice is deduplicated — use distinct functions for distinct reactions.

### Pattern Subscriptions with psubscribe()

`psubscribe()` matches channels with glob patterns: `*` matches any sequence of characters and `?` matches exactly one. Pattern-matched messages carry the matching `pattern` in their envelope.

```typescript
import { MemoryPubSubProvider } from 'blendsdk/webafx-cache';

const pubsub = new MemoryPubSubProvider({ channelPrefix: 'MyApp' });

await pubsub.psubscribe<{ id: number }>('order:*', (message) => {
    console.log(`[${message.pattern}] ${message.channel} -> order ${message.data.id}`);
});

// '?' matches exactly one character
await pubsub.psubscribe<{ id: number }>('slot:?', (message) => {
    console.log(`[${message.pattern}] ${message.channel} -> order ${message.data.id}`);
});

await pubsub.publish('order:created', { id: 1 });
await pubsub.publish('order:cancelled', { id: 2 });
await pubsub.publish('slot:a', { id: 3 });
await pubsub.publish('slot:ab', { id: 4 }); // does not match 'slot:?' — no output

await pubsub.shutdown();

// Output (printed in order):
// [order:*] order:created -> order 1
// [order:*] order:cancelled -> order 2
// [slot:?] slot:a -> order 3
```

A single message can be delivered to exact-channel handlers *and* every matching pattern handler — each delivery counts toward the value returned by `publish()`.

### Managing the Subscription Lifecycle

`activeSubscriptions()` reports the currently registered subscriptions using user-facing (unprefixed) names. `unsubscribe()` and `punsubscribe()` remove all handlers for a channel or pattern.

```typescript
import { MemoryPubSubProvider } from 'blendsdk/webafx-cache';

const pubsub = new MemoryPubSubProvider({ channelPrefix: 'MyApp' });

await pubsub.subscribe('order:new', () => {
    console.log('[exact] order handler fired');
});
await pubsub.psubscribe('audit:*', () => {
    console.log('[pattern] audit handler fired');
});

await pubsub.publish('order:new', { id: 1 });        // [exact] order handler fired
await pubsub.publish('audit:login', { userId: 1 });  // [pattern] audit handler fired

// activeSubscriptions() returns user-facing names — never the internal prefix
console.log(pubsub.activeSubscriptions());
// { channels: [ 'order:new' ], patterns: [ 'audit:*' ] }

// Remove both subscriptions and verify that nothing is delivered anymore
await pubsub.unsubscribe('order:new');
await pubsub.punsubscribe('audit:*');

console.log(pubsub.activeSubscriptions());
// { channels: [], patterns: [] }

const receivers = await pubsub.publish('order:new', { id: 2 });
console.log(receivers); // 0

await pubsub.shutdown();
```

### Handler Error Isolation

A handler that throws — synchronously or as a rejected promise — is caught and logged; every other handler still receives the message, and the failure can never crash the subscriber connection.

```typescript
import { MemoryPubSubProvider } from 'blendsdk/webafx-cache';

const pubsub = new MemoryPubSubProvider({ channelPrefix: 'MyApp' });

await pubsub.subscribe('events', () => {
    throw new Error('this handler is broken');
});

await pubsub.subscribe('events', (message) => {
    console.log('healthy handler received:', message.channel); // still fires
});

await pubsub.publish('events', { id: 1 });

await pubsub.shutdown();

// Output (printed in order):
// [PubSub] Handler error on channel "events": this handler is broken
// healthy handler received: events
```

---

## Redis Pub/Sub

The Redis backend adds one crucial capability: messages travel between processes. Each `RedisPubSubProvider` manages two dedicated connections internally — one for publishing and one for subscribing, as Redis requires a dedicated connection in subscriber mode. These examples require a reachable Redis server.

### Redis-Backed Publish/Subscribe

Two providers stand in for two application instances sharing one Redis server. A message published by one is delivered to the subscriber on the other.

```typescript
import { RedisPubSubProvider } from 'blendsdk/webafx-cache';
import type { PubSubMessage } from 'blendsdk/webafx-cache';

interface OrderEvent {
    orderId: number;
    total: number;
}

const REDIS = { host: 'localhost', port: 6379, channelPrefix: 'MyApp' };

// Two providers stand in for two app instances sharing one Redis server
const instanceA = new RedisPubSubProvider(REDIS);
const instanceB = new RedisPubSubProvider(REDIS);

let resolveMessage: (message: PubSubMessage<OrderEvent>) => void = () => {};
const received = new Promise<PubSubMessage<OrderEvent>>((resolve) => {
    resolveMessage = resolve;
});

await instanceB.subscribe<OrderEvent>('order:new', (message) => {
    resolveMessage(message);
});

// Give the Redis SUBSCRIBE command a moment to reach the server
await new Promise((resolve) => setTimeout(resolve, 100));

// Instance A publishes; instance B's handler fires
await instanceA.publish('order:new', { orderId: 9001, total: 149.5 });

const message = await received;
console.log(message.channel);    // 'order:new'
console.log(message.data.total); // 149.5

await instanceA.shutdown();
await instanceB.shutdown();
```

### Channel Prefix Isolation

On a shared Redis server, the `channelPrefix` isolates services from each other: publishers and subscribers with different prefixes never see each other's messages, even when the channel name is identical.

```typescript
import { RedisPubSubProvider } from 'blendsdk/webafx-cache';

const REDIS = { host: 'localhost', port: 6379 };

// Two services sharing one Redis server, isolated by channel prefix
const billing = new RedisPubSubProvider({ ...REDIS, channelPrefix: 'Billing' });
const shipping = new RedisPubSubProvider({ ...REDIS, channelPrefix: 'Shipping' });

const events: string[] = [];

await billing.subscribe('order:paid', () => {
    events.push('billing');
});
await shipping.subscribe('order:paid', () => {
    events.push('shipping');
});

// Give the SUBSCRIBE commands a moment to reach the server
await new Promise((resolve) => setTimeout(resolve, 100));

// This goes to 'Billing:order:paid' in Redis — only billing receives it
await billing.publish('order:paid', { orderId: 7 });

// Give the message time to arrive
await new Promise((resolve) => setTimeout(resolve, 200));

console.log(events); // [ 'billing' ]

// Subscriptions are reported with unprefixed, user-facing names
console.log(billing.activeSubscriptions());
// { channels: [ 'order:paid' ], patterns: [] }

await billing.shutdown();
await shipping.shutdown();
```

---

## WebAFX Plugin Integration

Plugin factories register a provider as an application-wide **singleton** service, wire `health()` into the WebAFX health endpoint, and hook `shutdown()` into graceful shutdown. The default plugin priority is `30`. The `app.use(...)` calls below are shown as fragments because the `app` instance comes from `blendsdk/webafx`.

### Registering a Memory Cache Plugin

`memoryCachePlugin()` is the one-liner for the in-memory backend — perfect for development and single-instance deployments.

```typescript
import { memoryCachePlugin } from 'blendsdk/webafx-cache';

const plugin = memoryCachePlugin({
    rootKey: 'MyApp',
    defaultTTL: 300,
});

// The plugin registers a singleton 'cache' service, wires health() into
// the /health endpoint, and shutdown() into graceful shutdown.
console.log(plugin.name);     // 'cache'
console.log(plugin.priority); // 30
```

Inside a WebAFX application:

```typescript fragment
import { memoryCachePlugin } from 'blendsdk/webafx-cache';

app.use(memoryCachePlugin({ rootKey: 'MyApp', defaultTTL: 300 }));
```

### Registering a Redis Cache Plugin

`redisCachePlugin()` creates the `RedisCacheProvider` for you — no manual instantiation needed.

```typescript
import { redisCachePlugin } from 'blendsdk/webafx-cache';

const plugin = redisCachePlugin({
    rootKey: 'MyApp',
    host: 'localhost',
    port: 6379,
    defaultTTL: 300,
});

console.log(plugin.name);     // 'cache'
console.log(plugin.priority); // 30
```

Inside a WebAFX application:

```typescript fragment
import { redisCachePlugin } from 'blendsdk/webafx-cache';

app.use(redisCachePlugin({
    rootKey: 'MyApp',
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    defaultTTL: 300,
}));
```

### Custom Priority and Reused Providers with createCachePlugin()

`createCachePlugin()` accepts any `CacheProvider` instance — including a provider you constructed yourself or a custom subclass — and supports overriding the plugin priority.

```typescript
import { MemoryCacheProvider, createCachePlugin } from 'blendsdk/webafx-cache';

const cache = new MemoryCacheProvider({
    rootKey: 'MyApp',
    serviceName: 'settings-cache',
});

// The plugin name comes from provider.serviceName; priority is overridable
const plugin = createCachePlugin(cache, { priority: 10 });

console.log(plugin.name);     // 'settings-cache'
console.log(plugin.priority); // 10 — overrides the default of 30
```

### Declarative Pub/Sub Subscriptions

`memoryPubSubPlugin()` (and `createPubSubPlugin()`) accepts a `subscriptions` option that registers channel and pattern handlers at plugin installation time — each entry uses either `channel` (exact) or `pattern` (glob).

```typescript
import { memoryPubSubPlugin } from 'blendsdk/webafx-cache';

const plugin = memoryPubSubPlugin(
    { channelPrefix: 'MyApp', serviceName: 'orders-pubsub' },
    {
        subscriptions: [
            {
                channel: 'order:new',
                handler: (message) => {
                    console.log(
                        `New order event on "${message.channel}":`,
                        JSON.stringify(message.data)
                    );
                },
            },
            {
                pattern: 'audit:*',
                handler: (message) => {
                    console.log(
                        `Audit event on "${message.channel}" (pattern "${message.pattern}")`
                    );
                },
            },
        ],
    }
);

console.log(plugin.name); // 'orders-pubsub'
```

In declarative handlers, `message.data` is typed as `unknown`. When you need the payload strongly typed, register the subscription programmatically instead: `provider.subscribe<OrderEvent>('order:new', handler)`.

### Environment-Based Backend Selection

`createCache()` and `createPubSub()` pick the backend from a `type` discriminator — the classic pattern is `redis` in production, `memory` everywhere else. The same code, the same calls, one configuration switch.

```typescript
import { createCache, createPubSub } from 'blendsdk/webafx-cache';

// Pick the backend from the environment — 'redis' in production, 'memory' locally
const backendType = process.env.NODE_ENV === 'production' ? 'redis' : 'memory';

const cache = createCache({
    type: backendType,
    rootKey: 'MyApp',
    defaultTTL: 300,
    // Redis-only fields — ignored when type is 'memory'
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
});

const pubsub = createPubSub({
    type: backendType,
    channelPrefix: 'MyApp',
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
});

console.log(cache.constructor.name);  // 'MemoryCacheProvider' (or 'RedisCacheProvider')
console.log(pubsub.constructor.name); // 'MemoryPubSubProvider' (or 'RedisPubSubProvider')

// The returned providers behave identically regardless of the backend
await cache.set('ping', 'pong');
console.log(await cache.get<string>('ping')); // 'pong'

await cache.shutdown();
await pubsub.shutdown();
```

An unknown `type` value throws a descriptive error at runtime: `Unknown cache type: "postgres". Supported types: "redis", "memory".` Register the providers with plugins inside a WebAFX app:

```typescript fragment
import { createCachePlugin, createPubSubPlugin } from 'blendsdk/webafx-cache';

app.use(createCachePlugin(cache));
app.use(createPubSubPlugin(pubsub));
```

---

## Integration Patterns

Composing the two hierarchies with application code: backend-agnostic service functions and cache invalidation across instances.

### Writing Backend-Agnostic Code

Type your service functions against the abstract `CacheProvider` class and any backend satisfies them — Memory, Redis, or a custom subclass. Swapping backends then requires no code changes at the call sites.

```typescript
import { MemoryCacheProvider, type CacheProvider } from 'blendsdk/webafx-cache';

interface User {
    id: number;
    name: string;
}

// Any CacheProvider — Memory, Redis, or custom — satisfies this signature
async function getUser(cache: CacheProvider, id: number): Promise<User> {
    return cache.getOrSet<User>(`user:${id}`, async () => {
        // Stand-in for a database lookup
        return { id, name: 'Alice' };
    }, 300);
}

const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });
const user = await getUser(cache, 123);
console.log(user.name); // 'Alice'

await cache.shutdown();
```

Passing a `RedisCacheProvider` — or a provider built by `createCache()` — to `getUser()` works without a single change to the function.

### Cross-Instance Cache Invalidation via Pub/Sub

The classic use of pub/sub alongside a cache: the write path broadcasts an invalidation event, and every instance drops the affected key from its local cache.

```typescript
import { MemoryCacheProvider, MemoryPubSubProvider } from 'blendsdk/webafx-cache';

interface Product {
    id: number;
    name: string;
}

const cache = new MemoryCacheProvider({ rootKey: 'Products' });
const pubsub = new MemoryPubSubProvider({ channelPrefix: 'Products' });

// Each instance drops the affected key when a write happens anywhere
await pubsub.subscribe<{ key: string }>('cache:invalidate', async (message) => {
    await cache.delete(message.data.key);
});

// Reads go through the cache-aside pattern
const product = await cache.getOrSet<Product>('product:42', async () => {
    return { id: 42, name: 'Widget' };
}, 300);
console.log(product.name); // 'Widget'

// The write path broadcasts an invalidation after updating the store
await pubsub.publish('cache:invalidate', { key: 'product:42' });

// The subscriber has already evicted the stale entry
console.log(await cache.exists('product:42')); // false

await pubsub.shutdown();
await cache.shutdown();
```

Replacing both providers with `RedisCacheProvider` and `RedisPubSubProvider` (same configuration, same code) turns this into cache coherence across every application instance sharing the Redis server.

---

## Testing and the Redis-Free Subpath

The in-memory providers are contract-identical to the Redis backend (the package pins this with cross-backend contract test suites — see `07-testing-strategy.md`), which makes them the natural choice for unit tests and infrastructure-free deployments.

### Unit Testing Services with Memory Providers

Use `MemoryCacheProvider` in tests: no Docker, no Redis, no cleanup between CI runs. Type the service under test against `CacheProvider` so the same suite validates behavior that production's Redis backend will provide.

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryCacheProvider, type CacheProvider } from 'blendsdk/webafx-cache';

interface User {
    id: number;
    name: string;
}

class UserService {
    constructor(private readonly cache: CacheProvider) {}

    async getUser(id: number): Promise<User> {
        return this.cache.getOrSet<User>(`user:${id}`, async () => {
            // Stand-in for a database query
            return { id, name: 'Alice' };
        }, 60);
    }
}

describe('UserService', () => {
    let cache: MemoryCacheProvider;
    let service: UserService;

    beforeEach(() => {
        cache = new MemoryCacheProvider({
            rootKey: 'Test',
            cleanupIntervalMs: 0, // no background timer during tests
        });
        service = new UserService(cache);
    });

    afterEach(async () => {
        await cache.shutdown();
    });

    it('loads a user on a cold cache', async () => {
        const user = await service.getUser(123);
        expect(user.name).toBe('Alice');
    });

    it('stores the result so the next call hits the cache', async () => {
        await service.getUser(123);
        expect(await cache.exists('user:123')).toBe(true);
    });
});
```

### Importing the Redis-Free Memory Subpath

The main entry point loads the Redis providers (and therefore `ioredis`). Import from `blendsdk/webafx-cache/memory` instead when you only need the in-memory backends — `ioredis` is never evaluated.

```typescript
import {
    MemoryCacheProvider,
    MemoryPubSubProvider,
    memoryCachePlugin,
    memoryPubSubPlugin,
} from 'blendsdk/webafx-cache/memory';

// ioredis is never loaded when only this subpath is imported
const cache = new MemoryCacheProvider({ rootKey: 'Worker' });
const pubsub = new MemoryPubSubProvider({ channelPrefix: 'Worker' });

await cache.set('job:1', { status: 'queued' });

// Combine both in-memory backends with zero infrastructure
let invalidated = false;
await pubsub.subscribe<{ id: number }>('job:done', async (message) => {
    await cache.delete(`job:${message.data.id}`);
    invalidated = true;
});
await pubsub.publish('job:done', { id: 1 });

console.log(await cache.get<{ status: string }>('job:1')); // undefined — evicted by the event
console.log(invalidated); // true

// The Redis-free plugin factories come from the same entry point
console.log(memoryCachePlugin({ rootKey: 'Worker' }).name); // 'cache'
console.log(memoryPubSubPlugin().name); // 'pubsub'

await pubsub.shutdown();
await cache.shutdown();
```

The subpath exposes `CacheProvider`, `PubSubProvider`, `MemoryCacheProvider`, `MemoryPubSubProvider`, the Redis-free builders `createCachePlugin` / `createPubSubPlugin`, the memory plugin factories, and the memory/plugin types — deliberately *not* `RedisCacheProvider` or `RedisPubSubProvider`. Every export shares identity with the main entry. Registering the memory plugins inside an app:

```typescript fragment
import { memoryCachePlugin, memoryPubSubPlugin } from 'blendsdk/webafx-cache/memory';

app.use(memoryCachePlugin({ rootKey: 'Worker' }));
app.use(memoryPubSubPlugin({ channelPrefix: 'Worker' }));
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
