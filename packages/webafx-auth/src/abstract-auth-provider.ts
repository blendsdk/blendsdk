/**
 * Abstract base class for all authentication provider implementations.
 *
 * Provides the common authentication lifecycle (extract token → validate → return
 * identity) and a configurable token extraction chain. Each concrete provider
 * implements only the `validate()` method — everything else is shared.
 *
 * Design principles:
 * - Application-wide singleton (not per-request)
 * - Configurable token extraction chain (header, cookie, query, custom)
 * - Silent failure pattern: invalid tokens return `undefined`, not throw
 * - Infrastructure errors (network, DNS) are the only thrown exceptions
 * - Claims mapping is pluggable via `mapClaims` config option
 *
 * @packageDocumentation
 */

import type { Request } from "express";

import type {
    AuthProviderConfig,
    AuthResult,
    ClaimsMapper,
    TokenSource,
} from "./types.js";

import {
    DEFAULT_COOKIE_NAME,
    DEFAULT_QUERY_PARAM_NAME,
    DEFAULT_SERVICE_NAME,
    DEFAULT_TOKEN_SOURCES,
} from "./types.js";

/**
 * Abstract base class for authentication providers.
 *
 * All auth backends (JWT, Introspection, OIDC, Tenant, Memory) derive from
 * this class. Provides a configurable token extraction chain and a standard
 * `authenticate()` lifecycle that concrete providers inherit without changes.
 *
 * Usage through concrete implementations:
 * ```typescript
 * const provider = new JwtAuthProvider({ secret: 'my-secret' });
 * const result = await provider.authenticate(req);
 * // result is AuthResult | undefined
 * ```
 */
export abstract class AuthProvider {
    /** Service name for WebAFX service container registration */
    protected _serviceName: string;

    /**
     * Ordered chain of token extractor functions.
     * Built from the `tokenSources` config at construction time.
     * Each function tries to extract a token from a different request location.
     */
    protected tokenExtractors: Array<(req: Request) => string | undefined>;

    /** Claims mapping function — transforms raw claims into AuthResult */
    protected claimsMapper: ClaimsMapper;

    /** Cookie name used by the 'cookie' token source */
    protected cookieName: string;

    /** Query parameter name used by the 'query' token source */
    protected queryParamName: string;

    /**
     * Initialize the auth provider with base configuration.
     *
     * Builds the token extraction chain from `tokenSources` config and
     * sets up the claims mapper (custom or default).
     *
     * @param config - Base configuration with token sources, cookie name, etc.
     */
    constructor(config: AuthProviderConfig = {}) {
        this._serviceName = config.serviceName ?? DEFAULT_SERVICE_NAME;
        this.cookieName = config.cookieName ?? DEFAULT_COOKIE_NAME;
        this.queryParamName = config.queryParamName ?? DEFAULT_QUERY_PARAM_NAME;

        // Use custom claims mapper if provided, otherwise fall back to the default.
        // The default mapper handles common JWT/OAuth2 claim formats (sub, exp, scope).
        this.claimsMapper = config.mapClaims ?? this.defaultClaimsMapper;

        // Build the ordered token extraction chain from config.
        // Each source becomes a function that tries one extraction strategy.
        this.tokenExtractors = this.buildExtractors(
            config.tokenSources ?? DEFAULT_TOKEN_SOURCES
        );
    }

    // -----------------------------------------------------------------------
    // Public Accessors
    // -----------------------------------------------------------------------

    /** Get the service name used for WebAFX service container registration */
    get serviceName(): string {
        return this._serviceName;
    }

    // -----------------------------------------------------------------------
    // Token Extraction (public — used by TenantAuthProvider and tests)
    // -----------------------------------------------------------------------

    /**
     * Extract a raw token string from the request.
     *
     * Tries each configured token source in order (header → cookie → query → custom).
     * Returns the first non-empty match, or `undefined` if no token is found.
     * This is NOT an error — unauthenticated requests are normal for public routes.
     *
     * @param req - Express request object
     * @returns The extracted token string, or undefined if no token found
     */
    extractToken(req: Request): string | undefined {
        // Walk the extraction chain in priority order — first match wins.
        // This allows applications to configure fallback strategies
        // (e.g., try header first, then fall back to cookie for browser clients).
        for (const extractor of this.tokenExtractors) {
            const token = extractor(req);
            if (token) {
                return token;
            }
        }
        return undefined;
    }

    // -----------------------------------------------------------------------
    // Authentication Lifecycle (public — called by plugin middleware)
    // -----------------------------------------------------------------------

    /**
     * Complete authentication flow: extract → validate → return result.
     *
     * This is the main entry point called by the plugin middleware on every
     * request. It is implemented once in the base class and works for all
     * providers — concrete providers only need to implement `validate()`.
     *
     * Returns `undefined` if:
     * - No token found in the request (unauthenticated, not an error)
     * - Token is invalid or expired (silent failure)
     *
     * Throws only on infrastructure failures (network errors, DNS failures).
     *
     * @param req - Express request object
     * @returns AuthResult if authenticated, undefined otherwise
     */
    async authenticate(req: Request): Promise<AuthResult | undefined> {
        const token = this.extractToken(req);
        if (!token) {
            return undefined;
        }
        return this.validate(token);
    }

    // -----------------------------------------------------------------------
    // Abstract Methods (must be implemented by each concrete provider)
    // -----------------------------------------------------------------------

