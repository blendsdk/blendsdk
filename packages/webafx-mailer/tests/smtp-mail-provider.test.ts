/**
 * Integration tests for SmtpMailProvider.
 *
 * Requires Mailpit Docker container running on port 1025 (SMTP) / 8025 (API).
 * Start with: docker-compose -p webafx-mailer -f ./docker/docker-compose.yml up -d
 *
 * Tests verify actual SMTP sending against a Mailpit fake server,
 * then use the Mailpit REST API to assert messages were received correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SmtpMailProvider } from "../src/smtp-mail-provider.js";
import type { MailMessage } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mailpit REST API Helpers
// ---------------------------------------------------------------------------

/** Mailpit REST API base URL */
const MAILPIT_API = "http://localhost:8025/api/v1";

/**
 * Fetch all messages from Mailpit.
 * Returns the messages array from the Mailpit API response.
 */
async function getMailpitMessages(): Promise<MailpitMessage[]> {
    const response = await fetch(`${MAILPIT_API}/messages`);
    const data = (await response.json()) as { messages: MailpitMessage[] };
    return data.messages ?? [];
}

/**
 * Poll Mailpit until a message with the given subject appears.
 * Handles the race condition where Mailpit hasn't finished indexing
 * a message after the SMTP send completes. Returns only the matching
 * message, making assertions immune to stale messages from prior tests.
 */
