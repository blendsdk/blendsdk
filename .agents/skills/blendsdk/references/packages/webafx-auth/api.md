> **Package**: `blendsdk/webafx-auth`

# webafx-auth API Reference

Complete reference for every public export of `blendsdk/webafx-auth`: the abstract `AuthProvider` base class, four concrete providers, five plugin factories, the `createAuthProvider()` factory, the abstract `OidcAuthController`, three OIDC flow error classes, and all exported types, interfaces, and constants.

---

## Export Index

### Classes

| Export | Kind | Description |
|--------|------|-------------|
| `AuthProvider` | abstract class | Base class owning the extract → validate → map lifecycle |
| `JwtAuthProvider` | class | Local JWT verification (HMAC / RSA / EC) via `jose` |
| `IntrospectionAuthProvider` | class | RFC 7662 opaque-token introspection with bounded LRU cache |
| `OidcAuthProvider` | class | OIDC discovery/JWKS token validation plus the BFF authorization-code flow |
| `MemoryAuthProvider` | class | In-memory token map for tests and local development |
| `OidcAuthController` | abstract class | WebAFX controller providing the five OIDC BFF routes |
| `OidcCodeExchangeError` | error class | Authorization-code exchange or ID-token verification failed |
| `OidcUserInfoForbiddenError` | error class | UserInfo endpoint refused the request with HTTP 403 |
| `OidcUserInfoSubjectMismatchError` | error class | UserInfo `sub` differs from the ID-token `sub` |

### Functions

| Export | Description |
|--------|-------------|
| `createAuthPlugin(provider, options?)` | Bridges any `AuthProvider` into the WebAFX service container |
| `jwtAuthPlugin(config, options?)` | Creates a `JwtAuthProvider` and plugin in one call |
| `introspectionAuthPlugin(config, options?)` | Creates an `IntrospectionAuthProvider` and plugin in one call |
| `oidcAuthPlugin(config, options?)` | Creates an `OidcAuthProvider` and plugin in one call |
| `memoryAuthPlugin(config, options?)` | Creates a `MemoryAuthProvider` and plugin in one call |
| `createAuthProvider(config)` | Factory that selects and validates a provider from `AuthFactoryConfig` |

### Constants

| Export | Value |
|--------|-------|
| `DEFAULT_SERVICE_NAME` | `"auth"` |
| `DEFAULT_PLUGIN_PRIORITY` | `10` |
| `DEFAULT_COOKIE_NAME` | `"auth_token"` |
| `DEFAULT_QUERY_PARAM_NAME` | `"token"` |
| `DEFAULT_TOKEN_SOURCES` | `["header"]` |

### Types & Interfaces

`AuthResult`, `PrincipalType`, `AuthTransportSecurity`, `AuthProviderConfig`, `JwtAuthConfig`, `IntrospectionAuthOptions`, `IntrospectionAuthConfig`, `IntrospectionAuthDynamicConfig`, `IntrospectionProviderConfig`, `TenantAuthConfig`, `MemoryAuthConfig`, `AuthFactoryConfig`, `TokenSource`, `TokenExtractor`, `ClaimsMapper`, `TenantResolver`, `TenantProviderFactory`, `AuthProviderLike`, `OidcAuthConfig`, `OidcCsrfConfig`, `OidcTokens`, `AuthorizationUrlResult`, `BuildAuthorizationUrlParams`, `ExchangeCodeParams`, `OidcSessionState`, `OidcSession`, `AuthPluginOptions`.

---

## AuthProvider (abstract)

Abstract base class for all authentication providers. Owns the shared lifecycle — extract a token from the request, validate it, return an `AuthResult` — and the configurable token extraction chain. Concrete providers implement only `validate()`, `health()`, and `shutdown()`.

**Design contract**

- One application-wide instance (not per request).
- Invalid, expired, or missing tokens resolve to `undefined` — never a thrown error (silent-failure pattern).
- Only infrastructure failures (network, DNS, store errors) are thrown.
- Claims shaping is pluggable via `mapClaims`; a `principalType` is stamped unless the mapped result already carries one.

```typescript fragment
export abstract class AuthProvider {
    protected _serviceName: string;
    protected _principalType: PrincipalType | undefined;
    protected tokenExtractors: Array<(req: Request) => string | undefined>;
    protected claimsMapper: ClaimsMapper;
    protected cookieName: string;
    protected queryParamName: string;

    constructor(config?: AuthProviderConfig);
}
```

### Constructor

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `AuthProviderConfig` | No | `{}` | Base configuration: token sources, cookie/query names, claims mapper, principal type |

Builds the ordered token extraction chain from `config.tokenSources` and selects the claims mapper (custom `mapClaims` or the internal default). Throws at construction when a `tokenSources` entry is not one of `"header"`, `"cookie"`, `"query"`, or `{ extractor: fn }`.

### Public Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `serviceName` | `get serviceName(): string` | `string` | Service name for WebAFX service container registration |
| `extractToken` | `extractToken(req: Request): string \| undefined` | `string \| undefined` | Walks the extraction chain in order; first non-empty match wins. `undefined` when no token is found (not an error) |
| `authenticate` | `authenticate(req: Request): Promise<AuthResult \| undefined>` | `Promise<AuthResult \| undefined>` | Full lifecycle: `extractToken()` → `validate()`. Main entry point called by the plugin middleware on every request |

### Abstract Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `validate` | `abstract validate(token: string): Promise<AuthResult \| undefined>` | `Promise<AuthResult \| undefined>` | The only method each concrete provider must implement. Returns `undefined` for invalid/expired tokens; throws only on infrastructure failures |
| `health` | `abstract health(): Promise<boolean>` | `Promise<boolean>` | Health check for the WebAFX health endpoint |
| `shutdown` | `abstract shutdown(): Promise<void>` | `Promise<void>` | Graceful shutdown — release connections, caches, keys, timers |

### Protected Members

| Member | Type | Description |
|--------|------|-------------|
| `_serviceName` | `string` | Configured service name |
| `_principalType` | `PrincipalType \| undefined` | Configured default principal type, stamped by `withPrincipalType()` and the default claims mapper |
| `tokenExtractors` | `Array<(req: Request) => string \| undefined>` | Ordered extractor chain built at construction |
| `claimsMapper` | `ClaimsMapper` | Effective claims mapping function |
| `cookieName` | `string` | Cookie name used by the `'cookie'` token source |
| `queryParamName` | `string` | Query parameter name used by the `'query'` token source |

### Protected Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `defaultClaimsMapper` | `protected defaultClaimsMapper(token: string, rawClaims: Record<string, unknown>): AuthResult` | `AuthResult` | Default mapper: subject from `sub` → `subject` → `"unknown"`; numeric `exp`; scopes from a space-separated `scope` string, a `scopes` array, or a `scope` array |
| `withPrincipalType` | `protected withPrincipalType(result: AuthResult \| undefined): AuthResult \| undefined` | `AuthResult \| undefined` | Fills the configured `principalType` when the result does not already set one; returns `undefined` unchanged |

### Example

```typescript
import { AuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

class StaticTokenAuthProvider extends AuthProvider {
    private readonly tokens: Map<string, AuthResult>;

    constructor(tokens: Record<string, AuthResult>) {
        super({ tokenSources: ['header'], cookieName: 'auth_token' });
        this.tokens = new Map(Object.entries(tokens));
    }

    async validate(token: string): Promise<AuthResult | undefined> {
        return this.tokens.get(token);
    }

    async health(): Promise<boolean> {
        return true;
    }

    async shutdown(): Promise<void> {
        this.tokens.clear();
    }
}

const provider = new StaticTokenAuthProvider({
    'demo-token': { sub: 'user-1', claims: {}, token: 'demo-token' },
});

console.log(provider.serviceName);            // "auth"
console.log(await provider.validate('demo-token')); // AuthResult
```

