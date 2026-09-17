> **Package**: `blendsdk/webafx-auth`

# webafx-auth Advanced Patterns

This document collects advanced composition patterns for `blendsdk/webafx-auth` — the combinations that production applications end up building on top of the four providers, the plugin integration, and the OIDC backend-for-frontend controller. Each pattern is self-contained: the problem it solves, a complete example, why it works, and the caveats and performance considerations you should weigh before adopting it.

Examples that involve HTTP routing assume `blendsdk/webafx` ^5.x; patterns that use server-side OIDC sessions assume `blendsdk/webafx-cache` ^5.x. Both are optional peer dependencies — the provider classes themselves run against plain Express `Request` objects.

## Pattern Index

| # | Pattern | Solves | Primary building blocks |
| --- | --- | --- | --- |
| 1 | Multi-provider routing | Humans and machines in one application | `createAuthPlugin` ×2, `principalType`, route-level principal selection |
| 2 | Environment-driven selection | One codebase, many deployments | `createAuthProvider`, `createAuthPlugin`, startup validation |
| 3 | Per-tenant credentials | Tenant-specific introspection/OIDC backends | `configFactory`, cache isolation, error semantics |
| 4 | OIDC BFF browser login | Browser sign-in without exposing tokens | `OidcAuthController`, `OidcAuthProvider`, `sessionStore`, dual-mode `authenticate()` |
| 5 | Session hardening | Stolen cookies, multi-tab replay, tenant scoping | Session-ID rotation, sliding TTLs, cookie-name resolvers |
| 6 | Claims normalization | Inconsistent IdP claim vocabularies | `mapClaims`, `resolveUser`, `principalType` precedence |
| 7 | Fail-closed audiences | Cross-service token acceptance | `audience`, `requireAudience`, `clockTolerance` |
| 8 | Custom extraction chains | Non-standard token ingress | `tokenSources`, custom `{ extractor }` functions |
| 9 | Testing auth-protected apps | Deterministic, offline test suites | `MemoryAuthProvider`, Supertest, runtime token helpers |
| 10 | Custom provider backend | In-house token formats | `AuthProvider` subclass, `createAuthPlugin` |

---

## Pattern 1: Multi-Provider Routing with Principal Discrimination

**When to use**: one application serves both interactive users and machine clients, and the two token kinds validate against different backends (for example, JWTs for humans, opaque OAuth2 tokens for machines).

A single provider must understand every token that reaches the application. Real deployments rarely have that luxury: the user-facing portal issues JWTs from an OIDC IdP, while the public API hands out opaque tokens that only the authorization server can introspect. Install one plugin per backend, give each plugin distinct service names, and let each route declare which principal kind it accepts.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { jwtAuthPlugin, introspectionAuthPlugin } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing environment variable: ${name}`);
    }
    return value;
}

class PortalController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            // No .secure(...) call: the default principal service ('user') applies.
            this.authenticated()
                .get('/portal/profile')
                .handle(async (req, res) => {
                    const user = await req.services.get<AuthResult>('user', undefined);
                    this.ok(res, { sub: user?.sub, kind: user?.principalType });
                }),
        ];
    }
}

class MachineApiController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            // .secure('client') routes this endpoint through the machine provider.
            this.route()
                .get('/api/orders')
                .secure('client')
                .handle(async (req, res) => {
                    const client = await req.services.get<AuthResult>('client', undefined);
                    this.ok(res, { sub: client?.sub, scopes: client?.scopes });
                }),
        ];
    }
}

export function createApp(): WebApplication {
    const app = new WebApplication({
        PORT: 3400,
        ENV_MODE: 'production',
        LOG_LEVEL: 'INFO',
    });

    // Human traffic: JWTs verified locally, no network round trip per request.
    app.use(
        jwtAuthPlugin(
            {
                secret: requireEnv('JWT_SECRET'),
                issuer: requireEnv('JWT_ISSUER'),
                audience: requireEnv('JWT_AUDIENCE'),
                requireAudience: true,
                principalType: 'user',
            },
            { serviceName: 'user-auth', userServiceName: 'user' }
        )
    );

    // Machine traffic: opaque tokens validated against the RFC 7662 endpoint,
    // cached per token after the first successful introspection.
    app.use(
        introspectionAuthPlugin(
            {
                introspectionUrl: requireEnv('INTROSPECTION_URL'),
                clientId: requireEnv('INTROSPECTION_CLIENT_ID'),
                clientSecret: requireEnv('INTROSPECTION_CLIENT_SECRET'),
                principalType: 'client',
            },
            { serviceName: 'client-auth', userServiceName: 'client' }
        )
    );

    app.registerController('', PortalController);
    app.registerController('', MachineApiController);

    return app;
}
```

**Why this pattern works**

- Each token kind is validated by the backend that understands it: local JWT verification for humans, RFC 7662 introspection for machines — no lowest-common-denominator provider that must cope with both.
- Route intent is explicit. `.secure('client')` binds an endpoint to the machine principal service; routes without it use the default `user` service. The mapping is readable in the controller, not buried in provider code.
- Each plugin stamps `principalType` on its results, so downstream handlers, audit logs, and authorization checks can branch on the principal kind without knowing which plugin authenticated the request.
- Startup collision protection: both plugins must have distinct `serviceName` values, because plugin names follow the pattern `auth:<serviceName>`. Registering a second plugin under a name that is already taken throws at startup (`Plugin "auth:auth" is already registered`) instead of silently replacing the first provider.

**Caveats and performance**

- Give every plugin both a distinct `serviceName` **and** a distinct `userServiceName`. Two plugins resolving principals into the same per-request service name would make route-to-provider routing ambiguous.
- A client token sent to a `user` route — or a user token sent to a `client` route — produces a 401, not a fallback. That is the intended isolation, but it should be covered by tests: assert cross-rejection in both directions for every protected route.
- Introspection costs one network round trip per token (cached afterwards, keyed by a SHA-256 digest of the token). If an endpoint is anonymous-friendly or extremely hot, prefer the JWT backend where the security policy allows it.
- Both plugins default to priority `10`. If authentication must run before or after other plugins in the pipeline, set `priority` explicitly on each `createAuthPlugin`/convenience-factory call.

---

## Pattern 2: Environment-Driven Provider Selection

**When to use**: the same codebase must run in several topologies — in-memory auth in unit tests, local JWT in staging, OIDC or introspection in production — and a misconfigured deployment should fail at startup, not at the first request.

Hand-rolled provider selection tends to degrade the same way everywhere: repeated base options, empty-string fallbacks for missing secrets, and error messages that name a line number instead of the missing field.

**Before** — provider selection hard-coded, base options duplicated, missing configuration silently degrades:

```typescript
// Before: base options repeated per branch and missing secrets become empty
// strings, so the provider constructs successfully and misbehaves later.
const common = { serviceName: 'auth', principalType: 'user' } as const;

const provider =
    process.env.AUTH_TYPE === 'jwt'
        ? new JwtAuthProvider({ ...common, secret: process.env.JWT_SECRET ?? '' })
        : new IntrospectionAuthProvider({
              ...common,
              introspectionUrl: process.env.INTROSPECTION_URL ?? '',
              clientId: process.env.INTROSPECTION_CLIENT_ID ?? '',
              clientSecret: process.env.INTROSPECTION_CLIENT_SECRET ?? '',
          });
```

**After** — one discriminated config, validated up front by `createAuthProvider()`:

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { createAuthProvider, createAuthPlugin } from 'blendsdk/webafx-auth';
import type { AuthFactoryConfig } from 'blendsdk/webafx-auth';

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing environment variable: ${name}`);
    }
    return value;
}

export function authConfigFromEnv(): AuthFactoryConfig {
    const type = requireEnv('AUTH_TYPE');

    switch (type) {
        case 'jwt':
            return {
                type: 'jwt',
                secret: requireEnv('JWT_SECRET'),
                issuer: requireEnv('JWT_ISSUER'),
                audience: requireEnv('JWT_AUDIENCE'),
                requireAudience: true,
                principalType: 'user',
            };
        case 'introspection':
            return {
                type: 'introspection',
                introspectionUrl: requireEnv('INTROSPECTION_URL'),
                clientId: requireEnv('INTROSPECTION_CLIENT_ID'),
                clientSecret: requireEnv('INTROSPECTION_CLIENT_SECRET'),
                principalType: 'client',
            };
        case 'oidc':
            return {
                type: 'oidc',
                issuerUrl: requireEnv('OIDC_ISSUER_URL'),
                clientId: requireEnv('OIDC_CLIENT_ID'),
                clientSecret: requireEnv('OIDC_CLIENT_SECRET'),
                audience: requireEnv('OIDC_AUDIENCE'),
                requireAudience: true,
            };
        case 'memory':
            return { type: 'memory' };
        default:
            throw new Error(`Unknown AUTH_TYPE: ${type}`);
    }
}

export function installAuth(app: WebApplication): void {
    app.use(createAuthPlugin(createAuthProvider(authConfigFromEnv())));
}
```

When a required field for the selected `type` is absent, the factory throws a field-specific error at construction time:

| `type` | Required fields | Startup error when missing |
| --- | --- | --- |
| `'jwt'` | `secret` | `createAuthProvider: type 'jwt' requires 'secret'` |
| `'introspection'` | `introspectionUrl`, `clientId`, `clientSecret` — or `configFactory` | `createAuthProvider: type 'introspection' requires 'introspectionUrl', 'clientId' and 'clientSecret', or 'configFactory'` |
| `'oidc'` | `issuerUrl` | `createAuthProvider: type 'oidc' requires 'issuerUrl'` |
| `'memory'` | — | — |

**Why this pattern works**

- One config object discriminates the variant; the base options (`serviceName`, `tokenSources`, `cookieName`, `queryParamName`, `mapClaims`, `principalType`) are forwarded uniformly to every provider, so behavior does not drift between branches.
- Errors name the missing field exactly — a broken deployment fails during boot with an actionable message instead of serving 401s (or worse, accepting nothing) until someone reads the logs.
- Topology becomes environment data: dev runs `memory`, staging runs `jwt`, production runs `introspection` or `oidc`, and `installAuth()` never changes.
- `createAuthProvider()` composes with `createAuthPlugin()` in a single expression, keeping the wiring readable.

**Caveats and performance**

- The factory validates that fields are *present*, not that they are *correct*. A typo'd but non-empty issuer or URL still fails later — pair this pattern with the `health()` checks exposed through the plugin lifecycle.
- Never allow `type: 'memory'` to be selectable in production; gate it explicitly (for example, throw when `AUTH_TYPE === 'memory'` and the application settings report a production environment).
- For introspection with database-backed credentials, the factory accepts a `configFactory` in place of the static triple — see Pattern 3 for the full multi-tenant variant.
- An empty string fails the factory's presence checks for the guarded fields (they use falsy checks), so `requireEnv` and the factory reinforce each other; keep both.

---

## Pattern 3: Per-Tenant Credentials with configFactory

**When to use**: every tenant validates tokens against its own authorization server — its own introspection URL, client ID, and secret — and those credentials live in a database or secret manager rather than in environment variables.

A static provider configuration cannot express "the credentials depend on the request". Both `IntrospectionAuthProvider` and `OidcAuthProvider` accept a `configFactory` that resolves the configuration per request. The factory's result also scopes the provider's internal cache, so tenants are isolated by construction.

```typescript
import { createAuthPlugin, IntrospectionAuthProvider } from 'blendsdk/webafx-auth';
import type { IntrospectionAuthConfig } from 'blendsdk/webafx-auth';
import type { Request } from 'express';

interface TenantRecord {
    slug: string;
    introspectionUrl: string;
    clientId: string;
    clientSecret: string;
}

// Stand-in for the tenant settings table; a real deployment reads from a database.
const tenants = new Map<string, TenantRecord>([
    [
        'acme',
        {
            slug: 'acme',
            introspectionUrl: 'https://acme.auth.example.com/oauth2/introspect',
            clientId: 'acme-api',
            clientSecret: 'acme-introspection-secret',
        },
    ],
]);

function tenantSlug(req: Request): string {
    const raw = req.headers['x-tenant'];
    return typeof raw === 'string' && raw.length > 0 ? raw : 'default';
}

async function resolveTenantConfig(req: Request): Promise<IntrospectionAuthConfig> {
    const tenant = tenants.get(tenantSlug(req));
    if (tenant === undefined) {
        throw new Error(`Unknown tenant: ${tenantSlug(req)}`);
    }
    return {
        introspectionUrl: tenant.introspectionUrl,
        clientId: tenant.clientId,
        clientSecret: tenant.clientSecret,
    };
}

export const authPlugin = createAuthPlugin(
    new IntrospectionAuthProvider({
        configFactory: resolveTenantConfig,
        cacheTTL: 30,
        maxCacheSize: 1000,
    })
);
```

**Why this pattern works**

