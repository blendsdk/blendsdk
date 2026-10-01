> **Package**: `blendsdk/webafx-mailer`

# webafx-mailer API Reference

Complete reference for every public export of `blendsdk/webafx-mailer`. The package provides an abstract `MailProvider` contract with two concrete backends — `SmtpMailProvider` (real delivery via nodemailer) and `MemoryMailProvider` (in-memory storage for testing) — plus WebAFX plugin factory functions that register a provider as an application-wide singleton service. All runtime code is ESM; all types are strict TypeScript with no `any`.

---

## Export Summary

| Export | Kind | Description |
|--------|------|-------------|
| `MailMessage` | Type (interface) | Complete outgoing email message (from, to, subject, body, attachments) |
| `MailAttachment` | Type (interface) | File attachment with `Buffer` or base64 string content |
| `MailResult` | Type (interface) | Send result with `accepted`/`rejected` recipients and optional `messageId` |
| `MailProviderConfig` | Type (interface) | Base configuration shared by all providers (`serviceName`) |
| `SmtpMailConfig` | Type (interface) | SMTP connection settings (`host`, `port`, `secure`, `auth`, `tls`) |
| `MemoryMailConfig` | Type (interface) | Memory configuration — extends the base config with no extra fields |
| `MailFactoryConfig` | Type (interface) | Type-discriminated factory config (`"smtp"` \| `"memory"`) |
| `DEFAULT_SERVICE_NAME` | Constant | `"mailer"` — the fallback service name used by every provider |
| `MailProvider` | Abstract class | The contract every backend implements (`send`, `health`, `shutdown`) |
| `SmtpMailProvider` | Class | SMTP backend powered by nodemailer |
| `MemoryMailProvider` | Class | In-memory backend with test assertion helpers |
| `SentMailEntry` | Type (interface) | Stored `{ message, result }` pair returned by `MemoryMailProvider` |
| `createMailPlugin` | Function | Wires any `MailProvider` into WebAFX as a `PluginDefinition` |
| `smtpMailPlugin` | Function | One-liner: create + register an SMTP-backed plugin |
| `memoryMailPlugin` | Function | One-liner: create + register an in-memory plugin |
| `createMailProvider` | Function | Creates a provider from a `MailFactoryConfig` discriminator |

---

## Message Types

The data contract that flows through `MailProvider.send()`. All three interfaces are type-only exports — they are erased at runtime.

### MailMessage

A complete outgoing email. At least one of `text` or `html` should be provided for body content.

| Property | Type | Description |
|----------|------|-------------|
| `from` | `string` | Sender address — plain (`"noreply@example.com"`) or `"Name <email>"` form |
| `to` | `string \| string[]` | Primary recipient(s) — single address or array |
| `cc` | `string \| string[]` | Optional. Carbon-copy recipient(s) |
| `bcc` | `string \| string[]` | Optional. Blind carbon-copy recipient(s) |
| `subject` | `string` | Subject line |
| `text` | `string` | Optional. Plain-text body — used as fallback when `html` is also provided |
| `html` | `string` | Optional. Rich HTML body |
| `attachments` | `MailAttachment[]` | Optional. File attachments |

### MailAttachment

| Property | Type | Description |
|----------|------|-------------|
| `filename` | `string` | Filename for the attachment (e.g., `"report.pdf"`) |
| `content` | `Buffer \| string` | `Buffer` for binary data, or a base64-encoded string |
| `contentType` | `string` | Optional. MIME content type (e.g., `"application/pdf"`, `"text/plain"`) |

### MailResult

| Property | Type | Description |
|----------|------|-------------|
| `accepted` | `string[]` | Addresses that accepted the message (always an array, never `undefined`) |
| `rejected` | `string[]` | Addresses that rejected the message (always an array) |
| `messageId` | `string` | Optional. Transport-assigned ID (e.g., `"<abc123@smtp.example.com>"`); Memory generates `` `<memory-...@test>` `` |

