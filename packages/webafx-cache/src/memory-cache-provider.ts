/**
 * In-memory cache provider with TTL support.
 *
 * Zero external dependencies — suitable for development, testing,
 * and single-instance applications. Mimics Redis behavior:
 * - TTL in seconds (stored as expiration timestamps)
 * - Returns -1 for no expiry, -2 for missing key (ttl method)
 * - Pattern matching with * wildcard
 * - Periodic cleanup of expired entries
 *
 * Values are JSON-serialized/deserialized to match Redis behavior,
 * ensuring what goes in is what comes out with no reference sharing.
 *
 * @packageDocumentation
 */

import { CacheProvider } from "./abstract-cache-provider.js";
import type { MemoryCacheConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

/**
 * Internal structure for a cache entry in the memory store.
 * Stores the JSON-serialized value alongside an optional expiration timestamp.
 */
interface MemoryCacheEntry {
    /** JSON-serialized value */
    value: string;

    /** Expiration timestamp in milliseconds, or undefined for no expiry */
    expiresAt: number | undefined;
}

// ---------------------------------------------------------------------------
// Default Constants
// ---------------------------------------------------------------------------

/** Default cleanup interval: 60 seconds */
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// MemoryCacheProvider
// ---------------------------------------------------------------------------

/**
 * In-memory cache provider with TTL support.
 *
 * Uses a `Map<string, MemoryCacheEntry>` for storage with JSON serialization
 * to match Redis behavior. Expired entries are lazily evicted on access and
 * periodically cleaned up via a configurable interval timer.
 *
 * @example
 * ```typescript
 * const cache = new MemoryCacheProvider({
 *     rootKey: 'TestApp',
 *     defaultTTL: 60,
 *     cleanupIntervalMs: 5000,
 * });
 *
 * await cache.set('key', { data: true });
 * const value = await cache.get<{ data: boolean }>('key');
 * ```
 */
export class MemoryCacheProvider extends CacheProvider {
    /** Internal storage map: prefixed key → cache entry */
    protected store: Map<string, MemoryCacheEntry>;

    /** Handle for the periodic cleanup interval (undefined if stopped) */
    protected cleanupInterval: ReturnType<typeof setInterval> | undefined;

    /** Cleanup interval in milliseconds */
    protected cleanupIntervalMs: number;

    /**
     * Create a new in-memory cache provider.
     *
     * @param config - Memory cache configuration with rootKey and optional cleanup interval
     */
    constructor(config: MemoryCacheConfig) {
        super(config);
        this.store = new Map();
        this.cleanupIntervalMs = config.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;

        // Start periodic cleanup of expired entries to prevent memory leaks
        this.startCleanup();
    }

    // -----------------------------------------------------------------------
    // Core Operations
    // -----------------------------------------------------------------------

    /** @inheritDoc */
    async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
        const fullKey = this.buildKey(key);
        const serialized = JSON.stringify(value);
        const effectiveTTL = this.resolveTTL(ttlSeconds);

        const entry: MemoryCacheEntry = {
            value: serialized,
            // Convert TTL in seconds to an absolute expiration timestamp in ms
            expiresAt: effectiveTTL !== undefined ? Date.now() + effectiveTTL * 1000 : undefined,
        };

        this.store.set(fullKey, entry);
    }

    /** @inheritDoc */
    async get<T>(key: string): Promise<T | undefined> {
        const fullKey = this.buildKey(key);
        const entry = this.store.get(fullKey);

        if (!entry) {
            return undefined;
        }

        // Lazy eviction: check if the entry has expired
        if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
            this.store.delete(fullKey);
            return undefined;
        }

        // Deserialize — treat parse failures as cache miss (matches Redis provider)
        try {
            return JSON.parse(entry.value) as T;
        } catch {
            return undefined;
        }
    }

    /** @inheritDoc */
    async delete(key: string): Promise<boolean> {
        const fullKey = this.buildKey(key);
        return this.store.delete(fullKey);
    }

    /** @inheritDoc */
    async exists(key: string): Promise<boolean> {
        const fullKey = this.buildKey(key);
        const entry = this.store.get(fullKey);

        if (!entry) {
            return false;
        }

        // Lazy eviction: check if the entry has expired
        if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
            this.store.delete(fullKey);
            return false;
        }

        return true;
    }

    /** @inheritDoc */
    async expire(key: string, ttlSeconds: number): Promise<boolean> {
        const fullKey = this.buildKey(key);
        const entry = this.store.get(fullKey);

        if (!entry) {
            return false;
        }

        // Cannot update TTL on an already-expired entry
        if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
            this.store.delete(fullKey);
            return false;
        }

        // Update the expiration timestamp
        entry.expiresAt = Date.now() + ttlSeconds * 1000;
        return true;
    }

    /** @inheritDoc */
    async ttl(key: string): Promise<number> {
        const fullKey = this.buildKey(key);
        const entry = this.store.get(fullKey);

        // Key doesn't exist
        if (!entry) {
            return -2;
        }

        // Lazy eviction: check if the entry has expired
        if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
            this.store.delete(fullKey);
            return -2;
        }

        // No expiry set — key persists indefinitely
        if (entry.expiresAt === undefined) {
            return -1;
        }

        // Calculate remaining TTL in seconds (round up to match Redis behavior)
        const remaining = Math.ceil((entry.expiresAt - Date.now()) / 1000);
        return remaining > 0 ? remaining : -2;
    }

    // -----------------------------------------------------------------------
    // Pattern Operations
    // -----------------------------------------------------------------------

    /** @inheritDoc */
    async deletePattern(pattern: string): Promise<number> {
        const fullPattern = this.buildPattern(pattern);
        const regex = this.patternToRegex(fullPattern);
        let deleted = 0;

        // Collect keys first to avoid mutating the map during iteration
        const keysToDelete: string[] = [];
        for (const key of this.store.keys()) {
            if (regex.test(key)) {
                keysToDelete.push(key);
            }
        }

        for (const key of keysToDelete) {
            this.store.delete(key);
            deleted++;
        }

        return deleted;
    }

    /** @inheritDoc */
    async clear(): Promise<void> {
        // Only delete keys under this rootKey namespace (not other namespaces)
        const prefix = this.buildKey("");

        // Collect keys first to avoid mutating the map during iteration
        const keysToDelete: string[] = [];
        for (const key of this.store.keys()) {
            if (key.startsWith(prefix)) {
                keysToDelete.push(key);
            }
        }

        for (const key of keysToDelete) {
            this.store.delete(key);
        }
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    /** @inheritDoc */
    async health(): Promise<boolean> {
        // In-memory cache is always healthy as long as the process is running
        return true;
    }

    /** @inheritDoc */
    async shutdown(): Promise<void> {
        // Stop the cleanup interval to prevent further timer callbacks
        if (this.cleanupInterval !== undefined) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = undefined;
        }

        // Clear all entries from the store
        this.store.clear();
    }

    // -----------------------------------------------------------------------
    // Internal Helpers
    // -----------------------------------------------------------------------

    /**
     * Convert a glob-style pattern (with * wildcards) to a RegExp.
     *
     * Escapes all regex special characters except *, which becomes .* to
     * match any sequence of characters (mimicking Redis SCAN MATCH behavior).
     *
     * @param pattern - Glob pattern (e.g., 'MyApp:user:*')
     * @returns RegExp that matches the pattern
     */
    protected patternToRegex(pattern: string): RegExp {
        const escaped = pattern
            .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // Escape regex specials
            .replace(/\*/g, ".*"); // Convert * wildcard to .*
        return new RegExp(`^${escaped}$`);
    }

    /**
     * Start periodic cleanup of expired entries.
     *
     * Prevents unbounded memory growth from expired-but-not-accessed entries.
     * The interval timer is unref'd so it doesn't prevent Node.js from exiting.
     */
    protected startCleanup(): void {
        // Only start if interval is positive (0 or negative disables cleanup)
        if (this.cleanupIntervalMs <= 0) {
            return;
        }

        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            for (const [key, entry] of this.store.entries()) {
                if (entry.expiresAt !== undefined && now > entry.expiresAt) {
                    this.store.delete(key);
                }
            }
        }, this.cleanupIntervalMs);

        // Unref so the interval doesn't prevent the Node.js process from exiting
        if (this.cleanupInterval.unref) {
            this.cleanupInterval.unref();
        }
    }
}
