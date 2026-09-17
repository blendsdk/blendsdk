> **Package**: `blendsdk/webafx-mailer-azure`

# webafx-mailer-azure Core Concepts

This document is the deep dive that accompanies the Overview. It explains each major abstraction in the package — what it is, how it works internally, and how to use it — with complete, runnable examples. The concepts map directly onto the public API surface and the internal request pipeline:

| Concept | Primary API | Role |
| --- | --- | --- |
| Provider implementation | `AzureMailProvider` | The `MailProvider` subclass that owns the Graph transport |
| Configuration contract | `AzureMailConfig` | Validated settings for Entra and the sender mailbox |
| App-only authentication | `acquireAccessToken()`, MSAL | Client-credentials token acquisition and caching |
| Message mapping | `buildGraphRequest()` (internal) | `MailMessage` → Graph JSON translation |
| Attachments | `MAX_DIRECT_ATTACHMENT_BYTES` (internal helpers) | Base64 encoding and the 3 MiB direct-send limit |
| Validation and security | `validateConfig()`, `parseMailbox()` (internal) | Fail-fast, injection-resistant input handling |
| WebAFX plugin | `azureMailPlugin` | Singleton registration in the service container |
| Delivery semantics and errors | `send()`, `MailResult` | Honest acceptance results and bounded errors |

For installation and first steps, see Basic Usage.

---

## AzureMailProvider — The Provider Implementation

### What It Is

`AzureMailProvider` is the exported concrete implementation of the common `MailProvider` contract from `blendsdk/webafx-mailer` that delivers messages through Microsoft Graph and Exchange Online. It is the only class in the package that touches external systems, and it is the object you construct for standalone use or that `azureMailPlugin()` constructs for you inside a WebAFX application.

### How It Works

The class extends `MailProvider` and adds exactly two pieces of instance state:

1. **Constructor** — `validateConfig(config)` runs first, so a malformed client ID, tenant, secret, or sender mailbox throws before anything else happens. Then `super(config)` is called, a frozen copy of the configuration is stored in `this.config` (`Object.freeze({ ...config })`), and one `ConfidentialClientApplication` (MSAL) instance is created and stored in `this.msalClient`.
2. **`send()` pipeline** — every call executes the same five steps in order:
   1. `buildGraphRequest(message, this.config)` validates and maps the message locally. No token or network activity has happened yet, so invalid input can never reach Microsoft Graph.
   2. `acquireAccessToken()` obtains an app-only bearer token through MSAL.
   3. `fetch()` POSTs the JSON body to `https://graph.microsoft.com/v1.0/users/{senderMailbox}/sendMail` with a 30-second bound from `AbortSignal.timeout`.
   4. Only HTTP 202 counts as success; any other status becomes a bounded error.
   5. The resolved `MailResult` lists the recipients that Graph accepted and always reports `rejected: []`.

Because the provider depends only on the base `MailProvider` contract, application code can treat it interchangeably with any other BlendSDK mail provider — the Microsoft Graph details stay behind the `send()`, `health()`, and `shutdown()` interface.

### Complete Example

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

