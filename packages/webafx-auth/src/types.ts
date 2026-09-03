/**
 * Type definitions and constants for the @blendsdk/webafx-auth package.
 *
 * Defines configuration interfaces for all authentication providers
 * (JWT, Introspection, OIDC, Tenant, Memory) and their environment-based
 * factory. Constants provide sensible defaults for service naming and
 * plugin priority.
 *
 * @packageDocumentation
 */

import type { Request } from "express";

// ---------------------------------------------------------------------------
// Core Auth Types
// ---------------------------------------------------------------------------

/**
 * Result of successful authentication.
 * Represents the validated identity extracted from a token.
 *
 * This is the value set on `req.services.set('user', authResult)` by the
 * auth plugin middleware. Controllers access it via `req.services.getUser<AuthResult>()`.
 */
export interface AuthResult {
    /** Unique subject identifier (user ID) */
    sub: string;

    /** All claims/attributes from the token or introspection response */
    claims: Record<string, unknown>;

    /** Original raw token string (useful for forwarding to downstream services) */
    token: string;

    /** Token expiration timestamp (seconds since epoch), if available */
    exp?: number;

    /** Scopes/permissions granted by the token */
    scopes?: string[];

    /** Tenant identifier (set by TenantAuthProvider) */
    tenantId?: string;
}

// ---------------------------------------------------------------------------
// Token Source Configuration
// ---------------------------------------------------------------------------

/**
 * Function that extracts a token string from an Express request.
 *
 * @param req - Express request object
 * @returns The extracted token string, or undefined if not found
 */
export type TokenExtractor = (req: Request) => string | undefined;

/**
 * Where to look for tokens. Tried in order — first match wins.
 *
 * Built-in sources:
 * - `'header'` — extracts from `Authorization: Bearer <token>`
 * - `'cookie'` — extracts from configured cookie name
 * - `'query'`  — extracts from configured query parameter
 *
 * Custom source:
 * - `{ extractor: (req) => string | undefined }` — custom extraction function
 */
export type TokenSource =
    | "header"
    | "cookie"
    | "query"
    | { extractor: TokenExtractor };

/**
 * Optional claims mapping function.
 *
 * Transforms raw provider-specific claims into the standardized AuthResult
 * format. If not provided, the AuthProvider base class uses a default mapper
 * that extracts `sub`, `exp`, and `scope` from the raw claims.
 *
 * @param token - The original raw token string
 * @param rawClaims - The raw claims object from the token or introspection response
 * @returns A fully-formed AuthResult
 */
export type ClaimsMapper = (
    token: string,
    rawClaims: Record<string, unknown>
) => AuthResult;

// ---------------------------------------------------------------------------
// Base Auth Provider Configuration
// ---------------------------------------------------------------------------

/**
 * Base configuration shared by all auth providers.
 *
 * Every provider extends this with backend-specific options (secret, issuer,
 * introspection URL, etc.). The base config covers token extraction and
 * claims mapping — concerns shared by all providers.
 */
export interface AuthProviderConfig {
    /**
     * Service name for WebAFX service container registration.
     * Default: `'auth'`. Use different names for multi-auth scenarios.
     */
    serviceName?: string;

    /**
     * Token extraction sources, tried in order. First match wins.
     * Default: `['header']` (Authorization: Bearer)
     */
    tokenSources?: TokenSource[];

    /**
     * Cookie name for cookie-based token extraction.
     * Only used when `'cookie'` is in `tokenSources`.
     * Default: `'auth_token'`
     */
    cookieName?: string;

    /**
     * Query parameter name for query-based token extraction.
     * Only used when `'query'` is in `tokenSources`.
     * Default: `'token'`
     */
    queryParamName?: string;

    /**
     * Optional claims mapping function.
     * Transforms raw token claims into the AuthResult format.
     * If not provided, a default mapper extracts `sub`, `exp`, `scope`.
     */
    mapClaims?: ClaimsMapper;
}

// ---------------------------------------------------------------------------
// JWT Provider Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for JwtAuthProvider.
 *
 * Validates self-issued JWTs locally using HMAC or RSA keys via the
 * `oauth4webapi` library's `jwtVerify()`. No network calls needed.
 */
export interface JwtAuthConfig extends AuthProviderConfig {
    /**
     * Signing secret or public key for JWT verification.
     * - `string` — HMAC secret (HS256/HS384/HS512)
     * - `CryptoKey` — RSA/EC public key for RS256/ES256 etc.
     */
    secret: string | CryptoKey;

    /**
     * Allowed JWT algorithms.
     * Default: `['HS256']` for string secrets, auto-detected for CryptoKey
     */
    algorithms?: string[];

    /**
     * Expected JWT issuer (`iss` claim). If set, tokens with a different
     * issuer are rejected.
     */
    issuer?: string;

    /**
     * Expected JWT audience (`aud` claim). If set, tokens without a
     * matching audience are rejected.
     */
    audience?: string | string[];

    /**
     * Clock tolerance in seconds for `exp`/`nbf` checks.
     * Accounts for clock skew between servers. Default: 0
     */
    clockTolerance?: number;
}

// ---------------------------------------------------------------------------
// Introspection Provider Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for IntrospectionAuthProvider.
 *
 * Validates opaque tokens by calling an OAuth2 token introspection endpoint
 * (RFC 7662). Includes a built-in response cache to avoid hammering the
 * auth server on every request.
 */
export interface IntrospectionAuthConfig extends AuthProviderConfig {
    /**
     * URL of the OAuth2 introspection endpoint.
     * Example: `'https://auth.example.com/oauth2/introspect'`
     */
    introspectionUrl: string;

