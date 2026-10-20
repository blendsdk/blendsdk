/**
 * Implementation tests for the authorization evaluator.
 *
 * These cover boundary cases of the evaluator that the specification tests do
 * not spell out directly. They are written after the implementation and focus
 * on how the code behaves at the edges.
 *
 * @packageDocumentation
 */

import { describe, it, expect } from "vitest";

import { hasPermission, hasRole, satisfiesAccess } from "../src/index.js";
import type { AccessPrincipal } from "../src/index.js";

/** Build a principal that holds the given roles and permissions. */
function principal(roles: string[] = [], permissions: string[] = []): AccessPrincipal {
  return { roles, permissions };
}

describe("satisfiesAccess edge cases", () => {
  it("should treat an all-mode requirement with no values as satisfied", () => {
    expect(satisfiesAccess(principal(["admin"]), { mode: "all" })).toBe(true);
  });

  it("should treat explicitly empty arrays like an absent requirement", () => {
    expect(satisfiesAccess(principal(), { roles: [], permissions: [] })).toBe(true);
  });

  it("should check only the populated list in all mode", () => {
    expect(
      satisfiesAccess(principal([], ["a"]), { mode: "all", permissions: ["a"] })
    ).toBe(true);
  });

  it("should deny in all mode when one of several permissions is missing", () => {
    expect(
      satisfiesAccess(principal([], ["a"]), { mode: "all", permissions: ["a", "b"] })
    ).toBe(false);
  });

  it("should ignore duplicate held values", () => {
    expect(satisfiesAccess(principal(["admin", "admin"]), { roles: ["admin"] })).toBe(true);
  });
});

describe("hasRole / hasPermission edge cases", () => {
  it("should return false for an empty principal", () => {
    expect(hasRole(principal(), "admin")).toBe(false);
    expect(hasPermission(principal(), "invoice:read")).toBe(false);
  });

  it("should match values exactly, including case", () => {
    expect(hasRole(principal(["Admin"]), "admin")).toBe(false);
    expect(hasPermission(principal([], ["invoice:read"]), "invoice:read:extra")).toBe(false);
  });
});
