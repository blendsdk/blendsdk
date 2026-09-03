/**
 * Specification tests for OidcAuthController DI-based refactor.
 *
 * These tests verify behavior specified in:
 * - ST-19 through ST-27 from plans/auth-plugin-refactor/07-testing-strategy.md
 * - 05-controller-refactor.md (technical specification)
 *
 * Each test traces to a specific specification test case (ST-#) and
 * its source requirement. Expectations are derived from the specification
 * documents — NOT from the implementation.
 *
 * Tests verify the REFACTORED controller behavior where:
 * - Provider is resolved from DI (req.services.get) instead of createProvider()
 * - Session/state CRUD is delegated to provider methods
 * - Cookie name resolution is delegated to provider methods
 * - No abstract methods (getConfig, getSessionStore removed)
 *
 * @remarks Written BEFORE refactoring (red phase). All tests should FAIL
 * against the current implementation.
 * @packageDocumentation
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

import { OidcAuthController } from "../src/oidc-auth-controller.js";
import type { OidcAuthProvider } from "../src/oidc-auth-provider.js";
import type { OidcAuthConfig, OidcTokens, OidcSession, OidcSessionState } from "../src/oidc-types.js";
import { createMockCacheProvider, createSampleSession } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Mock Infrastructure
// ---------------------------------------------------------------------------

/** Base config for the test subclass (satisfies current abstract methods) */
const BASE_CONFIG: OidcAuthConfig = {
    issuerUrl: "https://auth.example.com",
    clientId: "test-client",
    clientSecret: "test-secret",
    redirectUri: "https://app.example.com/api/oidc/callback",
};

/** Mock settings with isProduction() and get() */
function createMockSettings(): any {
    return {
        isProduction: () => false,
        get: (_key: string, defaultValue?: unknown) => defaultValue,
    };
}

/**
 * Creates a mock OidcAuthProvider with spied session/state CRUD methods
 * and BFF methods for DI-based controller tests.
 *
 * Session data is set up ONLY on this mock — if the controller doesn't
 * resolve it from DI, the data won't be found.
 */
function createMockProviderForDI(): OidcAuthProvider {
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
        // Session CRUD — delegated from controller after refactor
        storeSession: vi.fn().mockResolvedValue(undefined),
        getSession: vi.fn().mockResolvedValue(undefined),
        clearSession: vi.fn().mockResolvedValue(undefined),
        // State CRUD — delegated from controller after refactor
        storeState: vi.fn().mockResolvedValue(undefined),
        getState: vi.fn().mockResolvedValue(undefined),
        clearState: vi.fn().mockResolvedValue(undefined),
        // Cookie name resolution — delegated from controller after refactor
        getSessionCookieName: vi.fn().mockReturnValue("__oidc_session"),
        getStateCookieName: vi.fn().mockReturnValue("__oidc_state"),
        // Redirect URI — used by controller to build callback URL for code exchange
        getRedirectUri: vi.fn().mockReturnValue("https://app.example.com/api/oidc/callback"),
        // Auth lifecycle
        authenticate: vi.fn(),
        validate: vi.fn(),
        health: vi.fn().mockResolvedValue(true),
        shutdown: vi.fn().mockResolvedValue(undefined),
    } as unknown as OidcAuthProvider;
}

/**
 * Creates a mock Request with the DI provider on req.services.
 * The provider is resolved via req.services.get('auth').
 */
function createRequestWithDI(
    provider: OidcAuthProvider,
    overrides?: { cookie?: string; query?: Record<string, string> },
): Request {
    const headers: Record<string, string | undefined> = {};
    if (overrides?.cookie) {
        headers.cookie = overrides.cookie;
    }
    return {
        query: overrides?.query ?? {},
        headers,
        services: {
            get: vi.fn((name: string) => {
                if (name === "auth") return provider;
                throw new Error(`Service '${name}' not registered`);
            }),
        },
    } as unknown as Request;
}

/** Creates a mock Response with spied methods and captured state */
function createMockRes(): Response & {
    _json?: unknown;
    _status?: number;
    _redirect?: string;
    _cookies: Record<string, { value: string; options: unknown }>;
    _clearedCookies: string[];
} {
    const res: any = {
        _json: undefined,
        _status: 200,
        _redirect: undefined,
        _cookies: {} as Record<string, { value: string; options: unknown }>,
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
        cookie: vi.fn().mockImplementation(function (this: any, name: string, value: string, opts: unknown) {
            this._cookies[name] = { value, options: opts };
        }),
        clearCookie: vi.fn().mockImplementation(function (this: any, name: string) {
            this._clearedCookies.push(name);
        }),
    };
    return res as any;
}

// ---------------------------------------------------------------------------
// Test Controller Subclass
// ---------------------------------------------------------------------------

/**
 * Minimal test subclass satisfying current abstract methods.
 *
 * After refactor: abstract methods (getConfig, getSessionStore) are removed,
 * so this subclass will have no required overrides — only hook overrides.
 *
 * Session data for these tests is set up on the DI provider mock, NOT in the
 * internal cache returned by getSessionStore(). This ensures tests verify that
 * the controller resolves the provider from DI.
 */
