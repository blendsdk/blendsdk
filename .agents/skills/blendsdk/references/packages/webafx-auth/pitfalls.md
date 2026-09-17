> **Package**: `blendsdk/webafx-auth`

# webafx-auth Best Practices

`blendsdk/webafx-auth` concentrates a lot of security-sensitive behavior behind a few firm rules: a single `authenticate()` lifecycle, a silent-failure contract, and providers designed to live for the lifetime of the process. Most mistakes with this package come from working around those rules — validating outside the lifecycle, treating infrastructure failures as invalid credentials, or discarding the provider's caches. This document pairs each rule with the wrong and right way to apply it.

---

## Do / Don't Pairs

At a glance:

| # | Practice | Rule of thumb |
| --- | --- | --- |
| 1 | Authenticate through the plugin | One route guard, one principal service per request |
| 2 | Fail fast at startup | Let `createAuthProvider()` validate the configuration |
| 3 | Respect the failure contract | `undefined` = unauthenticated; thrown = infrastructure |
| 4 | One provider per application | Caches and connections are process-wide |
| 5 | Configure the token chain | `tokenSources` instead of extraction middleware |
| 6 | Dynamic config needs the request | Call `authenticate(req)`, not `validate(token)` |
| 7 | Validate the audience | `audience` + `requireAudience: true` |
| 8 | Pin JWT algorithms | `algorithms: ['HS256']`, never implicit |
| 9 | Keep clock tolerance small | Seconds of skew, not minutes |
| 10 | OIDC sessions live server-side | Opaque cookie + `sessionStore` |
| 11 | Unique names per provider | Distinct `serviceName` / `userServiceName` |
| 12 | `MemoryAuthProvider` is a test double | Never in a production configuration |

### 1. Authenticate through the plugin, not inside each handler

**❌ Wrong**

```typescript fragment
// No route guard: authenticate() runs inside the handler, the principal
// never reaches the service container, and every handler that needs it
// validates all over again with its own error handling.
this.route()
    .get('/orders')
    .handle(async (req, res) => {
        const user = await provider.authenticate(req);
        if (user === undefined) {
            res.status(401).json({ success: false, error: { code: 'unauthorized', message: 'Unauthorized' } });
            return;
        }
        this.ok(res, { sub: user.sub });
    });
```

**✅ Correct**

```typescript fragment
import type { RouteDefinition } from 'blendsdk/webafx';
import type { AuthResult } from 'blendsdk/webafx-auth';

routes(): RouteDefinition[] {
    return [
        this.authenticated()
            .get('/orders')
            .handle(async (req, res) => {
                const user = await req.services.get<AuthResult>('user', undefined);
                this.ok(res, { sub: user?.sub });
            }),
    ];
}
```

**Why:** `createAuthPlugin()` registers a per-request principal service that calls `provider.authenticate(req)` exactly once and makes the result available to everything in the request pipeline. Calling `authenticate()` inside handlers bypasses both halves of that design: the principal is invisible to any other middleware or controller that wants it, and every handler re-implements the 401 decision on its own terms (one returns a JSON error, another throws, a third forgets). The route guard (`.authenticated()`, or `.secure('client')` for a named principal) declares the requirement in one place and produces the consistent 401 you see in the integration tests.

### 2. Fail fast at startup

**❌ Wrong**

```typescript
import { createAuthProvider } from 'blendsdk/webafx-auth';

// The fallback defeats the factory's validation: the misconfiguration is
// never raised, and a well-known secret ships to production.
const provider = createAuthProvider({
    type: 'jwt',
    secret: process.env.JWT_SECRET ?? 'change-me',
});
```

**✅ Correct**

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { createAuthPlugin, createAuthProvider } from 'blendsdk/webafx-auth';

const secret = process.env.JWT_SECRET;
if (!secret) {
    throw new Error('JWT_SECRET must be set before the application starts');
}

