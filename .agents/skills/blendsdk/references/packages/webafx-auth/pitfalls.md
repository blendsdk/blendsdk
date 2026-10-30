> **Package**: `blendsdk/webafx-auth`

# webafx-auth Best Practices

`blendsdk/webafx-auth` is built around a small set of deliberate contracts: one long-lived provider per authentication backend, an extract → validate lifecycle that returns `undefined` for bad credentials and throws only on infrastructure failures, per-request configuration resolved through `authenticate(req)`, and a plugin layer that owns service registration, health, and shutdown. The practices below follow directly from those contracts.

---

## Do / Don't Pairs

### 1. Construct providers once, at startup

**❌ Wrong — a provider per request**

```typescript fragment
this.authenticated().get('/reports').handle(async (req, res) => {
    // ❌ New provider on every call: no shared key cache, no startup
    // validation, no lifecycle wiring.
    const provider = new JwtAuthProvider({ secret: process.env.JWT_SECRET ?? '' });
    const user = await provider.authenticate(req);
    this.ok(res, { sub: user?.sub });
});
```

Why it's problematic:

- Every construction re-encodes the HMAC key — `JwtAuthProvider` caches the `jose`-compatible key **per instance**, and per-request instances throw that cache away.
- `process.env.JWT_SECRET ?? ''` turns a missing environment variable into an empty secret. Nothing throws at boot; instead, verification fails on every request and — because `validate()` follows the silent-failure contract — surfaces as `undefined`, i.e. every user is silently unauthenticated.
- These throwaway objects can never be reached by `health()`/`shutdown()`, so WebAFX's health and shutdown lifecycles know nothing about them.

**✅ Correct — one instance, installed once, configuration resolved at boot**

```typescript fragment
function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

const jwtSecret = requireEnv('JWT_SECRET');

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'INFO' });
app.use(jwtAuthPlugin({
    secret: jwtSecret,
    algorithms: ['HS256'],
    issuer: 'https://auth.example.com',
    audience: 'https://api.example.com',
    requireAudience: true,
}));
```

The provider is an application-wide singleton by design: the key cache, OIDC discovery cache, introspection LRU, and in-flight refresh maps all live on the instance. `createAuthPlugin()` registers it in the container and delegates `health()`/`shutdown()` so the framework manages it.

---

### 2. Let the guard authenticate; read the principal from the container

**❌ Wrong — re-authenticating inside the handler**

```typescript fragment
this.authenticated().get('/reports').handle(async (req, res) => {
    // ❌ The plugin already resolved the principal for the guard's check;
    // this runs the full validation a second time for the same request.
    const provider = await req.services.get<JwtAuthProvider>('auth');
    const user = await provider.authenticate(req);
    this.ok(res, { sub: user?.sub });
});
```

Why it's problematic: it duplicates verification work per request. For JWT that is a second signature check; for OIDC it repeats JWKS-based validation and possibly a session-store read; for introspection it at best hits the LRU cache and at worst performs another HTTP call. The result the request was authorized on is the one the plugin already produced.

**✅ Correct — read the resolved principal**

```typescript fragment
this.authenticated().get('/reports').handle(async (req, res) => {
    const user = await req.services.get<AuthResult>('user', undefined);
    this.ok(res, { sub: user?.sub });
});
```

`createAuthPlugin()` registers a per-request `'user'` factory that calls `provider.authenticate(req)`; the secure guard gates on it and handlers consume it. The same lookup works under any principal name the plugin registered (see pair 6).

---

### 3. Call `authenticate(req)`, not `validate(token)`, when configuration is per-request

**❌ Wrong — bypassing the request-aware entry point**

```typescript fragment
const provider = new OidcAuthProvider({
    configFactory: async (req) => resolveTenantConfig(req),
});

// ❌ In factory-only mode there is no Request context. validate() always
// returns undefined, so every request is silently unauthenticated.
const token = provider.extractToken(req);
const user = token ? await provider.validate(token) : undefined;
```

Why it's problematic: `validate()` has no request in scope. With a `configFactory` (OIDC) or a factory-only introspection provider, `validate()` cannot resolve credentials and returns `undefined` for **every** token — a silent, total authentication failure with no error to trace. `IntrospectionAuthProvider` documents this explicitly: "in factory-only mode use `authenticate(req)`."

**✅ Correct**

```typescript fragment
const user = await provider.authenticate(req);
```

`authenticate()` is the extraction + per-request-config + validation lifecycle. Reserve `validate(token)` for callers that already hold a token and use a static configuration — for example a tenant-delegating provider built on the exported `TenantAuthConfig` contracts.

---

### 4. Keep the token extraction chain narrow

**❌ Wrong — widening every route just in case**

```typescript fragment
app.use(jwtAuthPlugin({
    secret: jwtSecret,
    // ❌ Query tokens leak into access logs, browser history, and Referer
    // headers; cookies ride along on cross-site requests.
    tokenSources: ['header', 'cookie', 'query'],
}));
```

Why it's problematic: sources are tried in order and the first match wins, so each additional source widens where a credential may legitimately arrive — for **every** route the provider serves. Query-string tokens are retained by proxies and browser history; cookie tokens are attached automatically by the browser, and the `'cookie'` source also depends on cookie-parser being installed.

**✅ Correct — scope non-header sources to the routes that need them**

```typescript fragment
// ✅ The default is ['header'] — keep it for APIs.
app.use(jwtAuthPlugin({ secret: jwtSecret }));

// A webhook or SSE endpoint that cannot set headers gets its own provider...
app.use(jwtAuthPlugin(
    { secret: jwtSecret, tokenSources: ['query'], queryParamName: 'access_token' },
    { serviceName: 'sse-auth', userServiceName: 'sse' },
));

// ...and only those routes select it.
this.route().get('/events').secure('sse').handle(streamHandler);
```

---

### 5. Harden validation: pin algorithms, issuer, and audience

**❌ Wrong — accepting anything the secret signs**

```typescript fragment
// ❌ No issuer pin, no audience check: any token signed with this secret —
// including one minted for a different API — is accepted here.
const provider = new JwtAuthProvider({ secret: jwtSecret });
```

Why it's problematic: without `issuer` and `audience`, a token issued for another service that happens to share the issuer (or any token signed with a leaked secret) validates here. Leaving the audience unchecked is the classic confused-deputy setup in multi-API deployments.

**✅ Correct**

```typescript fragment
const provider = new JwtAuthProvider({
    secret: jwtSecret,
    algorithms: ['HS256'],              // pin the accepted algorithm(s)
    issuer: 'https://auth.example.com', // pin the issuer
    audience: 'https://api.example.com',
    requireAudience: true,              // fail closed if the audience is ever removed
    clockTolerance: 5,
});
```

`requireAudience: true` with no `audience` configured rejects **every** token — fail closed — instead of silently skipping the check. OIDC and introspection share the same `audience`/`requireAudience` contract, and introspection re-checks the audience on every cache hit, so tightening the configuration can never be bypassed by a cached response.

---

### 6. Give every provider its own names, and select the principal on the route

**❌ Wrong — both plugins with default names**

```typescript fragment
// ❌ Both plugins use the default serviceName 'auth'. Startup fails with
// Plugin "auth:auth" is already registered
app.use(createAuthPlugin(userProvider));
app.use(createAuthPlugin(clientProvider));
```

Why it's problematic: the plugin name is `auth:<serviceName>` and duplicates are rejected at boot to prevent one provider silently replacing another. The quieter failure is the counterpart: setting `userServiceName: 'client'` on a plugin but leaving routes unnamed — an unnamed secure route always resolves the default `'user'` service, so the custom principal is never consulted and valid tokens look unauthenticated.

**✅ Correct** — the whole wiring, end to end:

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { createAuthPlugin, MemoryAuthProvider, type AuthResult } from 'blendsdk/webafx-auth';

const USER_TOKEN = 'user-token';
const CLIENT_TOKEN = 'client-token';

class ReportsController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated()
                .get('/reports')
                .handle(async (req, res) => {
                    const user = await req.services.get<AuthResult>('user', undefined);
                    this.ok(res, { reportedFor: user?.sub });
                }),
            this.route()
                .get('/machine/reports')
                .secure('client')
                .handle(async (req, res) => {
                    const client = await req.services.get<AuthResult>('client', undefined);
                    this.ok(res, { reportedFor: client?.sub });
                }),
        ];
    }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'INFO' });

// The in-memory double stands in for JwtAuthProvider / IntrospectionAuthProvider here.
app.use(
    createAuthPlugin(
        new MemoryAuthProvider({
            validTokens: {
                [USER_TOKEN]: { sub: 'user-1', claims: {}, token: USER_TOKEN },
            },
        }),
        { serviceName: 'user-auth', userServiceName: 'user' },
    ),
);

app.use(
    createAuthPlugin(
        new MemoryAuthProvider({
            validTokens: {
                [CLIENT_TOKEN]: { sub: 'client-1', claims: {}, token: CLIENT_TOKEN },
            },
        }),
        { serviceName: 'client-auth', userServiceName: 'client' },
    ),
);

app.registerController('', ReportsController);

await app.start();
```

`serviceName` (plugin + DI name of the provider), `userServiceName` (DI name of the per-request principal), and `secure(name)` on routes are one contract: the route must name the principal that its provider registered.

---

### 7. Respect the silent-failure contract

**❌ Wrong — collapsing an outage into "not logged in"**

```typescript fragment
// ❌ An infrastructure outage (cache store down, IdP unreachable) becomes a
// 401. The incident looks like a wave of logged-out users, and the real
// error never reaches the framework error handler.
let user: AuthResult | undefined;
try {
    user = await provider.authenticate(req);
} catch {
    user = undefined;
}
```

Why it's problematic: providers return `undefined` for invalid, expired, or missing tokens — that is the normal path. Only infrastructure failures throw: network/DNS errors, non-2xx introspection responses, timeouts, a throwing `configFactory`, and session-store errors (an OIDC session lookup failure propagates rather than logging the user out). Catching everything erases the distinction in both directions: real outages become silent 401s, and credential failures masquerade as health issues.

**✅ Correct**

```typescript fragment
// ✅ undefined = bad or missing token (expect it).
// A throw = infrastructure failure — let it reach the framework error handler.
const user = await provider.authenticate(req);
if (!user) {
    res.status(401).json({
        success: false,
        error: { code: 'unauthorized', message: 'Authentication required' },
    });
    return;
}
```

The plugin and secure guard already implement this split; if you hand-roll an optional-auth route, keep it.

---

### 8. Keep OIDC verification defaults on

**❌ Wrong — "fixing" a key problem by disabling checks**

```typescript fragment
app.use(oidcAuthPlugin({
    issuerUrl,
    clientId,
    clientSecret,
    redirectUri,
    verifyIdTokenSignature: false,  // ❌ disables non-repudiation
    verifyUserInfoSubject: false,   // ❌ drops the OIDC Core §5.3.2 subject check
}));
```

Why it's problematic: the ID-token signature is what makes the subject non-repudiable. With `verifyIdTokenSignature: false` there is no trusted subject, so the UserInfo subject comparison is **also** skipped (a one-time warning is emitted), and a mismatched UserInfo response can no longer be tied to the identity the ID token proved. With `verifyUserInfoSubject: true` (the default), a mismatch aborts the callback with a fixed `400` and creates no session — that protection disappears too. A JWKS mismatch is a trust-configuration problem, not a reason to disable verification.

**✅ Correct**

```typescript fragment
app.use(oidcAuthPlugin({
    issuerUrl,
    clientId,
    clientSecret,
    redirectUri,
    // verifyIdTokenSignature defaults to true — keep it.
    // verifyUserInfoSubject  defaults to true — keep it.
}));
```

Fix the underlying trust problem instead: point `transport.ca` at the issuer's private CA, or correct the discovery/JWKS configuration.

---

### 9. Never expose token material to the client

**❌ Wrong — folding tokens into the profile**

```typescript fragment
class MyAuthController extends OidcAuthController {
    protected async onCallback(
        tokens: OidcTokens,
        userInfo: Record<string, unknown>,
    ): Promise<{ tokens: OidcTokens; userInfo: Record<string, unknown> }> {
        // ❌ userInfo is stored as session.user and returned verbatim by
        // GET /me; token material must never be part of it.
        return {
            tokens,
            userInfo: {
                ...userInfo,
                access_token: tokens.accessToken,
                id_token: tokens.idToken,
            },
        };
    }
}
```

Why it's problematic: `GET /me` returns `session.user` to the browser. Anything you put in `userInfo` in the `onCallback` hook becomes part of that payload — the package deliberately returns only user claims, the expiry, the authorization state, and (optionally) the CSRF token.

**✅ Correct**

```typescript fragment
class MyAuthController extends OidcAuthController {
    protected async onCallback(
        tokens: OidcTokens,
        userInfo: Record<string, unknown>,
    ): Promise<{ tokens: OidcTokens; userInfo: Record<string, unknown> }> {
        // ✅ Tokens stay in the server-side session; enrich the profile with
        // application data only.
        const profile = await users.findBySubject(String(userInfo.sub));
        return {
            tokens,
            userInfo: {
                sub: userInfo.sub,
                email: userInfo.email,
                roles: profile?.roles ?? [],
            },
        };
    }
}
```

The browser holds only an opaque UUID session cookie; tokens live in the `CacheProvider` and are used server-side.

---

### 10. Enable CSRF for the browser session, and ship the client change with it

**❌ Wrong — cookie-only validation on state-changing routes**

```typescript fragment
// ❌ Logout and refresh are public POST routes validated only by the session
// cookie; any page can make a signed-in browser call them.
app.use(oidcAuthPlugin({ issuerUrl, clientId, clientSecret, redirectUri }));
```

Why it's problematic: the session cookie is `httpOnly` and `sameSite=lax`, but `POST /logout` and `POST /refresh` change state. Without CSRF enforcement they accept any request the browser attaches the cookie to — classic login-CSRF and session-fixation territory.

**✅ Correct**

```typescript fragment
app.use(oidcAuthPlugin({
    issuerUrl,
    clientId,
    clientSecret,
    redirectUri,
    csrf: { enabled: true },           // logout/refresh require the session's token
    sessionAbsoluteTtl: 8 * 60 * 60,   // hard cap on any session's lifetime
}));

// Client: read the per-session token from GET /api/oidc/me, then send it on
// mutations — e.g. fetch('/api/oidc/refresh', { method: 'POST',
// headers: { 'x-csrf-token': csrfToken } }).
```

Comparison is constant-time, and the token is stored server-side and returned only through `/me` — never placed in a script-readable cookie. One rollout note: sessions created **before** enforcement was enabled have no token, so enabling CSRF signs them out on their next logout or refresh. Ship the client change and the config change together.

---

### 11. Keep upstream error detail off the wire

**❌ Wrong — serializing `cause` to the caller**

```typescript fragment
} catch (error) {
    if (error instanceof OidcCodeExchangeError) {
        // ❌ error.cause carries the original library error and may contain
        // provider response detail; never serialize it to a client.
        res.status(400).json({
            success: false,
            error: { code: 'login_failed', message: String(error.cause) },
        });
        return;
    }
    throw error;
}
```

Why it's problematic: the typed flow errors exist so callers never inspect `openid-client` internals. Their messages are fixed and safe; `cause` is for programmatic inspection only and — per the source documentation — "must not be forwarded to a client, and not logged verbatim, because it may contain provider response detail." The controller itself also never reflects upstream `error`/`error_description` query parameters.

**✅ Correct**

```typescript fragment
} catch (error) {
    if (error instanceof OidcCodeExchangeError) {
        // ✅ Fixed, safe message; diagnostics stay server-side.
        res.status(400).json({
            success: false,
            error: {
                code: 'oidc_exchange_failed',
                message: 'Sign-in could not be completed',
            },
        });
        return;
    }
    throw error;
}
```

---

### 12. Test-only affordances never ship

**❌ Wrong — a fixed token map and a TLS bypass in production wiring**

```typescript fragment
// ❌ A predictable literal token authenticates anyone who sends it.
app.use(memoryAuthPlugin({
    validTokens: { 'test-token': { sub: 'dev-user', claims: {}, token: 'test-token' } },
}));

// ❌ Permits non-HTTPS issuers and disables certificate validation.
app.use(oidcAuthPlugin({ ...oidcConfig, transport: { allowInsecureRequests: true } }));
```

Why it's problematic: `MemoryAuthProvider` authenticates any request whose token matches its map — shipping it (or a leftover dev token) is a complete authentication bypass. `allowInsecureRequests` both allows plain HTTP issuers and disables TLS certificate validation; the provider warns once per instance precisely because it must never be on in production.

**✅ Correct**

```typescript fragment
// ✅ Production wiring: the real provider, default transport (HTTPS, system trust).
app.use(oidcAuthPlugin(oidcConfig));

// ✅ The in-memory double is opt-in, behind a check that cannot pass in production.
if (process.env.NODE_ENV !== 'production') {
    app.use(memoryAuthPlugin({
        validTokens: { 'dev-token': { sub: 'dev-user', claims: {}, token: 'dev-token' } },
    }));
}
```

---

### 13. Let the plugin own health and shutdown

**❌ Wrong — a provider used only through a bespoke handler**

```typescript fragment
const introspection = new IntrospectionAuthProvider({ introspectionUrl, clientId, clientSecret });

// ❌ Nothing ever calls health() or shutdown(): the response cache and HTTP
// state are never released, and WebAFX's health endpoint reports nothing.
this.route().get('/reports').handle(async (req, res) => {
    const user = await introspection.authenticate(req);
    this.ok(res, { sub: user?.sub });
});
```

Why it's problematic: caches, key material, and in-flight maps are meant to have a lifecycle. The plugin exists to register the provider **and** return `{ health, shutdown }` so WebAFX's health check and graceful shutdown reach it automatically. Skip the plugin and both hooks are dead code.

**✅ Correct**

```typescript fragment
// ✅ Installed once; the plugin wires health()/shutdown() into WebAFX.
app.use(createAuthPlugin(introspection));
```

If a provider must live outside a plugin (a script, a queue worker), call `await provider.shutdown()` from your own shutdown path. Shutdown is safe and reversible: caches rebuild lazily on the next call, and repeated `shutdown()` calls are no-ops.

---

## Anti-Patterns

### Copy-pasting the two-provider wiring

The loud failure: both plugins left on the default `serviceName` make `app.use()` throw `Plugin "auth:auth" is already registered` at startup. The quiet failure: names changed on one side only. `serviceName` + `userServiceName` + `secure(name)` are a three-way contract — change `userServiceName` to `'client'` without naming it on a route and that route keeps resolving `'user'` (the documented default for unnamed secure routes), so valid client tokens look unauthenticated. Treat the trio as one wiring and cover it with an integration test, exactly like the multi-provider suite.

### Async or fallible work inside `mapClaims`

In the JWT provider and the OIDC bearer path, synchronous claim mapping runs inside the authentication `try/catch` — a throw from your mapper is treated as *a failed authentication* (silent `undefined`), not an error. Put a database lookup in `mapClaims` and an outage logs your entire user base out. Enrichment that can fail or is async belongs in OIDC's `resolveUser`, whose rejection deliberately propagates as an infrastructure error:

```typescript fragment
const provider = new OidcAuthProvider({
    issuerUrl,
    clientId,
    clientSecret,
    // ✅ Async enrichment: a rejection surfaces as an infrastructure error.
    resolveUser: async (req, claims) => {
        const profile = await users.findBySubject(String(claims.sub));
        return {
            sub: String(claims.sub),
            claims: { ...claims, roles: profile?.roles ?? [] },
            // The hook receives the request; forward the raw token when needed.
            token: (req.headers.authorization ?? '').replace(/^Bearer /, ''),
        };
    },
});
```

### Zero or `NaN` TTLs

TTLs have sharp semantics that "unset-looking" values violate. `sessionAbsoluteTtl: 0` makes every session past its deadline on the next read (signed-out users, immediately). `sessionCookieTtl: 0` produces a non-persistent cookie. `cacheTTL <= 0` disables the introspection cache. And `Number('') === 0`, `Number('8h') === NaN` — env parsing produces exactly these values by accident:

```typescript fragment
// ❌ Number('') is 0; Number('8h') is NaN. "Unset" becomes "expire
// immediately" or "never expire".
const sessionAbsoluteTtl = Number(process.env.SESSION_ABSOLUTE_TTL_SECONDS);

