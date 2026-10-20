import { formatString } from "@blendsdk/stdlib";
import type {
    TranslationCatalog,
    TranslationEntry,
    TranslationValue,
    TranslatorConfig,
    LocaleParts,
} from "./types.js";

/**
 * Core translation engine.
 *
 * Provides translation lookup with locale fallback, plural support,
 * and string interpolation via `formatString`. The catalog is treated
 * as immutable after construction — use `setCatalog()` for atomic
 * replacement (e.g., on reload).
 *
 * Runtime-agnostic: no Node.js or browser-specific APIs.
 *
 * @example
 * ```typescript
 * const translator = new Translator({
 *     defaultLocale: "en",
 *     catalog: {
 *         greeting: { en: "Hello ${name}", nl: "Hallo ${name}" },
 *         book: { en: ["${count} book", "${count} books"] },
 *     },
 * });
 *
 * translator.translate("greeting", "en", { name: "Alice" });
 * // → "Hello Alice"
 *
 * translator.translate("book", "en", { count: 5 });
 * // → "5 books"
 * ```
 */
export class Translator {
    /** The default locale used when none is specified */
    protected defaultLocale: string;

    /** The translation catalog (atomic reference for reload safety) */
    protected catalog: TranslationCatalog;

    /** Cache for parsed locale parts to avoid repeated parsing */
    protected localeCache: Map<string, LocaleParts>;

    /** Optional callback for missing translations */
    protected onMissingTranslation?: (key: string, locale: string) => void;

    /**
     * Create a new Translator instance.
     *
     * @param config - Optional configuration (defaults to "en" locale, empty catalog)
     */
    constructor(config?: TranslatorConfig) {
        this.defaultLocale = config?.defaultLocale ?? "en";
        this.catalog = config?.catalog ?? {};
        this.localeCache = new Map();
        this.onMissingTranslation = config?.onMissingTranslation;
    }

    /**
     * Translate a key for a given locale with optional parameter interpolation.
     *
     * Locale fallback chain: exact locale → language only → key as-is.
     * Plural selection: if the translation value is a [singular, plural] tuple
     * and params contains a `count` property, the appropriate form is selected.
     *
     * @param key - Translation key (e.g., "greeting", "auth.login")
     * @param locale - Target locale (e.g., "en_GB", "nl"). Uses defaultLocale if omitted.
     * @param params - Optional interpolation parameters
     * @returns The translated, interpolated string
     *
     * @example
     * translator.translate("greeting", "en", { name: "Alice" })
     * // → "Hello Alice"
     *
     * translator.translate("book", "en", { count: 1 })
     * // → "1 book"
     *
     * translator.translate("book", "en", { count: 5 })
     * // → "5 books"
     *
     * translator.translate("unknown.key", "en")
     * // → "unknown.key" (key returned as-is)
     */
    translate(key: string, locale?: string, params?: Record<string, unknown>): string {
        const resolvedLocale = locale ?? this.defaultLocale;
        const localeParts = this.parseLocale(resolvedLocale);

        // Look up the entry for this key
        const entry = this.catalog[key];
        if (!entry) {
            // Key not found — invoke callback and return key as-is
            this.onMissingTranslation?.(key, resolvedLocale);
            return key;
        }

        // Resolve the best value using the locale fallback chain
        const value = this.resolveValue(entry, localeParts);
        if (value === undefined) {
            // No value for this locale — invoke callback and return key
            this.onMissingTranslation?.(key, resolvedLocale);
            return key;
        }

        // Select singular/plural form if applicable
        const selectedString = this.selectPlural(value, params);

        // Interpolate parameters using formatString from stdlib
        return formatString(selectedString, params);
    }

    /**
     * Get all translations for a specific locale as a flat key-value map.
     *
     * Resolves each key using the locale fallback chain (exact → language).
     * Plural values are returned as-is (the array form) since the client
     * needs both forms for dynamic count-based selection.
     *
     * Primarily used to serve translations to frontend clients.
     *
     * @param locale - Target locale (e.g., "en", "nl_NL")
     * @returns Flat map of { key: resolvedValue } for the locale
     *
     * @example
     * translator.getTranslationsForLocale("nl")
     * // → { greeting: "Hallo ${name}", book: ["${count} boek", "${count} boeken"] }
     */
    getTranslationsForLocale(locale: string): Record<string, TranslationValue> {
        const localeParts = this.parseLocale(locale);
        const result: Record<string, TranslationValue> = {};

        for (const [key, entry] of Object.entries(this.catalog)) {
            const value = this.resolveValue(entry, localeParts);
            if (value !== undefined) {
                result[key] = value;
            }
        }

        return result;
    }

