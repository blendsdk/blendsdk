// @vitest-environment jsdom

/**
 * Specification tests for the authorization hook.
 *
 * These tests describe how a component reads the canonical grants the server
 * stored on the session user: the hook exposes the roles and permissions,
 * answers role and permission questions, and treats an anonymous user as
 * holding nothing. They are derived from the authorization requirements and
 * written before the implementation; a failing case means the implementation
 * is wrong, never the test.
 *
 * @packageDocumentation
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { AuthContext } from "../src/auth/auth-provider.js";
import { AUTH_DEFAULTS } from "../src/auth/auth-defaults.js";
import { useAuthorization } from "../src/index.js";
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

/** Wraps the hook under test in the given auth context. */
function wrapperFor(
  context: AuthContextValue
): ({ children }: { children: ReactNode }) => ReactElement {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AuthContext.Provider value={context}>{children}</AuthContext.Provider>
    );
  };
}

describe("useAuthorization — Specification Tests", () => {
  it("should expose the grants and answer role and permission questions", () => {
    const context = makeAuthContext({
      isAuthenticated: true,
      user: {
        sub: "user-1",
        roles: ["admin"],
        permissions: ["invoice:read"],
      },
    });

    const { result } = renderHook(() => useAuthorization(), {
      wrapper: wrapperFor(context),
    });

    expect(result.current.roles).toEqual(["admin"]);
    expect(result.current.permissions).toEqual(["invoice:read"]);
    expect(result.current.hasRole("admin")).toBe(true);
    expect(result.current.can("invoice:write")).toBe(false);
  });

  it("should hold nothing when there is no user", () => {
    const context = makeAuthContext({
      isAuthenticated: false,
      user: null,
    });

    const { result } = renderHook(() => useAuthorization(), {
      wrapper: wrapperFor(context),
    });

    expect(result.current.roles).toEqual([]);
    expect(result.current.permissions).toEqual([]);
    expect(result.current.hasRole("admin")).toBe(false);
    expect(result.current.can("invoice:read")).toBe(false);
  });
});
