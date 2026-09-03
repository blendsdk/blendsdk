/**
 * Abstract base class for all pub/sub provider implementations.
 *
 * Provides a typed, JSON-serialized messaging API with transparent channel
 * prefix management. Both RedisPubSubProvider and MemoryPubSubProvider
 * extend this class and implement the abstract methods with backend-specific logic.
 *
 * Design principles:
 * - Application-wide singleton (not per-request)
 * - Channel prefix isolates channels per application/concern
 * - Configurable serviceName for multi-pubsub scenarios
 * - JSON serialization for all messages
 * - All methods are async for a uniform API
 * - Handler errors are isolated (log + continue)
 *
 * Architecture note:
 * This hierarchy is completely independent from CacheProvider. They are
 * parallel abstractions that happen to live in the same package.
 *
 * @packageDocumentation
 */

import type { PubSubProviderConfig, PubSubMessage, MessageHandler } from "./types.js";
import { DEFAULT_PUBSUB_SERVICE_NAME, CHANNEL_SEPARATOR } from "./types.js";

/**
 * Abstract base class for pub/sub implementations.
 *
 * All pub/sub backends (Redis, In-Memory) derive from this class.
 * Provides typed, JSON-serialized messaging with channel prefix support.
 *
 * Usage through concrete implementations:
 * ```typescript
 * const pubsub = new RedisPubSubProvider({ channelPrefix: 'MyApp' });
 * await pubsub.subscribe<OrderEvent>('order:new', (msg) => {
 *     console.log('New order:', msg.data);
 * });
 * await pubsub.publish('order:new', { orderId: 123, total: 49.99 });
 * ```
 */
export abstract class PubSubProvider {
    /** Channel prefix for namespace isolation */
    protected channelPrefix: string | undefined;

    /** Service name for WebAFX registration */
    protected _serviceName: string;

    /**
     * Initialize the pub/sub provider with configuration.
     *
     * @param config - Base configuration with optional channelPrefix and serviceName
     */
    constructor(config: PubSubProviderConfig) {
        this.channelPrefix = config.channelPrefix;
        this._serviceName = config.serviceName ?? DEFAULT_PUBSUB_SERVICE_NAME;
    }

    // -------------------------------------------------------------------
    // Public Accessors
    // -------------------------------------------------------------------

    /** Get the service name used for WebAFX service container registration */
    get serviceName(): string {
        return this._serviceName;
    }

    // -------------------------------------------------------------------
    // Channel Building (protected helpers for subclasses)
    // -------------------------------------------------------------------

    /**
     * Build the full channel name by prepending the prefix.
     *
     * Called by every publish/subscribe operation to ensure all channels
     * are namespaced under the channelPrefix, preventing collisions
     * when multiple applications share the same Redis instance.
     *
     * @param channel - User-provided channel name
     * @returns Prefixed channel (e.g., prefix='MyApp', channel='order:new' → 'MyApp:order:new')
     */
    protected buildChannel(channel: string): string {
        if (this.channelPrefix) {
            return `${this.channelPrefix}${CHANNEL_SEPARATOR}${channel}`;
        }
        return channel;
    }

    /**
     * Build the full pattern by prepending the prefix.
     *
     * Used by psubscribe to namespace glob patterns the same way
     * buildChannel namespaces exact channel names.
     *
     * @param pattern - User-provided pattern (e.g., 'order:*')
     * @returns Prefixed pattern (e.g., 'MyApp:order:*')
     */
    protected buildChannelPattern(pattern: string): string {
        if (this.channelPrefix) {
            return `${this.channelPrefix}${CHANNEL_SEPARATOR}${pattern}`;
        }
        return pattern;
    }