    /**
     * Client ID for authenticating with the introspection endpoint.
     * Used in HTTP Basic auth or as `client_id` form param.
     */
    clientId: string;

    /**
     * Client secret for authenticating with the introspection endpoint.
     */
    clientSecret: string;

    /**
     * Cache TTL in seconds for introspection responses.
     * Prevents calling the auth server on every request.
     * Default: 60 (1 minute)
     */
    cacheTTL?: number;

    /**
     * Maximum number of cached introspection responses.
     * When exceeded, the least-recently-used entries are evicted.
     * Default: 1000
     */
    maxCacheSize?: number;

    /**
     * HTTP request timeout in milliseconds.
     * Default: 5000 (5 seconds)
     */
    timeout?: number;
}

// ---------------------------------------------------------------------------
// Tenant Provider Configuration
// ---------------------------------------------------------------------------

/**
 * Function that resolves a tenant identifier from a request.
 *
 * @param req - Express request object
 * @returns The resolved tenant ID, or undefined if not determinable
 */
export type TenantResolver = (req: Request) => string | undefined;

/**
 * Factory function that creates an AuthProvider for a specific tenant.
 *
 * Called once per tenant and cached. The returned provider handles all
 * authentication for that tenant.
 *
 * @param tenantId - The resolved tenant identifier
 * @returns An AuthProvider instance configured for the tenant
 */
export type TenantProviderFactory = (
    tenantId: string
) => Promise<AuthProviderLike>;

/**
 * Minimal interface that TenantAuthProvider delegates to.
 *
 * This avoids a circular dependency on the full AuthProvider class —
 * any object with `validate()`, `health()`, and `shutdown()` qualifies.
 * In practice, all concrete AuthProvider subclasses satisfy this.
 */
export interface AuthProviderLike {
    /** Validate a token and return the authenticated identity */
    validate(token: string): Promise<AuthResult | undefined>;

    /** Health check for this provider */
    health(): Promise<boolean>;

    /** Graceful shutdown for this provider */
    shutdown(): Promise<void>;
}

/**
 * Configuration for TenantAuthProvider.
 *
 * Resolves a tenant from each request, then delegates authentication
 * to a per-tenant provider. Providers are created lazily and cached
 * with LRU eviction.
 */
export interface TenantAuthConfig extends AuthProviderConfig {
    /**
     * Function that resolves the tenant ID from each request.
     * Use one of the built-in `tenantResolvers` or provide a custom function.
     */
    resolveTenant: TenantResolver;

    /**
     * Factory that creates an AuthProvider for a specific tenant.
     * Called once per tenant and the result is cached.
     */
    createProvider: TenantProviderFactory;

    /**
     * Maximum number of cached tenant providers.
     * When exceeded, the least-recently-used tenant provider is shut down
     * and evicted. Default: 100
     */
    maxTenants?: number;
}

// ---------------------------------------------------------------------------
// Memory Provider Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for MemoryAuthProvider.
 *
 * A testing-only provider with a pre-configured mapping of token → AuthResult.
 * Use in integration tests with `memoryAuthPlugin()` to avoid real auth flows.
 */
export interface MemoryAuthConfig extends AuthProviderConfig {
    /**
     * Map of token strings to their corresponding auth results.
     * When a token matches a key, the corresponding AuthResult is returned.
     *
     * @example
     * ```typescript
     * validTokens: {
     *     'test-admin-token': { sub: 'admin-1', claims: { role: 'admin' }, token: 'test-admin-token' },
     *     'test-user-token': { sub: 'user-1', claims: { role: 'user' }, token: 'test-user-token' },
     * }
     * ```
     */
    validTokens?: Record<string, AuthResult>;
}

// ---------------------------------------------------------------------------
// Environment-Based Factory Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the `createAuthProvider()` environment-based factory.
 *
 * Determines which provider to create based on the `type` field.
 * Provider-specific fields are only used when the matching type is selected.
 */
export interface AuthFactoryConfig extends AuthProviderConfig {
    /** Auth provider backend type */
    type: "jwt" | "introspection" | "oidc" | "memory";

    // --- JWT-specific (only used when type === 'jwt') ---

    /** JWT signing secret or public key */
    secret?: string | CryptoKey;

    /** Allowed JWT algorithms */
    algorithms?: string[];

    // --- Shared optional fields ---

    /** Expected issuer (JWT: iss claim, OIDC: discovery URL) */
    issuer?: string;

    /** OIDC issuer URL for discovery */
    issuerUrl?: string;

    /** Client ID (introspection, OIDC) */
    clientId?: string;

    /** Client secret (introspection) */
    clientSecret?: string;

    /** Expected audience (JWT, OIDC) */
    audience?: string | string[];

    // --- Introspection-specific ---

    /** Introspection endpoint URL */
    introspectionUrl?: string;

    /** Introspection cache TTL in seconds */
    cacheTTL?: number;

    // --- Timing ---

    /** Clock tolerance in seconds */
    clockTolerance?: number;

    /** HTTP timeout in milliseconds */
    timeout?: number;

    // --- Memory-specific ---

    /** Pre-configured valid tokens for testing */
    validTokens?: Record<string, AuthResult>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default service name for auth when not specified */
export const DEFAULT_SERVICE_NAME = "auth";

/** Default plugin priority — installs early (before feature plugins) */
export const DEFAULT_PLUGIN_PRIORITY = 10;

/** Default cookie name for cookie-based token extraction */
export const DEFAULT_COOKIE_NAME = "auth_token";

/** Default query parameter name for query-based token extraction */
export const DEFAULT_QUERY_PARAM_NAME = "token";

/** Default token sources — Authorization: Bearer header only */
export const DEFAULT_TOKEN_SOURCES: TokenSource[] = ["header"];
