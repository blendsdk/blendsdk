/**
 * Provider-agnostic authorization primitives.
 *
 * This package defines what a role and a permission are, how provider claims
 * become canonical grants, and how a requirement is evaluated against a
 * principal. It has no runtime dependencies, so the same code can run on the
 * server and in the browser.
 *
 * A typical use translates a provider identity once, stores the resulting
 * roles and permissions on the session, and then evaluates requirements
 * against them:
 *
 * @example
 * ```typescript
 * import {
 *     createClaimsTranslator,
 *     genericClaimsProfile,
 *     satisfiesAccess,
 * } from "@blendsdk/authz";
 *
 * const ROLES = { Admin: "admin" } as const;
 * const PERMISSIONS = { InvoiceRead: "invoice:read" } as const;
 *
 * const translator = createClaimsTranslator(
 *     genericClaimsProfile,
 *     { "role:app-admin": { roles: [ROLES.Admin] } },
 *     {
 *         allowed: {
 *             roles: Object.values(ROLES),
 *             permissions: Object.values(PERMISSIONS),
 *         },
 *     }
 * );
 *
 * const principal = translator.translate({
 *     userInfo: { roles: ["user"], permissions: ["invoice:read"] },
 * });
 *
 * satisfiesAccess(principal, { permissions: [PERMISSIONS.InvoiceRead] }); // true
 * ```
 *
 * The interfaces in this module are types only; the functions are the runtime
 * surface.
 *
 * @packageDocumentation
 */

export type {
    AccessMode,
    AccessPrincipal,
    AccessRequirement,
    AllowedGrants,
    ClaimsProfile,
    ClaimsTranslator,
    GrantMap,
    GrantSource,
    Permission,
    ProviderIdentity,
    Role,
    TranslatorOptions,
} from "./types.js";

export { isOneOf } from "./guards.js";
export { hasPermission, hasRole, satisfiesAccess } from "./evaluate.js";
export { createClaimsTranslator, grantKey, resolveGrants } from "./translation.js";
export { azureClaimsProfile, genericClaimsProfile } from "./profiles.js";
