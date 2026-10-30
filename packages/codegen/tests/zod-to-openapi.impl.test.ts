import { describe, test, expect } from 'vitest';
import { z } from 'zod';
import {
  convertZodToJsonSchema,
  convertZodToQueryParameters,
  hoistDefinitions,
} from '../src/generator/zod-to-openapi.js';
import type { OpenAPIDocument, OpenAPISchema } from '../src/generator/openapi-types.js';

/**
 * Implementation tests for the native Zod → OpenAPI converter.
 *
 * These cover the conversion shapes, the query splitter, the `$defs` hoisting
 * step, and the edge cases that the specification tests do not pin. They are
 * derived from the implementation contract, so they may change with it.
 */
describe('convertZodToJsonSchema', () => {
  test('drops the draft-2020-12 $schema marker from the output', () => {
    const schema = convertZodToJsonSchema(z.string(), 'input');

    expect(schema).toEqual({ type: 'string' });
    expect(schema).not.toHaveProperty('$schema');
  });

  test('returns a permissive object for a value that is not a Zod schema', () => {
    expect(convertZodToJsonSchema(null as never, 'input')).toEqual({ type: 'object' });
    expect(convertZodToJsonSchema('nope' as never, 'input')).toEqual({ type: 'object' });
    expect(convertZodToJsonSchema(undefined as never, 'input')).toEqual({ type: 'object' });
  });

  test('converts an object with required, optional, and defaulted properties', () => {
    const schema = convertZodToJsonSchema(
      z.object({
        name: z.string(),
        nickname: z.string().optional(),
        role: z.enum(['admin', 'user']).default('user'),
      }),
      'input'
    );

    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['name']);
    expect(schema.properties!.nickname).toEqual({ type: 'string' });
    expect(schema.properties!.role).toMatchObject({
      type: 'string',
      enum: ['admin', 'user'],
      default: 'user',
    });
  });

  test('converts arrays and preserves item shape', () => {
    const schema = convertZodToJsonSchema(z.array(z.object({ id: z.number() })), 'input');

    expect(schema.type).toBe('array');
    expect(schema.items).toMatchObject({
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    });
  });

  test('converts a union to anyOf', () => {
    const schema = convertZodToJsonSchema(z.union([z.string(), z.number()]), 'input');

    expect(schema.anyOf).toEqual([{ type: 'string' }, { type: 'number' }]);
  });

  test('folds a nullable field inside an array into a type array', () => {
    const schema = convertZodToJsonSchema(z.array(z.string().nullable()), 'input');

    expect(schema).toEqual({ type: 'array', items: { type: ['string', 'null'] } });
  });

  test('preserves the default value of a primitive', () => {
    const schema = convertZodToJsonSchema(z.number().default(42), 'input');

    expect(schema).toMatchObject({ type: 'number', default: 42 });
  });

  test('uses the input type for a transform', () => {
    const schema = convertZodToJsonSchema(
      z.string().transform(value => value.toUpperCase()),
      'input'
    );

    expect(schema).toEqual({ type: 'string' });
  });

  test('emits a permissive schema for an unrepresentable type instead of throwing', () => {
    const schema = convertZodToJsonSchema(z.object({ when: z.date() }), 'input');

    expect(schema.type).toBe('object');
    expect(schema.properties!.when).toEqual({});
  });

  test('converts a discriminated union to oneOf', () => {
    const schema = convertZodToJsonSchema(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), value: z.string() }),
        z.object({ kind: z.literal('b'), value: z.number() }),
      ]),
      'input'
    );

    expect(schema.oneOf).toHaveLength(2);
  });
});

describe('convertZodToQueryParameters', () => {
  test('splits an object into one parameter per property', () => {
    const parameters = convertZodToQueryParameters(
      z.object({ page: z.coerce.number().default(1), search: z.string().optional() })
    );

    expect(parameters).toHaveLength(2);
    expect(parameters.find(parameter => parameter.name === 'page')).toMatchObject({
      in: 'query',
      schema: { type: 'number', default: 1 },
    });
    expect(parameters.find(parameter => parameter.name === 'search')!.required).toBeUndefined();
  });

  test('marks required properties as required parameters', () => {
    const parameters = convertZodToQueryParameters(z.object({ category: z.string() }));

    expect(parameters[0]).toMatchObject({ name: 'category', in: 'query', required: true });
  });

  test('returns no parameters for a non-object schema', () => {
    expect(convertZodToQueryParameters(z.string())).toEqual([]);
    expect(convertZodToQueryParameters(z.object({}))).toEqual([]);
  });

  test('returns no parameters for a value that is not a Zod schema', () => {
    expect(convertZodToQueryParameters(null as never)).toEqual([]);
  });
});

