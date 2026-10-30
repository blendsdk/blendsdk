> **Package**: `blendsdk/webafx-mailer`

# webafx-mailer API Reference

This document is the complete reference for every public export of `blendsdk/webafx-mailer`: three classes, four factory functions, eight interfaces, and one constant. Everything is imported from the package root — the package ships a single ESM entry point with bundled type declarations.

**Reading conventions**

- `typescript fragment` blocks contain declaration references (class shapes, function signatures). Plain `typescript` blocks are complete, runnable examples with all imports.
- In property tables, an optional property carries a `?` suffix (e.g. `cc?`), mirroring its TypeScript declaration.

> **Note** — The plugin factory functions return `PluginDefinition` from `blendsdk/webafx`. That type is **not** re-exported by this package; import it from `blendsdk/webafx` (an optional peer dependency) if you need to annotate plugin values explicitly.

---

## Exports at a Glance

| Symbol | Kind | Description |
|--------|------|-------------|
| [`MailProvider`](#mailprovider-abstract-base-class) | Abstract class | Base contract for all mail backends: `serviceName`, `send()`, `health()`, `shutdown()`. |
| [`SmtpMailProvider`](#smtpmailprovider) | Class | Real SMTP delivery through a nodemailer transport. |
| [`MemoryMailProvider`](#memorymailprovider) | Class | In-memory capture for development and testing, with assertion helpers. |
| [`SentMailEntry`](#sentmailentry) | Interface (type-only) | `{ message, result }` record stored by `MemoryMailProvider`. |
| [`MailMessage`](#mailmessage) | Interface (type-only) | Complete outgoing email (recipients, subject, bodies, attachments). |
| [`MailAttachment`](#mailattachment) | Interface (type-only) | Attachment with `filename`, `content` (Buffer or base64 string), and optional `contentType`. |
| [`MailResult`](#mailresult) | Interface (type-only) | Send outcome: `accepted`, `rejected`, and an optional `messageId`. |
| [`MailProviderConfig`](#mailproviderconfig) | Interface (type-only) | Base provider configuration carrying the optional `serviceName`. |
| [`SmtpMailConfig`](#smtpmailconfig) | Interface (type-only) | SMTP connection settings; extends `MailProviderConfig`. |
| [`MemoryMailConfig`](#memorymailconfig) | Interface (type-only) | Memory backend configuration; extends `MailProviderConfig` with no extra fields. |
| [`MailFactoryConfig`](#mailfactoryconfig) | Interface (type-only) | Type-discriminated configuration for `createMailProvider()`. |
| [`createMailPlugin`](#createmailplugin) | Function | Adapts any `MailProvider` into a WebAFX `PluginDefinition`. |
| [`smtpMailPlugin`](#smtpmailplugin) | Function | One-liner: creates an SMTP provider internally and returns its plugin. |
| [`memoryMailPlugin`](#memorymailplugin) | Function | One-liner: creates an in-memory provider internally and returns its plugin. |
| [`createMailProvider`](#createmailprovider) | Function | Backend factory keyed by `config.type` (`"smtp"` or `"memory"`). |
| [`DEFAULT_SERVICE_NAME`](#default_service_name) | Constant | `"mailer"` — default service name applied by every provider. |

---

## MailProvider (Abstract Base Class)

`MailProvider` is the abstract base every backend extends — the shipped `SmtpMailProvider` and `MemoryMailProvider`, plus any custom subclass you write. It defines the three-method contract (`send`, `health`, `shutdown`) and resolves the provider's service identity from [`MailProviderConfig`](#mailproviderconfig): `config.serviceName ?? DEFAULT_SERVICE_NAME`. Because the class is abstract it cannot be instantiated directly — construct a concrete subclass instead. Custom subclasses are fully supported by [`createMailPlugin()`](#createmailplugin).

```typescript fragment
abstract class MailProvider {
    protected _serviceName: string;

    constructor(config: MailProviderConfig);

    get serviceName(): string;

    abstract send(message: MailMessage): Promise<MailResult>;
    abstract health(): Promise<boolean>;
    abstract shutdown(): Promise<void>;
}
```

### Constructor

`constructor(config: MailProviderConfig)`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `MailProviderConfig` | Yes | — | Base configuration. `config.serviceName` is stored in `_serviceName`, defaulting to `"mailer"`. |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `_serviceName` | `protected string` | Backing field holding the resolved service name. |
| `serviceName` | `string` (getter, read-only) | Service-container registration name used when the provider is registered as a WebAFX singleton service. |

### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `send` | `abstract send(message: MailMessage): Promise<MailResult>` | `Promise<MailResult>` | Sends an email message. Resolves with accepted/rejected recipients and the server-assigned message ID; throws when sending fails (connection issues, auth failures, etc.). |
| `health` | `abstract health(): Promise<boolean>` | `Promise<boolean>` | Health check — resolves to `true` when the backend is operational. SMTP verifies the transport connection via EHLO/HELO; Memory always returns `true`. |
| `shutdown` | `abstract shutdown(): Promise<void>` | `Promise<void>` | Graceful shutdown — closes connections and releases resources. SMTP closes the nodemailer transport and connection pool; Memory clears all stored messages. |

### Example

Implementing the contract with a minimal custom backend:

```typescript
import {
    MailProvider,
    type MailMessage,
    type MailProviderConfig,
    type MailResult,
} from "blendsdk/webafx-mailer";

/** Minimal custom backend that logs messages instead of delivering them. */
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

console.log(mailer.serviceName);    // "audit-mailer"
console.log(await mailer.health()); // true

const result = await mailer.send({
    from: "noreply@example.com",
    to: ["ops@example.com", "oncall@example.com"],
    subject: "Deployment finished",
    text: "Deployment #42 completed successfully.",
});

console.log(result.accepted); // ["ops@example.com", "oncall@example.com"]
console.log(result.rejected); // []

await mailer.shutdown();
```

---

## SmtpMailProvider

Concrete backend that delivers real email through nodemailer. The constructor builds one nodemailer transport from [`SmtpMailConfig`](#smtpmailconfig); `secure` defaults to `false` (STARTTLS on port 587) and TLS certificate validation stays configurable through the `tls` option — there is no hardcoded `rejectUnauthorized: false`. `send()` maps `MailMessage` to nodemailer's format and back into a `MailResult`, `health()` runs `transporter.verify()`, and `shutdown()` closes the transport's connection pool.

```typescript fragment
class SmtpMailProvider extends MailProvider {
    // Transport type from the "nodemailer" package
    protected transporter: nodemailer.Transporter;

    constructor(config: SmtpMailConfig);

    send(message: MailMessage): Promise<MailResult>;
    health(): Promise<boolean>;
    shutdown(): Promise<void>;
}
```

### Constructor

`constructor(config: SmtpMailConfig)`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `SmtpMailConfig` | Yes | — | SMTP connection settings (`host`, `port`, optional `secure`, `auth`, `tls`, `serviceName`); used once to create the nodemailer transport. |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `transporter` | `protected nodemailer.Transporter` | Nodemailer transport instance — handles SMTP connection pooling internally. |
| `serviceName` | `string` (getter, read-only) | Inherited from `MailProvider`; equals `config.serviceName ?? "mailer"`. |

### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `send` | `send(message: MailMessage): Promise<MailResult>` | `Promise<MailResult>` | Translates the message into nodemailer's `sendMail` format — array `to`/`cc`/`bcc` recipients are joined with `", "`, attachments are mapped to `{ filename, content, contentType }` — sends it, and maps the response into a `MailResult` (`accepted`/`rejected` stringified, `messageId` passed through). Throws on SMTP connection failure, authentication failure, or send rejection. |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | Runs `transporter.verify()` — an EHLO/HELO handshake with the server that sends no email. Resolves to `false` on any failure; never throws. |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Calls `transporter.close()`, releasing the underlying TCP connection pool. Subsequent `send()` calls fail. |

### Example

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false, // STARTTLS — use true for implicit TLS (typically port 465)
    auth: {
        user: "user@example.com",
        pass: "secret",
    },
});

console.log("Reachable:", await mailer.health());

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
    console.error("Send failed:", reason);
} finally {
    await mailer.shutdown();
}
```

---

## MemoryMailProvider

Test-oriented backend that never sends anything: each `send()` stores the message and its result as a [`SentMailEntry`](#sentmailentry) (`{ message, result }`) in an internal array, and the class exposes assertion helpers — `getSentMessages()`, `getLastMessage()`, and `clear()`. Recipients are normalized from single strings or arrays; every `to` + `cc` + `bcc` address lands in `accepted`, `rejected` is always `[]`, and `messageId` follows the deterministic pattern `<memory-<timestamp>-<index>@test>` (where `index` is the store length at send time, so consecutive sends stay unique).

```typescript fragment
class MemoryMailProvider extends MailProvider {
    protected messages: SentMailEntry[];

    constructor(config?: MemoryMailConfig);

    send(message: MailMessage): Promise<MailResult>;
    getSentMessages(): SentMailEntry[];
    getLastMessage(): SentMailEntry | undefined;
    clear(): void;
    health(): Promise<boolean>;
    shutdown(): Promise<void>;
}
```

### Constructor

`constructor(config?: MemoryMailConfig)`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `MemoryMailConfig` | No | `{}` | Optional configuration; only `serviceName` is meaningful. Defaults to an empty config (`serviceName` resolves to `"mailer"`). |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `messages` | `protected SentMailEntry[]` | Internal store of all captured messages and their results; starts empty. |
| `serviceName` | `string` (getter, read-only) | Inherited from `MailProvider`; equals `config.serviceName ?? "mailer"`. |

### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `send` | `send(message: MailMessage): Promise<MailResult>` | `Promise<MailResult>` | Stores the message; cannot fail under normal operation. All `to` + `cc` + `bcc` recipients (normalized to arrays) are returned in `accepted`, in that order; `rejected` is always `[]`; `messageId` is `<memory-<timestamp>-<index>@test>`. |
| `getSentMessages` | `getSentMessages(): SentMailEntry[]` | `SentMailEntry[]` | Returns a shallow copy of the internal store in send order — mutating the returned array does not affect the provider's state. Entries inside the copy are shared references. |
| `getLastMessage` | `getLastMessage(): SentMailEntry \| undefined` | `SentMailEntry \| undefined` | Returns the most recently sent entry, or `undefined` when no messages have been sent. |
| `clear` | `clear(): void` | `void` | Empties the store. Useful for resetting state between test cases. |
| `health` | `health(): Promise<boolean>` | `Promise<boolean>` | Always resolves to `true` — the in-memory backend has no external dependencies. |
| `shutdown` | `shutdown(): Promise<void>` | `Promise<void>` | Clears all stored messages (delegates to `clear()`), aligning teardown with the shared `MailProvider` lifecycle. |

### Example

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider({ serviceName: "test-mailer" });

const result = await mailer.send({
    from: "noreply@example.com",
    to: "new-user@example.com",
    cc: "team@example.com",
    subject: "Welcome!",
    text: "Welcome aboard!",
});

console.log(result.accepted);  // ["new-user@example.com", "team@example.com"]
console.log(result.rejected);  // []
console.log(result.messageId); // "<memory-…@test>"

const last = mailer.getLastMessage();
console.log(last?.message.subject);           // "Welcome!"
console.log(mailer.getSentMessages().length); // 1

mailer.clear();
console.log(mailer.getSentMessages().length); // 0

await mailer.shutdown();
```

---

## Plugin Factory Functions

The WebAFX integration layer. These functions produce a `PluginDefinition` and are the only part of the package that depends on `blendsdk/webafx` — the providers themselves are fully usable standalone. Every definition returned by `createMailPlugin()` (and therefore by the one-liners) is populated as follows:

- **`name`** — `provider.serviceName`.
- **`priority`** — `options?.priority ?? 30`; lower values install earlier, and `0` is a valid priority.
- **`factory`** — an async function receiving the WebAFX plugin context (`{ app, logger }`). It registers the provider as a singleton service (`factory: () => provider`) with a `dispose` hook that awaits `provider.shutdown()`, logs `Mail plugin "<serviceName>" initialized (<ClassName>)` through the context logger, and returns `{ health, shutdown }` hooks bridged to the provider.

### createMailPlugin

```typescript fragment
function createMailPlugin(
    provider: MailProvider,
    options?: { priority?: number }
): PluginDefinition;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `provider` | `MailProvider` | Yes | — | Any `MailProvider` instance — SMTP, memory, or a custom subclass. |
| `options` | `{ priority?: number }` | No | `undefined` | Optional overrides for the produced plugin. |
| `options.priority` | `number` | No | `30` | Plugin priority; lower values install earlier. `0` is valid. |

**Returns** — `PluginDefinition` (from `blendsdk/webafx`), configured as described above. The provider instance is captured by reference, so the plugin always resolves the same object.

```typescript
import { createMailPlugin, MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider({ serviceName: "transactional-mailer" });
const plugin = createMailPlugin(mailer, { priority: 10 });

console.log(plugin.name);           // "transactional-mailer"
console.log(plugin.priority);       // 10
console.log(typeof plugin.factory); // "function"

await mailer.shutdown();
```

### smtpMailPlugin

```typescript fragment
function smtpMailPlugin(config: SmtpMailConfig): PluginDefinition;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `SmtpMailConfig` | Yes | — | SMTP settings used internally as `new SmtpMailProvider(config)` before delegating to `createMailPlugin()`. |

**Returns** — `PluginDefinition`. The `SmtpMailProvider` is created internally and owned by the plugin; it is shut down through the plugin's shutdown hook when the application disposes its services.

```typescript
import { smtpMailPlugin } from "blendsdk/webafx-mailer";

const plugin = smtpMailPlugin({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "user@example.com", pass: "secret" },
});

console.log(plugin.name);     // "mailer" (provider service name)
console.log(plugin.priority); // 30 (default plugin priority)
```

Typical registration inside a WebAFX application:

```typescript fragment
// WebAFX application bootstrap
app.use(smtpMailPlugin({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "user@example.com", pass: "secret" },
}));
```

### memoryMailPlugin

```typescript fragment
function memoryMailPlugin(config?: MemoryMailConfig): PluginDefinition;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `MemoryMailConfig` | No | `undefined` (the provider defaults to `{}`) | Optional service-name override for the internally created `MemoryMailProvider`. |

**Returns** — `PluginDefinition`. The provider instance stays internal to the plugin — when a test needs to assert on `getSentMessages()`, create the [`MemoryMailProvider`](#memorymailprovider) yourself and pass it to [`createMailPlugin()`](#createmailplugin) instead.

```typescript
import { memoryMailPlugin } from "blendsdk/webafx-mailer";

const plugin = memoryMailPlugin();                         // serviceName "mailer"
const named = memoryMailPlugin({ serviceName: "dev-mailer" });

console.log(plugin.name); // "mailer"
console.log(named.name);  // "dev-mailer"
```

### createMailProvider

```typescript fragment
function createMailProvider(config: MailFactoryConfig): MailProvider;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `MailFactoryConfig` | Yes | — | Type-discriminated configuration; `config.type` selects the backend. |

**Returns** — `MailProvider`:

- `type: "smtp"` → a `SmtpMailProvider` built from `serviceName`, `host`, `port`, `secure`, `auth`, and `tls`.
- `type: "memory"` → a `MemoryMailProvider` built from `serviceName` only.

**Throws** — `Error` when `config.type` is neither `"smtp"` nor `"memory"`: `Unknown mail type: "<value>". Supported types: "smtp", "memory".` This is a runtime guard for untyped or environment-provided configuration that TypeScript could not check at compile time.

```typescript
import {
    createMailProvider,
    MemoryMailProvider,
    SmtpMailProvider,
    type MailFactoryConfig,
} from "blendsdk/webafx-mailer";

// Environment-based backend switching:
const config: MailFactoryConfig = {
    type: process.env.NODE_ENV === "production" ? "smtp" : "memory",
    serviceName: "transactional-mailer",
    host: process.env.SMTP_HOST ?? "localhost",
    port: Number(process.env.SMTP_PORT ?? "587"),
};

const mailer = createMailProvider(config);

console.log(mailer instanceof SmtpMailProvider);   // true in production
console.log(mailer instanceof MemoryMailProvider); // true otherwise
console.log(mailer.serviceName);                   // "transactional-mailer"

// Unknown types fail fast with a descriptive error:
try {
    createMailProvider({ type: "sendgrid" as "smtp" });
} catch (error) {
    const message = error instanceof Error ? error.message : "unexpected error";
    console.log(message);
    // Unknown mail type: "sendgrid". Supported types: "smtp", "memory".
}

await mailer.shutdown();
```

---

## Message Types

### MailMessage

Complete description of an outgoing email. At least one of `text` or `html` should be provided for body content.

| Property | Type | Description |
|----------|------|-------------|
| `from` | `string` | Sender email address (e.g. `"noreply@example.com"` or `"Name <email>"`). Required. |
| `to` | `string \| string[]` | Primary recipient(s) — a single address or an array of addresses. Required. |
| `cc?` | `string \| string[]` | Carbon copy recipient(s). Optional. |
| `bcc?` | `string \| string[]` | Blind carbon copy recipient(s). Optional. |
| `subject` | `string` | Email subject line. Required. |
| `text?` | `string` | Plain-text body — used as fallback when `html` is also provided. |
| `html?` | `string` | HTML body — rich email content. |
| `attachments?` | `MailAttachment[]` | File attachments. Optional. |

### MailAttachment

A file to attach to an outgoing email.

| Property | Type | Description |
|----------|------|-------------|
| `filename` | `string` | Filename for the attachment (e.g. `"report.pdf"`). Required. |
| `content` | `Buffer \| string` | Attachment content — a raw `Buffer` for binary data, or a base64-encoded string. Required. |
| `contentType?` | `string` | MIME content type (e.g. `"application/pdf"`, `"text/plain"`). Optional. |

### MailResult

Result of a send operation, as resolved by `send()` on every backend.

| Property | Type | Description |
|----------|------|-------------|
| `accepted` | `string[]` | Email addresses that accepted the message. |
| `rejected` | `string[]` | Email addresses that rejected the message; always `[]` for the memory backend. |
| `messageId?` | `string` | Message ID assigned by the mail server (e.g. `"<abc123@smtp.example.com>"`). The memory backend generates `<memory-<timestamp>-<index>@test>`. Optional. |

### SentMailEntry

Record stored by [`MemoryMailProvider`](#memorymailprovider) for each captured message.

| Property | Type | Description |
|----------|------|-------------|
| `message` | `MailMessage` | The original mail message as submitted to `send()`. |
| `result` | `MailResult` | The result returned from `send()`. |

---

## Configuration Types

### MailProviderConfig

Base configuration shared by all mail providers.

| Property | Type | Description |
|----------|------|-------------|
| `serviceName?` | `string` | Service name for WebAFX service container registration. Default: `"mailer"` ([`DEFAULT_SERVICE_NAME`](#default_service_name)). Use different names for multi-provider scenarios (e.g. `"transactional-mailer"`, `"marketing-mailer"`). Optional. |

### SmtpMailConfig

Extends [`MailProviderConfig`](#mailproviderconfig) with all settings needed to connect to an SMTP server via nodemailer.

| Property | Type | Description |
|----------|------|-------------|
| `host` | `string` | SMTP server hostname (e.g. `"smtp.example.com"`). Required. |
| `port` | `number` | SMTP server port. Common values: 25, 465 (TLS), 587 (STARTTLS). Required. |
| `secure?` | `boolean` | Use a direct TLS connection. Default `false` — STARTTLS, typical for port 587; set `true` for implicit TLS (typically port 465). Optional. |
| `auth?` | `{ user: string; pass: string }` | SMTP authentication credentials — omit for unauthenticated servers. Optional. |
| `tls?` | `{ rejectUnauthorized?: boolean; [key: string]: unknown }` | Additional TLS options — certificate validation is configurable here. Optional. |
| `serviceName?` | `string` | Inherited from `MailProviderConfig`; default `"mailer"`. Optional. |

### MemoryMailConfig

Extends [`MailProviderConfig`](#mailproviderconfig) and adds **no additional fields** — only `serviceName` is meaningful for the in-memory backend, which stores messages in memory for test assertions.

| Property | Type | Description |
|----------|------|-------------|
| `serviceName?` | `string` | Inherited from `MailProviderConfig`; default `"mailer"`. Optional. |

### MailFactoryConfig

Type-discriminated configuration used by [`createMailProvider()`](#createmailprovider) for environment-based backend switching. The SMTP-specific fields are only read when `type === "smtp"`.

| Property | Type | Description |
|----------|------|-------------|
| `type` | `"smtp" \| "memory"` | Backend selector — determines which provider is created. Required. |
| `serviceName?` | `string` | Service name for WebAFX service container registration. Default: `"mailer"`. Optional; passed through to the created provider. |
| `host?` | `string` | SMTP server hostname. Used only when `type` is `"smtp"`; required at runtime for SMTP. |
| `port?` | `number` | SMTP server port. Used only when `type` is `"smtp"`; required at runtime for SMTP. |
| `secure?` | `boolean` | Use a direct TLS connection. Forwarded to the SMTP provider. Optional. |
| `auth?` | `{ user: string; pass: string }` | SMTP authentication credentials. Forwarded to the SMTP provider. Optional. |
| `tls?` | `{ rejectUnauthorized?: boolean; [key: string]: unknown }` | Additional TLS options. Forwarded to the SMTP provider. Optional. |

---

## Constants

### DEFAULT_SERVICE_NAME

```typescript fragment
const DEFAULT_SERVICE_NAME = "mailer";
```

| Name | Type | Value | Description |
|------|------|-------|-------------|
| `DEFAULT_SERVICE_NAME` | `"mailer"` (string literal) | `"mailer"` | Default service name for mail when not specified in config. Applied by the `MailProvider` constructor as `config.serviceName ?? DEFAULT_SERVICE_NAME`. |

```typescript
import { DEFAULT_SERVICE_NAME, MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

console.log(DEFAULT_SERVICE_NAME); // "mailer"
console.log(mailer.serviceName);   // "mailer" — resolved from the default
```

---

## See Also

- Overview — what the package is, its architecture, and dependencies.
- Core Concepts — deep dive into the provider contract, message model, backends, and plugin layer.
- Basic Usage — task-oriented walkthroughs for sending email, testing, and WebAFX integration.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
