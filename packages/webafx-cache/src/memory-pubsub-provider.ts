/**
 * In-memory pub/sub provider for development and testing.
 *
 * Uses in-process Maps and EventEmitter-style delivery. No network connections
 * or external dependencies — perfect for unit tests and local development.
 *
 * Key behaviors:
 * - JSON round-trip on publish (matches Redis serialization behavior)
 * - Glob pattern matching via regex conversion (supports *, ?)
 * - Synchronous delivery within the same event loop tick
 * - Handler errors isolated via safeInvoke (log + continue)
 * - Health always returns true (no external dependencies)
 *
 * @packageDocumentation
 */

import { PubSubProvider } from "./abstract-pubsub-provider.js";
import type { MemoryPubSubConfig, MessageHandler, PubSubMessage } from "./types.js";

/**
 * In-memory pub/sub provider for development and testing.
 *
 * Delivers messages synchronously within the same process.
 * No external connections required — always healthy.
 *
 * @example
 * ```typescript
 * const pubsub = new MemoryPubSubProvider({ channelPrefix: 'Test' });
 * await pubsub.subscribe<string>('greet', (msg) => console.log(msg.data));
 * await pubsub.publish('greet', 'Hello!');
 * ```
 */
export class MemoryPubSubProvider extends PubSubProvider {
    /** Exact channel handlers: Map<userChannel, Set<MessageHandler>> */
    protected handlers: Map<string, Set<MessageHandler>>;

    /** Pattern handlers: Map<userPattern, Set<MessageHandler>> */
    protected patternHandlers: Map<string, Set<MessageHandler>>;

    /**
     * Create a new in-memory pub/sub provider.
     *
     * @param config - Optional configuration with channelPrefix and serviceName
     */
    constructor(config?: MemoryPubSubConfig) {
        super(config ?? {});
        this.handlers = new Map();
        this.patternHandlers = new Map();
    }

    // -------------------------------------------------------------------
    // Core Operations
    // -------------------------------------------------------------------

    /**
     * Publish a message to a channel.
     *
     * Performs a JSON round-trip to match Redis behavior:
     * - Ensures data is JSON-serializable (throws if not)
     * - Handlers receive a new object (no shared references)
     *
     * @param channel - Channel name (prefix applied automatically)
     * @param data - Message payload (will be JSON-serialized)
     * @returns Number of handlers that received the message
     */
    async publish<T>(channel: string, data: T): Promise<number> {
        // JSON round-trip to match Redis behavior — ensures serializable data
        // and gives handlers a fresh copy (no shared references)
        const serialized = JSON.stringify(data);
        const deserialized = JSON.parse(serialized) as T;

        let receiverCount = 0;

        // Deliver to exact channel handlers
        const channelHandlers = this.handlers.get(channel);
        if (channelHandlers) {
            for (const handler of channelHandlers) {
                const envelope: PubSubMessage<T> = { channel, data: deserialized };
                void this.safeInvoke(handler, envelope);
                receiverCount++;
            }
        }

        // Deliver to matching pattern handlers
        for (const [pattern, patternHandlerSet] of this.patternHandlers) {
            if (this.matchGlob(channel, pattern)) {
                for (const handler of patternHandlerSet) {
                    const envelope: PubSubMessage<T> = {
                        channel,
                        data: deserialized,
                        pattern,
                    };
                    void this.safeInvoke(handler, envelope);
                    receiverCount++;
                }
            }
        }

        return receiverCount;
    }

    /**
     * Subscribe to an exact channel.
     *
     * Multiple handlers can be registered for the same channel.
     * Duplicate handlers are deduplicated by the underlying Set.
     *
     * @param channel - Exact channel name
     * @param handler - Handler function for incoming messages
     */
    async subscribe<T = unknown>(channel: string, handler: MessageHandler<T>): Promise<void> {
        if (!this.handlers.has(channel)) {
            this.handlers.set(channel, new Set());
        }
        this.handlers.get(channel)!.add(handler as MessageHandler);
    }

    /**
     * Unsubscribe from an exact channel.
     * Removes all handlers for the specified channel.
     *
     * @param channel - Channel name to unsubscribe from
     */
    async unsubscribe(channel: string): Promise<void> {
        this.handlers.delete(channel);
    }

    /**
     * Subscribe to a channel pattern with glob wildcards.
     *
     * Supports Redis-style glob patterns:
     * - `*` matches any sequence of characters
     * - `?` matches exactly one character
     *
     * @param pattern - Glob pattern (e.g., 'order:*')
     * @param handler - Handler function for matching messages
     */
    async psubscribe<T = unknown>(pattern: string, handler: MessageHandler<T>): Promise<void> {
        if (!this.patternHandlers.has(pattern)) {
            this.patternHandlers.set(pattern, new Set());
        }
        this.patternHandlers.get(pattern)!.add(handler as MessageHandler);
    }

    /**
     * Unsubscribe from a channel pattern.
     * Removes all handlers for the specified pattern.
     *
     * @param pattern - Pattern to unsubscribe from
     */
    async punsubscribe(pattern: string): Promise<void> {
        this.patternHandlers.delete(pattern);
    }

    /**
     * Get currently active subscriptions.
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
     * Health check — always returns true for in-memory provider.
     * There are no external connections to verify.
     */
    async health(): Promise<boolean> {
        return true;
    }

    /**
     * Shutdown — clears all handlers.
     * No connections to close for in-memory provider.
     */
    async shutdown(): Promise<void> {
        this.handlers.clear();
        this.patternHandlers.clear();
    }

    // -------------------------------------------------------------------
    // Internal: Glob Matching
    // -------------------------------------------------------------------

    /**
     * Match a channel name against a glob pattern.
     *
     * Converts glob syntax to a regular expression:
     * - `*` → `.*` (match any sequence of characters)
     * - `?` → `.` (match exactly one character)
     *
     * All other regex-special characters are escaped to prevent
     * accidental regex injection from channel or pattern names.
     *
     * @param channel - The channel name to test
     * @param pattern - The glob pattern to match against
     * @returns true if the channel matches the pattern
     */
    protected matchGlob(channel: string, pattern: string): boolean {
        // Escape regex special chars, then convert glob wildcards to regex equivalents
        const regexStr = pattern
            .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape regex specials (not * or ?)
            .replace(/\*/g, ".*") // * → .* (any sequence)
            .replace(/\?/g, "."); // ? → . (single char)
        const regex = new RegExp(`^${regexStr}$`);
        return regex.test(channel);
    }
}
