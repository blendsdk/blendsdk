/**
 * Redis-free WebAFX plugin builder for pub/sub providers.
 *
 * Wires any `PubSubProvider` instance into a WebAFX application as a singleton
 * service with health check, graceful shutdown, and optional declarative
 * subscriptions. This module imports no Redis code, so the memory entry point
 * can build its plugin without pulling `ioredis` into the process.
 *
 * @packageDocumentation
 */

import type { PluginDefinition } from "@blendsdk/webafx";
import type { PubSubProvider } from "./abstract-pubsub-provider.js";
import type { SubscriptionDefinition } from "./types.js";

/** Default plugin priority — same as cache (30), independent plugins */
const DEFAULT_PUBSUB_PLUGIN_PRIORITY = 30;

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
 * const pubsub = new MemoryPubSubProvider();
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
