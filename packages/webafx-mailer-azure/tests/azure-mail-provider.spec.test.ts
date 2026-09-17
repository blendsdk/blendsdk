/**
 * Public contract tests for Microsoft Graph email delivery.
 *
 * Microsoft Entra and Graph are external services, so these tests replace only
 * those boundaries while exercising the real provider and message mapping.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const msal = vi.hoisted(() => ({
  acquireTokenByClientCredential: vi.fn(),
  configurations: [] as object[],
}));

vi.mock('@azure/msal-node', () => ({
  ConfidentialClientApplication: class {
    constructor(configuration: object) {
      msal.configurations.push(configuration);
    }

    acquireTokenByClientCredential = msal.acquireTokenByClientCredential;
  },
}));

import { AzureMailProvider } from '../src/azure-mail-provider.js';

const fetchMock = vi.fn<typeof fetch>();

/** Standard provider configuration for the specification examples. */
const providerConfig = {
  clientId: '11111111-1111-4111-8111-111111111111',
  clientSecret: 'test-client-secret',
  tenantId: '22222222-2222-4222-8222-222222222222',
  senderMailbox: 'notifications@example.com',
};

beforeEach(() => {
  msal.acquireTokenByClientCredential.mockReset();
  msal.acquireTokenByClientCredential.mockResolvedValue({
    accessToken: 'graph-access-token',
  });
  msal.configurations.length = 0;

  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
});

describe('AzureMailProvider specification', () => {
  // The provider must use app-only Microsoft Graph authentication with the
  // tenant, application, and secret supplied by the application.
  it('should authenticate with the configured Entra application', async () => {
    const provider = new AzureMailProvider(providerConfig);

    await provider.send({
      from: 'notifications@example.com',
      to: 'customer@example.com',
      subject: 'Authentication contract',
      text: 'Hello',
    });

    expect(msal.configurations).toEqual([
      {
        auth: {
          clientId: providerConfig.clientId,
          clientSecret: providerConfig.clientSecret,
          authority: `https://login.microsoftonline.com/${providerConfig.tenantId}`,
        },
      },
    ]);
    expect(msal.acquireTokenByClientCredential).toHaveBeenCalledWith({
      scopes: ['https://graph.microsoft.com/.default'],
    });
  });

  // Mail must be submitted through the configured Exchange Online mailbox,
  // not through SMTP or a mailbox selected by untrusted message input.
  it('should send mail through the configured Microsoft Graph mailbox', async () => {
    const provider = new AzureMailProvider(providerConfig);

    await provider.send({
      from: 'Notifications <notifications@example.com>',
      to: 'customer@example.com',
      subject: 'Graph contract',
      html: '<p>Hello from Graph</p>',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.microsoft.com/v1.0/users/notifications%40example.com/sendMail');
    expect(options).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer graph-access-token',
        'Content-Type': 'application/json',
      },
    });
  });

  // The common MailMessage fields must map consistently across SMTP and
  // Microsoft Graph, including blind-copy recipients and attachments.
  it('should map the common mail contract to a Graph message', async () => {
    const provider = new AzureMailProvider({
      ...providerConfig,
      saveToSentItems: false,
    });

    await provider.send({
      from: 'Notifications <notifications@example.com>',
      to: ['alice@example.com', 'bob@example.com'],
      cc: 'manager@example.com',
      bcc: 'archive@example.com',
      subject: 'Monthly report',
      text: 'The report is attached.',
      html: '<p>The report is attached.</p>',
      attachments: [
        {
          filename: 'report.txt',
          content: Buffer.from('report contents'),
          contentType: 'text/plain',
        },
      ],
    });

    const options = fetchMock.mock.calls[0][1];
    expect(typeof options?.body).toBe('string');
    if (typeof options?.body !== 'string') {
      throw new Error('Expected the Graph request body to be JSON text.');
    }

    expect(JSON.parse(options.body)).toEqual({
      message: {
        subject: 'Monthly report',
        from: {
          emailAddress: {
            address: 'notifications@example.com',
            name: 'Notifications',
          },
        },
        toRecipients: [
          { emailAddress: { address: 'alice@example.com' } },
          { emailAddress: { address: 'bob@example.com' } },
        ],
        ccRecipients: [{ emailAddress: { address: 'manager@example.com' } }],
        bccRecipients: [{ emailAddress: { address: 'archive@example.com' } }],
        body: {
          contentType: 'HTML',
          content: '<p>The report is attached.</p>',
        },
        attachments: [
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: 'report.txt',
            contentType: 'text/plain',
            contentBytes: Buffer.from('report contents').toString('base64'),
          },
        ],
      },
      saveToSentItems: false,
    });
  });

  // A successful Graph submission accepts the recipient list but does not
  // return a final delivery result or an Exchange message identifier.
  it('should return accepted recipients without inventing a message identifier', async () => {
    const provider = new AzureMailProvider(providerConfig);

    const result = await provider.send({
      from: 'notifications@example.com',
      to: ['alice@example.com', 'bob@example.com'],
      cc: 'manager@example.com',
      bcc: 'archive@example.com',
      subject: 'Result contract',
      text: 'Hello',
    });

    expect(result).toEqual({
      accepted: [
        'alice@example.com',
        'bob@example.com',
        'manager@example.com',
        'archive@example.com',
      ],
      rejected: [],
    });
  });
});
