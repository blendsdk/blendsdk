/**
 * @blendsdk/webafx-mailer — Email sending plugin for WebAFX
 *
 * Provides an email sending abstraction with two backends:
 *
 * - MailProvider (abstract) → SmtpMailProvider, MemoryMailProvider
 * - Plugin factories: createMailPlugin(), smtpMailPlugin(), memoryMailPlugin(), createMailProvider()
 *
 * The SMTP backend uses nodemailer for reliable email delivery.
 * The Memory backend stores messages in-memory for testing.
 *
 * Both integrate with WebAFX via convenience plugin factory functions that
 * register providers as application-wide singleton services.
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Mail Message Types
// ---------------------------------------------------------------------------
export type { MailAttachment, MailMessage, MailResult } from "./types.js";

// ---------------------------------------------------------------------------
// Provider Configuration Types
// ---------------------------------------------------------------------------
export type {
    MailProviderConfig,
    SmtpMailConfig,
    MemoryMailConfig,
    MailFactoryConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export { DEFAULT_SERVICE_NAME } from "./types.js";

// ---------------------------------------------------------------------------
// Abstract Base Class
// ---------------------------------------------------------------------------
export { MailProvider } from "./abstract-mail-provider.js";

// ---------------------------------------------------------------------------
// Provider Implementations
// ---------------------------------------------------------------------------
export { SmtpMailProvider } from "./smtp-mail-provider.js";
export { MemoryMailProvider, type SentMailEntry } from "./memory-mail-provider.js";

// ---------------------------------------------------------------------------
// Plugin Integration (WebAFX)
// ---------------------------------------------------------------------------
export {
    createMailPlugin,
    smtpMailPlugin,
    memoryMailPlugin,
    createMailProvider,
} from "./mail-plugin.js";
