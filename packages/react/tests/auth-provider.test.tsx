// @vitest-environment jsdom

/**
 * AuthProvider test suite — AP-1 through AP-16
 *
 * @see plans/react-auth/07-testing-strategy.md
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { GlobalLoaderProvider, useGlobalLoader } from "../src/global-loader/index.js";
import { AuthProvider, useAuth, AUTH_DEFAULTS, type AuthConfig } from "../src/auth/index.js";
import type { ReactElement } from "react";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a mock fetch that routes by "METHOD url" key */
function mockFetch(
    responses: Record<string, { status: number; body: unknown }>,
) {
    return vi.fn((url: string | URL | Request, options?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        const method = options?.method ?? "GET";
        const key = `${method} ${urlStr}`;
        const response = responses[key];
        if (!response) {
            return Promise.reject(new Error(`Unexpected fetch: ${key}`));
        }
        return Promise.resolve({
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            json: () => Promise.resolve(response.body),
        } as Response);
    });
}

/** Standard user object for tests */
const TEST_USER = { sub: "user-123", name: "Alice", email: "alice@test.com" };

/** Standard BFF success response for /me */
function makeMeResponse(
    user: Record<string, unknown>,
    expiresAt?: number,
) {
    return {
        status: 200,
        body: { success: true, data: { user, expiresAt } },
    };
}

/** Standard BFF error response */
function makeErrorResponse(status: number) {
    return { status, body: { success: false, error: { code: "ERR", message: "Error" } } };
}

/** Render a component wrapped in GlobalLoaderProvider + AuthProvider */
function renderWithAuth(
    ui: ReactElement,
    config: AuthConfig = { basePath: "/api/auth" },
) {
    return render(
        <GlobalLoaderProvider>
            <AuthProvider config={config}>{ui}</AuthProvider>
        </GlobalLoaderProvider>,
    );
}

/** Consumer component that exposes auth state via test IDs */
function AuthConsumer() {
    const auth = useAuth();
    return (
        <div>
            <span data-testid="is-authenticated">
                {String(auth.isAuthenticated)}
            </span>
            <span data-testid="is-loading">{String(auth.isLoading)}</span>
            <span data-testid="user-sub">{auth.user?.sub ?? "null"}</span>
            <span data-testid="expires-at">
                {auth.expiresAt !== null ? String(auth.expiresAt) : "null"}
            </span>
            <button
                data-testid="login-btn"
                onClick={() => auth.login("/dashboard")}
            />
            <button
                data-testid="login-default-btn"
                onClick={() => auth.login()}
            />
            <button data-testid="logout-btn" onClick={() => void auth.logout()} />
            <button
                data-testid="refresh-btn"
                onClick={() => void auth.refresh()}
            />
        </div>
    );
}

