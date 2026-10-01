/**
 * Presentational overlay component for the GlobalLoader.
 * Renders a full-screen fixed overlay with a centered CSS spinner
 * and optional text message.
 *
 * @remarks
 * This is an internal component — not exported from the public API.
 * It is rendered conditionally by GlobalLoaderProvider when visible.
 *
 * @packageDocumentation
 */

import type { CSSProperties, ReactElement } from "react";

/** @internal Props for the overlay component. */
export interface GlobalLoaderOverlayProps {
    spinnerColor: string;
    spinnerWidth: number;
    spinnerSize: number;
    backgroundColor: string;
    textColor: string;
    zIndex: number;
    text: string | null;
    textComponent: (props: { text: string; textColor: string }) => ReactElement;
}

/** Default text component with sensible styling. */
const defaultTextComponent = ({
    text,
    textColor,
}: {
    text: string;
    textColor: string;
}): ReactElement => (
    <p style={{ marginTop: 16, color: textColor, fontSize: 14 }}>{text}</p>
);

/**
 * Full-screen overlay with centered spinner and optional text.
 * @internal
 */
export function GlobalLoaderOverlay({
    spinnerColor,
    spinnerWidth,
    spinnerSize,
    backgroundColor,
    textColor,
    zIndex,
    text,
    textComponent: TextComponent = defaultTextComponent,
}: GlobalLoaderOverlayProps): ReactElement {
    const overlayStyle: CSSProperties = {
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor,
        zIndex,
    };

    const spinnerStyle: CSSProperties = {
        width: spinnerSize,
        padding: spinnerWidth,
        background: spinnerColor,
    };

    const hasText = text !== null && text !== "";

    return (
        <div style={overlayStyle} data-testid="blend-global-loader-overlay">
            <div
                className="blend-global-loader-spinner"
                style={spinnerStyle}
                data-testid="blend-global-loader-spinner"
            />
            {hasText && <TextComponent text={text} textColor={textColor} />}
        </div>
    );
}

export { defaultTextComponent };
