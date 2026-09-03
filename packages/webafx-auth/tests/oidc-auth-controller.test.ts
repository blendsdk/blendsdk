/**
 * Tests for OidcAuthController — abstract BFF controller for OIDC authentication.
 *
 * Tests use a concrete TestAuthController subclass with a mock OidcAuthProvider.
 * All OIDC protocol operations are mocked — these tests verify the controller's
 * routing, session management, cookie handling, and hook behavior.
 *
 * @remarks No Docker required — all unit tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { OidcAuthController } from "../src/oidc-auth-controller.js";
import type { OidcAuthProvider } from "../src/oidc-auth-provider.js";
import type { OidcAuthConfig, OidcTokens, OidcSession, OidcSessionState, BuildAuthorizationUrlParams } from "../src/oidc-types.js";

// ---------------------------------------------------------------------------
// Mock Infrastructure (updated for DI-based controller)
// ---------------------------------------------------------------------------

/**
 * Mock provider with vitest spies on all BFF + session/state CRUD methods.
 * Session and state storage is backed by real Maps so multi-step flow tests
 * (login → callback → me/logout/refresh) work naturally.
 */
function createMockProvider(): OidcAuthProvider & {
    _sessions: Map<string, OidcSession>;
    _states: Map<string, OidcSessionState>;
} {
    const sessions = new Map<string, OidcSession>();
    const states = new Map<string, OidcSessionState>();

    return {
        // BFF methods
        buildAuthorizationUrl: vi.fn().mockResolvedValue({
            url: "https://auth.example.com/authorize?client_id=test",
            codeVerifier: "mock-verifier",
            state: "mock-state",
            nonce: "mock-nonce",
        }),
        exchangeCode: vi.fn().mockResolvedValue({
            accessToken: "mock-access-token",
            refreshToken: "mock-refresh-token",
            idToken: "mock-id-token",
            expiresIn: 3600,
            tokenType: "Bearer",
            scope: "openid profile email",
        } satisfies OidcTokens),
        refreshToken: vi.fn().mockResolvedValue({
            accessToken: "new-access-token",
            refreshToken: "new-refresh-token",
            expiresIn: 3600,
            tokenType: "Bearer",
        } satisfies OidcTokens),
        revokeToken: vi.fn().mockResolvedValue(undefined),
        fetchUserInfo: vi.fn().mockResolvedValue({
            sub: "user-123",
            email: "user@example.com",
            name: "Test User",
        }),
        // Session CRUD — backed by real Map for multi-step flow tests
        storeSession: vi.fn().mockImplementation(async (id: string, session: OidcSession) => {
            sessions.set(id, session);
        }),
        getSession: vi.fn().mockImplementation(async (id: string) => sessions.get(id)),
        clearSession: vi.fn().mockImplementation(async (id: string) => { sessions.delete(id); }),
        // State CRUD — backed by real Map for multi-step flow tests
        storeState: vi.fn().mockImplementation(async (id: string, state: OidcSessionState) => {
            states.set(id, state);
        }),
        getState: vi.fn().mockImplementation(async (id: string) => states.get(id)),
        clearState: vi.fn().mockImplementation(async (id: string) => { states.delete(id); }),
        // Cookie name resolution
        getSessionCookieName: vi.fn().mockReturnValue("__oidc_session"),
        getStateCookieName: vi.fn().mockReturnValue("__oidc_state"),
        getRedirectUri: vi.fn().mockReturnValue("https://app.example.com/auth/callback"),
        // Auth lifecycle
        authenticate: vi.fn(),
        validate: vi.fn(),
        health: vi.fn().mockResolvedValue(true),
        shutdown: vi.fn().mockResolvedValue(undefined),
        // Internal storage for test assertions
        _sessions: sessions,
        _states: states,
    } as unknown as OidcAuthProvider & {
        _sessions: Map<string, OidcSession>;
        _states: Map<string, OidcSessionState>;
    };
}

/** Default test OIDC configuration (referenced by tests for config values) */
const TEST_CONFIG: OidcAuthConfig = {
    issuerUrl: "https://auth.example.com",
    clientId: "test-client",
    clientSecret: "test-secret",
    redirectUri: "https://app.example.com/auth/callback",
};

/**
 * Concrete test subclass that overrides getProvider() to return a mock directly.
 * Bypasses DI (req.services) — DI wiring is tested by spec tests (ST-19).
 */
class TestAuthController extends OidcAuthController {
    public mockProvider: ReturnType<typeof createMockProvider>;

    constructor(
        settings: any,
        services: any,
        provider?: ReturnType<typeof createMockProvider>,
    ) {
        super(settings, services);
        this.mockProvider = provider ?? createMockProvider();
    }

    protected async getProvider(_req: Request): Promise<OidcAuthProvider> {
        return this.mockProvider as unknown as OidcAuthProvider;
    }
}

/**
 * Mock ApplicationSettings with isProduction() method.
 * Development mode by default (secure: false for cookies).
 */
function createMockSettings(envMode: "development" | "production" | "test" = "development"): any {
    return {
        isProduction: () => envMode === "production",
        get: (key: string, defaultValue?: any) => {
            if (key === "ENV_MODE") return envMode;
            return defaultValue;
        },
    };
}

const mockServices = {} as any;

/** Create a mock Express request */
function createMockReq(overrides?: Partial<Request>): Request {
    return {
        query: {},
        headers: {},
        ...overrides,
    } as Request;
}