app.use(oidcAuthPlugin({
    issuerUrl,
    clientId,
    clientSecret,
    redirectUri,
    sessionAbsoluteTtl,
}));
```

Validate explicitly and omit the option when unset:

```typescript fragment
// ✅ Parse, validate, and only pass the option when intentionally configured.
function parsePositiveInt(name: string): number | undefined {
    const raw = process.env[name];
    if (raw === undefined || raw === '') {
        return undefined;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}

const absoluteTtl = parsePositiveInt('SESSION_ABSOLUTE_TTL_SECONDS');
app.use(oidcAuthPlugin({
    issuerUrl,
    clientId,
    clientSecret,
    redirectUri,
    ...(absoluteTtl === undefined ? {} : { sessionAbsoluteTtl: absoluteTtl }),
}));
```

### Turning infrastructure failures into signed-out users

A wrapper that catches every `authenticate()` error and either answers 401 or clears the session cookie converts a cache-store or IdP outage into "everyone was logged out". After recovery, the whole user base re-authenticates — and your metrics recorded 401s, not the incident. Let thrown errors reach the framework error handler (500) and never delete a session because a lookup failed.

### Assuming process-local state is shared

These are per-process by design and by documentation: the OIDC discovery cache, the remote JWKS cache, the introspection LRU, the provider's `inFlightRefreshes` map, and the controller's `RefreshSingleFlight`. In a multi-instance deployment: N instances each perform their own discovery and grants; concurrent refreshes of one session can produce up to N grants, and a rotating IdP may reject the second use of a refresh token. The documented remedy is an external lock (or design for single-writer per session). Sessions themselves must live in a shared `CacheProvider` — an in-memory store means users bounce between instances and re-authenticate.

### Treating the principal as an authorization decision

`principalType` is descriptive — it "does not by itself grant or deny access" — and `authorized: false` merely marks an OIDC session whose UserInfo was denied; that session still authenticates so `/me` can present it. Both must be **enforced explicitly** where policy requires:

```typescript fragment
// ✅ Enforce the denial policy; don't assume authenticated means allowed.
const user = await req.services.get<AuthResult>('user', undefined);
if (!user || user.authorized === false) {
    res.status(403).json({
        success: false,
        error: { code: 'not_authorized', message: 'Access to this account is not permitted' },
    });
    return;
}
```

Prefer separate providers and `secure('client')`-style routes for principal kinds over ad-hoc checks of the descriptive field.

### Expecting `configFactory` to vary static-only settings

Several security-relevant OIDC options are read from the **static** config only; a value returned by a per-request `configFactory` is ignored: `verifyIdTokenSignature`, `verifyUserInfoSubject`, `userInfoDenied`, `notAuthorizedPath`, `rotateSessionIdOnRefresh`, `sessionTtl`/`sessionAbsoluteTtl`/`sessionCookieTtl`, `csrf`, `transport`, and `principalType`. A multi-tenant deployment that "enables CSRF for tenant B" via the factory silently won't. If two tenants genuinely need different policies, register two provider instances under distinct service names.

---

## Performance Tips

**Reuse one provider instance per backend.** Everything stateful is per instance: the encoded JWT key, OIDC discovery (per issuer, `discoveryTtl` default 3600s), the remote JWKS cache, the introspection LRU (`maxCacheSize` default 1000), and the in-flight refresh coalescing map. A second instance for the same backend doubles discovery/introspection traffic and splits coalescing — under concurrency, a rotating IdP may then see the same refresh token used twice.

**Pick the cheapest verification that meets the requirement.** `JwtAuthProvider` is pure local CPU — no network, ever. `OidcAuthProvider` verifies locally too, after discovery and JWKS fetches that are cached. `IntrospectionAuthProvider` is the only per-request network path, and its LRU exists precisely to amortize it. (The OIDC test server's loopback tokens are for tests; verify locally in production.)

**Tune the introspection cache to the token lifetime.** The effective TTL is `min(cacheTTL, exp - now)`, so a cached entry can never outlive the token it represents, and the audience and expiry are re-checked on every cache hit. Raising `cacheTTL` toward the token lifetime removes most introspection calls for long-lived tokens with no correctness risk. Raise `maxCacheSize` when many distinct tokens are live (tenants × users); the LRU evicts by recency, not insertion order.

**Cache what the package deliberately doesn't.** The introspection provider "does not cache the resolved credentials; the application owns that cache" — a `configFactory` that hits a database on every request is your cost to remove (memoize per tenant in the repository layer). Likewise, a tenant-delegating implementation built on the exported contracts is expected to build each tenant provider **once** and cache it (bounded, with eviction that shuts the evicted provider down).

**Authenticate once per request.** The guard resolves the principal; handlers read it from the container. A second `authenticate(req)` per handler is a redundant verification and, for OIDC sessions, a second store read.

**Treat health checks as endpoint work, not hot-path work.** `OidcAuthProvider.health()` performs discovery — and returns `false` for `configFactory`-only setups **by design** (there is no static config to check), so don't alarm on that or call it per request. JWT, introspection, and memory health checks are local and cheap; introspection health never touches the network.

**Know the coalescing boundaries.** Concurrent OIDC refreshes for the same tenant + token share one grant per process; the controller's `POST /refresh` coalesces per session id so a burst produces one store (and one rotation). Introspection has no in-flight dedupe — N concurrent requests for a cold token make N calls; warm the cache or accept the burst. A high `discoveryTtl` is safe for key rotation: the remote JWKS resolver re-fetches keys when it meets a `kid` it does not know.

---

## Security Considerations

**Never log or expose raw tokens.** The package holds up its side: introspection cache keys are SHA-256 digests (the raw token is never stored, logged, or used as a key), failure messages contain only HTTP status codes, and secrets are excluded from cache keys. Keep the same discipline in application logging — log `sub` or a hashed identifier, never the bearer value — and don't put tokens in URLs unless a source is strictly scoped to routes that cannot use headers.

**Pin the validation surface.** Configure `issuer` and `audience`, set `requireAudience: true` everywhere an issuer serves more than one API, pin `algorithms`, and keep `clockTolerance` deliberately small (JWT default 0; OIDC default 30 seconds). The fail-closed gates run before discovery and verification, so a misconfiguration rejects tokens rather than admitting them.

**Keep the OIDC non-repudiation chain intact.** The chain is: ID-token signature (default on) → trusted `sub` → UserInfo `sub` equality (default on, OpenID Connect Core §5.3.2) → no session on mismatch. Disabling any link degrades what identity means; the provider emits a one-time warning when the subject check is skipped because signature verification is off. Only a provider that genuinely cannot expose a verifiable ID token justifies `verifyIdTokenSignature: false`.

**Harden the browser session.** Sessions are opaque UUID cookies — `httpOnly`, `sameSite=lax`, `secure` when `isProduction()` is true. Make sure `ENV_MODE` is actually `production` in production, or cookies ship without `secure`. Enable `csrf` for logout/refresh, set a `sessionAbsoluteTtl` so activity cannot extend a session forever, and consider `rotateSessionIdOnRefresh` (accepting its documented caveats: single in-flight refresh assumed, and a lost refresh response forces re-login).

**Guard redirects and reflected input.** The controller sanitizes `returnTo` to relative, same-origin paths and never reflects upstream `error`/`error_description` text. If you replace `handleLogin`/`handleCallback` or add your own post-login redirects, preserve both properties — an unsanitized `returnTo` is an open-redirect attack after a successful sign-in.

**Keep upstream error detail server-side.** The typed flow errors (`OidcCodeExchangeError`, `OidcUserInfoForbiddenError`, `OidcUserInfoSubjectMismatchError`) carry fixed, safe messages; their `cause` is for programmatic inspection only and must not be forwarded to clients or logged verbatim. The controller's fixed responses (`oidc_error`, `missing_code`, `invalid_state`, `oidc_exchange_failed`, `userinfo_forbidden`, `userinfo_subject_mismatch`) are the model to follow.

**Use the transport shim's protections; don't bypass them.** The default is HTTPS with the system trust store. `allowInsecureRequests` is development-only: it additionally disables TLS certificate validation and allows non-HTTPS issuers. `transport.ca` **replaces** the default roots — it does not add to them — so a service that also talks to public issuers must include the public roots in the bundle. The built-in fetch never downgrades HTTPS to HTTP on redirect and strips `Authorization`, `Cookie`, and proxy credentials on cross-origin redirects; a hand-rolled fetch would not.

**Authorization is yours.** `AuthResult` describes the principal (`sub`, `claims`, `scopes`, `principalType`, `authorized`); the package authenticates, it does not authorize. Enforce `authorized === false` where a denied account must be blocked, prefer routes that select the correct provider (`secure('client')`) over checks of the descriptive `principalType`, and remember that OIDC session-cookie principals are always reported as `'user'` regardless of configuration.

**Preserve tenant isolation.** Introspection cache entries are scoped by endpoint + client (one tenant's result can never be served to another), OIDC discovery is cached per issuer, and `resolveSessionCookieName`/`resolveStateCookieName` scope cookies per organization. Never share client credentials or cookie names across tenants, and back sessions with a shared `CacheProvider` so a session created on one instance is found by every instance.

---

# webafx-auth Testing Patterns

This document explains how to test code that uses `blendsdk/webafx-auth` and how the package's own suite is organized. The suite runs entirely in-process: unit tests double only the network boundary, while integration tests start loopback HTTP/HTTPS servers. No Docker, database, or external identity provider is required. All patterns shown here are drawn from the package's actual test files (`tests/*.spec.test.ts`, `tests/*.impl.test.ts`, `tests/*.test.ts`) — they are the source of truth.

---

## Test Setup

### Running the suite

| Command | What it does |
| --- | --- |
| `npm test` / `npm run test:fast` | `vitest run --reporter=verbose` — full suite, run once |
| `npm run test:watch` | Watch mode with the verbose reporter |
| `npm run test:coverage` | `vitest run --coverage` — V8 coverage via `@vitest/coverage-v8` |
| `npx vitest run tests/jwt-auth-provider.test.ts` | Run a single test file |
| `npx vitest run -t "ST-1"` | Run tests whose name matches a pattern |

Notes:

- **No Docker, no external services.** Integration tests bind loopback servers to ephemeral ports (`127.0.0.1:0` / `localhost:0`) and close them in `afterEach`/`afterAll`. TLS tests use a committed self-signed fixture (`tests/fixtures/localhost-key.pem`, `localhost-cert.pem`).
- **Default Vitest configuration.** No setup files and no `globals: true` — every test file imports `describe`, `it`, `expect`, and `vi` from `vitest` explicitly, and declares its own mocks. The Node environment is the default.
- **Package tests import source directly** (`../src/jwt-auth-provider.js`). Consumer tests should import from the package entry point instead: `import { JwtAuthProvider } from 'blendsdk/webafx-auth'`.

An optional consumer-side config is enough to pin the environment:

```typescript
// vitest.config.ts — optional; the package itself relies on the defaults
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
    },
});
```

### Test file conventions

| Pattern | Purpose | Examples |
| --- | --- | --- |
| `*.spec.test.ts` | Specification tests: behavior contracts traced to spec IDs (`ST-1`…), written before the implementation | `auth-plugin.spec.test.ts`, `multi-provider-routing.spec.test.ts` |
| `*.impl.test.ts` | Implementation tests: internals, boundaries, and defensive behavior (`IM-…`) | `introspection-auth-provider.impl.test.ts`, `oidc-auth-controller.impl.test.ts` |
| `*.test.ts` | Feature-named unit suites | `jwt-auth-provider.test.ts`, `token-extraction.test.ts`, `claims-mapping.test.ts` |

Integration suites also use the `.spec.test.ts` suffix (`oidc-callback-exchange.spec.test.ts`, `oidc-transport.spec.test.ts`, and friends).

### Required imports

The typical import surface used across the suite:

```typescript fragment
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { WebApplication, BaseController } from 'blendsdk/webafx';
import { OidcAuthProvider, MemoryAuthProvider, JwtAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult, OidcSession, ClaimsMapper } from 'blendsdk/webafx-auth';
import { SignJWT, generateKeyPair } from 'jose';
import type { Request, Response } from 'express';
import type { CacheProvider } from 'blendsdk/webafx-cache';
```

Dev-time dependencies to mirror the suite: `vitest`, `supertest`, `@types/supertest`, `jose` (real JWT signing), plus `blendsdk/webafx` and `blendsdk/webafx-cache` when your tests exercise the plugin layer or OIDC sessions.

### Shared test helpers

The package centralizes its helpers in `tests/test-helpers.ts`. Copy the helpers you need into your own project — they eliminate nearly all boilerplate. Core helpers:

| Helper | Purpose |
| --- | --- |
| `TEST_SECRET` / `TEST_ISSUER` / `TEST_AUDIENCE` | Shared JWT constants |
| `createMockRequest(options?)` | Minimal `Request` double with `headers`, `cookies`, `query` |
| `createBearerRequest(token)` | Request with `Authorization: Bearer <token>` |
| `createCookieRequest(token, cookieName?)` | Request with an entry in `req.cookies` |
| `createQueryRequest(token, paramName?)` | Request with an entry in `req.query` |
| `signTestJwt(options?)` | A real, cryptographically valid HS256 JWT via `jose.SignJWT` |
| `signExpiredJwt(options?)` | A JWT whose `exp` is one hour in the past |
| `createTestAuthResult(overrides?)` | `AuthResult` fixture |
| `ADMIN_AUTH_RESULT` / `USER_AUTH_RESULT` | Pre-built principals |
| `createMockCacheProvider()` | In-memory `CacheProvider` with spies on `get`/`set`/`delete` plus the backing `Map` |
| `createSampleSession(overrides?)` | `OidcSession` fixture |
| `createMockTokenResponse(overrides?, claims?)` | `openid-client` token-response double with its `claims()` helper |
| `createMockOidcConfig(overrides?)` | `OidcAuthConfig` fixture |
| `createMockRes()` | Express `Response` double that captures status, JSON, cookies, cleared cookies, and redirects |

#### Request factories and constants

```typescript
// tests/test-helpers.ts
import { SignJWT } from 'jose';
import { vi } from 'vitest';
import type { Request, Response } from 'express';
import type { AuthResult } from 'blendsdk/webafx-auth';
import type { OidcAuthConfig, OidcSession } from 'blendsdk/webafx-auth';
import type { CacheProvider } from 'blendsdk/webafx-cache';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** HMAC secret used across all JWT test suites (32 bytes for HS256). */
export const TEST_SECRET = 'test-secret-that-is-at-least-256-bits-long!!';

/** Issuer claim value used in JWT tests. */
export const TEST_ISSUER = 'https://auth.test.example.com';

/** Audience claim value used in JWT tests. */
export const TEST_AUDIENCE = 'test-client-id';

// ---------------------------------------------------------------------------
// Mock request factory
// ---------------------------------------------------------------------------

export interface MockRequestOptions {
    /** Authorization header value (e.g. 'Bearer <token>'). */
    authorization?: string;
    /** Additional headers beyond Authorization. */
    headers?: Record<string, string>;
    /** Cookie values — simulates cookie-parser middleware (`req.cookies`). */
    cookies?: Record<string, string>;
    /** Query parameters. */
    query?: Record<string, string>;
}

export function createMockRequest(options: MockRequestOptions = {}): Request {
    const headers: Record<string, string | undefined> = { ...options.headers };
    if (options.authorization) {
        headers.authorization = options.authorization;
    }
    return {
        headers,
        cookies: options.cookies ?? {},
        query: options.query ?? {},
    } as unknown as Request;
}

export function createBearerRequest(token: string): Request {
    return createMockRequest({ authorization: `Bearer ${token}` });
}

export function createCookieRequest(token: string, cookieName = 'auth_token'): Request {
    return createMockRequest({ cookies: { [cookieName]: token } });
}

export function createQueryRequest(token: string, paramName = 'token'): Request {
    return createMockRequest({ query: { [paramName]: token } });
}
```

> **Cookie gotcha.** `createCookieRequest()` writes to `req.cookies`, which is what the base extraction chain reads (populated by cookie-parser in production). The OIDC controller and the provider's session-cookie fallback parse the **raw** `Cookie` header instead. For those, build the request with `createMockRequest({ headers: { cookie: '__oidc_session=sess-1' } })`.

#### JWT signing helpers

```typescript
// tests/test-helpers.ts (continued)

export interface SignJwtOptions {
    /** Subject claim (user ID). Default: 'test-user-1'. */
    sub?: string;
    /** Issuer claim. Default: TEST_ISSUER. */
    issuer?: string;
    /** Audience claim. Default: TEST_AUDIENCE. */
    audience?: string;
    /** Expiration time relative to now. Default: '1h'. */
    expiresIn?: string;
    /** Explicit expiration timestamp (overrides expiresIn). */
    exp?: number;
    /** Additional payload claims to include. */
    claims?: Record<string, unknown>;
    /** Signing secret. Default: TEST_SECRET. */
    secret?: string;
    /** Signing algorithm. Default: 'HS256'. */
    algorithm?: string;
}

/** Create a real, cryptographically valid JWT — no JWT mocking needed. */
export async function signTestJwt(options: SignJwtOptions = {}): Promise<string> {
    const secret = new TextEncoder().encode(options.secret ?? TEST_SECRET);

    const builder = new SignJWT({
        sub: options.sub ?? 'test-user-1',
        ...options.claims,
    })
        .setProtectedHeader({ alg: options.algorithm ?? 'HS256' })
        .setIssuedAt()
        .setIssuer(options.issuer ?? TEST_ISSUER)
        .setAudience(options.audience ?? TEST_AUDIENCE);

    if (options.exp !== undefined) {
        builder.setExpirationTime(options.exp);
    } else {
        builder.setExpirationTime(options.expiresIn ?? '1h');
    }

    return builder.sign(secret);
}

/** Create an already-expired JWT (exp = one hour ago). */
export async function signExpiredJwt(options: SignJwtOptions = {}): Promise<string> {
    return signTestJwt({ ...options, exp: Math.floor(Date.now() / 1000) - 3600 });
}
```

#### AuthResult fixtures

```typescript
// tests/test-helpers.ts (continued)

export function createTestAuthResult(overrides: Partial<AuthResult> = {}): AuthResult {
    return {
        sub: 'test-user-1',
        claims: { role: 'user' },
        token: 'test-token-1',
        ...overrides,
    };
}

export const ADMIN_AUTH_RESULT: AuthResult = {
    sub: 'admin-1',
    claims: { role: 'admin', permissions: ['read', 'write', 'delete'] },
    token: 'admin-token',
    scopes: ['admin'],
};

export const USER_AUTH_RESULT: AuthResult = {
    sub: 'user-1',
    claims: { role: 'user', permissions: ['read'] },
    token: 'user-token',
    scopes: ['read'],
};
```

#### CacheProvider and session fixtures

```typescript
// tests/test-helpers.ts (continued)
import { vi } from 'vitest';
import type { CacheProvider } from 'blendsdk/webafx-cache';
import type { OidcSession } from 'blendsdk/webafx-auth';

/**
 * In-memory CacheProvider with vitest spies on all methods.
 * The backing Map is returned for direct inspection in tests.
 */
export function createMockCacheProvider(): {
    provider: CacheProvider;
    store: Map<string, { value: unknown; expiresAt: number }>;
} {
    const store = new Map<string, { value: unknown; expiresAt: number }>();

    const provider = {
        get: vi.fn(async <T>(key: string): Promise<T | undefined> => {
            const entry = store.get(key);
            if (!entry) return undefined;
            if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
                store.delete(key);
                return undefined;
            }
            return entry.value as T;
        }),
        set: vi.fn(async (key: string, value: unknown, ttl?: number): Promise<void> => {
            const expiresAt = ttl ? Date.now() + ttl * 1000 : 0;
            store.set(key, { value, expiresAt });
        }),
        delete: vi.fn(async (key: string): Promise<boolean> => store.delete(key)),
        exists: vi.fn(async (key: string): Promise<boolean> => store.has(key)),
        expire: vi.fn(async () => true),
        ttl: vi.fn(async () => -1),
        deletePattern: vi.fn(async () => 0),
        clear: vi.fn(async () => {
            store.clear();
        }),
        health: vi.fn(async () => true),
        shutdown: vi.fn(async () => undefined),
        getOrSet: vi.fn(),
        serviceName: 'cache',
    } as unknown as CacheProvider;

    return { provider, store };
}

