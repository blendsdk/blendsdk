/**
 * Specification tests for the absolute session lifetime.
 *
 * A session past its absolute deadline is invalid even when continuously
 * active; a session within both TTLs is valid; refresh and rotation preserve
 * the creation time; and legacy sessions without a creation time are not
 * signed out.
 *
 * @packageDocumentation
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

import { OidcAuthProvider } from "../src/oidc-auth-provider.js";
import { OidcAuthController } from "../src/oidc-auth-controller.js";
import type { OidcSession } from "../src/oidc-types.js";
import { createMockCacheProvider } from "./test-helpers.js";

/** Monotonic "now" in seconds, matched to the session fixtures. */
const NOW = Math.floor(Date.now() / 1000);

afterEach(() => {
    vi.restoreAllMocks();
});

/** Session id used across the provider tests. */
const SESSION_ID = "session-1";

/**
 * Build a provider backed by an in-memory cache with an absolute TTL.
 */
function makeProvider(absoluteTtl?: number): {
    provider: OidcAuthProvider;
    store: Map<string, { value: unknown; expiresAt: number }>;
    cache: ReturnType<typeof createMockCacheProvider>["provider"];
} {
    const { provider: cache, store } = createMockCacheProvider();
    const provider = new OidcAuthProvider({
        issuerUrl: "https://auth.example.com",
        clientId: "test-client",
        sessionStore: cache,
        ...(absoluteTtl === undefined ? {} : { sessionAbsoluteTtl: absoluteTtl }),
    });
    return { provider, store, cache };
}

/** Build a session with an explicit creation time. */
function session(createdAt?: number, extra: Partial<OidcSession> = {}): OidcSession {
    return {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: NOW + 3600,
        user: { sub: "user-1" },
        ...(createdAt === undefined ? {} : { createdAt }),
        ...extra,
    };
}

/** Build an authenticated request carrying the session cookie. */
function requestWithSession(): Request {
    return {
        headers: { cookie: `__oidc_session=${SESSION_ID}` },
    } as unknown as Request;
}

