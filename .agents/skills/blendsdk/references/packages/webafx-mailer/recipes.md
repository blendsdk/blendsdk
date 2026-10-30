> **Package**: `blendsdk/webafx-mailer`

# webafx-mailer Advanced Patterns

---

This document covers advanced composition patterns for `blendsdk/webafx-mailer` — the scenarios where a single `provider.send()` call is not the whole story. Each pattern combines several package features (the `MailProvider` abstraction, both backends, and the WebAFX plugin factories) into a reusable solution for a concrete problem.

Familiarity with the `MailProvider` contract, `SmtpMailProvider` / `MemoryMailProvider`, and the plugin factories is assumed; see Core Concepts for the fundamentals. Complete examples import only from the package root and Node.js built-ins. WebAFX application bootstrap code appears in `typescript fragment` blocks, since it lives inside a running application rather than a standalone script.

---

## Pattern Index

| # | Pattern | Problem It Solves | Key Exports |
| --- | --- | --- | --- |
| 1 | [Environment-Driven Backend Switching](#pattern-1-environment-driven-backend-switching) | SMTP in production, memory in dev/test/CI, decided once | `createMailProvider`, `MailFactoryConfig` |
| 2 | [Multiple Named Mailers](#pattern-2-multiple-named-mailers) | Transactional and marketing mail with separate relays and reputations | `serviceName`, `createMailPlugin` |
| 3 | [Custom Backends via Subclassing](#pattern-3-custom-backends-via-subclassing) | New transports (audit logs, HTTP APIs) without forking the package | `MailProvider`, `createMailPlugin` |
| 4 | [Deterministic Email Testing](#pattern-4-deterministic-email-testing) | Assert on sent email with zero infrastructure | `MemoryMailProvider`, `SentMailEntry` |
| 5 | [Resilient Sends with Bounded Retries](#pattern-5-resilient-sends-with-bounded-retries) | Surviving transient SMTP failures | `send`, `health` |
| 6 | [Batch Fan-Out with Per-Recipient Accounting](#pattern-6-batch-fan-out-with-per-recipient-accounting) | Personalized notifications at scale, with a delivery report | `send`, `MailResult` |
| 7 | [Standalone Lifecycle Management](#pattern-7-standalone-lifecycle-management) | Graceful shutdown and cheap health checks in plain Node services | `health`, `shutdown`, `serviceName` |

---

## Pattern 1: Environment-Driven Backend Switching

### When to Use This Pattern

- The same codebase must deliver real email in production but capture email in development, test, and CI.
- Backend configuration arrives from environment variables (or a config service) that differ per environment.
- You want a single, explicit, fail-fast decision point instead of scattered `NODE_ENV` checks.

### Complete Example

The `MailFactoryConfig` type discriminator (`"smtp" | "memory"`) turns the environment decision into one configuration object that `createMailProvider()` maps to a concrete provider:

```typescript
import {
    createMailProvider,
    type MailFactoryConfig,
    type MailProvider,
} from "blendsdk/webafx-mailer";

/** Read a required environment variable or fail with a clear message. */
function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

/**
 * Environment-driven mailer factory.
 * Production uses SMTP; dev, test, and CI capture mail in memory.
 */
function buildMailer(): MailProvider {
    const isProduction = process.env.NODE_ENV === "production";

    const config: MailFactoryConfig = isProduction
        ? {
              type: "smtp",
              host: requireEnv("SMTP_HOST"),
              port: Number(process.env.SMTP_PORT ?? "587"),
              secure: process.env.SMTP_SECURE === "true",
              auth: {
                  user: requireEnv("SMTP_USER"),
                  pass: requireEnv("SMTP_PASS"),
              },
          }
        : {
              type: "memory",
              serviceName: "dev-mailer",
          };

    const mailer = createMailProvider(config);
    console.log(`Mailer "${mailer.serviceName}" created for the ${config.type} backend`);
    return mailer;
}

const mailer = buildMailer();

const result = await mailer.send({
    from: "noreply@example.com",
    to: "customer@example.com",
    subject: "Your order shipped",
    text: "Your order is on its way.",
});

console.log("Accepted:", result.accepted);
console.log("Message ID:", result.messageId);

await mailer.shutdown();
```

Running with `NODE_ENV` unset produces the memory backend and prints something like:

```text
Mailer "dev-mailer" created for the memory backend
Accepted: [ 'customer@example.com' ]
Message ID: <memory-1732000000000-0@test>
```

### Why This Pattern Matters

Without a factory, the environment decision is duplicated at every construction site, and missing configuration only surfaces when the first email fails to send:

```typescript fragment
// ✗ Before — the decision leaks everywhere and nothing validates the config:
const mailer =
    process.env.NODE_ENV === "production"
        ? new SmtpMailProvider({ host: "smtp.example.com", port: 587 })
        : new MemoryMailProvider();
```

`createMailProvider()` collapses that decision into one place. In a WebAFX application the resulting provider is registered exactly like a hand-built one — the environment logic never leaves the bootstrap module:

```typescript fragment
// WebAFX bootstrap — the backend was selected once, at startup:
app.use(createMailPlugin(buildMailer()));
```

### Caveats and Performance Notes

- **Validate before constructing.** `createMailProvider()` forwards `host` and `port` to the SMTP transport without validating them. An empty `SMTP_HOST` produces a provider that fails on its first `send()`; the `requireEnv()` helper turns that into a startup error instead.
- **Unknown types fail fast.** If `type` comes from untyped JSON or a bad environment value, the factory throws `Unknown mail type: "<value>". Supported types: "smtp", "memory".` — catch it during bootstrap, not on the first request.
- **The memory branch ignores SMTP fields.** When `type: "memory"`, `host`/`port`/`auth` are never read, so partial configuration is harmless in non-production environments.
- **Lifecycle still applies.** The WebAFX plugin calls `shutdown()` for you; standalone code must call `await mailer.shutdown()` explicitly (memory `shutdown()` clears captured messages, SMTP closes the connection pool).

---

## Pattern 2: Multiple Named Mailers

### When to Use This Pattern

- Transactional mail (receipts, password resets) and marketing/bulk mail should not share a relay, credential set, or sending reputation.
- Different parts of the application genuinely need different transports or service identities.
- You want each mailer to appear as its own singleton service with its own health entry and shutdown path.

### Complete Example

The service name — defaulting to `"mailer"` — is the registration key. Overriding it per provider makes multiple mailers coexist cleanly:

```typescript
import {
    createMailPlugin,
    MemoryMailProvider,
    SmtpMailProvider,
} from "blendsdk/webafx-mailer";

// Transactional mail — high-deliverability relay, sends order receipts.
const transactionalMailer = new SmtpMailProvider({
    serviceName: "transactional-mailer",
    host: "smtp.transactional.example.com",
    port: 587,
    auth: { user: "tx@example.com", pass: "tx-secret" },
});

// Marketing mail — bulk relay with a separate reputation.
const marketingMailer = new SmtpMailProvider({
    serviceName: "marketing-mailer",
    host: "smtp.marketing.example.com",
    port: 587,
    auth: { user: "mkt@example.com", pass: "mkt-secret" },
});

// Development/test capture under its own name.
const devMailer = new MemoryMailProvider({ serviceName: "dev-mailer" });

const plugins = [
    createMailPlugin(transactionalMailer),
    createMailPlugin(marketingMailer),
    createMailPlugin(devMailer, { priority: 20 }),
];

for (const plugin of plugins) {
    console.log(`Plugin "${plugin.name}" (priority ${plugin.priority})`);
}

// Each mailer sends independently:
await transactionalMailer.send({
    from: "receipts@example.com",
    to: "customer@example.com",
    subject: "Your receipt",
    text: "Thanks for your purchase.",
});

await marketingMailer.send({
    from: "news@example.com",
    to: ["subscriber-1@example.com", "subscriber-2@example.com"],
    subject: "This month at Example Corp",
    text: "Here is what is new.",
});

await devMailer.send({
    from: "noreply@example.com",
    to: "developer@example.com",
    subject: "Preview",
    text: "Rendered in memory only.",
});

console.log("Last captured dev email:", devMailer.getLastMessage()?.message.subject);

// Shut down every provider explicitly in standalone usage:
await Promise.all([
    transactionalMailer.shutdown(),
    marketingMailer.shutdown(),
    devMailer.shutdown(),
]);
```

In a WebAFX application, each plugin registers its own singleton service; resolution happens by name:

```typescript fragment
// Bootstrap — three plugins, three singleton services:
app.use(createMailPlugin(transactionalMailer));
app.use(createMailPlugin(marketingMailer));
app.use(createMailPlugin(devMailer, { priority: 20 }));

// Anywhere in the app — resolve the mailer you mean, by name:
const receipts = services.get<MailProvider>("transactional-mailer");

await receipts.send({
    from: "receipts@example.com",
    to: "customer@example.com",
    subject: "Your receipt",
    text: "Thanks for your purchase.",
});
```

### Why This Pattern Matters

This pattern is about failure isolation and identity:

- **Reputation and credential isolation** — a throttled or compromised marketing relay cannot take down password resets, and vice versa.
- **Uniform typing** — every mailer is a `MailProvider`, so shared helpers (the retry wrapper from Pattern 5, the guarded send wrapper from Pattern 7) accept any of them unchanged.
- **Independent lifecycle** — each plugin registers its own singleton and returns its own `health`/`shutdown` hooks, so health checks and disposal cover every mailer.
- **Explicit call sites** — resolving by name means no code silently depends on a single global `"mailer"`; the choice is visible at the call site.

### Caveats and Performance Notes

- **Service names must be unique.** The plugin name equals `provider.serviceName`; two providers that both default to `"mailer"` collide on the same container key. Override `serviceName` for every additional mailer.
- **Each SMTP provider owns a transport and its own connection pool.** More mailers mean more sockets and memory; keep the number small and justified.
- **Shut down every provider.** Plugins dispose their provider during application shutdown; standalone code must call `shutdown()` per mailer, as shown above.
- **Priority controls install order only.** Health reporting and service resolution are independent of plugin priority; use it purely for ordering relative to other plugins.

---

## Pattern 3: Custom Backends via Subclassing

### When to Use This Pattern

- You need a backend the package does not ship — an audit log, a local outbox, an HTTP-API transport, or a console logger for local development.
- You want to wrap a built-in provider with cross-cutting behavior (auditing, metrics, rate limiting) without touching call sites.
- You want the custom backend to participate in the same plugin infrastructure — singleton registration, health hook, shutdown hook — as the built-ins.

### Complete Example

Because `MailProvider` and `createMailPlugin()` are both public, a decorator provider gets the full plugin lifecycle for free. This example records every send attempt to a JSON Lines audit file before delegating to the wrapped provider:

```typescript
import { appendFile } from "node:fs/promises";

import {
    MailProvider,
    MemoryMailProvider,
    createMailPlugin,
    type MailMessage,
    type MailProviderConfig,
    type MailResult,
} from "blendsdk/webafx-mailer";

/**
 * Decorator provider that records every send attempt to an audit log
 * (JSON Lines), then delegates to the wrapped provider.
 */
class AuditingMailProvider extends MailProvider {
    private readonly inner: MailProvider;
    private readonly logPath: string;

    constructor(inner: MailProvider, logPath: string, config: MailProviderConfig = {}) {
        super(config);
        this.inner = inner;
        this.logPath = logPath;
    }

    async send(message: MailMessage): Promise<MailResult> {
        const entry = {
            at: new Date().toISOString(),
            from: message.from,
            to: message.to,
            subject: message.subject,
        };

        try {
            const result = await this.inner.send(message);
            await appendFile(
                this.logPath,
                JSON.stringify({ ...entry, outcome: "sent", messageId: result.messageId }) + "\n"
            );
            return result;
        } catch (error) {
            const reason = error instanceof Error ? error.message : "unknown error";
            await appendFile(
                this.logPath,
                JSON.stringify({ ...entry, outcome: "failed", reason }) + "\n"
            );
            throw error;
        }
    }

    async health(): Promise<boolean> {
        return this.inner.health();
    }

    async shutdown(): Promise<void> {
        await this.inner.shutdown();
    }
}

const baseMailer = new MemoryMailProvider();

const auditedMailer = new AuditingMailProvider(baseMailer, "./mail-audit.jsonl", {
    serviceName: "audited-mailer",
});

const result = await auditedMailer.send({
    from: "billing@example.com",
    to: "customer@example.com",
    subject: "Invoice 1042",
    text: "Your invoice is attached.",
});

console.log("Accepted:", result.accepted);

// The plugin layer accepts custom providers exactly like the built-ins:
const plugin = createMailPlugin(auditedMailer);
console.log(`Plugin "${plugin.name}" (priority ${plugin.priority})`);

await auditedMailer.shutdown();
```

Because the plugin layer trusts the contract rather than the implementation, a custom provider must honor the same semantics. The package verifies both built-in backends with one shared contract suite (see `tests/abstract-contract.test.ts`); run the same idea against your backend in your own test project:

```typescript
import { describe, expect, it } from "vitest";

import {
    MemoryMailProvider,
    type MailProvider,
} from "blendsdk/webafx-mailer";

/**
 * Run the shared contract against any provider factory.
 * Call it once per backend — built-in or custom.
 */
function describeMailProviderContract(
    name: string,
    createProvider: () => MailProvider
): void {
    describe(`MailProvider contract: ${name}`, () => {
        it("returns a result with the recipient in accepted", async () => {
            const provider = createProvider();
            try {
                const result = await provider.send({
                    from: "contract@example.com",
                    to: "recipient@example.com",
                    subject: "Contract",
                    text: "Contract check",
                });

                expect(result.accepted).toContain("recipient@example.com");
                expect(Array.isArray(result.rejected)).toBe(true);
                if (result.messageId !== undefined) {
                    expect(typeof result.messageId).toBe("string");
                    expect(result.messageId.length).toBeGreaterThan(0);
                }
            } finally {
                await provider.shutdown();
            }
        });

        it("reports health as a boolean and defaults the service name to 'mailer'", async () => {
            const provider = createProvider();
            try {
                expect(typeof (await provider.health())).toBe("boolean");
                expect(provider.serviceName).toBe("mailer");
            } finally {
                await provider.shutdown();
            }
        });
    });
}

describeMailProviderContract("MemoryMailProvider", () => new MemoryMailProvider());

// Your custom backend joins the same suite in your own tests:
// describeMailProviderContract(
//     "AuditingMailProvider",
//     () => new AuditingMailProvider(new MemoryMailProvider(), "./audit.jsonl")
// );
```

### Why This Pattern Matters

- **Open for extension, closed for modification.** The abstract class is exported precisely so new transports can be added without forking the package, and `createMailPlugin()` wires any `MailProvider` — SMTP, memory, or yours — into the same singleton-service, health, and shutdown infrastructure.
- **Decorators separate concerns.** Call sites keep calling `send()`; auditing, metrics, or fallback routing are added once, around the provider, instead of in every sending module.
- **Behavioral parity is testable.** A shared contract suite makes "indistinguishable from the built-ins" a checkable property rather than a hope — the exact approach the package uses for its own two backends.

### Caveats and Performance Notes

- **Implement all three members.** TypeScript strict mode enforces `send()`, `health()`, and `shutdown()` at compile time.
- **Match the error model.** `send()` should throw on failure (like `SmtpMailProvider`) so application-level retry and error handling behave identically; `health()` should never throw — catch internally and return a boolean.
- **Make `shutdown()` idempotent.** The plugin wires `provider.shutdown()` into both the singleton service's `dispose` hook and the returned shutdown hook, so teardown paths can invoke it more than once:

```typescript fragment
private disposed = false;

async shutdown(): Promise<void> {
    if (this.disposed) {
        return;
    }
    this.disposed = true;
    await this.inner.shutdown();
}
```

- **Watch the send-path latency.** Awaiting audit I/O adds a disk write to every `send()`; for hot paths, buffer writes or make them fire-and-forget with their own error handling.

---

## Pattern 4: Deterministic Email Testing

### When to Use This Pattern

- Unit-testing services or controllers that send email.
- Asserting on content, recipients, and result metadata of outgoing mail without a mail server.
- Integration-testing a WebAFX application where email is a side effect you want to observe and verify.

### Complete Example

The memory backend stores every send as a `SentMailEntry` (`{ message, result }`). Combined with constructor injection, this makes email assertions trivial:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryMailProvider, type MailProvider } from "blendsdk/webafx-mailer";

/** Application service with constructor-injected mailer — trivially testable. */
class RegistrationService {
    constructor(private readonly mailer: MailProvider) {}

    async register(email: string): Promise<void> {
        await this.mailer.send({
            from: "noreply@example.com",
            to: email,
            subject: "Welcome aboard!",
            text: "Your account is ready.",
            html: "<p>Your account is <strong>ready</strong>.</p>",
        });
    }
}

describe("RegistrationService", () => {
    let mailer: MemoryMailProvider;
    let service: RegistrationService;

    beforeEach(() => {
        mailer = new MemoryMailProvider();
        service = new RegistrationService(mailer);
    });

    afterEach(async () => {
        // shutdown() clears the store — always run it AFTER assertions.
        await mailer.shutdown();
    });

    it("sends exactly one welcome email with the right content", async () => {
        await service.register("new-user@example.com");

        const sent = mailer.getSentMessages();
        expect(sent).toHaveLength(1);
        expect(sent[0].message.to).toBe("new-user@example.com");
        expect(sent[0].message.subject).toBe("Welcome aboard!");
        expect(sent[0].result.accepted).toEqual(["new-user@example.com"]);
        expect(sent[0].result.rejected).toEqual([]);
        expect(sent[0].result.messageId).toMatch(/^<memory-\d+-\d+@test>$/);
    });

    it("clears captures between cases without recreating the provider", async () => {
        await service.register("first@example.com");
        mailer.clear();

        await service.register("second@example.com");

        expect(mailer.getSentMessages()).toHaveLength(1);
        expect(mailer.getLastMessage()?.message.to).toBe("second@example.com");
    });
});
```

When the application runs under WebAFX, the one-liner `memoryMailPlugin()` hides the provider instance, so there is no handle to assert with. Own the provider instead:

```typescript fragment
// Before — the provider lives inside the plugin;
// there is no handle for getSentMessages() in application tests.
app.use(memoryMailPlugin());
```

```typescript fragment
// After — own the provider, wrap it, keep the handle:
const mailer = new MemoryMailProvider({ serviceName: "mailer" });
app.use(createMailPlugin(mailer));

// Exercise the application (HTTP calls, jobs, etc.), then assert:
expect(mailer.getSentMessages()).toHaveLength(1);

// Teardown last — shutdown() clears the captured messages.
await mailer.shutdown();
```

The memory backend cannot fail, so failure-path tests need a stub. Subclass `MailProvider` (a plain object literal is not assignable — the base class has protected members):

```typescript fragment
// MemoryMailProvider.send() never throws — to exercise failure handling,
// subclass MailProvider with a stub that fails on demand:
class FailingMailProvider extends MailProvider {
    async send(message: MailMessage): Promise<MailResult> {
        throw new Error(`Simulated SMTP failure for "${message.subject}"`);
    }

    async health(): Promise<boolean> {
        return false;
    }

    async shutdown(): Promise<void> {
        // No resources to release in this stub.
    }
}
```

### Why This Pattern Matters

- **Zero infrastructure.** Full email flows run in CI without Docker, without a fake SMTP server, and without network access.
- **Full observability.** Each entry pairs the original `message` with the `result` that `send()` returned, so tests can assert on input and output in one place.
- **Predictable identifiers.** Message IDs follow the deterministic `<memory-${Date.now()}-${index}@test>` shape, safe to match with a regex instead of brittle exact strings.
- **Reference fidelity.** Entries store the original message object, so identity assertions (`expect(stored.message).toBe(originalMessage)`) hold — the same guarantee the package's own tests rely on.

### Caveats and Performance Notes

- **Assert before teardown.** `shutdown()` clears the store (it delegates to `clear()`). If you shut down in `afterEach`, all assertions must run inside the test body — never after cleanup.
- **Captures are by reference, not deep clones.** If code under test mutates a `MailMessage` object after `send()`, the stored entry reflects that mutation. Clone the message first (`structuredClone`) when a test needs to compare pre-send state.
- **`getSentMessages()` returns a shallow copy.** Mutating the returned array is safe (the store is unaffected), but the entries inside are shared.
- **The memory backend never rejects.** `result.rejected` is always empty and `send()` never throws; use the failing stub above for error-path tests, or the retry stub from Pattern 5.

---

## Pattern 5: Resilient Sends with Bounded Retries

### When to Use This Pattern

- Sending mail is part of a critical flow (password resets, order confirmations) and a transient SMTP hiccup should not lose the message.
- You want predictable failure behavior: bounded attempts, observable retries, and one final error.
- You want to combine the package's two error-reporting channels: `send()` throws on failure, while `health()` returns a boolean and never throws.

### Complete Example

```typescript
import {
    SmtpMailProvider,
    type MailMessage,
    type MailProvider,
    type MailResult,
} from "blendsdk/webafx-mailer";

interface RetryOptions {
    /** Total send attempts, including the first. Default: 3 */
    maxAttempts?: number;
    /** Base backoff in milliseconds; doubles after each failure. Default: 500 */
    baseDelayMs?: number;
    /** Called after every failed attempt — wire this to your logger or metrics. */
    onAttemptFailed?: (attempt: number, error: Error) => void;
}

/** Sleep helper for backoff between attempts. */
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a message with a pre-flight health check and bounded exponential
 * backoff. `send()` throws on SMTP failures, so every attempt is wrapped;
 * `health()` never throws and short-circuits the whole operation when the
 * backend is unreachable.
 */
async function sendWithRetry(
    provider: MailProvider,
    message: MailMessage,
    options: RetryOptions = {}
): Promise<MailResult> {
    const { maxAttempts = 3, baseDelayMs = 500, onAttemptFailed } = options;

    const healthy = await provider.health();
    if (!healthy) {
        throw new Error(`Mail provider "${provider.serviceName}" is not reachable`);
    }

    let lastError = new Error("No send attempt was performed");

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await provider.send(message);
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            onAttemptFailed?.(attempt, lastError);

            if (attempt < maxAttempts) {
                // Exponential backoff: baseDelayMs, 2x, 4x, ...
                await delay(baseDelayMs * 2 ** (attempt - 1));
            }
        }
    }

    throw new Error(
        `Giving up after ${maxAttempts} attempts: ${lastError.message}`,
        { cause: lastError }
    );
}

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "user@example.com", pass: "secret" },
});

try {
    const result = await sendWithRetry(
        mailer,
        {
            from: "noreply@example.com",
            to: "customer@example.com",
            subject: "Password reset",
            text: "Use code 482913 to reset your password.",
        },
        {
            maxAttempts: 3,
            baseDelayMs: 500,
            onAttemptFailed: (attempt, error) => {
                console.warn(`SMTP attempt ${attempt} failed: ${error.message}`);
            },
        }
    );

    console.log("Delivered to:", result.accepted);
} catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    console.error("Reset email could not be sent:", reason);
}

