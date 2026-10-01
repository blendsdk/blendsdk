# Template: Minimal API

> **Complexity**: Beginner
> **Packages Used**: webafx
> **Docker**: None
> **Features**: Controllers, validation, health check, error handling

## Overview

A minimal Express API using WebAFX with a single controller, Zod validation, and built-in health checks. This is the simplest possible BlendSDK API.

## Prerequisites

- Node.js >= 22.0.0
- Yarn or npm

## Project Structure

```
{{PROJECT_NAME}}/
├── src/
│   ├── index.ts                  # Application entry point
│   └── controllers/
│       └── hello-controller.ts   # Example controller
├── package.json
├── tsconfig.json
├── .env.js                       # Shared configuration
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
    "dev": "tsx watch src/index.ts"
  },
  "dependencies": {
    "blendsdk": "^5.x",
    "express": "^5.0.0",
    "cookie-parser": "^1.4.0",
    "cors": "^2.8.0",
    "helmet": "^8.0.0",
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

## File: .env.js

```javascript
export default {
  PORT: 3000,
  ENV_MODE: 'development',
  LOG_LEVEL: 'INFO',
  CORS: true,
};
```

## File: src/controllers/hello-controller.ts

```typescript
import { BaseController } from 'blendsdk/webafx';
import { Request, Response } from 'express';
import { z } from 'zod';

const greetSchema = z.object({
  name: z.string().min(1).max(100),
});

export class HelloController extends BaseController {
  routes() {
    return [
      this.route().get('/').handle(this.hello),
      this.route().get('/:name').validate(greetSchema).handle(this.greet),
    ];
  }

  async hello(req: Request, res: Response) {
    this.ok(res, {
      message: 'Welcome to {{PROJECT_NAME}}!',
      version: '1.0.0',
    });
  }

  async greet(req: Request, res: Response) {
    const { name } = req.services.getParams<{ name: string }>();
    this.ok(res, { message: `Hello, ${name}!` });
  }
}
```

## File: src/index.ts

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { HelloController } from './controllers/hello-controller.js';

const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'development',
  LOG_LEVEL: 'INFO',
  CORS: true,
});

app.registerController('/api/hello', HelloController);

const shutdown = await app.start();
```

## File: .gitignore

```
node_modules/
dist/
.env.local.js
```

## Post-Setup Instructions

```bash
# Install dependencies
yarn install

# Start development server (with hot reload)
yarn dev

# Build for production
yarn build

# Start production server
yarn start
```

## Test It

```bash
# Health check
curl http://localhost:3000/health

# Hello endpoint
curl http://localhost:3000/api/hello

# Greet endpoint
curl http://localhost:3000/api/hello/World

# 404 test
curl http://localhost:3000/nonexistent
```

## Customization Guide

1. **Add controllers** — Create new files in `src/controllers/` and register with `app.registerController()`
2. **Add validation** — Define Zod schemas and use `.validate()` on routes
3. **Add authentication** — Use `.secure()` on routes and register a `user` per-request service
4. **Add services** — Use `app.registerService()` for database connections, caches, etc.
5. **Add plugins** — Use `app.use()` for reusable middleware bundles
