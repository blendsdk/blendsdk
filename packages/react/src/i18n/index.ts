/**
 * I18n — Internationalization provider and hook for React applications.
 *
 * @example
 * ```tsx
 * import { I18nProvider, useTranslations } from "@blendsdk/react";
 *
 * // Wrap your app (inside GlobalLoaderProvider)
 * <GlobalLoaderProvider>
 *   <I18nProvider loader={fetchTranslations} defaultLocale="en">
 *     <App />
 *   </I18nProvider>
 * </GlobalLoaderProvider>
 *
 * // Use anywhere inside the provider
 * const { t, locale, setLocale, ready } = useTranslations();
 * ```
 *
 * @packageDocumentation
 */

export { I18nProvider } from "./i18n-context.js";
export { useTranslations } from "./use-translations.js";
export type {
    I18nProviderProps,
    I18nContextValue,
    TranslateFunction,
    TranslationLoader,
} from "./i18n-types.js";
