> **Package**: `blendsdk/webafx-auth`

# webafx-auth Core Concepts

`blendsdk/webafx-auth` is built around a small set of cooperating abstractions: one abstract provider lifecycle, a configurable token extraction chain, a standardized result type, four concrete providers, a plugin layer that wires a provider into the WebAFX service container, a configuration factory, and — for OIDC — a Backend-for-Frontend (BFF) controller with a server-side session model. This document examines each concept: what it is, how it works, a complete example, and its key API surface.

At a glance:

- **`AuthProvider`** — the abstract lifecycle (extract → validate) every backend inherits.
- **Token extraction chain** — header, cookie, query, or custom extractors, tried in order.
- **`AuthResult` and claims mapping** — the standardized identity contract and the pluggable mapper.
- **`JwtAuthProvider`** — local JWT verification for self-issued tokens.
- **`IntrospectionAuthProvider`** — RFC 7662 opaque-token validation with a bounded cache.
- **`OidcAuthProvider`** — discovery-based JWT validation plus a complete BFF engine.
- **`MemoryAuthProvider`** — deterministic authentication for tests and local development.
- **Plugin layer** — `createAuthPlugin()` and convenience factories that register a provider with WebAFX.
- **Provider factory** — `createAuthProvider()` selects a backend from a single config object.
- **`OidcAuthController`** — the five browser-facing BFF routes.
- **Sessions, PKCE state, and CSRF** — the server-side state model of the OIDC flow.
- **OIDC error types** — stable, typed discriminators for flow failures.
- **Multi-tenancy** — per-request configuration, tenant isolation, and the exported contracts.
- **Transport security** — custom CA trust and the development-only insecure switch.

For installation and a first working setup, start with Basic Usage.

---

## `AuthProvider` — The Abstract Base Class

### What It Is

`AuthProvider` is the abstract base class that every authentication backend in the package derives from. It defines one uniform lifecycle — extract a token from the request, validate it, and return a standardized `AuthResult` (or `undefined`) — so application code, the plugin layer, and the secure route guard are identical no matter which backend performs the actual verification. A provider instance is designed as an **application-wide singleton**: it is created once at startup and shared by every request, with all mutable state (caches, key material, in-flight maps) living on that single instance.

### How It Works

The base class fixes everything except the actual verification logic:

1. **Construction** stores the base configuration — `serviceName` (default `'auth'`), `principalType`, `cookieName` (default `'auth_token'`), `queryParamName` (default `'token'`) — selects the claims mapper (custom `mapClaims` or the default mapper), and builds the ordered token extraction chain from `tokenSources` (default `['header']`).
2. **`authenticate(req)`** is the template method: it calls `extractToken(req)`; if no token is found it returns `undefined` (an unauthenticated request is normal, not an error); otherwise it delegates to `validate(token)`.
3. **`validate(token)` is the only method concrete providers must implement** for authentication. `health()` and `shutdown()` are also abstract and must be implemented so the plugin can delegate WebAFX's health endpoint and graceful shutdown.
4. **Silent-failure contract** — an invalid, expired, or malformed token resolves to `undefined`; only infrastructure failures (network errors, DNS failures, cache/store errors, a rejecting `configFactory` where documented) are thrown so the framework maps them to a 500.
5. **Principal stamping** — a protected helper, `withPrincipalType()`, fills the configured `principalType` on a mapped result when it does not already carry one, keeping a custom mapper authoritative.

### Complete Example

A custom provider that extends the base class and reuses the extraction chain, principal stamping, and lifecycle contracts:

```typescript
import type { Request } from 'express';
import { AuthProvider } from 'blendsdk/webafx-auth';
import type { AuthProviderConfig, AuthResult } from 'blendsdk/webafx-auth';

interface ApiKeyConfig extends AuthProviderConfig {
    /** Map of API key → the identity it represents. */
    keys: Record<string, AuthResult>;
}

class ApiKeyAuthProvider extends AuthProvider {
    private readonly keys: Map<string, AuthResult>;

    constructor(config: ApiKeyConfig) {
        super(config);
        this.keys = new Map(Object.entries(config.keys));
    }

    async validate(token: string): Promise<AuthResult | undefined> {
        // Silent failure: unknown keys resolve to undefined, never throw.
        return this.withPrincipalType(this.keys.get(token));
    }

    async health(): Promise<boolean> {
        return this.keys.size > 0;
    }

    async shutdown(): Promise<void> {
        this.keys.clear();
    }
}

const provider = new ApiKeyAuthProvider({
    serviceName: 'api-key-auth',
    principalType: 'client',
    // The default chain expects "Authorization: Bearer ...";
    // read the raw API-key header instead.
    tokenSources: [
        {
            extractor: (req) => {
                const raw = req.headers['x-api-key'];
                return typeof raw === 'string' ? raw : undefined;
            },
        },
    ],
    keys: {
        'key-abc': { sub: 'service-1', claims: { plan: 'pro' }, token: 'key-abc' },
    },
});

export async function authenticate(req: Request): Promise<AuthResult | undefined> {
    return provider.authenticate(req);
}
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `serviceName` | `readonly string` (getter) | DI registration name of the provider; default `'auth'` |
| `extractToken(req)` | `(req: Request) => string \| undefined` | Walks the token extraction chain; public for diagnostics, tenant delegation, and tests |
| `authenticate(req)` | `(req: Request) => Promise<AuthResult \| undefined>` | The full lifecycle: extract → validate; main entry point used by the plugin middleware |
| `validate(token)` | `(token: string) => Promise<AuthResult \| undefined>` | **Abstract** — the only verification method each concrete provider implements |
| `health()` | `() => Promise<boolean>` | **Abstract** — is the backend configured and reachable? |
| `shutdown()` | `() => Promise<void>` | **Abstract** — release resources (caches, keys, connections) |
| `defaultClaimsMapper(token, rawClaims)` | `protected (token: string, rawClaims: Record<string, unknown>) => AuthResult` | Default `sub` / `exp` / `scope` normalization applied when no custom mapper is configured |
| `withPrincipalType(result)` | `protected (result: AuthResult \| undefined) => AuthResult \| undefined` | Fills the configured `principalType` when the result has none; `undefined` passes through |

---

## Token Extraction and Token Sources

### What It Is

The token extraction chain is the part of the lifecycle that decides **where** to look for the raw credential. It is configured once via `tokenSources` and shared by every provider, because extraction is a request-shape concern, not a backend concern. The chain makes fallback strategies configuration rather than code: a browser client can authenticate from a cookie while machine clients authenticate from a header, using the same provider.

### How It Works

At construction, each configured source is compiled into an extractor function; `extractToken()` walks the resulting array **in order and the first non-empty match wins**. Four source kinds are supported:

- `'header'` — reads `Authorization: Bearer <token>`. The `Bearer ` prefix is matched case-sensitively; a missing header or a different scheme yields `undefined`.
- `'cookie'` — reads `req.cookies[cookieName]`, where `cookieName` defaults to `'auth_token'`. This relies on cookie parsing middleware (built into WebAFX core middleware); without it, `req.cookies` is undefined and extraction silently yields `undefined`.
- `'query'` — reads `req.query[queryParamName]`, where `queryParamName` defaults to `'token'`. Only string values are accepted, so a repeated parameter parsed as an array is rejected. Useful for webhook callbacks, email-verification links, and SSE endpoints where headers cannot be set.
- `{ extractor: (req) => string | undefined }` — any custom function, for API-key headers, signed URLs, or proprietary schemes.

Two behavioral guarantees matter operationally: **finding no token is not an error** (public routes are normal), and an **unknown source value throws at construction time**, so a typo in `tokenSources` fails at startup rather than at the first request. `extractToken()` is a public method, which is what lets tenant-delegating providers and tests reuse the same chain.

### Complete Example

A provider configured with the full fallback chain plus a custom extractor:

```typescript
import type { Request } from 'express';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult, TokenSource } from 'blendsdk/webafx-auth';

/** Callers that cannot set headers (SSE, webhooks) pass a dedicated header token. */
const eventTokenSource: TokenSource = {
    extractor: (req) => {
        const raw = req.headers['x-event-token'];
        return typeof raw === 'string' ? raw : undefined;
    },
};

const provider = new JwtAuthProvider({
    secret: process.env.JWT_SECRET ?? '',
    // Tried in order — the first non-empty result wins:
    // 1. Authorization: Bearer <token>
    // 2. session_token cookie
    // 3. access_token query parameter
    // 4. x-event-token header
    tokenSources: ['header', 'cookie', 'query', eventTokenSource],
    cookieName: 'session_token',
    queryParamName: 'access_token',
});

export async function extractAndAuthenticate(req: Request): Promise<AuthResult | undefined> {
    // extractToken() is public — handy for diagnostics and wrapper providers.
    const rawToken = provider.extractToken(req);
    if (!rawToken) {
        return undefined;
    }
    return provider.authenticate(req);
}
```

### Key Methods and Properties

| Source / Constant | Where it looks | Notes |
| --- | --- | --- |
| `'header'` | `req.headers.authorization` | Requires the exact `Bearer ` prefix; the default source |
| `'cookie'` | `req.cookies[cookieName]` | `cookieName` default `'auth_token'`; requires cookie parsing middleware |
| `'query'` | `req.query[queryParamName]` | `queryParamName` default `'token'`; string values only |
| `{ extractor }` | custom `(req: Request) => string \| undefined` | Any function; first non-empty chain result wins |
| `DEFAULT_TOKEN_SOURCES` | `TokenSource[]` | `['header']` |
| `DEFAULT_COOKIE_NAME` | `string` | `'auth_token'` |
| `DEFAULT_QUERY_PARAM_NAME` | `string` | `'token'` |
| `extractToken(req)` | `(req: Request) => string \| undefined` | Public; walks the chain and returns the first match |

---

## `AuthResult`, Claims Mapping, and Principal Types

### What It Is

`AuthResult` is the standardized identity object every provider produces and every consumer — the secure guard, controllers, custom middleware — reads. It decouples application code from backend-specific claim formats: whether the identity came from a locally verified JWT, an introspection response, or a server-side OIDC session, consumers always see the same shape. **Claims mapping** is the pluggable transform that produces it.

### How It Works

The default mapper, inherited by all providers, normalizes the most common JWT/OAuth2 claim formats:

- **Subject** — `sub`, falling back to `subject`, falling back to `'unknown'`.
- **Expiration** — `exp`, copied only when it is a number (seconds since epoch).
- **Scopes** — `scope` as a space-separated string (RFC 6749), `scopes` as an array, or `scope` as an array; empty strings are filtered out.

A custom `mapClaims(token, rawClaims)` function **completely replaces** the default behavior and receives the original token string plus the raw claims, so it can read proprietary claim names (`user_id`, `permissions`, nested objects). Providers apply principal stamping **after** mapping: the configured `principalType` is written only when the mapped result does not already set one — a custom mapper that classifies a principal stays authoritative. The same rule applies to stored results in `MemoryAuthProvider`.

Two fields deserve special attention because they are **descriptive, not enforcing**:

- `principalType` (`'user' | 'client'`) states what kind of principal the token represents. Enforcement happens at the route level (`secure('client')` selects a named principal service), never because of this field.
- `authorized` is only ever set to `false` by the OIDC session-cookie path (see the sessions concept); `undefined` means authorized. Guards must check it explicitly if the application denies access by policy.

### Complete Example

A custom mapper that reads a proprietary claim shape and a configured principal type:

```typescript
import type { Request } from 'express';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult, ClaimsMapper } from 'blendsdk/webafx-auth';

