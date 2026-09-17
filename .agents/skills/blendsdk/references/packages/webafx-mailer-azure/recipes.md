> **Package**: `blendsdk/webafx-mailer-azure`

# webafx-mailer-azure Advanced Patterns

This document builds on the Overview, Core Concepts, and Basic Usage. Each pattern below combines several features of `blendsdk/webafx-mailer-azure` — and, where relevant, `blendsdk/webafx-mailer` — into a complete, production-shaped solution.

All patterns assume the package prerequisites: an Entra application registration with the Microsoft Graph `Mail.Send` **application** permission, admin consent, and (recommended) Exchange Online Application RBAC scoping that permission to the configured `senderMailbox`.

| # | Pattern | Problem it solves | Features combined |
| --- | --- | --- | --- |
| 1 | Multi-Mailbox Routing with Named Plugin Registrations | One application must send from several Exchange Online mailboxes | `serviceName`, `azureMailPlugin`, `AzureMailProvider`, eager config validation |
| 2 | Throttle-Aware Retry with Backoff and Jitter | Transient Graph throttling must not drop notifications | Bounded error messages, `Retry-After` detail, 30-second request timeout |
| 3 | Health-Gated Readiness and Graceful Shutdown | Traffic is served before Graph authentication works | `health()`, constructor validation, `shutdown()` |
| 4 | Observability Through Subclassed Providers | Token and send behavior is invisible to monitoring | `protected acquireAccessToken()`, `protected config`, `createMailPlugin` |
| 5 | Attachment Budgeting and Multi-Part Delivery | Large report attachments fail late with an aggregate error | `MAX_DIRECT_ATTACHMENT_BYTES`, base64 rules, attachment mapping |
| 6 | Personalized Batch Fan-Out with Bounded Concurrency | Bulk mail must not leak recipients or exhaust throttling budget | `send()` semantics, `MailResult`, `health()`, `saveToSentItems` |
| 7 | Failure-Isolated Notifications with Typed Outcomes | Email problems must not fail business transactions | Bounded error taxonomy, `MailProvider` contract, `MailResult` |

---

## 1. Multi-Mailbox Routing with Named Plugin Registrations

**Use it when** one application must send different categories of email (notifications, billing, support) from dedicated Exchange Online mailboxes, and you want the routing rules enforced in a single place instead of scattering `senderMailbox` strings across the codebase.

### Implementation

```typescript
import { AzureMailProvider, azureMailPlugin } from 'blendsdk/webafx-mailer-azure';
import type { AzureMailConfig } from 'blendsdk/webafx-mailer-azure';
import type { MailMessage, MailProvider, MailResult } from 'blendsdk/webafx-mailer';

/** Reads a required environment variable or fails fast with a clear message. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** The minimal structural shape of the WebAFX application object. */
interface PluginHost {
  use(plugin: ReturnType<typeof azureMailPlugin>): unknown;
}

/** Every outbound mail category routes through a dedicated Exchange Online mailbox. */
type MailRoute = 'notifications' | 'billing' | 'support';

const routeConfigs: Readonly<Record<MailRoute, AzureMailConfig>> = Object.freeze({
  notifications: {
    tenantId: requireEnv('AZURE_TENANT_ID'),
    clientId: requireEnv('AZURE_CLIENT_ID'),
    clientSecret: requireEnv('AZURE_CLIENT_SECRET'),
    senderMailbox: 'notifications@example.com',
    serviceName: 'mailer-notifications',
  },
  billing: {
    tenantId: requireEnv('AZURE_TENANT_ID'),
    clientId: requireEnv('AZURE_CLIENT_ID'),
    clientSecret: requireEnv('AZURE_CLIENT_SECRET'),
    senderMailbox: 'billing@example.com',
    serviceName: 'mailer-billing',
  },
  support: {
    tenantId: requireEnv('AZURE_TENANT_ID'),
    clientId: requireEnv('AZURE_CLIENT_ID'),
    clientSecret: requireEnv('AZURE_CLIENT_SECRET'),
    senderMailbox: 'support@example.com',
    serviceName: 'mailer-support',
  },
});

/**
 * WebAFX path: registers one named singleton per route. Each provider is
 * constructed (and therefore fully validated) eagerly, so a broken route
 * fails application startup instead of the first billing email.
 */
function registerMailRoutes(app: PluginHost): void {
  for (const config of Object.values(routeConfigs)) {
    app.use(azureMailPlugin(config));
  }
}

/**
 * Standalone path for workers and services outside the WebAFX container.
 * The from address always comes from the route table, so a caller can never
 * send billing mail from the support mailbox.
 */
class RoutedMailer {
  private readonly providers = new Map<MailRoute, MailProvider>();

  constructor(private readonly configs: Readonly<Record<MailRoute, AzureMailConfig>>) {
    for (const route of Object.keys(configs) as MailRoute[]) {
      this.providers.set(route, new AzureMailProvider(configs[route]));
    }
  }

  async send(route: MailRoute, message: Omit<MailMessage, 'from'>): Promise<MailResult> {
    const provider = this.providers.get(route);
    if (provider === undefined) {
      throw new Error(`No mail provider registered for route: ${route}`);
    }

    return provider.send({ ...message, from: this.configs[route].senderMailbox });
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.providers.values()].map(provider => provider.shutdown()));
  }
}

const registeredNames: string[] = [];
const host: PluginHost = {
  use(plugin): unknown {
    registeredNames.push(plugin.name);
    return undefined;
  },
};

registerMailRoutes(host);
console.log(`Registered mail plugins: ${registeredNames.join(', ')}`);
// Registered mail plugins: mailer-notifications, mailer-billing, mailer-support

const routedMailer = new RoutedMailer(routeConfigs);

const receipt = await routedMailer.send('billing', {
  to: 'customer@example.com',
  subject: 'Your invoice is ready',
  text: 'Your monthly invoice is available in the customer portal.',
});

console.log(`Billing mail accepted for: ${receipt.accepted.join(', ')}`);
await routedMailer.shutdown();
```

### Why this pattern helps

- **Routing as data** — one frozen table defines every mailbox, environment variable, and container name. Adding a route is a three-line change with compile-time checking, and every provider validates its configuration at startup rather than at first send.
- **The sender invariant is enforced by construction** — the provider rejects any message whose `from` does not match the configured `senderMailbox`. `RoutedMailer.send()` derives `from` from the route table, so callers physically cannot violate that rule (they never pass `from` at all).
- **Named singletons in WebAFX** — `serviceName` makes each route resolvable independently in the container while sharing one MSAL token cache per route. The same config objects work for both the plugin path and standalone providers.

> Pick **one** consumption style per application: WebAFX apps register the route table via `registerMailRoutes()` and resolve the named singletons; workers and CLI jobs outside the container build a `RoutedMailer`. Constructing both would duplicate MSAL clients and token caches.

### Caveats and performance considerations

- Each `AzureMailProvider` owns one `ConfidentialClientApplication` with its own in-memory token cache. Three routes mean up to three tokens refreshed roughly hourly — negligible, but keep the route count to real mailboxes.
- Route isolation is only as strong as your Entra configuration. Grant tenant-wide `Mail.Send` and any route can send from any mailbox. Use Exchange Online Application RBAC to scope the application to each mailbox (or separate app registrations when you need hard isolation).
- Plugin names must be unique: the default is `mailer`, so every route beyond the first needs an explicit `serviceName`.
- `serviceName` only affects plugin registration; it has no effect on standalone `AzureMailProvider` instances, where it is simply carried inside the frozen configuration.

---

## 2. Throttle-Aware Retry with Backoff and Jitter

**Use it when** notification-class email must survive Microsoft Graph throttling (HTTP 429) and short-lived network or server failures. The provider deliberately does not retry, but it surfaces exactly what you need to do so correctly: a stable error message, the HTTP status, and the validated `Retry-After` delay.

### Implementation

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';
import type { MailMessage, MailResult } from 'blendsdk/webafx-mailer';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

/** How the retry loop treats a failed send. */
type FailureKind = 'throttled' | 'retryable' | 'permanent';

interface SendFailure {
  readonly kind: FailureKind;
  /** Server-requested delay for throttling, in milliseconds (from Retry-After). */
  readonly retryAfterMs?: number;
}

/**
 * Classifies the provider's bounded error messages. Validation failures and
 * other input problems are permanent; transport and authentication problems
 * are retryable; HTTP 429 is throttling with an optional server delay.
 */
