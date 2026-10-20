import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { RequestContext, requestContextStorage } from './request-context.js';

/**
 * UUID v4 format regex pattern.
 * Validates standard UUID format: 8-4-4-4-12 hex characters.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates whether a string is a valid UUID v4 format.
 *
 * @param id - The string to validate
 * @returns True if the string matches UUID v4 format
 */
export function isValidUUID(id: string): boolean {
  return UUID_REGEX.test(id);
}

/**
 * Request ID middleware.
 * Generates a unique correlation ID for each request and propagates it through
 * AsyncLocalStorage for access anywhere in the request lifecycle.
 * Attaches it to req.id and X-Request-ID response header.
 *
 * If the incoming request has an X-Request-ID header with a valid UUID format,
 * it is reused. Otherwise, a new UUID is generated. This prevents malformed
 * or malicious request IDs from propagating through the system.
 *
 * @remarks
 * The request context is stored in AsyncLocalStorage, making the request ID
 * accessible via `getRequestId()` or `getRequestContext()` anywhere in the
 * async call chain without explicitly passing it through parameters.
 *
 * @example
 * ```typescript
 * app.use(requestIdMiddleware());
 * ```
 */
export function requestIdMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    // Check if request already has a valid UUID from upstream proxy
    const existingId = req.headers['x-request-id'] as string;

    // Only reuse existing ID if it's a valid UUID format;
    // reject malformed IDs to prevent injection or log corruption
    const requestId = existingId && isValidUUID(existingId) ? existingId : randomUUID();

    // Attach to request
    req.id = requestId;

    // Add to response headers
    res.setHeader('X-Request-ID', requestId);

    // Create request context and run the rest of the request in AsyncLocalStorage
    const context: RequestContext = {
      requestId,
      startTime: Date.now(),
    };

    // All async operations from this point have access to the context
    requestContextStorage.run(context, () => next());
  };
}
