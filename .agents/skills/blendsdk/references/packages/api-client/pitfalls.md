> **Package**: `blendsdk/api-client`

# api-client Best Practices

---

These practices keep calls secure, predictable, and easy to debug. Each pair states the rule, why it
matters, and the correct code.

---

## Do / Don't Pairs

### 1. Create one client and reuse it

**Why:** A client closes over its base URL, adapter, auth, and default headers. Building one per call
recreates that state and loses `BearerAuth`'s cached token and single-flight refresh, so concurrent
calls can stampede the identity provider.

```typescript
// Do
const client = createApiClient({ baseUrl: '/api', auth });
await client.request(opA, paramsA);
await client.request(opB, paramsB);

// Don't
await createApiClient({ baseUrl: '/api', auth }).request(opA, paramsA);
await createApiClient({ baseUrl: '/api', auth }).request(opB, paramsB);
```

### 2. Never send an API key in the query string

**Why:** Query strings are recorded in server logs, browser history, referrer headers, and forwarded
proxies. `ApiKeyAuth` warns on query placement for this reason. Header placement is the default and is
safe.

```typescript
// Do
new ApiKeyAuth({ key: process.env.API_KEY! });

// Avoid — leaks the key through intermediaries
new ApiKeyAuth({ key: process.env.API_KEY!, in: 'query' });
```

### 3. Let `BearerAuth.refresh` own token renewal

**Why:** Hand-rolling retries around every call duplicates logic and races on concurrent 401s. The
runtime refreshes once and retries once, and concurrent calls share one refresh.

```typescript
// Do
const auth = new BearerAuth({
  getToken: () => session.accessToken,
  refresh: () => session.refresh(),
});

// Don't catch 401, refresh manually, and replay the whole call
```

### 4. Drop a cached bearer token on logout

**Why:** A refreshed token is reused briefly, by design. Leaving it cached after logout lets a later
request reuse credentials that should be gone.

```typescript
session.clear();
auth.invalidate();
```

### 5. Prefer per-call overrides over new clients

**Why:** `RequestOptions` already overrides `baseUrl`, `auth`, `headers`, and `signal` for one call.
Building a second client just to change a tenant header adds state and hides the intent.

```typescript
await client.request(op, params, { headers: { 'X-Tenant': 'acme' } });
```

### 6. Always bound long operations with an AbortSignal

