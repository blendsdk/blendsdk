/**
 * Specification tests for grant translation.
 *
 * Translation turns provider claims, expressed as namespaced keys, into the
 * canonical roles and permissions a principal holds. Only application-owned
 * values grant authority: mapped keys are trusted application configuration,
 * while an unmapped canonical key is accepted only when the application lists
 * it in `allowed`. Provider-specific sources such as `scp:` and `group:` never
 * grant authority on their own. Expectations are written before the
 * implementation and must not be changed to match it.
 *
 * @packageDocumentation
 */

import { describe, it, expect, vi } from "vitest";

import { createClaimsTranslator, resolveGrants } from "../src/index.js";
import type { ClaimsProfile, GrantMap } from "../src/index.js";

describe("resolveGrants", () => {
  it("should prefer a mapped grant over the canonical fallback", () => {
    const map: GrantMap = { "role:admin": { roles: ["super"] } };

    const result = resolveGrants(["role:admin"], map, { roles: ["admin", "super"] });

    expect(result.roles).toEqual(["super"]);
  });

  it("should accept an unmapped canonical role that the application allows", () => {
    const result = resolveGrants(["role:admin"], {}, { roles: ["admin"] });

    expect(result.roles).toEqual(["admin"]);
  });

  it("should drop an unmapped canonical role that the application does not allow", () => {
    const result = resolveGrants(["role:editor"], {}, { roles: ["admin"] });

    expect(result.roles).toEqual([]);
  });

  it("should fail closed when no allowlist is supplied", () => {
    const result = resolveGrants(["role:admin"], {});

    expect(result.roles).toEqual([]);
  });

  it("should trust a mapped grant even when the allowlist is empty", () => {
    const map: GrantMap = { "role:x": { roles: ["admin"] } };

    const result = resolveGrants(["role:x"], map, { roles: [] });

    expect(result.roles).toEqual(["admin"]);
  });

  it("should never treat an scp key as a canonical permission", () => {
    const result = resolveGrants(["scp:Invoice.Read"], {}, {
      permissions: ["Invoice.Read"],
    });

    expect(result.permissions).toEqual([]);
  });

  it("should never treat a group key as a canonical role", () => {
    const result = resolveGrants(["group:Finance"], {}, { roles: ["Finance"] });

    expect(result.roles).toEqual([]);
  });

  it("should grant mapped permissions from a provider-specific key", () => {
    const map: GrantMap = { "scp:Invoice.Read": { permissions: ["invoice:read"] } };

    const result = resolveGrants(["scp:Invoice.Read"], map);

    expect(result.permissions).toEqual(["invoice:read"]);
  });

  it("should de-duplicate grants and keep first-seen order", () => {
    const result = resolveGrants(["role:admin", "role:admin", "role:viewer"], {}, {
      roles: ["admin", "viewer"],
    });

    expect(result.roles).toEqual(["admin", "viewer"]);
  });

  it("should drop non-string mapped values", () => {
    // Malformed runtime input: a map value can hold anything after JSON parsing.
    const malformedMap: GrantMap = JSON.parse('{"role:x":{"roles":["admin",3,"admin"]}}');

    const result = resolveGrants(["role:x"], malformedMap, { roles: ["admin"] });

    expect(result.roles).toEqual(["admin"]);
  });
});

describe("createClaimsTranslator", () => {
  it("should translate the keys reported by the profile", () => {
    const profile: ClaimsProfile = { name: "stub", extract: () => ["role:admin"] };
    const translator = createClaimsTranslator(profile, {}, { allowed: { roles: ["admin"] } });

    const principal = translator.translate({ userInfo: {} });

    expect(principal.roles).toEqual(["admin"]);
    expect(principal.permissions).toEqual([]);
  });

  it("should report every key that yields no grant", () => {
    const onUnmapped = vi.fn();
    const profile: ClaimsProfile = {
      name: "stub",
      extract: () => ["role:admin", "scp:Invoice.Read"],
    };
    const translator = createClaimsTranslator(profile, {}, {
      allowed: { roles: ["admin"] },
      onUnmapped,
    });

    translator.translate({ userInfo: {} });

    expect(onUnmapped).toHaveBeenCalledTimes(1);
    expect(onUnmapped).toHaveBeenCalledWith("scp:Invoice.Read");
  });

  it("should not report a mapped key that grants nothing", () => {
    const onUnmapped = vi.fn();
    const profile: ClaimsProfile = { name: "stub", extract: () => ["role:ghost"] };
    const translator = createClaimsTranslator(profile, { "role:ghost": {} }, { onUnmapped });

    translator.translate({ userInfo: {} });

    expect(onUnmapped).not.toHaveBeenCalled();
  });
});