### Example

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { MailAttachment, MailMessage, MailResult } from "blendsdk/webafx-mailer";

const attachment: MailAttachment = {
    filename: "invoice-1234.txt",
    content: Buffer.from("Invoice #1234 - Total: $42.00", "utf8"),
    contentType: "text/plain",
};

const message: MailMessage = {
    from: "billing@example.com",
    to: ["alice@example.com", "bob@example.com"],
    cc: "accounting@example.com",
    bcc: "archive@example.com",
    subject: "Your invoice",
    text: "Please find your invoice attached.",
    html: "<p>Please find your invoice <strong>attached</strong>.</p>",
    attachments: [attachment],
};

const mailer = new MemoryMailProvider();
const result: MailResult = await mailer.send(message);

console.log(result.accepted);
// ["alice@example.com", "bob@example.com", "accounting@example.com", "archive@example.com"]
console.log(result.rejected);  // []
console.log(result.messageId); // "<memory-...@test>"

await mailer.shutdown();
```

---

## Configuration Types

### MailProviderConfig

The base configuration accepted by every provider constructor.

| Property | Type | Description |
|----------|------|-------------|
| `serviceName` | `string` | Optional. Service name for WebAFX container registration. Defaults to `DEFAULT_SERVICE_NAME` (`"mailer"`). Use distinct names for multi-mailer scenarios (`"transactional-mailer"`, `"marketing-mailer"`) |

### SmtpMailConfig

Extends `MailProviderConfig` — adds all settings needed to connect to an SMTP server via nodemailer.

| Property | Type | Description |
|----------|------|-------------|
| `host` | `string` | SMTP server hostname (e.g., `"smtp.example.com"`) |
| `port` | `number` | SMTP server port (common: `25`, `465` for implicit TLS, `587` for STARTTLS) |
| `secure` | `boolean` | Optional. `true` for direct TLS (port 465). Defaults to `false` inside `SmtpMailProvider` (STARTTLS) |
| `auth` | `{ user: string; pass: string }` | Optional. Credentials — omit for unauthenticated servers |
| `tls` | `{ rejectUnauthorized?: boolean; [key: string]: unknown }` | Optional. Additional TLS options forwarded to nodemailer as-is |

### MemoryMailConfig

Extends `MailProviderConfig` with no additional fields (`interface MemoryMailConfig extends MailProviderConfig {}`). Only `serviceName` is configurable.

### MailFactoryConfig

Used by `createMailProvider()` for environment-based backend switching. The `type` field selects the provider; SMTP-specific fields are only used when `type === "smtp"`.

| Property | Type | Description |
|----------|------|-------------|
| `type` | `"smtp" \| "memory"` | Backend discriminator |
| `serviceName` | `string` | Optional. Defaults to `"mailer"` |
| `host` | `string` | Optional (SMTP only). SMTP hostname — required when `type === "smtp"` |
| `port` | `number` | Optional (SMTP only). SMTP port — required when `type === "smtp"` |
| `secure` | `boolean` | Optional (SMTP only). Implicit TLS flag; defaults to `false` |
| `auth` | `{ user: string; pass: string }` | Optional (SMTP only). Credentials |
| `tls` | `{ rejectUnauthorized?: boolean; [key: string]: unknown }` | Optional (SMTP only). TLS options |

### Example

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";
import type { MemoryMailConfig, SmtpMailConfig } from "blendsdk/webafx-mailer";

const smtpConfig: SmtpMailConfig = {
    serviceName: "transactional-mailer",
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: {
        user: "notifications@example.com",
        pass: "smtp-secret",
    },
    tls: {
        rejectUnauthorized: true,
    },
};

const smtpMailer = new SmtpMailProvider(smtpConfig);
console.log(smtpMailer.serviceName); // "transactional-mailer"

// MemoryMailConfig configures nothing beyond serviceName
const memoryConfig: MemoryMailConfig = {
    serviceName: "development-mailer",
};
console.log(memoryConfig.serviceName); // "development-mailer"

await smtpMailer.shutdown();
```