const app = new WebApplication({
    PORT: 3400,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

// Throws a field-specific error — e.g. "createAuthProvider: type 'jwt'
// requires 'secret'" — instead of failing on the first request.
app.use(createAuthPlugin(createAuthProvider({ type: 'jwt', secret })));
```

**Why:** `createAuthProvider()` validates the fields each provider type requires and throws errors that name the missing field (`"type 'oidc' requires 'issuerUrl'"`, `"type 'introspection' requires 'introspectionUrl', 'clientId' and 'clientSecret', or 'configFactory'"`). A `?? 'change-me'` fallback defeats that validation entirely: the application boots "successfully", and every attacker knows your signing key. Checking environment variables at the top of the configuration module turns a misdeployment into a startup crash that your orchestration and monitoring surface immediately, rather than a stream of runtime 500s.

### 3. Respect the failure contract: `undefined` versus thrown errors

**❌ Wrong**

```typescript fragment
// An introspection outage is reported to the caller as "invalid credentials":
// users retry, monitoring sees an auth-failure spike, and the outage is
// indistinguishable from a credential-stuffing attack.
try {
    const result = await provider.authenticate(req);
    if (result === undefined) {
        res.status(401).json({ success: false, error: { code: 'unauthorized', message: 'Unauthorized' } });
        return;
    }
    // ...
} catch {
    res.status(401).json({ success: false, error: { code: 'unauthorized', message: 'Unauthorized' } });
}
```

**✅ Correct**

```typescript fragment
// undefined means "not authenticated" — no token, invalid token, or expired
// token. That is a normal 401, and the only failure a 401 may represent.
const result = await provider.authenticate(req);
if (result === undefined) {
    res.status(401).json({ success: false, error: { code: 'unauthorized', message: 'Unauthorized' } });
    return;
}

// Infrastructure failures (DNS, timeouts, upstream 5xx, storage errors,
// failing config factories) throw and belong to the application error
// handler as a 5xx — never as a 401.
res.json({ success: true, data: { sub: result.sub } });
```

**Why:** Every `authenticate()`/`validate()` call follows one contract: invalid or expired tokens return `undefined` — silently, because unauthenticated requests are normal (public routes, anonymous traffic) — while thrown errors mean "the answer could not be determined": network failures, timeouts, non-2xx introspection responses, `CacheProvider` failures, and exceptions from per-request `configFactory` calls. Collapsing the thrown case into a 401 tells clients their credentials are wrong while your auth backend is actually down, defeats alerting, and turns an outage into a login-storm. If you need to distinguish "no credentials presented" from "bad credentials", use the public `extractToken(req)` before calling `validate()`.

### 4. Keep one provider instance per application

**❌ Wrong**

```typescript fragment
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

// A provider built per request: discovery and JWKS setup start cold on
// every request, nothing is ever shut down, and no cache is shared.
this.route()
    .get('/orders')
    .handle(async (req, res) => {
        const provider = new OidcAuthProvider(oidcConfig);
        const user = await provider.authenticate(req);
        this.ok(res, { sub: user?.sub });
    });
```

**✅ Correct**

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { oidcAuthPlugin } from 'blendsdk/webafx-auth';

const clientSecret = process.env.OIDC_CLIENT_SECRET;
if (!clientSecret) {
    throw new Error('OIDC_CLIENT_SECRET must be set before the application starts');
}

const app = new WebApplication({
    PORT: 3400,
    ENV_MODE: 'development',
    LOG_LEVEL: 'ERROR',
});

// One provider instance for the whole process. The plugin registers it as a
// singleton and returns health()/shutdown() hooks that delegate to it, so
// WebAFX's shutdown lifecycle releases discovery caches and JWKS state.
app.use(
    oidcAuthPlugin({
        issuerUrl: 'https://auth.example.com',
        clientId: 'web-app',
        clientSecret,
        redirectUri: 'https://app.example.com/api/oidc/callback',
    })
);
```

**Why:** Every provider amortizes real work across requests: the OIDC provider caches discovery results and the remote JWKS resolver per issuer, the introspection provider keeps an LRU cache of validated tokens, and JWT verification caches key material. A provider constructed per request restarts from a cold cache every time — each request pays the discovery or introspection round trip the cache was designed to eliminate — and a provider built outside the plugin lifecycle never receives `shutdown()`, leaking the timers, connections, and caches it holds. The abstract base class is explicitly designed as an application-wide singleton, and the plugin registers it as one (`type: "singleton"` in the registered service) so the whole application shares it.

### 5. Configure the token extraction chain — don't hand-roll extraction

**❌ Wrong**

```typescript fragment
// Rewriting the Authorization header by hand duplicates the extraction
// chain with homemade bugs (encoding, priority, empty values) and mutates
// the request for everything downstream.
app.use((req, _res, next) => {
    const fromCookie = req.cookies?.['access_token'];
    if (fromCookie && !req.headers.authorization) {
        req.headers.authorization = `Bearer ${fromCookie}`;
    }
    next();
});
```

**✅ Correct**

```typescript fragment
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const provider = new JwtAuthProvider({
    secret: secretFromEnvironment,
    // Ordered chain — the first source with a non-empty match wins.
    tokenSources: ['header', 'cookie', 'query'],
    cookieName: 'auth_token',      // default
    queryParamName: 'token',       // default
});
```

**Why:** Token extraction is a first-class part of the provider, not something to bolt on. The chain is built once at construction from `tokenSources`, walked in order, and returns on the first non-empty match — so fallback behavior (header first, cookie for browser clients, query for header-less endpoints) is configuration, not code. Hand-rolled middleware re-implements all of that with its own edge cases, mutates `req.headers` for every downstream consumer, and hides from the next developer where credentials actually come from. Unusual request locations are supported directly with a custom source: `tokenSources: ['header', { extractor: (req) => ... }]`.

### 6. When `configFactory` is configured, use `authenticate(req)` — not `validate(token)`

**❌ Wrong**

```typescript fragment
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';

const provider = new IntrospectionAuthProvider({
    configFactory: async (req) => resolveTenantConfig(req),
});

// validate() has no request, so it cannot resolve tenant credentials:
// every token returns undefined and no HTTP call is ever made. The symptom
// looks like "all tokens are invalid", not like a misconfiguration.
const result = await provider.validate(token);
```

**✅ Correct**

```typescript fragment
// authenticate() threads the request through to the factory, resolves the
// tenant's endpoint/credentials, then validates against them.
const result = await provider.authenticate(req);
```

**Why:** `validate(token)` is the provider-local step — it has no request context, so it cannot call a `configFactory`. With a factory-only configuration it returns `undefined` for every token and never contacts the endpoint (the same applies to the OIDC provider). Because the silent-failure contract makes `undefined` a normal outcome, the misconfiguration masquerades as "everything is rejected" rather than as an error. Any configuration that is resolved per request — tenant credentials, per-issuer OIDC config — can only flow through `authenticate(req)`.

### 7. Validate the audience deliberately

**❌ Wrong**

```typescript fragment
// Signature and issuer checks answer "who signed it" — not "was it meant
// for me". A token minted for any other service of the same issuer passes.
const provider = new JwtAuthProvider({
    secret: secretFromEnvironment,
    issuer: 'https://auth.example.com',
});
```

**✅ Correct**

```typescript fragment
const provider = new JwtAuthProvider({
    secret: secretFromEnvironment,
    issuer: 'https://auth.example.com',
    audience: 'https://api.example.com', // string or string[]
    requireAudience: true,               // fail closed if audience is ever unset
});
```

**Why:** Audience is the check that stops token confusion: a validly signed token issued for a different service — same issuer, same signing key — verifies fine without an `audience` configured, and your API accepts it. Omitting `audience` silently disables that protection. On the JWT and OIDC providers, `requireAudience: true` makes the requirement durable: if the `audience` is missing from configuration, every token is rejected — before discovery, before verification (fail closed, not fail open). The introspection provider validates `audience` against the response's `aud` claim the same way, accepting a string or an array there as well.

### 8. Pin the JWT algorithm set

**❌ Wrong**

```typescript fragment
// The accepted algorithm set is implicit — defined by library defaults
// and subject to change under you during a dependency upgrade.
const provider = new JwtAuthProvider({
    secret: secretFromEnvironment,
    issuer: 'https://auth.example.com',
    audience: 'https://api.example.com',
});
```

**✅ Correct**

```typescript fragment
// The exact algorithm(s) your identity provider signs with — nothing else.
const provider = new JwtAuthProvider({
    secret: secretFromEnvironment,
    algorithms: ['HS256'],
    issuer: 'https://auth.example.com',
    audience: 'https://api.example.com',
});
```

**Why:** The algorithm set is part of your trust boundary. Pinning the exact algorithms that your issuer uses makes the configuration reviewable — a reader sees precisely which tokens can verify — narrows what an attacker can attempt, and forces a conscious, visible change if the issuer ever rotates algorithms. For HS256, remember the secret is the entire security premise: use at least 256 bits (32 bytes) of entropy; short secrets weaken the MAC even with the right algorithm pinned.

### 9. Keep clock tolerance small

**❌ Wrong**

```typescript fragment
// An hour of tolerance turns a one-hour token into a two-hour token and
// gives every expired (or leaked-then-revoked) credential a generous grace
// period even when all clocks are correct.
const provider = new JwtAuthProvider({
    secret: secretFromEnvironment,
    clockTolerance: 3600,
});
```

**✅ Correct**

```typescript fragment
// Tens of seconds of skew compensation — the OIDC provider defaults to 30.
const provider = new JwtAuthProvider({
    secret: secretFromEnvironment,
    clockTolerance: 30,
});
```

**Why:** `clockTolerance` exists for one reason: to absorb clock skew between the issuer and your servers, which is measured in seconds. Every second of tolerance is a second an expired token keeps verifying. If you observe expiration failures in practice, fix the clocks (NTP) — don't widen the tolerance, because that quietly extends the lifetime of every token, including ones you would rather have stopped working. The same tolerance applies to OIDC session expiry checks against `expiresAt`.

### 10. Keep OIDC sessions server-side behind an opaque cookie

**❌ Wrong**

```typescript fragment
import type { OidcSession } from 'blendsdk/webafx-auth';

// A process-local session map: sessions die with the worker, are invisible
// to every other worker behind a load balancer (users appear logged out at
// random), and cannot be centrally revoked on logout.
const sessions = new Map<string, OidcSession>();
```

**✅ Correct**

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';
import type { CacheProvider } from 'blendsdk/webafx-cache';

export function createOidcProvider(sessionStore: CacheProvider): OidcAuthProvider {
    const clientSecret = process.env.OIDC_CLIENT_SECRET;
    if (!clientSecret) {
        throw new Error('OIDC_CLIENT_SECRET must be set before the application starts');
    }

    return new OidcAuthProvider({
        issuerUrl: 'https://auth.example.com',
        clientId: 'web-app',
        clientSecret,
        redirectUri: 'https://app.example.com/api/oidc/callback',
        sessionStore,
    });
}
```

**Why:** The BFF design keeps token material out of the browser entirely. `OidcAuthController` places only two cookies in the browser — a 5-minute state id and an opaque UUID session id, both httpOnly, `sameSite=lax`, and `secure` in production — while tokens live in the shared `CacheProvider`. That makes revocation real (`clearSession` deletes the tokens), and a stolen session id is worthless without the store. A process-local `Map` breaks the moment you run more than one worker and cannot be invalidated centrally. Register the provider through `createAuthPlugin()` so the controller (`getProviderServiceName()` defaults to `'auth'`) resolves it from the service container.

### 11. Give every provider plugin distinct service names

**❌ Wrong**

```typescript fragment
// Both plugins are named "auth:auth": the second app.use() throws
// 'Plugin "auth:auth" is already registered' at startup.
app.use(createAuthPlugin(humanProvider));
app.use(createAuthPlugin(machineProvider));
```

**✅ Correct**

```typescript fragment
// One plugin per principal kind, each with its own singleton service and
// its own per-request principal service.
app.use(
    createAuthPlugin(humanProvider, {
        serviceName: 'user-auth',
        userServiceName: 'user',
    })
);
app.use(
    createAuthPlugin(machineProvider, {
        serviceName: 'client-auth',
        userServiceName: 'client',
    })
);
```

**Why:** Each `createAuthPlugin()` call registers a plugin named `auth:<serviceName>` plus two services — a singleton provider and a per-request principal. With default options, two plugins collide on `auth:auth`, and WebAFX rejects the second registration at startup rather than silently replacing the first provider. Distinct `serviceName`s keep both installed; distinct `userServiceName`s give each principal its own service, which is exactly how a route selects its provider: a human route uses `.authenticated()` (the default `'user'` principal) while a machine route uses `.secure('client')`. Integration tests confirm that a route naming the `client` service rejects a user token with a 401 — and vice versa.

### 12. Use `MemoryAuthProvider` only as a test double

**❌ Wrong**

```typescript fragment
// A production configuration built on the test double: no signature, no
// expiry, no revocation — whoever knows a listed token is authenticated.
app.use(
    memoryAuthPlugin({
        validTokens: {
            'static-token-1': { sub: 'admin-1', claims: { role: 'admin' }, token: 'static-token-1' },
        },
    })
);
```

**✅ Correct**

```typescript fragment
// Real verification in the application...
app.use(jwtAuthPlugin({ secret: secretFromEnvironment }));

// ...and the deterministic double only inside the test suite.
const provider = new MemoryAuthProvider({
    validTokens: { [TEST_TOKEN]: TEST_AUTH_RESULT },
});
```

**Why:** `MemoryAuthProvider.validate()` returns the stored `AuthResult` as-is: there is no signature check, no expiration check, no revocation, and no claims mapping — anyone who learns a token in `validTokens` (or adds one with `addToken`) is fully authenticated, and `shutdown()` wipes the store. That is exactly what a test double should be, and exactly what production must never use. Its value is offline determinism: tests run without an identity provider and still exercise the full extraction → authenticate → principal-service pipeline with real provider objects.

---

## Anti-Patterns

### Assuming `mapClaims` shapes `MemoryAuthProvider` results

`MemoryAuthProvider.validate()` does not run the claims mapper — it returns the stored `AuthResult` object as-is (the only adjustment is `principalType`, filled from config when the stored result does not already carry one). If a test expects a mapped shape, build that shape directly into the fixture instead of configuring `mapClaims`:

```typescript
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const stored: AuthResult = {
    sub: 'user-1',
    claims: { role: 'admin' },
    token: 'test-token',
};

const provider = new MemoryAuthProvider({
    validTokens: { 'test-token': stored },
});

// validate('test-token') returns `stored` — exactly what you put in.
```

### Side effects and silent throws inside `mapClaims`

The claims mapper runs on every successful validation, **including introspection cache hits** — an implementation test asserts the mapper is invoked twice for two validations served by a single HTTP call. A metrics counter or audit write inside the mapper therefore measures validations, not distinct tokens, and its rate shifts with cache hit rate:

```typescript fragment
// ❌ The mapper is not a metrics hook — it also runs for every cache hit.
mapClaims: (token, claims) => {
    validatedTokens.inc(); // counts validations, not tokens
    return { sub: String(claims.sub), claims, token };
},
```

Keep the mapper pure. Also know the failure semantics: a synchronous throw from `mapClaims` is treated as a failed authentication (`undefined`), while a rejection from the async OIDC `resolveUser` propagates as an error. Put fallible I/O in `resolveUser` when you want failures to be visible.

### Expecting the OIDC session path to honor `principalType`

Bearer validation on `OidcAuthProvider` stamps the configured `principalType` (`'user'` or `'client'`). The session-cookie path **always** reports `'user'` — a session is an interactive user session by definition, whatever the provider configuration says. A workflow that must be classified as a client has to present a bearer token; it cannot get there through the login flow.

### Setting `requireAudience: true` without configuring `audience`

This fails closed, and it fails *early*: with no audience configured, every token is rejected before discovery and before signature verification — no JWKS fetch happens, and the symptom is a steady stream of 401s with no verification activity to show for it. Set `audience` first; keep `requireAudience: true` so the check survives future configuration edits (see pair 7).

### Adding a bearer guard in front of the OIDC lifecycle routes

The controller marks only `/api/oidc/me` as secure; `logout` and `refresh` authenticate the session cookie themselves. That is deliberate: a session whose *access token* has expired must still be able to refresh or log out — the exact moment users need those endpoints. A global "everything requires a valid bearer token" middleware in front of them breaks renewal. Keep the controller's route security as shipped.

### Treating token revocation as guaranteed

`handleLogout` performs revocation best-effort: a failing revocation call is swallowed and the endpoint still reports success, because the hard guarantee is server-side session deletion — not token destruction at the authorization server. Don't build compliance flows or audit promises that depend on the IdP having revoked the token.

### Conflating cookie lifetime with session lifetime

`sessionCookieTtl` controls only the browser cookie's `maxAge`; the stored session expires per `sessionTtl`. Setting a large `sessionCookieTtl` without a matching `sessionTtl` produces a cookie that outlives the session it points at: the next request resolves no session and the user is bounced to login holding a valid-looking cookie. If `sessionCookieTtl` is unset, the cookie follows `sessionTtl` — configure both together when you change either.

### Expecting arbitrary `/login` query parameters to reach the IdP

The controller forwards only what it knows: at login, `prompt` and `login_hint` become extra authorization parameters and `returnTo` is stored in session state; on the callback, `iss` is forwarded per RFC 9207. Everything else is dropped — an unrecognized parameter never reaches the authorization URL. To send additional parameters (for example `acr_values`), override the `getLoginParams` hook.

### Expecting tokens in the `/api/oidc/me` response

`/me` returns `{ user, expiresAt }` — tokens never appear in responses, by design. Build the frontend to treat the session as opaque: it asks your backend who it is (`/me`), never where the credentials are. If a browser-side component "needs the access token", the architecture is wrong, not the endpoint.

---

## Performance Tips

### 1. Reuse one provider instance for the whole process

This is the single largest performance decision (see pair 4). Every provider front-loads expensive work into caches — OIDC discovery and JWKS resolvers per issuer, the introspection LRU cache, JWT key material — and that work only amortizes if the instance survives across requests. Never construct a provider in a handler or per-request middleware.

### 2. Match the verification strategy to the token type

Local verification is the cheapest path: `JwtAuthProvider` and the OIDC bearer path verify signatures with cached keys and no per-request network hop. RFC 7662 introspection costs one HTTP round trip per cache miss — that is the inherent price of validating opaque tokens against the authorization server. If you control token issuance, preferring JWTs over introspection is a direct latency and load win; use introspection when tokens must remain opaque or the server must be consulted.

### 3. Tune the introspection cache to your revocation-visibility budget

```typescript fragment
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';

const provider = new IntrospectionAuthProvider({
    introspectionUrl: 'https://auth.example.com/oauth2/introspect',
    clientId: 'api-gateway',
    clientSecret: secretFromEnvironment,
    cacheTTL: 60,          // seconds — how stale a revocation may be
    maxCacheSize: 10_000,  // LRU bound — keep it above the hot working set
    timeout: 2_000,        // ms — fail fast instead of stalling requests
});
```

- Cache hits skip the HTTP round trip entirely — that is what keeps throughput stable under load.
- Entries expire at `cacheTTL` **or** the token's own `exp`, whichever is sooner, so the cache never serves past the token's lifetime.
- Inactive responses and failed requests are **never** cached: a flood of invalid tokens or an upstream outage costs one request per validation attempt and cannot "poison" the cache. Absorb that traffic with rate limiting, not with cache expectations; a longer `cacheTTL` means fewer requests but slower visibility of revocations — pick a TTL that matches your revocation budget.
- `maxCacheSize` bounds memory, and eviction removes the *least recently used* entry — not the oldest inserted — so frequently validated tokens stay cached. Keep the size above your live-token working set to avoid thrash.

### 4. Keep discovery caches warm

The OIDC provider runs discovery once per issuer and caches the result; `discoveryTtl` (seconds) controls re-discovery, and the cache is per issuer, so a multi-tenant deployment pays one discovery per tenant — not per request. Don't set the TTL to zero in production: every expiry means network I/O plus re-establishing JWKS state. Change it only when you need faster reaction to IdP endpoint changes, and prefer the default otherwise.

### 5. Keep the extraction chain short and cheap

The chain returns on the first non-empty match, so order it by your dominant client type — `['header', 'cookie', 'query']` means browser and API traffic both resolve on the first or second probe. Custom `{ extractor }` functions run only for requests where earlier sources miss; keep them pure and allocation-light (no database or HTTP calls), because they sit on the hot path of every unmatched request. Cookie extraction relies on `req.cookies` being populated (cookie-parser, built into WebAFX's core middleware).

### 6. Keep `configFactory` fast and plan per tenant

For dynamic (per-tenant) configuration, the factory runs on every authenticated request — it must, because tenant credentials are resolved before the per-tenant cache lookup. Back it with an in-memory tenant map or a locally cached lookup, never a fresh database round trip per request. Also account for cache isolation: the same token presented under two tenants is two cache entries and two introspection calls on a miss, so size `maxCacheSize` for the sum across tenants.

---

## Security Considerations

- **Hold secrets to cryptographic standards.** An HS256 secret needs at least 256 bits (32 bytes) of entropy; source it from the environment or a secret manager and fail startup when it is missing — never ship a fallback. The factory's error messages name missing *fields*, not their values, so they are safe to log.
- **Never log tokens or secrets.** The providers already keep tokens out of logs and error messages (introspection failures carry the status code, not the token; cache keys are SHA-256 digests, never raw tokens). When you add your own logging, log `result.sub` and status codes — not `result.token`, and not `result.claims` wholesale, which can contain PII.
- **Validate all three identity dimensions.** Pin the signing algorithm (pair 8), require the issuer, and require the audience (`requireAudience: true`, pair 7). Each check rejects a different class of valid-looking token; skipping any one of them is what token-confusion attacks exploit.
- **Keep clock tolerance tight.** Tolerance directly extends the lifetime of expired tokens (pair 9). Seconds, not minutes — and fix clock skew at the source.
- **Protect token transport.** Bearer tokens travel over HTTPS only. Prefer the `"header"` or `"cookie"` sources; the `"query"` source exists for endpoints that cannot set headers (webhook callbacks, email links, SSE), but URLs leak into server logs, browser history, and referrer headers — enable it only where required.
- **Do not bypass the BFF's protocol checks.** `OidcAuthController` enforces PKCE (S256), `state` (CSRF; `invalid_state` on mismatch), and nonce validation, and stores only opaque ids in httpOnly cookies. Don't build a parallel callback handler that skips them. Consider `rotateSessionIdOnRefresh: true` so a stolen cookie id stops resolving after the next refresh, and remember that logout's revocation is best-effort while session deletion is the guarantee.
- **Use the default introspection client authentication unless the server demands otherwise.** `client_secret_basic` keeps credentials out of the request body (where intermediaries are likelier to log them); switch to `authMethod: 'post'` only when the authorization server requires it. Credentials are percent-encoded per RFC 6749 either way.
- **Treat the introspection cache as security-relevant.** Its TTL is your revocation-visibility window (tip 3). Never mirror raw tokens into your own caches or logs — the provider hashes them into digests on purpose.

---

# webafx-auth Testing Patterns

This document describes how to test code that uses `blendsdk/webafx-auth`: consuming providers directly, protecting WebAFX applications with the auth plugin, driving the OIDC BFF controller, and mocking the package's network-facing components. All patterns mirror the package's own suite, which is the source of truth.

---

## Test Setup

### Framework and scripts

The package is tested with Vitest (with `@vitest/coverage-v8` for coverage) and Supertest for in-process HTTP integration tests. There are **no Docker or external service dependencies** — remote behavior (introspection endpoints, OIDC providers) is simulated by stubbing `fetch` or mocking `openid-client`/`jose` at the module level, and integration tests boot a real `WebApplication` in-process.

| Script | Command | Purpose |
| --- | --- | --- |
| `test` | `vitest run --reporter=verbose` | Single verbose run (CI) |
| `test:watch` | `vitest watch --reporter=verbose` | Watch mode during development |
| `test:coverage` | `vitest run --coverage` | Coverage run using the V8 provider |

### Vitest configuration

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html'],
            include: ['src/**/*.ts'],
        },
    },
});
```

### What to import

Consumer tests must import package symbols from the package root (`blendsdk/webafx-auth`) — never from `src/` or `dist/` paths, and never from internal modules. The package's own tests import from `../src/...`; that is an internal privilege, not a pattern to copy.

| Import | From | Used for |
| --- | --- | --- |
| `MemoryAuthProvider`, `JwtAuthProvider`, `IntrospectionAuthProvider`, `OidcAuthProvider`, `AuthProvider` | `blendsdk/webafx-auth` | Providers under test or used as doubles |
| `createAuthPlugin`, `jwtAuthPlugin`, `introspectionAuthPlugin`, `oidcAuthPlugin`, `memoryAuthPlugin` | `blendsdk/webafx-auth` | Plugin registration |
| `createAuthProvider` | `blendsdk/webafx-auth` | Factory tests |
| `OidcAuthController` | `blendsdk/webafx-auth` | BFF controller tests |
| `DEFAULT_SERVICE_NAME`, `DEFAULT_PLUGIN_PRIORITY`, `DEFAULT_COOKIE_NAME`, `DEFAULT_QUERY_PARAM_NAME`, `DEFAULT_TOKEN_SOURCES` | `blendsdk/webafx-auth` | Asserting defaults |
| `AuthResult`, `JwtAuthConfig`, `IntrospectionAuthConfig`, `OidcAuthConfig`, `OidcTokens`, `OidcSession`, `OidcSessionState`, `TokenSource`, `ClaimsMapper`, `AuthFactoryConfig` | `blendsdk/webafx-auth` | Fixtures and typed configs |
| `SignJWT` | `jose` | Signing *real* test JWTs |
| `WebApplication`, `BaseController`, `RouteDefinition` | `blendsdk/webafx` | Integration apps |
| `supertest` | `supertest` | HTTP assertions against `app.express` |
| `CacheProvider` | `blendsdk/webafx-cache` | Session-store doubles |

When your test files `import * as jose from 'jose'` or `import * as client from 'openid-client'` for module mocks, declare `jose` and `openid-client` as devDependencies in your project as well — do not rely on hoisting from the peer tree (strict package managers will fail).

A tip the package itself relies on: **Vitest does not type-check tests at runtime**. Keep the compiler honest by running `npx tsc --noEmit` against a tsconfig that includes `tests/**` in CI, separate from your build.

### Shared request and JWT helpers

`tests/test-helpers.ts` — request doubles, real JWT signing, and fixtures. Copy this into your suite as-is:

```typescript
/**
 * Shared helpers for tests that exercise blendsdk/webafx-auth.
 *
 * Adapted from the package's own tests/test-helpers.ts:
 * - Mock Express request factory (headers / cookies / query)
 * - Real JWT signing with jose (no mocked cryptography)
 * - AuthResult fixtures
 * - fetch() Response doubles and OIDC fixtures
 */

import { SignJWT } from 'jose';
import type { Request } from 'express';
import type { AuthResult, OidcAuthConfig } from 'blendsdk/webafx-auth';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

/** HMAC secret used across all JWT tests (32+ bytes for HS256). */
export const TEST_SECRET = 'test-secret-that-is-at-least-256-bits-long!!';

/** Issuer claim value used in JWT tests. */
export const TEST_ISSUER = 'https://auth.test.example.com';

/** Audience claim value used in JWT tests. */
export const TEST_AUDIENCE = 'test-client-id';

// ---------------------------------------------------------------------------
// Mock request factory
// ---------------------------------------------------------------------------

/** Options for creating a mock Express request. */
export interface MockRequestOptions {
    /** Authorization header value (e.g. 'Bearer <token>'). */
    authorization?: string;
    /** Additional headers beyond Authorization. */
    headers?: Record<string, string>;
    /** Cookie values (simulates cookie-parser middleware). */
    cookies?: Record<string, string>;
    /** Query parameters. */
    query?: Record<string, string>;
}

/**
 * Draft shape for the request double: a Partial<Request> plus the
 * cookie-parser-populated `cookies` bag (which is not on the base
 * Express type). The final cast is a narrowing assertion — `Request`
 * is assignable to this draft, so the assertion is type-safe.
 */
type RequestDraft = Partial<Request> & { cookies?: Record<string, string> };

/**
 * Create a minimal mock Express request for testing token extraction.
 *
 * Only the properties the AuthProvider extraction chain reads are set:
 * `headers`, `cookies`, and `query`.
 */
export function createMockRequest(options: MockRequestOptions = {}): Request {
    const headers: Record<string, string | undefined> = { ...options.headers };
    if (options.authorization !== undefined) {
        headers.authorization = options.authorization;
    }

    const draft: RequestDraft = {
        headers,
        query: options.query ?? {},
    };
    if (options.cookies !== undefined) {
        draft.cookies = options.cookies;
    }

    return draft as Request;
}

/** Create a mock request with a Bearer token in the Authorization header. */
export function createBearerRequest(token: string): Request {
    return createMockRequest({ authorization: `Bearer ${token}` });
}

/** Create a mock request with a token in a cookie (default name: auth_token). */
export function createCookieRequest(token: string, cookieName = 'auth_token'): Request {
    return createMockRequest({ cookies: { [cookieName]: token } });
}

/** Create a mock request with a token in a query parameter (default: token). */
export function createQueryRequest(token: string, paramName = 'token'): Request {
    return createMockRequest({ query: { [paramName]: token } });
}

// ---------------------------------------------------------------------------
// JWT signing helpers
// ---------------------------------------------------------------------------

/** Options for creating a signed test JWT. */
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

/**
 * Create a cryptographically valid JWT for testing.
 *
 * Uses jose's SignJWT so providers verify real signatures — tests
 * validate real JWT processing, not mocked behavior.
 */
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

/** Create a signed JWT that expired one hour ago. */
export async function signExpiredJwt(options: SignJwtOptions = {}): Promise<string> {
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    return signTestJwt({ ...options, exp: oneHourAgo });
}

// ---------------------------------------------------------------------------
// AuthResult fixtures
// ---------------------------------------------------------------------------

/** Create a standard test AuthResult with sensible defaults. */
export function createTestAuthResult(overrides: Partial<AuthResult> = {}): AuthResult {
    return {
        sub: 'test-user-1',
        claims: { role: 'user' },
        token: 'test-token-1',
        ...overrides,
    };
}

/** Pre-built admin auth result for multi-role scenarios. */
export const ADMIN_AUTH_RESULT: AuthResult = {
    sub: 'admin-1',
    claims: { role: 'admin', permissions: ['read', 'write', 'delete'] },
    token: 'admin-token',
    scopes: ['admin'],
};

/** Pre-built regular user auth result for multi-role scenarios. */
export const USER_AUTH_RESULT: AuthResult = {
    sub: 'user-1',
    claims: { role: 'user', permissions: ['read'] },
    token: 'user-token',
    scopes: ['read'],
};

// ---------------------------------------------------------------------------
// fetch / Response doubles
// ---------------------------------------------------------------------------

/**
 * Build a minimal fetch Response stand-in.
 *
 * Only the members the introspection provider reads are implemented:
 * `ok`, `status`, and `json`.
 */
export function jsonResponse(body: unknown, status = 200): Response {
    const draft: Partial<Response> = {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    };
    return draft as Response;
}

/** Shape of an openid-client token-endpoint response for BFF tests. */
export interface MockTokenResponse {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
    id_token?: string;
    scope?: string;
}

/** Create a mock openid-client token response. */
export function createMockTokenResponse(
    overrides: Partial<MockTokenResponse> = {}
): MockTokenResponse {
    return {
        access_token: 'mock-access-token',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'mock-refresh-token',
        id_token: 'mock-id-token',
        scope: 'openid profile email',
        ...overrides,
    };
}

/** Create a mock OIDC configuration for BFF and multi-tenant tests. */
export function createMockOidcConfig(overrides: Partial<OidcAuthConfig> = {}): OidcAuthConfig {
    return {
        serviceName: 'oidc-test',
        issuerUrl: 'https://auth.example.com',
        clientId: 'test-client',
        ...overrides,
    };
}
```

> Note on ESM: the examples import helpers as `./test-helpers.js` (the package's NodeNext convention). If your tsconfig uses classic resolution, drop the `.js` extension consistently.

### Cache and session helpers

`tests/cache-test-helpers.ts` — an in-memory `CacheProvider` double for OIDC session tests, plus the `OidcSession` fixture:

```typescript
/**
 * CacheProvider and OidcSession doubles for testing the OIDC
 * session-store path of blendsdk/webafx-auth.
 */

import { vi } from 'vitest';
import type { CacheProvider } from 'blendsdk/webafx-cache';
import type { OidcSession } from 'blendsdk/webafx-auth';

/** Entry stored in the in-memory cache map. */
export interface MockCacheEntry {
    value: unknown;
    expiresAt: number;
}

/**
 * Create a mock CacheProvider backed by an in-memory Map.
 *
 * Provides vitest spies on get/set/delete so tests can assert calls.
 * The backing Map is returned for direct seeding and inspection.
 */
export function createMockCacheProvider(): {
    provider: CacheProvider;
    store: Map<string, MockCacheEntry>;
} {
    const store = new Map<string, MockCacheEntry>();

    const partial: Partial<CacheProvider> = {
        get: vi.fn(async <T>(key: string): Promise<T | undefined> => {
            const entry = store.get(key);
            if (!entry) {
                return undefined;
            }
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
        clear: vi.fn(async (): Promise<void> => {
            store.clear();
        }),
        health: vi.fn(async (): Promise<boolean> => true),
        shutdown: vi.fn(async (): Promise<void> => {
            // no-op
        }),
    };

    return { provider: partial as CacheProvider, store };
}

/** Create a sample OidcSession with sensible test defaults. */
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

### Plugin harness helpers

`tests/plugin-harness.ts` — exercises plugin *definitions* (the value returned by `createAuthPlugin()` and the convenience factories) without booting an application:

```typescript
/**
 * Harness for exercising WebAFX plugin definitions without starting an
 * application: a mock app that captures registerService() calls, a mock
 * logger, and a helper that invokes a plugin factory.
 */

import { vi } from 'vitest';

/** A service registration captured from `app.registerService()`. */
export interface RegisteredService {
    name: string;
    type: string;
    factory: (...args: unknown[]) => unknown;
}

/** The subset of the plugin result these helpers interact with. */
export interface PluginInstanceLike {
    health(): Promise<boolean>;
    shutdown(): Promise<void>;
}

/** The subset of a PluginDefinition these helpers interact with. */
export interface PluginLike {
    name: string;
    priority: number;
    factory(params: {
        app: unknown;
        express: unknown;
        logger: unknown;
    }): Promise<PluginInstanceLike>;
}

/** Mock WebApplication that records service registrations. */
export function createMockApp() {
    const registeredServices: RegisteredService[] = [];

    const app = {
        registerService: vi.fn((definition: RegisteredService): void => {
            registeredServices.push(definition);
        }),
    };

    return { app, registeredServices };
}

/** Mock Logger with vitest spies on all log methods. */
export function createMockLogger() {
    return {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    };
}

/** Execute a plugin factory with mocks and return all captured state. */
export async function executePluginFactory(plugin: PluginLike) {
    const { app, registeredServices } = createMockApp();
    const logger = createMockLogger();

    const result = await plugin.factory({ app, express: {}, logger });

    return { app, registeredServices, logger, result };
}
```

### Suite conventions

The package organizes tests into three file kinds. Adopt the same split in your own suite:

| File pattern | Meaning | Example |
| --- | --- | --- |
| `*.spec.test.ts` | Specification tests — expectations derived from requirements, not the implementation. A failing case means the implementation is wrong. | `auth-plugin.spec.test.ts` |
| `*.impl.test.ts` | Implementation tests — edge cases, internals, exact error messages. These may change when internals change. | `introspection-auth-provider.impl.test.ts` |
| `*.test.ts` | Focused feature suites. | `jwt-auth-provider.test.ts`, `token-extraction.test.ts` |

Two rules that keep the suite reliable:

- **Isolate module-mocked files.** A file that calls `vi.mock('jose', ...)` or `vi.mock('openid-client', ...)` affects the entire file. Keep the real-cryptography tests (which use actual `jose` signing) in a *different* file than the tests that mock `jose`. The package does exactly this with its principal-discriminator tests.
- **Clean up in `afterEach`.** Always restore what you stubbed: `vi.unstubAllGlobals()`, `vi.restoreAllMocks()`, `vi.useRealTimers()`, and `await provider.shutdown()` for real provider instances that hold resources.

---

## Unit Testing

### Testing providers directly

Providers are plain classes operating on an Express `Request` — no WebAFX runtime required. The `MemoryAuthProvider` is the package's designed test double: deterministic, synchronous storage, no network. Use it as the default whenever the *authentication outcome* is not what you are testing.

```typescript
import { describe, it, expect } from 'vitest';
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';
import { createBearerRequest, createTestAuthResult } from './test-helpers.js';

describe('MemoryAuthProvider', () => {
    it('returns the stored result for a known token', async () => {
        const provider = new MemoryAuthProvider({
            validTokens: {
                'valid-token': createTestAuthResult({ sub: 'test-user-1' }),
            },
        });

        const result = await provider.validate('valid-token');

        expect(result).toBeDefined();
        expect(result?.sub).toBe('test-user-1');
    });

    it('returns undefined for an unknown token', async () => {
        const provider = new MemoryAuthProvider();

        await expect(provider.validate('unknown-token')).resolves.toBeUndefined();
    });

    it('authenticates a request end to end', async () => {
        const provider = new MemoryAuthProvider({
            validTokens: { 'valid-token': createTestAuthResult() },
        });

        const result = await provider.authenticate(createBearerRequest('valid-token'));

        expect(result?.sub).toBe('test-user-1');
    });
});
```

### Synchronous assertion patterns

Token extraction and construction validation are synchronous. Assert them with `expect(() => ...)` and direct value checks — never `await` a sync path:

```typescript
import { describe, it, expect } from 'vitest';
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { TokenSource } from 'blendsdk/webafx-auth';
import { createBearerRequest, createMockRequest } from './test-helpers.js';

describe('synchronous patterns', () => {
    it('extracts the token synchronously', () => {
        const provider = new MemoryAuthProvider({ tokenSources: ['header'] });

        const token = provider.extractToken(createBearerRequest('my-token-123'));

        expect(token).toBe('my-token-123');
    });

    it('throws for an unknown token source at construction time', () => {
        expect(
            () =>
                new MemoryAuthProvider({
                    tokenSources: ['invalid-source' as TokenSource],
                })
        ).toThrow('Unknown token source');
    });

    it('returns undefined for a malformed Authorization header', () => {
        const provider = new MemoryAuthProvider({ tokenSources: ['header'] });
        const req = createMockRequest({ authorization: 'Basic dXNlcjpwYXNz' });

        expect(provider.extractToken(req)).toBeUndefined();
    });
});
```

### Asynchronous assertion patterns

Every `validate()` / `authenticate()` path is async. Use `resolves` / `rejects` matchers so failures carry a clear message, and remember the silent-failure contract: invalid tokens resolve to `undefined`, while infrastructure errors reject.

```typescript
import { describe, it, expect } from 'vitest';
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';

describe('asynchronous patterns', () => {
    it('resolves to undefined for invalid credentials (silent failure)', async () => {
        const provider = new MemoryAuthProvider();

        await expect(provider.validate('nope')).resolves.toBeUndefined();
    });

    it('rejects only on infrastructure failures', async () => {
        // Introspection against an unreachable endpoint rejects; it does not
        // resolve to undefined. This distinction drives your 401 vs 500 handling.
        // See the Introspection provider section for the fetch-stub setup.
        // (Assertion shape:)
        // await expect(provider.validate(token)).rejects.toThrow('ECONNREFUSED');
    });
});
```

> The commented assertion above is a placeholder for context, not a runnable example — the full runnable version appears in [Testing patterns by feature → Introspection provider](#introspection-provider).

### Sign real tokens instead of mocking cryptography

Do not mock `jose`'s `jwtVerify` when you are testing *your* code against the JWT provider — sign a real token instead. This proves the full verification pipeline (signature, `exp`, `iss`, `aud`, algorithm) and keeps the test honest:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';
import {
    TEST_SECRET,
    TEST_ISSUER,
    TEST_AUDIENCE,
    signTestJwt,
    signExpiredJwt,
} from './test-helpers.js';

describe('JwtAuthProvider with real signatures', () => {
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

    it('validates a correctly signed JWT', async () => {
        const token = await signTestJwt();

        const result = await provider.validate(token);

        expect(result).toBeDefined();
        expect(result?.sub).toBe('test-user-1');
        expect(result?.token).toBe(token);
    });

    it('rejects an expired token', async () => {
        const token = await signExpiredJwt();

        await expect(provider.validate(token)).resolves.toBeUndefined();
    });

    it('rejects a token signed with a different secret', async () => {
        const token = await signTestJwt({
            secret: 'wrong-secret-that-is-also-at-least-256-bits!!',
        });

        await expect(provider.validate(token)).resolves.toBeUndefined();
    });

    it('rejects a malformed token string', async () => {
        await expect(provider.validate('not-a-jwt')).resolves.toBeUndefined();
        await expect(provider.validate('')).resolves.toBeUndefined();
    });
});
```

### Testing the provider factory

`createAuthProvider()` is fully synchronous: assert instance dispatch with `toBeInstanceOf` and required-field validation with exact error messages. Error-message assertions are implementation tests — they pin the diagnostic text, which is what you want for startup misconfiguration.

```typescript
import { describe, it, expect } from 'vitest';
import {
    createAuthProvider,
    IntrospectionAuthProvider,
    JwtAuthProvider,
    MemoryAuthProvider,
    OidcAuthProvider,
} from 'blendsdk/webafx-auth';
import type { AuthFactoryConfig } from 'blendsdk/webafx-auth';

describe('createAuthProvider', () => {
    it('returns a JwtAuthProvider when a secret is provided', () => {
        const provider = createAuthProvider({
            type: 'jwt',
            secret: 'a-secret-that-is-long-enough-for-hs256',
        });

        expect(provider).toBeInstanceOf(JwtAuthProvider);
    });

    it('returns an IntrospectionAuthProvider for static credentials', () => {
        const provider = createAuthProvider({
            type: 'introspection',
            introspectionUrl: 'https://auth.example.com/introspect',
            clientId: 'client',
            clientSecret: 'secret',
        });

        expect(provider).toBeInstanceOf(IntrospectionAuthProvider);
    });

    it('returns an OidcAuthProvider when an issuerUrl is provided', () => {
        const provider = createAuthProvider({
            type: 'oidc',
            issuerUrl: 'https://auth.example.com',
            clientId: 'client',
        });

        expect(provider).toBeInstanceOf(OidcAuthProvider);
    });

    it('returns a MemoryAuthProvider', () => {
        expect(createAuthProvider({ type: 'memory' })).toBeInstanceOf(MemoryAuthProvider);
    });

    it('supports an introspection configFactory', () => {
        const config: AuthFactoryConfig = {
            type: 'introspection',
            configFactory: async () => ({
                introspectionUrl: 'https://auth.example.com/introspect',
                clientId: 'client',
                clientSecret: 'secret',
            }),
        };

        expect(createAuthProvider(config)).toBeInstanceOf(IntrospectionAuthProvider);
    });

    it('throws a field-specific message when jwt has no secret', () => {
        expect(() => createAuthProvider({ type: 'jwt' })).toThrow(
            "createAuthProvider: type 'jwt' requires 'secret'"
        );
    });

    it('throws a field-specific message when oidc has no issuerUrl', () => {
        expect(() => createAuthProvider({ type: 'oidc' })).toThrow(
            "createAuthProvider: type 'oidc' requires 'issuerUrl'"
        );
    });

    it('throws a field-specific message when introspection has no credentials', () => {
        expect(() => createAuthProvider({ type: 'introspection' })).toThrow(
            "createAuthProvider: type 'introspection' requires 'introspectionUrl', 'clientId' and 'clientSecret', or 'configFactory'"
        );
    });
});
```

### Testing plugin definitions without booting an application

The plugin *definition* (`name`, `priority`, `factory`) is a plain value. Execute its factory against the mock app from the harness to verify service registration and delegation:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    createAuthPlugin,
    MemoryAuthProvider,
    DEFAULT_SERVICE_NAME,
    DEFAULT_PLUGIN_PRIORITY,
} from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';
import { createBearerRequest, createMockRequest } from './test-helpers.js';
import { executePluginFactory } from './plugin-harness.js';

/** Known test token for the MemoryAuthProvider. */
const TEST_TOKEN = 'valid-test-token';

/** AuthResult returned for TEST_TOKEN. */
const TEST_AUTH_RESULT: AuthResult = {
    sub: 'user-1',
    claims: { role: 'user' },
    token: TEST_TOKEN,
};

describe('createAuthPlugin', () => {
    let provider: MemoryAuthProvider;

    beforeEach(() => {
        provider = new MemoryAuthProvider({
            validTokens: { [TEST_TOKEN]: TEST_AUTH_RESULT },
        });
    });

    it('names the plugin auth:<serviceName> with the default priority', () => {
        const plugin = createAuthPlugin(provider);

        expect(plugin.name).toBe(`auth:${DEFAULT_SERVICE_NAME}`);
        expect(plugin.name).toBe('auth:auth');
        expect(plugin.priority).toBe(DEFAULT_PLUGIN_PRIORITY);
        expect(typeof plugin.factory).toBe('function');
    });

    it('registers a singleton provider and a per-request user service', async () => {
        const plugin = createAuthPlugin(provider);
        const { app, registeredServices } = await executePluginFactory(plugin);

        expect(app.registerService).toHaveBeenCalledTimes(2);

        const authService = registeredServices.find((s) => s.name === 'auth');
        expect(authService).toBeDefined();
        expect(authService?.type).toBe('singleton');

        const userService = registeredServices.find((s) => s.name === 'user');
        expect(userService).toBeDefined();
        expect(userService?.type).toBe('per-request');
    });

    it('delegates the per-request factory to provider.authenticate()', async () => {
        const plugin = createAuthPlugin(provider, { userServiceName: 'alt-user' });
        const { registeredServices } = await executePluginFactory(plugin);

        const userService = registeredServices.find((s) => s.name === 'alt-user');
        expect(userService).toBeDefined();

        const result = await userService?.factory(
            {}, // container
            {}, // settings
            createBearerRequest(TEST_TOKEN),
            {}, // res
            () => {} // next
        );

        expect(result).toEqual(TEST_AUTH_RESULT);
    });

    it('returns undefined through the per-request factory without credentials', async () => {
        const plugin = createAuthPlugin(provider);
        const { registeredServices } = await executePluginFactory(plugin);

        const userService = registeredServices.find((s) => s.name === 'user');

        const result = await userService?.factory(
            {},
            {},
            createMockRequest(), // no token anywhere
            {},
            () => {}
        );

        expect(result).toBeUndefined();
    });

    it('delegates health() and shutdown() to the provider', async () => {
        const plugin = createAuthPlugin(provider);
        const healthSpy = vi.spyOn(provider, 'health');
        const shutdownSpy = vi.spyOn(provider, 'shutdown');

        const { result } = await executePluginFactory(plugin);

        healthSpy.mockResolvedValueOnce(true);
        await expect(result.health()).resolves.toBe(true);
        expect(healthSpy).toHaveBeenCalled();

        shutdownSpy.mockResolvedValueOnce(undefined);
        await result.shutdown();
        expect(shutdownSpy).toHaveBeenCalled();
    });
});
```

---

## Integration Testing

### Booting a real WebApplication with Supertest

Integration tests use the *real* `WebApplication`, the real auth plugin, and a `MemoryAuthProvider` for deterministic principals. Two details make this fast and hermetic:

- `PORT: 0` — bind no meaningful port; Supertest drives `app.express` directly in-process.
- `app.start()` returns a shutdown function — capture it and call it in `afterEach` so application lifecycles never leak between tests.

```typescript
import { describe, test, expect, afterEach } from 'vitest';
import supertest from 'supertest';
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import { createAuthPlugin, MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

/** Token accepted by the app's auth provider. */
const ACCESS_TOKEN = 'valid-access-token';

/** Principal returned for ACCESS_TOKEN. */
const AUTH_RESULT: AuthResult = {
    sub: 'user-1',
    claims: { role: 'user' },
    token: ACCESS_TOKEN,
};

/** Protected route reading the principal from the per-request service. */
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

describe('protected route — integration', () => {
    let shutdown: (() => Promise<void>) | null = null;

    afterEach(async () => {
        if (shutdown) {
            await shutdown();
            shutdown = null;
        }
    });

    function createTestApp(): WebApplication {
        const app = new WebApplication({
            PORT: 0,
            ENV_MODE: 'test',
            LOG_LEVEL: 'ERROR',
        });

        app.use(
            createAuthPlugin(
                new MemoryAuthProvider({ validTokens: { [ACCESS_TOKEN]: AUTH_RESULT } })
            )
        );

        app.registerController('', ProfileController);
        return app;
    }

    test('accepts a request with a valid bearer token', async () => {
        const app = createTestApp();
        shutdown = await app.start();

        const res = await supertest(app.express)
            .get('/profile')
            .set('Authorization', `Bearer ${ACCESS_TOKEN}`)
            .expect(200);

        expect(res.body.data).toEqual({ sub: 'user-1' });
    });

    test('rejects a request without credentials', async () => {
        const app = createTestApp();
        shutdown = await app.start();

        await supertest(app.express).get('/profile').expect(401);
    });
});
```

### Two providers in one application

The motivating scenario for `principalType` and `userServiceName`: one application authenticating human users and machine clients through separate providers. Each plugin must use a distinct `serviceName` (plugin names collide otherwise) and its own `userServiceName`; a route selects its provider by naming the principal service via `.secure('client')`.

```typescript
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

/** Principal returned for USER_TOKEN. */
const USER_RESULT: AuthResult = { sub: 'user-1', claims: { kind: 'user' }, token: USER_TOKEN };

/** Principal returned for CLIENT_TOKEN. */
const CLIENT_RESULT: AuthResult = { sub: 'client-1', claims: { kind: 'client' }, token: CLIENT_TOKEN };

/** One controller with a human route and a machine route. */
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

describe('multiple auth providers — integration', () => {
    let shutdown: (() => Promise<void>) | null = null;

    afterEach(async () => {
        if (shutdown) {
            await shutdown();
            shutdown = null;
        }
    });

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

    test('the client route accepts the client token', async () => {
        const app = createTestApp();
        shutdown = await app.start();

        const res = await supertest(app.express)
            .get('/mp/client')
            .set('Authorization', `Bearer ${CLIENT_TOKEN}`)
            .expect(200);

        expect(res.body.data).toEqual({ sub: 'client-1' });
    });

    test('the client route rejects the user token', async () => {
        const app = createTestApp();
        shutdown = await app.start();

        await supertest(app.express)
            .get('/mp/client')
            .set('Authorization', `Bearer ${USER_TOKEN}`)
            .expect(401);
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

### Misconfiguration fails at startup

Two auth plugins with the default service name would silently replace each other at runtime. The plugin registry rejects the duplicate name at `app.use()` time — assert that, because it is the behavior that protects production:

```typescript
import { describe, it, expect } from 'vitest';
import { WebApplication } from 'blendsdk/webafx';
import { createAuthPlugin, MemoryAuthProvider } from 'blendsdk/webafx-auth';

describe('plugin name collision — integration', () => {
    it('rejects a second auth plugin that uses the default service name', () => {
        const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });

        app.use(createAuthPlugin(new MemoryAuthProvider()));

        expect(() => app.use(createAuthPlugin(new MemoryAuthProvider()))).toThrow(
            'Plugin "auth:auth" is already registered'
        );
    });
});
```

### No Docker required

There is no containerized infrastructure in this package's test suite, and consumer tests of this package do not need any either:

- The **introspection endpoint** is simulated with `vi.stubGlobal('fetch', ...)` — assertions run against the captured request shape and call counts.
- The **OIDC provider** is simulated with file-scoped `vi.mock()` calls for `openid-client` and `jose`.
- **OIDC sessions** are backed by the in-memory `CacheProvider` double (`createMockCacheProvider()`).
- **Integration tests** boot the real `WebApplication` in-process through Supertest; nothing listens on a real port.

---

## Mocking & Stubbing

### Stubbing global fetch for introspection

`IntrospectionAuthProvider` talks to its endpoint through global `fetch`. Stub it per test file, capture the calls, and restore the global in `afterEach`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';
import type { IntrospectionAuthConfig } from 'blendsdk/webafx-auth';
import { jsonResponse } from './test-helpers.js';

/** Static config shared by the test file. */
export const STATIC_CONFIG: IntrospectionAuthConfig = {
    introspectionUrl: 'https://auth.example.com/oauth2/introspect',
    clientId: 'client-1',
    clientSecret: 'secret-1',
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('IntrospectionAuthProvider request shape', () => {
    it('POSTs the token as form data and authenticates with Basic credentials', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ active: true }));

        const provider = new IntrospectionAuthProvider(STATIC_CONFIG);
        await provider.validate('opaque-token');

        expect(fetchMock).toHaveBeenCalledWith(
            STATIC_CONFIG.introspectionUrl,
            expect.objectContaining({ method: 'POST' })
        );

        const init: RequestInit = fetchMock.mock.calls[0][1];
        const body = new URLSearchParams(String(init.body));
        expect(body.get('token')).toBe('opaque-token');
        expect(body.get('token_type_hint')).toBe('access_token');

        const headers: Record<string, string> = init.headers as Record<string, string>;
        expect(headers.Authorization).toMatch(/^Basic /);
        expect(body.get('client_secret')).toBeNull();
    });

    it('sends credentials in the body for client_secret_post', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ active: true }));

        const provider = new IntrospectionAuthProvider({
            ...STATIC_CONFIG,
            authMethod: 'post',
        });
        await provider.validate('opaque-token');

        const init: RequestInit = fetchMock.mock.calls[0][1];
        const body = new URLSearchParams(String(init.body));
        expect(body.get('client_id')).toBe('client-1');
        expect(body.get('client_secret')).toBe('secret-1');
    });

    it('propagates a network failure instead of resolving to undefined', async () => {
        const networkError = new Error('ECONNREFUSED');
        fetchMock.mockRejectedValue(networkError);

        const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

        // Infrastructure errors reject — they are not a 401.
        await expect(provider.validate('opaque-token')).rejects.toBe(networkError);
    });
});
```

### CacheProvider double for session stores

`OidcAuthProvider`'s session path takes a `CacheProvider`. Use the Map-backed double from `tests/cache-test-helpers.ts` — it gives you spy assertions (`provider.set` was called with which TTL) and direct seeding (`store.set(...)`) without Redis:

```typescript
import { describe, it, expect } from 'vitest';
import { OidcAuthProvider } from 'blendsdk/webafx-auth';
import { createMockCacheProvider, createSampleSession } from './cache-test-helpers.js';

