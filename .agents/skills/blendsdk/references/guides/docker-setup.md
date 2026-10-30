# Docker Setup

> **Module**: Getting Started
> **Audience**: Developers setting up local development services

## Overview

Several BlendSDK packages require external services for integration testing and development — PostgreSQL for database operations, Redis for caching/pub-sub, and Mailpit for email testing. This guide shows how to set up all required Docker services.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) installed and running
- [Docker Compose](https://docs.docker.com/compose/install/) (included with Docker Desktop)

## Quick Start: All Services

Create a `docker/docker-compose.yml` in your project root to start all services at once:

```yaml
services:
  # PostgreSQL — for database operations, codegen, webafx
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: app_dev
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_HOST_AUTH_METHOD: trust
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d app_dev"]
      interval: 5s
      timeout: 5s
      retries: 5
      start_period: 10s

  # Redis — for caching and pub/sub (webafx-cache)
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    command: redis-server --appendonly no
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  # Mailpit — for email testing (webafx-mailer)
  mailpit:
    image: axllent/mailpit:latest
    ports:
      - "1025:1025"   # SMTP server
      - "8025:8025"   # Web UI + REST API
    environment:
      MP_SMTP_AUTH_ACCEPT_ANY: 1
      MP_SMTP_AUTH_ALLOW_INSECURE: 1
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:8025/api/v1/messages"]
      interval: 5s
      timeout: 3s
      retries: 5
```

### Start all services

```bash
cd docker && docker compose up -d
```

### Stop all services

```bash
cd docker && docker compose down
```

### Check service health

```bash
docker compose -f docker/docker-compose.yml ps
```

## Individual Service Setup

If you only need specific services, use the minimal configurations below.

### PostgreSQL Only

For `blendsdk/postgresql`, `blendsdk/codegen`, or database-backed webafx apps:

```yaml
# docker/docker-compose.yml
services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: app_dev
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_HOST_AUTH_METHOD: trust
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d app_dev"]
      interval: 5s
      timeout: 5s
      retries: 5
      start_period: 10s
```

**Connection string:**

```
postgresql://postgres:postgres@localhost:5432/app_dev
```

**Usage in BlendSDK:**

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
    host: 'localhost',
    port: 5432,
    database: 'app_dev',
    user: 'postgres',
    password: 'postgres',
});
```

### Redis Only

For `blendsdk/webafx-cache` (caching and pub/sub):

```yaml
# docker/docker-compose.yml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    command: redis-server --appendonly no
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
```

**Usage in BlendSDK:**

```typescript
import { RedisCacheProvider } from 'blendsdk/webafx-cache';

const cache = new RedisCacheProvider({
    host: 'localhost',
    port: 6379,
});
```

### Mailpit Only

For `blendsdk/webafx-mailer` (email sending and testing):

```yaml
# docker/docker-compose.yml
services:
  mailpit:
    image: axllent/mailpit:latest
    ports:
      - "1025:1025"   # SMTP server
      - "8025:8025"   # Web UI + REST API
    environment:
      MP_SMTP_AUTH_ACCEPT_ANY: 1
      MP_SMTP_AUTH_ALLOW_INSECURE: 1
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:8025/api/v1/messages"]
      interval: 5s
      timeout: 3s
      retries: 5
```

**SMTP connection:**

```
Host: localhost
Port: 1025
Auth: none (accepts any credentials)
```

**Web UI:** Open http://localhost:8025 to view sent emails.

**Usage in BlendSDK:**

```typescript
import { SmtpMailProvider } from 'blendsdk/webafx-mailer';

const mailer = new SmtpMailProvider({
    host: 'localhost',
    port: 1025,
});
```

## Port Mapping Reference

Default ports used by BlendSDK Docker configurations:

| Service | Container Port | Host Port | Package |
|---------|---------------|-----------|---------|
| PostgreSQL | 5432 | 5432 | `blendsdk/postgresql` |
| Redis | 6379 | 6379 | `blendsdk/webafx-cache` |
| Mailpit SMTP | 1025 | 1025 | `blendsdk/webafx-mailer` |
| Mailpit Web UI | 8025 | 8025 | `blendsdk/webafx-mailer` |

> **Note:** BlendSDK's internal test suites use non-standard ports to avoid conflicts with local development databases (e.g., PostgreSQL on 5599, Redis on 6399). For your own projects, use the standard ports shown above.

## Database Initialization Scripts

To run SQL scripts on PostgreSQL startup (creating tables, seeding data), mount an init directory:

```yaml
services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: app_dev
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    volumes:
      - ./docker/init-scripts:/docker-entrypoint-initdb.d
    ports:
      - "5432:5432"
```

Then create SQL files in `docker/init-scripts/`:

```sql
-- docker/init-scripts/01-create-tables.sql
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
```

Files are executed in alphabetical order on first container startup.

## Troubleshooting

### Port already in use

If a port is already taken, change the host port mapping:

```yaml
ports:
  - "5433:5432"  # Map to 5433 instead of 5432
```

### Container won't start

Check logs:

```bash
docker compose -f docker/docker-compose.yml logs postgres
docker compose -f docker/docker-compose.yml logs redis
docker compose -f docker/docker-compose.yml logs mailpit
```

### Reset database data

Remove volumes to start fresh:

```bash
docker compose -f docker/docker-compose.yml down -v
docker compose -f docker/docker-compose.yml up -d
```

## See Also

- [Installation](installation.md) — Install BlendSDK and peer dependencies
- Docker Reference — Complete Docker configs from all BlendSDK packages
- [Production Deployment](production-deployment.md) — Deploy to production with Docker
