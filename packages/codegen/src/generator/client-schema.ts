/**
 * OpenAPI schema to TypeScript type-text emitter.
 *
 * The generator writes type text directly rather than building an abstract
 * syntax tree, so it needs no TypeScript compiler API. This module understands
 * the JSON Schema subset that the Zod→OpenAPI converter produces: objects,
 * arrays, `$ref`, type-array nullability, `enum`/`const`, `anyOf`/`oneOf`,
 * `allOf`, and the primitive types. Anything it does not understand becomes
 * `unknown`, which is always safe for a generated client.
 *
 * @module
 */
import type { OpenAPISchema } from './openapi-types.js';
import { pascalCase, sanitizeIdentifier } from './client-naming.js';

/** Maps a `$ref` string to the TypeScript type name it resolves to. */
export type ReferenceResolver = (reference: string) => string;

/** Matches property names that can be written without quotes. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

/** Primitive JSON Schema types mapped to their TypeScript equivalents. */
const PRIMITIVES: Readonly<Record<string, string>> = {
  string: 'string',
  number: 'number',
  integer: 'number',
  boolean: 'boolean',
  null: 'null',
};

/**
 * Converts one schema into a TypeScript type expression.
 *
 * @param schema - The schema to convert, or `undefined`.
 * @param resolveReference - Maps a `$ref` to a type name. Defaults to the last
 *   path segment of the reference, which is the component schema name.
 * @returns A TypeScript type expression. Unknown shapes become `unknown`.
 *
 * @example
 * ```typescript
 * schemaToType({ type: ['string', 'null'] }); // 'string | null'
 * ```
 */
export function schemaToType(
  schema: OpenAPISchema | undefined,
  resolveReference: ReferenceResolver = defaultResolveReference
): string {
  if (!schema) {
    return 'unknown';
  }
  if (typeof schema.$ref === 'string') {
    return resolveReference(schema.$ref);
  }
  if (schema.const !== undefined) {
    return literal(schema.const);
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return union(schema.enum.map(literal));
  }
  if (schema.allOf && schema.allOf.length > 0) {
    const outer = schemaToType({ ...schema, allOf: undefined }, resolveReference);
    const members = schema.allOf.map(member => schemaToType(member, resolveReference));
    return intersection([outer, ...members]);
  }
  if (schema.anyOf && schema.anyOf.length > 0) {
    return union(schema.anyOf.map(member => schemaToType(member, resolveReference)));
  }
  if (schema.oneOf && schema.oneOf.length > 0) {
    return union(schema.oneOf.map(member => schemaToType(member, resolveReference)));
  }

  const types = toTypeList(schema.type);
  const nullable = types.includes('null');
  const concrete = types.filter(type => type !== 'null');
  const base = baseType(schema, concrete, resolveReference);
  if (!nullable) {
    return base;
  }
  return base === 'null' ? 'null' : union([base, 'null']);
}

/**
 * Resolves a `$ref` to its component schema name.
 *
 * @param reference - A reference such as `#/components/schemas/Product`.
 * @returns The sanitized last reference segment.
 */
export function defaultResolveReference(reference: string): string {
  const segment = reference.split('/').pop();
  return componentTypeName(segment && segment.length > 0 ? segment : 'unknown');
}

/**
 * Makes a component schema name safe to use as a TypeScript type name.
 *
 * Component names come from author metadata (`.meta({ id })`), so a name that
 * is not a valid identifier is normalized with the shared naming rules rather
 * than injected verbatim into the generated file.
 *
 * @param raw - The component schema name.
 * @returns A valid identifier.
 */
export function componentTypeName(raw: string): string {
  const normalized = IDENTIFIER.test(raw) ? raw : pascalCase(raw);
  return sanitizeIdentifier(normalized || 'Schema');
}

/**
 * Chooses the base type when nullability has been removed.
 *
 * @param schema - The schema being converted.
 * @param types - The schema's non-null type names.
 * @param resolveReference - Maps a `$ref` to a type name.
 * @returns The base TypeScript type expression.
 */