await mailer.shutdown();
```

Since the memory backend never throws, exercise the retry wrapper with a flaky stub in your tests:

```typescript fragment
// Stub for exercising the retry wrapper: fails twice, then succeeds.
class FlakyMailProvider extends MailProvider {
    private attempts = 0;

    async send(message: MailMessage): Promise<MailResult> {
        this.attempts += 1;
        if (this.attempts < 3) {
            throw new Error(`Transient SMTP failure #${this.attempts}`);
        }

        const recipients = Array.isArray(message.to) ? message.to : [message.to];
        return {
            accepted: recipients,
            rejected: [],
            messageId: `<flaky-${this.attempts}@test>`,
        };
    }

    async health(): Promise<boolean> {
        return true;
    }

    async shutdown(): Promise<void> {
        this.attempts = 0;
    }
}
```

### Why This Pattern Matters

`MailProvider` reports trouble through two distinct channels, and this pattern uses both for what they are good at:

| Channel | Semantics | Best Used For |
| --- | --- | --- |
| `health()` | Never throws; returns `false` when the backend is unreachable | Fail fast before attempting work; alerting and dashboards |
| `send()` | Throws on connection, authentication, or send failures | Wrapping in retries; propagating a final, actionable error |

The retry wrapper is backend-agnostic — it types against `MailProvider`, so it works with SMTP, memory, or any custom provider, and on the memory backend it simply never retries.

### Caveats and Performance Notes

- **SMTP is not exactly-once.** A timeout after the server accepted a message can duplicate it on retry. Keep `maxAttempts` small and the backoff meaningful; for strict delivery guarantees, put an outbox/queue in front (this package deliberately does not provide one).
- **`health()` costs a network round trip.** `SmtpMailProvider.health()` runs `transporter.verify()` — a real EHLO/HELO handshake, not a memory read. Do one pre-flight check as shown; never call it inside the retry loop, and see Pattern 7 for caching it.
- **Retries after `shutdown()` are pointless.** Once the transport is closed, every `send()` fails; ordering teardown after in-flight work is Pattern 7's job.
- **`rejected` is not an error.** A successful `send()` can still report recipients in `result.rejected`; retrying the whole message will not help those addresses.

---

## Pattern 6: Batch Fan-Out with Per-Recipient Accounting

### When to Use This Pattern

- Sending personalized notifications to a list — order updates, account alerts, per-user digest content.
- You need per-recipient bookkeeping: what was accepted, what was rejected, and what errored.
- You must avoid both sequential slowness and unbounded concurrency.

### Complete Example

```typescript
import {
    SmtpMailProvider,
    type MailMessage,
    type MailProvider,
    type MailResult,
} from "blendsdk/webafx-mailer";

