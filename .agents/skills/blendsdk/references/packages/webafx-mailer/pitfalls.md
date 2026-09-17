> **Package**: `blendsdk/webafx-mailer`

# webafx-mailer Best Practices

This document collects the mistakes to avoid and the patterns to follow when working with `blendsdk/webafx-mailer`. Each practice shows the wrong and the correct implementation side by side, with the reasoning behind the recommendation. It builds on the Overview and Core Concepts; for complete application wiring, see Basic Usage.

**In short:**

- Create one provider per SMTP endpoint and reuse it for the process lifetime.
- Always `await send()` and handle its rejection.
- Call `shutdown()` exactly once, at the end of the provider's life — never per operation.
- In WebAFX, register mailers with `smtpMailPlugin()`, `memoryMailPlugin()`, or `createMailPlugin()` — not by hand.
- Choose backends through `createMailProvider()` and validate the environment value at startup.
- Match `secure` to the port: `false` for 587 (STARTTLS), `true` for 465 (implicit TLS).
- Send `text` alongside `html`.
- Use arrays for multiple recipients — never hand-joined strings.
- Reconcile `result.accepted` and `result.rejected` — a resolved `send()` is not proof of delivery to every recipient.
- Test with `MemoryMailProvider`; keep real SMTP for a small integration suite.
- Keep TLS certificate validation enabled and credentials out of source code.

---

## Do / Don't Pairs

### 1. Create the provider once and reuse it

**❌ Wrong** — a new transport for every email:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";
import type { MailResult } from "blendsdk/webafx-mailer";

const smtpPass = process.env.SMTP_PASS;
if (smtpPass === undefined) {
    throw new Error("SMTP_PASS environment variable is required");
}

async function sendWelcomeEmail(to: string): Promise<MailResult> {
    // ❌ New transport per call: full connection setup for every email,
    // and the transport (with its pooled connections) is discarded after one send
    const mailer = new SmtpMailProvider({
        host: "smtp.example.com",
        port: 587,
        secure: false,
        auth: { user: "notifications@example.com", pass: smtpPass },
    });

    const result = await mailer.send({
        from: "noreply@example.com",
        to,
        subject: "Welcome!",
        text: "Welcome to our service!",
    });

    await mailer.shutdown();
    return result;
}
```

**✅ Correct** — one transport for the process:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";
import type { MailResult } from "blendsdk/webafx-mailer";

const smtpPass = process.env.SMTP_PASS;
if (smtpPass === undefined) {
    throw new Error("SMTP_PASS environment variable is required");
}

// ✅ One transport created at startup — the application reuses it (and its
// connection pool) for every email instead of rebuilding it per message
const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "notifications@example.com", pass: smtpPass },
});

async function sendWelcomeEmail(to: string): Promise<MailResult> {
    return mailer.send({
        from: "noreply@example.com",
        to,
        subject: "Welcome!",
        text: "Welcome to our service!",
    });
}

// Shut down once, when the process stops
process.on("SIGTERM", async () => {
    await mailer.shutdown();
});
```

**Why:** `new SmtpMailProvider()` builds a nodemailer transport, and transports are designed to be long-lived — the package's plugin registers providers as `"singleton"` services precisely so the whole application reuses one transport and its connection pool. Creating a transport per email means every message pays the full connection setup again (TCP connect, TLS negotiation, SMTP authentication), gets no reuse out of the pool, and must be closed again or it leaks sockets. One provider per SMTP endpoint, created at startup, is the pattern to follow.

---

### 2. Always `await send()` and handle failure

**❌ Wrong** — fire-and-forget:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.internal.example.com",
    port: 587,
    secure: false,
});

// ❌ Floating promise: the failure never reaches a handler, the MailResult
// is discarded, and the process may exit before the SMTP transaction finishes
mailer.send({
    from: "noreply@example.com",
    to: "alice@example.com",
    subject: "Password reset",
    text: "Click the link to reset your password.",
});
```

**✅ Correct** — awaited and wrapped in `try`/`catch`:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";
import type { MailResult } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.internal.example.com",
    port: 587,
    secure: false,
});

try {
    // ✅ Awaiting surfaces connection/auth failures as catchable errors
    // and provides the MailResult for accepted/rejected bookkeeping
    const result: MailResult = await mailer.send({
        from: "noreply@example.com",
        to: "alice@example.com",
        subject: "Password reset",
        text: "Click the link to reset your password.",
    });
    console.log(`Queued for: ${result.accepted.join(", ")}`);
} catch (error) {
    console.error(
        `Password reset email failed: ${error instanceof Error ? error.message : String(error)}`
    );
}
```

**Why:** SMTP failures — unreachable server, failed authentication, rejected transaction — surface as a rejected promise from `send()`. A floating promise turns them into unhandled rejections, and Node terminates the process by default when a rejection is never handled. On top of that, the `MailResult` is lost and the process may exit before the SMTP transaction completes. Awaiting inside `try`/`catch` gives you both the error and the delivery data. Decide what failure means per flow: retry or queue for critical mail (password resets, receipts), log and continue for best-effort mail.

---

### 3. Close providers with `shutdown()` at end of life

**❌ Wrong** — the transport is never released:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.internal.example.com",
    port: 587,
    secure: false,
});

// ❌ The program stops using the provider but never releases it —
// the transport and its connections linger until the sockets time out
await mailer.send({
    from: "noreply@example.com",
    to: "alice@example.com",
    subject: "Welcome",
    text: "Welcome to our service!",
});
```

**✅ Correct** — shut down once, when the provider is no longer needed:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.internal.example.com",
    port: 587,
    secure: false,
});

await mailer.send({
    from: "noreply@example.com",
    to: "alice@example.com",
    subject: "Welcome",
    text: "Welcome to our service!",
});

// ✅ Release the transport and its connection pool explicitly
await mailer.shutdown();
```

**Why:** `shutdown()` is one-way — it closes the nodemailer transport, and the provider's documentation notes that subsequent `send()` calls will fail afterward. For the memory backend it clears all stored messages. Skipping it leaves pooled connections open until the server or socket times them out. Who calls it depends on the context:

| Context | Where `shutdown()` happens |
|---------|----------------------------|
| WebAFX application | Automatically — the plugin wires `shutdown()` into service disposal and the app shutdown hook |
| Standalone service | Your signal handler (`SIGTERM`/`SIGINT`), called once at process stop |
| Tests | `afterEach` — as the package's own test files do |

---

### 4. Register mailers through the WebAFX plugin factories

**❌ Wrong** — a provider instantiated outside the plugin system:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

// ❌ A provider created on its own is invisible to WebAFX: no singleton
// service registration, no /health entry, no dispose — and nothing
// guarantees a single instance exists application-wide
export const mailer = new SmtpMailProvider({
    host: "smtp.internal.example.com",
    port: 587,
    secure: false,
});
```

**✅ Correct** — one factory call wires everything:

```typescript
import { smtpMailPlugin } from "blendsdk/webafx-mailer";
import type { PluginDefinition } from "blendsdk/webafx";

// ✅ Registered as a "singleton" service, health() feeds /health, and
// shutdown() runs on dispose and on application shutdown
export const mailerPlugin: PluginDefinition = smtpMailPlugin({
    host: "smtp.internal.example.com",
    port: 587,
    secure: false,
});
```

Register the result in the application bootstrap with `app.use(mailerPlugin)`; the provider is then resolved from the service container wherever it's needed. For custom providers, pass any `MailProvider` instance to `createMailPlugin(provider)` instead.

**Why:** `smtpMailPlugin()`, `memoryMailPlugin()`, and `createMailPlugin()` do three things in one call: they register the provider as a `"singleton"` service (one transport for the whole app), feed its `health()` into the application `/health` endpoint, and run its `shutdown()` during graceful shutdown via service disposal plus a plugin hook. A hand-instantiated provider is invisible to all of that — nothing monitors it and nothing closes its transport. The default plugin priority is `30`, which installs mail after most core plugins; override it only when ordering matters (`0` is a valid explicit priority).

---

### 5. Select backends with `createMailProvider()`

**❌ Wrong** — unvalidated type string with a silent fallback:

```typescript
import { MemoryMailProvider, SmtpMailProvider } from "blendsdk/webafx-mailer";
import type { MailProvider } from "blendsdk/webafx-mailer";

// ❌ A typo like MAIL_BACKEND="smt" quietly selects the memory backend —
// production email disappears with no error anywhere
const backend = process.env.MAIL_BACKEND ?? "memory";

const mailer: MailProvider =
    backend === "smtp"
        ? new SmtpMailProvider({
              host: "smtp.example.com",
              port: 587,
              secure: false,
          })
        : new MemoryMailProvider();
```

**✅ Correct** — validate once at startup, then build a typed config:

```typescript
import { createMailProvider } from "blendsdk/webafx-mailer";
import type { MailProvider } from "blendsdk/webafx-mailer";

// ✅ Fail fast on any value outside "smtp" | "memory"
const backendEnv = process.env.MAIL_BACKEND ?? "memory";
if (backendEnv !== "smtp" && backendEnv !== "memory") {
    throw new Error(`MAIL_BACKEND must be "smtp" or "memory", got "${backendEnv}"`);
}

const mailer: MailProvider = createMailProvider({
    type: backendEnv,
    host: process.env.SMTP_HOST ?? "smtp.example.com",
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: false,
});
```

**Why:** `createMailProvider()` exists so the backend decision lives in one place and fails loudly. Hand-rolled selection with a fallback branch maps every unrecognized value to one backend, so a misconfigured environment silently mis-sends (or drops) production email. The factory's `type` is a two-value union in TypeScript, and at runtime any other value throws `Unknown mail type: "<value>". Supported types: "smtp", "memory".` With startup validation on top, wrong configuration stops the application at boot instead of corrupting behavior at runtime — and the same config shape works in every environment, because SMTP-only fields are simply ignored by the memory backend.

---

### 6. Match `secure` to the port

**❌ Wrong** — implicit TLS on a STARTTLS port:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

// ❌ secure: true means "speak TLS from the first byte". Port 587 expects a
// plaintext greeting followed by a STARTTLS upgrade, so the handshake fails
// or times out (ETIMEDOUT / ECONNRESET)
const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: true,
});

await mailer.shutdown();
```

**✅ Correct** — `secure` matches the protocol the port speaks:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

// ✅ Port 587 (client submission): plaintext + STARTTLS upgrade → secure: false
// (this is also the package default — the option can be omitted entirely)
const starttlsMailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
});

// ✅ Port 465 (implicit TLS): TLS from the first byte → secure: true
const implicitTlsMailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 465,
    secure: true,
});

await starttlsMailer.shutdown();
await implicitTlsMailer.shutdown();
```

**Why:** `secure` does not mean "use encryption"; it means "TLS from the first byte". Setting `secure: true` against port 587 makes the client attempt a TLS handshake before the server has offered STARTTLS, which typically produces a connection timeout or reset that is hard to diagnose from the error alone. The package defaults `secure` to `false` (`config.secure ?? false`), which suits modern client submission on 587 — only set `true` for implicit-TLS ports.

| Port | Typical use | Correct `secure` value |
|------|-------------|------------------------|
| 25 | Server-to-server relay (often blocked for submission) | `false` |
| 587 | Client submission with STARTTLS | `false` (default) |
| 465 | Client submission with implicit TLS | `true` |

---

### 7. Send `text` alongside `html`

**❌ Wrong** — HTML-only message:

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

// ❌ HTML-only: degrades badly in plain-text clients and accessibility
// tooling, and a missing text part is a known spam-scoring signal
await mailer.send({
    from: "noreply@example.com",
    to: "alice@example.com",
    subject: "Your invoice",
    html: "<p>Your invoice for May is now available.</p>",
});

await mailer.shutdown();
```

**✅ Correct** — both bodies, with `text` as the fallback:

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

await mailer.send({
    from: "noreply@example.com",
    to: "alice@example.com",
    subject: "Your invoice",
    text: "Your invoice for May is now available.",
    html: "<p>Your invoice for May is <strong>now available</strong>.</p>",
});

await mailer.shutdown();
```

**Why:** `MailMessage.text` is documented as the fallback body used when HTML is also provided; nodemailer combines both parts into a `multipart/alternative` message and each client renders the richest part it supports. HTML-only mail degrades badly in plain-text clients and screen readers, and filters frequently treat the missing text alternative as a spam signal. Generating the text version is cheap — always do it.

---

### 8. Use arrays for multi-recipient messages

**❌ Wrong** — hand-joined recipient string:

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

// ❌ Hand-joined string: the memory backend records this as ONE accepted
// entry containing both addresses, while the SMTP backend parses it into
// two recipients — the same message behaves differently per backend
const result = await mailer.send({
    from: "notifications@example.com",
    to: "alice@example.com, bob@example.com",
    subject: "Team update",
    text: "The weekly sync is moved to Thursday.",
});

console.log(result.accepted);
// ["alice@example.com, bob@example.com"]

await mailer.shutdown();
```

**✅ Correct** — arrays normalize consistently on every backend:

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

// ✅ Per-address results on both backends
const result = await mailer.send({
    from: "notifications@example.com",
    to: ["alice@example.com", "bob@example.com"],
    cc: ["team-leads@example.com"],
    subject: "Team update",
    text: "The weekly sync is moved to Thursday.",
});

console.log(result.accepted);
// ["alice@example.com", "bob@example.com", "team-leads@example.com"]

