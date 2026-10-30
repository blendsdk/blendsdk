/**
 * Built-in claim profiles.
 *
 * A profile knows how one identity provider names its groups, roles, and
 * permissions, and turns those claims into the namespaced keys that
 * translation understands. These profiles cover generic OIDC and Azure Entra
 * ID; an application with a different provider can implement its own
 * {@link ClaimsProfile}.
 *
 * @packageDocumentation
 */

import { grantKey } from "./translation.js";
import type { ClaimsProfile, ProviderIdentity } from "./types.js";

/**
 * Returns the highest-precedence value for a claim.
 *
 * Claims merge with the order `userInfo`, then `idTokenClaims`, then
 * `accessTokenClaims`, so the access token wins when several sources carry the
 * same claim. Within the winning source the claim replaces earlier ones rather
 * than merging with them.
 *
 * @param identity - The provider identity to read
 * @param name - The claim name to look up
 * @returns The winning claim value, or `undefined` when no source defines it
 */
function mergedClaim(identity: ProviderIdentity, name: string): unknown {
    const sources = [
        identity.userInfo,
        identity.idTokenClaims,
        identity.accessTokenClaims,
    ];

    let value: unknown;
    for (const source of sources) {
        if (source && Object.hasOwn(source, name)) {
            value = source[name];
        }
    }
    return value;
}

/**
 * Narrows an unknown value to an array of strings.
 *
 * Every entry must be a string; a non-array value or a non-string entry is
 * dropped. This keeps malformed provider claims from reaching a principal.
 *
 * @param value - The claim value to read
 * @returns The string entries, or an empty array when the value is unsuitable
 */
function readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * The generic OIDC claim profile.
 *
 * Reads a `roles` array and a `permissions` array from the merged claims and
 * emits `role:` and `permission:` keys. Use it when the provider sends
 * application-friendly claim names.
 *
 * @example
 * ```typescript
 * genericClaimsProfile.extract({
 *     userInfo: { roles: ["admin"], permissions: ["invoice:read"] },
 * });
 * // ["role:admin", "permission:invoice:read"]
 * ```
 */
export const genericClaimsProfile: ClaimsProfile = {
    name: "generic",
    extract(identity: ProviderIdentity): readonly string[] {
        const keys: string[] = [];

        for (const role of readStringArray(mergedClaim(identity, "roles"))) {
            keys.push(grantKey("role", role));
        }
        for (const permission of readStringArray(mergedClaim(identity, "permissions"))) {
            keys.push(grantKey("permission", permission));
        }

        return keys;
    },
};

/**
 * The Azure Entra ID claim profile.
 *
 * Reads the `roles` array, the space-delimited `scp` (scope) claim, and the
 * `groups` array from the merged claims, emitting `role:`, `scp:`, and
 * `group:` keys. It never emits `permission:` because Azure scopes are not
 * application permissions; an application grants permissions by mapping `scp:`
 * and `group:` keys in its grant map.
 *
 * @example
 * ```typescript
 * azureClaimsProfile.extract({
 *     userInfo: {},
 *     accessTokenClaims: {
 *         roles: ["App.Admin"],
 *         scp: "Invoice.Read Invoice.Write",
 *         groups: ["Finance"],
 *     },
 * });
 * // ["role:App.Admin", "scp:Invoice.Read", "scp:Invoice.Write", "group:Finance"]
 * ```
 */
export const azureClaimsProfile: ClaimsProfile = {
    name: "azure",
    extract(identity: ProviderIdentity): readonly string[] {
        const keys: string[] = [];

        for (const role of readStringArray(mergedClaim(identity, "roles"))) {
            keys.push(grantKey("role", role));
        }

        const scp = mergedClaim(identity, "scp");
        if (typeof scp === "string") {
            for (const scope of scp.split(/\s+/)) {
                if (scope.length > 0) {
                    keys.push(grantKey("scp", scope));
                }
            }
        }

        for (const group of readStringArray(mergedClaim(identity, "groups"))) {
            keys.push(grantKey("group", group));
        }

        return keys;
    },
};