try {
  const result = await mailer.send({
    from: 'Notifications <notifications@example.com>',
    to: ['alice@example.com', 'bob@example.com'],
    subject: 'Welcome',
    html: '<p>Welcome to our service.</p>',
  });

  console.log(`Graph accepted: ${result.accepted.join(', ')}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await mailer.shutdown();
}
```

### Key Methods and Properties

| Name | Type/Signature | Description |
| --- | --- | --- |
| `constructor` | `(config: AzureMailConfig) => AzureMailProvider` | Validates the configuration, stores a frozen copy, and creates the MSAL client. Throws an `Error` when validation fails. |
| `config` | `protected readonly Readonly<AzureMailConfig>` | Immutable configuration shared by every request. |
| `msalClient` | `protected readonly ConfidentialClientApplication` | App-only token source from `@azure/msal-node`. |
| `send` | `(message: MailMessage) => Promise<MailResult>` | Validates and maps the message, acquires a token, and submits the Graph request. |
| `health` | `() => Promise<boolean>` | Resolves `true` only when an access token can be obtained. |
| `shutdown` | `() => Promise<void>` | Intentional no-op; neither MSAL nor `fetch` retains a disposable transport. |

---

## AzureMailConfig — The Configuration Contract

### What It Is

`AzureMailConfig` is the interface that carries everything the provider needs for app-only Graph delivery: the Entra application identifier, its client secret, the tenant, and the Exchange Online mailbox used as the sender. It extends `MailProviderConfig` from the core mailer package, so it also carries the shared provider options that the base contract defines (most notably `serviceName`, which the plugin consumes).

### How It Works

The configuration is validated **once**, inside the `AzureMailProvider` constructor, by `validateConfig()`. The rules are deliberately strict because these values are interpolated into MSAL authorities and Graph URLs:

- `clientId` must match a canonical UUID pattern.
- `tenantId` must be either a UUID or a conservative DNS tenant name (for example `contoso.onmicrosoft.com`); values containing path segments such as `/../organizations` are rejected so the MSAL authority cannot be manipulated.
- `clientSecret` must be a non-empty string of at most 4096 characters without control characters — a secret with embedded newlines is treated as an injection attempt.
- `senderMailbox` must parse as a bare email address. Unlike the `from` field of a message, it must **not** contain a display name like `Notifications <notifications@example.com>`.

After validation, a frozen copy is stored on the provider; the object you passed in is never mutated, and later changes to it have no effect. The optional `saveToSentItems` flag is read at request-build time and defaults to `true`, meaning Exchange Online keeps a copy in the sender mailbox's Sent Items unless you opt out.

### Complete Example

```typescript
import { AzureMailProvider, type AzureMailConfig } from 'blendsdk/webafx-mailer-azure';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const config: AzureMailConfig = {
  tenantId: requireEnv('AZURE_TENANT_ID'),
  clientId: requireEnv('AZURE_CLIENT_ID'),
  clientSecret: requireEnv('AZURE_CLIENT_SECRET'),
  senderMailbox: 'notifications@example.com',
  saveToSentItems: false,
};

const mailer = new AzureMailProvider(config);

const result = await mailer.send({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'Configuration example',
  text: 'This message is not saved to Sent Items.',
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

### Key Methods and Properties

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `clientId` | `string` | Yes | Microsoft Entra application (client) identifier; must be a valid UUID. |
| `clientSecret` | `string` | Yes | Application client secret; 1–4096 characters, no control characters. |
| `tenantId` | `string` | Yes | Tenant UUID or verified tenant domain (e.g. `contoso.onmicrosoft.com`). |
| `senderMailbox` | `string` | Yes | Exchange Online mailbox used by the Graph `sendMail` endpoint; bare address only. |
| `saveToSentItems` | `boolean` | No | Whether Exchange Online saves submitted messages in Sent Items. Defaults to `true`. |
| `serviceName` | `string` | No | Inherited from `MailProviderConfig`; overrides the plugin registration name (default `mailer`). |

---

## App-Only Authentication with MSAL

### What It Is

The provider authenticates as the Entra application itself using the OAuth 2.0 client-credentials flow — there is no signed-in user and no SMTP credential. Token acquisition is encapsulated in the protected `acquireAccessToken()` method, which delegates to the `ConfidentialClientApplication` from `@azure/msal-node`.

### How It Works

1. **MSAL setup** — the constructor builds a confidential client with `auth: { clientId, clientSecret, authority: 'https://login.microsoftonline.com/{tenantId}' }`. The authority URL is the only place the tenant identifier is used.
2. **Token acquisition** — `acquireAccessToken()` calls `acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] })`. The `.default` scope is a request for all Microsoft Graph **application** permissions that have already been granted and consented on the app registration (`Mail.Send` in the supported setup).
3. **Caching** — MSAL caches tokens internally. Every `send()` call goes through `acquireAccessToken()`, but MSAL serves a cached token while it is valid, so token acquisition is not a per-message network round trip.
4. **Failure containment** — all failures inside the method (MSAL throwing, a `null` authentication result, a missing access token) are collapsed into a single error: `Unable to authenticate with Microsoft Graph.` Tokens, secrets, and MSAL diagnostics never appear in the message.
5. **Extension point** — the method is `protected`, so subclasses can instrument or replace token acquisition while keeping the Graph transport untouched. `health()` is a non-throwing probe of the same mechanism: it returns `true` when a token can be acquired and `false` otherwise. Note that a successful token acquisition proves authentication readiness, not mailbox authorization — the Entra application must also have `Mail.Send` and, ideally, Exchange Online Application RBAC scoping that permission to the configured `senderMailbox`.

### Complete Example

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

/**
 * Logs each token acquisition. MSAL caches tokens, so this fires on a cache
 * miss rather than on every send() call.
 */
class AuditedAzureMailProvider extends AzureMailProvider {
  protected override async acquireAccessToken(): Promise<string> {
    const token = await super.acquireAccessToken();
    console.log(`Microsoft Graph access token acquired (${token.length} characters).`);
    return token;
  }
}

const mailer = new AuditedAzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const result = await mailer.send({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'Authenticated send',
  text: 'Delivered with an app-only Microsoft Graph token.',
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

### Key Methods and Properties

| Name | Type/Signature | Description |
| --- | --- | --- |
| `acquireAccessToken` | `protected () => Promise<string>` | Requests an app-only token for `https://graph.microsoft.com/.default`; throws a bounded error on any failure. |
| `msalClient` | `protected readonly ConfidentialClientApplication` | The MSAL instance configured with the client ID, secret, and tenant authority. |
| `GRAPH_DEFAULT_SCOPE` | `'https://graph.microsoft.com/.default'` (module constant, not exported) | The scope requested during token acquisition. |
| `health` | `() => Promise<boolean>` | Non-throwing authentication probe; `true` when a token can be obtained. |

---

## Message Mapping to Microsoft Graph

### What It Is

Message mapping is the translation layer that converts the provider-neutral `MailMessage` from the BlendSDK mailer contract into the Microsoft Graph JSON model used by the `sendMail` action. It is implemented by the internal `buildGraphRequest()` function and its helpers, and it is the reason the same application code can target SMTP or Graph without changes.

### How It Works

`send()` builds the Graph request **before** acquiring a token or opening a connection. The builder validates fields in a fixed order — sender, subject, body, recipients, attachments — and then produces a `GraphSendMailRequest` with two top-level properties: `message` and `saveToSentItems`.

The field-for-field mapping is:

