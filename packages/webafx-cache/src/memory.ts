/**
 * Redis-free entry point for `@blendsdk/webafx-cache`.
 *
 * The main entry point exports the Redis providers, whose modules import
 * `ioredis` at load time. Applications that only need the in-memory providers
 * — tests, single-instance deployments — can import from this subpath instead,
 * and `ioredis` is never loaded.
 *
 * @packageDocumentation
 */

import type { PluginDefinition } from "@blendsdk/webafx";
import { CacheProvider } from "./abstract-cache-provider.js";
import { PubSubProvider } from "./abstract-pubsub-provider.js";
import { MemoryCacheProvider } from "./memory-cache-provider.js";
import { MemoryPubSubProvider } from "./memory-pubsub-provider.js";
import { createCachePlugin } from "./cache-provider-plugin.js";
import {
    createPubSubPlugin,
    type PubSubPluginOptions,
} from "./pubsub-provider-plugin.js";
import type {
    CacheProviderConfig,
    MemoryCacheConfig,
    MemoryPubSubConfig,
    PubSubMessage,
    MessageHandler,
    SubscriptionDefinition,
} from "./types.js";

// ---------------------------------------------------------------------------
// Providers, builders, and types (no Redis)
// ---------------------------------------------------------------------------

export {
    CacheProvider,
    PubSubProvider,
    MemoryCacheProvider,
    MemoryPubSubProvider,
    createCachePlugin,
    createPubSubPlugin,
};

export type {
    CacheProviderConfig,
    MemoryCacheConfig,
    MemoryPubSubConfig,
    PubSubPluginOptions,
    PubSubMessage,
    MessageHandler,
    SubscriptionDefinition,
};

// ---------------------------------------------------------------------------
// Memory plugin factories
// ---------------------------------------------------------------------------

/**
 * Create a WebAFX cache plugin backed by an in-memory provider.
 *
 * @param config - Memory cache configuration (rootKey, defaultTTL, etc.)
 * @returns A WebAFX PluginDefinition ready to pass to app.use()
 *
 * @example
 * ```typescript
 * app.use(memoryCachePlugin({ rootKey: 'MyApp' }));
 * ```
 */
export function memoryCachePlugin(config: MemoryCacheConfig): PluginDefinition {
    return createCachePlugin(new MemoryCacheProvider(config));
}

/**
 * Create a WebAFX pub/sub plugin backed by an in-memory provider.
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
    return createPubSubPlugin(new MemoryPubSubProvider(config), options);
}