---

## JwtAuthProvider

Local JWT verification using the `jose` library. No network calls — verification is a pure cryptographic operation. Supports HMAC string secrets (HS256/HS384/HS512) and `CryptoKey` public keys (RS256, ES256, and other asymmetric algorithms), with issuer, audience, and clock-tolerance checks. The signing key is lazily converted to the format `jose` expects on first use and cached.

### Constructor

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `JwtAuthConfig` | Yes | — | JWT configuration; `secret` is required |

### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `validate` | `validate(token: string): Promise<AuthResult \| undefined>` | `Promise<AuthResult \| undefined>` | Verifies signature, `exp`, `nbf`, `iss` (when configured), and `aud` (when configured). Invalid, expired, or malformed tokens resolve to `undefined`. Fails closed when `requireAudience: true` and no `audience` is configured |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | `true` when a secret or key is configured (no network check) |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Releases the cached key material; the key is re-created on the next `validate()` call |

### Protected Members

| Member | Type | Description |
|--------|------|-------------|
| `config` | `JwtAuthConfig` | Provider configuration |
| `resolvedKey` | `CryptoKey \| Uint8Array \| null` | Cached key in jose-compatible format (lazy-initialized) |

### Protected Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `getOrCreateKey` | `protected getOrCreateKey(): CryptoKey \| Uint8Array` | `CryptoKey \| Uint8Array` | Encodes a string secret to `Uint8Array` (HMAC) or uses the `CryptoKey` as-is; result cached for the provider lifetime |

### Example

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const provider = new JwtAuthProvider({
    secret: process.env.JWT_SECRET ?? 'local-dev-secret-that-is-long-enough!!',
    algorithms: ['HS256'],
    issuer: 'https://auth.example.com',
    audience: 'my-api',
    clockTolerance: 5,
});

// An invalid token resolves to undefined — the silent-failure contract.
const result = await provider.validate('not-a-jwt');
console.log(result); // undefined

await provider.shutdown();
```

---

## IntrospectionAuthProvider

RFC 7662 OAuth2 token introspection for **opaque** access tokens. Sends the token to the authorization server's introspection endpoint and maps an `active: true` response to an `AuthResult`. Supports a static client configuration or a request-scoped `configFactory` for DB-backed, per-tenant credentials.

Active responses are cached in a small in-memory LRU. The cache key is a SHA-256 digest of the resolved endpoint + client scope + token, so the raw token is never stored, logged, or used as a key, and one tenant's result can never be served to another. The effective cache TTL is clamped to the token's own `exp`.

Invalid tokens return `undefined`. Only infrastructure failures — network errors, timeouts, non-2xx responses, an invalid response body, or a throwing `configFactory` — are raised as exceptions.

### Constructor

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `IntrospectionProviderConfig` | Yes | — | Static configuration (`introspectionUrl` + `clientId` + `clientSecret`) or a dynamic configuration with a `configFactory` |

**Throws** `Error` when neither a complete static triple nor a `configFactory` is supplied.

### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `validate` | `validate(token: string): Promise<AuthResult \| undefined>` | `Promise<AuthResult \| undefined>` | Introspects using the **static** configuration. Returns `undefined` in factory-only mode (no request context); use `authenticate(req)` instead |
| `authenticate` | `override authenticate(req: Request): Promise<AuthResult \| undefined>` | `Promise<AuthResult \| undefined>` | Extracts the token, resolves the effective config (calling `configFactory` once per request when configured), and introspects. Throws a clear error when a factory returns an incomplete config |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | `true` when a static config or a `configFactory` is present. Never performs a network call |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Clears the cached introspection responses |

### Protected Members

| Member | Type | Description |
|--------|------|-------------|
| `introspectionConfig` | `IntrospectionProviderConfig` | The original configuration, including any `configFactory` |
| `defaultConfig` | `IntrospectionAuthConfig \| undefined` | Static config when a complete triple was supplied; `undefined` in factory-only mode |
| `cache` | internal | Bounded LRU of active introspection responses (class intentionally not exported) |

### Example

```typescript
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';

const provider = new IntrospectionAuthProvider({
    introspectionUrl: 'https://auth.example.com/oauth2/introspect',
    clientId: 'my-api',
    clientSecret: process.env.INTROSPECTION_SECRET ?? 'local-secret',
    audience: 'https://api.example.com',
    cacheTTL: 60,
    maxCacheSize: 1000,
});

// Factory-only mode: credentials are resolved from the request per tenant.
const dynamicProvider = new IntrospectionAuthProvider({
    configFactory: async (req) => {
        const tenant = String(req.headers['x-tenant-id'] ?? 'default');
        return {
            introspectionUrl: `https://${tenant}.auth.example.com/oauth2/introspect`,
            clientId: `client-${tenant}`,
            clientSecret: process.env.INTROSPECTION_SECRET ?? 'local-secret',
        };
    },
});

