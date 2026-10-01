/**
 * I18n React context and provider component.
 *
 * The provider loads translations via a user-supplied async loader,
 * wraps them in a Translator from @blendsdk/i18n, and exposes a
 * t() translation function to the component tree via React Context.
 * Integrates with GlobalLoaderProvider for loading state overlay.
 *
 * @packageDocumentation
 */

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactElement,
} from "react";

import { Translator } from "@blendsdk/i18n";
import type { TranslationCatalog, TranslationValue } from "@blendsdk/i18n";

import { useGlobalLoader } from "../global-loader/index.js";
import type { I18nContextValue, I18nProviderProps } from "./i18n-types.js";

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

/**
 * Nesting detection context.
 * When a provider is mounted it sets this to `true`.
 * A nested provider reads this and throws. (Decision per AR #6)
 * @internal
 */
const I18nNestingContext = createContext<boolean>(false);

/**
 * Main context providing i18n values to consumers.
 * Null when no provider is present — the hook checks for this.
 */
export const I18nContext = createContext<I18nContextValue | null>(null);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Transform a flat loader response into a TranslationCatalog.
 * Wraps each value: { key: value } → { key: { locale: value } }
 *
 * @param locale - The locale these translations belong to
 * @param translations - Flat map of translation keys to values
 * @returns A TranslationCatalog suitable for the Translator
 */
function buildCatalog(
    locale: string,
    translations: Record<string, TranslationValue>,
): TranslationCatalog {
    const catalog: TranslationCatalog = {};
    for (const [key, value] of Object.entries(translations)) {
        catalog[key] = { [locale]: value };
    }
    return catalog;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Provides internationalization to the component tree.
 *
 * Loads translations on mount via the `loader` prop, wraps them in a
 * `Translator` from `@blendsdk/i18n`, and shows the GlobalLoader
 * overlay during fetches.
 *
 * @example
 * ```tsx
 * <GlobalLoaderProvider>
 *   <I18nProvider loader={fetchTranslations} defaultLocale="en">
 *     <App />
 *   </I18nProvider>
 * </GlobalLoaderProvider>
 * ```
 *
 * @throws Error if nested inside another `I18nProvider`.
 * @throws Error if no `GlobalLoaderProvider` wraps this provider.
 */
export function I18nProvider({
    loader,
    defaultLocale = "en",
    onMissingTranslation,
    children,
}: I18nProviderProps): ReactElement {
    // -- Nesting detection (AR #6) ------------------------------------------
    const isNested = useContext(I18nNestingContext);
    if (isNested) {
        throw new Error(
            "<I18nProvider> cannot be nested inside another <I18nProvider>. " +
                "Only one provider is allowed in the component tree.",
        );
    }

    // -- GlobalLoader integration (AR #3) -----------------------------------
    const { showLoader } = useGlobalLoader();

    // -- State & refs -------------------------------------------------------
    const [locale, setLocaleState] = useState(defaultLocale);
    const [ready, setReady] = useState(false);

    // Translator held in a ref — avoids re-creating on every render (AR #2)
    const translatorRef = useRef<Translator>(
        new Translator({
            defaultLocale,
            onMissingTranslation,
        }),
    );

    // Track the latest requested locale to protect against race conditions
    const latestLocaleRef = useRef(defaultLocale);

    // -- Translation loading ------------------------------------------------

    /**
     * Loads translations for a locale and updates the Translator catalog.
     * Shows/hides the GlobalLoader during the fetch. Protects against
     * race conditions by checking if the locale is still current after
     * the async fetch completes.
     */
    const loadTranslations = useCallback(
        async (targetLocale: string) => {
            latestLocaleRef.current = targetLocale;
            showLoader(true);

            try {
                const translations = await loader(targetLocale);

                // Race condition guard: only apply if this is still the latest request
                if (latestLocaleRef.current !== targetLocale) {
                    return;
                }

                const catalog = buildCatalog(targetLocale, translations);
                translatorRef.current.setCatalog(catalog);
                setLocaleState(targetLocale);
                setReady(true);
            } catch (error) {
                // Race condition guard for error path too
                if (latestLocaleRef.current !== targetLocale) {
                    return;
                }

                console.error(
                    `[I18nProvider] Failed to load translations for locale "${targetLocale}":`,
                    error,
                );
            } finally {
                // Always hide the loader, even on error
                if (latestLocaleRef.current === targetLocale) {
                    showLoader(false);
                }
            }
        },
        [loader, showLoader],
    );

    // -- Initial load on mount ----------------------------------------------
    useEffect(() => {
        void loadTranslations(defaultLocale);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps -- intentional mount-only

    // -- setLocale (exposed to consumers) -----------------------------------

    /**
     * Switch to a different locale. Triggers a re-fetch via the loader
     * and shows the GlobalLoader during the fetch. No-ops if the
     * requested locale matches the current one. (Decision per AR #4)
     */
    const setLocale = useCallback(
        (newLocale: string) => {
            // No-op if already on this locale
            if (newLocale === latestLocaleRef.current) {
                return;
            }
            void loadTranslations(newLocale);
        },
        [loadTranslations],
    );

    // -- reloadTranslations (exposed to consumers) --------------------------

    /**
     * Force re-fetch translations for the current locale.
     * Unlike setLocale(), this does NOT skip same-locale requests.
     * Use after server-side translation reload to refresh the UI.
     */
    const reloadTranslations = useCallback(() => {
        void loadTranslations(latestLocaleRef.current);
    }, [loadTranslations]);

    // -- t() translation function -------------------------------------------

    /**
     * Translation function. Delegates to the Translator instance.
     * Returns the key as-is if translations haven't loaded yet.
     */
    const t = useCallback(
        (key: string, params?: Record<string, unknown>): string => {
            if (!ready) {
                // Gracefully return key before translations are loaded
                return key;
            }
            return translatorRef.current.translate(key, locale, params);
        },
        [ready, locale],
    );

    // -- Context value (memoized to prevent unnecessary re-renders) ----------
    const contextValue = useMemo<I18nContextValue>(
        () => ({ t, locale, setLocale, reloadTranslations, ready }),
        [t, locale, setLocale, reloadTranslations, ready],
    );

    return (
        <I18nNestingContext.Provider value={true}>
            <I18nContext.Provider value={contextValue}>
                {children}
            </I18nContext.Provider>
        </I18nNestingContext.Provider>
    );
}