await mailer.shutdown();
```

**Why:** `MemoryMailProvider` normalizes each recipient field with `Array.isArray(message.to) ? message.to : [message.to]`, so a hand-joined string is stored as one opaque accepted entry, while `SmtpMailProvider` joins arrays with `", "` and lets nodemailer split the address list into individual recipients. The same `MailMessage` therefore produces a different `accepted` shape depending on the backend — and tests written against memory semantics break when you switch to SMTP. Arrays keep `accepted`/`rejected` per address everywhere and make test assertions portable across backends.

---

### 9. Read `rejected`, not just `accepted`

**❌ Wrong** — assuming a resolved promise means full delivery:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.internal.example.com",
    port: 587,
    secure: false,
});

const result = await mailer.send({
    from: "noreply@example.com",
    to: ["alice@example.com", "gone@example.com"], // second mailbox no longer exists
    subject: "Release notes",
    text: "Version 5.x is available.",
});

// ❌ Only counting accepted hides the fact that one recipient never
// received the message — send() resolves because the transaction completed
console.log(`Sent with ${result.accepted.length} accepted`);

await mailer.shutdown();
```

**✅ Correct** — reconcile both lists:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.internal.example.com",
    port: 587,
    secure: false,
});

const result = await mailer.send({
    from: "noreply@example.com",
    to: ["alice@example.com", "gone@example.com"], // second mailbox no longer exists
    subject: "Release notes",
    text: "Version 5.x is available.",
});

// ✅ A resolved send() is not proof of delivery — rejected recipients
// are reported separately
console.log(`Accepted: ${result.accepted.join(", ")}`);

if (result.rejected.length > 0) {
    console.warn(`Rejected: ${result.rejected.join(", ")}`);
}

await mailer.shutdown();
```

**Why:** Delivery is per recipient. An SMTP server can accept `alice@example.com` and reject `gone@example.com` inside the same transaction while `send()` still resolves — `result.rejected` is the only place that partial failure appears. Typos, closed mailboxes, and greylisted recipients all end up there. Log or alert on a non-empty `rejected` array and correct or retry those addresses. Remember that `MemoryMailProvider` can never reject (it reports every recipient as accepted), so this logic can only be exercised against SMTP.

---

### 10. Test with `MemoryMailProvider`

**❌ Wrong** — unit tests against a real SMTP server:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";
import { afterEach, expect, it } from "vitest";

// ❌ Slow, network-dependent, and one bad fixture away from emailing
// a real person from your domain
const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
});

afterEach(async () => {
    await mailer.shutdown();
});

it("sends the welcome email", async () => {
    const result = await mailer.send({
        from: "ci@example.com",
        to: "customer@example.com",
        subject: "Welcome",
        text: "Welcome!",
    });

    expect(result.accepted.length).toBeGreaterThan(0);
});
```

**✅ Correct** — fresh in-memory provider per test:

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import { afterEach, beforeEach, expect, it } from "vitest";

// ✅ No network, fully deterministic, and nothing can leave the process
let mailer: MemoryMailProvider;

beforeEach(() => {
    mailer = new MemoryMailProvider();
});

afterEach(async () => {
    await mailer.shutdown();
});

it("sends the welcome email", async () => {
    await mailer.send({
        from: "noreply@example.com",
        to: "customer@example.com",
        subject: "Welcome",
        text: "Welcome!",
    });

    const sent = mailer.getSentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0].message.subject).toBe("Welcome");
    expect(sent[0].result.accepted).toEqual(["customer@example.com"]);
});
```

**Why:** Unit tests should not depend on network, credentials, or someone else's inbox. `MemoryMailProvider` resolves instantly, keeps every message readable via `getSentMessages()`, `getLastMessage()`, and `clear()`, and generates a deterministic `<memory-...@test>` messageId. A fresh provider per test plus `shutdown()` in `afterEach` mirrors the package's own test files and prevents state leaking between tests. Reserve real SMTP for a small integration suite against a disposable fake like Mailpit — the setup this package's own tests use (SMTP on `:1025`, REST API on `:8025`).

---

## Anti-Patterns

### 1. Using a provider after `shutdown()`

**❌ Wrong** — shutting down the shared provider per request:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";
import type { MailResult } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.internal.example.com",
    port: 587,
    secure: false,
});

async function sendReceipt(orderId: string, to: string): Promise<MailResult> {
    try {
        return await mailer.send({
            from: "orders@example.com",
            to,
            subject: `Receipt for order ${orderId}`,
            text: `Thanks for order ${orderId}.`,
        });
    } finally {
        // ❌ Closes the shared transport after the first request —
        // every later send() fails because the connection pool is gone
        await mailer.shutdown();
    }
}
```

**✅ Correct** — the provider stays open for its whole lifetime:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";
import type { MailResult } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.internal.example.com",
    port: 587,
    secure: false,
});

async function sendReceipt(orderId: string, to: string): Promise<MailResult> {
    return mailer.send({
        from: "orders@example.com",
        to,
        subject: `Receipt for order ${orderId}`,
        text: `Thanks for order ${orderId}.`,
    });
}

// ✅ Shutdown happens once, at application teardown
// (the WebAFX plugin wires this automatically)
process.on("SIGTERM", async () => {
    await mailer.shutdown();
});
```

**Why:** `shutdown()` is a one-way operation: for SMTP it closes the nodemailer transport — the provider's documentation notes that subsequent `send()` calls will fail — and for the memory backend it clears the stored messages. A shutdown hidden in a per-request `finally`, an error handler, or any other spot that runs mid-life silently breaks every later caller of the same provider. Shut down exactly once, when the provider has no more work to do.

---

### 2. Assuming `messageId` is always defined

**❌ Wrong** — non-null assertion on an optional field:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.internal.example.com",
    port: 587,
    secure: false,
});

const result = await mailer.send({
    from: "noreply@example.com",
    to: "alice@example.com",
    subject: "Welcome",
    text: "Welcome to our service!",
});

// ❌ The non-null assertion only silences the compiler — if the transport
// did not assign an ID, this crashes at runtime
console.log(`Message ID length: ${result.messageId!.length}`);

await mailer.shutdown();
```

**✅ Correct** — guard the optional field:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.internal.example.com",
    port: 587,
    secure: false,
});

const result = await mailer.send({
    from: "noreply@example.com",
    to: "alice@example.com",
    subject: "Welcome",
    text: "Welcome to our service!",
});

// ✅ Handle the optional field explicitly, exactly like the package's
// own contract tests do
if (result.messageId !== undefined) {
    console.log(`Message ID: ${result.messageId}`);
} else {
    console.log(`Sent to ${result.accepted.join(", ")} (no message ID assigned)`);
}

await mailer.shutdown();
```

**Why:** `MailResult.messageId` is optional because not every transport assigns one — the package's contract tests explicitly accommodate transports that accept a message without returning an identifier, and only assert the value when it exists. `MemoryMailProvider` always generates a `<memory-...@test>` ID, so tests written against it can hide the assumption. Branch on `messageId !== undefined` before storing or correlating it.

---

### 3. Registering multiple mailers under the default `"mailer"` name

**❌ Wrong** — both providers claim the same service name:

```typescript
import { memoryMailPlugin } from "blendsdk/webafx-mailer";

// ❌ Both register under the default service name — the container key
// collides and the two providers become indistinguishable for resolution,
// health reporting, and shutdown
const transactional = memoryMailPlugin();
const marketing = memoryMailPlugin();

console.log(transactional.name); // "mailer"
console.log(marketing.name);     // "mailer"
```

**✅ Correct** — one distinct `serviceName` per mailer:

```typescript
import { memoryMailPlugin } from "blendsdk/webafx-mailer";

// ✅ Distinct names keep multiple mailers addressable
const transactional = memoryMailPlugin({ serviceName: "transactional-mailer" });
const marketing = memoryMailPlugin({ serviceName: "marketing-mailer" });

console.log(transactional.name); // "transactional-mailer"
console.log(marketing.name);     // "marketing-mailer"
```

**Why:** The plugin name is the provider's `serviceName`, and that name is the service-container registration key — the config documentation itself recommends distinct names "for multi-provider scenarios". Two plugins named `"mailer"` occupy the same key, so the application can no longer tell the transactional mailer from the marketing mailer when resolving services, and health reporting and shutdown hooks address the same name. The `"mailer"` default only fits applications with exactly one mailer.

---

### 4. Mutating messages after `send()`

**❌ Wrong** — editing a message object that the store still references:

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { MailMessage } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

const message: MailMessage = {
    from: "noreply@example.com",
    to: "alice@example.com",
    subject: "Order confirmation",
    text: "Your order is confirmed.",
};

await mailer.send(message);

// ❌ MemoryMailProvider stores the message BY REFERENCE — mutating it after
// send rewrites what the store shows, so assertions and debugging no longer
// reflect what was "sent"
message.subject = "Order cancelled";

console.log(mailer.getLastMessage()?.message.subject); // "Order cancelled"

await mailer.shutdown();
```

**✅ Correct** — build a new object per send; treat entries as read-only:

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

// ✅ Treat submitted messages as immutable
await mailer.send({
    from: "noreply@example.com",
    to: "alice@example.com",
    subject: "Order confirmation",
    text: "Your order is confirmed.",
});

console.log(mailer.getLastMessage()?.message.subject); // "Order confirmation"

// ✅ Reset state with clear(), never by editing stored fields
mailer.clear();

await mailer.shutdown();
```

**Why:** `MemoryMailProvider` pushes each entry as `{ message, result }` — the original object, by reference; its own tests assert identity with `toBe(testMessage)`. Reusing and mutating one message object across sends therefore rewrites history: `getLastMessage()` and every stored entry reflect the latest mutation instead of what was sent. The same care applies to entries returned by `getSentMessages()` — the array is a shallow copy, so the array itself is protected, but the `message` and `result` objects inside are shared with the store.

---

### 5. Treating every mail failure as fatal

**❌ Wrong** — a non-critical email takes down the business flow:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.internal.example.com",
    port: 587,
    secure: false,
});

const registeredUsers: string[] = [];

// ❌ A failed welcome email aborts the whole registration even though the
// account was already created — a mail outage becomes a signup outage
async function registerUser(email: string): Promise<void> {
    registeredUsers.push(email);

    await mailer.send({
        from: "noreply@example.com",
        to: email,
        subject: "Welcome!",
        text: "Welcome to our service!",
    });
}

await registerUser("alice@example.com");
await mailer.shutdown();
```

**✅ Correct** — failure policy matches message criticality:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.internal.example.com",
    port: 587,
    secure: false,
});

const registeredUsers: string[] = [];

async function registerUser(email: string): Promise<void> {
    registeredUsers.push(email);

    try {
        await mailer.send({
            from: "noreply@example.com",
            to: email,
            subject: "Welcome!",
            text: "Welcome to our service!",
        });
    } catch (error) {
        // ✅ Best-effort mail: log (and optionally queue a retry)
        // instead of failing the signup
        console.warn(
            `Welcome email to ${email} failed: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

await registerUser("alice@example.com");
await mailer.shutdown();
```

**Why:** A welcome email and a password reset do not deserve the same failure policy. Failing an entire registration because the mail server hiccuped turns a mail outage into a signup outage; conversely, swallowing a failed password-reset silently locks users out. Decide at the call site per message class: for best-effort mail, catch, log, and optionally queue a retry; for critical mail, surface the failure — retry, queue, or report it to the caller. The mistake is not choosing a policy at all.

---

## Performance Tips

### 1. Keep one provider per SMTP endpoint

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

// ✅ One transport for the process — connection setup is paid once,
// not per email, and the application reuses one connection pool
export const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
});
```

A transport created at startup and held for the process lifetime lets the application reuse its connection pool instead of repeating TCP, TLS, and SMTP-authentication work on every message — the same reason the WebAFX plugin registers providers as `"singleton"` services. Under concurrent load, a shared provider also keeps the number of open sockets bounded instead of growing it with every in-flight send. Under the hood this is the same principle as the [Do/Don't pair above](#1-create-the-provider-once-and-reuse-it).

---

### 2. Don't gate every send on `health()`

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.internal.example.com",
    port: 587,
    secure: false,
});

// ❌ Full EHLO/HELO handshake before every message
await mailer.health();
await mailer.send({
    from: "noreply@example.com",
    to: "alice@example.com",
    subject: "Welcome",
    text: "Welcome to our service!",
});

// ✅ Send directly — health() belongs at startup and behind /health
await mailer.send({
    from: "noreply@example.com",
    to: "bob@example.com",
    subject: "Welcome",
    text: "Welcome to our service!",
});

await mailer.shutdown();
```

`health()` runs nodemailer's `verify()`, which performs a full EHLO/HELO handshake — a network round trip — without sending mail. Calling it before every `send()` doubles the SMTP chatter per message and still cannot prevent the next send from failing (servers can reject specific recipients or messages). Health checks belong at startup (fail fast when the server is unreachable) and behind the `/health` endpoint, which the WebAFX plugin wires automatically; per-message problems belong in the `catch` around `send()`.

---

### 3. Send repeated content to many recipients in one call

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.internal.example.com",
    port: 587,
    secure: false,
});

const recipients = ["alice@example.com", "bob@example.com", "carol@example.com"];

// ❌ One SMTP transaction per recipient — the same body is transmitted three times
for (const recipient of recipients) {
    await mailer.send({
        from: "noreply@example.com",
        to: recipient,
        subject: "Release notes",
        text: "Version 5.x is available.",
    });
}

// ✅ One transaction for the whole list — contacted once, body sent once
await mailer.send({
    from: "noreply@example.com",
    to: recipients,
    subject: "Release notes",
    text: "Version 5.x is available.",
});

