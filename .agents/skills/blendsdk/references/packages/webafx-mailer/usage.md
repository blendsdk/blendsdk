> **Package**: `blendsdk/webafx-mailer`

# webafx-mailer Core Concepts

This document is a deep dive into the core abstractions of `blendsdk/webafx-mailer`: the abstract provider contract, the message model, both concrete backends, the WebAFX plugin layer, and the configuration model that ties them together. Each section follows the same structure: **What It Is**, **How It Works**, a **Complete Example**, and a **Key Methods and Properties** table. For the big picture, see the Overview.

---

## MailProvider — The Abstract Contract

### What It Is

`MailProvider` is the abstract base class at the center of the package. Every backend — the shipped `SmtpMailProvider` and `MemoryMailProvider`, as well as any custom implementation you write — extends it and thereby guarantees the same three-method contract: `send()`, `health()`, and `shutdown()`. Application code depends only on the `MailProvider` type, never on a concrete backend, so the delivery mechanism can be swapped at composition time without touching call sites. The class also standardizes service identity: every provider carries a `serviceName` that defaults to `"mailer"`.

### How It Works

- **Constructor** — accepts a `MailProviderConfig` and stores `config.serviceName ?? DEFAULT_SERVICE_NAME` (where `DEFAULT_SERVICE_NAME` is `"mailer"`) in the protected `_serviceName` field. The getter `serviceName` exposes this value.
- **Three abstract members** — subclasses must implement `send(message)` (deliver and return a `MailResult`), `health()` (return a boolean operational state; failures are reported as `false`, not thrown), and `shutdown()` (release resources gracefully).
- **No delivery logic in the base class** — each subclass owns its mechanism (nodemailer transport, in-memory array), which keeps the contract narrow and the backends interchangeable.
- **`serviceName` is the registration key** — when a provider is wired into WebAFX (see the WebAFX Plugin Integration section), it is registered as a singleton service under this name. Override it for multi-mailer scenarios (e.g. `"transactional-mailer"`, `"marketing-mailer"`).
- **Custom backends are first-class citizens** — because `MailProvider` is exported, you can subclass it to plug any delivery mechanism (a console logger, a file writer, an HTTP API) into the same plugin and health/shutdown infrastructure. The architecture deliberately mirrors `CacheProvider` from `blendsdk/webafx-cache`.

### Complete Example

A minimal custom backend that "delivers" email by writing to the console:

```typescript
import {
    MailProvider,
    type MailMessage,
    type MailProviderConfig,
    type MailResult,
} from "blendsdk/webafx-mailer";

/**
 * Minimal custom backend that "delivers" email by writing to the console.
 * Any MailProvider subclass can also be plugged into createMailPlugin().
 */
class ConsoleMailProvider extends MailProvider {
    constructor(config: MailProviderConfig = {}) {
        super(config);
    }

    async send(message: MailMessage): Promise<MailResult> {
        const recipients = Array.isArray(message.to) ? message.to : [message.to];
        console.log(`[console-mail] "${message.subject}" -> ${recipients.join(", ")}`);

        return {
            accepted: recipients,
            rejected: [],
            messageId: `<console-${Date.now()}@local>`,
        };
    }

    async health(): Promise<boolean> {
        return true;
    }

    async shutdown(): Promise<void> {
        console.log("[console-mail] transport closed");
    }
}

const mailer: MailProvider = new ConsoleMailProvider({ serviceName: "audit-mailer" });

console.log(mailer.serviceName); // "audit-mailer"

const result = await mailer.send({
    from: "noreply@example.com",
    to: ["ops@example.com", "oncall@example.com"],
    subject: "Deployment finished",
    text: "Deployment #42 completed successfully.",
});

console.log(result.accepted);       // ["ops@example.com", "oncall@example.com"]
console.log(result.rejected);       // []
console.log(await mailer.health()); // true

await mailer.shutdown();
```

### Key Methods and Properties

| Member | Type / Signature | Description |
| --- | --- | --- |
| `constructor` | `(config: MailProviderConfig) => MailProvider` | Resolves `serviceName` from the config; defaults to `"mailer"`. |
| `_serviceName` | `protected string` | Backing field holding the resolved service name. |
| `serviceName` | `get serviceName(): string` | Service-container registration name used when the provider is registered in WebAFX. |
| `send` | `abstract send(message: MailMessage): Promise<MailResult>` | Delivers the message. Throws on failure (SMTP); the memory backend never fails. |
| `health` | `abstract health(): Promise<boolean>` | Backend operational check — `true` when the backend can be used. |
| `shutdown` | `abstract shutdown(): Promise<void>` | Graceful resource release (close transport / clear store). |

---

## The Message Model — MailMessage, MailResult, and MailAttachment

### What It Is

`MailMessage`, `MailAttachment`, and `MailResult` are the plain-data interfaces that describe what is being sent and what happened. They are backend-independent: `from`/`to`/`subject` and friends mean the same thing to the SMTP backend and to the in-memory backend, so switching providers never changes application code. `MailMessage` describes an outgoing email, `MailAttachment` a file attached to it, and `MailResult` the outcome reported by `send()`.

### How It Works

- **Addresses are flexible** — `to` is required and accepts a single address (`"a@b.com"`) or an array (`["a@b.com", "c@d.com"]`); `cc` and `bcc` follow the same shape and are optional. `from` also accepts a display-name form such as `"Name <email@example.com>"`.
- **Bodies** — `text` and `html` are both optional; provide at least one. When both are present, the HTML body is the rich content and the text body acts as a fallback for clients that do not render HTML.
- **Attachments** — each `MailAttachment` needs a `filename` and `content`; `content` is either a raw `Buffer` (binary data) or a base64-encoded `string`, with an optional `contentType` MIME hint.
- **Results are uniform** — every `send()` resolves to a `MailResult` with `accepted: string[]`, `rejected: string[]`, and an optional `messageId`. The SMTP backend maps nodemailer's response; the memory backend flattens `to` + `cc` + `bcc` into `accepted`, and always reports `rejected: []`.
- **Backend nuances** — the SMTP provider joins array recipients with `", "` for the wire but reports individual addresses in `result.accepted`; the memory provider stores the original message object by reference so identity assertions (`toBe`) work in tests.

