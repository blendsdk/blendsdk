/**
 * OidcAuthController — Abstract WebAFX controller for OIDC BFF authentication.
 *
 * Provides five pre-built HTTP routes for the OIDC authorization code flow
 * with PKCE. All session and state operations are delegated to the
 * OidcAuthProvider resolved from the DI container (req.services).
 *
 * The provider is registered via createAuthPlugin() and resolved per-request
 * using req.services.get(serviceName).
 *
 * Extends BaseController from @blendsdk/webafx. Hooks (onCallback,
 * getLoginParams, resolveOrganization, getRoutePrefix) remain overridable.
 *
 * @remarks
 * Decision per AR #1: Breaking change — abstract methods removed.
 * Decision per AR #2: Provider owns session ops — controller delegates.
 * Decision per AR #4: Hooks stay on controller.
     * Decision per AR #5: /me uses this.authenticated(); /logout and /refresh
     * are public and validate the session cookie in the handler.
 *
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { BaseController } from "@blendsdk/webafx";
import type { RouteDefinition } from "@blendsdk/webafx";
import type { OidcAuthProvider } from "./oidc-auth-provider.js";
import { DEFAULT_SERVICE_NAME } from "./types.js";
import type {
    OidcTokens,
    BuildAuthorizationUrlParams,
    OidcAuthConfig,
} from "./oidc-types.js";
import type { OidcSessionState, OidcSession } from "./oidc-types.js";
import { oidcOpenApi } from "./oidc-openapi.js";
import {
    OidcUserInfoSubjectMismatchError,
    OidcCodeExchangeError,
    OidcUserInfoForbiddenError,
} from "./oidc-errors.js";
import {
    buildUnauthorizedSession,
    pickIdentityClaims,
} from "./oidc-unauthorized-session.js";
import { RefreshSingleFlight, executeSessionRefresh } from "./oidc-refresh.js";
import {
    assertOidcCsrf,
    generateCsrfToken,
    parseCookie,
    stripNullValues,
} from "./oidc-helpers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** State cookie max age: 5 minutes (seconds) — matches provider DEFAULT_STATE_TTL */
const STATE_COOKIE_MAX_AGE = 300;

// ---------------------------------------------------------------------------
// OidcAuthController
// ---------------------------------------------------------------------------

/**
 * Abstract controller providing BFF HTTP routes for OIDC authentication.
 *
 * The provider is resolved from the DI container via `req.services.get('auth')`.
 * Register the provider using `createAuthPlugin()` in your WebAFX application.
 *
 * No abstract methods are required — subclasses can override hooks for
 * customization (getLoginParams, onCallback, resolveOrganization, getRoutePrefix).
 * The class is abstract to prevent direct instantiation (it's a framework base).
 *
 * Routes provided:
 * - `GET  {prefix}/login`    — public, initiates OIDC authorization
 * - `GET  {prefix}/callback` — public, handles OIDC callback
 * - `POST {prefix}/logout`   — public, self-validating; clears session
 * - `GET  {prefix}/me`       — authenticated, returns user data
 * - `POST {prefix}/refresh`  — public, self-validating; refreshes tokens
 *
 * @example
 * ```typescript
 * // 1. Register the provider as a plugin:
 * app.use(oidcAuthPlugin({
 *     issuerUrl: process.env.OIDC_ISSUER_URL,
 *     clientId: process.env.OIDC_CLIENT_ID,
 *     clientSecret: process.env.OIDC_CLIENT_SECRET,
 *     redirectUri: `${process.env.APP_URL}/api/oidc/callback`,
 *     sessionStore: cacheProvider, // from webafx-cache
 * }));
 *
 * // 2. Create a controller subclass (or use as-is):
 * class MyAuthController extends OidcAuthController {
 *     // All hooks have working defaults — override only what you need
 *     protected getRoutePrefix(): string {
 *         return "/api/oidc";
 *     }
 * }
 *
 * // 3. Register the controller:
 * app.use(MyAuthController);
 * ```
 */