export function createSampleSession(overrides: Partial<OidcSession> = {}): OidcSession {
    return {
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        idToken: 'mock-id-token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        user: { sub: 'user-123', name: 'Alice', email: 'alice@example.com' },
        ...overrides,
    };
}
```

#### OIDC config and token-response fixtures

```typescript
// tests/test-helpers.ts (continued)

/** Double for an openid-client token response, including the claims() helper. */
export function createMockTokenResponse(
    overrides?: Partial<{
        access_token: string;
        token_type: string;
        expires_in: number;
        refresh_token: string;
        id_token: string;
        scope: string;
    }>,
    claims?: Record<string, unknown> | null
) {
    return {
        access_token: 'mock-access-token',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'mock-refresh-token',
        id_token: 'mock-id-token',
        scope: 'openid profile email',
        ...overrides,
        claims: () => (claims === null ? undefined : { sub: 'test-user-1', ...claims }),
    };
}

export function createMockOidcConfig(overrides?: Partial<OidcAuthConfig>): OidcAuthConfig {
    return {
        serviceName: 'oidc-test',
        issuerUrl: 'https://auth.example.com',
        clientId: 'test-client',
        ...overrides,
    };
}
```

#### Mock Express response

Controller tests capture status, JSON, cookies, cleared cookies, and redirects with a small response double (the package defines it per controller test file; this is the canonical form):

```typescript
// tests/test-helpers.ts (continued)

export interface MockRes extends Response {
    _status: number;
    _json?: unknown;
    _cookies: Record<string, { value: string; options: Record<string, unknown> }>;
    _clearedCookies: string[];
    _redirect?: string;
}

export function createMockRes(): MockRes {
    const res = {
        _status: 200,
        _json: undefined as unknown,
        _cookies: {} as Record<string, { value: string; options: Record<string, unknown> }>,
        _clearedCookies: [] as string[],
        _redirect: undefined as string | undefined,
        json(data: unknown): unknown {
            res._json = data;
            return res;
        },
        status(code: number): unknown {
            res._status = code;
            return res;
        },
        cookie(name: string, value: string, options: Record<string, unknown>): unknown {
            res._cookies[name] = { value, options };
            return res;
        },
        clearCookie(name: string): unknown {
            res._clearedCookies.push(name);
            return res;
        },
        redirect(url: string): void {
            res._redirect = url;
        },
    };
    return res as unknown as MockRes;
}
```

### General gotchas

- Call `await provider.shutdown()` in `afterEach` for providers that cache state (JWT key material, OIDC discovery, introspection LRU) so tests don't leak cached state into one another.
- Create a **fresh provider per test** where cache isolation matters — the discovery cache, introspection LRU, and single-flight maps are process-local to the instance.
- Send `issuer` / `audience` only when the test wants them checked — matches with providers whose config omits them are deliberate.
- The package's `tests/` directory (including `oidc-test-server.ts` and `test-helpers.ts`) is not published — copy what you need into your own repo.

---

## Unit Testing

### Approach

Unit tests in this ecosystem construct the provider directly and drive it with request doubles — no WebAFX server, no DI container, no network. Two principles from the package suite:

1. **Use real implementations when they exist.** JWT tests sign real tokens with `jose`; the memory provider is itself a test double. Reserve mocks for the network boundary (`fetch`, `openid-client`, `jose` when discovery must be faked) — see [Mocking & Stubbing](#mocking--stubbing).
2. **Test the contract, not the plumbing.** Assert on `AuthResult | undefined` and lifecycle outcomes; the silent-failure contract means invalid tokens are `undefined`, never thrown.

Synchronous patterns apply to `extractToken()`, cookie-name accessors, and plugin shape; asynchronous patterns use `async/await` with `.resolves` / `.rejects` matchers:

```typescript fragment
// sync
expect(provider.extractToken(req)).toBe('my-token-123');
expect(provider.getSessionCookieName(req)).toBe('__oidc_session');

// async
await expect(provider.validate(token)).resolves.toBeUndefined();
await expect(provider.authenticate(req)).rejects.toThrow('Redis connection lost');
```

### Testing a service that consumes a provider

Inject a provider into your service as `AuthProvider` and drive it with `MemoryAuthProvider` — that is what it exists for.

```typescript
// tests/principal-reporter.test.ts
import { describe, it, expect } from 'vitest';
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthProvider } from 'blendsdk/webafx-auth';
import type { Request } from 'express';
import { createBearerRequest, createMockRequest } from './test-helpers';

/** Consumer service under test: depends only on the AuthProvider contract. */
class PrincipalReporter {
    constructor(private readonly provider: AuthProvider) {}

    async report(req: Request): Promise<string> {
        const result = await this.provider.authenticate(req);
        return result ? `${result.sub} (${result.principalType ?? 'unknown'})` : 'anonymous';
    }
}

describe('PrincipalReporter', () => {
    it('reports the authenticated principal and falls back to anonymous', async () => {
        const provider = new MemoryAuthProvider({
            principalType: 'user',
            validTokens: {
                'token-1': { sub: 'user-1', claims: {}, token: 'token-1' },
            },
        });
        const reporter = new PrincipalReporter(provider);

        await expect(reporter.report(createBearerRequest('token-1'))).resolves.toBe(
            'user-1 (user)'
        );
        await expect(reporter.report(createMockRequest())).resolves.toBe('anonymous');
    });
});
```

### Testing a custom AuthProvider subclass

The abstract base class fixes the extract → validate lifecycle; a subclass only implements `validate()`, `health()`, and `shutdown()`. Test it exactly like the built-in providers.

```typescript
// tests/api-key-provider.ts
import { AuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

export class ApiKeyProvider extends AuthProvider {
    private readonly keys: Map<string, AuthResult>;

    constructor(keys: Record<string, AuthResult>) {
        super({ tokenSources: ['header'] });
        this.keys = new Map(Object.entries(keys));
    }

    async validate(token: string): Promise<AuthResult | undefined> {
        return this.keys.get(token);
    }

    async health(): Promise<boolean> {
        return this.keys.size > 0;
    }

    async shutdown(): Promise<void> {
        this.keys.clear();
    }
}
```

```typescript
// tests/api-key-provider.test.ts
import { describe, it, expect } from 'vitest';
import { ApiKeyProvider } from './api-key-provider';
import { createBearerRequest, createMockRequest } from './test-helpers';
import type { AuthResult } from 'blendsdk/webafx-auth';

const RESULT: AuthResult = { sub: 'service-1', claims: {}, token: 'key-1' };

describe('ApiKeyProvider', () => {
    it('authenticates a request whose Bearer value matches a configured key', async () => {
        const provider = new ApiKeyProvider({ 'key-1': RESULT });

        await expect(provider.authenticate(createBearerRequest('key-1'))).resolves.toEqual(
            RESULT
        );
    });

    it('returns undefined for an unknown key and for a missing token', async () => {
        const provider = new ApiKeyProvider({ 'key-1': RESULT });

        await expect(provider.authenticate(createBearerRequest('nope'))).resolves.toBeUndefined();
        await expect(provider.authenticate(createMockRequest())).resolves.toBeUndefined();
    });

    it('reports health and releases keys on shutdown', async () => {
        const provider = new ApiKeyProvider({ 'key-1': RESULT });
        expect(await provider.health()).toBe(true);

        await provider.shutdown();

        expect(await provider.health()).toBe(false);
        await expect(provider.validate('key-1')).resolves.toBeUndefined();
    });
});
```

### Testing plugin registration without a server

`createAuthPlugin()` returns a `PluginDefinition` whose `factory({ app, express, logger })` registers two services and returns the health/shutdown delegates. You can execute that factory against a mock app instead of starting WebAFX:

```typescript
// tests/auth-plugin.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createAuthPlugin, MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';
import { createBearerRequest, createMockRequest } from './test-helpers';

const TOKEN = 'valid-test-token';
const RESULT: AuthResult = { sub: 'user-1', claims: { role: 'user' }, token: TOKEN };

// ---------------------------------------------------------------------------
// Doubles for the WebAFX plugin factory parameters
// ---------------------------------------------------------------------------

interface RegisteredService {
    name: string;
    type: string;
    factory: (...args: unknown[]) => unknown;
}

/** Structural view of a PluginDefinition, enough to run its factory in tests. */
interface PluginDefinitionLike {
    name: string;
    priority?: number;
    factory: (params: {
        app: unknown;
        express: unknown;
        logger: unknown;
    }) => Promise<unknown>;
}

function createMockApp(): {
    app: { registerService: ReturnType<typeof vi.fn> };
    registeredServices: RegisteredService[];
} {
    const registeredServices: RegisteredService[] = [];
    const registerService = vi.fn((definition: RegisteredService) => {
        registeredServices.push(definition);
    });
    return { app: { registerService }, registeredServices };
}

function createMockLogger(): {
    info: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
} {
    return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function executePluginFactory(plugin: PluginDefinitionLike): Promise<{
    registeredServices: RegisteredService[];
    logger: ReturnType<typeof createMockLogger>;
    result: unknown;
}> {
    const { app, registeredServices } = createMockApp();
    const logger = createMockLogger();
    const result = await plugin.factory({ app, express: {}, logger });
    return { registeredServices, logger, result };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAuthPlugin', () => {
    it('returns the default plugin name and priority', () => {
        const plugin = createAuthPlugin(new MemoryAuthProvider());

        expect(plugin.name).toBe('auth:auth');
        expect(plugin.priority).toBe(10);
    });

    it('registers the provider singleton and the per-request principal factory', async () => {
        const provider = new MemoryAuthProvider({ validTokens: { [TOKEN]: RESULT } });
        const plugin = createAuthPlugin(provider) as unknown as PluginDefinitionLike;

        const { registeredServices } = await executePluginFactory(plugin);
        expect(registeredServices).toHaveLength(2);

        const providerService = registeredServices.find((service) => service.name === 'auth');
        expect(providerService?.type).toBe('singleton');
        expect(providerService?.factory()).toBe(provider);

        const principalService = registeredServices.find((service) => service.name === 'user');
        expect(principalService?.type).toBe('per-request');

        const viaBearer = await principalService?.factory(
            {},
            {},
            createBearerRequest(TOKEN),
            {},
            () => undefined
        );
        expect(viaBearer).toEqual(RESULT);

        const anonymous = await principalService?.factory(
            {},
            {},
            createMockRequest(),
            {},
            () => undefined
        );
        expect(anonymous).toBeUndefined();
    });

    it('delegates health and shutdown to the provider', async () => {
        const provider = new MemoryAuthProvider();
        const healthSpy = vi.spyOn(provider, 'health');
        const shutdownSpy = vi.spyOn(provider, 'shutdown');

        const plugin = createAuthPlugin(provider) as unknown as PluginDefinitionLike;
        const { result } = await executePluginFactory(plugin);
        const lifecycle = result as {
            health: () => Promise<boolean>;
            shutdown: () => Promise<void>;
        };

        await expect(lifecycle.health()).resolves.toBe(true);
        await lifecycle.shutdown();

        expect(healthSpy).toHaveBeenCalledTimes(1);
        expect(shutdownSpy).toHaveBeenCalledTimes(1);
    });

    it('honors custom service names and priority', async () => {
        const plugin = createAuthPlugin(new MemoryAuthProvider(), {
            serviceName: 'machine-auth',
            userServiceName: 'client',
            priority: 5,
        });

        expect(plugin.name).toBe('auth:machine-auth');
        expect(plugin.priority).toBe(5);

        const { registeredServices } = await executePluginFactory(
            plugin as unknown as PluginDefinitionLike
        );
        expect(registeredServices.map((service) => service.name)).toEqual([
            'machine-auth',
            'client',
        ]);
    });
});
```

---

## Integration Testing

### Integration levels

| Level | Real pieces | Doubles | Example files |
| --- | --- | --- | --- |
| Provider unit | Provider, real `jose` crypto | Request doubles, stubbed `fetch` | `jwt-auth-provider.test.ts`, `introspection-auth-provider.spec.test.ts` |
| App integration | WebAFX app, plugin, guard, DI container, HTTP | `MemoryAuthProvider` | `multi-provider-routing.spec.test.ts` |
| OIDC integration | `OidcAuthProvider`, `openid-client`, in-process IdP, HTTP/TLS | Session store (in-memory `Map`) | `oidc-callback-exchange.spec.test.ts`, `oidc-transport.spec.test.ts` |

### End-to-end routing with supertest

The strongest integration test boots a real `WebApplication` with two auth plugins and proves that routes are routed to the principal they name. This is exactly how the package verifies multi-provider support:

```typescript
// tests/multi-provider.integration.test.ts
import { describe, test, expect, afterEach } from 'vitest';
import supertest from 'supertest';
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { createAuthPlugin, MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

/** Token recognised only by the user provider. */
const USER_TOKEN = 'user-token';

/** Token recognised only by the client provider. */
const CLIENT_TOKEN = 'client-token';

const USER_RESULT: AuthResult = { sub: 'user-1', claims: { kind: 'user' }, token: USER_TOKEN };
const CLIENT_RESULT: AuthResult = {
    sub: 'client-1',
    claims: { kind: 'client' },
    token: CLIENT_TOKEN,
};

/** A human route (default principal) and a machine route (client principal). */
class MultiProviderController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated()
                .get('/mp/user')
                .handle(async (req, res) => {
                    const user = await req.services.get<AuthResult>('user', undefined);
                    this.ok(res, { sub: user?.sub });
                }),

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

function createTestApp(): WebApplication {
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });

    app.use(
        createAuthPlugin(
            new MemoryAuthProvider({ validTokens: { [USER_TOKEN]: USER_RESULT } }),
            { serviceName: 'user-auth', userServiceName: 'user' }
        )
    );

    app.use(
        createAuthPlugin(
            new MemoryAuthProvider({ validTokens: { [CLIENT_TOKEN]: CLIENT_RESULT } }),
            { serviceName: 'client-auth', userServiceName: 'client' }
        )
    );

    app.registerController('', MultiProviderController);
    return app;
}

describe('Multiple auth providers', () => {
    let shutdown: (() => Promise<void>) | null = null;

    afterEach(async () => {
        if (shutdown) {
            await shutdown();
            shutdown = null;
        }
    });

    test('a route naming the client service accepts the client token', async () => {
        const app = createTestApp();
        shutdown = await app.start();

        const res = await supertest(app.express)
            .get('/mp/client')
            .set('Authorization', `Bearer ${CLIENT_TOKEN}`)
            .expect(200);

        expect(res.body.data).toEqual({ sub: 'client-1' });
    });

    test('the default route rejects the client token', async () => {
        const app = createTestApp();
        shutdown = await app.start();

        await supertest(app.express)
            .get('/mp/user')
            .set('Authorization', `Bearer ${CLIENT_TOKEN}`)
            .expect(401);
    });

    test('the default route accepts the user token', async () => {
        const app = createTestApp();
        shutdown = await app.start();

        const res = await supertest(app.express)
            .get('/mp/user')
            .set('Authorization', `Bearer ${USER_TOKEN}`)
            .expect(200);

        expect(res.body.data).toEqual({ sub: 'user-1' });
    });
});
```

Key points: `PORT: 0` binds an ephemeral port, `app.start()` returns the shutdown function, and `supertest(app.express)` drives the real middleware chain — the secure guard, DI container, and per-request factory all execute for real.

### Plugin name collisions fail fast

Two plugins that share a `serviceName` produce the same plugin name, and `app.use()` throws at startup instead of silently replacing the first plugin. Verify this without starting a server:

```typescript
// tests/plugin-collision.integration.test.ts
import { describe, it, expect } from 'vitest';
import { WebApplication } from 'blendsdk/webafx';
import { createAuthPlugin, MemoryAuthProvider } from 'blendsdk/webafx-auth';

