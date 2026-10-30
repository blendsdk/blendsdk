/**
 * WebAFX plugin integration for pub/sub providers.
 *
 * Provides convenience factory functions that wire a PubSubProvider instance
 * into a WebAFX application as a singleton service with health check,
 * graceful shutdown, and optional declarative subscription support.
 *
 * This is one of the few files in @blendsdk/webafx-cache that imports from
 * @blendsdk/webafx, which is why webafx is a peer dependency (not a hard
 * dependency). The Redis-backed factories here load the Redis provider; the
 * memory entry point ({@link ./memory.js}) has no Redis dependency.
 *
 * @packageDocumentation
 */

import type { PluginDefinition } from "@blendsdk/webafx";
import { PubSubProvider } from "./abstract-pubsub-provider.js";
import { RedisPubSubProvider } from "./redis-pubsub-provider.js";
import { MemoryPubSubProvider } from "./memory-pubsub-provider.js";
import type { RedisPubSubConfig, PubSubFactoryConfig } from "./types.js";
import {
    createPubSubPlugin,
    type PubSubPluginOptions,
} from "./pubsub-provider-plugin.js";

// Re-export the Redis-free builder, its options, and the memory factory so the
// main entry point keeps its existing public names.
export { createPubSubPlugin } from "./pubsub-provider-plugin.js";
export type { PubSubPluginOptions } from "./pubsub-provider-plugin.js";
export { memoryPubSubPlugin } from "./memory.js";

/**
 * Create a WebAFX pub/sub plugin with a Redis backend. One-liner registration.
 *
 * Creates a RedisPubSubProvider internally and returns a PluginDefinition.
 * The user never needs to instantiate the provider manually.
 *
 * @param config - Redis pub/sub configuration (host, port, channelPrefix, etc.)
 * @param options - Optional plugin options (priority, subscriptions)
 * @returns A WebAFX PluginDefinition ready to pass to app.use()
 *
 * @example
 * ```typescript
 * app.use(redisPubSubPlugin({
 *     host: 'localhost',
 *     port: 6379,
 *     channelPrefix: 'MyApp',
 * }));
 * ```
 *
 * @example With declarative subscriptions
 * ```typescript
 * app.use(redisPubSubPlugin(
 *     { host: 'localhost', channelPrefix: 'MyApp' },
 *     {
 *         subscriptions: [
 *             { channel: 'order:created', handler: handleNewOrder },
 *             { pattern: 'audit:*', handler: handleAuditEvent },
 *         ]
 *     }
 * ));
 * ```
 */
export function redisPubSubPlugin(
    config: RedisPubSubConfig,
    options?: PubSubPluginOptions
): PluginDefinition {
    const provider = new RedisPubSubProvider(config);
    return createPubSubPlugin(provider, options);
}

/**
 * Create a PubSubProvider based on configuration type.
 *
 * Factory function for environment-based backend switching.
 * Returns the appropriate provider based on `config.type`.
 * Use with `createPubSubPlugin()` to register in WebAFX.
 *
 * @param config - Pub/sub factory configuration with type discriminator
 * @returns A PubSubProvider instance (Redis or Memory)
 * @throws Error if config.type is not 'redis' or 'memory'
 *
 * @example
 * ```typescript
 * const pubsub = createPubSub({
 *     type: process.env.NODE_ENV === 'production' ? 'redis' : 'memory',
 *     host: process.env.REDIS_HOST,
 *     port: Number(process.env.REDIS_PORT),
 *     channelPrefix: 'MyApp',
 * });
 * app.use(createPubSubPlugin(pubsub));
 * ```
 */
export function createPubSub(config: PubSubFactoryConfig): PubSubProvider {
    switch (config.type) {
        case "redis":
            return new RedisPubSubProvider({
                channelPrefix: config.channelPrefix,
                serviceName: config.serviceName,
                host: config.host,
                port: config.port,
                password: config.password,
                db: config.db,
                url: config.url,
            });

        case "memory":
            return new MemoryPubSubProvider({
                channelPrefix: config.channelPrefix,
                serviceName: config.serviceName,
            });

        default:
            // Exhaustive check — provides a clear runtime error for invalid types
            const unknownType = (config as { type: string }).type;
            throw new Error(
                `Unknown pub/sub type: "${unknownType}". Supported types: "redis", "memory".`
            );
    }
}
