// @vitest-environment jsdom

/**
 * Auth CSRF implementation suite.
 *
 * Covers the internals and edge cases behind the CSRF/session-state contract:
 * malformed `/me` values, refresh responses without a usable token, the
 * existing failure policies, ref freshness across a visibility refresh, and
 * token containment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { GlobalLoaderProvider } from "../src/global-loader/index.js";
import { AUTH_DEFAULTS, AuthProvider, useAuth, type AuthConfig } from "../src/auth/index.js";
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

/** Build a fetch double that routes by "METHOD url" and records every call. */
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
const TEST_USER = { sub: "user-123", name: "Alice" };

/** Find the recorded call for a method and URL fragment. */
function findCall(fetchMock: FetchMock, method: string, urlPart: string): FetchCall | undefined {
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
        const entry = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
        return entry ? entry[1] : null;
    }
    const key = Object.keys(headers).find(
        candidate => candidate.toLowerCase() === name.toLowerCase()
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
            <span data-testid="is-authenticated">{String(auth.isAuthenticated)}</span>
            <span data-testid="is-loading">{String(auth.isLoading)}</span>
            <span data-testid="authorized">{formatValue(auth.authorized)}</span>
            <span data-testid="csrf-token">{formatValue(auth.csrfToken)}</span>
            <span data-testid="expires-at">{formatValue(auth.expiresAt)}</span>
            <span data-testid="csrf-header">{formatValue(auth.config.csrfHeader)}</span>
            <button data-testid="logout-btn" onClick={() => void auth.logout()} />
            <button data-testid="refresh-btn" onClick={() => void auth.refresh()} />
        </div>
    );
}

/** Render a component wrapped in GlobalLoaderProvider + AuthProvider. */
function renderWithAuth(ui: ReactElement, config: AuthConfig = { basePath: "/api/auth" }) {
    return render(
        <GlobalLoaderProvider>
            <AuthProvider config={config}>{ui}</AuthProvider>
        </GlobalLoaderProvider>
    );
}

