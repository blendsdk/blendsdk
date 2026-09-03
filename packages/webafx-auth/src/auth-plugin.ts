/**
 * Auth plugin factory — bridges any AuthProvider into WebAFX's service container.
 *
 * `createAuthPlugin()` returns a `PluginDefinition` that, when installed
 * via `app.use()`, registers:
 *
 * 1. The provider as a **singleton** service (default name: `'auth'`)
 * 2. A **per-request** `'user'` factory that calls `provider.authenticate(req)`
 *
 * This makes `this.authenticated()` work on any controller — the secure
 * guard resolves `'user'` via the per-request factory.
 *
 * @example
 * ```typescript
 * import { createAuthPlugin, JwtAuthProvider } from '@blendsdk/webafx-auth';
 *
 * const provider = new JwtAuthProvider({ secret: process.env.JWT_SECRET });
 * app.use(createAuthPlugin(provider));
 * ```
 *
 * @packageDocumentation
 */

import type { PluginDefinition } from "@blendsdk/webafx";

import type { AuthProvider } from "./abstract-auth-provider.js";
import type { JwtAuthConfig, MemoryAuthConfig } from "./types.js";
import type { OidcAuthConfig } from "./oidc-types.js";
import { DEFAULT_PLUGIN_PRIORITY, DEFAULT_SERVICE_NAME } from "./types.js";
import { JwtAuthProvider } from "./jwt-auth-provider.js";
import { MemoryAuthProvider } from "./memory-auth-provider.js";
import { OidcAuthProvider } from "./oidc-auth-provider.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for createAuthPlugin().
 *
 * All fields are optional — sensible defaults are applied when omitted.
 */
export interface AuthPluginOptions {
    /**
     * Service name for the provider in the DI container.
     * Controllers retrieve the provider via `req.services.get(serviceName)`.
     * Default: `'auth'` (DEFAULT_SERVICE_NAME)
     */
    serviceName?: string;

    /**
     * Service name for the authenticated user in the DI container.
     * The secure guard resolves this name to determine if a request
     * is authenticated. Default: `'user'`
     */
    userServiceName?: string;

    /**
     * Plugin installation priority. Lower numbers install first.
     * Auth plugins should install early (before feature plugins)
     * so that the `'user'` service is available to all routes.
     * Default: `10` (DEFAULT_PLUGIN_PRIORITY)
     */
    priority?: number;
}

// ---------------------------------------------------------------------------
// Factory Function
// ---------------------------------------------------------------------------

/**
 * Creates a WebAFX plugin that bridges an AuthProvider into the service container.
 *
 * Registers two services:
 * 1. The provider as a singleton (default name: `'auth'`) — accessible via
 *    `req.services.get<AuthProvider>('auth')` in controllers.
 * 2. A per-request `'user'` factory that calls `provider.authenticate(req)` —
 *    returns `AuthResult | undefined`. When installed, the secure guard on
 *    routes resolves `'user'` and grants/denies access automatically.
 *
 * The returned Plugin object delegates `health()` and `shutdown()` to the
 * provider, integrating with WebAFX's health check and graceful shutdown
 * lifecycles.
 *
 * @param provider - Any AuthProvider instance (Jwt, Oidc, Memory, etc.)
 * @param options - Optional service name, user service name, priority overrides
 * @returns PluginDefinition for use with `app.use()`
 */
export function createAuthPlugin(
    provider: AuthProvider,
    options?: AuthPluginOptions
): PluginDefinition {
    const {
        serviceName = DEFAULT_SERVICE_NAME,
        userServiceName = "user",
        priority = DEFAULT_PLUGIN_PRIORITY,
    } = options ?? {};

    return {
        name: `auth:${serviceName}`,
        priority,
        factory: async ({ app, logger }) => {
            // 1. Register the provider as a singleton service.
            // Controllers can retrieve it via req.services.get<AuthProvider>(serviceName).
            app.registerService({
                name: serviceName,
                type: "singleton",
                factory: () => provider,
            });

            // 2. Register a per-request 'user' factory.
            // On each request, the secure guard calls req.services.get('user', undefined).
            // The factory delegates to provider.authenticate(req) which returns
            // AuthResult (authenticated) or undefined (unauthenticated).
            app.registerService({
                name: userServiceName,
                type: "per-request",
                factory: async (_container, _settings, req) => {
                    return provider.authenticate(req);
                },
            });

            logger.info(
                `Auth plugin installed: ${provider.constructor.name} as '${serviceName}'`
            );

            // 3. Delegate health and shutdown to the provider so WebAFX's
            // health endpoint and graceful shutdown lifecycle manage the
            // provider automatically.
            return {
                health: () => provider.health(),
                shutdown: () => provider.shutdown(),
            };
        },
    };
}

// ---------------------------------------------------------------------------
// Convenience Factories
// ---------------------------------------------------------------------------

/**
 * Convenience factory: creates an OIDC auth plugin in one step.
 *
 * Shorthand for `createAuthPlugin(new OidcAuthProvider(config), options)`.
 *
 * @param config - OIDC configuration (issuerUrl, clientId, clientSecret, redirectUri, etc.)
 * @param options - Optional plugin options (serviceName, userServiceName, priority)
 * @returns PluginDefinition for use with `app.use()`
 *
 * @example
 * ```typescript
 * app.use(oidcAuthPlugin({
 *     issuerUrl: process.env.OIDC_ISSUER_URL,
 *     clientId: process.env.OIDC_CLIENT_ID,
 *     clientSecret: process.env.OIDC_CLIENT_SECRET,
 *     redirectUri: `${process.env.APP_URL}/api/oidc/callback`,
 * }));
 * ```
 */
export function oidcAuthPlugin(
    config: OidcAuthConfig,
    options?: AuthPluginOptions,
): PluginDefinition {
    return createAuthPlugin(new OidcAuthProvider(config), options);
}

/**
 * Convenience factory: creates a JWT auth plugin in one step.
 *
 * Shorthand for `createAuthPlugin(new JwtAuthProvider(config), options)`.
 *
 * @param config - JWT configuration (secret or publicKey, algorithm, etc.)
 * @param options - Optional plugin options (serviceName, userServiceName, priority)
 * @returns PluginDefinition for use with `app.use()`
 *
 * @example
 * ```typescript
 * app.use(jwtAuthPlugin({ secret: process.env.JWT_SECRET }));
 * ```
 */
export function jwtAuthPlugin(
    config: JwtAuthConfig,
    options?: AuthPluginOptions,
): PluginDefinition {
    return createAuthPlugin(new JwtAuthProvider(config), options);
}

/**
 * Convenience factory: creates a memory auth plugin for testing.
 *
 * Shorthand for `createAuthPlugin(new MemoryAuthProvider(config), options)`.
 *
 * @param config - Memory configuration (validTokens map)
 * @param options - Optional plugin options (serviceName, userServiceName, priority)
 * @returns PluginDefinition for use with `app.use()`
 *
 * @example
 * ```typescript
 * app.use(memoryAuthPlugin({
 *     validTokens: {
 *         "test-token": { sub: "user-1", claims: {}, token: "test-token" },
 *     },
 * }));
 * ```
 */
export function memoryAuthPlugin(
    config: MemoryAuthConfig,
    options?: AuthPluginOptions,
): PluginDefinition {
    return createAuthPlugin(new MemoryAuthProvider(config), options);
}
