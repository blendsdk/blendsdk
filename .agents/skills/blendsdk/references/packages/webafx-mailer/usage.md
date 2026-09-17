> **Package**: `blendsdk/webafx-mailer`

# webafx-mailer Core Concepts

This document is a deep dive into the core abstractions of `blendsdk/webafx-mailer`. Each concept below follows the same structure: **What It Is**, **How It Works**, a complete example, and a reference table. If you are new to the package, read the Overview first; hands-on application wiring is covered in Basic Usage.

The concepts covered, in order:

- **MailProvider** — the abstract contract that every backend implements
- **Mail messages and results** — `MailMessage`, `MailAttachment`, `MailResult` — the data that flows through the contract
- **Provider configuration** — `MailProviderConfig`, `SmtpMailConfig`, `MemoryMailConfig`
- **SmtpMailProvider** — the production backend powered by nodemailer
- **MemoryMailProvider** — the in-memory backend with test assertion helpers
- **WebAFX plugin factories** — `createMailPlugin()`, `smtpMailPlugin()`, `memoryMailPlugin()`
- **createMailProvider** — type-discriminated backend selection for environment-based switching

---

## MailProvider — The Abstract Contract

### What It Is

`MailProvider` is the abstract base class that defines the complete public contract of the package. Every backend — the bundled `SmtpMailProvider` and `MemoryMailProvider`, as well as any custom implementation you write — extends this class, so application code can depend on `MailProvider` alone and stay backend-agnostic. The design intentionally mirrors the `CacheProvider` pattern from `blendsdk/webafx-cache`.

### How It Works

- The constructor accepts a `MailProviderConfig` and stores `config.serviceName ?? DEFAULT_SERVICE_NAME` (`"mailer"`) in the protected `_serviceName` field. The public `serviceName` getter exposes it; the WebAFX plugin factories use this name as the service-registration key.
- Three abstract methods form the contract:
  - `send(message: MailMessage): Promise<MailResult>` — delivers the message. Resolves with the transport's result; **throws** on failure (connection problems, authentication failures, server rejections).
  - `health(): Promise<boolean>` — returns `true` when the backend is operational. This is a boolean probe, not an exception channel: the bundled SMTP provider catches verification errors and resolves `false` instead of throwing.
  - `shutdown(): Promise<void>` — graceful shutdown. For SMTP this closes the nodemailer transport and its connection pool (after which `send()` fails); for Memory it clears the stored messages.
- Because the contract is class-based, a custom backend is just a subclass implementing the three methods — it then composes with `createMailPlugin()` and the rest of the infrastructure without modification.

### Complete Example

```typescript
import { MailProvider, MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { MailMessage, MailProviderConfig, MailResult } from "blendsdk/webafx-mailer";

/**
 * A custom MailProvider that logs every send before delegating storage
 * to MemoryMailProvider. Extending MailProvider and implementing the three
 * abstract methods is all that is required to create a valid backend.
 */
class LoggingMailProvider extends MailProvider {
    private readonly inner: MemoryMailProvider;

    constructor(config: MailProviderConfig = {}) {
        super(config);
        this.inner = new MemoryMailProvider();
    }

    async send(message: MailMessage): Promise<MailResult> {
        const to = Array.isArray(message.to) ? message.to.join(", ") : message.to;
        console.log(`[mail] sending "${message.subject}" to ${to}`);
        return this.inner.send(message);
    }

    async health(): Promise<boolean> {
        return this.inner.health();
    }

    async shutdown(): Promise<void> {
        await this.inner.shutdown();
    }
}

// Application code depends only on the abstraction
const mailer: MailProvider = new LoggingMailProvider({ serviceName: "audited-mailer" });
console.log(mailer.serviceName); // "audited-mailer"

const result = await mailer.send({
    from: "noreply@example.com",
    to: ["alice@example.com", "bob@example.com"],
    subject: "Welcome!",
    text: "Welcome to our service!",
});

console.log(result.accepted);       // ["alice@example.com", "bob@example.com"]
console.log(await mailer.health()); // true

await mailer.shutdown();
```

### Key Methods and Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `constructor` | `(config: MailProviderConfig) => MailProvider` | Stores `serviceName` from config; falls back to `"mailer"` |
| `serviceName` | `readonly string` (getter) | Registration name used by the WebAFX plugin factories |
| `send` | abstract `(message: MailMessage) => Promise<MailResult>` | Sends the message; throws on delivery failure |
| `health` | abstract `() => Promise<boolean>` | `true` when the backend is operational; never throws |
| `shutdown` | abstract `() => Promise<void>` | Closes connections / releases resources |
| `_serviceName` | `protected string` | Backing field for `serviceName` |
| `DEFAULT_SERVICE_NAME` | `string` (exported constant) | `"mailer"` — used whenever a config omits `serviceName` |

---

## Mail Messages and Send Results

### What It Is

`MailMessage` and its supporting `MailAttachment` type describe exactly what an outgoing email contains; `MailResult` describes what happened during delivery. Together they are the data contract that flows through `MailProvider.send()` — the only shapes that cross the provider boundary.

### How It Works

- **Required elements** — a message needs `from`, `to`, and `subject`. Body content is provided via `text` (plain) and/or `html` (rich); when both are present, `text` acts as the fallback for clients that do not render HTML.
- **Recipient flexibility** — `to`, `cc`, and `bcc` each accept either a single address string or an array of strings. Backends normalize consistently with their nature:
  - `MemoryMailProvider` flattens every recipient group (in `to → cc → bcc` order) into `accepted` and reports nothing as rejected.
  - `SmtpMailProvider` joins arrays with `", "` (the format nodemailer expects) and reports the `accepted`/`rejected` addresses the SMTP server actually processed.