describe('OidcAuthProvider session store wiring', () => {
    it('stores sessions under the oidc:session: prefix with the default TTL', async () => {
        const { provider: sessionStore } = createMockCacheProvider();

        const provider = new OidcAuthProvider({
            issuerUrl: 'https://auth.example.com',
            clientId: 'test-client',
            sessionStore,
        });

        const session = createSampleSession();
        await provider.storeSession('sess-1', session);

        expect(sessionStore.set).toHaveBeenCalledWith('oidc:session:sess-1', session, 3600);
    });

    it('throws when session operations are used without a sessionStore', async () => {
        const provider = new OidcAuthProvider({
            issuerUrl: 'https://auth.example.com',
            clientId: 'test-client',
        });

        await expect(provider.storeSession('sess-1', createSampleSession())).rejects.toThrow(
            'sessionStore is required'
        );
    });
});
```

### Mock provider and response double for OidcAuthController

Controller tests need two doubles: a provider double injected through the `getProvider()` hook, and an Express response double that captures status codes, cookies, and JSON bodies. Put both in `tests/oidc-test-helpers.ts`:

```typescript
/**
 * Doubles for testing OidcAuthController subclasses:
 * - a structural OidcAuthProvider double with real Maps for session/state
 * - a controller settings double
 * - an Express response double that records what the controller wrote
 */

