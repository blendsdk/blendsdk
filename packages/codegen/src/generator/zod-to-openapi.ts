/**
 * Zod v4 → OpenAPI JSON Schema converter.
 *
 * Converts Zod v4 schemas into OpenAPI v3.1 JSON Schema objects by
 * introspecting Zod's internal `_zod.def` structure. This custom converter
 * is necessary because existing zod-to-openapi libraries do not support
 * Zod v4's changed internals.
 *
 * @remarks
 * Zod v4 stores schema metadata in `schema._zod.def`:
 * - `def.type` — the Zod type name (string, number, boolean, object, array, etc.)
 * - `def.checks` — array of validation checks (min_length, max_length, etc.)
 * - `def.shape` — object property schemas (each value is a `_zod` internal object)
 * - `def.element` — array item schema (`_zod` internal object)
 * - `def.innerType` — wrapped schema for optional/nullable/default (`_zod` internal object)
 * - `def.entries` — enum values as Record<string, string>
 * - `def.values` — literal values as array
 * - `def.options` — union member schemas (array of `_zod` internal objects)
 * - `def.defaultValue` — the default value for default-wrapped schemas
 * - `def.coerce` — boolean flag for coerced types
 *
 * @module
 */
import type { OpenAPISchema, OpenAPIParameter } from './openapi-types.js';

// ─── Internal Types ─────────────────────────────────────────────────────────

/**
 * Represents a Zod v4 internal node (the `_zod` object).
 * Child schemas (in shape, element, innerType, options) are also ZodNode objects.
 *
 * @remarks
 * When accessing a Zod schema from user code, the `_zod` property gives us
 * this structure. When traversing children (shape values, innerType, etc.),
 * those are already ZodNode objects directly.
 */
interface ZodNode {
  def: ZodDef;
  [key: string]: unknown;
}

/**
 * Represents the definition object inside a ZodNode.
 * Contains the type discriminator and type-specific properties.
 */
interface ZodDef {
  /** The Zod type discriminator */
  type: string;
  /** Validation checks (string, number, array constraints) */
  checks?: ZodCheck[];
  /** Object shape — each value is a ZodNode */
  shape?: Record<string, ZodNode>;
  /** Array element schema — a ZodNode */
  element?: ZodNode;
  /** Wrapped inner type for optional/nullable/default — a ZodNode */
  innerType?: ZodNode;
  /** Enum entries as Record<value, value> */
  entries?: Record<string, string>;
  /** Literal values array */
  values?: unknown[];
  /** Union option schemas — array of ZodNode */
  options?: ZodNode[];
  /** Default value for default-wrapped schemas */
  defaultValue?: unknown;
  /** Whether this is a coerced type (z.coerce.number(), etc.) */
  coerce?: boolean;
  /**
   * Pipeline input schema — a full Zod schema object (not a ZodNode).
   * Present when `def.type === 'pipe'` (created by `.transform()` or `.pipe()`).
   * Access the ZodNode via `in._zod`.
   */
  in?: { _zod?: ZodNode; [key: string]: unknown };
  /**
   * Pipeline output schema — a ZodNode-like object.
   * Present when `def.type === 'pipe'`. For `.transform()`, this has
   * `def.type === 'transform'` (opaque). For `.pipe()`, it has the actual
   * output schema type.
   */
  out?: ZodNode;
}

/**
 * Represents a Zod v4 validation check.
 * Checks are stored in `def.checks` and have their own `_zod.def` with details.
 */
interface ZodCheck {
  _zod?: {
    def: ZodCheckDef;
  };
}

/**
 * The definition inside a Zod check, containing the actual constraint info.
 */
