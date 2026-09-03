import { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodType, z } from 'zod';

/**
 * Supported HTTP methods for routes.
 */
export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * Response definition for OpenAPI documentation.
 * Describes a possible response from an API endpoint.
 *
 * @remarks
 * This is pure metadata — no generation logic lives in webafx.
 * The actual OpenAPI spec generation happens in `@blendsdk/codegen`.
 */
export interface OpenAPIResponseDefinition {
  /** HTTP status code (e.g., 200, 201, 400, 404) */
  statusCode: number;
  /** Human-readable description of this response */
  description: string;
  /** Optional Zod schema describing the response body structure */
  schema?: ZodType;
}

/**
 * Optional OpenAPI metadata for route documentation.
 *
 * Only routes with this metadata will be included in generated OpenAPI specs.
 * This serves as the opt-in mechanism: routes without `.openapi()` are excluded
 * from the generated specification, keeping internal routes hidden.
 *
 * @remarks
 * This is pure data — no generation logic lives in webafx.
 * The actual OpenAPI spec generation happens in `@blendsdk/codegen`.
 *
 * @example
 * ```typescript
 * this.route()
 *   .get('/')
 *   .openapi({
 *     summary: 'List products',
 *     tags: ['products'],
 *     responses: [
 *       { statusCode: 200, description: 'Paginated product list' }
 *     ]
 *   })
 *   .validate(productQuerySchema)
 *   .handle(this.listProducts);
 * ```
 */
export interface OpenAPIRouteMetadata {
  /** Short summary of the route (appears in path listing) */
  summary?: string;
  /** Detailed description of the route (supports markdown) */
  description?: string;
  /** Tags for grouping routes in the spec (e.g., 'products', 'auth') */
  tags?: string[];
  /** Unique operation identifier for the route */
  operationId?: string;
  /** Mark route as deprecated in the spec */
  deprecated?: boolean;
  /**
   * Path parameter schemas for parameters not covered by the validation schema.
   * Each key is the parameter name (matching the Express `:param` in the path).
   */
  pathParams?: Record<string, { schema: ZodType; description?: string }>;
  /** Response definitions describing possible responses from this endpoint */
  responses?: OpenAPIResponseDefinition[];
}

/**
 * Route handler function signature.
 * Handles HTTP requests and can be async or sync.
 */
export type RouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<void> | void;

/**
 * Authorization function that determines if a user can access a route.
 *
 * @template T - User type
 * @param req - Express request object
 * @param user - Authenticated user object
 * @returns True if authorized, false otherwise
 */
export type AuthorizeFunction<T = any> = (req: Request, user: T) => boolean | Promise<boolean>;

/**
 * Complete route definition with all configuration.
 */
export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  handler: RouteHandler;
  validation?: ZodType;
  secure?: boolean;
  authorize?: AuthorizeFunction;
  middleware?: RequestHandler[];
  /**
   * Optional OpenAPI metadata for this route.
   * Routes without this field are excluded from generated OpenAPI specs.
   * This is the opt-in mechanism for API documentation.
   */
  openapi?: OpenAPIRouteMetadata;
}

/**
 * Fluent API builder for defining HTTP routes.
 * Provides a chainable interface for configuring route properties.
 *
 * @remarks
 * Use this class to build route definitions with method chaining:
 * - HTTP method (get, post, put, patch, delete)
 * - Path
 * - Authentication (secure)
 * - Authorization (authorize)
 * - Validation (validate)
 * - Handler function (handle)
 */
export class RouteBuilder {
  private definition: Partial<RouteDefinition> = {};

  /**
   * Defines a GET route.
   *
   * @param path - URL path for the route
   * @returns This builder instance for method chaining
   */
  get(path: string): this {
    this.definition.method = 'get';
    this.definition.path = path;
    return this;
  }

  /**
   * Defines a POST route.
   *
   * @param path - URL path for the route
   * @returns This builder instance for method chaining
   */
  post(path: string): this {
    this.definition.method = 'post';
    this.definition.path = path;
    return this;
  }

