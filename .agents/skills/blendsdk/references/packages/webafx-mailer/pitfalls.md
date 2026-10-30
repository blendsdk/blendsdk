> **Package**: `blendsdk/webafx-mailer`

# webafx-mailer Best Practices

`blendsdk/webafx-mailer` is a deliberately small package — one abstract contract (`MailProvider`), two interchangeable backends, and a thin WebAFX adapter — and almost every mistake with it is a lifecycle or contract mistake: providers created too often, never shut down, health checks placed in hot paths, or test helpers hidden behind one-liners. This document pairs each practice with the approach it replaces, then collects the recurring anti-patterns, performance tips, and security notes.

---

## Do / Don't Pairs

Each pair contrasts the problematic approach (❌ Wrong) with the recommended one (✅ Correct), followed by the reasoning. Pairs are numbered so the [Quick Reference](#quick-reference) and cross-references line up.

### 1. Program against `MailProvider`, not a concrete backend

❌ **Wrong** — depend on `SmtpMailProvider`:

```typescript fragment
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

// Business logic is welded to one backend: every test of this function
// now needs a real SMTP server.
async function sendPasswordReset(mailer: SmtpMailProvider, to: string): Promise<void> {
    await mailer.send({
        from: "noreply@example.com",
        to,
        subject: "Reset your password",
        text: "Use the link in this email to reset your password.",
    });
}
```

✅ **Correct** — depend on the abstract type:

```typescript fragment
import type { MailProvider } from "blendsdk/webafx-mailer";

// Any backend fits: SmtpMailProvider in production, MemoryMailProvider in
// tests, a custom subclass anywhere else.
async function sendPasswordReset(mailer: MailProvider, to: string): Promise<void> {
    await mailer.send({
        from: "noreply@example.com",
        to,
        subject: "Reset your password",
        text: "Use the link in this email to reset your password.",
    });
}
```

**Why**: backend interchangeability is the core design of the package — `SmtpMailProvider`, `MemoryMailProvider`, and custom subclasses all satisfy the same three-method contract, and `createMailPlugin()` accepts any of them. Typing against a concrete class re-couples every call site to one delivery mechanism, forces tests onto the network, and turns backend swapping into a refactoring project instead of a one-line composition change.

### 2. Create one provider per application — never per send

❌ **Wrong** — construct a transport for every email:

```typescript fragment
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

async function notifyCustomer(message: MailMessage): Promise<void> {
    // Fresh transport per call: full connection setup every time,
    // and the previous transport is never closed.
    const mailer = new SmtpMailProvider({ host: "smtp.example.com", port: 587 });
    await mailer.send(message);
}
```

✅ **Correct** — compose once, reuse everywhere:

```typescript fragment
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

// Created once at the composition root and reused for the process lifetime.
const mailer = new SmtpMailProvider({ host: "smtp.example.com", port: 587 });

async function notifyCustomer(message: MailMessage): Promise<void> {
    await mailer.send(message); // reuses the transport's connection handling
}
```

**Why**: a provider wraps exactly one nodemailer transport, and that transport is built to be long-lived — it manages connection pooling internally and only releases it via `shutdown()`. A provider-per-send throws that away, performs a fresh connection setup for every message, and leaks the abandoned transport. This is precisely why the WebAFX plugin registers the provider as an **application-wide singleton service**.

### 3. Shut down every provider you create

❌ **Wrong** — abandon the transport when you are done:

```typescript fragment
const mailer = new SmtpMailProvider({ host: "smtp.example.com", port: 587 });
await mailer.send(notification);
// No shutdown: the transport and its pooled connections are left for the GC.
```

✅ **Correct** — call `shutdown()` when the provider's job is done:

```typescript fragment
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({ host: "smtp.example.com", port: 587 });

try {
    await mailer.send(notification);
} finally {
    await mailer.shutdown(); // closes the transport / connection pool
}
```

**Why**: `shutdown()` is the package's terminal lifecycle call — on SMTP it closes the nodemailer transport and its connection pool; on the memory backend it clears the store. After calling it, subsequent `send()` calls fail, so treat it as final. The WebAFX plugin wires `shutdown()` into graceful application disposal for exactly this reason; standalone code must call it itself, and test suites should call it in `afterEach` (the package's own tests do).

### 4. Handle `send()` failures — SMTP throws, it does not return a status

❌ **Wrong** — assume every send resolves:

```typescript fragment
// Connection refused, bad credentials, or a send rejection — all of these
// reject the promise; nothing here notices.
await mailer.send(receipt);
markOrderAsNotified(orderId);
```

✅ **Correct** — catch, log the reason, and decide deliberately:

```typescript fragment
import type { MailMessage, MailProvider } from "blendsdk/webafx-mailer";

async function deliver(mailer: MailProvider, message: MailMessage): Promise<boolean> {
    try {
        await mailer.send(message);
        return true;
    } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown SMTP failure";
        console.error(`Email delivery failed: ${reason}`);
        return false; // caller decides: retry, alert, or surface to the user
    }
}
```

**Why**: `SmtpMailProvider.send()` rejects on connection failures, authentication failures, and send rejections — failure is always signalled by throwing, never by a boolean or status field. The memory backend never throws, which makes it an excellent test double but a dangerous way to *discover* missing error handling: code paths exercised only against `MemoryMailProvider` will never hit the catch branch, so review send sites explicitly.

### 5. Use `health()` for monitoring, not as a per-send precondition

❌ **Wrong** — gate every send behind a health check:

```typescript fragment
// verify() opens a connection and performs an EHLO/HELO handshake;
// then send() performs its own full connection sequence again.
if (await mailer.health()) {
    await mailer.send(message);
}
```

✅ **Correct** — let `send()` fail fast; poll `health()` where it belongs:

```typescript fragment
import { createMailPlugin } from "blendsdk/webafx-mailer";

// Register once — the plugin wires health() into the application's /health endpoint.
app.use(createMailPlugin(mailer));

// Hot paths call send() directly — connection problems surface as rejections.
await mailer.send(message);
```

**Why**: `health()` on the SMTP backend calls nodemailer's `verify()`, a full connection handshake performed without sending email. Using it as a gate roughly doubles the connection-setup work per message and still proves nothing about the next call — the server can fail between the check and the send, and `send()` already fails fast on its own. The plugin layer exists so `health()` can be polled on a schedule (health endpoints, readiness probes) independently of traffic.

### 6. In tests, wrap a `MemoryMailProvider` you own — don't hide it behind the one-liner

❌ **Wrong** — `memoryMailPlugin()` when the test needs assertions:

```typescript fragment
import { memoryMailPlugin } from "blendsdk/webafx-mailer";

// The provider instance lives and dies inside the plugin factory —
// there is no reference to call getSentMessages() or getLastMessage() on.
app.use(memoryMailPlugin());
```

✅ **Correct** — create the provider first, then adapt it:

```typescript fragment
import { createMailPlugin, MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider({ serviceName: "mailer" });
app.use(createMailPlugin(mailer));

// After the code under test has run, assert against the captured store:
expect(mailer.getSentMessages()).toHaveLength(1);
expect(mailer.getLastMessage()?.message.subject).toBe("Welcome!");
```

**Why**: `memoryMailPlugin()` constructs the provider internally and keeps the reference private — ideal for smoke setups, useless for assertions. `createMailPlugin()` adapts any provider you hand it, so owning the instance keeps the full test-helper surface (`getSentMessages`, `getLastMessage`, `clear`) available while still registering it as the application-wide singleton.

### 7. Reset the memory store between test cases

❌ **Wrong** — one shared store across the whole file:

```typescript fragment
// Module-level provider shared by every test: counts and "last message"
// assertions now depend on execution order.
const mailer = new MemoryMailProvider();

it("captures one welcome email", async () => {
    await mailer.send(welcome);
    expect(mailer.getSentMessages()).toHaveLength(1); // passes — for now
});

it("captures one reminder email", async () => {
    await mailer.send(reminder);
    expect(mailer.getSentMessages()).toHaveLength(1); // fails: 2 entries
});
```

✅ **Correct** — a fresh provider (or explicit reset) per test:

```typescript fragment
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

let mailer: MemoryMailProvider;

beforeEach(() => {
    mailer = new MemoryMailProvider();
});

afterEach(async () => {
    await mailer.shutdown(); // clears the store and releases resources
});
```

**Why**: the memory provider's store is append-only — nothing is discarded until `clear()` or `shutdown()` is called. A shared instance (or a provider registered as a singleton in a long-lived test app) accumulates messages across cases, so `getSentMessages()` lengths and `getLastMessage()` assertions silently depend on test order. The package's own memory tests create a fresh provider in `beforeEach` and shut it down in `afterEach`, and its SMTP tests clear the receiving server between cases — apply the same isolation discipline to your tests.

### 8. Treat `messageId` as optional

❌ **Wrong** — non-null assertion to silence the contract:

```typescript fragment
const result = await mailer.send(message);
const id = result.messageId!; // compiles by force, not by contract
persistTransportId(id.toUpperCase());
```

✅ **Correct** — branch on presence:

```typescript fragment
import type { MailResult } from "blendsdk/webafx-mailer";

function transportIdOf(result: MailResult): string {
    return result.messageId ?? "(no transport message id)";
}

const result = await mailer.send(message);
const id = transportIdOf(result);
```

**Why**: `MailResult.messageId` is deliberately optional so providers built on asynchronous APIs — the contract tests cite the Microsoft Graph style of "accepted without a transport identifier" — can satisfy the same interface. Both shipped backends populate it (SMTP from the server, memory with a synthetic `<memory-…@test>` value), but code that *depends* on the value breaks the moment a custom provider joins the mix. The package's own contract tests guard with `if (result.messageId !== undefined)`; do the same instead of reaching for `!`.

### 9. After SMTP sends, inspect `rejected` — success is not all-or-nothing

❌ **Wrong** — assume the send covered every recipient:

```typescript fragment
await mailer.send({
    from: "noreply@example.com",
    to: ["alice@example.com", "bob@example.com"],
    subject: "Release notes",
    text: "Here is what changed.",
});
// Done — but bob's mailbox quota was exceeded and the server said so
// in result.rejected, which was discarded.
```

✅ **Correct** — check the outcome the server reported:

```typescript fragment
const result = await mailer.send({
    from: "noreply@example.com",
    to: ["alice@example.com", "bob@example.com"],
    subject: "Release notes",
    text: "Here is what changed.",
});

if (result.rejected.length > 0) {
    console.warn(`SMTP server rejected: ${result.rejected.join(", ")}`);
    // flag, retry, or clean up the affected addresses
}
```

**Why**: `send()` throws for transport-level failures, but the SMTP conversation itself can complete while individual recipients are refused (unknown mailbox, quota exceeded, policy blocks). Those addresses land in `result.rejected` — not in an exception — so code that only catches errors will believe delivery was complete. `rejected` exists on every backend (the memory backend always returns `[]`), so inspecting it is portable across providers.

### 10. Set `secure` to match the port

❌ **Wrong** — implicit TLS on the STARTTLS port:

```typescript fragment
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

// Port 587 expects plaintext plus a STARTTLS upgrade; secure: true demands
// TLS from the first byte — the connection hangs or fails.
const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: true,
});
```

✅ **Correct** — use the pairings the defaults were designed around:

```typescript fragment
// Port 465 — implicit TLS from the first byte
const implicitTls = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 465,
    secure: true,
});

// Port 587 — STARTTLS (the default: secure defaults to false)
const starttls = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
});
```

**Why**: `secure` means "speak TLS immediately, before any SMTP dialogue" — correct for port 465, incorrect for 587, where the server expects a plaintext greeting that is then upgraded via STARTTLS. The provider defaults `secure` to `false` precisely because STARTTLS on 587 is the modern convention; only set it to `true` when the server genuinely uses implicit TLS.

### 11. Never fire-and-forget a `send()`

❌ **Wrong** — a floating promise:

```typescript fragment
// No await: a rejection becomes an unhandled rejection (process-fatal by
// default in modern Node) and the MailResult is lost.
mailer.send(notification);
```

✅ **Correct** — await it, or make background delivery explicit:

```typescript fragment
import type { MailMessage, MailProvider } from "blendsdk/webafx-mailer";

// Option A — wait for the outcome.
await mailer.send(notification);

// Option B — deliberate background delivery with its own error handling.
async function sendInBackground(mailer: MailProvider, message: MailMessage): Promise<void> {
    try {
        await mailer.send(message);
    } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown failure";
        console.error(`Background email failed: ${reason}`);
    }
}
```

**Why**: `send()` returns a promise that can reject, and Node treats unhandled rejections as process-fatal by default. Fire-and-forget also discards `MailResult` — the only place partial rejections surface (see practice 9) — so even "successful" background sends lose their observability. If delivery should not block the caller, wrap it in a named, error-handled async function like Option B instead of dropping the promise.

### 12. Give each provider a distinct `serviceName`

❌ **Wrong** — two providers, one registration identity:

```typescript fragment
import { memoryMailPlugin, smtpMailPlugin } from "blendsdk/webafx-mailer";

// Both default to serviceName "mailer": the plugins collide by name and
// the second registration can shadow the first in the service container.
app.use(smtpMailPlugin({ host: "smtp.example.com", port: 587 }));
app.use(memoryMailPlugin());
```

✅ **Correct** — name every mailer:

```typescript fragment
app.use(smtpMailPlugin({
    host: "smtp.example.com",
    port: 587,
    serviceName: "transactional-mailer",
}));
app.use(memoryMailPlugin({ serviceName: "dev-mailer" }));
```

**Why**: `serviceName` is the provider's single identity — it becomes both the plugin's `name` and the service-container registration key. Colliding names make resolution order-dependent and ambiguous, while distinct names support multi-mailer setups (transactional vs. marketing mail), exactly as the configuration documentation suggests. The name is read from the config at construction time, so set it there.

### 13. Provide a `text` body next to `html`

❌ **Wrong** — HTML-only messages:

```typescript fragment
await mailer.send({
    from: "noreply@example.com",
    to: user.email,
    subject: "Your invoice",
    html: "<h1>Your invoice is attached.</h1>",
});
```

✅ **Correct** — both parts, as the message model intends:

```typescript fragment
await mailer.send({
    from: "noreply@example.com",
    to: user.email,
    subject: "Your invoice",
    text: "Your invoice is attached.",
    html: "<h1>Your invoice is attached.</h1>",
});
```

**Why**: `MailMessage` documents `text` as the fallback body "used when HTML is also provided" — supplying the pair is what makes rich-plus-plain delivery possible. Text-only clients, accessibility tooling, and many spam heuristics read the plain-text part; sending `html` alone degrades all of them. Both fields are individually optional, but the documented guidance is to provide at least one body — and both when you can.

### Quick Reference

| # | Practice | Do | Don't |
| --- | --- | --- | --- |
| 1 | Dependency direction | Type against `MailProvider` | Concrete `SmtpMailProvider` in business logic |
| 2 | Provider lifetime | One instance per app, reused | New provider per send |
| 3 | Teardown | `shutdown()` on completion; `afterEach` in tests | Abandon transports |
| 4 | Failure handling | try/catch around `send()`; log and decide | Assume sends always resolve |
| 5 | Health checks | Health endpoints / readiness probes | Per-send precondition |
| 6 | Test assertions | Wrap your own `MemoryMailProvider` via `createMailPlugin()` | `memoryMailPlugin()` when asserting |
| 7 | Test isolation | Fresh provider or `clear()` per case | Shared accumulating store |
| 8 | `messageId` | Optional-check (`??`) | Non-null assertion (`!`) |
| 9 | `rejected` | Inspect after SMTP sends | Assume all recipients accepted |
| 10 | `secure` | Match port (465 → `true`, 587 → `false`) | Mismatch port and TLS mode |
| 11 | Background sends | Await or explicit error-handled task | Fire-and-forget promise |
| 12 | Multi-mailer | Distinct `serviceName` per provider | Colliding `"mailer"` defaults |
| 13 | Message bodies | `text` + `html` | `html` only |