function baseType(
  schema: OpenAPISchema,
  types: string[],
  resolveReference: ReferenceResolver
): string {
  const objectLike =
    types.includes('object') ||
    schema.properties !== undefined ||
    schema.additionalProperties !== undefined;
  if (objectLike) {
    return objectType(schema, resolveReference);
  }
  const arrayLike = types.includes('array') || schema.items !== undefined;
  if (arrayLike) {
    return arrayType(schema, resolveReference);
  }
  const primitive = types.length === 1 ? PRIMITIVES[types[0]] : undefined;
  return primitive ?? 'unknown';
}

/**
 * Converts an object schema into an inline object type.
 *
 * Property names are sorted so the emitted text is byte-stable. Optional
 * properties get a `?`; `additionalProperties` becomes an index signature.
 *
 * @param schema - The object schema.
 * @param resolveReference - Maps a `$ref` to a type name.
 * @returns An object type expression.
 */
function objectType(schema: OpenAPISchema, resolveReference: ReferenceResolver): string {
  const properties = Object.entries(schema.properties ?? {}).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const additional = schema.additionalProperties;

  if (properties.length === 0) {
    if (additional && typeof additional === 'object') {
      return `Record<string, ${schemaToType(additional, resolveReference)}>`;
    }
    return 'Record<string, unknown>';
  }

  const required = new Set(schema.required ?? []);
  const members = properties.map(
    ([name, value]) =>
      `${propertyName(name)}${required.has(name) ? '' : '?'}: ${schemaToType(value, resolveReference)};`
  );
  if (additional && typeof additional === 'object') {
    members.push(`[key: string]: ${schemaToType(additional, resolveReference)};`);
  } else if (additional === true) {
    members.push('[key: string]: unknown;');
  }
  return `{ ${members.join(' ')} }`;
}

/**
 * Converts an array schema into a TypeScript array type.
 *
 * @param schema - The array schema.
 * @param resolveReference - Maps a `$ref` to a type name.
 * @returns An array type expression.
 */
function arrayType(schema: OpenAPISchema, resolveReference: ReferenceResolver): string {
  const item = schema.items ? schemaToType(schema.items, resolveReference) : 'unknown';
  return needsParentheses(item) ? `(${item})[]` : `${item}[]`;
}

/**
 * Writes a property name, quoting it when it is not a valid identifier.
 *
 * @param name - The raw property name.
 * @returns An identifier or a quoted string.
 */
function propertyName(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/**
 * Writes a literal value as a TypeScript literal type.
 *
 * @param value - A string, number, boolean, or null.
 * @returns The literal type text; non-primitive values become `unknown`.
 */
function literal(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return 'unknown';
}

/**
 * Joins type expressions into a union, removing duplicates and empties.
 *
 * @param members - The member type expressions.
 * @param separator - The join separator; defaults to ` | `.
 * @returns The joined type expression.
 */
function union(members: string[], separator = ' | '): string {
  const unique = [...new Set(members.filter(member => member.length > 0))];
  if (unique.length === 0) {
    return 'unknown';
  }
  return unique.join(separator);
}

/**
 * Joins type expressions into an intersection.
 *
 * A member of `unknown` adds no constraint (`A & unknown` is `A`), so unknown
 * members are dropped. This keeps the parent schema's own type when an `allOf`
 * only carries constraints such as `pattern`, which is how the Zod→OpenAPI
 * converter represents refinements on a known type.
 *
 * @param members - The member type expressions.
 * @returns The intersected type expression, or `unknown` when nothing remains.
 */
function intersection(members: string[]): string {
  const unique = [...new Set(members.filter(member => member.length > 0 && member !== 'unknown'))];
  if (unique.length === 0) {
    return 'unknown';
  }
  return unique.map(member => (needsParentheses(member) ? `(${member})` : member)).join(' & ');
}

/**
 * Normalizes the `type` field into a list.
 *
 * @param type - A single type name, a list, or undefined.
 * @returns The type names as an array.
 */
function toTypeList(type: OpenAPISchema['type']): string[] {
  if (Array.isArray(type)) {
    return type;
  }
  return type ? [type] : [];
}

/**
 * Reports whether a compound type expression must be parenthesized for `[]`.
 *
 * @param type - The type expression.
 * @returns True when the expression contains a union or intersection.
 */
function needsParentheses(type: string): boolean {
  return type.includes(' | ') || type.includes(' & ');
}
