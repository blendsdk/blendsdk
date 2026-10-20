/**
 * Zod v4 → OpenAPI 3.1 JSON Schema conversion.
 *
 * Zod 4 ships a native converter, `z.toJSONSchema`, that understands every
 * schema type it can represent and reports (or overrides) the ones it cannot.
 * This module builds on that converter instead of introspecting Zod internals:
 * it selects the right wire direction for requests and responses, normalizes the
 * draft-2020-12 output into the shapes OpenAPI 3.1 consumers expect, splits a
 * query object into per-property parameters, and hoists reusable `$defs` into
 * `components.schemas`.
 *
 * @module
 */
import { ZodType, z } from 'zod';
import type { OpenAPIDocument, OpenAPIParameter, OpenAPISchema } from './openapi-types.js';

// ─── Internal Types ─────────────────────────────────────────────────────────

/**
 * A JSON Schema value as produced by Zod: a primitive, an array, or an object.
 * The converter walks this shape before narrowing it to `OpenAPISchema`.
 */
type JsonSchemaValue = string | number | boolean | null | JsonSchemaValue[] | JsonSchemaObject;

/** An object node of a JSON Schema document. */
interface JsonSchemaObject {
  [key: string]: JsonSchemaValue;
}

/**
 * Checks whether a value is a plain JSON object (not `null`, not an array).
 *
 * @param value - The value to inspect.
 * @returns True when the value can be treated as a JSON object node.
 */
function isJsonObject(value: unknown): value is JsonSchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks whether a JSON Schema node describes the JSON `null` type only.
 *
 * Zod represents a nullable field as `{ anyOf: [inner, { type: 'null' }] }`.
 * This helper identifies the `{ type: 'null' }` branch so it can be folded into
 * the inner type.
 *
 * @param value - The JSON Schema branch to inspect.
 * @returns True when the branch is exactly the `null` type.
 */
function isNullSchema(value: JsonSchemaValue): boolean {
  return isJsonObject(value) && value.type === 'null';
}

/**
 * Converts a JSON Schema `type` value into a non-empty array of type names.
 *
 * A JSON Schema `type` may be a single string or an array of strings. Returning
 * a consistent array keeps the nullable-folding logic simple.
 *
 * @param value - The `type` value, if any.
 * @returns The type names, or undefined when no usable type is present.
 */
function toTypeNames(value: JsonSchemaValue | undefined): string[] | undefined {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    const names = value.filter((entry): entry is string => typeof entry === 'string');
    return names.length > 0 ? names : undefined;
  }
  return undefined;
}

/**
 * Recursively normalizes a raw Zod JSON Schema into an OpenAPI 3.1 shape.
 *
 * Two adjustments are applied:
 * 1. The draft-2020-12 `$schema` marker Zod adds to the root is removed, because
 *    the schema is embedded in an OpenAPI document that declares its own version.
 * 2. A simple nullable union (`anyOf: [inner, { type: 'null' }]`) is folded into
 *    a JSON Schema type array (`type: ['string', 'null']`). OpenAPI 3.1 consumers
 *    understand type arrays directly, and the 3.0 `nullable` keyword is gone.
 *
 * @param value - The raw Zod JSON Schema value.
 * @returns The normalized value with the same node structure.
 */
function normalizeJsonSchema(value: unknown): JsonSchemaValue {
  if (Array.isArray(value)) {
    return value.map(entry => normalizeJsonSchema(entry));
  }
  if (!isJsonObject(value)) {
    return (value ?? null) as JsonSchemaValue;
  }

  const normalized: JsonSchemaObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === '$schema') {
      continue;
    }
    normalized[key] = normalizeJsonSchema(entry);
  }

  return foldNullableUnion(normalized);
}

/**
 * Folds a two-branch nullable union into a JSON Schema type array.
 *
 * Only the common case Zod emits is folded: exactly one `null` branch and one
 * named-type branch. Branches that carry `enum` or `const` are left as a union,
 * because a JSON Schema type array would not relax those keywords and `null`
 * would still be rejected, silently losing nullability.
 *
 * @param schema - A normalized JSON Schema object.
 * @returns The schema with a nullable union folded, or the original schema.
 */
