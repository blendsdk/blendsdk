/**
 * TTL behavior tests for CacheProvider implementations.
 *
 * Dedicated timing tests that verify TTL expiration, expire() resets,
 * defaultTTL behavior, and getOrSet caching with TTL — run against both
 * MemoryCacheProvider and RedisCacheProvider.
 *
 * These tests use short TTLs (1-3 seconds) with generous margins (+200ms)
 * to prevent CI flakiness while still verifying real timing behavior.
 * Redis tests require Docker on port 6399; they auto-skip when unavailable.
 *
 * @see 07-testing-strategy.md — TTL Behavior Tests section
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { Redis } from "ioredis";
import type { CacheProvider } from "../src/abstract-cache-provider.js";
import { MemoryCacheProvider } from "../src/memory-cache-provider.js";
import { RedisCacheProvider } from "../src/redis-cache-provider.js";

// ---------------------------------------------------------------------------
// Test Configuration
// ---------------------------------------------------------------------------

/** Redis test connection config — matches docker-compose.yml (port 6399) */
const REDIS_CONFIG = {
    host: "localhost",
    port: 6399,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
};

/**
 * Wait for the specified number of milliseconds.
 * Used for real-time TTL tests where both Redis and Memory need actual delays.
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
            // Ignore quit errors during availability check
        }
    }
});

// ---------------------------------------------------------------------------
// Shared TTL Behavior Test Suite
// ---------------------------------------------------------------------------

/**
 * Run TTL-specific timing tests against a CacheProvider implementation.
 *
 * All 10 tests cover real timing behavior with short TTLs (1-3 seconds)
 * and generous margins to avoid flakiness. Both providers are tested
 * with real delays (no fake timers) since Redis manages TTL natively.
 *
 * @param name - Display name for the provider (used in describe block)
 * @param createProvider - Factory to create a fresh provider (no defaultTTL)
 * @param createProviderWithDefaultTTL - Factory to create a provider with defaultTTL set
 * @param cleanupProvider - Async function to clean up after each test
 * @param shouldSkip - Optional function that returns true to skip all tests
 */
