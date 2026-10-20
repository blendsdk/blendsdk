/**
 * Contract tests for PubSubProvider implementations.
 *
 * Runs the same test suite against BOTH MemoryPubSubProvider and RedisPubSubProvider
 * to verify they behave identically per the abstract contract. If both providers pass
 * the same tests, consumers can swap backends without behavior changes.
 *
 * The contract tests cover:
 * - publish/subscribe exact channel delivery
 * - publish returns subscriber count
 * - publish to no subscribers returns 0
 * - subscribe/unsubscribe lifecycle
 * - psubscribe/punsubscribe lifecycle
 * - multiple handler fan-out
 * - handler error isolation
 * - typed message preservation
 * - activeSubscriptions accuracy
 * - health check
 * - shutdown clears state
 * - pattern message includes pattern field
 * - channel prefix transparency
 *
 * Redis tests require Docker on port 6399. Memory tests run without Docker.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { Redis } from "ioredis";
import { PubSubProvider } from "../src/abstract-pubsub-provider.js";
import { MemoryPubSubProvider } from "../src/memory-pubsub-provider.js";
import { RedisPubSubProvider } from "../src/redis-pubsub-provider.js";
import type { PubSubMessage, MessageHandler } from "../src/types.js";

// ---------------------------------------------------------------------------
// Test Configuration
// ---------------------------------------------------------------------------

const REDIS_CONFIG = {
    host: "localhost",
    port: 6399,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
};

// ---------------------------------------------------------------------------
// Connection Check
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
            // Ignore
        }
    }
});

// ---------------------------------------------------------------------------
// Test Types & Data
// ---------------------------------------------------------------------------

interface TestOrder {
    id: number;
    total: number;
    customer: string;
}

const sampleOrder: TestOrder = { id: 1, total: 99.99, customer: "Alice" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait for a pub/sub message to be delivered.
 * Works for both Memory (sync) and Redis (async) providers.
 */
function waitForMessage<T = unknown>(timeout = 2000): {
    promise: Promise<PubSubMessage<T>>;
    handler: MessageHandler<T>;
} {
    let resolve: (msg: PubSubMessage<T>) => void;
    const promise = new Promise<PubSubMessage<T>>((r, reject) => {
        resolve = r;
        setTimeout(() => reject(new Error("Timeout waiting for message")), timeout);
    });
    const handler: MessageHandler<T> = (msg) => resolve!(msg);
    return { promise, handler };
}

/**
 * Small delay to allow Redis subscriptions to establish and messages to deliver.
 * Memory provider doesn't need this, but it doesn't hurt.
 */
function settle(ms = 150): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Contract Test Suite
// ---------------------------------------------------------------------------

let testCounter = 0;

