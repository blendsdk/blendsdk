> **Package**: `blendsdk/webafx-mailer-azure`

# webafx-mailer-azure Best Practices

This document distills the practices that keep Microsoft Graph email delivery through `blendsdk/webafx-mailer-azure` fast, safe, and predictable. Every practice is presented as a paired ❌/✅ example with the reasoning behind it; for the complete API reference, see Core Concepts. The recurring themes are the ones the provider itself is built around: reuse the instance so MSAL's token cache works, treat a resolved `send()` as acceptance rather than delivery, and respect the fail-fast validation that runs before anything touches the network.

---

## At a Glance

| Concern | Do | Don't |
| --- | --- | --- |
| Provider lifecycle | Create one `AzureMailProvider` per process; use `azureMailPlugin()` in WebAFX apps | Construct a provider per request or per module |
| Secrets | Read `clientSecret` from the environment or a secret manager | Hardcode secrets into source or log the configuration object |
| Sender identity | Keep exactly one `senderMailbox` per provider and keep `from` equal to it | Attempt to send from a different mailbox with the same provider |
| Attachments | Pass `Buffer` content and pre-check `MAX_DIRECT_ATTACHMENT_BYTES` | Pass raw strings expecting encoding, or exceed the 3 MiB direct-send limit |
| Delivery semantics | Treat HTTP 202 as Graph accepting the message for asynchronous processing | Treat a resolved `send()` as final delivery or expect a message ID |
| Throttling | Back off with the surfaced `Retry-After` delay and a bounded number of attempts | Retry immediately in an unbounded loop |
| Shutdown | Drain in-flight `send()` promises, then call `shutdown()` | Assume `shutdown()` flushes or cancels pending sends |
| Body selection | Supply the body form you intend to deliver; HTML wins when both are present | Expect the `text` body to be delivered when `html` is also supplied |

---

## Do / Don't Pairs

### 1. Reuse one provider instance per process

#### ❌ Wrong

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

export async function sendWelcomeEmail(address: string): Promise<void> {
  const mailer = new AzureMailProvider({
    tenantId: process.env.AZURE_TENANT_ID!,
    clientId: process.env.AZURE_CLIENT_ID!,
    clientSecret: process.env.AZURE_CLIENT_SECRET!,
    senderMailbox: 'notifications@example.com',
  });

  await mailer.send({
    from: 'notifications@example.com',
    to: address,
    subject: 'Welcome',
    text: 'Welcome to our service.',
  });
}
```

#### ✅ Correct

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const senderMailbox = 'notifications@example.com';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox,
});

export async function sendWelcomeEmail(address: string): Promise<void> {
  await mailer.send({
    from: senderMailbox,
    to: address,
    subject: 'Welcome',
    text: 'Welcome to our service.',
  });
}
```

**Why**: Every `new AzureMailProvider(...)` creates its own `ConfidentialClientApplication` with an empty MSAL token cache. With a per-call provider, no message can ever reuse a cached token, so every send pays a full OAuth round trip to `login.microsoftonline.com` before the Graph request can even start. The constructor also re-runs configuration validation on every call, and each duplicate instance holds redundant MSAL state. Creating the provider once at module scope — or letting `azureMailPlugin()` register it as a container singleton in a WebAFX application — shares one token cache across every send in the process. Keeping the sender address in a single constant additionally guarantees that `from` always matches `senderMailbox`, which the provider enforces case-insensitively.

---

### 2. Keep the client secret out of source control

#### ❌ Wrong

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: 'contoso.onmicrosoft.com',
  clientId: '11111111-1111-4111-8111-111111111111',
  clientSecret: 'hardcoded-client-secret-value',
  senderMailbox: 'notifications@example.com',
});

export { mailer };
```

#### ✅ Correct

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const mailer = new AzureMailProvider({
  tenantId: requireEnv('AZURE_TENANT_ID'),
  clientId: requireEnv('AZURE_CLIENT_ID'),
  clientSecret: requireEnv('AZURE_CLIENT_SECRET'),
  senderMailbox: requireEnv('AZURE_SENDER_MAILBOX'),
});

export { mailer };
```

**Why**: A committed `clientSecret` lets anyone who finds it send mail as the configured mailbox until the secret is rotated, and the repository history keeps the leak alive even after a fix. Reading the secret from the environment (or a secret manager such as Azure Key Vault) at startup keeps it out of source control and lets each environment carry its own credential. `requireEnv` also converts a typo'd variable name into an immediate startup failure instead of an `undefined` value that fails later inside `validateConfig`. Note that the provider accepts a client secret of 1–4096 characters with no control characters, so store the exact secret value — trimming or templating it during deployment will break authentication with `Azure mail clientSecret is invalid.`

---

### 3. One sender mailbox per provider

#### ❌ Wrong

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

// Rejected before any network call: the message sender must match senderMailbox.
await mailer.send({
  from: 'billing@example.com',
  to: 'customer@example.com',
  subject: 'Your invoice',
  text: 'Your invoice is ready.',
});
```

#### ✅ Correct

```typescript
import { azureMailPlugin } from 'blendsdk/webafx-mailer-azure';

const notificationsPlugin = azureMailPlugin({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const billingPlugin = azureMailPlugin({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'billing@example.com',
  serviceName: 'billing-mailer',
});

export { notificationsPlugin, billingPlugin };
```

**Why**: An `AzureMailProvider` is bound to exactly one Exchange Online mailbox: `from` must equal `senderMailbox` (case-insensitively, ignoring an optional display name), and any mismatch throws `Mail message from address must match the configured senderMailbox.` before a token is acquired or a request is built. That is a deliberate anti-spoofing guard — it prevents a compromised or buggy caller from relabeling a message as coming from an arbitrary mailbox. The supported way to send from more than one mailbox is one provider (or one plugin) per mailbox, with a distinct `serviceName` so registrations don't collide — the default name `mailer` is already taken by the first plugin. Grant the Entra application `Mail.Send` access to each mailbox through Exchange Online Application RBAC, and never try to defeat the check by rewriting `from` values.

---

### 4. Attachments: Buffers, not raw strings; below the direct-send limit

#### ❌ Wrong

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
    to: 'customer@example.com',
    subject: 'Daily export',
    text: 'The export is attached.',
    attachments: [
      {
        filename: 'export.csv',
        content: 'id,total\n1,42\n',
      },
    ],
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}
```

#### ✅ Correct

```typescript
import { AzureMailProvider, MAX_DIRECT_ATTACHMENT_BYTES } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const attachments = [
  {
    filename: 'export.csv',
    content: Buffer.from('id,total\n1,42\n', 'utf8'),
    contentType: 'text/csv',
  },
];

const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.content.byteLength, 0);

if (totalBytes > MAX_DIRECT_ATTACHMENT_BYTES) {
  throw new Error('Attachments exceed the Microsoft Graph direct-send limit.');
}

await mailer.send({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'Daily export',
  text: 'The export is attached.',
  attachments,
});
```

**Why**: Attachment `content` is either a `Buffer` — encoded to base64 by the provider — or a string that must already be canonical base64. Supplying printable text as a string throws `Mail attachment string content must be valid base64.`, which is exactly what happens in the wrong example; passing a `Buffer` and letting the provider encode avoids that entire class of bug. The size pre-check matters because Graph's `sendMail` action only supports direct attachments up to 3 MiB: `mapAttachments()` accumulates decoded byte lengths across all attachments and throws `Mail attachments exceed the Microsoft Graph direct-send size limit.` when the total exceeds `MAX_DIRECT_ATTACHMENT_BYTES` (3,145,727 bytes). Checking the exported constant yourself lets your code fail with its own actionable message (for example, "upload the file and send a link instead") before the provider builds a doomed payload, and it scales to the cumulative total when a message carries several files.

---

### 5. Treat a resolved send() as acceptance, not delivery

#### ❌ Wrong

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
  subject: 'Order 1042 confirmed',
  text: 'Your order is confirmed.',
});

// The resolved promise only means Microsoft Graph accepted the request.
console.log(`Delivery confirmed for: ${result.accepted.join(', ')}`);
```

#### ✅ Correct

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
  subject: 'Order 1042 confirmed',
  text: 'Your order is confirmed.',
});

// HTTP 202: Graph accepted the message for asynchronous processing.
// Final delivery and bounces are observed out of band, for example as
// non-delivery reports in the sender mailbox.
console.log(`Graph accepted the message for ${result.accepted.length} recipient(s).`);
```

**Why**: `send()` resolves only when Microsoft Graph answers HTTP 202, which means the message was queued for asynchronous processing — transport, delivery, and any bounces happen afterwards and are invisible to this provider. `MailResult.rejected` is therefore always empty, and no message identifier is returned. Treating acceptance as delivery produces state like "customer notified" that can be wrong without anyone noticing; if delivery evidence matters (invoices, legal notices), monitor the sender mailbox for non-delivery reports and design your own idempotency and retry rules around acceptance rather than around a delivery receipt that never arrives.

---

### 6. Retry throttling with a bounded, Retry-After-aware backoff

#### ❌ Wrong

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

// Unbounded, immediate retries turn a short throttle into a longer outage.
for (;;) {
  try {
    await mailer.send({
      from: 'notifications@example.com',
      to: 'customer@example.com',
      subject: 'Invoice',
      text: 'Your invoice is attached.',
    });
    break;
  } catch {
    // Retry immediately.
  }
}
```

#### ✅ Correct

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';
import type { MailMessage } from 'blendsdk/webafx-mailer';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const MAX_ATTEMPTS = 3;
const RETRY_AFTER_PATTERN = /Retry after (\d+) seconds\./;

function getRetryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const seconds = RETRY_AFTER_PATTERN.exec(error.message)?.[1];
  return seconds === undefined ? undefined : Number(seconds) * 1000;
}

async function sendWithBackoff(message: MailMessage): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await mailer.send(message);
      return;
    } catch (error) {
      const throttled = error instanceof Error && error.message.includes('HTTP 429');
      if (!throttled || attempt === MAX_ATTEMPTS) {
        throw error;
      }

      const delayMs = getRetryAfterMs(error) ?? 2 ** attempt * 1000;
      await new Promise<void>(resolve => setTimeout(resolve, delayMs));
    }
  }
}
```

**Why**: Microsoft Graph throttles per mailbox and signals it with HTTP 429, which this provider surfaces as `Microsoft Graph rejected the email request with HTTP 429.` plus `Retry after {seconds} seconds.` when the response carries a numeric `Retry-After` header (non-numeric values are deliberately ignored). Immediate, unbounded retries ignore that signal, add load to an already-throttled mailbox, and can keep one failing message alive indefinitely — each attempt may also consume up to the provider's 30-second request timeout. The correct pattern retries only when the error is a throttle, waits for the server-provided delay when one exists (falling back to exponential backoff), and gives up after a small, fixed number of attempts so the failure reaches your error handling instead of looping forever. Do not retry other statuses blindly — a 401 or 403 from Graph means an authentication or permission problem that no amount of waiting will fix.

---

### 7. Drain in-flight sends before shutdown

#### ❌ Wrong

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

// Not awaited: process exit can abort the in-flight HTTP request.
void mailer.send({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'Shutdown example',
  text: 'This request may still be in flight.',
});

await mailer.shutdown();
process.exit(0);
```

#### ✅ Correct

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const inFlight = new Set<Promise<unknown>>();

async function track<T>(operation: Promise<T>): Promise<T> {
  inFlight.add(operation);
  try {
    return await operation;
  } finally {
    inFlight.delete(operation);
  }
}

async function drainAndShutdown(): Promise<void> {
  await Promise.allSettled([...inFlight]);
  await mailer.shutdown();
}

await track(
  mailer.send({
    from: 'notifications@example.com',
    to: 'customer@example.com',
    subject: 'Shutdown example',
    text: 'This request is drained before the process exits.',
  })
);

await drainAndShutdown();
```

**Why**: `shutdown()` is intentionally a no-op: neither MSAL nor native `fetch` holds a transport that needs disposal, so the provider has nothing to flush or cancel — and it does not track your in-flight `send()` calls. If the process exits while a request is still on the wire, that message is simply lost; HTTP 202 never arrives and nothing records the failure. Track the send promises your application creates and await them before exit; each request is independently bounded by the provider's 30-second `AbortSignal.timeout`, so the drain terminates even when Graph is unreachable. Calling `shutdown()` afterwards keeps the mailer lifecycle uniform with other providers, which pays off when the transport is swapped later.

---

### 8. Be deliberate about body selection (HTML wins)

#### ❌ Wrong

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
  subject: 'Body selection',
  text: 'The plain-text version, believed to be the fallback.',
  html: '<p>The HTML version, which is what recipients actually receive.</p>',
});
```

#### ✅ Correct

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const htmlBody = '<p>Release 5.x is available.</p>';

await mailer.send({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'Release 5.x',
  html: htmlBody,
});
```

**Why**: A Graph message carries exactly one body with a `contentType` of `HTML` or `Text`. `selectBody()` prefers `html` when it is a non-empty string and only falls back to `text` when no usable HTML exists, so passing both does not create a multipart/alternative message — the text is silently discarded. Decide which rendering you want delivered and pass only that; a message with neither (or with empty strings) throws `Mail message must contain a non-empty text or html body.`

---

## Anti-Patterns

### Constructing a provider per request

Each constructor call creates a fresh MSAL client with an empty token cache and re-validates the configuration. A per-request provider pays an OAuth round trip before every first Graph call and multiplies state instead of sharing it. Create one provider at module scope, or let `azureMailPlugin()` register the singleton in a WebAFX application — in serverless runtimes, keep it outside the handler so warm invocations reuse it.

### Assuming `MailResult.rejected` lists invalid recipients

`rejected` is always `[]`. Graph's `sendMail` action returns only HTTP 202 with no synchronous per-recipient verdicts, so a typo'd address is "accepted" and only surfaces later as a non-delivery report. Validate recipient syntax and business rules in your own layer; never build logic that reacts to `rejected`.

### Expecting a message identifier or delivery receipt

The provider deliberately reports no identifier and no delivery status. Do not try to invent one by querying Graph afterwards or by parsing anything out of the result; keep your own send journal keyed by your business identifiers (order number, account ID, correlation reference) and reconcile failures through NDRs or mailbox monitoring.

