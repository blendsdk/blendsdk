/**
 * Unit tests for MemoryMailProvider.
 *
 * No Docker required — tests the in-memory mail backend in isolation.
 * Covers all MailProvider abstract methods, recipient handling,
 * helper methods (getSentMessages, getLastMessage, clear), and lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryMailProvider } from "../src/memory-mail-provider.js";
import type { MailMessage } from "../src/types.js";

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

/** Standard test message for simple send tests */
const testMessage: MailMessage = {
    from: "sender@test.com",
    to: "recipient@test.com",
    subject: "Test Email",
    text: "Hello, this is a test email.",
    html: "<p>Hello, this is a test email.</p>",
};

/** Message with multiple recipients across to, cc, and bcc */
const multiRecipientMessage: MailMessage = {
    from: "sender@test.com",
    to: ["alice@test.com", "bob@test.com"],
    cc: "charlie@test.com",
    bcc: "dave@test.com",
    subject: "Multi-recipient Test",
    text: "Hello everyone!",
};

/** Message with a file attachment */
const attachmentMessage: MailMessage = {
    from: "sender@test.com",
    to: "recipient@test.com",
    subject: "Email with Attachment",
    text: "See attached.",
    attachments: [
        {
            filename: "test.txt",
            content: Buffer.from("Hello, world!"),
            contentType: "text/plain",
        },
    ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryMailProvider", () => {
    let mailer: MemoryMailProvider;

    beforeEach(() => {
        mailer = new MemoryMailProvider();
    });

    afterEach(async () => {
        await mailer.shutdown();
    });

    // -------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------

    describe("constructor", () => {
        it("should use default service name 'mailer' when no config provided", () => {
            expect(mailer.serviceName).toBe("mailer");
        });

        it("should accept empty config object", () => {
            const provider = new MemoryMailProvider({});
            expect(provider.serviceName).toBe("mailer");
        });

        it("should use custom serviceName when provided", () => {
            const provider = new MemoryMailProvider({ serviceName: "email" });
            expect(provider.serviceName).toBe("email");
        });

        it("should start with no sent messages", () => {
            expect(mailer.getSentMessages()).toHaveLength(0);
        });
    });

    // -------------------------------------------------------------------
    // send()
    // -------------------------------------------------------------------

    describe("send", () => {
        it("should store a sent message", async () => {
            await mailer.send(testMessage);

            const sent = mailer.getSentMessages();
            expect(sent).toHaveLength(1);
            expect(sent[0].message).toBe(testMessage);
        });

        it("should store multiple messages in order", async () => {
            const msg1: MailMessage = { ...testMessage, subject: "First" };
            const msg2: MailMessage = { ...testMessage, subject: "Second" };
            const msg3: MailMessage = { ...testMessage, subject: "Third" };

            await mailer.send(msg1);
            await mailer.send(msg2);
            await mailer.send(msg3);

            const sent = mailer.getSentMessages();
            expect(sent).toHaveLength(3);
            expect(sent[0].message.subject).toBe("First");
            expect(sent[1].message.subject).toBe("Second");
            expect(sent[2].message.subject).toBe("Third");
        });

        it("should return MailResult with single recipient in accepted", async () => {
            const result = await mailer.send(testMessage);

            expect(result.accepted).toEqual(["recipient@test.com"]);
            expect(result.rejected).toEqual([]);
            expect(result.messageId).toBeDefined();
        });

        it("should return MailResult with array recipients in accepted", async () => {
            const msg: MailMessage = {
                from: "sender@test.com",
                to: ["alice@test.com", "bob@test.com"],
                subject: "Test",
                text: "Hello",
            };
            const result = await mailer.send(msg);

            expect(result.accepted).toContain("alice@test.com");
            expect(result.accepted).toContain("bob@test.com");
            expect(result.rejected).toEqual([]);
        });

        it("should include cc recipients in accepted list", async () => {
            const result = await mailer.send(multiRecipientMessage);

            expect(result.accepted).toContain("charlie@test.com");
        });

        it("should include bcc recipients in accepted list", async () => {
            const result = await mailer.send(multiRecipientMessage);

            expect(result.accepted).toContain("dave@test.com");
        });

        it("should include all recipients (to + cc + bcc) in accepted", async () => {
            const result = await mailer.send(multiRecipientMessage);

            expect(result.accepted).toEqual([
                "alice@test.com",
                "bob@test.com",
                "charlie@test.com",
                "dave@test.com",
            ]);
        });

        it("should handle single cc string", async () => {
            const msg: MailMessage = {
                from: "sender@test.com",
                to: "recipient@test.com",
                cc: "cc@test.com",
                subject: "CC Test",
                text: "Hello",
            };
            const result = await mailer.send(msg);

            expect(result.accepted).toContain("cc@test.com");
        });

        it("should handle array cc", async () => {
            const msg: MailMessage = {
                from: "sender@test.com",
                to: "recipient@test.com",
                cc: ["cc1@test.com", "cc2@test.com"],
                subject: "CC Test",
                text: "Hello",
            };
            const result = await mailer.send(msg);

            expect(result.accepted).toContain("cc1@test.com");
            expect(result.accepted).toContain("cc2@test.com");
        });

        it("should handle single bcc string", async () => {
            const msg: MailMessage = {
                from: "sender@test.com",
                to: "recipient@test.com",
                bcc: "bcc@test.com",
                subject: "BCC Test",
                text: "Hello",
            };
            const result = await mailer.send(msg);

            expect(result.accepted).toContain("bcc@test.com");
        });

        it("should handle array bcc", async () => {
            const msg: MailMessage = {
                from: "sender@test.com",
                to: "recipient@test.com",
                bcc: ["bcc1@test.com", "bcc2@test.com"],
                subject: "BCC Test",
                text: "Hello",
            };
            const result = await mailer.send(msg);

            expect(result.accepted).toContain("bcc1@test.com");
            expect(result.accepted).toContain("bcc2@test.com");
        });

        it("should generate a messageId with memory prefix", async () => {
            const result = await mailer.send(testMessage);

            expect(result.messageId).toMatch(/^<memory-\d+-\d+@test>$/);
        });

        it("should generate unique messageIds for consecutive sends", async () => {
            const result1 = await mailer.send(testMessage);
            const result2 = await mailer.send(testMessage);

            expect(result1.messageId).not.toBe(result2.messageId);
        });

        it("should store messages with attachments", async () => {
            await mailer.send(attachmentMessage);

            const sent = mailer.getSentMessages();
            expect(sent[0].message.attachments).toHaveLength(1);
            expect(sent[0].message.attachments![0].filename).toBe("test.txt");
        });

        it("should store both message and result together", async () => {
            const result = await mailer.send(testMessage);

            const stored = mailer.getSentMessages()[0];
            expect(stored.message).toBe(testMessage);
            expect(stored.result).toEqual(result);
        });
    });

    // -------------------------------------------------------------------
    // getSentMessages()
    // -------------------------------------------------------------------

    describe("getSentMessages", () => {
        it("should return empty array when no messages sent", () => {
            expect(mailer.getSentMessages()).toEqual([]);
        });

        it("should return a copy (not the internal array)", async () => {
            await mailer.send(testMessage);

            const sent1 = mailer.getSentMessages();
            const sent2 = mailer.getSentMessages();

            // Different array references but same content
            expect(sent1).not.toBe(sent2);
            expect(sent1).toEqual(sent2);
        });

        it("should not be affected by mutating the returned array", async () => {
            await mailer.send(testMessage);

            const sent = mailer.getSentMessages();
            sent.length = 0; // Mutate the copy

            // Internal store should be unaffected
            expect(mailer.getSentMessages()).toHaveLength(1);
        });
    });

    // -------------------------------------------------------------------
    // getLastMessage()
    // -------------------------------------------------------------------

    describe("getLastMessage", () => {
        it("should return undefined when no messages sent", () => {
            expect(mailer.getLastMessage()).toBeUndefined();
        });

        it("should return the last sent message", async () => {
            await mailer.send({ ...testMessage, subject: "First" });
            await mailer.send({ ...testMessage, subject: "Last" });

            const last = mailer.getLastMessage();
            expect(last).toBeDefined();
            expect(last!.message.subject).toBe("Last");
        });

        it("should return the only message when one is sent", async () => {
            await mailer.send(testMessage);

            const last = mailer.getLastMessage();
            expect(last!.message).toBe(testMessage);
        });
    });

    // -------------------------------------------------------------------
    // clear()
    // -------------------------------------------------------------------

    describe("clear", () => {
        it("should remove all stored messages", async () => {
            await mailer.send(testMessage);
            await mailer.send(testMessage);

            mailer.clear();

            expect(mailer.getSentMessages()).toHaveLength(0);
            expect(mailer.getLastMessage()).toBeUndefined();
        });

        it("should allow sending new messages after clear", async () => {
            await mailer.send({ ...testMessage, subject: "Before" });
            mailer.clear();
            await mailer.send({ ...testMessage, subject: "After" });

            const sent = mailer.getSentMessages();
            expect(sent).toHaveLength(1);
            expect(sent[0].message.subject).toBe("After");
        });
    });

    // -------------------------------------------------------------------
    // health()
    // -------------------------------------------------------------------

    describe("health", () => {
        it("should always return true", async () => {
            const result = await mailer.health();
            expect(result).toBe(true);
        });

        it("should return true even after sending messages", async () => {
            await mailer.send(testMessage);
            const result = await mailer.health();
            expect(result).toBe(true);
        });
    });

    // -------------------------------------------------------------------
    // shutdown()
    // -------------------------------------------------------------------

    describe("shutdown", () => {
        it("should clear all stored messages", async () => {
            await mailer.send(testMessage);
            await mailer.send(testMessage);

            await mailer.shutdown();

            expect(mailer.getSentMessages()).toHaveLength(0);
        });

        it("should complete without error when no messages stored", async () => {
            // Should not throw
            await mailer.shutdown();
        });
    });
});
