/**
 * Browser-safe core entry point for @blendsdk/i18n.
 *
 * This module exports only the runtime-agnostic parts of the i18n library:
 * Translator, mergeCatalogs, types, and the TranslationSource interface.
 * It contains NO Node.js-specific imports (no `node:fs`, `node:path`),
 * making it safe for browser bundlers (Webpack, Vite, esbuild, etc.).
 *
 * **Import paths:**
 * - `@blendsdk/i18n`      — This module (browser-safe core)
 * - `@blendsdk/i18n/node`  — Full package including JsonFileSource & ContentFileSource (Node.js only)
 *
 * @module @blendsdk/i18n
 */

// Types
export type {
    TranslationValue,
    TranslationEntry,
    TranslationCatalog,
    TranslatorConfig,
    LocaleParts,
} from "./types.js";

// Core
export { Translator } from "./translator.js";

// Source abstraction
export type { TranslationSource } from "./translation-source.js";

// Catalog utilities
export { mergeCatalogs } from "./merge-catalogs.js";

// NOTE: JsonFileSource, ContentFileSource, and their factories are Node.js-only
// and are exported from "@blendsdk/i18n/node" — see ./node.ts
