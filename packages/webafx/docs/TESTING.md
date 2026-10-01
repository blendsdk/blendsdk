# Testing Patterns

> **Package**: `@blendsdk/webafx`
> **Back to**: [README](../README.md)

## Overview

WebAFX applications are tested using Vitest and supertest. Each `WebApplication` instance is fully isolated — you can create multiple test apps in parallel without state leakage.

## Setup

```bash
yarn add -D vitest supertest @types/supertest
```

## Testing Controllers

### Basic Controller Test

```typescript
import { describe, test, expect, afterEach } from 'vitest';
import supertest from 'supertest';
import { WebApplication, BaseController } from '@blendsdk/webafx';
import { Request, Response } from 'express';

class HelloController extends BaseController {
  routes() {
    return [
      this.route().get('/').handle(this.hello),
    ];
  }
  async hello(req: Request, res: Response) {
    this.ok(res, { message: 'Hello!' });
  }
}

describe('HelloController', () => {
  let shutdown: () => Promise<void>;

  afterEach(async () => {
    if (shutdown) await shutdown();
  });

  test('GET / returns 200 with message', async () => {
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
    app.registerController('/api/hello', HelloController);
    shutdown = await app.start();

    const res = await supertest(app.express)
      .get('/api/hello/')
      .expect(200);

    expect(res.body).toEqual({
      success: true,
      data: { message: 'Hello!' },
    });
  });
});
```

**Key points**:
- Use `PORT: 0` for random port assignment (avoids conflicts)
- Use `ENV_MODE: 'test'` for test-appropriate behavior
- Always call `shutdown()` in `afterEach` to clean up
- Access the Express app via `app.express` for supertest

### Testing Validation

```typescript
import { z } from 'zod';

class UserController extends BaseController {
  routes() {
    return [
      this.route()
        .post('/')
        .validate(z.object({
          name: z.string().min(1),
          email: z.string().email(),
        }))
        .handle(this.create),
    ];
  }
  async create(req: Request, res: Response) {
    const params = req.services.getParams();
    this.created(res, params);
  }
}

test('POST / with valid data returns 201', async () => {
  const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
  app.registerController('/api/users', UserController);
  shutdown = await app.start();

  const res = await supertest(app.express)
    .post('/api/users/')
    .send({ name: 'Alice', email: 'alice@test.com' })
    .expect(201);

  expect(res.body.success).toBe(true);
  expect(res.body.data.name).toBe('Alice');
});

test('POST / with invalid data returns 422', async () => {
  const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
  app.registerController('/api/users', UserController);
  shutdown = await app.start();

  const res = await supertest(app.express)
    .post('/api/users/')
    .send({ name: '', email: 'not-an-email' })
    .expect(422);

  expect(res.body.success).toBe(false);
  expect(res.body.error.code).toBe('VALIDATION_ERROR');
});
```

### Testing Authentication

```typescript
test('secured route returns 401 without auth', async () => {
  const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
  app.registerController('/api/profile', ProfileController);
  shutdown = await app.start();

  await supertest(app.express)
    .get('/api/profile/')
    .expect(401);
});

test('secured route returns 200 with valid auth', async () => {
  const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });

  // Register auth plugin that sets user from header
  app.use({
    name: 'test-auth',
    priority: 10,
    factory: async ({ express }) => {
      express.use((req, res, next) => {
        const userId = req.headers['x-test-user'] as string;
        if (userId) {
          req.services.set('user', { id: userId, role: 'admin' });
        }
        next();
      });
    },
  });

  app.registerController('/api/profile', ProfileController);
  shutdown = await app.start();

  const res = await supertest(app.express)
    .get('/api/profile/')
    .set('X-Test-User', 'user-123')
    .expect(200);

  expect(res.body.success).toBe(true);
});
```

### Testing Authorization

```typescript
test('admin-only route returns 403 for regular user', async () => {
  const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });

  app.use({
    name: 'test-auth',
    priority: 10,
    factory: async ({ express }) => {
      express.use((req, res, next) => {
        req.services.set('user', { id: '1', role: 'user' }); // Not admin
        next();
      });
    },
  });

  app.registerController('/api/admin', AdminController);
  shutdown = await app.start();

  await supertest(app.express)
    .delete('/api/admin/users/123')
    .expect(403);
});
```

## Testing Services

```typescript
import { ServiceContainer, ServiceDefinition } from '@blendsdk/webafx';

test('singleton service is created once', async () => {
  let callCount = 0;
  const registry = { definitions: {}, singletons: {} };
  const settings = new ApplicationSettings({ ENV_MODE: 'test' });
  const container = new ServiceContainer(registry, settings);

  container.registerService({
    name: 'counter',
    type: 'singleton',
    factory: () => ++callCount,
  });

  const first = await container.get('counter');
  const second = await container.get('counter');

  expect(first).toBe(1);
  expect(second).toBe(1); // Same instance
  expect(callCount).toBe(1);
});

test('circular dependency throws error', async () => {
  const registry = { definitions: {}, singletons: {} };
  const settings = new ApplicationSettings({ ENV_MODE: 'test' });
  const container = new ServiceContainer(registry, settings);

  container.registerService({
    name: 'a',
    type: 'singleton',
    dependencies: ['b'],
    factory: async (c) => await c.get('b'),
  });
  container.registerService({
    name: 'b',
    type: 'singleton',
    dependencies: ['a'],
    factory: async (c) => await c.get('a'),
  });

  await expect(container.get('a')).rejects.toThrow('Circular dependency');
});
```

## Testing Plugins

```typescript
test('plugin installs and provides health check', async () => {
  const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });

  app.use({
    name: 'test-plugin',
    factory: async ({ logger }) => {
      await logger.info('Test plugin installed');
      return {
        health: async () => true,
        shutdown: async () => {},
      };
    },
  });

  shutdown = await app.start();

  const res = await supertest(app.express)
    .get('/health')
    .expect(200);

  expect(res.body.health).toBe(true);
});
```

## Testing Error Handling

```typescript
test('unknown route returns 404', async () => {
  const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
  shutdown = await app.start();

  const res = await supertest(app.express)
    .get('/nonexistent')
    .expect(404);

  expect(res.body.success).toBe(false);
  expect(res.body.error.code).toBe('NOT_FOUND');
});

test('thrown errors return structured response', async () => {
  class ErrorController extends BaseController {
    routes() {
      return [
        this.route().get('/').handle(this.fail),
      ];
    }
    async fail() {
      throw new ConflictError('Already exists');
    }
  }

  const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
  app.registerController('/api/error', ErrorController);
  shutdown = await app.start();

  const res = await supertest(app.express)
    .get('/api/error/')
    .expect(409);

  expect(res.body.error.code).toBe('CONFLICT');
  expect(res.body.error.message).toBe('Already exists');
});
```

## Test Isolation

Each `WebApplication` instance owns its own service registry. Tests run in complete isolation:

```typescript
// These can run in parallel — no shared state
test('app 1', async () => {
  const app1 = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
  app1.registerService({ name: 'db', type: 'singleton', factory: () => 'db1' });
  // ...
});

test('app 2', async () => {
  const app2 = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
  app2.registerService({ name: 'db', type: 'singleton', factory: () => 'db2' });
  // ...
});
```

## Test Commands

```bash
# Run webafx tests
clear && yarn workspace @blendsdk/webafx test:fast

# Run all tests
clear && yarn build && yarn test
```

---

**Back to**: [README](../README.md) | **Prev**: [Middleware](./MIDDLEWARE.md) | **Next**: [Architecture](./ARCHITECTURE.md)
