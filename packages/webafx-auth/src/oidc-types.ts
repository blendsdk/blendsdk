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
// CSRF Configuration
// ---------------------------------------------------------------------------

/**
 * Opt-in CSRF enforcement for the OIDC BFF controller.
 *
 * When enabled, `POST /logout` and `POST /refresh` must present the session's
 * CSRF token in the configured header. The token is generated per session,
 * returned by `GET /me`, and never placed in a script-readable cookie.
 *
 * This is static configuration: a per-request `configFactory` cannot vary it,
 * matching `sessionTtl` and `rotateSessionIdOnRefresh`. A session created
 * before enforcement was enabled has no token, so enabling CSRF signs those
 * sessions out on their next logout or refresh.
 */
export interface OidcCsrfConfig {
    /** Enable CSRF enforcement on logout/refresh. Default: false. */
    enabled?: boolean;
    /** Header carrying the token. Default: `'x-csrf-token'`. */
    header?: string;
}

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

    /**
     * Require an audience check for validated tokens. Default: false.
     *
     * When true, a token is rejected unless an `audience` is configured and the
     * token's `aud` matches it. This fails closed, so a token minted for a
     * different API by the same issuer is not accepted here. When false
     * (default), the audience is checked only if `audience` is set.
     */
    requireAudience?: boolean;

    /**
     * Clock tolerance in seconds for JWT validation. Default: 30. (AR #9)
     *
     * Also used as the skew for the session-cookie expiry check. That check
     * reads the static configuration only, so a per-request `configFactory`
     * does not change it (matching the rest of the session path).
     */
    clockTolerance?: number;

    /** OIDC scopes to request. Default: ['openid', 'profile', 'email'] */
    scopes?: string[];

    /** Discovery cache TTL in seconds. Default: 3600 (1 hour). (AR #10) */
    discoveryTtl?: number;

    /**
     * Verify the signature of the ID token returned by the authorization-code
     * exchange against the issuer's published JWKS. Default: true.
     *
     * Signature verification is the OpenID Connect requirement that makes the
     * ID token non-repudiable. Set this to `false` only for a provider that
     * cannot expose a verifiable ID token; the `iss`, `aud`, `nonce`, and `exp`
     * claims are still validated.
     *
     * This is static configuration: a per-request `configFactory` cannot vary
     * it. The signature check is enabled when the discovery configuration is
     * built, and that cache entry is shared by all tenants of the provider.
     */
    verifyIdTokenSignature?: boolean;

    /**
     * Verify that the UserInfo response `sub` equals the ID-token `sub`.
     * Default: true.
     *
     * OpenID Connect Core 1.0 §5.3.2 requires this check and states that a
     * UserInfo response with a different subject MUST NOT be used. A mismatch
     * aborts the callback with a `400` and creates no session.
     *
     * The check needs a verified ID token. When `verifyIdTokenSignature` is
     * `false` no trusted subject is available, so the check is skipped and the
     * provider emits a one-time warning; comparing against an unverified
     * subject would prove nothing. Set this to `false` only for a provider
     * whose UserInfo subject cannot be validated.
     *
     * This is static configuration: a per-request `configFactory` cannot vary
     * it, matching `verifyIdTokenSignature` and `rotateSessionIdOnRefresh`.
     */
    verifyUserInfoSubject?: boolean;

    /**
     * How the callback treats a UserInfo endpoint denial (HTTP 403).
     *
     * `'error'` (default): the callback returns a fixed
     * `403 userinfo_forbidden` and creates no session.
     * `'unauthorized-session'`: the callback stores a session carrying the
     * exchanged tokens, the identity from the verified ID token, and
     * `authorized: false`, sets the session cookie, and redirects to
     * `notAuthorizedPath`. When no verified identity is available (for example
     * `verifyIdTokenSignature: false`), the outcome falls back to the fixed
     * `403`.
     *
     * This is static configuration: a per-request `configFactory` cannot vary
     * it, matching `verifyUserInfoSubject` and `rotateSessionIdOnRefresh`.
     */
    userInfoDenied?: "error" | "unauthorized-session";

    /**
     * Browser redirect target after an unauthorized session is created in
     * `'unauthorized-session'` mode.
     *
     * Default: `/`. This is static configuration: a per-request
     * `configFactory` cannot vary it.
     */
    notAuthorizedPath?: string;

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
     * Hard maximum session lifetime in seconds, measured from the session's
     * `createdAt`. Unlike the sliding `sessionTtl`, activity (refresh) never
     * extends it. Unset keeps the previous behavior (idle TTL only).
     *
     * A stored session with no `createdAt` — one written before this option was
     * configured — skips the absolute check on read; the next store stamps it,
     * giving that legacy session a fresh window instead of signing it out.
     *
     * A value of 0 or less makes every session immediately past its deadline on
     * the next read, so treat it as invalid configuration.
     *
     * This is static configuration: a per-request `configFactory` cannot vary it.
     */
    sessionAbsoluteTtl?: number;

    /**
     * Session cookie TTL in seconds.
     *
     * Sets the browser session cookie's `maxAge` independently of the access
     * token's `expiresIn`. When unset it falls back to `sessionTtl`, and then
     * to 3600 seconds, so the cookie matches the server-side session by
     * default. Each successful refresh re-issues the cookie with this lifetime,
     * letting the cookie and the session slide together.
     *
     * This is static configuration: a per-request `configFactory` cannot vary
     * it, matching the server-side `sessionTtl`. It may be larger or smaller
     * than `sessionTtl` (the two are independent); a cookie that outlives the
     * session only produces a 401 once the store entry expires. A value of 0 or
     * less yields a non-persistent cookie. A long cookie does not by itself
     * extend the session — the tokens must still be refreshed.
     */
    sessionCookieTtl?: number;

    /**
     * Rotate the opaque session identifier on every successful token refresh.
     * Default: false.
     *
     * When enabled, a successful refresh stores the updated session under a new
     * id, deletes the old session, and issues a cookie with the new id, so a
     * session id captured before the refresh stops resolving. Rotation happens
     * only after the token refresh and the new session store both succeed; a
     * failure leaves the existing session and cookie in place. A delete failure
     * after a successful store can leave the new session stored until it
     * expires.
     *
     * Two refreshes racing with the same id can leave more than one live session
     * until the store TTL expires, so assume a single in-flight refresh. If a
     * successful refresh response is lost in transit, the browser keeps the old
     * cookie whose session was just deleted, so the user must sign in again.
     * This is inherent to rotation.
     *
     * This is static configuration: a per-request `configFactory` cannot vary it.
     */
    rotateSessionIdOnRefresh?: boolean;

    /**
     * State TTL in seconds for PKCE transient state storage.
     * Determines how long login flow state is kept between redirect and callback.
     * Default: 300 (5 minutes).
     */
    stateTtl?: number;

    /**
     * Opt-in CSRF enforcement for the OIDC BFF controller. Unset keeps the
     * previous behavior (no CSRF check).
     */
    csrf?: OidcCsrfConfig;
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
    /**
     * Subject from the verified ID token returned by the code exchange.
     *
     * Used to validate the UserInfo response against the identity the ID token
     * proved. Unset on refresh responses (they carry no ID token) and when
     * `verifyIdTokenSignature` is disabled, because a subject from an
     * unverified ID token must not be trusted.
     */
    subject?: string;

    /**
     * Claims from the verified ID token returned by the code exchange.
     *
     * Present only when the ID-token signature was verified and the token
     * carried a string `sub`, so the field always includes a usable subject.
     * Absent on refresh responses and when signature verification is disabled;
     * consumers must treat absence as "no trusted identity". The controller
     * copies only the allowlisted identity claims into an unauthorized
     * session.
     */
    idTokenClaims?: Record<string, unknown>;
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

    /**
     * Post-login redirect target captured from the login request.
     *
     * Always a relative, same-origin path: the controller rejects absolute,
     * protocol-relative, or otherwise unsafe values and stores nothing when the
     * request carries no `returnTo`. The callback redirects to this path or,
     * when it is absent, to the app root "/".
     */
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

    /**
     * Unix seconds when the session was first created.
     *
     * Stamped on the first `storeSession` and preserved across refresh and
     * session-id rotation. Used with `sessionAbsoluteTtl` to bound the total
     * session lifetime.
     */
    createdAt?: number;

    /** User claims/profile data from UserInfo endpoint or id_token */
    user: Record<string, unknown>;

    /** Organization/tenant slug for multi-tenant sessions. (AR #15) */
    organizationSlug?: string;

    /**
     * Per-session CSRF token. Stored server-side and returned by `GET /me`;
     * never placed in a script-readable cookie.
     */
    csrfToken?: string;

    /**
     * False when the identity provider accepted the user but the application
     * denied access to the UserInfo endpoint. Unset (legacy sessions) and
     * true both mean authorized; only the opt-in
     * `userInfoDenied: 'unauthorized-session'` policy stores false.
     */
    authorized?: boolean;
}
