# Template: Microservice

> **Complexity**: Intermediate
> **Packages Used**: webafx, webafx-cache
> **Docker**: Redis
> **Features**: Lightweight API, pub/sub messaging, cache, health monitoring, graceful shutdown

## Overview

A lightweight microservice focused on a single domain with pub/sub messaging for event-driven communication, caching for performance, and comprehensive health checks. Designed for containerized deployments.

## Prerequisites

- Node.js >= 22.0.0
- Docker (for Redis)
- Yarn or npm

## Project Structure

```
{{PROJECT_NAME}}/
├── src/
│   ├── index.ts                        # Application entry point
│   ├── controllers/
│   │   └── order-controller.ts         # Domain controller
│   └── handlers/
│       └── event-handlers.ts           # Pub/sub event handlers
├── docker/
│   └── docker-compose.yml
├── package.json
├── tsconfig.json
├── .env.js
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

## File: docker/docker-compose.yml

```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
```

## File: .env.js

```javascript
export default {
  PORT: 3001,
  ENV_MODE: 'development',
  LOG_LEVEL: 'INFO',
  CORS: true,
  REDIS_HOST: 'localhost',
  REDIS_PORT: 6379,
  SERVICE_NAME: '{{PROJECT_NAME}}',
};
```

## File: src/handlers/event-handlers.ts

```typescript
import type { PubSubMessage } from 'blendsdk/webafx-cache';

interface OrderCreatedEvent {
  orderId: string;
  userId: string;
  total: number;
}

interface PaymentEvent {
  orderId: string;
  status: 'succeeded' | 'failed';
}

export async function handleOrderCreated(msg: PubSubMessage<OrderCreatedEvent>) {
  console.log(`[ORDER] New order ${msg.data.orderId} for $${msg.data.total}`);
  // Process order: validate inventory, reserve items, etc.
}

export async function handlePaymentUpdate(msg: PubSubMessage<PaymentEvent>) {
  console.log(`[PAYMENT] Order ${msg.data.orderId}: ${msg.data.status}`);
  // Update order status based on payment result
}

export async function handleAuditEvent(msg: PubSubMessage<unknown>) {
  console.log(`[AUDIT] Event on ${msg.channel}:`, msg.data);
  // Log audit events for compliance
}
```

## File: src/controllers/order-controller.ts

```typescript
import { BaseController } from 'blendsdk/webafx';
import type { CacheProvider, PubSubProvider } from 'blendsdk/webafx-cache';
import { Request, Response } from 'express';
import { z } from 'zod';

const createOrderSchema = z.object({
  userId: z.string().min(1),
  items: z.array(z.object({
    productId: z.string(),
    quantity: z.number().int().positive(),
  })).min(1),
});

export class OrderController extends BaseController {
  routes() {
    return [
      this.route().get('/:id').handle(this.getById),
      this.route().post('/').validate(createOrderSchema).handle(this.create),
    ];
  }

  async getById(req: Request, res: Response) {
    const { id } = req.services.getParams<{ id: string }>();
    const cache = await req.services.get<CacheProvider>('cache');

    const order = await cache.getOrSet(`order:${id}`, async () => {
      // TODO: Fetch from database
      return { id, status: 'pending', items: [] };
    }, 60);

    this.ok(res, order);
  }

  async create(req: Request, res: Response) {
    const params = req.services.getParams<z.infer<typeof createOrderSchema>>();
    const cache = await req.services.get<CacheProvider>('cache');
    const pubsub = await req.services.get<PubSubProvider>('pubsub');

    // TODO: Save to database
    const order = {
      id: crypto.randomUUID(),
      ...params,
      status: 'pending',
      total: 0,
      createdAt: new Date().toISOString(),
    };

    // Cache the new order
    await cache.set(`order:${order.id}`, order, 300);

    // Publish event for other services to react
    await pubsub.publish('order:created', {
      orderId: order.id,
      userId: params.userId,
      total: order.total,
    });

    this.created(res, order);
  }
}
```

## File: src/index.ts

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { redisCachePlugin, redisPubSubPlugin } from 'blendsdk/webafx-cache';
import { OrderController } from './controllers/order-controller.js';
import { handleOrderCreated, handlePaymentUpdate, handleAuditEvent } from './handlers/event-handlers.js';

const app = new WebApplication({
  PORT: 3001,
  ENV_MODE: 'development',
  LOG_LEVEL: 'INFO',
  CORS: true,
  SHUTDOWN_TIMEOUT: 10,
});

// Cache plugin
app.use(redisCachePlugin({
  rootKey: '{{PROJECT_NAME}}',
  host: 'localhost',
  port: 6379,
  defaultTTL: 300,
}));

// Pub/Sub plugin with declarative subscriptions
app.use(redisPubSubPlugin(
  { host: 'localhost', port: 6379, channelPrefix: '{{PROJECT_NAME}}' },
  {
    subscriptions: [
      { channel: 'order:created', handler: handleOrderCreated },
      { channel: 'payment:update', handler: handlePaymentUpdate },
      { pattern: 'audit:*', handler: handleAuditEvent },
    ],
  },
));

// Controllers
app.registerController('/api/orders', OrderController);

// Lifecycle hooks
app.on('afterStart', async () => {
  console.log(`🚀 {{PROJECT_NAME}} is ready`);
});

const shutdown = await app.start();
```

## Post-Setup Instructions

```bash
# Start Redis
yarn docker:up

# Install dependencies
yarn install

# Start the microservice
yarn dev
```

## Test It

```bash
# Health check
curl http://localhost:3001/health

# Create an order
curl -X POST http://localhost:3001/api/orders \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-1","items":[{"productId":"prod-1","quantity":2}]}'

# Get an order
curl http://localhost:3001/api/orders/<order-id>
```

## Customization Guide

1. **Add database** — Register a PostgreSQL singleton service for persistent storage
2. **Multiple services** — Run multiple instances with different ports and subscribe to different channels
3. **Scale with Docker** — Each instance shares Redis for cache + pub/sub coordination
4. **Add monitoring** — Create a metrics plugin that tracks request counts and durations
5. **Switch to memory** — Use `memoryCachePlugin()` and `memoryPubSubPlugin()` for local development without Redis
