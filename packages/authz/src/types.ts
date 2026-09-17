/**
 * Authorization vocabulary shared by server and client runtimes.
 *
 * These types describe what a caller is allowed to do, independently of the
 * identity provider that authenticated them. A role is a coarse label such as
 * `admin`; a permission is a fine-grained capability such as `invoice:read`.
 * Both are plain strings, so an application owns its vocabulary and this
 * package never ships default names.
 *
 * @packageDocumentation
 */

/**
 * A named role that groups related permissions.
 *
 * Roles are free-form strings. Applications define their own values, usually
 * in one shared constant object, and reuse them on the server and in the
 * browser.
 *
 * @example
 * ```typescript
 * const ROLES = { Admin: "admin", User: "user" } as const;
 * const admin: Role = ROLES.Admin;
 * ```
 */
export type Role = string;

/**
 * A named capability, conventionally written `resource:action`.
 *
 * Permissions are free-form strings, so an application can adopt any naming
 * scheme. The convention `resource:action` (for example `invoice:read`) reads
 * well in logs and keeps related capabilities grouped.
 *
 * @example
 * ```typescript
 * const PERMISSIONS = { InvoiceRead: "invoice:read" } as const;
 * const read: Permission = PERMISSIONS.InvoiceRead;
 * ```
 */
export type Permission = string;

/**
 * The grants a principal holds.
 *
 * A principal is whoever the request is acting as. The two lists are the only
 * thing authorization checks look at, which keeps evaluation independent of
 * how the grants were obtained.
 *
 * @example
 * ```typescript
 * const principal: AccessPrincipal = {
 *     roles: ["admin"],
 *     permissions: ["invoice:read"],
 * };
 * ```
 */
export interface AccessPrincipal {
    /** Roles the principal holds. */
    roles: readonly Role[];
    /** Permissions the principal holds. */
    permissions: readonly Permission[];
}

/**
 * How an access requirement combines its lists.
 *
 * - `'any'` — the principal must hold at least one listed role or permission.
 * - `'all'` — the principal must hold every listed role and permission.
 */
export type AccessMode = "any" | "all";

/**
 * A check to run against a principal.
 *
 * An absent or empty requirement is always satisfied, which makes it safe to
 * pass through a requirement that an application did not configure.
 *
 * @example
 * ```typescript
 * const requirement: AccessRequirement = {
 *     mode: "all",
 *     roles: ["finance"],
 *     permissions: ["invoice:write"],
 * };
 * ```
 */
export interface AccessRequirement {
    /** Roles the principal must hold, subject to {@link AccessRequirement.mode}. */
    roles?: readonly Role[];
    /** Permissions the principal must hold, subject to {@link AccessRequirement.mode}. */
    permissions?: readonly Permission[];
    /** How the two lists combine. Defaults to `'any'`. */
    mode?: AccessMode;
}

/**
 * The application-owned values that may grant authority without a map entry.
 *
 * This is the allowlist for canonical claims. A claim such as `role:admin`
 * grants the `admin` role only when the application lists `admin` here, which
 * keeps authority with the application instead of the identity provider.
 */
export interface AllowedGrants {
    /** Canonical roles that may be granted directly from a claim. */
    roles?: readonly Role[];
    /** Canonical permissions that may be granted directly from a claim. */
    permissions?: readonly Permission[];
}

/**
 * The provider claims and tokens collected for one identity.
 *
 * A profile reads these claims and turns them into namespaced keys. Fields are
 * optional because a provider may supply only some of them.
 */
export interface ProviderIdentity {
    /** User info returned by the provider, such as the OIDC `/userinfo` response. */
    userInfo: Record<string, unknown>;
    /** Claims decoded from the OIDC identity token, when one is available. */
    idTokenClaims?: Record<string, unknown>;
    /** Claims decoded from the access token, when one is available. */
    accessTokenClaims?: Record<string, unknown>;
    /** OAuth scopes granted to the access token. */
    scopes?: readonly string[];
}

/**
 * The provider claim family a namespaced key came from.
 *
 * - `'role'` — a role claim, for example an OIDC `roles` array.
 * - `'scp'` — an OAuth scope claim, for example the Azure `scp` string.
 * - `'group'` — a directory group claim.
 * - `'permission'` — a canonical permission value.
 */
export type GrantSource = "role" | "scp" | "group" | "permission";

/**
 * Maps a namespaced key to the canonical grants it confers.
 *
 * The map is trusted application configuration: a listed key always grants its
 * mapped values, even when those values are not in an allowlist. This is how
 * an application translates provider-specific labels, such as Azure groups,
 * into its own roles and permissions.
 *
 * @example
 * ```typescript
 * const map: GrantMap = {
 *     "group:Finance": { roles: ["finance"] },
 *     "scp:Invoice.Read": { permissions: ["invoice:read"] },
 * };
 * ```
 */
export type GrantMap = Record<string, Partial<AccessPrincipal>>;

/**
 * Converts a provider identity into the namespaced keys translation understands.
 *
 * Implement this to support a provider whose claims do not match a built-in
 * profile. The two built-in profiles cover generic OIDC and Azure Entra ID.
 */
export interface ClaimsProfile {
    /** Human-readable profile name, for example `'generic'` or `'azure'`. */
    readonly name: string;
    /**
     * Returns namespaced keys such as `role:admin` or `scp:Invoice.Read`.
     *
     * @param identity - The provider identity to read claims from
     * @returns The namespaced keys found in the identity
     */
    extract(identity: ProviderIdentity): readonly string[];
}

/**
 * Converts a provider identity into the canonical grants a principal holds.
 */
export interface ClaimsTranslator {
    /**
     * Translates the identity into the roles and permissions it holds.
     *
     * @param identity - The provider identity to translate
     * @returns The canonical grants conferred by the identity
     */
    translate(identity: ProviderIdentity): AccessPrincipal;
}

/**
 * Options for {@link createClaimsTranslator}.
 */
export interface TranslatorOptions {
    /**
     * Canonical values that may grant authority without a map entry. When
     * omitted, an unmapped key grants nothing, so translation fails closed.
     */
    allowed?: AllowedGrants;
    /**
     * Called for every key that yields no grant. The callback receives the key
     * name only, never a claim value, so the key is safe to log.
     */
    onUnmapped?: (key: string) => void;
}
