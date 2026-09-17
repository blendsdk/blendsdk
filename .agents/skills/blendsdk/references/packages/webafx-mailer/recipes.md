> **Package**: `blendsdk/webafx-mailer`

# webafx-mailer Advanced Patterns

This document covers advanced, production-oriented patterns built from the primitives described in Core Concepts. Every pattern combines multiple package features — providers, plugin factories, configuration types, and lifecycle hooks — and solves a concrete problem you will face once mail becomes part of a real application rather than a single `send()` call.

The patterns, in order:

- **Environment-Driven Backend Selection** — one resolver that selects SMTP or memory per environment and fails fast on bad configuration
- **Boot-Time Health Verification** — verify the backend before the app starts serving, with a degraded fallback for development
- **Resilient Delivery with a Retry Decorator** — a custom `MailProvider` that retries transient SMTP failures with exponential backoff
- **A Typed Domain Mail Facade** — a `NotificationService` that turns domain events into complete `MailMessage` objects over an injected `MailProvider`
- **Multiple Mailers with Distinct Service Names** — transactional and marketing mailers side by side, each with its own backend and lifecycle
- **Deterministic Email Testing** — driving the facade with `MemoryMailProvider` and asserting with its test helpers

All patterns assume ESM and strict TypeScript, and every example is complete — imports included.

---

## Pattern 1 — Environment-Driven Backend Selection with Fail-Fast Validation

**Combines:** `MailFactoryConfig`, `createMailProvider()`, `createMailPlugin()`, `DEFAULT_SERVICE_NAME`

**When to use it:** every application that runs in more than one environment, or that must never send real email from development, CI, or staging. This is the standard way to answer "which mail backend am I running?" in one and only one place instead of scattering `process.env.NODE_ENV` checks through the codebase.

### The Pattern

**Before — fragile environment wiring:**

```typescript
import { smtpMailPlugin } from "blendsdk/webafx-mailer";

// Anti-pattern: missing variables are hidden behind non-null assertions,
// an unset SMTP_PORT silently becomes NaN, and every environment —
// including CI — talks to the real SMTP server.
const plugin = smtpMailPlugin({
    host: process.env.SMTP_HOST!,
    port: Number(process.env.SMTP_PORT),
    auth: {
        user: process.env.SMTP_USER!,
        pass: process.env.SMTP_PASS!,
    },
});
```

**After — a validated configuration resolver:**

```typescript
import {
    DEFAULT_SERVICE_NAME,
    createMailPlugin,
    createMailProvider,
} from "blendsdk/webafx-mailer";
import type { MailFactoryConfig, MailProvider } from "blendsdk/webafx-mailer";
import type { PluginDefinition } from "blendsdk/webafx";

/** Read a required environment variable or fail with a descriptive error. */
function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
    const value = env[name];
    if (value === undefined || value.length === 0) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

/** Parse and validate an SMTP port; defaults to the STARTTLS submission port. */
function parsePort(env: NodeJS.ProcessEnv): number {
    const raw = env.SMTP_PORT ?? "587";
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid SMTP_PORT "${raw}": expected an integer from 1 to 65535.`);
    }
    return port;
}

/**
 * Resolve the mail backend from the environment.
 * Production → validated SMTP configuration; everything else → in-memory.
 */
function resolveMailConfig(env: NodeJS.ProcessEnv): MailFactoryConfig {
    const serviceName = env.MAIL_SERVICE_NAME ?? DEFAULT_SERVICE_NAME;

    if (env.NODE_ENV !== "production") {
        return { type: "memory", serviceName };
    }

    const port = parsePort(env);
    return {
        type: "smtp",
        serviceName,
        host: requireEnv(env, "SMTP_HOST"),
        port,
        secure: port === 465, // implicit TLS for 465, STARTTLS everywhere else
        auth: {
            user: requireEnv(env, "SMTP_USER"),
            pass: requireEnv(env, "SMTP_PASS"),
        },
    };
}

/** Build the fully wired mail plugin for the current environment. */
function createApplicationMailPlugin(env: NodeJS.ProcessEnv): PluginDefinition {
    const mailer: MailProvider = createMailProvider(resolveMailConfig(env));
    console.log(`Mail backend: ${mailer.constructor.name} (service "${mailer.serviceName}")`);
    return createMailPlugin(mailer);
}

// --- Application startup -----------------------------------------------

const mailPlugin = createApplicationMailPlugin(process.env);
console.log(`Plugin "${mailPlugin.name}" registered with priority ${mailPlugin.priority}`);

// In a WebAFX application:
//   app.use(mailPlugin);

// Fail-fast demonstration — production without SMTP variables throws
// before the application starts serving traffic:
try {
    createApplicationMailPlugin({ NODE_ENV: "production" });
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    // "Missing required environment variable: SMTP_HOST"
}
```

**Environment variables used by the resolver:**

| Variable | Used when | Purpose |
|----------|-----------|---------|
| `NODE_ENV` | always | `"production"` selects the SMTP backend; anything else selects memory |
| `MAIL_SERVICE_NAME` | always | Overrides `DEFAULT_SERVICE_NAME` (`"mailer"`) for service-container registration |
| `SMTP_HOST` | production | SMTP server hostname (required) |
| `SMTP_PORT` | production | Port, validated; defaults to `587` |
| `SMTP_USER` / `SMTP_PASS` | production | SMTP credentials (required) |

### Why This Pattern Is Valuable

- **Single decision point.** Backend type, service name, TLS mode, and credentials all resolve in one pure function; every consumer downstream sees only `MailProvider`.
- **Fails at boot, not at 3 a.m.** A missing `SMTP_HOST` or a malformed port throws before the application accepts traffic — never at the first password reset.
- **Safe by default.** Any environment that is not exactly `"production"` gets the memory backend, so CI and local development physically cannot email real customers.
- **Type-safe composition.** The resolver returns `MailFactoryConfig`, which `createMailProvider()` consumes; the compiler checks the shape, and the factory's runtime guard rejects unknown `type` values with a descriptive error.
- **Testable by design.** `resolveMailConfig` is a pure function of `NodeJS.ProcessEnv` — unit tests pass fake env objects instead of mutating `process.env`.

### Caveats and Performance Considerations

- `createMailProvider()` uses non-null assertions for `host` and `port` — it trusts your configuration. Validation is precisely what the resolver exists for; never feed raw `process.env` values to the factory.
- `Number()` coerces surprisingly: `Number("")` is `0` and `Number(" 12 ")` is `12`. Validate with `Number.isInteger` and range checks, as `parsePort` does.
- Derive `secure` from the validated port (`465` → `true`). Hardcoding `secure: true` on port 587 or `false` on 465 is the most common SMTP misconfiguration.
- Only the exact string `"production"` selects SMTP. If staging should use a real relay with test credentials, extend the resolver deliberately — keep the decision in this one function.
- The memory backend accepts everything and delivers nothing by design. It is excellent for development and CI and wrong for any environment with real users.

---

## Pattern 2 — Boot-Time Health Verification with a Degraded Fallback

**Combines:** `createMailProvider()`, `health()`, `shutdown()`, `createMailPlugin()`, `MemoryMailProvider`

**When to use it:** whenever a misconfigured SMTP connection must not take down the whole application — and equally, must not be discovered only when the first user tries to reset a password. Production should refuse to start with a broken mailer; development should keep working.

### The Pattern

```typescript
import {
    MemoryMailProvider,
    createMailPlugin,
    createMailProvider,
} from "blendsdk/webafx-mailer";
import type { MailFactoryConfig } from "blendsdk/webafx-mailer";
import type { PluginDefinition } from "blendsdk/webafx";

/**
 * Create a mail plugin only after the configured backend passes its
 * health check at application startup.
 *
 * - Healthy backend → the real plugin is returned.
 * - Unhealthy + allowMemoryFallback → the failed provider is shut down and
 *   a MemoryMailProvider is registered instead (development convenience).
 * - Unhealthy + no fallback → startup fails with a descriptive error.
 */
async function createVerifiedMailPlugin(
    config: MailFactoryConfig,
    options?: { allowMemoryFallback?: boolean }
): Promise<PluginDefinition> {
    const provider = createMailProvider(config);
    const healthy = await provider.health();

    if (healthy) {
        return createMailPlugin(provider);
    }

    // Release the half-open nodemailer transport before giving up on it.
    await provider.shutdown();

    if (options?.allowMemoryFallback) {
        console.warn(
            `Mail backend "${config.type}" is unhealthy — falling back to in-memory delivery.`
        );
        const fallback = new MemoryMailProvider({ serviceName: config.serviceName });
        return createMailPlugin(fallback);
    }

    throw new Error(
        `Mail backend "${config.type}" failed its startup health check. ` +
            `Verify host, port, credentials, and network access.`
    );
}

// --- Application startup -----------------------------------------------

const config: MailFactoryConfig = {
    type: "smtp",
    serviceName: "transactional-mailer",
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "notifications@example.com", pass: "smtp-secret" },
};

const plugin = await createVerifiedMailPlugin(config, {
    allowMemoryFallback: process.env.NODE_ENV !== "production",
});

console.log(plugin.name); // "transactional-mailer"
console.log(plugin.priority); // 30

