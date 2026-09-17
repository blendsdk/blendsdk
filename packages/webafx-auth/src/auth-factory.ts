/**
 * Environment-based authentication provider factory.
 *
 * `createAuthProvider()` selects a concrete `AuthProvider` from a single
 * `AuthFactoryConfig`. It is the counterpart to the plugin conveniences in
 * `auth-plugin.ts`: the factory builds the provider, and `createAuthPlugin()`
 * registers it with the WebAFX service container.
 *
 * The factory validates the fields each provider requires and throws a clear
 * error naming the missing field, so a misconfiguration fails at startup
 * rather than at the first request.
 *
 * @example
 * ```typescript
 * import { createAuthProvider, createAuthPlugin } from "@blendsdk/webafx-auth";
 *
 * app.use(createAuthPlugin(createAuthProvider({
 *     type: "introspection",
 *     introspectionUrl: process.env.OIDC_INTROSPECT_URL,
 *     clientId: process.env.OIDC_CLIENT_ID,
 *     clientSecret: process.env.OIDC_CLIENT_SECRET,
 * })));
 * ```
 *
 * @packageDocumentation
 */

import type { AuthProvider } from "./abstract-auth-provider.js";
import type { AuthFactoryConfig, AuthProviderConfig } from "./types.js";
import { IntrospectionAuthProvider } from "./introspection-auth-provider.js";
import { JwtAuthProvider } from "./jwt-auth-provider.js";
import { MemoryAuthProvider } from "./memory-auth-provider.js";
import { OidcAuthProvider } from "./oidc-auth-provider.js";

/**
 * Extract the configuration fields shared by every provider.
 *
 * @param config - The factory configuration
 * @returns The base {@link AuthProviderConfig} slice
 */
function baseConfig(config: AuthFactoryConfig): AuthProviderConfig {
    return {
        serviceName: config.serviceName,
        tokenSources: config.tokenSources,
        cookieName: config.cookieName,
        queryParamName: config.queryParamName,
        mapClaims: config.mapClaims,
        principalType: config.principalType,
    };
}

/**
 * Type guard: does the factory config carry a complete static client triple?
 *
 * @param config - The factory configuration
 * @returns true when `introspectionUrl`, `clientId`, and `clientSecret` are set
 */
function hasCompleteTriple(config: AuthFactoryConfig): config is AuthFactoryConfig & {
    introspectionUrl: string;
    clientId: string;
    clientSecret: string;
} {
    return Boolean(
        config.introspectionUrl && config.clientId && config.clientSecret
    );
}

/**
 * Create an authentication provider from a factory configuration.
 *
 * Dispatches on `config.type`:
 * - `'jwt'` — local JWT verification; requires `secret`.
 * - `'introspection'` — RFC 7662 opaque token introspection; requires the
 *   static triple (`introspectionUrl`, `clientId`, `clientSecret`) or a
 *   `configFactory` for DB-backed credentials.
 * - `'oidc'` — OIDC discovery/JWKS; requires `issuerUrl`.
 * - `'memory'` — testing provider; no required fields.
 *
 * @param config - Provider selection and provider-specific configuration
 * @returns The constructed provider
 * @throws Error when a required field for the selected type is missing
 */
export function createAuthProvider(config: AuthFactoryConfig): AuthProvider {
    const base = baseConfig(config);

    switch (config.type) {
        case "jwt": {
            if (!config.secret) {
                throw new Error(
                    "createAuthProvider: type 'jwt' requires 'secret'"
                );
            }
            return new JwtAuthProvider({
                ...base,
                secret: config.secret,
                algorithms: config.algorithms,
                issuer: config.issuer,
                audience: config.audience,
                requireAudience: config.requireAudience,
                clockTolerance: config.clockTolerance,
            });
        }

        case "introspection": {
            if (hasCompleteTriple(config)) {
                return new IntrospectionAuthProvider({
                    ...base,
                    introspectionUrl: config.introspectionUrl,
                    clientId: config.clientId,
                    clientSecret: config.clientSecret,
                    audience: config.audience,
                    authMethod: config.authMethod,
                    cacheTTL: config.cacheTTL,
                    maxCacheSize: config.maxCacheSize,
                    timeout: config.timeout,
                    configFactory: config.configFactory,
                });
            }
            if (config.configFactory) {
                return new IntrospectionAuthProvider({
                    ...base,
                    audience: config.audience,
                    authMethod: config.authMethod,
                    cacheTTL: config.cacheTTL,
                    maxCacheSize: config.maxCacheSize,
                    timeout: config.timeout,
                    configFactory: config.configFactory,
                });
            }
            throw new Error(
                "createAuthProvider: type 'introspection' requires " +
                    "'introspectionUrl', 'clientId' and 'clientSecret', " +
                    "or 'configFactory'"
            );
        }

        case "oidc": {
            if (!config.issuerUrl) {
                throw new Error(
                    "createAuthProvider: type 'oidc' requires 'issuerUrl'"
                );
            }
            return new OidcAuthProvider({
                ...base,
                issuerUrl: config.issuerUrl,
                clientId: config.clientId,
                clientSecret: config.clientSecret,
                audience: config.audience,
                requireAudience: config.requireAudience,
                clockTolerance: config.clockTolerance,
            });
        }

        case "memory": {
            return new MemoryAuthProvider({
                ...base,
                validTokens: config.validTokens,
            });
        }

        default: {
            throw new Error(
                `createAuthProvider: unsupported type '${String(
                    config.type
                )}'`
            );
        }
    }
}
