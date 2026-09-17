import { StandardErrorResponse } from './types.js';

/**
 * Base API error class
 * All custom errors should extend this class
 *
 * @example
 * ```typescript
 * throw new ApiError(400, 'INVALID_INPUT', 'Invalid user input', { field: 'email' });
 * ```
 */
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: any
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Convert error to standard JSON response format
   */
  toJSON(): StandardErrorResponse {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        statusCode: this.statusCode,
        timestamp: new Date().toISOString(),
        ...(this.details && { details: this.details }),
      },
    };
  }
}