    /**
     * Validate a raw token string and return the authenticated identity.
     *
     * Returns `undefined` if the token is invalid or expired (not an error).
     * Throws only on infrastructure failures (network errors, DNS failures).
     *
     * This is the ONLY method concrete providers must implement.
     * The base class handles everything else (extraction, lifecycle, mapping).
     *
     * @param token - Raw token string extracted from the request
     * @returns AuthResult if valid, undefined if invalid/expired
     */
    abstract validate(token: string): Promise<AuthResult | undefined>;

    /**
     * Health check — is the auth backend reachable and properly configured?
     *
     * Used by the WebAFX health endpoint to report provider status.
     * For local providers (JWT, Memory) this always returns true.
     * For remote providers (Introspection, OIDC) this checks connectivity.
     *
     * @returns true if the provider is operational
     */
    abstract health(): Promise<boolean>;

    /**
     * Graceful shutdown — clean up connections, cached keys, timers.
     *
     * Called by the WebAFX shutdown lifecycle when the application stops.
     * Providers should release all resources (HTTP connections, cached keys,
     * OIDC discovery state, tenant provider cache, etc.).
     */
    abstract shutdown(): Promise<void>;

    // -----------------------------------------------------------------------
    // Protected Helpers (used by concrete providers)
    // -----------------------------------------------------------------------

    /**
     * Default claims mapper: extracts sub, exp, and scopes from raw claims.
     *
     * Handles multiple common claim formats:
     * - `sub` or `subject` for the subject identifier
     * - `exp` for expiration (numeric seconds since epoch)
     * - `scope` (space-separated string) or `scopes` (array) for permissions
     *
     * Providers can override this by passing `mapClaims` in config.
     *
     * @param token - Original raw token string
     * @param rawClaims - Raw claims object from token validation
     * @returns Standardized AuthResult
     */
    protected defaultClaimsMapper(
        token: string,
        rawClaims: Record<string, unknown>
    ): AuthResult {
        // Extract subject — try 'sub' first (OAuth2/JWT standard), then 'subject'
        const sub = String(rawClaims.sub ?? rawClaims.subject ?? "unknown");

        // Extract expiration — must be a numeric timestamp (seconds since epoch)
        const exp =
            typeof rawClaims.exp === "number" ? rawClaims.exp : undefined;

        // Extract scopes from various claim formats:
        // - OAuth2 standard: "scope" as space-separated string (RFC 6749)
        // - Some providers: "scopes" as array
        // - Some providers: "scope" as array
        let scopes: string[] | undefined;
        if (typeof rawClaims.scope === "string") {
            scopes = rawClaims.scope.split(" ").filter(Boolean);
        } else if (Array.isArray(rawClaims.scopes)) {
            scopes = rawClaims.scopes.map(String);
        } else if (Array.isArray(rawClaims.scope)) {
            scopes = rawClaims.scope.map(String);
        }

        return { sub, claims: rawClaims, token, exp, scopes };
    }

    // -----------------------------------------------------------------------
    // Private Helpers (token extraction chain construction)
    // -----------------------------------------------------------------------

    /**
     * Build the ordered token extractor chain from configuration.
     *
     * Each configured source becomes a function that attempts to extract
     * a token from a specific request location. The resulting array is
     * walked in order by `extractToken()`.
     *
     * @param sources - Configured token sources in priority order
     * @returns Array of extractor functions
     * @throws Error if an unknown token source type is provided
     */
    private buildExtractors(
        sources: TokenSource[]
    ): Array<(req: Request) => string | undefined> {
        return sources.map((source) => {
            if (source === "header") {
                return (req: Request) => this.extractFromHeader(req);
            }
            if (source === "cookie") {
                return (req: Request) => this.extractFromCookie(req);
            }
            if (source === "query") {
                return (req: Request) => this.extractFromQuery(req);
            }
            if (typeof source === "object" && source.extractor) {
                return source.extractor;
            }
            throw new Error(
                `Unknown token source: ${JSON.stringify(source)}. ` +
                    `Supported: "header", "cookie", "query", or { extractor: fn }`
            );
        });
    }

    /**
     * Extract Bearer token from the Authorization header.
     *
     * Expects the format: `Authorization: Bearer <token>`
     * Returns undefined if the header is missing or doesn't start with "Bearer ".
     *
     * @param req - Express request object
     * @returns The token string without the "Bearer " prefix, or undefined
     */
    private extractFromHeader(req: Request): string | undefined {
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith("Bearer ")) {
            return authHeader.substring(7);
        }
        return undefined;
    }

    /**
     * Extract token from a named cookie.
     *
     * Requires cookie-parser middleware to be installed (already built into
     * WebAFX's core middleware). The cookie name is configured via `cookieName`
     * (default: `'auth_token'`).
     *
     * @param req - Express request object
     * @returns The cookie value as a string, or undefined
     */
    private extractFromCookie(req: Request): string | undefined {
        // req.cookies is populated by cookie-parser middleware.
        // If cookie-parser is not installed, req.cookies will be undefined.
        return req.cookies?.[this.cookieName] as string | undefined;
    }

    /**
     * Extract token from a query parameter.
     *
     * Useful for webhook callbacks, email verification links, and SSE endpoints
     * where headers can't be set. The parameter name is configured via
     * `queryParamName` (default: `'token'`).
     *
     * @param req - Express request object
     * @returns The query parameter value as a string, or undefined
     */
    private extractFromQuery(req: Request): string | undefined {
        const value = req.query?.[this.queryParamName];
        return typeof value === "string" ? value : undefined;
    }
}
