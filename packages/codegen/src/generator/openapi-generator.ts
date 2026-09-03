import fs from 'fs';
import path from 'path';
import type { RouteDefinition, HttpMethod } from '@blendsdk/webafx';
import type {
  OpenAPIDocument,
  OpenAPIGeneratorConfig,
  OpenAPIOperation,
  OpenAPIPathItem,
  OpenAPIResponse,
  OpenAPIParameter,
  OpenAPISchema,
  SecurityRequirement,
} from './openapi-types.js';
import { zodToOpenAPISchema, zodToQueryParameters } from './zod-to-openapi.js';

/**
 * Constructor type for webafx controllers.
 * Controllers must accept (settings, services) and implement routes().
 *
 * @remarks
 * Uses a loose constructor signature so codegen doesn't need to import
 * the full ApplicationSettings/ServiceContainer types at runtime.
 */
export type ControllerConstructor = new (settings: any, services: any) => {
  routes(): RouteDefinition[];
};

/**
 * Internal representation of a collected route with its base path.
 * Routes are collected from controllers and stored for document generation.
 */
interface CollectedRoute {
  /** The controller's base path (e.g., '/api/products') */
  basePath: string;
  /** The complete route definition from the controller */
  definition: RouteDefinition;
}

/**
 * Generates OpenAPI v3.1 specification documents from webafx controller routes.
 *
 * This generator reads route definitions (with their Zod validation schemas
 * and OpenAPI metadata) and produces a complete OpenAPI 3.1.0 document.
 * Only routes that have been annotated with `.openapi()` metadata are included
 * in the generated specification — this is the opt-in mechanism.
 *
 * @remarks
 * - This class does NOT extend the existing codegen `Generator` base class
 *   because it operates on webafx routes, not on database schemas.
 * - Controllers are instantiated with empty mock settings/services since
 *   `routes()` only builds RouteDefinition objects (no side effects).
 * - Zod→OpenAPI schema conversion is handled by dedicated protected methods
 *   that can be overridden or extended.
 *
 * @example
 * ```typescript
 * import { OpenAPIGenerator } from '@blendsdk/codegen';
 * import { ProductsController } from './controllers/products.controller.js';
 *
 * const generator = new OpenAPIGenerator({
 *   title: 'My API',
 *   version: '1.0.0',
 *   servers: [{ url: 'http://localhost:3000' }],
 *   securitySchemes: {
 *     bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
 *   },
 *   defaultSecurity: [{ bearerAuth: [] }]
 * });
 *
 * generator.addController('/api/products', ProductsController);
 *
 * const spec = generator.generate();
 * generator.toFile('./openapi.json');
 * ```
 */
export class OpenAPIGenerator {
  /** Generator configuration (API info, servers, security) */
  protected config: OpenAPIGeneratorConfig;

  /** Collected routes from controllers (only those with .openapi() metadata) */
  protected routes: CollectedRoute[];

  /**
   * Creates a new OpenAPIGenerator instance.
   *
   * @param config - Generator configuration with API metadata and security settings
   */
  constructor(config: OpenAPIGeneratorConfig) {
    this.config = config;
    this.routes = [];
  }

  /**
   * Add a controller class — instantiates it with mock settings/services
   * and collects routes that have OpenAPI metadata.
   *
   * @param basePath - The base URL path for all controller routes (e.g., '/api/products')
   * @param ControllerClass - The controller class constructor
   * @returns This generator instance for method chaining
   *
   * @remarks
   * The controller is instantiated with empty objects as settings and services.
   * This is safe because `routes()` only builds `RouteDefinition` objects —
   * it does not access the database, make HTTP calls, or produce side effects.
   */
  addController(basePath: string, ControllerClass: ControllerConstructor): this {
    // Instantiate controller with minimal mock dependencies.
    // routes() only builds RouteDefinition objects — no side effects.
    const controller = new ControllerClass({}, {});
    const routeDefinitions = controller.routes();
    return this.addRoutes(basePath, routeDefinitions);
  }

