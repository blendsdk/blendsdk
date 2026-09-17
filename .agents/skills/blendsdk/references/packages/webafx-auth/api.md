> **Package**: `blendsdk/webafx-auth`

# webafx-auth API Reference

This document is the complete reference for the public API surface of `blendsdk/webafx-auth`: the abstract `AuthProvider` base class, the four concrete providers (`MemoryAuthProvider`, `JwtAuthProvider`, `IntrospectionAuthProvider`, `OidcAuthProvider`), the OIDC browser-flow controller (`OidcAuthController`), the WebAFX plugin integration (`createAuthPlugin` and convenience factories), the environment-based provider factory (`createAuthProvider`), and every configuration and result type re-exported by the package entry point.

---

## Exports at a Glance

### Classes

| Export | Description |
|--------|-------------|
| `AuthProvider` | Abstract base class: token extraction, authentication lifecycle, claims mapping |
| `MemoryAuthProvider` | In-memory provider for tests and development |
| `JwtAuthProvider` | Local JWT verification (HMAC / asymmetric) |
| `IntrospectionAuthProvider` | OAuth2 token introspection (RFC 7662) with caching |
| `OidcAuthProvider` | OIDC discovery + JWKS validation, session store, and BFF operations |
| `OidcAuthController` | Authentication controller for the OIDC authorization code flow |

### Functions

| Export | Description |
|--------|-------------|
| `createAuthPlugin` | Wraps any provider as a WebAFX plugin |
| `jwtAuthPlugin` | `JwtAuthProvider` + plugin in one call |
| `introspectionAuthPlugin` | `IntrospectionAuthProvider` + plugin in one call |
| `oidcAuthPlugin` | `OidcAuthProvider` + plugin in one call |
| `memoryAuthPlugin` | `MemoryAuthProvider` + plugin in one call |
| `createAuthProvider` | Builds a provider from a single `AuthFactoryConfig` |

### Constants

| Export | Value |
|--------|-------|
| `DEFAULT_SERVICE_NAME` | `'auth'` |
| `DEFAULT_PLUGIN_PRIORITY` | `10` |
| `DEFAULT_COOKIE_NAME` | `'auth_token'` |
| `DEFAULT_QUERY_PARAM_NAME` | `'token'` |
| `DEFAULT_TOKEN_SOURCES` | `['header']` |

### Type exports

| Group | Types |
|-------|-------|
| Core | `AuthResult`, `PrincipalType`, `AuthProviderConfig`, `TokenSource`, `TokenExtractor`, `ClaimsMapper`, `AuthProviderLike` |
| Provider configuration | `JwtAuthConfig`, `MemoryAuthConfig`, `IntrospectionAuthOptions`, `IntrospectionAuthConfig`, `IntrospectionAuthDynamicConfig`, `IntrospectionProviderConfig` |
| OIDC | `OidcAuthConfig`, `OidcTokens`, `AuthorizationUrlResult`, `BuildAuthorizationUrlParams`, `ExchangeCodeParams`, `OidcSessionState`, `OidcSession` |
| Plugin / factory | `AuthPluginOptions`, `AuthFactoryConfig` |
| Tenant contracts | `TenantAuthConfig`, `TenantResolver`, `TenantProviderFactory` |

---

## Constants

| Constant | Type | Value | Description |
|----------|------|-------|-------------|
| `DEFAULT_SERVICE_NAME` | `string` | `'auth'` | Default service container name for a provider; the default plugin name becomes `auth:auth` |
| `DEFAULT_PLUGIN_PRIORITY` | `number` | `10` | Default WebAFX plugin priority |
| `DEFAULT_COOKIE_NAME` | `string` | `'auth_token'` | Cookie read by the `'cookie'` token source when `cookieName` is not configured |
| `DEFAULT_QUERY_PARAM_NAME` | `string` | `'token'` | Query parameter read by the `'query'` token source when `queryParamName` is not configured |
| `DEFAULT_TOKEN_SOURCES` | `TokenSource[]` | `['header']` | Default extraction chain; a Bearer `Authorization` header is the only default source |

---

## Core Types

### AuthResult

The standardized authenticated identity returned by every provider.

```typescript fragment
interface AuthResult {
    sub: string;
    claims: Record<string, unknown>;
    token: string;
    exp?: number;
    scopes?: string[];
    principalType?: PrincipalType;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `sub` | `string` | Principal identifier. The default claims mapper reads `sub`, then `subject`, and falls back to `"unknown"` |
| `claims` | `Record<string, unknown>` | Raw claims as returned by the backend: JWT payload, introspection response, or OIDC session user object |
| `token` | `string` | The original raw token string that was validated |
| `exp` | `number \| undefined` | Expiration as seconds since the Unix epoch, when the source provides a numeric value |
| `scopes` | `string[] \| undefined` | Parsed scopes: a space-separated `scope` string (RFC 6749), a `scopes` array, or a `scope` array. Empty entries are filtered out |
| `principalType` | `PrincipalType \| undefined` | Optional principal discriminator. Stamped by the provider when configured, unless a custom mapper or stored result already sets it |

### PrincipalType

```typescript fragment
type PrincipalType = "user" | "client";
```

| Value | Description |
|-------|-------------|
| `'user'` | Interactive human principal (for example, an OIDC browser session — the session path always reports `'user'`) |
| `'client'` | Machine/client principal (for example, a service token) |

### TokenSource and TokenExtractor

```typescript fragment
type TokenExtractor = (req: Request) => string | undefined;

type TokenSource = "header" | "cookie" | "query" | { extractor: TokenExtractor };
```

| Variant | Extracts from | Notes |
|---------|---------------|-------|
| `'header'` | `Authorization: Bearer <token>` | Case-sensitive `Bearer ` prefix; an empty token value is treated as "no token" |
| `'cookie'` | Cookie named by `cookieName` | Requires cookie-parser middleware (built into WebAFX); default name `'auth_token'` |
| `'query'` | Query parameter named by `queryParamName` | Only string values are used; default name `'token'` |
| `{ extractor: fn }` | Any custom request location | The function returns the token or `undefined` |

Passing an unsupported value in `tokenSources` makes the constructor throw:

```text
Unknown token source: <json>. Supported: "header", "cookie", "query", or { extractor: fn }
```

### ClaimsMapper

```typescript fragment
type ClaimsMapper = (
    token: string,
    rawClaims: Record<string, unknown>
) => AuthResult;
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `token` | `string` | The original raw token string |
| `rawClaims` | `Record<string, unknown>` | The raw claims object produced by the provider's validation step |

