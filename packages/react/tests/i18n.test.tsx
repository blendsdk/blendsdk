// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, act, cleanup, waitFor } from "@testing-library/react";
import React, { useEffect } from "react";

import type { TranslationValue } from "@blendsdk/i18n";

import {
    GlobalLoaderProvider,
    I18nProvider,
    useTranslations,
    type I18nContextValue,
    type TranslationLoader,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Standard test translations for English and Dutch */
const TEST_TRANSLATIONS: Record<string, Record<string, TranslationValue>> = {
    en: {
        greeting: "Hello ${name}",
        farewell: "Goodbye",
        book: ["${count} book", "${count} books"],
        "auth.login": "Log in",
    },
    nl: {
        greeting: "Hallo ${name}",
        farewell: "Tot ziens",
        book: ["${count} boek", "${count} boeken"],
        "auth.login": "Inloggen",
    },
};

/**
 * Creates a mock loader that returns translations for the given locale.
 * Throws if locale is not found in the translations map.
 */
function createMockLoader(
    translations: Record<string, Record<string, TranslationValue>>,
): TranslationLoader {
    return vi.fn(async (locale: string) => {
        const result = translations[locale];
        if (!result) {
            throw new Error(`No translations for locale: ${locale}`);
        }
        return result;
    });
}

/** Wraps component with GlobalLoaderProvider (required by I18nProvider) */
function TestWrapper({ children }: { children: React.ReactNode }) {
    return <GlobalLoaderProvider>{children}</GlobalLoaderProvider>;
}

/**
 * Consumer component that exposes useTranslations() hook values
 * and renders translated content for testing.
 */
function TranslationConsumer({
    onMount,
    translationKey,
    translationParams,
}: {
    onMount?: (api: I18nContextValue) => void;
    translationKey?: string;
    translationParams?: Record<string, unknown>;
}) {
    const api = useTranslations();

    useEffect(() => {
        onMount?.(api);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <div>
            <span data-testid="locale">{api.locale}</span>
            <span data-testid="ready">{String(api.ready)}</span>
            {translationKey && (
                <span data-testid="translated">
                    {api.t(translationKey, translationParams)}
                </span>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

afterEach(() => {
    cleanup();
});

// ---------------------------------------------------------------------------
// 1. Rendering and basic hook access
// ---------------------------------------------------------------------------

describe("I18nProvider + useTranslations", () => {
    describe("rendering and basic hook access", () => {
        it("renders children after translations load", async () => {
            const loader = createMockLoader(TEST_TRANSLATIONS);

            render(
                <TestWrapper>
                    <I18nProvider loader={loader}>
                        <div data-testid="child">Hello</div>
                    </I18nProvider>
                </TestWrapper>,
            );

            // Wait for async loader to complete
            await waitFor(() => {
                expect(screen.getByTestId("child")).toBeDefined();
            });
        });

        it("returns { t, locale, setLocale, ready } from useTranslations()", async () => {
            const loader = createMockLoader(TEST_TRANSLATIONS);
            let api: I18nContextValue;

            render(
                <TestWrapper>
                    <I18nProvider loader={loader}>
                        <TranslationConsumer onMount={(a) => (api = a)} />
                    </I18nProvider>
                </TestWrapper>,
            );

            await waitFor(() => {
                expect(screen.getByTestId("ready").textContent).toBe("true");
            });

            // Verify shape of the returned context value
            expect(typeof api!.t).toBe("function");
            expect(typeof api!.locale).toBe("string");
            expect(typeof api!.setLocale).toBe("function");
            expect(typeof api!.ready).toBe("boolean");
        });

        it("ready is true after translations load", async () => {
            const loader = createMockLoader(TEST_TRANSLATIONS);

            render(
                <TestWrapper>
                    <I18nProvider loader={loader}>
                        <TranslationConsumer />
                    </I18nProvider>
                </TestWrapper>,
            );

            await waitFor(() => {
                expect(screen.getByTestId("ready").textContent).toBe("true");
            });
        });

        it("defaults locale to 'en' when not specified", async () => {
            const loader = createMockLoader(TEST_TRANSLATIONS);

            render(
                <TestWrapper>
                    <I18nProvider loader={loader}>
                        <TranslationConsumer />
                    </I18nProvider>
                </TestWrapper>,
            );

            await waitFor(() => {
                expect(screen.getByTestId("locale").textContent).toBe("en");
            });
        });
    });

    // -----------------------------------------------------------------------
    // 2. t() translation function
    // -----------------------------------------------------------------------

    describe("t() translation function", () => {
        it("translates a simple key", async () => {
            const loader = createMockLoader(TEST_TRANSLATIONS);

            render(
                <TestWrapper>
                    <I18nProvider loader={loader}>
                        <TranslationConsumer translationKey="farewell" />
                    </I18nProvider>
                </TestWrapper>,
            );

            await waitFor(() => {
                expect(screen.getByTestId("translated").textContent).toBe(
                    "Goodbye",
                );
            });
        });

        it("interpolates parameters", async () => {
            const loader = createMockLoader(TEST_TRANSLATIONS);

            render(
                <TestWrapper>
                    <I18nProvider loader={loader}>
                        <TranslationConsumer
                            translationKey="greeting"
                            translationParams={{ name: "Alice" }}
                        />
                    </I18nProvider>
                </TestWrapper>,
            );

            await waitFor(() => {
                expect(screen.getByTestId("translated").textContent).toBe(
                    "Hello Alice",
                );
            });
        });

        it("handles singular plural form (count: 1)", async () => {
            const loader = createMockLoader(TEST_TRANSLATIONS);

            render(
                <TestWrapper>
                    <I18nProvider loader={loader}>
                        <TranslationConsumer
                            translationKey="book"
                            translationParams={{ count: 1 }}
                        />
                    </I18nProvider>
                </TestWrapper>,
            );

            await waitFor(() => {
                expect(screen.getByTestId("translated").textContent).toBe(
                    "1 book",
                );
            });
        });

        it("handles plural form (count: 5)", async () => {
            const loader = createMockLoader(TEST_TRANSLATIONS);

            render(
                <TestWrapper>
                    <I18nProvider loader={loader}>
                        <TranslationConsumer
                            translationKey="book"
                            translationParams={{ count: 5 }}
                        />
                    </I18nProvider>
                </TestWrapper>,
            );

            await waitFor(() => {
                expect(screen.getByTestId("translated").textContent).toBe(
                    "5 books",
                );
            });
        });

        it("returns key as-is for unknown keys", async () => {
            const loader = createMockLoader(TEST_TRANSLATIONS);

            render(
                <TestWrapper>
                    <I18nProvider loader={loader}>
                        <TranslationConsumer translationKey="unknown.key" />
                    </I18nProvider>
                </TestWrapper>,
            );

            await waitFor(() => {
                expect(screen.getByTestId("translated").textContent).toBe(
                    "unknown.key",
                );
            });
        });

        it("returns key as-is before translations load", () => {
            // Use a loader that never resolves to keep ready = false
            const neverResolveLoader: TranslationLoader = vi.fn(
                () => new Promise(() => {}),
            );

            render(
                <TestWrapper>
                    <I18nProvider loader={neverResolveLoader}>
                        <TranslationConsumer translationKey="farewell" />
                    </I18nProvider>
                </TestWrapper>,
            );

            // Before load completes, t() should return the key itself
            expect(screen.getByTestId("translated").textContent).toBe(
                "farewell",
            );
            expect(screen.getByTestId("ready").textContent).toBe("false");
        });

        it("translates dotted keys", async () => {
            const loader = createMockLoader(TEST_TRANSLATIONS);

            render(
                <TestWrapper>
                    <I18nProvider loader={loader}>
                        <TranslationConsumer translationKey="auth.login" />
                    </I18nProvider>
                </TestWrapper>,
            );

            await waitFor(() => {
                expect(screen.getByTestId("translated").textContent).toBe(
                    "Log in",
                );
            });
        });
    });

    // -----------------------------------------------------------------------
    // 3. GlobalLoader integration
    // -----------------------------------------------------------------------

    describe("GlobalLoader integration", () => {
        it("calls loader with the default locale on mount", async () => {
            const loader = createMockLoader(TEST_TRANSLATIONS);

            render(
                <TestWrapper>
                    <I18nProvider loader={loader}>
                        <TranslationConsumer />
                    </I18nProvider>
                </TestWrapper>,
            );

            await waitFor(() => {
                expect(screen.getByTestId("ready").textContent).toBe("true");
            });

            // Loader should have been called with 'en' (the default locale)
            expect(loader).toHaveBeenCalledWith("en");
            expect(loader).toHaveBeenCalledTimes(1);
        });

        it("shows and hides GlobalLoader during initial load", async () => {
            // Use a delayed loader to observe loading state
            let resolveLoader!: (
                value: Record<string, TranslationValue>,
            ) => void;
            const delayedLoader: TranslationLoader = vi.fn(
                () =>
                    new Promise<Record<string, TranslationValue>>((resolve) => {
                        resolveLoader = resolve;
                    }),
            );

            render(
                <TestWrapper>
                    <I18nProvider loader={delayedLoader}>
                        <TranslationConsumer />
                    </I18nProvider>
                </TestWrapper>,
            );

            // While loading, ready should be false
            expect(screen.getByTestId("ready").textContent).toBe("false");

            // Resolve the loader
            await act(async () => {
                resolveLoader(TEST_TRANSLATIONS.en);
            });

            // After loading, ready should be true
            expect(screen.getByTestId("ready").textContent).toBe("true");
        });
    });

    // -----------------------------------------------------------------------
    // 4. setLocale
    // -----------------------------------------------------------------------

    describe("setLocale", () => {
        it("triggers loader with new locale", async () => {
            const loader = createMockLoader(TEST_TRANSLATIONS);
            let api: I18nContextValue;

            render(
                <TestWrapper>
                    <I18nProvider loader={loader}>
                        <TranslationConsumer onMount={(a) => (api = a)} />
                    </I18nProvider>
                </TestWrapper>,
            );

            await waitFor(() => {
                expect(screen.getByTestId("ready").textContent).toBe("true");
            });

            // Switch to Dutch
            await act(async () => {
                api!.setLocale("nl");
            });

            // Loader should have been called twice: initial 'en' + switch to 'nl'
            expect(loader).toHaveBeenCalledWith("nl");
            expect(loader).toHaveBeenCalledTimes(2);
        });

        it("updates translations after setLocale completes", async () => {
            const loader = createMockLoader(TEST_TRANSLATIONS);
            let api: I18nContextValue;

            render(
                <TestWrapper>
                    <I18nProvider loader={loader}>
                        <TranslationConsumer
                            onMount={(a) => (api = a)}
                            translationKey="farewell"
                        />
                    </I18nProvider>
                </TestWrapper>,
            );

            await waitFor(() => {
                expect(screen.getByTestId("translated").textContent).toBe(
                    "Goodbye",
                );
            });

            // Switch to Dutch
            await act(async () => {
                api!.setLocale("nl");
            });

            await waitFor(() => {
                expect(screen.getByTestId("translated").textContent).toBe(
                    "Tot ziens",
                );
            });
        });

        it("updates locale value after setLocale", async () => {
            const loader = createMockLoader(TEST_TRANSLATIONS);
            let api: I18nContextValue;

            render(
                <TestWrapper>
                    <I18nProvider loader={loader}>
                        <TranslationConsumer onMount={(a) => (api = a)} />
                    </I18nProvider>
                </TestWrapper>,
            );

            await waitFor(() => {
                expect(screen.getByTestId("locale").textContent).toBe("en");
            });

            await act(async () => {
                api!.setLocale("nl");
            });

            await waitFor(() => {
                expect(screen.getByTestId("locale").textContent).toBe("nl");
            });
        });

        it("no-ops when setting the same locale", async () => {
            const loader = createMockLoader(TEST_TRANSLATIONS);
            let api: I18nContextValue;

            render(
                <TestWrapper>
                    <I18nProvider loader={loader}>
                        <TranslationConsumer onMount={(a) => (api = a)} />
                    </I18nProvider>
                </TestWrapper>,
            );

            await waitFor(() => {
                expect(screen.getByTestId("ready").textContent).toBe("true");
            });

            // Try setting the same locale again
            await act(async () => {
                api!.setLocale("en");
            });

            // Loader should still only have been called once (initial load)
            expect(loader).toHaveBeenCalledTimes(1);
        });
    });

    // -----------------------------------------------------------------------
    // 5. Error handling
    // -----------------------------------------------------------------------

    describe("error handling", () => {
        it("throws when I18nProvider is nested inside another", () => {
            const consoleSpy = vi
                .spyOn(console, "error")
                .mockImplementation(() => {});

            const loader = createMockLoader(TEST_TRANSLATIONS);

            expect(() => {
                render(
                    <TestWrapper>
                        <I18nProvider loader={loader}>
                            <I18nProvider loader={loader}>
                                <div>Nested</div>
                            </I18nProvider>
                        </I18nProvider>
                    </TestWrapper>,
                );
            }).toThrow(
                "<I18nProvider> cannot be nested inside another <I18nProvider>",
            );

            consoleSpy.mockRestore();
        });

        it("throws when useTranslations() is called outside I18nProvider", () => {
            const consoleSpy = vi
                .spyOn(console, "error")
                .mockImplementation(() => {});

            function BadComponent() {
                useTranslations();
                return null;
            }

            expect(() => {
                render(
                    <TestWrapper>
                        <BadComponent />
                    </TestWrapper>,
                );
            }).toThrow(
                "useTranslations() must be used within an <I18nProvider>",
            );

            consoleSpy.mockRestore();
        });

        it("handles loader error on mount gracefully", async () => {
            const consoleSpy = vi
                .spyOn(console, "error")
                .mockImplementation(() => {});

            // Loader that always fails
            const failingLoader: TranslationLoader = vi.fn(async () => {
                throw new Error("Network error");
            });

            render(
                <TestWrapper>
                    <I18nProvider loader={failingLoader}>
                        <TranslationConsumer translationKey="farewell" />
                    </I18nProvider>
                </TestWrapper>,
            );

            // Wait for the error to be logged
            await waitFor(() => {
                expect(consoleSpy).toHaveBeenCalledWith(
                    expect.stringContaining(
                        "[I18nProvider] Failed to load translations",
                    ),
                    expect.any(Error),
                );
            });

            // ready should stay false
            expect(screen.getByTestId("ready").textContent).toBe("false");

            // t() should return key as-is since not ready
            expect(screen.getByTestId("translated").textContent).toBe(
                "farewell",
            );

            consoleSpy.mockRestore();
        });

        it("handles loader error on locale switch gracefully", async () => {
            const consoleSpy = vi
                .spyOn(console, "error")
                .mockImplementation(() => {});

            // Loader that succeeds for 'en' but fails for 'nl'
            let callCount = 0;
            const partialLoader: TranslationLoader = vi.fn(
                async (locale: string) => {
                    callCount++;
                    if (locale === "nl") {
                        throw new Error("Network error for nl");
                    }
                    return TEST_TRANSLATIONS[locale]!;
                },
            );

            let api: I18nContextValue;

            render(
                <TestWrapper>
                    <I18nProvider loader={partialLoader}>
                        <TranslationConsumer
                            onMount={(a) => (api = a)}
                            translationKey="farewell"
                        />
                    </I18nProvider>
                </TestWrapper>,
            );

            // Wait for initial load to complete
            await waitFor(() => {
                expect(screen.getByTestId("ready").textContent).toBe("true");
                expect(screen.getByTestId("translated").textContent).toBe(
                    "Goodbye",
                );
            });

            // Switch to nl (will fail)
            await act(async () => {
                api!.setLocale("nl");
            });

            // Error should be logged
            await waitFor(() => {
                expect(consoleSpy).toHaveBeenCalledWith(
                    expect.stringContaining(
                        "[I18nProvider] Failed to load translations",
                    ),
                    expect.any(Error),
                );
            });

            consoleSpy.mockRestore();
        });
    });

    // -----------------------------------------------------------------------
    // 6. onMissingTranslation callback
    // -----------------------------------------------------------------------

    describe("onMissingTranslation callback", () => {
        it("fires when a translation key is not found", async () => {
            const loader = createMockLoader(TEST_TRANSLATIONS);
            const onMissing = vi.fn();

            render(
                <TestWrapper>
                    <I18nProvider
                        loader={loader}
                        onMissingTranslation={onMissing}
                    >
                        <TranslationConsumer translationKey="nonexistent.key" />
                    </I18nProvider>
                </TestWrapper>,
            );

            await waitFor(() => {
                expect(screen.getByTestId("ready").textContent).toBe("true");
            });

            // onMissingTranslation should have been called
            expect(onMissing).toHaveBeenCalled();
        });

        it("receives correct key and locale arguments", async () => {
            const loader = createMockLoader(TEST_TRANSLATIONS);
            const onMissing = vi.fn();

            render(
                <TestWrapper>
                    <I18nProvider
                        loader={loader}
                        onMissingTranslation={onMissing}
                    >
                        <TranslationConsumer translationKey="missing.key" />
                    </I18nProvider>
                </TestWrapper>,
            );

            await waitFor(() => {
                expect(screen.getByTestId("ready").textContent).toBe("true");
            });

            // Verify correct arguments
            expect(onMissing).toHaveBeenCalledWith("missing.key", "en");
        });
    });

    // -----------------------------------------------------------------------
    // 7. Custom defaultLocale
    // -----------------------------------------------------------------------

    describe("custom defaultLocale", () => {
        it("uses the specified defaultLocale instead of 'en'", async () => {
            const loader = createMockLoader(TEST_TRANSLATIONS);

            render(
                <TestWrapper>
                    <I18nProvider loader={loader} defaultLocale="nl">
                        <TranslationConsumer translationKey="farewell" />
                    </I18nProvider>
                </TestWrapper>,
            );

            await waitFor(() => {
                expect(screen.getByTestId("locale").textContent).toBe("nl");
                expect(screen.getByTestId("translated").textContent).toBe(
                    "Tot ziens",
                );
            });

            // Loader should have been called with 'nl'
            expect(loader).toHaveBeenCalledWith("nl");
        });
    });
});