**Why:** The runtime imposes no timeout. Without a signal, a hung socket keeps a promise pending
forever. An abort becomes an `ApiTransportError` and is never retried.

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 10_000);
await client.request(op, params, { signal: controller.signal });
```

### 7. Branch on `error.code`, not on message text

**Why:** Messages come from the server and can change without warning; codes are the stable
machine-readable contract. `statusCode` classifies the failure class, and `operationId` says which
call failed.

```typescript
if (error instanceof ApiError && error.code === 'not_found') {
  return undefined;
}
```

### 8. Keep OIDC client-credentials on the server

**Why:** `OidcClientCredentialsAuth` exchanges a secret for a token. The constructor refuses to run
outside Node so the secret cannot reach a browser bundle. Do not try to work around the guard; use a
server-side proxy or a cookie-session flow for browser clients.

### 9. Do not add Zod to the runtime

**Why:** The runtime validates nothing; the server validates requests. Adding a validator here would
introduce a second Zod copy and duplicate guarantees the server already enforces. Generated clients
import runtime values and types only.

### 10. Treat generated files as read-only and check them in CI

**Why:** Generated clients are deterministic output. Editing them by hand makes `blendsdk api check`
fail and hides drift. Change the controller or contract, regenerate, and let the check gate protect
the committed artifacts.

```bash
yarn workspace <package> generate:api
blendsdk api check --config packages/<package>/blendsdk.api.ts
```

### 11. Do not expect a query string on body methods

**Why:** For `POST`, `PUT`, and `PATCH`, all non-path parameters become the JSON body; the runtime
builds no query string. Put query-only values on `GET`/`DELETE` operations, or send them as body
fields.

### 12. Treat path parameters as untrusted input

**Why:** Although the runtime encodes path values and rejects `.`/`..`, the server must still
validate every path parameter. Client-side checks are a convenience, not a security boundary.

---

## Summary Table

| Practice | One-line reason |
|---|---|
| Reuse one client | Keeps auth state and token caching coherent |
| Header API keys | Query strings leak credentials |
| Let the strategy refresh | Correct single-flight retry, no races |
| `invalidate()` on logout | Drops cached credentials immediately |
| Per-call overrides | Simpler than rebuilding clients |
| Abort long calls | The runtime has no timeout |
| Use `error.code` | Stable identifiers; messages are not |
| Server-side OIDC | Secrets must never reach a browser |
| No Zod in the runtime | One Zod version; server validates anyway |
| Regenerate, don't edit | Keeps `blendsdk api check` green |
| No query on body methods | All non-path params become the body |
| Validate server-side | Client encoding is not a security control |

---

# api-client Testing Patterns

---

This guide shows how to test code that uses `blendsdk/api-client`. The package runs on Vitest and
splits **specification tests** (`*.spec.test.ts`) that assert public behaviour from a stub transport
from **implementation tests** (`*.impl.test.ts`) that cover internals. The runtime has one true
external boundary — the adapter — so nearly every test stubs it.

---

## Test Setup

| Requirement | Detail |
|---|---|
| Runner | Vitest |
| Module system | ESM; import from `../src/index.js` inside the package |
| Type checking | Vitest runs but does not typecheck; the `tsc` build covers types |
| External boundary | The `RequestAdapter`, replaced with a stub |

Keep the two file kinds distinct: `client.spec.test.ts` encodes the contract callers rely on, while
`auth.impl.test.ts`, `request.impl.test.ts`, `token-store.impl.test.ts`, and `transport.impl.test.ts`
exercise internals.

---

## Stubbing the Transport

A stub records requests and returns canned responses, so no server is required.

```typescript
import { expect, test } from 'vitest';
import {
  createApiClient,
  type AdapterRequest,
  type AdapterResponse,
  type RequestAdapter,
} from '../src/index.js';

class StubAdapter implements RequestAdapter {
  readonly requests: AdapterRequest[] = [];

  constructor(private readonly responder: (request: AdapterRequest) => AdapterResponse) {}

  async send(request: AdapterRequest): Promise<AdapterResponse> {
    this.requests.push(request);
    return this.responder(request);
  }
}

function dataResponse(data: unknown): AdapterResponse {
  return { status: 200, ok: true, body: { success: true, data } };
}

