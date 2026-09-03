import { describe, test, expect } from 'vitest';
import { z } from 'zod';
import { zodToOpenAPISchema, zodToQueryParameters } from '../src/generator/zod-to-openapi.js';
import { OpenAPIGenerator } from '../src/generator/openapi-generator.js';

/**
 * Tests for zodToOpenAPISchema — Zod v4 → OpenAPI JSON Schema converter.
 * Covers: primitive types, constraints, enums, literals, arrays, objects,
 * optional, nullable, default, coerce, unions, and nested structures.
 */
describe('zodToOpenAPISchema', () => {
  // ─── Primitive Types ──────────────────────────────────────────────────

  describe('primitive types', () => {
    test('z.string() → { type: "string" }', () => {
      const result = zodToOpenAPISchema(z.string());
      expect(result).toEqual({ type: 'string' });
    });

    test('z.number() → { type: "number" }', () => {
      const result = zodToOpenAPISchema(z.number());
      expect(result).toEqual({ type: 'number' });
    });

    test('z.boolean() → { type: "boolean" }', () => {
      const result = zodToOpenAPISchema(z.boolean());
      expect(result).toEqual({ type: 'boolean' });
    });
  });

  // ─── String Constraints ───────────────────────────────────────────────

  describe('string constraints', () => {
    test('z.string().min(1) adds minLength', () => {
      const result = zodToOpenAPISchema(z.string().min(1));
      expect(result.type).toBe('string');
      expect(result.minLength).toBe(1);
    });

    test('z.string().max(100) adds maxLength', () => {
      const result = zodToOpenAPISchema(z.string().max(100));
      expect(result.type).toBe('string');
      expect(result.maxLength).toBe(100);
    });

    test('z.string().min(3).max(50) adds both minLength and maxLength', () => {
      const result = zodToOpenAPISchema(z.string().min(3).max(50));
      expect(result.type).toBe('string');
      expect(result.minLength).toBe(3);
      expect(result.maxLength).toBe(50);
    });

    test('z.string().email() adds format: "email"', () => {
      const result = zodToOpenAPISchema(z.string().email());
      expect(result.type).toBe('string');
      expect(result.format).toBe('email');
    });

    test('z.string().url() adds format: "url"', () => {
      const result = zodToOpenAPISchema(z.string().url());
      expect(result.type).toBe('string');
      expect(result.format).toBe('url');
    });

    test('z.string().uuid() adds format: "uuid"', () => {
      const result = zodToOpenAPISchema(z.string().uuid());
      expect(result.type).toBe('string');
      expect(result.format).toBe('uuid');
    });
  });

  // ─── Number Constraints ───────────────────────────────────────────────

  describe('number constraints', () => {
    test('z.number().int() → { type: "integer" }', () => {
      const result = zodToOpenAPISchema(z.number().int());
      expect(result.type).toBe('integer');
    });

    test('z.number().min(0) adds minimum', () => {
      const result = zodToOpenAPISchema(z.number().min(0));
      expect(result.type).toBe('number');
      expect(result.minimum).toBe(0);
    });

    test('z.number().max(100) adds maximum', () => {
      const result = zodToOpenAPISchema(z.number().max(100));
      expect(result.type).toBe('number');
      expect(result.maximum).toBe(100);
    });

    test('z.number().min(0).max(100) adds both minimum and maximum', () => {
      const result = zodToOpenAPISchema(z.number().min(0).max(100));
      expect(result.minimum).toBe(0);
      expect(result.maximum).toBe(100);
    });

    test('z.number().int().min(1).max(999) is integer with min/max', () => {
      const result = zodToOpenAPISchema(z.number().int().min(1).max(999));
      expect(result.type).toBe('integer');
      expect(result.minimum).toBe(1);
      expect(result.maximum).toBe(999);
    });
  });

  // ─── Enum & Literal ───────────────────────────────────────────────────

  describe('enum and literal', () => {
    test('z.enum(["active", "inactive"]) → string with enum values', () => {
      const result = zodToOpenAPISchema(z.enum(['active', 'inactive']));
      expect(result.type).toBe('string');
      expect(result.enum).toEqual(['active', 'inactive']);
    });

    test('z.literal("hello") → string with single enum value', () => {
      const result = zodToOpenAPISchema(z.literal('hello'));
      expect(result.type).toBe('string');
      expect(result.enum).toEqual(['hello']);
    });

    test('z.literal(42) → number with single enum value', () => {
      const result = zodToOpenAPISchema(z.literal(42));
      expect(result.type).toBe('number');
      expect(result.enum).toEqual([42]);
    });

    test('z.literal(true) → boolean with single enum value', () => {
      const result = zodToOpenAPISchema(z.literal(true));
      expect(result.type).toBe('boolean');
      expect(result.enum).toEqual([true]);
    });
  });

  // ─── Array Type ───────────────────────────────────────────────────────

  describe('array type', () => {
    test('z.array(z.string()) → array of strings', () => {
      const result = zodToOpenAPISchema(z.array(z.string()));
      expect(result.type).toBe('array');
      expect(result.items).toEqual({ type: 'string' });
    });

    test('z.array(z.number()) → array of numbers', () => {
      const result = zodToOpenAPISchema(z.array(z.number()));
      expect(result.type).toBe('array');
      expect(result.items).toEqual({ type: 'number' });
    });

    test('z.array(z.string()).min(1).max(10) adds minItems and maxItems', () => {
      const result = zodToOpenAPISchema(z.array(z.string()).min(1).max(10));
      expect(result.type).toBe('array');
      expect(result.minItems).toBe(1);
      expect(result.maxItems).toBe(10);
    });

    test('z.array(z.object({ id: z.number() })) → array of objects', () => {
      const result = zodToOpenAPISchema(z.array(z.object({ id: z.number() })));
      expect(result.type).toBe('array');
      expect(result.items).toEqual({
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
      });
    });
  });

  // ─── Object Type ──────────────────────────────────────────────────────

  describe('object type', () => {
    test('z.object({}) → empty object', () => {
      const result = zodToOpenAPISchema(z.object({}));
      expect(result.type).toBe('object');
      expect(result.properties).toBeUndefined();
      expect(result.required).toBeUndefined();
    });

    test('z.object({ name: z.string() }) → object with required property', () => {
      const result = zodToOpenAPISchema(z.object({ name: z.string() }));
      expect(result.type).toBe('object');
      expect(result.properties).toEqual({ name: { type: 'string' } });
      expect(result.required).toEqual(['name']);
    });

    test('z.object({ name: z.string(), age: z.number() }) → multiple required properties', () => {
      const result = zodToOpenAPISchema(z.object({ name: z.string(), age: z.number() }));
      expect(result.type).toBe('object');
      expect(result.properties).toEqual({
        name: { type: 'string' },
        age: { type: 'number' },
      });
      expect(result.required).toEqual(['name', 'age']);
    });

    test('optional properties are NOT in required list', () => {
      const result = zodToOpenAPISchema(
        z.object({
          name: z.string(),
          nickname: z.string().optional(),
        })
      );
      expect(result.required).toEqual(['name']);
      expect(result.properties!.nickname).toEqual({ type: 'string' });
    });

    test('properties with defaults are NOT in required list', () => {
      const result = zodToOpenAPISchema(
        z.object({
          name: z.string(),
          role: z.string().default('user'),
        })
      );
      expect(result.required).toEqual(['name']);
      expect(result.properties!.role).toEqual({ type: 'string', default: 'user' });
    });
  });

  // ─── Optional / Nullable / Default Wrappers ───────────────────────────

  describe('wrapper types', () => {
    test('z.string().optional() → string (unwrapped)', () => {
      const result = zodToOpenAPISchema(z.string().optional());
      expect(result.type).toBe('string');
    });

    test('z.string().nullable() → string with nullable: true', () => {
      const result = zodToOpenAPISchema(z.string().nullable());
      expect(result.type).toBe('string');
      expect(result.nullable).toBe(true);
    });

    test('z.string().default("hello") → string with default value', () => {
      const result = zodToOpenAPISchema(z.string().default('hello'));
      expect(result.type).toBe('string');
      expect(result.default).toBe('hello');
    });

    test('z.number().default(42) → number with default value', () => {
      const result = zodToOpenAPISchema(z.number().default(42));
      expect(result.type).toBe('number');
      expect(result.default).toBe(42);
    });

    test('z.boolean().default(false) → boolean with default value', () => {
      const result = zodToOpenAPISchema(z.boolean().default(false));
      expect(result.type).toBe('boolean');
      expect(result.default).toBe(false);
    });
  });

  // ─── Coerce Types ────────────────────────────────────────────────────

  describe('coerce types', () => {
    test('z.coerce.number() → { type: "number" }', () => {
      const result = zodToOpenAPISchema(z.coerce.number());
      expect(result.type).toBe('number');
    });

    test('z.coerce.string() → { type: "string" }', () => {
      const result = zodToOpenAPISchema(z.coerce.string());
      expect(result.type).toBe('string');
    });

    test('z.coerce.boolean() → { type: "boolean" }', () => {
      const result = zodToOpenAPISchema(z.coerce.boolean());
      expect(result.type).toBe('boolean');
    });
  });

  // ─── Union Type ──────────────────────────────────────────────────────

  describe('union type', () => {
    test('z.union([z.string(), z.number()]) → anyOf with string and number', () => {
      const result = zodToOpenAPISchema(z.union([z.string(), z.number()]));
      expect(result.anyOf).toEqual([{ type: 'string' }, { type: 'number' }]);
    });
  });

  // ─── Nested / Complex Structures ──────────────────────────────────────

  describe('nested structures', () => {
    test('nested object with mixed types', () => {
      const schema = z.object({
        name: z.string().min(1),
        email: z.string().email(),
        age: z.number().int().optional(),
        role: z.enum(['admin', 'user']).default('user'),
        tags: z.array(z.string()),
      });

      const result = zodToOpenAPISchema(schema);

      expect(result.type).toBe('object');
      expect(result.properties!.name).toEqual({ type: 'string', minLength: 1 });
      expect(result.properties!.email).toEqual({ type: 'string', format: 'email' });
      expect(result.properties!.age).toEqual({ type: 'integer' });
      expect(result.properties!.role).toEqual({
        type: 'string',
        enum: ['admin', 'user'],
        default: 'user',
      });
      expect(result.properties!.tags).toEqual({
        type: 'array',
        items: { type: 'string' },
      });

      // name, email, tags are required; age (optional) and role (default) are not
      expect(result.required).toEqual(['name', 'email', 'tags']);
    });

    test('deeply nested objects', () => {
      const schema = z.object({
        user: z.object({
          name: z.string(),
          address: z.object({
            street: z.string(),
            city: z.string(),
          }),
        }),
      });

      const result = zodToOpenAPISchema(schema);
      expect(result.type).toBe('object');
      expect(result.properties!.user).toEqual({
        type: 'object',
        properties: {
          name: { type: 'string' },
          address: {
            type: 'object',
            properties: {
              street: { type: 'string' },
              city: { type: 'string' },
            },
            required: ['street', 'city'],
          },
        },
        required: ['name', 'address'],
      });
    });
  });

  // ─── Transform / Pipe Types ───────────────────────────────────────────

  describe('transform and pipe types', () => {
    test('z.string().transform() uses input type (string)', () => {
      const schema = z.string().transform(val => val.toUpperCase());
      const result = zodToOpenAPISchema(schema);
      expect(result).toEqual({ type: 'string' });
    });

    test('z.string().transform(split) uses input type (string), not output (array)', () => {
      // This is the "tags" pattern from ProductsController
      const schema = z
        .string()
        .transform(val =>
          val
            .split(',')
            .map(t => t.trim())
            .filter(Boolean)
        );
      const result = zodToOpenAPISchema(schema);
      expect(result).toEqual({ type: 'string' });
    });

    test('z.string().min(1).transform() preserves input constraints', () => {
      const schema = z
        .string()
        .min(1)
        .transform(val => val.toUpperCase());
      const result = zodToOpenAPISchema(schema);
      expect(result).toEqual({ type: 'string', minLength: 1 });
    });

    test('z.number().int().transform() preserves input as integer', () => {
      const schema = z
        .number()
        .int()
        .transform(val => val * 2);
      const result = zodToOpenAPISchema(schema);
      expect(result).toEqual({ type: 'integer' });
    });

    test('z.object({...}).transform() uses input object schema', () => {
      const schema = z
        .object({ name: z.string(), age: z.number() })
        .transform(obj => `${obj.name}: ${obj.age}`);
      const result = zodToOpenAPISchema(schema);
      expect(result).toEqual({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name', 'age'],
      });
    });

    test('z.string().pipe(z.number()) uses input type (string)', () => {
      const schema = z.string().pipe(z.number());
      const result = zodToOpenAPISchema(schema);
      expect(result).toEqual({ type: 'string' });
    });

    test('transform property inside object uses input type', () => {
      const schema = z.object({
        name: z.string(),
        tags: z
          .string()
          .transform(val =>
            val
              .split(',')
              .map(t => t.trim())
              .filter(Boolean)
          ),
      });
      const result = zodToOpenAPISchema(schema);
      expect(result.type).toBe('object');
      // tags should be { type: 'string' }, not { type: 'object' }
      expect(result.properties!.tags).toEqual({ type: 'string' });
      // Both name and tags are required (transform doesn't make it optional)
      expect(result.required).toEqual(['name', 'tags']);
    });

    test('optional transform property is not required', () => {
      const schema = z.object({
        name: z.string(),
        nickname: z
          .string()
          .transform(val => val.toUpperCase())
          .optional(),
      });
      const result = zodToOpenAPISchema(schema);
      expect(result.required).toEqual(['name']);
      // nickname should still show the input type (string)
      expect(result.properties!.nickname).toEqual({ type: 'string' });
    });
  });

  // ─── Edge Cases ───────────────────────────────────────────────────────

  describe('edge cases', () => {
    test('non-Zod value returns fallback object schema', () => {
      const result = zodToOpenAPISchema('not a schema');
      expect(result).toEqual({ type: 'object' });
    });

    test('null returns fallback object schema', () => {
      const result = zodToOpenAPISchema(null);
      expect(result).toEqual({ type: 'object' });
    });

    test('undefined returns fallback object schema', () => {
      const result = zodToOpenAPISchema(undefined);
      expect(result).toEqual({ type: 'object' });
    });
  });
});

