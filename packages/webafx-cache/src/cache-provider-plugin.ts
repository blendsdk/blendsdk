/**
 * Redis-free WebAFX plugin builder for cache providers.
 *
 * Wires any `CacheProvider` instance into a WebAFX application as a singleton
 * service with health check and graceful shutdown support. This module imports
 * no Redis code, so the memory entry point can build its plugin without pulling
 * `ioredis` into the process.
 *
 * @packageDocumentation
 */

import type { PluginDefinition } from "@blendsdk/webafx";
import type { CacheProvider } from "./abstract-cache-provider.js";

/** Default plugin priority — installs after most core plugins */
const DEFAULT_PLUGIN_PRIORITY = 30;

/**
 * Create a WebAFX PluginDefinition from any CacheProvider instance.
 *
 * This is the core function that wires a cache provider into WebAFX:
 * 1. Registers the provider as a singleton service in the service container
 * 2. Hooks the provider's health() into the /health endpoint
 * 3. Hooks the provider's shutdown() into graceful shutdown
 *
 * The service name is read from `provider.serviceName` (defaults to 'cache').
 *
 * @param provider - Any CacheProvider instance (Redis, Memory, or custom)
 * @param options - Optional overrides for plugin priority
 * @returns A WebAFX PluginDefinition ready to pass to app.use()
 *
 * @example
 * ```typescript
 * const cache = new MemoryCacheProvider({ rootKey: 'MyApp' });
 * app.use(createCachePlugin(cache));
 * ```
 */
export function createCachePlugin(
    provider: CacheProvider,
    options?: { priority?: number }
): PluginDefinition {
    return {
        name: provider.serviceName,
        priority: options?.priority ?? DEFAULT_PLUGIN_PRIORITY,

        factory: async ({ app, logger }) => {
            // Register the cache provider as an application-wide singleton service.
            // The factory ignores container/settings since the provider is pre-created.
            app.registerService({
                name: provider.serviceName,
                type: "singleton",
                factory: () => provider,
                dispose: async () => {
                    await provider.shutdown();
                },
            });

            await logger.info(
                `Cache plugin "${provider.serviceName}" initialized ` +
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
