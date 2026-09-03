/**
 * In-memory mail provider for testing.
 *
 * Stores all sent messages in an array that can be queried for test assertions.
 * Does not actually send any emails — purely for development and testing use.
 *
 * Provides helper methods for test assertions:
 * - `getSentMessages()` — returns all sent messages (as a copy)
 * - `getLastMessage()` — returns the most recently sent message
 * - `clear()` — empties the stored messages
 *
 * @example
 * ```typescript
 * const mailer = new MemoryMailProvider();
 * await mailer.send({ from: "a@b.com", to: "c@d.com", subject: "Hi", text: "Hello" });
 *
 * const sent = mailer.getSentMessages();
 * expect(sent).toHaveLength(1);
 * expect(sent[0].message.subject).toBe("Hi");
 * ```
 */

import { MailProvider } from "./abstract-mail-provider.js";
import type { MailMessage, MailResult, MemoryMailConfig } from "./types.js";

/** Stored message entry — includes both the original message and send result */
export interface SentMailEntry {
    /** The original mail message as submitted to send() */
    message: MailMessage;
    /** The result returned from send() */
    result: MailResult;
}

export class MemoryMailProvider extends MailProvider {
    /** Internal store of all sent messages */
    protected messages: SentMailEntry[] = [];

    /**
     * Create a new in-memory mail provider.
     *
     * @param config - Optional config; defaults to `{ serviceName: "mailer" }`
     */
    constructor(config?: MemoryMailConfig) {
        super(config ?? {});
    }

    /**
     * "Send" an email by storing it in memory.
     *
     * All recipients (to, cc, bcc) are marked as accepted.
     * A deterministic messageId is generated for test predictability.
     *
     * @param message - The email message to store
     * @returns Result with all recipients in accepted list
     */
    async send(message: MailMessage): Promise<MailResult> {
        // Normalize all recipient fields to arrays for consistent result format
        const toArray = Array.isArray(message.to) ? message.to : [message.to];
        const ccArray = message.cc
            ? Array.isArray(message.cc)
                ? message.cc
                : [message.cc]
            : [];
        const bccArray = message.bcc
            ? Array.isArray(message.bcc)
                ? message.bcc
                : [message.bcc]
            : [];

        const result: MailResult = {
            accepted: [...toArray, ...ccArray, ...bccArray],
            rejected: [],
            messageId: `<memory-${Date.now()}-${this.messages.length}@test>`,
        };

        this.messages.push({ message, result });
        return result;
    }

    /**
     * Get all sent messages (for test assertions).
     *
     * Returns a shallow copy of the internal array to prevent
     * external mutation of the stored data.
     *
     * @returns Array of all sent message entries (message + result)
     */
    getSentMessages(): SentMailEntry[] {
        return [...this.messages];
    }

    /**
     * Get the last sent message (convenience for single-email tests).
     *
     * @returns The most recently sent entry, or undefined if no messages sent
     */
    getLastMessage(): SentMailEntry | undefined {
        return this.messages.length > 0
            ? this.messages[this.messages.length - 1]
            : undefined;
    }

    /**
     * Clear all stored messages.
     *
     * Useful for resetting state between test cases.
     */
    clear(): void {
        this.messages = [];
    }

    /**
     * Health check — always returns true.
     *
     * The memory provider has no external dependencies,
     * so it's always "healthy".
     */
    async health(): Promise<boolean> {
        return true;
    }

    /**
     * Graceful shutdown — clears all stored messages.
     *
     * Releases the in-memory message store.
     */
    async shutdown(): Promise<void> {
        this.clear();
    }
}
