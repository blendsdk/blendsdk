import type { PluginDefinition, Plugin, Logger } from "@blendsdk/webafx";
import { Translator, mergeCatalogs } from "@blendsdk/i18n";
import type { TranslationSource, TranslationCatalog } from "@blendsdk/i18n";
import type { I18nPluginConfig } from "./types.js";
import { resolveLocale } from "./locale-resolver.js";

/** Default plugin priority */
const DEFAULT_PRIORITY = 40;

/** Default service names */
const DEFAULT_SERVICE_NAME = "i18n";
const DEFAULT_LOCALE_SERVICE_NAME = "locale";
const DEFAULT_PUBSUB_SERVICE_NAME = "pubsub";
const DEFAULT_COOKIE_NAME: string | false = "locale";

/**
 * Create a WebAFX PluginDefinition for i18n.
 *
 * This is the main entry point. It:
 * 1. Loads translations from all configured sources at startup
 * 2. Creates a Translator with the merged catalog
 * 3. Registers the Translator as a singleton service
 * 4. Registers a per-request "locale" service that resolves the request locale
 * 5. Optionally subscribes to a pub/sub reload channel
 *
 * @param config - Plugin configuration
 * @returns WebAFX PluginDefinition
 *
 * @example
 * ```typescript
 * import { createI18nPlugin, jsonFileSource } from "@blendsdk/webafx-i18n";
 *
 * app.use(createI18nPlugin({
 *     defaultLocale: "en",
 *     sources: [
 *         jsonFileSource({ paths: ["./translations/*.json"] }),
 *     ],
 * }));
 * ```
 */
export function createI18nPlugin(config: I18nPluginConfig): PluginDefinition {
    const serviceName = config.serviceName ?? DEFAULT_SERVICE_NAME;
    const localeServiceName = config.localeServiceName ?? DEFAULT_LOCALE_SERVICE_NAME;
    const defaultLocale = config.defaultLocale ?? "en";
    const cookieName = config.localeCookieName ?? DEFAULT_COOKIE_NAME;

    return {
        name: serviceName,
        priority: config.priority ?? DEFAULT_PRIORITY,

        factory: async ({ app, logger }) => {
            // --- Step 1: Load translations from all sources ---
            const catalog = await loadAllSources(config.sources, logger);

            // --- Step 2: Create Translator ---
            const translator = new Translator({
                defaultLocale,
                catalog,
                onMissingTranslation: config.onMissingTranslation,
            });

            await logger.info(
                `I18n plugin: loaded ${Object.keys(catalog).length} translation keys ` +
                    `from ${config.sources.length} source(s)`
            );

            // --- Step 3: Register Translator as singleton service ---
            app.registerService({
                name: serviceName,
                type: "singleton",
                factory: () => translator,
            });

            // --- Step 3b: Register reload function as singleton service ---
            // Allows controllers and other code to trigger a full source reload
            // (Decision per AR #1)
            app.registerService({
                name: `${serviceName}:reload`,
                type: "singleton",
                factory: () => async () => {
                    await reloadSources(config.sources, translator, logger);
                },
            });

            // --- Step 4: Register per-request locale service ---
            app.registerService({
                name: localeServiceName,
                type: "per-request",
                factory: (_container, _settings, req, res) => {
                    const locale = resolveLocale(req, defaultLocale, cookieName);

                    // Persist locale in cookie (if configured)
                    if (cookieName) {
                        res.cookie(cookieName as string, locale, {
                            httpOnly: false,
                            sameSite: "lax",
                            maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
                        });
                    }

                    return locale;
                },
            });

            // --- Step 5: Optional pub/sub reload ---
            if (config.reloadChannel) {
                const pubsubName = config.pubsubServiceName ?? DEFAULT_PUBSUB_SERVICE_NAME;
                try {
                    // Access service container via cast — services is protected on WebApplication
                    // but plugins are trusted framework code that need service resolution
                    const pubsub = await (app as any).services.get(pubsubName);
                    if (pubsub && typeof (pubsub as any).subscribe === "function") {
                        await (pubsub as any).subscribe(
                            config.reloadChannel,
                            async () => {
                                await logger.info(`I18n reload triggered via pub/sub`);
                                await reloadSources(config.sources, translator, logger);
                            }
                        );
                        await logger.info(
                            `I18n plugin: subscribed to reload channel "${config.reloadChannel}"`
                        );
                    }
                } catch {
                    await logger.info(
                        `I18n plugin: pub/sub service "${pubsubName}" not available — ` +
                            `reload channel "${config.reloadChannel}" will not be active`
                    );
                }
            }

            await logger.info(`I18n plugin "${serviceName}" initialized`);

            // --- Return Plugin hooks ---
            return {
                health: async () => true,
            } satisfies Plugin;
        },
    };
}

/**
 * Load all translation sources and merge their catalogs.
 *
 * Sources are loaded in order. Later sources override earlier ones
 * for the same key+locale pair.
 *
 * @param sources - Array of translation sources
 * @param logger - Logger for progress messages
 * @returns Merged translation catalog
 */
async function loadAllSources(
    sources: TranslationSource[],
    logger: Logger
): Promise<TranslationCatalog> {
    const catalogs: TranslationCatalog[] = [];

    for (const source of sources) {
        await logger.info(`I18n: loading from ${source.name}...`);
        const catalog = await source.load();
        await logger.info(`I18n: ${source.name} loaded ${Object.keys(catalog).length} keys`);
        catalogs.push(catalog);
    }

    return mergeCatalogs(catalogs);
}

/**
 * Reload all sources and atomically swap the translator's catalog.
 *
 * On failure, logs the error but keeps the old catalog (graceful degradation).
 *
 * @param sources - Array of translation sources
 * @param translator - The Translator instance to update
 * @param logger - Logger for progress messages
 */
async function reloadSources(
    sources: TranslationSource[],
    translator: Translator,
    logger: Logger
): Promise<void> {
    try {
        const catalog = await loadAllSources(sources, logger);
        translator.setCatalog(catalog);
        await logger.info(`I18n: reload complete — ${Object.keys(catalog).length} keys loaded`);
    } catch (error) {
        // Log the error but don't crash — keep the old catalog
        await logger.error(
            `I18n: reload failed, keeping previous catalog: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}
