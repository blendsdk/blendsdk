/**
 * Provider token decoding and identity assembly.
 *
 * These helpers sit between an OIDC callback and a claims translator: they
 * decode the tokens the provider returned and present the claims and scopes a
 * profile reads. They do not verify tokens.
 *
 * @packageDocumentation
 */

import { decodeJwt } from "jose";
import type { ProviderIdentity } from "@blendsdk/authz";

/**
 * Decodes the claims of a JWT without verifying it.
 *
 * A token that is absent, opaque, or malformed yields `undefined` instead of
 * throwing, so a provider that hands back an opaque access token still works
 * with an identity token. No signature, issuer, audience, or expiry check is
 * performed.
 *
 * **Trust boundary:** the returned claims are unverified. Only decode tokens
 * that were just received directly from the provider's token endpoint over a
 * trusted channel. Never decode a token that a client supplied, because its
 * contents could be forged.
 *
 * @param token - The encoded token, if one is available
 * @returns The decoded claims, or `undefined` when the token cannot be decoded
 *
 * @example
 * ```typescript
 * decodeJwtClaims("opaque-token"); // undefined
 * decodeJwtClaims(identityToken); // { sub: "user-1", ... }
 * ```
 */
export function decodeJwtClaims(
    token: string | undefined
): Record<string, unknown> | undefined {
    if (!token) {
        return undefined;
    }

    try {
        return decodeJwt(token);
    } catch {
        return undefined;
    }
}

/**
 * Splits a space-delimited scope string into individual scopes.
 *
 * @param scope - The granted scope string, if one is available
 * @returns The individual scopes, or `undefined` when none are present
 */
function splitScopes(scope: string | undefined): string[] | undefined {
    if (!scope) {
        return undefined;
    }

    const scopes = scope.split(/\s+/).filter(part => part.length > 0);
    return scopes.length > 0 ? scopes : undefined;
}

/**
 * Collects the claims and scopes a translation profile needs.
 *
 * The identity token and the access token are decoded independently, so an
 * opaque access token simply contributes no claims. User info is passed
 * through unchanged because the caller already received it from the provider.
 * The result is handed to a `ClaimsTranslator`.
 *
 * @param tokens - The tokens returned by the provider's token endpoint
 * @param userInfo - The user info returned by the provider, passed through as-is
 * @returns The provider identity to translate
 *
 * @example
 * ```typescript
 * const identity = buildProviderIdentity(
 *     { accessToken: tokens.accessToken, idToken: tokens.idToken, scope: tokens.scope },
 *     userInfo
 * );
 * const principal = translator.translate(identity);
 * ```
 */
export function buildProviderIdentity(
    tokens: { accessToken?: string; idToken?: string; scope?: string },
    userInfo: Record<string, unknown>
): ProviderIdentity {
    const identity: ProviderIdentity = { userInfo };

    const idTokenClaims = decodeJwtClaims(tokens.idToken);
    if (idTokenClaims) {
        identity.idTokenClaims = idTokenClaims;
    }

    const accessTokenClaims = decodeJwtClaims(tokens.accessToken);
    if (accessTokenClaims) {
        identity.accessTokenClaims = accessTokenClaims;
    }

    const scopes = splitScopes(tokens.scope);
    if (scopes) {
        identity.scopes = scopes;
    }

    return identity;
}
