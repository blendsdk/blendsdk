/**
 * Specification tests for UserInfo denial outcomes.
 *
 * When the UserInfo endpoint refuses the request with HTTP 403, the identity
 * provider authenticated the user but the application denies access. The
 * callback must never turn that into a server error: by default it returns a
 * fixed `403 userinfo_forbidden` with no session; with
 * `userInfoDenied: 'unauthorized-session'` it stores a session marked
 * `authorized: false` whose identity comes only from the verified ID token,
 * and redirects to `notAuthorizedPath`.
 *
 * A failing case means the implementation is wrong, not the test.
 *
 * @packageDocumentation
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

import { OidcAuthController } from "../src/oidc-auth-controller.js";
import { OidcAuthProvider } from "../src/oidc-auth-provider.js";
import type {
    OidcAuthConfig,
    OidcSession,
    OidcSessionState,
    OidcTokens,
} from "../src/oidc-types.js";
import { startOidcTestServer, type OidcTestServer } from "./oidc-test-server.js";
import { createMockCacheProvider } from "./test-helpers.js";

/** Running test providers, closed after each test. */
const servers: OidcTestServer[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** Start a plain-HTTP provider and register it for cleanup. */
async function startServer(): Promise<OidcTestServer> {
    const server = await startOidcTestServer();
    servers.push(server);
    return server;
}

/** The state id stored by the harness and read back from the state cookie. */
const STATE_ID = "state-1";

/** Controller fixed to a single provider instance, as WebAFX registers it. */
class ForbiddenTestController extends OidcAuthController {
    /** Provider used for every handler call. */
    public provider!: OidcAuthProvider;

    /** Resolve the fixed provider instead of a service container. */
    protected async getProvider(_req: Request): Promise<OidcAuthProvider> {
        return this.provider;
    }
}

/** Controller that counts onCallback runs, to assert the denied path skips it. */
class TrackingForbiddenController extends ForbiddenTestController {
    /** Number of times the success hook ran. */
    public callbackCalls = 0;

    /** Count hook runs and pass the payload through unchanged. */
    protected async onCallback(
        tokens: OidcTokens,
        userInfo: Record<string, unknown>,
        _req: Request,
        _res: Response
    ): Promise<{ tokens: OidcTokens; userInfo: Record<string, unknown> }> {
        this.callbackCalls += 1;
        return { tokens, userInfo };
    }
}

/** Mock settings double; cookie `secure` depends on production mode. */
function createMockSettings(): {
    isProduction: () => boolean;
    get: (key: string, def?: unknown) => unknown;
} {
    return {
        isProduction: () => false,
        get: (_key: string, defaultValue?: unknown) => defaultValue,
    };
}

/** Capturing Express response double. */
interface MockRes extends Response {
    _status: number;
    _json?: unknown;
    _cookies: Record<string, string>;
    _cookieOptions: Record<string, Record<string, unknown>>;
    _clearedCookies: string[];
    _redirect?: string;
}

/** Create a response double that records status, cookies, JSON, and redirects. */
function createMockRes(): MockRes {
    const res: Record<string, unknown> = {
        _status: 200,
        _json: undefined,
        _cookies: {} as Record<string, string>,
        _cookieOptions: {} as Record<string, Record<string, unknown>>,
        _clearedCookies: [] as string[],
        _redirect: undefined,
    };
    res.json = vi.fn(function (this: Record<string, unknown>, data: unknown) {
        this._json = data;
        return this;
    });
    res.status = vi.fn(function (this: Record<string, unknown>, code: number) {
        this._status = code;
        return this;
    });
    res.cookie = vi.fn(function (
        this: Record<string, unknown>,
        name: string,
        value: string,
        options: Record<string, unknown>
    ) {
        (this._cookies as Record<string, string>)[name] = value;
        (this._cookieOptions as Record<string, Record<string, unknown>>)[name] =
            options;
    });
    res.clearCookie = vi.fn(function (this: Record<string, unknown>, name: string) {
        (this._clearedCookies as string[]).push(name);
    });
    res.redirect = vi.fn(function (this: Record<string, unknown>, url: string) {
        this._redirect = url;
    });
    return res as unknown as MockRes;
}

/**
 * Build a provider bound to the test server.
 *
 * @param server - Running in-process IdP
 * @param overrides - Optional provider configuration overrides
 * @returns The provider plus its mock session store
 */
function makeProvider(
    server: OidcTestServer,
    overrides: Partial<OidcAuthConfig> = {}
): {
    provider: OidcAuthProvider;
    store: Map<string, { value: unknown; expiresAt: number }>;
} {
    const cache = createMockCacheProvider();
    const provider = new OidcAuthProvider({
        serviceName: "oidc-forbidden-test",
        issuerUrl: server.issuer,
        clientId: "test-client",
        clientSecret: "test-secret",
        redirectUri: "https://app.example.com/callback",
        transport: { allowInsecureRequests: true },
        sessionStore: cache.provider,
        ...overrides,
    });
    return { provider, store: cache.store };
}

/**
 * Prepare a callback request: build the authorization request, store the PKCE
 * state with the matching nonce, and return a request carrying the state
 * cookie.
 *
 * @param provider - Provider that owns the session store
 * @param server - Running in-process IdP
 * @returns The callback request
 */
async function prepareCallback(
    provider: OidcAuthProvider,
    server: OidcTestServer
): Promise<Request> {
    const auth = await provider.buildAuthorizationUrl();
    server.idTokenClaims.nonce = auth.nonce;
    const state: OidcSessionState = {
        codeVerifier: auth.codeVerifier,
        state: auth.state,
        nonce: auth.nonce,
    };
    await provider.storeState(STATE_ID, state);
    return {
        query: { code: "test-code", state: auth.state },
        headers: { cookie: `__oidc_state=${STATE_ID}` },
    } as unknown as Request;
}

/** Session-store keys for user sessions. */
function sessionKeys(
    store: Map<string, { value: unknown; expiresAt: number }>
): string[] {
    return [...store.keys()].filter((key) => key.startsWith("oidc:session:"));
}

/**
 * Read the single stored session.
 *
 * @param store - Mock session store
 * @returns The stored session value
 */
function readSession(
    store: Map<string, { value: unknown; expiresAt: number }>
): OidcSession {
    const keys = sessionKeys(store);
    expect(keys).toHaveLength(1);
    return store.get(keys[0])?.value as OidcSession;
}

/** Build a session-cookie request for the stored session. */
function sessionRequest(sessionId: string): Request {
    return {
        headers: { cookie: `__oidc_session=${sessionId}` },
    } as unknown as Request;
}

/** Read the session id from the single stored session key. */
function sessionIdOf(
    store: Map<string, { value: unknown; expiresAt: number }>
): string {
    const keys = sessionKeys(store);
    expect(keys).toHaveLength(1);
    return keys[0].slice("oidc:session:".length);
}

/**
 * Assert the fixed denial response and its side effects.
 *
 * @param res - Captured response double
 * @param provider - Provider whose state must be cleared
 * @param store - Session store that must hold no session
 */
async function expectForbidden(
    res: MockRes,
    provider: OidcAuthProvider,
    store: Map<string, { value: unknown; expiresAt: number }>
): Promise<void> {
    expect(res._status).toBe(403);
    expect(res._json).toEqual({
        success: false,
        error: {
            code: "userinfo_forbidden",
            message: "Access to this account is not permitted",
        },
    });
    expect(res._cookies["__oidc_session"]).toBeUndefined();
    expect(sessionKeys(store)).toHaveLength(0);
    expect(res._clearedCookies).toContain("__oidc_state");
    expect(await provider.getState(STATE_ID)).toBeUndefined();
}

// ---------------------------------------------------------------------------
// UIF-1 … UIF-3: default outcome and the unchanged mismatch path
// ---------------------------------------------------------------------------

describe("UserInfo denial — Specification Tests", () => {
    it("returns a fixed 403 and creates no session by default (UIF-1)", async () => {
        const server = await startServer();
        server.setUserInfoStatus(403);
        const { provider, store } = makeProvider(server);
        const controller = new ForbiddenTestController(createMockSettings(), {});
        controller.provider = provider;

        const req = await prepareCallback(provider, server);
        const res = createMockRes();
        await controller.handleCallback(req, res);

        await expectForbidden(res, provider, store);
    });

    it("returns the same fixed 403 when the endpoint sends a challenge (UIF-2)", async () => {
        const server = await startServer();
        server.setUserInfoStatus(403, { challenge: true });
        const { provider, store } = makeProvider(server);
        const controller = new ForbiddenTestController(createMockSettings(), {});
        controller.provider = provider;

        const req = await prepareCallback(provider, server);
        const res = createMockRes();
        await controller.handleCallback(req, res);

        await expectForbidden(res, provider, store);
    });

    it("keeps the subject mismatch at 400 (UIF-3)", async () => {
        const server = await startServer();
        server.setUserInfoSubject("a-different-user");
        const { provider, store } = makeProvider(server);
        const controller = new ForbiddenTestController(createMockSettings(), {});
        controller.provider = provider;

        const req = await prepareCallback(provider, server);
        const res = createMockRes();
        await controller.handleCallback(req, res);

        expect(res._status).toBe(400);
        expect(res._json).toMatchObject({
            success: false,
            error: { code: "userinfo_subject_mismatch" },
        });
        expect(sessionKeys(store)).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // UIF-4 / UIF-5: opt-in unauthorized session and /me
    // -----------------------------------------------------------------------

    it("stores an unauthorized session with allowlisted identity only (UIF-4)", async () => {
        const server = await startServer();
        server.setUserInfoStatus(403);
        server.idTokenClaims.email = "user@example.com";
        server.idTokenClaims.name = "Test User";
        server.idTokenClaims.role = "admin";
        const { provider, store } = makeProvider(server, {
            userInfoDenied: "unauthorized-session",
            notAuthorizedPath: "/not-authorized",
        });
        const controller = new TrackingForbiddenController(
            createMockSettings(),
            {}
        );
        controller.provider = provider;

        const req = await prepareCallback(provider, server);
        const res = createMockRes();
        await controller.handleCallback(req, res);

        expect(res._status).toBe(200);
        expect(res._cookies["__oidc_session"]).toBeDefined();
        expect(res._redirect).toBe("/not-authorized");
        expect(res._clearedCookies).toContain("__oidc_state");
        expect(await provider.getState(STATE_ID)).toBeUndefined();

        // The session cookie follows the provider session TTL (seconds -> ms).
        expect(res._cookieOptions["__oidc_session"].maxAge).toBe(
            provider.getSessionCookieTtl() * 1000
        );

        // The denied path never runs the success hook.
        expect(controller.callbackCalls).toBe(0);

        const session = readSession(store);
        expect(session.authorized).toBe(false);
        expect(session.accessToken).toBe("test-access-token");
        expect(session.expiresAt).toBeGreaterThan(
            Math.floor(Date.now() / 1000)
        );
        expect(session.user).toEqual({
            sub: "test-user-1",
            email: "user@example.com",
            name: "Test User",
        });
        expect(session.user.role).toBeUndefined();
    });

    it("returns the identity and authorized:false from /me (UIF-5)", async () => {
        const server = await startServer();
        server.setUserInfoStatus(403);
        const { provider, store } = makeProvider(server, {
            userInfoDenied: "unauthorized-session",
            csrf: { enabled: true },
        });
        const controller = new ForbiddenTestController(createMockSettings(), {});
        controller.provider = provider;

        const req = await prepareCallback(provider, server);
        const res = createMockRes();
        await controller.handleCallback(req, res);

        const meRes = createMockRes();
        await controller.handleMe(sessionRequest(sessionIdOf(store)), meRes);

        const data = (meRes._json as { data: Record<string, unknown> }).data;
        expect(data.authorized).toBe(false);
        expect(data.user).toMatchObject({ sub: "test-user-1" });
        expect(typeof data.csrfToken).toBe("string");
        expect(readSession(store).csrfToken).toBe(data.csrfToken);
    });

    it("returns authorized:true for a normal session (UIF-5)", async () => {
        const server = await startServer();
        const { provider, store } = makeProvider(server, {
            userInfoDenied: "unauthorized-session",
        });
        const controller = new ForbiddenTestController(createMockSettings(), {});
        controller.provider = provider;

        const req = await prepareCallback(provider, server);
        const res = createMockRes();
        await controller.handleCallback(req, res);

        const meRes = createMockRes();
        await controller.handleMe(sessionRequest(sessionIdOf(store)), meRes);

        const data = (meRes._json as { data: Record<string, unknown> }).data;
        expect(data.authorized).toBe(true);
    });

    it("keeps a denied session denied across a refresh (UIF-10)", async () => {
        const server = await startServer();
        server.setUserInfoStatus(403);
        const { provider, store } = makeProvider(server, {
            userInfoDenied: "unauthorized-session",
        });
        const controller = new ForbiddenTestController(createMockSettings(), {});
        controller.provider = provider;

        const req = await prepareCallback(provider, server);
        const res = createMockRes();
        await controller.handleCallback(req, res);

        const sessionId = sessionIdOf(store);
        const refreshRes = createMockRes();
        await controller.handleRefresh(sessionRequest(sessionId), refreshRes);

        expect(refreshRes._json).toMatchObject({
            success: true,
            data: { message: "Tokens refreshed" },
        });
        expect(readSession(store).authorized).toBe(false);

        const meRes = createMockRes();
        await controller.handleMe(sessionRequest(sessionId), meRes);
        const data = (meRes._json as { data: Record<string, unknown> }).data;
        expect(data.authorized).toBe(false);
    });

    // -----------------------------------------------------------------------
    // UIF-6 / UIF-7: fail-closed fallbacks
    // -----------------------------------------------------------------------

    it("falls back to the fixed 403 when signature verification is disabled (UIF-6)", async () => {
        const server = await startServer();
        server.setUserInfoStatus(403);
        const { provider, store } = makeProvider(server, {
            userInfoDenied: "unauthorized-session",
            verifyIdTokenSignature: false,
        });
        const controller = new ForbiddenTestController(createMockSettings(), {});
        controller.provider = provider;

        const req = await prepareCallback(provider, server);
        const res = createMockRes();
        await controller.handleCallback(req, res);

        await expectForbidden(res, provider, store);
    });

    it("falls back to the fixed 403 when the token has no string subject (UIF-7)", async () => {
        const server = await startServer();
        server.setUserInfoStatus(403);
        const { provider, store } = makeProvider(server, {
            userInfoDenied: "unauthorized-session",
            verifyUserInfoSubject: false,
        });
        const controller = new ForbiddenTestController(createMockSettings(), {});
        controller.provider = provider;

        const auth = await provider.buildAuthorizationUrl();
        server.idTokenClaims.nonce = auth.nonce;
        await provider.storeState(STATE_ID, {
            codeVerifier: auth.codeVerifier,
            state: auth.state,
            nonce: auth.nonce,
        });
        server.setIdToken(await server.signIdToken({ sub: 123 }));
        const req = {
            query: { code: "test-code", state: auth.state },
            headers: { cookie: `__oidc_state=${STATE_ID}` },
        } as unknown as Request;
        const res = createMockRes();
        await controller.handleCallback(req, res);

        await expectForbidden(res, provider, store);
    });

    // -----------------------------------------------------------------------
    // UIF-8 / UIF-9: guard-facing state and no leakage
    // -----------------------------------------------------------------------

    it("authenticates the denied session with authorized:false (UIF-8)", async () => {
        const server = await startServer();
        server.setUserInfoStatus(403);
        const { provider, store } = makeProvider(server, {
            userInfoDenied: "unauthorized-session",
        });
        const controller = new ForbiddenTestController(createMockSettings(), {});
        controller.provider = provider;

        const req = await prepareCallback(provider, server);
        const res = createMockRes();
        await controller.handleCallback(req, res);

        const result = await provider.authenticate(
            sessionRequest(sessionIdOf(store))
        );

        expect(result?.authorized).toBe(false);
        expect(result?.sub).toBe("test-user-1");
        expect(result?.principalType).toBe("user");
    });

    it("never echoes the endpoint text or the subject in the response (UIF-9)", async () => {
        const server = await startServer();
        server.setUserInfoStatus(403, { challenge: true });
        const { provider } = makeProvider(server);
        const controller = new ForbiddenTestController(createMockSettings(), {});
        controller.provider = provider;

        const req = await prepareCallback(provider, server);
        const res = createMockRes();
        await controller.handleCallback(req, res);

        const body = JSON.stringify(res._json);
        expect(body).not.toContain("insufficient_scope");
        expect(body).not.toContain("test-user-1");
        expect(body).not.toContain("test-access-token");
    });
});
