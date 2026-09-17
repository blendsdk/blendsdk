# Web API CRUD Pattern

> Build REST CRUD endpoints with validation, database integration, and error handling.

**Packages:** `webafx`, `postgresql`, `dbcore`, `expression`, `zod`

---

## Problem

How do I build a complete REST API with Create, Read, Update, Delete operations using BlendSDK's web framework and database layer?

## Solution

### Step 1: Define Validation Schemas

```typescript
import { z } from 'zod';

const createProductSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  price: z.number().positive(),
});

const updateProductSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  price: z.number().positive().optional(),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
```

### Step 2: Create the Controller

```typescript
import { BaseController, NotFoundError } from 'blendsdk/webafx';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { query } from 'blendsdk/expression';
import { Request, Response } from 'express';

class ProductController extends BaseController {
  routes() {
    return [
      this.route().get('/').validate(paginationSchema).handle(this.list),
      this.route().get('/:id').handle(this.getById),
      this.route().post('/').secure().validate(createProductSchema).handle(this.create),
      this.route().put('/:id').secure().validate(updateProductSchema).handle(this.update),
      this.route().delete('/:id').secure().authorize(async (req, user) => user?.role === 'admin').handle(this.remove),
    ];
  }

  async list(req: Request, res: Response) {
    const { page, limit } = req.services.getParams<{ page: number; limit: number }>();
    const db = await req.services.get<PostgreSQLDatabase>('db');
    const offset = (page - 1) * limit;

    const [data, countResult] = await Promise.all([
      db.from('products').selectAll().limit(limit).offset(offset).execute(),
      db.executeQuery('SELECT COUNT(*) as total FROM products'),
    ]);

    this.paginated(res, data.records, Number(countResult.records[0].total), page, limit);
  }

  async getById(req: Request, res: Response) {
    const { id } = req.services.getParams<{ id: string }>();
    const db = await req.services.get<PostgreSQLDatabase>('db');
    const result = await db.from('products').selectAll()
      .where(query().where('id').equals(id)).execute();

    if (result.records.length === 0) throw new NotFoundError(`Product ${id} not found`);
    this.ok(res, result.records[0]);
  }

  async create(req: Request, res: Response) {
    const params = req.services.getParams<{ name: string; description?: string; price: number }>();
    const db = await req.services.get<PostgreSQLDatabase>('db');
    const result = await db.insert('products').values(params).returning('*').execute();
    this.created(res, result.records[0]);
  }

  async update(req: Request, res: Response) {
    const { id, ...updates } = req.services.getParams<{ id: string; name?: string; description?: string; price?: number }>();
    const db = await req.services.get<PostgreSQLDatabase>('db');
    const result = await db.update('products').set(updates)
      .where(query().where('id').equals(id)).returning('*').execute();

    if (result.records.length === 0) throw new NotFoundError(`Product ${id} not found`);
    this.ok(res, result.records[0]);
  }

  async remove(req: Request, res: Response) {
    const { id } = req.services.getParams<{ id: string }>();
    const db = await req.services.get<PostgreSQLDatabase>('db');
    const result = await db.delete('products')
      .where(query().where('id').equals(id)).execute();

    if (result.affectedRows === 0) throw new NotFoundError(`Product ${id} not found`);
    this.noContent(res);
  }
}
```

### Step 3: Wire Up the Application

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });

app.registerService({
  name: 'db',
  type: 'singleton',
  factory: async (container, settings) => {
    const db = new PostgreSQLDatabase({
      host: settings.get('DB_HOST', 'localhost'),
      port: settings.get('DB_PORT', 5432),
      database: settings.get('DB_NAME', 'myapp'),
    });
    await db.connect();
    return db;
  },
  dispose: async (db) => await db.close(),
});

app.registerController('/api/products', ProductController);
const shutdown = await app.start();
```

## Key Points

- **Validation schemas** defined outside controllers for reusability
- **`this.paginated()`** for list endpoints with `page`/`limit` query params
- **`throw new NotFoundError()`** — error handler formats the JSON response
- **`.secure()`** requires authentication; **`.authorize()`** adds role checks
- **`db.from().selectAll().where(query()...)`** for type-safe queries
- **`db.insert().values().returning('*')`** for insert with response
- Always **register the DB service with `dispose`** for graceful shutdown
