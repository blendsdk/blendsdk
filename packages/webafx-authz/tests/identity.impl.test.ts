/**
 * Implementation tests for provider identity decoding.
 *
 * These cover the edge cases behind the identity specification: tokens that are
 * absent, blank, or structurally malformed, a missing access token, both tokens
 * present, and user info passed through by reference.
 *
 * @packageDocumentation
 */

import { describe, it, expect } from "vitest";
import { SignJWT } from "jose";
import { buildProviderIdentity, decodeJwtClaims } from "../src/index.js";

/** Signing secret for the test tokens (decoding does not verify it). */
const TEST_SECRET = "identity-impl-secret-that-is-long-enough-for-hs256!";

/** Creates a signed identity token carrying the given claims. */
async function signToken(claims: Record<string, unknown>): Promise<string> {
  const secret = new TextEncoder().encode(TEST_SECRET);
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).sign(secret);
}

describe("Identity helpers — Implementation Tests", () => {
  it("should return undefined when the token is absent or empty", () => {
    expect(decodeJwtClaims(undefined)).toBeUndefined();
    expect(decodeJwtClaims("")).toBeUndefined();
  });

  it("should return undefined for a token with malformed segments", () => {
    expect(decodeJwtClaims("only-one-segment")).toBeUndefined();
    expect(decodeJwtClaims("two.segments")).toBeUndefined();
    expect(decodeJwtClaims("not.a.jwt")).toBeUndefined();
  });

  it("should omit scopes when the scope string is blank", () => {
    expect(buildProviderIdentity({ scope: "   " }, {}).scopes).toBeUndefined();
  });

  it("should decode only the identity token when the access token is missing", async () => {
    const idToken = await signToken({ sub: "user-1" });

    const identity = buildProviderIdentity({ idToken }, {});

    expect(identity.idTokenClaims).toMatchObject({ sub: "user-1" });
    expect(identity.accessTokenClaims).toBeUndefined();
  });

  it("should decode both tokens when both are present", async () => {
    const idToken = await signToken({ sub: "user-1" });
    const accessToken = await signToken({ scope: "read" });

    const identity = buildProviderIdentity({ idToken, accessToken }, {});

    expect(identity.idTokenClaims).toMatchObject({ sub: "user-1" });
    expect(identity.accessTokenClaims).toMatchObject({ scope: "read" });
  });

  it("should pass user info through by reference", () => {
    const userInfo = { sub: "user-1" };

    expect(buildProviderIdentity({}, userInfo).userInfo).toBe(userInfo);
  });
});
