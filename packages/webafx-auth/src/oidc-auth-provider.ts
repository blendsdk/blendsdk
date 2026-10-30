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
import { jwtVerify, createRemoteJWKSet, customFetch as joseCustomFetch } from "jose";
import type { JWTVerifyGetKey } from "jose";
import type { Request } from "express";

import { createTlsFetch } from "./tls-fetch.js";
import { parseCookie } from "./oidc-helpers.js";
import {
    OidcCodeExchangeError,
    OidcUserInfoForbiddenError,
    OidcUserInfoSubjectMismatchError,
} from "./oidc-errors.js";
import { AuthProvider } from "./abstract-auth-provider.js";
import type { AuthResult } from "./types.js";
import type {
    OidcAuthConfig,
    OidcCsrfConfig,
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

/**
 * openid-client error code for a response whose HTTP status is not conform.
 *
 * The library does not re-export its operation codes, so the documented string
 * is used; it is produced by `oauth4webapi` and wrapped by openid-client's
 * error handler.
 */
const OAUTH_RESPONSE_IS_NOT_CONFORM = "OAUTH_RESPONSE_IS_NOT_CONFORM";

/**
 * openid-client `ClientError` codes that identify an ID-token verification
 * failure. Every other code — including the timeout, abort, and unsupported
 * operation codes and the wrapper without a code — is an infrastructure
 * failure and must not be mapped to a client error.
 *
 * Key selection is included on purpose: when the ID token's `kid` is absent
 * from the issuer's JWKS (a rotated key the cache has not seen, or a forged
 * token) the non-repudiation check fails while selecting a verification key,
 * which is a failed sign-in, not a server fault. Parse errors are included for
 * the same reason: an unparseable ID token cannot be trusted.
 */
const AUTHORIZATION_FLOW_CODES: ReadonlySet<string> = new Set([
    "OAUTH_INVALID_RESPONSE",
    "OAUTH_JWT_CLAIM_COMPARISON_FAILED",
    "OAUTH_JWT_TIMESTAMP_CHECK_FAILED",
    "OAUTH_KEY_SELECTION_FAILED",
    "OAUTH_PARSE_ERROR",
]);

/**
 * Structural check for a value carrying a numeric HTTP `status`.
 *
 * Used to read the response status from a wrapped library error without
 * importing DOM types or casting through `any`.
 *
 * @param value - Candidate value, typically an error's `cause`
 * @returns True when the value exposes a numeric `status`
 */
function hasStatus(value: unknown): value is { status: number } {
    return (
        typeof value === "object" &&
        value !== null &&
        "status" in value &&
        typeof (value as Record<string, unknown>).status === "number"
    );
}

/**
 * Whether a library error represents a flow-level failure that a browser user
 * can act on by restarting sign-in, as opposed to an infrastructure failure.
 *
 * - `ResponseBodyError`: the token endpoint answered with an OAuth error body
 *   (`invalid_grant`, ...); the library builds it only for a 4xx status.
 * - `WWWAuthenticateChallengeError`: the endpoint issued a challenge; a 5xx
 *   challenge stays an infrastructure failure.
 * - `ClientError`: only the allowlisted ID-token verification codes count; a
 *   non-conform response counts only for a 4xx status. Timeouts, aborts,
 *   unsupported operations, and unknown codes stay infrastructure failures.
 *
 * @param error - Error thrown by `openid-client`
 * @returns True when the error should become an {@link OidcCodeExchangeError}
 */
function isAuthorizationFlowError(error: unknown): boolean {
    if (error instanceof client.ResponseBodyError) {
        return error.status < 500;
    }
    if (error instanceof client.WWWAuthenticateChallengeError) {
        return error.status < 500;
    }
    if (error instanceof client.ClientError) {
        if (error.code === OAUTH_RESPONSE_IS_NOT_CONFORM) {
            return hasStatus(error.cause) && error.cause.status < 500;
        }
        return error.code !== undefined && AUTHORIZATION_FLOW_CODES.has(error.code);
    }
    return false;
}

/**
 * Whether a library error represents an HTTP 403 from the UserInfo endpoint.
 *
 * - `WWWAuthenticateChallengeError`: the endpoint issued a bearer challenge,
 *   and the status is available directly.
 * - `ClientError` with the non-conform code: the HTTP status lives on the
 *   wrapped `Response` in `cause`.
 *
 * Other statuses (`401`, 5xx) and other errors keep propagating.
 *
 * @param error - Error thrown by `openid-client`'s `fetchUserInfo`
 * @returns True when the error should become an {@link OidcUserInfoForbiddenError}
 */
function isUserInfoForbidden(error: unknown): boolean {
    if (error instanceof client.WWWAuthenticateChallengeError) {
        return error.status === 403;
    }
    return (
        error instanceof client.ClientError &&
        error.code === OAUTH_RESPONSE_IS_NOT_CONFORM &&
        hasStatus(error.cause) &&
        error.cause.status === 403
    );
}

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
     * In-flight refresh grants, keyed by issuer, client, and refresh token.
     *
     * Concurrent direct callers of {@link refreshToken} that present the same
     * tenant and token share a single grant, so a rotating IdP never sees the
     * same refresh token twice. Entries are removed when the grant settles,
     * whether it resolves or rejects.
     *
     * The map is process-local. Multiple application instances need an external
     * lock; this provider can only coalesce calls that reach one instance.
     */
    private readonly inFlightRefreshes = new Map<string, Promise<OidcTokens>>();

    /**
     * Whether the insecure-transport warning has already been emitted.
     *
     * The warning must appear once per provider, not once per discovery, so a
     * long-lived provider that re-discovers does not spam the log.
     */
    private insecureWarningLogged = false;

    /**
     * Whether the "UserInfo subject check skipped" warning has been emitted.
     *
     * Like the insecure-transport warning, this is reported once per provider
     * so every sign-in on a misconfigured provider does not repeat it.
     */
    private subjectCheckWarningLogged = false;

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
            // Fail closed when an audience is required but not configured, so a
            // token meant for another API cannot be accepted unchecked.
            if (this.oidcConfig.requireAudience && !this.oidcConfig.audience) {
                return undefined;
            }

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
            return this.withPrincipalType(this.claimsMapper(token, claims));
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
            // The async resolveUser is deferred outside the catch so a rejected
            // resolver propagates as an infrastructure error. Synchronous claim
            // mapping stays inside the catch, so a mapper throw is treated as a
            // failed authentication — matching JwtAuthProvider.
            let resolveUser: OidcAuthConfig["resolveUser"];
            let resolveClaims: Record<string, unknown> | undefined;

            try {
                // Determine config: configFactory (per-request) or static
                // Inside try/catch so configFactory errors return undefined (silent)
                const effectiveConfig = this.oidcConfig.configFactory
                    ? await this.oidcConfig.configFactory(req)
                    : this.oidcConfig;

                if (!effectiveConfig.issuerUrl || !effectiveConfig.clientId) {
                    return undefined;
                }

                const clockTolerance =
                    effectiveConfig.clockTolerance ??
                    this.oidcConfig.clockTolerance ??
                    30;
                const audience =
                    effectiveConfig.audience ?? this.oidcConfig.audience;
                const requireAudience =
                    effectiveConfig.requireAudience ??
                    this.oidcConfig.requireAudience;

                // Fail closed before discovery when an audience is required but
                // absent, so a token from another API is not accepted unchecked.
                if (requireAudience && !audience) {
                    return undefined;
                }

                const cached = await this.getDiscoveryConfig(
                    effectiveConfig.issuerUrl,
                    effectiveConfig.clientId,
                    effectiveConfig.clientSecret
                );

                // Validate JWT using jose with JWKS from discovery
                const { payload } = await jwtVerify(token, cached.jwks, {
                    issuer: cached.issuer,
                    clockTolerance,
                    ...(audience ? { audience } : {}),
                });

                const claims = payload as Record<string, unknown>;
                resolveUser =
                    effectiveConfig.resolveUser ?? this.oidcConfig.resolveUser;

                // resolveUser takes priority over mapClaims (AR #8).
                if (resolveUser) {
                    // Defer to outside the catch so a rejection propagates.
                    resolveClaims = claims;
                } else {
                    const mapClaims =
                        effectiveConfig.mapClaims ?? this.oidcConfig.mapClaims;
                    const mapped = mapClaims
                        ? mapClaims(token, claims)
                        : this.claimsMapper(token, claims);
                    return this.withPrincipalType(mapped);
                }
            } catch {
                // Silent failure — configFactory errors, discovery errors, JWT errors,
                // or a synchronous claims-mapper error
                return undefined;
            }

            // Reached only when an async resolveUser was selected: its rejection
            // is an infrastructure failure and propagates to the caller. The
            // result is stamped with the configured principal type.
            if (resolveUser && resolveClaims) {
                return this.withPrincipalType(await resolveUser(req, resolveClaims));
            }
            return undefined;
        }

        // --- Path 2: Session cookie fallback (AR #2, #8) ---
        const { sessionStore } = this.oidcConfig;
        if (!sessionStore) return undefined;

        // Resolve cookie name: org-scoped or default
        const cookieName = this.getSessionCookieName(req);

        const sessionId = parseCookie(req, cookieName);
        if (!sessionId) return undefined;

        // Look up session in CacheProvider — errors propagate as 500 (AR #13)
        const session = await sessionStore.get<OidcSession>(
            `${SESSION_KEY_PREFIX}${sessionId}`
        );
        if (!session) return undefined;

        // The absolute deadline is independent of the idle check below: a
        // continuously refreshed session still ends here. Delete on rejection
        // so the expired entry cannot be revived.
        if (this.isPastAbsoluteDeadline(session)) {
            await sessionStore.delete(`${SESSION_KEY_PREFIX}${sessionId}`);
            return undefined;
        }

        // A session past its token expiry must stop authenticating, even if the
        // CacheProvider TTL has not elapsed. clockTolerance allows for clock
        // skew, matching JWT validation. A session without expiresAt is bounded
        // by the CacheProvider TTL.
        const skew = this.oidcConfig.clockTolerance ?? 30;
        if (
            session.expiresAt !== undefined &&
            session.expiresAt <= Math.floor(Date.now() / 1000) - skew
        ) {
            return undefined;
        }

        // Build AuthResult from session data. A session cookie is always an
        // interactive user session, so the type is forced to 'user'. A denied
        // session authenticates so `/me` can present it, but carries
        // authorized: false for guards that need to deny by policy.
        return {
            sub: (session.user.sub as string) ?? "unknown",
            claims: session.user,
            token: session.accessToken,
            exp: session.expiresAt,
            principalType: "user",
            authorized: session.authorized !== false,
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
     *   `subject` is set when a verified ID token was returned; it is absent on
     *   the OAuth2 path (no nonce) when the provider returns no ID token.
     * @throws OidcCodeExchangeError when the flow fails: an invalid or expired
     *   code, a token-endpoint OAuth error or client challenge, a failed
     *   ID-token verification, or a verified ID token without a usable subject
     * @throws Error for infrastructure failures: missing configuration,
     *   discovery, network, timeout, 5xx responses, and structurally invalid
     *   responses (for example an unknown signing key)
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

        // Only the grant is classified here: discovery and configuration
        // failures happen before this point and keep propagating as
        // infrastructure errors.
        let response: client.TokenEndpointResponse &
            client.TokenEndpointResponseHelpers;
        try {
            response = await client.authorizationCodeGrant(
                cached.configuration,
                callbackUrl,
                {
                    pkceCodeVerifier: params.codeVerifier,
                    expectedNonce: params.nonce,
                    // State is validated by the controller before calling exchangeCode
                    expectedState: client.skipStateCheck,
                }
            );
        } catch (error) {
            if (isAuthorizationFlowError(error)) {
                throw new OidcCodeExchangeError(error);
            }
            throw error;
        }

        const tokens = this.mapTokenResponse(response);

        // The ID-token signature check is enabled from the static config when
        // the discovery entry is built (see getDiscoveryConfig), so the same
        // static source decides whether the subject is trustworthy here. A
        // per-request config override cannot change the cached configuration
        // shared by every tenant, so it is ignored for this decision.
        const signatureVerified =
            this.oidcConfig.verifyIdTokenSignature !== false;
        const verifiedClaims = signatureVerified ? response.claims() : undefined;
        const subject = verifiedClaims?.sub;

        if (typeof subject === "string") {
            // The verified claims accompany the subject so the controller can
            // build an identity for an unauthorized session without ever
            // reading unverified data. Absence of the field always means "no
            // trusted identity".
            return { ...tokens, subject, idTokenClaims: verifiedClaims };
        }

        // Fail closed when the subject check is requested and a verified ID
        // token was returned without a usable string subject: silently leaving
        // `subject` unset would disable the UserInfo check. The library
        // requires the claim to be present, not to be a string. A malformed
        // provider response is a failed sign-in, so it uses the typed flow
        // error.
        if (
            signatureVerified &&
            this.oidcConfig.verifyUserInfoSubject !== false &&
            typeof response.id_token === "string"
        ) {
            throw new OidcCodeExchangeError(
                new Error(
                    'OidcAuthProvider: the ID token is missing a string "sub" claim'
                )
            );
        }

        // Warn only when an ID token exists but was not verified: with no ID
        // token there is no subject to compare and no downgrade to report.
        if (
            !signatureVerified &&
            this.oidcConfig.verifyUserInfoSubject !== false &&
            typeof response.id_token === "string" &&
            !this.subjectCheckWarningLogged
        ) {
            this.subjectCheckWarningLogged = true;
            console.warn(
                "OidcAuthProvider: verifyIdTokenSignature is disabled, so " +
                    "UserInfo subject verification is skipped. Enable ID-token " +
                    "signature verification to enforce the OpenID Connect " +
                    "subject check."
            );
        }

        return tokens;
    }

    /**
     * Refresh an access token using a refresh_token grant.
     *
     * Concurrent calls for the same tenant and refresh token are coalesced:
     * they share one token-endpoint grant and receive the same result, so a
     * rotating IdP consumes the refresh token exactly once. A rejected grant
     * rejects every joined caller and the in-flight entry is removed, so a
     * later refresh can run.
     *
     * The coalescing map is process-local; a deployment with several
     * application instances needs an external lock.
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

        // Key by tenant as well as token: identical calls coalesce, while two
        // tenants served by one provider instance never share a grant. The
        // tuple encoding keeps the key unambiguous.
        const key = JSON.stringify([
            effectiveConfig.issuerUrl,
            effectiveConfig.clientId,
            refreshToken,
        ]);

        const existing = this.inFlightRefreshes.get(key);
        if (existing) {
            return existing;
        }

        // Start the grant and register it before awaiting, so a caller in the
        // same tick joins instead of starting a second grant. The guard above
        // proved issuerUrl and clientId are present; the spread spells that out
        // for the helper's narrowed parameter type.
        const pending = this.performRefreshGrant(refreshToken, {
            ...effectiveConfig,
            issuerUrl: effectiveConfig.issuerUrl,
            clientId: effectiveConfig.clientId,
        });
        this.inFlightRefreshes.set(key, pending);
        try {
            return await pending;
        } finally {
            // Remove unconditionally: a rejection must not wedge the token.
            this.inFlightRefreshes.delete(key);
        }
    }

    /**
     * Perform one refresh_token grant for an already-resolved configuration.
     *
     * Extracted from {@link refreshToken} so the single-flight wrapper can be
     * tested and reasoned about independently of the idempotency decision.
     *
     * @param refreshToken - The refresh token to present
     * @param effectiveConfig - Resolved configuration with issuerUrl and clientId
     * @returns The mapped token response
     * @throws Error when discovery or the grant fails
     * @internal
     */
    private async performRefreshGrant(
        refreshToken: string,
        effectiveConfig: OidcAuthConfig & { issuerUrl: string; clientId: string }
    ): Promise<OidcTokens> {
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
     * When `expectedSubject` is supplied, the response subject must match it
     * exactly (OpenID Connect Core 1.0 §5.3.2). The comparison happens here,
     * after the library has validated the response shape, so the provider can
     * raise a typed error instead of depending on an internal library error
     * code. A mismatch means the response must not be used.
     *
     * @param accessToken - A valid access token with userinfo scope
     * @param expectedSubject - Optional expected `sub` claim; typically
     *   `OidcTokens.subject` from the verified ID token
     * @param config - Optional config override (for multi-tenant BFF scenarios)
     * @returns User claims as a plain object
     * @throws OidcUserInfoSubjectMismatchError when the response subject differs
     *   from `expectedSubject`
     * @throws OidcUserInfoForbiddenError when the endpoint refuses the request
     *   with HTTP 403
     * @throws Error for infrastructure failures: missing configuration,
     *   discovery, network, or other HTTP statuses
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

        // The equality check below owns the subject comparison. Passing
        // skipSubjectCheck keeps the check at this boundary, where the typed
        // error is raised, while the library still validates the response
        // shape and asserts that `sub` is a string.
        let userInfo: client.UserInfoResponse;
        try {
            userInfo = await client.fetchUserInfo(
                cached.configuration,
                accessToken,
                client.skipSubjectCheck
            );
        } catch (error) {
            if (isUserInfoForbidden(error)) {
                throw new OidcUserInfoForbiddenError(error);
            }
            throw error;
        }

        const claims = userInfo as Record<string, unknown>;
        if (
            expectedSubject !== undefined &&
            claims.sub !== expectedSubject
        ) {
            throw new OidcUserInfoSubjectMismatchError();
        }

        return claims;
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

    /**
     * Returns the session cookie lifetime in seconds.
     *
     * Resolution order: `sessionCookieTtl`, then `sessionTtl`, then 3600.
     * OidcAuthController uses this for the cookie set at login and for the
     * cookie re-issued on refresh, so the browser cookie and the server-side
     * session slide together by default. Setting `sessionCookieTtl` lets an
     * application give the cookie a different window than the session store.
     *
     * The value is read from the static configuration only; a per-request
     * `configFactory` does not change it. A returned value of 0 or less yields
     * a non-persistent cookie, so configure a positive value in production.
     *
     * @returns Cookie lifetime in seconds; never undefined.
     */
    getSessionCookieTtl(): number {
        return (
            this.oidcConfig.sessionCookieTtl ??
            this.oidcConfig.sessionTtl ??
            DEFAULT_SESSION_TTL
        );
    }

    /**
     * Resolve the per-request OIDC configuration from the configured
     * `configFactory`.
     *
     * Returns undefined when no factory is configured, so callers fall back to
     * the provider's static configuration. Errors thrown by the factory
     * propagate to the caller as infrastructure failures.
     *
     * @param req - Express request used to resolve the tenant/issuer
     * @returns The resolved configuration, or undefined when there is no factory
     */
    async resolveRequestConfig(
        req: Request
    ): Promise<OidcAuthConfig | undefined> {
        return this.oidcConfig.configFactory
            ? this.oidcConfig.configFactory(req)
            : undefined;
    }

    /**
     * Returns the controller CSRF configuration, or undefined when unset.
     *
     * The controller needs this narrow accessor because `oidcConfig` is
     * protected; exposing the whole configuration would also expose the client
     * secret. A `csrf` block with `enabled` not true leaves enforcement off.
     *
     * @returns The CSRF configuration, or undefined when none is configured
     */
    getCsrfConfig(): OidcCsrfConfig | undefined {
        return this.oidcConfig.csrf;
    }

    /**
     * Whether the OIDC BFF flow should rotate the session id on refresh.
     *
     * When true, OidcAuthController moves a successfully refreshed session to a
     * new opaque id and re-issues the cookie, so an id captured before the
     * refresh stops resolving. Default: false.
     *
     * The value is read from the static configuration only; a per-request
     * `configFactory` does not change it. See
     * {@link OidcAuthConfig.rotateSessionIdOnRefresh} for the concurrency and
     * lost-response caveats.
     *
     * @returns True when session-id rotation is enabled
     */
    shouldRotateSessionIdOnRefresh(): boolean {
        return this.oidcConfig.rotateSessionIdOnRefresh ?? false;
    }

    /**
     * Whether the controller should verify the UserInfo subject against the
     * verified ID-token subject.
     *
     * Defaults to true; only an explicit `verifyUserInfoSubject: false` turns
     * the check off. The value is read from the static configuration only; a
     * per-request `configFactory` cannot change it, matching
     * `rotateSessionIdOnRefresh` and `verifyIdTokenSignature`.
     *
     * @returns True when the controller should pass the expected subject
     */
    shouldVerifyUserInfoSubject(): boolean {
        return this.oidcConfig.verifyUserInfoSubject !== false;
    }

    /**
     * How the callback treats a UserInfo endpoint denial (HTTP 403).
     *
     * `'error'` (the default) makes the callback return a fixed `403` with no
     * session. `'unauthorized-session'` makes it store a session marked
     * `authorized: false` whose identity comes from the verified ID token.
     *
     * This is static configuration: a per-request `configFactory` cannot vary
     * it, matching `verifyUserInfoSubject` and `rotateSessionIdOnRefresh`.
     *
     * @returns The configured denial policy; never undefined
     */
    getUserInfoDeniedMode(): "error" | "unauthorized-session" {
        return this.oidcConfig.userInfoDenied === "unauthorized-session"
            ? "unauthorized-session"
            : "error";
    }

    /**
     * Browser redirect target after an unauthorized session is created.
     *
     * Defaults to `/`. Static configuration: a per-request `configFactory`
     * cannot vary it.
     *
     * @returns The configured path; never undefined
     */
    getNotAuthorizedPath(): string {
        return this.oidcConfig.notAuthorizedPath ?? "/";
    }

    // -----------------------------------------------------------------------
    // Session CRUD
    // -----------------------------------------------------------------------

    /**
     * Stores a user session in CacheProvider with UUID key.
     *
     * When `sessionAbsoluteTtl` is configured, this stamps `createdAt` on the
     * first store and preserves any existing value, so the absolute deadline
     * cannot be extended. With no absolute lifetime configured the session is
     * stored exactly as supplied.
     *
     * @param sessionId - UUID key for the session
     * @param session - Session data (user claims, tokens, metadata)
     */
    async storeSession(sessionId: string, session: OidcSession): Promise<void> {
        const store = this.getSessionStore();
        const ttl = this.oidcConfig.sessionTtl ?? DEFAULT_SESSION_TTL;
        // When an absolute lifetime is configured, stamp the creation time on
        // first store and preserve it on every later store, so refresh and
        // rotation cannot extend the deadline; a legacy session without
        // createdAt gets a fresh window. When no absolute lifetime is set the
        // stored session is left exactly as it was before this feature existed.
        const toStore: OidcSession =
            this.oidcConfig.sessionAbsoluteTtl !== undefined &&
            session.createdAt === undefined
                ? { ...session, createdAt: Math.floor(Date.now() / 1000) }
                : session;
        await store.set(`${SESSION_KEY_PREFIX}${sessionId}`, toStore, ttl);
    }

    /**
     * Retrieves a user session from CacheProvider via UUID key.
     *
     * @param sessionId - UUID key for the session
     * @returns Session data or undefined if not found/expired
     */
    async getSession(sessionId: string): Promise<OidcSession | undefined> {
        const store = this.getSessionStore();
        const session = await store.get<OidcSession>(
            `${SESSION_KEY_PREFIX}${sessionId}`
        );
        if (session && this.isPastAbsoluteDeadline(session)) {
            // The absolute deadline is final: drop the entry so no later read
            // can revive it, then report the session as absent.
            await store.delete(`${SESSION_KEY_PREFIX}${sessionId}`);
            return undefined;
        }
        return session;
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
     * Whether a session has passed its absolute deadline, when one is set.
     *
     * Both the stored creation time and "now" come from the server clock, so
     * this comparison needs no clock-skew tolerance. A session without a
     * creation time (written before an absolute TTL was configured) is not
     * expired by this check.
     *
     * @param session - The stored session to test
     * @returns True when the session is at or past `createdAt + sessionAbsoluteTtl`
     * @internal
     */
    private isPastAbsoluteDeadline(session: OidcSession): boolean {
        const ttl = this.oidcConfig.sessionAbsoluteTtl;
        if (ttl === undefined || session.createdAt === undefined) {
            return false;
        }
        return Math.floor(Date.now() / 1000) >= session.createdAt + ttl;
    }

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

        // Build the transport shim once per discovery. When no relaxation is
        // requested it is undefined, so the default fetch path is untouched.
        const transport = this.oidcConfig.transport;
        const tlsFetch = createTlsFetch(transport);

        if (transport?.allowInsecureRequests && !this.insecureWarningLogged) {
            this.insecureWarningLogged = true;
            console.warn(
                "OidcAuthProvider: allowInsecureRequests is enabled. TLS " +
                    "certificate validation is disabled and non-HTTPS issuers " +
                    "are accepted. Do not use this in production."
            );
        }

        // `options` is the fifth parameter of discovery(); keeping it there
        // preserves clientSecret as client metadata in the third slot. The
        // allowInsecureRequests execute extension also relaxes the HTTPS-only
        // rule for the discovery call and every later request from this config.
        const discoveryOptions = tlsFetch
            ? {
                  [client.customFetch]: tlsFetch,
                  ...(transport?.allowInsecureRequests
                      ? { execute: [client.allowInsecureRequests] }
                      : {}),
              }
            : undefined;

        // Perform OIDC discovery via openid-client. The default call keeps its
        // original three-argument shape; the options bag is only passed when a
        // transport shim exists, so unconfigured providers are untouched.
        const configuration = discoveryOptions
            ? await client.discovery(
                  new URL(issuerUrl),
                  clientId,
                  clientSecret,
                  undefined,
                  discoveryOptions
              )
            : await client.discovery(new URL(issuerUrl), clientId, clientSecret);

        // Verify the code-exchange ID token signature by default. The check
        // reuses the configuration's transport, so it composes with a private
        // CA or an insecure issuer. Only an explicit false skips verification.
        if (this.oidcConfig.verifyIdTokenSignature !== false) {
            client.enableNonRepudiationChecks(configuration);
        }

        // Extract server metadata to get jwks_uri and issuer
        const metadata = configuration.serverMetadata();
        const jwksUri = metadata.jwks_uri;
        if (!jwksUri) {
            throw new Error(
                `OIDC discovery for ${issuerUrl} did not return a jwks_uri`
            );
        }

        // Build jose JWKS key set resolver for JWT validation. The shim keeps
        // access-token JWKS fetches on the same trust settings as discovery.
        // The no-transport call keeps its original single-argument shape.
        // createRemoteJWKSet handles key fetching and caching internally.
        const jwks = tlsFetch
            ? createRemoteJWKSet(new URL(jwksUri), { [joseCustomFetch]: tlsFetch })
            : createRemoteJWKSet(new URL(jwksUri));

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
