# Controllers & Routing

> **Package**: `@blendsdk/webafx`
> **Back to**: [README](../README.md)

## Overview

Controllers organize related HTTP routes and business logic. They extend `BaseController` and use the fluent `RouteBuilder` API to define routes with validation, authentication, authorization, and middleware.

## Creating a Controller

```typescript
import { BaseController } from '@blendsdk/webafx';
import { Request, Response } from 'express';
import { z } from 'zod';

class ProductController extends BaseController {
  /**
   * Define all routes for this controller.
   * Called once during application setup.
   */
  routes() {
    return [
      this.route().get('/').handle(this.list),
      this.route().get('/:id').handle(this.getById),

      this.route()
        .post('/')
        .secure()
        .validate(z.object({
          name: z.string().min(1).max(255),
          price: z.number().positive(),
        }))
        .handle(this.create),

      this.route()
        .delete('/:id')
        .secure()
        .authorize(async (req, user) => user?.role === 'admin')
        .handle(this.remove),
    ];
  }

  async list(req: Request, res: Response) {
    const products = []; // Fetch from database
    this.ok(res, { products });
  }

  async getById(req: Request, res: Response) {
    const { id } = req.services.getParams<{ id: string }>();
    const product = null; // Fetch from database
    if (!product) throw new NotFoundError('Product not found');
    this.ok(res, { product });
  }

  async create(req: Request, res: Response) {
    const data = req.services.getParams<{ name: string; price: number }>();
    const product = data; // Insert into database
    this.created(res, { product });
  }

  async remove(req: Request, res: Response) {
    // Delete from database
    this.noContent(res);
  }
}
```

## Registering Controllers

```typescript
const app = new WebApplication({ PORT: 3000 });

// Each controller is mounted at a base path
app.registerController('/api/products', ProductController);
app.registerController('/api/users', UserController);
app.registerController('/api/auth', AuthController);
```

Routes are prefixed with the base path:
- `ProductController.list` → `GET /api/products/`
- `ProductController.getById` → `GET /api/products/:id`
- `ProductController.create` → `POST /api/products/`

## RouteBuilder API

The `RouteBuilder` provides a fluent interface for defining routes. Start with `this.route()` and chain methods:

### HTTP Methods

```typescript
this.route().get('/path')       // GET request
this.route().post('/path')      // POST request
this.route().put('/path')       // PUT request
this.route().patch('/path')     // PATCH request
this.route().delete('/path')    // DELETE request
```

### Validation with Zod

Validates merged data from `req.params`, `req.query`, and `req.body`:

```typescript
this.route()
  .post('/users')
  .validate(z.object({
    name: z.string().min(1).max(100),
    email: z.string().email(),
    age: z.number().int().min(0).optional(),
  }))
  .handle(this.createUser)
```

Access validated data in the handler:

```typescript
async createUser(req: Request, res: Response) {
  // Merged and validated params
  const params = req.services.getParams<{ name: string; email: string; age?: number }>();

  // Or access separated input sources
  const input = req.services.getInput<{
    params: { id: string };
    query: { sort: string };
    body: { name: string };
  }>();
  console.log(input.body.name);
}
```

### Authentication (`.secure()`)

Marks a route as requiring authentication. The `user` service must be set in the request container (typically by an auth plugin):

```typescript
this.route().get('/me').secure().handle(this.getMe)
// Throws UnauthorizedError (401) if req.services.get('user') is undefined
```

### Authorization (`.authorize()`)

Adds a custom authorization check. Runs after authentication:

```typescript
this.route()
  .delete('/:id')
  .secure() // Must be authenticated first
  .authorize(async (req, user) => {
    // Return true to allow, false to deny
    return user.role === 'admin';
  })
  .handle(this.delete)
// Throws ForbiddenError (403) if authorize returns false
```

### Route-Level Middleware

Add Express middleware to specific routes:

```typescript
import { rateLimitMiddleware } from '@blendsdk/webafx';

this.route()
  .post('/search')
  .middleware(rateLimitMiddleware({ maxRequests: 10, windowMs: 60000 }))
  .middleware(customLoggingMiddleware)
  .handle(this.search)
```

