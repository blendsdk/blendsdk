/**
 * OIDC authentication provider using openid-client v6 and jose.
 *
 * Validates JWT access tokens using OIDC discovery for JWKS key resolution,
 * and provides BFF (Backend-For-Frontend) methods for authorization code flow
 * with PKCE. Supports both static single-tenant and dynamic multi-tenant
 * configurations via configFactory.
 *
 * Token validation uses `jose.jwtVerify()` with `createRemoteJWKSet()` using
 * the JWKS URI obtained from OIDC discovery — the same pattern as JwtAuthProvider
 * but with automatic key rotation via discovery.
 *
 * BFF methods use `openid-client` v6 for standards-compliant OIDC flows:
 * - Authorization URL construction with PKCE (S256)
 * - Authorization code exchange with nonce validation
 * - Token refresh, revocation, and userinfo retrieval
 *
 * @packageDocumentation
 */

import * as client from "openid-client";
import { jwtVerify, createRemoteJWKSet } from "jose";
import type { JWTVerifyGetKey } from "jose";
import type { Request } from "express";

import { AuthProvider } from "./abstract-auth-provider.js";
import type { AuthResult } from "./types.js";
import type {
    OidcAuthConfig,
    OidcTokens,
    OidcSession,
    AuthorizationUrlResult,
    BuildAuthorizationUrlParams,
    ExchangeCodeParams,
} from "./oidc-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default session cookie name when resolveSessionCookieName is not configured */
const DEFAULT_SESSION_COOKIE = "__oidc_session";

/** Default state cookie name when resolveStateCookieName is not configured */
const DEFAULT_STATE_COOKIE = "__oidc_state";

/** Cache key prefix for server-side sessions */
const SESSION_KEY_PREFIX = "oidc:session:";

/** Cache key prefix for PKCE transient state */
const STATE_KEY_PREFIX = "oidc:state:";

/** Default session TTL in seconds (1 hour) */
const DEFAULT_SESSION_TTL = 3600;

/** Default state TTL in seconds (5 minutes) */
const DEFAULT_STATE_TTL = 300;

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

/**
 * Cached OIDC discovery configuration.
 *
 * Stores both the openid-client Configuration (for BFF methods) and the
 * jose JWKS key resolver (for JWT validation) to avoid redundant HTTP calls.
 */
interface CachedConfig {
    /** openid-client Configuration — used by BFF methods */
    configuration: client.Configuration;
    /** jose JWKS key set resolver — used by validate()/authenticate() */
    jwks: JWTVerifyGetKey;
    /** Issuer from discovery metadata — used for JWT issuer validation */
    issuer: string;
    /** Cache expiration timestamp in milliseconds */
    expiresAt: number;
}

// ---------------------------------------------------------------------------
// OidcAuthProvider
// ---------------------------------------------------------------------------

/**
 * OIDC-native authentication provider.
 *
 * Extends the AuthProvider base class with OIDC discovery-based JWT validation
 * and BFF methods for server-side authorization code flow with PKCE.
 *
 * Two operational modes:
 * 1. **Token validation** — validates JWT access tokens on every request via
 *    the inherited `authenticate(req)` pipeline, using JWKS from OIDC discovery
 * 2. **BFF engine** — provides methods for server-side OIDC flows used by
 *    OidcAuthController (buildAuthorizationUrl, exchangeCode, etc.)
 *
 * @example Static config (single tenant)
 * ```typescript
 * const provider = new OidcAuthProvider({
 *     serviceName: "oidc",
 *     issuerUrl: "https://auth.example.com",
 *     clientId: "my-app",
 *     clientSecret: "secret",
 *     redirectUri: "https://app.example.com/auth/callback",
 *     audience: "https://api.example.com",
 * });
 * ```
 *
 * @example Multi-tenant (configFactory)
 * ```typescript
 * const provider = new OidcAuthProvider({
 *     serviceName: "oidc-multi",
 *     configFactory: async (req) => ({
 *         issuerUrl: resolveTenantIssuer(req),
 *         clientId: resolveTenantClientId(req),
 *     }),
 * });
 * ```
 */
