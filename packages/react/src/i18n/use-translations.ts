/**
 * Consumer hook for the I18n feature.
 *
 * @packageDocumentation
 */

import { useContext } from "react";

import { I18nContext } from "./i18n-context.js";
import type { I18nContextValue } from "./i18n-types.js";

/**
 * Hook to access translations from the nearest I18nProvider.
 *
 * Returns the translation function `t()`, current `locale`,
 * a `setLocale()` function for switching locales, and a
 * `ready` boolean indicating if translations are loaded.
 *
 * @throws Error if called outside an `<I18nProvider>`
 *
 * @example
 * ```tsx
 * const { t, locale, setLocale } = useTranslations();
 * return <Button>{t('auth.login.button')}</Button>;
 * ```
 */
export function useTranslations(): I18nContextValue {
    const context = useContext(I18nContext);
    if (context === null) {
        throw new Error(
            "useTranslations() must be used within an <I18nProvider>. " +
                "Wrap your component tree with <I18nProvider> to use this hook.",
        );
    }
    return context;
}
