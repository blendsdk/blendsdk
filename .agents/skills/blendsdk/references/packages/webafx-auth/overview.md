> **Package**: `blendsdk/webafx-auth`

# webafx-auth Overview

---

## What It Is

`blendsdk/webafx-auth` is the authentication package of the BlendSDK web runtime. It bridges incoming HTTP requests and an authenticated principal: it extracts a token from the request, validates it against a configurable backend, and exposes the resulting `AuthResult` to WebAFX route handlers through the service container. Four interchangeable providers sit behind one abstract base class — local JWT verification (`JwtAuthProvider`), OAuth2 token introspection per RFC 7662 (`IntrospectionAuthProvider`), OIDC discovery and JWKS validation (`OidcAuthProvider`), and an in-memory test double (`MemoryAuthProvider`). For browser-facing sign-in, the package additionally ships `OidcAuthController`, a backend-for-frontend controller that implements the OIDC authorization code flow with PKCE and stores server-side sessions in a `CacheProvider`. The package is ESM-only, MIT-licensed, and targets Node.js 22 or later.

---

## Key Features

- **One abstraction, four backends** — every provider derives from `AuthProvider` and implements only `validate()`, `health()`, and `shutdown()`; the shared base class handles everything else.
- **Configurable token extraction chain** — ordered sources (`"header"`, `"cookie"`, `"query"`, or a custom `{ extractor }` function); the first non-empty match wins, so fallback strategies are configuration rather than code.
- **Silent-failure semantics** — a missing, malformed, or expired token yields `undefined` (an unauthenticated request, not an error); only infrastructure failures such as network or DNS errors are thrown.
- **Pluggable claims mapping** — the `mapClaims` option (and OIDC's `resolveUser`) transforms raw claims into an `AuthResult`; the default mapper understands `sub`/`subject`, `exp`, and the OAuth2 `scope` string as well as `scope`/`scopes` arrays.
- **First-class WebAFX plugin** — `createAuthPlugin()` registers the provider as a singleton service plus a per-request principal service; `jwtAuthPlugin()`, `introspectionAuthPlugin()`, `oidcAuthPlugin()`, and `memoryAuthPlugin()` wrap provider construction.
- **Startup-validated provider factory** — `createAuthProvider()` builds a provider from a single `AuthFactoryConfig` and throws a field-specific error when a required option for the selected `type` is missing, so misconfiguration fails at startup, not at the first request.
- **Hardened introspection** — RFC 7662 request shape, `client_secret_basic` or `client_secret_post` client authentication, response caching keyed by SHA-256 token digests, LRU eviction, and cache TTL clamped to the token's expiry.
- **Complete OIDC support** — discovery/JWKS caching, dual-mode `authenticate()` (bearer JWT first, session-cookie fallback), BFF routes for login/callback/logout/refresh/me, sliding sessions, optional session-ID rotation on refresh, and RFC 9207 `iss` forwarding.
- **Multi-tenant patterns** — per-request dynamic configuration (`configFactory`), tenant-scoped session and state cookie name resolvers, and tenant delegation contracts (`TenantAuthConfig`, `TenantResolver`, `TenantProviderFactory`); note that the package ships the contracts, not a concrete tenant provider.
- **Principal discrimination** — results optionally carry a `principalType` (`'user'` or `'client'`), letting one application route human sessions and machine tokens through separate providers.
- **Fail-closed audience validation** — `audience` accepts a string or an array; `requireAudience: true` rejects every token when no audience is configured.

---

## When To Use

Use `blendsdk/webafx-auth` when:

- You are building a **WebAFX application** and need to protect routes — the plugin wires authentication into the service container with a single `app.use(...)` call.
- You want to validate **JWTs locally** without a network round trip, including issuer, audience, algorithm, and clock-tolerance controls.
- Your authorization server issues **opaque tokens** that must be validated against an RFC 7662 introspection endpoint, optionally with caching and per-tenant credentials.
- You need **OIDC**, either for bearer-token validation with JWKS discovery or for a complete **browser login flow** backed by server-side sessions.
- A single application must authenticate **different principal kinds** (for example, human users and machine clients) through separate providers.
- Credentials are **per-tenant** and must be resolved on each request rather than at startup.
- You are **testing** auth-dependent code and want deterministic tokens without external infrastructure (`MemoryAuthProvider`).

The provider classes operate on plain Express `Request` objects, so they can be driven directly (`provider.authenticate(req)`) even without the plugin system; the WebAFX runtime is required only for the plugin factories and `OidcAuthController`.

---

## Architecture

### Authentication lifecycle

Every validation follows the same lifecycle, fixed once in the abstract base class and specialized per backend:

```text
HTTP request
     │
     ▼
AuthProvider.authenticate(req)              ← template method on the abstract base class
     │
     ├─ 1. extractToken(req)                ← ordered chain, first match wins
     │        "header" → "cookie" → "query" → { extractor }
     │
     └─ 2. validate(token)                  ← one implementation per provider
              ├─ JwtAuthProvider             local verification via jose (HMAC / RSA)
              ├─ IntrospectionAuthProvider   RFC 7662 call + internal LRU cache
              ├─ OidcAuthProvider            JWKS discovery + session-store fallback
              └─ MemoryAuthProvider          in-memory test double
     │
     ▼
AuthResult | undefined  →  per-request service 'user'  →  route handlers
```

### Token extraction chain

The chain is built at construction time from the `tokenSources` config option:

| Source | Extracts from | Notes |
| --- | --- | --- |
| `"header"` | `Authorization: Bearer <token>` | Default and only entry of `DEFAULT_TOKEN_SOURCES` |
| `"cookie"` | Cookie named by `cookieName` | Default cookie name: `"auth_token"` (`DEFAULT_COOKIE_NAME`) |
| `"query"` | Query parameter named by `queryParamName` | Default parameter: `"token"` (`DEFAULT_QUERY_PARAM_NAME`); useful for callbacks and SSE |
| `{ extractor }` | Custom function `(req) => string \| undefined` | Any other request location, e.g. an API-key header |

### Plugin and service registration

`createAuthPlugin(provider, options?)` adapts any `AuthProvider` into a WebAFX `PluginDefinition`. Its factory registers two services with the application:

- a **singleton** service resolving to the shared `AuthProvider` instance, and
- a **per-request** service resolving to `AuthResult | undefined` for the current request by calling `provider.authenticate(req)`.

The plugin name follows the pattern `auth:<serviceName>`; registering two plugins with the same name is rejected at startup, preventing accidental replacement of one provider by another.

| `AuthPluginOptions` field | Default | Description |
| --- | --- | --- |
| `serviceName` | `"auth"` (`DEFAULT_SERVICE_NAME`) | Name of the singleton provider service; plugin name becomes `auth:<serviceName>` |
| `userServiceName` | `"user"` | Name of the per-request principal service |
| `priority` | `10` (`DEFAULT_PLUGIN_PRIORITY`) | WebAFX plugin ordering priority |

### OIDC browser flow (BFF)

`OidcAuthController` exposes the authorization code flow under a configurable route prefix (default `/api/oidc`):

| Route | Method | Behavior |
| --- | --- | --- |
| `/api/oidc/login` | GET | Builds the IdP authorization URL (PKCE, state, nonce), stores transient state, redirects |
| `/api/oidc/callback` | GET | Exchanges the code, fetches UserInfo, stores the session, sets the session cookie, redirects to `returnTo` |
| `/api/oidc/logout` | POST | Best-effort token revocation; clears session and cookie |
| `/api/oidc/me` | GET | Returns user claims and session expiry (never tokens) |
| `/api/oidc/refresh` | POST | Refreshes tokens, updates the session, optionally rotates the session ID |

### Building blocks

| Layer | Exports | Purpose |
| --- | --- | --- |
| Base class | `AuthProvider` | Shared extraction and lifecycle |
| Providers | `JwtAuthProvider`, `IntrospectionAuthProvider`, `OidcAuthProvider`, `MemoryAuthProvider` | Concrete validation backends |
| Plugin integration | `createAuthPlugin`, `jwtAuthPlugin`, `introspectionAuthPlugin`, `oidcAuthPlugin`, `memoryAuthPlugin`, `AuthPluginOptions` | WebAFX service container wiring |
| Factory | `createAuthProvider`, `AuthFactoryConfig` | Config-driven provider construction |
| Controller | `OidcAuthController` | Browser login flow (BFF) |
| Defaults | `DEFAULT_SERVICE_NAME`, `DEFAULT_PLUGIN_PRIORITY`, `DEFAULT_COOKIE_NAME`, `DEFAULT_QUERY_PARAM_NAME`, `DEFAULT_TOKEN_SOURCES` | Extraction, service, and plugin defaults |
| Core types | `AuthResult`, `PrincipalType`, `AuthProviderConfig`, `TokenSource`, `TokenExtractor`, `ClaimsMapper`, `AuthProviderLike` | Provider contracts |
| OIDC types | `OidcAuthConfig`, `OidcTokens`, `OidcSession`, `OidcSessionState`, `AuthorizationUrlResult`, `BuildAuthorizationUrlParams`, `ExchangeCodeParams` | BFF and session contracts |
| Tenant contracts | `TenantAuthConfig`, `TenantResolver`, `TenantProviderFactory` | Multi-tenant delegation interfaces |

### Design patterns

- **Template method** — `authenticate()` fixes the extract → validate flow in the base class; concrete providers fill in `validate()` only.
- **Abstract base class** — `AuthProvider` centralizes extraction, claims mapping, principal typing, and the `health()`/`shutdown()` contracts.
- **Strategy** — token extraction (`tokenSources`), claims transformation (`mapClaims`, `resolveUser`), per-request configuration (`configFactory`), and cookie naming (`resolveSessionCookieName`, `resolveStateCookieName`) are all injected behaviors.
- **Factory** — `createAuthProvider()` dispatches on a `type` discriminant and validates required fields up front; the convenience factories compose provider construction with plugin registration.
- **Adapter / plugin** — `createAuthPlugin()` adapts any provider to the WebAFX plugin contract (`name`, `priority`, `factory`, `health`, `shutdown`).
- **Singleton + per-request resolution** — one provider instance serves the application; the authenticated principal is resolved per request and read from the service container.

---

## Dependencies

### Runtime dependencies

| Package | Version | Used for |
| --- | --- | --- |
| `jose` | `^6.2.5` | JWT verification (HMAC and asymmetric algorithms) and remote JWKS resolution |
| `openid-client` | `^6.8.4` | OIDC discovery and BFF operations: authorization URL building, code exchange, token refresh, revocation, and UserInfo requests |

### Peer dependencies

Both peer dependencies are **optional** (declared via `peerDependenciesMeta`), so installing the package never forces them:

| Peer | Version | Required for |
| --- | --- | --- |
| `blendsdk/webafx` | `^5.x` | Plugin registration (`createAuthPlugin` and convenience factories) and `OidcAuthController`; the provider classes alone only need an Express-compatible `Request`. |
| `blendsdk/webafx-cache` | `^5.x` | Server-side OIDC sessions (`sessionStore` on `OidcAuthProvider`); without it, the OIDC provider still works for pure bearer-token validation. |

### Depended on by

Within the BlendSDK monorepo this is a leaf package with no internal dependents. It is consumed directly by WebAFX applications that need request authentication, typically installed alongside `blendsdk/webafx` and — when server-side OIDC sessions are used — `blendsdk/webafx-cache`.

### Development tooling

Built with TypeScript `^7.0.2`; tested with Vitest `^4.1.10`, with integration tests using Supertest `^7.2.2` against real WebAFX applications.

---

## Minimum Example

Install JWT authentication, register a protected route, and read the authenticated principal from the per-request `user` service. Requests to `GET /profile` must carry `Authorization: Bearer <jwt>` signed with the configured secret.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { jwtAuthPlugin } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

class ProfileController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated()
                .get('/profile')
                .handle(async (req, res) => {
                    const user = await req.services.get<AuthResult>('user', undefined);
                    this.ok(res, { sub: user?.sub, scopes: user?.scopes });
                }),
        ];
    }
}

const app = new WebApplication({ PORT: 3400, ENV_MODE: 'development', LOG_LEVEL: 'ERROR' });
app.use(jwtAuthPlugin({ secret: 'a-development-only-secret-at-least-32-bytes!' }));
app.registerController('', ProfileController);
await app.start();
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
