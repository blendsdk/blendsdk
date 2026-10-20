> **Package**: `blendsdk/webafx-auth`

# webafx-auth Advanced Patterns

This document covers composite, real-world usage patterns built from the public API of `blendsdk/webafx-auth`. Every pattern combines multiple package features — providers, the token extraction chain, the plugin layer, the OIDC BFF controller, and lifecycle hooks — and shows how they fit together with `blendsdk/webafx` (applications, controllers, the secure guard) and `blendsdk/webafx-cache` (server-side OIDC sessions) where the pattern calls for it.

The patterns are ordered from the most common application topologies to progressively deeper customization:

1. Two principals in one application (users + machine clients)
2. Multi-tenant OIDC with per-tenant issuers and scoped cookies
3. A hardened production profile for the OIDC BFF
4. Database-backed tenant credentials for token introspection
5. Zero-downtime migration with a composite JWT + introspection provider
6. A custom `AuthProvider` for proprietary credentials
7. Deterministic integration tests with `MemoryAuthProvider`

---

## Pattern 1: Two Principals in One Application (Users and Machine Clients)

### When to use

Your API serves interactive users *and* service clients in the same WebAFX application, and the two credential kinds must never authenticate interchangeably. Typical triggers:

- A browser-facing API (OIDC BFF sessions or user JWTs) plus machine-to-machine endpoints called with client-credentials JWTs.
- A gradual split where operations endpoints must accept user sessions while internal batch endpoints accept only service tokens.
- You want routes — not handler code — to decide which principal a request must present.

The building blocks are two `createAuthPlugin()` registrations with **distinct `serviceName`s**, each populating its own principal service, and route-level principal selection with `secure(name)`.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { jwtAuthPlugin, oidcAuthPlugin, OidcAuthController } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';
import type { CacheProvider } from 'blendsdk/webafx-cache';

/** Human-facing routes resolve the default 'user' principal. */
class ProfileController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated()
                .get('/api/profile')
                .handle(async (req, res) => {
                    const user = await req.services.get<AuthResult>('user', undefined);
                    this.ok(res, { sub: user?.sub, scopes: user?.scopes ?? [] });
                }),
        ];
    }
}

/** Machine-facing routes resolve the named 'client' principal. */
class ExportController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.route()
                .get('/api/exports/daily')
                .secure('client')
                .handle(async (req, res) => {
                    const client = await req.services.get<AuthResult>('client', undefined);
                    this.ok(res, { requestedBy: client?.sub });
                }),
        ];
    }
}

/** OIDC BFF routes: /api/oidc/login, /callback, /logout, /me, /refresh. */
class AuthController extends OidcAuthController {}

interface ApiSettings {
    oidc: {
        issuerUrl: string;
        clientId: string;
        clientSecret: string;
        redirectUri: string;
    };
    machine: {
        secret: string;
        issuer: string;
        audience: string;
    };
    sessionStore: CacheProvider;
}

export function createApi(settings: ApiSettings): WebApplication {
    const app = new WebApplication({
        PORT: 3000,
        ENV_MODE: 'production',
        LOG_LEVEL: 'INFO',
    });

    // Humans — OIDC BFF: browser sign-in, server-side sessions, and bearer
    // validation through the same provider. Registered as the default 'auth'
    // service so OidcAuthController can resolve it.
    app.use(
        oidcAuthPlugin(
            {
                issuerUrl: settings.oidc.issuerUrl,
                clientId: settings.oidc.clientId,
                clientSecret: settings.oidc.clientSecret,
                redirectUri: settings.oidc.redirectUri,
                sessionStore: settings.sessionStore,
            },
            { serviceName: 'auth', userServiceName: 'user' },
        ),
    );

    // Machines — self-issued client-credentials JWTs, verified locally.
    app.use(
        jwtAuthPlugin(
            {
                secret: settings.machine.secret,
                issuer: settings.machine.issuer,
                audience: settings.machine.audience,
                requireAudience: true,
                principalType: 'client',
            },
            { serviceName: 'client-auth', userServiceName: 'client' },
        ),
    );

    app.use(AuthController);
    app.registerController('', ProfileController);
    app.registerController('', ExportController);
    return app;
}
```

Resulting behavior:

| Request | Route | Outcome |
| --- | --- | --- |
| Browser session cookie (or user bearer token) → `/api/profile` | `authenticated()` | `200` — principal `'user'` |
| Machine JWT → `/api/profile` | `authenticated()` | `401` — not a valid user credential |
| Machine JWT → `/api/exports/daily` | `secure('client')` | `200` — principal `'client'` |
| Browser session cookie → `/api/exports/daily` | `secure('client')` | `401` — no bearer token to verify |

### Why this pattern pays off

- **No handler branching.** Each route declares the principal it accepts; the secure guard resolves exactly one per-request principal service. There is no `if (user) … else if (client) …` code path to audit.
- **Fail-closed by construction.** A user token is not a valid input to the machine provider's verification (different key material, issuer, audience) and vice versa, so cross-use is rejected at the guard, not inside controllers.
- **Independent lifecycles.** Each provider keeps its own caches, key material, and health state, and each plugin delegates `health()` and `shutdown()` to its provider — WebAFX's health endpoint and graceful shutdown manage both automatically.

### Caveats and performance considerations

- **Distinct `serviceName` values are mandatory.** Two plugins that both use the default name produce the same plugin name, and the second `app.use()` fails fast at startup with `Plugin "auth:auth" is already registered`. This is deliberate: an earlier silent-replacement behavior was replaced by a startup error.
- **`principalType` is descriptive, not enforcing.** It stamps `AuthResult.principalType` for downstream logic, but access is granted by the route's principal selection. Always pair `userServiceName: 'client'` with `.secure('client')` — an unnamed secure route always resolves the default `'user'` service, whatever `userServiceName` was configured.
- **The OIDC controller resolves its provider from the default `'auth'` service.** If you rename that plugin's `serviceName`, override `getProviderServiceName()` in your `OidcAuthController` subclass with the same name, or the controller will fail to resolve its provider.
- **Cookie-based user auth needs `sessionStore`.** The OIDC provider's session-cookie fallback only activates when a `CacheProvider` is configured; without it, browser clients must present bearer tokens.
- **Cost profile:** machine JWTs are verified locally with zero network calls; user bearer validation triggers discovery/JWKS once per `discoveryTtl` window (default 3600 s) and is then cache-only; only the sign-in flow itself contacts the identity provider.

---

## Pattern 2: Multi-Tenant OIDC (Per-Tenant Issuers and Scoped Cookies)

### When to use

You run a SaaS where each tenant has its own OIDC registration (issuer, client, endpoints) and browser sessions of different tenants must never collide — even though one provider instance serves them all. Tenants are typically distinguished by host (`acme.example.com`) or a request header.

The mechanics: a `configFactory(req)` resolves the tenant's OIDC configuration per request, the discovery cache is keyed per issuer so tenants never share JWKS material, and the `resolveSessionCookieName` / `resolveStateCookieName` resolvers scope the opaque browser cookies per tenant.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { Request } from 'express';
import {
    OidcAuthController,
    OidcAuthProvider,
    createAuthPlugin,
} from 'blendsdk/webafx-auth';
import type { OidcAuthConfig } from 'blendsdk/webafx-auth';
import type { CacheProvider } from 'blendsdk/webafx-cache';

interface TenantRecord {
    slug: string;
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
}

/** Tenant registry — loaded from the platform database at startup. */
const tenants = new Map<string, TenantRecord>([
    [
        'acme',
        {
            slug: 'acme',
            issuerUrl: 'https://acme.auth.example.com',
            clientId: 'web-acme',
            clientSecret: 'acme-tenant-secret',
        },
    ],
    [
        'globex',
        {
            slug: 'globex',
            issuerUrl: 'https://globex.auth.example.com',
            clientId: 'web-globex',
            clientSecret: 'globex-tenant-secret',
        },
    ],
]);

/** Resolves the tenant from the request host: acme.example.com → 'acme'. */
function tenantOf(req: Request): TenantRecord | undefined {
    const host = (req.headers.host ?? '').split(':')[0];
    return tenants.get(host.split('.')[0]);
}

function tenantConfig(tenant: TenantRecord): OidcAuthConfig {
    return {
        issuerUrl: tenant.issuerUrl,
        clientId: tenant.clientId,
        clientSecret: tenant.clientSecret,
        redirectUri: `https://${tenant.slug}.example.com/api/oidc/callback`,
    };
}

/** Stamps the organization slug onto every stored browser session. */
class TenantOidcController extends OidcAuthController {
    protected resolveOrganization(req: Request): string | undefined {
        return tenantOf(req)?.slug;
    }
}

export function createMultiTenantApp(sessionStore: CacheProvider): WebApplication {
    const app = new WebApplication({
        PORT: 3000,
        ENV_MODE: 'production',
        LOG_LEVEL: 'INFO',
    });

    const provider = new OidcAuthProvider({
        serviceName: 'auth',
        configFactory: async (req) => {
            const tenant = tenantOf(req);
            if (!tenant) {
                // Factory errors propagate as infrastructure failures; return
                // the platform's default registration instead if you prefer
                // a fallback over a 500.
                throw new Error('No tenant registration for this host');
            }
            return tenantConfig(tenant);
        },
        sessionStore,
        // Browser cookies are scoped per tenant so two tenants in one browser
        // never overwrite each other's session or PKCE state.
        resolveSessionCookieName: (req) => {
            const tenant = tenantOf(req);
            return tenant ? `__oidc_session_${tenant.slug}` : '__oidc_session';
        },
        resolveStateCookieName: (req) => {
            const tenant = tenantOf(req);
            return tenant ? `__oidc_state_${tenant.slug}` : '__oidc_state';
        },
    });

    app.use(createAuthPlugin(provider));
    app.use(TenantOidcController);
    return app;
}
```

The same registered provider also validates tenant **bearer** tokens on any authenticated route: `authenticate(req)` resolves the tenant configuration per request, verifies the JWT against that tenant's discovery/JWKS, and falls back to the tenant-scoped session cookie when no bearer token is present.

### Why this pattern pays off

- **One provider, N tenants, zero cross-talk.** The discovery cache is keyed by `issuerUrl`, so each tenant gets its own `openid-client` configuration and `jose` JWKS resolver; introspection-style cache sharing cannot happen across tenants here because there is no shared key.
- **Cookie isolation without browser state.** Only opaque UUIDs live in cookies, and the names are tenant-scoped; the session and PKCE data stay in the shared `CacheProvider`, so a stolen cookie from one tenant's subdomain cannot resolve against another tenant's entry.
- **`organizationSlug` is stamped on the session** by the controller hook and surfaces through `GET /api/oidc/me`, giving your application a session-bound tenant identifier that was resolved server-side, not client-supplied.

### Caveats and performance considerations

- **Static-only settings cannot vary per tenant.** `sessionTtl`, `sessionCookieTtl`, `sessionAbsoluteTtl`, `stateTtl`, `discoveryTtl`, `csrf`, `rotateSessionIdOnRefresh`, `verifyIdTokenSignature`, `verifyUserInfoSubject`, `userInfoDenied`, `notAuthorizedPath`, `transport`, and the session-path `clockTolerance` are read from the provider's static configuration. The `configFactory` can vary issuer, client credentials, redirect URI, audience, and resolution behavior — not the session/verification policy.
- **`configFactory` runs once per request** on the bearer path and in every controller handler. Keep it O(1) — a Map lookup as shown, or a memoized repository call. It must return a complete configuration (`issuerUrl` and `clientId` at minimum) or throw.
- **Cookie-name resolution must be deterministic per request.** Login, callback, `/me`, `/refresh`, and `/logout` each resolve the cookie name independently; a request that resolves a different name between steps strands the session. Always derive it from one shared helper, exactly as the example does.
- **`health()` returns `false` in factory-only setups**, because there is no static registration to check discovery against. If health reporting matters, also provide a static `issuerUrl` + `clientId` for the platform's primary tenant — `authenticate()` still prefers the factory, while `health()` and `validate()` work against the static registration.
- **Discovery entries expire per issuer after `discoveryTtl`** (default 3600 s). With many tenants, the first request per tenant after expiry pays one discovery round-trip; everything else is cached.

---

## Pattern 3: A Hardened Production Profile for the OIDC BFF

### When to use

You are exposing the browser sign-in flow to real users in production and want defense-in-depth beyond the defaults: CSRF enforcement on session mutations, session-id rotation on refresh, an absolute session cap, and an explicit policy for users the identity provider authenticates but the application denies.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';
import type { RouteDefinition } from 'blendsdk/webafx';
import {
    OidcAuthController,
    OidcAuthProvider,
    createAuthPlugin,
} from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';
import type { CacheProvider } from 'blendsdk/webafx-cache';

/** OIDC BFF routes with the hardened provider below. */
class HardenedAuthController extends OidcAuthController {}

/**
 * Application base controller: every guarded handler resolves the principal
 * through `authorizedUser()`, so a session the identity provider
 * authenticated but the application has not authorized is rejected.
 */
class AppController extends BaseController {
    protected async authorizedUser(
        req: Request,
        res: Response,
    ): Promise<AuthResult | undefined> {
        const user = await req.services.get<AuthResult>('user', undefined);
        if (user?.authorized === false) {
            res.status(403).json({
                success: false,
                error: {
                    code: 'account_not_authorized',
                    message: 'Signed in, but access to this application is not permitted',
                },
            });
            return undefined;
        }
        return user;
    }
}

class ReportsController extends AppController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated()
                .get('/api/reports')
                .handle(async (req, res) => {
                    const user = await this.authorizedUser(req, res);
                    if (!user) {
                        return;
                    }
                    this.ok(res, { generatedFor: user.sub });
                }),
        ];
    }
}

export function createHardenedOidcApp(sessionStore: CacheProvider): WebApplication {
    const app = new WebApplication({
        PORT: 3000,
        ENV_MODE: 'production',
        LOG_LEVEL: 'INFO',
    });

    const provider = new OidcAuthProvider({
        serviceName: 'auth',
        issuerUrl: 'https://auth.example.com',
        clientId: 'web-app',
        clientSecret: 'web-app-secret',
        redirectUri: 'https://app.example.com/api/oidc/callback',
        sessionStore,

        // Verification — defaults shown; keep them enabled.
        verifyIdTokenSignature: true, // ID token is checked against issuer JWKS
        verifyUserInfoSubject: true,  // OIDC Core 1.0 §5.3.2 subject check
        clockTolerance: 30,

        // Session lifetime.
        sessionTtl: 1800,           // 30-minute sliding idle window
        sessionCookieTtl: 1800,     // cookie slides with the session
        sessionAbsoluteTtl: 43200,  // 12-hour hard cap; refresh cannot extend it
        stateTtl: 300,
        discoveryTtl: 3600,

        // Refresh hardening and CSRF.
        rotateSessionIdOnRefresh: true,
        csrf: { enabled: true, header: 'x-csrf-token' },

        // Soft denial: keep a session, mark it unauthorized.
        userInfoDenied: 'unauthorized-session',
        notAuthorizedPath: '/not-authorized',
    });

    app.use(createAuthPlugin(provider));
    app.use(HardenedAuthController);
    app.registerController('', ReportsController);
    return app;
}
```

