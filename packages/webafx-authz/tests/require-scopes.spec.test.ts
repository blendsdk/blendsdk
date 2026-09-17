/**
 * Specification tests for the scope guard.
 *
 * These tests describe how a scope requirement is checked for a machine
 * principal: every requested scope must be held, and the held scopes may come
 * either from the principal's `scopes` list or from a space-delimited
 * `claims.scope` string when that list is absent. They are derived from the
 * authorization requirements and written before the implementation; a failing
 * case means the implementation is wrong, never the test.
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

/** Token for a principal holding every required scope. */
const ALL_SCOPES_TOKEN = "all-scopes-token";

/** Token for a principal holding only one of the required scopes. */
const ONE_SCOPE_TOKEN = "one-scope-token";

/** Token whose scopes are only in the space-delimited `scope` claim. */
const CLAIM_SCOPE_TOKEN = "claim-scope-token";

/** Principal holding `a`, `b`, and `c`. */
const ALL_SCOPES_RESULT: AuthResult = {
  sub: "service-all",
  claims: {},
  token: ALL_SCOPES_TOKEN,
  scopes: ["a", "b", "c"],
};

/** Principal holding only `a`. */
const ONE_SCOPE_RESULT: AuthResult = {
  sub: "service-one",
  claims: {},
  token: ONE_SCOPE_TOKEN,
  scopes: ["a"],
};

/** Principal with no scope list but a space-delimited `scope` claim. */
const CLAIM_SCOPE_RESULT: AuthResult = {
  sub: "service-claim",
  claims: { scope: "a b" },
  token: CLAIM_SCOPE_TOKEN,
};

/** Controller exposing one route guarded by a two-scope requirement. */
class ScopeController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get("/scope/guard")
        .secure()
        .authorize(requireScopes(["a", "b"]))
        .handle(async (req, res) => {
          this.ok(res, { allowed: true });
        }),
    ];
  }
}

/** Builds an application with the three scope tokens and the scope controller. */
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
          [ALL_SCOPES_TOKEN]: ALL_SCOPES_RESULT,
          [ONE_SCOPE_TOKEN]: ONE_SCOPE_RESULT,
          [CLAIM_SCOPE_TOKEN]: CLAIM_SCOPE_RESULT,
        },
      })
    )
  );

  app.registerController("", ScopeController);
  return app;
}

describe("Scope guard — Specification Tests", () => {
  let shutdown: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = null;
    }
  });

  it("should allow a principal holding every requested scope", async () => {
    const app = createTestApp();
    shutdown = await app.start();

    const response = await supertest(app.express)
      .get("/scope/guard")
      .set("Authorization", `Bearer ${ALL_SCOPES_TOKEN}`)
      .expect(200);

    expect(response.body.data).toEqual({ allowed: true });
  });

  it("should deny a principal missing one requested scope", async () => {
    const app = createTestApp();
    shutdown = await app.start();

    await supertest(app.express)
      .get("/scope/guard")
      .set("Authorization", `Bearer ${ONE_SCOPE_TOKEN}`)
      .expect(403);
  });

  it("should allow a principal whose scopes come from the scope claim", async () => {
    const app = createTestApp();
    shutdown = await app.start();

    const response = await supertest(app.express)
      .get("/scope/guard")
      .set("Authorization", `Bearer ${CLAIM_SCOPE_TOKEN}`)
      .expect(200);

    expect(response.body.data).toEqual({ allowed: true });
  });
});
