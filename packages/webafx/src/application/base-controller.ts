import { Response } from 'express';
import { ApplicationSettings } from './application-settings.js';
import { RouteBuilder, RouteDefinition } from './route-builder.js';
import { ServiceContainer } from './service-container.js';

/**
 * Standard success response envelope
 */
export interface StandardSuccessResponse<T = unknown> {
  success: true;
  data: T;
}

/**
 * Paginated response envelope
 */
export interface PaginatedResponse<T = unknown> {
  success: true;
  data: T[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
}

/**
 * Base class for all application controllers.
 * Provides route building utilities, response helpers, and access to application settings.
 *
 * @remarks
 * Controllers should extend this class and implement the routes() method
 * to define their HTTP endpoints. Use the route() and authenticated() helper
 * methods to build route definitions with a fluent API.
 *
 * Response helpers (ok, created, paginated, noContent) provide consistent
 * response formats across the application.
 */
export abstract class BaseController {
  /**
   * Creates a new controller instance.
   *
   * @param settings - Application settings passed from WebApplication
   * @param services - Service container for dependency injection
   */
  constructor(
    protected settings: ApplicationSettings,
    protected services: ServiceContainer
  ) {}

  /**
   * Defines the routes for this controller.
   * Must be implemented by subclasses.
   *
   * @returns Array of route definitions
   */
  abstract routes(): RouteDefinition[];

  /**
   * Creates a new route builder for defining routes.
   *
   * @returns A new RouteBuilder instance
   */
  protected route(): RouteBuilder {
    return new RouteBuilder();
  }

  /**
   * Creates a new route builder with authentication required.
   * Shorthand for route().secure().
   *
   * @returns A new RouteBuilder instance with secure flag set
   */
  protected authenticated(): RouteBuilder {
    return this.route().secure();
  }

  /**
   * Send a successful 200 OK response with data.
   *
   * @param res - Express response object
   * @param data - Data to send in the response
   *
   * @example
   * ```typescript
   * this.ok(res, { user: { id: 1, name: 'John' } });
   * // Response: { success: true, data: { user: { id: 1, name: 'John' } } }
   * ```
   */
  protected ok<T>(res: Response, data: T): void {
    res.json({ success: true, data } as StandardSuccessResponse<T>);
  }

  /**
   * Send a 201 Created response with data.
   *
   * @param res - Express response object
   * @param data - Data to send in the response
   *
   * @example
   * ```typescript
   * this.created(res, { id: 123, name: 'New Item' });
   * // Response: { success: true, data: { id: 123, name: 'New Item' } }
   * ```
   */
  protected created<T>(res: Response, data: T): void {
    res.status(201).json({ success: true, data } as StandardSuccessResponse<T>);
  }

  /**
   * Send a paginated response with metadata.
   *
   * @param res - Express response object
   * @param data - Array of items for the current page
   * @param total - Total number of items across all pages
   * @param page - Current page number (1-indexed)
   * @param limit - Number of items per page
   *
   * @example
   * ```typescript
   * this.paginated(res, users, 150, 2, 50);
   * // Response: {
   * //   success: true,
   * //   data: [...],
   * //   pagination: { total: 150, page: 2, limit: 50, pages: 3 }
   * // }
   * ```
   */
  protected paginated<T>(
    res: Response,
    data: T[],
    total: number,
    page: number,
    limit: number
  ): void {
    res.json({
      success: true,
      data,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    } as PaginatedResponse<T>);
  }

  /**
   * Send a 204 No Content response.
   * Typically used for successful DELETE operations or updates with no return value.
   *
   * @param res - Express response object
   *
   * @example
   * ```typescript
   * // DELETE /users/123
   * await userService.delete(id);
   * this.noContent(res);
   * ```
   */
  protected noContent(res: Response): void {
    res.status(204).end();
  }
}