- Credentials live where tenants live. Rotating a tenant secret is a database update plus cache expiry — no redeploy, no per-tenant provider instances in process.
- Cache isolation is automatic: the resolved configuration participates in the cache key, so the *same token string* validated for tenant A and tenant B causes two endpoint calls — one per tenant — and never a cross-tenant cache hit.
- Steady-state performance is unchanged: only the first validation per (token, tenant) pair hits the network; subsequent validations are served from the LRU cache with the claims mapper still applied on every call.
- The same mechanism exists on `OidcAuthProvider`: a `configFactory` returning per-tenant `OidcAuthConfig` values, with discovery results cached separately per issuer URL — one provider serves a fleet of tenants with different IdPs.
- When `OidcAuthProvider` has both a static `issuerUrl` and a `configFactory`, the factory wins — useful for keeping a default while adding tenant overrides.

**Caveats and performance**

- The factory is awaited on every `authenticate()` call, including calls that will be served from cache, because its result determines the cache entry. Keep it fast: an in-memory or short-TTL tenant lookup, not a chain of remote calls.
- `validate(token)` cannot work with a factory-only configuration — there is no request to resolve credentials from — and returns `undefined`. Only `authenticate()` (the path the plugin uses) is meaningful.
- Errors thrown by the factory propagate as infrastructure errors (5xx). Reserve throwing for genuine failures (database down, unknown tenant at the infrastructure layer). If "unknown tenant" should be a 400/404, enforce that in earlier middleware so the request never reaches the provider.
- A factory that resolves an *incomplete* config (missing `introspectionUrl`, for example) throws when used — the factory variant is validated at use time, not at construction, so keep the factory's return type honest.
- Combined with the factory, `cacheTTL` should stay short (30 seconds or less) — credential and revocation changes propagate only after cache entries lapse.

---

## Pattern 4: OIDC Backend-for-Frontend — Browser Login and Dual-Mode Authenticate

**When to use**: a browser application must sign users in through an OIDC IdP without ever exposing access or refresh tokens to JavaScript, while the same deployment also validates bearer JWTs for native clients or service calls.

`OidcAuthController` implements the authorization-code + PKCE flow server-side, stores sessions in a `CacheProvider`, and hands the browser an opaque, httpOnly cookie. The same `OidcAuthProvider` instance validates bearer JWTs first and only falls back to the session cookie when no bearer token is present.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { OidcAuthController, oidcAuthPlugin } from 'blendsdk/webafx-auth';
import type { AuthResult, OidcTokens } from 'blendsdk/webafx-auth';
import type { CacheProvider } from 'blendsdk/webafx-cache';
import type { Request, Response } from 'express';

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing environment variable: ${name}`);
    }
    return value;
}

const roleAssignments = new Map<string, string[]>([['user-123', ['editor']]]);

async function loadRoles(sub: string): Promise<string[]> {
    return roleAssignments.get(sub) ?? ['viewer'];
}

class AppOidcController extends OidcAuthController {
    protected getRoutePrefix(): string {
        return '/auth/oidc';
    }

    protected async onCallback(
        tokens: OidcTokens,
        userInfo: Record<string, unknown>,
        _req: Request,
        _res: Response,
    ) {
        // Enrich the IdP claims with application-local data before the session
        // is stored. The tokens are passed through unchanged.
        const roles = await loadRoles(String(userInfo.sub));
        return { tokens, userInfo: { ...userInfo, roles } };
    }
}

class SettingsController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated()
                .get('/settings')
                .handle(async (req, res) => {
                    const user = await req.services.get<AuthResult>('user', undefined);
                    this.ok(res, { sub: user?.sub, claims: user?.claims });
                }),
        ];
    }
}

export function createBrowserApp(cache: CacheProvider): WebApplication {
    const app = new WebApplication({
        PORT: 3400,
        ENV_MODE: 'production',
        LOG_LEVEL: 'INFO',
    });

    app.use(
        oidcAuthPlugin({
            issuerUrl: requireEnv('OIDC_ISSUER_URL'),
            clientId: requireEnv('OIDC_CLIENT_ID'),
            clientSecret: requireEnv('OIDC_CLIENT_SECRET'),
            redirectUri: requireEnv('OIDC_REDIRECT_URI'),
            sessionStore: cache,
        })
    );

    app.registerController('', AppOidcController);
    app.registerController('', SettingsController);

    return app;
}
```

The resulting browser flow, all server-side except the final cookie:

1. The browser hits `GET /auth/oidc/login`. The controller builds the authorization URL with PKCE, state, and nonce, stores the transient state server-side (`stateTtl`, 300 seconds by default), sets a short-lived state cookie, and redirects.
2. The IdP returns the browser to `/auth/oidc/callback?code=...&state=...`. The controller resolves the server-side state from the state cookie's UUID, verifies the `state` parameter, exchanges the code, fetches UserInfo (with subject verification), runs `onCallback`, stores the session (`sessionTtl`), sets the session cookie, clears the state, and redirects to the captured `returnTo` — or `/`.
3. Requests to `/settings` carry no `Authorization` header, so the provider falls back to the session cookie, loads the session from the cache, and resolves `AuthResult` with `claims` set to the stored UserInfo — including the `roles` added by the hook.
4. `POST /auth/oidc/refresh` performs a server-side token refresh and re-issues the cookie. `POST /auth/oidc/logout` revokes best-effort and destroys the session. `GET /auth/oidc/me` returns user claims and expiry — never tokens.

**Why this pattern works**

- Tokens never touch the browser. The callback exchanges the code server-side; only opaque UUID cookies travel to the client, and `/me` deliberately exposes user claims and session expiry only.
- One provider, two front doors: bearer JWTs (mobile, CLI, service calls) are verified first via JWKS; the session cookie is consulted only when no bearer token is present. A request carrying both prefers the bearer token, so API calls can never ride on someone's browser session.
- Identity classification is predictable: the session path always reports `principalType: 'user'` — a session is an interactive user by definition — while the bearer path stamps the provider's configured `principalType`.
- The hooks (`getRoutePrefix`, `getLoginParams`, `onCallback`, `onLogout`, `resolveOrganization`) cover the practical customizations — claim enrichment, forced re-auth via `prompt`, route layout — without forking the controller.
- Only `prompt` and `login_hint` from the login query string are forwarded to the IdP; unknown parameters are dropped, so the login endpoint cannot be used to smuggle arbitrary parameters into the authorization request.

**Caveats and performance**

- Without `sessionStore`, cookie authentication is skipped entirely — the provider becomes bearer-only, and browser requests simply appear unauthenticated. Assert the wiring at startup rather than discovering it in production.
- Cache-storage failures (for example, a Redis outage) propagate as errors rather than being swallowed into 401s. That is deliberate — outages should be visible — but it means cache and session-store health must be monitored and alerted on alongside request error rates.
- The controller resolves its provider from the service container under `getProviderServiceName()` (default `'auth'`). If the plugin is installed under a custom `serviceName`, override that method to match.
- `login` and `callback` are public routes (they must be); `me` is guarded; `logout` and `refresh` validate the session cookie inside the handler so that a user with an expired access token can still refresh or log out.
- Register the exact `redirectUri` at the IdP; the BFF exchange includes the `iss` parameter when the IdP sends it (RFC 9207), but everything else must match the registered value.
- Session cookies are `httpOnly`, `sameSite=lax`, `path=/`, and `secure` in production; the state cookie expires after 300 seconds, which bounds how long a login attempt may take.

---

## Pattern 5: Hardening Browser Sessions — Rotation, Sliding TTLs, and Tenant-Scoped Cookies

**When to use**: session cookies exist in a hostile environment — they can be stolen, replayed from another tab, or picked up under the wrong tenant on a shared domain — and you want each of those risks bounded by explicit session lifecycle semantics.

Three independent controls compose here: an independent cookie TTL (`sessionCookieTtl`) decouples the browser window from the access-token lifetime; `rotateSessionIdOnRefresh` makes the session ID single-use across refreshes; and cookie-name resolvers scope every read and write to the requesting tenant.

```typescript
import { OidcAuthController, OidcAuthProvider } from 'blendsdk/webafx-auth';
import type { Request } from 'express';
import type { CacheProvider } from 'blendsdk/webafx-cache';

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing environment variable: ${name}`);
    }
    return value;
}

function tenantFromRequest(req: Request): string {
    const host = req.hostname;
    const [subdomain] = host.split('.');
    return subdomain.length > 0 ? subdomain : 'default';
}

export function createTenantAwareProvider(cache: CacheProvider): OidcAuthProvider {
    return new OidcAuthProvider({
        issuerUrl: requireEnv('OIDC_ISSUER_URL'),
        clientId: requireEnv('OIDC_CLIENT_ID'),
        clientSecret: requireEnv('OIDC_CLIENT_SECRET'),
        redirectUri: requireEnv('OIDC_REDIRECT_URI'),
        sessionStore: cache,
        // The browser cookie outlives short-lived access tokens but stays far
        // below the server-side session budget.
        sessionCookieTtl: 60 * 60 * 8,
        sessionTtl: 60 * 60 * 24 * 30,
        rotateSessionIdOnRefresh: true,
        resolveSessionCookieName: (req) => `__oidc_session_${tenantFromRequest(req)}`,
        resolveStateCookieName: (req) => `__oidc_state_${tenantFromRequest(req)}`,
    });
}

export class TenantAwareOidcController extends OidcAuthController {
    protected resolveOrganization(req: Request): string | undefined {
        return tenantFromRequest(req);
    }
}
```

Wiring it into the application:

```typescript
import { createAuthPlugin } from 'blendsdk/webafx-auth';

app.use(createAuthPlugin(createTenantAwareProvider(cache)));
app.registerController('', TenantAwareOidcController);
```

**Why this pattern works**

- Rotation is time-bound theft protection: on a successful refresh, the controller stores the updated session under a freshly generated UUID, deletes the old ID, and re-issues the cookie carrying the new ID — in that order. An attacker holding a captured cookie loses the race with the legitimate client's next refresh; presenting the pre-rotation ID afterwards resolves to no session.
- Rotation failures are availability-first. If storing the new session fails, the old session stays intact and no cookie is written; if deleting the old ID fails, the old session remains usable and only an orphaned new entry exists, which lapses on its own via `sessionTtl`. In both cases the user is never stranded in a half-rotated state.
- Sliding sessions stay stable: each successful refresh re-issues the cookie with the same (or rotated) ID and the full `sessionCookieTtl`, and repeated refreshes do not drift the window. The cookie TTL follows the precedence `sessionCookieTtl ?? sessionTtl ?? 3600`, and a deliberate `0` is respected rather than treated as "unset".
- Tenant scoping prevents cross-tenant pickup: cookie names are resolved per request from the host on every route — login, callback, refresh, me, and logout — so `acme.example.com` and `globus.example.com` never read each other's session. The controller's `resolveOrganization` hook records the tenant slug on the stored session for observability.
- Cookie attributes are enforced by the controller regardless of rotation: `httpOnly` always, `sameSite=lax`, `path=/`, and `secure` whenever the settings report production.

**Caveats and performance**

- Multi-tab clients must coordinate refreshes. When one tab rotates the session ID, another tab presenting the old cookie receives a 401 on its next refresh and must re-authenticate. If that is unacceptable for your UX, refresh through a single-flight mechanism on the client, or disable rotation for lower-risk tenants.
- Rotation adds one store operation and one delete per refresh; for very chatty clients that refresh aggressively, consider rotating only on natural token expiry.
- Resolvers must be deterministic and derivable from the request alone (host, header). A resolver that depends on data absent from some routes produces inconsistent cookie names and broken sessions — test the full login → refresh → me → logout cycle per tenant.
- Refresh and logout validate the session cookie in the handler rather than behind the auth guard, precisely so that rotation and expiry do not lock users out of recovering; do not "simplify" these routes by making them `.secure(...)`.

---

## Pattern 6: Normalizing Token Claims with a Custom Mapper

**When to use**: the IdP emits a non-standard claim vocabulary (`user_id` instead of `sub`, `perms` instead of `scope`), or the application needs request-aware identity enrichment — and you want a single normalization point instead of scattered defensive reads of `claims` everywhere.

A custom `mapClaims` mapper replaces the default claim extraction entirely; the OIDC provider additionally offers `resolveUser`, an async, request-aware superset of the mapper.

```typescript
import { JwtAuthProvider, OidcAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult, ClaimsMapper } from 'blendsdk/webafx-auth';
import type { Request } from 'express';

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing environment variable: ${name}`);
    }
    return value;
}

/**
 * Normalizes a legacy IdP vocabulary:
 * user_id → sub, perms → scopes; the raw claims are preserved untouched.
 */
const legacyClaimsMapper: ClaimsMapper = (token, rawClaims) => {
    const sub = String(rawClaims.user_id ?? rawClaims.sub ?? 'unknown');

    let scopes: string[] | undefined;
    if (typeof rawClaims.perms === 'string') {
        scopes = rawClaims.perms.split(' ').filter(Boolean);
    } else if (Array.isArray(rawClaims.perms)) {
        scopes = rawClaims.perms.map(String);
    }

    const exp = typeof rawClaims.exp === 'number' ? rawClaims.exp : undefined;

    return { sub, claims: rawClaims, token, exp, scopes };
};

export function createLegacyJwtProvider(): JwtAuthProvider {
    return new JwtAuthProvider({
        secret: requireEnv('JWT_SECRET'),
        issuer: requireEnv('JWT_ISSUER'),
        audience: requireEnv('JWT_AUDIENCE'),
        requireAudience: true,
        mapClaims: legacyClaimsMapper,
        principalType: 'user',
    });
}

const accountFacts = new Map<string, Record<string, unknown>>([
    ['user-123', { plan: 'enterprise', department: 'engineering' }],
]);

function bearerToken(req: Request): string {
    const header = req.headers.authorization ?? '';
    return header.startsWith('Bearer ') ? header.slice(7) : '';
}

export function createEnrichedOidcProvider(): OidcAuthProvider {
    return new OidcAuthProvider({
        issuerUrl: requireEnv('OIDC_ISSUER_URL'),
        clientId: requireEnv('OIDC_CLIENT_ID'),
        clientSecret: requireEnv('OIDC_CLIENT_SECRET'),
        resolveUser: async (req, claims) => {
            // resolveUser supersedes mapClaims and may be asynchronous —
            // enrich from local stores using the request context.
            const sub = String(claims.sub);
            const facts = accountFacts.get(sub) ?? {};
            return {
                sub,
                claims: { ...claims, ...facts },
                token: bearerToken(req),
            };
        },
    });
}
```

