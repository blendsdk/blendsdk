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

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { connect } from "node:net";
import { MailProvider } from "../src/abstract-mail-provider.js";
import { MemoryMailProvider } from "../src/memory-mail-provider.js";
import { SmtpMailProvider } from "../src/smtp-mail-provider.js";
import type { MailMessage } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mailpit helper (for SMTP cleanup between tests)
// ---------------------------------------------------------------------------

const MAILPIT_API = "http://localhost:8025/api/v1";
const SMTP_HOST = "localhost";
const SMTP_PORT = 1025;

async function clearMailpit(): Promise<void> {
    await fetch(`${MAILPIT_API}/messages`, { method: "DELETE" });
}

/**
 * Checks whether a TCP port accepts connections.
 *
 * @param host - Host to connect to.
 * @param port - Port to connect to.
 * @param timeoutMs - Maximum time to wait for the connection.
 * @returns True when the connection succeeds.
 */
function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
        const socket = connect({ host, port });

        const finish = (reachable: boolean): void => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(reachable);
        };

        socket.setTimeout(timeoutMs);
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.once("timeout", () => finish(false));
    });
}

/**
 * Waits for Mailpit's SMTP listener before the contract tests start.
 *
 * The compose healthcheck polls the HTTP API, and `docker-compose up -d`
 * does not wait for it. A fixed sleep is unreliable on loaded CI runners, so
 * the suite waits for the SMTP port the tests actually use.
 *
 * @throws Error when the port is not reachable within 30 seconds.
 */
async function waitForSmtp(): Promise<void> {
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
        if (await canConnect(SMTP_HOST, SMTP_PORT, 1_000)) return;
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    throw new Error(
        `Mailpit SMTP at ${SMTP_HOST}:${SMTP_PORT} did not become ready within 30 seconds.`,
    );
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
describe("SmtpMailProvider (Mailpit)", () => {
    beforeAll(async () => {
        await waitForSmtp();
    }, 30_000);

    runContractTests(
        "SmtpMailProvider",
        () =>
            new SmtpMailProvider({
                host: SMTP_HOST,
                port: SMTP_PORT,
                secure: false,
            }),
        // Clear Mailpit between tests to avoid cross-test interference
        clearMailpit
    );
});

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
            host: SMTP_HOST,
            port: SMTP_PORT,
            secure: false,
            serviceName: "smtp-notifications",
        });
        expect(provider.serviceName).toBe("smtp-notifications");
    });
});
