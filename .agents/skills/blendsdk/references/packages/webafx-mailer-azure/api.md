> **Package**: `blendsdk/webafx-mailer-azure`

# webafx-mailer-azure API Reference

Complete reference for every public symbol exported by the Microsoft Graph email provider for BlendSDK WebAFX Mailer. For narrative coverage of the same concepts, see the Overview and Core Concepts documents.

---

## Exports Overview

The package entry point (`src/index.ts`) exports the following symbols:

| Export | Kind | Description |
| --- | --- | --- |
| `AzureMailProvider` | Class | Microsoft Graph implementation of the common `MailProvider` contract. |
| `azureMailPlugin` | Function | WebAFX plugin factory that registers the provider as a singleton. |
| `AzureMailConfig` | Interface (type-only export) | Entra application and Exchange Online mailbox configuration. |
| `MAX_DIRECT_ATTACHMENT_BYTES` | Constant | Maximum combined decoded attachment size for a direct Graph send. |

```typescript
import {
  AzureMailProvider,
  azureMailPlugin,
  MAX_DIRECT_ATTACHMENT_BYTES,
  type AzureMailConfig,
} from 'blendsdk/webafx-mailer-azure';
```

---

## AzureMailProvider

Sends BlendSDK mail messages through Microsoft Graph and Exchange Online.

The provider authenticates with application credentials (OAuth 2.0 client-credentials flow), so the Entra application must have the Microsoft Graph `Mail.Send` application permission and access to the configured mailbox. Restrict that permission to the configured mailbox with Exchange Online Application RBAC.

### Class Signature

```typescript
export class AzureMailProvider extends MailProvider {
  protected readonly config: Readonly<AzureMailConfig>;
  protected readonly msalClient: ConfidentialClientApplication;

  constructor(config: AzureMailConfig);

  async send(message: MailMessage): Promise<MailResult>;
  async health(): Promise<boolean>;
  async shutdown(): Promise<void>;

  protected async acquireAccessToken(): Promise<string>;
}
```

`MailProvider`, `MailMessage`, and `MailResult` are defined by the `blendsdk/webafx-mailer` peer dependency; `ConfidentialClientApplication` is defined by `@azure/msal-node`. The internal Graph request interfaces (`GraphMessage`, `GraphSendMailRequest`) are not part of the public API.

### Constructor

```typescript
constructor(config: AzureMailConfig)
```

Creates a Microsoft Graph mail provider. The configuration is validated first — malformed identifiers, an invalid secret, or an invalid sender mailbox throw before MSAL is constructed. The base `MailProvider` constructor then receives the same configuration, a frozen copy is stored in `config` (`Object.freeze({ ...config })`), and the MSAL client is created with the authority `https://login.microsoftonline.com/{tenantId}`.

**Parameters**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `config` | `AzureMailConfig` | Required | — | Entra application and Exchange Online mailbox settings. |

**Throws**

| Condition | Error |
| --- | --- |
| `clientId` is not a canonical UUID | `Azure mail clientId must be a valid UUID.` |
| `tenantId` is neither a UUID nor a valid tenant domain | `Azure mail tenantId must be a valid UUID or tenant domain.` |
| `clientSecret` is not a string, is empty, exceeds 4096 characters, or contains control characters | `Azure mail clientSecret is invalid.` |
| `senderMailbox` is not a valid email address | `Mail message senderMailbox contains an invalid email address.` |
| `senderMailbox` contains a display name | `Azure mail senderMailbox must not contain a display name.` |

### Properties

| Property | Type | Description |
| --- | --- | --- |
| `config` | `protected readonly Readonly<AzureMailConfig>` | Frozen copy of the validated configuration; later mutation of the original object has no effect. |
| `msalClient` | `protected readonly ConfidentialClientApplication` | MSAL confidential client used for app-only token acquisition and caching. |

### Methods

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `send` | `async send(message: MailMessage): Promise<MailResult>` | `Promise<MailResult>` | Validates and maps the message, acquires an app-only token, and submits it to the Graph `sendMail` endpoint. |
| `health` | `async health(): Promise<boolean>` | `Promise<boolean>` | Non-throwing probe that reports whether an access token can be obtained. |
| `shutdown` | `async shutdown(): Promise<void>` | `Promise<void>` | Completes provider shutdown; intentionally performs no work. |
| `acquireAccessToken` | `protected async acquireAccessToken(): Promise<string>` | `Promise<string>` | Requests an app-only Microsoft Graph bearer token from MSAL. |

#### send(message)

Submits a message through the configured Exchange Online mailbox.

