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
 * Decision per AR #5: /me, /logout, /refresh use this.authenticated().
 *
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { BaseController } from "@blendsdk/webafx";
import type { RouteDefinition } from "@blendsdk/webafx";
import type { OidcAuthProvider } from "./oidc-auth-provider.js";
import { DEFAULT_SERVICE_NAME } from "./types.js";
import type { OidcTokens, BuildAuthorizationUrlParams } from "./oidc-types.js";
import type { OidcSessionState, OidcSession } from "./oidc-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** State cookie max age: 5 minutes (seconds) — matches provider DEFAULT_STATE_TTL */
const STATE_COOKIE_MAX_AGE = 300;

/** Default session TTL: 1 hour (seconds) — used for session cookie max age */
const DEFAULT_SESSION_TTL = 3600;

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
 * - `POST {prefix}/logout`   — authenticated, clears session
 * - `GET  {prefix}/me`       — authenticated, returns user data
 * - `POST {prefix}/refresh`  — authenticated, refreshes tokens
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

    // -----------------------------------------------------------------------
    // Route definitions
    // -----------------------------------------------------------------------

    /**
     * Returns the five OIDC BFF route definitions.
     *
     * @remarks
     * Decision per AR #21: Routes registered via WebAFX plugin pattern.
     * Decision per AR #22: Configurable prefix (default: '/api/oidc') + fixed suffixes.
     * Decision per AR #5: /me, /logout, /refresh use this.authenticated().
     *
     * Routes:
     * - GET  {prefix}/login     — public, redirects to OIDC provider
     * - GET  {prefix}/callback  — public, handles OIDC callback
     * - POST {prefix}/logout    — authenticated, clears session
     * - GET  {prefix}/me        — authenticated, returns user data
     * - POST {prefix}/refresh   — authenticated, refreshes tokens
     */
    routes(): RouteDefinition[] {
        const prefix = this.getRoutePrefix();
        return [
            this.route()
                .get(`${prefix}/login`)
                .handle(this.handleLogin.bind(this)),
            this.route()
                .get(`${prefix}/callback`)
                .handle(this.handleCallback.bind(this)),
            this.authenticated()
                .post(`${prefix}/logout`)
                .handle(this.handleLogout.bind(this)),
            this.authenticated()
                .get(`${prefix}/me`)
                .handle(this.handleMe.bind(this)),
            this.authenticated()
                .post(`${prefix}/refresh`)
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
     * Captures `returnTo` query parameter for post-auth redirect (P4).
     */
    async handleLogin(req: Request, res: Response): Promise<void> {
        const provider = await this.getProvider(req);

        // Use getLoginParams() hook to forward OIDC params (prompt, login_hint, etc.)
        const loginParams = this.getLoginParams(req);
        const authResult = await provider.buildAuthorizationUrl(undefined, loginParams);

        const sessionState: OidcSessionState = {
            codeVerifier: authResult.codeVerifier,
            state: authResult.state,
            nonce: authResult.nonce,
            returnTo: (req.query.returnTo as string) || undefined,
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
     * 5. Fetches user info from provider
     * 6. Calls onCallback hook (for custom processing)
     * 7. Stores session via provider.storeSession()
     * 8. Clears transient state via provider.clearState()
     * 9. Redirects to returnTo or '/' (P4)
     *
     * Error handling: Returns 400 JSON for invalid state, missing code, or missing session state.
     * Throws on infrastructure errors (network, provider errors) per AR #14.
     */
    async handleCallback(req: Request, res: Response): Promise<void> {
        const { code, state: returnedState, error, error_description, iss } = req.query as Record<string, string>;

        // Handle OIDC error response (provider denied)
        if (error) {
            res.status(400).json({
                success: false,
                error: { code: "oidc_error", message: error_description || error },
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

        // Resolve provider from DI and retrieve PKCE state
        const provider = await this.getProvider(req);
        const stateCookieName = provider.getStateCookieName(req);
        const stateId = this.parseCookieByName(req, stateCookieName);

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
        const redirectUri = provider.getRedirectUri();
        const callbackUrl = new URL(redirectUri!);
        callbackUrl.searchParams.set("code", code);
        if (returnedState) callbackUrl.searchParams.set("state", returnedState);
        // Forward RFC 9207 issuer parameter — required by openid-client v6+ / oauth4webapi v3+
        if (iss) callbackUrl.searchParams.set("iss", iss);

        const tokens = await provider.exchangeCode({
            codeVerifier: sessionState.codeVerifier,
            callbackUrl: callbackUrl.toString(),
            nonce: sessionState.nonce,
        });

        // Fetch user info
        const userInfo = await provider.fetchUserInfo(tokens.accessToken);

        // Call onCallback hook for custom processing
        const callbackResult = await this.onCallback(tokens, userInfo, req, res);

        // Build session — strip null/undefined values to keep storage clean
        const orgSlug = this.resolveOrganization(req);
        const session = stripNullValues<OidcSession>({
            accessToken: callbackResult.tokens.accessToken,
            refreshToken: callbackResult.tokens.refreshToken,
            idToken: callbackResult.tokens.idToken,
            expiresAt: callbackResult.tokens.expiresIn
                ? Math.floor(Date.now() / 1000) + callbackResult.tokens.expiresIn
                : undefined,
            user: callbackResult.userInfo,
            organizationSlug: orgSlug,
        });

        // Store session via provider with UUID key
        const sessionId = randomUUID();
        await provider.storeSession(sessionId, session);

        // Set session cookie with the UUID
        const sessionCookieName = provider.getSessionCookieName(req);
        const sessionTtl = callbackResult.tokens.expiresIn ?? DEFAULT_SESSION_TTL;
        this.setCookie(res, sessionCookieName, sessionId, { maxAge: sessionTtl });

        // Clear transient state from provider store and cookie
        if (stateId) {
            await provider.clearState(stateId);
        }
        this.clearCookieByName(res, stateCookieName);

        // Redirect to original URL or default (P4)
        res.redirect(sessionState.returnTo || "/");
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
        const sessionId = this.parseCookieByName(req, cookieName);

        // Get session for token revocation (may be undefined if expired)
        const session = sessionId ? await provider.getSession(sessionId) : undefined;

        await this.onLogout(req, res);

        // Best-effort token revocation (don't fail if revocation fails)
        if (session?.accessToken) {
            try {
                await provider.revokeToken(session.accessToken, "access_token");
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
     * Returns user claims only — never exposes tokens to the client.
     */
    async handleMe(req: Request, res: Response): Promise<void> {
        const provider = await this.getProvider(req);
        const cookieName = provider.getSessionCookieName(req);
        const sessionId = this.parseCookieByName(req, cookieName);

        // No session cookie or session not found → 401
        const session = sessionId ? await provider.getSession(sessionId) : undefined;

        if (!session) {
            res.status(401).json({
                success: false,
                error: { code: "no_session", message: "No active session" },
            });
            return;
        }

        this.ok(res, {
            user: session.user,
            expiresAt: session.expiresAt,
        });
    }

    /**
     * POST {prefix}/refresh — Refreshes tokens using stored refresh token.
     *
     * 1. Resolves provider and retrieves session
     * 2. Validates refresh token exists
     * 3. Calls provider.refreshToken()
     * 4. Stores updated session via provider.storeSession()
     * 5. Returns success with new expiry
     */
    async handleRefresh(req: Request, res: Response): Promise<void> {
        const provider = await this.getProvider(req);
        const cookieName = provider.getSessionCookieName(req);
        const sessionId = this.parseCookieByName(req, cookieName);

        if (!sessionId) {
            res.status(401).json({
                success: false,
                error: { code: "no_session", message: "No active session" },
            });
            return;
        }

        const session = await provider.getSession(sessionId);

        if (!session) {
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

        const newTokens = await provider.refreshToken(session.refreshToken);

        // Update session with new tokens — preserve old refresh token if new one not provided
        const updatedSession: OidcSession = {
            ...session,
            accessToken: newTokens.accessToken,
            refreshToken: newTokens.refreshToken ?? session.refreshToken,
            idToken: newTokens.idToken ?? session.idToken,
            expiresAt: newTokens.expiresIn
                ? Math.floor(Date.now() / 1000) + newTokens.expiresIn
                : session.expiresAt,
        };

        // Store updated session via provider (replaces existing entry by key)
        await provider.storeSession(sessionId, updatedSession);

        this.ok(res, {
            expiresAt: updatedSession.expiresAt,
            message: "Tokens refreshed",
        });
    }

    // -----------------------------------------------------------------------
    // Private cookie utilities
    // -----------------------------------------------------------------------

    /**
     * Parses a specific cookie value from the raw Cookie header.
     * Self-contained — does not require cookie-parser middleware.
     */
    private parseCookieByName(req: Request, name: string): string | undefined {
        const cookieHeader = req.headers?.cookie;
        if (!cookieHeader) return undefined;

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
     * Sets a cookie on the response with secure defaults.
     * Defaults: httpOnly, secure (production only), sameSite 'lax', path '/'.
     */
    private setCookie(
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
     */
    private clearCookieByName(res: Response, name: string): void {
        res.clearCookie(name, {
            httpOnly: true,
            secure: this.settings.isProduction(),
            sameSite: "lax",
            path: "/",
        });
    }
}

// ---------------------------------------------------------------------------
// Utility functions (module-level, not exported)
// ---------------------------------------------------------------------------

/**
 * Strips null and undefined values from an object.
 * Returns a new object with only defined, non-null values.
 *
 * Used to keep session storage clean — undefined token fields
 * (refreshToken, idToken) are not stored as keys.
 *
 * @param obj - Source object
 * @returns New object without null/undefined values
 */
function stripNullValues<T>(obj: T): T {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        if (value !== null && value !== undefined) {
            result[key] = value;
        }
    }
    return result as T;
}