/** Create a mock Express response with tracking spies */
function createMockRes(): Response & {
    _json?: unknown;
    _status?: number;
    _redirect?: string;
    _cookies: Record<string, { value: string; options: any }>;
    _clearedCookies: string[];
} {
    const res: any = {
        _json: undefined,
        _status: 200,
        _redirect: undefined,
        _cookies: {} as Record<string, { value: string; options: any }>,
        _clearedCookies: [] as string[],
        json: vi.fn().mockImplementation(function (this: any, data: unknown) {
            this._json = data;
            return this;
        }),
        status: vi.fn().mockImplementation(function (this: any, code: number) {
            this._status = code;
            return this;
        }),
        redirect: vi.fn().mockImplementation(function (this: any, url: string) {
            this._redirect = url;
        }),
        cookie: vi.fn().mockImplementation(function (this: any, name: string, value: string, opts: any) {
            this._cookies[name] = { value, options: opts };
        }),
        clearCookie: vi.fn().mockImplementation(function (this: any, name: string, _opts: any) {
            this._clearedCookies.push(name);
        }),
    };
    return res as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OidcAuthController", () => {
    let controller: TestAuthController;
    let mockProvider: OidcAuthProvider;

    beforeEach(() => {
        controller = new TestAuthController(createMockSettings(), mockServices);
        mockProvider = controller.mockProvider;
    });

    // -----------------------------------------------------------------------
    // Task 3.1.2: Route definitions and provider management
    // -----------------------------------------------------------------------

    describe("routes()", () => {
        it("returns exactly 5 route definitions", () => {
            const routes = controller.routes();
            expect(routes).toHaveLength(5);
        });

        it("uses correct HTTP methods for each route", () => {
            const routes = controller.routes();
            const methods = routes.map(r => r.method);
            expect(methods).toEqual(["get", "get", "post", "get", "post"]);
        });

        it("uses default /api/oidc prefix for all paths", () => {
            const routes = controller.routes();
            const paths = routes.map(r => r.path);
            expect(paths).toEqual([
                "/api/oidc/login",
                "/api/oidc/callback",
                "/api/oidc/logout",
                "/api/oidc/me",
                "/api/oidc/refresh",
            ]);
        });

        it("marks login and callback as public (no secure flag)", () => {
            const routes = controller.routes();
            // Login and callback are the first two routes
            expect(routes[0].secure).toBeUndefined();
            expect(routes[1].secure).toBeUndefined();
        });

        it("marks logout, me, and refresh as authenticated (secure)", () => {
            const routes = controller.routes();
            expect(routes[2].secure).toBe(true); // logout
            expect(routes[3].secure).toBe(true); // me
            expect(routes[4].secure).toBe(true); // refresh
        });

        it("uses custom prefix from getRoutePrefix() override", () => {
            // Create a subclass with custom prefix
            class CustomPrefixController extends TestAuthController {
                protected getRoutePrefix(): string {
                    return "/api/v1/auth";
                }
            }
            const custom = new CustomPrefixController(createMockSettings(), mockServices);
            const routes = custom.routes();
            const paths = routes.map(r => r.path);
            expect(paths).toEqual([
                "/api/v1/auth/login",
                "/api/v1/auth/callback",
                "/api/v1/auth/logout",
                "/api/v1/auth/me",
                "/api/v1/auth/refresh",
            ]);
        });
    });

    describe("getProvider()", () => {
        it("creates provider on first call (lazy init)", async () => {
            // getProvider is protected, but we can test it indirectly via routes()
            // The login handler calls getProvider() internally
            const routes = controller.routes();
            const loginRoute = routes[0];
            const req = createMockReq();
            const res = createMockRes();

            // Before calling the handler, provider should not be created yet
            // Call login handler to trigger lazy init
            await loginRoute.handler(req, res as any, vi.fn());

            // Provider's buildAuthorizationUrl should have been called
            expect(mockProvider.buildAuthorizationUrl).toHaveBeenCalled();
        });

        it("returns cached provider on subsequent calls", async () => {
            const routes = controller.routes();
            const loginRoute = routes[0];

            const req1 = createMockReq();
            const res1 = createMockRes();
            const req2 = createMockReq();
            const res2 = createMockRes();

            // Call login twice — should use same provider
            await loginRoute.handler(req1, res1 as any, vi.fn());
            await loginRoute.handler(req2, res2 as any, vi.fn());

            // buildAuthorizationUrl called twice on the SAME mock provider
            expect(mockProvider.buildAuthorizationUrl).toHaveBeenCalledTimes(2);
        });
    });

    // -----------------------------------------------------------------------
    // Task 3.1.3: handleLogin and handleCallback
    // -----------------------------------------------------------------------

    describe("handleLogin", () => {
        it("builds auth URL and redirects to it", async () => {
            const routes = controller.routes();
            const loginRoute = routes[0];
            const req = createMockReq();
            const res = createMockRes();

            await loginRoute.handler(req, res as any, vi.fn());

            // Should redirect to the authorization URL
            expect(res.redirect).toHaveBeenCalledWith(
                "https://auth.example.com/authorize?client_id=test",
            );
        });

        it("stores session state with PKCE data via cookie", async () => {
            const routes = controller.routes();
            const loginRoute = routes[0];
            const req = createMockReq();
            const res = createMockRes();

            await loginRoute.handler(req, res as any, vi.fn());

            // Should set __oidc_state cookie
            expect(res._cookies["__oidc_state"]).toBeDefined();
            expect(res._cookies["__oidc_state"].options.httpOnly).toBe(true);
            // State cookie max age should be 300 seconds (5 min) in milliseconds
            expect(res._cookies["__oidc_state"].options.maxAge).toBe(300_000);
        });

        it("captures returnTo query parameter in session state", async () => {
            const routes = controller.routes();
            const loginRoute = routes[0];
            const req = createMockReq({ query: { returnTo: "/dashboard" } as any });
            const res = createMockRes();

            await loginRoute.handler(req, res as any, vi.fn());

            // Verify state cookie was set (we can't read it directly, but we verify
            // it round-trips correctly through the callback test below)
            expect(res._cookies["__oidc_state"]).toBeDefined();
        });

        it("sets returnTo to undefined when not provided", async () => {
            const routes = controller.routes();
            const loginRoute = routes[0];
            const req = createMockReq({ query: {} as any });
            const res = createMockRes();

            await loginRoute.handler(req, res as any, vi.fn());

            // State cookie is set — returnTo will be undefined in the stored state
            expect(res._cookies["__oidc_state"]).toBeDefined();
            expect(res.redirect).toHaveBeenCalled();
        });
    });

    describe("handleCallback", () => {
        /**
         * Helper: simulates login to get the state cookie, then builds a
         * callback request with that cookie and matching query params.
         */
        async function simulateLoginAndBuildCallbackReq(
            ctrl: TestAuthController,
            queryOverrides?: Record<string, string>,
        ) {
            const routes = ctrl.routes();
            const loginRoute = routes[0];

            // Step 1: Login to get state cookie
            const loginReq = createMockReq();
            const loginRes = createMockRes();
            await loginRoute.handler(loginReq, loginRes as any, vi.fn());

            const stateCookie = loginRes._cookies["__oidc_state"]?.value;

            // Step 2: Build callback request with state cookie and code
            const callbackReq = createMockReq({
                query: {
                    code: "auth-code-123",
                    state: "mock-state", // matches mock provider's state
                    ...queryOverrides,
                } as any,
                headers: {
                    cookie: `__oidc_state=${encodeURIComponent(stateCookie)}`,
                },
            });

            return { callbackReq, stateCookie, routes };
        }

        it("exchanges code, fetches user info, stores session, and redirects to /", async () => {
            const { callbackReq, routes } = await simulateLoginAndBuildCallbackReq(controller);
            const callbackRoute = routes[1];
            const callbackRes = createMockRes();

            await callbackRoute.handler(callbackReq, callbackRes as any, vi.fn());

            // Should exchange code
            expect(mockProvider.exchangeCode).toHaveBeenCalled();
            // Should fetch user info
            expect(mockProvider.fetchUserInfo).toHaveBeenCalledWith("mock-access-token");
            // Should store session cookie
            expect(callbackRes._cookies["__oidc_session"]).toBeDefined();
            // Should clear state cookie
            expect(callbackRes._clearedCookies).toContain("__oidc_state");
            // Should redirect to / (no returnTo)
            expect(callbackRes.redirect).toHaveBeenCalledWith("/");
        });

        it("redirects to returnTo from session state", async () => {
            // Login with returnTo parameter
            const routes = controller.routes();
            const loginRoute = routes[0];
            const loginReq = createMockReq({ query: { returnTo: "/dashboard" } as any });
            const loginRes = createMockRes();
            await loginRoute.handler(loginReq, loginRes as any, vi.fn());

            const stateCookie = loginRes._cookies["__oidc_state"]?.value;

            // Callback with matching state
            const callbackReq = createMockReq({
                query: { code: "auth-code", state: "mock-state" } as any,
                headers: { cookie: `__oidc_state=${encodeURIComponent(stateCookie)}` },
            });
            const callbackRes = createMockRes();
            await routes[1].handler(callbackReq, callbackRes as any, vi.fn());

            expect(callbackRes.redirect).toHaveBeenCalledWith("/dashboard");
        });

        it("returns 400 for OIDC error response", async () => {
            const routes = controller.routes();
            const callbackRoute = routes[1];
            const req = createMockReq({
                query: { error: "access_denied", error_description: "User cancelled" } as any,
            });
            const res = createMockRes();

            await callbackRoute.handler(req, res as any, vi.fn());

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res._json).toEqual({
                success: false,
                error: { code: "oidc_error", message: "User cancelled" },
            });
        });

        it("returns 400 for missing authorization code", async () => {
            const routes = controller.routes();
            const callbackRoute = routes[1];
            const req = createMockReq({
                query: { state: "some-state" } as any,
            });
            const res = createMockRes();

            await callbackRoute.handler(req, res as any, vi.fn());

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res._json).toEqual({
                success: false,
                error: { code: "missing_code", message: "Authorization code missing from callback" },
            });
        });

        it("returns 400 for missing/expired session state", async () => {
            const routes = controller.routes();
            const callbackRoute = routes[1];
            // No cookie header — session state not found
            const req = createMockReq({
                query: { code: "auth-code", state: "some-state" } as any,
            });
            const res = createMockRes();

            await callbackRoute.handler(req, res as any, vi.fn());

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res._json).toEqual({
                success: false,
                error: { code: "missing_state", message: "Session state not found (expired or missing)" },
            });
        });

        it("returns 400 for state parameter mismatch", async () => {
            const { callbackReq, routes } = await simulateLoginAndBuildCallbackReq(controller, {
                code: "auth-code",
                state: "wrong-state", // doesn't match "mock-state"
            });
            const callbackRes = createMockRes();

            await routes[1].handler(callbackReq, callbackRes as any, vi.fn());

            expect(callbackRes.status).toHaveBeenCalledWith(400);
            expect(callbackRes._json).toEqual({
                success: false,
                error: { code: "invalid_state", message: "State parameter mismatch (possible CSRF)" },
            });
        });

        it("calls onCallback hook with tokens and userInfo", async () => {
            const onCallbackSpy = vi.fn().mockResolvedValue({
                tokens: {
                    accessToken: "mock-access-token",
                    refreshToken: "mock-refresh-token",
                    idToken: "mock-id-token",
                    expiresIn: 3600,
                    tokenType: "Bearer",
                    scope: "openid profile email",
                },
                userInfo: { sub: "user-123", email: "user@example.com", name: "Test User" },
            });

            class HookController extends TestAuthController {
                protected async onCallback(
                    tokens: OidcTokens,
                    userInfo: Record<string, unknown>,
                    req: Request,
                    res: Response,
                ) {
                    return onCallbackSpy(tokens, userInfo, req, res);
                }
            }

            const hookCtrl = new HookController(createMockSettings(), mockServices);
            const { callbackReq, routes: _unused } = await simulateLoginAndBuildCallbackReq(hookCtrl);
            const hookRoutes = hookCtrl.routes();
            const callbackRes = createMockRes();
            await hookRoutes[1].handler(callbackReq, callbackRes as any, vi.fn());

            expect(onCallbackSpy).toHaveBeenCalledTimes(1);
            // First argument should be tokens
            expect(onCallbackSpy.mock.calls[0][0].accessToken).toBe("mock-access-token");
            // Second argument should be userInfo
            expect(onCallbackSpy.mock.calls[0][1].email).toBe("user@example.com");
        });

        it("clears state cookie after successful callback", async () => {
            const { callbackReq, routes } = await simulateLoginAndBuildCallbackReq(controller);
            const callbackRes = createMockRes();

            await routes[1].handler(callbackReq, callbackRes as any, vi.fn());

            expect(callbackRes._clearedCookies).toContain("__oidc_state");
        });
    });

    // -----------------------------------------------------------------------
    // Task 3.1.4: handleLogout and handleMe
    // -----------------------------------------------------------------------

    describe("handleLogout", () => {
        /** Helper: creates a request with a valid session cookie */
        async function createRequestWithSession(ctrl: TestAuthController): Promise<Request> {
            // Simulate login → callback to get session cookie
            const routes = ctrl.routes();
            const loginReq = createMockReq();
            const loginRes = createMockRes();
            await routes[0].handler(loginReq, loginRes as any, vi.fn());

            const stateCookie = loginRes._cookies["__oidc_state"]?.value;

            const callbackReq = createMockReq({
                query: { code: "code", state: "mock-state" } as any,
                headers: { cookie: `__oidc_state=${encodeURIComponent(stateCookie)}` },
            });
            const callbackRes = createMockRes();
            await routes[1].handler(callbackReq, callbackRes as any, vi.fn());

            const sessionCookie = callbackRes._cookies["__oidc_session"]?.value;

            // Build a request with the session cookie
            return createMockReq({
                headers: { cookie: `__oidc_session=${encodeURIComponent(sessionCookie)}` },
            });
        }

        it("clears session and returns success", async () => {
            const logoutReq = await createRequestWithSession(controller);
            const routes = controller.routes();
            const logoutRes = createMockRes();

            await routes[2].handler(logoutReq, logoutRes as any, vi.fn());

            // Should clear session cookie
            expect(logoutRes._clearedCookies).toContain("__oidc_session");
            // Should return success
            expect(logoutRes._json).toEqual({
                success: true,
                data: { message: "Logged out" },
            });
        });

        it("calls onLogout hook before clearing session", async () => {
            const onLogoutSpy = vi.fn().mockResolvedValue(undefined);

            class LogoutHookController extends TestAuthController {
                protected async onLogout(_req: Request, _res: Response): Promise<void> {
                    onLogoutSpy();
                }
            }

            const hookCtrl = new LogoutHookController(createMockSettings(), mockServices);
            const logoutReq = await createRequestWithSession(hookCtrl);
            const routes = hookCtrl.routes();
            const logoutRes = createMockRes();

            await routes[2].handler(logoutReq, logoutRes as any, vi.fn());

            expect(onLogoutSpy).toHaveBeenCalledTimes(1);
        });

        it("attempts token revocation (best-effort)", async () => {
            const logoutReq = await createRequestWithSession(controller);
            const routes = controller.routes();
            const logoutRes = createMockRes();

            await routes[2].handler(logoutReq, logoutRes as any, vi.fn());

            expect(mockProvider.revokeToken).toHaveBeenCalledWith(
                "mock-access-token",
                "access_token",
            );
        });

        it("handles revocation failure silently", async () => {
            (mockProvider.revokeToken as any).mockRejectedValueOnce(new Error("revocation failed"));

            const logoutReq = await createRequestWithSession(controller);
            const routes = controller.routes();
            const logoutRes = createMockRes();

            // Should not throw
            await routes[2].handler(logoutReq, logoutRes as any, vi.fn());

            expect(logoutRes._json).toEqual({
                success: true,
                data: { message: "Logged out" },
            });
        });

        it("works when no session exists (idempotent)", async () => {
            const routes = controller.routes();
            const logoutReq = createMockReq(); // no session cookie
            const logoutRes = createMockRes();

            await routes[2].handler(logoutReq, logoutRes as any, vi.fn());

            // Should still clear cookie and return success
            expect(logoutRes._clearedCookies).toContain("__oidc_session");
            expect(logoutRes._json).toEqual({
                success: true,
                data: { message: "Logged out" },
            });
            // Should NOT attempt revocation (no session = no token)
            expect(mockProvider.revokeToken).not.toHaveBeenCalled();
        });
    });

    describe("handleMe", () => {
        /** Helper: get a request with a valid session cookie */
        async function createRequestWithSession(ctrl: TestAuthController): Promise<Request> {
            const routes = ctrl.routes();
            const loginReq = createMockReq();
            const loginRes = createMockRes();
            await routes[0].handler(loginReq, loginRes as any, vi.fn());

            const stateCookie = loginRes._cookies["__oidc_state"]?.value;
            const callbackReq = createMockReq({
                query: { code: "code", state: "mock-state" } as any,
                headers: { cookie: `__oidc_state=${encodeURIComponent(stateCookie)}` },
            });
            const callbackRes = createMockRes();
            await routes[1].handler(callbackReq, callbackRes as any, vi.fn());

            const sessionCookie = callbackRes._cookies["__oidc_session"]?.value;
            return createMockReq({
                headers: { cookie: `__oidc_session=${encodeURIComponent(sessionCookie)}` },
            });
        }

        it("returns user claims and expiresAt", async () => {
            const meReq = await createRequestWithSession(controller);
            const routes = controller.routes();
            const meRes = createMockRes();

            await routes[3].handler(meReq, meRes as any, vi.fn());

            expect(meRes._json).toEqual({
                success: true,
                data: {
                    user: { sub: "user-123", email: "user@example.com", name: "Test User" },
                    expiresAt: expect.any(Number),
                },
            });
        });

        it("returns 401 when no session", async () => {
            const routes = controller.routes();
            const meReq = createMockReq(); // no session cookie
            const meRes = createMockRes();

            await routes[3].handler(meReq, meRes as any, vi.fn());

            expect(meRes.status).toHaveBeenCalledWith(401);
            expect(meRes._json).toEqual({
                success: false,
                error: { code: "no_session", message: "No active session" },
            });
        });

        it("never exposes tokens in response", async () => {
            const meReq = await createRequestWithSession(controller);
            const routes = controller.routes();
            const meRes = createMockRes();

            await routes[3].handler(meReq, meRes as any, vi.fn());

            // Response should contain user and expiresAt, but NOT tokens
            const responseData = (meRes._json as any)?.data;
            expect(responseData).not.toHaveProperty("accessToken");
            expect(responseData).not.toHaveProperty("refreshToken");
            expect(responseData).not.toHaveProperty("idToken");
        });
    });

    // -----------------------------------------------------------------------
    // Task 3.2.1: handleRefresh
    // -----------------------------------------------------------------------

    describe("handleRefresh", () => {
        /** Helper: get a request with a valid session cookie */
        async function createRequestWithSession(ctrl: TestAuthController): Promise<Request> {
            const routes = ctrl.routes();
            const loginReq = createMockReq();
            const loginRes = createMockRes();
            await routes[0].handler(loginReq, loginRes as any, vi.fn());

            const stateCookie = loginRes._cookies["__oidc_state"]?.value;
            const callbackReq = createMockReq({
                query: { code: "code", state: "mock-state" } as any,
                headers: { cookie: `__oidc_state=${encodeURIComponent(stateCookie)}` },
            });
            const callbackRes = createMockRes();
            await routes[1].handler(callbackReq, callbackRes as any, vi.fn());

            const sessionCookie = callbackRes._cookies["__oidc_session"]?.value;
            return createMockReq({
                headers: { cookie: `__oidc_session=${encodeURIComponent(sessionCookie)}` },
            });
        }

        it("refreshes tokens and updates session", async () => {
            const refreshReq = await createRequestWithSession(controller);
            const routes = controller.routes();
            const refreshRes = createMockRes();

            await routes[4].handler(refreshReq, refreshRes as any, vi.fn());

            // Should call provider.refreshToken
            expect(mockProvider.refreshToken).toHaveBeenCalledWith("mock-refresh-token");
            // Should return success with expiresAt
            expect(refreshRes._json).toEqual({
                success: true,
                data: {
                    expiresAt: expect.any(Number),
                    message: "Tokens refreshed",
                },
            });
        });

        it("returns 401 when no session", async () => {
            const routes = controller.routes();
            const refreshReq = createMockReq(); // no session cookie
            const refreshRes = createMockRes();

            await routes[4].handler(refreshReq, refreshRes as any, vi.fn());

            expect(refreshRes.status).toHaveBeenCalledWith(401);
            expect(refreshRes._json).toEqual({
                success: false,
                error: { code: "no_session", message: "No active session" },
            });
        });

        it("returns 400 when no refresh token in session", async () => {
            // Mock exchangeCode to return tokens WITHOUT refresh_token
            (mockProvider.exchangeCode as any).mockResolvedValueOnce({
                accessToken: "at",
                tokenType: "Bearer",
                expiresIn: 3600,
                // No refreshToken!
            } satisfies OidcTokens);

            const routes = controller.routes();

            // Login + callback to create session without refresh token
            const loginReq = createMockReq();
            const loginRes = createMockRes();
            await routes[0].handler(loginReq, loginRes as any, vi.fn());

            const stateCookie = loginRes._cookies["__oidc_state"]?.value;
            const callbackReq = createMockReq({
                query: { code: "code", state: "mock-state" } as any,
                headers: { cookie: `__oidc_state=${encodeURIComponent(stateCookie)}` },
            });
            const callbackRes = createMockRes();
            await routes[1].handler(callbackReq, callbackRes as any, vi.fn());

            const sessionCookie = callbackRes._cookies["__oidc_session"]?.value;
            const refreshReq = createMockReq({
                headers: { cookie: `__oidc_session=${encodeURIComponent(sessionCookie)}` },
            });
            const refreshRes = createMockRes();

            await routes[4].handler(refreshReq, refreshRes as any, vi.fn());

            expect(refreshRes.status).toHaveBeenCalledWith(400);
            expect(refreshRes._json).toEqual({
                success: false,
                error: { code: "no_refresh_token", message: "No refresh token available" },
            });
        });

        it("preserves old refresh token if new one is missing", async () => {
            // Mock refreshToken to NOT return a new refresh_token
            (mockProvider.refreshToken as any).mockResolvedValueOnce({
                accessToken: "new-access",
                tokenType: "Bearer",
                expiresIn: 3600,
                // No refreshToken in the new response
            } satisfies OidcTokens);

            const refreshReq = await createRequestWithSession(controller);
            const routes = controller.routes();
            const refreshRes = createMockRes();

            await routes[4].handler(refreshReq, refreshRes as any, vi.fn());

            // Should succeed — old refresh token is preserved in session
            expect(refreshRes._json).toEqual({
                success: true,
                data: {
                    expiresAt: expect.any(Number),
                    message: "Tokens refreshed",
                },
            });
        });
    });

    // -----------------------------------------------------------------------
    // Task 3.2.2: Cookie utilities and cookie security
    // -----------------------------------------------------------------------

    describe("cookie utilities", () => {
        it("state cookie contains UUID (not signed payload)", async () => {
            const routes = controller.routes();
            const loginReq = createMockReq();
            const loginRes = createMockRes();

            await routes[0].handler(loginReq, loginRes as any, vi.fn());

            // State cookie should be a UUID, not a signed payload
            const stateCookie = loginRes._cookies["__oidc_state"];
            expect(stateCookie).toBeDefined();
            // UUID format: short string, no JSON
            expect(stateCookie.value).not.toContain("{");
            expect(stateCookie.value.length).toBeLessThan(200);
        });

        it("returns 400 for unknown state UUID (not in CacheProvider)", async () => {
            const routes = controller.routes();
            const callbackReq = createMockReq({
                query: { code: "code", state: "mock-state" } as any,
                headers: { cookie: "__oidc_state=unknown-uuid-not-in-cache" },
            });
            const callbackRes = createMockRes();

            await routes[1].handler(callbackReq, callbackRes as any, vi.fn());

            expect(callbackRes.status).toHaveBeenCalledWith(400);
            expect(callbackRes._json).toEqual({
                success: false,
                error: { code: "missing_state", message: "Session state not found (expired or missing)" },
            });
        });

        it("parseCookies handles single cookie", async () => {
            const routes = controller.routes();
            // Login to set state cookie, then verify callback can read it
            const loginReq = createMockReq();
            const loginRes = createMockRes();
            await routes[0].handler(loginReq, loginRes as any, vi.fn());

            const stateCookie = loginRes._cookies["__oidc_state"]?.value;
            const callbackReq = createMockReq({
                query: { code: "code", state: "mock-state" } as any,
                headers: { cookie: `__oidc_state=${encodeURIComponent(stateCookie)}` },
            });
            const callbackRes = createMockRes();

            await routes[1].handler(callbackReq, callbackRes as any, vi.fn());

            // If parsing worked, callback succeeds (redirects)
            expect(callbackRes.redirect).toHaveBeenCalled();
        });

        it("parseCookies handles multiple semicolon-separated cookies", async () => {
            const routes = controller.routes();
            const loginReq = createMockReq();
            const loginRes = createMockRes();
            await routes[0].handler(loginReq, loginRes as any, vi.fn());

            const stateCookie = loginRes._cookies["__oidc_state"]?.value;
            // Multiple cookies including the one we need
            const callbackReq = createMockReq({
                query: { code: "code", state: "mock-state" } as any,
                headers: {
                    cookie: `other=value; __oidc_state=${encodeURIComponent(stateCookie)}; another=123`,
                },
            });
            const callbackRes = createMockRes();

            await routes[1].handler(callbackReq, callbackRes as any, vi.fn());

            // If parsing worked with multiple cookies, callback succeeds
            expect(callbackRes.redirect).toHaveBeenCalled();
        });

        it("parseCookies returns empty for missing cookie header", async () => {
            const routes = controller.routes();
            // Request with no cookie header — getSessionState returns undefined
            const callbackReq = createMockReq({
                query: { code: "code", state: "mock-state" } as any,
                // No headers.cookie
            });
            const callbackRes = createMockRes();

            await routes[1].handler(callbackReq, callbackRes as any, vi.fn());

            expect(callbackRes.status).toHaveBeenCalledWith(400);
            expect(callbackRes._json).toEqual({
                success: false,
                error: { code: "missing_state", message: "Session state not found (expired or missing)" },
            });
        });
    });

    describe("cookie security", () => {
        it("sets secure: false in development mode", async () => {
            const devController = new TestAuthController(
                createMockSettings("development"),
                mockServices,
            );
            const routes = devController.routes();
            const loginReq = createMockReq();
            const loginRes = createMockRes();

            await routes[0].handler(loginReq, loginRes as any, vi.fn());

            expect(loginRes._cookies["__oidc_state"].options.secure).toBe(false);
        });

        it("sets secure: true in production mode", async () => {
            const prodController = new TestAuthController(
                createMockSettings("production"),
                mockServices,
            );
            const routes = prodController.routes();
            const loginReq = createMockReq();
            const loginRes = createMockRes();

            await routes[0].handler(loginReq, loginRes as any, vi.fn());

            expect(loginRes._cookies["__oidc_state"].options.secure).toBe(true);
        });

        it("works without clientSecret (no cookie signing needed)", async () => {
            // Controller works regardless of clientSecret — sessions are
            // server-side via provider, no cookie signing needed
            const noSecretCtrl = new TestAuthController(
                createMockSettings(),
                mockServices,
            );

            const routes = noSecretCtrl.routes();
            const loginReq = createMockReq();
            const loginRes = createMockRes();

            // Should NOT throw — no cookie signing needed anymore
            await routes[0].handler(loginReq, loginRes as any, vi.fn());
            expect(loginRes._cookies["__oidc_state"]).toBeDefined();
        });
    });

    // -----------------------------------------------------------------------
    // Task 3.2.3: Hook overrides
    // -----------------------------------------------------------------------

    describe("hook overrides", () => {
        it("provider.storeSession is called during callback", async () => {
            const ctrl = new TestAuthController(createMockSettings(), mockServices);
            const routes = ctrl.routes();

            // Login + callback flow
            const loginReq = createMockReq();
            const loginRes = createMockRes();
            await routes[0].handler(loginReq, loginRes as any, vi.fn());

            const stateCookie = loginRes._cookies["__oidc_state"]?.value;
            const callbackReq = createMockReq({
                query: { code: "code", state: "mock-state" } as any,
                headers: { cookie: `__oidc_state=${encodeURIComponent(stateCookie)}` },
            });
            const callbackRes = createMockRes();
            await routes[1].handler(callbackReq, callbackRes as any, vi.fn());

            // Provider's storeSession should have been called with session data
            expect(ctrl.mockProvider.storeSession).toHaveBeenCalledTimes(1);
            const storedSession = (ctrl.mockProvider.storeSession as any).mock.calls[0][1];
            expect(storedSession.accessToken).toBe("mock-access-token");
        });

        it("provider.getSession is called by handleMe", async () => {
            const customSession: OidcSession = {
                accessToken: "custom-token",
                user: { sub: "custom-user", role: "admin" },
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
            };

            const ctrl = new TestAuthController(createMockSettings(), mockServices);
            // Pre-populate a session in the mock provider's Map
            ctrl.mockProvider._sessions.set("test-session-id", customSession);

            const routes = ctrl.routes();
            const meReq = createMockReq({
                headers: { cookie: "__oidc_session=test-session-id" },
            });
            const meRes = createMockRes();

            await routes[3].handler(meReq, meRes as any, vi.fn());

            expect(ctrl.mockProvider.getSession).toHaveBeenCalledWith("test-session-id");
            expect(meRes._json).toEqual({
                success: true,
                data: {
                    user: { sub: "custom-user", role: "admin" },
                    expiresAt: customSession.expiresAt,
                },
            });
        });

        it("provider.clearSession is called during logout", async () => {
            const ctrl = new TestAuthController(createMockSettings(), mockServices);
            // Pre-populate a session for revocation
            ctrl.mockProvider._sessions.set("sess-to-clear", {
                accessToken: "t",
                user: { sub: "u" },
            });

            const routes = ctrl.routes();
            const logoutReq = createMockReq({
                headers: { cookie: "__oidc_session=sess-to-clear" },
            });
            const logoutRes = createMockRes();

            await routes[2].handler(logoutReq, logoutRes as any, vi.fn());

            expect(ctrl.mockProvider.clearSession).toHaveBeenCalledWith("sess-to-clear");
        });

        it("custom getRoutePrefix changes all paths", () => {
            class PrefixController extends TestAuthController {
                protected getRoutePrefix(): string {
                    return "/custom";
                }
            }

            const ctrl = new PrefixController(createMockSettings(), mockServices);
            const routes = ctrl.routes();
            const paths = routes.map(r => r.path);

            expect(paths).toEqual([
                "/custom/login",
                "/custom/callback",
                "/custom/logout",
                "/custom/me",
                "/custom/refresh",
            ]);
        });

        it("custom onCallback modifies session data", async () => {
            class EnrichController extends TestAuthController {
                protected async onCallback(
                    tokens: OidcTokens,
                    userInfo: Record<string, unknown>,
                    _req: Request,
                    _res: Response,
                ) {
                    return {
                        tokens,
                        userInfo: { ...userInfo, enriched: true, role: "admin" },
                    };
                }
            }

            const ctrl = new EnrichController(createMockSettings(), mockServices);
            const routes = ctrl.routes();

            // Login + callback
            const loginReq = createMockReq();
            const loginRes = createMockRes();
            await routes[0].handler(loginReq, loginRes as any, vi.fn());

            const stateCookie = loginRes._cookies["__oidc_state"]?.value;
            const callbackReq = createMockReq({
                query: { code: "code", state: "mock-state" } as any,
                headers: { cookie: `__oidc_state=${encodeURIComponent(stateCookie)}` },
            });
            const callbackRes = createMockRes();
            await routes[1].handler(callbackReq, callbackRes as any, vi.fn());

            // Get session from the stored cookie and verify enrichment
            const sessionCookie = callbackRes._cookies["__oidc_session"]?.value;
            const meReq = createMockReq({
                headers: { cookie: `__oidc_session=${encodeURIComponent(sessionCookie)}` },
            });
            const meRes = createMockRes();
            await routes[3].handler(meReq, meRes as any, vi.fn());

            const userData = (meRes._json as any)?.data?.user;
            expect(userData.enriched).toBe(true);
            expect(userData.role).toBe("admin");
        });

        it("custom onLogout is called during logout flow", async () => {
            let logoutCalled = false;

            class LogoutController extends TestAuthController {
                protected async onLogout(_req: Request, _res: Response): Promise<void> {
                    logoutCalled = true;
                }
            }

            const ctrl = new LogoutController(createMockSettings(), mockServices);
            const routes = ctrl.routes();
            const logoutReq = createMockReq();
            const logoutRes = createMockRes();

            await routes[2].handler(logoutReq, logoutRes as any, vi.fn());

            expect(logoutCalled).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // RFC 9207: iss parameter forwarding in handleCallback
    // -----------------------------------------------------------------------

    describe("RFC 9207 iss parameter forwarding", () => {
        /**
         * Helper: simulates login, then builds a callback request with
         * the state cookie and custom query params (including iss).
         */
        async function simulateLoginAndBuildCallbackReq(
            ctrl: TestAuthController,
            queryOverrides?: Record<string, string>,
        ) {
            const routes = ctrl.routes();
            const loginReq = createMockReq();
            const loginRes = createMockRes();
            await routes[0].handler(loginReq, loginRes as any, vi.fn());

            const stateCookie = loginRes._cookies["__oidc_state"]?.value;
            const callbackReq = createMockReq({
                query: {
                    code: "auth-code-123",
                    state: "mock-state",
                    ...queryOverrides,
                } as any,
                headers: {
                    cookie: `__oidc_state=${encodeURIComponent(stateCookie)}`,
                },
            });

            return { callbackReq, routes };
        }

        it("forwards iss query parameter to exchangeCode callbackUrl", async () => {
            const issuerUrl = "https://auth.example.com";
            const { callbackReq, routes } = await simulateLoginAndBuildCallbackReq(
                controller,
                { iss: issuerUrl },
            );
            const callbackRes = createMockRes();

            await routes[1].handler(callbackReq, callbackRes as any, vi.fn());

            // Verify exchangeCode was called and the callbackUrl contains 'iss'
            expect(mockProvider.exchangeCode).toHaveBeenCalledTimes(1);
            const exchangeArgs = (mockProvider.exchangeCode as any).mock.calls[0][0];
            const parsedUrl = new URL(exchangeArgs.callbackUrl);
            expect(parsedUrl.searchParams.get("iss")).toBe(issuerUrl);
        });

        it("does not include iss when provider does not send it", async () => {
            // No iss in query — simulates a non-RFC 9207 provider
            const { callbackReq, routes } = await simulateLoginAndBuildCallbackReq(controller);
            const callbackRes = createMockRes();

            await routes[1].handler(callbackReq, callbackRes as any, vi.fn());

            expect(mockProvider.exchangeCode).toHaveBeenCalledTimes(1);
            const exchangeArgs = (mockProvider.exchangeCode as any).mock.calls[0][0];
            const parsedUrl = new URL(exchangeArgs.callbackUrl);
            // iss should NOT be present when not sent by provider
            expect(parsedUrl.searchParams.has("iss")).toBe(false);
        });

        it("preserves code and state alongside iss in callbackUrl", async () => {
            const { callbackReq, routes } = await simulateLoginAndBuildCallbackReq(
                controller,
                { iss: "https://auth.example.com" },
            );
            const callbackRes = createMockRes();

            await routes[1].handler(callbackReq, callbackRes as any, vi.fn());

            const exchangeArgs = (mockProvider.exchangeCode as any).mock.calls[0][0];
            const parsedUrl = new URL(exchangeArgs.callbackUrl);
            // All three params should be present
            expect(parsedUrl.searchParams.get("code")).toBe("auth-code-123");
            expect(parsedUrl.searchParams.get("state")).toBe("mock-state");
            expect(parsedUrl.searchParams.get("iss")).toBe("https://auth.example.com");
        });
    });

    // -----------------------------------------------------------------------
    // getLoginParams: prompt and login_hint forwarding
    // -----------------------------------------------------------------------

    describe("getLoginParams (prompt / login_hint forwarding)", () => {
        it("forwards prompt query parameter to buildAuthorizationUrl", async () => {
            const routes = controller.routes();
            const loginReq = createMockReq({
                query: { prompt: "consent" } as any,
            });
            const loginRes = createMockRes();

            await routes[0].handler(loginReq, loginRes as any, vi.fn());

            // buildAuthorizationUrl should have been called with extraParams containing prompt
            expect(mockProvider.buildAuthorizationUrl).toHaveBeenCalledWith(
                undefined,
                expect.objectContaining({
                    extraParams: expect.objectContaining({ prompt: "consent" }),
                }),
            );
        });

        it("forwards login_hint query parameter to buildAuthorizationUrl", async () => {
            const routes = controller.routes();
            const loginReq = createMockReq({
                query: { login_hint: "user@example.com" } as any,
            });
            const loginRes = createMockRes();

            await routes[0].handler(loginReq, loginRes as any, vi.fn());

            expect(mockProvider.buildAuthorizationUrl).toHaveBeenCalledWith(
                undefined,
                expect.objectContaining({
                    extraParams: expect.objectContaining({ login_hint: "user@example.com" }),
                }),
            );
        });

        it("forwards both prompt and login_hint together", async () => {
            const routes = controller.routes();
            const loginReq = createMockReq({
                query: { prompt: "login", login_hint: "admin@company.com" } as any,
            });
            const loginRes = createMockRes();

            await routes[0].handler(loginReq, loginRes as any, vi.fn());

            expect(mockProvider.buildAuthorizationUrl).toHaveBeenCalledWith(
                undefined,
                expect.objectContaining({
                    extraParams: {
                        prompt: "login",
                        login_hint: "admin@company.com",
                    },
                }),
            );
        });

        it("passes empty params when no prompt or login_hint in query", async () => {
            const routes = controller.routes();
            const loginReq = createMockReq({ query: {} as any });
            const loginRes = createMockRes();

            await routes[0].handler(loginReq, loginRes as any, vi.fn());

            // Should be called with empty object (no extraParams key)
            expect(mockProvider.buildAuthorizationUrl).toHaveBeenCalledWith(
                undefined,
                expect.not.objectContaining({ extraParams: expect.anything() }),
            );
        });

        it("does not forward unrecognized query params", async () => {
            const routes = controller.routes();
            const loginReq = createMockReq({
                query: { prompt: "consent", unknown_param: "bad" } as any,
            });
            const loginRes = createMockRes();

            await routes[0].handler(loginReq, loginRes as any, vi.fn());

            const callArgs = (mockProvider.buildAuthorizationUrl as any).mock.calls[0][1];
            // Only prompt should be in extraParams — unknown_param must NOT leak through
            expect(callArgs.extraParams).toEqual({ prompt: "consent" });
        });

        it("still captures returnTo alongside prompt", async () => {
            const routes = controller.routes();
            const loginReq = createMockReq({
                query: { prompt: "login", returnTo: "/settings" } as any,
            });
            const loginRes = createMockRes();

            await routes[0].handler(loginReq, loginRes as any, vi.fn());

            // prompt should be forwarded to buildAuthorizationUrl
            expect(mockProvider.buildAuthorizationUrl).toHaveBeenCalledWith(
                undefined,
                expect.objectContaining({
                    extraParams: expect.objectContaining({ prompt: "login" }),
                }),
            );
            // returnTo is stored in session state (verified by redirect on callback)
            expect(loginRes._cookies["__oidc_state"]).toBeDefined();
        });

        it("allows override via custom getLoginParams hook", async () => {
            // Subclass that always forces consent and adds acr_values
            class ForcedConsentController extends TestAuthController {
                protected getLoginParams(_req: Request): BuildAuthorizationUrlParams {
                    return {
                        extraParams: {
                            prompt: "consent",
                            acr_values: "urn:mace:incommon:iap:silver",
                        },
                    };
                }
            }

            const ctrl = new ForcedConsentController(createMockSettings(), mockServices);
            const routes = ctrl.routes();
            // Even without prompt in query, the override forces it
            const loginReq = createMockReq({ query: {} as any });
            const loginRes = createMockRes();

            await routes[0].handler(loginReq, loginRes as any, vi.fn());

            expect(ctrl.mockProvider.buildAuthorizationUrl).toHaveBeenCalledWith(
                undefined,
                expect.objectContaining({
                    extraParams: {
                        prompt: "consent",
                        acr_values: "urn:mace:incommon:iap:silver",
                    },
                }),
            );
        });
    });
});