// In a WebAFX application:
//   app.use(plugin);
```

### Why This Pattern Is Valuable

- **Health-first startup.** DNS problems, firewalls, wrong credentials, and expired certificates are caught before the first request — the failure mode is a clear error message instead of a production incident.
- **`health()` never throws.** The SMTP provider performs an EHLO/HELO handshake via nodemailer's `verify()` and catches failures internally, so boot code stays a simple `if` — no `try`/`catch` noise.
- **Policy, not code.** One option flips between "refuse to start" (production) and "work offline" (development). Both paths go through the exact same plugin wiring: singleton registration, health hook, and shutdown hook are identical for the real provider and the fallback.
- **Lifecycle hygiene.** The failed provider is `shutdown()` before being discarded, releasing the partially created transport instead of leaking it.
- **Developer velocity.** With the memory fallback, UI flows that send mail remain fully exercisable without an SMTP server.

### Caveats and Performance Considerations

- Boot-time health is a point-in-time network probe — it is not a runtime guarantee. The plugin's health hook keeps probing at runtime, and sends can still fail later (combine with [Pattern 3](#pattern-3--resilient-delivery-with-a-retry-decorator-provider)).
- Run this check **only at startup**: each `health()` call is a full EHLO round trip. Never place it in a request path.
- The memory fallback *discards* email. The `console.warn` is a placeholder for your real logger — make the fallback loud in logs, and gate it strictly on non-production environments.
- For flaky networks or rolling SMTP restarts, consider retrying the boot check a few times (with a short delay) before declaring failure — a single failed EHLO should not block a deployment.
- This pattern makes plugin creation async — `await` the factory before calling `app.use(...)`.

---

## Pattern 3 — Resilient Delivery with a Retry Decorator Provider

**Combines:** `MailProvider` subclassing, `send()`, `health()`, `shutdown()`, `createMailPlugin()`

**When to use it:** when transient network failures (DNS blips, connection timeouts, server restarts) should not fail an email on the first attempt — but permanent failures (wrong credentials, rejected recipients) should fail immediately. The decorator keeps the retry logic *inside* the provider contract, so application code and WebAFX integration never change.

### The Pattern

**The decorator provider** (`retrying-mail-provider.ts`):

```typescript
import { MailProvider } from "blendsdk/webafx-mailer";
import type { MailMessage, MailResult } from "blendsdk/webafx-mailer";

/**
 * Nodemailer error codes that indicate a transient failure worth retrying.
 * Permanent failures (EAUTH, EENVELOPE, EMESSAGE) are deliberately absent
 * and are rethrown immediately.
 */
const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
    "ECONNECTION", // could not connect to the SMTP server
    "ETIMEDOUT", // connection or greeting timed out
    "ESOCKET", // socket-level failure during the SMTP conversation
    "EDNS", // DNS resolution of the SMTP host failed
    "ECONNRESET", // connection reset by the peer
]);

/** Type guard: does this thrown value carry an error code we can classify? */
function isRetryableSendError(error: unknown): boolean {
    if (!(error instanceof Error) || !("code" in error)) {
        return false;
    }
    const { code } = error;
    return typeof code === "string" && RETRYABLE_ERROR_CODES.has(code);
}

export interface RetryingMailProviderOptions {
    /** Total attempts per send, including the first. Default: 3 */
    maxAttempts?: number;
    /** Base backoff delay in milliseconds, doubled on every retry. Default: 250 */
    baseDelayMs?: number;
    /** Override the registered service name; defaults to the wrapped provider's */
    serviceName?: string;
}

/**
 * Decorator provider — wraps another MailProvider and retries transient
 * SMTP failures with exponential backoff. Implements the full MailProvider
 * contract, so it is interchangeable with any backend.
 */
export class RetryingMailProvider extends MailProvider {
    private readonly inner: MailProvider;
    private readonly maxAttempts: number;
    private readonly baseDelayMs: number;

    constructor(inner: MailProvider, options?: RetryingMailProviderOptions) {
        super({ serviceName: options?.serviceName ?? inner.serviceName });
        this.inner = inner;
        this.maxAttempts = options?.maxAttempts ?? 3;
        this.baseDelayMs = options?.baseDelayMs ?? 250;
    }

    async send(message: MailMessage): Promise<MailResult> {
        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
            try {
                return await this.inner.send(message);
            } catch (error) {
                const canRetry = attempt < this.maxAttempts && isRetryableSendError(error);
                if (!canRetry) {
                    throw error;
                }
                // Exponential backoff: base, 2×base, 4×base, ...
                const delayMs = this.baseDelayMs * 2 ** (attempt - 1);
                await new Promise<void>((resolve) => {
                    setTimeout(resolve, delayMs);
                });
            }
        }
        // Only reachable when maxAttempts < 1 — treat it as a programming error
        throw new Error(`RetryingMailProvider: invalid maxAttempts (${this.maxAttempts}).`);
    }

    async health(): Promise<boolean> {
        return this.inner.health();
    }

    async shutdown(): Promise<void> {
        return this.inner.shutdown();
    }
}
```

**Wiring it into WebAFX** — the decorator is transparent to everything else:

```typescript
import { RetryingMailProvider } from "./retrying-mail-provider.js";
import { SmtpMailProvider, createMailPlugin } from "blendsdk/webafx-mailer";

const smtp = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "notifications@example.com", pass: "smtp-secret" },
});

const resilientMailer = new RetryingMailProvider(smtp, {
    maxAttempts: 4,
    baseDelayMs: 500,
});

// Same service name as the wrapped provider — the plugin and the rest of
// the application cannot tell the difference.
const plugin = createMailPlugin(resilientMailer);
console.log(plugin.name); // "mailer"

console.log(await resilientMailer.health()); // delegated EHLO probe

const result = await resilientMailer.send({
    from: "notifications@example.com",
    to: "alice@example.com",
    subject: "Deployment finished",
    text: "Version 5.x has been deployed.",
});

console.log(result.accepted); // ["alice@example.com"]

// Shutting down the decorator shuts down the wrapped SMTP provider.
await resilientMailer.shutdown();
```

**Which errors are retried:**

| Error code | Meaning | Retried |
|------------|---------|---------|
| `ECONNECTION` | Could not reach the SMTP server | Yes |
| `ETIMEDOUT` | Connection or greeting timed out | Yes |
| `ESOCKET` | Socket error during the SMTP conversation | Yes |
| `EDNS` | DNS resolution failed | Yes |
| `ECONNRESET` | Connection reset by peer | Yes |
| `EAUTH` | Authentication rejected | No — configuration problem |
| `EENVELOPE` | Sender or recipient address rejected | No — permanent failure |
| `EMESSAGE` | Message data rejected | No — permanent failure |

### Why This Pattern Is Valuable

- **The contract stays intact.** Application code, plugin factories, health checks, and shutdown hooks all operate on `MailProvider`; only delivery semantics improve. The decorator defaults its `serviceName` to the wrapped provider's, so the plugin registers the same name as before.
- **Composes with everything.** Wrap `SmtpMailProvider` in production, wrap `MemoryMailProvider` in tests (retry becomes a no-op because memory `send()` never throws), or wrap your own custom provider.
- **Error taxonomy, not blind retries.** Transient infrastructure failures get another chance; permanent failures (bad credentials, rejected envelopes) fail immediately instead of wasting attempts and time.
- **Backoff that respects the network.** Delays double on each retry (500 ms, 1 s, 2 s with the config above), giving a struggling relay room to recover instead of hammering it.
- **Zero call-site changes.** Nothing else in the application needs to know retries exist.

### Caveats and Performance Considerations

- **At-least-once delivery.** If the connection fails *after* the server accepted the message (for example, while reading the final response), a retry can produce a duplicate. Keep email content idempotent where duplicates matter, or dedupe downstream.
- **Worst-case latency multiplies.** Each attempt can consume a full SMTP timeout; with `maxAttempts: 4`, a caller may wait through several timeouts plus backoff. For user-facing requests, send asynchronously (background job or queue) instead of blocking the HTTP response.
- Do not stack retry wrappers — two decorators multiply attempts (`N × M`) and backoff delays. One wrapper around the real transport is enough.
- `maxAttempts` below `1` is a programming error: the provider throws a descriptive message rather than silently skipping the send.
- In test suites, pass `baseDelayMs: 0` (or a small value such as `10`) so backoff does not slow the suite down; `0` still resolves asynchronously via `setTimeout`.
- Total added delay with the defaults (3 attempts, 250 ms base): 250 ms + 500 ms = 750 ms of backoff in the absolute worst case, excluding SMTP timeouts themselves.

---

## Pattern 4 — A Typed Domain Mail Facade over MailProvider

**Combines:** `MailProvider` injection, `MailMessage`, `MailAttachment`, `MailResult`, text/HTML body pairing

**When to use it:** when the application has more than a couple of send sites. Instead of assembling `MailMessage` objects throughout your business logic, you define one class whose methods are named after domain events (`sendWelcome`, `sendPasswordReset`, `sendInvoice`). It keeps subjects, tone, and text/HTML pairing consistent, and it accepts an injected `MailProvider`, so the same class runs over SMTP in production and `MemoryMailProvider` in tests.

### The Pattern

**The facade** (`notification-service.ts`):

```typescript
import type { MailAttachment, MailProvider, MailResult } from "blendsdk/webafx-mailer";

/** Escape untrusted text before embedding it in an HTML body. */
function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

export interface MailRecipient {
    email: string;
    displayName: string;
}

export interface InvoiceNotice {
    number: string;
    total: string; // pre-formatted, e.g. "$42.00"
}

/**
 * Application-facing mail API. Every method builds a complete MailMessage
 * (text + HTML fallback) and delegates delivery to the injected provider.
 */
export class NotificationService {
    constructor(
        private readonly mailer: MailProvider,
        private readonly fromAddress: string
    ) {}

    async sendWelcome(user: MailRecipient): Promise<MailResult> {
        const name = escapeHtml(user.displayName);
        return this.mailer.send({
            from: this.fromAddress,
            to: user.email,
            subject: "Welcome aboard!",
            text: `Hi ${user.displayName},\n\nWelcome! Your account is ready.`,
            html: `<h1>Welcome, ${name}!</h1><p>Your account is ready.</p>`,
        });
    }

    async sendPasswordReset(
        user: MailRecipient,
        resetUrl: string,
        expiresInMinutes: number
    ): Promise<MailResult> {
        return this.mailer.send({
            from: this.fromAddress,
            to: user.email,
            subject: "Reset your password",
            text:
                `Hi ${user.displayName},\n\n` +
                `Reset your password: ${resetUrl}\n` +
                `This link expires in ${expiresInMinutes} minutes.`,
            html:
                `<p>Hi ${escapeHtml(user.displayName)},</p>` +
                `<p><a href="${escapeHtml(resetUrl)}">Reset your password</a></p>` +
                `<p>This link expires in ${expiresInMinutes} minutes.</p>`,
        });
    }