---

## Constants

### DEFAULT_SERVICE_NAME

```typescript
const DEFAULT_SERVICE_NAME = "mailer";
```

| Constant | Type | Value | Description |
|----------|------|-------|-------------|
| `DEFAULT_SERVICE_NAME` | `string` | `"mailer"` | Fallback service name applied by the `MailProvider` constructor whenever a config omits `serviceName`. Also determines the default plugin name used by `createMailPlugin()`, `smtpMailPlugin()`, and `memoryMailPlugin()` |

```typescript
import { DEFAULT_SERVICE_NAME, MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider({ serviceName: DEFAULT_SERVICE_NAME });
console.log(mailer.serviceName); // "mailer"
```

---

## MailProvider (Abstract Base Class)

The abstract contract that every mail backend implements. `SmtpMailProvider`, `MemoryMailProvider`, and any custom backend extend this class, so application code can depend on `MailProvider` alone and remain backend-agnostic. The design mirrors the `CacheProvider` pattern from `blendsdk/webafx-cache`.

### Declaration

```typescript
declare abstract class MailProvider {
    protected _serviceName: string;
    constructor(config: MailProviderConfig);
    get serviceName(): string;
    abstract send(message: MailMessage): Promise<MailResult>;
    abstract health(): Promise<boolean>;
    abstract shutdown(): Promise<void>;
}
```

### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `(config: MailProviderConfig)` | `MailProvider` | Stores `config.serviceName ?? DEFAULT_SERVICE_NAME` in the protected `_serviceName` field |
| `send` | `abstract (message: MailMessage)` | `Promise<MailResult>` | Sends the message. Resolves with accepted/rejected recipients and the server-assigned message ID; **throws** on failure (connection issues, auth failures, rejections) |
| `health` | `abstract ()` | `Promise<boolean>` | `true` when the backend is operational. A boolean probe, not an exception channel — implementations catch errors and resolve `false` |
| `shutdown` | `abstract ()` | `Promise<void>` | Graceful shutdown — close connections and release resources |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `serviceName` | `string` (getter, read-only at call site) | Registration name used for WebAFX service container registration and plugin naming |
| `_serviceName` | `protected string` | Backing field for the `serviceName` getter, initialized from the constructor config |

### Example

```typescript
import { MemoryMailProvider, SmtpMailProvider } from "blendsdk/webafx-mailer";
import type { MailProvider } from "blendsdk/webafx-mailer";

// Any concrete backend can be used through the abstraction
const mailer: MailProvider =
    process.env.NODE_ENV === "production"
        ? new SmtpMailProvider({
              host: "smtp.example.com",
              port: 587,
              auth: { user: "notifications@example.com", pass: "smtp-secret" },
          })
        : new MemoryMailProvider();

console.log(mailer.serviceName); // "mailer"

const result = await mailer.send({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Welcome!",
    text: "Welcome to our service!",
});

console.log(result.accepted);       // ["user@example.com"]
console.log(await mailer.health()); // true

await mailer.shutdown();
```

A custom backend only needs to subclass `MailProvider` and implement `send()`, `health()`, and `shutdown()` — it then composes with `createMailPlugin()` and the rest of the infrastructure without modification.

---

## SmtpMailProvider

The production backend — delivers real email through an SMTP server using nodemailer. The underlying transport handles connection pooling internally, which is why the WebAFX plugin registers this provider as a singleton (one pool per application).

### Declaration

```typescript
declare class SmtpMailProvider extends MailProvider {
    protected transporter: nodemailer.Transporter;
    constructor(config: SmtpMailConfig);
    send(message: MailMessage): Promise<MailResult>;
    health(): Promise<boolean>;
    shutdown(): Promise<void>;
}
```

### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `(config: SmtpMailConfig)` | `SmtpMailProvider` | Calls `nodemailer.createTransport({ host, port, secure: config.secure ?? false, auth, tls })`. Connections are established on demand |
| `send` | `(message: MailMessage)` | `Promise<MailResult>` | Sends via SMTP. Array recipients (`to`/`cc`/`bcc`) are joined with `", "`; attachments are mapped to nodemailer's format. Throws on connection failure, auth failure, or send rejection |
| `health` | `()` | `Promise<boolean>` | Runs `transporter.verify()` — an EHLO/HELO handshake **without sending email**. Resolves `false` on failure; never throws |
| `shutdown` | `()` | `Promise<void>` | Calls `transporter.close()` — releases the connection pool. Subsequent `send()` calls fail |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `transporter` | `protected nodemailer.Transporter` | The underlying nodemailer transport, available to subclasses for extension |

### Result Mapping

- `accepted` — nodemailer's `info.accepted` mapped through `String()`; `[]` when the transport reports none.
- `rejected` — nodemailer's `info.rejected` mapped through `String()`; `[]` when absent.
- `messageId` — `info.messageId` from the SMTP server (or `undefined` when the transport provides none).

### Example

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

// Health probe: EHLO/HELO handshake — no email is sent
const reachable: boolean = await mailer.health();
console.log(reachable); // true when the SMTP server answered

