import { describe, test, expect, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { errorHandlerMiddleware } from '../src/application/error-handler-middleware.js';
import {
  ApiError,
  BadRequestError,
  ValidationError,
  NotFoundError,
  InternalServerError,
} from '../src/errors/http-errors.js';

describe('Error Handler Middleware', () => {
  // Helper to create mock Express objects
  function createMocks() {
    const req = {
      id: 'test-request-id',
      path: '/api/test',
    } as Request;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;

    const next = vi.fn() as NextFunction;

    const logger = vi.fn(async () => {});

    return { req, res, next, logger };
  }

  describe('ApiError Handling', () => {
    test('returns correct status code for ApiError', async () => {
      const { req, res, next, logger } = createMocks();
      const middleware = errorHandlerMiddleware(logger, false);

      const error = new BadRequestError('Invalid input');

      await middleware(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('returns error code and message for ApiError', async () => {
      const { req, res, next, logger } = createMocks();
      const middleware = errorHandlerMiddleware(logger, false);

      const error = new NotFoundError('Resource not found');

      await middleware(error, req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.objectContaining({
          code: 'NOT_FOUND',
          message: 'Resource not found',
          statusCode: 404,
        }),
      });
    });

    test('includes validation details for ValidationError', async () => {
      const { req, res, next, logger } = createMocks();
      const middleware = errorHandlerMiddleware(logger, false);

      const error = new ValidationError('Validation failed', {
        email: 'Invalid email format',
        age: 'Must be a positive number',
      });

      await middleware(error, req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.objectContaining({
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          statusCode: 422,
          details: {
            email: 'Invalid email format',
            age: 'Must be a positive number',
          },
        }),
      });
    });

    test('includes timestamp in error response', async () => {
      const { req, res, next, logger } = createMocks();
      const middleware = errorHandlerMiddleware(logger, false);

      const error = new BadRequestError('Bad request');

      await middleware(error, req, res, next);

      const call = res.json.mock.calls[0][0];
      expect(call.error.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    test('includes request ID in error response', async () => {
      const { req, res, next, logger } = createMocks();
      const middleware = errorHandlerMiddleware(logger, false);

      const error = new BadRequestError('Bad request');

      await middleware(error, req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.objectContaining({
          requestId: 'test-request-id',
        }),
      });
    });

    test('includes path in error response', async () => {
      const { req, res, next, logger } = createMocks();
      const middleware = errorHandlerMiddleware(logger, false);

      const error = new BadRequestError('Bad request');

      await middleware(error, req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.objectContaining({
          path: '/api/test',
        }),
      });
    });
  });

  describe('Stack Trace Handling', () => {
    test('includes stack trace in development mode', async () => {
      const { req, res, next, logger } = createMocks();
      const middleware = errorHandlerMiddleware(logger, true); // includeStack = true

      const error = new BadRequestError('Bad request');

      await middleware(error, req, res, next);

      const call = res.json.mock.calls[0][0];
      expect(call.error.stack).toBeDefined();
      expect(call.error.stack).toContain('BadRequestError');
    });

    test('excludes stack trace in production mode', async () => {
      const { req, res, next, logger } = createMocks();
      const middleware = errorHandlerMiddleware(logger, false); // includeStack = false

      const error = new BadRequestError('Bad request');

      await middleware(error, req, res, next);

      const call = res.json.mock.calls[0][0];
      expect(call.error.stack).toBeUndefined();
    });
  });

  describe('Unknown Error Handling', () => {
    test('returns 500 for unknown errors', async () => {
      const { req, res, next, logger } = createMocks();
      const middleware = errorHandlerMiddleware(logger, false);

      const error = new Error('Something went wrong');

      await middleware(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('hides error message in production mode', async () => {
      const { req, res, next, logger } = createMocks();
      const middleware = errorHandlerMiddleware(logger, false); // production

      const error = new Error('Database connection failed');

      await middleware(error, req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.objectContaining({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Internal Server Error', // Generic message
          statusCode: 500,
        }),
      });
    });

    test('shows error message in development mode', async () => {
      const { req, res, next, logger } = createMocks();
      const middleware = errorHandlerMiddleware(logger, true); // development

      const error = new Error('Database connection failed');

      await middleware(error, req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.objectContaining({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Database connection failed', // Real error message
          statusCode: 500,
        }),
      });
    });

    test('includes stack trace for unknown errors in development', async () => {
      const { req, res, next, logger } = createMocks();
      const middleware = errorHandlerMiddleware(logger, true);

      const error = new Error('Unexpected error');

      await middleware(error, req, res, next);

      const call = res.json.mock.calls[0][0];
      expect(call.error.stack).toBeDefined();
      expect(call.error.stack).toContain('Error: Unexpected error');
    });

    test('excludes stack trace for unknown errors in production', async () => {
      const { req, res, next, logger } = createMocks();
      const middleware = errorHandlerMiddleware(logger, false);

      const error = new Error('Unexpected error');

      await middleware(error, req, res, next);

      const call = res.json.mock.calls[0][0];
      expect(call.error.stack).toBeUndefined();
    });
  });

  describe('Logger Integration', () => {
    test('calls logger with error details', async () => {
      const { req, res, next, logger } = createMocks();
      const middleware = errorHandlerMiddleware(logger, false);

      const error = new BadRequestError('Invalid input');

      await middleware(error, req, res, next);

      expect(logger).toHaveBeenCalledTimes(1);
      expect(logger).toHaveBeenCalledWith(
        req,
        error,
        expect.objectContaining({
          code: 'BAD_REQUEST',
          message: 'Invalid input',
          statusCode: 400,
        })
      );
    });

    test('calls logger for unknown errors', async () => {
      const { req, res, next, logger } = createMocks();
      const middleware = errorHandlerMiddleware(logger, false);

      const error = new Error('Database error');

      await middleware(error, req, res, next);

      expect(logger).toHaveBeenCalledTimes(1);
      expect(logger).toHaveBeenCalledWith(
        req,
        error,
        expect.objectContaining({
          code: 'INTERNAL_SERVER_ERROR',
          statusCode: 500,
        })
      );
    });
  });

  describe('Logger Failure Resilience', () => {
    test('still sends error response when logger throws (ApiError)', async () => {
      const { req, res, next } = createMocks();
      const logger = vi.fn(async () => {
        throw new Error('Logger is broken');
      });
      const middleware = errorHandlerMiddleware(logger, false);

      const error = new BadRequestError('Invalid input');

      await middleware(error, req, res, next);

      // Logger was called but failed
      expect(logger).toHaveBeenCalledTimes(1);

      // Response was still sent
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.objectContaining({
          code: 'BAD_REQUEST',
          message: 'Invalid input',
        }),
      });
    });

    test('still sends error response when logger throws (unknown error)', async () => {
      const { req, res, next } = createMocks();
      const logger = vi.fn(async () => {
        throw new Error('Logger is broken');
      });
      const middleware = errorHandlerMiddleware(logger, false);

      const error = new Error('Something went wrong');

      await middleware(error, req, res, next);

      // Logger was called but failed
      expect(logger).toHaveBeenCalledTimes(1);

      // Response was still sent
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.objectContaining({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Internal Server Error',
        }),
      });
    });

    test('silently continues when logger throws', async () => {
      const { req, res, next } = createMocks();
      const logger = vi.fn(async () => {
        throw new Error('Logger crashed');
      });
      const middleware = errorHandlerMiddleware(logger, false);

      const error = new BadRequestError('Bad request');

      // Should not throw
      await expect(middleware(error, req, res, next)).resolves.not.toThrow();

      // Response was still sent
      expect(res.json).toHaveBeenCalled();
    });
  });

  describe('Response Format', () => {
    test('response has success: false field', async () => {
      const { req, res, next, logger } = createMocks();
      const middleware = errorHandlerMiddleware(logger, false);

      const error = new BadRequestError('Bad request');

      await middleware(error, req, res, next);

      const call = res.json.mock.calls[0][0];
      expect(call.success).toBe(false);
    });

    test('response has nested error object', async () => {
      const { req, res, next, logger } = createMocks();
      const middleware = errorHandlerMiddleware(logger, false);

      const error = new BadRequestError('Bad request');

      await middleware(error, req, res, next);

      const call = res.json.mock.calls[0][0];
      expect(call.error).toBeDefined();
      expect(typeof call.error).toBe('object');
    });

    test('error object contains all required fields', async () => {
      const { req, res, next, logger } = createMocks();
      const middleware = errorHandlerMiddleware(logger, false);

      const error = new BadRequestError('Bad request');

      await middleware(error, req, res, next);

      const call = res.json.mock.calls[0][0];
      expect(call.error).toEqual(
        expect.objectContaining({
          code: expect.any(String),
          message: expect.any(String),
          statusCode: expect.any(Number),
          timestamp: expect.any(String),
          requestId: expect.any(String),
          path: expect.any(String),
        })
      );
    });

    test('details field is optional', async () => {
      const { req, res, next, logger } = createMocks();
      const middleware = errorHandlerMiddleware(logger, false);

      // Error without details
      const error1 = new BadRequestError('Bad request');
      await middleware(error1, req, res, next);
      let call = res.json.mock.calls[0][0];
      expect(call.error.details).toBeUndefined();

      // Error with details
      res.json.mockClear();
      const error2 = new ValidationError('Validation failed', { field: 'error' });
      await middleware(error2, req, res, next);
      call = res.json.mock.calls[0][0];
      expect(call.error.details).toBeDefined();
    });
  });
});