/** Build a `/me` route body with the given data overrides. */
function makeMeBody(data: Record<string, unknown>) {
    return { status: 200, body: { success: true, data } };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
    originalFetch = globalThis.fetch;

    Object.defineProperty(window, "location", {
        writable: true,
        value: { ...window.location, href: "", pathname: "/" },
    });
    Object.defineProperty(window.location, "href", {
        set: () => {},
        get: () => "",
        configurable: true,
    });
    Object.defineProperty(document, "visibilityState", {
        value: "visible",
        writable: true,
        configurable: true,
    });
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Implementation cases
// ---------------------------------------------------------------------------

describe("auth CSRF internals", () => {
    // A present non-boolean authorization flag fails closed, and a token that
    // is not a non-empty string is discarded instead of being forwarded.
    it("rejects malformed authorized and csrfToken values from /me", async () => {
        vi.stubGlobal(
            "fetch",
            mockFetch({
                [`GET /api/auth/me`]: makeMeBody({
                    user: TEST_USER,
                    authorized: "true",
                    csrfToken: 123,
                }),
            })
        );

        const first = renderWithAuth(<AuthStateConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe("true");
        });

        expect(screen.getByTestId("authorized").textContent).toBe("false");
        expect(screen.getByTestId("csrf-token").textContent).toBe("null");

        first.unmount();

        vi.stubGlobal(
            "fetch",
            mockFetch({
                [`GET /api/auth/me`]: makeMeBody({
                    user: TEST_USER,
                    authorized: 0,
                    csrfToken: "",
                }),
            })
        );

        renderWithAuth(<AuthStateConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe("true");
        });

        expect(screen.getByTestId("authorized").textContent).toBe("false");
        expect(screen.getByTestId("csrf-token").textContent).toBe("null");
    });

    // A refresh that carries no token does not invalidate the token the
    // session already holds.
    it("keeps the previous token when refresh returns no csrfToken", async () => {
        const newExpiry = Math.floor(Date.now() / 1000) + 7200;
        const fetchMock = mockFetch({
            [`GET /api/auth/me`]: makeMeBody({
                user: TEST_USER,
                authorized: true,
                csrfToken: "tok-1",
            }),
            [`POST /api/auth/refresh`]: {
                status: 200,
                body: {
                    success: true,
                    data: { expiresAt: newExpiry, message: "refreshed" },
                },
            },
        });
        vi.stubGlobal("fetch", fetchMock);

        renderWithAuth(<AuthStateConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe("true");
        });

        await act(async () => {
            screen.getByTestId("refresh-btn").click();
        });

        await waitFor(() => {
            expect(screen.getByTestId("expires-at").textContent).toBe(String(newExpiry));
        });

        expect(screen.getByTestId("csrf-token").textContent).toBe("tok-1");
    });

    // A non-string replacement token is ignored for the same reason.
    it("keeps the previous token when refresh returns a malformed csrfToken", async () => {
        const fetchMock = mockFetch({
            [`GET /api/auth/me`]: makeMeBody({
                user: TEST_USER,
                authorized: true,
                csrfToken: "tok-1",
            }),
            [`POST /api/auth/refresh`]: {
                status: 200,
                body: {
                    success: true,
                    data: { message: "refreshed", csrfToken: 123 },
                },
            },
        });
        vi.stubGlobal("fetch", fetchMock);

        renderWithAuth(<AuthStateConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe("true");
        });

        await act(async () => {
            screen.getByTestId("refresh-btn").click();
        });

        await waitFor(() => {
            expect(findCall(fetchMock, "POST", "/refresh")).toBeDefined();
        });

        expect(screen.getByTestId("csrf-token").textContent).toBe("tok-1");
    });

    // A rejected refresh keeps the session so a transient authorization
    // response cannot sign the user out.
    it("keeps state when refresh answers 403", async () => {
        const fetchMock = mockFetch({
            [`GET /api/auth/me`]: makeMeBody({
                user: TEST_USER,
                authorized: true,
                csrfToken: "tok-1",
            }),
            [`POST /api/auth/refresh`]: {
                status: 403,
                body: {
                    success: false,
                    error: { code: "csrf_invalid", message: "invalid token" },
                },
            },
        });
        vi.stubGlobal("fetch", fetchMock);

        renderWithAuth(<AuthStateConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe("true");
        });

        await act(async () => {
            screen.getByTestId("refresh-btn").click();
        });

        await waitFor(() => {
            expect(findCall(fetchMock, "POST", "/refresh")).toBeDefined();
        });

        const refreshCall = findCall(fetchMock, "POST", "/refresh");
        expect(getHeader(refreshCall, "x-csrf-token")).toBe("tok-1");
        expect(screen.getByTestId("is-authenticated").textContent).toBe("true");
        expect(screen.getByTestId("authorized").textContent).toBe("true");
        expect(screen.getByTestId("csrf-token").textContent).toBe("tok-1");
    });

    // A 401 from refresh is an auth failure: every session field resets.
    it("clears all session fields when refresh answers 401", async () => {
        vi.stubGlobal(
            "fetch",
            mockFetch({
                [`GET /api/auth/me`]: makeMeBody({
                    user: TEST_USER,
                    authorized: false,
                    csrfToken: "tok-1",
                }),
                [`POST /api/auth/refresh`]: {
                    status: 401,
                    body: {
                        success: false,
                        error: { code: "no_session", message: "no session" },
                    },
                },
            })
        );

        renderWithAuth(<AuthStateConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe("true");
        });

        await act(async () => {
            screen.getByTestId("refresh-btn").click();
        });

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe("false");
        });

        expect(screen.getByTestId("authorized").textContent).toBe("false");
        expect(screen.getByTestId("csrf-token").textContent).toBe("null");
        expect(screen.getByTestId("expires-at").textContent).toBe("null");
    });

    // Even a server-side logout failure clears the local session, matching
    // the documented sign-out behavior.
    it("clears local state when logout answers 500", async () => {
        vi.stubGlobal(
            "fetch",
            mockFetch({
                [`GET /api/auth/me`]: makeMeBody({
                    user: TEST_USER,
                    authorized: true,
                    csrfToken: "tok-1",
                }),
                [`POST /api/auth/logout`]: {
                    status: 500,
                    body: {
                        success: false,
                        error: { code: "server_error", message: "boom" },
                    },
                },
            })
        );

        renderWithAuth(<AuthStateConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe("true");
        });

        await act(async () => {
            screen.getByTestId("logout-btn").click();
        });

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe("false");
        });

        expect(screen.getByTestId("authorized").textContent).toBe("false");
        expect(screen.getByTestId("csrf-token").textContent).toBe("null");
    });

    // A dropped network connection during logout must not strand the user in
    // a signed-in-looking state.
    it("clears local state when logout rejects with a network error", async () => {
        const fetchMock = vi.fn(
            (url: string | URL | Request, options?: RequestInit) => {
                void url;
                const method = options?.method ?? "GET";
                if (method === "GET") {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: () =>
                            Promise.resolve({
                                success: true,
                                data: {
                                    user: TEST_USER,
                                    authorized: true,
                                    csrfToken: "tok-1",
                                },
                            }),
                    } as Response);
                }
                return Promise.reject(new Error("Network down"));
            },
        );
        vi.stubGlobal("fetch", fetchMock);

        renderWithAuth(<AuthStateConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe("true");
        });

        await act(async () => {
            screen.getByTestId("logout-btn").click();
        });

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe("false");
        });

        expect(screen.getByTestId("authorized").textContent).toBe("false");
        expect(screen.getByTestId("csrf-token").textContent).toBe("null");
        expect(screen.getByTestId("expires-at").textContent).toBe("null");
    });

    // The visibility handler must read the token through the ref so it uses
    // the latest replacement, not the one captured when the provider mounted.
    it("uses the latest token on a visibility-triggered refresh", async () => {
        const now = Math.floor(Date.now() / 1000);
        const fetchMock = mockFetch({
            [`GET /api/auth/me`]: makeMeBody({
                user: TEST_USER,
                expiresAt: now + 30,
                authorized: true,
                csrfToken: "tok-1",
            }),
            [`POST /api/auth/refresh`]: {
                status: 200,
                body: {
                    success: true,
                    data: {
                        expiresAt: now + 10,
                        message: "refreshed",
                        csrfToken: "tok-2",
                    },
                },
            },
        });
        vi.stubGlobal("fetch", fetchMock);

        renderWithAuth(<AuthStateConsumer />, {
            basePath: "/api/auth",
            autoRefresh: false,
        });

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe("true");
        });

        await act(async () => {
            screen.getByTestId("refresh-btn").click();
        });

        await waitFor(() => {
            expect(screen.getByTestId("csrf-token").textContent).toBe("tok-2");
        });

        act(() => {
            document.dispatchEvent(new Event("visibilitychange"));
        });

        await waitFor(() => {
            const refreshCalls = fetchMock.mock.calls.filter(
                (call: FetchCall) =>
                    (call[1]?.method ?? "GET") === "POST" && String(call[0]).includes("/refresh")
            );
            expect(refreshCalls.length).toBeGreaterThanOrEqual(2);
        });

        const refreshCalls = fetchMock.mock.calls.filter(
            (call: FetchCall) =>
                (call[1]?.method ?? "GET") === "POST" && String(call[0]).includes("/refresh")
        );
        expect(getHeader(refreshCalls[refreshCalls.length - 1], "x-csrf-token")).toBe("tok-2");
    });

    // The header name resolves from config with the documented default.
    it("resolves the configured and default CSRF header names", async () => {
        vi.stubGlobal(
            "fetch",
            mockFetch({
                [`GET /api/auth/me`]: {
                    status: 401,
                    body: {
                        success: false,
                        error: { code: "no_session", message: "none" },
                    },
                },
            })
        );

        const first = renderWithAuth(<AuthStateConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-loading").textContent).toBe("false");
        });

        expect(screen.getByTestId("csrf-header").textContent).toBe(AUTH_DEFAULTS.csrfHeader);

        first.unmount();

        renderWithAuth(<AuthStateConsumer />, {
            basePath: "/api/auth",
            csrfHeader: "x-xsrf-token",
        });

        await waitFor(() => {
            expect(screen.getByTestId("is-loading").textContent).toBe("false");
        });

        expect(screen.getByTestId("csrf-header").textContent).toBe("x-xsrf-token");
    });

    // A legacy session keeps working end to end without any CSRF header, and
    // logging out clears every session field.
    it("keeps a legacy session working and sends no header without a token", async () => {
        const newExpiry = Math.floor(Date.now() / 1000) + 7200;
        const fetchMock = mockFetch({
            [`GET /api/auth/me`]: makeMeBody({ user: TEST_USER }),
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
            expect(screen.getByTestId("is-authenticated").textContent).toBe("true");
        });

        expect(screen.getByTestId("authorized").textContent).toBe("true");
        expect(screen.getByTestId("csrf-token").textContent).toBe("null");

        await act(async () => {
            screen.getByTestId("refresh-btn").click();
        });

        await waitFor(() => {
            expect(screen.getByTestId("expires-at").textContent).toBe(String(newExpiry));
        });

        expect(getHeader(findCall(fetchMock, "POST", "/refresh"), "x-csrf-token")).toBeNull();

        await act(async () => {
            screen.getByTestId("logout-btn").click();
        });

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe("false");
        });

        expect(getHeader(findCall(fetchMock, "POST", "/logout"), "x-csrf-token")).toBeNull();
    });

    // A successful refresh carries no authorization field, so the flag from
    // the last /me response must survive it.
    it("keeps the authorized flag across a successful refresh", async () => {
        const newExpiry = Math.floor(Date.now() / 1000) + 7200;
        vi.stubGlobal(
            "fetch",
            mockFetch({
                [`GET /api/auth/me`]: makeMeBody({
                    user: TEST_USER,
                    authorized: false,
                    csrfToken: "tok-1",
                }),
                [`POST /api/auth/refresh`]: {
                    status: 200,
                    body: {
                        success: true,
                        data: { expiresAt: newExpiry, message: "refreshed" },
                    },
                },
            })
        );

        renderWithAuth(<AuthStateConsumer />);

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe("true");
        });

        expect(screen.getByTestId("authorized").textContent).toBe("false");

        await act(async () => {
            screen.getByTestId("refresh-btn").click();
        });

        await waitFor(() => {
            expect(screen.getByTestId("expires-at").textContent).toBe(String(newExpiry));
        });

        expect(screen.getByTestId("authorized").textContent).toBe("false");
    });

    // The token is confined to memory and to the two mutation requests: the
    // session probe stays header-free and nothing logs or persists it.
    it("contains the token to the mutation requests only", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

        const fetchMock = mockFetch({
            [`GET /api/auth/me`]: makeMeBody({
                user: TEST_USER,
                authorized: true,
                csrfToken: "tok-1",
            }),
            [`POST /api/auth/refresh`]: {
                status: 200,
                body: {
                    success: true,
                    data: { message: "refreshed", csrfToken: "tok-2" },
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
            expect(screen.getByTestId("is-authenticated").textContent).toBe("true");
        });

        await act(async () => {
            screen.getByTestId("refresh-btn").click();
        });

        await act(async () => {
            screen.getByTestId("logout-btn").click();
        });

        await waitFor(() => {
            expect(screen.getByTestId("is-authenticated").textContent).toBe("false");
        });

        const meCall = findCall(fetchMock, "GET", "/me");
        expect(meCall).toBeDefined();
        expect(meCall?.[1]?.headers).toBeUndefined();

        const recordedValues = [
            ...consoleSpy.mock.calls.flat(),
            ...warnSpy.mock.calls.flat(),
            ...logSpy.mock.calls.flat(),
            ...setItemSpy.mock.calls.flat(),
        ];
        expect(recordedValues).not.toContain("tok-1");
        expect(recordedValues).not.toContain("tok-2");
    });
});