/**
 * Tests for zodToQueryParameters — Zod object → OpenAPI query parameters.
 * Covers: required/optional params, defaults, mixed types, non-object schemas.
 */
describe('zodToQueryParameters', () => {
  test('converts object properties to query parameters', () => {
    const schema = z.object({
      page: z.number(),
      limit: z.number(),
    });

    const params = zodToQueryParameters(schema);
    expect(params).toHaveLength(2);

    expect(params[0].name).toBe('page');
    expect(params[0].in).toBe('query');
    expect(params[0].required).toBe(true);
    expect(params[0].schema).toEqual({ type: 'number' });

    expect(params[1].name).toBe('limit');
    expect(params[1].in).toBe('query');
    expect(params[1].required).toBe(true);
    expect(params[1].schema).toEqual({ type: 'number' });
  });

  test('optional properties become non-required params', () => {
    const schema = z.object({
      search: z.string().optional(),
      page: z.number(),
    });

    const params = zodToQueryParameters(schema);
    expect(params).toHaveLength(2);

    const searchParam = params.find(p => p.name === 'search')!;
    expect(searchParam.required).toBeUndefined();
    expect(searchParam.schema).toEqual({ type: 'string' });

    const pageParam = params.find(p => p.name === 'page')!;
    expect(pageParam.required).toBe(true);
  });

  test('default values appear in parameter schema', () => {
    const schema = z.object({
      page: z.coerce.number().default(1),
      limit: z.coerce.number().default(20),
    });

    const params = zodToQueryParameters(schema);

    const pageParam = params.find(p => p.name === 'page')!;
    expect(pageParam.required).toBeUndefined(); // has default, so not required
    expect(pageParam.schema).toEqual({ type: 'number', default: 1 });

    const limitParam = params.find(p => p.name === 'limit')!;
    expect(limitParam.required).toBeUndefined();
    expect(limitParam.schema).toEqual({ type: 'number', default: 20 });
  });

  test('mixed required, optional, and default params', () => {
    const schema = z.object({
      category: z.string(),
      search: z.string().optional(),
      page: z.coerce.number().default(1),
      sort: z.enum(['asc', 'desc']).default('asc'),
    });

    const params = zodToQueryParameters(schema);
    expect(params).toHaveLength(4);

    const categoryParam = params.find(p => p.name === 'category')!;
    expect(categoryParam.required).toBe(true);
    expect(categoryParam.schema).toEqual({ type: 'string' });

    const searchParam = params.find(p => p.name === 'search')!;
    expect(searchParam.required).toBeUndefined();

    const pageParam = params.find(p => p.name === 'page')!;
    expect(pageParam.required).toBeUndefined();
    expect(pageParam.schema!.default).toBe(1);

    const sortParam = params.find(p => p.name === 'sort')!;
    expect(sortParam.required).toBeUndefined();
    expect(sortParam.schema).toEqual({ type: 'string', enum: ['asc', 'desc'], default: 'asc' });
  });

  test('non-object schema returns empty array', () => {
    const params = zodToQueryParameters(z.string());
    expect(params).toEqual([]);
  });

  test('null returns empty array', () => {
    const params = zodToQueryParameters(null);
    expect(params).toEqual([]);
  });

  test('undefined returns empty array', () => {
    const params = zodToQueryParameters(undefined);
    expect(params).toEqual([]);
  });

  test('empty object returns empty array', () => {
    const params = zodToQueryParameters(z.object({}));
    expect(params).toEqual([]);
  });
});

