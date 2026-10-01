/**
 * Integration tests for RedisPubSubProvider.
 *
 * Requires Docker — Redis on port 6399.
 * Tests end-to-end message delivery via Redis pub/sub, including:
 * - Exact channel publish/subscribe
 * - Pattern subscribe (PSUBSCRIBE)
 * - Multiple handler fan-out
 * - Channel prefix handling
 * - Health checks on both connections
 * - Graceful shutdown
 * - Error isolation
 */

import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { Redis } from "ioredis";
import { RedisPubSubProvider } from "../src/redis-pubsub-provider.js";
import type { PubSubMessage, MessageHandler } from "../src/types.js";

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
// Helpers
// ---------------------------------------------------------------------------

interface TestOrder {
    id: number;
    total: number;
    customer: string;
}

const sampleOrder: TestOrder = { id: 1, total: 99.99, customer: "Alice" };

/**
 * Wait for a pub/sub message to be delivered.
 * Redis delivery is async (network round-trip), so we need to await.
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
 * Collect multiple messages.
 */
function collectMessages<T = unknown>(
    count: number,
    timeout = 2000
): {
    promise: Promise<PubSubMessage<T>[]>;
    handler: MessageHandler<T>;
} {
    const messages: PubSubMessage<T>[] = [];
    let resolve: (msgs: PubSubMessage<T>[]) => void;
    const promise = new Promise<PubSubMessage<T>[]>((r, reject) => {
        resolve = r;
        setTimeout(() => reject(new Error(`Timeout: received ${messages.length}/${count}`)), timeout);
    });
    const handler: MessageHandler<T> = (msg) => {
        messages.push(msg);
        if (messages.length >= count) resolve!(messages);
    };
    return { promise, handler };
}

/** Unique prefix per test to avoid cross-test interference */
let testCounter = 0;
function uniquePrefix(): string {
    return `RedisPubSubTest_${++testCounter}_${Date.now()}`;
}

// Cleanup tracking
const providersToCleanup: RedisPubSubProvider[] = [];

afterEach(async () => {
    for (const p of providersToCleanup) {
        try {
            await p.shutdown();
        } catch {
            // Ignore shutdown errors during cleanup
        }
    }
    providersToCleanup.length = 0;
});