interface Notification {
    recipient: string;
    orderId: string;
}

interface BatchReport {
    delivered: string[];
    rejected: string[];
    failed: Array<{ recipient: string; reason: string }>;
}

interface SendOutcome {
    notification: Notification;
    result: MailResult | null;
    error: Error | null;
}

/**
 * Send personalized notifications in small concurrent chunks.
 * Chunking keeps the connection pool busy without flooding the
 * SMTP server with hundreds of simultaneous sessions.
 */
async function sendShipmentNotifications(
    provider: MailProvider,
    notifications: Notification[],
    chunkSize = 5
): Promise<BatchReport> {
    const report: BatchReport = { delivered: [], rejected: [], failed: [] };

    for (let index = 0; index < notifications.length; index += chunkSize) {
        const chunk = notifications.slice(index, index + chunkSize);

        const outcomes: SendOutcome[] = await Promise.all(
            chunk.map(async (notification): Promise<SendOutcome> => {
                const message: MailMessage = {
                    from: "orders@example.com",
                    to: notification.recipient,
                    subject: `Order ${notification.orderId} has shipped`,
                    text: `Hello! Order ${notification.orderId} is on its way.`,
                };

                try {
                    return { notification, result: await provider.send(message), error: null };
                } catch (error) {
                    return {
                        notification,
                        result: null,
                        error: error instanceof Error ? error : new Error(String(error)),
                    };
                }
            })
        );

        for (const outcome of outcomes) {
            if (outcome.error !== null) {
                report.failed.push({
                    recipient: outcome.notification.recipient,
                    reason: outcome.error.message,
                });
                continue;
            }

            if (outcome.result !== null) {
                if (outcome.result.accepted.includes(outcome.notification.recipient)) {
                    report.delivered.push(outcome.notification.recipient);
                }
                for (const address of outcome.result.rejected) {
                    report.rejected.push(address);
                }
            }
        }
    }

    return report;
}

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
});

const report = await sendShipmentNotifications(mailer, [
    { recipient: "alice@example.com", orderId: "1001" },
    { recipient: "bob@example.com", orderId: "1002" },
    { recipient: "charlie@example.com", orderId: "1003" },
    { recipient: "dave@example.com", orderId: "1004" },
    { recipient: "erin@example.com", orderId: "1005" },
    { recipient: "frank@example.com", orderId: "1006" },
]);

console.log(`Delivered: ${report.delivered.length}`);
console.log(`Rejected: ${report.rejected.length}`);
console.log(`Failed: ${report.failed.length}`);

await mailer.shutdown();
```

When the content is identical for everyone, the cheaper variant is one message with array recipients — a single SMTP transaction with per-address accounting:

```typescript fragment
// Identical content? One message, one SMTP transaction, per-address results:
const result = await mailer.send({
    from: "news@example.com",
    to: ["subscriber-1@example.com", "subscriber-2@example.com", "subscriber-3@example.com"],
    subject: "Version 2.0 is out",
    text: "Here is what is new.",
});

