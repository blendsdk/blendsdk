/**
 * Authorization evaluation.
 *
 * These functions answer one question: does a principal satisfy a requirement?
 * They are pure, allocation-light, and safe to call in a hot request path or
 * in the browser.
 *
 * @packageDocumentation
 */

import type {
    AccessPrincipal,
    AccessRequirement,
    Permission,
    Role,
} from "./types.js";

/**
 * Returns `true` when the principal holds the given role.
 *
 * @param principal - The grants held by the caller
 * @param role - The role to look for
 * @returns `true` when the role is held
 *
 * @example
 * ```typescript
 * hasRole({ roles: ["admin"], permissions: [] }, "admin"); // true
 * ```
 */
export function hasRole(principal: AccessPrincipal, role: Role): boolean {
    return principal.roles.some(held => held === role);
}

/**
 * Returns `true` when the principal holds the given permission.
 *
 * @param principal - The grants held by the caller
 * @param permission - The permission to look for
 * @returns `true` when the permission is held
 *
 * @example
 * ```typescript
 * hasPermission({ roles: [], permissions: ["invoice:read"] }, "invoice:read"); // true
 * ```
 */
export function hasPermission(
    principal: AccessPrincipal,
    permission: Permission
): boolean {
    return principal.permissions.some(held => held === permission);
}

/**
 * Evaluates a requirement against a principal.
 *
 * An absent or empty requirement is always satisfied, so an unconfigured rule
 * does not accidentally lock users out. Otherwise the listed roles and
 * permissions are combined according to {@link AccessRequirement.mode}:
 * `'any'` (the default) passes when at least one value is held, and `'all'`
 * passes only when every value is held.
 *
 * @param principal - The grants held by the caller
 * @param requirement - The roles and permissions to check
 * @returns `true` when the requirement is satisfied
 *
 * @example
 * ```typescript
 * const principal = { roles: ["finance"], permissions: ["invoice:read"] };
 *
 * satisfiesAccess(principal, { permissions: ["invoice:read", "invoice:write"] }); // true
 * satisfiesAccess(principal, { mode: "all", permissions: ["invoice:read", "invoice:write"] }); // false
 * ```
 */
export function satisfiesAccess(
    principal: AccessPrincipal,
    requirement: AccessRequirement
): boolean {
    const roles = requirement.roles ?? [];
    const permissions = requirement.permissions ?? [];

    if (roles.length === 0 && permissions.length === 0) {
        return true;
    }

    const results: boolean[] = [
        ...roles.map(role => hasRole(principal, role)),
        ...permissions.map(permission => hasPermission(principal, permission)),
    ];

    return requirement.mode === "all" ? results.every(Boolean) : results.some(Boolean);
}
