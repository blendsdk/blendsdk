/**
 * OpenAPI metadata for the OIDC BFF controller routes.
 *
 * The controller attaches this metadata to its five routes with `.openapi()`,
 * which opts them into generated OpenAPI clients under the `oidc` tag. Keeping
 * the schemas here holds the controller near its size budget and gives the
 * route documentation one home.
 *
 * Success response schemas describe the unwrapped `data` payload produced by
 * `BaseController.ok()` (the generator's default `data` envelope). Error
 * schemas describe the full `{ success: false, error }` envelope.
 *
 * @packageDocumentation
 */

import { z } from "zod";
import type { OpenAPIRouteMetadata } from "@blendsdk/webafx";

/** Shared error envelope: `{ success: false, error: { code, message } }`. */
const oidcErrorSchema = z.object({
    success: z.literal(false),
    error: z.object({
        code: z.string(),
        message: z.string(),
    }),
});

/** `POST /logout` success payload. */
const logoutSuccessSchema = z.object({
    message: z.string(),
});

/**
 * `GET /me` success payload.
 *
 * Exported so tests can assert the shape; it is not part of the package entry
 * point.
 */
export const meSuccessSchema = z.object({
    user: z.record(z.string(), z.unknown()),
    expiresAt: z.number().optional(),
    authorized: z.boolean(),
    csrfToken: z.string().optional(),
});

/** `POST /refresh` success payload. */
const refreshSuccessSchema = z.object({
    expiresAt: z.number().optional(),
    message: z.string(),
    csrfToken: z.string().optional(),
});

/**
 * OpenAPI metadata for each OIDC BFF route, keyed by handler purpose.
 *
 * All five carry the `oidc` tag and a unique `operationId` so a generated
 * client can address them.
 */
export const oidcOpenApi: {
    login: OpenAPIRouteMetadata;
    callback: OpenAPIRouteMetadata;
    logout: OpenAPIRouteMetadata;
    me: OpenAPIRouteMetadata;
    refresh: OpenAPIRouteMetadata;
} = {
    login: {
        summary: "Start OIDC login",
        description:
            "Redirects the browser to the OIDC provider's authorization endpoint " +
            "and stores the PKCE state for the callback.",
        tags: ["oidc"],
        operationId: "oidcLogin",
        responses: [
            {
                statusCode: 302,
                description: "Redirect to the authorization endpoint",
            },
        ],
    },
    callback: {
        summary: "Handle OIDC callback",
        description:
            "Validates the state, exchanges the authorization code for tokens, " +
            "verifies the ID token, and creates the server-side session. A failed " +
            "sign-in returns a fixed 400; a UserInfo denial returns a fixed 403 or " +
            "creates an unauthorized session, depending on configuration.",
        tags: ["oidc"],
        operationId: "oidcCallback",
        responses: [
            { statusCode: 302, description: "Redirect to the original URL" },
            {
                statusCode: 400,
                description: "Invalid or expired callback",
                schema: oidcErrorSchema,
            },
            {
                statusCode: 403,
                description: "UserInfo endpoint denied access",
                schema: oidcErrorSchema,
            },
        ],
    },
    logout: {
        summary: "Log out",
        description:
            "Revokes the access token, clears the server-side session, and clears " +
            "the session cookie. When CSRF enforcement is enabled, the session " +
            "token must be present in the configured header.",
        tags: ["oidc"],
        operationId: "oidcLogout",
        responses: [
            { statusCode: 200, description: "Logged out", schema: logoutSuccessSchema },
            {
                statusCode: 403,
                description: "Invalid or missing CSRF token",
                schema: oidcErrorSchema,
            },
        ],
    },
    me: {
        summary: "Get the current session",
        description:
            "Returns the authenticated user's claims and session expiry. Access " +
            "and refresh tokens are never returned.",
        tags: ["oidc"],
        operationId: "oidcMe",
        responses: [
            {
                statusCode: 200,
                description: "Current user session",
                schema: meSuccessSchema,
            },
            {
                statusCode: 401,
                description: "No active session",
                schema: oidcErrorSchema,
            },
        ],
    },
    refresh: {
        summary: "Refresh the session",
        description:
            "Refreshes the access token and updates the server-side session. When " +
            "session-id rotation is enabled the returned CSRF token is regenerated.",
        tags: ["oidc"],
        operationId: "oidcRefresh",
        responses: [
            {
                statusCode: 200,
                description: "Tokens refreshed",
                schema: refreshSuccessSchema,
            },
            {
                statusCode: 400,
                description: "No refresh token available",
                schema: oidcErrorSchema,
            },
            {
                statusCode: 401,
                description: "No active session",
                schema: oidcErrorSchema,
            },
            {
                statusCode: 403,
                description: "Invalid or missing CSRF token",
                schema: oidcErrorSchema,
            },
        ],
    },
};
