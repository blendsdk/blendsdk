/**
 * Internal helpers shared by the OIDC provider and controller.
 *
 * These utilities cover CSRF token generation and validation, raw-cookie
 * parsing, and session cleaning. They live here to keep the controller within
 * its size budget and to give the security-sensitive comparison one
 * implementation.
 *
 * @packageDocumentation
 */

import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { constantTimeTokenMatch } from "@blendsdk/webafx";
import type { OidcCsrfConfig, OidcSession } from "./oidc-types.js";

/** Default header carrying the session-bound CSRF token. */
const DEFAULT_CSRF_HEADER = "x-csrf-token";

/**
 * Generate a new session-bound CSRF token.
 *
 * @returns A 256-bit random token encoded as base64url
 */
export function generateCsrfToken(): string {
    return randomBytes(32).toString("base64url");
}

/**
 * Validate the session-bound CSRF token for a mutating request.
 *
 * Comparison is constant-time. A missing header, a missing session token, or a
 * mismatch writes the standard `403` envelope and returns false so the caller
 * aborts. The session is never modified here.
 *
 * @param req - Express request carrying the token header
 * @param res - Express response used to write the rejection
 * @param config - The controller CSRF configuration
 * @param session - The resolved session, if any
 * @returns True when the request may proceed
 */
export function assertOidcCsrf(
    req: Request,
    res: Response,
    config: OidcCsrfConfig,
    session: OidcSession | undefined
): boolean {
    const header = (config.header ?? DEFAULT_CSRF_HEADER).toLowerCase();
    const raw = req.headers[header];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (constantTimeTokenMatch(provided, session?.csrfToken)) {
        return true;
    }
    res.status(403).json({
        success: false,
        error: {
            code: "csrf_invalid",
            message: "Invalid or missing CSRF token",
        },
    });
    return false;
}

/**
 * Parse a specific cookie value from the raw Cookie header.
 *
 * Self-contained — does not require the cookie-parser middleware. Handles
 * URL-encoded values via `decodeURIComponent`.
 *
 * @param req - Express request object
 * @param name - Cookie name to look for
 * @returns The decoded cookie value, or undefined if not found
 */
export function parseCookie(req: Request, name: string): string | undefined {
    const cookieHeader = req.headers?.cookie;
    if (!cookieHeader) return undefined;

    const prefix = `${name}=`;
    const cookies = cookieHeader.split("; ");
    for (const cookie of cookies) {
        if (cookie.startsWith(prefix)) {
            const raw = cookie.slice(prefix.length);
            try {
                return decodeURIComponent(raw);
            } catch {
                return raw;
            }
        }
    }
    return undefined;
}

/**
 * Strip null and undefined values from an object.
 *
 * Used to keep session storage clean: undefined token fields are not stored as
 * keys.
 *
 * @param obj - Source object
 * @returns A new object without null or undefined values
 */
export function stripNullValues<T>(obj: T): T {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        if (value !== null && value !== undefined) {
            result[key] = value;
        }
    }
    return result as T;
}
