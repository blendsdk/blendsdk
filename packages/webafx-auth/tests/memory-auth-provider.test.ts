/**
 * Tests for MemoryAuthProvider — the in-memory mock auth provider.
 *
 * Covers:
 * - Token validation via map lookup (valid/invalid/empty)
 * - Runtime helpers (addToken, removeToken, getTokenCount)
 * - Full authenticate() lifecycle with mock requests
 * - Health check and shutdown behavior
 * - Custom service name and token sources
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MemoryAuthProvider } from "../src/memory-auth-provider.js";
import {
    createBearerRequest,
    createMockRequest,
    createTestAuthResult,
    ADMIN_AUTH_RESULT,
    USER_AUTH_RESULT,
} from "./test-helpers.js";

describe("MemoryAuthProvider", () => {
    // -----------------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------------

    describe("construction", () => {
        it("should create with no config (empty token map)", () => {
            const provider = new MemoryAuthProvider();
            expect(provider.getTokenCount()).toBe(0);
        });

        it("should create with empty config", () => {
            const provider = new MemoryAuthProvider({});
            expect(provider.getTokenCount()).toBe(0);
        });

        it("should create with pre-configured tokens", () => {
            const provider = new MemoryAuthProvider({
                validTokens: {
                    "token-a": createTestAuthResult({ sub: "user-a" }),
                    "token-b": createTestAuthResult({ sub: "user-b" }),
                },
            });
            expect(provider.getTokenCount()).toBe(2);
        });

        it("should use default service name when not specified", () => {
            const provider = new MemoryAuthProvider();
            expect(provider.serviceName).toBe("auth");
        });

        it("should use custom service name when specified", () => {
            const provider = new MemoryAuthProvider({
                serviceName: "custom-auth",
            });
            expect(provider.serviceName).toBe("custom-auth");
        });
    });

    // -----------------------------------------------------------------------
    // validate()
    // -----------------------------------------------------------------------

    describe("validate()", () => {
        let provider: MemoryAuthProvider;

        beforeEach(() => {
            provider = new MemoryAuthProvider({
                validTokens: {
                    "admin-token": ADMIN_AUTH_RESULT,
                    "user-token": USER_AUTH_RESULT,
                },
            });
        });

        it("should return AuthResult for a valid token", async () => {
            const result = await provider.validate("admin-token");
            expect(result).toEqual(ADMIN_AUTH_RESULT);
        });

        it("should return correct result for each registered token", async () => {
            const admin = await provider.validate("admin-token");
            const user = await provider.validate("user-token");
            expect(admin?.sub).toBe("admin-1");
            expect(user?.sub).toBe("user-1");
        });

        it("should return undefined for unknown token", async () => {
            const result = await provider.validate("unknown-token");
            expect(result).toBeUndefined();
        });

        it("should return undefined for empty string token", async () => {
            const result = await provider.validate("");
            expect(result).toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // authenticate() — full lifecycle
    // -----------------------------------------------------------------------

    describe("authenticate()", () => {
        let provider: MemoryAuthProvider;

        beforeEach(() => {
            provider = new MemoryAuthProvider({
                validTokens: {
                    "valid-token": createTestAuthResult(),
                },
            });
        });

        it("should authenticate a request with valid Bearer token", async () => {
            const req = createBearerRequest("valid-token");
            const result = await provider.authenticate(req);
            expect(result).toBeDefined();
            expect(result?.sub).toBe("test-user-1");
        });

        it("should return undefined for request with invalid Bearer token", async () => {
            const req = createBearerRequest("invalid-token");
            const result = await provider.authenticate(req);
            expect(result).toBeUndefined();
        });

        it("should return undefined for request with no Authorization header", async () => {
            const req = createMockRequest();
            const result = await provider.authenticate(req);
            expect(result).toBeUndefined();
        });

        it("should return undefined for non-Bearer authorization", async () => {
            const req = createMockRequest({
                authorization: "Basic dXNlcjpwYXNz",
            });
            const result = await provider.authenticate(req);
            expect(result).toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // Runtime helpers
    // -----------------------------------------------------------------------

    describe("addToken()", () => {
        it("should add a new token at runtime", async () => {
            const provider = new MemoryAuthProvider();
            expect(provider.getTokenCount()).toBe(0);

            const authResult = createTestAuthResult({ sub: "dynamic-user" });
            provider.addToken("dynamic-token", authResult);

            expect(provider.getTokenCount()).toBe(1);
            const result = await provider.validate("dynamic-token");
            expect(result?.sub).toBe("dynamic-user");
        });

        it("should overwrite an existing token", async () => {
            const provider = new MemoryAuthProvider({
                validTokens: {
                    "my-token": createTestAuthResult({ sub: "original" }),
                },
            });

            provider.addToken(
                "my-token",
                createTestAuthResult({ sub: "updated" })
            );

            expect(provider.getTokenCount()).toBe(1);
            const result = await provider.validate("my-token");
            expect(result?.sub).toBe("updated");
        });
    });

    describe("removeToken()", () => {
        it("should remove an existing token", async () => {
            const provider = new MemoryAuthProvider({
                validTokens: {
                    "remove-me": createTestAuthResult(),
                },
            });

            const removed = provider.removeToken("remove-me");
            expect(removed).toBe(true);
            expect(provider.getTokenCount()).toBe(0);

            const result = await provider.validate("remove-me");
            expect(result).toBeUndefined();
        });

        it("should return false when removing non-existent token", () => {
            const provider = new MemoryAuthProvider();
            const removed = provider.removeToken("nonexistent");
            expect(removed).toBe(false);
        });
    });

    describe("getTokenCount()", () => {
        it("should return 0 for empty provider", () => {
            const provider = new MemoryAuthProvider();
            expect(provider.getTokenCount()).toBe(0);
        });

        it("should return correct count after add/remove operations", () => {
            const provider = new MemoryAuthProvider();
            provider.addToken("a", createTestAuthResult({ sub: "a" }));
            provider.addToken("b", createTestAuthResult({ sub: "b" }));
            expect(provider.getTokenCount()).toBe(2);

            provider.removeToken("a");
            expect(provider.getTokenCount()).toBe(1);
        });
    });

    // -----------------------------------------------------------------------
    // Health & Shutdown
    // -----------------------------------------------------------------------

    describe("health()", () => {
        it("should always return true", async () => {
            const provider = new MemoryAuthProvider();
            expect(await provider.health()).toBe(true);
        });

        it("should return true even with no tokens", async () => {
            const provider = new MemoryAuthProvider({});
            expect(await provider.health()).toBe(true);
        });
    });

    describe("shutdown()", () => {
        it("should clear all tokens on shutdown", async () => {
            const provider = new MemoryAuthProvider({
                validTokens: {
                    "token-a": createTestAuthResult({ sub: "a" }),
                    "token-b": createTestAuthResult({ sub: "b" }),
                },
            });
            expect(provider.getTokenCount()).toBe(2);

            await provider.shutdown();

            expect(provider.getTokenCount()).toBe(0);
            expect(await provider.validate("token-a")).toBeUndefined();
            expect(await provider.validate("token-b")).toBeUndefined();
        });

        it("should be safe to call shutdown on empty provider", async () => {
            const provider = new MemoryAuthProvider();
            await provider.shutdown();
            expect(provider.getTokenCount()).toBe(0);
        });

        it("should be safe to call shutdown multiple times", async () => {
            const provider = new MemoryAuthProvider({
                validTokens: { t: createTestAuthResult() },
            });
            await provider.shutdown();
            await provider.shutdown();
            expect(provider.getTokenCount()).toBe(0);
        });
    });
});
