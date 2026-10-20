/**
 * WebAFX plugin convenience factory for Microsoft Graph email delivery.
 */

import { createMailPlugin } from '@blendsdk/webafx-mailer';

import { AzureMailProvider } from './azure-mail-provider.js';
import type { AzureMailConfig } from './types.js';

/**
 * Creates a WebAFX mail plugin backed by Microsoft Graph.
 *
 * @param config - Entra application and Exchange Online mailbox settings.
 * @returns Plugin definition that registers the provider as a singleton.
 *
 * @example
 * ```typescript
 * app.use(azureMailPlugin({
 *     tenantId: process.env.AZURE_TENANT_ID!,
 *     clientId: process.env.AZURE_CLIENT_ID!,
 *     clientSecret: process.env.AZURE_CLIENT_SECRET!,
 *     senderMailbox: "notifications@example.com",
 * }));
 * ```
 */
export function azureMailPlugin(config: AzureMailConfig): ReturnType<typeof createMailPlugin> {
  return createMailPlugin(new AzureMailProvider(config));
}