export abstract class OidcAuthController extends BaseController {
    // -----------------------------------------------------------------------
    // Provider resolution (DI)
    // -----------------------------------------------------------------------

    /**
     * Returns the service name used to resolve the auth provider from DI.
     * Override to use a custom service name when multiple providers are registered.
     *
     * @returns Service name (default: 'auth' from DEFAULT_SERVICE_NAME)
     */
    protected getProviderServiceName(): string {
        return DEFAULT_SERVICE_NAME;
    }

    /**
     * Resolves the OidcAuthProvider from the request's service container.
     * The provider must be registered via createAuthPlugin() or manually.
     *
     * @param req - Express request with services container
     * @returns The OidcAuthProvider instance from DI
     * @throws Error if the provider is not registered in the container
     */
    protected async getProvider(req: Request): Promise<OidcAuthProvider> {
        return req.services.get<OidcAuthProvider>(this.getProviderServiceName());
    }

    /**
     * Single-flight runner for `POST /refresh`, keyed by session id.
     *
     * Concurrent requests for one session share one grant, one session store,
     * and one session-id rotation. The runner is process-local: a deployment
     * with several application instances needs an external lock.
     */
    private readonly refreshFlights = new RefreshSingleFlight();

    // -----------------------------------------------------------------------
    // Route definitions
    // -----------------------------------------------------------------------

    /**
     * Returns the five OIDC BFF route definitions.
     *
     * @remarks
     * Decision per AR #21: Routes registered via WebAFX plugin pattern.
     * Decision per AR #22: Configurable prefix (default: '/api/oidc') + fixed suffixes.
 * Decision per AR #5: /me uses this.authenticated(); /logout and /refresh are
 * public and validate the session cookie in the handler.
     *
     * Routes:
     * - GET  {prefix}/login     — public, redirects to OIDC provider
     * - GET  {prefix}/callback  — public, handles OIDC callback
     * - POST {prefix}/logout    — public, self-validating; clears session
     * - GET  {prefix}/me        — authenticated, returns user data
     * - POST {prefix}/refresh   — public, self-validating; refreshes tokens
     *
     * `logout` and `refresh` are intentionally not behind the secure guard: they
     * validate the opaque session cookie themselves (401 without a session, 400
     * without a refresh token), so a session past its access-token expiry can
     * still refresh or log out. The secure guard would reject those requests
     * before the handler ran.
     */
    routes(): RouteDefinition[] {
        const prefix = this.getRoutePrefix();
        return [
            this.route()
                .get(`${prefix}/login`)
                .openapi(oidcOpenApi.login)
                .handle(this.handleLogin.bind(this)),
            this.route()
                .get(`${prefix}/callback`)
                .openapi(oidcOpenApi.callback)
                .handle(this.handleCallback.bind(this)),
            this.route()
                .post(`${prefix}/logout`)
                .openapi(oidcOpenApi.logout)
                .handle(this.handleLogout.bind(this)),
            this.authenticated()
                .get(`${prefix}/me`)
                .openapi(oidcOpenApi.me)
                .handle(this.handleMe.bind(this)),
            this.route()
                .post(`${prefix}/refresh`)
                .openapi(oidcOpenApi.refresh)
                .handle(this.handleRefresh.bind(this)),
        ];
    }

    /**
     * Returns the route prefix for all auth routes.
     * Override to change from the default '/api/oidc'.
     *
     * @remarks Decision per OIDC Session Store plan: Changed from '/auth' to '/api/oidc'.
     */
    protected getRoutePrefix(): string {
        return "/api/oidc";
    }

    // -----------------------------------------------------------------------
    // Overridable hooks
    // -----------------------------------------------------------------------

