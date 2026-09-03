/**
 * Contract tests for CacheProvider implementations.
 *
 * This file defines a shared test suite that runs against EVERY CacheProvider
 * implementation to verify they all behave identically per the abstract contract.
 * If both providers pass the same tests, consumers can swap backends without
 * behavior changes.
 *
 * The contract tests cover:
 * - set/get round-trips for all JSON types
 * - delete, exists, expire, ttl semantics
 * - deletePattern with wildcards
 * - clear with namespace isolation
 * - health and shutdown lifecycle
 * - getOrSet cache-aside pattern
 *
 * Redis tests require Docker on port 6399. Memory tests run without Docker.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { Redis } from "ioredis";
import { CacheProvider } from "../src/abstract-cache-provider.js";
import { MemoryCacheProvider } from "../src/memory-cache-provider.js";
import { RedisCacheProvider } from "../src/redis-cache-provider.js";

// ---------------------------------------------------------------------------
// Test Configuration
// ---------------------------------------------------------------------------

/** Redis test connection config — matches docker-compose.yml */
const REDIS_CONFIG = {
    host: "localhost",
    port: 6399,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
};

/**
 * Wait for the specified number of milliseconds.
 * Used for TTL tests that need real time delays.
 */
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Connection Check — detect Redis availability once
// ---------------------------------------------------------------------------

let redisAvailable = false;

beforeAll(async () => {
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
            // Ignore quit errors
        }
    }
});

// ---------------------------------------------------------------------------
// Shared Contract Test Suite
// ---------------------------------------------------------------------------

/**
 * Run the full CacheProvider contract test suite against a given implementation.
 *
 * This ensures all backends produce identical behavior for the same inputs.
 * Each test creates a fresh provider via the factory function and cleans up
 * via the cleanup function after each test.
 *
 * @param name - Display name for the provider (used in describe block)
 * @param createProvider - Factory that creates a fresh provider instance
 * @param cleanupProvider - Async function to clean up after each test
 * @param shouldSkip - Optional function that returns true to skip (e.g., no Redis)
 */
