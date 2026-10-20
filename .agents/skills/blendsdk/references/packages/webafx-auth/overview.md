> **Package**: `blendsdk/webafx-auth`

# webafx-auth Overview

---

## What It Is

`blendsdk/webafx-auth` is the token validation and authentication package for WebAFX applications. It defines one abstract `AuthProvider` base class that owns a uniform lifecycle — extract a token from the request, validate it, and return a standardized `AuthResult` (or `undefined`) — and ships four concrete providers: local JWT verification (`JwtAuthProvider`), OAuth2 token introspection per RFC 7662 (`IntrospectionAuthProvider`), OIDC discovery-based validation plus a complete browser sign-in (Backend-for-Frontend) flow (`OidcAuthProvider`), and an in-memory test double (`MemoryAuthProvider`). A plugin layer (`createAuthPlugin()` and per-provider convenience factories) registers a provider with the WebAFX service container so the secure route guard resolves an authenticated principal automatically, and the abstract `OidcAuthController` supplies the five browser-facing routes of the OIDC authorization-code flow with PKCE. It consumes identity protocols — it verifies tokens issued elsewhere and drives sign-in against an external OIDC provider; it is not an authorization server.

---

## Key Features

- **One lifecycle, four providers** — `JwtAuthProvider` (local HMAC/RSA/EC verification via `jose`, no network calls), `IntrospectionAuthProvider` (RFC 7662 opaque-token introspection with a bounded LRU response cache), `OidcAuthProvider` (discovery + JWKS validation with BFF methods), and `MemoryAuthProvider` (token map for tests and local development).
- **Configurable token extraction chain** — `header` (default), `cookie`, `query`, or a custom `{ extractor }` function; tried in order, first match wins.
- **Pluggable claims mapping** — a default mapper normalizes `sub` / `exp` / `scope`; `mapClaims` (all providers) or the async `resolveUser` (OIDC bearer path) overrides it. Results can be stamped with a `principalType` of `'user'` or `'client'`.
- **Silent-failure contract** — an invalid, expired, or missing token resolves to `undefined`, never a thrown error; only infrastructure failures (network, DNS, cache/store errors, rejecting `configFactory`) propagate as exceptions.
- **WebAFX plugin integration** — `createAuthPlugin()` registers the provider as a singleton service (default `'auth'`, priority 10) and a per-request `'user'` factory that calls `provider.authenticate(req)`; options are typed by `AuthPluginOptions`. The plugin delegates `health()` and `shutdown()` to the provider so WebAFX's health endpoint and graceful shutdown manage it. `jwtAuthPlugin()`, `introspectionAuthPlugin()`, `oidcAuthPlugin()`, and `memoryAuthPlugin()` combine provider construction and plugin creation in one call.
- **Provider factory** — `createAuthProvider({ type: 'jwt' | 'introspection' | 'oidc' | 'memory', ... })` selects and validates a provider at startup, throwing a field-specific error message on misconfiguration.
- **Complete OIDC BFF flow** — `OidcAuthController` provides `GET {prefix}/login`, `GET {prefix}/callback`, `POST {prefix}/logout`, `GET {prefix}/me`, and `POST {prefix}/refresh` over a server-side session. PKCE `S256`, state and nonce validation, ID-token signature verification (default on), UserInfo subject verification (OpenID Connect Core §5.3.2), opt-in CSRF enforcement, and opt-in session-id rotation on refresh are built in.
- **Multi-tenant ready** — per-request `configFactory` for OIDC and introspection credentials, org-scoped session/state cookie-name resolvers, and caches keyed per issuer / endpoint + client so tenants never share entries.
- **Typed flow errors** — `OidcCodeExchangeError`, `OidcUserInfoForbiddenError`, and `OidcUserInfoSubjectMismatchError` give callers a stable discriminator; the controller maps them to fixed HTTP responses that never reflect upstream error text.
- **Security defaults** — constant-time CSRF token comparison, SHA-256-hashed introspection cache keys (raw tokens never stored or logged), `returnTo` redirect sanitization, cross-origin credential stripping on redirects, fail-closed `requireAudience`, and secure cookie flags (`httpOnly`, `sameSite=lax`, `secure` in production).
- **Transport controls** — optional custom CA bundle and a development-only `allowInsecureRequests` switch for private or loopback issuers (OIDC).
- **Exported contracts, no tenant provider** — `TenantAuthConfig`, `TenantResolver`, `TenantProviderFactory`, and `AuthProviderLike` describe tenant delegation, but this package does not ship a tenant provider. Defaults are exported as constants (`DEFAULT_SERVICE_NAME`, `DEFAULT_PLUGIN_PRIORITY`, `DEFAULT_COOKIE_NAME`, `DEFAULT_QUERY_PARAM_NAME`, `DEFAULT_TOKEN_SOURCES`).

---

## When To Use

- You are building a **WebAFX backend** and want route authentication through the framework's secure guard with a single `app.use(...)`.
- Your service **issues its own JWTs** (HMAC secret or RSA/EC public key) and you want local, zero-network verification with issuer, audience, and clock-tolerance checks.
- Your authorization server issues **opaque tokens** that must be checked via OAuth2 token introspection (RFC 7662), optionally with database-backed per-tenant credentials.
- You authenticate users with an **OpenID Connect provider** and need both resource-server token validation and a **Backend-for-Frontend browser sign-in** flow — configure `blendsdk/webafx-cache` for session storage.
- You run a **multi-tenant SaaS** where the issuer, endpoints, or client credentials differ per tenant (via `configFactory` and per-request cookie-name resolvers).
- One application must distinguish **multiple principal kinds** — for example human users and machine clients — and route them to different providers using distinct service names and `secure('client')` routes.
- You need **deterministic authentication in tests or local development** without a real identity provider (`MemoryAuthProvider`).
- You want a **custom backend** — extend `AuthProvider` and reuse the extraction chain, claims mapping, plugin, and lifecycle contracts.