console.log(result.accepted); // addresses the server took
console.log(result.rejected); // addresses the server refused
```

### Why This Pattern Matters

- **Auditable delivery reports.** `MailResult.accepted` / `rejected` plus per-send error capture produce a report you can log, persist, or show to an operator. Wrap each individual send in the retry helper from Pattern 5 when delivery matters more than batch latency.
- **Bounded concurrency, by design.** Chunked `Promise.all` keeps throughput high while respecting the receiving server's tolerance — the nodemailer transport pools connections, but relays enforce rate limits and session caps of their own.
- **Backend-agnostic bookkeeping.** The whole routine types against `MailProvider`, so the same code and the same unit tests run against the memory backend in CI.

### Caveats and Performance Notes

- **`accepted` means "the server accepted the transaction"** — not "the mailbox received it". Asynchronous bounces arrive later and are outside this package's scope.
- **Recipient visibility.** Array `to` exposes the address list to every recipient; use `bcc` for hidden lists, or fan out personalized sends (as in the main example).
- **Tune chunk size to the relay.** Start at 5 and adjust; large parallel bursts can trigger throttling or greylisting. `Promise.all` inside a chunk means one slow send delays the whole chunk — acceptable for mail, not for latency-critical work.
- **Large batches belong in a background job.** Keep the fan-out out of synchronous HTTP request paths; the memory backend makes the surrounding logic fully unit-testable without SMTP.

---

## Pattern 7: Standalone Lifecycle Management

### When to Use This Pattern

- Running the mailer in a standalone Node service (no WebAFX) — the documented use case for using providers directly.
- The process receives `SIGTERM`/`SIGINT` (containers, Kubernetes) and must close the SMTP pool without dropping in-flight sends.
- You expose health information but want to avoid a handshake round trip on every probe.

### Complete Example

```typescript
import {
    SmtpMailProvider,
    type MailMessage,
    type MailResult,
} from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "user@example.com", pass: "secret" },
});

/** In-flight sends — drained before the transport is closed. */
const inFlight = new Set<Promise<MailResult>>();

let shuttingDown = false;

/** Guarded send wrapper — refuses new work once shutdown has begun. */
async function send(message: MailMessage): Promise<MailResult> {
    if (shuttingDown) {
        throw new Error(`Mailer "${mailer.serviceName}" is shutting down`);
    }

    const pending = mailer.send(message);
    inFlight.add(pending);
    try {
        return await pending;
    } finally {
        inFlight.delete(pending);
    }
}

/** Idempotent teardown — drains in-flight sends, then closes the transport once. */
async function shutdown(): Promise<void> {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;

    await Promise.allSettled([...inFlight]);
    await mailer.shutdown();
    console.log("Mailer drained and transport closed");
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
        void shutdown().then(() => process.exit(0));
    });
}

// Application code uses the guarded wrapper instead of the provider directly:
const result = await send({
    from: "orders@example.com",
    to: "customer@example.com",
    subject: "Order shipped",
    text: "Your order is on its way.",
});

console.log("Delivered to:", result.accepted);

// In a real service the process exits via the signal handlers;
// for this example, close explicitly (shutdown is idempotent):
await shutdown();
```

Because `SmtpMailProvider.health()` performs a real EHLO/HELO handshake (`transporter.verify()`), cache the result instead of calling it per probe:

```typescript fragment
// Cache the handshake — health() is a network round trip, not a memory read.
let healthy = false;
let checkedAt = 0;
const HEALTH_TTL_MS = 15_000;

async function isMailHealthy(): Promise<boolean> {
    const now = Date.now();
    if (now - checkedAt >= HEALTH_TTL_MS) {
        healthy = await mailer.health();
        checkedAt = now;
    }
    return healthy;
}
```

### Why This Pattern Matters

- **Providers own resources.** The SMTP provider holds a pooled set of TCP connections; `shutdown()` releases them, and an abrupt process exit can drop messages mid-send. Container platforms terminate processes with `SIGTERM` as a matter of routine — deploys should not lose password-reset emails.
- **Deterministic behavior at the boundary.** The `shuttingDown` guard fails new sends fast with a clear error while the in-flight set drains existing work, so there is no window where a send starts against a closing transport.
- **Idempotency matches the plugin contract.** The WebAFX plugin wires `provider.shutdown()` into both the singleton's `dispose` hook and its shutdown hook, so built-in providers are designed to tolerate repeated calls; the same discipline in standalone code keeps behavior consistent across deployment styles (and mirrors the lifecycle contract shared with `blendsdk/webafx-cache`'s `CacheProvider` design).
- **Cheap health checks.** Caching `health()` keeps `/health` endpoints honest without paying a handshake on every poll.

### Caveats and Performance Notes

- **Installing signal handlers transfers exit responsibility to you.** Call `process.exit()` after cleanup or let the event loop drain naturally; a handler that never exits turns a deploy into a hang.
- **Draining is best-effort.** If deploy latency matters, bound the drain with a timeout (`Promise.race` against a timer) so a stuck SMTP connection cannot block termination forever.
- **After `shutdown()`, the provider is unusable.** Subsequent `send()` calls fail; create a new provider if the work must continue.
- **Cache with a TTL, not forever.** A cached `true` can mask a failure that occurs between checks; 10–30 seconds is a reasonable range for health endpoints, and Pattern 5's pre-flight check covers the send path itself.

---

## Next Steps

- Overview — package scope, architecture, and dependency notes.
- Core Concepts — deep dive into `MailProvider`, the message model, both backends, and the plugin layer.
- Basic Usage — task-oriented walkthroughs for sending mail, switching backends, and WebAFX integration.

---

# webafx-mailer Common Scenarios

This document answers the most common "How do I…?" questions about `blendsdk/webafx-mailer`, ordered from simple sending tasks to advanced integration and extensibility patterns. Every scenario is self-contained: a short explanation followed by a complete TypeScript example.

---

## How do I send a basic email?

Create a provider and call `send()` with a `MailMessage`. The example uses `MemoryMailProvider`, so no email actually leaves the process — ideal while you shape the message. Every backend resolves the same `MailResult` shape (`accepted`, `rejected`, `messageId`), so switching to `SmtpMailProvider` later requires no changes to call sites.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

const result = await mailer.send({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Welcome!",
    text: "Welcome to our service!",
});

console.log("Accepted:", result.accepted);       // ["user@example.com"]
console.log("Rejected:", result.rejected);       // []
console.log("Message ID:", result.messageId);    // "<memory-...@test>"

await mailer.shutdown();
```

---

## How do I send an HTML email with a plain-text fallback?

Provide both `text` and `html` in the same message: the HTML body is the rich version, and the plain-text body is the fallback for mail clients that do not render HTML. Providing both bodies also improves deliverability scoring on real SMTP servers.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

const result = await mailer.send({
    from: "noreply@example.com",
    to: "customer@example.com",
    subject: "Your receipt",
    text: "Thanks for your purchase! Your receipt is available in your account.",
    html: "<h1>Thanks for your purchase!</h1><p>Your receipt is available in your account.</p>",
});

console.log("Accepted:", result.accepted);
console.log("Message ID:", result.messageId);

await mailer.shutdown();
```

---

## How do I send to multiple recipients with CC and BCC?

`to`, `cc`, and `bcc` each accept a single address or an array of addresses — mix them freely. On the memory backend, all recipients land in `result.accepted`; on SMTP, the server decides what ends up in `accepted` and `rejected`. BCC recipients receive the mail without appearing in the headers seen by the other recipients.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

const result = await mailer.send({
    from: "noreply@example.com",
    to: ["alice@example.com", "bob@example.com"],
    cc: "team-lead@example.com",
    bcc: ["archive@example.com", "compliance@example.com"],
    subject: "Sprint review",
    text: "The sprint review is scheduled for Friday at 10:00.",
});

console.log("Accepted:", result.accepted);
// ["alice@example.com", "bob@example.com", "team-lead@example.com", "archive@example.com", "compliance@example.com"]
console.log("Rejected:", result.rejected); // []

await mailer.shutdown();
```

---

## How do I attach a file to an email?

Pass `MailAttachment` objects in `message.attachments`. Content is either a raw `Buffer` for binary data or a base64-encoded string, and the optional `contentType` sets the MIME type.

```typescript
import { MemoryMailProvider, type MailAttachment } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

// Binary content: raw Buffer (here, the 8-byte PNG file signature)
const chartAttachment: MailAttachment = {
    filename: "chart.png",
    content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    contentType: "image/png",
};

// Text content: base64-encoded string (a UTF-8 Buffer works too)
const notesAttachment: MailAttachment = {
    filename: "notes.txt",
    content: Buffer.from("Meeting notes: ship it!").toString("base64"),
    contentType: "text/plain",
};

const result = await mailer.send({
    from: "reports@example.com",
    to: "finance@example.com",
    subject: "Monthly report",
    text: "Please find the report attachments.",
    attachments: [chartAttachment, notesAttachment],
});

console.log("Accepted:", result.accepted);

const stored = mailer.getLastMessage();
console.log("Attached files:", stored?.message.attachments?.map((a) => a.filename));
// ["chart.png", "notes.txt"]

await mailer.shutdown();
```

---

## How do I send a real email over SMTP?

Construct an `SmtpMailProvider` with connection settings and call `send()` as usual — nodemailer owns the wire protocol and connection pooling. Use port 587 with `secure: false` (STARTTLS, the modern default) or port 465 with `secure: true` (implicit TLS). Always call `shutdown()` when the application stops to close the connection pool.

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,       // STARTTLS
    secure: false,   // true only for implicit TLS (typically port 465)
    auth: {
        user: "user@example.com",
        pass: process.env.SMTP_PASSWORD ?? "",
    },
});

try {
    const result = await mailer.send({
        from: "noreply@example.com",
        to: "customer@example.com",
        subject: "Your receipt",
        text: "Thanks for your purchase.",
        html: "<p>Thanks for your purchase.</p>",
    });

    console.log("Accepted:", result.accepted);
    console.log("Rejected:", result.rejected);
    console.log("Message ID:", result.messageId);
} catch (error) {
    const reason = error instanceof Error ? error.message : "unknown SMTP error";
    console.error("Failed to send email:", reason);
} finally {
    await mailer.shutdown();
}
```

Other common connection shapes:

```typescript fragment
// Implicit TLS (typically port 465) — set secure: true:
const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 465,
    secure: true,
    auth: { user: "user@example.com", pass: "secret" },
});

