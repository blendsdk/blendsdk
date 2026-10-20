/**
 * Implementation tests for createAuthProvider().
 *
 * Covers configuration pass-through into the constructed providers and the
 * exact validation error messages, which are not part of the specification
 * behavior but matter for diagnosing misconfiguration.
 *
 * @packageDocumentation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createAuthProvider } from "../src/auth-factory.js";
import type { AuthResult } from "../src/types.js";
import { createBearerRequest, signTestJwt, TEST_SECRET } from "./test-helpers.js";

const TOKEN = "factory-impl-token";

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * Build a minimal fetch Response stand-in.
 *
 * @param body - Parsed JSON body
 * @returns A Response-shaped object
 */
function jsonResponse(body: unknown): Response {
    return {
        ok: true,
        status: 200,
        json: async () => body,
    } as unknown as Response;
}

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("Implementation: createAuthProvider", () => {
    it("forwards the base serviceName to the provider", () => {
        const provider = createAuthProvider({
            type: "memory",
            serviceName: "custom-auth",
        });

        expect(provider.serviceName).toBe("custom-auth");
    });

    it("forwards a custom mapClaims to the introspection provider", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ active: true, sub: "u", exp: 4102444800 })
        );
        const mapClaims = (
            token: string,
            claims: Record<string, unknown>
        ): AuthResult => ({
            sub: "mapped",
            claims,
            token,
            scopes: ["mapped"],
        });

        const provider = createAuthProvider({
            type: "introspection",
            introspectionUrl: "https://auth.example.com/introspect",
            clientId: "client",
            clientSecret: "secret",
            mapClaims,
        });

        const result = await provider.authenticate(createBearerRequest(TOKEN));

        expect(result?.sub).toBe("mapped");
        expect(result?.scopes).toEqual(["mapped"]);
    });

    it("forwards authMethod 'post' to the introspection provider", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ active: true, sub: "u" }));
        const provider = createAuthProvider({
            type: "introspection",
            introspectionUrl: "https://auth.example.com/introspect",
            clientId: "client",
            clientSecret: "secret",
            authMethod: "post",
        });

        await provider.authenticate(createBearerRequest(TOKEN));

        const init = fetchMock.mock.calls[0][1] as RequestInit;
        const body = new URLSearchParams(init.body as string);
        expect(body.get("client_secret")).toBe("secret");
        expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    });

    it("forwards validTokens to the memory provider", async () => {
        const result: AuthResult = {
            sub: "memory-user",
            claims: {},
            token: TOKEN,
        };
        const provider = createAuthProvider({
            type: "memory",
            validTokens: { [TOKEN]: result },
        });

        await expect(provider.validate(TOKEN)).resolves.toEqual(result);
    });

    it("throws a field-specific message when jwt has no secret", () => {
        expect(() => createAuthProvider({ type: "jwt" })).toThrow(
            "createAuthProvider: type 'jwt' requires 'secret'"
        );
    });

    it("throws a field-specific message when oidc has no issuerUrl", () => {
        expect(() => createAuthProvider({ type: "oidc" })).toThrow(
            "createAuthProvider: type 'oidc' requires 'issuerUrl'"
        );
    });

    it("throws a field-specific message when introspection has no credentials", () => {
        expect(() => createAuthProvider({ type: "introspection" })).toThrow(
            "createAuthProvider: type 'introspection' requires 'introspectionUrl', 'clientId' and 'clientSecret', or 'configFactory'"
        );
    });
});

// ---------------------------------------------------------------------------
// requireAudience pass-through
// ---------------------------------------------------------------------------

describe("Implementation: createAuthProvider requireAudience pass-through", () => {
    it("builds a jwt provider that fails closed when requireAudience is set", async () => {
        const provider = createAuthProvider({
            type: "jwt",
            secret: TEST_SECRET,
            requireAudience: true,
        });

        const token = await signTestJwt();
        expect(await provider.validate(token)).toBeUndefined();

        await provider.shutdown();
    });

    it("builds an oidc provider that fails closed when requireAudience is set", async () => {
        const provider = createAuthProvider({
            type: "oidc",
            issuerUrl: "https://auth.example.com",
            clientId: "test-client",
            requireAudience: true,
        });

        // No audience is configured, so the gate rejects without discovery.
        expect(await provider.validate("opaque-token")).toBeUndefined();

        await provider.shutdown();
    });
});
