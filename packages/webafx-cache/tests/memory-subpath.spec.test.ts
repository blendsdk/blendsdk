/**
 * Specification tests for the Redis-free memory entry point.
 *
 * Importing the memory subpath must not load the Redis client, and it must
 * expose usable in-memory cache and pub/sub providers plus their plugin
 * factories.
 *
 * @packageDocumentation
 */

import { describe, expect, it, vi } from "vitest";

/** Records whether a Redis module was evaluated. */
const { recordRedisLoad } = vi.hoisted(() => ({
    recordRedisLoad: vi.fn(),
}));

vi.mock("ioredis", () => {
    recordRedisLoad();
    return { Redis: class RedisStub {} };
});

describe("webafx-cache memory subpath — Specification Tests", () => {
    it("imports without loading ioredis (ST-38)", async () => {
        await import("../src/memory.js");

        expect(recordRedisLoad).not.toHaveBeenCalled();
    });

    it("exposes a usable MemoryCacheProvider (ST-39)", async () => {
        const { MemoryCacheProvider, CacheProvider } = await import("../src/memory.js");

        const provider = new MemoryCacheProvider({ rootKey: "Test" });
        expect(provider).toBeInstanceOf(CacheProvider);
    });

    it("exposes a memory cache plugin factory (ST-40)", async () => {
        const { memoryCachePlugin } = await import("../src/memory.js");

        const plugin = memoryCachePlugin({ rootKey: "Test" });
        expect(plugin.name).toBeTruthy();
        expect(typeof plugin.factory).toBe("function");
    });
});
