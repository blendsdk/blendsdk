/**
 * Specification tests for single-flight token refresh.
 *
 * Concurrent refreshes for one session must perform exactly one token-endpoint
 * grant, one session store, and — with `rotateSessionIdOnRefresh` — one
 * session-id move. Every caller that joins the execution receives the same
 * result and cookie, so a rotating IdP never sees the old refresh token twice.
 *
 * The provider double gates `resolveRequestConfig` until all callers have
 * arrived and gates `refreshToken` until the test releases it, which makes the
 * interleaving deterministic.
 *
 * A failing case means the implementation is wrong, not the test.
 *
 * @packageDocumentation
 */

import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

import { OidcAuthController } from "../src/oidc-auth-controller.js";
import type { OidcAuthProvider } from "../src/oidc-auth-provider.js";
import type { OidcCsrfConfig, OidcSession, OidcTokens } from "../src/oidc-types.js";

/** Default session cookie name. */
const SESSION_COOKIE = "__oidc_session";

/** Session id used by every test. */
const SESSION_ID = "session-1";

/** CSRF header used by the CSRF test. */
const CSRF_HEADER = "x-csrf-token";

/** Tokens returned by the stubbed grant. */
const REFRESHED_TOKENS: OidcTokens = {
    accessToken: "refreshed-access-token",
    refreshToken: "refreshed-refresh-token",
    expiresIn: 3600,
    tokenType: "Bearer",
};

/** Minimal ApplicationSettings double (cookie `secure` depends on production). */
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

/** Create a request carrying a session cookie and optional CSRF token. */
function createCookieRequest(
    sessionId = SESSION_ID,
    csrfToken?: string
): Request {
    const headers: Record<string, string | undefined> = {
        cookie: `${SESSION_COOKIE}=${sessionId}`,
    };
    if (csrfToken !== undefined) {
        headers[CSRF_HEADER] = csrfToken;
    }
    return { query: {}, headers } as unknown as Request;
}

/** Sample session with a CSRF token so CSRF tests can authenticate. */
function createSession(overrides: Partial<OidcSession> = {}): OidcSession {
    return {
        accessToken: "old-access-token",
        refreshToken: "old-refresh-token",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        user: { sub: "user-1" },
        csrfToken: "csrf-old",
        ...overrides,
    };
}

/** Controller fixed to a single provider instance. */
class ConcurrencyTestController extends OidcAuthController {
    /** Provider used for every handler call. */
    public provider!: OidcAuthProvider;

    /** Resolve the fixed provider instead of a service container. */
    protected async getProvider(_req: Request): Promise<OidcAuthProvider> {
        return this.provider;
    }
}

/**
 * Provider double whose refresh and config resolution can be gated.
 *
 * `resolveRequestConfig` counts callers and releases a barrier once
 * `expectedCallers` have arrived. `refreshToken` counts grants, signals
 * `grantEntered`, and waits for `releaseGrant()`.
 */
interface RefreshHarness {
    provider: OidcAuthProvider;
    /** Number of `refreshToken` calls observed. */
    get grants(): number;
    /** `storeSession` calls in order. */
    stores: Array<{ id: string; session: OidcSession }>;
    /** Ids passed to `clearSession`. */
    clears: string[];
    /** Sessions currently resolvable by id. */
    sessions: Map<string, OidcSession>;
    /** Resolves once the grant holder has entered `refreshToken`. */
    waitForGrant(): Promise<void>;
    /** Lets the in-flight grant complete. */
    releaseGrant(): void;
    /** Makes `refreshToken` reject with the given error. */
    setFailure(error?: Error): void;
}

/**
 * Build a gated provider double.
 *
 * @param options - Session, rotation, CSRF, and caller-barrier settings
 * @returns The harness
 */
