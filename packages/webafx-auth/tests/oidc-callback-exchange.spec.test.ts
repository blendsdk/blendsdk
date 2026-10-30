/**
 * Specification tests for callback exchange failures.
 *
 * A callback whose authorization-code exchange or ID-token verification fails
 * is a rejected sign-in, not a server fault: it must return a fixed `400`
 * with a stable code, create no session, and clear the spent PKCE state. These
 * tests drive the real provider against the in-process OIDC test server and
 * the controller against that provider, so the behavior is exercised end to
 * end.
 *
 * A failing case means the implementation is wrong, not the test.
 *
 * @packageDocumentation
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPair } from "jose";
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
class ExchangeTestController extends OidcAuthController {
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
        serviceName: "oidc-exchange-test",
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
 * Assert the fixed exchange-failure response and its side effects.
 *
 * @param res - Captured response double
 * @param provider - Provider whose state must be cleared
 * @param store - Session store that must hold no session
 */
async function expectExchangeFailure(
    res: MockRes,
    provider: OidcAuthProvider,
    store: Map<string, { value: unknown; expiresAt: number }>
): Promise<void> {
    expect(res._status).toBe(400);
    expect(res._json).toEqual({
        success: false,
        error: {
            code: "oidc_exchange_failed",
            message: "Sign-in could not be completed",
        },
    });
    expect(res._cookies["__oidc_session"]).toBeUndefined();
    expect(sessionKeys(store)).toHaveLength(0);
    expect(res._clearedCookies).toContain("__oidc_state");
    expect(await provider.getState(STATE_ID)).toBeUndefined();
}

// ---------------------------------------------------------------------------
// EXC-1 … EXC-5: failing exchanges
// ---------------------------------------------------------------------------

describe("Callback exchange failures — Specification Tests", () => {
    it("returns 400 and clears the state when the ID-token nonce does not match (EXC-1)", async () => {
        const server = await startServer();
        const { provider, store } = makeProvider(server);
        const controller = new ExchangeTestController(createMockSettings(), {});
        controller.provider = provider;

        const req = await prepareCallback(provider, server);
        server.idTokenClaims.nonce = "wrong-nonce";
        const res = createMockRes();
        await controller.handleCallback(req, res);

        await expectExchangeFailure(res, provider, store);
    });

    it("returns 400 when the ID token is signed by a rogue key (EXC-2)", async () => {
        const server = await startServer();
        const { provider, store } = makeProvider(server);
        const controller = new ExchangeTestController(createMockSettings(), {});
        controller.provider = provider;

        const req = await prepareCallback(provider, server);
        const rogue = await generateKeyPair("RS256");
        server.setIdTokenSigningKey(rogue.privateKey);
        const res = createMockRes();
        await controller.handleCallback(req, res);

        await expectExchangeFailure(res, provider, store);
    });

    it("returns 400 when the ID token key id is not in the JWKS (EXC-7)", async () => {
        const server = await startServer();
        const { provider, store } = makeProvider(server);
        const controller = new ExchangeTestController(createMockSettings(), {});
        controller.provider = provider;

        const req = await prepareCallback(provider, server);
        // A signed token whose kid is absent from the published JWKS, as after
        // a signing-key rotation the cached JWKS has not caught up with, or for
        // a forged token. Key selection must be a failed sign-in, not a 500.
        const rogue = await generateKeyPair("RS256");
        server.setIdTokenSigningKey(rogue.privateKey);
        server.setIdTokenKeyId("unknown-key-id");
        const res = createMockRes();
        await controller.handleCallback(req, res);

        await expectExchangeFailure(res, provider, store);
    });

    it("returns 400 when the ID token is expired (EXC-3)", async () => {
        const server = await startServer();
        const { provider, store } = makeProvider(server);
        const controller = new ExchangeTestController(createMockSettings(), {});
        controller.provider = provider;

        const req = await prepareCallback(provider, server);
        server.idTokenClaims.exp = Math.floor(Date.now() / 1000) - 3600;
        const res = createMockRes();
        await controller.handleCallback(req, res);

        await expectExchangeFailure(res, provider, store);
    });

    it("returns 400 when the authorization code is invalid or expired (EXC-4)", async () => {
        const server = await startServer();
        server.setTokenError({
            error: "invalid_grant",
            error_description: "authorization code expired",
        });
        const { provider, store } = makeProvider(server);
        const controller = new ExchangeTestController(createMockSettings(), {});
        controller.provider = provider;

        const req = await prepareCallback(provider, server);
        const res = createMockRes();
        await controller.handleCallback(req, res);

        await expectExchangeFailure(res, provider, store);
    });

    it("never echoes the upstream error text (EXC-5)", async () => {
        const server = await startServer();
        server.setTokenError({
            error: "invalid_grant",
            error_description: "authorization code expired",
        });
        const { provider } = makeProvider(server);
        const controller = new ExchangeTestController(createMockSettings(), {});
        controller.provider = provider;

        const req = await prepareCallback(provider, server);
        const res = createMockRes();
        await controller.handleCallback(req, res);

        const body = JSON.stringify(res._json);
        expect(body).not.toContain("invalid_grant");
        expect(body).not.toContain("authorization code expired");
        expect(body).not.toContain("test-access-token");
    });

    // -----------------------------------------------------------------------
    // EXC-6: success regression
    // -----------------------------------------------------------------------

    it("completes a valid callback unchanged (EXC-6)", async () => {
        const server = await startServer();
        const { provider, store } = makeProvider(server);
        const controller = new ExchangeTestController(createMockSettings(), {});
        controller.provider = provider;

        const req = await prepareCallback(provider, server);
        const res = createMockRes();
        await controller.handleCallback(req, res);

        expect(res._status).toBe(200);
        expect(res._cookies["__oidc_session"]).toBeDefined();
        expect(sessionKeys(store)).toHaveLength(1);
        expect(res._redirect).toBe("/");
        expect(await provider.getState(STATE_ID)).toBeUndefined();
    });
});