### Complete Example

```typescript
import {
    MemoryMailProvider,
    type MailMessage,
    type MailResult,
} from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

const message: MailMessage = {
    from: "noreply@example.com",
    to: ["alice@example.com", "bob@example.com"],
    cc: "team-lead@example.com",
    bcc: "compliance@example.com",
    subject: "Monthly report",
    text: "The monthly report is attached.",
    html: "<p>The monthly report is <strong>attached</strong>.</p>",
    attachments: [
        {
            filename: "report.txt",
            content: Buffer.from("Revenue: 42"),
            contentType: "text/plain",
        },
    ],
};

const result: MailResult = await mailer.send(message);

console.log("Accepted:", result.accepted);
// ["alice@example.com", "bob@example.com", "team-lead@example.com", "compliance@example.com"]
console.log("Rejected:", result.rejected);    // []
console.log("Message ID:", result.messageId); // "<memory-...@test>"

await mailer.shutdown();
```

### Key Methods and Properties

**MailMessage**

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `from` | `string` | Yes | Sender address; may include a display name (`"Name <email@example.com>"`). |
| `to` | `string \| string[]` | Yes | Primary recipient(s) — a single address or an array of addresses. |
| `cc` | `string \| string[]` | No | Carbon copy recipient(s). |
| `bcc` | `string \| string[]` | No | Blind carbon copy recipient(s). |
| `subject` | `string` | Yes | Subject line. |
| `text` | `string` | No | Plain-text body — used as fallback when `html` is also provided. |
| `html` | `string` | No | Rich HTML body. |
| `attachments` | `MailAttachment[]` | No | File attachments. |

**MailAttachment**

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `filename` | `string` | Yes | Name shown to the recipient (e.g. `"report.pdf"`). |
| `content` | `Buffer \| string` | Yes | Raw `Buffer` for binary data or a base64-encoded string. |
| `contentType` | `string` | No | MIME type (e.g. `"application/pdf"`, `"text/plain"`). |

**MailResult**

| Property | Type | Description |
| --- | --- | --- |
| `accepted` | `string[]` | Addresses that accepted the message. |
| `rejected` | `string[]` | Addresses the server rejected — typically empty in normal operation. |
| `messageId` | `string \| undefined` | Server-assigned identifier; the memory backend generates a synthetic `<memory-…@test>` value. |

---

## SmtpMailProvider — Real Delivery via Nodemailer

### What It Is

`SmtpMailProvider` is the concrete backend that delivers real email through nodemailer. It is a drop-in `MailProvider`: anywhere the abstract type is expected — including `createMailPlugin()` — an `SmtpMailProvider` can be used. It is the only shipped backend that touches the network.

### How It Works

- **One transport per provider** — the constructor builds a nodemailer transport once from `SmtpMailConfig` (`host`, `port`, `secure`, `auth`, `tls`). The transport manages its own TCP connection pooling.
- **Safer defaults than typical v3-era code** — `secure` defaults to `false`, matching the modern convention of STARTTLS on port 587; set `secure: true` for implicit TLS (typically port 465). Notably, there is no hardcoded `tls.rejectUnauthorized: false` — certificate validation stays controllable through the `tls` option.
- **`send()` translates and forwards** — array recipients (`to`, `cc`, `bcc`) are joined with `", "` for the wire, attachments are mapped to nodemailer's `{ filename, content, contentType }` shape, and the awaited `sendMail()` response is mapped into a `MailResult` (`accepted`/`rejected` stringified, `messageId` passed through). Connection failures, authentication errors, and send rejections propagate as thrown errors, so callers should wrap sends in `try/catch`.
- **`health()` never throws** — it runs `transporter.verify()` (an EHLO/HELO handshake with the server, no email sent) inside a `try/catch` and returns `true` or `false`.
- **`shutdown()` closes the pool** — `transporter.close()` releases the underlying connections; any subsequent `send()` call fails.