Each hardening setting closes a specific class of issue:

| Concern | Setting | Effect |
| --- | --- | --- |
| Stolen session id keeps working after a refresh | `rotateSessionIdOnRefresh` | Successful refresh stores the session under a new id, deletes the old one, and re-issues the cookie; the old id stops resolving |
| Session lives forever through constant activity | `sessionAbsoluteTtl` | Hard deadline measured from `createdAt`; refresh and rotation preserve it |
| Idle sessions linger | `sessionTtl` + `sessionCookieTtl` | Sliding idle window, with the browser cookie expiring on the same schedule |
| Cross-site mutation of logout/refresh | `csrf: { enabled: true }` | `POST /logout` and `POST /refresh` require the session token in `x-csrf-token`; the token is returned by `GET /me` and never placed in a script-readable cookie |
| Forged or tampered ID token | `verifyIdTokenSignature` (default `true`) | The code exchange verifies the ID-token signature against the issuer's JWKS |
| UserInfo claims for a different user | `verifyUserInfoSubject` (default `true`) | A subject mismatch aborts the callback with `400` and creates no session |
| IdP authenticates but app denies (UserInfo `403`) | `userInfoDenied` | Default is a fixed `403` with no session; `'unauthorized-session'` stores a session with `authorized: false` and redirects to `notAuthorizedPath` |

### The client contract that comes with it

| Client action | Endpoint | Requirement |
| --- | --- | --- |
| Start sign-in | `GET /api/oidc/login` | Public; optional `prompt`, `login_hint`, and `returnTo` query parameters |
| Complete sign-in | `GET /api/oidc/callback` | Public; redirects to the sanitized `returnTo` path or `/` |
| Read session state | `GET /api/oidc/me` | Authenticated; returns `user`, `expiresAt`, `authorized`, and `csrfToken` when CSRF is enabled |
| Refresh tokens | `POST /api/oidc/refresh` | Send `x-csrf-token`; the cookie is re-issued and the response may carry a rotated `csrfToken` |
| Log out | `POST /api/oidc/logout` | Send `x-csrf-token`; revokes the access token (best-effort) and clears session + cookie |

`/logout` and `/refresh` are intentionally *not* behind the secure guard: they validate the opaque session cookie and CSRF token themselves, so a session whose access token already expired can still refresh or log out.

### Why this pattern pays off

- **Defense-in-depth without custom middleware.** CSRF, rotation, and the absolute cap are provider configuration; the controller enforces them on the wire, and the session store keeps only opaque ids in the browser.
- **Soft denial keeps users informed instead of bounced.** With `userInfoDenied: 'unauthorized-session'`, the callback stores a refreshable session whose identity comes exclusively from the verified ID token; `/me` reports `authorized: false`, and your controllers decide what that user may see.
- **The defaults stay honest.** The explicit `true` values are the package defaults — writing them down makes an intentional weakening (`false`) visible in review.

### Caveats and performance considerations

- **Enabling CSRF invalidates pre-existing sessions' mutations.** Sessions created before enforcement have no stored token, so their next logout or refresh is rejected with `403` until they expire or are cleared. Roll CSRF out together with a re-login window.
- **Rotation has inherent trade-offs.** A successful refresh response lost in transit leaves the browser with a cookie whose session was just deleted — the user must sign in again. Rotation only happens after both the token grant and the new session store succeed; a failed refresh never touches the existing session.
- **Concurrency is process-local.** The controller coalesces concurrent refreshes for one session id (one grant, one store, one rotation), and the provider coalesces direct `refreshToken()` calls per tenant + token. A deployment with multiple application instances needs an external lock; otherwise two instances can both rotate.
- **The absolute deadline is final on read.** A session past `createdAt + sessionAbsoluteTtl` is deleted on the next read. A session written before the option was configured has no `createdAt` and is *not* signed out; the next successful store stamps it with a fresh window.
- **Soft denial requires a verified identity.** `userInfoDenied: 'unauthorized-session'` falls back to the fixed `403` when `verifyIdTokenSignature` is disabled or the ID token has no usable string `sub` — there is nothing trusted to store. Denied sessions still authenticate on cookie routes (so `/me` works), which is exactly why every policy-sensitive handler must check `authorized !== false` as `AppController` does.

---

## Pattern 4: Database-Backed Tenant Credentials for Token Introspection

### When to use

Your authorization server issues **opaque** tokens that must be checked via RFC 7662 introspection, and the endpoint, client id, secret, or audience differ per tenant — resolved from a database at request time rather than baked into static configuration.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { Request } from 'express';
import {
    IntrospectionAuthProvider,
    createAuthPlugin,
} from 'blendsdk/webafx-auth';
import type { IntrospectionAuthConfig } from 'blendsdk/webafx-auth';

interface TenantCredentials {
    introspectionUrl: string;
    clientId: string;
    clientSecret: string;
    audience: string;
}

/**
 * Application-owned credential source. The provider deliberately does not
 * cache resolved credentials — back this with the tenant registry (and your
 * own short TTL) in production.
 */
class CredentialRepository {
    private readonly rows: Map<string, TenantCredentials>;

    constructor(rows: ReadonlyArray<readonly [string, TenantCredentials]>) {
        this.rows = new Map(rows);
    }

    async forTenant(tenantId: string): Promise<TenantCredentials> {
        const row = this.rows.get(tenantId);
        if (!row) {
            throw new Error(`No introspection credentials for tenant '${tenantId}'`);
        }
        return row;
    }
}

function tenantIdOf(req: Request): string {
    const header = req.headers['x-tenant-id'];
    if (typeof header !== 'string' || header.length === 0) {
        throw new Error('Missing x-tenant-id header');
    }
    return header;
}

export function createApi(): WebApplication {
    const repository = new CredentialRepository([
        [
            'acme',
            {
                introspectionUrl: 'https://acme.auth.example.com/oauth2/introspect',
                clientId: 'acme-api',
                clientSecret: 'acme-introspection-secret',
                audience: 'https://api.example.com',
            },
        ],
        [
            'globex',
            {
                introspectionUrl: 'https://globex.auth.example.com/oauth2/introspect',
                clientId: 'globex-api',
                clientSecret: 'globex-introspection-secret',
                audience: 'https://api.example.com',
            },
        ],
    ]);

    const provider = new IntrospectionAuthProvider({
        serviceName: 'auth',
        principalType: 'client',
        configFactory: async (req): Promise<IntrospectionAuthConfig> => {
            const credentials = await repository.forTenant(tenantIdOf(req));
            return {
                introspectionUrl: credentials.introspectionUrl,
                clientId: credentials.clientId,
                clientSecret: credentials.clientSecret,
                audience: credentials.audience,
            };
        },
        cacheTTL: 60,
        maxCacheSize: 2000,
        timeout: 3000,
    });

    const app = new WebApplication({
        PORT: 3000,
        ENV_MODE: 'production',
        LOG_LEVEL: 'INFO',
    });

    app.use(
        createAuthPlugin(provider, { serviceName: 'auth', userServiceName: 'client' }),
    );
    return app;
}
```

Machine routes then select the introspected principal by name:

```typescript
fragment
this.route()
    .get('/api/orders')
    .secure('client')
    .handle(async (req, res) => {
        const client = await req.services.get<AuthResult>('client', undefined);
        this.ok(res, { requestedBy: client?.sub, scopes: client?.scopes ?? [] });
    });
```

The equivalent for a configuration object assembled from validated environment settings is `createAuthProvider({ type: 'introspection', configFactory, principalType: 'client' })` — same provider semantics, one call.

### Why this pattern pays off

- **Tenant-safe caching by construction.** Active introspection responses are cached under a SHA-256 digest of the resolved *endpoint + client id + token* — never the raw token, never the secret — so one tenant's result can never be served to another, and tokens never appear in cache keys, logs, or error messages.
- **Revocation becomes cheap.** Warm tokens answer from the LRU without a network call, while the effective entry lifetime is clamped to `min(cacheTTL, token exp − now)`, so a cached result can never outlive the token it represents.
- **Failures are typed by contract.** An inactive, expired, or audience-mismatched token is a silent `undefined` (→ `401`); network errors, timeouts, non-2xx responses, and a throwing `configFactory` are infrastructure exceptions (→ `500`). You never accidentally treat an IdP outage as "unauthenticated".

### Caveats and performance considerations

- **Revocation visibility lags by up to `cacheTTL`** (bounded by token expiry). Lower `cacheTTL` for high-sensitivity tenants; the default is 60 seconds.
- **`configFactory` errors propagate.** A missing or unknown tenant header becomes a `500` unless your error handler maps it; decide deliberately whether an unresolvable tenant is a client error or a misrouted request.
- **`validate(token)` returns `undefined` in factory-only mode.** There is no request to resolve credentials from — direct callers (and unit tests) must use `authenticate(req)`, which the plugin does.
- **`health()` checks configuration, not reachability.** It returns `true` whenever a static triple or factory is present, deliberately without a network call so DB-backed providers are not reported unhealthy. Pair it with your own endpoint probe if you need uptime truth.
- **One global LRU across tenants** (`maxCacheSize`, default 1000) with least-recently-used eviction; size it for your total tenant traffic, and remember the credential repository — not the provider — owns credential caching.

---

## Pattern 5: Zero-Downtime Migration with a Composite JWT + Introspection Provider

### When to use

You are moving from opaque tokens (or a previous issuer) to locally verified JWTs and both token generations must work during the transition — without changing route code, and without splitting each route into two principals. A composite `AuthProvider` subclass tries the new format first and falls back to the legacy path.

Before — a single provider that cannot accept the new tokens:

```typescript
fragment
// Before: every request pays an introspection round-trip, and newly issued
// JWTs are not accepted at all.
app.use(
    introspectionAuthPlugin({
        introspectionUrl: 'https://legacy.auth.example.com/oauth2/introspect',
        clientId: 'legacy-api',
        clientSecret: 'legacy-secret',
    }),
);
```

After — one provider that accepts both generations:

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { Request } from 'express';
import {
    AuthProvider,
    IntrospectionAuthProvider,
    JwtAuthProvider,
    createAuthPlugin,
} from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

/**
 * Accepts both token generations during a migration window:
 * 1. New JWTs — verified locally, no network call.
 * 2. Legacy opaque tokens — RFC 7662 introspection.
 */
class MigratingAuthProvider extends AuthProvider {
    constructor(
        private readonly jwt: JwtAuthProvider,
        private readonly introspection: IntrospectionAuthProvider,
    ) {
        super({ serviceName: 'auth' });
    }

    override async authenticate(req: Request): Promise<AuthResult | undefined> {
        // The JWT path is local: an opaque token simply fails verification.
        const viaJwt = await this.jwt.authenticate(req);
        if (viaJwt !== undefined) {
            return viaJwt;
        }
        // Legacy tokens are introspected; infrastructure failures propagate.
        return this.introspection.authenticate(req);
    }

    async validate(token: string): Promise<AuthResult | undefined> {
        return (await this.jwt.validate(token)) ?? this.introspection.validate(token);
    }

    async health(): Promise<boolean> {
        const [jwtReady, introspectionReady] = await Promise.all([
            this.jwt.health(),
            this.introspection.health(),
        ]);
        return jwtReady && introspectionReady;
    }

    async shutdown(): Promise<void> {
        await Promise.all([this.jwt.shutdown(), this.introspection.shutdown()]);
    }
}

export function createMigratingApp(): WebApplication {
    const jwt = new JwtAuthProvider({
        secret: 'new-issuer-hmac-secret',
        algorithms: ['HS256'],
        issuer: 'https://auth.example.com',
        audience: 'https://api.example.com',
        requireAudience: true,
    });

    const introspection = new IntrospectionAuthProvider({
        introspectionUrl: 'https://legacy.auth.example.com/oauth2/introspect',
        clientId: 'legacy-api',
        clientSecret: 'legacy-secret',
        audience: 'https://api.example.com',
    });

    const app = new WebApplication({
        PORT: 3000,
        ENV_MODE: 'production',
        LOG_LEVEL: 'INFO',
    });

    app.use(createAuthPlugin(new MigratingAuthProvider(jwt, introspection)));
    return app;
}
```

When the last legacy token has expired (bounded by its maximum lifetime), retire the transition by swapping one line: `createAuthPlugin(jwt)` — and delete the composite class along with the introspection dependency.

### Why this pattern pays off

- **One principal, one registration, zero route changes.** Every existing `activated()` route keeps working; clients migrate on their own schedule instead of a flag day.
- **The common case gets cheaper immediately.** New JWTs are verified locally with zero network traffic; only legacy tokens pay the introspection round-trip, and those responses stay in the introspection LRU.
- **The lifecycle composes cleanly.** `createAuthPlugin()` delegates `health()` and `shutdown()` to the composite, which fans both out to every inner provider — no resource is leaked at shutdown.

### Caveats and performance considerations

