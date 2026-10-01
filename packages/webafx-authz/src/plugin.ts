/**
 * WebAFX plugin that exposes a claims translator to controllers.
 *
 * An application installs one plugin per translator and resolves it per
 * request, which keeps the translator's configuration in the application and
 * out of the controllers that use it.
 *
 * @packageDocumentation
 */

import type { ClaimsTranslator } from "@blendsdk/authz";
import type { PluginDefinition } from "@blendsdk/webafx";

/**
 * The default service name a translator is registered under.
 *
 * Use it when only one translator is installed. Applications that install more
 * than one translator pass a distinct `serviceName` per plugin.
 */
export const CLAIMS_TRANSLATOR_SERVICE = "claims-translator";

/**
 * Options for {@link createClaimsTranslatorPlugin}.
 */
export interface ClaimsTranslatorPluginOptions {
    /**
     * The service name to register the translator under.
     *
     * Defaults to {@link CLAIMS_TRANSLATOR_SERVICE}. Two translators in one
     * application must use distinct names.
     */
    serviceName?: string;
}

/**
 * Creates a plugin that registers a claims translator as a singleton service.
 *
 * Install it with `app.use(...)`, then resolve it inside a request with
 * `await req.services.get<ClaimsTranslator>(CLAIMS_TRANSLATOR_SERVICE)`.
 *
 * @param translator - The translator to register
 * @param options - Optional service name
 * @returns A `PluginDefinition` to pass to `app.use()`
 *
 * @example
 * ```typescript
 * app.use(createClaimsTranslatorPlugin(translator));
 * ```
 */
export function createClaimsTranslatorPlugin(
    translator: ClaimsTranslator,
    options?: ClaimsTranslatorPluginOptions
): PluginDefinition {
    const serviceName = options?.serviceName ?? CLAIMS_TRANSLATOR_SERVICE;

    return {
        name: `claims-translator:${serviceName}`,
        factory: async ({ app }) => {
            app.registerService({
                name: serviceName,
                type: "singleton",
                factory: () => translator,
            });
        },
    };
}
