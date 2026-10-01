# Caching Patterns

> Add caching to your application with Redis or in-memory backends, plus pub/sub messaging.

**Packages:** `webafx-cache`, `webafx`

---

## Problem

How do I add caching to improve performance, and how do I use pub/sub for real-time events?

## Solution

### Basic Setup — In-Memory (Development)

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { memoryCachePlugin } from 'blendsdk/webafx-cache';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

app.use(memoryCachePlugin({
  rootKey: 'MyApp',
  defaultTTL: 300, // 5 minutes
}));
```

### Production — Redis

```typescript
import { redisCachePlugin } from 'blendsdk/webafx-cache';

app.use(redisCachePlugin({
  rootKey: 'MyApp',
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
  defaultTTL: 300,
}));
```

### Environment-Based Switching

```typescript
import { createCache, createCachePlugin } from 'blendsdk/webafx-cache';

const cache = createCache({
  type: process.env.NODE_ENV === 'production' ? 'redis' : 'memory',
  rootKey: 'MyApp',
  host: process.env.REDIS_HOST ?? 'localhost',
  defaultTTL: 300,
});

app.use(createCachePlugin(cache));
```

### Cache-Aside Pattern in Controllers

```typescript
import type { CacheProvider } from 'blendsdk/webafx-cache';
import { BaseController, NotFoundError } from 'blendsdk/webafx';

class ProductController extends BaseController {
  routes() {
    return [
      this.route().get('/:id').handle(this.getById),
      this.route().put('/:id').secure().handle(this.update),
      this.route().delete('/:id').secure().handle(this.remove),
    ];
  }

  async getById(req: Request, res: Response) {
    const { id } = req.services.getParams<{ id: string }>();
    const cache = await req.services.get<CacheProvider>('cache');

    // getOrSet: returns cached value or calls factory on miss
    const product = await cache.getOrSet(`product:${id}`, async () => {
      const db = await req.services.get('db');
      const result = await db.executeQuery('SELECT * FROM products WHERE id = $1', [id]);
      if (!result.records[0]) throw new NotFoundError(`Product ${id} not found`);
      return result.records[0];
    }, 300);

    this.ok(res, product);
  }

  async update(req: Request, res: Response) {
    const { id, ...data } = req.services.getParams();
    const db = await req.services.get('db');
    const cache = await req.services.get<CacheProvider>('cache');

    // Update DB then invalidate cache
    await db.executeQuery('UPDATE products SET name = $1 WHERE id = $2', [data.name, id]);
    await cache.delete(`product:${id}`);

    this.ok(res, { updated: true });
  }

  async remove(req: Request, res: Response) {
    const { id } = req.services.getParams<{ id: string }>();
    const cache = await req.services.get<CacheProvider>('cache');

    // Bulk invalidation with pattern
    await cache.deletePattern(`product:${id}:*`);
    await cache.delete(`product:${id}`);

    this.noContent(res);
  }
}
```

### Pub/Sub Messaging

```typescript
import { redisPubSubPlugin } from 'blendsdk/webafx-cache';
import type { PubSubProvider } from 'blendsdk/webafx-cache';

// Register with declarative subscriptions
app.use(redisPubSubPlugin(
  { host: 'localhost', channelPrefix: 'MyApp' },
  {
    subscriptions: [
      {
        channel: 'order:created',
        handler: async (msg) => {
          console.log('New order:', msg.data);
        },
      },
      {
        pattern: 'audit:*',
        handler: async (msg) => {
          console.log(`Audit event on ${msg.channel}:`, msg.data);
        },
      },
    ],
  }
));

// Publish from controllers
class OrderController extends BaseController {
  routes() {
    return [this.route().post('/').secure().handle(this.create)];
  }

  async create(req: Request, res: Response) {
    const order = req.services.getParams();
    const pubsub = await req.services.get<PubSubProvider>('pubsub');

    // Save order to DB...
    await pubsub.publish('order:created', order);
    this.created(res, order);
  }
}
```

## Key Points

- **`rootKey`** isolates your keys — `MyApp:product:123` never collides with other apps
- **`getOrSet()`** is the recommended cache-aside pattern (prevents stampedes)
- **`deletePattern('prefix:*')`** for bulk invalidation (uses Redis SCAN, not KEYS)
- **`clear()`** only removes keys under your `rootKey`, not the entire Redis DB
- Pub/sub uses **two dedicated Redis connections** (publisher + subscriber)
- Handler errors are **isolated** — one failing handler doesn't affect others
- Both cache and pub/sub register as **singleton services** (not per-request)