console.log(await provider.health());        // true
console.log(await dynamicProvider.health()); // true
await provider.shutdown();
```

---

## OidcAuthProvider

OIDC-native provider built on `openid-client` v6 and `jose`. Two operational modes:

1. **Token validation** — validates JWT access tokens on every request through the inherited `authenticate()` pipeline, using JWKS resolved via OIDC discovery (cached per issuer with automatic key rotation support).
2. **BFF engine** — methods for the server-side authorization-code flow with PKCE used by `OidcAuthController` (`buildAuthorizationUrl`, `exchangeCode`, `refreshToken`, `revokeToken`, `fetchUserInfo`) plus server-side session and transient state CRUD.

When a `sessionStore` is configured, `authenticate()` falls back to a server-side session cookie after the Bearer path; session-cookie results always carry `principalType: 'user'` and `authorized` reflecting the stored session.

### Constructor

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `OidcAuthConfig` | Yes | — | OIDC configuration. At least one of `issuerUrl` or `configFactory` must be present |

**Throws** `Error` with message `"OidcAuthProvider requires either issuerUrl or configFactory"` when neither is provided.

### Token Validation and Lifecycle

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `validate` | `validate(token: string): Promise<AuthResult \| undefined>` | `Promise<AuthResult \| undefined>` | Validates against the **static** config using `jose.jwtVerify()` with discovery JWKS (issuer from discovery metadata; `clockTolerance` default 30). Returns `undefined` in factory-only mode and for any verification failure. Fails closed when `requireAudience: true` and no `audience` is configured |
| `authenticate` | `override authenticate(req: Request): Promise<AuthResult \| undefined>` | `Promise<AuthResult \| undefined>` | Dual-mode pipeline. Priority: (1) Bearer token via discovery + JWKS, with per-request `configFactory` and `resolveUser`/`mapClaims` resolution; (2) session-cookie lookup via `sessionStore` (`oidc:session:<id>`), enforcing the absolute deadline and the stored `expiresAt` against clock tolerance |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | `true` only when a static `issuerUrl` + `clientId` are configured **and** discovery succeeds; `false` for factory-only setups |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Clears all cached discovery configurations; the next call re-discovers |

### BFF Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `buildAuthorizationUrl` | `buildAuthorizationUrl(config?: OidcAuthConfig, params?: BuildAuthorizationUrlParams): Promise<AuthorizationUrlResult>` | `Promise<AuthorizationUrlResult>` | Builds the authorization URL with PKCE (S256), `state`, and `nonce`. Throws when `clientId`, `redirectUri`, or `issuerUrl` is missing |
| `exchangeCode` | `exchangeCode(params: ExchangeCodeParams, config?: OidcAuthConfig): Promise<OidcTokens>` | `Promise<OidcTokens>` | Exchanges the authorization code and validates the ID token's nonce when provided. Throws `OidcCodeExchangeError` for flow failures (invalid code, OAuth error body, failed ID-token verification, verified ID token without a string `sub`); throws plain `Error` for infrastructure failures (missing config, discovery, network, timeout, 5xx) |
| `refreshToken` | `refreshToken(refreshToken: string, config?: OidcAuthConfig): Promise<OidcTokens>` | `Promise<OidcTokens>` | Refreshes tokens via the `refresh_token` grant. Concurrent calls for the same tenant + token share a single in-flight grant (process-local) |
| `revokeToken` | `revokeToken(token: string, tokenTypeHint?: "access_token" \| "refresh_token", config?: OidcAuthConfig): Promise<void>` | `Promise<void>` | Revokes a token; passes `token_type_hint` only when provided |
| `fetchUserInfo` | `fetchUserInfo(accessToken: string, expectedSubject?: string, config?: OidcAuthConfig): Promise<Record<string, unknown>>` | `Promise<Record<string, unknown>>` | Fetches UserInfo claims. Throws `OidcUserInfoSubjectMismatchError` when the response `sub` differs from `expectedSubject` (OpenID Connect Core §5.3.2); throws `OidcUserInfoForbiddenError` on HTTP 403 |

### Configuration Accessors

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `getSessionCookieName` | `getSessionCookieName(req: Request): string` | `string` | `resolveSessionCookieName(req)` or the default `"__oidc_session"` |
| `getStateCookieName` | `getStateCookieName(req: Request): string` | `string` | `resolveStateCookieName(req)` or the default `"__oidc_state"` |
| `getRedirectUri` | `getRedirectUri(): string \| undefined` | `string \| undefined` | Configured callback redirect URI |
| `getSessionCookieTtl` | `getSessionCookieTtl(): number` | `number` | Cookie lifetime in seconds: `sessionCookieTtl` → `sessionTtl` → `3600`. Static configuration only |
| `resolveRequestConfig` | `resolveRequestConfig(req: Request): Promise<OidcAuthConfig \| undefined>` | `Promise<OidcAuthConfig \| undefined>` | Calls `configFactory(req)`, or returns `undefined` when no factory is configured. Factory errors propagate |
| `getCsrfConfig` | `getCsrfConfig(): OidcCsrfConfig \| undefined` | `OidcCsrfConfig \| undefined` | The controller CSRF block, or `undefined` when unset |
| `shouldRotateSessionIdOnRefresh` | `shouldRotateSessionIdOnRefresh(): boolean` | `boolean` | `true` only for `rotateSessionIdOnRefresh: true`. Static configuration only |
| `shouldVerifyUserInfoSubject` | `shouldVerifyUserInfoSubject(): boolean` | `boolean` | `true` unless `verifyUserInfoSubject: false`. Static configuration only |
| `getUserInfoDeniedMode` | `getUserInfoDeniedMode(): "error" \| "unauthorized-session"` | `"error" \| "unauthorized-session"` | Configured UserInfo denial policy; defaults to `"error"` |
| `getNotAuthorizedPath` | `getNotAuthorizedPath(): string` | `string` | Redirect target after an unauthorized session is created; defaults to `"/"` |

### Session CRUD

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `storeSession` | `storeSession(sessionId: string, session: OidcSession): Promise<void>` | `Promise<void>` | Stores under `oidc:session:<id>` with TTL `sessionTtl ?? 3600`. When `sessionAbsoluteTtl` is set, stamps `createdAt` on first store and preserves it thereafter |
| `getSession` | `getSession(sessionId: string): Promise<OidcSession \| undefined>` | `Promise<OidcSession \| undefined>` | Reads a session; deletes and reports `undefined` when the absolute deadline has passed |
| `clearSession` | `clearSession(sessionId: string): Promise<void>` | `Promise<void>` | Deletes the session entry |

All session operations throw `"OidcAuthProvider: sessionStore is required for BFF session operations"` when no `sessionStore` is configured.

### State CRUD (PKCE transient state)

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `storeState` | `storeState(stateId: string, state: OidcSessionState): Promise<void>` | `Promise<void>` | Stores under `oidc:state:<id>` with TTL `stateTtl ?? 300` |
| `getState` | `getState(stateId: string): Promise<OidcSessionState \| undefined>` | `Promise<OidcSessionState \| undefined>` | Reads the transient login state |
| `clearState` | `clearState(stateId: string): Promise<void>` | `Promise<void>` | Deletes the transient state entry |

### Protected Members

| Member | Type | Description |
|--------|------|-------------|
| `oidcConfig` | `OidcAuthConfig` | OIDC configuration stored separately from the base config |
| `discoveryCache` | `Map<string, CachedConfig>` | Discovery cache keyed by `issuerUrl`; each entry holds the openid-client `Configuration`, the jose JWKS resolver, the issuer string, and an expiry timestamp (`CachedConfig` is internal, not exported) |

### Example

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';
import type { ExchangeCodeParams } from 'blendsdk/webafx-auth';

const provider = new OidcAuthProvider({
    issuerUrl: 'https://login.example.com',
    clientId: 'my-web-app',
    clientSecret: process.env.OIDC_CLIENT_SECRET ?? 'local-secret',
    redirectUri: 'https://app.example.com/api/oidc/callback',
    audience: 'https://api.example.com',
});

// Step 1 — login: build the authorization URL and persist the PKCE material.
const authorization = await provider.buildAuthorizationUrl();
const loginState = {
    codeVerifier: authorization.codeVerifier,
    state: authorization.state,
    nonce: authorization.nonce,
};

// Step 2 — callback: exchange the authorization code for tokens.
const params: ExchangeCodeParams = {
    codeVerifier: loginState.codeVerifier,
    nonce: loginState.nonce,
    callbackUrl: 'https://app.example.com/api/oidc/callback?code=auth-code&state=state-value',
};
const tokens = await provider.exchangeCode(params);

// Step 3 — UserInfo, verifying its subject against the (verified) ID token.
const userInfo = await provider.fetchUserInfo(tokens.accessToken, tokens.subject);
console.log(userInfo.sub);
```

---

## MemoryAuthProvider

In-memory mock provider that validates tokens by map lookup — no network, no crypto. Designed for unit tests, integration tests, and local development. Supports runtime manipulation of the token map via `addToken()` / `removeToken()`.

### Constructor

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `MemoryAuthConfig` | No | `{}` | Optional configuration with pre-populated `validTokens`; starts empty when omitted |

### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `validate` | `validate(token: string): Promise<AuthResult \| undefined>` | `Promise<AuthResult \| undefined>` | Returns the stored `AuthResult` (with `principalType` filled when configured and unset) or `undefined` |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | Always `true` |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Clears all stored tokens; subsequent `validate()` calls return `undefined` |
| `addToken` | `addToken(token: string, result: AuthResult): void` | `void` | Registers (or overwrites) a valid token at runtime |
| `removeToken` | `removeToken(token: string): boolean` | `boolean` | Removes a token; `true` when it existed |
| `getTokenCount` | `getTokenCount(): number` | `number` | Number of currently registered tokens |

