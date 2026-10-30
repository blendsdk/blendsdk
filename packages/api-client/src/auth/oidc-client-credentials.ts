/**
 * OIDC client-credentials authentication for Node machine-to-machine clients.
 *
 * The strategy exchanges a client id and secret for an access token and caches
 * it until expiry. It is Node-only: constructing it in a browser, web worker,
 * or other non-Node runtime throws, so a secret is never shipped to a client by
 * accident. The token endpoint must be HTTPS (loopback HTTP is allowed for
 * development) and redirects are refused, so the secret is never sent in
 * cleartext or forwarded to another host.
 *
 * @module
 */
import { TokenStore } from '../token-store.js';
import type { AdapterRequest } from '../transport.js';
import type { AuthStrategy } from './strategy.js';

/**
 * Options for {@link OidcClientCredentialsAuth}.
 */
export interface OidcClientCredentialsOptions {
  /** The identity provider's token endpoint. */
  tokenEndpoint: string;
  /** The OAuth client id. */
  clientId: string;
  /** The OAuth client secret. Never logged or written to generated files. */
  clientSecret: string;
  /** Optional requested scopes. */
  scope?: string;
}

/**
 * Obtains tokens with the OAuth 2.0 client-credentials grant.
 *
 * @example
 * ```typescript
 * const auth = new OidcClientCredentialsAuth({
 *   tokenEndpoint: process.env.IDP_TOKEN_URL!,
 *   clientId: process.env.IDP_CLIENT_ID!,
 *   clientSecret: process.env.IDP_CLIENT_SECRET!,
 *   scope: 'api.read',
 * });
 * ```
 */
export class OidcClientCredentialsAuth implements AuthStrategy {
  /** The OpenAPI security-scheme name this strategy satisfies. */
  readonly scheme = 'oauth2';

  /** The shared token cache. */
  private readonly store: TokenStore;

  /**
   * @param options - The token endpoint and client credentials.
   * @throws {Error} When the runtime is not Node.js or the endpoint is insecure.
   */
  constructor(private readonly options: OidcClientCredentialsOptions) {
    if (!isNodeRuntime()) {
      throw new Error(
        'OidcClientCredentialsAuth is only available in Node.js; it must not run in a browser or worker'
      );
    }
    if (!isSecureTokenEndpoint(options.tokenEndpoint)) {
      throw new Error(
        'OidcClientCredentialsAuth requires an https token endpoint (http is allowed only for loopback development)'
      );
    }
    this.store = new TokenStore(() => this.fetchToken());
  }

  /**
   * Adds the OIDC access token to the request.
   *
   * @param request - The request being built.
   * @returns The request with the `Authorization` header.
   */
  async apply(request: AdapterRequest): Promise<AdapterRequest> {
    const token = await this.store.get();
    return {
      ...request,
      headers: { ...request.headers, Authorization: `Bearer ${token}` },
    };
  }

  /**
   * Refreshes the OIDC token once after a 401.
   *
   * @returns True when the token was refreshed and the request may be retried.
   */
  async refreshOnUnauthorized(): Promise<boolean> {
    await this.store.refresh();
    return true;
  }

  /**
   * Requests a token from the identity provider.
   *
   * @returns The access token and its expiry.
   * @throws {Error} When the token endpoint fails or omits the access token.
   */
  private async fetchToken(): Promise<{ token: string; expiresAt: number }> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
    });
    if (this.options.scope) {
      body.set('scope', this.options.scope);
    }

    const response = await fetch(this.options.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'error',
    });

    if (!response.ok) {
      throw new Error(`Token request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof payload.access_token !== 'string') {
      throw new Error('Token response did not contain an access token');
    }

    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 3600;
    return { token: payload.access_token, expiresAt: Date.now() + expiresIn * 1000 };
  }
}

/**
 * Checks that the runtime is Node.js.
 *
 * A negative `window` check is not enough: web and service workers have no
 * `window` either, yet a bundled secret there would still be exposed. This
 * requires the affirmative Node marker and the absence of browser-like globals.
 *
 * @returns True when the current runtime is Node.js.
 */
function isNodeRuntime(): boolean {
  const runtime = globalThis as {
    process?: { versions?: { node?: string } };
    window?: unknown;
    WorkerGlobalScope?: unknown;
  };
  return (
    runtime.window === undefined &&
    runtime.WorkerGlobalScope === undefined &&
    typeof runtime.process?.versions?.node === 'string'
  );
}

/**
 * Checks that a token endpoint cannot send the client secret in cleartext.
 *
 * HTTPS is required except for an explicit loopback development endpoint.
 *
 * @param endpoint - The token endpoint URL.
 * @returns True when the endpoint is acceptable.
 * @throws {Error} When the endpoint is not a valid URL.
 */
function isSecureTokenEndpoint(endpoint: string): boolean {
  const url = new URL(endpoint);
  if (url.protocol === 'https:') {
    return true;
  }
  const isLoopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '::1' ||
    url.hostname === '[::1]';
  return url.protocol === 'http:' && isLoopback;
}
