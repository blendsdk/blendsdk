/**
 * Implementation tests for grant translation.
 *
 * These cover parsing and aggregation details of the translator: how a key is
 * split, how malformed runtime data is filtered, and how the unmapped-key
 * callback behaves. They are written after the implementation.
 *
 * @packageDocumentation
 */

import { describe, it, expect, vi } from "vitest";

import { createClaimsTranslator, grantKey, resolveGrants } from "../src/index.js";
import type { ClaimsProfile, GrantMap } from "../src/index.js";

describe("grantKey", () => {
  it("should join the source and value with a colon", () => {
    expect(grantKey("role", "admin")).toBe("role:admin");
    expect(grantKey("permission", "invoice:read")).toBe("permission:invoice:read");
  });
});

describe("resolveGrants edge cases", () => {
  it("should return empty grants for no keys", () => {
    expect(resolveGrants([], {})).toEqual({ roles: [], permissions: [] });
  });

  it("should keep colons inside a canonical value", () => {
    const result = resolveGrants(["role:a:b"], {}, { roles: ["a:b"] });

    expect(result.roles).toEqual(["a:b"]);
  });

  it("should ignore a key without a colon", () => {
    const result = resolveGrants(["malformed"], {}, { roles: ["malformed"] });

    expect(result.roles).toEqual([]);
  });

  it("should ignore an inherited namespaced property", () => {
    const inherited: GrantMap = Object.create({ "role:x": { roles: ["admin"] } });

    const result = resolveGrants(["role:x"], inherited);

    expect(result.roles).toEqual([]);
  });

  it("should filter non-string mapped values", () => {
    // Malformed runtime input: a mapped value can hold anything after JSON parsing.
    const map: GrantMap = JSON.parse(
      '{"group:x":{"roles":["admin",null,"admin"],"permissions":[7]}}'
    );

    const result = resolveGrants(["group:x"], map);

    expect(result.roles).toEqual(["admin"]);
    expect(result.permissions).toEqual([]);
  });

  it("should ignore a mapped value that is not an array", () => {
    // A string would otherwise be iterated character by character.
    const map: GrantMap = JSON.parse('{"role:x":{"roles":"admin"}}');

    const result = resolveGrants(["role:x"], map);

    expect(result.roles).toEqual([]);
  });

  it("should ignore a mapped entry that is not an object", () => {
    const map: GrantMap = JSON.parse('{"role:x":null,"role:y":42}');

    expect(() => resolveGrants(["role:x", "role:y"], map)).not.toThrow();
    expect(resolveGrants(["role:x", "role:y"], map).roles).toEqual([]);
  });

  it("should treat an own property with no value as mapped", () => {
    const map: GrantMap = { "role:x": undefined };

    const result = resolveGrants(["role:x"], map, { roles: ["x"] });

    expect(result.roles).toEqual([]);
  });

  it("should de-duplicate a value granted by a mapped and a canonical key", () => {
    const map: GrantMap = { "group:admins": { roles: ["admin"] } };

    const result = resolveGrants(["group:admins", "role:admin"], map, {
      roles: ["admin"],
    });

    expect(result.roles).toEqual(["admin"]);
  });

  it("should preserve first-seen order across mapped and canonical keys", () => {
    const map: GrantMap = { "group:z": { roles: ["zeta"] } };

    const result = resolveGrants(["group:z", "role:alpha"], map, { roles: ["alpha"] });

    expect(result.roles).toEqual(["zeta", "alpha"]);
  });

  it("should treat an own property with an empty mapping as mapped", () => {
    const map: GrantMap = { "role:ghost": {} };

    const result = resolveGrants(["role:ghost"], map, { roles: ["ghost"] });

    expect(result.roles).toEqual([]);
  });
});

describe("createClaimsTranslator edge cases", () => {
  it("should report a malformed key as unmapped", () => {
    const onUnmapped = vi.fn();
    const profile: ClaimsProfile = { name: "stub", extract: () => ["malformed"] };

    createClaimsTranslator(profile, {}, { onUnmapped }).translate({ userInfo: {} });

    expect(onUnmapped).toHaveBeenCalledWith("malformed");
  });

  it("should not report a canonical key the application allows", () => {
    const onUnmapped = vi.fn();
    const profile: ClaimsProfile = { name: "stub", extract: () => ["role:admin"] };

    createClaimsTranslator(profile, {}, {
      allowed: { roles: ["admin"] },
      onUnmapped,
    }).translate({ userInfo: {} });

    expect(onUnmapped).not.toHaveBeenCalled();
  });
});
