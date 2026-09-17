# @blendsdk/webafx-mailer

Email sending plugin for WebAFX with SMTP and In-Memory backends.

## Overview

Provides an email sending abstraction with two backends:

- **SmtpMailProvider** — sends emails via SMTP using [nodemailer](https://nodemailer.com)
- **MemoryMailProvider** — stores messages in-memory for testing (no emails sent)

Both integrate with WebAFX via plugin factory functions that register providers as singleton services with health check and graceful shutdown support.

## Installation

```bash
yarn add @blendsdk/webafx-mailer
```

## Quick Start

### Production (SMTP)

```typescript
import { WebApplication } from "@blendsdk/webafx";
import { smtpMailPlugin } from "@blendsdk/webafx-mailer";

const app = new WebApplication();

app.use(smtpMailPlugin({
    host: process.env.SMTP_HOST!,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
        user: process.env.SMTP_USER!,
        pass: process.env.SMTP_PASS!,
    },
}));
```

### Testing (Memory)

```typescript
import { WebApplication } from "@blendsdk/webafx";
import { memoryMailPlugin, MemoryMailProvider } from "@blendsdk/webafx-mailer";

const app = new WebApplication();
app.use(memoryMailPlugin());

// In tests, retrieve the provider to inspect sent messages:
const mailer = await services.get<MemoryMailProvider>("mailer");
const sent = mailer.getSentMessages();
expect(sent).toHaveLength(1);
expect(sent[0].message.to).toBe("user@example.com");
```

### Environment-Based Backend Switching

```typescript
import { createMailProvider, createMailPlugin } from "@blendsdk/webafx-mailer";

const mailer = createMailProvider({
    type: process.env.NODE_ENV === "production" ? "smtp" : "memory",
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
});

app.use(createMailPlugin(mailer));
```

## Sending Emails

```typescript
import type { MailProvider } from "@blendsdk/webafx-mailer";

// In a controller or middleware:
const mailer = await req.services.get<MailProvider>("mailer");

const result = await mailer.send({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Welcome!",
    html: "<h1>Welcome to our service!</h1>",
    text: "Welcome to our service!",
});

console.log("Accepted:", result.accepted);
console.log("Message ID:", result.messageId);
```

### Sending with Attachments

```typescript
await mailer.send({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Your Report",
    text: "Please find your report attached.",
    attachments: [
        {
            filename: "report.pdf",
            content: pdfBuffer,
            contentType: "application/pdf",
        },
    ],
});
```

### Sending to Multiple Recipients

```typescript
await mailer.send({
    from: "noreply@example.com",
    to: ["alice@example.com", "bob@example.com"],
    cc: "manager@example.com",
    bcc: "archive@example.com",
    subject: "Team Update",
    html: "<p>Weekly update for the team.</p>",
});
```

## Standalone Usage (Without WebAFX)

The providers can be used directly without the WebAFX plugin system:

```typescript
import { SmtpMailProvider } from "@blendsdk/webafx-mailer";

const mailer = new SmtpMailProvider({
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "user@example.com", pass: "secret" },
});

await mailer.send({
    from: "sender@example.com",
    to: "recipient@example.com",
    subject: "Hello",
    text: "Hello, world!",
});

// Health check
const healthy = await mailer.health();

// Graceful shutdown
await mailer.shutdown();
```

## API Reference

### Types

| Type | Description |
|------|-------------|
| `MailMessage` | Email message (from, to, subject, text/html, attachments) |
| `MailResult` | Send result (accepted, rejected, messageId) |
| `MailAttachment` | File attachment (filename, content, contentType) |
| `SmtpMailConfig` | SMTP connection settings |
| `MemoryMailConfig` | Memory provider settings |
| `MailFactoryConfig` | Factory config with type discriminator |

### Classes

| Class | Description |
|-------|-------------|
| `MailProvider` | Abstract base class for all backends |
| `SmtpMailProvider` | SMTP backend via nodemailer |
| `MemoryMailProvider` | In-memory backend for testing |

### Plugin Factories

| Function | Description |
|----------|-------------|
| `createMailPlugin(provider)` | Core: wires any MailProvider into WebAFX |
| `smtpMailPlugin(config)` | One-liner SMTP plugin registration |
| `memoryMailPlugin(config?)` | One-liner Memory plugin registration |
| `createMailProvider(config)` | Type-discriminated provider factory |

### MemoryMailProvider Helpers

| Method | Description |
|--------|-------------|
| `getSentMessages()` | Returns all stored messages (copy) |
| `getLastMessage()` | Returns the most recently sent message |
| `clear()` | Clears all stored messages |

## Testing

```bash
# Fast tests — Memory provider only, no Docker required
yarn test:fast

# Full tests — includes SMTP integration tests via Mailpit Docker
yarn test
```

### Docker (Mailpit)

SMTP integration tests use [Mailpit](https://mailpit.axllent.org/) as a fake SMTP server:

```bash
# Start Mailpit manually
docker-compose -p webafx-mailer -f ./docker/docker-compose.yml up -d

# Mailpit Web UI: http://localhost:8025
# SMTP server: localhost:1025
```

## License

MIT