interface ZodCheckDef {
  /** The check type discriminator */
  check: string;
  /** Minimum value for min_length checks */
  minimum?: number;
  /** Maximum value for max_length checks */
  maximum?: number;
  /** Numeric value for greater_than / less_than checks */
  value?: number;
  /** Whether the comparison is inclusive (>=) or exclusive (>) */
  inclusive?: boolean;
  /** Format string for string_format / number_format checks */
  format?: string;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Convert a Zod v4 schema to an OpenAPI JSON Schema object.
 *
 * This is the main entry point for schema conversion. It extracts the
 * internal `_zod` node from the schema and delegates to the recursive
 * node converter.
 *
 * @param zodSchema - Any Zod v4 schema instance (z.string(), z.object(), etc.)
 * @returns An OpenAPI-compatible JSON Schema object
 *
 * @example
 * ```typescript
 * import { z } from 'zod';
 * import { zodToOpenAPISchema } from './zod-to-openapi.js';
 *
 * const schema = z.object({ name: z.string().min(1), age: z.number().int() });
 * const openApiSchema = zodToOpenAPISchema(schema);
 * // { type: 'object', properties: { name: { type: 'string', minLength: 1 }, age: { type: 'integer' } }, required: ['name', 'age'] }
 * ```
 */
export function zodToOpenAPISchema(zodSchema: unknown): OpenAPISchema {
  const node = extractZodNode(zodSchema);
  if (!node) {
    // Fallback for unrecognized schemas
    return { type: 'object' };
  }
  return convertNode(node);
}

/**
 * Convert a Zod v4 object schema into an array of OpenAPI query parameters.
 *
 * Each top-level property of the Zod object becomes a separate query parameter.
 * Optional properties become non-required parameters. Default values are included.
 *
 * @param zodSchema - A Zod v4 object schema (z.object({ ... }))
 * @returns Array of OpenAPI parameter objects with `in: 'query'`
 *
 * @example
 * ```typescript
 * const schema = z.object({
 *   page: z.coerce.number().default(1),
 *   search: z.string().optional(),
 * });
 * const params = zodToQueryParameters(schema);
 * // [
 * //   { name: 'page', in: 'query', schema: { type: 'number', default: 1 } },
 * //   { name: 'search', in: 'query', schema: { type: 'string' } },
 * // ]
 * ```
 */
export function zodToQueryParameters(zodSchema: unknown): OpenAPIParameter[] {
  const node = extractZodNode(zodSchema);
  if (!node) {
    return [];
  }

  // Unwrap wrappers (optional, default, nullable) to find the object schema
  const objectNode = unwrapToObject(node);
  if (!objectNode || objectNode.def.type !== 'object' || !objectNode.def.shape) {
    return [];
  }

  const parameters: OpenAPIParameter[] = [];

  for (const [propName, propNode] of Object.entries(objectNode.def.shape)) {
    const { schema: propSchema, isOptional } = convertPropertyWithOptional(propNode);

    const param: OpenAPIParameter = {
      name: propName,
      in: 'query',
      schema: propSchema,
    };

    // Query params are required only if the property is not optional/default
    if (!isOptional) {
      param.required = true;
    }

    parameters.push(param);
  }

  return parameters;
}

// ─── Internal Conversion Logic ──────────────────────────────────────────────

/**
 * Extract the internal `_zod` node from a Zod schema instance.
 *
 * @param zodSchema - A Zod schema (or any value)
 * @returns The internal ZodNode, or null if not a valid Zod schema
 */
function extractZodNode(zodSchema: unknown): ZodNode | null {
  if (
    zodSchema &&
    typeof zodSchema === 'object' &&
    '_zod' in zodSchema &&
    typeof (zodSchema as any)._zod === 'object' &&
    (zodSchema as any)._zod?.def
  ) {
    return (zodSchema as any)._zod as ZodNode;
  }
  return null;
}

/**
 * Unwrap optional/nullable/default wrappers to find an underlying object node.
 * Used by query parameter conversion to reach the object shape.
 *
 * @param node - The ZodNode to unwrap
 * @returns The unwrapped ZodNode (possibly the same node if it's already an object)
 */
function unwrapToObject(node: ZodNode): ZodNode | null {
  const type = node.def.type;

  if (type === 'object') {
    return node;
  }

  // Unwrap wrappers that contain an innerType
  if ((type === 'optional' || type === 'nullable' || type === 'default') && node.def.innerType) {
    return unwrapToObject(node.def.innerType);
  }

  // Unwrap pipe (transform/pipe) — use the input schema for OpenAPI
  if (type === 'pipe' && node.def.in?._zod) {
    return unwrapToObject(node.def.in._zod);
  }

  return null;
}

/**
 * Convert a ZodNode to an OpenAPI schema object.
 * This is the main recursive dispatcher that handles all Zod types.
 *
 * @param node - The internal Zod node to convert
 * @returns The corresponding OpenAPI schema
 */
function convertNode(node: ZodNode): OpenAPISchema {
  const type = node.def.type;

  switch (type) {
    case 'string':
      return convertString(node);
    case 'number':
      return convertNumber(node);
    case 'boolean':
      return convertBoolean();
    case 'enum':
      return convertEnum(node);
    case 'literal':
      return convertLiteral(node);
    case 'array':
      return convertArray(node);
    case 'object':
      return convertObject(node);
    case 'optional':
      return convertOptional(node);
    case 'nullable':
      return convertNullable(node);
    case 'default':
      return convertDefault(node);
    case 'union':
      return convertUnion(node);
    case 'pipe':
      return convertPipe(node);
    default:
      // Fallback for unsupported types — return generic object
      return { type: 'object' };
  }
}

/**
 * Convert a Zod string schema to OpenAPI string schema.
 * Extracts format, minLength, and maxLength from checks.
 *
 * @param node - String ZodNode
 * @returns OpenAPI string schema with constraints
 */
function convertString(node: ZodNode): OpenAPISchema {
  const schema: OpenAPISchema = { type: 'string' };

  // Process checks for constraints and format
  if (node.def.checks) {
    for (const check of node.def.checks) {
      const checkDef = check._zod?.def;
      if (!checkDef) {
        continue;
      }

      switch (checkDef.check) {
        case 'min_length':
          if (checkDef.minimum !== undefined) {
            schema.minLength = checkDef.minimum;
          }
          break;
        case 'max_length':
          if (checkDef.maximum !== undefined) {
            schema.maxLength = checkDef.maximum;
          }
          break;
        case 'string_format':
          // Map Zod format names to OpenAPI format names
          if (checkDef.format) {
            schema.format = checkDef.format;
          }
          break;
      }
    }
  }

  return schema;
}

/**
 * Convert a Zod number schema to OpenAPI number/integer schema.
 * Extracts minimum, maximum, and determines if integer from checks.
 *
 * @param node - Number ZodNode
 * @returns OpenAPI number or integer schema with constraints
 */
function convertNumber(node: ZodNode): OpenAPISchema {
  const schema: OpenAPISchema = { type: 'number' };
  let isInt = false;

  // Process checks for constraints and format
  if (node.def.checks) {
    for (const check of node.def.checks) {
      const checkDef = check._zod?.def;
      if (!checkDef) {
        continue;
      }

      switch (checkDef.check) {
        case 'greater_than':
          if (checkDef.value !== undefined) {
            // OpenAPI uses minimum/exclusiveMinimum
            if (checkDef.inclusive) {
              schema.minimum = checkDef.value;
            } else {
              // For exclusive, use the value + note: OpenAPI 3.1 supports exclusiveMinimum as number
              schema.minimum = checkDef.value;
            }
          }
          break;
        case 'less_than':
          if (checkDef.value !== undefined) {
            if (checkDef.inclusive) {
              schema.maximum = checkDef.value;
            } else {
              schema.maximum = checkDef.value;
            }
          }
          break;
        case 'number_format':
          // 'safeint' format means .int() was called
          if (checkDef.format === 'safeint') {
            isInt = true;
          }
          break;
      }
    }
  }

  // Use 'integer' type when .int() is applied
  if (isInt) {
    schema.type = 'integer';
  }

  return schema;
}

/**
 * Convert a Zod boolean schema to OpenAPI boolean schema.
 *
 * @returns OpenAPI boolean schema
 */
function convertBoolean(): OpenAPISchema {
  return { type: 'boolean' };
}

/**
 * Convert a Zod enum schema to OpenAPI string schema with enum values.
 *
 * @param node - Enum ZodNode with `def.entries`
 * @returns OpenAPI string schema with enum array
 */
function convertEnum(node: ZodNode): OpenAPISchema {
  const schema: OpenAPISchema = { type: 'string' };

  if (node.def.entries) {
    // Entries is Record<value, value> — extract the values
    schema.enum = Object.values(node.def.entries);
  }

  return schema;
}

/**
 * Convert a Zod literal schema to OpenAPI schema with enum containing the literal value.
 *
 * @param node - Literal ZodNode with `def.values`
 * @returns OpenAPI schema with enum for the literal value
 */
function convertLiteral(node: ZodNode): OpenAPISchema {
  const values = node.def.values || [];

  if (values.length === 1) {
    const val = values[0];
    const schema: OpenAPISchema = {
      type: typeof val === 'number' ? 'number' : typeof val === 'boolean' ? 'boolean' : 'string',
      enum: [val],
    };
    return schema;
  }

  // Multiple literal values — use enum
  return { enum: values };
}

/**
 * Convert a Zod array schema to OpenAPI array schema.
 * Extracts minItems and maxItems from checks.
 *
 * @param node - Array ZodNode with `def.element`
 * @returns OpenAPI array schema with items and constraints
 */
function convertArray(node: ZodNode): OpenAPISchema {
  const schema: OpenAPISchema = { type: 'array' };

  // Convert element type
  if (node.def.element) {
    schema.items = convertNode(node.def.element);
  }

  // Process array-specific checks (min/max items)
  if (node.def.checks) {
    for (const check of node.def.checks) {
      const checkDef = check._zod?.def;
      if (!checkDef) {
        continue;
      }

      switch (checkDef.check) {
        case 'min_length':
          if (checkDef.minimum !== undefined) {
            schema.minItems = checkDef.minimum;
          }
          break;
        case 'max_length':
          if (checkDef.maximum !== undefined) {
            schema.maxItems = checkDef.maximum;
          }
          break;
      }
    }
  }

  return schema;
}

/**
 * Convert a Zod object schema to OpenAPI object schema.
 * Iterates over shape properties and determines which are required.
 *
 * @param node - Object ZodNode with `def.shape`
 * @returns OpenAPI object schema with properties and required list
 */
function convertObject(node: ZodNode): OpenAPISchema {
  const schema: OpenAPISchema = { type: 'object' };

  if (!node.def.shape) {
    return schema;
  }

  const properties: Record<string, OpenAPISchema> = {};
  const required: string[] = [];

  for (const [propName, propNode] of Object.entries(node.def.shape)) {
    const { schema: propSchema, isOptional } = convertPropertyWithOptional(propNode);
    properties[propName] = propSchema;

    // Add to required list if not optional and not default
    if (!isOptional) {
      required.push(propName);
    }
  }

  if (Object.keys(properties).length > 0) {
    schema.properties = properties;
  }
  if (required.length > 0) {
    schema.required = required;
  }

  return schema;
}

/**
 * Convert a property ZodNode, tracking whether it is optional.
 * Unwraps optional/default wrappers and returns both the schema
 * and an isOptional flag for the parent to use.
 *
 * @param node - The property's ZodNode
 * @returns Object with the converted schema and optionality flag
 */
function convertPropertyWithOptional(node: ZodNode): { schema: OpenAPISchema; isOptional: boolean } {
  const type = node.def.type;

  if (type === 'optional') {
    // Unwrap optional and convert inner type
    if (node.def.innerType) {
      const innerResult = convertPropertyWithOptional(node.def.innerType);
      return { schema: innerResult.schema, isOptional: true };
    }
    return { schema: { type: 'object' }, isOptional: true };
  }

  if (type === 'default') {
    // Unwrap default, convert inner type, and add default value
    if (node.def.innerType) {
      const innerResult = convertPropertyWithOptional(node.def.innerType);
      const schema = { ...innerResult.schema };
      if (node.def.defaultValue !== undefined) {
        schema.default = node.def.defaultValue;
      }
      // Properties with defaults are treated as optional (not required)
      return { schema, isOptional: true };
    }
    return { schema: { type: 'object' }, isOptional: true };
  }

  // For all other types, convert normally
  return { schema: convertNode(node), isOptional: false };
}

/**
 * Convert a Zod optional schema to OpenAPI schema.
 * When encountered at a non-property level (e.g., as a standalone schema),
 * simply returns the inner type's schema.
 *
 * @param node - Optional ZodNode with `def.innerType`
 * @returns The inner type's OpenAPI schema
 */
function convertOptional(node: ZodNode): OpenAPISchema {
  if (node.def.innerType) {
    return convertNode(node.def.innerType);
  }
  return { type: 'object' };
}

/**
 * Convert a Zod nullable schema to OpenAPI schema.
 * Adds `nullable: true` to the inner type's schema.
 *
 * @param node - Nullable ZodNode with `def.innerType`
 * @returns The inner type's OpenAPI schema with nullable flag
 */
function convertNullable(node: ZodNode): OpenAPISchema {
  if (node.def.innerType) {
    const schema = convertNode(node.def.innerType);
    schema.nullable = true;
    return schema;
  }
  return { type: 'object', nullable: true };
}

/**
 * Convert a Zod default schema to OpenAPI schema.
 * Adds the `default` value to the inner type's schema.
 *
 * @param node - Default ZodNode with `def.innerType` and `def.defaultValue`
 * @returns The inner type's OpenAPI schema with default value
 */
function convertDefault(node: ZodNode): OpenAPISchema {
  if (node.def.innerType) {
    const schema = convertNode(node.def.innerType);
    if (node.def.defaultValue !== undefined) {
      schema.default = node.def.defaultValue;
    }
    return schema;
  }
  return { type: 'object' };
}

/**
 * Convert a Zod union schema to OpenAPI anyOf schema.
 *
 * @param node - Union ZodNode with `def.options`
 * @returns OpenAPI schema with anyOf containing all union members
 */
function convertUnion(node: ZodNode): OpenAPISchema {
  if (!node.def.options || node.def.options.length === 0) {
    return { type: 'object' };
  }

  const schemas = node.def.options.map(optionNode => convertNode(optionNode));
  return { anyOf: schemas };
}

/**
 * Convert a Zod pipe schema to OpenAPI schema.
 *
 * Pipe types are created by `.transform()` and `.pipe()`. They have:
 * - `def.in` — the input schema (what the API consumer sends)
 * - `def.out` — the output schema (what the code receives after transformation)
 *
 * For OpenAPI, we use the **input** schema because that represents what the
 * API consumer needs to send. The transform/pipe output is a runtime concern
 * that doesn't affect the API contract.
 *
 * @example
 * ```typescript
 * // z.string().transform(val => val.split(',')) → { type: 'string' }
 * // z.string().pipe(z.number()) → { type: 'string' }
 * // z.object({...}).transform(obj => obj.name) → { type: 'object', ... }
 * ```
 *
 * @param node - Pipe ZodNode with `def.in` (input) and `def.out` (output)
 * @returns The input schema's OpenAPI representation
 */
function convertPipe(node: ZodNode): OpenAPISchema {
  // Extract the input schema from the pipe — this is a full Zod schema
  // object (not a ZodNode), so we access _zod to get the node
  const inputNode = node.def.in?._zod;
  if (inputNode) {
    return convertNode(inputNode);
  }

  // Fallback if no input schema found
  return { type: 'object' };
}