### Complete Example

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false, // STARTTLS — use true for implicit TLS on port 465
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
        html: "<p>Thanks for your purchase.</p>",
    });

    console.log("Accepted:", result.accepted);
    console.log("Message ID:", result.messageId);
} catch (error) {
    const reason = error instanceof Error ? error.message : "SMTP send failed";
    console.error("Failed to send email:", reason);
} finally {
    await mailer.shutdown();
}
```

### Key Methods and Properties

**Configuration (`SmtpMailConfig`)**

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `host` | `string` | — (required) | SMTP server hostname (e.g. `"smtp.example.com"`). |
| `port` | `number` | — (required) | Common ports: 25, 587 (STARTTLS), 465 (implicit TLS). |
| `secure` | `boolean` | `false` | `true` selects a direct TLS connection (typically port 465). |
| `auth` | `{ user: string; pass: string }` | `undefined` | Credentials — omit for unauthenticated servers. |
| `tls` | `{ rejectUnauthorized?: boolean; [key: string]: unknown }` | `undefined` | Extra TLS options; certificate validation is configurable here. |
| `serviceName` | `string` | `"mailer"` | Service identity for WebAFX registration. |

**Provider Members**

| Member | Signature | Description |
| --- | --- | --- |
| `constructor` | `(config: SmtpMailConfig) => SmtpMailProvider` | Creates the nodemailer transport from the SMTP settings. |
| `transporter` | `protected nodemailer.Transporter` | Underlying nodemailer transport; handles connection pooling. |
| `send` | `(message: MailMessage) => Promise<MailResult>` | Converts and sends the message; throws on failure. |
| `health` | `() => Promise<boolean>` | Runs `transporter.verify()`; returns `false` on any failure. |
| `shutdown` | `() => Promise<void>` | Closes the transport and connection pool. |
| `serviceName` | `get serviceName(): string` | Inherited from `MailProvider`. |

---

## MemoryMailProvider — In-Memory Capture for Tests

### What It Is

`MemoryMailProvider` is the test-oriented backend: instead of delivering anything, it stores every "sent" message in an in-memory array of `SentMailEntry` records (`{ message, result }`) and exposes assertion helpers for querying them. It is the fastest way to test email flows — no server, no network, no Docker — and it pairs naturally with the WebAFX plugin layer for integration tests. For a full testing walkthrough, see Basic Usage.

### How It Works

- **`send()` normalizes and stores** — `to`, `cc`, and `bcc` are each flattened into arrays; the combined recipient list becomes `result.accepted`, `result.rejected` is always `[]`, and `messageId` follows the deterministic pattern `<memory-${Date.now()}-${index}@test>` (the index is the current store length, so consecutive sends get unique IDs even within the same millisecond). The entry is pushed as `{ message, result }` and the result returned. The method cannot fail under normal conditions.
- **`getSentMessages()` returns a shallow copy** — mutating the returned array does not affect the internal store; the `message` and `result` references inside the entries are shared, so identity assertions like `expect(stored.message).toBe(originalMessage)` hold.
- **`getLastMessage()`** — convenience accessor for the most recent entry, or `undefined` when nothing was sent.
- **`clear()`** — empties the store; useful between test cases.
- **`health()` is always `true`** — there are no external dependencies to check.
- **`shutdown()` simply clears the store** — aligning resource teardown with the shared `MailProvider` lifecycle. Because `shutdown()` clears the store, call it in `afterEach` for clean test isolation.
- **WebAFX note** — when tests need assertions, create the `MemoryMailProvider` yourself and pass it to `createMailPlugin()` (as in the plugin section below); the `memoryMailPlugin()` one-liner keeps the provider instance internal.

### Complete Example

A Vitest test that asserts on a captured welcome email:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

describe("registration flow", () => {
    let mailer: MemoryMailProvider;

    beforeEach(() => {
        mailer = new MemoryMailProvider({ serviceName: "test-mailer" });
    });

    afterEach(async () => {
        await mailer.shutdown();
    });

    it("stores the welcome email with all recipients accepted", async () => {
        const result = await mailer.send({
            from: "noreply@example.com",
            to: "new-user@example.com",
            cc: "team@example.com",
            subject: "Welcome!",
            text: "Welcome aboard!",
        });

        expect(result.accepted).toEqual([
            "new-user@example.com",
            "team@example.com",
        ]);
        expect(result.rejected).toEqual([]);
        expect(result.messageId).toMatch(/^<memory-\d+-\d+@test>$/);

        const last = mailer.getLastMessage();
        expect(last?.message.subject).toBe("Welcome!");
        expect(mailer.getSentMessages()).toHaveLength(1);
    });
});
```

### Key Methods and Properties

| Member | Signature | Description |
| --- | --- | --- |
| `constructor` | `(config?: MemoryMailConfig) => MemoryMailProvider` | Config is optional; defaults to `{}` (serviceName `"mailer"`). |
| `messages` | `protected SentMailEntry[]` | Internal store of all captured messages and their results. |
| `send` | `(message: MailMessage) => Promise<MailResult>` | Stores the message; all `to` + `cc` + `bcc` recipients are accepted; generates a `<memory-…@test>` ID. |
| `getSentMessages` | `() => SentMailEntry[]` | Returns a shallow copy of the store (mutation-safe). |
| `getLastMessage` | `() => SentMailEntry \| undefined` | The most recently sent entry, or `undefined`. |
| `clear` | `() => void` | Empties the store. |
| `health` | `() => Promise<boolean>` | Always returns `true`. |
| `shutdown` | `() => Promise<void>` | Clears the store (delegates to `clear()`). |

**SentMailEntry**

| Property | Type | Description |
| --- | --- | --- |
| `message` | `MailMessage` | The original message as submitted to `send()`. |
| `result` | `MailResult` | The result that `send()` returned for this message. |

---

## WebAFX Plugin Integration — createMailPlugin and Plugin Factories

### What It Is

The plugin layer adapts any `MailProvider` into a WebAFX `PluginDefinition`. `createMailPlugin()` is the core adapter; `smtpMailPlugin()` and `memoryMailPlugin()` are one-liner convenience factories for the two shipped backends. This is the only part of the package that imports `blendsdk/webafx` — which is why WebAFX is an optional peer dependency, and why the providers remain fully usable standalone. The design mirrors `blendsdk/webafx-cache`'s plugin layer exactly.

### How It Works

1. **Factory creation** — `createMailPlugin(provider, options?)` synchronously returns a `PluginDefinition` object: `name` is `provider.serviceName`, `priority` is `options?.priority ?? 30` (installs after most core plugins; `0` is a valid override), and `factory` holds the wiring logic.
2. **Singleton service registration** — when WebAFX runs the plugin factory, it calls `app.registerService({ name: provider.serviceName, type: "singleton", factory: () => provider, dispose: async () => { await provider.shutdown(); } })`. The provider is pre-created, so the factory returns the same instance for every resolution of that service name.
3. **Health hook** — the factory returns `{ health: () => provider.health() }`, bridging the provider into the application's health check (e.g. the `/health` endpoint).
4. **Shutdown hook** — the factory returns `{ shutdown: () => provider.shutdown() }`, bridging the provider into graceful application shutdown. Initialization is also logged with the provider's class name via the plugin context logger.
5. **One-liners** — `smtpMailPlugin(config)` and `memoryMailPlugin(config?)` construct the provider internally (`new SmtpMailProvider(config)` / `new MemoryMailProvider(config)`) and delegate to `createMailPlugin()`. The provider is owned by the plugin; for tests that assert via `getSentMessages()`, prefer creating the `MemoryMailProvider` yourself and wrapping it.
6. **Multiple mailers** — because the plugin name equals the service name, several providers can coexist under distinct names (e.g. `"transactional-mailer"`, `"dev-mailer"`).

### Complete Example