const mapper: ClaimsMapper = (token, rawClaims): AuthResult => ({
    sub: String(rawClaims.user_id ?? rawClaims.sub ?? 'unknown'),
    claims: rawClaims,
    token,
    exp: typeof rawClaims.exp === 'number' ? rawClaims.exp : undefined,
    scopes:
        typeof rawClaims.scope === 'string'
            ? rawClaims.scope.split(' ').filter(Boolean)
            : undefined,
});

const provider = new JwtAuthProvider({
    secret: process.env.JWT_SECRET ?? '',
    mapClaims: mapper,
    // Stamped on the result because the mapper above does not set it.
    principalType: 'user',
});

export async function authenticate(req: Request): Promise<AuthResult | undefined> {
    return provider.authenticate(req);
}
```

The default mapping is equivalent to the following transformation:

```typescript fragment
// Verified JWT payload:
//   { sub: "user-42", exp: 1735689600, scope: "read write" }
//
// Default mapper output:
{
    sub: "user-42",
    claims: { sub: "user-42", exp: 1735689600, scope: "read write" },
    token: "<original token string>",
    exp: 1735689600,
    scopes: ["read", "write"],
}
```

### Key Methods and Properties

`AuthResult` fields:

| Field | Type | Description |
| --- | --- | --- |
| `sub` | `string` | Subject identifier (user or service ID); `'unknown'` when the mapper finds no subject |
| `claims` | `Record<string, unknown>` | All raw claims from the token or introspection response |
| `token` | `string` | The original raw token string (useful for forwarding downstream) |
| `exp` | `number \| undefined` | Expiration in seconds since epoch, when available |
| `scopes` | `string[] \| undefined` | Parsed permissions from `scope` / `scopes` |
| `tenantId` | `string \| undefined` | Tenant identifier when the provider resolves one |
| `principalType` | `PrincipalType \| undefined` | `'user'` or `'client'`; descriptive only |
| `authorized` | `boolean \| undefined` | `false` only from the OIDC session path; `undefined` means authorized |

Claims mapping configuration:

| Name | Type / Signature | Description |
| --- | --- | --- |
| `mapClaims` | `(token: string, rawClaims: Record<string, unknown>) => AuthResult` | Replaces the default mapper entirely |
| `ClaimsMapper` | type alias for the signature above | The exported contract for custom mappers |
| `principalType` | `'user' \| 'client'` | Stamped by `withPrincipalType()` when the mapper does not set it |
| `PrincipalType` | `'user' \| 'client'` | The exported union type for the field |

---

## `JwtAuthProvider` — Local JWT Verification

### What It Is

`JwtAuthProvider` validates **self-issued** JWTs entirely in-process. It verifies the signature with `jose.jwtVerify()` — HMAC for symmetric secrets, RSA/EC for asymmetric keys — and checks the standard claims. Because verification is a pure cryptographic operation, there are no network calls, no discovery, and no external state: this is the fastest and most self-contained provider in the package.

### How It Works

- **Key handling** — a `string` secret (HMAC, `HS256`/`HS384`/`HS512`) is encoded to bytes on first use via `TextEncoder` and cached on the provider; a `CryptoKey` (RSA/EC, `RS256`/`ES256`, …) is used as-is. `shutdown()` releases the cached key, and it is re-created lazily on the next `validate()`.
- **Claim validation** — the `algorithms` option defaults to `['HS256']`; `clockTolerance` defaults to `0` seconds of skew for `exp`/`nbf`; `issuer` and `audience` are checked only when configured.
- **Fail-closed audience** — with `requireAudience: true` but no `audience` configured, **every** token is rejected before any verification work happens. This prevents a token minted for a different API by the same issuer from being accepted unchecked.
- **Silent failure** — a bad signature, expired token, wrong issuer, wrong audience, or malformed string yields `undefined`. No error ever escapes `validate()` for a token problem.
- **Lifecycle** — `health()` reports whether key material is configured; `shutdown()` clears the cached key (and is safe to call repeatedly).

### Complete Example

```typescript
import type { Request } from 'express';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const provider = new JwtAuthProvider({
    secret: process.env.JWT_SECRET ?? '',
    algorithms: ['HS256'],
    issuer: 'https://api.example.com',
    audience: 'my-client-id',
    requireAudience: true,
    clockTolerance: 5,
});

export async function authenticate(req: Request): Promise<AuthResult | undefined> {
    // Invalid, expired, wrong-issuer, or wrong-audience tokens → undefined.
    // Verification is pure crypto in this process — no network calls.
    return provider.authenticate(req);
}

export async function shutdownProvider(): Promise<void> {
    await provider.shutdown();
}
```

Asymmetric verification accepts a public key directly:

```typescript fragment
declare const publicKey: CryptoKey;

const provider = new JwtAuthProvider({
    secret: publicKey,          // CryptoKey — used as-is for RS256/ES256
    algorithms: ['RS256'],
    issuer: 'https://auth.example.com',
});
```

### Key Methods and Properties

Configuration options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `secret` | `string \| CryptoKey` | — (required) | HMAC secret or asymmetric public key |
| `algorithms` | `string[]` | `['HS256']` | Allowed JWT algorithms |
| `issuer` | `string` | — | Expected `iss`; checked when set |
| `audience` | `string \| string[]` | — | Expected `aud`; checked when set |
| `requireAudience` | `boolean` | `false` | Fail closed when true and no audience configured |
| `clockTolerance` | `number` | `0` | Seconds of allowed clock skew for `exp` / `nbf` |

Methods:

| Name | Signature | Description |
| --- | --- | --- |
| `validate(token)` | `(token: string) => Promise<AuthResult \| undefined>` | Verifies signature, expiration, issuer, and audience; silent `undefined` on failure |
| `health()` | `() => Promise<boolean>` | True when a secret or key is configured |
| `shutdown()` | `() => Promise<void>` | Releases the cached key material |

---

## `IntrospectionAuthProvider` — RFC 7662 Token Introspection

### What It Is

`IntrospectionAuthProvider` validates **opaque** access tokens — tokens that carry no verifiable signature and therefore cannot be checked locally — by asking the authorization server whether the token is active, per RFC 7662. Because introspection is a network call, the provider adds a bounded, token-safe response cache and supports two configuration modes: a static client triple, or a per-request `configFactory` for credentials that live in a database and differ per tenant.

### How It Works

**Configuration resolution.** The constructor requires either a complete static triple (`introspectionUrl` + `clientId` + `clientSecret`) or a `configFactory`; otherwise it throws at startup. When a factory is configured, `authenticate(req)` calls it once per request and uses the returned config; `validate(token)` has no request context, so it works with the static config only and returns `undefined` in factory-only mode. A factory that resolves an incomplete config causes a clear thrown error rather than a malformed request.

**The introspection call.** A `POST` with `application/x-www-form-urlencoded` body carrying `token` and `token_type_hint=access_token`. Client credentials go either into an HTTP `Basic` header — RFC 6749 §2.3.1 percent-encoded and base64-encoded — or into the body as `client_id`/`client_secret` when `authMethod: 'post'` is configured. Requests time out via `AbortController` (`timeout`, default 5000 ms) and redirects are refused outright.

**Response handling.** A non-2xx response throws an error carrying only the HTTP status — never the token or the credentials. The JSON body must be an object. `active !== true` yields `undefined`; a configured `audience` must appear in the response `aud` (missing audience is rejected); a past `exp` yields `undefined`.

**Caching.** Active, usable responses are cached in a small LRU. The cache key is a **SHA-256 digest** of endpoint + client scope + token, so the raw token is never stored, logged, or used as a key — and one tenant's entry can never be served to another. The effective TTL is the smaller of `cacheTTL` (default 60 s) and the time left before the token's `exp`. The audience and expiration checks are re-applied on every cache hit, so a shared entry cannot bypass a stricter configuration. Inactive responses and failed requests are never cached.

**Error contract.** Invalid, inactive, or expired tokens → `undefined` (silent). Infrastructure failures — network errors, timeouts, non-2xx responses, a throwing `configFactory` — propagate as exceptions.

### Complete Example

```typescript
import type { Request } from 'express';
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const provider = new IntrospectionAuthProvider({
    introspectionUrl: 'https://auth.example.com/oauth2/introspect',
    clientId: process.env.CLIENT_ID ?? '',
    clientSecret: process.env.CLIENT_SECRET ?? '',
    audience: 'https://api.example.com',
    authMethod: 'basic',
    cacheTTL: 60,
    maxCacheSize: 1000,
    timeout: 5000,
});

export async function authenticate(req: Request): Promise<AuthResult | undefined> {
    // Active token → AuthResult; inactive/expired → undefined;
    // network error, timeout, or non-2xx → thrown Error.
    return provider.authenticate(req);
}
```

Database-backed, per-tenant credentials use the dynamic configuration:

```typescript fragment
const provider = new IntrospectionAuthProvider({
    configFactory: async (req) => {
        const tenant = String(req.headers['x-tenant'] ?? 'default');
        const credentials = await credentialsRepo.findByTenant(tenant);
        return {
            introspectionUrl: credentials.introspectUrl,
            clientId: credentials.clientId,
            clientSecret: credentials.clientSecret,
        };
    },
});
```

### Key Methods and Properties

Configuration options (`IntrospectionAuthOptions` plus the static or dynamic fields):

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `introspectionUrl` | `string` | — | Endpoint URL; required unless a `configFactory` always supplies it |
| `clientId` / `clientSecret` | `string` | — | Client credentials; required together with `introspectionUrl` |
| `configFactory` | `(req: Request) => IntrospectionAuthConfig \| Promise<IntrospectionAuthConfig>` | — | Per-request credentials; takes precedence over static fields |
| `audience` | `string \| string[]` | — | Reject unless one configured value appears in the response `aud` |
| `authMethod` | `'basic' \| 'post'` | `'basic'` | How credentials are sent to the endpoint |
| `cacheTTL` | `number` | `60` | Seconds; effective TTL is `min(cacheTTL, exp − now)` |
| `maxCacheSize` | `number` | `1000` | LRU capacity before least-recently-used eviction |
| `timeout` | `number` | `5000` | HTTP timeout in milliseconds |

Methods:

| Name | Signature | Description |
| --- | --- | --- |
| `validate(token)` | `(token: string) => Promise<AuthResult \| undefined>` | Introspects with the static config; `undefined` in factory-only mode |
| `authenticate(req)` | `(req: Request) => Promise<AuthResult \| undefined>` | Resolves per-request config (if any), introspects, maps |
| `health()` | `() => Promise<boolean>` | True when static config or a factory is present; no network call |
| `shutdown()` | `() => Promise<void>` | Clears the cached introspection responses |

---

## `OidcAuthProvider` — Discovery-Based Validation and the BFF Engine

### What It Is

`OidcAuthProvider` is the package's most capable provider. It operates in two modes at once:

1. **Resource-server mode** — validates JWT access tokens against the issuer's JWKS, discovered via OpenID Connect discovery (`openid-client` for discovery, `jose` for verification), with automatic key rotation.
2. **BFF engine mode** — exposes the server-side methods of an authorization-code flow with PKCE: build an authorization URL, exchange the code (with nonce and ID-token verification), refresh and revoke tokens, and fetch UserInfo. These methods are what `OidcAuthController` drives.

It also implements a **dual-mode `authenticate()`**: a Bearer token takes priority, and a server-side session cookie is checked as a fallback when a `sessionStore` is configured.

### How It Works

**Construction guard.** Either `issuerUrl` (static, single-tenant) or a `configFactory` (dynamic, multi-tenant) must be provided; the constructor throws otherwise. When both are present, `issuerUrl` serves `validate()` (no request context) while the factory serves per-request `authenticate()`.

**Discovery.** The first validation or BFF call performs OIDC discovery and caches — per issuer URL — the openid-client `Configuration`, a `jose` remote JWKS resolver, and the discovered issuer. Entries expire after `discoveryTtl` (default 3600 s). ID-token non-repudiation checks are enabled on the configuration by default (`verifyIdTokenSignature !== false`).

**`validate(token)`** uses static configuration only (the factory needs a request): it fails closed when `requireAudience` is set without an audience, verifies the JWT against the cached JWKS with the discovered issuer, `clockTolerance` (default 30 s) and the configured audience, and maps the claims. Any failure returns `undefined`.

**`authenticate(req)` — Bearer path.** If a token is present, the effective config is resolved (factory or static); a required-but-missing audience fails closed; the JWT is verified; then identity resolution follows a strict priority: async `resolveUser(req, claims)` → `mapClaims` → the inherited default mapper. A **rejecting `resolveUser` propagates as an infrastructure error**, while factory, discovery, JWT, and synchronous mapper failures stay silent (`undefined`), matching `JwtAuthProvider`.

**`authenticate(req)` — session path.** When no Bearer token is present and a `sessionStore` is configured, the provider reads the session cookie (name via `resolveSessionCookieName` or `__oidc_session`), loads `oidc:session:<id>` from the `CacheProvider`, enforces the absolute deadline (deleting a dead entry so it cannot be revived) and the `expiresAt` + clock-skew check, and returns an `AuthResult` with `principalType: 'user'` and `authorized` reflecting the session. Store errors propagate (a broken store is infrastructure, not a failed sign-in).

**BFF engine.** `buildAuthorizationUrl()` produces a PKCE `S256` authorization URL plus the `codeVerifier`, `state`, and `nonce` that must be stored server-side. `exchangeCode()` validates the nonce, verifies the ID-token signature (unless explicitly disabled), and surfaces `subject` plus `idTokenClaims` from the **verified** token; flow-level failures become typed `OidcCodeExchangeError`s while infrastructure failures re-throw. `refreshToken()` coalesces concurrent grants for the same tenant + token into a single request, so a rotating IdP consumes the refresh token exactly once (the map is process-local). `fetchUserInfo()` enforces OpenID Connect Core §5.3.2: when an expected subject is supplied, a mismatch throws `OidcUserInfoSubjectMismatchError` and the response must not be used; a 403 becomes `OidcUserInfoForbiddenError`.

**Lifecycle.** `health()` succeeds only with static config and a reachable issuer; factory-only setups report `false`. `shutdown()` clears the discovery cache.

### Complete Example

```typescript
import type { Request } from 'express';
import { OidcAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult, AuthorizationUrlResult } from 'blendsdk/webafx-auth';

