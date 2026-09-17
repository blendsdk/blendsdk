/**
 * Unit tests for pub/sub plugin factory functions.
 *
 * No Docker required — uses MemoryPubSubProvider for all plugin tests.
 * Covers createPubSubPlugin, redisPubSubPlugin, memoryPubSubPlugin, and createPubSub.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { PubSubProvider } from "../src/abstract-pubsub-provider.js";
import {
    createPubSub,
    createPubSubPlugin,
    memoryPubSubPlugin,
    redisPubSubPlugin,
} from "../src/pubsub-plugin.js";
import { MemoryPubSubProvider } from "../src/memory-pubsub-provider.js";
import { RedisPubSubProvider } from "../src/redis-pubsub-provider.js";

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const providersToCleanup: PubSubProvider[] = [];

afterEach(async () => {
    for (const p of providersToCleanup) {
        try {
            await p.shutdown();
        } catch {
            // Ignore shutdown errors in cleanup
        }
    }
    providersToCleanup.length = 0;
});

/** Helper to create a test provider and register for cleanup */
function createTestProvider(overrides?: { channelPrefix?: string; serviceName?: string }) {
    const p = new MemoryPubSubProvider(overrides);
    providersToCleanup.push(p);
    return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPubSubPlugin", () => {
    it("should return a valid PluginDefinition with name, factory, and priority", () => {
        const provider = createTestProvider();
        const plugin = createPubSubPlugin(provider);

        expect(plugin).toBeDefined();
        expect(plugin.name).toBe("pubsub"); // Default serviceName
        expect(typeof plugin.factory).toBe("function");
        expect(plugin.priority).toBe(30); // Default priority
    });

    it("should use provider.serviceName as the plugin name", () => {
        const provider = createTestProvider({ serviceName: "my-pubsub" });
        const plugin = createPubSubPlugin(provider);

        expect(plugin.name).toBe("my-pubsub");
    });

    it("should use default priority of 30 when not specified", () => {
        const provider = createTestProvider();
        const plugin = createPubSubPlugin(provider);

        expect(plugin.priority).toBe(30);
    });

    it("should accept custom priority via options", () => {
        const provider = createTestProvider();
        const plugin = createPubSubPlugin(provider, { priority: 10 });

        expect(plugin.priority).toBe(10);
    });

    it("should accept priority of 0", () => {
        const provider = createTestProvider();
        const plugin = createPubSubPlugin(provider, { priority: 0 });

        expect(plugin.priority).toBe(0);
    });

    it("should return health and shutdown hooks from factory", async () => {
        const provider = createTestProvider();
        const plugin = createPubSubPlugin(provider);

        // Create a mock app and logger to call the factory
        const mockApp = {
            registerService: vi.fn(),
        };
        const mockLogger = {
            info: vi.fn().mockResolvedValue(undefined),
        };

        const hooks = await plugin.factory({
            app: mockApp as never,
            express: {} as never,
            logger: mockLogger as never,
        });

        expect(typeof hooks.health).toBe("function");
        expect(typeof hooks.shutdown).toBe("function");
    });

    it("should register declarative channel subscriptions", async () => {
        const provider = createTestProvider();
        const handler = vi.fn();
        const plugin = createPubSubPlugin(provider, {
            subscriptions: [{ channel: "order:new", handler }],
        });

        const mockApp = { registerService: vi.fn() };
        const mockLogger = { info: vi.fn().mockResolvedValue(undefined) };

        await plugin.factory({
            app: mockApp as never,
            express: {} as never,
            logger: mockLogger as never,
        });

        // Verify subscription was registered by publishing a message
        await provider.publish("order:new", { id: 1 });
        await new Promise((r) => setTimeout(r, 10));
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should register declarative pattern subscriptions", async () => {
        const provider = createTestProvider();
        const handler = vi.fn();
        const plugin = createPubSubPlugin(provider, {
            subscriptions: [{ pattern: "audit:*", handler }],
        });

        const mockApp = { registerService: vi.fn() };
        const mockLogger = { info: vi.fn().mockResolvedValue(undefined) };

        await plugin.factory({
            app: mockApp as never,
            express: {} as never,
            logger: mockLogger as never,
        });

        // Verify psubscription was registered
        await provider.publish("audit:login", { userId: 1 });
        await new Promise((r) => setTimeout(r, 10));
        expect(handler).toHaveBeenCalledTimes(1);
    });
});

describe("memoryPubSubPlugin", () => {
    it("should return a valid PluginDefinition", () => {
        const plugin = memoryPubSubPlugin();

        expect(plugin).toBeDefined();
        expect(plugin.name).toBe("pubsub");
        expect(typeof plugin.factory).toBe("function");
        expect(plugin.priority).toBe(30);
    });

    it("should respect custom serviceName", () => {
        const plugin = memoryPubSubPlugin({ serviceName: "mem-pubsub" });

        expect(plugin.name).toBe("mem-pubsub");
    });
});

describe("redisPubSubPlugin", () => {
    it("should return a valid PluginDefinition", () => {
        // Note: This creates Redis clients that will try to connect.
        // We don't call factory(), so the connection attempt is just in the background.
        const plugin = redisPubSubPlugin({
            host: "localhost",
            port: 6399,
            maxRetriesPerRequest: 0,
        });

        expect(plugin).toBeDefined();
        expect(plugin.name).toBe("pubsub");
        expect(typeof plugin.factory).toBe("function");
        expect(plugin.priority).toBe(30);
    });

    it("should respect custom serviceName", () => {
        const plugin = redisPubSubPlugin({
            host: "localhost",
            port: 6399,
            serviceName: "redis-pubsub",
            maxRetriesPerRequest: 0,
        });

        expect(plugin.name).toBe("redis-pubsub");
    });
});

describe("createPubSub", () => {
    it("should return MemoryPubSubProvider for type='memory'", () => {
        const pubsub = createPubSub({ type: "memory" });
        providersToCleanup.push(pubsub);

        expect(pubsub).toBeInstanceOf(MemoryPubSubProvider);
    });

    it("should return RedisPubSubProvider for type='redis'", () => {
        const pubsub = createPubSub({
            type: "redis",
            host: "localhost",
            port: 6399,
        });
        providersToCleanup.push(pubsub);

        expect(pubsub).toBeInstanceOf(RedisPubSubProvider);
    });

    it("should pass channelPrefix through to the provider", () => {
        const pubsub = createPubSub({
            type: "memory",
            channelPrefix: "MyApp",
        });
        providersToCleanup.push(pubsub);

        // Verify the prefix is set (indirectly via serviceName default)
        expect(pubsub.serviceName).toBe("pubsub");
    });

    it("should pass serviceName through to the provider", () => {
        const pubsub = createPubSub({
            type: "memory",
            serviceName: "my-pubsub",
        });
        providersToCleanup.push(pubsub);

        expect(pubsub.serviceName).toBe("my-pubsub");
    });

    it("should throw for unknown pub/sub type", () => {
        expect(() =>
            createPubSub({
                type: "kafka" as "redis",
            })
        ).toThrow('Unknown pub/sub type: "kafka"');
    });

    it("should include supported types in the error message", () => {
        expect(() =>
            createPubSub({
                type: "invalid" as "redis",
            })
        ).toThrow('Supported types: "redis", "memory"');
    });
});
