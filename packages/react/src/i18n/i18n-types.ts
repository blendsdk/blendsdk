/**
 * Types and interfaces for the I18n feature.
 *
 * @packageDocumentation
 */

import type { TranslationValue } from "@blendsdk/i18n";
import type { ReactNode } from "react";

/**
 * Function that loads translations for a specific locale.
 * Returns a flat map of translation keys to values.
 * The provider wraps this into a TranslationCatalog internally.
 *
 * @example
 * ```typescript
 * const loader: TranslationLoader = async (locale) => {
 *     const res = await fetch(`/api/translations/${locale}`);
 *     return res.json();
 * };
 * ```
 */
export type TranslationLoader = (locale: string) => Promise<Record<string, TranslationValue>>;

/**
 * Props for the I18nProvider component.
 */
export interface I18nProviderProps {
    /** Async function that loads translations for a given locale. (Decision per AR #1) */
    loader: TranslationLoader;
    /** Default locale to load on mount. Default: 'en' */
    defaultLocale?: string;
    /** Optional callback when a translation key is not found. */
    onMissingTranslation?: (key: string, locale: string) => void;
    /** Application subtree. */
    children: ReactNode;
}

/**
 * Translation function signature.
 * Translates a key with optional interpolation parameters.
 * Supports plurals via the `count` parameter.
 */
export type TranslateFunction = (key: string, params?: Record<string, unknown>) => string;

/**
 * Context value provided by I18nProvider.
 * Consumed via the useTranslations() hook.
 */
export interface I18nContextValue {
    /** Translation function — t('key', params?) → string */
    t: TranslateFunction;
    /** Current active locale */
    locale: string;
    /** Switch to a different locale (triggers re-fetch via loader, shows GlobalLoader). (Decision per AR #4) */
    setLocale: (locale: string) => void;
    /** Force re-fetch translations for the current locale (e.g., after server-side reload). */
    reloadTranslations: () => void;
    /** True when translations have been loaded successfully */
    ready: boolean;
}
