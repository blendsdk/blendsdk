/**
 * Specification tests for the WebAFX access guard.
 *
 * These tests drive a real `WebApplication` and `MemoryAuthProvider` through
 * HTTP and describe what an application must observe: a caller who holds the
 * required permission is allowed, a caller who does not is forbidden, an
 * anonymous caller is rejected before authorization runs, an authorizing route
 * that is not secured still fails closed, and a custom selector can read the
 * principal from anywhere. They are derived from the authorization
 * requirements and written before the implementation; a failing case means the
 * implementation is wrong, never the test.
 *
 * @packageDocumentation
 */

import { describe, it, expect, afterEach } from "vitest";
import supertest from "supertest";
import { WebApplication, BaseController } from "@blendsdk/webafx";
import type { RouteDefinition } from "@blendsdk/webafx";
import { createAuthPlugin, MemoryAuthProvider } from "@blendsdk/webafx-auth";
import type { AuthResult } from "@blendsdk/webafx-auth";
import type { AccessPrincipal } from "@blendsdk/authz";
import { requireAccess } from "../src/index.js";

/** Permission required by the guarded route. */
const READ_PERMISSION = "invoice:read";

/** Role required by the custom-selector route. */
const ADMIN_ROLE = "admin";

/** Token for a caller who holds the required permission. */
const PERMITTED_TOKEN = "permitted-token";

/** Token for an authenticated caller who lacks the required permission. */
const FORBIDDEN_TOKEN = "forbidden-token";

/** Token whose roles live under a nested `user` claim. */
const NESTED_ADMIN_TOKEN = "nested-admin-token";

/** Principal returned for {@link PERMITTED_TOKEN}. */
const PERMITTED_RESULT: AuthResult = {
  sub: "user-permitted",
  claims: { permissions: [READ_PERMISSION] },
  token: PERMITTED_TOKEN,
};

/** Principal returned for {@link FORBIDDEN_TOKEN}. */
const FORBIDDEN_RESULT: AuthResult = {
  sub: "user-forbidden",
  claims: { permissions: ["invoice:write"] },
  token: FORBIDDEN_TOKEN,
};

/** Principal returned for {@link NESTED_ADMIN_TOKEN}. */
const NESTED_ADMIN_RESULT: AuthResult = {
  sub: "user-nested-admin",
  claims: { user: { roles: [ADMIN_ROLE] } },
  token: NESTED_ADMIN_TOKEN,
};

/**
 * Returns `true` when a runtime value is a plain record that can be indexed.
 *
 * Used instead of a type assertion so the selector reads nested claims without
 * an unsafe cast.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Reads the roles a caller holds from a `claims.user.roles` path.
 *
 * A missing or mis-shaped path contributes no roles, which is the same
 * fail-closed behavior an empty principal has.
 */
function selectNestedRoles(principal: AuthResult | undefined): AccessPrincipal {
  const user = principal ? principal.claims["user"] : undefined;
  const roles = isRecord(user) ? user["roles"] : undefined;

  return {
    roles: Array.isArray(roles)
      ? roles.filter((role): role is string => typeof role === "string")
      : [],
    permissions: [],
  };
}

/**
 * Controller with one route per requirement scenario.
 *
 * - `/guard/permission` is secure and requires a permission.
 * - `/guard/authorize-only` authorizes but is not secure, to prove a missing
 *   principal still fails closed.
 * - `/guard/custom` requires a role read through a custom selector.
 */
class GuardController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get("/guard/permission")
        .secure()
        .authorize(requireAccess({ permissions: [READ_PERMISSION] }))
        .handle(async (req, res) => {
          this.ok(res, { allowed: true });
        }),

      this.route()
        .get("/guard/authorize-only")
        .authorize(requireAccess({ roles: [ADMIN_ROLE] }))
        .handle(async (req, res) => {
          this.ok(res, { allowed: true });
        }),

      this.route()
        .get("/guard/custom")
        .secure()
        .authorize(
          requireAccess({ roles: [ADMIN_ROLE] }, { select: selectNestedRoles })
        )
        .handle(async (req, res) => {
          this.ok(res, { allowed: true });
        }),
    ];
  }
}

/**
 * Builds an application with the memory provider's three tokens and the guard
 * controller mounted at the root.
 */
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
          [PERMITTED_TOKEN]: PERMITTED_RESULT,
          [FORBIDDEN_TOKEN]: FORBIDDEN_RESULT,
          [NESTED_ADMIN_TOKEN]: NESTED_ADMIN_RESULT,
        },
      })
    )
  );

  app.registerController("", GuardController);
  return app;
}

describe("Access guard — Specification Tests", () => {
  let shutdown: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = null;
    }
  });

  it("should allow a caller who holds the required permission", async () => {
    const app = createTestApp();
    shutdown = await app.start();

    const response = await supertest(app.express)
      .get("/guard/permission")
      .set("Authorization", `Bearer ${PERMITTED_TOKEN}`)
      .expect(200);

    expect(response.body.data).toEqual({ allowed: true });
  });

  it("should forbid an authenticated caller who lacks the required permission", async () => {
    const app = createTestApp();
    shutdown = await app.start();

    await supertest(app.express)
      .get("/guard/permission")
      .set("Authorization", `Bearer ${FORBIDDEN_TOKEN}`)
      .expect(403);
  });

  it("should reject an anonymous caller before authorization runs", async () => {
    const app = createTestApp();
    shutdown = await app.start();

    await supertest(app.express).get("/guard/permission").expect(401);
  });

  it("should fail closed on an authorizing route that is not secure", async () => {
    const app = createTestApp();
    shutdown = await app.start();

    await supertest(app.express).get("/guard/authorize-only").expect(403);
  });

  it("should allow a caller whose grants a custom selector reads", async () => {
    const app = createTestApp();
    shutdown = await app.start();

    const response = await supertest(app.express)
      .get("/guard/custom")
      .set("Authorization", `Bearer ${NESTED_ADMIN_TOKEN}`)
      .expect(200);

    expect(response.body.data).toEqual({ allowed: true });
  });
});
