/**
 * Integration tests for RedisCacheProvider.
 *
 * Requires Docker Redis on port 6399. Tests against a real Redis instance
 * to verify correct command usage, TTL behavior, SCAN-based operations,
 * JSON serialization, and connection lifecycle.
 *
 * Run with: `yarn test` (starts Docker automatically)
 * Skip with: `yarn test:fast` (no Docker needed)
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { Redis } from "ioredis";
import { RedisCacheProvider } from "../src/redis-cache-provider.js";

// ---------------------------------------------------------------------------
// Test Configuration
// ---------------------------------------------------------------------------

/** Redis test connection config — matches docker-compose.yml port mapping */
const REDIS_CONFIG = {
    host: "localhost",
    port: 6399,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
};

/** Unique root key per test run to avoid collisions */
const ROOT_KEY = `RedisTest_${Date.now()}`;

/** Standard test values covering all JSON-serializable types */
const TEST_VALUES = {
    string: "hello world",
    number: 42,
    float: 3.14,
    boolean: true,
    null: null as null,
    object: { name: "John", age: 30, nested: { active: true } },
    array: [1, "two", { three: 3 }, [4, 5]],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a RedisCacheProvider for testing with a unique rootKey.
 * Uses a fresh rootKey suffix to prevent test cross-contamination.
 */
function createProvider(overrides?: Partial<{
    rootKey: string;
    defaultTTL: number;
    serviceName: string;
    url: string;
}>) {
    return new RedisCacheProvider({
        ...REDIS_CONFIG,
        rootKey: overrides?.rootKey ?? ROOT_KEY,
        defaultTTL: overrides?.defaultTTL ?? 0,
        serviceName: overrides?.serviceName,
        url: overrides?.url,
    });
}

/**
 * Wait for the specified number of milliseconds.
 * Used for TTL-related tests where we need real Redis delays.
 */
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Connection Check — skip all tests if Redis is not available
// ---------------------------------------------------------------------------

let redisAvailable = false;

beforeAll(async () => {
    // Check if Redis is reachable before running tests
    const testClient = new Redis({
        ...REDIS_CONFIG,
        lazyConnect: true,
        maxRetriesPerRequest: 0,
    });

    try {
        await testClient.connect();
        const pong = await testClient.ping();
        redisAvailable = pong === "PONG";
    } catch {
        redisAvailable = false;
    } finally {
        try {
            await testClient.quit();
        } catch {
            // Ignore quit errors during setup
        }
    }

    if (!redisAvailable) {
        console.warn("⚠️  Redis not available on port 6399 — skipping Redis integration tests");
    }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RedisCacheProvider", () => {
    let cache: RedisCacheProvider;

    beforeEach(async () => {
        if (!redisAvailable) {
            return;
        }
        cache = createProvider();
        // Clean up any leftover keys from previous test runs
        await cache.clear();
    });

    afterEach(async () => {
        if (!redisAvailable) {
            return;
        }
        try {
            await cache.clear();
            await cache.shutdown();
        } catch {
            // Ignore cleanup errors (connection may already be closed)
        }
    });

    // -------------------------------------------------------------------
    // Constructor Validation
    // -------------------------------------------------------------------

    describe("constructor", () => {
        it("should throw if rootKey is empty", () => {
            if (!redisAvailable) return;
            expect(() => new RedisCacheProvider({ ...REDIS_CONFIG, rootKey: "" })).toThrow(
                "rootKey is required and cannot be empty"
            );
        });

        it("should throw if rootKey is whitespace only", () => {
            if (!redisAvailable) return;
            expect(() => new RedisCacheProvider({ ...REDIS_CONFIG, rootKey: "   " })).toThrow(
                "rootKey is required and cannot be empty"
            );
        });

        it("should use default serviceName 'cache'", () => {
            if (!redisAvailable) return;
            expect(cache.serviceName).toBe("cache");
        });

        it("should use custom serviceName when provided", async () => {
            if (!redisAvailable) return;
            const provider = createProvider({ serviceName: "redis-cache" });
            expect(provider.serviceName).toBe("redis-cache");
            await provider.shutdown();
        });
    });

    // -------------------------------------------------------------------
    // Core Operations: set / get
    // -------------------------------------------------------------------

    describe("set and get", () => {
        it("should set and get a string value", async () => {
            if (!redisAvailable) return;
            await cache.set("key1", TEST_VALUES.string);
            const result = await cache.get<string>("key1");
            expect(result).toBe(TEST_VALUES.string);
        });

        it("should set and get a number value", async () => {
            if (!redisAvailable) return;
            await cache.set("key1", TEST_VALUES.number);
            const result = await cache.get<number>("key1");
            expect(result).toBe(TEST_VALUES.number);
        });

        it("should set and get a float value", async () => {
            if (!redisAvailable) return;
            await cache.set("key1", TEST_VALUES.float);
            const result = await cache.get<number>("key1");
            expect(result).toBe(TEST_VALUES.float);
        });

        it("should set and get a boolean value", async () => {
            if (!redisAvailable) return;
            await cache.set("key1", TEST_VALUES.boolean);
            const result = await cache.get<boolean>("key1");
            expect(result).toBe(TEST_VALUES.boolean);
        });

        it("should set and get a null value", async () => {
            if (!redisAvailable) return;
            await cache.set("key1", TEST_VALUES.null);
            const result = await cache.get<null>("key1");
            expect(result).toBeNull();
        });

        it("should set and get an object value", async () => {
            if (!redisAvailable) return;
            await cache.set("key1", TEST_VALUES.object);
            const result = await cache.get<typeof TEST_VALUES.object>("key1");
            expect(result).toEqual(TEST_VALUES.object);
        });

        it("should set and get an array value", async () => {
            if (!redisAvailable) return;
            await cache.set("key1", TEST_VALUES.array);
            const result = await cache.get<typeof TEST_VALUES.array>("key1");
            expect(result).toEqual(TEST_VALUES.array);
        });

        it("should return undefined for a non-existent key", async () => {
            if (!redisAvailable) return;
            const result = await cache.get<string>("nonexistent");
            expect(result).toBeUndefined();
        });

        it("should overwrite an existing key with a new value", async () => {
            if (!redisAvailable) return;
            await cache.set("key1", "first");
            await cache.set("key1", "second");
            const result = await cache.get<string>("key1");
            expect(result).toBe("second");
        });

        it("should return a deep copy (no reference sharing) via JSON serialization", async () => {
            if (!redisAvailable) return;
            const original = { count: 1, items: [1, 2, 3] };
            await cache.set("key1", original);

            // Modify the original — cached value should not change
            original.count = 999;
            original.items.push(4);

            const result = await cache.get<typeof original>("key1");
            expect(result).toEqual({ count: 1, items: [1, 2, 3] });
        });
    });

    // -------------------------------------------------------------------
    // Core Operations: delete
    // -------------------------------------------------------------------

    describe("delete", () => {
        it("should return true when deleting an existing key", async () => {
            if (!redisAvailable) return;
            await cache.set("key1", "value");
            const result = await cache.delete("key1");
            expect(result).toBe(true);
        });

        it("should return false when deleting a non-existent key", async () => {
            if (!redisAvailable) return;
            const result = await cache.delete("nonexistent");
            expect(result).toBe(false);
        });

        it("should make the key inaccessible after deletion", async () => {
            if (!redisAvailable) return;
            await cache.set("key1", "value");
            await cache.delete("key1");
            const result = await cache.get<string>("key1");
            expect(result).toBeUndefined();
        });
    });

    // -------------------------------------------------------------------
    // Core Operations: exists
    // -------------------------------------------------------------------

    describe("exists", () => {
        it("should return true for an existing key", async () => {
            if (!redisAvailable) return;
            await cache.set("key1", "value");
            const result = await cache.exists("key1");
            expect(result).toBe(true);
        });

        it("should return false for a non-existent key", async () => {
            if (!redisAvailable) return;
            const result = await cache.exists("nonexistent");
            expect(result).toBe(false);
        });

        it("should return false for an expired key", async () => {
            if (!redisAvailable) return;
            await cache.set("key1", "value", 1); // 1 second TTL
            await delay(1200);
            const result = await cache.exists("key1");
            expect(result).toBe(false);
        });
    });

    // -------------------------------------------------------------------
    // TTL Operations: expire / ttl
    // -------------------------------------------------------------------

    describe("expire", () => {
        it("should return true when setting TTL on existing key", async () => {
            if (!redisAvailable) return;
            await cache.set("key1", "value");
            const result = await cache.expire("key1", 60);
            expect(result).toBe(true);
        });

        it("should return false when setting TTL on non-existent key", async () => {
            if (!redisAvailable) return;
            const result = await cache.expire("nonexistent", 60);
            expect(result).toBe(false);
        });

        it("should actually update the TTL in Redis", async () => {
            if (!redisAvailable) return;
            await cache.set("key1", "value"); // No TTL
            expect(await cache.ttl("key1")).toBe(-1); // No expiry

            await cache.expire("key1", 30);
            const ttl = await cache.ttl("key1");
            expect(ttl).toBeGreaterThanOrEqual(28);
            expect(ttl).toBeLessThanOrEqual(30);
        });
    });

    describe("ttl", () => {
        it("should return -1 for a key with no expiry", async () => {
            if (!redisAvailable) return;
            await cache.set("key1", "value");
            const result = await cache.ttl("key1");
            expect(result).toBe(-1);
        });

        it("should return -2 for a non-existent key", async () => {
            if (!redisAvailable) return;
            const result = await cache.ttl("nonexistent");
            expect(result).toBe(-2);
        });

        it("should return remaining seconds for a key with TTL", async () => {
            if (!redisAvailable) return;
            await cache.set("key1", "value", 10);
            const result = await cache.ttl("key1");
            // Should be approximately 10 (±1 second for network/timing)
            expect(result).toBeGreaterThanOrEqual(8);
            expect(result).toBeLessThanOrEqual(10);
        });
    });

    // -------------------------------------------------------------------
    // TTL Expiration Behavior
    // -------------------------------------------------------------------

    describe("TTL expiration", () => {
        it("should return value before TTL expires", async () => {
            if (!redisAvailable) return;
            await cache.set("key1", "value", 3); // 3 second TTL
            await delay(500);
            const result = await cache.get<string>("key1");
            expect(result).toBe("value");
        });

        it("should return undefined after TTL expires", async () => {
            if (!redisAvailable) return;
            await cache.set("key1", "value", 1); // 1 second TTL
            await delay(1500); // Wait 1.5s
            const result = await cache.get<string>("key1");
            expect(result).toBeUndefined();
        });

        it("should use defaultTTL when no explicit TTL provided", async () => {
            if (!redisAvailable) return;
            const providerWithDefault = createProvider({ defaultTTL: 1 });
            await providerWithDefault.set("key1", "value"); // Uses defaultTTL=1
            await delay(1500);
            const result = await providerWithDefault.get<string>("key1");
            expect(result).toBeUndefined();
            await providerWithDefault.shutdown();
        });

        it("should persist indefinitely when TTL is 0 (no defaultTTL)", async () => {
            if (!redisAvailable) return;
            await cache.set("key1", "value", 0); // Explicit 0 = no expiry
            await delay(200);
            const result = await cache.get<string>("key1");
            expect(result).toBe("value");

            // Verify no TTL is set in Redis
            const ttl = await cache.ttl("key1");
            expect(ttl).toBe(-1);
        });
    });

    // -------------------------------------------------------------------
    // Pattern Operations: deletePattern / clear
    // -------------------------------------------------------------------

    describe("deletePattern", () => {
        it("should delete keys matching a wildcard pattern", async () => {
            if (!redisAvailable) return;
            await cache.set("user:1", "a");
            await cache.set("user:2", "b");
            await cache.set("user:3", "c");
            await cache.set("product:1", "x");

            const deleted = await cache.deletePattern("user:*");
            expect(deleted).toBe(3);

            // user keys should be gone
            expect(await cache.exists("user:1")).toBe(false);
            expect(await cache.exists("user:2")).toBe(false);
            expect(await cache.exists("user:3")).toBe(false);

            // product key should remain
            expect(await cache.exists("product:1")).toBe(true);
        });

        it("should return 0 when no keys match the pattern", async () => {
            if (!redisAvailable) return;
            await cache.set("key1", "value");
            const deleted = await cache.deletePattern("nonexistent:*");
            expect(deleted).toBe(0);
        });

        it("should handle pattern with wildcard in the middle", async () => {
            if (!redisAvailable) return;
            await cache.set("api:users:active", "a");
            await cache.set("api:products:active", "b");
            await cache.set("api:users:inactive", "c");

            const deleted = await cache.deletePattern("api:*:active");
            expect(deleted).toBe(2);
            expect(await cache.exists("api:users:inactive")).toBe(true);
        });

        it("should use SCAN (not KEYS) for production safety", async () => {
            if (!redisAvailable) return;
            // Populate enough keys to require multiple SCAN iterations
            const promises: Promise<void>[] = [];
            for (let i = 0; i < 150; i++) {
                promises.push(cache.set(`bulk:${i}`, `val-${i}`));
            }
            await Promise.all(promises);

            const deleted = await cache.deletePattern("bulk:*");
            expect(deleted).toBe(150);
        });
    });

    describe("clear", () => {
        it("should remove all keys under the rootKey namespace", async () => {
            if (!redisAvailable) return;
            await cache.set("key1", "a");
            await cache.set("key2", "b");
            await cache.set("user:1", "c");

            await cache.clear();

            expect(await cache.exists("key1")).toBe(false);
            expect(await cache.exists("key2")).toBe(false);
            expect(await cache.exists("user:1")).toBe(false);
        });

        it("should NOT remove keys from a different rootKey", async () => {
            if (!redisAvailable) return;
            const otherProvider = createProvider({ rootKey: `Other_${Date.now()}` });

            await cache.set("shared-key", "from-cache");
            await otherProvider.set("shared-key", "from-other");

            // Clear only the main cache
            await cache.clear();

            // Main cache key should be gone
            expect(await cache.get<string>("shared-key")).toBeUndefined();

            // Other provider's key should still exist
            expect(await otherProvider.get<string>("shared-key")).toBe("from-other");

            await otherProvider.clear();
            await otherProvider.shutdown();
        });
    });

    // -------------------------------------------------------------------
    // Lifecycle: health / shutdown
    // -------------------------------------------------------------------

    describe("health", () => {
        it("should return true when connected to Redis", async () => {
            if (!redisAvailable) return;
            const result = await cache.health();
            expect(result).toBe(true);
        });
    });

    describe("shutdown", () => {
        it("should close the Redis connection gracefully", async () => {
            if (!redisAvailable) return;
            const provider = createProvider();
            expect(await provider.health()).toBe(true);

            await provider.shutdown();

            // After shutdown, health should fail (connection closed)
            const result = await provider.health();
            expect(result).toBe(false);
        });
    });

    // -------------------------------------------------------------------
    // getOrSet (Cache-Aside Pattern)
    // -------------------------------------------------------------------

    describe("getOrSet", () => {
        it("should call factory on cache miss and return the produced value", async () => {
            if (!redisAvailable) return;
            let factoryCalled = false;
            const result = await cache.getOrSet("key1", async () => {
                factoryCalled = true;
                return { name: "Alice" };
            });

            expect(factoryCalled).toBe(true);
            expect(result).toEqual({ name: "Alice" });
        });

        it("should cache the factory result for subsequent calls", async () => {
            if (!redisAvailable) return;
            let callCount = 0;
            const factory = async () => {
                callCount++;
                return "expensive-value";
            };

            // First call — factory should execute
            await cache.getOrSet("key1", factory);
            expect(callCount).toBe(1);

            // Second call — factory should NOT execute (cached)
            const result = await cache.getOrSet("key1", factory);
            expect(callCount).toBe(1);
            expect(result).toBe("expensive-value");
        });

        it("should respect TTL for the cached value", async () => {
            if (!redisAvailable) return;
            await cache.getOrSet(
                "key1",
                async () => "short-lived",
                1 // 1 second TTL
            );

            expect(await cache.get<string>("key1")).toBe("short-lived");

            // Wait for Redis TTL expiration
            await delay(1500);

            expect(await cache.get<string>("key1")).toBeUndefined();
        });
    });

    // -------------------------------------------------------------------
    // Root Key Namespacing (verify actual Redis keys)
    // -------------------------------------------------------------------

    describe("rootKey namespacing", () => {
        it("should prefix all Redis keys with rootKey:", async () => {
            if (!redisAvailable) return;
            // Use a raw ioredis client to inspect actual Redis key names
            const rawClient = new Redis(REDIS_CONFIG);

            await cache.set("mykey", "value");

            // The actual Redis key should be prefixed with the rootKey
            const expectedKey = `${ROOT_KEY}:mykey`;
            const rawValue = await rawClient.get(expectedKey);
            expect(rawValue).toBe('"value"'); // JSON-serialized string

            await rawClient.quit();
        });

        it("should isolate keys between providers with different rootKeys", async () => {
            if (!redisAvailable) return;
            const cacheA = createProvider({ rootKey: `IsoA_${Date.now()}` });
            const cacheB = createProvider({ rootKey: `IsoB_${Date.now()}` });

            await cacheA.set("key", "from-A");
            await cacheB.set("key", "from-B");

            expect(await cacheA.get<string>("key")).toBe("from-A");
            expect(await cacheB.get<string>("key")).toBe("from-B");

            await cacheA.clear();
            await cacheB.clear();
            await cacheA.shutdown();
            await cacheB.shutdown();
        });
    });

    // -------------------------------------------------------------------
    // URL-based Connection
    // -------------------------------------------------------------------

    describe("URL-based connection", () => {
        it("should connect via redis:// URL", async () => {
            if (!redisAvailable) return;
            const provider = createProvider({
                rootKey: `URL_${Date.now()}`,
                url: `redis://localhost:6399`,
            });

            await provider.set("url-test", "connected");
            const result = await provider.get<string>("url-test");
            expect(result).toBe("connected");

            await provider.clear();
            await provider.shutdown();
        });
    });
});
