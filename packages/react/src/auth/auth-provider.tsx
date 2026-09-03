/**
 * AuthProvider — React context provider for BFF OIDC authentication.
 *
 * Manages the full authentication lifecycle:
 * - Session check on mount via GET /me
 * - Auto-refresh scheduling based on expiresAt
 * - Tab visibility re-check on focus
 * - Login redirect, logout, manual refresh
 * - GlobalLoader integration for loading states
 * - Nesting detection to prevent multiple providers
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

import { useGlobalLoader } from "../global-loader/use-global-loader.js";
import { AUTH_DEFAULTS } from "./auth-defaults.js";
import type {
    AuthContextValue,
    AuthProviderProps,
    AuthUser,
    ResolvedAuthConfig,
} from "./auth-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Retry delay (ms) for refresh network errors before giving up */
const REFRESH_RETRY_DELAY_MS = 5000;

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

/**
 * Main auth context providing authentication state and actions.
 * Null when no provider is present — useAuth() checks for this.
 *
 * Exported for use by use-auth.ts and test helpers (e.g., in auth-guard tests).
 * Not part of the public barrel export.
 */
export const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Nesting detection sentinel.
 * When an AuthProvider is mounted it sets this to `true`.
 * A nested AuthProvider reads this and throws.
 * @internal
 */
const AuthNestingContext = createContext<boolean>(false);

// ---------------------------------------------------------------------------
// Helper: resolve config by merging user values with defaults
// ---------------------------------------------------------------------------

/**
 * Merge user-provided auth config with AUTH_DEFAULTS.
 * Returns a fully-resolved ResolvedAuthConfig with no optional properties.
 */
