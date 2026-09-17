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
 * expiresAt) and action functions (login, logout, refresh).
 *
 * @returns The current AuthContextValue
 * @throws Error if called outside an `<AuthProvider>`
 *
 * @example
 * ```tsx
 * function ProfileButton() {
 *     const { user, isAuthenticated, login, logout } = useAuth();
 *
 *     if (!isAuthenticated) {
 *         return <button onClick={() => login()}>Sign In</button>;
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
