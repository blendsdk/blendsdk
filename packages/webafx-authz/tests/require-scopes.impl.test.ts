/**
 * Implementation tests for the scope guard.
 *
 * These cover the edge cases behind the scope specification: an empty scope
 * list requires nothing, and a `scopes` list that holds only non-string
 * entries must not suppress the fallback to the `scope` claim.
 *
 * @packageDocumentation
 */

import { describe, it, expect, afterEach } from "vitest";
import supertest from "supertest";
import { WebApplication, BaseController } from "@blendsdk/webafx";
import type { RouteDefinition } from "@blendsdk/webafx";
import { createAuthPlugin, MemoryAuthProvider } from "@blendsdk/webafx-auth";
import type { AuthResult } from "@blendsdk/webafx-auth";
import { requireScopes } from "../src/index.js";

/** Token for a principal that holds no scopes at all. */
const PLAIN_TOKEN = "plain-token";

/** Token whose `scopes` list holds a non-string entry and a `scope` claim. */
const MALFORMED_SCOPES_TOKEN = "malformed-scopes-token";

/** Token whose `claims` object is null. */
const NULL_CLAIMS_TOKEN = "null-claims-token";

/** Principal with no scopes. */
const PLAIN_RESULT: AuthResult = {
  sub: "service-plain",
  claims: {},
  token: PLAIN_TOKEN,
};

/** Principal whose scope list is malformed, with a valid `scope` claim. */
const MALFORMED_SCOPES_RESULT: AuthResult = JSON.parse(
  '{"sub":"service-malformed","token":"malformed-scopes-token","scopes":[42],"claims":{"scope":"a b"}}'
);

/** Principal whose `claims` object is null. */
const NULL_CLAIMS_RESULT: AuthResult = JSON.parse(
  '{"sub":"service-null","token":"null-claims-token","claims":null}'
);

/**
 * Controller with one route per scope edge case.
 *
 * - `/impl/scopes-empty` requires no scopes.
 * - `/impl/scopes-fallback` requires two scopes that only the fallback claim
 *   supplies.
 * - `/impl/scopes-null-claims` requires a scope from a principal whose claims
 *   are null.
 */
class ScopeImplController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get("/impl/scopes-empty")
        .secure()
        .authorize(requireScopes([]))
        .handle(async (req, res) => {
          this.ok(res, { allowed: true });
        }),

      this.route()
        .get("/impl/scopes-fallback")
        .secure()
        .authorize(requireScopes(["a", "b"]))
        .handle(async (req, res) => {
          this.ok(res, { allowed: true });
        }),

      this.route()
        .get("/impl/scopes-null-claims")
        .secure()
        .authorize(requireScopes(["a"]))
        .handle(async (req, res) => {
          this.ok(res, { allowed: true });
        }),
    ];
  }
}

/** Builds an application with the two scope tokens and the controller. */
function createTestApp(): WebApplication {
  const app = new WebApplication({
    PORT: 0,
    ENV_MODE: "test",
    LOG_LEVEL: "ERROR",
  });

  app.use(
    createAuthPlugin(
      new MemoryAuthProvider({
        validTokens: {
          [PLAIN_TOKEN]: PLAIN_RESULT,
          [MALFORMED_SCOPES_TOKEN]: MALFORMED_SCOPES_RESULT,
          [NULL_CLAIMS_TOKEN]: NULL_CLAIMS_RESULT,
        },
      })
    )
  );

  app.registerController("", ScopeImplController);
  return app;
}

describe("Scope guard — Implementation Tests", () => {
  let shutdown: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = null;
    }
  });

  it("should require nothing when the scope list is empty", async () => {
    const app = createTestApp();
    shutdown = await app.start();

    const response = await supertest(app.express)
      .get("/impl/scopes-empty")
      .set("Authorization", `Bearer ${PLAIN_TOKEN}`)
      .expect(200);

    expect(response.body.data).toEqual({ allowed: true });
  });

  it("should fall back to the scope claim when the scopes list holds no strings", async () => {
    const app = createTestApp();
    shutdown = await app.start();

    const response = await supertest(app.express)
      .get("/impl/scopes-fallback")
      .set("Authorization", `Bearer ${MALFORMED_SCOPES_TOKEN}`)
      .expect(200);

    expect(response.body.data).toEqual({ allowed: true });
  });

  it("should fail closed, not throw, when the claims object is null", async () => {
    const app = createTestApp();
    shutdown = await app.start();

    await supertest(app.express)
      .get("/impl/scopes-null-claims")
      .set("Authorization", `Bearer ${NULL_CLAIMS_TOKEN}`)
      .expect(403);
  });
});
