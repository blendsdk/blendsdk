/**
 * Unit tests for cache plugin factory functions.
 *
 * No Docker required — uses MemoryCacheProvider for all plugin tests.
 * Covers createCachePlugin, redisCachePlugin, memoryCachePlugin, and createCache.
 */

import { describe, it, expect, afterEach } from "vitest";
import { CacheProvider } from "../src/abstract-cache-provider.js";
import {
    createCache,
    createCachePlugin,
    memoryCachePlugin,
    redisCachePlugin,
} from "../src/cache-plugin.js";
import { MemoryCacheProvider } from "../src/memory-cache-provider.js";
import { RedisCacheProvider } from "../src/redis-cache-provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a simple in-memory provider for testing (no cleanup interval) */
function createTestProvider(overrides?: { rootKey?: string; serviceName?: string }) {
    return new MemoryCacheProvider({
        rootKey: overrides?.rootKey ?? "PluginTest",
        serviceName: overrides?.serviceName,
        cleanupIntervalMs: 0,
    });
}

// Track providers to clean up after tests
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCachePlugin", () => {
    it("should return a valid PluginDefinition with name, factory, and priority", () => {
        const provider = createTestProvider();
        providersToCleanup.push(provider);

        const plugin = createCachePlugin(provider);

        expect(plugin).toBeDefined();
        expect(plugin.name).toBe("cache"); // Default serviceName
        expect(typeof plugin.factory).toBe("function");
        expect(plugin.priority).toBe(30); // Default priority
    });

    it("should use provider.serviceName as the plugin name", () => {
        const provider = createTestProvider({ serviceName: "my-cache" });
        providersToCleanup.push(provider);

        const plugin = createCachePlugin(provider);

        expect(plugin.name).toBe("my-cache");
    });

    it("should use default priority of 30 when not specified", () => {
        const provider = createTestProvider();
        providersToCleanup.push(provider);

        const plugin = createCachePlugin(provider);

        expect(plugin.priority).toBe(30);
    });

    it("should accept custom priority via options", () => {
        const provider = createTestProvider();
        providersToCleanup.push(provider);

        const plugin = createCachePlugin(provider, { priority: 10 });

        expect(plugin.priority).toBe(10);
    });

    it("should accept priority of 0", () => {
        const provider = createTestProvider();
        providersToCleanup.push(provider);

        const plugin = createCachePlugin(provider, { priority: 0 });

        expect(plugin.priority).toBe(0);
    });
});

describe("memoryCachePlugin", () => {
    it("should return a valid PluginDefinition", () => {
        const plugin = memoryCachePlugin({ rootKey: "TestApp" });

        expect(plugin).toBeDefined();
        expect(plugin.name).toBe("cache");
        expect(typeof plugin.factory).toBe("function");
        expect(plugin.priority).toBe(30);
    });

    it("should respect custom serviceName", () => {
        const plugin = memoryCachePlugin({ rootKey: "TestApp", serviceName: "mem-cache" });

        expect(plugin.name).toBe("mem-cache");
    });
});

describe("redisCachePlugin", () => {
    it("should return a valid PluginDefinition", () => {
        // Note: This creates a Redis client that will try to connect.
        // We don't call factory(), so the connection attempt is just in the background.
        const plugin = redisCachePlugin({
            rootKey: "TestApp",
            host: "localhost",
            port: 6399,
            // Set max retries to 0 to prevent reconnection attempts in tests
            maxRetriesPerRequest: 0,
        });

        expect(plugin).toBeDefined();
        expect(plugin.name).toBe("cache");
        expect(typeof plugin.factory).toBe("function");
        expect(plugin.priority).toBe(30);
    });

    it("should respect custom serviceName", () => {
        const plugin = redisCachePlugin({
            rootKey: "TestApp",
            host: "localhost",
            port: 6399,
            serviceName: "redis-cache",
            maxRetriesPerRequest: 0,
        });

        expect(plugin.name).toBe("redis-cache");
    });
});

describe("createCache", () => {
    it("should return MemoryCacheProvider for type='memory'", () => {
        const cache = createCache({
            type: "memory",
            rootKey: "TestApp",
        });
        providersToCleanup.push(cache);

        expect(cache).toBeInstanceOf(MemoryCacheProvider);
    });

    it("should return RedisCacheProvider for type='redis'", () => {
        const cache = createCache({
            type: "redis",
            rootKey: "TestApp",
            host: "localhost",
            port: 6399,
            maxRetriesPerRequest: 0,
        });
        providersToCleanup.push(cache);

        expect(cache).toBeInstanceOf(RedisCacheProvider);
    });

    it("should pass serviceName through to the provider", () => {
        const cache = createCache({
            type: "memory",
            rootKey: "TestApp",
            serviceName: "my-cache",
        });
        providersToCleanup.push(cache);

        expect(cache.serviceName).toBe("my-cache");
    });

    it("should pass defaultTTL through to the provider", async () => {
        const cache = createCache({
            type: "memory",
            rootKey: "TestApp",
            defaultTTL: 60,
        });
        providersToCleanup.push(cache);

        // Set without explicit TTL — should use defaultTTL
        await cache.set("key1", "value");
        const ttl = await cache.ttl("key1");
        // Should have a TTL around 60 seconds
        expect(ttl).toBeGreaterThan(50);
        expect(ttl).toBeLessThanOrEqual(60);
    });

    it("should throw for unknown cache type", () => {
        expect(() =>
            createCache({
                type: "postgres" as "redis",
                rootKey: "TestApp",
            })
        ).toThrow('Unknown cache type: "postgres"');
    });

    it("should include supported types in the error message", () => {
        expect(() =>
            createCache({
                type: "invalid" as "redis",
                rootKey: "TestApp",
            })
        ).toThrow('Supported types: "redis", "memory"');
    });
});
