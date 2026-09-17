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
 * The kind of authenticated principal.
 *
 * - `'user'` — an end user (for example, an interactive browser session).
 * - `'client'` — a machine or service principal (for example, client credentials).
 */
export type PrincipalType = 'user' | 'client';

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

    /** Tenant identifier for multi-tenant deployments, when the provider in use resolves one */
    tenantId?: string;

    /**
     * The kind of principal this result describes, when known.
     *
     * Unset when the source does not make it unambiguous. Descriptive only — it
     * does not by itself grant or deny access.
     */
    principalType?: PrincipalType;
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

    /**
     * Default principal type for tokens authenticated by this provider.
     *
     * Applied to an authenticated result only when the mapped result does not
     * already set `principalType`, so a custom claims mapper stays authoritative.
     * Use `'client'` for a machine/service provider and `'user'` for a user
     * provider. Default: undefined.
     *
     * This is read from the static provider config; a value returned by a
     * per-request `configFactory` is ignored.
     */
    principalType?: PrincipalType;
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
     * Require an audience check for validated tokens. Default: false.
     *
     * When true and no `audience` is configured, every token is rejected. This
     * fails closed instead of accepting any audience. When false (default), the
     * audience is checked only if `audience` is set.
     */
    requireAudience?: boolean;

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
 * Options shared by static and dynamic introspection configurations.
 *
 * Holds the tuning knobs that do not depend on how the client credentials are
 * supplied. `IntrospectionAuthConfig` (static) and
 * `IntrospectionAuthDynamicConfig` (request-scoped) both extend this interface.
 */
export interface IntrospectionAuthOptions extends AuthProviderConfig {
    /**
     * Expected token audience (`aud` claim in the introspection response).
     * Accepts a single value or a list. When set, the token is rejected unless
     * at least one configured value appears in the response audience.
     */
    audience?: string | string[];

    /**
     * How client credentials are sent to the introspection endpoint:
     * - `'basic'` — HTTP Basic auth (RFC 6749 `client_secret_basic`). Default.
     * - `'post'`  — as `client_id`/`client_secret` form fields (`client_secret_post`).
     */
    authMethod?: "basic" | "post";

    /**
     * Cache TTL in seconds for introspection responses.
     * Prevents calling the auth server on every request.
     * The effective TTL is also bounded by the token's own `exp` claim.
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

    /**
     * Optional per-request configuration factory.
     *
     * When set, the provider calls this once per request to resolve the full
     * static configuration (for example DB-backed, per-tenant credentials)
     * and it takes precedence over the static fields. `IntrospectionAuthConfig`
     * may also carry it; `IntrospectionAuthDynamicConfig` requires it.
     *
     * @param req - Express request used to resolve the tenant/credentials
     * @returns The static introspection config to use for this request
     */
    configFactory?: (
        req: Request
    ) => IntrospectionAuthConfig | Promise<IntrospectionAuthConfig>;
}

/**
 * Static configuration for IntrospectionAuthProvider.
 *
 * Validates opaque tokens by calling an OAuth2 token introspection endpoint
 * (RFC 7662). Includes a built-in response cache to avoid hammering the
 * auth server on every request.
 *
 * Use this shape when the same client credentials apply to every request.
 * For credentials that come from a database and differ per tenant, use
 * {@link IntrospectionAuthDynamicConfig} with a `configFactory`.
 */
export interface IntrospectionAuthConfig extends IntrospectionAuthOptions {
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
}

/**
 * Dynamic, request-scoped configuration for IntrospectionAuthProvider.
 *
 * Use this when the client credentials (and possibly the endpoint) are not
 * known at construction time — typically because they are loaded from a
 * database and differ per tenant. The provider calls `configFactory` on each
 * request and uses the returned static config to introspect the token.
 *
 * The provider does not cache the resolved credentials; the application owns
 * that cache (for example in its repository layer).
 */
export interface IntrospectionAuthDynamicConfig
    extends IntrospectionAuthOptions {
    /**
     * Introspection endpoint URL for the default/static case.
     * Optional when `configFactory` always supplies it.
     */
    introspectionUrl?: string;

    /**
     * Client ID for the default/static case.
     * Optional when `configFactory` always supplies it.
     */
    clientId?: string;

    /**
     * Client secret for the default/static case.
     * Optional when `configFactory` always supplies it.
     */
    clientSecret?: string;

    /**
     * Resolves the full introspection configuration for a request.
     *
     * Called once per authenticated request. It must return a complete
     * {@link IntrospectionAuthConfig}; errors thrown here propagate as
     * infrastructure failures.
     *
     * @param req - Express request used to determine the tenant/credentials
     * @returns The static introspection config to use for this request
     */
    configFactory: (
        req: Request
    ) => IntrospectionAuthConfig | Promise<IntrospectionAuthConfig>;
}

/**
 * Configuration accepted by the IntrospectionAuthProvider constructor.
 *
 * A union of the static and dynamic configurations so callers choose one
 * without the provider needing two classes.
 */
export type IntrospectionProviderConfig =
    | IntrospectionAuthConfig
    | IntrospectionAuthDynamicConfig;

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
 * An implementation is expected to call it once per tenant and cache the
 * result. The returned provider handles all authentication for that tenant.
 *
 * @param tenantId - The resolved tenant identifier
 * @returns An AuthProvider instance configured for the tenant
 */
export type TenantProviderFactory = (
    tenantId: string
) => Promise<AuthProviderLike>;

/**
 * Minimal provider shape used by tenant-delegation contracts.
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
 * Contract for tenant-delegating authentication.
 *
 * A consumer resolves a tenant from each request and supplies a per-tenant
 * provider factory. This package exports the contract but does not ship a
 * provider that consumes it, so nothing enforces the caching behaviour below;
 * an implementation built on the `AuthProvider` base class decides how to
 * honour it.
 */
export interface TenantAuthConfig extends AuthProviderConfig {
    /**
     * Function that resolves the tenant ID from each request.
     * Provide a custom function; no built-in resolvers are shipped.
     */
    resolveTenant: TenantResolver;

    /**
     * Factory that creates an AuthProvider for a specific tenant.
     * An implementation is expected to call it once per tenant and cache
     * the result.
     */
    createProvider: TenantProviderFactory;

    /**
     * Maximum number of tenant providers a delegation implementation should
     * cache. When the bound is exceeded, the least-recently-used provider is
     * expected to be shut down and evicted. Default: 100
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

    /**
     * Require an audience check for JWT/OIDC validation. Default: false.
     * When true and no `audience` is configured, tokens are rejected.
     */
    requireAudience?: boolean;

    // --- Introspection-specific ---

    /** Introspection endpoint URL */
    introspectionUrl?: string;

    /** Introspection cache TTL in seconds */
    cacheTTL?: number;

    /** Introspection client authentication method. Default: `'basic'` */
    authMethod?: "basic" | "post";

    /** Introspection cache capacity. Default: 1000 */
    maxCacheSize?: number;

    /**
     * Introspection per-request config factory for DB-backed, per-tenant
     * credentials. When set, it takes precedence over the static fields.
     */
    configFactory?: (
        req: Request
    ) => IntrospectionAuthConfig | Promise<IntrospectionAuthConfig>;

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