### Protected Members

| Member | Type | Description |
|--------|------|-------------|
| `tokens` | `Map<string, AuthResult>` | The token → result map backing `validate()` |

### Example

```typescript
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';

const provider = new MemoryAuthProvider({
    validTokens: {
        'admin-token': { sub: 'admin-1', claims: { role: 'admin' }, token: 'admin-token' },
    },
});

const admin = await provider.validate('admin-token');
console.log(admin?.sub); // "admin-1"

provider.addToken('temp-token', { sub: 'temp-1', claims: {}, token: 'temp-token' });
console.log(provider.getTokenCount()); // 2

provider.removeToken('temp-token');
console.log(provider.getTokenCount()); // 1
```

---

## OidcAuthController (abstract)

Abstract WebAFX controller (extends `BaseController` from `blendsdk/webafx`) that provides five pre-built HTTP routes for the OIDC authorization-code flow with PKCE. All session and state operations are delegated to the `OidcAuthProvider` resolved from the DI container (`req.services`). The class is abstract to prevent direct instantiation; no abstract methods must be implemented — subclasses override hooks only.

### Routes

| Method & Path | Guard | Behavior |
|---------------|-------|----------|
| `GET {prefix}/login` | public | Builds the authorization URL with PKCE, stores transient state via `provider.storeState()`, sets the state cookie (UUID, `maxAge` 300 s), redirects (302) |
| `GET {prefix}/callback` | public | Validates `error`/`code`/`state`, exchanges the code, verifies the UserInfo subject, stores the session, sets the session cookie (TTL from `provider.getSessionCookieTtl()`), clears state, redirects to the sanitized `returnTo` (default `/`) |
| `POST {prefix}/logout` | public, self-validating | CSRF check (when enabled), `onLogout` hook, best-effort token revocation, clears session + cookie, returns `{ message: "Logged out" }` |
| `GET {prefix}/me` | `this.authenticated()` | Returns `{ user, expiresAt, authorized, csrfToken? }`. Tokens are never exposed. Missing session → 401 `no_session` |
| `POST {prefix}/refresh` | public, self-validating | CSRF check, single-flight refresh (one grant/store/rotation per session), re-issues the session cookie, returns `{ expiresAt, message, csrfToken? }` |

The default prefix is `/api/oidc`, overridable via `getRoutePrefix()`. All five routes carry OpenAPI metadata under the `oidc` tag with unique operation ids.

### Public Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `routes` | `routes(): RouteDefinition[]` | `RouteDefinition[]` | Returns the five route definitions (see table above) |
| `handleLogin` | `handleLogin(req: Request, res: Response): Promise<void>` | `Promise<void>` | Login handler |
| `handleCallback` | `handleCallback(req: Request, res: Response): Promise<void>` | `Promise<void>` | Callback handler. Maps typed flow failures to fixed bodies: `400 oidc_error`, `400 missing_code`, `400 missing_state`, `400 invalid_state`, `400 oidc_exchange_failed`, `400 userinfo_subject_mismatch`, `403 userinfo_forbidden` (or an unauthorized-session redirect). Infrastructure failures propagate to the framework error handler |
| `handleLogout` | `handleLogout(req: Request, res: Response): Promise<void>` | `Promise<void>` | Logout handler; idempotent when no session exists |
| `handleMe` | `handleMe(req: Request, res: Response): Promise<void>` | `Promise<void>` | Session read handler; 401 `no_session` without a session |
| `handleRefresh` | `handleRefresh(req: Request, res: Response): Promise<void>` | `Promise<void>` | Refresh handler; 401 `no_session`, 400 `no_refresh_token`, 403 `csrf_invalid` |

### Protected Hooks and Helpers

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `getProviderServiceName` | `getProviderServiceName(): string` | `string` | DI service name for the provider; default `'auth'` (`DEFAULT_SERVICE_NAME`) |
| `getProvider` | `getProvider(req: Request): Promise<OidcAuthProvider>` | `Promise<OidcAuthProvider>` | Resolves the provider via `req.services.get(...)`. Throws when not registered |
| `getRoutePrefix` | `getRoutePrefix(): string` | `string` | Route prefix; default `"/api/oidc"` |
| `onCallback` | `onCallback(tokens: OidcTokens, userInfo: Record<string, unknown>, req: Request, res: Response): Promise<{ tokens: OidcTokens; userInfo: Record<string, unknown> }>` | `Promise<{ tokens: OidcTokens; userInfo: Record<string, unknown> }>` | Runs after code exchange, before the session is stored. Default passes through unchanged. Not called on the UserInfo-denied path |
| `onLogout` | `onLogout(req: Request, res: Response): Promise<void>` | `Promise<void>` | Runs before the session is cleared. Default is a no-op |
| `getLoginParams` | `getLoginParams(req: Request): BuildAuthorizationUrlParams` | `BuildAuthorizationUrlParams` | Extra authorization-URL parameters. Default forwards `prompt` and `login_hint` from the query string |
| `resolveOrganization` | `resolveOrganization(req: Request): string \| undefined` | `string \| undefined` | Organization/tenant slug for org-scoped cookies and sessions. Default `undefined` |
| `resolveConfig` | `resolveConfig(req: Request, provider: OidcAuthProvider): Promise<OidcAuthConfig \| undefined>` | `Promise<OidcAuthConfig \| undefined>` | Per-request config. Default delegates to `provider.resolveRequestConfig(req)` |
| `setCookie` | `protected setCookie(res: Response, name: string, value: string, options?: { maxAge?: number }): void` | `void` | Sets a cookie with secure defaults: `httpOnly`, `sameSite: 'lax'`, `path: '/'`, `secure` in production. `maxAge` is in seconds (converted to ms for Express) |
| `clearCookieByName` | `protected clearCookieByName(res: Response, name: string): void` | `void` | Clears a cookie with the same secure defaults |

### Example

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { Request } from 'express';
import { OidcAuthController } from 'blendsdk/webafx-auth';

class AppAuthController extends OidcAuthController {
    protected getRoutePrefix(): string {
        return '/auth';
    }