function classifySendError(error: unknown): SendFailure {
  if (!(error instanceof Error)) {
    return { kind: 'permanent' };
  }

  if (error.message.includes('HTTP 429')) {
    const seconds = /Retry after (\d+) seconds\./.exec(error.message);
    return {
      kind: 'throttled',
      retryAfterMs: seconds ? Number(seconds[1]) * 1000 : undefined,
    };
  }

  if (/HTTP 5\d\d/.test(error.message)) {
    return { kind: 'retryable' };
  }

  if (
    error.message === 'Microsoft Graph email request failed.' ||
    error.message === 'Unable to authenticate with Microsoft Graph.'
  ) {
    return { kind: 'retryable' };
  }

  return { kind: 'permanent' };
}

/** Exponential backoff with jitter, capped at 10 seconds. */
function backoffMs(attempt: number): number {
  const base = Math.min(2 ** (attempt - 1) * 250, 10_000);
  return base + Math.floor(Math.random() * 250);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sends a message with throttle-aware retries.
 *
 * Throttled requests honor Graph's Retry-After header; other retryable
 * failures use capped exponential backoff with jitter. Classification relies
 * on the provider's documented, stable error text; every failure still
 * throws the original bounded error after the final attempt.
 */
async function sendWithRetry(message: MailMessage, maxAttempts = 4): Promise<MailResult> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await mailer.send(message);
    } catch (error) {
      const failure = classifySendError(error);
      if (failure.kind === 'permanent' || attempt >= maxAttempts) {
        throw error;
      }

      const waitMs =
        failure.kind === 'throttled' ? (failure.retryAfterMs ?? 5_000) : backoffMs(attempt);
      console.warn(`Mail attempt ${attempt} failed (${failure.kind}); retrying in ${waitMs} ms.`);
      await delay(waitMs);
    }
  }
}

