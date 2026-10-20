/**
 * Implementation-focused tests for lifecycle, error handling, and body mapping.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const msal = vi.hoisted(() => ({
  acquireTokenByClientCredential: vi.fn(),
}));

vi.mock('@azure/msal-node', () => ({
  ConfidentialClientApplication: class {
    acquireTokenByClientCredential = msal.acquireTokenByClientCredential;
  },
}));

import { azureMailPlugin } from '../src/azure-mail-plugin.js';
import { AzureMailProvider } from '../src/azure-mail-provider.js';

const fetchMock = vi.fn<typeof fetch>();

/** Valid application configuration reused across implementation tests. */
const providerConfig = {
  clientId: '11111111-1111-4111-8111-111111111111',
  clientSecret: 'test-client-secret',
  tenantId: 'contoso.onmicrosoft.com',
  senderMailbox: 'notifications@example.com',
};

/** Sends a minimal valid message through the supplied provider. */
async function sendMinimalMessage(provider: AzureMailProvider): Promise<void> {
  await provider.send({
    from: 'notifications@example.com',
    to: 'customer@example.com',
    subject: 'Implementation test',
    text: 'Hello',
  });
}

beforeEach(() => {
  msal.acquireTokenByClientCredential.mockReset();
  msal.acquireTokenByClientCredential.mockResolvedValue({ accessToken: 'access-token' });

  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
});

describe('AzureMailProvider implementation', () => {
  it('should default to saving messages in Sent Items', async () => {
    const provider = new AzureMailProvider(providerConfig);

    await sendMinimalMessage(provider);

    const body = fetchMock.mock.calls[0][1]?.body;
    expect(typeof body).toBe('string');
    if (typeof body !== 'string') {
      throw new Error('Expected a JSON request body.');
    }
    expect(JSON.parse(body)).toMatchObject({ saveToSentItems: true });
  });

  it('should use a text body when HTML is absent', async () => {
    const provider = new AzureMailProvider(providerConfig);

    await sendMinimalMessage(provider);

    const body = fetchMock.mock.calls[0][1]?.body;
    if (typeof body !== 'string') {
      throw new Error('Expected a JSON request body.');
    }
    expect(JSON.parse(body)).toMatchObject({
      message: {
        body: { contentType: 'Text', content: 'Hello' },
      },
    });
  });

  it('should preserve canonical base64 attachment strings', async () => {
    const provider = new AzureMailProvider(providerConfig);
    const encoded = Buffer.from('already encoded').toString('base64');

    await provider.send({
      from: 'notifications@example.com',
      to: 'customer@example.com',
      subject: 'Base64 attachment',
      text: 'Hello',
      attachments: [{ filename: 'data.bin', content: encoded }],
    });

    const body = fetchMock.mock.calls[0][1]?.body;
    if (typeof body !== 'string') {
      throw new Error('Expected a JSON request body.');
    }
    expect(JSON.parse(body)).toMatchObject({
      message: {
        attachments: [{ contentBytes: encoded }],
      },
    });
  });

  it('should report healthy when MSAL supplies an access token', async () => {
    const provider = new AzureMailProvider(providerConfig);

    await expect(provider.health()).resolves.toBe(true);
  });

  it('should report unhealthy when MSAL rejects authentication', async () => {
    msal.acquireTokenByClientCredential.mockRejectedValue(new Error('external failure'));
    const provider = new AzureMailProvider(providerConfig);

    await expect(provider.health()).resolves.toBe(false);
  });

  it('should reject sending when authentication returns no token', async () => {
    msal.acquireTokenByClientCredential.mockResolvedValue(null);
    const provider = new AzureMailProvider(providerConfig);

    await expect(sendMinimalMessage(provider)).rejects.toThrow(
      'Unable to authenticate with Microsoft Graph.'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should return a bounded error when the network request fails', async () => {
    fetchMock.mockRejectedValue(new Error('socket included sensitive request details'));
    const provider = new AzureMailProvider(providerConfig);

    await expect(sendMinimalMessage(provider)).rejects.toThrow(
      'Microsoft Graph email request failed.'
    );
  });

  it('should include a valid Graph retry delay in a throttling error', async () => {
    fetchMock.mockResolvedValue(
      new Response('sensitive provider response', {
        status: 429,
        headers: { 'Retry-After': '15' },
      })
    );
    const provider = new AzureMailProvider(providerConfig);

    await expect(sendMinimalMessage(provider)).rejects.toThrow(
      'Microsoft Graph rejected the email request with HTTP 429. Retry after 15 seconds.'
    );
  });

  it('should ignore a non-numeric Graph retry header', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 429,
        headers: { 'Retry-After': 'soon' },
      })
    );
    const provider = new AzureMailProvider(providerConfig);

    await expect(sendMinimalMessage(provider)).rejects.toThrow(
      'Microsoft Graph rejected the email request with HTTP 429.'
    );
  });

  it('should shut down without retaining external resources', async () => {
    const provider = new AzureMailProvider(providerConfig);

    await expect(provider.shutdown()).resolves.toBeUndefined();
  });
});

describe('azureMailPlugin', () => {
  it('should register the provider with the common mail service name', () => {
    const plugin = azureMailPlugin(providerConfig);

    expect(plugin.name).toBe('mailer');
    expect(plugin.priority).toBe(30);
    expect(typeof plugin.factory).toBe('function');
  });

  it('should respect a custom common mail service name', () => {
    const plugin = azureMailPlugin({
      ...providerConfig,
      serviceName: 'graph-mailer',
    });

    expect(plugin.name).toBe('graph-mailer');
  });
});