- **Order matters: newest format first.** Every fallback position adds latency for the tokens that reach it; put the local, zero-network check first.
- **Do not swallow infrastructure errors in the fallback.** The JWT provider returns `undefined` for *invalid* tokens (safe to fall through), but an introspection network failure throws by contract — catching it would turn an authorization-server outage into a silent `401` and hide the problem.
- **`validate()` only covers the statically configured paths.** A factory-only `IntrospectionAuthProvider` returns `undefined` from `validate()`; the composite's `authenticate(req)` (what the plugin calls) is the operational path. If tests call `validate()` directly, configure introspection statically or test through `authenticate()`.
- **Composite `health()` means "both configured", not "both reachable".** JWT health checks key presence; introspection health checks configuration presence. Add an explicit probe if you need round-trip truth.

---

## Pattern 6: A Custom `AuthProvider` for Proprietary Credentials (API Keys)

### When to use

Internal callers authenticate with API keys or another in-house credential format, and you want the full WebAFX lifecycle — plugin registration, the secure guard, `health()`, `shutdown()` — without pretending the keys are JWTs. Extending `AuthProvider` gives you the extraction chain, claims mapping, principal stamping, and the silent-failure contract for free.

```typescript
import { createHash, timingSafeEqual } from 'node:crypto';
import { WebApplication } from 'blendsdk/webafx';
import type { Request } from 'express';
import { AuthProvider, createAuthPlugin } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

/** Registry entry for one service API key. */
interface ApiKeyRecord {
    /** SHA-256 digest of the secret half of the key. */
    secretHash: Buffer;
    /** Principal name the key authenticates as. */
    owner: string;
    /** Scopes granted to the key. */
    scopes: string[];
}

/** Custom token source: reads the key from `x-api-key` (Node lowercases header names). */
function extractApiKey(req: Request): string | undefined {
    const header = req.headers['x-api-key'];
    return typeof header === 'string' ? header : undefined;
}

/** SHA-256 digest of a key secret, as stored by the registry. */
function hashSecret(secret: string): Buffer {
    return createHash('sha256').update(secret).digest();
}

class ApiKeyAuthProvider extends AuthProvider {
    private readonly keys: Map<string, ApiKeyRecord>;

    constructor(keys: ReadonlyArray<readonly [string, ApiKeyRecord]>) {
        super({
            serviceName: 'service-auth',
            principalType: 'client',
            tokenSources: [{ extractor: extractApiKey }],
        });
        this.keys = new Map(keys);
    }

    async validate(token: string): Promise<AuthResult | undefined> {
        // Keys have the form "<keyId>.<secret>".
        const separator = token.indexOf('.');
        if (separator <= 0 || separator === token.length - 1) {
            return undefined;
        }

        const record = this.keys.get(token.slice(0, separator));
        if (!record) {
            return undefined;
        }

        const presented = hashSecret(token.slice(separator + 1));
        if (
            presented.length !== record.secretHash.length ||
            !timingSafeEqual(presented, record.secretHash)
        ) {
            return undefined;
        }

        // Reuse the configured claims mapper (default: sub/exp/scope) and stamp
        // the configured principal type.
        return this.withPrincipalType(
            this.claimsMapper(token, {
                sub: record.owner,
                scope: record.scopes,
            }),
        );
    }

    async health(): Promise<boolean> {
        // Cheap local check — the health endpoint calls this on every probe.
        return this.keys.size > 0;
    }

    async shutdown(): Promise<void> {
        this.keys.clear();
    }
}

const apiKeysProvider = new ApiKeyAuthProvider([
    [
        'svc-billing',
        {
            secretHash: hashSecret('billing-service-secret'),
            owner: 'billing-service',
            scopes: ['invoices:read'],
        },
    ],
    [
        'svc-search',
        {
            secretHash: hashSecret('search-service-secret'),
            owner: 'search-service',
            scopes: ['catalog:read'],
        },
    ],
]);

const app = new WebApplication({
    PORT: 4000,
    ENV_MODE: 'production',
    LOG_LEVEL: 'INFO',
});

app.use(
    createAuthPlugin(apiKeysProvider, {
        serviceName: 'service-auth',
        userServiceName: 'client',
    }),
);
```

Routes consume the result through the named principal:

```typescript
fragment
this.route()
    .get('/internal/catalog')
    .secure('client')
    .handle(async (req, res) => {
        const client = await req.services.get<AuthResult>('client', undefined);
        this.ok(res, { owner: client?.sub, scopes: client?.scopes ?? [] });
    });
```

### Why this pattern pays off

- **Only three methods to implement.** The base class owns extraction chaining, the `authenticate()` lifecycle, and claims mapping; the custom provider implements `validate()`, `health()`, and `shutdown()` and inherits everything else.
- **Security primitives come from the platform.** Constant-time digest comparison via `timingSafeEqual`, the silent-failure contract, and claims mapping through the configured `mapClaims` (custom mappers stay authoritative over `principalType`).
- **It's a first-class citizen.** The plugin registers it like any other provider, the guard resolves `'client'`, and WebAFX's health and shutdown lifecycles manage it automatically.

### Caveats and performance considerations

- **Never throw for a bad credential.** Return `undefined` for malformed, unknown, or mismatched keys — the guard then answers `401` uniformly, with no oracle distinguishing "unknown key id" from "bad secret". Only genuine infrastructure failures (e.g., a required remote check) should throw.
- **`health()` must stay O(1) and side-effect free.** It is wired to the health endpoint; return cached/local state (as here), or map a probe's failure to `false` internally rather than letting it throw.
- **`shutdown()` runs on graceful shutdown.** Clear key material so it is not retained after the process stops serving; mirror `MemoryAuthProvider`'s `addToken`/`removeToken` shape if you need runtime key rotation and revocation.
- **Mind the header lookup.** Node lowercases incoming header names — read `req.headers['x-api-key']`, not `'X-Api-Key'`.
- **API keys are bearer credentials.** Serve only over TLS, plan for rotation, and pair `userServiceName: 'client'` with `.secure('client')` on every route — unnamed secure routes resolve the default `'user'` service, which this pattern never registers.

---

## Pattern 7: Deterministic Integration Tests with `MemoryAuthProvider`

### When to use

You want HTTP-level tests (supertest-style) of guarded routes, real plugin wiring, and scenario control over tokens — without an identity provider, network mocks, or signing keys. `MemoryAuthProvider` validates by exact map lookup and exposes `addToken()`, `removeToken()`, and `getTokenCount()` for mid-test manipulation.

The app factory — one provider and one running app per test:

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { createAuthPlugin, MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

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

export interface TestApp {
    app: WebApplication;
    provider: MemoryAuthProvider;
    /** Stops the app; the plugin's shutdown clears the provider's token map. */
    shutdown: () => Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
    const provider = new MemoryAuthProvider({
        validTokens: {
            'user-token': {
                sub: 'user-1',
                claims: { role: 'user' },
                token: 'user-token',
            },
        },
    });

    const app = new WebApplication({
        PORT: 0, // ephemeral port — safe for parallel test suites
        ENV_MODE: 'test',
        LOG_LEVEL: 'ERROR',
    });

    app.use(createAuthPlugin(provider));
    app.registerController('', ProfileController);

    const shutdown = await app.start();
    return { app, provider, shutdown };
}
```

The test suite — scenario control without restarting anything:

```typescript
import { afterEach, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { createTestApp, type TestApp } from './test-app.js';

describe('profile route authentication', () => {
    let sut: TestApp | undefined;

    afterEach(async () => {
        await sut?.shutdown();
        sut = undefined;
    });

    it('rejects an unknown token with 401', async () => {
        sut = await createTestApp();

        await supertest(sut.app.express)
            .get('/profile')
            .set('Authorization', 'Bearer unknown-token')
            .expect(401);
    });

    it('authenticates a known token', async () => {
        sut = await createTestApp();

        const response = await supertest(sut.app.express)
            .get('/profile')
            .set('Authorization', 'Bearer user-token')
            .expect(200);

        expect(response.body.data).toEqual({ sub: 'user-1' });
    });

    it('honors a token added for one scenario', async () => {
        sut = await createTestApp();
        const scoped: AuthResult = {
            sub: 'ci-runner',
            claims: { role: 'ci' },
            token: 'ci-token',
            scopes: ['reports:read'],
        };
        sut.provider.addToken('ci-token', scoped);

        await supertest(sut.app.express)
            .get('/profile')
            .set('Authorization', 'Bearer ci-token')
            .expect(200);
    });

    it('rejects the token after a simulated revocation', async () => {
        sut = await createTestApp();

        await supertest(sut.app.express)
            .get('/profile')
            .set('Authorization', 'Bearer user-token')
            .expect(200);

        sut.provider.removeToken('user-token');

        await supertest(sut.app.express)
            .get('/profile')
            .set('Authorization', 'Bearer user-token')
            .expect(401);
    });
});
```

### Why this pattern pays off

- **Real wiring, real guard, real HTTP.** Only the identity source is swapped: the plugin registers the same services, the guard resolves the same `'user'` principal, and the handlers run unchanged from production.
- **Scenario control in one call.** `addToken()` sets up role- or scope-specific scenarios; `removeToken()` simulates revocation; both take effect on the next request with no app restart.
- **No state leaks between suites.** The plugin delegates `shutdown()` to the provider, so stopping the app also clears the token map — combined with the per-test factory, each test starts from a known state. `getTokenCount()` lets assertions verify that state explicitly.

### Caveats and performance considerations

- **Testing only — never ship it.** There is no signature verification, no expiry, and no crypto: a token is valid if and only if its string is a map key. Use it in unit/integration tests and local development.
- **Use `createAuthPlugin(new MemoryAuthProvider(...))` when tests need the instance.** The `memoryAuthPlugin()` convenience builds the provider internally, so you get no reference to call `addToken()`/`removeToken()` on.
- **Prefer real providers for protocol semantics.** If the test asserts expiry, issuer/audience rejection, or signature behavior, construct a `JwtAuthProvider` with a test secret and sign real tokens with `jose` — the package's own test helpers do exactly that (`signTestJwt`, `signExpiredJwt`).
- **`PORT: 0` keeps suites parallel-safe** by avoiding port collisions; the plugin log line is still emitted at install time, which is why the example sets `LOG_LEVEL: 'ERROR'`.

---

## Pattern Selection Cheat Sheet

| Problem | Pattern | Core APIs |
| --- | --- | --- |
| Users and service clients in one application | 1 | `createAuthPlugin()` × 2, `secure('client')`, `principalType` |
| Per-tenant issuers and isolated browser sessions | 2 | OIDC `configFactory`, `resolveSessionCookieName`, `resolveStateCookieName`, `resolveOrganization` |
| Production-hardened browser sessions | 3 | `csrf`, `rotateSessionIdOnRefresh`, `sessionAbsoluteTtl`, `userInfoDenied`, `sessionCookieTtl` |
| Per-tenant opaque tokens with DB-backed credentials | 4 | `IntrospectionAuthProvider` + introspection `configFactory` |
| Two token generations during a migration | 5 | `AuthProvider` subclass delegating to inner providers |
| Proprietary credentials with full lifecycle | 6 | `AuthProvider` subclass + custom `TokenSource` |
| Deterministic HTTP tests of guarded routes | 7 | `MemoryAuthProvider` + `createAuthPlugin()` |

These patterns compose — Pattern 1 + Pattern 2 give you one application where multi-tenant OIDC users and JWT machine clients are routed to their own principals, both managed by WebAFX's health and shutdown lifecycles.

Regardless of which patterns you combine, every provider in this package preserves the same invariants:

- **A missing, invalid, or expired credential resolves to `undefined`** and the guard answers `401`; only infrastructure failures (network, DNS, store errors, rejecting factories) throw.
- **Providers are application-wide singletons.** Caches and in-flight maps are process-local; multi-instance deployments need shared session storage and external locks for refresh coalescing.
- **Plugins delegate `health()` and `shutdown()`.** Custom providers must fan both out to anything they own.
- **Secrets and raw tokens are never logged or used as cache keys.** The introspection cache hashes its keys; the OIDC client secret stays server-side; browsers hold only opaque session and state ids.

---

# webafx-auth Common Scenarios

This document answers the "How do I…?" questions that come up most often when adopting `blendsdk/webafx-auth`. Scenarios are ordered from a single route behind a JWT to full multi-tenant OIDC deployments. Every `typescript` block is a complete module that uses only public imports; `typescript fragment` blocks are partial by design.

---

## How do I protect a route with JWT authentication?

Install `jwtAuthPlugin()` before registering your controllers. The plugin registers the provider and a per-request `'user'` service, and the secure guard created by `this.authenticated()` resolves `'user'` — running the handler when a valid token is present and answering `401` when it is not.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { jwtAuthPlugin } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
    throw new Error('JWT_SECRET is required to start the application');
}

class ProfileController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated().get('/profile').handle(async (req, res) => {
                const user = await req.services.get<AuthResult>('user', undefined);
                this.ok(res, {
                    sub: user?.sub,
                    scopes: user?.scopes ?? [],
                });
            }),
        ];
    }
}

const app = new WebApplication({
    PORT: 3000,
    ENV_MODE: 'production',
    LOG_LEVEL: 'INFO',
});

app.use(jwtAuthPlugin({
    secret: jwtSecret,
    issuer: 'https://auth.example.com',
    audience: 'https://api.example.com',
}));

app.registerController('', ProfileController);

await app.start();
```

Verification is fully local — no network calls. An invalid, expired, or missing token resolves silently to `undefined` (never an exception), so unauthenticated requests simply receive `401`.

---

## How do I authenticate requests in tests without a real identity provider?

Use `memoryAuthPlugin()` with a map of token strings to pre-built `AuthResult` values. Tokens are validated by pure map lookup, so integration tests need no identity provider, crypto, or network.

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import supertest from 'supertest';
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { memoryAuthPlugin } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

class WhoAmIController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated().get('/whoami').handle(async (req, res) => {
                const user = await req.services.get<AuthResult>('user', undefined);
                this.ok(res, { sub: user?.sub });
            }),
        ];
    }
}