const provider = new OidcAuthProvider({
    issuerUrl: 'https://auth.example.com',
    clientId: 'my-app',
    clientSecret: process.env.OIDC_CLIENT_SECRET ?? '',
    redirectUri: 'https://app.example.com/api/oidc/callback',
    audience: 'https://api.example.com',
    scopes: ['openid', 'profile', 'email'],
    clockTolerance: 30,
    discoveryTtl: 3600,
});

// Resource-server path: validate a Bearer access token on any request.
export async function authenticate(req: Request): Promise<AuthResult | undefined> {
    return provider.authenticate(req);
}

// BFF path: start a browser sign-in. Persist the returned codeVerifier, state,
// and nonce server-side, then pass codeVerifier + nonce back to
// provider.exchangeCode() inside the callback handler.
export async function startSignIn(): Promise<AuthorizationUrlResult> {
    return provider.buildAuthorizationUrl();
}

export async function shutdownProvider(): Promise<void> {
    await provider.shutdown();
}
```

### Key Methods and Properties

Configuration options (core validation and BFF; session options are covered in the sessions concept):

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `issuerUrl` | `string` | — | OIDC issuer; required unless a `configFactory` is provided |
| `clientId` / `clientSecret` | `string` | — | OAuth2 client credentials |
| `redirectUri` | `string` | — | Callback URI used when building the authorization URL |
| `audience` | `string \| string[]` | — | Expected `aud`; checked when set |
| `requireAudience` | `boolean` | `false` | Fail closed when true and no audience configured |
| `clockTolerance` | `number` | `30` | Skew allowed for JWT validation and the session expiry check |
| `scopes` | `string[]` | `['openid', 'profile', 'email']` | Scopes requested at authorization |
| `discoveryTtl` | `number` | `3600` | Discovery cache TTL in seconds |
| `verifyIdTokenSignature` | `boolean` | `true` | Verify the code-exchange ID token against the issuer JWKS |
| `verifyUserInfoSubject` | `boolean` | `true` | Enforce the §5.3.2 UserInfo-vs-ID-token subject equality |
| `userInfoDenied` | `'error' \| 'unauthorized-session'` | `'error'` | How the callback treats a UserInfo 403 |
| `notAuthorizedPath` | `string` | `'/'` | Redirect target for unauthorized sessions |
| `resolveUser` | `(req: Request, claims: Record<string, unknown>) => Promise<AuthResult>` | — | Async resolver that takes precedence over `mapClaims` on the Bearer path |
| `configFactory` | `(req: Request) => Promise<OidcAuthConfig>` | — | Per-request configuration (multi-tenant) |

Methods:

| Name | Signature | Description |
| --- | --- | --- |
| `validate(token)` | `(token: string) => Promise<AuthResult \| undefined>` | JWKS verification with static config; `undefined` in factory-only mode |
| `authenticate(req)` | `(req: Request) => Promise<AuthResult \| undefined>` | Bearer first (factory config, `resolveUser` > `mapClaims` > default), then session-cookie fallback |
| `health()` | `() => Promise<boolean>` | Static config present and discovery reachable |
| `shutdown()` | `() => Promise<void>` | Clears the discovery cache |
| `buildAuthorizationUrl(config?, params?)` | `(...) => Promise<AuthorizationUrlResult>` | PKCE `S256` URL plus `codeVerifier` / `state` / `nonce` to store |
| `exchangeCode(params, config?)` | `(...) => Promise<OidcTokens>` | Code grant with nonce and ID-token verification; typed errors for flow failures |
| `refreshToken(refreshToken, config?)` | `(...) => Promise<OidcTokens>` | Single-flight refresh grant (coalesced per tenant + token) |
| `revokeToken(token, tokenTypeHint?, config?)` | `(...) => Promise<void>` | RFC 7009 revocation |
| `fetchUserInfo(accessToken, expectedSubject?, config?)` | `(...) => Promise<Record<string, unknown>>` | UserInfo with subject equality and typed 403 handling |
| `resolveRequestConfig(req)` | `(req: Request) => Promise<OidcAuthConfig \| undefined>` | Invokes the configured `configFactory`; `undefined` when none |
| `getRedirectUri()` | `() => string \| undefined` | The configured redirect URI |
| `getSessionCookieTtl()` | `() => number` | `sessionCookieTtl` ?? `sessionTtl` ?? `3600` |

---

## `MemoryAuthProvider` — The Test Double

### What It Is

`MemoryAuthProvider` authenticates tokens by a simple map lookup: if the token string exists as a key, the pre-built `AuthResult` is returned. There is no crypto, no network, and no hidden state — which makes it the right tool for unit tests, integration tests, and local development where a real identity provider is unnecessary or unavailable. It pairs with `memoryAuthPlugin()` for full WebAFX app testing.

### How It Works

The constructor converts `validTokens` (a plain `Record<string, AuthResult>`) into a `Map` for O(1) lookups. `validate()` returns the stored result, passed through the base class's principal stamping so a configured `principalType` is filled when the stored result does not carry one. Unlike production providers, the map is mutable at runtime: `addToken()` registers new tokens mid-test, `removeToken()` simulates revocation, and `getTokenCount()` supports assertions. `health()` always returns `true`; `shutdown()` clears the map, after which every `validate()` returns `undefined`.

### Complete Example

```typescript
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const provider = new MemoryAuthProvider({
    validTokens: {
        'admin-token': {
            sub: 'admin-1',
            claims: { role: 'admin' },
            token: 'admin-token',
        },
        'user-token': {
            sub: 'user-1',
            claims: { role: 'user' },
            token: 'user-token',
        },
    },
});

// Inside a test scenario:
const admin: AuthResult | undefined = await provider.validate('admin-token');
console.log(admin?.sub); // 'admin-1'

// Simulate token revocation.
provider.removeToken('admin-token');
console.log(await provider.validate('admin-token')); // undefined

// Register a scenario-specific token.
provider.addToken('temporary-token', {
    sub: 'temp-1',
    claims: {},
    token: 'temporary-token',
});
console.log(provider.getTokenCount()); // 2

// Teardown: release the token map.
await provider.shutdown();
console.log(provider.getTokenCount()); // 0
```

### Key Methods and Properties

| Name | Signature | Description |
| --- | --- | --- |
| `validate(token)` | `(token: string) => Promise<AuthResult \| undefined>` | Map lookup; stored result, stamped with the configured `principalType` when unset |
| `authenticate(req)` | `(req: Request) => Promise<AuthResult \| undefined>` | Inherited lifecycle: extraction chain + `validate()` |
| `addToken(token, result)` | `(token: string, result: AuthResult) => void` | Registers (or overwrites) a valid token at runtime |
| `removeToken(token)` | `(token: string) => boolean` | Removes a token; returns whether it existed |
| `getTokenCount()` | `() => number` | Number of registered tokens, for assertions |
| `health()` | `() => Promise<boolean>` | Always `true` |
| `shutdown()` | `() => Promise<void>` | Clears the token map |

---

## The Plugin Layer — `createAuthPlugin()` and Convenience Factories

### What It Is

The plugin layer is the bridge between a provider instance and the WebAFX framework. `createAuthPlugin(provider, options?)` returns a `PluginDefinition` that, when installed with `app.use()`, registers the provider with the WebAFX service container and connects it to the secure route guard. `jwtAuthPlugin()`, `introspectionAuthPlugin()`, `oidcAuthPlugin()`, and `memoryAuthPlugin()` are one-step conveniences that construct the provider and the plugin together.

### How It Works

Installing the plugin registers exactly two services:

1. **The provider as a singleton** — named by `serviceName` (default `'auth'`), so any controller can retrieve it with `req.services.get<AuthProvider>('auth', undefined)`.
2. **A per-request principal factory** — named by `userServiceName` (default `'user'`), whose factory calls `provider.authenticate(req)` on every request. The secure guard resolves this name: a defined result grants access, `undefined` produces a 401.

How routes select their principal: an unnamed secure route always resolves the default `'user'` service. To authenticate against a differently named service, name it on the route — for example `secure('client')` — and register the matching plugin with `userServiceName: 'client'`. Because the plugin name is `auth:<serviceName>`, two plugins that use the same service name collide at startup (`Plugin "auth:auth" is already registered`) instead of silently replacing each other. The plugin installs early by default (`priority` 10) and returns a plugin object whose `health()` and `shutdown()` delegate to the provider, so WebAFX's health endpoint and graceful shutdown lifecycle manage the provider automatically.

### Complete Example

A complete WebAFX application with a JWT-backed principal and a controller that reads it:

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { jwtAuthPlugin } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

class ProfileController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated().get('/profile').handle(async (req, res) => {
                const user = await req.services.get<AuthResult>('user', undefined);
                this.ok(res, { sub: user?.sub });
            }),
        ];
    }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'INFO' });

app.use(jwtAuthPlugin({ secret: process.env.JWT_SECRET ?? '' }));
app.registerController('', ProfileController);

await app.start();
```

Two providers in one application — distinct service names, distinct principal names, routes select with `secure()`:

```typescript fragment
app.use(createAuthPlugin(userProvider, { serviceName: 'user-auth', userServiceName: 'user' }));
app.use(createAuthPlugin(clientProvider, { serviceName: 'client-auth', userServiceName: 'client' }));

// A route that must be called by a machine principal:
this.route().get('/reports').secure('client').handle(...);
```

