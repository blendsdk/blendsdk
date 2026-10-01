/**
 * Specification tests for OIDC session-id rotation on refresh.
 *
 * These tests encode the expected behavior from the requirement: when
 * `rotateSessionIdOnRefresh` is enabled, a successful token refresh moves the
 * session to a new opaque id and re-issues the cookie, so an id captured before
 * the refresh stops resolving. Failures leave the existing session and cookie
 * in place.
 *
 * A failing case means the implementation is wrong, not the test.
 *
 * @packageDocumentation
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

import { OidcAuthController } from "../src/oidc-auth-controller.js";
import { OidcAuthProvider } from "../src/oidc-auth-provider.js";
import type { OidcSession } from "../src/oidc-types.js";
import { createMockCacheProvider, createSampleSession } from "./test-helpers.js";

/** Default OIDC session cookie name. */
const SESSION_COOKIE = "__oidc_session";

/** Tokens returned by the stubbed refresh call. */
const REFRESHED_TOKENS = {
    accessToken: "refreshed-access-token",
    refreshToken: "refreshed-refresh-token",
    expiresIn: 3600,
    tokenType: "Bearer",
};

/** Minimal ApplicationSettings double (cookie `secure` depends on production). */
function createMockSettings(): { isProduction: () => boolean; get: (key: string, def?: unknown) => unknown } {
    return {
        isProduction: () => false,
        get: (_key: string, defaultValue?: unknown) => defaultValue,
    };
}

/** Create a request carrying a session cookie. */
function createCookieRequest(sessionId: string): Request {
    return {
        query: {},
        headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    } as unknown as Request;
}

/** Create a request with no cookie. */
function createEmptyRequest(): Request {
    return { query: {}, headers: {} } as unknown as Request;
}

/** Capturing Express response double. */
interface MockRes extends Response {
    _status: number;
    _json?: unknown;
    _cookies: Record<string, string>;
    _clearedCookies: string[];
}

/** Create a response double that records status, cookies, and JSON. */
function createMockRes(): MockRes {
    const res: Record<string, unknown> = {
        _status: 200,
        _json: undefined,
        _cookies: {} as Record<string, string>,
        _clearedCookies: [] as string[],
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
    return res as unknown as MockRes;
}

/** Controller fixed to a single provider instance. */
class RotationTestController extends OidcAuthController {
    public provider!: OidcAuthProvider;

    protected async getProvider(_req: Request): Promise<OidcAuthProvider> {
        return this.provider;
    }
}

/** Build a real provider backed by the mock cache, with a stubbed refresh call. */
function createProvider(options: { rotate: boolean }): OidcAuthProvider {
    const cache = createMockCacheProvider();
    const provider = new OidcAuthProvider({
        issuerUrl: "https://auth.example.com",
        clientId: "test-client",
        sessionStore: cache.provider,
        rotateSessionIdOnRefresh: options.rotate,
    });
    vi.spyOn(provider, "refreshToken").mockResolvedValue(REFRESHED_TOKENS);
    return provider;
}

/** Drive `handleRefresh` for a provider with the given request and response. */
function handleRefresh(
    provider: OidcAuthProvider,
    req: Request,
    res: MockRes
): Promise<void> {
    const controller = new RotationTestController(createMockSettings(), {});
    controller.provider = provider;
    return controller.handleRefresh(req, res);
}

describe("Specification: OIDC session-id rotation on refresh", () => {
    let provider: OidcAuthProvider;

    beforeEach(() => {
        provider = createProvider({ rotate: true });
    });

    it("keeps the same session id when rotation is disabled", async () => {
        const disabled = createProvider({ rotate: false });
        await disabled.storeSession("S1", createSampleSession());
        const res = createMockRes();

        await handleRefresh(disabled, createCookieRequest("S1"), res);

        expect(res._status).toBe(200);
        expect(res._cookies[SESSION_COOKIE]).toBe("S1");
        expect(await disabled.getSession("S1")).toBeDefined();
    });

    it("issues a new session id after a successful refresh when rotation is enabled", async () => {
        await provider.storeSession("S1", createSampleSession());
        const res = createMockRes();

        await handleRefresh(provider, createCookieRequest("S1"), res);

        expect(res._status).toBe(200);
        const newId = res._cookies[SESSION_COOKIE];
        expect(newId).toBeDefined();
        expect(newId).not.toBe("S1");
    });

    it("stops resolving the old session id after rotation", async () => {
        await provider.storeSession("S1", createSampleSession());
        const res = createMockRes();

        await handleRefresh(provider, createCookieRequest("S1"), res);

        const newId = res._cookies[SESSION_COOKIE];
        expect(await provider.getSession("S1")).toBeUndefined();
        const moved = await provider.getSession(newId);
        expect(moved).toBeDefined();
        expect(moved?.accessToken).toBe(REFRESHED_TOKENS.accessToken);
        expect(moved?.user).toEqual(createSampleSession().user);
    });

    it("leaves the session and cookie in place when the refresh fails", async () => {
        const session: OidcSession = createSampleSession();
        await provider.storeSession("S1", session);
        vi.spyOn(provider, "refreshToken").mockRejectedValue(new Error("refresh failed"));
        const res = createMockRes();

        await expect(
            handleRefresh(provider, createCookieRequest("S1"), res)
        ).rejects.toThrow("refresh failed");

        expect(res._cookies[SESSION_COOKIE]).toBeUndefined();
        expect(await provider.getSession("S1")).toEqual(session);
    });

    it("returns 401 without a session cookie and does not write a session", async () => {
        const res = createMockRes();
        const storeSpy = vi.spyOn(provider, "storeSession");

        await handleRefresh(provider, createEmptyRequest(), res);

        expect(res._status).toBe(401);
        expect(storeSpy).not.toHaveBeenCalled();
    });

    it("returns 401 for an unknown session id", async () => {
        const res = createMockRes();

        await handleRefresh(provider, createCookieRequest("missing"), res);

        expect(res._status).toBe(401);
        expect(res._cookies[SESSION_COOKIE]).toBeUndefined();
    });

    it("returns 400 when the session has no refresh token", async () => {
        const session = createSampleSession({ refreshToken: undefined });
        await provider.storeSession("S1", session);
        const res = createMockRes();

        await handleRefresh(provider, createCookieRequest("S1"), res);

        expect(res._status).toBe(400);
        expect(await provider.getSession("S1")).toEqual(session);
    });

    it("rejects a second refresh presenting the already-rotated id", async () => {
        await provider.storeSession("S1", createSampleSession());
        const first = createMockRes();
        await handleRefresh(provider, createCookieRequest("S1"), first);
        expect(first._status).toBe(200);

        const second = createMockRes();
        await handleRefresh(provider, createCookieRequest("S1"), second);

        expect(second._status).toBe(401);
    });
});
