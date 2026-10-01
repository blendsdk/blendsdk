# Email Sending Pattern

> Send emails with SMTP in production and test with in-memory backend.

**Packages:** `webafx-mailer`, `webafx`

---

## Problem

How do I send emails from my application with different backends for production and testing?

## Solution

### Production — SMTP

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { smtpMailPlugin } from 'blendsdk/webafx-mailer';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'production' });

app.use(smtpMailPlugin({
  host: process.env.SMTP_HOST!,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER!,
    pass: process.env.SMTP_PASS!,
  },
}));
```

### Development/Testing — Memory

```typescript
import { memoryMailPlugin } from 'blendsdk/webafx-mailer';

app.use(memoryMailPlugin());
// Emails stored in memory — no SMTP required
```

### Environment-Based Switching

```typescript
import { createMailProvider, createMailPlugin } from 'blendsdk/webafx-mailer';

const mailer = createMailProvider({
  type: process.env.NODE_ENV === 'production' ? 'smtp' : 'memory',
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
});

app.use(createMailPlugin(mailer));
```

### Sending Emails from Controllers

```typescript
import type { MailProvider } from 'blendsdk/webafx-mailer';
import { BaseController } from 'blendsdk/webafx';
import { Request, Response } from 'express';

class UserController extends BaseController {
  routes() {
    return [
      this.route().post('/register').handle(this.register),
    ];
  }

  async register(req: Request, res: Response) {
    const { email, name } = req.services.getParams<{ email: string; name: string }>();
    const mailer = await req.services.get<MailProvider>('mailer');

    // Create user in database...

    // Send welcome email
    const result = await mailer.send({
      from: 'noreply@myapp.com',
      to: email,
      subject: 'Welcome!',
      html: `<h1>Welcome, ${name}!</h1><p>Thanks for joining.</p>`,
      text: `Welcome, ${name}! Thanks for joining.`,
    });

    console.log('Accepted:', result.accepted);
    this.created(res, { email, message: 'Welcome email sent' });
  }
}
```

### Sending with Attachments

```typescript
await mailer.send({
  from: 'noreply@myapp.com',
  to: 'user@example.com',
  subject: 'Your Report',
  text: 'Please find your report attached.',
  attachments: [{
    filename: 'report.pdf',
    content: pdfBuffer,
    contentType: 'application/pdf',
  }],
});
```

### Testing Email Sending

```typescript
import { MemoryMailProvider } from 'blendsdk/webafx-mailer';
import { describe, test, expect, afterEach } from 'vitest';
import supertest from 'supertest';

describe('Registration', () => {
  let shutdown: () => Promise<void>;
  afterEach(async () => { if (shutdown) await shutdown(); });

  test('sends welcome email on registration', async () => {
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
    app.use(memoryMailPlugin());
    app.registerController('/api/users', UserController);
    shutdown = await app.start();

    await supertest(app.express)
      .post('/api/users/register')
      .send({ email: 'new@test.com', name: 'Alice' })
      .expect(201);

    // Inspect sent messages
    const mailer = await app.getSettings(); // access via service
    // Or get provider directly in test setup
  });
});

// Standalone test without WebAFX
test('MemoryMailProvider stores messages', async () => {
  const mailer = new MemoryMailProvider();

  await mailer.send({
    from: 'test@test.com',
    to: 'user@test.com',
    subject: 'Test',
    text: 'Hello',
  });

  const sent = mailer.getSentMessages();
  expect(sent).toHaveLength(1);
  expect(sent[0].message.to).toBe('user@test.com');
  expect(sent[0].message.subject).toBe('Test');

  mailer.clear(); // Reset for next test
});
```

## Key Points

- **`MailProvider`** is the abstract base — use `SmtpMailProvider` or `MemoryMailProvider`
- Service name defaults to **`'mailer'`** — access via `req.services.get('mailer')`
- **`MemoryMailProvider.getSentMessages()`** returns all stored messages for test assertions
- **`MemoryMailProvider.getLastMessage()`** returns the most recent message
- **`MemoryMailProvider.clear()`** resets stored messages between tests
- Always provide both **`html`** and **`text`** versions for email clients
- Docker integration tests use **Mailpit** (SMTP on port 1025, Web UI on port 8025)