import { vi } from 'vitest';
import type { CookieOptions, Response } from 'express';
import type { OidcAuthProvider, OidcSession, OidcSessionState } from 'blendsdk/webafx-auth';

// ---------------------------------------------------------------------------
// Provider double
// ---------------------------------------------------------------------------

/**
 * Build a structural OidcAuthProvider double.
 *
 * Session and state CRUD is backed by real Maps so multi-step flows
 * (login -> callback -> me) work naturally; BFF methods are spies with
 * resolved values. `rotateSessionIdOnRefresh` controls the rotation hook.
 */
export function createMockOidcProvider(
    options: { rotateSessionIdOnRefresh?: boolean } = {}
): {
    provider: Partial<OidcAuthProvider>;
    sessions: Map<string, OidcSession>;
    states: Map<string, OidcSessionState>;
} {
    const sessions = new Map<string, OidcSession>();
    const states = new Map<string, OidcSessionState>();

    const provider: Partial<OidcAuthProvider> = {
        buildAuthorizationUrl: vi.fn().mockResolvedValue({
            url: 'https://auth.example.com/authorize?client_id=test',
            codeVerifier: 'mock-verifier',
            state: 'mock-state',
            nonce: 'mock-nonce',
        }),
        exchangeCode: vi.fn().mockResolvedValue({
            accessToken: 'mock-access-token',
            refreshToken: 'mock-refresh-token',
            idToken: 'mock-id-token',
            expiresIn: 3600,
            tokenType: 'Bearer',
            scope: 'openid profile email',
        }),
        refreshToken: vi.fn().mockResolvedValue({
            accessToken: 'new-access-token',
            refreshToken: 'new-refresh-token',
            expiresIn: 3600,
            tokenType: 'Bearer',
        }),
        revokeToken: vi.fn().mockResolvedValue(undefined),
        fetchUserInfo: vi.fn().mockResolvedValue({
            sub: 'user-123',
            email: 'user@example.com',
            name: 'Test User',
        }),
        storeSession: vi.fn(async (id: string, session: OidcSession): Promise<void> => {
            sessions.set(id, session);
        }),
        getSession: vi.fn(async (id: string): Promise<OidcSession | undefined> => sessions.get(id)),
        clearSession: vi.fn(async (id: string): Promise<void> => {
            sessions.delete(id);
        }),
        storeState: vi.fn(async (id: string, state: OidcSessionState): Promise<void> => {
            states.set(id, state);
        }),
        getState: vi.fn(async (id: string): Promise<OidcSessionState | undefined> => states.get(id)),
        clearState: vi.fn(async (id: string): Promise<void> => {
            states.delete(id);
        }),
        getSessionCookieName: vi.fn().mockReturnValue('__oidc_session'),
        getStateCookieName: vi.fn().mockReturnValue('__oidc_state'),
        getSessionCookieTtl: vi.fn().mockReturnValue(3600),
        shouldRotateSessionIdOnRefresh: vi.fn().mockReturnValue(options.rotateSessionIdOnRefresh ?? false),
        getRedirectUri: vi.fn().mockReturnValue('https://app.example.com/api/oidc/callback'),
    };

    return { provider, sessions, states };
}

// ---------------------------------------------------------------------------
// Settings double
// ---------------------------------------------------------------------------

/** The ApplicationSettings members the controller reads. */
export interface MockSettings {
    isProduction(): boolean;
    get(key: string, defaultValue?: unknown): unknown;
}

/** Create a settings double; production mode flips cookie `secure`. */
export function createMockSettings(
    envMode: 'development' | 'production' = 'development'
): MockSettings {
    return {
        isProduction: (): boolean => envMode === 'production',
        get: (key: string, defaultValue?: unknown): unknown => {
            if (key === 'ENV_MODE') {
                return envMode;
            }
            return defaultValue;
        },
    };
}

// ---------------------------------------------------------------------------
// Response double
// ---------------------------------------------------------------------------

/** JSON body captured from `res.json()`. */
export interface ApiBody {
    success: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
}

/** Express response double that records what the controller wrote. */
export interface MockResponse extends Response {
    _status: number;
    _json?: ApiBody;
    _redirect?: string;
    _cookies: Record<string, { value: string; options: CookieOptions }>;
    _clearedCookies: string[];
}

/** Create a response double with tracking fields and chaining methods. */
export function createMockRes(): MockResponse {
    const res: Partial<MockResponse> = {
        _status: 200,
        _cookies: {},
        _clearedCookies: [],
    };

    res.status = (code: number): MockResponse => {
        res._status = code;
        return res as MockResponse;
    };

    res.json = (body?: ApiBody): MockResponse => {
        res._json = body;
        return res as MockResponse;
    };

    res.redirect = (url: string): void => {
        res._redirect = url;
    };

    res.cookie = (name: string, value: string, options?: CookieOptions): MockResponse => {
        const cookies = res._cookies;
        if (cookies) {
            cookies[name] = { value, options: options ?? {} };
        }
        return res as MockResponse;
    };

    res.clearCookie = (name: string): MockResponse => {
        res._clearedCookies?.push(name);
        return res as MockResponse;
    };

    return res as MockResponse;
}
```

Then bind the provider double to the controller through the single DI boundary — a test subclass overriding `getProvider()`:

```typescript
import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { OidcAuthController } from 'blendsdk/webafx-auth';
import type { OidcAuthProvider } from 'blendsdk/webafx-auth';
import {
    createMockOidcProvider,
    createMockRequest,
    createMockRes,
    createMockSettings,
} from './oidc-test-helpers.js';

/**
 * Subclass fixed to a provider double. `getProvider()` is the controller's
 * single dependency-injection seam: production subclasses let the base
 * resolve the provider from the service container; tests override it.
 */
class TestAuthController extends OidcAuthController {
    constructor(
        private readonly providerDouble: Partial<OidcAuthProvider>,
        envMode: 'development' | 'production' = 'development'
    ) {
        super(createMockSettings(envMode), {});
    }

    protected async getProvider(_req: Request): Promise<OidcAuthProvider> {
        // Boundary assertion: every member the controller calls is provided
        // by createMockOidcProvider().
        return this.providerDouble as OidcAuthProvider;
    }
}

describe('OidcAuthController — login / callback / me', () => {
    it('completes the full BFF flow with cookies as the channel', async () => {
        const { provider, sessions } = createMockOidcProvider();
        const controller = new TestAuthController(provider);

        // 1. Login: the controller stores PKCE state and sets the state cookie.
        const loginRes = createMockRes();
        await controller.handleLogin(createMockRequest(), loginRes);

        const stateId = loginRes._cookies['__oidc_state'].value;
        expect(stateId).toBeDefined();

        // 2. Callback: present the state cookie and the authorization code.
        const callbackReq = createMockRequest({
            query: { code: 'auth-code', state: 'mock-state' },
            headers: { cookie: `__oidc_state=${stateId}` },
        });
        const callbackRes = createMockRes();
        await controller.handleCallback(callbackReq, callbackRes);

        const sessionId = callbackRes._cookies['__oidc_session'].value;
        expect(sessionId).toBeDefined();
        expect(sessions.size).toBe(1);
        expect(callbackRes._clearedCookies).toContain('__oidc_state');

        // 3. Me: read the session back — user data only, never tokens.
        const meReq = createMockRequest({
            headers: { cookie: `__oidc_session=${sessionId}` },
        });
        const meRes = createMockRes();
        await controller.handleMe(meReq, meRes);

        expect(meRes._json).toMatchObject({
            success: true,
            data: { user: { sub: 'user-123' } },
        });
    });
});
```

### File-scoped module mocks for OIDC bearer validation

Testing the *bearer* path of `OidcAuthProvider` requires mocking the two libraries it calls. Both mocks are file-scoped — spread the real module and override only what the provider touches. This entire file must contain no real-`jose` tests (and vice versa):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as client from 'openid-client';
import * as jose from 'jose';
import { OidcAuthProvider } from 'blendsdk/webafx-auth';
import type { OidcAuthConfig } from 'blendsdk/webafx-auth';
import { createBearerRequest } from './test-helpers.js';

// ---------------------------------------------------------------------------
// Module mocks — file-scoped
// ---------------------------------------------------------------------------

vi.mock('openid-client', async () => {
    const actual = await vi.importActual<typeof client>('openid-client');
    return {
        ...actual,
        discovery: vi.fn(),
        buildAuthorizationUrl: vi.fn(),
        authorizationCodeGrant: vi.fn(),
        refreshTokenGrant: vi.fn(),
        tokenRevocation: vi.fn(),
        fetchUserInfo: vi.fn(),
        randomPKCECodeVerifier: vi.fn(() => 'mock-code-verifier'),
        calculatePKCECodeChallenge: vi.fn(async () => 'mock-code-challenge'),
        randomState: vi.fn(() => 'mock-state'),
        randomNonce: vi.fn(() => 'mock-nonce'),
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockServerMetadata = {
    issuer: 'https://auth.example.com',
    jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
};

/**
 * `client.Configuration` is a nominal class (private fields), so build the
 * double through Partial: the class is assignable to its Partial form, which
 * makes the final narrowing assertion type-safe even though the double is
 * structural.
 */
const mockConfiguration = {
    serverMetadata: () => mockServerMetadata,
} as Partial<client.Configuration> as client.Configuration;

const baseConfig: OidcAuthConfig = {
    serviceName: 'oidc-test',
    issuerUrl: 'https://auth.example.com',
    clientId: 'test-client',
    clientSecret: 'test-secret',
    audience: 'https://api.example.com',
};

beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(client.discovery).mockResolvedValue(mockConfiguration);
    vi.mocked(jose.jwtVerify).mockResolvedValue({
        payload: {
            sub: 'user-1',
            iss: 'https://auth.example.com',
            aud: 'https://api.example.com',
            exp: Math.floor(Date.now() / 1000) + 3600,
        },
        protectedHeader: { alg: 'RS256' },
    });
    vi.mocked(jose.createRemoteJWKSet).mockReturnValue(vi.fn());
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OidcAuthProvider bearer path (mocked)', () => {
    it('validates a Bearer token through discovery and JWKS verification', async () => {
        const provider = new OidcAuthProvider(baseConfig);

        const result = await provider.authenticate(createBearerRequest('valid-bearer-token'));

        expect(result).toBeDefined();
        expect(result?.sub).toBe('user-1');
        expect(client.discovery).toHaveBeenCalledOnce();
        expect(jose.jwtVerify).toHaveBeenCalledWith(
            'valid-bearer-token',
            expect.any(Function), // mocked JWKS resolver
            expect.objectContaining({
                issuer: 'https://auth.example.com',
                audience: 'https://api.example.com',
                clockTolerance: 30,
            })
        );
    });

    it('returns undefined when verification rejects the token', async () => {
        vi.mocked(jose.jwtVerify).mockRejectedValueOnce(new Error('invalid signature'));
        const provider = new OidcAuthProvider(baseConfig);

        await expect(
            provider.authenticate(createBearerRequest('bad-token'))
        ).resolves.toBeUndefined();
    });

    it('caches discovery per issuer', async () => {
        const provider = new OidcAuthProvider(baseConfig);

        await provider.validate('token-1');
        await provider.validate('token-2');

        expect(client.discovery).toHaveBeenCalledTimes(1);
    });
});
```

### Cleanup checklist

