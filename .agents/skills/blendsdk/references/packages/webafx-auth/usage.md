> **Package**: `blendsdk/webafx-auth`

# webafx-auth Core Concepts

This document is a deep dive into the building blocks of `blendsdk/webafx-auth`: the abstract provider lifecycle, the token extraction chain, result mapping and principal typing, the four concrete providers, the OIDC browser-login controller, and the plugin and factory integration layer. For a runnable first contact, see Basic Usage; for the architecture summary, see the Overview.

---

## AuthProvider — The Abstract Base Class

### What It Is

`AuthProvider` is the abstract base class every provider in this package derives from. It owns the two things concrete providers must never re-implement: the ordered token extraction chain that locates a raw token on the request, and the authentication lifecycle that turns a token into an `AuthResult`. A concrete provider implements exactly three methods — `validate()`, `health()`, and `shutdown()`.

### How It Works

- The provider is an **application-wide singleton** (not per-request). One instance is registered with the WebAFX service container; the per-request principal is produced by calling `authenticate(req)` on that instance.
- `authenticate()` first calls the public `extractToken(req)`. When no token is found it returns `undefined` immediately — no validation work is performed, because unauthenticated requests are normal for public routes.
- When a token is found, `authenticate()` delegates to `validate(token)`, which is the only method concrete providers must implement.
- The failure contract is **silent**: missing, malformed, or expired tokens yield `undefined` (which route security turns into a 401). Only infrastructure failures — network errors, DNS failures — are thrown.
- The constructor builds the extraction chain from `tokenSources` and installs the claims mapper (`mapClaims` or the built-in default). An unknown token source throws at construction time, so misconfiguration surfaces at startup.
- `health()` is used by the WebAFX health endpoint to report provider status; `shutdown()` is invoked by the WebAFX shutdown lifecycle to release connections, cached keys, and timers.

### Complete Example

A custom provider that validates static API keys demonstrates the minimal contract — only `validate()`, `health()`, and `shutdown()` are needed:

```typescript
import { AuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult, TokenExtractor } from 'blendsdk/webafx-auth';

/** Reads a token from the X-Api-Key request header. */
const apiKeyExtractor: TokenExtractor = (req) => {
    const value = req.headers['x-api-key'];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
};

/** Minimal custom provider: validates against a fixed set of API keys. */
class ApiKeyAuthProvider extends AuthProvider {
    private readonly validKeys: Set<string>;

    constructor(validKeys: string[]) {
        super({ tokenSources: [{ extractor: apiKeyExtractor }] });
        this.validKeys = new Set(validKeys);
    }

    async validate(token: string): Promise<AuthResult | undefined> {
        if (!this.validKeys.has(token)) {
            return undefined; // silent failure — invalid credentials are not errors
        }
        return {
            sub: `api-key:${token.slice(0, 8)}`,
            claims: { kind: 'api-key' },
            token,
        };
    }

    async health(): Promise<boolean> {
        return this.validKeys.size > 0;
    }

    async shutdown(): Promise<void> {
        this.validKeys.clear();
    }
}

const provider = new ApiKeyAuthProvider(['key-abc123']);

console.log(await provider.validate('key-abc123')); // AuthResult with sub 'api-key:key-abc1'
console.log(await provider.validate('wrong-key')); // undefined — silent failure

await provider.shutdown();
```

See Basic Usage for wiring a provider into an application with the plugin system.

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `constructor` | `(config?: AuthProviderConfig)` | Builds the extraction chain and installs the claims mapper |
| `serviceName` | `string` (getter) | Registration name; defaults to `DEFAULT_SERVICE_NAME` (`'auth'`) |
| `extractToken` | `(req: Request) => string \| undefined` | Walks the extraction chain; returns the first non-empty match |
| `authenticate` | `(req: Request) => Promise<AuthResult \| undefined>` | The full lifecycle: extract token, then validate it |
| `validate` | `(token: string) => Promise<AuthResult \| undefined>` | Abstract — implemented by each provider |
| `health` | `() => Promise<boolean>` | Abstract — is the auth backend reachable and configured? |
| `shutdown` | `() => Promise<void>` | Abstract — release connections, caches, and timers |

Base configuration options understood by every provider:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `serviceName` | `string` | `'auth'` | Service name used for container registration |
| `tokenSources` | `TokenSource[]` | `['header']` | Ordered extraction chain (see next section) |
| `cookieName` | `string` | `'auth_token'` | Cookie read by the `'cookie'` source |
| `queryParamName` | `string` | `'token'` | Query parameter read by the `'query'` source |
| `mapClaims` | `ClaimsMapper` | built-in default mapper | Converts raw claims into an `AuthResult` |
| `principalType` | `PrincipalType` | `undefined` | Stamped on results that do not carry one |

---

## The Token Extraction Chain

### What It Is

The token extraction chain is the ordered fallback strategy that finds a raw token on an incoming request. It is configured once with the `tokenSources` option and evaluated on every request by `extractToken()`.

### How It Works

- At construction, each configured source is compiled into an extractor function; `extractToken()` walks the array in order and returns the **first non-empty match**. When every source is exhausted, it returns `undefined` — an unauthenticated request, never an error.
- The header source expects the exact, case-sensitive `Bearer ` prefix on the `Authorization` header and returns the remainder. `Basic` or lowercase `bearer` schemes do not match.
- The cookie source reads `req.cookies[cookieName]`; it requires cookie-parser middleware, which is already built into WebAFX's core middleware stack.
- The query source reads `req.query[queryParamName]` and only accepts string values — repeated parameters parsed as arrays are ignored. It is useful for webhook callbacks, email links, and SSE endpoints where headers cannot be set.
- A custom source is an object of the shape `{ extractor: TokenExtractor }` and can read any other request location, such as an API-key header.
- An unrecognized source value throws at construction time with a message listing the supported forms.

### Complete Example