### Key Methods and Properties

`AuthPluginOptions`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `serviceName` | `string` | `'auth'` | Name of the singleton provider service; also names the plugin `auth:<serviceName>` |
| `userServiceName` | `string` | `'user'` | Per-request principal service resolved by the secure guard |
| `priority` | `number` | `10` | Installation order; lower installs first |

Factories:

| Name | Signature | Description |
| --- | --- | --- |
| `createAuthPlugin(provider, options?)` | `(provider: AuthProvider, options?: AuthPluginOptions) => PluginDefinition` | Registers any provider plus its per-request principal |
| `jwtAuthPlugin(config, options?)` | `(config: JwtAuthConfig, options?: AuthPluginOptions) => PluginDefinition` | `createAuthPlugin(new JwtAuthProvider(config), options)` |
| `introspectionAuthPlugin(config, options?)` | `(config: IntrospectionProviderConfig, options?: AuthPluginOptions) => PluginDefinition` | Static or factory-based introspection |
| `oidcAuthPlugin(config, options?)` | `(config: OidcAuthConfig, options?: AuthPluginOptions) => PluginDefinition` | OIDC validation + BFF engine |
| `memoryAuthPlugin(config, options?)` | `(config: MemoryAuthConfig, options?: AuthPluginOptions) => PluginDefinition` | Testing plugin over a token map |
| `AuthPluginOptions` | exported interface | The options type above |

---

## `createAuthProvider()` — Configuration-Driven Provider Selection

### What It Is

`createAuthProvider()` is the environment-based factory: it takes a single `AuthFactoryConfig` object, dispatches on its `type` field (`'jwt' | 'introspection' | 'oidc' | 'memory'`), validates the fields that type requires, and returns a fully constructed `AuthProvider`. It is the counterpart to the plugin layer — the factory builds the provider, and `createAuthPlugin()` registers it — which makes both steps expressible in one composed call.

### How It Works

The factory extracts the base configuration shared by every provider (`serviceName`, `tokenSources`, `cookieName`, `queryParamName`, `mapClaims`, `principalType`) and forwards it to the selected constructor, along with the type-specific fields. Required fields are validated per type, and a missing one throws a **field-specific message at startup** rather than failing at the first request:

- `createAuthProvider: type 'jwt' requires 'secret'`
- `createAuthProvider: type 'oidc' requires 'issuerUrl'`
- `createAuthProvider: type 'introspection' requires 'introspectionUrl', 'clientId' and 'clientSecret', or 'configFactory'`
- `createAuthProvider: unsupported type '<value>'`

The introspection type accepts either a complete static triple **or** a `configFactory` for database-backed, per-tenant credentials. The memory type has no required fields. OIDC-only forwarders such as `transport`, `verifyIdTokenSignature`, and `sessionAbsoluteTtl` are passed through unchanged; other types ignore them.

### Complete Example

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { createAuthPlugin, createAuthProvider } from 'blendsdk/webafx-auth';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production', LOG_LEVEL: 'INFO' });

const provider = createAuthProvider({
    type: 'jwt',
    secret: process.env.JWT_SECRET ?? '',
    issuer: 'https://api.example.com',
    audience: 'my-client-id',
    requireAudience: true,
    serviceName: 'auth',
});

// Misconfiguration fails fast here, at startup:
// createAuthProvider({ type: 'jwt' }) throws "createAuthProvider: type 'jwt' requires 'secret'".
app.use(createAuthPlugin(provider));

await app.start();
```

### Key Methods and Properties

`AuthFactoryConfig` fields, grouped by applicability:

| Field | Used by | Description |
| --- | --- | --- |
| `type` | all | `'jwt' \| 'introspection' \| 'oidc' \| 'memory'` — selects the provider |
| `secret`, `algorithms` | `jwt` | HMAC/`CryptoKey` material and allowed algorithms |
| `issuerUrl` | `oidc` | Required for OIDC |
| `introspectionUrl`, `clientId`, `clientSecret` | `introspection` | The static client triple |
| `configFactory` | `introspection` | DB-backed credentials; takes precedence over static fields |
| `audience`, `issuer`, `requireAudience`, `clockTolerance` | `jwt`, `oidc` | Shared claim-validation options |
| `authMethod`, `cacheTTL`, `maxCacheSize`, `timeout` | `introspection` | Introspection tuning |
| `transport`, `verifyIdTokenSignature`, `sessionAbsoluteTtl` | `oidc` | OIDC-only forwarders, passed through unchanged |
| `validTokens` | `memory` | Pre-built token → result map |
| `serviceName`, `tokenSources`, `cookieName`, `queryParamName`, `mapClaims`, `principalType` | all (base) | The shared `AuthProviderConfig` slice |

| Function | Signature | Description |
| --- | --- | --- |
| `createAuthProvider` | `(config: AuthFactoryConfig) => AuthProvider` | Builds and validates the selected provider; throws a field-specific `Error` on misconfiguration |

---

## `OidcAuthController` — The BFF HTTP Surface

### What It Is

`OidcAuthController` is an abstract `BaseController` subclass that ships the five browser-facing HTTP routes of the OIDC authorization-code flow with PKCE: `login`, `callback`, `logout`, `me`, and `refresh`. It contains no protocol logic itself — every session, state, and token operation is delegated to the `OidcAuthProvider` resolved from the dependency-injection container — so a subclass customizes behavior purely through overridable hooks. The class is abstract to prevent direct instantiation; there are **no abstract methods to implement**, only hooks to optionally override.

### How It Works

**Provider resolution.** Each handler resolves the provider through `getProviderServiceName()` (default `'auth'`) and `req.services.get(...)`, so the controller must be registered after an auth plugin has installed the provider.

**Route guards.** `login` and `callback` are public. `me` sits behind the secure guard (`this.authenticated()`). `logout` and `refresh` are deliberately public and self-validating: they read and validate the opaque session cookie in the handler, so a session that is past its access-token expiry can still refresh or log out — the secure guard would 401 those requests before the handler ran.

**Login.** Builds the authorization URL with PKCE `S256` via the provider, stores the transient state (code verifier, state, nonce, sanitized `returnTo`) under a UUID, sets an httpOnly state cookie with a 5-minute lifetime, and issues a `302` to the provider.

**Callback.** Handles provider-declared errors with a fixed envelope (untrusted error text is never reflected), validates the state cookie and the returned `state` parameter, exchanges the code (a typed `OidcCodeExchangeError` becomes a fixed `400` and clears the spent state), verifies the UserInfo subject against the ID token, runs the `onCallback` hook, stores the session under a new UUID with `stripNullValues`, and sets the session cookie with a lifetime from `provider.getSessionCookieTtl()` — not the access-token expiry — before redirecting to the sanitized `returnTo` (default `'/'`). A UserInfo denial produces either a fixed `403` or an *unauthorized session* (`authorized: false`, identity from the verified ID token only), depending on `userInfoDenied`.

**Logout / Me / Refresh.** Logout runs the `onLogout` hook, attempts best-effort token revocation, clears the session and the cookie, and always returns success. `me` returns `user`, `expiresAt`, `authorized` — and `csrfToken` when CSRF enforcement is enabled — but never tokens. Refresh validates its preconditions, then runs a **single-flight** execution keyed by session id, so concurrent refreshes perform one grant, one store, and (with rotation) one session-id move; the cookie is re-issued only after a successful store.

**Security details.** Cookies default to `httpOnly`, `sameSite: 'lax'`, `path: '/'`, and `secure` in production. The `returnTo` value is sanitized on both login and callback: only relative, same-origin paths survive — absolute URLs, protocol-relative URLs, backslashes, control characters, whitespace, and non-string query values all collapse to `'/'`.

### Complete Example

A subclass overriding hooks, installed alongside the OIDC plugin:

```typescript
import type { WebApplication } from 'blendsdk/webafx';
import type { CacheProvider } from 'blendsdk/webafx-cache';
import type { Request } from 'express';
import { OidcAuthController, oidcAuthPlugin } from 'blendsdk/webafx-auth';
import type { BuildAuthorizationUrlParams } from 'blendsdk/webafx-auth';

class AuthController extends OidcAuthController {
    protected getRoutePrefix(): string {
        return '/api/oidc';
    }

    protected getLoginParams(req: Request): BuildAuthorizationUrlParams {
        // Always show the account chooser on interactive sign-in.
        return { extraParams: { prompt: 'select_account' } };
    }
}