try {
    const result = await mailer.send({
        from: "notifications@example.com",
        to: ["alice@example.com", "bob@example.com"],
        cc: "team@example.com",
        subject: "Deployment finished",
        text: "Version 5.x has been deployed.",
        html: "<p>Version <strong>5.x</strong> has been deployed.</p>",
    });

    console.log(result.accepted);  // addresses accepted by the SMTP server
    console.log(result.rejected);  // addresses rejected by the SMTP server
    console.log(result.messageId); // e.g. "<a1b2c3@smtp.example.com>"
} catch (error) {
    // Connection failures, auth failures, and send rejections all throw here
    console.error("Send failed:", error instanceof Error ? error.message : String(error));
} finally {
    // Release the nodemailer connection pool — send() fails after this
    await mailer.shutdown();
}
```

---

## MemoryMailProvider

The in-memory backend for development and testing. Stores every "sent" message instead of delivering it, and exposes helper methods that make email assertions trivial in test suites. Never touches the network and never throws.

### Declaration

```typescript
declare class MemoryMailProvider extends MailProvider {
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

### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `(config?: MemoryMailConfig)` | `MemoryMailProvider` | Defaults to `{ serviceName: "mailer" }` when no config is given |
| `send` | `(message: MailMessage)` | `Promise<MailResult>` | Stores the message in memory. All recipients (`to` + `cc` + `bcc`) are marked accepted; `rejected` is always `[]`. Never throws |
| `getSentMessages` | `()` | `SentMailEntry[]` | Returns a **shallow copy** of the store — mutating the returned array does not affect internal state |
| `getLastMessage` | `()` | `SentMailEntry \| undefined` | Most recently sent entry, or `undefined` when nothing has been sent |
| `clear` | `()` | `void` | Empties the stored messages. Ideal for resetting state between test cases |
| `health` | `()` | `Promise<boolean>` | Always resolves `true` — no external dependencies |
| `shutdown` | `()` | `Promise<void>` | Clears all stored messages (calls `clear()`) |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `messages` | `protected SentMailEntry[]` | Internal store of all sent message entries |

### Behavior Notes

- **Recipient normalization** — `to`, `cc`, and `bcc` accept single strings or arrays; `undefined` cc/bcc become `[]`. The result's `accepted` list contains `[...to, ...cc, ...bcc]` in that exact order.
- **Message ID pattern** — every send generates `` `<memory-{timestamp}-{index}@test>` ``, where `index` is the number of messages already stored, making consecutive IDs unique and results predictable for test matching.
- **Stored by reference** — each `SentMailEntry` holds the original `MailMessage` object (same reference) plus the `MailResult` returned by `send()`; `getSentMessages()` copies the array, not the entries.

### SentMailEntry

The stored entry interface returned by `getSentMessages()` and `getLastMessage()`.

| Property | Type | Description |
|----------|------|-------------|
| `message` | `MailMessage` | The original message as submitted to `send()` (same object reference) |
| `result` | `MailResult` | The result returned from `send()` |

### Example

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { SentMailEntry } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

// "Send" a password-reset email — nothing leaves the process
const result = await mailer.send({
    from: "noreply@example.com",
    to: "alice@example.com",
    cc: "audit@example.com",
    subject: "Password reset",
    text: "Use the link below to reset your password.",
});

console.log(result.accepted);  // ["alice@example.com", "audit@example.com"]
console.log(result.rejected);  // []
console.log(result.messageId); // e.g. "<memory-1729512345678-0@test>"

// Assert on what was captured
const sent: SentMailEntry[] = mailer.getSentMessages();
console.log(sent.length);             // 1
console.log(sent[0].message.subject); // "Password reset"
console.log(sent[0].result.accepted); // ["alice@example.com", "audit@example.com"]

// Convenience accessor for the most recent message
const last = mailer.getLastMessage();
console.log(last?.message.subject); // "Password reset"

// Reset between test cases
mailer.clear();
console.log(mailer.getSentMessages().length); // 0

await mailer.shutdown(); // also clears the store
```

---

## Plugin Factory Functions

Factory functions that convert a `MailProvider` into a WebAFX `PluginDefinition`. The plugin registers the provider as an application-wide **singleton service**, hooks its `health()` into the application health endpoint, and runs its `shutdown()` during graceful shutdown. This is the only module in the package that imports `blendsdk/webafx` — which is why WebAFX is an *optional* peer dependency.

All functions return `PluginDefinition` from `blendsdk/webafx` (type-only import; no runtime dependency required to use the provider classes standalone).

### createMailPlugin

The core wiring function — accepts any `MailProvider` instance (SMTP, Memory, or custom) and returns a ready-to-use `PluginDefinition`.

```typescript
function createMailPlugin(
    provider: MailProvider,
    options?: { priority?: number }
): PluginDefinition;
```

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `provider` | `MailProvider` | Yes | — | Any `MailProvider` instance. The plugin `name` is read from `provider.serviceName` |
| `options` | `{ priority?: number }` | No | `{}` | Overrides the plugin priority. When omitted, the internal `DEFAULT_PLUGIN_PRIORITY` of `30` is used. `0` is preserved as an explicit value (`??` semantics) |

**Returns** — `PluginDefinition` with the following shape:

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | `provider.serviceName` — also the service-container registration key |
| `priority` | `number` | `options?.priority ?? 30` |
| `factory` | `async ({ app, logger }) => Promise<{ health: () => Promise<boolean>; shutdown: () => Promise<void> }>` | Runs at plugin initialization (see behavior below) |

**Factory behavior** — when WebAFX initializes the plugin:

1. Registers the provider via `app.registerService({ name: provider.serviceName, type: "singleton", factory: () => provider, dispose: async () => provider.shutdown() })` — every consumer resolves the same instance, and container disposal runs `shutdown()`.
2. Logs `Mail plugin "{serviceName}" initialized ({ProviderClassName})` via the application logger.
3. Returns lifecycle hooks: `{ health: () => provider.health(), shutdown: () => provider.shutdown() }` — `health()` feeds the `/health` endpoint, `shutdown()` participates in graceful application shutdown.

**Example**

```typescript
import { MemoryMailProvider, createMailPlugin } from "blendsdk/webafx-mailer";
import type { PluginDefinition } from "blendsdk/webafx";

const provider = new MemoryMailProvider({ serviceName: "transactional-mailer" });

// Custom priority — installs earlier than the default 30
const plugin: PluginDefinition = createMailPlugin(provider, { priority: 10 });

console.log(plugin.name);     // "transactional-mailer"
console.log(plugin.priority); // 10

// In a WebAFX application the plugin is passed to app.use(plugin);
```

### smtpMailPlugin

One-liner registration with an SMTP backend — creates a `SmtpMailProvider` internally; you never instantiate the provider manually.

```typescript
function smtpMailPlugin(config: SmtpMailConfig): PluginDefinition;
```

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `SmtpMailConfig` | Yes | — | SMTP connection settings (host, port, auth, TLS options) passed to the internally created `SmtpMailProvider` |

**Returns** — `PluginDefinition`. The plugin name comes from `config.serviceName ?? "mailer"`; the priority is always the default `30` (use `createMailPlugin()` for a custom priority).

**Example**

```typescript
import { smtpMailPlugin } from "blendsdk/webafx-mailer";
import type { PluginDefinition } from "blendsdk/webafx";

const plugin: PluginDefinition = smtpMailPlugin({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "notifications@example.com", pass: "smtp-secret" },
});

