/**
 * The API client factory.
 *
 * `createApiClient` returns the small runtime surface that generated clients
 * call: one `request` method that takes an operation descriptor, a flat params
 * object, and per-call options. It owns URL building, authentication, the 401
 * refresh-and-retry policy, error normalization, and envelope unwrapping.
 *
 * @module
 */
import type { AuthStrategy } from './auth/strategy.js';
import { unwrapResponse } from './envelope.js';
import { createApiError, createTransportError } from './errors.js';
import {
  buildUrl,
  omitPathParams,
  resolvePath,
  serializeBody,
  type RequestParams,
} from './request.js';
import {
  FetchAdapter,
  type AdapterRequest,
  type AdapterResponse,
  type RequestAdapter,
} from './transport.js';

/**
 * The descriptor every generated method passes to `client.request`.
 */
export interface OperationDescriptor {
  /** HTTP method, lowercase. */
  method: string;
  /** OpenAPI path with `{param}` placeholders. */
  path: string;
  /** Whether to unwrap the `data` property. */
  envelope: 'data' | 'body';
  /** Stable operation id, used in error messages. */
  operationId: string;
}

/**
 * Per-call options. No timeout is imposed; the caller owns the `AbortSignal`.
 */
export interface RequestOptions {
  /** Cancels the request. */
  signal?: AbortSignal;
  /** Extra request headers, merged after auth headers. */
  headers?: Record<string, string>;
  /** Overrides the client's base URL for this call. */
  baseUrl?: string;
  /** Overrides the client's auth strategy for this call. */
  auth?: AuthStrategy;
}

/**
 * Options accepted by `createApiClient`.
 */
export interface ApiClientOptions {
  /** Base URL prepended to every operation path. */
  baseUrl: string;
  /** Transport adapter. Defaults to `new FetchAdapter()`. */
  adapter?: RequestAdapter;
  /** Default authentication strategy. */
  auth?: AuthStrategy;
  /** Default headers merged into every request. */
  headers?: Record<string, string>;
}

/**
 * The minimal surface the generated client calls.
 */
export interface RuntimeClient {
  /**
   * Executes one operation.
   *
   * @param operation - The generated operation descriptor.
   * @param params - Flat path, query, and body values.
   * @param options - Per-call overrides.
   * @returns The unwrapped payload, or the whole body for `envelope: 'body'`.
   */
  request<T>(
    operation: OperationDescriptor,
    params?: RequestParams,
    options?: RequestOptions
  ): Promise<T>;
}

/**
 * Creates the runtime client used by generated clients.
 *
 * @param options - Base URL, adapter, and default auth and headers.
 * @returns A client with `request`.
 *
 * @example
 * ```typescript
 * import { createApiClient, CookieSessionAuth } from `@blendsdk/api-client`;
 *
 * const client = createApiClient({ baseUrl: 'https://api.example.com', auth: new CookieSessionAuth() });
 * const product = await client.request<Product>(
 *   { method: 'get', path: '/api/products/{id}', envelope: 'data', operationId: 'getProduct' },
 *   { id: 42 }
 * );
 * ```
 */
