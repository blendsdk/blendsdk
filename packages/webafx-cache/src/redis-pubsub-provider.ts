/**
 * Redis-backed pub/sub provider using ioredis.
 *
 * Production-grade implementation with:
 * - Two dedicated ioredis connections (publisher + subscriber)
 * - Automatic JSON serialization/deserialization
 * - Channel prefix support for namespace isolation
 * - Multiple handlers per channel (fan-out)
 * - Handler error isolation via safeInvoke
 * - Connection health monitoring via PING on both connections
 * - Graceful shutdown: unsubscribe all, then close both connections
 *
 * Redis pub/sub requires a dedicated connection for subscribing — once a
 * client enters subscriber mode (SUBSCRIBE/PSUBSCRIBE), it can only execute
 * subscriber commands. Regular commands like PUBLISH must use a separate connection.
 *
 * @packageDocumentation
 */

import { Redis } from "ioredis";
import { PubSubProvider } from "./abstract-pubsub-provider.js";
import type { RedisPubSubConfig, MessageHandler, PubSubMessage } from "./types.js";

// ---------------------------------------------------------------------------
// Default Constants
// ---------------------------------------------------------------------------

/** Default connection timeout in milliseconds */
const DEFAULT_CONNECT_TIMEOUT = 5000;

/** Default max retries per request */
const DEFAULT_MAX_RETRIES = 3;

/** Default Redis host */
const DEFAULT_HOST = "localhost";

/** Default Redis port */
const DEFAULT_PORT = 6379;

/** Default Redis database index */
const DEFAULT_DB = 0;

// ---------------------------------------------------------------------------
// RedisPubSubProvider
// ---------------------------------------------------------------------------

/**
 * Redis-backed pub/sub provider using ioredis.
 *
 * Creates two ioredis connections:
 * - `publisher` for PUBLISH commands
 * - `subscriber` for SUBSCRIBE/PSUBSCRIBE (enters subscriber mode)
 *
 * Handler maps use user-facing channel names (without prefix) so that
 * `activeSubscriptions()` returns clean names and handler lookup is simple.
 * Redis subscribe/unsubscribe is only called on the first/last handler for
 * a given channel — multiple in-process handlers share a single Redis subscription.
 *
 * @example
 * ```typescript
 * const pubsub = new RedisPubSubProvider({
 *     channelPrefix: 'MyApp',
 *     host: 'localhost',
 *     port: 6379,
 * });
 *
 * await pubsub.subscribe<OrderEvent>('order:new', (msg) => {
 *     console.log('New order:', msg.data);
 * });
 *
 * await pubsub.publish('order:new', { orderId: 123, total: 49.99 });
 * await pubsub.shutdown();
 * ```
 */
export class RedisPubSubProvider extends PubSubProvider {
    /** Dedicated connection for PUBLISH commands */
    protected publisher: Redis;

    /** Dedicated connection for SUBSCRIBE/PSUBSCRIBE (enters subscriber mode) */
    protected subscriber: Redis;

    /** Exact channel handlers: Map<userChannel, Set<MessageHandler>> */
    protected handlers: Map<string, Set<MessageHandler>>;

    /** Pattern handlers: Map<userPattern, Set<MessageHandler>> */
    protected patternHandlers: Map<string, Set<MessageHandler>>;

    /**
     * Create a new Redis pub/sub provider.
     *
     * Two ioredis connections are created immediately and begin connecting
     * in the background. The subscriber connection has ioredis message
     * event listeners wired up for routing incoming messages to handlers.
     *
     * @param config - Redis pub/sub configuration with connection details
     */
    constructor(config: RedisPubSubConfig) {
        super(config);

        // Create TWO connections with the same Redis config
        this.publisher = this.createRedisClient(config);
        this.subscriber = this.createRedisClient(config);

        this.handlers = new Map();
        this.patternHandlers = new Map();

        // Wire up ioredis message events for routing to handlers
        this.setupMessageHandlers();
    }

    // -------------------------------------------------------------------
    // Core Operations
    // -------------------------------------------------------------------

