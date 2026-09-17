/**
 * Specification tests for the authorization evaluator.
 *
 * The expectations describe how a principal that holds roles and permissions
 * must satisfy an access requirement. They are derived from the authorization
 * requirements and written before the implementation; they must never be
 * adjusted to match it. A failing test here means the implementation is wrong.
 *
 * @packageDocumentation
 */

import { describe, it, expect } from "vitest";

import { hasPermission, hasRole, satisfiesAccess } from "../src/index.js";
import type { AccessPrincipal } from "../src/index.js";

/** Build a principal that holds the given roles and permissions. */
function principal(roles: string[], permissions: string[]): AccessPrincipal {
  return { roles, permissions };
}

describe("satisfiesAccess", () => {
  it("should grant access when any listed role is held", () => {
    expect(
      satisfiesAccess(principal(["admin"], []), { roles: ["admin", "editor"] })
    ).toBe(true);
  });

  it("should grant access when any listed permission is held", () => {
    expect(
      satisfiesAccess(principal([], ["invoice:read"]), {
        permissions: ["invoice:read", "invoice:write"],
      })
    ).toBe(true);
  });

  it("should deny access when not every listed role is held in all mode", () => {
    expect(
      satisfiesAccess(principal(["admin"], []), {
        mode: "all",
        roles: ["admin", "editor"],
      })
    ).toBe(false);
  });

  it("should grant access when every listed role is held in all mode", () => {
    expect(
      satisfiesAccess(principal(["admin", "editor"], []), {
        mode: "all",
        roles: ["admin", "editor"],
      })
    ).toBe(true);
  });

  it("should grant access when a roles-only requirement is held", () => {
    expect(satisfiesAccess(principal(["viewer"], []), { roles: ["viewer"] })).toBe(true);
  });

  it("should grant access when a permissions-only requirement is held", () => {
    expect(
      satisfiesAccess(principal([], ["invoice:read"]), { permissions: ["invoice:read"] })
    ).toBe(true);
  });

  it("should grant access when the requirement is empty", () => {
    expect(satisfiesAccess(principal([], []), {})).toBe(true);
  });

  it("should grant access when any role or permission is held across both lists", () => {
    expect(
      satisfiesAccess(principal(["admin"], []), {
        roles: ["admin"],
        permissions: ["invoice:read"],
      })
    ).toBe(true);
  });

  it("should deny access when a required permission is missing in all mode", () => {
    expect(
      satisfiesAccess(principal(["admin"], ["invoice:read"]), {
        mode: "all",
        roles: ["admin"],
        permissions: ["invoice:write"],
      })
    ).toBe(false);
  });
});

describe("hasRole / hasPermission", () => {
  it("should report a held role", () => {
    expect(hasRole(principal(["admin"], []), "admin")).toBe(true);
  });

  it("should report an unheld role", () => {
    expect(hasRole(principal(["admin"], []), "editor")).toBe(false);
  });

  it("should report a held permission", () => {
    expect(hasPermission(principal([], ["invoice:read"]), "invoice:read")).toBe(true);
  });

  it("should report an unheld permission", () => {
    expect(hasPermission(principal([], ["invoice:read"]), "invoice:write")).toBe(false);
  });
});
