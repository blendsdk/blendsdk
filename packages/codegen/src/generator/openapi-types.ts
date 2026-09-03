/**
 * OpenAPI v3.1 document type definitions.
 *
 * These interfaces represent the structure of an OpenAPI v3.1.0 specification
 * document. They cover the subset of the specification needed by the
 * OpenAPIGenerator — not the full OpenAPI spec.
 *
 * @see https://spec.openapis.org/oas/v3.1.0
 */

// ─── Info Object ────────────────────────────────────────────────────────────

/**
 * Metadata about the API.
 * @see https://spec.openapis.org/oas/v3.1.0#info-object
 */
export interface OpenAPIInfo {
  /** The title of the API */
  title: string;
  /** The version of the API (not the OpenAPI spec version) */
  version: string;
  /** A description of the API (supports Markdown) */
  description?: string;
}

// ─── Server Object ──────────────────────────────────────────────────────────

/**
 * An object representing a server.
 * @see https://spec.openapis.org/oas/v3.1.0#server-object
 */
export interface OpenAPIServer {
  /** A URL to the target host */
  url: string;
  /** An optional description of the server */
  description?: string;
}

// ─── Schema Object ──────────────────────────────────────────────────────────

/**
 * Simplified OpenAPI JSON Schema object.
 * Covers the common schema properties used in request/response definitions.
 *
 * @remarks
 * This is not a full JSON Schema implementation — it covers the subset
 * needed by the Zod→OpenAPI converter.
 *
 * @see https://spec.openapis.org/oas/v3.1.0#schema-object
 */
export interface OpenAPISchema {
  /** The data type (string, number, integer, boolean, array, object) */
  type?: string;
  /** Description of this schema */
  description?: string;
  /** Format hint (e.g., 'int32', 'int64', 'float', 'double', 'date-time', 'email', 'uuid') */
  format?: string;
  /** Allowed enumeration values */
  enum?: unknown[];
  /** Default value */
  default?: unknown;

  /** For objects: property definitions */
  properties?: Record<string, OpenAPISchema>;
  /** For objects: required property names */
  required?: string[];
  /** For objects: whether additional properties are allowed */
  additionalProperties?: boolean | OpenAPISchema;

  /** For arrays: schema of the array items */
  items?: OpenAPISchema;

  /** Minimum value (number/integer) */
  minimum?: number;
  /** Maximum value (number/integer) */
  maximum?: number;
  /** Minimum length (string) or minimum items (array) */
  minLength?: number;
  /** Maximum length (string) or maximum items (array) */
  maxLength?: number;
  /** Minimum number of items (array) */
  minItems?: number;
  /** Maximum number of items (array) */
  maxItems?: number;

  /** Regex pattern for strings */
  pattern?: string;

  /** Nullable value (OpenAPI 3.1 uses type arrays, but nullable is common) */
  nullable?: boolean;

  /** Composition: all of the listed schemas must match */
  allOf?: OpenAPISchema[];
  /** Composition: any of the listed schemas must match */
  anyOf?: OpenAPISchema[];
  /** Composition: exactly one of the listed schemas must match */
  oneOf?: OpenAPISchema[];

  /** Example value */
  example?: unknown;

  /** Reference to another schema (e.g., '#/components/schemas/Product') */
  $ref?: string;
}

// ─── Parameter Object ───────────────────────────────────────────────────────

/**
 * Describes a single operation parameter.
 * @see https://spec.openapis.org/oas/v3.1.0#parameter-object
 */
export interface OpenAPIParameter {
  /** The name of the parameter */
  name: string;
  /** Location of the parameter: query, header, path, or cookie */
  in: 'query' | 'header' | 'path' | 'cookie';
  /** Whether the parameter is required (path params are always required) */
  required?: boolean;
  /** A description of the parameter */
  description?: string;
  /** The schema defining the parameter type and constraints */
  schema?: OpenAPISchema;
  /** Whether the parameter is deprecated */
  deprecated?: boolean;
}

// ─── Request Body Object ────────────────────────────────────────────────────

/**
 * Describes a request body.
 * @see https://spec.openapis.org/oas/v3.1.0#request-body-object
 */
export interface OpenAPIRequestBody {
  /** A description of the request body */
  description?: string;
  /** Whether the request body is required (default: false) */
  required?: boolean;
  /** The content of the request body, keyed by media type */
  content: Record<string, OpenAPIMediaType>;
}

// ─── Media Type Object ──────────────────────────────────────────────────────

/**
 * Describes a media type with a schema.
 * @see https://spec.openapis.org/oas/v3.1.0#media-type-object
 */
export interface OpenAPIMediaType {
  /** The schema defining the content structure */
  schema?: OpenAPISchema;
}

// ─── Response Object ────────────────────────────────────────────────────────

/**
 * Describes a single response from an API operation.
 * @see https://spec.openapis.org/oas/v3.1.0#response-object
 */
