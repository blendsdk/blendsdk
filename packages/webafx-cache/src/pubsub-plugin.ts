/**
 * WebAFX plugin integration for pub/sub providers.
 *
 * Provides convenience factory functions that wire a PubSubProvider instance
 * into a WebAFX application as a singleton service with health check,
 * graceful shutdown, and optional declarative subscription support.
 *
 * This is the ONLY pub/sub file that imports from @blendsdk/webafx,
 * which is why webafx is a peer dependency (not a hard dependency).
 *
 * @packageDocumentation
 */

import type { PluginDefinition } from "@blendsdk/webafx";
import { PubSubProvider } from "./abstract-pubsub-provider.js";
import { RedisPubSubProvider } from "./redis-pubsub-provider.js";
import { MemoryPubSubProvider } from "./memory-pubsub-provider.js";
import type {
    RedisPubSubConfig,
    MemoryPubSubConfig,
    PubSubFactoryConfig,
    SubscriptionDefinition,
} from "./types.js";

// ---------------------------------------------------------------------------
// Default Constants
// ---------------------------------------------------------------------------

/** Default plugin priority — same as cache (30), independent plugins */
const DEFAULT_PUBSUB_PLUGIN_PRIORITY = 30;

// ---------------------------------------------------------------------------
// Plugin Options
// ---------------------------------------------------------------------------

/**
 * Options for pub/sub plugin creation.
 *
 * Allows overriding the plugin priority and registering declarative
 * subscriptions that are set up at plugin installation time.
 */
export interface PubSubPluginOptions {
    /** Plugin installation priority. Default: 30 */
    priority?: number;

    /**
     * Declarative subscriptions to register at plugin install time.
     *
     * Each entry specifies either a `channel` (exact) or `pattern` (glob)
     * with a handler function. Subscriptions are registered in order
     * during the plugin factory execution.
     */
    subscriptions?: SubscriptionDefinition[];
}

// ---------------------------------------------------------------------------
// Plugin Factory Functions
// ---------------------------------------------------------------------------

/**
 * Create a WebAFX PluginDefinition from any PubSubProvider instance.
 *
 * Core function that wires a pub/sub provider into WebAFX:
 * 1. Registers the provider as a singleton service in the service container
 * 2. Registers any declarative subscriptions from options
 * 3. Hooks the provider's health() into the /health endpoint
 * 4. Hooks the provider's shutdown() into graceful shutdown
 *
 * The service name is read from `provider.serviceName` (defaults to 'pubsub').
 *
 * @param provider - Any PubSubProvider instance (Redis, Memory, or custom)
 * @param options - Optional overrides for priority and declarative subscriptions
 * @returns A WebAFX PluginDefinition ready to pass to app.use()
 *
 * @example
 * ```typescript
 * const pubsub = new RedisPubSubProvider({ host: 'localhost' });
 * app.use(createPubSubPlugin(pubsub));
 * ```
 */
export function createPubSubPlugin(
    provider: PubSubProvider,
    options?: PubSubPluginOptions
): PluginDefinition {
    return {
        name: provider.serviceName,
        priority: options?.priority ?? DEFAULT_PUBSUB_PLUGIN_PRIORITY,

        factory: async ({ app, logger }) => {
            // Register the pub/sub provider as an application-wide singleton service.
            // The factory ignores container/settings since the provider is pre-created.
            app.registerService({
                name: provider.serviceName,
                type: "singleton",
                factory: () => provider,
                dispose: async () => {
                    await provider.shutdown();
                },
            });

            // Register declarative subscriptions (if provided in options)
            if (options?.subscriptions) {
                for (const sub of options.subscriptions) {
                    if (sub.channel) {
                        await provider.subscribe(sub.channel, sub.handler);
                        await logger.info(`PubSub: subscribed to channel "${sub.channel}"`);
                    } else if (sub.pattern) {
                        await provider.psubscribe(sub.pattern, sub.handler);
                        await logger.info(`PubSub: subscribed to pattern "${sub.pattern}"`);
                    }
                }
            }

            await logger.info(
                `PubSub plugin "${provider.serviceName}" initialized ` +
                    `(${provider.constructor.name})`
            );

            // Return Plugin hooks for health monitoring and graceful shutdown
            return {
                health: () => provider.health(),
                shutdown: () => provider.shutdown(),
            };
        },
    };
}

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
 * Create a WebAFX pub/sub plugin with an In-Memory backend. One-liner registration.
 *
 * Creates a MemoryPubSubProvider internally and returns a PluginDefinition.
 * Ideal for development, testing, and single-instance applications.
 *
 * @param config - Optional memory pub/sub configuration (channelPrefix, serviceName)
 * @param options - Optional plugin options (priority, subscriptions)
 * @returns A WebAFX PluginDefinition ready to pass to app.use()
 *
 * @example
 * ```typescript
 * app.use(memoryPubSubPlugin());
 * ```
 */
export function memoryPubSubPlugin(
    config?: MemoryPubSubConfig,
    options?: PubSubPluginOptions
): PluginDefinition {
    const provider = new MemoryPubSubProvider(config);
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