describe('whoami', () => {
    let shutdown: (() => Promise<void>) | null = null;

    afterEach(async () => {
        if (shutdown) {
            await shutdown();
            shutdown = null;
        }
    });

    it('returns the configured principal for a known token', async () => {
        const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });
        app.use(memoryAuthPlugin({
            validTokens: {
                'test-token': {
                    sub: 'user-1',
                    claims: { role: 'tester' },
                    token: 'test-token',
                },
            },
        }));
        app.registerController('', WhoAmIController);
        shutdown = await app.start();

        const response = await supertest(app.express)
            .get('/whoami')
            .set('Authorization', 'Bearer test-token')
            .expect(200);

        expect(response.body.data).toEqual({ sub: 'user-1' });

        await supertest(app.express).get('/whoami').expect(401);
    });
});
```

`MemoryAuthProvider` is intended for tests and local development only — never register it in production.

---

## How do I accept tokens from cookies, query parameters, or custom locations?

Configure `tokenSources` on any provider. Sources are tried in order and the first non-empty match wins — this is how browser clients can fall back from a header to a cookie, and how SSE endpoints or webhook callbacks can pass a token in the query string.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { jwtAuthPlugin } from 'blendsdk/webafx-auth';
import type { TokenSource } from 'blendsdk/webafx-auth';
import type { Request } from 'express';

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
    throw new Error('JWT_SECRET is required');
}

const fromCustomHeader: TokenSource = {
    extractor: (req: Request): string | undefined => {
        const value = req.headers['x-access-token'];
        return typeof value === 'string' ? value : undefined;
    },
};

const app = new WebApplication({
    PORT: 3000,
    ENV_MODE: 'production',
    LOG_LEVEL: 'INFO',
});

app.use(jwtAuthPlugin({
    secret: jwtSecret,
    // Tried in order; the first non-empty match wins.
    tokenSources: ['header', 'cookie', 'query', fromCustomHeader],
    cookieName: 'auth_token',
    queryParamName: 'token',
}));
```

The `'header'` source expects `Authorization: Bearer <token>` (exact, case-sensitive prefix). The `'cookie'` source reads `req.cookies`, which WebAFX's core middleware populates via cookie-parser. The default is `['header']` only.

---

## How do I validate opaque access tokens with introspection?

Use `introspectionAuthPlugin()` (RFC 7662). The provider asks the authorization server whether a token is active and caches active responses in a bounded LRU so a warm token does not cause a network call on every request. Inactive tokens resolve to `undefined`; only infrastructure failures (network, timeout, non-2xx, malformed body) throw.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { introspectionAuthPlugin } from 'blendsdk/webafx-auth';

const introspectionUrl = process.env.INTROSPECTION_URL;
const clientId = process.env.INTROSPECTION_CLIENT_ID;
const clientSecret = process.env.INTROSPECTION_CLIENT_SECRET;

if (!introspectionUrl || !clientId || !clientSecret) {
    throw new Error(
        'INTROSPECTION_URL, INTROSPECTION_CLIENT_ID and INTROSPECTION_CLIENT_SECRET are required'
    );
}

const app = new WebApplication({
    PORT: 3000,
    ENV_MODE: 'production',
    LOG_LEVEL: 'INFO',
});

app.use(introspectionAuthPlugin({
    introspectionUrl,
    clientId,
    clientSecret,
    audience: 'https://api.example.com',
    cacheTTL: 60,
    maxCacheSize: 1000,
    timeout: 5000,
}));
```

Cache keys are SHA-256 digests of the endpoint, client, and token, so raw tokens are never stored, logged, or used as keys, and one tenant's result can never be served to another. Use `authMethod: 'post'` if your server expects `client_secret_post` instead of HTTP Basic.

---

## How do I map custom claims into an `AuthResult`?

Pass a `mapClaims` function on any provider config. It receives the raw token and raw claims and must return a complete `AuthResult` — a custom mapper replaces the default mapper entirely, so extract `exp` and scopes yourself when you need them.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { createAuthPlugin, JwtAuthProvider } from 'blendsdk/webafx-auth';

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
    throw new Error('JWT_SECRET is required');
}

const provider = new JwtAuthProvider({
    secret: jwtSecret,
    issuer: 'https://auth.example.com',
    audience: 'https://api.example.com',
    mapClaims: (token, rawClaims) => ({
        sub: String(rawClaims.user_id ?? rawClaims.sub ?? 'unknown'),
        claims: rawClaims,
        token,
        exp: typeof rawClaims.exp === 'number' ? rawClaims.exp : undefined,
        scopes: Array.isArray(rawClaims.permissions)
            ? rawClaims.permissions.map(String)
            : undefined,
    }),
});

const app = new WebApplication({
    PORT: 3000,
    ENV_MODE: 'production',
    LOG_LEVEL: 'INFO',
});

app.use(createAuthPlugin(provider));
```

The default mapper handles `sub`/`subject`, numeric `exp`, and `scope` (space-separated string or array) / `scopes` (array). When a `principalType` is configured, it is stamped on the result only if your mapper has not already set one.

---

## How do I build a provider from a single configuration object?

`createAuthProvider()` dispatches on the `type` field (`'jwt' | 'introspection' | 'oidc' | 'memory'`) and validates the fields each provider requires, throwing a startup error that names the missing field — for example `createAuthProvider: type 'jwt' requires 'secret'`.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { createAuthPlugin, createAuthProvider } from 'blendsdk/webafx-auth';

// Fails fast at startup when a required field is missing, instead of
// failing at the first request.
const provider = createAuthProvider({
    type: 'jwt',
    secret: process.env.JWT_SECRET,
    issuer: 'https://auth.example.com',
    audience: 'https://api.example.com',
    requireAudience: true,
});

const app = new WebApplication({
    PORT: 3000,
    ENV_MODE: 'production',
    LOG_LEVEL: 'INFO',
});

app.use(createAuthPlugin(provider));
```

Required fields per type: `'jwt'` needs `secret`; `'introspection'` needs the complete triple (`introspectionUrl`, `clientId`, `clientSecret`) or a `configFactory`; `'oidc'` needs `issuerUrl`; `'memory'` needs nothing. This makes the factory a natural match for environment-driven configuration.

---

## How do I add and remove valid tokens at runtime in tests?

`MemoryAuthProvider` exposes three helpers beyond the `AuthProvider` contract: `addToken()`, `removeToken()`, and `getTokenCount()`. They let a test register tokens for one scenario and revoke them afterwards — for example to simulate token revocation.

```typescript
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const provider = new MemoryAuthProvider();

const token = 'scenario-token';
const principal: AuthResult = {
    sub: 'user-7',
    claims: { role: 'tester' },
    token,
};

// Register a token for one scenario...
provider.addToken(token, principal);
console.log(provider.getTokenCount()); // 1

// ...and revoke it afterwards, e.g. to simulate token revocation.
const removed = provider.removeToken(token);
console.log(removed); // true

// shutdown() clears every remaining token.
await provider.shutdown();
console.log(provider.getTokenCount()); // 0
```

After `shutdown()`, every subsequent `validate()` call resolves to `undefined`. These helpers exist only on `MemoryAuthProvider`; other providers have no equivalent runtime token registry.

---

## How do I run a user provider and a machine-client provider side by side?

Register two plugins with distinct `serviceName` values and give each one its own `userServiceName` (the principal service it registers). Routes then select their provider through the principal name they request: an unnamed `this.authenticated()` route resolves the default `'user'` service, while `secure('client')` resolves `'client'`.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { createAuthPlugin, MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const USER_TOKEN = 'user-token';
const CLIENT_TOKEN = 'client-token';

class ReportsController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated().get('/profile').handle(async (req, res) => {
                const user = await req.services.get<AuthResult>('user', undefined);
                this.ok(res, { sub: user?.sub });
            }),
            this.route().get('/reports').secure('client').handle(async (req, res) => {
                const client = await req.services.get<AuthResult>('client', undefined);
                this.ok(res, { sub: client?.sub });
            }),
        ];
    }
}

const app = new WebApplication({
    PORT: 3000,
    ENV_MODE: 'production',
    LOG_LEVEL: 'INFO',
});

// Distinct plugin/service names are required: a second default-named plugin
// fails at startup with 'Plugin "auth:auth" is already registered'.
app.use(createAuthPlugin(
    new MemoryAuthProvider({
        validTokens: { [USER_TOKEN]: { sub: 'user-1', claims: {}, token: USER_TOKEN } },
    }),
    { serviceName: 'user-auth', userServiceName: 'user' },
));

app.use(createAuthPlugin(
    new MemoryAuthProvider({
        validTokens: { [CLIENT_TOKEN]: { sub: 'client-1', claims: {}, token: CLIENT_TOKEN } },
    }),
    { serviceName: 'client-auth', userServiceName: 'client' },
));

app.registerController('', ReportsController);

await app.start();
```

In production, swap the memory providers for e.g. `new JwtAuthProvider({ ...config, principalType: 'client' })`. The `principalType` option stamps `'user'` or `'client'` on an authenticated result, which downstream code can use for descriptive branching.

---

## How do I set up the OIDC browser sign-in flow?

Call `oidcAuthPlugin()` with a `sessionStore` (a `CacheProvider` from `blendsdk/webafx-cache`) and register a subclass of `OidcAuthController`. The controller supplies the five BFF routes under the default `/api/oidc` prefix; the browser holds only opaque UUID cookies while tokens live server-side.

```typescript
import type { CacheProvider } from 'blendsdk/webafx-cache';
import { OidcAuthController, oidcAuthPlugin } from 'blendsdk/webafx-auth';
import type { WebApplication } from 'blendsdk/webafx';

/** Every hook has a working default, so an empty subclass is complete. */
class AuthController extends OidcAuthController {}

/**
 * Installs the five BFF routes under the default prefix /api/oidc:
 *   GET  /api/oidc/login     — redirects the browser to the provider
 *   GET  /api/oidc/callback  — completes the flow and sets the session cookie
 *   POST /api/oidc/logout    — clears the session
 *   GET  /api/oidc/me        — returns the session user (never tokens)
 *   POST /api/oidc/refresh   — renews tokens with the stored refresh token
 *
 * `sessionStore` is the CacheProvider registered by blendsdk/webafx-cache.
 */
export function installOidcAuth(app: WebApplication, sessionStore: CacheProvider): void {
    app.use(oidcAuthPlugin({
        issuerUrl: 'https://auth.example.com',
        clientId: 'web-app',
        clientSecret: process.env.OIDC_CLIENT_SECRET,
        redirectUri: 'https://app.example.com/api/oidc/callback',
        sessionStore,
    }));

    app.registerController('', AuthController);
}
```

Start the flow with `GET /api/oidc/login?returnTo=/dashboard`; the query string may also carry `prompt` and `login_hint` pass-throughs. The callback validates state and nonce, verifies the ID-token signature (on by default), verifies the UserInfo subject, and redirects to the validated `returnTo` path or `/`. Override hooks such as `onCallback`, `getRoutePrefix`, or `resolveOrganization` in your subclass when you need customization.

---

## How do I resolve per-tenant credentials for each request?

Pass a `configFactory` instead of static credentials. It is called once per authenticated request and returns the complete configuration for that tenant — useful when endpoints or client secrets live in a database. Cache entries are isolated per tenant because the cache key includes the resolved endpoint and client id.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { introspectionAuthPlugin } from 'blendsdk/webafx-auth';

interface TenantCredentials {
    introspectionUrl: string;
    clientId: string;
    clientSecret: string;
}

// In a real deployment this would be a database or secret-store lookup.
const tenantCredentials = new Map<string, TenantCredentials>([
    ['acme', {
        introspectionUrl: 'https://acme.example.com/oauth2/introspect',
        clientId: 'acme-orders-api',
        clientSecret: 'acme-orders-secret',
    }],
    ['globex', {
        introspectionUrl: 'https://globex.example.com/oauth2/introspect',
        clientId: 'globex-orders-api',
        clientSecret: 'globex-orders-secret',
    }],
]);

const app = new WebApplication({
    PORT: 3000,
    ENV_MODE: 'production',
    LOG_LEVEL: 'INFO',
});

app.use(introspectionAuthPlugin({
    configFactory: async (req) => {
        const tenant = String(req.headers['x-tenant-id'] ?? '');
        const credentials = tenantCredentials.get(tenant);
        if (!credentials) {
            throw new Error(`No introspection credentials for tenant '${tenant}'`);
        }
        return credentials;
    },
}));
```

A throwing factory is an infrastructure failure and propagates as a server error; a returned config missing the required triple also fails clearly. `OidcAuthProvider` accepts a `configFactory` with the same shape (returning `{ issuerUrl, clientId, ... }`), and factory-only introspection configs validate through `authenticate(req)` — which is exactly what the plugin's per-request service calls.

---

## How do I reject tokens that were not minted for my API?

Set `requireAudience: true` together with an `audience`. This fails closed: every token is rejected unless the configured audience is present and the token's `aud` claim matches it, so a token minted for a different API by the same issuer is not accepted here.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { jwtAuthPlugin } from 'blendsdk/webafx-auth';

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
    throw new Error('JWT_SECRET is required');
}

const app = new WebApplication({
    PORT: 3000,
    ENV_MODE: 'production',
    LOG_LEVEL: 'INFO',
});

app.use(jwtAuthPlugin({
    secret: jwtSecret,
    issuer: 'https://auth.example.com',
    audience: 'https://api.example.com',
    // Fail closed: with no audience configured, or a non-matching one,
    // the token is rejected — without this flag the audience is checked
    // only when `audience` happens to be set.
    requireAudience: true,
}));
```

`audience` accepts a single string or an array (at least one value must match). The same option exists on `OidcAuthConfig`; `IntrospectionAuthProvider` matches the configured audience against the `aud` value in the introspection response and rejects tokens when an audience is configured but the response has none.

---

## How do I tolerate small clock differences between servers?

Set `clockTolerance` (seconds) on the provider. It widens the `exp`/`nbf` checks by that many seconds, so an issuer whose clock runs slightly ahead or behind does not cause spurious 401s.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { jwtAuthPlugin } from 'blendsdk/webafx-auth';

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
    throw new Error('JWT_SECRET is required');
}

const app = new WebApplication({
    PORT: 3000,
    ENV_MODE: 'production',
    LOG_LEVEL: 'INFO',
});