const result = await sendWithRetry({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'Retry-aware delivery',
  text: 'This message survives transient throttling.',
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
await mailer.shutdown();
```

### Why this pattern helps

- The provider's error design — status code plus a validated `Retry-After` value — exists precisely so callers can implement correct backoff without parsing Graph response bodies (which are deliberately never exposed). This pattern is the intended consumer of that design.
- Classification separates conditions that retrying can fix (throttling, transient network/5xx, token blips) from conditions retrying cannot fix (sender mismatch, header injection, oversized attachments), so a programming error never turns into four wasted network round trips.
- Jitter on the exponential backoff prevents synchronized retries when several workers are throttled at the same moment.

### Caveats and performance considerations

- **Duplicate-delivery risk.** HTTP 429 means Graph definitively rejected the request, so retrying it is safe. But `Microsoft Graph email request failed.` also covers timeouts where the request may already have been accepted and the response was lost — retrying that class can deliver twice. This pattern accepts that trade-off for notification-class mail; for financial or legal mail, retry only `throttled` and route ambiguous failures to manual review.
- Worst-case latency is `maxAttempts × (30 s timeout + backoff)` — up to roughly two minutes. Never run this on a user-facing request path; run it in workers or background jobs.
- Repeated `Unable to authenticate with Microsoft Graph.` failures indicate a configuration or consent problem — alert on them instead of relying on retries.
- If you observe token clock-skew issues, classify `HTTP 401` as retryable; keep `HTTP 403` permanent, because authorization fixes are operational, not automatic.
- At scale, wrap this loop in a circuit breaker so a sustained Graph outage does not multiply traffic across every worker.

---

## 3. Health-Gated Readiness and Graceful Shutdown

**Use it when** mail delivery is part of your service's critical path, so the process should not accept traffic until Microsoft Graph authentication is known to work — and your orchestrator (Kubernetes, ECS, systemd) should be able to probe that state.

### Implementation

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Boot gate: waits until an access token can be acquired before the process
 * starts serving traffic. Returns false when authentication never becomes
 * ready, so the orchestrator can restart the process with a fresh state.
 */
async function waitForGraphReadiness(maxAttempts = 5, intervalMs = 2_000): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (await mailer.health()) {
      return true;
    }
    console.warn(`Mail backend not ready (attempt ${attempt}/${maxAttempts}).`);
    await delay(intervalMs);
  }
  return false;
}

async function respondWithReadiness(response: ServerResponse): Promise<void> {
  const ready = await mailer.health();
  response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ mailer: ready ? 'ready' : 'unavailable' }));
}

const server = createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/health/ready') {
    response.writeHead(404);
    response.end();
    return;
  }

  void respondWithReadiness(response).catch((error: unknown) => {
    console.error('Readiness probe failed.', error);
  });
});

const ready = await waitForGraphReadiness();

if (!ready) {
  console.error('Microsoft Graph authentication is not ready; refusing to start.');
  process.exitCode = 1;
} else {
  server.listen(8080, () => {
    console.log('Mail-ready service listening on port 8080.');
  });

  process.once('SIGTERM', () => {
    void (async () => {
      // shutdown() is intentionally a no-op for this provider, but calling it
      // keeps lifecycle code uniform if the transport is swapped later.
      await mailer.shutdown();
      server.close();
    })();
  });
}
```

### Why this pattern helps

- **Fail before customers do.** Without a boot gate, the first transactional email after a deploy is the health check — and a misconfigured secret or revoked consent surfaces as a lost notification. The gate converts that into a refused startup the orchestrator can act on.
- `health()` is non-throwing by design: it resolves `false` instead of leaking MSAL diagnostics, which makes it safe to call from probe endpoints and boot loops alike.
- The readiness endpoint gives orchestrators a continuous signal, and wiring `shutdown()` into `SIGTERM` keeps the lifecycle uniform across all `blendsdk/webafx-mailer-*` providers.

### Caveats and performance considerations

- **`health()` proves token acquisition only.** It does not verify mailbox authorization: a process can report healthy and still receive `HTTP 403` on send if Exchange Online Application RBAC or `Mail.Send` consent is misconfigured. Treat a healthy probe as "authentication ready", not "delivery proven".
- MSAL caches tokens internally, so probes are usually cache hits; an expired cache plus a Microsoft Entra outage can make `health()` return `false` even while a previously issued token would still have allowed sends. Keep the strict gate at boot and consider a more tolerant, warn-level policy for periodic probes.
- Each cache miss inside `health()` is a network call to `login.microsoftonline.com` — probe at infrastructure cadence (30–60 seconds), never per request.
- Do not gate individual `send()` calls on `health()`; the send path already handles authentication and returns bounded errors.
- `process.exitCode = 1` (rather than `process.exit()`) lets pending log writes flush; the process ends because no server and no signal handler were registered.

---

## 4. Observability Through Subclassed Providers

**Use it when** you need per-token and per-send telemetry (durations, outcomes, throttling rate) without changing the transport, and you want that instrumentation to apply to the WebAFX-registered singleton as well.

### Implementation

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';
import type { AzureMailConfig } from 'blendsdk/webafx-mailer-azure';
import { createMailPlugin } from 'blendsdk/webafx-mailer';
import type { MailMessage, MailResult } from 'blendsdk/webafx-mailer';

/** Minimal metrics port; substitute your monitoring stack's client. */
interface MailMetrics {
  count(name: string, tags?: Readonly<Record<string, string>>): void;
  timing(name: string, milliseconds: number, tags?: Readonly<Record<string, string>>): void;
}

/** Console metrics implementation, so the example stays runnable. */
const metrics: MailMetrics = {
  count: (name, tags) => console.log(`metric ${name}`, tags ?? {}),
  timing: (name, milliseconds, tags) =>
    console.log(`timing ${name}=${milliseconds.toFixed(1)}ms`, tags ?? {}),
};

/**
 * Extends the provider through its protected extension points:
 * - acquireAccessToken() captures token-cache misses and authentication failures.
 * - send() captures outcome and duration for every Graph submission.
 *
 * Both overrides rethrow the original bounded error unchanged, so callers
 * never see different messages than a plain AzureMailProvider would produce.
 */
class InstrumentedAzureMailProvider extends AzureMailProvider {
  constructor(config: AzureMailConfig, private readonly telemetry: MailMetrics) {
    super(config);
  }

  override async send(message: MailMessage): Promise<MailResult> {
    const startedAt = performance.now();
    try {
      const result = await super.send(message);
      this.telemetry.count('mail.send.accepted', { mailbox: this.config.senderMailbox });
      this.telemetry.timing('mail.send.duration', performance.now() - startedAt, {
        mailbox: this.config.senderMailbox,
        outcome: 'accepted',
      });
      return result;
    } catch (error) {
      const reason =
        error instanceof Error && error.message.includes('HTTP 429') ? 'throttled' : 'failed';
      this.telemetry.count('mail.send.failed', {
        mailbox: this.config.senderMailbox,
        reason,
      });
      this.telemetry.timing('mail.send.duration', performance.now() - startedAt, {
        mailbox: this.config.senderMailbox,
        outcome: reason,
      });
      throw error;
    }
  }

  protected override async acquireAccessToken(): Promise<string> {
    const startedAt = performance.now();
    try {
      const token = await super.acquireAccessToken();
      this.telemetry.count('mail.token.acquired');
      return token;
    } catch (error) {
      this.telemetry.count('mail.token.failed');
      throw error;
    } finally {
      this.telemetry.timing('mail.token.duration', performance.now() - startedAt);
    }
  }
}

const mailer = new InstrumentedAzureMailProvider(
  {
    tenantId: process.env.AZURE_TENANT_ID!,
    clientId: process.env.AZURE_CLIENT_ID!,
    clientSecret: process.env.AZURE_CLIENT_SECRET!,
    senderMailbox: 'notifications@example.com',
  },
  metrics
);

// azureMailPlugin() always constructs a plain AzureMailProvider, so subclasses
// are registered through createMailPlugin() from the core package instead.
const plugin = createMailPlugin(mailer);
console.log(`Registered plugin: ${plugin.name} (priority ${plugin.priority})`);
// Registered plugin: mailer (priority 30)

try {
  const result = await mailer.send({
    from: 'notifications@example.com',
    to: 'customer@example.com',
    subject: 'Instrumented send',
    text: 'Metrics are recorded around the Graph transport.',
  });
  console.log(`Accepted: ${result.accepted.join(', ')}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}

await mailer.shutdown();
```

### Why this pattern helps

- **The package exposes extension points exactly where telemetry belongs.** `acquireAccessToken()` is `protected` so token behavior can be observed without touching the Graph transport; `send()` is an ordinary overridable contract method. A plain `AzureMailProvider` needs no changes to gain full observability.
- `createMailPlugin()` accepts a provider **instance**, so instrumented subclasses still register as container singletons — `azureMailPlugin()` only ever constructs the base class, and knowing this distinction is the key to using subclasses in WebAFX.
- The `config` property is `protected readonly`, so subclasses can tag metrics with the mailbox without reaching back into environment variables, and the provider's frozen configuration cannot be corrupted by subclass code.

### Caveats and performance considerations

- **Token metrics are not per-email metrics.** `mail.token.acquired` fires on MSAL cache misses (roughly hourly) and also every time a readiness probe triggers acquisition — never treat it as a send counter.
- Never log message bodies or tokens: the provider deliberately keeps them out of errors, and instrumentation must not defeat that. Limit tags to the mailbox and the outcome.
- Always rethrow the original error object; wrapping it would change the bounded message other layers (like the retry classifier in Pattern 2) depend on.
- Keep overrides thin and synchronous-safe: an exception thrown by your metrics client inside `send()`'s catch path could mask the original mail failure, so use a metrics client that never throws.
- The overhead of two `performance.now()` calls per send is negligible; the cost that matters is cardinality — one tag value per mailbox is low, one per message is not.

---

## 5. Attachment Budgeting and Multi-Part Delivery

**Use it when** your application attaches generated reports, exports, or documents that may approach the 3 MiB direct-send limit, and an aggregate failure from `send()` is too late and too vague to act on. This pattern pre-checks the budget and splits oversized payloads into numbered parts.

### Implementation

```typescript
import { AzureMailProvider, MAX_DIRECT_ATTACHMENT_BYTES } from 'blendsdk/webafx-mailer-azure';
import type { MailAttachment, MailMessage, MailResult } from 'blendsdk/webafx-mailer';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

/** Decoded byte size, measured exactly the way the provider measures it. */
function decodedByteLength(attachment: MailAttachment): number {
  return Buffer.isBuffer(attachment.content)
    ? attachment.content.byteLength
    : Buffer.from(attachment.content, 'base64').byteLength;
}

/**
 * Splits attachments into groups that each fit the direct-send budget while
 * preserving order. Throws a named, sized error for a single attachment that
 * can never fit, instead of leaving the recipient with a vague aggregate
 * failure at send time.
 */
function partitionAttachments(
  attachments: readonly MailAttachment[],
  limit = MAX_DIRECT_ATTACHMENT_BYTES
): MailAttachment[][] {
  const groups: MailAttachment[][] = [];
  let current: MailAttachment[] = [];
  let currentBytes = 0;

  for (const attachment of attachments) {
    const bytes = decodedByteLength(attachment);
    if (bytes > limit) {
      throw new Error(
        `Attachment "${attachment.filename}" is ${bytes} bytes and cannot be sent as a direct Graph attachment.`
      );
    }

    if (currentBytes + bytes > limit) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }

    current.push(attachment);
    currentBytes += bytes;
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

/**
 * Sends one message per attachment group and numbers the subject when the
 * payload had to be split ("(part 1 of 2)").
 */
async function sendWithinAttachmentBudget(
  message: Omit<MailMessage, 'attachments'>,
  attachments: readonly MailAttachment[]
): Promise<MailResult[]> {
  const groups = partitionAttachments(attachments);

  if (groups.length === 0) {
    return [await mailer.send({ ...message, attachments: [] })];
  }

  const results: MailResult[] = [];
  for (const [index, group] of groups.entries()) {
    const suffix = groups.length > 1 ? ` (part ${index + 1} of ${groups.length})` : '';
    results.push(
      await mailer.send({
        ...message,
        subject: `${message.subject}${suffix}`,
        attachments: [...group],
      })
    );
  }
  return results;
}

const results = await sendWithinAttachmentBudget(
  {
    from: 'notifications@example.com',
    to: 'customer@example.com',
    subject: 'Monthly report',
    text: 'The report is attached.',
  },
  [
    {
      filename: 'transactions.csv',
      content: Buffer.from('id,amount\n1,42\n', 'utf8'),
      contentType: 'text/csv',
    },
    {
      filename: 'chart.svg',
      content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" />').toString('base64'),
      contentType: 'image/svg+xml',
    },
  ]
);

for (const [index, result] of results.entries()) {
  console.log(`Part ${index + 1} accepted: ${result.accepted.join(', ')}`);
}

await mailer.shutdown();
```

### Why this pattern helps

- The provider rejects the whole message the moment the **combined** decoded size exceeds `MAX_DIRECT_ATTACHMENT_BYTES`, and its error intentionally names no files. Pre-flight budgeting turns a late, aggregate failure into an early, actionable one that names the offending file and its exact size.
- `MAX_DIRECT_ATTACHMENT_BYTES` is exported for precisely this purpose — pre-checking without importing internals — and the helper measures payloads identically to the provider (`Buffer.byteLength` for buffers, base64 round-trip decode for strings).
- Splitting keeps large reports deliverable inside the provider's supported workflow instead of silently truncating or attempting the Graph upload-session workflow, which is explicitly out of scope and requires broader mailbox permissions.

### Caveats and performance considerations

- Base64 encoding inflates the JSON payload by roughly 33 % on the wire: a decoded payload at the limit produces a Graph request body of about 4 MiB. Budget for the request size, not just the file size, when tuning proxy limits.
- Each part is a separate Graph request and a separate Sent Items copy if `saveToSentItems` is enabled (the default). For high-volume splitting, combine this pattern with Pattern 2 for throttling and consider `saveToSentItems: false`.
- A single attachment larger than the limit can never be sent by this provider; the helper's named error makes that obvious so you can switch to a storage link (for example a signed URL to object storage) instead of guessing.
- The pre-check duplicates validation the provider still performs; it is defense in depth, not a substitute. String content must be canonical base64, or `send()` will reject it regardless of the pre-check.
- Recipients receive multiple numbered emails, which most clients thread together; tell users in the message body when a report spans parts.

---

## 6. Personalized Batch Fan-Out with Bounded Concurrency

**Use it when** you send a personalized message to many recipients (weekly summaries, onboarding drips, per-customer alerts) — one message per person, so recipients never see each other's addresses — while respecting the mailbox's throttling budget and failing fast when authentication breaks mid-batch.

### Implementation

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const senderMailbox = 'notifications@example.com';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox,
  saveToSentItems: false,
});

interface Recipient {
  readonly email: string;
  readonly fullName: string;
}

interface BatchOutcome {
  readonly email: string;
  readonly status: 'accepted' | 'failed';
  readonly detail?: string;
}

/** Escapes user-controlled values before embedding them in the HTML body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sends one personalized message per recipient with bounded concurrency.
 * - Verifies authentication before spending any send attempts.
 * - Stops the batch when authentication becomes unavailable mid-run.
 * - Reports every recipient that was never attempted, because the provider's
 *   MailResult.rejected array is always empty and cannot express skips.
 */
async function sendPersonalizedBatch(
  recipients: readonly Recipient[],
  concurrency = 4
): Promise<BatchOutcome[]> {
  if (!(await mailer.health())) {
    throw new Error('Microsoft Graph authentication is not ready; batch aborted before sending.');
  }

  const queue = [...recipients];
  const outcomes: BatchOutcome[] = [];
  let abortReason: string | undefined;

  const runner = async (): Promise<void> => {
    for (;;) {
      if (abortReason !== undefined) {
        return;
      }

      const recipient = queue.shift();
      if (recipient === undefined) {
        return;
      }

      try {
        const result = await mailer.send({
          from: senderMailbox,
          to: recipient.email,
          subject: `Your weekly summary, ${recipient.fullName}`,
          html: `<p>Hello ${escapeHtml(recipient.fullName)}, here is your weekly summary.</p>`,
        });

        // Defensive: the contract promises a complete accepted list on HTTP 202.
        if (!result.accepted.includes(recipient.email)) {
          outcomes.push({
            email: recipient.email,
            status: 'failed',
            detail: 'Graph did not list the recipient as accepted.',
          });
          continue;
        }

        outcomes.push({ email: recipient.email, status: 'accepted' });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        outcomes.push({ email: recipient.email, status: 'failed', detail });

        if (detail === 'Unable to authenticate with Microsoft Graph.') {
          abortReason = detail;
          return;
        }
      }
    }
  };

  const workerCount = Math.max(1, Math.min(concurrency, queue.length));
  await Promise.all(Array.from({ length: workerCount }, () => runner()));

  if (abortReason !== undefined) {
    for (const skipped of queue) {
      outcomes.push({
        email: skipped.email,
        status: 'failed',
        detail: `not attempted: ${abortReason}`,
      });
    }
  }

  return outcomes.sort((left, right) => left.email.localeCompare(right.email));
}

const recipients: Recipient[] = [
  { email: 'alice@example.com', fullName: 'Alice' },
  { email: 'bob@example.com', fullName: 'Bob' },
  { email: 'carol@example.com', fullName: 'Carol' },
];

const outcomes = await sendPersonalizedBatch(recipients);

const accepted = outcomes.filter(outcome => outcome.status === 'accepted').length;
console.log(`Batch finished: ${accepted} accepted, ${outcomes.length - accepted} failed.`);

for (const outcome of outcomes) {
  if (outcome.status === 'failed') {
    console.error(`Failed: ${outcome.email} (${outcome.detail ?? 'unknown reason'})`);
  }
}

await mailer.shutdown();
```

### Why this pattern helps

- **Privacy by construction.** Each recipient receives a single-recipient message; there is no To/BCC list that could leak the audience. Personalization happens per message, with escaping applied before values enter HTML.
- **Bounded concurrency respects the per-mailbox throttling budget.** Graph throttles per mailbox, so an unbounded `Promise.all` over hundreds of recipients converts your batch into a 429 storm. A small worker pool keeps sustained pressure at a level the mailbox can absorb.
- **Honest bookkeeping.** Because `MailResult.rejected` is always empty (Graph `sendMail` returns no synchronous per-recipient outcomes), the only failure signal is a thrown error — so the batch records outcomes per message, verifies the `accepted` list defensively, aborts when authentication fails mid-run, and explicitly reports recipients that were never attempted.

### Caveats and performance considerations

- Start with concurrency 3–5 and watch your `HTTP 429` rate; raise it only with measurements. For sustained throttling, compose this pattern with the throttle-aware retry from Pattern 2 (as the worker function's inner call) rather than increasing retries ad hoc.
- Each message costs one HTTPS request (plus occasional token acquisition) with a 30-second timeout. Rough batch duration is `recipients / concurrency × per-message latency` — run batches in workers or scheduled jobs, never inline in a request handler.
- `saveToSentItems: false` avoids one Sent Items copy per recipient, but removes the mailbox audit trail. That is a compliance decision, not only a performance one.
- Nonexistent mailboxes are **not** visible here: Graph accepts the request asynchronously and the failure arrives later as an NDR. This provider never reports those, so monitor the sender mailbox if bounce visibility matters.
- Validate personalization data (names, IDs) before the batch: one malformed value fails only its own message (validation runs locally per send), which keeps the rest of the batch running — the outcome list tells you exactly which ones failed.

---

## 7. Failure-Isolated Notifications with Typed Outcomes

**Use it when** email is a side effect of a business transaction — welcome messages, receipts, status updates — and a Graph hiccup must never fail user registration or an order. The business layer depends only on the `MailProvider` contract from `blendsdk/webafx-mailer`, so the transport can be swapped without touching business code.

### Implementation

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';
import type { AzureMailConfig } from 'blendsdk/webafx-mailer-azure';
import type { MailMessage, MailProvider, MailResult } from 'blendsdk/webafx-mailer';

/** Discriminated outcome so callers never need try/catch for notifications. */
type NotificationOutcome =
  | { readonly delivered: true; readonly accepted: readonly string[] }
  | { readonly delivered: false; readonly reason: 'throttled' | 'transient' | 'permanent' };

type FailureReason = Extract<NotificationOutcome, { delivered: false }>['reason'];

/** Maps the provider's bounded error taxonomy to a retry policy hint. */
function classifyFailure(error: unknown): FailureReason {
  if (!(error instanceof Error)) {
    return 'permanent';
  }

  if (error.message.includes('HTTP 429')) {
    return 'throttled';
  }

  if (
    /HTTP 5\d\d/.test(error.message) ||
    error.message === 'Microsoft Graph email request failed.' ||
    error.message === 'Unable to authenticate with Microsoft Graph.'
  ) {
    return 'transient';
  }

  return 'permanent';
}

/**
 * Notifications must never break the calling business flow. Failures are
 * converted into typed outcomes so the caller can decide between retrying
 * through a durable queue and dropping with an alert.
 */
async function notify(provider: MailProvider, message: MailMessage): Promise<NotificationOutcome> {
  try {
    const result: MailResult = await provider.send(message);
    return { delivered: true, accepted: result.accepted };
  } catch (error) {
    return { delivered: false, reason: classifyFailure(error) };
  }
}

// --- Composition root: the only place that knows Microsoft Graph exists. ---

const config: AzureMailConfig = {
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
};

const mailProvider: MailProvider = new AzureMailProvider(config);

// --- Business flow: registration succeeds even if the welcome mail cannot. ---

interface RegisteredUser {
  readonly id: string;
  readonly email: string;
  readonly welcomeNotification: 'sent' | 'queued-for-retry' | 'not-sent';
}

async function registerUserAfterPersistence(user: {
  id: string;
  email: string;
}): Promise<RegisteredUser> {
  const outcome = await notify(mailProvider, {
    from: 'notifications@example.com',
    to: user.email,
    subject: 'Welcome aboard',
    text: 'Thanks for signing up. Your account is ready.',
  });

  if (outcome.delivered) {
    return { ...user, welcomeNotification: 'sent' };
  }

  if (outcome.reason === 'throttled' || outcome.reason === 'transient') {
    // Hand off to your durable retry queue; never block the registration
    // response on email delivery.
    return { ...user, welcomeNotification: 'queued-for-retry' };
  }

  return { ...user, welcomeNotification: 'not-sent' };
}

const registered = await registerUserAfterPersistence({
  id: 'user-1042',
  email: 'customer@example.com',
});

console.log(`User ${registered.id}: welcome notification ${registered.welcomeNotification}.`);

await mailProvider.shutdown();
```

### Why this pattern helps

- **Isolation of failure.** Without this pattern, a Graph 429 inside `registerUser()` becomes a failed registration; with it, the business transaction commits and the notification degrades gracefully. The `delivered` discriminant forces callers to handle both paths at compile time.
- **Policy from the error taxonomy.** `throttled` and `transient` feed a durable retry queue; `permanent` (validation, sender mismatch, malformed attachments) stops immediately because retrying cannot fix a programming error. This mirrors the provider's own philosophy: bounded, stable, classifiable failures.
- **Transport independence via the core package.** `notify()` accepts `MailProvider` from `blendsdk/webafx-mailer`, so the composition root is the single place that references `blendsdk/webafx-mailer-azure`. Switching to any other BlendSDK mail provider — or substituting an implementation of the same contract in tests — requires no changes to `notify()` or the business flow.

### Caveats and performance considerations

- **Ambiguous failures can duplicate on retry.** A `transient` outcome includes `Microsoft Graph email request failed.`, where the request may actually have been accepted. A durable retry queue is therefore at-least-once delivery: acceptable for notifications, not for invoices. Align this policy with Pattern 2.
- `queued-for-retry` assumes a real durable queue (database-backed outbox, broker). An in-memory array loses notifications on restart — do not substitute one silently.
- Never swallow silently: count `delivered: false` outcomes and alert on `permanent` reasons, or use Pattern 4 instrumentation. The provider emits no logs of its own, and the documented error messages are safe to log.
- Keep messages short-lived and PII-aware: log outcomes, never bodies. Bounded errors contain no message content by design.
- Send **after** persistence, as in the example, so a crash between database commit and mail send can be reconciled by the retry queue — never before the transaction is durable.

---

## Putting the Patterns Together

| If you need to… | Adopt pattern |
| --- | --- |
| Send from more than one mailbox | 1 — Multi-Mailbox Routing |
| Survive throttling and transient failures | 2 — Throttle-Aware Retry |
| Gate startup and probes on Graph authentication | 3 — Health-Gated Readiness |
| See token and send behavior in monitoring | 4 — Observability Subclass |
| Deliver payloads near the 3 MiB direct limit | 5 — Attachment Budgeting |
| Personalize at volume without leaking recipients | 6 — Batch Fan-Out |
| Keep email failures out of business transactions | 7 — Failure-Isolated Notifications |

A typical production composition chains them in this order: **3** gates boot until authentication is proven, **1** routes each email category through its own mailbox, **4** instruments the provider, **2** wraps the send path with throttle-aware retries, **6** drives high-volume personalization through that wrapper, **5** budgets attachments on any message carrying files, and **7** keeps notification failures from ever failing the business transaction that triggered them. Each pattern is independent — adopt the ones your deployment actually needs.

---

# webafx-mailer-azure Common Scenarios

This document answers the most common "How do I...?" questions for `blendsdk/webafx-mailer-azure`, progressing from the simplest send to configuration, WebAFX integration, and the edge cases developers hit in production. Every example is self-contained and assumes an Entra application with the Microsoft Graph `Mail.Send` application permission and access to the configured `senderMailbox`, as described in the Overview.

---

## How do I send a plain-text email?

Create an `AzureMailProvider` with your Entra credentials and sender mailbox, then call `send()` with a message that has a `text` body. The call resolves after Microsoft Graph returns HTTP 202, which means Graph accepted the message for asynchronous processing.

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

---

## How do I send an HTML email?

Supply an `html` body on the message. When both `html` and `text` are present, the HTML body is transmitted and the text version is not used; when `html` is absent or an empty string, the provider falls back to `text`, and a message with neither throws `Mail message must contain a non-empty text or html body.`

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
  html: '<p>Welcome to our <strong>service</strong>.</p>',
});

