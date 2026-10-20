> **Package**: `blendsdk/webafx-mailer`

# webafx-mailer Overview

> **License**: MIT

---

## What It Is

`blendsdk/webafx-mailer` is the outbound email layer of BlendSDK. It defines one small contract — the abstract `MailProvider` class with three async operations (`send()`, `health()`, `shutdown()`) — and ships two concrete implementations: `SmtpMailProvider`, which delivers real mail through [nodemailer](https://nodemailer.com), and `MemoryMailProvider`, which records every message in an in-process array so tests can assert on outbound mail without touching the network.

On top of the providers sits a thin WebAFX integration layer: `createMailPlugin()` turns any `MailProvider` into a `PluginDefinition` that registers the provider as an application-wide singleton service, wires its `health()` into the health endpoint and its `shutdown()` into graceful shutdown. `smtpMailPlugin()`, `memoryMailPlugin()` and the type-discriminated `createMailProvider()` factory are convenience wrappers for that same wiring, letting an application choose its mail backend from configuration while every call site keeps using the identical `MailProvider` API.

---

## Key Features

- **Single provider contract** — `send(message)`, `health()`, `shutdown()` and a `serviceName` getter. Anything typed against `MailProvider` works with every backend, including custom ones.
- **SMTP backend via nodemailer** — pooled transport; `secure` defaults to `false` (STARTTLS on port 587), TLS options pass straight through, and no `rejectUnauthorized: false` is forced. `health()` uses `transporter.verify()` (EHLO/HELO handshake, no email sent); `shutdown()` uses `transporter.close()`.
- **In-memory backend for tests** — every send is stored as a `SentMailEntry` (`{ message, result }`); all `to`/`cc`/`bcc` addresses are reported as `accepted`; message IDs are deterministic (`<memory-<timestamp>-<index>@test>`).
- **Test inspection helpers** — `getSentMessages()` (returns a defensive copy), `getLastMessage()`, and `clear()` on `MemoryMailProvider`.
- **Rich message model** — `text` and `html` alternatives in the same message, `to`/`cc`/`bcc` accept `string | string[]`, attachments accept `Buffer` or base64-encoded `string` with an optional `contentType`.
- **Normalized result** — every backend answers with `MailResult { accepted, rejected, messageId? }`; backend-specific recipient shapes never leak out.
- **WebAFX plugin factories** — `createMailPlugin(provider, options?)`, `smtpMailPlugin(config)`, `memoryMailPlugin(config?)`, all returning a `PluginDefinition` (default priority `30`).
- **Environment-based switching** — `createMailProvider()` takes a `type: "smtp" | "memory"` discriminator and throws a descriptive error for unsupported types.
- **Named services** — `serviceName` (default `"mailer"`, exported as `DEFAULT_SERVICE_NAME`) lets several independent mailers coexist in one application (`"transactional-mailer"`, `"marketing-mailer"`).
- **Optional WebAFX coupling** — only `mail-plugin.ts` imports `blendsdk/webafx`, and that peer is marked optional, so the providers work standalone in any Node service.

---

## When To Use

Use `blendsdk/webafx-mailer` when:

- You send **transactional email** — welcome messages, password resets, receipts, notifications — from a WebAFX application or a plain Node service.
- You want the **backend decided by configuration** (`NODE_ENV`, env vars) while application code stays identical in development, CI and production.
- You need to **assert on outbound mail in tests** without an SMTP server: `MemoryMailProvider` exposes exactly what was sent.
- You want **multiple independent mailers** in one app, each registered under its own service name.
- You need a **provider-agnostic seam** so a future backend (HTTP API, SES, a queue-backed sender) can be added by extending `MailProvider` and changing one line of wiring.

Look elsewhere (or combine with other tools) when you need:

- **Template rendering** — this package sends already-rendered content; render with your own template engine before calling `send()`.
- **Inbound mail** — IMAP, mailbox management and bounce/webhook processing are out of scope.
- **HTTP-API providers** — only SMTP and memory ship today; wrap another API by subclassing `MailProvider`.
- **Delivery guarantees** — there is no retry, persistence, queueing or rate limiting; pair it with a job queue for at-least-once semantics.
- **Campaign tooling** — no list management, scheduling or analytics.

---

## Architecture

The package is deliberately layered so that only one file knows WebAFX and only one file knows nodemailer:

```text
mail-plugin.ts ─────────────► blendsdk/webafx (optional peer, types only)
  │  createMailPlugin / smtpMailPlugin / memoryMailPlugin / createMailProvider
  │
  ├── SmtpMailProvider ─────► nodemailer ─────► SMTP server
  └── MemoryMailProvider ───► in-process SentMailEntry[]
        │
        └── both extend MailProvider  (send / health / shutdown / serviceName)
              │
              └── types.ts — MailMessage, MailResult, configs, DEFAULT_SERVICE_NAME (no imports)
```

Design patterns in play:

| Pattern | Where it appears |
|---|---|
| **Strategy** | `MailProvider` is the interchangeable strategy; SMTP and memory are concrete implementations chosen at wiring time. |
| **Abstract base class** | Shared `serviceName` resolution (`config.serviceName ?? DEFAULT_SERVICE_NAME`) lives once in `MailProvider`; subclasses implement the three abstract methods. |
| **Adapter** | `SmtpMailProvider` adapts nodemailer: joins `string[]` recipients into comma-separated lists, maps `MailAttachment` to nodemailer attachments, and maps `info.accepted` / `info.rejected` / `info.messageId` back into `MailResult`. |
| **Factory** | `createMailProvider()` is a type-discriminated factory (with an exhaustive runtime guard); `smtpMailPlugin()` and `memoryMailPlugin()` are convenience factories that build a provider and wrap it. |
| **Plugin + lifecycle hooks** | `createMailPlugin()` returns a `PluginDefinition` (`name`, `priority`, `factory`). WebAFX calls `factory({ app, logger })`, which registers a singleton service with a `dispose` handler and returns `{ health, shutdown }` hooks. |
| **Fake, not mock** | `MemoryMailProvider` fully satisfies the contract and adds inspection methods on top — the same test can run against SMTP (against a local Mailpit) and memory. |

Behavioural invariants worth remembering:

- The plugin's `name` and the container key both come from `provider.serviceName`, not from the config object passed to the plugin factory.
- `send()` **throws** on transport failures (unreachable host, auth rejection); per-recipient refusals are reported in `result.rejected` instead.
- `health()` never throws — `SmtpMailProvider` catches and returns `false`; `MemoryMailProvider` always returns `true`.
- `shutdown()` on the memory backend clears the store; on SMTP it closes the pool, after which further `send()` calls fail.

Public exports at a glance: classes `MailProvider`, `SmtpMailProvider`, `MemoryMailProvider`; functions `createMailPlugin`, `smtpMailPlugin`, `memoryMailPlugin`, `createMailProvider`; types `MailMessage`, `MailResult`, `MailAttachment`, `MailProviderConfig`, `SmtpMailConfig`, `MemoryMailConfig`, `MailFactoryConfig`, `SentMailEntry`; constant `DEFAULT_SERVICE_NAME`.

---

## Dependencies

| Direction | Name | Notes |
|---|---|---|
| Runtime dependency | `nodemailer` ^9.0.3 | Used exclusively by `SmtpMailProvider`; the memory backend never touches it. |
| Optional peer dependency | `blendsdk/webafx` (`optional: true`) | Imported for the `PluginDefinition` type by `mail-plugin.ts` only. Without it, everything except the four plugin factories still works. |
| Dev-only types | `@types/nodemailer` ^8.0.1 | Compile-time only. |
| Internal dependencies | none | `types.ts` imports nothing; `abstract-mail-provider.ts` imports types only. |
| Platform | Node.js >= 22, ESM (`"type": "module"`), TypeScript strict | No CommonJS build. |

**Depended on by:** applications and services that send mail. Nothing else in the BlendSDK monorepo depends on this package — it is a leaf. Its sibling `blendsdk/webafx-cache` uses the identical plugin shape (`cache-plugin.ts`), so the wiring patterns transfer one-to-one, but there is no code dependency in either direction.

Distribution: the package ships inside the `blendsdk` umbrella — install it once with `npm install blendsdk` (or the yarn/pnpm/bun equivalent) and import the `blendsdk/webafx-mailer` subpath. `nodemailer` arrives as a transitive dependency of the umbrella; `blendsdk/webafx` is only needed when you use the plugin factories.

---

## Minimum Example

The shortest complete program: send a message through the memory backend, inspect it, then shut the provider down. It runs with no SMTP server and no Docker.

```typescript
import { MemoryMailProvider } from "blendsdk/webafx-mailer";
import type { MailMessage, MailResult } from "blendsdk/webafx-mailer";

const mailer = new MemoryMailProvider();
console.log(mailer.serviceName); // "mailer"

const message: MailMessage = {
    from: "noreply@example.com",
    to: ["alice@example.com", "bob@example.com"],
    cc: "team@example.com",
    subject: "Welcome!",
    text: "Welcome to our service.",
    html: "<h1>Welcome to our service.</h1>",
};

const result: MailResult = await mailer.send(message);
console.log(result.accepted);  // ["alice@example.com", "bob@example.com", "team@example.com"]
console.log(result.messageId); // "<memory-1750000000000-0@test>"
console.log(await mailer.health()); // true
console.log(mailer.getLastMessage()?.message.subject); // "Welcome!"

await mailer.shutdown();
```

Swap `new MemoryMailProvider()` for `new SmtpMailProvider({ host, port, auth })` — or register `smtpMailPlugin(config)` on a WebAFX application — and the `send()` call site stays byte-for-byte the same. Subsequent documents in this folder cover installation and wiring, the SMTP and memory backends in depth, the message and configuration types, and the WebAFX plugin lifecycle.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