```typescript
import {
    createMailPlugin,
    MemoryMailProvider,
    memoryMailPlugin,
    smtpMailPlugin,
} from "blendsdk/webafx-mailer";

// 1. Wrap a provider you own — the instance stays available for direct assertions.
const mailer = new MemoryMailProvider({ serviceName: "mailer" });
const mailerPlugin = createMailPlugin(mailer);

console.log(mailerPlugin.name);     // "mailer" — from provider.serviceName
console.log(mailerPlugin.priority); // 30 — default priority

// WebAFX invokes mailerPlugin.factory during application bootstrap; it registers
// the provider as a singleton service and wires the health/shutdown hooks.

// 2. One-liner plugins — the provider is created internally and owned by the
//    plugin (disposed via the plugin's shutdown hook in a running application).
const devPlugin = memoryMailPlugin({ serviceName: "dev-mailer" });
console.log(devPlugin.name); // "dev-mailer"

const productionPlugin = smtpMailPlugin({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    serviceName: "transactional-mailer",
});
console.log(productionPlugin.name); // "transactional-mailer"

// 3. Custom priority for ordering relative to other plugins.
const earlyPlugin = createMailPlugin(mailer, { priority: 5 });
console.log(earlyPlugin.priority); // 5

await mailer.shutdown();
```

In a real WebAFX application, the plugin is registered with `app.use()` and the provider is later resolved from the service container — shown here as an illustrative fragment:

```typescript fragment
// WebAFX application bootstrap
app.use(smtpMailPlugin({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "user@example.com", pass: "secret" },
}));

// Anywhere in the application — resolve the registered singleton:
const mailer = services.get<MailProvider>("mailer");

const result = await mailer.send({
    from: "noreply@example.com",
    to: "customer@example.com",
    subject: "Your receipt",
    text: "Thanks for your purchase.",
});
```

### Key Methods and Properties

**Plugin Factory Functions**

| Function | Signature | Description |
| --- | --- | --- |
| `createMailPlugin` | `(provider: MailProvider, options?: { priority?: number }) => PluginDefinition` | Adapts any provider (SMTP, memory, or custom) into a WebAFX plugin. |
| `smtpMailPlugin` | `(config: SmtpMailConfig) => PluginDefinition` | Creates a `SmtpMailProvider` internally and wraps it. |
| `memoryMailPlugin` | `(config?: MemoryMailConfig) => PluginDefinition` | Creates a `MemoryMailProvider` internally and wraps it. |

**Resulting PluginDefinition**

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Equal to `provider.serviceName` (default `"mailer"`). |
| `priority` | `number` | `options?.priority ?? 30`; lower values install earlier. |
| `factory` | async `(context: { app, logger }) => { health, shutdown }` | Registers the provider as a singleton service (`dispose` → `provider.shutdown()`), logs initialization, and returns the health/shutdown hooks. |

---

## Configuration and Backend Switching — createMailProvider

### What It Is

The configuration model is the type family that feeds every constructor: `MailProviderConfig` (base, carrying `serviceName`), `SmtpMailConfig` and `MemoryMailConfig` (backend-specific extensions), and `MailFactoryConfig` — a type-discriminated config consumed by the `createMailProvider()` factory for environment-based backend switching. The `DEFAULT_SERVICE_NAME` constant (`"mailer"`) anchors the default service identity across all of them.

### How It Works

- **Base first** — every provider constructor accepts a config extending `MailProviderConfig`; the base class resolves `serviceName` against `DEFAULT_SERVICE_NAME`, so configuration flows bottom-up into a single resolution point.
- **`SmtpMailConfig`** adds the required `host`/`port` plus optional `secure`, `auth`, and `tls` (details in the SmtpMailProvider section above). **`MemoryMailConfig`** adds nothing — only `serviceName` is meaningful.
- **`MailFactoryConfig`** adds a required `type: "smtp" | "memory"` discriminator; `serviceName` stays optional, and the SMTP fields (`host`, `port`, `secure`, `auth`, `tls`) are optional because they are only read when `type === "smtp"`. Supply `host` and `port` for SMTP configurations; they are forwarded to the transport as-is.
- **`createMailProvider(config)` maps by `type`** — `"smtp"` builds a `SmtpMailProvider` from the SMTP fields (passing `serviceName` through), `"memory"` builds a `MemoryMailProvider` with just the service name. Pair the result with `createMailPlugin()` for WebAFX, or use it standalone.
- **Unknown types fail fast** — the `default` branch throws `Error: Unknown mail type: "<value>". Supported types: "smtp", "memory".`, an explicit runtime guard for untyped or environment-provided configuration that TypeScript could not check.
- **Multiple mailers via `serviceName`** — distinct service names (e.g. `"transactional-mailer"` vs. `"dev-mailer"`) let several providers coexist in one application.

### Complete Example

Environment-based backend switching with an explicit service name:

```typescript
import {
    createMailProvider,
    DEFAULT_SERVICE_NAME,
    type MailFactoryConfig,
    type MailProvider,
} from "blendsdk/webafx-mailer";

const isProduction = process.env.NODE_ENV === "production";

const factoryConfig: MailFactoryConfig = {
    type: isProduction ? "smtp" : "memory",
    serviceName: isProduction ? "transactional-mailer" : "dev-mailer",
    host: process.env.SMTP_HOST ?? "localhost",
    port: Number(process.env.SMTP_PORT ?? "587"),
    secure: false,
    auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" }
        : undefined,
};

const mailer: MailProvider = createMailProvider(factoryConfig);

console.log(DEFAULT_SERVICE_NAME);  // "mailer"
console.log(mailer.serviceName);    // "dev-mailer" when NODE_ENV !== "production"
console.log(await mailer.health()); // true for the memory backend

// Simulate an untyped/environment-provided value: unknown backends fail fast.
try {
    createMailProvider({ type: "sendgrid" as "smtp" });
} catch (error) {
    console.log(error instanceof Error ? error.message : "unexpected failure");
    // Unknown mail type: "sendgrid". Supported types: "smtp", "memory".
}

await mailer.shutdown();
```

### Key Methods and Properties

**Config Type Hierarchy**

| Type | Extends | Additional Fields | Purpose |
| --- | --- | --- | --- |
| `MailProviderConfig` | — | `serviceName?` | Base config accepted by every provider. |
| `SmtpMailConfig` | `MailProviderConfig` | `host`, `port`, `secure?`, `auth?`, `tls?` | Full SMTP connection settings. |
| `MemoryMailConfig` | `MailProviderConfig` | — | In-memory backend; only `serviceName` is meaningful. |
| `MailFactoryConfig` | — | `type`, `serviceName?`, `host?`, `port?`, `secure?`, `auth?`, `tls?` | Type-discriminated config for `createMailProvider()`. |

