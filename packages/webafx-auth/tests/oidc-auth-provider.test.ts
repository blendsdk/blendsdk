/**
 * Tests for OidcAuthProvider — OIDC discovery-based JWT validation and BFF methods.
 *
 * Mocking strategy:
 * - `openid-client` is fully mocked (discovery, BFF ops, random generators)
 * - `jose` is fully mocked (jwtVerify, createRemoteJWKSet)
 * - Tests validate provider logic, not cryptographic correctness
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
    createMockTokenResponse,
    createMockOidcConfig,
} from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Module Mocks
// ---------------------------------------------------------------------------

// Mock openid-client — BFF operations and discovery
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

// Mock jose — JWT validation
vi.mock("jose", async () => {
    const actual = await vi.importActual<typeof jose>("jose");
    return {
        ...actual,
        jwtVerify: vi.fn(),
        createRemoteJWKSet: vi.fn(() => vi.fn()),
    };
});

// ---------------------------------------------------------------------------
// Shared Test Fixtures
// ---------------------------------------------------------------------------

/** Reusable mock server metadata returned by discovery */
const mockServerMetadata = {
    issuer: "https://auth.example.com",
    jwks_uri: "https://auth.example.com/.well-known/jwks.json",
    authorization_endpoint: "https://auth.example.com/authorize",
    token_endpoint: "https://auth.example.com/token",
    userinfo_endpoint: "https://auth.example.com/userinfo",
    revocation_endpoint: "https://auth.example.com/revoke",
};

/** Mock openid-client Configuration with serverMetadata() */
const mockConfiguration = {
    serverMetadata: () => mockServerMetadata,
} as unknown as client.Configuration;

/** Standard test config — static single-tenant */
const testConfig: OidcAuthConfig = {
    serviceName: "oidc-test",
    issuerUrl: "https://auth.example.com",
    clientId: "test-client",
    clientSecret: "test-secret",
    redirectUri: "https://app.example.com/callback",
    audience: "https://api.example.com",
};