class TestOidcController extends OidcAuthController {
    // Satisfies current abstract method — will be removed in refactor
    getConfig(): OidcAuthConfig {
        return BASE_CONFIG;
    }

    // Satisfies current abstract method — will be removed in refactor
    // Returns an EMPTY cache — session data is only on the DI provider
    protected getSessionStore() {
        return createMockCacheProvider().provider;
    }
}

// ---------------------------------------------------------------------------
// Specification Tests: DI-Based Controller Refactor
// ---------------------------------------------------------------------------

describe("Specification: OidcAuthController DI-Based Refactor", () => {
    let controller: TestOidcController;
    let diProvider: OidcAuthProvider;

    beforeEach(() => {
        controller = new TestOidcController(createMockSettings(), {});
        diProvider = createMockProviderForDI();
    });

    // -----------------------------------------------------------------------
    // ST-19: Provider Resolution from DI
    // -----------------------------------------------------------------------

    // Source: 05-controller-refactor.md — R5, getProvider(req) uses req.services.get('auth')
    it("ST-19: should resolve provider from req.services.get('auth') during handler execution", async () => {
        // Set up: session data on DI provider only
        const session = createSampleSession();
        vi.mocked(diProvider.getSession).mockResolvedValue(session);

        const req = createRequestWithDI(diProvider, {
            cookie: "__oidc_session=sess-123",
        });
        const res = createMockRes();

        await controller.handleMe(req, res);

        // The DI service container should have been queried for 'auth'
        expect(req.services.get).toHaveBeenCalledWith("auth");
    });

    // -----------------------------------------------------------------------
    // ST-20: Route Definitions
    // -----------------------------------------------------------------------

    // Source: 05-controller-refactor.md — R7, AR #5
    it("ST-20: should define 5 routes with correct HTTP methods and paths", () => {
        const routes = controller.routes();

        expect(routes).toHaveLength(5);

        // Extract path and method from each route
        const routeMap = routes.map((r) => ({
            path: r.path,
            method: r.method,
        }));

        // Login and callback are public (GET)
        expect(routeMap).toContainEqual({ path: "/api/oidc/login", method: "get" });
        expect(routeMap).toContainEqual({ path: "/api/oidc/callback", method: "get" });
        // Logout and refresh are secure (POST)
        expect(routeMap).toContainEqual({ path: "/api/oidc/logout", method: "post" });
        expect(routeMap).toContainEqual({ path: "/api/oidc/refresh", method: "post" });
        // Me is secure (GET)
        expect(routeMap).toContainEqual({ path: "/api/oidc/me", method: "get" });
    });

    // -----------------------------------------------------------------------
    // ST-21: handleMe with Valid Session
    // -----------------------------------------------------------------------

    // Source: 05-controller-refactor.md — R7, AR #5
    it("ST-21: should return 200 with user data when session exists in provider", async () => {
        const session = createSampleSession();
        vi.mocked(diProvider.getSession).mockResolvedValue(session);

        const req = createRequestWithDI(diProvider, {
            cookie: "__oidc_session=sess-123",
        });
        const res = createMockRes();

        await controller.handleMe(req, res);

        // Provider's getSession should be called with the session ID from cookie
        expect(diProvider.getSession).toHaveBeenCalledWith("sess-123");
        // Response should include user data (not 401)
        expect(res._status).not.toBe(401);
        expect(res._json).toBeDefined();
        const data = res._json as any;
        expect(data.data.user).toEqual(session.user);
    });

    // -----------------------------------------------------------------------
    // ST-22: handleMe without Session
    // -----------------------------------------------------------------------

    // Source: 05-controller-refactor.md — R7, AR #5
    it("ST-22: should return 401 when no session cookie is present", async () => {
        const req = createRequestWithDI(diProvider);
        const res = createMockRes();

        await controller.handleMe(req, res);

        expect(res._status).toBe(401);
    });

    // -----------------------------------------------------------------------
    // ST-23: handleLogout Clears Session via Provider
    // -----------------------------------------------------------------------

    // Source: 05-controller-refactor.md — R2
    it("ST-23: should clear session via provider.clearSession() and clear cookie on logout", async () => {
        const session = createSampleSession();
        vi.mocked(diProvider.getSession).mockResolvedValue(session);

        const req = createRequestWithDI(diProvider, {
            cookie: "__oidc_session=sess-to-delete",
        });
        const res = createMockRes();

        await controller.handleLogout(req, res);

        // Provider's clearSession should be called (not internal cache.delete)
        expect(diProvider.clearSession).toHaveBeenCalledWith("sess-to-delete");
        // Session cookie should be cleared
        expect(res._clearedCookies).toContain("__oidc_session");
        // Response should be 200
        expect(res._status).toBe(200);
    });

    // -----------------------------------------------------------------------
    // ST-24: handleRefresh Updates Session via Provider
    // -----------------------------------------------------------------------

    // Source: 05-controller-refactor.md — R2, AR #5
    it("ST-24: should refresh tokens and update session via provider.storeSession()", async () => {
        const session = createSampleSession({ refreshToken: "old-refresh-token" });
        vi.mocked(diProvider.getSession).mockResolvedValue(session);

        const req = createRequestWithDI(diProvider, {
            cookie: "__oidc_session=sess-to-refresh",
        });
        const res = createMockRes();

        await controller.handleRefresh(req, res);

        // Provider's getSession should be called to retrieve current session
        expect(diProvider.getSession).toHaveBeenCalledWith("sess-to-refresh");
        // Provider's refreshToken should be called with the old refresh token
        // (no config override arg — controller delegates without tenant config)
        expect(diProvider.refreshToken).toHaveBeenCalledWith("old-refresh-token");
        // Updated session should be stored via provider (not internal cache.set)
        expect(diProvider.storeSession).toHaveBeenCalledWith(
            "sess-to-refresh",
            expect.objectContaining({
                accessToken: "new-access-token",
            }),
        );
        // Response should be 200 with new expiry
        expect(res._status).toBe(200);
    });

    // -----------------------------------------------------------------------
    // ST-25: handleLogin Stores State via Provider
    // -----------------------------------------------------------------------

    // Source: 05-controller-refactor.md — R2
    it("ST-25: should store state via provider.storeState() and redirect to OIDC provider", async () => {
        const req = createRequestWithDI(diProvider, {
            query: { returnTo: "/dashboard" },
        });
        const res = createMockRes();

        await controller.handleLogin(req, res);

        // Provider's storeState should be called with UUID and state data
        expect(diProvider.storeState).toHaveBeenCalledWith(
            expect.any(String), // UUID generated by controller
            expect.objectContaining({
                codeVerifier: "mock-verifier",
                state: "mock-state",
                nonce: "mock-nonce",
                returnTo: "/dashboard",
            }),
        );
        // State cookie should be set (with the UUID value)
        expect(res._cookies["__oidc_state"]).toBeDefined();
        // Should redirect to authorization URL
        expect(res._redirect).toContain("https://auth.example.com/authorize");
    });

    // -----------------------------------------------------------------------
    // ST-26: handleCallback Stores Session and Clears State via Provider
    // -----------------------------------------------------------------------

    // Source: 05-controller-refactor.md — R2
    it("ST-26: should exchange code, store session via provider, and clear state on callback", async () => {
        // Set up: PKCE state data on provider
        const stateData: OidcSessionState = {
            codeVerifier: "mock-verifier",
            state: "mock-state",
            nonce: "mock-nonce",
            returnTo: "/dashboard",
        };
        vi.mocked(diProvider.getState).mockResolvedValue(stateData);

        const req = createRequestWithDI(diProvider, {
            query: { code: "auth-code", state: "mock-state" },
            cookie: "__oidc_state=state-uuid-123",
        });
        const res = createMockRes();

        await controller.handleCallback(req, res);

        // Provider's getState should retrieve the PKCE state by ID
        expect(diProvider.getState).toHaveBeenCalledWith("state-uuid-123");
        // Provider's storeSession should store the new session
        expect(diProvider.storeSession).toHaveBeenCalledWith(
            expect.any(String), // UUID generated by controller
            expect.objectContaining({
                accessToken: "mock-access-token",
                user: expect.objectContaining({ sub: "user-123" }),
            }),
        );
        // Provider's clearState should clean up transient state
        expect(diProvider.clearState).toHaveBeenCalledWith("state-uuid-123");
        // Session cookie should be set
        expect(res._cookies["__oidc_session"]).toBeDefined();
        // State cookie should be cleared
        expect(res._clearedCookies).toContain("__oidc_state");
        // Should redirect to returnTo
        expect(res._redirect).toBe("/dashboard");
    });

    // -----------------------------------------------------------------------
    // ST-27: No Abstract Methods
    // -----------------------------------------------------------------------

    // Source: 05-controller-refactor.md — R6, AR #1
    it("ST-27: should not require abstract method implementations in subclasses", () => {
        // After refactor, OidcAuthController should have no abstract methods.
        // getConfig and getSessionStore are removed from the base class entirely.
        // The class provides getProviderServiceName() as a concrete method.
        const prototype = OidcAuthController.prototype;

        // After refactor, getConfig and getSessionStore are removed — not on base prototype
        expect((prototype as any).getConfig).toBeUndefined();
        expect((prototype as any).getSessionStore).toBeUndefined();

        // The class provides getProviderServiceName as a concrete method (DI resolution)
        expect(typeof (prototype as any).getProviderServiceName).toBe("function");

        // A minimal subclass should instantiate and return the default service name
        const minimalController = new TestOidcController(createMockSettings(), {});
        expect((minimalController as any).getProviderServiceName()).toBe("auth");
    });
});
