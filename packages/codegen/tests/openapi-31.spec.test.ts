import { describe, test, expect } from 'vitest';
import { z } from 'zod';
import type { RouteDefinition } from '@blendsdk/webafx';
import { OpenAPIGenerator } from '../src/generator/openapi-generator.js';
import { convertZodToJsonSchema } from '../src/generator/zod-to-openapi.js';

/**
 * Behavioural contract for the OpenAPI 3.1 document the client generator reads.
 *
 * Two behaviours are pinned here. First, every operation records how a client
 * must read its successful response: routes that do not opt in use the `data`
 * envelope, and a route can opt into the `body` envelope for paginated bodies.
 * Second, nullable Zod fields are converted to JSON Schema type arrays
 * (`['string', 'null']`) rather than the OpenAPI 3.0 `nullable` keyword, which
 * an OpenAPI 3.1 consumer is not required to understand.
 */
describe('OpenAPI 3.1 contract fidelity', () => {
  /**
   * Builds a minimal route definition for the generator.
   *
   * @param overrides - Route fields to merge over the defaults.
   * @returns A complete route definition with OpenAPI metadata.
   */
  function createRoute(overrides: Partial<RouteDefinition>): RouteDefinition {
    return {
      method: 'get',
      path: '/',
      handler: () => {},
      ...overrides,
    } as RouteDefinition;
  }

  test('an operation without an explicit envelope is marked with the data envelope', () => {
    const generator = new OpenAPIGenerator({ title: 'Test', version: '1.0.0' });
    generator.addRoutes('/api', [createRoute({ path: '/items', openapi: { summary: 'Items' } })]);

    const operation = generator.generate().paths['/api/items'].get!;

    expect(operation['x-blend-envelope']).toBe('data');
  });

  test('an operation that opts into the body envelope carries that signal', () => {
    const generator = new OpenAPIGenerator({ title: 'Test', version: '1.0.0' });
    generator.addRoutes('/api', [
      createRoute({ path: '/items', openapi: { summary: 'Items', envelope: 'body' } }),
    ]);

    const operation = generator.generate().paths['/api/items'].get!;

    expect(operation['x-blend-envelope']).toBe('body');
  });

  test('a nullable field becomes a JSON Schema type array, not the nullable keyword', () => {
    const schema = convertZodToJsonSchema(z.string().nullable(), 'input');

    expect(schema).toEqual({ type: ['string', 'null'] });
    expect(schema).not.toHaveProperty('nullable');
  });

  test('a nullable number becomes a type array', () => {
    const schema = convertZodToJsonSchema(z.number().nullable(), 'input');

    expect(schema).toEqual({ type: ['number', 'null'] });
  });

  test('a deeply nested nullable field also becomes a type array', () => {
    const schema = convertZodToJsonSchema(
      z.object({ profile: z.object({ nickname: z.string().nullable() }) }),
      'input'
    );

    expect(schema).toMatchObject({
      type: 'object',
      properties: {
        profile: {
          type: 'object',
          properties: { nickname: { type: ['string', 'null'] } },
        },
      },
    });
  });

  test('a nullable enum keeps a null branch instead of losing nullability', () => {
    const schema = convertZodToJsonSchema(z.enum(['a', 'b']).nullable(), 'input');

    expect(schema).toEqual({
      anyOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'null' }],
    });
  });
});
