/**
 * Contract tests for MailProvider implementations.
 *
 * Verifies that both SmtpMailProvider and MemoryMailProvider satisfy
 * the abstract MailProvider contract. Runs the same test suite against
 * each provider to ensure consistent behavior across backends.
 *
 * SMTP tests require Mailpit Docker container running on port 1025.
 * Memory tests run without Docker.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MailProvider } from "../src/abstract-mail-provider.js";
import { MemoryMailProvider } from "../src/memory-mail-provider.js";
import { SmtpMailProvider } from "../src/smtp-mail-provider.js";
import type { MailMessage } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mailpit helper (for SMTP cleanup between tests)
// ---------------------------------------------------------------------------

const MAILPIT_API = "http://localhost:8025/api/v1";

async function clearMailpit(): Promise<void> {
    await fetch(`${MAILPIT_API}/messages`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

/** Simple test message used for all contract tests */
const contractMessage: MailMessage = {
    from: "contract-sender@test.com",
    to: "contract-recipient@test.com",
    subject: "Contract Test",
    text: "Testing the MailProvider contract.",
};

// ---------------------------------------------------------------------------
// Contract Test Suite — runs against each provider implementation
// ---------------------------------------------------------------------------

/**
 * Shared contract test suite that runs against any MailProvider.
 * Ensures all providers behave consistently for the core contract.
 *
 * @param name - Provider name for the describe block
 * @param factory - Factory function to create a provider instance
 * @param beforeEachHook - Optional setup function run before each test
 */
function runContractTests(
    name: string,
    factory: () => MailProvider,
    beforeEachHook?: () => Promise<void>
) {
    describe(`MailProvider contract: ${name}`, () => {
        let provider: MailProvider;

        beforeEach(async () => {
            if (beforeEachHook) {
                await beforeEachHook();
            }
            provider = factory();
        });

        afterEach(async () => {
            // Guard against provider being undefined if beforeEach hook failed
            // (e.g., when Mailpit Docker isn't running)
            if (provider) {
                await provider.shutdown();
            }
        });

        // ---------------------------------------------------------------
        // send() contract
        // ---------------------------------------------------------------

        describe("send()", () => {
            it("should return a MailResult with accepted array", async () => {
                const result = await provider.send(contractMessage);

                expect(result).toBeDefined();
                expect(Array.isArray(result.accepted)).toBe(true);
                expect(result.accepted.length).toBeGreaterThan(0);
            });

            it("should return a MailResult with rejected array", async () => {
                const result = await provider.send(contractMessage);

                expect(Array.isArray(result.rejected)).toBe(true);
            });

            it("should return a non-empty messageId when the provider supplies one", async () => {
                const result = await provider.send(contractMessage);

                // Asynchronous APIs such as Microsoft Graph accept a request
                // without returning a transport message identifier.
                if (result.messageId !== undefined) {
                    expect(typeof result.messageId).toBe("string");
                    expect(result.messageId.length).toBeGreaterThan(0);
                }
            });

            it("should include the recipient in accepted list", async () => {
                const result = await provider.send(contractMessage);

                expect(result.accepted).toContain("contract-recipient@test.com");
            });
        });

        // ---------------------------------------------------------------
        // health() contract
        // ---------------------------------------------------------------

        describe("health()", () => {
            it("should return a boolean", async () => {
                const result = await provider.health();

                expect(typeof result).toBe("boolean");
            });

            it("should return true when provider is operational", async () => {
                const result = await provider.health();

                expect(result).toBe(true);
            });
        });

        // ---------------------------------------------------------------
        // shutdown() contract
        // ---------------------------------------------------------------

        describe("shutdown()", () => {
            it("should complete without throwing", async () => {
                // Should not throw
                await provider.shutdown();
            });
        });

        // ---------------------------------------------------------------
        // serviceName contract
        // ---------------------------------------------------------------

        describe("serviceName", () => {
            it("should default to 'mailer'", () => {
                expect(provider.serviceName).toBe("mailer");
            });
        });
    });
}

// ---------------------------------------------------------------------------
// Run contract tests for both providers
// ---------------------------------------------------------------------------

// Memory provider — no Docker needed
runContractTests("MemoryMailProvider", () => new MemoryMailProvider());

// SMTP provider — requires Mailpit Docker on port 1025/8025
runContractTests(
    "SmtpMailProvider",
    () =>
        new SmtpMailProvider({
            host: "localhost",
            port: 1025,
            secure: false,
        }),
    // Clear Mailpit between tests to avoid cross-test interference
    clearMailpit
);

// ---------------------------------------------------------------------------
// Custom serviceName contract test (both providers)
// ---------------------------------------------------------------------------

describe("MailProvider serviceName override", () => {
    it("should respect custom serviceName for MemoryMailProvider", () => {
        const provider = new MemoryMailProvider({ serviceName: "custom-mail" });
        expect(provider.serviceName).toBe("custom-mail");
    });

    it("should respect custom serviceName for SmtpMailProvider", () => {
        const provider = new SmtpMailProvider({
            host: "localhost",
            port: 1025,
            secure: false,
            serviceName: "smtp-notifications",
        });
        expect(provider.serviceName).toBe("smtp-notifications");
    });
});
