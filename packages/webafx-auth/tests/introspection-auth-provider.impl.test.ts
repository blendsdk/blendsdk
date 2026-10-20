/**
 * Implementation tests for IntrospectionAuthProvider.
 *
 * These tests cover internals and boundaries that go beyond the specification:
 * cache key hashing, cache expiry and TTL clamping, credential encoding,
 * malformed responses, and config precedence.
 *
 * @packageDocumentation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { IntrospectionAuthProvider } from "../src/introspection-auth-provider.js";
import type { IntrospectionAuthConfig } from "../src/types.js";
import { createBearerRequest } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const STATIC_CONFIG: IntrospectionAuthConfig = {
    introspectionUrl: "https://auth.example.com/oauth2/introspect",
    clientId: "client-1",
    clientSecret: "secret-1",
};

const TEST_TOKEN = "impl-opaque-token";

/** Shape used to inspect the provider's private cache in tests. */
interface CacheInspector {
    cache: { entries: Map<string, unknown> };
}

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * Build a minimal fetch Response stand-in.
 *
 * @param body - Parsed JSON body
 * @param status - HTTP status code
 * @returns A Response-shaped object
 */
function jsonResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    } as unknown as Response;
}

/** Seconds since epoch offset from now. */
function epochIn(offsetSeconds: number): number {
    return Math.floor(Date.now() / 1000) + offsetSeconds;
}

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Implementation tests
// ---------------------------------------------------------------------------

describe("Implementation: IntrospectionAuthProvider", () => {
    it("stores cache keys as SHA-256 hex digests, never the raw token", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ active: true, sub: "u", exp: epochIn(3600) })
        );
        const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

        await provider.validate(TEST_TOKEN);

        const inspector = provider as unknown as CacheInspector;
        const keys = [...inspector.cache.entries.keys()];

        expect(keys.length).toBe(1);
        expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
        expect(keys[0]).not.toContain(TEST_TOKEN);
    });

    it("does not cache an active token that is already expired", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ active: true, sub: "u", exp: epochIn(-1) })
        );
        const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

        await expect(provider.validate(TEST_TOKEN)).resolves.toBeUndefined();
        await expect(provider.validate(TEST_TOKEN)).resolves.toBeUndefined();

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("expires cache entries after cacheTTL", async () => {
        vi.useFakeTimers();
        fetchMock.mockResolvedValue(
            jsonResponse({ active: true, sub: "u", exp: epochIn(3600) })
        );
        const provider = new IntrospectionAuthProvider({
            ...STATIC_CONFIG,
            cacheTTL: 1,
        });

        await provider.validate(TEST_TOKEN);
        vi.advanceTimersByTime(1100);
        await provider.validate(TEST_TOKEN);

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("clamps the cache TTL to the token expiration", async () => {
        vi.useFakeTimers();
        // exp is one second away, far below the configured 60s TTL.
        fetchMock.mockResolvedValue(
            jsonResponse({ active: true, sub: "u", exp: epochIn(1) })
        );
        const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

        await provider.validate(TEST_TOKEN);
        vi.advanceTimersByTime(2000);
        await provider.validate(TEST_TOKEN);

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("sends RFC 6749 percent-encoded client credentials in Basic auth", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ active: true }));
        const provider = new IntrospectionAuthProvider({
            introspectionUrl: "https://auth.example.com/introspect",
            clientId: "cli:ent",
            clientSecret: "s/e c",
        });

        await provider.validate(TEST_TOKEN);

        const init = fetchMock.mock.calls[0][1] as RequestInit;
        const header = (init.headers as Record<string, string>).Authorization;
        const encoded = header.replace(/^Basic /, "");
        const decoded = Buffer.from(encoded, "base64").toString("utf-8");

        expect(decoded).toBe(
            `${encodeURIComponent("cli:ent")}:${encodeURIComponent("s/e c")}`
        );
    });

    it("rejects when the introspection body is not valid JSON", async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => {
                throw new Error("invalid json");
            },
        } as unknown as Response);
        const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

        await expect(provider.validate(TEST_TOKEN)).rejects.toThrow(
            "invalid json"
        );
    });

    it("prefers configFactory over static config when both are present", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ active: true, sub: "u", exp: epochIn(3600) })
        );
        const provider = new IntrospectionAuthProvider({
            ...STATIC_CONFIG,
            configFactory: async () => ({
                introspectionUrl: "https://tenant.example.com/introspect",
                clientId: "tenant-client",
                clientSecret: "tenant-secret",
            }),
        });

        await provider.authenticate(createBearerRequest(TEST_TOKEN));

        expect(fetchMock).toHaveBeenCalledWith(
            "https://tenant.example.com/introspect",
            expect.objectContaining({ method: "POST" })
        );
    });

    it("applies the claims mapper on every call, including cache hits", async () => {
        const mapClaims = vi.fn((token: string, claims: Record<string, unknown>) => ({
            sub: String(claims.sub),
            claims,
            token,
        }));
        fetchMock.mockResolvedValue(
            jsonResponse({ active: true, sub: "u", exp: epochIn(3600) })
        );
        const provider = new IntrospectionAuthProvider({
            ...STATIC_CONFIG,
            mapClaims,
        });

        await provider.validate(TEST_TOKEN);
        await provider.validate(TEST_TOKEN);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(mapClaims).toHaveBeenCalledTimes(2);
        expect(mapClaims).toHaveBeenLastCalledWith(
            TEST_TOKEN,
            expect.objectContaining({ active: true })
        );
    });

    it("throws when a configFactory resolves an incomplete config", async () => {
        const provider = new IntrospectionAuthProvider({
            configFactory: async () =>
                ({ clientId: "only-id" }) as IntrospectionAuthConfig,
        });

        await expect(
            provider.authenticate(createBearerRequest(TEST_TOKEN))
        ).rejects.toThrow(/introspectionUrl/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not cache an inactive response", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ active: false }));
        const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

        await provider.validate(TEST_TOKEN);
        await provider.validate(TEST_TOKEN);

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("caches an active response that has no exp for the configured TTL", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ active: true, sub: "u" }));
        const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

        await provider.validate(TEST_TOKEN);
        await provider.validate(TEST_TOKEN);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not cache a failed request", async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse({}, 500))
            .mockResolvedValueOnce(
                jsonResponse({ active: true, sub: "u", exp: epochIn(3600) })
            );
        const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

        await expect(provider.validate(TEST_TOKEN)).rejects.toThrow(/500/);
        await expect(provider.validate(TEST_TOKEN)).resolves.toBeDefined();

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("rejects a JSON body that is not an object", async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => null,
        } as unknown as Response);
        const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

        await expect(provider.validate(TEST_TOKEN)).rejects.toThrow(
            /invalid response body/
        );
    });
});