```typescript
async send(message: MailMessage): Promise<MailResult>
```

Every call executes the same pipeline:

1. `buildGraphRequest()` validates the message and maps it to the Microsoft Graph JSON model — before any token is acquired or any socket is opened.
2. `acquireAccessToken()` obtains an app-only bearer token from MSAL (served from the MSAL token cache while valid).
3. `fetch()` submits the request with a 30-second bound.
4. HTTP `202 Accepted` is the only status treated as success.

**HTTP contract**

| Aspect | Value |
| --- | --- |
| Method | `POST` |
| URL | `https://graph.microsoft.com/v1.0/users/{encodeURIComponent(senderMailbox)}/sendMail` |
| Headers | `Authorization: Bearer {accessToken}`, `Content-Type: application/json` |
| Body | `GraphSendMailRequest` JSON — `message` plus `saveToSentItems` |
| Timeout | 30 seconds via `AbortSignal.timeout(30_000)` |
| Success | HTTP `202 Accepted` (any other status throws) |

**Parameters**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `message` | `MailMessage` | Required | — | Common BlendSDK message to submit (see Referenced Types). |

**Returns**

`Promise<MailResult>` — resolves only after Graph returns HTTP 202:

| Property | Type | Description |
| --- | --- | --- |
| `accepted` | `string[]` | Recipient addresses in To → CC → BCC order. |
| `rejected` | `string[]` | Always empty; Graph returns no synchronous per-recipient outcomes. |

A successful return means Microsoft Graph accepted the request; transport and delivery complete asynchronously after HTTP 202. No message identifier is invented.

**Throws**

| Error | Condition |
| --- | --- |
| `Mail message ...` validation errors | Any message field is invalid; thrown before token acquisition and before `fetch` (see Error Reference). |
| `Unable to authenticate with Microsoft Graph.` | MSAL cannot acquire a usable access token. |
| `Microsoft Graph email request failed.` | The network request fails or exceeds the 30-second timeout. |
| `Microsoft Graph rejected the email request with HTTP {status}.` | Graph responds with any status other than 202. |
| `Microsoft Graph rejected the email request with HTTP {status}. Retry after {seconds} seconds.` | Non-202 response with a numeric `Retry-After` header. |

**Wire format** — the JSON body sent to Graph is shaped like this (HTML body preferred when both body forms are supplied):

```json
{
  "message": {
    "subject": "Monthly report",
    "from": {
      "emailAddress": { "address": "notifications@example.com", "name": "Notifications" }
    },
    "toRecipients": [
      { "emailAddress": { "address": "alice@example.com" } }
    ],
    "body": {
      "contentType": "HTML",
      "content": "<p>The report is attached.</p>"
    },
    "attachments": [
      {
        "@odata.type": "#microsoft.graph.fileAttachment",
        "name": "report.txt",
        "contentType": "text/plain",
        "contentBytes": "cmVwb3J0IGNvbnRlbnRz"
      }
    ]
  },
  "saveToSentItems": true
}
```

**Example**

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const result = await mailer.send({
  from: 'notifications@example.com',
  to: ['alice@example.com', 'bob@example.com'],
  cc: 'manager@example.com',
  bcc: 'archive@example.com',
  subject: 'Result contract',
  text: 'Hello',
});

console.log(result.accepted.join(', '));
// alice@example.com, bob@example.com, manager@example.com, archive@example.com
console.log(result.rejected.length);
// 0
```

#### health()

Checks whether MSAL can obtain an application token for Microsoft Graph.

```typescript
async health(): Promise<boolean>
```

**Returns**

| Type | Description |
| --- | --- |
| `Promise<boolean>` | `true` when an access token can be obtained; otherwise `false`. Never throws. |

Token acquisition cannot prove mailbox authorization without sending a message or requesting extra Graph permissions, so this health check only verifies authentication readiness.

**Example**

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const healthy = await mailer.health();
console.log(healthy ? 'Graph authentication ready.' : 'Graph authentication unavailable.');
```

#### shutdown()

Completes provider shutdown.

```typescript
async shutdown(): Promise<void>
```

**Returns**: `Promise<void>` — resolves `undefined`. MSAL and native `fetch` do not retain a transport that requires explicit disposal, so this method intentionally performs no work.

#### acquireAccessToken() (protected)

Obtains an app-only access token without exposing authentication details.

```typescript
protected async acquireAccessToken(): Promise<string>
```

**Returns**: `Promise<string>` — non-empty Microsoft Graph bearer token for the `https://graph.microsoft.com/.default` scope (subject to MSAL token caching).

