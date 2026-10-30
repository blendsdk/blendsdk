/**
 * Construction of the session stored when the application denies access.
 *
 * When `userInfoDenied: 'unauthorized-session'` is configured and the UserInfo
 * endpoint refuses the request, the callback still has an identity provider
 * authentication and the tokens from the code exchange. This module builds the
 * record stored for that state: the tokens, the identity copied from the
 * verified ID token, and `authorized: false`. Keeping it here holds the
 * controller near its size budget and gives the identity allowlist one home.
 *
 * @packageDocumentation
 */

import type { OidcSession, OidcTokens } from "./oidc-types.js";
import { generateCsrfToken, stripNullValues } from "./oidc-helpers.js";

/**
 * Identity claims copied from the verified ID token into an unauthorized
 * session.
 *
 * Deliberately small: the session needs enough to render a "signed in, but not
 * allowed" state, not a full claim set. `sub` is required; `email` and `name`
 * are copied when present.
 */
export const UNAUTHORIZED_IDENTITY_CLAIMS = ["sub", "email", "name"] as const;

/**
 * Copy the allowlisted identity claims from verified ID-token claims.
 *
 * A value is copied only when it is a string, so a malformed claim cannot put
 * an unexpected type into the session. Returns undefined when there is no
 * usable string `sub`, so the caller can fall back to the fixed denial
 * response. Extra claims, and everything when the claims are absent
 * (unverified or no ID token), are never copied.
 *
 * @param claims - Verified ID-token claims, or undefined when unavailable
 * @returns The identity record, or undefined when there is no usable subject
 */
export function pickIdentityClaims(
    claims: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
    if (!claims || typeof claims.sub !== "string") {
        return undefined;
    }

    const identity: Record<string, unknown> = {};
    for (const key of UNAUTHORIZED_IDENTITY_CLAIMS) {
        const value = claims[key];
        if (typeof value === "string") {
            identity[key] = value;
        }
    }
    return identity;
}

/**
 * Parameters for {@link buildUnauthorizedSession}.
 */
export interface BuildUnauthorizedSessionParams {
    /** Tokens from the successful code exchange. */
    tokens: OidcTokens;

    /** Identity copied from the verified ID token. */
    identity: Record<string, unknown>;

    /** Organization/tenant slug for multi-tenant sessions, when resolved. */
    organizationSlug?: string;

    /** Whether CSRF enforcement is enabled for this provider. */
    csrfEnabled: boolean;
}

/**
 * Build the session stored when the application denies access.
 *
 * The session carries the exchanged tokens so the browser keeps a normal,
 * refreshable BFF session, and `authorized: false` so the application can
 * present the denial and its guards can deny by policy. A CSRF token is minted
 * only when enforcement is enabled, matching the success path.
 *
 * @param params - Tokens, identity, organization slug, and CSRF flag
 * @returns The session record to store
 */
export function buildUnauthorizedSession(
    params: BuildUnauthorizedSessionParams
): OidcSession {
    return stripNullValues<OidcSession>({
        accessToken: params.tokens.accessToken,
        refreshToken: params.tokens.refreshToken,
        idToken: params.tokens.idToken,
        expiresAt: params.tokens.expiresIn
            ? Math.floor(Date.now() / 1000) + params.tokens.expiresIn
            : undefined,
        user: params.identity,
        organizationSlug: params.organizationSlug,
        csrfToken: params.csrfEnabled ? generateCsrfToken() : undefined,
        authorized: false,
    });
}
