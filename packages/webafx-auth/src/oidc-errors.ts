/**
 * Error types raised by the OIDC BFF flow.
 *
 * These errors give callers a stable, typed discriminator instead of the
 * internal error codes of the underlying `openid-client`/`oauth4webapi`
 * implementation. The controller maps them to HTTP responses.
 *
 * @packageDocumentation
 */

/**
 * Thrown when the authorization-code exchange or the ID-token verification
 * fails for a reason attributable to the sign-in flow: an invalid or expired
 * code, an OAuth error response from the token endpoint, a failed signature,
 * `nonce`, issuer, audience, or expiry check, or a verified ID token without a
 * usable subject. A browser user can act on the outcome by restarting
 * sign-in, so the controller maps it to a fixed `400` instead of a server
 * error.
 *
 * The message is fixed and safe to serialize. The original library error is
 * carried as `cause` for programmatic inspection only; it must not be
 * forwarded to a client, and not logged verbatim, because it may contain
 * provider response detail.
 *
 * @example
 * ```typescript
 * try {
 *     await provider.exchangeCode(params);
 * } catch (error) {
 *     if (error instanceof OidcCodeExchangeError) {
 *         // Report a failed sign-in; inspect error.cause for diagnostics.
 *     }
 *     throw error;
 * }
 * ```
 */
export class OidcCodeExchangeError extends Error {
    /**
     * Create the error.
     *
     * @param cause - The original library error, kept for diagnostics only
     */
    constructor(cause?: unknown) {
        super(
            "Authorization code exchange failed",
            cause === undefined ? undefined : { cause }
        );
        this.name = "OidcCodeExchangeError";
    }
}

/**
 * Thrown when the UserInfo endpoint refuses the request with HTTP 403.
 *
 * The identity provider authenticated the user, but the endpoint denied access
 * — for example `insufficient_scope`, a disabled account, or an
 * application-level policy. The authorization outcome is distinct from a
 * failed sign-in: the callback can surface the verified identity and let the
 * application present a "signed in, but not allowed" state.
 *
 * The message is fixed and safe to serialize. The original library error is
 * carried as `cause` for programmatic inspection only; it must not be
 * forwarded to a client, and not logged verbatim, because it may contain
 * provider response detail.
 */
export class OidcUserInfoForbiddenError extends Error {
    /**
     * Create the error.
     *
     * @param cause - The original library error, kept for diagnostics only
     */
    constructor(cause?: unknown) {
        super(
            "UserInfo endpoint denied the request",
            cause === undefined ? undefined : { cause }
        );
        this.name = "OidcUserInfoForbiddenError";
    }
}

/**
 * Thrown when the UserInfo endpoint returns a subject that differs from the
 * expected (ID-token) subject.
 *
 * OpenID Connect Core 1.0 §5.3.2 requires the two subjects to match exactly
 * and states that a mismatched UserInfo response MUST NOT be used.
 * {@link OidcAuthProvider.fetchUserInfo} throws this error when an expected
 * subject is supplied, so no mismatched claims can reach the session.
 *
 * The message intentionally carries no subject values, so the error is safe to
 * log.
 *
 * @example
 * ```typescript
 * try {
 *     await provider.fetchUserInfo(accessToken, "subject-123");
 * } catch (error) {
 *     if (error instanceof OidcUserInfoSubjectMismatchError) {
 *         // Reject the sign-in; never use the returned claims.
 *     }
 *     throw error;
 * }
 * ```
 */
export class OidcUserInfoSubjectMismatchError extends Error {
    /** Create the error. */
    constructor() {
        super("UserInfo response subject does not match the ID token subject");
        this.name = "OidcUserInfoSubjectMismatchError";
    }
}