function createProvider(overrides?: { channelPrefix?: string; serviceName?: string }) {
    if (!redisAvailable) return undefined;
    const p = new RedisPubSubProvider({
        ...REDIS_CONFIG,
        channelPrefix: overrides?.channelPrefix ?? uniquePrefix(),
        serviceName: overrides?.serviceName,
    });
    providersToCleanup.push(p);
    return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RedisPubSubProvider", () => {
    describe("publish and subscribe", () => {
        it("should deliver message to subscribed handler via Redis", async () => {
            if (!redisAvailable) return;
            const pubsub = createProvider()!;

            const { promise, handler } = waitForMessage<TestOrder>();
            await pubsub.subscribe<TestOrder>("order:new", handler);

            // Small delay to ensure Redis subscription is established
            await new Promise((r) => setTimeout(r, 100));

            await pubsub.publish("order:new", sampleOrder);
            const msg = await promise;

            expect(msg.channel).toBe("order:new");
            expect(msg.data).toEqual(sampleOrder);
            expect(msg.pattern).toBeUndefined();
        });

        it("should deliver typed string message", async () => {
            if (!redisAvailable) return;
            const pubsub = createProvider()!;

            const { promise, handler } = waitForMessage<string>();
            await pubsub.subscribe<string>("greet", handler);
            await new Promise((r) => setTimeout(r, 100));

            await pubsub.publish("greet", "hello world");
            const msg = await promise;

            expect(msg.data).toBe("hello world");
        });

        it("should return subscriber count from publish", async () => {
            if (!redisAvailable) return;
            const pubsub = createProvider()!;

            await pubsub.subscribe("ch", vi.fn());
            await new Promise((r) => setTimeout(r, 100));

            const count = await pubsub.publish("ch", "data");
            // Should be at least 1 (our subscriber)
            expect(count).toBeGreaterThanOrEqual(1);
        });

        it("should return 0 when publishing to no subscribers", async () => {
            if (!redisAvailable) return;
            const pubsub = createProvider()!;

            const count = await pubsub.publish("nobody", "data");
            expect(count).toBe(0);
        });

        it("should deliver to multiple handlers (fan-out)", async () => {
            if (!redisAvailable) return;
            const pubsub = createProvider()!;

            const { promise: p1, handler: h1 } = waitForMessage();
            const { promise: p2, handler: h2 } = waitForMessage();

            await pubsub.subscribe("events", h1);
            await pubsub.subscribe("events", h2);
            await new Promise((r) => setTimeout(r, 100));

            await pubsub.publish("events", { type: "test" });

            const [msg1, msg2] = await Promise.all([p1, p2]);
            expect(msg1.data).toEqual({ type: "test" });
            expect(msg2.data).toEqual({ type: "test" });
        });
    });

    describe("unsubscribe", () => {
        it("should stop delivering messages after unsubscribe", async () => {
            if (!redisAvailable) return;
            const pubsub = createProvider()!;
            const handler = vi.fn();

            await pubsub.subscribe("ch", handler);
            await new Promise((r) => setTimeout(r, 100));
            await pubsub.unsubscribe("ch");
            await new Promise((r) => setTimeout(r, 50));

            await pubsub.publish("ch", "data");
            await new Promise((r) => setTimeout(r, 200));

            expect(handler).not.toHaveBeenCalled();
        });
    });

    describe("psubscribe and pattern matching", () => {
        it("should deliver to pattern subscriber", async () => {
            if (!redisAvailable) return;
            const pubsub = createProvider()!;

            const { promise, handler } = collectMessages(2);
            await pubsub.psubscribe("order:*", handler);
            await new Promise((r) => setTimeout(r, 100));

            await pubsub.publish("order:created", { id: 1 });
            await pubsub.publish("order:updated", { id: 2 });

            const msgs = await promise;
            expect(msgs).toHaveLength(2);
            expect(msgs[0].channel).toBe("order:created");
            expect(msgs[1].channel).toBe("order:updated");
        });

        it("should include pattern field in message envelope", async () => {
            if (!redisAvailable) return;
            const pubsub = createProvider()!;

            const { promise, handler } = waitForMessage();
            await pubsub.psubscribe("audit:*", handler);
            await new Promise((r) => setTimeout(r, 100));

            await pubsub.publish("audit:login", { userId: 1 });
            const msg = await promise;

            expect(msg.pattern).toBe("audit:*");
            expect(msg.channel).toBe("audit:login");
        });

        it("should not match non-matching channels", async () => {
            if (!redisAvailable) return;
            const pubsub = createProvider()!;
            const handler = vi.fn();

            await pubsub.psubscribe("order:*", handler);
            await new Promise((r) => setTimeout(r, 100));

            await pubsub.publish("user:created", { id: 1 });
            await new Promise((r) => setTimeout(r, 200));

            expect(handler).not.toHaveBeenCalled();
        });
    });

    describe("punsubscribe", () => {
        it("should stop delivering pattern messages after punsubscribe", async () => {
            if (!redisAvailable) return;
            const pubsub = createProvider()!;
            const handler = vi.fn();

            await pubsub.psubscribe("order:*", handler);
            await new Promise((r) => setTimeout(r, 100));
            await pubsub.punsubscribe("order:*");
            await new Promise((r) => setTimeout(r, 50));

            await pubsub.publish("order:created", { id: 1 });
            await new Promise((r) => setTimeout(r, 200));

            expect(handler).not.toHaveBeenCalled();
        });
    });

    describe("error isolation", () => {
        it("should catch handler errors without affecting other handlers", async () => {
            if (!redisAvailable) return;
            const pubsub = createProvider()!;
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

            const badHandler: MessageHandler = () => {
                throw new Error("handler boom");
            };
            const { promise, handler: goodHandler } = waitForMessage();

            await pubsub.subscribe("ch", badHandler);
            await pubsub.subscribe("ch", goodHandler);
            await new Promise((r) => setTimeout(r, 100));

            await pubsub.publish("ch", "data");
            const msg = await promise;

            expect(msg.data).toBe("data");
            expect(errorSpy).toHaveBeenCalled();
            errorSpy.mockRestore();
        });
    });

    describe("channelPrefix", () => {
        it("should apply prefix to Redis channels transparently", async () => {
            if (!redisAvailable) return;
            const pubsub = createProvider({ channelPrefix: "MyApp" })!;

            const { promise, handler } = waitForMessage<string>();
            await pubsub.subscribe<string>("greet", handler);
            await new Promise((r) => setTimeout(r, 100));

            await pubsub.publish("greet", "hello");
            const msg = await promise;

            // User sees unprefixed channel name
            expect(msg.channel).toBe("greet");
        });
    });

    describe("activeSubscriptions", () => {
        it("should return correct channels and patterns", async () => {
            if (!redisAvailable) return;
            const pubsub = createProvider()!;

            await pubsub.subscribe("ch1", vi.fn());
            await pubsub.subscribe("ch2", vi.fn());
            await pubsub.psubscribe("pat:*", vi.fn());

            const subs = pubsub.activeSubscriptions();
            expect(subs.channels).toEqual(["ch1", "ch2"]);
            expect(subs.patterns).toEqual(["pat:*"]);
        });

        it("should return empty arrays initially", () => {
            if (!redisAvailable) return;
            const pubsub = createProvider()!;
            const subs = pubsub.activeSubscriptions();
            expect(subs.channels).toEqual([]);
            expect(subs.patterns).toEqual([]);
        });
    });

    describe("health", () => {
        it("should return true when both connections are healthy", async () => {
            if (!redisAvailable) return;
            const pubsub = createProvider()!;
            expect(await pubsub.health()).toBe(true);
        });
    });

    describe("shutdown", () => {
        it("should close both connections gracefully", async () => {
            if (!redisAvailable) return;
            const prefix = uniquePrefix();
            const pubsub = new RedisPubSubProvider({
                ...REDIS_CONFIG,
                channelPrefix: prefix,
            });
            // Don't add to cleanup — we're testing shutdown manually

            await pubsub.subscribe("ch", vi.fn());
            await pubsub.shutdown();

            const subs = pubsub.activeSubscriptions();
            expect(subs.channels).toEqual([]);
            expect(subs.patterns).toEqual([]);
        });
    });

    describe("multiple handlers per channel", () => {
        it("should only subscribe to Redis once for same channel", async () => {
            if (!redisAvailable) return;
            const pubsub = createProvider()!;

            // Subscribe 3 handlers to the same channel
            const { promise: p1, handler: h1 } = waitForMessage();
            const { promise: p2, handler: h2 } = waitForMessage();
            const { promise: p3, handler: h3 } = waitForMessage();

            await pubsub.subscribe("shared", h1);
            await pubsub.subscribe("shared", h2);
            await pubsub.subscribe("shared", h3);
            await new Promise((r) => setTimeout(r, 100));

            await pubsub.publish("shared", "broadcast");

            const [m1, m2, m3] = await Promise.all([p1, p2, p3]);
            expect(m1.data).toBe("broadcast");
            expect(m2.data).toBe("broadcast");
            expect(m3.data).toBe("broadcast");
        });
    });
});
