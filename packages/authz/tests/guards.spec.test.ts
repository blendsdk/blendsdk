/**
 * Specification tests for the value guard.
 *
 * The guard validates an untrusted value, such as a claim read from a token,
 * against a list of application-owned values. It returns `true` only for a
 * string that appears in the list, which lets a caller narrow an `unknown`
 * value to the application's own union type without a cast. Expectations are
 * written before the implementation and must not be changed to match it.
 *
 * @packageDocumentation
 */

import { describe, it, expect } from "vitest";

import { isOneOf } from "../src/index.js";

/** Application-owned role values, used to exercise the guard. */
const ROLES = { Admin: "admin", User: "user" } as const;

describe("isOneOf", () => {
  it("should accept a value present in the allowed list", () => {
    expect(isOneOf("admin", ["admin", "user"])).toBe(true);
  });

  it("should reject a string that is not in the allowed list", () => {
    expect(isOneOf("root", ["admin"])).toBe(false);
  });

  it("should reject a value that is not a string", () => {
    expect(isOneOf(42, ["admin"])).toBe(false);
  });

  it("should narrow an unknown value to the application union", () => {
    const raw: unknown = "admin";

    if (isOneOf(raw, Object.values(ROLES))) {
      // The guard must narrow `unknown` to the derived union type.
      const narrowed: "admin" | "user" = raw;
      expect(narrowed).toBe("admin");
    } else {
      throw new Error("expected the guard to accept an application value");
    }
  });
});