---

## Anti-Patterns

These are the recurring integration mistakes, several of which the package's own tests and documentation explicitly steer away from.

### Hand-rolled provider mocks instead of `MemoryMailProvider`

Teams sometimes stub the provider by hand — a minimal subclass or a fake object — instead of using the backend the package ships for exactly this purpose:

```typescript fragment
import { MailProvider, type MailMessage, type MailResult } from "blendsdk/webafx-mailer";

// ❌ Reimplementing a test backend by hand — drifts from the real contract.
class FakeMailer extends MailProvider {
    readonly sent: MailMessage[] = [];

    async send(message: MailMessage): Promise<MailResult> {
        this.sent.push(message);
        return { accepted: [], rejected: [] };
        // Does not match real semantics: the shipped memory backend puts
        // every to/cc/bcc address into accepted.
    }

    async health(): Promise<boolean> {
        return true;
    }

    async shutdown(): Promise<void> {
        this.sent.length = 0; // "close enough"
    }
}
```

`MemoryMailProvider` is this backend — contract-tested against the same suite as the SMTP provider. It normalizes `to`/`cc`/`bcc` into `accepted`, generates pattern-checked `<memory-…@test>` message IDs, protects its store from array mutation, and keeps identity semantics (`toBe`) working for assertions. A hand-rolled fake drifts the moment any of that matters: a fake returning `accepted: []` passes your tests while the real backend reports recipients, and it can never tell you that your production code assumes `health()` throws.

**Do this instead**:

```typescript fragment
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

// ✅ The shipped backend already implements everything the fake tried to do.
const mailer = new MemoryMailProvider();
```

### Constructing providers from unvalidated configuration

`MailFactoryConfig` makes the SMTP fields optional because they are only read when `type === "smtp"` — which means this compiles:

```typescript fragment
import { createMailProvider } from "blendsdk/webafx-mailer";

// ❌ Compiles, but host/port may be undefined: the provider is created
// "successfully" and only fails on the first real send.
const mailer = createMailProvider({
    type: "smtp",
    host: process.env.SMTP_HOST,         // string | undefined
    port: Number(process.env.SMTP_PORT), // NaN when unset
});
```

The factory forwards these values straight into the transport — and `as` casts (`type: value as "smtp"`) are worse, because they hide the very configuration mistakes the factory's runtime guard is designed to surface with a clear error.

Validate once, at startup, and fail fast:

```typescript
import { createMailProvider, type MailProvider } from "blendsdk/webafx-mailer";

function requireEnv(name: string): string {
    const value = process.env[name];
    if (value === undefined || value === "") {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

const port = Number(requireEnv("SMTP_PORT"));
if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`SMTP_PORT must be a positive integer, received "${process.env.SMTP_PORT}"`);
}

const mailer: MailProvider = createMailProvider({
    type: "smtp",
    host: requireEnv("SMTP_HOST"),
    port,
    serviceName: "transactional-mailer",
});

console.log(`Mail provider ready: ${mailer.serviceName}`);
```

A misconfigured process should refuse to start (or fall back deliberately) — never discover the problem on the first customer email.

### The "temporary" memory backend in production

```typescript fragment
import { createMailPlugin, createMailProvider } from "blendsdk/webafx-mailer";

// ❌ No email leaves the process: messages pile up in memory forever.
const mailer = createMailProvider({ type: "memory" });
app.use(createMailPlugin(mailer));
```

The memory backend never sends anything, retains full message payloads (recipients, bodies, attachments) in process memory until `shutdown()`, and grows without bound as a stand-in "outbox". In production, "temporary" tends to become permanent — and every email that should have reached a customer is silently captured instead.

**Do this instead**: make the environment choice explicit, the way the configuration documentation shows, and validate the SMTP fields at startup (see the previous anti-pattern) so production cannot accidentally fall into the memory branch:

```typescript fragment
// ✅ Explicit, environment-driven choice.
const mailer = createMailProvider({
    type: process.env.NODE_ENV === "production" ? "smtp" : "memory",
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? "587"),
});
```

### Mutating message objects after `send()`

```typescript fragment
// ❌ The memory provider stores the message object by reference —
// mutating it later rewrites what getSentMessages() reports.
const message: MailMessage = { from, to, subject: "Order placed", text: "Thanks!" };

await mailer.send(message);
message.subject = "Order shipped"; // also changes the stored record

expect(mailer.getSentMessages()[0].message.subject).toBe("Order placed"); // fails
```

The memory provider deliberately stores the *same object* you passed so identity assertions (`toBe`) work — that is a feature for assertions and a trap for shared, mutable fixtures. Mutating a message after send corrupts earlier records and makes test failures depend on object reuse.

**Do this instead**: treat `MailMessage` objects as write-once. Build a fresh message per send, or spread immutable overrides:

```typescript fragment
const baseMessage: MailMessage = { from, to, text: "Thanks!" };

await mailer.send({ ...baseMessage, subject: "Order placed" });
await mailer.send({ ...baseMessage, subject: "Order shipped" });
```

### Silent catch around `send()`

```typescript fragment
// ❌ Failure is known and discarded: no log, no retry, no signal.
try {
    await mailer.send(receipt);
} catch {
    // ignore
}
```

An empty catch converts actionable SMTP failures — expired credentials, quota exhaustion, network outages — into invisible data loss. Because the package intentionally ships no retry queue or outbox, "what happens when sending fails" is a decision your application must make; the empty catch makes that decision implicitly and badly.

**Do this instead**: at minimum log the error with context, then make the policy explicit — rethrow so the caller can react, hand off to your own retry/outbox mechanism, or record the failure for manual follow-up.

### Asserting on SMTP delivery immediately after `send()` resolves

```typescript fragment
// ❌ Racy: send() completed, but the receiving system (a test mail server
// such as Mailpit, or any external sink) may not have indexed the message yet.
await mailer.send({ from, to, subject: "Race condition", text: "..." });
const received = await getMailpitMessages();
expect(received).toHaveLength(1); // flaky — empty now, stale later
```

Delivery to the SMTP server and *observability* of that delivery in the sink are two separate events; the naive assertion also trips over messages left behind by previous tests. The package's own integration tests solve both problems with a bounded polling helper that matches on a unique subject:

```typescript fragment
// ✅ Poll until the specific message appears (the package's tests allow up to
// 25 attempts at 200 ms), then assert on the matched message only.
async function waitForMessage(subject: string): Promise<MailpitMessage> {
    for (let attempt = 0; attempt < 25; attempt++) {
        const messages = await getMailpitMessages();
        const match = messages.find((m) => m.Subject === subject);
        if (match) return match;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out waiting for message "${subject}"`);
}
```

**Do this instead**: use unique subjects per test, clear the sink between tests, and poll with a bounded retry loop. Better yet, keep this style of test to a thin SMTP integration suite — unit tests should assert against `MemoryMailProvider`, where the message is stored synchronously and no polling is needed.

---

## Performance Tips

The package's performance profile is dominated by one thing — how you manage the provider lifecycle — plus a handful of backend-specific wins.

### Reuse one provider for the process lifetime

Each `SmtpMailProvider` owns one transport built for long-lived use: it manages its connection pooling internally, and `shutdown()` is the documented way to release it. A provider-per-send pays full connection setup (TCP + TLS + authentication) per message and abandons transports. The plugin layer registers providers as singletons for the same reason — reuse *is* the performance model.

### Keep `health()` off the send path

On SMTP, `health()` runs `verify()` — a complete connect + EHLO/HELO handshake performed without sending mail. Called before each send, it roughly doubles the connection-setup work per email and adds no safety (the check is inherently racy, and `send()` fails fast on its own). Schedule `health()` from your health endpoint or a readiness probe instead; one probe interval is plenty for monitoring.

### Batch recipients into one message

`to`/`cc`/`bcc` accept arrays, and a single `send()` with N recipients is one SMTP transaction instead of N. For small groups, list everyone directly; when recipients should not see each other, put the batch in `bcc`. Real-world servers cap recipients per message, so chunk very large audiences (newsletter scale) across multiple sends.

### Prefer `Buffer` attachment content over base64 strings

`MailAttachment.content` accepts `Buffer | string`; the string form is base64, which carries roughly 33% size overhead versus the binary data and requires a decode step in the transport. Use `Buffer` whenever the content is already binary (a file read, a generated PDF); use base64 only when that is the form you were handed.

### Use the memory backend in development and CI

`MemoryMailProvider.send()` is a synchronous array push — no network, no Docker, no flakiness. The package's unit tests run with it and need no infrastructure at all; only the SMTP integration suite requires the Mailpit container. Mirror that split: unit and most integration tests against the memory backend, a thin SMTP suite for wire-level confidence.

### Bound the memory store in long-lived processes

The memory backend's store is append-only: every captured message — including attachments — stays in memory until `clear()` or `shutdown()`. In tests that is a feature; in a long-running dev server it is a slow leak. Call `clear()` on a schedule (or after assertions) when the process handles many messages.

### Shut down promptly — especially in tests

`shutdown()` closes the transport pool (SMTP) or clears the store (memory). Test suites that create a provider per case and skip `shutdown()` accumulate pooled sockets across the run — the package's own suites put shutdown in `afterEach` for exactly this reason. For SMTP, a graceful close also lets the server release its session immediately instead of waiting for a timeout. Remember that post-shutdown sends fail, so shut down only when the provider is genuinely done.

---

## Security Considerations

### Keep TLS certificate validation enabled

The provider deliberately ships **no** hardcoded `tls.rejectUnauthorized: false` — validation is on by default, and the `tls` config option exists so you *can* relax it, not so you *should*. Disabling validation lets any on-path attacker impersonate the SMTP server and harvest credentials and message contents.

```typescript fragment
// ❌ Disables verification in ALL environments — man-in-the-middle territory.
new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    tls: { rejectUnauthorized: false },
});

// ✅ Keep the default (verify). Relax only against a local development
// server with a self-signed certificate, never for internet-facing SMTP.
new SmtpMailProvider({ host: "localhost", port: 1025, secure: false });
```

### Source credentials from the environment, never from source

`SmtpMailConfig.auth` is a plaintext `{ user, pass }`. Keep it out of the repository, out of source files, and out of logs — pass it from environment variables or a secret manager at startup:

```typescript fragment
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

// ✅ Secrets arrive at runtime; the source tree contains none.
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
if (!user || !pass) {
    throw new Error("SMTP_USER and SMTP_PASS must be set");
}

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    auth: { user, pass },
});
```

Also note what *not* to log: configuration objects (they carry `auth.pass`) and message bodies. The plugin's initialization log deliberately records only the service name and the provider class — keep your custom logging at the same level of restraint.

### Use TLS-capable ports so credentials and content are protected in transit

Port 465 wraps the entire session in TLS; port 587 performs a STARTTLS upgrade before authenticated delivery; port 25 is designed for server-to-server relay and is rarely the right choice for application mail with credentials. Pair the port with the correct `secure` value (see [practice 10](#10-set-secure-to-match-the-port)) and keep certificate validation on (above) — an encrypted connection whose certificate is never verified provides confidentiality against passive observers only.

### Treat `MailResult.accepted` as sensitive

`accepted` reflects the **envelope** recipients: on the memory backend it is `to` + `cc` + `bcc` flattened; on SMTP it maps the server's envelope response. That means BCC addresses — recipients deliberately hidden from the visible headers — can appear in it. Do not log `result.accepted` wholesale or ship it to third-party analytics; log counts, or mask addresses, if you must record the outcome.

### Keep the memory backend out of production

`MemoryMailProvider` retains every message's full payload — recipients, subjects, bodies, attachments — in plain process memory for the life of the provider. That is ideal for tests and wrong for production: besides sending nothing (see the anti-pattern above), it means PII and potentially sensitive documents sit in memory until the next `clear()` or `shutdown()`.

### Validate untrusted input before it becomes email content

Addresses, display names, and subjects frequently originate from end users or upstream systems. Pass them through the typed `MailMessage` fields rather than assembling raw header strings by concatenation, apply basic sanity checks at the boundary (address shape, length caps), and normalize user input to a single line for fields such as `subject`. Cheap validation up front prevents malformed headers and header-splitting style abuses from ever reaching the transport.

---

## Related Documents

- Overview — what the package is, its architecture, and dependency notes.
- Core Concepts — deep dive into `MailProvider`, the message model, both backends, and the plugin layer.
- Basic Usage — task-oriented walkthroughs for sending email, backend switching, and WebAFX integration.

---

# webafx-mailer Testing Patterns

This document describes how to test code that uses `blendsdk/webafx-mailer`. The package's own suite is built on Vitest and splits cleanly into two tiers:

- **Unit tests** use `MemoryMailProvider` and require no Docker, no network, and no SMTP server.
- **Integration tests** use `SmtpMailProvider` against a local [Mailpit](https://mailpit.axllent.org/) container, then assert on messages through Mailpit's REST API.

The package's internal tests import from `../src/*.js` because they exercise the sources directly. Consumer tests must import the public package subpath, `blendsdk/webafx-mailer`. Install the umbrella package with `npm install blendsdk` (or the yarn/pnpm/bun equivalent); a subpath such as `blendsdk/webafx-mailer` is an import path, not a separately installable package.

---

## Test Setup

### Test Stack

| Concern | Choice |
| --- | --- |
| Test runner | Vitest 4 (`vitest`, `@vitest/coverage-v8`) |
| Runtime | Node.js >= 22, ESM, `environment: "node"` |
| Language | TypeScript strict mode |
| Unit backend | `MemoryMailProvider` — stores messages in-process |
| SMTP integration backend | `SmtpMailProvider` against Mailpit |
| Mailpit ports | SMTP `1025`, REST API `8025` |
| Assertions | Vitest `expect`, plus `fetch` against the Mailpit API |

A practical consumer test layout:

```text
tests/
  helpers/
    mailer.ts
    mailpit.ts
  setup.ts
  unit/
    notifications.test.ts
  integration/
    smtp-mail-provider.test.ts
```

### Public Imports for Tests

Import only from the package root. The symbols most useful in tests are:

```typescript fragment
import {
    DEFAULT_SERVICE_NAME,
    MailProvider,
    MemoryMailProvider,
    SmtpMailProvider,
    createMailPlugin,
    createMailProvider,
    memoryMailPlugin,
    smtpMailPlugin,
} from "blendsdk/webafx-mailer";

import type {
    MailAttachment,
    MailFactoryConfig,
    MailMessage,
    MailProviderConfig,
    MailResult,
    MemoryMailConfig,
    SentMailEntry,
    SmtpMailConfig,
} from "blendsdk/webafx-mailer";
```

| Symbol | Kind | Typical test use |
| --- | --- | --- |
| `MemoryMailProvider` | class | Unit-test fake; inspect captured mail |
| `SmtpMailProvider` | class | Integration tests against Mailpit |
| `MailProvider` | abstract class | Type services and write stubs |
| `createMailPlugin` | function | Assert plugin metadata and priority |
| `smtpMailPlugin` / `memoryMailPlugin` | functions | Assert one-liner plugin definitions |
| `createMailProvider` | function | Assert backend selection and invalid-type errors |
| `DEFAULT_SERVICE_NAME` | constant | Assert default `"mailer"` service name |
| `MailMessage`, `MailResult`, `MailAttachment` | types | Build fixtures; type assertions |
| `SentMailEntry` | type | Type results from `getSentMessages()` |
| `SmtpMailConfig`, `MemoryMailConfig`, `MailFactoryConfig`, `MailProviderConfig` | types | Type test configuration objects |

### Vitest Configuration

A configuration that supports both tiers:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
        reporters: ["verbose"],
        testTimeout: 15_000,
        hookTimeout: 30_000,
        setupFiles: ["./tests/setup.ts"],
        // Mailpit is a shared external fixture. If SMTP tests are split across
        // multiple files, run files serially to avoid one file clearing another
        // file's messages. Remove this when each worker owns its own Mailpit.
        fileParallelism: false,
        coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
            exclude: ["src/**/*.d.ts"],
        },
    },
});
```

The package's scripts map to these testing tiers:

| Script | Command | Docker managed? | Purpose |
| --- | --- | --- | --- |
| `test:fast` | `vitest run --reporter=verbose` | No | One-shot run; Mailpit must already be running if SMTP tests are included |
| `test:watch` | `vitest watch --reporter=verbose` | No | Interactive TDD |
| `test:coverage` | `vitest run --coverage` | No | Coverage run with the V8 provider |
| `test` | `docker:down && docker:up && vitest run --reporter=verbose && docker:down` | Yes | Full suite with Mailpit lifecycle |
| `docker:up` | compose up + `scripts/wait-for-mailpit.mjs` | Starts Mailpit | Start Mailpit and wait for readiness |
| `docker:down` | compose down `-v --remove-orphans` | Stops Mailpit | Remove container and volume |
| `docker:logs` | compose logs `mailpit` | — | Inspect Mailpit logs |

`test:fast` does **not** start Docker. Run it with Mailpit already up, or filter to the unit-only test files.

### Docker and Mailpit

Docker is required only for `SmtpMailProvider` tests and for the SMTP half of the contract suite. `MemoryMailProvider` and all plugin-metadata tests run without Docker.

```bash
# Start Mailpit and wait for its API to become ready
pnpm run docker:up

