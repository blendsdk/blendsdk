/**
 * Type definitions and constants for the @blendsdk/webafx-mailer package.
 *
 * Defines mail message structures, provider configuration interfaces,
 * and the factory configuration with type discriminator for environment-based
 * backend switching.
 */

// ---------------------------------------------------------------------------
// Mail Message Types
// ---------------------------------------------------------------------------

/**
 * Email attachment definition.
 *
 * Represents a file to attach to an outgoing email. Content can be
 * provided as a raw Buffer or a base64-encoded string.
 */
export interface MailAttachment {
    /** Filename for the attachment (e.g., "report.pdf") */
    filename: string;
    /** Attachment content — Buffer for binary data, or base64-encoded string */
    content: Buffer | string;
    /** MIME content type (e.g., "application/pdf", "text/plain") */
    contentType?: string;
}

/**
 * Email message to send.
 *
 * Represents a complete outgoing email. At least one of `text` or `html`
 * should be provided for message body content.
 */
export interface MailMessage {
    /** Sender email address (e.g., "noreply@example.com" or "Name <email>") */
    from: string;
    /** Recipient(s) — single address or array of addresses */
    to: string | string[];
    /** CC recipient(s) — optional carbon copy addresses */
    cc?: string | string[];
    /** BCC recipient(s) — optional blind carbon copy addresses */
    bcc?: string | string[];
    /** Email subject line */
    subject: string;
    /** Plain text body — used as fallback when HTML is also provided */
    text?: string;
    /** HTML body — rich email content */
    html?: string;
    /** File attachments */
    attachments?: MailAttachment[];
}

/**
 * Result of a send operation.
 *
 * Contains information about which recipients accepted or rejected
 * the message, plus the server-assigned message ID.
 */
export interface MailResult {
    /** Email addresses that accepted the message */
    accepted: string[];
    /** Email addresses that rejected the message */
    rejected: string[];
    /** Message ID assigned by the mail server (e.g., "<abc123@smtp.example.com>") */
    messageId?: string;
}

// ---------------------------------------------------------------------------
// Provider Configuration Types
// ---------------------------------------------------------------------------

/**
 * Base configuration shared by all mail providers.
 *
 * Every provider implementation accepts at least these options.
 */
export interface MailProviderConfig {
    /**
     * Service name for WebAFX service container registration.
     * Default: "mailer". Use different names for multi-provider scenarios
     * (e.g., "transactional-mailer", "marketing-mailer").
     */
    serviceName?: string;
}

/**
 * SMTP-specific mail configuration.
 *
 * Extends the base config with all settings needed to connect to
 * an SMTP server via nodemailer.
 */
export interface SmtpMailConfig extends MailProviderConfig {
    /** SMTP server hostname (e.g., "smtp.example.com") */
    host: string;
    /** SMTP server port (common: 25, 465 for TLS, 587 for STARTTLS) */
    port: number;
    /** Use direct TLS connection (true for port 465, false for STARTTLS on 587) */
    secure?: boolean;
    /** SMTP authentication credentials — omit for unauthenticated servers */
    auth?: {
        user: string;
        pass: string;
    };
    /** Additional TLS options — allows configuring certificate validation etc. */
    tls?: {
        rejectUnauthorized?: boolean;
        [key: string]: unknown;
    };
}

/**
 * Memory-specific mail configuration.
 *
 * No additional fields beyond the base config. The memory provider
 * stores messages in-memory for test assertion purposes.
 */
export interface MemoryMailConfig extends MailProviderConfig {}

/**
 * Factory configuration with type discriminator.
 *
 * Used by `createMailProvider()` for environment-based backend switching.
 * The `type` field determines which provider is instantiated, and
 * SMTP-specific fields are only used when `type === "smtp"`.
 */
export interface MailFactoryConfig {
    /** Mail backend type — determines which provider to create */
    type: "smtp" | "memory";
    /** Service name for WebAFX service container. Default: "mailer" */
    serviceName?: string;

    // --- SMTP-specific (only used when type === "smtp") ---

    /** SMTP server hostname */
    host?: string;
    /** SMTP server port */
    port?: number;
    /** Use direct TLS connection */
    secure?: boolean;
    /** SMTP authentication credentials */
    auth?: { user: string; pass: string };
    /** Additional TLS options */
    tls?: { rejectUnauthorized?: boolean; [key: string]: unknown };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default service name for mail when not specified in config */
export const DEFAULT_SERVICE_NAME = "mailer";