export function installAuth(app: WebApplication, sessionStore: CacheProvider): void {
    app.use(
        oidcAuthPlugin({
            issuerUrl: process.env.OIDC_ISSUER_URL ?? '',
            clientId: process.env.OIDC_CLIENT_ID ?? '',
            clientSecret: process.env.OIDC_CLIENT_SECRET ?? '',
            redirectUri: `${process.env.APP_URL ?? ''}/api/oidc/callback`,
            sessionStore,
            sessionTtl: 3600,
        })
    );
    app.registerController('', AuthController);
}
```

### Key Methods and Properties

Routes (default prefix `/api/oidc`, configurable via `getRoutePrefix()`):

| Method | Path | Guard | Description |
| --- | --- | --- | --- |
| `GET` | `{prefix}/login` | public | Builds the authorization URL, stores PKCE state, sets the state cookie, `302` |
| `GET` | `{prefix}/callback` | public | Validates state, exchanges the code, verifies the UserInfo subject, stores the session, redirects |
| `POST` | `{prefix}/logout` | public, self-validating | CSRF (opt-in), best-effort revocation, clears session + cookie |
| `GET` | `{prefix}/me` | authenticated (`secure`) | Returns `user`, `expiresAt`, `authorized`, optional `csrfToken`; never tokens |
| `POST` | `{prefix}/refresh` | public, self-validating | CSRF (opt-in), single-flight refresh, re-issues the cookie |

Overridable members:

| Name | Signature | Description |
| --- | --- | --- |
| `routes()` | `() => RouteDefinition[]` | The five route definitions (public API, rarely overridden) |
| `getProviderServiceName()` | `protected () => string` | DI name of the provider; default `'auth'` |
| `getProvider(req)` | `protected (req: Request) => Promise<OidcAuthProvider>` | Resolves the provider from `req.services` |
| `getRoutePrefix()` | `protected () => string` | Route prefix; default `'/api/oidc'` |
| `getLoginParams(req)` | `protected (req: Request) => BuildAuthorizationUrlParams` | Forwards `prompt` / `login_hint` by default |
| `onCallback(tokens, userInfo, req, res)` | `protected async` | Enrich tokens/userInfo before the session is stored |
| `onLogout(req, res)` | `protected async () => void` | Runs before the session is cleared |
| `resolveOrganization(req)` | `protected (req: Request) => string \| undefined` | Tenant slug for org-scoped cookie resolution |
| `resolveConfig(req, provider)` | `protected async (req, provider) => Promise<OidcAuthConfig \| undefined>` | Per-request config; defaults to `provider.resolveRequestConfig(req)` |

---

## OIDC Sessions, PKCE State, and CSRF

### What It Is

The OIDC BFF flow keeps **all sensitive state server-side**. The browser holds only opaque UUID cookies — `__oidc_session` and `__oidc_state` by default — while tokens, user claims, and PKCE material live in a `blendsdk/webafx-cache` `CacheProvider` under `oidc:session:` and `oidc:state:` keys. This concept covers the session record, its three independent lifetime controls, session-id rotation, the transient PKCE state, and the opt-in CSRF enforcement that protects the mutating routes.

### How It Works

**Sessions.** After a successful callback, `OidcAuthProvider.storeSession()` writes the session record under `oidc:session:<uuid>`. Sessions carry the access/refresh/ID tokens, the token expiry, the user claims, an optional organization slug, and — when CSRF is enabled — a per-session CSRF token. Lifetime is governed by three independent settings:

- `sessionTtl` (default 3600 s) — the **sliding idle TTL** of the stored entry, reset by every store (including refreshes).
- `sessionAbsoluteTtl` — a **hard maximum** measured from `createdAt`. The creation time is stamped on the first store and preserved across refreshes and rotation, so activity never extends the deadline. A session past it is deleted on read so it cannot be revived. Legacy sessions without `createdAt` are not rejected; the next store stamps them.
- `sessionCookieTtl` — the browser cookie lifetime, resolved as `sessionCookieTtl ?? sessionTtl ?? 3600`. Each successful refresh re-issues the cookie with this lifetime, so the cookie and the session slide together. An explicit `0` is respected (non-persistent cookie).

**Session-id rotation.** With `rotateSessionIdOnRefresh: true`, a successful refresh stores the updated session under a **new** UUID, deletes the old entry, and issues the cookie with the new id — so an id captured before the refresh stops resolving. Rotation happens only after the refresh and the new store both succeed; failures leave the existing session and cookie in place. The `RefreshSingleFlight` runner in the controller coalesces concurrent refreshes, so ten parallel requests still produce one grant, one store, and one rotation.

**PKCE transient state.** The login handler stores `{ codeVerifier, state, nonce, returnTo }` under `oidc:state:<uuid>` with a short TTL (`stateTtl`, default 300 s) and sets the matching state cookie. The callback consumed it once and clears it — on success and on every rejected outcome — so a spent state cannot be replayed.

**CSRF enforcement (opt-in).** With `csrf: { enabled: true }` (header default `x-csrf-token`), `GET /me` returns the session's CSRF token and `POST /logout` / `POST /refresh` must present it in the configured header; comparison is constant-time. The token never lives in a script-readable cookie, and a session-id rotation regenerates it. Enabling CSRF signs out sessions created before enforcement (they carry no token) on their next logout or refresh.

**Unauthorized sessions.** With `userInfoDenied: 'unauthorized-session'`, a UserInfo 403 still produces a session — carrying the exchanged tokens and `authorized: false`, with only the allowlisted identity claims (`sub`, `email`, `name`) copied from the **verified** ID token. The session authenticates through the provider's session path with `authorized: false`, so `/me` can present the state while guards deny access by policy. When no verified identity exists, the outcome falls back to the fixed `403`.

### Complete Example

A fully configured session-backed provider:

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';
import type { CacheProvider } from 'blendsdk/webafx-cache';
import type { OidcSession } from 'blendsdk/webafx-auth';

export function createSessionBackedProvider(sessionStore: CacheProvider): OidcAuthProvider {
    return new OidcAuthProvider({
        issuerUrl: 'https://auth.example.com',
        clientId: 'my-app',
        clientSecret: process.env.OIDC_CLIENT_SECRET ?? '',
        redirectUri: 'https://app.example.com/api/oidc/callback',
        sessionStore,
        sessionTtl: 3600,          // sliding idle lifetime of the stored session
        sessionAbsoluteTtl: 28800, // hard cap: 8 hours from the first store
        sessionCookieTtl: 3600,    // browser cookie; slides with each refresh
        rotateSessionIdOnRefresh: true,
        csrf: { enabled: true, header: 'x-csrf-token' },
    });
}

export async function persistSession(
    provider: OidcAuthProvider,
    sessionId: string,
    session: OidcSession,
): Promise<OidcSession | undefined> {
    await provider.storeSession(sessionId, session);
    // Returns undefined when the session is past its absolute deadline.
    return provider.getSession(sessionId);
}
```

### Key Methods and Properties

Session and state methods:

| Name | Signature | Description |
| --- | --- | --- |
| `storeSession(id, session)` | `(sessionId: string, session: OidcSession) => Promise<void>` | Writes under `oidc:session:<id>`; stamps `createdAt` when an absolute TTL is configured |
| `getSession(id)` | `(sessionId: string) => Promise<OidcSession \| undefined>` | Deletes and returns `undefined` past the absolute deadline |
| `clearSession(id)` | `(sessionId: string) => Promise<void>` | Deletes the session entry |
| `storeState(id, state)` / `getState(id)` / `clearState(id)` | PKCE transient state CRUD | `oidc:state:<id>` keys, `stateTtl` lifetime |
| `getSessionCookieName(req)` / `getStateCookieName(req)` | `(req: Request) => string` | Resolvers or defaults (`__oidc_session` / `__oidc_state`) |
| `getSessionCookieTtl()` | `() => number` | `sessionCookieTtl` ?? `sessionTtl` ?? `3600` |
| `shouldRotateSessionIdOnRefresh()` | `() => boolean` | Whether the controller rotates the id on refresh |
| `getCsrfConfig()` | `() => OidcCsrfConfig \| undefined` | Session CSRF configuration |
| `shouldVerifyUserInfoSubject()` | `() => boolean` | Defaults to `true` |
| `getUserInfoDeniedMode()` | `() => 'error' \| 'unauthorized-session'` | Denial policy; defaults to `'error'` |
| `getNotAuthorizedPath()` | `() => string` | Redirect target; defaults to `'/'` |

Configuration and stored record:

| Option / Field | Type | Default | Description |
| --- | --- | --- | --- |
| `sessionStore` | `CacheProvider` | — | Required for all BFF session and state operations |
| `sessionTtl` | `number` | `3600` | Sliding store TTL in seconds |
| `sessionAbsoluteTtl` | `number` | unset | Hard session cap from `createdAt`; refresh never extends it |
| `sessionCookieTtl` | `number` | `sessionTtl` → `3600` | Browser cookie lifetime; `≤ 0` yields a non-persistent cookie |
| `stateTtl` | `number` | `300` | PKCE transient state lifetime |
| `rotateSessionIdOnRefresh` | `boolean` | `false` | Move the session to a new id on every successful refresh |
| `csrf` | `OidcCsrfConfig` (`{ enabled?, header? }`) | unset (off) | Session-bound CSRF enforcement; default header `x-csrf-token` |
| `OidcSession.accessToken` / `refreshToken?` / `idToken?` | `string` | — | Tokens held server-side only |
| `OidcSession.expiresAt?` / `createdAt?` | `number` | — | Token expiry (epoch seconds) / first-store time for the absolute TTL |
| `OidcSession.user` | `Record<string, unknown>` | — | User claims from UserInfo (or the verified ID token for unauthorized sessions) |
| `OidcSession.organizationSlug?` / `csrfToken?` / `authorized?` | `string` / `string` / `boolean` | — | Tenant slug / CSRF token / `false` only for denied sessions |

---

## OIDC Flow Error Types

### What It Is

The three exported error classes — `OidcCodeExchangeError`, `OidcUserInfoForbiddenError`, and `OidcUserInfoSubjectMismatchError` — give callers a **stable, typed discriminator** for sign-in outcomes instead of the internal error codes of the underlying `openid-client`/`oauth4webapi` implementation. The controller maps them to fixed HTTP responses; application code can catch them by class.

### How It Works

The distinction that matters everywhere is **flow failure vs. infrastructure failure**:

- A **flow failure** is something a browser user can act on by restarting sign-in: an invalid or expired authorization code, a token-endpoint OAuth error, a failed ID-token signature, `nonce`, issuer, audience, or expiry check. These become `OidcCodeExchangeError` (thrown by `exchangeCode`) with a fixed, safe message; the original library error is attached as `cause` for programmatic inspection only — it may contain provider response detail, so it must not be forwarded to clients or logged verbatim.
- A **UserInfo denial (HTTP 403)** means the IdP authenticated the user but the application declined access. It becomes `OidcUserInfoForbiddenError`, which the controller turns into a fixed `403` — or, with `userInfoDenied: 'unauthorized-session'`, into an unauthorized session.
- A **UserInfo subject mismatch** violates OpenID Connect Core §5.3.2 and the response MUST NOT be used; `OidcUserInfoSubjectMismatchError` is thrown by `fetchUserInfo` when an expected subject is supplied. Its message intentionally carries no subject values, so it is safe to log.
- Everything else — discovery failures, network errors, timeouts, 5xx responses — propagates as the original error and is treated as an infrastructure fault.

### Complete Example

```typescript
import {
    OidcAuthProvider,
    OidcCodeExchangeError,
    OidcUserInfoForbiddenError,
    OidcUserInfoSubjectMismatchError,
} from 'blendsdk/webafx-auth';
import type { OidcAuthConfig, OidcTokens } from 'blendsdk/webafx-auth';

export async function finishSignIn(
    provider: OidcAuthProvider,
    config: OidcAuthConfig | undefined,
    codeVerifier: string,
    callbackUrl: string,
): Promise<OidcTokens | undefined> {
    try {
        return await provider.exchangeCode({ codeVerifier, callbackUrl }, config);
    } catch (error) {
        if (error instanceof OidcCodeExchangeError) {
            // Rejected sign-in: restart the flow. Inspect error.cause for
            // diagnostics only — never send it to the client.
            return undefined;
        }
        throw error;
    }
}

export async function loadUserInfo(
    provider: OidcAuthProvider,
    accessToken: string,
    expectedSubject: string,
): Promise<Record<string, unknown> | undefined> {
    try {
        return await provider.fetchUserInfo(accessToken, expectedSubject);
    } catch (error) {
        if (error instanceof OidcUserInfoForbiddenError) {
            // Authenticated, but the application denies access.
            return undefined;
        }
        if (error instanceof OidcUserInfoSubjectMismatchError) {
            // Never use the returned claims.
            return undefined;
        }
        throw error;
    }
}
```

### Key Methods and Properties

| Error | Thrown by | Meaning | Controller response |
| --- | --- | --- | --- |
| `OidcCodeExchangeError` | `exchangeCode` | Flow-level sign-in failure (bad/expired code, OAuth error body, failed ID-token verification, verified token without a usable subject); `cause` holds the library error for diagnostics only | `400 { code: 'oidc_exchange_failed' }` with the spent state cleared |
| `OidcUserInfoForbiddenError` | `fetchUserInfo` | UserInfo endpoint denied the request with HTTP 403; `cause` for diagnostics only | `403 { code: 'userinfo_forbidden' }`, or an unauthorized session with `userInfoDenied: 'unauthorized-session'` |
| `OidcUserInfoSubjectMismatchError` | `fetchUserInfo` | UserInfo `sub` differs from the expected (ID-token) subject; message carries no subject values | `400 { code: 'userinfo_subject_mismatch' }`; no session created |

---

## Multi-Tenancy and Dynamic Configuration

### What It Is

Multi-tenancy in `blendsdk/webafx-auth` means one provider instance serving many tenants whose issuer, endpoints, or credentials differ. It is implemented through **per-request configuration** (`configFactory` on the OIDC and introspection providers), **per-request cookie-name resolution** for org-scoped sessions, and **tenant-scoped caching** so results never leak between tenants. The package also exports tenant-delegation **contracts** (`TenantAuthConfig`, `TenantResolver`, `TenantProviderFactory`, `AuthProviderLike`) — deliberately as contracts only: **no tenant provider ships with this package**.

### How It Works

**OIDC `configFactory`.** On `authenticate(req)`, the factory is called once per request to produce the effective `OidcAuthConfig` (issuer, clientId, clientSecret, redirectUri). `validate(token)` remains static-only because it has no request context. Discovery is cached **per issuer URL**, so each tenant gets its own discovery entry and JWKS resolver. Refresh coalescing is keyed by issuer + client + token, so identical calls share one grant while two tenants never do. Note which settings are static-only and cannot vary per request: `verifyIdTokenSignature`, `verifyUserInfoSubject`, `rotateSessionIdOnRefresh`, the session TTLs, and `transport`.