describe('plugin name collision', () => {
    it('rejects a second auth plugin that uses the default service name', () => {
        const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });

        app.use(createAuthPlugin(new MemoryAuthProvider()));

        expect(() => app.use(createAuthPlugin(new MemoryAuthProvider()))).toThrow(
            'Plugin "auth:auth" is already registered'
        );
    });
});
```

### OIDC against an in-process identity provider

The package ships a minimal in-process OIDC provider (`tests/oidc-test-server.ts`) that serves discovery, JWKS, the token endpoint, UserInfo, and revocation. It runs over plain HTTP or HTTPS with a committed self-signed fixture, so the full `OidcAuthProvider` — including real `openid-client` and `jose` verification — can be exercised end to end with no Docker.

#### Test server capabilities

| Member | Purpose |
| --- | --- |
| `issuer`, `jwksUri` | Discovery base URL and JWKS endpoint |
| `accessToken`, `refreshToken` | Values returned by the token endpoint |
| `idTokenClaims` | Mutable object merged into every issued ID token (set `nonce`, `exp`, `aud`, …) |
| `setIdTokenSigningKey(key)` | Sign with a rogue key (signature-failure tests) |
| `setIdTokenKeyId(kid)` | Emit a `kid` absent from the JWKS (rotation/forgery tests) |
| `signIdToken(overrides?)` | Craft a token with tampered claims |
| `setIdToken(token \| null \| undefined)` | Force, restore, or omit the ID token |
| `setUserInfoSubject(subject)` | Return a UserInfo subject that differs from the ID token |
| `setTokenError({ error, error_description })` | Force a token-endpoint OAuth error body |
| `setUserInfoStatus(status, { challenge })` | Simulate 403/401/5xx responses, optionally with a bearer challenge |
| `readTestCa()` | PEM of the self-signed certificate for `transport.ca` |
| `close()` | Stop the server and release its port |

#### Callback success and failure

This example drives the real provider against the test server and the real `OidcAuthController` against that provider:

```typescript
// tests/oidc-flow.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { OidcAuthController, OidcAuthProvider } from 'blendsdk/webafx-auth';
import type { OidcSessionState } from 'blendsdk/webafx-auth';
import { startOidcTestServer } from './oidc-test-server';
import type { OidcTestServer } from './oidc-test-server';
import { createMockCacheProvider, createMockRes } from './test-helpers';

let server: OidcTestServer;

beforeAll(async () => {
    server = await startOidcTestServer();
});

afterAll(async () => {
    await server.close();
});

/** Controller fixed to a single provider instance, as WebAFX registers it. */
class TestController extends OidcAuthController {
    constructor(private readonly provider: OidcAuthProvider) {
        super({ isProduction: () => false } as never, {} as never);
    }

    protected async getProvider(_req: Request): Promise<OidcAuthProvider> {
        return this.provider;
    }
}

function makeProvider(): {
    provider: OidcAuthProvider;
    store: Map<string, { value: unknown; expiresAt: number }>;
} {
    const cache = createMockCacheProvider();
    const provider = new OidcAuthProvider({
        issuerUrl: server.issuer,
        clientId: 'test-client',
        clientSecret: 'test-secret',
        redirectUri: 'https://app.example.com/callback',
        transport: { allowInsecureRequests: true },
        sessionStore: cache.provider,
    });
    return { provider, store: cache.store };
}

/** Build the authorization request, bind the nonce, and store the PKCE state. */
async function prepareCallback(provider: OidcAuthProvider): Promise<Request> {
    const auth = await provider.buildAuthorizationUrl();
    server.idTokenClaims.nonce = auth.nonce;
    const state: OidcSessionState = {
        codeVerifier: auth.codeVerifier,
        state: auth.state,
        nonce: auth.nonce,
    };
    await provider.storeState('state-1', state);
    return {
        query: { code: 'test-code', state: auth.state },
        headers: { cookie: '__oidc_state=state-1' },
    } as unknown as Request;
}

describe('OIDC BFF flow against the in-process provider', () => {
    it('completes a valid callback and stores a session', async () => {
        const { provider, store } = makeProvider();
        const controller = new TestController(provider);
        const request = await prepareCallback(provider);

        const res = createMockRes();
        await controller.handleCallback(request, res);

        expect(res._redirect).toBe('/');
        expect(res._cookies['__oidc_session']).toBeDefined();
        expect(res._clearedCookies).toContain('__oidc_state');
        expect(
            [...store.keys()].filter((key) => key.startsWith('oidc:session:'))
        ).toHaveLength(1);
        expect(await provider.getState('state-1')).toBeUndefined();
    });

    it('returns a fixed 400 when the ID-token nonce does not match', async () => {
        const { provider, store } = makeProvider();
        const controller = new TestController(provider);
        const request = await prepareCallback(provider);
        server.idTokenClaims.nonce = 'wrong-nonce';

        const res = createMockRes();
        await controller.handleCallback(request, res);

        expect(res._status).toBe(400);
        expect(res._json).toEqual({
            success: false,
            error: {
                code: 'oidc_exchange_failed',
                message: 'Sign-in could not be completed',
            },
        });
        expect(res._cookies['__oidc_session']).toBeUndefined();
        expect(
            [...store.keys()].filter((key) => key.startsWith('oidc:session:'))
        ).toHaveLength(0);
    });
});
```

The same skeleton covers the other OIDC failure modes by mutating the server before the callback: `setIdTokenSigningKey()` for a rogue key, `setIdTokenKeyId('unknown-key-id')` for a missing `kid`, `server.idTokenClaims.exp` for an expired ID token, `setTokenError(...)` for an invalid/expired code, and `setUserInfoSubject(...)` for a subject mismatch.

#### Transport security

```typescript
// tests/oidc-transport.integration.test.ts
import { describe, expect, it } from 'vitest';
import { OidcAuthProvider } from 'blendsdk/webafx-auth';
import { readTestCa, startOidcTestServer } from './oidc-test-server';

describe('transport security', () => {
    it('rejects a plain-http issuer unless allowInsecureRequests is set', async () => {
        const server = await startOidcTestServer();
        try {
            const strict = new OidcAuthProvider({
                issuerUrl: server.issuer,
                clientId: 'test-client',
                clientSecret: 'test-secret',
                redirectUri: 'https://app.example.com/callback',
            });

            await expect(strict.buildAuthorizationUrl()).rejects.toThrow();

            const relaxed = new OidcAuthProvider({
                issuerUrl: server.issuer,
                clientId: 'test-client',
                clientSecret: 'test-secret',
                redirectUri: 'https://app.example.com/callback',
                transport: { allowInsecureRequests: true },
            });

            await expect(relaxed.buildAuthorizationUrl()).resolves.toBeDefined();
        } finally {
            await server.close();
        }
    });

    it('trusts a self-signed https issuer when its CA is supplied', async () => {
        const server = await startOidcTestServer({ tls: true });
        try {
            const provider = new OidcAuthProvider({
                issuerUrl: server.issuer,
                clientId: 'test-client',
                clientSecret: 'test-secret',
                redirectUri: 'https://app.example.com/callback',
                transport: { ca: readTestCa() },
            });

            const auth = await provider.buildAuthorizationUrl();

            expect(auth.url).toContain(server.issuer);
        } finally {
            await server.close();
        }
    });
});
```

### No Docker required

Every integration test binds an ephemeral loopback port and closes it in teardown. The TLS fixture is committed to the repository, so even HTTPS transport tests run offline and in parallel. If you replicate the pattern in your own repo, keep the two fixture files (`localhost-key.pem`, `localhost-cert.pem`) under version control and load them relative to the test file.

---

## Mocking & Stubbing

Prefer the package's own doubles before reaching for module mocks:

| Need | Recommended approach |
| --- | --- |
| Deterministic auth in consumer tests | `MemoryAuthProvider` — the package-provided test double |
| Session storage for OIDC | `createMockCacheProvider()` (in-memory `Map` + spies) |
| Introspection HTTP | Stub the global `fetch` |
| OIDC discovery/JWKS in unit tests | `vi.mock('openid-client')` + `vi.mock('jose')` |
| Controller under test | Subclass overriding `getProvider()`, or a `req.services.get` double |
| Code typed against `AuthProviderLike` | A plain object with `validate` / `health` / `shutdown` |

### Stubbing the global fetch (introspection)

`IntrospectionAuthProvider` uses the runtime `fetch`. Stub it with `vi.stubGlobal()` and restore with `vi.unstubAllGlobals()`:

```typescript
// tests/introspection-stubbed.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';
import { createBearerRequest } from './test-helpers';

/** Minimal fetch Response stand-in with only the members the provider reads. */
function jsonResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('IntrospectionAuthProvider with a stubbed fetch', () => {
    it('validates an active token and sends the RFC 7662 request', async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ active: true, sub: 'user-1', exp: 4102444800 })
        );
        const provider = new IntrospectionAuthProvider({
            introspectionUrl: 'https://auth.example.com/oauth2/introspect',
            clientId: 'client-1',
            clientSecret: 'secret-1',
        });

        const result = await provider.authenticate(createBearerRequest('opaque-token'));

        expect(result?.sub).toBe('user-1');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
```

Inspect the outgoing request by reading `fetchMock.mock.calls[0]` and parsing `init.body` with `URLSearchParams` — that is how the package asserts method, headers, and body shape.

### Module mocks for OIDC (`openid-client` and `jose`)

For unit tests of the OIDC bearer path and discovery caching, mock both modules at file scope. `vi.mock` calls are hoisted above imports; keep the real exports with `importActual` so error classes and constants remain available, and configure per-test behavior with `vi.mocked()` in `beforeEach`:

```typescript
// tests/oidc-discovery.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as client from 'openid-client';
import * as jose from 'jose';
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

vi.mock('openid-client', async () => {
    const actual = await vi.importActual<typeof client>('openid-client');
    return {
        ...actual,
        discovery: vi.fn(),
        enableNonRepudiationChecks: vi.fn(),
    };
});

vi.mock('jose', async () => {
    const actual = await vi.importActual<typeof jose>('jose');
    return {
        ...actual,
        jwtVerify: vi.fn(),
        createRemoteJWKSet: vi.fn(() => vi.fn()),
    };
});

/** Discovery metadata returned by the mocked discovery call. */
const serverMetadata = {
    issuer: 'https://auth.example.com',
    jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
};

/** openid-client Configuration double exposing serverMetadata(). */
const configuration = {
    serverMetadata: () => serverMetadata,
} as unknown as client.Configuration;

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.discovery).mockResolvedValue(configuration);
    vi.mocked(jose.jwtVerify).mockResolvedValue({
        payload: {
            sub: 'user-1',
            iss: 'https://auth.example.com',
            aud: 'https://api.example.com',
            exp: Math.floor(Date.now() / 1000) + 3600,
        },
        protectedHeader: { alg: 'RS256' },
    } as never);
    vi.mocked(jose.createRemoteJWKSet).mockReturnValue(vi.fn() as never);
});

describe('OIDC discovery caching', () => {
    it('discovers once per issuer and serves the second validation from cache', async () => {
        const provider = new OidcAuthProvider({
            issuerUrl: 'https://auth.example.com',
            clientId: 'test-client',
            clientSecret: 'test-secret',
            audience: 'https://api.example.com',
        });

        await provider.validate('token-1');
        await provider.validate('token-2');

        expect(client.discovery).toHaveBeenCalledTimes(1);
    });
});
```

Notes:

- Keep OIDC tests that mock `jose` in their own file — a Jest-style module mock is per-file, and other suites rely on the real `jose` implementation.
- `as never` casts appear only on mock resolutions whose shapes are structural subsets of the library types.
- Assert cache expiry with `vi.useFakeTimers()` + `vi.advanceTimersByTime(...)` and restore real timers in `afterEach`.

### Mocking the CacheProvider (OIDC sessions)

Session operations talk to a `CacheProvider`. Use `createMockCacheProvider()` to assert both behavior and storage details:

```typescript
// tests/oidc-session-store.test.ts
import { describe, it, expect } from 'vitest';
import { OidcAuthProvider } from 'blendsdk/webafx-auth';
import { createMockCacheProvider, createSampleSession } from './test-helpers';

describe('OidcAuthProvider session storage', () => {
    it('stores sessions under oidc:session:<id> with the configured TTL', async () => {
        const { provider: cache } = createMockCacheProvider();
        const provider = new OidcAuthProvider({
            issuerUrl: 'https://auth.example.com',
            clientId: 'test-client',
            sessionStore: cache,
            sessionTtl: 7200,
        });

        await provider.storeSession('uuid-1', createSampleSession());

        expect(cache.set).toHaveBeenCalledWith(
            'oidc:session:uuid-1',
            expect.objectContaining({ accessToken: 'mock-access-token' }),
            7200
        );
    });
});
```

### Provider doubles in consumer tests

**Use `MemoryAuthProvider` first.** It is a real `AuthProvider` with a token map and runtime helpers, so any consumer code that takes an `AuthProvider` can be tested without mocks:

```typescript fragment
const provider = new MemoryAuthProvider();
provider.addToken('scenario-token', { sub: 'scenario-user', claims: {}, token: 'scenario-token' });
// ... run the scenario ...
expect(provider.removeToken('scenario-token')).toBe(true);
```

**Fake only the `AuthProviderLike` contract** when your code only needs `validate` / `health` / `shutdown` (for example tenant-delegation contracts):

```typescript
import type { AuthProviderLike, AuthResult } from 'blendsdk/webafx-auth';

const fake: AuthProviderLike = {
    async validate(token: string): Promise<AuthResult | undefined> {
        return token === 'ok' ? { sub: 'user-1', claims: {}, token } : undefined;
    },
    async health(): Promise<boolean> {
        return true;
    },
    async shutdown(): Promise<void> {
        return undefined;
    },
};
```

**Stub network methods on a real provider with `vi.spyOn`.** This is how the rotation tests avoid touching the network while keeping the real session store:

```typescript fragment
const provider = new OidcAuthProvider({
    issuerUrl: 'https://auth.example.com',
    clientId: 'test-client',
    sessionStore: cache.provider,
});
vi.spyOn(provider, 'refreshToken').mockResolvedValue({
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
    expiresIn: 3600,
    tokenType: 'Bearer',
});
vi.spyOn(provider, 'revokeToken').mockResolvedValue(undefined);
```

**For the controller, replace the provider wholesale.** `OidcAuthController` resolves its provider from DI (`req.services.get('auth')`). Either subclass and override `getProvider()` (shown in the feature patterns below), or supply a `services.get` double on the request:

```typescript fragment
const req = {
    query: {},
    headers: { cookie: '__oidc_session=sess-123' },
    services: {
        get: (name: string) => {
            if (name === 'auth') return provider;
            throw new Error(`Service '${name}' not registered`);
        },
    },
} as unknown as Request;
```

---

## Test Patterns by Feature

### Token extraction chain

Source tests: `tests/token-extraction.test.ts`.

The chain is tried in order — first match wins. `extractToken()` is synchronous and returns `undefined` (not an error) when no source matches.

| Behavior | Expectation |
| --- | --- |
| `'header'` (default) | `Authorization: Bearer <token>`; the `Bearer ` prefix is case-sensitive |
| `'cookie'` | Reads `req.cookies[cookieName]` (needs cookie-parser in production) |
| `'query'` | Reads `req.query[queryParamName]`; non-string values are ignored |
| Custom source | `{ extractor: (req) => string \| undefined }` |
| Empty values | `'Bearer '` with no token, empty cookie, and unknown sources fall through |
| Unknown source | Throws at construction: `Unknown token source` |

```typescript
// tests/token-extraction.test.ts
import { describe, it, expect } from 'vitest';
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { TokenSource } from 'blendsdk/webafx-auth';
import { createMockRequest } from './test-helpers';

describe('token extraction chain', () => {
    it('returns the first match, header-first', () => {
        const provider = new MemoryAuthProvider({
            tokenSources: ['header', 'cookie', 'query'],
        });

        const req = createMockRequest({
            authorization: 'Bearer header-token',
            cookies: { auth_token: 'cookie-token' },
            query: { token: 'query-token' },
        });

        expect(provider.extractToken(req)).toBe('header-token');
    });

    it('falls back to cookie, then query, when earlier sources are empty', () => {
        const provider = new MemoryAuthProvider({
            tokenSources: ['header', 'cookie', 'query'],
        });

        expect(
            provider.extractToken(createMockRequest({ cookies: { auth_token: 'cookie-token' } }))
        ).toBe('cookie-token');

        expect(
            provider.extractToken(createMockRequest({ query: { token: 'query-token' } }))
        ).toBe('query-token');

        expect(provider.extractToken(createMockRequest())).toBeUndefined();
    });

    it('supports a custom extractor function as a source', () => {
        const apiKeySource: TokenSource = {
            extractor: (req) => req.headers['x-api-key'] as string | undefined,
        };
        const provider = new MemoryAuthProvider({ tokenSources: [apiKeySource] });

        const req = createMockRequest({ headers: { 'x-api-key': 'api-key-abc' } });

        expect(provider.extractToken(req)).toBe('api-key-abc');
    });

    it('rejects an unknown token source at construction time', () => {
        expect(
            () =>
                new MemoryAuthProvider({
                    tokenSources: ['magic'] as unknown as TokenSource[],
                })
        ).toThrow('Unknown token source');
    });
});
```

### Claims mapping

Source tests: `tests/claims-mapping.test.ts`, `tests/principal-discriminator*.spec.test.ts`.

| Raw claim | Default mapper result |
| --- | --- |
| `sub` or `subject` | `AuthResult.sub` (falls back to `'unknown'`) |
| `exp` (numeric seconds) | `AuthResult.exp` |
| `scope` string | `AuthResult.scopes` split on spaces, empties filtered |
| `scope` array or `scopes` array | `AuthResult.scopes` mapped to strings |
| Everything | Preserved as-is in `AuthResult.claims` |
| — | Configured `principalType` is stamped unless the mapper set one |

A custom `mapClaims` replaces the default entirely — assert exactly what you rely on:

```typescript
// tests/claims-mapping.test.ts
import { describe, it, expect } from 'vitest';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';
import type { ClaimsMapper } from 'blendsdk/webafx-auth';
import { TEST_SECRET, TEST_ISSUER, TEST_AUDIENCE, signTestJwt } from './test-helpers';

function createProvider(mapClaims?: ClaimsMapper): JwtAuthProvider {
    return new JwtAuthProvider({
        secret: TEST_SECRET,
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        ...(mapClaims === undefined ? {} : { mapClaims }),
    });
}

