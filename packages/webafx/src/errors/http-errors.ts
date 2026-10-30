import { ApiError } from './api-error.js';

/**
 * 400 Bad Request
 */
export class BadRequestError extends ApiError {
  constructor(message = 'Bad Request', details?: any) {
    super(400, 'BAD_REQUEST', message, details);
  }
}

/**
 * 401 Unauthorized
 */
export class UnauthorizedError extends ApiError {
  constructor(message = 'Unauthorized', details?: any) {
    super(401, 'UNAUTHORIZED', message, details);
  }
}

/**
 * 403 Forbidden
 */
export class ForbiddenError extends ApiError {
  constructor(message = 'Forbidden', details?: any) {
    super(403, 'FORBIDDEN', message, details);
  }
}

/**
 * 404 Not Found
 */
export class NotFoundError extends ApiError {
  constructor(message = 'Not Found', details?: any) {
    super(404, 'NOT_FOUND', message, details);
  }
}

/**
 * 409 Conflict
 */
export class ConflictError extends ApiError {
  constructor(message = 'Conflict', details?: any) {
    super(409, 'CONFLICT', message, details);
  }
}

/**
 * 422 Validation Error
 */
export class ValidationError extends ApiError {
  constructor(message = 'Validation Failed', details?: any) {
    super(422, 'VALIDATION_ERROR', message, details);
  }
}

/**
 * 429 Rate Limit Exceeded
 */
export class RateLimitError extends ApiError {
  constructor(message = 'Rate Limit Exceeded', details?: any) {
    super(429, 'RATE_LIMIT_EXCEEDED', message, details);
  }
}

/**
 * 500 Internal Server Error
 */
export class InternalServerError extends ApiError {
  constructor(message = 'Internal Server Error', details?: any) {
    super(500, 'INTERNAL_SERVER_ERROR', message, details);
  }
}

/**
 * 503 Service Unavailable
 */
export class ServiceUnavailableError extends ApiError {
  constructor(message = 'Service Unavailable', details?: any) {
    super(503, 'SERVICE_UNAVAILABLE', message, details);
  }
}