await mailer.shutdown();
```

A single `send()` with an array of recipients is one SMTP transaction: the server is contacted once and the message body is transmitted once, while a per-recipient loop pays connection and data-transfer costs for every address. Put the list in `to` only when recipients may see each other; use `bcc` when they may not (see [Security](#4-use-bcc-for-multi-recipient-sends)), and remember most servers cap how many recipients a single transaction can carry — beyond that, use dedicated bulk infrastructure.

---

### 4. Keep attachments lean

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";
import { readFile } from "node:fs/promises";

const mailer = new SmtpMailProvider({
    host: "smtp.internal.example.com",
    port: 587,
    secure: false,
});

// ✅ Read the file once as a Buffer — for very large files, send a link instead
const report = await readFile("./reports/monthly.pdf");

await mailer.send({
    from: "reports@example.com",
    to: "alice@example.com",
    subject: "Monthly report",
    text: "The monthly report is attached.",
    attachments: [
        {
            filename: "monthly.pdf",
            content: report,
            contentType: "application/pdf",
        },
    ],
});

await mailer.shutdown();
```

Attachments dominate the cost of any message: MIME's base64 encoding inflates content by roughly a third on the wire, and the sending process holds the full content in memory while the transport works on it. Attach only what the recipient needs — prefer a link for large files.

---

### 5. Bound the in-memory store in long-running processes

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

for (const customer of ["alice@example.com", "bob@example.com"]) {
    await mailer.send({
        from: "noreply@example.com",
        to: customer,
        subject: "Scheduled maintenance",
        text: "We will perform maintenance tonight.",
    });
}

console.log(mailer.getSentMessages().length); // 2 — retained until cleared

// ✅ Release what you no longer assert on
mailer.clear();
console.log(mailer.getSentMessages().length); // 0
```

The memory backend's whole purpose is retention, so it never discards anything on its own: every stored entry keeps the complete message — including attachment `content` Buffers — until `clear()` or `shutdown()` runs. In a long-running development server or a test suite processing large fixtures, that store grows without bound. Clear it when assertions are done, or create a fresh provider per test.

---

## Security Considerations

The risks this package touches are transport security (TLS), credential handling, sender spoofing, and data exposure through message content and logs.

### 1. Keep TLS certificate validation enabled

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const smtpPass = process.env.SMTP_PASS;
if (smtpPass === undefined) {
    throw new Error("SMTP_PASS environment variable is required");
}

// ✅ Certificate validation is on by default (v5.54 does not hardcode
// rejectUnauthorized: false like earlier versions did) — leave it that way.
// For a private CA, launch with NODE_EXTRA_CA_CERTS=/path/to/ca-bundle.pem
const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "notifications@example.com", pass: smtpPass },
});

await mailer.shutdown();
```

Disabling validation — `tls: { rejectUnauthorized: false }` — makes the client accept any certificate, so a man-in-the-middle can impersonate the SMTP server and capture both the AUTH credentials and the message content. Earlier major versions of this package hardcoded that relaxation; v5.54 exposes it as a configurable option and does not enable it. If you must relax it for a local test server, scope it strictly to that configuration and never ship it.

### 2. Keep credentials out of source code

Credentials live in `SmtpMailConfig.auth` and are your responsibility to source safely. Load them from environment variables or a secret manager at startup — the examples in this document validate `SMTP_PASS` before the provider is constructed — never commit them to the repository, never log the config or the `auth` object (it contains the password), and rotate them like any other production secret. `createMailProvider()` keeps credential loading in one place, which makes rotation a single change.

### 3. Pin the sender address

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";
import type { MailMessage } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.internal.example.com",
    port: 587,
    secure: false,
});

// ✅ The sender is fixed server-side; only the recipient comes from the request.
// Never accept `from` from user input — an authenticated transport can spoof
// any sender address.
function buildResetMessage(recipient: string): MailMessage {
    return {
        from: "noreply@example.com",
        to: recipient,
        subject: "Password reset",
        text: "You requested a password reset. If this wasn't you, ignore this email.",
    };
}

await mailer.send(buildResetMessage("alice@example.com"));
await mailer.shutdown();
```

Once `auth` authorizes your account, whatever address you put in `from` is what recipients see. If user input can reach `from`, your SMTP account can be used to spoof arbitrary senders and damage your domain's sending reputation. Fix the sender server-side, and escape any user data interpolated into `html` bodies so stray markup cannot be injected into the message.

### 4. Use `bcc` for multi-recipient sends

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.internal.example.com",
    port: 587,
    secure: false,
});

// ✅ The recipient list stays private: addresses travel in bcc
await mailer.send({
    from: "updates@example.com",
    to: "announcements@example.com",
    bcc: ["alice@example.com", "bob@example.com"],
    subject: "Scheduled maintenance",
    text: "We will perform maintenance tonight.",
});

await mailer.shutdown();
```

Addresses in `to` (and `cc`) are visible to every recipient of the message. When one message goes to a whole list, put the list in `bcc` — or send per recipient — so subscribers don't disclose each other's addresses.

### 5. Treat message bodies as sensitive in logs and memory

Message bodies regularly contain secrets — password-reset links with embedded tokens, invoices, personal data — and log aggregators retain data far longer than the mail system does. Log metadata instead: subject, recipient counts, and `messageId`. The memory backend is the one place where full messages are intentionally retained until `clear()` or `shutdown()`; it is a development and testing tool, so don't let production payloads rest in it.

---

*For hands-on wiring of everything described here, the Basic Usage guide walks through a complete application setup; the Core Concepts document explains the abstractions these practices build on.*

---

# webafx-mailer Testing Patterns

`blendsdk/webafx-mailer` is built to be testable. The `MemoryMailProvider` backend captures every "sent" message in memory — with deterministic message IDs and the assertion helpers `getSentMessages()`, `getLastMessage()`, and `clear()` — so most tests need no mocking and no infrastructure. Only the SMTP backend needs a live server, which is why the package's own integration suites run against a **Mailpit** Docker container.

This document mirrors the patterns from the package's own test files — they are the source of truth:

| Test file | Docker needed | Covers |
|-----------|---------------|--------|
| `tests/memory-mail-provider.test.ts` | No | In-memory backend, recipient handling, helpers, lifecycle |
| `tests/mail-plugin.test.ts` | No | Plugin factories, `createMailProvider` selection |
| `tests/smtp-mail-provider.test.ts` | Yes (Mailpit) | Real SMTP delivery, health, error paths |
| `tests/abstract-contract.test.ts` | Partly (SMTP run) | Shared contract suite executed against every backend |

Note on imports: the package's own tests import internals with relative paths (`../src/memory-mail-provider.js`) because they live inside the repository. Consumer projects import the same symbols from the package root — `blendsdk/webafx-mailer` — which is what all examples below use.

---

## Test Setup

### Test Framework and Configuration

The package uses **Vitest 4.x** with the Node environment (no jsdom needed — mail sending is server-side), and `@vitest/coverage-v8` for coverage. A configuration that supports every pattern in this document:

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
        // SMTP integration tests poll Mailpit, so allow generous timeouts
        hookTimeout: 30_000,
        testTimeout: 15_000,
    },
});
```

The package's own test scripts show the intended workflow:

| Script | Command | Purpose |
|--------|---------|---------|
| `test:fast` | `vitest run --reporter=verbose` | Quick feedback; Docker-backed suites need Mailpit already running |
| `test:watch` | `vitest watch --reporter=verbose` | Watch mode during development |
| `test:coverage` | `vitest run --coverage` | Coverage run via the v8 provider |
| `test` | `yarn docker:down && yarn docker:up && vitest run && yarn docker:down` | Full cycle: containers managed automatically |
| `docker:up` | `docker-compose -p webafx-mailer -f ./docker/docker-compose${MODE}.yml up -d && sleep 5` | Starts Mailpit (5s readiness wait built in) |
| `docker:down` | `docker-compose -p webafx-mailer -f ./docker/docker-compose${MODE}.yml down -v --remove-orphans` | Stops Mailpit and removes volumes |
| `docker:logs` | `docker-compose ... logs mailpit` | Follows the Mailpit container logs |

The Compose project is named `webafx-mailer` and the compose file path is parameterized with `${MODE}` so alternate compose variants can be selected.

### Required Imports

```typescript
// Test framework
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Package under test (consumers import from the published package name)
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { MailMessage, MailResult, SentMailEntry } from "blendsdk/webafx-mailer";
```

### Docker Dependency: Mailpit

| Item | Value |
|------|-------|
| Container | Mailpit — fake SMTP server, web UI, and REST API |
| SMTP endpoint | `localhost:1025` |
| REST API base | `http://localhost:8025/api/v1` |
| Web UI | `http://localhost:8025` |
| Needed by | `SmtpMailProvider` tests and the SMTP run of the contract suite |
| Not needed by | `MemoryMailProvider` tests, plugin factory tests, `createMailProvider` selection tests |

```bash
# Start Mailpit (the script also waits ~5 seconds for readiness)
yarn docker:up

# Run the Docker-dependent suites
yarn test:fast

# Follow Mailpit logs while debugging
yarn docker:logs

# Tear down and remove volumes
yarn docker:down
```

In CI, reproduce the same sequence as pipeline steps: `docker:down` → `docker:up` → `vitest run` → `docker:down`. Note that `docker:down` uses `-v`, so captured mail never leaks between pipeline runs.

### Test Helpers

**Mailpit REST helpers.** Extract these into `tests/helpers/mailpit.ts` — every SMTP test file needs them:

```typescript
// tests/helpers/mailpit.ts
/**
 * Mailpit REST API helpers for SMTP integration tests.
 *
 * Mailpit indexes incoming messages asynchronously, so `waitForMessage()`
 * polls until the expected message appears instead of fetching once.
 */

const MAILPIT_API = "http://localhost:8025/api/v1";

/** Simplified Mailpit message shape for test assertions */
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

/** Fetch all messages currently stored in Mailpit. */
export async function getMailpitMessages(): Promise<MailpitMessage[]> {
    const response = await fetch(`${MAILPIT_API}/messages`);
    const data = (await response.json()) as { messages: MailpitMessage[] };
    return data.messages ?? [];
}

/**
 * Poll Mailpit until a message with the given subject appears (~5s budget).
 * Returns only the matching message, so assertions are immune to stale
 * messages left over from earlier tests.
 */
export async function waitForMessage(subject: string): Promise<MailpitMessage> {
    const maxAttempts = 25;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const messages = await getMailpitMessages();
        const match = messages.find((message) => message.Subject === subject);
        if (match) {
            return match;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out waiting for Mailpit message with subject "${subject}"`);
}

/** Delete all messages — call this in beforeEach for test isolation. */
export async function clearMailpit(): Promise<void> {
    await fetch(`${MAILPIT_API}/messages`, { method: "DELETE" });
}
```

**Provider cleanup registry.** Providers must be shut down after every test — SMTP closes its transport, Memory clears its store. The package's tests track providers in an array with a defensive `afterEach`:

```typescript
import { afterEach } from "vitest";
import type { MailProvider } from "blendsdk/webafx-mailer";

/** Track providers created by a test file; shut them down after every test. */
const providersToCleanup: MailProvider[] = [];

afterEach(async () => {
    for (const provider of providersToCleanup) {
        try {
            await provider.shutdown();
        } catch {
            // Ignore shutdown errors during cleanup
        }
    }
    providersToCleanup.length = 0;
});
```

Push each provider right after construction: `providersToCleanup.push(mailer);`.

---

## Unit Testing

Unit tests cover everything that does not require a live SMTP server: your own services against `MemoryMailProvider`, provider construction, plugin metadata, and `createMailProvider` backend selection. All of it runs with no Docker.

### Testing a Service That Depends on MailProvider

The idiomatic pattern is **constructor injection of the abstract `MailProvider` type** in production code, and a `MemoryMailProvider` instance in tests. No mocking library is involved — the memory backend *is* the test double.

```typescript
// src/account-service.ts — the code under test
import type { MailProvider } from "blendsdk/webafx-mailer";

export class AccountService {
    constructor(private readonly mailer: MailProvider) {}

    async registerUser(email: string, displayName: string): Promise<void> {
        if (!email.includes("@")) {
            throw new Error(`Invalid email address: "${email}"`);
        }

        await this.mailer.send({
            from: "noreply@example.com",
            to: email,
            subject: `Welcome, ${displayName}!`,
            text: `Welcome to our service, ${displayName}!`,
            html: `<h1>Welcome to our service, ${displayName}!</h1>`,
        });
    }
}
```

```typescript
// tests/account-service.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import { AccountService } from "../src/account-service.js";

describe("AccountService", () => {
    let mailer: MemoryMailProvider;
    let service: AccountService;

    beforeEach(() => {
        // A fresh in-memory provider per test captures only this test's sends
        mailer = new MemoryMailProvider();
        service = new AccountService(mailer);
    });

    afterEach(async () => {
        await mailer.shutdown();
    });

    it("should send a welcome email with plain-text and HTML bodies", async () => {
        await service.registerUser("alice@example.com", "Alice");

        const sent = mailer.getLastMessage();
        expect(sent).toBeDefined();
        expect(sent?.message.to).toBe("alice@example.com");
        expect(sent?.message.subject).toBe("Welcome, Alice!");
        expect(sent?.message.html).toBe("<h1>Welcome to our service, Alice!</h1>");
    });

    it("should report the recipient as accepted", async () => {
        await service.registerUser("alice@example.com", "Alice");

        const sent = mailer.getLastMessage();
        expect(sent?.result.accepted).toEqual(["alice@example.com"]);
        expect(sent?.result.rejected).toEqual([]);
    });

    it("should not send an email when validation fails", async () => {
        await expect(service.registerUser("not-an-address", "Alice")).rejects.toThrow(
            'Invalid email address: "not-an-address"'
        );

        // The store proves nothing was sent
        expect(mailer.getSentMessages()).toHaveLength(0);
    });
});
```

Key points:

- `MemoryMailProvider.send()` **never throws** — use it for happy paths. Use a stubbed provider or an unreachable SMTP config to test failure paths.
- Entries are stored **by reference**: `sent?.message` is the exact object your code submitted, so `toBe` identity checks work. Consequently, mutating a message *after* sending also mutates the stored entry — assert immediately or send cloned fixtures.
- `getSentMessages()` returns a **shallow copy** of the array: mutating the returned array never affects the store.

### Synchronous and Asynchronous Test Shapes

| Scenario | Shape |
|----------|-------|
| Construction, `serviceName` | Sync: `expect(provider.serviceName).toBe("mailer")` |
| Plugin metadata (`name`, `priority`) | Sync: `expect(plugin.priority).toBe(30)` |
| Invalid input errors | Sync: `expect(() => createMailProvider(...)).toThrow(...)` |
| `send()` outcomes | Async: `const result = await mailer.send(message); expect(result.accepted)...` |
| Boolean probes | Async: `await expect(mailer.health()).resolves.toBe(true)` |
| Failures | Async: `await expect(mailer.send(message)).rejects.toThrow()` |
| Cleanup | Async `afterEach`: `await provider.shutdown()` |

Synchronous assertions — provider construction is pure state setup, so plain `expect` works:

```typescript
import { describe, it, expect } from "vitest";
import {
    DEFAULT_SERVICE_NAME,
    MemoryMailProvider,
    SmtpMailProvider,
} from "blendsdk/webafx-mailer";

