# Error Handling

> **Package**: `@blendsdk/webafx`
> **Back to**: [README](../README.md)

## Overview

WebAFX provides a structured error handling system with typed HTTP error classes, standardized JSON responses, and automatic error middleware. Throw errors anywhere in your handlers — they're caught and formatted automatically.

## Error Response Format

All errors follow the `StandardErrorResponse` format:

```typescript
interface StandardErrorResponse {
  success: false;
  error: {
    code: string;           // Machine-readable error code (e.g., 'NOT_FOUND')
    message: string;        // Human-readable message
    statusCode: number;     // HTTP status code
    timestamp: string;      // ISO 8601 timestamp
    requestId?: string;     // Correlation ID from X-Request-ID
    path?: string;          // Request path
    details?: unknown;      // Additional details (validation errors, etc.)
    stack?: string;         // Stack trace (development/test only)
  };
}
```

Example response:

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "User not found",
    "statusCode": 404,
    "timestamp": "2026-02-09T10:00:00.000Z",
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "path": "/api/users/999"
  }
}
```

## Built-in Error Classes

All error classes extend `ApiError`:

| Class | Status | Code | Default Message |
|-------|--------|------|-----------------|
| `BadRequestError` | 400 | `BAD_REQUEST` | Bad Request |
| `UnauthorizedError` | 401 | `UNAUTHORIZED` | Unauthorized |
| `ForbiddenError` | 403 | `FORBIDDEN` | Forbidden |
| `NotFoundError` | 404 | `NOT_FOUND` | Not Found |
| `ConflictError` | 409 | `CONFLICT` | Conflict |
| `ValidationError` | 422 | `VALIDATION_ERROR` | Validation Failed |
| `RateLimitError` | 429 | `RATE_LIMIT_EXCEEDED` | Rate Limit Exceeded |
| `InternalServerError` | 500 | `INTERNAL_SERVER_ERROR` | Internal Server Error |
| `ServiceUnavailableError` | 503 | `SERVICE_UNAVAILABLE` | Service Unavailable |

### Usage

```typescript
import {
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  InternalServerError,
} from '@blendsdk/webafx';

// Basic usage — just throw in any handler
throw new NotFoundError('Product not found');

// With custom details
throw new BadRequestError('Invalid input', { field: 'email', reason: 'already exists' });

// Conflict detection
throw new ConflictError('Email already registered');

// Service health issues
throw new ServiceUnavailableError('Database connection lost');
```

## ApiError Base Class

All error classes extend `ApiError`:

```typescript
class ApiError extends Error {
  constructor(
    public statusCode: number,    // HTTP status code
    public code: string,          // Machine-readable code
    message: string,              // Human-readable message
    public details?: any          // Optional additional details
  ) {}

  // Convert to standard JSON response
  toJSON(): StandardErrorResponse;
}
```

### Creating Custom Errors

```typescript
import { ApiError } from '@blendsdk/webafx';

class PaymentRequiredError extends ApiError {
  constructor(message = 'Payment Required', details?: any) {
    super(402, 'PAYMENT_REQUIRED', message, details);
  }
}

class TooManyRequestsError extends ApiError {
  constructor(retryAfter: number) {
    super(429, 'TOO_MANY_REQUESTS', 'Too many requests', { retryAfter });
  }
}
```

## Automatic Error Handling

WebAFX's error handler middleware catches all errors thrown in route handlers:

1. **ApiError instances** → Formatted using `toJSON()` with the correct status code
2. **Unknown errors** → Wrapped as 500 Internal Server Error
3. **Unmatched routes** → 404 Not Found via the catch-all handler

### Development vs Production

| Feature | Development/Test | Production |
|---------|-----------------|------------|
| Error message | Original message | Original for `ApiError`, generic for unknown |
| Stack trace | Included | Never included |
| Error details | Included | Included |
| Error logging | Server-side | Server-side |

## Validation Errors

Thrown automatically when Zod schema validation fails. Contains detailed field-level errors:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "statusCode": 422,
    "timestamp": "2026-02-09T10:00:00.000Z",
    "details": [
      { "path": "email", "message": "Invalid email", "code": "invalid_string" },
      { "path": "name", "message": "Required", "code": "invalid_type" }
    ]
  }
}
```

## 404 Handler

Unmatched routes automatically throw `NotFoundError`:

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Cannot GET /api/nonexistent",
    "statusCode": 404,
    "timestamp": "2026-02-09T10:00:00.000Z"
  }
}
```

## Error Handling Patterns

### In Controllers

```typescript
class UserController extends BaseController {
  async getById(req: Request, res: Response) {
    const { id } = req.services.getParams<{ id: string }>();
    const db = await req.services.get<Database>('db');

    const user = await db.findById('users', id);
    if (!user) {
      throw new NotFoundError(`User ${id} not found`);
    }

    this.ok(res, { user });
  }

  async create(req: Request, res: Response) {
    const data = req.services.getParams<CreateUserDTO>();
    const db = await req.services.get<Database>('db');

    const existing = await db.findByEmail(data.email);
    if (existing) {
      throw new ConflictError('Email already registered');
    }

    const user = await db.insert('users', data);
    this.created(res, { user });
  }
}
```

### Error Logging

All errors are logged server-side. The error handler uses the `logger` service (falling back to the app's ConsoleLogger):

```typescript
// Error handler calls this for every error:
async (req: Request, err: Error, data: Record<any, string>) => {
  const logger = await req.services.get('logger', this.logger);
  await logger.error(data.error, data);
};
```

---

**Back to**: [README](../README.md) | **Prev**: [Security](./SECURITY.md) | **Next**: [Logging](./LOGGING.md)
