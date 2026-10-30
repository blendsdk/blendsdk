/**
 * AuthGuard — Route protection component for React Router.
 *
 * Renders `<Outlet />` for authenticated users, redirects to the
 * configured login path for unauthenticated users, and returns null
 * while loading (GlobalLoader handles the overlay).
 *
 * Designed for React Router object-based routes as a layout route element.
 *
 * @packageDocumentation
 */

import { Navigate, Outlet, useLocation } from "react-router";
import { useAuth } from "./use-auth.js";
import type { ReactElement } from "react";

/**
 * Route protection component for React Router object-based routes.
 *
 * Renders `<Outlet />` if the user is authenticated, redirects to
 * the configured login path if not. Returns `null` during the initial
 * loading phase (GlobalLoader shows the overlay).
 *
 * The redirect includes `{ state: { returnTo: location.pathname } }`
 * so the login page can redirect back after authentication.
 *
 * @example
 * ```tsx
 * const routes = [
 *     {
 *         element: <AuthGuard />,
 *         children: [
 *             { path: '/dashboard', element: <Dashboard /> },
 *             { path: '/profile', element: <Profile /> },
 *         ],
 *     },
 *     { path: '/login', element: <LoginPage /> },
 * ];
 * ```
 */
export function AuthGuard(): ReactElement | null {
    const { isAuthenticated, isLoading, config } = useAuth();
    const location = useLocation();

    // Still loading — return nothing (GlobalLoader handles the overlay)
    if (isLoading) {
        return null;
    }

    // Not authenticated — redirect to login with returnTo state
    if (!isAuthenticated) {
        return (
            <Navigate
                to={config.loginPath}
                state={{ returnTo: location.pathname }}
                replace
            />
        );
    }

    // Authenticated — render child routes
    return <Outlet />;
}