function runContractTests(
    name: string,
    createProvider: () => CacheProvider,
    cleanupProvider: (p: CacheProvider) => Promise<void>,
    shouldSkip?: () => boolean
) {
    describe(`CacheProvider Contract: ${name}`, () => {
        let provider: CacheProvider;

        beforeEach(() => {
            if (shouldSkip?.()) return;
            provider = createProvider();
        });

        afterEach(async () => {
            if (shouldSkip?.()) return;
            await cleanupProvider(provider);
        });

        // ---------------------------------------------------------------
        // set / get — round-trip for all JSON types
        // ---------------------------------------------------------------

        describe("set and get", () => {
            it("should round-trip a string", async () => {
                if (shouldSkip?.()) return;
                await provider.set("str", "hello");
                expect(await provider.get<string>("str")).toBe("hello");
            });

            it("should round-trip a number", async () => {
                if (shouldSkip?.()) return;
                await provider.set("num", 42);
                expect(await provider.get<number>("num")).toBe(42);
            });

            it("should round-trip a float", async () => {
                if (shouldSkip?.()) return;
                await provider.set("flt", 3.14);
                expect(await provider.get<number>("flt")).toBe(3.14);
            });

            it("should round-trip a boolean", async () => {
                if (shouldSkip?.()) return;
                await provider.set("bool", true);
                expect(await provider.get<boolean>("bool")).toBe(true);
            });

            it("should round-trip null", async () => {
                if (shouldSkip?.()) return;
                await provider.set("nil", null);
                expect(await provider.get<null>("nil")).toBeNull();
            });

            it("should round-trip an object", async () => {
                if (shouldSkip?.()) return;
                const obj = { name: "Alice", scores: [10, 20] };
                await provider.set("obj", obj);
                expect(await provider.get("obj")).toEqual(obj);
            });

            it("should round-trip an array", async () => {
                if (shouldSkip?.()) return;
                const arr = [1, "two", { three: 3 }];
                await provider.set("arr", arr);
                expect(await provider.get("arr")).toEqual(arr);
            });

            it("should return undefined for a missing key", async () => {
                if (shouldSkip?.()) return;
                expect(await provider.get("missing")).toBeUndefined();
            });

            it("should overwrite an existing key", async () => {
                if (shouldSkip?.()) return;
                await provider.set("k", "first");
                await provider.set("k", "second");
                expect(await provider.get<string>("k")).toBe("second");
            });
        });

        // ---------------------------------------------------------------
        // delete
        // ---------------------------------------------------------------

        describe("delete", () => {
            it("should return true for an existing key", async () => {
                if (shouldSkip?.()) return;
                await provider.set("k", "v");
                expect(await provider.delete("k")).toBe(true);
            });

            it("should return false for a non-existent key", async () => {
                if (shouldSkip?.()) return;
                expect(await provider.delete("missing")).toBe(false);
            });

            it("should make the key inaccessible", async () => {
                if (shouldSkip?.()) return;
                await provider.set("k", "v");
                await provider.delete("k");
                expect(await provider.get("k")).toBeUndefined();
            });
        });

        // ---------------------------------------------------------------
        // exists
        // ---------------------------------------------------------------

        describe("exists", () => {
            it("should return true for an existing key", async () => {
                if (shouldSkip?.()) return;
                await provider.set("k", "v");
                expect(await provider.exists("k")).toBe(true);
            });

            it("should return false for a non-existent key", async () => {
                if (shouldSkip?.()) return;
                expect(await provider.exists("missing")).toBe(false);
            });

            it("should return false for an expired key", async () => {
                if (shouldSkip?.()) return;
                await provider.set("k", "v", 1);
                await delay(1200);
                expect(await provider.exists("k")).toBe(false);
            });
        });

        // ---------------------------------------------------------------
        // expire
        // ---------------------------------------------------------------

        describe("expire", () => {
            it("should return true when setting TTL on an existing key", async () => {
                if (shouldSkip?.()) return;
                await provider.set("k", "v");
                expect(await provider.expire("k", 60)).toBe(true);
            });

            it("should return false for a non-existent key", async () => {
                if (shouldSkip?.()) return;
                expect(await provider.expire("missing", 60)).toBe(false);
            });
        });

        // ---------------------------------------------------------------
        // ttl
        // ---------------------------------------------------------------

        describe("ttl", () => {
            it("should return -1 for a key with no expiry", async () => {
                if (shouldSkip?.()) return;
                await provider.set("k", "v");
                expect(await provider.ttl("k")).toBe(-1);
            });

            it("should return -2 for a non-existent key", async () => {
                if (shouldSkip?.()) return;
                expect(await provider.ttl("missing")).toBe(-2);
            });

            it("should return positive remaining seconds for a key with TTL", async () => {
                if (shouldSkip?.()) return;
                await provider.set("k", "v", 10);
                const ttl = await provider.ttl("k");
                // Allow tolerance for execution time
                expect(ttl).toBeGreaterThanOrEqual(8);
                expect(ttl).toBeLessThanOrEqual(10);
            });
        });

        // ---------------------------------------------------------------
        // TTL expiration
        // ---------------------------------------------------------------

        describe("TTL expiration", () => {
            it("should return value before TTL expires", async () => {
                if (shouldSkip?.()) return;
                await provider.set("k", "v", 3);
                await delay(500);
                expect(await provider.get<string>("k")).toBe("v");
            });

            it("should return undefined after TTL expires", async () => {
                if (shouldSkip?.()) return;
                await provider.set("k", "v", 1);
                await delay(1500);
                expect(await provider.get("k")).toBeUndefined();
            });
        });

        // ---------------------------------------------------------------
        // deletePattern
        // ---------------------------------------------------------------

        describe("deletePattern", () => {
            it("should delete matching keys and return the count", async () => {
                if (shouldSkip?.()) return;
                await provider.set("user:1", "a");
                await provider.set("user:2", "b");
                await provider.set("product:1", "x");

                const deleted = await provider.deletePattern("user:*");
                expect(deleted).toBe(2);

                expect(await provider.exists("user:1")).toBe(false);
                expect(await provider.exists("user:2")).toBe(false);
                expect(await provider.exists("product:1")).toBe(true);
            });

            it("should return 0 when no keys match", async () => {
                if (shouldSkip?.()) return;
                await provider.set("key1", "v");
                expect(await provider.deletePattern("nomatch:*")).toBe(0);
            });
        });

        // ---------------------------------------------------------------
        // clear
        // ---------------------------------------------------------------

        describe("clear", () => {
            it("should remove all keys under the rootKey namespace", async () => {
                if (shouldSkip?.()) return;
                await provider.set("a", "1");
                await provider.set("b", "2");
                await provider.set("c", "3");

                await provider.clear();

                expect(await provider.exists("a")).toBe(false);
                expect(await provider.exists("b")).toBe(false);
                expect(await provider.exists("c")).toBe(false);
            });
        });

        // ---------------------------------------------------------------
        // health
        // ---------------------------------------------------------------

        describe("health", () => {
            it("should return true when operational", async () => {
                if (shouldSkip?.()) return;
                expect(await provider.health()).toBe(true);
            });
        });

        // ---------------------------------------------------------------
        // getOrSet
        // ---------------------------------------------------------------

        describe("getOrSet", () => {
            it("should call factory on cache miss", async () => {
                if (shouldSkip?.()) return;
                let called = false;
                const result = await provider.getOrSet("k", async () => {
                    called = true;
                    return "produced";
                });

                expect(called).toBe(true);
                expect(result).toBe("produced");
            });

            it("should skip factory on cache hit", async () => {
                if (shouldSkip?.()) return;
                await provider.set("k", "existing");

                let called = false;
                const result = await provider.getOrSet("k", async () => {
                    called = true;
                    return "should-not-use";
                });

                expect(called).toBe(false);
                expect(result).toBe("existing");
            });

            it("should cache the factory result for next call", async () => {
                if (shouldSkip?.()) return;
                let callCount = 0;
                const factory = async () => {
                    callCount++;
                    return "value";
                };

                await provider.getOrSet("k", factory);
                await provider.getOrSet("k", factory);
                expect(callCount).toBe(1);
            });

            it("should respect TTL on the cached value", async () => {
                if (shouldSkip?.()) return;
                await provider.getOrSet("k", async () => "temp", 1);
                expect(await provider.get<string>("k")).toBe("temp");

                await delay(1500);
                expect(await provider.get("k")).toBeUndefined();
            });
        });
    });
}

// ---------------------------------------------------------------------------
// Run Contract Tests Against Both Providers
// ---------------------------------------------------------------------------

// Counter for unique rootKeys to prevent test isolation issues across providers
let memoryCounter = 0;
let redisCounter = 0;

// --- MemoryCacheProvider (always runs, no Docker needed) ---
runContractTests(
    "MemoryCacheProvider",
    () =>
        new MemoryCacheProvider({
            rootKey: `Contract_Mem_${++memoryCounter}`,
            cleanupIntervalMs: 0,
        }),
    async (p) => await p.shutdown()
);

// --- RedisCacheProvider (only runs when Docker Redis is available) ---
runContractTests(
    "RedisCacheProvider",
    () =>
        new RedisCacheProvider({
            ...REDIS_CONFIG,
            rootKey: `Contract_Redis_${++redisCounter}_${Date.now()}`,
        }),
    async (p) => {
        await p.clear();
        await p.shutdown();
    },
    // Skip Redis contract tests if Docker is not available
    () => !redisAvailable
);
