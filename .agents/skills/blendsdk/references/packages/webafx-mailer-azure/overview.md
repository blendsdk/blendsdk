> **Package**: `blendsdk/webafx-mailer-azure`

# webafx-mailer-azure Overview

---

## What It Is

`blendsdk/webafx-mailer-azure` is an email delivery provider for BlendSDK WebAFX Mailer that sends messages through **Microsoft Graph and Exchange Online** instead of SMTP. It authenticates an Entra application with the official `@azure/msal-node` package using the app-only client-credentials flow, builds a validated Microsoft Graph `sendMail` request from the common BlendSDK `MailMessage` contract, and submits it to `/users/{senderMailbox}/sendMail` with native `fetch`. The package exposes a `MailProvider` subclass (`AzureMailProvider`) for standalone use and a WebAFX plugin factory (`azureMailPlugin`) that registers the provider as a singleton in the application's service container. It is a thin, security-hardened adapter: recipient mapping, body selection, attachment encoding, and input validation all happen locally before any network call, and operational errors never leak secrets, tokens, message bodies, or Graph response payloads.

---

## Key Features

- **App-only Entra authentication** — Uses `ConfidentialClientApplication` from `@azure/msal-node` with the client-credentials flow and the `https://graph.microsoft.com/.default` scope; MSAL handles token caching internally.
- **No SMTP** — Submission goes through the Microsoft Graph v1.0 REST endpoint `POST /users/{senderMailbox}/sendMail` over HTTPS with a bounded 30-second request timeout (`AbortSignal.timeout`).
- **Drop-in `MailProvider` implementation** — Implements the same `send()`, `health()`, and `shutdown()` contract as every other BlendSDK mail provider, so application code stays provider-agnostic.
- **WebAFX plugin factory** — `azureMailPlugin(config)` delegates to `createMailPlugin()` and registers the provider as a singleton under the default service name `mailer` (plugin priority 30), with support for a custom `serviceName`.
- **Full message mapping** — Supports sender display names, multiple To/CC/BCC recipients, plain-text or HTML bodies (HTML preferred when both are supplied), and file attachments with an optional MIME type.
- **Fail-fast input validation** — Configuration, sender/recipient addresses, subjects, filenames, MIME types, and attachment payloads are validated before MSAL or `fetch` is touched; control characters are rejected to prevent header injection.
- **Attachment size guard** — Direct Graph attachments are capped at `MAX_DIRECT_ATTACHMENT_BYTES` (3 MiB − 1) per message; larger payloads require Graph upload sessions and are rejected with a validation error.
- **Bounded, non-leaking errors** — Failure messages contain only stable text plus an HTTP status, and include a `Retry-After` delay when Graph throttles with HTTP 429.
- **Honest delivery semantics** — A successful `send()` means Graph returned HTTP 202 and accepted the recipients for asynchronous processing; no message identifier is invented.
- **Lifecycle-aware** — `health()` verifies that an access token can be acquired, and `shutdown()` is an intentional no-op because neither MSAL nor `fetch` retains a disposable transport.

---

## When To Use

Use this package when any of the following apply:

- Your backend runs on Node.js >= 22 and must send transactional or notification email from a server-side application, worker, or scheduled job.
- Your organization already uses **Microsoft 365 / Entra ID (Azure AD)** and can grant the Microsoft Graph `Mail.Send` application permission with admin consent.
- Outbound SMTP is blocked, rate-limited, or disabled — for example, tenants where Exchange Online basic authentication and SMTP AUTH are turned off.
- You want email delivery behind the provider-agnostic `MailProvider` contract so the transport can be swapped without changing application code.
- You are building a **WebAFX** application and want the mailer registered as a container-managed singleton via `azureMailPlugin()`.
- You need to send as a single, fixed Exchange Online mailbox (`senderMailbox`) rather than as an interactive signed-in user.

Choose a different provider, or a different approach, when:

- You need final delivery confirmation, bounce handling, or a Graph message identifier — Graph `sendMail` returns only HTTP 202 and this provider deliberately reports no identifier.
- You must send attachments larger than 3 MiB, which requires the Graph draft + upload-session workflow and broader mailbox permissions.
- You need delegated (per-user) sending instead of app-only credentials.
- You need SMTP-specific behavior or a non-Microsoft transport — use another `blendsdk/webafx-mailer-*` provider.

---

## Architecture