The mapper completely replaces the default mapping. If you want the default behavior for `sub`, `exp`, and `scopes`, read those fields yourself — see `AuthProvider.defaultClaimsMapper` for the exact fallback rules.

### AuthProviderConfig

Base configuration accepted by every provider.

```typescript fragment
interface AuthProviderConfig {
    serviceName?: string;
    tokenSources?: TokenSource[];
    cookieName?: string;
    queryParamName?: string;
    mapClaims?: ClaimsMapper;
    principalType?: PrincipalType;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `serviceName` | `string \| undefined` | Service container registration name. Default: `DEFAULT_SERVICE_NAME` (`'auth'`) |
| `tokenSources` | `TokenSource[] \| undefined` | Ordered token extraction chain; the first non-empty match wins. Default: `DEFAULT_TOKEN_SOURCES` (`['header']`) |
| `cookieName` | `string \| undefined` | Cookie name used by the `'cookie'` source. Default: `DEFAULT_COOKIE_NAME` (`'auth_token'`) |
| `queryParamName` | `string \| undefined` | Query parameter name used by the `'query'` source. Default: `DEFAULT_QUERY_PARAM_NAME` (`'token'`) |
| `mapClaims` | `ClaimsMapper \| undefined` | Custom claims mapper; replaces the default mapper |
| `principalType` | `PrincipalType \| undefined` | Principal type stamped on results that do not already carry one |

### AuthProviderLike

A structural contract describing provider-shaped values consumed by the package's integration helpers. The concrete providers — and any subclass of `AuthProvider` — satisfy it, so applications can type provider values without depending on the abstract class itself.

### Tenant Delegation Contracts

`TenantAuthConfig`, `TenantResolver`, and `TenantProviderFactory` are exported configuration contracts for tenant-delegating authentication setups:

| Type | Purpose |
|------|---------|
| `TenantAuthConfig` | Configuration contract for a tenant-aware authentication setup |
| `TenantResolver` | Contract for resolving the tenant for an incoming request |
| `TenantProviderFactory` | Contract for constructing a provider for a resolved tenant |

This package ships these contracts for typing custom implementations — it does **not** include a concrete tenant provider.

---

## Provider Configuration Types

### JwtAuthConfig

Configuration for `JwtAuthProvider`. Extends all `AuthProviderConfig` fields.

```typescript fragment
interface JwtAuthConfig extends AuthProviderConfig {
    secret: string;
    algorithms?: string[];
    issuer?: string;
    audience?: string | string[];
    requireAudience?: boolean;
    clockTolerance?: number;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `secret` | `string` | Required. Secret or key material used to verify signatures (HMAC secret for `HS*`; PEM/DER key material for asymmetric algorithms) |
| `algorithms` | `string[] \| undefined` | Accepted signing algorithms. Default: `['HS256']` |
| `issuer` | `string \| undefined` | Expected `iss` claim; when unset, issuer validation is skipped |
| `audience` | `string \| string[] \| undefined` | Expected `aud` claim (single value or any-of list); when unset and `requireAudience` is not set, audience validation is skipped |
| `requireAudience` | `boolean \| undefined` | Fail-closed switch: when `true` and no `audience` is configured, every token is rejected |
| `clockTolerance` | `number \| undefined` | Expiration leeway in seconds |

### MemoryAuthConfig

Configuration for `MemoryAuthProvider`. Extends all `AuthProviderConfig` fields.

```typescript fragment
interface MemoryAuthConfig extends AuthProviderConfig {
    validTokens?: Record<string, AuthResult>;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `validTokens` | `Record<string, AuthResult> \| undefined` | Token map to pre-seed the provider with; keys are raw token strings, values are the `AuthResult` returned for that token |

### IntrospectionAuthOptions

Options shared by static and dynamic introspection configuration. Extends all `AuthProviderConfig` fields.

```typescript fragment
interface IntrospectionAuthOptions extends AuthProviderConfig {
    authMethod?: "basic" | "post";
    timeout?: number;
    audience?: string | string[];
    cacheTTL?: number;
    maxCacheSize?: number;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `authMethod` | `'basic' \| 'post' \| undefined` | Client authentication method. Default: `'basic'` (`client_secret_basic`); `'post'` sends credentials in the request body (`client_secret_post`) |
| `timeout` | `number \| undefined` | Request timeout in milliseconds; the introspection call is aborted when exceeded |
| `audience` | `string \| string[] \| undefined` | Expected `aud` claim of the introspection response; responses without an audience are rejected when one is configured |
| `cacheTTL` | `number \| undefined` | Cache lifetime in seconds for active responses; clamped down to the token's remaining lifetime (`exp`) |
| `maxCacheSize` | `number \| undefined` | Maximum number of cached responses; least-recently-used entries are evicted first |

### IntrospectionAuthConfig

Static (single-tenant or startup-configured) introspection configuration.

```typescript fragment
interface IntrospectionAuthConfig extends IntrospectionAuthOptions {
    introspectionUrl: string;
    clientId: string;
    clientSecret: string;
    // configFactory is inherited from IntrospectionAuthOptions
}
```

| Property | Type | Description |
|----------|------|-------------|
| `introspectionUrl` | `string` | Required for static configuration. URL of the RFC 7662 introspection endpoint |
| `clientId` | `string` | Required for static configuration. OAuth2 client identifier |
| `clientSecret` | `string` | Required for static configuration. OAuth2 client secret |
| `configFactory` | `(req: Request) => IntrospectionAuthConfig \| Promise<IntrospectionAuthConfig>` | Inherited from `IntrospectionAuthOptions`. Optional per-request credential resolver; when present it takes precedence over the static triple for every request |

### IntrospectionAuthDynamicConfig

Dynamic (per-request credential) introspection configuration.

```typescript fragment
interface IntrospectionAuthDynamicConfig extends IntrospectionAuthOptions {
    configFactory: (req: Request) => Promise<IntrospectionAuthConfig>;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `configFactory` | `(req: Request) => Promise<IntrospectionAuthConfig>` | Required. Resolves the endpoint and client credentials from the request (for example, per tenant). Errors thrown by the factory propagate to the caller |

### IntrospectionProviderConfig

```typescript fragment
type IntrospectionProviderConfig =
    | IntrospectionAuthConfig
    | IntrospectionAuthDynamicConfig;
```

The union accepted by the `IntrospectionAuthProvider` constructor: either a complete static triple, or a `configFactory` (or both — in which case the factory wins).

---

## OIDC Types

### OidcAuthConfig

Configuration for `OidcAuthProvider`. Extends all `AuthProviderConfig` fields.

```typescript fragment
interface OidcAuthConfig extends AuthProviderConfig {
    issuerUrl?: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    scopes?: string[];
    audience?: string | string[];
    requireAudience?: boolean;
    clockTolerance?: number;
    discoveryTtl?: number;
    sessionStore?: CacheProvider;
    sessionTtl?: number;
    stateTtl?: number;
    sessionCookieTtl?: number;
    rotateSessionIdOnRefresh?: boolean;
    resolveSessionCookieName?: (req: Request) => string;
    resolveStateCookieName?: (req: Request) => string;
    resolveUser?: (
        req: Request,
        claims: Record<string, unknown>
    ) => AuthResult | undefined | Promise<AuthResult | undefined>;
    configFactory?: (req: Request) => Promise<OidcAuthConfig>;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `issuerUrl` | `string \| undefined` | OIDC issuer URL used for discovery. Required unless a `configFactory` is provided |
| `clientId` | `string \| undefined` | OIDC client identifier; required by the BFF methods and for discovery |
| `clientSecret` | `string \| undefined` | OIDC client secret |
| `redirectUri` | `string \| undefined` | Registered redirect URI; required by `buildAuthorizationUrl` and used to build the callback URL for code exchange |
| `scopes` | `string[] \| undefined` | Requested scopes. Default: `['openid', 'profile', 'email']` |
| `audience` | `string \| string[] \| undefined` | Expected `aud` of bearer tokens (single value or any-of list) |
| `requireAudience` | `boolean \| undefined` | Fail-closed switch: when `true` and no `audience` is configured, every token is rejected before discovery or verification |
| `clockTolerance` | `number \| undefined` | Expiration leeway in seconds for JWT verification and session expiry checks. Default: `30` |
| `discoveryTtl` | `number \| undefined` | Cache lifetime in seconds for OIDC discovery metadata, per issuer URL |
| `sessionStore` | `CacheProvider \| undefined` | A `blendsdk/webafx-cache` provider used to persist sessions and PKCE state server-side; enables the session-cookie authentication path |
| `sessionTtl` | `number \| undefined` | Server-side session TTL in seconds. Default: `3600` |
| `stateTtl` | `number \| undefined` | PKCE state TTL in seconds. Default: `300` |
| `sessionCookieTtl` | `number \| undefined` | Browser cookie lifetime in seconds; falls back to `sessionTtl`, then `3600`. An explicit `0` is honored |
| `rotateSessionIdOnRefresh` | `boolean \| undefined` | When `true`, a successful refresh moves the session to a new opaque ID and re-issues the cookie. Default: `false` |
| `resolveSessionCookieName` | `(req: Request) => string \| undefined` | Per-request session cookie name resolver. Default: `'__oidc_session'` |
| `resolveStateCookieName` | `(req: Request) => string \| undefined` | Per-request state cookie name resolver. Default: `'__oidc_state'` |
| `resolveUser` | `(req, claims) => AuthResult \| undefined \| Promise<AuthResult \| undefined> \| undefined` | Per-request identity resolver for the bearer path; preferred over `mapClaims` when present |
| `configFactory` | `(req: Request) => Promise<OidcAuthConfig> \| undefined` | Per-request configuration resolver (multi-tenant deployments) |

### OidcTokens

Standardized token endpoint response.

```typescript fragment
interface OidcTokens {
    accessToken: string;
    tokenType: string;
    expiresIn?: number;
    refreshToken?: string;
    idToken?: string;
    scope?: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `accessToken` | `string` | The issued access token |
| `tokenType` | `string` | Token type; defaults to `'Bearer'` when the endpoint does not send one |
| `expiresIn` | `number \| undefined` | Access token lifetime in seconds |
| `refreshToken` | `string \| undefined` | Refresh token, when the endpoint issues one |
| `idToken` | `string \| undefined` | ID token, when present |
| `scope` | `string \| undefined` | Space-separated granted scopes |

### AuthorizationUrlResult

Result of `OidcAuthProvider.buildAuthorizationUrl()`.

```typescript fragment
interface AuthorizationUrlResult {
    url: string;
    codeVerifier: string;
    state: string;
    nonce: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `url` | `string` | The authorization URL to redirect the browser to |
| `codeVerifier` | `string` | PKCE code verifier to persist alongside the state |
| `state` | `string` | CSRF state value to persist alongside the verifier |
| `nonce` | `string` | Nonce to persist and pass back as `expectedNonce` during code exchange |

### BuildAuthorizationUrlParams

Optional overrides for `buildAuthorizationUrl`.

```typescript fragment
interface BuildAuthorizationUrlParams {
    clientId?: string;
    redirectUri?: string;
    scopes?: string[];
    extraParams?: Record<string, string>;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `clientId` | `string \| undefined` | Overrides the configured client ID for this call |
| `redirectUri` | `string \| undefined` | Overrides the configured redirect URI for this call |
| `scopes` | `string[] \| undefined` | Overrides the configured scopes (joined with spaces in the request) |
| `extraParams` | `Record<string, string> \| undefined` | Additional authorization parameters (for example `prompt`, `login_hint`, or `acr_values`) |

### ExchangeCodeParams

Parameters for `OidcAuthProvider.exchangeCode()`.

```typescript fragment
interface ExchangeCodeParams {
    codeVerifier: string;
    callbackUrl: string;
    nonce?: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `codeVerifier` | `string` | PKCE code verifier persisted during login |
| `callbackUrl` | `string` | The full callback URL received on the redirect (must include `code` and `state`; RFC 9207 `iss` is forwarded when present) |
| `nonce` | `string \| undefined` | Expected nonce for ID token validation |

### OidcSessionState

Transient PKCE state stored server-side during the login redirect.

```typescript fragment
interface OidcSessionState {
    codeVerifier: string;
    state: string;
    nonce: string;
    returnTo?: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `codeVerifier` | `string` | PKCE code verifier |
| `state` | `string` | The `state` value sent to the IdP; compared on callback |
| `nonce` | `string` | The `nonce` sent to the IdP; passed as `expectedNonce` on exchange |
| `returnTo` | `string \| undefined` | Optional post-login redirect target captured from the login request |

### OidcSession

Server-side session stored in the `sessionStore` under `oidc:session:<id>`.

```typescript fragment
interface OidcSession {
    accessToken: string;
    refreshToken?: string;
    idToken?: string;
    expiresAt?: number;
    user: Record<string, unknown>;
    organizationSlug?: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `accessToken` | `string` | Access token for the session; returned as `AuthResult.token` on the session path |
| `refreshToken` | `string \| undefined` | Refresh token, when the IdP issued one |
| `idToken` | `string \| undefined` | ID token, when present |
| `expiresAt` | `number \| undefined` | Access token expiry as seconds since the Unix epoch; enforced by the provider with `clockTolerance` |
| `user` | `Record<string, unknown>` | UserInfo claims; returned as `AuthResult.claims` on the session path |
| `organizationSlug` | `string \| undefined` | Tenant/organization slug stamped by `OidcAuthController` when `resolveOrganization` is overridden |

---

## AuthProvider (Abstract Base Class)

```typescript fragment
abstract class AuthProvider { }
```

The base class for every authentication backend. It owns the shared lifecycle — extract a token from the request, delegate to `validate()`, return the identity — plus the configurable token extraction chain, the default claims mapper, and principal-type stamping. Concrete providers implement only `validate()`, `health()`, and `shutdown()`.

Design properties of the class:

- Application-wide singleton (not per-request).
- Configurable extraction chain (`'header'`, `'cookie'`, `'query'`, or `{ extractor }`).
- Silent failure: a missing, malformed, or expired token yields `undefined`, never a throw.
- Infrastructure failures (network, DNS) are the only thrown exceptions.

### Constructor

```typescript fragment
constructor(config: AuthProviderConfig = {})
```

Builds the ordered token extraction chain from `tokenSources` and installs the claims mapper (custom `mapClaims` or the default). Throws an `Error` when `tokenSources` contains an unknown source value.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `AuthProviderConfig` | No | `{}` | Base configuration: service name, token sources, cookie/query names, claims mapper, principal type |

### Properties

| Property | Type | Visibility | Description |
|----------|------|------------|-------------|
| `_serviceName` | `string` | protected | Service container registration name (exposed via the `serviceName` getter) |
| `_principalType` | `PrincipalType \| undefined` | protected | Configured default principal type; applied by `withPrincipalType` and the default mapper |
| `tokenExtractors` | `Array<(req: Request) => string \| undefined>` | protected | Ordered extraction chain built at construction time |
| `claimsMapper` | `ClaimsMapper` | protected | The active claims mapping function (custom or default) |
| `cookieName` | `string` | protected | Cookie name used by the `'cookie'` source |
| `queryParamName` | `string` | protected | Query parameter name used by the `'query'` source |

### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `serviceName` (getter) | `get serviceName(): string` | `string` | The configured service name |
| `extractToken` | `extractToken(req: Request): string \| undefined` | `string \| undefined` | Walks the extraction chain in order; first non-empty match wins. `undefined` is not an error — unauthenticated requests are normal for public routes |
| `authenticate` | `authenticate(req: Request): Promise<AuthResult \| undefined>` | `Promise<AuthResult \| undefined>` | The main entry point called by the plugin middleware: extract → validate. Returns `undefined` when no token is found or the token is invalid |
| `validate` | `abstract validate(token: string): Promise<AuthResult \| undefined>` | `Promise<AuthResult \| undefined>` | Validates a raw token. The only method concrete providers must implement |
| `health` | `abstract health(): Promise<boolean>` | `Promise<boolean>` | Backend health check for the WebAFX health endpoint |
| `shutdown` | `abstract shutdown(): Promise<void>` | `Promise<void>` | Graceful shutdown: release connections, cached keys, timers |
| `defaultClaimsMapper` | `protected defaultClaimsMapper(token: string, rawClaims: Record<string, unknown>): AuthResult` | `AuthResult` | Default mapping: `sub` → `subject` → `'unknown'`; numeric `exp`; scopes from a space-separated `scope` string, a `scopes` array, or a `scope` array. Adds `principalType` when configured |
| `withPrincipalType` | `protected withPrincipalType(result: AuthResult \| undefined): AuthResult \| undefined` | `AuthResult \| undefined` | Fills the configured `principalType` on a result that does not already carry one; returns `undefined` unchanged. A value set by a custom mapper or stored result stays authoritative |

### Example

The base class is used through its concrete implementations; the shared lifecycle is the same for all of them.

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const provider = new JwtAuthProvider({
    secret: 'a-development-only-secret-at-least-32-bytes!',
});

const result = await provider.validate(process.env.ACCESS_TOKEN ?? '');

if (result) {
    console.log(`Authenticated subject: ${result.sub}`);
} else {
    console.log('Token rejected');
}

await provider.shutdown();
```

---

## MemoryAuthProvider

```typescript fragment
class MemoryAuthProvider extends AuthProvider { }
```

An in-memory provider with a pre-configured token map. Intended for tests and local development — no network, no crypto, deterministic results. `validate()` returns the stored `AuthResult` **as-is**; the claims mapper is not applied to stored results, but a stored result without a `principalType` inherits the configured one.

### Constructor

```typescript fragment
constructor(config?: MemoryAuthConfig)
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `MemoryAuthConfig` | No | `{}` | Optional `validTokens` map plus any `AuthProviderConfig` field |

### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `validate` | `validate(token: string): Promise<AuthResult \| undefined>` | `Promise<AuthResult \| undefined>` | Map lookup; `undefined` for unknown or empty tokens |
| `addToken` | `addToken(token: string, result: AuthResult): void` | `void` | Adds a token or overwrites an existing entry |
| `removeToken` | `removeToken(token: string): boolean` | `boolean` | Removes a token; `true` when an entry existed |
| `getTokenCount` | `getTokenCount(): number` | `number` | Number of registered tokens |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | Always resolves `true` |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Clears all tokens; safe to call repeatedly |

Inherited: `serviceName`, `extractToken`, `authenticate`.

### Example

```typescript
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';

const provider = new MemoryAuthProvider({
    validTokens: {
        'demo-token': { sub: 'user-1', claims: { role: 'admin' }, token: 'demo-token' },
    },
});

provider.addToken('second-token', { sub: 'user-2', claims: {}, token: 'second-token' });
console.log(`tokens stored: ${provider.getTokenCount()}`);

const result = await provider.validate('demo-token');
console.log(`authenticated subject: ${result?.sub ?? 'none'}`);
```

---

## JwtAuthProvider

```typescript fragment
class JwtAuthProvider extends AuthProvider { }
```

Local JWT verification using `jose` — no network round trip. Configured with a secret (or key material), accepted algorithms, and optional issuer/audience constraints.

Verification behavior:

- Correctly signed tokens within their expiry window are accepted; `clockTolerance` extends the window.
- Expired tokens, tokens signed with a different secret, malformed strings, and structurally valid but garbage tokens all resolve to `undefined` — never a throw.
- `issuer` and `audience` are validated only when configured; a wrong `iss`/`aud` resolves to `undefined`.
- `requireAudience: true` with no `audience` configured rejects every token (fail-closed).

### Constructor

```typescript fragment
constructor(config: JwtAuthConfig)
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `JwtAuthConfig` | Yes | — | Requires `secret`; see `JwtAuthConfig` for all options |

### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `validate` | `validate(token: string): Promise<AuthResult \| undefined>` | `Promise<AuthResult \| undefined>` | Verifies the token and maps claims via `mapClaims` or the default mapper |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | Resolves `true` when a secret is configured |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Clears cached key material; key material is re-created lazily, so the provider remains usable. Safe to call multiple times |

Inherited: `serviceName`, `extractToken`, `authenticate`.

### Example

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const provider = new JwtAuthProvider({
    secret: 'a-development-only-secret-at-least-32-bytes!',
    algorithms: ['HS256'],
    issuer: 'https://auth.example.com',
    audience: 'my-api',
    clockTolerance: 30,
});

const result = await provider.validate(process.env.ACCESS_TOKEN ?? '');

if (result) {
    console.log(`Authenticated subject: ${result.sub}`);
} else {
    console.log('Token rejected');
}

await provider.shutdown();
```

---

## IntrospectionAuthProvider

```typescript fragment
class IntrospectionAuthProvider extends AuthProvider { }
```

Validates opaque access tokens against an OAuth2 token introspection endpoint (RFC 7662), with an internal response cache. The constructor requires either a complete static triple (`introspectionUrl`, `clientId`, `clientSecret`) or a `configFactory`; otherwise it throws.

### Constructor

```typescript fragment
constructor(config: IntrospectionProviderConfig)
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `IntrospectionProviderConfig` | Yes | — | Static configuration, dynamic configuration, or both (the `configFactory` wins when both are present) |

### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `validate` | `validate(token: string): Promise<AuthResult \| undefined>` | `Promise<AuthResult \| undefined>` | Introspects the token. When only a `configFactory` is configured (no static triple), resolves `undefined` — request-scoped credentials are unavailable without a request |
| `authenticate` | `authenticate(req: Request): Promise<AuthResult \| undefined>` | `Promise<AuthResult \| undefined>` | Extracts the token and resolves the per-request configuration via `configFactory(req)` before introspecting |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | Resolves `true` for both static and dynamic configuration; no network probe is performed |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Clears the cache; the next validation re-fetches from the endpoint |

Inherited: `serviceName`, `extractToken`.

### Request shape (RFC 7662)

| Aspect | Behavior |
|--------|----------|
| Method / URL | `POST` to `introspectionUrl` |
| `Content-Type` | `application/x-www-form-urlencoded` |
| `Accept` | `application/json` |
| Body | `token=<token>` and `token_type_hint=access_token` |
| Client auth — `'basic'` (default) | `Authorization: Basic <base64>` with RFC 6749 percent-encoded `clientId:clientSecret`; credentials are never placed in the body |
| Client auth — `'post'` | `client_id` and `client_secret` in the body; no `Authorization` header |
| Timeout | The request is aborted after `timeout` milliseconds |

### Caching

- Only active responses are cached. Inactive responses (`active: false`) and failed requests are never cached.
- An active response whose `exp` is already in the past is rejected and not cached.
- The cache TTL is `cacheTTL` seconds, clamped down to the token's remaining lifetime.
- Cache keys are SHA-256 hex digests of the token — raw tokens never appear in cache keys.
- `maxCacheSize` bounds the cache; the least-recently-used entry is evicted first.
- Entries are scoped to the resolved client configuration: the same token validated for two different tenants results in two endpoint calls.
- The claims mapper runs on every call, including cache hits.

### Error semantics

| Condition | Behavior |
|-----------|----------|
| Non-2xx response | Throws an error containing the HTTP status; the token and client secret are never included in the message |
| Network failure | The fetch error propagates |
| Invalid JSON or non-object body | Throws (for example, `invalid response body`) |
| `configFactory` throws | The error propagates as-is |
| `configFactory` resolves an incomplete config | Rejects with an error naming the missing field (for example, `introspectionUrl`); no HTTP call is made |
| Inactive / expired / audience mismatch | Resolves `undefined` (not an error) |

### Example

```typescript
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';

const provider = new IntrospectionAuthProvider({
    introspectionUrl: process.env.INTROSPECT_URL ?? 'https://auth.example.com/oauth2/introspect',
    clientId: process.env.CLIENT_ID ?? 'my-client',
    clientSecret: process.env.CLIENT_SECRET ?? 'my-secret',
    authMethod: 'basic',
    cacheTTL: 60,
    maxCacheSize: 1000,
});

try {
    const result = await provider.validate(process.env.ACCESS_TOKEN ?? '');

    if (result) {
        console.log(`Authenticated subject: ${result.sub}`);
    } else {
        console.log('Token rejected (inactive, expired, or audience mismatch)');
    }
} catch (error) {
    console.error('Introspection endpoint unreachable', error);
} finally {
    await provider.shutdown();
}
```

---

## OidcAuthProvider

```typescript fragment
class OidcAuthProvider extends AuthProvider { }
```

OIDC provider with JWT validation via discovery/JWKS, server-side sessions, and backend-for-frontend (BFF) operations for the authorization code flow. The constructor throws `OidcAuthProvider requires either issuerUrl or configFactory` when neither is provided.

### Constructor

```typescript fragment
constructor(config: OidcAuthConfig)
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `OidcAuthConfig` | Yes | — | Requires `issuerUrl` or `configFactory`; see `OidcAuthConfig` for all options |

### Dual-mode authenticate()

`authenticate(req)` evaluates two authentication paths in priority order:

| Priority | Source | Condition | Result |
|----------|--------|-----------|--------|
| 1 | Bearer JWT | A bearer token is present | JWKS verification, claims mapped via `mapClaims`/`resolveUser`/default mapper; `principalType` stamped from config |
| 2 | Session cookie | No bearer token, and `sessionStore` is configured | Session loaded from `oidc:session:<id>`; `claims` = session `user`, `token` = session `accessToken`, `exp` = session `expiresAt`; `principalType` is always `'user'` |

Session path details:

- The cookie name is resolved per request via `resolveSessionCookieName(req)` (default `'__oidc_session'`); the cookie value is URL-decoded before lookup.
- A session missing from the store resolves to `undefined`, as does a session whose `expiresAt` is in the past beyond `clockTolerance` (default 30 seconds).
- `CacheProvider` errors propagate — they are not swallowed.

### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `validate` | `validate(token: string): Promise<AuthResult \| undefined>` | `Promise<AuthResult \| undefined>` | Bearer-only verification. Returns `undefined` when only a `configFactory` is configured, and fails closed before discovery when `requireAudience` is set without an `audience` |
| `authenticate` | `authenticate(req: Request): Promise<AuthResult \| undefined>` | `Promise<AuthResult \| undefined>` | Dual-mode entry point (bearer first, session-cookie fallback); resolves per-request configuration via `configFactory` |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | `true` when a static config is set and discovery succeeds; `false` without a static config or when discovery fails |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Clears the discovery cache |
| `buildAuthorizationUrl` | `buildAuthorizationUrl(config?: OidcAuthConfig, params?: BuildAuthorizationUrlParams): Promise<AuthorizationUrlResult>` | `Promise<AuthorizationUrlResult>` | Builds the authorization URL with PKCE, `state`, and `nonce`. Throws `clientId is required for buildAuthorizationUrl` / `redirectUri is required for buildAuthorizationUrl` when missing |
| `exchangeCode` | `exchangeCode(params: ExchangeCodeParams, config?: OidcAuthConfig): Promise<OidcTokens>` | `Promise<OidcTokens>` | Exchanges the authorization code, validating `expectedNonce` when provided. Throws `issuerUrl and clientId are required for exchangeCode` |
| `refreshToken` | `refreshToken(refreshToken: string, config?: OidcAuthConfig): Promise<OidcTokens>` | `Promise<OidcTokens>` | Refreshes tokens. Throws `issuerUrl and clientId are required for refreshToken` |
| `revokeToken` | `revokeToken(token: string, tokenTypeHint?: string, config?: OidcAuthConfig): Promise<void>` | `Promise<void>` | Revokes a token (for example, with hint `'access_token'` or `'refresh_token'`). Throws `issuerUrl and clientId are required for revokeToken` |
| `fetchUserInfo` | `fetchUserInfo(accessToken: string, subject?: string, config?: OidcAuthConfig): Promise<Record<string, unknown>>` | `Promise<Record<string, unknown>>` | Fetches UserInfo; the subject is verified when provided, otherwise the subject check is skipped. Throws `issuerUrl and clientId are required for fetchUserInfo` |

### Session and state storage

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `storeSession` | `storeSession(id: string, session: OidcSession): Promise<void>` | `Promise<void>` | Stores a session under `oidc:session:<id>` with the `sessionTtl` TTL (default 3600 seconds) |
| `getSession` | `getSession(id: string): Promise<OidcSession \| undefined>` | `Promise<OidcSession \| undefined>` | Reads a session; `undefined` for missing keys |
| `clearSession` | `clearSession(id: string): Promise<void>` | `Promise<void>` | Deletes a session; safe for missing keys |
| `storeState` | `storeState(id: string, state: OidcSessionState): Promise<void>` | `Promise<void>` | Stores PKCE state under `oidc:state:<id>` with the `stateTtl` TTL (default 300 seconds) |
| `getState` | `getState(id: string): Promise<OidcSessionState \| undefined>` | `Promise<OidcSessionState \| undefined>` | Reads PKCE state; `undefined` for missing keys |
| `clearState` | `clearState(id: string): Promise<void>` | `Promise<void>` | Deletes PKCE state; safe for missing keys |

All six operations throw `sessionStore is required` when no `sessionStore` is configured.

### Cookie configuration

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `getSessionCookieName` | `getSessionCookieName(req: Request): string` | `string` | The resolved session cookie name (default `'__oidc_session'`) |
| `getStateCookieName` | `getStateCookieName(req: Request): string` | `string` | The resolved state cookie name (default `'__oidc_state'`) |
| `getSessionCookieTtl` | `getSessionCookieTtl(): number` | `number` | Resolution order: `sessionCookieTtl` → `sessionTtl` → `3600`. An explicit `0` is honored |
| `shouldRotateSessionIdOnRefresh` | `shouldRotateSessionIdOnRefresh(): boolean` | `boolean` | The configured `rotateSessionIdOnRefresh` flag (default `false`) |
| `getRedirectUri` | `getRedirectUri(): string` | `string` | The configured `redirectUri`, used by the controller to build the code-exchange callback URL |

Discovery details: discovery metadata is fetched lazily on first verification and cached per issuer URL for `discoveryTtl` seconds; JWKS is resolved from the discovered `jwks_uri` (metadata without it makes verification resolve to `undefined`); `shutdown()` clears the cache. `resolveUser` is preferred over `mapClaims` on the bearer path; a synchronously throwing `mapClaims` is treated as a failed authentication (`undefined`), while an error from an async `resolveUser` propagates.

### Example

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

const provider = new OidcAuthProvider({
    issuerUrl: process.env.OIDC_ISSUER_URL ?? 'https://auth.example.com',
    clientId: process.env.OIDC_CLIENT_ID ?? 'my-client',
    audience: 'https://api.example.com',
    clockTolerance: 30,
});

const result = await provider.validate(process.env.ACCESS_TOKEN ?? '');

if (result) {
    console.log(`Authenticated subject: ${result.sub}`);
} else {
    console.log('Token rejected');
}

await provider.shutdown();
```

---

## OidcAuthController

```typescript fragment
class OidcAuthController extends BaseController { }
```

Backend-for-frontend controller implementing the OIDC authorization code flow with PKCE. Sessions are stored server-side via `OidcAuthProvider` (no tokens in cookies); the browser only carries opaque UUID cookie values. Register it with `app.registerController()`; the WebAFX runtime instantiates it with settings and services.

### Constructor

```typescript fragment
constructor(settings: ApplicationSettings, services: ServiceContainer)
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `settings` | `ApplicationSettings` | Yes | — | Application settings supplied by the runtime; `isProduction()` controls the cookie `secure` flag |
| `services` | `ServiceContainer` | Yes | — | The service container; used for provider resolution via `req.services` |

### Routes

```typescript fragment
routes(): RouteDefinition[]
```

Returns exactly five routes, using the prefix from `getRoutePrefix()` (default `/api/oidc`):

| Method | Path | Guard | Handler | Behavior |
|--------|------|-------|---------|----------|
| GET | `<prefix>/login` | Public | `handleLogin` | Builds the authorization URL (PKCE, state, nonce), stores state, sets the state cookie, redirects |
| GET | `<prefix>/callback` | Public | `handleCallback` | Exchanges the code, fetches UserInfo, stores the session, sets the session cookie, clears the state cookie, redirects to `returnTo ?? '/'` |
| POST | `<prefix>/logout` | Self-validating | `handleLogout` | Clears the session and cookie; revocation is best-effort |
| GET | `<prefix>/me` | `secure: true` | `handleMe` | Returns the current user and session expiry |
| POST | `<prefix>/refresh` | Self-validating | `handleRefresh` | Refreshes tokens; works even when the access token has already expired |

### Handler methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `handleLogin` | `handleLogin(req: Request, res: Response): Promise<void>` | `Promise<void>` | Stores `OidcSessionState` (`codeVerifier`, `state`, `nonce`, `returnTo`) via `provider.storeState(uuid)`; sets the state cookie to the UUID (max age 5 minutes); redirects to the authorization URL |
| `handleCallback` | `handleCallback(req: Request, res: Response): Promise<void>` | `Promise<void>` | Loads state by cookie UUID; validates the `state` query parameter; exchanges the code (forwarding RFC 9207 `iss`); fetches UserInfo; calls `onCallback`; resolves `resolveOrganization` into `organizationSlug`; strips null/undefined token fields from the session; stores the session via `provider.storeSession(uuid)`; sets the session cookie (max age from `getSessionCookieTtl()`); clears the state cookie |
| `handleLogout` | `handleLogout(req: Request, res: Response): Promise<void>` | `Promise<void>` | Calls `onLogout`; attempts `revokeToken(accessToken, 'access_token')` and swallows failures; clears the session and cookie; responds `{ success: true, data: { message: 'Logged out' } }`. Idempotent without a session |
| `handleMe` | `handleMe(req: Request, res: Response): Promise<void>` | `Promise<void>` | Responds `{ success: true, data: { user, expiresAt } }`; never exposes tokens |
| `handleRefresh` | `handleRefresh(req: Request, res: Response): Promise<void>` | `Promise<void>` | Refreshes via `provider.refreshToken`; preserves the old refresh token when the response omits one; optionally rotates the session ID (store → delete → cookie); re-issues the cookie; responds `{ success: true, data: { expiresAt, message: 'Tokens refreshed' } }` |

On refresh failure the existing session and cookie stay untouched and no cookie is re-issued.

### Response shapes

Error responses use `{ success: false, error: { code, message } }`:

| Code | Status | Message |
|------|--------|---------|
| `oidc_error` | 400 | The provider-supplied `error_description` |
| `missing_code` | 400 | `Authorization code missing from callback` |
| `missing_state` | 400 | `Session state not found (expired or missing)` |
| `invalid_state` | 400 | `State parameter mismatch (possible CSRF)` |
| `no_session` | 401 | `No active session` |
| `no_refresh_token` | 400 | `No refresh token available` |

### Protected override points

| Hook | Signature | Default behavior |
|------|-----------|------------------|
| `getProvider` | `getProvider(req: Request): Promise<OidcAuthProvider>` | Resolves the provider from `req.services.get(getProviderServiceName())` |
| `getProviderServiceName` | `getProviderServiceName(): string` | `'auth'` |
| `getRoutePrefix` | `getRoutePrefix(): string` | `'/api/oidc'` |
| `getLoginParams` | `getLoginParams(req: Request): BuildAuthorizationUrlParams` | Forwards the `prompt` and `login_hint` query parameters; all other query parameters are ignored |
| `resolveOrganization` | `resolveOrganization(req: Request): string \| undefined` | `undefined` (single-tenant); a returned slug is stored as `session.organizationSlug` |
| `onCallback` | `onCallback(tokens: OidcTokens, userInfo: Record<string, unknown>, req: Request, res: Response): Promise<{ tokens: OidcTokens; userInfo: Record<string, unknown> }>` | Returns its inputs unchanged; override to enrich the session before it is stored |
| `onLogout` | `onLogout(req: Request, res: Response): Promise<void>` | No-op; runs before session teardown |
| `setCookie` | `setCookie(res: Response, name: string, value: string, options: CookieOptions): void` | Sets a cookie with `httpOnly: true`, `sameSite: 'lax'`, `path: '/'`, `secure: settings.isProduction()`, merged with the given options |

### Cookie behavior

- The state cookie carries a short UUID (never a signed payload) and expires after 5 minutes.
- The session cookie max age follows `getSessionCookieTtl()` — it is independent of the (shorter) access token lifetime.
- The session cookie is re-issued on every successful refresh with the same or a rotated session ID; repeated refreshes do not drift the cookie window.
- Both cookies are cleared on logout and on successful callback (state cookie).

### Example

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { OidcAuthController } from 'blendsdk/webafx-auth';
import type { OidcTokens } from 'blendsdk/webafx-auth';
import type { Request, Response } from 'express';

class AppOidcController extends OidcAuthController {
    protected getRoutePrefix(): string {
        return '/api/auth';
    }

