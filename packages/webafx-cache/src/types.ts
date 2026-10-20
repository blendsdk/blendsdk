/**
 * Type definitions and constants for the @blendsdk/webafx-cache package.
 *
 * Defines configuration interfaces for all cache and pub/sub providers
 * (Redis, In-Memory) and their environment-based factories. Constants
 * provide sensible defaults for service naming, TTL, key formatting,
 * and channel prefix handling.
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Shared Redis Connection Config
// ---------------------------------------------------------------------------

/**
 * Shared Redis connection configuration.
 *
 * Extracted as a common base so both cache and pub/sub Redis providers
 * can share the same connection field definitions without duplication.
 *
 * When `url` is provided, it takes precedence over host/port/password/db.
 */
export interface RedisConnectionConfig {
    /** Redis host. Default: 'localhost' */
    host?: string;

    /** Redis port. Default: 6379 */
    port?: number;

    /** Redis password (optional) */
    password?: string;

    /** Redis database index (0-15). Default: 0 */
    db?: number;

    /** Redis connection URL (overrides host/port/password/db if provided) */
    url?: string;

    /** Connection timeout in milliseconds. Default: 5000 */
    connectTimeout?: number;

    /** Maximum number of reconnection attempts. Default: 3 */
    maxRetriesPerRequest?: number;
}

// ---------------------------------------------------------------------------
// Cache Configuration Interfaces
// ---------------------------------------------------------------------------

/**
 * Base configuration shared by all cache providers.
 * Every provider requires at minimum a rootKey for namespace isolation.
 */
export interface CacheProviderConfig {
    /** Root key prefix for all cache keys (e.g., 'MyApp') */
    rootKey: string;

    /**
     * Service name for WebAFX service container registration.
     * Defaults to 'cache'. Use different names for multi-cache scenarios.
     */
    serviceName?: string;

    /** Default TTL in seconds. 0 means no expiry. Default: 0 */
    defaultTTL?: number;
}

/**
 * Redis-specific cache configuration.
 *
 * Extends base cache config with shared Redis connection options.
 * This is a non-breaking refactor — the interface exposes the exact
 * same fields as before, but Redis connection fields now come from
 * the shared `RedisConnectionConfig` base.
 *
 * When `url` is provided, it takes precedence over host/port/password/db.
 */
export interface RedisCacheConfig extends CacheProviderConfig, RedisConnectionConfig {}

/**
 * In-memory specific configuration.
 * Extends base config with memory management options.
 */
export interface MemoryCacheConfig extends CacheProviderConfig {
    /** Cleanup interval for expired entries in milliseconds. Default: 60000 (1 min) */
    cleanupIntervalMs?: number;
}

/**
 * Configuration for the createCache() environment-based factory.
 * Determines which backend to create based on the 'type' field.
 *
 * Redis-specific fields are only used when type === 'redis'.
 * Memory-specific fields are only used when type === 'memory'.
 */
export interface CacheFactoryConfig {
    /** Cache backend type */
    type: "redis" | "memory";

    /** Root key prefix for all cache keys */
    rootKey: string;

    /** Service name for WebAFX service container. Default: 'cache' */
    serviceName?: string;

    /** Default TTL in seconds. Default: 0 */
    defaultTTL?: number;

    // --- Redis-specific (only used when type === 'redis') ---

    /** Redis host */
    host?: string;

    /** Redis port */
    port?: number;

    /** Redis password */
    password?: string;

    /** Redis database index */
    db?: number;

    /** Redis connection URL */
    url?: string;

    // --- Memory-specific (only used when type === 'memory') ---

    /** Cleanup interval in ms */
    cleanupIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Pub/Sub Configuration Interfaces
// ---------------------------------------------------------------------------

/**
 * Base configuration shared by all pub/sub providers.
 *
 * The `channelPrefix` provides namespace isolation — all channels are
 * automatically prefixed so multiple applications can share the same
 * Redis instance without channel name collisions.
 */
export interface PubSubProviderConfig {
    /**
     * Channel prefix for namespace isolation.
     * Applied to all channels automatically.
     *
     * @example
     * // prefix='MyApp' → channel 'order:new' becomes 'MyApp:order:new'
     */
    channelPrefix?: string;

