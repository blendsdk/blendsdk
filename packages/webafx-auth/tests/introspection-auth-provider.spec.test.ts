/**
 * Specification tests for IntrospectionAuthProvider (RFC 7662).
 *
 * These tests describe required behavior for validating opaque access tokens
 * against an OAuth2 token introspection endpoint. They are derived from the
 * feature specification and must not be changed to match an implementation.
 *
 * Covers: request shape, client authentication, active/inactive handling,
 * audience checks, caching and LRU eviction, timeouts, error propagation,
 * dynamic per-tenant configuration, health, and shutdown.
 *
 * @packageDocumentation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { IntrospectionAuthProvider } from "../src/introspection-auth-provider.js";
import type {
    IntrospectionAuthConfig,
    IntrospectionAuthDynamicConfig,
} from "../src/types.js";
import { createBearerRequest, createMockRequest } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/** Static configuration used by most tests. */
const STATIC_CONFIG: IntrospectionAuthConfig = {
    introspectionUrl: "https://auth.example.com/oauth2/introspect",
    clientId: "client-1",
    clientSecret: "secret-1",
};

/** Token string used by tests; must never leak into logs or errors. */
const TEST_TOKEN = "opaque-token-should-never-appear";

/** Seconds since epoch, one hour in the future. */
function futureEpoch(offsetSeconds = 3600): number {
    return Math.floor(Date.now() / 1000) + offsetSeconds;
}

/**
 * Build a minimal fetch Response stand-in.
 *
 * Only the members the provider reads are implemented: `ok`, `status`, `json`.
 *
 * @param body - Parsed JSON body returned by the introspection endpoint
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

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** Extract and parse the body of the first fetch call. */
function firstRequestBody(): URLSearchParams {
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    return new URLSearchParams(init.body as string);
}

/** Extract the headers of the first fetch call. */
function firstRequestHeaders(): Record<string, string> {
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    return (init.headers ?? {}) as Record<string, string>;
}

// ---------------------------------------------------------------------------
// Specification tests
// ---------------------------------------------------------------------------