app.use(jwtAuthPlugin({
    secret: jwtSecret,
    issuer: 'https://auth.example.com',
    // JwtAuthProvider default: 0 seconds.
    clockTolerance: 5,
}));
```

`JwtAuthProvider` defaults to `0`; `OidcAuthProvider` defaults to `30` for JWT validation and also uses that value as the skew for its session-cookie expiry check. Keep the value small and symmetric — it only widens the acceptance window, never narrows it.

---

## How do I point the OIDC provider at a private CA or a local issuer?

Use the `transport` block on the OIDC configuration. Supplying `ca` makes discovery, JWKS, token, refresh, revocation, and UserInfo requests trust your private certificate bundle instead of the system roots.

```typescript
import { readFileSync } from 'node:fs';
import type { CacheProvider } from 'blendsdk/webafx-cache';
import { oidcAuthPlugin } from 'blendsdk/webafx-auth';
import type { WebApplication } from 'blendsdk/webafx';

export function installInternalOidc(app: WebApplication, sessionStore: CacheProvider): void {
    app.use(oidcAuthPlugin({
        issuerUrl: 'https://auth.internal.example.com',
        clientId: 'web-app',
        clientSecret: process.env.OIDC_CLIENT_SECRET,
        redirectUri: 'https://app.example.com/api/oidc/callback',
        sessionStore,
        // Trust the private CA. Passing `ca` replaces the system roots —
        // include your public roots in the bundle if you need both.
        transport: {
            ca: readFileSync('/etc/ssl/certs/internal-ca.pem', 'utf8'),
        },
    }));
}
```

For local development against a plain-HTTP or self-signed issuer, opt in explicitly — this disables TLS certificate validation and emits a one-time warning, so never enable it against a production issuer:

```typescript
// Development only.
app.use(oidcAuthPlugin({
    issuerUrl: 'http://127.0.0.1:9090',
    clientId: 'web-app',
    redirectUri: 'http://127.0.0.1:3000/api/oidc/callback',
    sessionStore,
    transport: { allowInsecureRequests: true },
}));
```

---

## How do I protect logout and refresh from CSRF?

Enable the `csrf` block. When enabled, `POST /logout` and `POST /refresh` must present the session's CSRF token in the configured header; the token is generated per session, returned by `GET /me` (as `data.csrfToken`), and compared in constant time.

```typescript
import type { CacheProvider } from 'blendsdk/webafx-cache';
import { oidcAuthPlugin } from 'blendsdk/webafx-auth';
import type { WebApplication } from 'blendsdk/webafx';

export function installOidcWithCsrf(app: WebApplication, sessionStore: CacheProvider): void {
    app.use(oidcAuthPlugin({
        issuerUrl: 'https://auth.example.com',
        clientId: 'web-app',
        clientSecret: process.env.OIDC_CLIENT_SECRET,
        redirectUri: 'https://app.example.com/api/oidc/callback',
        sessionStore,
        csrf: {
            enabled: true,
            header: 'x-csrf-token', // default
        },
    }));
}
```

A missing or mismatched token produces a fixed `403` with `{ code: 'csrf_invalid' }` and the session is left untouched. Tokens are never placed in script-readable cookies. Two edge cases to know: sessions created before enforcement was enabled have no token and are signed out on their next logout or refresh, and when session-id rotation is enabled a successful refresh regenerates the CSRF token alongside the new session id.

---

## How do I control how long an OIDC session lives?

A handful of static options shape the server-side session, the browser cookie, and renewal. All are read from the static configuration only — a per-request `configFactory` cannot vary them.

```typescript
import type { CacheProvider } from 'blendsdk/webafx-cache';
import { oidcAuthPlugin } from 'blendsdk/webafx-auth';
import type { WebApplication } from 'blendsdk/webafx';

export function installOidcWithSessionPolicy(app: WebApplication, sessionStore: CacheProvider): void {
    app.use(oidcAuthPlugin({
        issuerUrl: 'https://auth.example.com',
        clientId: 'web-app',
        clientSecret: process.env.OIDC_CLIENT_SECRET,
        redirectUri: 'https://app.example.com/api/oidc/callback',
        sessionStore,
        // Sliding idle TTL (seconds): each successful store resets it.
        // Default: 3600.
        sessionTtl: 1800,
        // Hard cap measured from the first store; refresh cannot extend it.
        // Unset keeps idle-TTL-only behavior.
        sessionAbsoluteTtl: 28800,
        // Browser cookie window; falls back to sessionTtl, then 3600.
        // Re-issued on every successful refresh so it slides with the session.
        sessionCookieTtl: 1800,
        // Move the session to a new opaque id on each successful refresh,
        // so an id captured before the refresh stops resolving. Default: false.
        rotateSessionIdOnRefresh: true,
    }));
}
```

Notes:

- With `sessionAbsoluteTtl` set, a stored session past its deadline is rejected and deleted on the next read; a legacy session with no `createdAt` is not signed out — the next store stamps it and gives it a fresh window.
- Rotation happens only after the refresh grant and the new store both succeed; concurrent refreshes for one session are coalesced into a single grant, and every joined caller receives the same rotated id.
- PKCE transient login state has its own lifetime: `stateTtl` (default 300 seconds) bounds the window between the login redirect and the callback.

---

## How do I handle users the identity provider rejects at UserInfo?

By default a UserInfo `403` returns a fixed `403 userinfo_forbidden` with no session. With `userInfoDenied: 'unauthorized-session'`, the callback instead stores a session carrying the exchanged tokens, the identity copied from the verified ID token (only `sub`, `email`, and `name`), and `authorized: false`, then redirects to `notAuthorizedPath`.

```typescript
import type { CacheProvider } from 'blendsdk/webafx-cache';
import { oidcAuthPlugin } from 'blendsdk/webafx-auth';
import type { WebApplication } from 'blendsdk/webafx';

export function installOidcWithDenialHandling(app: WebApplication, sessionStore: CacheProvider): void {
    app.use(oidcAuthPlugin({
        issuerUrl: 'https://auth.example.com',
        clientId: 'web-app',
        clientSecret: process.env.OIDC_CLIENT_SECRET,
        redirectUri: 'https://app.example.com/api/oidc/callback',
        sessionStore,
        // Default 'error' returns a fixed 403 and creates no session.
        // 'unauthorized-session' stores authorized:false and redirects here.
        userInfoDenied: 'unauthorized-session',
        notAuthorizedPath: '/not-authorized',
    }));
}
```

The `authorized` flag is descriptive only — guards must enforce it explicitly, for example in a route handler:

```typescript
const user = await req.services.get<AuthResult>('user', undefined);
if (user?.authorized === false) {
    res.status(403).json({
        success: false,
        error: {
            code: 'not_authorized',
            message: 'Access to this account is not permitted',
        },
    });
    return;
}
```

`GET /me` reports `authorized: false` so the frontend can present a "signed in, but not allowed" state, and the denial survives token refresh. If no verified ID-token identity is available (for example `verifyIdTokenSignature: false`), the outcome falls back to the fixed `403`.

---

## How do I implement a custom authentication backend?

Extend the abstract `AuthProvider` and implement three methods — `validate()`, `health()`, and `shutdown()`. The base class supplies everything else: the configurable extraction chain, the extract → validate lifecycle, claims mapping, and plugin/lifecycle integration via `createAuthPlugin()`.

```typescript
import type { Request } from 'express';
import { WebApplication } from 'blendsdk/webafx';
import { AuthProvider, createAuthPlugin } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

/** Validates static API keys sent in the `x-api-key` header. */
class ApiKeyAuthProvider extends AuthProvider {
    constructor(private readonly keys: Map<string, AuthResult>) {
        super({
            tokenSources: [
                {
                    extractor: (req: Request): string | undefined => {
                        const value = req.headers['x-api-key'];
                        return typeof value === 'string' ? value : undefined;
                    },
                },
            ],
        });
    }

    async validate(token: string): Promise<AuthResult | undefined> {
        // An unknown key resolves to undefined — the silent-failure contract.
        return this.keys.get(token);
    }

    async health(): Promise<boolean> {
        return true;
    }

    async shutdown(): Promise<void> {
        this.keys.clear();
    }
}

const provider = new ApiKeyAuthProvider(new Map<string, AuthResult>([
    ['key-123', { sub: 'service-1', claims: { role: 'service' }, token: 'key-123' }],
]));

const app = new WebApplication({
    PORT: 3000,
    ENV_MODE: 'production',
    LOG_LEVEL: 'INFO',
});

// The whole base-class pipeline is reused: extraction, plugin registration,
// health reporting, and graceful shutdown all come from AuthProvider.
app.use(createAuthPlugin(provider));

await app.start();
```

Two contracts to honor: an invalid or expired token must resolve to `undefined` (not throw), and only infrastructure failures may throw — that is how the secure guard distinguishes "not authenticated" (`401`) from "authentication backend broken" (`500`).

---

# webafx-auth Examples Library

Copy-paste ready examples for every feature area of `blendsdk/webafx-auth`. Every example imports only from package entry points, is strict-mode TypeScript, and targets the Node.js >= 22 ESM runtime. Application examples use `blendsdk/webafx`; test examples use Vitest and Supertest.

---

## 1. Getting Started

### Verify a Token with MemoryAuthProvider

The in-memory provider validates tokens against a fixed map — no crypto, no network. It is the fastest way to bring up a working authentication flow for tests and local development.

```typescript
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';

const provider = new MemoryAuthProvider({
    validTokens: {
        'test-token': {
            sub: 'user-1',
            claims: { role: 'user' },
            token: 'test-token',
        },
    },
});

const result = await provider.validate('test-token');
// → { sub: 'user-1', claims: { role: 'user' }, token: 'test-token' }

const missing = await provider.validate('unknown-token');
// → undefined — invalid tokens resolve to undefined; they never throw
```

### Protect Routes in a WebAFX Application

`memoryAuthPlugin()` registers the provider with the WebAFX service container. Routes declared with `this.authenticated()` resolve the per-request `'user'` service, which the plugin maps to `provider.authenticate(req)`.

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { memoryAuthPlugin } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

class ProfileController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated()
                .get('/api/profile')
                .handle(async (req, res) => {
                    const user = await req.services.get<AuthResult>('user', undefined);
                    this.ok(res, { sub: user?.sub });
                }),
        ];
    }
}

const app = new WebApplication({
    PORT: 3000,
    ENV_MODE: 'development',
    LOG_LEVEL: 'INFO',
});

app.use(memoryAuthPlugin({
    validTokens: {
        'test-token': { sub: 'user-1', claims: {}, token: 'test-token' },
    },
}));

app.registerController('', ProfileController);

await app.start();

// GET /api/profile with 'Authorization: Bearer test-token'
//   → 200 { success: true, data: { sub: 'user-1' } }
// GET /api/profile without a token
//   → 401 — the secure guard rejects before the handler runs
```

### Test a Protected Route End to End

Start the application on an ephemeral port and drive it with Supertest. This is the pattern used for integration tests: real plugin, real guard, real HTTP.

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import supertest from 'supertest';
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { memoryAuthPlugin } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

class PingController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated()
                .get('/ping')
                .handle(async (req, res) => {
                    const user = await req.services.get<AuthResult>('user', undefined);
                    this.ok(res, { sub: user?.sub });
                }),
        ];
    }
}

function createApp(): WebApplication {
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });
    app.use(memoryAuthPlugin({
        validTokens: {
            'valid-token': { sub: 'user-1', claims: {}, token: 'valid-token' },
        },
    }));
    app.registerController('', PingController);
    return app;
}

describe('protected route', () => {
    let shutdown: (() => Promise<void>) | null = null;

    afterEach(async () => {
        if (shutdown) {
            await shutdown();
            shutdown = null;
        }
    });

    it('accepts requests with a valid token', async () => {
        const app = createApp();
        shutdown = await app.start();

        const response = await supertest(app.express)
            .get('/ping')
            .set('Authorization', 'Bearer valid-token')
            .expect(200);

        expect(response.body.data).toEqual({ sub: 'user-1' });
    });

    it('rejects requests without a token', async () => {
        const app = createApp();
        shutdown = await app.start();

        await supertest(app.express).get('/ping').expect(401);
    });
});
```

---

## 2. JWT Authentication

### Verify HS256 Tokens with Claim Checks

`JwtAuthProvider` verifies JWTs locally with the `jose` library — no network calls. Signature, expiration, issuer, and audience are all checked inside `validate()`.

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const secret = process.env.JWT_SECRET;
if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
}

const provider = new JwtAuthProvider({
    secret,
    algorithms: ['HS256'],
    issuer: 'https://auth.example.com',
    audience: 'my-api',
    clockTolerance: 5, // seconds of leeway for exp/nbf checks (default 0)
});

/** Call from your request pipeline with the raw token from the header. */
export async function verifyToken(token: string): Promise<AuthResult | undefined> {
    return provider.validate(token);
}

// verifyToken(validJwt)    → AuthResult { sub, exp, scopes, claims, token }
// verifyToken(expiredJwt)  → undefined
// verifyToken(otherApiJwt) → undefined (issuer or audience mismatch)
// Only unexpected internal failures propagate as thrown exceptions.
```

### Verify RS256 Tokens with a Public CryptoKey

Asymmetric verification accepts a `CryptoKey` as the `secret` config value. Import an SPKI PEM public key with Node's Web Crypto — the key material stays read-only and can be rotated without code changes.

```typescript
import { readFile } from 'node:fs/promises';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

// Import an SPKI PEM public key as a CryptoKey usable for RS256 verification.
const pem = await readFile('./keys/public.pem', 'utf8');
const der = Uint8Array.from(
    Buffer.from(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64')
);
const publicKey: CryptoKey = await crypto.subtle.importKey(
    'spki',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['verify']
);

const provider = new JwtAuthProvider({
    secret: publicKey,
    algorithms: ['RS256'],
    issuer: 'https://auth.example.com',
    audience: 'my-api',
});

/** Verify tokens signed by the matching private key. */
export async function verifyToken(token: string): Promise<AuthResult | undefined> {
    return provider.validate(token);
}

// Correctly signed RS256 token  → AuthResult
// Token signed by another key   → undefined
```

### Fail Closed with requireAudience

