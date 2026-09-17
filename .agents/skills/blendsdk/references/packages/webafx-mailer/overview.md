> **Package**: `blendsdk/webafx-mailer`

# webafx-mailer Overview

---

## What It Is

`blendsdk/webafx-mailer` is the email-sending plugin for the WebAFX application framework. It provides a single abstraction — the abstract `MailProvider` base class with the operations `send()`, `health()`, and `shutdown()` — and ships two concrete backends: `SmtpMailProvider`, which delivers real email through nodemailer, and `MemoryMailProvider`, which stores messages in memory for development and testing instead of sending anything. Convenience factory functions (`smtpMailPlugin()`, `memoryMailPlugin()`, `createMailPlugin()`, and the type-discriminated `createMailProvider()`) wire a provider into a WebAFX application as an application-wide singleton service, hook the provider's `health()` into the application health endpoint, and run its `shutdown()` during graceful shutdown. The provider classes are also usable standalone in any Node.js project, because `blendsdk/webafx` is an *optional* peer dependency — only `mail-plugin.ts` imports it. The provider/plugin design mirrors `blendsdk/webafx-cache`.

---

## Key Features

- **Two interchangeable backends** — `SmtpMailProvider` for real delivery via nodemailer, and `MemoryMailProvider` for in-memory storage with test assertion helpers; both share one contract.
- **Uniform provider contract** — every backend implements `send(message)`, `health()`, and `shutdown()`, and exposes a `serviceName` (default: `"mailer"`, from `DEFAULT_SERVICE_NAME`).
- **One-liner WebAFX integration** — `smtpMailPlugin(config)` and `memoryMailPlugin(config?)` create the provider and register it as a singleton service in a single call.
- **Type-discriminated factory** — `createMailProvider({ type: "smtp" | "memory", ... })` selects the backend at runtime, ideal for environment-based switching; an invalid `type` throws a descriptive error.
- **Test helpers on `MemoryMailProvider`** — `getSentMessages()`, `getLastMessage()`, and `clear()` make email assertions trivial; all recipients are reported as accepted and a deterministic `messageId` (`<memory-...@test>`) is generated.
- **Health checks and graceful shutdown** — the plugin hooks `health()` into the `/health` endpoint and `shutdown()` into application shutdown (and service-container disposal); for SMTP, health is verified via nodemailer's EHLO/HELO handshake.
- **Multiple mailers per application** — set a custom `serviceName` (e.g., `"transactional-mailer"`, `"marketing-mailer"`) to register more than one provider instance.
- **Rich message support** — plain-text and HTML bodies, `to`/`cc`/`bcc` as single addresses or arrays, and attachments supplied as `Buffer` or base64-encoded strings.
- **Strict TypeScript** — all message, result, and configuration types are exported with strict typings and no `any`.

---

## When To Use

Use `blendsdk/webafx-mailer` when:

- **Your WebAFX application sends transactional email** — welcome messages, password resets, receipts, or notifications — and you want one clean provider API instead of talking to nodemailer directly.
- **You want environment-specific backends** — SMTP in production, in-memory in development and CI — without changing application code, using `createMailProvider()` with a `type` discriminator.
- **You need to test email flows** — `MemoryMailProvider` captures every message in memory, so tests can assert on recipients, subjects, bodies, and attachments without a real SMTP server or Docker container.
- **You want mail health and lifecycle handled for you** — the plugin surfaces provider health through the app's health endpoint and closes the SMTP connection pool cleanly on shutdown.
- **You run more than one mailer** — for example, a transactional mailer and a marketing mailer in the same application, distinguished by `serviceName`.
- **You are not using WebAFX at all** — the provider classes work standalone in any Node.js service, since `blendsdk/webafx` is an optional peer dependency.

This package sends email only. It does not receive or parse incoming mail, and it does not render templates — pass fully rendered `text`/`html` content in the `MailMessage`.

---

## Architecture

The package is organized in three layers:

