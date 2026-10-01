/**
 * Tests for the token extraction chain in AuthProvider.
 *
 * Covers:
 * - Header extraction (Authorization: Bearer)
 * - Cookie extraction
 * - Query parameter extraction
 * - Custom extractor functions
 * - Multi-source fallback chain (first match wins)
 * - Edge cases (missing headers, empty values, malformed auth)
 * - Custom cookie and query parameter names
 *
 * Uses MemoryAuthProvider as the concrete implementation since
 * token extraction is inherited from the abstract AuthProvider base.
 */

import { describe, it, expect } from "vitest";
import { MemoryAuthProvider } from "../src/memory-auth-provider.js";
import type { TokenSource } from "../src/types.js";
import {
    createMockRequest,
    createBearerRequest,
    createCookieRequest,
    createQueryRequest,
    createTestAuthResult,
} from "./test-helpers.js";

describe("Token Extraction", () => {
    // -----------------------------------------------------------------------
    // Header extraction (Authorization: Bearer)
    // -----------------------------------------------------------------------

    describe("header extraction", () => {
        it("should extract token from Authorization: Bearer header", () => {
            const provider = new MemoryAuthProvider({
                tokenSources: ["header"],
            });
            const req = createBearerRequest("my-token-123");
            const token = provider.extractToken(req);

            expect(token).toBe("my-token-123");
        });

        it("should return undefined when no Authorization header", () => {
            const provider = new MemoryAuthProvider({
                tokenSources: ["header"],
            });
            const req = createMockRequest();
            const token = provider.extractToken(req);

            expect(token).toBeUndefined();
        });

        it("should return undefined for non-Bearer authorization scheme", () => {
            const provider = new MemoryAuthProvider({
                tokenSources: ["header"],
            });
            const req = createMockRequest({
                authorization: "Basic dXNlcjpwYXNz",
            });
            const token = provider.extractToken(req);

            expect(token).toBeUndefined();
        });

        it("should return undefined for Bearer with no token value", () => {
            const provider = new MemoryAuthProvider({
                tokenSources: ["header"],
            });
            // "Bearer " followed by empty string — extractFromHeader returns ""
            // which is falsy, so extractToken continues to next source and returns undefined
            const req = createMockRequest({ authorization: "Bearer " });
            const token = provider.extractToken(req);

            expect(token).toBeUndefined();
        });

        it("should handle case-sensitive Bearer prefix", () => {
            const provider = new MemoryAuthProvider({
                tokenSources: ["header"],
            });
            // "bearer" (lowercase) should not match — RFC 6750 specifies "Bearer"
            const req = createMockRequest({
                authorization: "bearer my-token",
            });
            const token = provider.extractToken(req);

            expect(token).toBeUndefined();
        });

        it("should be the default token source when not configured", () => {
            // No tokenSources specified — defaults to ['header']
            const provider = new MemoryAuthProvider();
            const req = createBearerRequest("default-source-token");
            const token = provider.extractToken(req);

            expect(token).toBe("default-source-token");
        });
    });

    // -----------------------------------------------------------------------
    // Cookie extraction
    // -----------------------------------------------------------------------

    describe("cookie extraction", () => {
        it("should extract token from default cookie name (auth_token)", () => {
            const provider = new MemoryAuthProvider({
                tokenSources: ["cookie"],
            });
            const req = createCookieRequest("cookie-token-456");
            const token = provider.extractToken(req);

            expect(token).toBe("cookie-token-456");
        });

        it("should extract token from custom cookie name", () => {
            const provider = new MemoryAuthProvider({
                tokenSources: ["cookie"],
                cookieName: "session_id",
            });
            const req = createCookieRequest("session-value", "session_id");
            const token = provider.extractToken(req);

            expect(token).toBe("session-value");
        });

        it("should return undefined when cookie is not present", () => {
            const provider = new MemoryAuthProvider({
                tokenSources: ["cookie"],
            });
            const req = createMockRequest();
            const token = provider.extractToken(req);

            expect(token).toBeUndefined();
        });

        it("should return undefined when cookies object is undefined", () => {
            const provider = new MemoryAuthProvider({
                tokenSources: ["cookie"],
            });
            // Simulate request without cookie-parser middleware
            const req = { headers: {}, query: {} } as any;
            const token = provider.extractToken(req);

            expect(token).toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // Query parameter extraction
    // -----------------------------------------------------------------------

    describe("query parameter extraction", () => {
        it("should extract token from default query param (token)", () => {
            const provider = new MemoryAuthProvider({
                tokenSources: ["query"],
            });
            const req = createQueryRequest("query-token-789");
            const token = provider.extractToken(req);

            expect(token).toBe("query-token-789");
        });

        it("should extract token from custom query param name", () => {
            const provider = new MemoryAuthProvider({
                tokenSources: ["query"],
                queryParamName: "access_token",
            });
            const req = createQueryRequest("custom-value", "access_token");
            const token = provider.extractToken(req);

            expect(token).toBe("custom-value");
        });

        it("should return undefined when query param is not present", () => {
            const provider = new MemoryAuthProvider({
                tokenSources: ["query"],
            });
            const req = createMockRequest();
            const token = provider.extractToken(req);

            expect(token).toBeUndefined();
        });

        it("should return undefined for non-string query values", () => {
            const provider = new MemoryAuthProvider({
                tokenSources: ["query"],
            });
            // Express may parse repeated query params as arrays
            const req = createMockRequest();
            (req.query as Record<string, unknown>).token = ["a", "b"];
            const token = provider.extractToken(req);

            expect(token).toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // Custom extractor
    // -----------------------------------------------------------------------

    describe("custom extractor", () => {
        it("should use a custom extractor function", () => {
            const customSource: TokenSource = {
                extractor: (req) => {
                    // Extract from a custom header (e.g., API key)
                    return req.headers["x-api-key"] as string | undefined;
                },
            };

            const provider = new MemoryAuthProvider({
                tokenSources: [customSource],
            });

            const req = createMockRequest({
                headers: { "x-api-key": "api-key-abc" },
            });
            const token = provider.extractToken(req);

            expect(token).toBe("api-key-abc");
        });

        it("should return undefined when custom extractor returns undefined", () => {
            const customSource: TokenSource = {
                extractor: () => undefined,
            };

            const provider = new MemoryAuthProvider({
                tokenSources: [customSource],
            });

            const req = createMockRequest();
            const token = provider.extractToken(req);

            expect(token).toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // Multi-source fallback chain
    // -----------------------------------------------------------------------

    describe("multi-source fallback chain", () => {
        it("should try sources in order and return first match", () => {
            const provider = new MemoryAuthProvider({
                tokenSources: ["header", "cookie", "query"],
            });

            // All three sources are present — header should win (first in chain)
            const req = createMockRequest({
                authorization: "Bearer header-token",
                cookies: { auth_token: "cookie-token" },
                query: { token: "query-token" },
            });
            const token = provider.extractToken(req);

            expect(token).toBe("header-token");
        });

        it("should fall back to cookie when header is missing", () => {
            const provider = new MemoryAuthProvider({
                tokenSources: ["header", "cookie", "query"],
            });

            const req = createMockRequest({
                cookies: { auth_token: "cookie-token" },
                query: { token: "query-token" },
            });
            const token = provider.extractToken(req);

            expect(token).toBe("cookie-token");
        });

        it("should fall back to query when header and cookie are missing", () => {
            const provider = new MemoryAuthProvider({
                tokenSources: ["header", "cookie", "query"],
            });

            const req = createMockRequest({
                query: { token: "query-token" },
            });
            const token = provider.extractToken(req);

            expect(token).toBe("query-token");
        });

        it("should return undefined when all sources are exhausted", () => {
            const provider = new MemoryAuthProvider({
                tokenSources: ["header", "cookie", "query"],
            });

            const req = createMockRequest();
            const token = provider.extractToken(req);

            expect(token).toBeUndefined();
        });

        it("should support custom extractor mixed with built-in sources", () => {
            const customSource: TokenSource = {
                extractor: (req) =>
                    req.headers["x-custom-token"] as string | undefined,
            };

            const provider = new MemoryAuthProvider({
                tokenSources: ["header", customSource],
            });

            // No Bearer header, but custom header is present
            const req = createMockRequest({
                headers: { "x-custom-token": "custom-value" },
            });
            const token = provider.extractToken(req);

            expect(token).toBe("custom-value");
        });
    });

    // -----------------------------------------------------------------------
    // Full authenticate with different token sources
    // -----------------------------------------------------------------------

    describe("authenticate with token sources", () => {
        it("should authenticate via cookie token source", async () => {
            const provider = new MemoryAuthProvider({
                tokenSources: ["cookie"],
                validTokens: {
                    "my-cookie-token": createTestAuthResult({
                        sub: "cookie-user",
                    }),
                },
            });

            const req = createCookieRequest("my-cookie-token");
            const result = await provider.authenticate(req);

            expect(result).toBeDefined();
            expect(result?.sub).toBe("cookie-user");
        });

        it("should authenticate via query token source", async () => {
            const provider = new MemoryAuthProvider({
                tokenSources: ["query"],
                validTokens: {
                    "my-query-token": createTestAuthResult({
                        sub: "query-user",
                    }),
                },
            });

            const req = createQueryRequest("my-query-token");
            const result = await provider.authenticate(req);

            expect(result).toBeDefined();
            expect(result?.sub).toBe("query-user");
        });
    });

    // -----------------------------------------------------------------------
    // Error handling
    // -----------------------------------------------------------------------

    describe("error handling", () => {
        it("should throw for unknown token source type", () => {
            expect(
                () =>
                    new MemoryAuthProvider({
                        tokenSources: ["invalid-source" as any],
                    })
            ).toThrow("Unknown token source");
        });
    });
});