`requireAudience` rejects every token while no `audience` is configured, so a token minted for a different API by the same issuer is never accepted unchecked.

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const secret = process.env.JWT_SECRET;
if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
}

const provider = new JwtAuthProvider({
    secret,
    issuer: 'https://auth.example.com',
    audience: 'my-api',
    requireAudience: true,
});

// Token minted for 'my-api' by the issuer           → AuthResult
// Token minted for 'another-api' by the same issuer → undefined (aud mismatch)
// Same config without `audience`                    → every token rejected
```

### Install JWT Authentication as a Plugin

`jwtAuthPlugin()` builds the provider and wraps it in `createAuthPlugin()` in one call. Every `this.authenticated()` route now authenticates through the JWT provider.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { jwtAuthPlugin } from 'blendsdk/webafx-auth';

const secret = process.env.JWT_SECRET;
if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
}

const app = new WebApplication({
    PORT: 3000,
    ENV_MODE: 'production',
    LOG_LEVEL: 'INFO',
});

app.use(jwtAuthPlugin({
    secret,
    algorithms: ['HS256'],
    issuer: 'https://auth.example.com',
    audience: 'my-api',
}));

await app.start();

// Secure routes resolve 'user' through JwtAuthProvider.authenticate(req).
// Health checks and graceful shutdown are delegated to the provider
// automatically by the plugin lifecycle.
```

---

## 3. Token Extraction

### Configure a Fallback Chain

Token sources are tried in order and the first non-empty match wins. Defaults: `['header']`, cookie name `auth_token`, query parameter name `token`.

```typescript
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';

const provider = new MemoryAuthProvider({
    tokenSources: ['header', 'cookie', 'query'],
    cookieName: 'app_session',
    queryParamName: 'access_token',
    validTokens: {
        'valid-token': { sub: 'user-1', claims: {}, token: 'valid-token' },
    },
});

// Requests now authenticate with any of:
//   Authorization: Bearer valid-token       (checked first)
//   Cookie: app_session=valid-token         (fallback for browser clients)
//   GET /resource?access_token=valid-token  (fallback for SSE and callback links)
const result = await provider.validate('valid-token');
// → { sub: 'user-1', claims: {}, token: 'valid-token' }
```

### Extract Tokens from a Custom Header

A custom `TokenExtractor` reads a token from anywhere on the request. Custom sources can be mixed with the built-in ones at any position in the chain.

```typescript
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { TokenSource } from 'blendsdk/webafx-auth';

// Machine clients authenticate with an API key header instead of a Bearer token.
const apiKeySource: TokenSource = {
    extractor: (req) => {
        const value = req.headers['x-api-key'];
        return typeof value === 'string' && value.length > 0 ? value : undefined;
    },
};

const provider = new MemoryAuthProvider({
    tokenSources: [apiKeySource], // e.g. ['header', apiKeySource] to try both
    validTokens: {
        'key-abc123': { sub: 'service-1', claims: {}, token: 'key-abc123' },
    },
});

// A request carrying 'X-API-Key: key-abc123' authenticates as 'service-1'.
const result = await provider.validate('key-abc123');
```

### Drive the Extraction Chain Through HTTP

The same token is accepted from the header, a cookie, or a query parameter — and the header wins when several sources carry a value.

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import supertest from 'supertest';
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { memoryAuthPlugin } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

class WhoAmIController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated()
                .get('/whoami')
                .handle(async (req, res) => {
                    const user = await req.services.get<AuthResult>('user', undefined);
                    this.ok(res, { sub: user?.sub });
                }),
        ];
    }
}

const TOKEN = 'valid-token';

function createApp(): WebApplication {
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });
    app.use(memoryAuthPlugin({
        tokenSources: ['header', 'cookie', 'query'],
        validTokens: { [TOKEN]: { sub: 'user-1', claims: {}, token: TOKEN } },
    }));
    app.registerController('', WhoAmIController);
    return app;
}

describe('token extraction chain', () => {
    let shutdown: (() => Promise<void>) | null = null;

    afterEach(async () => {
        if (shutdown) {
            await shutdown();
            shutdown = null;
        }
    });

    it('accepts the token from the Authorization header', async () => {
        const app = createApp();
        shutdown = await app.start();

        const response = await supertest(app.express)
            .get('/whoami')
            .set('Authorization', `Bearer ${TOKEN}`)
            .expect(200);

        expect(response.body.data).toEqual({ sub: 'user-1' });
    });

    it('falls back to the auth_token cookie', async () => {
        const app = createApp();
        shutdown = await app.start();

        await supertest(app.express)
            .get('/whoami')
            .set('Cookie', `auth_token=${TOKEN}`)
            .expect(200);
    });

    it('falls back to the token query parameter', async () => {
        const app = createApp();
        shutdown = await app.start();

        await supertest(app.express)
            .get('/whoami')
            .query({ token: TOKEN })
            .expect(200);
    });

    it('prefers the header when several sources carry a token', async () => {
        const app = createApp();
        shutdown = await app.start();

        // The invalid cookie is ignored because the header matches first.
        await supertest(app.express)
            .get('/whoami')
            .set('Authorization', `Bearer ${TOKEN}`)
            .set('Cookie', 'auth_token=invalid-token')
            .expect(200);
    });
});
```

---

## 4. Claims Mapping

### See What the Default Mapper Extracts

Every provider runs a default claims mapper that normalizes `sub`, `exp`, and `scope` into the standard `AuthResult`. This example signs a token and shows exactly what comes back.

```typescript
import { SignJWT } from 'jose';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const secret = process.env.JWT_SECRET;
if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
}

const provider = new JwtAuthProvider({ secret, algorithms: ['HS256'] });

// Sign a token the way the identity provider would.
const token = await new SignJWT({ scope: 'openid profile email', role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));

const result = await provider.validate(token);

// result.sub    → 'user-1'                        (from the `sub` claim)
// result.scopes → ['openid', 'profile', 'email']  (space-separated `scope` split)
// result.exp    → seconds since epoch             (numeric `exp`)
// result.token  → the raw token string
// result.claims → the full decoded payload, including `role: 'admin'`
// Without a `sub` claim the mapper falls back to `subject`, then to 'unknown'.
```

### Replace the Mapper with mapClaims

When your provider uses non-standard claim names, supply a `ClaimsMapper` that reshapes the payload. A custom mapper replaces the default one completely — anything it does not set stays undefined.

```typescript
import { SignJWT } from 'jose';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';
import type { ClaimsMapper } from 'blendsdk/webafx-auth';

const secret = process.env.JWT_SECRET;
if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
}

// The provider issues tokens where the user id lives in `user_id` and
// permissions live in `permissions`.
const customMapper: ClaimsMapper = (token, rawClaims) => {
    const permissions = rawClaims.permissions;
    return {
        sub: String(rawClaims.user_id ?? 'unknown'),
        claims: rawClaims,
        token,
        scopes: Array.isArray(permissions) ? permissions.map(String) : undefined,
    };
};

const provider = new JwtAuthProvider({
    secret,
    algorithms: ['HS256'],
    mapClaims: customMapper,
});

const token = await new SignJWT({ user_id: 'user-99', permissions: ['read', 'write'] })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(new TextEncoder().encode(secret));

const result = await provider.validate(token);

// result.sub    → 'user-99'
// result.scopes → ['read', 'write']
// result.exp    → undefined — the custom mapper chose not to extract it
```

### Stamp a Principal Type

The `principalType` config value marks every result from a provider as a user or a client. It is applied only when the mapped result does not already carry a type, so a custom mapper stays authoritative.

```typescript
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';

const machineProvider = new MemoryAuthProvider({
    principalType: 'client',
    validTokens: {
        'service-token': {
            sub: 'service-1',
            claims: { scope: 'reports:read' },
            token: 'service-token',
        },
    },
});

const result = await machineProvider.validate('service-token');
// result.principalType → 'client'

// A value already present on the stored result or set by a custom mapper
// takes precedence over the configured type.
```

---

## 5. Plugin Integration

`createAuthPlugin()` registers the provider as a singleton service and a per-request principal factory. The convenience factories build the provider and the plugin in one call.

| Helper | Provider built | Required config |
| --- | --- | --- |
| `jwtAuthPlugin(config)` | `JwtAuthProvider` | `secret` |
| `introspectionAuthPlugin(config)` | `IntrospectionAuthProvider` | static client triple or `configFactory` |
| `oidcAuthPlugin(config)` | `OidcAuthProvider` | `issuerUrl` or `configFactory` |
| `memoryAuthPlugin(config)` | `MemoryAuthProvider` | none |

### Create a Plugin with Custom Service Names

`AuthPluginOptions` controls the DI service names and install order. Service names must be distinct when multiple providers are installed in one application.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { createAuthPlugin, MemoryAuthProvider } from 'blendsdk/webafx-auth';

const app = new WebApplication({
    PORT: 3000,
    ENV_MODE: 'development',
    LOG_LEVEL: 'INFO',
});

const provider = new MemoryAuthProvider({
    validTokens: {
        'test-token': { sub: 'user-1', claims: {}, token: 'test-token' },
    },
});

const plugin = createAuthPlugin(provider, {
    serviceName: 'auth',     // singleton service name (default 'auth')
    userServiceName: 'user', // per-request principal name (default 'user')
    priority: 10,            // install order, lower first (default 10)
});

app.use(plugin);

console.log(plugin.name);     // 'auth:auth'
console.log(plugin.priority); // 10

// The plugin factory registers two services:
//   'auth' — singleton returning the provider instance
//   'user' — per-request factory calling provider.authenticate(req)
```

### Build Providers and Plugins in One Step

Each convenience factory returns a `PluginDefinition` ready for `app.use()`. Install exactly one auth plugin per application unless each uses a distinct `serviceName`.

```typescript
import {
    introspectionAuthPlugin,
    jwtAuthPlugin,
    memoryAuthPlugin,
    oidcAuthPlugin,
} from 'blendsdk/webafx-auth';

const jwtSecret = process.env.JWT_SECRET;
const introspectSecret = process.env.CLIENT_SECRET;
if (!jwtSecret || !introspectSecret) {
    throw new Error('JWT_SECRET and CLIENT_SECRET environment variables are required');
}

const jwtPlugin = jwtAuthPlugin({ secret: jwtSecret, issuer: 'https://auth.example.com' });

const memoryPlugin = memoryAuthPlugin({
    validTokens: {
        'test-token': { sub: 'user-1', claims: {}, token: 'test-token' },
    },
});

const introspectionPlugin = introspectionAuthPlugin({
    introspectionUrl: 'https://auth.example.com/oauth2/introspect',
    clientId: 'my-api',
    clientSecret: introspectSecret,
});

const oidcPlugin = oidcAuthPlugin({
    issuerUrl: 'https://auth.example.com',
    clientId: 'my-app',
    clientSecret: process.env.OIDC_CLIENT_SECRET,
});

// All four return a PluginDefinition usable with app.use(plugin, options).
// Give each installed plugin a distinct serviceName when installing several.
```

### Delegate Health Checks and Shutdown

Providers expose `health()` and `shutdown()` so WebAFX's health endpoint and graceful-shutdown lifecycle manage them automatically when installed through a plugin.

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const secret = process.env.JWT_SECRET;
if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
}

const provider = new JwtAuthProvider({ secret });

const healthy = await provider.health();
// → true — the signing key is configured; local verification needs nothing else

await provider.shutdown();
// Releases cached key material; the next validate() re-creates it lazily.

// When the provider is installed through createAuthPlugin(), the plugin
// delegates health() and shutdown() to it, so WebAFX's health endpoint and
// application teardown call these methods for you.
```

---

## 6. Provider Factory

### Select a Provider from Configuration

`createAuthProvider()` dispatches on `config.type` and validates the fields each provider requires. Provider-specific fields are used only by the matching type.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { createAuthPlugin, createAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthFactoryConfig } from 'blendsdk/webafx-auth';

function resolveProviderType(): AuthFactoryConfig['type'] {
    const value = process.env.AUTH_TYPE;
    if (
        value === 'jwt' ||
        value === 'introspection' ||
        value === 'oidc' ||
        value === 'memory'
    ) {
        return value;
    }
    return 'jwt';
}

const provider = createAuthProvider({
    type: resolveProviderType(),
    // JWT-specific
    secret: process.env.JWT_SECRET,
    algorithms: ['HS256'],
    // Shared
    issuer: 'https://auth.example.com',
    audience: 'my-api',
    requireAudience: true,
    // Introspection / OIDC
    issuerUrl: process.env.OIDC_ISSUER_URL,
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    introspectionUrl: process.env.INTROSPECT_URL,
});

// type 'jwt'           → JwtAuthProvider           (requires secret)
// type 'introspection' → IntrospectionAuthProvider (requires the URL + client triple, or configFactory)
// type 'oidc'          → OidcAuthProvider          (requires issuerUrl)
// type 'memory'        → MemoryAuthProvider        (no required fields)

const app = new WebApplication({
    PORT: 3000,
    ENV_MODE: 'production',
    LOG_LEVEL: 'INFO',
});

app.use(createAuthPlugin(provider));

await app.start();
```

### Fail Fast on Misconfiguration

A missing required field throws at startup with a message that names the field — never at the first request.

```typescript
import { createAuthProvider } from 'blendsdk/webafx-auth';

try {
    createAuthProvider({ type: 'jwt' });
} catch (error) {
    if (error instanceof Error) {
        console.error(error.message);
        // createAuthProvider: type 'jwt' requires 'secret'
    }
}

try {
    createAuthProvider({ type: 'oidc' });
} catch (error) {
    if (error instanceof Error) {
        console.error(error.message);
        // createAuthProvider: type 'oidc' requires 'issuerUrl'
    }
}

try {
    createAuthProvider({ type: 'introspection' });
} catch (error) {
    if (error instanceof Error) {
        console.error(error.message);
        // createAuthProvider: type 'introspection' requires 'introspectionUrl',
        // 'clientId' and 'clientSecret', or 'configFactory'
    }
}
```

---

## 7. Custom Providers

### Extend the AuthProvider Base Class

Every concrete provider implements only `validate()`, `health()`, and `shutdown()` — extraction, lifecycle, and plugin integration come from the base class.

