/**
 * Grant translation.
 *
 * Translation turns the namespaced keys a
 * {@link ClaimsProfile} reports into the canonical roles and permissions a
 * principal holds. Two rules keep authority with the application:
 *
 * 1. A key whose mapping the application declared always grants its mapped
 *    values.
 * 2. A key with no mapping grants a canonical role or permission only when the
 *    application lists that value in `allowed`.
 *
 * When no allowlist is supplied, rule 2 grants nothing, so translation fails
 * closed by default.
 *
 * @packageDocumentation
 */

import type {
    AccessPrincipal,
    AllowedGrants,
    ClaimsProfile,
    ClaimsTranslator,
    GrantMap,
    GrantSource,
    ProviderIdentity,
    TranslatorOptions,
} from "./types.js";

/**
 * Joins a grant source and a value into the namespaced key format translation
 * understands.
 *
 * @param source - The claim family, such as `'role'` or `'scp'`
 * @param value - The raw value, such as `'admin'` or `'Invoice.Read'`
 * @returns The namespaced key, for example `'role:admin'`
 *
 * @example
 * ```typescript
 * grantKey("role", "admin"); // "role:admin"
 * grantKey("scp", "Invoice.Read"); // "scp:Invoice.Read"
 * ```
 */
export function grantKey(source: GrantSource, value: string): string {
    return `${source}:${value}`;
}

/**
 * Splits a namespaced key at the first colon.
 *
 * The value may itself contain colons, so only the first one separates the
 * source from the value.
 *
 * @param key - The namespaced key to split
 * @returns The source and value, or `undefined` when the key has no colon
 */
function splitKey(key: string): { source: string; value: string } | undefined {
    const separator = key.indexOf(":");
    if (separator === -1) {
        return undefined;
    }
    return { source: key.slice(0, separator), value: key.slice(separator + 1) };
}

/**
 * Returns `true` when a key names a canonical value the application allows.
 *
 * Only `role:` and `permission:` keys are canonical. Provider-specific sources
 * such as `scp:` and `group:` never qualify, whatever the allowlist contains.
 *
 * @param key - The namespaced key to test
 * @param allowed - The application-owned canonical values
 * @returns `true` when the key grants an allowed canonical value
 */
function isAllowedCanonical(key: string, allowed?: AllowedGrants): boolean {
    const parts = splitKey(key);
    if (!parts) {
        return false;
    }
    if (parts.source === "role") {
        return allowed?.roles?.includes(parts.value) ?? false;
    }
    if (parts.source === "permission") {
        return allowed?.permissions?.includes(parts.value) ?? false;
    }
    return false;
}

/**
 * Appends string values to a list, skipping duplicates.
 *
 * A value that is not an array is ignored, and non-string entries within an
 * array are dropped. This keeps malformed runtime data, such as a string or a
 * number in a JSON-parsed claims object, from reaching a principal or from
 * making the translator throw.
 *
 * @param target - The list to append to
 * @param values - The values to append, when the claim is an array of strings
 */
function appendGrant(target: string[], values: unknown): void {
    if (!Array.isArray(values)) {
        return;
    }
    for (const value of values) {
        if (typeof value === "string" && !target.includes(value)) {
            target.push(value);
        }
    }
}

/**
 * Aggregates namespaced keys into canonical grants.
 *
 * Mapped keys are trusted application configuration and grant their mapped
 * values immediately. An unmapped key grants only a canonical `role:` or
 * `permission:` value that appears in `allowed`; every other key contributes
 * nothing. Values are filtered to strings and de-duplicated in first-seen
 * order, and the output arrays are stable.
 *
 * @param keys - The namespaced keys to translate
 * @param map - The application-provided grant map
 * @param allowed - Canonical values that may be granted without a map entry
 * @returns The canonical roles and permissions conferred by the keys
 *
 * @example
 * ```typescript
 * const map = { "scp:Invoice.Read": { permissions: ["invoice:read"] } };
 *
 * resolveGrants(["scp:Invoice.Read"], map);
 * // { roles: [], permissions: ["invoice:read"] }
 *
 * resolveGrants(["role:admin"], {}, { roles: ["admin"] });
 * // { roles: ["admin"], permissions: [] }
 * ```
 */
export function resolveGrants(
    keys: readonly string[],
    map: GrantMap,
    allowed?: AllowedGrants
): AccessPrincipal {
    const roles: string[] = [];
    const permissions: string[] = [];

    for (const key of keys) {
        if (Object.hasOwn(map, key)) {
            const mapped = map[key];
            if (mapped && typeof mapped === "object") {
                appendGrant(roles, mapped.roles);
                appendGrant(permissions, mapped.permissions);
            }
            continue;
        }

        const parts = splitKey(key);
        if (!parts) {
            continue;
        }
        if (parts.source === "role" && allowed?.roles?.includes(parts.value)) {
            appendGrant(roles, [parts.value]);
        } else if (
            parts.source === "permission" &&
            allowed?.permissions?.includes(parts.value)
        ) {
            appendGrant(permissions, [parts.value]);
        }
    }

    return { roles, permissions };
}

/**
 * Creates a translator that reads a profile's keys and applies a grant map.
 *
 * This is the entry point most applications use. On each call the translator
 * extracts the namespaced keys from the identity and aggregates them exactly
 * as {@link resolveGrants} does. When {@link TranslatorOptions.onUnmapped} is
 * provided, it is called once for every key that yields no grant. A key the
 * map lists never triggers the callback, even when its mapped values are empty.
 *
 * @param profile - The claims profile that reads the identity
 * @param map - The application-provided grant map
 * @param options - The allowlist and unmapped-key callback
 * @returns A translator that produces canonical grants from an identity
 *
 * @example
 * ```typescript
 * import { createClaimsTranslator, genericClaimsProfile } from "@blendsdk/authz";
 *
 * const translator = createClaimsTranslator(
 *     genericClaimsProfile,
 *     { "role:app-admin": { roles: ["admin"] } },
 *     { allowed: { roles: ["user"] } }
 * );
 *
 * translator.translate({ userInfo: { roles: ["app-admin", "user"] } });
 * // { roles: ["admin", "user"], permissions: [] }
 * ```
 */
export function createClaimsTranslator(
    profile: ClaimsProfile,
    map: GrantMap,
    options?: TranslatorOptions
): ClaimsTranslator {
    const allowed = options?.allowed;
    const onUnmapped = options?.onUnmapped;

    return {
        translate(identity: ProviderIdentity): AccessPrincipal {
            const keys = profile.extract(identity);

            if (onUnmapped) {
                for (const key of keys) {
                    if (!Object.hasOwn(map, key) && !isAllowedCanonical(key, allowed)) {
                        onUnmapped(key);
                    }
                }
            }

            return resolveGrants(keys, map, allowed);
        },
    };
}