/** Consumer that tracks GlobalLoader visibility */
function LoaderSpy() {
    const { visible } = useGlobalLoader();
    return <span data-testid="loader-visible">{String(visible)}</span>;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;
let locationHrefSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
    originalFetch = globalThis.fetch;

    // Spy on window.location.href assignment
    locationHrefSpy = vi.fn();
    Object.defineProperty(window, "location", {
        writable: true,
        value: { ...window.location, href: "", pathname: "/" },
    });
    Object.defineProperty(window.location, "href", {
        set: locationHrefSpy,
        get: () => "",
        configurable: true,
    });
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// AP-1: Mount — successful session
// ---------------------------------------------------------------------------
describe("AuthProvider", () => {
    it("AP-1: sets authenticated state on successful /me response", async () => {
        const expiresAt = Math.floor(Date.now() / 1000) + 3600;
        vi.stubGlobal(
            "fetch",
            mockFetch({
                [`GET /api/auth/me`]: makeMeResponse(TEST_USER, expiresAt),
            }),
        );

        renderWithAuth(
            <>
                <AuthConsumer />
                <LoaderSpy />
            </>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("is-loading").textContent).toBe("false");
        });

        expect(screen.getByTestId("is-authenticated").textContent).toBe("true");
        expect(screen.getByTestId("user-sub").textContent).toBe("user-123");
        expect(screen.getByTestId("expires-at").textContent).toBe(
            String(expiresAt),
        );
        // Loader should be hidden after mount
        expect(screen.getByTestId("loader-visible").textContent).toBe("false");
    });

    // -----------------------------------------------------------------------
    // AP-2: Mount — no session (401)
    // -----------------------------------------------------------------------
    it("AP-2: sets unauthenticated on 401 /me response", async () => {
        vi.stubGlobal(
            "fetch",
            mockFetch({ [`GET /api/auth/me`]: makeErrorResponse(401) }),
        );

        renderWithAuth(<AuthConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-loading").textContent).toBe("false");
        });

        expect(screen.getByTestId("is-authenticated").textContent).toBe(
            "false",
        );
        expect(screen.getByTestId("user-sub").textContent).toBe("null");
    });

    // -----------------------------------------------------------------------
    // AP-3: Mount — network error
    // -----------------------------------------------------------------------
    it("AP-3: handles /me network error gracefully", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(() => Promise.reject(new Error("Network down"))),
        );

        renderWithAuth(
            <>
                <AuthConsumer />
                <LoaderSpy />
            </>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("is-loading").textContent).toBe("false");
        });

        expect(screen.getByTestId("is-authenticated").textContent).toBe(
            "false",
        );
        expect(screen.getByTestId("loader-visible").textContent).toBe("false");
    });

    // -----------------------------------------------------------------------
    // AP-4: Mount — missing sub claim
    // -----------------------------------------------------------------------
    it("AP-4: treats user without sub as unauthenticated", async () => {
        vi.stubGlobal(
            "fetch",
            mockFetch({
                [`GET /api/auth/me`]: makeMeResponse(
                    { name: "No Sub User" }, // missing sub
                    9999999999,
                ),
            }),
        );

        renderWithAuth(<AuthConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-loading").textContent).toBe("false");
        });

        expect(screen.getByTestId("is-authenticated").textContent).toBe(
            "false",
        );
        expect(screen.getByTestId("user-sub").textContent).toBe("null");
    });

    // -----------------------------------------------------------------------
    // AP-5: login() function
    // -----------------------------------------------------------------------
    it("AP-5: login() redirects to BFF login URL with returnTo", async () => {
        vi.stubGlobal(
            "fetch",
            mockFetch({ [`GET /api/auth/me`]: makeErrorResponse(401) }),
        );

        renderWithAuth(<AuthConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-loading").textContent).toBe("false");
        });

        act(() => {
            screen.getByTestId("login-btn").click();
        });

        expect(locationHrefSpy).toHaveBeenCalledWith(
            "/api/auth/login?returnTo=%2Fdashboard",
        );
    });

    // -----------------------------------------------------------------------
    // AP-6: login() default returnTo
    // -----------------------------------------------------------------------
    it("AP-6: login() uses defaultReturnTo when no arg provided", async () => {
        vi.stubGlobal(
            "fetch",
            mockFetch({ [`GET /api/auth/me`]: makeErrorResponse(401) }),
        );

        renderWithAuth(<AuthConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-loading").textContent).toBe("false");
        });

        act(() => {
            screen.getByTestId("login-default-btn").click();
        });

        expect(locationHrefSpy).toHaveBeenCalledWith(
            `/api/auth/login?returnTo=${encodeURIComponent(AUTH_DEFAULTS.defaultReturnTo)}`,
        );
    });

    // -----------------------------------------------------------------------
    // AP-7: logout() function
    // -----------------------------------------------------------------------
    it("AP-7: logout() calls BFF and clears state", async () => {
        const expiresAt = Math.floor(Date.now() / 1000) + 3600;
        const fetchMock = mockFetch({
            [`GET /api/auth/me`]: makeMeResponse(TEST_USER, expiresAt),
            [`POST /api/auth/logout`]: { status: 200, body: { success: true } },
        });
        vi.stubGlobal("fetch", fetchMock);

        renderWithAuth(<AuthConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe(
                "true",
            );
        });

        await act(async () => {
            screen.getByTestId("logout-btn").click();
        });

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe(
                "false",
            );
        });

        // Verify logout was called with credentials: include
        const logoutCall = fetchMock.mock.calls.find(
            (c: [string | URL | Request, RequestInit | undefined]) =>
                typeof c[0] === "string" && c[0].includes("/logout"),
        );
        expect(logoutCall).toBeDefined();
        expect(logoutCall![1]?.credentials).toBe("include");
    });

    // -----------------------------------------------------------------------
    // AP-8: refresh() success
    // -----------------------------------------------------------------------
    it("AP-8: refresh() updates expiresAt on success", async () => {
        const initialExpiry = Math.floor(Date.now() / 1000) + 3600;
        const newExpiry = Math.floor(Date.now() / 1000) + 7200;

        vi.stubGlobal(
            "fetch",
            mockFetch({
                [`GET /api/auth/me`]: makeMeResponse(TEST_USER, initialExpiry),
                [`POST /api/auth/refresh`]: {
                    status: 200,
                    body: { success: true, data: { expiresAt: newExpiry } },
                },
            }),
        );

        renderWithAuth(<AuthConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe(
                "true",
            );
        });

        await act(async () => {
            screen.getByTestId("refresh-btn").click();
        });

        await waitFor(() => {
            expect(screen.getByTestId("expires-at").textContent).toBe(
                String(newExpiry),
            );
        });
    });

    // -----------------------------------------------------------------------
    // AP-9: refresh() failure (401)
    // -----------------------------------------------------------------------
    it("AP-9: refresh() clears state on 401", async () => {
        const initialExpiry = Math.floor(Date.now() / 1000) + 3600;

        vi.stubGlobal(
            "fetch",
            mockFetch({
                [`GET /api/auth/me`]: makeMeResponse(TEST_USER, initialExpiry),
                [`POST /api/auth/refresh`]: makeErrorResponse(401),
            }),
        );

        renderWithAuth(<AuthConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe(
                "true",
            );
        });

        await act(async () => {
            screen.getByTestId("refresh-btn").click();
        });

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe(
                "false",
            );
        });
    });

    // -----------------------------------------------------------------------
    // AP-10: Auto-refresh scheduling
    // -----------------------------------------------------------------------
    it("AP-10: schedules auto-refresh before expiry", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        const now = Math.floor(Date.now() / 1000);
        const expiresAt = now + 120; // expires in 2 minutes
        const newExpiry = now + 240;

        const fetchMock = mockFetch({
            [`GET /api/auth/me`]: makeMeResponse(TEST_USER, expiresAt),
            [`POST /api/auth/refresh`]: {
                status: 200,
                body: { success: true, data: { expiresAt: newExpiry } },
            },
        });
        vi.stubGlobal("fetch", fetchMock);

        renderWithAuth(<AuthConsumer />);

        // Wait for mount /me to resolve
        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe(
                "true",
            );
        });

        // Advance time to the refresh window (expiresAt - refreshLeadTime)
        // refreshLeadTime defaults to 60s, so refresh should happen at expiresAt - 60 = now + 60
        const refreshDelayMs = (expiresAt - AUTH_DEFAULTS.refreshLeadTime - now) * 1000;
        await act(async () => {
            vi.advanceTimersByTime(refreshDelayMs + 100);
        });

        // The refresh endpoint should have been called
        await waitFor(() => {
            const refreshCalls = fetchMock.mock.calls.filter(
                (c: [string | URL | Request, RequestInit | undefined]) =>
                    typeof c[0] === "string" && c[0].includes("/refresh"),
            );
            expect(refreshCalls.length).toBeGreaterThanOrEqual(1);
        });

        vi.useRealTimers();
    });

    // -----------------------------------------------------------------------
    // AP-11: Auto-refresh disabled (null expiresAt)
    // -----------------------------------------------------------------------
    it("AP-11: does not schedule refresh when expiresAt is null", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        // /me returns user but no expiresAt
        const fetchMock = mockFetch({
            [`GET /api/auth/me`]: makeMeResponse(TEST_USER), // no expiresAt
        });
        vi.stubGlobal("fetch", fetchMock);

        renderWithAuth(<AuthConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe(
                "true",
            );
        });

        // Advance timers significantly — no refresh should fire
        await act(async () => {
            vi.advanceTimersByTime(300_000);
        });

        // Only the initial /me call, no refresh calls
        const refreshCalls = fetchMock.mock.calls.filter(
            (c: [string | URL | Request, RequestInit | undefined]) =>
                typeof c[0] === "string" && c[0].includes("/refresh"),
        );
        expect(refreshCalls.length).toBe(0);

        vi.useRealTimers();
    });

    // -----------------------------------------------------------------------
    // AP-12: Tab visibility — expired triggers refresh
    // -----------------------------------------------------------------------
    it("AP-12: refreshes on tab visibility when past refresh threshold", async () => {
        const now = Math.floor(Date.now() / 1000);
        // Set expiresAt so that the refresh threshold has already passed
        const expiresAt = now + 30; // 30s left, which is < refreshLeadTime (60s)
        const newExpiry = now + 3600;

        const fetchMock = mockFetch({
            [`GET /api/auth/me`]: makeMeResponse(TEST_USER, expiresAt),
            [`POST /api/auth/refresh`]: {
                status: 200,
                body: { success: true, data: { expiresAt: newExpiry } },
            },
        });
        vi.stubGlobal("fetch", fetchMock);

        // Disable autoRefresh so the visibility handler is the only trigger
        renderWithAuth(<AuthConsumer />, {
            basePath: "/api/auth",
            autoRefresh: false,
        });

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe(
                "true",
            );
        });

        // Only the /me call should have been made (no auto-refresh)
        const refreshCallsBefore = fetchMock.mock.calls.filter(
            (c: [string | URL | Request, RequestInit | undefined]) =>
                typeof c[0] === "string" && c[0].includes("/refresh"),
        );
        expect(refreshCallsBefore.length).toBe(0);

        // Simulate tab becoming visible
        Object.defineProperty(document, "visibilityState", {
            value: "visible",
            writable: true,
            configurable: true,
        });
        act(() => {
            document.dispatchEvent(new Event("visibilitychange"));
        });

        // The visibility handler should trigger a refresh
        await waitFor(() => {
            const refreshCalls = fetchMock.mock.calls.filter(
                (c: [string | URL | Request, RequestInit | undefined]) =>
                    typeof c[0] === "string" && c[0].includes("/refresh"),
            );
            expect(refreshCalls.length).toBeGreaterThanOrEqual(1);
        });
    });

    // -----------------------------------------------------------------------
    // AP-13: Nesting detection
    // -----------------------------------------------------------------------
    it("AP-13: throws when AuthProvider is nested", () => {
        vi.stubGlobal(
            "fetch",
            mockFetch({ [`GET /api/auth/me`]: makeErrorResponse(401) }),
        );

        // Suppress React error boundary console output
        const consoleSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});

        expect(() => {
            render(
                <GlobalLoaderProvider>
                    <AuthProvider config={{ basePath: "/api/auth" }}>
                        <AuthProvider config={{ basePath: "/api/auth" }}>
                            <div>nested</div>
                        </AuthProvider>
                    </AuthProvider>
                </GlobalLoaderProvider>,
            );
        }).toThrow("cannot be nested");

        consoleSpy.mockRestore();
    });

    // -----------------------------------------------------------------------
    // AP-14: Custom config
    // -----------------------------------------------------------------------
    it("AP-14: uses custom basePath and endpoint config", async () => {
        const fetchMock = mockFetch({
            [`GET /custom/auth/session`]: makeMeResponse(TEST_USER, 9999999999),
        });
        vi.stubGlobal("fetch", fetchMock);

        renderWithAuth(<AuthConsumer />, {
            basePath: "/custom/auth",
            endpoints: { me: "/session" },
        });

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe(
                "true",
            );
        });

        // Verify the custom URL was called
        expect(fetchMock).toHaveBeenCalledWith(
            "/custom/auth/session",
            expect.objectContaining({ credentials: "include" }),
        );
    });

    // -----------------------------------------------------------------------
    // AP-15: Cleanup — AbortController
    // -----------------------------------------------------------------------
    it("AP-15: aborts fetch on unmount", async () => {
        let abortSignal: AbortSignal | undefined;

        vi.stubGlobal(
            "fetch",
            vi.fn((_url: string, options?: RequestInit) => {
                abortSignal = options?.signal ?? undefined;
                // Return a promise that never resolves (simulates slow network)
                return new Promise(() => {});
            }),
        );

        const { unmount } = renderWithAuth(<AuthConsumer />);

        // Unmount immediately
        unmount();

        // The abort signal should have been triggered
        expect(abortSignal?.aborted).toBe(true);
    });

    // -----------------------------------------------------------------------
    // AP-16: Resolved config exposed
    // -----------------------------------------------------------------------
    it("AP-16: exposes resolved config with defaults merged", async () => {
        vi.stubGlobal(
            "fetch",
            mockFetch({ [`GET /api/auth/me`]: makeErrorResponse(401) }),
        );

        function ConfigChecker() {
            const { config } = useAuth();
            return (
                <div>
                    <span data-testid="cfg-base">{config.basePath}</span>
                    <span data-testid="cfg-login">{config.endpoints.login}</span>
                    <span data-testid="cfg-me">{config.endpoints.me}</span>
                    <span data-testid="cfg-refresh">
                        {config.endpoints.refresh}
                    </span>
                    <span data-testid="cfg-loginPath">{config.loginPath}</span>
                    <span data-testid="cfg-autoRefresh">
                        {String(config.autoRefresh)}
                    </span>
                    <span data-testid="cfg-leadTime">
                        {String(config.refreshLeadTime)}
                    </span>
                </div>
            );
        }

        renderWithAuth(<ConfigChecker />);

        await waitFor(() => {
            expect(screen.getByTestId("cfg-base").textContent).toBe(
                "/api/auth",
            );
        });

        expect(screen.getByTestId("cfg-login").textContent).toBe("/login");
        expect(screen.getByTestId("cfg-me").textContent).toBe("/me");
        expect(screen.getByTestId("cfg-refresh").textContent).toBe("/refresh");
        expect(screen.getByTestId("cfg-loginPath").textContent).toBe("/login");
        expect(screen.getByTestId("cfg-autoRefresh").textContent).toBe("true");
        expect(screen.getByTestId("cfg-leadTime").textContent).toBe("60");
    });
});