function createRefreshHarness(options: {
    session?: OidcSession;
    rotate?: boolean;
    csrf?: OidcCsrfConfig;
    expectedCallers: number;
}): RefreshHarness {
    const sessions = new Map<string, OidcSession>([
        [SESSION_ID, options.session ?? createSession()],
    ]);
    const stores: Array<{ id: string; session: OidcSession }> = [];
    const clears: string[] = [];

    let grants = 0;
    let failure: Error | undefined;

    let callers = 0;
    let releaseCallers = (): void => {};
    const callersReady = new Promise<void>((resolve) => {
        releaseCallers = resolve;
    });

    let signalGrantEntered = (): void => {};
    const grantEntered = new Promise<void>((resolve) => {
        signalGrantEntered = resolve;
    });
    let openGrantGate = (): void => {};
    const grantGate = new Promise<void>((resolve) => {
        openGrantGate = resolve;
    });

    const provider = {
        getSessionCookieName: () => SESSION_COOKIE,
        getSession: vi.fn(async (id: string) => sessions.get(id)),
        getCsrfConfig: () => options.csrf,
        resolveRequestConfig: vi.fn(async () => {
            callers += 1;
            if (callers >= options.expectedCallers) {
                releaseCallers();
            }
            await callersReady;
            return undefined;
        }),
        refreshToken: vi.fn(async () => {
            grants += 1;
            signalGrantEntered();
            await grantGate;
            if (failure) {
                throw failure;
            }
            return REFRESHED_TOKENS;
        }),
        shouldRotateSessionIdOnRefresh: () => options.rotate ?? false,
        storeSession: vi.fn(async (id: string, session: OidcSession) => {
            stores.push({ id, session });
            sessions.set(id, session);
        }),
        clearSession: vi.fn(async (id: string) => {
            clears.push(id);
            sessions.delete(id);
        }),
        getSessionCookieTtl: () => 3600,
    } as unknown as OidcAuthProvider;

    return {
        provider,
        get grants() {
            return grants;
        },
        stores,
        clears,
        sessions,
        waitForGrant: () => grantEntered,
        releaseGrant: () => openGrantGate(),
        setFailure: (error?: Error) => {
            failure = error;
        },
    };
}

/** Build a controller wired to the harness provider. */
function createController(harness: RefreshHarness): ConcurrencyTestController {
    const controller = new ConcurrencyTestController(createMockSettings(), {});
    controller.provider = harness.provider;
    return controller;
}

/** Start N concurrent refreshes and return their pending promises. */
function startRefreshes(
    controller: ConcurrencyTestController,
    count: number,
    csrfToken?: string
): { responses: MockRes[]; pending: Array<Promise<void>> } {
    const responses = Array.from({ length: count }, () => createMockRes());
    const pending = responses.map((res, index) =>
        controller.handleRefresh(createCookieRequest(SESSION_ID, csrfToken), res)
    );
    return { responses, pending };
}

// ---------------------------------------------------------------------------
// CONC-1…CONC-3: one grant, one store, one cookie
// ---------------------------------------------------------------------------