Resolution precedence, from highest to lowest:

| Layer | Runs when | Error behavior |
| --- | --- | --- |
| `resolveUser` (OIDC) | configured; receives `(req, claims)` | async; a thrown error propagates (5xx — treat as a backend outage) |
| `mapClaims` | configured and no `resolveUser` | synchronous; a thrown error fails authentication silently (`undefined` → 401) |
| default mapper | neither configured | extracts `sub`/`subject`, numeric `exp`, `scope` string or `scope`/`scopes` arrays |
| `principalType` fill | result has no `principalType` | the value set by the mapper or stored result wins; config only fills the gap |

**Why this pattern works**

- One choke point for identity shape. Application code reads a stable `AuthResult` (`sub`, `scopes`, `exp`, `claims`) regardless of which IdP or claim vocabulary produced it — migrating IdPs becomes a mapper change, not a codebase-wide search.
- The custom mapper is authoritative, including for classification: a mapper that sets `principalType` explicitly overrides the configured value, and configuration only fills results that left it unset. Nothing silently rewrites your mapper's decisions.
- `resolveUser` enables request-aware enrichment: per-tenant facts, feature flags, or role tables fetched per validation, with the request available for context. The enriched `claims` object is what route handlers see.
- The default mapper keeps `claims` intact, so a custom mapper can always fall back to raw values — normalization is additive, not lossy.
- The introspection provider applies the mapper on every call, including cache hits, so cache entries store raw claims while mapping stays live.

**Caveats and performance**

- A custom mapper fully replaces the default: if you still need `exp` or `scopes`, re-derive them (as above), or they will be missing from results.
- The mapper runs on every validation — and on every cache hit for introspection — so keep it pure and cheap. `resolveUser`, being async, is the place for I/O; the sync mapper is not.
- Respect the failure asymmetry: sync mapper errors fail closed silently (401), async `resolveUser` errors surface as 5xx. If an account-lookup failure must not masquerade as a bad token, use `resolveUser`; if it should simply remove access, use the sync mapper path.
- Never log the raw token — the mapper receives it as its first argument. `claims` may carry PII; log selectively.
- `MemoryAuthProvider` returns stored `AuthResult` objects as-is and never invokes the mapper. Test mapping behavior with a real provider (JWT or OIDC), not the memory double.

---

## Pattern 7: Fail-Closed Audience Validation

**When to use**: several services share a signing key or an IdP, and a token minted for one service must never be accepted by another; or a security review asks "what happens if we forget to configure the audience?"

**Before** — signature-only validation accepts every token signed with the shared secret, regardless of which service, issuer, or audience it was minted for:

```typescript
// Before: any token this secret validates is accepted — the fleet's other
// services' tokens included, because neither issuer nor audience is checked.
const looseProvider = new JwtAuthProvider({ secret: requireEnv('JWT_SECRET') });
```

**After** — explicit issuer/audience constraints, a fail-closed gate, and a bounded clock tolerance:

```typescript
import { JwtAuthProvider, OidcAuthProvider } from 'blendsdk/webafx-auth';

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing environment variable: ${name}`);
    }
    return value;
}

export function createIntranetJwtProvider(): JwtAuthProvider {
    return new JwtAuthProvider({
        secret: requireEnv('JWT_SECRET'),
        algorithms: ['HS256'],
        issuer: requireEnv('JWT_ISSUER'),
        audience: requireEnv('JWT_AUDIENCE'),
        requireAudience: true,
        clockTolerance: 5,
    });
}

export function createPlatformOidcProvider(): OidcAuthProvider {
    return new OidcAuthProvider({
        issuerUrl: requireEnv('OIDC_ISSUER_URL'),
        clientId: requireEnv('OIDC_CLIENT_ID'),
        clientSecret: requireEnv('OIDC_CLIENT_SECRET'),
        // A token is accepted when it addresses any of these audiences.
        audience: [requireEnv('OIDC_AUDIENCE'), 'https://internal.example.com'],
        requireAudience: true,
    });
}
```

For opaque tokens, the introspection provider offers the same gate in single-option form:

```typescript
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';

// Opaque tokens: the endpoint's 'aud' claim must contain one of these values;
// a missing or mismatched audience is rejected even when 'active' is true.
const introspectionProvider = new IntrospectionAuthProvider({
    introspectionUrl: requireEnv('INTROSPECTION_URL'),
    clientId: requireEnv('INTROSPECTION_CLIENT_ID'),
    clientSecret: requireEnv('INTROSPECTION_CLIENT_SECRET'),
    audience: ['api-a', 'api-b'],
});
```

Validation behavior across the three backends:

| Provider | Audience handling | `requireAudience: true` with no audience configured | Clock tolerance |
| --- | --- | --- | --- |
| `JwtAuthProvider` | checked during local verification against the token's `aud` | rejects every token, fail closed | `clockTolerance` in seconds |
| `OidcAuthProvider` | passed to JWKS-based verification | rejects every token **before** discovery — no JWKS fetch is performed for a misconfigured deployment | defaults to `30` seconds |
| `IntrospectionAuthProvider` | matched against the endpoint response's `aud` (string or array); missing or non-matching → rejected despite `active: true` | configuration of `audience` is itself the gate — there is no bypass switch | — |

**Why this pattern works**

- The fail-closed gate converts a silent security hole into a loud operational failure. `requireAudience: true` with no configured audience rejects *everything* — including valid tokens — so the misconfiguration cannot survive even one successful request. In the OIDC provider the gate runs before discovery, so the failure is immediate and offline.
- Tokens become service-scoped: in a fleet sharing a signing key, only tokens addressed to this service pass verification. Issuer validation removes the same class of confusion when multiple IdPs share key material.
- A bounded `clockTolerance` keeps a pool of NTP-skewed hosts issuing and accepting tokens without extending token validity to the point of defeating expiry — a recently expired token within tolerance passes; a long-expired one never does.
- The audience option accepts a single string or an array on every provider, so a service that is legitimately addressed under several audience identifiers configures them in one place.

**Caveats and performance**

- Fail-closed means fail-*down* when half-configured: ship `requireAudience` together with configuration that can never be empty (`requireEnv`) so the gate is always armed with a real value, and let startup validation (Pattern 2) catch the rest.
- Keep `clockTolerance` small (seconds for JWT, the 30-second OIDC default is already generous). Every second of tolerance is a second of extra validity for expired tokens.
- For introspection, verify the endpoint actually emits `aud` before enabling the audience check — endpoints that omit the claim will reject *all* tokens once `audience` is configured.
- Audience arrays are membership checks, not ordering preferences; a token matching any configured value passes. Audit the list when services split or merge.

---

## Pattern 8: Custom Token Extraction Chains

**When to use**: tokens arrive through non-standard channels — an API-key header injected by a gateway, a callback URL with a query parameter, an SSE endpoint that cannot set headers — and the acceptance rules differ per route group within one application.

Token extraction is a chain of sources evaluated in order; the first non-empty match wins, and a falsy extraction (for example, `Bearer ` with no value) falls through to the next source instead of failing hard. Custom extractors plug in as ordinary functions.

```typescript
import { IntrospectionAuthProvider, createAuthPlugin } from 'blendsdk/webafx-auth';
import type { TokenSource } from 'blendsdk/webafx-auth';
import type { Request } from 'express';

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing environment variable: ${name}`);
    }
    return value;
}

/** Reads a gateway-injected API key from the X-Api-Key header. */
const apiKeySource: TokenSource = {
    extractor: (req: Request) => {
        const value = req.headers['x-api-key'];
        return typeof value === 'string' && value.length > 0 ? value : undefined;
    },
};

export const gatewayAuthPlugin = createAuthPlugin(
    new IntrospectionAuthProvider({
        introspectionUrl: requireEnv('INTROSPECTION_URL'),
        clientId: requireEnv('INTROSPECTION_CLIENT_ID'),
        clientSecret: requireEnv('INTROSPECTION_CLIENT_SECRET'),
        // Explicit API clients first, browser cookies second, gateway keys last.
        tokenSources: ['header', 'cookie', apiKeySource],
        cookieName: 'gateway_session',
    })
);
```

For routes that cannot set headers at all — SSE streams, webhook callbacks — give them their own provider instance with a query-only chain, so the weaker ingress rule never applies to the rest of the application:

```typescript
import { introspectionAuthPlugin } from 'blendsdk/webafx-auth';

// EventSource cannot set an Authorization header. This sibling plugin accepts
// short-lived, narrowly scoped tokens from a query parameter — for the SSE
// route group only, never enabled globally.
export const sseAuthPlugin = introspectionAuthPlugin(
    {
        introspectionUrl: requireEnv('INTROSPECTION_URL'),
        clientId: requireEnv('INTROSPECTION_CLIENT_ID'),
        clientSecret: requireEnv('INTROSPECTION_CLIENT_SECRET'),
        tokenSources: ['query'],
        queryParamName: 'access_token',
    },
    { serviceName: 'sse-auth', userServiceName: 'sse-user' }
);
```

**Why this pattern works**

- The chain order is the policy. Putting the explicit `Authorization` header first and the implicit sources later means well-behaved clients use the strongest channel, and fallback channels only matter when nothing stronger was presented.
- Custom extractors keep the providers generic: an in-house header, an mTLS-derived identity header, or a gateway-injected claim is one pure function, with the full Express request available.
- Because sources are constructor configuration, different provider instances (and therefore different plugin registrations) can accept different ingress paths while sharing the same validation backend — browser and gateway plugins can point at the same introspection endpoint with distinct service names and extraction rules.
- Configuration errors fail at startup: an unknown source value throws at construction (`Unknown token source: ... Supported: "header", "cookie", "query", or { extractor: fn }`), not on the first request.
- The chain is built in the abstract base class, so behavior is identical across all four providers — including OIDC bearer extraction and the JWT provider.

**Caveats and performance**

- Query-string tokens leak: they appear in access logs, browser history, and `Referer` headers. Restrict query-based chains to routes where headers are impossible, use short-lived and narrowly scoped tokens, and scrub them from logs.
- Header matching is case-sensitive: only `Bearer ` (capital B) is recognized. Lowercase or alternative schemes fall through to the next source — deliberately, so a malformed scheme cannot shadow a valid cookie.
- Custom extractors run on every request before any validation; keep them synchronous, allocation-light, and side-effect free.
- Cookie extraction depends on upstream cookie parsing (WebAFX's core middleware provides it in the framework stack); driving the providers outside WebAFX means installing `cookie-parser` yourself.
- Order affects latency in aggregate only marginally — every extractor is a cheap property read — but it affects security posture decisively. Review chain changes the way you review route guards.

---

## Pattern 9: Testing Auth-Protected Applications with MemoryAuthProvider

**When to use**: every test suite for an auth-protected endpoint needs deterministic, offline authentication — no IdP, no introspection endpoint, no clock dependence — plus the ability to add and revoke tokens mid-test.

`MemoryAuthProvider` maps token strings to pre-built `AuthResult` objects. Combined with `createAuthPlugin`, it exercises the real extraction chain, the real plugin wiring, and the real route guards — everything except the external validation backend.

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import supertest from 'supertest';
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { createAuthPlugin, MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const ADMIN_RESULT: AuthResult = {
    sub: 'admin-1',
    claims: { role: 'admin' },
    token: 'admin-token',
    scopes: ['billing:read', 'billing:write'],
};

class BillingController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated()
                .get('/billing/invoices')
                .handle(async (req, res) => {
                    const user = await req.services.get<AuthResult>('user', undefined);
                    this.ok(res, { sub: user?.sub, scopes: user?.scopes });
                }),
        ];
    }
}

