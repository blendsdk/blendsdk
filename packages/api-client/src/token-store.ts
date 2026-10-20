/**
 * Token caching with single-flight refresh.
 *
 * Both the bearer and OIDC client-credentials strategies share this store. It
 * caches a token until shortly before its expiry and collapses concurrent
 * refreshes into one token request, so a burst of 401s does not stampede the
 * identity provider.
 *
 * @module
 */

/**
 * A token and the absolute time at which it expires.
 */
export interface TokenResult {
  /** The access token. */
  token: string;
  /** Epoch milliseconds at which the token expires. */
  expiresAt: number;
}

/**
 * Options for {@link TokenStore}.
 */
export interface TokenStoreOptions {
  /** Clock source, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Refresh this many milliseconds before expiry. Defaults to 5000. */
  skewMs?: number;
}

/**
 * Caches a token and performs a single-flight refresh.
 *
 * @example
 * ```typescript
 * const store = new TokenStore(async () => {
 *   const response = await fetch(tokenEndpoint, { method: 'POST' });
 *   const payload = await response.json();
 *   return { token: payload.access_token, expiresAt: Date.now() + payload.expires_in * 1000 };
 * });
 * const token = await store.get();
 * ```
 */
export class TokenStore {
  /** The cached token, when present. */
  private token?: string;

  /** Epoch milliseconds at which the cached token expires. */
  private expiresAt = 0;

  /** The in-flight refresh, shared by concurrent callers. */
  private refreshing?: Promise<string>;

  /**
   * @param fetchToken - Obtains a fresh token.
   * @param options - Clock and expiry-skew overrides.
   */
  constructor(
    private readonly fetchToken: () => Promise<TokenResult>,
    private readonly options: TokenStoreOptions = {}
  ) {}

  /**
   * Returns a usable token, refreshing it when the cache is empty or stale.
   *
   * @returns A valid token.
   */
  async get(): Promise<string> {
    if (this.token !== undefined && this.now() + this.skewMs < this.expiresAt) {
      return this.token;
    }
    return this.refresh();
  }

  /**
   * Refreshes the token, collapsing concurrent calls into one request.
   *
   * If the in-flight refresh fails, the failure is shared by the callers that
   * joined it and the next call starts a fresh attempt.
   *
   * @returns The refreshed token.
   */
  refresh(): Promise<string> {
    if (this.refreshing === undefined) {
      this.refreshing = this.fetchToken()
        .then(result => {
          this.token = result.token;
          this.expiresAt = result.expiresAt;
          return result.token;
        })
        .finally(() => {
          this.refreshing = undefined;
        });
    }
    return this.refreshing;
  }

  /**
   * @returns The current clock reading in epoch milliseconds.
   */
  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * @returns The refresh skew in milliseconds.
   */
  private get skewMs(): number {
    return this.options.skewMs ?? 5000;
  }
}
