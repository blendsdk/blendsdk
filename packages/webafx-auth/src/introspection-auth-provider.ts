/**
 * OAuth 2.0 Token Introspection provider (RFC 7662).
 *
 * Validates **opaque** access tokens — tokens that cannot be verified locally
 * with a signature — by asking the authorization server whether a token is
 * active. The provider follows the same dynamic-configuration convention as
 * `OidcAuthProvider`: a static client configuration may be supplied, or a
 * `configFactory(req)` may resolve the full configuration per request (for
 * example when client credentials live in a database and differ per tenant).
 *
 * Active responses are cached in a small in-memory LRU so a warm token does
 * not cause a network call on every request. The cache key is a SHA-256 digest
 * of the resolved endpoint/client scope plus the token, so the raw token is
 * never stored, logged, or used as a key, and one tenant's result can never be
 * served to another.
 *
 * Invalid tokens return `undefined` (the silent-failure pattern). Only
 * infrastructure failures — network errors, timeouts, non-2xx responses, or a
 * throwing `configFactory` — are raised as exceptions.
 *
 * @example
 * ```typescript
 * const provider = new IntrospectionAuthProvider({
 *     introspectionUrl: "https://auth.example.com/oauth2/introspect",
 *     clientId: process.env.CLIENT_ID!,
 *     clientSecret: process.env.CLIENT_SECRET!,
 *     audience: "https://api.example.com",
 * });
 *
 * const result = await provider.authenticate(req);
 * // result is AuthResult for an active token, undefined otherwise
 * ```
 *
 * @packageDocumentation
 */

import { createHash } from "node:crypto";

import type { Request } from "express";