**`MailFactoryConfig` Fields**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"smtp" \| "memory"` | Yes | Backend selector. |
| `serviceName` | `string` | No | Passed through to the provider; defaults to `"mailer"`. |
| `host` | `string` | Only for `"smtp"` | SMTP server hostname. |
| `port` | `number` | Only for `"smtp"` | SMTP server port. |
| `secure` | `boolean` | No | Direct TLS connection (default `false`). |
| `auth` | `{ user: string; pass: string }` | No | SMTP credentials. |
| `tls` | `{ rejectUnauthorized?: boolean; [key: string]: unknown }` | No | Extra TLS options. |

**Function and Constant**

| Name | Signature / Value | Description |
| --- | --- | --- |
| `createMailProvider` | `(config: MailFactoryConfig) => MailProvider` | Returns a `SmtpMailProvider` or `MemoryMailProvider`; throws for unknown `type` values. |
| `DEFAULT_SERVICE_NAME` | `string` — value `"mailer"` | Default service name applied by every provider constructor. |

---

## Next Steps

- Basic Usage — task-oriented walkthroughs for sending email, switching backends, and integrating with WebAFX.
- Overview — package scope, architecture diagram, and dependency notes.

---

# webafx-mailer Basic Usage

This document is a step-by-step getting started guide — from installing the package to sending your first email, inspecting sent mail in tests, and registering the mailer in a WebAFX application. All examples are complete ESM modules and use top-level `await`. For the architectural big picture, see the Overview; for a deep dive into the abstractions, see Core Concepts.

---

## Installation

### Requirements

- **Node.js >= 22.0.0** — the package ships a single ESM entry point (`dist/index.js`) with bundled type declarations (`dist/index.d.ts`). It is `import`-only; there is no CommonJS build.
- **`nodemailer` `^9.0.3`** — a direct dependency, installed automatically with the package. You never import or configure it yourself; `SmtpMailProvider` wraps it completely.
- **`blendsdk/webafx`** — an *optional* peer dependency. Install it only if you use the plugin factories (`createMailPlugin`, `smtpMailPlugin`, `memoryMailPlugin`) to integrate the mailer into a WebAFX application. The providers themselves work fully standalone.
- **TypeScript** — use an exports-aware `moduleResolution` (`"node16"`, `"nodenext"`, or `"bundler"`) so the package's `exports` map resolves correctly.

### Install Commands

```bash
# npm
npm install blendsdk

# yarn
yarn add blendsdk

# pnpm
pnpm add blendsdk
```

If you plan to use the WebAFX plugin factories, install the optional peer alongside:

```bash
# npm
npm install blendsdk

# yarn
yarn add blendsdk

# pnpm
pnpm add blendsdk
```

### Verify the Installation

```typescript
import { DEFAULT_SERVICE_NAME } from "blendsdk/webafx-mailer";

console.log(DEFAULT_SERVICE_NAME); // "mailer"
```

---

## Quick Start

The fastest way to a working mailer is the in-memory backend — no SMTP server, no credentials, no network. It stores every "sent" message so you can inspect it afterwards:

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

const result = await mailer.send({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Hello from webafx-mailer",
    text: "This message was captured in memory.",
});

console.log(result.accepted); // ["user@example.com"]
```

No email leaves the process. When you are ready for real delivery, replace `MemoryMailProvider` with `SmtpMailProvider` (see [Sending Real Email over SMTP](#sending-real-email-over-smtp)), or register either backend in a WebAFX application with `smtpMailPlugin()` / `memoryMailPlugin()` (see [Registering the Mailer in WebAFX](#registering-the-mailer-in-webafx)).

---

## Fundamentals

Each subsection introduces exactly one new concept, building on the previous one.

### Creating a Mail Provider

Every backend extends the abstract `MailProvider` class. `MemoryMailProvider` is the simplest to create — its config is optional, and the service name resolves to the `"mailer"` default:

```typescript
import { DEFAULT_SERVICE_NAME, MemoryMailProvider } from "blendsdk/webafx-mailer";

// Simplest case — all defaults
const mailer = new MemoryMailProvider();
console.log(mailer.serviceName);      // "mailer"
console.log(DEFAULT_SERVICE_NAME);    // "mailer"

// Next level — a custom service name for multi-provider setups
const reportingMailer = new MemoryMailProvider({ serviceName: "reporting-mailer" });
console.log(reportingMailer.serviceName); // "reporting-mailer"

await mailer.shutdown();
await reportingMailer.shutdown();
```

The `serviceName` is the identity the provider registers under when wired into WebAFX. With distinct names you can run several providers side by side (e.g. `"transactional-mailer"`, `"marketing-mailer"`). A provider created without config and one created with `{ serviceName: "mailer" }` are equivalent.

### Sending a Message and Reading the Result

`send()` accepts a `MailMessage` and resolves to a `MailResult`. The memory backend stores the message and immediately reports success:

```typescript
import { MemoryMailProvider, type MailResult } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

const result: MailResult = await mailer.send({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Welcome!",
    text: "Welcome to our service!",
});

console.log("Accepted:", result.accepted);    // ["user@example.com"]
console.log("Rejected:", result.rejected);    // []
console.log("Message ID:", result.messageId); // "<memory-...@test>"

await mailer.shutdown();
```

`MailResult` fields:

| Field | Type | Description |
| --- | --- | --- |
| `accepted` | `string[]` | Addresses that accepted the message. |
| `rejected` | `string[]` | Addresses refused by the server — always `[]` on the memory backend. |
| `messageId` | `string \| undefined` | Server-assigned identifier; the memory backend generates a synthetic `<memory-{timestamp}-{index}@test>` value. |

`from`, `to`, and `subject` are the only required message fields. The full field set is introduced in the next subsection.

### Sending Real Email over SMTP

`SmtpMailProvider` implements the same `send()` contract but delivers through nodemailer. The constructor requires `host` and `port`; `secure` defaults to `false`, matching the modern convention of STARTTLS on port 587:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,        // STARTTLS — the common modern default
    secure: false,    // true = implicit TLS (typically port 465)
    auth: {
        user: "user@example.com",
        pass: "secret",
    },
});

