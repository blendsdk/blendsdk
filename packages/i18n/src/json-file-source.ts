import { readFile, readdir } from "node:fs/promises";
import { basename, resolve, dirname, join } from "node:path";
import type { TranslationCatalog, TranslationEntry, TranslationValue } from "./types.js";
import type { TranslationSource } from "./translation-source.js";

/**
 * Configuration for the JSON file translation source.
 */
export interface JsonFileSourceConfig {
    /**
     * Array of file paths or glob patterns to load.
     *
     * Supports two JSON file formats:
     *
     * **Format 1: Multi-locale file** — Each key maps to a locale→value object:
     * ```json
     * {
     *     "greeting": { "en": "Hello", "nl": "Hallo" },
     *     "book": { "en": ["1 book", "N books"] }
     * }
     * ```
     *
     * **Format 2: Single-locale file** — Flat key→value, locale derived from filename:
     * File: `translations/en.json`
     * ```json
     * {
     *     "greeting": "Hello",
     *     "farewell": "Goodbye"
     * }
     * ```
     * The locale is extracted from the filename: `en.json` → locale "en".
     *
     * Both formats are auto-detected per file and normalized into TranslationCatalog.
     *
     * @example
     * paths: ["./translations/*.json"]
     * paths: ["./translations/en.json", "./translations/nl.json"]
     */
    paths: string[];
}


/**
 * Translation source that loads from JSON files.
 *
 * Supports two file formats:
 * 1. Multi-locale: `{ key: { locale: value } }` — all locales in one file
 * 2. Single-locale: `{ key: value }` — one file per locale, locale from filename
 *
 * Format is auto-detected per file based on the structure of the first value.
 *
 * @example
 * ```typescript
 * const source = new JsonFileSource({
 *     paths: ["./translations/*.json"],
 * });
 * const catalog = await source.load();
 * ```
 */
export class JsonFileSource implements TranslationSource {
    /** @inheritdoc */
    readonly name = "JsonFileSource";

    /** Source configuration */
    protected config: JsonFileSourceConfig;

    /**
     * Create a new JsonFileSource.
     *
     * @param config - File paths or glob patterns configuration
     */
    constructor(config: JsonFileSourceConfig) {
        this.config = config;
    }

    /**
     * Load all translations from configured JSON file paths.
     *
     * 1. Resolves all glob patterns to file paths
     * 2. Reads and parses each JSON file
     * 3. Auto-detects format (multi-locale vs single-locale)
     * 4. Normalizes into TranslationCatalog entries
     * 5. Merges all entries (later files override earlier for same key+locale)
     *
     * @returns The complete translation catalog from all matched files
     * @throws Error if a file cannot be read or parsed
     */
    async load(): Promise<TranslationCatalog> {
        const catalog: TranslationCatalog = {};

        // Resolve all glob patterns to file paths
        const filePaths = await resolveGlobs(this.config.paths);

        for (const filePath of filePaths) {
            const content = await readFile(filePath, "utf-8");
            let data: Record<string, unknown>;

            try {
                data = JSON.parse(content) as Record<string, unknown>;
            } catch (error) {
                throw new Error(
                    `Failed to parse JSON file "${filePath}": ${error instanceof Error ? error.message : String(error)}`
                );
            }

            // Auto-detect format and normalize into catalog
            const format = detectFormat(data);
            if (format === "multi-locale") {
                // Multi-locale: { key: { locale: value } }
                mergeMultiLocale(catalog, data as Record<string, Record<string, unknown>>);
            } else {
                // Single-locale: { key: value }, locale from filename
                const locale = extractLocaleFromFilename(basename(filePath));
                mergeSingleLocale(catalog, data as Record<string, unknown>, locale);
            }
        }

        return catalog;
    }
}

/**
 * Create a JsonFileSource instance. Convenience factory for plugin configuration.
 *
 * @param config - JSON file source configuration
 * @returns A new JsonFileSource instance
 *
 * @example
 * ```typescript
 * app.use(createI18nPlugin({
 *     sources: [
 *         jsonFileSource({ paths: ["./translations/*.json"] }),
 *     ],
 * }));
 * ```
 */
export function jsonFileSource(config: JsonFileSourceConfig): JsonFileSource {
    return new JsonFileSource(config);
}

/**
 * Detect if a JSON file is multi-locale or single-locale format.
 *
 * Heuristic: Look at the first value in the object.
 * - If it's a string or array → single-locale (flat key→value)
 * - If it's a plain object → multi-locale (key→{locale: value})
 * - Empty object → defaults to multi-locale (no keys to process anyway)
 *
 * @param data - Parsed JSON object
 * @returns "multi-locale" or "single-locale"
 */