| `MailMessage` field | Graph JSON field | Notes |
| --- | --- | --- |
| `from` | `message.from.emailAddress` | Accepts `user@example.com` or `Name <user@example.com>`; the address must match the configured `senderMailbox` case-insensitively (the display name is not part of that comparison). |
| `to` | `message.toRecipients` | Single string or array; at least one recipient is required. |
| `cc` | `message.ccRecipients` | Omitted from the payload when not supplied. |
| `bcc` | `message.bccRecipients` | Omitted from the payload when not supplied. |
| `subject` | `message.subject` | Non-empty, at most 998 characters, no control characters. |
| `html` | `message.body` as `{ contentType: 'HTML', content }` | Preferred when present and non-empty. |
| `text` | `message.body` as `{ contentType: 'Text', content }` | Used only when no usable HTML body exists. |
| `attachments` | `message.attachments` | Mapped to `#microsoft.graph.fileAttachment` entries (see the next concept). |

Each recipient is wrapped in Graph's recipient envelope: `{ emailAddress: { address: 'user@example.com', name: 'Optional Name' } }`. Display names are normalized by stripping surrounding quotes and enforcing a 128-character limit with no `<`, `>`, or `"` characters.

After Graph accepts the request, `collectRecipientAddresses()` builds the `accepted` array from the validated Graph message in **To → CC → BCC order**, which is the exact order returned in `MailResult`.

### Complete Example

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const result = await mailer.send({
  from: 'Notifications <notifications@example.com>',
  to: ['alice@example.com', 'bob@example.com'],
  cc: 'manager@example.com',
  bcc: 'archive@example.com',
  subject: 'Monthly report',
  text: 'The report is attached. An HTML version is available.',
  html: '<p>The report is attached.</p>',
  attachments: [
    {
      filename: 'report.txt',
      content: Buffer.from('report contents'),
      contentType: 'text/plain',
    },
  ],
});

// HTML wins when both body forms are supplied.
console.log(`Accepted in To/CC/BCC order: ${result.accepted.join(', ')}`);
```

### Key Methods and Properties

These helpers are module-private (they are not exported from the package); they are documented here because they define the observable mapping behavior of every `send()` call.

| Name | Type/Signature | Description |
| --- | --- | --- |
| `buildGraphRequest` | `(message: MailMessage, config: Readonly<AzureMailConfig>) => GraphSendMailRequest` | Validates and assembles the complete `sendMail` request body, including `saveToSentItems` (defaults to `true`). |
| `selectBody` | `(message: MailMessage) => { contentType: 'HTML' \| 'Text'; content: string }` | Picks HTML when present and non-empty, otherwise text; throws when neither exists. |
| `parseMailbox` | `(value: string, fieldName: string) => ParsedMailbox` | Parses a plain or display-name mailbox into Graph's `emailAddress` model. |
| `parseRecipients` | `(recipients: string \| string[], fieldName: string) => GraphRecipient[]` | Normalizes single-or-array recipients; throws when the list is empty or any address is invalid. |
| `collectRecipientAddresses` | `(message: GraphMessage) => string[]` | Builds the `accepted` list in To → CC → BCC order. |

---

## Attachment Handling and the Direct-Send Limit

### What It Is

Attachments are mapped from the common `MailAttachment` shape (`filename`, `content`, optional `contentType`) into Graph `#microsoft.graph.fileAttachment` objects whose bytes travel as base64 `contentBytes`. Because the Graph `sendMail` action only supports **direct** attachments up to 3 MiB, the package exports `MAX_DIRECT_ATTACHMENT_BYTES` so applications can pre-check payload sizes without importing internal code.

### How It Works

`mapAttachments()` processes each attachment in sequence and accumulates a running total:

1. **Metadata validation** — `validateAttachmentMetadata()` rejects a filename that is empty, longer than 255 characters, or contains control characters, and rejects a `contentType` that is present but malformed (must match a conservative `type/subtype` token pattern such as `text/plain` or `image/svg+xml`, at most 127 characters). The MIME check blocks header-injection payloads like `text/plain\r\nInjected: value`.
2. **Content encoding** — `encodeAttachmentContent()` handles two content forms:
   - `Buffer` content is encoded directly with `toString('base64')`.
   - `string` content follows the common contract and must already be **canonical** base64: length divisible by 4, only the base64 alphabet (with up to two `=` padding characters), and a byte-for-byte round trip through `Buffer.from(value, 'base64').toString('base64')`. Strings like `'not base64'` are rejected with `Mail attachment string content must be valid base64.`
3. **Size guard** — after each attachment is encoded, its decoded byte length is added to the running total. If the total exceeds `MAX_DIRECT_ATTACHMENT_BYTES` (`3 * 1024 * 1024 - 1`, i.e. 3,145,727 bytes) the call throws `Mail attachments exceed the Microsoft Graph direct-send size limit.` — locally, before any token or network activity.
4. **Payload shaping** — each validated attachment becomes `{ '@odata.type': '#microsoft.graph.fileAttachment', name, contentType?, contentBytes }`. When there are no attachments, the `attachments` property is omitted from the Graph message entirely.

Payloads above the direct-send limit are **not** silently truncated or upgraded: the Graph draft + upload-session workflow requires broader mailbox permissions and is intentionally out of scope for this provider. If your application may exceed 3 MiB, split the payload or pre-check against the exported constant.

### Complete Example