function foldNullableUnion(schema: JsonSchemaObject): JsonSchemaObject {
  const union = schema.anyOf;
  if (!Array.isArray(union)) {
    return schema;
  }

  const nullBranches = union.filter(isNullSchema);
  const valueBranches = union.filter(branch => !isNullSchema(branch));

  if (nullBranches.length !== 1 || valueBranches.length !== 1 || !isJsonObject(valueBranches[0])) {
    return schema;
  }

  const inner = valueBranches[0];
  if (inner.enum !== undefined || inner.const !== undefined) {
    return schema;
  }

  const typeNames = toTypeNames(inner.type);
  if (!typeNames) {
    return schema;
  }

  const merged: JsonSchemaObject = { ...inner };
  for (const [key, entry] of Object.entries(schema)) {
    if (key !== 'anyOf') {
      merged[key] = entry;
    }
  }
  merged.type = typeNames.includes('null') ? typeNames : [...typeNames, 'null'];

  return merged;
}

/**
 * Checks whether a value is a Zod schema that the native converter can process.
 *
 * @param value - The value to inspect.
 * @returns True when the value looks like a Zod schema.
 */
export function isZodSchema(value: unknown): value is ZodType {
  return value instanceof z.ZodType;
}

/**
 * Returns a new record with keys in ascending order.
 *
 * Deterministic key order keeps the generated OpenAPI document byte-stable
 * between runs, which the drift check relies on.
 *
 * @param record - The record to sort.
 * @returns A copy with sorted keys.
 */
export function sortByName<T extends object>(record: T): T {
  const sorted = {} as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    sorted[key] = (record as Record<string, unknown>)[key];
  }
  return sorted as T;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Converts a Zod schema to an OpenAPI 3.1 JSON Schema object.
 *
 * Pass `io: 'input'` for request schemas (the shape a caller sends) and
 * `io: 'output'` for response schemas (the shape the server returns), so Zod
 * resolves defaults and transforms on the correct side of the wire. Reusable
 * schemas with `.meta({ id })` become `$ref`s into `$defs`, which
 * {@link hoistDefinitions} later moves into `components.schemas`.
 *
 * @param schema - The Zod schema to convert.
 * @param direction - Which side of the wire the schema describes.
 * @returns A draft-2020-12 JSON Schema object.
 *
 * @example
 * ```typescript
 * const createProduct = z.object({ name: z.string(), tags: z.array(z.string()) });
 * const schema = convertZodToJsonSchema(createProduct, 'input');
 * // { type: 'object', properties: { ... }, required: ['name', 'tags'] }
 * ```
 */
export function convertZodToJsonSchema(
  schema: ZodType,
  direction: 'input' | 'output'
): OpenAPISchema {
  if (!isZodSchema(schema)) {
    return { type: 'object' };
  }

  const raw = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: direction,
    cycles: 'ref',
    reused: 'ref',
    metadata: z.globalRegistry,
    unrepresentable: 'any',
  });

  return normalizeJsonSchema(raw) as OpenAPISchema;
}

/**
 * Splits a route's query object schema into OpenAPI query parameters.
 *
 * Each top-level property of the object becomes one `in: 'query'` parameter.
 * Optional and defaulted properties are not marked required. A non-object
 * schema (or a value that is not a Zod schema) produces no parameters.
 *
 * @param schema - The route's query object schema.
 * @returns One OpenAPI parameter per top-level property.
 *
 * @example
 * ```typescript
 * const query = z.object({ page: z.coerce.number().default(1), search: z.string().optional() });
 * const parameters = convertZodToQueryParameters(query);
 * // [
 * //   { name: 'page', in: 'query', schema: { default: 1, type: 'number' } },
 * //   { name: 'search', in: 'query', schema: { type: 'string' } },
 * // ]
 * ```
 */
export function convertZodToQueryParameters(schema: ZodType): OpenAPIParameter[] {
  const converted = convertZodToJsonSchema(schema, 'input');
  const object = asObjectSchema(converted);
  if (!object?.properties) {
    return [];
  }

  const required = new Set(object.required ?? []);

  return Object.entries(object.properties).map(([name, propertySchema]) => {
    const parameter: OpenAPIParameter = {
      name,
      in: 'query',
      schema: propertySchema,
    };
    if (required.has(name)) {
      parameter.required = true;
    }
    return parameter;
  });
}