    /**
     * Called after successful code exchange, before session is stored.
     * Override to enrich user info (e.g., create/update user in database).
     *
     * @param tokens - Tokens received from the OIDC provider
     * @param userInfo - User claims from the UserInfo endpoint
     * @param _req - Express request (access DI container via req.services)
     * @param _res - Express response
     * @returns Modified tokens and userInfo for session storage
     *
     * @remarks Decision per AR #20: Default passes through unchanged.
     */
    protected async onCallback(
        tokens: OidcTokens,
        userInfo: Record<string, unknown>,
        _req: Request,
        _res: Response,
    ): Promise<{ tokens: OidcTokens; userInfo: Record<string, unknown> }> {
        return { tokens, userInfo };
    }

    /**
     * Called during logout, before session is cleared.
     * Override for custom logout logic (e.g., audit logging, cache invalidation).
     *
     * @remarks Decision per AR #20: Default is no-op.
     */
    protected async onLogout(_req: Request, _res: Response): Promise<void> {
        // Default: no-op
    }

    /**
     * Returns extra parameters for the authorization URL built during login.
     *
     * Default implementation forwards `prompt` and `login_hint` from the
     * request query string, enabling the frontend to control OIDC behavior:
     * - `GET /api/oidc/login?prompt=login` — force re-authentication
     * - `GET /api/oidc/login?prompt=consent` — force consent screen
     * - `GET /api/oidc/login?login_hint=user@example.com` — pre-fill login form
     *
     * Override for custom behavior (e.g., always force consent, add `acr_values`,
     * or pass tenant-specific parameters).
     *
     * @param req - Express request (read query params, headers, DI container)
     * @returns Authorization URL parameters passed to `buildAuthorizationUrl()`
     */
    protected getLoginParams(req: Request): BuildAuthorizationUrlParams {
        const extraParams: Record<string, string> = {};
        const { prompt, login_hint } = req.query as Record<string, string>;
        if (prompt) extraParams.prompt = prompt;
        if (login_hint) extraParams.login_hint = login_hint;
        // Only return extraParams when non-empty to keep the default call clean
        return Object.keys(extraParams).length > 0 ? { extraParams } : {};
    }

    /**
     * Resolves the organization/tenant slug from a request.
     * Override for multi-tenant scenarios where cookie names are org-scoped.
     *
     * When this returns a non-empty string, the provider's cookie name resolution
     * functions (resolveSessionCookieName, resolveStateCookieName in config)
     * handle scoping.
     *
     * @param _req - Express request
     * @returns Organization slug, or undefined for single-tenant
     *
     * @remarks Decision per AR #6, #15: Multi-tenant org-scoped cookie names.
     */
    protected resolveOrganization(_req: Request): string | undefined {
        return undefined;
    }

    /**
     * Resolve the OIDC configuration for a request.
     *
     * The default delegates to the provider's `configFactory`, so a
     * multi-tenant deployment can point one controller at different issuers
     * per request. Override to customize resolution. The already-resolved
     * provider is passed in so the handler does not resolve it (and run
     * `configFactory`) twice per request.
     *
     * @param req - Express request used to resolve the tenant/issuer
     * @param provider - The provider already resolved for this request
     * @returns The resolved config, or undefined when there is no factory
     */
    protected async resolveConfig(
        req: Request,
        provider: OidcAuthProvider
    ): Promise<OidcAuthConfig | undefined> {
        return provider.resolveRequestConfig(req);
    }

    // -----------------------------------------------------------------------
    // Route handlers
    // -----------------------------------------------------------------------

