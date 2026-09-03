/**
 * OIDC-specific type definitions for OidcAuthProvider.
 *
 * Defines configuration interfaces for OIDC discovery-based authentication
 * and BFF (Backend-For-Frontend) operations. These types are separate from
 * the base types.ts to keep the type system manageable as providers grow.
 *
 * @packageDocumentation
 */

import type { Request } from "express";
import type { CacheProvider } from "@blendsdk/webafx-cache";
import type { AuthProviderConfig, AuthResult } from "./types.js";

// ---------------------------------------------------------------------------
// OIDC Provider Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for OidcAuthProvider.
 *
 * Extends the base AuthProviderConfig with OIDC-specific options for
 * discovery, JWT validation, and BFF flow parameters. Supports both
 * static single-tenant configuration and dynamic multi-tenant via configFactory.
 *
 * At least one of `issuerUrl` or `configFactory` must be provided.
 * When both are set, `issuerUrl` is used for `validate()` (no Request context)
 * and `configFactory` is used for per-request `authenticate()`.
 */
export interface OidcAuthConfig extends AuthProviderConfig {
    /** OIDC issuer URL. Optional if configFactory is provided. (AR #7) */
    issuerUrl?: string;

    /** OAuth2 client ID. Optional if configFactory is provided. */
    clientId?: string;

    /** Client secret (for confidential clients). */
    clientSecret?: string;

    /** Redirect URI for authorization code flow. */
    redirectUri?: string;

    /** Expected audience. Accepts single string or array. (AR #6) */
    audience?: string | string[];

    /** Clock tolerance in seconds for JWT validation. Default: 30. (AR #9) */
    clockTolerance?: number;

    /** OIDC scopes to request. Default: ['openid', 'profile', 'email'] */
    scopes?: string[];

    /** Discovery cache TTL in seconds. Default: 3600 (1 hour). (AR #10) */
    discoveryTtl?: number;

    /**
     * Async user resolver — takes precedence over mapClaims when set. (AR #8)
     * Receives the Request and raw claims, returns AuthResult.
     */
    resolveUser?: (
        req: Request,
        claims: Record<string, unknown>
    ) => Promise<AuthResult>;

    /**
     * Dynamic config factory for multi-tenant scenarios. (AR #7)
     * Called per-request to resolve tenant-specific OIDC configuration.
     * Must return at minimum: issuerUrl, clientId.
     */
    configFactory?: (req: Request) => Promise<OidcAuthConfig>;

    /**
     * CacheProvider for server-side session storage. Enables dual-mode authenticate.
     * When set, the provider checks session cookies as a fallback after Bearer tokens.
     * (AR #2, #8)
     */
    sessionStore?: CacheProvider;

    /**
     * Resolves the session cookie name per request.
     * For multi-tenant: returns org-scoped cookie name (e.g., `__oidc_session_acme`).
     * For single-tenant: returns static cookie name (`__oidc_session`).
     * Only used when sessionStore is configured. (AR #6)
     */
    resolveSessionCookieName?: (req: Request) => string;

    /**
     * Resolves the state cookie name per request.
     * For multi-tenant: returns org-scoped cookie name (e.g., `__oidc_state_acme`).
     * For single-tenant: returns static cookie name (`__oidc_state`).
     * Only used when sessionStore is configured.
     */
    resolveStateCookieName?: (req: Request) => string;

    /**
     * Session TTL in seconds for server-side session storage.
     * Determines how long user sessions are kept in the CacheProvider.
     * Default: 3600 (1 hour).
     */
    sessionTtl?: number;

    /**
     * State TTL in seconds for PKCE transient state storage.
     * Determines how long login flow state is kept between redirect and callback.
     * Default: 300 (5 minutes).
     */
    stateTtl?: number;
}

// ---------------------------------------------------------------------------
// Token Response
// ---------------------------------------------------------------------------

/**
 * Clean extraction of OIDC token response fields.
 *
 * Maps standard OAuth2/OIDC token endpoint response fields into a typed
 * interface. No openid-client types leak through this boundary. (AR #17)
 */
