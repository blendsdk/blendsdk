/**
 * Auth module barrel export.
 *
 * Re-exports all public auth types, constants, components, and hooks.
 *
 * @packageDocumentation
 */

export { AuthProvider } from "./auth-provider.js";
export { AuthGuard } from "./auth-guard.js";
export { useAuth } from "./use-auth.js";
export { AUTH_DEFAULTS } from "./auth-defaults.js";
export type {
    AuthConfig,
    AuthUser,
    AuthContextValue,
    AuthProviderProps,
    ResolvedAuthConfig,
} from "./auth-types.js";