/**
 * Finds the object schema inside a converted schema.
 *
 * A query object is normally a plain `{ type: 'object' }`, but Zod wraps it in an
 * `anyOf` when the object itself is optional or nullable, and folds a nullable
 * object into `type: ['object', 'null']`. This helper accepts both so the
 * query-splitting logic keeps working.
 *
 * @param schema - The converted schema.
 * @returns The object schema, or undefined when the conversion is not an object.
 */
function asObjectSchema(schema: OpenAPISchema): OpenAPISchema | undefined {
  if (Array.isArray(schema.type) ? schema.type.includes('object') : schema.type === 'object') {
    return schema;
  }
  const union = schema.anyOf;
  if (Array.isArray(union)) {
    return union.find(branch => branch.type === 'object');
  }
  return undefined;
}

/**
 * Rewrites draft-2020-12 `$defs` into OpenAPI `components.schemas`.
 *
 * Zod emits reusable definitions under `$defs`. OpenAPI 3.1 stores them under
 * `components.schemas`, so every `#/$defs/Name` reference is rewritten to
 * `#/components/schemas/Name` and the definitions are hoisted. Any existing
 * `components` entries, such as `securitySchemes`, are preserved; only `schemas`
 * is added or merged, and its entries are sorted by name for stable output.
 *
 * Zod restarts its anonymous `__schemaN` numbering on every conversion, so two
 * operations can produce same-named but different definitions. A name that is
 * already taken by an equal definition is reused; a name taken by a different
 * definition is deterministically renamed (`Name_2`, `Name_3`, ...) and the
 * references inside that operation are rewritten to match. This prevents one
 * operation's schema from silently overwriting another's.
 *
 * @param document - The in-progress OpenAPI document with collected schemas.
 * @returns The document with hoisted, rewritten component schemas.
 * @throws {Error} When a `#/$defs/` reference survives hoisting, which would
 *   otherwise produce an unresolvable reference in the generated client.
 *
 * @example
 * ```typescript
 * const document = { openapi: '3.1.0', info: {}, paths: {}, ... };
 * const hoisted = hoistDefinitions(document);
 * // hoisted.components?.schemas?.Product is defined; references use #/components/schemas/Product
 * ```
 */
export function hoistDefinitions(document: OpenAPIDocument): OpenAPIDocument {
  const schemas: Record<string, OpenAPISchema> = {};
  collectAndRename(document, schemas);

  if (Object.keys(schemas).length > 0) {
    const components = { ...(document.components ?? {}) };
    const merged: Record<string, OpenAPISchema> = { ...(components.schemas ?? {}), ...schemas };
    components.schemas = sortByName(merged);
    document.components = components;

    // Rewrite remaining references once the definitions are part of the document.
    rewriteReferences(document);
  }

  assertNoLocalReferences(document);

  return document;
}

/**
 * Walks a document, removes every `$defs` map, and merges its entries into the
 * collected definitions with collision-safe names.
 *
 * @param value - The node to walk.
 * @param schemas - The accumulator keyed by final definition name.
 */
function collectAndRename(value: unknown, schemas: Record<string, OpenAPISchema>): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectAndRename(entry, schemas);
    }
    return;
  }
  if (!isJsonObject(value)) {
    return;
  }

  const rawDefinitions = value.$defs;
  if (isJsonObject(rawDefinitions)) {
    const rename = new Map<string, string>();

    for (const [name, definition] of Object.entries(rawDefinitions)) {
      const finalName = resolveDefinitionName(name, definition, schemas);
      if (finalName !== name) {
        rename.set(name, finalName);
      }
      collectAndRename(definition, schemas);
      schemas[finalName] = definition as OpenAPISchema;
    }

    // Rewrite references inside the moved definitions, then inside the rest of
    // the subtree that referenced them.
    for (const definition of Object.values(rawDefinitions)) {
      rewriteRenamedReferences(definition, rename);
    }
    delete value.$defs;
    rewriteRenamedReferences(value, rename);
  }

  for (const [key, entry] of Object.entries(value)) {
    if (key === '$defs') {
      continue;
    }
    collectAndRename(entry, schemas);
  }
}

