/**
 * Scope guard for WebAFX routes.
 *
 * Checks OAuth scopes for machine callers. It is separate from the role and
 * permission guard because scopes describe what a token may do, not what a
 * person is allowed to do.
 *
 * @packageDocumentation
 */

import type { AuthResult } from "@blendsdk/webafx-auth";
import type { AuthorizeFunction } from "@blendsdk/webafx";

/**
 * Returns `true` when a runtime value is an object that can be indexed.
 *
 * The principal crosses an `any` boundary in WebAFX, so its `claims` field is
 * not guaranteed to be an object at runtime.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/**
 * Reads the scopes a principal holds.
 *
 * The principal's `scopes` list is authoritative when it holds at least one
 * string. Otherwise the guard falls back to the space-delimited `scope` claim,
 * which is how OAuth providers commonly report granted scopes. Anything that
 * is not a string is ignored, so malformed claims cannot smuggle a scope in,
 * and a list that holds only non-string entries does not suppress the
 * fallback.
 *
 * @param principal - The authenticated caller, or `undefined` when the request
 *   is anonymous
 * @returns The scopes the caller holds
 */
function readScopes(principal: AuthResult | undefined): string[] {
    if (!principal) {
        return [];
    }

    const scopes = principal.scopes;
    const listed = Array.isArray(scopes)
        ? scopes.filter((scope): scope is string => typeof scope === "string")
        : [];
    if (listed.length > 0) {
        return listed;
    }

    const claims = principal.claims;
    const claim = isRecord(claims) ? claims["scope"] : undefined;
    if (typeof claim !== "string") {
        return [];
    }

    return claim.split(/\s+/).filter(scope => scope.length > 0);
}

/**
 * Builds an authorization callback that requires every listed scope.
 *
 * An empty scope list requires nothing and always passes. A principal that
 * holds only some of the requested scopes is denied, and a principal with no
 * scopes at all is denied, so the guard fails closed.
 *
 * @param scopes - The scopes a caller must hold
 * @returns An `AuthorizeFunction` to pass to `route.authorize()`
 *
 * @example
 * ```typescript
 * this.route()
 *     .get("/reports/export")
 *     .secure("client")
 *     .authorize(requireScopes(["reports:read"]))
 *     .handle(this.exportReport);
 * ```
 */
export function requireScopes(scopes: readonly string[]): AuthorizeFunction {
    return (_req, principal: AuthResult | undefined) => {
        if (scopes.length === 0) {
            return true;
        }

        const held = readScopes(principal);
        return scopes.every(scope => held.includes(scope));
    };
}