---

## Architecture

### Request flow

```text
HTTP request
   │
   ▼
WebAFX plugin layer                                createAuthPlugin(provider)
   ├─ singleton service 'auth'  ─────────────────► the one provider instance
   └─ per-request service 'user' ────────────────► provider.authenticate(req)
   │
   ▼
AuthProvider.authenticate(req)                     base-class template method
   ├─ extractToken(req)   header → cookie → query → custom extractor
   └─ validate(token)     the only method each provider implements
        ├─ JwtAuthProvider           jose.jwtVerify (HMAC / RSA / EC, local)
        ├─ IntrospectionAuthProvider RFC 7662 POST + bounded LRU cache
        ├─ OidcAuthProvider          OIDC discovery + JWKS validation, with a
        │                            server-side session-cookie fallback
        └─ MemoryAuthProvider        token-map lookup (tests / development)
   │
   ▼
AuthResult | undefined                             mapped claims, principalType
   └─ secure guard: defined → route runs; undefined → 401
```

### Design patterns

| Pattern | Where | Purpose |
| --- | --- | --- |
| Template method | `AuthProvider.authenticate()` | Fixes the extract → validate sequence; concrete providers implement only `validate()`, `health()`, and `shutdown()` |
| Strategy | `TokenSource[]`, `ClaimsMapper`, OIDC `resolveUser` | Token lookup order and claim shaping are configuration, not subclassing |
| Factory | `createAuthProvider()`; the four `*AuthPlugin()` helpers | Build a provider or plugin from a discriminated config object |
| Facade / DI registration | `createAuthPlugin()` | Registers provider and principal services into the WebAFX container; delegates health and shutdown |
| Adapter | `mapTokenResponse()`, `tls-fetch.ts`, `oidc-helpers.ts` | Third-party types (`openid-client`, ambient `fetch`) stay behind the package boundary |
| Application-wide singleton | Provider lifecycle | One stateful instance (discovery cache, LRU, in-flight maps) serves all requests |

### Operational characteristics

- **Caching and concurrency** — OIDC discovery is cached per issuer (`discoveryTtl`, default 3600 seconds); introspection responses live in a bounded LRU (`cacheTTL` default 60 seconds, `maxCacheSize` default 1000) keyed by a SHA-256 digest. Concurrent OIDC token refreshes for the same tenant and token are coalesced into a single grant; the coalescing map is process-local, so multi-instance deployments need an external lock.
- **Session model (OIDC BFF)** — browsers hold only opaque UUID cookies (`__oidc_session`, `__oidc_state`); sessions and PKCE transient state are stored in a `blendsdk/webafx-cache` `CacheProvider` under `oidc:session:` / `oidc:state:` keys, with sliding TTL, optional absolute lifetime, and optional session-id rotation on refresh.
- **Lifecycle** — the plugin delegates `health()` and `shutdown()` so WebAFX's health endpoint and graceful shutdown release provider resources (caches, connections) automatically.
- **Multi-provider applications** — plugin name collisions fail fast at startup, so two providers must use distinct `serviceName` values, and each route selects its principal with `secure(principalName)`.

---

## Dependencies

### Runtime dependencies (installed automatically)

| Package | Version | Used by |
| --- | --- | --- |
| `jose` | ^6.2.5 | `JwtAuthProvider` (JWT verification) and `OidcAuthProvider` (remote JWKS, ID-token verification) |
| `openid-client` | ^6.8.4 | `OidcAuthProvider` BFF flow: discovery, authorization-code + PKCE, refresh, revocation, UserInfo |

### Peer dependencies (both declared optional)

| Peer | Required when |
| --- | --- |
| `blendsdk/webafx` | You use the plugin layer (`createAuthPlugin()` and the convenience factories) or `OidcAuthController` — they need the service container, `BaseController`, and secure-guard integration |
| `blendsdk/webafx-cache` | You use OIDC server-side sessions — `OidcAuthProvider` stores sessions and PKCE state through a `CacheProvider` |

Providers used standalone for token validation require neither peer.

### Downstream consumers

- Application code is the primary consumer: WebAFX apps install a plugin and optionally extend `OidcAuthController`.
- Custom backends and tenant-delegating implementations extend `AuthProvider` and the exported tenant contracts.
- The package targets **Node.js >= 22**, is **ESM-only** (`"type": "module"`), and is part of the BlendSDK monorepo (`blendsdk/*` scope).

---

## Minimum Example

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { memoryAuthPlugin, type AuthResult } from 'blendsdk/webafx-auth';

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
app.use(memoryAuthPlugin({
    validTokens: { 'test-token': { sub: 'user-1', claims: {}, token: 'test-token' } },
}));
app.registerController('', ProfileController);

await app.start();
// GET /profile with "Authorization: Bearer test-token"
// → 200 { success: true, data: { sub: 'user-1' } }
// Without the token → the secure guard answers 401.
```

Swapping the provider is a one-line change: replace `memoryAuthPlugin(...)` with `jwtAuthPlugin({ secret })`, `introspectionAuthPlugin({ ... })`, or `oidcAuthPlugin({ ... })` — the controller code stays the same because every provider satisfies the same `AuthProvider` contract.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