### Treating the bounded error messages as incomplete

Errors contain only stable text plus an HTTP status and an optional `Retry after N seconds.` — deliberately no tokens, no message bodies, and no Graph response payloads. Don't "improve" that by attaching `error.cause`, request bodies, or configuration objects when rethrowing or logging; you would reintroduce exactly the leak the provider avoids. Log your own non-sensitive context (mailbox, subject category, correlation ID) alongside the bounded message.

### Passing raw strings or hand-rolled base64 as attachment content

String content must be canonical base64 (length divisible by 4, valid alphabet, byte-for-byte round trip). Passing plain text throws `Mail attachment string content must be valid base64.`, and hand-encoding data yourself only adds a place to introduce subtle bugs. Pass a `Buffer` and let the provider encode it.

### Using `health()` as an authorization or delivery check

`health()` returns `true` as soon as MSAL can acquire an access token; it cannot verify that the Entra application has consented `Mail.Send` or that Exchange Online Application RBAC allows the `senderMailbox`. Use it once at startup to warm the token cache and fail fast on credential errors, then treat `HTTP 403` from a real `send()` as the signal that mailbox authorization needs attention.

### Relying on `shutdown()` to flush queued mail

There is no queue and no retained transport. `shutdown()` resolves immediately with no work performed, so pending or fire-and-forget `send()` calls are neither awaited nor canceled — and an unawaited send can be killed by process exit without a trace. Drain your own in-flight promises before exit (see pair 7).

### Swallowing send failures for "fire-and-forget" notifications

A bare `catch {}` around `send()` converts every failure — invalid configuration, authentication failure, throttling, network loss — into silence. Catch, log the bounded message with your own context, and mark affected records for retry or alerting; the bounded error text is stable enough to match on.

### Running the provider in a browser bundle

This is a Node.js package: it relies on global `fetch`, `AbortSignal`, and `Buffer`, and it requires an app-only client secret. Shipping it to clients would expose credentials that can send mail as your organization. Keep all mail sending server-side.

---

## Performance Tips

- **Reuse a single provider instance.** MSAL caches tokens inside the `ConfidentialClientApplication`; a fresh provider starts with an empty cache and must complete an OAuth round trip before its first Graph request. Module-scope construction — or `azureMailPlugin()`'s singleton — removes that per-process cost and shares the cache across every call site.

- **Warm the token cache at startup with one `health()` call.** The first real `send()` otherwise pays the token round trip in the middle of a user-facing flow. A startup probe moves that cost to boot time and fails fast when credentials are wrong:

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

if (!(await mailer.health())) {
  throw new Error('Microsoft Graph authentication is not ready.');
}
```

- **Bound bulk-send concurrency.** Each `send()` is one HTTPS POST; firing hundreds in parallel invites HTTP 429 throttling (Graph meters per mailbox) and holds every serialized payload in memory at once. A small worker pool keeps throughput high while staying under throttling limits:

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const senderMailbox = 'notifications@example.com';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox,
});

const MAX_CONCURRENT_SENDS = 4;

async function sendReleaseNotes(recipients: string[]): Promise<void> {
  const queue = [...recipients];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const address = queue.shift();
      if (address === undefined) {
        return;
      }

      await mailer.send({
        from: senderMailbox,
        to: address,
        subject: 'Release notes',
        text: 'The latest release notes are available.',
      });
    }
  }

  const workers = Array.from({ length: Math.min(MAX_CONCURRENT_SENDS, queue.length) }, () =>
    worker()
  );
  await Promise.all(workers);
}

await sendReleaseNotes(['alice@example.com', 'bob@example.com']);
```

- **Prefer links over large attachments.** Base64 inflates payloads by roughly 33% on the wire, and the provider holds the encoded content plus the JSON body in memory while serializing. The direct-send limit is 3 MiB per message across all attachments; for anything sizeable, upload the file elsewhere (for example to blob storage) and send a short link instead.

- **Opt out of Sent Items for machine-generated traffic when retention rules allow.** `saveToSentItems` defaults to `true`, so Exchange Online stores a copy of every notification and a high-volume stream grows the sender mailbox indefinitely. Setting `saveToSentItems: false` avoids that growth when no compliance requirement needs the copies.

- **Keep HTML bodies lean.** The body is embedded directly in the JSON request; megabyte-sized inline data URIs bloat every request, sit in memory on every retry, and can trip Exchange message-size limits that the package's validation does not check (only attachments are size-guarded). Host images externally and let the HTML reference them.

- **Don't call `health()` before every send.** Each `send()` already acquires a token (served from cache) and surfaces its own bounded errors; extra probes add calls without verifying anything new — and `health()` never proves mailbox authorization.

---

## Security Considerations

### Scope the Entra application to a single mailbox (least privilege)

Granting the Graph `Mail.Send` application permission with admin consent, without more, lets the app send as any mailbox in the tenant — an organization-wide relay if the secret leaks. Pair the permission with Exchange Online Application RBAC (or an ApplicationAccessPolicy) that restricts the application to the configured `senderMailbox`, and use one Entra app per mailbox or use case so revocation stays simple. `Mail.Send` is the only Microsoft Graph permission this provider needs.

### Store and rotate the client secret deliberately

Keep the secret in a secret manager or injected environment variable; never commit it, never log it, and never send it to the client. Rotate it on your organization's schedule and on any suspicion of exposure — because the provider reads the secret only at construction, a rotation is just a redeploy with the new value. The constructor rejects empty secrets, secrets over 4096 characters, and secrets containing control characters, which is often the telltale sign of corruption from copy/paste or templating.

### Never let untrusted input choose recipients

This is an app-only credential on the server side: it can send to any address your RBAC scope and tenant policy allow. If end users can trigger email (password resets, invitations, share features), validate that recipient addresses belong to the intended workflow and rate-limit per account. The provider's address grammar blocks malformed input and control characters, but "valid address" is not the same as "address this user is allowed to mail."

### Keep rejecting hostile input; don't pre-sanitize it

The provider rejects control characters in subjects, addresses, filenames, and display names precisely to stop header-injection attempts (`customer@example.com\r\nBcc: attacker@example.com` throws before any network call). Don't strip characters yourself and resend a "cleaned" value — treat a validation error on user-supplied data as a security signal and reject the request. Likewise, don't pass a tenant identifier containing path segments (`contoso.onmicrosoft.com/../organizations`) hoping to influence the MSAL authority; the tenant grammar rejects it, and the authority is built only from the validated value.

### Sanitize content before embedding it into HTML bodies

The provider maps `html` to the Graph payload verbatim — it does not sanitize markup. If any part of the body comes from user input, escape it (or run it through an allowlist sanitizer) so recipients can't be targeted with injected links, tracking pixels, or spoofed content that appears to come from your sender:

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

// Stands in for a value that originated from user input.
const customerName = 'Alice & Bob <billing@example.com>';

await mailer.send({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'Your billing profile changed',
  html: `<p>Hello ${escapeHtml(customerName)}, your billing profile was updated.</p>`,
});
```

### Keep logging free of secrets and message content

Message bodies and recipient lists are personal data; bearer tokens and secrets are credentials. The provider's bounded errors already exclude all of that — preserve the property by logging `error.message` plus your own non-sensitive context, rather than whole error objects, configuration dumps, or request payloads.

### Treat `health()` and readiness probes honestly

An authentication probe that returns `true` says nothing about mailbox authorization. A deployment with revoked RBAC will pass startup checks and fail every send with `Microsoft Graph rejected the email request with HTTP 403.` — alert on that pattern instead of assuming a green probe means mail works. Conversely, when authentication itself fails, every send throws `Unable to authenticate with Microsoft Graph.`; monitor the rate of that message as a credential-health signal.

### Validate attachments at the business layer

The provider checks filename length and control characters and enforces a conservative MIME `type/subtype` pattern, but it does not scan content or enforce business rules. If users supply files, apply your own allowlists (extensions, size ceilings below the direct-send limit), malware scanning, and content-type verification before handing attachments to the mailer.

---

# webafx-mailer-azure Testing Patterns

This document shows how to test code that uses `blendsdk/webafx-mailer-azure` and how the package's own tests are structured. Every pattern here is derived from the package's test files — `tests/azure-mail-provider.spec.test.ts`, `tests/azure-mail-provider.impl.test.ts`, and `tests/security/security.input-validation.test.ts` — which remain the source of truth.

The central testing insight for this package: **Microsoft Entra ID and Microsoft Graph are external services with no local emulator, so tests replace only those two boundaries** (the MSAL client and the global `fetch`) and exercise the real provider, the real validation pipeline, and the real message mapping.

---

## Test Strategy at a Glance

The package's suite is organized in three layers, each with a different focus:

| Suite | File | What it covers | Boundaries replaced |
| --- | --- | --- | --- |
| Contract (spec) | `tests/azure-mail-provider.spec.test.ts` | Entra authentication wiring, Graph URL and headers, full message mapping, result shape | `@azure/msal-node`, `fetch` |
| Implementation | `tests/azure-mail-provider.impl.test.ts` | Body selection, `saveToSentItems` default, error handling, `Retry-After`, `health()`, `shutdown()`, plugin metadata | `@azure/msal-node`, `fetch` |
| Security | `tests/security/security.input-validation.test.ts` | Configuration validation, sender/recipient rules, header injection, attachment limits and encoding | `fetch` only (to prove it is never called) |

Key principles that carry over to any test you write:

- **Replace only the external boundaries.** Keep `AzureMailProvider` real. Mocking the provider itself means you no longer test mapping, validation, or error shaping — the exact behavior this package exists for.
- **Validation is pure and needs no mocks.** The constructor and `send()` reject invalid input before any token or network activity, so validation tests can run with (at most) a `fetch` stub used solely to assert `fetch` was not called.
- **Errors are asserted by their stable messages.** The provider collapses all external failures into bounded, non-leaking messages that are safe to match on.
- **No Docker, no containers, no emulators.** There is no local stand-in for Exchange Online; the only optional integration environment is a real Microsoft 365 tenant.

Commands (from the package's `package.json`):

| Command | Runs |
| --- | --- |
| `yarn test` | `vitest run --reporter=verbose` |
| `yarn test:watch` | `vitest watch --reporter=verbose` |
| `yarn test:coverage` | `vitest run --coverage` (V8 provider via `@vitest/coverage-v8`) |

---

## Test Setup

### Test Framework and Runtime

- **Vitest 4.x** with the `--reporter=verbose` reporter, running in the default **Node environment** — no `jsdom`.
- **Node.js >= 22** provides the real `fetch`, `Response`, `AbortSignal.timeout`, and `Buffer` used by tests and by the provider.
- Test files are ESM TypeScript and import source modules with explicit `.js` specifiers, for example `import { AzureMailProvider } from '../src/azure-mail-provider.js';`.

### Required Imports

| Import | From | Purpose |
| --- | --- | --- |
| `describe`, `it`, `expect`, `vi`, `beforeEach` | `vitest` | Suite structure, assertions, mock control |
| `AzureMailProvider`, `MAX_DIRECT_ATTACHMENT_BYTES` | `../src/azure-mail-provider.js` | The provider under test and the exported attachment limit |
| `azureMailPlugin` | `../src/azure-mail-plugin.js` | The WebAFX plugin factory under test |
| `type AzureMailConfig` | `../src/types.js` | Typed configuration fixtures |
| Shared helpers | `./helpers/graph-test-helpers.js` | Fixtures, response factories, request-body reader |

### The Standard Test-File Prologue

Every in-package test file starts with the same boundary setup. This is the file skeleton that the feature patterns later in this document are appended to:

```typescript
// tests/azure-mail-provider.patterns.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const msal = vi.hoisted(() => ({
  acquireTokenByClientCredential: vi.fn(),
}));

vi.mock('@azure/msal-node', () => ({
  ConfidentialClientApplication: class {
    acquireTokenByClientCredential = msal.acquireTokenByClientCredential;
  },
}));

import { AzureMailProvider, MAX_DIRECT_ATTACHMENT_BYTES } from '../src/azure-mail-provider.js';
import { azureMailPlugin } from '../src/azure-mail-plugin.js';
import type { AzureMailConfig } from '../src/types.js';
import {
  graphAccepted,
  graphError,
  providerConfig,
  readRequestJsonBody,
  sendMinimalMessage,
} from './helpers/graph-test-helpers.js';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  msal.acquireTokenByClientCredential.mockReset();
  msal.acquireTokenByClientCredential.mockResolvedValue({ accessToken: 'access-token' });

  fetchMock.mockReset();
  fetchMock.mockResolvedValue(graphAccepted());
  vi.stubGlobal('fetch', fetchMock);
});
```

Why this prologue looks the way it does:

- **`vi.hoisted` is mandatory here.** `vi.mock` calls are hoisted above imports, so the mock factory cannot close over ordinary top-level variables. `vi.hoisted` creates state that the hoisted factory can safely reference.
- **The MSAL mock replaces the whole `@azure/msal-node` module.** The provider only needs `ConfidentialClientApplication`; the mock class assigns the mocked function as a **class field** so it stays bindable regardless of `this`.
- **Default token:** every test starts with MSAL resolving `{ accessToken: 'access-token' }`, which makes the `Authorization: Bearer access-token` header deterministic.
- **Default fetch:** every test starts with `fetch` resolving HTTP 202 (accepted). Tests override this per case with `mockResolvedValue` or `mockRejectedValue`.
- **Both mocks are reset in `beforeEach`** and their defaults re-applied immediately, so no test can leak behavior into the next.

Optionally restore globals after each test so the stub never survives beyond the file:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
});
```

### Shared Test Helpers

Pure, mock-free helpers live in a dedicated module. Keep `vi.mock` calls out of helper modules so Vitest hoisting stays predictable; helpers should only build values and read mock results.