    /**
     * GET {prefix}/login — Initiates OIDC authorization code flow.
     *
     * 1. Resolves provider from DI
     * 2. Builds authorization URL with PKCE
     * 3. Stores PKCE state via provider.storeState()
     * 4. Sets state cookie with UUID
     * 5. Redirects (302) to authorization URL
     *
     * Stores a validated same-origin `returnTo` path for the post-login redirect.
     */
    async handleLogin(req: Request, res: Response): Promise<void> {
        const provider = await this.getProvider(req);

        // Use getLoginParams() hook to forward OIDC params (prompt, login_hint, etc.)
        const loginParams = this.getLoginParams(req);
        const config = await this.resolveConfig(req, provider);
        const authResult = await provider.buildAuthorizationUrl(config, loginParams);

        // Only a relative, same-origin path is a safe post-login redirect target.
        const rawReturnTo = req.query.returnTo;

        const sessionState: OidcSessionState = {
            codeVerifier: authResult.codeVerifier,
            state: authResult.state,
            nonce: authResult.nonce,
            returnTo: rawReturnTo === undefined ? undefined : this.sanitizeReturnPath(rawReturnTo),
        };

        // Generate UUID for state storage and delegate to provider
        const stateId = randomUUID();
        await provider.storeState(stateId, sessionState);

        // Set state cookie with the UUID — browser sends it back on callback
        const stateCookieName = provider.getStateCookieName(req);
        this.setCookie(res, stateCookieName, stateId, { maxAge: STATE_COOKIE_MAX_AGE });

        res.redirect(authResult.url);
    }

