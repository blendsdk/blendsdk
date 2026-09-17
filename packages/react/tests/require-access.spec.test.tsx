// @vitest-environment jsdom

/**
 * Specification tests for the route access guard.
 *
 * These tests describe how a route is protected: an authorized caller sees the
 * guarded content, an anonymous caller is sent to the login page with a way
 * back, a signed-in caller without the grant is sent to the not-authorized
 * page, and nothing renders while the session is still loading. They are
 * derived from the authorization requirements and written before the
 * implementation; a failing case means the implementation is wrong, never the
 * test.
 *
 * @packageDocumentation
 */

import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { AuthContext } from "../src/auth/auth-provider.js";
import { AUTH_DEFAULTS } from "../src/auth/auth-defaults.js";
import { RequireAccess } from "../src/index.js";
import type {
  AuthContextValue,
  ResolvedAuthConfig,
} from "../src/auth/auth-types.js";

/** Builds a complete auth context value with overrides. */
function makeAuthContext(
  overrides: Partial<AuthContextValue> = {}
): AuthContextValue {
  const config: ResolvedAuthConfig = {
    basePath: "/api/auth",
    endpoints: { ...AUTH_DEFAULTS.endpoints },
    loginPath: AUTH_DEFAULTS.loginPath,
    defaultReturnTo: AUTH_DEFAULTS.defaultReturnTo,
    autoRefresh: AUTH_DEFAULTS.autoRefresh,
    refreshLeadTime: AUTH_DEFAULTS.refreshLeadTime,
    notAuthorizedPath: AUTH_DEFAULTS.notAuthorizedPath,
  };

  return {
    user: null,
    isAuthenticated: false,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(async () => {}),
    refresh: vi.fn(async () => true),
    expiresAt: null,
    config,
    ...overrides,
  };
}

/** Reads the `returnTo` value from router location state, if present. */
function readReturnTo(state: unknown): string {
  if (typeof state === "object" && state !== null && "returnTo" in state) {
    const value = state.returnTo;
    return typeof value === "string" ? value : "";
  }
  return "";
}

/** Renders the current path and its `returnTo` state for redirect assertions. */
function LocationProbe({ id }: { id: string }) {
  const location = useLocation();

  return (
    <div data-testid={id} data-return-to={readReturnTo(location.state)}>
      {location.pathname}
    </div>
  );
}

/** Renders the guard at `/dashboard` with the login and not-authorized probes. */
function renderGuard(
  authState: Partial<AuthContextValue>,
  guard: ReactElement
) {
  const context = makeAuthContext(authState);

  return render(
    <AuthContext.Provider value={context}>
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route path="/dashboard" element={guard} />
          <Route path="/login" element={<LocationProbe id="login" />} />
          <Route
            path="/not-authorized"
            element={<LocationProbe id="not-authorized" />}
          />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

describe("RequireAccess — Specification Tests", () => {
  it("should render its children when the caller holds the required role", () => {
    renderGuard(
      { isAuthenticated: true, user: { sub: "user-1", roles: ["admin"] } },
      <RequireAccess requirement={{ roles: ["admin"] }}>
        <div data-testid="guarded">Guarded</div>
      </RequireAccess>
    );

    expect(screen.getByTestId("guarded").textContent).toBe("Guarded");
  });

  it("should redirect an anonymous caller to login with the current path", () => {
    renderGuard(
      { isAuthenticated: false, user: null },
      <RequireAccess requirement={{ roles: ["admin"] }}>
        <div data-testid="guarded">Guarded</div>
      </RequireAccess>
    );

    expect(screen.getByTestId("login").dataset.returnTo).toBe("/dashboard");
    expect(screen.queryByTestId("guarded")).toBeNull();
  });

  it("should redirect a denied caller to the not-authorized path without a return path", () => {
    renderGuard(
      { isAuthenticated: true, user: { sub: "user-1", roles: ["viewer"] } },
      <RequireAccess requirement={{ roles: ["admin"] }}>
        <div data-testid="guarded">Guarded</div>
      </RequireAccess>
    );

    expect(screen.getByTestId("not-authorized").dataset.returnTo).toBe("");
    expect(screen.queryByTestId("guarded")).toBeNull();
  });

  it("should render nothing while the session is loading", () => {
    const { container } = renderGuard(
      { isAuthenticated: false, isLoading: true, user: null },
      <RequireAccess requirement={{ roles: ["admin"] }}>
        <div data-testid="guarded">Guarded</div>
      </RequireAccess>
    );

    expect(container.textContent).toBe("");
  });

  it("should render the route outlet when satisfied and no children are given", () => {
    const context = makeAuthContext({
      isAuthenticated: true,
      user: { sub: "user-1", roles: ["admin"] },
    });

    render(
      <AuthContext.Provider value={context}>
        <MemoryRouter initialEntries={["/layout"]}>
          <Routes>
            <Route element={<RequireAccess requirement={{ roles: ["admin"] }} />}>
              <Route
                path="/layout"
                element={<div data-testid="outlet-child">Outlet Child</div>}
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    );

    expect(screen.getByTestId("outlet-child").textContent).toBe("Outlet Child");
  });
});
