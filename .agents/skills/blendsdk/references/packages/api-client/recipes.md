> **Package**: `blendsdk/api-client`

# api-client Advanced Patterns

---

These patterns go beyond a single call: swapping the transport, overriding options per call, letting
`BearerAuth` refresh tokens automatically, authenticating Node jobs with OIDC, reading pagination,
and cancelling requests.

---

## Custom Transport Adapter

Implement `RequestAdapter` to inspect, log, or cache requests. It is the only true external boundary,
so this is also the seam tests use.

```typescript
import {
  FetchAdapter,
  createApiClient,
  type AdapterRequest,
  type AdapterResponse,
  type RequestAdapter,
} from 'blendsdk/api-client';

class LoggingAdapter implements RequestAdapter {
  constructor(private readonly inner: RequestAdapter) {}

  async send(request: AdapterRequest): Promise<AdapterResponse> {
    const started = Date.now();
    try {
      return await this.inner.send(request);
    } finally {
      console.log(request.method, request.url, Date.now() - started, 'ms');
    }
  }
}

const client = createApiClient({
  baseUrl: 'https://api.example.com',
  adapter: new LoggingAdapter(new FetchAdapter()),
});
```

Log the method and URL only — never the headers, which carry credentials.

---

## Per-Call Overrides

`RequestOptions` overrides the client defaults for one call: cancel with `signal`, override `baseUrl`,
override `auth`, or add headers.

```typescript
const report = await client.request<Report>(
  { method: 'get', path: '/api/reports/{id}', envelope: 'data', operationId: 'getReport' },
  { id: 7 },
  {
    baseUrl: 'https://reports.example.com',
    auth: new ApiKeyAuth({ key: process.env.REPORTS_KEY! }),
    headers: { 'X-Tenant': 'acme' },
  }
);
```

Header precedence is **client defaults < auth < per-call headers**, and the comparison is
case-insensitive: a per-call header whose name differs only in case replaces the earlier value rather
than duplicating it.

---

## Automatic Token Refresh with BearerAuth

`BearerAuth` calls `getToken` for the current token. When you also provide `refresh`, the runtime
retries one 401 with a fresh token, and concurrent 401s share a single refresh.

```typescript
import { BearerAuth, createApiClient } from 'blendsdk/api-client';

const auth = new BearerAuth({
  getToken: () => session.accessToken,
  refresh: () => session.refresh(),
  refreshedTokenTtlMs: 30_000,
});

const client = createApiClient({ baseUrl: '/api', auth });
```

A refreshed token is reused for a short window (default 30000 ms), so the retry and any concurrent
request sharing the instance use it; after that, `getToken` is authoritative again. Call
`invalidate()` on logout or key rotation to drop the cached token immediately. Without a `refresh`
function, `refreshOnUnauthorized()` returns `false` and a 401 is surfaced unchanged — no retry.

---

## Node Machine-to-Machine with OIDC

`OidcClientCredentialsAuth` implements the OAuth 2.0 client-credentials grant. It is Node-only: the
constructor throws in a browser or worker, so a client secret can never be shipped to a browser.

```typescript
import { createApiClient, OidcClientCredentialsAuth } from 'blendsdk/api-client';

const auth = new OidcClientCredentialsAuth({
  tokenEndpoint: process.env.IDP_TOKEN_URL!,
  clientId: process.env.IDP_CLIENT_ID!,
  clientSecret: process.env.IDP_CLIENT_SECRET!,
  scope: 'api.read',
});

const client = createApiClient({ baseUrl: 'https://api.example.com', auth });
```

The token endpoint must use HTTPS; plain HTTP is allowed only for a loopback endpoint (`localhost`,
`127.0.0.1`, or `::1`). Token requests set `redirect: 'error'`, so the secret is never forwarded to
another host. A missing `access_token` is an error, and `expires_in` defaults to 3600 seconds when
the identity provider omits it. Refreshes are coalesced through `TokenStore`.

---

## Handling Paginated Responses

A paginated operation uses the `'body'` envelope, so the returned type is `PaginatedResponse<T>` and
the `pagination` object survives unwrapping.

```typescript
import type { PaginatedResponse } from 'blendsdk/api-client';

const page = await client.request<PaginatedResponse<{ id: number; name: string }>>(
  { method: 'get', path: '/api/products', envelope: 'body', operationId: 'listProducts' },
  { page: 1, limit: 20 }
);

console.log(page.data.length, 'of', page.pagination.total);
console.log('page', page.pagination.page, 'of', page.pagination.pages);
```