/**
 * Tests for integrated generator Zod conversion — verifies that the generator
 * produces correct schema output when Zod schemas are provided.
 */
describe('OpenAPIGenerator — Zod integration', () => {
  /**
   * Helper to create a generator with minimal config.
   */
  function createGenerator() {
    return new OpenAPIGenerator({ title: 'Test', version: '1.0.0' });
  }

  test('POST with z.object produces correct requestBody schema', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      {
        method: 'post',
        path: '/users',
        handler: () => {},
        validation: z.object({
          name: z.string().min(1),
          email: z.string().email(),
          age: z.number().int().optional(),
        }),
        openapi: { summary: 'Create user' },
      } as any,
    ]);
    const doc = gen.generate();

    const schema = doc.paths['/api/users'].post!.requestBody!.content['application/json'].schema!;
    expect(schema.type).toBe('object');
    expect(schema.properties!.name).toEqual({ type: 'string', minLength: 1 });
    expect(schema.properties!.email).toEqual({ type: 'string', format: 'email' });
    expect(schema.properties!.age).toEqual({ type: 'integer' });
    expect(schema.required).toEqual(['name', 'email']);
  });

  test('GET with z.object produces query parameters', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      {
        method: 'get',
        path: '/products',
        handler: () => {},
        validation: z.object({
          page: z.coerce.number().default(1),
          search: z.string().optional(),
        }),
        openapi: { summary: 'List products' },
      } as any,
    ]);
    const doc = gen.generate();

    const params = doc.paths['/api/products'].get!.parameters!;
    const pageParam = params.find(p => p.name === 'page')!;
    expect(pageParam.in).toBe('query');
    expect(pageParam.schema).toEqual({ type: 'number', default: 1 });

    const searchParam = params.find(p => p.name === 'search')!;
    expect(searchParam.in).toBe('query');
    expect(searchParam.required).toBeUndefined();
    expect(searchParam.schema).toEqual({ type: 'string' });
  });

  test('response with Zod schema produces correct response schema', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      {
        method: 'get',
        path: '/health',
        handler: () => {},
        openapi: {
          summary: 'Health check',
          responses: [
            {
              statusCode: 200,
              description: 'OK',
              schema: z.object({
                status: z.enum(['healthy', 'degraded']),
                uptime: z.number(),
              }),
            },
          ],
        },
      } as any,
    ]);
    const doc = gen.generate();

    const responseSchema =
      doc.paths['/api/health'].get!.responses!['200'].content!['application/json'].schema!;
    expect(responseSchema.type).toBe('object');
    expect(responseSchema.properties!.status).toEqual({
      type: 'string',
      enum: ['healthy', 'degraded'],
    });
    expect(responseSchema.properties!.uptime).toEqual({ type: 'number' });
    expect(responseSchema.required).toEqual(['status', 'uptime']);
  });

  test('path params with Zod schema produce typed parameters', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      {
        method: 'get',
        path: '/products/:id',
        handler: () => {},
        openapi: {
          summary: 'Get product',
          pathParams: {
            id: {
              description: 'Product ID',
              schema: z.coerce.number().int(),
            },
          },
        },
      } as any,
    ]);
    const doc = gen.generate();

    const params = doc.paths['/api/products/{id}'].get!.parameters!;
    const idParam = params.find(p => p.name === 'id')!;
    expect(idParam.in).toBe('path');
    expect(idParam.required).toBe(true);
    expect(idParam.description).toBe('Product ID');
    expect(idParam.schema).toEqual({ type: 'integer' });
  });
});
