/**
 * Implementation tests for the memory subpath re-export integrity.
 *
 * The memory entry point must expose the same provider classes and builders as
 * the main entry (shared identity), must not leak the Redis providers, and must
 * build working memory plugins.
 *
 * @packageDocumentation
 */

import { describe, expect, it, vi } from "vitest";

describe("memory subpath — implementation edge cases", () => {
    it("shares provider and builder identities with the main entry", async () => {
        const memory = await import("../src/memory.js");
        const main = await import("../src/index.js");

        expect(memory.MemoryCacheProvider).toBe(main.MemoryCacheProvider);
        expect(memory.MemoryPubSubProvider).toBe(main.MemoryPubSubProvider);
        expect(memory.CacheProvider).toBe(main.CacheProvider);
        expect(memory.PubSubProvider).toBe(main.PubSubProvider);
        expect(memory.createCachePlugin).toBe(main.createCachePlugin);
        expect(memory.createPubSubPlugin).toBe(main.createPubSubPlugin);
        expect(memory.memoryCachePlugin).toBe(main.memoryCachePlugin);
        expect(memory.memoryPubSubPlugin).toBe(main.memoryPubSubPlugin);
    });

    it("does not expose the Redis providers", async () => {
        const memory = await import("../src/memory.js");

        expect("RedisCacheProvider" in memory).toBe(false);
        expect("RedisPubSubProvider" in memory).toBe(false);
    });

    it("wires a memory provider through the plugin factory", async () => {
        const memory = await import("../src/memory.js");
        const registerService = vi.fn();
        const plugin = memory.memoryPubSubPlugin();

        await plugin.factory({
            app: { registerService } as never,
            express: {} as never,
            logger: { info: async () => {} } as never,
        });

        expect(registerService).toHaveBeenCalledTimes(1);
        const registration = registerService.mock.calls[0][0] as {
            factory: () => unknown;
        };
        expect(registration.factory()).toBeInstanceOf(memory.MemoryPubSubProvider);
    });
});
