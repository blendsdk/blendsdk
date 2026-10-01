/**
 * Unit tests for mail plugin factory functions.
 *
 * No Docker required — uses MemoryMailProvider for all plugin tests.
 * Covers createMailPlugin, smtpMailPlugin, memoryMailPlugin, and createMailProvider.
 */

import { describe, it, expect, afterEach } from "vitest";
import { MailProvider } from "../src/abstract-mail-provider.js";
import {
    createMailPlugin,
    createMailProvider,
    memoryMailPlugin,
    smtpMailPlugin,
} from "../src/mail-plugin.js";
import { MemoryMailProvider } from "../src/memory-mail-provider.js";
import { SmtpMailProvider } from "../src/smtp-mail-provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Track providers to clean up after tests */
const providersToCleanup: MailProvider[] = [];

afterEach(async () => {
    for (const provider of providersToCleanup) {
        try {
            await provider.shutdown();
        } catch {
            // Ignore shutdown errors in cleanup
        }
    }
    providersToCleanup.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMailPlugin", () => {
    it("should return a valid PluginDefinition with name, factory, and priority", () => {
        const provider = new MemoryMailProvider();
        providersToCleanup.push(provider);

        const plugin = createMailPlugin(provider);

        expect(plugin).toBeDefined();
        expect(plugin.name).toBe("mailer"); // Default serviceName
        expect(typeof plugin.factory).toBe("function");
        expect(plugin.priority).toBe(30); // Default priority
    });

    it("should use provider.serviceName as the plugin name", () => {
        const provider = new MemoryMailProvider({ serviceName: "my-mailer" });
        providersToCleanup.push(provider);

        const plugin = createMailPlugin(provider);

        expect(plugin.name).toBe("my-mailer");
    });

    it("should use default priority of 30 when not specified", () => {
        const provider = new MemoryMailProvider();
        providersToCleanup.push(provider);

        const plugin = createMailPlugin(provider);

        expect(plugin.priority).toBe(30);
    });

    it("should accept custom priority via options", () => {
        const provider = new MemoryMailProvider();
        providersToCleanup.push(provider);

        const plugin = createMailPlugin(provider, { priority: 10 });

        expect(plugin.priority).toBe(10);
    });

    it("should accept priority of 0", () => {
        const provider = new MemoryMailProvider();
        providersToCleanup.push(provider);

        const plugin = createMailPlugin(provider, { priority: 0 });

        expect(plugin.priority).toBe(0);
    });
});

describe("memoryMailPlugin", () => {
    it("should return a valid PluginDefinition", () => {
        const plugin = memoryMailPlugin();

        expect(plugin).toBeDefined();
        expect(plugin.name).toBe("mailer");
        expect(typeof plugin.factory).toBe("function");
        expect(plugin.priority).toBe(30);
    });

    it("should respect custom serviceName", () => {
        const plugin = memoryMailPlugin({ serviceName: "mem-mailer" });

        expect(plugin.name).toBe("mem-mailer");
    });
});

describe("smtpMailPlugin", () => {
    it("should return a valid PluginDefinition", () => {
        // Note: This creates an SMTP transport that will try to connect.
        // We don't call factory(), so the connection attempt is just in the background.
        const plugin = smtpMailPlugin({
            host: "localhost",
            port: 1025,
            secure: false,
        });

        expect(plugin).toBeDefined();
        expect(plugin.name).toBe("mailer");
        expect(typeof plugin.factory).toBe("function");
        expect(plugin.priority).toBe(30);
    });

    it("should respect custom serviceName", () => {
        const plugin = smtpMailPlugin({
            host: "localhost",
            port: 1025,
            secure: false,
            serviceName: "smtp-mailer",
        });

        expect(plugin.name).toBe("smtp-mailer");
    });
});

describe("createMailProvider", () => {
    it("should return MemoryMailProvider for type='memory'", () => {
        const provider = createMailProvider({ type: "memory" });
        providersToCleanup.push(provider);

        expect(provider).toBeInstanceOf(MemoryMailProvider);
    });

    it("should return SmtpMailProvider for type='smtp'", () => {
        const provider = createMailProvider({
            type: "smtp",
            host: "localhost",
            port: 1025,
        });
        providersToCleanup.push(provider);

        expect(provider).toBeInstanceOf(SmtpMailProvider);
    });

    it("should pass serviceName through to the provider", () => {
        const provider = createMailProvider({
            type: "memory",
            serviceName: "custom-mailer",
        });
        providersToCleanup.push(provider);

        expect(provider.serviceName).toBe("custom-mailer");
    });

    it("should default serviceName to 'mailer'", () => {
        const provider = createMailProvider({ type: "memory" });
        providersToCleanup.push(provider);

        expect(provider.serviceName).toBe("mailer");
    });

    it("should throw for unknown mail type", () => {
        expect(() =>
            createMailProvider({
                type: "sendgrid" as "smtp",
            })
        ).toThrow('Unknown mail type: "sendgrid"');
    });

    it("should include supported types in the error message", () => {
        expect(() =>
            createMailProvider({
                type: "invalid" as "smtp",
            })
        ).toThrow('Supported types: "smtp", "memory"');
    });
});
