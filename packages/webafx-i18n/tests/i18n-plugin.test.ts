import { describe, expect, it, vi } from "vitest";
import { createI18nPlugin } from "../src/i18n-plugin.js";
import type { TranslationSource, TranslationCatalog } from "@blendsdk/i18n";
import type { PluginDefinition } from "@blendsdk/webafx";

/**
 * Create a mock TranslationSource for testing.
 */
function mockSource(
    name: string,
    catalog: TranslationCatalog
): TranslationSource {
    return {
        name,
        load: vi.fn().mockResolvedValue(catalog),
    };
}

/**
 * Create a mock logger.
 */
function mockLogger() {
    return {
        info: vi.fn().mockResolvedValue(undefined),
        error: vi.fn().mockResolvedValue(undefined),
        warn: vi.fn().mockResolvedValue(undefined),
        debug: vi.fn().mockResolvedValue(undefined),
    };
}

/**
 * Create a mock WebApplication with service registration tracking.
 */
function mockApp() {
    const services: Record<string, any> = {};
    return {
        registerService: vi.fn((def: any) => {
            services[def.name] = def;
        }),
        services: {
            get: vi.fn().mockRejectedValue(new Error("Service not found")),
        },
        _registeredServices: services,
    };
}

describe("createI18nPlugin", () => {
    describe("plugin definition", () => {
        it("should return a PluginDefinition", () => {
            const plugin = createI18nPlugin({
                sources: [],
            });

            expect(plugin.name).toBe("i18n");
            expect(plugin.priority).toBe(40);
            expect(typeof plugin.factory).toBe("function");
        });

        it("should use custom service name", () => {
            const plugin = createI18nPlugin({
                sources: [],
                serviceName: "translations",
            });

            expect(plugin.name).toBe("translations");
        });

        it("should use custom priority", () => {
            const plugin = createI18nPlugin({
                sources: [],
                priority: 10,
            });

            expect(plugin.priority).toBe(10);
        });
    });

    describe("factory execution", () => {
        it("should load sources and register services", async () => {
            const source = mockSource("TestSource", {
                greeting: { en: "Hello", nl: "Hallo" },
            });

            const plugin = createI18nPlugin({
                sources: [source],
                defaultLocale: "en",
            });

            const app = mockApp();
            const logger = mockLogger();

            const result = await plugin.factory({
                app: app as any,
                express: {} as any,
                logger,
            });

            // Source should have been loaded
            expect(source.load).toHaveBeenCalled();

            // Should register i18n, i18n:reload, and locale services
            expect(app.registerService).toHaveBeenCalledTimes(3);
            expect(app._registeredServices["i18n"]).toBeDefined();
            expect(app._registeredServices["i18n:reload"]).toBeDefined();
            expect(app._registeredServices["locale"]).toBeDefined();

            // Should return a Plugin with health check
            expect(result).toBeDefined();
            expect(typeof result!.health).toBe("function");
            expect(await result!.health!()).toBe(true);
        });

        it("should load from multiple sources", async () => {
            const source1 = mockSource("Source1", {
                greeting: { en: "Hello" },
            });
            const source2 = mockSource("Source2", {
                greeting: { en: "Hi" }, // Override
                farewell: { en: "Bye" },
            });

            const plugin = createI18nPlugin({
                sources: [source1, source2],
            });

            const app = mockApp();
            const logger = mockLogger();

            await plugin.factory({
                app: app as any,
                express: {} as any,
                logger,
            });

            expect(source1.load).toHaveBeenCalled();
            expect(source2.load).toHaveBeenCalled();

            // The singleton factory should return a Translator with merged catalog
            const singletonDef = app._registeredServices["i18n"];
            const translator = singletonDef.factory();
            expect(translator.translate("greeting", "en")).toBe("Hi"); // From source2
            expect(translator.translate("farewell", "en")).toBe("Bye");
        });

        it("should handle empty sources array", async () => {
            const plugin = createI18nPlugin({ sources: [] });

            const app = mockApp();
            const logger = mockLogger();

            await plugin.factory({
                app: app as any,
                express: {} as any,
                logger,
            });

            // Should still register services
            expect(app.registerService).toHaveBeenCalledTimes(3);
        });

        it("should use custom service names", async () => {
            const plugin = createI18nPlugin({
                sources: [],
                serviceName: "translator",
                localeServiceName: "request-locale",
            });

            const app = mockApp();
            const logger = mockLogger();

            await plugin.factory({
                app: app as any,
                express: {} as any,
                logger,
            });

            expect(app._registeredServices["translator"]).toBeDefined();
            expect(app._registeredServices["request-locale"]).toBeDefined();
        });

        it("should pass onMissingTranslation to Translator", async () => {
            const onMissing = vi.fn();
            const plugin = createI18nPlugin({
                sources: [],
                onMissingTranslation: onMissing,
            });

            const app = mockApp();
            const logger = mockLogger();

            await plugin.factory({
                app: app as any,
                express: {} as any,
                logger,
            });

            // Get the translator and trigger a missing key
            const singletonDef = app._registeredServices["i18n"];
            const translator = singletonDef.factory();
            translator.translate("missing.key", "en");
            expect(onMissing).toHaveBeenCalledWith("missing.key", "en");
        });
    });

    describe("pub/sub reload", () => {
        it("should gracefully handle missing pubsub service", async () => {
            const plugin = createI18nPlugin({
                sources: [],
                reloadChannel: "i18n:reload",
            });

            const app = mockApp();
            const logger = mockLogger();

            // Should not throw — graceful degradation
            await expect(
                plugin.factory({
                    app: app as any,
                    express: {} as any,
                    logger,
                })
            ).resolves.toBeDefined();

            // Should log that pubsub is not available
            expect(logger.info).toHaveBeenCalledWith(
                expect.stringContaining("not available")
            );
        });
    });

    describe("singleton service", () => {
        it("should register i18n as singleton type", async () => {
            const plugin = createI18nPlugin({
                sources: [mockSource("Test", { greeting: { en: "Hello" } })],
            });

            const app = mockApp();
            const logger = mockLogger();

            await plugin.factory({
                app: app as any,
                express: {} as any,
                logger,
            });

            expect(app._registeredServices["i18n"].type).toBe("singleton");
        });
    });

    describe("locale service", () => {
        it("should register locale as per-request type", async () => {
            const plugin = createI18nPlugin({
                sources: [],
            });

            const app = mockApp();
            const logger = mockLogger();

            await plugin.factory({
                app: app as any,
                express: {} as any,
                logger,
            });

            expect(app._registeredServices["locale"].type).toBe("per-request");
        });
    });
});