Every concern below is exercised by the package's own suite; wire each into `afterEach` of the files that use it:

| Stub | Cleanup |
| --- | --- |
| `vi.stubGlobal('fetch', ...)` | `vi.unstubAllGlobals()` |
| `vi.spyOn(...)` (console, provider methods) | `vi.restoreAllMocks()` |
| `vi.useFakeTimers()` | `vi.useRealTimers()` |
| Real provider instances (`JwtAuthProvider`, `OidcAuthProvider`, ...) | `await provider.shutdown()` |
| Real `WebApplication` instances | `await shutdown()` from `app.start()` |

---

## Test Patterns by Feature

### Token extraction

Extraction is synchronous and inherits from the abstract base — drive it with `MemoryAuthProvider` and assert on the ordered chain: first non-empty match wins.

```typescript
import { describe, it, expect } from 'vitest';
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { TokenSource } from 'blendsdk/webafx-auth';
import {
    createBearerRequest,
    createCookieRequest,
    createMockRequest,
    createQueryRequest,
} from './test-helpers.js';

describe('token extraction chain', () => {
    it('extracts from the Authorization header', () => {
        const provider = new MemoryAuthProvider({ tokenSources: ['header'] });

        expect(provider.extractToken(createBearerRequest('my-token-123'))).toBe('my-token-123');
    });

    it('returns the first match when several sources are configured', () => {
        const provider = new MemoryAuthProvider({ tokenSources: ['header', 'cookie', 'query'] });
        const req = createMockRequest({
            authorization: 'Bearer header-token',
            cookies: { auth_token: 'cookie-token' },
            query: { token: 'query-token' },
        });

        expect(provider.extractToken(req)).toBe('header-token');
    });

    it('falls back to the cookie, then the query parameter', () => {
        const provider = new MemoryAuthProvider({ tokenSources: ['header', 'cookie', 'query'] });

        expect(provider.extractToken(createCookieRequest('cookie-token'))).toBe('cookie-token');
        expect(provider.extractToken(createQueryRequest('query-token'))).toBe('query-token');
    });

    it('honours custom cookie and query parameter names', () => {
        const cookieProvider = new MemoryAuthProvider({
            tokenSources: ['cookie'],
            cookieName: 'session_id',
        });
        expect(cookieProvider.extractToken(createCookieRequest('v', 'session_id'))).toBe('v');

        const queryProvider = new MemoryAuthProvider({
            tokenSources: ['query'],
            queryParamName: 'access_token',
        });
        expect(queryProvider.extractToken(createQueryRequest('v', 'access_token'))).toBe('v');
    });

    it('supports a custom extractor', () => {
        const customSource: TokenSource = {
            extractor: (req) => req.headers['x-api-key'] as string | undefined,
        };
        const provider = new MemoryAuthProvider({ tokenSources: [customSource] });
        const req = createMockRequest({ headers: { 'x-api-key': 'api-key-abc' } });

        expect(provider.extractToken(req)).toBe('api-key-abc');
    });

    it('returns undefined when nothing matches — this is not an error', () => {
        const provider = new MemoryAuthProvider({ tokenSources: ['header', 'cookie', 'query'] });

        expect(provider.extractToken(createMockRequest())).toBeUndefined();
    });
});
```

Key assertions: `toBe(...)` for the extracted string, `toBeUndefined()` for no match, `toThrow('Unknown token source')` for a bad configuration, and case-sensitivity of the `'Bearer '` prefix (lowercase `bearer` must not match).

### JWT validation

Test the enforcement matrix: signature, expiry, issuer, audience, clock tolerance, and the fail-closed `requireAudience` gate. The gate is the subtle one — assert that verification is never even attempted when required configuration is missing.

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';
import { TEST_SECRET, TEST_ISSUER, TEST_AUDIENCE, signTestJwt } from './test-helpers.js';

describe('JWT validation matrix', () => {
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

    it('rejects a token with the wrong issuer', async () => {
        const token = await signTestJwt({ issuer: 'https://wrong-issuer.example.com' });

        await expect(provider.validate(token)).resolves.toBeUndefined();
    });

    it('rejects a token with the wrong audience', async () => {
        const token = await signTestJwt({ audience: 'wrong-client-id' });

        await expect(provider.validate(token)).resolves.toBeUndefined();
    });

    it('accepts a recently-expired token within clockTolerance', async () => {
        const tolerant = new JwtAuthProvider({
            secret: TEST_SECRET,
            algorithms: ['HS256'],
            issuer: TEST_ISSUER,
            audience: TEST_AUDIENCE,
            clockTolerance: 120,
        });

        const token = await signTestJwt({
            exp: Math.floor(Date.now() / 1000) - 30,
        });

        await expect(tolerant.validate(token)).resolves.toBeDefined();
        await tolerant.shutdown();
    });

    it('fails closed when requireAudience is set but no audience is configured', async () => {
        const strict = new JwtAuthProvider({
            secret: TEST_SECRET,
            algorithms: ['HS256'],
            issuer: TEST_ISSUER,
            requireAudience: true,
        });

        const token = await signTestJwt({ audience: TEST_AUDIENCE });

        await expect(strict.validate(token)).resolves.toBeUndefined();
        await strict.shutdown();
    });

    it('prefers resolveUser over mapClaims in the OIDC provider (same config precedence rule)', () => {
        // See the OIDC provider section: resolveUser wins when both are set.
        const precedenceCheck = vi.fn(() => true);
        expect(precedenceCheck()).toBe(true);
    });
});
```

> The final test above is a stub illustrating where the precedence rule *would* live if you were checking it structurally; the runnable precedence test belongs with the OIDC provider mocks (see below).

### Claims mapping

The default mapper handles `sub`/`subject`, `exp`, and the three scope encodings (`scope` string, `scope` array, `scopes` array). Verify each encoding and prove a custom `mapClaims` fully overrides the default.

```typescript
import { describe, it, expect } from 'vitest';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';
import type { ClaimsMapper, JwtAuthConfig } from 'blendsdk/webafx-auth';
import { TEST_SECRET, TEST_ISSUER, TEST_AUDIENCE, signTestJwt } from './test-helpers.js';

const BASE_CONFIG: JwtAuthConfig = {
    secret: TEST_SECRET,
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
};

describe('claims mapping', () => {
    it('parses a space-separated scope string (OAuth2 standard)', async () => {
        const provider = new JwtAuthProvider(BASE_CONFIG);
        const token = await signTestJwt({ claims: { scope: 'openid profile email' } });

        const result = await provider.validate(token);

        expect(result?.scopes).toEqual(['openid', 'profile', 'email']);
        await provider.shutdown();
    });

    it('handles scope and scopes arrays', async () => {
        const provider = new JwtAuthProvider(BASE_CONFIG);

        const viaScopes = await provider.validate(
            await signTestJwt({ claims: { scopes: ['admin', 'user'] } })
        );
        expect(viaScopes?.scopes).toEqual(['admin', 'user']);

        const viaScope = await provider.validate(
            await signTestJwt({ claims: { scope: ['read', 'write'] } })
        );
        expect(viaScope?.scopes).toEqual(['read', 'write']);

        await provider.shutdown();
    });

    it('leaves scopes undefined when no scope claim is present', async () => {
        const provider = new JwtAuthProvider(BASE_CONFIG);

        const result = await provider.validate(await signTestJwt());

        expect(result?.scopes).toBeUndefined();
        await provider.shutdown();
    });

    it('preserves raw claims and the original token', async () => {
        const provider = new JwtAuthProvider(BASE_CONFIG);
        const token = await signTestJwt({
            claims: { role: 'admin', department: 'engineering' },
        });

        const result = await provider.validate(token);

        expect(result?.claims.role).toBe('admin');
        expect(result?.claims.iss).toBe(TEST_ISSUER);
        expect(result?.token).toBe(token);
        await provider.shutdown();
    });

    it('lets a custom mapper replace the default completely', async () => {
        const customMapper: ClaimsMapper = (token, rawClaims) => ({
            sub: String(rawClaims.user_id ?? rawClaims.sub ?? 'unknown'),
            claims: rawClaims,
            token,
            scopes: Array.isArray(rawClaims.permissions)
                ? rawClaims.permissions.map(String)
                : undefined,
        });

        const provider = new JwtAuthProvider({ ...BASE_CONFIG, mapClaims: customMapper });
        const token = await signTestJwt({
            claims: { user_id: 'custom-id-99', permissions: ['read', 'write'] },
        });

        const result = await provider.validate(token);

        expect(result?.sub).toBe('custom-id-99');
        expect(result?.scopes).toEqual(['read', 'write']);
        await provider.shutdown();
    });
});
```

### Memory provider

Beyond `validate()`, the memory provider exposes runtime helpers — cover them, because tests use them to change authentication mid-scenario. Also pin the shutdown semantics: `shutdown()` clears the token map.

```typescript
import { describe, it, expect } from 'vitest';
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';
import { createTestAuthResult } from './test-helpers.js';

