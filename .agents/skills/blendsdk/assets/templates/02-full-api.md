# Template: Full API

> **Complexity**: Intermediate
> **Packages Used**: webafx, postgresql, dbcore, expression, webafx-cache, webafx-auth, i18n
> **Docker**: PostgreSQL, Redis
> **Features**: CRUD, JWT auth, caching, i18n, validation, pagination, health checks

## Overview

A complete REST API with PostgreSQL database, Redis caching, JWT authentication, internationalization, and production-ready middleware. This is the recommended starting point for most API projects.

## Prerequisites

- Node.js >= 22.0.0
- Docker (for PostgreSQL and Redis)
- Yarn or npm

## Project Structure

```
{{PROJECT_NAME}}/
├── src/
│   ├── index.ts                        # Application entry point
│   ├── plugins/
│   │   └── jwt-auth-plugin.ts          # JWT authentication plugin
│   ├── controllers/
│   │   ├── auth-controller.ts          # Login/register endpoints
│   │   └── product-controller.ts       # CRUD example controller
│   └── services/
│       └── product-service.ts          # Business logic layer
├── docker/
│   └── docker-compose.yml              # PostgreSQL + Redis
├── package.json
├── tsconfig.json
├── .env.js
├── .env.local.js.example
└── .gitignore
```

## File: package.json

```json
{
  "name": "{{PROJECT_NAME}}",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "docker:up": "docker compose -f docker/docker-compose.yml up -d",
    "docker:down": "docker compose -f docker/docker-compose.yml down"
  },
  "dependencies": {
    "blendsdk": "^5.x",
    "express": "^5.0.0",
    "cookie-parser": "^1.4.0",
    "cors": "^2.8.0",
    "helmet": "^8.0.0",
    "jose": "^6.0.0",
    "pg": "^8.18.0",
    "yesql": "^7.0.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.21.0",
    "typescript": "^5.9.0",
    "vitest": "^4.1.0",
    "supertest": "^7.0.0",
    "@types/supertest": "^6.0.0"
  }
}
```

## File: tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

## File: docker/docker-compose.yml

```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB: {{PROJECT_NAME}}
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  pgdata:
```

## File: .env.js

```javascript
export default {
  PORT: 3000,
  ENV_MODE: 'development',
  LOG_LEVEL: 'INFO',
  CORS: true,
  DB_HOST: 'localhost',
  DB_PORT: 5432,
  DB_NAME: '{{PROJECT_NAME}}',
  DB_USER: 'postgres',
  DB_PASSWORD: 'postgres',
  REDIS_HOST: 'localhost',
  REDIS_PORT: 6379,
  JWT_SECRET: 'dev-secret-change-in-production',
};
```

## File: src/plugins/jwt-auth-plugin.ts

```typescript
import type { PluginDefinition } from 'blendsdk/webafx';
import { SignJWT, jwtVerify } from 'jose';

interface JwtPayload {
  sub: string;
  email: string;
  role: string;
}

export const jwtAuthPlugin: PluginDefinition = {
  name: 'jwt-auth',
  priority: 10,

  factory: async ({ app, logger }) => {
    const settings = app.getSettings();
    const secret = new TextEncoder().encode(
      settings.get<string>('JWT_SECRET', 'dev-secret')
    );

    app.registerService({
      name: 'user',
      type: 'per-request',
      factory: async (container, settings, req) => {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) return null;

        try {
          const { payload } = await jwtVerify(authHeader.slice(7), secret);
          return {
            id: payload.sub,
            email: payload.email as string,
            role: payload.role as string,
          };
        } catch {
          return null;
        }
      },
    });

    await logger.info('JWT Auth plugin ready');
    return { health: async () => true };
  },
};

export async function generateToken(
  payload: JwtPayload,
  jwtSecret: string
): Promise<string> {
  const secret = new TextEncoder().encode(jwtSecret);
  return new SignJWT({ email: payload.email, role: payload.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setExpirationTime('24h')
    .sign(secret);
}
```

## File: src/controllers/auth-controller.ts

```typescript
import { BaseController, UnauthorizedError } from 'blendsdk/webafx';
import { Request, Response } from 'express';
import { z } from 'zod';
import { generateToken } from '../plugins/jwt-auth-plugin.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export class AuthController extends BaseController {
  routes() {
    return [
      this.route().post('/login').validate(loginSchema).handle(this.login),
      this.authenticated().get('/me').handle(this.getMe),
    ];
  }

  async login(req: Request, res: Response) {
    const { email, password } = req.services.getParams<{ email: string; password: string }>();

    // TODO: Replace with real DB lookup
    if (email !== 'admin@example.com' || password !== 'password') {
      throw new UnauthorizedError('Invalid credentials');
    }

    const secret = this.settings.get<string>('JWT_SECRET', 'dev-secret');
    const token = await generateToken({ sub: '1', email, role: 'admin' }, secret);
    this.ok(res, { token, expiresIn: '24h' });
  }

  async getMe(req: Request, res: Response) {
    this.ok(res, req.services.getUser());
  }
}
```

