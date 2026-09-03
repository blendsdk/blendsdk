/**
 * Shared test helpers for @blendsdk/webafx-auth test suites.
 *
 * Provides:
 * - Mock Express request factory with configurable headers, cookies, query params
 * - JWT signing utilities using the `jose` library's SignJWT
 * - Pre-built AuthResult fixtures for common test scenarios
 * - Shared test constants (secrets, issuer, audience)
 *
 * @packageDocumentation
 */

import { SignJWT } from "jose";
import { vi } from "vitest";
import type { Request } from "express";
import type { CacheProvider } from "@blendsdk/webafx-cache";
import type { AuthResult } from "../src/types.js";
import type { OidcAuthConfig, OidcSession } from "../src/oidc-types.js";

// ---------------------------------------------------------------------------
// Test Constants
// ---------------------------------------------------------------------------

/** HMAC secret used across all JWT test suites (32 bytes for HS256) */
export const TEST_SECRET = "test-secret-that-is-at-least-256-bits-long!!";

/** Issuer claim value used in JWT tests */
export const TEST_ISSUER = "https://auth.test.example.com";

/** Audience claim value used in JWT tests */
export const TEST_AUDIENCE = "test-client-id";

// ---------------------------------------------------------------------------
// Mock Request Factory
// ---------------------------------------------------------------------------

/**
 * Options for creating a mock Express request.
 *
 * Only the fields relevant to token extraction are included.
 * All other Express request properties are left as defaults.
 */
export interface MockRequestOptions {
    /** Authorization header value (e.g., 'Bearer <token>') */
    authorization?: string;
    /** Additional headers beyond Authorization */
    headers?: Record<string, string>;
    /** Cookie values (simulates cookie-parser middleware) */
    cookies?: Record<string, string>;
    /** Query parameters */
    query?: Record<string, string>;
}

/**
 * Create a minimal mock Express request for testing token extraction.
 *
 * Returns an object shaped like Express's Request with only the properties
 * that the AuthProvider token extraction chain accesses:
 * - `headers` (including `authorization`)
 * - `cookies` (populated by cookie-parser)
 * - `query` (parsed query parameters)
 *
 * @param options - Request properties to set
 * @returns A mock Request suitable for AuthProvider.extractToken() and authenticate()
 */
export function createMockRequest(options: MockRequestOptions = {}): Request {
    const headers: Record<string, string | undefined> = {
        ...options.headers,
    };

    // Set the authorization header if provided
    if (options.authorization) {
        headers.authorization = options.authorization;
    }

    // Build the minimal mock request object.
    // Cast to Request since we only need the subset of properties
    // that AuthProvider accesses (headers, cookies, query).
    const req = {
        headers,
        cookies: options.cookies ?? {},
        query: options.query ?? {},
    } as unknown as Request;

    return req;
}

/**
 * Create a mock request with a Bearer token in the Authorization header.
 *
 * Shorthand for `createMockRequest({ authorization: 'Bearer <token>' })`.
 *
 * @param token - The Bearer token value
 * @returns A mock Request with the Authorization header set
 */
export function createBearerRequest(token: string): Request {
    return createMockRequest({ authorization: `Bearer ${token}` });
}

/**
 * Create a mock request with a token in a cookie.
 *
 * @param token - The token value
 * @param cookieName - The cookie name (default: 'auth_token')
 * @returns A mock Request with the cookie set
 */
export function createCookieRequest(
    token: string,
    cookieName = "auth_token"
): Request {
    return createMockRequest({ cookies: { [cookieName]: token } });
}

/**
 * Create a mock request with a token in a query parameter.
 *
 * @param token - The token value
 * @param paramName - The query parameter name (default: 'token')
 * @returns A mock Request with the query parameter set
 */
export function createQueryRequest(
    token: string,
    paramName = "token"
): Request {
    return createMockRequest({ query: { [paramName]: token } });
}

// ---------------------------------------------------------------------------
// JWT Signing Helpers
// ---------------------------------------------------------------------------

/**
 * Options for creating a signed test JWT.
 *
 * All claim values have sensible defaults for testing — only override
 * what your specific test case needs.
 */
export interface SignJwtOptions {
    /** Subject claim (user ID). Default: 'test-user-1' */
    sub?: string;
    /** Issuer claim. Default: TEST_ISSUER */
    issuer?: string;
    /** Audience claim. Default: TEST_AUDIENCE */
    audience?: string;
    /** Expiration time relative to now. Default: '1h' */
    expiresIn?: string;
    /** Explicit expiration timestamp (overrides expiresIn) */
    exp?: number;
    /** Additional payload claims to include */
    claims?: Record<string, unknown>;
    /** Signing secret. Default: TEST_SECRET */
    secret?: string;
    /** Signing algorithm. Default: 'HS256' */
    algorithm?: string;
}

/**
 * Create a signed JWT for testing.
 *
 * Uses `jose`'s SignJWT to produce a real, cryptographically valid JWT
 * that can be verified by JwtAuthProvider. This ensures tests validate
 * real JWT processing, not mocked behavior.
 *
 * @param options - JWT claims and signing configuration
 * @returns A signed JWT string (header.payload.signature)
 */