function createTestApp(): { app: WebApplication; provider: MemoryAuthProvider } {
    const provider = new MemoryAuthProvider({
        validTokens: { 'admin-token': ADMIN_RESULT },
    });

    const app = new WebApplication({
        PORT: 0,
        ENV_MODE: 'test',
        LOG_LEVEL: 'ERROR',
    });
    app.use(createAuthPlugin(provider));
    app.registerController('', BillingController);

    return { app, provider };
}

describe('billing routes', () => {
    let shutdown: (() => Promise<void>) | null = null;

    afterEach(async () => {
        if (shutdown !== null) {
            await shutdown();
            shutdown = null;
        }
    });

    it('accepts a known token', async () => {
        const { app } = createTestApp();
        shutdown = await app.start();

        const res = await supertest(app.express)
            .get('/billing/invoices')
            .set('Authorization', 'Bearer admin-token')
            .expect(200);

        expect(res.body.data).toEqual({
            sub: 'admin-1',
            scopes: ['billing:read', 'billing:write'],
        });
    });

    it('rejects an unknown token', async () => {
        const { app } = createTestApp();
        shutdown = await app.start();

        await supertest(app.express)
            .get('/billing/invoices')
            .set('Authorization', 'Bearer unknown-token')
            .expect(401);
    });

    it('rejects a token that was removed at runtime', async () => {
        const { app, provider } = createTestApp();
        shutdown = await app.start();

        await supertest(app.express)
            .get('/billing/invoices')
            .set('Authorization', 'Bearer admin-token')
            .expect(200);

        expect(provider.getTokenCount()).toBe(1);
        provider.removeToken('admin-token');

        await supertest(app.express)
            .get('/billing/invoices')
            .set('Authorization', 'Bearer admin-token')
            .expect(401);
    });
});
```

**Why this pattern works**

- Tests run against the real machinery: the extraction chain parses your `Authorization` headers, the plugin registers its services, the route guard produces the same 401 a production provider would. Only the `validate()` backend is a map lookup.
- Token state is fully controllable at runtime — `addToken()` and `removeToken()` simulate issuance, rotation, and revocation without timers or network stubs; `getTokenCount()` lets tests assert provider state directly.
- Results are byte-for-byte deterministic. The stored `AuthResult` objects come back exactly as configured, so assertions on `sub`, `scopes`, and `claims` are stable across machines and time zones.
- The pattern scales to multi-provider layouts: build a test app with two plugins and distinct `userServiceName` values (Pattern 1) and assert cross-rejection — each provider's token is a 401 on the other's routes — as the package's own specification suite does.
- `PORT: 0` keeps parallel suites from colliding, and `LOG_LEVEL: 'ERROR'` keeps test output readable.

**Caveats and performance**

- `shutdown()` clears every token. Because the plugin holds the same provider instance the test created, tokens added before `shutdown` vanish after it — so create a fresh app (and provider) per test instead of sharing one across a suite that shuts down between cases.
- The memory provider returns stored results as-is and never invokes `mapClaims`. A green suite here does not prove claims-mapping behavior; test the mapper against `JwtAuthProvider` or `OidcAuthProvider` (Pattern 6).
- `principalType` follows the same rule: if the stored result carries one, it wins; otherwise the provider's configured `principalType` fills the gap. Store results without a type when you want to test the fill behavior.
- Keep `MemoryAuthProvider` out of production code paths entirely; wiring it behind `createAuthProvider` should be gated so an environment variable can never select it outside tests (Pattern 2).

---

## Pattern 10: Extending AuthProvider with a Custom Backend

**When to use**: your organization has an in-house token format — a signed legacy ticket, a proprietary license key, a vendor-specific credential — and you want it to behave exactly like the four built-in providers: same extraction chain, same plugin integration, same lifecycle contract.

Concrete providers implement only `validate()`; the base class supplies extraction, claims mapping, and principal typing. A custom provider needs to implement `health()` and `shutdown()` as well, but everything the plugin system touches is inherited.

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthProvider, createAuthPlugin } from 'blendsdk/webafx-auth';
import type { AuthProviderConfig, AuthResult } from 'blendsdk/webafx-auth';

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing environment variable: ${name}`);
    }
    return value;
}

export interface LegacyTokenAuthConfig extends AuthProviderConfig {
    /** Shared secret used to validate legacy signatures. */
    signingKey: string;
}

/**
 * Validates in-house tokens of the shape:
 *   legacy.<url-encoded userId>.<expiryEpochSeconds>.<hmacSha256Hex>
 */
export class LegacyTokenAuthProvider extends AuthProvider {
    private readonly signingKey: string;

    constructor(config: LegacyTokenAuthConfig) {
        super(config);
        this.signingKey = config.signingKey;
    }

    async validate(token: string): Promise<AuthResult | undefined> {
        const parts = token.split('.');
        if (parts.length !== 4) {
            return undefined;
        }

        const [version, sub, expRaw, signature] = parts;
        if (version !== 'legacy') {
            return undefined;
        }

        const expiresAt = Number(expRaw);
        if (!Number.isInteger(expiresAt) || expiresAt * 1000 <= Date.now()) {
            return undefined;
        }

        const expected = createHmac('sha256', this.signingKey)
            .update(`${sub}.${expRaw}`)
            .digest('hex');

        if (
            expected.length !== signature.length ||
            !timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'))
        ) {
            return undefined;
        }

        return this.withPrincipalType(
            this.claimsMapper(token, { sub: decodeURIComponent(sub), exp: expiresAt })
        );
    }

    async health(): Promise<boolean> {
        return this.signingKey.length > 0;
    }

    async shutdown(): Promise<void> {
        // Stateless verifier — no connections or cached key material to release.
    }
}

export const legacyAuthPlugin = createAuthPlugin(
    new LegacyTokenAuthProvider({
        signingKey: requireEnv('LEGACY_SIGNING_KEY'),
        principalType: 'client',
    })
);
```

**Why this pattern works**

- The base class does the heavy lifting. Token extraction (all configured `tokenSources`, including custom extractors), the `mapClaims` configuration, and the `principalType` fill are inherited without a line of provider code — behavior matches the built-ins exactly.
- Silent-failure discipline is preserved: the provider returns `undefined` for malformed, expired, or badly signed tokens; the plugin middleware turns that into a 401. Only genuine infrastructure faults should throw.
- `createAuthPlugin()` is generic over `AuthProvider`, so the custom provider immediately gains singleton registration, the per-request principal service, custom service names, and plugin priority — no adapter code.
- `health()` and `shutdown()` plug into the same lifecycle as the built-ins: the plugin factory's returned `health`/`shutdown` delegate straight to the provider, so framework health reporting and graceful stop behave uniformly. The built-ins use `shutdown()` to clear key caches, introspection caches, discovery state, and memory tokens — a custom provider that holds resources (HTTP agents, timers, key sets) must release them here too.
- The provider uses the protected `claimsMapper` and `withPrincipalType` helpers, so configuration from Pattern 6 applies unchanged: a custom `mapClaims` in the constructor config replaces the default, and the configured `principalType` only fills results that did not set their own.

**Caveats and performance**

- Compare signatures with `timingSafeEqual` (as above), never `===`; the length guard before the constant-time comparison is standard practice and avoids an exception on length mismatch.
- `validate()` is the hot path and may be called with any string, including empty ones — reject cheaply and early, and avoid allocations on the failure path.
- Do not re-implement extraction or claims mapping inside `validate()`. Pass the raw token to `claimsMapper` so the custom-mapper contract is honored, and let the base class feed you the token.
- If your backend is remote (a proprietary validation API), `health()` should be a lightweight reachability check and `shutdown()` must close sockets and cancel timers; a stateless verifier returning `true` and doing nothing is not a cop-out — it is an accurate implementation of the contract.
- Remember the plugin name collision rule: a custom provider installed with the default `serviceName` occupies `auth:auth` like any other; give it a distinct service name when it coexists with other providers (Pattern 1).

---

## Design Invariants Across These Patterns

Regardless of which patterns you compose, these invariants hold throughout the package — breaking them is how auth bugs are born:

| Invariant | Meaning | Where it surfaces |
| --- | --- | --- |
| Silent failure vs infrastructure error | Invalid, missing, or expired credentials resolve to `undefined` (→ 401); only infrastructure faults (network, storage) throw (→ 5xx) | Patterns 3, 5, 10 |
| First match wins | The extraction chain stops at the first non-empty source; empty values fall through | Patterns 1, 8 |
| Hash, never store | Introspection cache keys are SHA-256 digests of tokens; raw tokens never enter the cache | Patterns 3, 7 |
| Fail closed at startup | Unknown token sources, missing factory fields, and plugin-name collisions throw before the first request | Patterns 2, 8, 10 |
| One provider, many front doors | A single provider instance serves every route; per-route behavior comes from plugin registration and `principalType` | Patterns 1, 4 |
| Opaque browser state | Browser cookies carry UUIDs only; sessions and PKCE state live server-side with explicit TTLs | Patterns 4, 5 |

---

# webafx-auth Common Scenarios

Task-oriented answers to the questions that come up most often when wiring authentication into a WebAFX application. Every scenario is self-contained: each example is complete, compiles under strict TypeScript, and imports exclusively from package entry points.

---

## How do I protect routes with JWT authentication?

Register `jwtAuthPlugin()` with the application and mark routes as authenticated; tokens are verified locally with the configured secret — no network round trip — and the authenticated principal is available through the per-request `user` service. Requests without a valid, unexpired token receive `401`.

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
                    this.ok(res, {
                        sub: user?.sub,
                        scopes: user?.scopes,
                    });
                }),
        ];
    }
}

const app = new WebApplication({
    PORT: 3400,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

app.use(jwtAuthPlugin({
    secret: 'a-development-only-secret-at-least-32-bytes!',
}));

app.registerController('', ProfileController);

await app.start();
```

---

## How do I test auth-protected routes without an identity provider?

Use `MemoryAuthProvider`: it authenticates by exact token lookup against a preconfigured map, so tests need no network, no signing keys, and no external infrastructure. Register it with `memoryAuthPlugin()` and send one of the configured tokens as a Bearer token. When a suite must add or revoke tokens mid-run, construct a `MemoryAuthProvider`, register it with `createAuthPlugin()`, and call `addToken()` or `removeToken()` on the instance as the test progresses.

```typescript
import supertest from 'supertest';
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { memoryAuthPlugin } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const TEST_TOKEN = 'integration-test-token';

const TEST_USER: AuthResult = {
    sub: 'test-user-1',
    claims: { role: 'admin' },
    token: TEST_TOKEN,
};

class ProfileController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated()
                .get('/profile')
                .handle(async (req, res) => {
                    const user = await req.services.get<AuthResult>('user', undefined);
                    this.ok(res, { sub: user?.sub });
                }),
        ];
    }
}

const app = new WebApplication({
    PORT: 0,
    ENV_MODE: 'test',
    LOG_LEVEL: 'ERROR',
});

app.use(memoryAuthPlugin({
    validTokens: { [TEST_TOKEN]: TEST_USER },
}));

app.registerController('', ProfileController);

const shutdown = await app.start();

await supertest(app.express)
    .get('/profile')
    .set('Authorization', `Bearer ${TEST_TOKEN}`)
    .expect(200);

await supertest(app.express)
    .get('/profile')
    .expect(401);

await shutdown();
```

---

## How do I extract tokens from cookies, query parameters, or custom headers?

Configure the ordered `tokenSources` chain — the first non-empty match wins — and rename the cookie or query parameter with `cookieName` and `queryParamName`. Custom `{ extractor }` entries cover any other request location, such as an API-key header. If no source matches, the request is simply unauthenticated (`undefined`) — not an error.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { Request } from 'express';
import { JwtAuthProvider, createAuthPlugin } from 'blendsdk/webafx-auth';
import type { TokenSource } from 'blendsdk/webafx-auth';

const apiKeySource: TokenSource = {
    extractor: (req: Request): string | undefined =>
        req.headers['x-api-key'] as string | undefined,
};

const provider = new JwtAuthProvider({
    secret: 'a-development-only-secret-at-least-32-bytes!',
    tokenSources: ['header', 'cookie', 'query', apiKeySource],
    cookieName: 'auth_token',
    queryParamName: 'token',
});