export interface OidcTokens {
    /** The access token */
    accessToken: string;
    /** Token type (usually "Bearer") */
    tokenType: string;
    /** Expiration time in seconds from issuance */
    expiresIn?: number;
    /** Refresh token (if granted) */
    refreshToken?: string;
    /** ID token JWT (if granted) */
    idToken?: string;
    /** Granted scopes (space-separated string) */
    scope?: string;
}

// ---------------------------------------------------------------------------
// BFF Method Parameters
// ---------------------------------------------------------------------------

/**
 * Result of buildAuthorizationUrl().
 *
 * Contains everything needed to redirect the user to the OIDC provider
 * and later validate the authorization callback. The codeVerifier, state,
 * and nonce must be stored server-side (e.g., in session) for callback validation.
 */
export interface AuthorizationUrlResult {
    /** Full authorization URL to redirect the user to */
    url: string;
    /** PKCE code verifier — must be stored and passed to exchangeCode() */
    codeVerifier: string;
    /** State parameter — must be stored and verified on callback */
    state: string;
    /** Nonce for id_token validation */
    nonce: string;
}

/**
 * Optional overrides for buildAuthorizationUrl().
 *
 * Config defaults are used when these are not provided. (AR #16)
 * Allows per-call customization without changing the provider config.
 */
export interface BuildAuthorizationUrlParams {
    /** Override config's clientId */
    clientId?: string;
    /** Override config's redirectUri */
    redirectUri?: string;
    /** Override config's scopes */
    scopes?: string[];
    /** Additional OIDC parameters (prompt, login_hint, acr_values, etc.) */
    extraParams?: Record<string, string>;
}

/**
 * Parameters for exchangeCode().
 *
 * Contains the full callback URL (which includes the authorization code
 * in its query params), PKCE verifier, and nonce for validation.
 */
export interface ExchangeCodeParams {
    /** The PKCE code verifier from buildAuthorizationUrl() */
    codeVerifier: string;
    /** The nonce to validate against the id_token (AR #15) */
    nonce?: string;
    /**
     * The full callback URL including query parameters (code, state, etc.).
     * openid-client extracts the authorization code from this URL automatically.
     * Example: "https://app.example.com/callback?code=abc123&state=xyz"
     */
    callbackUrl: string;
}

// ---------------------------------------------------------------------------
// Session Types (RD-03: OidcAuthController)
// ---------------------------------------------------------------------------

/**
 * Transient state stored between login redirect and callback.
 *
 * Created during the login handler and consumed during the callback handler.
 * Contains the PKCE code verifier, state parameter for CSRF validation,
 * nonce for id_token validation, and an optional return URL.
 *
 * Default storage: signed cookie (`__oidc_state`) with short TTL (~5 minutes).
 * Override `storeSessionState()` and `getSessionState()` hooks for custom storage.
 *
 * @remarks
 * Decision per P3: Cookie name defaults to `__oidc_state`.
 */
export interface OidcSessionState {
    /** PKCE code verifier — used in token exchange to prove authorization request origin */
    codeVerifier: string;

    /** State parameter — validated on callback to prevent CSRF attacks */
    state: string;

    /** Nonce — validated against id_token claims to prevent replay attacks */
    nonce: string;

    /** Original URL to redirect to after successful authentication (optional) */
    returnTo?: string;
}

/**
 * User session stored after successful OIDC authentication.
 *
 * Created during the callback handler after code exchange and user info fetch.
 * Consumed by the me, refresh, and logout handlers.
 *
 * Default storage: signed cookie (`__oidc_session`).
 * Override `storeSession()`, `getSession()`, and `clearSession()` hooks for custom storage.
 *
 * @remarks
 * Decision per P3: Cookie name defaults to `__oidc_session`.
 * Decision per P5: Default cookie storage has ~4KB size limit. For production
 * with large tokens, override session hooks with server-side storage (Redis/DB).
 */
export interface OidcSession {
    /** Access token — used for API calls and token refresh */
    accessToken: string;

    /** Refresh token — used to obtain new tokens without re-authentication */
    refreshToken?: string;

    /** ID token — used for logout (id_token_hint) */
    idToken?: string;

    /** Token expiration timestamp (seconds since epoch) */
    expiresAt?: number;

    /** User claims/profile data from UserInfo endpoint or id_token */
    user: Record<string, unknown>;

    /** Organization/tenant slug for multi-tenant sessions. (AR #15) */
    organizationSlug?: string;
}
