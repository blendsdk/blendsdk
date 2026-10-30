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
export { useAuthorization } from "./use-authorization.js";
export { RequireAccess } from "./require-access.js";
export { Can } from "./can.js";
export type {
    AuthConfig,
    AuthUser,
    AuthContextValue,
    AuthProviderProps,
    ResolvedAuthConfig,
} from "./auth-types.js";
export type { UseAuthorizationResult } from "./use-authorization.js";
export type { RequireAccessProps } from "./require-access.js";
export type { CanProps } from "./can.js";