export class OidcAuthProvider extends AuthProvider {
    /** OIDC-specific configuration stored separately from base config */
    protected readonly oidcConfig: OidcAuthConfig;

    /**
     * Discovery configuration cache, keyed by issuerUrl.
     * Each entry contains the openid-client Configuration, jose JWKS resolver,
     * issuer string, and cache expiration timestamp.
     */
    protected readonly discoveryCache = new Map<string, CachedConfig>();

    /**
     * Create a new OIDC auth provider.
     *
     * Requires either `issuerUrl` (for static single-tenant) or `configFactory`
     * (for dynamic multi-tenant). Both can be provided — static config is used
     * for `validate()` and `health()`, factory is used for per-request `authenticate()`.
     *
     * @param config - OIDC configuration with issuer, client credentials, and BFF params
     * @throws Error if neither issuerUrl nor configFactory is provided
     */
    constructor(config: OidcAuthConfig) {
        super(config);
        this.oidcConfig = config;

        // Validate: at least one configuration source must be present (AR #7)
        if (!config.issuerUrl && !config.configFactory) {
            throw new Error(
                "OidcAuthProvider requires either issuerUrl or configFactory"
            );
        }
    }

    // -----------------------------------------------------------------------
    // Core Authentication
    // -----------------------------------------------------------------------

    /**
     * Validate a JWT access token using static OIDC configuration.
     *
     * Uses `jose.jwtVerify()` with JWKS from OIDC discovery to verify the
     * token's signature, expiration, issuer, and audience claims.
     *
     * Returns `undefined` when only `configFactory` is configured (no Request
     * context available for per-request resolution). (AR #11)
     *
     * @param token - Raw JWT access token string
     * @returns AuthResult if valid, undefined if invalid/expired or no static config
     */
    async validate(token: string): Promise<AuthResult | undefined> {
        // Static config only — configFactory needs Request context (AR #11)
        if (!this.oidcConfig.issuerUrl || !this.oidcConfig.clientId) {
            return undefined;
        }

        try {
            const cached = await this.getDiscoveryConfig(
                this.oidcConfig.issuerUrl,
                this.oidcConfig.clientId,
                this.oidcConfig.clientSecret
            );

            const clockTolerance = this.oidcConfig.clockTolerance ?? 30;
            const audience = this.oidcConfig.audience;

            // Validate JWT using jose — same approach as JwtAuthProvider
            const { payload } = await jwtVerify(token, cached.jwks, {
                issuer: cached.issuer,
                clockTolerance,
                ...(audience ? { audience } : {}),
            });

            // Use the inherited claimsMapper (from base class) — same as JwtAuthProvider
            const claims = payload as Record<string, unknown>;
            return this.claimsMapper(token, claims);
        } catch {
            // Silent failure for validation — invalid tokens return undefined
            return undefined;
        }
    }

