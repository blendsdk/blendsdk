# Authentication (JWT) Pattern

> Implement JWT-based authentication with role-based authorization.

**Packages:** `webafx`, `webafx-auth`

---

## Problem

How do I add JWT authentication to a WebAFX application with role-based access control?

## Solution

### Using webafx-auth Plugin

```typescript
import { WebApplication, BaseController, UnauthorizedError } from 'blendsdk/webafx';
import { JwtAuthProvider } from 'blendsdk/webafx-auth';
import { Request, Response } from 'express';
import { z } from 'zod';

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'development',
  JWT_SECRET: 'your-secret-key',
});

// Register the JWT auth provider as a plugin
const jwtProvider = new JwtAuthProvider({
  secret: 'your-secret-key',
  issuer: 'my-app',
  expiresIn: '24h',
});

// Register user resolution as a per-request service
app.registerService({
  name: 'user',
  type: 'per-request',
  factory: async (container, settings, req) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return null;
    try {
      return await jwtProvider.verify(token);
    } catch {
      return null;
    }
  },
});
```

### Login Controller

```typescript
class AuthController extends BaseController {
  routes() {
    return [
      this.route()
        .post('/login')
        .validate(z.object({
          email: z.string().email(),
          password: z.string().min(1),
        }))
        .handle(this.login),

      this.route().get('/me').secure().handle(this.getMe),
    ];
  }

  async login(req: Request, res: Response) {
    const { email, password } = req.services.getParams<{ email: string; password: string }>();

    // Validate credentials against your database
    const db = await req.services.get('db');
    const user = await findUserByCredentials(db, email, password);
    if (!user) throw new UnauthorizedError('Invalid credentials');

    const token = jwtProvider.sign({ sub: user.id, email, role: user.role });
    this.ok(res, { token, expiresIn: '24h' });
  }

  async getMe(req: Request, res: Response) {
    const user = req.services.getUser();
    this.ok(res, user);
  }
}

app.registerController('/api/auth', AuthController);
```

### Role-Based Authorization

```typescript
function requireRole(...roles: string[]) {
  return async (req: Request, user: any): Promise<boolean> => {
    return user && roles.includes(user.role);
  };
}

class AdminController extends BaseController {
  routes() {
    return [
      // Admin-only route
      this.authenticated()
        .get('/dashboard')
        .authorize(requireRole('admin'))
        .handle(this.dashboard),

      // Admin or manager
      this.authenticated()
        .get('/reports')
        .authorize(requireRole('admin', 'manager'))
        .handle(this.reports),

      // Owner or admin
      this.authenticated()
        .put('/users/:id')
        .authorize(async (req, user) => {
          if (user?.role === 'admin') return true;
          const { id } = req.services.getParams<{ id: string }>();
          return user?.id === id;
        })
        .handle(this.updateUser),
    ];
  }

  async dashboard(req: Request, res: Response) { this.ok(res, { stats: {} }); }
  async reports(req: Request, res: Response) { this.ok(res, { reports: [] }); }
  async updateUser(req: Request, res: Response) { this.ok(res, {}); }
}
```

### Testing with Memory Auth Provider

```typescript
import { MemoryAuthProvider } from 'blendsdk/webafx-auth';
import { describe, test, expect, afterEach } from 'vitest';
import supertest from 'supertest';

describe('Auth Routes', () => {
  let shutdown: () => Promise<void>;
  afterEach(async () => { if (shutdown) await shutdown(); });

  test('secure route returns 401 without auth', async () => {
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
    app.registerService({
      name: 'user',
      type: 'per-request',
      factory: async () => null,
    });
    app.registerController('/api/auth', AuthController);
    shutdown = await app.start();

    await supertest(app.express).get('/api/auth/me').expect(401);
  });

  test('secure route returns 200 with valid user', async () => {
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
    app.registerService({
      name: 'user',
      type: 'per-request',
      factory: async () => ({ id: '1', email: 'test@test.com', role: 'admin' }),
    });
    app.registerController('/api/auth', AuthController);
    shutdown = await app.start();

    const res = await supertest(app.express).get('/api/auth/me').expect(200);
    expect(res.body.data.email).toBe('test@test.com');
  });
});
```

## Key Points

- **`webafx-auth`** provides `JwtAuthProvider` and `MemoryAuthProvider`
- Register `user` as a **per-request** service that extracts token from `Authorization` header
- Use **`.secure()`** on routes that require authentication (returns 401 if no user)
- Use **`.authorize(fn)`** for role-based access (returns 403 if denied)
- **`this.authenticated()`** is shorthand for `this.route().secure()`
- In tests, register a mock `user` service returning test data
