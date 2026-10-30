/**
 * GlobalLoader React context and provider component.
 *
 * The provider manages loader state, injects CSS styles at runtime,
 * handles body scroll locking, and detects nested provider misuse.
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

import {
    GLOBAL_LOADER_DEFAULTS,
    type GlobalLoaderConfig,
    type GlobalLoaderContextValue,
    type GlobalLoaderProviderProps,
} from "./global-loader-types.js";

import {
    defaultTextComponent,
    GlobalLoaderOverlay,
} from "./global-loader-overlay.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STYLE_TAG_ID = "blend-global-loader-styles";

/** CSS injected into <head> at runtime for the spinner animation. */
const LOADER_CSS = `
@keyframes blend-global-loader-spin {
  to { transform: rotate(1turn); }
}

.blend-global-loader-spinner {
  aspect-ratio: 1;
  border-radius: 50%;
  --_m:
    conic-gradient(#0000 10%, #000),
    linear-gradient(#000 0 0) content-box;
  -webkit-mask: var(--_m);
          mask: var(--_m);
  -webkit-mask-composite: source-out;
          mask-composite: subtract;
  animation: blend-global-loader-spin 1s infinite linear;
}
`;

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

/**
 * Main context providing loader controls to consumers.
 * Null when no provider is present — the hook checks for this.
 */
export const GlobalLoaderContext =
    createContext<GlobalLoaderContextValue | null>(null);

/**
 * Nesting detection context.
 * When a provider is mounted it sets this to `true`.
 * A nested provider reads this and throws.
 * @internal
 */
const GlobalLoaderNestingContext = createContext<boolean>(false);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Provides global loader state and controls to the component tree.
 *
 * @example
 * ```tsx
 * <GlobalLoaderProvider config={{ spinnerColor: '#25b09b' }}>
 *   <App />
 * </GlobalLoaderProvider>
 * ```
 *
 * @throws Error if nested inside another `GlobalLoaderProvider`.
 */
export function GlobalLoaderProvider({
    config,
    children,
}: GlobalLoaderProviderProps): ReactElement {
    // -- Nesting detection (AR #8) ------------------------------------------
    const isNested = useContext(GlobalLoaderNestingContext);
    if (isNested) {
        throw new Error(
            "<GlobalLoaderProvider> cannot be nested inside another <GlobalLoaderProvider>. " +
                "Only one provider is allowed in the component tree.",
        );
    }

    // -- Config ref (AR #12 — not reactive, captured on mount) ---------------
    const configRef = useRef<Required<GlobalLoaderConfig>>({
        spinnerColor: config?.spinnerColor ?? GLOBAL_LOADER_DEFAULTS.spinnerColor,
        spinnerWidth: config?.spinnerWidth ?? GLOBAL_LOADER_DEFAULTS.spinnerWidth,
        backgroundColor:
            config?.backgroundColor ?? GLOBAL_LOADER_DEFAULTS.backgroundColor,
        spinnerSize: config?.spinnerSize ?? GLOBAL_LOADER_DEFAULTS.spinnerSize,
        textColor: config?.textColor ?? GLOBAL_LOADER_DEFAULTS.textColor,
        zIndex: config?.zIndex ?? GLOBAL_LOADER_DEFAULTS.zIndex,
        textComponent: config?.textComponent ?? defaultTextComponent,
    });

    // -- State ---------------------------------------------------------------
    // Reference-counted visibility: multiple consumers can independently
    // show/hide the loader without interfering with each other.
    const [count, setCount] = useState(0);
    const visible = count > 0;
    const [text, setText] = useState<string | null>(null);

    // -- Style injection (AR #4) ---------------------------------------------
    useEffect(() => {
        // Check for existing style tag (handles rapid remount)
        let styleEl = document.querySelector(
            `style[data-${STYLE_TAG_ID}]`,
        ) as HTMLStyleElement | null;

        if (!styleEl) {
            styleEl = document.createElement("style");
            styleEl.setAttribute(`data-${STYLE_TAG_ID}`, "");
            styleEl.textContent = LOADER_CSS;
            document.head.appendChild(styleEl);
        }

        return () => {
            styleEl?.remove();
        };
    }, []);

    // -- Body scroll lock (AR #5) --------------------------------------------
    useEffect(() => {
        if (!visible) {
            return;
        }

        const originalOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";

        return () => {
            document.body.style.overflow = originalOverflow;
        };
    }, [visible]);

    // -- Callbacks -----------------------------------------------------------
    // Reference-counted show/hide: increment on show, decrement on hide.
    // Text is only cleared when ALL consumers have hidden the loader (count === 0).
    const showLoader = useCallback((show: boolean) => {
        setCount(prev => {
            const next = show ? prev + 1 : Math.max(0, prev - 1);
            // Only clear text when ALL consumers have hidden the loader
            if (next === 0) {
                setText(null);
            }
            return next;
        });
    }, []);

    const setTextCallback = useCallback((value: string | null) => {
        setText(value);
    }, []);

    // -- Context value (memoized) --------------------------------------------
    const contextValue = useMemo<GlobalLoaderContextValue>(
        () => ({
            showLoader,
            setText: setTextCallback,
            visible,
        }),
        [showLoader, setTextCallback, visible],
    );

    // -- Resolved config from ref --------------------------------------------
    const {
        spinnerColor,
        spinnerWidth,
        backgroundColor,
        spinnerSize,
        textColor,
        zIndex,
        textComponent,
    } = configRef.current;

    return (
        <GlobalLoaderNestingContext.Provider value={true}>
            <GlobalLoaderContext.Provider value={contextValue}>
                {children}
                {visible && (
                    <GlobalLoaderOverlay
                        spinnerColor={spinnerColor}
                        spinnerWidth={spinnerWidth}
                        spinnerSize={spinnerSize}
                        backgroundColor={backgroundColor}
                        textColor={textColor}
                        zIndex={zIndex}
                        text={text}
                        textComponent={textComponent}
                    />
                )}
            </GlobalLoaderContext.Provider>
        </GlobalLoaderNestingContext.Provider>
    );
}
