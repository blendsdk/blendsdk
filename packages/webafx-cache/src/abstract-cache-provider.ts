/**
 * Abstract base class for all cache provider implementations.
 *
 * Provides a Redis-like API with transparent key namespacing via rootKey prefix.
 * Both RedisCacheProvider and MemoryCacheProvider extend this class and implement
 * the abstract methods with backend-specific logic.
 *
 * Design principles:
 * - Application-wide singleton (not per-request)
 * - Root key prefix isolates keys per application/concern
 * - Configurable serviceName for multi-cache scenarios
 * - JSON serialization for all stored values
 * - All methods are async for a uniform API
 *
 * @packageDocumentation
 */

import type { CacheProviderConfig } from "./types.js";
import { DEFAULT_SERVICE_NAME, DEFAULT_TTL, KEY_SEPARATOR } from "./types.js";

/**
 * Abstract base class for cache implementations.
 *
 * All cache backends (Redis, In-Memory) derive from this class.
 * Provides a Redis-like API with transparent key namespacing via rootKey.
 *
 * Usage through concrete implementations:
 * ```typescript
 * const cache = new RedisCacheProvider({ rootKey: 'MyApp' });
 * await cache.set('user:123', { name: 'Alice' }, 300);
 * const user = await cache.get<User>('user:123');
 * ```
 */
export abstract class CacheProvider {
    /** Root key prefix applied to all cache keys */
    protected rootKey: string;

    /** Service name for WebAFX service container registration */
    protected _serviceName: string;

    /** Default TTL in seconds (0 = no expiry) */
    protected defaultTTL: number;

    /**
     * Initialize the cache provider with configuration.
     *
     * @param config - Base configuration with rootKey, optional serviceName and defaultTTL
     * @throws Error if rootKey is empty or not provided
     */
    constructor(config: CacheProviderConfig) {
        // Validate rootKey — it must be a non-empty string for namespace isolation
        if (!config.rootKey || config.rootKey.trim().length === 0) {
            throw new Error("CacheProvider: rootKey is required and cannot be empty");
        }

        this.rootKey = config.rootKey;
        this._serviceName = config.serviceName ?? DEFAULT_SERVICE_NAME;
        this.defaultTTL = config.defaultTTL ?? DEFAULT_TTL;
    }

    // -----------------------------------------------------------------------
    // Public Accessors
    // -----------------------------------------------------------------------

    /** Get the service name used for WebAFX service container registration */
    get serviceName(): string {
        return this._serviceName;
    }

    // -----------------------------------------------------------------------
    // Key Building (protected helpers for subclasses)
    // -----------------------------------------------------------------------

    /**
     * Build the actual storage key by prepending the root prefix.
     *
     * This method is called by every cache operation to ensure all keys
     * are namespaced under the rootKey, preventing key collisions in
     * shared backends (e.g., multiple apps sharing one Redis instance).
     *
     * @param key - The user-provided cache key
     * @returns The prefixed key (e.g., rootKey='MyApp', key='user:123' → 'MyApp:user:123')
     */
    protected buildKey(key: string): string {
        return `${this.rootKey}${KEY_SEPARATOR}${key}`;
    }

    /**
     * Build the pattern key for pattern-based operations (deletePattern, clear).
     *
     * @param pattern - The user-provided pattern (e.g., 'user:*')
     * @returns The prefixed pattern (e.g., 'MyApp:user:*')
     */
    protected buildPattern(pattern: string): string {
        return `${this.rootKey}${KEY_SEPARATOR}${pattern}`;
    }

    /**
     * Resolve the effective TTL for an operation.
     *
     * Uses the provided TTL if given, otherwise falls back to defaultTTL.
     * Returns undefined if effective TTL is 0 (meaning no expiry).
     *
     * @param ttlSeconds - Optional TTL override for this operation
     * @returns The effective TTL in seconds, or undefined if no expiry
     */
    protected resolveTTL(ttlSeconds?: number): number | undefined {
        const ttl = ttlSeconds ?? this.defaultTTL;
        return ttl > 0 ? ttl : undefined;
    }

    // -----------------------------------------------------------------------
    // Abstract Methods (must be implemented by each backend)
    // -----------------------------------------------------------------------