const app = new WebApplication({
    PORT: 3400,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

app.use(createAuthPlugin(provider));

await app.start();
```

---

## How do I map non-standard claims into an `AuthResult`?

Pass a `mapClaims` function in the provider config; it receives the raw token string and the raw claims object and returns the standardized `AuthResult`. A custom mapper replaces the default entirely — the default already understands `sub`/`subject`, `exp`, and `scope`/`scopes`, so only override it for legacy or provider-specific claim formats.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { JwtAuthProvider, createAuthPlugin } from 'blendsdk/webafx-auth';
import type { AuthResult, ClaimsMapper } from 'blendsdk/webafx-auth';

const legacyClaimsMapper: ClaimsMapper = (token, rawClaims): AuthResult => ({
    sub: String(rawClaims.user_id ?? rawClaims.sub ?? 'unknown'),
    claims: rawClaims,
    token,
    scopes:
        typeof rawClaims.permissions === 'string'
            ? rawClaims.permissions.split(' ').filter(Boolean)
            : undefined,
});

const provider = new JwtAuthProvider({
    secret: 'a-development-only-secret-at-least-32-bytes!',
    mapClaims: legacyClaimsMapper,
});

const app = new WebApplication({
    PORT: 3400,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

app.use(createAuthPlugin(provider));

await app.start();
```

---

## How do I require a token audience and fail closed when it is missing?

Set `audience` (string or array) to enforce the `aud` claim, and add `requireAudience: true` so that a token whose audience does not match is rejected — and, critically, so that a missing audience configuration rejects every token instead of silently skipping the check. Failing closed turns a forgotten audience into an immediate, visible authentication failure rather than a security hole.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { jwtAuthPlugin } from 'blendsdk/webafx-auth';

const app = new WebApplication({
    PORT: 3400,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

app.use(jwtAuthPlugin({
    secret: 'a-development-only-secret-at-least-32-bytes!',
    issuer: 'https://auth.example.com',
    audience: ['https://api.example.com', 'https://admin.example.com'],
    requireAudience: true,
}));

await app.start();
```

---

## How do I tolerate clock skew for recently expired tokens?

Set `clockTolerance` (in seconds) to widen the expiration window: tokens that expired within the tolerance are still accepted, while anything older is rejected. This is useful during rolling deploys or when the token issuer and your hosts are a few seconds out of sync.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { jwtAuthPlugin } from 'blendsdk/webafx-auth';

const app = new WebApplication({
    PORT: 3400,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

app.use(jwtAuthPlugin({
    secret: 'a-development-only-secret-at-least-32-bytes!',
    issuer: 'https://auth.example.com',
    clockTolerance: 120,
}));

await app.start();
```

---

## How do I build an auth provider from environment configuration?

`createAuthProvider()` takes a single config object with a `type` discriminant and constructs the matching provider, validating required fields at startup instead of at the first request. Combine it with `createAuthPlugin()` for a one-line, deployment-configurable setup.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { createAuthProvider, createAuthPlugin } from 'blendsdk/webafx-auth';

const app = new WebApplication({
    PORT: 3400,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

app.use(createAuthPlugin(createAuthProvider({
    type: 'introspection',
    introspectionUrl: process.env.OIDC_INTROSPECT_URL,
    clientId: process.env.OIDC_CLIENT_ID,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
})));

await app.start();
```

Required fields per provider type:

| `type` | Required fields | Notes |
| --- | --- | --- |
| `'jwt'` | `secret` | Local verification (HMAC/RSA), no network |
| `'introspection'` | `introspectionUrl`, `clientId`, `clientSecret` — or `configFactory` | RFC 7662 opaque-token validation |
| `'oidc'` | `issuerUrl` | Discovery + JWKS validation |
| `'memory'` | none | Deterministic provider for tests |

If a required field is missing, construction throws a field-specific error — for example `createAuthProvider: type 'jwt' requires 'secret'` — so a misconfigured deployment fails at startup rather than on the first request.

---

## How do I validate opaque access tokens with OAuth2 introspection?

`introspectionAuthPlugin()` (or `IntrospectionAuthProvider`) validates opaque tokens against an RFC 7662 introspection endpoint. Responses are cached automatically, keyed by a SHA-256 digest of the token so raw tokens are never retained, with entry TTLs clamped to the token's own `exp` — inactive and expired responses are never cached, and `maxCacheSize` bounds the cache with LRU eviction. Use `authMethod: 'post'` for servers that reject Basic auth, and `audience` to validate the response's `aud` claim.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { introspectionAuthPlugin } from 'blendsdk/webafx-auth';

const app = new WebApplication({
    PORT: 3400,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

app.use(introspectionAuthPlugin({
    introspectionUrl: 'https://auth.example.com/oauth2/introspect',
    clientId: 'orders-api',
    clientSecret: 'orders-api-secret',
    authMethod: 'post',
    audience: 'https://orders.example.com',
    maxCacheSize: 1000,
}));

await app.start();
```

---

## How do I resolve per-tenant introspection credentials on each request?

Provide a `configFactory` instead of the static credential triple: it runs per request and returns the introspection URL and credentials for that tenant. Cached results are scoped to the resolved client, so the same token string validated for two tenants is never shared; an error thrown by the factory (for example, an unknown tenant) propagates to the request. Note that `validate(token)` alone has no request context and returns `undefined` when only a factory is configured — per-request resolution happens in `authenticate(req)`, which the plugin invokes.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { Request } from 'express';
import { IntrospectionAuthProvider, createAuthPlugin } from 'blendsdk/webafx-auth';
import type { IntrospectionAuthConfig } from 'blendsdk/webafx-auth';

const tenantSecrets = new Map<string, string>([
    ['acme', 'acme-introspection-secret'],
    ['globus', 'globus-introspection-secret'],
]);

const provider = new IntrospectionAuthProvider({
    configFactory: async (req: Request): Promise<IntrospectionAuthConfig> => {
        const tenant = String(req.headers['x-tenant-id'] ?? 'acme');
        const clientSecret = tenantSecrets.get(tenant);
        if (!clientSecret) {
            throw new Error(`No introspection credentials configured for tenant '${tenant}'`);
        }
        return {
            introspectionUrl: `https://${tenant}.auth.example.com/oauth2/introspect`,
            clientId: `orders-api-${tenant}`,
            clientSecret,
        };
    },
});

const app = new WebApplication({
    PORT: 3400,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

app.use(createAuthPlugin(provider));

await app.start();
```

---

## How do I validate OIDC bearer tokens with discovery and JWKS?

`oidcAuthPlugin()` configures discovery-based validation: the provider fetches the issuer metadata, resolves the JWKS key set, and verifies each bearer token with `jose`. Discovery results are cached and refreshed after `discoveryTtl` seconds, the validation clock tolerance defaults to 30 seconds, and — as with JWT — `requireAudience: true` rejects tokens when no audience is configured. For per-tenant issuers, supply a `configFactory` instead of a static `issuerUrl`, mirroring the introspection pattern.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { oidcAuthPlugin } from 'blendsdk/webafx-auth';

const app = new WebApplication({
    PORT: 3400,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

app.use(oidcAuthPlugin({
    issuerUrl: 'https://login.example.com',
    clientId: 'orders-api',
    clientSecret: 'orders-api-secret',
    audience: 'https://orders.example.com',
    discoveryTtl: 600,
}));

await app.start();
```

---

## How do I run two auth providers side by side?

Register one plugin per principal kind, each with a distinct `serviceName` (the plugin identity — duplicates are rejected at startup with `Plugin "auth:auth" is already registered`) and `userServiceName` (the per-request principal service). Routes select their principal by naming that service with `.secure()`, while `this.authenticated()` always resolves the default `user` service; setting `principalType` stamps results so downstream code can tell humans and machines apart.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { createAuthPlugin, MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const USER_TOKEN = 'user-token';
const CLIENT_TOKEN = 'client-token';

class ApiController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated()
                .get('/api/me')
                .handle(async (req, res) => {
                    const user = await req.services.get<AuthResult>('user', undefined);
                    this.ok(res, { sub: user?.sub });
                }),

            this.route()
                .get('/api/machine/jobs')
                .secure('client')
                .handle(async (req, res) => {
                    const client = await req.services.get<AuthResult>('client', undefined);
                    this.ok(res, { client: client?.sub });
                }),
        ];
    }
}

const app = new WebApplication({
    PORT: 3400,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

app.use(createAuthPlugin(
    new MemoryAuthProvider({
        validTokens: {
            [USER_TOKEN]: { sub: 'user-1', claims: { kind: 'user' }, token: USER_TOKEN },
        },
    }),
    { serviceName: 'user-auth', userServiceName: 'user' },
));

app.use(createAuthPlugin(
    new MemoryAuthProvider({
        principalType: 'client',
        validTokens: {
            [CLIENT_TOKEN]: { sub: 'client-1', claims: { kind: 'client' }, token: CLIENT_TOKEN },
        },
    }),
    { serviceName: 'client-auth', userServiceName: 'client' },
));

app.registerController('', ApiController);

await app.start();
```

In production, swap the `MemoryAuthProvider` instances for real providers — for example, JWT for human users and introspection for machine clients.

---

## How do I set up the OIDC browser login flow with server-side sessions?

Subclass `OidcAuthController` to expose the BFF routes (`login`, `callback`, `logout`, `me`, `refresh`) under a configurable prefix, and register an `OidcAuthProvider` — with a `CacheProvider` from `blendsdk/webafx-cache` as `sessionStore` — through `createAuthPlugin()`, which also makes the session cookie available to authenticated routes. The controller resolves that provider from the `auth` service by default, handles PKCE, state and nonce, and stores sessions under `oidc:session:<id>` in the cache behind an httpOnly cookie. The example takes the session store as a parameter — pass the `CacheProvider` you create with `blendsdk/webafx-cache`.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { Request, Response } from 'express';
import type { CacheProvider } from 'blendsdk/webafx-cache';
import {
    OidcAuthProvider,
    OidcAuthController,
    createAuthPlugin,
} from 'blendsdk/webafx-auth';
import type { OidcTokens } from 'blendsdk/webafx-auth';

class CompanyOidcController extends OidcAuthController {
    protected getRoutePrefix(): string {
        return '/api/sso';
    }

    protected async onCallback(
        tokens: OidcTokens,
        userInfo: Record<string, unknown>,
        _req: Request,
        _res: Response,
    ) {
        return {
            tokens,
            userInfo: { ...userInfo, tenant: 'acme' },
        };
    }
}

export function createAuthApp(sessionStore: CacheProvider): WebApplication {
    const app = new WebApplication({
        PORT: 3400,
        ENV_MODE: 'development',
        LOG_LEVEL: 'ERROR',
    });

    app.use(createAuthPlugin(new OidcAuthProvider({
        issuerUrl: 'https://login.example.com',
        clientId: 'web-app',
        clientSecret: 'web-app-secret',
        redirectUri: 'https://app.example.com/api/sso/callback',
        sessionStore,
    })));

    app.registerController('', CompanyOidcController);

    return app;
}
```

The `/api/sso/me` endpoint returns only user claims and session expiry — never tokens — and cookie security follows the environment: httpOnly and `SameSite=Lax` always, `Secure` in production.

---

## How do I rotate the OIDC session ID on refresh?

Set `rotateSessionIdOnRefresh: true` on the OIDC provider; each successful `POST /api/oidc/refresh` then stores the session under a fresh opaque id, deletes the old entry, and re-issues the cookie, so an id captured before the refresh stops resolving. Rotation is off by default and applies only to successful refreshes — a missing session (401), a missing refresh token (400), or a failed refresh/store leaves the existing session and cookie untouched. The refresh handler lives on `OidcAuthController`, so register the controller as shown.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { CacheProvider } from 'blendsdk/webafx-cache';
import { OidcAuthProvider, OidcAuthController, createAuthPlugin } from 'blendsdk/webafx-auth';

class AppOidcController extends OidcAuthController {}

export function createRotatingAuthApp(sessionStore: CacheProvider): WebApplication {
    const app = new WebApplication({
        PORT: 3400,
        ENV_MODE: 'development',
        LOG_LEVEL: 'ERROR',
    });

    app.use(createAuthPlugin(new OidcAuthProvider({
        issuerUrl: 'https://login.example.com',
        clientId: 'web-app',
        clientSecret: 'web-app-secret',
        redirectUri: 'https://app.example.com/api/oidc/callback',
        sessionStore,
        rotateSessionIdOnRefresh: true,
    })));

    app.registerController('', AppOidcController);

    return app;
}
```

---

## How do I check auth health and shut down cleanly?

Call `health()` to verify the provider is operational — always `true` for JWT and memory providers, a connectivity check for introspection and OIDC — and `shutdown()` to release cached keys, discovery state, sessions, and connections. WebAFX drives both during the application lifecycle: the function returned by `app.start()` shuts the application down and cascades to the provider.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { JwtAuthProvider, createAuthPlugin } from 'blendsdk/webafx-auth';

const provider = new JwtAuthProvider({
    secret: 'a-development-only-secret-at-least-32-bytes!',
});

const healthy = await provider.health();
if (!healthy) {
    throw new Error('Auth provider is not operational');
}

const app = new WebApplication({
    PORT: 3400,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

app.use(createAuthPlugin(provider));

const shutdown = await app.start();

await shutdown();
```

---

# webafx-auth Examples Library

This library collects copy-paste ready examples for every major feature of `blendsdk/webafx-auth`, ordered from simple to complex within each category. Every example is a complete TypeScript module with all imports included. Examples that need external infrastructure — a reachable OIDC provider or introspection endpoint, or a `CacheProvider` from `blendsdk/webafx-cache` — state that requirement in their description.

---

## Basic Application Setup

### Minimal JWT-Protected Application

Register the JWT plugin and protect a route; the authenticated principal is read from the per-request `user` service. Tokens must be HS256-signed with the configured `secret` (issuer and audience checks are optional).

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
                    this.ok(res, {
                        sub: user?.sub,
                        scopes: user?.scopes,
                    });
                }),
        ];
    }
}

const app = new WebApplication({
    PORT: 3400,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

// Registers the provider as singleton service 'auth' and the current
// principal as per-request service 'user'.
app.use(jwtAuthPlugin({
    secret: 'a-development-only-secret-of-at-least-32-bytes',
}));

app.registerController('', ProfileController);
await app.start();
```

**Expected result**
- `GET /profile` with `Authorization: Bearer <valid JWT>` → `200`, with `sub` and `scopes` in the response body's `data`.
- `GET /profile` without a token → `401`.

---

### Development Tokens with MemoryAuthProvider

Use the in-memory provider to run a fully working auth setup locally — no IdP, no crypto, no network. Tokens listed in `validTokens` authenticate; everything else is rejected.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { memoryAuthPlugin } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const DEV_TOKEN = 'dev-token-123';

const DEV_PRINCIPAL: AuthResult = {
    sub: 'dev-user',
    claims: { role: 'admin' },
    token: DEV_TOKEN,
    scopes: ['admin'],
};

class DevController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated()
                .get('/dev/whoami')
                .handle(async (req, res) => {
                    const user = await req.services.get<AuthResult>('user', undefined);
                    this.ok(res, { sub: user?.sub, role: user?.claims.role });
                }),
        ];
    }
}

const app = new WebApplication({
    PORT: 3401,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

app.use(memoryAuthPlugin({ validTokens: { [DEV_TOKEN]: DEV_PRINCIPAL } }));
app.registerController('', DevController);
await app.start();
```

**Expected result**
- `GET /dev/whoami` with `Authorization: Bearer dev-token-123` → `200` with `{ sub: 'dev-user', role: 'admin' }`.
- Any other token → `401`.

---

### Optional Authentication on a Public Route

A public route has no credential guard, but the `user` service still resolves — it returns `undefined` when the request carries no valid token. This lets one handler serve both anonymous and authenticated callers.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { memoryAuthPlugin } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const TOKEN = 'demo-token';

class FeedController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            // A public route: no `.secure(...)` guard, so the request is never
            // rejected. The 'user' service simply resolves to undefined
            // without credentials.
            this.route()
                .get('/feed')
                .handle(async (req, res) => {
                    const user = await req.services.get<AuthResult>('user', undefined);
                    this.ok(res, {
                        authenticated: user !== undefined,
                        sub: user?.sub ?? null,
                    });
                }),
        ];
    }
}

const app = new WebApplication({
    PORT: 3402,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

app.use(memoryAuthPlugin({
    validTokens: {
        [TOKEN]: { sub: 'user-1', claims: { role: 'reader' }, token: TOKEN },
    },
}));

app.registerController('', FeedController);
await app.start();
```

**Expected result**
- `GET /feed` → `200` with `{ authenticated: false, sub: null }`.
- `GET /feed` with `Authorization: Bearer demo-token` → `200` with `{ authenticated: true, sub: 'user-1' }`.

---

## Token Extraction

### Multi-Source Fallback Chain (Header → Cookie → Query)

The `tokenSources` option builds an ordered extraction chain; the first non-empty match wins. This example accepts bearer headers for APIs, cookies for browsers, and query parameters for callback-style endpoints — all on one route.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { createAuthPlugin, MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const HEADER_USER: AuthResult = { sub: 'header-user', claims: {}, token: 'header-token' };
const COOKIE_USER: AuthResult = { sub: 'cookie-user', claims: {}, token: 'cookie-token' };
const QUERY_USER: AuthResult = { sub: 'query-user', claims: {}, token: 'query-token' };

const provider = new MemoryAuthProvider({
    // Default is ['header'] only; extend it with fallbacks in priority order.
    tokenSources: ['header', 'cookie', 'query'],
    validTokens: {
        'header-token': HEADER_USER,
        'cookie-token': COOKIE_USER,
        'query-token': QUERY_USER,
    },
});

class ChainController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated()
                .get('/chain')
                .handle(async (req, res) => {
                    const user = await req.services.get<AuthResult>('user', undefined);
                    this.ok(res, { sub: user?.sub });
                }),
        ];
    }
}

const app = new WebApplication({
    PORT: 3403,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

app.use(createAuthPlugin(provider));
app.registerController('', ChainController);
await app.start();
```

**Expected result** (chain order: header → cookie → query)
- Bearer header + `auth_token` cookie + `?token=` all present → authenticated as `header-user`.
- Only cookie `auth_token=cookie-token` → `cookie-user`.
- Only `?token=query-token` → `query-user`.
- No credentials at all → `401`.

---

### Custom Token Source (API-Key Header)

Any extraction location can be added with a custom `TokenSource`. This example reads a token from an `X-API-Key` header while keeping the standard bearer header as the first source.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { createAuthPlugin, MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult, TokenSource } from 'blendsdk/webafx-auth';

const API_KEY = 'key-abc-123';

const API_KEY_PRINCIPAL: AuthResult = {
    sub: 'machine-client',
    claims: { kind: 'service' },
    token: API_KEY,
    principalType: 'client',
};

// Custom source: read the token from an `X-API-Key` header.
const apiKeySource: TokenSource = {
    extractor: (req) => {
        const value = req.headers['x-api-key'];
        return typeof value === 'string' ? value : undefined;
    },
};

const provider = new MemoryAuthProvider({
    tokenSources: ['header', apiKeySource],
    validTokens: { [API_KEY]: API_KEY_PRINCIPAL },
});

class MachineController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.route()
                .get('/machine/status')
                .secure('client')
                .handle(async (req, res) => {
                    const client = await req.services.get<AuthResult>('client', undefined);
                    this.ok(res, { sub: client?.sub });
                }),
        ];
    }
}

const app = new WebApplication({
    PORT: 3404,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

// Registers the principal under the per-request service name 'client'.
app.use(createAuthPlugin(provider, { userServiceName: 'client' }));
app.registerController('', MachineController);
await app.start();
```

**Expected result**
- `GET /machine/status` with `X-API-Key: key-abc-123` → `200` with `{ sub: 'machine-client' }`.
- Without the header → `401`.

---

### Custom Cookie and Query Parameter Names

The `cookie` and `query` sources read from configurable names — useful when integrating with an existing session cookie or an `access_token` query convention. This example uses `session_token` for browsers and `access_token` for query-based clients such as SSE consumers.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { createAuthPlugin, MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const BROWSER_USER: AuthResult = { sub: 'browser-user', claims: {}, token: 'session-value' };
const SSE_USER: AuthResult = { sub: 'sse-user', claims: {}, token: 'query-value' };

const provider = new MemoryAuthProvider({
    tokenSources: ['cookie', 'query'],
    cookieName: 'session_token',     // default: 'auth_token'
    queryParamName: 'access_token',  // default: 'token'
    validTokens: {
        'session-value': BROWSER_USER,
        'query-value': SSE_USER,
    },
});

class StreamController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated()
                .get('/stream')
                .handle(async (req, res) => {
                    const user = await req.services.get<AuthResult>('user', undefined);
                    this.ok(res, { sub: user?.sub });
                }),
        ];
    }
}

const app = new WebApplication({
    PORT: 3405,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

app.use(createAuthPlugin(provider));
app.registerController('', StreamController);
await app.start();
```

**Expected result**
- `Cookie: session_token=session-value` → authenticated as `browser-user`.
- `GET /stream?access_token=query-value` → authenticated as `sse-user`.
- The default names `auth_token` / `token` are ignored.

---

## JWT Verification

### Verify a Locally Signed JWT

The provider verifies tokens locally — no network calls. This example mints an HS256 token with `jose` (a dependency shipped with this package) and validates it with matching issuer and audience settings.

```typescript
import { SignJWT } from 'jose';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const SECRET = 'a-development-only-secret-of-at-least-32-bytes';
const ISSUER = 'https://auth.test.example.com';
const AUDIENCE = 'my-api';

// Mint an HS256 token signed with the same secret the provider will verify.
// In production the token comes from your authorization server instead.
const token = await new SignJWT({ scope: 'read write' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('test-user-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .sign(new TextEncoder().encode(SECRET));

const provider = new JwtAuthProvider({
    secret: SECRET,
    issuer: ISSUER,
    audience: AUDIENCE,
});

const result = await provider.validate(token);

console.log(result?.sub);            // 'test-user-1'
console.log(result?.scopes);         // ['read', 'write']
console.log(result?.token === token); // true — the raw token is echoed back

// Malformed or wrongly signed tokens resolve to undefined — never throw.
console.log(await provider.validate('not-a-jwt')); // undefined

console.log(await provider.health()); // true — verification is local
await provider.shutdown();
```

**Expected result**
- A valid token yields the subject, parsed scopes, expiry, and all raw claims.
- `not-a-jwt` and any token signed with a different secret, wrong issuer, or wrong audience resolve to `undefined`.

---

### Fail-Closed Audience Enforcement

Setting `requireAudience: true` rejects every token when no `audience` is configured, preventing accidental "any audience accepted" deployments. Pinning the audience then accepts only matching tokens (`audience` accepts a string or an array).

```typescript
import { SignJWT } from 'jose';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const SECRET = 'a-development-only-secret-of-at-least-32-bytes';
const ISSUER = 'https://auth.test.example.com';

async function signToken(audience: string): Promise<string> {
    return new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('test-user-1')
        .setIssuedAt()
        .setExpirationTime('5m')
        .setIssuer(ISSUER)
        .setAudience(audience)
        .sign(new TextEncoder().encode(SECRET));
}

// requireAudience without a configured audience fails closed:
// every token is rejected, even ones with a correct signature.
const strictProvider = new JwtAuthProvider({
    secret: SECRET,
    issuer: ISSUER,
    requireAudience: true,
});
console.log(await strictProvider.validate(await signToken('any-api'))); // undefined

// Pinning the audience accepts only matching tokens.
const pinnedProvider = new JwtAuthProvider({
    secret: SECRET,
    issuer: ISSUER,
    audience: 'my-api',
    requireAudience: true,
});
console.log((await pinnedProvider.validate(await signToken('my-api')))?.sub); // 'test-user-1'
console.log(await pinnedProvider.validate(await signToken('other-api')));     // undefined

await strictProvider.shutdown();
await pinnedProvider.shutdown();
```

**Expected result**
- The strict provider rejects a correctly signed token because no audience is configured.
- The pinned provider accepts `aud = 'my-api'` and rejects `aud = 'other-api'`.

---

### Clock Tolerance for Distributed Systems

`clockTolerance` (in seconds) accepts tokens that expired within the window, absorbing small clock skew between the token issuer and the API host without weakening verification.

```typescript
import { SignJWT } from 'jose';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const SECRET = 'a-development-only-secret-of-at-least-32-bytes';

async function signExpired(secondsAgo: number): Promise<string> {
    return new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('test-user-1')
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) - secondsAgo)
        .sign(new TextEncoder().encode(SECRET));
}

const provider = new JwtAuthProvider({
    secret: SECRET,
    clockTolerance: 120, // accept tokens that expired up to 2 minutes ago
});

// Expired 30 seconds ago — inside the tolerance window.
console.log((await provider.validate(await signExpired(30)))?.sub); // 'test-user-1'

// Expired 5 minutes ago — outside the tolerance window.
console.log(await provider.validate(await signExpired(300))); // undefined

await provider.shutdown();
```

**Expected result**
- The token expired 30 seconds ago authenticates because of the 120-second tolerance.
- The token expired 5 minutes ago is rejected.

---

## Claims Mapping and Principal Types

### Default Claims Mapper — Flexible Claim Formats

The default mapper normalizes the common claim layouts found across identity providers: `sub`/`subject`, numeric `exp`, and `scope`/`scopes` as a space-separated string or an array. All raw claims remain available on `result.claims`.

```typescript
import { SignJWT } from 'jose';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const SECRET = 'a-development-only-secret-of-at-least-32-bytes';

async function sign(claims: Record<string, unknown>): Promise<string> {
    return new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode(SECRET));
}

const provider = new JwtAuthProvider({ secret: SECRET });

// Subject: 'sub' wins, 'subject' is the legacy fallback, 'unknown' as last resort.
console.log((await provider.validate(await sign({ sub: 'user-1' })))?.sub);       // 'user-1'
console.log((await provider.validate(await sign({ subject: 'legacy-7' })))?.sub); // 'legacy-7'
console.log((await provider.validate(await sign({})))?.sub);                      // 'unknown'

// OAuth2 standard: 'scope' as a space-separated string (empty entries filtered).
console.log((await provider.validate(await sign({ scope: 'openid profile  email' })))?.scopes);
// ['openid', 'profile', 'email']

// Alternate formats: 'scope' or 'scopes' as arrays.
console.log((await provider.validate(await sign({ scope: ['read', 'write'] })))?.scopes);
// ['read', 'write']
console.log((await provider.validate(await sign({ scopes: ['admin'] })))?.scopes);
// ['admin']

// All raw claims stay available on the result.
const rich = await provider.validate(await sign({ role: 'admin', department: 'engineering' }));
console.log(rich?.claims.role);       // 'admin'
console.log(rich?.claims.department); // 'engineering'

await provider.shutdown();
```

**Expected result**
- Each `console.log` prints the values shown in the inline comments.
- A token without any scope claim yields `scopes === undefined`.

---

### Custom mapClaims and Principal-Type Precedence

The `mapClaims` option fully replaces the default mapper — use it for non-standard claim layouts. The `principalType` config is a default: it fills the result only when the mapper (or the stored result) does not set one.

```typescript
import { SignJWT } from 'jose';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';
import type { ClaimsMapper } from 'blendsdk/webafx-auth';

const SECRET = 'a-development-only-secret-of-at-least-32-bytes';

async function sign(claims: Record<string, unknown>): Promise<string> {
    return new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode(SECRET));
}

// Map a non-standard layout: 'user_id' for the subject, 'permissions' for scopes.
const mapClaims: ClaimsMapper = (token, rawClaims) => ({
    sub: String(rawClaims.user_id ?? rawClaims.sub ?? 'unknown'),
    claims: rawClaims,
    token,
    scopes: Array.isArray(rawClaims.permissions)
        ? rawClaims.permissions.map(String)
        : undefined,
});

const provider = new JwtAuthProvider({
    secret: SECRET,
    principalType: 'client',
    mapClaims,
});

const result = await provider.validate(
    await sign({ user_id: 'usr-99', permissions: ['read', 'write'] })
);
console.log(result?.sub);           // 'usr-99'
console.log(result?.scopes);        // ['read', 'write']
console.log(result?.principalType); // 'client' — filled in from config

// A mapper that sets its own principalType stays authoritative.
const overridingMapper: ClaimsMapper = (token, rawClaims) => ({
    sub: String(rawClaims.sub),
    claims: rawClaims,
    token,
    principalType: 'user',
});

const overrideProvider = new JwtAuthProvider({
    secret: SECRET,
    principalType: 'client',
    mapClaims: overridingMapper,
});

const overridden = await overrideProvider.validate(await sign({ sub: 'user-1' }));
console.log(overridden?.principalType); // 'user' — the mapper wins over config

await provider.shutdown();
await overrideProvider.shutdown();
```

**Expected result**
- The first provider maps `user_id`/`permissions` and stamps `principalType: 'client'` from config.
- The second provider keeps `principalType: 'user'` because the mapper set it explicitly.

---

## MemoryAuthProvider (Testing and Local Development)

### Stub Authentication with Pre-Configured Tokens

`MemoryAuthProvider` returns stored `AuthResult` objects by exact token lookup — no network, no crypto, fully deterministic. Ideal for unit tests and local development.

```typescript
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const ADMIN_RESULT: AuthResult = {
    sub: 'admin-1',
    claims: { role: 'admin' },
    token: 'admin-token',
    scopes: ['read', 'write', 'delete'],
};

const provider = new MemoryAuthProvider({
    validTokens: {
        'admin-token': ADMIN_RESULT,
        'user-token': { sub: 'user-1', claims: { role: 'user' }, token: 'user-token', scopes: ['read'] },
    },
});

console.log(await provider.validate('admin-token'));
// { sub: 'admin-1', claims: { role: 'admin' }, token: 'admin-token', scopes: [...] }

console.log((await provider.validate('user-token'))?.scopes); // ['read']

// Unknown and empty tokens resolve to undefined — never throw.
console.log(await provider.validate('unknown-token')); // undefined
console.log(await provider.validate(''));              // undefined

console.log(provider.getTokenCount()); // 2
console.log(await provider.health());  // true — no external dependencies

await provider.shutdown();
console.log(provider.getTokenCount()); // 0 — shutdown clears the token map
```

**Expected result**
- Registered tokens return their stored `AuthResult`; anything else returns `undefined`.
- `health()` is always `true`; `shutdown()` clears the token map and is safe to call repeatedly.

---

### Manage Tokens at Runtime

Tokens can be added, overwritten, and removed while the provider is live — useful for simulating login/logout cycles or rotating test fixtures.

```typescript
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const provider = new MemoryAuthProvider();

function principal(sub: string, role: string): AuthResult {
    return { sub, claims: { role }, token: sub };
}

provider.addToken('token-a', principal('user-a', 'admin'));
provider.addToken('token-b', principal('user-b', 'user'));

console.log(provider.getTokenCount()); // 2

provider.removeToken('token-b');
console.log(provider.getTokenCount()); // 1
console.log(provider.removeToken('token-b')); // false — already removed

// Overwriting an existing token replaces its principal.
provider.addToken('token-a', principal('user-a', 'owner'));
console.log((await provider.validate('token-a'))?.claims.role); // 'owner'

await provider.shutdown();
await provider.shutdown(); // safe to call multiple times
console.log(provider.getTokenCount()); // 0
```

**Expected result**
- `addToken()` inserts or replaces, `removeToken()` returns `true` only when a token was removed, and `getTokenCount()` reflects the current map size.

---

## Token Introspection (RFC 7662)

### Validate an Opaque Token with Static Credentials

For authorization servers that issue opaque tokens, `IntrospectionAuthProvider` calls the RFC 7662 endpoint and maps the response. Credentials are sent via HTTP Basic auth (`client_secret_basic`) by default. Requires a reachable introspection endpoint.

```typescript
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';

const provider = new IntrospectionAuthProvider({
    introspectionUrl: 'https://auth.example.com/oauth2/introspect',
    clientId: 'my-service',
    clientSecret: 'my-service-secret',
});

// Given the endpoint answers
//   { "active": true, "sub": "user-1", "scope": "read write", "exp": 4102444800 }
const result = await provider.validate('opaque-access-token');

console.log(result?.sub);           // 'user-1'
console.log(result?.scopes);        // ['read', 'write']
console.log(result?.claims.active); // true

// Inactive tokens resolve to undefined.
console.log(await provider.validate('revoked-token')); // undefined (when active: false)

await provider.shutdown();
```

**Expected result**
- `active: true` maps to an `AuthResult`; `active: false` maps to `undefined`.
- Non-2xx responses and network failures throw (infrastructure errors, not auth failures).

---

### client_secret_post and Audience Enforcement

Some authorization servers require credentials in the form body instead of the Authorization header. This example switches to `client_secret_post` and pins the token audience.

```typescript
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';

const provider = new IntrospectionAuthProvider({
    introspectionUrl: 'https://auth.example.com/oauth2/introspect',
    clientId: 'my-service',
    clientSecret: 'my-service-secret',
    // Credentials travel in the form body instead of the Authorization header.
    authMethod: 'post',
    // Accept only tokens minted for this API (string or string[]).
    audience: 'my-api',
});

const accepted = await provider.validate('token-for-my-api');
console.log(accepted !== undefined); // true — aud matched

const rejected = await provider.validate('token-for-other-api');
console.log(rejected); // undefined — aud mismatch or missing aud

// Infrastructure failures throw; invalid tokens never do.
try {
    await provider.validate('token-for-my-api');
} catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
}

await provider.shutdown();
```

**Expected result**
- With `aud: 'my-api'` in the introspection response the token authenticates; a different or missing `aud` yields `undefined`.
- A timeout, refused connection, or 5xx response throws an `Error` containing the status — never the token or client secret.

---

### Tune the Response Cache

Active introspection responses are cached in memory: keys are SHA-256 digests of the token, TTLs are clamped to the token's own `exp`, and eviction follows LRU order at `maxCacheSize`.

```typescript
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';

const provider = new IntrospectionAuthProvider({
    introspectionUrl: 'https://auth.example.com/oauth2/introspect',
    clientId: 'my-service',
    clientSecret: 'my-service-secret',
    cacheTTL: 60,       // seconds; clamped to the token's exp when shorter
    maxCacheSize: 500,  // LRU entries; the least recently used is evicted first
    timeout: 5000,      // ms; the request is aborted after this
});

// First call hits the endpoint and caches the active response.
await provider.validate('opaque-token');
// Second call within the TTL is served from memory. Cache keys are SHA-256
// digests — the raw token is never used as a key.
await provider.validate('opaque-token');

// shutdown() drops the cache; the next call hits the endpoint again.
await provider.shutdown();
await provider.validate('opaque-token');
```

**Expected result**
- Repeated validations of the same token within the TTL perform a single HTTP request.
- After `shutdown()`, the same token triggers a fresh request. Inactive responses, expired tokens, and failed requests are never cached.

---

### Per-Tenant Credentials with configFactory

When credentials depend on the request, provide a `configFactory` instead of static fields. The factory runs on every `authenticate()` call and its results are cached per resolved configuration.

```typescript
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';

const provider = new IntrospectionAuthProvider({
    configFactory: async (req) => {
        const tenant = String(req.headers['x-tenant'] ?? 'default');
        return {
            introspectionUrl: `https://${tenant}.example.com/oauth2/introspect`,
            clientId: `service-${tenant}`,
            clientSecret: `secret-${tenant}`,
        };
    },
});