    /**
     * Service name for WebAFX service container registration.
     * Default: 'pubsub'. Use different names for multi-pubsub scenarios.
     */
    serviceName?: string;
}

/**
 * Redis-specific pub/sub configuration.
 *
 * Extends base pub/sub config with shared Redis connection options.
 * The provider creates **two** ioredis connections internally:
 * one for publishing and one for subscribing (Redis requires
 * a dedicated connection once it enters subscriber mode).
 */
export interface RedisPubSubConfig extends PubSubProviderConfig, RedisConnectionConfig {}

/**
 * In-memory specific pub/sub configuration.
 * No additional fields beyond the base config.
 */
export interface MemoryPubSubConfig extends PubSubProviderConfig {}

/**
 * Configuration for the createPubSub() environment-based factory.
 * Determines which backend to create based on the 'type' field.
 *
 * Redis-specific fields are only used when type === 'redis'.
 */
export interface PubSubFactoryConfig extends PubSubProviderConfig {
    /** Pub/sub backend type */
    type: "redis" | "memory";

    // --- Redis-specific (only used when type === 'redis') ---

    /** Redis host */
    host?: string;

    /** Redis port */
    port?: number;

    /** Redis password */
    password?: string;

    /** Redis database index */
    db?: number;

    /** Redis connection URL */
    url?: string;
}

// ---------------------------------------------------------------------------
// Pub/Sub Message Types
// ---------------------------------------------------------------------------

/**
 * Message envelope delivered to subscription handlers.
 *
 * Contains the deserialized payload and metadata about the channel
 * and (for pattern subscriptions) the pattern that matched.
 * The `channel` field always contains the user-facing name
 * (prefix stripped), not the internal prefixed name.
 */
export interface PubSubMessage<T = unknown> {
    /** The channel the message was published to (prefix stripped) */
    channel: string;

    /** The deserialized message payload */
    data: T;

    /** For pattern subscriptions: the pattern that matched (prefix stripped) */
    pattern?: string;
}

/**
 * Handler function for pub/sub messages.
 *
 * Can be synchronous or asynchronous. Errors thrown by handlers are
 * caught and logged — they do not break other subscribers or crash
 * the subscriber connection.
 */
export type MessageHandler<T = unknown> = (message: PubSubMessage<T>) => void | Promise<void>;

/**
 * Subscription definition for declarative registration via plugin config.
 *
 * Exactly one of `channel` or `pattern` must be provided.
 * - `channel` subscribes to an exact channel (SUBSCRIBE)
 * - `pattern` subscribes to a glob pattern (PSUBSCRIBE)
 */
export interface SubscriptionDefinition<T = unknown> {
    /** Exact channel name (mutually exclusive with `pattern`) */
    channel?: string;

    /** Channel pattern with glob wildcards (mutually exclusive with `channel`) */
    pattern?: string;

    /** Handler function invoked when a matching message arrives */
    handler: MessageHandler<T>;
}

// ---------------------------------------------------------------------------
// Cache Constants
// ---------------------------------------------------------------------------

/** Default service name for cache when not specified */
export const DEFAULT_SERVICE_NAME = "cache";

/** Default TTL (0 = no expiry) */
export const DEFAULT_TTL = 0;

/** Key separator between rootKey and user-provided key */
export const KEY_SEPARATOR = ":";

// ---------------------------------------------------------------------------
// Pub/Sub Constants
// ---------------------------------------------------------------------------

/** Default service name for pub/sub when not specified */
export const DEFAULT_PUBSUB_SERVICE_NAME = "pubsub";

/** Channel prefix separator (same as key separator for consistency) */
export const CHANNEL_SEPARATOR = ":";