    /**
     * Publish a message to a channel.
     *
     * The data is JSON-serialized and sent via the publisher connection.
     * The channel prefix is applied automatically.
     *
     * @param channel - Channel name (prefix applied automatically)
     * @param data - Message payload (will be JSON-serialized)
     * @returns Number of Redis subscribers that received the message
     */
    async publish<T>(channel: string, data: T): Promise<number> {
        const fullChannel = this.buildChannel(channel);
        const serialized = JSON.stringify(data);
        // PUBLISH returns the number of clients that received the message
        return await this.publisher.publish(fullChannel, serialized);
    }

    /**
     * Subscribe to an exact channel with a typed handler.
     *
     * Multiple handlers can be registered for the same channel.
     * The Redis SUBSCRIBE command is only sent on the first handler
     * registration for a channel — subsequent handlers share the
     * same Redis subscription.
     *
     * @param channel - Exact channel name (prefix applied automatically)
     * @param handler - Function called when a message is received
     */
    async subscribe<T = unknown>(channel: string, handler: MessageHandler<T>): Promise<void> {
        // Add handler to local map
        if (!this.handlers.has(channel)) {
            this.handlers.set(channel, new Set());
        }
        this.handlers.get(channel)!.add(handler as MessageHandler);

        // Only subscribe to Redis on the first handler for this channel
        if (this.handlers.get(channel)!.size === 1) {
            const fullChannel = this.buildChannel(channel);
            await this.subscriber.subscribe(fullChannel);
        }
    }

    /**
     * Unsubscribe from an exact channel.
     * Removes all handlers and unsubscribes from Redis.
     *
     * @param channel - Channel name to unsubscribe from
     */
    async unsubscribe(channel: string): Promise<void> {
        const fullChannel = this.buildChannel(channel);
        await this.subscriber.unsubscribe(fullChannel);
        this.handlers.delete(channel);
    }

    /**
     * Subscribe to a channel pattern with a typed handler.
     *
     * Multiple handlers can be registered for the same pattern.
     * The Redis PSUBSCRIBE command is only sent on the first handler
     * registration for a pattern.
     *
     * @param pattern - Glob pattern (e.g., 'order:*')
     * @param handler - Function called when a matching message is received
     */
    async psubscribe<T = unknown>(pattern: string, handler: MessageHandler<T>): Promise<void> {
        if (!this.patternHandlers.has(pattern)) {
            this.patternHandlers.set(pattern, new Set());
        }
        this.patternHandlers.get(pattern)!.add(handler as MessageHandler);

        // Only psubscribe to Redis on the first handler for this pattern
        if (this.patternHandlers.get(pattern)!.size === 1) {
            const fullPattern = this.buildChannelPattern(pattern);
            await this.subscriber.psubscribe(fullPattern);
        }
    }

    /**
     * Unsubscribe from a channel pattern.
     * Removes all handlers and unsubscribes from Redis.
     *
     * @param pattern - Pattern to unsubscribe from
     */
    async punsubscribe(pattern: string): Promise<void> {
        const fullPattern = this.buildChannelPattern(pattern);
        await this.subscriber.punsubscribe(fullPattern);
        this.patternHandlers.delete(pattern);
    }

    /**
     * Get currently active subscriptions.
     * Returns user-facing channel/pattern names (without prefix).
     *
     * @returns Object with exact `channels` and glob `patterns` arrays
     */
    activeSubscriptions(): { channels: string[]; patterns: string[] } {
        return {
            channels: Array.from(this.handlers.keys()),
            patterns: Array.from(this.patternHandlers.keys()),
        };
    }

    // -------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------

    /**
     * Health check — pings both publisher and subscriber connections.
     * Returns true only if both connections respond with PONG.
     */
    async health(): Promise<boolean> {
        try {
            const [pubResult, subResult] = await Promise.all([
                this.publisher.ping(),
                this.subscriber.ping(),
            ]);
            return pubResult === "PONG" && subResult === "PONG";
        } catch {
            return false;
        }
    }

