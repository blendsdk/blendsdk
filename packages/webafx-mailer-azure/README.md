# @blendsdk/webafx-mailer-azure

Microsoft Graph email provider for BlendSDK WebAFX Mailer.

The provider authenticates an Entra application with the official
`@azure/msal-node` package and submits messages through the Exchange Online
`/users/{sender}/sendMail` Microsoft Graph endpoint. It does not use SMTP.

## Public installation

The provider is published as part of the `blendsdk` umbrella package. Install
its optional MSAL peer dependency when using this module:

```bash
yarn add blendsdk @azure/msal-node
```

## Usage

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { azureMailPlugin } from 'blendsdk/webafx-mailer-azure';

const app = new WebApplication();

app.use(
  azureMailPlugin({
    tenantId: process.env.AZURE_TENANT_ID!,
    clientId: process.env.AZURE_CLIENT_ID!,
    clientSecret: process.env.AZURE_CLIENT_SECRET!,
    senderMailbox: 'notifications@example.com',
    saveToSentItems: true,
  })
);
```

Retrieve the common `MailProvider` service and send a message normally:

```typescript
import type { MailProvider } from 'blendsdk/webafx-mailer';

const mailer = await req.services.get<MailProvider>('mailer');

await mailer.send({
  from: 'Notifications <notifications@example.com>',
  to: 'customer@example.com',
  subject: 'Welcome',
  text: 'Welcome to our service.',
  attachments: [
    {
      filename: 'welcome.txt',
      content: Buffer.from('Welcome'),
      contentType: 'text/plain',
    },
  ],
});
```

## Entra and Exchange configuration

The Entra application needs the Microsoft Graph `Mail.Send` application
permission with administrator consent. Because that permission can otherwise
send as any organizational mailbox, restrict it to the configured sender with
Exchange Online Application RBAC.

Keep client secrets in environment variables or a secret manager. The provider
never includes secrets, access tokens, message bodies, or recipient addresses in
its operational errors.

## Supported message fields

- Sender, To, CC, and BCC
- Multiple recipients
- Plain-text or HTML content; HTML is preferred when both are supplied
- File attachments with a filename and optional MIME type
- Optional Sent Items storage

Direct-send attachments are limited to a combined size below 3 MiB. Larger
attachments require Graph draft and upload-session permissions and are rejected
with a validation error.

Microsoft Graph returns HTTP 202 without a message identifier. A successful
`send()` result means Graph accepted the recipients for asynchronous processing;
it does not confirm final delivery.

## Standalone usage

The provider can be used without WebAFX:

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

await mailer.send({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'Hello',
  text: 'Hello from Microsoft Graph.',
});
```

## License

MIT