// Unauthenticated local server (e.g. Mailpit in Docker) — omit auth entirely:
const localMailer = new SmtpMailProvider({
    host: "localhost",
    port: 1025,
    secure: false,
});

// Certificate validation stays configurable via the tls option — only use
// rejectUnauthorized: false for internal servers with self-signed certificates:
const internalMailer = new SmtpMailProvider({
    host: "mail.internal.example.com",
    port: 587,
    secure: false,
    tls: { rejectUnauthorized: false },
});
```

---

## How do I handle a failed SMTP send?

`send()` on the SMTP backend rejects on connection failures, authentication errors, and server rejections, so wrap sends in `try/catch` when the application must keep running. For monitoring-style checks, prefer `health()`, which reports `false` instead of throwing.

```typescript
import {
    SmtpMailProvider,
    type MailMessage,
    type MailProvider,
} from "blendsdk/webafx-mailer";

async function sendSafely(mailer: MailProvider, message: MailMessage): Promise<boolean> {
    try {
        const result = await mailer.send(message);
        console.log(`Sent "${message.subject}" to ${result.accepted.join(", ")}`);
        return true;
    } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown SMTP failure";
        console.error(`Send failed for "${message.subject}": ${reason}`);
        return false;
    }
}

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "user@example.com", pass: "secret" },
});

const delivered = await sendSafely(mailer, {
    from: "noreply@example.com",
    to: "customer@example.com",
    subject: "Your receipt",
    text: "Thanks for your purchase.",
});

console.log("Delivered:", delivered);

await mailer.shutdown();
```

---

## How do I test email-sending code without a real SMTP server?

Type application code against the abstract `MailProvider` and inject the concrete backend at composition time. Tests pass a `MemoryMailProvider` and assert against `getSentMessages()` — no SMTP server, no network, no Docker. Production code passes an `SmtpMailProvider` instead; the application function never changes.

```typescript
import { describe, expect, it } from "vitest";
import { MemoryMailProvider, type MailProvider } from "blendsdk/webafx-mailer";

// Application code depends only on the abstract MailProvider type.
async function sendPasswordReset(mailer: MailProvider, userEmail: string): Promise<void> {
    await mailer.send({
        from: "noreply@example.com",
        to: userEmail,
        subject: "Password reset",
        text: "Follow the link in your account settings to reset your password.",
    });
}

describe("sendPasswordReset", () => {
    it("sends a reset email to the requesting user", async () => {
        // Production swaps in an SmtpMailProvider here — the test uses memory.
        const mailer = new MemoryMailProvider();

        await sendPasswordReset(mailer, "user@example.com");

        const sent = mailer.getSentMessages();
        expect(sent).toHaveLength(1);
        expect(sent[0].message.to).toBe("user@example.com");
        expect(sent[0].message.subject).toBe("Password reset");
        expect(sent[0].result.accepted).toEqual(["user@example.com"]);

        await mailer.shutdown();
    });
});
```

---

## How do I inspect exactly what a memory provider captured?

Use `getSentMessages()` for the full list and `getLastMessage()` for the most recent entry; each `SentMailEntry` pairs the original `message` with the `result` that `send()` returned. The returned array is a defensive copy (mutating it is safe), while each entry keeps a reference to the original message object — so identity assertions with `toBe` work as well.

```typescript
import { MemoryMailProvider, type MailMessage, type SentMailEntry } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

const message: MailMessage = {
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Welcome!",
    text: "Welcome aboard!",
};

await mailer.send(message);

// getSentMessages() returns a defensive copy of the internal array
const firstRead = mailer.getSentMessages();
const secondRead = mailer.getSentMessages();
console.log(firstRead === secondRead); // false — different array references

// Each entry pairs the original message with the result send() returned
const entry: SentMailEntry | undefined = mailer.getLastMessage();
console.log(entry?.message === message);   // true — the original object, by reference
console.log(entry?.result.accepted);       // ["user@example.com"]

// Mutating a returned array does not affect the provider's store
firstRead.length = 0;
console.log(mailer.getSentMessages().length); // 1

await mailer.shutdown();
```

---

## How do I reset captured mail between tests?

Call `clear()` after each test (or before the next one) to empty the store. `shutdown()` on the memory provider also clears it, but note the difference for SMTP: `shutdown()` closes the transport permanently, so call it once at application teardown — never between sends on a shared SMTP provider.

```typescript
import { afterEach, describe, expect, it } from "vitest";
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

describe("newsletter flow", () => {
    const mailer = new MemoryMailProvider();

    afterEach(() => {
        // Reset the in-memory store so each test starts from zero captured messages.
        mailer.clear();
    });

    it("captures the first announcement", async () => {
        await mailer.send({
            from: "news@example.com",
            to: "subscriber@example.com",
            subject: "Announcement #1",
            text: "First announcement.",
        });

        expect(mailer.getSentMessages()).toHaveLength(1);
    });

    it("starts clean for the next test", async () => {
        expect(mailer.getSentMessages()).toHaveLength(0);

        await mailer.send({
            from: "news@example.com",
            to: "subscriber@example.com",
            subject: "Announcement #2",
            text: "Second announcement.",
        });

        expect(mailer.getLastMessage()?.message.subject).toBe("Announcement #2");
    });
});
```

---

## How do I check whether the mail backend is reachable?

Call `health()` — it never rejects and reports the operational state as a boolean. The SMTP implementation runs nodemailer's `verify()` (an EHLO/HELO handshake that does not send email) and returns `false` when the server cannot be reached; the memory backend has no external dependencies and is always healthy.

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "user@example.com", pass: "secret" },
});

const reachable = await mailer.health();

if (reachable) {
    console.log("SMTP server is reachable — safe to send.");
} else {
    console.error("SMTP server is unreachable — check host, port, and credentials.");
}

await mailer.shutdown();
```

When the provider is registered through a plugin, `health()` is exposed on the application health check automatically — see the WebAFX scenarios below.

---

## How do I switch backends per environment?

Build a `MailFactoryConfig` with a `type` discriminator and hand it to `createMailProvider()` — one code path selects SMTP or memory at runtime, ideal for `NODE_ENV`-based configuration. Unknown backend names throw a descriptive `Error` instead of failing silently.

```typescript
import {
    createMailProvider,
    type MailFactoryConfig,
    type MailProvider,
} from "blendsdk/webafx-mailer";

const isProduction = process.env.NODE_ENV === "production";

const config: MailFactoryConfig = isProduction
    ? {
          type: "smtp",
          serviceName: "mailer",
          host: process.env.SMTP_HOST ?? "smtp.example.com",
          port: Number(process.env.SMTP_PORT ?? "587"),
          secure: process.env.SMTP_SECURE === "true",
          auth: {
              user: process.env.SMTP_USER ?? "",
              pass: process.env.SMTP_PASS ?? "",
          },
      }
    : {
          type: "memory",
          serviceName: "mailer",
      };

const mailer: MailProvider = createMailProvider(config);

console.log(`Connected backend: ${mailer.constructor.name}`);
// "SmtpMailProvider" in production, "MemoryMailProvider" everywhere else

// Unknown backend values fail fast with a descriptive error name
const misconfiguredBackend: string = "sendgrid";

try {
    createMailProvider({ type: misconfiguredBackend as "smtp" | "memory" });
} catch (error) {
    console.error(error instanceof Error ? error.message : "unexpected failure");
    // Unknown mail type: "sendgrid". Supported types: "smtp", "memory".
}

await mailer.shutdown();
```

Pair the result with `createMailPlugin()` (see below) when the mailer should be registered in a WebAFX application.

---

## How do I register the mailer with a WebAFX application?

Use `smtpMailPlugin(config)` / `memoryMailPlugin(config?)` for one-liner plugins, or `createMailPlugin(provider, options?)` to adapt any provider instance. The plugin registers the provider as a singleton service named after its `serviceName` (default `"mailer"`), hooks `health()` into the application health check, and hooks `shutdown()` into graceful disposal. Default priority is `30` — pass `{ priority }` to install earlier or later.

```typescript
import {
    createMailPlugin,
    MemoryMailProvider,
    memoryMailPlugin,
    smtpMailPlugin,
} from "blendsdk/webafx-mailer";

// Production: one-liner SMTP plugin
const productionPlugin = smtpMailPlugin({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "user@example.com", pass: "secret" },
});

// Development / CI: one-liner memory plugin — nothing is actually sent
const devPlugin = memoryMailPlugin({ serviceName: "dev-mailer" });

// Any provider: wrap it yourself, with a custom priority
const provider = new MemoryMailProvider({ serviceName: "test-mailer" });
const customPlugin = createMailPlugin(provider, { priority: 10 });

console.log(productionPlugin.name);     // "mailer"
console.log(productionPlugin.priority); // 30
console.log(devPlugin.name);            // "dev-mailer"
console.log(customPlugin.name);         // "test-mailer"
console.log(customPlugin.priority);     // 10

await provider.shutdown();
```

In a running WebAFX application, the plugin is passed to `app.use()` and the provider is resolved from the service container:

```typescript fragment
// WebAFX application bootstrap — app.use() accepts the PluginDefinition:
app.use(smtpMailPlugin({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "user@example.com", pass: "secret" },
}));

// Resolve the registered singleton anywhere in the application:
const mailer = services.get<MailProvider>("mailer");

await mailer.send({
    from: "noreply@example.com",
    to: "customer@example.com",
    subject: "Welcome!",
    text: "Thanks for signing up!",
});
```