/**
 * Chooses the final name for a definition being hoisted.
 *
 * A free name is kept. A name already used by an equal definition is reused so
 * the two collapse into one, but only when neither definition contains a local
 * `#/$defs/` reference: two definitions can be textually equal yet reference
 * same-named definitions that resolve differently in each operation, so
 * collapsing those would corrupt the contract. Otherwise the definition gets a
 * deterministic numbered suffix.
 *
 * @param name - The name Zod assigned to the definition.
 * @param definition - The definition being hoisted.
 * @param schemas - The definitions collected so far.
 * @returns The name the definition will be stored under.
 */
function resolveDefinitionName(
  name: string,
  definition: JsonSchemaValue,
  schemas: Record<string, OpenAPISchema>
): string {
  const existing = schemas[name];
  if (existing === undefined) {
    return name;
  }

  const canDeduplicate =
    !containsLocalReference(definition) &&
    !containsLocalReference(existing) &&
    stableStringify(existing) === stableStringify(definition);
  if (canDeduplicate) {
    return name;
  }

  let suffix = 2;
  let candidate = `${name}_${suffix}`;
  while (schemas[candidate] !== undefined) {
    suffix += 1;
    candidate = `${name}_${suffix}`;
  }
  return candidate;
}

/**
 * Checks whether a schema contains a local `#/$defs/` reference anywhere.
 *
 * Such references resolve relative to the conversion that produced them, so a
 * definition containing one cannot be safely deduplicated by text alone.
 *
 * @param value - The node to inspect.
 * @returns True when a local reference is present.
 */
function containsLocalReference(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsLocalReference);
  }
  if (!isJsonObject(value)) {
    return false;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (key === '$ref' && typeof entry === 'string' && entry.startsWith('#/$defs/')) {
      return true;
    }
    if (containsLocalReference(entry)) {
      return true;
    }
  }
  return false;
}

/**
 * Rewrites local `#/$defs/<name>` references that were renamed during hoisting.
 *
 * References to names that were not renamed are left for the later document-wide
 * rewrite so the two passes never conflict.
 *
 * @param value - The node to walk.
 * @param rename - The map from original name to final name.
 */
function rewriteRenamedReferences(value: unknown, rename: Map<string, string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      rewriteRenamedReferences(entry, rename);
    }
    return;
  }
  if (!isJsonObject(value)) {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (key === '$ref' && typeof entry === 'string' && entry.startsWith('#/$defs/')) {
      const renamed = rename.get(entry.slice('#/$defs/'.length));
      if (renamed !== undefined) {
        value[key] = `#/components/schemas/${renamed}`;
      }
      continue;
    }
    rewriteRenamedReferences(entry, rename);
  }
}

/**
 * Rewrites every local `#/$defs/` reference to `#/components/schemas/`.
 *
 * @param value - The node to walk.
 */
function rewriteReferences(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      rewriteReferences(entry);
    }
    return;
  }
  if (!isJsonObject(value)) {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (key === '$ref' && typeof entry === 'string' && entry.startsWith('#/$defs/')) {
      value[key] = entry.replace('#/$defs/', '#/components/schemas/');
      continue;
    }
    rewriteReferences(entry);
  }
}

/**
 * Throws when any local `#/$defs/` reference remains after hoisting.
 *
 * @param value - The node to walk.
 * @throws {Error} When an unresolvable local reference is found.
 */
function assertNoLocalReferences(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertNoLocalReferences(entry);
    }
    return;
  }
  if (!isJsonObject(value)) {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (key === '$ref' && typeof entry === 'string' && entry.includes('#/$defs/')) {
      throw new Error(`Unresolvable local schema reference after hoisting: ${entry}`);
    }
    assertNoLocalReferences(entry);
  }
}

/**
 * Serializes a value to a canonical JSON string with sorted object keys.
 *
 * Used to decide whether two same-named definitions are structurally equal so
 * identical definitions can be deduplicated. Two different key orders for the
 * same structure produce the same string.
 *
 * @param value - The value to serialize.
 * @returns A stable JSON string.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (isJsonObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