- **Attachments** — each attachment carries a `filename`, `content` as a `Buffer` (binary data) or a base64-encoded `string`, and an optional MIME `contentType`. Both backends preserve them; SMTP forwards them to nodemailer.
- **Results** — `accepted` and `rejected` are always arrays (never `undefined`). `messageId` is optional on the type because not every transport supplies one: Memory always generates `` `<memory-{timestamp}-{index}@test>` ``, while SMTP forwards nodemailer's `info.messageId`.

### Complete Example

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { MailAttachment, MailMessage, MailResult } from "blendsdk/webafx-mailer";

// Attachment content can be a Buffer (binary data)...
const invoice: MailAttachment = {
    filename: "invoice-1234.txt",
    content: Buffer.from("Invoice #1234 - Total: $42.00", "utf8"),
    contentType: "text/plain",
};

// ...or a base64-encoded string (here: a 1x1 transparent PNG)
const logo: MailAttachment = {
    filename: "logo.png",
    content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    contentType: "image/png",
};

const message: MailMessage = {
    from: "billing@example.com",
    to: ["alice@example.com", "bob@example.com"],
    cc: "accounting@example.com",
    bcc: "archive@example.com",
    subject: "Your invoice",
    text: "Please find your invoice attached.",
    html: "<p>Please find your invoice <strong>attached</strong>.</p>",
    attachments: [invoice, logo],
};

const mailer = new MemoryMailProvider();
const result: MailResult = await mailer.send(message);

// MemoryMailProvider marks every recipient (to + cc + bcc) as accepted
console.log(result.accepted);
// ["alice@example.com", "bob@example.com", "accounting@example.com", "archive@example.com"]
console.log(result.rejected);  // []
console.log(result.messageId); // "<memory-...@test>"

await mailer.shutdown();
```

### Key Properties

**`MailMessage`**

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `from` | `string` | Yes | Sender address; plain or `"Name <address>"` form |
| `to` | `string \| string[]` | Yes | Primary recipient(s) |
| `cc` | `string \| string[]` | No | Carbon-copy recipient(s) |
| `bcc` | `string \| string[]` | No | Blind carbon-copy recipient(s) |
| `subject` | `string` | Yes | Subject line |
| `text` | `string` | No | Plain-text body; fallback when `html` is set |
| `html` | `string` | No | HTML body |
| `attachments` | `MailAttachment[]` | No | File attachments |

**`MailAttachment`**

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `filename` | `string` | Yes | Filename shown to the recipient |
| `content` | `Buffer \| string` | Yes | `Buffer` for binary data, base64-encoded `string` otherwise |
| `contentType` | `string` | No | MIME type, e.g. `"application/pdf"`, `"text/plain"` |

**`MailResult`**

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `accepted` | `string[]` | Yes | Addresses that accepted the message |
| `rejected` | `string[]` | Yes | Addresses that rejected the message |
| `messageId` | `string` | No | Transport-assigned message ID (e.g., `"<abc123@smtp.example.com>"`) |

---

## Provider Configuration Types

### What It Is

The type-only configuration layer of the package: `MailProviderConfig` (the shared base, carrying `serviceName`), `SmtpMailConfig` (everything needed to connect to an SMTP server via nodemailer), and `MemoryMailConfig` (nothing beyond the base). These interfaces define how concrete providers are constructed; `MailFactoryConfig`, the fourth config type, is covered in the [createMailProvider](#createMailProvider--Runtime-Backend-Selection) section below.

### How It Works

- **Shared base** — every provider accepts `MailProviderConfig`, so `serviceName` is universally available. When omitted it defaults to `DEFAULT_SERVICE_NAME` (`"mailer"`); distinct names enable multiple mailer instances in one application.
- **SMTP specifics** — `host` and `port` are the only required fields. `secure` defaults to `false` inside `SmtpMailProvider` (`config.secure ?? false`), the modern default since port 587 uses STARTTLS. `auth` can be omitted entirely for unauthenticated servers. `tls` is forwarded to nodemailer as-is — unlike older versions there is no hardcoded `rejectUnauthorized: false`, so certificate validation is under your control.
- **Memory specifics** — `MemoryMailConfig` adds no fields; it is literally `interface MemoryMailConfig extends MailProviderConfig {}`.
- **Type-only module** — all of these are `export type` declarations, erased at runtime. `types.ts` contains exactly one runtime value: the `DEFAULT_SERVICE_NAME` constant.
- **Reused by the plugin layer** — the same shapes are accepted by the plugin factories: `smtpMailPlugin(config)` takes a `SmtpMailConfig`, `memoryMailPlugin(config?)` takes a `MemoryMailConfig`.

Typical port usage:

| Port | Typical use | `secure` value |
|------|-------------|----------------|
| `25` | Server-to-server relay (often blocked for client submission) | `false` |
| `587` | Client submission with STARTTLS — the modern default | `false` |
| `465` | Client submission with implicit TLS | `true` |

### Complete Example

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";
import type { MemoryMailConfig, SmtpMailConfig } from "blendsdk/webafx-mailer";

// STARTTLS (most common): port 587, secure false, authenticated
const productionConfig: SmtpMailConfig = {
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

// Constructing the provider creates a nodemailer transport (connection is lazy)
const smtpMailer = new SmtpMailProvider(productionConfig);
console.log(smtpMailer.serviceName); // "transactional-mailer"

// Memory config: only a serviceName is configurable
const memoryConfig: MemoryMailConfig = {
    serviceName: "development-mailer",
};
console.log(memoryConfig.serviceName); // "development-mailer"

await smtpMailer.shutdown();
```

### Key Configuration Properties

**`MailProviderConfig`** (base, extended by all configs)

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `serviceName` | `string` | No | Registration name; defaults to `"mailer"` |

