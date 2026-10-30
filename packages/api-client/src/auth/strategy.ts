/**
 * The authentication strategy boundary.
 *
 * A strategy applies credentials to an outgoing request and, when it can, says
 * whether it was able to refresh those credentials after a 401 so the runtime
 * can retry once.
 *
 * @module
 */
import type { AdapterRequest } from '../transport.js';

/**
 * An authentication strategy keyed by security-scheme name.
 *
 * @example
 * ```typescript
 * class CustomAuth implements AuthStrategy {
 *   readonly scheme = 'custom';
 *   async apply(request: AdapterRequest): Promise<AdapterRequest> {
 *     return { ...request, headers: { ...request.headers, 'X-Tenant': 'acme' } };
 *   }
 * }
 * ```
 */
export interface AuthStrategy {
  /** The OpenAPI security-scheme name this strategy satisfies. */
  readonly scheme: string;

  /**
   * Applies authentication to an outgoing request.
   *
   * @param request - The request being built.
   * @returns The request with authentication applied.
   */
  apply(request: AdapterRequest): Promise<AdapterRequest>;

  /**
   * Refreshes credentials after a 401, at most once per request.
   *
   * @returns True when credentials changed and the request may be retried.
   */
  refreshOnUnauthorized?(): Promise<boolean>;
}