    /**
     * Check if a translation key exists, optionally for a specific locale.
     *
     * @param key - Translation key
     * @param locale - Optional: check for this specific locale (with fallback)
     * @returns true if the key exists (and has a value for the locale if specified)
     */
    hasKey(key: string, locale?: string): boolean {
        const entry = this.catalog[key];
        if (!entry) return false;
        if (!locale) return true;

        // Check if the key has a value for the requested locale (with fallback)
        const localeParts = this.parseLocale(locale);
        return this.resolveValue(entry, localeParts) !== undefined;
    }

    /**
     * Atomically replace the translation catalog.
     *
     * Used by the reload mechanism to swap in a new catalog without
     * affecting ongoing translations. The old catalog serves current
     * requests; the new catalog serves subsequent ones.
     *
     * @param catalog - The new translation catalog
     */
    setCatalog(catalog: TranslationCatalog): void {
        this.catalog = catalog;
        // Clear locale cache since new catalog may have different locale coverage
        this.localeCache.clear();
    }

    /**
     * Get the current translation catalog.
     * Primarily useful for testing and debugging.
     *
     * @returns The current TranslationCatalog
     */
    getCatalog(): TranslationCatalog {
        return this.catalog;
    }

    /**
     * Get the configured default locale.
     * @returns The default locale string
     */
    getDefaultLocale(): string {
        return this.defaultLocale;
    }

    /**
     * Parse and cache a locale string into its component parts.
     *
     * Handles formats like:
     * - "en" → { full: "en", language: "en" }
     * - "en_GB" → { full: "en_GB", language: "en", region: "GB" }
     * - "en-GB" → { full: "en_GB", language: "en", region: "GB" } (normalizes dash to underscore)
     * - "en_GB.UTF-8" → { full: "en_GB", language: "en", region: "GB" } (strips encoding)
     *
     * Results are cached in a Map for O(1) subsequent lookups.
     *
     * @param locale - The locale string to parse
     * @returns Parsed LocaleParts
     */
    protected parseLocale(locale: string): LocaleParts {
        // Check cache first
        const cached = this.localeCache.get(locale);
        if (cached) return cached;

        // Strip encoding (e.g., ".UTF-8")
        const withoutEncoding = locale.split(".")[0];

        // Normalize dash to underscore (e.g., "en-GB" → "en_GB")
        const normalized = withoutEncoding.replace("-", "_");

        // Split on underscore to get language and optional region
        const parts = normalized.split("_");
        const language = parts[0];
        const region = parts.length > 1 ? parts[1] : undefined;

        const result: LocaleParts = {
            full: normalized,
            language,
            region,
        };

        // Cache for future lookups
        this.localeCache.set(locale, result);

        return result;
    }

    /**
     * Resolve the best translation value from an entry for a given locale.
     *
     * Fallback chain:
     * 1. Exact match: entry[locale_full] (e.g., entry["en_GB"])
     * 2. Language match: entry[language] (e.g., entry["en"])
     * 3. undefined (not found)
     *
     * @param entry - The translation entry for a key
     * @param localeParts - Parsed locale parts
     * @returns The resolved value, or undefined if no match
     */
    protected resolveValue(
        entry: TranslationEntry,
        localeParts: LocaleParts
    ): TranslationValue | undefined {
        // Try exact locale match first (e.g., "en_GB")
        if (entry[localeParts.full] !== undefined) {
            return entry[localeParts.full];
        }

        // Fall back to language-only match (e.g., "en")
        // Only try if full locale differs from language (has a region)
        if (localeParts.region && entry[localeParts.language] !== undefined) {
            return entry[localeParts.language];
        }

        return undefined;
    }

    /**
     * Select singular or plural form based on the `count` parameter.
     *
     * If the value is a [singular, plural] tuple and params.count exists
     * and is a number:
     * - count === 1 → singular (index 0)
     * - count !== 1 → plural (index 1)
     *
     * If the value is a simple string, returns it unchanged.
     * If count is not a valid number, defaults to singular.
     *
     * @param value - The translation value (string or [singular, plural])
     * @param params - Parameters that may contain a `count` property
     * @returns The selected string form
     */
    protected selectPlural(value: TranslationValue, params?: Record<string, unknown>): string {
        // Simple string — return as-is
        if (typeof value === "string") {
            return value;
        }

        // Plural tuple — select based on count
        const count = params?.count;
        if (typeof count === "number" && !Number.isNaN(count)) {
            return count === 1 ? value[0] : value[1];
        }

        // No valid count — default to singular form
        return value[0];
    }
}
