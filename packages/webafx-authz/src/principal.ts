/**
 * Principal selection for access guards.
 *
 * An `AuthResult` describes who the caller is; an `AccessPrincipal` describes
 * what they may do. A selector bridges the two so an application can decide
 * where its roles and permissions live without changing the guard.
 *
 * @packageDocumentation
 */

import type { AccessPrincipal } from "@blendsdk/authz";
import type { AuthResult } from "@blendsdk/webafx-auth";

/**
 * Resolves the canonical grants to check from the resolved principal.
 *
 * The default selector reads `claims.roles` and `claims.permissions`, which is
 * where the translation step stores its output. Supply a custom selector when
 * the grants live somewhere else, such as a nested claim or a separate field.
 *
 * @param principal - The authenticated caller, or `undefined` when the request
 *   is anonymous
 * @returns The roles and permissions the caller holds
 *
 * @example
 * ```typescript
 * // Read the grants the server translated and stored on the session.
 * const select: PrincipalSelector = (principal) => ({
 *     roles: Array.isArray(principal?.claims.roles) ? principal.claims.roles : [],
 *     permissions: [],
 * });
 * ```
 */
export type PrincipalSelector = (
    principal: AuthResult | undefined
) => AccessPrincipal;

/**
 * Returns `true` when a runtime value is an object that can be indexed.
 *
 * The principal crosses an `any` boundary in WebAFX, so its `claims` field is
 * not guaranteed to be an object at runtime. This check lets the selector treat
 * a foreign or partial principal as empty instead of throwing.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/**
 * Keeps only the string entries of a value and removes duplicates.
 *
 * Claims are untrusted runtime data, so a value that is not an array — or an
 * array that holds a number, an object, or a null — must not reach a guard.
 * The first occurrence of each string wins, which keeps the result order
 * stable.
 *
 * @param value - The value read from a claim
 * @returns The distinct strings found in the value, or an empty list
 */
function readGrantList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const result: string[] = [];
    for (const entry of value) {
        if (typeof entry === "string" && !result.includes(entry)) {
            result.push(entry);
        }
    }
    return result;
}

/**
 * Reads the roles and permissions a caller holds from `claims.roles` and
 * `claims.permissions`.
 *
 * This is the selector a guard uses unless the caller supplies its own. An
 * anonymous request has no claims, so it yields an empty principal and every
 * non-empty requirement fails closed. A principal whose claims are missing or
 * not an object is treated the same way, so a foreign principal cannot turn a
 * denial into an error.
 *
 * **Trust boundary:** these two claims must hold the canonical grants the
 * server wrote *after* translating the provider identity. Raw provider claims
 * are untrusted until they have been translated, so never store them under
 * these names: a token that carries its own `roles` value would otherwise
 * grant authority without the application's allowlist. Translate first (for
 * example in an OIDC callback) and store the result here. When the grants live
 * somewhere else, pass a custom selector instead.
 *
 * @param principal - The authenticated caller, or `undefined` when the request
 *   is anonymous
 * @returns The roles and permissions stored on the principal's claims
 *
 * @example
 * ```typescript
 * const grants = defaultPrincipalSelector({
 *     sub: "user-1",
 *     claims: { roles: ["admin"], permissions: ["invoice:read"] },
 *     token: "t",
 * });
 * // { roles: ["admin"], permissions: ["invoice:read"] }
 * ```
 */
export function defaultPrincipalSelector(
    principal: AuthResult | undefined
): AccessPrincipal {
    if (!principal || !isRecord(principal.claims)) {
        return { roles: [], permissions: [] };
    }

    const claims = principal.claims;
    return {
        roles: readGrantList(claims["roles"]),
        permissions: readGrantList(claims["permissions"]),
    };
}