**`SmtpMailConfig`** (extends `MailProviderConfig`)

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `host` | `string` | Yes | SMTP server hostname |
| `port` | `number` | Yes | SMTP server port (25, 465, or 587) |
| `secure` | `boolean` | No | `true` for implicit TLS (port 465); defaults to `false` (STARTTLS) |
| `auth` | `{ user: string; pass: string }` | No | Credentials; omit for unauthenticated servers |
| `tls` | `{ rejectUnauthorized?: boolean; [key: string]: unknown }` | No | Additional TLS options forwarded to nodemailer |

**`MemoryMailConfig`** (extends `MailProviderConfig`) — no additional fields; only `serviceName` is configurable.

---

## SmtpMailProvider — SMTP Backend

### What It Is

`SmtpMailProvider` is the concrete backend that delivers real email through an SMTP server using nodemailer. It is the production backend of the package.

### How It Works

- **Construction** — the constructor calls `nodemailer.createTransport({ host, port, secure: config.secure ?? false, auth, tls })`. The transport connects lazily and manages connection pooling internally — which is why the plugin registers the provider as a singleton, so the whole application reuses one pool.
- **`send()`** — converts the `MailMessage` into nodemailer's format:
  - `to`/`cc`/`bcc` arrays are joined with `", "`; `undefined` stays `undefined`.
  - Attachments are mapped to `{ filename, content, contentType }`.
  - Resolves with a `MailResult`: nodemailer's `info.accepted` and `info.rejected` mapped to strings (empty arrays when absent), plus `info.messageId`.
  - Rejects (throws) on connection failure, authentication failure, or send rejection — wrap calls in `try`/`catch`.
- **`health()`** — calls `transporter.verify()`, which performs an SMTP EHLO/HELO handshake *without sending any email*. Failures are caught and reported as `false` rather than thrown.
- **`shutdown()`** — calls `transporter.close()` to release the connection pool. After this, subsequent `send()` calls fail.
- **Extension point** — the raw `nodemailer.Transporter` is exposed to subclasses via the protected `transporter` field.

The package's own integration test suite exercises this provider against a Mailpit container (SMTP on `:1025`, REST API on `:8025`).

### Complete Example

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

// Health check: EHLO/HELO handshake — no email is sent
const reachable: boolean = await mailer.health();
console.log(reachable); // true if the SMTP server answered

try {
    const result = await mailer.send({
        from: "notifications@example.com",
        to: ["alice@example.com", "bob@example.com"],
        cc: "team@example.com",
        subject: "Deployment finished",
        text: "Version 5.x has been deployed.",
        html: "<p>Version <strong>5.x</strong> has been deployed.</p>",
    });

    console.log(result.accepted);  // addresses the server accepted
    console.log(result.rejected);  // addresses the server rejected
    console.log(result.messageId); // e.g. "<a1b2c3@smtp.example.com>"
} catch (error) {
    // Connection failures, auth failures, and send rejections all throw here
    console.error("Send failed:", error instanceof Error ? error.message : String(error));
} finally {
    // Release the nodemailer connection pool — send() fails after this
    await mailer.shutdown();
}
```

### Key Methods and Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `constructor` | `(config: SmtpMailConfig) => SmtpMailProvider` | Creates a nodemailer transport; `secure` defaults to `false` |
| `send` | `(message: MailMessage) => Promise<MailResult>` | Sends via SMTP; arrays joined with `", "`; throws on failure |
| `health` | `() => Promise<boolean>` | `transporter.verify()` EHLO/HELO probe; `false` on failure, never throws |
| `shutdown` | `() => Promise<void>` | `transporter.close()` — releases the connection pool |
| `transporter` | `protected nodemailer.Transporter` | The underlying nodemailer transport (available to subclasses) |

---

## MemoryMailProvider — In-Memory Backend

### What It Is

`MemoryMailProvider` is the in-memory backend for development and testing. It stores every "sent" message instead of delivering it, and exposes helper methods that make email flows trivial to assert in test suites.

### How It Works

- **Storage** — maintains a protected `messages: SentMailEntry[]` array. Each entry pairs the original `MailMessage` (stored **by reference**) with the `MailResult` returned from `send()`.
- **`send()`** — never throws and never touches the network:
  - Normalizes `to`, `cc`, and `bcc` to arrays (`undefined` cc/bcc become `[]`).
  - Reports every recipient as accepted — `accepted = [...to, ...cc, ...bcc]`, `rejected = []`.
  - Generates a predictable messageId: `` `<memory-{timestamp}-{index}@test>` `` where `index` is the number of messages stored before this one, so consecutive sends are always unique.
  - Pushes `{ message, result }` and resolves with the result.
- **Test helpers**:
  - `getSentMessages()` returns a **shallow copy** of the array — mutating the returned array does not affect the store (the entry objects themselves are shared).
  - `getLastMessage()` returns the most recent entry, or `undefined` when nothing was sent.
  - `clear()` empties the store — ideal between test cases.
- **Lifecycle** — `health()` always resolves `true` (no external dependencies); `shutdown()` simply calls `clear()`.

### Complete Example

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { SentMailEntry } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

// "Send" a password-reset email — nothing leaves the process
const result = await mailer.send({
    from: "noreply@example.com",
    to: ["alice@example.com", "bob@example.com"],
    cc: "audit@example.com",
    subject: "Password reset",
    text: "Use the link below to reset your password.",
});

console.log(result.accepted);
// ["alice@example.com", "bob@example.com", "audit@example.com"]
console.log(result.messageId); // e.g. "<memory-1729512345678-0@test>"

// Assert on what was captured
const sent: SentMailEntry[] = mailer.getSentMessages();
console.log(sent.length);             // 1
console.log(sent[0].message.subject); // "Password reset"
console.log(sent[0].result.accepted); // ["alice@example.com", "bob@example.com", "audit@example.com"]

// Convenience accessor for the most recent message
const last = mailer.getLastMessage();
console.log(last?.message.subject);   // "Password reset"

// Reset between test cases, then verify the store is empty
mailer.clear();
console.log(mailer.getSentMessages().length); // 0

await mailer.shutdown(); // also clears the store
```

