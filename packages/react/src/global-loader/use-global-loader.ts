/**
 * Consumer hook for the GlobalLoader feature.
 *
 * @packageDocumentation
 */

import { useContext } from "react";

import { GlobalLoaderContext } from "./global-loader-context.js";
import type { GlobalLoaderContextValue } from "./global-loader-types.js";

/**
 * Hook to control the global loader overlay.
 *
 * Must be called within a `<GlobalLoaderProvider>`.
 *
 * @returns Object with `showLoader`, `setText`, and `visible` properties.
 *
 * @example
 * ```tsx
 * const { showLoader, setText, visible } = useGlobalLoader();
 *
 * setText("Loading data…");
 * showLoader(true);
 * // ... later
 * showLoader(false); // hides overlay and clears text
 * ```
 *
 * @throws Error if called outside a `<GlobalLoaderProvider>`.
 */
export function useGlobalLoader(): GlobalLoaderContextValue {
    const context = useContext(GlobalLoaderContext);
    if (context === null) {
        throw new Error(
            "useGlobalLoader() must be used within a <GlobalLoaderProvider>. " +
                "Wrap your component tree with <GlobalLoaderProvider> to use this hook.",
        );
    }
    return context;
}