/** Standard JWT claims returned by mocked jwtVerify */
const defaultClaims = {
    sub: "user-1",
    iss: "https://auth.example.com",
    aud: "https://api.example.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.clearAllMocks();

    // Default: discovery returns mockConfiguration
    vi.mocked(client.discovery).mockResolvedValue(mockConfiguration);

    // Default: jwtVerify returns valid claims
    vi.mocked(jose.jwtVerify).mockResolvedValue({
        payload: { ...defaultClaims },
        protectedHeader: { alg: "RS256" },
    } as any);

    // Default: createRemoteJWKSet returns a mock key resolver
    vi.mocked(jose.createRemoteJWKSet).mockReturnValue(vi.fn() as any);

    // Default: buildAuthorizationUrl returns a mock URL
    vi.mocked(client.buildAuthorizationUrl).mockReturnValue(
        new URL("https://auth.example.com/authorize?response_type=code")
    );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OidcAuthProvider", () => {
    // -------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------
    describe("constructor", () => {
        it("should create with static config (issuerUrl + clientId)", () => {
            const provider = new OidcAuthProvider(testConfig);
            expect(provider).toBeInstanceOf(OidcAuthProvider);
        });

        it("should create with configFactory only", () => {
            const provider = new OidcAuthProvider({
                serviceName: "oidc-factory",
                configFactory: async () => createMockOidcConfig(),
            });
            expect(provider).toBeInstanceOf(OidcAuthProvider);
        });

        it("should create with both issuerUrl and configFactory", () => {
            const provider = new OidcAuthProvider({
                ...testConfig,
                configFactory: async () => createMockOidcConfig(),
            });
            expect(provider).toBeInstanceOf(OidcAuthProvider);
        });

        it("should throw when neither issuerUrl nor configFactory provided", () => {
            expect(
                () =>
                    new OidcAuthProvider({
                        serviceName: "oidc-invalid",
                    })
            ).toThrow(
                "OidcAuthProvider requires either issuerUrl or configFactory"
            );
        });
    });

    // -------------------------------------------------------------------
    // Discovery Caching
    // -------------------------------------------------------------------
    describe("discovery caching", () => {
        it("should call discovery and createRemoteJWKSet on first use", async () => {
            const provider = new OidcAuthProvider(testConfig);
            await provider.validate("some-token");

            expect(client.discovery).toHaveBeenCalledOnce();
            expect(jose.createRemoteJWKSet).toHaveBeenCalledOnce();
        });

        it("should return cached config within TTL", async () => {
            const provider = new OidcAuthProvider(testConfig);

            // First call triggers discovery
            await provider.validate("token-1");
            expect(client.discovery).toHaveBeenCalledTimes(1);

            // Second call should use cache
            await provider.validate("token-2");
            expect(client.discovery).toHaveBeenCalledTimes(1);
        });

        it("should refresh cache after TTL expires", async () => {
            // Use a very short TTL (1 second)
            const provider = new OidcAuthProvider({
                ...testConfig,
                discoveryTtl: 1,
            });

            // First call triggers discovery
            await provider.validate("token-1");
            expect(client.discovery).toHaveBeenCalledTimes(1);

            // Advance time past TTL
            vi.useFakeTimers();
            vi.advanceTimersByTime(1500);

            // Second call should re-discover
            await provider.validate("token-2");
            expect(client.discovery).toHaveBeenCalledTimes(2);

            vi.useRealTimers();
        });

        it("should respect custom discoveryTtl", async () => {
            const provider = new OidcAuthProvider({
                ...testConfig,
                discoveryTtl: 60, // 60 seconds
            });

            await provider.validate("token-1");
            expect(client.discovery).toHaveBeenCalledTimes(1);

            // Advance time but within TTL
            vi.useFakeTimers();
            vi.advanceTimersByTime(30_000); // 30s — within 60s TTL

            await provider.validate("token-2");
            // Should still be cached
            expect(client.discovery).toHaveBeenCalledTimes(1);

            vi.useRealTimers();
        });

        it("should cache separately per issuerUrl", async () => {
            const provider = new OidcAuthProvider({
                serviceName: "oidc-multi",
                configFactory: async (req) => {
                    const tenant = req.headers["x-tenant-id"] as string;
                    return createMockOidcConfig({
                        issuerUrl: `https://${tenant}.auth.example.com`,
                        clientId: `${tenant}-client`,
                    });
                },
            });

            // Request for tenant A
            const reqA = createMockRequest({
                authorization: "Bearer token-a",
                headers: { "x-tenant-id": "tenant-a" },
            });
            await provider.authenticate(reqA);

            // Request for tenant B
            const reqB = createMockRequest({
                authorization: "Bearer token-b",
                headers: { "x-tenant-id": "tenant-b" },
            });
            await provider.authenticate(reqB);

            // Discovery should have been called twice — once per issuerUrl
            expect(client.discovery).toHaveBeenCalledTimes(2);
        });

        it("should throw when discovery metadata lacks jwks_uri", async () => {
            // Mock discovery returning metadata without jwks_uri
            const noJwksConfig = {
                serverMetadata: () => ({
                    issuer: "https://auth.example.com",
                    // Missing jwks_uri
                }),
            } as unknown as client.Configuration;
            vi.mocked(client.discovery).mockResolvedValue(noJwksConfig);

            const provider = new OidcAuthProvider(testConfig);

            // validate() catches and returns undefined (silent)
            const result = await provider.validate("some-token");
            expect(result).toBeUndefined();
        });
    });

    // -------------------------------------------------------------------
    // validate()
    // -------------------------------------------------------------------
    describe("validate()", () => {
        it("should validate token with static config via jose.jwtVerify", async () => {
            const provider = new OidcAuthProvider(testConfig);
            const result = await provider.validate("valid-token");

            expect(result).toBeDefined();
            expect(result!.sub).toBe("user-1");
            expect(result!.token).toBe("valid-token");
            expect(jose.jwtVerify).toHaveBeenCalledWith(
                "valid-token",
                expect.any(Function), // mock JWKS resolver
                expect.objectContaining({
                    issuer: "https://auth.example.com",
                    clockTolerance: 30,
                    audience: "https://api.example.com",
                })
            );
        });

        it("should return undefined for invalid token (jwtVerify throws)", async () => {
            vi.mocked(jose.jwtVerify).mockRejectedValue(
                new Error("invalid signature")
            );

            const provider = new OidcAuthProvider(testConfig);
            const result = await provider.validate("bad-token");

            expect(result).toBeUndefined();
        });

        it("should return undefined when only configFactory configured", async () => {
            const provider = new OidcAuthProvider({
                serviceName: "oidc-factory-only",
                configFactory: async () => createMockOidcConfig(),
            });

            const result = await provider.validate("some-token");
            expect(result).toBeUndefined();
            // Should NOT call discovery — no static config
            expect(client.discovery).not.toHaveBeenCalled();
        });

        it("should apply mapClaims transformation", async () => {
            const provider = new OidcAuthProvider({
                ...testConfig,
                mapClaims: (token, claims) => ({
                    sub: String(claims.sub),
                    claims,
                    token,
                    scopes: ["custom-scope"],
                }),
            });

            const result = await provider.validate("mapped-token");
            expect(result).toBeDefined();
            expect(result!.scopes).toEqual(["custom-scope"]);
        });

        it("should use default clockTolerance of 30 seconds", async () => {
            const provider = new OidcAuthProvider({
                ...testConfig,
                clockTolerance: undefined, // Explicitly unset
            });

            await provider.validate("token");
            expect(jose.jwtVerify).toHaveBeenCalledWith(
                "token",
                expect.any(Function),
                expect.objectContaining({ clockTolerance: 30 })
            );
        });

        it("should pass custom clockTolerance to jwtVerify", async () => {
            const provider = new OidcAuthProvider({
                ...testConfig,
                clockTolerance: 60,
            });

            await provider.validate("token");
            expect(jose.jwtVerify).toHaveBeenCalledWith(
                "token",
                expect.any(Function),
                expect.objectContaining({ clockTolerance: 60 })
            );
        });

        it("should pass audience string to jwtVerify", async () => {
            const provider = new OidcAuthProvider({
                ...testConfig,
                audience: "single-audience",
            });

            await provider.validate("token");
            expect(jose.jwtVerify).toHaveBeenCalledWith(
                "token",
                expect.any(Function),
                expect.objectContaining({ audience: "single-audience" })
            );
        });

        it("should pass audience array to jwtVerify", async () => {
            const provider = new OidcAuthProvider({
                ...testConfig,
                audience: ["aud-1", "aud-2"],
            });

            await provider.validate("token");
            expect(jose.jwtVerify).toHaveBeenCalledWith(
                "token",
                expect.any(Function),
                expect.objectContaining({ audience: ["aud-1", "aud-2"] })
            );
        });
    });

    // -------------------------------------------------------------------
    // authenticate()
    // -------------------------------------------------------------------
    describe("authenticate()", () => {
        it("should validate token from request using static config", async () => {
            const provider = new OidcAuthProvider(testConfig);
            const req = createBearerRequest("valid-token");

            const result = await provider.authenticate(req);
            expect(result).toBeDefined();
            expect(result!.sub).toBe("user-1");
        });

        it("should resolve config via configFactory per request", async () => {
            const factoryFn = vi.fn(async () =>
                createMockOidcConfig({
                    issuerUrl: "https://tenant.auth.example.com",
                    clientId: "tenant-client",
                })
            );

            const provider = new OidcAuthProvider({
                serviceName: "oidc-factory",
                configFactory: factoryFn,
            });

            const req = createBearerRequest("factory-token");
            await provider.authenticate(req);

            expect(factoryFn).toHaveBeenCalledWith(req);
            expect(client.discovery).toHaveBeenCalledWith(
                new URL("https://tenant.auth.example.com"),
                "tenant-client",
                undefined
            );
        });

        it("should return undefined when no token in request", async () => {
            const provider = new OidcAuthProvider(testConfig);
            const req = createMockRequest(); // No token

            const result = await provider.authenticate(req);
            expect(result).toBeUndefined();
        });

        it("should return undefined when configFactory throws", async () => {
            const provider = new OidcAuthProvider({
                serviceName: "oidc-factory-error",
                configFactory: async () => {
                    throw new Error("tenant lookup failed");
                },
            });

            const req = createBearerRequest("some-token");
            const result = await provider.authenticate(req);
            expect(result).toBeUndefined();
        });

        it("should return undefined when discovery fails", async () => {
            vi.mocked(client.discovery).mockRejectedValue(
                new Error("network error")
            );

            const provider = new OidcAuthProvider(testConfig);
            const req = createBearerRequest("some-token");

            const result = await provider.authenticate(req);
            expect(result).toBeUndefined();
        });

        it("should prefer resolveUser over mapClaims (AR #8)", async () => {
            const resolveUser = vi.fn(async (_req, claims) => ({
                sub: String(claims.sub),
                claims,
                token: "resolved-token",
                scopes: ["resolved"],
            }));

            const mapClaims = vi.fn((_token, _claims) => ({
                sub: "mapped",
                claims: {},
                token: "mapped-token",
            }));

            const provider = new OidcAuthProvider({
                ...testConfig,
                resolveUser,
                mapClaims,
            });

            const req = createBearerRequest("token");
            const result = await provider.authenticate(req);

            // resolveUser should be called, mapClaims should NOT
            expect(resolveUser).toHaveBeenCalledOnce();
            expect(mapClaims).not.toHaveBeenCalled();
            expect(result!.scopes).toEqual(["resolved"]);
        });

        it("should fall back to mapClaims when no resolveUser", async () => {
            const mapClaims = vi.fn((token, claims) => ({
                sub: String(claims.sub),
                claims,
                token,
                scopes: ["mapped"],
            }));

            const provider = new OidcAuthProvider({
                ...testConfig,
                mapClaims,
            });

            const req = createBearerRequest("token");
            const result = await provider.authenticate(req);

            expect(mapClaims).toHaveBeenCalledOnce();
            expect(result!.scopes).toEqual(["mapped"]);
        });

        it("should return raw claims via claimsMapper when no resolver configured", async () => {
            const provider = new OidcAuthProvider({
                ...testConfig,
                // No resolveUser, no mapClaims
            });

            const req = createBearerRequest("token");
            const result = await provider.authenticate(req);

            // Should use default claimsMapper from base class
            expect(result).toBeDefined();
            expect(result!.sub).toBe("user-1");
        });
    });

    // -------------------------------------------------------------------
    // health()
    // -------------------------------------------------------------------
    describe("health()", () => {
        it("should return true when static config set and discovery succeeds", async () => {
            const provider = new OidcAuthProvider(testConfig);
            const result = await provider.health();
            expect(result).toBe(true);
        });

        it("should return false when no static config", async () => {
            const provider = new OidcAuthProvider({
                serviceName: "oidc-factory-only",
                configFactory: async () => createMockOidcConfig(),
            });
            const result = await provider.health();
            expect(result).toBe(false);
        });

        it("should return false when discovery fails", async () => {
            vi.mocked(client.discovery).mockRejectedValue(
                new Error("network error")
            );
            const provider = new OidcAuthProvider(testConfig);
            const result = await provider.health();
            expect(result).toBe(false);
        });
    });

    // -------------------------------------------------------------------
    // shutdown()
    // -------------------------------------------------------------------
    describe("shutdown()", () => {
        it("should clear discovery cache", async () => {
            const provider = new OidcAuthProvider(testConfig);

            // Populate cache
            await provider.validate("token");
            expect(client.discovery).toHaveBeenCalledTimes(1);

            // Shutdown clears cache
            await provider.shutdown();

            // Next call should re-discover
            await provider.validate("token-2");
            expect(client.discovery).toHaveBeenCalledTimes(2);
        });
    });

    // -------------------------------------------------------------------
    // buildAuthorizationUrl()
    // -------------------------------------------------------------------
    describe("buildAuthorizationUrl()", () => {
        it("should build URL with PKCE, state, and nonce", async () => {
            const provider = new OidcAuthProvider(testConfig);
            const result = await provider.buildAuthorizationUrl();

            expect(result.url).toContain("https://auth.example.com/authorize");
            expect(result.codeVerifier).toBe("mock-code-verifier");
            expect(result.state).toBe("mock-state");
            expect(result.nonce).toBe("mock-nonce");

            // Verify PKCE and params were passed to openid-client
            expect(client.buildAuthorizationUrl).toHaveBeenCalledWith(
                mockConfiguration,
                expect.objectContaining({
                    redirect_uri: "https://app.example.com/callback",
                    scope: "openid profile email",
                    code_challenge: "mock-code-challenge",
                    code_challenge_method: "S256",
                    state: "mock-state",
                    nonce: "mock-nonce",
                })
            );
        });

        it("should allow param overrides for clientId, redirectUri, scopes", async () => {
            const provider = new OidcAuthProvider(testConfig);
            await provider.buildAuthorizationUrl(undefined, {
                clientId: "override-client",
                redirectUri: "https://other.example.com/cb",
                scopes: ["openid", "custom"],
            });

            // Discovery should use the overridden clientId
            expect(client.discovery).toHaveBeenCalledWith(
                new URL("https://auth.example.com"),
                "override-client",
                "test-secret"
            );

            expect(client.buildAuthorizationUrl).toHaveBeenCalledWith(
                mockConfiguration,
                expect.objectContaining({
                    redirect_uri: "https://other.example.com/cb",
                    scope: "openid custom",
                })
            );
        });

        it("should pass extra OIDC parameters", async () => {
            const provider = new OidcAuthProvider(testConfig);
            await provider.buildAuthorizationUrl(undefined, {
                extraParams: { prompt: "consent", login_hint: "user@example.com" },
            });

            expect(client.buildAuthorizationUrl).toHaveBeenCalledWith(
                mockConfiguration,
                expect.objectContaining({
                    prompt: "consent",
                    login_hint: "user@example.com",
                })
            );
        });

        it("should throw when clientId is missing", async () => {
            const provider = new OidcAuthProvider({
                serviceName: "oidc-no-client",
                issuerUrl: "https://auth.example.com",
                // No clientId
            });

            await expect(
                provider.buildAuthorizationUrl()
            ).rejects.toThrow("clientId is required for buildAuthorizationUrl");
        });

        it("should throw when redirectUri is missing", async () => {
            const provider = new OidcAuthProvider({
                ...testConfig,
                redirectUri: undefined,
            });

            await expect(
                provider.buildAuthorizationUrl()
            ).rejects.toThrow(
                "redirectUri is required for buildAuthorizationUrl"
            );
        });

        it("should default scopes to openid, profile, email", async () => {
            const provider = new OidcAuthProvider({
                ...testConfig,
                scopes: undefined, // Explicitly unset
            });
            await provider.buildAuthorizationUrl();

            expect(client.buildAuthorizationUrl).toHaveBeenCalledWith(
                mockConfiguration,
                expect.objectContaining({
                    scope: "openid profile email",
                })
            );
        });
    });

    // -------------------------------------------------------------------
    // exchangeCode()
    // -------------------------------------------------------------------
    describe("exchangeCode()", () => {
        it("should exchange code and return OidcTokens", async () => {
            const mockResponse = createMockTokenResponse();
            vi.mocked(client.authorizationCodeGrant).mockResolvedValue(
                mockResponse as any
            );

            const provider = new OidcAuthProvider(testConfig);
            const result = await provider.exchangeCode({
                codeVerifier: "verifier-123",
                callbackUrl:
                    "https://app.example.com/callback?code=auth-code&state=xyz",
            });

            expect(result.accessToken).toBe("mock-access-token");
            expect(result.tokenType).toBe("Bearer");
            expect(result.expiresIn).toBe(3600);
            expect(result.refreshToken).toBe("mock-refresh-token");
            expect(result.idToken).toBe("mock-id-token");
            expect(result.scope).toBe("openid profile email");
        });

        it("should pass expectedNonce for nonce validation (AR #15)", async () => {
            vi.mocked(client.authorizationCodeGrant).mockResolvedValue(
                createMockTokenResponse() as any
            );

            const provider = new OidcAuthProvider(testConfig);
            await provider.exchangeCode({
                codeVerifier: "verifier",
                nonce: "expected-nonce-123",
                callbackUrl: "https://app.example.com/callback?code=abc",
            });

            expect(client.authorizationCodeGrant).toHaveBeenCalledWith(
                mockConfiguration,
                expect.any(URL),
                expect.objectContaining({
                    pkceCodeVerifier: "verifier",
                    expectedNonce: "expected-nonce-123",
                    expectedState: client.skipStateCheck,
                })
            );
        });

        it("should throw when issuerUrl/clientId missing", async () => {
            const provider = new OidcAuthProvider({
                serviceName: "oidc-no-config",
                configFactory: async () => createMockOidcConfig(),
            });

            await expect(
                provider.exchangeCode({
                    codeVerifier: "verifier",
                    callbackUrl: "https://app.example.com/callback?code=abc",
                })
            ).rejects.toThrow(
                "issuerUrl and clientId are required for exchangeCode"
            );
        });

        it("should propagate openid-client errors", async () => {
            vi.mocked(client.authorizationCodeGrant).mockRejectedValue(
                new Error("invalid_grant")
            );

            const provider = new OidcAuthProvider(testConfig);
            await expect(
                provider.exchangeCode({
                    codeVerifier: "verifier",
                    callbackUrl: "https://app.example.com/callback?code=bad",
                })
            ).rejects.toThrow("invalid_grant");
        });
    });

    // -------------------------------------------------------------------
    // refreshToken()
    // -------------------------------------------------------------------
    describe("refreshToken()", () => {
        it("should refresh and return new OidcTokens", async () => {
            const mockResponse = createMockTokenResponse({
                access_token: "new-access-token",
                refresh_token: "new-refresh-token",
            });
            vi.mocked(client.refreshTokenGrant).mockResolvedValue(
                mockResponse as any
            );

            const provider = new OidcAuthProvider(testConfig);
            const result = await provider.refreshToken("old-refresh-token");

            expect(result.accessToken).toBe("new-access-token");
            expect(result.refreshToken).toBe("new-refresh-token");
            expect(client.refreshTokenGrant).toHaveBeenCalledWith(
                mockConfiguration,
                "old-refresh-token"
            );
        });

        it("should throw when config missing", async () => {
            const provider = new OidcAuthProvider({
                serviceName: "oidc-no-config",
                configFactory: async () => createMockOidcConfig(),
            });

            await expect(
                provider.refreshToken("some-refresh-token")
            ).rejects.toThrow(
                "issuerUrl and clientId are required for refreshToken"
            );
        });
    });

    // -------------------------------------------------------------------
    // revokeToken()
    // -------------------------------------------------------------------
    describe("revokeToken()", () => {
        it("should revoke token successfully", async () => {
            vi.mocked(client.tokenRevocation).mockResolvedValue(
                undefined as any
            );

            const provider = new OidcAuthProvider(testConfig);
            await provider.revokeToken("token-to-revoke");

            expect(client.tokenRevocation).toHaveBeenCalledWith(
                mockConfiguration,
                "token-to-revoke",
                undefined
            );
        });

        it("should pass token_type_hint when provided", async () => {
            vi.mocked(client.tokenRevocation).mockResolvedValue(
                undefined as any
            );

            const provider = new OidcAuthProvider(testConfig);
            await provider.revokeToken(
                "refresh-token",
                "refresh_token"
            );

            expect(client.tokenRevocation).toHaveBeenCalledWith(
                mockConfiguration,
                "refresh-token",
                { token_type_hint: "refresh_token" }
            );
        });

        it("should omit params when no token_type_hint", async () => {
            vi.mocked(client.tokenRevocation).mockResolvedValue(
                undefined as any
            );

            const provider = new OidcAuthProvider(testConfig);
            await provider.revokeToken("some-token");

            expect(client.tokenRevocation).toHaveBeenCalledWith(
                mockConfiguration,
                "some-token",
                undefined
            );
        });

        it("should throw when config missing", async () => {
            const provider = new OidcAuthProvider({
                serviceName: "oidc-no-config",
                configFactory: async () => createMockOidcConfig(),
            });

            await expect(
                provider.revokeToken("some-token")
            ).rejects.toThrow(
                "issuerUrl and clientId are required for revokeToken"
            );
        });
    });

    // -------------------------------------------------------------------
    // fetchUserInfo()
    // -------------------------------------------------------------------
    describe("fetchUserInfo()", () => {
        it("should fetch user info with expected subject", async () => {
            const mockUserInfo = {
                sub: "user-1",
                name: "Test User",
                email: "test@example.com",
            };
            vi.mocked(client.fetchUserInfo).mockResolvedValue(
                mockUserInfo as any
            );

            const provider = new OidcAuthProvider(testConfig);
            const result = await provider.fetchUserInfo(
                "access-token",
                "user-1"
            );

            expect(result).toEqual(mockUserInfo);
            expect(client.fetchUserInfo).toHaveBeenCalledWith(
                mockConfiguration,
                "access-token",
                "user-1"
            );
        });

        it("should use skipSubjectCheck when no subject provided", async () => {
            vi.mocked(client.fetchUserInfo).mockResolvedValue({
                sub: "user-1",
            } as any);

            const provider = new OidcAuthProvider(testConfig);
            await provider.fetchUserInfo("access-token");

            expect(client.fetchUserInfo).toHaveBeenCalledWith(
                mockConfiguration,
                "access-token",
                client.skipSubjectCheck
            );
        });

        it("should throw when config missing", async () => {
            const provider = new OidcAuthProvider({
                serviceName: "oidc-no-config",
                configFactory: async () => createMockOidcConfig(),
            });

            await expect(
                provider.fetchUserInfo("access-token")
            ).rejects.toThrow(
                "issuerUrl and clientId are required for fetchUserInfo"
            );
        });
    });

    // -------------------------------------------------------------------
    // Multi-tenant (BFF config override)
    // -------------------------------------------------------------------
    describe("multi-tenant (BFF config override)", () => {
        it("should use provided config over base config in BFF methods", async () => {
            vi.mocked(client.authorizationCodeGrant).mockResolvedValue(
                createMockTokenResponse() as any
            );

            const provider = new OidcAuthProvider(testConfig);

            // Override config for a specific tenant
            const tenantConfig: OidcAuthConfig = {
                serviceName: "tenant-b",
                issuerUrl: "https://tenant-b.auth.example.com",
                clientId: "tenant-b-client",
                clientSecret: "tenant-b-secret",
                redirectUri: "https://tenant-b.app.com/callback",
            };

            await provider.exchangeCode(
                {
                    codeVerifier: "verifier",
                    callbackUrl:
                        "https://tenant-b.app.com/callback?code=abc",
                },
                tenantConfig
            );

            // Discovery should use the tenant config
            expect(client.discovery).toHaveBeenCalledWith(
                new URL("https://tenant-b.auth.example.com"),
                "tenant-b-client",
                "tenant-b-secret"
            );
        });
    });

    // -------------------------------------------------------------------
    // mapTokenResponse (via exchangeCode)
    // -------------------------------------------------------------------
    describe("mapTokenResponse", () => {
        it("should map all standard fields to OidcTokens", async () => {
            const fullResponse = createMockTokenResponse();
            vi.mocked(client.authorizationCodeGrant).mockResolvedValue(
                fullResponse as any
            );

            const provider = new OidcAuthProvider(testConfig);
            const result = await provider.exchangeCode({
                codeVerifier: "v",
                callbackUrl: "https://app.example.com/cb?code=c",
            });

            expect(result).toEqual({
                accessToken: "mock-access-token",
                tokenType: "Bearer",
                expiresIn: 3600,
                refreshToken: "mock-refresh-token",
                idToken: "mock-id-token",
                scope: "openid profile email",
            });
        });

        it("should map minimal response (optional fields undefined)", async () => {
            const minimalResponse = {
                access_token: "minimal-token",
                // No token_type, expires_in, refresh_token, id_token, scope
            };
            vi.mocked(client.authorizationCodeGrant).mockResolvedValue(
                minimalResponse as any
            );

            const provider = new OidcAuthProvider(testConfig);
            const result = await provider.exchangeCode({
                codeVerifier: "v",
                callbackUrl: "https://app.example.com/cb?code=c",
            });

            expect(result.accessToken).toBe("minimal-token");
            expect(result.tokenType).toBe("Bearer"); // Defaults to "Bearer"
            expect(result.expiresIn).toBeUndefined();
            expect(result.refreshToken).toBeUndefined();
            expect(result.idToken).toBeUndefined();
            expect(result.scope).toBeUndefined();
        });
    });
});
