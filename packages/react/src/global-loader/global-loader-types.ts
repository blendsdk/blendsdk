/**
 * Types and configuration for the GlobalLoader feature.
 *
 * @packageDocumentation
 */

import type { ReactElement, ReactNode } from 'react';

/**
 * Configuration for the GlobalLoaderProvider.
 * All properties are optional — sensible defaults are applied.
 *
 * @remarks
 * Configuration is captured on mount and is NOT reactive.
 * To change config, remount the provider.
 */
export interface GlobalLoaderConfig {
  /** CSS color for the spinner arc. Default: "#888888" */
  spinnerColor?: string;
  /** Spinner arc width (padding) in pixels. Default: 3 */
  spinnerWidth?: number;
  /** Background color of the full-screen overlay. Default: "#fafafa" */
  backgroundColor?: string;
  /** Spinner diameter in pixels. Default: 50 */
  spinnerSize?: number;
    /** CSS color for the text below the spinner. Default: "#888888" (matches spinnerColor) */
    textColor?: string;
    /** CSS z-index for the overlay. Default: 999999 */
    zIndex?: number;
    /**
     * Custom render function for the text displayed below the spinner.
     * Receives `{ text, textColor }` and must return a ReactElement.
     *
     * @example
     * ```tsx
     * textComponent: ({ text, textColor }) => <Text style={{ color: textColor }}>{text}</Text>
     * ```
     *
     * Default: `<p>` with `color: textColor, fontSize: 14px, marginTop: 16px`
     */
    textComponent?: (props: { text: string; textColor: string }) => ReactElement;
}

/**
 * Context value provided by GlobalLoaderProvider.
 * Consumed via the useGlobalLoader() hook.
 */
export interface GlobalLoaderContextValue {
  /** Show or hide the loader overlay. Hiding automatically clears text. */
  showLoader: (visible: boolean) => void;
  /** Set the message displayed below the spinner. Pass null or "" to clear. */
  setText: (text: string | null) => void;
  /** Current visibility state of the loader (read-only). */
  visible: boolean;
}

/**
 * Props for the GlobalLoaderProvider component.
 */
export interface GlobalLoaderProviderProps {
  /** Optional configuration. Defaults applied for all omitted properties. */
  config?: GlobalLoaderConfig;
  /** Application subtree. */
  children: ReactNode;
}

/** Default configuration values. */
export const GLOBAL_LOADER_DEFAULTS = {
    spinnerColor: "#888888",
    backgroundColor: "#fafafa",
    spinnerSize: 50,
    spinnerWidth: 3,
    textColor: "#888888",
    zIndex: 999999,
} as const;