```typescript
import { AuthProvider } from 'blendsdk/webafx-auth';
import type { AuthProviderConfig, AuthResult } from 'blendsdk/webafx-auth';
import { createAuthPlugin } from 'blendsdk/webafx-auth';

/** Configuration for the example provider. */
interface DatabaseAuthConfig extends AuthProviderConfig {
    /** Looks up a token in your own store. */
    lookupToken: (token: string) => Promise<AuthResult | undefined>;
    /** Reports whether the backing store is reachable. */
    isReachable: () => Promise<boolean>;
}

/**
 * Custom backend: reuse the shared extraction chain, lifecycle, and plugin
 * integration; implement only validate/health/shutdown.
 */
class DatabaseAuthProvider extends AuthProvider {
    private readonly cache = new Map<string, AuthResult>();

    constructor(private readonly databaseConfig: DatabaseAuthConfig) {
        super(databaseConfig);
    }

    async validate(token: string): Promise<AuthResult | undefined> {
        const cached = this.cache.get(token);
        if (cached) {
            return cached;
        }
        const result = await this.databaseConfig.lookupToken(token);
        if (result) {
            this.cache.set(token, result);
        }
        return result;
    }

    async health(): Promise<boolean> {
        return this.databaseConfig.isReachable();
    }

    async shutdown(): Promise<void> {
        this.cache.clear();
    }
}

const provider = new DatabaseAuthProvider({
    tokenSources: ['header'],
    lookupToken: async (token) =>
        token === 'db-token' ? { sub: 'user-1', claims: {}, token } : undefined,
    isReachable: async () => true,
});

const plugin = createAuthPlugin(provider);
// plugin.name → 'auth:auth' — install it with app.use(plugin);
// secure routes resolve 'user' exactly like the built-in providers.
```

### Extend a Concrete Provider

Built-in providers are regular classes. Subclass one to add behavior while keeping all inherited capabilities — extraction chain, verification, plugin registration, and lifecycle.

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

/** Stamps the token's `tenant` claim onto the result as `tenantId`. */
class TenantJwtAuthProvider extends JwtAuthProvider {
    override async validate(token: string): Promise<AuthResult | undefined> {
        const result = await super.validate(token);
        if (!result) {
            return undefined;
        }
        const tenant = result.claims.tenant;
        return typeof tenant === 'string' ? { ...result, tenantId: tenant } : result;
    }
}

const secret = process.env.JWT_SECRET;
if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
}

const provider = new TenantJwtAuthProvider({
    secret,
    issuer: 'https://auth.example.com',
});

// Tokens carrying `tenant: 'acme'` → result.tenantId === 'acme'
// Tokens without the claim        → result unchanged
// Everything else is inherited: extraction chain, claims mapping,
// plugin registration, and health/shutdown.
```

---

## 8. Introspection

### Validate Opaque Tokens with Static Credentials

`IntrospectionAuthProvider` validates tokens that cannot be verified locally by asking the authorization server (RFC 7662). Active responses are cached in a bounded LRU so a warm token does not cause a network call on every request.

```typescript
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';

const clientSecret = process.env.CLIENT_SECRET;
if (!clientSecret) {
    throw new Error('CLIENT_SECRET environment variable is required');
}

const provider = new IntrospectionAuthProvider({
    introspectionUrl: 'https://auth.example.com/oauth2/introspect',
    clientId: 'my-api',
    clientSecret,
    audience: 'https://api.example.com',
});

// provider.validate(<token from the Authorization header>) outcomes:
//   active: true, matching audience  → AuthResult with sub/exp/scopes mapped
//   active: false                    → undefined (revoked or unknown token)
//   mismatched or missing audience   → undefined
//   HTTP 5xx, timeout, network error → thrown (infrastructure failure)
//
// Requests use HTTP Basic auth by default and never follow redirects.
// health() reports true whenever the provider is configured — no network call.
```

### Resolve Per-Tenant Credentials at Request Time

When client credentials live in a database and differ per tenant, a `configFactory` resolves the full configuration per request. Cache entries are scoped by endpoint and client id, so tenants never share responses.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { introspectionAuthPlugin } from 'blendsdk/webafx-auth';

const app = new WebApplication({
    PORT: 3000,
    ENV_MODE: 'production',
    LOG_LEVEL: 'INFO',
});

app.use(introspectionAuthPlugin({
    configFactory: async (req) => {
        const tenant = req.headers['x-tenant-id'];
        if (typeof tenant !== 'string' || tenant.length === 0) {
            throw new Error('Missing x-tenant-id header');
        }
        const clientSecret = process.env[`INTROSPECT_SECRET_${tenant.toUpperCase()}`];
        if (!clientSecret) {
            throw new Error(`No introspection credentials for tenant '${tenant}'`);
        }
        return {
            introspectionUrl: `https://${tenant}.auth.example.com/oauth2/introspect`,
            clientId: `api-${tenant}`,
            clientSecret,
        };
    },
}));

await app.start();

// The factory runs once per authenticated request and takes precedence over
// any static fields. With a configFactory the provider cannot serve
// validate(token) — there is no request context — so authentication flows
// through authenticate(req), which the plugin invokes per request.
// A throwing factory propagates as an infrastructure error; it is never a
// silent rejection.
```

### Use client_secret_post and Tune the Cache

Some authorization servers reject HTTP Basic and require the credentials as form fields. Cache behavior is configurable without changing the request flow.

```typescript
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';

const clientSecret = process.env.CLIENT_SECRET;
if (!clientSecret) {
    throw new Error('CLIENT_SECRET environment variable is required');
}

const provider = new IntrospectionAuthProvider({
    introspectionUrl: 'https://auth.example.com/oauth2/introspect',
    clientId: 'my-api',
    clientSecret,
    authMethod: 'post', // send client_id/client_secret as form fields (default: 'basic')
    cacheTTL: 120,      // seconds a warm token stays cached (default 60)
    maxCacheSize: 500,  // LRU capacity (default 1000)
    timeout: 3000,      // HTTP timeout in milliseconds (default 5000)
});

// Cache keys are SHA-256 digests — the raw token is never stored or logged.
// The effective TTL is clamped to the token's own `exp`, inactive responses
// are never cached, and shutdown() clears the cache.
```

---

## 9. OIDC Provider

### Validate Access Tokens via OIDC Discovery

`OidcAuthProvider` resolves the issuer's JWKS through OIDC discovery and verifies tokens locally. Discovery is cached per issuer for `discoveryTtl` seconds.

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

const provider = new OidcAuthProvider({
    issuerUrl: 'https://auth.example.com',
    clientId: 'my-api',
    audience: 'https://api.example.com',
    clockTolerance: 30, // seconds of leeway (default 30)
});

// provider.validate(<access token>) outcomes:
//   valid token   → AuthResult (signature checked against the issuer's JWKS,
//                   fetched via discovery and cached per issuer — default
//                   discoveryTtl is 3600 seconds)
//   invalid token → undefined (bad signature, expired, wrong issuer/audience)
//   network failure → thrown (infrastructure failure)
```

### Serve Multiple Tenants from One Provider

A `configFactory` resolves the issuer and client per request. Discovery entries are cached per issuer URL, so every tenant gets its own JWKS resolver.

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

const provider = new OidcAuthProvider({
    configFactory: async (req) => {
        const tenant = req.headers['x-tenant-id'];
        if (typeof tenant !== 'string' || tenant.length === 0) {
            throw new Error('Missing x-tenant-id header');
        }
        return {
            issuerUrl: `https://${tenant}.auth.example.com`,
            clientId: `app-${tenant}`,
            clientSecret: process.env[`OIDC_SECRET_${tenant.toUpperCase()}`],
        };
    },
});

// Factory-only providers answer per request: authenticate(req) resolves the
// tenant config, validates the Bearer token, and applies resolveUser or
// mapClaims from the effective config.
// validate(token) returns undefined without a Request context, and health()
// reports false for factory-only setups.
```

### Run the Authorization-Code Flow Manually

The BFF building blocks are public: build the authorization URL, exchange the code with nonce validation, and read the profile with the UserInfo subject check.

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthorizationUrlResult, OidcTokens } from 'blendsdk/webafx-auth';

const provider = new OidcAuthProvider({
    issuerUrl: 'https://auth.example.com',
    clientId: 'my-app',
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    redirectUri: 'https://app.example.com/api/oidc/callback',
    scopes: ['openid', 'profile', 'email'],
});

/**
 * Step 1 — build the authorization URL. Redirect the browser to `url` and
 * store the returned codeVerifier, state, and nonce server-side until the
 * callback arrives.
 */
async function startSignIn(): Promise<AuthorizationUrlResult> {
    return provider.buildAuthorizationUrl();
}

/** Step 2 — complete the flow after the provider redirects the browser back. */
async function completeSignIn(
    pending: AuthorizationUrlResult,
    callbackQuery: { code: string; state: string }
): Promise<{ tokens: OidcTokens; userInfo: Record<string, unknown> }> {
    if (callbackQuery.state !== pending.state) {
        throw new Error('State mismatch (possible CSRF); restart the sign-in');
    }

    const callbackUrl =
        'https://app.example.com/api/oidc/callback' +
        `?code=${encodeURIComponent(callbackQuery.code)}` +
        `&state=${encodeURIComponent(callbackQuery.state)}`;

    const tokens = await provider.exchangeCode({
        codeVerifier: pending.codeVerifier,
        nonce: pending.nonce,
        callbackUrl,
    });

    // Verifies the UserInfo `sub` against the verified ID-token subject
    // (OpenID Connect Core §5.3.2).
    const userInfo = await provider.fetchUserInfo(tokens.accessToken, tokens.subject);

    return { tokens, userInfo };
}

// Related methods for custom flows:
//   provider.refreshToken(refreshToken)               — new tokens without re-authentication
//   provider.revokeToken(accessToken, 'access_token') — revocation on logout
```

### Authenticate with Bearer Tokens or Session Cookies

When a `sessionStore` is configured, `authenticate()` checks the Bearer token first and falls back to the server-side session cookie — the same dual mode the BFF controller relies on.

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';
import type { CacheProvider } from 'blendsdk/webafx-cache';

/**
 * Build an OIDC provider with a server-side session store. Pass the
 * CacheProvider created by your blendsdk/webafx-cache setup.
 */
export function createOidcProvider(sessionStore: CacheProvider): OidcAuthProvider {
    return new OidcAuthProvider({
        issuerUrl: 'https://auth.example.com',
        clientId: 'my-app',
        clientSecret: process.env.OIDC_CLIENT_SECRET,
        sessionStore,
        sessionTtl: 3600,
        // Optional: scope the cookie name per organization (multi-tenant).
        resolveSessionCookieName: (req) => {
            const tenant = req.headers['x-tenant-id'];
            return `__oidc_session_${typeof tenant === 'string' ? tenant : 'default'}`;
        },
    });
}

// authenticate(req) resolution order:
//   1. Bearer token   — verified via OIDC discovery (highest priority)
//   2. Session cookie — server-side session lookup ('__oidc_session' by default)
// A session past its access-token expiry (plus clockTolerance) or past
// sessionAbsoluteTtl stops authenticating and returns undefined.
```

### Trust a Private CA or a Local Issuer

Transport controls point discovery, JWKS, token, and UserInfo requests at a private CA or, for development only, at a non-HTTPS issuer.

```typescript
import { readFile } from 'node:fs/promises';
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

// Trust a private CA (a PEM bundle). `ca` replaces the default trust store;
// include the public roots in it when both are needed.
const ca = await readFile('./certs/private-ca.pem', 'utf8');

const provider = new OidcAuthProvider({
    issuerUrl: 'https://idp.internal.example.com',
    clientId: 'my-api',
    transport: { ca },
});

// Development and test only: accept a loopback issuer and skip TLS
// certificate validation. The provider emits a one-time warning when used.
const devProvider = new OidcAuthProvider({
    issuerUrl: 'http://localhost:8080',
    clientId: 'my-api',
    transport: { allowInsecureRequests: true },
});
```

### Handle Typed OIDC Flow Errors

Flow failures carry stable error types that distinguish a rejected sign-in from an infrastructure failure — map them directly to HTTP responses.

```typescript
import {
    OidcAuthProvider,
    OidcCodeExchangeError,
    OidcUserInfoForbiddenError,
    OidcUserInfoSubjectMismatchError,
} from 'blendsdk/webafx-auth';
import type { ExchangeCodeParams, OidcTokens } from 'blendsdk/webafx-auth';

/** Outcome the calling route maps to an HTTP response. */
type SignInOutcome =
    | { status: 'ok'; tokens: OidcTokens; userInfo: Record<string, unknown> }
    | { status: 'failed' }
    | { status: 'denied' }
    | { status: 'mismatch' };

/**
 * Complete a code exchange and fetch the profile, classifying failures:
 * a rejected sign-in is not a server error.
 */
export async function completeSignIn(
    provider: OidcAuthProvider,
    params: ExchangeCodeParams
): Promise<SignInOutcome> {
    try {
        const tokens = await provider.exchangeCode(params);
        const userInfo = await provider.fetchUserInfo(tokens.accessToken, tokens.subject);
        return { status: 'ok', tokens, userInfo };
    } catch (error) {
        if (error instanceof OidcCodeExchangeError) {
            // Invalid/expired code, failed ID-token verification → 400.
            return { status: 'failed' };
        }
        if (error instanceof OidcUserInfoSubjectMismatchError) {
            // UserInfo `sub` ≠ ID-token `sub` → reject; never use the claims.
            return { status: 'mismatch' };
        }
        if (error instanceof OidcUserInfoForbiddenError) {
            // Authenticated but not allowed → present a denial state.
            return { status: 'denied' };
        }
        // Discovery, network, and 5xx failures stay infrastructure errors.
        throw error;
    }
}
```

---

## 10. OIDC BFF Controller

### Register the BFF Controller

`OidcAuthController` provides the five browser-facing routes of the OIDC authorization-code flow over a server-side session. It resolves its provider from the DI container registered by the auth plugin.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { OidcAuthController, oidcAuthPlugin } from 'blendsdk/webafx-auth';
import type { CacheProvider } from 'blendsdk/webafx-cache';

/** Controller subclass; all hooks have working defaults. */
class AuthController extends OidcAuthController {}

/**
 * Wire the OIDC BFF flow: provider plugin + controller.
 * `sessionStore` is your blendsdk/webafx-cache CacheProvider.
 */
export function registerOidcAuth(app: WebApplication, sessionStore: CacheProvider): void {
    app.use(oidcAuthPlugin({
        issuerUrl: 'https://auth.example.com',
        clientId: 'my-app',
        clientSecret: process.env.OIDC_CLIENT_SECRET,
        redirectUri: 'https://app.example.com/api/oidc/callback',
        sessionStore,
    }));

    app.use(AuthController);
}

// Routes (default prefix '/api/oidc'):
//   GET  /api/oidc/login     — 302 to the authorization endpoint (PKCE, state, nonce stored server-side)
//   GET  /api/oidc/callback  — exchange code, verify ID token, create session cookie
//   POST /api/oidc/logout    — revoke tokens, clear the session (public; validates the cookie itself)
//   GET  /api/oidc/me        — current user, expiry, and authorization state (authenticated)
//   POST /api/oidc/refresh   — refresh tokens and re-issue the cookie (public; self-validating)
```