import { AuthProvider } from "./abstract-auth-provider.js";
import type {
    AuthResult,
    IntrospectionAuthConfig,
    IntrospectionProviderConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default cache TTL in seconds when `cacheTTL` is not configured. */
const DEFAULT_CACHE_TTL = 60;

/** Default maximum number of cached introspection responses. */
const DEFAULT_MAX_CACHE_SIZE = 1000;

/** Default HTTP timeout in milliseconds when `timeout` is not configured. */
const DEFAULT_TIMEOUT = 5000;

/** Separator inserted between the cache scope and the token before hashing. */
const CACHE_KEY_SEPARATOR = "\u0000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Type guard: does this config carry a complete static client triple?
 *
 * @param config - Provider config to inspect
 * @returns true when `introspectionUrl`, `clientId`, and `clientSecret` are set
 */
function hasStaticConfig(
    config: IntrospectionProviderConfig
): config is IntrospectionAuthConfig {
    return Boolean(
        config.introspectionUrl && config.clientId && config.clientSecret
    );
}

/**
 * Hash a value with SHA-256 and return a hex digest.
 *
 * Used to derive cache keys so that raw tokens are never held as keys.
 *
 * @param value - Value to hash
 * @returns Lowercase hex SHA-256 digest
 */
function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

/**
 * Type guard: is this a plain introspection response object?
 *
 * A JSON body of `null`, an array, or a primitive is not a valid RFC 7662
 * response and must not be treated as claims.
 *
 * @param value - Parsed JSON value
 * @returns true when the value is a non-null, non-array object
 */
function isClaimsObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decide whether an audience is configured.
 *
 * Empty strings and empty arrays are treated as "not configured" so they do
 * not silently reject every token.
 *
 * @param audience - Configured audience value(s)
 * @returns true when at least one audience value is configured
 */
function hasAudience(
    audience: string | string[] | undefined
): audience is string | string[] {
    if (Array.isArray(audience)) {
        return audience.length > 0;
    }
    return Boolean(audience);
}

/**
 * Decide whether a response audience satisfies the configured expectation.
 *
 * The introspection `aud` claim may be a single string or an array. A token
 * satisfies the check when at least one configured value is present. When an
 * audience is configured but the response has none, the token is rejected.
 *
 * @param expected - Configured audience value(s)
 * @param actual - `aud` value from the introspection response
 * @returns true when the audience matches
 */
function matchesAudience(expected: string | string[], actual: unknown): boolean {
    const wanted = Array.isArray(expected) ? expected : [expected];

    let got: string[];
    if (Array.isArray(actual)) {
        got = actual.map((value) => String(value));
    } else if (typeof actual === "string") {
        got = [actual];
    } else {
        got = [];
    }

    return wanted.some((value) => got.includes(value));
}

/**
 * Compute the effective cache TTL in seconds.
 *
 * The TTL is the smaller of the configured TTL and the time left before the
 * token expires, so a cached entry never outlives the token it represents.
 *
 * @param configuredTtl - Configured `cacheTTL` in seconds
 * @param exp - Token expiration (seconds since epoch), if present
 * @param now - Current time (seconds since epoch)
 * @returns Effective TTL in seconds
 */
function computeCacheTtl(
    configuredTtl: number,
    exp: number | undefined,
    now: number
): number {
    if (exp === undefined) {
        return configuredTtl;
    }
    return Math.min(configuredTtl, exp - now);
}

// ---------------------------------------------------------------------------
// Response cache
// ---------------------------------------------------------------------------

/**
 * Minimal bounded LRU cache for active introspection responses.
 *
 * Backed by a `Map`, which preserves insertion order; a successful `get`
 * re-inserts the entry so the first key is always the least recently used.
 * Entries also carry an absolute expiry so callers never receive a stale
 * response.
 *
 * This class is internal to the provider and intentionally not exported.
 */
class IntrospectionCache {
    /** Entry store, ordered oldest-first for LRU eviction. */
    private readonly entries = new Map<
        string,
        { claims: Record<string, unknown>; expiresAt: number }
    >();

    /**
     * @param maxSize - Maximum number of entries kept before eviction
     */
    constructor(private readonly maxSize: number) {}

    /**
     * Read a cached response and refresh its recency.
     *
     * @param key - Hashed cache key
     * @returns The cached claims, or undefined when missing or expired
     */
    get(key: string): Record<string, unknown> | undefined {
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }
        if (entry.expiresAt <= Date.now()) {
            this.entries.delete(key);
            return undefined;
        }
        // Refresh recency: remove and re-insert so this entry is newest.
        this.entries.delete(key);
        this.entries.set(key, entry);
        // Return a shallow copy so a caller mutating the mapped claims cannot
        // corrupt the cached response.
        return { ...entry.claims };
    }

    /**
     * Store a response and evict the least recently used entries if needed.
     *
     * @param key - Hashed cache key
     * @param claims - Introspection response to cache
     * @param ttlSeconds - Time to live in seconds; non-positive values are ignored
     */
    set(key: string, claims: Record<string, unknown>, ttlSeconds: number): void {
        if (ttlSeconds <= 0) {
            return;
        }
        this.entries.delete(key);
        this.entries.set(key, {
            claims,
            expiresAt: Date.now() + ttlSeconds * 1000,
        });

        while (this.entries.size > this.maxSize) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.entries.delete(oldest);
        }
    }

    /** Remove every cached entry. */
    clear(): void {
        this.entries.clear();
    }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Authentication provider for opaque tokens using RFC 7662 introspection.
 *
 * The provider requires either a complete static configuration or a
 * `configFactory`; the constructor throws otherwise. `validate(token)` works
 * only with a static configuration — in factory-only mode use
 * `authenticate(req)`, which can resolve request-scoped credentials.
 */
export class IntrospectionAuthProvider extends AuthProvider {
    /**
     * The original configuration. It may carry a `configFactory` used by
     * `authenticate()` to resolve request-scoped client credentials.
     */
    protected readonly introspectionConfig: IntrospectionProviderConfig;

