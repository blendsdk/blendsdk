/**
 * Bearer-token authentication.
 *
 * The token is supplied by the caller (for example, from an in-memory session).
 * When a request is rejected with 401, the strategy refreshes at most once and
 * the runtime retries the request once.
 *
 * @module
 */
import type { AdapterRequest } from '../transport.js';
import type { AuthStrategy } from './strategy.js';

/**
 * Options for {@link BearerAuth}.
 */
export interface BearerAuthOptions {
  /** Returns the current access token. */
  getToken: () => string | Promise<string>;
  /**
   * Refreshes the access token. Required for automatic retry after a 401;
   * without it a 401 is surfaced to the caller unchanged.
   */
  refresh?: () => string | Promise<string>;
  /**
   * How long a refreshed token is reused before `getToken` is consulted again.
   * Defaults to 30000 milliseconds. A short window keeps the retry coherent for
   * concurrent requests without shadowing `getToken` indefinitely.
   */
  refreshedTokenTtlMs?: number;
  /** Clock source, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Sends `Authorization: Bearer <token>` and refreshes once on 401.
 *
 * A refreshed token is reused for a short window so a retried request (and any
 * concurrent request sharing the same instance) uses it, after which `getToken`
 * becomes authoritative again. Call {@link invalidate} on logout or rotation to
 * drop the cached token immediately.
 *
 * @example
 * ```typescript
 * const auth = new BearerAuth({
 *   getToken: async () => session.accessToken,
 *   refresh: async () => (await fetch('/auth/refresh')).accessToken,
 * });
 * ```
 */
export class BearerAuth implements AuthStrategy {
  /** The OpenAPI security-scheme name this strategy satisfies. */
  readonly scheme = 'bearerAuth';

  /** The token returned by the most recent refresh, when one happened. */
  private refreshedToken?: string;

  /** When the refreshed token was stored, in epoch milliseconds. */
  private refreshedAt = 0;

  /** The in-flight refresh, shared by concurrent 401s. */
  private refreshing?: Promise<string>;

  /**
   * @param options - The token provider, optional refresh function, and cache policy.
   */
  constructor(private readonly options: BearerAuthOptions) {}

  /**
   * Adds the bearer token to the request.
   *
   * Uses a recently refreshed token when one is still within its reuse window,
   * otherwise asks `getToken` for the current token.
   *
   * @param request - The request being built.
   * @returns The request with the `Authorization` header.
   */
  async apply(request: AdapterRequest): Promise<AdapterRequest> {
    const token = this.currentToken();
    const resolved = token ?? (await this.options.getToken());
    return {
      ...request,
      headers: { ...request.headers, Authorization: `Bearer ${resolved}` },
    };
  }

  /**
   * Refreshes the token once, collapsing concurrent refreshes.
   *
   * @returns True when a refresh happened and the request may be retried.
   */
  async refreshOnUnauthorized(): Promise<boolean> {
    if (this.options.refresh === undefined) {
      return false;
    }

    if (this.refreshing === undefined) {
      this.refreshing = Promise.resolve(this.options.refresh())
        .then(token => {
          this.refreshedToken = token;
          this.refreshedAt = this.now();
          return token;
        })
        .finally(() => {
          this.refreshing = undefined;
        });
    }

    await this.refreshing;
    return true;
  }

  /**
   * Drops any cached refreshed token, so the next request calls `getToken`.
   */
  invalidate(): void {
    this.refreshedToken = undefined;
    this.refreshedAt = 0;
  }

  /**
   * @returns The cached refreshed token when it is still within its reuse window.
   */
  private currentToken(): string | undefined {
    if (this.refreshedToken === undefined) {
      return undefined;
    }
    return this.now() - this.refreshedAt < this.ttlMs ? this.refreshedToken : undefined;
  }

  /**
   * @returns The current clock reading in epoch milliseconds.
   */
  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * @returns The refreshed-token reuse window in milliseconds.
   */
  private get ttlMs(): number {
    return this.options.refreshedTokenTtlMs ?? 30000;
  }
}
