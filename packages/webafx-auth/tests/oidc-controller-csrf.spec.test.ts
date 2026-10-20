/**
 * Specification tests for session-bound CSRF enforcement in the OIDC
 * controller.
 *
 * When enabled, `GET /me` returns the session token, and logout/refresh require
 * the matching header. When disabled, the handlers behave as before.
 *
 * @packageDocumentation
 */

import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

import { OidcAuthController } from "../src/oidc-auth-controller.js";
import type { OidcSession } from "../src/oidc-types.js";

const SESSION_ID = "session-1";
const CSRF_TOKEN = "csrf-token-value";

/** Build a controller wired to a stub provider. */
class CsrfController extends OidcAuthController {
    constructor(private readonly provider: any) {
        super({ isProduction: () => false } as never, {} as never);
    }

    /** Resolve the stub provider from the request service container. */
    protected async getProvider(_req: Request): Promise<any> {
        return this.provider;
    }
}

/** Build a stub provider with the requested CSRF config and session. */
function makeProvider(csrf: unknown, session: OidcSession): any {
    return {
        getCsrfConfig: () => csrf,
        resolveRequestConfig: vi.fn(async () => undefined),
        getSessionCookieName: () => "__oidc_session",
        getSession: vi.fn(async () => session),
        clearSession: vi.fn(async () => {}),
        storeSession: vi.fn(async () => {}),
        refreshToken: vi.fn(async () => ({
            accessToken: "new-access",
            refreshToken: "new-refresh",
            expiresIn: 3600,
        })),
        revokeToken: vi.fn(async () => {}),
        shouldRotateSessionIdOnRefresh: () => false,
        getSessionCookieTtl: () => 3600,
    };
}

/** Build a request carrying the session cookie and optional CSRF header. */
function makeReq(csrfHeader?: string, header = "x-csrf-token"): Request {
    const headers: Record<string, string | undefined> = {
        cookie: `__oidc_session=${SESSION_ID}`,
    };
    if (csrfHeader !== undefined) headers[header] = csrfHeader;
    return { headers, query: {}, services: {} } as unknown as Request;
}

/** Build a mock response recording status and body. */
function makeRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
    const json = vi.fn().mockReturnThis();
    const status = vi.fn().mockReturnThis();
    return { res: { status, json, cookie: vi.fn(), clearCookie: vi.fn() } as unknown as Response, status, json };
}

/** Build a session carrying a CSRF token. */
function makeSession(): OidcSession {
    return {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        user: { sub: "user-1" },
        csrfToken: CSRF_TOKEN,
    };
}

describe("OIDC controller CSRF — Specification Tests", () => {
    it("returns the session CSRF token from GET /me when enabled (ST-27)", async () => {
        const controller = new CsrfController(makeProvider({ enabled: true }, makeSession()));
        const { res, json } = makeRes();

        await controller.handleMe(makeReq(), res);

        expect(json.mock.calls[0][0].data.csrfToken).toBe(CSRF_TOKEN);
    });

    it("allows logout with the correct token (ST-28)", async () => {
        const provider = makeProvider({ enabled: true }, makeSession());
        const controller = new CsrfController(provider);
        const { res } = makeRes();

        await controller.handleLogout(makeReq(CSRF_TOKEN), res);

        expect(provider.clearSession).toHaveBeenCalledTimes(1);
    });

    it("rejects logout with a missing or wrong token and leaves the session (ST-29)", async () => {
        const provider = makeProvider({ enabled: true }, makeSession());
        const controller = new CsrfController(provider);

        const missing = makeRes();
        await controller.handleLogout(makeReq(), missing.res);
        expect(missing.status).toHaveBeenCalledWith(403);
        expect(provider.clearSession).not.toHaveBeenCalled();

        const wrong = makeRes();
        await controller.handleLogout(makeReq("wrong"), wrong.res);
        expect(wrong.status).toHaveBeenCalledWith(403);
        expect(provider.clearSession).not.toHaveBeenCalled();
    });

    it("rejects logout when CSRF is enabled and no session exists (ST-29)", async () => {
        const provider = makeProvider({ enabled: true }, makeSession());
        provider.getSession = vi.fn(async () => undefined);
        const controller = new CsrfController(provider);
        const { res, status } = makeRes();

        await controller.handleLogout(makeReq(CSRF_TOKEN), res);

        expect(status).toHaveBeenCalledWith(403);
        expect(provider.clearSession).not.toHaveBeenCalled();
    });

    it("rejects refresh when CSRF is enabled and no session exists (ST-29)", async () => {
        const provider = makeProvider({ enabled: true }, makeSession());
        provider.getSession = vi.fn(async () => undefined);
        const controller = new CsrfController(provider);
        const { res, status } = makeRes();

        await controller.handleRefresh(makeReq(CSRF_TOKEN), res);

        expect(status).toHaveBeenCalledWith(403);
        expect(provider.refreshToken).not.toHaveBeenCalled();
    });

    it("allows refresh with the correct token (ST-30)", async () => {
        const provider = makeProvider({ enabled: true }, makeSession());
        const controller = new CsrfController(provider);
        const { res } = makeRes();

        await controller.handleRefresh(makeReq(CSRF_TOKEN), res);

        expect(provider.refreshToken).toHaveBeenCalledTimes(1);
    });

    it("regenerates and returns a new token on a rotated refresh (ST-30)", async () => {
        const provider = makeProvider({ enabled: true }, makeSession());
        provider.shouldRotateSessionIdOnRefresh = () => true;
        const controller = new CsrfController(provider);
        const { res, json } = makeRes();

        await controller.handleRefresh(makeReq(CSRF_TOKEN), res);

        const body = json.mock.calls[0][0];
        expect(body.data.csrfToken).toBeDefined();
        expect(body.data.csrfToken).not.toBe(CSRF_TOKEN);
        // The regenerated token is stored with the rotated session.
        const stored = provider.storeSession.mock.calls[0][1] as OidcSession;
        expect(stored.csrfToken).toBe(body.data.csrfToken);
    });

    it("preserves and returns the existing token on a non-rotating refresh (ST-30)", async () => {
        const provider = makeProvider({ enabled: true }, makeSession());
        const controller = new CsrfController(provider);
        const { res, json } = makeRes();

        await controller.handleRefresh(makeReq(CSRF_TOKEN), res);

        expect(json.mock.calls[0][0].data.csrfToken).toBe(CSRF_TOKEN);
    });

    it("leaves logout and refresh unchanged when CSRF is not configured (ST-31)", async () => {
        const provider = makeProvider(undefined, makeSession());
        const controller = new CsrfController(provider);

        const logout = makeRes();
        await controller.handleLogout(makeReq(), logout.res);
        expect(provider.clearSession).toHaveBeenCalledTimes(1);

        const refresh = makeRes();
        await controller.handleRefresh(makeReq(), refresh.res);
        expect(provider.refreshToken).toHaveBeenCalledTimes(1);
    });
});
