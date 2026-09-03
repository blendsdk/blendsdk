/**
 * Default configuration values for the auth module.
 *
 * These defaults are merged with user-provided config on mount.
 * All endpoint paths are relative to the configured `basePath`.
 *
 * @packageDocumentation
 */

/**
 * Default auth configuration values, merged with user config on mount.
 *
 * Endpoint paths are relative to `basePath` (e.g., basePath="/api/auth"
 * and login="/login" results in "/api/auth/login").
 */
export const AUTH_DEFAULTS = {
    endpoints: {
        login: "/login",
        callback: "/callback",
        logout: "/logout",
        me: "/me",
        refresh: "/refresh",
    },
    loginPath: "/login",
    defaultReturnTo: "/",
    autoRefresh: true,
    refreshLeadTime: 60,
} as const;