```typescript
import { AzureMailProvider, MAX_DIRECT_ATTACHMENT_BYTES } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const result = await mailer.send({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'Attachment example',
  text: 'Two small attachments are included.',
  attachments: [
    {
      filename: 'totals.csv',
      content: Buffer.from('id,total\n1,42\n', 'utf8'),
      contentType: 'text/csv',
    },
    {
      filename: 'diagram.svg',
      content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" />').toString('base64'),
      contentType: 'image/svg+xml',
    },
  ],
});

console.log(`Accepted: ${result.accepted.join(', ')}`);

try {
  await mailer.send({
    from: 'notifications@example.com',
    to: 'customer@example.com',
    subject: 'Oversized attachment',
    text: 'This message is rejected locally.',
    attachments: [
      {
        filename: 'oversized.bin',
        content: Buffer.alloc(MAX_DIRECT_ATTACHMENT_BYTES + 1),
      },
    ],
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}
```

### Key Methods and Properties

| Name | Type/Value | Description |
| --- | --- | --- |
| `MAX_DIRECT_ATTACHMENT_BYTES` | `3145727` (exported constant) | `3 * 1024 * 1024 - 1`; the maximum combined decoded attachment size accepted without an upload session. |
| `mapAttachments` | `(attachments: MailAttachment[] \| undefined) => GraphFileAttachment[] \| undefined` | Validates metadata, encodes content, enforces the running size limit; returns `undefined` when no attachments are supplied. (Module-private.) |
| `encodeAttachmentContent` | `(content: Buffer \| string) => string` | Encodes buffers to base64 or verifies that string content is canonical base64. (Module-private.) |
| `validateAttachmentMetadata` | `(attachment: MailAttachment) => void` | Rejects malformed filenames and MIME types before serialization. (Module-private.) |

---

## Input Validation and Security Guardrails

### What It Is

Validation is a first-class concept in this package, not an afterthought. Every value that could end up in an authentication authority, a Graph URL, a JSON header field, or a base64 payload is checked by pure, dependency-free helpers before any credential is requested or any socket is opened. The constructor validates configuration; `send()` validates the message. Both pipelines are fail-fast and both produce stable, non-echoing error messages.

### How It Works

The guard strategy has three pillars:

1. **Control-character rejection** — `hasControlCharacters()` matches `[\u0000-\u001f\u007f]` and is applied to addresses, subjects, filenames, display names, and even the client secret. Characters like `\r\n` can create header-injection ambiguity if they reach transport layers, so input containing them is rejected outright (for example, a `to` value of `customer@example.com\r\nBcc: attacker@example.com`).
2. **Conservative allowlists over denylists** — instead of "escaping" input, each field must match a narrow, purpose-built grammar: UUIDs for `clientId`, UUID-or-DNS for `tenantId`, a bounded RFC-style email grammar (single `@`, local part ≤ 64 chars with no leading/trailing dot, domain labels per DNS rules, no `..` anywhere), and a token-pattern MIME check for attachment content types. A tenant value like `contoso.onmicrosoft.com/../organizations` fails the domain grammar instead of being sanitized.
3. **Ordering guarantees** — configuration is validated in the constructor before MSAL is constructed; the message is validated by `buildGraphRequest()` before `acquireAccessToken()` and before `fetch()`. A rejection therefore never touches the network and never consumes a token. This ordering is asserted by the test suite: validation failures are expected to leave `fetch` uncalled.

Because error messages are intentionally generic and never echo the offending value, they disclose nothing an attacker could use to probe the system, and they remain stable enough for applications to match on.

### Complete Example

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

