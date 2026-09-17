// @vitest-environment jsdom

/**
 * Implementation tests for the route access guard.
 *
 * These cover the edge cases behind the guard specification: a custom redirect
 * target for a denied user, the rule that an anonymous user is always sent to
 * login, and the behavior of one guard nested inside another.
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

/** Renders a route tree under controlled auth state. */
function renderRoutes(
  authState: Partial<AuthContextValue>,
  routes: ReactElement,
  initialRoute = "/dashboard"
) {
  const context = makeAuthContext(authState);

  return render(
    <AuthContext.Provider value={context}>
      <MemoryRouter initialEntries={[initialRoute]}>{routes}</MemoryRouter>
    </AuthContext.Provider>
  );
}

describe("RequireAccess — Implementation Tests", () => {
  it("should redirect to the redirectTo override when denied", () => {
    renderRoutes(
      { isAuthenticated: true, user: { sub: "user-1", roles: ["viewer"] } },
      <Routes>
        <Route
          path="/dashboard"
          element={
            <RequireAccess
              requirement={{ roles: ["admin"] }}
              redirectTo="/custom-denied"
            >
              <div data-testid="guarded">Guarded</div>
            </RequireAccess>
          }
        />
        <Route
          path="/custom-denied"
          element={<LocationProbe id="custom-denied" />}
        />
      </Routes>
    );

    expect(screen.getByTestId("custom-denied")).toBeTruthy();
    expect(screen.queryByTestId("guarded")).toBeNull();
  });

  it("should send an anonymous caller to login even when redirectTo is set", () => {
    renderRoutes(
      { isAuthenticated: false, user: null },
      <Routes>
        <Route
          path="/dashboard"
          element={
            <RequireAccess
              requirement={{ roles: ["admin"] }}
              redirectTo="/custom-denied"
            >
              <div data-testid="guarded">Guarded</div>
            </RequireAccess>
          }
        />
        <Route path="/login" element={<LocationProbe id="login" />} />
        <Route
          path="/custom-denied"
          element={<LocationProbe id="custom-denied" />}
        />
      </Routes>
    );

    expect(screen.getByTestId("login").dataset.returnTo).toBe("/dashboard");
    expect(screen.queryByTestId("custom-denied")).toBeNull();
  });

  it("should deny a nested guard when the inner requirement is unmet", () => {
    renderRoutes(
      {
        isAuthenticated: true,
        user: { sub: "user-1", roles: ["admin"] },
      },
      <Routes>
        <Route element={<RequireAccess requirement={{ roles: ["admin"] }} />}>
          <Route
            path="/dashboard"
            element={
              <RequireAccess requirement={{ permissions: ["invoice:write"] }}>
                <div data-testid="deep">Deep</div>
              </RequireAccess>
            }
          />
        </Route>
        <Route
          path="/not-authorized"
          element={<LocationProbe id="not-authorized" />}
        />
      </Routes>
    );

    expect(screen.getByTestId("not-authorized")).toBeTruthy();
    expect(screen.queryByTestId("deep")).toBeNull();
  });
});