// Without a request there is no tenant context: validate() returns undefined
// and never calls the endpoint.
console.log(await provider.validate('opaque-token')); // undefined

// authenticate(req) — or the plugin, which calls it per request — resolves the
// tenant from the request. Each tenant's responses are cached separately, so
// the same token validated for two tenants triggers two endpoint calls.
```

**Expected result**
- `validate()` without request context resolves to `undefined`.
- Requests routed through `authenticate()` (or `createAuthPlugin()`) use the tenant-specific endpoint and credentials.
- A `configFactory` error, or a factory that resolves an incomplete config, propagates as a rejected promise.

---

## OIDC Provider

### Validate IdP-Issued Bearer Tokens

`OidcAuthProvider` discovers the issuer's JWKS metadata lazily on the first validation and verifies tokens locally afterwards. Discovery results are cached per issuer and refreshed after `discoveryTtl` seconds. Requires a reachable OIDC issuer.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { oidcAuthPlugin } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

class ApiController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated()
                .get('/api/data')
                .handle(async (req, res) => {
                    const user = await req.services.get<AuthResult>('user', undefined);
                    this.ok(res, { sub: user?.sub });
                }),
        ];
    }
}

const app = new WebApplication({
    PORT: 3406,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

// Discovery + JWKS run lazily on the first validation; the metadata is cached
// per issuer (default and configurable via `discoveryTtl`).
app.use(oidcAuthPlugin({
    issuerUrl: 'https://idp.example.com',
    clientId: 'my-api',
    audience: 'https://api.example.com',
}));

app.registerController('', ApiController);
await app.start();
```