// The Graph payload contains the HTML body because it is preferred.
console.log(`Accepted: ${result.accepted.join(', ')}`);
```

---

## How do I send to multiple recipients, including CC and BCC?

The `to`, `cc`, and `bcc` fields each accept a single address string or an array of addresses. CC and BCC are omitted from the Graph payload entirely when you do not supply them, and the accepted addresses come back in To → CC → BCC order.

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
  subject: 'Monthly report',
  text: 'The monthly report has been generated.',
});

console.log(`Accepted in To/CC/BCC order: ${result.accepted.join(', ')}`);
```

---

## How do I use a friendly display name for the sender?

Put the display name on the message's `from` field using the `Name <address>` form; the address part must still match the configured `senderMailbox` (the comparison is case-insensitive and ignores the display name). Note the asymmetry: the `senderMailbox` configuration value itself must be a bare address — the constructor rejects `Notifications <notifications@example.com>` with `Azure mail senderMailbox must not contain a display name.`

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
  to: 'customer@example.com',
  subject: 'Welcome',
  text: 'Welcome to our service.',
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

---

## How do I attach files to a message?

Pass an `attachments` array where each entry has a `filename`, its `content`, and an optional `contentType`. `Buffer` content is base64-encoded for you, while string content must already be canonical base64 — produce it with `Buffer.from(...).toString('base64')` — otherwise the call fails with `Mail attachment string content must be valid base64.`

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
  subject: 'Report attached',
  text: 'Please find the report attached.',
  attachments: [
    {
      filename: 'report.txt',
      content: Buffer.from('report contents', 'utf8'),
      contentType: 'text/plain',
    },
    {
      filename: 'chart.svg',
      content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" />', 'utf8').toString('base64'),
      contentType: 'image/svg+xml',
    },
  ],
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

