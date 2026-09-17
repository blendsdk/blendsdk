/**
 * Access guard for WebAFX routes.
 *
 * Turns an authorization requirement into the `AuthorizeFunction` shape that
 * `route.authorize()` already expects, so an application guards a route with
 * declarative roles and permissions instead of hand-written callbacks.
 *
 * @packageDocumentation
 */

import { satisfiesAccess } from "@blendsdk/authz";
import type { AccessRequirement } from "@blendsdk/authz";
import type { AuthResult } from "@blendsdk/webafx-auth";
import type { AuthorizeFunction } from "@blendsdk/webafx";
import { defaultPrincipalSelector } from "./principal.js";
import type { PrincipalSelector } from "./principal.js";

/**
 * Options for {@link requireAccess}.
 */
export interface RequireAccessOptions {
    /**
     * Resolves the grants to check from the request's principal.
     *
     * Defaults to reading `claims.roles` and `claims.permissions`. Provide a
     * selector when the application stores its canonical grants elsewhere.
     */
    select?: PrincipalSelector;
}

/**
 * Builds an authorization callback that checks a requirement against the
 * request's principal.
 *
 * The callback never throws for a missing principal: an anonymous request
 * yields an empty principal, so a non-empty requirement fails closed and
 * WebAFX answers 401 on a secure route or 403 when only authorization failed.
 * An empty requirement is always satisfied.
 *
 * @param requirement - The roles and permissions to check. By default the
 *   caller must hold at least one listed value; set `mode: "all"` to require
 *   every listed role and permission.
 * @param options - Optional principal selector
 * @returns An `AuthorizeFunction` to pass to `route.authorize()`
 *
 * @example
 * ```typescript
 * this.route()
 *     .get("/invoices")
 *     .secure()
 *     .authorize(requireAccess({ permissions: ["invoice:read"] }))
 *     .handle(this.listInvoices);
 * ```
 */
export function requireAccess(
    requirement: AccessRequirement,
    options?: RequireAccessOptions
): AuthorizeFunction {
    const select = options?.select ?? defaultPrincipalSelector;

    return (_req, principal: AuthResult | undefined) => {
        const grants = select(principal);
        return satisfiesAccess(grants, requirement);
    };
}
