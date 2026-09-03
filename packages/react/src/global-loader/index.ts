/**
 * GlobalLoader — Full-screen overlay with CSS spinner and optional text.
 *
 * @example
 * ```tsx
 * import { GlobalLoaderProvider, useGlobalLoader } from "@blendsdk/react";
 *
 * // Wrap your app
 * <GlobalLoaderProvider config={{ spinnerColor: '#25b09b' }}>
 *   <App />
 * </GlobalLoaderProvider>
 *
 * // Use anywhere inside the provider
 * const { showLoader, setText, visible } = useGlobalLoader();
 * ```
 *
 * @packageDocumentation
 */

export { GlobalLoaderProvider } from "./global-loader-context.js";
export { useGlobalLoader } from "./use-global-loader.js";
export type {
    GlobalLoaderConfig,
    GlobalLoaderContextValue,
    GlobalLoaderProviderProps,
} from "./global-loader-types.js";