describe("provider construction (synchronous assertions)", () => {
    it("should default serviceName to DEFAULT_SERVICE_NAME", () => {
        const provider = new MemoryMailProvider();

        expect(provider.serviceName).toBe(DEFAULT_SERVICE_NAME);
        expect(provider.serviceName).toBe("mailer");
    });

    it("should honor a custom serviceName on every backend", () => {
        const memory = new MemoryMailProvider({ serviceName: "transactional-mailer" });

        // Note: constructing an SMTP provider does NOT open a connection —
        // the first network I/O happens in send() or health().
        const smtp = new SmtpMailProvider({
            host: "localhost",
            port: 1025,
            secure: false,
            serviceName: "marketing-mailer",
        });

        expect(memory.serviceName).toBe("transactional-mailer");
        expect(smtp.serviceName).toBe("marketing-mailer");
    });
});
```

Asynchronous assertions — the `resolves`/`rejects` matchers keep await-and-assert compact:

```typescript
import { describe, it, expect } from "vitest";
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

describe("async assertion shapes", () => {
    it("should report an operational memory backend", async () => {
        const mailer = new MemoryMailProvider();

        await expect(mailer.health()).resolves.toBe(true);

        await mailer.shutdown();
    });
});
```

---

## Integration Testing

Integration tests exercise `SmtpMailProvider` against a real SMTP server — the Mailpit container — and verify delivery through Mailpit's REST API rather than trusting the transport alone.

### Running Against Mailpit

Start the container before the suite (`yarn docker:up`), point the provider at `localhost:1025`, and clear Mailpit before each test for isolation:

```typescript
// tests/smtp-mail-provider.test.ts (condensed)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SmtpMailProvider } from "blendsdk/webafx-mailer";
import type { MailMessage } from "blendsdk/webafx-mailer";
import { clearMailpit, waitForMessage } from "./helpers/mailpit.js";

describe("SmtpMailProvider (Mailpit integration)", () => {
    let mailer: SmtpMailProvider;

    beforeEach(async () => {
        mailer = new SmtpMailProvider({
            host: "localhost",
            port: 1025,
            secure: false,
        });
        // Isolate tests — the Mailpit container persists messages between runs
        await clearMailpit();
    });

    afterEach(async () => {
        await mailer.shutdown();
    });

    it("should deliver a message and expose it through the Mailpit API", async () => {
        const message: MailMessage = {
            from: "sender@test.com",
            to: "recipient@test.com",
            subject: "Integration Test",
            text: "Hello from the integration suite.",
        };

        const result = await mailer.send(message);

        expect(result.accepted).toContain("recipient@test.com");
        expect(result.messageId).toBeDefined();

        const received = await waitForMessage("Integration Test");
        expect(received.Subject).toBe("Integration Test");
        expect(received.To.map((entry) => entry.Address)).toContain("recipient@test.com");
    });
});
```

### Health Checks and Failure Paths

`health()` performs an EHLO/HELO handshake (`transporter.verify()`) without sending email, and it never throws — failures resolve to `false`. Sends against an unreachable server reject. Both behaviors are testable against real sockets:

```typescript
import { describe, it, expect } from "vitest";
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

describe("SmtpMailProvider health and failure paths", () => {
    it("should report healthy when Mailpit is reachable", async () => {
        const mailer = new SmtpMailProvider({ host: "localhost", port: 1025, secure: false });

        await expect(mailer.health()).resolves.toBe(true);

        await mailer.shutdown();
    });

    it("should report unhealthy and reject sends when the server is unreachable", async () => {
        // Port 19999 has no listener — connection refused
        const mailer = new SmtpMailProvider({ host: "localhost", port: 19999, secure: false });

        await expect(mailer.health()).resolves.toBe(false);
        await expect(
            mailer.send({
                from: "sender@test.com",
                to: "recipient@test.com",
                subject: "Should Fail",
                text: "This message must never be delivered.",
            })
        ).rejects.toThrow();

        await mailer.shutdown();
    });
});
```

### Attachments and CC Recipients

The Mailpit API exposes recipient lists and an attachment count, so you can verify the full envelope after delivery:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SmtpMailProvider } from "blendsdk/webafx-mailer";
import { clearMailpit, waitForMessage } from "./helpers/mailpit.js";

describe("SmtpMailProvider envelope checks", () => {
    let mailer: SmtpMailProvider;

    beforeEach(async () => {
        mailer = new SmtpMailProvider({ host: "localhost", port: 1025, secure: false });
        await clearMailpit();
    });

    afterEach(async () => {
        await mailer.shutdown();
    });

    it("should preserve attachments through SMTP", async () => {
        await mailer.send({
            from: "sender@test.com",
            to: "recipient@test.com",
            subject: "Attachment Integration Test",
            text: "See attached.",
            attachments: [
                {
                    filename: "test.txt",
                    content: Buffer.from("Hello, attachment!"),
                    contentType: "text/plain",
                },
            ],
        });

        const received = await waitForMessage("Attachment Integration Test");
        expect(received.Attachments).toBe(1);
    });

    it("should deliver CC recipients", async () => {
        await mailer.send({
            from: "sender@test.com",
            to: "recipient@test.com",
            cc: "cc@test.com",
            subject: "CC Integration Test",
            text: "Hello!",
        });

        const received = await waitForMessage("CC Integration Test");
        expect(received.Cc.map((entry) => entry.Address)).toContain("cc@test.com");
    });
});
```

### Avoiding Flaky SMTP Tests

- **Clear Mailpit in `beforeEach`.** The container persists messages across test files and runs; stale messages are the most common source of false positives.
- **Poll, never fetch once.** `send()` resolving only means the SMTP server accepted the message — Mailpit indexes asynchronously. Always use `waitForMessage()`, which also returns only the matching message so array indexing can't pick a stale entry.
- **Use unique subjects per test.** The helper matches on `Subject`, so test-specific subjects make assertions immune to interference.
- **Shut down every provider in `afterEach`.** For SMTP this closes the transport; for Memory it clears the store.
- **Guard cleanup against failed setup.** In shared contract suites, wrap shutdown in `if (provider)` so a failed `beforeEach` (e.g., Docker not running) doesn't cascade into confusing cleanup errors.

---

## Mocking & Stubbing

### Choosing an Approach

| Need | Technique |
|------|-----------|
| Assert *what* your code sent | `MemoryMailProvider` — zero mocking (preferred) |
| Assert call counts/arguments, simulate failures | `StubMailProvider` with `vi.fn()` spies |
| Count calls on a real provider without changing behavior | `vi.spyOn(provider, "send")` |
| Unit test SMTP message mapping without a server | Mock `nodemailer` |
| No dependency injection available in the code under test | `vi.mock` the package module |

### 1. Use MemoryMailProvider (Preferred)

The package ships its own test double. Before writing any mock, check whether the memory backend covers the need:

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

// No mocking library required — the in-memory backend is the test double
const mailer = new MemoryMailProvider();
```

### 2. StubMailProvider with vi.fn()

When you need `toHaveBeenCalledTimes()`-style assertions or scripted failures, extend the abstract class with delegating methods over `vi.fn()` spies:

```typescript
// tests/helpers/stub-mail-provider.ts
import { vi } from "vitest";
import { MailProvider } from "blendsdk/webafx-mailer";
import type { MailMessage, MailProviderConfig, MailResult } from "blendsdk/webafx-mailer";

/**
 * Scriptable test double for MailProvider.
 *
 * Unlike MemoryMailProvider, this stub does not store messages — it exposes
 * vi.fn() spies so tests can assert call counts/arguments and simulate
 * scripted failures with mockRejectedValueOnce().
 */
export class StubMailProvider extends MailProvider {
    /** Spy for send() — records calls and scriptable return values */
    readonly sendMock = vi.fn(
        async (_message: MailMessage): Promise<MailResult> => ({
            accepted: [],
            rejected: [],
            messageId: "<stub@test>",
        })
    );

    /** Spy for health() */
    readonly healthMock = vi.fn(async (): Promise<boolean> => true);

    /** Spy for shutdown() */
    readonly shutdownMock = vi.fn(async (): Promise<void> => undefined);

    constructor(config: MailProviderConfig = {}) {
        super(config);
    }

    override async send(message: MailMessage): Promise<MailResult> {
        return this.sendMock(message);
    }

    override async health(): Promise<boolean> {
        return this.healthMock();
    }

    override async shutdown(): Promise<void> {
        return this.shutdownMock();
    }
}
```

Usage — call assertions and failure simulation against the consumer service from earlier:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { AccountService } from "../src/account-service.js";
import { StubMailProvider } from "./helpers/stub-mail-provider.js";

describe("AccountService with a stubbed mailer", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("should call send exactly once with the welcome message", async () => {
        const mailer = new StubMailProvider();
        const service = new AccountService(mailer);

        await service.registerUser("alice@example.com", "Alice");

        expect(mailer.sendMock).toHaveBeenCalledTimes(1);
        expect(mailer.sendMock).toHaveBeenCalledWith({
            from: "noreply@example.com",
            to: "alice@example.com",
            subject: "Welcome, Alice!",
            text: "Welcome to our service, Alice!",
            html: "<h1>Welcome to our service, Alice!</h1>",
        });
    });

    it("should propagate delivery failures to the caller", async () => {
        const mailer = new StubMailProvider();
        mailer.sendMock.mockRejectedValueOnce(new Error("SMTP connection refused"));
        const service = new AccountService(mailer);

        await expect(service.registerUser("bob@example.com", "Bob")).rejects.toThrow(
            "SMTP connection refused"
        );
    });
});
```

### 3. Spying on a Real Provider

`vi.spyOn` wraps a real method with call tracking while preserving the original implementation — useful to count sends without losing `MemoryMailProvider`'s storage:

```typescript
import { describe, it, expect, vi } from "vitest";
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

describe("spying on a real provider", () => {
    it("should count sends without changing behavior", async () => {
        const mailer = new MemoryMailProvider();
        const sendSpy = vi.spyOn(mailer, "send");

        await mailer.send({
            from: "sender@test.com",
            to: "recipient@test.com",
            subject: "Spy Test",
            text: "Hello",
        });

        expect(sendSpy).toHaveBeenCalledTimes(1);
        // The original implementation still ran — the message was stored:
        expect(mailer.getSentMessages()).toHaveLength(1);

        sendSpy.mockRestore();
        await mailer.shutdown();
    });
});
```

### 4. Mocking nodemailer for SMTP Unit Tests

To unit test `SmtpMailProvider`'s message mapping (array-to-comma joining, attachment mapping, result conversion) without Docker, mock **nodemailer — not the package**. `vi.hoisted()` makes the mock functions visible to the hoisted `vi.mock()` factory:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SmtpMailProvider } from "blendsdk/webafx-mailer";
import type { MailMessage } from "blendsdk/webafx-mailer";

// vi.mock() is hoisted above the imports — vi.hoisted() ensures these
// spies exist by the time the mock factory runs
const nodemailerMock = vi.hoisted(() => {
    const sendMail = vi.fn();
    const verify = vi.fn();
    const close = vi.fn();
    const createTransport = vi.fn(() => ({ sendMail, verify, close }));
    return { sendMail, verify, close, createTransport };
});

vi.mock("nodemailer", () => ({
    default: {
        createTransport: nodemailerMock.createTransport,
    },
}));

