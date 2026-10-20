import { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { ApiError } from '../errors/api-error.js';
import { StandardErrorResponse } from '../errors/types.js';

/**
 * Error handler middleware options
 */
export type onErrorLog = (req: Request, error: Error, data: Record<any, string>) => Promise<void>;

/**
 * Error handler middleware
 * Formats errors and sends appropriate responses using StandardErrorResponse format
 *
 * @param logger - Logger function for error logging
 * @param includeStack - Whether to include stack traces in responses
 *
 * @example
 * ```typescript
 * app.use(errorHandlerMiddleware(
 *   async (req, err, data) => logger.error(data.error, data),
 *   process.env.NODE_ENV === 'development'
 * ));
 * ```
 */
export function errorHandlerMiddleware(
  logger: onErrorLog,
  includeStack: boolean
): ErrorRequestHandler {
  return (async (err: Error, req: Request, res: Response, next: NextFunction) => {
    // Handle ApiError
    if (err instanceof ApiError) {
      const response: StandardErrorResponse = {
        success: false,
        error: {
          code: err.code,
          message: err.message,
          statusCode: err.statusCode,
          timestamp: new Date().toISOString(),
          requestId: req.id,
          path: req.path,
          ...(err.details && { details: err.details }),
          ...(includeStack && { stack: err.stack }),
        },
      };

      // Wrap logger in try-catch to prevent logger failures from
      // crashing error handling — the client must always get a response
      try {
        await logger(req, err, response.error as any);
      } catch {
        // Logger failed — silently continue to send the error response
      }

      return res.status(err.statusCode).json(response);
    }

    // Handle unknown errors
    const statusCode = 500;
    const message = includeStack ? err.message : 'Internal Server Error';

    const response: StandardErrorResponse = {
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message,
        statusCode,
        timestamp: new Date().toISOString(),
        requestId: req.id,
        path: req.path,
        ...(includeStack && { stack: err.stack }),
      },
    };

    // Wrap logger in try-catch to prevent logger failures from
    // crashing error handling — the client must always get a response
    try {
      await logger(req, err, response.error as any);
    } catch {
      // Logger failed — silently continue to send the error response
    }

    res.status(statusCode).json(response);
  }) as ErrorRequestHandler;
}