### Key Methods and Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `constructor` | `(config?: MemoryMailConfig) => MemoryMailProvider` | Defaults to `{ serviceName: "mailer" }` |
| `send` | `(message: MailMessage) => Promise<MailResult>` | Stores the message; all recipients accepted; never throws |
| `getSentMessages` | `() => SentMailEntry[]` | Shallow copy of the store for test assertions |
| `getLastMessage` | `() => SentMailEntry \| undefined` | Most recent entry, or `undefined` if none sent |
| `clear` | `() => void` | Empties the store |
| `health` | `() => Promise<boolean>` | Always `true` — no external dependencies |
| `shutdown` | `() => Promise<void>` | Clears the store |
| `messages` | `protected SentMailEntry[]` | Internal message store |

**`SentMailEntry`**

| Property | Type | Description |
|----------|------|-------------|
| `message` | `MailMessage` | The message as submitted (same object reference) |
| `result` | `MailResult` | The result `send()` returned |

For full end-to-end testing patterns, see Basic Usage.

---

## WebAFX Plugin Factories

### What It Is

The plugin factories — `createMailPlugin()`, `smtpMailPlugin()`, and `memoryMailPlugin()` — convert a `MailProvider` into a WebAFX `PluginDefinition`. The plugin registers the provider as an application-wide **singleton service**, hooks its `health()` into the application health endpoint, and runs its `shutdown()` during graceful shutdown. This is the only module in the package that imports `blendsdk/webafx`, which is why WebAFX is an *optional* peer dependency.

### How It Works

1. **`smtpMailPlugin(config)`** constructs a `SmtpMailProvider` internally and delegates to `createMailPlugin()`. **`memoryMailPlugin(config?)`** does the same with `MemoryMailProvider`. Both are one-liners that require no manual provider instantiation.
2. **`createMailPlugin(provider, options?)`** is the core function. It returns a `PluginDefinition` with:
   - `name` — read from `provider.serviceName` (default `"mailer"`).
   - `priority` — `options?.priority ?? 30`. The default 30 installs the plugin after most core plugins; `0` is a valid explicit value.
   - `factory` — an async function that runs when WebAFX initializes the plugin:
     1. Registers the provider in the service container via `app.registerService({ name, type: "singleton", factory: () => provider, dispose })` — the `dispose` callback runs `provider.shutdown()`.
     2. Logs initialization of the plugin and the provider class name via the app logger.
     3. Returns `{ health, shutdown }` hooks — `health()` feeds the `/health` endpoint, `shutdown()` participates in graceful application shutdown.
3. **Multiple mailers per application** — give each provider a distinct `serviceName` (e.g., `"transactional-mailer"`, `"marketing-mailer"`) and register one plugin per mailer.
4. **Any provider works** — `createMailPlugin()` accepts SMTP, Memory, or your own custom `MailProvider` subclass.

Pass the resulting definitions to your WebAFX application with `app.use(...)`; see Basic Usage for a complete application wiring example.

### Complete Example

```typescript
import {
    MemoryMailProvider,
    createMailPlugin,
    memoryMailPlugin,
    smtpMailPlugin,
} from "blendsdk/webafx-mailer";
import type { PluginDefinition } from "blendsdk/webafx";

// One-liner: create + register an SMTP-backed mailer (name defaults to "mailer")
const productionPlugin: PluginDefinition = smtpMailPlugin({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "notifications@example.com", pass: "smtp-secret" },
});

// One-liner: in-memory backend — same call shape, nothing is actually sent
const developmentPlugin: PluginDefinition = memoryMailPlugin();

// Bring your own provider — any MailProvider instance, including custom subclasses
const provider = new MemoryMailProvider({ serviceName: "transactional-mailer" });
const transactionalPlugin: PluginDefinition = createMailPlugin(provider, { priority: 10 });

// Multiple mailers in one application: distinct serviceName per plugin
const marketingPlugin: PluginDefinition = memoryMailPlugin({ serviceName: "marketing-mailer" });

console.log(productionPlugin.name);         // "mailer"
console.log(productionPlugin.priority);     // 30
console.log(developmentPlugin.name);        // "mailer"
console.log(transactionalPlugin.name);      // "transactional-mailer"
console.log(transactionalPlugin.priority);  // 10
console.log(marketingPlugin.name);          // "marketing-mailer"

// In your WebAFX application, register the plugins you need:
//   app.use(productionPlugin);   // or app.use(developmentPlugin) outside production
//   app.use(marketingPlugin);
```

### Key Methods and Properties

| Function | Signature | Description |
|----------|-----------|-------------|
| `createMailPlugin` | `(provider: MailProvider, options?: { priority?: number }) => PluginDefinition` | Core wiring function; plugin name = `provider.serviceName`; priority defaults to 30 |
| `smtpMailPlugin` | `(config: SmtpMailConfig) => PluginDefinition` | Creates a `SmtpMailProvider` internally and wires it |
| `memoryMailPlugin` | `(config?: MemoryMailConfig) => PluginDefinition` | Creates a `MemoryMailProvider` internally and wires it |

**`PluginDefinition` produced by these factories**

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | The provider's `serviceName`, used as the service-registration key |
| `priority` | `number` | Default `30`; overridable via `options.priority` (value `0` is preserved) |
| `factory` | `async ({ app, logger }) => Promise<{ health: () => Promise<boolean>; shutdown: () => Promise<void> }>` | Registers the provider as a `"singleton"` service (with `dispose` → `shutdown()`), logs initialization, and returns lifecycle hooks |

---

## createMailProvider — Runtime Backend Selection

### What It Is

`createMailProvider()` is a type-discriminated factory that constructs the right provider from a single `MailFactoryConfig`. Its primary use case is environment-based backend switching: SMTP in production, in-memory in development and CI — decided at runtime, with no changes to calling code.