export interface OpenAPIResponse {
  /** A description of the response (required by spec) */
  description: string;
  /** The content of the response, keyed by media type */
  content?: Record<string, OpenAPIMediaType>;
}

// ─── Operation Object ───────────────────────────────────────────────────────

/**
 * Describes a single API operation on a path.
 * @see https://spec.openapis.org/oas/v3.1.0#operation-object
 */
export interface OpenAPIOperation {
  /** A short summary of the operation */
  summary?: string;
  /** A verbose description of the operation (supports Markdown) */
  description?: string;
  /** A unique string used to identify the operation */
  operationId?: string;
  /** Tags for API documentation grouping */
  tags?: string[];
  /** The parameters applicable for this operation */
  parameters?: OpenAPIParameter[];
  /** The request body applicable for this operation */
  requestBody?: OpenAPIRequestBody;
  /** Expected responses keyed by HTTP status code */
  responses?: Record<string, OpenAPIResponse>;
  /** Security requirements for this operation */
  security?: SecurityRequirement[];
  /** Whether the operation is deprecated */
  deprecated?: boolean;
}

// ─── Path Item Object ───────────────────────────────────────────────────────

/**
 * Describes the operations available on a single path.
 * Each property corresponds to an HTTP method.
 *
 * @see https://spec.openapis.org/oas/v3.1.0#path-item-object
 */
export interface OpenAPIPathItem {
  get?: OpenAPIOperation;
  post?: OpenAPIOperation;
  put?: OpenAPIOperation;
  patch?: OpenAPIOperation;
  delete?: OpenAPIOperation;
}

// ─── Security Scheme Object ─────────────────────────────────────────────────

/**
 * Defines a security scheme that can be used by the operations.
 * @see https://spec.openapis.org/oas/v3.1.0#security-scheme-object
 */
export interface OpenAPISecurityScheme {
  /** The type of the security scheme */
  type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect';
  /** A description for the security scheme */
  description?: string;
  /** The name of the header, query, or cookie parameter (for apiKey) */
  name?: string;
  /** The location of the API key (for apiKey) */
  in?: 'query' | 'header' | 'cookie';
  /** The HTTP authorization scheme (for http, e.g., 'bearer') */
  scheme?: string;
  /** The format of the bearer token (for http bearer, e.g., 'JWT') */
  bearerFormat?: string;
}

// ─── Security Requirement Object ────────────────────────────────────────────

/**
 * Lists the required security schemes to execute an operation.
 * Each key is a security scheme name, value is an array of scopes.
 *
 * @see https://spec.openapis.org/oas/v3.1.0#security-requirement-object
 */
export type SecurityRequirement = Record<string, string[]>;

// ─── Components Object ──────────────────────────────────────────────────────

/**
 * Holds reusable objects for the specification.
 * @see https://spec.openapis.org/oas/v3.1.0#components-object
 */
export interface OpenAPIComponents {
  /** Reusable schema definitions */
  schemas?: Record<string, OpenAPISchema>;
  /** Security scheme definitions */
  securitySchemes?: Record<string, OpenAPISecurityScheme>;
}

// ─── Document Object ────────────────────────────────────────────────────────

/**
 * Root OpenAPI v3.1.0 document structure.
 *
 * This is the top-level object produced by the OpenAPIGenerator.
 * It contains all paths, schemas, and security definitions for the API.
 *
 * @see https://spec.openapis.org/oas/v3.1.0#openapi-object
 */
export interface OpenAPIDocument {
  /** The OpenAPI spec version (always '3.1.0') */
  openapi: '3.1.0';
  /** Metadata about the API */
  info: OpenAPIInfo;
  /** Server connectivity information */
  servers?: OpenAPIServer[];
  /** Available paths and operations */
  paths: Record<string, OpenAPIPathItem>;
  /** Reusable components */
  components?: OpenAPIComponents;
}

// ─── Generator Config ───────────────────────────────────────────────────────

/**
 * Configuration for the OpenAPI spec generator.
 *
 * @example
 * ```typescript
 * const config: OpenAPIGeneratorConfig = {
 *   title: 'My API',
 *   version: '1.0.0',
 *   description: 'API documentation',
 *   servers: [{ url: 'http://localhost:3000', description: 'Local dev' }],
 *   securitySchemes: {
 *     bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
 *   },
 *   defaultSecurity: [{ bearerAuth: [] }]
 * };
 * ```
 */
export interface OpenAPIGeneratorConfig {
  /** API title (appears in spec info) */
  title: string;
  /** API version string (appears in spec info) */
  version: string;
  /** Optional API description (supports Markdown) */
  description?: string;
  /** Server definitions for the API */
  servers?: OpenAPIServer[];
  /** Security scheme definitions for the components section */
  securitySchemes?: Record<string, OpenAPISecurityScheme>;
  /**
   * Default security requirements applied to routes with `secure: true`.
   * When a route is marked as secure, these requirements are added
   * to the operation's `security` field.
   */
  defaultSecurity?: SecurityRequirement[];
}
