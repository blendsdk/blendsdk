// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import React, { useEffect } from "react";

import {
    GlobalLoaderProvider,
    useGlobalLoader,
    type GlobalLoaderContextValue,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Test helper — renders a consumer component inside the provider
// ---------------------------------------------------------------------------

function TestConsumer({
    onMount,
}: {
    onMount: (api: GlobalLoaderContextValue) => void;
}) {
    const api = useGlobalLoader();
    useEffect(() => {
        onMount(api);
    }, []);
    return <div data-testid="child">child</div>;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
    // Reset body overflow before each test
    document.body.style.overflow = "";
});

afterEach(() => {
    cleanup();
    // Clean up any leftover style tags
    document
        .querySelectorAll("style[data-blend-global-loader-styles]")
        .forEach((el) => el.remove());
    // Restore body overflow
    document.body.style.overflow = "";
});

// ---------------------------------------------------------------------------
// 1. Provider renders children
// ---------------------------------------------------------------------------

describe("GlobalLoaderProvider", () => {
    it("renders children without showing the overlay by default", () => {
        render(
            <GlobalLoaderProvider>
                <div data-testid="child">Hello</div>
            </GlobalLoaderProvider>,
        );

        expect(screen.getByTestId("child")).toBeDefined();
        expect(
            screen.queryByTestId("blend-global-loader-overlay"),
        ).toBeNull();
    });

    // -----------------------------------------------------------------------
    // 2. showLoader(true) shows overlay
    // -----------------------------------------------------------------------

    it("shows the overlay when showLoader(true) is called", () => {
        let api: GlobalLoaderContextValue;

        render(
            <GlobalLoaderProvider>
                <TestConsumer onMount={(a) => (api = a)} />
            </GlobalLoaderProvider>,
        );

        act(() => {
            api!.showLoader(true);
        });

        expect(
            screen.getByTestId("blend-global-loader-overlay"),
        ).toBeDefined();
        expect(
            screen.getByTestId("blend-global-loader-spinner"),
        ).toBeDefined();
    });

    // -----------------------------------------------------------------------
    // 3. showLoader(false) hides overlay
    // -----------------------------------------------------------------------

    it("hides the overlay when showLoader(false) is called", () => {
        let api: GlobalLoaderContextValue;

        render(
            <GlobalLoaderProvider>
                <TestConsumer onMount={(a) => (api = a)} />
            </GlobalLoaderProvider>,
        );

        act(() => {
            api!.showLoader(true);
        });

        expect(
            screen.getByTestId("blend-global-loader-overlay"),
        ).toBeDefined();

        act(() => {
            api!.showLoader(false);
        });

        expect(
            screen.queryByTestId("blend-global-loader-overlay"),
        ).toBeNull();
    });

    // -----------------------------------------------------------------------
    // 4. showLoader(false) clears text (AR #1)
    // -----------------------------------------------------------------------

    it("clears text when showLoader(false) is called", () => {
        let api: GlobalLoaderContextValue;

        render(
            <GlobalLoaderProvider>
                <TestConsumer onMount={(a) => (api = a)} />
            </GlobalLoaderProvider>,
        );

        act(() => {
            api!.setText("Loading…");
            api!.showLoader(true);
        });

        expect(screen.getByText("Loading…")).toBeDefined();

        act(() => {
            api!.showLoader(false);
        });

        expect(screen.queryByText("Loading…")).toBeNull();

        // Show again — text should not reappear
        act(() => {
            api!.showLoader(true);
        });

        expect(screen.queryByText("Loading…")).toBeNull();
    });

    // -----------------------------------------------------------------------
    // 5. setText displays text
    // -----------------------------------------------------------------------

    it("displays text below the spinner when setText is called", () => {
        let api: GlobalLoaderContextValue;

        render(
            <GlobalLoaderProvider>
                <TestConsumer onMount={(a) => (api = a)} />
            </GlobalLoaderProvider>,
        );

        act(() => {
            api!.setText("Please wait…");
            api!.showLoader(true);
        });

        expect(screen.getByText("Please wait…")).toBeDefined();
    });

    // -----------------------------------------------------------------------
    // 6. setText(null) clears text
    // -----------------------------------------------------------------------

    it("clears text when setText(null) is called", () => {
        let api: GlobalLoaderContextValue;

        render(
            <GlobalLoaderProvider>
                <TestConsumer onMount={(a) => (api = a)} />
            </GlobalLoaderProvider>,
        );

        act(() => {
            api!.setText("Loading…");
            api!.showLoader(true);
        });

        expect(screen.getByText("Loading…")).toBeDefined();

        act(() => {
            api!.setText(null);
        });

        expect(screen.queryByText("Loading…")).toBeNull();
    });

    // -----------------------------------------------------------------------
    // 7. Default config values
    // -----------------------------------------------------------------------

    it("applies default config values when no config is provided", () => {
        let api: GlobalLoaderContextValue;

        render(
            <GlobalLoaderProvider>
                <TestConsumer onMount={(a) => (api = a)} />
            </GlobalLoaderProvider>,
        );

        act(() => {
            api!.showLoader(true);
        });

        const overlay = screen.getByTestId("blend-global-loader-overlay");
        const spinner = screen.getByTestId("blend-global-loader-spinner");

        // Default background: #fafafa
        expect(overlay.style.backgroundColor).toBe("rgb(250, 250, 250)");
        // Default z-index: 999999
        expect(overlay.style.zIndex).toBe("999999");
        // Default spinner color: #888888
        expect(spinner.style.background).toBe("rgb(136, 136, 136)");
        // Default spinner width (padding): 3px
        expect(spinner.style.padding).toBe("3px");
        // Default spinner size: 50px
        expect(spinner.style.width).toBe("50px");
    });

    // -----------------------------------------------------------------------
    // 8. Custom spinnerColor
    // -----------------------------------------------------------------------

    it("applies custom spinnerColor from config", () => {
        let api: GlobalLoaderContextValue;

        render(
            <GlobalLoaderProvider config={{ spinnerColor: "#25b09b" }}>
                <TestConsumer onMount={(a) => (api = a)} />
            </GlobalLoaderProvider>,
        );

        act(() => {
            api!.showLoader(true);
        });

        const spinner = screen.getByTestId("blend-global-loader-spinner");
        expect(spinner.style.background).toBe("rgb(37, 176, 155)");
    });

    // -----------------------------------------------------------------------
    // 9. Custom backgroundColor
    // -----------------------------------------------------------------------

    it("applies custom backgroundColor from config", () => {
        let api: GlobalLoaderContextValue;

        render(
            <GlobalLoaderProvider config={{ backgroundColor: "#ffffff" }}>
                <TestConsumer onMount={(a) => (api = a)} />
            </GlobalLoaderProvider>,
        );

        act(() => {
            api!.showLoader(true);
        });

        const overlay = screen.getByTestId("blend-global-loader-overlay");
        expect(overlay.style.backgroundColor).toBe("rgb(255, 255, 255)");
    });

    // -----------------------------------------------------------------------
    // 10. Custom spinnerSize
    // -----------------------------------------------------------------------

    it("applies custom spinnerSize from config", () => {
        let api: GlobalLoaderContextValue;

        render(
            <GlobalLoaderProvider config={{ spinnerSize: 80 }}>
                <TestConsumer onMount={(a) => (api = a)} />
            </GlobalLoaderProvider>,
        );

        act(() => {
            api!.showLoader(true);
        });

        const spinner = screen.getByTestId("blend-global-loader-spinner");
        expect(spinner.style.width).toBe("80px");
    });

    // -----------------------------------------------------------------------
    // 10b. Custom spinnerWidth
    // -----------------------------------------------------------------------

    it("applies custom spinnerWidth from config", () => {
        let api: GlobalLoaderContextValue;

        render(
            <GlobalLoaderProvider config={{ spinnerWidth: 6 }}>
                <TestConsumer onMount={(a) => (api = a)} />
            </GlobalLoaderProvider>,
        );

        act(() => {
            api!.showLoader(true);
        });

        const spinner = screen.getByTestId("blend-global-loader-spinner");
        expect(spinner.style.padding).toBe("6px");
    });

    // -----------------------------------------------------------------------
    // 11. Custom zIndex
    // -----------------------------------------------------------------------

    it("applies custom zIndex from config", () => {
        let api: GlobalLoaderContextValue;

        render(
            <GlobalLoaderProvider config={{ zIndex: 5000 }}>
                <TestConsumer onMount={(a) => (api = a)} />
            </GlobalLoaderProvider>,
        );

        act(() => {
            api!.showLoader(true);
        });

        const overlay = screen.getByTestId("blend-global-loader-overlay");
        expect(overlay.style.zIndex).toBe("5000");
    });

    // -----------------------------------------------------------------------
    // 12. Custom textComponent
    // -----------------------------------------------------------------------

    it("renders custom textComponent when provided", () => {
        let api: GlobalLoaderContextValue;

        const customTextComponent = ({
            text,
        }: {
            text: string;
            textColor: string;
        }) => <span data-testid="custom-text">{text}</span>;

        render(
            <GlobalLoaderProvider
                config={{ textComponent: customTextComponent }}
            >
                <TestConsumer onMount={(a) => (api = a)} />
            </GlobalLoaderProvider>,
        );

        act(() => {
            api!.setText("Custom text");
            api!.showLoader(true);
        });

        const customEl = screen.getByTestId("custom-text");
        expect(customEl).toBeDefined();
        expect(customEl.textContent).toBe("Custom text");
    });

    // -----------------------------------------------------------------------
    // 15. visible reflects state
    // -----------------------------------------------------------------------

    it("visible reflects the current loader state", () => {
        let api: GlobalLoaderContextValue;
        const visibleStates: boolean[] = [];

        function StateTracker() {
            const loaderApi = useGlobalLoader();
            visibleStates.push(loaderApi.visible);
            useEffect(() => {
                api = loaderApi;
            }, []);
            return null;
        }

        render(
            <GlobalLoaderProvider>
                <StateTracker />
            </GlobalLoaderProvider>,
        );

        // Initially false
        expect(visibleStates[0]).toBe(false);

        act(() => {
            api!.showLoader(true);
        });

        // After show — last recorded state should be true
        expect(visibleStates[visibleStates.length - 1]).toBe(true);

        act(() => {
            api!.showLoader(false);
        });

        // After hide — last recorded state should be false
        expect(visibleStates[visibleStates.length - 1]).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 13. Hook outside provider throws
// ---------------------------------------------------------------------------

describe("useGlobalLoader", () => {
    it("throws when called outside a GlobalLoaderProvider", () => {
        // Suppress React error boundary console output
        const consoleSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});

        function BadComponent() {
            useGlobalLoader();
            return null;
        }

        expect(() => {
            render(<BadComponent />);
        }).toThrow(
            "useGlobalLoader() must be used within a <GlobalLoaderProvider>",
        );

        consoleSpy.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// 14. Nested provider throws (AR #8)
// ---------------------------------------------------------------------------

describe("Nested GlobalLoaderProvider", () => {
    it("throws when GlobalLoaderProvider is nested inside another", () => {
        const consoleSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});

        expect(() => {
            render(
                <GlobalLoaderProvider>
                    <GlobalLoaderProvider>
                        <div>Nested</div>
                    </GlobalLoaderProvider>
                </GlobalLoaderProvider>,
            );
        }).toThrow(
            "<GlobalLoaderProvider> cannot be nested inside another <GlobalLoaderProvider>",
        );

        consoleSpy.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// Reference Counting Tests (RC-1 through RC-6)
// ---------------------------------------------------------------------------

describe("GlobalLoader reference counting", () => {
    // RC-1: Multi-consumer both show → overlay visible
    it("should show overlay when two consumers both call showLoader(true)", () => {
        let api: GlobalLoaderContextValue;

        render(
            <GlobalLoaderProvider>
                <TestConsumer onMount={(a) => (api = a)} />
            </GlobalLoaderProvider>,
        );

        act(() => {
            api!.showLoader(true); // count: 0 → 1
            api!.showLoader(true); // count: 1 → 2
        });

        expect(
            screen.getByTestId("blend-global-loader-overlay"),
        ).toBeDefined();
    });

    // RC-2: Multi-consumer one hides → overlay still visible
    it("should keep overlay visible when only one consumer hides", () => {
        let api: GlobalLoaderContextValue;

        render(
            <GlobalLoaderProvider>
                <TestConsumer onMount={(a) => (api = a)} />
            </GlobalLoaderProvider>,
        );

        act(() => {
            api!.showLoader(true); // count: 0 → 1
            api!.showLoader(true); // count: 1 → 2
        });

        act(() => {
            api!.showLoader(false); // count: 2 → 1
        });

        // Overlay should still be visible (count === 1)
        expect(
            screen.getByTestId("blend-global-loader-overlay"),
        ).toBeDefined();
    });

    // RC-3: Multi-consumer both hide → overlay hidden
    it("should hide overlay when all consumers call showLoader(false)", () => {
        let api: GlobalLoaderContextValue;

        render(
            <GlobalLoaderProvider>
                <TestConsumer onMount={(a) => (api = a)} />
            </GlobalLoaderProvider>,
        );

        act(() => {
            api!.showLoader(true); // count: 0 → 1
            api!.showLoader(true); // count: 1 → 2
        });

        act(() => {
            api!.showLoader(false); // count: 2 → 1
            api!.showLoader(false); // count: 1 → 0
        });

        expect(
            screen.queryByTestId("blend-global-loader-overlay"),
        ).toBeNull();
    });

    // RC-4: Text clears only on last hide
    it("should only clear text when the last consumer hides the loader", () => {
        let api: GlobalLoaderContextValue;

        render(
            <GlobalLoaderProvider>
                <TestConsumer onMount={(a) => (api = a)} />
            </GlobalLoaderProvider>,
        );

        act(() => {
            api!.setText("Loading…");
            api!.showLoader(true); // count: 0 → 1
            api!.showLoader(true); // count: 1 → 2
        });

        expect(screen.getByText("Loading…")).toBeDefined();

        // First hide — text should stay (count goes from 2 → 1)
        act(() => {
            api!.showLoader(false);
        });

        expect(screen.getByText("Loading…")).toBeDefined();

        // Second hide — text should clear (count goes from 1 → 0)
        act(() => {
            api!.showLoader(false);
        });

        expect(screen.queryByText("Loading…")).toBeNull();
    });

    // RC-5: Backward-compatible single consumer behavior
    it("should work correctly with a single consumer show/hide cycle", () => {
        let api: GlobalLoaderContextValue;

        render(
            <GlobalLoaderProvider>
                <TestConsumer onMount={(a) => (api = a)} />
            </GlobalLoaderProvider>,
        );

        // Show
        act(() => {
            api!.showLoader(true);
        });

        expect(
            screen.getByTestId("blend-global-loader-overlay"),
        ).toBeDefined();

        // Hide
        act(() => {
            api!.showLoader(false);
        });

        expect(
            screen.queryByTestId("blend-global-loader-overlay"),
        ).toBeNull();
    });

    // RC-6: Underflow protection — hide when already hidden doesn't crash
    it("should not go below zero when showLoader(false) is called while already hidden", () => {
        let api: GlobalLoaderContextValue;

        render(
            <GlobalLoaderProvider>
                <TestConsumer onMount={(a) => (api = a)} />
            </GlobalLoaderProvider>,
        );

        // Multiple false calls when count is already 0
        act(() => {
            api!.showLoader(false);
            api!.showLoader(false);
            api!.showLoader(false);
        });

        // Should not crash, overlay stays hidden
        expect(
            screen.queryByTestId("blend-global-loader-overlay"),
        ).toBeNull();

        // Should still work normally after underflow attempts
        act(() => {
            api!.showLoader(true);
        });

        expect(
            screen.getByTestId("blend-global-loader-overlay"),
        ).toBeDefined();

        act(() => {
            api!.showLoader(false);
        });

        expect(
            screen.queryByTestId("blend-global-loader-overlay"),
        ).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// 16-17. Style tag injection
// ---------------------------------------------------------------------------

describe("Style tag injection", () => {
    it("injects a style tag into document head on mount", () => {
        render(
            <GlobalLoaderProvider>
                <div>App</div>
            </GlobalLoaderProvider>,
        );

        const styleTag = document.querySelector(
            "style[data-blend-global-loader-styles]",
        );
        expect(styleTag).not.toBeNull();
        expect(styleTag!.textContent).toContain("blend-global-loader-spin");
    });

    it("removes the style tag on unmount", () => {
        const { unmount } = render(
            <GlobalLoaderProvider>
                <div>App</div>
            </GlobalLoaderProvider>,
        );

        expect(
            document.querySelector(
                "style[data-blend-global-loader-styles]",
            ),
        ).not.toBeNull();

        unmount();

        expect(
            document.querySelector(
                "style[data-blend-global-loader-styles]",
            ),
        ).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// 18-20. Body overflow (AR #5)
// ---------------------------------------------------------------------------

describe("Body overflow lock", () => {
    it("sets body overflow to hidden when loader is visible", () => {
        let api: GlobalLoaderContextValue;

        render(
            <GlobalLoaderProvider>
                <TestConsumer onMount={(a) => (api = a)} />
            </GlobalLoaderProvider>,
        );

        expect(document.body.style.overflow).toBe("");

        act(() => {
            api!.showLoader(true);
        });

        expect(document.body.style.overflow).toBe("hidden");
    });

    it("restores body overflow when loader is hidden", () => {
        let api: GlobalLoaderContextValue;
        document.body.style.overflow = "auto";

        render(
            <GlobalLoaderProvider>
                <TestConsumer onMount={(a) => (api = a)} />
            </GlobalLoaderProvider>,
        );

        act(() => {
            api!.showLoader(true);
        });

        expect(document.body.style.overflow).toBe("hidden");

        act(() => {
            api!.showLoader(false);
        });

        expect(document.body.style.overflow).toBe("auto");
    });

    it("restores body overflow on unmount when loader is visible", () => {
        let api: GlobalLoaderContextValue;
        document.body.style.overflow = "scroll";

        const { unmount } = render(
            <GlobalLoaderProvider>
                <TestConsumer onMount={(a) => (api = a)} />
            </GlobalLoaderProvider>,
        );

        act(() => {
            api!.showLoader(true);
        });

        expect(document.body.style.overflow).toBe("hidden");

        unmount();

        expect(document.body.style.overflow).toBe("scroll");
    });
});