### How It Works

- **`type: "smtp"`** → creates a `SmtpMailProvider`, forwarding `serviceName`, `host`, `port`, `secure`, `auth`, and `tls`. `host` and `port` must be supplied for SMTP (the factory asserts them with non-null assertions); a missing value surfaces as a connection error at send time.
- **`type: "memory"`** → creates a `MemoryMailProvider` with just the `serviceName`; all SMTP-specific fields in the config are ignored.
- **Fail-fast guard** — any other runtime value falls through to the `default` branch and throws `Unknown mail type: "<value>". Supported types: "smtp", "memory".` This catches config-file typos or bad environment variables that TypeScript cannot see at compile time.
- **Composability** — returns a plain `MailProvider`. Combine it with `createMailPlugin()` for full WebAFX integration, or use it standalone in any Node.js service.

### Complete Example

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

// Combine with the plugin factory for full WebAFX integration
const plugin = createMailPlugin(mailer);
console.log(plugin.name); // "mailer"

// Standalone usage (no WebAFX) works the same way
const result = await mailer.send({
    from: "notifications@example.com",
    to: "alice@example.com",
    subject: "Environment check",
    text: `Running in ${process.env.NODE_ENV ?? "development"} mode.`,
});

console.log(result.accepted); // ["alice@example.com"] (memory backend in this example)

await mailer.shutdown();
```

Invalid types fail fast with a descriptive error:

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

### Key Methods and Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `createMailProvider` | `(config: MailFactoryConfig) => MailProvider` | Returns a `SmtpMailProvider` or `MemoryMailProvider`; throws on an unknown `type` |

**`MailFactoryConfig`**

| Property | Type | Applies to | Description |
|----------|------|------------|-------------|
| `type` | `"smtp" \| "memory"` | both | Backend discriminator |
| `serviceName` | `string` | both | Registration name; defaults to `"mailer"` |
| `host` | `string` | `"smtp"` | SMTP hostname — required when `type === "smtp"` |
| `port` | `number` | `"smtp"` | SMTP port — required when `type === "smtp"` |
| `secure` | `boolean` | `"smtp"` | Implicit TLS flag; defaults to `false` |
| `auth` | `{ user: string; pass: string }` | `"smtp"` | SMTP credentials; omit for unauthenticated servers |
| `tls` | `{ rejectUnauthorized?: boolean; [key: string]: unknown }` | `"smtp"` | Additional TLS options forwarded to nodemailer |

---

# webafx-mailer Basic Usage

This guide takes you from installation to a working send — first with the zero-setup in-memory backend, then over real SMTP, and finally wired into a WebAFX application as a plugin. Every example is complete ESM TypeScript (strict mode) and can be copied as-is. For the conceptual deep dive behind these APIs, see Core Concepts.

---

## Installation

Install the package with npm:

```bash
npm install blendsdk/webafx-mailer
```

Or with Yarn:

```bash
yarn add blendsdk/webafx-mailer
```

### Requirements

- **Node.js 22+** — the package targets modern ESM Node.js.
- **ESM only** — use `import` syntax; the package ships as an ES module (`"type": "module"`).
- **Strict TypeScript** — all exported types are strict; no `any` appears in the public API.
- **`nodemailer`** — comes with the package as a direct dependency; it powers the SMTP backend only.
- **`blendsdk/webafx`** — an *optional* peer dependency. You only need it when using the plugin factories (`smtpMailPlugin()`, `memoryMailPlugin()`, `createMailPlugin()`) inside a WebAFX application. The `SmtpMailProvider` and `MemoryMailProvider` classes work standalone in any Node.js project.

---

## Quick Start

Get a working (in-memory) mailer running without any configuration — no SMTP server, no Docker, no environment variables:

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

const result = await mailer.send({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Hello!",
    text: "Hello from blendsdk/webafx-mailer.",
});

console.log(result.accepted); // ["user@example.com"]
```

That is the complete provider lifecycle: create → send → read the result. To deliver real email instead, swap `MemoryMailProvider` for `SmtpMailProvider` with your SMTP settings — the `send()` call stays exactly the same (see step 7 below).

---

## Fundamentals

The walkthrough below starts with a no-configuration in-memory mailer and builds up, one concept at a time, to real SMTP delivery and WebAFX integration:

1. Send your first email (in-memory backend)
2. Read the send result
3. Address recipients (to, cc, bcc)
4. Write text and HTML bodies
5. Attach files
6. Inspect sent messages (test helpers)
7. Send real email over SMTP
8. Check health and shut down
9. Register with a WebAFX application
10. Choose a backend per environment

### 1. Send Your First Email (In-Memory Backend)

Every backend implements the same `send()` method, and the quickest way to try it is `MemoryMailProvider` — it stores messages in memory instead of delivering them. A `MailMessage` requires `from`, `to`, and `subject`; the body comes from `text` and/or `html`.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

// Step 1: create a provider — the memory backend needs no configuration
const mailer = new MemoryMailProvider();

// Step 2: send a message — from, to, and subject are required
const result = await mailer.send({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Welcome!",
    text: "Welcome to our service!",
});

// Step 3: the message was captured — nothing left the process
console.log(mailer.getSentMessages().length); // 1
console.log(result.accepted);                 // ["user@example.com"]
```

Nothing left the process: the provider captured the message and marked the recipient as accepted. That makes this backend ideal for local development and tests.

### 2. Read the Send Result

`send()` always resolves with a `MailResult` describing what the backend did with the message.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { MailResult } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

const result: MailResult = await mailer.send({
    from: "noreply@example.com",
    to: ["alice@example.com", "bob@example.com"],
    subject: "Release announcement",
    text: "Version 5.x is now available.",
});

console.log(result.accepted);  // ["alice@example.com", "bob@example.com"]
console.log(result.rejected);  // []
console.log(result.messageId); // "<memory-1729512345678-0@test>"
```