Middleware runs in order before the route handler.

### Shorthand: `.authenticated()`

`this.authenticated()` is shorthand for `this.route().secure()`:

```typescript
// These are equivalent:
this.route().get('/me').secure().handle(this.getMe)
this.authenticated().get('/me').handle(this.getMe)
```

### Complete Chain

The full chain order is:

```typescript
this.route()
  .get('/path')              // 1. HTTP method + path (required)
  .secure()                  // 2. Require authentication (optional)
  .authorize(fn)             // 3. Custom authorization (optional)
  .middleware(fn)             // 4. Route middleware (optional, repeatable)
  .validate(zodSchema)       // 5. Request validation (optional)
  .handle(this.handlerFn)    // 6. Route handler (required, must be last)
```

## Response Helpers

`BaseController` provides response helper methods for consistent response envelopes:

### `this.ok(res, data)` — 200 OK

```typescript
this.ok(res, { user: { id: 1, name: 'Alice' } });
// Response: { "success": true, "data": { "user": { "id": 1, "name": "Alice" } } }
```

### `this.created(res, data)` — 201 Created

```typescript
this.created(res, { id: 42, name: 'New Product' });
// Response: { "success": true, "data": { "id": 42, "name": "New Product" } }
```

### `this.paginated(res, data, total, page, limit)` — Paginated

```typescript
this.paginated(res, users, 150, 2, 50);
// Response:
// {
//   "success": true,
//   "data": [...],
//   "pagination": { "total": 150, "page": 2, "limit": 50, "pages": 3 }
// }
```

### `this.noContent(res)` — 204 No Content

```typescript
this.noContent(res);
// Response: 204 with empty body (used for DELETE operations)
```

## Accessing Services in Controllers

Controllers receive `settings` and `services` via the constructor:

```typescript
class MyController extends BaseController {
  // this.settings — ApplicationSettings instance
  // this.services — ServiceContainer instance (app-level)

  async handler(req: Request, res: Response) {
    // Request-scoped service container
    const db = await req.services.get<Database>('db');
    const user = req.services.getUser<User>();
    const params = req.services.getParams<{ id: string }>();
    const input = req.services.getInput();

    // Application settings
    const apiKey = this.settings.get<string>('API_KEY');
  }
}
```

## Request Processing Pipeline

When a request hits a route, WebAFX processes it in this order:

```
Request → Route Middleware → Authentication → Authorization → Validation → Handler
```

1. **Route middleware** runs first (if any)
2. **Authentication** check: if `.secure()`, verifies `user` service exists
3. **Authorization** check: if `.authorize(fn)`, calls the authorize function
4. **Validation**: if `.validate(schema)`, validates merged request data
5. **Handler**: the controller method is called

If any step fails, an appropriate error is thrown and caught by the error handler.

## Patterns

### Pagination Pattern

```typescript
async list(req: Request, res: Response) {
  const { page = 1, limit = 20 } = req.services.getParams<{
    page?: number;
    limit?: number;
  }>();

  const db = await req.services.get<Database>('db');
  const offset = (page - 1) * limit;
  const { rows, total } = await db.query(
    'SELECT * FROM products LIMIT $1 OFFSET $2',
    [limit, offset]
  );

  this.paginated(res, rows, total, page, limit);
}
```

### Error Handling Pattern

```typescript
import { NotFoundError, ConflictError, BadRequestError } from '@blendsdk/webafx';

async create(req: Request, res: Response) {
  const data = req.services.getParams<CreateUserDTO>();
  const db = await req.services.get<Database>('db');

  // Check for duplicates
  const existing = await db.findByEmail(data.email);
  if (existing) throw new ConflictError('Email already registered');

  const user = await db.insert('users', data);
  this.created(res, { user });
}
```

---

**Back to**: [README](../README.md) | **Prev**: [Configuration](./CONFIGURATION.md) | **Next**: [Services](./SERVICES.md)
