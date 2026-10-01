/**
 * WebAFX route authorization helpers.
 *
 * This package connects the provider-agnostic authorization core to WebAFX:
 * it turns requirements into the `AuthorizeFunction` shape that
 * `route.authorize()` expects, decodes provider tokens, and registers a claims
 * translator in the service container.
 *
 * The server remains authoritative. These helpers decide whether a request may
 * proceed; any check the browser performs is presentation only.
 *
 * Guards read the canonical grants your server stored after translating the
 * provider identity. Translate raw provider claims before storing them, and
 * pass a custom selector when the grants live somewhere other than
 * `claims.roles` and `claims.permissions`.
 *
 * @example
 * ```typescript
 * import {
 *     requireAccess,
 *     requireScopes,
 *     buildProviderIdentity,
 *     createClaimsTranslatorPlugin,
 * } from "@blendsdk/webafx-authz";
 *
 * app.use(createClaimsTranslatorPlugin(translator));
 *
 * this.route()
 *     .get("/invoices")
 *     .secure()
 *     .authorize(requireAccess({ permissions: ["invoice:read"] }))
 *     .handle(this.listInvoices);
 * ```
 *
 * @packageDocumentation
 */

export type { PrincipalSelector } from "./principal.js";
export { defaultPrincipalSelector } from "./principal.js";
export type { RequireAccessOptions } from "./require-access.js";
export { requireAccess } from "./require-access.js";
export { requireScopes } from "./require-scopes.js";
export { buildProviderIdentity, decodeJwtClaims } from "./identity.js";
export type { ClaimsTranslatorPluginOptions } from "./plugin.js";
export {
    CLAIMS_TRANSLATOR_SERVICE,
    createClaimsTranslatorPlugin,
} from "./plugin.js";