# Full suite: stops any old container, starts Mailpit, runs Vitest, stops Mailpit
pnpm test

# Stop Mailpit and delete its message volume
pnpm run docker:down

# Tail Mailpit logs
pnpm run docker:logs
```

The compose file path includes an optional `MODE` suffix: `./docker/docker-compose${MODE}.yml`. An empty `MODE` selects `docker-compose.yml`; `MODE=.ci` would select `docker-compose.ci.yml` when present.

Mailpit exposes:

| Endpoint | Purpose |
| --- | --- |
| `localhost:1025` | SMTP listener used by `SmtpMailProvider` |
| `GET http://localhost:8025/api/v1/messages` | List indexed messages as `{ messages: MailpitMessage[] }` |
| `DELETE http://localhost:8025/api/v1/messages` | Clear all messages between tests |

The package's own SMTP coverage is deliberately split so failures point at the right layer:

| Test file | Docker needed | What it covers |
| --- | --- | --- |
| `memory-mail-provider.test.ts` | No | Memory provider contract, helpers, lifecycle |
| `mail-plugin.test.ts` | No | Plugin factory metadata, priorities, backend factory |
| `smtp-mail-provider.test.ts` | Yes | Real SMTP send verified through Mailpit's REST API |
| `abstract-contract.test.ts` | Only for SMTP half | Shared `MailProvider` contract across both backends |

### Test Helpers

#### Provider Cleanup Helper

`MemoryMailProvider.shutdown()` clears its store, and `SmtpMailProvider.shutdown()` closes the transport. Always release providers after a test. A tracked-provider helper keeps that boilerplate out of individual files:

```typescript
// tests/helpers/mailer.ts
import {
    MemoryMailProvider,
    type MailProvider,
    type MemoryMailConfig,
} from "blendsdk/webafx-mailer";

const activeProviders: MailProvider[] = [];

/**
 * Create a MemoryMailProvider that is shut down by the global test setup.
 */
export function createTestMailer(config?: MemoryMailConfig): MemoryMailProvider {
    const mailer = new MemoryMailProvider(config);
    activeProviders.push(mailer);
    return mailer;
}

/**
 * Track any provider for automatic shutdown after the current test.
 */
export function trackProvider<T extends MailProvider>(provider: T): T {
    activeProviders.push(provider);
    return provider;
}

/**
 * Shut down every tracked provider. Cleanup failures must not mask test failures.
 */
export async function shutdownTrackedProviders(): Promise<void> {
    for (const provider of activeProviders) {
        try {
            await provider.shutdown();
        } catch {
            // Ignore shutdown failures during cleanup.
        }
    }
    activeProviders.length = 0;
}
```

```typescript
// tests/setup.ts
import { afterEach } from "vitest";
import { shutdownTrackedProviders } from "./helpers/mailer.js";

afterEach(async () => {
    await shutdownTrackedProviders();
});
```

#### Mailpit Helper Module

`waitForMessage()` is the most important integration helper. Mailpit indexes messages asynchronously after the SMTP transaction completes, so an immediate `GET /api/v1/messages` can miss the message that was just sent. Poll for the expected subject instead of using a fixed sleep.

```typescript
// tests/helpers/mailpit.ts
import { connect } from "node:net";
import type { SmtpMailConfig } from "blendsdk/webafx-mailer";

export const MAILPIT_API = "http://localhost:8025/api/v1";
export const MAILPIT_SMTP_HOST = "localhost";
export const MAILPIT_SMTP_PORT = 1025;

export const MAILPIT_SMTP_CONFIG: SmtpMailConfig = {
    host: MAILPIT_SMTP_HOST,
    port: MAILPIT_SMTP_PORT,
    secure: false,
};

export interface MailpitMessage {
    ID: string;
    From: { Address: string; Name: string };
    To: Array<{ Address: string; Name: string }>;
    Cc: Array<{ Address: string; Name: string }>;
    Bcc: Array<{ Address: string; Name: string }>;
    Subject: string;
    Snippet: string;
    Attachments: number;
}

/**
 * Fetch every message currently indexed by Mailpit.
 */
export async function getMailpitMessages(): Promise<MailpitMessage[]> {
    const response = await fetch(`${MAILPIT_API}/messages`);
    const data = (await response.json()) as { messages: MailpitMessage[] };
    return data.messages ?? [];
}

/**
 * Poll Mailpit until a message with the given subject appears.
 * Polling avoids the race between SMTP delivery and Mailpit indexing.
 */
export async function waitForMessage(subject: string): Promise<MailpitMessage> {
    const maxAttempts = 25;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const messages = await getMailpitMessages();
        const match = messages.find((message) => message.Subject === subject);

        if (match) {
            return match;
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }

    throw new Error(`Timed out waiting for Mailpit message with subject "${subject}"`);
}

/**
 * Delete all messages so tests do not see stale mail from earlier tests.
 */
export async function clearMailpit(): Promise<void> {
    await fetch(`${MAILPIT_API}/messages`, { method: "DELETE" });
}

/**
 * Check whether a TCP port accepts connections.
 */
export function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const socket = connect({ host, port });

        const finish = (reachable: boolean): void => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(reachable);
        };

        socket.setTimeout(timeoutMs);
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.once("timeout", () => finish(false));
    });
}

/**
 * Wait for Mailpit's SMTP listener before contract or integration tests.
 * `docker compose up -d` does not wait for the healthcheck, and a fixed sleep
 * is unreliable on loaded CI runners.
 */
export async function waitForSmtp(): Promise<void> {
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
        if (await canConnect(MAILPIT_SMTP_HOST, MAILPIT_SMTP_PORT, 1_000)) {
            return;
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(
        `Mailpit SMTP at ${MAILPIT_SMTP_HOST}:${MAILPIT_SMTP_PORT} did not become ready within 30 seconds.`
    );
}
```

### Synchronous vs Asynchronous Patterns

Constructors, `serviceName`, plugin metadata, and invalid factory configurations are synchronous and should use plain `expect`. Delivery, health checks, and shutdown are asynchronous and should always be awaited.

```typescript
import { describe, expect, it } from "vitest";
import { createMailProvider, MemoryMailProvider } from "blendsdk/webafx-mailer";

describe("synchronous and asynchronous test patterns", () => {
    it("checks configuration synchronously", () => {
        const mailer = new MemoryMailProvider();

        expect(mailer.serviceName).toBe("mailer");
        expect(() =>
            createMailProvider({ type: "nope" as "smtp" })
        ).toThrow('Unknown mail type: "nope"');
    });

    it("awaits delivery and shutdown", async () => {
        const mailer = new MemoryMailProvider();

        await expect(
            mailer.send({
                from: "sender@test.com",
                to: "recipient@test.com",
                subject: "Hello",
                text: "Hello from the test.",
            })
        ).resolves.toMatchObject({
            accepted: ["recipient@test.com"],
            rejected: [],
        });

        await mailer.shutdown();
    });
});
```

Use `await expect(promise).resolves` and `await expect(promise).rejects` rather than returning a bare promise. Do not leave `send()` or `shutdown()` promises unresolved — Vitest may finish the test before the operation completes.

---

## Unit Testing

Unit tests use `MemoryMailProvider` as a fully functional fake. It satisfies the entire `MailProvider` contract and additionally exposes `getSentMessages()`, `getLastMessage()`, and `clear()`, so tests can assert on what was sent without mocking the package.

### Pattern: Inject a MemoryMailProvider Into the Unit Under Test

The service under test depends on the abstract `MailProvider`, not on a concrete SMTP or memory class. That makes the memory backend a drop-in replacement in tests.

```typescript
// src/notifications.ts
import type { MailMessage, MailProvider, MailResult } from "blendsdk/webafx-mailer";

export interface WelcomeUser {
    email: string;
    displayName: string;
}

export class NotificationService {
    constructor(private readonly mailer: MailProvider) {}

    async sendWelcome(user: WelcomeUser): Promise<MailResult> {
        const message: MailMessage = {
            from: "noreply@example.com",
            to: user.email,
            subject: `Welcome, ${user.displayName}!`,
            text: `Welcome aboard, ${user.displayName}!`,
            html: `<h1>Welcome aboard, ${user.displayName}!</h1>`,
        };

        return this.mailer.send(message);
    }
}
```

```typescript
// tests/unit/notifications.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import { NotificationService } from "../../src/notifications.js";

describe("NotificationService.sendWelcome", () => {
    let mailer: MemoryMailProvider;
    let service: NotificationService;

    beforeEach(() => {
        mailer = new MemoryMailProvider();
        service = new NotificationService(mailer);
    });

    afterEach(async () => {
        await mailer.shutdown();
    });

    it("sends exactly one welcome email to the new user", async () => {
        const result = await service.sendWelcome({
            email: "alice@example.com",
            displayName: "Alice",
        });

        expect(result.accepted).toEqual(["alice@example.com"]);
        expect(result.rejected).toEqual([]);

        const sent = mailer.getSentMessages();
        expect(sent).toHaveLength(1);
        expect(sent[0].message).toMatchObject({
            from: "noreply@example.com",
            to: "alice@example.com",
            subject: "Welcome, Alice!",
        });
    });

    it("sends both text and HTML bodies", async () => {
        await service.sendWelcome({
            email: "bob@example.com",
            displayName: "Bob",
        });

        const message = mailer.getLastMessage()?.message;

        expect(message?.text).toContain("Welcome aboard, Bob!");
        expect(message?.html).toContain("<h1>Welcome aboard, Bob!</h1>");
    });
});
```

### Pattern: Assert Configuration and Plugin Metadata Without I/O

Plugin metadata is entirely synchronous. `createMailPlugin()` returns a `PluginDefinition` immediately; `provider.serviceName`, `plugin.name`, and `plugin.priority` can be asserted without starting a WebAFX application.

```typescript
// tests/unit/mail-plugin.test.ts
import { describe, expect, it } from "vitest";
import {
    createMailPlugin,
    createMailProvider,
    DEFAULT_SERVICE_NAME,
    MemoryMailProvider,
    memoryMailPlugin,
    SmtpMailProvider,
    smtpMailPlugin,
} from "blendsdk/webafx-mailer";
import { trackProvider } from "../helpers/mailer.js";

describe("synchronous configuration and plugin metadata", () => {
    it("resolves the default service name", () => {
        const mailer = new MemoryMailProvider();

        expect(DEFAULT_SERVICE_NAME).toBe("mailer");
        expect(mailer.serviceName).toBe("mailer");
    });

    it("derives the plugin name from provider.serviceName and defaults priority to 30", () => {
        const mailer = new MemoryMailProvider({
            serviceName: "transactional-mailer",
        });

        const plugin = createMailPlugin(mailer);

        expect(plugin.name).toBe("transactional-mailer");
        expect(plugin.priority).toBe(30);
        expect(typeof plugin.factory).toBe("function");
    });

    it("accepts explicit priority values, including zero", () => {
        const mailer = new MemoryMailProvider();

        expect(createMailPlugin(mailer, { priority: 0 }).priority).toBe(0);
        expect(createMailPlugin(mailer, { priority: 10 }).priority).toBe(10);
    });

    it("maps factory configuration to the matching provider class", () => {
        const memory = trackProvider(
            createMailProvider({ type: "memory", serviceName: "dev-mailer" })
        );
        const smtp = trackProvider(
            createMailProvider({ type: "smtp", host: "localhost", port: 1025 })
        );

        expect(memory).toBeInstanceOf(MemoryMailProvider);
        expect(memory.serviceName).toBe("dev-mailer");
        expect(smtp).toBeInstanceOf(SmtpMailProvider);
    });

    it("throws synchronously for an unknown backend type", () => {
        expect(() =>
            createMailProvider({ type: "sendgrid" as "smtp" })
        ).toThrow(
            'Unknown mail type: "sendgrid". Supported types: "smtp", "memory".'
        );
    });

    it("wraps both built-in backends in PluginDefinitions", () => {
        expect(memoryMailPlugin({ serviceName: "dev-mailer" }).name).toBe("dev-mailer");
        expect(
            smtpMailPlugin({
                host: "localhost",
                port: 1025,
                secure: false,
                serviceName: "smtp-mailer",
            }).name
        ).toBe("smtp-mailer");
    });
});
```

The one-liner plugin factories own their internal provider. This test only inspects the returned `PluginDefinition`; it never invokes `factory()` and never calls `send()` or `health()`, so no SMTP connection is opened. The package's own plugin tests follow the same rule.

### Pattern: Simulate Transport Failures With Spies

Use `vi.spyOn()` when a single test needs a transient failure while keeping the rest of the real provider behavior. Restore spies after every test so failures do not leak.

```typescript
// tests/unit/notifications-failure.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import { NotificationService } from "../../src/notifications.js";

describe("NotificationService failure handling", () => {
    let mailer: MemoryMailProvider;
    let service: NotificationService;

    beforeEach(() => {
        mailer = new MemoryMailProvider();
        service = new NotificationService(mailer);
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await mailer.shutdown();
    });

    it("propagates transport failures to the caller", async () => {
        vi.spyOn(mailer, "send").mockRejectedValueOnce(
            new Error("SMTP connection refused")
        );

        await expect(
            service.sendWelcome({
                email: "alice@example.com",
                displayName: "Alice",
            })
        ).rejects.toThrow("SMTP connection refused");
    });
});
```