describe('claims mapping', () => {
    it('parses the scope-string and scopes-array forms', async () => {
        const provider = createProvider();

        const fromString = await provider.validate(
            await signTestJwt({ claims: { scope: 'openid profile email' } })
        );
        const fromScopesArray = await provider.validate(
            await signTestJwt({ claims: { scopes: ['admin', 'user'] } })
        );

        expect(fromString?.scopes).toEqual(['openid', 'profile', 'email']);
        expect(fromScopesArray?.scopes).toEqual(['admin', 'user']);
        await provider.shutdown();
    });

    it('leaves scopes undefined when no scope claim is present', async () => {
        const provider = createProvider();

        const result = await provider.validate(await signTestJwt());

        expect(result?.sub).toBe('test-user-1');
        expect(result?.scopes).toBeUndefined();
        await provider.shutdown();
    });

    it('replaces the default mapping entirely when mapClaims is provided', async () => {
        const mapper: ClaimsMapper = (token, rawClaims) => ({
            sub: String(rawClaims.user_id ?? rawClaims.sub ?? 'unknown'),
            claims: rawClaims,
            token,
            scopes: Array.isArray(rawClaims.permissions)
                ? rawClaims.permissions.map(String)
                : undefined,
        });
        const provider = createProvider(mapper);

        const result = await provider.validate(
            await signTestJwt({
                claims: { user_id: 'custom-42', permissions: ['read', 'write'] },
            })
        );

        expect(result?.sub).toBe('custom-42');
        expect(result?.scopes).toEqual(['read', 'write']);
        // The custom mapper does not extract exp — prove the default did not run.
        expect(result?.exp).toBeUndefined();
        await provider.shutdown();
    });
});
```

### JWT validation

Source tests: `tests/jwt-auth-provider.test.ts`.

| Scenario | Setup | Expectation |
| --- | --- | --- |
| Valid token | `signTestJwt()` | `AuthResult` with `sub`, `exp`, `claims`, `token` |
| Expired | `signExpiredJwt()` | `undefined` |
| Wrong secret | `signTestJwt({ secret: '...' })` | `undefined` |
| Wrong issuer | `signTestJwt({ issuer: '...' })` | `undefined` when `issuer` is configured |
| Wrong audience | `signTestJwt({ audience: '...' })` | `undefined` when `audience` is configured |
| Clock skew | expired 30s ago + `clockTolerance: 120` | accepted |
| `requireAudience` without `audience` | — | fail closed: every token is `undefined` |
| Garbage input | `'not-a-jwt'`, `''`, `'aaa.bbb.ccc'` | `undefined` |

```typescript
// tests/jwt-validation.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';
import {
    signTestJwt,
    signExpiredJwt,
    TEST_SECRET,
    TEST_ISSUER,
    TEST_AUDIENCE,
} from './test-helpers';

describe('JwtAuthProvider', () => {
    let provider: JwtAuthProvider;

    beforeEach(() => {
        provider = new JwtAuthProvider({
            secret: TEST_SECRET,
            algorithms: ['HS256'],
            issuer: TEST_ISSUER,
            audience: TEST_AUDIENCE,
        });
    });

    afterEach(async () => {
        await provider.shutdown();
    });

    it('validates a correctly signed token and maps its claims', async () => {
        const token = await signTestJwt({ claims: { scope: 'read write' } });

        const result = await provider.validate(token);

        expect(result?.sub).toBe('test-user-1');
        expect(result?.token).toBe(token);
        expect(result?.scopes).toEqual(['read', 'write']);
        expect(result?.exp).toBeTypeOf('number');
    });

    it('rejects expired, wrong-secret, wrong-issuer, and wrong-audience tokens', async () => {
        await expect(provider.validate(await signExpiredJwt())).resolves.toBeUndefined();
        await expect(
            provider.validate(
                await signTestJwt({ secret: 'wrong-secret-that-is-also-at-least-256-bits!!' })
            )
        ).resolves.toBeUndefined();
        await expect(
            provider.validate(await signTestJwt({ issuer: 'https://wrong-issuer.example.com' }))
        ).resolves.toBeUndefined();
        await expect(
            provider.validate(await signTestJwt({ audience: 'wrong-client-id' }))
        ).resolves.toBeUndefined();
    });

    it('accepts a recently expired token within the configured clock tolerance', async () => {
        const tolerant = new JwtAuthProvider({
            secret: TEST_SECRET,
            issuer: TEST_ISSUER,
            audience: TEST_AUDIENCE,
            clockTolerance: 120,
        });

        const token = await signTestJwt({ exp: Math.floor(Date.now() / 1000) - 30 });

        await expect(tolerant.validate(token)).resolves.toBeDefined();
        await tolerant.shutdown();
    });

    it('fails closed when requireAudience is set without an audience', async () => {
        const strict = new JwtAuthProvider({
            secret: TEST_SECRET,
            issuer: TEST_ISSUER,
            requireAudience: true,
        });

        await expect(strict.validate(await signTestJwt())).resolves.toBeUndefined();
        await strict.shutdown();
    });
});
```

### Introspection and response caching

Source tests: `tests/introspection-auth-provider.spec.test.ts`, `tests/introspection-auth-provider.impl.test.ts`.

| Scenario | Expectation |
| --- | --- |
| Active token | `sub`, `exp`, `scopes` mapped from the introspection response |
| RFC 7662 shape | `POST` form, `token` + `token_type_hint=access_token`; Basic auth by default, or credentials in the body with `authMethod: 'post'` |
| Inactive token | `undefined` |
| Non-2xx | Throws; message contains the status, never the token or secret |
| Timeout | `AbortController` fires; the fetch rejects |
| Cache hit | Two validations of one token → one HTTP call |
| Cache TTL clamp | An `exp` sooner than `cacheTTL` bounds the entry; an expired token is never cached |
| LRU eviction | `maxCacheSize` bounds entries; a touched entry survives eviction |
| Factory-only mode | `validate()` returns `undefined`; use `authenticate(req)` for per-request credentials |

```typescript
// tests/introspection-caching.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';
import { createBearerRequest } from './test-helpers';

function jsonResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    } as unknown as Response;
}

