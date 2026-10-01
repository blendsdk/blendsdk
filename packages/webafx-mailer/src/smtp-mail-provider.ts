/**
 * SMTP mail provider using nodemailer.
 *
 * Wraps nodemailer's transport to provide a clean MailProvider interface
 * with health check and graceful shutdown support. The underlying transport
 * handles connection pooling internally.
 *
 * Key design decisions vs. v3:
 * - `secure` defaults to false (modern SMTP uses STARTTLS on port 587)
 * - No hardcoded `tls.rejectUnauthorized: false` — configurable via `tls` option
 * - `transporter.verify()` for health check — tests SMTP connection without sending
 * - `transporter.close()` for graceful shutdown — closes the connection pool
 *
 * @example
 * ```typescript
 * const mailer = new SmtpMailProvider({
 *     host: "smtp.example.com",
 *     port: 587,
 *     secure: false,
 *     auth: { user: "user@example.com", pass: "secret" },
 * });
 * await mailer.send({ from: "a@b.com", to: "c@d.com", subject: "Hi", text: "Hello" });
 * ```
 */

import nodemailer from "nodemailer";

import { MailProvider } from "./abstract-mail-provider.js";
import type { MailMessage, MailResult, SmtpMailConfig } from "./types.js";

export class SmtpMailProvider extends MailProvider {
    /** Nodemailer transport instance — handles SMTP connection pooling */
    protected transporter: nodemailer.Transporter;

    /**
     * Create a new SMTP mail provider.
     *
     * @param config - SMTP connection settings (host, port, auth, TLS options)
     */
    constructor(config: SmtpMailConfig) {
        super(config);

        // Create nodemailer transport with provided SMTP settings.
        // secure defaults to false — most modern SMTP servers use STARTTLS on port 587.
        this.transporter = nodemailer.createTransport({
            host: config.host,
            port: config.port,
            secure: config.secure ?? false,
            auth: config.auth,
            tls: config.tls,
        });
    }

    /**
     * Send an email via SMTP.
     *
     * Converts our MailMessage to nodemailer's format and sends it.
     * Array recipients are joined with commas as nodemailer expects.
     *
     * @param message - The email message to send
     * @returns Result with accepted/rejected addresses and message ID
     * @throws Error on SMTP connection failure, auth failure, or send rejection
     */
    async send(message: MailMessage): Promise<MailResult> {
        const info = await this.transporter.sendMail({
            from: message.from,
            to: Array.isArray(message.to) ? message.to.join(", ") : message.to,
            cc: message.cc
                ? Array.isArray(message.cc)
                    ? message.cc.join(", ")
                    : message.cc
                : undefined,
            bcc: message.bcc
                ? Array.isArray(message.bcc)
                    ? message.bcc.join(", ")
                    : message.bcc
                : undefined,
            subject: message.subject,
            text: message.text,
            html: message.html,
            attachments: message.attachments?.map((a) => ({
                filename: a.filename,
                content: a.content,
                contentType: a.contentType,
            })),
        });

        return {
            accepted: Array.isArray(info.accepted) ? info.accepted.map(String) : [],
            rejected: Array.isArray(info.rejected) ? info.rejected.map(String) : [],
            messageId: info.messageId,
        };
    }

    /**
     * Health check — verifies the SMTP connection is alive.
     *
     * Uses nodemailer's `verify()` which performs an EHLO/HELO handshake
     * with the server without sending any email.
     *
     * @returns true if SMTP server is reachable and accepts connections
     */
    async health(): Promise<boolean> {
        try {
            await this.transporter.verify();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Graceful shutdown — closes the nodemailer transport.
     *
     * Releases the underlying TCP connection pool. After calling this,
     * subsequent `send()` calls will fail.
     */
    async shutdown(): Promise<void> {
        this.transporter.close();
    }
}