describe('MemoryAuthProvider runtime helpers', () => {
    it('adds, overwrites, and removes tokens at runtime', async () => {
        const provider = new MemoryAuthProvider();
        expect(provider.getTokenCount()).toBe(0);

        provider.addToken('dynamic-token', createTestAuthResult({ sub: 'dynamic-user' }));
        expect(provider.getTokenCount()).toBe(1);
        expect((await provider.validate('dynamic-token'))?.sub).toBe('dynamic-user');

        provider.addToken('dynamic-token', createTestAuthResult({ sub: 'updated' }));
        expect(provider.getTokenCount()).toBe(1);
        expect((await provider.validate('dynamic-token'))?.sub).toBe('updated');

        expect(provider.removeToken('dynamic-token')).toBe(true);
        expect(provider.removeToken('dynamic-token')).toBe(false);
    });

    it('clears all tokens on shutdown', async () => {
        const provider = new MemoryAuthProvider({
            validTokens: {
                'token-a': createTestAuthResult({ sub: 'a' }),
                'token-b': createTestAuthResult({ sub: 'b' }),
            },
        });

        await provider.shutdown();

        expect(provider.getTokenCount()).toBe(0);
        await expect(provider.validate('token-a')).resolves.toBeUndefined();
    });

    it('always reports healthy', async () => {
        const provider = new MemoryAuthProvider();

        await expect(provider.health()).resolves.toBe(true);
    });
});
```

### Introspection provider

The introspection provider is best tested through observable effects on the stubbed `fetch`: request shape, call counts (cache hits), eviction order (LRU), and per-tenant dynamic configuration.

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';
import type { IntrospectionAuthConfig } from 'blendsdk/webafx-auth';
import { createMockRequest, jsonResponse } from './test-helpers.js';

const STATIC_CONFIG: IntrospectionAuthConfig = {
    introspectionUrl: 'https://auth.example.com/oauth2/introspect',
    clientId: 'client-1',
    clientSecret: 'secret-1',
};

/** Seconds since epoch, offset from now. */
function futureEpoch(offsetSeconds = 3600): number {
    return Math.floor(Date.now() / 1000) + offsetSeconds;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('IntrospectionAuthProvider behavior', () => {
    it('maps an active response to an AuthResult with sub, exp, and scopes', async () => {
        const exp = futureEpoch();
        fetchMock.mockResolvedValue(
            jsonResponse({ active: true, sub: 'user-1', exp, scope: 'read write' })
        );
        const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

        const result = await provider.validate('opaque-token');

        expect(result?.sub).toBe('user-1');
        expect(result?.exp).toBe(exp);
        expect(result?.scopes).toEqual(['read', 'write']);
        expect(result?.claims.active).toBe(true);
    });

    it('returns undefined for an inactive token', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ active: false }));
        const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

        await expect(provider.validate('opaque-token')).resolves.toBeUndefined();
    });

    it('rejects an active but already-expired token and does not cache it', async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ active: true, sub: 'u', exp: futureEpoch(-1) })
        );
        const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

        await expect(provider.validate('opaque-token')).resolves.toBeUndefined();
        await expect(provider.validate('opaque-token')).resolves.toBeUndefined();

        // Observable cache signal: an uncached invalid token is re-fetched.
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('caches an active token: one fetch for two validations', async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ active: true, sub: 'u', exp: futureEpoch() })
        );
        const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

        await provider.validate('opaque-token');
        await provider.validate('opaque-token');

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('applies the claims mapper on every call, including cache hits', async () => {
        const mapClaims = vi.fn((token: string, claims: Record<string, unknown>) => ({
            sub: String(claims.sub),
            claims,
            token,
        }));
        fetchMock.mockResolvedValue(
            jsonResponse({ active: true, sub: 'u', exp: futureEpoch() })
        );
        const provider = new IntrospectionAuthProvider({ ...STATIC_CONFIG, mapClaims });

        await provider.validate('opaque-token');
        await provider.validate('opaque-token');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(mapClaims).toHaveBeenCalledTimes(2);
    });

    it('evicts the least recently used entry, not the oldest inserted', async () => {
        fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
            const token = new URLSearchParams(String(init.body)).get('token');
            return jsonResponse({ active: true, sub: token, exp: futureEpoch() });
        });
        const provider = new IntrospectionAuthProvider({
            ...STATIC_CONFIG,
            maxCacheSize: 2,
        });

        // A and B fill the cache; touching A makes B the least recently used,
        // so inserting C evicts B (not A). B is then re-fetched.
        await provider.validate('token-a');
        await provider.validate('token-b');
        await provider.validate('token-a');
        await provider.validate('token-c');
        await provider.validate('token-b');

        // Fetches: A, B, C, B — a FIFO cache would have evicted A and
        // produced 4 fetches plus one more for A... LRU gives exactly 4 minus
        // the cached A and (after re-fetch) B. See the call-count assertion below.
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('resolves credentials per request via configFactory (multi-tenant)', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ active: true, sub: 'u', exp: futureEpoch() }));
        const provider = new IntrospectionAuthProvider({
            configFactory: async (req) => {
                const tenant = String(req.headers['x-tenant'] ?? '');
                return {
                    introspectionUrl: `https://${tenant}.example.com/introspect`,
                    clientId: `client-${tenant}`,
                    clientSecret: `secret-${tenant}`,
                };
            },
        });

        const result = await provider.authenticate(
            createMockRequest({
                authorization: 'Bearer opaque-token',
                headers: { 'x-tenant': 'acme' },
            })
        );

        expect(result).toBeDefined();
        expect(fetchMock).toHaveBeenCalledWith(
            'https://acme.example.com/introspect',
            expect.objectContaining({ method: 'POST' })
        );
    });

    it('never logs the token or the client secret', async () => {
        const spies = [
            vi.spyOn(console, 'log').mockImplementation(() => {}),
            vi.spyOn(console, 'info').mockImplementation(() => {}),
            vi.spyOn(console, 'warn').mockImplementation(() => {}),
            vi.spyOn(console, 'error').mockImplementation(() => {}),
        ];
        fetchMock.mockResolvedValue(jsonResponse({ active: true }, 500));
        const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

        const error = await provider.validate('secret-token-value').catch((err: unknown) => err);

        expect(String(error)).toMatch(/500/);
        expect(String(error)).not.toContain('secret-token-value');
        const output = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
        expect(output).not.toContain('secret-token-value');
        expect(output).not.toContain(STATIC_CONFIG.clientSecret);
    });

    it('clears the cache on shutdown', async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ active: true, sub: 'u', exp: futureEpoch() })
        );
        const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

        await provider.validate('opaque-token');
        await provider.shutdown();
        await provider.validate('opaque-token');

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('reports healthy without touching the network for static config', async () => {
        const provider = new IntrospectionAuthProvider(STATIC_CONFIG);

        await expect(provider.health()).resolves.toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
```

### OIDC provider

The OIDC provider has two independent authentication paths. Test the session-cookie path **without** module mocks — it only touches the `CacheProvider` double. Test the bearer path in a separate file with the file-scoped `jose`/`openid-client` mocks shown earlier. Also verify the fail-closed `requireAudience` gate rejects before any discovery call.

Session-cookie path (no mocks):

```typescript
import { describe, it, expect } from 'vitest';
import { OidcAuthProvider } from 'blendsdk/webafx-auth';
import { createMockRequest } from './test-helpers.js';
import { createMockCacheProvider, createSampleSession } from './cache-test-helpers.js';

describe('OidcAuthProvider session-cookie path', () => {
    it('authenticates from the session store when no Bearer token is present', async () => {
        const { provider: sessionStore, store } = createMockCacheProvider();
        const session = createSampleSession();
        store.set('oidc:session:sess-1', { value: session, expiresAt: 0 });

        const provider = new OidcAuthProvider({
            issuerUrl: 'https://auth.example.com',
            clientId: 'test-client',
            sessionStore,
        });

        const req = createMockRequest({
            headers: { cookie: '__oidc_session=sess-1' },
        });

        const result = await provider.authenticate(req);

        expect(result).toBeDefined();
        expect(result?.sub).toBe('user-123');
        expect(result?.token).toBe('mock-access-token');
        expect(result?.claims).toEqual(session.user);
        expect(result?.exp).toBe(session.expiresAt);
    });

    it('rejects a session whose expiresAt is in the past', async () => {
        const { provider: sessionStore, store } = createMockCacheProvider();
        store.set('oidc:session:old', {
            value: createSampleSession({
                expiresAt: Math.floor(Date.now() / 1000) - 3600,
            }),
            expiresAt: 0,
        });

        const provider = new OidcAuthProvider({
            issuerUrl: 'https://auth.example.com',
            clientId: 'test-client',
            sessionStore,
        });

        const result = await provider.authenticate(
            createMockRequest({ headers: { cookie: '__oidc_session=old' } })
        );

        // Expiry is enforced by the provider, not left to the store TTL.
        expect(result).toBeUndefined();
    });

    it('returns undefined without a Bearer token and without a sessionStore', async () => {
        const provider = new OidcAuthProvider({
            issuerUrl: 'https://auth.example.com',
            clientId: 'test-client',
        });

        const result = await provider.authenticate(
            createMockRequest({ headers: { cookie: '__oidc_session=some-id' } })
        );

        expect(result).toBeUndefined();
    });
});
```

Bearer path — fail-closed and precedence patterns to use with the mocked file:

```typescript fragment
// Continues the file-scoped mock scaffold from "Mocking & Stubbing".

it('rejects before verification when the audience is required but not configured', async () => {
    const provider = new OidcAuthProvider({
        serviceName: 'oidc-test',
        issuerUrl: 'https://auth.example.com',
        clientId: 'test-client',
        requireAudience: true,
        // no audience configured for this tenant
    });

    const result = await provider.authenticate(createBearerRequest('some-token'));

    expect(result).toBeUndefined();
    // Fail closed BEFORE discovery and verification — no needless work.
    expect(jose.jwtVerify).not.toHaveBeenCalled();
    expect(client.discovery).not.toHaveBeenCalled();
});

it('prefers resolveUser over mapClaims', async () => {
    const resolveUser = vi.fn(async (_req, claims) => ({
        sub: String(claims.sub),
        claims,
        token: 'resolved-token',
        scopes: ['resolved'],
    }));
    const mapClaims = vi.fn((_token, _claims) => ({
        sub: 'mapped',
        claims: {},
        token: 'mapped-token',
    }));

    const provider = new OidcAuthProvider({ ...baseConfig, resolveUser, mapClaims });
    const result = await provider.authenticate(createBearerRequest('token'));

    expect(resolveUser).toHaveBeenCalledOnce();
    expect(mapClaims).not.toHaveBeenCalled();
    expect(result?.scopes).toEqual(['resolved']);
});

it('reports the session path as a user even when the config says client', async () => {
    const { provider: sessionStore, store } = createMockCacheProvider();
    store.set('oidc:session:s1', { value: createSampleSession(), expiresAt: 0 });

    const provider = new OidcAuthProvider({
        ...baseConfig,
        sessionStore,
        principalType: 'client',
    });

    const result = await provider.authenticate(
        createMockRequest({ headers: { cookie: '__oidc_session=s1' } })
    );

    // A browser session is an interactive user, regardless of configuration.
    expect(result?.principalType).toBe('user');
});
```

### OIDC controller (BFF)

Beyond the full flow, assert cookie security flags (they flip with `isProduction()`), the refresh/session-TTL behavior, and optional session-ID rotation. All of these use the doubles from the mocking section.

```typescript
import { describe, it, expect, vi } from 'vitest';
import type { Request } from 'express';
import { OidcAuthController } from 'blendsdk/webafx-auth';
import type { OidcAuthProvider } from 'blendsdk/webafx-auth';
import { createBearerRequest } from './test-helpers.js';
import { createSampleSession } from './cache-test-helpers.js';
import {
    createMockOidcProvider,
    createMockRequest,
    createMockRes,
    createMockSettings,
} from './oidc-test-helpers.js';

/** Controller fixed to the given provider double. */
class RotationTestController extends OidcAuthController {
    constructor(private readonly providerDouble: Partial<OidcAuthProvider>) {
        super(createMockSettings(), {});
    }

    protected async getProvider(_req: Request): Promise<OidcAuthProvider> {
        return this.providerDouble as OidcAuthProvider;
    }
}

describe('OidcAuthController cookie and session behavior', () => {
    it('sets httpOnly SameSite=Lax cookies in development mode', async () => {
        const { provider } = createMockOidcProvider();
        const controller = new (class extends RotationTestController {})(
            provider
        ) as unknown as OidcAuthController;

        // Route the login through the concrete subclass under test:
        const loginRes = createMockRes();
        await (controller as unknown as { handleLogin(req: unknown, res: unknown): Promise<void> })
            .handleLogin(createMockRequest(), loginRes);

        const options = loginRes._cookies['__oidc_state'].options;
        expect(options.httpOnly).toBe(true);
        expect(options.sameSite).toBe('lax');
        expect(options.path).toBe('/');
        expect(options.secure).toBe(false);
    });

    it('rotates the session id on refresh when enabled', async () => {
        const { provider, sessions } = createMockOidcProvider({ rotateSessionIdOnRefresh: true });
        sessions.set('S1', createSampleSession({ refreshToken: 'old-refresh-token' }));
        const controller = new RotationTestController(provider);

        const res = createMockRes();
        await controller.handleRefresh(
            createMockRequest({ headers: { cookie: '__oidc_session=S1' } }),
            res
        );

        const newId = res._cookies['__oidc_session'].value;
        expect(newId).toBeDefined();
        expect(newId).not.toBe('S1');
        // The old id stops resolving; the session moved to the new id.
        expect(sessions.get('S1')).toBeUndefined();
        expect(sessions.get(newId)).toBeDefined();
    });

    it('leaves the session in place when the refresh fails', async () => {
        const { provider, sessions } = createMockOidcProvider({ rotateSessionIdOnRefresh: true });
        const session = createSampleSession({ refreshToken: 'old-refresh-token' });
        sessions.set('S1', session);
        provider.refreshToken = vi.fn().mockRejectedValue(new Error('refresh failed'));

        const controller = new RotationTestController(provider);
        const res = createMockRes();

        await expect(
            controller.handleRefresh(
                createMockRequest({ headers: { cookie: '__oidc_session=S1' } }),
                res
            )
        ).rejects.toThrow('refresh failed');

        expect(sessions.get('S1')).toEqual(session);
        expect(res._cookies['__oidc_session']).toBeUndefined();
    });

    it('returns 400 with a typed error body for an unknown state', async () => {
        const { provider } = createMockOidcProvider();
        const controller = new RotationTestController(provider);

        const res = createMockRes();
        await controller.handleCallback(
            createMockRequest({
                query: { code: 'code', state: 'mock-state' },
                headers: { cookie: '__oidc_state=unknown-uuid' },
            }),
            res
        );

        expect(res._status).toBe(400);
        expect(res._json).toEqual({
            success: false,
            error: {
                code: 'missing_state',
                message: 'Session state not found (expired or missing)',
            },
        });
    });
});
```

> The first test above shows a wrapper pattern for convenience in a one-off block; in a real suite, declare `RotationTestController` once and instantiate it directly as in the other tests.

Also assert route definitions when your subclass changes the prefix:

```typescript fragment
it('registers the five BFF routes under the default prefix', () => {
    const controller = new RotationTestController(createMockOidcProvider().provider);

    const paths = controller.routes().map((route) => route.path);

    expect(paths).toEqual([
        '/api/oidc/login',
        '/api/oidc/callback',
        '/api/oidc/logout',
        '/api/oidc/me',
        '/api/oidc/refresh',
    ]);
});
```

### Plugin integration

Cover three things at the plugin level: the definition shape (`name`, `priority`), the two service registrations, and per-request delegation — all shown in the unit-testing section. Two extra cases worth pinning:

```typescript fragment
// Uses the plugin harness from "Test Setup".

it('uses custom option values for plugin name, priority, and service names', async () => {
    const provider = new MemoryAuthProvider({
        validTokens: { t: createTestAuthResult() },
    });
    const plugin = createAuthPlugin(provider, {
        serviceName: 'my-auth',
        userServiceName: 'authenticated-user',
        priority: 25,
    });

    expect(plugin.name).toBe('auth:my-auth');
    expect(plugin.priority).toBe(25);

    const { registeredServices } = await executePluginFactory(plugin);
    expect(registeredServices.some((s) => s.name === 'my-auth' && s.type === 'singleton')).toBe(true);
    expect(
        registeredServices.some((s) => s.name === 'authenticated-user' && s.type === 'per-request')
    ).toBe(true);
});

it('logs the provider class and service name on installation', async () => {
    const provider = new MemoryAuthProvider();
    const plugin = createAuthPlugin(provider);
    const { logger } = await executePluginFactory(plugin);

    const message = logger.info.mock.calls[0][0] as string;
    expect(message).toContain('MemoryAuthProvider');
    expect(message).toContain("'auth'");
});
```

The convenience factories (`jwtAuthPlugin`, `introspectionAuthPlugin`, `oidcAuthPlugin`, `memoryAuthPlugin`) are thin wrappers — for each, assert that a valid `PluginDefinition` is produced and options are forwarded:

```typescript
import { describe, it, expect } from 'vitest';
import { jwtAuthPlugin, memoryAuthPlugin, oidcAuthPlugin, introspectionAuthPlugin } from 'blendsdk/webafx-auth';

describe('convenience factories', () => {
    it('jwtAuthPlugin forwards AuthPluginOptions', () => {
        const plugin = jwtAuthPlugin(
            { secret: 'test-secret-key-at-least-32-chars-long!!' },
            { serviceName: 'jwt', priority: 3 }
        );

        expect(plugin.name).toBe('auth:jwt');
        expect(plugin.priority).toBe(3);
        expect(typeof plugin.factory).toBe('function');
    });

    it('memoryAuthPlugin forwards AuthPluginOptions', () => {
        const plugin = memoryAuthPlugin(
            {
                validTokens: {
                    'test-token': { sub: 'user-1', claims: { role: 'admin' }, token: 'test-token' },
                },
            },
            { serviceName: 'test-auth', priority: 1 }
        );

        expect(plugin.name).toBe('auth:test-auth');
        expect(plugin.priority).toBe(1);
    });

    it('oidcAuthPlugin and introspectionAuthPlugin produce PluginDefinitions', () => {
        const oidc = oidcAuthPlugin({
            issuerUrl: 'https://auth.example.com',
            clientId: 'test-client',
            clientSecret: 'test-secret',
            redirectUri: 'https://app.example.com/auth/callback',
        });
        expect(oidc.name).toMatch(/^auth:/);

        const introspection = introspectionAuthPlugin({
            introspectionUrl: 'https://auth.example.com/oauth2/introspect',
            clientId: 'test-client',
            clientSecret: 'test-secret',
        });
        expect(introspection.name).toMatch(/^auth:/);
    });
});
```

### Provider factory

Dispatch and diagnostics are the two things to test (full example in the unit-testing section). Two additional cases for config pass-through:

```typescript fragment
it('forwards a custom mapClaims to the introspection provider', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ active: true, sub: 'u', exp: 4102444800 }));

    const provider = createAuthProvider({
        type: 'introspection',
        introspectionUrl: 'https://auth.example.com/introspect',
        clientId: 'client',
        clientSecret: 'secret',
        mapClaims: (token, claims): AuthResult => ({
            sub: 'mapped',
            claims,
            token,
            scopes: ['mapped'],
        }),
    });

    const result = await provider.authenticate(createBearerRequest('factory-impl-token'));

    expect(result?.sub).toBe('mapped');
    expect(result?.scopes).toEqual(['mapped']);
});

it('builds a jwt provider that fails closed when requireAudience is set', async () => {
    const provider = createAuthProvider({
        type: 'jwt',
        secret: TEST_SECRET,
        requireAudience: true,
    });

    const token = await signTestJwt();

    await expect(provider.validate(token)).resolves.toBeUndefined();
    await provider.shutdown();
});
```

### Principal discriminator

`principalType` lets one application classify principals as `'user'` or `'client'`. The precedence contract: a custom mapper or a stored result wins over the configured static type; the static type fills in only when unset.

```typescript
import { describe, it, expect } from 'vitest';
import { JwtAuthProvider, MemoryAuthProvider, createAuthProvider } from 'blendsdk/webafx-auth';
import { TEST_SECRET, TEST_ISSUER, TEST_AUDIENCE, signTestJwt } from './test-helpers.js';

const JWT_BASE = {
    secret: TEST_SECRET,
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
};

describe('principal discriminator', () => {
    it('stamps the configured type on a JWT result', async () => {
        const provider = new JwtAuthProvider({ ...JWT_BASE, principalType: 'user' });

        const result = await provider.validate(await signTestJwt());

        expect(result?.principalType).toBe('user');
        await provider.shutdown();
    });

    it('leaves the type unset when nothing configures it', async () => {
        const provider = new JwtAuthProvider(JWT_BASE);

        const result = await provider.validate(await signTestJwt());

        expect(result?.principalType).toBeUndefined();
        await provider.shutdown();
    });

    it('keeps a value set by a custom mapper over the configured type', async () => {
        const provider = new JwtAuthProvider({
            ...JWT_BASE,
            principalType: 'client',
            mapClaims: (token, claims) => ({
                sub: String(claims.sub),
                claims,
                token,
                principalType: 'user',
            }),
        });

        const result = await provider.validate(await signTestJwt());

        expect(result?.principalType).toBe('user');
        await provider.shutdown();
    });

    it('passes through a type stored on a memory result', async () => {
        const provider = new MemoryAuthProvider({
            validTokens: {
                'memory-token': {
                    sub: 'user-9',
                    claims: {},
                    token: 'memory-token',
                    principalType: 'user',
                },
            },
        });

        const result = await provider.validate('memory-token');

        expect(result?.principalType).toBe('user');
    });

    it('forwards the configured type through createAuthProvider', async () => {
        const provider = createAuthProvider({ type: 'jwt', ...JWT_BASE, principalType: 'client' });

        const result = await provider.validate(await signTestJwt());

        expect(result?.principalType).toBe('client');
        await provider.shutdown();
    });
});
```

### Public API surface

A cheap, high-value regression suite: import every documented runtime export from the package root and assert its presence. A removed or renamed export fails here instead of surfacing as a consumer compile error.

```typescript
import { describe, it, expect } from 'vitest';
import {
    AuthProvider,
    MemoryAuthProvider,
    JwtAuthProvider,
    IntrospectionAuthProvider,
    OidcAuthProvider,
    createAuthPlugin,
    oidcAuthPlugin,
    jwtAuthPlugin,
    introspectionAuthPlugin,
    memoryAuthPlugin,
    createAuthProvider,
    OidcAuthController,
    DEFAULT_SERVICE_NAME,
    DEFAULT_PLUGIN_PRIORITY,
    DEFAULT_COOKIE_NAME,
    DEFAULT_QUERY_PARAM_NAME,
    DEFAULT_TOKEN_SOURCES,
} from 'blendsdk/webafx-auth';
import type {
    AuthResult,
    PrincipalType,
    JwtAuthConfig,
    IntrospectionAuthConfig,
    OidcAuthConfig,
    OidcTokens,
    OidcSession,
    OidcSessionState,
    TokenSource,
    ClaimsMapper,
    AuthFactoryConfig,
    AuthPluginOptions,
} from 'blendsdk/webafx-auth';

describe('public API surface', () => {
    it('exports the five documented default constants', () => {
        expect(DEFAULT_SERVICE_NAME).toBeDefined();
        expect(DEFAULT_PLUGIN_PRIORITY).toBeDefined();
        expect(DEFAULT_COOKIE_NAME).toBeDefined();
        expect(DEFAULT_QUERY_PARAM_NAME).toBeDefined();
        expect(DEFAULT_TOKEN_SOURCES).toBeDefined();
    });

    it('exports the providers as constructible classes', () => {
        for (const provider of [
            AuthProvider,
            MemoryAuthProvider,
            JwtAuthProvider,
            IntrospectionAuthProvider,
            OidcAuthProvider,
        ]) {
            expect(typeof provider).toBe('function');
        }
    });

    it('exports the plugin factories and the provider factory as callable functions', () => {
        for (const factory of [
            createAuthPlugin,
            oidcAuthPlugin,
            jwtAuthPlugin,
            introspectionAuthPlugin,
            memoryAuthPlugin,
            createAuthProvider,
        ]) {
            expect(typeof factory).toBe('function');
        }
    });

    it('exports the OIDC controller as a constructible class', () => {
        expect(typeof OidcAuthController).toBe('function');
    });
});
```

---

---

# webafx-auth Troubleshooting

This guide covers the failure modes you are most likely to hit when wiring `blendsdk/webafx-auth` into a WebAFX application: startup misconfiguration, silent token rejections, introspection and OIDC endpoint problems, session-cookie behavior, and the TypeScript compiler errors that strict ESM projects produce.

Two ground rules explain most of the surprises in this package:

- **Startup misconfiguration throws.** Factories and constructors validate their inputs and throw a message that names the missing field, so bad configuration fails before the first request.
- **Authentication failure is silent.** A missing, malformed, or expired token produces `undefined` — never an exception. Only infrastructure problems (network failures, unreachable discovery documents, cache errors) can throw, and even that differs per provider (see [Known Pitfalls](#known-pitfalls)).

---

## Common Errors

### Startup and Configuration Errors

#### `createAuthProvider: type 'jwt' requires 'secret'`

**Error**

```text
createAuthProvider: type 'jwt' requires 'secret'
```

**Cause**

`createAuthProvider()` validates the fields required by the selected `type` before constructing anything. A JWT provider without `secret` has no key material for HMAC verification, so the factory refuses to build it. The same class of error appears for `type: 'oidc'` (missing `issuerUrl`) and `type: 'introspection'` (missing credentials or `configFactory`).

**Fix**

Supply the required field. The secret must match the signer's key exactly and should be at least 256 bits (32 bytes) for HS256.

```typescript
import { createAuthProvider } from 'blendsdk/webafx-auth';

export const authProvider = createAuthProvider({
    type: 'jwt',
    secret: 'a-development-only-secret-at-least-32-bytes!',
    issuer: 'https://auth.example.com',
    audience: 'my-api',
});
```

---

#### `createAuthProvider: type 'oidc' requires 'issuerUrl'`

**Error**

```text
createAuthProvider: type 'oidc' requires 'issuerUrl'
```

**Cause**

The OIDC provider discovers the tenant's metadata (including the JWKS endpoint) from the issuer URL. Without it there is nothing to discover against, so the factory throws at startup instead of letting every request fail later.

**Fix**

Provide `issuerUrl` (and normally `clientId`/`clientSecret`, which are required by the BFF methods).

```typescript
import { createAuthProvider } from 'blendsdk/webafx-auth';

