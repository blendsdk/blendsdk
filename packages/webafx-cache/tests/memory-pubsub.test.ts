/**
 * Unit tests for MemoryPubSubProvider.
 *
 * No Docker required — uses in-memory provider exclusively.
 * Covers publish/subscribe, pattern matching, error isolation,
 * channel prefix, JSON round-trip, and lifecycle operations.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { MemoryPubSubProvider } from "../src/memory-pubsub-provider.js";
import type { PubSubMessage, MessageHandler } from "../src/types.js";

// ---------------------------------------------------------------------------
// Test Types
// ---------------------------------------------------------------------------

interface TestOrder {
    id: number;
    total: number;
    customer: string;
}

const sampleOrder: TestOrder = { id: 1, total: 99.99, customer: "Alice" };

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const providersToCleanup: MemoryPubSubProvider[] = [];

afterEach(async () => {
    for (const p of providersToCleanup) {
        await p.shutdown();
    }
    providersToCleanup.length = 0;
});

/** Helper to create a provider and register it for cleanup */
function createProvider(config?: { channelPrefix?: string; serviceName?: string }) {
    const p = new MemoryPubSubProvider(config);
    providersToCleanup.push(p);
    return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryPubSubProvider", () => {
    describe("constructor", () => {
        it("should use default serviceName 'pubsub'", () => {
            const pubsub = createProvider();
            expect(pubsub.serviceName).toBe("pubsub");
        });

        it("should use custom serviceName when provided", () => {
            const pubsub = createProvider({ serviceName: "my-pubsub" });
            expect(pubsub.serviceName).toBe("my-pubsub");
        });

        it("should accept no config (all defaults)", () => {
            const pubsub = new MemoryPubSubProvider();
            providersToCleanup.push(pubsub);
            expect(pubsub.serviceName).toBe("pubsub");
        });
    });

    describe("publish and subscribe", () => {
        it("should deliver message to subscribed handler", async () => {
            const pubsub = createProvider();
            const received: PubSubMessage<string>[] = [];

            await pubsub.subscribe<string>("greet", (msg) => {
                received.push(msg);
            });
            await pubsub.publish("greet", "hello");

            // Memory provider delivers synchronously via safeInvoke
            // Give microtask queue a tick to process
            await new Promise((r) => setTimeout(r, 10));
            expect(received).toHaveLength(1);
            expect(received[0].channel).toBe("greet");
            expect(received[0].data).toBe("hello");
        });

        it("should deliver typed message with correct PubSubMessage shape", async () => {
            const pubsub = createProvider();
            const received: PubSubMessage<TestOrder>[] = [];

            await pubsub.subscribe<TestOrder>("order:new", (msg) => {
                received.push(msg);
            });
            await pubsub.publish("order:new", sampleOrder);

            await new Promise((r) => setTimeout(r, 10));
            expect(received[0].data).toEqual(sampleOrder);
            expect(received[0].channel).toBe("order:new");
            expect(received[0].pattern).toBeUndefined();
        });

        it("should return 0 when publishing to no subscribers", async () => {
            const pubsub = createProvider();
            const count = await pubsub.publish("nobody", "hello");
            expect(count).toBe(0);
        });

        it("should deliver to multiple handlers (fan-out)", async () => {
            const pubsub = createProvider();
            const handler1 = vi.fn();
            const handler2 = vi.fn();

            await pubsub.subscribe("events", handler1);
            await pubsub.subscribe("events", handler2);

            const count = await pubsub.publish("events", "data");
            await new Promise((r) => setTimeout(r, 10));

            expect(count).toBe(2);
            expect(handler1).toHaveBeenCalledTimes(1);
            expect(handler2).toHaveBeenCalledTimes(1);
        });

        it("should return correct receiver count", async () => {
            const pubsub = createProvider();
            await pubsub.subscribe("ch", vi.fn());
            await pubsub.subscribe("ch", vi.fn());
            await pubsub.subscribe("ch", vi.fn());

            const count = await pubsub.publish("ch", "data");
            expect(count).toBe(3);
        });
    });

    describe("unsubscribe", () => {
        it("should stop delivering messages after unsubscribe", async () => {
            const pubsub = createProvider();
            const handler = vi.fn();

            await pubsub.subscribe("ch", handler);
            await pubsub.unsubscribe("ch");
            await pubsub.publish("ch", "data");

            await new Promise((r) => setTimeout(r, 10));
            expect(handler).not.toHaveBeenCalled();
        });

        it("should not error when unsubscribing from non-existent channel", async () => {
            const pubsub = createProvider();
            await expect(pubsub.unsubscribe("nonexistent")).resolves.toBeUndefined();
        });
    });

    describe("psubscribe and pattern matching", () => {
        it("should match * pattern (any sequence)", async () => {
            const pubsub = createProvider();
            const received: PubSubMessage[] = [];

            await pubsub.psubscribe("order:*", (msg) => received.push(msg));

            await pubsub.publish("order:created", { id: 1 });
            await pubsub.publish("order:updated", { id: 2 });
            await pubsub.publish("user:created", { id: 3 }); // Should NOT match

            await new Promise((r) => setTimeout(r, 10));
            expect(received).toHaveLength(2);
            expect(received[0].channel).toBe("order:created");
            expect(received[1].channel).toBe("order:updated");
        });

        it("should include pattern field in message envelope", async () => {
            const pubsub = createProvider();
            const received: PubSubMessage[] = [];

            await pubsub.psubscribe("audit:*", (msg) => received.push(msg));
            await pubsub.publish("audit:login", { userId: 1 });

            await new Promise((r) => setTimeout(r, 10));
            expect(received[0].pattern).toBe("audit:*");
            expect(received[0].channel).toBe("audit:login");
        });

        it("should match ? pattern (single character)", async () => {
            const pubsub = createProvider();
            const received: PubSubMessage[] = [];

            await pubsub.psubscribe("slot:?", (msg) => received.push(msg));

            await pubsub.publish("slot:a", "yes");
            await pubsub.publish("slot:b", "yes");
            await pubsub.publish("slot:ab", "no"); // Should NOT match (two chars)

            await new Promise((r) => setTimeout(r, 10));
            expect(received).toHaveLength(2);
        });

        it("should deliver to both exact and pattern handlers", async () => {
            const pubsub = createProvider();
            const exactHandler = vi.fn();
            const patternHandler = vi.fn();

            await pubsub.subscribe("order:new", exactHandler);
            await pubsub.psubscribe("order:*", patternHandler);

            const count = await pubsub.publish("order:new", sampleOrder);
            await new Promise((r) => setTimeout(r, 10));

            // Both should fire: 1 exact + 1 pattern = 2
            expect(count).toBe(2);
            expect(exactHandler).toHaveBeenCalledTimes(1);
            expect(patternHandler).toHaveBeenCalledTimes(1);
        });
    });

    describe("punsubscribe", () => {
        it("should stop delivering pattern messages after punsubscribe", async () => {
            const pubsub = createProvider();
            const handler = vi.fn();

            await pubsub.psubscribe("order:*", handler);
            await pubsub.punsubscribe("order:*");
            await pubsub.publish("order:created", { id: 1 });

            await new Promise((r) => setTimeout(r, 10));
            expect(handler).not.toHaveBeenCalled();
        });
    });

    describe("error isolation", () => {
        it("should catch synchronous handler errors without affecting others", async () => {
            const pubsub = createProvider();
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
            const goodHandler = vi.fn();

            const badHandler: MessageHandler = () => {
                throw new Error("handler boom");
            };

            await pubsub.subscribe("ch", badHandler);
            await pubsub.subscribe("ch", goodHandler);

            await pubsub.publish("ch", "data");
            await new Promise((r) => setTimeout(r, 10));

            expect(goodHandler).toHaveBeenCalledTimes(1);
            expect(errorSpy).toHaveBeenCalled();
            errorSpy.mockRestore();
        });

        it("should catch async handler rejections without affecting others", async () => {
            const pubsub = createProvider();
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
            const goodHandler = vi.fn();

            const badHandler: MessageHandler = async () => {
                throw new Error("async handler boom");
            };

            await pubsub.subscribe("ch", badHandler);
            await pubsub.subscribe("ch", goodHandler);

            await pubsub.publish("ch", "data");
            await new Promise((r) => setTimeout(r, 50));

            expect(goodHandler).toHaveBeenCalledTimes(1);
            expect(errorSpy).toHaveBeenCalled();
            errorSpy.mockRestore();
        });
    });

    describe("JSON round-trip", () => {
        it("should serialize and deserialize objects (no shared references)", async () => {
            const pubsub = createProvider();
            const original = { nested: { value: 42 } };
            let received: unknown;

            await pubsub.subscribe("ch", (msg) => {
                received = msg.data;
            });
            await pubsub.publish("ch", original);

            await new Promise((r) => setTimeout(r, 10));
            expect(received).toEqual(original);
            // Must be a new object, not the same reference
            expect(received).not.toBe(original);
        });

        it("should preserve various data types through JSON round-trip", async () => {
            const pubsub = createProvider();
            const testCases = [
                { input: "hello", expected: "hello" },
                { input: 42, expected: 42 },
                { input: true, expected: true },
                { input: null, expected: null },
                { input: [1, 2, 3], expected: [1, 2, 3] },
            ];

            for (const { input, expected } of testCases) {
                let received: unknown;
                const handler: MessageHandler = (msg) => {
                    received = msg.data;
                };
                await pubsub.subscribe(`type-${String(input)}`, handler);
                await pubsub.publish(`type-${String(input)}`, input);
                await new Promise((r) => setTimeout(r, 10));
                expect(received).toEqual(expected);
                await pubsub.unsubscribe(`type-${String(input)}`);
            }
        });
    });

    describe("activeSubscriptions", () => {
        it("should return empty arrays initially", () => {
            const pubsub = createProvider();
            const subs = pubsub.activeSubscriptions();
            expect(subs.channels).toEqual([]);
            expect(subs.patterns).toEqual([]);
        });

        it("should return correct channels and patterns", async () => {
            const pubsub = createProvider();
            await pubsub.subscribe("ch1", vi.fn());
            await pubsub.subscribe("ch2", vi.fn());
            await pubsub.psubscribe("pat:*", vi.fn());

            const subs = pubsub.activeSubscriptions();
            expect(subs.channels).toEqual(["ch1", "ch2"]);
            expect(subs.patterns).toEqual(["pat:*"]);
        });

        it("should reflect unsubscribe changes", async () => {
            const pubsub = createProvider();
            await pubsub.subscribe("ch1", vi.fn());
            await pubsub.unsubscribe("ch1");

            const subs = pubsub.activeSubscriptions();
            expect(subs.channels).toEqual([]);
        });
    });

    describe("health", () => {
        it("should always return true", async () => {
            const pubsub = createProvider();
            expect(await pubsub.health()).toBe(true);
        });
    });

    describe("shutdown", () => {
        it("should clear all handlers", async () => {
            const pubsub = createProvider();
            await pubsub.subscribe("ch", vi.fn());
            await pubsub.psubscribe("pat:*", vi.fn());

            await pubsub.shutdown();

            const subs = pubsub.activeSubscriptions();
            expect(subs.channels).toEqual([]);
            expect(subs.patterns).toEqual([]);
        });

        it("should stop delivering messages after shutdown", async () => {
            const pubsub = createProvider();
            const handler = vi.fn();
            await pubsub.subscribe("ch", handler);

            await pubsub.shutdown();
            await pubsub.publish("ch", "data");

            await new Promise((r) => setTimeout(r, 10));
            expect(handler).not.toHaveBeenCalled();
        });
    });

    describe("channelPrefix", () => {
        it("should work correctly with prefix (transparent to user)", async () => {
            // Prefix is handled internally — user sees unprefixed names
            const pubsub = createProvider({ channelPrefix: "MyApp" });
            const received: PubSubMessage[] = [];

            await pubsub.subscribe("order:new", (msg) => received.push(msg));
            await pubsub.publish("order:new", sampleOrder);

            await new Promise((r) => setTimeout(r, 10));
            expect(received).toHaveLength(1);
            expect(received[0].channel).toBe("order:new"); // User sees unprefixed
        });

        it("should work correctly without prefix", async () => {
            const pubsub = createProvider(); // No prefix
            const received: PubSubMessage[] = [];

            await pubsub.subscribe("ch", (msg) => received.push(msg));
            await pubsub.publish("ch", "data");

            await new Promise((r) => setTimeout(r, 10));
            expect(received).toHaveLength(1);
        });
    });
});