```typescript
// tests/helpers/graph-test-helpers.ts
/**
 * Shared helpers for Microsoft Graph mail provider tests.
 *
 * Helpers are mock-free by design: module mocks stay in test files so that
 * Vitest hoisting remains predictable.
 */

import type { Mock } from 'vitest';

import type { AzureMailProvider } from '../../src/azure-mail-provider.js';

/** Valid application configuration reused across every test. */
export const providerConfig = {
  clientId: '11111111-1111-4111-8111-111111111111',
  clientSecret: 'test-client-secret',
  tenantId: 'contoso.onmicrosoft.com',
  senderMailbox: 'notifications@example.com',
};

/** Creates the HTTP 202 response returned when Graph accepts a message. */
export function graphAccepted(): Response {
  return new Response(null, { status: 202 });
}

/** Creates a Graph error response with an optional Retry-After header. */
export function graphError(status: number, retryAfter?: string): Response {
  const headers: Record<string, string> = {};
  if (retryAfter !== undefined) {
    headers['Retry-After'] = retryAfter;
  }

  return new Response('sensitive provider response', { status, headers });
}

/** Reads the JSON text body of a captured Graph fetch call. */
export function readRequestJsonBody(fetchMock: Mock<typeof fetch>, callIndex = 0): string {
  const body = fetchMock.mock.calls[callIndex]?.[1]?.body;
  if (typeof body !== 'string') {
    throw new Error('Expected the Graph request body to be JSON text.');
  }

  return body;
}

/** Sends a minimal valid message through the supplied provider. */
export async function sendMinimalMessage(provider: AzureMailProvider): Promise<void> {
  await provider.send({
    from: 'notifications@example.com',
    to: 'customer@example.com',
    subject: 'Test message',
    text: 'Hello',
  });
}
```

A complete test file that uses the helpers:

```typescript
// tests/helpers-usage.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const msal = vi.hoisted(() => ({
  acquireTokenByClientCredential: vi.fn(),
}));

vi.mock('@azure/msal-node', () => ({
  ConfidentialClientApplication: class {
    acquireTokenByClientCredential = msal.acquireTokenByClientCredential;
  },
}));

import { AzureMailProvider } from '../src/azure-mail-provider.js';
import {
  graphAccepted,
  graphError,
  providerConfig,
  readRequestJsonBody,
  sendMinimalMessage,
} from './helpers/graph-test-helpers.js';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  msal.acquireTokenByClientCredential.mockReset();
  msal.acquireTokenByClientCredential.mockResolvedValue({ accessToken: 'access-token' });

  fetchMock.mockReset();
  fetchMock.mockResolvedValue(graphAccepted());
  vi.stubGlobal('fetch', fetchMock);
});

describe('AzureMailProvider with shared helpers', () => {
  it('should report the retry delay from a throttled response', async () => {
    fetchMock.mockResolvedValue(graphError(429, '15'));
    const provider = new AzureMailProvider(providerConfig);

    await expect(sendMinimalMessage(provider)).rejects.toThrow('Retry after 15 seconds.');
  });

  it('should keep request bodies inspectable through the helper', async () => {
    const provider = new AzureMailProvider(providerConfig);

    await sendMinimalMessage(provider);

    expect(JSON.parse(readRequestJsonBody(fetchMock))).toMatchObject({
      saveToSentItems: true,
    });
  });
});
```

### Vitest Configuration for Consumer Projects

When testing application code outside this repository, a minimal config is enough — the default Node environment already provides `fetch`, `Response`, and `Buffer` on Node.js >= 22:

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
```

---

## Unit Testing

Unit testing code that uses this package comes down to choosing an isolation level. There are three, in increasing fidelity:

| Level | What is replaced | Best for | Speed |
| --- | --- | --- | --- |
| 1. Mock the package module | `blendsdk/webafx-mailer-azure` itself | Pure application logic; verifying what your code asks the mailer to do | Fastest |
| 2. Mock the external boundaries | `@azure/msal-node` + `fetch` only | Verifying the exact Graph request your application produces, including validation | Fast (no real network) |
| 3. Spy on an injected instance | One instance method via `vi.spyOn` | Code that receives a provider instance you control | Fastest |

All three levels use the same application code under test — a small `WelcomeService` — so you can see exactly how fidelity changes.

```typescript
// src/welcome-service.ts
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

/** Sends onboarding mail through the configured Microsoft Graph provider. */
export class WelcomeService {
  constructor(private readonly mailer: AzureMailProvider) {}

  /** Sends a welcome message and returns the recipients Graph accepted. */
  async sendWelcome(email: string): Promise<string[]> {
    const result = await this.mailer.send({
      from: 'notifications@example.com',
      to: email,
      subject: 'Welcome',
      text: 'Welcome to our service.',
    });

    return result.accepted;
  }
}
```

### Synchronous vs Asynchronous Assertions

| Scenario | Idiom |
| --- | --- |
| Constructor rejects bad configuration | `expect(() => new AzureMailProvider(config)).toThrow('...')` |
| `send()` rejects | `await expect(provider.send(message)).rejects.toThrow('...')` |
| `send()` succeeds | `await expect(provider.send(message)).resolves.toEqual({ accepted: [...], rejected: [] })` |
| `health()` probe | `await expect(provider.health()).resolves.toBe(true)` |
| Prove no network happened | `expect(fetchMock).not.toHaveBeenCalled()` **after** the `rejects` assertion |
| Prove no token was requested | `expect(msal.acquireTokenByClientCredential).not.toHaveBeenCalled()` |

One rule to remember: never wrap an async rejection in `expect(fn).toThrow` — always `await` a `.rejects` matcher, otherwise the assertion passes against the returned Promise instead of the rejection.

### Level 1 — Mocking the Package Module

Use this when the test is about *your* application logic, not about Graph behavior. The mock factory should provide every export the code under test imports.

```typescript
// tests/welcome-service.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const providerMock = vi.hoisted(() => ({
  send: vi.fn(),
  health: vi.fn(),
  shutdown: vi.fn(),
}));

vi.mock('blendsdk/webafx-mailer-azure', () => ({
  MAX_DIRECT_ATTACHMENT_BYTES: 3 * 1024 * 1024 - 1,
  AzureMailProvider: class {
    send = providerMock.send;
    health = providerMock.health;
    shutdown = providerMock.shutdown;
  },
  azureMailPlugin: vi.fn(() => ({
    name: 'mailer',
    priority: 30,
    factory: () => providerMock,
  })),
}));

import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

import { WelcomeService } from '../src/welcome-service.js';

const providerConfig = {
  clientId: '11111111-1111-4111-8111-111111111111',
  clientSecret: 'test-client-secret',
  tenantId: 'contoso.onmicrosoft.com',
  senderMailbox: 'notifications@example.com',
};

describe('WelcomeService', () => {
  beforeEach(() => {
    providerMock.send.mockReset();
    providerMock.send.mockResolvedValue({
      accepted: ['customer@example.com'],
      rejected: [],
    });
  });

  it('should send the welcome message and return accepted recipients', async () => {
    const service = new WelcomeService(new AzureMailProvider(providerConfig));

    await expect(service.sendWelcome('customer@example.com')).resolves.toEqual([
      'customer@example.com',
    ]);
    expect(providerMock.send).toHaveBeenCalledWith({
      from: 'notifications@example.com',
      to: 'customer@example.com',
      subject: 'Welcome',
      text: 'Welcome to our service.',
    });
  });

  it('should surface provider failures to the caller', async () => {
    providerMock.send.mockRejectedValue(new Error('Microsoft Graph email request failed.'));
    const service = new WelcomeService(new AzureMailProvider(providerConfig));

    await expect(service.sendWelcome('customer@example.com')).rejects.toThrow(
      'Microsoft Graph email request failed.'
    );
  });
});
```

Because the mocked class ignores the constructor argument, `new AzureMailProvider(providerConfig)` never validates the configuration and never creates an MSAL client — this level tests wiring, not behavior.

### Level 2 — Real Provider with Boundary Mocks

Use this when you want to verify the exact Graph request your application produces, including the package's validation pipeline. Only `@azure/msal-node` and the global `fetch` are replaced; `AzureMailProvider` is real.

```typescript
// tests/welcome-service.graph.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const msal = vi.hoisted(() => ({
  acquireTokenByClientCredential: vi.fn(),
}));

vi.mock('@azure/msal-node', () => ({
  ConfidentialClientApplication: class {
    acquireTokenByClientCredential = msal.acquireTokenByClientCredential;
  },
}));

import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

import { WelcomeService } from '../src/welcome-service.js';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  msal.acquireTokenByClientCredential.mockReset();
  msal.acquireTokenByClientCredential.mockResolvedValue({ accessToken: 'access-token' });

  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
});

describe('WelcomeService against the real provider', () => {
  it('should submit a Graph sendMail request for the new customer', async () => {
    const service = new WelcomeService(
      new AzureMailProvider({
        clientId: '11111111-1111-4111-8111-111111111111',
        clientSecret: 'test-client-secret',
        tenantId: 'contoso.onmicrosoft.com',
        senderMailbox: 'notifications@example.com',
      })
    );

    await service.sendWelcome('customer@example.com');

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://graph.microsoft.com/v1.0/users/notifications%40example.com/sendMail'
    );
    expect(options).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
    });

    const body = options?.body;
    if (typeof body !== 'string') {
      throw new Error('Expected a JSON request body.');
    }

    expect(JSON.parse(body)).toMatchObject({
      message: {
        from: { emailAddress: { address: 'notifications@example.com' } },
        toRecipients: [{ emailAddress: { address: 'customer@example.com' } }],
        subject: 'Welcome',
        body: { contentType: 'Text', content: 'Welcome to our service.' },
      },
    });
  });
});
```

This level also exercises the security posture: if `WelcomeService` ever built an invalid message, the real `send()` would reject locally and `fetchMock` would remain uncalled.

### Level 3 — Spying on an Injected Provider Instance

When your code receives a provider instance, you can construct a **real** provider (safe offline — the constructor only validates configuration and creates an MSAL client) and replace a single method with `vi.spyOn`.

```typescript
// tests/welcome-service.spy.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

import { WelcomeService } from '../src/welcome-service.js';

const providerConfig = {
  clientId: '11111111-1111-4111-8111-111111111111',
  clientSecret: 'test-client-secret',
  tenantId: 'contoso.onmicrosoft.com',
  senderMailbox: 'notifications@example.com',
};