    /**
     * GET {prefix}/callback — Handles OIDC authorization callback.
     *
     * 1. Validates query params (error, code)
     * 2. Retrieves PKCE state from provider via cookie UUID
     * 3. Validates state parameter (CSRF protection)
     * 4. Exchanges authorization code for tokens via provider
     * 5. Fetches user info from provider, verifying its `sub` against the
     *    verified ID-token subject when `verifyUserInfoSubject` is enabled
     *    (default); a mismatch clears the transient state and returns 400.
     *    A UserInfo denial (403) clears the state and either returns a fixed
     *    403 or, with `userInfoDenied: 'unauthorized-session'`, stores an
     *    unauthorized session and redirects to `notAuthorizedPath`
     * 6. Calls onCallback hook (for custom processing)
     * 7. Stores session via provider.storeSession()
     * 8. Sets the session cookie with the provider's session-cookie TTL
     *    (`sessionCookieTtl ?? sessionTtl ?? 3600`), not the access-token expiry
     * 9. Clears transient state via provider.clearState()
     * 10. Redirects to the validated returnTo path, or '/' when unset
     *
     * Error handling: returns a fixed 400 JSON envelope for invalid state,
     * missing code, missing session state, and a failed code exchange or
     * ID-token verification, clearing the transient state; a UserInfo denial
     * returns a fixed 403 or creates an unauthorized session. Infrastructure
     * failures (network, discovery, 5xx) propagate to the framework error
     * handler.
     */
    async handleCallback(req: Request, res: Response): Promise<void> {
        const { code, state: returnedState, error, iss } = req.query as Record<string, string>;

        // The identity provider declined to complete the flow. Answer with a
        // fixed message: the `error` and `error_description` query values are
        // untrusted input and must never be reflected back to the caller.
        if (error) {
            res.status(400).json({
                success: false,
                error: {
                    code: "oidc_error",
                    message: "Sign-in was rejected by the identity provider",
                },
            });
            return;
        }

        // Validate required parameters
        if (!code) {
            res.status(400).json({
                success: false,
                error: { code: "missing_code", message: "Authorization code missing from callback" },
            });
            return;
        }

        // Resolve provider from DI, the per-request config, and retrieve PKCE state
        const provider = await this.getProvider(req);
        const config = await this.resolveConfig(req, provider);
        const stateCookieName = provider.getStateCookieName(req);
        const stateId = parseCookie(req, stateCookieName);

        // Retrieve session state from provider (returns undefined if expired/missing)
        const sessionState = stateId ? await provider.getState(stateId) : undefined;
        if (!sessionState) {
            res.status(400).json({
                success: false,
                error: { code: "missing_state", message: "Session state not found (expired or missing)" },
            });
            return;
        }

        if (sessionState.state !== returnedState) {
            res.status(400).json({
                success: false,
                error: { code: "invalid_state", message: "State parameter mismatch (possible CSRF)" },
            });
            return;
        }

        // Exchange code for tokens.
        // Build the full callback URL including query params — openid-client
        // extracts the authorization code from the URL's query string.
        const redirectUri = config?.redirectUri ?? provider.getRedirectUri();
        const callbackUrl = new URL(redirectUri!);
        callbackUrl.searchParams.set("code", code);
        if (returnedState) callbackUrl.searchParams.set("state", returnedState);
        // Forward RFC 9207 issuer parameter — required by openid-client v6+ / oauth4webapi v3+
        if (iss) callbackUrl.searchParams.set("iss", iss);

        const exchangeParams = {
            codeVerifier: sessionState.codeVerifier,
            callbackUrl: callbackUrl.toString(),
            nonce: sessionState.nonce,
        };

        // A failed exchange (bad/expired code, failed ID-token verification) is
        // a rejected sign-in. Map it to a fixed client error; a genuinely
        // unexpected error still propagates to the framework error handler.
        let tokens: OidcTokens;
        try {
            tokens = config
                ? await provider.exchangeCode(exchangeParams, config)
                : await provider.exchangeCode(exchangeParams);
        } catch (error) {
            if (!(error instanceof OidcCodeExchangeError)) {
                throw error;
            }
            // The authorization code is single-use and the PKCE state is spent:
            // clear the transient entry and its cookie exactly as the success
            // path does. No session is created and no session cookie is set.
            if (stateId) {
                await provider.clearState(stateId);
            }
            this.clearCookieByName(res, stateCookieName);
            res.status(400).json({
                success: false,
                error: {
                    code: "oidc_exchange_failed",
                    message: "Sign-in could not be completed",
                },
            });
            return;
        }

        // Verify the UserInfo subject against the verified ID-token subject
        // when the provider is configured to do so. `tokens.subject` is absent
        // when no verified ID token was available (for example when ID-token
        // signature verification is disabled), in which case there is nothing
        // trusted to compare and the check is skipped.
        const expectedSubject = provider.shouldVerifyUserInfoSubject()
            ? tokens.subject
            : undefined;

        let userInfo: Record<string, unknown>;
        try {
            userInfo = config
                ? await provider.fetchUserInfo(tokens.accessToken, expectedSubject, config)
                : await provider.fetchUserInfo(tokens.accessToken, expectedSubject);
        } catch (error) {
            if (error instanceof OidcUserInfoSubjectMismatchError) {
                // The authorization code is spent and the PKCE state is
                // single-use: clear the transient entry and its cookie before
                // rejecting, as the success path does. No session is created
                // and no session cookie is set.
                if (stateId) {
                    await provider.clearState(stateId);
                }
                this.clearCookieByName(res, stateCookieName);
                res.status(400).json({
                    success: false,
                    error: {
                        code: "userinfo_subject_mismatch",
                        message:
                            "UserInfo response subject does not match the ID token subject",
                    },
                });
                return;
            }
            if (error instanceof OidcUserInfoForbiddenError) {
                await this.handleUserInfoDenied(
                    req,
                    res,
                    provider,
                    tokens,
                    stateId,
                    stateCookieName
                );
                return;
            }
            throw error;
        }

        // Call onCallback hook for custom processing
        const callbackResult = await this.onCallback(tokens, userInfo, req, res);

        // Build session — strip null/undefined values to keep storage clean.
        // A fresh CSRF token is minted only when enforcement is enabled, so a
        // controller without CSRF stores exactly what it did before.
        const orgSlug = this.resolveOrganization(req);
        const csrfEnabled = provider.getCsrfConfig()?.enabled === true;
        const session = stripNullValues<OidcSession>({
            accessToken: callbackResult.tokens.accessToken,
            refreshToken: callbackResult.tokens.refreshToken,
            idToken: callbackResult.tokens.idToken,
            expiresAt: callbackResult.tokens.expiresIn
                ? Math.floor(Date.now() / 1000) + callbackResult.tokens.expiresIn
                : undefined,
            user: callbackResult.userInfo,
            organizationSlug: orgSlug,
            csrfToken: csrfEnabled ? generateCsrfToken() : undefined,
        });

        // Store session via provider with UUID key
        const sessionId = randomUUID();
        await provider.storeSession(sessionId, session);

        // Set session cookie with the UUID. The cookie lifetime follows the
        // provider's session TTL rather than the access token, so a short
        // access token does not sign the user out early.
        const sessionCookieName = provider.getSessionCookieName(req);
        this.setCookie(res, sessionCookieName, sessionId, {
            maxAge: provider.getSessionCookieTtl(),
        });

        // Clear transient state from provider store and cookie
        if (stateId) {
            await provider.clearState(stateId);
        }
        this.clearCookieByName(res, stateCookieName);

        // Redirect to the validated post-login target, defaulting to the app root.
        res.redirect(this.sanitizeReturnPath(sessionState.returnTo));
    }