    /**
     * Static configuration when the constructor received a complete client
     * triple; otherwise `undefined` (factory-only mode).
     */
    protected readonly defaultConfig: IntrospectionAuthConfig | undefined;

    /** Bounded LRU cache of active introspection responses. */
    protected readonly cache: IntrospectionCache;

    /**
     * Create a new introspection authentication provider.
     *
     * @param config - Static configuration or a dynamic config with a factory
     * @throws Error when neither a complete static triple nor a `configFactory`
     *   is supplied
     */
    constructor(config: IntrospectionProviderConfig) {
        super(config);
        this.introspectionConfig = config;
        this.defaultConfig = hasStaticConfig(config) ? config : undefined;

        if (!config.configFactory && !this.defaultConfig) {
            throw new Error(
                "IntrospectionAuthProvider requires either introspectionUrl, " +
                    "clientId and clientSecret, or a configFactory"
            );
        }

        this.cache = new IntrospectionCache(
            config.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE
        );
    }

    // -----------------------------------------------------------------------
    // Authentication lifecycle
    // -----------------------------------------------------------------------

    /**
     * Validate a token using static configuration.
     *
     * Requires the constructor to have received a complete static triple. In
     * factory-only mode there is no request to resolve credentials from, so
     * this returns `undefined`; use `authenticate(req)` instead.
     *
     * @param token - Raw opaque token
     * @returns AuthResult for an active token, undefined otherwise
     */
    async validate(token: string): Promise<AuthResult | undefined> {
        if (!this.defaultConfig) {
            return undefined;
        }
        return this.introspectAndMap(token, this.defaultConfig);
    }

    /**
     * Extract the request token, resolve the effective configuration, and
     * introspect.
     *
     * When a `configFactory` is configured it is called once per request;
     * otherwise the static configuration is used.
     *
     * @param req - Express request object
     * @returns AuthResult for an active token, undefined otherwise
     */
    override async authenticate(
        req: Request
    ): Promise<AuthResult | undefined> {
        const token = this.extractToken(req);
        if (!token) {
            return undefined;
        }

        let effective: IntrospectionAuthConfig | undefined;
        if (this.introspectionConfig.configFactory) {
            effective = await this.introspectionConfig.configFactory(req);
        } else {
            effective = this.defaultConfig;
        }

        if (!effective) {
            return undefined;
        }

        // Defensive check: a configFactory could return an incomplete object
        // from untyped JavaScript. Fail clearly instead of building a bad URL.
        if (!hasStaticConfig(effective)) {
            throw new Error(
                "IntrospectionAuthProvider: resolved config is missing " +
                    "introspectionUrl, clientId or clientSecret"
            );
        }

        return this.introspectAndMap(token, effective);
    }

    /**
     * Health check — is the provider configured?
     *
     * This never performs a network call. It returns `true` when either a
     * static configuration or a `configFactory` is present, so DB-backed
     * providers are not reported as unhealthy.
     *
     * @returns true when the provider is configured
     */
    async health(): Promise<boolean> {
        return Boolean(
            this.defaultConfig || this.introspectionConfig.configFactory
        );
    }