describe("SmtpMailProvider (nodemailer mocked)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("should create the transport with SMTP config and secure=false default", () => {
        new SmtpMailProvider({
            host: "smtp.example.com",
            port: 587,
            auth: { user: "user@example.com", pass: "secret" },
        });

        expect(nodemailerMock.createTransport).toHaveBeenCalledWith({
            host: "smtp.example.com",
            port: 587,
            secure: false,
            auth: { user: "user@example.com", pass: "secret" },
            tls: undefined,
        });
    });

    it("should map a MailMessage to the nodemailer format", async () => {
        nodemailerMock.sendMail.mockResolvedValueOnce({
            accepted: ["alice@example.com"],
            rejected: [],
            messageId: "<id@smtp.example.com>",
        });

        const provider = new SmtpMailProvider({ host: "smtp.example.com", port: 587 });
        const message: MailMessage = {
            from: "noreply@example.com",
            to: ["alice@example.com", "bob@example.com"],
            cc: "team@example.com",
            subject: "Hello",
            text: "Hi there",
            html: "<p>Hi there</p>",
            attachments: [
                { filename: "notes.txt", content: Buffer.from("Notes"), contentType: "text/plain" },
            ],
        };

        const result = await provider.send(message);

        expect(nodemailerMock.sendMail).toHaveBeenCalledWith({
            from: "noreply@example.com",
            to: "alice@example.com, bob@example.com",
            cc: "team@example.com",
            bcc: undefined,
            subject: "Hello",
            text: "Hi there",
            html: "<p>Hi there</p>",
            attachments: [
                { filename: "notes.txt", content: Buffer.from("Notes"), contentType: "text/plain" },
            ],
        });

        expect(result).toEqual({
            accepted: ["alice@example.com"],
            rejected: [],
            messageId: "<id@smtp.example.com>",
        });
    });

    it("should report health=false when verify() rejects", async () => {
        nodemailerMock.verify.mockRejectedValueOnce(new Error("Connection refused"));

        const provider = new SmtpMailProvider({ host: "smtp.example.com", port: 587 });

        await expect(provider.health()).resolves.toBe(false);
    });

    it("should close the transport on shutdown", async () => {
        const provider = new SmtpMailProvider({ host: "smtp.example.com", port: 587 });

        await provider.shutdown();

        expect(nodemailerMock.close).toHaveBeenCalledTimes(1);
    });
});
```

Note the deliberate use of `mockResolvedValueOnce`/`mockRejectedValueOnce` and `vi.clearAllMocks()` in `beforeEach` — full `resetAllMocks()` would also wipe the `createTransport` implementation, breaking subsequent constructions.

### 5. Module-Level Mocking with vi.mock

For code under test that constructs providers itself (no injection point), replace the package's `createMailProvider` so tests never open an SMTP connection even when configuration requests `type: "smtp"`. Use `importOriginal` to keep every other export real:

```typescript
// tests/config-selection.test.ts
import { describe, it, expect, vi } from "vitest";
import { MemoryMailProvider, createMailProvider } from "blendsdk/webafx-mailer";
import type { MailFactoryConfig, MailProvider } from "blendsdk/webafx-mailer";

vi.mock("blendsdk/webafx-mailer", async (importOriginal) => {
    const actual = await importOriginal<typeof import("blendsdk/webafx-mailer")>();

    return {
        ...actual,
        // Force the memory backend in tests: code that asks for "smtp"
        // (e.g. via environment-based config) never opens a connection.
        createMailProvider: vi.fn(
            (config: MailFactoryConfig): MailProvider =>
                config.type === "smtp"
                    ? new actual.MemoryMailProvider({ serviceName: config.serviceName })
                    : actual.createMailProvider(config)
        ),
    };
});

describe("environment-driven mail config", () => {
    it("should never create a real SMTP provider in tests", () => {
        const provider = createMailProvider({
            type: "smtp",
            host: "smtp.example.com",
            port: 587,
            serviceName: "notifications",
        });

        expect(provider).toBeInstanceOf(MemoryMailProvider);
        expect(provider.serviceName).toBe("notifications");
        expect(vi.mocked(createMailProvider)).toHaveBeenCalledWith(
            expect.objectContaining({ type: "smtp" })
        );
    });
});
```

Remember: `vi.mock()` calls are hoisted above imports, and the factory cannot reference ordinary top-level variables — use `vi.hoisted()` for shared state. `vi.mocked()` gives typed access to mocked exports for assertions.

**What not to mock:** don't hand-roll a fake SMTP server (Mailpit exists and the package scripts manage it), don't mock `MemoryMailProvider` (it *is* the fake), and don't assert on nodemailer internals unless you are specifically testing the mapping layer shown above.

---

## Test Patterns by Feature

Every pattern below uses the real providers and the setup conventions from this document. The `beforeEach`/`afterEach` scaffolding is shown once per subsection; repeated snippets omit it for brevity but assume the same shape.

### Feature: Message Composition and Recipient Normalization

`to`, `cc`, and `bcc` accept a single string or an array. `MemoryMailProvider` flattens all groups — in `to → cc → bcc` order — into `accepted` and reports nothing as rejected:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { MailMessage } from "blendsdk/webafx-mailer";

describe("message composition", () => {
    let mailer: MemoryMailProvider;

    beforeEach(() => {
        mailer = new MemoryMailProvider();
    });

    afterEach(async () => {
        await mailer.shutdown();
    });

    it("should normalize to + cc + bcc into accepted in order", async () => {
        const result = await mailer.send({
            from: "sender@example.com",
            to: ["alice@example.com", "bob@example.com"],
            cc: "charlie@example.com",
            bcc: ["dave@example.com"],
            subject: "Recipient order",
            text: "Recipients are flattened in to → cc → bcc order.",
        });

        expect(result.accepted).toEqual([
            "alice@example.com",
            "bob@example.com",
            "charlie@example.com",
            "dave@example.com",
        ]);
        expect(result.rejected).toEqual([]);
    });

    it("should accept a single string or an array interchangeably", async () => {
        const single = await mailer.send({
            from: "sender@example.com",
            to: "recipient@example.com",
            subject: "Single",
            text: "Single recipient.",
        });
        const array = await mailer.send({
            from: "sender@example.com",
            to: ["recipient@example.com"],
            subject: "Array",
            text: "Array recipient.",
        });

        expect(single.accepted).toEqual(array.accepted);
    });

    it("should preserve attachments and both body variants", async () => {
        const content = Buffer.from("Report data", "utf8");
        const message: MailMessage = {
            from: "sender@example.com",
            to: "recipient@example.com",
            subject: "With attachment",
            text: "Plain-text body",
            html: "<p>HTML body</p>",
            attachments: [{ filename: "report.txt", content, contentType: "text/plain" }],
        };

        await mailer.send(message);

        // The message is stored by reference — toBe identity works
        const sent = mailer.getLastMessage();
        expect(sent?.message).toBe(message);
        expect(sent?.message.text).toBe("Plain-text body");
        expect(sent?.message.html).toBe("<p>HTML body</p>");
        expect(sent?.message.attachments).toHaveLength(1);
        expect(sent?.message.attachments?.[0].filename).toBe("report.txt");
        expect(sent?.message.attachments?.[0].content).toEqual(content);
    });
});
```

### Feature: Send Results and Message IDs

The memory backend guarantees deterministic, unique message IDs matching `/^<memory-\d+-\d+@test>$/`. Every stored entry pairs the submitted message with the exact result `send()` returned:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { MailMessage, SentMailEntry } from "blendsdk/webafx-mailer";

const testMessage: MailMessage = {
    from: "sender@test.com",
    to: "recipient@test.com",
    subject: "Test Email",
    text: "Hello, this is a test email.",
};

describe("send results", () => {
    let mailer: MemoryMailProvider;

    beforeEach(() => {
        mailer = new MemoryMailProvider();
    });

    afterEach(async () => {
        await mailer.shutdown();
    });

    it("should generate a deterministic messageId pattern", async () => {
        const result = await mailer.send(testMessage);

        expect(result.messageId).toMatch(/^<memory-\d+-\d+@test>$/);
    });

    it("should generate unique messageIds for consecutive sends", async () => {
        const first = await mailer.send(testMessage);
        const second = await mailer.send(testMessage);

        expect(first.messageId).not.toBe(second.messageId);
    });

    it("should pair every stored entry with its result", async () => {
        const result = await mailer.send(testMessage);

        const entry: SentMailEntry | undefined = mailer.getLastMessage();
        expect(entry?.message).toBe(testMessage);
        expect(entry?.result).toEqual(result);
    });

    it("should default rejected to an empty array", async () => {
        const result = await mailer.send(testMessage);

        expect(result.accepted).toEqual(["recipient@test.com"]);
        expect(result.rejected).toEqual([]);
    });
});
```

### Feature: Memory Provider Test Helpers

Three helpers make assertions trivial — and each has a documented edge worth testing: `getSentMessages()` returns a defensive copy, `getLastMessage()` returns `undefined` when empty, and `clear()` resets state for long-lived providers:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

describe("memory provider helpers", () => {
    let mailer: MemoryMailProvider;

    beforeEach(() => {
        // Fresh instance per test is the preferred isolation strategy;
        // clear() is for when a provider instance must be reused.
        mailer = new MemoryMailProvider();
    });

    it("should return a defensive copy from getSentMessages()", async () => {
        await mailer.send({
            from: "sender@test.com",
            to: "recipient@test.com",
            subject: "Copy Test",
            text: "Hello",
        });

        const copy = mailer.getSentMessages();
        copy.length = 0; // Mutating the copy...

        // ...does not affect the internal store
        expect(mailer.getSentMessages()).toHaveLength(1);
    });

    it("should return undefined from getLastMessage() when empty", () => {
        expect(mailer.getLastMessage()).toBeUndefined();
    });

    it("should reset between test cases with clear()", async () => {
        await mailer.send({
            from: "sender@test.com",
            to: "recipient@test.com",
            subject: "Before clear",
            text: "Hello",
        });

        mailer.clear();

        expect(mailer.getSentMessages()).toEqual([]);
        expect(mailer.getLastMessage()).toBeUndefined();

        // The same provider instance can be reused after clear()
        await mailer.send({
            from: "sender@test.com",
            to: "recipient@test.com",
            subject: "After clear",
            text: "Hello again",
        });
        expect(mailer.getLastMessage()?.message.subject).toBe("After clear");
    });
});
```

### Feature: Provider Lifecycle

Memory lifecycle is trivial to assert — health is always `true`, and `shutdown()` clears the store. Assert **before** shutdown: `shutdown()` empties `messages`, so any `getSentMessages()` check afterwards sees zero entries:

```typescript
import { describe, it, expect } from "vitest";
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

describe("memory provider lifecycle", () => {
    it("should always report healthy, before and after sends", async () => {
        const mailer = new MemoryMailProvider();

        await expect(mailer.health()).resolves.toBe(true);

        await mailer.send({
            from: "sender@test.com",
            to: "recipient@test.com",
            subject: "Health Test",
            text: "Hello",
        });

        await expect(mailer.health()).resolves.toBe(true);

        await mailer.shutdown();
    });

    it("should clear the store on shutdown", async () => {
        const mailer = new MemoryMailProvider();

        await mailer.send({
            from: "sender@test.com",
            to: "recipient@test.com",
            subject: "Shutdown Test",
            text: "Hello",
        });
        expect(mailer.getSentMessages()).toHaveLength(1);

        await mailer.shutdown();

        expect(mailer.getSentMessages()).toHaveLength(0);
    });
});
```

