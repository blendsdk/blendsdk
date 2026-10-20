/**
 * Implementation tests for the principal selector and access guard.
 *
 * These cover the edge cases behind the guard specification: untrusted claim
 * shapes, duplicate and non-string grant values, a custom selector that returns
 * an empty principal, and an empty requirement that must stay satisfied.
 *
 * @packageDocumentation
 */

import { describe, it, expect, afterEach } from "vitest";
import supertest from "supertest";
import { WebApplication, BaseController } from "@blendsdk/webafx";
import type { RouteDefinition } from "@blendsdk/webafx";
import { createAuthPlugin, MemoryAuthProvider } from "@blendsdk/webafx-auth";
import type { AuthResult } from "@blendsdk/webafx-auth";
import { defaultPrincipalSelector, requireAccess } from "../src/index.js";

/** Token for the one authenticated caller used by the HTTP cases. */
const VALID_TOKEN = "valid-token";

/** Principal returned for {@link VALID_TOKEN}. */
const VALID_RESULT: AuthResult = {
  sub: "user-1",
  claims: {},
  token: VALID_TOKEN,
};

/** Builds an `AuthResult` with the given claims for selector tests. */
function resultWithClaims(claims: Record<string, unknown>): AuthResult {
  return { sub: "user-1", claims, token: "t" };
}

/** Returns an empty principal, used to prove a non-empty requirement denies. */
function emptySelector() {
  return { roles: [], permissions: [] };
}

/**
 * Controller with one route per guard edge case.
 *
 * - `/impl/empty-selector` requires a role but selects an empty principal.
 * - `/impl/empty-requirement` requires nothing but also selects an empty
 *   principal, so it must still be allowed.
 */
class ImplController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get("/impl/empty-selector")
        .secure()
        .authorize(
          requireAccess({ roles: ["admin"] }, { select: emptySelector })
        )
        .handle(async (req, res) => {
          this.ok(res, { allowed: true });
        }),

      this.route()
        .get("/impl/empty-requirement")
        .secure()
        .authorize(requireAccess({}, { select: emptySelector }))
        .handle(async (req, res) => {
          this.ok(res, { allowed: true });
        }),
    ];
  }
}

/** Builds an application with the valid token and the edge-case controller. */
function createTestApp(): WebApplication {
  const app = new WebApplication({
    PORT: 0,
    ENV_MODE: "test",
    LOG_LEVEL: "ERROR",
  });

  app.use(
    createAuthPlugin(
      new MemoryAuthProvider({ validTokens: { [VALID_TOKEN]: VALID_RESULT } })
    )
  );

  app.registerController("", ImplController);
  return app;
}

describe("Principal selector — Implementation Tests", () => {
  it("should return an empty principal for an anonymous caller", () => {
    expect(defaultPrincipalSelector(undefined)).toEqual({
      roles: [],
      permissions: [],
    });
  });

  it("should ignore claim values that are not arrays", () => {
    const principal = resultWithClaims({ roles: "admin", permissions: 42 });

    expect(defaultPrincipalSelector(principal)).toEqual({
      roles: [],
      permissions: [],
    });
  });

  it("should treat a principal whose claims are not an object as empty", () => {
    // A null `claims` object throws on property access, so this pins the
    // fail-closed guard rather than only a shape that never throws.
    const principal: AuthResult = JSON.parse(
      '{"sub":"user-1","token":"t","claims":null}'
    );

    expect(defaultPrincipalSelector(principal)).toEqual({
      roles: [],
      permissions: [],
    });
  });

  it("should keep only strings and remove duplicates", () => {
    const principal = resultWithClaims({
      roles: ["admin", 3, "admin", null, "viewer"],
      permissions: ["invoice:read", "invoice:read"],
    });

    expect(defaultPrincipalSelector(principal)).toEqual({
      roles: ["admin", "viewer"],
      permissions: ["invoice:read"],
    });
  });
});

describe("Access guard — Implementation Tests", () => {
  let shutdown: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = null;
    }
  });

  it("should deny a non-empty requirement when the selector returns no grants", async () => {
    const app = createTestApp();
    shutdown = await app.start();

    await supertest(app.express)
      .get("/impl/empty-selector")
      .set("Authorization", `Bearer ${VALID_TOKEN}`)
      .expect(403);
  });

  it("should allow an empty requirement even when the selector returns no grants", async () => {
    const app = createTestApp();
    shutdown = await app.start();

    const response = await supertest(app.express)
      .get("/impl/empty-requirement")
      .set("Authorization", `Bearer ${VALID_TOKEN}`)
      .expect(200);

    expect(response.body.data).toEqual({ allowed: true });
  });
});