describe("Absolute session lifetime — Specification Tests", () => {
    it("accepts a session within both TTLs (ST-14)", async () => {
        const { provider, store } = makeProvider(100);
        store.set(`oidc:session:${SESSION_ID}`, {
            value: session(NOW - 10),
            expiresAt: 0,
        });

        const result = await provider.getSession(SESSION_ID);

        expect(result).toBeDefined();
    });

    it("rejects and deletes a session past its absolute deadline (ST-15)", async () => {
        const { provider, store } = makeProvider(100);
        store.set(`oidc:session:${SESSION_ID}`, {
            value: session(NOW - 200),
            expiresAt: 0,
        });

        const result = await provider.getSession(SESSION_ID);

        expect(result).toBeUndefined();
        expect(store.has(`oidc:session:${SESSION_ID}`)).toBe(false);
    });

    it("rejects a session past the idle TTL on authenticate (ST-16)", async () => {
        const { provider, store } = makeProvider();
        store.set(`oidc:session:${SESSION_ID}`, {
            value: session(NOW, { expiresAt: NOW - 60 }),
            expiresAt: 0,
        });

        const result = await provider.authenticate(requestWithSession());

        expect(result).toBeUndefined();
    });

    it("preserves createdAt across a refresh (ST-17)", async () => {
        const controller = makeController({
            session: session(NOW - 50),
            rotate: false,
        });

        await controller.refresh();

        expect(controller.storedSession?.createdAt).toBe(NOW - 50);
    });

    it("preserves createdAt across session-id rotation (ST-18)", async () => {
        const controller = makeController({
            session: session(NOW - 50),
            rotate: true,
        });

        await controller.refresh();

        expect(controller.storedSession?.createdAt).toBe(NOW - 50);
    });

    it("does not reject a legacy session without createdAt and stamps it on store (ST-19)", async () => {
        const { provider, store } = makeProvider(100);
        store.set(`oidc:session:${SESSION_ID}`, { value: session(), expiresAt: 0 });

        const found = await provider.getSession(SESSION_ID);
        expect(found).toBeDefined();

        await provider.storeSession(SESSION_ID, found!);
        const persisted = store.get(`oidc:session:${SESSION_ID}`)?.value as OidcSession;
        expect(typeof persisted.createdAt).toBe("number");
    });

    it("leaves behavior unchanged when the absolute TTL is unset (ST-20)", async () => {
        const { provider, store } = makeProvider();
        store.set(`oidc:session:${SESSION_ID}`, {
            value: session(NOW - 100000),
            expiresAt: 0,
        });

        const result = await provider.getSession(SESSION_ID);

        expect(result).toBeDefined();
    });

    it("rejects and deletes a session past the absolute deadline on authenticate (ST-15)", async () => {
        const { provider, store } = makeProvider(100);
        // Active session (expiresAt in the future) but past the absolute deadline.
        store.set(`oidc:session:${SESSION_ID}`, {
            value: session(NOW - 200),
            expiresAt: 0,
        });

        const result = await provider.authenticate(requestWithSession());

        expect(result).toBeUndefined();
        expect(store.has(`oidc:session:${SESSION_ID}`)).toBe(false);
    });

    it("preserves an existing createdAt across stores (ST-19)", async () => {
        const { provider, store } = makeProvider(100);

        await provider.storeSession(SESSION_ID, session(NOW - 50));
        const first = store.get(`oidc:session:${SESSION_ID}`)?.value as OidcSession;
        expect(first.createdAt).toBe(NOW - 50);

        // A later store must not move the original creation time.
        await provider.storeSession(SESSION_ID, {
            ...first,
            accessToken: "new-access",
        });
        const second = store.get(`oidc:session:${SESSION_ID}`)?.value as OidcSession;
        expect(second.createdAt).toBe(NOW - 50);
    });

    it("does not add createdAt when the absolute TTL is unset (ST-20)", async () => {
        const { provider, store } = makeProvider();

        await provider.storeSession(SESSION_ID, session());

        const persisted = store.get(`oidc:session:${SESSION_ID}`)?.value as OidcSession;
        expect(persisted.createdAt).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Controller harness for refresh/rotation preservation
// ---------------------------------------------------------------------------

/** Minimal controller that drives the refresh path with a stub provider. */
class RefreshController extends OidcAuthController {
    storedSession: OidcSession | undefined;

    constructor(
        private readonly sessionValue: OidcSession,
        private readonly rotate: boolean
    ) {
        super(
            { isProduction: () => false } as never,
            {} as never
        );
    }

    /** Run handleRefresh against the stub provider. */
    async refresh(): Promise<void> {
        const provider = this.stubProvider();
        const req = {
            headers: { cookie: `__oidc_session=${SESSION_ID}` },
            services: { get: () => provider },
        } as unknown as Request;
        const res = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn().mockReturnThis(),
            cookie: vi.fn(),
            clearCookie: vi.fn(),
            redirect: vi.fn(),
        } as unknown as Response;
        await this.handleRefresh(req, res);
    }

    private stubProvider() {
        return {
            getCsrfConfig: () => undefined,
            resolveRequestConfig: async () => undefined,
            getSessionCookieName: () => "__oidc_session",
            getSession: async () => this.sessionValue,
            refreshToken: async () => ({
                accessToken: "new-access",
                refreshToken: "new-refresh",
                expiresIn: 3600,
            }),
            storeSession: async (_id: string, value: OidcSession) => {
                this.storedSession = value;
            },
            clearSession: async () => {},
            shouldRotateSessionIdOnRefresh: () => this.rotate,
            getSessionCookieTtl: () => 3600,
        };
    }
}

/** Build and run a refresh controller for a session. */
function makeController(options: { session: OidcSession; rotate: boolean }): {
    refresh: () => Promise<void>;
    storedSession: OidcSession | undefined;
} {
    const controller = new RefreshController(options.session, options.rotate);
    return {
        refresh: () => controller.refresh(),
        get storedSession() {
            return controller.storedSession;
        },
    };
}
