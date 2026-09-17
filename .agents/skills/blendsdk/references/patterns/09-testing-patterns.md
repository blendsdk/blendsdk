# Testing Patterns

> Test WebAFX controllers, services, and plugins with Vitest and supertest.

**Packages:** `webafx`, `vitest`, `supertest`

---

## Problem

How do I test my WebAFX controllers, services, and plugins effectively?

## Solution

### Basic Controller Test

```typescript
import { describe, test, expect, afterEach } from 'vitest';
import supertest from 'supertest';
import { WebApplication, BaseController } from 'blendsdk/webafx';
import { Request, Response } from 'express';

class HelloController extends BaseController {
  routes() {
    return [this.route().get('/').handle(this.hello)];
  }
  async hello(req: Request, res: Response) {
    this.ok(res, { message: 'Hello' });
  }
}

describe('HelloController', () => {
  let shutdown: () => Promise<void>;
  afterEach(async () => { if (shutdown) await shutdown(); });

  test('GET / returns 200', async () => {
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
    app.registerController('/api', HelloController);
    shutdown = await app.start();

    const res = await supertest(app.express).get('/api').expect(200);
    expect(res.body).toEqual({ success: true, data: { message: 'Hello' } });
  });
});
```

### Testing Authenticated Routes

```typescript
test('secure route returns 401 without auth', async () => {
  const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
  app.registerService({ name: 'user', type: 'per-request', factory: async () => null });
  app.registerController('/api', SecureController);
  shutdown = await app.start();

  await supertest(app.express).get('/api/profile').expect(401);
});

test('secure route returns 200 with user', async () => {
  const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
  app.registerService({
    name: 'user',
    type: 'per-request',
    factory: async () => ({ id: '1', role: 'admin' }),
  });
  app.registerController('/api', SecureController);
  shutdown = await app.start();

  await supertest(app.express).get('/api/profile').expect(200);
});

test('admin route returns 403 for non-admin', async () => {
  const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
  app.registerService({
    name: 'user',
    type: 'per-request',
    factory: async () => ({ id: '1', role: 'user' }),
  });
  app.registerController('/api', AdminController);
  shutdown = await app.start();

  await supertest(app.express).get('/api/admin').expect(403);
});
```

### Testing Validation

```typescript
import { z } from 'zod';

test('invalid data returns 422 with details', async () => {
  const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
  app.registerController('/api', ValidatedController);
  shutdown = await app.start();

  const res = await supertest(app.express)
    .post('/api')
    .send({ name: '', email: 'not-an-email' })
    .expect(422);

  expect(res.body.success).toBe(false);
  expect(res.body.error.code).toBe('VALIDATION_ERROR');
  expect(res.body.error.details).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: 'email' }),
    ])
  );
});
```

### Testing Error Handling

```typescript
test('NotFoundError returns 404', async () => {
  const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
  app.registerController('/api', ErrorController);
  shutdown = await app.start();

  const res = await supertest(app.express).get('/api/missing').expect(404);
  expect(res.body.error.code).toBe('NOT_FOUND');
});

test('unknown route returns 404', async () => {
  const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
  shutdown = await app.start();

  await supertest(app.express).get('/nonexistent').expect(404);
});
```

### Testing Plugins

```typescript
test('plugin health check', async () => {
  const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
  app.use({
    name: 'test-plugin',
    factory: async () => ({ health: async () => true }),
  });
  shutdown = await app.start();

  const res = await supertest(app.express).get('/health').expect(200);
  expect(res.body.health).toBe(true);
});

test('unhealthy plugin returns 503', async () => {
  const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
  app.use({
    name: 'broken',
    factory: async () => ({ health: async () => false }),
  });
  shutdown = await app.start();

  await supertest(app.express).get('/health').expect(503);
});
```

### Test Helper for Reuse

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { PluginDefinition, ServiceDefinition } from 'blendsdk/webafx';
import supertest from 'supertest';

export async function createTestApp(options: {
  controllers?: Array<{ path: string; controller: new (...args: any[]) => BaseController }>;
  plugins?: PluginDefinition[];
  services?: ServiceDefinition[];
  user?: unknown;
}) {
  const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });

  if (options.user !== undefined) {
    app.registerService({ name: 'user', type: 'per-request', factory: async () => options.user });
  }
  for (const svc of options.services || []) app.registerService(svc);
  for (const plugin of options.plugins || []) app.use(plugin);
  for (const { path, controller } of options.controllers || []) {
    app.registerController(path, controller);
  }

  const shutdown = await app.start();
  return { app, request: supertest(app.express), shutdown };
}

// Usage:
test('with helper', async () => {
  const { request, shutdown: s } = await createTestApp({
    controllers: [{ path: '/api', controller: MyController }],
    user: { id: '1', role: 'admin' },
  });
  shutdown = s;

  await request.get('/api').expect(200);
});
```

## Key Points

- **`PORT: 0`** — OS assigns a random available port (prevents conflicts in parallel tests)
- **`ENV_MODE: 'test'`** — enables stack traces in errors, fast shutdown (1 second)
- **Always call `shutdown()` in `afterEach`** — prevents port leaks and hanging tests
- Each **`WebApplication` instance is fully isolated** — no shared state between tests
- Mock auth by registering a test `user` per-request service returning your test data
- Use **`supertest(app.express)`** — no need to know the actual port
- Test response format: `{ success: true, data: T }` for success, `{ success: false, error: {...} }` for errors