    protected async onCallback(
        tokens: OidcTokens,
        userInfo: Record<string, unknown>,
        _req: Request,
        _res: Response
    ): Promise<{ tokens: OidcTokens; userInfo: Record<string, unknown> }> {
        return { tokens, userInfo: { ...userInfo, roles: ['member'] } };
    }
}

const app = new WebApplication({
    PORT: 3400,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

app.registerController('', AppOidcController);
await app.start();
```

---

## Plugin Integration

### AuthPluginOptions

```typescript fragment
interface AuthPluginOptions {
    serviceName?: string;
    userServiceName?: string;
    priority?: number;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `serviceName` | `string \| undefined` | Name for the singleton provider registration; the plugin name becomes `auth:<serviceName>`. Default: `DEFAULT_SERVICE_NAME` (`'auth'`) |
| `userServiceName` | `string \| undefined` | Name for the per-request principal registration. Default: `'user'` |
| `priority` | `number \| undefined` | WebAFX plugin ordering priority. Default: `DEFAULT_PLUGIN_PRIORITY` (`10`) |

### createAuthPlugin

```typescript fragment
function createAuthPlugin(provider: AuthProvider, options?: AuthPluginOptions): PluginDefinition
```

Wraps any provider as a WebAFX plugin. When the plugin factory executes it registers two services and returns health/shutdown delegates:

| Registered service | Type | Resolves to |
|--------------------|------|-------------|
| `<serviceName>` | singleton | The exact provider instance passed to `createAuthPlugin` |
| `<userServiceName>` | per-request | `AuthResult \| undefined` for the current request, via `provider.authenticate(req)`; `undefined` means unauthenticated |

The plugin also logs the provider class name and service name once on installation, and its factory result exposes `health()` and `shutdown()` that delegate to the provider. Registering a second plugin with the same name is rejected at startup (`Plugin "auth:auth" is already registered`), so multiple providers in one application must use distinct `serviceName` values.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `provider` | `AuthProvider` | Yes | — | The provider instance to register |
| `options` | `AuthPluginOptions` | No | `{}` | Service names and plugin priority |

Returns: `PluginDefinition` (from `blendsdk/webafx`) with `name` = `auth:<serviceName>`, `priority`, and an async `factory`.

#### Example

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { createAuthPlugin, MemoryAuthProvider } from 'blendsdk/webafx-auth';

const provider = new MemoryAuthProvider({
    validTokens: {
        'demo-token': { sub: 'user-1', claims: {}, token: 'demo-token' },
    },
});

const app = new WebApplication({
    PORT: 3400,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

app.use(createAuthPlugin(provider, {
    serviceName: 'auth',
    userServiceName: 'user',
    priority: 10,
}));

await app.start();
```

### Convenience Factories

Each factory constructs a provider from the given configuration and delegates to `createAuthPlugin` with the same options:

| Function | Signature | Config type | Provider built |
|----------|-----------|-------------|----------------|
| `jwtAuthPlugin` | `jwtAuthPlugin(config: JwtAuthConfig, options?: AuthPluginOptions): PluginDefinition` | `JwtAuthConfig` | `JwtAuthProvider` |
| `introspectionAuthPlugin` | `introspectionAuthPlugin(config: IntrospectionProviderConfig, options?: AuthPluginOptions): PluginDefinition` | `IntrospectionProviderConfig` | `IntrospectionAuthProvider` |
| `oidcAuthPlugin` | `oidcAuthPlugin(config: OidcAuthConfig, options?: AuthPluginOptions): PluginDefinition` | `OidcAuthConfig` | `OidcAuthProvider` |
| `memoryAuthPlugin` | `memoryAuthPlugin(config: MemoryAuthConfig, options?: AuthPluginOptions): PluginDefinition` | `MemoryAuthConfig` | `MemoryAuthProvider` |

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | Provider-specific config type | Yes | — | Passed to the provider constructor; validation errors surface at construction time |
| `options` | `AuthPluginOptions` | No | `{}` | Forwarded to `createAuthPlugin`; defaults apply (plugin name `auth:auth`, priority 10) |

#### Example

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { jwtAuthPlugin } from 'blendsdk/webafx-auth';

const app = new WebApplication({
    PORT: 3400,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

app.use(jwtAuthPlugin(
    { secret: 'a-development-only-secret-at-least-32-bytes!' },
    { serviceName: 'jwt-auth', priority: 5 }
));

await app.start();
```

---

## Provider Factory (createAuthProvider)

### AuthFactoryConfig

Discriminated union selecting the provider type; each arm combines the `type` discriminant with the provider's own configuration type (including all shared `AuthProviderConfig` fields).

```typescript fragment
type AuthFactoryConfig =
    | ({ type: "jwt" } & JwtAuthConfig)
    | ({ type: "introspection" } & IntrospectionProviderConfig)
    | ({ type: "oidc" } & OidcAuthConfig)
    | ({ type: "memory" } & MemoryAuthConfig);
```

| `type` | Provider built | Required fields (validated at runtime) | Required config type |
|--------|----------------|-----------------------------------------|----------------------|
| `'jwt'` | `JwtAuthProvider` | `secret` | `JwtAuthConfig` |
| `'introspection'` | `IntrospectionAuthProvider` | `introspectionUrl` + `clientId` + `clientSecret`, or a `configFactory` | `IntrospectionProviderConfig` |
| `'oidc'` | `OidcAuthProvider` | `issuerUrl` | `OidcAuthConfig` |
| `'memory'` | `MemoryAuthProvider` | none | `MemoryAuthConfig` |

### createAuthProvider

```typescript fragment
function createAuthProvider(config: AuthFactoryConfig): AuthProvider
```

Builds a concrete `AuthProvider` from a single configuration object. Shared base fields (`serviceName`, `tokenSources`, `cookieName`, `queryParamName`, `mapClaims`, `principalType`) and the selected arm's provider-specific fields (for example `secret`, `authMethod`, `validTokens`, `requireAudience`) are forwarded to the provider constructor. Misconfiguration fails at startup with a field-specific error rather than at the first request.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `AuthFactoryConfig` | Yes | — | Provider selection (`type`) plus provider-specific configuration |

Returns: the constructed provider (`AuthProvider`).

Validation errors:

| Throw condition | Exact error message |
|-----------------|---------------------|
| `type: 'jwt'` without `secret` | `createAuthProvider: type 'jwt' requires 'secret'` |
| `type: 'oidc'` without `issuerUrl` | `createAuthProvider: type 'oidc' requires 'issuerUrl'` |
| `type: 'introspection'` without a complete static triple and without `configFactory` | `createAuthProvider: type 'introspection' requires 'introspectionUrl', 'clientId' and 'clientSecret', or 'configFactory'` |

#### Example

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { createAuthPlugin, createAuthProvider } from 'blendsdk/webafx-auth';

const app = new WebApplication({
    PORT: 3400,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

app.use(createAuthPlugin(createAuthProvider({
    type: 'introspection',
    introspectionUrl: process.env.OIDC_INTROSPECT_URL ?? 'https://auth.example.com/introspect',
    clientId: process.env.OIDC_CLIENT_ID ?? 'my-client',
    clientSecret: process.env.OIDC_CLIENT_SECRET ?? 'my-secret',
})));

await app.start();
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