const getProduct = {
  method: 'get',
  path: '/api/products/{id}',
  envelope: 'data' as const,
  operationId: 'getProduct',
};
```

---

## Testing URL, Method, and Parameters

Assert the request the runtime built, not just the result.

```typescript
test('encodes path parameters', async () => {
  const adapter = new StubAdapter(() => dataResponse({}));
  const client = createApiClient({ baseUrl: 'https://api.example.com', adapter });

  await client.request(getProduct, { id: 'a/b c' });

  expect(adapter.requests[0].method).toBe('GET');
  expect(adapter.requests[0].url).toBe('https://api.example.com/api/products/a%2Fb%20c');
});
```

Array query parameters become repeated keys (`tag=a&tag=b`); assert the built URL to nail this down.

---

## Testing Envelope Handling

Return `{ success: true, data }` and assert the unwrapped value; return a body with `pagination` and
assert the whole body comes back. Also cover the forgiving `'data'` fallback: a body without a `data`
property, and a non-object body, are returned unchanged.

```typescript
test('unwraps the data property', async () => {
  const adapter = new StubAdapter(() => dataResponse({ id: 42 }));
  const client = createApiClient({ baseUrl: 'https://x', adapter });

  await expect(client.request<{ id: number }>(getProduct, { id: 42 })).resolves.toEqual({ id: 42 });
});
```

For error mapping, return a non-2xx response with `{ success: false, error: { code, message } }` and
assert `ApiError` (including `code` and `operationId`); make the responder throw and assert
`ApiTransportError`.

---

## Testing the 401 Refresh-and-Retry

Return 401 on the first send and success on the second, then assert the retry count and header.

```typescript
test('refreshes once on 401, then retries', async () => {
  let calls = 0;
  const adapter = new StubAdapter(() => {
    calls += 1;
    return calls === 1
      ? { status: 401, ok: false, body: { success: false, error: { code: 'unauthorized' } } }
      : dataResponse({ ok: true });
  });
  const auth = new BearerAuth({ getToken: async () => 'old', refresh: async () => 'new' });
  const client = createApiClient({ baseUrl: 'https://x', adapter, auth });

  await client.request(getProduct, { id: 1 });

  expect(adapter.requests).toHaveLength(2);
  expect(adapter.requests[1].headers.Authorization).toBe('Bearer new');
});
```

To test single-flight refresh, make the responder reject while the token is `'old'`, start two calls
with `Promise.all`, and assert the refresh ran once.

---

## Testing TokenStore with a Fake Clock

Inject `now` so expiry is deterministic; assert caching and the skew boundary.

```typescript
import { TokenStore } from '../src/index.js';

test('refreshes only once the token enters the expiry skew', async () => {
  let clock = 0;
  let calls = 0;
  const store = new TokenStore(
    async () => {
      calls += 1;
      return { token: `token-${calls}`, expiresAt: 10_000 };
    },
    { now: () => clock, skewMs: 1_000 }
  );

  await expect(store.get()).resolves.toBe('token-1');
  clock = 8_000;
  await expect(store.get()).resolves.toBe('token-1');
  clock = 9_500;
  await expect(store.get()).resolves.toBe('token-2');
  expect(calls).toBe(2);
});
```

---

## Testing Auth Strategies and the OIDC Guard

A strategy's `apply` is a pure request transformation, so test it directly: call
`new ApiKeyAuth({ key: 'secret' }).apply(request)` and assert the `X-API-Key` header. The OIDC guards
run in the constructor, so assert with `toThrow`, set `globalThis.window` to a stub first, and restore
it in a `finally`. Avoid real timers and real networks: the stub adapter, an injected clock, and
direct strategy calls cover the whole runtime.

---

# api-client Troubleshooting

---

This guide lists the failures you are most likely to meet, how to recognise them, and the fix. Start
with the diagnostic table, then read the matching section for detail.

---

## Quick Diagnostic Table

| Symptom | Likely cause | Fix |
|---|---|---|
| `Missing value for path parameter "id"` | The flat params object lacked a path field | Pass every `{param}` from the descriptor path |
| Request goes to the wrong URL | `baseUrl` has a double slash or no scheme | Let `baseUrl` end without `/`; include `https://` |
| Query params vanish on `POST`/`PUT`/`PATCH` | Body methods turn all non-path params into the JSON body | Use `GET`/`DELETE`, or send the values in the body |
| A 401 is returned to you, not retried | No `refresh` function or no `refreshOnUnauthorized` | Provide `refresh` to `BearerAuth`, or expect the 401 |
| Every call refreshes the token | A new client or strategy is built per call | Reuse one client and one strategy instance |
| Browser bundle throws for OIDC | `OidcClientCredentialsAuth` is Node-only | Keep it server-side; use cookie-session for browsers |
| Endpoint rejected as insecure | OIDC endpoint is HTTP and not loopback | Use `https://`, or a loopback HTTP dev endpoint |
| `ApiError.message` is generic | The server body was not a valid error envelope | Read `statusCode`; fix the server's error shape |
| `'data'` envelope returns the whole body | Body had no `data` property | Check the server contract; or use `'body'` |
| Pagination missing | The operation used `'data'`, which drops the rest | Use `'body'` and `PaginatedResponse<T>` |
| Token or credential appears in an error | Should not happen — redaction is built in | Report the exact message; check custom error handling |

