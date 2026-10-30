/**
 * Implementation tests for OIDC session-id rotation.
 *
 * These cover internals and failure paths that the specification tests do not:
 * the accessor default, the exact store/delete/cookie ordering, store and
 * delete failures, preserved session fields, and logout after rotation.
 *
 * @packageDocumentation
 */

import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";

import { OidcAuthController } from "../src/oidc-auth-controller.js";
import { OidcAuthProvider } from "../src/oidc-auth-provider.js";
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

/** Minimal ApplicationSettings double. */
function createMockSettings(): { isProduction: () => boolean; get: (key: string, def?: unknown) => unknown } {
    return { isProduction: () => false, get: (_key, def) => def };
}

/** Create a request carrying a session cookie. */
function createCookieRequest(sessionId: string): Request {
    return {
        query: {},
        headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    } as unknown as Request;
}

/** Capturing Express response double. */
interface MockRes extends Response {
    _status: number;
    _cookies: Record<string, string>;
}

/** Create a response double that records status and cookies. */
function createMockRes(): MockRes {
    const res: Record<string, unknown> = { _status: 200, _cookies: {} as Record<string, string> };
    res.json = vi.fn(function (this: Record<string, unknown>) {
        return this;
    });
    res.status = vi.fn(function (this: Record<string, unknown>, code: number) {
        this._status = code;
        return this;
    });
    res.cookie = vi.fn(function (this: Record<string, unknown>, name: string, value: string) {
        (this._cookies as Record<string, string>)[name] = value;
    });
    res.clearCookie = vi.fn(function (this: Record<string, unknown>) {
        return this;
    });
    return res as unknown as MockRes;
}

/** Controller fixed to a single provider instance. */
class RotationImplController extends OidcAuthController {
    public provider!: OidcAuthProvider;
    protected async getProvider(_req: Request): Promise<OidcAuthProvider> {
        return this.provider;
    }
}

/** Build a controller bound to the given provider. */
function controller(provider: OidcAuthProvider): RotationImplController {
    const c = new RotationImplController(createMockSettings(), {});
    c.provider = provider;
    return c;
}

/** Build a real provider backed by the mock cache, with a stubbed refresh call. */
function createProvider(rotate: boolean): OidcAuthProvider {
    const cache = createMockCacheProvider();
    const provider = new OidcAuthProvider({
        issuerUrl: "https://auth.example.com",
        clientId: "test-client",
        sessionStore: cache.provider,
        rotateSessionIdOnRefresh: rotate,
    });
    vi.spyOn(provider, "refreshToken").mockResolvedValue(REFRESHED_TOKENS);
    // Logout revokes the access token; stub it so the test never reaches the
    // network (discovery + token revocation are true externals).
    vi.spyOn(provider, "revokeToken").mockResolvedValue(undefined);
    return provider;
}

describe("Implementation: OIDC session-id rotation", () => {
    it("reports rotation disabled by default and enabled when configured", () => {
        expect(createProvider(false).shouldRotateSessionIdOnRefresh()).toBe(false);
        expect(createProvider(true).shouldRotateSessionIdOnRefresh()).toBe(true);
    });

    it("stores the new session, deletes the old one, then sets the cookie", async () => {
        const provider = createProvider(true);
        await provider.storeSession("S1", createSampleSession());
        const storeSpy = vi.spyOn(provider, "storeSession");
        const clearSpy = vi.spyOn(provider, "clearSession");
        const res = createMockRes();

        await controller(provider).handleRefresh(createCookieRequest("S1"), res);

        const newId = res._cookies[SESSION_COOKIE];
        expect(storeSpy).toHaveBeenCalledWith(newId, expect.objectContaining({ refreshToken: REFRESHED_TOKENS.refreshToken }));
        expect(clearSpy).toHaveBeenCalledWith("S1");
        const cookieCall = (res.cookie as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];
        expect(storeSpy.mock.invocationCallOrder[0]).toBeLessThan(clearSpy.mock.invocationCallOrder[0]);
        expect(clearSpy.mock.invocationCallOrder[0]).toBeLessThan(cookieCall);
    });

    it("leaves the old session and cookie in place when storing the new session fails", async () => {
        const provider = createProvider(true);
        const original = createSampleSession();
        await provider.storeSession("S1", original);
        vi.spyOn(provider, "storeSession").mockRejectedValueOnce(new Error("store failed"));
        const res = createMockRes();

        await expect(controller(provider).handleRefresh(createCookieRequest("S1"), res)).rejects.toThrow("store failed");

        expect(res._cookies[SESSION_COOKIE]).toBeUndefined();
        expect(await provider.getSession("S1")).toEqual(original);
    });

    it("keeps the old session and leaves an orphan new session when deleting the old one fails", async () => {
        const provider = createProvider(true);
        const original = createSampleSession();
        await provider.storeSession("S1", original);
        const storedIds: string[] = [];
        const realStore = provider.storeSession.bind(provider);
        vi.spyOn(provider, "storeSession").mockImplementation(async (id: string, session) => {
            storedIds.push(id);
            return realStore(id, session);
        });
        vi.spyOn(provider, "clearSession").mockRejectedValue(new Error("delete failed"));
        const res = createMockRes();

        await expect(controller(provider).handleRefresh(createCookieRequest("S1"), res)).rejects.toThrow("delete failed");

        expect(res._cookies[SESSION_COOKIE]).toBeUndefined();
        expect(await provider.getSession("S1")).toEqual(original);
        const orphanId = storedIds.find((id) => id !== "S1");
        expect(orphanId).toBeDefined();
        expect(await provider.getSession(orphanId as string)).toBeDefined();
    });

    it("carries the user and the refreshed tokens onto the rotated session", async () => {
        const provider = createProvider(true);
        const original = createSampleSession();
        await provider.storeSession("S1", original);
        const res = createMockRes();

        await controller(provider).handleRefresh(createCookieRequest("S1"), res);

        const moved = await provider.getSession(res._cookies[SESSION_COOKIE]);
        expect(moved?.user).toEqual(original.user);
        expect(moved?.accessToken).toBe(REFRESHED_TOKENS.accessToken);
        expect(moved?.refreshToken).toBe(REFRESHED_TOKENS.refreshToken);
    });

    it("keeps the previous refresh token when the refresh response omits one", async () => {
        const provider = createProvider(true);
        const original = createSampleSession({ refreshToken: "original-refresh-token" });
        await provider.storeSession("S1", original);
        vi.spyOn(provider, "refreshToken").mockResolvedValue({
            accessToken: "rotated-access-token",
            expiresIn: 3600,
            tokenType: "Bearer",
        });
        const res = createMockRes();

        await controller(provider).handleRefresh(createCookieRequest("S1"), res);

        const moved = await provider.getSession(res._cookies[SESSION_COOKIE]);
        expect(moved?.refreshToken).toBe("original-refresh-token");
    });

    it("clears the rotated session on logout", async () => {
        const provider = createProvider(true);
        await provider.storeSession("S1", createSampleSession());
        const rotated = createMockRes();
        await controller(provider).handleRefresh(createCookieRequest("S1"), rotated);
        const newId = rotated._cookies[SESSION_COOKIE];
        const clearSpy = vi.spyOn(provider, "clearSession");
        const logoutRes = createMockRes();

        await controller(provider).handleLogout(createCookieRequest(newId), logoutRes);

        expect(clearSpy).toHaveBeenCalledWith(newId);
        expect(await provider.getSession(newId)).toBeUndefined();
    });
});
