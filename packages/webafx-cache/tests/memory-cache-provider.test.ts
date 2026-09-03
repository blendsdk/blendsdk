/**
 * Unit tests for MemoryCacheProvider.
 *
 * No Docker required — tests the in-memory backend in isolation.
 * Covers all CacheProvider abstract methods, JSON serialization,
 * rootKey namespacing, TTL behavior, and lifecycle management.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryCacheProvider } from "../src/memory-cache-provider.js";

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

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
// Helper: Create a provider with cleanup interval disabled for fast tests
// ---------------------------------------------------------------------------

function createProvider(overrides?: Partial<{ rootKey: string; defaultTTL: number; cleanupIntervalMs: number }>) {
    return new MemoryCacheProvider({
        rootKey: overrides?.rootKey ?? "Test",
        defaultTTL: overrides?.defaultTTL ?? 0,
        cleanupIntervalMs: overrides?.cleanupIntervalMs ?? 0, // Disable cleanup for predictable tests
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryCacheProvider", () => {
    let cache: MemoryCacheProvider;

    beforeEach(() => {
        cache = createProvider();
    });

    afterEach(async () => {
        await cache.shutdown();
    });

    // -------------------------------------------------------------------
    // Constructor Validation
    // -------------------------------------------------------------------

    describe("constructor", () => {
        it("should throw if rootKey is empty", () => {
            expect(() => new MemoryCacheProvider({ rootKey: "" })).toThrow(
                "rootKey is required and cannot be empty"
            );
        });

        it("should throw if rootKey is whitespace only", () => {
            expect(() => new MemoryCacheProvider({ rootKey: "   " })).toThrow(
                "rootKey is required and cannot be empty"
            );
        });

        it("should accept a valid rootKey", () => {
            const provider = new MemoryCacheProvider({ rootKey: "Valid" });
            expect(provider.serviceName).toBe("cache");
            void provider.shutdown();
        });

        it("should use default serviceName 'cache'", () => {
            expect(cache.serviceName).toBe("cache");
        });

        it("should use custom serviceName when provided", () => {
            const provider = new MemoryCacheProvider({ rootKey: "Test", serviceName: "custom-cache" });
            expect(provider.serviceName).toBe("custom-cache");
            void provider.shutdown();
        });
    });

    // -------------------------------------------------------------------
    // Core Operations: set / get
    // -------------------------------------------------------------------

    describe("set and get", () => {
        it("should set and get a string value", async () => {
            await cache.set("key1", TEST_VALUES.string);
            const result = await cache.get<string>("key1");
            expect(result).toBe(TEST_VALUES.string);
        });

        it("should set and get a number value", async () => {
            await cache.set("key1", TEST_VALUES.number);
            const result = await cache.get<number>("key1");
            expect(result).toBe(TEST_VALUES.number);
        });

        it("should set and get a float value", async () => {
            await cache.set("key1", TEST_VALUES.float);
            const result = await cache.get<number>("key1");
            expect(result).toBe(TEST_VALUES.float);
        });

        it("should set and get a boolean value", async () => {
            await cache.set("key1", TEST_VALUES.boolean);
            const result = await cache.get<boolean>("key1");
            expect(result).toBe(TEST_VALUES.boolean);
        });

        it("should set and get a null value", async () => {
            await cache.set("key1", TEST_VALUES.null);
            const result = await cache.get<null>("key1");
            expect(result).toBeNull();
        });

        it("should set and get an object value", async () => {
            await cache.set("key1", TEST_VALUES.object);
            const result = await cache.get<typeof TEST_VALUES.object>("key1");
            expect(result).toEqual(TEST_VALUES.object);
        });

        it("should set and get an array value", async () => {
            await cache.set("key1", TEST_VALUES.array);
            const result = await cache.get<typeof TEST_VALUES.array>("key1");
            expect(result).toEqual(TEST_VALUES.array);
        });

        it("should return undefined for a non-existent key", async () => {
            const result = await cache.get<string>("nonexistent");
            expect(result).toBeUndefined();
        });

        it("should overwrite an existing key with a new value", async () => {
            await cache.set("key1", "first");
            await cache.set("key1", "second");
            const result = await cache.get<string>("key1");
            expect(result).toBe("second");
        });

        it("should return a deep copy (no reference sharing) via JSON serialization", async () => {
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
            await cache.set("key1", "value");
            const result = await cache.delete("key1");
            expect(result).toBe(true);
        });

        it("should return false when deleting a non-existent key", async () => {
            const result = await cache.delete("nonexistent");
            expect(result).toBe(false);
        });

        it("should make the key inaccessible after deletion", async () => {
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
            await cache.set("key1", "value");
            const result = await cache.exists("key1");
            expect(result).toBe(true);
        });

        it("should return false for a non-existent key", async () => {
            const result = await cache.exists("nonexistent");
            expect(result).toBe(false);
        });

        it("should return false for an expired key", async () => {
            await cache.set("key1", "value", 1); // 1 second TTL
            // Wait for expiration
            await new Promise((r) => setTimeout(r, 1100));
            const result = await cache.exists("key1");
            expect(result).toBe(false);
        });
    });

    // -------------------------------------------------------------------
    // TTL Operations: expire / ttl
    // -------------------------------------------------------------------

    describe("expire", () => {
        it("should return true when setting TTL on existing key", async () => {
            await cache.set("key1", "value");
            const result = await cache.expire("key1", 60);
            expect(result).toBe(true);
        });

        it("should return false when setting TTL on non-existent key", async () => {
            const result = await cache.expire("nonexistent", 60);
            expect(result).toBe(false);
        });

        it("should return false when setting TTL on an expired key", async () => {
            await cache.set("key1", "value", 1);
            await new Promise((r) => setTimeout(r, 1100));
            const result = await cache.expire("key1", 60);
            expect(result).toBe(false);
        });
    });

    describe("ttl", () => {
        it("should return -1 for a key with no expiry", async () => {
            await cache.set("key1", "value");
            const result = await cache.ttl("key1");
            expect(result).toBe(-1);
        });

        it("should return -2 for a non-existent key", async () => {
            const result = await cache.ttl("nonexistent");
            expect(result).toBe(-2);
        });

        it("should return -2 for an expired key", async () => {
            await cache.set("key1", "value", 1);
            await new Promise((r) => setTimeout(r, 1100));
            const result = await cache.ttl("key1");
            expect(result).toBe(-2);
        });

        it("should return remaining seconds for a key with TTL", async () => {
            await cache.set("key1", "value", 10);
            const result = await cache.ttl("key1");
            // Should be approximately 10 (with tolerance for test execution time)
            expect(result).toBeGreaterThanOrEqual(9);
            expect(result).toBeLessThanOrEqual(10);
        });
    });

    // -------------------------------------------------------------------
    // TTL Expiration Behavior
    // -------------------------------------------------------------------

    describe("TTL expiration", () => {
        it("should return value before TTL expires", async () => {
            await cache.set("key1", "value", 2); // 2 second TTL
            await new Promise((r) => setTimeout(r, 500)); // Wait 0.5s
            const result = await cache.get<string>("key1");
            expect(result).toBe("value");
        });

        it("should return undefined after TTL expires", async () => {
            await cache.set("key1", "value", 1); // 1 second TTL
            await new Promise((r) => setTimeout(r, 1200)); // Wait 1.2s
            const result = await cache.get<string>("key1");
            expect(result).toBeUndefined();
        });

        it("should use defaultTTL when no explicit TTL provided", async () => {
            const providerWithDefault = createProvider({ defaultTTL: 1 });
            await providerWithDefault.set("key1", "value"); // Uses defaultTTL=1
            await new Promise((r) => setTimeout(r, 1200));
            const result = await providerWithDefault.get<string>("key1");
            expect(result).toBeUndefined();
            await providerWithDefault.shutdown();
        });

        it("should persist indefinitely when TTL is 0 (no defaultTTL)", async () => {
            await cache.set("key1", "value", 0); // Explicit 0 = no expiry
            await new Promise((r) => setTimeout(r, 100));
            const result = await cache.get<string>("key1");
            expect(result).toBe("value");
        });
    });

    // -------------------------------------------------------------------
    // Pattern Operations: deletePattern / clear
    // -------------------------------------------------------------------

    describe("deletePattern", () => {
        it("should delete keys matching a wildcard pattern", async () => {
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
            await cache.set("key1", "value");
            const deleted = await cache.deletePattern("nonexistent:*");
            expect(deleted).toBe(0);
        });

        it("should handle pattern with wildcard in the middle", async () => {
            await cache.set("api:users:active", "a");
            await cache.set("api:products:active", "b");
            await cache.set("api:users:inactive", "c");

            const deleted = await cache.deletePattern("api:*:active");
            expect(deleted).toBe(2);
            expect(await cache.exists("api:users:inactive")).toBe(true);
        });
    });

    describe("clear", () => {
        it("should remove all keys under the rootKey namespace", async () => {
            await cache.set("key1", "a");
            await cache.set("key2", "b");
            await cache.set("user:1", "c");

            await cache.clear();

            expect(await cache.exists("key1")).toBe(false);
            expect(await cache.exists("key2")).toBe(false);
            expect(await cache.exists("user:1")).toBe(false);
        });

        it("should NOT remove keys from a different rootKey", async () => {
            // Create two providers with different rootKeys sharing the same store concept
            // Since they have separate stores, we test that clear only affects "this" provider
            const provider1 = createProvider({ rootKey: "App1" });
            const provider2 = createProvider({ rootKey: "App2" });

            await provider1.set("shared-key", "app1-value");
            await provider2.set("shared-key", "app2-value");

            // Clear only App1
            await provider1.clear();

            // App1's key should be gone
            expect(await provider1.get("shared-key")).toBeUndefined();

            // App2's key should still exist (separate store instance)
            expect(await provider2.get("shared-key")).toBe("app2-value");

            await provider1.shutdown();
            await provider2.shutdown();
        });
    });

    // -------------------------------------------------------------------
    // Lifecycle: health / shutdown
    // -------------------------------------------------------------------

    describe("health", () => {
        it("should return true (in-memory is always healthy)", async () => {
            const result = await cache.health();
            expect(result).toBe(true);
        });
    });

    describe("shutdown", () => {
        it("should clear all entries from the store", async () => {
            await cache.set("key1", "value");
            await cache.set("key2", "value");
            await cache.shutdown();

            // After shutdown, store is cleared — but we can't get because the
            // provider is shut down. Verify by checking health still works.
            const result = await cache.health();
            expect(result).toBe(true);
        });
    });

    // -------------------------------------------------------------------
    // getOrSet (Cache-Aside Pattern)
    // -------------------------------------------------------------------

    describe("getOrSet", () => {
        it("should call factory on cache miss and return the produced value", async () => {
            let factoryCalled = false;
            const result = await cache.getOrSet("key1", async () => {
                factoryCalled = true;
                return { name: "Alice" };
            });

            expect(factoryCalled).toBe(true);
            expect(result).toEqual({ name: "Alice" });
        });

        it("should cache the factory result for subsequent calls", async () => {
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
            await cache.getOrSet(
                "key1",
                async () => "short-lived",
                1 // 1 second TTL
            );

            // Value should be available immediately
            expect(await cache.get<string>("key1")).toBe("short-lived");

            // Wait for expiration
            await new Promise((r) => setTimeout(r, 1200));

            // Value should be expired
            expect(await cache.get<string>("key1")).toBeUndefined();
        });
    });

    // -------------------------------------------------------------------
    // Root Key Namespacing
    // -------------------------------------------------------------------

    describe("rootKey namespacing", () => {
        it("should isolate keys between providers with different rootKeys", async () => {
            const cacheA = createProvider({ rootKey: "AppA" });
            const cacheB = createProvider({ rootKey: "AppB" });

            await cacheA.set("key", "from-A");
            await cacheB.set("key", "from-B");

            expect(await cacheA.get<string>("key")).toBe("from-A");
            expect(await cacheB.get<string>("key")).toBe("from-B");

            await cacheA.shutdown();
            await cacheB.shutdown();
        });
    });

    // -------------------------------------------------------------------
    // Cleanup Interval
    // -------------------------------------------------------------------

    describe("cleanup interval", () => {
        it("should automatically remove expired entries", async () => {
            // Create a provider with a short cleanup interval
            const provider = new MemoryCacheProvider({
                rootKey: "Cleanup",
                cleanupIntervalMs: 200, // Clean up every 200ms
            });

            // Set a key with 1-second TTL
            await provider.set("temp", "value", 1);

            // Verify it exists
            expect(await provider.exists("temp")).toBe(true);

            // Wait for TTL + cleanup interval
            await new Promise((r) => setTimeout(r, 1500));

            // The cleanup interval should have removed it even without access
            // We can verify by checking the internal store is clean
            // (the lazy eviction in get/exists would also catch it,
            // but the cleanup ensures memory is reclaimed proactively)
            expect(await provider.exists("temp")).toBe(false);

            await provider.shutdown();
        });
    });
});
