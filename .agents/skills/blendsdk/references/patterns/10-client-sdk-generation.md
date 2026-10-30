# Client SDK Generation Pattern

> Turn WebAFX controller routes into a committed OpenAPI contract and a typed TypeScript client.

**Packages:** `webafx`, `codegen`, `api-client`

---

## Problem

How do I give every client of my WebAFX API the same typed methods, and stop a frontend from drifting when a route changes?

## Solution

### 1. Declare routes with `.openapi()` metadata

Only routes that call `.openapi()` are collected into the contract. Routes without it stay hidden from the generated client, so your internal endpoints never leak into the public SDK.

```typescript fragment
import { BaseController, NotFoundError } from 'blendsdk/webafx';
import { Request, Response } from 'express';
import { z } from 'zod';

const productSchema = z.object({
  id: z.number(),
  name: z.string(),
  price: z.number(),
});

const errorSchema = z.object({
  success: z.boolean(),
  error: z.object({ message: z.string(), statusCode: z.number() }),
});

export class ProductsController extends BaseController {
  routes() {
    return [
      this.route()
        .get('/:id')
        .openapi({
          summary: 'Get product by ID',
          tags: ['products'], // becomes the client namespace
          operationId: 'getProduct', // becomes the method name
          pathParams: {
            id: { schema: z.coerce.number().int().min(1), description: 'Product ID' },
          },
          responses: [
            { statusCode: 200, description: 'Product details', schema: productSchema },
            { statusCode: 404, description: 'Product not found', schema: errorSchema },
          ],
        })
        .handle(this.getProduct),
    ];
  }

  async getProduct(req: Request, res: Response) {
    const { id } = req.services.getParams<{ id: number }>();
    const product = await loadProduct(id);
    if (!product) {
      throw new NotFoundError(`Product ${id} not found`);
    }
    this.ok(res, product);
  }
}
```

The metadata fields you will use most:

| Field | Purpose |
|---|---|
| `operationId` | The generated method name. It must be unique across the whole API. |
| `tags` | The generated namespace. The first tag wins. |
| `pathParams` | Zod schemas for `:param` segments the validation schema does not cover. |
| `responses` | The status codes and their response schemas. The first 2xx schema becomes the result type. |
| `envelope` | How the client reads the body. Defaults to `'data'`. |

### 2. Choose the response envelope

`envelope: 'data'` (the default) returns only the `data` property of the standard success body. `envelope: 'body'` returns the whole body, which paginated responses need to keep their `pagination` object.

```typescript fragment
this.route()
  .get('/')
  .openapi({
    summary: 'List products',
    tags: ['products'],
    operationId: 'listProducts',
    envelope: 'body', // keep { success, data, pagination }
    responses: [
      // The schema describes one item; the client wraps it as PaginatedResponse<T>.
      { statusCode: 200, description: 'One product', schema: productSchema },
    ],
  })
  .validate(listQuerySchema)
  .handle(this.listProducts);
```

A paginated route usually calls `this.paginated(res, items, total, page, limit)`, which produces `{ success: true, data: items, pagination: { total, page, limit, pages } }`.

### 3. Describe the contract in `blendsdk.api.ts`

A single file names the controllers and where the artifacts go.

```typescript fragment
import { defineApiContract } from 'blendsdk/codegen';
import { ProductsController } from './src/controllers/products-controller.js';

export default defineApiContract({
  outputDir: 'src/api-client',
  contractFile: 'api.json',
  controllers: [{ basePath: '/api/products', controller: ProductsController }],
  openapi: {
    title: 'My API',
    version: '1.0.0',
    servers: [{ url: 'http://localhost:3000', description: 'Local development server' }],
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    defaultSecurity: [{ bearerAuth: [] }],
  },
  generator: { runtimeImport: 'blendsdk/api-client' },
});
```

- `outputDir` and `contractFile` are resolved relative to the config file and must not escape it.
- `contractFile` defaults to `api.json`.
- `controllers` is the list of `{ basePath, controller }` registrations. The `basePath` is the same one you pass to `app.registerController()`.
- `generator.runtimeImport` is the import specifier the generated client uses. The default is `blendsdk/api-client`.

The CLI finds the config through `--config <path>`, or by searching upward for `blendsdk.api.ts` until it reaches the repository root.

### 4. Generate and check from the CLI