  /**
   * Defines a PUT route.
   *
   * @param path - URL path for the route
   * @returns This builder instance for method chaining
   */
  put(path: string): this {
    this.definition.method = 'put';
    this.definition.path = path;
    return this;
  }

  /**
   * Defines a PATCH route.
   *
   * @param path - URL path for the route
   * @returns This builder instance for method chaining
   */
  patch(path: string): this {
    this.definition.method = 'patch';
    this.definition.path = path;
    return this;
  }

  /**
   * Defines a DELETE route.
   *
   * @param path - URL path for the route
   * @returns This builder instance for method chaining
   */
  delete(path: string): this {
    this.definition.method = 'delete';
    this.definition.path = path;
    return this;
  }

  /**
   * Marks the route as requiring authentication.
   * Authenticated user must be present in request.services.
   *
   * @returns This builder instance for method chaining
   */
  secure(): this {
    this.definition.secure = true;
    return this;
  }

  /**
   * Adds authorization check to the route.
   * Called after authentication if route is secure.
   *
   * @param authorizeFn - Function that determines if user is authorized
   * @returns This builder instance for method chaining
   */
  authorize(authorizeFn: AuthorizeFunction): this {
    this.definition.authorize = authorizeFn;
    return this;
  }

  /**
   * Adds middleware to this route. Can be called multiple times.
   * Middleware runs in order before the route handler.
   *
   * @param fn - Middleware function to add
   * @returns This builder instance for method chaining
   *
   * @example
   * ```typescript
   * this.route()
   *   .get('/admin')
   *   .middleware(authMiddleware)
   *   .middleware(rateLimitMiddleware)
   *   .handle(fn);
   * ```
   */
  middleware(fn: RequestHandler): this {
    if (!this.definition.middleware) {
      this.definition.middleware = [];
    }
    this.definition.middleware.push(fn);
    return this;
  }

  /**
   * Attaches OpenAPI metadata to this route.
   *
   * Only routes with this metadata will appear in generated OpenAPI specs.
   * Routes without `.openapi()` are excluded, keeping internal routes hidden.
   *
   * @param meta - OpenAPI metadata for this route
   * @returns This builder instance for method chaining
   *
   * @example
   * ```typescript
   * this.route()
   *   .get('/:id')
   *   .openapi({
   *     summary: 'Get product by ID',
   *     tags: ['products'],
   *     pathParams: { id: { schema: z.coerce.number(), description: 'Product ID' } },
   *     responses: [
   *       { statusCode: 200, description: 'Product details' },
   *       { statusCode: 404, description: 'Product not found' }
   *     ]
   *   })
   *   .handle(this.getProduct);
   * ```
   */
  openapi(meta: OpenAPIRouteMetadata): this {
    this.definition.openapi = meta;
    return this;
  }

  /**
   * Adds request validation using a Zod schema.
   * Validates merged params, query, and body data.
   *
   * @param schema - Zod validation schema
   * @returns This builder instance for method chaining
   * @template TSchema - Zod schema type
   */
  validate<TSchema extends ZodType>(
    schema: TSchema
  ): RouteBuilder {
    this.definition.validation = schema;
    return this as any;
  }

  /**
   * Sets the route handler function and finalizes the route definition.
   * This must be the last method called in the chain.
   *
   * @param handler - Route handler function
   * @returns Complete route definition
   * @throws {Error} If handler is not a function
   * @throws {Error} If method or path not set
   */
  handle(handler: RouteHandler): RouteDefinition {
    // Validate that handler is a function
    if (typeof handler !== 'function') {
      throw new Error(
        `Route handler must be a function, received: ${typeof handler}. ` +
        `Path: ${this.definition.path || 'unknown'}, Method: ${this.definition.method || 'unknown'}`
      );
    }

    // Validate that required route properties are set
    if (!this.definition.method) {
      throw new Error('Route method must be set before calling handle()');
    }

    if (!this.definition.path) {
      throw new Error('Route path must be set before calling handle()');
    }

    this.definition.handler = handler;
    return this.definition as RouteDefinition;
  }
}