const result = await mailer.send({
    from: "noreply@example.com",
    to: "customer@example.com",
    subject: "Your receipt",
    text: "Thanks for your purchase.",
});

console.log("Delivered to:", result.accepted);
console.log("Message ID:", result.messageId);

await mailer.shutdown();
```

Notes:

- The nodemailer transport is created once in the constructor and pools connections internally; `health()` and `shutdown()` manage its lifecycle (covered later in this section).
- `secure: false` upgrades the connection via STARTTLS. Use `secure: true` for implicit TLS (e.g. port 465). Omit `auth` for unauthenticated/relay servers, and use the `tls` option for extra TLS settings such as certificate validation.
- Because both backends share the `MailProvider` type, switching from memory to SMTP changes only the provider creation — every `send()` call site stays identical.
- Unlike the memory backend, the SMTP backend **throws** on connection failures, authentication errors, and send rejections — see [Error Handling](#error-handling).

### Richer Messages: HTML, CC/BCC, and Attachments

`MailMessage` supports the full set of email fields. Recipients (`to`, `cc`, `bcc`) accept either a single address or an array, and `from` supports the display-name form:

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

const result = await mailer.send({
    from: "Reports <reports@example.com>",
    to: ["alice@example.com", "bob@example.com"],
    cc: "team-lead@example.com",
    bcc: "archive@example.com",
    subject: "Monthly report",
    text: "The monthly report is attached.",
    html: "<h1>Monthly Report</h1><p>See the attached file.</p>",
    attachments: [
        {
            filename: "report.txt",
            content: Buffer.from("Revenue: 42"),
            contentType: "text/plain",
        },
    ],
});

console.log(result.accepted);
// ["alice@example.com", "bob@example.com", "team-lead@example.com", "archive@example.com"]

await mailer.shutdown();
```

Full message model:

**MailMessage**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `from` | `string` | Yes | Sender address; plain (`"a@b.com"`) or display-name (`"Name <a@b.com>"`) form. |
| `to` | `string \| string[]` | Yes | Primary recipient(s). |
| `cc` | `string \| string[]` | No | Carbon copy recipient(s). |
| `bcc` | `string \| string[]` | No | Blind carbon copy recipient(s). |
| `subject` | `string` | Yes | Subject line. |
| `text` | `string` | No | Plain-text body; acts as fallback when `html` is also provided. |
| `html` | `string` | No | Rich HTML body. |
| `attachments` | `MailAttachment[]` | No | File attachments. |

Provide at least one of `text` or `html` for body content.

**MailAttachment**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `filename` | `string` | Yes | File name shown to the recipient (e.g. `"report.pdf"`). |
| `content` | `Buffer \| string` | Yes | Raw `Buffer` for binary data, or a base64-encoded string. |
| `contentType` | `string` | No | MIME type hint (e.g. `"application/pdf"`). |

The next level — attaching content as a base64-encoded string instead of a `Buffer`:

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

const result = await mailer.send({
    from: "billing@example.com",
    to: "customer@example.com",
    subject: "Invoice #1042",
    text: "Your invoice is attached.",
    attachments: [
        {
            filename: "invoice.txt",
            // `content` also accepts base64-encoded strings.
            content: Buffer.from("Revenue: 42").toString("base64"),
            contentType: "text/plain",
        },
    ],
});

console.log("Sent:", result.messageId);

await mailer.shutdown();
```

### Inspecting Sent Messages in Tests

The memory backend's reason to exist is test assertions: it captures every message so tests can verify exactly what would have been sent. `getSentMessages()` returns all captured entries (as a copy of the array), `getLastMessage()` returns the most recent one, and `clear()` empties the store:

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

await mailer.send({
    from: "billing@example.com",
    to: "customer@example.com",
    subject: "Invoice #1042",
    text: "Your invoice is ready.",
});

const last = mailer.getLastMessage();
console.log(last?.message.subject);           // "Invoice #1042"
console.log(last?.result.accepted);           // ["customer@example.com"]
console.log(mailer.getSentMessages().length); // 1

mailer.clear(); // reset the store between scenarios
console.log(mailer.getSentMessages().length); // 0

await mailer.shutdown();
```

| Method | Returns | Description |
| --- | --- | --- |
| `getSentMessages()` | `SentMailEntry[]` | Shallow copy of all captured entries; mutating the returned array does not affect the store. |
| `getLastMessage()` | `SentMailEntry \| undefined` | The most recently sent entry, or `undefined` when nothing was sent. |
| `clear()` | `void` | Empties the store. |

**SentMailEntry**

| Property | Type | Description |
| --- | --- | --- |
| `message` | `MailMessage` | The original message submitted to `send()` — stored by reference, so identity assertions (`expect(entry.message).toBe(original)`) work. |
| `result` | `MailResult` | The result that `send()` returned for this message. |

All `to` + `cc` + `bcc` recipients land in `result.accepted`, and `result.rejected` is always empty on this backend. Typical test usage:

```typescript fragment
// Vitest pattern — mailer is a MemoryMailProvider created in beforeEach
afterEach(async () => {
    await mailer.shutdown(); // shutdown() also clears the stored messages
});

it("captures the welcome email", async () => {
    await mailer.send({
        from: "noreply@example.com",
        to: "new-user@example.com",
        subject: "Welcome!",
        text: "Welcome aboard!",
    });

    const sent = mailer.getSentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0].message.subject).toBe("Welcome!");
    expect(sent[0].result.accepted).toEqual(["new-user@example.com"]);
});
```

### Health Checks and Graceful Shutdown

Every provider exposes `health()` and `shutdown()`. Health checks never throw — an unreachable backend is reported as `false`:

```typescript
import { MemoryMailProvider, SmtpMailProvider } from "blendsdk/webafx-mailer";

const memoryMailer = new MemoryMailProvider();
console.log(await memoryMailer.health()); // true — no external dependencies

const smtpMailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
});

// Performs an EHLO/HELO handshake with the server — no email is sent.
const smtpReachable = await smtpMailer.health();
console.log("SMTP reachable:", smtpReachable); // true or false

await smtpMailer.shutdown();   // closes the transport and connection pool
await memoryMailer.shutdown(); // clears the in-memory message store
```

