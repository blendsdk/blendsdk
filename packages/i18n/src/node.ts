/**
 * Node.js entry point for @blendsdk/i18n.
 *
 * This module re-exports the entire browser-safe core (Translator, mergeCatalogs,
 * types, TranslationSource) plus the Node.js-only file-based translation sources
 * (JsonFileSource, ContentFileSource) that depend on `node:fs` and `node:path`.
 *
 * **Import paths:**
 * - `@blendsdk/i18n`      — Browser-safe core (works everywhere)
 * - `@blendsdk/i18n/node`  — Full package including file-based sources (Node.js only)
 *
 * @module @blendsdk/i18n/node
 */

// Re-export everything from the browser-safe core
export {
    Translator,
    mergeCatalogs,
} from "./index.js";

export type {
    TranslationValue,
    TranslationEntry,
    TranslationCatalog,
    TranslatorConfig,
    LocaleParts,
    TranslationSource,
} from "./index.js";

// Node.js-only sources
export { JsonFileSource, jsonFileSource } from "./json-file-source.js";
export type { JsonFileSourceConfig } from "./json-file-source.js";
export { ContentFileSource, contentFileSource } from "./content-file-source.js";
export type { ContentFileSourceConfig } from "./content-file-source.js";
