/**
 * Type definitions for the auth module.
 *
 * Defines interfaces for BFF authentication configuration,
 * user representation, context value, and provider props.
 *
 * @packageDocumentation
 */

import type { ReactNode } from "react";

/**
 * Configuration for BFF auth endpoints and behavior.
 *
 * The `basePath` is required — all other properties have sensible defaults
 * defined in `AUTH_DEFAULTS`. User-provided values are merged with defaults
 * on mount.
 */
export interface AuthConfig {
    /** Base path for all BFF auth endpoints (e.g., '/api/auth') */
    basePath: string;
    /** Override individual endpoint paths relative to basePath */
    endpoints?: {
        login?: string;
        callback?: string;
        logout?: string;
        me?: string;
        refresh?: string;
    };
    /** Frontend route path for login page — AuthGuard redirects here (default: '/login') */
    loginPath?: string;
    /** Frontend path to redirect after login (default: '/') */
    defaultReturnTo?: string;
    /** Auto-refresh tokens before expiry (default: true) */
    autoRefresh?: boolean;
    /** Seconds before expiry to trigger refresh (default: 60) */
    refreshLeadTime?: number;
}

/**
 * Authenticated user from OIDC session.
 *
 * The `sub` (subject) claim is required per the OIDC Core spec.
 * Additional claims from the identity provider are available
 * via the index signature.
 */
export interface AuthUser {
    /** Subject identifier from OIDC provider */
    sub: string;
    /** Additional claims from the identity provider */
    [key: string]: unknown;
}

/**
 * Context value provided by AuthProvider, consumed by useAuth().
 *
 * Contains the current authentication state (user, loading, expiry)
 * and action functions (login, logout, refresh).
 */
export interface AuthContextValue {
    /** Current authenticated user, or null if not authenticated */
    user: AuthUser | null;
    /** Whether the user is currently authenticated (derived from user !== null) */
    isAuthenticated: boolean;
    /** Whether the initial session check is in progress */
    isLoading: boolean;
    /** Redirect to the BFF login endpoint. Optional returnTo path for post-login redirect. */
    login: (returnTo?: string) => void;
    /** Sign out via the BFF logout endpoint and clear local state */
    logout: () => Promise<void>;
    /** Manually refresh the session. Returns true on success, false on failure. */
    refresh: () => Promise<boolean>;
    /** Unix timestamp (seconds) when the session expires, or null if unknown */
    expiresAt: number | null;
        /** Resolved configuration with all defaults applied */
    config: ResolvedAuthConfig;
}

/**
 * Fully resolved auth config with all properties required,
 * including nested endpoint paths. Produced by merging user
 * config with AUTH_DEFAULTS on mount.
 */
export interface ResolvedAuthConfig {
    /** Base path for all BFF auth endpoints */
    basePath: string;
    /** All endpoint paths — fully resolved, no optionals */
    endpoints: Required<NonNullable<AuthConfig["endpoints"]>>;
    /** Frontend route path for login page */
    loginPath: string;
    /** Frontend path to redirect after login */
    defaultReturnTo: string;
    /** Whether auto-refresh is enabled */
    autoRefresh: boolean;
    /** Seconds before expiry to trigger refresh */
    refreshLeadTime: number;
}

/**
 * Props for the AuthProvider component.
 */
export interface AuthProviderProps {
    /** Auth configuration — basePath is required, other values have defaults */
    config: AuthConfig;
    /** Application subtree that will have access to auth context */
    children: ReactNode;
}
