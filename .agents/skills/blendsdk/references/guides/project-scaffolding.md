# Project Scaffolding

> **Module**: Getting Started
> **Audience**: Developers creating a new BlendSDK project

## Overview

This guide walks you through creating a new BlendSDK web API project from scratch. By the end, you'll have a working project structure with TypeScript, Express 5, and the BlendSDK packages you need.

## Step 1: Create Project Directory

```bash
mkdir my-api && cd my-api
npm init -y
```

## Step 2: Configure package.json

Edit `package.json` to enable ESM and add scripts:

```json
{
  "name": "my-api",
  "version": "1.0.0",
  "type": "module",
  "engines": {
    "node": ">=22.0.0"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "clean": "rm -rf dist"
  }
}
```

## Step 3: Install Dependencies

```bash
# BlendSDK core
npm install blendsdk

# Peer dependencies for webafx + postgresql
npm install express cookie-parser cors helmet pg yesql

# Dev dependencies
npm install -D typescript tsx @types/express @types/cookie-parser @types/cors @types/pg @types/node
```

## Step 4: Create tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

## Step 5: Create Directory Structure

```bash
mkdir -p src/controllers src/services src/routes src/config
```

Recommended project layout:

```
my-api/
├── package.json
├── tsconfig.json
├── docker/
│   └── docker-compose.yml          # PostgreSQL, Redis, etc.
├── src/
│   ├── index.ts                    # Application entry point
│   ├── config/
│   │   └── app-config.ts           # Configuration loading
│   ├── controllers/
│   │   └── health.controller.ts    # Health check controller
│   ├── routes/
│   │   └── api.routes.ts           # Route definitions
│   └── services/
│       └── example.service.ts      # Business logic
└── tests/
    └── health.test.ts              # Tests
```

## Step 6: Create the Application Entry Point

```typescript
// src/index.ts
import { WebApplication } from 'blendsdk/webafx';

/**
 * Create and configure the web application.
 * WebApplication wraps Express 5 with DI, plugins, and route building.
 */
const app = new WebApplication({
    name: 'my-api',
    port: 3000,
    cors: {
        // Allow requests from your frontend origin in development
        origin: ['http://localhost:5173'],
        credentials: true,
    },
});

// Register routes
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start the server
await app.start();
console.log(`🚀 Server running on http://localhost:${app.getPort()}`);
```

## Step 7: Add a Controller

```typescript
// src/controllers/health.controller.ts
import type { Request, Response } from 'express';

/**
 * Health check controller.
 * Returns the application status and current timestamp.
 */
export function healthCheck(_req: Request, res: Response): void {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
    });
}
```

## Step 8: Run the Application

### Development mode (with hot reload)

```bash
npm run dev
```

### Production mode

```bash
npm run build
npm start
```

## Step 9: Verify

Open your browser or use curl:

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{
  "status": "ok",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "uptime": 1.234
}
```

## Adding More Packages

As your project grows, install additional peer dependencies as needed:

### Add PostgreSQL database support

```bash
# Peer deps already installed in Step 3
# Use in your code:
```

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { query } from 'blendsdk/expression';
```

### Add caching with Redis

```bash
npm install ioredis
```

```typescript
import { redisCachePlugin } from 'blendsdk/webafx-cache';
```

### Add email sending

```bash
npm install nodemailer
npm install -D @types/nodemailer
```

```typescript
import { smtpMailPlugin } from 'blendsdk/webafx-mailer';
```

### Add authentication

```bash
npm install jose
```

```typescript
import { JwtAuthProvider } from 'blendsdk/webafx-auth';
```

### Add internationalization

```typescript
// No additional peer deps needed for basic i18n
import { Translator, mergeCatalogs } from 'blendsdk/i18n';
```

## See Also

- [Installation](installation.md) — Detailed installation and peer dependency reference
- [Docker Setup](docker-setup.md) — Set up PostgreSQL, Redis, and Mailpit for development
- [Web API CRUD Pattern](../patterns/01-web-api-crud.md) — Build a full CRUD API
- Templates — Complete starter project templates