    /**
     * Graceful shutdown — unsubscribe all, clear handlers, close both connections.
     *
     * Unsubscribes from all channels and patterns before closing to ensure
     * clean disconnection. Both connections are closed via quit() which
     * waits for pending commands to complete.
     */
    async shutdown(): Promise<void> {
        // Unsubscribe all exact channels
        for (const channel of this.handlers.keys()) {
            const fullChannel = this.buildChannel(channel);
            await this.subscriber.unsubscribe(fullChannel);
        }

        // Unsubscribe all patterns
        for (const pattern of this.patternHandlers.keys()) {
            const fullPattern = this.buildChannelPattern(pattern);
            await this.subscriber.punsubscribe(fullPattern);
        }

        // Clear all handler maps
        this.handlers.clear();
        this.patternHandlers.clear();

        // Close both connections gracefully — waits for pending commands
        await Promise.all([this.publisher.quit(), this.subscriber.quit()]);
    }

    // -------------------------------------------------------------------
    // Internal: Redis Client Factory
    // -------------------------------------------------------------------

    /**
     * Create an ioredis client from config.
     *
     * URL takes precedence over individual host/port/password/db settings.
     * This is the same pattern used by RedisCacheProvider.
     *
     * @param config - Redis connection configuration
     * @returns A new ioredis Redis client
     */
    protected createRedisClient(config: RedisPubSubConfig): Redis {
        if (config.url) {
            // URL-based connection — pass additional options alongside
            return new Redis(config.url, {
                db: config.db,
                connectTimeout: config.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT,
                maxRetriesPerRequest: config.maxRetriesPerRequest ?? DEFAULT_MAX_RETRIES,
            });
        }

        // Individual field connection
        return new Redis({
            host: config.host ?? DEFAULT_HOST,
            port: config.port ?? DEFAULT_PORT,
            password: config.password,
            db: config.db ?? DEFAULT_DB,
            connectTimeout: config.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT,
            maxRetriesPerRequest: config.maxRetriesPerRequest ?? DEFAULT_MAX_RETRIES,
        });
    }

    // -------------------------------------------------------------------
    // Internal: Message Routing
    // -------------------------------------------------------------------

    /**
     * Wire up ioredis event listeners on the subscriber connection.
     *
     * ioredis emits two events for pub/sub messages:
     * - `message(channel, message)` for exact channel subscriptions
     * - `pmessage(pattern, channel, message)` for pattern subscriptions
     *
     * This method sets up listeners that:
     * 1. Strip the channel prefix from the full Redis channel name
     * 2. JSON-deserialize the message payload
     * 3. Fan out to all registered handlers via safeInvoke
     */
    protected setupMessageHandlers(): void {
        // Handle exact channel messages (from SUBSCRIBE)
        this.subscriber.on("message", (fullChannel: string, message: string) => {
            const userChannel = this.stripPrefix(fullChannel);
            const handlers = this.handlers.get(userChannel);
            if (!handlers || handlers.size === 0) return;

            // Deserialize the JSON payload
            let data: unknown;
            try {
                data = JSON.parse(message);
            } catch {
                console.error(`[PubSub] Failed to parse message on "${userChannel}"`);
                return;
            }

            const envelope: PubSubMessage = { channel: userChannel, data };

            // Fan out to all handlers — errors isolated per handler
            for (const handler of handlers) {
                void this.safeInvoke(handler, envelope);
            }
        });

        // Handle pattern messages (from PSUBSCRIBE)
        this.subscriber.on("pmessage", (fullPattern: string, fullChannel: string, message: string) => {
            const userChannel = this.stripPrefix(fullChannel);
            const userPattern = this.stripPrefix(fullPattern);
            const handlers = this.patternHandlers.get(userPattern);
            if (!handlers || handlers.size === 0) return;

            // Deserialize the JSON payload
            let data: unknown;
            try {
                data = JSON.parse(message);
            } catch {
                console.error(
                    `[PubSub] Failed to parse message on "${userChannel}" (pattern: "${userPattern}")`
                );
                return;
            }

            const envelope: PubSubMessage = {
                channel: userChannel,
                data,
                pattern: userPattern,
            };

            // Fan out to all handlers — errors isolated per handler
            for (const handler of handlers) {
                void this.safeInvoke(handler, envelope);
            }
        });
    }
}