function runTTLBehaviorTests(
    name: string,
    createProvider: () => CacheProvider,
    createProviderWithDefaultTTL: (ttl: number) => CacheProvider,
    cleanupProvider: (p: CacheProvider) => Promise<void>,
    shouldSkip?: () => boolean
) {
    describe(`TTL Behavior: ${name}`, () => {
        let provider: CacheProvider;

        afterEach(async () => {
            if (shouldSkip?.()) return;
            if (provider) {
                await cleanupProvider(provider);
            }
        });

        // ---------------------------------------------------------------
        // Immediate availability
        // ---------------------------------------------------------------

        it("should make value available immediately after set", async () => {
            if (shouldSkip?.()) return;
            provider = createProvider();

            // Set with a 3-second TTL and retrieve immediately — no delay
            await provider.set("key", "immediate-value", 3);
            const result = await provider.get<string>("key");

            expect(result).toBe("immediate-value");
        });

        // ---------------------------------------------------------------
        // Value at 50% TTL
        // ---------------------------------------------------------------

        it("should return value at 50% of TTL duration", async () => {
            if (shouldSkip?.()) return;
            provider = createProvider();

            // 2-second TTL, check at 1 second (50%)
            await provider.set("key", "halfway-value", 2);
            await delay(1000);

            const result = await provider.get<string>("key");
            expect(result).toBe("halfway-value");
        });

        // ---------------------------------------------------------------
        // Value gone after TTL
        // ---------------------------------------------------------------

        it("should return undefined after TTL expires", async () => {
            if (shouldSkip?.()) return;
            provider = createProvider();

            // 1-second TTL, wait 1.2 seconds (TTL + 200ms margin)
            await provider.set("key", "expired-value", 1);
            await delay(1200);

            const result = await provider.get("key");
            expect(result).toBeUndefined();
        });

        // ---------------------------------------------------------------
        // TTL decreases over time
        // ---------------------------------------------------------------

        it("should return decreasing TTL values over time", async () => {
            if (shouldSkip?.()) return;
            provider = createProvider();

            // 3-second TTL — check TTL at multiple time points
            await provider.set("key", "data", 3);

            const ttlStart = await provider.ttl("key");
            // TTL should be close to 3 at the start
            expect(ttlStart).toBeGreaterThanOrEqual(2);
            expect(ttlStart).toBeLessThanOrEqual(3);

            // Wait 1 second and check again
            await delay(1000);
            const ttlMid = await provider.ttl("key");
            // Should have decreased — now around 2
            expect(ttlMid).toBeGreaterThanOrEqual(1);
            expect(ttlMid).toBeLessThanOrEqual(2);

            // TTL at midpoint should be less than TTL at start
            expect(ttlMid).toBeLessThan(ttlStart);
        });

        // ---------------------------------------------------------------
        // expire() resets TTL: short → long
        // ---------------------------------------------------------------

        it("should extend lifetime when expire resets TTL from short to long", async () => {
            if (shouldSkip?.()) return;
            provider = createProvider();

            // Start with a 1-second TTL
            await provider.set("key", "extend-me", 1);

            // Immediately extend to 3 seconds
            const result = await provider.expire("key", 3);
            expect(result).toBe(true);

            // Wait past the original 1-second TTL — value should still exist
            await delay(1200);
            const value = await provider.get<string>("key");
            expect(value).toBe("extend-me");

            // TTL should still be positive (about 1-2 seconds remaining)
            const ttl = await provider.ttl("key");
            expect(ttl).toBeGreaterThanOrEqual(1);
        });

        // ---------------------------------------------------------------
        // expire() resets TTL: long → short
        // ---------------------------------------------------------------

        it("should shorten lifetime when expire resets TTL from long to short", async () => {
            if (shouldSkip?.()) return;
            provider = createProvider();

            // Start with a 10-second TTL
            await provider.set("key", "shorten-me", 10);

            // Immediately shorten to 1 second
            const result = await provider.expire("key", 1);
            expect(result).toBe(true);

            // Wait for the shortened TTL to expire
            await delay(1200);
            const value = await provider.get("key");
            expect(value).toBeUndefined();
        });

        // ---------------------------------------------------------------
        // defaultTTL applied when no explicit TTL
        // ---------------------------------------------------------------

        it("should use defaultTTL when no explicit TTL is provided", async () => {
            if (shouldSkip?.()) return;

            // Create provider with 2-second defaultTTL
            provider = createProviderWithDefaultTTL(2);

            // Set without explicit TTL — should use defaultTTL of 2 seconds
            await provider.set("key", "default-ttl-value");

            // Verify TTL is approximately 2 seconds
            const ttl = await provider.ttl("key");
            expect(ttl).toBeGreaterThanOrEqual(1);
            expect(ttl).toBeLessThanOrEqual(2);

            // Value should be gone after 2 seconds + margin
            await delay(2200);
            const value = await provider.get("key");
            expect(value).toBeUndefined();
        });

        // ---------------------------------------------------------------
        // Explicit TTL overrides defaultTTL
        // ---------------------------------------------------------------

        it("should use explicit TTL over defaultTTL when provided", async () => {
            if (shouldSkip?.()) return;

            // Create provider with 10-second defaultTTL
            provider = createProviderWithDefaultTTL(10);

            // Set with explicit 1-second TTL — should override the 10-second default
            await provider.set("key", "explicit-ttl-value", 1);

            // TTL should be around 1, not 10
            const ttl = await provider.ttl("key");
            expect(ttl).toBeLessThanOrEqual(1);
            expect(ttl).toBeGreaterThanOrEqual(0);

            // Value should expire after 1 second, not 10
            await delay(1200);
            const value = await provider.get("key");
            expect(value).toBeUndefined();
        });

        // ---------------------------------------------------------------
        // TTL=0 means no expiry (overrides defaultTTL)
        // ---------------------------------------------------------------

        it("should persist indefinitely when TTL=0 overrides defaultTTL", async () => {
            if (shouldSkip?.()) return;

            // Create provider with 1-second defaultTTL
            provider = createProviderWithDefaultTTL(1);

            // Set with explicit TTL=0 — should override defaultTTL, meaning no expiry
            await provider.set("key", "no-expiry-value", 0);

            // Wait past the defaultTTL
            await delay(1500);

            // Value should still be there because TTL=0 means no expiry
            const value = await provider.get<string>("key");
            expect(value).toBe("no-expiry-value");

            // TTL should be -1 (no expiry), not -2 (missing)
            const ttl = await provider.ttl("key");
            expect(ttl).toBe(-1);
        });

        // ---------------------------------------------------------------
        // getOrSet caches with correct TTL
        // ---------------------------------------------------------------

        it("should cache getOrSet result with the specified TTL", async () => {
            if (shouldSkip?.()) return;
            provider = createProvider();

            // Use getOrSet with a 1-second TTL
            const result = await provider.getOrSet(
                "key",
                async () => "factory-value",
                1
            );
            expect(result).toBe("factory-value");

            // Value should be cached immediately
            const cached = await provider.get<string>("key");
            expect(cached).toBe("factory-value");

            // TTL should be around 1 second
            const ttl = await provider.ttl("key");
            expect(ttl).toBeGreaterThanOrEqual(0);
            expect(ttl).toBeLessThanOrEqual(1);

            // Wait for TTL to expire
            await delay(1200);
            const expired = await provider.get("key");
            expect(expired).toBeUndefined();
        });
    });
}

// ---------------------------------------------------------------------------
// Run TTL Behavior Tests Against Both Providers
// ---------------------------------------------------------------------------

// Counters for unique rootKeys to prevent test isolation issues
let memoryCounter = 0;
let redisCounter = 0;

// --- MemoryCacheProvider (always runs, no Docker needed) ---
runTTLBehaviorTests(
    "MemoryCacheProvider",
    () =>
        new MemoryCacheProvider({
            rootKey: `TTL_Mem_${++memoryCounter}`,
            cleanupIntervalMs: 0, // Disable cleanup timer — rely on lazy eviction
        }),
    (defaultTTL: number) =>
        new MemoryCacheProvider({
            rootKey: `TTL_Mem_DefTTL_${++memoryCounter}`,
            defaultTTL,
            cleanupIntervalMs: 0,
        }),
    async (p) => await p.shutdown()
);

// --- RedisCacheProvider (only runs when Docker Redis is available) ---
runTTLBehaviorTests(
    "RedisCacheProvider",
    () =>
        new RedisCacheProvider({
            ...REDIS_CONFIG,
            rootKey: `TTL_Redis_${++redisCounter}_${Date.now()}`,
        }),
    (defaultTTL: number) =>
        new RedisCacheProvider({
            ...REDIS_CONFIG,
            rootKey: `TTL_Redis_DefTTL_${++redisCounter}_${Date.now()}`,
            defaultTTL,
        }),
    async (p) => {
        await p.clear();
        await p.shutdown();
    },
    // Skip Redis TTL tests if Docker is not available
    () => !redisAvailable
);