    async sendInvoice(
        user: MailRecipient,
        invoice: InvoiceNotice,
        pdf: Buffer
    ): Promise<MailResult> {
        const attachment: MailAttachment = {
            filename: `invoice-${invoice.number}.pdf`,
            content: pdf,
            contentType: "application/pdf",
        };
        return this.mailer.send({
            from: this.fromAddress,
            to: [user.email],
            bcc: this.fromAddress, // keep a copy of every invoice in the sending mailbox
            subject: `Invoice ${invoice.number}`,
            text:
                `Hi ${user.displayName},\n\n` +
                `Please find invoice ${invoice.number} (${invoice.total}) attached.`,
            html:
                `<p>Hi ${escapeHtml(user.displayName)},</p>` +
                `<p>Please find invoice <strong>${escapeHtml(invoice.number)}</strong> ` +
                `(${escapeHtml(invoice.total)}) attached.</p>`,
            attachments: [attachment],
        });
    }
}
```

**Using it with any provider** — here the memory backend, so the whole flow is observable:

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import { NotificationService } from "./notification-service.js";

const mailer = new MemoryMailProvider();
const notifications = new NotificationService(mailer, "billing@example.com");

const result = await notifications.sendWelcome({
    email: "alice@example.com",
    displayName: "Alice & Bob",
});

console.log(result.accepted); // ["alice@example.com"]

const sent = mailer.getLastMessage();
console.log(sent?.message.subject); // "Welcome aboard!"
console.log(sent?.message.html);    // "<h1>Welcome, Alice &amp; Bob!</h1>..."

await mailer.shutdown();
```

### Why This Pattern Is Valuable

