/**
 * @blendsdk/webafx-auth — Token validation and authentication plugin for WebAFX
 *
 * Provides an abstract AuthProvider base class with a configurable token
 * extraction chain and five concrete provider implementations:
 *
 * **Providers:**
 * - AuthProvider (abstract) — base class with extract → validate → authenticate lifecycle
 * - JwtAuthProvider — local JWT verification (HMAC/RSA via oauth4webapi)
 * - IntrospectionAuthProvider — OAuth2 token introspection (RFC 7662) with cache
 * - OidcAuthProvider — OIDC JWT validation with JWKS discovery (openid-client)
 * - TenantAuthProvider — multi-tenant delegation with per-tenant providers
 * - MemoryAuthProvider — testing mock with pre-configured valid tokens
 *
 * **Plugin integration:**
 * - createAuthPlugin() — generic plugin from any AuthProvider
 * - jwtAuthPlugin(), introspectionAuthPlugin(), oidcAuthPlugin(), etc.
 * - createAuthProvider() — environment-based factory
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Types & Constants
// ---------------------------------------------------------------------------
export type {
    AuthResult,
    AuthProviderConfig,
    JwtAuthConfig,
    IntrospectionAuthConfig,
    TenantAuthConfig,
    MemoryAuthConfig,
    AuthFactoryConfig,
    TokenSource,
    TokenExtractor,
    ClaimsMapper,
    TenantResolver,
    TenantProviderFactory,
    AuthProviderLike,
} from "./types.js";

export type {
    OidcAuthConfig,
    OidcTokens,
    AuthorizationUrlResult,
    BuildAuthorizationUrlParams,
    ExchangeCodeParams,
    OidcSessionState,
    OidcSession,
} from "./oidc-types.js";

export {
    DEFAULT_SERVICE_NAME,
    DEFAULT_PLUGIN_PRIORITY,
    DEFAULT_COOKIE_NAME,
    DEFAULT_QUERY_PARAM_NAME,
    DEFAULT_TOKEN_SOURCES,
} from "./types.js";

// ---------------------------------------------------------------------------
// Abstract Base Class
// ---------------------------------------------------------------------------
export { AuthProvider } from "./abstract-auth-provider.js";

// ---------------------------------------------------------------------------
// Concrete Providers
// ---------------------------------------------------------------------------
export { MemoryAuthProvider } from "./memory-auth-provider.js";
export { JwtAuthProvider } from "./jwt-auth-provider.js";
export { OidcAuthProvider } from "./oidc-auth-provider.js";

// ---------------------------------------------------------------------------
// Plugin Integration
// ---------------------------------------------------------------------------
export {
    createAuthPlugin,
    oidcAuthPlugin,
    jwtAuthPlugin,
    memoryAuthPlugin,
} from "./auth-plugin.js";
export type { AuthPluginOptions } from "./auth-plugin.js";

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------
export { OidcAuthController } from "./oidc-auth-controller.js";