**Expected result**
- A valid IdP-issued access token → `200`; a wrong audience, wrong signature, or expired token → `401` (silent rejection).
- `requireAudience: true` fails closed when no audience is configured, matching the JWT provider behavior.

---

### Bearer Tokens with a Session-Cookie Fallback

When a `sessionStore` is configured, `authenticate()` accepts either a bearer JWT or the server-side session referenced by the session cookie. Requires a `CacheProvider` from `blendsdk/webafx-cache`.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { CacheProvider } from 'blendsdk/webafx-cache';
import { OidcAuthProvider, createAuthPlugin } from 'blendsdk/webafx-auth';

/**
 * Installs an OIDC provider that accepts bearer JWTs first and falls back to
 * the server-side session referenced by the `__oidc_session` cookie.
 */
export function installDualModeAuth(app: WebApplication, sessionStore: CacheProvider): void {
    const provider = new OidcAuthProvider({
        issuerUrl: 'https://idp.example.com',
        clientId: 'my-app',
        audience: 'https://api.example.com',
        sessionStore,
    });

    app.use(createAuthPlugin(provider));
}
```

**Expected result**
- Bearer token present → validated against the issuer's JWKS; the CacheProvider is never consulted.
- No bearer token, `__oidc_session` cookie present → session looked up in the store; a missing or expired session yields `401`. Session results always report `principalType: 'user'`.
- Both present → the bearer token wins.

---

### Store and Retrieve Server-Side Sessions

Session and PKCE state CRUD are delegated to the provider and namespaced under separate cache prefixes (`oidc:session:` / `oidc:state:`). Calls without a configured `sessionStore` throw `sessionStore is required`. Requires a `CacheProvider`.

```typescript
import type { CacheProvider } from 'blendsdk/webafx-cache';
import { OidcAuthProvider } from 'blendsdk/webafx-auth';
import type { OidcSession, OidcSessionState } from 'blendsdk/webafx-auth';

