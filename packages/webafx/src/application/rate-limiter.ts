import { NextFunction, Request, Response } from 'express';
import { RateLimitError } from '../errors/http-errors.js';

/**
 * Configuration options for rate limiting middleware.
 */
export interface RateLimitOptions {
  /** Maximum requests per window. Default: 100 */
  maxRequests?: number;
  /** Window duration in milliseconds. Default: 60000 (1 minute) */
  windowMs?: number;
  /** Key extractor function. Default: uses IP address */
  keyExtractor?: (req: Request) => string;
  /** Optional message for rate limit errors */
  message?: string;
}

/**
 * Creates a rate limiting middleware.
 * Uses in-memory storage — suitable for single-instance deployments.
 * For multi-instance deployments, use a Redis-backed implementation via plugins.
 *
 * @param options - Rate limiting configuration options
 * @returns Express middleware function
 *
 * @example
 * ```typescript
 * // Global rate limiting
 * app.express.use(rateLimitMiddleware({ maxRequests: 100, windowMs: 60000 }));
 *
 * // Per-route rate limiting
 * this.route().get('/api/search')
 *   .middleware(rateLimitMiddleware({ maxRequests: 10, windowMs: 60000 }))
 *   .handle(this.search);
 * ```
 */
export function rateLimitMiddleware(options?: RateLimitOptions) {
  const {
    maxRequests = 100,
    windowMs = 60_000,
    keyExtractor = (req: Request) => req.ip || 'unknown',
    message = 'Rate limit exceeded',
  } = options || {};

  // In-memory storage: key -> { count, resetTime }
  const hits: Map<string, { count: number; resetTime: number }> = new Map();

  // Periodic cleanup to prevent memory leaks
  // Runs every windowMs to remove expired entries
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of hits) {
      if (value.resetTime <= now) {
        hits.delete(key);
      }
    }
  }, windowMs);

  // Prevent cleanup interval from keeping process alive
  if (cleanup.unref) cleanup.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyExtractor(req);
    const now = Date.now();
    const record = hits.get(key);

    // First request or window expired — create new record
    if (!record || record.resetTime <= now) {
      hits.set(key, { count: 1, resetTime: now + windowMs });
      setRateLimitHeaders(res, maxRequests, maxRequests - 1, now + windowMs);
      return next();
    }

    // Increment counter for existing window
    record.count += 1;

    // Rate limit exceeded
    if (record.count > maxRequests) {
      setRateLimitHeaders(res, maxRequests, 0, record.resetTime);
      throw new RateLimitError(message);
    }

    // Within limit
    setRateLimitHeaders(res, maxRequests, maxRequests - record.count, record.resetTime);
    next();
  };
}

/**
 * Sets standard rate limit headers on the response.
 *
 * @param res - Express response object
 * @param limit - Maximum requests allowed
 * @param remaining - Remaining requests in current window
 * @param reset - Unix timestamp (seconds) when the window resets
 * @internal
 */
function setRateLimitHeaders(res: Response, limit: number, remaining: number, reset: number): void {
  res.setHeader('X-RateLimit-Limit', limit);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, remaining));
  res.setHeader('X-RateLimit-Reset', Math.ceil(reset / 1000));
}