- **`accepted` / `rejected`** — always arrays. The memory backend accepts every recipient (`to` + `cc` + `bcc`, in that order); the SMTP backend reports what the server actually processed.
- **`messageId`** — optional, because not every transport returns one. Memory generates a deterministic `` `<memory-{timestamp}-{index}@test>` ``; SMTP forwards the ID assigned by the mail server.

### 3. Address Recipients (to, cc, bcc)

Every recipient field accepts either a single address string or an array of addresses.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

// Simple case: one recipient as a plain string
await mailer.send({
    from: "notifications@example.com",
    to: "alice@example.com",
    subject: "Single recipient",
    text: "Only Alice receives this message.",
});

// Next level: arrays for every recipient group, plus cc and bcc
const result = await mailer.send({
    from: "notifications@example.com",
    to: ["alice@example.com", "bob@example.com"],
    cc: ["team-lead@example.com", "support@example.com"],
    bcc: "audit@example.com",
    subject: "Deployment complete",
    text: "Version 5.x has been deployed.",
});

console.log(result.accepted);
// ["alice@example.com", "bob@example.com", "team-lead@example.com", "support@example.com", "audit@example.com"]
```

`cc` and `bcc` are optional and may each be a single string or an array — mix the forms freely.

### 4. Write Text and HTML Bodies

Provide `text`, `html`, or both. `text` acts as the fallback for clients that cannot render HTML, so providing both is recommended.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

await mailer.send({
    from: "digest@example.com",
    to: "user@example.com",
    subject: "Your weekly digest",
    // Plain-text fallback for clients that do not render HTML
    text: "Your weekly digest: three new articles are waiting for you.",
    // Rich HTML body for clients that do
    html: "<h1>Your weekly digest</h1><p>Three new articles are waiting for you.</p>",
});
```

Both bodies belong to the same message — recipients never receive two separate emails.

### 5. Attach Files

Attachments carry a `filename`, `content` — either a `Buffer` for binary data or a base64-encoded string — and an optional `contentType`.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { MailAttachment } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

// Simple case: one attachment with Buffer content
const invoice: MailAttachment = {
    filename: "invoice-1234.csv",
    content: Buffer.from("id,total\n1234,42.00", "utf8"),
    contentType: "text/csv",
};

// Next level: multiple attachments — content can also be a base64-encoded string
const logo: MailAttachment = {
    filename: "logo.png",
    content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    contentType: "image/png",
};

await mailer.send({
    from: "billing@example.com",
    to: "user@example.com",
    subject: "Your invoice",
    text: "Please find your invoice attached.",
    attachments: [invoice, logo],
});

console.log(mailer.getLastMessage()?.message.attachments?.length); // 2
```

### 6. Inspect Sent Messages (Test Helpers)

`MemoryMailProvider` keeps every captured message and exposes three helpers beyond the abstract contract:

- **`getSentMessages()`** — a shallow copy of every captured entry (`message` + `result`), in send order. Mutating the returned array does not affect the internal store.
- **`getLastMessage()`** — the most recent entry, or `undefined` when nothing was sent.
- **`clear()`** — empties the store; call this between test cases.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { SentMailEntry } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();

await mailer.send({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Password reset",
    text: "Use the link in this email to reset your password.",
});

// All captured entries (message + result), in send order
const sent: SentMailEntry[] = mailer.getSentMessages();
console.log(sent.length);              // 1
console.log(sent[0].message.subject);  // "Password reset"
console.log(sent[0].result.accepted);  // ["user@example.com"]

// Convenience accessor for the most recent message
const last: SentMailEntry | undefined = mailer.getLastMessage();
console.log(last?.message.to); // "user@example.com"

// Reset the store between test cases
mailer.clear();
console.log(mailer.getSentMessages().length); // 0
```

These helpers exist only on `MemoryMailProvider` — they are not part of the abstract `MailProvider` contract, because real backends have no reason to store messages.

### 7. Send Real Email over SMTP

`SmtpMailProvider` delivers real email through any SMTP server, using nodemailer under the hood. `secure` defaults to `false` — the correct choice for port 587, where the connection is upgraded with STARTTLS. Use `secure: true` with port 465 (implicit TLS).

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,     // STARTTLS submission port
    secure: false, // the default — STARTTLS
    auth: {
        user: "notifications@example.com",
        pass: "smtp-secret",
    },
});

const result = await mailer.send({
    from: "notifications@example.com",
    to: ["alice@example.com", "bob@example.com"],
    subject: "Deployment complete",
    text: "Version 5.x has been deployed.",
});

console.log(result.accepted);  // addresses the SMTP server accepted
console.log(result.messageId); // e.g. "<a1b2c3@smtp.example.com>"

await mailer.shutdown(); // release the nodemailer connection pool
```

The transport is created in the constructor, connects lazily, and pools connections internally — keep one provider instance per application (the WebAFX plugin in step 9 does this for you).

Because both backends share one contract, application code can depend on `MailProvider` and stay backend-agnostic:

```typescript
import { MemoryMailProvider, SmtpMailProvider } from "blendsdk/webafx-mailer";
import type { MailMessage, MailProvider } from "blendsdk/webafx-mailer";

// Application code depends on MailProvider only — the backend is an
// implementation detail chosen at composition time
async function sendWelcome(mailer: MailProvider, to: string): Promise<void> {
    const message: MailMessage = {
        from: "noreply@example.com",
        to,
        subject: "Welcome!",
        text: "Welcome to our service!",
    };

    await mailer.send(message);
}

const memoryMailer = new MemoryMailProvider();
const smtpMailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "notifications@example.com", pass: "smtp-secret" },
});

// The same function works with either backend
await sendWelcome(memoryMailer, "dev@example.com");
await sendWelcome(smtpMailer, "user@example.com");

