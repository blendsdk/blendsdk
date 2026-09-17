> **Package**: `blendsdk/api-client`

# api-client Core Concepts

---

This guide explains how a call flows from `request()` to a response, what an operation descriptor
and a flat parameter bag are, how envelopes and errors are handled, and how authentication and token
caching work. For hands-on code, see Basic Usage.

---

## The Request Lifecycle

Every call follows the same steps.

1. **Uppercase the method.** The descriptor stores a lowercase method; the runtime normalizes it.
2. **Decide whether a body is allowed.** `GET` and `DELETE` are bodyless; every other method may send
   one.
3. **Split parameters.** Path placeholders are removed; the rest becomes query parameters
   (`GET`/`DELETE`) or the JSON body (other methods).
4. **Resolve the base URL.** A per-call `baseUrl` wins over the client's `baseUrl`.
5. **Resolve and encode the path.** Each `{param}` is replaced with its encoded value; a missing
   value throws instead of producing a wrong URL.
6. **Build the body.** The remaining parameters are serialized with `JSON.stringify`; an empty bag
   means no body.
7. **Set default headers.** Client headers are copied; `content-type: application/json` is added when
   a body exists and no content type is set.
8. **Apply authentication.** The per-call `auth` wins over the client default; per-call headers are
   merged last.
9. **Send and retry once.** A 401 triggers one refresh-and-retry when the strategy supports it.
10. **Map the result.** Non-2xx becomes `ApiError`; success is unwrapped per the envelope.

Because body methods consume all non-path parameters as the body, this runtime does not send a query
string on `POST`, `PUT`, or `PATCH`. Put query-only values on `GET`/`DELETE` operations, or include
them as body fields.

---

## The Operation Descriptor

Generated methods never hard-code URLs. They pass an `OperationDescriptor` — plain data the runtime
can execute without an OpenAPI document:

```typescript
interface OperationDescriptor {
  method: string;             // HTTP method, lowercase
  path: string;               // OpenAPI path with {param} placeholders
  envelope: 'data' | 'body';  // whether to unwrap the `data` property
  operationId: string;        // stable id, used in error messages
}
```

The `operationId` is not sent to the server. It is attached to every `ApiError` and
`ApiTransportError`, so a failure can be traced back to the exact generated method.

---

## Flat Parameters

`RequestParams` is one object holding path, query, and body fields together; generated clients
synthesize it from the operation's path parameters, query parameters, and request body.

```typescript
type RequestParams = Record<string, unknown>;
```

For `GET` and `DELETE`, the non-path entries become the query string; arrays produce repeated keys
(`tag=a&tag=b`) and `undefined` values are omitted. For body methods, they become the JSON body. A
`__proto__` key is dropped so a parameter cannot change an object's prototype.

---

## The Response Envelope

WebAFX wraps every successful response as `{ success: true, data }`. The operation's `envelope` says
which part the caller receives:

| Envelope | Returned value | Use when |
|---|---|---|
| `'data'` | `body.data` when the body is an object with a `data` property; otherwise the body unchanged | The payload is under `data` |
| `'body'` | The whole body | You need the surrounding fields — most often `pagination` |

Paginated operations use `'body'` so the metadata is not lost. The shape is `PaginatedResponse<T>`:

```typescript
interface PaginatedResponse<T> {
  success: true;
  data: T[];
  pagination: { total: number; page: number; limit: number; pages: number };
}
```

A `'data'` envelope is forgiving: if the body is not an object, has no `data` property, or is
`undefined`, the runtime returns it as-is rather than throwing.

---

## The Authentication Boundary

An `AuthStrategy` applies credentials and reports whether it can refresh them after a 401:

```typescript
interface AuthStrategy {
  readonly scheme: string;
  apply(request: AdapterRequest): Promise<AdapterRequest>;
  refreshOnUnauthorized?(): Promise<boolean>;
}
```

| Strategy | `scheme` | Behavior |
|---|---|---|
| `CookieSessionAuth` | `'cookie'` | Sets `credentials: 'include'`; the browser supplies the cookie |
| `ApiKeyAuth` | `'apiKey'` | Sends the key in a header (default `X-API-Key`); query placement is opt-in and warns |
| `BearerAuth` | `'bearerAuth'` | Sends `Authorization: Bearer <token>`; refreshes once on 401 |
| `OidcClientCredentialsAuth` | `'oauth2'` | Node-only; exchanges client credentials for a token at the IdP |

The runtime calls `refreshOnUnauthorized()` only when the strategy defines it and the status is
exactly `401`, and it retries at most once. A `403` is never retried.

---

## Token Caching and Single-Flight Refresh

`BearerAuth` and `OidcClientCredentialsAuth` both use `TokenStore`. It caches a token until shortly
before expiry — default skew 5000 ms — and stores the in-flight refresh promise so concurrent callers
await one shared result. `TokenStoreOptions` offers `now?: () => number` (clock, for tests) and
`skewMs?: number`.

If a refresh fails, the failure is shared by every caller that joined it, the in-flight state is
cleared, and the next call starts a fresh attempt. This prevents a burst of simultaneous 401s from
making a burst of token requests.

---

## The Transport Seam

The runtime never calls `fetch` directly. It builds an `AdapterRequest` and passes it to a
`RequestAdapter` whose single method is `send(request): Promise<AdapterResponse>`. `FetchAdapter` is
the default; substituting an adapter is how tests avoid the network and how applications add logging,
caching, or another transport. `FetchAdapter` parses a JSON body and falls back to raw text so an
HTML error page cannot hide the status code.

---

## The Error Model

