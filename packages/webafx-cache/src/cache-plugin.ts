/**
 * WebAFX plugin integration for cache providers.
 *
 * Provides convenience factory functions that wire a CacheProvider instance
 * into a WebAFX application as a singleton service with health check and
 * graceful shutdown support.
 *
 * This is one of the few files in @blendsdk/webafx-cache that imports from
 * @blendsdk/webafx, which is why webafx is a peer dependency (not a hard
 * dependency). The Redis-backed factories here load the Redis provider; the
 * memory entry point ({@link ./memory.js}) has no Redis dependency.
 *
 * @packageDocumentation
 */

import type { PluginDefinition } from "@blendsdk/webafx";
import { CacheProvider } from "./abstract-cache-provider.js";
import { MemoryCacheProvider } from "./memory-cache-provider.js";
import { RedisCacheProvider } from "./redis-cache-provider.js";
import type { CacheFactoryConfig, RedisCacheConfig } from "./types.js";
import { createCachePlugin } from "./cache-provider-plugin.js";

// Re-export the Redis-free builder and the memory factory so the main entry
// point keeps its existing public names.
export { createCachePlugin } from "./cache-provider-plugin.js";
export { memoryCachePlugin } from "./memory.js";

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