---

## How do I keep attachments within the Microsoft Graph direct-send limit?

The Graph `sendMail` action only accepts direct file attachments totaling at most `MAX_DIRECT_ATTACHMENT_BYTES` (3 MiB − 1 = 3,145,727 decoded bytes) per message. Sum the decoded size of your content and pre-check it against the exported constant; the provider enforces the same limit and rejects oversized messages locally with `Mail attachments exceed the Microsoft Graph direct-send size limit.` before any token or network activity.

```typescript
import { AzureMailProvider, MAX_DIRECT_ATTACHMENT_BYTES } from 'blendsdk/webafx-mailer-azure';
import type { MailAttachment } from 'blendsdk/webafx-mailer';

/** Decoded byte length of either supported attachment content form. */
function decodedByteLength(content: Buffer | string): number {
  return Buffer.isBuffer(content) ? content.byteLength : Buffer.from(content, 'base64').byteLength;
}

const attachments: MailAttachment[] = [
  {
    filename: 'totals.csv',
    content: Buffer.from('id,total\n1,42\n', 'utf8'),
    contentType: 'text/csv',
  },
  {
    filename: 'terms.txt',
    content: Buffer.from('Terms of service', 'utf8').toString('base64'),
    contentType: 'text/plain',
  },
];

const totalBytes = attachments.reduce(
  (sum, attachment) => sum + decodedByteLength(attachment.content),
  0
);

if (totalBytes > MAX_DIRECT_ATTACHMENT_BYTES) {
  throw new Error(
    `Attachments total ${totalBytes} bytes; the direct-send limit is ${MAX_DIRECT_ATTACHMENT_BYTES} bytes.`
  );
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
  subject: 'Pre-checked attachments',
  text: 'Attachment sizes were verified before sending.',
  attachments,
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

---

## How do I interpret the result of a successful send?

HTTP 202 from Microsoft Graph is the only success status, and it means Graph accepted the message for asynchronous processing — not that it was delivered. `accepted` lists every To, CC, and BCC address in that order, and `rejected` is always empty because the `sendMail` action returns no synchronous per-recipient outcomes and no message identifier.

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

console.log(JSON.stringify(result));
// {"accepted":["alice@example.com","bob@example.com","manager@example.com","archive@example.com"],"rejected":[]}
```

---

## How do I control whether messages are saved to Sent Items?

Set `saveToSentItems: false` in the configuration; it defaults to `true`, meaning Exchange Online keeps a copy in the sender mailbox's Sent Items. The flag is sent as part of every Graph request body and is read from the frozen configuration at request-build time.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
  saveToSentItems: false,
});

const result = await mailer.send({
  from: 'notifications@example.com',
  to: 'customer@example.com',
  subject: 'Not saved to Sent Items',
  text: 'This message is submitted with saveToSentItems disabled.',
});

console.log(`Accepted: ${result.accepted.join(', ')}`);
```

---

## How do I load credentials from environment variables and fail fast at startup?

Read every required value with a small `requireEnv` helper and construct the provider during application startup. The constructor validates the entire configuration immediately — a malformed client ID, tenant, secret, or sender mailbox throws while the process is still booting instead of on the first send.

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
  senderMailbox: requireEnv('AZURE_SENDER_MAILBOX'),
};

try {
  const mailer = new AzureMailProvider(config);

  const result = await mailer.send({
    from: config.senderMailbox,
    to: 'customer@example.com',
    subject: 'Environment configuration',
    text: 'Credentials came from the process environment.',
  });

  console.log(`Accepted: ${result.accepted.join(', ')}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
