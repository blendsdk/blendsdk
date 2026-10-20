/**
 * useAuth — Consumer hook for accessing AuthProvider context.
 *
 * Provides type-safe access to authentication state and actions.
 * Must be called within a component tree wrapped by `<AuthProvider>`.
 *
 * @packageDocumentation
 */

import { useContext } from "react";
import { AuthContext } from "./auth-provider.js";
import type { AuthContextValue } from "./auth-types.js";

/**
 * Access auth state and actions from AuthProvider.
 *
 * Returns the current authentication state (user, isAuthenticated, isLoading,
 * expiresAt, authorized, csrfToken) and action functions (login, logout,
 * refresh). `authorized` is false for a session the server denied, and
 * `csrfToken` is the per-session token to send on state-changing BFF calls.
 *
 * @returns The current AuthContextValue
 * @throws Error if called outside an `<AuthProvider>`
 *
 * @example
 * ```tsx
 * function ProfileButton() {
 *     const { user, isAuthenticated, authorized, login, logout } = useAuth();
 *
 *     if (!isAuthenticated) {
 *         return <button onClick={() => login()}>Sign In</button>;
 *     }
 *
 *     if (!authorized) {
 *         return <p>Signed in as {user?.sub}, but not allowed.</p>;
 *     }
 *
 *     return <button onClick={() => logout()}>Sign Out ({user?.sub})</button>;
 * }
 * ```
 */
export function useAuth(): AuthContextValue {
    const context = useContext(AuthContext);
    if (context === null) {
        throw new Error(
            "useAuth() must be used within an <AuthProvider>. " +
                "Wrap your component tree with <AuthProvider> to use this hook.",
        );
    }
    return context;
}
