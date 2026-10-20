/**
 * Runtime guards for untrusted values.
 *
 * Values that arrive from a token or a request are `unknown` until they are
 * checked. These guards make the check explicit and let TypeScript narrow the
 * value to the application's own type without a cast.
 *
 * @packageDocumentation
 */

/**
 * Returns `true` when `value` is a string that appears in `allowed`.
 *
 * Use this to validate a claim read from a token against the application's own
 * vocabulary before trusting it. Because the parameter is `unknown`, the guard
 * also rejects values of the wrong type instead of failing later.
 *
 * @param value - The untrusted value to check
 * @param allowed - The application-owned values that are acceptable
 * @returns `true` when `value` is one of the allowed strings
 *
 * @example
 * ```typescript
 * const ROLES = { Admin: "admin", User: "user" } as const;
 * const raw: unknown = claim.role;
 *
 * if (isOneOf(raw, Object.values(ROLES))) {
 *     // `raw` is now typed as "admin" | "user"
 *     grant(raw);
 * }
 * ```
 */
export function isOneOf<const T extends string>(
    value: unknown,
    allowed: readonly T[]
): value is T {
    return typeof value === "string" && allowed.some(candidate => candidate === value);
}