describe("IntrospectionAuthProvider — Specification Tests", () => {
    describe("ST-101: active token maps to AuthResult", () => {
        it("returns sub, exp and scopes from the introspection response", async () => {
            const exp = futureEpoch();
            fetchMock.mockResolvedValue(
                jsonResponse({
                    active: true,
                    sub: "user-1",
                    exp,
                    scope: "read write",
                })
            );

            const provider = new IntrospectionAuthProvider(STATIC_CONFIG);
            const result = await provider.authenticate(
                createBearerRequest(TEST_TOKEN)
            );

            expect(result).toBeDefined();
            expect(result?.sub).toBe("user-1");
            expect(result?.exp).toBe(exp);
            expect(result?.scopes).toEqual(["read", "write"]);
            expect(result?.claims.active).toBe(true);
        });
    });

    describe("ST-102: RFC 7662 request shape", () => {
        it("POSTs the token to the introspection endpoint with the required headers and body", async () => {
            fetchMock.mockResolvedValue(jsonResponse({ active: true }));
            const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

            await provider.validate(TEST_TOKEN);

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(fetchMock).toHaveBeenCalledWith(
                STATIC_CONFIG.introspectionUrl,
                expect.objectContaining({ method: "POST" })
            );

            const headers = firstRequestHeaders();
            expect(headers["Content-Type"]).toBe(
                "application/x-www-form-urlencoded"
            );
            expect(headers["Accept"]).toBe("application/json");

            const body = firstRequestBody();
            expect(body.get("token")).toBe(TEST_TOKEN);
            expect(body.get("token_type_hint")).toBe("access_token");
        });
    });

    describe("ST-103: default client_secret_basic", () => {
        it("sends credentials in the Authorization header, not the body", async () => {
            fetchMock.mockResolvedValue(jsonResponse({ active: true }));
            const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

            await provider.validate(TEST_TOKEN);

            const headers = firstRequestHeaders();
            expect(headers.Authorization).toMatch(/^Basic /);
            expect(firstRequestBody().get("client_id")).toBeNull();
            expect(firstRequestBody().get("client_secret")).toBeNull();
        });
    });

    describe("ST-104: client_secret_post", () => {
        it("sends credentials in the body and omits the Authorization header", async () => {
            fetchMock.mockResolvedValue(jsonResponse({ active: true }));
            const provider = new IntrospectionAuthProvider({
                ...STATIC_CONFIG,
                authMethod: "post",
            });

            await provider.validate(TEST_TOKEN);

            const headers = firstRequestHeaders();
            expect(headers.Authorization).toBeUndefined();
            const body = firstRequestBody();
            expect(body.get("client_id")).toBe("client-1");
            expect(body.get("client_secret")).toBe("secret-1");
        });
    });

    describe("ST-105: inactive token", () => {
        it("returns undefined when active is false", async () => {
            fetchMock.mockResolvedValue(jsonResponse({ active: false }));
            const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

            await expect(provider.validate(TEST_TOKEN)).resolves.toBeUndefined();
        });
    });

    describe("ST-106: non-2xx response", () => {
        it("throws an error containing the status but not the token", async () => {
            fetchMock.mockResolvedValue(jsonResponse({}, 500));
            const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

            const error = await provider
                .validate(TEST_TOKEN)
                .catch((err: unknown) => err);
            const message = String(error);
            expect(message).toMatch(/500/);
            expect(message).not.toContain(TEST_TOKEN);
        });
    });

    describe("ST-107: network failure", () => {
        it("propagates the fetch error", async () => {
            const networkError = new Error("ECONNREFUSED");
            fetchMock.mockRejectedValue(networkError);
            const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

            await expect(provider.validate(TEST_TOKEN)).rejects.toBe(
                networkError
            );
        });
    });

    describe("ST-108: request timeout", () => {
        it("aborts and rejects when the endpoint does not respond in time", async () => {
            fetchMock.mockImplementation(
                (_url: string, init: RequestInit) =>
                    new Promise((_resolve, reject) => {
                        init.signal?.addEventListener("abort", () =>
                            reject(new Error("aborted"))
                        );
                    })
            );
            const provider = new IntrospectionAuthProvider({
                ...STATIC_CONFIG,
                timeout: 20,
            });

            await expect(provider.validate(TEST_TOKEN)).rejects.toThrow();
        });
    });

    describe("ST-109–ST-112: audience validation", () => {
        it("accepts a matching string audience", async () => {
            fetchMock.mockResolvedValue(
                jsonResponse({ active: true, sub: "u", aud: "api" })
            );
            const provider = new IntrospectionAuthProvider({
                ...STATIC_CONFIG,
                audience: "api",
            });

            await expect(provider.validate(TEST_TOKEN)).resolves.toBeDefined();
        });

        it("accepts a matching entry in an array audience", async () => {
            fetchMock.mockResolvedValue(
                jsonResponse({ active: true, sub: "u", aud: ["b"] })
            );
            const provider = new IntrospectionAuthProvider({
                ...STATIC_CONFIG,
                audience: ["a", "b"],
            });

            await expect(provider.validate(TEST_TOKEN)).resolves.toBeDefined();
        });

        it("rejects a mismatched audience", async () => {
            fetchMock.mockResolvedValue(
                jsonResponse({ active: true, sub: "u", aud: "other" })
            );
            const provider = new IntrospectionAuthProvider({
                ...STATIC_CONFIG,
                audience: "api",
            });

            await expect(provider.validate(TEST_TOKEN)).resolves.toBeUndefined();
        });

        it("rejects a missing audience when one is configured", async () => {
            fetchMock.mockResolvedValue(
                jsonResponse({ active: true, sub: "u" })
            );
            const provider = new IntrospectionAuthProvider({
                ...STATIC_CONFIG,
                audience: "api",
            });

            await expect(provider.validate(TEST_TOKEN)).resolves.toBeUndefined();
        });
    });

    describe("ST-113: cache hit avoids a second HTTP call", () => {
        it("calls fetch once for two validations of the same token", async () => {
            fetchMock.mockResolvedValue(
                jsonResponse({ active: true, sub: "u", exp: futureEpoch() })
            );
            const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

            await provider.validate(TEST_TOKEN);
            await provider.validate(TEST_TOKEN);

            expect(fetchMock).toHaveBeenCalledTimes(1);
        });
    });

    describe("ST-114: active but expired", () => {
        it("returns undefined when exp is in the past", async () => {
            fetchMock.mockResolvedValue(
                jsonResponse({ active: true, sub: "u", exp: futureEpoch(-60) })
            );
            const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

            await expect(provider.validate(TEST_TOKEN)).resolves.toBeUndefined();
        });
    });

    describe("ST-115: LRU eviction", () => {
        it("evicts the least recently used entry, not the oldest inserted", async () => {
            fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
                const token = new URLSearchParams(
                    init.body as string
                ).get("token");
                return jsonResponse({
                    active: true,
                    sub: token,
                    exp: futureEpoch(),
                });
            });

            const provider = new IntrospectionAuthProvider({
                ...STATIC_CONFIG,
                maxCacheSize: 2,
            });

            // A and B fill the cache; touching A makes B the least recently
            // used, so inserting C evicts B (not A). B is then re-fetched.
            await provider.validate("token-a");
            await provider.validate("token-b");
            await provider.validate("token-a");
            await provider.validate("token-c");
            await provider.validate("token-b");

            // Fetches: A, B, C, B. A and (after re-fetch) B come from cache.
            // A FIFO cache would have evicted A instead, giving 3 fetches.
            expect(fetchMock).toHaveBeenCalledTimes(4);
        });
    });

    describe("ST-116: secrets and tokens never logged", () => {
        it("does not write the token or client secret to the console", async () => {
            const spies = [
                vi.spyOn(console, "log").mockImplementation(() => {}),
                vi.spyOn(console, "info").mockImplementation(() => {}),
                vi.spyOn(console, "warn").mockImplementation(() => {}),
                vi.spyOn(console, "error").mockImplementation(() => {}),
                vi.spyOn(console, "debug").mockImplementation(() => {}),
            ];
            fetchMock.mockResolvedValue(
                jsonResponse({ active: true, sub: "u", exp: futureEpoch() })
            );
            const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

            await provider.validate(TEST_TOKEN);

            const output = JSON.stringify(
                spies.flatMap((spy) => spy.mock.calls)
            );
            expect(output).not.toContain(TEST_TOKEN);
            expect(output).not.toContain(STATIC_CONFIG.clientSecret);
        });

        it("does not leak the token or secret in a failure message", async () => {
            fetchMock.mockResolvedValue(jsonResponse({}, 500));
            const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

            const error = await provider
                .validate(TEST_TOKEN)
                .catch((err: unknown) => err);
            const message = String(error);
            expect(message).toMatch(/500/);
            expect(message).not.toContain(TEST_TOKEN);
            expect(message).not.toContain(STATIC_CONFIG.clientSecret);
        });
    });

    describe("ST-117/ST-118: health", () => {
        it("returns true for static config without making a request", async () => {
            const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

            await expect(provider.health()).resolves.toBe(true);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it("returns true when only a configFactory is configured", async () => {
            const provider = new IntrospectionAuthProvider({
                configFactory: async () => STATIC_CONFIG,
            });

            await expect(provider.health()).resolves.toBe(true);
        });
    });

    describe("ST-119: shutdown clears the cache", () => {
        it("re-fetches a token after shutdown", async () => {
            fetchMock.mockResolvedValue(
                jsonResponse({ active: true, sub: "u", exp: futureEpoch() })
            );
            const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

            await provider.validate(TEST_TOKEN);
            await provider.shutdown();
            await provider.validate(TEST_TOKEN);

            expect(fetchMock).toHaveBeenCalledTimes(2);
        });
    });

    describe("ST-120/ST-121: constructor guard", () => {
        it("throws when neither a static triple nor a configFactory is given", () => {
            expect(
                () =>
                    new IntrospectionAuthProvider(
                        {} as IntrospectionAuthDynamicConfig
                    )
            ).toThrow();
        });

        it("throws when the static triple is incomplete and no factory is given", () => {
            expect(
                () =>
                    new IntrospectionAuthProvider({
                        introspectionUrl: "https://x",
                        clientId: "c",
                    } as IntrospectionAuthConfig)
            ).toThrow();
        });
    });

    describe("ST-122/ST-123: dynamic configuration", () => {
        const dynamicConfig: IntrospectionAuthDynamicConfig = {
            configFactory: async (req) => {
                const tenant = String(req.headers["x-tenant"] ?? "");
                return {
                    introspectionUrl: `https://${tenant}.example.com/introspect`,
                    clientId: `client-${tenant}`,
                    clientSecret: `secret-${tenant}`,
                };
            },
        };

        it("returns undefined from validate when only a factory is configured", async () => {
            const provider = new IntrospectionAuthProvider(dynamicConfig);

            await expect(provider.validate(TEST_TOKEN)).resolves.toBeUndefined();
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it("uses the configFactory result when authenticating a request", async () => {
            fetchMock.mockResolvedValue(
                jsonResponse({ active: true, sub: "u", exp: futureEpoch() })
            );
            const provider = new IntrospectionAuthProvider(dynamicConfig);

            const result = await provider.authenticate(
                createMockRequest({
                    authorization: `Bearer ${TEST_TOKEN}`,
                    headers: { "x-tenant": "acme" },
                })
            );

            expect(result).toBeDefined();
            expect(fetchMock).toHaveBeenCalledWith(
                "https://acme.example.com/introspect",
                expect.objectContaining({ method: "POST" })
            );
        });
    });

    describe("ST-124: per-tenant cache isolation", () => {
        it("calls the endpoint once per tenant for the same token", async () => {
            fetchMock.mockResolvedValue(
                jsonResponse({ active: true, sub: "u", exp: futureEpoch() })
            );
            const provider = new IntrospectionAuthProvider({
                configFactory: async (req) => {
                    const tenant = String(req.headers["x-tenant"] ?? "");
                    return {
                        introspectionUrl: "https://auth.example.com/introspect",
                        clientId: `client-${tenant}`,
                        clientSecret: "s",
                    };
                },
            });

            await provider.authenticate(
                createMockRequest({
                    authorization: `Bearer ${TEST_TOKEN}`,
                    headers: { "x-tenant": "a" },
                })
            );
            await provider.authenticate(
                createMockRequest({
                    authorization: `Bearer ${TEST_TOKEN}`,
                    headers: { "x-tenant": "b" },
                })
            );

            expect(fetchMock).toHaveBeenCalledTimes(2);
        });
    });

    describe("ST-125: config factory failure", () => {
        it("propagates an error thrown by the config factory", async () => {
            const factoryError = new Error("database unavailable");
            const provider = new IntrospectionAuthProvider({
                configFactory: async () => {
                    throw factoryError;
                },
            });

            await expect(
                provider.authenticate(createBearerRequest(TEST_TOKEN))
            ).rejects.toBe(factoryError);
        });
    });
});