  /**
   * Add individual route definitions directly.
   * Only routes with `.openapi()` metadata are collected (opt-in filtering).
   *
   * @param basePath - The base URL path for these routes
   * @param routeDefinitions - Array of route definitions to add
   * @returns This generator instance for method chaining
   */
  addRoutes(basePath: string, routeDefinitions: RouteDefinition[]): this {
    for (const definition of routeDefinitions) {
      // Only include routes with OpenAPI metadata (opt-in mechanism)
      if (definition.openapi) {
        this.routes.push({ basePath, definition });
      }
    }
    return this;
  }

  /**
   * Generate the complete OpenAPI v3.1 document from collected routes.
   *
   * @returns The assembled OpenAPI document object
   */
  generate(): OpenAPIDocument {
    const document: OpenAPIDocument = {
      openapi: '3.1.0',
      info: {
        title: this.config.title,
        version: this.config.version,
        ...(this.config.description ? { description: this.config.description } : {}),
      },
      paths: {},
    };

    // Add servers if configured
    if (this.config.servers && this.config.servers.length > 0) {
      document.servers = this.config.servers;
    }

    // Build paths from collected routes
    document.paths = this.buildPaths();

    // Add components section if security schemes are configured
    if (this.config.securitySchemes && Object.keys(this.config.securitySchemes).length > 0) {
      document.components = {
        securitySchemes: this.config.securitySchemes,
      };
    }

    return document;
  }

  /**
   * Generate and return the specification as a formatted JSON string.
   *
   * @param indent - Number of spaces for JSON indentation (default: 2)
   * @returns Formatted JSON string of the OpenAPI document
   */
  toJSON(indent: number = 2): string {
    const document = this.generate();
    return JSON.stringify(document, null, indent);
  }

  /**
   * Generate and write the specification to a file.
   * Creates parent directories if they don't exist.
   *
   * @param filePath - The path where the JSON file should be written
   */
  toFile(filePath: string): void {
    const resolvedPath = path.resolve(filePath);
    const dir = path.dirname(resolvedPath);

    // Ensure the output directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const json = this.toJSON();
    fs.writeFileSync(resolvedPath, json, 'utf-8');
  }

  // ─── Protected Methods ──────────────────────────────────────────────────

  /**
   * Build the paths object from all collected routes.
   * Groups routes by their full path (basePath + route path) and
   * creates an operation for each HTTP method on that path.
   *
   * @returns The paths object for the OpenAPI document
   */
  protected buildPaths(): Record<string, OpenAPIPathItem> {
    const paths: Record<string, OpenAPIPathItem> = {};

    for (const { basePath, definition } of this.routes) {
      const fullPath = this.buildFullPath(basePath, definition.path);
      const openApiPath = this.convertExpressPathToOpenAPI(fullPath);

      // Initialize path item if it doesn't exist yet
      if (!paths[openApiPath]) {
        paths[openApiPath] = {};
      }

      // Build the operation for this route's HTTP method
      const operation = this.buildOperation(definition);

      // Assign the operation to the correct HTTP method
      const method = definition.method as HttpMethod;
      paths[openApiPath][method] = operation;
    }

    return paths;
  }

  /**
   * Combine a base path and route path into a full path.
   * Handles trailing/leading slashes and avoids double slashes.
   *
   * @param basePath - The controller's base path (e.g., '/api/products')
   * @param routePath - The route's relative path (e.g., '/:id')
   * @returns The combined full path (e.g., '/api/products/:id')
   *
   * @example
   * ```
   * buildFullPath('/api/products', '/')     → '/api/products'
   * buildFullPath('/api/products', '/:id')  → '/api/products/:id'
   * buildFullPath('/api', '/users/:id')     → '/api/users/:id'
   * ```
   */
  protected buildFullPath(basePath: string, routePath: string): string {
    // Remove trailing slash from basePath
    const normalizedBase = basePath.replace(/\/+$/, '');
    // Ensure routePath starts with /
    const normalizedRoute = routePath.startsWith('/') ? routePath : `/${routePath}`;

    // If route is just '/', return basePath alone
    if (normalizedRoute === '/') {
      return normalizedBase || '/';
    }

    return `${normalizedBase}${normalizedRoute}`;
  }