await smtpMailer.shutdown();
```

### 8. Check Health and Shut Down

`health()` is a safe, non-throwing probe. For SMTP it performs an EHLO/HELO handshake with the server — no email is sent — and resolves `false` if the server is unreachable. `shutdown()` releases resources: SMTP closes the connection pool (subsequent `send()` calls fail), and memory clears the store.

```typescript
import { MemoryMailProvider, SmtpMailProvider } from "blendsdk/webafx-mailer";

// Memory backend: health() is always true; shutdown() clears the store
const memoryMailer = new MemoryMailProvider();
const memoryHealthy: boolean = await memoryMailer.health();
console.log(memoryHealthy); // true
await memoryMailer.shutdown();

// SMTP backend: health() performs an EHLO/HELO handshake — no email is sent
const smtpMailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    auth: {
        user: "notifications@example.com",
        pass: "smtp-secret",
    },
});

const smtpHealthy: boolean = await smtpMailer.health();
console.log(smtpHealthy); // true when the server is reachable

// Releases the nodemailer connection pool — send() fails after this point
await smtpMailer.shutdown();
```

Call `shutdown()` once when your application exits. The WebAFX plugin (next step) wires this into the application lifecycle for you.

### 9. Register with a WebAFX Application

The plugin factories register a provider in the WebAFX service container, expose its health through the application health endpoint, and run `shutdown()` during graceful shutdown. `smtpMailPlugin()` and `memoryMailPlugin()` create the provider **and** the plugin in one call — you never construct the provider yourself.

```typescript
import {
    MemoryMailProvider,
    createMailPlugin,
    memoryMailPlugin,
    smtpMailPlugin,
} from "blendsdk/webafx-mailer";
import type { PluginDefinition } from "blendsdk/webafx";

// One-liner for production — the SMTP provider is created internally
const productionPlugin: PluginDefinition = smtpMailPlugin({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "notifications@example.com", pass: "smtp-secret" },
});

// One-liner for development — nothing is actually sent
const developmentPlugin: PluginDefinition = memoryMailPlugin();

// Bring your own provider — any MailProvider instance works
const provider = new MemoryMailProvider({ serviceName: "audit-mailer" });
const auditPlugin: PluginDefinition = createMailPlugin(provider, { priority: 10 });

console.log(productionPlugin.name);     // "mailer"
console.log(productionPlugin.priority); // 30 (default)
console.log(developmentPlugin.name);    // "mailer"
console.log(auditPlugin.name);          // "audit-mailer"
console.log(auditPlugin.priority);      // 10

// Register with your WebAFX application instance (`app`):
//     app.use(productionPlugin); // or developmentPlugin outside production
//     app.use(auditPlugin);
```

When WebAFX initializes the plugin, it:

1. Registers the provider in the service container as a `"singleton"` named `provider.serviceName` — every consumer resolves the same instance (one shared nodemailer connection pool).
2. Hooks the provider's `health()` into the application health endpoint.
3. Runs `shutdown()` during graceful application shutdown (and when the service is disposed).

To run more than one mailer in a single application — for example a transactional and a marketing mailer — give each provider a distinct `serviceName` and register one plugin per mailer. This integration is the only part of the package that needs `blendsdk/webafx`, which is why it is an optional peer dependency.

### 10. Choose a Backend per Environment

`createMailProvider()` selects the backend from a `type` discriminator at runtime — SMTP in production, in-memory in development and CI — without changing application code.

```typescript
import { createMailPlugin, createMailProvider } from "blendsdk/webafx-mailer";
import type { MailFactoryConfig, MailProvider } from "blendsdk/webafx-mailer";

// The backend is chosen from the environment — application code never changes
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
    to: "user@example.com",
    subject: "Environment check",
    text: `Running in ${process.env.NODE_ENV ?? "development"} mode.`,
});

// With the memory backend selected above: ["user@example.com"]
console.log(result.accepted);

// Wrap the provider in a WebAFX plugin when you are ready to register it
const plugin = createMailPlugin(mailer);
console.log(plugin.name); // "mailer"

await mailer.shutdown();
```

When `type` is `"memory"`, the SMTP-specific fields are ignored. If `type` is anything other than `"smtp"` or `"memory"` — for example a typo in an environment variable — the factory throws immediately instead of creating a broken provider. See [Error Handling](#error-handling) below.

---

## Configuration

All configuration is passed as plain objects — to provider constructors, plugin factories, or the runtime factory. The tables below list every option with its type and default.

### Common Options (All Providers)

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `serviceName` | `string` | `"mailer"` | Name used for WebAFX service-container registration and as the plugin name (the `DEFAULT_SERVICE_NAME` constant). Use distinct values to run multiple mailers side by side. |

### SMTP Options (`SmtpMailConfig`)

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `host` | `string` | — (required) | SMTP server hostname |
| `port` | `number` | — (required) | SMTP server port (commonly 25, 465, or 587) |
| `secure` | `boolean` | `false` | `true` for implicit TLS (typically port 465); `false` connects with STARTTLS support (typically port 587) |
| `auth` | `{ user: string; pass: string }` | — (no authentication) | SMTP credentials; omit for servers that do not require authentication |
| `tls` | `{ rejectUnauthorized?: boolean; [key: string]: unknown }` | — (nodemailer defaults) | Extra TLS options forwarded to nodemailer. Certificate validation is not disabled by the package — opt out explicitly via `rejectUnauthorized` if you must. |

Choosing the right `secure` value:

| Port | Typical use | `secure` value |
|------|-------------|----------------|
| `25` | Server-to-server relay — often blocked for client submission | `false` |
| `587` | Client submission with STARTTLS — the modern default | `false` |
| `465` | Client submission with implicit TLS | `true` |

### Memory Options (`MemoryMailConfig`)

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `serviceName` | `string` | `"mailer"` | The only configurable option — the in-memory backend needs no connection settings |

### Plugin Options (`createMailPlugin`)

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `priority` | `number` | `30` | Plugin initialization order passed to WebAFX. The default places the mailer after most core plugins; `0` is a valid explicit value. |

### Factory Options (`MailFactoryConfig`)

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `type` | `"smtp" \| "memory"` | — (required) | Selects the backend; any other runtime value throws an `Error` |
| `serviceName` | `string` | `"mailer"` | Forwarded to the created provider |
| `host` | `string` | — | SMTP hostname; used only when `type === "smtp"` |
| `port` | `number` | — | SMTP port; used only when `type === "smtp"` |
| `secure` | `boolean` | `false` | Forwarded to `SmtpMailProvider` |
| `auth` | `{ user: string; pass: string }` | — | Forwarded to `SmtpMailProvider` |
| `tls` | `{ rejectUnauthorized?: boolean; [key: string]: unknown }` | — | Forwarded to `SmtpMailProvider` |

### Configuration Examples

```typescript
import { SmtpMailProvider, memoryMailPlugin } from "blendsdk/webafx-mailer";
import type { SmtpMailConfig } from "blendsdk/webafx-mailer";

