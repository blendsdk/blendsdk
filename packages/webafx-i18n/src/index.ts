// Plugin
export { createI18nPlugin } from "./i18n-plugin.js";

// Types
export type { I18nPluginConfig } from "./types.js";

// Sources
export { PostgreSQLSource, postgresqlSource } from "./postgresql-source.js";
export type { PostgreSQLSourceConfig } from "./postgresql-source.js";

// Locale resolver (exported for testing and custom use)
export { resolveLocale, parseAcceptLanguage } from "./locale-resolver.js";

// Re-export browser-safe i18n core for convenience
export { Translator, mergeCatalogs } from "@blendsdk/i18n";
export type {
    TranslationCatalog,
    TranslationEntry,
    TranslationValue,
    TranslationSource,
    TranslatorConfig,
} from "@blendsdk/i18n";

// Re-export Node.js-only file sources from the /node subpath
export { JsonFileSource, jsonFileSource } from "@blendsdk/i18n/node";
export type { JsonFileSourceConfig } from "@blendsdk/i18n/node";
export { ContentFileSource, contentFileSource } from "@blendsdk/i18n/node";
export type { ContentFileSourceConfig } from "@blendsdk/i18n/node";
