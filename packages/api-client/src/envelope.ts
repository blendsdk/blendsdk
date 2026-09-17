/**
 * Response envelope handling.
 *
 * Every successful WebAFX response is wrapped as `{ success: true, data }`,
 * except paginated responses that also carry a `pagination` object. An
 * operation's `envelope` says which part a generated method returns.
 *
 * @module
 */

/**
 * The body returned by a paginated operation when its envelope is `'body'`.
 *
 * Mirrors `BaseController.paginated()` on the server. The runtime owns this
 * type so browser clients never import the server package.
 */
export interface PaginatedResponse<T> {
  /** Always true for a successful paginated response. */
  success: true;
  /** The page of items. */
  data: T[];
  /** Pagination metadata. */
  pagination: {
    /** Total number of matching items. */
    total: number;
    /** 1-based page number. */
    page: number;
    /** Page size. */
    limit: number;
    /** Total number of pages. */
    pages: number;
  };
}

/**
 * Applies an operation's envelope to a successful response body.
 *
 * @param envelope - The operation's envelope.
 * @param body - The parsed response body.
 * @returns The payload for a `'data'` envelope, or the whole body for `'body'`.
 *
 * @example
 * ```typescript
 * unwrapResponse<{ id: number }>('data', { success: true, data: { id: 1 } }); // { id: 1 }
 * ```
 */
export function unwrapResponse<T>(envelope: 'data' | 'body', body: unknown): T {
  if (envelope === 'body') {
    return body as T;
  }
  if (typeof body === 'object' && body !== null && 'data' in body) {
    return (body as { data: T }).data;
  }
  return body as T;
}
