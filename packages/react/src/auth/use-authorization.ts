/**
 * useAuthorization — Reads the caller's canonical grants from the session.
 *
 * The hook turns the authenticated user into an authorization principal and
 * exposes the roles and permissions plus two predicates. It is presentation
 * only: the server remains the authority, so a hidden button is a convenience,
 * never a security boundary.
 *
 * @packageDocumentation
 */

import { useMemo } from "react";
import {
    hasPermission as isPermissionGranted,
    hasRole as isRoleGranted,
} from "@blendsdk/authz";
import type { AccessPrincipal } from "@blendsdk/authz";
import { useAuth } from "./use-auth.js";
import type { AuthUser } from "./auth-types.js";

/**
 * The grants and predicates returned by {@link useAuthorization}.
 */
export interface UseAuthorizationResult {
    /** Roles the current user holds. */
    roles: readonly string[];
    /** Permissions the current user holds. */
    permissions: readonly string[];
    /**
     * Reports whether the current user holds a role.
     *
     * @param role - The role to look for
     * @returns `true` when the role is held
     */
    hasRole(role: string): boolean;
    /**
     * Reports whether the current user holds a permission.
     *
     * @param permission - The permission to look for
     * @returns `true` when the permission is held
     */
    can(permission: string): boolean;
}

/**
 * Keeps only the string entries of a value and removes duplicates.
 *
 * The session user is untrusted runtime data, so a missing value, a value that
 * is not an array, or an array that holds a non-string must not reach the
 * evaluator. The first occurrence of each string wins.
 *
 * @param value - The value read from the user object
 * @returns The distinct strings found in the value, or an empty list
 */
function readStringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const result: string[] = [];
    for (const entry of value) {
        if (typeof entry === "string" && !result.includes(entry)) {
            result.push(entry);
        }
    }
    return result;
}

/**
 * Builds an authorization principal from the session user.
 *
 * An anonymous user and a user whose grants are malformed both yield an empty
 * principal, so a requirement fails closed instead of throwing.
 *
 * @param user - The authenticated user, or `null` when anonymous
 * @returns The roles and permissions the user holds
 */
function readPrincipal(user: AuthUser | null): AccessPrincipal {
    if (!user) {
        return { roles: [], permissions: [] };
    }

    return {
        roles: readStringList(user["roles"]),
        permissions: readStringList(user["permissions"]),
    };
}

/**
 * Reads the current user's roles and permissions.
 *
 * The canonical grants are the ones the server stored on the session user
 * after translating the provider identity. An anonymous user holds nothing.
 * The result is memoized on the user, so the predicates stay stable between
 * renders.
 *
 * @returns The grants and the `hasRole`/`can` predicates
 *
 * @example
 * ```tsx
 * function InvoiceToolbar() {
 *     const { can, hasRole } = useAuthorization();
 *
 *     return (
 *         <>
 *             {hasRole("finance") && <FinanceBadge />}
 *             {can("invoice:write") && <EditButton />}
 *         </>
 *     );
 * }
 * ```
 */
export function useAuthorization(): UseAuthorizationResult {
    const { user } = useAuth();

    return useMemo(() => {
        const principal = readPrincipal(user);
        return {
            roles: principal.roles,
            permissions: principal.permissions,
            hasRole: (role: string) => isRoleGranted(principal, role),
            can: (permission: string) => isPermissionGranted(principal, permission),
        };
    }, [user]);
}
