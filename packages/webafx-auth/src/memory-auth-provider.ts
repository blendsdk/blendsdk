/**
 * In-memory authentication provider for testing and development.
 *
 * Validates tokens against a pre-configured map of token → AuthResult.
 * No network calls, no crypto — pure map lookup. Provides runtime
 * helpers (`addToken`, `removeToken`) for dynamic test scenarios.
 *
 * @example
 * ```typescript
 * const provider = new MemoryAuthProvider({
 *     validTokens: {
 *         'admin-token': { sub: 'admin-1', claims: { role: 'admin' }, token: 'admin-token' },
 *         'user-token': { sub: 'user-1', claims: { role: 'user' }, token: 'user-token' },
 *     },
 * });
 *
 * const result = await provider.authenticate(req);
 * // result is AuthResult if the Bearer token matches a key, undefined otherwise
 * ```
 *
 * @packageDocumentation
 */

import { AuthProvider } from "./abstract-auth-provider.js";
import type { AuthResult, MemoryAuthConfig } from "./types.js";

/**
 * In-memory mock authentication provider.
 *
 * Designed for use in unit tests, integration tests, and local development
 * where a real identity provider is unnecessary. Tokens are validated by
 * simple map lookup — if the token string exists as a key, the corresponding
 * AuthResult is returned.
 *
 * Supports runtime manipulation of the token map via `addToken()` and
 * `removeToken()`, making it easy to set up and tear down test scenarios.
 */
export class MemoryAuthProvider extends AuthProvider {
    /** Map of valid token strings to their corresponding AuthResult */
    protected tokens: Map<string, AuthResult>;

    /**
     * Create a new in-memory auth provider.
     *
     * @param config - Optional configuration with pre-populated valid tokens.
     *   If omitted, starts with an empty token map.
     */
    constructor(config?: MemoryAuthConfig) {
        super(config ?? {});
        // Convert the plain object to a Map for O(1) lookups.
        // Default to empty map if no tokens are configured.
        this.tokens = new Map(Object.entries(config?.validTokens ?? {}));
    }

    // -----------------------------------------------------------------------
    // Abstract Method Implementations
    // -----------------------------------------------------------------------

    /**
     * Validate a token by looking it up in the pre-configured map.
     *
     * Returns the matching AuthResult if found, undefined otherwise.
     * No crypto, no network — pure map lookup.
     *
     * @param token - Raw token string extracted from the request
     * @returns AuthResult if the token is in the map, undefined otherwise
     */
    async validate(token: string): Promise<AuthResult | undefined> {
        return this.tokens.get(token);
    }

    /**
     * Health check — always returns true.
     *
     * The in-memory provider has no external dependencies and is always
     * operational as long as the process is running.
     *
     * @returns Always true
     */
    async health(): Promise<boolean> {
        return true;
    }

    /**
     * Graceful shutdown — clears all stored tokens.
     *
     * Releases the token map entries. After shutdown, all subsequent
     * `validate()` calls will return undefined.
     */
    async shutdown(): Promise<void> {
        this.tokens.clear();
    }

    // -----------------------------------------------------------------------
    // Test Helpers (not part of the abstract AuthProvider contract)
    // -----------------------------------------------------------------------

    /**
     * Add a valid token at runtime.
     *
     * Useful in test setup to register tokens for specific test scenarios
     * without needing to recreate the provider.
     *
     * @param token - The token string to register
     * @param result - The AuthResult to return when this token is validated
     */
    addToken(token: string, result: AuthResult): void {
        this.tokens.set(token, result);
    }

    /**
     * Remove a token at runtime.
     *
     * Useful in test teardown or to simulate token revocation scenarios.
     *
     * @param token - The token string to remove
     * @returns true if the token existed and was removed, false otherwise
     */
    removeToken(token: string): boolean {
        return this.tokens.delete(token);
    }

    /**
     * Get the number of currently registered tokens.
     *
     * Useful in test assertions to verify the token map state.
     *
     * @returns Number of valid tokens in the map
     */
    getTokenCount(): number {
        return this.tokens.size;
    }
}
