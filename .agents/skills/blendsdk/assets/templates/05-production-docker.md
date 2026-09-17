# Template: Production Docker

> **Complexity**: Advanced
> **Packages Used**: webafx, postgresql, dbcore, expression, webafx-cache
> **Docker**: PostgreSQL, Redis, multi-stage build
> **Features**: Multi-stage Docker build, production config, health checks, graceful shutdown, security hardening

## Overview

A production-ready Docker deployment with multi-stage builds, PostgreSQL, Redis, proper health checks, and security hardening. Designed for Kubernetes, Docker Swarm, or any container orchestrator.

## Prerequisites

- Node.js >= 22.0.0
- Docker and Docker Compose
- Yarn or npm

## Project Structure

```
{{PROJECT_NAME}}/
├── src/
│   ├── index.ts                        # Application entry point
│   └── controllers/
│       └── product-controller.ts       # Example controller
├── docker/
│   ├── docker-compose.yml              # Full stack (dev)
│   ├── docker-compose.prod.yml         # Production overrides
│   └── Dockerfile                      # Multi-stage build
├── package.json
├── tsconfig.json
├── .env.js                             # Production defaults
├── .env.local.js.example              # Local override template
├── .dockerignore
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
    "docker:dev": "docker compose -f docker/docker-compose.yml up -d",
    "docker:prod": "docker compose -f docker/docker-compose.yml -f docker/docker-compose.prod.yml up -d --build",
    "docker:down": "docker compose -f docker/docker-compose.yml down -v"
  },
  "dependencies": {
    "blendsdk": "^5.x",
    "express": "^5.0.0",
    "cookie-parser": "^1.4.0",
    "cors": "^2.8.0",
    "helmet": "^8.0.0",
    "pg": "^8.18.0",
    "yesql": "^7.0.0",
    "ioredis": "^5.9.0",
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

## File: docker/Dockerfile

```dockerfile
# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files first for layer caching
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=false

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN yarn build

# Remove dev dependencies
RUN yarn install --frozen-lockfile --production=true

# Stage 2: Production
FROM node:22-alpine AS production

# Security: run as non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

WORKDIR /app

# Copy only production artifacts
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/package.json ./

# Copy production config
COPY --chown=appuser:appgroup .env.js ./

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1

# Start the application
CMD ["node", "dist/index.js"]
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
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
```

## File: docker/docker-compose.prod.yml

```yaml
services:
  app:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    ports:
      - "4000:4000"
    environment:
      PORT: 4000
      ENV_MODE: production
      LOG_LEVEL: WARN
      DB_HOST: postgres
      DB_PORT: 5432
      DB_NAME: {{PROJECT_NAME}}
      DB_USER: postgres
      DB_PASSWORD: postgres
      REDIS_HOST: redis
      REDIS_PORT: 6379
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped
```

## File: .env.js

```javascript
export default {
  PORT: 4000,
  ENV_MODE: 'production',
  LOG_LEVEL: 'WARN',
  CORS: {
    origin: ['https://app.{{PROJECT_NAME}}.com'],
    credentials: true,
    maxAge: 86400,
  },
  TRUST_PROXY: true,
  BODY_LIMIT: '10mb',
  SHUTDOWN_TIMEOUT: 10,
  DB_HOST: process.env.DB_HOST || 'localhost',
  DB_PORT: Number(process.env.DB_PORT || 5432),
  DB_NAME: process.env.DB_NAME || '{{PROJECT_NAME}}',
  DB_USER: process.env.DB_USER || 'postgres',
  DB_PASSWORD: process.env.DB_PASSWORD || 'postgres',
  REDIS_HOST: process.env.REDIS_HOST || 'localhost',
  REDIS_PORT: Number(process.env.REDIS_PORT || 6379),
};
```

## File: .env.local.js.example

```javascript
// Copy to .env.local.js for local development overrides
export default {
  PORT: 3000,
  ENV_MODE: 'development',
  LOG_LEVEL: 'DEBUG',
  CORS: true,
};
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
}
```

## File: src/index.ts

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { createCache, createCachePlugin } from 'blendsdk/webafx-cache';
import { ProductController } from './controllers/product-controller.js';

const app = new WebApplication({
  PORT: 4000,
  ENV_MODE: 'production',
  LOG_LEVEL: 'WARN',
  TRUST_PROXY: true,
  SHUTDOWN_TIMEOUT: 10,
});

// Database service with health check via plugin
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
      poolConfig: { max: 20 },
    });
    await db.connect();
    return db;
  },
  dispose: async (db) => await db.disconnect(),
});

// Cache — auto-switches between Redis (production) and Memory (development)
const cache = createCache({
  type: process.env.REDIS_HOST ? 'redis' : 'memory',
  rootKey: '{{PROJECT_NAME}}',
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT || 6379),
  defaultTTL: 300,
});
app.use(createCachePlugin(cache));

// Controllers
app.registerController('/api/products', ProductController);

// Lifecycle
app.on('afterStart', async () => {
  console.log('🚀 {{PROJECT_NAME}} started');
});

app.on('beforeShutdown', async () => {
  console.log('🔻 Shutting down gracefully...');
});

const shutdown = await app.start();
```

## File: .dockerignore

```
node_modules
dist
.git
.env.local.js
*.test.ts
tests/
docker/
.turbo
```

## File: .gitignore

```
node_modules/
dist/
.env.local.js
.turbo/
```

## Post-Setup Instructions

### Development

```bash
# Start PostgreSQL + Redis
yarn docker:dev

# Install dependencies
yarn install

# Copy local config
cp .env.local.js.example .env.local.js

# Start development server
yarn dev
```

### Production

```bash
# Build and start full stack
yarn docker:prod

# Verify health
curl http://localhost:4000/health

# View logs
docker compose -f docker/docker-compose.yml -f docker/docker-compose.prod.yml logs -f app

# Stop
yarn docker:down
```

### Kubernetes Deployment

```yaml
# Example Kubernetes readiness/liveness probes
readinessProbe:
  httpGet:
    path: /health
    port: 4000
  initialDelaySeconds: 10
  periodSeconds: 5

livenessProbe:
  httpGet:
    path: /health
    port: 4000
  initialDelaySeconds: 15
  periodSeconds: 10
```

## Customization Guide

1. **Add secrets management** — Use Kubernetes Secrets or Docker Swarm secrets for DB passwords
2. **Add reverse proxy** — Put nginx or Traefik in front for TLS termination and rate limiting
3. **Add logging** — Use `StructuredLogger` for JSON logs compatible with ELK/CloudWatch
4. **Add migrations** — Add a migration step in the Dockerfile or as an init container
5. **Multi-stage CI** — Run `yarn build && yarn test` in CI before the Docker build
