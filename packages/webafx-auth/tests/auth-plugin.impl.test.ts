/**
 * Implementation tests for createAuthPlugin.
 *
 * Tests edge cases, custom options, and internal behavior that go beyond
 * the specification tests. These tests verify implementation details
 * NOT covered by the spec test cases (ST-1 through ST-6).
 *
 * @packageDocumentation
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { createAuthPlugin } from "../src/auth-plugin.js";
import type { AuthPluginOptions } from "../src/auth-plugin.js";
import { MemoryAuthProvider } from "../src/memory-auth-provider.js";
import type { AuthResult } from "../src/types.js";
import { createBearerRequest, createMockRequest } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Shared Fixtures
// ---------------------------------------------------------------------------

/** Known test token */
const TEST_TOKEN = "impl-test-token";

/** AuthResult for the known token */
const TEST_AUTH_RESULT: AuthResult = {
    sub: "impl-user",
    claims: { role: "tester" },
    token: TEST_TOKEN,
};

/**
 * Create a mock WebApplication with registerService spy.
 * Returns captured registrations for inspection.
 */
function createMockApp() {
    const registeredServices: Array<{
        name: string;
        type: string;
        factory: (...args: unknown[]) => unknown;
    }> = [];

    const app = {
        registerService: vi.fn(
            (def: {
                name: string;
                type: string;
                factory: (...args: unknown[]) => unknown;
            }) => {
                registeredServices.push(def);
            }
        ),
    };

    return { app, registeredServices };
}

/** Create a mock Logger with vitest spies */
function createMockLogger() {
    return {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    };
}

/** Execute a plugin factory with mocks and return all captured state */
async function executePluginFactory(plugin: {
    factory: (params: {
        app: unknown;
        express: unknown;
        logger: unknown;
    }) => Promise<unknown>;
}) {
    const { app, registeredServices } = createMockApp();
    const logger = createMockLogger();

    const result = await plugin.factory({
        app,
        express: {},
        logger,
    });

    return { app, registeredServices, logger, result };
}

// ---------------------------------------------------------------------------
// Implementation Tests
// ---------------------------------------------------------------------------

describe("Implementation: createAuthPlugin", () => {
    let provider: MemoryAuthProvider;

    beforeEach(() => {
        provider = new MemoryAuthProvider({
            validTokens: { [TEST_TOKEN]: TEST_AUTH_RESULT },
        });
    });

    // -----------------------------------------------------------------------
    // Custom Options
    // -----------------------------------------------------------------------

    describe("custom options", () => {
        it("should use custom userServiceName for the per-request service registration", async () => {
            const plugin = createAuthPlugin(provider, {
                userServiceName: "current-user",
            });
            const { registeredServices } = await executePluginFactory(plugin);

            // The per-request service should use the custom name
            const userService = registeredServices.find(
                (s) => s.name === "current-user"
            );
            expect(userService).toBeDefined();
            expect(userService!.type).toBe("per-request");

            // Should NOT register under default name 'user'
            const defaultUser = registeredServices.find(
                (s) => s.name === "user"
            );
            expect(defaultUser).toBeUndefined();
        });

        it("should use custom priority in the returned PluginDefinition", () => {
            const plugin = createAuthPlugin(provider, { priority: 5 });

            expect(plugin.priority).toBe(5);
        });

        it("should apply all custom options simultaneously", async () => {
            const options: AuthPluginOptions = {
                serviceName: "my-auth",
                userServiceName: "authenticated-user",
                priority: 25,
            };
            const plugin = createAuthPlugin(provider, options);

            // Check plugin definition shape
            expect(plugin.name).toBe("auth:my-auth");
            expect(plugin.priority).toBe(25);

            // Check registered service names
            const { registeredServices } = await executePluginFactory(plugin);

            const authService = registeredServices.find(
                (s) => s.name === "my-auth"
            );
            expect(authService).toBeDefined();
            expect(authService!.type).toBe("singleton");

            const userService = registeredServices.find(
                (s) => s.name === "authenticated-user"
            );
            expect(userService).toBeDefined();
            expect(userService!.type).toBe("per-request");
        });

        it("should handle empty options object the same as no options", () => {
            const pluginDefault = createAuthPlugin(provider);
            const pluginEmpty = createAuthPlugin(provider, {});

            expect(pluginDefault.name).toBe(pluginEmpty.name);
            expect(pluginDefault.priority).toBe(pluginEmpty.priority);
        });
    });

    // -----------------------------------------------------------------------
    // Logger Output
    // -----------------------------------------------------------------------

    describe("logger output", () => {
        it("should log provider class name and service name on installation", async () => {
            const plugin = createAuthPlugin(provider);
            const { logger } = await executePluginFactory(plugin);

            // Logger.info should be called once with the provider class name
            expect(logger.info).toHaveBeenCalledTimes(1);

            const logMessage = logger.info.mock.calls[0][0] as string;
            expect(logMessage).toContain("MemoryAuthProvider");
            expect(logMessage).toContain("'auth'");
        });

        it("should include custom service name in the log message", async () => {
            const plugin = createAuthPlugin(provider, {
                serviceName: "custom-auth",
            });
            const { logger } = await executePluginFactory(plugin);

            const logMessage = logger.info.mock.calls[0][0] as string;
            expect(logMessage).toContain("'custom-auth'");
        });
    });

    // -----------------------------------------------------------------------
    // Singleton Provider Identity
    // -----------------------------------------------------------------------

    describe("singleton provider registration", () => {
        it("should register the exact same provider instance as the singleton factory return value", async () => {
            const plugin = createAuthPlugin(provider);
            const { registeredServices } = await executePluginFactory(plugin);

            // Get the singleton factory and call it
            const authService = registeredServices.find(
                (s) => s.name === "auth"
            );
            const resolved = authService!.factory();

            // The factory should return the exact same provider object (identity check)
            expect(resolved).toBe(provider);
        });
    });

    // -----------------------------------------------------------------------
    // Per-Request Factory Delegation
    // -----------------------------------------------------------------------

    describe("per-request factory delegation", () => {
        it("should delegate authenticate() calls through the per-request factory with custom service names", async () => {
            const plugin = createAuthPlugin(provider, {
                serviceName: "alt-auth",
                userServiceName: "alt-user",
            });
            const { registeredServices } = await executePluginFactory(plugin);

            // Get the per-request factory for 'alt-user'
            const userService = registeredServices.find(
                (s) => s.name === "alt-user"
            );
            expect(userService).toBeDefined();

            // Call with a valid token — should still delegate to provider.authenticate()
            const req = createBearerRequest(TEST_TOKEN);
            const result = await userService!.factory(
                {} /* container */,
                {} /* settings */,
                req,
                {} /* res */,
                (() => {}) /* next */
            );

            expect(result).toEqual(TEST_AUTH_RESULT);
        });

        it("should handle provider that returns undefined for unknown tokens", async () => {
            const plugin = createAuthPlugin(provider);
            const { registeredServices } = await executePluginFactory(plugin);

            const userService = registeredServices.find(
                (s) => s.name === "user"
            );

            // Call with a Bearer token that doesn't exist in the MemoryAuthProvider
            const req = createBearerRequest("unknown-token");
            const result = await userService!.factory(
                {} /* container */,
                {} /* settings */,
                req,
                {} /* res */,
                (() => {}) /* next */
            );

            expect(result).toBeUndefined();
        });
    });
});