In an application, the plugin's shutdown hook disposes the provider — you do not call `shutdown()` manually.

---

## How do I assert on emails when the mailer is wired into WebAFX?

`memoryMailPlugin()` creates and owns its provider internally, so tests have no reference to assert against. Instead, construct the `MemoryMailProvider` yourself and pass it to `createMailPlugin()` — the plugin registers that exact instance, and your test keeps asserting against it directly.

```typescript
import { describe, expect, it } from "vitest";
import { createMailPlugin, MemoryMailProvider } from "blendsdk/webafx-mailer";

describe("WebAFX mail plugin tests", () => {
    it("keeps the provider reachable for assertions", async () => {
        // memoryMailPlugin() owns its provider internally — a test cannot reach it.
        // Passing your own instance to createMailPlugin() keeps a direct reference.
        const mailer = new MemoryMailProvider();
        const plugin = createMailPlugin(mailer);

        expect(plugin.name).toBe("mailer");
        expect(plugin.priority).toBe(30);

        // Application code resolves this exact instance from the service container
        // and sends through it; the test then asserts against the captured store.
        await mailer.send({
            from: "noreply@example.com",
            to: "user@example.com",
            subject: "Welcome!",
            text: "Welcome aboard!",
        });

        const sent = mailer.getSentMessages();
        expect(sent).toHaveLength(1);
        expect(sent[0].message.subject).toBe("Welcome!");

        await mailer.shutdown();
    });
});
```

---

## How do I run multiple mailers side by side?

Give each provider a distinct `serviceName` — the plugin takes the same name. Multiple mailers (for example, transactional versus marketing) then coexist in one application, each with its own backend, configuration, and captured messages. `createMailProvider()` passes `serviceName` through, so environment-based setups can select distinct names too.

```typescript
import {
    createMailPlugin,
    MemoryMailProvider,
    type MailProvider,
} from "blendsdk/webafx-mailer";

// Two providers, two service names, two plugins.
const transactional = new MemoryMailProvider({ serviceName: "transactional-mailer" });
const marketing = new MemoryMailProvider({ serviceName: "marketing-mailer" });

const transactionalPlugin = createMailPlugin(transactional);
const marketingPlugin = createMailPlugin(marketing);

console.log(transactionalPlugin.name); // "transactional-mailer"
console.log(marketingPlugin.name);     // "marketing-mailer"

// Each provider captures its own messages, fully independently.
await transactional.send({
    from: "receipts@example.com",
    to: "customer@example.com",
    subject: "Your receipt",
    text: "Thanks for your purchase.",
});

await marketing.send({
    from: "news@example.com",
    to: "subscriber@example.com",
    subject: "Weekly digest",
    text: "Here is what happened this week.",
});

console.log("Transactional messages:", transactional.getSentMessages().length); // 1
console.log("Marketing messages:", marketing.getSentMessages().length);         // 1

const providers: MailProvider[] = [transactional, marketing];

for (const provider of providers) {
    await provider.shutdown();
}
```

The default service name is `"mailer"` — exported as `DEFAULT_SERVICE_NAME` if you need to reference it programmatically.

---

## How do I plug in a custom mail backend?

Subclass `MailProvider` and implement `send()`, `health()`, and `shutdown()`. Custom providers are first-class citizens: they work standalone and can be passed to `createMailPlugin()` alongside the shipped backends. This is also the recommended escape hatch when you need a transport the package does not ship.

```typescript
import { appendFile } from "node:fs/promises";

import {
    MailProvider,
    type MailMessage,
    type MailProviderConfig,
    type MailResult,
} from "blendsdk/webafx-mailer";

interface AuditLogConfig extends MailProviderConfig {
    /** Path of the file that receives one JSON line per sent message. */
    logPath: string;
}

/**
 * Custom backend that records every "sent" message as a JSON line in a
 * local file. Extending MailProvider makes it a first-class citizen:
 * usable standalone and with createMailPlugin().
 */
class AuditLogMailProvider extends MailProvider {
    private readonly logPath: string;

    constructor(config: AuditLogConfig) {
        super(config);
        this.logPath = config.logPath;
    }

    async send(message: MailMessage): Promise<MailResult> {
        await appendFile(this.logPath, `${JSON.stringify(message)}\n`, "utf8");

        const recipients = Array.isArray(message.to) ? message.to : [message.to];

        return {
            accepted: recipients,
            rejected: [],
            messageId: `<audit-${Date.now()}@local>`,
        };
    }

    async health(): Promise<boolean> {
        return true;
    }

    async shutdown(): Promise<void> {
        // The log file is opened per append, so there is no connection to close.
    }
}

const auditMailer = new AuditLogMailProvider({
    serviceName: "audit-mailer",
    logPath: "./mail-audit.jsonl",
});

console.log(auditMailer.serviceName); // "audit-mailer"

const result = await auditMailer.send({
    from: "noreply@example.com",
    to: "security@example.com",
    subject: "Audit entry",
    text: "User 42 signed in from a new device.",
});

console.log("Accepted:", result.accepted);
console.log("Message ID:", result.messageId);

await auditMailer.shutdown();
```

---

## See Also

- Overview — package scope, architecture, and dependency notes.
- Core Concepts — deep dives into `MailProvider`, the message model, both backends, and the plugin layer.
- Basic Usage — task-oriented walkthroughs for sending email, switching backends, and integrating with WebAFX.

---

# webafx-mailer Examples Library

A categorized collection of copy-paste ready examples covering every feature area of `blendsdk/webafx-mailer` — in-memory capture, real SMTP delivery, WebAFX plugin wiring, backend switching, testing, and custom providers. Every example is complete strict-mode TypeScript with full imports, ES modules, and top-level `await` (Node.js >= 22). SMTP examples target `smtp.example.com` placeholders — swap in real credentials; local SMTP examples target Mailpit on `localhost:1025`. Test examples additionally require Vitest.

---

## Getting Started with the Memory Backend

The in-memory backend is the fastest way to send (and capture) email — no mail server, no network, no Docker.

### Send Your First Email

Create a `MemoryMailProvider` and send a message; it is stored in process instead of being delivered.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

const result = await mailer.send({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Welcome!",
    text: "Welcome to our service!",
});

console.log("Accepted:", result.accepted);     // ["user@example.com"]
console.log("Rejected:", result.rejected);     // []
console.log("Message ID:", result.messageId);  // "<memory-...@test>" (timestamp + index)

const sent = mailer.getSentMessages();
console.log("Stored messages:", sent.length);            // 1
console.log("Stored subject:", sent[0].message.subject); // "Welcome!"

await mailer.shutdown();
```

### Inspect Sent Messages

`getSentMessages()` returns a shallow copy of every captured `SentMailEntry` (message plus result); `getLastMessage()` is a shortcut to the most recent one.

```typescript
import { MemoryMailProvider, type SentMailEntry } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

await mailer.send({
    from: "noreply@example.com",
    to: "first@example.com",
    subject: "First",
    text: "First message",
});

await mailer.send({
    from: "noreply@example.com",
    to: "second@example.com",
    subject: "Second",
    text: "Second message",
});

const entries: SentMailEntry[] = mailer.getSentMessages();
console.log("Count:", entries.length);                      // 2
console.log("First subject:", entries[0].message.subject);  // "First"
console.log("Second subject:", entries[1].message.subject); // "Second"

const last = mailer.getLastMessage();
console.log("Last subject:", last?.message.subject);   // "Second"
console.log("Last accepted:", last?.result.accepted);  // ["second@example.com"]

// getSentMessages() returns a shallow copy — trimming it does not affect the store.
const copy = mailer.getSentMessages();
copy.length = 0;
console.log("Store still holds:", mailer.getSentMessages().length); // 2

await mailer.shutdown();
```

### Clear and Reuse the Store

`clear()` empties the captured messages without recreating the provider — useful for resetting between scenarios.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

await mailer.send({ from: "a@example.com", to: "b@example.com", subject: "One", text: "1" });
await mailer.send({ from: "a@example.com", to: "b@example.com", subject: "Two", text: "2" });

console.log(mailer.getSentMessages().length); // 2

mailer.clear();

console.log(mailer.getSentMessages().length); // 0
console.log(mailer.getLastMessage());         // undefined

// The provider remains fully usable after a clear.
await mailer.send({ from: "a@example.com", to: "b@example.com", subject: "Three", text: "3" });
console.log(mailer.getLastMessage()?.message.subject); // "Three"

await mailer.shutdown();
```

---

## Sending Real Email over SMTP

Real delivery through nodemailer. All examples wrap `send()` in `try/finally` so the transport pool is always closed.

### Send via SMTP with STARTTLS (Port 587)

The modern default: `secure` is `false` and the connection upgrades through STARTTLS.

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false, // STARTTLS — `secure` defaults to false; shown here explicitly
    auth: {
        user: "user@example.com",
        pass: "secret",
    },
});

try {
    const result = await mailer.send({
        from: "noreply@example.com",
        to: "customer@example.com",
        subject: "Your receipt",
        text: "Thanks for your purchase.",
    });

    console.log("Accepted:", result.accepted);    // ["customer@example.com"]
    console.log("Message ID:", result.messageId); // server-assigned, e.g. "<...@smtp.example.com>"
} catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("SMTP send failed:", reason);
} finally {
    await mailer.shutdown();
}
```

**Result**: `accepted` lists the recipient and `messageId` is assigned by the SMTP server. Authentication or connection failures are thrown from `send()`.

### Send with Implicit TLS (Port 465)

Set `secure: true` for a direct TLS connection, conventionally on port 465.

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 465,
    secure: true, // implicit TLS — typically port 465
    auth: {
        user: "user@example.com",
        pass: "secret",
    },
});

try {
    const result = await mailer.send({
        from: "noreply@example.com",
        to: "customer@example.com",
        subject: "Secure delivery",
        text: "This message travels over an implicit TLS connection.",
    });

    console.log("Accepted:", result.accepted); // ["customer@example.com"]
} finally {
    await mailer.shutdown();
}
```