describe('hoistDefinitions', () => {
  /**
   * Builds a document whose only operation returns a schema, so the hoisting
   * logic has a place to find `$defs`.
   *
   * @param schema - The response schema to embed.
   * @returns A minimal OpenAPI document.
   */
  function documentWithResponse(schema: OpenAPISchema): OpenAPIDocument {
    return {
      openapi: '3.1.0',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/things': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                content: { 'application/json': { schema } },
              },
            },
          },
        },
      },
    };
  }

  test('returns the document unchanged when there are no definitions', () => {
    const document = documentWithResponse({ type: 'string' });
    const result = hoistDefinitions(document);

    expect(result.components).toBeUndefined();
  });

  test('moves reused named schemas into sorted components.schemas and rewrites refs', () => {
    const product = z.object({ id: z.number(), name: z.string() }).meta({ id: 'Product' });
    const schema = convertZodToJsonSchema(z.object({ a: product, b: product }), 'input');
    const document = documentWithResponse(schema);

    const result = hoistDefinitions(document);

    expect(result.components!.schemas!.Product).toBeDefined();
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('#/components/schemas/Product');
    expect(serialized).not.toContain('$defs');
  });

  test('preserves existing component entries such as securitySchemes', () => {
    const product = z.object({ id: z.number() }).meta({ id: 'Product' });
    const schema = convertZodToJsonSchema(z.object({ a: product, b: product }), 'input');
    const document = documentWithResponse(schema);
    document.components = {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    };

    const result = hoistDefinitions(document);

    expect(result.components!.securitySchemes!.bearerAuth).toEqual({
      type: 'http',
      scheme: 'bearer',
    });
    expect(result.components!.schemas!.Product).toBeDefined();
  });

  test('produces sorted schema names', () => {
    const alpha = z.object({ id: z.number() }).meta({ id: 'Alpha' });
    const zeta = z.object({ id: z.number() }).meta({ id: 'Zeta' });
    const schema = convertZodToJsonSchema(
      z.object({ a: zeta, b: zeta, c: alpha, d: alpha }),
      'input'
    );
    const document = documentWithResponse(schema);

    const result = hoistDefinitions(document);

    const names = Object.keys(result.components!.schemas!);
    expect(names).toContain('Alpha');
    expect(names).toContain('Zeta');
    expect(names).toEqual([...names].sort());
  });

  test('keeps random-named definitions from different operations apart', () => {
    /**
     * Builds a schema whose local `$defs` reference a nested schema, so two
     * operations can produce textually equal definitions that resolve to
     * different inner shapes.
     *
     * @param inner - The nested schema to wrap.
     * @returns A Zod object reused across the conversion.
     */
    function build(inner: z.ZodType) {
      const wrapped = z.object({ value: inner });
      return z.object({ a: wrapped, b: wrapped, c: inner });
    }

    /**
     * Follows a single `$ref` into the collected component schemas.
     *
     * @param schema - The schema, possibly a reference.
     * @param schemas - The collected component schemas.
     * @returns The referenced schema, or the input when it is not a reference.
     */
    function dereference(
      schema: OpenAPISchema | undefined,
      schemas: Record<string, OpenAPISchema>
    ): OpenAPISchema | undefined {
      if (schema && typeof schema.$ref === 'string') {
        return schemas[schema.$ref.replace('#/components/schemas/', '')];
      }
      return schema;
    }

    const first = convertZodToJsonSchema(build(z.object({ x: z.number() })), 'input');
    const second = convertZodToJsonSchema(build(z.object({ y: z.string() })), 'input');

    const document: OpenAPIDocument = {
      openapi: '3.1.0',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/first': {
          get: {
            responses: {
              '200': { description: 'OK', content: { 'application/json': { schema: first } } },
            },
          },
        },
        '/second': {
          get: {
            responses: {
              '200': { description: 'OK', content: { 'application/json': { schema: second } } },
            },
          },
        },
      },
    };

    const result = hoistDefinitions(document);
    const schemas = result.components!.schemas!;

    const firstRoot =
      result.paths['/first'].get!.responses!['200'].content!['application/json'].schema!;
    const firstInner = dereference(
      dereference(firstRoot.properties!.a, schemas)?.properties?.value,
      schemas
    );
    expect(firstInner?.properties).toHaveProperty('x');

    const secondRoot =
      result.paths['/second'].get!.responses!['200'].content!['application/json'].schema!;
    const secondInner = dereference(
      dereference(secondRoot.properties!.a, schemas)?.properties?.value,
      schemas
    );
    expect(secondInner?.properties).toHaveProperty('y');

    expect(JSON.stringify(result)).not.toContain('$defs');
  });
});