**Org-scoped cookies.** `resolveSessionCookieName(req)` and `resolveStateCookieName(req)` let one provider (and one `OidcAuthController`, via its `resolveOrganization()` hook) use cookie names such as `__oidc_session_acme` per tenant. Because the browser then holds independent cookies per tenant, sessions cannot collide.

**Introspection `configFactory`.** The provider resolves DB-backed credentials per request and scopes its response cache by endpoint + client — the same token introspected for tenant A is a separate cache entry from tenant B.

**Tenant delegation contracts.** `TenantAuthConfig` describes a delegating provider that resolves a tenant per request (`resolveTenant`) and obtains a per-tenant provider once (expected to be cached; `maxTenants` default 100 with least-recently-used eviction). `AuthProviderLike` is the minimal shape (`validate`, `health`, `shutdown`) that avoids a circular dependency on the full class. An implementation built on the `AuthProvider` base class decides how to honor these; nothing in this package enforces them.

### Complete Example

A multi-tenant OIDC provider with tenant-specific issuers and org-scoped cookie names:

```typescript
import type { Request } from 'express';
import { OidcAuthProvider } from 'blendsdk/webafx-auth';
import type { CacheProvider } from 'blendsdk/webafx-cache';

interface Tenant {
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
}

const tenants: Record<string, Tenant> = {
    acme: {
        issuerUrl: 'https://acme.auth.example.com',
        clientId: 'acme-app',
        clientSecret: process.env.ACME_CLIENT_SECRET ?? '',
        redirectUri: 'https://acme.app.example.com/api/oidc/callback',
    },
    globex: {
        issuerUrl: 'https://globex.auth.example.com',
        clientId: 'globex-app',
        clientSecret: process.env.GLOBEX_CLIENT_SECRET ?? '',
        redirectUri: 'https://globex.app.example.com/api/oidc/callback',
    },
};

function resolveTenant(req: Request): Tenant {
    const raw = req.headers['x-tenant'];
    const slug = typeof raw === 'string' ? raw : 'acme';
    return tenants[slug] ?? tenants.acme;
}

export function createMultiTenantProvider(sessionStore: CacheProvider): OidcAuthProvider {
    return new OidcAuthProvider({
        sessionStore,
        configFactory: async (req) => resolveTenant(req),
        resolveSessionCookieName: (req) => `__oidc_session_${resolveTenant(req).clientId}`,
        resolveStateCookieName: (req) => `__oidc_state_${resolveTenant(req).clientId}`,
    });
}
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `configFactory` (OIDC) | `(req: Request) => Promise<OidcAuthConfig>` | Per-request issuer/credentials; discovery cached per issuer |
| `configFactory` (introspection) | `(req: Request) => IntrospectionAuthConfig \| Promise<IntrospectionAuthConfig>` | Per-request credentials; takes precedence over static fields |
| `resolveSessionCookieName` / `resolveStateCookieName` | `(req: Request) => string` | Org-scoped cookie names per request |
| `TenantAuthConfig` | exported interface | `{ resolveTenant, createProvider, maxTenants? }` (default 100); contract only — no tenant provider ships |
| `TenantResolver` | `(req: Request) => string \| undefined` | Resolves a tenant id from a request |
| `TenantProviderFactory` | `(tenantId: string) => Promise<AuthProviderLike>` | Creates a per-tenant provider; expected to be called once and cached |
| `AuthProviderLike` | exported interface | Minimal `{ validate, health, shutdown }` shape used by the contracts |

---

## Transport Security

### What It Is

`AuthTransportSecurity` is the opt-in escape hatch for outbound network calls made by a provider — currently consumed only by the OIDC provider. It covers two real-world situations the default transport refuses by design: an issuer whose TLS certificate is signed by a **private CA**, and a development issuer reachable only over **plain HTTP loopback**. When the block is unset, nothing changes: HTTPS only, system trust store, and a hard failure on any TLS problem.

### How It Works

When `transport` is configured with a non-empty `ca` or `allowInsecureRequests: true`, the OIDC provider builds a small `fetch` shim backed by `node:http`/`node:https` and hands it to both `openid-client` and `jose` — so discovery, JWKS fetching, token exchange, refresh, revocation, and UserInfo all use the same trust settings. Details worth knowing:

- **`ca` replaces the system roots** — it does not add to them. When both a private CA and public roots are needed, include the public roots in the value.
- **`allowInsecureRequests` has two effects**: it permits non-HTTPS issuers and disables TLS certificate validation for HTTPS requests. It is development/test only; the provider logs a **once-per-provider warning** when it is enabled.
- **Redirect discipline** — the shim follows up to five redirects, refuses an https→http downgrade, and strips `authorization`/`cookie`/`proxy-authorization` headers on cross-origin redirects.
- **Static configuration only** — a per-request `configFactory` cannot vary `transport`; the discovery cache entry it configures is shared by every tenant of the provider.

### Complete Example

Trusting a private CA for an on-premises issuer:

```typescript
import { readFileSync } from 'node:fs';
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

const privateCa = readFileSync('/etc/ssl/private-ca.pem', 'utf8');

const provider = new OidcAuthProvider({
    issuerUrl: 'https://idp.internal.example.com',
    clientId: 'my-app',
    clientSecret: process.env.OIDC_CLIENT_SECRET ?? '',
    redirectUri: 'https://app.example.com/api/oidc/callback',
    transport: { ca: privateCa },
});

export async function healthCheck(): Promise<boolean> {
    return provider.health();
}
```

Development and test environments may opt into a loopback HTTP issuer:

```typescript fragment
const provider = new OidcAuthProvider({
    issuerUrl: 'http://127.0.0.1:8080',
    clientId: 'dev-client',
    redirectUri: 'http://localhost:3000/api/oidc/callback',
    // Development only. Permits non-HTTPS issuers and disables TLS
    // certificate validation. Never enable against a production issuer.
    transport: { allowInsecureRequests: true },
});
```

### Key Methods and Properties

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `ca` | `string \| string[]` | unset (system roots) | PEM CA bundle(s) to trust; **replaces** the system trust store |
| `allowInsecureRequests` | `boolean` | `false` | Development only: permits non-HTTPS issuers and disables TLS certificate validation; warns once per provider |
| `transport` (config slot) | `AuthTransportSecurity` | unset | Accepted by `AuthProviderConfig`, `OidcAuthConfig`, and `AuthFactoryConfig`; currently consumed only by `OidcAuthProvider` |

---

With these concepts covered, proceed to Basic Usage for end-to-end recipes, or revisit the Overview for the architecture diagram and feature summary.

---

# webafx-auth Basic Usage

---

## Installation

```bash
# npm
npm install blendsdk/webafx-auth

# yarn
yarn add blendsdk/webafx-auth

# pnpm
pnpm add blendsdk/webafx-auth
```

Requirements and dependencies:

- **Node.js >= 22** — the package is ESM-only (`"type": "module"`).
- **TypeScript declarations ship with the package** (`dist/index.d.ts`) — no `@types` package is needed.
- `jose` and `openid-client` are installed automatically as runtime dependencies.

Two peer dependencies are declared **optional** and only needed for the features listed:

| Peer | Install it when |
| --- | --- |
| `blendsdk/webafx` | You use the plugin layer (`createAuthPlugin()` and the `*AuthPlugin()` helpers) or `OidcAuthController` — they integrate with the WebAFX service container and secure guard |
| `blendsdk/webafx-cache` | You use OIDC server-side sessions — `OidcAuthProvider` stores sessions and PKCE state through a `CacheProvider` |

Providers used standalone for token validation require neither peer.

---

## Quick Start

Register an in-memory provider on a WebAFX application and start it:

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { memoryAuthPlugin } from 'blendsdk/webafx-auth';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'INFO' });

app.use(memoryAuthPlugin({
    validTokens: { 'test-token': { sub: 'user-1', claims: {}, token: 'test-token' } },
}));

await app.start();
// GET any route registered with this.authenticated() and
//   Authorization: Bearer test-token  → the route runs with the principal available
// without the header                  → the secure guard answers 401
```

`memoryAuthPlugin()` is the shortest path to a working setup and is intended for tests and local development. Moving to production is a one-line swap — `jwtAuthPlugin({ secret })`, `introspectionAuthPlugin({ ... })`, or `oidcAuthPlugin({ ... })` — because every provider satisfies the same `AuthProvider` contract and registers the same services.

---

## Fundamentals

### 1. Providers: one lifecycle, four implementations

The package exports one abstract base class, `AuthProvider`, which owns the full authentication lifecycle, plus four concrete providers that implement only the backend-specific `validate()` step:

1. `extractToken(req)` walks the configured token sources (default: the `Authorization: Bearer` header).
2. No token found → `undefined` is returned. Unauthenticated requests are normal, not errors.
3. `validate(token)` verifies the token against the provider's backend.
4. A successful verification is mapped to a standardized `AuthResult` (via the claims mapper) and returned.

| Provider | Verifies | Network I/O | Typical use |
| --- | --- | --- | --- |
| `AuthProvider` | Abstract base — cannot be instantiated | — | Custom backends: extend it and implement `validate()`, `health()`, `shutdown()` |
| `JwtAuthProvider` | Locally issued JWTs (HMAC / RSA / EC) | None | Your service issues its own tokens |
| `IntrospectionAuthProvider` | Opaque tokens via OAuth2 introspection (RFC 7662) | Yes | The authorization server issues opaque tokens |
| `OidcAuthProvider` | JWT access tokens via OIDC discovery + JWKS, plus the BFF sign-in flow | Yes | Users sign in through an OpenID Connect provider |
| `MemoryAuthProvider` | A pre-configured token map | None | Tests and local development |

In application code you rarely call the lifecycle by hand — the plugin does it on every request:

```typescript
// typescript fragment
const result: AuthResult | undefined = await provider.authenticate(req);
```

The result carries `sub`, the raw `claims`, the original `token`, and — when available — `exp`, `scopes`, and `principalType`. An invalid, expired, or malformed token resolves to `undefined`; only infrastructure failures (network errors, DNS failures, store errors) are thrown.

### 2. Registering a provider with the WebAFX plugin layer

Wrap any provider with `createAuthPlugin()` and install it with `app.use()`:

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { createAuthPlugin, JwtAuthProvider } from 'blendsdk/webafx-auth';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'INFO' });

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
    throw new Error('JWT_SECRET must be set');
}

const provider = new JwtAuthProvider({
    secret: jwtSecret,
    issuer: 'https://api.example.com',
    audience: 'my-client-id',
});

app.use(createAuthPlugin(provider));