describe("Single-flight refresh — Specification Tests", () => {
    it("performs one grant for N concurrent refreshes and returns the same token to all (CONC-1)", async () => {
        const harness = createRefreshHarness({ expectedCallers: 10 });
        const controller = createController(harness);
        const { responses, pending } = startRefreshes(controller, 10);

        await harness.waitForGrant();
        harness.releaseGrant();
        await Promise.all(pending);

        expect(harness.grants).toBe(1);
        for (const res of responses) {
            expect(res._status).toBe(200);
            expect((res._json as { data: { message: string } }).data.message).toBe(
                "Tokens refreshed"
            );
        }
        const stored = harness.stores;
        expect(stored).toHaveLength(1);
        expect(stored[0].id).toBe(SESSION_ID);
        expect(stored[0].session.accessToken).toBe(REFRESHED_TOKENS.accessToken);
    });

    it("keeps the same session id and cookie across N concurrent refreshes (CONC-2)", async () => {
        const harness = createRefreshHarness({ expectedCallers: 10 });
        const controller = createController(harness);
        const { responses, pending } = startRefreshes(controller, 10);

        await harness.waitForGrant();
        harness.releaseGrant();
        await Promise.all(pending);

        expect(harness.grants).toBe(1);
        expect(harness.stores).toHaveLength(1);
        expect(harness.clears).toHaveLength(0);
        for (const res of responses) {
            expect(res._cookies[SESSION_COOKIE]).toBe(SESSION_ID);
        }
    });

    it("stores one new session id and issues the same cookie when rotation is enabled (CONC-3)", async () => {
        const harness = createRefreshHarness({ rotate: true, expectedCallers: 10 });
        const controller = createController(harness);
        const { responses, pending } = startRefreshes(controller, 10);

        await harness.waitForGrant();
        harness.releaseGrant();
        await Promise.all(pending);

        expect(harness.grants).toBe(1);
        expect(harness.stores).toHaveLength(1);
        expect(harness.clears).toEqual([SESSION_ID]);
        const newId = harness.stores[0].id;
        expect(newId).not.toBe(SESSION_ID);
        for (const res of responses) {
            expect(res._cookies[SESSION_COOKIE]).toBe(newId);
        }
        expect(harness.sessions.has(SESSION_ID)).toBe(false);
    });

    // -----------------------------------------------------------------------
    // CONC-4 / CONC-5: failures fail all joiners and release the lock
    // -----------------------------------------------------------------------

    it("rejects all joined callers and leaves the session untouched when the grant fails (CONC-4)", async () => {
        const harness = createRefreshHarness({ expectedCallers: 10 });
        harness.setFailure(new Error("refresh failed"));
        const controller = createController(harness);
        const sessionBefore = harness.sessions.get(SESSION_ID);
        const { responses, pending } = startRefreshes(controller, 10);

        await harness.waitForGrant();
        harness.releaseGrant();
        const results = await Promise.allSettled(pending);

        expect(harness.grants).toBe(1);
        expect(results.every((result) => result.status === "rejected")).toBe(true);
        for (const result of results) {
            expect((result as PromiseRejectedResult).reason.message).toBe(
                "refresh failed"
            );
        }
        expect(harness.stores).toHaveLength(0);
        expect(harness.clears).toHaveLength(0);
        expect(harness.sessions.get(SESSION_ID)).toBe(sessionBefore);
        for (const res of responses) {
            expect(res._cookies[SESSION_COOKIE]).toBeUndefined();
        }
    });

    it("runs a later refresh after a failed one, proving the lock was released (CONC-5)", async () => {
        const harness = createRefreshHarness({ expectedCallers: 1 });
        harness.setFailure(new Error("refresh failed"));
        harness.releaseGrant();
        const controller = createController(harness);

        const failed = createMockRes();
        await expect(
            controller.handleRefresh(createCookieRequest(), failed)
        ).rejects.toThrow("refresh failed");

        harness.setFailure(undefined);
        const recovered = createMockRes();
        await controller.handleRefresh(createCookieRequest(), recovered);

        expect(recovered._status).toBe(200);
        expect(harness.grants).toBe(2);
        expect(harness.stores).toHaveLength(1);
    });

    // -----------------------------------------------------------------------
    // CONC-6: CSRF is per caller and joined callers share the new token
    // -----------------------------------------------------------------------

    it("rejects a bad CSRF token without joining and shares one new token with joined callers (CONC-6)", async () => {
        const harness = createRefreshHarness({
            rotate: true,
            csrf: { enabled: true, header: CSRF_HEADER },
            expectedCallers: 5,
        });
        const controller = createController(harness);

        // The invalid caller never reaches the config-resolution barrier.
        const rejected = createMockRes();
        await controller.handleRefresh(createCookieRequest(SESSION_ID, "wrong"), rejected);
        expect(rejected._status).toBe(403);

        const { responses, pending } = startRefreshes(controller, 5, "csrf-old");
        await harness.waitForGrant();
        harness.releaseGrant();
        await Promise.all(pending);

        expect(harness.grants).toBe(1);
        const newToken = (responses[0]._json as { data: { csrfToken: string } }).data
            .csrfToken;
        expect(newToken).toBeDefined();
        expect(newToken).not.toBe("csrf-old");
        for (const res of responses) {
            expect(res._status).toBe(200);
            expect(
                (res._json as { data: { csrfToken: string } }).data.csrfToken
            ).toBe(newToken);
        }
    });

    // -----------------------------------------------------------------------
    // CONC-7 / CONC-8: sequential behavior is preserved
    // -----------------------------------------------------------------------

    it("rejects a second refresh presenting the rotated-away id (CONC-7)", async () => {
        const harness = createRefreshHarness({ rotate: true, expectedCallers: 1 });
        harness.releaseGrant();
        const controller = createController(harness);

        const first = createMockRes();
        await controller.handleRefresh(createCookieRequest(), first);
        expect(first._status).toBe(200);

        const second = createMockRes();
        await controller.handleRefresh(createCookieRequest(), second);

        expect(second._status).toBe(401);
        expect(harness.grants).toBe(1);
    });

    it("performs two grants for two sequential refreshes without rotation (CONC-8)", async () => {
        const harness = createRefreshHarness({ expectedCallers: 1 });
        harness.releaseGrant();
        const controller = createController(harness);

        const first = createMockRes();
        await controller.handleRefresh(createCookieRequest(), first);
        const second = createMockRes();
        await controller.handleRefresh(createCookieRequest(), second);

        expect(first._status).toBe(200);
        expect(second._status).toBe(200);
        expect(harness.grants).toBe(2);
        expect(harness.stores).toHaveLength(2);
    });

    // -----------------------------------------------------------------------
    // CONC-9 / CONC-10: the under-lock re-read is authoritative
    // -----------------------------------------------------------------------

    it("rejects a caller whose outer read succeeded but locks after a rotation (CONC-9)", async () => {
        const harness = createRefreshHarness({ rotate: true, expectedCallers: 1 });
        harness.releaseGrant();
        const controller = createController(harness);

        // The outer read resolves the pre-rotation session; the under-lock
        // re-read sees it gone, so no grant is performed. Reusing the outer
        // session instead of re-reading would pass this request (and grant).
        let reads = 0;
        vi.mocked(harness.provider.getSession).mockImplementation(async (id: string) => {
            reads += 1;
            return reads === 1 ? harness.sessions.get(id) : undefined;
        });

        const res = createMockRes();
        await controller.handleRefresh(createCookieRequest(), res);

        expect(res._status).toBe(401);
        expect(harness.grants).toBe(0);
    });

    it("returns no_refresh_token when the refresh token vanished before the lock (CONC-10)", async () => {
        const harness = createRefreshHarness({ expectedCallers: 1 });
        harness.releaseGrant();
        const controller = createController(harness);

        // The outer read sees a refresh token; the under-lock re-read sees a
        // session that lost it, so the request stops before the grant.
        let reads = 0;
        vi.mocked(harness.provider.getSession).mockImplementation(async (id: string) => {
            reads += 1;
            const session = harness.sessions.get(id);
            if (reads === 1) {
                return session;
            }
            return session ? { ...session, refreshToken: undefined } : undefined;
        });

        const res = createMockRes();
        await controller.handleRefresh(createCookieRequest(), res);

        expect(res._status).toBe(400);
        expect(res._json).toMatchObject({
            success: false,
            error: { code: "no_refresh_token" },
        });
        expect(harness.grants).toBe(0);
    });

    // -----------------------------------------------------------------------
    // CONC-11: CSRF token preservation across joined callers
    // -----------------------------------------------------------------------

    it("preserves the CSRF token across joined callers without rotation (CONC-11)", async () => {
        const harness = createRefreshHarness({
            csrf: { enabled: true, header: CSRF_HEADER },
            expectedCallers: 5,
        });
        const controller = createController(harness);
        const { responses, pending } = startRefreshes(controller, 5, "csrf-old");

        await harness.waitForGrant();
        harness.releaseGrant();
        await Promise.all(pending);

        expect(harness.grants).toBe(1);
        expect(harness.stores).toHaveLength(1);
        for (const res of responses) {
            expect(res._status).toBe(200);
            expect(
                (res._json as { data: { csrfToken: string } }).data.csrfToken
            ).toBe("csrf-old");
        }
    });
});
