/**
 * Implementation tests for the built-in claim profiles.
 *
 * These cover details of claim reading: how non-string entries are filtered,
 * how a claim falls back between sources, and how whitespace in the Azure
 * scope claim is handled. They are written after the implementation.
 *
 * @packageDocumentation
 */

import { describe, it, expect } from "vitest";

import { azureClaimsProfile, genericClaimsProfile } from "../src/index.js";

describe("string array reading", () => {
  it("should drop non-string entries in a generic roles claim", () => {
    const keys = genericClaimsProfile.extract({
      userInfo: { roles: ["a", 3, null, "b"] },
    });

    expect(keys).toEqual(["role:a", "role:b"]);
  });

  it("should ignore a permissions claim that is not an array", () => {
    const keys = genericClaimsProfile.extract({
      userInfo: { permissions: "invoice:read" },
    });

    expect(keys).toEqual([]);
  });
});

describe("claim precedence edge cases", () => {
  it("should fall back to the identity token when the access token has no claim", () => {
    const keys = genericClaimsProfile.extract({
      userInfo: { roles: ["user-info"] },
      idTokenClaims: { roles: ["id-token"] },
    });

    expect(keys).toEqual(["role:id-token"]);
  });

  it("should resolve each claim independently across sources", () => {
    const keys = genericClaimsProfile.extract({
      userInfo: { permissions: ["invoice:read"] },
      accessTokenClaims: { roles: ["admin"] },
    });

    expect(keys).toEqual(["role:admin", "permission:invoice:read"]);
  });
});

describe("azure profile edge cases", () => {
  it("should not emit empty scp keys for padded whitespace", () => {
    const keys = azureClaimsProfile.extract({
      userInfo: {},
      accessTokenClaims: { scp: "  A   B  " },
    });

    expect(keys).toEqual(["scp:A", "scp:B"]);
  });

  it("should ignore a groups claim that is not an array", () => {
    const keys = azureClaimsProfile.extract({
      userInfo: {},
      accessTokenClaims: { groups: "Finance" },
    });

    expect(keys).toEqual([]);
  });

  it("should return no keys for an identity without claims", () => {
    expect(genericClaimsProfile.extract({ userInfo: {} })).toEqual([]);
    expect(azureClaimsProfile.extract({ userInfo: {} })).toEqual([]);
  });
});