export const authProvider = createAuthProvider({
    type: 'oidc',
    issuerUrl: 'https://auth.example.com',
    clientId: 'my-client',
    clientSecret: 's3cret',
});
```

---

#### `createAuthProvider: type 'introspection' requires 'introspectionUrl', 'clientId' and 'clientSecret', or 'configFactory'`

**Error**

```text
createAuthProvider: type 'introspection' requires 'introspectionUrl', 'clientId' and 'clientSecret', or 'configFactory'
```

**Cause**

Introspection (RFC 7662) needs an endpoint and client credentials. The factory accepts either the complete static triple or a `configFactory` that resolves credentials per request. A *partial* triple (for example, `introspectionUrl` and `clientId` but no secret) is treated as missing — the type guard requires all three.

**Fix**

Pass the complete triple, or a factory. Note that the same rule is enforced by the `IntrospectionAuthProvider` constructor itself.

```typescript
import { createAuthProvider } from 'blendsdk/webafx-auth';

export const authProvider = createAuthProvider({
    type: 'introspection',
    introspectionUrl: 'https://auth.example.com/oauth2/introspect',
    clientId: 'my-service',
    clientSecret: 's3cret',
});
```

For DB-backed, per-tenant credentials:

```typescript
import type { Request } from 'express';
import { createAuthProvider } from 'blendsdk/webafx-auth';
import type { IntrospectionAuthConfig } from 'blendsdk/webafx-auth';

export const authProvider = createAuthProvider({
    type: 'introspection',
    configFactory: async (req: Request): Promise<IntrospectionAuthConfig> => {
        const tenant = String(req.headers['x-tenant'] ?? 'default');
        return {
            introspectionUrl: `https://${tenant}.example.com/oauth2/introspect`,
            clientId: `client-${tenant}`,
            clientSecret: `secret-${tenant}`,
        };
    },
});
```

---

#### `Unknown token source: "bearer". Supported: "header", "cookie", "query", or { extractor: fn }`

**Error**

```text
Unknown token source: "bearer". Supported: "header", "cookie", "query", or { extractor: fn }
```

**Cause**

The token extraction chain is built in the `AuthProvider` constructor, and it only accepts the three built-in source names or an object with an `extractor` function. Because `TokenSource` is a typed union, TypeScript normally rejects invalid strings at compile time — this runtime error appears when the value was cast (`'bearer' as TokenSource`) or supplied from JavaScript/JSON configuration. There is no separate `"bearer"` source: the `"header"` source already parses `Authorization: Bearer <token>`.

**Fix**

Use one of the built-in names or a custom extractor object.

```typescript
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';

export const provider = new MemoryAuthProvider({
    tokenSources: ['header', 'cookie'],
    cookieName: 'auth_token',
});
```

---

#### `OidcAuthProvider requires either issuerUrl or configFactory`

**Error**

```text
OidcAuthProvider requires either issuerUrl or configFactory
```

**Cause**

The constructor needs at least one source of OIDC configuration. This typically happens when configuration is loaded from the environment and a variable is unset at runtime, so an optional config object arrives empty.

**Fix**

Construct the provider with a static issuer or a per-request factory.

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

export const provider = new OidcAuthProvider({
    issuerUrl: 'https://auth.example.com',
    clientId: 'my-client',
    clientSecret: 's3cret',
});
```

Be aware that a `configFactory`-only provider cannot serve local `validate()` calls — it needs request context via `authenticate(req)` or the OIDC controller.

---

#### `Plugin "auth:auth" is already registered`

**Error**

```text
Plugin "auth:auth" is already registered
```

**Cause**

Two `createAuthPlugin()` calls used the default `serviceName` (`"auth"`), so both produced the plugin name `auth:auth` and the second `app.use(...)` was rejected by WebAFX. This is intentional: silently replacing the first provider with the second would be a security bug.

**Fix**

Give each plugin a distinct `serviceName`, and a distinct `userServiceName` when both register a principal service. The plugin name becomes `auth:<serviceName>`.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { createAuthPlugin, IntrospectionAuthProvider, JwtAuthProvider } from 'blendsdk/webafx-auth';

const app = new WebApplication({ PORT: 3400, ENV_MODE: 'development', LOG_LEVEL: 'ERROR' });

app.use(
    createAuthPlugin(
        new JwtAuthProvider({ secret: 'a-development-only-secret-at-least-32-bytes!' }),
        { serviceName: 'user-auth', userServiceName: 'user' }
    )
);

app.use(
    createAuthPlugin(
        new IntrospectionAuthProvider({
            introspectionUrl: 'https://auth.example.com/oauth2/introspect',
            clientId: 'my-service',
            clientSecret: 's3cret',
        }),
        { serviceName: 'client-auth', userServiceName: 'client' }
    )
);
```

---

#### `sessionStore is required` for session operations

**Symptom**

`storeSession()`, `getSession()`, `clearSession()`, `storeState()`, `getState()`, or `clearState()` rejects with an error whose message contains:

```text
sessionStore is required
```

**Cause**

The OIDC provider delegates all server-side session and PKCE-state persistence to a `CacheProvider`. Without a `sessionStore` the operations throw instead of silently pretending to work — the session-cookie fallback in `authenticate()` and the BFF flow cannot function.

**Fix**

Pass a `CacheProvider` (from `blendsdk/webafx-cache`) as `sessionStore`. Pure bearer-token validation against the static config keeps working without it.

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';
import type { CacheProvider } from 'blendsdk/webafx-cache';

export function createSessionAwareProvider(sessionStore: CacheProvider): OidcAuthProvider {
    return new OidcAuthProvider({
        issuerUrl: 'https://auth.example.com',
        clientId: 'my-client',
        clientSecret: 's3cret',
        sessionStore,
    });
}
```

---

#### OIDC BFF methods throw missing-configuration errors

**Errors**

```text
clientId is required for buildAuthorizationUrl
redirectUri is required for buildAuthorizationUrl
issuerUrl and clientId are required for exchangeCode
issuerUrl and clientId are required for refreshToken
issuerUrl and clientId are required for revokeToken
issuerUrl and clientId are required for fetchUserInfo
```

**Cause**

Every BFF method (`buildAuthorizationUrl`, `exchangeCode`, `refreshToken`, `revokeToken`, `fetchUserInfo`) validates its configuration before touching the network. Providers configured with only a `configFactory` cannot resolve per-request configuration inside these methods, so calls fail unless a config override is passed explicitly.

**Fix**

Provide complete static configuration, and pass a per-tenant config as the second argument when overriding.

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';
import type { OidcAuthConfig } from 'blendsdk/webafx-auth';

export const provider = new OidcAuthProvider({
    issuerUrl: 'https://auth.example.com',
    clientId: 'my-client',
    clientSecret: 's3cret',
    redirectUri: 'https://app.example.com/api/oidc/callback',
    scopes: ['openid', 'profile', 'email'],
});

const tenantB: OidcAuthConfig = {
    issuerUrl: 'https://tenant-b.auth.example.com',
    clientId: 'tenant-b-client',
    clientSecret: 'tenant-b-secret',
    redirectUri: 'https://tenant-b.app.example.com/api/oidc/callback',
};

export async function exchangeForTenantB(codeVerifier: string, callbackUrl: string) {
    return provider.exchangeCode({ codeVerifier, callbackUrl }, tenantB);
}
```

---

### Token Validation Failures (Silent Rejections)

#### Symptom: `authenticate()` resolves `undefined` and every guarded route answers 401

**Symptom**

A request that you believe carries a valid token is rejected: the per-request principal service resolves `undefined`, guarded routes answer 401, and nothing is thrown or logged by the package.

**Cause**

By design, all of the following produce the same observable outcome — `undefined` — with no exception:

1. **The token is not where the extraction chain looks.** The `Bearer ` prefix is case-sensitive; a cookie source requires cookie-parser (built into WebAFX, must be installed for plain Express) and the configured `cookieName`; a query value must be a plain string (repeated parameters arrive as arrays and are ignored).
2. **An empty `Bearer ` value falls through the chain.** `Authorization: Bearer ` yields an empty string, which is falsy — extraction continues to the next configured source, so the request can authenticate with a *different* credential than you expect.
3. **Signature mismatch.** The JWT `secret` differs from the signer's, or the token's algorithm is not in the configured `algorithms` (default HS256).
4. **Claim mismatch.** Configured `issuer` and `audience` must match the token's `iss` and `aud` claims (JWT, introspection, and OIDC all enforce this when configured).
5. **Expiry or clock skew.** `exp` is in the past, or the issuer/API clocks disagree by more than `clockTolerance` seconds.
6. **`requireAudience` fails closed.** With `requireAudience: true` but no `audience` configured, every token is rejected (see next entry).

**Fix**

Instrument the two lifecycle stages — extraction and validation — instead of guessing from the 401.

```typescript
import type { Request } from 'express';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const provider = new JwtAuthProvider({ secret: 'a-development-only-secret-at-least-32-bytes!' });

export async function traceAuthentication(req: Request): Promise<void> {
    const token = provider.extractToken(req);
    console.log(`stage 1 — token extracted: ${token !== undefined}`);

    if (token === undefined) {
        console.log('check tokenSources, the case-sensitive "Bearer " prefix, and cookie-parser');
        return;
    }

    const result = await provider.validate(token);
    console.log(`stage 2 — token validated: ${result !== undefined}`);
}
```

Then align the provider configuration with what the issuer actually emits:

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

export const provider = new JwtAuthProvider({
    secret: 'a-development-only-secret-at-least-32-bytes!', // must match the signer
    algorithms: ['HS256'],
    issuer: 'https://auth.example.com', // must equal the token's `iss`
    audience: 'my-api',                 // must appear in the token's `aud`
    clockTolerance: 60,                 // accepted clock skew in seconds
});
```

