/**
 * Implementation tests for OidcAuthProvider — edge cases and defensive behavior.
 *
 * These tests complement the specification tests (ST-1 through ST-12) by covering
 * edge cases: malformed cookies, empty session objects, concurrent requests,
 * and boundary conditions in the dual-mode authenticate() pipeline.
 *
 * @remarks No Docker required — all tests use mock CacheProvider.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request } from "express";
import { OidcAuthProvider } from "../src/oidc-auth-provider.js";
import type { OidcAuthConfig, OidcSession } from "../src/oidc-types.js";
import type { CacheProvider } from "@blendsdk/webafx-cache";
import { createMockCacheProvider, createSampleSession } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockReq(overrides?: Partial<Request>): Request {
    return {
        headers: {},
        query: {},
        ...overrides,
    } as Request;
}

function createProviderWithSessionStore(
    store: CacheProvider,
    overrides?: Partial<OidcAuthConfig>,
): OidcAuthProvider {
    return new OidcAuthProvider({
        serviceName: "test-oidc",
        issuerUrl: "https://auth.example.com",
        clientId: "test-client",
        sessionStore: store,
        ...overrides,
    } as OidcAuthConfig);
}

// ---------------------------------------------------------------------------
// Edge Cases: parseCookieByName
// ---------------------------------------------------------------------------

describe("OidcAuthProvider — parseCookieByName edge cases", () => {
    let cacheProvider: CacheProvider;
    let cacheStore: Map<string, { value: unknown; expiresAt: number }>;

    beforeEach(() => {
        const mock = createMockCacheProvider();
        cacheProvider = mock.provider;
        cacheStore = mock.store;
    });

    it("handles cookie value with equals sign (base64 padding)", async () => {
        const session = createSampleSession();
        const sessionId = "abc123==";
        cacheStore.set(`oidc:session:${sessionId}`, { value: session, expiresAt: 0 });

        const provider = createProviderWithSessionStore(cacheProvider);
        const req = createMockReq({
            headers: { cookie: `__oidc_session=${encodeURIComponent(sessionId)}` },
        });

        const result = await provider.authenticate(req);
        expect(result).toBeDefined();
        expect(result!.sub).toBe("user-123");
    });

    it("handles cookie value with special characters (URL-encoded)", async () => {
        const session = createSampleSession();
        const sessionId = "id-with spaces+and/slashes";
        cacheStore.set(`oidc:session:${sessionId}`, { value: session, expiresAt: 0 });

        const provider = createProviderWithSessionStore(cacheProvider);
        const req = createMockReq({
            headers: { cookie: `__oidc_session=${encodeURIComponent(sessionId)}` },
        });

        const result = await provider.authenticate(req);
        expect(result).toBeDefined();
    });

    it("handles empty cookie value", async () => {
        const provider = createProviderWithSessionStore(cacheProvider);
        const req = createMockReq({
            headers: { cookie: "__oidc_session=" },
        });

        const result = await provider.authenticate(req);
        expect(result).toBeUndefined();
    });

    it("handles cookie header with only whitespace", async () => {
        const provider = createProviderWithSessionStore(cacheProvider);
        const req = createMockReq({
            headers: { cookie: "   " },
        });

        const result = await provider.authenticate(req);
        expect(result).toBeUndefined();
    });

    it("handles cookie header with trailing semicolons (value includes trailing chars)", async () => {
        // parseCookieByName splits on "; " (with space), so trailing ";;;" without
        // spaces become part of the value. The lookup uses the full value as key.
        const session = createSampleSession();
        cacheStore.set("oidc:session:sess-id;;;", { value: session, expiresAt: 0 });

        const provider = createProviderWithSessionStore(cacheProvider);
        const req = createMockReq({
            headers: { cookie: "__oidc_session=sess-id;;;" },
        });

        const result = await provider.authenticate(req);
        expect(result).toBeDefined();
    });

    it("handles duplicate cookie names (first wins)", async () => {
        const session = createSampleSession();
        cacheStore.set("oidc:session:first-id", { value: session, expiresAt: 0 });

        const provider = createProviderWithSessionStore(cacheProvider);
        const req = createMockReq({
            headers: { cookie: "__oidc_session=first-id; __oidc_session=second-id" },
        });

        const result = await provider.authenticate(req);
        expect(result).toBeDefined();
        // First cookie value should be used
        expect(result!.token).toBe(session.accessToken);
    });
});

// ---------------------------------------------------------------------------
// Edge Cases: Session Data Quality
// ---------------------------------------------------------------------------

describe("OidcAuthProvider — session data edge cases", () => {
    let cacheProvider: CacheProvider;
    let cacheStore: Map<string, { value: unknown; expiresAt: number }>;

    beforeEach(() => {
        const mock = createMockCacheProvider();
        cacheProvider = mock.provider;
        cacheStore = mock.store;
    });

    it("handles session with minimal fields (only accessToken and user.sub)", async () => {
        const minimalSession: OidcSession = {
            accessToken: "minimal-token",
            user: { sub: "min-user" },
        };
        cacheStore.set("oidc:session:min-sess", { value: minimalSession, expiresAt: 0 });

        const provider = createProviderWithSessionStore(cacheProvider);
        const req = createMockReq({
            headers: { cookie: "__oidc_session=min-sess" },
        });

        const result = await provider.authenticate(req);
        expect(result).toBeDefined();
        expect(result!.sub).toBe("min-user");
        expect(result!.token).toBe("minimal-token");
        expect(result!.exp).toBeUndefined();
    });

    it("handles session with expiresAt in the past (expired but still in cache)", async () => {
        const expiredSession: OidcSession = {
            accessToken: "expired-token",
            user: { sub: "expired-user" },
            expiresAt: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
        };
        cacheStore.set("oidc:session:exp-sess", { value: expiredSession, expiresAt: 0 });

        const provider = createProviderWithSessionStore(cacheProvider);
        const req = createMockReq({
            headers: { cookie: "__oidc_session=exp-sess" },
        });

        // Provider returns the session data even if expired — TTL handling is CacheProvider's job
        const result = await provider.authenticate(req);
        expect(result).toBeDefined();
        expect(result!.exp).toBe(expiredSession.expiresAt);
    });

    it("handles session with user object containing extra claims", async () => {
        const richSession: OidcSession = {
            accessToken: "rich-token",
            user: {
                sub: "rich-user",
                email: "rich@example.com",
                roles: ["admin", "editor"],
                org: { id: "org-1", name: "Acme" },
            },
        };
        cacheStore.set("oidc:session:rich-sess", { value: richSession, expiresAt: 0 });

        const provider = createProviderWithSessionStore(cacheProvider);
        const req = createMockReq({
            headers: { cookie: "__oidc_session=rich-sess" },
        });

        const result = await provider.authenticate(req);
        expect(result).toBeDefined();
        expect(result!.claims).toEqual(richSession.user);
        expect((result!.claims as any).roles).toEqual(["admin", "editor"]);
    });
});

// ---------------------------------------------------------------------------
// Edge Cases: resolveSessionCookieName
// ---------------------------------------------------------------------------

describe("OidcAuthProvider — resolveSessionCookieName edge cases", () => {
    let cacheProvider: CacheProvider;
    let cacheStore: Map<string, { value: unknown; expiresAt: number }>;

    beforeEach(() => {
        const mock = createMockCacheProvider();
        cacheProvider = mock.provider;
        cacheStore = mock.store;
    });

    it("uses resolveSessionCookieName when provided", async () => {
        const session = createSampleSession();
        cacheStore.set("oidc:session:org-sess", { value: session, expiresAt: 0 });

        const provider = createProviderWithSessionStore(cacheProvider, {
            resolveSessionCookieName: () => "__oidc_session_acme",
        });

        const req = createMockReq({
            headers: { cookie: "__oidc_session_acme=org-sess" },
        });

        const result = await provider.authenticate(req);
        expect(result).toBeDefined();
        expect(result!.sub).toBe("user-123");
    });

    it("returns undefined when resolveSessionCookieName returns wrong cookie name", async () => {
        const session = createSampleSession();
        cacheStore.set("oidc:session:org-sess", { value: session, expiresAt: 0 });

        const provider = createProviderWithSessionStore(cacheProvider, {
            resolveSessionCookieName: () => "__oidc_session_other",
        });

        // Cookie has default name, but resolver expects a different name
        const req = createMockReq({
            headers: { cookie: "__oidc_session=org-sess" },
        });

        const result = await provider.authenticate(req);
        expect(result).toBeUndefined();
    });

    it("resolveSessionCookieName receives the request object", async () => {
        const session = createSampleSession();
        cacheStore.set("oidc:session:tenant-sess", { value: session, expiresAt: 0 });

        const resolverSpy = vi.fn().mockReturnValue("__oidc_session_tenant");
        const provider = createProviderWithSessionStore(cacheProvider, {
            resolveSessionCookieName: resolverSpy,
        });

        const req = createMockReq({
            headers: { cookie: "__oidc_session_tenant=tenant-sess", host: "tenant.example.com" },
        });

        await provider.authenticate(req);
        expect(resolverSpy).toHaveBeenCalledWith(req);
    });
});

// ---------------------------------------------------------------------------
// Edge Cases: CacheProvider error handling
// ---------------------------------------------------------------------------

describe("OidcAuthProvider — CacheProvider error propagation", () => {
    it("propagates CacheProvider.get errors as-is (500)", async () => {
        const { provider: cacheProvider } = createMockCacheProvider();
        vi.mocked(cacheProvider.get).mockRejectedValueOnce(new Error("Redis connection lost"));

        const provider = createProviderWithSessionStore(cacheProvider);
        const req = createMockReq({
            headers: { cookie: "__oidc_session=some-id" },
        });

        // Error should propagate — not be silently swallowed
        await expect(provider.authenticate(req)).rejects.toThrow("Redis connection lost");
    });

    it("does not catch CacheProvider timeout errors", async () => {
        const { provider: cacheProvider } = createMockCacheProvider();
        vi.mocked(cacheProvider.get).mockRejectedValueOnce(new Error("Operation timed out"));

        const provider = createProviderWithSessionStore(cacheProvider);
        const req = createMockReq({
            headers: { cookie: "__oidc_session=some-id" },
        });

        await expect(provider.authenticate(req)).rejects.toThrow("Operation timed out");
    });
});
