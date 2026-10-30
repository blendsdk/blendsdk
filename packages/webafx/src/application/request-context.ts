import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request context data propagated through async operations.
 * Contains request-scoped information accessible anywhere in the request lifecycle.
 */
export interface RequestContext {
  /** Unique request ID for tracing */
  requestId: string;
  /** Request start time (milliseconds since epoch) */
  startTime: number;
  /** Additional context properties can be added dynamically */
  [key: string]: unknown;
}

/**
 * Shared AsyncLocalStorage instance for request context propagation.
 * This enables accessing request-scoped data anywhere in the async call chain
 * without explicitly passing it through function parameters.
 *
 * @remarks
 * AsyncLocalStorage is a Node.js feature that maintains context across async operations.
 * Each request runs in its own context, preventing cross-request contamination.
 *
 * @example
 * ```typescript
 * // In middleware:
 * requestContextStorage.run(context, () => {
 *   next(); // All async operations from here have access to context
 * });
 *
 * // Anywhere in the request lifecycle:
 * const context = getRequestContext();
 * console.log(context?.requestId);
 * ```
 */
export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Gets the current request context if inside a request scope.
 *
 * @returns Request context object, or undefined if called outside request scope
 *
 * @example
 * ```typescript
 * const context = getRequestContext();
 * if (context) {
 *   logger.info('Processing request', { requestId: context.requestId });
 * }
 * ```
 */
export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

/**
 * Gets the current request ID if inside a request scope.
 *
 * @returns Request ID string, or undefined if called outside request scope
 *
 * @example
 * ```typescript
 * const requestId = getRequestId();
 * await database.query('SELECT * FROM users WHERE id = ?', [userId], { requestId });
 * ```
 */
export function getRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}
