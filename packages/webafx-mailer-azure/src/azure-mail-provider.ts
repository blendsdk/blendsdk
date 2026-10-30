/**
 * Microsoft Graph implementation of the common BlendSDK mail provider.
 */

import { ConfidentialClientApplication } from '@azure/msal-node';
import {
  MailProvider,
  type MailAttachment,
  type MailMessage,
  type MailResult,
} from '@blendsdk/webafx-mailer';

import type { AzureMailConfig } from './types.js';

/** Microsoft Graph scope used for app-only permissions configured in Entra. */
const GRAPH_DEFAULT_SCOPE = 'https://graph.microsoft.com/.default';

/** Stable Microsoft Graph endpoint used for Exchange Online mail submission. */
const GRAPH_ENDPOINT = 'https://graph.microsoft.com/v1.0';

/** Requests are bounded so an unavailable network cannot hold shutdown indefinitely. */
const GRAPH_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Direct Graph attachments must remain below 3 MiB. Larger files require a
 * draft and upload-session workflow with broader mailbox permissions.
 */
export const MAX_DIRECT_ATTACHMENT_BYTES = 3 * 1024 * 1024 - 1;

/** Maximum lengths used to reject malformed or abusive input before network calls. */
const MAX_EMAIL_LENGTH = 254;
const MAX_SUBJECT_LENGTH = 998;
const MAX_FILENAME_LENGTH = 255;
const MAX_CONTENT_TYPE_LENGTH = 127;
const MAX_CLIENT_SECRET_LENGTH = 4096;

/** A parsed mailbox address suitable for the Microsoft Graph JSON model. */
interface ParsedMailbox {
  /** Validated email address without a display name. */
  address: string;
  /** Optional validated display name. */
  name?: string;
}

/** Microsoft Graph recipient wrapper. */
interface GraphRecipient {
  /** Recipient address information. */
  emailAddress: ParsedMailbox;
}

/** Microsoft Graph file-attachment representation. */
interface GraphFileAttachment {
  /** Graph discriminator for a file attachment. */
  '@odata.type': '#microsoft.graph.fileAttachment';
  /** Filename presented to the recipient. */
  name: string;
  /** Optional MIME content type. */
  contentType?: string;
  /** Base64-encoded file bytes. */
  contentBytes: string;
}

/** Microsoft Graph message payload used by the `sendMail` action. */
interface GraphMessage {
  /** Email subject. */
  subject: string;
  /** Sender shown on the message. */
  from: GraphRecipient;
  /** Primary recipients. */
  toRecipients: GraphRecipient[];
  /** Carbon-copy recipients, when supplied. */
  ccRecipients?: GraphRecipient[];
  /** Blind-carbon-copy recipients, when supplied. */
  bccRecipients?: GraphRecipient[];
  /** Single Graph body; HTML is preferred when both common body forms exist. */
  body: {
    contentType: 'HTML' | 'Text';
    content: string;
  };
  /** Direct file attachments, when supplied. */
  attachments?: GraphFileAttachment[];
}

/** Complete Microsoft Graph `sendMail` request body. */
interface GraphSendMailRequest {
  /** Message submitted to Exchange Online. */
  message: GraphMessage;
  /** Controls whether Exchange Online retains a copy in Sent Items. */
  saveToSentItems: boolean;
}

/**
 * Sends BlendSDK mail messages through Microsoft Graph and Exchange Online.
 *
 * This provider uses application credentials, so the Entra application must
 * have `Mail.Send` application permission. Restrict that permission to the
 * configured mailbox with Exchange Online Application RBAC.
 *
 * @example
 * ```typescript
 * const mailer = new AzureMailProvider({
 *     tenantId: process.env.AZURE_TENANT_ID!,
 *     clientId: process.env.AZURE_CLIENT_ID!,
 *     clientSecret: process.env.AZURE_CLIENT_SECRET!,
 *     senderMailbox: "notifications@example.com",
 * });
 *
 * await mailer.send({
 *     from: "Notifications <notifications@example.com>",
 *     to: "customer@example.com",
 *     subject: "Welcome",
 *     text: "Welcome to our service.",
 * });
 * ```
 */
export class AzureMailProvider extends MailProvider {
  /** Validated provider configuration. */
  protected readonly config: Readonly<AzureMailConfig>;