function resolveConfig(config: AuthProviderProps["config"]): ResolvedAuthConfig {
    return {
        basePath: config.basePath,
        endpoints: {
            login: config.endpoints?.login ?? AUTH_DEFAULTS.endpoints.login,
            callback:
                config.endpoints?.callback ?? AUTH_DEFAULTS.endpoints.callback,
            logout: config.endpoints?.logout ?? AUTH_DEFAULTS.endpoints.logout,
            me: config.endpoints?.me ?? AUTH_DEFAULTS.endpoints.me,
            refresh:
                config.endpoints?.refresh ?? AUTH_DEFAULTS.endpoints.refresh,
        },
        loginPath: config.loginPath ?? AUTH_DEFAULTS.loginPath,
        defaultReturnTo: config.defaultReturnTo ?? AUTH_DEFAULTS.defaultReturnTo,
        autoRefresh: config.autoRefresh ?? AUTH_DEFAULTS.autoRefresh,
        refreshLeadTime: config.refreshLeadTime ?? AUTH_DEFAULTS.refreshLeadTime,
    };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Provides authentication state and actions to the component tree.
 *
 * Must be rendered inside a `<GlobalLoaderProvider>` (uses showLoader
 * for loading states). Only one AuthProvider is allowed per tree.
 *
 * @example
 * ```tsx
 * <GlobalLoaderProvider>
 *   <AuthProvider config={{ basePath: '/api/auth' }}>
 *     <App />
 *   </AuthProvider>
 * </GlobalLoaderProvider>
 * ```
 *
 * @throws Error if nested inside another AuthProvider
 * @throws Error if not wrapped in a GlobalLoaderProvider
 */
export function AuthProvider({
    config,
    children,
}: AuthProviderProps): ReactElement {
    // -- Nesting detection ---------------------------------------------------
    const isNested = useContext(AuthNestingContext);
    if (isNested) {
        throw new Error(
            "<AuthProvider> cannot be nested inside another <AuthProvider>. " +
                "Only one provider is allowed in the component tree.",
        );
    }

    // -- Config ref (merged with defaults, captured on mount) ----------------
    const configRef = useRef<ResolvedAuthConfig>(resolveConfig(config));

    // -- GlobalLoader integration --------------------------------------------
    const { showLoader } = useGlobalLoader();

    // -- State ---------------------------------------------------------------
    const [user, setUser] = useState<AuthUser | null>(null);
    const [expiresAt, setExpiresAt] = useState<number | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    // Derived — no need for separate state
    const isAuthenticated = user !== null;

    // -- Refs ----------------------------------------------------------------
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedRef = useRef(true);

    // -- URL builder ---------------------------------------------------------
    /** Construct a full BFF URL from config basePath + endpoint path */
    const buildUrl = useCallback((endpoint: string): string => {
        return `${configRef.current.basePath}${endpoint}`;
    }, []);

    // -- Clear auth state ----------------------------------------------------
    /** Reset all auth state and cancel any pending refresh timer */
    const clearAuthState = useCallback(() => {
        setUser(null);
        setExpiresAt(null);
        if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    // -- Refresh logic -------------------------------------------------------
    /**
     * Call the BFF /refresh endpoint. Returns true on success, false on failure.
     * On success, updates expiresAt state. On auth failure (401/400), clears state.
     * On network error, retries once after REFRESH_RETRY_DELAY_MS, then clears state.
     */
    const performRefresh = useCallback(
        async (isRetry = false): Promise<boolean> => {
            try {
                const response = await fetch(
                    buildUrl(configRef.current.endpoints.refresh),
                    { method: "POST", credentials: "include" },
                );

                if (!mountedRef.current) return false;

                if (response.ok) {
                    const json = await response.json();
                    const newExpiresAt: number | null =
                        json?.data?.expiresAt ?? null;
                    setExpiresAt(newExpiresAt);
                    return true;
                }

                // Auth failure (401, 400) — clear state, no retry
                if (response.status === 401 || response.status === 400) {
                    clearAuthState();
                    return false;
                }

                // HTTP 403 — do NOT clear auth state (per AR #9)
                return false;
            } catch (_error: unknown) {
                if (!mountedRef.current) return false;

                // Network error — retry once after delay, then give up
                if (!isRetry) {
                    return new Promise<boolean>(resolve => {
                        timerRef.current = setTimeout(async () => {
                            if (!mountedRef.current) {
                                resolve(false);
                                return;
                            }
                            const result = await performRefresh(true);
                            resolve(result);
                        }, REFRESH_RETRY_DELAY_MS);
                    });
                }

                // Retry also failed — clear state
                clearAuthState();
                return false;
            }
        },
        [buildUrl, clearAuthState],
    );

    // -- Schedule auto-refresh -----------------------------------------------
    /**
     * Schedule a refresh call based on expiresAt.
     * Calculates delay as (expiresAt - refreshLeadTime) * 1000 - Date.now().
     * If the deadline has already passed, refreshes immediately.
     */
    const scheduleRefresh = useCallback(
        (expiry: number) => {
            // Clear any existing timer
            if (timerRef.current !== null) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }

            const cfg = configRef.current;
            // expiresAt is Unix seconds, convert to ms for comparison with Date.now()
            const refreshAtMs =
                (expiry - cfg.refreshLeadTime) * 1000;
            const delayMs = refreshAtMs - Date.now();

            const doRefresh = async () => {
                if (!mountedRef.current) return;
                const success = await performRefresh();
                // On success, reschedule if new expiresAt is available
                // (state update triggers the useEffect below)
                if (!success) {
                    // Refresh failed — state already cleared by performRefresh
                }
            };

            if (delayMs > 0) {
                // Clamp to 2^31-1 ms (~24.8 days) to avoid Node.js
                // TimeoutOverflowWarning on large expiry values.
                const safeDelay = Math.min(delayMs, 0x7fff_ffff);
                timerRef.current = setTimeout(doRefresh, safeDelay);
            } else {
                // Already past the refresh window — refresh immediately
                void doRefresh();
            }
        },
        [performRefresh],
    );

    // -- Auto-refresh effect -------------------------------------------------
    // Reschedule whenever expiresAt changes and autoRefresh is enabled
    useEffect(() => {
        if (
            configRef.current.autoRefresh &&
            expiresAt !== null &&
            user !== null
        ) {
            scheduleRefresh(expiresAt);
        }

        return () => {
            // Clean up timer when effect re-runs or unmounts
            if (timerRef.current !== null) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [expiresAt, user, scheduleRefresh]);

    // -- Tab visibility handler ----------------------------------------------
    useEffect(() => {
        const handleVisibilityChange = () => {
            if (document.visibilityState !== "visible") return;
            if (!mountedRef.current) return;

            // Only act if we have an authenticated user
            const currentUser = user;
            const currentExpiresAt = expiresAt;
            if (currentUser === null || currentExpiresAt === null) return;

            // Check if we need to refresh (past the lead time threshold)
            const cfg = configRef.current;
            const refreshAtMs =
                (currentExpiresAt - cfg.refreshLeadTime) * 1000;
            if (Date.now() >= refreshAtMs) {
                void performRefresh();
            }
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            document.removeEventListener(
                "visibilitychange",
                handleVisibilityChange,
            );
        };
    }, [user, expiresAt, performRefresh]);

    // -- Mount: session check ------------------------------------------------
    useEffect(() => {
        const controller = new AbortController();

        const checkSession = async () => {
            showLoader(true);
            try {
                const response = await fetch(
                    buildUrl(configRef.current.endpoints.me),
                    { credentials: "include", signal: controller.signal },
                );

                if (!mountedRef.current) return;

                if (response.ok) {
                    const json = await response.json();
                    const meUser = json?.data?.user;

                    // Validate sub claim presence (per AR #2)
                    if (
                        meUser &&
                        typeof meUser === "object" &&
                        typeof meUser.sub === "string" &&
                        meUser.sub.length > 0
                    ) {
                        setUser(meUser as AuthUser);
                        // Map undefined expiresAt to null
                        setExpiresAt(json?.data?.expiresAt ?? null);
                    } else {
                        // Missing or invalid sub — treat as unauthenticated
                        setUser(null);
                        setExpiresAt(null);
                    }
                } else {
                    // Non-OK (e.g., 401) — no session
                    setUser(null);
                    setExpiresAt(null);
                }
            } catch (_error: unknown) {
                // Network error or abort — treat as no session
                if (mountedRef.current) {
                    setUser(null);
                    setExpiresAt(null);
                }
            } finally {
                if (mountedRef.current) {
                    setIsLoading(false);
                    showLoader(false);
                }
            }
        };

        void checkSession();

        // Cleanup on unmount
        return () => {
            mountedRef.current = false;
            controller.abort();
            if (timerRef.current !== null) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps -- mount only

    // -- Public actions -------------------------------------------------------

    /**
     * Redirect the browser to the BFF login endpoint.
     * Constructs the login URL with returnTo query parameter.
     */
    const login = useCallback(
        (returnTo?: string) => {
            const cfg = configRef.current;
            const target = returnTo ?? cfg.defaultReturnTo;
            const loginUrl = buildUrl(cfg.endpoints.login);
            window.location.href = `${loginUrl}?returnTo=${encodeURIComponent(target)}`;
        },
        [buildUrl],
    );

    /**
     * Sign out by calling the BFF logout endpoint, then clear local state.
     * Clears state regardless of whether the server call succeeds.
     */
    const logout = useCallback(async (): Promise<void> => {
        try {
            await fetch(buildUrl(configRef.current.endpoints.logout), {
                method: "POST",
                credentials: "include",
            });
        } catch {
            // Ignore network errors — clear state regardless
        } finally {
            if (mountedRef.current) {
                clearAuthState();
            }
        }
    }, [buildUrl, clearAuthState]);

    /**
     * Manually refresh the session. Returns true on success, false on failure.
     */
    const refresh = useCallback(async (): Promise<boolean> => {
        return performRefresh();
    }, [performRefresh]);

    // -- Context value (memoized) --------------------------------------------
    const contextValue = useMemo<AuthContextValue>(
        () => ({
            user,
            isAuthenticated,
            isLoading,
            login,
            logout,
            refresh,
            expiresAt,
            config: configRef.current,
        }),
        [
            user,
            isAuthenticated,
            isLoading,
            login,
            logout,
            refresh,
            expiresAt,
        ],
    );

    return (
        <AuthNestingContext.Provider value={true}>
            <AuthContext.Provider value={contextValue}>
                {children}
            </AuthContext.Provider>
        </AuthNestingContext.Provider>
    );
}
