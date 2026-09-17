/**
 * Specification tests for the OIDC principal discriminator.
 *
 * The OIDC provider has two authentication paths: a Bearer token and a session
 * cookie. The bearer path stamps the configured `principalType`; the session
 * cookie path always reports `'user'`, because a session is an interactive user
 * session regardless of configuration.
 *
 * These cases mock `jose`/`openid-client` file-wide, so they live apart from the
 * real-`jose` cases in `principal-discriminator.spec.test.ts`.
 *
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
} from "./test-helpers.js";

vi.mock("openid-client", async () => {
    const actual = await vi.importActual<typeof client>("openid-client");
    return {
        ...actual,
        discovery: vi.fn(),
        createRemoteJWKSet: vi.fn(() => vi.fn()),
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

const mockConfiguration = {
    serverMetadata: () => ({
        issuer: "https://auth.example.com",
        jwks_uri: "https://auth.example.com/.well-known/jwks.json",
    }),
} as unknown as client.Configuration;

const baseConfig: OidcAuthConfig = {
    issuerUrl: "https://auth.example.com",
    clientId: "test-client",
    clientSecret: "test-secret",
    audience: "https://api.example.com",
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.discovery).mockResolvedValue(mockConfiguration);
    vi.mocked(jose.jwtVerify).mockResolvedValue({
        payload: {
            sub: "user-1",
            iss: "https://auth.example.com",
            aud: "https://api.example.com",
            exp: Math.floor(Date.now() / 1000) + 3600,
        },
        protectedHeader: { alg: "RS256" },
    } as any);
});

describe("Specification: OIDC principal discriminator", () => {
    it("reports the session-cookie path as a user even when the config says client", async () => {
        const { provider: cacheProvider, store } = createMockCacheProvider();
        const sessionId = "session-1";
        store.set(`oidc:session:${sessionId}`, { value: createSampleSession(), expiresAt: 0 });
        const provider = new OidcAuthProvider({
            ...baseConfig,
            sessionStore: cacheProvider,
            principalType: "client",
        });

        const result = await provider.authenticate(
            createMockRequest({ headers: { cookie: `__oidc_session=${sessionId}` } })
        );

        expect(result).toBeDefined();
        expect(result?.principalType).toBe("user");
    });

    it("stamps the configured type on the bearer path", async () => {
        const provider = new OidcAuthProvider({ ...baseConfig, principalType: "client" });

        const result = await provider.authenticate(createBearerRequest("valid-bearer-token"));

        expect(result?.principalType).toBe("client");
    });
});
