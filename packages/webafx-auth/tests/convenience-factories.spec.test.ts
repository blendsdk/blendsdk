/**
 * Specification tests for convenience factory functions.
 *
 * ST-28: oidcAuthPlugin() returns a valid PluginDefinition
 * ST-29: jwtAuthPlugin() returns a valid PluginDefinition
 * ST-30: memoryAuthPlugin() returns a valid PluginDefinition
 *
 * Each factory is a thin wrapper: create provider → delegate to createAuthPlugin().
 * These tests verify the wrappers produce correct PluginDefinitions and forward options.
 *
 * @remarks No Docker required — all unit tests.
 */

import { describe, it, expect } from "vitest";
import {
    oidcAuthPlugin,
    jwtAuthPlugin,
    memoryAuthPlugin,
} from "../src/auth-plugin.js";
import type { OidcAuthConfig } from "../src/oidc-types.js";
import type { JwtAuthConfig, MemoryAuthConfig } from "../src/types.js";

// ---------------------------------------------------------------------------
// Test Configs
// ---------------------------------------------------------------------------

const OIDC_CONFIG: OidcAuthConfig = {
    issuerUrl: "https://auth.example.com",
    clientId: "test-client",
    clientSecret: "test-secret",
    redirectUri: "https://app.example.com/auth/callback",
};

const JWT_CONFIG: JwtAuthConfig = {
    secret: "test-secret-key-at-least-32-chars-long!!",
};

const MEMORY_CONFIG: MemoryAuthConfig = {
    validTokens: {
        "test-token": {
            sub: "user-1",
            claims: { role: "admin" },
            token: "test-token",
        },
    },
};

// ---------------------------------------------------------------------------
// Specification Tests
// ---------------------------------------------------------------------------

describe("Convenience Factories — Specification Tests", () => {
    describe("ST-28: oidcAuthPlugin()", () => {
        it("returns a PluginDefinition with name, priority, and factory", () => {
            const plugin = oidcAuthPlugin(OIDC_CONFIG);

            expect(plugin).toBeDefined();
            expect(plugin.name).toMatch(/^auth:/);
            expect(typeof plugin.priority).toBe("number");
            expect(typeof plugin.factory).toBe("function");
        });

        it("forwards AuthPluginOptions to the plugin", () => {
            const plugin = oidcAuthPlugin(OIDC_CONFIG, {
                serviceName: "oidc",
                priority: 5,
            });

            expect(plugin.name).toBe("auth:oidc");
            expect(plugin.priority).toBe(5);
        });
    });

    describe("ST-29: jwtAuthPlugin()", () => {
        it("returns a PluginDefinition with name, priority, and factory", () => {
            const plugin = jwtAuthPlugin(JWT_CONFIG);

            expect(plugin).toBeDefined();
            expect(plugin.name).toMatch(/^auth:/);
            expect(typeof plugin.priority).toBe("number");
            expect(typeof plugin.factory).toBe("function");
        });

        it("forwards AuthPluginOptions to the plugin", () => {
            const plugin = jwtAuthPlugin(JWT_CONFIG, {
                serviceName: "jwt",
                priority: 3,
            });

            expect(plugin.name).toBe("auth:jwt");
            expect(plugin.priority).toBe(3);
        });
    });

    describe("ST-30: memoryAuthPlugin()", () => {
        it("returns a PluginDefinition with name, priority, and factory", () => {
            const plugin = memoryAuthPlugin(MEMORY_CONFIG);

            expect(plugin).toBeDefined();
            expect(plugin.name).toMatch(/^auth:/);
            expect(typeof plugin.priority).toBe("number");
            expect(typeof plugin.factory).toBe("function");
        });

        it("forwards AuthPluginOptions to the plugin", () => {
            const plugin = memoryAuthPlugin(MEMORY_CONFIG, {
                serviceName: "test-auth",
                priority: 1,
            });

            expect(plugin.name).toBe("auth:test-auth");
            expect(plugin.priority).toBe(1);
        });
    });
});