    /**
     * Handle a UserInfo endpoint denial after a successful code exchange.
     *
     * The default policy (and the fail-closed fallback) clears the spent PKCE
     * state and returns a fixed 403 with no session. With
     * `userInfoDenied: 'unauthorized-session'` and a verified ID-token
     * identity, the session is stored with `authorized: false`, the session
     * cookie is set, and the browser is redirected to `notAuthorizedPath`.
     * The `onCallback` hook is not called: there is no UserInfo payload.
     *
     * The session user is limited to the allowlisted identity claims copied
     * from the verified ID token; unverified data is never stored.
     *
     * @param req - Express request used to resolve the organization
     * @param res - Express response
     * @param provider - The provider already resolved for this request
     * @param tokens - Tokens from the successful code exchange
     * @param stateId - Stored state id, when a state cookie was present
     * @param stateCookieName - Resolved state cookie name
     */
    private async handleUserInfoDenied(
        req: Request,
        res: Response,
        provider: OidcAuthProvider,
        tokens: OidcTokens,
        stateId: string | undefined,
        stateCookieName: string
    ): Promise<void> {
        const identity =
            provider.getUserInfoDeniedMode() === "unauthorized-session"
                ? pickIdentityClaims(tokens.idTokenClaims)
                : undefined;

        if (!identity) {
            // Default outcome, also the fail-closed fallback when no verified
            // identity is available. The code is spent and the PKCE state is
            // single-use, so the transient entry and its cookie are cleared.
            if (stateId) {
                await provider.clearState(stateId);
            }
            this.clearCookieByName(res, stateCookieName);
            res.status(403).json({
                success: false,
                error: {
                    code: "userinfo_forbidden",
                    message: "Access to this account is not permitted",
                },
            });
            return;
        }

        const session = buildUnauthorizedSession({
            tokens,
            identity,
            organizationSlug: this.resolveOrganization(req),
            csrfEnabled: provider.getCsrfConfig()?.enabled === true,
        });

        const sessionId = randomUUID();
        await provider.storeSession(sessionId, session);
        this.setCookie(res, provider.getSessionCookieName(req), sessionId, {
            maxAge: provider.getSessionCookieTtl(),
        });

        if (stateId) {
            await provider.clearState(stateId);
        }
        this.clearCookieByName(res, stateCookieName);
        res.redirect(provider.getNotAuthorizedPath());
    }