```

---

## How do I register the mailer in a WebAFX application?

Call `azureMailPlugin(config)` and pass the returned plugin definition to `app.use()`. The factory constructs the provider eagerly (so configuration errors surface at registration time) and registers it as a container singleton under the service name `mailer` with priority `30`.

```typescript
import { azureMailPlugin } from 'blendsdk/webafx-mailer-azure';

const mailPlugin = azureMailPlugin({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

// Inside a WebAFX application this object is passed to app.use(mailPlugin).
console.log(`Plugin: ${mailPlugin.name} (priority ${mailPlugin.priority})`);
// Plugin: mailer (priority 30)
```

---

## How do I register more than one mailer instance?

Give each registration a distinct `serviceName` — the inherited `MailProviderConfig` field that overrides the default `mailer` name. Each plugin creates its own `AzureMailProvider` with its own MSAL token cache and sender mailbox, so one application can send as several Exchange Online mailboxes (subject to the application's RBAC scoping).

```typescript
import { azureMailPlugin } from 'blendsdk/webafx-mailer-azure';

const notificationsPlugin = azureMailPlugin({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
  serviceName: 'graph-mailer',
});

const billingPlugin = azureMailPlugin({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'billing@example.com',
  serviceName: 'billing-mailer',
});

// Register both with app.use(...) in the WebAFX application.
console.log(notificationsPlugin.name); // graph-mailer
console.log(billingPlugin.name); // billing-mailer
```

---

## How do I check that the mailer is ready and shut it down cleanly?

`health()` resolves `true` when MSAL can obtain an access token and `false` otherwise, making it a safe, non-throwing readiness probe before a send loop or batch job — though it proves authentication readiness, not mailbox authorization. `shutdown()` is an intentional no-op because neither MSAL nor native `fetch` retains a disposable transport, so it is always safe to call when a short-lived process ends (in a long-running service, call it once during graceful shutdown).

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

try {
  const healthy = await mailer.health();
  if (!healthy) {
    console.warn('Microsoft Graph authentication is not ready; check the Entra configuration.');
  } else {
    const result = await mailer.send({
      from: 'notifications@example.com',
      to: 'customer@example.com',
      subject: 'Health-gated send',
      text: 'Sent after a successful health check.',
    });

    console.log(`Accepted: ${result.accepted.join(', ')}`);
  }
} finally {
  await mailer.shutdown();
}
```

---

## How do I pass user-supplied recipients and subjects safely?

You can feed untrusted strings straight into `send()`: every address, subject, filename, and MIME type is validated before a token is acquired, and control characters such as `\r\n` are rejected to block header injection. Validation failures never touch the network, and the error messages name the offending field without echoing the value, so they are safe to log and to return to callers.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

// A hostile value captured from an HTTP form or API request.
const recipient = 'customer@example.com\r\nBcc: attacker@example.com';

try {
  await mailer.send({
    from: 'notifications@example.com',
    to: recipient,
    subject: 'Contact form submission',
    text: 'A visitor submitted the contact form.',
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  // Mail message to contains an invalid email address.
}
```

---

## How do I fix the "from address must match the configured senderMailbox" error?

Each provider sends only as its configured mailbox: the `from` address is compared case-insensitively against `senderMailbox`, and any other address is rejected before authentication or network activity with `Mail message from address must match the configured senderMailbox.` The display name part is ignored by that comparison, but remember the `senderMailbox` configuration itself must be a bare address. To send from a different mailbox, create a second provider (or plugin registration) with that mailbox as its `senderMailbox` and grant it RBAC access.

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
    from: 'support@example.com',
    to: 'customer@example.com',
    subject: 'Sender mismatch',
    text: 'This message is rejected before any network call.',
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  // Mail message from address must match the configured senderMailbox.
}
```

---

## How do I handle throttling and other Microsoft Graph send failures?

Every failure is a bounded `Error` with a stable message: authentication problems become `Unable to authenticate with Microsoft Graph.`, network or timeout failures become `Microsoft Graph email request failed.`, and any non-202 Graph response becomes `Microsoft Graph rejected the email request with HTTP {status}.` — with a validated ` Retry after {seconds} seconds.` suffix when Graph throttles with a numeric `Retry-After` header (non-numeric values are ignored). Match on the status to decide whether to back off and retry or surface the failure to the caller.

| Failure | Thrown message |
| --- | --- |
| Authentication (MSAL failure or missing token) | `Unable to authenticate with Microsoft Graph.` |
| Network error or 30-second timeout | `Microsoft Graph email request failed.` |
| Graph non-success status (400, 403, 429, ...) | `Microsoft Graph rejected the email request with HTTP {status}.` |
| Throttling with numeric `Retry-After` | Appends ` Retry after {seconds} seconds.` |
| Invalid configuration or message input | Field-specific validation error; thrown before any token or network call |

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
    subject: 'Throttling example',
    text: 'Hello',
  });

  console.log(`Accepted: ${result.accepted.join(', ')}`);
} catch (error) {
  if (!(error instanceof Error)) {
    throw error;
  }

  if (error.message === 'Unable to authenticate with Microsoft Graph.') {
    console.error(
      'Authentication failed. Verify the client ID, secret, tenant, and admin-consented permissions.'
    );
  } else if (error.message === 'Microsoft Graph email request failed.') {
    console.error('The Graph request failed or exceeded the 30-second timeout. Retry with backoff.');
  } else {
    const statusMatch = /HTTP (\d+)\./.exec(error.message);
    const retryAfterMatch = /Retry after (\d+) seconds/.exec(error.message);

    if (statusMatch && statusMatch[1] === '429' && retryAfterMatch) {
      console.warn(`Throttled by Microsoft Graph. Retry after ${retryAfterMatch[1]} seconds.`);
    } else if (statusMatch) {
      console.error(`Microsoft Graph rejected the request with HTTP ${statusMatch[1]}.`);
    } else {
      console.error(`Send failed: ${error.message}`);
    }
  }
}
```

---

# webafx-mailer-azure Examples Library

---

## Provider Setup and Configuration

This category covers construction and configuration of `AzureMailProvider`. All examples assume Node.js >= 22 and a Microsoft Entra application that has the Microsoft Graph `Mail.Send` application permission with admin consent.

### Create a Provider from Environment Variables

The constructor accepts the Entra application identifiers, the client secret, and the Exchange Online mailbox that Microsoft Graph sends from. Configuration is validated immediately, so a malformed value throws before the MSAL client is created.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const config = {
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
};

const mailer = new AzureMailProvider(config);

console.log(`AzureMailProvider created for ${config.senderMailbox}.`);

// Expected output:
// AzureMailProvider created for notifications@example.com.
```

### Load Settings into a Typed AzureMailConfig

A small environment helper keeps the typed `AzureMailConfig` complete and fails before the provider is constructed, which surfaces missing secrets during startup instead of on the first send.

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
  senderMailbox: requireEnv('AZURE_SENDER_MAILBOX'),
};

const mailer = new AzureMailProvider(config);

console.log(`Mailer ready for ${config.senderMailbox}.`);

// Expected output (with AZURE_SENDER_MAILBOX=notifications@example.com):
// Mailer ready for notifications@example.com.
```

### Opt Out of Sent Items with saveToSentItems

By default Exchange Online retains a copy of every submitted message in the sender mailbox's Sent Items. Set `saveToSentItems` to `false` for transient notifications that should not accumulate.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
  saveToSentItems: false,
});

try {
  const result = await mailer.send({
    from: 'notifications@example.com',
    to: 'customer@example.com',
    subject: 'Transient notification',
    text: 'This message is not retained in Sent Items.',
  });

  console.log(`Accepted: ${result.accepted.join(', ')}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}

// Expected output:
// Accepted: customer@example.com
```

### Use a Verified Tenant Domain as tenantId

`tenantId` accepts either a tenant UUID or a verified tenant domain. Values that contain path segments (such as `/../organizations`) are rejected so the MSAL authority URL cannot be manipulated.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: 'contoso.onmicrosoft.com',
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

try {
  const result = await mailer.send({
    from: 'notifications@example.com',
    to: 'customer@example.com',
    subject: 'Tenant domain configuration',
    text: 'This provider authenticates through the contoso.onmicrosoft.com tenant.',
  });

  console.log(`Accepted: ${result.accepted.join(', ')}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}

