// @vitest-environment jsdom

/**
 * Auth CSRF specification suite.
 *
 * Covers the BFF CSRF contract for logout and refresh, the session token
 * surfaced by `/me` and `/refresh`, and the `authorized` / `csrfToken` values
 * exposed by `useAuth()`. The expectations come from the server contract, not
 * from the implementation, so a failure here means the implementation is wrong.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { GlobalLoaderProvider } from "../src/global-loader/index.js";
import {
    AUTH_DEFAULTS,
    AuthProvider,
    useAuth,
    type AuthConfig,
} from "../src/auth/index.js";
import type { ReactElement } from "react";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** One mocked route: HTTP status plus JSON body. */
interface MockRoute {
    status: number;
    body: unknown;
}

/** A recorded fetch invocation. */
type FetchCall = [string | URL | Request, RequestInit | undefined];

/**
 * Build a fetch double that routes by "METHOD url" and records every call,
 * including its RequestInit, so header and credentials can be asserted.
 */
function mockFetch(responses: Record<string, MockRoute>) {
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

type FetchMock = ReturnType<typeof mockFetch>;

/** Standard user object for tests. */
const TEST_USER = { sub: "user-123", name: "Alice", email: "alice@test.com" };

/** Find the recorded call for a method and URL fragment. */
function findCall(
    fetchMock: FetchMock,
    method: string,
    urlPart: string,
): FetchCall | undefined {
    return fetchMock.mock.calls.find((call: FetchCall) => {
        const [url, options] = call;
        const urlStr = typeof url === "string" ? url : url.toString();
        return (options?.method ?? "GET") === method && urlStr.includes(urlPart);
    });
}

/** Read a header from a recorded call, tolerating the HeadersInit shapes. */
function getHeader(call: FetchCall | undefined, name: string): string | null {
    const headers = call?.[1]?.headers;
    if (!headers) {
        return null;
    }
    if (headers instanceof Headers) {
        return headers.get(name);
    }
    if (Array.isArray(headers)) {
        const entry = headers.find(
            ([key]) => key.toLowerCase() === name.toLowerCase(),
        );
        return entry ? entry[1] : null;
    }
    const key = Object.keys(headers).find(
        (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    return key === undefined ? null : headers[key];
}

/** Render undefined distinctly so a missing field cannot look like null. */
function formatValue(value: unknown): string {
    if (value === undefined) {
        return "<missing>";
    }
    if (value === null) {
        return "null";
    }
    return String(value);
}

/** Consumer component that exposes auth state via test IDs. */
function AuthStateConsumer() {
    const auth = useAuth();
    return (
        <div>
            <span data-testid="is-authenticated">
                {String(auth.isAuthenticated)}
            </span>
            <span data-testid="is-loading">{String(auth.isLoading)}</span>
            <span data-testid="authorized">{formatValue(auth.authorized)}</span>
            <span data-testid="csrf-token">{formatValue(auth.csrfToken)}</span>
            <span data-testid="user-sub">{auth.user?.sub ?? "null"}</span>
            <span data-testid="expires-at">{formatValue(auth.expiresAt)}</span>
            <button data-testid="logout-btn" onClick={() => void auth.logout()} />
            <button
                data-testid="refresh-btn"
                onClick={() => void auth.refresh()}
            />
        </div>
    );
}

/** Consumer component that exposes the resolved CSRF header name. */
function CsrfHeaderConsumer() {
    const { config } = useAuth();
    return (
        <span data-testid="csrf-header">
            {formatValue(config.csrfHeader)}
        </span>
    );
}

/** Render a component wrapped in GlobalLoaderProvider + AuthProvider. */
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

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
    originalFetch = globalThis.fetch;

    // Protect against navigation side effects if logout redirects.
    Object.defineProperty(window, "location", {
        writable: true,
        value: { ...window.location, href: "", pathname: "/" },
    });
    Object.defineProperty(window.location, "href", {
        set: () => {},
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
// Spec cases
// ---------------------------------------------------------------------------

describe("auth CSRF contract", () => {
    // After a successful session load, logging out must prove possession of
    // the session CSRF token and then drop any local session state.
    it("sends the session CSRF token on logout, then clears authentication state", async () => {
        const fetchMock = mockFetch({
            [`GET /api/auth/me`]: {
                status: 200,
                body: {
                    success: true,
                    data: {
                        user: TEST_USER,
                        authorized: true,
                        csrfToken: "tok-1",
                    },
                },
            },
            [`POST /api/auth/logout`]: {
                status: 200,
                body: { success: true, data: { message: "logged out" } },
            },
        });
        vi.stubGlobal("fetch", fetchMock);

        renderWithAuth(<AuthStateConsumer />);

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

        const logoutCall = findCall(fetchMock, "POST", "/logout");
        expect(logoutCall).toBeDefined();
        expect(logoutCall?.[1]?.credentials).toBe("include");
        expect(getHeader(logoutCall, "x-csrf-token")).toBe("tok-1");

        expect(screen.getByTestId("authorized").textContent).toBe("false");
        expect(screen.getByTestId("csrf-token").textContent).toBe("null");
    });

    // Refreshing must present the CSRF token the session already holds, and
    // any token returned by the server becomes the new session token.
    it("sends the session CSRF token on refresh and stores the rotated token", async () => {
        const initialExpiry = Math.floor(Date.now() / 1000) + 3600;
        const newExpiry = initialExpiry + 3600;

        const fetchMock = mockFetch({
            [`GET /api/auth/me`]: {
                status: 200,
                body: {
                    success: true,
                    data: {
                        user: TEST_USER,
                        expiresAt: initialExpiry,
                        authorized: true,
                        csrfToken: "tok-1",
                    },
                },
            },
            [`POST /api/auth/refresh`]: {
                status: 200,
                body: {
                    success: true,
                    data: {
                        expiresAt: newExpiry,
                        message: "refreshed",
                        csrfToken: "tok-2",
                    },
                },
            },
        });
        vi.stubGlobal("fetch", fetchMock);

        renderWithAuth(<AuthStateConsumer />);

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

        const refreshCall = findCall(fetchMock, "POST", "/refresh");
        expect(refreshCall).toBeDefined();
        expect(getHeader(refreshCall, "x-csrf-token")).toBe("tok-1");

        expect(screen.getByTestId("csrf-token").textContent).toBe("tok-2");
    });

    // When the server issues no CSRF token, logout and refresh must stay
    // header-free while still clearing state and updating expiry as usual.
    it("omits the CSRF header when the session has no token", async () => {
        const initialExpiry = Math.floor(Date.now() / 1000) + 3600;
        const newExpiry = initialExpiry + 3600;

        const fetchMock = mockFetch({
            [`GET /api/auth/me`]: {
                status: 200,
                body: {
                    success: true,
                    data: {
                        user: TEST_USER,
                        expiresAt: initialExpiry,
                        authorized: true,
                    },
                },
            },
            [`POST /api/auth/refresh`]: {
                status: 200,
                body: {
                    success: true,
                    data: { expiresAt: newExpiry, message: "refreshed" },
                },
            },
            [`POST /api/auth/logout`]: {
                status: 200,
                body: { success: true, data: { message: "logged out" } },
            },
        });
        vi.stubGlobal("fetch", fetchMock);

        renderWithAuth(<AuthStateConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe(
                "true",
            );
        });

        expect(screen.getByTestId("csrf-token").textContent).toBe("null");

        await act(async () => {
            screen.getByTestId("refresh-btn").click();
        });

        await waitFor(() => {
            expect(screen.getByTestId("expires-at").textContent).toBe(
                String(newExpiry),
            );
        });

        const refreshCall = findCall(fetchMock, "POST", "/refresh");
        expect(refreshCall).toBeDefined();
        expect(getHeader(refreshCall, "x-csrf-token")).toBeNull();

        await act(async () => {
            screen.getByTestId("logout-btn").click();
        });

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe(
                "false",
            );
        });

        const logoutCall = findCall(fetchMock, "POST", "/logout");
        expect(logoutCall).toBeDefined();
        expect(getHeader(logoutCall, "x-csrf-token")).toBeNull();

        expect(screen.getByTestId("authorized").textContent).toBe("false");
        expect(screen.getByTestId("csrf-token").textContent).toBe("null");
    });

    // A configured header name must replace the default on outgoing requests,
    // so the default header must not appear at all.
    it("sends the token under a configured custom CSRF header", async () => {
        const fetchMock = mockFetch({
            [`GET /api/auth/me`]: {
                status: 200,
                body: {
                    success: true,
                    data: {
                        user: TEST_USER,
                        authorized: true,
                        csrfToken: "tok-1",
                    },
                },
            },
            [`POST /api/auth/logout`]: {
                status: 200,
                body: { success: true, data: { message: "logged out" } },
            },
        });
        vi.stubGlobal("fetch", fetchMock);

        renderWithAuth(<AuthStateConsumer />, {
            basePath: "/api/auth",
            csrfHeader: "x-xsrf-token",
        });

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

        const logoutCall = findCall(fetchMock, "POST", "/logout");
        expect(logoutCall).toBeDefined();
        expect(getHeader(logoutCall, "x-xsrf-token")).toBe("tok-1");
        expect(getHeader(logoutCall, "x-csrf-token")).toBeNull();
    });

    // A session can be authenticated while not authorized for protected work,
    // and the user identity must still be exposed.
    it("exposes a false authorized flag from the /me response", async () => {
        vi.stubGlobal(
            "fetch",
            mockFetch({
                [`GET /api/auth/me`]: {
                    status: 200,
                    body: {
                        success: true,
                        data: { user: TEST_USER, authorized: false },
                    },
                },
            }),
        );

        renderWithAuth(<AuthStateConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe(
                "true",
            );
        });

        expect(screen.getByTestId("user-sub").textContent).toBe("user-123");
        expect(screen.getByTestId("authorized").textContent).toBe("false");
    });

    // Sessions created before the authorized flag existed default to true so
    // they are not locked out.
    it("treats a legacy session without authorized as authorized", async () => {
        vi.stubGlobal(
            "fetch",
            mockFetch({
                [`GET /api/auth/me`]: {
                    status: 200,
                    body: {
                        success: true,
                        data: { user: TEST_USER },
                    },
                },
            }),
        );

        renderWithAuth(<AuthStateConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe(
                "true",
            );
        });

        expect(screen.getByTestId("authorized").textContent).toBe("true");
    });

    // A failed session probe must produce a safe, token-free state whether the
    // server answers 401 or the network itself fails.
    it("reports unauthenticated, unauthorized, and no token when /me fails", async () => {
        vi.stubGlobal(
            "fetch",
            mockFetch({
                [`GET /api/auth/me`]: {
                    status: 401,
                    body: {
                        success: false,
                        error: { code: "ERR", message: "no session" },
                    },
                },
            }),
        );

        const first = renderWithAuth(<AuthStateConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-loading").textContent).toBe("false");
        });

        expect(screen.getByTestId("is-authenticated").textContent).toBe(
            "false",
        );
        expect(screen.getByTestId("authorized").textContent).toBe("false");
        expect(screen.getByTestId("csrf-token").textContent).toBe("null");

        first.unmount();

        vi.stubGlobal(
            "fetch",
            vi.fn(() => Promise.reject(new Error("Network down"))),
        );

        renderWithAuth(<AuthStateConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-loading").textContent).toBe("false");
        });

        expect(screen.getByTestId("is-authenticated").textContent).toBe(
            "false",
        );
        expect(screen.getByTestId("authorized").textContent).toBe("false");
        expect(screen.getByTestId("csrf-token").textContent).toBe("null");
    });

    // The scheduled auto-refresh must authenticate itself with the token held
    // by the session and pick up any replacement token from the response.
    it("sends the current CSRF token when auto-refresh fires and stores the new one", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        const now = Math.floor(Date.now() / 1000);
        const expiresAt = now + 120;
        const newExpiry = now + 3600;

        const fetchMock = mockFetch({
            [`GET /api/auth/me`]: {
                status: 200,
                body: {
                    success: true,
                    data: {
                        user: TEST_USER,
                        expiresAt,
                        authorized: true,
                        csrfToken: "tok-1",
                    },
                },
            },
            [`POST /api/auth/refresh`]: {
                status: 200,
                body: {
                    success: true,
                    data: {
                        expiresAt: newExpiry,
                        message: "refreshed",
                        csrfToken: "tok-2",
                    },
                },
            },
        });
        vi.stubGlobal("fetch", fetchMock);

        renderWithAuth(<AuthStateConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe(
                "true",
            );
        });

        const refreshDelayMs =
            (expiresAt - AUTH_DEFAULTS.refreshLeadTime - now) * 1000;
        await act(async () => {
            vi.advanceTimersByTime(refreshDelayMs + 100);
        });

        await waitFor(() => {
            expect(screen.getByTestId("expires-at").textContent).toBe(
                String(newExpiry),
            );
        });

        const refreshCall = findCall(fetchMock, "POST", "/refresh");
        expect(refreshCall).toBeDefined();
        expect(getHeader(refreshCall, "x-csrf-token")).toBe("tok-1");

        expect(screen.getByTestId("csrf-token").textContent).toBe("tok-2");

        vi.useRealTimers();
    });

    // Leaving csrfHeader unset must resolve to the documented default name.
    it("resolves csrfHeader to the default header name", async () => {
        vi.stubGlobal(
            "fetch",
            mockFetch({
                [`GET /api/auth/me`]: {
                    status: 401,
                    body: {
                        success: false,
                        error: { code: "ERR", message: "no session" },
                    },
                },
            }),
        );

        renderWithAuth(
            <>
                <AuthStateConsumer />
                <CsrfHeaderConsumer />
            </>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("is-loading").textContent).toBe("false");
        });

        expect(screen.getByTestId("csrf-header").textContent).toBe(
            "x-csrf-token",
        );
        expect(AUTH_DEFAULTS.csrfHeader).toBe("x-csrf-token");
    });
});