### Send to a Local SMTP Server Without Authentication

Omit the `auth` block for development servers such as Mailpit that accept unauthenticated mail.

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

// Start Mailpit locally with:
// docker-compose -p webafx-mailer -f ./docker/docker-compose.yml up -d
const mailer = new SmtpMailProvider({
    host: "localhost",
    port: 1025,
    secure: false,
});

try {
    const result = await mailer.send({
        from: "dev@example.com",
        to: "tester@example.com",
        subject: "Local delivery",
        text: "Inspect this message in the Mailpit web UI at http://localhost:8025",
    });

    console.log("Accepted:", result.accepted);    // ["tester@example.com"]
    console.log("Message ID:", result.messageId);
} finally {
    await mailer.shutdown();
}
```

---

## Recipients and Content

Address shapes, CC/BCC, display names, HTML bodies, and attachments.

### Send to Multiple Recipients

`to` accepts a single address or an array; every recipient is reported individually in the result.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

const result = await mailer.send({
    from: "news@example.com",
    to: ["alice@example.com", "bob@example.com", "carol@example.com"],
    subject: "Release notes",
    text: "Version 2.0 is out.",
});

console.log(result.accepted);
// ["alice@example.com", "bob@example.com", "carol@example.com"]

await mailer.shutdown();
```

### Use CC and BCC

`cc` and `bcc` follow the same single-or-array shape as `to`. On the memory backend, all of them appear in `accepted`.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

const result = await mailer.send({
    from: "hr@example.com",
    to: "candidate@example.com",
    cc: ["hiring-manager@example.com", "recruiter@example.com"],
    bcc: "audit@example.com",
    subject: "Interview invitation",
    text: "We would like to invite you to an interview.",
});

console.log(result.accepted);
// ["candidate@example.com", "hiring-manager@example.com",
//  "recruiter@example.com", "audit@example.com"]

await mailer.shutdown();
```

### Use Display Names in Addresses

`from` and recipient fields accept RFC 5322 display-name form (`"Name <email>"`).

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

const result = await mailer.send({
    from: "Acme Billing <billing@example.com>",
    to: ["Jane Doe <jane@example.com>", "ops@example.com"],
    subject: "Invoice available",
    text: "Your June invoice is ready.",
});

console.log(mailer.getLastMessage()?.message.from);
// "Acme Billing <billing@example.com>"
console.log(result.accepted);
// ["Jane Doe <jane@example.com>", "ops@example.com"]

await mailer.shutdown();
```

### Send HTML with a Plain-Text Fallback

Provide `text` and `html` together: capable clients render the HTML, while the text body serves as the fallback.

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "localhost",
    port: 1025,
    secure: false,
});

const result = await mailer.send({
    from: "noreply@example.com",
    to: "customer@example.com",
    subject: "Your order shipped",
    text: "Order #1234 has shipped. Track it at https://example.com/track/1234",
    html: [
        "<h1>Your order shipped</h1>",
        "<p>Order <strong>#1234</strong> is on its way.</p>",
        '<p><a href="https://example.com/track/1234">Track your package</a></p>',
    ].join(""),
});

console.log("Accepted:", result.accepted); // ["customer@example.com"]

await mailer.shutdown();
```

### Attach a File from Disk

Read a file into a `Buffer` and pass it as `content` with a `contentType` hint.

```typescript
import { readFile } from "node:fs/promises";
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "user@example.com", pass: "secret" },
});

const invoice = await readFile("./invoices/invoice-1042.pdf");

const result = await mailer.send({
    from: "billing@example.com",
    to: "customer@example.com",
    subject: "Invoice 1042",
    text: "Your invoice is attached.",
    attachments: [
        {
            filename: "invoice-1042.pdf",
            content: invoice, // Buffer straight from readFile
            contentType: "application/pdf",
        },
    ],
});

console.log("Accepted:", result.accepted); // ["customer@example.com"]

await mailer.shutdown();
```

### Attach Base64-Encoded Content

`content` also accepts a base64-encoded string — convenient when the data comes from an API or database column.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

const csv = "region,revenue\nEMEA,42000\nAPAC,31000";
const encoded = Buffer.from(csv, "utf-8").toString("base64");

await mailer.send({
    from: "reports@example.com",
    to: "management@example.com",
    subject: "Quarterly report",
    text: "The report is attached.",
    attachments: [
        {
            filename: "report.csv",
            content: encoded, // base64-encoded string
            contentType: "text/csv",
        },
    ],
});

const attachment = mailer.getLastMessage()?.message.attachments?.[0];
console.log(attachment?.filename); // "report.csv"
console.log(attachment?.contentType); // "text/csv"

await mailer.shutdown();
```

---

## WebAFX Plugin Integration

Adapt any provider into a `PluginDefinition`. Creating and inspecting plugins is fully standalone; actual `app.use()` registration requires a WebAFX application context and is shown as a fragment.

### Wrap an Existing Provider with createMailPlugin

`createMailPlugin()` wires any `MailProvider` — including custom subclasses — into WebAFX: singleton service registration, health hook, and shutdown hook.

```typescript
import { createMailPlugin, MemoryMailProvider } from "blendsdk/webafx-mailer";

// Own the provider yourself so you can keep asserting on it in tests.
const mailer = new MemoryMailProvider({ serviceName: "mailer" });

const plugin = createMailPlugin(mailer);

console.log(plugin.name);           // "mailer" — taken from provider.serviceName
console.log(plugin.priority);       // 30 — default plugin priority
console.log(typeof plugin.factory); // "function" — invoked by WebAFX at bootstrap

// When WebAFX runs the factory it registers the provider as a singleton
// service and wires health()/shutdown() into the application lifecycle.

await mailer.shutdown();
```

### One-Liner Memory Plugin

`memoryMailPlugin()` creates the `MemoryMailProvider` internally and returns a ready-to-use plugin.

```typescript
import { memoryMailPlugin } from "blendsdk/webafx-mailer";

const plugin = memoryMailPlugin();

console.log(plugin.name);     // "mailer"
console.log(plugin.priority); // 30

const namedPlugin = memoryMailPlugin({ serviceName: "dev-mailer" });
console.log(namedPlugin.name); // "dev-mailer"
```

### One-Liner SMTP Plugin

`smtpMailPlugin(config)` builds the SMTP provider from the config and wraps it in one call.

```typescript
import { smtpMailPlugin } from "blendsdk/webafx-mailer";

const plugin = smtpMailPlugin({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "user@example.com", pass: "secret" },
});

console.log(plugin.name);           // "mailer"
console.log(plugin.priority);       // 30
console.log(typeof plugin.factory); // "function"
```

### Register a Plugin in a WebAFX Application

Illustrative fragment — `app` and `services` are provided by the surrounding WebAFX application. The plugin registers the provider as a singleton under its service name; resolve it later with `services.get<MailProvider>("mailer")`.

```typescript fragment
import { memoryMailPlugin, type MailProvider } from "blendsdk/webafx-mailer";

// WebAFX application bootstrap
app.use(memoryMailPlugin());

// Anywhere in the application — resolve the registered singleton service:
const mailer = services.get<MailProvider>("mailer");

const result = await mailer.send({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Welcome!",
    text: "Welcome to our service!",
});

console.log(result.accepted); // ["user@example.com"]
```

### Configure Plugin Priority

Plugins default to priority `30`; lower values install earlier. Pass `{ priority }` as the second argument to `createMailPlugin()`. `0` is a valid priority.

```typescript
import { createMailPlugin, MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

console.log(createMailPlugin(mailer).priority);                  // 30 (default)
console.log(createMailPlugin(mailer, { priority: 5 }).priority); // 5
console.log(createMailPlugin(mailer, { priority: 0 }).priority); // 0 is valid

await mailer.shutdown();
```

### Register Multiple Mailers Under Distinct Service Names

Because the plugin name equals the service name, several providers can coexist in one application.

```typescript
import {
    createMailPlugin,
    MemoryMailProvider,
    SmtpMailProvider,
} from "blendsdk/webafx-mailer";

const transactionalMailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "user@example.com", pass: "secret" },
    serviceName: "transactional-mailer",
});

const marketingMailer = new MemoryMailProvider({ serviceName: "marketing-mailer" });

const transactionalPlugin = createMailPlugin(transactionalMailer);
const marketingPlugin = createMailPlugin(marketingMailer);

console.log(transactionalPlugin.name); // "transactional-mailer"
console.log(marketingPlugin.name);     // "marketing-mailer"

// In a WebAFX app: register both, then resolve by name:
// app.use(transactionalPlugin);
// app.use(marketingPlugin);

await transactionalMailer.shutdown();
await marketingMailer.shutdown();
```

---

## Configuration and Backend Switching

### Switch Backends per Environment with createMailProvider

`createMailProvider()` reads the `type` discriminator (`"smtp" | "memory"`) and returns the matching provider — production can use SMTP while development and CI use memory, with no other code changes.

```typescript
import {
    createMailPlugin,
    createMailProvider,
    type MailFactoryConfig,
    type MailProvider,
} from "blendsdk/webafx-mailer";

const isProduction = process.env.NODE_ENV === "production";

const config: MailFactoryConfig = {
    type: isProduction ? "smtp" : "memory",
    serviceName: isProduction ? "transactional-mailer" : "dev-mailer",
    host: process.env.SMTP_HOST ?? "localhost",
    port: Number(process.env.SMTP_PORT ?? "587"),
    secure: false,
    auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" }
        : undefined,
};

const mailer: MailProvider = createMailProvider(config);

console.log(mailer.serviceName);    // "dev-mailer" unless NODE_ENV === "production"
console.log(await mailer.health()); // true for the memory backend

// Wrap the selected provider as a WebAFX plugin.
const plugin = createMailPlugin(mailer);
console.log(plugin.name); // matches mailer.serviceName

await mailer.shutdown();
```