// (A) STARTTLS submission on port 587 — the most common configuration
const startTlsConfig: SmtpMailConfig = {
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

const startTlsMailer = new SmtpMailProvider(startTlsConfig);
console.log(startTlsMailer.serviceName); // "transactional-mailer"

// (B) Implicit TLS on port 465
const implicitTlsConfig: SmtpMailConfig = {
    host: "smtp.example.com",
    port: 465,
    secure: true,
    auth: {
        user: "notifications@example.com",
        pass: "smtp-secret",
    },
};

const implicitTlsMailer = new SmtpMailProvider(implicitTlsConfig);

// (C) The memory backend has a single option: serviceName
const developmentPlugin = memoryMailPlugin({ serviceName: "development-mailer" });
console.log(developmentPlugin.name); // "development-mailer"

await startTlsMailer.shutdown();
await implicitTlsMailer.shutdown();
```

For environment-driven configuration, see [Fundamentals step 10](#10-choose-a-backend-per-environment).

---

## Error Handling

The package follows a simple rule: **operations that touch the network can throw; everything else reports failure through return values.** `MemoryMailProvider` never throws, and `health()` never throws on any backend.

### Errors and Signals at a Glance

| Error / signal | Produced by | Meaning |
|----------------|-------------|---------|
| Thrown `Error` | `SmtpMailProvider.send()` | SMTP connection failure, authentication failure, or a server-side send rejection. `error.message` describes the cause. |
| Thrown `Error` | `createMailProvider()` | `config.type` is not `"smtp"` or `"memory"` — message: `Unknown mail type: "...". Supported types: "smtp", "memory".` No provider is created. |
| `false` result | `SmtpMailProvider.health()` | The SMTP server is unreachable. This is a probe, not an exception — nothing is thrown. |
| `rejected` array | `MailResult` | The server accepted some recipients but rejected these. `send()` still resolves — always inspect `result.rejected` before assuming full delivery. |
| — (nothing) | `MemoryMailProvider` | All operations are pure in-memory work: `send()` stores the message, the helpers read it. No network, no failure modes. |

### Handling Send Failures

Wrap SMTP sends in `try`/`catch`. Connection failures, authentication failures, and send rejections all reject the returned promise:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    auth: {
        user: "notifications@example.com",
        pass: "smtp-secret",
    },
});

try {
    const result = await mailer.send({
        from: "notifications@example.com",
        to: "user@example.com",
        subject: "Order confirmation",
        text: "Your order #1234 has been confirmed.",
    });

    console.log("Sent:", result.messageId ?? "(no message ID returned)");
} catch (error) {
    // Connection failures, authentication failures, and send rejections land here
    const message = error instanceof Error ? error.message : String(error);
    console.error("Sending failed:", message);
} finally {
    // Standalone script: release the connection pool when done
    await mailer.shutdown();
}
```

If you prefer not to rely on exceptions to detect connectivity problems, use `health()` instead — it resolves `false` rather than throwing (see [Fundamentals step 8](#8-check-health-and-shut-down)).

### Inspecting Partial Delivery

A send can resolve even when the server rejected some recipients. Check `result.rejected` to detect partial delivery:

```typescript
import { SmtpMailProvider } from "blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    auth: {
        user: "notifications@example.com",
        pass: "smtp-secret",
    },
});

const result = await mailer.send({
    from: "notifications@example.com",
    to: ["valid@example.com", "typo@invalid-domain.example"],
    subject: "Partial delivery",
    text: "Recipients the server rejects are reported in the result.",
});

// send() resolves with a non-empty rejected list when only some
// recipients were accepted — if ALL recipients are rejected, send() throws instead
if (result.rejected.length > 0) {
    console.warn("Rejected recipients:", result.rejected);
}

await mailer.shutdown();
```

### Handling Configuration Errors

`createMailProvider()` fails fast: an unrecognized `type` throws synchronously at creation time, so misconfigured backends are caught during application startup rather than on the first email.

```typescript
import { createMailProvider } from "blendsdk/webafx-mailer";
import type { MailFactoryConfig } from "blendsdk/webafx-mailer";

// Simulates a backend name read from a config file or environment variable.
// TypeScript sees `string` here, so the invalid value passes compile time
// and must be caught at runtime by the factory.
const rawType: string = "sendgrid";

try {
    const mailer = createMailProvider({ type: rawType } as MailFactoryConfig);
    console.log("Mailer created:", mailer.serviceName);
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Invalid mail configuration:", message);
    // Invalid mail configuration: Unknown mail type: "sendgrid". Supported types: "smtp", "memory".
}
```

---

## Related Documentation

- Overview — what the package is, key features, dependencies, and architecture
- Core Concepts — deep dive into `MailProvider`, message and result types, configuration types, and plugin factories

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