| Class | Raised when | Key fields |
|---|---|---|
| `ApiError` | Non-2xx response | `statusCode`, `code`, `message`, `details?`, `requestId?`, `operationId` |
| `ApiTransportError` | No response existed: network failure, abort, or a failed credential fetch | `operationId`, `cause?` |

A malformed error body still produces an `ApiError`: the code falls back to `'http_error'` and the
message to ``Request failed with status <code>``. Before either error is built, credential material
is removed: `Bearer`/`Basic` values, JWT-shaped strings, and query parameters named `api_key`,
`access_token`, `token`, or `key` become `[redacted]`. Structured `details` are redacted recursively.

---

## Why the Runtime Has No Zod

The server validates every request, and generated client types are erased at run time, so importing
Zod here would add weight without adding a guarantee. The package therefore has no Zod dependency,
and generated clients must not add one either: it keeps one Zod version across the application and
keeps the browser bundle lean.

---

# api-client Basic Usage

---

This guide walks from installation to a working call: creating a client, invoking an operation,
passing parameters, reading the payload, adding an auth strategy, and handling errors. For the design
behind these steps, see Core Concepts.

---

## Installation

```bash
npm install blendsdk/api-client    # or: yarn add / pnpm add
```

Inside the BlendSDK monorepo the dependency resolves through the workspace, and the umbrella package
re-exports it as `blendsdk/api-client`. Requirements: Node.js `>= 22.0.0`, ESM only, no runtime
dependencies. Browsers and Node.js are supported; OIDC client-credentials is Node-only.

---

## Quick Start

Create a client, then call `request` with an operation descriptor and a flat parameter object:

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

console.log(product.name); // the value of body.data
```

That is the entire runtime contract. Generated clients wrap this pattern in typed methods, so you
usually call `client.products.getProduct({ id: 42 })` instead.

---

## Creating a Client

| Option | Type | Required | Description |
|---|---|---|---|
| `baseUrl` | `string` | Yes | Prepended to every operation path |
| `adapter` | `RequestAdapter` | No | Transport; defaults to `new FetchAdapter()` |
| `auth` | `AuthStrategy` | No | Default authentication strategy |
| `headers` | `Record<string, string>` | No | Default headers merged into every request |

```typescript
import { createApiClient, CookieSessionAuth } from 'blendsdk/api-client';

const client = createApiClient({
  baseUrl: '/api', // a trailing slash is ignored
  auth: new CookieSessionAuth(),
  headers: { 'X-App-Version': '1.4.0' },
});
```

---

## Calling an Operation

`request<T>(operation, params?, options?)` returns `Promise<T>`, where `T` is the unwrapped payload.
Pass the operation id for traceability in error messages. A method with no parameters omits the
params argument entirely.

```typescript
const created = await client.request<{ id: number }>(
  { method: 'post', path: '/api/products', envelope: 'data', operationId: 'createProduct' },
  { name: 'Widget', price: 9.99 }
);
```

---

## Passing Parameters

One flat object carries every field. How those fields travel depends on the method:

| Method | Path fields | Other fields |
|---|---|---|
| `GET` | Encoded into the path | Serialized as the query string |
| `DELETE` | Encoded into the path | Serialized as the query string |
| `POST`, `PUT`, `PATCH` | Encoded into the path | Serialized as the JSON body |

```typescript
const page = await client.request<unknown>(
  { method: 'get', path: '/api/products', envelope: 'data', operationId: 'listProducts' },
  { page: 2, limit: 20, tags: ['sale', 'new'] }
);
// GET https://api.example.com/api/products?page=2&limit=20&tags=sale&tags=new
```

A missing path value is an error, not an empty segment: the runtime throws
`Missing value for path parameter "<name>"` rather than produce a wrong URL.

---

## Envelope Handling

The `envelope` field decides what `request` returns. `'data'` unwraps the payload
(`{ success: true, data: { value: 1 } }` → `{ value: 1 }`); `'body'` returns the whole body, so
surrounding fields such as `pagination` survive. A `'data'` envelope is forgiving: if the body has no
`data` property — or is not an object — the body is returned unchanged.

```typescript
// 'body' keeps pagination; 'data' would discard it
const body = await client.request<{ success: true; data: number[]; pagination: { page: number } }>(
  { method: 'get', path: '/api/items', envelope: 'body', operationId: 'listItems' }
);
```

---

## Adding Authentication

Pass an `AuthStrategy` once at construction, or override it per call. `CookieSessionAuth` needs no
token handling; `ApiKeyAuth` sends the key in a header by default (`X-API-Key` unless named
otherwise). Bearer and OIDC strategies are covered in Advanced Patterns.

```typescript
import { ApiKeyAuth, createApiClient } from 'blendsdk/api-client';

createApiClient({
  baseUrl: 'https://api.example.com',
  auth: new ApiKeyAuth({ key: process.env.API_KEY! }),
});
```

---

## Handling Errors

Both error classes carry the `operationId`. Branch on `error.code`, not the message text: messages
come from the server and can change; codes are stable.

```typescript
import { ApiError, ApiTransportError } from 'blendsdk/api-client';

try {
  const product = await client.request<Product>(
    { method: 'get', path: '/api/products/{id}', envelope: 'data', operationId: 'getProduct' },
    { id: 42 }
  );
  console.log(product.name);
} catch (error) {
  if (error instanceof ApiError) {
    console.error(error.statusCode, error.code, error.message);
    // 404 not_found Product 42 does not exist
  } else if (error instanceof ApiTransportError) {
    console.error('transport failure in', error.operationId, error.message);
  } else {
    throw error;
  }
}
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