  /** MSAL client responsible for secure token acquisition and caching. */
  protected readonly msalClient: ConfidentialClientApplication;

  /**
   * Creates a Microsoft Graph mail provider.
   *
   * @param config - Entra application and Exchange Online mailbox settings.
   * @throws Error when identifiers, the secret, or sender mailbox are invalid.
   */
  constructor(config: AzureMailConfig) {
    validateConfig(config);
    super(config);

    this.config = Object.freeze({ ...config });
    this.msalClient = new ConfidentialClientApplication({
      auth: {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        authority: `https://login.microsoftonline.com/${config.tenantId}`,
      },
    });
  }

  /**
   * Submits a message through the configured Exchange Online mailbox.
   *
   * A successful return means Microsoft Graph accepted the request. Graph
   * completes transport and delivery asynchronously after returning HTTP 202.
   *
   * @param message - Common BlendSDK message to submit.
   * @returns Recipients accepted for asynchronous processing by Graph.
   * @throws Error for invalid input, authentication failure, network failure,
   * or a non-success Microsoft Graph response.
   */
  async send(message: MailMessage): Promise<MailResult> {
    const request = buildGraphRequest(message, this.config);
    const accessToken = await this.acquireAccessToken();
    const mailboxPath = encodeURIComponent(this.config.senderMailbox);

    let response: Response;
    try {
      response = await fetch(`${GRAPH_ENDPOINT}/users/${mailboxPath}/sendMail`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error('Microsoft Graph email request failed.');
    }

    if (response.status !== 202) {
      throw createGraphResponseError(response);
    }

    return {
      accepted: collectRecipientAddresses(request.message),
      rejected: [],
    };
  }

  /**
   * Checks whether MSAL can obtain an application token for Microsoft Graph.
   *
   * Token acquisition cannot prove mailbox authorization without sending a
   * message or requesting extra Graph permissions, so this health check only
   * verifies authentication readiness.
   *
   * @returns `true` when an access token can be obtained; otherwise `false`.
   */
  async health(): Promise<boolean> {
    try {
      await this.acquireAccessToken();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Completes provider shutdown.
   *
   * MSAL and native fetch do not retain a transport that requires explicit
   * disposal, so this method intentionally performs no work.
   */
  async shutdown(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Obtains an app-only access token without exposing authentication details.
   *
   * @returns Non-empty Microsoft Graph bearer token.
   * @throws Error when MSAL cannot acquire a usable token.
   */
  protected async acquireAccessToken(): Promise<string> {
    try {
      const authentication = await this.msalClient.acquireTokenByClientCredential({
        scopes: [GRAPH_DEFAULT_SCOPE],
      });

      if (!authentication?.accessToken) {
        throw new Error('Microsoft Graph authentication returned no access token.');
      }

      return authentication.accessToken;
    } catch {
      throw new Error('Unable to authenticate with Microsoft Graph.');
    }
  }
}

/**
 * Validates provider configuration before secrets or identifiers reach MSAL.
 *
 * @param config - Configuration supplied by the application.
 * @throws Error when a configuration value is malformed or unsafe.
 */
function validateConfig(config: AzureMailConfig): void {
  if (!isUuid(config.clientId)) {
    throw new Error('Azure mail clientId must be a valid UUID.');
  }

  if (!isUuid(config.tenantId) && !isDomainName(config.tenantId)) {
    throw new Error('Azure mail tenantId must be a valid UUID or tenant domain.');
  }

  if (
    typeof config.clientSecret !== 'string' ||
    config.clientSecret.length === 0 ||
    config.clientSecret.length > MAX_CLIENT_SECRET_LENGTH ||
    hasControlCharacters(config.clientSecret)
  ) {
    throw new Error('Azure mail clientSecret is invalid.');
  }

  const sender = parseMailbox(config.senderMailbox, 'senderMailbox');
  if (sender.name) {
    throw new Error('Azure mail senderMailbox must not contain a display name.');
  }
}

/**
 * Builds and validates the Microsoft Graph request for a common mail message.
 *
 * @param message - Common mail message.
 * @param config - Validated provider configuration.
 * @returns Graph request ready for JSON serialization.
 */
function buildGraphRequest(
  message: MailMessage,
  config: Readonly<AzureMailConfig>
): GraphSendMailRequest {
  const from = parseMailbox(message.from, 'from');
  if (from.address.toLowerCase() !== config.senderMailbox.toLowerCase()) {
    throw new Error('Mail message from address must match the configured senderMailbox.');
  }

  validateSubject(message.subject);
  const body = selectBody(message);
  const toRecipients = parseRecipients(message.to, 'to');
  const ccRecipients = message.cc ? parseRecipients(message.cc, 'cc') : undefined;
  const bccRecipients = message.bcc ? parseRecipients(message.bcc, 'bcc') : undefined;
  const attachments = mapAttachments(message.attachments);

  return {
    message: {
      subject: message.subject,
      from: { emailAddress: from },
      toRecipients,
      ccRecipients,
      bccRecipients,
      body,
      attachments,
    },
    saveToSentItems: config.saveToSentItems ?? true,
  };
}

/**
 * Selects the single body representation supported by Graph JSON messages.
 *
 * @param message - Common mail message with optional text and HTML bodies.
 * @returns Graph body, preferring HTML when both forms are supplied.
 */
function selectBody(message: MailMessage): GraphMessage['body'] {
  if (typeof message.html === 'string' && message.html.length > 0) {
    return { contentType: 'HTML', content: message.html };
  }

  if (typeof message.text === 'string' && message.text.length > 0) {
    return { contentType: 'Text', content: message.text };
  }

  throw new Error('Mail message must contain a non-empty text or html body.');
}

/**
 * Validates a subject against transport-safe bounds.
 *
 * @param subject - Subject supplied by the application.
 * @throws Error when the subject is empty, oversized, or contains control characters.
 */
function validateSubject(subject: string): void {
  if (
    typeof subject !== 'string' ||
    subject.length === 0 ||
    subject.length > MAX_SUBJECT_LENGTH ||
    hasControlCharacters(subject)
  ) {
    throw new Error('Mail message subject is invalid.');
  }
}

/**
 * Parses one or more recipients into Graph wrappers.
 *
 * @param recipients - Single address or array from the common contract.
 * @param fieldName - Field name used in validation errors.
 * @returns Non-empty list of Graph recipients.
 */
function parseRecipients(recipients: string | string[], fieldName: string): GraphRecipient[] {
  const values = Array.isArray(recipients) ? recipients : [recipients];
  if (values.length === 0) {
    throw new Error(`Mail message ${fieldName} must contain at least one recipient.`);
  }

  return values.map(value => ({ emailAddress: parseMailbox(value, fieldName) }));
}

/**
 * Parses a plain or display-name mailbox string using a conservative allowlist.
 *
 * @param value - Mailbox such as `user@example.com` or `Name <user@example.com>`.
 * @param fieldName - Field name used in validation errors.
 * @returns Validated address and optional display name.
 */
function parseMailbox(value: string, fieldName: string): ParsedMailbox {
  if (typeof value !== 'string' || value.length === 0 || hasControlCharacters(value)) {
    throw new Error(`Mail message ${fieldName} contains an invalid email address.`);
  }

  const trimmed = value.trim();
  const displayMatch = /^([^<>]*)<([^<>]+)>$/.exec(trimmed);
  const address = displayMatch ? displayMatch[2].trim() : trimmed;
  const displayName = displayMatch ? normalizeDisplayName(displayMatch[1]) : undefined;

  if (!isEmailAddress(address)) {
    throw new Error(`Mail message ${fieldName} contains an invalid email address.`);
  }

  return displayName ? { address, name: displayName } : { address };
}

/**
 * Normalizes an optional display name without accepting nested quote syntax.
 *
 * @param value - Text before a mailbox angle bracket.
 * @returns Clean display name, or `undefined` when no name was supplied.
 */
function normalizeDisplayName(value: string): string | undefined {
  const trimmed = value.trim();
  const unquoted =
    trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1).trim() : trimmed;

  if (unquoted.length === 0) {
    return undefined;
  }

  if (unquoted.length > 128 || hasControlCharacters(unquoted) || /[<>"]/.test(unquoted)) {
    throw new Error('Mail message contains an invalid sender display name.');
  }

  return unquoted;
}

/**
 * Maps and validates direct file attachments.
 *
 * @param attachments - Attachments from the common mail contract.
 * @returns Graph attachments, or `undefined` when none were supplied.
 */
function mapAttachments(
  attachments: MailAttachment[] | undefined
): GraphFileAttachment[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  let totalBytes = 0;
  const mapped = attachments.map(attachment => {
    validateAttachmentMetadata(attachment);
    const contentBytes = encodeAttachmentContent(attachment.content);
    totalBytes += Buffer.from(contentBytes, 'base64').byteLength;

    if (totalBytes > MAX_DIRECT_ATTACHMENT_BYTES) {
      throw new Error('Mail attachments exceed the Microsoft Graph direct-send size limit.');
    }

    return {
      '@odata.type': '#microsoft.graph.fileAttachment' as const,
      name: attachment.filename,
      contentType: attachment.contentType,
      contentBytes,
    };
  });

  return mapped;
}

/**
 * Validates filename and MIME type values before JSON serialization.
 *
 * @param attachment - Common mail attachment.
 * @throws Error when metadata is malformed or unsafe.
 */
function validateAttachmentMetadata(attachment: MailAttachment): void {
  if (
    typeof attachment.filename !== 'string' ||
    attachment.filename.length === 0 ||
    attachment.filename.length > MAX_FILENAME_LENGTH ||
    hasControlCharacters(attachment.filename)
  ) {
    throw new Error('Mail attachment filename is invalid.');
  }

  if (
    attachment.contentType !== undefined &&
    (attachment.contentType.length === 0 ||
      attachment.contentType.length > MAX_CONTENT_TYPE_LENGTH ||
      !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(attachment.contentType))
  ) {
    throw new Error('Mail attachment contentType is invalid.');
  }
}

/**
 * Converts attachment content into the base64 representation required by Graph.
 *
 * Buffer content is encoded directly. String content follows the existing
 * common contract and must already be valid base64.
 *
 * @param content - Binary buffer or pre-encoded base64 string.
 * @returns Canonical base64 content.
 */
function encodeAttachmentContent(content: Buffer | string): string {
  if (Buffer.isBuffer(content)) {
    return content.toString('base64');
  }

  if (typeof content !== 'string' || !isCanonicalBase64(content)) {
    throw new Error('Mail attachment string content must be valid base64.');
  }

  return content;
}

/**
 * Collects all recipients after the Graph API has accepted the request.
 *
 * @param message - Validated Graph message.
 * @returns Recipient addresses in To, CC, then BCC order.
 */
function collectRecipientAddresses(message: GraphMessage): string[] {
  return [
    ...message.toRecipients,
    ...(message.ccRecipients ?? []),
    ...(message.bccRecipients ?? []),
  ].map(recipient => recipient.emailAddress.address);
}

/**
 * Creates a bounded operational error without exposing Graph response bodies.
 *
 * @param response - Non-success Graph response.
 * @returns Error containing status and an optional validated retry delay.
 */
function createGraphResponseError(response: Response): Error {
  const retryAfter = response.headers.get('Retry-After');
  const retryDetail =
    retryAfter && /^\d+$/.test(retryAfter) ? ` Retry after ${retryAfter} seconds.` : '';

  return new Error(
    `Microsoft Graph rejected the email request with HTTP ${response.status}.${retryDetail}`
  );
}

/** Checks whether a string is a UUID accepted for Entra application identifiers. */
function isUuid(value: string): boolean {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

/** Checks whether a string is a conservative DNS tenant name. */
function isDomainName(value: string): boolean {
  if (typeof value !== 'string' || value.length > 253 || value.length === 0) {
    return false;
  }

  const labels = value.split('.');
  return (
    labels.length >= 2 &&
    labels.every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
  );
}

/** Checks whether a mailbox address satisfies conservative RFC-style bounds. */
function isEmailAddress(value: string): boolean {
  if (value.length > MAX_EMAIL_LENGTH || value.includes('..')) {
    return false;
  }

  const separator = value.lastIndexOf('@');
  if (separator <= 0 || separator === value.length - 1) {
    return false;
  }

  const local = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  return (
    local.length <= 64 &&
    !local.startsWith('.') &&
    !local.endsWith('.') &&
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) &&
    isDomainName(domain)
  );
}

/** Checks for characters that can create header or log injection ambiguity. */
function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

/** Checks whether a string is canonical, non-empty base64 data. */
function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }

  return Buffer.from(value, 'base64').toString('base64') === value;
}
