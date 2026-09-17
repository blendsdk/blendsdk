/**
 * Specification tests for the built-in claim profiles.
 *
 * A claim profile maps a provider's raw identity claims to the namespaced keys
 * that translation understands. The generic profile reads `roles` and
 * `permissions`; the Azure profile reads `roles`, the space-delimited `scp`
 * claim, and `groups`, and it must never emit a `permission:` key because Azure
 * scopes are not application permissions. Claims merge with the order
 * `userInfo`, then `idTokenClaims`, then `accessTokenClaims`, so the access
 * token wins. Malformed claims are ignored. Expectations are written before the
 * implementation and must not be changed to match it.
 *
 * @packageDocumentation
 */

import { describe, it, expect } from "vitest";

import { azureClaimsProfile, genericClaimsProfile } from "../src/index.js";

describe("genericClaimsProfile", () => {
  it("should emit role and permission keys for array claims", () => {
    const keys = genericClaimsProfile.extract({
      userInfo: { roles: ["a", "b"], permissions: ["p"] },
    });

    expect(keys).toEqual(["role:a", "role:b", "permission:p"]);
  });

  it("should ignore a role claim that is not an array", () => {
    const keys = genericClaimsProfile.extract({ userInfo: { roles: "admin" } });

    expect(keys).toEqual([]);
  });
});

describe("azureClaimsProfile", () => {
  it("should emit role keys from an access token roles claim", () => {
    const keys = azureClaimsProfile.extract({
      userInfo: {},
      accessTokenClaims: { roles: ["App.Admin"] },
    });

    expect(keys).toEqual(["role:App.Admin"]);
  });

  it("should split a whitespace-delimited scp claim into scp keys", () => {
    const keys = azureClaimsProfile.extract({
      userInfo: {},
      accessTokenClaims: { scp: "A B  C" },
    });

    expect(keys).toEqual(["scp:A", "scp:B", "scp:C"]);
  });

  it("should emit group keys from a groups claim", () => {
    const keys = azureClaimsProfile.extract({
      userInfo: {},
      accessTokenClaims: { groups: ["Finance", "HR"] },
    });

    expect(keys).toEqual(["group:Finance", "group:HR"]);
  });

  it("should never emit a permission key", () => {
    const keys = azureClaimsProfile.extract({
      userInfo: {},
      accessTokenClaims: { permissions: ["p"], scp: "S" },
    });

    expect(keys).toEqual(["scp:S"]);
  });

  it("should ignore malformed claims", () => {
    const keys = azureClaimsProfile.extract({
      userInfo: {},
      accessTokenClaims: { scp: 123, groups: "Finance" },
    });

    expect(keys).toEqual([]);
  });
});

describe("claim precedence", () => {
  it("should let the access token claims override user info and the identity token", () => {
    const keys = genericClaimsProfile.extract({
      userInfo: { roles: ["user-info"] },
      idTokenClaims: { roles: ["id-token"] },
      accessTokenClaims: { roles: ["access-token"] },
    });

    expect(keys).toEqual(["role:access-token"]);
  });
});