export async function signTestJwt(options: SignJwtOptions = {}): Promise<string> {
    const secret = new TextEncoder().encode(options.secret ?? TEST_SECRET);
    const algorithm = options.algorithm ?? "HS256";

    const builder = new SignJWT({
        sub: options.sub ?? "test-user-1",
        ...options.claims,
    })
        .setProtectedHeader({ alg: algorithm })
        .setIssuedAt();

    // Set issuer if provided (default: TEST_ISSUER)
    if (options.issuer !== undefined) {
        builder.setIssuer(options.issuer);
    } else {
        builder.setIssuer(TEST_ISSUER);
    }

    // Set audience if provided (default: TEST_AUDIENCE)
    if (options.audience !== undefined) {
        builder.setAudience(options.audience);
    } else {
        builder.setAudience(TEST_AUDIENCE);
    }

    // Set expiration — explicit timestamp takes precedence over relative time
    if (options.exp !== undefined) {
        builder.setExpirationTime(options.exp);
    } else {
        builder.setExpirationTime(options.expiresIn ?? "1h");
    }

    return builder.sign(secret);
}

/**
 * Create a signed JWT that is already expired.
 *
 * Sets the expiration to 1 hour in the past so the token fails
 * expiration checks during verification.
 *
 * @param options - Additional JWT options
 * @returns An expired JWT string
 */
export async function signExpiredJwt(
    options: SignJwtOptions = {}
): Promise<string> {
    // Set exp to 1 hour ago (seconds since epoch)
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    return signTestJwt({ ...options, exp: oneHourAgo });
}

// ---------------------------------------------------------------------------
// AuthResult Fixtures
// ---------------------------------------------------------------------------

/**
 * Create a standard test AuthResult for use in MemoryAuthProvider tests.
 *
 * @param overrides - Optional field overrides
 * @returns A complete AuthResult with sensible test defaults
 */
export function createTestAuthResult(
    overrides: Partial<AuthResult> = {}
): AuthResult {
    return {
        sub: "test-user-1",
        claims: { role: "user" },
        token: "test-token-1",
        ...overrides,
    };
}

/** Pre-built admin auth result for multi-role test scenarios */
export const ADMIN_AUTH_RESULT: AuthResult = {
    sub: "admin-1",
    claims: { role: "admin", permissions: ["read", "write", "delete"] },
    token: "admin-token",
    scopes: ["admin"],
};

/** Pre-built regular user auth result for multi-role test scenarios */
export const USER_AUTH_RESULT: AuthResult = {
    sub: "user-1",
    claims: { role: "user", permissions: ["read"] },
    token: "user-token",
    scopes: ["read"],
};

// ---------------------------------------------------------------------------
// OIDC Test Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock openid-client token response for BFF method tests.
 *
 * Returns a plain object shaped like openid-client's TokenEndpointResponse
 * with standard OAuth2/OIDC fields. Override individual fields as needed.
 *
 * @param overrides - Optional field overrides
 * @returns A mock token endpoint response
 */
export function createMockTokenResponse(
    overrides?: Partial<{
        access_token: string;
        token_type: string;
        expires_in: number;
        refresh_token: string;
        id_token: string;
        scope: string;
    }>
) {
    return {
        access_token: "mock-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "mock-refresh-token",
        id_token: "mock-id-token",
        scope: "openid profile email",
        ...overrides,
    };
}

/**
 * Create a mock OIDC config for multi-tenant and BFF tests.
 *
 * @param overrides - Optional field overrides
 * @returns A complete OidcAuthConfig with sensible test defaults
 */
export function createMockOidcConfig(
    overrides?: Partial<OidcAuthConfig>
): OidcAuthConfig {
    return {
        serviceName: "oidc-test",
        issuerUrl: "https://auth.example.com",
        clientId: "test-client",
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Mock CacheProvider (for server-side session tests)
// ---------------------------------------------------------------------------

/**
 * Create a mock CacheProvider backed by an in-memory Map.
 *
 * Provides vitest spies on get/set/delete so tests can assert calls.
 * The internal Map is returned for direct inspection in tests.
 *
 * @returns Object with the mock CacheProvider and its backing store
 */
export function createMockCacheProvider(): {
    provider: CacheProvider;
    store: Map<string, { value: unknown; expiresAt: number }>;
} {
    const store = new Map<string, { value: unknown; expiresAt: number }>();

    const provider = {
        get: vi.fn(async <T>(key: string): Promise<T | undefined> => {
            const entry = store.get(key);
            if (!entry) return undefined;
            // Check expiry
            if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
                store.delete(key);
                return undefined;
            }
            return entry.value as T;
        }),
        set: vi.fn(async (key: string, value: unknown, ttl?: number): Promise<void> => {
            const expiresAt = ttl ? Date.now() + ttl * 1000 : 0;
            store.set(key, { value, expiresAt });
        }),
        delete: vi.fn(async (key: string): Promise<boolean> => {
            return store.delete(key);
        }),
        exists: vi.fn(async (key: string): Promise<boolean> => {
            return store.has(key);
        }),
        expire: vi.fn(async () => true),
        ttl: vi.fn(async () => -1),
        deletePattern: vi.fn(async () => 0),
        clear: vi.fn(async () => { store.clear(); }),
        health: vi.fn(async () => true),
        shutdown: vi.fn(async () => {}),
        getOrSet: vi.fn(),
        serviceName: "cache",
    } as unknown as CacheProvider;

    return { provider, store };
}

// ---------------------------------------------------------------------------
// Sample OidcSession Fixture
// ---------------------------------------------------------------------------

/**
 * Create a sample OidcSession for testing.
 *
 * @param overrides - Optional field overrides
 * @returns A complete OidcSession with sensible test defaults
 */
export function createSampleSession(
    overrides?: Partial<OidcSession>
): OidcSession {
    return {
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
        idToken: "mock-id-token",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        user: { sub: "user-123", name: "Alice", email: "alice@example.com" },
        ...overrides,
    };
}