    protected resolveOrganization(req: Request): string | undefined {
        const slug = req.headers['x-org-slug'];
        return Array.isArray(slug) ? slug[0] : slug;
    }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production', LOG_LEVEL: 'INFO' });
app.registerController('', AppAuthController);

await app.start();
```

---

## Plugin Factories

### createAuthPlugin

Creates a WebAFX `PluginDefinition` that bridges any `AuthProvider` into the service container. On installation it registers:

1. The provider as a **singleton** service (default name `'auth'`).
2. A **per-request** service (default name `'user'`) whose factory calls `provider.authenticate(req)` and yields `AuthResult | undefined`. The secure guard resolves this name so secured routes work automatically.

The plugin delegates `health()` and `shutdown()` to the provider so WebAFX's health endpoint and graceful shutdown manage the provider lifecycle.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `provider` | `AuthProvider` | Yes | — | Any concrete provider instance |
| `options` | `AuthPluginOptions` | No | `{}` | Service names and priority overrides |

**Returns**: `PluginDefinition` (from `blendsdk/webafx`) — `name` is `auth:<serviceName>`, plus `priority` and an async `factory`.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { createAuthPlugin, MemoryAuthProvider } from 'blendsdk/webafx-auth';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'INFO' });

const provider = new MemoryAuthProvider({
    validTokens: {
        'test-token': { sub: 'user-1', claims: {}, token: 'test-token' },
    },
});

app.use(
    createAuthPlugin(provider, {
        serviceName: 'auth',
        userServiceName: 'user',
        priority: 10,
    })
);

await app.start();
```

---

### oidcAuthPlugin

Shorthand for `createAuthPlugin(new OidcAuthProvider(config), options)`.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `OidcAuthConfig` | Yes | — | OIDC provider configuration |
| `options` | `AuthPluginOptions` | No | `{}` | Plugin options |

**Returns**: `PluginDefinition`

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { oidcAuthPlugin } from 'blendsdk/webafx-auth';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production', LOG_LEVEL: 'INFO' });

app.use(
    oidcAuthPlugin({
        issuerUrl: 'https://login.example.com',
        clientId: 'my-web-app',
        clientSecret: process.env.OIDC_CLIENT_SECRET ?? 'local-secret',
        redirectUri: 'https://app.example.com/api/oidc/callback',
    })
);

await app.start();
```

---

### jwtAuthPlugin

Shorthand for `createAuthPlugin(new JwtAuthProvider(config), options)`.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `JwtAuthConfig` | Yes | — | JWT provider configuration |
| `options` | `AuthPluginOptions` | No | `{}` | Plugin options |

**Returns**: `PluginDefinition`

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { jwtAuthPlugin } from 'blendsdk/webafx-auth';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production', LOG_LEVEL: 'INFO' });

app.use(
    jwtAuthPlugin({
        secret: process.env.JWT_SECRET ?? 'local-dev-secret-that-is-long-enough!!',
        issuer: 'https://auth.example.com',
        audience: 'my-api',
    })
);

await app.start();
```

---

### introspectionAuthPlugin

Shorthand for `createAuthPlugin(new IntrospectionAuthProvider(config), options)`. Accepts either a static client configuration or a `configFactory` for DB-backed, per-tenant credentials.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `IntrospectionProviderConfig` | Yes | — | Static or dynamic introspection configuration |
| `options` | `AuthPluginOptions` | No | `{}` | Plugin options |

**Returns**: `PluginDefinition`

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { introspectionAuthPlugin } from 'blendsdk/webafx-auth';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production', LOG_LEVEL: 'INFO' });

app.use(
    introspectionAuthPlugin({
        configFactory: async (req) => {
            const tenant = String(req.headers['x-tenant-id'] ?? 'default');
            return {
                introspectionUrl: `https://${tenant}.auth.example.com/oauth2/introspect`,
                clientId: `client-${tenant}`,
                clientSecret: process.env.INTROSPECTION_SECRET ?? 'local-secret',
            };
        },
    })
);

await app.start();
```

---

### memoryAuthPlugin

Shorthand for `createAuthPlugin(new MemoryAuthProvider(config), options)`. Intended for tests and local development.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `MemoryAuthConfig` | Yes | — | Memory provider configuration (`validTokens` map) |
| `options` | `AuthPluginOptions` | No | `{}` | Plugin options |

**Returns**: `PluginDefinition`

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { memoryAuthPlugin } from 'blendsdk/webafx-auth';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });

app.use(
    memoryAuthPlugin({
        validTokens: {
            'test-token': { sub: 'user-1', claims: { role: 'user' }, token: 'test-token' },
        },
    })
);

await app.start();
```

---

## createAuthProvider

Environment-based provider factory. Selects and constructs a concrete `AuthProvider` from a single `AuthFactoryConfig`, validating the fields each provider requires and throwing a field-specific error at startup rather than failing at the first request. It is the counterpart to the plugin conveniences: the factory builds the provider, `createAuthPlugin()` registers it.

**Dispatch rules**

| `type` | Provider | Required fields |
|--------|----------|-----------------|
| `'jwt'` | `JwtAuthProvider` | `secret` |
| `'introspection'` | `IntrospectionAuthProvider` | Complete static triple (`introspectionUrl`, `clientId`, `clientSecret`) **or** `configFactory` |
| `'oidc'` | `OidcAuthProvider` | `issuerUrl` |
| `'memory'` | `MemoryAuthProvider` | none |

Base fields (`serviceName`, `tokenSources`, `cookieName`, `queryParamName`, `mapClaims`, `principalType`) are forwarded to every provider.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `AuthFactoryConfig` | Yes | — | Provider selection (`type`) and provider-specific configuration |

**Returns**: `AuthProvider`

**Throws**: `Error` with a field-specific message, for example:

- `"createAuthProvider: type 'jwt' requires 'secret'"`
- `"createAuthProvider: type 'introspection' requires 'introspectionUrl', 'clientId' and 'clientSecret', or 'configFactory'"`
- `"createAuthProvider: type 'oidc' requires 'issuerUrl'"`
- `"createAuthProvider: unsupported type '<value>'"`

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { createAuthProvider, createAuthPlugin } from 'blendsdk/webafx-auth';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production', LOG_LEVEL: 'INFO' });

app.use(
    createAuthPlugin(
        createAuthProvider({
            type: 'jwt',
            secret: process.env.JWT_SECRET ?? 'local-dev-secret-that-is-long-enough!!',
            issuer: 'https://auth.example.com',
            audience: 'my-api',
            requireAudience: true,
        })
    )
);

await app.start();
```

---

## Errors

### OidcCodeExchangeError

Thrown when the authorization-code exchange or the ID-token verification fails for a reason attributable to the sign-in flow: an invalid or expired code, an OAuth error response from the token endpoint, a failed signature / `nonce` / issuer / audience / expiry check, or a verified ID token without a usable subject. The controller maps it to a fixed `400` (`oidc_exchange_failed`).

| Member | Type | Description |
|--------|------|-------------|
| `name` | `string` | Always `"OidcCodeExchangeError"` |
| `message` | `string` | Fixed: `"Authorization code exchange failed"` — safe to serialize |
| `cause` | `unknown` | The original library error. For programmatic diagnosis only — never forward to a client and do not log verbatim |

```typescript fragment
constructor(cause?: unknown)
```

```typescript
import { OidcAuthProvider, OidcCodeExchangeError } from 'blendsdk/webafx-auth';
import type { ExchangeCodeParams } from 'blendsdk/webafx-auth';

async function completeSignIn(
    provider: OidcAuthProvider,
    params: ExchangeCodeParams
): Promise<void> {
    try {
        const tokens = await provider.exchangeCode(params);
        console.log(tokens.accessToken);
    } catch (error) {
        if (error instanceof OidcCodeExchangeError) {
            // A rejected sign-in — the fixed message is safe for the browser.
            console.warn(error.message);
            return;
        }
        throw error;
    }
}
```

---

### OidcUserInfoForbiddenError

Thrown when the UserInfo endpoint refuses the request with HTTP 403 — the identity provider authenticated the user, but the application denies access (e.g., `insufficient_scope`, a disabled account, or an application-level policy). Distinct from a failed sign-in: the callback can surface the verified identity. The controller maps the default policy to a fixed `403 userinfo_forbidden`.

| Member | Type | Description |
|--------|------|-------------|
| `name` | `string` | Always `"OidcUserInfoForbiddenError"` |
| `message` | `string` | Fixed: `"UserInfo endpoint denied the request"` — safe to serialize |
| `cause` | `unknown` | The original library error. Diagnostics only |

```typescript fragment
constructor(cause?: unknown)
```

```typescript
import { OidcAuthProvider, OidcUserInfoForbiddenError } from 'blendsdk/webafx-auth';

async function loadUserInfo(
    provider: OidcAuthProvider,
    accessToken: string,
    expectedSubject: string
): Promise<void> {
    try {
        const userInfo = await provider.fetchUserInfo(accessToken, expectedSubject);
        console.log(userInfo.sub);
    } catch (error) {
        if (error instanceof OidcUserInfoForbiddenError) {
            // The IdP authenticated the user, but access is denied.
            console.warn('Access to this account is not permitted');
            return;
        }
        throw error;
    }
}
```

---

### OidcUserInfoSubjectMismatchError

Thrown when the UserInfo endpoint returns a `sub` that differs from the expected (ID-token) subject. OpenID Connect Core 1.0 §5.3.2 requires the two to match exactly and states a mismatched response MUST NOT be used. `fetchUserInfo()` throws before any mismatched claims can reach a session.

| Member | Type | Description |
|--------|------|-------------|
| `name` | `string` | Always `"OidcUserInfoSubjectMismatchError"` |
| `message` | `string` | Fixed: `"UserInfo response subject does not match the ID token subject"` — carries no subject values, safe to log |

```typescript fragment
constructor()
```

```typescript
import { OidcAuthProvider, OidcUserInfoSubjectMismatchError } from 'blendsdk/webafx-auth';

async function verifyUserInfo(
    provider: OidcAuthProvider,
    accessToken: string,
    expectedSubject: string
): Promise<void> {
    try {
        const userInfo = await provider.fetchUserInfo(accessToken, expectedSubject);
        console.log(userInfo.sub);
    } catch (error) {
        if (error instanceof OidcUserInfoSubjectMismatchError) {
            // Reject the sign-in; never use the returned claims.
            console.warn(error.message);
            return;
        }
        throw error;
    }
}
```

---

## Types & Interfaces

### Core Types

#### AuthResult

Result of successful authentication — the validated identity extracted from a token. This is the value the plugin's per-request principal service yields.

| Property | Type | Description |
|----------|------|-------------|
| `sub` | `string` | Unique subject identifier (user ID) |
| `claims` | `Record<string, unknown>` | All claims/attributes from the token or introspection response |
| `token` | `string` | Original raw token string (useful for forwarding downstream) |
| `exp` | `number \| undefined` | Token expiration (seconds since epoch), when available |
| `scopes` | `string[] \| undefined` | Scopes/permissions granted by the token |
| `tenantId` | `string \| undefined` | Tenant identifier for multi-tenant deployments, when resolved |
| `principalType` | `PrincipalType \| undefined` | The kind of principal, when known. Descriptive only — does not grant or deny access |
| `authorized` | `boolean \| undefined` | `false` when authenticated but the application denied the UserInfo request; unset means authorized. Descriptive only — guards must enforce it explicitly |

#### PrincipalType

```typescript fragment
type PrincipalType = 'user' | 'client';
```

`'user'` — an end user (e.g., an interactive browser session). `'client'` — a machine or service principal (e.g., client credentials).

#### TokenExtractor

```typescript fragment
type TokenExtractor = (req: Request) => string | undefined;
```

Function that extracts a token string from an Express request; returns `undefined` when not found.

#### TokenSource

```typescript fragment
type TokenSource =
    | "header"
    | "cookie"
    | "query"
    | { extractor: TokenExtractor };
```

Where to look for tokens; tried in order, first match wins. `'header'` extracts from `Authorization: Bearer <token>`; `'cookie'` uses `cookieName`; `'query'` uses `queryParamName`; the object form is a custom extractor. An unknown value throws at provider construction.

#### ClaimsMapper

```typescript fragment
type ClaimsMapper = (
    token: string,
    rawClaims: Record<string, unknown>
) => AuthResult;
```

Transforms raw provider-specific claims into a standardized `AuthResult`. When not provided, the base class default mapper extracts `sub`, `exp`, and `scope`.

#### AuthProviderLike

Minimal provider shape used by the tenant-delegation contracts. Avoids a circular dependency on the full `AuthProvider` class — any object with these three methods qualifies.

| Method | Signature | Returns |
|--------|-----------|---------|
| `validate` | `validate(token: string): Promise<AuthResult \| undefined>` | `Promise<AuthResult \| undefined>` |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` |

---

### Configuration Types

#### AuthProviderConfig

Base configuration shared by all providers — token extraction and claims mapping.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `serviceName` | `string \| undefined` | `'auth'` | Service name for WebAFX service container registration. Use different names for multi-provider scenarios |
| `tokenSources` | `TokenSource[] \| undefined` | `['header']` | Token extraction sources, tried in order |
| `cookieName` | `string \| undefined` | `'auth_token'` | Cookie name for the `'cookie'` token source |
| `queryParamName` | `string \| undefined` | `'token'` | Query parameter name for the `'query'` token source |
| `mapClaims` | `ClaimsMapper \| undefined` | — | Optional claims mapping function |
| `principalType` | `PrincipalType \| undefined` | — | Default principal type stamped when the mapped result does not set one. Read from static config only — a `configFactory` value is ignored |
| `transport` | `AuthTransportSecurity \| undefined` | — | Transport-security controls for network-calling providers (currently consumed by the OIDC provider). Static config only |

#### AuthTransportSecurity

Opt-in transport-security controls. Every field is opt-in; leaving `transport` unset keeps the built-in behavior (HTTPS only, system trust store).

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `ca` | `string \| string[] \| undefined` | — | PEM CA certificate bundle(s) to trust. **Replaces** the default system roots; include public roots in this value when both are needed |
| `allowInsecureRequests` | `boolean \| undefined` | off | Development and test only. Permits non-HTTPS issuers and disables TLS certificate validation. Never enable against a production issuer |

#### JwtAuthConfig

Extends `AuthProviderConfig`.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `secret` | `string \| CryptoKey` | — (required) | `string` for HMAC (HS256/384/512); `CryptoKey` for RSA/EC public keys (RS256, ES256, …) |
| `algorithms` | `string[] \| undefined` | `['HS256']` for string secrets | Allowed JWT algorithms |
| `issuer` | `string \| undefined` | — | Expected `iss`; tokens with a different issuer are rejected |
| `audience` | `string \| string[] \| undefined` | — | Expected `aud`; when set, tokens without a match are rejected |
| `requireAudience` | `boolean \| undefined` | `false` | When `true` and no `audience` is configured, every token is rejected (fails closed) |
| `clockTolerance` | `number \| undefined` | `0` | Clock tolerance in seconds for `exp`/`nbf` checks |

#### IntrospectionAuthOptions

Options shared by the static and dynamic introspection configurations. Extends `AuthProviderConfig`.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `audience` | `string \| string[] \| undefined` | — | Expected audience (`aud` in the introspection response); rejected unless at least one configured value appears |
| `authMethod` | `"basic" \| "post" \| undefined` | `'basic'` | How client credentials are sent: HTTP Basic (`client_secret_basic`) or form fields (`client_secret_post`) |
| `cacheTTL` | `number \| undefined` | `60` | Response cache TTL in seconds; also clamped to the token's own `exp` |
| `maxCacheSize` | `number \| undefined` | `1000` | Maximum cached responses; LRU eviction beyond the bound |
| `timeout` | `number \| undefined` | `5000` | HTTP request timeout in milliseconds |
| `configFactory` | `(req: Request) => IntrospectionAuthConfig \| Promise<IntrospectionAuthConfig>` | — | Per-request credential resolution; takes precedence over static fields. Errors propagate as infrastructure failures |

#### IntrospectionAuthConfig

Extends `IntrospectionAuthOptions`.

| Property | Type | Description |
|----------|------|-------------|
| `introspectionUrl` | `string` | RFC 7662 introspection endpoint URL (required) |
| `clientId` | `string` | Client ID for endpoint authentication (required) |
| `clientSecret` | `string` | Client secret for endpoint authentication (required) |

#### IntrospectionAuthDynamicConfig

Extends `IntrospectionAuthOptions`.

| Property | Type | Description |
|----------|------|-------------|
| `introspectionUrl` | `string \| undefined` | Endpoint for the default/static case; optional when the factory always supplies it |
| `clientId` | `string \| undefined` | Client ID for the default/static case |
| `clientSecret` | `string \| undefined` | Client secret for the default/static case |
| `configFactory` | `(req: Request) => IntrospectionAuthConfig \| Promise<IntrospectionAuthConfig>` | Required. Called once per authenticated request; must return a complete `IntrospectionAuthConfig` |

#### IntrospectionProviderConfig

```typescript fragment
type IntrospectionProviderConfig =
    | IntrospectionAuthConfig
    | IntrospectionAuthDynamicConfig;
```

Union accepted by the `IntrospectionAuthProvider` constructor.

#### MemoryAuthConfig

Extends `AuthProviderConfig`.

| Property | Type | Description |
|----------|------|-------------|
| `validTokens` | `Record<string, AuthResult> \| undefined` | Map of token strings to their corresponding auth results |

#### AuthFactoryConfig

Extends `AuthProviderConfig`. Configuration for `createAuthProvider()`; provider-specific fields are only used when the matching `type` is selected.

| Property | Type | Applies to | Description |
|----------|------|------------|-------------|
| `type` | `"jwt" \| "introspection" \| "oidc" \| "memory"` | all | Required backend selector |
| `secret` | `string \| CryptoKey \| undefined` | `jwt` | Signing secret or public key |
| `algorithms` | `string[] \| undefined` | `jwt` | Allowed JWT algorithms |
| `issuer` | `string \| undefined` | `jwt` | Expected `iss` claim |
| `issuerUrl` | `string \| undefined` | `oidc` | OIDC issuer URL for discovery |
| `clientId` | `string \| undefined` | `introspection`, `oidc` | Client ID |
| `clientSecret` | `string \| undefined` | `introspection`, `oidc` | Client secret |
| `transport` | `AuthTransportSecurity \| undefined` | `oidc` | Forwarded unchanged to the provider |
| `verifyIdTokenSignature` | `boolean \| undefined` | `oidc` | Forwarded unchanged to the provider |
| `sessionAbsoluteTtl` | `number \| undefined` | `oidc` | Forwarded unchanged to the provider |
| `audience` | `string \| string[] \| undefined` | `jwt`, `oidc` | Expected audience |
| `requireAudience` | `boolean \| undefined` | `jwt`, `oidc` | Fail closed when `true` and no audience configured |
| `introspectionUrl` | `string \| undefined` | `introspection` | Introspection endpoint URL |
| `cacheTTL` | `number \| undefined` | `introspection` | Introspection cache TTL (seconds) |
| `authMethod` | `"basic" \| "post" \| undefined` | `introspection` | Client authentication method |
| `maxCacheSize` | `number \| undefined` | `introspection` | Introspection cache capacity |
| `configFactory` | `(req: Request) => IntrospectionAuthConfig \| Promise<IntrospectionAuthConfig>` | `introspection` | DB-backed per-tenant credentials; takes precedence over static fields |
| `clockTolerance` | `number \| undefined` | `jwt`, `oidc` | Clock tolerance in seconds |
| `timeout` | `number \| undefined` | `introspection` | HTTP timeout in milliseconds |
| `validTokens` | `Record<string, AuthResult> \| undefined` | `memory` | Pre-configured valid tokens |

---

### OIDC Types

#### OidcAuthConfig

Extends `AuthProviderConfig`. Configuration for `OidcAuthProvider`. At least one of `issuerUrl` or `configFactory` must be provided; when both are set, `issuerUrl` serves `validate()` and the factory serves per-request `authenticate()`.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `issuerUrl` | `string \| undefined` | — | OIDC issuer URL; optional if `configFactory` is provided |
| `clientId` | `string \| undefined` | — | OAuth2 client ID; optional if `configFactory` is provided |
| `clientSecret` | `string \| undefined` | — | Client secret for confidential clients |
| `redirectUri` | `string \| undefined` | — | Redirect URI for the authorization-code flow |
| `audience` | `string \| string[] \| undefined` | — | Expected audience |
| `requireAudience` | `boolean \| undefined` | `false` | Fail closed: reject tokens unless `audience` is configured and matches |
| `clockTolerance` | `number \| undefined` | `30` | Clock tolerance (seconds) for JWT validation and the session-cookie expiry skew check. Static config only for the session path |
| `scopes` | `string[] \| undefined` | `['openid', 'profile', 'email']` | OIDC scopes to request |
| `discoveryTtl` | `number \| undefined` | `3600` | Discovery cache TTL in seconds |
| `verifyIdTokenSignature` | `boolean \| undefined` | `true` | Verify the ID-token signature from the code exchange against the issuer JWKS. Static config only; shared by all tenants |
| `verifyUserInfoSubject` | `boolean \| undefined` | `true` | Verify the UserInfo `sub` equals the ID-token `sub` (OIDC Core §5.3.2). Static config only |
| `userInfoDenied` | `"error" \| "unauthorized-session" \| undefined` | `'error'` | `'error'`: fixed `403` with no session. `'unauthorized-session'`: store a session with `authorized: false` built from the verified ID token, then redirect to `notAuthorizedPath`. Falls back to the fixed `403` when no verified identity is available. Static config only |
| `notAuthorizedPath` | `string \| undefined` | `'/'` | Redirect target after an unauthorized session is created. Static config only |
| `resolveUser` | `(req: Request, claims: Record<string, unknown>) => Promise<AuthResult>` | — | Async user resolver; takes precedence over `mapClaims` on the Bearer path. Rejections propagate as infrastructure errors |
| `configFactory` | `(req: Request) => Promise<OidcAuthConfig>` | — | Dynamic per-request (multi-tenant) configuration; must return at least `issuerUrl` and `clientId` |
| `sessionStore` | `CacheProvider \| undefined` | — | `blendsdk/webafx-cache` provider for server-side sessions; enables the session-cookie fallback |
| `resolveSessionCookieName` | `(req: Request) => string` | — | Per-request session cookie name (e.g. org-scoped) |
| `resolveStateCookieName` | `(req: Request) => string` | — | Per-request state cookie name |
| `sessionTtl` | `number \| undefined` | `3600` | Server-side session TTL in seconds (sliding) |
| `sessionAbsoluteTtl` | `number \| undefined` | — | Hard maximum session lifetime (seconds) measured from `createdAt`; refresh never extends it. Static config only |
| `sessionCookieTtl` | `number \| undefined` | falls back to `sessionTtl`, then `3600` | Browser session cookie lifetime (seconds), independent of the access token lifetime. Static config only |
| `rotateSessionIdOnRefresh` | `boolean \| undefined` | `false` | Rotate the opaque session id on every successful refresh; the old id stops resolving. Static config only. Process-local under concurrency |
| `stateTtl` | `number \| undefined` | `300` | PKCE transient state TTL in seconds |
| `csrf` | `OidcCsrfConfig \| undefined` | — | Opt-in CSRF enforcement for the OIDC BFF controller |

#### OidcCsrfConfig

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `enabled` | `boolean \| undefined` | `false` | Enforce CSRF on `POST /logout` and `POST /refresh`; `GET /me` then returns the session token |
| `header` | `string \| undefined` | `'x-csrf-token'` | Header carrying the token |

Static configuration: a per-request `configFactory` cannot vary it. Enabling CSRF signs out sessions created before enforcement.

#### OidcTokens

Clean extraction of OIDC token response fields — no `openid-client` types leak through this boundary.

| Property | Type | Description |
|----------|------|-------------|
| `accessToken` | `string` | The access token |
| `tokenType` | `string` | Token type (usually `"Bearer"`) |
| `expiresIn` | `number \| undefined` | Expiration in seconds from issuance |
| `refreshToken` | `string \| undefined` | Refresh token, when granted |
| `idToken` | `string \| undefined` | ID token JWT, when granted |
| `scope` | `string \| undefined` | Granted scopes (space-separated) |
| `subject` | `string \| undefined` | Subject from the verified ID token of the code exchange. Unset on refresh responses and when `verifyIdTokenSignature` is disabled — absence always means "no trusted identity" |
| `idTokenClaims` | `Record<string, unknown> \| undefined` | Claims from the verified ID token. Present only when the signature was verified and a string `sub` exists |

#### AuthorizationUrlResult

| Property | Type | Description |
|----------|------|-------------|
| `url` | `string` | Full authorization URL to redirect the user to |
| `codeVerifier` | `string` | PKCE code verifier — store server-side and pass to `exchangeCode()` |
| `state` | `string` | State parameter — store and verify on callback |
| `nonce` | `string` | Nonce for ID-token validation |

#### BuildAuthorizationUrlParams

| Property | Type | Description |
|----------|------|-------------|
| `clientId` | `string \| undefined` | Overrides the config's `clientId` |
| `redirectUri` | `string \| undefined` | Overrides the config's `redirectUri` |
| `scopes` | `string[] \| undefined` | Overrides the config's `scopes` |
| `extraParams` | `Record<string, string> \| undefined` | Additional OIDC parameters (`prompt`, `login_hint`, `acr_values`, …) |

#### ExchangeCodeParams

| Property | Type | Description |
|----------|------|-------------|
| `codeVerifier` | `string` | PKCE code verifier from `buildAuthorizationUrl()` (required) |
| `nonce` | `string \| undefined` | Nonce to validate against the ID token |
| `callbackUrl` | `string` | Full callback URL including query parameters (`code`, `state`, …) (required) |

#### OidcSessionState

Transient state stored between the login redirect and the callback.

| Property | Type | Description |
|----------|------|-------------|
| `codeVerifier` | `string` | PKCE code verifier |
| `state` | `string` | State parameter validated on callback (CSRF protection) |
| `nonce` | `string` | Nonce validated against ID-token claims |
| `returnTo` | `string \| undefined` | Post-login redirect target — always a relative, same-origin path; absent when the login request carried no safe `returnTo` |

#### OidcSession

User session stored after successful OIDC authentication (server-side via `CacheProvider`).

| Property | Type | Description |
|----------|------|-------------|
| `accessToken` | `string` | Access token for API calls and refresh |
| `refreshToken` | `string \| undefined` | Refresh token for obtaining new tokens |
| `idToken` | `string \| undefined` | ID token (e.g., `id_token_hint` on logout) |
| `expiresAt` | `number \| undefined` | Token expiration (seconds since epoch) |
| `createdAt` | `number \| undefined` | Unix seconds of first creation. Stamped by `storeSession()` when `sessionAbsoluteTtl` is configured; preserved across refresh and rotation |
| `user` | `Record<string, unknown>` | User claims/profile data from UserInfo or the ID token |
| `organizationSlug` | `string \| undefined` | Organization/tenant slug for multi-tenant sessions |
| `csrfToken` | `string \| undefined` | Per-session CSRF token; stored server-side and returned by `GET /me`; never placed in a script-readable cookie |
| `authorized` | `boolean \| undefined` | `false` only under the opt-in `userInfoDenied: 'unauthorized-session'` policy. Unset and `true` both mean authorized |

---

### Tenant Delegation Contracts

> This package exports the tenant contracts but does **not** ship a tenant provider. Nothing here enforces the stated caching behavior — an implementation built on `AuthProvider` decides how to honor it.

#### TenantResolver

```typescript fragment
type TenantResolver = (req: Request) => string | undefined;
```

Resolves a tenant identifier from a request; `undefined` when not determinable.

#### TenantProviderFactory

```typescript fragment
type TenantProviderFactory = (tenantId: string) => Promise<AuthProviderLike>;
```

Creates an `AuthProvider` for a specific tenant. An implementation is expected to call it once per tenant and cache the result.

#### TenantAuthConfig

Extends `AuthProviderConfig`.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `resolveTenant` | `TenantResolver` | — (required) | Resolves the tenant ID per request |
| `createProvider` | `TenantProviderFactory` | — (required) | Creates a per-tenant provider |
| `maxTenants` | `number \| undefined` | `100` | Expected cache bound; beyond it, the least-recently-used provider is expected to be shut down and evicted |

---

### Plugin & Factory Support Types

#### AuthPluginOptions

Options for `createAuthPlugin()` and the convenience factories. All fields optional.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `serviceName` | `string \| undefined` | `'auth'` | Provider service name in the DI container; controllers retrieve it via `req.services.get(serviceName)` |
| `userServiceName` | `string \| undefined` | `'user'` | Principal service name the secure guard resolves. An unnamed secure route always resolves the default `'user'`; to authenticate against this name, name it on the route — e.g. `secure('client')` on a route and `userServiceName: 'client'` here |
| `priority` | `number \| undefined` | `10` | Plugin installation priority; lower installs first. Auth plugins should install before feature plugins |

---

## Constants

| Constant | Type | Value | Description |
|----------|------|-------|-------------|
| `DEFAULT_SERVICE_NAME` | `string` | `"auth"` | Default provider service name for DI registration |
| `DEFAULT_PLUGIN_PRIORITY` | `number` | `10` | Default plugin priority — installs early, before feature plugins |
| `DEFAULT_COOKIE_NAME` | `string` | `"auth_token"` | Default cookie name for the `'cookie'` token source |
| `DEFAULT_QUERY_PARAM_NAME` | `string` | `"token"` | Default query parameter name for the `'query'` token source |
| `DEFAULT_TOKEN_SOURCES` | `TokenSource[]` | `["header"]` | Default extraction chain — `Authorization: Bearer` only |

```typescript
import {
    DEFAULT_SERVICE_NAME,
    DEFAULT_PLUGIN_PRIORITY,
    DEFAULT_COOKIE_NAME,
    DEFAULT_QUERY_PARAM_NAME,
    DEFAULT_TOKEN_SOURCES,
} from 'blendsdk/webafx-auth';

console.log(DEFAULT_SERVICE_NAME);     // "auth"
console.log(DEFAULT_PLUGIN_PRIORITY);  // 10
console.log(DEFAULT_COOKIE_NAME);      // "auth_token"
console.log(DEFAULT_QUERY_PARAM_NAME); // "token"
console.log(DEFAULT_TOKEN_SOURCES);    // ["header"]
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