Because the spy replaces the implementation for that call, the message is not captured in the memory store. Assert on the rejection, not on `getSentMessages()`.

### Pattern: Test Capture, Inspection Helpers, Health, and Shutdown

The memory provider's contract and helper methods can be tested directly. These tests require no Docker.

```typescript
// tests/unit/memory-mail-provider.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    MemoryMailProvider,
    type MailAttachment,
    type MailMessage,
    type SentMailEntry,
} from "blendsdk/webafx-mailer";

const baseMessage: MailMessage = {
    from: "sender@test.com",
    to: "recipient@test.com",
    subject: "Base",
    text: "Hello",
};

describe("MemoryMailProvider capture and inspection", () => {
    let mailer: MemoryMailProvider;

    beforeEach(() => {
        mailer = new MemoryMailProvider();
    });

    afterEach(async () => {
        await mailer.shutdown();
    });

    it("stores messages in order and exposes the last one", async () => {
        await mailer.send({ ...baseMessage, subject: "First" });
        await mailer.send({ ...baseMessage, subject: "Second" });

        const sent: SentMailEntry[] = mailer.getSentMessages();

        expect(sent).toHaveLength(2);
        expect(sent.map((entry) => entry.message.subject)).toEqual([
            "First",
            "Second",
        ]);
        expect(mailer.getLastMessage()?.message.subject).toBe("Second");
    });

    it("flattens to, cc and bcc into accepted", async () => {
        const result = await mailer.send({
            ...baseMessage,
            to: ["alice@test.com", "bob@test.com"],
            cc: "carol@test.com",
            bcc: ["dave@test.com", "erin@test.com"],
        });

        expect(result.accepted).toEqual([
            "alice@test.com",
            "bob@test.com",
            "carol@test.com",
            "dave@test.com",
            "erin@test.com",
        ]);
        expect(result.rejected).toEqual([]);
    });

    it("generates unique memory message ids", async () => {
        const first = await mailer.send(baseMessage);
        const second = await mailer.send(baseMessage);

        expect(first.messageId).toMatch(/^<memory-\d+-\d+@test>$/);
        expect(second.messageId).toMatch(/^<memory-\d+-\d+@test>$/);
        expect(first.messageId).not.toBe(second.messageId);
    });

    it("stores attachments by reference", async () => {
        const attachment: MailAttachment = {
            filename: "report.txt",
            content: Buffer.from("Revenue: 42"),
            contentType: "text/plain",
        };

        await mailer.send({ ...baseMessage, attachments: [attachment] });

        const stored = mailer.getLastMessage()?.message.attachments?.[0];

        expect(stored).toBe(attachment);
        expect(stored?.content).toEqual(Buffer.from("Revenue: 42"));
    });

    it("returns a defensive copy of the message list", async () => {
        await mailer.send(baseMessage);

        const firstCopy = mailer.getSentMessages();
        const secondCopy = mailer.getSentMessages();
        firstCopy.length = 0;

        expect(firstCopy).not.toBe(secondCopy);
        expect(mailer.getSentMessages()).toHaveLength(1);
    });

    it("clears messages on clear() and shutdown()", async () => {
        await mailer.send(baseMessage);
        mailer.clear();
        expect(mailer.getSentMessages()).toHaveLength(0);

        await mailer.send(baseMessage);
        await mailer.shutdown();
        expect(mailer.getSentMessages()).toHaveLength(0);
    });

    it("reports healthy with no external dependencies", async () => {
        await expect(mailer.health()).resolves.toBe(true);
    });
});
```

Important details:

- `getSentMessages()` returns a shallow copy of the array. Mutating the copy does not affect the provider, but the `message` and `result` objects inside are the originals.
- `getLastMessage()` returns `undefined` before any send and after `clear()`.
- `shutdown()` on the memory provider clears the store. Never call it before inspecting messages.
- `messageId` follows `^<memory-\d+-\d+@test>$` and is unique across consecutive sends.

### Unit Test Checklist

| Area | Assertions |
| --- | --- |
| Constructor | `serviceName` defaults to `"mailer"`; custom names are preserved; empty config is accepted |
| Initial state | `getSentMessages()` is empty; `getLastMessage()` is `undefined` |
| `send()` | Message stored; multiple sends preserve order; result contains `accepted`, `rejected`, `messageId` |
| Recipients | `to`, `cc`, `bcc` accept `string` and `string[]`; accepted order is `to` → `cc` → `bcc` |
| Attachments | Stored by reference; `Buffer` and base64 string content preserved |
| Inspection | `getSentMessages()` is a copy; `getLastMessage()` returns the newest entry; `clear()` empties the store |
| Health | `health()` resolves to `true` |
| Shutdown | Resolves without throwing; memory store is empty afterward |
| Plugins | `plugin.name` equals `provider.serviceName`; default priority is `30`; custom priority including `0` works |
| Factory | Correct provider class per `type`; `serviceName` passed through; unknown types throw synchronously |

---

## Integration Testing

Integration tests use `SmtpMailProvider` against Mailpit, a fake SMTP server with a REST API for inspecting received mail. These tests catch adapter bugs that memory-backend tests cannot: recipient serialization, attachment mapping, SMTP transport configuration, and result parsing from nodemailer.

### Starting Mailpit

```bash
# Start Mailpit and wait for the HTTP API
pnpm run docker:up

# Verify Mailpit is reachable
curl http://localhost:8025/api/v1/messages
```

The `pnpm test` script performs the full lifecycle automatically: it stops any previous container, starts Mailpit, runs Vitest, and stops Mailpit again. `pnpm run docker:down` also removes the message volume, giving the next run a clean slate.

### Pattern: End-to-End SMTP Send Verified Through Mailpit

Always wait for the SMTP port before running tests, clear messages between tests, and poll the API for the expected subject after `send()` resolves.

```typescript
// tests/integration/smtp-mail-provider.test.ts
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SmtpMailProvider, type MailMessage } from "blendsdk/webafx-mailer";
import {
    clearMailpit,
    MAILPIT_SMTP_CONFIG,
    waitForMessage,
    waitForSmtp,
} from "../helpers/mailpit.js";

describe("SmtpMailProvider (Mailpit integration)", () => {
    let mailer: SmtpMailProvider;

    beforeAll(async () => {
        await waitForSmtp();
    }, 30_000);

    beforeEach(async () => {
        mailer = new SmtpMailProvider(MAILPIT_SMTP_CONFIG);
        await clearMailpit();
    });

    afterEach(async () => {
        if (mailer) {
            await mailer.shutdown();
        }
    });

    it("delivers text, HTML, CC and attachments to Mailpit", async () => {
        const message: MailMessage = {
            from: "sender@test.com",
            to: ["alice@test.com", "bob@test.com"],
            cc: "carol@test.com",
            subject: "SMTP Integration Test",
            text: "Hello from SMTP.",
            html: "<p>Hello from SMTP.</p>",
            attachments: [
                {
                    filename: "report.txt",
                    content: Buffer.from("quarterly report"),
                    contentType: "text/plain",
                },
            ],
        };

        const result = await mailer.send(message);

        expect(result.accepted).toContain("alice@test.com");
        expect(result.accepted).toContain("bob@test.com");
        expect(result.accepted).toContain("carol@test.com");
        expect(result.rejected).toEqual([]);
        expect(result.messageId).toBeDefined();

        const received = await waitForMessage("SMTP Integration Test");

        expect(received.From.Address).toBe("sender@test.com");
        expect(received.To.map((entry) => entry.Address)).toEqual(
            expect.arrayContaining(["alice@test.com", "bob@test.com"])
        );
        expect(received.Cc.map((entry) => entry.Address)).toContain("carol@test.com");
        expect(received.Attachments).toBe(1);
    });

    it("reports healthy when Mailpit is reachable", async () => {
        await expect(mailer.health()).resolves.toBe(true);
    });

    it("reports unhealthy and throws send errors for an unreachable server", async () => {
        const offline = new SmtpMailProvider({
            host: "localhost",
            port: 19999,
            secure: false,
        });

        try {
            await expect(offline.health()).resolves.toBe(false);

            await expect(
                offline.send({
                    from: "sender@test.com",
                    to: "recipient@test.com",
                    subject: "Unreachable",
                    text: "This send must fail.",
                })
            ).rejects.toThrow();
        } finally {
            await offline.shutdown();
        }
    });
});
```

Key points:

- `waitForSmtp()` runs in `beforeAll` with a 30-second timeout. It checks the SMTP port actually used by the tests, not just the HTTP API.
- `clearMailpit()` runs before each test. Without it, `waitForMessage()` could match a message from a previous test.
- `waitForMessage()` polls until Mailpit has indexed the message. Do not replace it with an immediate `getMailpitMessages()` call or a fixed sleep.
- Assert both sides: `MailResult` proves what nodemailer reported, and Mailpit proves what the server received.
- For negative tests, use an unused port such as `19999`. `health()` must resolve to `false` rather than throw, while `send()` must reject.

### Pattern: Shared Contract Suite Across Backends

Contract tests run the same behavioral suite against every backend. This catches drift between `MemoryMailProvider` and `SmtpMailProvider` and gives custom providers a ready-made acceptance suite.

```typescript
// tests/integration/abstract-contract.test.ts
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
    MemoryMailProvider,
    SmtpMailProvider,
    type MailMessage,
    type MailProvider,
} from "blendsdk/webafx-mailer";
import {
    clearMailpit,
    MAILPIT_SMTP_CONFIG,
    waitForSmtp,
} from "../helpers/mailpit.js";

const contractMessage: MailMessage = {
    from: "contract-sender@test.com",
    to: "contract-recipient@test.com",
    subject: "Contract Test",
    text: "Testing the MailProvider contract.",
};

/**
 * Shared contract suite for any MailProvider implementation.
 */
function runContractTests(
    name: string,
    factory: () => MailProvider,
    beforeEachHook?: () => Promise<void>
): void {
    describe(`MailProvider contract: ${name}`, () => {
        let provider: MailProvider;

        beforeEach(async () => {
            if (beforeEachHook) {
                await beforeEachHook();
            }
            provider = factory();
        });

        afterEach(async () => {
            // Guard against a failed beforeEach hook leaving provider undefined.
            if (provider) {
                await provider.shutdown();
            }
        });

        it("reports every recipient as accepted", async () => {
            const result = await provider.send(contractMessage);

            expect(result.accepted).toContain("contract-recipient@test.com");
            expect(result.rejected).toEqual([]);
        });

        it("returns a non-empty message id when the backend supplies one", async () => {
            const result = await provider.send(contractMessage);

            if (result.messageId !== undefined) {
                expect(typeof result.messageId).toBe("string");
                expect(result.messageId.length).toBeGreaterThan(0);
            }
        });

        it("reports health as true while operational", async () => {
            await expect(provider.health()).resolves.toBe(true);
        });

        it("shuts down without throwing", async () => {
            await expect(provider.shutdown()).resolves.toBeUndefined();
        });

        it("exposes the configured service name", () => {
            expect(provider.serviceName).toBe("mailer");
        });
    });
}

// Memory backend — no Docker required.
runContractTests("MemoryMailProvider", () => new MemoryMailProvider());

// SMTP backend — requires Mailpit.
describe("SmtpMailProvider (Mailpit)", () => {
    beforeAll(async () => {
        await waitForSmtp();
    }, 30_000);

    runContractTests(
        "SmtpMailProvider",
        () => new SmtpMailProvider(MAILPIT_SMTP_CONFIG),
        clearMailpit
    );
});
```

If you write a custom `MailProvider`, register it with `runContractTests()` as well. The suite asserts only the shared contract: accepted recipients, rejected array, optional message ID, health semantics, shutdown, and default service name.

### Integration Guidelines

1. **Wait for the SMTP port, not just HTTP.** `docker compose up -d` returns before the healthcheck succeeds. `waitForSmtp()` checks the port the tests actually use.
2. **Clear Mailpit before each test.** `clearMailpit()` prevents stale messages from satisfying `waitForMessage()`.
3. **Poll after every send.** Mailpit indexes asynchronously; `waitForMessage(subject)` handles the race.
4. **Serialize files that share Mailpit.** If SMTP tests live in multiple files, set `fileParallelism: false` or provision a separate Mailpit per worker.
5. **Assert both the result and the received message.** `MailResult` covers nodemailer's response; the Mailpit API covers SMTP wire behavior.
6. **Use an unused port for failure tests.** `localhost:19999` reliably produces `health() === false` and a rejected `send()` without affecting Mailpit.
7. **Shut down every provider.** SMTP transports hold connection pools; memory providers clear their stores on shutdown.
8. **Never point integration tests at a production SMTP server.** Always use a dedicated fake server or a dedicated test account.

---

## Mocking & Stubbing

Prefer real fakes over mocks. `MemoryMailProvider` implements the full contract and records messages, so most tests need no mocking at all. Reach for spies, subclasses, or module mocks only when you need to force a specific failure or verify wiring.

| Technique | Use when | Caveat |
| --- | --- | --- |
| `MemoryMailProvider` | Testing any service that depends on `MailProvider` | `shutdown()` clears the store |
| `vi.spyOn()` on a provider | Simulating one-off rejection or unhealthy state | Restore mocks after each test |
| Subclass `MailProvider` | Persistent failure or custom behavior across many tests | More code than a spy |
| Partial `vi.mock()` | Testing application wiring without constructing real providers | Must keep mocked exports compatible with the code under test |
| Mocking `nodemailer` | Almost never | Couples tests to implementation details; prefer Mailpit integration |

### Prefer the In-Memory Fake

```typescript fragment
const mailer = new MemoryMailProvider();
const service = new NotificationService(mailer);

await service.sendWelcome({ email: "alice@example.com", displayName: "Alice" });

expect(mailer.getLastMessage()?.message.subject).toBe("Welcome, Alice!");
```

This runs the real `send()` implementation, exercises the real `MailProvider` contract, and still lets you assert on the captured message.

### Spy on a Real Provider

Spies keep the real implementation unless you explicitly replace it. Use `mockRejectedValueOnce()` for a single failure and `mockResolvedValue()` for a persistent health state.

```typescript
// tests/unit/provider-spies.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    MemoryMailProvider,
    type MailResult,
} from "blendsdk/webafx-mailer";

describe("spying on a MailProvider", () => {
    let mailer: MemoryMailProvider;

    beforeEach(() => {
        mailer = new MemoryMailProvider();
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await mailer.shutdown();
    });

    it("simulates a transient send failure", async () => {
        vi.spyOn(mailer, "send").mockRejectedValueOnce(
            new Error("SMTP timeout")
        );

        await expect(
            mailer.send({
                from: "sender@test.com",
                to: "recipient@test.com",
                subject: "Retry me",
                text: "Body",
            })
        ).rejects.toThrow("SMTP timeout");

        // The spy replaced the implementation, so nothing was captured.
        expect(mailer.getSentMessages()).toHaveLength(0);
    });

    it("simulates an unhealthy backend", async () => {
        vi.spyOn(mailer, "health").mockResolvedValue(false);

        await expect(mailer.health()).resolves.toBe(false);
    });

    it("records calls while keeping the real implementation", async () => {
        const spy = vi.spyOn(mailer, "send");

        const result: MailResult = await mailer.send({
            from: "sender@test.com",
            to: "recipient@test.com",
            subject: "Observed",
            text: "Body",
        });

        expect(spy).toHaveBeenCalledOnce();
        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({ subject: "Observed" })
        );
        expect(result.accepted).toEqual(["recipient@test.com"]);
        expect(mailer.getSentMessages()).toHaveLength(1);
    });
});
```

