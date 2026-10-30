/**
 * A single translation value.
 *
 * Can be either:
 * - A simple string: "Hello ${name}"
 * - A plural pair: ["${count} book", "${count} books"]
 *   where index 0 = singular, index 1 = plural
 */
export type TranslationValue = string | [singular: string, plural: string];

/**
 * A translation entry: one key mapped to all its locale translations.
 *
 * Keys are locale identifiers (e.g., "en", "en_GB", "nl", "nl_NL").
 * Values are either simple strings or [singular, plural] tuples.
 *
 * @example
 * {
 *     en: "Hello ${name}",
 *     nl: "Hallo ${name}",
 *     de: "Hallo ${name}",
 * }
 *
 * @example Plural
 * {
 *     en: ["${count} book", "${count} books"],
 *     nl: ["${count} boek", "${count} boeken"],
 * }
 */
export type TranslationEntry = Record<string, TranslationValue>;

/**
 * The complete translation catalog.
 *
 * A flat map of translation keys to their locale entries.
 * Keys use dot-notation by convention for namespacing (e.g., "auth.login_button").
 *
 * @example
 * {
 *     "greeting": { en: "Hello", nl: "Hallo" },
 *     "auth.login": { en: "Log in", nl: "Inloggen" },
 *     "item_count": { en: ["${count} item", "${count} items"] },
 * }
 */
export type TranslationCatalog = Record<string, TranslationEntry>;

/**
 * Configuration for creating a Translator instance.
 */
export interface TranslatorConfig {
    /**
     * The default locale to use when no locale is specified.
     * @default "en"
     */
    defaultLocale?: string;

    /**
     * Initial translation catalog. Can be empty if translations
     * will be loaded later via sources.
     */
    catalog?: TranslationCatalog;

    /**
     * Optional callback invoked when a translation key is not found.
     * Useful for logging missing translations during development.
     */
    onMissingTranslation?: (key: string, locale: string) => void;
}

/**
 * Parsed locale parts.
 * Splits a locale identifier into its component parts.
 *
 * @example
 * "en_GB.UTF-8" → { full: "en_GB", language: "en", region: "GB" }
 * "nl" → { full: "nl", language: "nl", region: undefined }
 */
export interface LocaleParts {
    /** The cleaned locale (encoding stripped): "en_GB" */
    full: string;
    /** The language part: "en" */
    language: string;
    /** The region part (if present): "GB" */
    region?: string;
}
