import type { TranslationSource } from "@blendsdk/i18n";

/**
 * Configuration for the i18n WebAFX plugin.
 */
export interface I18nPluginConfig {
    /**
     * The default locale used as fallback when no locale can be resolved.
     * @default "en"
     */
    defaultLocale?: string;

    /**
     * Array of translation sources to load at startup.
     * Sources are loaded in order; later sources override earlier ones
     * for the same key+locale combination.
     *
     * @example
     * sources: [
     *     jsonFileSource({ paths: ["./translations/*.json"] }),
     *     postgresqlSource({ queryFn: (sql) => db.query(sql) }),
     * ]
     */
    sources: TranslationSource[];

    /**
     * Service name for registering the Translator in the service container.
     * @default "i18n"
     */
    serviceName?: string;

    /**
     * Service name for registering the resolved locale as a per-request service.
     * @default "locale"
     */
    localeServiceName?: string;

    /**
     * Optional: Pub/Sub channel name for distributed reload.
     *
     * When set, the plugin subscribes to this channel via the PubSubProvider
     * registered in the service container (from @blendsdk/webafx-cache plugin).
     * When a message is received on this channel, all sources are reloaded
     * and the translator catalog is atomically swapped.
     *
     * Requires @blendsdk/webafx-cache pub/sub plugin to be installed.
     *
     * @example
     * reloadChannel: "i18n:reload"
     */
    reloadChannel?: string;

    /**
     * Service name of the PubSubProvider in the service container.
     * Only used when `reloadChannel` is set.
     * @default "pubsub"
     */
    pubsubServiceName?: string;

    /**
     * Optional callback invoked when a translation key is not found.
     * Passed through to the Translator instance.
     */
    onMissingTranslation?: (key: string, locale: string) => void;

    /**
     * Cookie name for persisting the user's locale preference.
     * Set to `false` to disable locale persistence.
     * @default "locale"
     */
    localeCookieName?: string | false;

    /**
     * Plugin installation priority. Lower numbers install first.
     * @default 40
     */
    priority?: number;
}
