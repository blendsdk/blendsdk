/**
 * Implementation tests for OidcAuthProvider session operations.
 *
 * Tests edge cases, internals, and boundary conditions NOT covered by
 * the specification tests (ST-7 through ST-18). These tests verify
 * implementation details such as:
 * - Custom stateTtl configuration
 * - Key prefix isolation between session and state namespaces
 * - Concurrent session/state operations
 * - Non-existent key behavior
 * - Error propagation for all session/state ops when sessionStore is missing
 * - Cookie name resolver receives the correct request object
 *
 * @packageDocumentation
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as client from "openid-client";
import * as jose from "jose";

import { OidcAuthProvider } from "../src/oidc-auth-provider.js";
import type { OidcSession, OidcSessionState } from "../src/oidc-types.js";
import { createMockRequest, createMockCacheProvider } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Module Mocks — suppress OIDC network calls
// ---------------------------------------------------------------------------

vi.mock("openid-client", async () => {
    const actual = await vi.importActual<typeof client>("openid-client");
    return {
        ...actual,
        discovery: vi.fn(),
        buildAuthorizationUrl: vi.fn(),
        authorizationCodeGrant: vi.fn(),
        refreshTokenGrant: vi.fn(),
        tokenRevocation: vi.fn(),
        fetchUserInfo: vi.fn(),
        randomPKCECodeVerifier: vi.fn(() => "mock-code-verifier"),
        calculatePKCECodeChallenge: vi.fn(async () => "mock-code-challenge"),
        randomState: vi.fn(() => "mock-state"),
        randomNonce: vi.fn(() => "mock-nonce"),
    };
});

vi.mock("jose", async () => {
    const actual = await vi.importActual<typeof jose>("jose");
    return {
        ...actual,
        jwtVerify: vi.fn(),
        createRemoteJWKSet: vi.fn(() => vi.fn()),
    };
});

// ---------------------------------------------------------------------------
// Shared Fixtures
// ---------------------------------------------------------------------------

/** Sample session for store/get tests */
const SAMPLE_SESSION: OidcSession = {
    accessToken: "access-token-impl",
    refreshToken: "refresh-token-impl",
    idToken: "id-token-impl",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    user: { sub: "impl-user-1", name: "Bob", email: "bob@example.com" },
};

/** Alternative session for concurrent/multi-session tests */
const ALT_SESSION: OidcSession = {
    accessToken: "access-token-alt",
    refreshToken: "refresh-token-alt",
    idToken: "id-token-alt",
    expiresAt: Math.floor(Date.now() / 1000) + 7200,
    user: { sub: "impl-user-2", name: "Carol", email: "carol@example.com" },
};

/** Sample PKCE state for tests */
const SAMPLE_STATE: OidcSessionState = {
    codeVerifier: "pkce-verifier-impl",
    state: "random-state-impl",
    nonce: "random-nonce-impl",
    returnTo: "/settings",
};

/** Alternative PKCE state for concurrent tests */
const ALT_STATE: OidcSessionState = {
    codeVerifier: "pkce-verifier-alt",
    state: "random-state-alt",
    nonce: "random-nonce-alt",
    returnTo: "/profile",
};

// ---------------------------------------------------------------------------
// Implementation Tests
// ---------------------------------------------------------------------------

