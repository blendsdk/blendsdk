import type { TranslationCatalog } from "./types.js";

/**
 * Abstract interface for translation data sources.
 *
 * A TranslationSource loads translations from an external backend
 * (JSON files, database, remote API, etc.) and returns them as a
 * TranslationCatalog. Sources are composable — multiple sources
 * can be loaded and merged into a single catalog.
 *
 * Each source implementation is responsible for:
 * 1. Connecting to its backend (file system, database, etc.)
 * 2. Reading translation data
 * 3. Normalizing data into the TranslationCatalog format
 *
 * Sources are loaded at application startup and optionally re-loaded
 * when a reload is triggered (e.g., via pub/sub).
 */
export interface TranslationSource {
    /**
     * Human-readable name for logging (e.g., "JsonFileSource", "PostgreSQLSource").
     */
    readonly name: string;

    /**
     * Load all translations from this source.
     *
     * Called at application startup and on reload events.
     * Must return a complete TranslationCatalog.
     * If the source is unavailable, should throw with a descriptive error.
     *
     * @returns The complete translation catalog from this source
     * @throws Error if the source cannot be read
     */
    load(): Promise<TranslationCatalog>;
}