try {
  await mailer.send({
    from: 'notifications@example.com',
    to: 'customer@example.com\r\nBcc: attacker@example.com',
    subject: 'Header injection attempt',
    text: 'This message never reaches Microsoft Graph.',
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  // Mail message to contains an invalid email address.
}
```

### Key Methods and Properties

| Guard | Applies To | Rule Enforced |
| --- | --- | --- |
| `validateConfig` | Provider configuration | UUID `clientId`; UUID-or-domain `tenantId`; bounded secret without control characters; bare `senderMailbox` (no display name). |
| `validateSubject` | `MailMessage.subject` | Non-empty, at most 998 characters, no control characters. |
| `parseMailbox` | `from` and all recipients | Conservative email grammar; optional display name up to 128 characters without `<`, `>`, or `"`. |
| `hasControlCharacters` | Every text field | Rejects `\u0000`–`\u001f` and `\u007f` to block header and log injection ambiguity. |
| `isCanonicalBase64` | String attachment content | Length divisible by 4, valid alphabet, byte-for-byte round trip through `Buffer`. |

Internal limits enforced by these guards:

| Constant | Value | Scope |
| --- | --- | --- |
| `MAX_EMAIL_LENGTH` | 254 | Email addresses |
| `MAX_SUBJECT_LENGTH` | 998 | Subject line |
| `MAX_FILENAME_LENGTH` | 255 | Attachment filename |
| `MAX_CONTENT_TYPE_LENGTH` | 127 | Attachment MIME type |
| `MAX_CLIENT_SECRET_LENGTH` | 4096 | Client secret |
| — (inline check) | 128 | Sender/recipient display name |
| `MAX_DIRECT_ATTACHMENT_BYTES` | 3145727 | Combined attachment payload (exported) |

---

## The azureMailPlugin Factory

### What It Is

`azureMailPlugin()` is the WebAFX integration point: a convenience factory that constructs an `AzureMailProvider` from your configuration and wraps it in the plugin definition produced by `createMailPlugin()` from `blendsdk/webafx-mailer`. Instead of wiring the provider into the container by hand, a WebAFX application calls `app.use(azureMailPlugin(config))` once and resolves the mailer as a singleton.

### How It Works

The factory is intentionally minimal — its entire body is `return createMailPlugin(new AzureMailProvider(config));` — and that simplicity carries three important behavioral consequences:

1. **Eager construction** — the provider (and therefore `validateConfig()`) runs at plugin-creation time. A bad `clientId`, `tenantId`, `clientSecret`, or `senderMailbox` throws while your application is still registering plugins, not on the first `send()`.
2. **Singleton registration** — `createMailPlugin` registers the provider as a container singleton. One instance (and therefore one MSAL token cache) serves the whole application, so token caching is shared across all mail-sending code paths.
3. **Naming and ordering** — the plugin registers under the default service name `mailer` with priority `30`. Supplying `serviceName` in the configuration (an inherited `MailProviderConfig` field) changes the registration name, which lets an application register more than one mailer — for example `graph-mailer` alongside a default.

The returned plugin object exposes `name`, `priority`, and `factory`; the `factory` is the function the container invokes to resolve the provider instance.

### Complete Example

```typescript
import { azureMailPlugin } from 'blendsdk/webafx-mailer-azure';

const plugin = azureMailPlugin({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
  serviceName: 'graph-mailer',
});

// Inside a WebAFX application this object is passed to app.use(plugin).
console.log(`Plugin: ${plugin.name} (priority ${plugin.priority})`);
// Plugin: graph-mailer (priority 30)
```

### Key Methods and Properties

| Name | Type/Signature | Description |
| --- | --- | --- |
| `azureMailPlugin` | `(config: AzureMailConfig) => ReturnType<typeof createMailPlugin>` | Constructs an `AzureMailProvider` and wraps it in the common mail plugin definition. Throws immediately when the configuration is invalid. |
| plugin `.name` | `string` | `'mailer'` by default; overridden by `config.serviceName`. |
| plugin `.priority` | `number` | `30`, the standard mail plugin priority. |
| plugin `.factory` | `function` | Container factory that returns the registered singleton provider. |

---

## Delivery Semantics and Bounded Errors

### What It Is

This concept covers what a successful `send()` actually guarantees, what `MailResult` contains, and the complete error taxonomy the provider produces. The design principle is honesty: the provider reports exactly what Microsoft Graph reported — an HTTP 202 acceptance — and never invents a message identifier, a delivery confirmation, or a per-recipient rejection that Graph did not return.

### How It Works

A `send()` call ends in one of exactly two ways:

**Success** — Graph responded with HTTP 202, meaning it accepted the message for **asynchronous** processing and transport by Exchange Online. The result is:

- `accepted`: every To, CC, and BCC address, in that order, as plain address strings.
- `rejected`: always empty, because the `sendMail` action returns no synchronous per-recipient outcomes.

Delivery, bounce generation, and non-delivery reports happen after the HTTP response and are invisible to this provider. If your application needs final delivery confirmation, it must be handled out of band (for example, by monitoring the sender mailbox or NDRs) — the Overview lists this as a deliberate non-goal.

**Failure** — all failures collapse into bounded, stable, non-leaking messages:

| Condition | Behavior |
| --- | --- |
| Success (HTTP 202) | Resolves `{ accepted: string[], rejected: [] }`; no message identifier is included. |
| Network failure or 30-second timeout | Throws `Microsoft Graph email request failed.` The original error (which could contain request details) is discarded. |
| Graph rejects (any non-202 status) | Throws `Microsoft Graph rejected the email request with HTTP {status}.` When the `Retry-After` header is numeric, the message appends ` Retry after {seconds} seconds.` — non-numeric values are ignored. |
| Authentication failure | Throws `Unable to authenticate with Microsoft Graph.` |
| Invalid configuration or message | Throws the specific validation error; no token is acquired and `fetch` is never called. |

The error design has two deliberate properties. First, **containment**: MSAL internals, bearer tokens, message bodies, and Graph response payloads never appear in thrown errors, so logging them cannot leak secrets. Second, **actionability**: status codes and a validated `Retry-After` delay give callers enough to implement backoff for throttling (HTTP 429) without exposing anything sensitive.

### Complete Example

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

try {
  const result = await mailer.send({
    from: 'notifications@example.com',
    to: 'customer@example.com',
    subject: 'Delivery semantics',
    text: 'Graph acceptance is not final delivery.',
  });

  console.log(`Graph accepted ${result.accepted.length} recipient(s) for asynchronous processing.`);
} catch (error) {
  if (error instanceof Error && error.message.includes('HTTP 429')) {
    console.error(`Throttled by Microsoft Graph: ${error.message}`);
  } else if (error instanceof Error) {
    console.error(`Send failed: ${error.message}`);
  }
}
```

### Key Methods and Properties

| Property / Condition | Type | Description |
| --- | --- | --- |
| `MailResult.accepted` | `string[]` | Recipient addresses Graph accepted for asynchronous processing, in To → CC → BCC order. |
| `MailResult.rejected` | `string[]` | Always empty; Graph `sendMail` returns no synchronous rejections. |
| HTTP 202 | success status | The only status treated as success. |
| `Retry-After` header | optional detail | Numeric values are surfaced as ` Retry after {seconds} seconds.` in the thrown error; anything else is ignored. |
| `GRAPH_REQUEST_TIMEOUT_MS` | `30_000` (module constant, not exported) | Upper bound on every Graph request via `AbortSignal.timeout`. |

---

# webafx-mailer-azure Basic Usage

This guide takes you from installation to a working Microsoft Graph email delivery in progressive steps. Each [Fundamentals](#fundamentals) subsection introduces exactly one new concept on top of the previous one. For architecture and deep dives, see the Overview and Core Concepts.

---

## Installation

### Direct Install

Install the provider together with its peer dependency, the common mailer contract:

```bash
npm install blendsdk/webafx-mailer-azure blendsdk/webafx-mailer
```

```bash
yarn add blendsdk/webafx-mailer-azure blendsdk/webafx-mailer
```

`@azure/msal-node` is a direct dependency of this package and is installed automatically.

### Umbrella Install

If you consume the `blendsdk` umbrella distribution, install the umbrella and the MSAL client:

```bash
npm install blendsdk @azure/msal-node
```

### Requirements

| Requirement | Details |
| --- | --- |
| Node.js | `>= 22.0.0` — needed for global `fetch`, `AbortSignal.timeout`, and `Buffer` |
| TypeScript | Strict mode, ESM-first (`"type": "module"`) |
| Entra application | Registered app with the Microsoft Graph `Mail.Send` **application** permission and admin consent |
| Exchange Online | Application RBAC scoping `Mail.Send` to the configured `senderMailbox` (recommended) |
| Network access | HTTPS to `login.microsoftonline.com` and `graph.microsoft.com` |

---

## Quick Start

The minimal setup: construct the provider with your Entra credentials and Exchange Online mailbox, then call `send()`.

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
  to: 'customer@example.com',
  subject: 'Welcome',
  text: 'Welcome to our service.',
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

Under the hood, each `send()` call:

1. Validates the configuration once in the constructor — a malformed `clientId`, `tenantId`, `clientSecret`, or `senderMailbox` throws immediately, before MSAL is created.
2. Validates and maps the message to a Microsoft Graph `sendMail` payload locally, before any credential or network activity.
3. Acquires an app-only access token through MSAL (`@azure/msal-node`) for the `https://graph.microsoft.com/.default` scope.
4. POSTs to `https://graph.microsoft.com/v1.0/users/{senderMailbox}/sendMail` with a 30-second timeout.
5. Resolves `{ accepted: string[], rejected: [] }` when Graph answers HTTP 202 — acceptance for asynchronous delivery, not final delivery confirmation.

---

## Fundamentals

### Sending a Text Message

The provider is constructed once with your Entra application and mailbox settings, then reused for every message. A text message needs only `from`, `to`, `subject`, and a body.

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
  to: 'customer@example.com',
  subject: 'Welcome',
  text: 'Welcome to our service.',
});