SMTP lifecycle (health true against Mailpit, `false` against a closed port, sends rejected when unreachable, shutdown completing cleanly) is covered in [Integration Testing](#integration-testing).

### Feature: Plugin Factory Metadata

`PluginDefinition`s are plain objects, so factory tests are fully synchronous and need no Docker. Assert `name` (from `provider.serviceName`), `priority` (default `30`, overridable — `0` is preserved because the code uses `??`, not `||`), and that `factory` is installed:

```typescript
import { describe, it, expect } from "vitest";
import {
    createMailPlugin,
    MemoryMailProvider,
    memoryMailPlugin,
    smtpMailPlugin,
} from "blendsdk/webafx-mailer";

describe("plugin factories", () => {
    it("should name the plugin after the provider serviceName", () => {
        const plugin = createMailPlugin(
            new MemoryMailProvider({ serviceName: "transactional-mailer" })
        );

        expect(plugin.name).toBe("transactional-mailer");
    });

    it("should default priority to 30 and honor explicit values including 0", () => {
        const provider = new MemoryMailProvider();

        expect(createMailPlugin(provider).priority).toBe(30);
        expect(createMailPlugin(provider, { priority: 10 }).priority).toBe(10);
        expect(createMailPlugin(provider, { priority: 0 }).priority).toBe(0);
    });

    it("should build one-liner plugins for both backends", () => {
        expect(memoryMailPlugin().name).toBe("mailer");
        expect(memoryMailPlugin({ serviceName: "mem-mailer" }).name).toBe("mem-mailer");

        // Constructing the SMTP-backed plugin creates a transport but does not
        // connect — the first network I/O happens in send() or health().
        const smtp = smtpMailPlugin({
            host: "localhost",
            port: 1025,
            secure: false,
            serviceName: "smtp-mailer",
        });

        expect(smtp.name).toBe("smtp-mailer");
        expect(typeof smtp.factory).toBe("function");
    });
});
```

Do not invoke `plugin.factory()` in unit tests — executing it requires a WebAFX application context (`app.registerService`, `logger.info`). Verifying that the provider is registered as a singleton, that health is hooked into the health endpoint, and that shutdown runs during graceful shutdown belongs in your application-level integration suite, where a real WebAFX app installs the plugin.

### Feature: Backend Selection with createMailProvider

`createMailProvider()` is tested by asserting the returned class with `instanceof`, verifying `serviceName` pass-through, and — most importantly — pinning the fail-fast error message for invalid runtime types (TypeScript cannot catch a bad value arriving from a config file or environment variable, hence the deliberate `as "smtp"` casts in tests):

```typescript
import { describe, it, expect } from "vitest";
import {
    MemoryMailProvider,
    SmtpMailProvider,
    createMailProvider,
} from "blendsdk/webafx-mailer";

describe("createMailProvider selection", () => {
    it("should return the backend matching the type discriminator", () => {
        const memory = createMailProvider({ type: "memory" });
        const smtp = createMailProvider({ type: "smtp", host: "localhost", port: 1025 });

        expect(memory).toBeInstanceOf(MemoryMailProvider);
        expect(smtp).toBeInstanceOf(SmtpMailProvider);
    });

    it("should pass serviceName through to the selected backend", () => {
        const provider = createMailProvider({ type: "memory", serviceName: "custom-mailer" });

        expect(provider.serviceName).toBe("custom-mailer");
    });

    it("should default serviceName to 'mailer'", () => {
        const provider = createMailProvider({ type: "memory" });

        expect(provider.serviceName).toBe("mailer");
    });

    it("should fail fast with a descriptive error for unknown types", () => {
        expect(() => createMailProvider({ type: "sendgrid" as "smtp" })).toThrow(
            'Unknown mail type: "sendgrid"'
        );
        expect(() => createMailProvider({ type: "invalid" as "smtp" })).toThrow(
            'Supported types: "smtp", "memory"'
        );
    });
});
```

Track every provider you construct here in `providersToCleanup` (see [Test Setup](#test-setup)) — the SMTP instance owns a transport even though no connection is opened.

### Feature: Contract Tests for Custom Backends

The package's signature testing pattern is a **shared contract suite**: one function runs the identical assertions against every backend, proving that `SmtpMailProvider`, `MemoryMailProvider`, and your own custom providers are interchangeable. Note the optional `beforeEachHook` (used to clear Mailpit for the SMTP run) and the `if (provider)` guard that keeps cleanup safe when setup fails:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MailProvider, MemoryMailProvider, SmtpMailProvider } from "blendsdk/webafx-mailer";
import type { MailMessage, MailProviderConfig, MailResult } from "blendsdk/webafx-mailer";
import { clearMailpit } from "./helpers/mailpit.js";

/** Simple message used across every contract run */
const contractMessage: MailMessage = {
    from: "contract-sender@test.com",
    to: "contract-recipient@test.com",
    subject: "Contract Test",
    text: "Testing the MailProvider contract.",
};

/**
 * Shared contract suite — runs the same assertions against any backend.
 * The optional beforeEachHook handles per-backend setup (e.g., clearing Mailpit).
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
            // Guard against provider being undefined if setup failed
            // (e.g., when Mailpit Docker isn't running)
            if (provider) {
                await provider.shutdown();
            }
        });

        it("should return accepted recipients from send()", async () => {
            const result = await provider.send(contractMessage);

            expect(Array.isArray(result.accepted)).toBe(true);
            expect(result.accepted.length).toBeGreaterThan(0);
            expect(result.accepted).toContain("contract-recipient@test.com");
        });

        it("should always return a rejected array", async () => {
            const result = await provider.send(contractMessage);

            expect(Array.isArray(result.rejected)).toBe(true);
        });

        it("should supply a non-empty messageId when the transport provides one", async () => {
            const result = await provider.send(contractMessage);

            // Asynchronous APIs (e.g., Microsoft Graph-style transports) may
            // accept a message without returning a transport message id.
            if (result.messageId !== undefined) {
                expect(typeof result.messageId).toBe("string");
                expect(result.messageId.length).toBeGreaterThan(0);
            }
        });

        it("should report health as a boolean and be operational", async () => {
            const health = await provider.health();

            expect(typeof health).toBe("boolean");
            expect(health).toBe(true);
        });

        it("should default serviceName to 'mailer'", () => {
            expect(provider.serviceName).toBe("mailer");
        });

        it("should shut down without throwing", async () => {
            await provider.shutdown();
        });
    });
}

/** Minimal custom backend that satisfies the contract without network I/O */
class EchoMailProvider extends MailProvider {
    constructor(config: MailProviderConfig = {}) {
        super(config);
    }

    override async send(message: MailMessage): Promise<MailResult> {
        const recipients = Array.isArray(message.to) ? message.to : [message.to];
        return {
            accepted: recipients,
            rejected: [],
            messageId: "<echo@test>",
        };
    }

    override async health(): Promise<boolean> {
        return true;
    }

    override async shutdown(): Promise<void> {
        return undefined;
    }
}

// Memory backend — runs anywhere
runContractTests("MemoryMailProvider", () => new MemoryMailProvider());

// SMTP backend — requires Mailpit on localhost:1025/8025
runContractTests(
    "SmtpMailProvider",
    () => new SmtpMailProvider({ host: "localhost", port: 1025, secure: false }),
    clearMailpit
);

// Your own backend — the same suite proves contract parity
runContractTests("EchoMailProvider", () => new EchoMailProvider());
```

When you write a custom provider, add it to this suite first: if it passes, application code depending on `MailProvider` can swap it for the bundled backends without changes — and any future behavior drift is caught by the shared assertions rather than by production.

---

For the concepts behind these patterns, see Core Concepts; for API-level detail on every type used above, see Overview.

---

# webafx-mailer Troubleshooting

This document covers the errors you are most likely to encounter with `blendsdk/webafx-mailer`, how to diagnose mail problems systematically, and the subtle behaviors that are easy to miss. Every issue follows the same structure: **Symptom → Cause → Fix**.

Most problems fall into one of three buckets:

- **Connectivity / TLS** — the SMTP server is unreachable or the transport is misconfigured (`secure`, certificates).
- **Authentication** — credentials are missing or rejected by the SMTP server.
- **Configuration drift** — the application is not using the backend (or the values) you think it is.

---

## Quick Diagnosis

| Symptom | Most likely cause | Error group |
|---------|-------------------|-------------|
| `send()` rejects with `connect ECONNREFUSED` | Nothing listening at `host:port` (container down, wrong port) | SMTP Connection and TLS Errors |
| `send()` rejects with `Connection timeout` or `Greeting never received` | Outbound port blocked by firewall / cloud provider | SMTP Connection and TLS Errors |
| TLS handshake exception ending in `wrong version number` | `secure` does not match the port (465 vs 587) | SMTP Connection and TLS Errors |
| `self-signed certificate in certificate chain` | Internal SMTP server with a private CA | SMTP Connection and TLS Errors |
| `Invalid login: 535 ...` | Wrong password or missing app password | SMTP Authentication Errors |
| `Missing credentials for "PLAIN"` / `530 5.7.0 Authentication required` | Server requires authentication; `auth` omitted | SMTP Authentication Errors |
| `Unknown mail type: "..."` | Runtime value outside `"smtp" \| "memory"` | Factory and Configuration Errors |
| Sends "succeed" but nothing is delivered | Memory backend active where SMTP was expected | Factory and Configuration Errors |
| `Cannot find module 'blendsdk/webafx'` | Optional peer dependency not installed | TypeScript Compile Errors |
| Tests fail with `TypeError: fetch failed` | Mailpit Docker container not running | Test Suite Errors |
| Tests fail with `Timed out waiting for Mailpit message...` | Mailpit indexing race, or the message was never sent | Test Suite Errors |

---

## Common Errors

### SMTP Connection and TLS Errors

#### 1. `Error: connect ECONNREFUSED 127.0.0.1:1025`

**Symptom** — `send()` rejects with a connection-refused error; `health()` resolves `false`. The stack trace contains `errno: -61`, `code: 'ECONNREFUSED'`, `syscall: 'connect'` plus the address and port.

**Cause** — Nothing is listening on the configured `host`/`port` combination. Typical cases: the local Mailpit container used by the test suite is not running, the port is wrong (SMTP is `1025`, not `8025` — `8025` is Mailpit's *HTTP API*), or a production server moved.

**Fix** — Probe the provider with `health()` before sending, and start the local container when testing:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({ host: "localhost", port: 1025, secure: false });

const reachable = await mailer.health();
if (!reachable) {
    console.error(
        "SMTP server unreachable — for the local test container run `yarn docker:up` " +
            "from the package directory (Mailpit listens on SMTP :1025, API :8025)."
    );
} else {
    const result = await mailer.send({
        from: "sender@test.com",
        to: "recipient@test.com",
        subject: "Connectivity check",
        text: "The SMTP connection works.",
    });
    console.log(`Accepted: ${result.accepted.join(", ")}`);
}

await mailer.shutdown();
```

---

#### 2. `Error: Connection timeout` / `Error: Greeting never received`

**Symptom** — `send()` hangs for a while and then rejects with `Connection timeout` or `Greeting never received` (the TCP connection succeeded, but the SMTP banner never arrived). `health()` resolves `false`.

**Cause** — The network path is blocked rather than refused. The most common culprit is outbound port `25`, which ISPs and cloud providers routinely block to fight spam; corporate firewalls and security groups can also blackhole specific ports.

**Fix** — Use a submission port that is meant for client sending (`587` with STARTTLS, or `465` with implicit TLS), and verify egress rules:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

// Prefer 587 (STARTTLS) or 465 (implicit TLS) — many networks block outbound port 25
const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "notifications@example.com", pass: "smtp-secret" },
});

const healthy = await mailer.health();
console.log(healthy); // true when TCP connect, greeting, and AUTH all succeed

await mailer.shutdown();
```

---

#### 3. TLS handshake fails with `...error:0A00010B:SSL routines::wrong version number`

**Symptom** — `send()` or `health()` rejects with an OpenSSL exception whose tail reads `wrong version number`, e.g. `Error: 8030ADF801000000:error:0A00010B:SSL routines::wrong version number`.

**Cause** — `secure` does not match the port. `secure: true` means *implicit TLS from the first byte* (port `465`). Connecting that way to a STARTTLS port (`587`, or Mailpit's `1025`) makes the client speak TLS to a plaintext server, and the handshake explodes with `wrong version number`. The reverse mismatch (`secure: false` against `465`) hangs or fails with `Greeting never received` because the server waits for a TLS handshake that never comes.

**Fix** — Pair `secure` with the port. Note the package default is `secure: false` (`config.secure ?? false`), which is correct for `587`:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";
import type { SmtpMailConfig } from "blendsdk/webafx-mailer";

// Port 465 — implicit TLS from the first byte
const implicitTls: SmtpMailConfig = {
    host: "smtp.example.com",
    port: 465,
    secure: true,
    auth: { user: "notifications@example.com", pass: "smtp-secret" },
};

// Port 587 — plain connection upgraded via STARTTLS (`secure` defaults to false)
const startTls: SmtpMailConfig = {
    host: "smtp.example.com",
    port: 587,
    auth: { user: "notifications@example.com", pass: "smtp-secret" },
};

for (const config of [implicitTls, startTls]) {
    const mailer = new SmtpMailProvider(config);
    console.log(`port ${config.port}, secure ${config.secure ?? false}: ${await mailer.health()}`);
    await mailer.shutdown();
}
```

---

#### 4. `Error: self-signed certificate in certificate chain`

**Symptom** — `send()` and `health()` fail against an internal or self-hosted SMTP server with `self-signed certificate in certificate chain`, `SELF_SIGNED_CERT_IN_CHAIN`, or `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, while the same server works with other tools.

**Cause** — Unlike older versions of this package, `SmtpMailProvider` does **not** hardcode `tls.rejectUnauthorized: false`. Certificate validation is active by default, so private/internal CAs are rejected until you trust them via the `tls` option.

**Fix** — Pass the internal CA through `tls` (preferred); only disable validation for trusted internal networks as a last resort:

```typescript
import { readFileSync } from "node:fs";
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

// Preferred: trust the private CA explicitly
const ca = readFileSync("./certs/internal-ca.pem");

const trusted = new SmtpMailProvider({
    host: "mail.internal.example.com",
    port: 587,
    secure: false,
    tls: { ca },
});

// Last resort — trusted internal networks only. Disables certificate validation,
// which exposes the connection to man-in-the-middle attacks.
const insecure = new SmtpMailProvider({
    host: "mail.internal.example.com",
    port: 587,
    secure: false,
    tls: { rejectUnauthorized: false },
});

console.log(await trusted.health());
console.log(await insecure.health());

await trusted.shutdown();
await insecure.shutdown();
```

---

### SMTP Authentication Errors

#### 5. `Error: Missing credentials for "PLAIN"` / `Error: 530 5.7.0 Authentication required`

**Symptom** — `send()` rejects with `Missing credentials for "PLAIN"`, or the server answers `530 5.7.0 Authentication required`. `health()` resolves `false` against the same config.

**Cause** — The SMTP server advertises the `AUTH` extension and requires it, but `SmtpMailConfig.auth` was omitted. `auth` is optional in the config type because unauthenticated relays (like local Mailpit) exist, so TypeScript cannot catch this — the server does, at connect time.

**Fix** — Supply `auth`. Since `health()` uses nodemailer's `verify()`, which performs EHLO **and** authentication, a passing health check proves the credentials are accepted:

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

const healthy = await mailer.health();
console.log(healthy); // true only when EHLO and AUTH both complete successfully

await mailer.shutdown();
```

---

#### 6. `Error: Invalid login: 535-5.7.8 Username and Password not accepted`

**Symptom** — `verify()` (and therefore `health()`) reports authentication failure; `send()` rejects with `Invalid login: 535-5.7.8 Username and Password not accepted` or a provider-specific 535 variant.

**Cause** — The credentials themselves are wrong, or the provider refuses normal account passwords for SMTP clients. Gmail, Microsoft 365, and most hosted providers require an **app password** (or OAuth) and reject the interactive account password. A common variant is forgetting that `auth.user` usually must be the *full email address*, not a short username.

**Fix** — Generate an app-specific password in the provider's account settings and use it together with the full address:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
        user: "you@example.com",
        // 16-character app password, generated in the account settings —
        // NOT the normal account password (those are rejected with 535).
        pass: "abcdefghijklmnop",
    },
});

const healthy = await mailer.health();
console.log(healthy ? "credentials accepted" : "credentials rejected — regenerate the app password");

