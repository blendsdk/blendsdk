# Security Features

> **Package**: `@blendsdk/webafx`
> **Back to**: [README](../README.md)

## Overview

WebAFX includes production-ready security features out of the box: CORS, security headers via Helmet, request ID tracking, input validation, rate limiting, and error sanitization.

## Security Headers (Helmet)

WebAFX uses [Helmet](https://helmetjs.github.io/) to set secure HTTP headers automatically:

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Content-Type-Options` | `nosniff` | Prevent MIME type sniffing |
| `X-Frame-Options` | `SAMEORIGIN` | Clickjacking protection |
| `X-XSS-Protection` | `0` | Disable legacy XSS filter (CSP is preferred) |
| `Strict-Transport-Security` | `max-age=15552000` | Force HTTPS |
| `X-DNS-Prefetch-Control` | `off` | Prevent DNS prefetching |
| `X-Download-Options` | `noopen` | Prevent downloads from opening |
| `X-Permitted-Cross-Domain-Policies` | `none` | Block Flash/PDF cross-domain |
| `Referrer-Policy` | `no-referrer` | Control referrer information |
| `X-Powered-By` | (removed) | Hide Express fingerprint |

**Note**: Content-Security-Policy (CSP) and Cross-Origin-Embedder-Policy (COEP) are disabled by default to avoid breaking APIs. Configure CSP via a plugin if needed.

## CORS Configuration

CORS is configured via the `CORS` config option. See [Configuration](./CONFIGURATION.md#cors-configuration) for full details.

```typescript
// Production: restrictive
const app = new WebApplication({
  CORS: {
    origin: ['https://app.example.com'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
    maxAge: 86400,
  },
});

// Development: permissive
const app = new WebApplication({ CORS: true });
```

## CSRF Protection

### Strategy 1: SameSite Cookies (Recommended for APIs)

For **API-only applications** or **SPA backends**, SameSite cookies + CORS provide robust CSRF protection without additional tokens:

```typescript
// Set SameSite cookie in authentication handler
res.cookie('auth_token', token, {
  httpOnly: true,       // Not accessible via JavaScript
  secure: true,         // HTTPS only
  sameSite: 'strict',   // Block cross-site requests (or 'lax' for navigations)
  maxAge: 3600000,      // 1 hour
});
```

### Strategy 2: Double-Submit Cookie (For Form-Based Apps)

For **traditional server-rendered forms**, implement CSRF tokens via a plugin:

```typescript
import { PluginDefinition } from '@blendsdk/webafx';
import { doubleCsrf } from 'csrf-csrf';

const csrfPlugin: PluginDefinition = {
  name: 'csrf',
  priority: 15,
  factory: async ({ express }) => {
    const { generateToken, doubleCsrfProtection } = doubleCsrf({
      getSecret: () => process.env.CSRF_SECRET!,
      cookieName: '__Host-csrf',
      cookieOptions: { sameSite: 'strict', path: '/', secure: true },
    });

    express.use((req, res, next) => {
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        return doubleCsrfProtection(req, res, next);
      }
      next();
    });

    express.get('/csrf-token', (req, res) => {
      res.json({ csrfToken: generateToken(req, res) });
    });
  },
};
```

## Rate Limiting

WebAFX includes a built-in in-memory rate limiter:

### Global Rate Limiting

```typescript
import { rateLimitMiddleware } from '@blendsdk/webafx';

// Apply to all routes
app.express.use(rateLimitMiddleware({
  maxRequests: 100,    // 100 requests per window
  windowMs: 60000,     // 1 minute window
}));
```

### Per-Route Rate Limiting

```typescript
class ApiController extends BaseController {
  routes() {
    return [
      this.route()
        .post('/search')
        .middleware(rateLimitMiddleware({ maxRequests: 10, windowMs: 60000 }))
        .handle(this.search),
    ];
  }
}
```

### Rate Limit Options

```typescript
interface RateLimitOptions {
  maxRequests?: number;                    // Default: 100
  windowMs?: number;                       // Default: 60000 (1 min)
  keyExtractor?: (req: Request) => string; // Default: req.ip
  message?: string;                        // Default: 'Rate limit exceeded'
}
```

### Rate Limit Headers

Automatically added to all responses:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Maximum requests allowed per window |
| `X-RateLimit-Remaining` | Remaining requests in current window |
| `X-RateLimit-Reset` | Unix timestamp (seconds) when window resets |

**Note**: The built-in rate limiter uses in-memory storage. For multi-instance deployments, implement a Redis-backed rate limiter via a plugin.

## Request ID Tracking

Every request gets a unique UUID v4 correlation ID:

- Generated automatically or reused from `X-Request-ID` header (if valid UUID)
- Attached to `req.id`
- Returned in `X-Request-ID` response header
- Stored in `AsyncLocalStorage` — accessible via `getRequestId()` anywhere
- Included in error responses as `requestId`

```typescript
import { getRequestId, getRequestContext } from '@blendsdk/webafx';

// Anywhere in async request chain:
const requestId = getRequestId();
const context = getRequestContext(); // { requestId, startTime, ... }
```

## Input Validation

Zod schemas validate request data before handlers execute:

```typescript
this.route()
  .post('/users')
  .validate(z.object({
    email: z.string().email(),
    password: z.string().min(8),
    age: z.number().int().min(0).max(150),
  }))
  .handle(this.create)
```

Invalid input throws `ValidationError` (422) with detailed field errors:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "statusCode": 422,
    "details": [
      { "path": "email", "message": "Invalid email", "code": "invalid_string" },
      { "path": "password", "message": "String must contain at least 8 character(s)", "code": "too_small" }
    ]
  }
}
```

## Authentication & Authorization

### Authentication Pattern (via Plugins)

```typescript
// 1. Auth plugin sets user on each request
const authPlugin: PluginDefinition = {
  name: 'auth',
  priority: 10,
  factory: async ({ express }) => {
    express.use((req, res, next) => {
      const user = verifyToken(req);
      if (user) req.services.set('user', user);
      next();
    });
  },
};

// 2. Routes use .secure() to require authentication
this.route().get('/profile').secure().handle(this.getProfile)
// Throws 401 if user not set

// 3. Routes use .authorize() for role checks
this.route()
  .delete('/users/:id')
  .secure()
  .authorize(async (req, user) => user.role === 'admin')
  .handle(this.deleteUser)
// Throws 403 if authorization fails
```

## Error Sanitization

In production mode (`ENV_MODE: 'production'`):
- Stack traces are **never** included in error responses
- Unknown errors return generic "Internal Server Error" message
- Error details are still logged server-side

In development/test mode:
- Stack traces are included in error responses
- Original error messages are returned

## Proxy Trust

When running behind a reverse proxy (nginx, load balancer):

```typescript
const app = new WebApplication({ TRUST_PROXY: true }); // Default: true
```

This enables proper:
- Client IP detection (`req.ip`)
- Protocol detection (`req.protocol`)
- Secure cookie handling

## Security Checklist

- [ ] Set `ENV_MODE: 'production'` in production
- [ ] Configure restrictive CORS origins
- [ ] Use `httpOnly`, `secure`, `sameSite` on cookies
- [ ] Validate all input with Zod schemas
- [ ] Use `.secure()` on authenticated routes
- [ ] Use `.authorize()` for role-based access
- [ ] Apply rate limiting to sensitive endpoints
- [ ] Configure HTTPS at the proxy/load balancer level

---

**Back to**: [README](../README.md) | **Prev**: [Plugins](./PLUGINS.md) | **Next**: [Errors](./ERRORS.md)
