/**
 * @blendsdk/react — React component and hook library for BlendSDK applications
 *
 * @packageDocumentation
 */

// -- GlobalLoader -----------------------------------------------------------
export {
    GlobalLoaderProvider,
    useGlobalLoader,
    type GlobalLoaderConfig,
    type GlobalLoaderContextValue,
    type GlobalLoaderProviderProps,
} from "./global-loader/index.js";

// -- I18n -------------------------------------------------------------------
export {
    I18nProvider,
    useTranslations,
    type I18nProviderProps,
    type I18nContextValue,
    type TranslateFunction,
    type TranslationLoader,
} from "./i18n/index.js";

// -- Auth — BFF authentication for OIDC ------------------------------------
export {
    AuthProvider,
    AuthGuard,
    useAuth,
    AUTH_DEFAULTS,
    type AuthConfig,
    type AuthUser,
    type AuthContextValue,
    type AuthProviderProps,
    type ResolvedAuthConfig,
} from "./auth/index.js";
