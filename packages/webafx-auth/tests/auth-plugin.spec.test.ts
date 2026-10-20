/**
 * Specification tests for createAuthPlugin.
 *
 * These tests verify behavior specified in:
 * - ST-1 through ST-6 from plans/auth-plugin-refactor/07-testing-strategy.md
 * - 03-create-auth-plugin.md (technical specification)
 *
 * Each test traces to a specific specification test case (ST-#) and
 * its source requirement. Expectations are derived from the specification
 * documents — NOT from the implementation.
 *
 * @remarks Written BEFORE implementation (red phase).
 * @packageDocumentation
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { createAuthPlugin } from "../src/auth-plugin.js";
import type { AuthPluginOptions } from "../src/auth-plugin.js";
import { MemoryAuthProvider } from "../src/memory-auth-provider.js";
import { DEFAULT_SERVICE_NAME, DEFAULT_PLUGIN_PRIORITY } from "../src/types.js";
import type { AuthResult } from "../src/types.js";
import { createMockRequest, createBearerRequest } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Shared Fixtures
// ---------------------------------------------------------------------------

/** Known test token for MemoryAuthProvider */
const TEST_TOKEN = "valid-test-token";

/** Expected AuthResult for the test token */
const TEST_AUTH_RESULT: AuthResult = {
    sub: "user-1",
    claims: { role: "user" },
    token: TEST_TOKEN,
};

/**
 * Create a mock WebApplication with a `registerService` spy.
 * Captures all registered service definitions for assertions.
 *
 * @returns Object with the mock app and captured service registrations
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

/**
 * Create a mock Logger for plugin factory invocation.
 *
 * @returns A mock Logger with vitest spies on all log methods
 */
function createMockLogger() {
    return {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    };
}

/**
 * Execute a plugin factory with mock app, express, and logger.
 * Returns the plugin result and captured service registrations.
 */
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
// Specification Tests
// ---------------------------------------------------------------------------