| Method | SMTP backend | Memory backend |
| --- | --- | --- |
| `health()` | Runs nodemailer's `verify()` handshake; returns `false` on any failure. | Always returns `true`. |
| `shutdown()` | Closes the transport and releases the connection pool; later `send()` calls fail. | Clears all stored messages. |

When a provider is registered as a WebAFX plugin, both methods are wired into the application automatically — `health()` into the health check endpoint and `shutdown()` into graceful disposal.

### Registering the Mailer in WebAFX

The plugin factories adapt a provider into a WebAFX `PluginDefinition`. `createMailPlugin()` wraps any provider instance; the one-liners create and wrap a provider in a single call:

```typescript
import {
    createMailPlugin,
    MemoryMailProvider,
    memoryMailPlugin,
    smtpMailPlugin,
} from "blendsdk/webafx-mailer";

// Wrap a provider you own — you keep direct access to the instance.
const mailer = new MemoryMailProvider({ serviceName: "mailer" });
const plugin = createMailPlugin(mailer);

console.log(plugin.name);     // "mailer" — taken from provider.serviceName
console.log(plugin.priority); // 30 — the default plugin priority

// One-liners — the provider is created internally and owned by the plugin.
const devPlugin = memoryMailPlugin({ serviceName: "dev-mailer" });
console.log(devPlugin.name); // "dev-mailer"

const productionPlugin = smtpMailPlugin({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "user@example.com", pass: "secret" },
});
console.log(productionPlugin.name); // "mailer"

// Lower priorities install earlier — override via the options argument.
const earlyPlugin = createMailPlugin(mailer, { priority: 5 });
console.log(earlyPlugin.priority); // 5

await mailer.shutdown();
```

When the application runs the plugin factory, it:

1. Registers the provider as a singleton service under `provider.serviceName` (with `dispose` calling `provider.shutdown()`).
2. Logs the initialization, including the provider's class name.
3. Returns hooks that bridge `provider.health()` into the application health check and `provider.shutdown()` into graceful shutdown.

In a WebAFX application, pass the plugin to `app.use()` and resolve the registered singleton from the service container:

```typescript fragment
// Application bootstrap — register the SMTP mailer under its default service name.
app.use(smtpMailPlugin({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "user@example.com", pass: "secret" },
}));

// Anywhere in the application — resolve the singleton and send.
const mailer = services.get<MailProvider>("mailer");

const result = await mailer.send({
    from: "noreply@example.com",
    to: "customer@example.com",
    subject: "Hello from WebAFX",
    text: "This mailer came from the service container.",
});
```

For tests that need assertions, create the `MemoryMailProvider` yourself and pass it to `createMailPlugin()` — the one-liners keep the provider instance internal, so there is nothing to call `getSentMessages()` on.

### Switching Backends by Environment

`createMailProvider()` is a type-discriminated factory for environment-based backend switching: pass `type: "smtp"` or `type: "memory"` and it returns the matching provider. SMTP-specific fields are only read when `type` is `"smtp"`:

```typescript
import { createMailProvider, type MailProvider } from "blendsdk/webafx-mailer";

const isProduction = process.env.NODE_ENV === "production";

const mailer: MailProvider = createMailProvider({
    type: isProduction ? "smtp" : "memory",
    serviceName: "transactional-mailer",
    host: process.env.SMTP_HOST ?? "localhost",
    port: Number(process.env.SMTP_PORT ?? "587"),
    secure: false,
    auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" }
        : undefined,
});

console.log("Backend:", mailer.constructor.name);
// "SmtpMailProvider" in production, "MemoryMailProvider" otherwise

await mailer.shutdown();
```

