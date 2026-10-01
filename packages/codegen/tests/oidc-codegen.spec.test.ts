/**
 * Specification tests for OIDC routes in generated OpenAPI output.
 *
 * The OIDC BFF controller annotates its five routes with `.openapi()` metadata.
 * This fixture builds an OpenAPI document from the controller's `routes()` and
 * asserts the resulting paths and operations, proving the codegen path
 * independently of the playground, which intentionally does not register the
 * OIDC controller (it has no OIDC provider).
 *
 * Scope: this is a document-level check. The login and callback routes only
 * produce redirects (no 2xx response body), so a strict typed client would emit
 * no callable method for them; that behavior is a codegen concern for consumers
 * who choose to register the controller, not part of this feature.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from "vitest";
import { OidcAuthController } from "@blendsdk/webafx-auth";

import { OpenAPIGenerator } from "../src/generator/openapi-generator.js";
import type { OpenAPIOperation } from "../src/generator/openapi-types.js";

/** Concrete controller so the abstract base can be instantiated by codegen. */
class TestOidcController extends OidcAuthController {}

/** The five OIDC BFF paths the controller documents. */
const EXPECTED_PATHS = [
    "/api/oidc/login",
    "/api/oidc/callback",
    "/api/oidc/logout",
    "/api/oidc/me",
    "/api/oidc/refresh",
];

/** Build a document from the OIDC controller's annotated routes. */
function generate(): ReturnType<OpenAPIGenerator["generate"]> {
    const generator = new OpenAPIGenerator({
        title: "OIDC API",
        version: "1.0.0",
    });
    // The controller's routes already include the /api/oidc prefix, so the
    // registration base path is empty to avoid duplicating it.
    generator.addController("", TestOidcController);
    return generator.generate();
}

describe("OIDC codegen — Specification Tests", () => {
    it("generates the five annotated /api/oidc paths (ST-37)", () => {
        const document = generate();

        expect(Object.keys(document.paths)).toEqual(
            expect.arrayContaining(EXPECTED_PATHS)
        );
    });

    it("tags every generated OIDC operation and gives it a unique id (ST-37)", () => {
        const document = generate();
        const operations = Object.values(document.paths).flatMap(pathItem =>
            Object.values(pathItem).filter(
                (operation): operation is OpenAPIOperation =>
                    operation !== undefined
            )
        );

        expect(operations).toHaveLength(EXPECTED_PATHS.length);

        const ids = new Set<string>();
        for (const operation of operations) {
            expect(operation.tags).toContain("oidc");
            expect(typeof operation.operationId).toBe("string");
            if (operation.operationId) {
                ids.add(operation.operationId);
            }
        }
        expect(ids.size).toBe(EXPECTED_PATHS.length);
    });
});
