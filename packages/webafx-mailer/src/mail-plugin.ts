/**
 * WebAFX plugin integration for mail providers.
 *
 * Provides convenience factory functions that wire a MailProvider instance
 * into a WebAFX application as a singleton service with health check and
 * graceful shutdown support.
 *
 * This is the ONLY file in @blendsdk/webafx-mailer that imports from @blendsdk/webafx,
 * which is why webafx is an optional peer dependency (not a hard dependency).
 *
 * The design mirrors @blendsdk/webafx-cache's cache-plugin.ts exactly.
 *
 * @packageDocumentation
 */

import type { PluginDefinition } from "@blendsdk/webafx";

import { MailProvider } from "./abstract-mail-provider.js";
import { MemoryMailProvider } from "./memory-mail-provider.js";
import { SmtpMailProvider } from "./smtp-mail-provider.js";
import type { MailFactoryConfig, MemoryMailConfig, SmtpMailConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Default Constants
// ---------------------------------------------------------------------------

/** Default plugin priority — installs after most core plugins */
const DEFAULT_PLUGIN_PRIORITY = 30;

// ---------------------------------------------------------------------------
// Plugin Factory Functions
// ---------------------------------------------------------------------------

/**
 * Create a WebAFX PluginDefinition from any MailProvider instance.
 *
 * This is the core function that wires a mail provider into WebAFX:
 * 1. Registers the provider as a singleton service in the service container
 * 2. Hooks the provider's health() into the /health endpoint
 * 3. Hooks the provider's shutdown() into graceful shutdown
 *
 * The service name is read from `provider.serviceName` (defaults to "mailer").
 *
 * @param provider - Any MailProvider instance (SMTP, Memory, or custom)
 * @param options - Optional overrides for plugin priority
 * @returns A WebAFX PluginDefinition ready to pass to app.use()
 *
 * @example
 * ```typescript
 * const mailer = new SmtpMailProvider({ host: "smtp.example.com", port: 587 });
 * app.use(createMailPlugin(mailer));
 * ```
 */
export function createMailPlugin(
    provider: MailProvider,
    options?: { priority?: number }
): PluginDefinition {
    return {
        name: provider.serviceName,
        priority: options?.priority ?? DEFAULT_PLUGIN_PRIORITY,

        factory: async ({ app, logger }) => {
            // Register the mail provider as an application-wide singleton service.
            // The factory ignores container/settings since the provider is pre-created.
            app.registerService({
                name: provider.serviceName,
                type: "singleton",
                factory: () => provider,
                dispose: async () => {
                    await provider.shutdown();
                },
            });

            await logger.info(
                `Mail plugin "${provider.serviceName}" initialized ` +
                    `(${provider.constructor.name})`
            );

            // Return Plugin hooks for health monitoring and graceful shutdown
            return {
                health: () => provider.health(),
                shutdown: () => provider.shutdown(),
            };
        },
    };
}

/**
 * Create a WebAFX mail plugin with an SMTP backend. One-liner registration.
 *
 * Creates a SmtpMailProvider internally and returns a PluginDefinition.
 * The user never needs to instantiate the provider manually.
 *
 * @param config - SMTP configuration (host, port, auth, TLS options)
 * @returns A WebAFX PluginDefinition ready to pass to app.use()
 *
 * @example
 * ```typescript
 * app.use(smtpMailPlugin({
 *     host: "smtp.example.com",
 *     port: 587,
 *     secure: false,
 *     auth: { user: "user@example.com", pass: "secret" },
 * }));
 * ```
 */
export function smtpMailPlugin(config: SmtpMailConfig): PluginDefinition {
    const provider = new SmtpMailProvider(config);
    return createMailPlugin(provider);
}

/**
 * Create a WebAFX mail plugin with an In-Memory backend. One-liner registration.
 *
 * Creates a MemoryMailProvider internally and returns a PluginDefinition.
 * Ideal for development and testing — no emails are actually sent.
 *
 * @param config - Optional memory configuration (serviceName override)
 * @returns A WebAFX PluginDefinition ready to pass to app.use()
 *
 * @example
 * ```typescript
 * app.use(memoryMailPlugin());
 * ```
 */
export function memoryMailPlugin(config?: MemoryMailConfig): PluginDefinition {
    const provider = new MemoryMailProvider(config);
    return createMailPlugin(provider);
}

/**
 * Create a MailProvider based on configuration type.
 *
 * Factory function for environment-based backend switching.
 * Returns the appropriate provider based on `config.type`.
 * Use with `createMailPlugin()` to register in WebAFX.
 *
 * @param config - Mail factory configuration with type discriminator
 * @returns A MailProvider instance (SMTP or Memory)
 * @throws Error if config.type is not "smtp" or "memory"
 *
 * @example
 * ```typescript
 * const mailer = createMailProvider({
 *     type: process.env.NODE_ENV === "production" ? "smtp" : "memory",
 *     host: process.env.SMTP_HOST,
 *     port: Number(process.env.SMTP_PORT || 587),
 * });
 * app.use(createMailPlugin(mailer));
 * ```
 */
export function createMailProvider(config: MailFactoryConfig): MailProvider {
    switch (config.type) {
        case "smtp":
            return new SmtpMailProvider({
                serviceName: config.serviceName,
                host: config.host!,
                port: config.port!,
                secure: config.secure,
                auth: config.auth,
                tls: config.tls,
            });

        case "memory":
            return new MemoryMailProvider({
                serviceName: config.serviceName,
            });

        default: {
            // Exhaustive check — provides a clear runtime error if called with
            // an invalid type that TypeScript couldn't catch at compile time
            const unknownType = (config as { type: string }).type;
            throw new Error(
                `Unknown mail type: "${unknownType}". Supported types: "smtp", "memory".`
            );
        }
    }
}