/** Seconds since epoch, offset from now. */
function epochIn(offsetSeconds: number): number {
    return Math.floor(Date.now() / 1000) + offsetSeconds;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function createProvider(maxCacheSize?: number): IntrospectionAuthProvider {
    return new IntrospectionAuthProvider({
        introspectionUrl: 'https://auth.example.com/oauth2/introspect',
        clientId: 'client-1',
        clientSecret: 'secret-1',
        ...(maxCacheSize === undefined ? {} : { maxCacheSize }),
    });
}

describe('IntrospectionAuthProvider caching', () => {
    it('maps an active token and sends the RFC 7662 request shape', async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ active: true, sub: 'user-1', exp: epochIn(3600), scope: 'read write' })
        );
        const provider = createProvider();

        const result = await provider.authenticate(createBearerRequest('opaque-token'));

        expect(result?.sub).toBe('user-1');
        expect(result?.scopes).toEqual(['read', 'write']);

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://auth.example.com/oauth2/introspect');
        expect(init.method).toBe('POST');

        const headers = init.headers as Record<string, string>;
        expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
        expect(headers.Authorization).toMatch(/^Basic /);

        const body = new URLSearchParams(init.body as string);
        expect(body.get('token')).toBe('opaque-token');
        expect(body.get('token_type_hint')).toBe('access_token');
    });

    it('calls the endpoint once for two validations of the same token', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ active: true, sub: 'user-1' }));

        const provider = createProvider();
        await provider.validate('opaque-token');
        await provider.validate('opaque-token');

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('evicts the least recently used entry, not the oldest inserted', async () => {
        fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
            const token = new URLSearchParams(init.body as string).get('token');
            return jsonResponse({ active: true, sub: token, exp: epochIn(3600) });
        });

        const provider = createProvider(2);

        await provider.validate('token-a');
        await provider.validate('token-b');
        await provider.validate('token-a'); // touch A: B is now the least recently used
        await provider.validate('token-c'); // evicts B
        await provider.validate('token-b'); // re-fetch

        // Fetches: A, B, C, B — a FIFO cache would have evicted A and made this 5.
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('never logs the token or the client secret', async () => {
        const consoleSpies = [
            vi.spyOn(console, 'log').mockImplementation(() => undefined),
            vi.spyOn(console, 'warn').mockImplementation(() => undefined),
            vi.spyOn(console, 'error').mockImplementation(() => undefined),
        ];
        fetchMock.mockResolvedValue(
            jsonResponse({ active: true, sub: 'user-1', exp: epochIn(3600) })
        );

        await createProvider().validate('secret-token-value');

        const output = JSON.stringify(consoleSpies.flatMap((spy) => spy.mock.calls));
        expect(output).not.toContain('secret-token-value');
        expect(output).not.toContain('secret-1');
    });

    it('aborts when the endpoint does not respond in time', async () => {
        fetchMock.mockImplementation(
            (_url: string, init: RequestInit) =>
                new Promise((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () =>
                        reject(new Error('aborted'))
                    );
                })
        );
        const provider = new IntrospectionAuthProvider({
            introspectionUrl: 'https://auth.example.com/oauth2/introspect',
            clientId: 'client-1',
            clientSecret: 'secret-1',
            timeout: 20,
        });

        await expect(provider.validate('opaque-token')).rejects.toThrow();
    });
});
```

### Provider factory (`createAuthProvider`)

Source tests: `tests/auth-factory.spec.test.ts`, `tests/auth-factory.impl.test.ts`.

| `type` | Required configuration | Validation error (thrown at startup) |
| --- | --- | --- |
| `'jwt'` | `secret` | `createAuthProvider: type 'jwt' requires 'secret'` |
| `'introspection'` | Static triple or `configFactory` | `...requires 'introspectionUrl', 'clientId' and 'clientSecret', or 'configFactory'` |
| `'oidc'` | `issuerUrl` | `createAuthProvider: type 'oidc' requires 'issuerUrl'` |
| `'memory'` | — | — |

```typescript
// tests/auth-factory.test.ts
import { describe, it, expect } from 'vitest';
import { createAuthProvider, MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const RESULT: AuthResult = { sub: 'memory-user', claims: {}, token: 'factory-token' };

describe('createAuthProvider', () => {
    it('dispatches on type and forwards provider-specific configuration', async () => {
        const provider = createAuthProvider({
            type: 'memory',
            validTokens: { 'factory-token': RESULT },
        });

        expect(provider).toBeInstanceOf(MemoryAuthProvider);
        await expect(provider.validate('factory-token')).resolves.toEqual(RESULT);
    });

    it('fails at startup with a field-specific message instead of at the first request', () => {
        expect(() => createAuthProvider({ type: 'jwt' })).toThrow(
            "createAuthProvider: type 'jwt' requires 'secret'"
        );
        expect(() => createAuthProvider({ type: 'oidc' })).toThrow(
            "createAuthProvider: type 'oidc' requires 'issuerUrl'"
        );
    });
});
```

### OIDC provider: sessions, discovery, and multi-tenancy

Source tests: `tests/oidc-auth-provider.spec.test.ts`, `tests/oidc-provider-session.spec.test.ts`, `tests/oidc-absolute-session.spec.test.ts`.

Dual-mode authentication: a Bearer token wins; otherwise, when a `sessionStore` is configured, the provider resolves the opaque session cookie and enforces both the idle expiry (`sessionTtl`/`expiresAt`) and the optional absolute deadline (`sessionAbsoluteTtl`). Session-store errors propagate (they must not be masked as "unauthenticated").

```typescript
// tests/oidc-sessions.test.ts
import { describe, it, expect, vi } from 'vitest';
import { OidcAuthProvider } from 'blendsdk/webafx-auth';
import type { OidcAuthConfig } from 'blendsdk/webafx-auth';
import { createMockCacheProvider, createMockRequest, createSampleSession } from './test-helpers';
import type { CacheProvider } from 'blendsdk/webafx-cache';

function createProvider(
    store: CacheProvider,
    overrides: Partial<OidcAuthConfig> = {}
): OidcAuthProvider {
    return new OidcAuthProvider({
        issuerUrl: 'https://auth.example.com',
        clientId: 'test-client',
        sessionStore: store,
        ...overrides,
    });
}

describe('OidcAuthProvider server-side sessions', () => {
    it('authenticates from the session cookie when no bearer token is present', async () => {
        const { provider: cache, store } = createMockCacheProvider();
        store.set('oidc:session:sess-1', { value: createSampleSession(), expiresAt: 0 });
        const provider = createProvider(cache);

        const result = await provider.authenticate(
            createMockRequest({ headers: { cookie: '__oidc_session=sess-1' } })
        );

        expect(result?.sub).toBe('user-123');
        // A session cookie is always an interactive user session.
        expect(result?.principalType).toBe('user');
    });

    it('rejects a session past its access-token expiry even when the store entry remains', async () => {
        const { provider: cache, store } = createMockCacheProvider();
        store.set('oidc:session:expired', {
            value: createSampleSession({
                expiresAt: Math.floor(Date.now() / 1000) - 3600,
            }),
            expiresAt: 0,
        });
        const provider = createProvider(cache);

        const result = await provider.authenticate(
            createMockRequest({ headers: { cookie: '__oidc_session=expired' } })
        );

        expect(result).toBeUndefined();
    });

    it('propagates store failures instead of masking them', async () => {
        const { provider: cache } = createMockCacheProvider();
        vi.mocked(cache.get).mockRejectedValueOnce(new Error('Redis connection lost'));
        const provider = createProvider(cache);

        await expect(
            provider.authenticate(
                createMockRequest({ headers: { cookie: '__oidc_session=sess-1' } })
            )
        ).rejects.toThrow('Redis connection lost');
    });

    it('stores sessions under oidc:session:<id> with the configured TTL', async () => {
        const { provider: cache } = createMockCacheProvider();
        const provider = createProvider(cache, { sessionTtl: 7200 });

        await provider.storeSession('uuid-1', createSampleSession());

        expect(cache.set).toHaveBeenCalledWith(
            'oidc:session:uuid-1',
            expect.objectContaining({ accessToken: 'mock-access-token' }),
            7200
        );
    });

    it('resolves org-scoped cookie names per request', () => {
        const provider = new OidcAuthProvider({
            issuerUrl: 'https://auth.example.com',
            clientId: 'test-client',
            resolveSessionCookieName: (req) =>
                `__oidc_session_${String(req.headers['x-tenant'] ?? 'default')}`,
            resolveStateCookieName: (req) =>
                `__oidc_state_${String(req.headers['x-tenant'] ?? 'default')}`,
        });

        const req = createMockRequest({ headers: { 'x-tenant': 'acme' } });

        expect(provider.getSessionCookieName(req)).toBe('__oidc_session_acme');
        expect(provider.getStateCookieName(req)).toBe('__oidc_state_acme');
    });
});
```

For discovery caching of the Bearer path, mock `openid-client`/`jose` (see [Module mocks for OIDC](#module-mocks-for-oidc-openid-client-and-jose)) and assert `client.discovery` is called once per issuer, again after `discoveryTtl` elapses with fake timers, and again after `shutdown()`.

### Plugin integration

Source tests: `tests/auth-plugin.spec.test.ts`, `tests/auth-plugin.impl.test.ts`, `tests/convenience-factories.spec.test.ts`. The unit-level factory execution pattern lives in [Testing plugin registration without a server](#testing-plugin-registration-without-a-server); this table summarizes the knobs to test:

| Option | Default | Behaviors to test |
| --- | --- | --- |
| `serviceName` | `'auth'` | Plugin name is `auth:<serviceName>`; the singleton factory returns the exact provider instance |
| `userServiceName` | `'user'` | The per-request factory registers under this name and delegates to `provider.authenticate(req)` |
| `priority` | `10` | Exposed on the returned `PluginDefinition` |

Also verify that the plugin factory returns `{ health, shutdown }` delegating to the provider (`ST-6`), and that `jwtAuthPlugin()`, `introspectionAuthPlugin()`, `oidcAuthPlugin()`, and `memoryAuthPlugin()` forward options into `createAuthPlugin()` (assert `plugin.name` and `plugin.priority`).

### OIDC controller (BFF routes)

Source tests: `tests/oidc-auth-controller.test.ts`, `tests/oidc-auth-controller.spec.test.ts`, `tests/oidc-auth-controller.impl.test.ts`.

Routes (default prefix `/api/oidc`, override via `getRoutePrefix()`):

| Method | Path | Guard | Notes |
| --- | --- | --- | --- |
| GET | `{prefix}/login` | public | Builds authorization URL + PKCE, stores state, sets `__oidc_state` (maxAge 300s), redirects; forwards `?prompt=`, `?login_hint=`, sanitized `?returnTo=` |
| GET | `{prefix}/callback` | public | Validates state, exchanges code, verifies ID token and UserInfo subject, stores the session, sets `__oidc_session`, redirects to the sanitized `returnTo` (default `/`) |
| POST | `{prefix}/logout` | public, self-validating | Best-effort revocation, clears session + cookie; idempotent — 200 even without a session |
| GET | `{prefix}/me` | `secure` | Returns `{ user, expiresAt, authorized, csrfToken? }` — never tokens |
| POST | `{prefix}/refresh` | public, self-validating | Single-flight refresh, re-issues the cookie; 401 without session, 400 without refresh token |

Error catalog (all bodies are `{ success: false, error: { code, message } }`; upstream text is never reflected):

| Condition | Status | `error.code` |
| --- | --- | --- |
| Missing `code` query param | 400 | `missing_code` |
| State cookie missing/expired | 400 | `missing_state` |
| State mismatch | 400 | `invalid_state` |
| Provider `error` query param | 400 | `oidc_error` |
| Failed exchange / ID-token verification | 400 | `oidc_exchange_failed` |
| UserInfo subject mismatch | 400 | `userinfo_subject_mismatch` |
| UserInfo 403 (default policy) | 403 | `userinfo_forbidden` |
| `/me` without a session | 401 | `no_session` |
| Refresh without a session | 401 | `no_session` |
| Refresh without a refresh token | 400 | `no_refresh_token` |
| CSRF enforcement failed | 403 | `csrf_invalid` |

Drive login → callback → me against a stub provider and a response double — the stubs keep session/state in real `Map`s so multi-step flows work naturally:

```typescript
// tests/oidc-controller.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { Request } from 'express';
import { OidcAuthController } from 'blendsdk/webafx-auth';
import type { OidcAuthProvider, OidcSession, OidcSessionState } from 'blendsdk/webafx-auth';
import { createMockRequest, createMockRes } from './test-helpers';

/** Controller fixed to a stub provider. */
class TestController extends OidcAuthController {
    constructor(private readonly provider: OidcAuthProvider) {
        super({ isProduction: () => false } as never, {} as never);
    }

    protected async getProvider(_req: Request): Promise<OidcAuthProvider> {
        return this.provider;
    }
}

/** Stub provider with Map-backed session/state storage and spied BFF methods. */
function createStubProvider(): {
    provider: OidcAuthProvider;
    sessions: Map<string, OidcSession>;
    states: Map<string, OidcSessionState>;
} {
    const sessions = new Map<string, OidcSession>();
    const states = new Map<string, OidcSessionState>();

    const provider = {
        buildAuthorizationUrl: vi.fn(async () => ({
            url: 'https://auth.example.com/authorize?client_id=test',
            codeVerifier: 'mock-verifier',
            state: 'mock-state',
            nonce: 'mock-nonce',
        })),
        getStateCookieName: () => '__oidc_state',
        getSessionCookieName: () => '__oidc_session',
        getSessionCookieTtl: () => 3600,
        getCsrfConfig: () => undefined,
        resolveRequestConfig: vi.fn(async () => undefined),
        storeState: vi.fn(async (id: string, state: OidcSessionState) => {
            states.set(id, state);
        }),
        getState: vi.fn(async (id: string) => states.get(id)),
        clearState: vi.fn(async (id: string) => {
            states.delete(id);
        }),
        storeSession: vi.fn(async (id: string, session: OidcSession) => {
            sessions.set(id, session);
        }),
        getSession: vi.fn(async (id: string) => sessions.get(id)),
        clearSession: vi.fn(async (id: string) => {
            sessions.delete(id);
        }),
        exchangeCode: vi.fn(async () => ({
            accessToken: 'mock-access-token',
            refreshToken: 'mock-refresh-token',
            idToken: 'mock-id-token',
            expiresIn: 3600,
            tokenType: 'Bearer',
        })),
        fetchUserInfo: vi.fn(async () => ({
            sub: 'user-123',
            email: 'user@example.com',
        })),
        refreshToken: vi.fn(async () => ({
            accessToken: 'new-access-token',
            refreshToken: 'new-refresh-token',
            expiresIn: 3600,
            tokenType: 'Bearer',
        })),
        revokeToken: vi.fn(async () => undefined),
        shouldRotateSessionIdOnRefresh: () => false,
        shouldVerifyUserInfoSubject: () => true,
        getUserInfoDeniedMode: () => 'error',
        getNotAuthorizedPath: () => '/',
        getRedirectUri: () => 'https://app.example.com/api/oidc/callback',
        // AuthProvider surface (not exercised by the controller tests)
        authenticate: vi.fn(async () => undefined),
        validate: vi.fn(async () => undefined),
        health: vi.fn(async () => true),
        shutdown: vi.fn(async () => undefined),
    } as unknown as OidcAuthProvider;

    return { provider, sessions, states };
}

describe('OidcAuthController BFF routes', () => {
    it('runs login → callback → me over the stub provider', async () => {
        const { provider, sessions } = createStubProvider();
        const controller = new TestController(provider);

        // 1) login: store PKCE state, set the state cookie, redirect.
        const loginRes = createMockRes();
        await controller.handleLogin(createMockRequest(), loginRes);

        const stateId = loginRes._cookies['__oidc_state'].value;
        expect(stateId).toBeDefined();
        expect(loginRes._cookies['__oidc_state'].options).toMatchObject({
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            maxAge: 300_000,
        });
        expect(loginRes._redirect).toBe('https://auth.example.com/authorize?client_id=test');

        // 2) callback: exchange the code, store the session, clear transient state.
        const callbackRes = createMockRes();
        await controller.handleCallback(
            createMockRequest({
                query: { code: 'auth-code', state: 'mock-state' },
                headers: { cookie: `__oidc_state=${stateId}` },
            }),
            callbackRes
        );

        expect(callbackRes._cookies['__oidc_session']).toBeDefined();
        expect(callbackRes._clearedCookies).toContain('__oidc_state');
        expect(callbackRes._redirect).toBe('/');

        // 3) me: read the session back through the same stub map.
        const sessionId = callbackRes._cookies['__oidc_session'].value;
        const meRes = createMockRes();
        await controller.handleMe(
            createMockRequest({ headers: { cookie: `__oidc_session=${sessionId}` } }),
            meRes
        );

        expect(meRes._json).toEqual({
            success: true,
            data: {
                user: { sub: 'user-123', email: 'user@example.com' },
                expiresAt: expect.any(Number),
                authorized: true,
            },
        });
        expect(sessions.has(sessionId)).toBe(true);
    });

    it('sanitizes returnTo: unsafe values fall back to "/"', async () => {
        const { provider, states } = createStubProvider();
        const controller = new TestController(provider);

        const unsafe = createMockRes();
        await controller.handleLogin(
            { query: { returnTo: '//evil.example' }, headers: {} } as unknown as Request,
            unsafe
        );
        const unsafeStateId = unsafe._cookies['__oidc_state'].value;
        expect(states.get(unsafeStateId)?.returnTo).toBe('/');

        const safe = createMockRes();
        await controller.handleLogin(
            { query: { returnTo: '/settings?tab=security' }, headers: {} } as unknown as Request,
            safe
        );
        const safeStateId = safe._cookies['__oidc_state'].value;
        expect(states.get(safeStateId)?.returnTo).toBe('/settings?tab=security');
    });
});
```

Cookie-flag tests are explicit: `secure` is `false` in development and `true` in production (drive it via the settings double passed to `super`), while `httpOnly`, `sameSite: 'lax'`, and `path: '/'` are unconditional.

### CSRF enforcement

Source tests: `tests/oidc-controller-csrf.spec.test.ts`.

When `csrf: { enabled: true }` is configured: `/me` returns the session token, and `logout`/`refresh` require it in the configured header (default `x-csrf-token`, compared in constant time). A session is never modified before the check passes.

```typescript
// tests/oidc-csrf.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { Request } from 'express';
import { OidcAuthController } from 'blendsdk/webafx-auth';
import type { OidcAuthProvider, OidcCsrfConfig, OidcSession } from 'blendsdk/webafx-auth';
import { createMockRes } from './test-helpers';

const CSRF_TOKEN = 'csrf-token-value';

class TestController extends OidcAuthController {
    constructor(private readonly provider: OidcAuthProvider) {
        super({ isProduction: () => false } as never, {} as never);
    }

    protected async getProvider(_req: Request): Promise<OidcAuthProvider> {
        return this.provider;
    }
}

function createSession(): OidcSession {
    return {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        user: { sub: 'user-1' },
        csrfToken: CSRF_TOKEN,
    };
}

function makeProvider(csrf: OidcCsrfConfig | undefined, session: OidcSession): {
    provider: OidcAuthProvider;
    clearSession: ReturnType<typeof vi.fn>;
    refreshToken: ReturnType<typeof vi.fn>;
} {
    const clearSession = vi.fn(async () => undefined);
    const refreshToken = vi.fn(async () => ({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresIn: 3600,
        tokenType: 'Bearer',
    }));

    const provider = {
        getCsrfConfig: () => csrf,
        resolveRequestConfig: vi.fn(async () => undefined),
        getSessionCookieName: () => '__oidc_session',
        getSession: vi.fn(async () => session),
        clearSession,
        storeSession: vi.fn(async () => undefined),
        refreshToken,
        revokeToken: vi.fn(async () => undefined),
        shouldRotateSessionIdOnRefresh: () => false,
        getSessionCookieTtl: () => 3600,
    } as unknown as OidcAuthProvider;

    return { provider, clearSession, refreshToken };
}

function cookieRequest(csrfHeader?: string): Request {
    const headers: Record<string, string> = { cookie: '__oidc_session=session-1' };
    if (csrfHeader !== undefined) {
        headers['x-csrf-token'] = csrfHeader;
    }
    return { headers, query: {} } as unknown as Request;
}

describe('CSRF enforcement', () => {
    it('returns the session CSRF token from /me', async () => {
        const { provider } = makeProvider({ enabled: true }, createSession());
        const controller = new TestController(provider);

        const res = createMockRes();
        await controller.handleMe(cookieRequest(), res);

        const body = res._json as { data: { csrfToken?: string } };
        expect(body.data.csrfToken).toBe(CSRF_TOKEN);
    });

    it('rejects logout without the session token and clears nothing', async () => {
        const { provider, clearSession } = makeProvider({ enabled: true }, createSession());
        const controller = new TestController(provider);

        const res = createMockRes();
        await controller.handleLogout(cookieRequest(), res);

        expect(res._status).toBe(403);
        expect(res._json).toMatchObject({
            success: false,
            error: { code: 'csrf_invalid' },
        });
        expect(clearSession).not.toHaveBeenCalled();
    });

    it('allows logout with the correct token', async () => {
        const { provider, clearSession } = makeProvider({ enabled: true }, createSession());
        const controller = new TestController(provider);

        const res = createMockRes();
        await controller.handleLogout(cookieRequest(CSRF_TOKEN), res);

        expect(res._status).toBe(200);
        expect(clearSession).toHaveBeenCalledWith('session-1');
    });

    it('leaves logout and refresh unchanged when CSRF is not configured', async () => {
        const { provider, clearSession, refreshToken } = makeProvider(undefined, createSession());
        const controller = new TestController(provider);

        await controller.handleLogout(cookieRequest(), createMockRes());
        expect(clearSession).toHaveBeenCalledTimes(1);

        await controller.handleRefresh(cookieRequest(), createMockRes());
        expect(refreshToken).toHaveBeenCalledTimes(1);
    });
});
```

### Session-ID rotation on refresh

Source tests: `tests/oidc-session-rotation.spec.test.ts`, `tests/oidc-session-rotation.impl.test.ts`.

With `rotateSessionIdOnRefresh: true`, a successful refresh stores the updated session under a new UUID, deletes the old entry, and re-issues the cookie — an id captured before the refresh stops resolving. Failures leave the existing session and cookie untouched.

```typescript
// tests/oidc-session-rotation.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { Request } from 'express';
import { OidcAuthController, OidcAuthProvider } from 'blendsdk/webafx-auth';
import { createMockCacheProvider, createMockRes, createSampleSession } from './test-helpers';

class TestController extends OidcAuthController {
    constructor(private readonly provider: OidcAuthProvider) {
        super({ isProduction: () => false } as never, {} as never);
    }

    protected async getProvider(_req: Request): Promise<OidcAuthProvider> {
        return this.provider;
    }
}

function createProvider(options: { rotate: boolean }): OidcAuthProvider {
    const cache = createMockCacheProvider();
    const provider = new OidcAuthProvider({
        issuerUrl: 'https://auth.example.com',
        clientId: 'test-client',
        sessionStore: cache.provider,
        rotateSessionIdOnRefresh: options.rotate,
    });
    vi.spyOn(provider, 'refreshToken').mockResolvedValue({
        accessToken: 'refreshed-access-token',
        refreshToken: 'refreshed-refresh-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
    });
    return provider;
}

function cookieRequest(sessionId: string): Request {
    return {
        query: {},
        headers: { cookie: `__oidc_session=${sessionId}` },
    } as unknown as Request;
}

describe('session-id rotation on refresh', () => {
    it('moves the session to a new id and stops resolving the old one', async () => {
        const provider = createProvider({ rotate: true });
        await provider.storeSession('S1', createSampleSession());
        const controller = new TestController(provider);

        const res = createMockRes();
        await controller.handleRefresh(cookieRequest('S1'), res);

        const newId = res._cookies['__oidc_session'].value;
        expect(newId).toBeDefined();
        expect(newId).not.toBe('S1');
        expect(await provider.getSession('S1')).toBeUndefined();
        expect(await provider.getSession(newId)).toBeDefined();
    });

    it('leaves the session and cookie in place when the refresh fails', async () => {
        const provider = createProvider({ rotate: true });
        const original = createSampleSession();
        await provider.storeSession('S1', original);
        vi.spyOn(provider, 'refreshToken').mockRejectedValue(new Error('refresh failed'));
        const controller = new TestController(provider);

        const res = createMockRes();
        await expect(controller.handleRefresh(cookieRequest('S1'), res)).rejects.toThrow(
            'refresh failed'
        );

        expect(res._cookies['__oidc_session']).toBeUndefined();
        expect(await provider.getSession('S1')).toEqual(original);
    });
});
```

### Concurrent refresh (single-flight)

Source tests: `tests/oidc-refresh-concurrency.spec.test.ts`.

Concurrent refreshes for one session must produce exactly one token-endpoint grant, one session store, and (with rotation) one session-id move. The deterministic pattern: gate the provider's config resolution until **all** callers have arrived (so every caller joins the flight), then gate the grant itself and assert afterwards. The barrier is what makes "N concurrent requests" reproducible — without it, a straggler can reach the lock after the flight settled.

```typescript
// tests/oidc-refresh-concurrency.test.ts
import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { OidcAuthController } from 'blendsdk/webafx-auth';
import type { OidcAuthProvider, OidcSession, OidcTokens } from 'blendsdk/webafx-auth';
import { createMockRes } from './test-helpers';

const SESSION_COOKIE = '__oidc_session';
const SESSION_ID = 'session-1';

const REFRESHED_TOKENS: OidcTokens = {
    accessToken: 'refreshed-access-token',
    refreshToken: 'refreshed-refresh-token',
    expiresIn: 3600,
    tokenType: 'Bearer',
};

class TestController extends OidcAuthController {
    constructor(private readonly provider: OidcAuthProvider) {
        super({ isProduction: () => false } as never, {} as never);
    }

    protected async getProvider(_req: Request): Promise<OidcAuthProvider> {
        return this.provider;
    }
}

function cookieRequest(sessionId: string): Request {
    return {
        query: {},
        headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    } as unknown as Request;
}

interface RefreshHarness {
    provider: OidcAuthProvider;
    grantCount(): number;
    stores: Array<{ id: string; session: OidcSession }>;
    waitForGrant(): Promise<void>;
    releaseGrant(): void;
}

/**
 * Gated provider double.
 *
 * - resolveRequestConfig counts callers and releases a barrier once
 *   `expectedCallers` have arrived, so every concurrent request joins the
 *   single flight before the grant can run.
 * - refreshToken signals `waitForGrant` and blocks on `releaseGrant`, keeping
 *   the flight open while the test observes it.
 */
function createRefreshHarness(expectedCallers: number): RefreshHarness {
    const sessions = new Map<string, OidcSession>([
        [
            SESSION_ID,
            {
                accessToken: 'old-access-token',
                refreshToken: 'old-refresh-token',
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                user: { sub: 'user-1' },
            },
        ],
    ]);
    const stores: Array<{ id: string; session: OidcSession }> = [];
    let grants = 0;

    let callers = 0;
    let releaseCallers: () => void = () => undefined;
    const allCallersReady = new Promise<void>((resolve) => {
        releaseCallers = () => resolve();
    });

    let signalGrantEntered: () => void = () => undefined;
    const grantEntered = new Promise<void>((resolve) => {
        signalGrantEntered = () => resolve();
    });
    let openGrantGate: () => void = () => undefined;
    const grantGate = new Promise<void>((resolve) => {
        openGrantGate = () => resolve();
    });

    const provider = {
        getSessionCookieName: () => SESSION_COOKIE,
        getCsrfConfig: () => undefined,
        getSession: async (id: string) => sessions.get(id),
        resolveRequestConfig: async () => {
            callers += 1;
            if (callers >= expectedCallers) {
                releaseCallers();
            }
            await allCallersReady;
            return undefined;
        },
        refreshToken: async () => {
            grants += 1;
            signalGrantEntered();
            await grantGate;
            return REFRESHED_TOKENS;
        },
        shouldRotateSessionIdOnRefresh: () => false,
        storeSession: async (id: string, session: OidcSession) => {
            stores.push({ id, session });
            sessions.set(id, session);
        },
        clearSession: async (id: string) => {
            sessions.delete(id);
        },
        getSessionCookieTtl: () => 3600,
    } as unknown as OidcAuthProvider;

    return {
        provider,
        grantCount: () => grants,
        stores,
        waitForGrant: () => grantEntered,
        releaseGrant: () => openGrantGate(),
    };
}

describe('single-flight refresh', () => {
    it('performs one grant for ten concurrent refreshes and returns the same result to all', async () => {
        const harness = createRefreshHarness(10);
        const controller = new TestController(harness.provider);

        const responses = Array.from({ length: 10 }, () => createMockRes());
        const pending = responses.map((res) =>
            controller.handleRefresh(cookieRequest(SESSION_ID), res)
        );

        await harness.waitForGrant();
        harness.releaseGrant();
        await Promise.all(pending);

        expect(harness.grantCount()).toBe(1);
        expect(harness.stores).toHaveLength(1);
        for (const res of responses) {
            expect(res._status).toBe(200);
            expect(res._cookies[SESSION_COOKIE]).toBe(SESSION_ID);
        }
    });
});
```

To test the rotating variant, set `shouldRotateSessionIdOnRefresh: () => true` and assert that all responses carry the same **new** cookie value while `harness.stores` still holds exactly one entry.

### Public API surface

Source test: `tests/public-api-surface.spec.test.ts`. A small consumer-side smoke test guards against accidental removals when upgrading:

```typescript
// tests/public-api-surface.test.ts
import { describe, it, expect } from 'vitest';
import * as auth from 'blendsdk/webafx-auth';

describe('public API surface', () => {
    it('keeps the documented entry-point exports available', () => {
        expect(typeof auth.createAuthPlugin).toBe('function');
        expect(typeof auth.jwtAuthPlugin).toBe('function');
        expect(typeof auth.createAuthProvider).toBe('function');
        expect(typeof auth.OidcAuthController).toBe('function');
        expect(typeof auth.MemoryAuthProvider).toBe('function');

        expect(auth.DEFAULT_SERVICE_NAME).toBe('auth');
        expect(auth.DEFAULT_PLUGIN_PRIORITY).toBe(10);
        expect(auth.DEFAULT_COOKIE_NAME).toBe('auth_token');
        expect(auth.DEFAULT_QUERY_PARAM_NAME).toBe('token');
        expect(auth.DEFAULT_TOKEN_SOURCES).toEqual(['header']);
    });
});
```

---

*See also: the package README for configuration reference, and `blendsdk/webafx`'s own testing guide for application-level test patterns.*

---

# webafx-auth Troubleshooting

This guide covers the failures most commonly encountered when running `blendsdk/webafx-auth`, grouped by area. Read failures through the package's two failure channels before you start debugging:

- **Silent rejection** — a missing, invalid, or expired credential resolves to `undefined` and the secure guard answers `401`. Nothing is thrown and nothing is logged; this is the contract, not a bug.
- **Infrastructure failure** — network errors, timeouts, non-2xx introspection responses, discovery problems, cache/store errors, and rejecting `configFactory` functions are thrown (or reject) and reach your framework error handler. These carry exact, greppable messages.

All examples assume an ESM project (`"type": "module"`), TypeScript strict mode, and Node.js >= 22, and import only from the package root.

---

## Common Errors

The OIDC BFF controller answers with a fixed envelope — `{ "success": false, "error": { "code", "message" } }` — that never reflects upstream error text. Use this table to identify where a response came from, then jump to the matching entry below.

| Status | `error.code` | Message | Emitted by |
| --- | --- | --- | --- |
| 400 | `oidc_error` | Sign-in was rejected by the identity provider | callback |
| 400 | `missing_code` | Authorization code missing from callback | callback |
| 400 | `missing_state` | Session state not found (expired or missing) | callback |
| 400 | `invalid_state` | State parameter mismatch (possible CSRF) | callback |
| 400 | `oidc_exchange_failed` | Sign-in could not be completed | callback |
| 400 | `userinfo_subject_mismatch` | UserInfo response subject does not match the ID token subject | callback |
| 400 | `no_refresh_token` | No refresh token available | refresh |
| 403 | `userinfo_forbidden` | Access to this account is not permitted | callback |
| 403 | `csrf_invalid` | Invalid or missing CSRF token | logout, refresh |
| 401 | `no_session` | No active session | me, refresh |

### Startup and Configuration Errors

#### `createAuthProvider: type 'jwt' requires 'secret'`

Related exact messages: `createAuthProvider: type 'oidc' requires 'issuerUrl'`, `createAuthProvider: type 'introspection' requires 'introspectionUrl', 'clientId' and 'clientSecret', or 'configFactory'`, and `createAuthProvider: unsupported type '...'` for a `type` outside the union.

**Cause.** `createAuthProvider()` validates the selected `type`'s required fields before constructing anything, so a misconfigured deployment fails during boot rather than at the first request. A missing environment variable is the usual trigger.

**Fix.** Supply the required fields for your `type` (or construct the provider class directly, which skips the factory's validation):

```typescript
import { createAuthProvider, JwtAuthProvider } from 'blendsdk/webafx-auth';

// Validated at startup — throws "requires 'secret'" if the variable is missing:
export const providerFromFactory = createAuthProvider({
    type: 'jwt',
    secret: process.env.JWT_SECRET!,
    issuer: 'https://auth.example.com',
});

// Equivalent direct construction:
export const providerDirect = new JwtAuthProvider({
    secret: process.env.JWT_SECRET!,
    issuer: 'https://auth.example.com',
});
```

#### `OidcAuthProvider requires either issuerUrl or configFactory`

**Cause.** The constructor guard rejects an OIDC provider that has no way to resolve an issuer — neither a static `issuerUrl` nor a per-request `configFactory`.

**Fix.** Provide static configuration, a factory, or both. When both are set, the static values serve `validate()` and `health()`, while `configFactory` serves per-request `authenticate()`:

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

const provider = new OidcAuthProvider({
    issuerUrl: process.env.OIDC_ISSUER_URL!,
    clientId: process.env.OIDC_CLIENT_ID!,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
});
```

#### `IntrospectionAuthProvider requires either introspectionUrl, clientId and clientSecret, or a configFactory`

**Cause.** Same fail-fast pattern: the introspection provider needs a complete static client triple or a `configFactory`.

**Fix.**

```typescript
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';

const provider = new IntrospectionAuthProvider({
    introspectionUrl: 'https://auth.example.com/oauth2/introspect',
    clientId: process.env.CLIENT_ID!,
    clientSecret: process.env.CLIENT_SECRET!,
});
```

#### `Unknown token source: "basic". Supported: "header", "cookie", "query", or { extractor: fn }`

**Cause.** A `tokenSources` entry is neither a built-in (`'header'`, `'cookie'`, `'query'`) nor an object with an `extractor` function. TypeScript usually catches this first (`Type '"basic"' is not assignable to type 'TokenSource'.`); the runtime error appears when untyped JavaScript, JSON-driven configuration, or a cast bypasses the compiler.

**Fix.** Use the allowed values, and wrap custom logic in `{ extractor }`:

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';
import type { TokenSource } from 'blendsdk/webafx-auth';

const apiKeySource: TokenSource = {
    extractor: (req) => {
        const value = req.headers['x-api-key'];
        return typeof value === 'string' ? value : undefined;
    },
};

const provider = new JwtAuthProvider({
    secret: process.env.JWT_SECRET!,
    tokenSources: ['header', apiKeySource],
});
```

#### `Plugin "auth:auth" is already registered`

**Cause.** `createAuthPlugin()` names the plugin `auth:<serviceName>`. Two plugins that both use the default `serviceName` (`'auth'`) produce the same name, and WebAFX refuses the second `app.use()` at startup instead of silently replacing the first.

**Fix.** Give each plugin a distinct `serviceName` and a `userServiceName` that matches the principal name your routes select:

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { MemoryAuthProvider, createAuthPlugin } from 'blendsdk/webafx-auth';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'INFO' });

app.use(createAuthPlugin(new MemoryAuthProvider(), {
    serviceName: 'user-auth',
    userServiceName: 'user',
}));

app.use(createAuthPlugin(new MemoryAuthProvider(), {
    serviceName: 'client-auth',
    userServiceName: 'client',
}));
```

An unnamed secure route always resolves the default `'user'` service; a machine-facing route must name its principal (for example `secure('client')`).

### Token Extraction Failures

#### Requests authenticate nowhere: the `Authorization` header is not recognized

**Symptom.** `provider.extractToken(req)` returns `undefined` even though the client sends a token, so every request is a silent 401.

**Cause.** The built-in header extractor requires exactly `Bearer ` — capital `B` plus one trailing space. `bearer x`, `BEARER x`, `Token x`, or a `Bearer` header with an empty value all fail; the empty value is skipped as "no token found".

**Fix.** Send the canonical header, or install a tolerant extractor first in the chain:

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const provider = new JwtAuthProvider({
    secret: process.env.JWT_SECRET!,
    tokenSources: [
        {
            extractor: (req) => {
                const header = req.headers.authorization;
                if (header && header.toLowerCase().startsWith('bearer ')) {
                    const token = header.slice(7).trim();
                    return token.length > 0 ? token : undefined;
                }
                return undefined;
            },
        },
    ],
});
```

#### Cookie token source never finds the token

**Symptom.** `tokenSources: ['cookie']` never authenticates although the browser sends the cookie.

**Cause.** The `cookie` source reads `req.cookies`, which only exists when cookie-parser middleware has run. WebAFX's core middleware installs it, but a bare Express setup or a hand-rolled test harness leaves `req.cookies` undefined.

**Fix.** Run cookie-parser before the plugin in non-WebAFX setups (or extract from the raw `Cookie` header with a custom extractor):

```typescript
import cookieParser from 'cookie-parser';
import express from 'express';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const app = express();
app.use(cookieParser());

const provider = new JwtAuthProvider({
    secret: process.env.JWT_SECRET!,
    tokenSources: ['cookie'],
    cookieName: 'auth_token', // default
});
```

### Validation Failures (All Providers)

#### Every token is rejected after enabling `requireAudience`

**Cause.** `requireAudience: true` fails closed: when the option is enabled and no `audience` is configured, the provider rejects the token *before* any verification (or discovery). This is intentional — it stops a token minted for another API by the same issuer from being accepted unchecked — but the result is that every request silently becomes a 401.

**Fix.** Configure the `audience` (single value or array) alongside the flag, for both JWT and OIDC validation:

```typescript
import { JwtAuthProvider, OidcAuthProvider } from 'blendsdk/webafx-auth';

const jwtProvider = new JwtAuthProvider({
    secret: process.env.JWT_SECRET!,
    audience: 'https://api.example.com',
    requireAudience: true,
});

const oidcProvider = new OidcAuthProvider({
    issuerUrl: process.env.OIDC_ISSUER_URL!,
    clientId: process.env.OIDC_CLIENT_ID!,
    audience: 'https://api.example.com',
    requireAudience: true,
});
```

#### Asymmetric (RS256/ES256) tokens are all rejected silently

**Cause.** `JwtAuthProvider` defaults `algorithms` to `['HS256']` for every instance, including instances constructed with a `CryptoKey`. `jose` then refuses a token whose `alg` is not in the allowlist, and the failure is swallowed into `undefined`.

**Fix.** Set `algorithms` explicitly to match the key material:

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';
import { importSPKI } from 'jose';

const publicKey = await importSPKI(process.env.JWT_PUBLIC_KEY_PEM!, 'RS256');

const provider = new JwtAuthProvider({
    secret: publicKey,
    algorithms: ['RS256'],
});
```

Add `jose` to your application's dependencies when you load keys with it.

#### `validate()` returns `undefined` and `health()` reports false in factory-only mode

**Cause.** `validate()` has no request context, so it cannot run a `configFactory`:

- `IntrospectionAuthProvider.validate()` returns `undefined` in factory-only mode — use `authenticate(req)` instead.
- `OidcAuthProvider.validate()` returns `undefined` when static `issuerUrl`/`clientId` are absent, and `health()` reports false for a factory-only provider because it can only check static configuration.

**Fix.** Route factory-backed deployments through `authenticate(req)` — which is exactly what the plugin registers and the secure guard calls:

```typescript
import type { Request } from 'express';
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

const provider = new OidcAuthProvider({
    configFactory: async (req) => ({
        issuerUrl: `https://${String(req.headers['x-tenant'] ?? 'default')}.auth.example.com`,
        clientId: 'my-client',
    }),
});

