/**
 * Cookie-session authentication for browser clients.
 *
 * The browser owns the session cookie; this strategy only tells the request to
 * include credentials. The server remains responsible for CSRF protection and
 * for the cookie's `SameSite` attribute.
 *
 * @module
 */
import type { AdapterRequest } from '../transport.js';
import type { AuthStrategy } from './strategy.js';

/**
 * Includes the browser's session cookie on every request.
 *
 * @example
 * ```typescript
 * const client = createApiClient({ baseUrl: '/api', auth: new CookieSessionAuth() });
 * ```
 */
export class CookieSessionAuth implements AuthStrategy {
  /** The OpenAPI security-scheme name this strategy satisfies. */
  readonly scheme = 'cookie';

  /**
   * Marks the request to include browser credentials.
   *
   * @param request - The request being built.
   * @returns The request with `credentials: 'include'`.
   */
  async apply(request: AdapterRequest): Promise<AdapterRequest> {
    return { ...request, credentials: 'include' };
  }
}