    /**
     * POST {prefix}/logout — Clears session and revokes tokens.
     *
     * 1. Resolves provider and gets session for token revocation
     * 2. Calls onLogout hook
     * 3. Optionally revokes access token via provider (best-effort)
     * 4. Clears session via provider.clearSession()
     * 5. Clears session cookie
     * 6. Returns success response
     */
    async handleLogout(req: Request, res: Response): Promise<void> {
        const provider = await this.getProvider(req);
        const cookieName = provider.getSessionCookieName(req);
        const sessionId = parseCookie(req, cookieName);

        // Get session for token revocation and the CSRF token (may be
        // undefined if expired).
        const session = sessionId ? await provider.getSession(sessionId) : undefined;

        // When enforcement is on, a missing/expired session has no expected
        // token and is rejected here rather than skipping the check.
        const csrf = provider.getCsrfConfig();
        if (csrf?.enabled && !assertOidcCsrf(req, res, csrf, session)) {
            return;
        }

        await this.onLogout(req, res);

        // Best-effort token revocation (don't fail if revocation fails).
        // Resolving the config is also best-effort here: a factory failure
        // must not stop the session and cookie from being cleared.
        if (session?.accessToken) {
            try {
                const config = await this.resolveConfig(req, provider);
                if (config) {
                    await provider.revokeToken(
                        session.accessToken,
                        "access_token",
                        config
                    );
                } else {
                    await provider.revokeToken(
                        session.accessToken,
                        "access_token"
                    );
                }
            } catch {
                // Silent — revocation is best-effort
            }
        }

        // Clear session from provider store
        if (sessionId) {
            await provider.clearSession(sessionId);
        }
        // Always clear the session cookie
        this.clearCookieByName(res, cookieName);

        this.ok(res, { message: "Logged out" });
    }

    /**
     * GET {prefix}/me — Returns current user session data.
     *
     * Returns user claims, the session expiry, and the authorization state.
     * Access and refresh tokens are never exposed. When CSRF enforcement is
     * enabled, the session's CSRF token is included so the client can send it
     * on later mutations.
     */
    async handleMe(req: Request, res: Response): Promise<void> {
        const provider = await this.getProvider(req);
        const cookieName = provider.getSessionCookieName(req);
        const sessionId = parseCookie(req, cookieName);

        // No session cookie or session not found → 401
        const session = sessionId ? await provider.getSession(sessionId) : undefined;

        if (!session) {
            res.status(401).json({
                success: false,
                error: { code: "no_session", message: "No active session" },
            });
            return;
        }

        const csrf = provider.getCsrfConfig();
        this.ok(res, {
            user: session.user,
            expiresAt: session.expiresAt,
            // Legacy sessions without the flag are authorized.
            authorized: session.authorized !== false,
            // The token is only exposed when enforcement is enabled, so a
            // controller without CSRF keeps its previous response shape.
            ...(csrf?.enabled ? { csrfToken: session.csrfToken } : {}),
        });
    }