console.log(plugin.name);     // "mailer"
console.log(plugin.priority); // 30
```

### memoryMailPlugin

One-liner registration with an in-memory backend — ideal for development and testing, since no emails are actually sent.

```typescript
function memoryMailPlugin(config?: MemoryMailConfig): PluginDefinition;
```

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `MemoryMailConfig` | No | `{}` → `serviceName` `"mailer"` | Optional configuration; only `serviceName` is used |

**Returns** — `PluginDefinition`. The plugin name comes from `config.serviceName ?? "mailer"`; the priority is always the default `30`.

**Example**

```typescript
import { memoryMailPlugin } from "blendsdk/webafx-mailer";
import type { PluginDefinition } from "blendsdk/webafx";

const plugin: PluginDefinition = memoryMailPlugin({ serviceName: "dev-mailer" });

console.log(plugin.name);     // "dev-mailer"
console.log(plugin.priority); // 30
```

### createMailProvider

Type-discriminated factory for environment-based backend switching. Returns the appropriate provider based on `config.type`; combine with `createMailPlugin()` for full WebAFX integration.

```typescript
function createMailProvider(config: MailFactoryConfig): MailProvider;
```

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `MailFactoryConfig` | Yes | — | Factory configuration with the `type` discriminator |

**Returns** — `MailProvider`:

| `config.type` | Provider created | Configuration forwarded |
|---------------|------------------|-------------------------|
| `"smtp"` | `SmtpMailProvider` | `serviceName`, `host`, `port`, `secure`, `auth`, `tls` |
| `"memory"` | `MemoryMailProvider` | `serviceName` only — all SMTP-specific fields are ignored |

**Throws** — `Error` when `config.type` is neither `"smtp"` nor `"memory"` (catches config-file typos or invalid environment variables TypeScript cannot see at compile time):

```text
Unknown mail type: "<value>". Supported types: "smtp", "memory".
```

**Example — environment-based selection:**

```typescript
import { createMailPlugin, createMailProvider } from "blendsdk/webafx-mailer";
import type { MailFactoryConfig, MailProvider } from "blendsdk/webafx-mailer";

// Pick the backend from the environment — no code changes between environments
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

const result = await mailer.send({
    from: "notifications@example.com",
    to: "alice@example.com",
    subject: "Environment check",
    text: `Running in ${process.env.NODE_ENV ?? "development"} mode.`,
});

console.log(result.accepted); // ["alice@example.com"] (memory backend in this example)

// Combine with the plugin factory for full WebAFX integration
const plugin = createMailPlugin(mailer);
console.log(plugin.name); // "mailer"

await mailer.shutdown();
```

**Example — invalid type fails fast:**

```typescript
import { createMailProvider } from "blendsdk/webafx-mailer";

try {
    // Simulates an invalid value arriving at runtime (e.g., from a config file)
    createMailProvider({ type: "sendgrid" as "smtp" });
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    // Unknown mail type: "sendgrid". Supported types: "smtp", "memory".
}
```

---

## Related Documentation

- Overview — what the package is, when to use it, and its architecture
- Core Concepts — deep dive into `MailProvider`, message/result types, provider configuration, and backend selection
- Basic Usage — hands-on application wiring with WebAFX

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