Generated clients expose this type already; you do not write the generic by hand.

---

## Cancelling Requests with AbortSignal

The runtime imposes no timeout. Pass an `AbortSignal` and abort it yourself; an abort becomes an
`ApiTransportError` and is never retried.

```typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 5_000);

try {
  await client.request<unknown>(
    { method: 'get', path: '/api/slow', envelope: 'data', operationId: 'slow' },
    {},
    { signal: controller.signal }
  );
} finally {
  clearTimeout(timeout);
}
```

For a custom header scheme the built-in strategies do not cover, implement `AuthStrategy`: set
`scheme`, apply headers in `apply`, and add `refreshOnUnauthorized` only if the credentials can be
refreshed.

---

# api-client Common Scenarios

---

Answers to the "How do I…?" questions that come up most often. Every scenario uses real names and
shows the whole call, not a fragment.

---

## How do I call an endpoint that needs a session cookie?

Use `CookieSessionAuth`. The browser owns the cookie; the strategy only asks the request to include
credentials.

```typescript
import { createApiClient, CookieSessionAuth } from 'blendsdk/api-client';

const client = createApiClient({ baseUrl: '/api', auth: new CookieSessionAuth() });

const me = await client.request<{ id: number; name: string }>({
  method: 'get',
  path: '/api/auth/me',
  envelope: 'data',
  operationId: 'getCurrentUser',
});
```

The server must still set `SameSite`, enforce CSRF protection, and validate the session.

---

## How do I authenticate with a static API key?

`ApiKeyAuth` sends the key in a header by default (`X-API-Key` unless you name another).

```typescript
import { ApiKeyAuth, createApiClient } from 'blendsdk/api-client';

const client = createApiClient({
  baseUrl: 'https://api.example.com',
  auth: new ApiKeyAuth({ key: process.env.API_KEY!, name: 'X-Service-Key' }),
});
```

---

## How do I run machine-to-machine in Node?

Use `OidcClientCredentialsAuth`; the secret stays on the server.

```typescript
import { createApiClient, OidcClientCredentialsAuth } from 'blendsdk/api-client';

const auth = new OidcClientCredentialsAuth({
  tokenEndpoint: process.env.IDP_TOKEN_URL!,
  clientId: process.env.IDP_CLIENT_ID!,
  clientSecret: process.env.IDP_CLIENT_SECRET!,
});

const client = createApiClient({ baseUrl: 'https://api.example.com', auth });
```

---

## How do I refresh an expired token automatically?

Give `BearerAuth` a `refresh` function. On a 401 the runtime refreshes once and retries once, and
concurrent 401s share a single refresh.

```typescript
import { BearerAuth, createApiClient } from 'blendsdk/api-client';

const auth = new BearerAuth({
  getToken: () => session.token,
  refresh: () => session.refresh(),
});

const client = createApiClient({ baseUrl: '/api', auth });
```

---

## How do I read pagination metadata?

Set `envelope: 'body'` and type the result as `PaginatedResponse<T>`. The `'data'` envelope would
discard `pagination`.

```typescript
import type { PaginatedResponse } from 'blendsdk/api-client';

const page = await client.request<PaginatedResponse<{ id: number }>>(
  { method: 'get', path: '/api/products', envelope: 'body', operationId: 'listProducts' },
  { page: 3, limit: 20 }
);

console.log(`page ${page.pagination.page} of ${page.pagination.pages}`);
```

---

## How do I cancel a request or add a timeout?

Create an `AbortController`, pass its signal, and abort on your own schedule. An abort surfaces as
`ApiTransportError`.

```typescript
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 3_000);

try {
  await client.request(op, params, { signal: controller.signal });
} finally {
  clearTimeout(timer);
}
```

---

## How do I add a header to every request, or change auth for one call?

Pass default headers to `createApiClient`; override `baseUrl`, `auth`, `headers`, or `signal` per call
with `RequestOptions`. No second client is needed.

```typescript
const client = createApiClient({
  baseUrl: '/api',
  headers: { 'X-App-Version': '2.0.0', 'Accept-Language': 'en' },
});

await client.request(op, params, {
  baseUrl: 'https://reports.example.com',
  auth: new ApiKeyAuth({ key: process.env.REPORTS_KEY! }),
});
```

---

## How do I regenerate a client after a server change?

