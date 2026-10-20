# Middleware

> **Package**: `@blendsdk/webafx`
> **Back to**: [README](../README.md)

## Overview

WebAFX uses Express middleware at multiple levels: built-in core middleware (applied automatically), plugin middleware (applied during installation), and route-level middleware (applied per-route via `RouteBuilder`).

## Built-in Middleware

Applied automatically during `app.start()` in this order:

| # | Middleware | Description |
|---|-----------|-------------|
| 1 | Trust Proxy | `app.set('trust proxy', 1)` if `TRUST_PROXY: true` |
| 2 | CORS | `cors()` with configured options (if `CORS` is set) |
| 3 | Cookie Parser | `cookieParser()` for cookie handling |
| 4 | Body Parsers | `express.json()` and `express.urlencoded()` with `BODY_LIMIT` |
| 5 | Request ID | UUID generation, `X-Request-ID` header, `AsyncLocalStorage` context |
| 6 | Request Timing | Logs `METHOD path statusCode duration` after response |
| 7 | Security Headers | Helmet with CSP and COEP disabled |
| 8 | Service Container | Creates per-request `ServiceContainer` on `req.services` |
| 9 | Plugin Middleware | All registered plugins (in priority order) |
| 9a | Static Files | `staticFilesPlugin()` — static serving + SPA fallback (if registered) |
| 10 | Controller Routes | All registered controller routes |
| 11 | Health Check | `GET /health` endpoint |
| 12 | 404 Handler | Catch-all for unmatched routes |
| 13 | Error Handler | Formats and returns error responses |

## Request ID Middleware

Generates a unique UUID v4 for every request:

```typescript
import { requestIdMiddleware } from '@blendsdk/webafx';

// Already applied by WebApplication — no manual setup needed
// But can be used standalone:
app.express.use(requestIdMiddleware());
```

**Behavior**:
- If `X-Request-ID` header contains a valid UUID → reuses it
- Otherwise → generates a new UUID v4
- Attaches to `req.id`
- Sets `X-Request-ID` response header
- Creates `AsyncLocalStorage` context with `{ requestId, startTime }`

**Access anywhere in async chain**:

```typescript
import { getRequestId, getRequestContext } from '@blendsdk/webafx';

const id = getRequestId();           // 'abc-123-...'
const ctx = getRequestContext();      // { requestId: '...', startTime: 1234567890 }
```

## Rate Limit Middleware

See [Security > Rate Limiting](./SECURITY.md#rate-limiting) for full details.

```typescript
import { rateLimitMiddleware } from '@blendsdk/webafx';

// Global
app.express.use(rateLimitMiddleware({ maxRequests: 100, windowMs: 60000 }));

// Per-route
this.route()
  .post('/search')
  .middleware(rateLimitMiddleware({ maxRequests: 10, windowMs: 60000 }))
  .handle(this.search);
```

## Error Handler Middleware

Catches all errors thrown in route handlers:

```typescript
import { errorHandlerMiddleware } from '@blendsdk/webafx';

// Already applied by WebApplication — no manual setup needed
// Signature:
errorHandlerMiddleware(
  logger: (req: Request, error: Error, data: Record<any, string>) => Promise<void>,
  includeStack: boolean
): ErrorRequestHandler
```

- `ApiError` instances → formatted with correct status code
- Unknown errors → wrapped as 500
- Stack traces included only if `includeStack` is true (non-production)

## Route-Level Middleware

Add middleware to specific routes via `RouteBuilder`:

```typescript
class MyController extends BaseController {
  routes() {
    return [
      this.route()
        .get('/data')
        .middleware(customCacheMiddleware)
        .middleware(rateLimitMiddleware({ maxRequests: 5 }))
        .handle(this.getData),
    ];
  }
}
```

Middleware runs in the order added, **before** authentication, authorization, validation, and the handler.

## Custom Middleware Examples

### Request Logger

```typescript
import { NextFunction, Request, Response } from 'express';

function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${req.method}] ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });

  next();
}
```

### API Key Authentication

```typescript
import { UnauthorizedError } from '@blendsdk/webafx';

function apiKeyMiddleware(validKeys: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const apiKey = req.headers['x-api-key'] as string;
    if (!apiKey || !validKeys.includes(apiKey)) {
      throw new UnauthorizedError('Invalid or missing API key');
    }
    next();
  };
}

// Usage on a route
this.route()
  .get('/data')
  .middleware(apiKeyMiddleware(['key-123', 'key-456']))
  .handle(this.getData);
```

### Response Caching

```typescript
function cacheMiddleware(ttlSeconds: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', `public, max-age=${ttlSeconds}`);
    next();
  };
}
```

## Middleware Execution Order

For a route with middleware, the full execution order is:

```
1. Global middleware (CORS, body parser, request ID, helmet, etc.)
2. Plugin middleware (in priority order)
3. Service container attachment
4. Route-level middleware (in order added)
5. Authentication check (.secure())
6. Authorization check (.authorize())
7. Validation (.validate())
8. Route handler
9. Error handler (if error thrown)
```

---

**Back to**: [README](../README.md) | **Prev**: [Logging](./LOGGING.md) | **Next**: [Testing](./TESTING.md)