console.log(result);
// { accepted: ['customer@example.com'], rejected: [] }
```

Three rules apply to every message:

- The `from` address must match the configured `senderMailbox` (case-insensitive). Sending as any other mailbox is rejected locally.
- The message must contain a non-empty `text` or `html` body.
- The `subject` must be non-empty (at most 998 characters, no control characters).

A successful return means Microsoft Graph accepted the recipients for asynchronous processing. `rejected` is always empty because the Graph `sendMail` action returns no synchronous per-recipient outcomes and no message identifier is invented.

### Rich Recipients and Bodies

The next level of complexity: display names, multiple recipients, CC/BCC lists, and HTML bodies. All of this maps directly onto the common `MailMessage` contract.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const result = await mailer.send({
  from: 'Notifications <notifications@example.com>',
  to: ['alice@example.com', 'bob@example.com'],
  cc: 'manager@example.com',
  bcc: 'archive@example.com',
  subject: 'Monthly report',
  text: 'The report is attached. An HTML version is available.',
  html: '<p>The report is attached.</p>',
});

console.log(`Accepted in To/CC/BCC order: ${result.accepted.join(', ')}`);
```

Key behaviors:

- `to`, `cc`, and `bcc` each accept a single address or an array. At least one primary recipient is required.
- A display name may be used in the message `from` (`Notifications <notifications@example.com>`) and in any recipient. The configured `senderMailbox` itself must be a bare address.
- When both `text` and `html` are supplied, HTML is preferred — Graph messages carry a single body, and this provider selects the HTML form.
- `result.accepted` lists every address in **To → CC → BCC order**, exactly matching the submitted message.

### Adding Attachments

Attachments are passed as `filename`, `content`, and an optional `contentType`. Content can be a `Buffer` (encoded to base64 automatically) or a string that is already canonical base64.

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
  to: 'customer@example.com',
  subject: 'Totals report',
  text: 'The report is attached.',
  attachments: [
    {
      filename: 'totals.csv',
      content: Buffer.from('id,total\n1,42\n', 'utf8'),
      contentType: 'text/csv',
    },
    {
      filename: 'diagram.svg',
      content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" />').toString('base64'),
      contentType: 'image/svg+xml',
    },
  ],
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

Attachment rules:

- `contentType` is optional, but when present it must be a valid `type/subtype` token (for example `text/csv`), at most 127 characters.
- String content must be **canonical** base64 — generate it with `Buffer.from(...).toString('base64')`. A string like `'not base64'` is rejected.
- The combined decoded size of all attachments must not exceed `MAX_DIRECT_ATTACHMENT_BYTES` (`3 * 1024 * 1024 - 1` = 3,145,727 bytes). Larger payloads require the Graph draft + upload-session workflow, which is out of scope — and the package rejects them locally rather than truncating silently.

