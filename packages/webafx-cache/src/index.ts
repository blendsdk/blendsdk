/**
 * @blendsdk/webafx-cache — Application-wide caching and pub/sub plugin for WebAFX
 *
 * Provides two independent abstraction hierarchies:
 *
 * **Caching:**
 * - CacheProvider (abstract) → RedisCacheProvider, MemoryCacheProvider
 * - Plugin factories: createCachePlugin(), redisCachePlugin(), memoryCachePlugin(), createCache()
 *
 * **Pub/Sub Messaging:**
 * - PubSubProvider (abstract) → RedisPubSubProvider, MemoryPubSubProvider
 * - Plugin factories: createPubSubPlugin(), redisPubSubPlugin(), memoryPubSubPlugin(), createPubSub()
 *
 * Both integrate with WebAFX via convenience plugin factory functions that
 * register providers as application-wide singleton services.
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Shared Types & Constants
// ---------------------------------------------------------------------------
export type { RedisConnectionConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Cache Types & Constants
// ---------------------------------------------------------------------------
export type {
    CacheProviderConfig,
    RedisCacheConfig,
    MemoryCacheConfig,
    CacheFactoryConfig,
} from "./types.js";

export { DEFAULT_SERVICE_NAME, DEFAULT_TTL, KEY_SEPARATOR } from "./types.js";

// ---------------------------------------------------------------------------
// Pub/Sub Types & Constants
// ---------------------------------------------------------------------------
export type {
    PubSubProviderConfig,
    RedisPubSubConfig,
    MemoryPubSubConfig,
    PubSubFactoryConfig,
    PubSubMessage,
    MessageHandler,
    SubscriptionDefinition,
} from "./types.js";

export { DEFAULT_PUBSUB_SERVICE_NAME, CHANNEL_SEPARATOR } from "./types.js";

// ---------------------------------------------------------------------------
// Cache Abstract Base Class
// ---------------------------------------------------------------------------
export { CacheProvider } from "./abstract-cache-provider.js";

// ---------------------------------------------------------------------------
// Pub/Sub Abstract Base Class
// ---------------------------------------------------------------------------
export { PubSubProvider } from "./abstract-pubsub-provider.js";

// ---------------------------------------------------------------------------
// Cache Provider Implementations
// ---------------------------------------------------------------------------
export { MemoryCacheProvider } from "./memory-cache-provider.js";
export { RedisCacheProvider } from "./redis-cache-provider.js";

// ---------------------------------------------------------------------------
// Pub/Sub Provider Implementations
// ---------------------------------------------------------------------------
export { MemoryPubSubProvider } from "./memory-pubsub-provider.js";
export { RedisPubSubProvider } from "./redis-pubsub-provider.js";

// ---------------------------------------------------------------------------
// Cache Plugin Integration (WebAFX)
// ---------------------------------------------------------------------------
export { createCachePlugin, redisCachePlugin, memoryCachePlugin, createCache } from "./cache-plugin.js";

// ---------------------------------------------------------------------------
// Pub/Sub Plugin Integration (WebAFX)
// ---------------------------------------------------------------------------
export type { PubSubPluginOptions } from "./pubsub-plugin.js";
export {
    createPubSubPlugin,
    redisPubSubPlugin,
    memoryPubSubPlugin,
    createPubSub,
} from "./pubsub-plugin.js";