1. **WebAFX integration layer** (`mail-plugin.ts`) — factory functions that turn a provider into a WebAFX `PluginDefinition`: singleton service registration, health hook, and shutdown hook. This is the only file that imports `blendsdk/webafx`.
2. **Provider layer** — the abstract `MailProvider` base class and its two implementations (`SmtpMailProvider`, `MemoryMailProvider`).
3. **Types and constants layer** (`types.ts`) — message, result, and configuration types plus `DEFAULT_SERVICE_NAME`.

```
WebAFX Application
  │  app.use(smtpMailPlugin(config) | memoryMailPlugin() | createMailPlugin(provider))
  ▼
mail-plugin.ts  — WebAFX integration layer (only module importing blendsdk/webafx)
  ├─ createMailPlugin(provider, options?)  → PluginDefinition (singleton + health + shutdown)
  ├─ smtpMailPlugin(config)                → SmtpMailProvider, then createMailPlugin
  ├─ memoryMailPlugin(config?)             → MemoryMailProvider, then createMailPlugin
  └─ createMailProvider(factoryConfig)     → "smtp" | "memory" → MailProvider
  │
  ▼
MailProvider (abstract base class)
  ├─ send(message: MailMessage): Promise<MailResult>    (abstract)
  ├─ health(): Promise<boolean>                         (abstract)
  ├─ shutdown(): Promise<void>                          (abstract)
  └─ serviceName: string  (default "mailer")
  │
  ├── SmtpMailProvider   → nodemailer transport → SMTP server
  └── MemoryMailProvider → SentMailEntry[] in memory (+ getSentMessages/getLastMessage/clear)
```

### Design Patterns

- **Abstract base class / template contract** — `MailProvider` defines the exact shape every backend must satisfy; application code depends only on this abstraction.
- **Strategy** — `SmtpMailProvider` and `MemoryMailProvider` are interchangeable sending strategies selected at composition time (typically per environment); swapping backends requires no changes to calling code.
- **Adapter** — `SmtpMailProvider` adapts nodemailer's transport API to the `MailProvider` contract, including array-to-comma-string recipient conversion, `verify()` for health, and `close()` for shutdown.
- **Factory functions** — `createMailProvider()` (type-discriminated), `smtpMailPlugin()`, `memoryMailPlugin()`, and `createMailPlugin()` construct fully configured providers and plugin definitions so consumers never need to touch constructors directly.
- **Singleton registration** — `createMailPlugin()` registers the provider in the WebAFX service container as a `"singleton"`, so every request resolves the same instance (reusing one nodemailer connection pool).
- **Plugin hooks (lifecycle)** — the returned `PluginDefinition` (default priority `30`) contributes `health` and `shutdown` hooks to WebAFX and disposes the service via the container's `dispose` callback.

---

## Dependencies

### Runtime Dependencies

| Package | Version | Used By | Purpose |
|---------|---------|---------|---------|
| `nodemailer` | ^9.0.3 | `SmtpMailProvider` only | SMTP transport, connection pooling, `verify()`-based health checks |

### Peer Dependencies

| Package | Version | Required | Notes |
|---------|---------|----------|-------|
| `blendsdk/webafx` | ^5.x | Optional (`peerDependenciesMeta.optional: true`) | Imported only by `mail-plugin.ts`; provider classes work standalone without WebAFX |

### What Depends on This Package

`blendsdk/webafx-mailer` is a consumer-facing plugin package: WebAFX applications import it directly, and nothing else in the BlendSDK stack depends on it. It follows exactly the same provider/plugin architecture as `blendsdk/webafx-cache`, so knowledge transfers between the two packages. For development, the integration test suite uses Vitest with a Mailpit Docker container acting as a fake SMTP server (SMTP on port 1025, API on port 8025).

---

## Minimum Example

The shortest complete example — an in-memory mailer that "sends" a message, inspects the stored result, and performs the full provider lifecycle. It needs no infrastructure; swap `MemoryMailProvider` for `SmtpMailProvider` with real SMTP settings for delivery.

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
console.log(result.messageId); // "<memory-...@test>"

const sent = mailer.getSentMessages();
console.log(sent.length);              // 1
console.log(sent[0].message.subject);  // "Welcome!"

const healthy = await mailer.health(); // true

await mailer.shutdown();
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