export function createApiClient(options: ApiClientOptions): RuntimeClient {
  const adapter = options.adapter ?? new FetchAdapter();

  /**
   * Applies the effective auth strategy and merges headers in precedence order:
   * client defaults, then auth, then per-call headers (which win). Keys are
   * compared case-insensitively so a per-call header always replaces an auth or
   * default header that differs only in case.
   *
   * @param request - The request so far.
   * @param auth - The effective auth strategy, if any.
   * @param perCallHeaders - Headers supplied for this call.
   * @returns The authenticated request.
   */
  async function authenticate(
    request: AdapterRequest,
    auth: AuthStrategy | undefined,
    perCallHeaders: Record<string, string> | undefined
  ): Promise<AdapterRequest> {
    const authenticated = auth ? await auth.apply(request) : request;
    return {
      ...authenticated,
      headers: mergeHeaders(authenticated.headers, perCallHeaders),
    };
  }

  /**
   * Applies authentication, converting a credential-fetch failure into a
   * redacted `ApiTransportError` instead of letting a raw error escape.
   *
   * @param request - The request so far.
   * @param auth - The effective auth strategy, if any.
   * @param perCallHeaders - Headers supplied for this call.
   * @param operationId - The operation id for error reporting.
   * @returns The authenticated request.
   */
  async function authenticateSafely(
    request: AdapterRequest,
    auth: AuthStrategy | undefined,
    perCallHeaders: Record<string, string> | undefined,
    operationId: string
  ): Promise<AdapterRequest> {
    try {
      return await authenticate(request, auth, perCallHeaders);
    } catch (cause) {
      throw createTransportError(cause, operationId);
    }
  }

  /**
   * Sends a request, converting a transport failure into an `ApiTransportError`.
   *
   * @param request - The request to send.
   * @param operationId - The operation id for error reporting.
   * @returns The adapter's response.
   */
  async function send(request: AdapterRequest, operationId: string): Promise<AdapterResponse> {
    try {
      return await adapter.send(request);
    } catch (cause) {
      throw createTransportError(cause, operationId);
    }
  }

  return {
    async request<T>(
      operation: OperationDescriptor,
      params: RequestParams = {},
      callOptions: RequestOptions = {}
    ): Promise<T> {
      const method = operation.method.toUpperCase();
      const hasBody = method !== 'GET' && method !== 'DELETE';
      const rest = omitPathParams(operation.path, params);

      const baseUrl = callOptions.baseUrl ?? options.baseUrl;
      const url = buildUrl(baseUrl, resolvePath(operation.path, params), hasBody ? {} : rest);
      const body = hasBody ? serializeBody(rest) : undefined;

      const headers = { ...(options.headers ?? {}) };
      if (body !== undefined && !hasHeader(headers, 'content-type')) {
        headers['content-type'] = 'application/json';
      }

      let request: AdapterRequest = {
        url,
        method,
        headers,
        body,
        signal: callOptions.signal,
      };

      const auth = callOptions.auth ?? options.auth;
      request = await authenticateSafely(request, auth, callOptions.headers, operation.operationId);

      let response = await send(request, operation.operationId);

      // A 401 is retried once when the strategy can refresh its credentials.
      if (response.status === 401 && auth?.refreshOnUnauthorized) {
        let refreshed: boolean;
        try {
          refreshed = await auth.refreshOnUnauthorized();
        } catch (cause) {
          throw createTransportError(cause, operation.operationId);
        }
        if (refreshed) {
          request = await authenticateSafely(
            request,
            auth,
            callOptions.headers,
            operation.operationId
          );
          response = await send(request, operation.operationId);
        }
      }

      if (!response.ok) {
        throw createApiError(response.status, response.body, operation.operationId);
      }

      return unwrapResponse<T>(operation.envelope, response.body);
    },
  };
}

/**
 * Merges two header maps case-insensitively, with the override winning.
 *
 * Later entries replace earlier ones when their names differ only in case, and
 * the override's original casing is preserved.
 *
 * @param base - The base headers.
 * @param override - The headers that take precedence.
 * @returns A merged header map with case-insensitive duplicate keys collapsed.
 */
function mergeHeaders(
  base: Record<string, string>,
  override: Record<string, string> | undefined
): Record<string, string> {
  const byLowerName = new Map<string, [string, string]>();
  for (const [name, value] of Object.entries(base)) {
    byLowerName.set(name.toLowerCase(), [name, value]);
  }
  for (const [name, value] of Object.entries(override ?? {})) {
    byLowerName.set(name.toLowerCase(), [name, value]);
  }
  return Object.fromEntries(byLowerName.values());
}

/**
 * Checks whether a header is present, ignoring case.
 *
 * @param headers - The header map.
 * @param name - The header name to look for.
 * @returns True when a header with that name (any case) exists.
 */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some(key => key.toLowerCase() === target);
}