Pre-check a payload against the exported limit before building the message:

```typescript
import { MAX_DIRECT_ATTACHMENT_BYTES } from 'blendsdk/webafx-mailer-azure';

const payload = Buffer.from('report contents', 'utf8');

if (payload.byteLength > MAX_DIRECT_ATTACHMENT_BYTES) {
  throw new Error('Payload exceeds the Microsoft Graph direct-send attachment limit.');
}
```

### Registering with a WebAFX Application

In a WebAFX application you do not construct the provider by hand. `azureMailPlugin()` builds an `AzureMailProvider` from the same configuration object and wraps it in a plugin definition that registers it as a container singleton.

```typescript
import { azureMailPlugin } from 'blendsdk/webafx-mailer-azure';

const plugin = azureMailPlugin({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

console.log(`Registering ${plugin.name} with priority ${plugin.priority}.`);
// Registering mailer with priority 30.
```

Inside an application you pass this object to `app.use(plugin)` and resolve the mailer from the container. Three behavioral consequences matter:

1. **Eager construction** — the provider (and therefore configuration validation) runs when the plugin is created, so a bad configuration fails during application startup, not on the first `send()`.
2. **Singleton registration** — one provider instance, and therefore one MSAL token cache, serves the whole application.
3. **Naming** — the plugin registers as `mailer` with priority 30 by default; pass `serviceName` to register under a different name.

```typescript
import { azureMailPlugin } from 'blendsdk/webafx-mailer-azure';

const plugin = azureMailPlugin({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
  serviceName: 'graph-mailer',
});

console.log(`Registered as: ${plugin.name}`);
// Registered as: graph-mailer
```

### Health Checks and Shutdown

The final lifecycle concept: a non-throwing readiness probe and a graceful shutdown hook. Both are optional for simple applications.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const healthy = await mailer.health();
console.log(`Authentication ready: ${healthy}`);

await mailer.shutdown();
```

- `health()` resolves `true` when an access token can be obtained and `false` on any authentication failure — it never throws. Note that it verifies **authentication readiness only**: it cannot prove mailbox authorization without sending a message, so the `Mail.Send` permission and mailbox scoping still matter.
- `shutdown()` is an intentional no-op that resolves `undefined`. MSAL and native `fetch` retain no disposable transport, so it is safe to call from a graceful-shutdown handler and safe to omit entirely.

---

## Configuration

Every setting lives in a single `AzureMailConfig` object that is validated once by the constructor (and therefore also by `azureMailPlugin()`).

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `clientId` | `string` | Yes | — | Microsoft Entra application (client) identifier. Must be a valid UUID. |
| `clientSecret` | `string` | Yes | — | Entra application client secret. 1–4096 characters; control characters rejected. |
| `tenantId` | `string` | Yes | — | Entra tenant UUID or verified tenant domain (e.g. `contoso.onmicrosoft.com`). Authority paths such as `contoso.onmicrosoft.com/../organizations` are rejected. |
| `senderMailbox` | `string` | Yes | — | Exchange Online mailbox used by the Graph `sendMail` endpoint. Bare address only — no display name. |
| `saveToSentItems` | `boolean` | No | `true` | Whether Exchange Online keeps a copy of the submitted message in the sender mailbox's Sent Items. |
| `serviceName` | `string` | No | `'mailer'` | Inherited from `MailProviderConfig`. Plugin registration name used by `azureMailPlugin()`. |

A complete configuration example using environment variables, with Sent Items saving disabled:

```typescript
import { AzureMailProvider, type AzureMailConfig } from 'blendsdk/webafx-mailer-azure';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const config: AzureMailConfig = {
  tenantId: requireEnv('AZURE_TENANT_ID'),
  clientId: requireEnv('AZURE_CLIENT_ID'),
  clientSecret: requireEnv('AZURE_CLIENT_SECRET'),
  senderMailbox: 'notifications@example.com',
  saveToSentItems: false,
};

const mailer = new AzureMailProvider(config);

