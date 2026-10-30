/**
 * Specification tests for the AuthResult principal discriminator.
 *
 * These tests encode the expected classification: a provider can be configured
 * with a static `principalType`, which is stamped on an authenticated result
 * unless a custom mapper or stored result already sets it. Providers with no
 * configuration leave the field undefined.
 *
 * These cases use the real `jose` implementation; the OIDC bearer/session cases
 * live in `principal-discriminator-oidc.spec.test.ts` because they mock `jose`.
 *
 * @packageDocumentation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { JwtAuthProvider } from "../src/jwt-auth-provider.js";
import { MemoryAuthProvider } from "../src/memory-auth-provider.js";
import { IntrospectionAuthProvider } from "../src/introspection-auth-provider.js";
import { createAuthProvider } from "../src/auth-factory.js";
import type { AuthProviderConfig, JwtAuthConfig } from "../src/types.js";
import {
    createBearerRequest,
    signTestJwt,
    TEST_SECRET,
    TEST_ISSUER,
    TEST_AUDIENCE,
} from "./test-helpers.js";

/** Base JWT config shared by the cases. */
const JWT_BASE: JwtAuthConfig = {
    secret: TEST_SECRET,
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
};

/** Static introspection config for the introspection case. */
const INTROSPECTION_BASE: AuthProviderConfig & {
    introspectionUrl: string;
    clientId: string;
    clientSecret: string;
} = {
    introspectionUrl: "https://auth.example.com/oauth2/introspect",
    clientId: "client-1",
    clientSecret: "secret-1",
};

/** A minimal fetch Response stand-in for the introspection call. */
function jsonResponse(body: unknown): Response {
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("Specification: principal discriminator", () => {
    it("stamps the configured type on a JWT result", async () => {
        const provider = new JwtAuthProvider({ ...JWT_BASE, principalType: "user" });
        const result = await provider.validate(await signTestJwt());

        expect(result?.principalType).toBe("user");
    });

    it("leaves the type unset when neither config nor mapper sets it", async () => {
        const provider = new JwtAuthProvider({ ...JWT_BASE });
        const result = await provider.validate(await signTestJwt());

        expect(result?.principalType).toBeUndefined();
    });

    it("leaves the type unset when a custom mapper does not set it", async () => {
        const provider = new JwtAuthProvider({
            ...JWT_BASE,
            mapClaims: (token, claims) => ({
                sub: String(claims.sub),
                claims,
                token,
            }),
        });
        const result = await provider.validate(await signTestJwt());

        expect(result?.principalType).toBeUndefined();
    });

    it("keeps a value set by a custom mapper over the configured type", async () => {
        const provider = new JwtAuthProvider({
            ...JWT_BASE,
            principalType: "client",
            mapClaims: (token, claims) => ({
                sub: String(claims.sub),
                claims,
                token,
                principalType: "user",
            }),
        });
        const result = await provider.validate(await signTestJwt());

        expect(result?.principalType).toBe("user");
    });

    it("stamps the configured type on an introspection result", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({
                active: true,
                sub: "client-1",
                exp: Math.floor(Date.now() / 1000) + 3600,
            })
        );
        const provider = new IntrospectionAuthProvider({
            ...INTROSPECTION_BASE,
            principalType: "client",
        });

        const result = await provider.authenticate(createBearerRequest("opaque-token"));

        expect(result?.principalType).toBe("client");
    });

    it("passes through the principal type stored on a memory result", async () => {
        const provider = new MemoryAuthProvider({
            validTokens: {
                "memory-token": { sub: "user-9", claims: {}, token: "memory-token", principalType: "user" },
            },
        });

        const result = await provider.validate("memory-token");

        expect(result?.principalType).toBe("user");
    });

    it("forwards the configured type through createAuthProvider", async () => {
        const provider = createAuthProvider({ type: "jwt", ...JWT_BASE, principalType: "client" });

        const result = await provider.validate(await signTestJwt());

        expect(result?.principalType).toBe("client");
    });
});