    /**
     * Set a value in the cache.
     *
     * The value is JSON-serialized before storage. The rootKey prefix
     * is applied automatically to the key.
     *
     * @param key - Cache key (rootKey prefix applied automatically)
     * @param value - Value to store (will be JSON-serialized)
     * @param ttlSeconds - Optional TTL in seconds. Uses defaultTTL if not provided. 0 = no expiry.
     */
    abstract set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;

    /**
     * Get a value from the cache.
     *
     * The stored JSON is deserialized before returning. Returns undefined
     * for cache misses or expired entries.
     *
     * @param key - Cache key (rootKey prefix applied automatically)
     * @returns The deserialized value, or undefined if not found / expired
     */
    abstract get<T>(key: string): Promise<T | undefined>;

    /**
     * Delete a key from the cache.
     *
     * @param key - Cache key (rootKey prefix applied automatically)
     * @returns true if the key was deleted, false if it didn't exist
     */
    abstract delete(key: string): Promise<boolean>;

    /**
     * Check if a key exists in the cache (and is not expired).
     *
     * @param key - Cache key (rootKey prefix applied automatically)
     * @returns true if the key exists and is not expired
     */
    abstract exists(key: string): Promise<boolean>;

    /**
     * Update the TTL on an existing key without changing its value.
     *
     * @param key - Cache key (rootKey prefix applied automatically)
     * @param ttlSeconds - New TTL in seconds
     * @returns true if the key exists and TTL was updated, false otherwise
     */
    abstract expire(key: string, ttlSeconds: number): Promise<boolean>;

    /**
     * Get the remaining TTL of a key in seconds.
     *
     * Follows Redis conventions for return values:
     * - Positive number: remaining TTL in seconds
     * - -1: key exists but has no expiry
     * - -2: key does not exist
     *
     * @param key - Cache key (rootKey prefix applied automatically)
     * @returns Remaining TTL in seconds, -1 if no expiry, -2 if key doesn't exist
     */
    abstract ttl(key: string): Promise<number>;

    /**
     * Delete all keys matching a pattern within this root namespace.
     *
     * Pattern uses '*' as wildcard:
     * - 'user:*' matches 'user:123', 'user:abc'
     * - '*:session' matches 'admin:session', 'guest:session'
     *
     * For Redis, this uses SCAN (not KEYS) to avoid blocking the server.
     *
     * @param pattern - Pattern to match (rootKey prefix applied automatically)
     * @returns Number of keys deleted
     */
    abstract deletePattern(pattern: string): Promise<number>;

    /**
     * Clear all keys under this root namespace.
     *
     * Only removes keys with this provider's rootKey prefix — does NOT
     * flush the entire Redis database or clear other namespaces.
     */
    abstract clear(): Promise<void>;

    /**
     * Health check — returns true if the backend is operational.
     *
     * For Redis: sends a PING command and checks connectivity.
     * For In-Memory: always returns true.
     */
    abstract health(): Promise<boolean>;

    /**
     * Graceful shutdown — close connections, clear intervals, release resources.
     *
     * For Redis: disconnects the ioredis client.
     * For In-Memory: clears the cleanup interval and empties the store.
     */
    abstract shutdown(): Promise<void>;

    // -----------------------------------------------------------------------
    // Concrete Methods (shared logic implemented once for all backends)
    // -----------------------------------------------------------------------

    /**
     * Cache-aside pattern: get a value if it exists, otherwise call the factory
     * function to produce it, cache the result, and return it.
     *
     * This is the most common caching pattern and is implemented once in the
     * base class since the logic is identical for all backends.
     *
     * @param key - Cache key (rootKey prefix applied automatically)
     * @param factory - Async function that produces the value on cache miss
     * @param ttlSeconds - Optional TTL in seconds for the cached value
     * @returns The cached or freshly produced value
     *
     * @example
     * ```typescript
     * const user = await cache.getOrSet('user:123', async () => {
     *     return await db.fetchUser(123);
     * }, 300); // Cache for 5 minutes
     * ```
     */
    async getOrSet<T>(key: string, factory: () => Promise<T>, ttlSeconds?: number): Promise<T> {
        // Try to get from cache first
        const cached = await this.get<T>(key);
        if (cached !== undefined) {
            return cached;
        }

        // Cache miss — call factory to produce the value
        const value = await factory();

        // Store in cache with the specified or default TTL
        await this.set(key, value, ttlSeconds);

        return value;
    }
}
