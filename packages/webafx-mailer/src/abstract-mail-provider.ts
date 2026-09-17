/**
 * Abstract base class for all mail provider implementations.
 *
 * All mail backends (SMTP, Memory) derive from this class, providing
 * a uniform API for sending emails with health check and graceful
 * shutdown support. This mirrors the CacheProvider pattern from
 * @blendsdk/webafx-cache.
 *
 * @example
 * ```typescript
 * // Usage via concrete provider:
 * const mailer: MailProvider = new SmtpMailProvider({ host: "smtp.example.com", port: 587 });
 * const result = await mailer.send({ from: "a@b.com", to: "c@d.com", subject: "Hi", text: "Hello" });
 * ```
 */

import type { MailMessage, MailProviderConfig, MailResult } from "./types.js";
import { DEFAULT_SERVICE_NAME } from "./types.js";

export abstract class MailProvider {
    /**
     * Service name used for WebAFX service container registration.
     * Defaults to "mailer" unless overridden in config.
     */
    protected _serviceName: string;

    /**
     * @param config - Base provider configuration with optional service name
     */
    constructor(config: MailProviderConfig) {
        this._serviceName = config.serviceName ?? DEFAULT_SERVICE_NAME;
    }

    /**
     * Get the service name used for WebAFX service container registration.
     * This name is used when registering the provider as a singleton service.
     */
    get serviceName(): string {
        return this._serviceName;
    }

    /**
     * Send an email message.
     *
     * @param message - The email message to send (from, to, subject, body, etc.)
     * @returns Result with accepted/rejected recipients and server-assigned message ID
     * @throws Error if sending fails (connection issues, auth failures, etc.)
     */
    abstract send(message: MailMessage): Promise<MailResult>;

    /**
     * Health check — returns true if the backend is operational.
     *
     * For SMTP: verifies the transport connection via EHLO/HELO.
     * For Memory: always returns true (no external dependencies).
     */
    abstract health(): Promise<boolean>;

    /**
     * Graceful shutdown — close connections and release resources.
     *
     * For SMTP: closes the nodemailer transport and connection pool.
     * For Memory: clears all stored messages.
     */
    abstract shutdown(): Promise<void>;
}