// Expected output:
// Accepted: customer@example.com
```

### See Configuration Errors Fail Fast at Construction

Invalid configuration throws synchronously from the constructor — before MSAL is created, before a token is requested, and before any network call. The same fail-fast behavior applies to a malformed tenant, a secret with control characters, or a sender mailbox that contains a display name.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

try {
  new AzureMailProvider({
    tenantId: '22222222-2222-4222-8222-222222222222',
    clientId: 'not-a-client-id',
    clientSecret: 'example-client-secret',
    senderMailbox: 'notifications@example.com',
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}

// Expected output:
// Azure mail clientId must be a valid UUID.
```

---

## Sending Messages

These examples use the common `MailMessage` contract from `blendsdk/webafx-mailer`; the provider maps each field onto the Microsoft Graph JSON model before the request is sent.

### Send a Plain-Text Message

The simplest send: one sender that matches the configured `senderMailbox`, one recipient, and a text body. A successful call returns the recipients Graph accepted for asynchronous processing.

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
    subject: 'Welcome',
    text: 'Welcome to our service.',
  });

  console.log(`Accepted: ${result.accepted.join(', ')}`);
  console.log(`Rejected: ${result.rejected.length}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}

// Expected output:
// Accepted: customer@example.com
// Rejected: 0
```

### Send an HTML Message

Supplying `html` makes Graph deliver the message with `body.contentType = 'HTML'`. HTML should be a complete, well-formed fragment or document.

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
    subject: 'Your invoice is ready',
    html: '<h1>Invoice #1042</h1><p>Your invoice is ready for review.</p>',
  });

  console.log(`Accepted: ${result.accepted.join(', ')}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}

// Expected output:
// Accepted: customer@example.com
```

### Send to Multiple Recipients with CC and BCC

`to`, `cc`, and `bcc` each accept a single address or an array. The resolved `accepted` list preserves To → CC → BCC order, and BCC addresses are carried only inside the Graph payload.

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
    cc: 'manager@example.com',
    bcc: 'archive@example.com',
    subject: 'Monthly report',
    text: 'The report for this month is ready.',
  });

  console.log(`Accepted: ${result.accepted.join(', ')}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}

// Expected output:
// Accepted: alice@example.com, bob@example.com, manager@example.com, archive@example.com
```

### Send with a Display Name in the From Field

The message `from` may include a display name, while the configured `senderMailbox` must remain a bare address. The address portion is compared case-insensitively; surrounding quotes around the display name are normalized away.

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
    from: '"Notifications Team" <notifications@example.com>',
    to: 'customer@example.com',
    subject: 'Display name example',
    text: 'The recipient sees "Notifications Team" as the sender name.',
  });

  console.log(`Accepted: ${result.accepted.join(', ')}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}

// Expected output:
// Accepted: customer@example.com
```

### Rely on HTML Body Preference

When both `text` and `html` are supplied, Microsoft Graph receives exactly one body and HTML wins. The text form is used only when no non-empty HTML body exists.

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
    subject: 'Both body forms supplied',
    text: 'This text is ignored because a non-empty HTML body exists.',
    html: '<p>This HTML body is sent to Microsoft Graph.</p>',
  });

  console.log(`Accepted: ${result.accepted.join(', ')}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}

// Graph receives a single body: { contentType: 'HTML', content: '<p>...</p>' }.
// Expected output:
// Accepted: customer@example.com
```

### Send a Batch with Per-Message Error Isolation

A single provider instance (and therefore a single MSAL token cache) serves the whole batch. Catching per message keeps one failure from stopping the remaining recipients.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const recipients = ['alice@example.com', 'bob@example.com', 'carol@example.com'];

for (const recipient of recipients) {
  try {
    const result = await mailer.send({
      from: 'notifications@example.com',
      to: recipient,
      subject: 'Scheduled reminder',
      text: 'This is your scheduled reminder.',
    });
    console.log(`Accepted for ${recipient}: ${result.accepted.join(', ')}`);
  } catch (error) {
    console.error(
      `Failed for ${recipient}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// Expected output:
// Accepted for alice@example.com: alice@example.com
// Accepted for bob@example.com: bob@example.com
// Accepted for carol@example.com: carol@example.com
```

---

## Working with Attachments

Attachments map to Graph `#microsoft.graph.fileAttachment` entries with base64 `contentBytes`. The combined decoded size of all attachments must stay within `MAX_DIRECT_ATTACHMENT_BYTES` (3 MiB − 1); larger payloads require the Graph upload-session workflow and are rejected locally.

### Attach Buffer Content with a MIME Type

Buffer content is encoded directly to base64. When `contentType` is omitted, the `contentType` property is left out of the Graph attachment entirely.

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
    subject: 'Monthly report',
    text: 'The report is attached.',
    attachments: [
      {
        filename: 'report.txt',
        content: Buffer.from('report contents'),
        contentType: 'text/plain',
      },
    ],
  });

  console.log(`Accepted: ${result.accepted.join(', ')}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}

// Expected output:
// Accepted: customer@example.com
```

### Attach Pre-Encoded Base64 Content

String content follows the common mail contract and must already be canonical base64: correct length, valid base64 alphabet, and a byte-for-byte round trip through `Buffer`. Non-canonical strings are rejected before any network call.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const encoded = Buffer.from('already encoded').toString('base64');

try {
  const result = await mailer.send({
    from: 'notifications@example.com',
    to: 'customer@example.com',
    subject: 'Base64 attachment',
    text: 'The attachment arrived as a pre-encoded string.',
    attachments: [{ filename: 'data.bin', content: encoded }],
  });

  console.log(`Accepted: ${result.accepted.join(', ')}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}

// Expected output:
// Accepted: customer@example.com
```

### Attach Multiple Files in One Message

Buffer and string content can be mixed freely in one attachment array, and each entry can carry its own MIME type. Sizes accumulate across all attachments for the 3 MiB direct-send guard.

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
    subject: 'Two attachments',
    text: 'A CSV and an SVG are attached.',
    attachments: [
      {
        filename: 'totals.csv',
        content: Buffer.from('id,total\n1,42\n', 'utf8'),
        contentType: 'text/csv',
      },
      {
        filename: 'diagram.svg',
        content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4" /></svg>').toString('base64'),
        contentType: 'image/svg+xml',
      },
    ],
  });

  console.log(`Accepted: ${result.accepted.join(', ')}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}

// Expected output:
// Accepted: customer@example.com
```

### Enforce the Direct-Send Limit with MAX_DIRECT_ATTACHMENT_BYTES

The exported constant lets applications pre-check payloads before calling `send()`. The provider enforces the same limit internally and throws a bounded validation error for oversized payloads.

```typescript
import { AzureMailProvider, MAX_DIRECT_ATTACHMENT_BYTES } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const payload = Buffer.alloc(MAX_DIRECT_ATTACHMENT_BYTES + 1);

if (payload.byteLength > MAX_DIRECT_ATTACHMENT_BYTES) {
  console.error(`Payload of ${payload.byteLength} bytes must be split into multiple messages.`);
}

try {
  await mailer.send({
    from: 'notifications@example.com',
    to: 'customer@example.com',
    subject: 'Oversized attachment',
    text: 'The attachment exceeds the Graph direct-send limit.',
    attachments: [{ filename: 'oversized.bin', content: payload }],
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}

// Expected output:
// Payload of 3145728 bytes must be split into multiple messages.
// Mail attachments exceed the Microsoft Graph direct-send size limit.
```

---

## Authentication, Health, and Lifecycle

Authentication is app-only via MSAL client credentials. These examples cover the non-throwing health probe, the protected token-acquisition extension point, and the no-op shutdown.

### Probe Authentication Readiness with health()

`health()` resolves `true` when MSAL can obtain a Microsoft Graph token and `false` otherwise — it never throws. Note that a token proves authentication readiness only, not mailbox authorization.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

const healthy = await mailer.health();

console.log(`Microsoft Graph authentication ready: ${healthy}`);

// Expected output with valid credentials:
// Microsoft Graph authentication ready: true
// Output when MSAL cannot obtain a token:
// Microsoft Graph authentication ready: false
```

### Instrument Token Acquisition in a Subclass

`acquireAccessToken()` is `protected`, so subclasses can observe or wrap token acquisition while the Graph transport stays untouched. MSAL caches tokens internally, so the log lines appear on cache misses rather than on every send.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

class AuditedAzureMailProvider extends AzureMailProvider {
  protected override async acquireAccessToken(): Promise<string> {
    console.log('Acquiring a Microsoft Graph access token through MSAL.');
    const token = await super.acquireAccessToken();
    console.log('Access token available for the Graph request.');
    return token;
  }
}

const mailer = new AuditedAzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

try {
  const result = await mailer.send({
    from: 'notifications@example.com',
    to: 'customer@example.com',
    subject: 'Audited authentication',
    text: 'Token acquisition is logged by the subclass.',
  });

  console.log(`Accepted: ${result.accepted.join(', ')}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}

// Expected output (first send, before the MSAL token cache is warm):
// Acquiring a Microsoft Graph access token through MSAL.
// Access token available for the Graph request.
// Accepted: customer@example.com
// Later sends served from the MSAL token cache print only the Accepted line.
```

### Shut Down the Provider Cleanly

`shutdown()` is an intentional no-op that resolves immediately: neither MSAL nor native `fetch` retains a transport that requires explicit disposal. Calling it in a `finally` block keeps shutdown symmetrical with other providers in the SDK.

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
    subject: 'Shutdown example',
    text: 'This message is sent before shutdown.',
  });
  console.log(`Accepted: ${result.accepted.join(', ')}`);
} finally {
  await mailer.shutdown();
  console.log('Provider shut down; no transport resources are retained.');
}

// Expected output:
// Accepted: customer@example.com
// Provider shut down; no transport resources are retained.
```

---

## WebAFX Plugin Integration

The `azureMailPlugin()` factory constructs an `AzureMailProvider` eagerly and wraps it in the standard mail plugin definition, which registers the provider as a container singleton under the default service name `mailer`.

### Register the Mailer with azureMailPlugin

Create the plugin once at application startup and pass the returned object to `app.use()` inside a WebAFX application. Because construction is eager, configuration validation happens during plugin registration.

```typescript
import { azureMailPlugin } from 'blendsdk/webafx-mailer-azure';

const plugin = azureMailPlugin({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

// Inside a WebAFX application, the plugin object is passed to app.use().
console.log(`Registered as "${plugin.name}" with priority ${plugin.priority}.`);

// Expected output:
// Registered as "mailer" with priority 30.
```

### Register Under a Custom Service Name

Supplying `serviceName` changes the container registration name, which allows more than one mailer to coexist — for example a Graph mailer alongside a default provider under `mailer`.

```typescript
import { azureMailPlugin } from 'blendsdk/webafx-mailer-azure';

const plugin = azureMailPlugin({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
  serviceName: 'graph-mailer',
});

console.log(`Plugin name: ${plugin.name}`);

// Expected output:
// Plugin name: graph-mailer
```

### Fail Fast When Plugin Configuration Is Invalid

The factory constructs the provider immediately, so a bad tenant (including one containing path segments) throws while the application is still registering plugins, not on the first send.

```typescript
import { azureMailPlugin } from 'blendsdk/webafx-mailer-azure';

try {
  azureMailPlugin({
    tenantId: 'contoso.onmicrosoft.com/../organizations',
    clientId: '11111111-1111-4111-8111-111111111111',
    clientSecret: 'example-client-secret',
    senderMailbox: 'notifications@example.com',
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}

// Expected output:
// Azure mail tenantId must be a valid UUID or tenant domain.
```

---

## Error Handling and Delivery Semantics

Every failure collapses into one of a small set of bounded, stable error messages. None of them echo secrets, tokens, message bodies, or Graph response payloads, so they are safe to log.

### Classify Runtime Failures from send()

The four failure classes can be distinguished by exact-match or prefix checks on the error message: authentication, network, Graph rejection, and local validation.

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
    subject: 'Failure classification',
    text: 'Hello',
  });
  console.log(`Accepted: ${result.accepted.join(', ')}`);
} catch (error) {
  if (!(error instanceof Error)) {
    throw error;
  }

  const { message } = error;

  if (message === 'Unable to authenticate with Microsoft Graph.') {
    console.error('Authentication failed: verify the tenant, client ID, and secret.');
  } else if (message === 'Microsoft Graph email request failed.') {
    console.error('Network failure or 30-second timeout: queue the message for retry.');
  } else if (message.startsWith('Microsoft Graph rejected the email request')) {
    console.error(`Microsoft Graph refused the request: ${message}`);
  } else {
    console.error(`Rejected locally before any network call: ${message}`);
  }
}