  /**
   * Convert Express-style path parameters to OpenAPI format.
   * Express uses `:param` syntax, OpenAPI uses `{param}` syntax.
   *
   * @param expressPath - Express-style path (e.g., '/users/:userId/posts/:postId')
   * @returns OpenAPI-style path (e.g., '/users/{userId}/posts/{postId}')
   */
  protected convertExpressPathToOpenAPI(expressPath: string): string {
    return expressPath.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');
  }

  /**
   * Extract path parameter names from an Express-style path.
   *
   * @param expressPath - Express-style path (e.g., '/users/:userId/posts/:postId')
   * @returns Array of parameter names (e.g., ['userId', 'postId'])
   */
  protected extractPathParamNames(expressPath: string): string[] {
    const paramRegex = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
    const params: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = paramRegex.exec(expressPath)) !== null) {
      params.push(match[1]);
    }
    return params;
  }

  /**
   * Build an OpenAPI operation object from a route definition.
   * Assembles summary, description, tags, operationId, parameters,
   * requestBody, responses, security, and deprecated flag.
   *
   * @param definition - The route definition to convert
   * @returns The assembled OpenAPI operation object
   */
  protected buildOperation(definition: RouteDefinition): OpenAPIOperation {
    const metadata = definition.openapi!;
    const operation: OpenAPIOperation = {};

    // Basic metadata from .openapi()
    if (metadata.summary) {
      operation.summary = metadata.summary;
    }
    if (metadata.description) {
      operation.description = metadata.description;
    }
    if (metadata.tags && metadata.tags.length > 0) {
      operation.tags = metadata.tags;
    }
    if (metadata.operationId) {
      operation.operationId = metadata.operationId;
    }
    if (metadata.deprecated) {
      operation.deprecated = true;
    }

    // Build parameters (path params + query params for GET/DELETE)
    const parameters = this.buildParameters(definition);
    if (parameters.length > 0) {
      operation.parameters = parameters;
    }

    // Build request body (for POST/PUT/PATCH with validation schema)
    const requestBody = this.buildRequestBody(definition);
    if (requestBody) {
      operation.requestBody = requestBody;
    }

    // Build responses from metadata
    const responses = this.buildResponses(definition);
    if (Object.keys(responses).length > 0) {
      operation.responses = responses;
    }

    // Apply security requirements for secure routes
    const security = this.buildSecurity(definition);
    if (security) {
      operation.security = security;
    }

    return operation;
  }

  /**
   * Build path parameters from the route path and metadata.
   *
   * @remarks
   * Path parameters are extracted from Express `:param` syntax in the URL.
   * If the metadata includes `pathParams` with schemas and descriptions,
   * those are used to enrich the parameter definitions.
   *
   * For GET/DELETE routes with a validation schema, query parameters are
   * also generated (handled in Session 2.2 — Zod conversion).
   *
   * @param definition - The route definition
   * @returns Array of OpenAPI parameter objects
   */
  protected buildParameters(definition: RouteDefinition): OpenAPIParameter[] {
    const parameters: OpenAPIParameter[] = [];
    const fullPath = this.buildFullPath(
      this.routes.find(r => r.definition === definition)?.basePath || '',
      definition.path
    );
    const pathParamNames = this.extractPathParamNames(fullPath);
    const metadata = definition.openapi!;

    // Add path parameters
    for (const paramName of pathParamNames) {
      const paramMeta = metadata.pathParams?.[paramName];
      const param: OpenAPIParameter = {
        name: paramName,
        in: 'path',
        required: true, // Path parameters are always required per OpenAPI spec
      };

      if (paramMeta?.description) {
        param.description = paramMeta.description;
      }

      // Schema conversion from Zod pathParams will be added in Session 2.2
      // For now, default to string type
      if (paramMeta?.schema) {
        param.schema = this.convertZodToSchema(paramMeta.schema);
      } else {
        param.schema = { type: 'string' };
      }

      parameters.push(param);
    }

    // Query parameters for GET/DELETE routes with validation schemas
    // (Zod→OpenAPI conversion will be implemented in Session 2.2)
    if (this.isQueryParamMethod(definition.method) && definition.validation) {
      const queryParams = this.convertZodToQueryParameters(definition.validation);
      parameters.push(...queryParams);
    }

    return parameters;
  }

  /**
   * Build request body from validation schema for POST/PUT/PATCH routes.
   *
   * @param definition - The route definition
   * @returns OpenAPI request body object, or undefined for GET/DELETE routes
   */
  protected buildRequestBody(
    definition: RouteDefinition
  ): { description?: string; required?: boolean; content: Record<string, { schema?: any }> } | undefined {
    // Only POST, PUT, PATCH have request bodies
    if (this.isQueryParamMethod(definition.method)) {
      return undefined;
    }

    // Need a validation schema to generate request body
    if (!definition.validation) {
      return undefined;
    }

    // Zod→OpenAPI schema conversion (Session 2.2 will implement convertZodToSchema)
    const schema = this.convertZodToSchema(definition.validation);

    return {
      required: true,
      content: {
        'application/json': {
          schema,
        },
      },
    };
  }

  /**
   * Build response objects from OpenAPI metadata.
   *
   * @param definition - The route definition
   * @returns Record of status code → response object
   */
  protected buildResponses(definition: RouteDefinition): Record<string, OpenAPIResponse> {
    const responses: Record<string, OpenAPIResponse> = {};
    const metadata = definition.openapi!;

    if (!metadata.responses || metadata.responses.length === 0) {
      return responses;
    }

    for (const responseDef of metadata.responses) {
      const statusCode = String(responseDef.statusCode);
      const response: OpenAPIResponse = {
        description: responseDef.description,
      };

      // If a response schema is provided, convert it
      // (Zod→OpenAPI conversion will be fully implemented in Session 2.2)
      if (responseDef.schema) {
        response.content = {
          'application/json': {
            schema: this.convertZodToSchema(responseDef.schema),
          },
        };
      }

      responses[statusCode] = response;
    }

    return responses;
  }

  /**
   * Build security requirements for the operation.
   * Routes with `secure: true` get the configured `defaultSecurity` applied.
   * Routes without `secure` or with `secure: false` have no security.
   *
   * @param definition - The route definition
   * @returns Array of security requirements, or undefined for public routes
   */
  protected buildSecurity(definition: RouteDefinition): SecurityRequirement[] | undefined {
    if (!definition.secure) {
      return undefined;
    }

    // Apply default security from config when route is secure
    if (this.config.defaultSecurity && this.config.defaultSecurity.length > 0) {
      return this.config.defaultSecurity;
    }

    // Secure route but no default security configured — return empty array
    // (indicates security is required but no specific scheme defined)
    return [];
  }

  /**
   * Check if the HTTP method typically uses query parameters instead of request body.
   * GET and DELETE routes use query parameters; POST, PUT, PATCH use request body.
   *
   * @param method - The HTTP method
   * @returns True for GET and DELETE, false otherwise
   */
  protected isQueryParamMethod(method: HttpMethod): boolean {
    return method === 'get' || method === 'delete';
  }

  // ─── Zod → OpenAPI Conversion ───────────────────────────────────────────

  /**
   * Convert a Zod schema to an OpenAPI JSON Schema object.
   *
   * Delegates to the `zodToOpenAPISchema` function from the zod-to-openapi module,
   * which introspects Zod v4's internal `_zod.def` structure to produce a complete
   * OpenAPI-compatible JSON Schema.
   *
   * @param zodSchema - The Zod schema to convert (any Zod type)
   * @returns An OpenAPI schema object with type, constraints, and nested definitions
   */
  protected convertZodToSchema(zodSchema: unknown): OpenAPISchema {
    return zodToOpenAPISchema(zodSchema);
  }

  /**
   * Convert a Zod object schema to an array of OpenAPI query parameters.
   * Each top-level property of the Zod object becomes a separate query parameter.
   *
   * Delegates to the `zodToQueryParameters` function from the zod-to-openapi module.
   * Optional properties become non-required parameters. Default values are preserved.
   *
   * @param zodSchema - The Zod schema (expected to be z.object())
   * @returns Array of OpenAPI parameter objects with `in: 'query'`
   */
  protected convertZodToQueryParameters(zodSchema: unknown): OpenAPIParameter[] {
    return zodToQueryParameters(zodSchema);
  }
}