    /**
     * Graceful shutdown — clear the cached introspection responses.
     */
    async shutdown(): Promise<void> {
        this.cache.clear();
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    /**
     * Validate a token against a specific configuration, using the cache.
     *
     * @param token - Raw opaque token
     * @param config - Complete static configuration to introspect with
     * @returns AuthResult for an active token, undefined otherwise
     */
    private async introspectAndMap(
        token: string,
        config: IntrospectionAuthConfig
    ): Promise<AuthResult | undefined> {
        // Scope the cache by endpoint and client so tenants never share
        // entries. Secrets are deliberately excluded from the key. `audience`
        // is not part of the scope: it is re-checked on every cache hit, so a
        // shared entry cannot bypass a stricter audience configuration.
        const scope = `${config.introspectionUrl}${CACHE_KEY_SEPARATOR}${config.clientId}`;
        const cacheKey = sha256(`${scope}${CACHE_KEY_SEPARATOR}${token}`);

        const cached = this.cache.get(cacheKey);
        if (cached) {
            return this.withPrincipalType(this.mapClaims(token, cached, config));
        }

        const claims = await this.introspect(token, config);

        if (claims.active !== true) {
            return undefined;
        }
        if (!this.isUsableClaims(claims, config)) {
            return undefined;
        }

        const exp = typeof claims.exp === "number" ? claims.exp : undefined;
        const now = Math.floor(Date.now() / 1000);

        const ttl = computeCacheTtl(
            config.cacheTTL ?? DEFAULT_CACHE_TTL,
            exp,
            now
        );
        this.cache.set(cacheKey, claims, ttl);

        return this.withPrincipalType(this.mapClaims(token, claims, config));
    }

    /**
     * Do an active response's audience and expiration still satisfy the config?
     *
     * Shared by the fresh and cached paths so the two can never drift.
     *
     * @param claims - Introspection response
     * @param config - Configuration the response was fetched with
     * @returns true when the claims are usable
     */
    private isUsableClaims(
        claims: Record<string, unknown>,
        config: IntrospectionAuthConfig
    ): boolean {
        if (
            hasAudience(config.audience) &&
            !matchesAudience(config.audience, claims.aud)
        ) {
            return false;
        }

        const exp = typeof claims.exp === "number" ? claims.exp : undefined;
        return exp === undefined || exp > Math.floor(Date.now() / 1000);
    }

    /**
     * Apply the audience and expiration checks to cached claims, then map.
     *
     * @param token - Raw opaque token
     * @param claims - Cached introspection response
     * @param config - Configuration the response was fetched with
     * @returns AuthResult when still valid, undefined otherwise
     */
    private mapClaims(
        token: string,
        claims: Record<string, unknown>,
        config: IntrospectionAuthConfig
    ): AuthResult | undefined {
        if (!this.isUsableClaims(claims, config)) {
            return undefined;
        }
        return this.claimsMapper(token, claims);
    }

    /**
     * Perform the RFC 7662 HTTP call.
     *
     * @param token - Raw opaque token
     * @param config - Complete static configuration
     * @returns Parsed introspection response
     * @throws Error on a non-2xx response, network failure, or timeout
     */
    private async introspect(
        token: string,
        config: IntrospectionAuthConfig
    ): Promise<Record<string, unknown>> {
        const controller = new AbortController();
        const timer = setTimeout(
            () => controller.abort(),
            config.timeout ?? DEFAULT_TIMEOUT
        );

        try {
            const body = new URLSearchParams({
                token,
                token_type_hint: "access_token",
            });

            const headers: Record<string, string> = {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
            };

            if (config.authMethod === "post") {
                body.set("client_id", config.clientId);
                body.set("client_secret", config.clientSecret);
            } else {
                // RFC 6749 §2.3.1: percent-encode each part, then base64.
                const encoded = `${encodeURIComponent(
                    config.clientId
                )}:${encodeURIComponent(config.clientSecret)}`;
                headers.Authorization = `Basic ${Buffer.from(encoded).toString(
                    "base64"
                )}`;
            }

            const response = await fetch(config.introspectionUrl, {
                method: "POST",
                headers,
                body,
                signal: controller.signal,
                // Do not follow redirects: the endpoint is app/tenant supplied
                // and a redirect could be abused to reach internal hosts.
                redirect: "error",
            });

            if (!response.ok) {
                // Status only — never echo the token or credentials.
                throw new Error(
                    `Token introspection failed with HTTP ${response.status}`
                );
            }

            const data: unknown = await response.json();
            if (!isClaimsObject(data)) {
                throw new Error(
                    "Token introspection returned an invalid response body"
                );
            }
            return data;
        } finally {
            clearTimeout(timer);
        }
    }
}