describe('WelcomeService with a spied provider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should delegate the welcome message to the injected provider', async () => {
    const provider = new AzureMailProvider(providerConfig);
    const sendSpy = vi.spyOn(provider, 'send').mockResolvedValue({
      accepted: ['customer@example.com'],
      rejected: [],
    });

    const service = new WelcomeService(provider);
    await service.sendWelcome('customer@example.com');

    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy).toHaveBeenCalledWith({
      from: 'notifications@example.com',
      to: 'customer@example.com',
      subject: 'Welcome',
      text: 'Welcome to our service.',
    });
  });
});
```

No MSAL mock and no `fetch` stub are needed at this level: `send` is replaced before it can reach `acquireAccessToken()` or the network.

---

## Integration Testing

### What "Integration" Means for This Package

Microsoft Entra ID and Exchange Online are external SaaS services, and the Graph endpoint is a hard-coded constant inside the provider — you cannot redirect the provider to a local mock server. That shapes the integration strategy: **the highest-fidelity test that runs anywhere is one that exercises the real provider with only the two external boundaries replaced.** This is exactly what the package's contract suite documents in its header:

> *"Microsoft Entra and Graph are external services, so these tests replace only those boundaries while exercising the real provider and message mapping."*

| Component | Contract suite (`*.spec.test.ts`) | Live smoke test |
| --- | --- | --- |
| `AzureMailProvider` | **Real** | **Real** |
| Validation and mapping (`buildGraphRequest` pipeline) | **Real** | **Real** |
| `@azure/msal-node` | Mocked | Real |
| Global `fetch` / Microsoft Graph | Mocked (`Response` objects) | Real |
| Entra tenant and Exchange Online mailbox | Not involved | Required |

### No Docker Dependencies

There are no containers, emulators, or test doubles for Exchange Online. The only optional integration environment is a real Microsoft 365 tenant, and it should only ever be used for **live smoke tests that are explicitly opted into** (see below).

### Contract-Style Integration Test

This pattern combines the full pipeline — authentication wiring, endpoint, mapping, and result shape — in a single test, replacing only the external boundaries:

```typescript
describe('End-to-end contract with replaced external boundaries', () => {
  it('should authenticate, submit, and report accepted recipients for a full message', async () => {
    const provider = new AzureMailProvider({ ...providerConfig, saveToSentItems: false });

    const result = await provider.send({
      from: 'Notifications <notifications@example.com>',
      to: ['alice@example.com', 'bob@example.com'],
      cc: 'manager@example.com',
      bcc: 'archive@example.com',
      subject: 'Contract test',
      text: 'Hello',
      attachments: [
        {
          filename: 'note.txt',
          content: Buffer.from('note'),
          contentType: 'text/plain',
        },
      ],
    });

    expect(msal.acquireTokenByClientCredential).toHaveBeenCalledWith({
      scopes: ['https://graph.microsoft.com/.default'],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://graph.microsoft.com/v1.0/users/notifications%40example.com/sendMail'
    );
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
```

### Live Smoke Tests Against a Real Tenant

For occasional, manual verification against real Entra and Graph, gate the suite behind an environment flag so it never runs in shared CI. It sends **real email**, so use a dedicated test tenant, a dedicated sender mailbox with Exchange Online Application RBAC restricting `Mail.Send`, and a recipient you control.

```typescript
// tests/live/graph.live.test.ts
import { describe, expect, it } from 'vitest';

import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

/** Enables live Graph smoke tests; never enable this in shared CI. */
const smokeEnabled = process.env.AZURE_MAIL_SMOKE === '1';

/** Mailbox the live tenant is allowed to deliver to (one you control). */
const recipient = process.env.AZURE_MAIL_SMOKE_RECIPIENT ?? '';

describe.runIf(smokeEnabled && recipient.length > 0)('Microsoft Graph live smoke', () => {
  it(
    'should authenticate and submit a real message through the configured mailbox',
    { timeout: 30_000 },
    async () => {
      const provider = new AzureMailProvider({
        tenantId: process.env.AZURE_TENANT_ID!,
        clientId: process.env.AZURE_CLIENT_ID!,
        clientSecret: process.env.AZURE_CLIENT_SECRET!,
        senderMailbox: process.env.AZURE_SENDER_MAILBOX!,
        saveToSentItems: false,
      });

      await expect(provider.health()).resolves.toBe(true);

      const result = await provider.send({
        from: process.env.AZURE_SENDER_MAILBOX!,
        to: recipient,
        subject: `webafx-mailer-azure smoke ${new Date().toISOString()}`,
        text: 'Live smoke test message sent by the webafx-mailer-azure test suite.',
      });

      expect(result.accepted).toEqual([recipient]);
      expect(result.rejected).toEqual([]);

      await provider.shutdown();
    }
  );
});
```

Guidance for live tests:

- **Run manually only**, for example `AZURE_MAIL_SMOKE=1 AZURE_MAIL_SMOKE_RECIPIENT=you@example.com yarn vitest run tests/live/graph.live.test.ts`. `describe.runIf` evaluates at collection time, so the variables must be set before Vitest starts.
- **Raise the test timeout.** Real token acquisition plus a Graph round trip can exceed Vitest's default 5-second timeout; the example uses a per-test `{ timeout: 30_000 }` override.
- **Assert acceptance, not delivery.** Graph returns HTTP 202 and completes transport asynchronously; the smoke test deliberately stops at `accepted`. Verifying inbox arrival requires polling the recipient mailbox out of band.
- **`health()` proves authentication readiness, not mailbox authorization.** Only a real `send()` exercises the `Mail.Send` permission and RBAC scoping.
- **Keep runs minimal.** Graph throttles `sendMail` (HTTP 429 with `Retry-After`); the provider surfaces the delay in its error message, but a smoke suite should never depend on volume.

---

## Mocking & Stubbing

### Boundary Map

| Boundary | Mechanism | Rationale |
| --- | --- | --- |
| `@azure/msal-node` (token acquisition) | `vi.mock` with a factory backed by `vi.hoisted` | Tests must never contact Entra; token results must be deterministic |
| Global `fetch` (Graph HTTP) | `vi.stubGlobal('fetch', vi.fn<typeof fetch>())` | Return exact `Response` objects; inspect the outgoing request |
| The package module itself | `vi.mock('blendsdk/webafx-mailer-azure', factory)` | Consumer tests of pure application logic |
| A single instance method | `vi.spyOn(provider, 'send').mockResolvedValue(...)` | Application code that receives an injected provider |

What you should **not** mock:

- **The validation helpers.** They are module-private; exercise them through the constructor and `send()` and assert the thrown messages.
- **`Buffer`, `Response`, `AbortSignal`.** The real implementations are deterministic and are part of what you want to verify (e.g., base64 round trips).
- **MSAL in validation-only suites.** The constructor creates a real `ConfidentialClientApplication` without any network activity — the security suite in this package does exactly that and only stubs `fetch`. Add the MSAL mock only when the test touches token acquisition.

### Recipe 1 — Mocking `@azure/msal-node`

The minimal recipe (used by every in-package suite):

```typescript
import { vi } from 'vitest';

const msal = vi.hoisted(() => ({
  acquireTokenByClientCredential: vi.fn(),
}));

vi.mock('@azure/msal-node', () => ({
  ConfidentialClientApplication: class {
    acquireTokenByClientCredential = msal.acquireTokenByClientCredential;
  },
}));
```

To also verify how the provider wires the MSAL authority, capture constructor arguments:

```typescript
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
```

Then assert the client-credentials wiring in a test (remember to clear `msal.configurations.length = 0;` in `beforeEach`):

```typescript
expect(msal.configurations).toEqual([
  {
    auth: {
      clientId: providerConfig.clientId,
      clientSecret: providerConfig.clientSecret,
      authority: `https://login.microsoftonline.com/${providerConfig.tenantId}`,
    },
  },
]);
```

### Recipe 2 — Stubbing the Global `fetch`

```typescript
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
});
```

- `vi.fn<typeof fetch>()` keeps the mock fully typed: `mock.calls` is `[input, init?]` and `mockResolvedValue` accepts only a `Response`.
- Reset in `beforeEach` and immediately re-apply the accepted default; tests override per case with `fetchMock.mockResolvedValue(...)` or `fetchMock.mockRejectedValue(...)`.
- Common assertion idioms:

```typescript
// Exactly one request was made
expect(fetchMock).toHaveBeenCalledTimes(1);

// Endpoint and options of the first call
const [url, options] = fetchMock.mock.calls[0];

// The JSON body, always behind a type guard
const body = options?.body;
if (typeof body !== 'string') {
  throw new Error('Expected a JSON request body.');
}
expect(JSON.parse(body)).toMatchObject({ saveToSentItems: true });
```

### Recipe 3 — Crafting Graph Responses

| Scenario | Response to return |
| --- | --- |
| Accepted | `new Response(null, { status: 202 })` |
| Throttled with delay | `new Response(null, { status: 429, headers: { 'Retry-After': '15' } })` |
| Throttled with non-numeric delay | `new Response(null, { status: 429, headers: { 'Retry-After': 'soon' } })` |
| Error whose body must never leak | `new Response('sensitive provider response', { status: 500 })` |
| Network failure | `fetchMock.mockRejectedValue(new Error('socket details'))` |

The shared `graphAccepted()` and `graphError(status, retryAfter?)` factories from the helpers keep these cases consistent; note that `graphError` deliberately attaches a body so that "never leaks the response body" assertions are meaningful.

### Recipe 4 — Mocking the Package in Consumer Tests

When consumer code imports `azureMailPlugin`, mock the module and assert the configuration that the application forwards into it. Every export the code under test imports must exist in the factory.

```typescript
// src/bootstrap-mail.ts
import { azureMailPlugin } from 'blendsdk/webafx-mailer-azure';

/** Builds the Graph mail plugin from environment configuration. */
export function createMailPlugin(env: NodeJS.ProcessEnv) {
  const tenantId = env.AZURE_TENANT_ID;
  const clientId = env.AZURE_CLIENT_ID;
  const clientSecret = env.AZURE_CLIENT_SECRET;
  const senderMailbox = env.AZURE_SENDER_MAILBOX;

  if (!tenantId || !clientId || !clientSecret || !senderMailbox) {
    throw new Error('Microsoft Graph mail environment variables are incomplete.');
  }

  return azureMailPlugin({ tenantId, clientId, clientSecret, senderMailbox });
}
```

```typescript
// tests/bootstrap-mail.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pluginMock = vi.hoisted(() => vi.fn());

vi.mock('blendsdk/webafx-mailer-azure', () => ({
  MAX_DIRECT_ATTACHMENT_BYTES: 3 * 1024 * 1024 - 1,
  azureMailPlugin: pluginMock,
}));

import { createMailPlugin } from '../src/bootstrap-mail.js';

describe('createMailPlugin', () => {
  beforeEach(() => {
    pluginMock.mockReset();
    pluginMock.mockReturnValue({
      name: 'mailer',
      priority: 30,
      factory: vi.fn(),
    });
  });

  it('should forward environment values into the Graph mail configuration', () => {
    createMailPlugin({
      AZURE_TENANT_ID: 'contoso.onmicrosoft.com',
      AZURE_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
      AZURE_CLIENT_SECRET: 'test-client-secret',
      AZURE_SENDER_MAILBOX: 'notifications@example.com',
    });

    expect(pluginMock).toHaveBeenCalledWith({
      tenantId: 'contoso.onmicrosoft.com',
      clientId: '11111111-1111-4111-8111-111111111111',
      clientSecret: 'test-client-secret',
      senderMailbox: 'notifications@example.com',
    });
  });

  it('should reject an incomplete environment synchronously', () => {
    expect(() =>
      createMailPlugin({
        AZURE_TENANT_ID: 'contoso.onmicrosoft.com',
      })
    ).toThrow('Microsoft Graph mail environment variables are incomplete.');

    expect(pluginMock).not.toHaveBeenCalled();
  });
});
```

### Isolation and Hygiene

- **Reset before every test.** `mockReset()` clears both implementations and recorded calls; re-apply defaults immediately afterwards, exactly as the package suites do.
- **Vitest isolates test files by default** — each file gets a fresh module registry — but mocks are *not* reset between tests within a file unless you reset them.
- **Remove the fetch stub with `vi.unstubAllGlobals()`** in `afterEach` if other tests in the same file should observe the environment untouched.
- **Mock class fields, not prototype methods.** Assigning `acquireTokenByClientCredential` as a class field (as shown) keeps the same mocked function identity regardless of how the caller invokes it.
- **One copy of `@azure/msal-node`.** The `vi.mock` factory intercepts the module instance the provider actually loads; with a single hoisted installation this is automatic, but in layouts with duplicated dependencies (for example, strict nested installs) make sure the versions are deduplicated or add a `resolve.alias` in `vitest.config.ts`.

---

## Test Patterns by Feature

Every `describe` block below is appended to a file that begins with the standard prologue (MSAL mock, `fetchMock`, shared helpers, and `beforeEach` defaults) shown in [Test Setup](#the-standard-test-file-prologue). The prologue already imports `AzureMailProvider`, `MAX_DIRECT_ATTACHMENT_BYTES`, `azureMailPlugin`, the `AzureMailConfig` type, and all helpers.

### Configuration Validation

Configuration errors are thrown synchronously by the constructor, so they are asserted with `expect(() => ...).toThrow(...)`. A table-driven `it.each` keeps the cases aligned with the validation rules.

```typescript
const invalidConfigurations: [string, AzureMailConfig, string][] = [
  [
    'clientId that is not a UUID',
    { ...providerConfig, clientId: 'not-a-client-id' },
    'Azure mail clientId must be a valid UUID.',
  ],
  [
    'tenantId containing an authority path',
    { ...providerConfig, tenantId: 'contoso.onmicrosoft.com/../organizations' },
    'Azure mail tenantId must be a valid UUID or tenant domain.',
  ],
  [
    'empty clientSecret',
    { ...providerConfig, clientSecret: '' },
    'Azure mail clientSecret is invalid.',
  ],
  [
    'clientSecret containing control characters',
    { ...providerConfig, clientSecret: 'secret\nvalue' },
    'Azure mail clientSecret is invalid.',
  ],
  [
    'senderMailbox containing a display name',
    { ...providerConfig, senderMailbox: 'Notifications <notifications@example.com>' },
    'Azure mail senderMailbox must not contain a display name.',
  ],
];

describe('Configuration validation patterns', () => {
  it.each(invalidConfigurations)('should reject a %s', (_label, config, message) => {
    expect(() => new AzureMailProvider(config)).toThrow(message);
  });

  it('should accept a tenant domain instead of a UUID', () => {
    expect(
      () => new AzureMailProvider({ ...providerConfig, tenantId: 'contoso.onmicrosoft.com' })
    ).not.toThrow();
  });
});
```

### Authentication and Health

Token acquisition is tested by steering the MSAL mock. `health()` is a non-throwing probe; `send()` fails with a bounded error when no token is available.

```typescript
describe('Authentication patterns', () => {
  it('should report healthy when MSAL supplies an access token', async () => {
    const provider = new AzureMailProvider(providerConfig);

    await expect(provider.health()).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should report unhealthy when MSAL rejects authentication', async () => {
    msal.acquireTokenByClientCredential.mockRejectedValue(new Error('external failure'));
    const provider = new AzureMailProvider(providerConfig);

    await expect(provider.health()).resolves.toBe(false);
  });

  it('should reject sending when authentication resolves without a token', async () => {
    msal.acquireTokenByClientCredential.mockResolvedValue(null);
    const provider = new AzureMailProvider(providerConfig);

    await expect(sendMinimalMessage(provider)).rejects.toThrow(
      'Unable to authenticate with Microsoft Graph.'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should request the Graph default scope exactly once per send', async () => {
    const provider = new AzureMailProvider(providerConfig);

    await sendMinimalMessage(provider);

    expect(msal.acquireTokenByClientCredential).toHaveBeenCalledTimes(1);
    expect(msal.acquireTokenByClientCredential).toHaveBeenCalledWith({
      scopes: ['https://graph.microsoft.com/.default'],
    });
  });
});
```

### Request Mapping, Body Selection, and Results

These tests inspect the captured `fetch` call and parsed JSON body. The endpoint assertion doubles as a check that the sender mailbox is URL-encoded rather than interpolated raw.

```typescript
describe('Request mapping patterns', () => {
  it('should POST to the URL-encoded sender mailbox endpoint with a bearer token', async () => {
    const provider = new AzureMailProvider(providerConfig);

    await sendMinimalMessage(provider);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://graph.microsoft.com/v1.0/users/notifications%40example.com/sendMail'
    );
    expect(options).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should map a full message into the Graph JSON model', async () => {
    const provider = new AzureMailProvider({ ...providerConfig, saveToSentItems: false });

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

    expect(JSON.parse(readRequestJsonBody(fetchMock))).toEqual({
      message: {
        subject: 'Monthly report',
        from: {
          emailAddress: { address: 'notifications@example.com', name: 'Notifications' },
        },
        toRecipients: [
          { emailAddress: { address: 'alice@example.com' } },
          { emailAddress: { address: 'bob@example.com' } },
        ],
        ccRecipients: [{ emailAddress: { address: 'manager@example.com' } }],
        bccRecipients: [{ emailAddress: { address: 'archive@example.com' } }],
        body: { contentType: 'HTML', content: '<p>The report is attached.</p>' },
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

  it('should use a text body when HTML is absent', async () => {
    const provider = new AzureMailProvider(providerConfig);

    await sendMinimalMessage(provider);

    expect(JSON.parse(readRequestJsonBody(fetchMock))).toMatchObject({
      message: { body: { contentType: 'Text', content: 'Hello' } },
    });
  });

  it('should default saveToSentItems to true', async () => {
    const provider = new AzureMailProvider(providerConfig);

    await sendMinimalMessage(provider);

    expect(JSON.parse(readRequestJsonBody(fetchMock))).toMatchObject({ saveToSentItems: true });
  });

  it('should return accepted recipients in To, CC, then BCC order', async () => {
    const provider = new AzureMailProvider(providerConfig);

    const result = await provider.send({
      from: 'notifications@example.com',
      to: ['alice@example.com', 'bob@example.com'],
      cc: 'manager@example.com',
      bcc: 'archive@example.com',
      subject: 'Recipient order',
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
```

### Attachments and the Direct-Send Limit

Attachment tests cover encoding (Buffer and canonical base64), metadata validation, and the exact size boundary — a classic off-by-one to lock down. `MAX_DIRECT_ATTACHMENT_BYTES` is exported precisely so tests and applications can express the boundary without magic numbers.

```typescript
describe('Attachment patterns', () => {
  it('should encode Buffer content as canonical base64', async () => {
    const provider = new AzureMailProvider(providerConfig);
    const bytes = Buffer.from('report contents');

    await provider.send({
      from: 'notifications@example.com',
      to: 'customer@example.com',
      subject: 'Buffer attachment',
      text: 'Hello',
      attachments: [{ filename: 'report.bin', content: bytes }],
    });

    expect(JSON.parse(readRequestJsonBody(fetchMock))).toMatchObject({
      message: {
        attachments: [
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: 'report.bin',
            contentBytes: bytes.toString('base64'),
          },
        ],
      },
    });
  });

  it('should preserve canonical base64 string content', async () => {
    const provider = new AzureMailProvider(providerConfig);
    const encoded = Buffer.from('already encoded').toString('base64');

    await provider.send({
      from: 'notifications@example.com',
      to: 'customer@example.com',
      subject: 'Base64 attachment',
      text: 'Hello',
      attachments: [{ filename: 'data.bin', content: encoded }],
    });

    expect(JSON.parse(readRequestJsonBody(fetchMock))).toMatchObject({
      message: { attachments: [{ contentBytes: encoded }] },
    });
  });

  it('should reject non-canonical base64 string content locally', async () => {
    const provider = new AzureMailProvider(providerConfig);

    await expect(
      provider.send({
        from: 'notifications@example.com',
        to: 'customer@example.com',
        subject: 'Malformed attachment',
        text: 'Hello',
        attachments: [{ filename: 'report.txt', content: 'not base64' }],
      })
    ).rejects.toThrow('string content must be valid base64');

    expect(msal.acquireTokenByClientCredential).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject malformed MIME types locally', async () => {
    const provider = new AzureMailProvider(providerConfig);

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

  it('should allow exactly MAX_DIRECT_ATTACHMENT_BYTES and reject one byte more', async () => {
    const atLimit = new AzureMailProvider(providerConfig);

    await atLimit.send({
      from: 'notifications@example.com',
      to: 'customer@example.com',
      subject: 'At the limit',
      text: 'Hello',
      attachments: [
        { filename: 'at-limit.bin', content: Buffer.alloc(MAX_DIRECT_ATTACHMENT_BYTES) },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const overLimit = new AzureMailProvider(providerConfig);

    await expect(
      overLimit.send({
        from: 'notifications@example.com',
        to: 'customer@example.com',
        subject: 'Over the limit',
        text: 'Hello',
        attachments: [
          { filename: 'over-limit.bin', content: Buffer.alloc(MAX_DIRECT_ATTACHMENT_BYTES + 1) },
        ],
      })
    ).rejects.toThrow('attachments exceed the Microsoft Graph direct-send size limit');
  });
});
```

### Error Handling, Throttling, and Non-Leaking Errors

Failure paths are driven entirely through the `fetch` mock: a rejected promise for network failures, crafted `Response` objects for Graph statuses. For the non-leakage test, pass an `Error` instance to `rejects.toThrow` — that asserts the message **exactly**, so any appended response body would fail the assertion.

```typescript
describe('Error handling patterns', () => {
  it('should wrap network failures in a bounded error', async () => {
    fetchMock.mockRejectedValue(new Error('socket details that must not leak'));
    const provider = new AzureMailProvider(providerConfig);

    await expect(sendMinimalMessage(provider)).rejects.toThrow(
      'Microsoft Graph email request failed.'
    );
  });

  it('should surface the HTTP status and a numeric Retry-After delay', async () => {
    fetchMock.mockResolvedValue(graphError(429, '15'));
    const provider = new AzureMailProvider(providerConfig);

    await expect(sendMinimalMessage(provider)).rejects.toThrow(
      'Microsoft Graph rejected the email request with HTTP 429. Retry after 15 seconds.'
    );
  });

  it('should ignore a non-numeric Retry-After header', async () => {
    fetchMock.mockResolvedValue(graphError(429, 'soon'));
    const provider = new AzureMailProvider(providerConfig);

    await expect(sendMinimalMessage(provider)).rejects.toThrow(
      'Microsoft Graph rejected the email request with HTTP 429.'
    );
  });

  it('should not include the Graph response body in the error', async () => {
    fetchMock.mockResolvedValue(new Response('sensitive provider response', { status: 500 }));
    const provider = new AzureMailProvider(providerConfig);

    await expect(sendMinimalMessage(provider)).rejects.toThrow(
      new Error('Microsoft Graph rejected the email request with HTTP 500.')
    );
  });
});
```

Because the provider bounds every request with `AbortSignal.timeout(30_000)`, a timeout surfaces as a rejected `fetch` promise and is covered by the network-failure pattern — no fake timers are required.

### Validation Failures and Injection Resistance

These tests assert both the rejection **and** that nothing external was touched. If a test file only exercises validation, the MSAL mock is optional (the provider can be constructed against the real MSAL client offline); keep it, as shown here, when you also want to prove that no token was ever requested.

```typescript
describe('Validation failure patterns', () => {
  it('should reject a sender that does not match the configured mailbox', async () => {
    const provider = new AzureMailProvider(providerConfig);

    await expect(
      provider.send({
        from: 'other@example.com',
        to: 'customer@example.com',
        subject: 'Sender mismatch',
        text: 'Hello',
      })
    ).rejects.toThrow('from address must match the configured senderMailbox');

    expect(msal.acquireTokenByClientCredential).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject recipient header injection before acquiring a token', async () => {
    const provider = new AzureMailProvider(providerConfig);

    await expect(
      provider.send({
        from: 'notifications@example.com',
        to: 'customer@example.com\r\nBcc: attacker@example.com',
        subject: 'Injection attempt',
        text: 'Hello',
      })
    ).rejects.toThrow('to contains an invalid email address');

    expect(msal.acquireTokenByClientCredential).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject subject header injection', async () => {
    const provider = new AzureMailProvider(providerConfig);

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
    const provider = new AzureMailProvider(providerConfig);

    await expect(
      provider.send({
        from: 'notifications@example.com',
        to: 'customer@example.com',
        subject: 'No body',
      })
    ).rejects.toThrow('must contain a non-empty text or html body');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

### Plugin Registration

The plugin factory is tested at the metadata level — `name`, `priority`, and `factory` — plus a custom `serviceName` and the eager constructor validation that happens at plugin-creation time.

```typescript
describe('Plugin registration patterns', () => {
  it('should register the provider under the default mailer service name', () => {
    const plugin = azureMailPlugin(providerConfig);

    expect(plugin.name).toBe('mailer');
    expect(plugin.priority).toBe(30);
    expect(typeof plugin.factory).toBe('function');
  });

  it('should register under a custom service name', () => {
    const plugin = azureMailPlugin({ ...providerConfig, serviceName: 'graph-mailer' });

    expect(plugin.name).toBe('graph-mailer');
  });

  it('should validate configuration eagerly at plugin-creation time', () => {
    expect(() => azureMailPlugin({ ...providerConfig, clientSecret: '' })).toThrow(
      'Azure mail clientSecret is invalid.'
    );
  });
});
```

### Lifecycle

`shutdown()` is an intentional no-op, and the result shape is deliberately minimal — the test asserts both the exact object and that no extra keys (such as an invented message identifier) exist.

```typescript
describe('Lifecycle patterns', () => {
  it('should shut down without retaining external resources', async () => {
    const provider = new AzureMailProvider(providerConfig);

    await expect(provider.shutdown()).resolves.toBeUndefined();
  });

  it('should not invent a message identifier in the result', async () => {
    const provider = new AzureMailProvider(providerConfig);

    const result = await provider.send({
      from: 'notifications@example.com',
      to: 'customer@example.com',
      subject: 'Result shape',
      text: 'Hello',
    });

    expect(result).toEqual({ accepted: ['customer@example.com'], rejected: [] });
    expect(Object.keys(result).sort()).toEqual(['accepted', 'rejected']);
  });
});
```

---

## Assertion Quick Reference

The provider's error messages are part of its observable contract — they are stable, bounded, and safe to assert on. Match them as substrings with `toThrow('...')`, or pass an `Error` instance for exact equality (useful for non-leakage tests).

| Exact message | Trigger |
| --- | --- |
| `Azure mail clientId must be a valid UUID.` | Constructor with a malformed `clientId` |
| `Azure mail tenantId must be a valid UUID or tenant domain.` | Constructor with a malformed `tenantId` |
| `Azure mail clientSecret is invalid.` | Constructor with an empty, oversized, or control-character secret |
| `Azure mail senderMailbox must not contain a display name.` | Constructor with `Name <addr>` in `senderMailbox` |
| `Mail message from address must match the configured senderMailbox.` | `send()` where `from` differs from the configured mailbox |
| `Mail message from contains an invalid email address.` | `send()` with a malformed `from` |
| `Mail message to contains an invalid email address.` | `send()` with a malformed recipient (`cc`/`bcc` analogously) |
| `Mail message to must contain at least one recipient.` | `send()` with an empty recipient array (`cc`/`bcc` analogously) |
| `Mail message contains an invalid sender display name.` | Display name with `<`, `>`, `"`, or over 128 characters |
| `Mail message subject is invalid.` | Empty, oversized, or control-character subject |
| `Mail message must contain a non-empty text or html body.` | Neither `text` nor `html` supplied |
| `Mail attachment filename is invalid.` | Empty, oversized, or control-character filename |
| `Mail attachment contentType is invalid.` | Malformed MIME type, including injection payloads |
| `Mail attachment string content must be valid base64.` | Non-canonical base64 string content |
| `Mail attachments exceed the Microsoft Graph direct-send size limit.` | Combined decoded attachments above `MAX_DIRECT_ATTACHMENT_BYTES` |
| `Unable to authenticate with Microsoft Graph.` | MSAL rejects, returns `null`, or omits the access token |
| `Microsoft Graph email request failed.` | `fetch` rejects (network failure or the 30-second timeout) |
| `Microsoft Graph rejected the email request with HTTP {status}.` | Any non-202 Graph response; a numeric `Retry-After` appends ` Retry after {seconds} seconds.` |

---

# webafx-mailer-azure Troubleshooting

`blendsdk/webafx-mailer-azure` is built to fail fast and fail quietly. Invalid input is rejected before any credential or socket is touched, and every external failure (MSAL, network, Microsoft Graph) is collapsed into a small set of bounded error messages that never contain secrets, tokens, message content, or Graph response bodies. That design is deliberate, but it means you must know **which stage** produced a message before you can diagnose it. Every `send()` call moves through four stages:

| Stage | What runs | Message prefix | Network activity |
| --- | --- | --- | --- |
| Configuration | `validateConfig()` inside the constructor (also runs eagerly from `azureMailPlugin()`) | `Azure mail ...` or `Mail message senderMailbox ...` | None |
| Message validation | `buildGraphRequest()` at the top of `send()` | `Mail message ...` / `Mail attachment ...` | None — the package's own tests assert `fetch` is never called |
| Authentication | MSAL client-credentials token acquisition | `Unable to authenticate with Microsoft Graph.` | Token endpoint only |
| Transport / Graph | `fetch()` POST to `/users/{senderMailbox}/sendMail` | `Microsoft Graph email request failed.` or `Microsoft Graph rejected the email request with HTTP ...` | Graph endpoint |

---

## Common Errors

### Configuration Errors

These throw from `new AzureMailProvider(config)` — and therefore also from `azureMailPlugin(config)`, which constructs the provider eagerly at plugin-registration time. No token is requested and no network call happens for any of them.

#### `Azure mail clientId must be a valid UUID.`

**Error**

```text
Azure mail clientId must be a valid UUID.
```

**Cause**

`config.clientId` does not match the strict RFC 4122 pattern used by the provider: version nibble `1`–`5`, variant nibble `8`, `9`, `a`, or `b`. The most common real-world triggers are using the application **object ID** (from *Enterprise applications*) instead of the **Application (client) ID**, leaving surrounding whitespace or braces (`{...}`) from a copy/paste, or passing an Application ID URI or secret ID.

**Fix**

1. Open the Entra admin center → **App registrations** → your app → **Overview**.
2. Copy **Application (client) ID** — the UUID at the top of the page, not the object ID shown further down.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

// Wrong: object ID of the enterprise app, or a value with braces/whitespace.
// const clientId = '{11111111-1111-4111-8111-111111111111}';

// Correct: Application (client) ID from App registrations → Overview.
const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: '11111111-1111-4111-8111-111111111111',
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const result = await mailer.send({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'Configuration check',
  text: 'The provider was constructed with a valid Entra application ID.',
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

#### `Azure mail tenantId must be a valid UUID or tenant domain.`

**Cause**

`config.tenantId` is neither a UUID (same strict pattern as `clientId`) nor a conservative DNS name — at least two labels, letters/digits/hyphens only. Frequent triggers:

- Copying the full authority URL (`https://login.microsoftonline.com/contoso.onmicrosoft.com`) instead of the tenant value.
- Appending a path or slash (`contoso.onmicrosoft.com/`). Path-style values are deliberately rejected so the MSAL authority cannot be manipulated.
- Using the multi-tenant aliases `common` or `organizations` — both fail the two-label DNS rule.
- A very old tenant GUID whose version/variant nibbles are not RFC 4122 compliant also fails the UUID check even though the GUID is "real".

**Fix**

Use the **Directory (tenant) ID** or a **verified domain** (`contoso.onmicrosoft.com`) exactly as shown in Entra → **Overview**. If a legitimate tenant GUID is rejected by the strict UUID check, the domain form works identically.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  // Either form is accepted:
  // tenantId: '22222222-2222-4222-8222-222222222222',
  tenantId: 'contoso.onmicrosoft.com',
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const healthy = await mailer.health();
console.log(healthy ? 'Tenant authority accepted; token acquired.' : 'Token acquisition failed.');
```

#### `Azure mail clientSecret is invalid.`

**Cause**

`config.clientSecret` is not a string, is empty, exceeds 4096 characters, or contains a control character (`\u0000`–`\u001f`, including `\n`, `\r`, and `\t`). Typical triggers: pasting the secret **ID** or a **certificate thumbprint** instead of the secret *Value*, copying from a file that appended a newline, or a missing environment variable (`undefined` fails the string check). Surrounding *spaces* are not control characters and pass this check — they fail later as an authentication error, so trim secret values defensively.

**Fix**

Use the secret **Value** from Entra → **App registrations** → **Certificates & secrets** (visible only at creation time).

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const mailer = new AzureMailProvider({
  tenantId: requireEnv('AZURE_TENANT_ID'),
  clientId: requireEnv('AZURE_CLIENT_ID'),
  // Trim defensively: a trailing newline fails validation,
  // and accidental surrounding spaces fail later at authentication time.
  clientSecret: requireEnv('AZURE_CLIENT_SECRET').trim(),
  senderMailbox: 'notifications@example.com',
});

const healthy = await mailer.health();
console.log(healthy ? 'Client secret accepted; token acquired.' : 'Client secret rejected by Entra.');
```

#### `Azure mail senderMailbox must not contain a display name.`

**Cause**

`config.senderMailbox` was given as `Notifications <notifications@example.com>`. The configured mailbox is interpolated into the Graph URL `/users/{senderMailbox}/sendMail`, so it must be a bare address. Display names are allowed only on `message.from`.

**Fix**

Keep the display name in the message; keep the configuration bare.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com', // bare address only
});

const result = await mailer.send({
  from: 'Notifications <notifications@example.com>', // display name lives here
  to: 'customer@example.com',
  subject: 'Display name',
  text: 'The sender shown to the recipient is "Notifications".',
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

#### `Mail message senderMailbox contains an invalid email address.`

**Error**

```text
Mail message senderMailbox contains an invalid email address.
```

**Cause**

Despite the `Mail message` prefix, this comes from the **constructor** and refers to the configuration field, not to anything passed to `send()`. `config.senderMailbox` failed the email grammar: it is empty, contains control characters, has a single-label domain (`admin@localhost`), or otherwise does not parse as a conservative address. Note that surrounding whitespace does **not** trigger this error — it is trimmed for the check but stored verbatim, causing later failures (see [Known Pitfalls](#known-pitfalls)).

**Fix**

Use the mailbox's primary SMTP address, bare and unpadded.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

// Rejected: 'notifications@localhost' (single-label domain), '' (empty),
//           any value with control characters.
const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const result = await mailer.send({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'Mailbox check',
  text: 'The configured sender mailbox is a full, unpadded SMTP address.',
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

### Message Validation Errors

All of these come from `buildGraphRequest()` inside `send()`, **before** a token is requested or a socket opened. Fields are validated in a fixed order — `from`, subject, body, `to`, `cc`, `bcc`, attachments — so when several fields are wrong you will see them one at a time, in that order.

#### `Mail message from address must match the configured senderMailbox.`

**Cause**

The address part of `message.from` (compared case-insensitively) is not equal to `config.senderMailbox`. Subtle cases include:

- Sending from an alias, a plus-address (`notifications+reports@example.com`), or a "Send As" proxy address instead of the mailbox itself.
- `config.senderMailbox` was stored with surrounding whitespace: validation trims for the check, but the *stored* value is compared verbatim, so the values can "look" identical and still fail.

**Fix**

Send exactly the configured mailbox; use the display name for presentation.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const senderMailbox = 'notifications@example.com';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox,
});

const result = await mailer.send({
  from: `Order Notifications <${senderMailbox}>`,
  to: 'customer@example.com',
  subject: 'Sender match',
  text: 'The from address matches the configured sender mailbox.',
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

#### `Mail message subject is invalid.`

**Cause**

The subject is empty, longer than 998 characters, or contains a control character. Template literals with indentation are a classic trigger: a tab (`\t`) or newline (`\n`) anywhere in the subject fails the check, and the message never echoes the offending character.

**Fix**

Collapse generated subjects to a single line before sending.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

function toSingleLine(subject: string): string {
  return subject.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 998);
}

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const result = await mailer.send({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: toSingleLine(`Order   1234
confirmed`),
  text: 'Line breaks and tabs in subjects are rejected by validation.',
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

#### `Mail message must contain a non-empty text or html body.`

**Cause**

Neither `message.html` nor `message.text` is a non-empty string. `undefined` and `''` both fail. When `html` is empty, the provider falls back to `text`; if that is also empty, this error throws. Remember that when both bodies are supplied, HTML wins and the text body is discarded.

**Fix**

Always supply at least one body.

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
  subject: 'Body required',
  html: '<p>Your order was confirmed.</p>',
  text: 'Your order was confirmed.',
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

#### `Mail message to contains an invalid email address.` (and `cc` / `bcc`)

**Cause**

The provider uses a conservative, ASCII-only grammar that is stricter than "what Exchange accepts". Rejections include:

- IDN / Unicode domains (`user@münchen.example`) — punycode them (`user@xn--mnchen-3ya.example`).
- Single-label domains (`user@localhost`) — at least two labels are required.
- Quoted local parts (`"jane doe"@example.com`).
- Two consecutive dots anywhere (`a..b@example.com`, `user@example..com`).
- A display name with an unmatched bracket: `Alice <alice@example.com` (missing `>`) means the whole string is treated as a bare address and fails.
- Addresses longer than 254 characters, or local parts longer than 64 characters.
- Control characters — including the classic injection attempt `customer@example.com\r\nBcc: attacker@example.com`.

**Fix**

Normalize to plain ASCII `user@domain` or `Display Name <user@domain>`.

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
  to: [
    'alice@example.com',
    'Bob Jones <bob@example.com>', // display name form is fine with a closing bracket
  ],
  subject: 'Recipient forms',
  text: 'Both plain and display-name addresses are accepted.',
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

#### `Mail message contains an invalid sender display name.`

**Cause**

A display name (in `from`, `to`, `cc`, or `bcc`) is longer than 128 characters, or contains `<`, `>`, or `"` after surrounding quotes are stripped. The message says "sender", but recipient display names are checked by the same helper and produce the same error.

**Fix**

Keep display names simple — letters, digits, spaces, and punctuation without brackets or quotes.

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
  // Rejected: 'Bob "The Builder" <bob@example.com>' — inner quotes are invalid.
  to: 'Bob The Builder <bob@example.com>',
  subject: 'Display names',
  text: 'Quotes and angle brackets may not appear inside a display name.',
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

#### `Mail message cc must contain at least one recipient.` (and `to`, `bcc`)

**Cause**

An empty array was supplied. `cc: []` is truthy, so it is parsed like a populated list and fails the non-empty requirement. Conditional code that computes a list often produces this when the list ends up empty.

**Fix**

Omit the field (or pass `undefined`) when the list is empty.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const ccList: string[] = [];

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const result = await mailer.send({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'Optional cc',
  text: 'An empty cc array would be rejected; undefined omits the field.',
  cc: ccList.length > 0 ? ccList : undefined,
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

### Attachment Errors

#### `Mail attachment filename is invalid.`

**Cause**

`attachment.filename` is not a string, is empty, exceeds 255 characters, or contains a control character — for example a generated filename that picked up a `\n`.

**Fix**

Sanitize generated filenames before building the message.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

function safeFilename(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, '_').trim().slice(0, 255);
}

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const result = await mailer.send({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'Filenames',
  text: 'Filenames cannot contain line breaks.',
  attachments: [
    { filename: safeFilename('report\n2024.txt'), content: Buffer.from('report') },
  ],
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

#### `Mail attachment contentType is invalid.`

**Cause**

`contentType` is present but empty, longer than 127 characters, or not a bare `type/subtype` token. MIME **parameters are not allowed**: `text/plain; charset=utf-8` fails, as does anything containing control characters.

**Fix**

Strip parameters, or omit `contentType` entirely when the type is unknown.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

function bareMimeType(value: string): string {
  return value.split(';', 1)[0].trim();
}

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const result = await mailer.send({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'MIME types',
  text: 'Attachment content types must be bare type/subtype tokens.',
  attachments: [
    {
      filename: 'notes.txt',
      content: Buffer.from('notes'),
      contentType: bareMimeType('text/plain; charset=utf-8'), // → 'text/plain'
    },
  ],
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

#### `Mail attachment string content must be valid base64.`

**Cause**

String content must be **canonical** standard base64: length divisible by 4 (padding present), only `A–Z a–z 0–9 + /` plus up to two trailing `=`, and the decoded bytes must re-encode to the identical string. Rejections include unpadded base64 (`'SGVsbG8'`), base64url (`-` and `_` instead of `+` and `/`), strings with line breaks or whitespace (common when base64 is wrapped at 76 columns), and plain text like `'report contents'`.

**Fix**

Pass a `Buffer`, or encode explicitly with `toString('base64')`.

```typescript
import { readFileSync } from 'node:fs';

import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const bytes = readFileSync('./reports/monthly.csv');

const result = await mailer.send({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'Base64 content',
  text: 'Attach a Buffer, or a canonical base64 string.',
  attachments: [
    { filename: 'monthly.csv', content: bytes, contentType: 'text/csv' },
    { filename: 'copy.csv', content: bytes.toString('base64'), contentType: 'text/csv' },
  ],
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

#### `Mail attachments exceed the Microsoft Graph direct-send size limit.`

**Cause**

The combined **decoded** size of all attachments exceeds `MAX_DIRECT_ATTACHMENT_BYTES` (3,145,727 bytes = 3 MiB − 1). The check runs after each attachment is encoded, so it catches the running total across the whole message, not per file. Note the JSON payload actually uploaded is roughly 33% larger than the decoded total because bytes travel as base64.

**Fix**

Pre-check totals against the exported constant and choose an alternative for larger payloads — a download link, or a split across messages. The Graph draft + upload-session workflow is intentionally out of scope.

```typescript
import { AzureMailProvider, MAX_DIRECT_ATTACHMENT_BYTES } from 'blendsdk/webafx-mailer-azure';
import type { MailAttachment } from 'blendsdk/webafx-mailer';

function totalAttachmentBytes(attachments: MailAttachment[]): number {
  return attachments.reduce((sum, attachment) => {
    const bytes = Buffer.isBuffer(attachment.content)
      ? attachment.content.byteLength
      : Buffer.from(attachment.content, 'base64').byteLength;
    return sum + bytes;
  }, 0);
}

const attachments: MailAttachment[] = [
  { filename: 'totals.csv', content: Buffer.from('id,total\n1,42\n', 'utf8'), contentType: 'text/csv' },
];

const total = totalAttachmentBytes(attachments);
if (total > MAX_DIRECT_ATTACHMENT_BYTES) {
  throw new Error(`Attachments total ${total} bytes; the direct-send limit is ${MAX_DIRECT_ATTACHMENT_BYTES}.`);
}

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const result = await mailer.send({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'Size pre-check',
  text: 'The payload was verified against the direct-send limit before sending.',
  attachments,
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

### Authentication Errors

#### `Unable to authenticate with Microsoft Graph.`

**Cause**

`acquireAccessToken()` collapses every MSAL failure into this single message by design, so tokens, secrets, and AADSTS details never leak into logs. (The internal message `Microsoft Graph authentication returned no access token.` is re-wrapped by the same catch and is never observable.) Underlying causes all concern the token endpoint `https://login.microsoftonline.com/{tenantId}`:

- A wrong `clientId`, `clientSecret`, or `tenantId`, or a secret that expired or was rotated.
- The app registration lives in a different tenant than `tenantId`.
- Egress to `login.microsoftonline.com` is blocked (firewall, proxy, DNS).
- Local clock skew larger than the allowed window.

Important: **consent for `Mail.Send` is not checked here.** An app without the permission still receives a token; that failure surfaces later as HTTP 403 from Graph.

**Fix**

1. Reproduce token acquisition with a direct MSAL script (see **Strategy 3: Surface detailed MSAL diagnostics**) to obtain the real AADSTS code — `AADSTS7000215` (invalid secret), `AADSTS7000222` (expired secret), `AADSTS700016` (app not found in directory).
2. Correct the identified value: re-copy the secret *Value*, confirm the tenant matches the app registration, verify egress.
3. Re-verify with `health()`.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const healthy = await mailer.health();
if (!healthy) {
  throw new Error('Token acquisition failed — run the direct MSAL diagnostic to see the AADSTS code.');
}

const result = await mailer.send({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'Authentication verified',
  text: 'MSAL acquired a token for the configured application.',
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

### Transport and Microsoft Graph Errors

#### `Microsoft Graph email request failed.`

**Cause**

`fetch` threw before a response existed — DNS failure, refused/reset connection, TLS failure, a blocked proxy, or the 30-second `AbortSignal.timeout` firing. The underlying error is discarded on purpose because it can contain request details.

**Fix**

1. **Connectivity.** Verify the process can reach both endpoints with the same resolver and proxy configuration as production.
2. **The timeout.** A request that timed out may still have been accepted by Graph after the client gave up. Confirm with an Exchange message trace before re-sending, or you risk duplicates.

```typescript
const endpoints = [
  `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID!}/v2.0/.well-known/openid-configuration`,
  'https://graph.microsoft.com/v1.0/$metadata',
];

for (const endpoint of endpoints) {
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(10_000) });
    console.log(`${response.status} ${endpoint}`);
  } catch (error) {
    console.error(
      `Unreachable: ${endpoint} — ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
```

#### `Microsoft Graph rejected the email request with HTTP {status}.`

**Cause**

Graph answered with anything other than HTTP 202. Authentication worked (a token was attached) and the request reached Exchange Online, which refused it. The thrown message contains only the status, plus ` Retry after {seconds} seconds.` when the `Retry-After` header is numeric; the Graph error body is never included.

**Fix**

Act on the status code:

| Status | Typical cause | Action |
| --- | --- | --- |
| 400 | Mailbox rejected the submission (e.g., sending disabled on the mailbox) | Verify the mailbox exists, is licensed, and is allowed to send |
| 401 | Token rejected by Graph (clock skew, stale token) | Usually transient — retry; if persistent, verify tenant details and system time |
| 403 | `Mail.Send` not granted/consented, or Exchange Online Application RBAC does not include this mailbox | Grant consent; scope the permission with the Exchange cmdlets below; allow up to ~1 hour for replication |
| 404 | Mailbox not found — misspelled or whitespace-padded `senderMailbox`, or no Exchange Online mailbox exists | Fix `senderMailbox`; confirm the user is mail-enabled |
| 429 | Throttling | Retry after the surfaced delay |
| 500/502/503/504 | Transient service error | Retry with backoff |

For 403, scope the application permission to the single mailbox with Exchange Online PowerShell:

```powershell
Connect-ExchangeOnline -UserPrincipalName admin@contoso.onmicrosoft.com

# Register the app's service principal in Exchange Online.
New-ServicePrincipal -AppId <clientId> -ObjectId <enterprise-app-object-id> -DisplayName "Graph Mailer"

# Restrict Application Mail.Send to the one mailbox.
New-ManagementScope -Name "MailerNotificationsMailbox" `
  -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'notifications@example.com'"

New-RoleAssignment -Principal "Graph Mailer" -Role "Application Mail.Send" `
  -Scope "MailerNotificationsMailbox"
```

Then retry with backoff — and note that this helper deliberately does **not** retry `Microsoft Graph email request failed.` (network/timeout), because that request may already have been delivered:

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';
import type { MailMessage, MailResult } from 'blendsdk/webafx-mailer';

function retryDelayMs(error: Error): number | undefined {
  const match = /Retry after (\d+) seconds\./.exec(error.message);
  const seconds = match?.[1];
  return seconds ? Number.parseInt(seconds, 10) * 1000 : undefined;
}

async function sendWithBackoff(
  mailer: AzureMailProvider,
  message: MailMessage,
  attempts = 3
): Promise<MailResult> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await mailer.send(message);
    } catch (error) {
      if (!(error instanceof Error) || attempt === attempts) {
        throw error;
      }

      const delay = retryDelayMs(error);
      const isRetryable = delay !== undefined || /HTTP (500|502|503|504)\./.test(error.message);
      if (!isRetryable) {
        throw error;
      }

      await new Promise<void>(resolve => setTimeout(resolve, delay ?? 2_000 * attempt));
    }
  }

  throw new Error('Mail send did not complete.');
}

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const result = await sendWithBackoff(mailer, {
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'Throttle-tolerant send',
  text: '429 and 5xx responses are retried with a bounded backoff.',
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

#### Symptom: `send()` resolves but the message is never delivered

**Symptom**

A successful result — `accepted` contains the recipient — but no email arrives and no error is thrown.

**Cause**

HTTP 202 means Graph queued the message for **asynchronous** processing. Delivery failures (invalid recipient, recipient-side rejection, mail flow rules, spam filtering) happen after the response and are reported through NDRs and message traces, not through this provider. `MailResult.rejected` is always empty because Graph `sendMail` returns no synchronous per-recipient outcomes.

**Fix**

1. Run an Exchange **message trace** for the sender mailbox (Exchange admin center → **Mail flow** → **Message trace**); check the status and events for the message.
2. If the trace says **Delivered**, check the recipient's junk/quarantine folders and any transport rules.
3. For a repeatable check, send a smoke test to an internal, monitored mailbox.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const smokeTestTo = 'mailer-smoke-test@example.com';
const result = await mailer.send({
  from: 'notifications@example.com',
  to: smokeTestTo,
  subject: `Mailer smoke test ${new Date().toISOString()}`,
  text: 'If this message does not arrive, check the Exchange message trace for this sender mailbox.',
});

console.log(`Graph accepted for asynchronous processing: ${result.accepted.join(', ')}`);
console.log('Delivery is confirmed by the message trace, not by this result.');
```

### TypeScript Compiler Errors

#### `TS2307: Cannot find module 'blendsdk/webafx-mailer-azure' or its corresponding type declarations.`

**Cause**

The package is not installed, or the consuming project uses a `moduleResolution` mode that ignores the `exports` map in `package.json` (the types live at `exports['.'].types` → `./dist/index.d.ts`).

**Fix**

1. Install the package — `yarn add blendsdk/webafx-mailer-azure` — and its peer `blendsdk/webafx-mailer` (usually installed automatically).
2. Set `moduleResolution` to `NodeNext` (with `module: NodeNext`) or `Bundler`.

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "verbatimModuleSyntax": true
  }
}
```

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

console.log(`AzureMailProvider resolved: ${typeof AzureMailProvider === 'function'}`);
```

#### `TS1192: Module 'blendsdk/webafx-mailer-azure' has no default export.`

**Cause**

`import AzureMailProvider from 'blendsdk/webafx-mailer-azure';` — the package is ESM with named exports only; there is no default export.

**Fix**

Use named imports.

```typescript
// Wrong: import AzureMailProvider from 'blendsdk/webafx-mailer-azure';
import {
  AzureMailProvider,
  azureMailPlugin,
  MAX_DIRECT_ATTACHMENT_BYTES,
} from 'blendsdk/webafx-mailer-azure';

console.log(
  `Exports resolved: ${typeof AzureMailProvider}, ${typeof azureMailPlugin}, ${MAX_DIRECT_ATTACHMENT_BYTES}`
);
```

#### `TS1484: 'AzureMailConfig' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled.`

**Cause**

`AzureMailConfig` is a type-only export. With `verbatimModuleSyntax` (or `isolatedModules` configurations requiring type-only imports), importing it as a value fails.

**Fix**

Use `import type`, or an inline `type` modifier.

```typescript
import { AzureMailProvider, type AzureMailConfig } from 'blendsdk/webafx-mailer-azure';

const config: AzureMailConfig = {
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
};

const mailer = new AzureMailProvider(config);
console.log(`Provider created for ${config.senderMailbox}: ${typeof mailer.send === 'function'}`);
```

#### `TS4114: This member must have an 'override' modifier because it overrides a member in the base class ...`

**Cause**

Subclassing to customize token acquisition (the documented extension point) without the `override` keyword while `noImplicitOverride` is enabled. The exact class name in the message depends on where the compiler resolves the member declaration.

**Fix**

Add `override` to the method.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

class InstrumentedMailer extends AzureMailProvider {
  protected override async acquireAccessToken(): Promise<string> {
    const token = await super.acquireAccessToken();
    console.log(`Access token acquired (${token.length} characters).`);
    return token;
  }
}

const mailer = new InstrumentedMailer({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const healthy = await mailer.health();
console.log(healthy ? 'Token acquisition works.' : 'Token acquisition failed.');
```

#### `TS2322: Type 'string | undefined' is not assignable to type 'string'.`

**Cause**

`process.env` values are `string | undefined` under strict mode, and every `AzureMailConfig` identity field is required.

**Fix**

Use a fail-fast environment helper so the configuration carries definite strings.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const mailer = new AzureMailProvider({
  tenantId: requireEnv('AZURE_TENANT_ID'),
  clientId: requireEnv('AZURE_CLIENT_ID'),
  clientSecret: requireEnv('AZURE_CLIENT_SECRET'),
  senderMailbox: 'notifications@example.com',
});

console.log(`Configuration loaded for ${'notifications@example.com'}.`);
```

#### `TS2554: Expected 1 arguments, but got 0.`

**Cause**

Calling `new AzureMailProvider()` without a configuration object. Configuration is required; there is no default credential chain.

**Fix**

Always pass a complete `AzureMailConfig`.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID ?? 'contoso.onmicrosoft.com',
  clientId: process.env.AZURE_CLIENT_ID ?? '11111111-1111-4111-8111-111111111111',
  clientSecret: process.env.AZURE_CLIENT_SECRET ?? 'development-secret',
  senderMailbox: 'notifications@example.com',
});

console.log(`Provider constructed for ${'notifications@example.com'}.`);
```

#### `TS2305: Module 'blendsdk/webafx-mailer-azure' has no exported member 'buildGraphRequest'.`

**Cause**

Trying to import internal helpers. The package's public surface is exactly `AzureMailProvider`, `azureMailPlugin`, `AzureMailConfig` (type only), and `MAX_DIRECT_ATTACHMENT_BYTES`; the request builder is module-private.

**Fix**

Use the public API. To inspect the Graph request body during development, use **Strategy 2: Inspect the Graph request without network or credentials**.

```typescript
// Wrong: import { buildGraphRequest } from 'blendsdk/webafx-mailer-azure';
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

console.log(`Public class available: ${typeof AzureMailProvider === 'function'}`);
```

### Module System and Runtime Errors

#### `ERR_PACKAGE_PATH_NOT_EXPORTED` when using `require()`

**Error**

```text
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './' is not defined by "exports" in .../blendsdk/webafx-mailer-azure/package.json
```

**Cause**

The package is ESM-only: `"type": "module"` and an `exports` map that defines only `types` and `import` conditions. CommonJS `require('blendsdk/webafx-mailer-azure')` cannot resolve it.

**Fix**

Use ESM `import` from ESM code, or a dynamic `import()` from CommonJS. Note that TypeScript down-levels dynamic `import()` to `require()` when compiling to `module: "commonjs"`, which reproduces the same failure — compile with `module: "NodeNext"` (or `ES2020`+) so the dynamic import is preserved.

```typescript
// From CommonJS code, load the ESM-only package with a dynamic import.
async function main(): Promise<void> {
  const { AzureMailProvider } = await import('blendsdk/webafx-mailer-azure');

  const mailer = new AzureMailProvider({
    tenantId: process.env.AZURE_TENANT_ID!,
    clientId: process.env.AZURE_CLIENT_ID!,
    clientSecret: process.env.AZURE_CLIENT_SECRET!,
    senderMailbox: 'notifications@example.com',
  });

  const healthy = await mailer.health();
  console.log(healthy ? 'Token acquisition works.' : 'Token acquisition failed.');
}

void main();
```

#### `Cannot find module '@azure/msal-node'`

**Cause**

The provider imports `ConfidentialClientApplication` from `@azure/msal-node` at module load time. When the package is consumed through the `blendsdk` umbrella distribution or a strict package manager configuration that does not resolve transitive dependencies, the module cannot be found.

**Fix**

Install the dependency explicitly — `yarn add @azure/msal-node` — then verify the package loads.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

console.log(`Package loaded: ${typeof AzureMailProvider === 'function'}`);
```

#### `ReferenceError: fetch is not defined` / `TypeError: AbortSignal.timeout is not a function`

**Cause**

The runtime is older than the supported baseline (Node.js >= 22). The provider uses the global `fetch` and `AbortSignal.timeout`, neither of which exists on older Node.js releases.

**Fix**

Run on Node.js 22 or newer and verify at startup.

```typescript
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
if (nodeMajor < 22) {
  throw new Error(`Node.js >= 22 is required; running ${process.versions.node}.`);
}

console.log(
  `Node.js ${process.versions.node}: fetch=${typeof fetch}, AbortSignal.timeout=${typeof AbortSignal.timeout}`
);
```

---

## Debugging Strategies

### Strategy 1: Classify the failure by stage

The error prefix tells you which subsystem to investigate. Classify first so you do not debug DNS when the problem is a malformed subject.

1. Log `error.message` verbatim — never log the message object or the request config (they contain secrets and content).
2. Classify with the helper below.
3. Investigate only the matching stage from the table at the top of this document.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

type FailureStage =
  | 'configuration'
  | 'message-validation'
  | 'authentication'
  | 'network'
  | 'graph-rejection'
  | 'unknown';

function classifyFailure(error: unknown): FailureStage {
  if (!(error instanceof Error)) {
    return 'unknown';
  }

  const message = error.message;

  if (message.startsWith('Azure mail ')) {
    return 'configuration';
  }
  if (message.startsWith('Mail message senderMailbox')) {
    // Configuration error thrown from the constructor with a "Mail message" prefix.
    return 'configuration';
  }
  if (message.startsWith('Mail message') || message.startsWith('Mail attachment')) {
    return 'message-validation';
  }
  if (message.startsWith('Unable to authenticate with Microsoft Graph')) {
    return 'authentication';
  }
  if (message.startsWith('Microsoft Graph email request failed')) {
    return 'network';
  }
  if (message.startsWith('Microsoft Graph rejected the email request')) {
    return 'graph-rejection';
  }
  return 'unknown';
}

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

try {
  await mailer.send({
    from: 'notifications@example.com',
    to: 'customer@example.com',
    subject: 'Classified send',
    text: 'Failures are logged with the stage that produced them.',
  });
} catch (error) {
  const stage = classifyFailure(error);
  console.error(`[${stage}] ${error instanceof Error ? error.message : String(error)}`);
}
```

### Strategy 2: Inspect the Graph request without network or credentials

When you suspect the *mapping* is wrong (body preference, recipient order, attachment shape), capture the exact JSON the provider would send. Override `acquireAccessToken()` with a fake token and stub `globalThis.fetch`. No credentials, no network.

1. Subclass `AzureMailProvider` and override the protected `acquireAccessToken()`.
2. Replace `globalThis.fetch` with a capturing stub that returns `202`.
3. Send and print the captured body.
4. Restore the original `fetch` in a `finally` block.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

class OfflineAzureMailProvider extends AzureMailProvider {
  protected override async acquireAccessToken(): Promise<string> {
    return 'offline-debug-token';
  }
}

const captured: Array<{ url: string; body: string }> = [];
const realFetch: typeof fetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  captured.push({
    url: input instanceof Request ? input.url : input.toString(),
    body: typeof init?.body === 'string' ? init.body : '',
  });
  return new Response(null, { status: 202 });
};

try {
  const provider = new OfflineAzureMailProvider({
    tenantId: 'contoso.onmicrosoft.com',
    clientId: '11111111-1111-4111-8111-111111111111',
    clientSecret: 'offline-debug-secret',
    senderMailbox: 'notifications@example.com',
  });

  await provider.send({
    from: 'Notifications <notifications@example.com>',
    to: ['alice@example.com', 'bob@example.com'],
    cc: 'manager@example.com',
    subject: 'Offline inspection',
    text: 'Text version.',
    html: '<p>HTML version.</p>',
    attachments: [{ filename: 'report.txt', content: Buffer.from('report'), contentType: 'text/plain' }],
  });

  const parsed: unknown = JSON.parse(captured[0].body);
  console.log(captured[0].url);
  console.log(JSON.stringify(parsed, null, 2));
} finally {
  globalThis.fetch = realFetch;
}
```

The output confirms exactly what Microsoft Graph would receive — useful for verifying that HTML won over text, that `saveToSentItems` is correct, and that attachments are shaped as `#microsoft.graph.fileAttachment`.

### Strategy 3: Surface detailed MSAL diagnostics

`acquireAccessToken()` intentionally discards MSAL details. To see them, build the confidential client yourself with the same values and let the real error through. This is the fastest way to resolve `Unable to authenticate with Microsoft Graph.`

1. Write a small script that constructs `ConfidentialClientApplication` directly.
2. Run it and read the `errorCode` (AADSTS) and `correlationId`.
3. Map the code: `AADSTS7000215` invalid secret, `AADSTS7000222` expired secret, `AADSTS700016` app not found in the directory. An AADSTS code means the request reached Entra, so network and DNS are fine.

```typescript
import { ConfidentialClientApplication } from '@azure/msal-node';

function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const details: string[] = [error.message];
  if ('errorCode' in error && typeof error.errorCode === 'string') {
    details.push(`code=${error.errorCode}`);
  }
  if ('correlationId' in error && typeof error.correlationId === 'string') {
    details.push(`correlationId=${error.correlationId}`);
  }
  return details.join(' ');
}

const client = new ConfidentialClientApplication({
  auth: {
    clientId: process.env.AZURE_CLIENT_ID!,
    clientSecret: process.env.AZURE_CLIENT_SECRET!,
    authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID!}`,
  },
});

try {
  const result = await client.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  });
  console.log(result?.accessToken ? 'Token acquired — authentication configuration is correct.' : 'No token returned.');
} catch (error) {
  console.error(`MSAL failure: ${describeError(error)}`);
}
```

### Strategy 4: Capture the exact URL and status of live Graph traffic

When Graph rejects requests (especially 404s caused by a padded or mistyped `senderMailbox`), it helps to see the exact URL the provider called. Wrap `globalThis.fetch` and log only metadata — never the request body, which contains message content.

1. Wrap `globalThis.fetch` **before** the first send (the plugin constructs the provider at startup, so wrap before traffic starts).
2. Log method, URL, status, and `Retry-After` for `graph.microsoft.com` calls only.
3. Restore the original `fetch` when finished.

```typescript
const realFetch: typeof fetch = globalThis.fetch;

const loggingFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  const response = await realFetch(input, init);

  if (url.startsWith('https://graph.microsoft.com/')) {
    const retryAfter = response.headers.get('Retry-After');
    console.log(
      `${init?.method ?? 'GET'} ${url} → ${response.status}${retryAfter ? ` (Retry-After: ${retryAfter})` : ''}`
    );
  }

  return response;
};

globalThis.fetch = loggingFetch;

// Run your sends here, then restore:
// globalThis.fetch = realFetch;
console.log(`Tracing active: ${globalThis.fetch === loggingFetch}`);
```

### Strategy 5: Verify Entra and Exchange prerequisites

Most "it authenticates but will not send" problems are authorization, not configuration. Walk the checklist in order:

1. `clientId` is the **Application (client) ID**; `tenantId` is the directory ID or verified domain for the same app registration.
2. The client secret is the secret **Value** (not the ID) and has not expired — check **Certificates & secrets** for the expiry date.
3. Microsoft Graph → **API permissions** → **Application permissions** includes `Mail.Send`, and **Grant admin consent** shows *Granted* for the tenant.
4. Exchange Online Application RBAC scopes `Application Mail.Send` to the mailbox (apply the PowerShell from the HTTP 403 fix above). Allow up to ~1 hour for replication.
5. The mailbox exists, is licensed (or is a shared mailbox), and its primary SMTP address equals `senderMailbox` exactly.
6. Network egress allows `login.microsoftonline.com` and `graph.microsoft.com`.
7. The runtime is Node.js >= 22.

Then verify end-to-end with a two-step script:

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const senderMailbox = process.env.MAIL_SENDER ?? 'notifications@example.com';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox,
});

const authenticated = await mailer.health();
console.log(`Step 1 — token acquisition: ${authenticated ? 'OK' : 'FAILED'}`);

if (!authenticated) {
  process.exitCode = 1;
} else {
  try {
    const result = await mailer.send({
      from: senderMailbox,
      to: process.env.MAIL_SMOKE_TEST_RECIPIENT ?? senderMailbox,
      subject: 'Mailer verification',
      text: 'End-to-end verification message.',
    });
    console.log(`Step 2 — Graph submission: OK (${result.accepted.join(', ')})`);
  } catch (error) {
    console.error(
      `Step 2 — Graph submission: FAILED (${error instanceof Error ? error.message : String(error)})`
    );
    process.exitCode = 1;
  }
}
```

A failure at Step 1 is authentication; a failure at Step 2 with HTTP 403 is authorization (RBAC/consent); a 404 is the mailbox value itself.

### Strategy 6: Reproduce failures under Vitest with mocked boundaries

The package's own tests replace only the two external boundaries — `@azure/msal-node` and `fetch` — and exercise the real provider. Use the same pattern to reproduce a reported failure deterministically instead of sending live mail.

1. Mock `@azure/msal-node` with `vi.hoisted` + `vi.mock`.
2. Stub `fetch` with `vi.stubGlobal`.
3. Drive the real provider and assert on the captured request body.

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const msal = vi.hoisted(() => ({
  acquireTokenByClientCredential: vi.fn(),
}));

vi.mock('@azure/msal-node', () => ({
  ConfidentialClientApplication: class {
    acquireTokenByClientCredential = msal.acquireTokenByClientCredential;
  },
}));

import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  msal.acquireTokenByClientCredential.mockReset();
  msal.acquireTokenByClientCredential.mockResolvedValue({ accessToken: 'test-token' });

  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
});

describe('mail diagnostics', () => {
  it('exposes the request the provider would send', async () => {
    const provider = new AzureMailProvider({
      clientId: '11111111-1111-4111-8111-111111111111',
      clientSecret: 'test-secret',
      tenantId: 'contoso.onmicrosoft.com',
      senderMailbox: 'notifications@example.com',
    });

    await provider.send({
      from: 'notifications@example.com',
      to: 'customer@example.com',
      subject: 'Diagnostic',
      text: 'Hello',
    });

    const body = fetchMock.mock.calls[0][1]?.body;
    if (typeof body !== 'string') {
      throw new Error('Expected a JSON request body.');
    }
    const parsed: unknown = JSON.parse(body);
    console.log(JSON.stringify(parsed, null, 2));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

### Strategy 7: Trace deliveries in Exchange Online

For anything after a successful `send()` — silent non-delivery, partial delivery — the answer is never in this package's return value. Trace it in Microsoft 365:

1. Exchange admin center → **Mail flow** → **Message trace**.
2. Filter by sender = `senderMailbox` over the last 1–24 hours.
3. Open the message: check the status (**Delivered**, **Pending**, **Failed**, **Quarantined**) and the event list.
4. If **Failed**, open the details; the NDR reason identifies recipient problems, transport rules, or policy blocks.
5. For authentication questions, check Entra → **Monitoring** → **Sign-in logs** → **Service principal sign-ins** (filter by the app's client ID) and correlate with the `correlationId` from **Strategy 3**.

---

## Known Pitfalls

These are the subtle behaviors that are easy to miss when reading only the happy-path documentation.

| # | Pitfall | Symptom | Mitigation |
| --- | --- | --- | --- |
| 1 | `health()` proves authentication, not authorization — and can be satisfied from MSAL's cache without a network round trip | `health()` returns `true`, but `send()` fails with HTTP 403 | Treat `health()` as a token check only; prove mailbox access with a smoke send (Strategy 5) |
| 2 | HTTP 202 is acceptance for asynchronous processing, not delivery | `send()` resolves, no email arrives | Confirm delivery with an Exchange message trace, not the result object |
| 3 | A timed-out request may still be delivered | `Microsoft Graph email request failed.` followed by a duplicate email after a naive retry | Check the message trace before re-sending; the backoff helper shown earlier deliberately does not retry network failures |
| 4 | HTML silently wins when both bodies are supplied | Recipients never see the `text` version | Supply only the body you want delivered, or accept that HTML takes precedence |
| 5 | `cc: []`, `bcc: []`, or `to: []` throw instead of being ignored | `Mail message cc must contain at least one recipient.` | Pass `undefined` for empty lists |
| 6 | Configuration values are validated trimmed but stored verbatim | From-mismatch error or HTTP 404 despite the "same" mailbox | Pass clean values; `.trim()` environment-sourced mailbox and secret strings |
| 7 | Attachment `contentType` must be a bare `type/subtype` | `Mail attachment contentType is invalid.` for `text/plain; charset=utf-8` | Strip parameters before sending |
| 8 | The 3 MiB limit counts decoded bytes across **all** attachments — and base64 inflates the wire payload by ~33% | Limit error on a message you thought was under 3 MB | Pre-check with `MAX_DIRECT_ATTACHMENT_BYTES` and the totals helper shown above |
| 9 | String attachment content must be canonical base64 | `Mail attachment string content must be valid base64.` for base64url or wrapped base64 | Pass a `Buffer` or `bytes.toString('base64')` |
| 10 | Validation errors never echo the offending value | With an array of recipients you do not know which one failed | Bisect or validate addresses in your own code before calling `send()` |
| 11 | All errors are deliberately opaque — no Graph body, no MSAL code, no correlation ID | Diagnosing by error message alone is a dead end | Use the direct MSAL probe (Strategy 3), Entra sign-in logs, and message traces |
| 12 | `Retry-After` is surfaced only when numeric | An HTTP-date `Retry-After` is silently ignored on 429 | Fall back to your own backoff delay when the error message has no "Retry after" text |
| 13 | `from` must equal `senderMailbox` exactly (case-insensitive) | Aliases, plus-addresses, and Send-As addresses fail locally | Send from the configured mailbox; present a display name instead |
| 14 | `tenantId: 'common'` / `'organizations'` are rejected | Tenant validation error on a multi-tenant style value | Use the concrete tenant ID or verified domain |
| 15 | Each provider instance owns its own MSAL token cache; rotating a secret does not invalidate cached tokens | Sends keep working after rotation, then fail abruptly later; a bad new secret may go unnoticed | Register one provider (the plugin singleton) so the cache is shared; after rotation, restart and verify with `health()` |
| 16 | `saveToSentItems` defaults to `true` | Automated mail accumulates in the sender mailbox's Sent Items | Set `saveToSentItems: false` to reduce noise (no effect on delivery) |
| 17 | `shutdown()` is a no-op | Nothing is cancelled or flushed on shutdown | Rely on the 30-second request timeout to bound in-flight requests |
| 18 | Tabs and newlines are rejected everywhere they can appear in headers or names | Subjects, filenames, or display names fail with generic messages | Normalize generated strings to single-line, control-character-free values |
| 19 | Display names are limited to 128 characters and cannot contain `<`, `>`, or `"` — and the check applies to recipients too, despite the "sender" wording | `Mail message contains an invalid sender display name.` on a `to` field | Keep display names simple |

A few of these deserve more than a single line:

### `health()` is not an authorization check

`health()` returns `true` whenever MSAL can produce an access token — that proves the app credentials are valid, nothing more. `Mail.Send` consent and Exchange Online Application RBAC are only exercised when a message is actually submitted, so a misconfigured mailbox shows up as HTTP 403 on the first real send:

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const authenticated = await mailer.health();
console.log(`Token acquisition: ${authenticated ? 'OK' : 'FAILED'}`);

try {
  const result = await mailer.send({
    from: 'notifications@example.com',
    to: 'internal-smoke-test@example.com',
    subject: 'Mailbox authorization probe',
    text: 'A 403 here means Mail.Send consent or Exchange Online Application RBAC is missing.',
  });
  console.log(`Mailbox submission: OK (${result.accepted.join(', ')})`);
} catch (error) {
  console.error(
    `Mailbox submission: FAILED — ${error instanceof Error ? error.message : String(error)}`
  );
}
```

### Whitespace in `senderMailbox` passes validation but breaks later

The email grammar is checked against a **trimmed** copy of `senderMailbox`, but the frozen configuration stores the original string, which is then used verbatim in the Graph URL (`/users/{value}/sendMail`) and in the `from` comparison. The observable results are either `Mail message from address must match the configured senderMailbox.` or a Graph 404:

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const mailer = new AzureMailProvider({
  tenantId: requireEnv('AZURE_TENANT_ID'),
  clientId: requireEnv('AZURE_CLIENT_ID'),
  clientSecret: requireEnv('AZURE_CLIENT_SECRET'),
  // Never pad this value: it is validated trimmed but used verbatim.
  senderMailbox: requireEnv('AZURE_SENDER_MAILBOX').trim(),
});

const result = await mailer.send({
  from: `Notifications <${requireEnv('AZURE_SENDER_MAILBOX').trim()}>`,
  to: 'customer@example.com',
  subject: 'Clean mailbox value',
  text: 'The configured mailbox is trimmed, so both the URL and the from match succeed.',
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

### Empty recipient arrays are not "no recipients"

`cc: []` is not treated as "no CC"; it is parsed as a provided list and fails the non-empty requirement. Build the message with conditional spreads for optional lists:

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const ccList: string[] = [];
const bccList: string[] = ['archive@example.com'];

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const result = await mailer.send({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'Conditional recipients',
  text: 'Empty lists are omitted; populated lists are included.',
  cc: ccList.length > 0 ? ccList : undefined,
  bcc: bccList.length > 0 ? bccList : undefined,
});

console.log(`Accepted in To/CC/BCC order: ${result.accepted.join(', ')}`);
```

### A timeout may be a delivery, not a failure

If the 30-second `AbortSignal.timeout` fires, `fetch` rejects and the provider throws `Microsoft Graph email request failed.` — but Graph may have already received and queued the message. Blindly retrying can send duplicates, and there is no message identifier or idempotency key to deduplicate with. The rule is simple: after a network-level failure, check the Exchange message trace for the sender mailbox first; re-send only if the trace shows nothing.

---

## See Also

- Overview — what the package is, its architecture, and when to use it
- Core Concepts — provider, configuration, authentication, mapping, attachments, validation, plugin, and delivery semantics in depth

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