function runPubSubContractTests(
    name: string,
    createProvider: () => PubSubProvider,
    cleanupProvider: (p: PubSubProvider) => Promise<void>,
    shouldSkip?: () => boolean
) {
    describe(`PubSubProvider Contract: ${name}`, () => {
        let provider: PubSubProvider;

        beforeEach(() => {
            if (shouldSkip?.()) return;
            provider = createProvider();
        });

        afterEach(async () => {
            if (shouldSkip?.()) return;
            await cleanupProvider(provider);
        });

        // ---------------------------------------------------------------
        // publish / subscribe
        // ---------------------------------------------------------------

        describe("publish and subscribe", () => {
            it("should deliver message to exact channel subscriber", async () => {
                if (shouldSkip?.()) return;
                const { promise, handler } = waitForMessage<TestOrder>();

                await provider.subscribe<TestOrder>("order:new", handler);
                await settle();
                await provider.publish("order:new", sampleOrder);

                const msg = await promise;
                expect(msg.channel).toBe("order:new");
                expect(msg.data).toEqual(sampleOrder);
            });

            it("should return subscriber count from publish", async () => {
                if (shouldSkip?.()) return;
                await provider.subscribe("ch", vi.fn());
                await settle();

                const count = await provider.publish("ch", "data");
                expect(count).toBeGreaterThanOrEqual(1);
            });

            it("should return 0 when publishing to no subscribers", async () => {
                if (shouldSkip?.()) return;
                const count = await provider.publish("nobody", "data");
                expect(count).toBe(0);
            });
        });

        // ---------------------------------------------------------------
        // subscribe / unsubscribe lifecycle
        // ---------------------------------------------------------------

        describe("subscribe and unsubscribe", () => {
            it("should stop delivery after unsubscribe", async () => {
                if (shouldSkip?.()) return;
                const handler = vi.fn();

                await provider.subscribe("ch", handler);
                await settle();
                await provider.unsubscribe("ch");
                await settle(50);

                await provider.publish("ch", "data");
                await settle();

                expect(handler).not.toHaveBeenCalled();
            });
        });

        // ---------------------------------------------------------------
        // psubscribe / punsubscribe lifecycle
        // ---------------------------------------------------------------

        describe("psubscribe and punsubscribe", () => {
            it("should deliver to pattern subscriber", async () => {
                if (shouldSkip?.()) return;
                const { promise, handler } = waitForMessage();

                await provider.psubscribe("order:*", handler);
                await settle();
                await provider.publish("order:created", { id: 1 });

                const msg = await promise;
                expect(msg.channel).toBe("order:created");
            });

            it("should stop pattern delivery after punsubscribe", async () => {
                if (shouldSkip?.()) return;
                const handler = vi.fn();

                await provider.psubscribe("order:*", handler);
                await settle();
                await provider.punsubscribe("order:*");
                await settle(50);

                await provider.publish("order:created", { id: 1 });
                await settle();

                expect(handler).not.toHaveBeenCalled();
            });
        });

        // ---------------------------------------------------------------
        // Fan-out: multiple handlers
        // ---------------------------------------------------------------

        describe("multiple handlers", () => {
            it("should deliver to all handlers (fan-out)", async () => {
                if (shouldSkip?.()) return;
                const { promise: p1, handler: h1 } = waitForMessage();
                const { promise: p2, handler: h2 } = waitForMessage();

                await provider.subscribe("events", h1);
                await provider.subscribe("events", h2);
                await settle();

                await provider.publish("events", "broadcast");

                const [m1, m2] = await Promise.all([p1, p2]);
                expect(m1.data).toBe("broadcast");
                expect(m2.data).toBe("broadcast");
            });
        });

        // ---------------------------------------------------------------
        // Error isolation
        // ---------------------------------------------------------------

        describe("error isolation", () => {
            it("should catch handler errors and still deliver to others", async () => {
                if (shouldSkip?.()) return;
                const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

                const badHandler: MessageHandler = () => {
                    throw new Error("contract test boom");
                };
                const { promise, handler: goodHandler } = waitForMessage();

                await provider.subscribe("ch", badHandler);
                await provider.subscribe("ch", goodHandler);
                await settle();

                await provider.publish("ch", "data");
                const msg = await promise;

                expect(msg.data).toBe("data");
                expect(errorSpy).toHaveBeenCalled();
                errorSpy.mockRestore();
            });
        });

        // ---------------------------------------------------------------
        // Typed message preservation
        // ---------------------------------------------------------------

        describe("typed messages", () => {
            it("should preserve object types through serialization", async () => {
                if (shouldSkip?.()) return;
                const { promise, handler } = waitForMessage<TestOrder>();

                await provider.subscribe<TestOrder>("typed", handler);
                await settle();
                await provider.publish("typed", sampleOrder);

                const msg = await promise;
                expect(msg.data.id).toBe(1);
                expect(msg.data.total).toBe(99.99);
                expect(msg.data.customer).toBe("Alice");
            });

            it("should preserve primitive types", async () => {
                if (shouldSkip?.()) return;
                const { promise, handler } = waitForMessage<number>();

                await provider.subscribe<number>("num", handler);
                await settle();
                await provider.publish("num", 42);

                const msg = await promise;
                expect(msg.data).toBe(42);
            });
        });

        // ---------------------------------------------------------------
        // activeSubscriptions
        // ---------------------------------------------------------------

        describe("activeSubscriptions", () => {
            it("should return correct channels and patterns", async () => {
                if (shouldSkip?.()) return;
                await provider.subscribe("ch1", vi.fn());
                await provider.psubscribe("pat:*", vi.fn());

                const subs = provider.activeSubscriptions();
                expect(subs.channels).toContain("ch1");
                expect(subs.patterns).toContain("pat:*");
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
        // shutdown
        // ---------------------------------------------------------------

        describe("shutdown", () => {
            it("should clear all subscriptions on shutdown", async () => {
                if (shouldSkip?.()) return;
                // Create a dedicated provider for the shutdown test to avoid
                // double-shutdown in afterEach (which would fail on Redis
                // since connections are already closed)
                const shutdownProvider = createProvider();
                await shutdownProvider.subscribe("ch", vi.fn());
                await shutdownProvider.psubscribe("pat:*", vi.fn());

                await shutdownProvider.shutdown();

                const subs = shutdownProvider.activeSubscriptions();
                expect(subs.channels).toEqual([]);
                expect(subs.patterns).toEqual([]);
            });
        });

        // ---------------------------------------------------------------
        // pattern message includes pattern field
        // ---------------------------------------------------------------

        describe("pattern message envelope", () => {
            it("should include pattern field in pattern-matched messages", async () => {
                if (shouldSkip?.()) return;
                const { promise, handler } = waitForMessage();

                await provider.psubscribe("audit:*", handler);
                await settle();
                await provider.publish("audit:login", { userId: 42 });

                const msg = await promise;
                expect(msg.pattern).toBe("audit:*");
                expect(msg.channel).toBe("audit:login");
            });
        });

        // ---------------------------------------------------------------
        // channel prefix transparency
        // ---------------------------------------------------------------

        describe("channel prefix", () => {
            it("should be transparent — user sees unprefixed names", async () => {
                if (shouldSkip?.()) return;
                const { promise, handler } = waitForMessage<string>();

                await provider.subscribe<string>("events", handler);
                await settle();
                await provider.publish("events", "test");

                const msg = await promise;
                // Channel name should be the user-facing name, not the prefixed one
                expect(msg.channel).toBe("events");
            });
        });
    });
}

// ---------------------------------------------------------------------------
// Run Contract Tests Against Both Providers
// ---------------------------------------------------------------------------

let memoryCounter = 0;
let redisCounter = 0;

// --- MemoryPubSubProvider (always runs, no Docker needed) ---
runPubSubContractTests(
    "MemoryPubSubProvider",
    () =>
        new MemoryPubSubProvider({
            channelPrefix: `ContractMem_${++memoryCounter}`,
        }),
    async (p) => await p.shutdown()
);

// --- RedisPubSubProvider (only runs when Docker Redis is available) ---
runPubSubContractTests(
    "RedisPubSubProvider",
    () =>
        new RedisPubSubProvider({
            ...REDIS_CONFIG,
            channelPrefix: `ContractRedis_${++redisCounter}_${Date.now()}`,
        }),
    async (p) => await p.shutdown(),
    () => !redisAvailable
);
