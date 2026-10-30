/**
 * Specification tests for UserInfo subject verification.
 *
 * OpenID Connect Core 1.0 §5.3.2 requires the UserInfo `sub` to equal the ID
 * token `sub`; a mismatch means the response must not be used. These tests
 * drive the real provider against the in-process OIDC test server and the
 * controller against that provider, so the check is exercised end to end.
 *
 * A failing case means the implementation is wrong, not the test.
 *
 * @packageDocumentation
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

import { OidcAuthController } from "../src/oidc-auth-controller.js";
import { OidcAuthProvider } from "../src/oidc-auth-provider.js";
import type { OidcAuthConfig, OidcSessionState } from "../src/oidc-types.js";
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
class SubjectTestController extends OidcAuthController {
    /** Provider used for every handler call. */
    public provider!: OidcAuthProvider;

    /** Resolve the fixed provider instead of a service container. */
    protected async getProvider(_req: Request): Promise<OidcAuthProvider> {
        return this.provider;
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
    _clearedCookies: string[];
    _redirect?: string;
}

/** Create a response double that records status, cookies, JSON, and redirects. */
function createMockRes(): MockRes {
    const res: Record<string, unknown> = {
        _status: 200,
        _json: undefined,
        _cookies: {} as Record<string, string>,
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
        value: string
    ) {
        (this._cookies as Record<string, string>)[name] = value;
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
        serviceName: "oidc-subject-test",
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

/** Prepare a code exchange (nonce set on the server) and return its params. */
async function prepareExchange(
    provider: OidcAuthProvider,
    server: OidcTestServer
): Promise<{ codeVerifier: string; nonce: string; callbackUrl: string }> {
    const auth = await provider.buildAuthorizationUrl();
    server.idTokenClaims.nonce = auth.nonce;
    return {
        codeVerifier: auth.codeVerifier,
        nonce: auth.nonce,
        callbackUrl: `https://app.example.com/callback?code=test-code&state=${auth.state}`,
    };
}

/**
 * Prepare a callback request: build the authorization request, store the PKCE
 * state, and return a request carrying the state cookie.
 *
 * @param provider - Provider that owns the session store
 * @param server - Running in-process IdP
 * @param options - Optional nonce suppression for the no-ID-token path
 * @returns The callback request
 */
async function prepareCallback(
    provider: OidcAuthProvider,
    server: OidcTestServer,
    options: { omitNonce?: boolean } = {}
): Promise<Request> {
    const auth = await provider.buildAuthorizationUrl();
    server.idTokenClaims.nonce = auth.nonce;
    const state: OidcSessionState = {
        codeVerifier: auth.codeVerifier,
        state: auth.state,
        nonce: options.omitNonce ? (undefined as unknown as string) : auth.nonce,
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

// ---------------------------------------------------------------------------
// SUBJ-1: the verified subject is surfaced on OidcTokens
// ---------------------------------------------------------------------------

describe("UserInfo subject — Specification Tests", () => {
    it("exposes the verified ID-token subject on OidcTokens (SUBJ-1)", async () => {
        const server = await startServer();
        const { provider } = makeProvider(server);
        const params = await prepareExchange(provider, server);

        const tokens = await provider.exchangeCode(params);

        expect(tokens.subject).toBe("test-user-1");
    });

    // -----------------------------------------------------------------------
    // SUBJ-2 / SUBJ-3: matching and mismatching subjects
    // -----------------------------------------------------------------------

    it("completes sign-in and stores a session when the subjects match (SUBJ-2)", async () => {
        const server = await startServer();
        const { provider, store } = makeProvider(server);
        const controller = new SubjectTestController(createMockSettings(), {});
        controller.provider = provider;

        const req = await prepareCallback(provider, server);
        const res = createMockRes();
        await controller.handleCallback(req, res);

        expect(res._status).toBe(200);
        expect(res._cookies["__oidc_session"]).toBeDefined();
        const stored = sessionKeys(store);
        expect(stored).toHaveLength(1);
    });

    it("rejects a mismatched UserInfo subject with 400 and creates no session (SUBJ-3)", async () => {
        const server = await startServer();
        server.setUserInfoSubject("a-different-user");
        const { provider, store } = makeProvider(server);
        const controller = new SubjectTestController(createMockSettings(), {});
        controller.provider = provider;

        const req = await prepareCallback(provider, server);
        const res = createMockRes();
        await controller.handleCallback(req, res);

        expect(res._status).toBe(400);
        expect(res._json).toMatchObject({
            success: false,
            error: { code: "userinfo_subject_mismatch" },
        });
        expect(res._cookies["__oidc_session"]).toBeUndefined();
        expect(sessionKeys(store)).toHaveLength(0);
        expect(res._clearedCookies).toContain("__oidc_state");
        expect(await provider.getState(STATE_ID)).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // SUBJ-4: explicit opt-out
    // -----------------------------------------------------------------------

    it("accepts a mismatch when verifyUserInfoSubject is false (SUBJ-4)", async () => {
        const server = await startServer();
        server.setUserInfoSubject("a-different-user");
        const { provider, store } = makeProvider(server, {
            verifyUserInfoSubject: false,
        });
        const controller = new SubjectTestController(createMockSettings(), {});
        controller.provider = provider;

        const req = await prepareCallback(provider, server);
        const res = createMockRes();
        await controller.handleCallback(req, res);

        expect(res._status).toBe(200);
        expect(res._cookies["__oidc_session"]).toBeDefined();
        expect(sessionKeys(store)).toHaveLength(1);
    });

    // -----------------------------------------------------------------------
    // SUBJ-5: unverified ID token skips the check with a warning
    // -----------------------------------------------------------------------

    it("skips the check and warns once when signature verification is disabled (SUBJ-5)", async () => {
        const server = await startServer();
        server.setUserInfoSubject("a-different-user");
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { provider, store } = makeProvider(server, {
            verifyIdTokenSignature: false,
        });
        const controller = new SubjectTestController(createMockSettings(), {});
        controller.provider = provider;

        const req = await prepareCallback(provider, server);
        const res = createMockRes();
        await controller.handleCallback(req, res);

        expect(res._status).toBe(200);
        expect(res._cookies["__oidc_session"]).toBeDefined();
        expect(sessionKeys(store)).toHaveLength(1);
        // The insecure-transport warning also fires on this provider; isolate
        // the subject warning by message and require exactly one.
        const subjectWarnings = warn.mock.calls
            .map(([message]) => String(message))
            .filter((message) => message.toLowerCase().includes("subject"));
        expect(subjectWarnings).toHaveLength(1);
        warn.mockRestore();
    });

    // -----------------------------------------------------------------------
    // SUBJ-6: the multi-tenant config path still enforces the check
    // -----------------------------------------------------------------------

    it("enforces the check when a per-request config supplies the tenant (SUBJ-6)", async () => {
        const server = await startServer();
        server.setUserInfoSubject("a-different-user");
        const tenantConfig: OidcAuthConfig = {
            serviceName: "oidc-subject-tenant",
            issuerUrl: server.issuer,
            clientId: "test-client",
            clientSecret: "test-secret",
            redirectUri: "https://app.example.com/callback",
            transport: { allowInsecureRequests: true },
        };
        const { provider, store } = makeProvider(server, {
            configFactory: async () => tenantConfig,
        });
        const controller = new SubjectTestController(createMockSettings(), {});
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
    // SUBJ-7: no ID token means no subject and the check is skipped
    // -----------------------------------------------------------------------

    it("skips the check without warning when the exchange returns no ID token (SUBJ-7)", async () => {
        const server = await startServer();
        server.setUserInfoSubject("a-different-user");
        server.setIdToken(null);
        const { provider, store } = makeProvider(server);
        const controller = new SubjectTestController(createMockSettings(), {});
        controller.provider = provider;
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const req = await prepareCallback(provider, server, { omitNonce: true });
        const res = createMockRes();
        await controller.handleCallback(req, res);

        expect(res._status).toBe(200);
        expect(res._cookies["__oidc_session"]).toBeDefined();
        expect(sessionKeys(store)).toHaveLength(1);
        // No ID token means nothing to verify, so no downgrade warning.
        expect(
            warn.mock.calls
                .map(([message]) => String(message))
                .filter((message) => message.toLowerCase().includes("subject"))
        ).toHaveLength(0);
        warn.mockRestore();
    });
});