---

## Missing Path Parameter

`resolvePath` throws rather than silently substituting an empty segment, because that would produce a
different (often collection-level) URL. Pass the value under the same key the path uses; the runtime
percent-encodes it and encodes `.` and `..` so a value cannot traverse to a parent path.

```typescript
// path: '/api/products/{id}'
await client.request(op, {}); // throws: Missing value for path parameter "id" ...
```

---

## A 401 Is Not Retried

The runtime retries a 401 only when the effective strategy defines `refreshOnUnauthorized` and that
call returns `true`. `BearerAuth` returns `false` when no `refresh` function was supplied, because it
has nothing with which to refresh.

```typescript
new BearerAuth({ getToken: () => session.token }); // 401 returned, not retried
new BearerAuth({ getToken: () => session.token, refresh: () => session.refresh() }); // retried once
```

`OidcClientCredentialsAuth` always reports a refresh; `CookieSessionAuth` and `ApiKeyAuth` do not
support refresh at all.

---

## OIDC Throws Immediately

The constructor runs two guards before any request:

1. **Runtime** — it throws unless `window` and `WorkerGlobalScope` are absent and
   `process.versions.node` is a string. This refuses browsers and workers, where a bundled secret
   would be exposed. Do not bypass it; move the call to the server.
2. **Endpoint** — it throws unless the token endpoint is HTTPS or an HTTP loopback address
   (`localhost`, `127.0.0.1`, `::1`). The secret must never travel in cleartext.

```typescript
new OidcClientCredentialsAuth({
  tokenEndpoint: 'https://idp.example.com/token', // must be https
  clientId: process.env.IDP_CLIENT_ID!,
  clientSecret: process.env.IDP_CLIENT_SECRET!,
});
```

---

## Query Parameters Disappear on POST/PUT/PATCH

This is intentional. The runtime splits the flat params with the path, then uses **all** remaining
fields as the JSON body for body methods; it builds no query string. If an operation needs both a
body and query values, express the query values in the body or model the call as a `GET`/`DELETE`.

```typescript
await client.request(
  { method: 'post', path: '/api/products', envelope: 'data', operationId: 'createProduct' },
  { name: 'Widget', price: 9.99 } // both fields become the body
);
```

`serializeBody` returns `undefined` when there are no non-path parameters, so a `POST` with an empty
object sends no body and no `content-type` header.

---

## Pagination Is Missing or the Whole Body Comes Back

`'data'` returns `body.data` and discards everything else, including `pagination`. Use `'body'` for
paginated operations and type the result as `PaginatedResponse<T>`. If a `'data'` envelope
unexpectedly returns the whole body, the body had no `data` property — fix the server's response
shape or deliberately use `'body'`.

```typescript
const page = await client.request<PaginatedResponse<Item>>(
  { method: 'get', path: '/api/items', envelope: 'body', operationId: 'listItems' },
  { page: 1 }
);
```

---

## An Error Message Is Generic

An `ApiError` built from a malformed body falls back to code `'http_error'` and message
``Request failed with status <code>``, meaning no `error` object was found. Correct the server's
error response to include `{ error: { code, message } }`, and meanwhile branch on `statusCode`.

---

## Credentials in an Error Message

The runtime redacts `Bearer`/`Basic` values, JWT-shaped strings, and query parameters named `api_key`,
`access_token`, `token`, or `key` before an error is constructed. If you still see a credential, it is
likely in custom code that bypasses these errors — for example logging `request.headers` directly.
Never log the raw `AdapterRequest`; log the method and URL only.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