### Stub the Provider Contract

For a provider that must fail consistently, subclass `MailProvider`. The result is typed, reusable, and does not depend on module mocking.

```typescript
// tests/helpers/unhealthy-mail-provider.ts
import {
    MailProvider,
    type MailMessage,
    type MailProviderConfig,
    type MailResult,
} from "blendsdk/webafx-mailer";

/**
 * A MailProvider stub that is never healthy and rejects every send.
 */
export class UnhealthyMailProvider extends MailProvider {
    constructor(
        private readonly failure: Error,
        config: MailProviderConfig = {}
    ) {
        super(config);
    }

    async send(_message: MailMessage): Promise<MailResult> {
        throw this.failure;
    }

    async health(): Promise<boolean> {
        return false;
    }

    async shutdown(): Promise<void> {
        // No resources to release in this stub.
    }
}
```

```typescript
// tests/unit/unhealthy-provider.test.ts
import { describe, expect, it } from "vitest";
import { UnhealthyMailProvider } from "../helpers/unhealthy-mail-provider.js";

describe("unhealthy backend", () => {
    it("never reports healthy and rejects every send", async () => {
        const mailer = new UnhealthyMailProvider(new Error("SMTP offline"));

        await expect(mailer.health()).resolves.toBe(false);

        await expect(
            mailer.send({
                from: "sender@test.com",
                to: "recipient@test.com",
                subject: "Fails",
                text: "Body",
            })
        ).rejects.toThrow("SMTP offline");

        await mailer.shutdown();
    });
});
```

### Module-Level Mocking

Use a partial module mock when you are testing application wiring — for example, a function that chooses a backend from environment configuration — and you do not want to construct a real provider. Keep the real exports and override only the factory.

```typescript
// tests/unit/app-mailer.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    createMailProvider,
    MemoryMailProvider,
    type MailFactoryConfig,
    type MailProvider,
} from "blendsdk/webafx-mailer";

const { createMailProviderMock } = vi.hoisted(() => ({
    createMailProviderMock: vi.fn<(config: MailFactoryConfig) => MailProvider>(),
}));

vi.mock("blendsdk/webafx-mailer", async (importOriginal) => {
    const actual = await importOriginal<typeof import("blendsdk/webafx-mailer")>();
    return {
        ...actual,
        createMailProvider: createMailProviderMock,
    };
});

// Normally this function lives in your application. It is defined here to keep
// the example self-contained; the module mock applies to its import as well.
function createAppMailer(env: { NODE_ENV?: string }): MailProvider {
    return createMailProvider({
        type: env.NODE_ENV === "production" ? "smtp" : "memory",
        host: "localhost",
        port: 1025,
        secure: false,
    });
}

describe("createAppMailer", () => {
    let mockedMailer: MemoryMailProvider;

    beforeEach(() => {
        mockedMailer = new MemoryMailProvider();
        createMailProviderMock.mockReset();
        createMailProviderMock.mockReturnValue(mockedMailer);
    });

    afterEach(async () => {
        await mockedMailer.shutdown();
    });

    it("delegates backend selection to createMailProvider", () => {
        const mailer = createAppMailer({ NODE_ENV: "test" });

        expect(createMailProviderMock).toHaveBeenCalledWith({
            type: "memory",
            host: "localhost",
            port: 1025,
            secure: false,
        });
        expect(mailer).toBeInstanceOf(MemoryMailProvider);
    });

    it("requests SMTP in production", () => {
        createAppMailer({ NODE_ENV: "production" });

        expect(createMailProviderMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: "smtp" })
        );
    });
});
```

The partial factory mock keeps `MemoryMailProvider`, `SmtpMailProvider`, and the real types available. Override only the function your wiring test needs.

### Mocking Guidelines

| Rule | Reason |
| --- | --- |
| Prefer `MemoryMailProvider` over mocks | It satisfies the real contract and records messages |
| Restore spies in `afterEach` | Prevents cross-test behavior leakage |
| Use `mockRejectedValueOnce` for transient failures | Next call can still exercise the real implementation |
| Use a subclass for persistent failures | Typed, reusable, and independent of module mocking |
| Keep partial module mocks compatible | Code under test may use other package exports |
| Do not assert on `getSentMessages()` after mocking `send` | The real implementation, and therefore capture, is replaced |
| Do not mock nodemailer internals | It couples tests to implementation and misses adapter bugs; use Mailpit |
| Do not call `plugin.factory()` in unit tests | It expects a WebAFX application context; assert metadata instead |

---

## Test Patterns by Feature

### Message Composition and Recipients

`MailMessage` accepts single strings or arrays for `to`, `cc`, and `bcc`. The memory provider normalizes each field only for the result; the stored `message` object remains exactly as submitted.

| Scenario | Expected behavior |
| --- | --- |
| `to: "a@test.com"` | `result.accepted` equals `["a@test.com"]` |
| `to: ["a@test.com", "b@test.com"]` | Both addresses accepted, order preserved |
| `cc` string or array | Included in `accepted` after all `to` recipients |
| `bcc` string or array | Included in `accepted` after all `cc` recipients |
| `from` with display name | Memory store preserves the exact string; SMTP parses the address |
| `text` and `html` together | Both preserved by memory; both forwarded by SMTP |
| Attachment `Buffer` or base64 string | Memory preserves the original content; SMTP maps it to nodemailer |

```typescript fragment
const result = await mailer.send({
    from: "sender@test.com",
    to: ["alice@test.com", "bob@test.com"],
    cc: "carol@test.com",
    bcc: "dave@test.com",
    subject: "Recipients",
    text: "Hello",
});

expect(result.accepted).toEqual([
    "alice@test.com",
    "bob@test.com",
    "carol@test.com",
    "dave@test.com",
]);
```

### Attachments

| Provider | Assertion pattern |
| --- | --- |
| Memory | `mailer.getLastMessage()?.message.attachments?.[0]` is the same object reference as the submitted attachment |
| Memory | `content` is preserved as `Buffer` or base64 string without transformation |
| SMTP | Use Mailpit: `received.Attachments` equals the number of attachments |
| SMTP | The `MailResult` does not list attachments; assert attachment delivery through Mailpit |

```typescript fragment
expect(mailer.getLastMessage()?.message.attachments?.[0]).toBe(attachment);
expect(received.Attachments).toBe(1);
```

### Result and Message ID

| Provider | `messageId` | `rejected` |
| --- | --- | --- |
| Memory | Deterministic `<memory-${Date.now()}-${index}@test>`; unique per send | Always `[]` |
| SMTP | Server-assigned ID, typically `<...@...>` | Server-reported; normally `[]` against Mailpit |

```typescript fragment
expect(result.messageId).toMatch(/^<memory-\d+-\d+@test>$/);
expect(result.rejected).toEqual([]);
```

### Inspection Helpers

| Helper | Pattern |
| --- | --- |
| `getSentMessages()` | Assert length, order, and subjects; it returns a **new array** containing the original entries |
| `getSentMessages()` mutation | Set `sent.length = 0` on the copy; internal store remains unchanged |
| `getLastMessage()` | Returns `undefined` before any send/after `clear()`; otherwise the newest entry |
| `clear()` | Empties the store; sending again starts a fresh sequence |
| `shutdown()` | Clears the store; assert emptiness only after the call |

```typescript fragment
const firstCopy = mailer.getSentMessages();
const secondCopy = mailer.getSentMessages();
firstCopy.length = 0;

expect(firstCopy).not.toBe(secondCopy);
expect(mailer.getSentMessages()).toHaveLength(1);
```

### Health Checks

| Provider / situation | Expected |
| --- | --- |
| `MemoryMailProvider`, any time | Resolves `true` |
| `SmtpMailProvider` with Mailpit running | Resolves `true` via EHLO/HELO verification |
| `SmtpMailProvider` with unreachable host/port | Resolves `false`; never throws |
| Return type | Always a `boolean` |

```typescript fragment
const offline = new SmtpMailProvider({
    host: "localhost",
    port: 19999,
    secure: false,
});

await expect(offline.health()).resolves.toBe(false);
await offline.shutdown();
```

### Shutdown and Lifecycle

| Provider | Effect | Test pattern |
| --- | --- | --- |
| Memory | Clears all stored messages | Send, `await shutdown()`, expect store length `0` |
| SMTP | Closes the nodemailer transport and connection pool | `await expect(mailer.shutdown()).resolves.toBeUndefined()` |
| Plugin | `dispose` calls `provider.shutdown()` | Exercise through a real WebAFX application lifecycle |

Do not call `shutdown()` before asserting on memory messages — it is destructive to the captured store. In `afterEach`, cleanup failures should be swallowed so they do not mask the real test failure.

### Plugin Factories

| Function / field | Pattern |
| --- | --- |
| `createMailPlugin(provider)` | `plugin.name === provider.serviceName`; default `plugin.priority === 30`; `typeof plugin.factory === "function"` |
| `createMailPlugin(provider, { priority })` | Explicit priority wins; `0` is valid (`??`, not `||`) |
| `memoryMailPlugin(config?)` | Definition name defaults to `"mailer"` or uses custom `serviceName` |
| `smtpMailPlugin(config)` | Definition name defaults to `"mailer"` or uses custom `serviceName` |
| `plugin.factory()` | Requires a WebAFX application context; do not invoke it in unit tests that only assert metadata |

```typescript fragment
const plugin = createMailPlugin(
    new MemoryMailProvider({ serviceName: "transactional-mailer" })
);

expect(plugin.name).toBe("transactional-mailer");
expect(plugin.priority).toBe(30);
expect(typeof plugin.factory).toBe("function");
```

For tests that need to inspect sent mail, create the `MemoryMailProvider` yourself and pass it to `createMailPlugin()`. The one-liner `memoryMailPlugin()` owns its provider internally.

### Backend Selection With createMailProvider

| Configuration | Expected |
| --- | --- |
| `{ type: "memory" }` | `MemoryMailProvider` instance |
| `{ type: "smtp", host, port }` | `SmtpMailProvider` instance |
| `serviceName` supplied | Passed through to the provider |
| Unknown `type` | Throws synchronously: `Unknown mail type: "<value>". Supported types: "smtp", "memory".` |

```typescript fragment
expect(createMailProvider({ type: "memory" })).toBeInstanceOf(MemoryMailProvider);
expect(
    createMailProvider({ type: "smtp", host: "localhost", port: 1025 })
).toBeInstanceOf(SmtpMailProvider);

expect(() =>
    createMailProvider({ type: "sendgrid" as "smtp" })
).toThrow('Unknown mail type: "sendgrid"');
```

### SMTP Delivery and Mailpit Assertions

| What to verify | Where to assert |
| --- | --- |
| Accepted/rejected recipients | `MailResult.accepted` / `MailResult.rejected` |
| Server message ID | `MailResult.messageId` |
| Subject | `waitForMessage(subject)` then `received.Subject` |
| `To` and `Cc` recipients | `received.To` / `received.Cc` address arrays |
| Attachment count | `received.Attachments` |
| Health | `mailer.health()` |
| Transport failure | `await expect(mailer.send(...)).rejects.toThrow()` |
| Indexing race | Always poll with `waitForMessage()` |

### Contract Tests

| Contract expectation | Assertion |
| --- | --- |
| `send()` returns `accepted` with the recipient | `expect(result.accepted).toContain(recipient)` |
| `send()` returns a `rejected` array | `expect(result.rejected).toEqual([])` for healthy backends |
| `messageId` is optional but non-empty when supplied | Check `typeof` and `length` only when defined |
| `health()` reports operational state | `await expect(provider.health()).resolves.toBe(true)` |
| `shutdown()` resolves | `await expect(provider.shutdown()).resolves.toBeUndefined()` |
| Default service name is `"mailer"` | `expect(provider.serviceName).toBe("mailer")` |

Run the shared contract suite against both built-in providers and any custom `MailProvider` subclass. For a custom provider, supply a factory in place of `new MemoryMailProvider()` and add a cleanup hook if it owns external resources.

---

## Related Documents

- Overview — package scope, architecture, and dependency notes.
- Core Concepts — provider contract, message model, backends, and plugin lifecycle.

---

# webafx-mailer Troubleshooting

This document covers the errors, failure modes, and subtle traps you are most likely to encounter with `blendsdk/webafx-mailer` — whether you are sending through a real SMTP server, testing against the in-memory backend, wiring the mailer into WebAFX, or running the package's own Mailpit-based integration suite. The package adds very little error text of its own: most messages you will see originate from Node's network/TLS stack, the SMTP server, or the TypeScript compiler. Only one error message is thrown by this package directly (`Unknown mail type: "..."`), and a handful of behaviors (notably `health()` and `shutdown()`) intentionally hide detail — those are documented below.

## Quick Reference

| Message / Symptom | Likely Cause | Section |
| --- | --- | --- |
| `Unknown mail type: "..."` | Invalid `type` value from env/config reaching `createMailProvider()` | Factory and Configuration Errors |
| `connect ECONNREFUSED <host>:<port>` | No SMTP server listening at the configured address | SMTP Delivery Errors |
| `Connection timeout` / `Greeting never received` | `secure` setting and port mismatch | SMTP Delivery Errors |
| `Invalid login: 535 Authentication failed` | Wrong credentials or provider requires an app password | SMTP Delivery Errors |
| `unable to verify the first certificate` | SMTP certificate not trusted by Node | SMTP Delivery Errors |
| `send()` fails after `shutdown()` | Provider is single-lifecycle; transport was closed | SMTP Delivery Errors |
| `health()` returns `false`, nothing logged | `health()` deliberately swallows the underlying error | SMTP Delivery Errors |
| Resolving `"mailer"` returns the wrong provider | Two plugins registered under the same service name | WebAFX Plugin Errors |
| `getSentMessages()` unreachable in tests | `memoryMailPlugin()` keeps the provider internal | Test Environment Errors |
| `Timed out waiting for Mailpit message with subject "..."` | Mailpit indexing delay, parallel interference, or subject mismatch | Test Environment Errors |
| TS `Cannot find module 'blendsdk/webafx-mailer'` | Missing dependency or incompatible `moduleResolution` | TypeScript Compiler Errors |
| TS `Module '...' has no exported member '...'` | Wrong symbol name | TypeScript Compiler Errors |

---

## Common Errors

Each entry follows the same shape: the exact error message or observable symptom, the technical cause, and a fix with a working code example. All examples import only from the package root (`blendsdk/webafx-mailer`).

### Factory and Configuration Errors

#### `Unknown mail type: "sendgrid". Supported types: "smtp", "memory".`

**Error / Symptom**

`createMailProvider()` throws synchronously (it is not a rejected promise) with that message, including the actual value it received and the list of supported backends.

**Cause**

`createMailProvider()` switches on `config.type` and hits its `default` branch — an explicit runtime guard for values that TypeScript could not verify at compile time. This almost always happens when the config is assembled from untyped sources: environment variables, JSON files, or a cast like `"sendgrid" as "smtp"`. The guard exists precisely because `MailFactoryConfig.type` can be bypassed with a cast, and the error text is constructed from the offending value.

**Fix**

Validate the raw value before it ever reaches the factory, and narrow it to `MailFactoryConfig["type"]` with a parser function. This converts a hard crash (and a potentially ugly stack trace) into a well-described configuration error at startup.