The package is a layered adapter with no state beyond the frozen configuration and the MSAL client:

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ WebAFX application                                                       │
│   app.use(azureMailPlugin(config)) ────────────────► mailer (singleton)  │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ MailMessage
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ AzureMailProvider (extends MailProvider)                                 │
│   buildGraphRequest()  → validate + map to Graph JSON model              │
│   acquireAccessToken() → MSAL client credentials                         │
│   fetch() POST /users/{senderMailbox}/sendMail (30 s timeout)            │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ HTTPS (application/json)
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Microsoft Graph v1.0 ──► Exchange Online mailbox ──► recipient servers   │
│   HTTP 202 Accepted → MailResult { accepted, rejected: [] }              │
└──────────────────────────────────────────────────────────────────────────┘
```

| Layer | Component | Responsibility |
| --- | --- | --- |
| Public API | `src/index.ts` | Single entry point exporting `AzureMailProvider`, `azureMailPlugin`, `AzureMailConfig`, and `MAX_DIRECT_ATTACHMENT_BYTES` |
| WebAFX integration | `azureMailPlugin()` | Convenience factory over `createMailPlugin()`; registers the provider as a singleton under `mailer` (priority 30) |
| Provider | `AzureMailProvider` | Implements the common `MailProvider` lifecycle: `send()`, `health()`, `shutdown()` |
| Request builder | `buildGraphRequest()` and mapping helpers | Validates and maps `MailMessage` into the Graph JSON `sendMail` body |
| Authentication | `ConfidentialClientApplication` (MSAL) | App-only token acquisition and caching for the `.default` Graph scope |
| Transport | `fetch` + `AbortSignal.timeout` | HTTPS POST with a 30-second bound; HTTP 202 is the only success status |

**Key design patterns**

- **Adapter** — `AzureMailProvider` adapts the provider-neutral `MailMessage`/`MailResult` contract onto the Microsoft Graph JSON model (`GraphMessage`, `GraphSendMailRequest`).
- **Factory + Plugin** — `azureMailPlugin()` is a factory that produces a WebAFX plugin definition, keeping registration boilerplate out of application code.
- **Strategy (via the base contract)** — Applications depend on `MailProvider`, not on `AzureMailProvider`, so the Graph implementation is interchangeable with other providers.
- **Singleton lifecycle** — The plugin registers one provider instance per application; `health()`, `send()`, and `shutdown()` are all instance methods with no per-call setup.
- **Fail-fast validation pipeline** — Pure, dependency-free helpers (`validateConfig`, `parseMailbox`, `validateSubject`, `mapAttachments`, and friends) reject malformed or hostile input before any credential or network operation.
- **Information hiding** — All catch blocks collapse external failures into bounded, stable error messages; MSAL internals, tokens, and Graph response bodies are never surfaced.

---

## Dependencies

| Kind | Package / Runtime | Version | Role |
| --- | --- | --- | --- |
| Direct dependency | `@azure/msal-node` | `^5.6.0` | `ConfidentialClientApplication` for app-only tokens (typically installed as an optional peer of the umbrella distribution) |
| Peer dependency | `blendsdk/webafx-mailer` | `^5.x` | Supplies `MailProvider`, `MailProviderConfig`, `MailMessage`, `MailAttachment`, `MailResult`, and `createMailPlugin` |
| Runtime | Node.js | `>= 22.0.0` | Required for global `fetch`, `AbortSignal.timeout`, and `Buffer` |
| Language | TypeScript | 5.x / 7.x toolchain | Strict mode, ESM-first output (`"type": "module"`) |

**Consumed by**

- `blendsdk/webafx` — WebAFX applications install the plugin with `app.use(azureMailPlugin(config))` and resolve the provider through the service container.
- The `blendsdk` umbrella package — re-exports this module, so public installation is:

```bash
yarn add blendsdk @azure/msal-node
```

**External prerequisites (not npm packages)**

- An Entra application registration with the Microsoft Graph `Mail.Send` **application** permission and admin consent.
- Exchange Online Application RBAC scoping that permission to the configured `senderMailbox`.
- Network access to `login.microsoftonline.com` and `graph.microsoft.com`.

---

## Minimum Example

Standalone usage — no WebAFX application required. The same configuration object is accepted by `azureMailPlugin()`.

```typescript
import { AzureMailProvider } from 'blendsdk/webafx-mailer-azure';

const mailer = new AzureMailProvider({
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  senderMailbox: 'notifications@example.com',
});

try {
  const result = await mailer.send({
    from: 'Notifications <notifications@example.com>',
    to: 'customer@example.com',
    subject: 'Welcome',
    text: 'Welcome to our service.',
  });

  console.log(`Accepted: ${result.accepted.join(', ')}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}
```

A successful `send()` returns `{ accepted: ['customer@example.com'], rejected: [] }` after Graph responds with HTTP 202. Rejections (invalid configuration, sender/recipient mismatch, injection attempts, oversized attachments, throttling, or authentication failure) throw an `Error` before or instead of a network request, as covered in the remaining documents of this training set.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
