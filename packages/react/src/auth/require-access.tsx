/**
 * RequireAccess — Route wrapper that enforces an access requirement.
 *
 * Designed for React Router as a layout-route element. It runs the requirement
 * against the current user's grants and either renders the protected content or
 * redirects. Client checks are presentation only; the server remains
 * authoritative.
 *
 * @packageDocumentation
 */

import { Navigate, Outlet, useLocation } from "react-router";
import { satisfiesAccess } from "@blendsdk/authz";
import type { AccessRequirement } from "@blendsdk/authz";
import type { ReactElement, ReactNode } from "react";
import { useAuth } from "./use-auth.js";
import { useAuthorization } from "./use-authorization.js";

/**
 * Props for {@link RequireAccess}.
 */
export interface RequireAccessProps {
    /** The roles and permissions the user must hold. */
    requirement: AccessRequirement;
    /**
     * Content to render when access is granted. When omitted, the component
     * renders the matched child route (`<Outlet />`) instead.
     */
    children?: ReactNode;
    /**
     * Path to redirect to when access is denied. Defaults to the configured
     * `notAuthorizedPath`. Ignored for an anonymous user, who is sent to the
     * login path.
     */
    redirectTo?: string;
}

/**
 * Protects a route or a subtree with an access requirement.
 *
 * Behavior:
 * - While the session is loading, renders nothing (a global loader covers the gap).
 * - When no user is signed in, redirects to the login path with the current
 *   path in `state.returnTo`, matching `AuthGuard`.
 * - When the requirement is satisfied, renders `children`, or the matched child
 *   route when no children are given.
 * - When the user is signed in but denied, redirects to `redirectTo` or the
 *   configured `notAuthorizedPath`, without a `returnTo` state.
 *
 * @param props - The requirement, optional children, and optional redirect path
 * @returns The rendered element, or `null` while loading
 *
 * @example
 * ```tsx
 * // Layout route: no children, so the child route renders when allowed.
 * { element: <RequireAccess requirement={{ roles: ["finance"] }} />, children: [...] }
 *
 * // Inline guard with explicit children.
 * <RequireAccess requirement={{ permissions: ["invoice:read"] }}>
 *     <Invoices />
 * </RequireAccess>
 * ```
 */
export function RequireAccess(props: RequireAccessProps): ReactElement | null {
    const { isLoading, user, config } = useAuth();
    const location = useLocation();
    const { roles, permissions } = useAuthorization();

    if (isLoading) {
        return null;
    }

    if (user === null) {
        return (
            <Navigate
                to={config.loginPath}
                state={{ returnTo: location.pathname }}
                replace
            />
        );
    }

    const principal = { roles, permissions };
    if (satisfiesAccess(principal, props.requirement)) {
        if (props.children === undefined || props.children === null) {
            return <Outlet />;
        }
        return <>{props.children}</>;
    }

    return <Navigate to={props.redirectTo ?? config.notAuthorizedPath} replace />;
}