describe("Implementation: OidcAuthProvider Session Operations", () => {
    let provider: OidcAuthProvider;
    let cacheProvider: ReturnType<typeof createMockCacheProvider>["provider"];
    let cacheStore: ReturnType<typeof createMockCacheProvider>["store"];

    beforeEach(() => {
        const cache = createMockCacheProvider();
        cacheProvider = cache.provider;
        cacheStore = cache.store;

        provider = new OidcAuthProvider({
            issuerUrl: "https://auth.example.com",
            clientId: "test-client",
            sessionStore: cacheProvider,
        });
    });

    // -----------------------------------------------------------------------
    // Custom stateTtl
    // -----------------------------------------------------------------------

    describe("custom stateTtl", () => {
        it("should use custom stateTtl when configured", async () => {
            // Spec ST-17 only tests custom sessionTtl; this tests stateTtl
            const customProvider = new OidcAuthProvider({
                issuerUrl: "https://auth.example.com",
                clientId: "test-client",
                sessionStore: cacheProvider,
                stateTtl: 600,
            });

            await customProvider.storeState("state-custom", SAMPLE_STATE);

            expect(cacheProvider.set).toHaveBeenCalledWith(
                "oidc:state:state-custom",
                SAMPLE_STATE,
                600
            );
        });

        it("should allow both sessionTtl and stateTtl to be configured independently", async () => {
            const customProvider = new OidcAuthProvider({
                issuerUrl: "https://auth.example.com",
                clientId: "test-client",
                sessionStore: cacheProvider,
                sessionTtl: 1800,
                stateTtl: 120,
            });

            await customProvider.storeSession("sess-1", SAMPLE_SESSION);
            await customProvider.storeState("state-1", SAMPLE_STATE);

            // Session uses sessionTtl (1800)
            expect(cacheProvider.set).toHaveBeenCalledWith(
                "oidc:session:sess-1",
                SAMPLE_SESSION,
                1800
            );

            // State uses stateTtl (120)
            expect(cacheProvider.set).toHaveBeenCalledWith(
                "oidc:state:state-1",
                SAMPLE_STATE,
                120
            );
        });
    });

    // -----------------------------------------------------------------------
    // Key Prefix Isolation
    // -----------------------------------------------------------------------

    describe("key prefix isolation", () => {
        it("should store session and state with same ID without collision", async () => {
            // Use identical ID for both session and state
            const sharedId = "shared-uuid-123";

            await provider.storeSession(sharedId, SAMPLE_SESSION);
            await provider.storeState(sharedId, SAMPLE_STATE);

            // Both should exist in the backing store with different prefixed keys
            expect(cacheStore.has("oidc:session:shared-uuid-123")).toBe(true);
            expect(cacheStore.has("oidc:state:shared-uuid-123")).toBe(true);

            // Retrieving each by type should return the correct data
            const session = await provider.getSession(sharedId);
            const state = await provider.getState(sharedId);

            expect(session).toEqual(SAMPLE_SESSION);
            expect(state).toEqual(SAMPLE_STATE);
        });

        it("should clear session without affecting state with same ID", async () => {
            const sharedId = "shared-uuid-456";

            await provider.storeSession(sharedId, SAMPLE_SESSION);
            await provider.storeState(sharedId, SAMPLE_STATE);

            // Clear only the session
            await provider.clearSession(sharedId);

            // Session should be gone, state should remain
            const session = await provider.getSession(sharedId);
            const state = await provider.getState(sharedId);

            expect(session).toBeUndefined();
            expect(state).toEqual(SAMPLE_STATE);
        });

        it("should clear state without affecting session with same ID", async () => {
            const sharedId = "shared-uuid-789";

            await provider.storeSession(sharedId, SAMPLE_SESSION);
            await provider.storeState(sharedId, SAMPLE_STATE);

            // Clear only the state
            await provider.clearState(sharedId);

            // State should be gone, session should remain
            const session = await provider.getSession(sharedId);
            const state = await provider.getState(sharedId);

            expect(session).toEqual(SAMPLE_SESSION);
            expect(state).toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // Concurrent / Multi-Key Operations
    // -----------------------------------------------------------------------

    describe("concurrent operations", () => {
        it("should store and retrieve multiple sessions independently", async () => {
            await provider.storeSession("sess-a", SAMPLE_SESSION);
            await provider.storeSession("sess-b", ALT_SESSION);

            const sessionA = await provider.getSession("sess-a");
            const sessionB = await provider.getSession("sess-b");

            expect(sessionA).toEqual(SAMPLE_SESSION);
            expect(sessionB).toEqual(ALT_SESSION);
        });

        it("should store and retrieve multiple states independently", async () => {
            await provider.storeState("state-a", SAMPLE_STATE);
            await provider.storeState("state-b", ALT_STATE);

            const stateA = await provider.getState("state-a");
            const stateB = await provider.getState("state-b");

            expect(stateA).toEqual(SAMPLE_STATE);
            expect(stateB).toEqual(ALT_STATE);
        });

        it("should clear one session without affecting another", async () => {
            await provider.storeSession("sess-x", SAMPLE_SESSION);
            await provider.storeSession("sess-y", ALT_SESSION);

            await provider.clearSession("sess-x");

            const sessionX = await provider.getSession("sess-x");
            const sessionY = await provider.getSession("sess-y");

            expect(sessionX).toBeUndefined();
            expect(sessionY).toEqual(ALT_SESSION);
        });

        it("should handle concurrent store/get/clear operations via Promise.all", async () => {
            // Simulate concurrent operations — all running in parallel
            await Promise.all([
                provider.storeSession("concurrent-1", SAMPLE_SESSION),
                provider.storeSession("concurrent-2", ALT_SESSION),
                provider.storeState("concurrent-state-1", SAMPLE_STATE),
                provider.storeState("concurrent-state-2", ALT_STATE),
            ]);

            // Verify all stored correctly
            const [s1, s2, st1, st2] = await Promise.all([
                provider.getSession("concurrent-1"),
                provider.getSession("concurrent-2"),
                provider.getState("concurrent-state-1"),
                provider.getState("concurrent-state-2"),
            ]);

            expect(s1).toEqual(SAMPLE_SESSION);
            expect(s2).toEqual(ALT_SESSION);
            expect(st1).toEqual(SAMPLE_STATE);
            expect(st2).toEqual(ALT_STATE);
        });
    });

    // -----------------------------------------------------------------------
    // Non-Existent Key Behavior
    // -----------------------------------------------------------------------

    describe("non-existent key behavior", () => {
        it("should return undefined for getSession with non-existent ID", async () => {
            const result = await provider.getSession("does-not-exist");
            expect(result).toBeUndefined();
        });

        it("should return undefined for getState with non-existent ID", async () => {
            const result = await provider.getState("does-not-exist");
            expect(result).toBeUndefined();
        });

        it("should not throw when clearing a non-existent session", async () => {
            // clearSession on a non-existent key should complete without error
            await expect(
                provider.clearSession("does-not-exist")
            ).resolves.toBeUndefined();
        });

        it("should not throw when clearing a non-existent state", async () => {
            // clearState on a non-existent key should complete without error
            await expect(
                provider.clearState("does-not-exist")
            ).resolves.toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // Session Overwrite
    // -----------------------------------------------------------------------

    describe("session overwrite", () => {
        it("should overwrite an existing session with the same ID", async () => {
            await provider.storeSession("overwrite-1", SAMPLE_SESSION);
            await provider.storeSession("overwrite-1", ALT_SESSION);

            const result = await provider.getSession("overwrite-1");
            expect(result).toEqual(ALT_SESSION);
        });

        it("should overwrite an existing state with the same ID", async () => {
            await provider.storeState("overwrite-state-1", SAMPLE_STATE);
            await provider.storeState("overwrite-state-1", ALT_STATE);

            const result = await provider.getState("overwrite-state-1");
            expect(result).toEqual(ALT_STATE);
        });
    });

    // -----------------------------------------------------------------------
    // Missing sessionStore — All Operations
    // -----------------------------------------------------------------------

    describe("missing sessionStore — all operations", () => {
        let noStoreProvider: OidcAuthProvider;

        beforeEach(() => {
            // Provider without sessionStore — should throw for all CRUD ops
            noStoreProvider = new OidcAuthProvider({
                issuerUrl: "https://auth.example.com",
                clientId: "test-client",
                // No sessionStore configured
            });
        });

        // Spec ST-18 only tests storeSession; these test the remaining ops
        it("should throw when getSession is called without sessionStore", async () => {
            await expect(
                noStoreProvider.getSession("uuid-1")
            ).rejects.toThrow("sessionStore is required");
        });

        it("should throw when clearSession is called without sessionStore", async () => {
            await expect(
                noStoreProvider.clearSession("uuid-1")
            ).rejects.toThrow("sessionStore is required");
        });

        it("should throw when storeState is called without sessionStore", async () => {
            await expect(
                noStoreProvider.storeState("state-1", SAMPLE_STATE)
            ).rejects.toThrow("sessionStore is required");
        });

        it("should throw when getState is called without sessionStore", async () => {
            await expect(
                noStoreProvider.getState("state-1")
            ).rejects.toThrow("sessionStore is required");
        });

        it("should throw when clearState is called without sessionStore", async () => {
            await expect(
                noStoreProvider.clearState("state-1")
            ).rejects.toThrow("sessionStore is required");
        });
    });

    // -----------------------------------------------------------------------
    // Cookie Name Resolver — Request Passthrough
    // -----------------------------------------------------------------------

    describe("cookie name resolver — request passthrough", () => {
        it("should pass the request object to resolveSessionCookieName", () => {
            const resolver = vi.fn(() => "__oidc_session_tenant");
            const customProvider = new OidcAuthProvider({
                issuerUrl: "https://auth.example.com",
                clientId: "test-client",
                sessionStore: cacheProvider,
                resolveSessionCookieName: resolver,
            });

            const req = createMockRequest({
                headers: { "x-tenant-id": "acme" },
            });
            customProvider.getSessionCookieName(req);

            // The resolver should be called with the exact request object
            expect(resolver).toHaveBeenCalledTimes(1);
            expect(resolver).toHaveBeenCalledWith(req);
        });

        it("should pass the request object to resolveStateCookieName", () => {
            const resolver = vi.fn(() => "__oidc_state_tenant");
            const customProvider = new OidcAuthProvider({
                issuerUrl: "https://auth.example.com",
                clientId: "test-client",
                sessionStore: cacheProvider,
                resolveStateCookieName: resolver,
            });

            const req = createMockRequest({
                headers: { "x-tenant-id": "acme" },
            });
            customProvider.getStateCookieName(req);

            // The resolver should be called with the exact request object
            expect(resolver).toHaveBeenCalledTimes(1);
            expect(resolver).toHaveBeenCalledWith(req);
        });

        it("should support dynamic cookie names based on request properties", () => {
            // Multi-tenant resolver that uses a header to scope cookies
            const customProvider = new OidcAuthProvider({
                issuerUrl: "https://auth.example.com",
                clientId: "test-client",
                sessionStore: cacheProvider,
                resolveSessionCookieName: (req) => {
                    const tenant = req.headers["x-tenant-id"] as string;
                    return `__oidc_session_${tenant ?? "default"}`;
                },
                resolveStateCookieName: (req) => {
                    const tenant = req.headers["x-tenant-id"] as string;
                    return `__oidc_state_${tenant ?? "default"}`;
                },
            });

            const reqAcme = createMockRequest({
                headers: { "x-tenant-id": "acme" },
            });
            const reqGlobus = createMockRequest({
                headers: { "x-tenant-id": "globus" },
            });

            // Different tenants get different cookie names
            expect(customProvider.getSessionCookieName(reqAcme)).toBe(
                "__oidc_session_acme"
            );
            expect(customProvider.getSessionCookieName(reqGlobus)).toBe(
                "__oidc_session_globus"
            );
            expect(customProvider.getStateCookieName(reqAcme)).toBe(
                "__oidc_state_acme"
            );
            expect(customProvider.getStateCookieName(reqGlobus)).toBe(
                "__oidc_state_globus"
            );
        });
    });

    // -----------------------------------------------------------------------
    // CacheProvider Call Verification
    // -----------------------------------------------------------------------

    describe("CacheProvider call verification", () => {
        it("should call CacheProvider.delete with the prefixed key for clearSession", async () => {
            await provider.clearSession("uuid-del");

            expect(cacheProvider.delete).toHaveBeenCalledWith(
                "oidc:session:uuid-del"
            );
        });

        it("should call CacheProvider.delete with the prefixed key for clearState", async () => {
            await provider.clearState("state-del");

            expect(cacheProvider.delete).toHaveBeenCalledWith(
                "oidc:state:state-del"
            );
        });

        it("should call CacheProvider.get with the prefixed key for getSession", async () => {
            await provider.getSession("uuid-get");

            expect(cacheProvider.get).toHaveBeenCalledWith(
                "oidc:session:uuid-get"
            );
        });

        it("should call CacheProvider.get with the prefixed key for getState", async () => {
            await provider.getState("state-get");

            expect(cacheProvider.get).toHaveBeenCalledWith(
                "oidc:state:state-get"
            );
        });
    });
});