const result = await mailer.send({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'Configuration example',
  text: 'This message is not saved to Sent Items.',
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

**Notes on defaults**

- The configuration object is copied and frozen at construction time; mutating the object you passed in afterwards has no effect on the provider.
- `saveToSentItems` is read per request. Set it to `false` for high-volume notification mailboxes to avoid Sent Items growth; both the message and the flag travel in the same Graph request.

### Validation Limits

The constructor and `send()` enforce these bounds before any credential or network operation:

| Input | Constraint |
| --- | --- |
| `clientId` | Canonical UUID |
| `tenantId` | UUID or conservative DNS tenant name (≤ 253 characters) |
| `clientSecret` | 1–4096 characters, no control characters |
| `senderMailbox` | Valid bare email address (no display name, no control characters) |
| Message `subject` | 1–998 characters, no control characters |
| Email addresses (`from`, `to`, `cc`, `bcc`) | ≤ 254 characters, conservative grammar; embedded `\r\n` is rejected |
| Display names | ≤ 128 characters, no `<`, `>`, or `"` |
| Attachment `filename` | 1–255 characters, no control characters |
| Attachment `contentType` | Valid `type/subtype` token, ≤ 127 characters |
| Combined attachment payload | ≤ `MAX_DIRECT_ATTACHMENT_BYTES` (3,145,727 decoded bytes) |

---

## Error Handling

The package does not define custom error subclasses. Every failure is a standard `Error` with a stable, deliberately generic message that never echoes secrets, tokens, message bodies, or Graph response payloads — so the messages are safe to log and stable enough to match on. Use `error instanceof Error` narrowing before reading `error.message`.

### Error Categories

| Category | Thrown From | Message (pattern) | Retryable? |
| --- | --- | --- | --- |
| Configuration | `new AzureMailProvider(...)` / `azureMailPlugin(...)`, synchronously | `Azure mail clientId must be a valid UUID.` / `Azure mail tenantId must be a valid UUID or tenant domain.` / `Azure mail clientSecret is invalid.` / `Azure mail senderMailbox must not contain a display name.` | No — fix the configuration |
| Message validation | `send()`, before any network call | `Mail message ...` and `Mail attachment ...` variants (see below) | No — fix the message |
| Authentication | `send()` via `acquireAccessToken()` | `Unable to authenticate with Microsoft Graph.` | Not until credentials/permissions are corrected |
| Network / timeout | `send()`, `fetch` rejection or 30-second timeout | `Microsoft Graph email request failed.` | Yes — retry with backoff |
| Graph rejection | `send()`, any non-202 response | `Microsoft Graph rejected the email request with HTTP {status}.` plus, for a numeric `Retry-After` header, ` Retry after {seconds} seconds.` | 429/5xx: yes, with backoff; 4xx: inspect permissions and mailbox |

Message validation messages in full:

| Message | Meaning |
| --- | --- |
| `Mail message from address must match the configured senderMailbox.` | The message `from` address is not the configured mailbox (case-insensitive comparison, display name ignored). |
| `Mail message subject is invalid.` | Subject is empty, longer than 998 characters, or contains control characters. |
| `Mail message must contain a non-empty text or html body.` | Neither `text` nor `html` was supplied. |
| `Mail message {to\|cc\|bcc\|from} contains an invalid email address.` | Address fails the conservative grammar — includes header-injection attempts like `customer@example.com\r\nBcc: attacker@example.com`. |
| `Mail message {to\|cc\|bcc} must contain at least one recipient.` | An explicitly empty recipient array was supplied. |
| `Mail message contains an invalid sender display name.` | Display name is over 128 characters or contains `<`, `>`, or `"`. |
| `Mail attachment filename is invalid.` | Filename empty, over 255 characters, or contains control characters. |
| `Mail attachment contentType is invalid.` | Content type does not match the `type/subtype` token pattern. |
| `Mail attachment string content must be valid base64.` | String content is not canonical base64 — use `Buffer.from(...).toString('base64')`. |
| `Mail attachments exceed the Microsoft Graph direct-send size limit.` | Combined decoded attachments exceed 3,145,727 bytes. |

### Handling Configuration Errors

Configuration errors throw synchronously — catch them around construction or plugin creation, at application startup:

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

try {
  const mailer = new AzureMailProvider({
    tenantId: process.env.AZURE_TENANT_ID!,
    clientId: 'not-a-client-id',
    clientSecret: process.env.AZURE_CLIENT_SECRET!,
    senderMailbox: 'notifications@example.com',
  });
  console.log(`Provider ready: ${mailer.constructor.name}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  // Azure mail clientId must be a valid UUID.
}
```

### Handling Send Errors

`send()` failures fall into distinct categories you can dispatch on. Validation errors are guaranteed to occur **before** a token is acquired or `fetch` is called, so retrying them is pointless — fix the input instead. Network failures and HTTP 429 throttling are the retryable categories.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

try {
  const result = await mailer.send({
    from: 'notifications@example.com',
    to: 'customer@example.com',
    subject: 'Error handling example',
    text: 'Hello from Microsoft Graph.',
  });

  console.log(`Accepted: ${result.accepted.join(', ')}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);

  if (message === 'Unable to authenticate with Microsoft Graph.') {
    console.error('Authentication failed — check the client secret, tenant ID, and Mail.Send consent.');
  } else if (message === 'Microsoft Graph email request failed.') {
    console.error('Network or timeout failure — safe to retry with backoff.');
  } else if (message.includes('HTTP 429')) {
    console.error(`Throttled by Microsoft Graph — back off and retry. ${message}`);
  } else if (message.startsWith('Microsoft Graph rejected')) {
    console.error(`Microsoft Graph rejected the request: ${message}`);
  } else if (message.startsWith('Mail message') || message.startsWith('Mail attachment')) {
    console.error(`The message is invalid and was never sent: ${message}`);
  } else {
    console.error(`Unexpected failure: ${message}`);
  }
}
```

Two guarantees make this pattern reliable:

1. **Input rejection is local** — when a `Mail message ...` or `Mail attachment ...` error is thrown, no token was requested and no HTTP request was made. Reacting to such an error by retrying will always fail again; fix the message instead.
2. **Operational errors are bounded** — authentication, network, and Graph rejection errors contain only stable text, an HTTP status, and (when Graph supplied a numeric `Retry-After`) a retry delay. MSAL diagnostics, bearer tokens, message bodies, and Graph response payloads never appear, so these errors are safe to log verbatim.

For throttling, honor the surfaced delay: an error containing `Retry after 15 seconds.` is Graph's own instruction for when to try again. `health()` is the non-throwing complement to this table — it swallows every authentication failure and simply returns `false`.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
