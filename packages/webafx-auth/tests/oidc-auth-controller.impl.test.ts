/**
 * Implementation tests for OidcAuthController — edge cases and defensive behavior.
 *
 * These tests complement the specification tests (ST-13 through ST-34) by covering
 * edge cases: UUID format, CacheProvider race conditions, cookie option verification,
 * sanitizeOrgSlug boundary conditions, and stripNullValues behavior.
 *
 * @remarks No Docker required — all tests use mock CacheProvider.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { OidcAuthController } from "../src/oidc-auth-controller.js";
import type { OidcAuthProvider } from "../src/oidc-auth-provider.js";
import type { OidcAuthConfig, OidcTokens, OidcSession, OidcSessionState } from "../src/oidc-types.js";
import { createSampleSession } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Mock Infrastructure (updated for DI-based controller)
// ---------------------------------------------------------------------------

function createMockProvider(): OidcAuthProvider & {
    _sessions: Map<string, OidcSession>;
    _states: Map<string, OidcSessionState>;
} {
    const sessions = new Map<string, OidcSession>();
    const states = new Map<string, OidcSessionState>();

    return {
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
        storeSession: vi.fn().mockImplementation(async (id: string, session: OidcSession) => {
            sessions.set(id, session);
        }),
        getSession: vi.fn().mockImplementation(async (id: string) => sessions.get(id)),
        clearSession: vi.fn().mockImplementation(async (id: string) => { sessions.delete(id); }),
        storeState: vi.fn().mockImplementation(async (id: string, state: OidcSessionState) => {
            states.set(id, state);
        }),
        getState: vi.fn().mockImplementation(async (id: string) => states.get(id)),
        clearState: vi.fn().mockImplementation(async (id: string) => { states.delete(id); }),
        getSessionCookieName: vi.fn().mockReturnValue("__oidc_session"),
        getStateCookieName: vi.fn().mockReturnValue("__oidc_state"),
        getRedirectUri: vi.fn().mockReturnValue("https://app.example.com/api/oidc/callback"),
        authenticate: vi.fn(),
        validate: vi.fn(),
        health: vi.fn().mockResolvedValue(true),
        shutdown: vi.fn().mockResolvedValue(undefined),
        _sessions: sessions,
        _states: states,
    } as unknown as OidcAuthProvider & {
        _sessions: Map<string, OidcSession>;
        _states: Map<string, OidcSessionState>;
    };
}

const BASE_CONFIG: OidcAuthConfig = {
    issuerUrl: "https://auth.example.com",
    clientId: "test-client",
    clientSecret: "test-secret",
    redirectUri: "https://app.example.com/api/oidc/callback",
};

function createMockSettings(envMode: "development" | "production" = "development"): any {
    return {
        isProduction: () => envMode === "production",
        get: (key: string, defaultValue?: any) => {
            if (key === "ENV_MODE") return envMode;
            return defaultValue;
        },
    };
}

const mockServices = {} as any;

function createMockReq(overrides?: Partial<Request>): Request {
    return { query: {}, headers: {}, ...overrides } as Request;
}

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
// Test Controller
// ---------------------------------------------------------------------------

class ImplTestController extends OidcAuthController {
    public mockProvider: ReturnType<typeof createMockProvider>;
    private orgResolver?: (req: Request) => string | undefined;

    constructor(
        settings: any,
        services: any,
        options?: {
            provider?: ReturnType<typeof createMockProvider>;
            orgResolver?: (req: Request) => string | undefined;
        },
    ) {
        super(settings, services);
        this.mockProvider = options?.provider ?? createMockProvider();
        this.orgResolver = options?.orgResolver;
    }

    protected async getProvider(_req: Request): Promise<OidcAuthProvider> {
        return this.mockProvider as unknown as OidcAuthProvider;
    }

    protected resolveOrganization(req: Request): string | undefined {
        return this.orgResolver?.(req);
    }
}

// ---------------------------------------------------------------------------
// Edge Cases: UUID cookie values
// ---------------------------------------------------------------------------

describe("OidcAuthController — UUID cookie values", () => {
    let controller: ImplTestController;

    beforeEach(() => {
        controller = new ImplTestController(createMockSettings(), mockServices);
    });

    it("session cookie value is a short UUID-like string, not JSON", async () => {
        const routes = controller.routes();
        const loginReq = createMockReq();
        const loginRes = createMockRes();
        await routes[0].handler(loginReq, loginRes as any, vi.fn());

        const stateCookie = loginRes._cookies["__oidc_state"];
        expect(stateCookie.value.length).toBeLessThan(100);
        expect(stateCookie.value).not.toContain("{");
        expect(stateCookie.value).not.toContain("codeVerifier");
    });

    it("different logins produce different state UUIDs", async () => {
        const routes = controller.routes();

        const res1 = createMockRes();
        await routes[0].handler(createMockReq(), res1 as any, vi.fn());

        const res2 = createMockRes();
        await routes[0].handler(createMockReq(), res2 as any, vi.fn());

        expect(res1._cookies["__oidc_state"].value).not.toBe(
            res2._cookies["__oidc_state"].value,
        );
    });

    it("different callbacks produce different session UUIDs", async () => {
        const routes = controller.routes();

        // First flow
        const loginRes1 = createMockRes();
        await routes[0].handler(createMockReq(), loginRes1 as any, vi.fn());
        const state1 = loginRes1._cookies["__oidc_state"].value;
        const cbReq1 = createMockReq({
            query: { code: "code1", state: "mock-state" } as any,
            headers: { cookie: `__oidc_state=${state1}` },
        });
        const cbRes1 = createMockRes();
        await routes[1].handler(cbReq1, cbRes1 as any, vi.fn());

        // Second flow
        const loginRes2 = createMockRes();
        await routes[0].handler(createMockReq(), loginRes2 as any, vi.fn());
        const state2 = loginRes2._cookies["__oidc_state"].value;
        const cbReq2 = createMockReq({
            query: { code: "code2", state: "mock-state" } as any,
            headers: { cookie: `__oidc_state=${state2}` },
        });
        const cbRes2 = createMockRes();
        await routes[1].handler(cbReq2, cbRes2 as any, vi.fn());

        expect(cbRes1._cookies["__oidc_session"].value).not.toBe(
            cbRes2._cookies["__oidc_session"].value,
        );
    });
});

// ---------------------------------------------------------------------------
// Edge Cases: Cookie options verification
// ---------------------------------------------------------------------------

describe("OidcAuthController — cookie options", () => {
    it("state cookie has httpOnly, sameSite=lax, path=/", async () => {
        const controller = new ImplTestController(createMockSettings(), mockServices);
        const routes = controller.routes();
        const res = createMockRes();
        await routes[0].handler(createMockReq(), res as any, vi.fn());

        const opts = res._cookies["__oidc_state"].options;
        expect(opts.httpOnly).toBe(true);
        expect(opts.sameSite).toBe("lax");
        expect(opts.path).toBe("/");
    });

    it("session cookie has httpOnly, sameSite=lax, path=/", async () => {
        const controller = new ImplTestController(createMockSettings(), mockServices);
        const routes = controller.routes();

        // Login + callback
        const loginRes = createMockRes();
        await routes[0].handler(createMockReq(), loginRes as any, vi.fn());
        const stateVal = loginRes._cookies["__oidc_state"].value;

        const cbReq = createMockReq({
            query: { code: "code", state: "mock-state" } as any,
            headers: { cookie: `__oidc_state=${stateVal}` },
        });
        const cbRes = createMockRes();
        await routes[1].handler(cbReq, cbRes as any, vi.fn());

        const opts = cbRes._cookies["__oidc_session"].options;
        expect(opts.httpOnly).toBe(true);
        expect(opts.sameSite).toBe("lax");
        expect(opts.path).toBe("/");
    });

    it("production mode sets secure: true on all cookies", async () => {
        const controller = new ImplTestController(createMockSettings("production"), mockServices);
        const routes = controller.routes();

        const loginRes = createMockRes();
        await routes[0].handler(createMockReq(), loginRes as any, vi.fn());
        expect(loginRes._cookies["__oidc_state"].options.secure).toBe(true);

        const stateVal = loginRes._cookies["__oidc_state"].value;
        const cbReq = createMockReq({
            query: { code: "code", state: "mock-state" } as any,
            headers: { cookie: `__oidc_state=${stateVal}` },
        });
        const cbRes = createMockRes();
        await routes[1].handler(cbReq, cbRes as any, vi.fn());
        expect(cbRes._cookies["__oidc_session"].options.secure).toBe(true);
    });

    it("state cookie maxAge is 300 seconds (5 minutes)", async () => {
        const controller = new ImplTestController(createMockSettings(), mockServices);
        const routes = controller.routes();
        const res = createMockRes();
        await routes[0].handler(createMockReq(), res as any, vi.fn());

        expect(res._cookies["__oidc_state"].options.maxAge).toBe(300_000);
    });
});

// ---------------------------------------------------------------------------
// Edge Cases: sanitizeOrgSlug boundary conditions
// ---------------------------------------------------------------------------

describe("OidcAuthController — resolveOrganization hook", () => {
    it("resolveOrganization returns undefined by default (single-tenant)", async () => {
        const controller = new ImplTestController(createMockSettings(), mockServices);
        const routes = controller.routes();
        const res = createMockRes();
        await routes[0].handler(createMockReq(), res as any, vi.fn());

        // Default cookie name — no org scoping
        expect(res._cookies["__oidc_state"]).toBeDefined();
    });

    it("resolveOrganization override is called during callback", async () => {
        const orgSpy = vi.fn().mockReturnValue("acme-corp");
        const controller = new ImplTestController(
            createMockSettings(),
            mockServices,
            { orgResolver: orgSpy },
        );
        const routes = controller.routes();

        // Login + callback flow
        const loginRes = createMockRes();
        await routes[0].handler(createMockReq(), loginRes as any, vi.fn());
        const stateVal = loginRes._cookies["__oidc_state"].value;

        const cbReq = createMockReq({
            query: { code: "code", state: "mock-state" } as any,
            headers: { cookie: `__oidc_state=${stateVal}` },
        });
        const cbRes = createMockRes();
        await routes[1].handler(cbReq, cbRes as any, vi.fn());

        // resolveOrganization should have been called during callback
        expect(orgSpy).toHaveBeenCalled();

        // The stored session should include the org slug
        const storeCall = vi.mocked(controller.mockProvider.storeSession).mock.calls[0];
        const session = storeCall[1] as OidcSession;
        expect(session.organizationSlug).toBe("acme-corp");
    });
});

// ---------------------------------------------------------------------------
// Edge Cases: CacheProvider errors during controller operations
// ---------------------------------------------------------------------------

describe("OidcAuthController — provider storage error handling", () => {
    it("handleLogin handles provider.storeState failure gracefully", async () => {
        const controller = new ImplTestController(createMockSettings(), mockServices);
        vi.mocked(controller.mockProvider.storeState).mockRejectedValueOnce(
            new Error("Redis write failed"),
        );

        const routes = controller.routes();
        const res = createMockRes();

        // handleLogin should propagate the error (Express error handler catches it)
        await expect(
            routes[0].handler(createMockReq(), res as any, vi.fn()),
        ).rejects.toThrow("Redis write failed");
    });

    it("handleMe handles provider.getSession failure gracefully", async () => {
        const controller = new ImplTestController(createMockSettings(), mockServices);
        vi.mocked(controller.mockProvider.getSession).mockRejectedValueOnce(
            new Error("Redis read failed"),
        );

        const routes = controller.routes();
        const req = createMockReq({
            headers: { cookie: "__oidc_session=some-id" },
        });
        const res = createMockRes();

        await expect(
            routes[3].handler(req, res as any, vi.fn()),
        ).rejects.toThrow("Redis read failed");
    });
});

// ---------------------------------------------------------------------------
// Edge Cases: stripNullValues behavior
// ---------------------------------------------------------------------------

describe("OidcAuthController — stripNullValues in callback", () => {
    it("strips null/undefined token fields at session level", async () => {
        const controller = new ImplTestController(createMockSettings(), mockServices);
        // Return tokens with no refreshToken/idToken
        vi.mocked(controller.mockProvider.exchangeCode).mockResolvedValue({
            accessToken: "at",
            tokenType: "Bearer",
            expiresIn: 3600,
            refreshToken: undefined,
            idToken: undefined,
        } as any);

        const routes = controller.routes();

        // Login
        const loginRes = createMockRes();
        await routes[0].handler(createMockReq(), loginRes as any, vi.fn());
        const stateVal = loginRes._cookies["__oidc_state"].value;

        // Callback
        const cbReq = createMockReq({
            query: { code: "code", state: "mock-state" } as any,
            headers: { cookie: `__oidc_state=${stateVal}` },
        });
        const cbRes = createMockRes();
        await routes[1].handler(cbReq, cbRes as any, vi.fn());

        // Verify stored session has no undefined token fields at top level
        const storeCalls = vi.mocked(controller.mockProvider.storeSession).mock.calls;
        expect(storeCalls).toHaveLength(1);
        const session = storeCalls[0][1] as OidcSession;

        expect(session.accessToken).toBe("at");
        expect("refreshToken" in session).toBe(false);
        expect("idToken" in session).toBe(false);
        // user is preserved as-is (not stripped)
        expect(session.user).toBeDefined();
    });

    it("preserves all non-null values in session", async () => {
        const controller = new ImplTestController(createMockSettings(), mockServices);
        vi.mocked(controller.mockProvider.fetchUserInfo).mockResolvedValue({
            sub: "user-123",
            email: "user@example.com",
            name: "Test User",
            roles: ["admin"],
        });

        const routes = controller.routes();
        const loginRes = createMockRes();
        await routes[0].handler(createMockReq(), loginRes as any, vi.fn());
        const stateVal = loginRes._cookies["__oidc_state"].value;

        const cbReq = createMockReq({
            query: { code: "code", state: "mock-state" } as any,
            headers: { cookie: `__oidc_state=${stateVal}` },
        });
        const cbRes = createMockRes();
        await routes[1].handler(cbReq, cbRes as any, vi.fn());

        const storeCalls = vi.mocked(controller.mockProvider.storeSession).mock.calls;
        expect(storeCalls).toHaveLength(1);
        const session = storeCalls[0][1] as OidcSession;

        expect(session.user).toEqual({
            sub: "user-123",
            email: "user@example.com",
            name: "Test User",
            roles: ["admin"],
        });
    });
});

// ---------------------------------------------------------------------------
// Edge Cases: Concurrent session operations
// ---------------------------------------------------------------------------

describe("OidcAuthController — concurrent operations", () => {
    it("two concurrent login flows get independent state entries", async () => {
        const controller = new ImplTestController(createMockSettings(), mockServices);
        const routes = controller.routes();

        const res1 = createMockRes();
        const res2 = createMockRes();

        // Fire two logins concurrently
        await Promise.all([
            routes[0].handler(createMockReq(), res1 as any, vi.fn()),
            routes[0].handler(createMockReq(), res2 as any, vi.fn()),
        ]);

        const id1 = res1._cookies["__oidc_state"].value;
        const id2 = res2._cookies["__oidc_state"].value;

        // Different UUIDs
        expect(id1).not.toBe(id2);
        // Both stored in provider's state Map
        expect(controller.mockProvider._states.has(id1)).toBe(true);
        expect(controller.mockProvider._states.has(id2)).toBe(true);
    });
});
