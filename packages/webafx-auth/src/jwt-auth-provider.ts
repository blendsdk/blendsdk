/**
 * JWT authentication provider for self-issued token verification.
 *
 * Validates JWTs locally using HMAC or RSA/EC keys via the `jose` library.
 * No network calls required — verification is a pure cryptographic operation.
 *
 * Supports:
 * - **HMAC** (HS256, HS384, HS512) — string secrets
 * - **RSA/EC** (RS256, ES256, etc.) — CryptoKey public keys
 * - Issuer validation (`iss` claim)
 * - Audience validation (`aud` claim)
 * - Clock tolerance for `exp`/`nbf` checks
 *
 * @example
 * ```typescript
 * const provider = new JwtAuthProvider({
 *     secret: 'my-256-bit-secret',
 *     algorithms: ['HS256'],
 *     issuer: 'https://api.example.com',
 *     audience: 'my-client-id',
 *     clockTolerance: 5,
 * });
 *
 * const result = await provider.authenticate(req);
 * // result is AuthResult if JWT is valid, undefined otherwise
 * ```
 *
 * @packageDocumentation
 */

import { jwtVerify } from "jose";
import type { JWTVerifyResult } from "jose";

import { AuthProvider } from "./abstract-auth-provider.js";
import type { AuthResult, JwtAuthConfig } from "./types.js";

/**
 * JWT authentication provider using the `jose` library.
 *
 * Verifies JWT signatures locally — no network calls needed. Supports both
 * symmetric (HMAC) and asymmetric (RSA, EC) algorithms. The signing key is
 * lazily converted to the format `jose` expects on first use.
 *
 * Invalid or expired tokens silently return `undefined` (not throw).
 * Only truly unexpected errors (e.g., corrupt CryptoKey) propagate as exceptions.
 */
export class JwtAuthProvider extends AuthProvider {
    /** Provider configuration */
    protected config: JwtAuthConfig;

    /**
     * Cached key in the format jose expects.
     * For string secrets (HMAC): encoded as Uint8Array.
     * For CryptoKey (RSA/EC): used directly.
     * Lazy-initialized on first validate() call.
     */
    protected resolvedKey: CryptoKey | Uint8Array | null = null;

    /**
     * Create a new JWT auth provider.
     *
     * @param config - JWT configuration with secret/key, algorithms, issuer, audience
     */
    constructor(config: JwtAuthConfig) {
        super(config);
        this.config = config;
    }

    // -----------------------------------------------------------------------
    // Abstract Method Implementations
    // -----------------------------------------------------------------------

    /**
     * Validate a JWT by verifying its signature, expiration, and claims.
     *
     * Uses `jose.jwtVerify()` which checks:
     * - Signature against the configured secret/key
     * - `exp` claim (token not expired, with clock tolerance)
     * - `nbf` claim (token not used before valid time)
     * - `iss` claim (if issuer is configured)
     * - `aud` claim (if audience is configured)
     *
     * @param token - Raw JWT string (header.payload.signature)
     * @returns AuthResult if valid, undefined if invalid/expired
     */
    async validate(token: string): Promise<AuthResult | undefined> {
        try {
            const key = this.getOrCreateKey();

            // Build verification options from config.
            // jose uses these to validate standard JWT claims after
            // signature verification succeeds.
            const options: Parameters<typeof jwtVerify>[2] = {
                algorithms: this.config.algorithms ?? ["HS256"],
                clockTolerance: this.config.clockTolerance ?? 0,
            };

            // Only set issuer/audience if configured — undefined means "don't check"
            if (this.config.issuer) {
                options.issuer = this.config.issuer;
            }
            if (this.config.audience) {
                options.audience = this.config.audience;
            }

            const result: JWTVerifyResult = await jwtVerify(
                token,
                key,
                options
            );

            // Map the verified JWT payload to our standardized AuthResult format
            return this.claimsMapper(
                token,
                result.payload as Record<string, unknown>
            );
        } catch {
            // Any verification failure (bad signature, expired, wrong issuer, malformed)
            // returns undefined — the silent failure pattern.
            return undefined;
        }
    }

    /**
     * Health check — verifies that the signing secret/key is configured.
     *
     * JWT verification is a local CPU operation with no external dependencies,
     * so health only checks that the key material is present.
     *
     * @returns true if a secret or key is configured
     */
    async health(): Promise<boolean> {
        return this.config.secret !== undefined && this.config.secret !== null;
    }

    /**
     * Graceful shutdown — releases the cached CryptoKey.
     *
     * After shutdown, the key will be re-created on next `validate()` call.
     */
    async shutdown(): Promise<void> {
        this.resolvedKey = null;
    }

    // -----------------------------------------------------------------------
    // Protected Helpers
    // -----------------------------------------------------------------------

    /**
     * Get or create the signing key in jose-compatible format.
     *
     * For string secrets (HMAC): encodes to Uint8Array using TextEncoder.
     * For CryptoKey (RSA/EC): uses the key directly as-is.
     *
     * The result is cached for the lifetime of the provider to avoid
     * repeated encoding on every request.
     *
     * @returns The key in a format jose's jwtVerify() accepts
     */
    protected getOrCreateKey(): CryptoKey | Uint8Array {
        if (this.resolvedKey) {
            return this.resolvedKey;
        }

        const { secret } = this.config;

        if (typeof secret === "string") {
            // HMAC secrets: encode the string to bytes for jose.
            // jose accepts Uint8Array for symmetric algorithms (HS256/384/512).
            this.resolvedKey = new TextEncoder().encode(secret);
        } else {
            // CryptoKey: use directly for asymmetric algorithms (RS256, ES256, etc.)
            this.resolvedKey = secret;
        }

        return this.resolvedKey;
    }
}
