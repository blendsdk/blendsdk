/**
 * WebAFX plugin integration for cache providers.
 *
 * Provides convenience factory functions that wire a CacheProvider instance
 * into a WebAFX application as a singleton service with health check and
 * graceful shutdown support.
 *
 * This is the ONLY file in @blendsdk/webafx-cache that imports from @blendsdk/webafx,
 * which is why webafx is a peer dependency (not a hard dependency).
 *
 * @packageDocumentation
 */

import type { PluginDefinition } from "@blendsdk/webafx";
import { CacheProvider } from "./abstract-cache-provider.js";
import { MemoryCacheProvider } from "./memory-cache-provider.js";
import { RedisCacheProvider } from "./redis-cache-provider.js";
import type { CacheFactoryConfig, MemoryCacheConfig, RedisCacheConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Default Constants
// ---------------------------------------------------------------------------

/** Default plugin priority — installs after most core plugins */
const DEFAULT_PLUGIN_PRIORITY = 30;

// ---------------------------------------------------------------------------
// Plugin Factory Functions
// ---------------------------------------------------------------------------

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
 * const cache = new RedisCacheProvider({ rootKey: 'MyApp', host: 'localhost' });
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

/**
 * Create a WebAFX cache plugin with a Redis backend. One-liner registration.
 *
 * Creates a RedisCacheProvider internally and returns a PluginDefinition.
 * The user never needs to instantiate the provider manually.
 *
 * @param config - Redis cache configuration (rootKey, host, port, etc.)
 * @returns A WebAFX PluginDefinition ready to pass to app.use()
 *
 * @example
 * ```typescript
 * app.use(redisCachePlugin({
 *     rootKey: 'MyApp',
 *     host: 'localhost',
 *     port: 6379,
 *     defaultTTL: 300,
 * }));
 * ```
 *
 * @example Multi-cache with different service names
 * ```typescript
 * app.use(redisCachePlugin({
 *     rootKey: 'Sessions',
 *     host: 'redis-sessions',
 *     serviceName: 'session-cache',
 * }));
 * app.use(redisCachePlugin({
 *     rootKey: 'Products',
 *     host: 'redis-products',
 *     serviceName: 'product-cache',
 * }));
 * ```
 */
export function redisCachePlugin(config: RedisCacheConfig): PluginDefinition {
    const provider = new RedisCacheProvider(config);
    return createCachePlugin(provider);
}

/**
 * Create a WebAFX cache plugin with an In-Memory backend. One-liner registration.
 *
 * Creates a MemoryCacheProvider internally and returns a PluginDefinition.
 * Ideal for development, testing, and single-instance applications.
 *
 * @param config - Memory cache configuration (rootKey, defaultTTL, etc.)
 * @returns A WebAFX PluginDefinition ready to pass to app.use()
 *
 * @example
 * ```typescript
 * app.use(memoryCachePlugin({
 *     rootKey: 'MyApp',
 *     defaultTTL: 60,
 * }));
 * ```
 */
export function memoryCachePlugin(config: MemoryCacheConfig): PluginDefinition {
    const provider = new MemoryCacheProvider(config);
    return createCachePlugin(provider);
}

/**
 * Create a CacheProvider based on configuration type.
 *
 * Factory function for environment-based backend switching.
 * Returns the appropriate provider based on `config.type`.
 * Use with `createCachePlugin()` to register in WebAFX.
 *
 * @param config - Cache factory configuration with type discriminator
 * @returns A CacheProvider instance (Redis or Memory)
 * @throws Error if config.type is not 'redis' or 'memory'
 *
 * @example
 * ```typescript
 * const cache = createCache({
 *     type: process.env.NODE_ENV === 'production' ? 'redis' : 'memory',
 *     rootKey: 'MyApp',
 *     host: process.env.REDIS_HOST,
 *     port: Number(process.env.REDIS_PORT),
 * });
 * app.use(createCachePlugin(cache));
 * ```
 */
export function createCache(config: CacheFactoryConfig): CacheProvider {
    switch (config.type) {
        case "redis":
            return new RedisCacheProvider({
                rootKey: config.rootKey,
                serviceName: config.serviceName,
                defaultTTL: config.defaultTTL,
                host: config.host,
                port: config.port,
                password: config.password,
                db: config.db,
                url: config.url,
            });

        case "memory":
            return new MemoryCacheProvider({
                rootKey: config.rootKey,
                serviceName: config.serviceName,
                defaultTTL: config.defaultTTL,
                cleanupIntervalMs: config.cleanupIntervalMs,
            });

        default:
            // Exhaustive check — this should never happen with correct TypeScript usage,
            // but provides a clear runtime error if called with an invalid type
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const unknownType = (config as { type: string }).type;
            throw new Error(
                `Unknown cache type: "${unknownType}". Supported types: "redis", "memory".`
            );
    }
}
