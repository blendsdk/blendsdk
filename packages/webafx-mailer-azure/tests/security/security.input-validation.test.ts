/**
 * Security tests for configuration, address, header, and attachment validation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AzureMailProvider, MAX_DIRECT_ATTACHMENT_BYTES } from '../../src/azure-mail-provider.js';

const fetchMock = vi.fn<typeof fetch>();

/** Valid provider configuration used when testing message input. */
const providerConfig = {
  clientId: '11111111-1111-4111-8111-111111111111',
  clientSecret: 'test-client-secret',
  tenantId: '22222222-2222-4222-8222-222222222222',
  senderMailbox: 'notifications@example.com',
};

/** Creates a provider after the constructor has validated its configuration. */
function createProvider(): AzureMailProvider {
  return new AzureMailProvider(providerConfig);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('Azure mail configuration validation', () => {
  it('should reject a client identifier that is not a UUID', () => {
    expect(() => new AzureMailProvider({ ...providerConfig, clientId: 'not-a-client-id' })).toThrow(
      'Azure mail clientId must be a valid UUID.'
    );
  });

  it('should reject a tenant identifier containing an authority path', () => {
    expect(
      () =>
        new AzureMailProvider({
          ...providerConfig,
          tenantId: 'contoso.onmicrosoft.com/../organizations',
        })
    ).toThrow('Azure mail tenantId must be a valid UUID or tenant domain.');
  });

  it('should reject an empty client secret', () => {
    expect(() => new AzureMailProvider({ ...providerConfig, clientSecret: '' })).toThrow(
      'Azure mail clientSecret is invalid.'
    );
  });

  it('should reject control characters in a client secret', () => {
    expect(
      () =>
        new AzureMailProvider({
          ...providerConfig,
          clientSecret: 'secret\nvalue',
        })
    ).toThrow('Azure mail clientSecret is invalid.');
  });

  it('should reject a sender mailbox containing a display name', () => {
    expect(
      () =>
        new AzureMailProvider({
          ...providerConfig,
          senderMailbox: 'Notifications <notifications@example.com>',
        })
    ).toThrow('Azure mail senderMailbox must not contain a display name.');
  });
});

describe('Azure mail message validation', () => {
  it('should reject a message sender that does not match the configured mailbox', async () => {
    const provider = createProvider();

    await expect(
      provider.send({
        from: 'other@example.com',
        to: 'customer@example.com',
        subject: 'Sender mismatch',
        text: 'Hello',
      })
    ).rejects.toThrow('from address must match the configured senderMailbox');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject recipient header injection', async () => {
    const provider = createProvider();

    await expect(
      provider.send({
        from: 'notifications@example.com',
        to: 'customer@example.com\r\nBcc: attacker@example.com',
        subject: 'Injection test',
        text: 'Hello',
      })
    ).rejects.toThrow('to contains an invalid email address');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject subject header injection', async () => {
    const provider = createProvider();

    await expect(
      provider.send({
        from: 'notifications@example.com',
        to: 'customer@example.com',
        subject: 'Subject\r\nBcc: attacker@example.com',
        text: 'Hello',
      })
    ).rejects.toThrow('Mail message subject is invalid.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject a message without a usable body', async () => {
    const provider = createProvider();

    await expect(
      provider.send({
        from: 'notifications@example.com',
        to: 'customer@example.com',
        subject: 'No body',
      })
    ).rejects.toThrow('must contain a non-empty text or html body');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject malformed attachment MIME types', async () => {
    const provider = createProvider();

    await expect(
      provider.send({
        from: 'notifications@example.com',
        to: 'customer@example.com',
        subject: 'Unsafe attachment',
        text: 'Hello',
        attachments: [
          {
            filename: 'report.txt',
            content: Buffer.from('report'),
            contentType: 'text/plain\r\nInjected: value',
          },
        ],
      })
    ).rejects.toThrow('Mail attachment contentType is invalid.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject a malformed base64 attachment string', async () => {
    const provider = createProvider();

    await expect(
      provider.send({
        from: 'notifications@example.com',
        to: 'customer@example.com',
        subject: 'Malformed attachment',
        text: 'Hello',
        attachments: [{ filename: 'report.txt', content: 'not base64' }],
      })
    ).rejects.toThrow('string content must be valid base64');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject attachments at or above the direct-send limit', async () => {
    const provider = createProvider();

    await expect(
      provider.send({
        from: 'notifications@example.com',
        to: 'customer@example.com',
        subject: 'Oversized attachment',
        text: 'Hello',
        attachments: [
          {
            filename: 'oversized.bin',
            content: Buffer.alloc(MAX_DIRECT_ATTACHMENT_BYTES + 1),
          },
        ],
      })
    ).rejects.toThrow('attachments exceed the Microsoft Graph direct-send size limit');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