```bash
blendsdk api generate --config blendsdk.api.ts   # writes api.json, then the client
blendsdk api check --config blendsdk.api.ts      # fails with exit 1 on drift
```

- `generate` rebuilds the OpenAPI document from the controllers, writes `api.json`, and writes the client.
- `check` does the same rebuild in memory and compares it against the committed files. It writes nothing.
- Exit codes: `0` clean, `1` drift or operational failure, `2` usage or configuration failure. Run `blendsdk api --help` for the command list.

### 5. What the generator writes

Three files land in `outputDir`. Each one is prefixed with a marker line so the generator knows what it owns.

```typescript fragment
// src/api-client/client.ts (generated — do not edit)
export interface AppClient {
  products: {
    getProduct: (
      params: ProductsGetProductParams,
      options?: RequestOptions
    ) => Promise<ProductsGetProductResult>;
    listProducts: (
      params: ProductsListProductsParams,
      options?: RequestOptions
    ) => Promise<ProductsListProductsResult>;
  };
}

export function createAppClient(options: ApiClientOptions): AppClient {
  const runtime = createApiClient(options);
  return {
    products: {
      // one method per operation, each forwarding a flat params object
    },
  };
}
```

```typescript fragment
// src/api-client/types.ts (generated — do not edit)
export type ProductsGetProductParams = { id: number };

export type ProductsGetProductResult = {
  id: number;
  name: string;
  price: number;
};
```

`index.ts` re-exports both files. With `generator.splitByGroup: true`, the generator writes one `client.<group>.ts` file per tag group and `client.ts` becomes the barrel.

### 6. Consume the generated client

Import the factory from the generated `index.ts`. The parameter and the result are typed from the contract, so renaming a field on the server fails the client build.

```typescript fragment
import { createAppClient, type AppClient } from './api-client/index.js';

const client = createAppClient({ baseUrl: 'http://localhost:3000' });

const product = await client.products.getProduct({ id: 42 });
console.log(product.name); // typed as string
```

### 7. Read a paginated body

For an operation declared with `envelope: 'body'`, the result is `PaginatedResponse<T>`, where `T` is the item type in `data`.

```typescript fragment
const page = await client.products.listProducts({ page: 1, limit: 20 });

console.log(page.success); // true
console.log(page.data.length); // items on this page
console.log(page.pagination.total); // items across all pages
console.log(page.pagination.pages); // total number of pages
```

`PaginatedResponse<T>` is `{ success: true; data: T[]; pagination: { total; page; limit; pages } }`. The runtime owns the type, so a browser client never imports the server package.

### 8. Add authentication

Pass an `AuthStrategy` through `ApiClientOptions` when you create the client. The runtime applies it to every request from that client.

```typescript fragment
import { BearerAuth } from 'blendsdk/api-client';
import { createAppClient } from './api-client/index.js';

const auth = new BearerAuth({
  getToken: () => session.accessToken,
  refresh: () => session.refresh(), // refreshed once and retried on a 401
});

const client = createAppClient({ baseUrl: '/api', auth });
```

`CookieSessionAuth` sends the browser's session cookie instead and needs no token handling.

```typescript fragment
import { CookieSessionAuth } from 'blendsdk/api-client';

const client = createAppClient({ baseUrl: '/api', auth: new CookieSessionAuth() });
```

Each strategy also has a `scheme` name that matches the OpenAPI security scheme. `BearerAuth` uses `bearerAuth`; `CookieSessionAuth` uses `cookie`.

## Key Points

- **`.openapi()` is opt-in** — a route without it is never in the contract, so internal routes stay hidden.
- **The first tag is the namespace** and **`operationId` is the method name**. Both are sanitized to valid JavaScript identifiers, and a reserved word gets a trailing underscore.
- **`envelope: 'data'`** (default) returns `body.data`; **`envelope: 'body'`** returns the whole body and is required for pagination through `PaginatedResponse<T>`.
- **`blendsdk api check` compares bytes** — it rebuilds `api.json` and every generated file in memory and exits `1` if any of them differ. The committed artifacts cannot drift from the controllers.
- **Commit `blendsdk.api.ts`, `api.json`, and the generated client directory**, then run `check` in CI so drift is caught without a database or a running server.
- **The runtime has no dependencies** — `blendsdk/api-client` does not import Zod, so the client bundle stays small and the project keeps one Zod version.