await mailer.shutdown();
```

---

### Factory and Configuration Errors

#### 7. `Error: Unknown mail type: "sendgrid". Supported types: "smtp", "memory".`

**Symptom** — `createMailProvider()` throws immediately with `Unknown mail type: "<value>". Supported types: "smtp", "memory".` Typically during application startup, after a config file or environment variable is read.

**Cause** — This is the factory's runtime exhaustiveness guard. TypeScript's union type prevents invalid values at compile time, but values arriving from `JSON.parse`, `process.env`, or a config file are outside the compiler's view — a typo like `"Mailgun"` or `"SENDGRID"` slips through and hits the `default` branch.

**Fix** — Validate untrusted values with a type guard before calling the factory, so the error names your own configuration source and fails earlier:

```typescript
import { createMailProvider } from "blendsdk/webafx-mailer";
import type { MailFactoryConfig } from "blendsdk/webafx-mailer";

function isMailBackendType(value: string): value is MailFactoryConfig["type"] {
    return value === "smtp" || value === "memory";
}

const rawType: string = process.env.MAIL_BACKEND ?? "memory";

if (!isMailBackendType(rawType)) {
    throw new Error(`Invalid MAIL_BACKEND "${rawType}" — expected "smtp" or "memory".`);
}

const mailer = createMailProvider({ type: rawType });
console.log(`Mailer "${mailer.serviceName}" created (${mailer.constructor.name})`);

await mailer.shutdown();
```

If an invalid value nonetheless reaches the factory (for example from a JSON config), it still fails fast — the guard is a safety net, not a replacement:

```typescript
import { createMailProvider } from "blendsdk/webafx-mailer";
import type { MailFactoryConfig } from "blendsdk/webafx-mailer";

// Config files are `unknown` at the type level until validated/parsed
const rawConfig: unknown = JSON.parse(process.env.MAIL_CONFIG ?? '{"type":"mailgun"}');

try {
    createMailProvider(rawConfig as MailFactoryConfig);
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    // Unknown mail type: "mailgun". Supported types: "smtp", "memory".
}
```

---

#### 8. SMTP send fails against `localhost` even though SMTP settings are configured

**Symptom** — `send()` rejects with a connection error pointing at localhost — for example `Error: connect ECONNREFUSED 127.0.0.1:587` — although `SMTP_HOST`/`SMTP_PORT` appear to be set in the deployment.

**Cause** — `MailFactoryConfig` marks `host` and `port` as optional (the same interface also serves the `"memory"` type), and `createMailProvider()` forwards them with non-null assertions (`config.host!`, `config.port!`). If the environment variables were `undefined` — a typo'd variable name, a `.env` file that was never loaded, a missing secret in the deployment — TypeScript cannot warn you, the `undefined` values flow into nodemailer, and the failure only surfaces at send time against nodemailer's fallback host (`localhost`).

**Fix** — Validate the required values explicitly at startup so the process fails with a precise message instead of a misleading connection error:

```typescript
import { createMailProvider } from "blendsdk/webafx-mailer";

function requireEnv(name: string): string {
    const value = process.env[name];
    if (value === undefined || value === "") {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

const mailer = createMailProvider({
    type: "smtp",
    host: requireEnv("SMTP_HOST"),
    port: Number(requireEnv("SMTP_PORT")),
    secure: false,
    auth: {
        user: requireEnv("SMTP_USER"),
        pass: requireEnv("SMTP_PASS"),
    },
});

console.log(`Mailer ready: service "${mailer.serviceName}"`);

await mailer.shutdown();
```

---

#### 9. Emails silently never arrive — the memory backend is active

**Symptom** — `send()` resolves successfully, `accepted` is fully populated, no error is logged — but no email is ever delivered. The application appears to work perfectly. The `messageId` always starts with `<memory-`.

**Cause** — The environment-based switch (`type: process.env.NODE_ENV === "production" ? "smtp" : "memory"`) silently picked the memory backend, usually because `NODE_ENV` was not set (or was spelled differently) in the deployed process. `MemoryMailProvider` never throws and never touches the network, so nothing indicates a problem.

**Fix** — Make the backend selection explicit and refuse to start in production with the memory backend. The tell-tale sign is the `messageId` prefix:

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();
const result = await mailer.send({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Password reset",
    text: "Reset link inside.",
});

// The tell-tale sign that nothing was delivered:
console.log(result.messageId?.startsWith("<memory-")); // true

await mailer.shutdown();
```

```typescript
import { SmtpMailProvider, createMailProvider } from "blendsdk/webafx-mailer";
import type { MailFactoryConfig, MailProvider } from "blendsdk/webafx-mailer";

function createAppMailer(): MailProvider {
    const requested = process.env.MAIL_BACKEND;
    const isProduction = process.env.NODE_ENV === "production";

    // Fail fast instead of silently dropping mail in production
    if (isProduction && requested !== "smtp") {
        throw new Error(
            `Refusing to start: production requires MAIL_BACKEND="smtp" ` +
                `(got "${requested ?? "undefined"}").`
        );
    }

    const config: MailFactoryConfig = {
        type: requested === "smtp" ? "smtp" : "memory",
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
    };

    return createMailProvider(config);
}

const mailer = createAppMailer();

// Belt and braces: log the concrete backend class on startup
if (!(mailer instanceof SmtpMailProvider)) {
    console.warn(`Using the ${mailer.constructor.name} — emails will NOT be delivered.`);
}

await mailer.shutdown();
```

---

### TypeScript Compile Errors

#### 10. `error TS2307: Cannot find module 'blendsdk/webafx' or its corresponding type declarations.`

**Symptom** — The project compiles fine at runtime but `tsc` reports `error TS2307: Cannot find module 'blendsdk/webafx' or its corresponding type declarations.` pointing into `node_modules/blendsdk/webafx-mailer/dist/mail-plugin.d.ts`.

**Cause** — `blendsdk/webafx` is an **optional** peer dependency (declared in `peerDependenciesMeta`), so npm/yarn does not install it automatically. The package's declaration files reference `PluginDefinition` from `blendsdk/webafx` in the plugin factory signatures; without the package present, TypeScript cannot resolve that type import.

**Fix** — Install `blendsdk/webafx` so the type resolution succeeds. If you only use the providers standalone (no plugin factories), a dev dependency is sufficient because the runtime import is type-only:

```bash
yarn add -D blendsdk/webafx@^5.x
```

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import { memoryMailPlugin } from "blendsdk/webafx-mailer";
import type { PluginDefinition } from "blendsdk/webafx";

// Provider usage needs no WebAFX at runtime…
const mailer = new MemoryMailProvider();
await mailer.send({ from: "a@example.com", to: "b@example.com", subject: "Hi", text: "Hello" });
await mailer.shutdown();

// …but the plugin factory types reference PluginDefinition from blendsdk/webafx
const plugin: PluginDefinition = memoryMailPlugin();
console.log(plugin.name); // "mailer"
```

If you cannot install the package, `"skipLibCheck": true` in `tsconfig.json` suppresses errors originating inside dependency declaration files — but it silences *all* of them, so prefer installing the peer dependency.

---

#### 11. `error TS2339: Property 'getSentMessages' does not exist on type 'MailProvider'.`

**Symptom** — Test code calling `mailer.getSentMessages()` compiles only while the variable is typed as `MemoryMailProvider`; the moment it is declared as `MailProvider` (or obtained from `createMailProvider()`), the compiler reports `error TS2339: Property 'getSentMessages' does not exist on type 'MailProvider'.`

**Cause** — `getSentMessages()`, `getLastMessage()`, and `clear()` are assertion helpers that exist only on `MemoryMailProvider` — they are deliberately not part of the abstract contract, because an SMTP server has nothing to read back. `MailProvider` (and the return type of `createMailProvider()`) therefore does not declare them.

**Fix** — Keep the concrete type where you need the helpers, or narrow with `instanceof` before calling them:

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { MailProvider } from "blendsdk/webafx-mailer";

function assertNoMailSent(provider: MailProvider): void {
    if (provider instanceof MemoryMailProvider) {
        const sent = provider.getSentMessages();
        if (sent.length > 0) {
            throw new Error(`Expected no mail, but ${sent.length} message(s) were sent.`);
        }
    }
}

const mailer: MailProvider = new MemoryMailProvider();
assertNoMailSent(mailer);

await mailer.shutdown();
```

---

#### 12. `error TS1484: 'MailMessage' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled.`

**Symptom** — With `"verbatimModuleSyntax": true` in `tsconfig.json`, imports that mix values and types from the package fail: `error TS1484: 'MailMessage' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled.`

**Cause** — The package exports classes *and* interfaces from the same entry point. `MailMessage`, `MailResult`, `SmtpMailConfig`, etc. are `export type` declarations erased at runtime; under `verbatimModuleSyntax`, TypeScript demands they be imported with `import type` so the emitted JavaScript never imports a non-existent binding.

**Fix** — Split value imports and type imports into two statements:

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { MailMessage, MailResult, MemoryMailConfig } from "blendsdk/webafx-mailer";

const config: MemoryMailConfig = { serviceName: "test-mailer" };
const mailer = new MemoryMailProvider(config);

const message: MailMessage = {
    from: "sender@example.com",
    to: "recipient@example.com",
    subject: "Type-only imports",
    text: "This compiles under verbatimModuleSyntax.",
};

const result: MailResult = await mailer.send(message);
console.log(result.accepted);
await mailer.shutdown();
```

---

#### 13. `error TS18048: 'result.messageId' is possibly 'undefined'.`

**Symptom** — Code like `if (result.messageId.length > 0)` fails under `strict` mode with `error TS18048: 'result.messageId' is possibly 'undefined'.`

**Cause** — `MailResult.messageId` is typed `messageId?: string` because not every transport supplies one: `MemoryMailProvider` always generates one and `SmtpMailProvider` forwards nodemailer's, but the abstract contract cannot guarantee it. `strictNullChecks` (part of strict mode) correctly flags direct access.

**Fix** — Narrow or default the value before using it:

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();
const result = await mailer.send({
    from: "sender@example.com",
    to: "recipient@example.com",
    subject: "Message ID handling",
    text: "Hello.",
});

const messageId: string = result.messageId ?? "(no message id)";
console.log(`Sent with id: ${messageId}`);

await mailer.shutdown();
```

---

### Test Suite Errors (Vitest + Mailpit)

#### 14. `TypeError: fetch failed` (with `cause: Error: connect ECONNREFUSED ::1:8025`)

**Symptom** — The Vitest run fails inside the Mailpit helpers with `TypeError: fetch failed`; the error's `cause` is `connect ECONNREFUSED` against port `8025`. The SMTP-backed tests fail while the memory provider tests pass.

**Cause** — The Mailpit Docker container is not running, so the REST API on `http://localhost:8025` and the SMTP endpoint on `localhost:1025` are both unavailable. This happens when tests are run with `test:fast` (which skips the Docker lifecycle) before `docker:up`, in CI without the service container, or after a previous run executed `docker:down`.

**Fix** — Use the package's own orchestration or start the container manually before running Vitest:

```bash
# From the package directory — starts Mailpit (SMTP :1025, REST API :8025)
yarn docker:up

# Confirm the API answers before running the suite
curl -s http://localhost:8025/api/v1/messages

# Run the tests (yarn test wraps this with docker:down → docker:up → vitest → docker:down)
yarn test:fast
```

Memory-provider tests do not need Docker — to iterate quickly without the container, run only that file:

```bash
npx vitest run --reporter=verbose tests/memory-mail-provider.test.ts
```

---

#### 15. `Error: Timed out waiting for Mailpit message with subject "..."`

**Symptom** — A test fails with `Timed out waiting for Mailpit message with subject "Reset password"` even though the provider's `send()` resolved without error.

**Cause** — Mailpit indexes a message asynchronously *after* the SMTP conversation completes, so an immediate assertion races the indexer. Two other frequent causes produce the same symptom: the message was deleted mid-test by a concurrent `clearMailpit()` call, or `send()` actually failed on a *different* provider instance and the poll never sees the message. A static subject shared across tests can also mask the situation by matching a stale message from a previous test rather than the new one.

**Fix** — Poll with a deadline (the package's own test helper does exactly this), assert the `send()` result first so transport errors surface immediately, and give each test a unique subject:

```typescript
import { describe, it, expect } from "vitest";
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

interface MailpitMessageSummary {
    Subject: string;
}

async function waitForMessage(subject: string): Promise<MailpitMessageSummary> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const response = await fetch("http://localhost:8025/api/v1/messages");
        const data = (await response.json()) as { messages?: MailpitMessageSummary[] };
        const match = (data.messages ?? []).find((m) => m.Subject === subject);
        if (match) {
            return match;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for Mailpit message with subject "${subject}"`);
}

describe("password reset email", () => {
    it("delivers the reset email", async () => {
        const mailer = new SmtpMailProvider({ host: "localhost", port: 1025, secure: false });
        const subject = `Reset ${Date.now()}`;

        const result = await mailer.send({
            from: "noreply@test.com",
            to: "alice@test.com",
            subject,
            text: "Reset your password.",
        });

        // Assert the transport result first — a real send failure surfaces here,
        // not as a mysterious Mailpit timeout.
        expect(result.accepted).toContain("alice@test.com");

        const message = await waitForMessage(subject);
        expect(message.Subject).toBe(subject);

        await mailer.shutdown();
    });
});
```

---

## Debugging Strategies

### 1. Verify which backend is actually running

Before debugging *how* mail is sent, confirm *what* is sending it. The two backends fail in completely different ways, and the memory backend fails silently by design.

1. Log the concrete class name and `serviceName` once at startup.
2. Check the `messageId` of a sent message: a `<memory-...@test>` prefix proves the memory backend handled it.
3. Use `instanceof` to warn (or throw) when the backend does not match the environment.

```typescript
import { MemoryMailProvider, SmtpMailProvider, createMailProvider } from "blendsdk/webafx-mailer";
import type { MailProvider } from "blendsdk/webafx-mailer";

const mailer: MailProvider = createMailProvider({
    type: process.env.MAIL_BACKEND === "smtp" ? "smtp" : "memory",
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
});

if (mailer instanceof MemoryMailProvider) {
    console.warn("Using the in-memory backend — emails will NOT be delivered.");
}
if (mailer instanceof SmtpMailProvider) {
    console.log(`Using the SMTP backend for service "${mailer.serviceName}"`);
}

await mailer.shutdown();
```

---

### 2. Get the real error behind `health() === false`

`SmtpMailProvider.health()` catches `transporter.verify()` errors and maps them to `false` — by design, since health is a boolean probe. That means the *reason* is swallowed. Because `transporter` is `protected`, a small subclass recovers it.

1. Run `health()` to learn *whether* the backend works.
2. Run `diagnose()` to learn *why* it does not — it logs the exact nodemailer error (DNS failure, `ECONNREFUSED`, TLS error, `Invalid login`, ...).
3. Use the result as a routing decision: `verify()` performs EHLO **and** AUTH, so if `health()` is `true` but `send()` still fails, the problem is not connectivity or credentials — look at the sender address, relay permissions, or recipient rejections.

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

class DiagnosableMailProvider extends SmtpMailProvider {
    /** Like health(), but logs the underlying verify() error instead of swallowing it. */
    async diagnose(): Promise<void> {
        try {
            await this.transporter.verify();
            console.log("SMTP verify succeeded — server reachable, credentials accepted.");
        } catch (error) {
            console.error("SMTP verify failed:", error instanceof Error ? error.message : String(error));
        }
    }
}

const mailer = new DiagnosableMailProvider({ host: "localhost", port: 1025, secure: false });

console.log(await mailer.health()); // true | false — no details
await mailer.diagnose();            // prints the actual reason when health() is false

await mailer.shutdown();
```

---

### 3. Reproduce SMTP problems against Mailpit locally

Isolate "our code" from "the real SMTP server" by pointing the provider at the local Mailpit container. If it works against Mailpit but not production, the bug is environmental: TLS, auth, sender policy, or egress.

1. Start the container: `yarn docker:up` (SMTP on `1025`, REST API on `8025`).
2. Point a provider at `localhost:1025` with `secure: false` and send a message with a unique subject.
3. Inspect the result via the REST API — or open `http://localhost:8025` in a browser for the web UI.

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({ host: "localhost", port: 1025, secure: false });

const result = await mailer.send({
    from: "debug@test.com",
    to: "you@test.com",
    subject: `Debug run ${new Date().toISOString()}`,
    text: "If this appears in Mailpit, the provider side is healthy.",
});

console.log(`accepted: ${result.accepted.join(", ")}`);

const response = await fetch("http://localhost:8025/api/v1/messages");
const data = (await response.json()) as { messages?: Array<{ Subject: string }> };
const messages = data.messages ?? [];
console.log(`Mailpit holds ${messages.length} message(s); newest: ${messages[0]?.Subject ?? "(none)"}`);

await mailer.shutdown();
```

---

### 4. Trace the raw SMTP conversation

When the failure is intermittent or server-specific, turn on nodemailer's protocol logging. The provider exposes its transport via the protected `transporter` field, so a subclass can replace it with a debug-enabled transport.

1. Subclass `SmtpMailProvider` and re-create the transport with `logger: true` and `debug: true`.
2. Send one message; the full SMTP dialogue is printed to the console.
3. Look for: the greeting banner, `EHLO` extensions (`STARTTLS`, `AUTH`), the `AUTH` exchange result, `MAIL FROM` / `RCPT TO` responses, and the terminating `QUIT`.

```typescript
import nodemailer from "nodemailer";
import { SmtpMailProvider } from "blendsdk/webafx-mailer";
import type { SmtpMailConfig } from "blendsdk/webafx-mailer";

class DebugSmtpMailProvider extends SmtpMailProvider {
    constructor(config: SmtpMailConfig) {
        super(config);
        // Replace the transport with one that logs every SMTP command/response
        this.transporter = nodemailer.createTransport({
            host: config.host,
            port: config.port,
            secure: config.secure ?? false,
            auth: config.auth,
            logger: true,
            debug: true,
        });
    }
}

const mailer = new DebugSmtpMailProvider({ host: "localhost", port: 1025, secure: false });

await mailer.send({
    from: "debug@test.com",
    to: "recipient@test.com",
    subject: "Trace run",
    text: "Watch the console for the SMTP conversation.",
});

await mailer.shutdown();
```

---

### 5. Isolate application logic with the memory backend

If you are unsure whether the bug is in your application or in the transport layer, swap in `MemoryMailProvider`. If the flow produces the expected message there, the application is fine and the problem is on the SMTP side — and vice versa.

1. Run the exact application flow (password reset, order confirmation, ...) against a `MemoryMailProvider`.
2. Assert what was produced with `getLastMessage()` / `getSentMessages()`.
3. If the memory run is correct, reproduce the same flow against Mailpit (strategy 3) before touching the real server.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

async function resetPassword(mailer: MemoryMailProvider, email: string): Promise<void> {
    await mailer.send({
        from: "noreply@example.com",
        to: email,
        subject: "Reset your password",
        text: "Follow the link to reset your password.",
        html: "<p>Follow the link to reset your password.</p>",
    });
}

const mailer = new MemoryMailProvider();
await resetPassword(mailer, "alice@example.com");

const last = mailer.getLastMessage();
if (last === undefined) {
    throw new Error("No email was captured — the flow under test never called send().");
}
if (last.message.to !== "alice@example.com") {
    throw new Error(`Wrong recipient: ${String(last.message.to)}`);
}
console.log("Application flow produces the expected email.");

await mailer.shutdown();
```

---

### 6. Read `MailResult` — a resolved promise is not proof of delivery

`send()` resolving only means the SMTP server finished the conversation, not that every recipient accepted the message. Log the result fields — they are your per-recipient ground truth.

1. Log `accepted`, `rejected`, and `messageId` for every send during debugging.
2. Treat `rejected.length > 0` (or `accepted.length === 0`) as a delivery failure and escalate.
3. Cross-check against the SMTP server log — `rejected` usually comes with a 5xx reply code visible only there.

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

async function sendAndReport(
    mailer: SmtpMailProvider,
    to: string[],
    subject: string,
    body: string
): Promise<void> {
    const result = await mailer.send({
        from: "notifications@example.com",
        to,
        subject,
        text: body,
    });

    console.log(`"${subject}" → accepted:  [${result.accepted.join(", ")}]`);
    console.log(`"${subject}" → rejected:  [${result.rejected.join(", ")}]`);
    console.log(`"${subject}" → messageId: ${result.messageId ?? "(none)"}`);

    if (result.rejected.length > 0 || result.accepted.length === 0) {
        throw new Error(`Delivery problem for "${subject}" — check the SMTP server logs.`);
    }
}

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "notifications@example.com", pass: "smtp-secret" },
});

