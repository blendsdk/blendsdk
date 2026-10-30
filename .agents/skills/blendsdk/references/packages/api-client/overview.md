> **Package**: `blendsdk/api-client`

# api-client Overview

---

## What It Is

`blendsdk/api-client` is the small, framework-agnostic runtime that executes HTTP calls for
generated BlendSDK clients. It owns URL building, path and query encoding, request-body
serialization, authentication, the 401 refresh-and-retry policy, error normalization, and
response-envelope unwrapping. Generated clients are thin wrappers: each method builds an
`OperationDescriptor`, forwards one flat parameter object, and returns the typed payload that
`request()` resolves.

The package is deliberately minimal. It exposes one factory (`createApiClient`), one runtime method
(`request`), four authentication strategies, one swappable transport seam, and two error classes. It
targets browsers and Node.js, except for `OidcClientCredentialsAuth`, which is Node-only. It has no
runtime dependencies — in particular it does not import Zod — so an application keeps exactly one Zod
version and the browser bundle stays small.

---

## Key Features

- **One request method** — `request(operation, params?, options?)` handles every operation.
- **Operation descriptors** — generated methods pass plain `{ method, path, envelope, operationId }`
  objects; no OpenAPI document is needed at run time.
- **Flat parameters** — path, query, and body values travel in one object that mirrors the server's
  merged validation object.
- **Envelope unwrapping** — `'data'` returns `body.data`; `'body'` returns the whole body so
  pagination metadata survives. `PaginatedResponse<T>` types the `'body'` case.
- **Four authentication strategies** — `CookieSessionAuth`, `ApiKeyAuth`, `BearerAuth`, and
  `OidcClientCredentialsAuth`, each keyed by OpenAPI security-scheme name.
- **Refresh once on 401** — a strategy that can refresh is invoked at most once, then the request is
  retried once.
- **Single-flight token refresh** — `TokenStore` collapses concurrent refreshes into one token
  request.
- **Swappable transport** — `RequestAdapter` is the only external boundary; `FetchAdapter` is the
  default.
- **Normalized, redacted errors** — `ApiError` for non-2xx responses, `ApiTransportError` for
  network or abort failures; neither exposes a token or credential.
- **Generated clients** — `createAppClient` plus group namespaces, produced by
  `blendsdk api generate` and guarded by `blendsdk api check`.

---

## When To Use

Use it when you call a BlendSDK API from a browser app, run a Node machine-to-machine job with the
OAuth 2.0 client-credentials grant, consume a generated client, need one consistent place for auth
and error mapping, or want to stub the transport in tests.

Look elsewhere when you need a full HTTP library with automatic retries, caching, or interceptors;
automatic timeouts (the runtime imposes none — the caller owns the `AbortSignal`); or client-side
schema validation (the server validates requests).

---

## Architecture

The runtime is a one-way pipeline. The client builds an `AdapterRequest`, applies auth, hands the
request to a `RequestAdapter`, maps the `AdapterResponse`, and unwraps the envelope.

```text
createApiClient(options) ──► RuntimeClient
                                   │  request(operation, params, options)
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
        resolvePath            auth.apply          per-call headers
        serializeQuery/body    (AuthStrategy)     (win, case-insensitive)
              └────────────► AdapterRequest ◄──────────┘
                                   │
                          RequestAdapter.send (FetchAdapter default)
                                   │
            ┌───────────┬──────────┴──────────┐
            ▼           ▼                     ▼
        401 + can    non-2xx               2xx
        refresh?     → ApiError            → unwrapResponse
        retry once                         ('data' | 'body')
```

**Design patterns.** Authentication is a **Strategy**: the runtime depends on `AuthStrategy`, never a
concrete class. Transport is an **Adapter**: `RequestAdapter` isolates `fetch`. `createApiClient` is a
**Factory** closing over the base URL, adapter, auth, and default headers. `TokenStore` provides
**single-flight** refresh by storing the in-flight promise.

### Public Surface at a Glance

| Export | Kind | Role |
|---|---|---|
| `createApiClient` | Function | Builds a `RuntimeClient` |
| `RuntimeClient`, `ApiClientOptions`, `RequestOptions`, `OperationDescriptor` | Types | Client and per-call contract |
| `RequestParams`, `ParamValue`, `JsonValue` | Types | Flat parameter bag |
| `unwrapResponse`, `PaginatedResponse` | Function / Type | Envelope handling |
| `ApiError`, `ApiTransportError`, `createApiError`, `createTransportError`, `redactSensitive`, `redactValue` | Classes / Functions | Normalized, redacted failures |
| `AuthStrategy`, `CookieSessionAuth`, `ApiKeyAuth`, `BearerAuth`, `OidcClientCredentialsAuth` | Interface / Classes | Authentication |
| `TokenStore` | Class | Token caching and single-flight refresh |
| `RequestAdapter`, `FetchAdapter`, `AdapterRequest`, `AdapterResponse` | Interface / Class / Types | Transport boundary |
| `buildUrl`, `resolvePath`, `omitPathParams`, `extractPathParamNames`, `appendQuery`, `serializeQuery`, `serializeBody` | Functions | URL and parameter serialization |

---

## Dependencies

**Runtime dependencies: none.** The runtime uses the standard library plus platform globals
(`fetch`, `URLSearchParams`, `AbortSignal`) and does not import Zod. **Peer dependencies: none.**

| Requirement | Detail |
|---|---|
| Node.js | `>= 22.0.0` |
| Module system | ESM only — a single `import` entry point |
| Runtime | Browsers and Node.js; `OidcClientCredentialsAuth` is Node-only |
| TypeScript | `strict` mode recommended; declarations ship with the package |

**Relationships.** It depends on nothing inside or outside the monorepo. It is designed for generated
clients produced by `blendsdk/codegen` and the `blendsdk api` commands, and it ships through the
`blendsdk` umbrella as `blendsdk/api-client`. It is marked `"private": true` in the monorepo.

---

## Minimum Example

```typescript
import { createApiClient, CookieSessionAuth } from 'blendsdk/api-client';

interface Product {
  id: number;
  name: string;
  price: number;
}

const client = createApiClient({
  baseUrl: 'https://api.example.com',
  auth: new CookieSessionAuth(),
});

const product = await client.request<Product>(
  { method: 'get', path: '/api/products/{id}', envelope: 'data', operationId: 'getProduct' },
  { id: 42 }
);

console.log(product.name);
```

`request()` resolves with the unwrapped payload. On a non-2xx response it throws `ApiError`; on a
network or abort failure it throws `ApiTransportError`.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
