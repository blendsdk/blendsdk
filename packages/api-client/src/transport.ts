/**
 * The transport boundary of the API client runtime.
 *
 * The runtime never calls `fetch` directly; it builds an {@link AdapterRequest}
 * and hands it to a {@link RequestAdapter}. Tests substitute a stub adapter, and
 * applications can supply their own for logging, caching, or another transport.
 *
 * @module
 */

/**
 * A fully built request handed to the transport adapter.
 */
export interface AdapterRequest {
  /** Absolute, encoded URL including the query string. */
  url: string;
  /** Uppercase HTTP method. */
  method: string;
  /** Final headers, including authentication. */
  headers: Record<string, string>;
  /** Serialized JSON body, or undefined for bodyless methods. */
  body?: string;
  /** Cancellation signal forwarded from the caller. */
  signal?: AbortSignal;
  /** Fetch credential mode; set by cookie-session authentication. */
  credentials?: RequestCredentials;
}

/**
 * The adapter's response.
 */
export interface AdapterResponse {
  /** HTTP status code. */
  status: number;
  /** Whether the status is in the 2xx range. */
  ok: boolean;
  /** Parsed JSON body, or undefined when the body is empty. */
  body: unknown;
}

/**
 * The transport boundary. The default adapter wraps `fetch`.
 *
 * @example
 * ```typescript
 * class RecordingAdapter implements RequestAdapter {
 *   readonly requests: AdapterRequest[] = [];
 *   async send(request: AdapterRequest): Promise<AdapterResponse> {
 *     this.requests.push(request);
 *     return { status: 200, ok: true, body: { success: true, data: {} } };
 *   }
 * }
 * ```
 */
export interface RequestAdapter {
  /**
   * Executes one HTTP request.
   *
   * @param request - The fully built request.
   * @returns The raw response.
   */
  send(request: AdapterRequest): Promise<AdapterResponse>;
}

/**
 * The default adapter, backed by the global `fetch`.
 *
 * @example
 * ```typescript
 * const client = createApiClient({ baseUrl: '/api', adapter: new FetchAdapter() });
 * ```
 */
export class FetchAdapter implements RequestAdapter {
  /**
   * Executes one request with `fetch` and parses the response body.
   *
   * A non-JSON body is returned as text so an HTML error page does not hide the
   * status code.
   *
   * @param request - The fully built request.
   * @returns The status, ok flag, and parsed body.
   */
  async send(request: AdapterRequest): Promise<AdapterResponse> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
      credentials: request.credentials,
    });

    const text = await response.text();

    return {
      status: response.status,
      ok: response.ok,
      body: parseResponseBody(text),
    };
  }
}

/**
 * Parses a response body as JSON, falling back to the raw text.
 *
 * @param text - The response body as text.
 * @returns The parsed JSON value, the raw text, or undefined for an empty body.
 */
function parseResponseBody(text: string): unknown {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