    /**
     * Strip the channel prefix from a full channel name.
     *
     * Used when delivering messages to handlers — they should see
     * the original channel name, not the internal prefixed version.
     * This keeps the handler code agnostic of the prefix configuration.
     *
     * @param fullChannel - The prefixed channel (from Redis or internal store)
     * @returns The user-facing channel name without prefix
     */
    protected stripPrefix(fullChannel: string): string {
        if (this.channelPrefix) {
            const prefix = `${this.channelPrefix}${CHANNEL_SEPARATOR}`;
            if (fullChannel.startsWith(prefix)) {
                return fullChannel.slice(prefix.length);
            }
        }
        return fullChannel;
    }

    /**
     * Safely invoke a message handler, catching and logging errors.
     *
     * Handler errors must never break other subscribers or crash
     * the subscriber connection. This method wraps every handler
     * invocation in a try/catch and logs errors to console.error.
     *
     * @param handler - The handler function to invoke
     * @param message - The message to pass to the handler
     */
    protected async safeInvoke<T>(handler: MessageHandler<T>, message: PubSubMessage<T>): Promise<void> {
        try {
            await handler(message);
        } catch (error) {
            // Log and continue — handler errors must not break other subscribers
            console.error(
                `[PubSub] Handler error on channel "${message.channel}":`,
                error instanceof Error ? error.message : error
            );
        }
    }

    // -------------------------------------------------------------------
    // Abstract Methods (implemented by each backend)
    // -------------------------------------------------------------------

    /**
     * Publish a typed message to a channel.
     *
     * The data is JSON-serialized before sending. The channel prefix
     * is applied automatically.
     *
     * @param channel - Channel name (prefix applied automatically)
     * @param data - Message payload (will be JSON-serialized)
     * @returns Number of subscribers that received the message
     */
    abstract publish<T>(channel: string, data: T): Promise<number>;

    /**
     * Subscribe to an exact channel with a typed handler.
     *
     * Multiple handlers can be registered for the same channel.
     * The handler receives a `PubSubMessage<T>` with the deserialized
     * payload and channel metadata.
     *
     * @param channel - Exact channel name (prefix applied automatically)
     * @param handler - Function called when a message is received
     */
    abstract subscribe<T = unknown>(channel: string, handler: MessageHandler<T>): Promise<void>;

    /**
     * Unsubscribe from an exact channel.
     *
     * Removes all handlers for the specified channel and unsubscribes
     * from the underlying transport.
     *
     * @param channel - Channel name to unsubscribe from
     */
    abstract unsubscribe(channel: string): Promise<void>;

    /**
     * Subscribe to a channel pattern with a typed handler.
     *
     * Pattern uses '*' as wildcard (glob matching). For example,
     * 'order:*' matches 'order:new', 'order:cancelled', etc.
     *
     * @param pattern - Channel pattern (e.g., 'order:*')
     * @param handler - Function called when a matching message is received
     */
    abstract psubscribe<T = unknown>(pattern: string, handler: MessageHandler<T>): Promise<void>;

    /**
     * Unsubscribe from a channel pattern.
     *
     * Removes all handlers for the specified pattern and unsubscribes
     * from the underlying transport.
     *
     * @param pattern - Pattern to unsubscribe from
     */
    abstract punsubscribe(pattern: string): Promise<void>;

    /**
     * Get the list of currently active subscriptions.
     *
     * Returns user-facing channel/pattern names (prefix stripped).
     *
     * @returns Object with `channels` (exact) and `patterns` (glob) arrays
     */
    abstract activeSubscriptions(): { channels: string[]; patterns: string[] };

    /**
     * Health check — returns true if the backend is operational.
     *
     * For Redis: checks connectivity on both publisher and subscriber connections.
     * For In-Memory: always returns true.
     */
    abstract health(): Promise<boolean>;

    /**
     * Graceful shutdown — unsubscribe all, close connections, release resources.
     *
     * For Redis: disconnects both publisher and subscriber ioredis clients.
     * For In-Memory: removes all handlers.
     */
    abstract shutdown(): Promise<void>;
}