await app.start();
```

The plugin registers two services in the WebAFX container:

| Service | Registration type | Value |
| --- | --- | --- |
| `'auth'` (configurable) | singleton | The provider instance — retrieve it with `req.services.get<AuthProvider>('auth')` |
| `'user'` (configurable) | per-request | `provider.authenticate(req)` — an `AuthResult` or `undefined`; the secure guard resolves this to grant or deny access |

The plugin name is `auth:<serviceName>` and the default priority is `10`, so auth installs before feature plugins. The plugin also delegates `health()` and `shutdown()` to the provider, so the WebAFX health endpoint and graceful shutdown lifecycle manage it automatically — for example, `OidcAuthProvider.health()` performs a discovery check and reports `false` when the issuer is unreachable.

Each provider also has a convenience factory that combines construction and installation in one call:

```typescript
// typescript fragment
app.use(jwtAuthPlugin({ secret }));
app.use(introspectionAuthPlugin({ introspectionUrl: 'https://auth.example.com/oauth2/introspect', clientId, clientSecret }));
app.use(oidcAuthPlugin({ issuerUrl, clientId, clientSecret, redirectUri }));
app.use(memoryAuthPlugin({ validTokens }));
```

Multi-tenant introspection credentials are supported through a per-request factory instead of static credentials:

```typescript
// typescript fragment
app.use(introspectionAuthPlugin({
    configFactory: async (req) => {
        const tenant = String(req.headers['x-tenant'] ?? 'default');
        return {
            introspectionUrl: `https://${tenant}.example.com/oauth2/introspect`,
            clientId: `client-${tenant}`,
            clientSecret: `secret-${tenant}`,
        };
    },
}));
```

### 3. Reading the authenticated principal in a controller

Routes registered with `this.authenticated()` go through the secure guard: it resolves the `'user'` service and returns 401 before the handler runs when the value is `undefined`.

```typescript
import { BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { AuthResult } from 'blendsdk/webafx-auth';

class ReportController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated().get('/reports').handle(async (req, res) => {
                const user = await req.services.get<AuthResult>('user', undefined);
                this.ok(res, {
                    sub: user?.sub,
                    scopes: user?.scopes ?? [],
                });
            }),
        ];
    }
}
```

On a **public** route, use `this.route()` and treat the principal as optional — the same lookup returns `undefined` for anonymous callers:

```typescript
// typescript fragment
this.route().get('/feed').handle(async (req, res) => {
    const user = await req.services.get<AuthResult>('user', undefined);
    this.ok(res, { personalized: user !== undefined });
});
```

### 4. Controlling where tokens are read from

By default only the `Authorization: Bearer <token>` header is inspected. Configure a fallback chain — sources are tried in order and the first non-empty match wins:

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const provider = new JwtAuthProvider({
    secret: 'a-256-bit-secret-for-hs256',
    tokenSources: [
        'header',
        'cookie',
        {
            extractor: (req) => {
                const value = req.headers['x-api-key'];
                return typeof value === 'string' ? value : undefined;
            },
        },
    ],
    cookieName: 'access_token',
});
```

Source details:

| Source | Reads | Configurable name |
| --- | --- | --- |
| `'header'` | `Authorization: Bearer <token>` (the `Bearer ` prefix is required, case-sensitive) | — |
| `'cookie'` | The named cookie (requires cookie parsing middleware, which WebAFX installs) | `cookieName` — default `'auth_token'` |
| `'query'` | The named query parameter (useful for webhooks and SSE) | `queryParamName` — default `'token'` |
| `{ extractor }` | Any custom logic; return `undefined` to fall through to the next source | — |

Extraction only locates the token — validation always happens afterwards in `validate()`.

### 5. Mapping claims and stamping principal types

Every provider runs raw claims through a claims mapper. The built-in default mapper:

- reads the subject from `sub` (falling back to `subject`, then `'unknown'`),
- copies a numeric `exp` when present,
- normalizes scopes from a space-separated `scope` string, a `scopes` array, or a `scope` array,
- preserves all raw claims and the original token string.

Supply `mapClaims` when your tokens use different claim names or you want to classify the principal:

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { jwtAuthPlugin } from 'blendsdk/webafx-auth';
import type { ClaimsMapper } from 'blendsdk/webafx-auth';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'INFO' });

const mapClaims: ClaimsMapper = (token, rawClaims) => ({
    sub: String(rawClaims.user_id ?? rawClaims.sub ?? 'unknown'),
    claims: rawClaims,
    token,
    scopes: Array.isArray(rawClaims.permissions)
        ? rawClaims.permissions.map(String)
        : undefined,
    principalType: 'client',
});

app.use(jwtAuthPlugin({ secret: 'a-256-bit-secret-for-hs256', mapClaims }));

await app.start();
```

Notes:

- `principalType` is descriptive metadata (`'user'` or `'client'`), stamped on a result only when the mapper (or a stored `MemoryAuthProvider` result) has not already set one. It is read from the static provider config; a per-request `configFactory` cannot vary it.
- `OidcAuthProvider` additionally accepts an async `resolveUser(req, claims) => Promise<AuthResult>`, which takes precedence over `mapClaims` on the bearer-token path.

### 6. Running two providers side by side

An application can distinguish principal kinds — for example human users and machine clients — by installing two plugins with distinct service names. Each route then selects its principal with `secure(name)`:

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { createAuthPlugin, MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'INFO' });

app.use(createAuthPlugin(
    new MemoryAuthProvider({
        validTokens: { 'user-token': { sub: 'user-1', claims: {}, token: 'user-token' } },
    }),
    { serviceName: 'user-auth', userServiceName: 'user' },
));

app.use(createAuthPlugin(
    new MemoryAuthProvider({
        validTokens: { 'client-token': { sub: 'client-1', claims: {}, token: 'client-token' } },
    }),
    { serviceName: 'client-auth', userServiceName: 'client' },
));

class ReportController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated().get('/reports').handle(async (req, res) => {
                const user = await req.services.get<AuthResult>('user', undefined);
                this.ok(res, { sub: user?.sub });
            }),
            this.route().get('/reports/export').secure('client').handle(async (req, res) => {
                const client = await req.services.get<AuthResult>('client', undefined);
                this.ok(res, { sub: client?.sub });
            }),
        ];
    }
}

app.registerController('', ReportController);

await app.start();
```

Key rules:

- Each plugin needs a **distinct `serviceName`** — the plugin name is `auth:<serviceName>`, and WebAFX fails fast at startup when a name is already registered.
- An **unnamed** secure route always resolves the default `'user'` service, whatever `userServiceName` is set. To authenticate against a non-default principal, name it on the route with `secure('client')`.
- Each principal is independent: the client token is rejected (401) on the default route, and the user token is rejected on the client route.

### 7. Building the provider from environment configuration

`createAuthProvider()` selects and validates a provider from a single config object — ideal for environment-driven startup. Misconfiguration fails immediately with a field-specific message, not at the first request:

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { createAuthPlugin, createAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthFactoryConfig, AuthProvider } from 'blendsdk/webafx-auth';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'INFO' });