export async function authenticateRequest(req: Request) {
    return provider.authenticate(req);
}
```

### Introspection Failures

#### `Token introspection failed with HTTP 500` (any non-2xx status)

**Cause.** The introspection endpoint answered a non-2xx status. The provider throws by design — the message deliberately excludes the token and credentials — so this is an infrastructure failure, not a failed validation. Frequent causes: wrong credentials, wrong client authentication method, an expired client secret, or a moved endpoint. Statuses: 401/403 usually means credentials; 5xx means the endpoint is unhealthy.

**Fix.** Reproduce the exact RFC 7662 request by hand, then align `authMethod` with what the server expects (`basic` is the default):

```bash
curl -sS -X POST https://auth.example.com/oauth2/introspect \
  -u 'my-client:my-secret' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'Accept: application/json' \
  --data 'token=opaque-token&token_type_hint=access_token'
```

```typescript
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';

const provider = new IntrospectionAuthProvider({
    introspectionUrl: 'https://auth.example.com/oauth2/introspect',
    clientId: process.env.CLIENT_ID!,
    clientSecret: process.env.CLIENT_SECRET!,
    authMethod: 'post', // when the server expects client_secret_post
});
```

#### Introspection calls reject with a fetch error after the endpoint starts redirecting

**Symptom.** Every validation rejects (`TypeError: fetch failed` with a redirect-related cause) after the endpoint URL begins answering 3xx — for example when a plain-HTTP URL now redirects to HTTPS, or a path was moved.

**Cause.** The provider performs introspection calls with `redirect: "error"` on purpose: the endpoint is application/tenant supplied, and following a redirect could reach internal hosts.

**Fix.** Point `introspectionUrl` directly at the final HTTPS URL; do not rely on redirects:

```typescript
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';

const provider = new IntrospectionAuthProvider({
    introspectionUrl: 'https://auth.example.com/oauth2/introspect', // final URL — no redirect
    clientId: process.env.CLIENT_ID!,
    clientSecret: process.env.CLIENT_SECRET!,
});
```

#### `Token introspection returned an invalid response body`

**Cause.** The endpoint answered 200 with JSON that is not an RFC 7662 object — `null`, an array, or a primitive. (Invalid JSON throws the underlying parse error instead of this message.) This often happens when a proxy or gateway in front of the endpoint returns an HTML or wrapped payload.

**Fix.** Inspect the raw response with the same request the provider sends; a valid response is a JSON object with at least `active`:

```typescript
const clientId = process.env.CLIENT_ID!;
const clientSecret = process.env.CLIENT_SECRET!;

const response = await fetch('https://auth.example.com/oauth2/introspect', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ token: 'opaque-token', token_type_hint: 'access_token' }),
});

console.info(response.status, await response.text());
```

#### `IntrospectionAuthProvider: resolved config is missing introspectionUrl, clientId or clientSecret`

**Cause.** Your `configFactory` returned an incomplete object — typically a lookup that produced an empty record or values of the wrong type. The provider fails loudly instead of building a malformed request.

**Fix.** Validate inside the factory and throw a descriptive error before returning:

```typescript
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';

const provider = new IntrospectionAuthProvider({
    configFactory: async (req) => {
        const introspectionUrl = req.headers['x-introspect-url'];
        const clientId = req.headers['x-client-id'];
        const clientSecret = req.headers['x-client-secret'];

        if (
            typeof introspectionUrl !== 'string' ||
            typeof clientId !== 'string' ||
            typeof clientSecret !== 'string'
        ) {
            throw new Error('Resolved introspection credentials are incomplete');
        }

        return { introspectionUrl, clientId, clientSecret };
    },
});
```

### OIDC Validation and BFF Failures

#### `OidcAuthProvider: sessionStore is required for BFF session operations`

**Cause.** Session and PKCE-state operations were invoked without a `sessionStore`. The OIDC BFF flow stores sessions and transient login state in a `blendsdk/webafx-cache` `CacheProvider`.

**Fix.** Pass the cache provider registered with your application:

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';
import type { CacheProvider } from 'blendsdk/webafx-cache';

export function createOidcProvider(sessionStore: CacheProvider): OidcAuthProvider {
    return new OidcAuthProvider({
        issuerUrl: process.env.OIDC_ISSUER_URL!,
        clientId: process.env.OIDC_CLIENT_ID!,
        clientSecret: process.env.OIDC_CLIENT_SECRET,
        redirectUri: `${process.env.APP_URL!}/api/oidc/callback`,
        sessionStore,
    });
}
```

#### `OIDC discovery for <issuer> did not return a jwks_uri`

**Cause.** Discovery succeeded but the metadata document lacked `jwks_uri`. This usually means `issuerUrl` points at a base URL rather than the exact issuer — the discovery document must be reachable at the issuer and advertise a JWKS endpoint.

**Fix.** Inspect the metadata and align `issuerUrl` with the document's `issuer` value:

```bash
curl -sS https://auth.example.com/.well-known/openid-configuration | jq '{issuer, jwks_uri}'
```

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

const provider = new OidcAuthProvider({
    issuerUrl: 'https://auth.example.com', // must equal the discovery document's "issuer"
    clientId: process.env.OIDC_CLIENT_ID!,
});
```

#### `clientId is required for buildAuthorizationUrl`

Related exact messages: `redirectUri is required for buildAuthorizationUrl` and `issuerUrl is required for buildAuthorizationUrl`.

**Cause.** The login-start method needs `clientId`, `redirectUri`, and an issuer, none of which came from the provider config or the per-call `params` override.

**Fix.** Configure all three on the provider:

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

const provider = new OidcAuthProvider({
    issuerUrl: process.env.OIDC_ISSUER_URL!,
    clientId: process.env.OIDC_CLIENT_ID!,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    redirectUri: `${process.env.APP_URL!}/api/oidc/callback`,
});

const authorization = await provider.buildAuthorizationUrl();
console.info(authorization.url);
```

#### `issuerUrl and clientId are required for exchangeCode`

Related exact messages exist for `refreshToken`, `revokeToken`, and `fetchUserInfo`.

**Cause.** A BFF method was called on a provider without static `issuerUrl`/`clientId`, typically a factory-only provider that did not receive the resolved per-request config.

**Fix.** Resolve the config first and pass it (the packaged `OidcAuthController` does this threading automatically):

```typescript
import type { Request } from 'express';
import { OidcAuthProvider } from 'blendsdk/webafx-auth';
import type { OidcTokens } from 'blendsdk/webafx-auth';

const provider = new OidcAuthProvider({
    configFactory: async () => ({
        issuerUrl: 'https://auth.example.com',
        clientId: 'my-client',
        clientSecret: process.env.OIDC_CLIENT_SECRET,
    }),
});

export async function exchange(
    req: Request,
    codeVerifier: string,
    callbackUrl: string,
): Promise<OidcTokens> {
    const config = await provider.resolveRequestConfig(req);
    return provider.exchangeCode({ codeVerifier, callbackUrl }, config);
}
```

#### Callback returns 400 `oidc_exchange_failed`

**Symptom.** The callback responds `{ "success": false, "error": { "code": "oidc_exchange_failed", "message": "Sign-in could not be completed" } }` and clears the transient PKCE state; at the provider level the call throws `OidcCodeExchangeError` (fixed message: `Authorization code exchange failed`). No session is created.

**Cause.** The code exchange or ID-token verification failed for a flow-level reason a browser user can act on: an invalid, expired, or already-used authorization code; a token-endpoint OAuth error body (for example `invalid_grant`); a failed ID-token check (`nonce`, `iss`, `aud`, `exp`, signature, or an unknown `kid`); or a verified ID token without a string `sub` when the subject check is enabled. Infrastructure problems — discovery failures, network errors, 5xx responses — propagate as server errors instead and produce no such response.

**Fix.** Treat it as a rejected sign-in and restart the flow. When you handle the error yourself, discriminate with `instanceof` and never forward the `cause` to clients or log it verbatim (it may contain provider response detail):

```typescript
import { OidcAuthProvider, OidcCodeExchangeError } from 'blendsdk/webafx-auth';

export async function tryExchange(
    provider: OidcAuthProvider,
    codeVerifier: string,
    callbackUrl: string,
) {
    try {
        return await provider.exchangeCode({ codeVerifier, callbackUrl });
    } catch (error) {
        if (error instanceof OidcCodeExchangeError) {
            // Rejected sign-in: restart sign-in. Inspect error.cause for
            // diagnostics only — never log it verbatim or send it to clients.
            return undefined;
        }
        throw error; // network/discovery/5xx — let it surface as a server error
    }
}
```

#### Callback returns 400 `invalid_state` or `missing_state`

**Symptoms.** `invalid_state` — "State parameter mismatch (possible CSRF)". `missing_state` — "Session state not found (expired or missing)".

**Cause.**
- `missing_state`: the state cookie was absent or already expired. The state cookie lives 5 minutes; a user who leaves the sign-in tab open longer, a browser that refuses the cookie (production mode over plain HTTP — the cookie is `secure` only in production, so it works in dev but then silently fails after a production-mode switch), or login and callback resolving different cookie names (org-scoped resolvers) all produce this.
- `invalid_state`: stored state exists, but the `state` query parameter differs — multiple tabs, a replayed callback, or a stale link.

**Fix.** Keep the round trip under 5 minutes, serve production over HTTPS, and make cookie-name resolution consistent between login and callback:

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

const provider = new OidcAuthProvider({
    issuerUrl: process.env.OIDC_ISSUER_URL!,
    clientId: process.env.OIDC_CLIENT_ID!,
    resolveStateCookieName: (req) =>
        `__oidc_state_${String(req.headers.host ?? 'default').split('.')[0]}`,
    resolveSessionCookieName: (req) =>
        `__oidc_session_${String(req.headers.host ?? 'default').split('.')[0]}`,
});
```

Starting a fresh sign-in from `/api/oidc/login` clears stale state for the retry.

#### Callback returns 403 `userinfo_forbidden`

**Cause.** The identity provider authenticated the user, but the UserInfo endpoint refused the request with HTTP 403 (insufficient scope, disabled account, or an application-level policy). By default the callback returns a fixed 403 and creates no session.

**Fix.** Check that requested `scopes` satisfy the endpoint. To let the application present a "signed in, but not allowed" state instead, opt in to the unauthorized-session policy:

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

const provider = new OidcAuthProvider({
    issuerUrl: process.env.OIDC_ISSUER_URL!,
    clientId: process.env.OIDC_CLIENT_ID!,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    scopes: ['openid', 'profile', 'email'],
    userInfoDenied: 'unauthorized-session',
    notAuthorizedPath: '/not-authorized',
});
```

