> **Package**: `blendsdk/api-client`

# api-client API Reference

---

Complete reference for every symbol exported from the package root. Runtime values are imported
normally; types are imported with `import type`.

| Export | Kind | Summary |
|---|---|---|
| `createApiClient` | Function | Builds a `RuntimeClient` |
| `RuntimeClient` | Interface | The `request` surface generated clients call |
| `ApiClientOptions` | Interface | Base URL, adapter, auth, and default headers |
| `RequestOptions` | Interface | Per-call `signal`, `headers`, `baseUrl`, and `auth` |
| `OperationDescriptor` | Interface | `{ method, path, envelope, operationId }` |
| `RequestParams` | Type | `Record<string, unknown>` flat parameter bag |
| `ParamValue` | Type | `string \| number \| boolean \| null \| undefined` |
| `JsonValue` | Type | `ParamValue \| JsonValue[] \| { [key: string]: JsonValue }` |
| `unwrapResponse` | Function | Applies an envelope to a response body |
| `PaginatedResponse<T>` | Interface | Typed body for the `'body'` envelope |
| `ApiError`, `ApiTransportError` | Classes | Normalized failures |
| `createApiError`, `createTransportError`, `redactSensitive`, `redactValue` | Functions | Error construction and redaction |
| `AuthStrategy` | Interface | `scheme`, `apply`, optional `refreshOnUnauthorized` |
| `CookieSessionAuth`, `ApiKeyAuth`, `BearerAuth`, `OidcClientCredentialsAuth` | Classes | Authentication strategies |
| `TokenStore` | Class | Caching and single-flight refresh |
| `TokenResult`, `TokenStoreOptions` | Types | Token value and store options |
| `BearerAuthOptions`, `ApiKeyAuthOptions`, `OidcClientCredentialsOptions` | Types | Strategy options |
| `RequestAdapter`, `FetchAdapter` | Interface / Class | Transport seam and default implementation |
| `AdapterRequest`, `AdapterResponse` | Interfaces | Transport request and response |
| `extractPathParamNames`, `resolvePath`, `omitPathParams` | Functions | Path parsing and substitution |
| `buildUrl`, `appendQuery`, `serializeQuery`, `serializeBody` | Functions | URL and body serialization |

---

## Functions

### `createApiClient(options: ApiClientOptions): RuntimeClient`

Builds the runtime client. The adapter defaults to `new FetchAdapter()`. A trailing slash on
`baseUrl` is ignored.

### `RuntimeClient.request<T>(operation, params?, options?): Promise<T>`

Builds and sends one request. `params` defaults to `{}`; `options` defaults to `{}`. A missing path
value throws an `Error`; a non-2xx response throws `ApiError`; a send or credential-fetch failure
throws `ApiTransportError`. `T` is the unwrapped payload.

### Error construction

| Function | Signature | Returns |
|---|---|---|
| `createApiError` | `(statusCode: number, body: unknown, operationId: string)` | `ApiError` |
| `createTransportError` | `(cause: unknown, operationId: string)` | `ApiTransportError` |
| `redactSensitive` | `(message: string)` | Message with credentials replaced by `[redacted]` |
| `redactValue` | `(value: unknown)` | Copy with credentials removed from every string |

`redactSensitive` handles `Bearer`/`Basic` values, JWT-shaped strings (`eyJ…`), and the query
parameters `api_key`, `access_token`, `token`, and `key`.

### Envelope and URL helpers

| Function | Signature | Returns |
|---|---|---|
| `unwrapResponse` | `<T>(envelope: 'data' \| 'body', body: unknown)` | `body.data` for `'data'`, otherwise the body |
| `extractPathParamNames` | `(path: string)` | `string[]` placeholder names in order |
| `resolvePath` | `(path: string, params: RequestParams)` | Path with encoded values; throws when a value is missing |
| `omitPathParams` | `(path: string, params: RequestParams)` | Parameters not consumed by the path (`__proto__` dropped) |
| `buildUrl` | `(baseUrl: string, path: string, query: RequestParams)` | Absolute URL with a query string when non-empty |
| `appendQuery` | `(url: string, key: string, value: string)` | URL with one encoded query parameter appended |
| `serializeQuery` | `(params: RequestParams)` | Query string without a leading `?`; arrays repeat the key |
| `serializeBody` | `(params: RequestParams)` | JSON body, or `undefined` when empty |

---

## Classes

| Class | Signature | Notes |
|---|---|---|
| `FetchAdapter` | `send(request: AdapterRequest): Promise<AdapterResponse>` | Default transport; parses JSON, falls back to text |
| `ApiError` | `new (message, { statusCode, code, details?, requestId?, operationId })` | Fields: `statusCode`, `code`, `details?`, `requestId?`, `operationId` |
| `ApiTransportError` | `new (message, { operationId, cause? })` | Fields: `operationId`, `cause?` |
| `TokenStore` | `new (fetchToken: () => Promise<TokenResult>, options?: TokenStoreOptions)` | Methods `get(): Promise<string>` and `refresh(): Promise<string>` |

`TokenStore.get` returns the cached token until `now + skewMs` reaches `expiresAt`, then refreshes.
`refresh` shares one in-flight promise among concurrent callers; a rejected refresh is shared once,
then the next call retries.

| Class | Constructor options | Extra members |
|---|---|---|
| `CookieSessionAuth` | none | Sets `credentials: 'include'` |
| `ApiKeyAuth` | `{ key: string; name?: string; in?: 'header' \| 'query' }` | Warns once on query placement |
| `BearerAuth` | `{ getToken; refresh?; refreshedTokenTtlMs?; now? }` | `invalidate(): void` |
| `OidcClientCredentialsAuth` | `{ tokenEndpoint; clientId; clientSecret; scope? }` | Node-only; throws on insecure endpoints |

`BearerAuth.getToken` and `refresh` return `string | Promise<string>`; `refreshedTokenTtlMs` defaults
to 30000.

---

## Interfaces and Types

```typescript
interface ApiClientOptions {
  baseUrl: string;
  adapter?: RequestAdapter;
  auth?: AuthStrategy;
  headers?: Record<string, string>;
}

interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  baseUrl?: string;
  auth?: AuthStrategy;
}

interface OperationDescriptor {
  method: string;             // lowercase HTTP method
  path: string;               // OpenAPI path with {param} placeholders
  envelope: 'data' | 'body';
  operationId: string;
}

interface AdapterRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  credentials?: RequestCredentials;
}

interface AdapterResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

interface RequestAdapter {
  send(request: AdapterRequest): Promise<AdapterResponse>;
}

interface AuthStrategy {
  readonly scheme: string;
  apply(request: AdapterRequest): Promise<AdapterRequest>;
  refreshOnUnauthorized?(): Promise<boolean>;
}

interface TokenResult {
  token: string;
  expiresAt: number; // epoch milliseconds
}

interface TokenStoreOptions {
  now?: () => number;
  skewMs?: number; // defaults to 5000
}

interface PaginatedResponse<T> {
  success: true;
  data: T[];
  pagination: { total: number; page: number; limit: number; pages: number };
}

type ParamValue = string | number | boolean | null | undefined;
type JsonValue = ParamValue | JsonValue[] | { [key: string]: JsonValue };
type RequestParams = Record<string, unknown>;
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
