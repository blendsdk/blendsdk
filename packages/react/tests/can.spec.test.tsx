// @vitest-environment jsdom

/**
 * Specification tests for the conditional-rendering component.
 *
 * These tests describe how a small piece of UI is shown or hidden based on a
 * permission: the children render when the grant is held, the fallback renders
 * otherwise, and an anonymous caller behaves like a denied one. It never
 * redirects. They are derived from the authorization requirements and written
 * before the implementation; a failing case means the implementation is wrong,
 * never the test.
 *
 * @packageDocumentation
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthContext } from "../src/auth/auth-provider.js";
import { AUTH_DEFAULTS } from "../src/auth/auth-defaults.js";
import { Can } from "../src/index.js";
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

/** Renders the given tree under a controlled auth context, without a router. */
function renderWithAuth(
  authState: Partial<AuthContextValue>,
  tree: ReactNode
): ReturnType<typeof render> {
  const context = makeAuthContext(authState);

  return render(
    <AuthContext.Provider value={context}>{tree}</AuthContext.Provider>
  );
}

describe("Can — Specification Tests", () => {
  it("should render children when the permission is held", () => {
    renderWithAuth(
      {
        isAuthenticated: true,
        user: { sub: "user-1", permissions: ["invoice:write"] },
      },
      <Can requirement={{ permissions: ["invoice:write"] }}>
        <div data-testid="allowed">Allowed</div>
      </Can>
    );

    expect(document.querySelector('[data-testid="allowed"]')).not.toBeNull();
  });

  it("should render the fallback when the permission is not held", () => {
    renderWithAuth(
      {
        isAuthenticated: true,
        user: { sub: "user-1", permissions: ["invoice:read"] },
      },
      <Can
        requirement={{ permissions: ["invoice:write"] }}
        fallback={<div data-testid="fallback">Read only</div>}
      >
        <div data-testid="allowed">Allowed</div>
      </Can>
    );

    expect(document.querySelector('[data-testid="fallback"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="allowed"]')).toBeNull();
  });

  it("should render nothing when not held and no fallback is given", () => {
    const { container } = renderWithAuth(
      {
        isAuthenticated: true,
        user: { sub: "user-1", permissions: ["invoice:read"] },
      },
      <Can requirement={{ permissions: ["invoice:write"] }}>
        <div data-testid="allowed">Allowed</div>
      </Can>
    );

    expect(container.textContent).toBe("");
  });

  it("should treat an anonymous caller as denied and never redirect", () => {
    const { container } = renderWithAuth(
      { isAuthenticated: false, user: null },
      <Can
        requirement={{ permissions: ["invoice:write"] }}
        fallback={<div data-testid="fallback">Read only</div>}
      >
        <div data-testid="allowed">Allowed</div>
      </Can>
    );

    expect(document.querySelector('[data-testid="fallback"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="allowed"]')).toBeNull();
    expect(container.textContent).toBe("Read only");
  });
});