These sessions still authenticate (so `/me` can report them) and carry `authorized: false` — guards that must deny them have to check `result.authorized !== false` explicitly; the field is descriptive, not enforced. If no verified identity is available, the outcome falls back to the fixed 403.

#### Callback returns 400 `userinfo_subject_mismatch`

**Cause.** The UserInfo response `sub` differs from the verified ID-token `sub`. OpenID Connect Core §5.3.2 requires them to match and states a mismatched response must not be used, so the callback rejects the sign-in, clears the state, and stores no session. The provider-level call throws `OidcUserInfoSubjectMismatchError`.

**Fix.** Fix the provider or endpoint configuration. Disabling the check is a deliberate weakening of the sign-in guarantee and should be a last resort:

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

const provider = new OidcAuthProvider({
    issuerUrl: process.env.OIDC_ISSUER_URL!,
    clientId: process.env.OIDC_CLIENT_ID!,
    verifyUserInfoSubject: false, // last resort — only for providers that cannot be fixed
});
```

#### Logout or refresh returns 403 `csrf_invalid`

**Cause.** CSRF enforcement is enabled and the session-bound token was missing or wrong. Sessions created before enforcement was switched on have no token and are signed out on their next logout or refresh. With enforcement on, even a missing session is rejected as 403 (the CSRF check runs before the session-existence check).

**Fix.** Configure the header, then have clients read the token from `GET /me` (or a refresh response) and echo it:

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

const provider = new OidcAuthProvider({
    issuerUrl: process.env.OIDC_ISSUER_URL!,
    clientId: process.env.OIDC_CLIENT_ID!,
    csrf: { enabled: true, header: 'x-csrf-token' },
});
```

```typescript
interface MeResponse {
    success: boolean;
    data?: { csrfToken?: string };
}

const me = (await fetch('/api/oidc/me', { credentials: 'same-origin' }).then(
    (response) => response.json() as Promise<MeResponse>,
));

const csrfToken = me.data?.csrfToken;
if (csrfToken === undefined) {
    throw new Error('No session or CSRF token — sign in again');
}

await fetch('/api/oidc/refresh', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-csrf-token': csrfToken },
});
```

#### 401 `no_session` or 400 `no_refresh_token`

**Cause.** `/me` and `/refresh` found no resolvable session: no cookie, an unknown id, an expired store entry, a session past its `expiresAt` or absolute deadline, or an id that was rotated away by a previous refresh. `no_refresh_token` means the session exists but carries no refresh token — typically the IdP never granted one.

**Fix.** Sign in again for missing sessions; verify TTLs for premature expiry; request refresh tokens explicitly when your IdP gates them behind a scope:

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

const provider = new OidcAuthProvider({
    issuerUrl: process.env.OIDC_ISSUER_URL!,
    clientId: process.env.OIDC_CLIENT_ID!,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    sessionTtl: 7200,
});
```

With session-id rotation enabled, the refresh response must reach the browser; a lost response leaves the browser holding the id of a session that was just deleted.

### Transport and TLS Errors

#### Discovery or exchange fails against a private or self-signed issuer

**Symptom.** Fetch-level rejections such as `fetch failed`, `self-signed certificate`, or `unable to verify the first certificate` while the issuer is reachable from `curl`.

**Cause.** The default transport validates TLS with the system trust store, which does not know a private CA. Note the reverse trap: passing `ca` **replaces** the system roots rather than adding to them, so a configuration that mixes public and private issuers needs the public roots included in the value.

**Fix.** Supply the private CA through `transport`:

```typescript
import { readFileSync } from 'node:fs';
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

const provider = new OidcAuthProvider({
    issuerUrl: 'https://idp.internal.example.com',
    clientId: process.env.OIDC_CLIENT_ID!,
    transport: {
        // Replaces the system roots — include public roots here if both are needed.
        ca: readFileSync('/etc/ssl/private-ca.pem', 'utf8'),
    },
});
```

#### Warning: `OidcAuthProvider: allowInsecureRequests is enabled. TLS certificate validation is disabled and non-HTTPS issuers are accepted. Do not use this in production.`

**Cause.** The development/test switch is on. It disables TLS certificate validation and permits non-HTTPS issuers; the warning is emitted once per provider.

**Fix.** Remove the relaxation in production — the default transport is HTTPS-only with system trust. Use `transport.ca` for private CAs, and `allowInsecureRequests` only against loopback issuers in tests:

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

const provider = new OidcAuthProvider({
    issuerUrl: process.env.OIDC_ISSUER_URL!,
    clientId: process.env.OIDC_CLIENT_ID!,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    // No `transport` block: HTTPS-only, system trust.
});
```

#### `createTlsFetch: refusing to follow an https-to-http redirect to http://...`

**Cause.** A discovery, JWKS, token, or refresh request was redirected from HTTPS down to plain HTTP. The transport shim always refuses protocol downgrades — independently of `allowInsecureRequests`, which only permits non-HTTPS issuers outright.

**Fix.** Correct the issuer metadata so every advertised endpoint is HTTPS; verify with:

```bash
curl -sS https://auth.example.com/.well-known/openid-configuration \
  | grep -E 'https?://'
```

### TypeScript Compiler Errors

#### `Cannot find module 'blendsdk/webafx-auth' or its corresponding type declarations.` (TS2307)

**Cause.** Legacy module resolution (`"moduleResolution": "node"` with a CommonJS-era `module` setting) cannot read the package's `exports` map. The package is ESM-first and resolves through `exports`, not `main`.

**Fix.** Use a modern module setup:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true
  }
}
```

For bundler-based projects, `"module": "ESNext"` with `"moduleResolution": "Bundler"` works as well. Also confirm the package is actually installed.

#### `The current file is a CommonJS module whose imports will produce 'require' calls; however, the referenced file is an ECMAScript module...` (TS1479)

**Cause.** A CommonJS TypeScript file (`module: "CommonJS"`, or a `.ts` file in a package without `"type": "module"`) imports this ESM-only package with a static `import`.

**Fix.** Convert the project to ESM (`"type": "module"` plus `NodeNext` module resolution), or load the package dynamically from CommonJS:

```typescript
export async function createProvider() {
    const { JwtAuthProvider } = await import('blendsdk/webafx-auth');
    return new JwtAuthProvider({ secret: process.env.JWT_SECRET! });
}
```

#### `Type 'string | undefined' is not assignable to type 'string | CryptoKey'.` (TS2322)

**Cause.** Under strict null checks, `process.env.X` is `string | undefined`, but `secret` (and the introspection `introspectionUrl`, `clientId`, and `clientSecret`) are required. The same pattern appears for any required config field fed directly from the environment.

**Fix.** Narrow the value once at startup and pass the narrowed variable:

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const secret = process.env.JWT_SECRET;
if (secret === undefined || secret.length === 0) {
    throw new Error('JWT_SECRET must be set');
}

const provider = new JwtAuthProvider({ secret });
```

#### `'user' is possibly 'undefined'.` / `'result' is possibly 'undefined'.` (TS18048)

**Cause.** `authenticate()` and the per-request `'user'` service resolve to `AuthResult | undefined` — an unauthenticated request is a normal outcome, so the type forces you to handle it.

**Fix.** Guard before use (inside a WebAFX request handler):

```typescript
import type { Request } from 'express';
import type { AuthResult } from 'blendsdk/webafx-auth';

export async function currentSubject(req: Request): Promise<string | undefined> {
    const user = await req.services.get<AuthResult>('user', undefined);
    return user?.sub;
}
```

#### `Parameter 'req' implicitly has an 'any' type.` (TS7006)

**Cause.** A config object declared away from its contextual type loses parameter inference — for example a `configFactory` extracted into its own `const` without an annotation.

**Fix.** Annotate the parameter(s) and the config type explicitly:

```typescript
import type { Request } from 'express';
import type { OidcAuthConfig } from 'blendsdk/webafx-auth';

export const tenantFactory: (req: Request) => Promise<OidcAuthConfig> = async (req) => {
    const tenant = String(req.headers['x-tenant'] ?? 'default');
    return {
        issuerUrl: `https://${tenant}.auth.example.com`,
        clientId: 'my-client',
    };
};
```

---

## Debugging Strategies

### 1. Decide where the failure lives: extraction vs validation

1. Capture the raw token from the failing request, or call the public `provider.extractToken(req)` on a copy of it.
2. If `extractToken` returns `undefined`, the problem is extraction (header format, cookie middleware, source order).
3. If a token comes back, call `provider.validate(token)` directly with the same configuration and inspect the outcome: `undefined` means a validation config mismatch (secret, issuer, audience, expiry); a thrown error means infrastructure.

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const token = process.argv[2];
if (token === undefined) {
    throw new Error('Pass the token as the first argument');
}

const provider = new JwtAuthProvider({
    secret: process.env.JWT_SECRET!,
    issuer: 'https://auth.example.com',
    audience: 'https://api.example.com',
});

const result = await provider.validate(token);
console.info(result === undefined ? 'REJECTED' : `VALID: ${result.sub}`);
```

### 2. Log what the extraction chain sees

Install a pass-through extractor first in the chain — it observes every request without changing behavior (the built-in `'header'` entry after it keeps the default working):

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const provider = new JwtAuthProvider({
    secret: process.env.JWT_SECRET!,
    tokenSources: [
        {
            extractor: (req) => {
                console.info('authorization:', req.headers.authorization);
                console.info('cookie header:', req.headers.cookie);
                return undefined; // observe only — fall through to 'header'
            },
        },
        'header',
    ],
});
```

### 3. Bisect with the MemoryAuthProvider

1. Temporarily replace your real provider with `MemoryAuthProvider` configured with a fixed token.
2. Call the failing route with `Authorization: Bearer bisect-token`.
3. If the route passes, the wiring is correct and the fault is in your real provider configuration. If it still fails, the guard, route principal, or service names are the problem.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { MemoryAuthProvider, createAuthPlugin } from 'blendsdk/webafx-auth';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development', LOG_LEVEL: 'DEBUG' });

app.use(createAuthPlugin(new MemoryAuthProvider({
    validTokens: {
        'bisect-token': { sub: 'bisect-user', claims: {}, token: 'bisect-token' },
    },
})));

// GET the failing route with: Authorization: Bearer bisect-token
```

### 4. Verify plugin names, service names, and route principals

Walk this checklist whenever a route 401s even though the provider seems healthy:

- Each plugin has a unique `serviceName` (duplicates throw `Plugin "auth:auth" is already registered` at startup).
- `userServiceName` matches the name the route passes to `secure(...)`; unnamed secure routes always resolve `'user'`.
- `OidcAuthController.getProviderServiceName()` matches the plugin's `serviceName` (default `'auth'`).
- Controllers read the principal with the same name the plugin registered.

```typescript
import { OidcAuthController } from 'blendsdk/webafx-auth';

class AuthController extends OidcAuthController {
    protected getProviderServiceName(): string {
        return 'oidc-auth'; // must match createAuthPlugin({ serviceName: 'oidc-auth' })
    }
}
```

### 5. Classify the outcome: silent 401 vs thrown error

1. A silent `undefined` (401) has no log trail — use strategies 1–4.
2. A thrown error reaches your framework error handler and carries an exact message (`Token introspection failed with HTTP ...`, fetch/TLS failures, `sessionStore is required ...`). Read the server log and fix the dependency; do not relax token validation to "fix" an infrastructure error.
3. Grep startup and first-request logs for the two one-time warnings (`allowInsecureRequests ...`, `verifyIdTokenSignature is disabled ...`). They flag configurations that quietly change behavior.

### 6. Inspect OIDC sessions and state in the cache

1. Cookie values are opaque UUIDs; the data lives under `oidc:session:<id>` and `oidc:state:<id>` keys.
2. Check existence and TTLs against `sessionTtl` / `stateTtl`, and check `expiresAt` against the current time (the authenticate path applies the configured clock tolerance as skew).
3. Confirm login and callback resolved the same cookie names when org-scoped resolvers are in play.

```typescript
import type { CacheProvider } from 'blendsdk/webafx-cache';
import type { OidcSession } from 'blendsdk/webafx-auth';

export async function readSession(
    store: CacheProvider,
    sessionId: string,
): Promise<OidcSession | undefined> {
    return store.get<OidcSession>(`oidc:session:${sessionId}`);
}
```

### 7. Verify the identity provider by hand

Reproduce what the provider fetches, outside the application:

```bash
# OIDC: confirm the discovery document and the JWKS it advertises
curl -sS https://auth.example.com/.well-known/openid-configuration | jq
curl -sS https://auth.example.com/.well-known/jwks.json | jq '.keys[].kid'

# Introspection: confirm the endpoint, credentials, and response shape
curl -sS -X POST https://auth.example.com/oauth2/introspect \
  -u 'my-client:my-secret' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'token=opaque-token&token_type_hint=access_token'
```

If these succeed but the provider fails, the difference is configuration (issuer URL, audience, TLS trust, client auth method) or environment (DNS, proxies, clocks).

### 8. Compare clocks and check claim timestamps

1. Compare `date -u` on the application host and the identity provider.
2. Decode the token's `exp` and `nbf` claims and compare them with the current time.
3. Dial in `clockTolerance` — `JwtAuthProvider` defaults to `0` seconds, `OidcAuthProvider` to `30`.

```typescript
const token = process.env.DEBUG_TOKEN!;
const [, payloadPart] = token.split('.');
const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<string, unknown>;

console.info('exp:', claims.exp, 'nbf:', claims.nbf, 'now:', Math.floor(Date.now() / 1000));
```

---

## Known Pitfalls

### Failure semantics

- **Silent rejection is the contract.** Invalid, expired, or missing credentials resolve to `undefined` — never a thrown error, never a log line. Do not add retry logic that assumes exceptions for bad tokens, and treat a 5xx as an infrastructure signal, not an auth signal.
- **`validate()` and `authenticate(req)` disagree in factory-only mode.** Both `IntrospectionAuthProvider.validate()` and `OidcAuthProvider.validate()` return `undefined` when the configuration only exists behind a `configFactory`; the plugin always calls `authenticate(req)`, so direct calls in scripts and tests can mislead you.
- **`configFactory` failure behavior differs per provider and path.** A rejecting factory on `IntrospectionAuthProvider` propagates (loud 5xx); on the OIDC bearer path it is swallowed into `undefined` (silent 401); on the OIDC BFF path it propagates. During a database outage, introspection fails loudly while OIDC bearer auth looks like a wave of bad tokens.

### Claims and clocks

- **A missing `sub` becomes the literal string `"unknown"`.** The default claims mapper resolves `String(rawClaims.sub ?? rawClaims.subject ?? "unknown")`, so a validated token without a subject authenticates as `sub: 'unknown'`. Treat that value as unauthenticated if your tokens always carry a subject.
- **Clock-tolerance defaults are inconsistent across providers.** `JwtAuthProvider` uses `0`, `OidcAuthProvider` uses `30` for JWT verification and for the session-expiry skew (static config only), and the introspection provider applies no tolerance at all to its `exp` check. A token second-away from expiry can pass one provider and fail another; set `clockTolerance` explicitly when swapping providers.
- **`requireAudience: true` without an `audience` rejects everything** (fail closed). This is easy to enable during a hardening pass and forget to pair with the audience value.

### OIDC per-request configuration

- **A `configFactory` cannot vary static-only settings.** `principalType`, `transport`, `discoveryTtl`, `sessionTtl`, `stateTtl`, `sessionAbsoluteTtl`, `sessionCookieTtl`, `rotateSessionIdOnRefresh`, `csrf`, `verifyIdTokenSignature`, `verifyUserInfoSubject`, `userInfoDenied`, and `notAuthorizedPath` are read from the static configuration only; values returned by the factory for these are ignored. `audience`/`requireAudience` *are* honored from the resolved config on the bearer path but come from static config in `validate()`.
- **The session-cookie path always reports `principalType: 'user'`.** A session is an interactive user session regardless of configuration; only the bearer path stamps the configured `principalType` (for example `'client'`).
- **Transport `ca` replaces the system roots** — it does not add to them. Mixing public and private issuers requires including the public roots in the `ca` value.
- **`tenantId` is never populated by the shipped providers.** The `AuthResult.tenantId` field exists for providers that resolve a tenant identity; multi-tenant OIDC sessions carry `organizationSlug` instead, and nothing fills `tenantId` automatically.

### OIDC BFF sessions

- **Logout and refresh are intentionally public** (not behind the secure guard) so that a session past its access-token expiry can still refresh or log out. They validate the opaque session cookie in the handler; do not "fix" this by adding them to a secure route.
- **CSRF enforcement signs out existing sessions.** Sessions created before `csrf.enabled` was set have no token and are rejected on their next logout or refresh. Also, the CSRF check runs before the session check, so a missing session with enforcement on returns 403, not 401.
- **The state cookie lives 5 minutes regardless of `stateTtl`.** The controller hardcodes the state cookie's `maxAge` at 300 seconds; raising `stateTtl` extends only the server-side entry, and the browser will still drop the cookie — the effective window is the shorter of the two.
- **Session-id rotation has inherent caveats.** If a successful refresh response is lost in transit, the browser keeps the old cookie whose session was just deleted, and the user must sign in again. The refresh single-flight is process-local, so multi-instance deployments need an external lock; a delete failure after a successful store can leave an orphan session until it expires.
- **TTL edge values are literal.** `sessionAbsoluteTtl: 0` makes every session immediately past its deadline (invalid configuration), while `sessionCookieTtl: 0` is honored as a deliberate non-persistent cookie.
- **`authorized: false` sessions still authenticate.** They surface through `/me` and the session path with `authorized: false`; guards must enforce the denial themselves — the flag is descriptive.
- **Unsafe `returnTo` values fall back to `/` silently.** Absolute URLs, protocol-relative paths, backslashes, whitespace, and control characters are replaced rather than rejected, so a "redirect didn't go where I expected" is by design, not a bug.

### Cookie handling

- **The `cookie` token source needs cookie-parser; the OIDC controller does not.** The controller parses the raw `Cookie` header itself, so hand-built test requests that populate only `req.cookies` drive the provider but leave the controller's state/session lookups empty.
- **`parseCookie` splits on `"; "` only and takes the first match.** Duplicate cookie names resolve to the first occurrence, and a header without a space after a semicolon (`a=1;b=2`) folds the remainder into the value. Emit cookies the way `res.cookie` does (semicolon + space) to keep parsing predictable.

### Testing and lifecycle

- **`MemoryAuthProvider.shutdown()` clears the token map.** The plugin delegates `shutdown()` to the provider, so a graceful app shutdown in a test suite empties the provider — register tokens again (or recreate the provider) for any test that runs afterwards.
- **Two memory plugins in one test app still need distinct names.** The plugin-name collision applies to tests exactly as it does to production; give each `createAuthPlugin` call its own `serviceName` and route principal.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