The example below tries three sources in order: the standard bearer header, a custom `X-Api-Key` header, and finally the `app_session` cookie for browser clients.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { createAuthPlugin, MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { TokenExtractor } from 'blendsdk/webafx-auth';

/** Reads a token from the X-Api-Key header (machine clients). */
const apiKeyExtractor: TokenExtractor = (req) => {
    const value = req.headers['x-api-key'];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const provider = new MemoryAuthProvider({
    // First source with a value wins: header → API key → cookie.
    tokenSources: ['header', { extractor: apiKeyExtractor }, 'cookie'],
    cookieName: 'app_session',
    validTokens: {
        'valid-token': { sub: 'user-1', claims: {}, token: 'valid-token' },
    },
});

const app = new WebApplication({ PORT: 3400, ENV_MODE: 'development', LOG_LEVEL: 'ERROR' });
app.use(createAuthPlugin(provider));
await app.start();
```

A request can present the token as `Authorization: Bearer valid-token`, `X-Api-Key: valid-token`, or `Cookie: app_session=valid-token` — the first source that yields a value wins.

### Key Methods and Properties

| Source | Reads from | Notes |
| --- | --- | --- |
| `'header'` | `Authorization: Bearer <token>` | Default and only entry of `DEFAULT_TOKEN_SOURCES`; requires the exact `Bearer ` prefix |
| `'cookie'` | Cookie named `cookieName` | Default name `'auth_token'` (`DEFAULT_COOKIE_NAME`); requires cookie-parser |
| `'query'` | Parameter named `queryParamName` | Default name `'token'` (`DEFAULT_QUERY_PARAM_NAME`); non-string values are ignored |
| `{ extractor }` | `TokenExtractor`: `(req) => string \| undefined` | Any other request location; return `undefined` when the token is absent |

| Name | Type / Signature | Description |
| --- | --- | --- |
| `extractToken` | `(req: Request) => string \| undefined` | Walks the chain in order; first non-empty match wins |

---

## AuthResult and Claims Mapping

### What It Is

`AuthResult` is the standardized, provider-independent description of an authenticated principal — the object every route handler consumes via the per-request principal service. Claims mapping is the transformation that converts a provider's raw claims (JWT payload, introspection response, UserInfo document) into that shape.

### How It Works

- Every provider except `MemoryAuthProvider` funnels raw claims through a `ClaimsMapper`. `MemoryAuthProvider` stores complete `AuthResult` objects and returns them as-is.
- The **default mapper** lives on the base class and understands the most common OAuth2/JWT claim formats: `sub`/`subject`, numeric `exp`, and the space-separated `scope` string as well as `scope`/`scopes` arrays.
- A custom mapper replaces the default entirely: `mapClaims: (token, rawClaims) => AuthResult`. Its return value is used as-is, except for the principal-type fill described in the next section.
- For OIDC bearer validation, the per-request `resolveUser` hook takes precedence over `mapClaims` when both are configured.
- The mapper runs on every successful validation, including introspection cache hits — so tenant-specific enrichment in a mapper is never skipped just because the HTTP call was skipped.

### Complete Example

An identity provider that issues non-standard `employee_id` and `roles` claims is mapped onto the standard result shape:

```typescript
import { SignJWT } from 'jose';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';
import type { ClaimsMapper } from 'blendsdk/webafx-auth';

const SECRET = 'documentation-example-secret-at-least-32-bytes!';

// A token using provider-specific claim names
const token = await new SignJWT({ employee_id: 'E-4711', roles: ['reports:read', 'reports:export'] })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .setIssuer('https://auth.corp.example.com')
    .setAudience('internal-api')
    .sign(new TextEncoder().encode(SECRET));

// Translate the non-standard claims into the standard AuthResult shape
const corporateMapper: ClaimsMapper = (rawToken, rawClaims) => ({
    sub: String(rawClaims.employee_id ?? 'unknown'),
    claims: rawClaims,
    token: rawToken,
    scopes: Array.isArray(rawClaims.roles) ? rawClaims.roles.map(String) : undefined,
});

const provider = new JwtAuthProvider({
    secret: SECRET,
    issuer: 'https://auth.corp.example.com',
    audience: 'internal-api',
    mapClaims: corporateMapper,
});

const result = await provider.validate(token);
console.log(result?.sub);    // 'E-4711'
console.log(result?.scopes); // ['reports:read', 'reports:export']

await provider.shutdown();
```

### Key Methods and Properties

The `AuthResult` shape:

| Field | Type | Description |
| --- | --- | --- |
| `sub` | `string` | Subject identifier of the authenticated principal |
| `claims` | `Record<string, unknown>` | The raw claims, preserved verbatim |
| `token` | `string` | The original raw token string |
| `exp` | `number \| undefined` | Expiration as seconds since epoch; set only for numeric `exp` claims |
| `scopes` | `string[] \| undefined` | Parsed permissions from `scope`/`scopes` claims |
| `principalType` | `PrincipalType \| undefined` | `'user'` or `'client'` — see Principal Discrimination |

Default mapping rules applied when no `mapClaims` is configured:

| Raw claim | Mapped to | Rule |
| --- | --- | --- |
| `sub` or `subject` | `sub` | Stringified; falls back to `'unknown'` when neither is present |
| `exp` | `exp` | Kept only when the value is a number |
| `scope` (string) | `scopes` | Split on single spaces, empty entries removed |
| `scope` (array) | `scopes` | Each entry stringified |
| `scopes` (array) | `scopes` | Each entry stringified |
| everything else | `claims` | Preserved unchanged |

| Name | Type / Signature | Description |
| --- | --- | --- |
| `mapClaims` | `(token: string, rawClaims: Record<string, unknown>) => AuthResult` | Config option; replaces the default mapper |
| `ClaimsMapper` | `(token: string, rawClaims: Record<string, unknown>) => AuthResult` | The mapper type; may be synchronous |

---

## Principal Discrimination

### What It Is

`principalType` is an optional field on `AuthResult` (`'user'` or `'client'` — the `PrincipalType` union) that distinguishes interactive human sessions from machine principals. A single application can run several providers side by side and route each request to the appropriate one by the principal service a route requires.

### How It Works

- Discrimination is configured once per provider with the `principalType` option; the base class stamps it onto validated results.
- Precedence when filling the field: a value **already present** on the mapped result wins (custom mapper output, stored memory result) — otherwise the configured `principalType` is applied — otherwise the field stays `undefined`. This keeps custom mappers authoritative while making the config option a safe default.
- The built-in default claims mapper bakes the configured type in directly; the protected `withPrincipalType()` helper covers results produced by custom mappers.
- OIDC has a deliberate special case: the bearer-token path stamps the configured type, while the **session-cookie path always reports `'user'`**, because a server-side session is an interactive user session regardless of configuration.
- Routing works through per-request service names: each auth plugin registers its principal under its `userServiceName` (default `'user'`), and a route names the service it needs — for example WebAFX's `this.route().get('/api/machine').secure('client')` for machine tokens versus the default authenticated route for users.

### Complete Example

Two providers, each declaring its principal kind; stored memory results inherit the configured type when they do not carry one:

```typescript
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';

const userProvider = new MemoryAuthProvider({
    principalType: 'user',
    validTokens: {
        'session-token': { sub: 'user-1', claims: {}, token: 'session-token' },
    },
});

const clientProvider = new MemoryAuthProvider({
    principalType: 'client',
    validTokens: {
        'machine-token': { sub: 'svc-billing', claims: {}, token: 'machine-token' },
    },
});

const user = await userProvider.validate('session-token');
const client = await clientProvider.validate('machine-token');

console.log(user?.principalType);   // 'user'
console.log(client?.principalType); // 'client'
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `principalType` (config) | `'user' \| 'client'` | Static principal type stamped on results lacking one |
| `principalType` (result) | `PrincipalType \| undefined` | Set by the mapper, the config fill, or the provider's own logic (OIDC session path) |
| `withPrincipalType` | `(result: AuthResult \| undefined) => AuthResult \| undefined` | Protected helper; fills the configured type when unset, leaves existing values untouched |

---

## MemoryAuthProvider

### What It Is

`MemoryAuthProvider` is the in-memory provider that maps token strings to pre-built `AuthResult` objects. It performs no cryptography and no network calls, making it the deterministic choice for tests, demos, and local development — and an unsuitable choice for production.

### How It Works

- `validate()` is a plain map lookup: a registered token returns its stored `AuthResult`; an unknown or empty token returns `undefined`.
- The stored result is returned as-is; `mapClaims` is **not** applied. The only transformation is the principal-type fill: a stored result keeps its own `principalType`, otherwise the configured one is applied.
- Tokens can be managed at runtime with `addToken()` (adding or replacing), `removeToken()` (returning whether the token existed), and `getTokenCount()`.
- `health()` always returns `true`; `shutdown()` clears the entire token map, which is handy for cleaning up between test suites.
- All base options apply — the provider honors the token extraction chain, `serviceName`, and `principalType`, so it can exercise any extraction configuration.

### Complete Example

```typescript
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';

const provider = new MemoryAuthProvider({
    validTokens: {
        'admin-token': {
            sub: 'admin-1',
            claims: { role: 'admin' },
            token: 'admin-token',
            scopes: ['admin'],
        },
    },
});

provider.addToken('temp-token', {
    sub: 'temp-user',
    claims: {},
    token: 'temp-token',
});
console.log(provider.getTokenCount()); // 2

const result = await provider.validate('admin-token');
console.log(result?.sub);    // 'admin-1'
console.log(result?.scopes); // ['admin']

provider.removeToken('temp-token');
console.log(provider.getTokenCount()); // 1

await provider.shutdown();
console.log(provider.getTokenCount()); // 0 — shutdown clears all tokens
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `constructor` | `(config?: MemoryAuthConfig)` | Accepts `validTokens` plus all base configuration options |
| `validTokens` | `Record<string, AuthResult>` | Map of token string to the result returned for it |
| `validate` | `(token: string) => Promise<AuthResult \| undefined>` | Map lookup; `undefined` for unknown tokens |
| `addToken` | `(token: string, result: AuthResult) => void` | Adds a token or replaces an existing entry |
| `removeToken` | `(token: string) => boolean` | Removes a token; returns whether it existed |
| `getTokenCount` | `() => number` | Number of currently registered tokens |
| `health` | `() => Promise<boolean>` | Always `true` |
| `shutdown` | `() => Promise<void>` | Clears all registered tokens; safe to call repeatedly |

---

## JwtAuthProvider

### What It Is

`JwtAuthProvider` validates self-contained JWTs locally using `jose`. The token's signature, expiration, issuer, and audience are verified in-process — there is no network round trip at request time, which makes it the lowest-latency provider for APIs that receive JWTs directly.

### How It Works

- HMAC or asymmetric algorithms are accepted per the `algorithms` option; it defaults to `HS256`.
- The provider **fails closed**: an invalid signature, an expired token, a wrong issuer, a wrong audience, or a malformed string all return `undefined` rather than throwing.
- `issuer` and `audience` are validated only when configured. `requireAudience: true` changes that posture: until an audience is configured, every token is rejected — a deliberate fail-closed gate for APIs where accepting tokenless audiences would be unsafe. `audience` accepts a single string or an array.
- `clockTolerance` (in seconds) allows for clock skew between the token issuer and the API host; tokens expired within the tolerance window are accepted.
- Key material is cached after first use. `shutdown()` clears that cache, is safe to call multiple times, and the provider keeps working afterwards — key material is lazily re-created on the next validation.

### Complete Example

```typescript
import { SignJWT } from 'jose';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const SECRET = 'documentation-example-secret-at-least-32-bytes!';

// A token as your identity provider would issue it (HS256)
const token = await new SignJWT({ sub: 'user-42', scope: 'reports:read reports:export' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .setIssuer('https://auth.example.com')
    .setAudience('https://api.example.com')
    .sign(new TextEncoder().encode(SECRET));

const provider = new JwtAuthProvider({
    secret: SECRET,
    algorithms: ['HS256'],
    issuer: 'https://auth.example.com',
    audience: 'https://api.example.com',
    clockTolerance: 30,
});

const result = await provider.validate(token);
console.log(result?.sub);    // 'user-42'
console.log(result?.scopes); // ['reports:read', 'reports:export']

// Anything that fails signature, expiry, issuer, or audience checks is undefined:
console.log(await provider.validate('not-a-jwt')); // undefined

await provider.shutdown();
```

### Key Methods and Properties

| Option | Type | Description |
| --- | --- | --- |
| `secret` | `string` | **Required.** The HMAC secret used to verify the signature |
| `algorithms` | `string[]` | Accepted algorithms; defaults to `HS256` |
| `issuer` | `string` | Validated against the `iss` claim when set |
| `audience` | `string \| string[]` | Validated against the `aud` claim when set |
| `requireAudience` | `boolean` | When `true`, rejects every token until an audience is configured (fail closed) |
| `clockTolerance` | `number` | Allowed clock skew in seconds |
| base options | `AuthProviderConfig` | `serviceName`, `tokenSources`, `mapClaims`, `principalType`, … |

| Name | Type / Signature | Description |
| --- | --- | --- |
| `constructor` | `(config: JwtAuthConfig)` | Requires `secret` |
| `validate` | `(token: string) => Promise<AuthResult \| undefined>` | Local verification; `undefined` on any claim or signature failure |
| `authenticate` | `(req: Request) => Promise<AuthResult \| undefined>` | Inherited lifecycle: extract from the request, then verify |
| `health` | `() => Promise<boolean>` | `true` when a secret is configured |
| `shutdown` | `() => Promise<void>` | Clears cached key material; provider remains usable |

---

## IntrospectionAuthProvider

### What It Is

`IntrospectionAuthProvider` validates opaque access tokens against an OAuth2 token introspection endpoint per RFC 7662. It POSTs the token to the authorization server, interprets the `active` flag and claims, and caches positive responses — keyed by a SHA-256 digest of the token — to keep the per-request network cost near zero for hot tokens.

### How It Works

- **Request shape**: a POST with a form-urlencoded body containing `token` and `token_type_hint=access_token`, `Content-Type: application/x-www-form-urlencoded` and `Accept: application/json`.
- **Client authentication**: `client_secret_basic` by default — the credentials are RFC 6749 percent-encoded and sent in the `Authorization` header. With `authMethod: 'post'`, the credentials move into the body and the header is omitted.
- **Response handling**: `active: false` (or missing) returns `undefined`; `active: true` with an `exp` in the past returns `undefined`; otherwise the claims are mapped into an `AuthResult`.
- **Audience validation**: when `audience` is configured (string or array), a missing or mismatched audience rejects the token.
- **Caching**: the cache key is a SHA-256 hex digest of the token scoped by the resolved endpoint and client id (`sha256(endpoint + sep + clientId + sep + token)`), so tenants never share entries — the raw token is never stored. The entry TTL is the smaller of `cacheTTL` and the time until the token's `exp`; active responses without `exp` use `cacheTTL`; inactive, already-expired, and failed responses are never cached. Eviction is LRU when `maxCacheSize` is exceeded. The claims mapper runs on every call, including cache hits.
- **Dynamic configuration**: with `configFactory`, credentials and endpoint are resolved per request, so one provider serves many tenants. `validate()` returns `undefined` in that mode (there is no request to resolve against); authentication must go through `authenticate()`. Cache entries are isolated per tenant, and a factory error propagates to the caller. The constructor throws when neither a complete static triple (`introspectionUrl`, `clientId`, `clientSecret`) nor a `configFactory` is supplied.
- **Failure semantics**: a non-2xx response throws an error containing the status code but never the token or secret; network failures propagate; `timeout` (milliseconds) aborts the request.
- `health()` returns `true` whenever the provider is statically configured (no network call is made); `shutdown()` clears the cache.

### Complete Example

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { IntrospectionAuthProvider, createAuthPlugin } from 'blendsdk/webafx-auth';

const provider = new IntrospectionAuthProvider({
    introspectionUrl: 'https://auth.example.com/oauth2/introspect',
    clientId: 'billing-api',
    clientSecret: 'client-secret-from-vault',
    authMethod: 'basic',
    audience: 'https://api.example.com',
    timeout: 3000,
    cacheTTL: 60,
    maxCacheSize: 5000,
});

const app = new WebApplication({ PORT: 3400, ENV_MODE: 'production', LOG_LEVEL: 'ERROR' });
app.use(createAuthPlugin(provider));
await app.start();
```

For per-tenant credentials with `configFactory`, see Multi-Tenant Configurations below.

### Key Methods and Properties

| Option | Type | Description |
| --- | --- | --- |
| `introspectionUrl` | `string` | Introspection endpoint (static triple, part 1) |
| `clientId` | `string` | Client identifier (static triple, part 2) |
| `clientSecret` | `string` | Client secret (static triple, part 3) |
| `configFactory` | `(req: Request) => Promise<IntrospectionAuthConfig>` | Per-request configuration; takes precedence over static config |
| `authMethod` | `'basic' \| 'post'` | Client authentication method; defaults to `'basic'` |
| `audience` | `string \| string[]` | Token is rejected when set and not matched |
| `timeout` | `number` | Abort timeout in milliseconds |
| `cacheTTL` | `number` | Cache lifetime in seconds; clamped to the token's remaining lifetime |
| `maxCacheSize` | `number` | LRU capacity of the response cache |

| Name | Type / Signature | Description |
| --- | --- | --- |
| `constructor` | `(config: IntrospectionProviderConfig)` | Static triple or `configFactory`; throws when neither is complete |
| `validate` | `(token: string) => Promise<AuthResult \| undefined>` | Static config only; `undefined` in factory-only mode |
| `authenticate` | `(req: Request) => Promise<AuthResult \| undefined>` | Resolves per-request config when `configFactory` is set |
| `health` | `() => Promise<boolean>` | `true` when configured; performs no network call |
| `shutdown` | `() => Promise<void>` | Clears the introspection response cache |

---

## OidcAuthProvider

### What It Is

`OidcAuthProvider` is the OIDC workhorse with two jobs. First, it validates bearer JWTs using OIDC discovery and remote JWKS resolution (`openid-client` for discovery, `jose` for verification). Second, and optionally, it powers the browser BFF flow: when configured with a `sessionStore`, `authenticate()` falls back to server-side session-cookie authentication and the provider exposes the session and BFF operations that `OidcAuthController` drives.

### How It Works

- **Dual-mode authentication**: `authenticate()` tries the bearer token first. When a bearer token is present, the session store is never consulted — bearer wins even if a session cookie is also present. Only when no token is found and a `sessionStore` is configured does the provider fall back to the session cookie.
- **Discovery and JWKS**: discovery runs lazily via `openid-client` and is cached per `issuerUrl` for `discoveryTtl` seconds, so multi-tenant issuers each get their own cache slot. The remote JWKS resolver is created once per issuer. `shutdown()` clears the discovery cache.
- **Bearer validation** (`validate()`): static configuration only — with only a `configFactory`, `validate()` returns `undefined`. Verification failures (bad signature, wrong issuer/audience, missing `jwks_uri`, discovery failure) are silent and yield `undefined`. `requireAudience: true` rejects every token when no audience is configured, failing closed before any discovery work. Verification passes `issuer`, `audience` (when set), and `clockTolerance` (default 30 seconds) to `jose.jwtVerify`. On the bearer path, the per-request `resolveUser` hook takes precedence over `mapClaims`; an error thrown by an async `resolveUser` propagates, while a synchronous mapper failure counts as a failed authentication.
- **Session validation**: the session cookie name is resolved per request (default `__oidc_session`); the session is read from the `sessionStore` under `oidc:session:<id>`; `expiresAt` is enforced by the provider itself (honoring `clockTolerance`), not left to the cache TTL. A missing or expired session returns `undefined` — a clean 401. `CacheProvider` failures propagate as infrastructure errors. The session path always reports `principalType: 'user'` and maps `sub` from `session.user.sub`, claims from the full user object, `token` from the access token, and `exp` from `expiresAt`.
- **BFF and session operations** are the methods `OidcAuthController` calls on every login, callback, refresh, and logout; they need static config (or an explicit per-call override) and throw a descriptive error when `issuerUrl`/`clientId` are absent — e.g. in factory-only mode.
- `health()` returns `true` only when static config is present and discovery succeeds; factory-only providers report `false`. Token operations (`exchangeCode`, `refreshToken`, `revokeToken`, `fetchUserInfo`) throw when misconfigured and propagate `openid-client` errors.

### Complete Example

Bearer-token mode with fail-closed audience validation:

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { OidcAuthProvider, createAuthPlugin } from 'blendsdk/webafx-auth';

const provider = new OidcAuthProvider({
    issuerUrl: 'https://auth.example.com',
    clientId: 'web-app',
    clientSecret: 'client-secret-from-vault',
    audience: 'https://api.example.com',
    requireAudience: true,
    discoveryTtl: 300,
});

const app = new WebApplication({ PORT: 3400, ENV_MODE: 'production', LOG_LEVEL: 'ERROR' });
app.use(createAuthPlugin(provider));
await app.start();
```

With `sessionStore` omitted, only bearer JWTs are accepted. To add browser sign-in, configure a `sessionStore` and register the controller — see the OidcAuthController section below.

### Key Methods and Properties

Configuration options (a selection of the most important `OidcAuthConfig` fields):

| Option | Type | Default / Notes |
| --- | --- | --- |
| `issuerUrl` | `string` | Required unless `configFactory` is used |
| `clientId` / `clientSecret` | `string` | Client credentials for discovery and BFF operations |
| `redirectUri` | `string` | Required by `buildAuthorizationUrl` |
| `scopes` | `string[]` | Defaults to `['openid', 'profile', 'email']` |
| `audience` | `string \| string[]` | Passed to `jwtVerify` when set |
| `requireAudience` | `boolean` | Fail closed when no audience is configured |
| `clockTolerance` | `number` | Defaults to 30 seconds |
| `discoveryTtl` | `number` | Discovery cache lifetime in seconds |
| `configFactory` | `(req: Request) => Promise<OidcAuthConfig>` | Per-request configuration |
| `sessionStore` | `CacheProvider` | Enables session-cookie mode and BFF session operations |
| `sessionTtl` / `stateTtl` | `number` | Defaults: 3600 / 300 seconds |
| `sessionCookieTtl` | `number` | Cookie lifetime; falls back to `sessionTtl`, then 3600 |
| `rotateSessionIdOnRefresh` | `boolean` | Defaults to `false` |
| `resolveSessionCookieName` / `resolveStateCookieName` | `(req: Request) => string` | Defaults: `__oidc_session` / `__oidc_state` |
| `resolveUser` | async per-request mapper | Takes precedence over `mapClaims` on the bearer path |

| Name | Type / Signature | Description |
| --- | --- | --- |
| `constructor` | `(config: OidcAuthConfig)` | Throws when neither `issuerUrl` nor `configFactory` is provided |
| `validate` | `(token: string) => Promise<AuthResult \| undefined>` | Static config only; silent failure on verification errors |
| `authenticate` | `(req: Request) => Promise<AuthResult \| undefined>` | Bearer first, session-cookie fallback when `sessionStore` is set |
| `health` | `() => Promise<boolean>` | `true` only with static config and successful discovery |
| `shutdown` | `() => Promise<void>` | Clears the discovery cache |

| Name | Type / Signature | Description |
| --- | --- | --- |
| `buildAuthorizationUrl` | `(configOverride?: OidcAuthConfig, params?: BuildAuthorizationUrlParams) => Promise<AuthorizationUrlResult>` | Builds the IdP URL with PKCE challenge, state, and nonce; returns `{ url, codeVerifier, state, nonce }` |
| `exchangeCode` | `(params: ExchangeCodeParams, configOverride?: OidcAuthConfig) => Promise<OidcTokens>` | Exchanges the callback code, validating PKCE verifier and expected nonce |
| `refreshToken` | `(refreshToken: string, configOverride?: OidcAuthConfig) => Promise<OidcTokens>` | Refreshes the token set |
| `revokeToken` | `(token: string, tokenTypeHint?: string) => Promise<void>` | Best-effort RFC 7009 revocation |
| `fetchUserInfo` | `(accessToken: string, subject?: string) => Promise<Record<string, unknown>>` | UserInfo request; omitting the subject skips the subject check |
| `storeSession` / `getSession` / `clearSession` | `(id: string, …) => Promise<…>` | Session CRUD under `oidc:session:<id>`; throws without `sessionStore` |
| `storeState` / `getState` / `clearState` | `(id: string, …) => Promise<…>` | Transient PKCE/CSRF state under `oidc:state:<id>` |
| `getSessionCookieName` / `getStateCookieName` | `(req: Request) => string` | Effective cookie names, honoring the resolvers |
| `getSessionCookieTtl` | `() => number` | Session cookie lifetime in seconds (`sessionCookieTtl` → `sessionTtl` → 3600) |
| `shouldRotateSessionIdOnRefresh` | `() => boolean` | Whether refresh rotates the session id |
| `getRedirectUri` | `() => string \| undefined` | The configured redirect URI |

The session model used by the BFF flow:

| Type | Fields | Purpose |
| --- | --- | --- |
| `OidcTokens` | `accessToken`, `tokenType`, `expiresIn?`, `refreshToken?`, `idToken?`, `scope?` | Normalized token-endpoint response |
| `OidcSession` | `accessToken`, `user`, `expiresAt?`, `refreshToken?`, `idToken?`, `organizationSlug?` | Server-side session record |
| `OidcSessionState` | `codeVerifier`, `state`, `nonce`, `returnTo?` | Transient login state (PKCE, CSRF, nonce, redirect target) |

---

## OidcAuthController — The Browser Login Flow

### What It Is

`OidcAuthController` is the backend-for-frontend (BFF) controller that implements the OIDC authorization-code flow with PKCE. It exposes five routes, keeps tokens entirely on the server, and hands the browser nothing but opaque, httpOnly session cookies — so no cookie signing secret or token ever reaches the client.

### How It Works

- **Provider resolution**: the controller resolves its `OidcAuthProvider` from the WebAFX service container via `getProvider(req)`, which looks up the service named by `getProviderServiceName()` (default `'auth'` — the default plugin service name). If you register the plugin under a custom `serviceName`, override `getProviderServiceName()` or `getProvider()` in a subclass.
- **Routes** live under `getRoutePrefix()` (default `/api/oidc`). The login and callback routes are public; `/me` runs behind the authentication guard; logout and refresh validate the opaque session cookie inside their handlers, so a session with an expired access token can still refresh or log out.
- **Cookies** are opaque UUIDs, never signed payloads, so no signing secret is needed. Both cookies are `httpOnly`, `sameSite: 'lax'`, `path: '/'`, and `secure` in production. The state cookie expires after 5 minutes; the session cookie lifetime comes from `provider.getSessionCookieTtl()`.
- **Login**: builds the authorization URL (PKCE challenge, state, nonce) via the provider, stores the transient state under a fresh UUID through `provider.storeState()`, and redirects. The `prompt` and `login_hint` query parameters are forwarded to the IdP; any other query parameter is ignored. Override `getLoginParams(req)` to force extra authorization parameters.
- **Callback**: verifies the state parameter against the stored state (CSRF protection), exchanges the code — forwarding the RFC 9207 `iss` parameter when the IdP sends it — fetches UserInfo, runs the `onCallback` hook, stores the session via `provider.storeSession()`, sets the session cookie, clears the state, and redirects to `returnTo` (or `/`). Error paths return structured 400 responses.
- **Logout**: runs the `onLogout` hook, attempts best-effort token revocation, clears the session and cookie, and responds `200` with `{ success: true, data: { message: 'Logged out' } }`. It is idempotent — logging out without a session still succeeds. Revocation failures are swallowed.
- **Me**: returns `{ success: true, data: { user, expiresAt } }` — never tokens. Without a session it responds `401` with code `no_session`.
- **Refresh**: `401` when the session is missing, `400` when it has no refresh token. On success the access token is updated, the old refresh token is preserved if the response omits a new one, the session is stored, and the cookie is re-issued with the same id. With `rotateSessionIdOnRefresh: true`, the session is moved to a fresh UUID (store new → delete old → set cookie); any failure leaves the original session and cookie untouched.
- **Hooks**: there are no abstract methods — a subclass overrides only the hooks it needs. `resolveOrganization(req)` returns an organization slug that is recorded on the stored session.

### Complete Example

A minimal subclass overriding the route prefix and enriching the callback, wired into a WebAFX application:

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { CacheProvider } from 'blendsdk/webafx-cache';
import {
    OidcAuthController,
    OidcAuthProvider,
    createAuthPlugin,
} from 'blendsdk/webafx-auth';
import type { OidcTokens } from 'blendsdk/webafx-auth';

class AppAuthController extends OidcAuthController {
    protected getRoutePrefix(): string {
        return '/auth/oidc';
    }

    protected async onCallback(
        tokens: OidcTokens,
        userInfo: Record<string, unknown>,
    ): Promise<{ tokens: OidcTokens; userInfo: Record<string, unknown> }> {
        return {
            tokens,
            userInfo: { ...userInfo, tenantId: 'acme' },
        };
    }
}

export function createAuthApp(sessionStore: CacheProvider): WebApplication {
    const provider = new OidcAuthProvider({
        issuerUrl: 'https://auth.example.com',
        clientId: 'web-app',
        clientSecret: 'client-secret-from-vault',
        redirectUri: 'https://app.example.com/auth/oidc/callback',
        sessionStore,
        sessionTtl: 3600,
        sessionCookieTtl: 7200,
        rotateSessionIdOnRefresh: true,
    });

    const app = new WebApplication({
        PORT: 3400,
        ENV_MODE: 'production',
        LOG_LEVEL: 'ERROR',
    });

    app.use(createAuthPlugin(provider));
    app.registerController('', AppAuthController);

    return app;
}
```

Pass the `CacheProvider` instance for your deployment from the composition root — it comes from `blendsdk/webafx-cache`.

### Key Methods and Properties

| Route (default prefix `/api/oidc`) | Method | Secure | Purpose |
| --- | --- | --- | --- |
| `/api/oidc/login` | GET | no | Start login; redirect to the IdP with PKCE, state, and nonce |
| `/api/oidc/callback` | GET | no | Complete login; exchange the code, store the session, set the cookie |
| `/api/oidc/logout` | POST | self-validating | Revoke (best effort) and clear the session |
| `/api/oidc/me` | GET | yes | Return the current user and session expiry — never tokens |
| `/api/oidc/refresh` | POST | self-validating | Refresh tokens; optionally rotate the session id |

Callback error codes:

| Code | HTTP | Condition |
| --- | --- | --- |
| `oidc_error` | 400 | The IdP returned an `error` response |
| `missing_code` | 400 | No authorization code in the callback query |
| `missing_state` | 400 | No state cookie, or the state is no longer stored (expired) |
| `invalid_state` | 400 | State parameter mismatch — possible CSRF |

| Hook | Signature | Description |
| --- | --- | --- |
| `getRoutePrefix` | `() => string` | Route prefix; default `'/api/oidc'` |
| `getProviderServiceName` | `() => string` | Provider service name; default `'auth'` |
| `getProvider` | `(req: Request) => Promise<OidcAuthProvider>` | Resolves the provider from the service container |
| `getLoginParams` | `(req: Request) => BuildAuthorizationUrlParams` | Extra authorization parameters (e.g. forced `prompt`, `acr_values`) |
| `onCallback` | `(tokens, userInfo, req, res) => Promise<{ tokens, userInfo }>` | Runs before the session is stored; can enrich or override both |
| `onLogout` | `(req: Request, res: Response) => Promise<void>` | Runs before the session is cleared |
| `resolveOrganization` | `(req: Request) => string \| undefined` | Organization slug recorded on the session (`organizationSlug`) |

---

## Auth Plugins — createAuthPlugin and Convenience Factories

### What It Is

`createAuthPlugin(provider, options?)` adapts **any** `AuthProvider` — including your own subclasses — into a WebAFX plugin definition. Four convenience factories (`jwtAuthPlugin`, `introspectionAuthPlugin`, `oidcAuthPlugin`, `memoryAuthPlugin`) compose provider construction with the same plugin registration.

### How It Works

- The plugin definition carries `name: 'auth:<serviceName>'` (default `'auth:auth'`), a `priority` (default `DEFAULT_PLUGIN_PRIORITY`, `10`), and an async `factory` that WebAFX invokes during `app.use(...)`.
- The factory calls the application's service registration twice:
  1. a **singleton** service under `serviceName` (default `'auth'`) that resolves to the shared provider instance itself; and
  2. a **per-request** service under `userServiceName` (default `'user'`) that awaits `provider.authenticate(req)` and resolves to `AuthResult | undefined` — `undefined` for unauthenticated requests.
- Installation is reported through the WebAFX logger with the provider class name and the service name.
- The factory returns an object exposing `health()` and `shutdown()` that delegate to the provider, so the WebAFX health endpoint and shutdown lifecycle cover the provider automatically.
- Plugin names must be unique per application. A second plugin with the same name is rejected at startup — `Plugin "auth:auth" is already registered` — so two providers never silently replace each other. Register multiple providers with distinct `serviceName` values.
- The convenience factories construct a provider from a config object and delegate to `createAuthPlugin`, forwarding `AuthPluginOptions` unchanged.

### Complete Example

A memory-backed provider, registered with custom options, plus a protected route reading the per-request principal:

```typescript
import { BaseController, WebApplication } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { createAuthPlugin, MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const provider = new MemoryAuthProvider({
    validTokens: {
        'valid-token': { sub: 'user-1', claims: { role: 'admin' }, token: 'valid-token' },
    },
});

const app = new WebApplication({ PORT: 3400, ENV_MODE: 'development', LOG_LEVEL: 'ERROR' });

app.use(
    createAuthPlugin(provider, {
        serviceName: 'auth',
        userServiceName: 'user',
        priority: 10,
    })
);

class WhoamiController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated()
                .get('/whoami')
                .handle(async (req, res) => {
                    const user = await req.services.get<AuthResult>('user', undefined);
                    this.ok(res, { sub: user?.sub, scopes: user?.scopes });
                }),
        ];
    }
}

app.registerController('', WhoamiController);
await app.start();
```

### Key Methods and Properties

`AuthPluginOptions`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `serviceName` | `string` | `'auth'` (`DEFAULT_SERVICE_NAME`) | Singleton provider service name; the plugin name becomes `auth:<serviceName>` |
| `userServiceName` | `string` | `'user'` | Per-request principal service name |
| `priority` | `number` | `10` (`DEFAULT_PLUGIN_PRIORITY`) | WebAFX plugin ordering priority |

Convenience factories — each builds its provider and delegates to `createAuthPlugin`:

| Factory | Provider built | Signature |
| --- | --- | --- |
| `jwtAuthPlugin` | `JwtAuthProvider` | `(config: JwtAuthConfig, options?: AuthPluginOptions) => PluginDefinition` |
| `introspectionAuthPlugin` | `IntrospectionAuthProvider` | `(config: IntrospectionProviderConfig, options?: AuthPluginOptions) => PluginDefinition` |
| `oidcAuthPlugin` | `OidcAuthProvider` | `(config: OidcAuthConfig, options?: AuthPluginOptions) => PluginDefinition` |
| `memoryAuthPlugin` | `MemoryAuthProvider` | `(config: MemoryAuthConfig, options?: AuthPluginOptions) => PluginDefinition` |

| Name | Type / Signature | Description |
| --- | --- | --- |
| `createAuthPlugin` | `(provider: AuthProvider, options?: AuthPluginOptions) => PluginDefinition` | Adapts any provider to the WebAFX plugin contract |

---

## The createAuthProvider Factory

### What It Is

`createAuthProvider()` selects a concrete provider from a single `AuthFactoryConfig` discriminated by its `type` field. It is the configuration-driven counterpart to the convenience plugin factories: the factory builds the provider, and `createAuthPlugin()` registers it.

### How It Works

- The factory dispatches on `config.type` — `'jwt'`, `'introspection'`, `'oidc'`, or `'memory'` — and validates the fields the chosen provider requires.
- Missing required fields produce a **field-specific error at startup** rather than a failure at the first request: `createAuthProvider: type 'jwt' requires 'secret'`, `createAuthProvider: type 'oidc' requires 'issuerUrl'`, and `createAuthProvider: type 'introspection' requires 'introspectionUrl', 'clientId' and 'clientSecret', or 'configFactory'`.
- Shared fields (`serviceName`, `tokenSources`, `cookieName`, `queryParamName`, `mapClaims`, `principalType`) are forwarded to every provider, as are provider-specific options such as `authMethod`, `validTokens`, and `requireAudience`.
- The result is a plain `AuthProvider` instance — usable directly, or wrapped by `createAuthPlugin` with custom service names.

### Complete Example

A machine-token provider configured entirely from its factory object:

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { createAuthProvider, createAuthPlugin } from 'blendsdk/webafx-auth';

const provider = createAuthProvider({
    type: 'introspection',
    introspectionUrl: 'https://auth.example.com/oauth2/introspect',
    clientId: 'billing-api',
    clientSecret: 'client-secret-from-vault',
    principalType: 'client',
});

const app = new WebApplication({ PORT: 3400, ENV_MODE: 'production', LOG_LEVEL: 'ERROR' });
app.use(createAuthPlugin(provider, { serviceName: 'client-auth', userServiceName: 'client' }));
await app.start();
```

### Key Methods and Properties

Dispatch table:

| `type` | Required fields | Provider constructed |
| --- | --- | --- |
| `'jwt'` | `secret` | `JwtAuthProvider` |
| `'introspection'` | `introspectionUrl` + `clientId` + `clientSecret`, or `configFactory` | `IntrospectionAuthProvider` |
| `'oidc'` | `issuerUrl` (or `configFactory`) | `OidcAuthProvider` |
| `'memory'` | — | `MemoryAuthProvider` |

| Name | Type / Signature | Description |
| --- | --- | --- |
| `createAuthProvider` | `(config: AuthFactoryConfig) => AuthProvider` | Builds the provider selected by `config.type`; throws a field-specific error when a required option is missing |

---

## Multi-Tenant Configurations

### What It Is

Multi-tenancy means one application instance serves principals whose credentials, issuers, or cookies differ per tenant. The package supports this without a tenant-specific provider class: per-request configuration factories, tenant-scoped cookie names, per-tenant caching, and org-scoped sessions.

### How It Works

- **Per-request configuration** is provided by `configFactory` on `IntrospectionAuthProvider` and `OidcAuthProvider`, and by the `configFactory` field of `createAuthProvider`'s introspection path. The factory runs on `authenticate()` for every request that carries a token, resolving endpoints and credentials — typically from headers such as `x-tenant-id`.
- **Cache isolation**: introspection cache entries are scoped per tenant, so the same opaque token validated for two tenants results in two introspection calls — one credential set never reuses another tenant's verdict. OIDC discovery is cached per `issuerUrl`, so each tenant issuer refreshes independently.
- **Tenant-scoped cookies**: `resolveSessionCookieName` and `resolveStateCookieName` derive cookie names per request (for example `__oidc_session_acme`), so multiple tenants can hold sessions in the same browser without collisions. On the controller side, `resolveOrganization(req)` records an organization slug on each stored session (`organizationSlug`).
- **Multiple providers side by side**: install several plugins with distinct `serviceName` values and `userServiceName` values, and let each route require the principal service it needs (see Principal Discrimination and Auth Plugins above).
- **Delegation contracts**: the package exports `TenantAuthConfig`, `TenantResolver`, and `TenantProviderFactory` as configuration contracts for delegating authentication to tenant-resolved providers. Note that no concrete tenant provider ships with this package — applications either use `configFactory` or compose multiple plugins.

### Complete Example

Per-tenant introspection credentials resolved from a request header:

```typescript
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';

const tenantCredentials: Record<string, { clientId: string; clientSecret: string }> = {
    acme: { clientId: 'client-acme', clientSecret: 'secret-acme' },
    globex: { clientId: 'client-globex', clientSecret: 'secret-globex' },
};

const provider = new IntrospectionAuthProvider({
    configFactory: async (req) => {
        const tenant = String(req.headers['x-tenant-id'] ?? 'acme');
        const credentials = tenantCredentials[tenant];
        if (!credentials) {
            throw new Error(`Unknown tenant: ${tenant}`);
        }
        return {
            introspectionUrl: `https://${tenant}.auth.example.com/oauth2/introspect`,
            ...credentials,
        };
    },
});
```

Tenant-scoped OIDC cookie names (fragment):

```typescript
// Each tenant gets its own session and state cookies in the same browser (fragment)
const provider = new OidcAuthProvider({
    issuerUrl: 'https://auth.example.com',
    clientId: 'web-app',
    resolveSessionCookieName: (req) =>
        `__oidc_session_${String(req.headers['x-tenant-id'] ?? 'default')}`,
    resolveStateCookieName: (req) =>
        `__oidc_state_${String(req.headers['x-tenant-id'] ?? 'default')}`,
});
```

### Key Methods and Properties

| Mechanism | Where it lives | Purpose |
| --- | --- | --- |
| `configFactory` | `IntrospectionAuthProvider`, `OidcAuthProvider`, `AuthFactoryConfig` (introspection) | Resolve endpoints and credentials per request |
| `resolveSessionCookieName` / `resolveStateCookieName` | `OidcAuthProvider` | Tenant-scoped session and state cookies |
| `resolveOrganization` | `OidcAuthController` | Record the organization slug on stored sessions |
| Distinct `serviceName` / `userServiceName` pairs | `createAuthPlugin` | Run multiple providers and principal kinds side by side |
| `TenantAuthConfig`, `TenantResolver`, `TenantProviderFactory` | Type exports | Delegation contracts for tenant-resolved providers; no implementation shipped |

---

# webafx-auth Basic Usage

This guide takes you from installation to a working, authenticated WebAFX route. It uses the package's public API only and builds up complexity one concept at a time — provider basics, token extraction, plugin registration, production backends, result shaping, and lifecycle. For architecture and design rationale, see the overview document.

---

## Installation

Install the package with npm or yarn:

```bash
npm install blendsdk/webafx-auth
# or
yarn add blendsdk/webafx-auth
```

The provider classes work with any Express-compatible request and carry only two runtime dependencies (`jose` and `openid-client`). To use the plugin factories — the WebAFX integration this guide builds up to — install the WebAFX runtime alongside:

```bash
npm install blendsdk/webafx
```

OIDC server-side sessions additionally use `blendsdk/webafx-cache` as the session store:

```bash
npm install blendsdk/webafx-cache
```

Both of the latter packages are declared as **optional peer dependencies**: installing `blendsdk/webafx-auth` never forces them, but they are required for the corresponding features (plugin registration and the OIDC browser flow). The package targets Node.js 22 or later and is ESM-only, shipping its own TypeScript declarations.

---

## Quick Start

The smallest way to put authentication in front of a WebAFX application:

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { jwtAuthPlugin } from 'blendsdk/webafx-auth';

const app = new WebApplication({ PORT: 3400, ENV_MODE: 'development', LOG_LEVEL: 'ERROR' });

app.use(jwtAuthPlugin({ secret: 'a-development-only-secret-at-least-32-bytes!' }));

await app.start();
```

This registers JWT bearer authentication for the whole application: requests carrying a valid `Authorization: Bearer <jwt>` (HS256-signed with the configured secret) produce an authenticated principal; all other requests are anonymous. The Fundamentals sections below build this setup up piece by piece — protecting a route, where the token is read from, and how to swap the JWT check for another backend.

---

## Fundamentals

### 1. Create a provider and validate a token

Every backend implements the same contract, inherited from the abstract `AuthProvider` base class:

- `validate(token)` — verifies one raw token string and returns an `AuthResult`, or `undefined` when the token is missing, malformed, or expired.
- `authenticate(req)` — the full request lifecycle: extract the token from the request, then validate it.

`MemoryAuthProvider` is the simplest provider: it resolves tokens from a `Map` you define. That makes it the natural first contact — and the standard test double for auth-dependent code.

```typescript
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const provider = new MemoryAuthProvider({
    validTokens: {
        'demo-token': {
            sub: 'user-1',
            claims: { role: 'admin' },
            token: 'demo-token',
        },
    },
});

const result: AuthResult | undefined = await provider.validate('demo-token');

const rejected: AuthResult | undefined = await provider.validate('stale-token');
```

`provider.validate('demo-token')` resolves to an `AuthResult` describing the principal; a token nobody registered resolves to `undefined`. Note that second outcome carefully: **a rejected token is a normal, expected result, not an exception.** Only infrastructure failures (network, DNS) throw — the Error Handling section covers the distinction.

The `AuthResult` carries:

| Field | Type | Description |
| --- | --- | --- |
| `sub` | `string` | Subject identifier of the authenticated principal |
| `claims` | `Record<string, unknown>` | Raw claims exactly as the backend reported them |
| `token` | `string` | The original token string |
| `exp` | `number \| undefined` | Expiration, in seconds since the Unix epoch |
| `scopes` | `string[] \| undefined` | Permissions extracted from `scope`/`scopes` claims |
| `principalType` | `'user' \| 'client' \| undefined` | Optional principal classification (see subsection 5) |

In a real deployment you rarely call `validate()` yourself — the next sections wire the provider into the request flow.

### 2. Control where the token is read from

`authenticate(req)` starts by extracting the token from the request. The extraction chain is configured with `tokenSources` — an **ordered list in which the first non-empty match wins**:

```typescript
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';

const provider = new MemoryAuthProvider({
    tokenSources: ['header', 'cookie', 'query'],
    cookieName: 'auth_token',
    queryParamName: 'token',
});
```

| Source | Reads from | Default name |
| --- | --- | --- |
| `'header'` | `Authorization: Bearer <token>` | — |
| `'cookie'` | the request cookie named by `cookieName` | `'auth_token'` |
| `'query'` | the query parameter named by `queryParamName` | `'token'` |
| `{ extractor }` | a custom `(req) => string \| undefined` function | — |

The configuration above tries the `Authorization` header first, falls back to the `auth_token` cookie (browsers cannot always set headers), and finally falls back to the `token` query parameter (useful for webhook callbacks and SSE endpoints). WebAFX's core middleware includes cookie parsing, so `req.cookies` is populated in WebAFX applications.

**Next level:** any request location can participate via a custom extractor. Here the standard header is still tried first; if it carries no token, the extractor reads an API-key header instead:

```typescript
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { TokenSource } from 'blendsdk/webafx-auth';

const apiKeySource: TokenSource = {
    extractor: (req) => {
        const apiKey = req.headers['x-api-key'];
        return typeof apiKey === 'string' ? apiKey : undefined;
    },
};

const provider = new MemoryAuthProvider({
    tokenSources: ['header', apiKeySource],
});
```

The chain is also exposed for direct use — `extractToken(req)` returns the first extracted string (or `undefined`) without validating anything:

```typescript fragment
// AuthProvider method — walks the configured chain, first non-empty match wins
extractToken(req: Request): string | undefined
```

### 3. Register the provider with WebAFX

Calling `authenticate(req)` by hand in every handler does not integrate with WebAFX's routing, so the package ships a plugin adapter. `createAuthPlugin(provider)` returns a WebAFX plugin that wires the provider into the service container and exposes the principal per request:

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { MemoryAuthProvider, createAuthPlugin } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

class ProfileController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated()
                .get('/profile')
                .handle(async (req, res) => {
                    const user = await req.services.get<AuthResult>('user', undefined);
                    this.ok(res, { sub: user?.sub, scopes: user?.scopes ?? [] });
                }),
        ];
    }
}

const auth = new MemoryAuthProvider({
    validTokens: {
        'demo-token': { sub: 'user-1', claims: { role: 'admin' }, token: 'demo-token' },
    },
});

const app = new WebApplication({ PORT: 3400, ENV_MODE: 'development', LOG_LEVEL: 'ERROR' });
app.use(createAuthPlugin(auth));
app.registerController('', ProfileController);
await app.start();
```

With the app running, the route answers for the known token and rejects everything else:

```bash
curl -H "Authorization: Bearer demo-token" http://localhost:3400/profile
# 200 — the handler reads the principal from the 'user' service
# omit the header → 401 on the authenticated route
```

What the plugin registers:

| Service | Kind | Resolves to |
| --- | --- | --- |
| `auth` | singleton | the exact `AuthProvider` instance you passed in |
| `user` | per-request | `AuthResult \| undefined`, produced by calling `provider.authenticate(req)` |

A route built with `this.authenticated()` is only reachable by authenticated requests: when the principal resolves to `undefined`, WebAFX responds `401` before the handler runs.

**Next level:** rename the services or change plugin ordering through `AuthPluginOptions`:

```typescript fragment
app.use(createAuthPlugin(auth, {
    serviceName: 'jwt-auth',        // singleton service; plugin name becomes 'auth:jwt-auth'
    userServiceName: 'currentUser', // per-request principal service
    priority: 5,                    // plugin ordering within WebAFX (default 10)
}));
```

Distinct `userServiceName` values are how one application runs two providers side by side: a route selects its provider by naming the principal service it requires, for example `.secure('client')`. Registering a second plugin with the same `serviceName` fails at startup (`Plugin "auth:auth" is already registered`) instead of silently replacing the first provider.

### 4. Move from the test double to a real backend

`MemoryAuthProvider` keeps tokens in memory, so it is meant for tests and local development. Production uses one of three real backends — and because they all derive from `AuthProvider`, swapping one in changes nothing about the plugin or your routes:

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const auth = new JwtAuthProvider({
    secret: 'a-production-secret-loaded-from-config-1234',
    issuer: 'https://auth.example.com',
    audience: 'my-api',
    requireAudience: true,
});
```

```typescript fragment
app.use(createAuthPlugin(auth));
```

| Provider | Validates tokens against | Choose it when |
| --- | --- | --- |
| `MemoryAuthProvider` | an in-memory `validTokens` map | testing or local development only |
| `JwtAuthProvider` | the signature itself, locally, via `jose` | the issuer hands out JWTs you can verify offline |
| `IntrospectionAuthProvider` | an RFC 7662 introspection endpoint | tokens are opaque, or they must be checked against the authorization server |
| `OidcAuthProvider` | the issuer's JWKS (via OIDC discovery), with an optional server-side session fallback | you use OIDC — bearer validation and/or the browser login flow |

For the JWT provider, `issuer` and `audience` (string or array) are enforced when configured, and `requireAudience: true` makes the audience check mandatory — with no audience configured, every token is rejected (fail closed). `clockTolerance` accepts small clock skew, in seconds.

**Next level:** `createAuthProvider()` builds any of the four providers from a single config object and fails fast, at startup, when a required option for the selected `type` is missing:

```typescript
import { createAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthFactoryConfig } from 'blendsdk/webafx-auth';

const config: AuthFactoryConfig = {
    type: 'introspection',
    introspectionUrl: 'https://auth.example.com/oauth2/introspect',
    clientId: 'my-api',
    clientSecret: 'my-api-secret',
};

const provider = createAuthProvider(config);
```

```typescript fragment
app.use(createAuthPlugin(provider));
```

Worth knowing about the remote backends:

- The introspection provider caches active results for 60 seconds by default (`cacheTTL`), keyed by a SHA-256 digest of the token — the raw token is never used as a cache key — and clamps the cache TTL to the token's own `exp`.
- Both the introspection and OIDC providers accept a `configFactory(req)` instead of static credentials, the hook for per-request (per-tenant) configuration.
- `OidcAuthProvider` gets its session-cookie fallback only when a `sessionStore` (a `blendsdk/webafx-cache` `CacheProvider`) is configured; without it, it validates bearer tokens only.
- For single-provider setups, the convenience factories `jwtAuthPlugin()`, `introspectionAuthPlugin()`, `oidcAuthPlugin()`, and `memoryAuthPlugin()` combine provider construction with plugin registration in one call.

### 5. Shape the result: claims mapping and principal type

The `AuthResult` your routes receive is produced by a **claims mapper**. The default mapper understands the common OAuth2/JWT formats — `sub` or `subject` for the subject, `exp` for expiry, and `scope` (space-separated string) or `scope`/`scopes` arrays for permissions — and preserves every other claim verbatim in `claims`.

When your issuer uses different claim names, pass your own `mapClaims`:

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';
import type { ClaimsMapper } from 'blendsdk/webafx-auth';

const mapClaims: ClaimsMapper = (token, rawClaims) => ({
    sub: String(rawClaims.user_id ?? rawClaims.sub ?? 'unknown'),
    claims: rawClaims,
    token,
    scopes: Array.isArray(rawClaims.permissions) ? rawClaims.permissions.map(String) : undefined,
});

const auth = new JwtAuthProvider({
    secret: 'a-production-secret-loaded-from-config-1234',
    mapClaims,
});
```

Now `result.sub` comes from the `user_id` claim and `result.scopes` from `permissions`, while `result.claims` still carries the complete claim set.

**Next level:** an application that authenticates both humans and machines sets `principalType` on the machine-facing provider:

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const machineAuth = new JwtAuthProvider({
    secret: 'a-production-machine-secret-12345678',
    principalType: 'client',
});
```

The type is stamped onto every result whose mapper does not already set one — custom mappers and stored results stay authoritative. Combined with a distinct `serviceName`/`userServiceName` per provider, machine routes then require that principal with `.secure('client')`, while human routes keep using the default `user` service.

### 6. Health and shutdown

All providers implement two lifecycle methods in addition to validation:

| Method | Returns | Purpose |
| --- | --- | --- |
| `health()` | `Promise<boolean>` | Is the backend reachable and correctly configured? |
| `shutdown()` | `Promise<void>` | Release resources: cached keys, discovery state, sessions |

```typescript
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';

const provider = new MemoryAuthProvider();

// true for in-memory providers — no external dependency to check
const healthy: boolean = await provider.health();

// Releases the token map; safe to call more than once
await provider.shutdown();
```

`health()` backs the WebAFX health endpoint, and `shutdown()` runs as part of the application shutdown lifecycle — the plugin forwards both to the provider automatically, so you only call them directly when you drive a provider outside WebAFX. `shutdown()` is idempotent; for local providers such as `JwtAuthProvider` it clears cached key material, and the provider lazily rebuilds it if used again.

---

## Configuration

Configuration enters the package at three points:

- **Provider config** — the constructor argument (base `AuthProviderConfig` plus per-provider extensions such as `JwtAuthConfig`, `IntrospectionAuthConfig`, `OidcAuthConfig`, `MemoryAuthConfig`).
- **Plugin options** — the second argument of `createAuthPlugin()` and the convenience plugin factories.
- **Factory config** — a single `AuthFactoryConfig` passed to `createAuthProvider()`.

### Common provider options (`AuthProviderConfig`)

Every provider inherits these options:

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `serviceName` | `string` | `'auth'` (`DEFAULT_SERVICE_NAME`) | Name used for service-container registration |
| `tokenSources` | `TokenSource[]` | `['header']` (`DEFAULT_TOKEN_SOURCES`) | Ordered extraction chain; first non-empty match wins |
| `cookieName` | `string` | `'auth_token'` (`DEFAULT_COOKIE_NAME`) | Cookie read by the `'cookie'` source |
| `queryParamName` | `string` | `'token'` (`DEFAULT_QUERY_PARAM_NAME`) | Query parameter read by the `'query'` source |
| `mapClaims` | `ClaimsMapper` | built-in mapper | Transforms raw claims into an `AuthResult` |
| `principalType` | `'user' \| 'client'` | `undefined` | Stamped onto results that do not already carry a type |

### Plugin options (`AuthPluginOptions`)

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `serviceName` | `string` | `'auth'` | Singleton provider service; the plugin name becomes `auth:<serviceName>` |
| `userServiceName` | `string` | `'user'` | Per-request principal service resolved from `AuthResult \| undefined` |
| `priority` | `number` | `10` (`DEFAULT_PLUGIN_PRIORITY`) | Plugin ordering priority within WebAFX |

### Provider-specific essentials

| Provider | Required options | Notable defaults |
| --- | --- | --- |
| `MemoryAuthProvider` | — | `validTokens: {}` (empty token map) |
| `JwtAuthProvider` | `secret` | `algorithms: ['HS256']`, `requireAudience: false` |
| `IntrospectionAuthProvider` | `introspectionUrl`, `clientId`, `clientSecret` — or `configFactory` | `authMethod: 'basic'`, `cacheTTL: 60` |
| `OidcAuthProvider` | `issuerUrl` — or `configFactory`; `clientId` for BFF methods | `scopes: ['openid', 'profile', 'email']`, `clockTolerance: 30`, `sessionTtl: 3600`, `stateTtl: 300` |

Selected additional options:

- **JWT** — `issuer`, `audience` (string or array), `requireAudience`, `clockTolerance`.
- **Introspection** — `audience`, `timeout`, `maxCacheSize` (LRU eviction), and `authMethod: 'post'` for `client_secret_post` client authentication.
- **OIDC (sessions)** — `sessionStore` (required for session features), `sessionCookieTtl` (falls back to `sessionTtl`), `rotateSessionIdOnRefresh` (default `false`), `discoveryTtl`, and the per-tenant cookie-name resolvers `resolveSessionCookieName` / `resolveStateCookieName`.
- **Dynamic configuration** — `configFactory(req)` on both `IntrospectionAuthProvider` and `OidcAuthProvider` replaces the static credentials per request (for example, per tenant).

### Exported defaults

| Constant | Value | Used for |
| --- | --- | --- |
| `DEFAULT_SERVICE_NAME` | `'auth'` | Provider `serviceName` |
| `DEFAULT_PLUGIN_PRIORITY` | `10` | Plugin `priority` |
| `DEFAULT_COOKIE_NAME` | `'auth_token'` | `'cookie'` token source |
| `DEFAULT_QUERY_PARAM_NAME` | `'token'` | `'query'` token source |
| `DEFAULT_TOKEN_SOURCES` | `['header']` | Provider `tokenSources` |

---

## Error Handling

### Two outcomes, two responses

The package has a deliberately narrow error model:

| Outcome | Provider result | What it means | Typical response |
| --- | --- | --- | --- |
| Token authenticated | `AuthResult` | The backend verified the token | proceed to the handler |
| Token not authenticated | `undefined` | Missing, malformed, expired, inactive, or failing the audience check | `401 Unauthorized` |
| Provider cannot decide | thrown `Error` | Infrastructure failure: endpoint unreachable, non-2xx introspection response, storage failure | `500` / `503` |

The package defines **no custom error classes** — everything thrown is a standard `Error` with a descriptive message. Error messages never contain the token or the client secret (asserted by the introspection test suite).

When you call a provider directly, translate the two outcomes explicitly:

```typescript
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const auth = new IntrospectionAuthProvider({
    introspectionUrl: 'https://auth.example.com/oauth2/introspect',
    clientId: 'my-api',
    clientSecret: 'my-api-secret',
});

let user: AuthResult | undefined;
try {
    user = await auth.validate('opaque-token-from-request');
} catch (error) {
    // Infrastructure failure: the endpoint is unreachable or answered with a
    // non-2xx status. The message includes the status code but never the
    // token or the client secret.
    console.error('Auth backend unavailable:', error);
    throw error;
}

if (user === undefined) {
    // Rejected token — a normal unauthenticated request.
    console.log('Token rejected: respond with 401');
} else {
    console.log(`Authenticated as ${user.sub} (scopes: ${user.scopes?.join(', ') ?? 'none'})`);
}
```

When you use the plugin instead, secured routes handle the first case for you: a rejected token simply leaves the per-request principal `undefined`, and WebAFX answers `401`. Thrown infrastructure errors propagate to your application's error handling.

### Runtime errors

| Error | Raised when |
| --- | --- |
| The underlying network error (e.g. `ECONNREFUSED`) | The auth endpoint cannot be reached |
| `Error` whose message contains the HTTP status (e.g. `500`) | The introspection endpoint answered with a non-2xx status |
| `invalid response body` | The introspection endpoint answered 2xx with a JSON body that is not an object |
| `... sessionStore is required ...` | An OIDC session or state operation ran without a configured `sessionStore` |

### Configuration errors fail fast

Misconfiguration throws immediately — during provider construction, during `createAuthProvider()`, or at plugin registration — so a broken configuration never survives until the first request:

| Thrown message (excerpt) | Raised by |
| --- | --- |
| `Unknown token source: ...` | Provider constructor when `tokenSources` contains an entry that is not `'header'`, `'cookie'`, `'query'`, or `{ extractor }` |
| `createAuthProvider: type 'jwt' requires 'secret'` | `createAuthProvider({ type: 'jwt' })` without a secret |
| `createAuthProvider: type 'oidc' requires 'issuerUrl'` | `createAuthProvider({ type: 'oidc' })` without an issuer |
| `createAuthProvider: type 'introspection' requires 'introspectionUrl', 'clientId' and 'clientSecret', or 'configFactory'` | `createAuthProvider({ type: 'introspection' })` without credentials or a factory |
| `OidcAuthProvider requires either issuerUrl or configFactory` | `new OidcAuthProvider({})` with neither |
| `issuerUrl and clientId are required for <method>` | An OIDC BFF method (`exchangeCode`, `refreshToken`, …) on a provider configured only via `configFactory` |
| `Plugin "auth:auth" is already registered` | A second auth plugin registered with the same `serviceName` |

Because these surface at startup, the most robust strategy is to let the application fail to start on a configuration error — the messages name the offending field, so there is nothing to recover from at runtime.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