```typescript
import {
    createMailProvider,
    type MailFactoryConfig,
    type MailProvider,
} from "blendsdk/webafx-mailer";

type MailBackendType = MailFactoryConfig["type"];

function parseMailType(value: string | undefined): MailBackendType {
    if (value === "smtp" || value === "memory") {
        return value;
    }
    throw new Error(`Invalid MAIL_TYPE "${value ?? ""}" — expected "smtp" or "memory".`);
}

const config: MailFactoryConfig = {
    type: parseMailType(process.env.MAIL_TYPE ?? "memory"),
    host: process.env.SMTP_HOST ?? "localhost",
    port: Number(process.env.SMTP_PORT ?? "587"),
    secure: false,
};

const mailer: MailProvider = createMailProvider(config);
console.log(`Created ${mailer.constructor.name} as "${mailer.serviceName}"`);

await mailer.shutdown();
```

If you do not control the value (for example, it comes from a remote configuration store), keep the parser but return a safe default (`"memory"` in development, or throw in production) instead of letting the factory surprise you at runtime.

---

### SMTP Delivery Errors

#### `connect ECONNREFUSED 127.0.0.1:1025`

**Error / Symptom**

`send()` (and sometimes `health()`) rejects with `Error: connect ECONNREFUSED <host>:<port>`. The port in the message is your configured port — `1025` here means a local Mailpit/dev server that is not running; `25`, `587`, or `465` point at a real server that is down, firewalled, or misconfigured.

**Cause**

Nothing is accepting TCP connections at the configured `host:port`. Typical scenarios: a development config still pointing at a local mail sink; the SMTP server being down; a firewall or security group blocking the port; a Docker container that was never started (or has exited).

**Fix**

1. Check reachability before sending — `health()` returns `false` instead of throwing when the server is unreachable.
2. Log the resolved `host`/`port` so you can immediately spot an environment mix-up.
3. For local development, run a mail sink (the package's own docker setup starts Mailpit on port `1025`).

```typescript
import { SmtpMailProvider, type SmtpMailConfig } from "blendsdk/webafx-mailer";

const config: SmtpMailConfig = {
    host: process.env.SMTP_HOST ?? "localhost",
    port: Number(process.env.SMTP_PORT ?? "1025"),
    secure: false,
};

const mailer = new SmtpMailProvider(config);

const reachable = await mailer.health();
if (!reachable) {
    console.warn(`SMTP server at ${config.host}:${config.port} is not reachable — skipping send.`);
} else {
    const result = await mailer.send({
        from: "noreply@example.com",
        to: "user@example.com",
        subject: "Health-checked send",
        text: "This message is only sent when the SMTP server is reachable.",
    });
    console.log("Accepted:", result.accepted);
}

await mailer.shutdown();
```

To inspect the Mailpit instance used by this package's tests, run `pnpm docker:logs` after starting it — the log output confirms whether the SMTP listener on `1025` is actually up.

#### `Connection timeout` / `Greeting never received`

**Error / Symptom**

`send()` or `health()` hangs for a while and then fails with `Connection timeout`, `Greeting never received`, or a TLS protocol error such as `...:SSL routines:ssl3_get_record:wrong version number...`.

**Cause**

The `secure` setting and the port disagree:

| Port convention | Correct `secure` value | Handshake |
| --- | --- | --- |
| `587` (submission) | `false` (default) | Plaintext connect, then STARTTLS upgrade |
| `465` (smtps) | `true` | TLS from the first byte |
| `25` (relay) | `false` | Plaintext (STARTTLS only if the server offers it) |
| `1025` (Mailpit) | `false` | Plaintext, no authentication |

`SmtpMailConfig.secure` defaults to `false` when omitted — which is correct for port 587 but causes a stall (the client waits for a TLS greeting that never arrives) against port 465.

**Fix**

1. Pick `secure: false` for 587/25/1025 and `secure: true` for 465.
2. When unsure, derive the value from the port rather than hardcoding it.

```typescript
import { SmtpMailProvider, type SmtpMailConfig } from "blendsdk/webafx-mailer";

const startTlsConfig: SmtpMailConfig = {
    host: "smtp.example.com",
    port: 587,
    secure: false, // STARTTLS — the connection is upgraded after EHLO
    auth: { user: "user@example.com", pass: "secret" },
};

const implicitTlsConfig: SmtpMailConfig = {
    host: "smtp.example.com",
    port: 465,
    secure: true, // direct TLS from the first byte
    auth: { user: "user@example.com", pass: "secret" },
};

const configuredPort = Number(process.env.SMTP_PORT ?? "587");
const mailer = new SmtpMailProvider(configuredPort === 465 ? implicitTlsConfig : startTlsConfig);

console.log("SMTP verified:", await mailer.health());

await mailer.shutdown();
```

#### `Invalid login: 535 Authentication failed`

**Error / Symptom**

`send()` rejects with a nodemailer error beginning `Invalid login: 535` (the text after the code varies per server, e.g. `535 5.7.8 Username and Password not accepted`). `health()` returns `false` for the same configuration because it also exercises authentication.

**Cause**

The server rejected the credentials in `SmtpMailConfig.auth`. Common reasons:

- The password is wrong, expired, or contains characters that were mangled by environment handling.
- The provider requires an **app-specific password** (Gmail, Yahoo, and many corporate mail servers) instead of the account password.
- SMTP AUTH is disabled for the account, or the sending IP is not allowlisted.
- The provider requires OAuth2 — `SmtpMailConfig.auth` only supports `{ user, pass }`, so OAuth2-only providers need an app password (if offered) or a custom `MailProvider` implementation.

**Fix**

1. Load credentials from the environment — never hardcode them.
2. Probe with an actual `send()` wrapped in `try/catch` so you see the server's full message, which `health()` hides.
3. If the message confirms 535, regenerate the credential as an app password in the provider's control panel.

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;

if (user === undefined || pass === undefined) {
    throw new Error("SMTP_USER and SMTP_PASS must be set for the auth probe.");
}

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user, pass },
});

try {
    const result = await mailer.send({
        from: user,
        to: "recipient@example.com",
        subject: "Auth probe",
        text: "Verifying SMTP credentials.",
    });
    console.log("Credentials accepted. Accepted recipients:", result.accepted);
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("535") || message.toLowerCase().includes("authentication")) {
        console.error(
            "SMTP rejected the credentials (535). Most providers require an " +
                "app-specific password instead of the account password."
        );
    } else {
        console.error("Send failed:", message);
    }
} finally {
    await mailer.shutdown();
}
```

#### `unable to verify the first certificate` / `self-signed certificate in certificate chain`

**Error / Symptom**

`send()` or `health()` fails with one of the classic Node TLS errors: `unable to verify the first certificate`, `self-signed certificate in certificate chain`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, or `SELF_SIGNED_CERT_IN_CHAIN`.

**Cause**

The SMTP server presents a certificate that Node's built-in trust store does not accept — typical for internal/self-hosted mail servers, corporate TLS-inspecting proxies, or servers with an incomplete certificate chain. This package deliberately does **not** hardcode `tls.rejectUnauthorized: false` (a common anti-pattern in older code), so certificate validation stays on unless you opt out.

**Fix**

1. Preferred: pin the issuing CA through `tls.ca` so validation stays enabled.
2. Only as a last resort for a local test server, set `tls.rejectUnauthorized: false` — and never in production.

```typescript
import { readFileSync } from "node:fs";

import { SmtpMailProvider, type SmtpMailConfig } from "blendsdk/webafx-mailer";

const config: SmtpMailConfig = {
    host: "smtp.internal.example.com",
    port: 587,
    secure: false,
    auth: { user: "user@example.com", pass: "secret" },
    tls: {
        ca: readFileSync("./certs/internal-ca.pem"),
        rejectUnauthorized: true, // keep verification on — against the pinned CA
    },
};

const mailer = new SmtpMailProvider(config);

try {
    const result = await mailer.send({
        from: "noreply@example.com",
        to: "user@example.com",
        subject: "TLS test",
        text: "Sent with a pinned internal CA.",
    });
    console.log("Accepted:", result.accepted);
} finally {
    await mailer.shutdown();
}
```

#### `send()` fails or hangs after `shutdown()`

**Error / Symptom**

`send()` calls that previously succeeded now fail (or hang until a timeout) after `shutdown()` ran — directly, or indirectly through a WebAFX dispose hook or an `afterEach` cleanup. The exact error text depends on the server; the package documents the behavior as: "After calling this, subsequent `send()` calls will fail."

**Cause**

`SmtpMailProvider.shutdown()` calls `transporter.close()`, which releases the nodemailer connection pool. A provider is **single-lifecycle**: it cannot be revived. This bites most often in tests that shut a shared provider down in the first `afterEach` and then reuse it in the next test.

**Fix**

1. Treat the provider as disposable: shut it down exactly once, at the end of its lifetime.
2. Create a fresh provider per test (or per application lifecycle) rather than reusing a closed one.
3. Wrap the provider in a small guard that nulls the reference on close, so late sends fail with a clear message instead of a transport error.

```typescript
import {
    MailProvider,
    MemoryMailProvider,
    type MailMessage,
    type MailResult,
} from "blendsdk/webafx-mailer";

class LifecycleAwareMailer {
    private provider: MailProvider | null;

    constructor(provider: MailProvider) {
        this.provider = provider;
    }

    async send(message: MailMessage): Promise<MailResult> {
        if (this.provider === null) {
            throw new Error("Mailer has been shut down — create a new provider instance.");
        }
        return this.provider.send(message);
    }

    async close(): Promise<void> {
        if (this.provider !== null) {
            await this.provider.shutdown();
            this.provider = null;
        }
    }
}

const mailer = new LifecycleAwareMailer(new MemoryMailProvider());

await mailer.send({ from: "a@b.com", to: "c@d.com", subject: "Hi", text: "Hello" });
await mailer.close();

try {
    await mailer.send({ from: "a@b.com", to: "c@d.com", subject: "Hi", text: "Hello" });
} catch (error) {
    console.log(error instanceof Error ? error.message : "unexpected failure");
    // Mailer has been shut down — create a new provider instance.
}
```

#### `health()` returns `false` and no error appears anywhere

**Error / Symptom**

`await provider.health()` resolves to `false`, the WebAFX `/health` endpoint reports the mailer as unhealthy, and **no error, exception, or log line explains why**.

**Cause**

`SmtpMailProvider.health()` runs `transporter.verify()` inside a `try/catch` and converts any failure (DNS, TCP, TLS, authentication) into the boolean `false`. That is the correct production behavior for health endpoints — but it makes diagnosis impossible without a probe.

**Fix**

Create a diagnostic subclass that calls `verify()` directly and returns the error message. Because `transporter` is `protected`, a subclass can access it; production `health()` behavior stays untouched.

```typescript
import { SmtpMailProvider, type SmtpMailConfig } from "blendsdk/webafx-mailer";

/**
 * Debug subclass: surfaces the nodemailer verify() error that the
 * production health() check intentionally swallows.
 */
class DiagnosableSmtpMailProvider extends SmtpMailProvider {
    constructor(config: SmtpMailConfig) {
        super(config);
    }

    async diagnose(): Promise<string> {
        try {
            await this.transporter.verify();
            return "SMTP connection and authentication verified successfully.";
        } catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    }
}

const probe = new DiagnosableSmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "user@example.com", pass: "secret" },
});

console.log(await probe.diagnose());

await probe.shutdown();
```

Keep this class in a diagnostics script or test helper — do not ship it as the production health check.

---

### WebAFX Plugin Errors

#### Resolving the mailer service returns the wrong provider

**Error / Symptom**

When two mail plugins are registered, resolving the service by name (e.g. `services.get<MailProvider>("mailer")`) returns a provider you did not expect, or one of your two mailers is simply never reachable. Memory assertions also appear to hit the "wrong" instance. There is no error message — the symptom is silent shadowing.

**Cause**

The plugin's `name` **is** the service name: `createMailPlugin()` sets `name: provider.serviceName` and registers the singleton under that same name. Two plugins with the default name `"mailer"` register two singleton services under one key — the later registration wins and the earlier provider becomes unreachable. This also happens if you call `createMailPlugin()` twice with the same provider instance by accident.

**Fix**

Give every provider a distinct `serviceName` (and therefore a distinct plugin name). The name defaults to `"mailer"` (`DEFAULT_SERVICE_NAME`), so multi-mailer setups must opt in.

```typescript
import { memoryMailPlugin, smtpMailPlugin } from "blendsdk/webafx-mailer";

const transactionalPlugin = smtpMailPlugin({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    serviceName: "transactional-mailer",
});

const marketingPlugin = memoryMailPlugin({ serviceName: "marketing-mailer" });

