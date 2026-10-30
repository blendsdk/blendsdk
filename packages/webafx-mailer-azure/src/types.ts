/**
 * Configuration types for Microsoft Graph email delivery.
 */

import type { MailProviderConfig } from '@blendsdk/webafx-mailer';

/**
 * Configures app-only Microsoft Graph email delivery through Exchange Online.
 *
 * The Entra application must have the Microsoft Graph `Mail.Send` application
 * permission and access to the configured sender mailbox.
 */
export interface AzureMailConfig extends MailProviderConfig {
  /** Microsoft Entra application (client) identifier. */
  clientId: string;
  /** Microsoft Entra application client secret. */
  clientSecret: string;
  /** Microsoft Entra tenant identifier or verified tenant domain. */
  tenantId: string;
  /** Exchange Online mailbox used by the Graph `sendMail` endpoint. */
  senderMailbox: string;
  /** Whether Exchange Online saves submitted messages in Sent Items. Defaults to `true`. */
  saveToSentItems?: boolean;
}