export async function manageSessions(sessionStore: CacheProvider): Promise<void> {
    const provider = new OidcAuthProvider({
        issuerUrl: 'https://idp.example.com',
        clientId: 'my-app',
        sessionStore,
        sessionTtl: 3600, // seconds; default 3600
        stateTtl: 300,    // seconds; default 300 (short-lived PKCE state)
    });

    const session: OidcSession = {
        accessToken: 'access-token-123',
        refreshToken: 'refresh-token-456',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        user: { sub: 'user-1', email: 'user@example.com' },
    };
    await provider.storeSession('session-uuid', session);

    const stored = await provider.getSession('session-uuid');
    console.log(stored?.user.sub); // 'user-1'

    await provider.clearSession('session-uuid');
    console.log(await provider.getSession('session-uuid')); // undefined

    // Transient PKCE state lives in its own namespace with its own TTL.
    const state: OidcSessionState = {
        codeVerifier: 'pkce-verifier',
        state: 'random-state',
        nonce: 'random-nonce',
        returnTo: '/dashboard',
    };
    await provider.storeState('state-uuid', state);
    console.log((await provider.getState('state-uuid'))?.returnTo); // '/dashboard'
    await provider.clearState('state-uuid');
}
```

**Expected result**
- A stored session round-trips through `getSession()` and disappears after `clearSession()`.
- Sessions and states stored under the same ID never collide because their cache keys use different prefixes.

---

### Tenant-Scoped Session and State Cookies

Multi-tenant deployments can resolve cookie names per request. Two tenants can therefore keep independent sessions in the same browser. Requires a `CacheProvider`.

```typescript
import type { CacheProvider } from 'blendsdk/webafx-cache';
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

export function createTenantScopedProvider(sessionStore: CacheProvider): OidcAuthProvider {
    return new OidcAuthProvider({
        issuerUrl: 'https://idp.example.com',
        clientId: 'my-app',
        sessionStore,
        // The cookie carrying the session id is scoped per tenant...
        resolveSessionCookieName: (req) => {
            const tenant = req.headers['x-tenant'];
            return `__oidc_session_${typeof tenant === 'string' ? tenant : 'default'}`;
        },
        // ...and so is the transient PKCE state cookie.
        resolveStateCookieName: (req) => {
            const tenant = req.headers['x-tenant'];
            return `__oidc_state_${typeof tenant === 'string' ? tenant : 'default'}`;
        },
    });
}
```

**Expected result**
- A request with `x-tenant: acme` reads and writes the `__oidc_session_acme` / `__oidc_state_acme` cookies.
- Without the resolver, the defaults `__oidc_session` and `__oidc_state` are used.

---

## OIDC Browser Login (BFF Controller)

### Wire the OIDC Login Flow into an Application

`OidcAuthController` exposes the authorization code flow with PKCE as backend-for-frontend routes. It has no abstract members — an empty subclass works — and resolves the provider from the DI container (service `auth`). Requires a `CacheProvider` for server-side sessions.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { CacheProvider } from 'blendsdk/webafx-cache';
import { OidcAuthController, oidcAuthPlugin } from 'blendsdk/webafx-auth';

/** The base class resolves the provider from the DI container — no overrides needed. */
class AppOidcController extends OidcAuthController {}

export function installOidcLogin(app: WebApplication, sessionStore: CacheProvider): void {
    app.use(oidcAuthPlugin({
        issuerUrl: 'https://idp.example.com',
        clientId: 'my-app',
        clientSecret: 'my-app-secret',
        redirectUri: 'https://app.example.com/api/oidc/callback',
        sessionStore,
    }));

    app.registerController('', AppOidcController);
}
```

**Expected result** (default route prefix `/api/oidc`)
- `GET /api/oidc/login` → `302` to the IdP; PKCE verifier, state, and nonce stored server-side.
- `GET /api/oidc/callback` → exchanges the code, fetches UserInfo, stores the session, sets the `__oidc_session` cookie, and redirects to `returnTo` (default `/`). The `iss` parameter is forwarded to the token request when the IdP sends it (RFC 9207).
- `GET /api/oidc/me` → user claims and expiry only — never tokens.
- `POST /api/oidc/refresh` → refreshed tokens with a sliding session cookie; `POST /api/oidc/logout` → best-effort revocation and cookie cleared.

---

### Enrich the User Profile in onCallback

The `onCallback` hook runs after the code exchange and UserInfo fetch, right before the session is stored. Returning modified `tokens`/`userInfo` lets you attach application-specific data to the session.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { CacheProvider } from 'blendsdk/webafx-cache';
import { OidcAuthController, oidcAuthPlugin } from 'blendsdk/webafx-auth';
import type { OidcTokens } from 'blendsdk/webafx-auth';

class EnrichingOidcController extends OidcAuthController {
    protected async onCallback(
        tokens: OidcTokens,
        userInfo: Record<string, unknown>,
    ): Promise<{ tokens: OidcTokens; userInfo: Record<string, unknown> }> {
        return {
            tokens,
            userInfo: {
                ...userInfo,
                appRole: 'member',
            },
        };
    }
}

export function installEnrichingLogin(app: WebApplication, sessionStore: CacheProvider): void {
    app.use(oidcAuthPlugin({
        issuerUrl: 'https://idp.example.com',
        clientId: 'my-app',
        clientSecret: 'my-app-secret',
        redirectUri: 'https://app.example.com/api/oidc/callback',
        sessionStore,
    }));

    app.registerController('', EnrichingOidcController);
}
```

**Expected result**
- After login, `GET /api/oidc/me` returns the IdP's claims plus `appRole: 'member'` in `data.user`.
- The enriched object is what subsequent session-cookie authentications expose as `claims`.

---

### Custom Route Prefix and Forced Consent

Override `getRoutePrefix()` to move the flow, and `getLoginParams()` to add fixed authorization parameters to every login request. (The default `getLoginParams()` forwards `prompt` and `login_hint` from the request's query string; the override replaces that behavior.)

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { CacheProvider } from 'blendsdk/webafx-cache';
import { OidcAuthController, oidcAuthPlugin } from 'blendsdk/webafx-auth';
import type { BuildAuthorizationUrlParams } from 'blendsdk/webafx-auth';

class BrandedOidcController extends OidcAuthController {
    // Move the flow under a custom prefix: '/auth/oidc/login', etc.
    protected getRoutePrefix(): string {
        return '/auth/oidc';
    }

    // Add extra parameters to every authorization request.
    protected getLoginParams(): BuildAuthorizationUrlParams {
        return {
            extraParams: {
                prompt: 'consent',
                acr_values: 'urn:mace:incommon:iap:silver',
            },
        };
    }
}

export function installBrandedLogin(app: WebApplication, sessionStore: CacheProvider): void {
    app.use(oidcAuthPlugin({
        issuerUrl: 'https://idp.example.com',
        clientId: 'my-app',
        clientSecret: 'my-app-secret',
        redirectUri: 'https://app.example.com/auth/oidc/callback',
        sessionStore,
    }));

    app.registerController('', BrandedOidcController);
}
```

**Expected result**
- Routes live under `/auth/oidc/*` instead of `/api/oidc/*`.
- Every `/auth/oidc/login` redirect includes `prompt=consent` and `acr_values=urn:mace:incommon:iap:silver` in the authorization URL.

---

## Provider Factory

### Build a Provider from a Single Config Object

`createAuthProvider()` selects a concrete provider from one `AuthFactoryConfig` — convenient when the provider type is chosen per environment. Pair it with `createAuthPlugin()` to register the resulting instance.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { createAuthProvider, createAuthPlugin } from 'blendsdk/webafx-auth';

export function installAuth(app: WebApplication): void {
    const provider = createAuthProvider({
        type: 'jwt',
        secret: 'a-development-only-secret-of-at-least-32-bytes',
        issuer: 'https://auth.example.com',
        audience: 'my-api',
    });

    // The factory returns a JwtAuthProvider; the plugin registers it as the
    // singleton service 'auth' plus the per-request service 'user'.
    app.use(createAuthPlugin(provider));
}
```

**Expected result**
- `type: 'jwt' | 'introspection' | 'oidc' | 'memory'` dispatches to the matching provider class; shared options (`serviceName`, `tokenSources`, `mapClaims`, `principalType`, ...) are forwarded to every provider.

---

### Fail Fast on Incomplete Configuration

The factory validates every required field up front and throws a field-specific error, so a misconfiguration surfaces at startup instead of at the first request.

```typescript
import { createAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthFactoryConfig } from 'blendsdk/webafx-auth';

const incomplete: AuthFactoryConfig[] = [
    { type: 'jwt' },
    { type: 'oidc' },
    { type: 'introspection' },
];

for (const config of incomplete) {
    try {
        createAuthProvider(config);
    } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
    }
}

// Output:
// createAuthProvider: type 'jwt' requires 'secret'
// createAuthProvider: type 'oidc' requires 'issuerUrl'
// createAuthProvider: type 'introspection' requires 'introspectionUrl', 'clientId' and 'clientSecret', or 'configFactory'
```

**Expected result**
- Each invalid configuration throws an `Error` whose message names the missing field.
- `type: 'memory'` requires nothing and never throws.

---

## Multi-Provider Routing

### Run User and Machine Providers Side by Side

Two `createAuthPlugin()` calls with distinct `serviceName`s install two independent providers. Each route selects its provider through the principal service it names.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { createAuthPlugin, MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const USER_TOKEN = 'user-token';
const CLIENT_TOKEN = 'client-token';

const USER_RESULT: AuthResult = {
    sub: 'user-1',
    claims: { kind: 'user' },
    token: USER_TOKEN,
    principalType: 'user',
};

const CLIENT_RESULT: AuthResult = {
    sub: 'client-1',
    claims: { kind: 'client' },
    token: CLIENT_TOKEN,
    principalType: 'client',
};

class MultiProviderController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            // Default route: authenticates against the principal service 'user'.
            this.authenticated()
                .get('/mp/user')
                .handle(async (req, res) => {
                    const user = await req.services.get<AuthResult>('user', undefined);
                    this.ok(res, { sub: user?.sub });
                }),

            // Machine route: authenticates against the principal service 'client'.
            this.route()
                .get('/mp/client')
                .secure('client')
                .handle(async (req, res) => {
                    const client = await req.services.get<AuthResult>('client', undefined);
                    this.ok(res, { sub: client?.sub });
                }),
        ];
    }
}

const app = new WebApplication({
    PORT: 3407,
    ENV_MODE: 'test',
    LOG_LEVEL: 'ERROR',
});

// Distinct plugin + service names are required: two plugins cannot share
// the default name 'auth:auth'.
app.use(createAuthPlugin(
    new MemoryAuthProvider({ validTokens: { [USER_TOKEN]: USER_RESULT } }),
    { serviceName: 'user-auth', userServiceName: 'user' },
));

app.use(createAuthPlugin(
    new MemoryAuthProvider({ validTokens: { [CLIENT_TOKEN]: CLIENT_RESULT } }),
    { serviceName: 'client-auth', userServiceName: 'client' },
));

app.registerController('', MultiProviderController);
await app.start();
```

**Expected result**
- `GET /mp/client` with the client token → `200` with `{ sub: 'client-1' }`; with the user token → `401`.
- `GET /mp/user` with the user token → `200` with `{ sub: 'user-1' }`; with the client token → `401`.

---

### Name the Plugin Services Explicitly

`AuthPluginOptions` controls the singleton provider service, the per-request principal service, and the plugin ordering. Route guards and `req.services.get()` calls then use these names.

```typescript
import {
    createAuthPlugin,
    MemoryAuthProvider,
    DEFAULT_PLUGIN_PRIORITY,
    DEFAULT_SERVICE_NAME,
} from 'blendsdk/webafx-auth';

const plugin = createAuthPlugin(new MemoryAuthProvider(), {
    serviceName: 'machine-auth', // plugin name: 'auth:machine-auth'
    userServiceName: 'machine',  // per-request principal service name
    priority: 25,                // plugin ordering priority
});

console.log(plugin.name);              // 'auth:machine-auth'
console.log(plugin.priority);          // 25
console.log(DEFAULT_SERVICE_NAME);     // 'auth'
console.log(DEFAULT_PLUGIN_PRIORITY);  // 10 — the default when priority is omitted

// Routes in the application then use `.secure('machine')` and read the
// principal with req.services.get('machine', undefined).
```

**Expected result**
- The plugin registers a singleton service named `machine-auth` and a per-request service named `machine`.
- Omitting `priority` defaults to `DEFAULT_PLUGIN_PRIORITY` (`10`); omitting `serviceName` defaults to `'auth'`, producing the plugin name `'auth:auth'`.

---

### Catch Plugin Name Collisions at Startup

Registering two auth plugins with the same effective service name is rejected synchronously by `app.use()` — before the server starts and before one provider can silently replace another.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { createAuthPlugin, MemoryAuthProvider } from 'blendsdk/webafx-auth';

const app = new WebApplication({
    PORT: 0,
    ENV_MODE: 'test',
    LOG_LEVEL: 'ERROR',
});

app.use(createAuthPlugin(new MemoryAuthProvider()));

try {
    // Same default serviceName → same plugin name 'auth:auth'.
    app.use(createAuthPlugin(new MemoryAuthProvider()));
} catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    // Plugin "auth:auth" is already registered
}
```

**Expected result**
- The second `app.use()` throws with the message `Plugin "auth:auth" is already registered`.
- Giving the second plugin a distinct `serviceName` (as in the multi-provider example) avoids the collision.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