console.log(transactionalPlugin.name); // "transactional-mailer"
console.log(marketingPlugin.name);     // "marketing-mailer"
```

Calls in application code should then resolve the exact name they need rather than the generic `"mailer"`.

---

### Test Environment Errors (Memory Backend and Mailpit)

#### `getSentMessages()` cannot be reached when using `memoryMailPlugin()`

**Error / Symptom**

Tests register the mailer with `memoryMailPlugin()` and then have no handle to assert on: the captured mail exists, but `getSentMessages()`, `getLastMessage()`, and `clear()` are not reachable on a `PluginDefinition`.

**Cause**

By design, `memoryMailPlugin()` creates the `MemoryMailProvider` internally and returns only the plugin. The provider instance stays private — and it is disposed (and its store cleared) when the application shuts down.

**Fix**

Create the `MemoryMailProvider` yourself and wrap it with `createMailPlugin()`. You keep the provider reference, so the assertion helpers stay available; the plugin behavior (singleton registration, health, shutdown wiring) is identical.

```typescript
import { createMailPlugin, MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider({ serviceName: "test-mailer" });

// Pass this plugin to app.use() in your WebAFX application:
const plugin = createMailPlugin(mailer);

await mailer.send({
    from: "noreply@example.com",
    to: "new-user@example.com",
    subject: "Welcome!",
    text: "Welcome aboard!",
});

console.log(plugin.name);              // "test-mailer"
console.log(mailer.getSentMessages().length); // 1 — assertions work

await mailer.shutdown();
```

#### Captured memory messages disappear before assertions run

**Error / Symptom**

`getSentMessages()` returns `[]` even though the same test sent mail moments ago — assertions fail with empty arrays, or a helper reports "no messages captured" after test teardown.

**Cause**

`MemoryMailProvider.shutdown()` delegates to `clear()`. The WebAFX plugin wires `shutdown()` into both the service `dispose` hook and the plugin shutdown hook, so application teardown wipes the store. Any assertion that runs after `shutdown()` — or a shared provider that was closed by an earlier `afterEach` — sees an empty provider.

**Fix**

1. Assert inside the test body, while the provider is alive.
2. Perform `shutdown()`/`clear()` only in `afterEach`, after assertions have run.
3. If you need data after teardown, snapshot it (e.g. copy `message.subject` values) before shutting down.

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryMailProvider } from "blendsdk/webafx-mailer";

describe("welcome email", () => {
    let mailer: MemoryMailProvider;

    beforeEach(() => {
        mailer = new MemoryMailProvider();
    });

    afterEach(async () => {
        await mailer.shutdown(); // clears the store AFTER the test has asserted
    });

    it("captures the welcome email", async () => {
        await mailer.send({
            from: "noreply@example.com",
            to: "user@example.com",
            subject: "Welcome!",
            text: "Welcome aboard!",
        });

        expect(mailer.getSentMessages()).toHaveLength(1);
        expect(mailer.getLastMessage()?.message.subject).toBe("Welcome!");
    });
});
```

#### SMTP tests fail with `ECONNREFUSED` / `fetch failed` — Mailpit not running

**Error / Symptom**

Running `pnpm test:fast` or `pnpm test:watch` fails with `Error: connect ECONNREFUSED 127.0.0.1:1025` from the SMTP suite, and/or `TypeError: fetch failed` against `http://localhost:8025/api/v1` from the Mailpit helpers.

**Cause**

`test:fast` and `test:watch` run Vitest directly — they do **not** manage the Mailpit container. Only the `test` script performs the full lifecycle: `docker:down` → `docker:up` → `vitest run` → `docker:down`. Without a running container, both the SMTP endpoint (port `1025`) and the Mailpit REST API (port `8025`) are unavailable.

**Fix**

Use `pnpm test` for the complete cycle, or start Docker manually when you want the faster watch loop:

```bash
# Full lifecycle — starts Mailpit, runs all tests, stops Mailpit:
pnpm test

# Manual flow for test:fast / test:watch:
pnpm docker:up
pnpm test:fast
pnpm docker:down

# Inspect the Mailpit container log (SMTP listener health, received messages):
pnpm docker:logs
```

If the container is up but tests still fail, check that ports `1025` and `8025` are not already occupied by another local mail server — a port conflict produces the same connection errors.

#### `Timed out waiting for Mailpit message with subject "..."`

**Error / Symptom**

The integration suite (or your own Mailpit-based test) throws `Error: Timed out waiting for Mailpit message with subject "<subject>"` after polling. The send itself succeeded.

**Cause**

Several possibilities, in order of likelihood:

1. **Indexing delay** — Mailpit stores the message asynchronously; an SMTP `send()` resolves before the message is queryable through the REST API. This is exactly why the package's test helper polls up to 25 times with 200 ms intervals.
2. **Parallel interference** — multiple test files share one Mailpit instance; another suite's `clearMailpit()` (a `DELETE` on `/api/v1/messages`) races your assertion.
3. **Subject mismatch** — the asserted subject differs from the sent one (case, whitespace, or interpolation differences); `waitForMessage` matches `Subject` exactly.
4. **The message was silently rejected** — check `result.rejected` and catch any throw from `send()` before blaming the poller.

**Fix**

1. Always poll for the message instead of asserting immediately — and match by subject so stale messages from earlier tests cannot satisfy the assertion.
2. Clear the mailbox in setup (`beforeEach`), not concurrently with other assertions.
3. Verify `result.rejected` is empty and let `send()` throw visibly before waiting.

```typescript
import { SmtpMailProvider, type MailMessage } from "blendsdk/webafx-mailer";

interface MailpitMessage {
    ID: string;
    Subject: string;
    To: Array<{ Address: string; Name: string }>;
}

const MAILPIT_API = "http://localhost:8025/api/v1";

async function waitForMessage(subject: string): Promise<MailpitMessage> {
    const maxAttempts = 25;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const response = await fetch(`${MAILPIT_API}/messages`);
        const data = (await response.json()) as { messages: MailpitMessage[] };
        const match = data.messages.find((m) => m.Subject === subject);
        if (match) {
            return match;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out waiting for Mailpit message with subject "${subject}"`);
}

const mailer = new SmtpMailProvider({ host: "localhost", port: 1025, secure: false });

const message: MailMessage = {
    from: "sender@test.com",
    to: "recipient@test.com",
    subject: "Polling Example",
    text: "This message is indexed asynchronously by Mailpit.",
};

const result = await mailer.send(message);

if (result.rejected.length > 0) {
    throw new Error(`Mailpit rejected: ${result.rejected.join(", ")}`);
}

const stored = await waitForMessage(message.subject);
console.log("Found in Mailpit:", stored.Subject);

await mailer.shutdown();
```

---

### TypeScript Compiler Errors

#### `Cannot find module 'blendsdk/webafx-mailer' or its corresponding type declarations.`

**Error / Symptom**

TypeScript reports the module cannot be resolved, and IDE auto-import does not offer any package symbols.

**Cause**

Two common reasons:

1. The package is not installed in the project.
2. The package is installed, but your `tsconfig.json` uses a resolution mode that cannot read modern `exports` maps — the package is ESM-only and ships **no** top-level `main`/`types` fields, only the `exports` conditions `types` and `import`. Classic `"node"` (Node10) resolution ignores `exports` entirely and reports the module as missing.

**Fix**

1. Install the package.
2. Set `module` and `moduleResolution` to `NodeNext` (or `"bundler"` in bundler-based projects) so TypeScript reads the `exports` map.

```json
{
    "compilerOptions": {
        "module": "NodeNext",
        "moduleResolution": "NodeNext",
        "target": "ES2022",
        "strict": true
    }
}
```

```typescript
import {
    DEFAULT_SERVICE_NAME,
    MemoryMailProvider,
    type MailMessage,
} from "blendsdk/webafx-mailer";

const message: MailMessage = {
    from: "resolution-check@example.com",
    to: "recipient@example.com",
    subject: `Resolved — default service name is ${DEFAULT_SERVICE_NAME}`,
    text: "If this compiles and runs, module resolution works.",
};

const mailer = new MemoryMailProvider();
await mailer.send(message);
console.log("Captured messages:", mailer.getSentMessages().length);
await mailer.shutdown();
```

#### `Cannot find module 'blendsdk/webafx' or its corresponding type declarations.`

**Error / Symptom**

TypeScript fails to resolve `blendsdk/webafx` even though you never typed that import yourself — the error typically points at the package's own declaration files, or at a type annotation you added (`PluginDefinition`).

**Cause**

`blendsdk/webafx` is an **optional peer dependency**. Exactly one module, `src/mail-plugin.ts` (re-exported from the package root), contains `import type { PluginDefinition } from "blendsdk/webafx"`. Type-only imports are erased at runtime, so JavaScript never needs WebAFX — but TypeScript must resolve those types whenever it checks the plugin functions' signatures.

**Fix**

1. If you use the plugin factories (`createMailPlugin`, `smtpMailPlugin`, `memoryMailPlugin`), install the peer so the types resolve:

```bash
pnpm add -D blendsdk
```

```typescript
import type { PluginDefinition } from "blendsdk/webafx";

import { createMailPlugin, SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
});

const plugin: PluginDefinition = createMailPlugin(mailer);
console.log(plugin.name); // "mailer"

await mailer.shutdown();
```

2. If you only use the standalone providers and never touch the plugin layer, the missing types are irrelevant at runtime. Adding `"skipLibCheck": true` to your `tsconfig.json` silences errors that originate inside dependency declaration files — but be aware it disables checking for **all** library declarations, so prefer option 1 when you actually use the plugins.

#### `Module '"blendsdk/webafx-mailer"' has no exported member 'createMailer'.`

**Error / Symptom**

The compiler rejects an import with `has no exported member '<name>'` (sometimes with a "Did you mean" suggestion). Auto-import may then offer a `dist/` path — do not accept it.

**Cause**

The symbol name is not part of the package's public API. The most common mistakes are near-misses of the real export names. Never work around this by importing from `dist/` or `src/` paths — only the package root is a supported entry point.

| Written | Correct export |
| --- | --- |
| `createMailer`, `mailPlugin` | `createMailPlugin` (or the one-liners `smtpMailPlugin`, `memoryMailPlugin`) |
| `createProvider` | `createMailProvider` |
| `SmtpProvider` | `SmtpMailProvider` |
| `MemoryProvider`, `InMemoryMailProvider` | `MemoryMailProvider` |
| `MailerProvider` | `MailProvider` (abstract — instantiate a concrete backend instead) |

**Fix**

Import from the root using the canonical names:

```typescript
import {
    createMailPlugin,
    createMailProvider,
    DEFAULT_SERVICE_NAME,
    MailProvider,
    MemoryMailProvider,
    SmtpMailProvider,
} from "blendsdk/webafx-mailer";

const provider: MailProvider = new MemoryMailProvider({ serviceName: DEFAULT_SERVICE_NAME });
const plugin = createMailPlugin(provider);
console.log(plugin.name); // "mailer"

const factoryMade: MailProvider = createMailProvider({ type: "memory" });
console.log(factoryMade instanceof MemoryMailProvider); // true
console.log(SmtpMailProvider.name); // "SmtpMailProvider" — no connection opened

await provider.shutdown();
await factoryMade.shutdown();
```

#### `'SentMailEntry' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled.`

**Error / Symptom**

With `verbatimModuleSyntax` (or strict `isolatedModules` setups) enabled, importing one of the package's type-only exports without the `type` modifier fails.

**Cause**

Several exports from the package root are types, not runtime values: `MailAttachment`, `MailMessage`, `MailResult`, `MailProviderConfig`, `SmtpMailConfig`, `MemoryMailConfig`, `MailFactoryConfig`, and `SentMailEntry`. With `verbatimModuleSyntax`, TypeScript preserves your import statements exactly as written — so type imports must be marked explicitly.

**Fix**

Use the `type` modifier on those imports:

```typescript
import { MemoryMailProvider, type SentMailEntry } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

await mailer.send({
    from: "sender@test.com",
    to: "recipient@test.com",
    subject: "Type-only import check",
    text: "Hello!",
});

const entries: SentMailEntry[] = mailer.getSentMessages();
console.log("Captured entries:", entries.length); // 1

await mailer.shutdown();
```

#### `Type 'string' is not assignable to type '"smtp" | "memory"'.`

**Error / Symptom**

Constructing a config object from environment values fails: `const config = { type: process.env.MAIL_TYPE ?? "memory" }` then passing it to `createMailProvider(config)` — the compiler reports the `type` property is just `string`.

**Cause**

Object literal inference widens literal types: `process.env.MAIL_TYPE` is `string | undefined`, so `type` widens to `string` and is no longer assignable to the `"smtp" | "memory"` discriminator of `MailFactoryConfig`.

**Fix**

Narrow with a user-defined type guard before building the config:

```typescript
import {
    createMailProvider,
    type MailFactoryConfig,
    type MailProvider,
} from "blendsdk/webafx-mailer";

function isMailType(value: unknown): value is MailFactoryConfig["type"] {
    return value === "smtp" || value === "memory";
}

const rawType: string = process.env.MAIL_TYPE ?? "memory";

if (!isMailType(rawType)) {
    throw new Error(`Unsupported MAIL_TYPE "${rawType}" — expected "smtp" or "memory".`);
}

const config: MailFactoryConfig = {
    type: rawType, // narrowed to "smtp" | "memory" by the type guard
    host: process.env.SMTP_HOST ?? "localhost",
    port: Number(process.env.SMTP_PORT ?? "587"),
    secure: false,
};

const mailer: MailProvider = createMailProvider(config);
console.log(`${mailer.constructor.name} ready as "${mailer.serviceName}"`);

await mailer.shutdown();
```

#### `Object literal may only specify known properties, and 'path' does not exist in type 'MailAttachment'.`

**Error / Symptom**

Copying an attachment example from nodemailer documentation fails to compile: `{ filename: "report.pdf", path: "./report.pdf" }`.

**Cause**

`MailAttachment` deliberately exposes a narrow shape: `filename` (required), `content` (required — a `Buffer` or a base64-encoded `string`), and optional `contentType`. nodemailer's lazy file-source variants (`path`, `href`, raw `stream`) are not part of the public model, and unknown properties are rejected on object literals.

**Fix**

Read the file yourself and pass the `Buffer` (or a base64 string) as `content`:

```typescript
import { readFileSync } from "node:fs";

import {
    SmtpMailProvider,
    type MailAttachment,
} from "blendsdk/webafx-mailer";

const attachment: MailAttachment = {
    filename: "report.pdf",
    content: readFileSync("./report.pdf"),
    contentType: "application/pdf",
};

const mailer = new SmtpMailProvider({ host: "smtp.example.com", port: 587, secure: false });

const result = await mailer.send({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Your report",
    text: "See attached.",
    attachments: [attachment],
});
console.log("Accepted:", result.accepted);

// The base64 string form works too:
const base64Attachment: MailAttachment = {
    filename: "note.txt",
    content: Buffer.from("Hello!").toString("base64"),
    contentType: "text/plain",
};
console.log("Second attachment prepared:", base64Attachment.filename);

await mailer.shutdown();
```

#### `Object literal may only specify known properties, and 'host' does not exist in type 'MemoryMailConfig'.`

**Error / Symptom**

Passing SMTP options to the memory backend fails — e.g. `memoryMailPlugin({ host: "smtp.example.com", port: 587 })`, or `new MemoryMailProvider({ host: ... })`.

**Cause**

`MemoryMailConfig` extends `MailProviderConfig`, which only defines `serviceName`. The two backends accept different config shapes, and the object-literal excess-property check catches the mismatch at compile time — which is the desired behavior, since silently ignored SMTP options would be worse.

**Fix**

Use the plugin/provider factory that matches the intended backend. When the backend is chosen at runtime, branch on the environment and construct the matching config:

```typescript
import { memoryMailPlugin, smtpMailPlugin } from "blendsdk/webafx-mailer";

const isProduction = process.env.NODE_ENV === "production";

const plugin = isProduction
    ? smtpMailPlugin({
          host: process.env.SMTP_HOST ?? "localhost",
          port: Number(process.env.SMTP_PORT ?? "587"),
          secure: false,
      })
    : memoryMailPlugin({ serviceName: "dev-mailer" });

console.log(plugin.name); // "mailer" in production, "dev-mailer" otherwise
```

#### `Non-abstract class 'AuditMailProvider' does not implement inherited abstract member 'health' from class 'MailProvider'.`

**Error / Symptom**

Subclassing `MailProvider` fails because one or more of `send`, `health`, or `shutdown` is missing. A related variant appears when a method exists but has the wrong shape: `Property 'send' in type 'AuditMailProvider' is not assignable to the same property in base type 'MailProvider'.`

**Cause**

`MailProvider` declares all three members as `abstract`. TypeScript requires every subclass to implement all of them with exactly matching signatures:

- `send(message: MailMessage): Promise<MailResult>` — note the parameter type and the async return.
- `health(): Promise<boolean>` — must be async, even if you return `true` immediately.
- `shutdown(): Promise<void>` — must be async, even if it does nothing.

**Fix**

Implement all three members with matching signatures. The inherited constructor already accepts `MailProviderConfig`, so the custom `serviceName` flows through automatically:

```typescript
import {
    MailProvider,
    type MailMessage,
    type MailResult,
} from "blendsdk/webafx-mailer";

class AuditMailProvider extends MailProvider {
    async send(message: MailMessage): Promise<MailResult> {
        const recipients = Array.isArray(message.to) ? message.to : [message.to];
        console.log("AUDIT:", JSON.stringify({ to: recipients, subject: message.subject }));

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
        // No resources to release.
    }
}

const mailer = new AuditMailProvider({ serviceName: "audit-mailer" });

await mailer.send({
    from: "noreply@example.com",
    to: "compliance@example.com",
    subject: "Deployment finished",
    text: "Deployment #42 completed successfully.",
});

console.log("Service name:", mailer.serviceName); // "audit-mailer"

