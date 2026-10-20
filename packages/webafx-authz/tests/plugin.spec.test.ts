/**
 * Specification tests for the claims translator plugin.
 *
 * These tests describe how an application installs a translator: the plugin
 * registers it as a singleton service under the default name, and a custom
 * service name can be supplied when more than one translator is needed. They
 * are derived from the authorization requirements and written before the
 * implementation; a failing case means the implementation is wrong, never the
 * test.
 *
 * @packageDocumentation
 */

import { describe, it, expect, afterEach } from "vitest";
import supertest from "supertest";
import { WebApplication, BaseController } from "@blendsdk/webafx";
import type { RouteDefinition } from "@blendsdk/webafx";
import type { ClaimsTranslator } from "@blendsdk/authz";
import {
  CLAIMS_TRANSLATOR_SERVICE,
  createClaimsTranslatorPlugin,
} from "../src/index.js";

/** Role returned by the translator installed under the default name. */
const DEFAULT_SENTINEL = "default-sentinel";

/** Role returned by the translator installed under a custom name. */
const CUSTOM_SENTINEL = "custom-sentinel";

/** Custom service name used to prove the option is honored. */
const CUSTOM_SERVICE_NAME = "custom-translator";

/**
 * Creates a translator that always reports a single sentinel role.
 *
 * The sentinel role makes the resolved service identifiable without relying on
 * object identity.
 */
function sentinelTranslator(role: string): ClaimsTranslator {
  return {
    translate: () => ({ roles: [role], permissions: [] }),
  };
}

/**
 * Controller with one route per service name.
 *
 * Each route resolves a translator and reports the role it produced, so the
 * response shows which translator the container returned.
 */
class PluginController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get("/plugin/default")
        .handle(async (req, res) => {
          const translator = await req.services.get<ClaimsTranslator>(
            CLAIMS_TRANSLATOR_SERVICE,
            undefined
          );
          this.ok(res, {
            roles: translator ? translator.translate({ userInfo: {} }).roles : [],
          });
        }),

      this.route()
        .get("/plugin/custom")
        .handle(async (req, res) => {
          const translator = await req.services.get<ClaimsTranslator>(
            CUSTOM_SERVICE_NAME,
            undefined
          );
          this.ok(res, {
            roles: translator ? translator.translate({ userInfo: {} }).roles : [],
          });
        }),
    ];
  }
}

/** Builds an application that installs the given plugin and the controller. */
function createTestApp(
  plugin: ReturnType<typeof createClaimsTranslatorPlugin>
): WebApplication {
  const app = new WebApplication({
    PORT: 0,
    ENV_MODE: "test",
    LOG_LEVEL: "ERROR",
  });

  app.use(plugin);
  app.registerController("", PluginController);
  return app;
}

describe("Claims translator plugin — Specification Tests", () => {
  let shutdown: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = null;
    }
  });

  it("should register the translator under the default service name", async () => {
    const app = createTestApp(
      createClaimsTranslatorPlugin(sentinelTranslator(DEFAULT_SENTINEL))
    );
    shutdown = await app.start();

    const response = await supertest(app.express)
      .get("/plugin/default")
      .expect(200);

    expect(response.body.data).toEqual({ roles: [DEFAULT_SENTINEL] });
  });

  it("should register the translator under a custom service name", async () => {
    const app = createTestApp(
      createClaimsTranslatorPlugin(sentinelTranslator(CUSTOM_SENTINEL), {
        serviceName: CUSTOM_SERVICE_NAME,
      })
    );
    shutdown = await app.start();

    const response = await supertest(app.express)
      .get("/plugin/custom")
      .expect(200);

    expect(response.body.data).toEqual({ roles: [CUSTOM_SENTINEL] });
  });
});