function detectFormat(data: Record<string, unknown>): "multi-locale" | "single-locale" {
    const firstValue = Object.values(data)[0];

    // Empty file — treat as multi-locale (no entries either way)
    if (firstValue === undefined) {
        return "multi-locale";
    }

    // String or array → single-locale format
    if (typeof firstValue === "string" || Array.isArray(firstValue)) {
        return "single-locale";
    }

    // Object → multi-locale format
    if (typeof firstValue === "object" && firstValue !== null) {
        return "multi-locale";
    }

    // Fallback: treat as single-locale
    return "single-locale";
}

/**
 * Extract locale from a filename.
 *
 * Supports patterns:
 * - "en.json" → "en"
 * - "nl_NL.json" → "nl_NL"
 * - "translations.en.json" → "en"
 * - "strings.nl.json" → "nl"
 *
 * Uses the last segment before the final .json extension.
 *
 * @param filename - The file name (without directory path)
 * @returns The extracted locale string
 * @throws Error if no locale can be determined from the filename
 */
function extractLocaleFromFilename(filename: string): string {
    // Remove the .json extension
    const withoutExt = filename.replace(/\.json$/i, "");

    // Split by dots and take the last segment
    const segments = withoutExt.split(".");
    const locale = segments[segments.length - 1];

    if (!locale) {
        throw new Error(`Cannot determine locale from filename "${filename}"`);
    }

    return locale;
}

/**
 * Merge a multi-locale file's data into an existing catalog.
 *
 * Multi-locale format: { key: { locale: value } }
 *
 * @param catalog - The target catalog to merge into (mutated)
 * @param data - The multi-locale file data
 */
function mergeMultiLocale(
    catalog: TranslationCatalog,
    data: Record<string, Record<string, unknown>>
): void {
    for (const [key, localeMap] of Object.entries(data)) {
        if (!catalog[key]) {
            catalog[key] = {};
        }
        for (const [locale, value] of Object.entries(localeMap)) {
            // Normalize the value to TranslationValue
            catalog[key][locale] = normalizeValue(value);
        }
    }
}

/**
 * Merge a single-locale file's data into an existing catalog.
 *
 * Single-locale format: { key: value } with locale from filename.
 *
 * @param catalog - The target catalog to merge into (mutated)
 * @param data - The single-locale file data
 * @param locale - The locale extracted from the filename
 */
function mergeSingleLocale(
    catalog: TranslationCatalog,
    data: Record<string, unknown>,
    locale: string
): void {
    for (const [key, value] of Object.entries(data)) {
        if (!catalog[key]) {
            catalog[key] = {};
        }
        catalog[key][locale] = normalizeValue(value);
    }
}

/**
 * Normalize a raw JSON value to a TranslationValue.
 *
 * - Strings pass through as-is
 * - Arrays of exactly 2 strings become [singular, plural] tuples
 * - Other values are converted to string via String()
 *
 * @param value - The raw value from JSON
 * @returns Normalized TranslationValue
 */
function normalizeValue(value: unknown): TranslationValue {
    if (typeof value === "string") {
        return value;
    }

    // Check for plural array [singular, plural]
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string") {
        return value as [string, string];
    }

    // Fallback: convert to string
    return String(value);
}

/**
 * Resolve glob patterns to file paths.
 *
 * Supports simple glob patterns like "dir/*.json" by listing the
 * directory and filtering by extension. Non-glob paths are returned
 * as-is (resolved to absolute).
 *
 * @param patterns - Array of file paths or glob patterns
 * @returns Array of resolved file paths, sorted for deterministic ordering
 */
async function resolveGlobs(patterns: string[]): Promise<string[]> {
    const allPaths: string[] = [];

    for (const pattern of patterns) {
        // Check if it's a glob pattern (contains * or ?)
        if (pattern.includes("*") || pattern.includes("?")) {
            const matches = await expandSimpleGlob(pattern);
            allPaths.push(...matches);
        } else {
            // Plain file path — resolve to absolute
            allPaths.push(resolve(pattern));
        }
    }

    // Sort for deterministic file ordering
    return allPaths.sort();
}

/**
 * Expand a simple glob pattern like "dir/*.json" into matching file paths.
 *
 * Supports only `*` wildcards in the filename part (not recursive `**`).
 * This covers the primary use case for translation files without needing
 * an external glob library.
 *
 * @param pattern - A glob pattern (e.g., "./translations/*.json")
 * @returns Array of matching absolute file paths
 */
async function expandSimpleGlob(pattern: string): Promise<string[]> {
    const dir = dirname(pattern);
    const filePattern = basename(pattern);

    // Convert glob pattern to regex: * → [^/]*, ? → [^/]
    const regexStr = filePattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape regex special chars (except * and ?)
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]");
    const regex = new RegExp(`^${regexStr}$`);

    try {
        const entries = await readdir(resolve(dir));
        return entries
            .filter((entry) => regex.test(entry))
            .map((entry) => resolve(dir, entry));
    } catch {
        // Directory doesn't exist — return empty (no matches)
        return [];
    }
}