- **One home for every message shape.** Subjects, tone, text/HTML pairs, and escaping live in a single class; call sites read like domain actions — `notifications.sendPasswordReset(user, url, 15)`.
- **Provider-agnostic by construction.** The constructor takes `MailProvider`: inject `SmtpMailProvider` in production (optionally wrapped in [Pattern 3](#pattern-3--resilient-delivery-with-a-retry-decorator-provider)'s retry decorator), `MemoryMailProvider` in tests ([Pattern 6](#pattern-6--deterministic-email-testing-with-memorymailprovider)) — the code path under test is identical.
- **Security boundary made explicit.** The mailer sends exactly what you hand it, so escaping untrusted values is the facade's responsibility. Escaping happens precisely where interpolation happens — including URLs placed in `href` attributes.
- **Accessibility and client fallback.** Every message sets both `text` and `html`; plain-text clients and screen-reader-focused flows get a sane fallback.
- **Results stay visible.** Methods return `MailResult`, so callers can audit `accepted`/`rejected` addresses without knowing anything about the transport.

### Caveats and Performance Considerations

- Keep the facade thin. Retries, health checks, and connection management belong to providers and plugins ([Patterns 2](#pattern-2--boot-time-health-verification-with-a-degraded-fallback)–[3](#pattern-3--resilient-delivery-with-a-retry-decorator-provider)) — do not reimplement them here.
- Escape only when interpolating into HTML. Plain-text bodies do not need escaping (and escaping a URL there would corrupt it — note how `text` uses the raw `resetUrl` while `html` uses the escaped one).
- Method-per-email stops scaling at a few dozen templates; at that point, generate message builders from template files while keeping the facade's constructor and provider injection unchanged.
- One `from` address per service instance. Different senders (billing vs. support) belong to separate instances with distinct `serviceName`s — see [Pattern 5](#pattern-5--multiple-mailers-with-distinct-service-names).
- The facade is stateless apart from its provider reference — create one per mailer and inject it; do not construct providers inside the facade, or you lose the singleton connection pool.

---

## Pattern 5 — Multiple Mailers with Distinct Service Names

**Combines:** `createMailProvider()`, `createMailPlugin()` options, `serviceName`, plugin `priority`

**When to use it:** when one application sends different *kinds* of email — transactional versus marketing, or high-volume versus low-latency — through separate relays, credentials, or even separate backends. Each mailer is an independent provider registered under its own `serviceName`, with its own connection pool, health probe, and shutdown hook.

### The Pattern

```typescript
import { createMailPlugin, createMailProvider } from "blendsdk/webafx-mailer";
import type { MailFactoryConfig } from "blendsdk/webafx-mailer";
import type { PluginDefinition } from "blendsdk/webafx";

interface MailerDefinitions {
    transactional: MailFactoryConfig;
    marketing: MailFactoryConfig;
}

/**
 * Build one plugin per mailer. Each backend is created independently and
 * registered under its own serviceName, so nothing collides in the
 * WebAFX service container.
 */
function createMailerPlugins(definitions: MailerDefinitions): PluginDefinition[] {
    const transactional = createMailProvider(definitions.transactional);
    const marketing = createMailProvider(definitions.marketing);

    return [
        createMailPlugin(transactional, { priority: 20 }),
        createMailPlugin(marketing),
    ];
}

// --- Application startup -----------------------------------------------

const mailerPlugins = createMailerPlugins({
    transactional: {
        type: "smtp",
        serviceName: "transactional-mailer",
        host: "smtp.example.com",
        port: 587,
        secure: false,
        auth: { user: "no-reply@example.com", pass: "smtp-secret" },
    },
    marketing: {
        type: "smtp",
        serviceName: "marketing-mailer",
        host: "smtp-bulk.example.com",
        port: 587,
        secure: false,
        auth: { user: "news@example.com", pass: "bulk-secret" },
    },
});

for (const plugin of mailerPlugins) {
    console.log(`"${plugin.name}" — priority ${plugin.priority}`);
}
// "transactional-mailer" — priority 20
// "marketing-mailer" — priority 30

// In a WebAFX application:
//   for (const plugin of mailerPlugins) {
//       app.use(plugin);
//   }
```

**What the application ends up with:**

| Mailer | Backend | `serviceName` | Plugin priority |
|--------|---------|---------------|-----------------|
| Transactional | SMTP via `smtp.example.com:587` | `transactional-mailer` | 20 |
| Marketing | SMTP via `smtp-bulk.example.com:587` | `marketing-mailer` | 30 |

In development, switch either entry to `{ type: "memory", serviceName: "marketing-mailer" }` and nothing else in the application changes — the [Pattern 1](#pattern-1--environment-driven-backend-selection-with-fail-fast-validation) resolver produces exactly these shapes per environment.

### Why This Pattern Is Valuable

- **Fault isolation.** Marketing campaigns run on a bulk relay with its own credentials and its own nodemailer connection pool; a marketing flood cannot starve transactional sends through a shared socket pool.
- **Independent lifecycle.** Each plugin registers its own health probe and shutdown hook (and the service container's `dispose` callback runs per provider), so one mailer can be disposed without touching the other.
- **Explicit routing contracts.** Service names (`transactional-mailer`, `marketing-mailer`) are stable identifiers. Combined with one facade instance per mailer ([Pattern 4](#pattern-4--a-typed-domain-mail-facade-over-mailprovider)), a password reset cannot accidentally leave through the marketing stream.
- **Uniform tooling.** Both plugins are plain `PluginDefinition`s that compose through the same `app.use()` pipeline as every other WebAFX plugin; `priority` makes installation order explicit.
- **Convention consistency.** This is the same provider/`serviceName` convention used across the BlendSDK provider packages — the design of this package deliberately mirrors `blendsdk/webafx-cache`.

### Caveats and Performance Considerations

- **Service names must be unique.** Two plugins whose providers share a name both register under that key and collide in the service container. Centralize names in constants rather than scattering string literals.
- **Two SMTP providers mean two connection pools and two health probes.** That is the desired isolation, but plan capacity accordingly — and remember each probe is an EHLO round trip, so `/health` latency grows with the number of SMTP mailers.
- `priority` (20 installs before 30) controls **plugin installation order only** — it does not select a mailer at send time. Selection happens by resolving the intended service and using its provider/facade.
- Shutdown is per provider: make sure application shutdown runs every plugin's hooks so all pools close cleanly.
- Routing lives in application code. Without one facade per mailer, every send site must know which service it targets — keep that knowledge at composition time, not at call sites.

---

## Pattern 6 — Deterministic Email Testing with MemoryMailProvider

**Combines:** `MemoryMailProvider` test helpers (`getSentMessages`, `getLastMessage`, `clear`), custom `MailProvider` test doubles, constructor injection, `createMailProvider()` notes

**When to use it:** in every test suite that asserts your application sends the right email — and in local development, where the same provider keeps real inboxes untouched. The memory backend is the package's first-party test double: no Docker, no SMTP server, no network.

### The Pattern

The suite below tests the `NotificationService` from [Pattern 4](#pattern-4--a-typed-domain-mail-facade-over-mailprovider) through its `MemoryMailProvider` backend, plus a throwing provider for failure paths:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MailProvider, MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { MailMessage, MailResult } from "blendsdk/webafx-mailer";
import { NotificationService } from "../src/notification-service.js";

/** A provider that always fails — exercises error paths deterministically. */
class FailingMailProvider extends MailProvider {
    async send(message: MailMessage): Promise<MailResult> {
        throw new Error(`SMTP outage: could not deliver "${message.subject}"`);
    }

    async health(): Promise<boolean> {
        return false;
    }

    async shutdown(): Promise<void> {
        // Nothing to release — this provider simulates an unreachable backend.
    }
}

describe("NotificationService", () => {
    let mailer: MemoryMailProvider;
    let notifications: NotificationService;

    beforeEach(() => {
        // A fresh provider per test means a fresh outbox.
        mailer = new MemoryMailProvider();
        notifications = new NotificationService(mailer, "billing@example.com");
    });

    afterEach(async () => {
        await mailer.shutdown();
    });

    it("sends a welcome email with both text and HTML bodies", async () => {
        const result = await notifications.sendWelcome({
            email: "alice@example.com",
            displayName: "Alice",
        });

        expect(result.accepted).toEqual(["alice@example.com"]);

        const sent = mailer.getLastMessage();
        expect(sent).toBeDefined();
        expect(sent?.message.to).toBe("alice@example.com");
        expect(sent?.message.subject).toBe("Welcome aboard!");
        expect(sent?.message.text).toContain("Hi Alice");
        expect(sent?.message.html).toContain("<h1>Welcome, Alice!</h1>");
        expect(sent?.result.messageId).toMatch(/^<memory-\d+-\d+@test>$/);
    });

    it("escapes HTML in user-provided display names", async () => {
        await notifications.sendWelcome({
            email: "mallory@example.com",
            displayName: "<script>alert('xss')</script>",
        });

        const html = mailer.getLastMessage()?.message.html ?? "";
        expect(html).not.toContain("<script>");
        expect(html).toContain("&lt;script&gt;");
    });

    it("attaches the invoice PDF and BCCs the sender", async () => {
        const pdf = Buffer.from("%PDF-1.7 fake invoice body", "utf8");

        await notifications.sendInvoice(
            { email: "bob@example.com", displayName: "Bob" },
            { number: "INV-1001", total: "$42.00" },
            pdf
        );

        const entry = mailer.getLastMessage();
        const attachment = entry?.message.attachments?.[0];
        expect(entry?.message.attachments).toHaveLength(1);
        expect(attachment?.filename).toBe("invoice-INV-1001.pdf");
        expect(attachment?.contentType).toBe("application/pdf");
        expect(entry?.message.bcc).toBe("billing@example.com");
        expect(entry?.result.accepted).toContain("bob@example.com");
    });

    it("clears the outbox between assertions", async () => {
        await notifications.sendWelcome({ email: "a@example.com", displayName: "A" });
        expect(mailer.getSentMessages()).toHaveLength(1);

        mailer.clear();
        await notifications.sendWelcome({ email: "b@example.com", displayName: "B" });

        expect(mailer.getSentMessages()).toHaveLength(1);
        expect(mailer.getLastMessage()?.message.to).toBe("b@example.com");
    });

    it("exposes a defensive copy of the outbox", async () => {
        await notifications.sendWelcome({ email: "alice@example.com", displayName: "Alice" });

        const snapshot = mailer.getSentMessages();
        snapshot.length = 0; // mutate the copy...

        expect(mailer.getSentMessages()).toHaveLength(1); // ...the store is unaffected
    });

    it("propagates provider failures to the caller", async () => {
        const failing = new FailingMailProvider();
        const service = new NotificationService(failing, "billing@example.com");

        await expect(
            service.sendWelcome({ email: "alice@example.com", displayName: "Alice" })
        ).rejects.toThrow('SMTP outage: could not deliver "Welcome aboard!"');

        expect(await failing.health()).toBe(false);
        await failing.shutdown();
    });
});
```

### Why This Pattern Is Valuable

- **No infrastructure.** The suite runs anywhere — no SMTP server, no Docker, no Mailpit — which is exactly how the package's own memory tests are structured.
- **Deterministic assertions.** Store order equals send order, and message IDs follow `` `<memory-{Date.now()}-{index}@test>` ``, so uniqueness assertions are stable. `getSentMessages()` returns a defensive copy (mutating the snapshot cannot corrupt provider state), and `getLastMessage()` keeps single-email assertions tight.
- **Production code paths, test backend.** `NotificationService` and any provider-level logic run unchanged — only the injected provider instance differs. Constructor injection ([Pattern 4](#pattern-4--a-typed-domain-mail-facade-over-mailprovider)) is what makes this a one-line swap.
- **Failure coverage without risk.** A small throwing `MailProvider` subclass exercises propagation paths, and `health(): false` models an outage — all without touching the network.
- **Zero leakage.** The memory provider never opens a socket, so even a test run with production credentials in the environment cannot email a real person.

### Caveats and Performance Considerations

- The memory backend marks **every** recipient (to + cc + bcc) as accepted and never rejects. It validates your code's *intent*, not SMTP semantics — invalid addresses, rate limits, and spam scoring all go untested. For transport-level fidelity, run `SmtpMailProvider` against Mailpit, exactly as this package's own integration suite does (SMTP on `1025`, REST API on `8025`).
- Entries store the message **by reference** — `entry.message` is the same object your code passed to `send()`. Treat sent messages as immutable after sending, and note that a strict identity check (`expect(entry.message).toBe(myMessage)`) is valid.
- `createMailProvider({ type: "memory" })` returns the `MailProvider` abstraction, which does **not** expose `getSentMessages()`. When a test needs assertions, instantiate `MemoryMailProvider` directly (or keep the concrete reference you created); use the factory for application wiring, not for tests.
- `shutdown()` clears the store. Call it in `afterEach`, never mid-test between assertions.
- `messageId` embeds `Date.now()` — assert with a pattern such as `/^<memory-\d+-\d+@test>$/`, never with a hardcoded value.
- If a suite shares one provider instance across tests (a valid optimization), call `clear()` in `beforeEach` to isolate cases — that is precisely what the helper exists for. The example above prefers a fresh provider per test.

---

## Composing the Patterns End to End

The patterns stack without any changes to the application layer: **Pattern 1** resolves the backend per environment and fails fast on bad configuration → **Pattern 2** verifies the resolved backend at boot and degrades explicitly in development → **Pattern 3** wraps the surviving provider in retry semantics → **Pattern 4** exposes the result as a typed, provider-agnostic domain facade → **Pattern 5** lets that recipe repeat once per mailer, each under its own `serviceName` → **Pattern 6** proves the whole chain with the memory backend, no infrastructure required. Every step consumes the same `MailProvider` contract, so each layer can be adopted — or removed — independently.

---

# webafx-mailer Common Scenarios

This document answers frequently asked "How do I ...?" questions about `blendsdk/webafx-mailer`, ordered from simple to complex. Each scenario states the question, gives a brief solution, and ends with a complete code example that uses only the package's public API (plus `vitest` in the testing scenarios).

The scenarios are grouped as follows:

- **Sending messages** — in-memory and SMTP sends, multiple recipients, attachments
- **Testing with the memory backend** — assertions, resetting state, unit-testing dependent services
- **SMTP configuration and operations** — TLS modes, connectivity checks, error handling, graceful shutdown
- **WebAFX integration** — plugin registration, per-environment backend switching, multiple mailers
- **Extending** — writing a custom `MailProvider` subclass

---

## How do I send an email with the in-memory backend?

Instantiate `MemoryMailProvider` and call `send()` with a `MailMessage`. Nothing leaves the process — the message is stored in memory — and the resolved `MailResult` reports every recipient as accepted with a generated `<memory-...@test>` message ID.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

const result = await mailer.send({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Welcome!",
    text: "Welcome to our service!",
    html: "<h1>Welcome to our service!</h1>",
});

console.log(result.accepted);  // ["user@example.com"]
console.log(result.rejected);  // []
console.log(result.messageId); // e.g. "<memory-1729512345678-0@test>"

// Stored messages are queryable — useful for development and tests
console.log(mailer.getSentMessages().length); // 1

await mailer.shutdown();
```

---

## How do I send an email through a real SMTP server?

Use `SmtpMailProvider` with your SMTP settings; it wraps a nodemailer transport (created lazily, pooled internally) and resolves with the recipients the server accepted or rejected. Wrap `send()` in `try`/`catch`, because connection failures, authentication failures, and send rejections all throw.

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: {
        user: "notifications@example.com",
        pass: "smtp-secret",
    },
});

try {
    const result = await mailer.send({
        from: "notifications@example.com",
        to: "alice@example.com",
        subject: "Deployment finished",
        text: "Version 5.x has been deployed.",
        html: "<p>Version <strong>5.x</strong> has been deployed.</p>",
    });

    console.log(result.accepted);  // ["alice@example.com"]
    console.log(result.rejected);  // []
    console.log(result.messageId); // e.g. "<a1b2c3@smtp.example.com>"
} catch (error) {
    console.error("Send failed:", error instanceof Error ? error.message : String(error));
} finally {
    // Release the nodemailer connection pool
    await mailer.shutdown();
}
```

---

## How do I send to multiple recipients with CC and BCC?

Set `to`, `cc`, and `bcc` to either a single address string or an array of addresses — both backends normalize the values for you. `MemoryMailProvider` reports every recipient as accepted in `to → cc → bcc` order, while `SmtpMailProvider` joins arrays with commas for nodemailer and reports the addresses the server actually processed.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

const result = await mailer.send({
    from: "noreply@example.com",
    to: ["alice@example.com", "bob@example.com"],
    cc: "team@example.com",
    bcc: ["archive@example.com", "compliance@example.com"],
    subject: "Sprint review notes",
    text: "Please find the sprint review notes below.",
});

// All recipients — to, cc, and bcc — are reported as accepted
console.log(result.accepted);
// ["alice@example.com", "bob@example.com", "team@example.com", "archive@example.com", "compliance@example.com"]

await mailer.shutdown();
```

---

## How do I attach files to an email?

Add an `attachments` array to the `MailMessage`; each `MailAttachment` needs a `filename` and `content` — a `Buffer` for binary data or a base64-encoded string — plus an optional `contentType`. The SMTP backend forwards attachments to nodemailer unchanged, and the memory backend stores them for assertions.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { MailAttachment, MailMessage } from "blendsdk/webafx-mailer";

// Binary content as a Buffer
const invoice: MailAttachment = {
    filename: "invoice-1234.pdf",
    content: Buffer.from("%PDF-1.7 simulated invoice bytes", "utf8"),
    contentType: "application/pdf",
};

// ...or base64-encoded string content (here: a 1x1 transparent PNG)
const logo: MailAttachment = {
    filename: "logo.png",
    content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    contentType: "image/png",
};

const message: MailMessage = {
    from: "billing@example.com",
    to: "alice@example.com",
    subject: "Your invoice",
    text: "Please find your invoice attached.",
    attachments: [invoice, logo],
};

const mailer = new MemoryMailProvider();
await mailer.send(message);

const sent = mailer.getSentMessages();
console.log(sent[0].message.attachments?.length);          // 2
console.log(sent[0].message.attachments?.[0].filename);    // "invoice-1234.pdf"
console.log(sent[0].message.attachments?.[1].contentType); // "image/png"

await mailer.shutdown();
```

---

## How do I assert that an email was sent?

Use the `MemoryMailProvider` test helpers: `getSentMessages()` returns a snapshot of every `SentMailEntry` (the original `message` plus the `result` that `send()` returned), and `getLastMessage()` returns just the newest entry. Both are plain synchronous calls you can assert on — no SMTP server, Docker, or network access required.

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { SentMailEntry } from "blendsdk/webafx-mailer";

describe("welcome email", () => {
    let mailer: MemoryMailProvider;

    beforeEach(() => {
        mailer = new MemoryMailProvider();
    });

    afterEach(async () => {
        await mailer.shutdown();
    });

    it("should send a welcome email to the new user", async () => {
        await mailer.send({
            from: "noreply@example.com",
            to: "new-user@example.com",
            subject: "Welcome!",
            text: "Welcome to our service!",
        });

        const sent: SentMailEntry[] = mailer.getSentMessages();

        expect(sent).toHaveLength(1);
        expect(sent[0].message.subject).toBe("Welcome!");
        expect(sent[0].result.accepted).toContain("new-user@example.com");
    });

    it("should expose the latest email via getLastMessage()", async () => {
        await mailer.send({
            from: "noreply@example.com",
            to: "new-user@example.com",
            subject: "Welcome!",
            text: "Welcome to our service!",
        });

        const last = mailer.getLastMessage();

        expect(last).toBeDefined();
        expect(last?.message.subject).toBe("Welcome!");
    });
});
```

---

## How do I reset the in-memory mailer between tests?

Call `clear()` — it empties the in-memory store without touching the provider, so a single instance can serve a whole test file. After clearing, `getSentMessages()` returns `[]` and `getLastMessage()` returns `undefined`; `shutdown()` clears the store as well.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

describe("password reset flow", () => {
    const mailer = new MemoryMailProvider();

    beforeEach(() => {
        // Reset state between test cases — clears all stored messages
        mailer.clear();
    });

    it("should capture the password reset email", async () => {
        await mailer.send({
            from: "noreply@example.com",
            to: "alice@example.com",
            subject: "Password reset",
            text: "Use the link below to reset your password.",
        });

        expect(mailer.getSentMessages()).toHaveLength(1);
        expect(mailer.getLastMessage()?.message.subject).toBe("Password reset");
    });

    it("should start from an empty mailbox", () => {
        // clear() ran in beforeEach — nothing leaked from the previous test
        expect(mailer.getSentMessages()).toEqual([]);
        expect(mailer.getLastMessage()).toBeUndefined();
    });
});
```

---

## How do I unit-test a service that depends on a mailer?

Type the dependency as the abstract `MailProvider` and inject a `MemoryMailProvider` in tests — production code receives the real SMTP provider through the same constructor. The test then asserts on the captured messages via `getLastMessage()` or `getSentMessages()`.

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { MailProvider } from "blendsdk/webafx-mailer";

/** Application service — depends on the MailProvider abstraction only. */
class UserService {
    constructor(
        private readonly mailer: MailProvider,
        private readonly baseUrl: string
    ) {}

    async registerUser(email: string): Promise<void> {
        await this.mailer.send({
            from: "noreply@example.com",
            to: email,
            subject: "Welcome!",
            text: `Welcome! Confirm your address at ${this.baseUrl}/confirm`,
        });
    }
}

describe("UserService", () => {
    let mailer: MemoryMailProvider;
    let service: UserService;

    beforeEach(() => {
        mailer = new MemoryMailProvider();
        service = new UserService(mailer, "https://example.com");
    });

    afterEach(async () => {
        await mailer.shutdown();
    });

    it("should send a welcome email on registration", async () => {
        await service.registerUser("alice@example.com");

        const last = mailer.getLastMessage();

        expect(last?.message.to).toBe("alice@example.com");
        expect(last?.message.subject).toBe("Welcome!");
        expect(last?.message.text).toContain("https://example.com/confirm");
    });
});
```

---

## How do I configure a secure SMTP connection (STARTTLS vs. implicit TLS)?

Use port 587 with `secure: false` for STARTTLS (this is also the default when `secure` is omitted) and port 465 with `secure: true` for implicit TLS. Certificate validation is never disabled implicitly — for internal servers with self-signed certificates, opt out explicitly with `tls: { rejectUnauthorized: false }`.

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";
import type { SmtpMailConfig } from "blendsdk/webafx-mailer";

const credentials = { user: "notifications@example.com", pass: "smtp-secret" };

// 1. STARTTLS — port 587. Omitting `secure` is identical to setting it to false.
const startTlsConfig: SmtpMailConfig = {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: credentials,
};

// 2. Implicit TLS — port 465.
const implicitTlsConfig: SmtpMailConfig = {
    host: "smtp.example.com",
    port: 465,
    secure: true,
    auth: credentials,
};

// 3. Internal server with a self-signed certificate — validation is opt-out only.
const internalConfig: SmtpMailConfig = {
    host: "mail.internal.example.com",
    port: 587,
    auth: credentials,
    tls: { rejectUnauthorized: false },
};

const startTlsMailer = new SmtpMailProvider(startTlsConfig);
const implicitTlsMailer = new SmtpMailProvider(implicitTlsConfig);
const internalMailer = new SmtpMailProvider(internalConfig);

const result = await startTlsMailer.send({
    from: "notifications@example.com",
    to: "alice@example.com",
    subject: "TLS configuration check",
    text: "This message was sent over a STARTTLS connection.",
});

console.log(result.accepted); // ["alice@example.com"]

await startTlsMailer.shutdown();
await implicitTlsMailer.shutdown();
await internalMailer.shutdown();
```

---

## How do I check SMTP connectivity without sending an email?

Call `health()`: on the SMTP backend it runs nodemailer's `verify()`, an EHLO/HELO handshake that sends no email, and it never throws — an unreachable or misconfigured server simply yields `false`. The WebAFX plugin wires this same check into your application health endpoint automatically.

```typescript
import { MemoryMailProvider, SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "notifications@example.com", pass: "smtp-secret" },
});

const healthy: boolean = await mailer.health();

if (healthy) {
    console.log("SMTP server is reachable — safe to send.");
} else {
    console.error("SMTP server is unreachable — check host, port, and TLS settings.");
}

// The memory backend has no external dependencies, so health() is always true
const memoryMailer = new MemoryMailProvider();
console.log(await memoryMailer.health()); // true

await mailer.shutdown();
await memoryMailer.shutdown();
```

---

## How do I handle send failures and rejected recipients?

Handle both failure modes: connection failures, authentication failures, and total send failures make `send()` throw (wrap it in `try`/`catch`), while individual addresses the server refuses resolve normally in `result.rejected`. Check `rejected` even after a successful send so partial failures are not silently ignored.

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";
import type { MailResult } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "notifications@example.com", pass: "smtp-secret" },
});

try {
    const result: MailResult = await mailer.send({
        from: "notifications@example.com",
        to: ["alice@example.com", "bob@example.com"],
        subject: "Deployment finished",
        text: "Version 5.x has been deployed.",
    });

    if (result.rejected.length > 0) {
        console.warn("Some recipients were rejected:", result.rejected);
    }
    console.log("Delivered to:", result.accepted.join(", "));
} catch (error) {
    // Thrown for connection failures, authentication failures, and send rejections
    console.error("Send failed:", error instanceof Error ? error.message : String(error));
} finally {
    await mailer.shutdown();
}
```

---

## How do I shut down the mailer gracefully?

Call `shutdown()` when the application stops — the SMTP backend closes the nodemailer transport and its connection pool (later `send()` calls fail), and the memory backend clears its store. When the provider is registered through a plugin, WebAFX invokes `shutdown()` for you during graceful shutdown and service disposal.

```typescript
import { MemoryMailProvider, SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "notifications@example.com", pass: "smtp-secret" },
});

const result = await mailer.send({
    from: "notifications@example.com",
    to: "alice@example.com",
    subject: "Before shutdown",
    text: "This message is delivered normally.",
});

console.log(result.accepted); // ["alice@example.com"]

// Call during application shutdown — releases the nodemailer connection pool.
// Subsequent send() calls fail; create a new provider if you need to send again.
await mailer.shutdown();

// The memory backend clears its message store on shutdown
const memoryMailer = new MemoryMailProvider();

await memoryMailer.send({
    from: "noreply@example.com",
    to: "alice@example.com",
    subject: "Stored message",
    text: "Stored until shutdown.",
});

console.log(memoryMailer.getSentMessages().length); // 1

await memoryMailer.shutdown();

console.log(memoryMailer.getSentMessages().length); // 0
```

---

## How do I register the mailer in a WebAFX application?

Use the plugin factories: `smtpMailPlugin(config)` and `memoryMailPlugin(config?)` create the provider and return a `PluginDefinition` for `app.use()`, while `createMailPlugin(provider)` wraps an existing (including custom) provider. The plugin registers the provider as a singleton service under its `serviceName` (default `"mailer"`), exposes `health()` through the health endpoint, and runs `shutdown()` during graceful shutdown.

```typescript
import type { PluginDefinition } from "blendsdk/webafx";
import {
    createMailPlugin,
    MemoryMailProvider,
    memoryMailPlugin,
    smtpMailPlugin,
} from "blendsdk/webafx-mailer";

// Production: SMTP backend — one call creates the provider and wires it up
const productionPlugin: PluginDefinition = smtpMailPlugin({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "notifications@example.com", pass: "smtp-secret" },
});

// Development and CI: in-memory backend — identical registration shape
const developmentPlugin: PluginDefinition = memoryMailPlugin();

// Bring your own provider — any MailProvider instance works with createMailPlugin()
const auditProvider = new MemoryMailProvider({ serviceName: "audit-mailer" });
const auditPlugin: PluginDefinition = createMailPlugin(auditProvider, { priority: 10 });

// Each plugin uses the provider's serviceName as its registration key
console.log(productionPlugin.name);   // "mailer"
console.log(developmentPlugin.name);  // "mailer"
console.log(auditPlugin.name);        // "audit-mailer"
console.log(auditPlugin.priority);    // 10

// In your WebAFX application, register the plugin matching your environment:
//   app.use(productionPlugin);
//   app.use(developmentPlugin);
//
// WebAFX then resolves the provider under its serviceName and manages the
// provider lifecycle — health checks and shutdown() are called for you.
```

---

## How do I switch between the memory and SMTP backends per environment?

Pass a `MailFactoryConfig` with a `type` discriminator to `createMailProvider()` — `"smtp"` builds a `SmtpMailProvider`, `"memory"` builds a `MemoryMailProvider` — which makes `NODE_ENV`-based switching a one-liner. Any other runtime value throws `Unknown mail type: "...". Supported types: "smtp", "memory".` instead of failing silently.

```typescript
import { createMailPlugin, createMailProvider } from "blendsdk/webafx-mailer";
import type { MailFactoryConfig, MailProvider } from "blendsdk/webafx-mailer";

const config: MailFactoryConfig = {
    type: process.env.NODE_ENV === "production" ? "smtp" : "memory",
    // serviceName is optional — it defaults to "mailer"
    host: process.env.SMTP_HOST ?? "smtp.example.com",
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: false,
    auth: {
        user: process.env.SMTP_USER ?? "notifications@example.com",
        pass: process.env.SMTP_PASS ?? "smtp-secret",
    },
};

// "smtp" → SmtpMailProvider; "memory" → MemoryMailProvider (SMTP fields ignored)
const mailer: MailProvider = createMailProvider(config);

// Wrap the provider for WebAFX, or use it standalone — both work
const plugin = createMailPlugin(mailer);
console.log(plugin.name); // "mailer"

const result = await mailer.send({
    from: "notifications@example.com",
    to: "alice@example.com",
    subject: "Environment check",
    text: `Using the "${config.type}" mail backend.`,
});

console.log(result.accepted);

await mailer.shutdown();
```

An invalid type — for example from a typo in a config file or an environment variable — is caught immediately:

```typescript
import { createMailProvider } from "blendsdk/webafx-mailer";

try {
    // Simulates an invalid value arriving at runtime (TypeScript cannot catch it)
    createMailProvider({ type: "sendgrid" as "smtp" });
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    // Unknown mail type: "sendgrid". Supported types: "smtp", "memory".
}
```

---

## How do I run more than one mailer in the same application?

Give each provider a distinct `serviceName` and register one plugin per mailer — the service name is the registration key, so a transactional mailer and a marketing mailer coexist without colliding. Optional `priority` values control plugin installation order when it matters.

```typescript
import type { PluginDefinition } from "blendsdk/webafx";
import { createMailPlugin, memoryMailPlugin, SmtpMailProvider } from "blendsdk/webafx-mailer";

// Transactional mailer — password resets, receipts
const transactionalMailer = new SmtpMailProvider({
    serviceName: "transactional-mailer",
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "transactional@example.com", pass: "smtp-secret" },
});

// Marketing mailer — one-liner variant with the in-memory backend
const marketingPlugin: PluginDefinition = memoryMailPlugin({ serviceName: "marketing-mailer" });

const transactionalPlugin: PluginDefinition = createMailPlugin(transactionalMailer, {
    priority: 10, // install before the marketing mailer
});

console.log(transactionalPlugin.name);     // "transactional-mailer"
console.log(transactionalPlugin.priority); // 10
console.log(marketingPlugin.name);         // "marketing-mailer"
console.log(marketingPlugin.priority);     // 30 (default)

// In your WebAFX application, register both — each provider is a singleton
// under its own serviceName, and WebAFX manages their lifecycles:
//   app.use(transactionalPlugin);
//   app.use(marketingPlugin);
```

---

## How do I write a custom mail provider?

Extend the abstract `MailProvider` class and implement `send()`, `health()`, and `shutdown()` — that is the whole contract. Your subclass composes with the rest of the package: use it standalone or wrap it with `createMailPlugin()` like any built-in provider.

```typescript
import { MailProvider } from "blendsdk/webafx-mailer";
import type { MailMessage, MailProviderConfig, MailResult } from "blendsdk/webafx-mailer";

/** Custom provider config extends the shared base with API-specific settings. */
interface HttpApiMailConfig extends MailProviderConfig {
    apiUrl: string;
    apiKey: string;
}

/**
 * A custom backend that delivers mail by POSTing to an HTTP API instead
 * of talking SMTP. Any MailProvider subclass is a valid plugin citizen.
 */
class HttpApiMailProvider extends MailProvider {
    private readonly apiUrl: string;
    private readonly apiKey: string;

    constructor(config: HttpApiMailConfig) {
        super(config);
        this.apiUrl = config.apiUrl;
        this.apiKey = config.apiKey;
    }

    async send(message: MailMessage): Promise<MailResult> {
        // Map the fields your API expects (attachments would go through
        // your API's own upload flow rather than this JSON payload).
        const response = await fetch(this.apiUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                from: message.from,
                to: message.to,
                cc: message.cc,
                bcc: message.bcc,
                subject: message.subject,
                text: message.text,
                html: message.html,
            }),
        });

        if (!response.ok) {
            throw new Error(`Mail API responded with status ${response.status}`);
        }

        const data: { id: string } = await response.json();
        const to = Array.isArray(message.to) ? message.to : [message.to];

        return {
            accepted: to,
            rejected: [],
            messageId: data.id,
        };
    }

    async health(): Promise<boolean> {
        try {
            const response = await fetch(`${this.apiUrl}/health`);
            return response.ok;
        } catch {
            return false;
        }
    }

    async shutdown(): Promise<void> {
        // Nothing to release — this backend holds no persistent connections.
    }
}

const mailer = new HttpApiMailProvider({
    serviceName: "http-mailer",
    apiUrl: "https://mail-api.example.com/send",
    apiKey: "mail-api-secret",
});

const result = await mailer.send({
    from: "noreply@example.com",
    to: "alice@example.com",
    subject: "Welcome!",
    text: "Welcome to our service!",
});

console.log(mailer.serviceName); // "http-mailer"
console.log(result.accepted);    // ["alice@example.com"]
console.log(result.messageId);   // server-assigned ID

await mailer.shutdown();
```

---

*Related reading: Overview, Core Concepts, and Basic Usage.*

---

# webafx-mailer Examples Library

A collection of complete, copy-paste-ready examples covering every feature area of `blendsdk/webafx-mailer`. Each example includes all required imports, compiles under strict TypeScript, and runs on Node.js >= 22 with ESM (top-level `await` is used throughout for brevity). For conceptual background, see the Overview and Core Concepts; for guided setup, see Basic Usage.

| Category | Covers |
|----------|--------|
| Getting Started | Minimal end-to-end flows for both backends |
| Message Composition | Bodies, recipients, CC/BCC, attachments |
| Testing with the Memory Backend | Assertions, message history, test fixtures |
| SMTP Configuration and Lifecycle | STARTTLS, implicit TLS, unauthenticated servers, health, errors, shutdown |
| WebAFX Plugin Integration | `memoryMailPlugin()`, `smtpMailPlugin()`, `createMailPlugin()`, multiple mailers |
| Runtime Backend Selection | `createMailProvider()` by environment, invalid-type errors |
| Custom Providers | Extending `MailProvider`, composing providers |

---

## Getting Started

Two minimal end-to-end flows — one per backend. Both follow the same provider lifecycle: construct, send, inspect the result, shut down.

### Send an Email with the Memory Backend

The fastest way to see the provider contract in action. Nothing leaves the process: the message is stored in memory and fully inspectable via the returned result and the test helpers.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

const result = await mailer.send({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Welcome!",
    text: "Welcome to our service!",
    html: "<h1>Welcome to our service!</h1>",
});

console.log(result.accepted);  // ["user@example.com"]
console.log(result.rejected);  // []
console.log(result.messageId); // e.g. "<memory-1729512345678-0@test>"

console.log(mailer.getSentMessages().length); // 1

await mailer.shutdown();
```

### Send an Email over SMTP

The production flow: `SmtpMailProvider` delivers through nodemailer. Substitute your own SMTP settings; `secure: false` on port `587` is the modern STARTTLS default.

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: {
        user: "notifications@example.com",
        pass: "smtp-secret",
    },
});

const result = await mailer.send({
    from: "notifications@example.com",
    to: "user@example.com",
    subject: "Welcome!",
    text: "Welcome to our service!",
});

console.log(result.accepted);  // ["user@example.com"] — confirmed by the SMTP server
console.log(result.rejected);  // []
console.log(result.messageId); // e.g. "<a1b2c3d4@smtp.example.com>"

await mailer.shutdown();
```

---

## Message Composition

Everything that goes into a `MailMessage`: bodies, recipient lists, and attachments. All examples use `MemoryMailProvider` so they run with no infrastructure — the same messages work unchanged against `SmtpMailProvider`.

### Send a Plain-Text Email

The minimal message: `from`, `to`, `subject`, and a `text` body.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { MailMessage } from "blendsdk/webafx-mailer";

const message: MailMessage = {
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Your daily digest",
    text: "Here is your daily digest.\n\n- 3 new comments\n- 1 new follower",
};

const mailer = new MemoryMailProvider();
const result = await mailer.send(message);

console.log(result.accepted); // ["user@example.com"]

await mailer.shutdown();
```

### Send an HTML Email with a Plain-Text Fallback

When both `html` and `text` are set, `text` acts as the fallback for clients that do not render HTML. Both bodies are preserved on the stored message.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { MailMessage } from "blendsdk/webafx-mailer";

const message: MailMessage = {
    from: "newsletter@example.com",
    to: "subscriber@example.com",
    subject: "This week at Example",
    text: "This week: new features, new docs, new SDK. Read online: https://example.com/news/42",
    html: `
        <h1>This week at Example</h1>
        <ul>
            <li>New features</li>
            <li>New docs</li>
            <li>New SDK</li>
        </ul>
        <p><a href="https://example.com/news/42">Read online</a></p>
    `,
};

const mailer = new MemoryMailProvider();
await mailer.send(message);

const stored = mailer.getLastMessage();
console.log(stored?.message.text !== undefined); // true — fallback body preserved
console.log(stored?.message.html !== undefined); // true — HTML body preserved

await mailer.shutdown();
```

### Send to Multiple Recipients with CC and BCC

`to`, `cc`, and `bcc` each accept a single address string or an array of addresses. The memory backend reports every recipient as accepted, in `to → cc → bcc` order.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

const result = await mailer.send({
    from: "release-bot@example.com",
    to: ["alice@example.com", "bob@example.com"],
    cc: ["carol@example.com"],
    bcc: "audit@example.com",
    subject: "Release 5.x deployed",
    text: "Version 5.x was deployed successfully.",
});

console.log(result.accepted);
// ["alice@example.com", "bob@example.com", "carol@example.com", "audit@example.com"]
console.log(result.rejected); // []

await mailer.shutdown();
```

### Attach a File from a Buffer

Binary attachment content is passed as a `Buffer`; the optional `contentType` tells the mail client how to treat the file.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { MailAttachment } from "blendsdk/webafx-mailer";

const csvReport: MailAttachment = {
    filename: "users-export.csv",
    content: Buffer.from("id,name\n1,Alice\n2,Bob\n", "utf8"),
    contentType: "text/csv",
};

const mailer = new MemoryMailProvider();

await mailer.send({
    from: "reports@example.com",
    to: "analyst@example.com",
    subject: "Nightly user export",
    text: "The nightly user export is attached.",
    attachments: [csvReport],
});

const sent = mailer.getLastMessage();
const attachment = sent?.message.attachments?.[0];
console.log(sent?.message.attachments?.length); // 1
console.log(attachment?.filename);              // "users-export.csv"
console.log(attachment?.contentType);           // "text/csv"

await mailer.shutdown();
```

### Attach a File as a Base64-Encoded String

Attachment content can also be a base64-encoded string — convenient when the data comes from an API response or a database column.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

// A 1x1 transparent PNG, base64-encoded
const transparentPng =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const mailer = new MemoryMailProvider();

await mailer.send({
    from: "hello@example.com",
    to: "user@example.com",
    subject: "Brand assets",
    text: "The logo is attached.",
    attachments: [
        {
            filename: "logo.png",
            content: transparentPng,
            contentType: "image/png",
        },
    ],
});

const last = mailer.getLastMessage();
const logo = last?.message.attachments?.[0];
console.log(logo?.filename);    // "logo.png"
console.log(logo?.contentType); // "image/png"

await mailer.shutdown();
```

---

## Testing with the Memory Backend

`MemoryMailProvider` is built for tests: every send is captured, message history is inspectable, and `clear()` / `shutdown()` give each test case a clean slate. `health()` always reports `true`, so the assertion helpers are the only thing to learn.

### Assert on Sent Messages with getSentMessages()

`getSentMessages()` returns every captured entry — the original message plus the result `send()` produced. The returned array is a shallow copy, so mutating it never corrupts the store.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { SentMailEntry } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

await mailer.send({
    from: "noreply@example.com",
    to: "alice@example.com",
    subject: "Password reset",
    text: "Use the link below to reset your password.",
});

const sent: SentMailEntry[] = mailer.getSentMessages();

console.log(sent.length);             // 1
console.log(sent[0].message.subject); // "Password reset"
console.log(sent[0].result.accepted); // ["alice@example.com"]

// Shallow copy: mutating the returned array does not affect the store
sent.length = 0;
console.log(mailer.getSentMessages().length); // 1

await mailer.shutdown();
```

### Inspect the Last Sent Message with getLastMessage()

For single-email flows, `getLastMessage()` returns the most recent entry — or `undefined` when nothing has been sent yet.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

console.log(mailer.getLastMessage()); // undefined — nothing sent yet

await mailer.send({
    from: "noreply@example.com",
    to: "alice@example.com",
    subject: "First",
    text: "First message",
});
await mailer.send({
    from: "noreply@example.com",
    to: "bob@example.com",
    subject: "Second",
    text: "Second message",
});

const last = mailer.getLastMessage();
console.log(last?.message.subject); // "Second"
console.log(last?.result.accepted); // ["bob@example.com"]

await mailer.shutdown();
```

### Reset Between Test Cases with clear()

`clear()` empties the message store without touching anything else — the standard way to isolate test cases that share a provider instance.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

await mailer.send({
    from: "noreply@example.com",
    to: "alice@example.com",
    subject: "Before reset",
    text: "Old message",
});
await mailer.send({
    from: "noreply@example.com",
    to: "bob@example.com",
    subject: "Before reset (again)",
    text: "Another old message",
});

console.log(mailer.getSentMessages().length); // 2

mailer.clear();

console.log(mailer.getSentMessages().length); // 0
console.log(mailer.getLastMessage());         // undefined

// Sending after clear() starts a fresh history
await mailer.send({
    from: "noreply@example.com",
    to: "carol@example.com",
    subject: "After reset",
    text: "New message",
});
console.log(mailer.getSentMessages()[0].message.subject); // "After reset"

await mailer.shutdown();
```

### Use MemoryMailProvider in a Vitest Suite

The canonical testing setup: one provider per test case, assertions on the captured messages. This is the same pattern the package's own test suite uses.

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

describe("welcome email flow", () => {
    let mailer: MemoryMailProvider;

    beforeEach(() => {
        mailer = new MemoryMailProvider();
    });

    afterEach(async () => {
        await mailer.shutdown();
    });

    async function sendWelcomeEmail(address: string): Promise<void> {
        await mailer.send({
            from: "noreply@example.com",
            to: address,
            subject: "Welcome to Example!",
            text: "Thanks for signing up.",
        });
    }

    it("sends exactly one email per signup", async () => {
        await sendWelcomeEmail("alice@example.com");

        expect(mailer.getSentMessages()).toHaveLength(1);
    });

    it("addresses the email to the new user", async () => {
        await sendWelcomeEmail("alice@example.com");

        const last = mailer.getLastMessage();
        expect(last?.message.to).toBe("alice@example.com");
        expect(last?.result.accepted).toContain("alice@example.com");
        expect(last?.message.subject).toBe("Welcome to Example!");
    });

    it("starts with a clean store for every test case", () => {
        expect(mailer.getSentMessages()).toHaveLength(0);
        expect(mailer.getLastMessage()).toBeUndefined();
    });
});

// vitest run
// ✓ welcome email flow > sends exactly one email per signup
// ✓ welcome email flow > addresses the email to the new user
// ✓ welcome email flow > starts with a clean store for every test case
```

---

## SMTP Configuration and Lifecycle

Real delivery through nodemailer. The examples cover the common connection setups, health probing, failure handling, and connection-pool shutdown. Substitute `smtp.example.com` with your own server; the Mailpit example additionally requires a local Mailpit container.

### Configure STARTTLS on Port 587

The modern default: the connection starts in plaintext and is upgraded to TLS by the server. `secure: false` is correct here — and is also the built-in default when omitted.

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false, // STARTTLS upgrade — do NOT set `true` for port 587
    auth: {
        user: "notifications@example.com",
        pass: "smtp-secret",
    },
});

const result = await mailer.send({
    from: "notifications@example.com",
    to: "user@example.com",
    subject: "STARTTLS delivery",
    text: "This message was sent over a STARTTLS connection.",
});

console.log(result.accepted); // ["user@example.com"]

await mailer.shutdown();
```

### Configure Implicit TLS on Port 465

When the whole connection is TLS from the first byte (port 465), set `secure: true`. The `tls` block is forwarded to nodemailer as-is; certificate validation is enabled by default.

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 465,
    secure: true, // implicit TLS from the start
    auth: {
        user: "notifications@example.com",
        pass: "smtp-secret",
    },
    tls: {
        // Forwarded to nodemailer as-is. Validation is on by default —
        // set `rejectUnauthorized: false` only for self-signed dev servers.
        rejectUnauthorized: true,
    },
});

const healthy = await mailer.health();
console.log(healthy); // true once the TLS handshake and EHLO/HELO succeed

await mailer.shutdown();
```

### Connect to an Unauthenticated SMTP Server

Fake SMTP servers such as Mailpit accept anything: no `auth` block is needed, and no TLS is required. This is the exact configuration the package's integration tests use.

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

// Start Mailpit first (SMTP on :1025, web UI + API on :8025):
//   docker run --rm -p 1025:1025 -p 8025:8025 axllent/mailpit
const mailer = new SmtpMailProvider({
    host: "localhost",
    port: 1025,
    secure: false,
});

const result = await mailer.send({
    from: "sender@test.com",
    to: "recipient@test.com",
    subject: "Local Mailpit test",
    text: "Captured by Mailpit — not delivered to the internet.",
});

console.log(result.accepted); // ["recipient@test.com"]

await mailer.shutdown();

// Inspect the captured message in the Mailpit web UI at http://localhost:8025
```

### Health-Check the SMTP Connection

`health()` runs nodemailer's `verify()` — a full EHLO/HELO handshake that sends no email. It never throws: any failure (unreachable host, bad credentials) resolves to `false`.

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "notifications@example.com", pass: "smtp-secret" },
});

if (await mailer.health()) {
    console.log("SMTP connection is operational.");
} else {
    console.log("SMTP server unreachable — check host, port, and credentials.");
}

await mailer.shutdown();

// A provider pointed at a wrong port reports `false` instead of throwing
const misconfigured = new SmtpMailProvider({ host: "localhost", port: 19999, secure: false });
console.log(await misconfigured.health()); // false
await misconfigured.shutdown();
```

### Handle Send Failures and Shut Down Gracefully

`send()` throws on connection failures, authentication failures, and server-side rejections — so wrap it in `try`/`catch`. `shutdown()` closes the nodemailer connection pool; after it runs, further `send()` calls fail.

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "notifications@example.com", pass: "smtp-secret" },
});

try {
    const result = await mailer.send({
        from: "notifications@example.com",
        to: "user@example.com",
        subject: "Order shipped",
        text: "Your order has shipped.",
    });

    console.log(result.accepted); // ["user@example.com"]
} catch (error) {
    // Connection failures, auth failures, and send rejections all land here
    console.error("Sending failed:", error instanceof Error ? error.message : String(error));
} finally {
    // Release the connection pool — send() calls after this will fail
    await mailer.shutdown();
}
```

---

## WebAFX Plugin Integration

Factory functions that register a mailer in a WebAFX application as an application-wide singleton service, hook its `health()` into the `/health` endpoint, and run its `shutdown()` during graceful shutdown. Every factory returns a `PluginDefinition` that your application setup passes to `app.use(...)`.

### Create a WebAFX Mail Plugin with the Memory Backend

`memoryMailPlugin()` is the one-liner for development and test setups: it creates a `MemoryMailProvider` and wraps it in a plugin. Pass a `serviceName` to give the mailer a different registration key.

```typescript
import { memoryMailPlugin } from "blendsdk/webafx-mailer";
import type { PluginDefinition } from "blendsdk/webafx";

// One-liner: creates a MemoryMailProvider wrapped in a PluginDefinition.
// Registering it makes the mailer the "mailer" singleton service, feeds
// health() into /health, and runs shutdown() during graceful shutdown.
const plugin: PluginDefinition = memoryMailPlugin();

console.log(plugin.name);     // "mailer"
console.log(plugin.priority); // 30

// Custom service name — useful when the app registers several mailers
const namedPlugin: PluginDefinition = memoryMailPlugin({ serviceName: "dev-mailer" });
console.log(namedPlugin.name); // "dev-mailer"

// In your WebAFX application setup:
//   app.use(plugin);
```

### Create a WebAFX Mail Plugin with an SMTP Backend

`smtpMailPlugin()` builds an `SmtpMailProvider` from your config and wires it in. Creating the plugin does not open a connection — the transport connects lazily on the first `send()`.

```typescript
import { smtpMailPlugin } from "blendsdk/webafx-mailer";
import type { PluginDefinition } from "blendsdk/webafx";

const plugin: PluginDefinition = smtpMailPlugin({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: {
        user: "notifications@example.com",
        pass: "smtp-secret",
    },
});

console.log(plugin.name);     // "mailer"
console.log(plugin.priority); // 30

// In your WebAFX application setup:
//   app.use(plugin);
```

### Wire a Custom Provider with createMailPlugin()

`createMailPlugin()` accepts any `MailProvider` instance — including your own subclasses — plus an optional priority override.

```typescript
import { MemoryMailProvider, createMailPlugin } from "blendsdk/webafx-mailer";
import type { PluginDefinition } from "blendsdk/webafx";

const provider = new MemoryMailProvider({ serviceName: "transactional-mailer" });

// The plugin name comes from provider.serviceName; priority defaults to 30
const plugin: PluginDefinition = createMailPlugin(provider, { priority: 10 });

console.log(plugin.name);     // "transactional-mailer"
console.log(plugin.priority); // 10

// In your WebAFX application setup:
//   app.use(plugin);
```

### Register Multiple Mailers in One Application

Give every mailer a distinct `serviceName` to register several providers in a single application — for example, a transactional mailer and a marketing mailer.

```typescript
import {
    MemoryMailProvider,
    createMailPlugin,
    memoryMailPlugin,
    smtpMailPlugin,
} from "blendsdk/webafx-mailer";
import type { PluginDefinition } from "blendsdk/webafx";

const transactional: PluginDefinition = smtpMailPlugin({
    host: "smtp.example.com",
    port: 587,
    auth: { user: "transactions@example.com", pass: "smtp-secret" },
    serviceName: "transactional-mailer",
});

const marketing: PluginDefinition = memoryMailPlugin({ serviceName: "marketing-mailer" });

const system: PluginDefinition = createMailPlugin(
    new MemoryMailProvider({ serviceName: "system-mailer" }),
    { priority: 10 }
);

console.log(transactional.name); // "transactional-mailer"
console.log(marketing.name);     // "marketing-mailer"
console.log(system.name);        // "system-mailer"

// In your WebAFX application setup:
//   app.use(transactional);
//   app.use(marketing);
//   app.use(system);
```

---

## Runtime Backend Selection

`createMailProvider()` builds the right backend from a single config object with a `type` discriminator — the recommended pattern for switching between SMTP and in-memory per environment.

### Switch Backends by Environment

One config object, two behaviors: SMTP in production, in-memory everywhere else. The returned provider is a plain `MailProvider`, so it composes with `createMailPlugin()` or works standalone.

```typescript
import { createMailPlugin, createMailProvider } from "blendsdk/webafx-mailer";
import type { MailFactoryConfig, MailProvider } from "blendsdk/webafx-mailer";
import type { PluginDefinition } from "blendsdk/webafx";

const config: MailFactoryConfig = {
    type: process.env.NODE_ENV === "production" ? "smtp" : "memory",
    serviceName: "mailer",
    host: process.env.SMTP_HOST ?? "smtp.example.com",
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: false,
    auth: {
        user: process.env.SMTP_USER ?? "notifications@example.com",
        pass: process.env.SMTP_PASS ?? "smtp-secret",
    },
};

const mailer: MailProvider = createMailProvider(config);
console.log(mailer.constructor.name);
// "SmtpMailProvider" when NODE_ENV === "production"
// "MemoryMailProvider" otherwise

// Full WebAFX integration from the same provider instance
const plugin: PluginDefinition = createMailPlugin(mailer);
console.log(plugin.name); // "mailer"

// In your WebAFX application setup:
//   app.use(plugin);

// Standalone usage (no WebAFX) works identically
try {
    const result = await mailer.send({
        from: "noreply@example.com",
        to: "user@example.com",
        subject: "Backend check",
        text: `Running with NODE_ENV=${process.env.NODE_ENV ?? "development"}.`,
    });

    console.log(result.accepted); // ["user@example.com"] — memory backend reports all recipients as accepted
} catch (error) {
    console.error("Send failed:", error instanceof Error ? error.message : String(error));
} finally {
    await mailer.shutdown();
}
```

### Catch Unknown Backend Types Early

Any `type` outside `"smtp" | "memory"` fails fast with a descriptive error — catching config typos or bad environment variables that TypeScript cannot see at compile time.

```typescript
import { createMailProvider } from "blendsdk/webafx-mailer";

try {
    // Simulates an invalid value arriving at runtime (e.g., from a config
    // file); the cast bypasses compile-time checking the way real input would
    createMailProvider({ type: "sendgrid" as "smtp" });
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    // Unknown mail type: "sendgrid". Supported types: "smtp", "memory".
}
```

---

## Custom Providers

Any subclass of `MailProvider` that implements `send()`, `health()`, and `shutdown()` is a first-class backend: the plugin factories accept it, it can wrap other providers, and it can be wrapped itself.

### Build a Logging MailProvider

A custom provider that logs every send before delegating storage to a wrapped `MemoryMailProvider` — the template for instrumentation, auditing, or routing layers.

```typescript
import { MailProvider, MemoryMailProvider, createMailPlugin } from "blendsdk/webafx-mailer";
import type {
    MailMessage,
    MailProviderConfig,
    MailResult,
    SentMailEntry,
} from "blendsdk/webafx-mailer";

/**
 * A custom MailProvider that logs every send before delegating storage to a
 * wrapped MemoryMailProvider. Implementing send(), health(), and shutdown()
 * is all it takes for a subclass to be a valid MailProvider.
 */
class LoggingMailProvider extends MailProvider {
    private readonly inner: MemoryMailProvider;

    constructor(config: MailProviderConfig = {}) {
        super(config);
        this.inner = new MemoryMailProvider();
    }

    async send(message: MailMessage): Promise<MailResult> {
        const recipients = Array.isArray(message.to) ? message.to.join(", ") : message.to;
        console.log(`[mail] sending "${message.subject}" to ${recipients}`);
        return this.inner.send(message);
    }

    async health(): Promise<boolean> {
        return this.inner.health();
    }

    async shutdown(): Promise<void> {
        await this.inner.shutdown();
    }

    /** Expose the wrapped provider's captured messages for inspection */
    getSentMessages(): SentMailEntry[] {
        return this.inner.getSentMessages();
    }
}

const mailer = new LoggingMailProvider({ serviceName: "audited-mailer" });
console.log(mailer.serviceName); // "audited-mailer"

const result = await mailer.send({
    from: "noreply@example.com",
    to: ["alice@example.com", "bob@example.com"],
    subject: "Welcome!",
    text: "Welcome to our service!",
});
// [mail] sending "Welcome!" to alice@example.com, bob@example.com

console.log(result.accepted);                 // ["alice@example.com", "bob@example.com"]
console.log(mailer.getSentMessages().length); // 1

// Custom providers wire into WebAFX exactly like the built-in ones
const plugin = createMailPlugin(mailer);
console.log(plugin.name); // "audited-mailer"

await mailer.shutdown();
```

### Add Retry Logic by Composing Providers

Compose a retry wrapper around any provider to survive transient delivery failures — then register it with `createMailPlugin()` like any other backend. The demo uses an in-process flaky provider so the retries are visible without a real SMTP server.

```typescript
import { setTimeout as delay } from "node:timers/promises";

import { MailProvider, createMailPlugin } from "blendsdk/webafx-mailer";
import type { MailMessage, MailProviderConfig, MailResult } from "blendsdk/webafx-mailer";

/**
 * Wraps another MailProvider and retries failed sends with a fixed delay.
 * Compose it around any backend, e.g.:
 *   new RetryMailProvider(new SmtpMailProvider(smtpConfig), { maxAttempts: 5 })
 */
class RetryMailProvider extends MailProvider {
    private readonly inner: MailProvider;
    private readonly maxAttempts: number;
    private readonly delayMs: number;

    constructor(
        inner: MailProvider,
        options: { serviceName?: string; maxAttempts?: number; delayMs?: number } = {}
    ) {
        super({ serviceName: options.serviceName });
        this.inner = inner;
        this.maxAttempts = options.maxAttempts ?? 3;
        this.delayMs = options.delayMs ?? 500;
    }

    async send(message: MailMessage): Promise<MailResult> {
        let lastError = new Error("Send was never attempted.");

        for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
            try {
                return await this.inner.send(message);
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                console.warn(
                    `Attempt ${attempt}/${this.maxAttempts} failed: ${lastError.message}`
                );
                if (attempt < this.maxAttempts) {
                    await delay(this.delayMs);
                }
            }
        }

        throw lastError;
    }

    async health(): Promise<boolean> {
        return this.inner.health();
    }

    async shutdown(): Promise<void> {
        await this.inner.shutdown();
    }
}

/** Demo backend that fails the first two send attempts, then succeeds. */
class FlakyMailProvider extends MailProvider {
    private attempts = 0;

    constructor(config: MailProviderConfig = {}) {
        super(config);
    }

    async send(message: MailMessage): Promise<MailResult> {
        this.attempts += 1;

        if (this.attempts < 3) {
            throw new Error(`Simulated transient failure (attempt ${this.attempts})`);
        }

        const accepted = Array.isArray(message.to) ? message.to : [message.to];
        return { accepted, rejected: [], messageId: `<flaky-${this.attempts}@test>` };
    }

    async health(): Promise<boolean> {
        return true;
    }

    async shutdown(): Promise<void> {
        // No resources to release in this demo provider
    }
}

const mailer = new RetryMailProvider(new FlakyMailProvider(), {
    serviceName: "resilient-mailer",
    maxAttempts: 3,
    delayMs: 100,
});

// Register it like any other provider
const plugin = createMailPlugin(mailer);
console.log(plugin.name); // "resilient-mailer"

const result = await mailer.send({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Retry demo",
    text: "This send succeeds on the third attempt.",
});

// Attempt 1/3 failed: Simulated transient failure (attempt 1)
// Attempt 2/3 failed: Simulated transient failure (attempt 2)
console.log(result.accepted);  // ["user@example.com"]
console.log(result.messageId); // "<flaky-3@test>"

await mailer.shutdown();
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
