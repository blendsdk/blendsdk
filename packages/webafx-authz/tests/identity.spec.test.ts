/**
 * Specification tests for provider identity decoding.
 *
 * These tests describe how a provider callback turns raw tokens into the
 * claims and scopes a translation profile reads: an identity token is decoded,
 * an opaque access token is tolerated, user info passes through unchanged, and
 * a granted scope string is split into individual scopes. They are derived
 * from the authorization requirements and written before the implementation; a
 * failing case means the implementation is wrong, never the test.
 *
 * @packageDocumentation
 */

import { describe, it, expect } from "vitest";
import { SignJWT } from "jose";
import { buildProviderIdentity, decodeJwtClaims } from "../src/index.js";

/** Signing secret for the test identity token (decoding does not verify it). */
const TEST_SECRET = "identity-spec-secret-that-is-long-enough-for-hs256!";

/**
 * Creates a signed identity token carrying the given claims.
 *
 * The token is cryptographically valid, but {@link decodeJwtClaims} only
 * decodes it, so the secret is irrelevant to the assertions.
 */
async function signIdentityToken(
  claims: Record<string, unknown>
): Promise<string> {
  const secret = new TextEncoder().encode(TEST_SECRET);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .sign(secret);
}

describe("Provider identity — Specification Tests", () => {
  it("should decode an identity token, keep user info, and split scopes", async () => {
    const idToken = await signIdentityToken({ sub: "1" });
    const userInfo = { sub: "1", email: "user@example.com" };

    const identity = buildProviderIdentity(
      { accessToken: "opaque", idToken, scope: "openid profile" },
      userInfo
    );

    expect(identity.userInfo).toBe(userInfo);
    expect(identity.idTokenClaims).toMatchObject({ sub: "1" });
    expect(identity.accessTokenClaims).toBeUndefined();
    expect(identity.scopes).toEqual(["openid", "profile"]);
  });

  it("should return undefined for an opaque token and the payload for a decodable one", async () => {
    const idToken = await signIdentityToken({ sub: "user-1" });

    expect(decodeJwtClaims("opaque")).toBeUndefined();
    expect(decodeJwtClaims(idToken)).toMatchObject({ sub: "user-1" });
  });

  it("should split a padded scope string and omit scopes when none are granted", () => {
    const withScopes = buildProviderIdentity({ scope: "  a   b " }, {});
    const withoutScopes = buildProviderIdentity({}, {});

    expect(withScopes.scopes).toEqual(["a", "b"]);
    expect(withoutScopes.scopes).toBeUndefined();
  });
});
