# Production Deployment

> **Module**: Getting Started
> **Audience**: Developers deploying BlendSDK applications to production

## Overview

This guide covers building, optimizing, and deploying a BlendSDK web API to production. BlendSDK applications are standard Node.js ESM applications — they can be deployed anywhere Node.js runs.

## Build for Production

### Step 1: Compile TypeScript

```bash
# Compile to JavaScript
npm run build
```

This produces optimized JavaScript in the `dist/` directory.

### Step 2: Verify the build

```bash
# Start the compiled application to verify it works
node dist/index.js
```

### Project structure after build

```
my-api/
├── dist/                          # Compiled JavaScript (deploy this)
│   ├── index.js
│   ├── index.js.map
│   ├── controllers/
│   ├── services/
│   └── routes/
├── src/                           # TypeScript source (do NOT deploy)
├── node_modules/                  # Dependencies (install on server)
├── package.json
└── package-lock.json
```

## Environment Configuration

Use environment variables for all deployment-specific settings:

```typescript
// src/config/app-config.ts

/**
 * Application configuration loaded from environment variables.
 * All sensitive values (database credentials, API keys) must come from
 * environment variables — never hardcode them.
 */
export const config = {
    port: parseInt(process.env.PORT ?? '3000', 10),
    nodeEnv: process.env.NODE_ENV ?? 'development',

    // Database
    database: {
        host: process.env.DB_HOST ?? 'localhost',
        port: parseInt(process.env.DB_PORT ?? '5432', 10),
        database: process.env.DB_NAME ?? 'app',
        user: process.env.DB_USER ?? 'postgres',
        password: process.env.DB_PASSWORD ?? 'postgres',
        // Connection pool settings for production
        max: parseInt(process.env.DB_POOL_MAX ?? '20', 10),
        idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT ?? '30000', 10),
    },

    // Redis (for webafx-cache)
    redis: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
        password: process.env.REDIS_PASSWORD,
    },

    // SMTP (for webafx-mailer)
    smtp: {
        host: process.env.SMTP_HOST ?? 'localhost',
        port: parseInt(process.env.SMTP_PORT ?? '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        user: process.env.SMTP_USER,
        password: process.env.SMTP_PASSWORD,
    },

    // CORS
    cors: {
        origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:5173'],
    },
};
```

## Docker Production Deployment

### Dockerfile

```dockerfile
# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --production=false

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Production image
FROM node:22-alpine

WORKDIR /app

# Copy package files and install production deps only
COPY package.json package-lock.json ./
RUN npm ci --production && npm cache clean --force

# Copy compiled JavaScript from builder stage
COPY --from=builder /app/dist ./dist

# Run as non-root user for security
RUN addgroup -g 1001 -S appuser && \
    adduser -S appuser -u 1001 -G appuser
USER appuser

EXPOSE 3000

# Use node directly (not npm) for proper signal handling
CMD ["node", "dist/index.js"]
```

### .dockerignore

```
node_modules
dist
src
tests
*.md
.git
.env*
docker
```

### Build and run

```bash
# Build the image
docker build -t my-api:latest .

# Run with environment variables
docker run -d \
  --name my-api \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e DB_HOST=postgres \
  -e DB_NAME=app_prod \
  -e DB_USER=app \
  -e DB_PASSWORD=secure-password \
  -e REDIS_HOST=redis \
  my-api:latest
```

### Docker Compose for production

```yaml
# docker-compose.prod.yml
services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      PORT: 3000
      DB_HOST: postgres
      DB_PORT: 5432
      DB_NAME: app_prod
      DB_USER: app
      DB_PASSWORD: ${DB_PASSWORD}
      REDIS_HOST: redis
      REDIS_PORT: 6379
      CORS_ORIGIN: https://myapp.example.com
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped

  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: app_prod
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app_prod"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    command: redis-server --requirepass ${REDIS_PASSWORD}
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD}", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5

volumes:
  pgdata:
  redisdata:
```

## Health Checks

Always include a health endpoint for load balancers and container orchestrators:

```typescript
// src/controllers/health.controller.ts
import type { Request, Response } from 'express';

/**
 * Health check endpoint for load balancers and orchestrators.
 * Returns 200 if the application is ready to serve requests.
 */
export function healthCheck(_req: Request, res: Response): void {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: process.env.npm_package_version ?? 'unknown',
    });
}
```

Register it:

```typescript
app.get('/health', healthCheck);
```

## Graceful Shutdown

Handle process signals for clean shutdown (important for container deployments):

```typescript
// src/index.ts
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication({ name: 'my-api', port: 3000 });

// ... register routes and plugins ...

await app.start();

/**
 * Graceful shutdown handler.
 * Closes database connections, cache connections, and HTTP server
 * before the process exits. This prevents data loss and connection leaks.
 */
async function shutdown(signal: string): Promise<void> {
    console.log(`\n${signal} received. Shutting down gracefully...`);

    // Stop accepting new requests, close existing connections
    await app.stop();

    console.log('Shutdown complete.');
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

## Production Checklist

Before deploying, verify:

- [ ] **Build succeeds**: `npm run build` produces clean output
- [ ] **Tests pass**: All unit and integration tests pass
- [ ] **Environment variables**: All config is via env vars, no hardcoded secrets
- [ ] **Health endpoint**: `/health` returns 200
- [ ] **Graceful shutdown**: SIGTERM handler closes connections cleanly
- [ ] **Non-root user**: Docker container runs as non-root
- [ ] **CORS configured**: Only your frontend origin(s) allowed
- [ ] **Database pool**: Connection pool sized for production load
- [ ] **Logging**: Structured logging enabled (not console.log)
- [ ] **Error handling**: Unhandled errors return safe responses (no stack traces)

## Deployment Targets

BlendSDK applications run anywhere Node.js 22+ is available:

| Target | Notes |
|--------|-------|
| **Docker / Kubernetes** | Use the multi-stage Dockerfile above |
| **Cloud Run / App Runner** | Deploy container image, set env vars in console |
| **VM / Bare metal** | Install Node.js, `npm ci --production`, `node dist/index.js` |
| **Serverless** | Not recommended — BlendSDK is designed for long-running servers |

## See Also

- [Docker Setup](docker-setup.md) — Local development Docker configuration
- [Project Scaffolding](project-scaffolding.md) — Create a new project from scratch
- [Templates: Production Docker](../../assets/templates/05-production-docker.md) — Complete production Docker template