    /**
     * POST {prefix}/refresh — Refreshes tokens using stored refresh token.
     *
     * 1. Resolves provider and retrieves session
     * 2. Validates the caller's CSRF token, when enforcement is enabled
     * 3. Validates refresh token exists
     * 4. Joins or starts the single-flight execution for the session id. The
     *    shared execution re-reads the session, calls `provider.refreshToken()`,
     *    stores the updated session, and rotates the session id when
     *    `rotateSessionIdOnRefresh` is enabled.
     * 5. Re-issues the session cookie from the shared outcome with the provider
     *    session-cookie TTL, so the cookie slides with the session and every
     *    joined caller receives the same (possibly rotated) id
     * 6. Returns success with the new expiry
     *
     * Concurrent requests for one session perform exactly one grant and one
     * store. CSRF is validated per caller before joining, so a request without
     * a valid token can never share a legitimate refresh. A caller that reaches
     * the lock after the execution settled re-reads the session: with rotation
     * its old id no longer resolves and it receives `401`, matching the
     * rotation guarantee; without rotation it performs a sequential refresh.
     */
    async handleRefresh(req: Request, res: Response): Promise<void> {
        const provider = await this.getProvider(req);
        const cookieName = provider.getSessionCookieName(req);
        const sessionId = parseCookie(req, cookieName);
        const session = sessionId ? await provider.getSession(sessionId) : undefined;

        // Enforce CSRF before any state change. A missing/expired session has
        // no expected token and is rejected here rather than skipping it.
        const csrf = provider.getCsrfConfig();
        if (csrf?.enabled && !assertOidcCsrf(req, res, csrf, session)) {
            return;
        }

        if (!sessionId || !session) {
            res.status(401).json({
                success: false,
                error: { code: "no_session", message: "No active session" },
            });
            return;
        }

        if (!session.refreshToken) {
            res.status(400).json({
                success: false,
                error: { code: "no_refresh_token", message: "No refresh token available" },
            });
            return;
        }

        const config = await this.resolveConfig(req, provider);

        // Coalesce the state mutation: concurrent requests for one session
        // share a single grant, store, and (with rotation) id move. The shared
        // execution re-reads the session, so a request that arrives after a
        // rotation completed is not presented with the consumed refresh token.
        const outcome = await this.refreshFlights.run(sessionId, () =>
            executeSessionRefresh({
                provider,
                sessionId,
                config,
                csrfEnabled: csrf?.enabled === true,
            })
        );

        if (outcome.status === "no_session") {
            res.status(401).json({
                success: false,
                error: { code: "no_session", message: "No active session" },
            });
            return;
        }

        if (outcome.status === "no_refresh_token") {
            res.status(400).json({
                success: false,
                error: { code: "no_refresh_token", message: "No refresh token available" },
            });
            return;
        }

        // Re-issue the session cookie so the browser cookie and the server-side
        // session slide together. Only reached after a successful store, so a
        // failed refresh never extends the cookie.
        this.setCookie(res, cookieName, outcome.sessionId, {
            maxAge: provider.getSessionCookieTtl(),
        });

        this.ok(res, {
            expiresAt: outcome.expiresAt,
            message: "Tokens refreshed",
            ...(csrf?.enabled ? { csrfToken: outcome.csrfToken } : {}),
        });
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /**
     * Validates a post-login redirect target.
     *
     * Only a relative, same-origin path is safe to redirect to. An absolute
     * URL (`https://evil.example`), a protocol-relative URL (`//evil.example`),
     * or a backslash variant (`/\evil.example`) would send the browser to an
     * attacker-controlled site after a successful login. Such values, non-string
     * values (for example a repeated query parameter parsed as an array), and
     * paths containing a backslash, a control character, or whitespace are all
     * rejected and replaced with the app root "/".
     *
     * @param value - The raw `returnTo` value, which may be of any type.
     * @returns A safe in-app path, or "/" when the value is not a safe path.
     */
    private sanitizeReturnPath(value: unknown): string {
        if (typeof value !== "string" || !value.startsWith("/")) {
            return "/";
        }
        if (value.startsWith("//")) {
            return "/";
        }
        if (/[\\\u0000-\u001F\u007F\s]/.test(value)) {
            return "/";
        }
        return value;
    }

    // -----------------------------------------------------------------------
    // Protected cookie utilities (available to subclasses)
    // -----------------------------------------------------------------------

    /**
     * Sets a cookie on the response with secure defaults.
     * Defaults: httpOnly, secure (production only), sameSite 'lax', path '/'.
     *
     * Protected so subclasses can reuse the framework's secure cookie options
     * instead of duplicating them.
     */
    protected setCookie(
        res: Response,
        name: string,
        value: string,
        options: { maxAge?: number } = {},
    ): void {
        res.cookie(name, value, {
            httpOnly: true,
            secure: this.settings.isProduction(),
            sameSite: "lax",
            path: "/",
            ...(options.maxAge !== undefined && { maxAge: options.maxAge * 1000 }), // Express uses ms
        });
    }

    /**
     * Clears a cookie by name with secure defaults.
     *
     * Protected so subclasses can reuse the framework's secure cookie options.
     */
    protected clearCookieByName(res: Response, name: string): void {
        res.clearCookie(name, {
            httpOnly: true,
            secure: this.settings.isProduction(),
            sameSite: "lax",
            path: "/",
        });
    }
}