await sendAndReport(mailer, ["alice@example.com", "bob@example.com"], "Nightly report", "All good.");
await mailer.shutdown();
```

---

## Known Pitfalls

### 1. `send()` resolving does not mean every recipient accepted

`SmtpMailProvider.send()` performs a single SMTP transaction for all recipients. The server can accept some recipients and reject others; the promise still resolves, with the rejected addresses reported in `MailResult.rejected`. Code that only wraps `send()` in `try`/`catch` will silently lose those messages. Always inspect `rejected` in production code paths that matter.

### 2. `MemoryMailProvider` accepts every recipient — including BCC

The memory backend flattens `to`, `cc`, and `bcc` into `accepted` and reports `rejected: []`, unconditionally. It cannot validate addresses, domains, or suppression rules — even nonsense addresses are "accepted". Use it to assert *what your application composed*, never to verify *what the SMTP server would do*:

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();
const result = await mailer.send({
    from: "sender@example.com",
    to: "definitely-not-a-real-address@example.invalid",
    bcc: "hidden@example.com",
    subject: "Memory never rejects",
    text: "The memory backend reports every recipient as accepted.",
});

console.log(result.accepted);
// ["definitely-not-a-real-address@example.invalid", "hidden@example.com"]
console.log(result.rejected); // [] — even for nonsense addresses

await mailer.shutdown();
```

### 3. Base64 attachment strings are not decoded by the SMTP backend

`SmtpMailProvider` forwards each attachment to nodemailer as `{ filename, content, contentType }` without an `encoding` flag. Nodemailer only decodes base64 string content when `encoding: "base64"` is set — without it, the base64 *text itself* is attached, and recipients get a corrupt file. If your attachment source is a base64 string, decode it to a `Buffer` before sending:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

// A 1x1 transparent PNG, base64-encoded
const logoBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "design@example.com", pass: "smtp-secret" },
});

await mailer.send({
    from: "design@example.com",
    to: "recipient@example.com",
    subject: "Logo attached",
    text: "The logo is attached.",
    attachments: [
        {
            filename: "logo.png",
            // Decode to a Buffer first — a raw base64 string would be attached as literal text
            content: Buffer.from(logoBase64, "base64"),
            contentType: "image/png",
        },
    ],
});

await mailer.shutdown();
```

There is also no stream- or path-based attachment support in the type: preload files into a `Buffer` (for example with `readFile` from `node:fs/promises`) before calling `send()`.

### 4. `shutdown()` is terminal and destructive

For `SmtpMailProvider`, `shutdown()` calls `transporter.close()` — subsequent `send()` calls fail. For `MemoryMailProvider`, `shutdown()` calls `clear()` — every captured message is gone. This bites in two places: tests that shut the provider down *before* asserting (`getSentMessages()` suddenly returns `[]`), and applications that reuse a provider instance across lifecycles. With the WebAFX plugin, both the `dispose` callback and the `shutdown` hook call `shutdown()`, so container disposal destroys the provider. Read captured messages *before* teardown, and create a fresh provider per test:

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();
await mailer.send({
    from: "a@example.com",
    to: "b@example.com",
    subject: "Before shutdown",
    text: "Captured.",
});

// Assert first…
const captured = mailer.getSentMessages();
console.log(captured.length); // 1

// …then release resources (the plugin's dispose hook does this for you)
await mailer.shutdown();
console.log(mailer.getSentMessages().length); // 0 — the store was cleared
```

### 5. Plugin factories capture configuration immediately (and reuse the service name)

`memoryMailPlugin(config?)` and `smtpMailPlugin(config)` create the provider at the moment you call them — the `PluginDefinition` closes over that instance. If you call `smtpMailPlugin()` at module top level before `dotenv`/secrets loading has run, the provider is built from empty values and never picks them up. Build the plugin after configuration is loaded. Also note that every plugin defaults its registration name to `serviceName = "mailer"` — two mailers without distinct names collide in the service container:

```typescript
import { memoryMailPlugin } from "blendsdk/webafx-mailer";
import type { PluginDefinition } from "blendsdk/webafx";

// Two mailers, two distinct registration names
const transactional: PluginDefinition = memoryMailPlugin({ serviceName: "transactional-mailer" });
const marketing: PluginDefinition = memoryMailPlugin({ serviceName: "marketing-mailer" });

console.log(transactional.name); // "transactional-mailer"
console.log(marketing.name);     // "marketing-mailer"
```

### 6. Memory `messageId`s are test artifacts, not stable identifiers

`MemoryMailProvider` generates IDs as `` `<memory-{timestamp}-{index}@test>` `` where `index` is the current store size. Two consequences: after `clear()` the counter restarts at `0`, so two sends within the same millisecond can produce *identical* IDs; and the format is not an RFC-style Message-ID you should parse or persist. Assert with a pattern instead of an exact value:

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

const first = await mailer.send({
    from: "a@example.com",
    to: "b@example.com",
    subject: "One",
    text: "First",
});
mailer.clear();
const second = await mailer.send({
    from: "a@example.com",
    to: "b@example.com",
    subject: "Two",
    text: "Second",
});

console.log(first.messageId);  // e.g. "<memory-1729512345678-0@test>"
console.log(second.messageId); // e.g. "<memory-1729512345678-0@test>" — counter restarted

if (second.messageId !== undefined) {
    console.log(/^<memory-\d+-\d+@test>$/.test(second.messageId)); // true
}

await mailer.shutdown();
```

### 7. `getSentMessages()` is a shallow copy — entries share references

`getSentMessages()` returns `[...this.messages]`: mutating the returned *array* (truncating it, sorting it) does not affect the store, but the entry objects — and, crucially, the `MailMessage` objects inside them — are the same references `send()` stored. `send()` does not clone the message, so mutating the original object *after* sending changes what the test observes. Assert immediately, or deep-clone if you need a frozen snapshot:

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();
const message = {
    from: "a@example.com",
    to: "b@example.com",
    subject: "Original",
    text: "Hello",
};

await mailer.send(message);

// The returned array is a copy…
const copy = mailer.getSentMessages();
copy.length = 0;
console.log(mailer.getSentMessages().length); // 1 — the store is intact

// …but the entries are shared references: mutating the source mutates the capture
message.subject = "Mutated afterwards";
console.log(mailer.getSentMessages()[0].message.subject); // "Mutated afterwards"
console.log(mailer.getLastMessage()?.message.subject);    // "Mutated afterwards"

await mailer.shutdown();
```

### 8. `health() === false` is not a guard (and it hides the reason)

`SmtpMailProvider.health()` maps any `verify()` failure to `false` and never throws — which is exactly what the WebAFX health endpoint needs, but it means the cause is invisible, and nothing in the package *blocks* `send()` after a failed health check. A `false` result does not prevent `send()` from being attempted (and throwing the real error). Use `health()` as a boolean signal, and use the `DiagnosableMailProvider` pattern from [Debugging Strategies](#debugging-strategies) when you need the underlying error. If you write a custom `MailProvider`, follow the same convention: resolve `false` on failure rather than throwing, because the plugin wires the result straight into the `/health` endpoint.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
