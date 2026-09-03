/**
 * Specification tests for OidcAuthProvider dual-mode authenticate.
 *
 * These tests verify behavior specified in the OIDC Session Store plan:
 * - ST-1 through ST-12 from 07-testing-strategy.md
 *
 * Source: plans/oidc-session-store/07-testing-strategy.md
 * Source: plans/oidc-session-store/03-oidc-auth-provider.md
 *
 * @remarks Written BEFORE implementation (red phase).
 * @packageDocumentation
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as client from "openid-client";
import * as jose from "jose";
import { OidcAuthProvider } from "../src/oidc-auth-provider.js";
import type { OidcAuthConfig } from "../src/oidc-types.js";
import {
    createMockRequest,
    createBearerRequest,
    createMockCacheProvider,
    createSampleSession,
    createMockOidcConfig,
} from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Module Mocks — same pattern as oidc-auth-provider.test.ts
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

const mockServerMetadata = {
    issuer: "https://auth.example.com",
    jwks_uri: "https://auth.example.com/.well-known/jwks.json",
};

const mockConfiguration = {
    serverMetadata: () => mockServerMetadata,
} as unknown as client.Configuration;

const defaultClaims = {
    sub: "user-1",
    iss: "https://auth.example.com",
    aud: "https://api.example.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
};

const baseConfig: OidcAuthConfig = {
    serviceName: "oidc-test",
    issuerUrl: "https://auth.example.com",
    clientId: "test-client",
    clientSecret: "test-secret",
    audience: "https://api.example.com",
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.discovery).mockResolvedValue(mockConfiguration);
    vi.mocked(jose.jwtVerify).mockResolvedValue({
        payload: { ...defaultClaims },
        protectedHeader: { alg: "RS256" },
    } as any);
    vi.mocked(jose.createRemoteJWKSet).mockReturnValue(vi.fn() as any);
});

// ---------------------------------------------------------------------------
// Specification Tests: Dual-Mode Authenticate (ST-1 through ST-8)
// ---------------------------------------------------------------------------

describe("Specification: OidcAuthProvider dual-mode authenticate", () => {
    // Source: 07-testing-strategy.md — ST-1
    // AR #8: Bearer token takes priority
    it("ST-1: should return AuthResult from JWT validation when Bearer token is present and sessionStore is configured", async () => {
        const { provider: cacheProvider } = createMockCacheProvider();
        const provider = new OidcAuthProvider({
            ...baseConfig,
            sessionStore: cacheProvider,
        });

        const req = createBearerRequest("valid-bearer-token");
        const result = await provider.authenticate(req);

        // Bearer path should succeed via JWT validation
        expect(result).toBeDefined();
        expect(result!.sub).toBe("user-1");
        expect(result!.token).toBe("valid-bearer-token");
        // CacheProvider should NOT be called — Bearer path handled it
        expect(cacheProvider.get).not.toHaveBeenCalled();
    });

    // Source: 07-testing-strategy.md — ST-2
    // AR #8: Session cookie fallback when no Bearer token
    it("ST-2: should return AuthResult from session cookie when no Bearer token and session exists in CacheProvider", async () => {
        const { provider: cacheProvider, store } = createMockCacheProvider();
        const session = createSampleSession();
        const sessionId = "test-session-uuid";

        // Pre-populate session in cache
        store.set(`oidc:session:${sessionId}`, { value: session, expiresAt: 0 });

        const provider = new OidcAuthProvider({
            ...baseConfig,
            sessionStore: cacheProvider,
        });

        // Request with session cookie but no Bearer token
        const req = createMockRequest({
            headers: { cookie: `__oidc_session=${sessionId}` },
        });

        const result = await provider.authenticate(req);

        expect(result).toBeDefined();
        expect(result!.sub).toBe("user-123");
        expect(result!.token).toBe("mock-access-token");
        expect(result!.claims).toEqual(session.user);
        expect(result!.exp).toBe(session.expiresAt);
    });

    // Source: 07-testing-strategy.md — ST-3
    // AR #14: Session expired → return undefined → 401
    it("ST-3: should return undefined when session cookie present but session NOT in CacheProvider", async () => {
        const { provider: cacheProvider } = createMockCacheProvider();
        // No session pre-populated — simulates expired/missing session

        const provider = new OidcAuthProvider({
            ...baseConfig,
            sessionStore: cacheProvider,
        });

        const req = createMockRequest({
            headers: { cookie: "__oidc_session=expired-session-id" },
        });

        const result = await provider.authenticate(req);
        expect(result).toBeUndefined();
    });

    // Source: 07-testing-strategy.md — ST-4
    // AR #8: No Bearer, no session cookie → undefined
    it("ST-4: should return undefined when no Bearer token and no session cookie", async () => {
        const { provider: cacheProvider } = createMockCacheProvider();
        const provider = new OidcAuthProvider({
            ...baseConfig,
            sessionStore: cacheProvider,
        });

        const req = createMockRequest(); // No token, no cookie
        const result = await provider.authenticate(req);
        expect(result).toBeUndefined();
    });

    // Source: 07-testing-strategy.md — ST-5
    // AR #8: sessionStore NOT configured → no session fallback
    it("ST-5: should return undefined when no Bearer token and sessionStore is NOT configured", async () => {
        const provider = new OidcAuthProvider(baseConfig); // No sessionStore

        const req = createMockRequest({
            headers: { cookie: "__oidc_session=some-session-id" },
        });

        const result = await provider.authenticate(req);
        expect(result).toBeUndefined();
    });

    // Source: 07-testing-strategy.md — ST-6
    // AR #8: Bearer takes priority over session cookie
    it("ST-6: should return AuthResult from JWT when both Bearer token AND session cookie are present", async () => {
        const { provider: cacheProvider, store } = createMockCacheProvider();
        const session = createSampleSession({ user: { sub: "session-user" } });
        store.set("oidc:session:sess-id", { value: session, expiresAt: 0 });

        const provider = new OidcAuthProvider({
            ...baseConfig,
            sessionStore: cacheProvider,
        });

        const req = createMockRequest({
            authorization: "Bearer valid-jwt",
            headers: { cookie: "__oidc_session=sess-id" },
        });

        const result = await provider.authenticate(req);

        // Should return JWT result (sub=user-1), NOT session result (sub=session-user)
        expect(result).toBeDefined();
        expect(result!.sub).toBe("user-1"); // From JWT, not session
        expect(cacheProvider.get).not.toHaveBeenCalled();
    });

    // Source: 07-testing-strategy.md — ST-7
    // AR #13: CacheProvider errors propagate as 500
    it("ST-7: should propagate CacheProvider error when session lookup fails", async () => {
        const { provider: cacheProvider } = createMockCacheProvider();
        // Make CacheProvider.get throw
        vi.mocked(cacheProvider.get).mockRejectedValue(new Error("Redis connection refused"));

        const provider = new OidcAuthProvider({
            ...baseConfig,
            sessionStore: cacheProvider,
        });

        const req = createMockRequest({
            headers: { cookie: "__oidc_session=some-session-id" },
        });

        // Error should propagate — not be silently caught
        await expect(provider.authenticate(req)).rejects.toThrow("Redis connection refused");
    });

    // Source: 07-testing-strategy.md — ST-8
    // AR #6: Multi-tenant org-scoped cookie name
    it("ST-8: should resolve session from org-scoped cookie name when resolveSessionCookieName is configured", async () => {
        const { provider: cacheProvider, store } = createMockCacheProvider();
        const session = createSampleSession({ organizationSlug: "acme" });
        const sessionId = "acme-session-uuid";
        store.set(`oidc:session:${sessionId}`, { value: session, expiresAt: 0 });

        const provider = new OidcAuthProvider({
            ...baseConfig,
            sessionStore: cacheProvider,
            resolveSessionCookieName: () => "__oidc_session_acme",
        });

        const req = createMockRequest({
            headers: { cookie: `__oidc_session_acme=${sessionId}` },
        });

        const result = await provider.authenticate(req);

        expect(result).toBeDefined();
        expect(result!.sub).toBe("user-123");
        expect(result!.token).toBe("mock-access-token");
    });
});

// ---------------------------------------------------------------------------
// Specification Tests: parseCookieByName (ST-9 through ST-12)
// ---------------------------------------------------------------------------

describe("Specification: OidcAuthProvider parseCookieByName", () => {
    // Source: 07-testing-strategy.md — ST-9
    // R2: Parse cookie from Cookie header
    it("ST-9: should find and return cookie value from Cookie header", async () => {
        const { provider: cacheProvider, store } = createMockCacheProvider();
        const session = createSampleSession();
        store.set("oidc:session:my-uuid", { value: session, expiresAt: 0 });

        const provider = new OidcAuthProvider({
            ...baseConfig,
            sessionStore: cacheProvider,
        });

        const req = createMockRequest({
            headers: { cookie: "other=val; __oidc_session=my-uuid; another=123" },
        });

        const result = await provider.authenticate(req);
        // If parseCookieByName works, session should be found
        expect(result).toBeDefined();
        expect(result!.sub).toBe("user-123");
    });

    // Source: 07-testing-strategy.md — ST-10
    // R2: Target cookie not present → undefined
    it("ST-10: should return undefined when target cookie is not in Cookie header", async () => {
        const { provider: cacheProvider } = createMockCacheProvider();
        const provider = new OidcAuthProvider({
            ...baseConfig,
            sessionStore: cacheProvider,
        });

        const req = createMockRequest({
            headers: { cookie: "other_cookie=value; unrelated=data" },
        });

        const result = await provider.authenticate(req);
        expect(result).toBeUndefined();
    });

    // Source: 07-testing-strategy.md — ST-11
    // R2: No Cookie header → undefined
    it("ST-11: should return undefined when no Cookie header is present", async () => {
        const { provider: cacheProvider } = createMockCacheProvider();
        const provider = new OidcAuthProvider({
            ...baseConfig,
            sessionStore: cacheProvider,
        });

        const req = createMockRequest(); // No cookie header
        const result = await provider.authenticate(req);
        expect(result).toBeUndefined();
    });

    // Source: 07-testing-strategy.md — ST-12
    // R2: URL-encoded cookie value → decoded
    it("ST-12: should decode URL-encoded cookie value", async () => {
        const { provider: cacheProvider, store } = createMockCacheProvider();
        const session = createSampleSession();
        const encodedId = "id%20with%20spaces";
        const decodedId = "id with spaces";
        store.set(`oidc:session:${decodedId}`, { value: session, expiresAt: 0 });

        const provider = new OidcAuthProvider({
            ...baseConfig,
            sessionStore: cacheProvider,
        });

        const req = createMockRequest({
            headers: { cookie: `__oidc_session=${encodedId}` },
        });

        const result = await provider.authenticate(req);
        expect(result).toBeDefined();
        expect(result!.sub).toBe("user-123");
    });
});