    /**
     * Authenticate a request using OIDC token validation with dual-mode support.
     *
     * Overrides the base class to support `configFactory` per-request resolution,
     * `resolveUser` async callback, and server-side session cookie fallback. (AR #7, #8)
     *
     * Authentication priority:
     * 1. **Bearer token** — JWT validation via OIDC discovery (highest priority)
     * 2. **Session cookie** — Server-side session lookup via CacheProvider (fallback)
     *
     * Resolution priority for building AuthResult (Bearer path):
     * 1. `resolveUser(req, claims)` — OIDC-specific async resolver (highest priority)
     * 2. `mapClaims(token, claims)` — standard claims mapper from config
     * 3. `this.claimsMapper(token, claims)` — inherited default mapper (lowest priority)
     *
     * @param req - Express request object
     * @returns AuthResult if authenticated, undefined otherwise
     */
    override async authenticate(
        req: Request
    ): Promise<AuthResult | undefined> {
        // --- Path 1: Bearer token (highest priority) ---
        const token = this.extractToken(req);
        if (token) {
            try {
                // Determine config: configFactory (per-request) or static
                // Inside try/catch so configFactory errors return undefined (silent)
                const effectiveConfig = this.oidcConfig.configFactory
                    ? await this.oidcConfig.configFactory(req)
                    : this.oidcConfig;

                if (!effectiveConfig.issuerUrl || !effectiveConfig.clientId) {
                    return undefined;
                }

                const cached = await this.getDiscoveryConfig(
                    effectiveConfig.issuerUrl,
                    effectiveConfig.clientId,
                    effectiveConfig.clientSecret
                );

                const clockTolerance =
                    effectiveConfig.clockTolerance ??
                    this.oidcConfig.clockTolerance ??
                    30;
                const audience =
                    effectiveConfig.audience ?? this.oidcConfig.audience;

                // Validate JWT using jose with JWKS from discovery
                const { payload } = await jwtVerify(token, cached.jwks, {
                    issuer: cached.issuer,
                    clockTolerance,
                    ...(audience ? { audience } : {}),
                });

                const claims = payload as Record<string, unknown>;

                // resolveUser takes priority over mapClaims (AR #8)
                const resolveUser =
                    effectiveConfig.resolveUser ?? this.oidcConfig.resolveUser;
                if (resolveUser) {
                    return resolveUser(req, claims);
                }

                // Fall back to mapClaims via effectiveConfig or base claimsMapper
                const mapClaims =
                    effectiveConfig.mapClaims ?? this.oidcConfig.mapClaims;
                if (mapClaims) {
                    return mapClaims(token, claims);
                }

                // Default: use inherited claimsMapper (from base class constructor)
                return this.claimsMapper(token, claims);
            } catch {
                // Silent failure — configFactory errors, discovery errors, JWT errors
                return undefined;
            }
        }

        // --- Path 2: Session cookie fallback (AR #2, #8) ---
        const { sessionStore } = this.oidcConfig;
        if (!sessionStore) return undefined;

        // Resolve cookie name: org-scoped or default
        const cookieName = this.getSessionCookieName(req);

        const sessionId = this.parseCookieByName(req, cookieName);
        if (!sessionId) return undefined;

        // Look up session in CacheProvider — errors propagate as 500 (AR #13)
        const session = await sessionStore.get<OidcSession>(
            `${SESSION_KEY_PREFIX}${sessionId}`
        );
        if (!session) return undefined;

        // Build AuthResult from session data
        return {
            sub: (session.user.sub as string) ?? "unknown",
            claims: session.user,
            token: session.accessToken,
            exp: session.expiresAt,
        };
    }

    // -----------------------------------------------------------------------
    // Lifecycle Methods
    // -----------------------------------------------------------------------

