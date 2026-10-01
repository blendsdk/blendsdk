/**
 * API-key authentication.
 *
 * The key is sent in a header by default. Sending it in the query string is an
 * explicit opt-in that emits a warning, because query strings are commonly
 * recorded in server logs, browser history, referrer headers, and forwarded
 * through redirects and proxies.
 *
 * @module
 */
import { appendQuery } from '../request.js';
import type { AdapterRequest } from '../transport.js';
import type { AuthStrategy } from './strategy.js';

/**
 * Options for {@link ApiKeyAuth}.
 */
export interface ApiKeyAuthOptions {
  /** The API key value. */
  key: string;
  /** Header name when sending a header. Defaults to `X-API-Key`. */
  name?: string;
  /** Where to send the key. Defaults to `'header'`. */
  in?: 'header' | 'query';
}

/**
 * Sends an API key in a header by default, or in the query when requested.
 *
 * @example
 * ```typescript
 * const auth = new ApiKeyAuth({ key: process.env.API_KEY! });
 * ```
 */
export class ApiKeyAuth implements AuthStrategy {
  /** The OpenAPI security-scheme name this strategy satisfies. */
  readonly scheme = 'apiKey';

  /** Whether the query-placement warning has already been emitted. */
  private warned = false;

  /**
   * @param options - The key and its placement.
   */
  constructor(private readonly options: ApiKeyAuthOptions) {}

  /**
   * Applies the API key to the request.
   *
   * @param request - The request being built.
   * @returns The request with the key added.
   */
  async apply(request: AdapterRequest): Promise<AdapterRequest> {
    const name = this.options.name ?? 'X-API-Key';

    if (this.options.in === 'query') {
      if (!this.warned) {
        this.warned = true;
        console.warn(
          'ApiKeyAuth: sending the API key in the query string can leak it through server logs, browser history, referrer headers, redirects, and forward proxies; prefer header placement.'
        );
      }
      return { ...request, url: appendQuery(request.url, name, this.options.key) };
    }

    return {
      ...request,
      headers: { ...request.headers, [name]: this.options.key },
    };
  }
}