The returned provider is a normal `MailProvider`, so it composes with the plugin layer: `app.use(createMailPlugin(mailer))`. If `type` is neither `"smtp"` nor `"memory"`, the factory throws a descriptive error — see [Invalid Factory Configuration](#invalid-factory-configuration).

### Custom Mail Providers

Because `MailProvider` is exported, you can subclass it to plug any delivery mechanism into the same API — and into the same plugin, health, and shutdown infrastructure. Implement the three abstract methods:

```typescript
import {
    createMailPlugin,
    MailProvider,
    type MailMessage,
    type MailProviderConfig,
    type MailResult,
} from "blendsdk/webafx-mailer";

class ConsoleMailProvider extends MailProvider {
    constructor(config: MailProviderConfig = {}) {
        super(config);
    }

    async send(message: MailMessage): Promise<MailResult> {
        const recipients = Array.isArray(message.to) ? message.to : [message.to];
        console.log(`[console-mail] "${message.subject}" -> ${recipients.join(", ")}`);

        return {
            accepted: recipients,
            rejected: [],
            messageId: `<console-${Date.now()}@local>`,
        };
    }

    async health(): Promise<boolean> {
        return true;
    }

    async shutdown(): Promise<void> {
        console.log("[console-mail] transport closed");
    }
}

const mailer: MailProvider = new ConsoleMailProvider({ serviceName: "audit-mailer" });

const result = await mailer.send({
    from: "noreply@example.com",
    to: "audit@example.com",
    subject: "Deployment finished",
    text: "Deployment #42 completed successfully.",
});

console.log(result.accepted); // ["audit@example.com"]

// Any MailProvider subclass can be registered with the plugin layer.
const plugin = createMailPlugin(mailer);
console.log(plugin.name); // "audit-mailer"

await mailer.shutdown();
```

---

## Configuration

All provider configurations extend the base `MailProviderConfig`, which carries the `serviceName`. Defaults at a glance:

| Setting | Default | Applies to |
| --- | --- | --- |
| Service name | `"mailer"` (exposed as `DEFAULT_SERVICE_NAME`) | All providers and plugins. |
| `secure` | `false` | `SmtpMailProvider` and SMTP factory config. |
| Plugin priority | `30` | `createMailPlugin()` and the one-liner plugin factories. |

### SmtpMailConfig

Passed to `new SmtpMailProvider(config)`, `smtpMailPlugin(config)`, and — via `MailFactoryConfig` — `createMailProvider({ type: "smtp", ... })`:

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `host` | `string` | — (required) | SMTP server hostname (e.g. `"smtp.example.com"`). |
| `port` | `number` | — (required) | SMTP port — `587` for STARTTLS, `465` for implicit TLS, `25` for relay. |
| `secure` | `boolean` | `false` | `true` opens a direct TLS connection; `false` upgrades via STARTTLS. |
| `auth` | `{ user: string; pass: string }` | `undefined` | SMTP credentials; omit for unauthenticated servers. |
| `tls` | `{ rejectUnauthorized?: boolean; [key: string]: unknown }` | `undefined` | Additional TLS options (e.g. certificate validation) passed to the transport. |
| `serviceName` | `string` | `"mailer"` | Service container name used for WebAFX registration. |

### MemoryMailConfig

Passed to `new MemoryMailProvider(config?)`, `memoryMailPlugin(config?)`, and `createMailProvider({ type: "memory", ... })`:

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `serviceName` | `string` | `"mailer"` | The only option — the memory backend has no connection settings. |

### MailFactoryConfig

Passed to `createMailProvider(config)` for environment-based switching:

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `type` | `"smtp" \| "memory"` | — (required) | Selects the backend; unknown values throw at runtime. |
| `serviceName` | `string` | `"mailer"` | Passed through to the created provider. |
| `host` | `string` | `undefined` | SMTP only — required at runtime when `type` is `"smtp"`. |
| `port` | `number` | `undefined` | SMTP only — required at runtime when `type` is `"smtp"`. |
| `secure` | `boolean` | `false` | SMTP only. |
| `auth` | `{ user: string; pass: string }` | `undefined` | SMTP only. |
| `tls` | `{ rejectUnauthorized?: boolean; [key: string]: unknown }` | `undefined` | SMTP only. |

### Plugin Options

`createMailPlugin(provider, options?)` accepts:

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `priority` | `number` | `30` | Plugin installation order — lower values install earlier; `0` is a valid value. |

The plugin's `name` is not an option — it always equals `provider.serviceName` (default `"mailer"`).

### A Fully Specified Configuration

Putting the SMTP options together — note the port 465 / implicit TLS pairing:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    serviceName: "transactional-mailer",
    host: "smtp.example.com",
    port: 465,
    secure: true, // implicit TLS — pairs with port 465
    auth: {
        user: "user@example.com",
        pass: "secret",
    },
    tls: {
        rejectUnauthorized: true, // validate the server certificate (default)
    },
});

console.log(mailer.serviceName); // "transactional-mailer"

await mailer.shutdown();
```

---

## Error Handling

The package defines no custom error classes. Failures surface as standard `Error` instances raised by the runtime or nodemailer, and the memory backend cannot fail under normal operation.

### How Errors Surface

| Scenario | Backend | Behavior |
| --- | --- | --- |
| Server unreachable during `send()` | SMTP | Rejects with an `Error` (e.g. connection refused). |
| Authentication rejected during `send()` | SMTP | Rejects with an `Error`. |
| Individual recipients refused | SMTP | Resolves; refused addresses are reported in `result.rejected`. |
| `health()` cannot reach the server | SMTP | Resolves `false` — never rejects. |
| Any normal `send()` | Memory | Never rejects; `result.rejected` is always `[]`. |
| Unknown `type` in `createMailProvider()` | Factory | Throws `Error: Unknown mail type: "<value>". Supported types: "smtp", "memory".` |

### Handling Send Failures (SMTP)

Wrap `send()` in `try/catch`, and treat `result.rejected` as a separate, partial-failure signal:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "user@example.com", pass: "secret" },
});

try {
    const result = await mailer.send({
        from: "noreply@example.com",
        to: "customer@example.com",
        subject: "Your receipt",
        text: "Thanks for your purchase.",
    });

    if (result.rejected.length > 0) {
        console.warn("Rejected recipients:", result.rejected.join(", "));
    } else {
        console.log("Sent:", result.messageId);
    }
} catch (error) {
    const reason = error instanceof Error ? error.message : "SMTP send failed";
    console.error("Email could not be sent:", reason);
} finally {
    await mailer.shutdown();
}
```

The package performs no automatic retries — if you need retry behavior, implement it at the call site (e.g. a bounded retry loop around `send()`).

### Checking Health Without Exceptions

`health()` is designed for monitoring: it reports failures as `false` instead of throwing, so it is safe to call in health endpoints and startup checks:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
});

if (await mailer.health()) {
    console.log("SMTP backend is reachable");
} else {
    console.warn("SMTP backend is unreachable — sends will fail until it recovers");
}

await mailer.shutdown();
```

### Invalid Factory Configuration

`createMailProvider()` validates the `type` discriminator at runtime and throws with a descriptive message — useful when the value comes from an environment variable, which TypeScript cannot check:

```typescript
import { createMailProvider } from "blendsdk/webafx-mailer";

// Environment variables are plain strings — guard the value at startup.
const configuredType = (process.env.MAIL_TYPE ?? "sendgrid") as "smtp" | "memory";

try {
    const mailer = createMailProvider({
        type: configuredType,
        host: "smtp.example.com",
        port: 587,
    });

    console.log("Created:", mailer.constructor.name);
    await mailer.shutdown();
} catch (error) {
    // Unknown mail type: "sendgrid". Supported types: "smtp", "memory".
    console.log(error instanceof Error ? error.message : "unexpected failure");
}
```

### Rejected Recipients Are Results, Not Errors

A resolved `send()` means the server processed the message. If it refused specific addresses, they appear in `result.rejected` — a data-level concern to retry or flag, not a transport failure to catch:

```typescript fragment
const result = await mailer.send(message);

if (result.rejected.length > 0) {
    // The message was processed, but these addresses were refused —
    // flag them for review or retry.
    console.warn("Server refused:", result.rejected.join(", "));
}
```

---

## Next Steps

- Core Concepts — the full deep dive: provider contract, message model, both backends, plugin internals, and the configuration model.
- Overview — package scope, architecture, dependencies, and design patterns.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