    /**
     * Health check — verifies static config is present and discovery succeeds.
     *
     * Returns `true` only when a static issuerUrl + clientId are configured AND
     * OIDC discovery can reach the provider. Returns `false` for configFactory-only
     * setups (no static config to check). (AR #12)
     *
     * @returns true if the provider is operational with static config
     */
    async health(): Promise<boolean> {
        if (!this.oidcConfig.issuerUrl || !this.oidcConfig.clientId) {
            return false;
        }

        try {
            await this.getDiscoveryConfig(
                this.oidcConfig.issuerUrl,
                this.oidcConfig.clientId,
                this.oidcConfig.clientSecret
            );
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Graceful shutdown — clears all cached OIDC discovery configurations.
     *
     * After shutdown, the next `validate()` or BFF call will trigger fresh
     * OIDC discovery.
     */
    async shutdown(): Promise<void> {
        this.discoveryCache.clear();
    }

    // -----------------------------------------------------------------------
    // BFF Methods
    // -----------------------------------------------------------------------

    /**
     * Build an OIDC authorization URL with PKCE for the authorization code flow.
     *
     * Returns the URL to redirect the user to, along with the PKCE code verifier,
     * state, and nonce that must be stored server-side for callback validation.
     *
     * Config defaults are used for clientId, redirectUri, and scopes unless
     * overridden via the `params` argument. (AR #16)
     *
     * @param config - Optional config override (for multi-tenant BFF scenarios)
     * @param params - Optional parameter overrides for this specific authorization request
     * @returns Authorization URL, code verifier, state, and nonce
     * @throws Error if clientId, redirectUri, or issuerUrl is missing
     */
    async buildAuthorizationUrl(
        config?: OidcAuthConfig,
        params?: BuildAuthorizationUrlParams
    ): Promise<AuthorizationUrlResult> {
        const effectiveConfig = this.resolveConfig(config);

        const clientId = params?.clientId ?? effectiveConfig.clientId;
        const redirectUri = params?.redirectUri ?? effectiveConfig.redirectUri;
        const scopes =
            params?.scopes ??
            effectiveConfig.scopes ?? ["openid", "profile", "email"];

        if (!clientId)
            throw new Error(
                "clientId is required for buildAuthorizationUrl"
            );
        if (!redirectUri)
            throw new Error(
                "redirectUri is required for buildAuthorizationUrl"
            );
        if (!effectiveConfig.issuerUrl)
            throw new Error(
                "issuerUrl is required for buildAuthorizationUrl"
            );

        const cached = await this.getDiscoveryConfig(
            effectiveConfig.issuerUrl,
            clientId,
            effectiveConfig.clientSecret
        );

        // Generate PKCE challenge pair (S256 — no implicit flow)
        const codeVerifier = client.randomPKCECodeVerifier();
        const codeChallenge =
            await client.calculatePKCECodeChallenge(codeVerifier);

        // Generate state and nonce for callback validation
        const state = client.randomState();
        const nonce = client.randomNonce();

        const authUrl = client.buildAuthorizationUrl(cached.configuration, {
            redirect_uri: redirectUri,
            scope: scopes.join(" "),
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            state,
            nonce,
            ...params?.extraParams,
        });

        return {
            url: authUrl.href,
            codeVerifier,
            state,
            nonce,
        };
    }

    /**
     * Exchange an authorization code for tokens.
     *
     * Validates the nonce against the id_token if provided. (AR #15)
     * State validation is skipped here — the controller validates state before
     * calling this method.
     *
     * @param params - Exchange parameters (code verifier, nonce, callback URL)
     * @param config - Optional config override (for multi-tenant BFF scenarios)
     * @returns Clean OidcTokens with access_token, refresh_token, id_token, etc.
     * @throws Error if issuerUrl/clientId is missing or openid-client reports an error
     */
    async exchangeCode(
        params: ExchangeCodeParams,
        config?: OidcAuthConfig
    ): Promise<OidcTokens> {
        const effectiveConfig = this.resolveConfig(config);

        if (!effectiveConfig.issuerUrl || !effectiveConfig.clientId) {
            throw new Error(
                "issuerUrl and clientId are required for exchangeCode"
            );
        }

        const cached = await this.getDiscoveryConfig(
            effectiveConfig.issuerUrl,
            effectiveConfig.clientId,
            effectiveConfig.clientSecret
        );

        const callbackUrl = new URL(params.callbackUrl);
        const response = await client.authorizationCodeGrant(
            cached.configuration,
            callbackUrl,
            {
                pkceCodeVerifier: params.codeVerifier,
                expectedNonce: params.nonce,
                // State is validated by the controller before calling exchangeCode
                expectedState: client.skipStateCheck,
            }
        );

        return this.mapTokenResponse(response);
    }

    /**
     * Refresh an access token using a refresh_token grant.
     *
     * @param refreshToken - The refresh token from a previous token response
     * @param config - Optional config override (for multi-tenant BFF scenarios)
     * @returns New OidcTokens with refreshed access_token (and possibly new refresh_token)
     * @throws Error if issuerUrl/clientId is missing or the refresh fails
     */
    async refreshToken(
        refreshToken: string,
        config?: OidcAuthConfig
    ): Promise<OidcTokens> {
        const effectiveConfig = this.resolveConfig(config);

        if (!effectiveConfig.issuerUrl || !effectiveConfig.clientId) {
            throw new Error(
                "issuerUrl and clientId are required for refreshToken"
            );
        }

        const cached = await this.getDiscoveryConfig(
            effectiveConfig.issuerUrl,
            effectiveConfig.clientId,
            effectiveConfig.clientSecret
        );

        const response = await client.refreshTokenGrant(
            cached.configuration,
            refreshToken
        );
        return this.mapTokenResponse(response);
    }

    /**
     * Revoke an access or refresh token.
     *
     * @param token - The token to revoke
     * @param tokenTypeHint - Optional hint: "access_token" or "refresh_token"
     * @param config - Optional config override (for multi-tenant BFF scenarios)
     * @throws Error if issuerUrl/clientId is missing or revocation fails
     */
    async revokeToken(
        token: string,
        tokenTypeHint?: "access_token" | "refresh_token",
        config?: OidcAuthConfig
    ): Promise<void> {
        const effectiveConfig = this.resolveConfig(config);

        if (!effectiveConfig.issuerUrl || !effectiveConfig.clientId) {
            throw new Error(
                "issuerUrl and clientId are required for revokeToken"
            );
        }

        const cached = await this.getDiscoveryConfig(
            effectiveConfig.issuerUrl,
            effectiveConfig.clientId,
            effectiveConfig.clientSecret
        );

        // Only pass token_type_hint when explicitly provided
        const params = tokenTypeHint
            ? { token_type_hint: tokenTypeHint }
            : undefined;

        await client.tokenRevocation(cached.configuration, token, params);
    }

    /**
     * Fetch user information from the OIDC provider's userinfo endpoint.
     *
     * @param accessToken - A valid access token with userinfo scope
     * @param expectedSubject - Optional expected `sub` claim for validation
     * @param config - Optional config override (for multi-tenant BFF scenarios)
     * @returns User claims as a plain object
     * @throws Error if issuerUrl/clientId is missing or the fetch fails
     */
    async fetchUserInfo(
        accessToken: string,
        expectedSubject?: string,
        config?: OidcAuthConfig
    ): Promise<Record<string, unknown>> {
        const effectiveConfig = this.resolveConfig(config);

        if (!effectiveConfig.issuerUrl || !effectiveConfig.clientId) {
            throw new Error(
                "issuerUrl and clientId are required for fetchUserInfo"
            );
        }

        const cached = await this.getDiscoveryConfig(
            effectiveConfig.issuerUrl,
            effectiveConfig.clientId,
            effectiveConfig.clientSecret
        );

        // openid-client requires expectedSubject — use skipSubjectCheck when not provided
        const userInfo = await client.fetchUserInfo(
            cached.configuration,
            accessToken,
            expectedSubject ?? client.skipSubjectCheck
        );

        return userInfo as Record<string, unknown>;
    }

    // -----------------------------------------------------------------------
    // Cookie Name Resolution
    // -----------------------------------------------------------------------

    /**
     * Resolves the session cookie name for a request.
     * Uses resolveSessionCookieName from config, or default '__oidc_session'.
     *
     * @param req - Express request object
     * @returns Session cookie name
     */
    getSessionCookieName(req: Request): string {
        return (
            this.oidcConfig.resolveSessionCookieName?.(req) ??
            DEFAULT_SESSION_COOKIE
        );
    }

    /**
     * Resolves the state cookie name for a request.
     * Uses resolveStateCookieName from config, or default '__oidc_state'.
     *
     * @param req - Express request object
     * @returns State cookie name
     */
    getStateCookieName(req: Request): string {
        return (
            this.oidcConfig.resolveStateCookieName?.(req) ??
            DEFAULT_STATE_COOKIE
        );
    }

    /**
     * Returns the configured redirect URI for OIDC callbacks.
     * Used by OidcAuthController to build the callback URL for code exchange
     * after getConfig() was removed from the controller.
     *
     * @returns The redirect URI, or undefined if not configured
     */
    getRedirectUri(): string | undefined {
        return this.oidcConfig.redirectUri;
    }

    // -----------------------------------------------------------------------
    // Session CRUD
    // -----------------------------------------------------------------------

    /**
     * Stores a user session in CacheProvider with UUID key.
     *
     * @param sessionId - UUID key for the session
     * @param session - Session data (user claims, tokens, metadata)
     */
    async storeSession(sessionId: string, session: OidcSession): Promise<void> {
        const store = this.getSessionStore();
        const ttl = this.oidcConfig.sessionTtl ?? DEFAULT_SESSION_TTL;
        await store.set(`${SESSION_KEY_PREFIX}${sessionId}`, session, ttl);
    }

    /**
     * Retrieves a user session from CacheProvider via UUID key.
     *
     * @param sessionId - UUID key for the session
     * @returns Session data or undefined if not found/expired
     */
    async getSession(sessionId: string): Promise<OidcSession | undefined> {
        const store = this.getSessionStore();
        return store.get<OidcSession>(`${SESSION_KEY_PREFIX}${sessionId}`);
    }

    /**
     * Clears a user session from CacheProvider.
     *
     * @param sessionId - UUID key for the session
     */
    async clearSession(sessionId: string): Promise<void> {
        const store = this.getSessionStore();
        await store.delete(`${SESSION_KEY_PREFIX}${sessionId}`);
    }

    // -----------------------------------------------------------------------
    // State CRUD (PKCE transient state)
    // -----------------------------------------------------------------------

    /**
     * Stores PKCE transient state in CacheProvider with short TTL.
     *
     * @param stateId - UUID key for the state
     * @param state - PKCE state data (codeVerifier, nonce, returnTo)
     */
    async storeState(
        stateId: string,
        state: import("./oidc-types.js").OidcSessionState
    ): Promise<void> {
        const store = this.getSessionStore();
        const ttl = this.oidcConfig.stateTtl ?? DEFAULT_STATE_TTL;
        await store.set(`${STATE_KEY_PREFIX}${stateId}`, state, ttl);
    }

    /**
     * Retrieves PKCE transient state from CacheProvider.
     *
     * @param stateId - UUID key for the state
     * @returns State data or undefined if not found/expired
     */
    async getState(
        stateId: string
    ): Promise<import("./oidc-types.js").OidcSessionState | undefined> {
        const store = this.getSessionStore();
        return store.get<import("./oidc-types.js").OidcSessionState>(
            `${STATE_KEY_PREFIX}${stateId}`
        );
    }

    /**
     * Clears PKCE transient state from CacheProvider.
     *
     * @param stateId - UUID key for the state
     */
    async clearState(stateId: string): Promise<void> {
        const store = this.getSessionStore();
        await store.delete(`${STATE_KEY_PREFIX}${stateId}`);
    }

    // -----------------------------------------------------------------------
    // Internal Helpers
    // -----------------------------------------------------------------------

    /**
     * Returns the CacheProvider from config. Throws if not configured.
     * @internal
     */
    private getSessionStore() {
        const store = this.oidcConfig.sessionStore;
        if (!store) {
            throw new Error(
                "OidcAuthProvider: sessionStore is required for BFF session operations"
            );
        }
        return store;
    }

    /**
     * Get or refresh the cached OIDC discovery configuration for an issuer.
     *
     * Performs OIDC discovery via openid-client on first call or when the
     * cache TTL has expired. Caches both the openid-client Configuration
     * (for BFF methods) and a jose JWKS key resolver (for JWT validation). (AR #10)
     *
     * @param issuerUrl - OIDC issuer URL for discovery
     * @param clientId - OAuth2 client ID
     * @param clientSecret - Optional client secret for confidential clients
     * @returns Cached discovery configuration with JWKS resolver
     * @throws Error if discovery fails or metadata lacks jwks_uri
     */
    protected async getDiscoveryConfig(
        issuerUrl: string,
        clientId: string,
        clientSecret?: string
    ): Promise<CachedConfig> {
        const cacheKey = issuerUrl;
        const cached = this.discoveryCache.get(cacheKey);

        // Return cached config if still valid
        if (cached && !this.isExpired(cached)) {
            return cached;
        }

        // Perform OIDC discovery via openid-client
        const configuration = await client.discovery(
            new URL(issuerUrl),
            clientId,
            clientSecret
        );

        // Extract server metadata to get jwks_uri and issuer
        const metadata = configuration.serverMetadata();
        const jwksUri = metadata.jwks_uri;
        if (!jwksUri) {
            throw new Error(
                `OIDC discovery for ${issuerUrl} did not return a jwks_uri`
            );
        }

        // Build jose JWKS key set resolver for JWT validation.
        // createRemoteJWKSet handles key fetching and caching internally.
        const jwks = createRemoteJWKSet(new URL(jwksUri));

        const ttl = this.oidcConfig.discoveryTtl ?? 3600;
        const entry: CachedConfig = {
            configuration,
            jwks,
            issuer: metadata.issuer,
            expiresAt: Date.now() + ttl * 1000,
        };

        this.discoveryCache.set(cacheKey, entry);
        return entry;
    }

    /**
     * Check if a cached discovery configuration has expired.
     *
     * @param cached - The cached configuration to check
     * @returns true if the cache entry has expired and should be refreshed
     */
    protected isExpired(cached: CachedConfig): boolean {
        return Date.now() >= cached.expiresAt;
    }

    /**
     * Merge an optional config override with the provider's base config.
     *
     * Used by BFF methods to support multi-tenant scenarios where the
     * controller passes a resolved per-tenant config.
     *
     * @param config - Optional config override
     * @returns The effective config (override merged with base, or just base)
     */
    protected resolveConfig(config?: OidcAuthConfig): OidcAuthConfig {
        if (!config) return this.oidcConfig;
        return { ...this.oidcConfig, ...config };
    }

    /**
     * Parse a specific cookie value from the raw Cookie header.
     *
     * Parses the Cookie header manually to avoid dependency on cookie-parser
     * middleware. This is needed because the session cookie fallback must work
     * even when cookie-parser is not configured.
     *
     * Handles URL-encoded cookie values via decodeURIComponent.
     *
     * @param req - Express request object
     * @param name - Cookie name to look for
     * @returns The decoded cookie value, or undefined if not found
     */
    private parseCookieByName(req: Request, name: string): string | undefined {
        const cookieHeader = req.headers?.cookie;
        if (!cookieHeader) return undefined;

        // Split on "; " (standard cookie separator) and find matching name
        const prefix = `${name}=`;
        const cookies = cookieHeader.split("; ");
        for (const cookie of cookies) {
            if (cookie.startsWith(prefix)) {
                const raw = cookie.slice(prefix.length);
                try {
                    return decodeURIComponent(raw);
                } catch {
                    return raw;
                }
            }
        }

        return undefined;
    }

    /**
     * Map an openid-client token endpoint response to our clean OidcTokens type.
     *
     * Extracts standard OAuth2/OIDC fields into a typed interface so that
     * no openid-client types leak through the public API boundary. (AR #17)
     *
     * @param response - Raw token endpoint response from openid-client
     * @returns Clean OidcTokens with standardized field names
     */
    protected mapTokenResponse(
        response: client.TokenEndpointResponse & {
            token_type?: string;
            expires_in?: number;
            refresh_token?: string;
            id_token?: string;
            scope?: string;
        }
    ): OidcTokens {
        return {
            accessToken: response.access_token,
            tokenType: response.token_type ?? "Bearer",
            expiresIn: response.expires_in,
            refreshToken: response.refresh_token,
            idToken: response.id_token,
            scope: response.scope,
        };
    }
}
