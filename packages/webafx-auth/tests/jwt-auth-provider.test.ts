/**
 * Tests for JwtAuthProvider — local JWT verification via jose.
 *
 * Covers:
 * - Valid HS256 token verification
 * - Expired token rejection
 * - Wrong secret rejection
 * - Issuer validation
 * - Audience validation
 * - Clock tolerance behavior
 * - Malformed/garbage token handling
 * - Full authenticate() lifecycle
 * - Health check and shutdown
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { JwtAuthProvider } from "../src/jwt-auth-provider.js";
import {
    TEST_SECRET,
    TEST_ISSUER,
    TEST_AUDIENCE,
    signTestJwt,
    signExpiredJwt,
    createBearerRequest,
    createMockRequest,
} from "./test-helpers.js";

describe("JwtAuthProvider", () => {
    let provider: JwtAuthProvider;

    beforeEach(() => {
        provider = new JwtAuthProvider({
            secret: TEST_SECRET,
            algorithms: ["HS256"],
            issuer: TEST_ISSUER,
            audience: TEST_AUDIENCE,
        });
    });

    afterEach(async () => {
        await provider.shutdown();
    });

    // -----------------------------------------------------------------------
    // Valid Token Verification
    // -----------------------------------------------------------------------

    describe("valid token verification", () => {
        it("should validate a correctly signed HS256 JWT", async () => {
            const token = await signTestJwt();
            const result = await provider.validate(token);

            expect(result).toBeDefined();
            expect(result?.sub).toBe("test-user-1");
            expect(result?.token).toBe(token);
        });

        it("should extract exp from JWT payload", async () => {
            const token = await signTestJwt();
            const result = await provider.validate(token);

            expect(result?.exp).toBeDefined();
            // exp should be ~1 hour from now (in seconds since epoch)
            const oneHourFromNow = Math.floor(Date.now() / 1000) + 3600;
            expect(result!.exp).toBeGreaterThan(oneHourFromNow - 10);
            expect(result!.exp).toBeLessThanOrEqual(oneHourFromNow + 10);
        });

        it("should include all JWT claims in the claims object", async () => {
            const token = await signTestJwt({
                claims: { role: "admin", department: "engineering" },
            });
            const result = await provider.validate(token);

            expect(result?.claims).toBeDefined();
            expect(result!.claims.role).toBe("admin");
            expect(result!.claims.department).toBe("engineering");
            expect(result!.claims.sub).toBe("test-user-1");
        });

        it("should extract scopes from space-separated scope claim", async () => {
            const token = await signTestJwt({
                claims: { scope: "read write admin" },
            });
            const result = await provider.validate(token);

            expect(result?.scopes).toEqual(["read", "write", "admin"]);
        });

        it("should validate token with custom subject", async () => {
            const token = await signTestJwt({ sub: "custom-user-42" });
            const result = await provider.validate(token);

            expect(result?.sub).toBe("custom-user-42");
        });
    });

    // -----------------------------------------------------------------------
    // Token Rejection
    // -----------------------------------------------------------------------

    describe("invalid token rejection", () => {
        it("should reject an expired token", async () => {
            const token = await signExpiredJwt();
            const result = await provider.validate(token);

            expect(result).toBeUndefined();
        });

        it("should reject a token signed with wrong secret", async () => {
            const token = await signTestJwt({
                secret: "wrong-secret-that-is-also-at-least-256-bits!!",
            });
            const result = await provider.validate(token);

            expect(result).toBeUndefined();
        });

        it("should reject a malformed token string", async () => {
            const result = await provider.validate("not-a-jwt");
            expect(result).toBeUndefined();
        });

        it("should reject an empty string", async () => {
            const result = await provider.validate("");
            expect(result).toBeUndefined();
        });

        it("should reject a token with valid structure but garbage data", async () => {
            const result = await provider.validate("aaa.bbb.ccc");
            expect(result).toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // Issuer Validation
    // -----------------------------------------------------------------------

    describe("issuer validation", () => {
        it("should reject a token with wrong issuer", async () => {
            const token = await signTestJwt({
                issuer: "https://wrong-issuer.example.com",
            });
            const result = await provider.validate(token);

            expect(result).toBeUndefined();
        });

        it("should accept a token with correct issuer", async () => {
            const token = await signTestJwt({ issuer: TEST_ISSUER });
            const result = await provider.validate(token);

            expect(result).toBeDefined();
            expect(result?.sub).toBe("test-user-1");
        });

        it("should skip issuer validation when not configured", async () => {
            // Create provider without issuer validation
            const noIssuerProvider = new JwtAuthProvider({
                secret: TEST_SECRET,
                algorithms: ["HS256"],
                audience: TEST_AUDIENCE,
            });

            const token = await signTestJwt({
                issuer: "https://any-issuer.example.com",
            });
            const result = await noIssuerProvider.validate(token);

            expect(result).toBeDefined();
            await noIssuerProvider.shutdown();
        });
    });

    // -----------------------------------------------------------------------
    // Audience Validation
    // -----------------------------------------------------------------------

    describe("audience validation", () => {
        it("should reject a token with wrong audience", async () => {
            const token = await signTestJwt({
                audience: "wrong-client-id",
            });
            const result = await provider.validate(token);

            expect(result).toBeUndefined();
        });

        it("should accept a token with correct audience", async () => {
            const token = await signTestJwt({ audience: TEST_AUDIENCE });
            const result = await provider.validate(token);

            expect(result).toBeDefined();
        });

        it("should skip audience validation when not configured", async () => {
            const noAudienceProvider = new JwtAuthProvider({
                secret: TEST_SECRET,
                algorithms: ["HS256"],
                issuer: TEST_ISSUER,
            });

            const token = await signTestJwt({
                audience: "any-audience",
            });
            const result = await noAudienceProvider.validate(token);

            expect(result).toBeDefined();
            await noAudienceProvider.shutdown();
        });
    });

    // -----------------------------------------------------------------------
    // Clock Tolerance
    // -----------------------------------------------------------------------

    describe("clock tolerance", () => {
        it("should accept a recently-expired token with sufficient tolerance", async () => {
            const tolerantProvider = new JwtAuthProvider({
                secret: TEST_SECRET,
                algorithms: ["HS256"],
                issuer: TEST_ISSUER,
                audience: TEST_AUDIENCE,
                clockTolerance: 120, // 2 minutes
            });

            // Token expired 30 seconds ago — within the 120s tolerance
            const recentlyExpired = Math.floor(Date.now() / 1000) - 30;
            const token = await signTestJwt({ exp: recentlyExpired });
            const result = await tolerantProvider.validate(token);

            expect(result).toBeDefined();
            await tolerantProvider.shutdown();
        });

        it("should reject a long-expired token even with tolerance", async () => {
            const tolerantProvider = new JwtAuthProvider({
                secret: TEST_SECRET,
                algorithms: ["HS256"],
                issuer: TEST_ISSUER,
                audience: TEST_AUDIENCE,
                clockTolerance: 60, // 1 minute
            });

            // Token expired 5 minutes ago — exceeds the 60s tolerance
            const longExpired = Math.floor(Date.now() / 1000) - 300;
            const token = await signTestJwt({ exp: longExpired });
            const result = await tolerantProvider.validate(token);

            expect(result).toBeUndefined();
            await tolerantProvider.shutdown();
        });
    });

    // -----------------------------------------------------------------------
    // Full authenticate() lifecycle
    // -----------------------------------------------------------------------

    describe("authenticate()", () => {
        it("should authenticate a request with valid Bearer JWT", async () => {
            const token = await signTestJwt();
            const req = createBearerRequest(token);
            const result = await provider.authenticate(req);

            expect(result).toBeDefined();
            expect(result?.sub).toBe("test-user-1");
        });

        it("should return undefined for request with invalid JWT", async () => {
            const req = createBearerRequest("not-a-valid-jwt");
            const result = await provider.authenticate(req);

            expect(result).toBeUndefined();
        });

        it("should return undefined for request without Authorization header", async () => {
            const req = createMockRequest();
            const result = await provider.authenticate(req);

            expect(result).toBeUndefined();
        });

        it("should return undefined for expired JWT in Bearer header", async () => {
            const token = await signExpiredJwt();
            const req = createBearerRequest(token);
            const result = await provider.authenticate(req);

            expect(result).toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // Health & Shutdown
    // -----------------------------------------------------------------------

    describe("health()", () => {
        it("should return true when secret is configured", async () => {
            expect(await provider.health()).toBe(true);
        });
    });

    describe("shutdown()", () => {
        it("should clear cached key material", async () => {
            // First validate to populate the key cache
            const token = await signTestJwt();
            await provider.validate(token);

            await provider.shutdown();

            // Provider should still work after shutdown (key re-created lazily)
            const result = await provider.validate(token);
            expect(result).toBeDefined();
        });

        it("should be safe to call multiple times", async () => {
            await provider.shutdown();
            await provider.shutdown();
            // No error thrown
        });
    });

    // -----------------------------------------------------------------------
    // Default algorithm behavior
    // -----------------------------------------------------------------------

    describe("default algorithm", () => {
        it("should default to HS256 when algorithms not specified", async () => {
            const defaultProvider = new JwtAuthProvider({
                secret: TEST_SECRET,
            });

            // Sign with HS256 (default) — should work
            const token = await signTestJwt();
            const result = await defaultProvider.validate(token);

            expect(result).toBeDefined();
            await defaultProvider.shutdown();
        });
    });
});