// Possible outputs:
// Authentication failed: verify the tenant, client ID, and secret.
// Network failure or 30-second timeout: queue the message for retry.
// Microsoft Graph refused the request: Microsoft Graph rejected the email request with HTTP 403.
// Rejected locally before any network call: Mail message subject is invalid.
```

### Handle Throttling with the Retry-After Detail

When Graph throttles with HTTP 429 and sends a numeric `Retry-After` header, the thrown error appends the validated delay (` Retry after {seconds} seconds.`). Non-numeric header values are ignored, so the sentence is either fully present or absent.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

/**
 * Reads the validated retry delay that the provider appends to a throttling
 * error when Microsoft Graph sends a numeric Retry-After header.
 */
function graphRetryDelayMs(error: Error): number {
  const match = /Retry after (\d+) seconds\./.exec(error.message);
  if (!match) {
    return 0;
  }
  return Number(match[1]) * 1000;
}

try {
  const result = await mailer.send({
    from: 'notifications@example.com',
    to: 'customer@example.com',
    subject: 'Throttling example',
    text: 'Hello',
  });
  console.log(`Accepted: ${result.accepted.join(', ')}`);
} catch (error) {
  if (error instanceof Error && error.message.includes('HTTP 429')) {
    const delayMs = graphRetryDelayMs(error);
    console.error(`Throttled by Microsoft Graph. Retry in ${delayMs} ms.`);
  } else {
    throw error;
  }
}

// Expected output when Graph throttles with `Retry-After: 15`:
// Throttled by Microsoft Graph. Retry in 15000 ms.
```

### Interpret MailResult: Acceptance Is Asynchronous

HTTP 202 means Graph accepted the message for asynchronous processing by Exchange Online. The result lists the recipients that were accepted, never invents a message identifier, and always reports zero synchronous rejections.

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
    to: ['alice@example.com', 'bob@example.com'],
    subject: 'Delivery semantics',
    text: 'Graph acceptance is not final delivery.',
  });

  console.log(`Accepted for asynchronous processing: ${result.accepted.join(', ')}`);
  console.log(`Synchronous rejections reported by Graph: ${result.rejected.length}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}

// Expected output:
// Accepted for asynchronous processing: alice@example.com, bob@example.com
// Synchronous rejections reported by Graph: 0
```

---

## Input Validation and Security

Every message is validated locally before a token is requested or a connection is opened. Rejections never reach Microsoft Graph, and error messages never echo the offending value.

### Reject Recipient Header Injection

Control characters in an address — such as an embedded CRLF that tries to smuggle a Bcc header — fail the conservative email grammar. The provider throws before acquiring a token, and `fetch` is never called.

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
}

// Expected output:
// Mail message to contains an invalid email address.
```

### Reject a Sender That Does Not Match the Configured Mailbox

The `from` address of every message must match the configured `senderMailbox` case-insensitively, so a message can never be sent as a different mailbox through the Graph endpoint.

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
    from: 'other@example.com',
    to: 'customer@example.com',
    subject: 'Sender mismatch',
    text: 'Hello',
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}

// Expected output:
// Mail message from address must match the configured senderMailbox.
```

### Reject Invalid Subjects and Missing Bodies

Subjects are bounded to 998 characters with no control characters, and every message must contain a non-empty `text` or `html` body. Both checks run locally before authentication.

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
    subject: 'Subject\r\nBcc: attacker@example.com',
    text: 'Hello',
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}

try {
  await mailer.send({
    from: 'notifications@example.com',
    to: 'customer@example.com',
    subject: 'No body',
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}

// Expected output:
// Mail message subject is invalid.
// Mail message must contain a non-empty text or html body.
```

### Reject Malformed Attachment Metadata and Content

Attachment filenames and MIME types are validated against conservative allowlists, and string content must round-trip as canonical base64. Malformed metadata never reaches JSON serialization or the network.

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
    subject: 'Unsafe attachment metadata',
    text: 'Hello',
    attachments: [
      {
        filename: 'report.txt',
        content: Buffer.from('report'),
        contentType: 'text/plain\r\nInjected: value',
      },
    ],
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}

try {
  await mailer.send({
    from: 'notifications@example.com',
    to: 'customer@example.com',
    subject: 'Malformed base64 attachment',
    text: 'Hello',
    attachments: [{ filename: 'report.txt', content: 'not base64' }],
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}

// Expected output:
// Mail attachment contentType is invalid.
// Mail attachment string content must be valid base64.
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