**Note**: when `type` can evaluate to `"smtp"`, always supply `host` and `port` — the factory forwards them straight to the nodemailer transport.

### Set a Custom Service Name

The default service name is exported as `DEFAULT_SERVICE_NAME` (`"mailer"`); override it per provider for multi-mailer setups.

```typescript
import { DEFAULT_SERVICE_NAME, MemoryMailProvider } from "blendsdk/webafx-mailer";

console.log(DEFAULT_SERVICE_NAME); // "mailer"

const defaultMailer = new MemoryMailProvider();
console.log(defaultMailer.serviceName); // "mailer"

const namedMailer = new MemoryMailProvider({ serviceName: "notifications-mailer" });
console.log(namedMailer.serviceName);   // "notifications-mailer"

await defaultMailer.shutdown();
await namedMailer.shutdown();
```

### Handle Unknown Backend Types

The factory validates `type` at runtime and throws a descriptive error — useful when the value comes from an environment variable that TypeScript cannot check.

```typescript
import { createMailProvider } from "blendsdk/webafx-mailer";

// Simulate an untyped value (e.g. from an environment variable).
const typeFromEnv: string = "sendgrid";

try {
    createMailProvider({ type: typeFromEnv as "smtp" });
} catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(reason);
    // Unknown mail type: "sendgrid". Supported types: "smtp", "memory".
}
```

---

## Testing Email Flows

The memory backend is purpose-built for tests: assert on `getSentMessages()` / `getLastMessage()` instead of hitting a real server.

### Test a Password Reset Email

A complete Vitest suite using `MemoryMailProvider` with lifecycle cleanup in `afterEach`.

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryMailProvider, type MailMessage } from "blendsdk/webafx-mailer";

describe("password reset flow", () => {
    let mailer: MemoryMailProvider;

    beforeEach(() => {
        mailer = new MemoryMailProvider();
    });

    afterEach(async () => {
        await mailer.shutdown();
    });

    it("sends the reset link to the user", async () => {
        const message: MailMessage = {
            from: "noreply@example.com",
            to: "user@example.com",
            subject: "Reset your password",
            text: "Open https://example.com/reset?token=abc123 to set a new password.",
        };

        const result = await mailer.send(message);

        expect(result.accepted).toEqual(["user@example.com"]);
        expect(result.rejected).toEqual([]);

        const last = mailer.getLastMessage();
        expect(last?.message.subject).toBe("Reset your password");
        expect(last?.message.text).toContain("token=abc123");
    });
});
```

### Assert All Recipient Types Are Accepted

The memory backend flattens `to` + `cc` + `bcc` into `accepted` and always reports `rejected: []`, with message IDs following the `<memory-…@test>` pattern.

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

describe("notification fan-out", () => {
    let mailer: MemoryMailProvider;

    beforeEach(() => {
        mailer = new MemoryMailProvider();
    });

    afterEach(async () => {
        await mailer.shutdown();
    });

    it("accepts every to, cc, and bcc recipient", async () => {
        const result = await mailer.send({
            from: "alerts@example.com",
            to: ["oncall@example.com", "sre@example.com"],
            cc: "lead@example.com",
            bcc: "archive@example.com",
            subject: "Service degraded",
            text: "Elevated error rate detected.",
        });

        expect(result.accepted).toEqual([
            "oncall@example.com",
            "sre@example.com",
            "lead@example.com",
            "archive@example.com",
        ]);
        expect(result.rejected).toEqual([]);
        expect(result.messageId).toMatch(/^<memory-\d+-\d+@test>$/);
    });
});
```

### Isolate Tests with clear() and shutdown()

`shutdown()` clears the store, so calling it in `afterEach` guarantees a clean slate; `clear()` resets state mid-test without recreating the provider.

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

describe("mail store isolation", () => {
    let mailer: MemoryMailProvider;

    beforeEach(() => {
        mailer = new MemoryMailProvider();
    });

    afterEach(async () => {
        await mailer.shutdown(); // clears the store as well
    });

    it("records only the email sent inside this test", async () => {
        expect(mailer.getSentMessages()).toHaveLength(0);

        await mailer.send({
            from: "a@example.com",
            to: "b@example.com",
            subject: "First",
            text: "Body",
        });

        expect(mailer.getSentMessages()).toHaveLength(1);

        // Reset mid-test without recreating the provider.
        mailer.clear();
        expect(mailer.getSentMessages()).toHaveLength(0);
        expect(mailer.getLastMessage()).toBeUndefined();
    });
});
```

---

## Custom Providers and Lifecycle

### Implement a Custom MailProvider

Any delivery mechanism can be plugged in by subclassing `MailProvider` — here, a provider that persists emails as JSON files on disk. Custom providers also work with `createMailPlugin()`.

```typescript
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
    MailProvider,
    type MailMessage,
    type MailProviderConfig,
    type MailResult,
} from "blendsdk/webafx-mailer";

/**
 * A custom MailProvider that persists emails as JSON files on disk.
 * Handy for local development when no SMTP server is running.
 */
class FileMailProvider extends MailProvider {
    private readonly outputDir: string;

    constructor(outputDir: string, config: MailProviderConfig = {}) {
        super(config);
        this.outputDir = outputDir;
    }

    async send(message: MailMessage): Promise<MailResult> {
        await mkdir(this.outputDir, { recursive: true });

        const safeSubject = message.subject.replace(/\W+/g, "-");
        const filename = `${Date.now()}-${safeSubject}.json`;
        await writeFile(
            join(this.outputDir, filename),
            JSON.stringify(message, null, 2),
            "utf-8"
        );

        const recipients = Array.isArray(message.to) ? message.to : [message.to];

        return {
            accepted: recipients,
            rejected: [],
            messageId: `<file-${filename}@local>`,
        };
    }

    async health(): Promise<boolean> {
        try {
            await mkdir(this.outputDir, { recursive: true });
            return true;
        } catch {
            return false;
        }
    }

    async shutdown(): Promise<void> {
        // Each send writes and closes its own file — nothing to release.
    }
}

const mailer = new FileMailProvider("./outbox", { serviceName: "file-mailer" });

console.log(mailer.serviceName); // "file-mailer"

const result = await mailer.send({
    from: "noreply@example.com",
    to: "dev@example.com",
    subject: "Local test",
    text: "Written to the outbox directory.",
});

console.log(result.accepted);       // ["dev@example.com"]
console.log(result.messageId);      // "<file-<filename>@local>"
console.log(await mailer.health()); // true

await mailer.shutdown();
```

### Check Backend Health

`health()` verifies the SMTP connection with an EHLO/HELO handshake (no email sent) and returns `false` instead of throwing when the server is unreachable; the memory backend is always healthy.

```typescript
import { MemoryMailProvider, SmtpMailProvider } from "blendsdk/webafx-mailer";

// Memory backend — no external dependencies, always healthy.
const memoryMailer = new MemoryMailProvider();
console.log(await memoryMailer.health()); // true

// SMTP backend — verify() checks the connection without sending mail.
const smtpMailer = new SmtpMailProvider({
    host: "localhost",
    port: 1025,
    secure: false,
});

console.log(await smtpMailer.health()); // true when an SMTP server listens on port 1025

// Unreachable server — health() reports false instead of throwing.
const unreachableMailer = new SmtpMailProvider({
    host: "localhost",
    port: 19999,
    secure: false,
});

console.log(await unreachableMailer.health()); // false

await memoryMailer.shutdown();
await smtpMailer.shutdown();
await unreachableMailer.shutdown();
```

### Shut Down Gracefully

`shutdown()` clears the memory store or closes the SMTP connection pool. In a WebAFX app the plugin wires this into graceful disposal automatically.

```typescript
import { MemoryMailProvider, SmtpMailProvider } from "blendsdk/webafx-mailer";

// --- Memory backend: shutdown() clears the message store ---------------
const memoryMailer = new MemoryMailProvider();

await memoryMailer.send({
    from: "a@example.com",
    to: "b@example.com",
    subject: "Stored",
    text: "Stored in memory.",
});

console.log(memoryMailer.getSentMessages().length); // 1

await memoryMailer.shutdown();

console.log(memoryMailer.getSentMessages().length); // 0

// --- SMTP backend: shutdown() closes the connection pool ---------------
const smtpMailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "user@example.com", pass: "secret" },
});

// While the transport is open, send() delivers messages. After shutdown(),
// the pool is closed and any further send() call fails — so call it last.
await smtpMailer.shutdown();
```

### Handle SMTP Send Failures

Connection errors, authentication failures, and send rejections are thrown from `send()` — wrap sends in `try/catch` and always close the transport in `finally`.

```typescript
import { SmtpMailProvider, type MailMessage } from "blendsdk/webafx-mailer";

// Point at a port where nothing is listening to trigger a connection failure.
const mailer = new SmtpMailProvider({
    host: "localhost",
    port: 19999,
    secure: false,
});

const message: MailMessage = {
    from: "noreply@example.com",
    to: "customer@example.com",
    subject: "Order confirmation",
    text: "Your order is confirmed.",
};

try {
    const result = await mailer.send(message);
    console.log("Accepted:", result.accepted);
} catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("Email delivery failed:", reason);
    // Typical output: Email delivery failed: connect ECONNREFUSED 127.0.0.1:19999
} finally {
    await mailer.shutdown();
}
```

---

## See Also

- Overview — package scope, architecture, and dependencies
- Core Concepts — deep dive into providers, the message model, and the plugin layer
- Basic Usage — task-oriented walkthroughs for common workflows

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