async function waitForMessage(subject: string): Promise<MailpitMessage> {
    const maxAttempts = 25;
    for (let i = 0; i < maxAttempts; i++) {
        const messages = await getMailpitMessages();
        const match = messages.find((m) => m.Subject === subject);
        if (match) return match;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out waiting for Mailpit message with subject "${subject}"`);
}

/**
 * Delete all messages from Mailpit.
 * Used to clean up between tests for isolation.
 */
async function clearMailpit(): Promise<void> {
    await fetch(`${MAILPIT_API}/messages`, { method: "DELETE" });
}

/** Simplified Mailpit message type for test assertions */
interface MailpitMessage {
    ID: string;
    From: { Address: string; Name: string };
    To: Array<{ Address: string; Name: string }>;
    Cc: Array<{ Address: string; Name: string }>;
    Bcc: Array<{ Address: string; Name: string }>;
    Subject: string;
    Snippet: string;
    Attachments: number;
}

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

/** SMTP config pointing to local Mailpit container */
const mailpitConfig = {
    host: "localhost",
    port: 1025,
    secure: false,
};

/** Standard test message */
const testMessage: MailMessage = {
    from: "sender@test.com",
    to: "recipient@test.com",
    subject: "SMTP Test Email",
    text: "Hello from SMTP test.",
    html: "<p>Hello from SMTP test.</p>",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SmtpMailProvider (Mailpit integration)", () => {
    let mailer: SmtpMailProvider;

    beforeEach(async () => {
        mailer = new SmtpMailProvider(mailpitConfig);
        // Clear any messages from previous tests
        await clearMailpit();
    });

    afterEach(async () => {
        await mailer.shutdown();
    });

    // -------------------------------------------------------------------
    // send()
    // -------------------------------------------------------------------

    describe("send", () => {
        it("should send a plain text email", async () => {
            const msg: MailMessage = {
                from: "sender@test.com",
                to: "recipient@test.com",
                subject: "Plain Text Test",
                text: "Hello, plain text!",
            };

            const result = await mailer.send(msg);

            expect(result.accepted).toContain("recipient@test.com");
            expect(result.messageId).toBeDefined();

            // Verify via Mailpit API (poll until indexed)
            const message = await waitForMessage("Plain Text Test");
            expect(message.Subject).toBe("Plain Text Test");
        });

        it("should send an HTML email", async () => {
            const msg: MailMessage = {
                from: "sender@test.com",
                to: "recipient@test.com",
                subject: "HTML Test",
                html: "<h1>Hello, HTML!</h1>",
            };

            await mailer.send(msg);

            const message = await waitForMessage("HTML Test");
            expect(message.Subject).toBe("HTML Test");
        });

        it("should send to multiple recipients", async () => {
            const msg: MailMessage = {
                from: "sender@test.com",
                to: ["alice@test.com", "bob@test.com"],
                subject: "Multi Recipient",
                text: "Hello everyone!",
            };

            const result = await mailer.send(msg);

            // Both recipients should be accepted
            expect(result.accepted).toContain("alice@test.com");
            expect(result.accepted).toContain("bob@test.com");

            // Mailpit should show the message with both recipients (poll until indexed)
            const message = await waitForMessage("Multi Recipient");
            const toAddresses = message.To.map((t) => t.Address);
            expect(toAddresses).toContain("alice@test.com");
            expect(toAddresses).toContain("bob@test.com");
        });

        it("should send with CC recipients", async () => {
            const msg: MailMessage = {
                from: "sender@test.com",
                to: "recipient@test.com",
                cc: "cc@test.com",
                subject: "CC Test",
                text: "Hello!",
            };

            await mailer.send(msg);

            const message = await waitForMessage("CC Test");
            const ccAddresses = message.Cc.map((c) => c.Address);
            expect(ccAddresses).toContain("cc@test.com");
        });

        it("should send with attachments", async () => {
            const msg: MailMessage = {
                from: "sender@test.com",
                to: "recipient@test.com",
                subject: "Attachment Test",
                text: "See attached.",
                attachments: [
                    {
                        filename: "test.txt",
                        content: Buffer.from("Hello, attachment!"),
                        contentType: "text/plain",
                    },
                ],
            };

            await mailer.send(msg);

            const message = await waitForMessage("Attachment Test");
            expect(message.Attachments).toBe(1);
        });

        it("should return correct MailResult structure", async () => {
            const result = await mailer.send(testMessage);

            expect(result).toHaveProperty("accepted");
            expect(result).toHaveProperty("rejected");
            expect(result).toHaveProperty("messageId");
            expect(Array.isArray(result.accepted)).toBe(true);
            expect(Array.isArray(result.rejected)).toBe(true);
        });
    });

    // -------------------------------------------------------------------
    // health()
    // -------------------------------------------------------------------

    describe("health", () => {
        it("should return true when connected to Mailpit", async () => {
            const result = await mailer.health();
            expect(result).toBe(true);
        });

        it("should return false when pointing to wrong port", async () => {
            // Create a provider pointing to a non-existent SMTP server
            const badMailer = new SmtpMailProvider({
                host: "localhost",
                port: 19999, // Non-existent port
                secure: false,
            });

            const result = await badMailer.health();
            expect(result).toBe(false);

            await badMailer.shutdown();
        });
    });

    // -------------------------------------------------------------------
    // shutdown()
    // -------------------------------------------------------------------

    describe("shutdown", () => {
        it("should complete without error", async () => {
            // Should not throw
            await mailer.shutdown();
        });
    });

    // -------------------------------------------------------------------
    // Error handling
    // -------------------------------------------------------------------

    describe("error handling", () => {
        it("should throw when SMTP server is unreachable", async () => {
            const badMailer = new SmtpMailProvider({
                host: "localhost",
                port: 19999, // Non-existent port
                secure: false,
            });

            await expect(badMailer.send(testMessage)).rejects.toThrow();

            await badMailer.shutdown();
        });
    });

    // -------------------------------------------------------------------
    // Constructor / Configuration
    // -------------------------------------------------------------------

    describe("constructor", () => {
        it("should use default serviceName 'mailer'", () => {
            expect(mailer.serviceName).toBe("mailer");
        });

        it("should use custom serviceName when provided", () => {
            const customMailer = new SmtpMailProvider({
                ...mailpitConfig,
                serviceName: "notifications",
            });
            expect(customMailer.serviceName).toBe("notifications");
        });
    });
});