function buildProvider(): AuthProvider {
    const config: AuthFactoryConfig = {
        type: 'oidc',
        issuerUrl: process.env.OIDC_ISSUER_URL,
        clientId: process.env.OIDC_CLIENT_ID,
        clientSecret: process.env.OIDC_CLIENT_SECRET,
    };

    try {
        return createAuthProvider(config);
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Authentication is misconfigured: ${error.message}`);
        }
        throw error;
    }
}

app.use(createAuthPlugin(buildProvider()));

await app.start();
```

Dispatch table:

| `type` | Provider created | Required fields |
| --- | --- | --- |
| `'jwt'` | `JwtAuthProvider` | `secret` |
| `'introspection'` | `IntrospectionAuthProvider` | `introspectionUrl`, `clientId`, `clientSecret` — or a `configFactory` |
| `'oidc'` | `OidcAuthProvider` | `issuerUrl` (`clientId` is additionally required for discovery/JWKS validation and BFF calls) |
| `'memory'` | `MemoryAuthProvider` | None |

### 8. Full browser sign-in with the OIDC controller

For interactive users, pair `oidcAuthPlugin()` with a subclass of `OidcAuthController`. The controller provides the Backend-for-Frontend authorization-code flow with PKCE; browsers hold only opaque UUID cookies, and tokens stay server-side in a `CacheProvider` session store:

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { OidcAuthController, oidcAuthPlugin } from 'blendsdk/webafx-auth';
import type { OidcAuthConfig } from 'blendsdk/webafx-auth';
import type { CacheProvider } from 'blendsdk/webafx-cache';

export function registerOidcAuth(app: WebApplication, sessionStore: CacheProvider): void {
    const config: OidcAuthConfig = {
        issuerUrl: 'https://auth.example.com/realms/acme',
        clientId: 'my-web-app',
        clientSecret: 'client-secret',
        redirectUri: 'https://app.example.com/auth/callback',
        sessionStore,
    };

    app.use(oidcAuthPlugin(config));

    class AuthController extends OidcAuthController {
        protected getRoutePrefix(): string {
            return '/auth';
        }
    }

    app.registerController('', AuthController);
}
```

The default route prefix is `/api/oidc`; overriding `getRoutePrefix()` moves all five routes, so keep `redirectUri` aligned with the callback route.

| Route | Method | Purpose |
| --- | --- | --- |
| `{prefix}/login` | GET | Starts the flow: builds the authorization URL with PKCE (`S256`), stores transient state server-side, sets the state cookie, redirects to the provider |
| `{prefix}/callback` | GET | Validates state, exchanges the code, verifies the ID token and the UserInfo subject, creates the session, sets the session cookie, redirects to the (sanitized) `returnTo` path |
| `{prefix}/me` | GET | Authenticated. Returns `user`, `expiresAt`, `authorized`, and `csrfToken` when CSRF enforcement is enabled — never tokens |
| `{prefix}/logout` | POST | Revokes the access token (best-effort), clears the session and cookie |
| `{prefix}/refresh` | POST | Refreshes tokens with single-flight coalescing; rotates the session id when `rotateSessionIdOnRefresh` is enabled |

Security behavior is on by default: PKCE state and nonce validation, ID-token signature verification, UserInfo subject verification (OpenID Connect Core §5.3.2), and secure cookie flags with opaque UUID cookie values. CSRF enforcement, absolute session lifetimes, and session-id rotation are opt-in. The controller resolves the provider from the service name `'auth'` — exactly the name `oidcAuthPlugin()` registers by default. Multi-tenant deployments point the same controller at different issuers through the provider's `configFactory`.

---

## Configuration

All options are optional unless marked required. Default values come from the provider constructors and the exported constants.

### Plugin options (`AuthPluginOptions`)

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `serviceName` | `string` | `'auth'` (`DEFAULT_SERVICE_NAME`) | Name of the singleton provider service in the WebAFX container |
| `userServiceName` | `string` | `'user'` | Name of the per-request principal service. A route authenticates against this name only when the route names it (`secure('client')`); unnamed secure routes always resolve `'user'` |
| `priority` | `number` | `10` (`DEFAULT_PLUGIN_PRIORITY`) | Install order; lower numbers install first, so auth installs before feature plugins |

### Shared provider options (`AuthProviderConfig`)

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `serviceName` | `string` | `'auth'` | Service name used by the provider (and reported by `provider.serviceName`) |
| `tokenSources` | `TokenSource[]` | `['header']` (`DEFAULT_TOKEN_SOURCES`) | Ordered extraction chain; first non-empty match wins |
| `cookieName` | `string` | `'auth_token'` (`DEFAULT_COOKIE_NAME`) | Cookie read by the `'cookie'` source |
| `queryParamName` | `string` | `'token'` (`DEFAULT_QUERY_PARAM_NAME`) | Query parameter read by the `'query'` source |
| `mapClaims` | `ClaimsMapper` | built-in default mapper | Transforms raw claims into an `AuthResult` |
| `principalType` | `'user' \| 'client'` | unset | Stamped on results that do not already carry one; static config only |
| `transport` | `AuthTransportSecurity` | unset | OIDC outbound transport: `{ ca?: string \| string[]; allowInsecureRequests?: boolean }`. `ca` replaces the system roots; `allowInsecureRequests` is development-only |

### JWT provider options (`JwtAuthConfig`)

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `secret` | `string \| CryptoKey` | **required** | HMAC secret (string) or RSA/EC public key (`CryptoKey`) |
| `algorithms` | `string[]` | `['HS256']` | Allowed signing algorithms |
| `issuer` | `string` | unset | When set, tokens with a different `iss` are rejected |
| `audience` | `string \| string[]` | unset | When set, tokens without a matching `aud` are rejected |
| `requireAudience` | `boolean` | `false` | When `true` and no `audience` is configured, every token is rejected (fails closed) |
| `clockTolerance` | `number` | `0` | Seconds of skew allowed for `exp` / `nbf` checks |

### Introspection provider options (`IntrospectionAuthOptions` / `IntrospectionAuthConfig`)

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `introspectionUrl` | `string` | required in static mode | RFC 7662 introspection endpoint |
| `clientId` | `string` | required in static mode | Client ID for the introspection endpoint |
| `clientSecret` | `string` | required in static mode | Client secret for the introspection endpoint |
| `configFactory` | `(req) => IntrospectionAuthConfig \| Promise<IntrospectionAuthConfig>` | unset | Resolves credentials per request (for example from a database); takes precedence over static fields. In factory-only mode use `authenticate(req)` — `validate()` returns `undefined` |
| `audience` | `string \| string[]` | unset | Token is rejected unless at least one configured value appears in the response `aud` |
| `authMethod` | `'basic' \| 'post'` | `'basic'` | How client credentials are sent to the endpoint |
| `cacheTTL` | `number` | `60` | Seconds an active response is cached; also bounded by the token's own `exp` |
| `maxCacheSize` | `number` | `1000` | LRU bound on cached responses |
| `timeout` | `number` | `5000` | HTTP timeout in milliseconds |

### OIDC provider options — connection and validation (`OidcAuthConfig`)

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `issuerUrl` | `string` | required unless `configFactory` is set | OIDC issuer used for discovery |
| `clientId` | `string` | required for discovery/JWKS and BFF | OAuth2 client ID |
| `clientSecret` | `string` | unset | Client secret for confidential clients |
| `redirectUri` | `string` | required for the BFF flow | Callback URL registered at the provider |
| `configFactory` | `(req) => Promise<OidcAuthConfig>` | unset | Resolves tenant-specific configuration per request |
| `scopes` | `string[]` | `['openid', 'profile', 'email']` | Scopes requested during sign-in |
| `audience` | `string \| string[]` | unset | Expected access-token `aud` |
| `requireAudience` | `boolean` | `false` | When `true` and no `audience` is configured, tokens are rejected (fails closed) |
| `clockTolerance` | `number` | `30` | Seconds of skew for JWT validation (and the session expiry check) |
| `discoveryTtl` | `number` | `3600` | Seconds the per-issuer discovery/JWKS cache entry lives |
| `verifyIdTokenSignature` | `boolean` | `true` | Verify the code-exchange ID token against the issuer's JWKS; static config only |
| `verifyUserInfoSubject` | `boolean` | `true` | Require the UserInfo `sub` to equal the verified ID-token `sub`; static config only |
| `resolveUser` | `(req, claims) => Promise<AuthResult>` | unset | Async resolver that takes precedence over `mapClaims` on the bearer path |
| `transport` | `AuthTransportSecurity` | unset | Private CA and/or development-only insecure transport |

### OIDC provider options — sessions and BFF

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `sessionStore` | `CacheProvider` | unset — required for the BFF flow | Server-side storage for sessions and PKCE state |
| `sessionTtl` | `number` | `3600` | Sliding session lifetime in seconds; static config only |
| `sessionAbsoluteTtl` | `number` | unset | Hard session cap measured from `createdAt`; refresh never extends it |
| `sessionCookieTtl` | `number` | `sessionTtl`, then `3600` | Browser cookie `maxAge`; re-issued on refresh |
| `resolveSessionCookieName` | `(req) => string` | `'__oidc_session'` | Per-request cookie name (org-scoped cookies for multi-tenant) |
| `resolveStateCookieName` | `(req) => string` | `'__oidc_state'` | Per-request state cookie name |
| `stateTtl` | `number` | `300` | Seconds PKCE transient state lives between redirect and callback |
| `rotateSessionIdOnRefresh` | `boolean` | `false` | Move the session to a new opaque id on every successful refresh |
| `userInfoDenied` | `'error' \| 'unauthorized-session'` | `'error'` | How a UserInfo 403 is handled: fixed 403, or a stored session marked `authorized: false` |
| `notAuthorizedPath` | `string` | `'/'` | Redirect target for the `unauthorized-session` mode |
| `csrf` | `OidcCsrfConfig` | unset (disabled) | `{ enabled?: boolean; header?: string }` — defaults `false` and `'x-csrf-token'`. When enabled, `/me` returns the token and logout/refresh require it |

Static-only options: `principalType`, `transport`, `verifyIdTokenSignature`, `verifyUserInfoSubject`, `userInfoDenied`, `notAuthorizedPath`, `rotateSessionIdOnRefresh`, `sessionTtl`, `sessionAbsoluteTtl`, and `sessionCookieTtl` are read from the static configuration — a per-request `configFactory` cannot vary them.

### Memory provider options (`MemoryAuthConfig`)

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `validTokens` | `Record<string, AuthResult>` | `{}` (empty) | Token string → result returned when that token is validated |

`MemoryAuthProvider` also exposes test helpers: `addToken(token, result)`, `removeToken(token)` (returns whether it existed), and `getTokenCount()`. `shutdown()` clears the map.

### Exported default constants

| Constant | Value |
| --- | --- |
| `DEFAULT_SERVICE_NAME` | `'auth'` |
| `DEFAULT_PLUGIN_PRIORITY` | `10` |
| `DEFAULT_COOKIE_NAME` | `'auth_token'` |
| `DEFAULT_QUERY_PARAM_NAME` | `'token'` |
| `DEFAULT_TOKEN_SOURCES` | `['header']` |

---

## Error Handling

### The silent-failure contract

The package deliberately separates "this request is not authenticated" from "something is broken". Failed authentication never throws — it resolves to `undefined`, and the secure guard turns that into a 401:

| Situation | Outcome |
| --- | --- |
| No token found in the request | `undefined` — normal for public routes |
| Token malformed, expired, or signed with the wrong key | `undefined` |
| JWT issuer/audience mismatch, or `requireAudience` with no audience configured | `undefined` |
| OIDC access-token verification fails, or discovery fails during bearer authentication | `undefined` |
| Introspection response has `active: false`, is expired, or fails the audience check | `undefined` |
| Memory provider receives an unknown token | `undefined` |

Only infrastructure failures propagate as exceptions, which WebAFX's error handling surfaces as 500-class responses:

| Failure | Where | Outcome |
| --- | --- | --- |
| Network/DNS failure or timeout against the introspection endpoint | `IntrospectionAuthProvider` | Error is thrown (e.g. the fetch error, or `Token introspection failed with HTTP 503`) |
| Introspection body is not a JSON object | `IntrospectionAuthProvider` | `Error: Token introspection returned an invalid response body` |
| `configFactory` rejects or returns an incomplete config | `IntrospectionAuthProvider` | Error is thrown |
| `configFactory` rejects during bearer authentication | `OidcAuthProvider` | Treated as failed authentication — `undefined` |
| `resolveUser` rejects | `OidcAuthProvider` | Rejection propagates |
| Session store read/write fails | `OidcAuthProvider` session path, `OidcAuthController` | Error propagates (do not swallow it — a degraded store must not silently authenticate) |
| Session operation without `sessionStore` configured | `OidcAuthProvider` BFF methods | `Error: OidcAuthProvider: sessionStore is required for BFF session operations` |
| Unknown token source in `tokenSources` | Constructor | `Error: Unknown token source: ... Supported: "header", "cookie", "query", or { extractor: fn }` |

`health()` never throws: it returns `true` or `false` (`OidcAuthProvider.health()` performs a discovery check; `JwtAuthProvider.health()` only checks that key material is present; `MemoryAuthProvider.health()` always returns `true`).

### Errors thrown at startup

Misconfiguration is meant to fail loudly before the first request. `createAuthProvider()` throws synchronously with a field-specific message:

| Trigger | Error message |
| --- | --- |
| `type: 'jwt'` without `secret` | `createAuthProvider: type 'jwt' requires 'secret'` |
| `type: 'oidc'` without `issuerUrl` | `createAuthProvider: type 'oidc' requires 'issuerUrl'` |
| `type: 'introspection'` without the static triple or a factory | `createAuthProvider: type 'introspection' requires 'introspectionUrl', 'clientId' and 'clientSecret', or 'configFactory'` |
| Unknown `type` value | `createAuthProvider: unsupported type '...'` |

The provider constructors enforce the same contracts directly:

- `new IntrospectionAuthProvider(...)` throws unless it receives a complete `introspectionUrl` / `clientId` / `clientSecret` triple or a `configFactory`.
- `new OidcAuthProvider(...)` throws unless it receives an `issuerUrl` or a `configFactory`.

Catch startup errors to add operational context:

```typescript
import { createAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthFactoryConfig, AuthProvider } from 'blendsdk/webafx-auth';

export function buildProvider(): AuthProvider {
    const config: AuthFactoryConfig = {
        type: 'introspection',
        introspectionUrl: process.env.OIDC_INTROSPECT_URL,
        clientId: process.env.OIDC_CLIENT_ID,
        clientSecret: process.env.OIDC_CLIENT_SECRET,
    };

    try {
        return createAuthProvider(config);
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Authentication is misconfigured: ${error.message}`);
        }
        throw error;
    }
}
```

### Typed OIDC flow errors

The OIDC BFF flow reports flow-level failures with three exported error classes. Their messages are fixed and safe to serialize; each carries the original library error as `cause` for programmatic diagnostics only — never forward `cause` to a client and do not log it verbatim, because it may contain provider response detail.

| Error class | Raised when | `OidcAuthController` maps it to |
| --- | --- | --- |
| `OidcCodeExchangeError` | The authorization-code exchange or ID-token verification fails (invalid/expired code, failed signature, `nonce`/`iss`/`aud`/`exp` check, or a verified ID token without a usable subject) | `400` with code `oidc_exchange_failed` |
| `OidcUserInfoSubjectMismatchError` | The UserInfo `sub` differs from the verified ID-token `sub` (OIDC Core §5.3.2) | `400` with code `userinfo_subject_mismatch` |
| `OidcUserInfoForbiddenError` | The UserInfo endpoint refuses the request with HTTP 403 | `403` with code `userinfo_forbidden` — or an `authorized: false` session in `unauthorized-session` mode |
| Any other error (network, discovery, 5xx, store failure) | Infrastructure problem | Propagates to the framework error handler |

If you call the BFF methods on `OidcAuthProvider` directly (instead of through the controller), discriminate with `instanceof`:

```typescript
import {
    OidcCodeExchangeError,
    OidcUserInfoForbiddenError,
    OidcUserInfoSubjectMismatchError,
} from 'blendsdk/webafx-auth';
import type {
    ExchangeCodeParams,
    OidcAuthProvider,
    OidcTokens,
} from 'blendsdk/webafx-auth';

export async function completeSignIn(
    provider: OidcAuthProvider,
    params: ExchangeCodeParams,
): Promise<{ tokens: OidcTokens; userInfo: Record<string, unknown> } | undefined> {
    try {
        const tokens = await provider.exchangeCode(params);
        const userInfo = await provider.fetchUserInfo(tokens.accessToken, tokens.subject);
        return { tokens, userInfo };
    } catch (error) {
        if (error instanceof OidcCodeExchangeError) {
            console.warn(`Sign-in rejected: ${error.message}`);
            return undefined;
        }
        if (error instanceof OidcUserInfoForbiddenError) {
            console.warn(`UserInfo denied: ${error.message}`);
            return undefined;
        }
        if (error instanceof OidcUserInfoSubjectMismatchError) {
            console.warn(`UserInfo rejected: ${error.message}`);
            return undefined;
        }
        throw error;
    }
}
```

In an application using `OidcAuthController`, you rarely need this pattern — the controller already classifies these errors into fixed HTTP responses and clears the spent PKCE state. Let unexpected errors propagate so infrastructure problems stay visible as server errors.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