describe("Specification: createAuthPlugin", () => {
    let provider: MemoryAuthProvider;

    beforeEach(() => {
        // Create a MemoryAuthProvider with a known valid token.
        // This is a real provider instance — no mocks needed (per code.md Rule 29).
        provider = new MemoryAuthProvider({
            validTokens: { [TEST_TOKEN]: TEST_AUTH_RESULT },
        });
    });

    // -----------------------------------------------------------------------
    // ST-1: Default PluginDefinition shape
    // Source: 03-create-auth-plugin.md, R1
    // -----------------------------------------------------------------------
    it("ST-1: should return PluginDefinition with name 'auth:auth' and priority 10 when called with defaults", () => {
        const plugin = createAuthPlugin(provider);

        // Plugin name follows the pattern `auth:<serviceName>`
        // Default serviceName is DEFAULT_SERVICE_NAME ('auth')
        expect(plugin.name).toBe(`auth:${DEFAULT_SERVICE_NAME}`);
        expect(plugin.name).toBe("auth:auth");

        // Default priority is DEFAULT_PLUGIN_PRIORITY (10)
        expect(plugin.priority).toBe(DEFAULT_PLUGIN_PRIORITY);
        expect(plugin.priority).toBe(10);

        // Factory must be an async function
        expect(typeof plugin.factory).toBe("function");
    });

    // -----------------------------------------------------------------------
    // ST-2: Custom serviceName in plugin name
    // Source: 03-create-auth-plugin.md, R1
    // -----------------------------------------------------------------------
    it("ST-2: should use custom serviceName in plugin name when provided", () => {
        const plugin = createAuthPlugin(provider, { serviceName: "custom" });

        // Plugin name reflects the custom service name
        expect(plugin.name).toBe("auth:custom");
    });

    // -----------------------------------------------------------------------
    // ST-3: Plugin factory registers two services
    // Source: 03-create-auth-plugin.md, R1
    // -----------------------------------------------------------------------
    it("ST-3: should register singleton 'auth' and per-request 'user' services when factory executes", async () => {
        const plugin = createAuthPlugin(provider);
        const { app, registeredServices } = await executePluginFactory(plugin);

        // The plugin factory must call app.registerService exactly twice
        expect(app.registerService).toHaveBeenCalledTimes(2);

        // First registration: provider as singleton service named 'auth'
        const authService = registeredServices.find((s) => s.name === "auth");
        expect(authService).toBeDefined();
        expect(authService!.type).toBe("singleton");

        // Second registration: user as per-request service named 'user'
        const userService = registeredServices.find((s) => s.name === "user");
        expect(userService).toBeDefined();
        expect(userService!.type).toBe("per-request");
    });

    // -----------------------------------------------------------------------
    // ST-4: Per-request user factory returns AuthResult for valid credentials
    // Source: 03-create-auth-plugin.md, R1, AR #6
    // -----------------------------------------------------------------------
    it("ST-4: should return AuthResult when per-request user factory is called with valid credentials", async () => {
        const plugin = createAuthPlugin(provider);
        const { registeredServices } = await executePluginFactory(plugin);

        // Get the per-request 'user' factory that was registered
        const userService = registeredServices.find((s) => s.name === "user");
        expect(userService).toBeDefined();

        // Call the user factory with a request containing a valid Bearer token.
        // The factory signature is PerRequestFactory: (container, settings, req, res, next) => T
        const req = createBearerRequest(TEST_TOKEN);
        const result = await userService!.factory(
            {} /* container */,
            {} /* settings */,
            req,
            {} /* res */,
            (() => {}) /* next */
        );

        // The factory delegates to provider.authenticate(req), which should
        // return the AuthResult for the known token
        expect(result).toEqual(TEST_AUTH_RESULT);
    });

    // -----------------------------------------------------------------------
    // ST-5: Per-request user factory returns undefined without credentials
    // Source: 03-create-auth-plugin.md, R1, AR #6
    // -----------------------------------------------------------------------
    it("ST-5: should return undefined when per-request user factory is called without credentials", async () => {
        const plugin = createAuthPlugin(provider);
        const { registeredServices } = await executePluginFactory(plugin);

        // Get the per-request 'user' factory that was registered
        const userService = registeredServices.find((s) => s.name === "user");
        expect(userService).toBeDefined();

        // Call the user factory with an empty request (no token anywhere)
        const req = createMockRequest();
        const result = await userService!.factory(
            {} /* container */,
            {} /* settings */,
            req,
            {} /* res */,
            (() => {}) /* next */
        );

        // No credentials → provider.authenticate() returns undefined → factory returns undefined
        expect(result).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // ST-6: Plugin factory returns health/shutdown that delegate to provider
    // Source: 03-create-auth-plugin.md, R10
    // -----------------------------------------------------------------------
    it("ST-6: should return health and shutdown functions that delegate to the provider", async () => {
        const plugin = createAuthPlugin(provider);

        // Spy on provider's health and shutdown methods to verify delegation
        const healthSpy = vi.spyOn(provider, "health");
        const shutdownSpy = vi.spyOn(provider, "shutdown");

        const { result } = await executePluginFactory(plugin);

        // Plugin factory must return a Plugin object with health and shutdown
        expect(result).toBeDefined();
        const pluginResult = result as {
            health: () => Promise<boolean>;
            shutdown: () => Promise<void>;
        };
        expect(typeof pluginResult.health).toBe("function");
        expect(typeof pluginResult.shutdown).toBe("function");

        // health() must delegate to provider.health()
        healthSpy.mockResolvedValueOnce(true);
        const healthResult = await pluginResult.health();
        expect(healthSpy).toHaveBeenCalled();
        expect(healthResult).toBe(true);

        // shutdown() must delegate to provider.shutdown()
        shutdownSpy.mockResolvedValueOnce(undefined);
        await pluginResult.shutdown();
        expect(shutdownSpy).toHaveBeenCalled();
    });
});