## File: src/controllers/product-controller.ts

```typescript
import { BaseController, NotFoundError } from 'blendsdk/webafx';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { query } from 'blendsdk/expression';
import type { CacheProvider } from 'blendsdk/webafx-cache';
import { Request, Response } from 'express';
import { z } from 'zod';

const createSchema = z.object({
  name: z.string().min(1).max(255),
  price: z.number().positive(),
});

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export class ProductController extends BaseController {
  routes() {
    return [
      this.route().get('/').validate(listSchema).handle(this.list),
      this.route().get('/:id').handle(this.getById),
      this.route().post('/').secure().validate(createSchema).handle(this.create),
      this.authenticated().delete('/:id')
        .authorize(async (req, user) => user?.role === 'admin')
        .handle(this.remove),
    ];
  }

  async list(req: Request, res: Response) {
    const { page, limit } = req.services.getParams<{ page: number; limit: number }>();
    const db = await req.services.get<PostgreSQLDatabase>('db');
    const offset = (page - 1) * limit;

    const data = await db.executeQuery<{ id: number; name: string; price: number }>(
      'SELECT * FROM products ORDER BY id LIMIT :limit OFFSET :offset',
      { limit, offset }
    );
    const countResult = await db.executeQuery<{ total: string }>(
      'SELECT COUNT(*) as total FROM products'
    );
    const total = Number(countResult.records[0]?.total ?? 0);
    this.paginated(res, data.records, total, page, limit);
  }

  async getById(req: Request, res: Response) {
    const { id } = req.services.getParams<{ id: string }>();
    const cache = await req.services.get<CacheProvider>('cache');

    const product = await cache.getOrSet(`product:${id}`, async () => {
      const db = await req.services.get<PostgreSQLDatabase>('db');
      const filter = query().where('id').equals(id).compile();
      const result = await db.from('products').select().byExpression(filter).execute();
      if (!result || result.records.length === 0) {
        throw new NotFoundError(`Product ${id} not found`);
      }
      return result.records[0];
    }, 300);

    this.ok(res, product);
  }

  async create(req: Request, res: Response) {
    const params = req.services.getParams<{ name: string; price: number }>();
    const db = await req.services.get<PostgreSQLDatabase>('db');
    const result = await db.insert('products').values(params).returning('*').execute();
    this.created(res, result!.records[0]);
  }

  async remove(req: Request, res: Response) {
    const { id } = req.services.getParams<{ id: string }>();
    const db = await req.services.get<PostgreSQLDatabase>('db');
    const cache = await req.services.get<CacheProvider>('cache');

    const result = await db.delete('products')
      .filterByExpression(q => q.where('id').equals(id))
      .execute();
    if (!result || result.rowCount === 0) {
      throw new NotFoundError(`Product ${id} not found`);
    }

    await cache.delete(`product:${id}`);
    this.noContent(res);
  }
}
```

## File: src/index.ts

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { redisCachePlugin } from 'blendsdk/webafx-cache';
import { jwtAuthPlugin } from './plugins/jwt-auth-plugin.js';
import { AuthController } from './controllers/auth-controller.js';
import { ProductController } from './controllers/product-controller.js';

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'development',
  LOG_LEVEL: 'INFO',
  CORS: true,
});

// Database service
app.registerService({
  name: 'db',
  type: 'singleton',
  factory: async (container, settings) => {
    const db = new PostgreSQLDatabase({
      host: settings.get('DB_HOST', 'localhost'),
      port: settings.get('DB_PORT', 5432),
      database: settings.get('DB_NAME', '{{PROJECT_NAME}}'),
      user: settings.get('DB_USER', 'postgres'),
      pass: settings.get('DB_PASSWORD', 'postgres'),
    });
    await db.connect();
    return db;
  },
  dispose: async (db) => await db.disconnect(),
});

// Plugins
app.use(jwtAuthPlugin);
app.use(redisCachePlugin({
  rootKey: '{{PROJECT_NAME}}',
  host: 'localhost',
  port: 6379,
  defaultTTL: 300,
}));

// Controllers
app.registerController('/api/auth', AuthController);
app.registerController('/api/products', ProductController);

const shutdown = await app.start();
```

## Post-Setup Instructions

```bash
# Start Docker services
yarn docker:up

# Install dependencies
yarn install

# Create the products table (run manually in psql)
# CREATE TABLE products (
#   id SERIAL PRIMARY KEY,
#   name VARCHAR(255) NOT NULL,
#   price NUMERIC(10,2) NOT NULL,
#   created_at TIMESTAMP DEFAULT NOW()
# );

# Start development server
yarn dev
```

## Customization Guide

1. **Add more controllers** — Follow the `ProductController` pattern
2. **Replace auth** — Swap the stub in `AuthController.login` with real DB lookups
3. **Add i18n** — Install `webafx-i18n` plugin for multi-language support
4. **Add email** — Install `webafx-mailer` plugin for transactional emails
5. **Switch cache** — Use `memoryCachePlugin()` for development without Redis