**Throws**: `Unable to authenticate with Microsoft Graph.` when MSAL throws, returns `null`, or returns no access token. The original failure is discarded so no credential material can leak.

This method is the single authentication seam: both `send()` and `health()` route through it. Subclasses can override it to instrument token acquisition while keeping the Graph transport unchanged.

### Complete Example

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
  saveToSentItems: true,
});

try {
  const result = await mailer.send({
    from: 'Notifications <notifications@example.com>',
    to: 'customer@example.com',
    subject: 'API reference example',
    text: 'This message is delivered through Microsoft Graph.',
  });

  console.log(`Graph accepted ${result.accepted.length} recipient(s).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await mailer.shutdown();
}
```

---

## azureMailPlugin

Creates a WebAFX mail plugin backed by Microsoft Graph.

```typescript
export function azureMailPlugin(config: AzureMailConfig): ReturnType<typeof createMailPlugin>
```

The factory constructs an `AzureMailProvider` from the configuration and wraps it in the plugin definition produced by `createMailPlugin()` from `blendsdk/webafx-mailer`. The provider is constructed **eagerly**, so configuration validation runs at plugin-creation time — a bad `clientId`, `tenantId`, `clientSecret`, or `senderMailbox` throws while the application is still registering plugins, not on the first `send()`.

**Parameters**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `config` | `AzureMailConfig` | Required | — | Entra application and Exchange Online mailbox settings. |

**Returns**

`ReturnType<typeof createMailPlugin>` — the WebAFX plugin definition, registered as a singleton under its service name:

| Property | Type | Description |
| --- | --- | --- |
| `name` | `string` | Registration name; `'mailer'` unless `config.serviceName` is set (for example `'graph-mailer'`). |
| `priority` | `number` | `30`, the standard mail plugin priority. |
| `factory` | function | Container factory that resolves the singleton `AzureMailProvider` instance. |

**Throws**: The same validation errors as the `AzureMailProvider` constructor (see Error Reference), thrown at plugin-creation time.

**Example**

```typescript
import { azureMailPlugin } from 'blendsdk/webafx-mailer-azure';

const plugin = azureMailPlugin({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
  serviceName: 'graph-mailer',
});

// Registered inside a WebAFX application as a singleton service.
console.log(`Plugin '${plugin.name}' ready with priority ${plugin.priority}.`);
```

---

## AzureMailConfig

Configures app-only Microsoft Graph email delivery through Exchange Online.

```typescript
export interface AzureMailConfig extends MailProviderConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  senderMailbox: string;
  saveToSentItems?: boolean;
}
```

This is a type-only export. Import it with `import type { AzureMailConfig } from 'blendsdk/webafx-mailer-azure';` or the inline `type` modifier.

**Properties**

| Property | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `clientId` | `string` | Required | — | Microsoft Entra application (client) identifier; must be a canonical UUID. |
| `clientSecret` | `string` | Required | — | Microsoft Entra application client secret; 1–4096 characters, no control characters. |
| `tenantId` | `string` | Required | — | Microsoft Entra tenant identifier or verified tenant domain (for example `contoso.onmicrosoft.com`). |
| `senderMailbox` | `string` | Required | — | Exchange Online mailbox used by the Graph `sendMail` endpoint; bare email address without a display name. |
| `saveToSentItems` | `boolean` | Optional | `true` | Whether Exchange Online saves submitted messages in Sent Items. |
| `serviceName` | `string` | Optional | `'mailer'` | Inherited from `MailProviderConfig`; overrides the plugin registration name used by `azureMailPlugin`. |

**Validation** — enforced once by the `AzureMailProvider` constructor:

| Field | Rule | Failure message |
| --- | --- | --- |
| `clientId` | Canonical UUID (version 1–5, RFC 4122 variant bits) | `Azure mail clientId must be a valid UUID.` |
| `tenantId` | UUID, or conservative DNS name: at most 253 characters, at least two labels, each label 1–63 alphanumeric characters with optional inner hyphens | `Azure mail tenantId must be a valid UUID or tenant domain.` |
| `clientSecret` | Non-empty string of at most 4096 characters without control characters | `Azure mail clientSecret is invalid.` |
| `senderMailbox` | Valid email address per the provider's conservative parser | `Mail message senderMailbox contains an invalid email address.` |
| `senderMailbox` | No display name (bare address only) | `Azure mail senderMailbox must not contain a display name.` |

**Example**

```typescript
import { AzureMailProvider, type AzureMailConfig } from 'blendsdk/webafx-mailer-azure';

const config: AzureMailConfig = {
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
  saveToSentItems: false,
};

const mailer = new AzureMailProvider(config);

const result = await mailer.send({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'API reference example',
  text: 'This message is not saved to Sent Items.',
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

---

## MAX_DIRECT_ATTACHMENT_BYTES

Maximum combined decoded attachment size accepted for a single direct Graph send.

```typescript
export const MAX_DIRECT_ATTACHMENT_BYTES = 3 * 1024 * 1024 - 1;
```

| Constant | Type | Value | Description |
| --- | --- | --- | --- |
| `MAX_DIRECT_ATTACHMENT_BYTES` | `number` | `3145727` | `3 * 1024 * 1024 - 1`; the maximum combined decoded attachment size accepted by `send()` without a Graph upload session. |

Direct Graph attachments must remain below 3 MiB. Larger files require a draft and upload-session workflow with broader mailbox permissions, which this provider does not implement. The limit is enforced as a running total across all attachments in a message, measured on decoded byte length, and a violation throws `Mail attachments exceed the Microsoft Graph direct-send size limit.` locally — before any token or network activity. Use the constant to pre-check payloads before calling `send()`.

**Example**

```typescript
import { AzureMailProvider, MAX_DIRECT_ATTACHMENT_BYTES } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const payload = Buffer.alloc(2 * 1024 * 1024);

if (payload.byteLength > MAX_DIRECT_ATTACHMENT_BYTES) {
  throw new Error('Attachment exceeds the Microsoft Graph direct-send limit.');
}

const result = await mailer.send({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'Pre-checked attachment',
  text: 'The payload fits within the direct-send limit.',
  attachments: [
    {
      filename: 'payload.bin',
      content: payload,
      contentType: 'application/octet-stream',
    },
  ],
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

---

## Referenced Types from blendsdk/webafx-mailer

`AzureMailProvider` consumes the provider-neutral mail contract from the `blendsdk/webafx-mailer` peer dependency. These types appear in the public signatures of this package; the constraints below are the ones enforced by `AzureMailProvider` before any network call.

### MailMessage

| Property | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `from` | `string` | Required | — | Sender mailbox as `user@example.com` or `Name <user@example.com>`; the address must match the configured `senderMailbox` (case-insensitive comparison). |
| `to` | `string \| string[]` | Required | — | Primary recipients; at least one required. |
| `cc` | `string \| string[]` | Optional | — | Carbon-copy recipients; omitted from the Graph payload when not supplied. |
| `bcc` | `string \| string[]` | Optional | — | Blind-carbon-copy recipients; omitted from the Graph payload when not supplied. |
| `subject` | `string` | Required | — | Subject line; non-empty, at most 998 characters, no control characters. |
| `text` | `string` | Optional | — | Plain-text body; used when `html` is absent or empty. |
| `html` | `string` | Optional | — | HTML body; preferred when present and non-empty. |
| `attachments` | `MailAttachment[]` | Optional | — | Direct file attachments (see `MAX_DIRECT_ATTACHMENT_BYTES`). |

At least one non-empty `text` or `html` body is required. When both are supplied, only the HTML body is sent — Graph messages carry a single body.

### MailAttachment

| Property | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `filename` | `string` | Required | — | Presented filename; 1–255 characters, no control characters. |
| `content` | `Buffer \| string` | Required | — | `Buffer` bytes, or a string that is already canonical base64. |
| `contentType` | `string` | Optional | — | MIME type matching `type/subtype` (for example `text/plain`, `image/svg+xml`); at most 127 characters. |

### MailResult

| Property | Type | Description |
| --- | --- | --- |
| `accepted` | `string[]` | Recipient addresses Graph accepted for asynchronous processing, in To → CC → BCC order. |
| `rejected` | `string[]` | Always empty for this provider; Graph `sendMail` returns no synchronous per-recipient outcomes. |

### MailProviderConfig

Base configuration interface extended by `AzureMailConfig`. The field this package consumes is `serviceName`, which selects the plugin registration name used by `azureMailPlugin`.

| Property | Type | Description |
| --- | --- | --- |
| `serviceName` | `string` | Optional service container registration name for the mail plugin; defaults to `mailer`. |

Refer to the `blendsdk/webafx-mailer` API reference for the complete base contract.

---

## Error Reference

Every error thrown by this package. Messages never include MSAL diagnostics, bearer tokens, message content, or Graph response bodies.

### Configuration Errors (Constructor)

| Error message | Condition |
| --- | --- |
| `Azure mail clientId must be a valid UUID.` | `clientId` fails the canonical UUID pattern. |
| `Azure mail tenantId must be a valid UUID or tenant domain.` | `tenantId` is neither a UUID nor a conservative DNS name (at most 253 characters, at least two labels, alphanumeric labels with optional inner hyphens; values containing path segments are rejected). |
| `Azure mail clientSecret is invalid.` | `clientSecret` is not a string, is empty, exceeds 4096 characters, or contains control characters. |
| `Mail message senderMailbox contains an invalid email address.` | `senderMailbox` is empty, contains control characters, or fails the email grammar. |
| `Azure mail senderMailbox must not contain a display name.` | `senderMailbox` uses the `Name <address>` form. |

### Message Validation Errors (send, before token acquisition and network)

| Error message | Condition |
| --- | --- |
| `Mail message from contains an invalid email address.` | `from` is empty, contains control characters, or fails the email grammar. |
| `Mail message contains an invalid sender display name.` | A mailbox display name exceeds 128 characters, contains control characters, or contains `<`, `>`, or `"`. |
| `Mail message from address must match the configured senderMailbox.` | The parsed `from` address does not equal `senderMailbox` (case-insensitive). |
| `Mail message subject is invalid.` | `subject` is empty, exceeds 998 characters, or contains control characters. |
| `Mail message must contain a non-empty text or html body.` | Neither `html` nor `text` is a non-empty string. |
| `Mail message to contains an invalid email address.` | A `to` recipient fails the email grammar. |
| `Mail message cc contains an invalid email address.` | A `cc` recipient fails the email grammar. |
| `Mail message bcc contains an invalid email address.` | A `bcc` recipient fails the email grammar. |
| `Mail message {to\|cc\|bcc} must contain at least one recipient.` | A recipient field is supplied as an empty array. |
| `Mail attachment filename is invalid.` | `filename` is not a string, is empty, exceeds 255 characters, or contains control characters. |
| `Mail attachment contentType is invalid.` | `contentType` is present but empty, exceeds 127 characters, or does not match `type/subtype`. |
| `Mail attachment string content must be valid base64.` | String `content` is not canonical base64 (not length-divisible by 4, invalid alphabet, or fails the byte-for-byte round trip). |
| `Mail attachments exceed the Microsoft Graph direct-send size limit.` | The combined decoded attachment size exceeds `MAX_DIRECT_ATTACHMENT_BYTES`. |

### Authentication and Transport Errors

| Error message | Thrown by | Condition |
| --- | --- | --- |
| `Unable to authenticate with Microsoft Graph.` | `send()` (via `acquireAccessToken()`), `acquireAccessToken()` | MSAL throws, returns `null`, or returns no access token. `health()` catches this and resolves `false` instead. |
| `Microsoft Graph email request failed.` | `send()` | `fetch` rejects — network failure or the 30-second timeout. |
| `Microsoft Graph rejected the email request with HTTP {status}.` | `send()` | Graph responds with a status other than 202 and no numeric `Retry-After` header. |
| `Microsoft Graph rejected the email request with HTTP {status}. Retry after {seconds} seconds.` | `send()` | Non-202 response with a numeric `Retry-After` header (non-numeric values are ignored). |

---

## Internal Limits and Constants

These values are module-private (only `MAX_DIRECT_ATTACHMENT_BYTES` is exported); they are documented because they define the observable validation and transport behavior of every `send()` call.

| Name | Value | Description |
| --- | --- | --- |
| `GRAPH_ENDPOINT` | `'https://graph.microsoft.com/v1.0'` | Base URL for the `sendMail` action (`/users/{senderMailbox}/sendMail`). |
| `GRAPH_DEFAULT_SCOPE` | `'https://graph.microsoft.com/.default'` | Graph scope requested during token acquisition. |
| `GRAPH_REQUEST_TIMEOUT_MS` | `30_000` | Upper bound on every Microsoft Graph request via `AbortSignal.timeout`. |
| `MAX_EMAIL_LENGTH` | `254` | Maximum email address length (`from`, `to`, `cc`, `bcc`, `senderMailbox`). |
| `MAX_SUBJECT_LENGTH` | `998` | Maximum subject length. |
| `MAX_FILENAME_LENGTH` | `255` | Maximum attachment filename length. |
| `MAX_CONTENT_TYPE_LENGTH` | `127` | Maximum attachment MIME type length. |
| `MAX_CLIENT_SECRET_LENGTH` | `4096` | Maximum client secret length. |
| Display name limit (inline check) | `128` | Maximum mailbox display name length. |
| `MAX_DIRECT_ATTACHMENT_BYTES` | `3145727` | Maximum combined decoded attachment size (exported constant). |

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
