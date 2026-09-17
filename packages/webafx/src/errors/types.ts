/**
 * Standard error response envelope used consistently across the application.
 * All error responses follow this format for predictable error handling.
 */
export interface StandardErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    statusCode: number;
    details?: unknown;
    timestamp: string;
    requestId?: string;
    path?: string;
    stack?: string;
  };
}

/**
 * Legacy error response format (deprecated, use StandardErrorResponse)
 * @deprecated Use StandardErrorResponse instead
 */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: any;
    statusCode: number;
    timestamp?: string;
    requestId?: string;
    path?: string;
    stack?: string;
  };
}

/**
 * Validation error detail
 */
export interface ValidationErrorDetail {
  field: string;
  message: string;
  value?: any;
}
