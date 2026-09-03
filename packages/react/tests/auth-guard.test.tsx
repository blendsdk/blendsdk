// @vitest-environment jsdom

/**
 * AuthGuard test suite — AG-1 through AG-3
 *
 * Tests use a mock AuthContext.Provider to inject controlled auth state,
 * bypassing the real AuthProvider's mount-time fetch logic.
 *
 * @see plans/react-auth/07-testing-strategy.md
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { AuthContext } from "../src/auth/auth-provider.js";
import { AuthGuard } from "../src/auth/auth-guard.js";
import type { AuthContextValue, ResolvedAuthConfig } from "../src/auth/auth-types.js";
import { AUTH_DEFAULTS } from "../src/auth/auth-defaults.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a complete AuthContextValue with overrides */
function makeAuthContext(
    overrides: Partial<AuthContextValue> = {},
): AuthContextValue {
    const defaultConfig: ResolvedAuthConfig = {
        basePath: "/api/auth",
        endpoints: { ...AUTH_DEFAULTS.endpoints },
        loginPath: AUTH_DEFAULTS.loginPath,
        defaultReturnTo: AUTH_DEFAULTS.defaultReturnTo,
        autoRefresh: AUTH_DEFAULTS.autoRefresh,
        refreshLeadTime: AUTH_DEFAULTS.refreshLeadTime,
    };

    return {
        user: null,
        isAuthenticated: false,
        isLoading: false,
        login: vi.fn(),
        logout: vi.fn(async () => {}),
        refresh: vi.fn(async () => true),
        expiresAt: null,
        config: defaultConfig,
        ...overrides,
    };
}

/** Render AuthGuard within a MemoryRouter with controlled auth state */
function renderAuthGuard(
    authState: Partial<AuthContextValue>,
    initialRoute = "/protected",
) {
    const ctx = makeAuthContext(authState);
    return render(
        <AuthContext.Provider value={ctx}>
            <MemoryRouter initialEntries={[initialRoute]}>
                <Routes>
                    <Route element={<AuthGuard />}>
                        <Route
                            path="/protected"
                            element={<div data-testid="protected">Protected Content</div>}
                        />
                    </Route>
                    <Route
                        path="/login"
                        element={<div data-testid="login-page">Login Page</div>}
                    />
                </Routes>
            </MemoryRouter>
        </AuthContext.Provider>,
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuthGuard", () => {
    // AG-1: Authenticated — renders Outlet
    it("AG-1: renders protected content when authenticated", () => {
        renderAuthGuard({
            isAuthenticated: true,
            isLoading: false,
            user: { sub: "user-123" },
        });

        expect(screen.getByTestId("protected").textContent).toBe(
            "Protected Content",
        );
        expect(screen.queryByTestId("login-page")).toBeNull();
    });

    // AG-2: Not authenticated — redirects to login
    it("AG-2: redirects to login when not authenticated", () => {
        renderAuthGuard({
            isAuthenticated: false,
            isLoading: false,
            user: null,
        });

        expect(screen.getByTestId("login-page").textContent).toBe(
            "Login Page",
        );
        expect(screen.queryByTestId("protected")).toBeNull();
    });

    // AG-3: Loading — returns null
    it("AG-3: renders nothing while loading", () => {
        const { container } = renderAuthGuard({
            isAuthenticated: false,
            isLoading: true,
            user: null,
        });

        expect(screen.queryByTestId("protected")).toBeNull();
        expect(screen.queryByTestId("login-page")).toBeNull();
        // The router root should be essentially empty (just the router wrapper)
        expect(container.textContent).toBe("");
    });
});
