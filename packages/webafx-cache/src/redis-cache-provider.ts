/**
 * Redis-backed cache provider using ioredis.
 *
 * Production-grade implementation with:
 * - Native TTL support via Redis EXPIRE/EX
 * - SCAN-based pattern deletion (safe for production, never uses KEYS)
 * - Automatic JSON serialization/deserialization
 * - Connection health monitoring via PING
 * - Graceful shutdown via quit()
 *
 * @packageDocumentation
 */

import { Redis } from "ioredis";
import { CacheProvider } from "./abstract-cache-provider.js";
import type { RedisCacheConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Default Constants
// ---------------------------------------------------------------------------

/** Default connection timeout in milliseconds */
const DEFAULT_CONNECT_TIMEOUT = 5000;

/** Default max retries per request */
const DEFAULT_MAX_RETRIES = 3;

/** Default Redis host */
const DEFAULT_HOST = "localhost";

/** Default Redis port */
const DEFAULT_PORT = 6379;

/** Default Redis database index */
const DEFAULT_DB = 0;

/** Batch size for SCAN operations — how many keys to fetch per SCAN iteration */
const SCAN_BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// RedisCacheProvider
// ---------------------------------------------------------------------------

/**
 * Redis-backed cache provider using ioredis.
 *
 * Connects to a Redis instance via URL or host/port configuration.
 * All cache operations map directly to Redis commands for optimal performance.
 * Pattern-based operations use SCAN (not KEYS) to avoid blocking the server.
 *
 * @example
 * ```typescript
 * const cache = new RedisCacheProvider({
 *     rootKey: 'MyApp',
 *     host: 'localhost',
 *     port: 6379,
 *     defaultTTL: 300,
 * });
 *
 * await cache.set('user:123', { name: 'Alice' }, 600);
 * const user = await cache.get<User>('user:123');
 * await cache.shutdown();
 * ```
 */
export class RedisCacheProvider extends CacheProvider {
    /** The ioredis client instance */
    protected client: Redis;

    /**
     * Create a new Redis cache provider.
     *
     * If `url` is provided in config, it takes precedence over individual
     * host/port/password/db settings. The ioredis client is created immediately
     * and begins connecting in the background.
     *
     * @param config - Redis cache configuration with connection details
     */
    constructor(config: RedisCacheConfig) {
        super(config);

        // Initialize ioredis client — URL takes precedence over individual options
        if (config.url) {
            this.client = new Redis(config.url, {
                db: config.db,
                connectTimeout: config.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT,
                maxRetriesPerRequest: config.maxRetriesPerRequest ?? DEFAULT_MAX_RETRIES,
            });
        } else {
            this.client = new Redis({
                host: config.host ?? DEFAULT_HOST,
                port: config.port ?? DEFAULT_PORT,
                password: config.password,
                db: config.db ?? DEFAULT_DB,
                connectTimeout: config.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT,
                maxRetriesPerRequest: config.maxRetriesPerRequest ?? DEFAULT_MAX_RETRIES,
            });
        }
    }

    // -----------------------------------------------------------------------
    // Core Operations
    // -----------------------------------------------------------------------

    /** @inheritDoc */
    async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
        const fullKey = this.buildKey(key);
        const serialized = JSON.stringify(value);
        const effectiveTTL = this.resolveTTL(ttlSeconds);

        if (effectiveTTL !== undefined) {
            // SET with EX flag for TTL in seconds
            await this.client.set(fullKey, serialized, "EX", effectiveTTL);
        } else {
            // SET without expiry
            await this.client.set(fullKey, serialized);
        }
    }

    /** @inheritDoc */
    async get<T>(key: string): Promise<T | undefined> {
        const fullKey = this.buildKey(key);
        const result = await this.client.get(fullKey);

        // Redis returns null for missing keys
        if (result === null) {
            return undefined;
        }

        // Deserialize — treat JSON parse failures as cache miss
        try {
            return JSON.parse(result) as T;
        } catch {
            return undefined;
        }
    }

    /** @inheritDoc */
    async delete(key: string): Promise<boolean> {
        const fullKey = this.buildKey(key);
        const result = await this.client.del(fullKey);
        // DEL returns the number of keys removed (0 or 1 for a single key)
        return result === 1;
    }

    /** @inheritDoc */
    async exists(key: string): Promise<boolean> {
        const fullKey = this.buildKey(key);
        const result = await this.client.exists(fullKey);
        // EXISTS returns 1 if the key exists, 0 if it doesn't
        return result === 1;
    }

    /** @inheritDoc */
    async expire(key: string, ttlSeconds: number): Promise<boolean> {
        const fullKey = this.buildKey(key);
        const result = await this.client.expire(fullKey, ttlSeconds);
        // EXPIRE returns 1 if TTL was set, 0 if key doesn't exist
        return result === 1;
    }

    /** @inheritDoc */
    async ttl(key: string): Promise<number> {
        const fullKey = this.buildKey(key);
        // TTL returns: positive = remaining seconds, -1 = no expiry, -2 = key missing
        return await this.client.ttl(fullKey);
    }

    // -----------------------------------------------------------------------
    // Pattern Operations
    // -----------------------------------------------------------------------

    /** @inheritDoc */
    async deletePattern(pattern: string): Promise<number> {
        // Use SCAN to find matching keys (safe for production, non-blocking)
        const fullPattern = this.buildPattern(pattern);
        return await this.scanAndDelete(fullPattern);
    }

    /** @inheritDoc */
    async clear(): Promise<void> {
        // Delete all keys under this rootKey namespace using SCAN + DEL
        const fullPattern = this.buildPattern("*");
        await this.scanAndDelete(fullPattern);
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    /** @inheritDoc */
    async health(): Promise<boolean> {
        try {
            const result = await this.client.ping();
            return result === "PONG";
        } catch {
            // Connection failure, timeout, etc.
            return false;
        }
    }

    /** @inheritDoc */
    async shutdown(): Promise<void> {
        // Graceful disconnect — waits for pending commands to complete
        await this.client.quit();
    }

    // -----------------------------------------------------------------------
    // Internal Helpers
    // -----------------------------------------------------------------------

    /**
     * Use SCAN to find keys matching a pattern and delete them in batches.
     *
     * SCAN is non-blocking and safe for production (unlike KEYS which blocks
     * the entire Redis server). Keys are deleted in batches as they are found.
     *
     * @param pattern - The full pattern to match (already includes rootKey prefix)
     * @returns Number of keys deleted
     */
    protected async scanAndDelete(pattern: string): Promise<number> {
        let cursor = "0";
        let totalDeleted = 0;

        do {
            // SCAN returns [nextCursor, matchingKeys]
            const [nextCursor, keys] = await this.client.scan(
                cursor,
                "MATCH",
                pattern,
                "COUNT",
                SCAN_BATCH_SIZE
            );
            cursor = nextCursor;

            // Delete found keys in one DEL command (batch delete)
            if (keys.length > 0) {
                const deleted = await this.client.del(...keys);
                totalDeleted += deleted;
            }
        } while (cursor !== "0");

        return totalDeleted;
    }
}
