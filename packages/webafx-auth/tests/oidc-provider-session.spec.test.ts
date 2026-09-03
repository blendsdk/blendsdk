/**
 * Specification tests for OidcAuthProvider session operations.
 *
 * These tests verify behavior specified in:
 * - ST-7 through ST-18 from plans/auth-plugin-refactor/07-testing-strategy.md
 * - 04-provider-session-ops.md (technical specification)
 *
 * Each test traces to a specific specification test case (ST-#) and
 * its source requirement. Expectations are derived from the specification
 * documents — NOT from the implementation.
 *
 * @remarks Written BEFORE implementation (red phase).
 * @packageDocumentation
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as client from "openid-client";
import * as jose from "jose";

import { OidcAuthProvider } from "../src/oidc-auth-provider.js";
import type { OidcAuthConfig, OidcSession, OidcSessionState } from "../src/oidc-types.js";
import {
    createMockRequest,
    createMockCacheProvider,
    createMockOidcConfig,
    createSampleSession,
} from "./test-helpers.js";

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
    accessToken: "access-token-123",
    refreshToken: "refresh-token-456",
    idToken: "id-token-789",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    user: { sub: "user-1", name: "Alice", email: "alice@example.com" },
};

/** Sample state for store/get tests */
const SAMPLE_STATE: OidcSessionState = {
    codeVerifier: "pkce-verifier-abc",
    state: "random-state-def",
    nonce: "random-nonce-ghi",
    returnTo: "/dashboard",
};

// ---------------------------------------------------------------------------
// Specification Tests
// ---------------------------------------------------------------------------

describe("Specification: OidcAuthProvider Session Operations", () => {
    let provider: OidcAuthProvider;
    let cacheProvider: ReturnType<typeof createMockCacheProvider>["provider"];
    let cacheStore: ReturnType<typeof createMockCacheProvider>["store"];

    beforeEach(() => {
        const cache = createMockCacheProvider();
        cacheProvider = cache.provider;
        cacheStore = cache.store;

        // Create provider with sessionStore configured
        provider = new OidcAuthProvider({
            issuerUrl: "https://auth.example.com",
            clientId: "test-client",
            sessionStore: cacheProvider,
        });
    });

    // -----------------------------------------------------------------------
    // Session CRUD (ST-7, ST-8, ST-9)
    // -----------------------------------------------------------------------

    // Source: 04-provider-session-ops.md, R2
    it("ST-7: should store session in CacheProvider with key 'oidc:session:<id>' and TTL 3600", async () => {
        await provider.storeSession("uuid-1", SAMPLE_SESSION);

        // CacheProvider.set must be called with prefixed key and default TTL
        expect(cacheProvider.set).toHaveBeenCalledWith(
            "oidc:session:uuid-1",
            SAMPLE_SESSION,
            3600
        );
    });

    // Source: 04-provider-session-ops.md, R2
    it("ST-8: should retrieve stored session data by ID", async () => {
        await provider.storeSession("uuid-1", SAMPLE_SESSION);
        const result = await provider.getSession("uuid-1");

        expect(result).toEqual(SAMPLE_SESSION);
    });

    // Source: 04-provider-session-ops.md, R2
    it("ST-9: should return undefined after clearing a session", async () => {
        await provider.storeSession("uuid-1", SAMPLE_SESSION);
        await provider.clearSession("uuid-1");
        const result = await provider.getSession("uuid-1");

        expect(result).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // State CRUD (ST-10, ST-11, ST-12)
    // -----------------------------------------------------------------------

    // Source: 04-provider-session-ops.md, R2
    it("ST-10: should store state in CacheProvider with key 'oidc:state:<id>' and TTL 300", async () => {
        await provider.storeState("state-1", SAMPLE_STATE);

        // CacheProvider.set must be called with state prefix and default state TTL
        expect(cacheProvider.set).toHaveBeenCalledWith(
            "oidc:state:state-1",
            SAMPLE_STATE,
            300
        );
    });

    // Source: 04-provider-session-ops.md, R2
    it("ST-11: should retrieve stored state data by ID", async () => {
        await provider.storeState("state-1", SAMPLE_STATE);
        const result = await provider.getState("state-1");

        expect(result).toEqual(SAMPLE_STATE);
    });

    // Source: 04-provider-session-ops.md, R2
    it("ST-12: should return undefined after clearing a state", async () => {
        await provider.storeState("state-1", SAMPLE_STATE);
        await provider.clearState("state-1");
        const result = await provider.getState("state-1");

        expect(result).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // Cookie Name Resolution (ST-13, ST-14, ST-15, ST-16)
    // -----------------------------------------------------------------------

    // Source: 04-provider-session-ops.md, R3
    it("ST-13: should return default session cookie name '__oidc_session' when no resolver configured", () => {
        const req = createMockRequest();
        const name = provider.getSessionCookieName(req);

        expect(name).toBe("__oidc_session");
    });

    // Source: 04-provider-session-ops.md, R3
    it("ST-14: should return custom session cookie name from resolveSessionCookieName", () => {
        const customProvider = new OidcAuthProvider({
            issuerUrl: "https://auth.example.com",
            clientId: "test-client",
            sessionStore: cacheProvider,
            resolveSessionCookieName: () => "__oidc_session_acme",
        });

        const req = createMockRequest();
        const name = customProvider.getSessionCookieName(req);

        expect(name).toBe("__oidc_session_acme");
    });

    // Source: 04-provider-session-ops.md, R3, R4
    it("ST-15: should return default state cookie name '__oidc_state' when no resolver configured", () => {
        const req = createMockRequest();
        const name = provider.getStateCookieName(req);

        expect(name).toBe("__oidc_state");
    });

    // Source: 04-provider-session-ops.md, R3, R4
    it("ST-16: should return custom state cookie name from resolveStateCookieName", () => {
        const customProvider = new OidcAuthProvider({
            issuerUrl: "https://auth.example.com",
            clientId: "test-client",
            sessionStore: cacheProvider,
            resolveStateCookieName: () => "__oidc_state_acme",
        });

        const req = createMockRequest();
        const name = customProvider.getStateCookieName(req);

        expect(name).toBe("__oidc_state_acme");
    });

    // -----------------------------------------------------------------------
    // Custom TTL (ST-17)
    // -----------------------------------------------------------------------

    // Source: 04-provider-session-ops.md, R11
    it("ST-17: should use custom sessionTtl when configured", async () => {
        const customProvider = new OidcAuthProvider({
            issuerUrl: "https://auth.example.com",
            clientId: "test-client",
            sessionStore: cacheProvider,
            sessionTtl: 7200,
        });

        await customProvider.storeSession("uuid-custom", SAMPLE_SESSION);

        // CacheProvider.set must be called with the custom TTL
        expect(cacheProvider.set).toHaveBeenCalledWith(
            "oidc:session:uuid-custom",
            SAMPLE_SESSION,
            7200
        );
    });

    // -----------------------------------------------------------------------
    // Missing sessionStore Error (ST-18)
    // -----------------------------------------------------------------------

    // Source: 04-provider-session-ops.md
    it("ST-18: should throw error when session ops called without sessionStore configured", async () => {
        const noStoreProvider = new OidcAuthProvider({
            issuerUrl: "https://auth.example.com",
            clientId: "test-client",
            // No sessionStore
        });

        await expect(
            noStoreProvider.storeSession("uuid-1", SAMPLE_SESSION)
        ).rejects.toThrow("sessionStore is required");
    });
});