### Customize Hooks and Routes

Every hook has a working default. Override only what you need: the route prefix, login parameters, the callback enrichment step, session scoping, and more.

```typescript
import { OidcAuthController } from 'blendsdk/webafx-auth';
import type { BuildAuthorizationUrlParams, OidcTokens } from 'blendsdk/webafx-auth';
import type { Request, Response } from 'express';

export class AppAuthController extends OidcAuthController {
    /** Serve the flow under a different prefix. */
    protected getRoutePrefix(): string {
        return '/auth/oidc';
    }

    /** Force a fresh authentication on every login. */
    protected getLoginParams(_req: Request): BuildAuthorizationUrlParams {
        return { extraParams: { prompt: 'login' } };
    }

    /** Enrich the session user before it is stored. */
    protected async onCallback(
        tokens: OidcTokens,
        userInfo: Record<string, unknown>,
        _req: Request,
        _res: Response
    ): Promise<{ tokens: OidcTokens; userInfo: Record<string, unknown> }> {
        return {
            tokens,
            userInfo: { ...userInfo, appRole: 'member' },
        };
    }

    /** Resolve a tenant slug for org-scoped cookie names (multi-tenant). */
    protected resolveOrganization(req: Request): string | undefined {
        const tenant = req.headers['x-tenant-id'];
        return typeof tenant === 'string' && tenant.length > 0 ? tenant : undefined;
    }
}

// Other overridable members:
//   onLogout(req, res)            — runs before the session is cleared (default: no-op)
//   resolveConfig(req, provider)  — custom per-request config resolution
//   getProviderServiceName()      — provider DI service name (default 'auth')
// The default getLoginParams() forwards `prompt` and `login_hint` query values.
```

### Enable CSRF Protection

Opt-in CSRF enforcement gives the client a session-bound token via `GET /me` and requires it on the two mutating routes. Comparison is constant-time.

```typescript
import { oidcAuthPlugin } from 'blendsdk/webafx-auth';
import type { CacheProvider } from 'blendsdk/webafx-cache';
import type { PluginDefinition } from 'blendsdk/webafx';

/** Build the OIDC plugin with CSRF enforcement enabled. */
export function createCsrfProtectedOidcPlugin(sessionStore: CacheProvider): PluginDefinition {
    return oidcAuthPlugin({
        issuerUrl: 'https://auth.example.com',
        clientId: 'my-app',
        redirectUri: 'https://app.example.com/api/oidc/callback',
        sessionStore,
        csrf: { enabled: true }, // header defaults to 'x-csrf-token'
    });
}

// With CSRF enforcement on:
//   GET  /api/oidc/me       → payload includes `csrfToken`
//   POST /api/oidc/logout   → requires the token in the header
//   POST /api/oidc/refresh  → requires the token in the header
// Missing or mismatched token → 403
//   { success: false, error: { code: 'csrf_invalid', message: 'Invalid or missing CSRF token' } }
// The token is stored server-side in the session and never placed in a
// script-readable cookie. Sessions created before enforcement was enabled
// have no token and are rejected on their next logout or refresh.
```

### Tune Session Lifetime and Rotation

Sessions slide with each successful refresh, can be capped by an absolute deadline that activity cannot extend, and can rotate their opaque id on every refresh.

```typescript
import { oidcAuthPlugin } from 'blendsdk/webafx-auth';
import type { CacheProvider } from 'blendsdk/webafx-cache';
import type { PluginDefinition } from 'blendsdk/webafx';

/** Build the OIDC plugin with hardened session lifetimes. */
export function createTunedOidcPlugin(sessionStore: CacheProvider): PluginDefinition {
    return oidcAuthPlugin({
        issuerUrl: 'https://auth.example.com',
        clientId: 'my-app',
        redirectUri: 'https://app.example.com/api/oidc/callback',
        sessionStore,
        sessionTtl: 3600,          // sliding server-side TTL (default 3600s)
        sessionAbsoluteTtl: 28800, // hard 8-hour cap; refresh cannot extend it
        sessionCookieTtl: 3600,    // cookie window; follows sessionTtl when unset
        stateTtl: 300,             // PKCE transient state TTL (default 300s)
        rotateSessionIdOnRefresh: true, // new session id + cookie after each refresh
    });
}

// Session mechanics:
//   - Sessions and PKCE state live in the CacheProvider under
//     'oidc:session:<uuid>' and 'oidc:state:<uuid>' keys.
//   - Each successful refresh slides the TTL and re-issues the session cookie.
//   - sessionAbsoluteTtl is measured from the first store; refresh preserves
//     the original creation time, so activity never extends it.
//   - Rotation runs only after the refresh and the new session store both
//     succeed; a failure leaves the existing session and cookie in place.
```

### Create Unauthorized Sessions on UserInfo Denial

When the identity provider authenticates a user but the application denies access, the opt-in `'unauthorized-session'` policy stores a marked session from the verified ID token instead of failing the callback.

```typescript
import { oidcAuthPlugin } from 'blendsdk/webafx-auth';
import type { CacheProvider } from 'blendsdk/webafx-cache';
import type { PluginDefinition } from 'blendsdk/webafx';

/** Store a "signed in but not allowed" session instead of failing the callback. */
export function createOidcPluginWithDeniedSessions(
    sessionStore: CacheProvider
): PluginDefinition {
    return oidcAuthPlugin({
        issuerUrl: 'https://auth.example.com',
        clientId: 'my-app',
        redirectUri: 'https://app.example.com/api/oidc/callback',
        sessionStore,
        userInfoDenied: 'unauthorized-session',
        notAuthorizedPath: '/not-authorized',
    });
}

// When the UserInfo endpoint returns HTTP 403 (identity provider authenticated
// the user, the application does not allow access):
//   - the callback stores a session with `authorized: false` whose identity is
//     copied from the verified ID token (sub, email, name only),
//   - sets the session cookie, and redirects the browser to /not-authorized.
// GET /api/oidc/me returns { authorized: false, user }; the provider's session
// path authenticates with `authorized: false`, so route guards can deny by
// policy. The default ('error') returns a fixed 403 and creates no session;
// without a verified ID token the fallback is always the fixed 403.
```

---

## 11. Multiple Providers

### Users and Machines on Separate Routes

Two auth plugins with distinct service names route each request to its own principal. A route selects its provider through the principal name it declares with `secure()`.

```typescript
import { describe, test, expect, afterEach } from 'vitest';
import supertest from 'supertest';
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
                .get('/user/profile')
                .handle(async (req, res) => {
                    const user = await req.services.get<AuthResult>('user', undefined);
                    this.ok(res, { sub: user?.sub, kind: 'user' });
                }),

            this.route()
                .get('/machine/stats')
                .secure('client')
                .handle(async (req, res) => {
                    const client = await req.services.get<AuthResult>('client', undefined);
                    this.ok(res, { sub: client?.sub, kind: 'client' });
                }),
        ];
    }
}

function createApp(): WebApplication {
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });

    app.use(createAuthPlugin(
        new MemoryAuthProvider({
            validTokens: {
                [USER_TOKEN]: { sub: 'user-1', claims: { kind: 'user' }, token: USER_TOKEN },
            },
        }),
        { serviceName: 'user-auth', userServiceName: 'user' }
    ));

    app.use(createAuthPlugin(
        new MemoryAuthProvider({
            validTokens: {
                [CLIENT_TOKEN]: { sub: 'client-1', claims: { kind: 'client' }, token: CLIENT_TOKEN },
            },
        }),
        { serviceName: 'client-auth', userServiceName: 'client' }
    ));

    app.registerController('', ApiController);
    return app;
}

describe('multiple auth providers', () => {
    let shutdown: (() => Promise<void>) | null = null;

    afterEach(async () => {
        if (shutdown) {
            await shutdown();
            shutdown = null;
        }
    });

    test('the machine route accepts the client token', async () => {
        const app = createApp();
        shutdown = await app.start();

        const response = await supertest(app.express)
            .get('/machine/stats')
            .set('Authorization', `Bearer ${CLIENT_TOKEN}`)
            .expect(200);

        expect(response.body.data).toEqual({ sub: 'client-1', kind: 'client' });
    });

    test('the user route rejects the client token', async () => {
        const app = createApp();
        shutdown = await app.start();

        await supertest(app.express)
            .get('/user/profile')
            .set('Authorization', `Bearer ${CLIENT_TOKEN}`)
            .expect(401);
    });

    test('each provider accepts its own token', async () => {
        const app = createApp();
        shutdown = await app.start();

        await supertest(app.express)
            .get('/user/profile')
            .set('Authorization', `Bearer ${USER_TOKEN}`)
            .expect(200);

        await supertest(app.express)
            .get('/machine/stats')
            .set('Authorization', `Bearer ${CLIENT_TOKEN}`)
            .expect(200);
    });
});
```

### Avoid Plugin Name Collisions

Two plugins that share a service name produce the same plugin name, and WebAFX rejects the second registration at startup instead of silently replacing the first.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { createAuthPlugin, MemoryAuthProvider } from 'blendsdk/webafx-auth';

const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });

app.use(createAuthPlugin(new MemoryAuthProvider()));

try {
    app.use(createAuthPlugin(new MemoryAuthProvider()));
} catch (error) {
    if (error instanceof Error) {
        console.error(error.message);
        // Plugin "auth:auth" is already registered
    }
}

// Fix: give every provider a distinct serviceName.
app.use(createAuthPlugin(new MemoryAuthProvider(), { serviceName: 'second-auth' }));
```

---

## 12. Testing

### Manage Test Tokens at Runtime

`MemoryAuthProvider` supports adding, removing, and counting tokens at runtime — perfect for revocation scenarios and per-test setup. `shutdown()` clears the map entirely.

```typescript
import { describe, it, expect } from 'vitest';
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';

describe('MemoryAuthProvider runtime tokens', () => {
    it('revokes a token with removeToken()', async () => {
        const provider = new MemoryAuthProvider({
            validTokens: {
                'kept-token': { sub: 'user-1', claims: {}, token: 'kept-token' },
                'revoked-token': { sub: 'user-2', claims: {}, token: 'revoked-token' },
            },
        });
        expect(provider.getTokenCount()).toBe(2);

        const removed = provider.removeToken('revoked-token');
        expect(removed).toBe(true);

        await expect(provider.validate('revoked-token')).resolves.toBeUndefined();
        await expect(provider.validate('kept-token')).resolves.toBeDefined();
    });

    it('adds a token at runtime with addToken()', async () => {
        const provider = new MemoryAuthProvider();

        provider.addToken('fresh-token', {
            sub: 'user-3',
            claims: {},
            token: 'fresh-token',
        });

        const result = await provider.validate('fresh-token');
        expect(result?.sub).toBe('user-3');
        expect(provider.getTokenCount()).toBe(1);
    });

    it('clears every token on shutdown()', async () => {
        const provider = new MemoryAuthProvider({
            validTokens: {
                'test-token': { sub: 'user-1', claims: {}, token: 'test-token' },
            },
        });

        await provider.shutdown();

        expect(provider.getTokenCount()).toBe(0);
        await expect(provider.validate('test-token')).resolves.toBeUndefined();
    });
});
```

### Sign Real JWTs in Provider Tests

`JwtAuthProvider` verifies real cryptography, so tests sign real tokens. The `jose` library ships as a dependency of the package and works directly in test files.

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SignJWT } from 'jose';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const TEST_SECRET = 'test-secret-that-is-at-least-32-characters';

async function signTestJwt(options: { sub?: string; exp?: number } = {}): Promise<string> {
    return new SignJWT({ scope: 'read write' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(options.sub ?? 'test-user-1')
        .setIssuer('https://auth.test.example.com')
        .setAudience('test-client')
        .setIssuedAt()
        .setExpirationTime(options.exp ?? Math.floor(Date.now() / 1000) + 3600)
        .sign(new TextEncoder().encode(TEST_SECRET));
}

describe('JwtAuthProvider', () => {
    let provider: JwtAuthProvider;

    beforeEach(() => {
        provider = new JwtAuthProvider({
            secret: TEST_SECRET,
            algorithms: ['HS256'],
            issuer: 'https://auth.test.example.com',
            audience: 'test-client',
        });
    });

    afterEach(async () => {
        await provider.shutdown();
    });

    it('accepts a valid HS256 token', async () => {
        const result = await provider.validate(await signTestJwt({ sub: 'user-42' }));

        expect(result?.sub).toBe('user-42');
        expect(result?.scopes).toEqual(['read', 'write']);
    });

    it('rejects an expired token', async () => {
        const token = await signTestJwt({ exp: Math.floor(Date.now() / 1000) - 3600 });

        await expect(provider.validate(token)).resolves.toBeUndefined();
    });

    it('rejects a token signed with a different secret', async () => {
        const token = await new SignJWT({ sub: 'user-1' })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuer('https://auth.test.example.com')
            .setAudience('test-client')
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(new TextEncoder().encode('another-secret-also-at-least-256-bits-long!!'));

        await expect(provider.validate(token)).resolves.toBeUndefined();
    });
});
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