If extraction succeeds but validation fails, decode the token to compare claims (see [Debugging Strategies](#debugging-strategies), step 3).

---

#### Symptom: every token is rejected after enabling `requireAudience`

**Symptom**

After adding `requireAudience: true` — directly or through `createAuthProvider()` — every token fails validation, including tokens that verified before.

**Cause**

`requireAudience` is a fail-closed gate: when no `audience` is configured, the check can never succeed, so the provider rejects before doing any verification work (no JWKS fetch, no `jwtVerify` call). This is deliberate — it catches deployments that forgot to configure an audience instead of silently skipping the check.

**Fix**

Always pair `requireAudience: true` with at least one configured audience (a string or an array).

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

export const provider = new JwtAuthProvider({
    secret: 'a-development-only-secret-at-least-32-bytes!',
    audience: ['my-api', 'my-api-v2'],
    requireAudience: true,
});
```

---

#### Symptom: a token that worked moments ago is now rejected

**Symptom**

Tokens validate fine, then start failing `undefined` shortly before their expected lifetime — especially when the issuer runs on different infrastructure than the API.

**Cause**

The token's `exp` has passed from the API server's point of view, or `nbf`/`iat` checks fail because the clocks differ. The OIDC provider defaults to **30 seconds** of tolerance; the JWT provider applies `clockTolerance` seconds of leeway to time-based claims.

**Fix**

Raise `clockTolerance` (in seconds) to match the real skew between your systems — but keep it small; it directly extends the window in which expired tokens are accepted.

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

export const provider = new JwtAuthProvider({
    secret: 'a-development-only-secret-at-least-32-bytes!',
    issuer: 'https://auth.example.com',
    audience: 'my-api',
    clockTolerance: 60,
});
```

---

### Introspection Endpoint Failures

#### Rejection whose message contains the HTTP status (for example `500`)

**Symptom**

`provider.validate(token)` rejects with an error whose message contains the endpoint's HTTP status (for example `500`), and — by design — **never** contains the token or the client secret. Authenticated requests may surface as 500s through your error middleware, not as 401s.

**Cause**

Unlike local JWT validation, introspection is a network call: a non-2xx response, a refused connection (`ECONNREFUSED`), a DNS failure, or an aborted timeout are infrastructure errors and are *thrown*. Common root causes are wrong endpoint URL, credentials the endpoint rejects, the wrong client authentication method, or an endpoint that is simply slow.

**Fix**

1. Set an explicit `timeout` (milliseconds) so slow endpoints abort instead of hanging requests.
2. Try `authMethod: 'post'` if the endpoint rejects `Basic` authentication.
3. Add `audience` when tokens from the same issuer are minted for several APIs.

```typescript
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';

export const provider = new IntrospectionAuthProvider({
    introspectionUrl: 'https://auth.example.com/oauth2/introspect',
    clientId: 'my-service',
    clientSecret: 's3cret',
    authMethod: 'post', // default is basic; try 'post' when Basic is rejected
    timeout: 5_000,     // milliseconds
    audience: 'my-api', // reject active tokens minted for other APIs
});
```

Reproduce the exact RFC 7662 request by hand to compare status and body:

```bash
curl -i -X POST 'https://auth.example.com/oauth2/introspect' \
  -u 'my-service:s3cret' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'Accept: application/json' \
  --data-urlencode 'token=the-opaque-token-from-the-request' \
  --data-urlencode 'token_type_hint=access_token'
```

---

#### Rejection mentioning `invalid response body`

**Symptom**

`provider.validate(token)` rejects with an error whose message contains:

```text
invalid response body
```

**Cause**

The endpoint returned HTTP 200 but the JSON body is not an object — typically `null` (or another non-object value) from a misconfigured gateway or wrong URL. Two related variants exist: if the body is not valid JSON at all, the JSON parse error itself propagates; if the body parses but is not an object, the provider raises `invalid response body`.

**Fix**

Point the provider at the real introspection endpoint and verify it with a known active token using the curl command above. A correctly configured endpoint returns an object such as:

```json
{
  "active": true,
  "sub": "user-1",
  "exp": 4102444800,
  "scope": "read write",
  "aud": "my-api"
}
```

```typescript
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';

export const provider = new IntrospectionAuthProvider({
    introspectionUrl: 'https://auth.example.com/oauth2/introspect',
    clientId: 'my-service',
    clientSecret: 's3cret',
});
```

---

#### `validate()` resolves `undefined` although the endpoint works

**Symptom**

The introspection endpoint responds correctly to curl and to `authenticate(req)`, but calling `provider.validate(token)` directly always resolves `undefined`.

**Cause**

With only a `configFactory` configured (no static triple), `validate()` has no request object and therefore no way to resolve credentials. It refuses to guess and returns `undefined` without making any HTTP call.

**Fix**

Use `authenticate(req)` — which resolves the configuration per request — or add a static triple.

```typescript
import type { Request } from 'express';
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';
import type { IntrospectionAuthConfig } from 'blendsdk/webafx-auth';

const provider = new IntrospectionAuthProvider({
    configFactory: async (req: Request): Promise<IntrospectionAuthConfig> => ({
        introspectionUrl: 'https://auth.example.com/oauth2/introspect',
        clientId: String(req.headers['x-client-id'] ?? 'default-client'),
        clientSecret: 'resolved-per-request',
    }),
});

export async function check(req: Request): Promise<boolean> {
    const result = await provider.authenticate(req);
    return result !== undefined;
}
```

---

### OIDC Failures

#### `health()` returns `false`

**Symptom**

The WebAFX health endpoint reports the OIDC provider as unhealthy: `provider.health()` resolves `false`.

**Cause**

Two possible causes:

1. **No static configuration.** A provider built with only a `configFactory` reports `false` by design — there is no default issuer for the health check to probe.
2. **Discovery fails.** The issuer URL is unreachable, returns an error, or the discovery document is malformed.

**Fix**

Give the provider a static `issuerUrl`, then verify discovery manually. `health()` performs a discovery call, so a `true` result proves the issuer is reachable.

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

const provider = new OidcAuthProvider({
    issuerUrl: 'https://auth.example.com',
    clientId: 'my-client',
    clientSecret: 's3cret',
});

export async function checkDiscovery(): Promise<boolean> {
    return provider.health();
}
```

```bash
curl -s 'https://auth.example.com/.well-known/openid-configuration'
```

Confirm the document contains a `jwks_uri` — verification silently returns `undefined` when it is missing.

---

#### `validate()` resolves `undefined` for every token

**Symptom**

Bearer JWTs that the OIDC provider used to accept are rejected; `authenticate()` also resolves `undefined`; no error is thrown.

**Cause**

Local validation (`validate()`) only works with static configuration and only after successful discovery. The provider swallows the following as failed authentication: discovery failures, a discovery document without `jwks_uri`, and — in `authenticate()` — a throwing `configFactory`. A provider configured with only a `configFactory` never even attempts discovery inside `validate()`.

**Fix**

Use static configuration for bearer validation, make the issuer reachable, and choose the right entry point for dynamic setups:

- `validate(token)` — static config only.
- `authenticate(req)` — resolves `configFactory` per request, then validates.
- `OidcAuthController` — full BFF flow with server-side sessions.

```typescript
import type { Request } from 'express';
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

const provider = new OidcAuthProvider({
    issuerUrl: 'https://auth.example.com',
    clientId: 'my-client',
    clientSecret: 's3cret',
    discoveryTtl: 60, // seconds; shorten temporarily to rule out stale discovery caching
});

export async function check(req: Request): Promise<boolean> {
    const result = await provider.authenticate(req);
    return result !== undefined;
}
```

---

#### BFF responses: `missing_state`, `invalid_state`, `no_session`, and friends

**Symptom**

The OIDC controller's routes return structured error responses instead of redirects or data:

```json
{
  "success": false,
  "error": { "code": "missing_state", "message": "Session state not found (expired or missing)" }
}
```

**Cause**

The controller encodes each failure with a stable code. Full map:

| HTTP | `error.code` | `error.message` | Trigger |
| --- | --- | --- | --- |
| 400 | `oidc_error` | the IdP's `error_description` | IdP redirected back with an `error` query parameter |
| 400 | `missing_code` | `Authorization code missing from callback` | callback arrived without a `code` parameter |
| 400 | `missing_state` | `Session state not found (expired or missing)` | state cookie absent, unknown, or expired (state TTL is 5 minutes) |
| 400 | `invalid_state` | `State parameter mismatch (possible CSRF)` | `state` parameter differs from the stored state |
| 400 | `no_refresh_token` | `No refresh token available` | refresh requested on a session without a refresh token |
| 401 | `no_session` | `No active session` | `/me` or `/refresh` without a valid session cookie |

The most common root causes: the state cookie was not sent (production `Secure` cookie over plain HTTP, missing cookie-parser, different domain), the flow took longer than the 5-minute state window, a multi-tenant cookie-name resolver returned a different name than during login, or the server-side session expired (the provider enforces `expiresAt` itself — an entry can still be in the cache and still be rejected).

**Fix**

For multi-tenant deployments, make the cookie-name resolver deterministic: it must produce the same name during login, callback, and all subsequent requests, and the headers it reads must be present on every request.

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';
import type { CacheProvider } from 'blendsdk/webafx-cache';

export function createTenantScopedProvider(sessionStore: CacheProvider): OidcAuthProvider {
    return new OidcAuthProvider({
        issuerUrl: 'https://auth.example.com',
        clientId: 'my-client',
        clientSecret: 's3cret',
        sessionStore,
        resolveSessionCookieName: (req) => `__oidc_session_${String(req.headers['x-tenant'] ?? 'default')}`,
        resolveStateCookieName: (req) => `__oidc_state_${String(req.headers['x-tenant'] ?? 'default')}`,
    });
}
```

For session-expiry-related `no_session` responses, verify `expiresAt` against your clock and allow small skew:

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';
import type { CacheProvider } from 'blendsdk/webafx-cache';

export function createProvider(sessionStore: CacheProvider): OidcAuthProvider {
    return new OidcAuthProvider({
        issuerUrl: 'https://auth.example.com',
        clientId: 'my-client',
        clientSecret: 's3cret',
        sessionStore,
        clockTolerance: 60, // seconds; default is 30
    });
}
```

---

### TypeScript Compiler Errors

#### `error TS2307: Cannot find module 'blendsdk/webafx-auth' or its corresponding type declarations.`

**Cause**

The package is ESM-only and publishes its types exclusively through the `exports` map (`./dist/index.d.ts`). TypeScript projects using legacy `moduleResolution: "node"` / `"node10"` cannot read `exports` and therefore never find the types.

**Fix**

Compile with Node16/NodeNext module resolution and make the project ESM.

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "strict": true
  }
}
```

Also set `"type": "module"` in the consuming package's `package.json`.

---

#### `error TS1479: The current file is a CommonJS module whose imports will produce 'require' calls`

**Cause**

The package's `exports` map exposes only an `import` condition. A CommonJS module cannot statically import it under NodeNext semantics.

**Fix**

Convert the consuming project to ESM (previous entry), or load the package with a dynamic `import()`, which is legal from CommonJS output.

```typescript
export async function loadAuth(): Promise<typeof import('blendsdk/webafx-auth')> {
    return import('blendsdk/webafx-auth');
}
```

---

#### `error TS2511: Cannot create an instance of an abstract class.`

**Cause**

`AuthProvider` is abstract — it defines the shared lifecycle but leaves `validate()`, `health()`, and `shutdown()` to concrete providers. `new AuthProvider(...)` is always a bug.

**Fix**

Instantiate one of the shipped providers, or implement all three abstract methods yourself.

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

export const provider = new JwtAuthProvider({
    secret: 'a-development-only-secret-at-least-32-bytes!',
});
```

A minimal custom provider:

```typescript
import { AuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

class StaticTokenProvider extends AuthProvider {
    async validate(token: string): Promise<AuthResult | undefined> {
        if (token !== 'expected-token') {
            return undefined;
        }
        return { sub: 'service-account', claims: {}, token };
    }

    async health(): Promise<boolean> {
        return true;
    }

    async shutdown(): Promise<void> {
        // Nothing to release — no external resources.
    }
}

export const provider = new StaticTokenProvider();
```

---

#### `error TS18048: 'user' is possibly 'undefined'.`

**Cause**

The per-request principal service resolves `AuthResult | undefined` — unauthenticated requests are normal for public routes. Even behind `this.authenticated()`, the type stays optional, so strict mode requires handling.

**Fix**

Narrow the value or use optional chaining.

```typescript
import { BaseController } from 'blendsdk/webafx';
import type { RouteDefinition } from 'blendsdk/webafx';
import type { AuthResult } from 'blendsdk/webafx-auth';

class ProfileController extends BaseController {
    routes(): RouteDefinition[] {
        return [
            this.authenticated()
                .get('/profile')
                .handle(async (req, res) => {
                    const user = await req.services.get<AuthResult>('user', undefined);
                    this.ok(res, {
                        sub: user?.sub ?? null,
                        scopes: user?.scopes ?? [],
                    });
                }),
        ];
    }
}
```

---

#### `error TS7006: Parameter 'req' implicitly has an 'any' type.`

**Cause**

A custom token extractor written without parameter types — common when its type annotation was accidentally dropped from the `TokenSource` object.

**Fix**

Type the extractor parameter explicitly; `TokenSource` objects accept `(req: Request) => string | undefined`.

```typescript
import type { Request } from 'express';
import type { TokenSource } from 'blendsdk/webafx-auth';

export const apiKeySource: TokenSource = {
    extractor: (req: Request): string | undefined => {
        const apiKey = req.headers['x-api-key'];
        return typeof apiKey === 'string' ? apiKey : undefined;
    },
};
```

---

#### `error TS2322: Type '"service"' is not assignable to type 'PrincipalType | undefined'.`

**Cause**

`PrincipalType` only allows `'user'` and `'client'`. Arbitrary labels are not part of the discriminator contract.

**Fix**

Use one of the supported values, and encode finer distinctions in claims via a custom mapper.

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

export const provider = new JwtAuthProvider({
    secret: 'a-development-only-secret-at-least-32-bytes!',
    principalType: 'client',
});
```

---

#### `error TS2345: Argument of type 'Request' is not assignable to parameter of type 'Request'` (with "Two different types with this name exist")

**Cause**

Two copies of `@types/express` are installed — one resolved by your application code and one resolved by the package's declaration files. The `Request` types look identical but originate from different files, so they are unrelated to the compiler.

**Fix**

Dedupe the types so a single `@types/express` copy resolves everywhere.

```bash
npm ls @types/express
npm dedupe
```

Align the declared version across the workspace if the duplicates persist.

---

## Debugging Strategies

### 1. Bisect the authentication lifecycle

The lifecycle has exactly two stages inside the provider (`extractToken` → `validate`) plus the plugin wiring around it. Run each stage explicitly against a captured request instead of inferring from 401 responses.

```typescript
import type { Request } from 'express';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';

const provider = new JwtAuthProvider({ secret: 'a-development-only-secret-at-least-32-bytes!' });

export async function traceAuthentication(req: Request): Promise<void> {
    const token = provider.extractToken(req);
    console.log(`stage 1 — token extracted: ${token !== undefined}`);

    if (token === undefined) {
        console.log('no token found: check tokenSources, the "Bearer " prefix, and cookie-parser');
        return;
    }

    const result = await provider.validate(token);
    console.log(`stage 2 — token validated: ${result !== undefined}`);
    console.log(`provider healthy: ${await provider.health()}`);
}
```

- **Stage 1 fails** → the problem is request shape, not credentials (see strategy 3 for the chain details).
- **Stage 1 succeeds, stage 2 fails** → the token itself is rejected; decode it (strategy 3 for JWT, strategy 4 for opaque tokens).
- **Both succeed but routes still 401** → the problem is wiring: plugins, service names, or route guards.

### 2. Prove the wiring with `MemoryAuthProvider`

Swap the real backend for the in-memory test provider. If requests authenticate with a known token, extraction and plugin registration are correct, and the problem is in the real backend or its configuration.

```typescript
import type { Request } from 'express';
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';
import type { AuthResult } from 'blendsdk/webafx-auth';

const stub: AuthResult = {
    sub: 'wiring-check',
    claims: {},
    token: 'known-token',
};

const provider = new MemoryAuthProvider({
    validTokens: { 'known-token': stub },
});

export async function verifyWiring(req: Request): Promise<boolean> {
    const result = await provider.authenticate(req);
    return result !== undefined;
}
```

Send `Authorization: Bearer known-token` and expect `true`. Note that `MemoryAuthProvider.shutdown()` wipes all tokens — do not call it mid-test-run.

### 3. Decode a JWT without verifying it, and compare claims

A failed `validate()` tells you nothing about *which* claim mismatched. Decode the token and compare it against your provider configuration. This uses `jose`, the same library the package verifies with — add it to your application if your package manager does not hoist it.

```typescript
import { decodeJwt, decodeProtectedHeader } from 'jose';

export function inspectToken(token: string): void {
    const header = decodeProtectedHeader(token);
    const claims = decodeJwt(token);
    const nowSeconds = Math.floor(Date.now() / 1000);

    console.log(`alg: ${header.alg}`);
    console.log(`iss: ${claims.iss ?? '<none>'}`);
    console.log(`aud: ${JSON.stringify(claims.aud ?? null)}`);
    console.log(`exp: ${String(claims.exp ?? '<none>')} (now: ${nowSeconds})`);
}
```

Compare each field against the provider's `algorithms`, `issuer`, `audience`, and clock. Remember that decoding performs **no** verification — never use a decoded token for authorization decisions.

### 4. Compare introspection traffic against a raw RFC 7662 call

1. Reproduce the request with curl (see the introspection error entries) using the exact URL, client credentials, and body from your configuration.
2. If curl succeeds but the provider fails, check `authMethod` (`basic` vs `post`) and `timeout`.
3. Remember the cache: two consecutive validations may produce only **one** HTTP call. To force a fresh call between experiments, clear the cache first.

```typescript
import { IntrospectionAuthProvider } from 'blendsdk/webafx-auth';

export async function probeIntrospection(
    provider: IntrospectionAuthProvider,
    token: string
): Promise<void> {
    const before = await provider.shutdown().then(() => provider.validate(token));
    console.log(`validated after cache clear: ${before !== undefined}`);
}
```

### 5. Probe OIDC discovery and JWKS manually

1. Call `provider.health()` — for a statically configured provider this performs a discovery call. `false` means the issuer is unreachable or the metadata is malformed.
2. `curl` the issuer's `/.well-known/openid-configuration` and confirm it contains `jwks_uri`.
3. If you changed the issuer or rotated JWKS keys, clear the discovery cache with `await provider.shutdown()` or wait out `discoveryTtl`. Discovery is cached per issuer URL.
4. Remember that `validate()` silently returns `undefined` when discovery fails — use `health()` to turn that silence into a signal.

```typescript
import { OidcAuthProvider } from 'blendsdk/webafx-auth';

const provider = new OidcAuthProvider({
    issuerUrl: 'https://auth.example.com',
    clientId: 'my-client',
    clientSecret: 's3cret',
    discoveryTtl: 60, // seconds; shorten while investigating discovery churn
});

export async function checkDiscovery(): Promise<boolean> {
    return provider.health();
}
```

### 6. Inspect server-side sessions and cookies

Sessions live in the `CacheProvider` under `oidc:session:<id>` and PKCE states under `oidc:state:<id>`. Read them directly to answer "is the session actually there, and why not?".

```typescript
import type { CacheProvider } from 'blendsdk/webafx-cache';
import type { OidcSession } from 'blendsdk/webafx-auth';

export async function inspectSession(
    sessionStore: CacheProvider,
    sessionId: string
): Promise<void> {
    const session = await sessionStore.get<OidcSession>(`oidc:session:${sessionId}`);
    if (session === undefined) {
        console.log('session not found (expired, cleared, or wrong key)');
        return;
    }
    console.log({
        sub: session.user.sub,
        expiresAt: session.expiresAt,
        nowSeconds: Math.floor(Date.now() / 1000),
        hasRefreshToken: session.refreshToken !== undefined,
    });
}
```

Then, in the browser: the cookies are named `__oidc_session` / `__oidc_state` (defaults), are `httpOnly` (invisible to `document.cookie` — use DevTools' Application/Network panels), `SameSite=Lax`, path `/`. The state cookie lives 5 minutes; the session cookie's `maxAge` follows `sessionCookieTtl ?? sessionTtl ?? 3600`. In production the `Secure` flag is set (`settings.isProduction()`), so cookies are dropped over plain HTTP.

### 7. Watch the plugin installation log line

`createAuthPlugin()` writes exactly one `logger.info` line when its factory runs, naming the provider class and the quoted service name (for example, containing `MemoryAuthProvider` and `'auth'`). If that line never appears for a plugin you registered:

- the plugin factory was never invoked (check `app.use(...)` ordering and plugin name collisions), or
- the provider instance you attached is not the one you configured.

Also remember: the package itself never logs tokens or secrets — mirror that discipline in any instrumentation you add, logging booleans and claim names, not token material.

---

## Known Pitfalls

### `undefined` conflates "no token" with "invalid token"

Both produce the same result: `undefined`. Do not try to distinguish them with `try/catch` — exceptions mean infrastructure problems, not authentication failures. Instrument `extractToken()` and `validate()` separately (see strategy 1) whenever the distinction matters.

### Error-throwing behavior differs per provider

The silent-failure rule is not uniform. These asymmetries surprise teams when they switch backends:

| Failure mode | `IntrospectionAuthProvider` | `OidcAuthProvider` |
| --- | --- | --- |
| Endpoint / discovery unreachable | throws (network error propagates) | returns `undefined` |
| `configFactory` throws | throws | returns `undefined` |
| Async `resolveUser` mapper throws | — | throws |
| Sync `mapClaims` mapper throws | — | returns `undefined` (treated as failed auth) |

Practical consequence: your Express error middleware sees 500s for introspection transport failures but never for OIDC ones. Monitor both paths differently.

### `requireAudience: true` without `audience` rejects everything

Fail-closed by design: the gate runs before verification, so no token can ever pass. Always configure at least one audience when you enable the requirement.

### Introspection caching changes what you observe

- Two validations of the same active token produce **one** HTTP call (until `cacheTTL` elapses, an LRU eviction at `maxCacheSize` occurs, or you `shutdown()`).
- The cache TTL is clamped to the token's remaining lifetime — a token with `exp` one second away is cached for one second, regardless of `cacheTTL`.
- Inactive responses, expired tokens, and failed requests are **not** cached.
- Per-tenant requests are cached in isolation, keyed by a SHA-256 digest of the token combined with the tenant's configuration — the raw token never appears in the cache.
- The claims mapper runs on **every** validation, including cache hits. A mapper with side effects (metrics, enrichment calls) runs far more often than the endpoint is contacted.

### Percent-encoded Basic credentials may surprise non-compliant endpoints

With the default `authMethod: 'basic'`, the client ID and secret are percent-encoded (RFC 6749) before being Base64-encoded for the `Authorization` header. Endpoints that compare the credentials byte-for-byte may reject unusual values containing reserved characters. Switch to `authMethod: 'post'` when the endpoint misbehaves with such credentials.

### Token extraction chain details that bite

- The `Bearer ` prefix is **case-sensitive**; `bearer <token>` is ignored entirely.
- `Authorization: Bearer ` (empty value) is falsy, so extraction **continues to the next source** — a request can authenticate via a cookie even though a broken bearer header was present.
- The `"query"` source only accepts plain string values; repeated parameters parsed into arrays yield `undefined`.
- The `"cookie"` source requires cookie-parser. WebAFX installs it already; bare Express does not.

### `MemoryAuthProvider` has test-double semantics

- `validate()` returns the exact `AuthResult` object you registered — stored by reference, with **no** claims mapping applied. Mutating a stored result changes what later validations return.
- `principalType` from config is only filled in when the stored result does not already carry one.
- `shutdown()` empties the token map. It is for tests and never for production credentials.

### The OIDC session path always reports `principalType: 'user'`

The bearer path stamps the configured `principalType` (for example `'client'`), but a session-cookie authentication always reports `'user'`, because a session is an interactive login regardless of configuration. Do not route machine traffic onto the session path and expect the configured type to appear.

### Session expiry is enforced by the provider, not only the store TTL

A session whose `expiresAt` is in the past is rejected even while its cache entry is still present. The boundary is sharp: with the default 30-second tolerance, `expiresAt` exactly `now - 30` is already rejected; `clockTolerance: 0` rejects anything past. Sessions **without** `expiresAt` are accepted and rely entirely on the store TTL — make sure the TTL is set when your tokens have no expiry.

### Cookie-name resolvers must be consistent across the whole flow

If `resolveSessionCookieName` / `resolveStateCookieName` depend on a request header, that header must be present on the login request, the callback, and every authenticated request. A resolver that returns `__oidc_session_acme` during login but `__oidc_session_default` later produces `missing_state` or 401s that look like session loss but are name mismatches.

### Session-ID rotation invalidates captured IDs instantly

With `rotateSessionIdOnRefresh` enabled, a successful refresh moves the session to a new ID and re-issues the cookie; the old ID stops resolving and a second refresh presenting it returns 401. Browsers follow the new cookie transparently, but parallel tabs, captured IDs in tests, and clients that cache the cookie value will fail. When rotation is disabled (the default), the ID is stable.

Related: the `/api/oidc/logout` and `/api/oidc/refresh` routes are intentionally **not** behind the `secure` guard — they validate the session cookie themselves so an expired session can still refresh or log out. Do not stack an additional auth guard on top of them.

### `validate()` ignores `configFactory` on both remote providers

- `IntrospectionAuthProvider`: returns `undefined` without any HTTP call when only a factory is configured.
- `OidcAuthProvider`: returns `undefined` without triggering discovery when only a factory is configured.

Dynamic per-tenant setups must go through `authenticate(req)` (or the `OidcAuthController`), because that is the only entry point that has the request object needed to resolve configuration.

### Two providers need distinct plugin and principal service names

`serviceName` collisions throw `Plugin "auth:<name>" is already registered` at startup. `userServiceName` collisions do not throw — both plugins bind the same per-request service name, and routes silently resolve whichever registration wins. Always give co-installed providers distinct values for both names.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