await mailer.shutdown();
```

Custom providers plug into `createMailPlugin()` exactly like the built-in ones — the plugin layer only depends on the abstract type.

#### `Could not find a declaration file for module 'nodemailer'. ... Try 'npm i --save-dev @types/nodemailer'`

**Error / Symptom**

The compiler complains about missing types for `nodemailer`, typically when your code touches the nodemailer surface — for example, subclassing `SmtpMailProvider` and accessing its `transporter`, whose type is `nodemailer.Transporter`.

**Cause**

`nodemailer` is a runtime dependency whose TypeScript declarations live in the separate `@types/nodemailer` package. If your project needs to name or introspect that type (the package's own declarations reference it), the ambient type package must be resolvable.

**Fix**

Add the type package as a dev dependency, then use the transporter through a subclass when you need diagnostics:

```bash
pnpm add -D @types/nodemailer
```

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

class InspectableSmtpProvider extends SmtpMailProvider {
    /** Exposes the nodemailer transport for diagnostics and tests. */
    get transport() {
        return this.transporter;
    }
}

const provider = new InspectableSmtpProvider({
    host: "localhost",
    port: 1025,
    secure: false,
});

console.log("Transport object:", typeof provider.transport); // "object"

await provider.shutdown();
```

If your code never references the transport — you only call `send`, `health`, and `shutdown` — you can usually avoid this dependency entirely.

---

## Debugging Strategies

The procedures below are ordered from broadest to most specific: start by separating transport failures from application bugs, then narrow down.

### 1. Triage a failing send: transport or application?

1. Wrap the `send()` call in `try/catch` and print the raw error message. The wrapper adds almost no text of its own, so the message you see is the transport's actual complaint (`ECONNREFUSED`, TLS, `535`, …).
2. If the send resolves, inspect `result.accepted` and `result.rejected` — a resolved promise can still mean partial failure.
3. Run a raw TCP probe against `host:port` to separate "nothing is listening" from "SMTP/TLS/auth conversation failed".
4. Compare with `mailer.health()`: TCP reachable + `health() === false` points at TLS or authentication; TCP unreachable points at networking or config.

```typescript
import { connect } from "node:net";

import { SmtpMailProvider, type SmtpMailConfig } from "blendsdk/webafx-mailer";

function checkTcpReachability(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host, port });
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("timeout", () => {
            socket.destroy();
            resolve(false);
        });
        socket.once("error", () => {
            socket.destroy();
            resolve(false);
        });
    });
}

const config: SmtpMailConfig = {
    host: process.env.SMTP_HOST ?? "localhost",
    port: Number(process.env.SMTP_PORT ?? "587"),
    secure: false,
};

console.log("1. TCP reachable:", await checkTcpReachability(config.host, config.port));

const mailer = new SmtpMailProvider(config);
console.log("2. SMTP verified (EHLO + auth):", await mailer.health());

try {
    const result = await mailer.send({
        from: "noreply@example.com",
        to: "diagnostics@example.com",
        subject: "Triage probe",
        text: "Probe message from the triage script.",
    });
    console.log("3. Send accepted:", result.accepted, "rejected:", result.rejected);
} catch (error) {
    console.log("3. Send failed:", error instanceof Error ? error.message : String(error));
} finally {
    await mailer.shutdown();
}
```

### 2. Isolate application logic with the memory backend

1. Switch the backend to `"memory"` — via `createMailProvider({ type: "memory" })` or by constructing `MemoryMailProvider` directly.
2. Run the same code path that failed against SMTP.
3. Use an `instanceof MemoryMailProvider` check to reach `getSentMessages()` and verify exactly what your application tried to send.
4. Once the message content and recipients look right, switch back to SMTP — any remaining failure is transport-level, not application-level.

```typescript
import { createMailProvider, MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = createMailProvider({ type: "memory" });

const result = await mailer.send({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Triage",
    text: "Isolating application logic from the transport.",
});

console.log("accepted:", result.accepted);
console.log("rejected:", result.rejected);

if (mailer instanceof MemoryMailProvider) {
    const captured = mailer.getSentMessages();
    console.log("captured:", captured.length, "message(s)");
    console.log("subject of first:", captured[0]?.message.subject);
}

await mailer.shutdown();
```

### 3. Make a silent `health()` failure speak

1. Subclass `SmtpMailProvider` and override `health()` so it logs the `verify()` error before returning `false`.
2. Deploy the subclass only in a staging/diagnostic context and read the surfaced message.
3. Map the message to the corresponding section of this document (TLS → certificate entry, `535` → auth entry, timeout → `secure`/port entry).
4. Remove the subclass once the root cause is fixed.

```typescript
import { SmtpMailProvider, type SmtpMailConfig } from "blendsdk/webafx-mailer";

class VerboseHealthSmtpProvider extends SmtpMailProvider {
    constructor(config: SmtpMailConfig) {
        super(config);
    }

    async health(): Promise<boolean> {
        try {
            await this.transporter.verify();
            return true;
        } catch (error) {
            console.error(
                "SMTP health failure:",
                error instanceof Error ? error.message : String(error)
            );
            return false;
        }
    }
}

const probe = new VerboseHealthSmtpProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
});

console.log("healthy:", await probe.health());

await probe.shutdown();
```

### 4. Verify plugin wiring before application bootstrap

1. After building the plugin, log `plugin.name` and `plugin.priority` — `name` must equal the provider's `serviceName`, and it must be unique across all registered mail plugins.
2. Confirm the priority: lower values install earlier; the default is `30`.
3. Record the names your application code actually resolves (e.g. `"transactional-mailer"` vs. the default `"mailer"`).
4. If an early plugin resolves the mailer during its own initialization, lower the mail plugin's priority so it registers first.

```typescript
import { createMailPlugin, SmtpMailProvider } from "blendsdk/webafx-mailer";

const provider = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    serviceName: "transactional-mailer",
});

const plugin = createMailPlugin(provider, { priority: 5 });

console.log("plugin name:", plugin.name);
console.log("plugin priority:", plugin.priority);
console.log("provider serviceName:", provider.serviceName);
console.log("name matches service name:", plugin.name === provider.serviceName);

await provider.shutdown();
```

### 5. Debug the SMTP integration suite in isolation

1. Start Mailpit: `pnpm docker:up` (SMTP on `1025`, REST API and UI on `8025`).
2. Run only the SMTP integration test file so unrelated failures do not obscure the output.
3. On failure, inspect the container log to confirm the SMTP listener is up and whether the message actually arrived.
4. Tear the container down when finished — stale containers with old state are a common source of confusing test results.

```bash
pnpm docker:up
pnpm vitest run tests/smtp-mail-provider.test.ts --reporter=verbose
pnpm docker:logs
pnpm docker:down
```

---

## Known Pitfalls

These are behaviors that follow from deliberate design decisions. Nothing throws, nothing warns — you only notice them when something downstream misbehaves.

### The factory validates only `type` — missing SMTP fields go to the transport unpinned

**Symptom**

`createMailProvider({ type: "smtp" })` without `host`/`port` does not throw. Sends either fail with confusing errors against unexpected addresses (nodemailer falls back to its own defaults, typically `localhost:587`), or — worse — a fallback to `type: "memory"` in production silently discards every email.

**Cause**

`MailFactoryConfig` marks the SMTP fields as optional because the same interface is shared with the memory variant, and the factory forwards them with non-null assertions (`config.host!`, `config.port!`). TypeScript cannot express "`host` and `port` are required when `type === "smtp"`" on this shape, and memory sends are always "successful", so a misconfigured production deployment quietly drops mail.

**Fix**

Validate the config at startup — before the factory is called — and fail fast when the SMTP backend is selected without connection details:

```typescript
import {
    createMailProvider,
    type MailFactoryConfig,
    type MailProvider,
} from "blendsdk/webafx-mailer";

function buildFactoryConfig(env: NodeJS.ProcessEnv): MailFactoryConfig {
    const rawType = env.MAIL_TYPE;
    if (rawType !== "smtp" && rawType !== "memory") {
        throw new Error(`MAIL_TYPE must be "smtp" or "memory" — received: ${rawType ?? "(unset)"}`);
    }

    if (rawType === "memory") {
        return { type: "memory" };
    }

    const host = env.SMTP_HOST;
    const port = Number(env.SMTP_PORT ?? "587");
    if (host === undefined || Number.isNaN(port)) {
        throw new Error("SMTP backend selected, but SMTP_HOST/SMTP_PORT are missing or invalid.");
    }

    return { type: "smtp", host, port, secure: false };
}

const mailer: MailProvider = createMailProvider(buildFactoryConfig(process.env));
console.log(`Mailer backend: ${mailer.constructor.name}`);

await mailer.shutdown();
```

### The memory store works with references and a shallow copy

**Symptom**

Three related surprises: (a) mutating `getSentMessages()[0].message` also mutates the "original" message object you still hold; (b) mutating the array returned by `getSentMessages()` does **not** affect the store; (c) identity checks like `stored.message === original` succeed in tests — and break if you "fix" the provider by spreading the message.

**Cause**

`getSentMessages()` returns a shallow copy of the internal array, but the `SentMailEntry` objects inside it hold references to the exact `message` and `result` objects that were passed to and returned from `send()`. This reference semantics is intentional — the package's own tests assert message identity with `toBe`.

**Fix**

Treat the store as read-only, clone before mutating, and keep identity assertions deliberate:

```typescript
import { MemoryMailProvider, type MailMessage } from "blendsdk/webafx-mailer";

const original: MailMessage = {
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Identity",
    text: "Stored by reference.",
};

const mailer = new MemoryMailProvider();
await mailer.send(original);

const stored = mailer.getSentMessages()[0];

// Intentional identity — the exact object you passed is stored:
console.log(stored.message === original); // true

// Clone before reusing or mutating a message:
const clone: MailMessage = { ...original, subject: "Reused safely" };
await mailer.send(clone);

console.log(mailer.getSentMessages().length); // 2
console.log(original.subject);                // "Identity" — untouched by the clone

await mailer.shutdown();
```

### `health()` performs a live SMTP handshake — do not call it per request

**Symptom**

Latency spikes when a load balancer or frequent `/health` polling hits an endpoint that calls `provider.health()`; the SMTP server sees a steady stream of EHLO connections; connection pool pressure rises.

**Cause**

SMTP `health()` runs `transporter.verify()` — a real network round trip (TCP + EHLO/HELO, plus authentication when `auth` is configured). It is a deliberate liveness probe, not a cheap flag. (The memory backend is the exception — its `health()` always returns `true` instantly.)

**Fix**

Check mail health at boot and on a slow schedule; cache the result and serve that from your health endpoint:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const provider = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
});

const TTL_MS = 30_000;
let cached: { value: boolean; checkedAt: number } | undefined;

async function cachedHealth(): Promise<boolean> {
    const now = Date.now();
    if (cached === undefined || now - cached.checkedAt > TTL_MS) {
        const value = await provider.health();
        cached = { value, checkedAt: now };
        return value;
    }
    return cached.value;
}

console.log(await cachedHealth()); // performs the SMTP handshake
console.log(await cachedHealth()); // served from the 30-second cache

await provider.shutdown();
```

### `result.accepted` reflects the server's verdict, not your recipient list

**Symptom**

`accepted.length` is smaller than the number of recipients you passed; some addresses appear in `result.rejected` without any exception being thrown. Tests that pass against `MemoryMailProvider` (which accepts everything) fail against real SMTP.

**Cause**

nodemailer resolves `sendMail()` even when individual recipients are rejected — hard failures (connection, auth) throw, but per-recipient SMTP rejections such as `550 unknown user` surface in `rejected`. The memory backend never rejects anyone, so it can only validate your message construction, not deliverability.

**Fix**

Always inspect `rejected` and treat it as a delivery warning. Do not assert `accepted` equals your input against real SMTP:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
});

const result = await mailer.send({
    from: "noreply@example.com",
    to: ["valid@example.com", "unknown@example.com"],
    subject: "Delivery report",
    text: "Watching per-recipient outcomes.",
});

if (result.rejected.length > 0) {
    console.warn("Rejected recipients:", result.rejected);
}
console.log("Accepted recipients:", result.accepted);

await mailer.shutdown();
```

### `messageId` is synthetic on the memory backend — never persist it

**Symptom**

Logs or test fixtures record IDs like `<memory-1720000000000-0@test>`. Downstream systems (support tickets, bounce tracking, analytics joins) cannot correlate anything with them.

**Cause**

`MemoryMailProvider` fabricates IDs via `<memory-${Date.now()}-${index}@test>` for test predictability — unique per send and deterministic in shape, but meaningless outside the process. `MailResult.messageId` is optional everywhere: even SMTP backends may not supply one (the contract tests explicitly tolerate `undefined`).

**Fix**

Treat `messageId` as diagnostic metadata, never as a durable identifier. Generate your own tracking ID when you need one:

```typescript
import { randomUUID } from "node:crypto";

import { createMailProvider, type MailResult } from "blendsdk/webafx-mailer";

const mailer = createMailProvider({ type: "memory" });

const result: MailResult = await mailer.send({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Tracking",
    text: "Do not persist synthetic message IDs.",
});

const trackingId = result.messageId ?? `local-${randomUUID()}`;
console.log("Transport reported:", result.messageId);
console.log("Tracking ID to persist:", trackingId);

await mailer.shutdown();
```

### Default plugin priority (30) can be too late for early consumers

**Symptom**

A plugin whose initialization resolves the mailer service finds nothing (or an unresolved service), even though the mail plugin is registered. Reordering `app.use()` calls appears to fix it — until priorities change elsewhere.

**Cause**

`createMailPlugin()` defaults to `priority: 30` and installs "after most core plugins". WebAFX executes plugin factories in priority order (lower first); if another plugin with a numerically lower priority resolves the mailer during its own factory execution, the mail service has not been registered yet.

**Fix**

Pass an explicit, lower priority so the mail plugin registers before its consumers:

```typescript
import { createMailPlugin, SmtpMailProvider } from "blendsdk/webafx-mailer";

const provider = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
});

// Install early so plugins with lower priorities than the default (30)
// can resolve the "mailer" service during their own initialization.
const plugin = createMailPlugin(provider, { priority: 5 });

console.log(plugin.priority); // 5

await provider.shutdown();
```

### `MailMessage` lets you send a message with no body

**Symptom**

Recipients receive a subject-only email (or a message with only an empty HTML part). Nothing in TypeScript flagged it, and memory-backend tests pass because the message is stored exactly as submitted.

**Cause**

`text` and `html` are both optional in `MailMessage` — the interface documents "at least one of `text` or `html` should be provided", but optional-property types cannot express that constraint, so the compiler accepts a body-less message.

**Fix**

Validate the body before sending — either in a small helper or at your template-rendering boundary:

```typescript
import { MemoryMailProvider, type MailMessage } from "blendsdk/webafx-mailer";

function assertBody(message: MailMessage): MailMessage {
    if (message.text === undefined && message.html === undefined) {
        throw new Error("MailMessage must include text, html, or both.");
    }
    return message;
}

const mailer = new MemoryMailProvider();

await mailer.send(
    assertBody({
        from: "noreply@example.com",
        to: "user@example.com",
        subject: "With a body",
        text: "This one has a body.",
    })
);

console.log("Last subject:", mailer.getLastMessage()?.message.subject); // "With a body"

try {
    await mailer.send(
        assertBody({
            from: "noreply@example.com",
            to: "user@example.com",
            subject: "Missing body",
        })
    );
} catch (error) {
    console.log(error instanceof Error ? error.message : "unexpected failure");
    // MailMessage must include text, html, or both.
}

await mailer.shutdown();
```

---

## Related Documents

- Overview — package scope, architecture diagram, and dependency notes.
- Core Concepts — the `MailProvider` contract, message model, both backends, and the plugin layer in depth.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