Update the controller or OpenAPI contract, then run generate and check.

```bash
blendsdk api generate --config packages/playground/blendsdk.api.ts
blendsdk api check --config packages/playground/blendsdk.api.ts
```

`generate` rewrites the contract JSON and the client under `outputDir`; `check` fails when either
committed artifact drifts.

---

# api-client Examples Library

---

Every example here is a complete module: imports, types, and the call. They run from simple to
advanced — a bare `GET`, a body write, a paginated list, bearer refresh, an API key, and the
generated-client surface.

---

## 1. A Minimal GET

```typescript
import { createApiClient } from 'blendsdk/api-client';

interface Product {
  id: number;
  name: string;
  price: number;
}

const client = createApiClient({ baseUrl: 'https://api.example.com' });

const product = await client.request<Product>(
  { method: 'get', path: '/api/products/{id}', envelope: 'data', operationId: 'getProduct' },
  { id: 42 }
);

console.log(product.name);
// GET https://api.example.com/api/products/42
```

---

## 2. A Write with a JSON Body

```typescript
import { createApiClient } from 'blendsdk/api-client';

const client = createApiClient({ baseUrl: 'https://api.example.com' });

const created = await client.request<{ id: number; name: string }>(
  { method: 'post', path: '/api/products', envelope: 'data', operationId: 'createProduct' },
  { name: 'Widget', price: 9.99, tags: ['sale'] }
);

console.log(created.id);
// POST /api/products with body {"name":"Widget","price":9.99,"tags":["sale"]}
```

---

## 3. A Paginated List

```typescript
import { createApiClient, type PaginatedResponse } from 'blendsdk/api-client';

interface Product {
  id: number;
  name: string;
}

const client = createApiClient({ baseUrl: 'https://api.example.com' });

const page = await client.request<PaginatedResponse<Product>>(
  { method: 'get', path: '/api/products', envelope: 'body', operationId: 'listProducts' },
  { page: 1, limit: 20, sortBy: 'name' }
);

console.log(`showing ${page.data.length} of ${page.pagination.total}`);
```

The `'body'` envelope keeps `pagination`; `'data'` would have discarded it.

---

## 4. Bearer Token with Automatic Refresh

```typescript
import { BearerAuth, createApiClient } from 'blendsdk/api-client';

interface Session {
  token: string;
  refresh: () => Promise<string>;
}

function makeClient(session: Session) {
  const auth = new BearerAuth({
    getToken: () => session.token,
    refresh: () => session.refresh(),
  });

  return createApiClient({ baseUrl: 'https://api.example.com', auth });
}

const client = makeClient(session);

const me = await client.request<{ id: number; name: string }>({
  method: 'get',
  path: '/api/auth/me',
  envelope: 'data',
  operationId: 'getCurrentUser',
});
```

On a 401 the runtime refreshes once and retries once; ten concurrent 401s share one refresh.

---

## 5. A Static API Key and a Custom Header

```typescript
import { ApiKeyAuth, createApiClient } from 'blendsdk/api-client';

const client = createApiClient({
  baseUrl: 'https://api.example.com',
  auth: new ApiKeyAuth({ key: process.env.API_KEY!, name: 'X-Service-Key' }),
  headers: { 'Accept-Language': 'en', 'X-App-Version': '2.0.0' },
});

const weather = await client.request<{ tempC: number }>(
  { method: 'get', path: '/api/weather', envelope: 'data', operationId: 'weather' },
  { city: 'Amsterdam' },
  { headers: { 'X-Tenant': 'acme' } } // per-call header wins over defaults
);
```

---

## 6. The Generated Client Surface

Generated clients wrap `request` in typed methods grouped by namespace. A method with parameters takes
them plus optional per-call options; a method with none takes only options.

```typescript
import { createAppClient, type AppClient } from './generated/api-client/index.js';
import type { ProductsGetProductResult } from './generated/api-client/types.js';

const client: AppClient = createAppClient({ baseUrl: 'http://localhost:4000' });

const product: ProductsGetProductResult = await client.products.getProduct({ id: 42 });
console.log(product.name);

const users = await client.admin.adminListUsers();
```

Parameters and results are typed from the OpenAPI contract, so a server rename surfaces here at
compile time. Regenerate whenever a controller route or its metadata changes:

```bash
blendsdk api generate --config packages/playground/blendsdk.api.ts
blendsdk api check    --config packages/playground/blendsdk.api.ts
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
