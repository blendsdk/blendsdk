import { describe, test, expect } from 'vitest';
import { z } from 'zod';
import type { RouteDefinition } from '@blendsdk/webafx';
import { OpenAPIGenerator } from '../src/generator/openapi-generator.js';
import type { OpenAPIGeneratorConfig } from '../src/generator/openapi-types.js';

/**
 * Tests for OpenAPIGenerator — operation building.
 * Covers: metadata, tags, operationId, deprecated, responses, request body.
 */
describe('OpenAPIGenerator — Operations', () => {
  /**
   * Helper to create a generator with minimal config.
   */
  function createGenerator(overrides?: Partial<OpenAPIGeneratorConfig>): OpenAPIGenerator {
    return new OpenAPIGenerator({
      title: 'Test API',
      version: '1.0.0',
      ...overrides,
    });
  }

  /**
   * Helper to create a minimal route definition.
   */
  function createRoute(overrides: Partial<RouteDefinition>): RouteDefinition {
    return {
      method: 'get',
      path: '/',
      handler: () => {},
      ...overrides,
    } as RouteDefinition;
  }

  // ─── Summary & Description ──────────────────────────────────────────────

  test('summary appears on operation', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        path: '/items',
        openapi: { summary: 'List all items' },
      }),
    ]);
    const doc = gen.generate();

    expect(doc.paths['/api/items'].get!.summary).toBe('List all items');
  });

  test('description appears on operation', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        path: '/items',
        openapi: {
          summary: 'List items',
          description: 'Returns a paginated list of all items in the catalog.',
        },
      }),
    ]);
    const doc = gen.generate();

    expect(doc.paths['/api/items'].get!.description).toBe(
      'Returns a paginated list of all items in the catalog.'
    );
  });

  test('omits summary and description when not provided', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        path: '/minimal',
        openapi: {},
      }),
    ]);
    const doc = gen.generate();

    const op = doc.paths['/api/minimal'].get!;
    expect(op.summary).toBeUndefined();
    expect(op.description).toBeUndefined();
  });

  // ─── Tags ──────────────────────────────────────────────────────────────

  test('tags from metadata appear on operation', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        path: '/products',
        openapi: {
          summary: 'List products',
          tags: ['products', 'catalog'],
        },
      }),
    ]);
    const doc = gen.generate();

    expect(doc.paths['/api/products'].get!.tags).toEqual(['products', 'catalog']);
  });

  test('omits tags when empty array', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        path: '/items',
        openapi: { summary: 'Items', tags: [] },
      }),
    ]);
    const doc = gen.generate();

    expect(doc.paths['/api/items'].get!.tags).toBeUndefined();
  });

  test('omits tags when not provided', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        path: '/items',
        openapi: { summary: 'Items' },
      }),
    ]);
    const doc = gen.generate();

    expect(doc.paths['/api/items'].get!.tags).toBeUndefined();
  });

  // ─── Operation ID ──────────────────────────────────────────────────────

  test('operationId appears on operation', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        path: '/products',
        openapi: {
          summary: 'List products',
          operationId: 'listProducts',
        },
      }),
    ]);
    const doc = gen.generate();

    expect(doc.paths['/api/products'].get!.operationId).toBe('listProducts');
  });

  test('omits operationId when not provided', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        path: '/items',
        openapi: { summary: 'Items' },
      }),
    ]);
    const doc = gen.generate();

    expect(doc.paths['/api/items'].get!.operationId).toBeUndefined();
  });

  // ─── Deprecated ────────────────────────────────────────────────────────

  test('deprecated: true appears on operation', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        path: '/legacy',
        openapi: {
          summary: 'Legacy endpoint',
          deprecated: true,
        },
      }),
    ]);
    const doc = gen.generate();

    expect(doc.paths['/api/legacy'].get!.deprecated).toBe(true);
  });

  test('omits deprecated when false or not provided', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        path: '/current',
        openapi: { summary: 'Current endpoint', deprecated: false },
      }),
      createRoute({
        method: 'post',
        path: '/other',
        openapi: { summary: 'Other endpoint' },
      }),
    ]);
    const doc = gen.generate();

    expect(doc.paths['/api/current'].get!.deprecated).toBeUndefined();
    expect(doc.paths['/api/other'].post!.deprecated).toBeUndefined();
  });

  // ─── Responses ─────────────────────────────────────────────────────────

  test('response definitions map correctly', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        path: '/products',
        openapi: {
          summary: 'List products',
          responses: [
            { statusCode: 200, description: 'Paginated product list' },
            { statusCode: 401, description: 'Unauthorized' },
          ],
        },
      }),
    ]);
    const doc = gen.generate();

    const responses = doc.paths['/api/products'].get!.responses!;
    expect(responses['200']).toBeDefined();
    expect(responses['200'].description).toBe('Paginated product list');
    expect(responses['401']).toBeDefined();
    expect(responses['401'].description).toBe('Unauthorized');
  });

  test('response with schema includes content', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        path: '/health',
        openapi: {
          summary: 'Health check',
          responses: [
            {
              statusCode: 200,
              description: 'OK',
              schema: z.object({ status: z.string() }),
            },
          ],
        },
      }),
    ]);
    const doc = gen.generate();

    const response = doc.paths['/api/health'].get!.responses!['200'];
    expect(response.content).toBeDefined();
    expect(response.content!['application/json']).toBeDefined();
    expect(response.content!['application/json'].schema).toBeDefined();
  });

  test('response without schema has no content', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        path: '/items',
        openapi: {
          summary: 'Items',
          responses: [{ statusCode: 204, description: 'No content' }],
        },
      }),
    ]);
    const doc = gen.generate();

    const response = doc.paths['/api/items'].get!.responses!['204'];
    expect(response.description).toBe('No content');
    expect(response.content).toBeUndefined();
  });

  test('omits responses when empty or not provided', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        path: '/no-responses',
        openapi: { summary: 'No responses defined' },
      }),
    ]);
    const doc = gen.generate();

    expect(doc.paths['/api/no-responses'].get!.responses).toBeUndefined();
  });

  // ─── Request Body ──────────────────────────────────────────────────────

  test('POST route with validation schema has requestBody', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        method: 'post',
        path: '/products',
        validation: z.object({ name: z.string() }),
        openapi: { summary: 'Create product' },
      }),
    ]);
    const doc = gen.generate();

    const op = doc.paths['/api/products'].post!;
    expect(op.requestBody).toBeDefined();
    expect(op.requestBody!.required).toBe(true);
    expect(op.requestBody!.content['application/json']).toBeDefined();
  });

  test('PUT route with validation schema has requestBody', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        method: 'put',
        path: '/products/:id',
        validation: z.object({ name: z.string() }),
        openapi: { summary: 'Update product' },
      }),
    ]);
    const doc = gen.generate();

    const op = doc.paths['/api/products/{id}'].put!;
    expect(op.requestBody).toBeDefined();
  });

  test('PATCH route with validation schema has requestBody', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        method: 'patch',
        path: '/products/:id',
        validation: z.object({ name: z.string().optional() }),
        openapi: { summary: 'Patch product' },
      }),
    ]);
    const doc = gen.generate();

    const op = doc.paths['/api/products/{id}'].patch!;
    expect(op.requestBody).toBeDefined();
  });

  test('GET route does NOT have requestBody', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        method: 'get',
        path: '/products',
        validation: z.object({ page: z.number() }),
        openapi: { summary: 'List products' },
      }),
    ]);
    const doc = gen.generate();

    const op = doc.paths['/api/products'].get!;
    expect(op.requestBody).toBeUndefined();
  });

  test('DELETE route does NOT have requestBody', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        method: 'delete',
        path: '/products/:id',
        openapi: { summary: 'Delete product' },
      }),
    ]);
    const doc = gen.generate();

    const op = doc.paths['/api/products/{id}'].delete!;
    expect(op.requestBody).toBeUndefined();
  });

  test('POST route without validation schema has no requestBody', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        method: 'post',
        path: '/trigger',
        openapi: { summary: 'Trigger action' },
      }),
    ]);
    const doc = gen.generate();

    const op = doc.paths['/api/trigger'].post!;
    expect(op.requestBody).toBeUndefined();
  });

  // ─── All HTTP Methods ──────────────────────────────────────────────────

  test('all HTTP methods create operations on the correct method key', () => {
    const gen = createGenerator();
    gen.addRoutes('/api/resource', [
      createRoute({ method: 'get', path: '/', openapi: { summary: 'List' } }),
      createRoute({ method: 'post', path: '/', openapi: { summary: 'Create' } }),
      createRoute({ method: 'put', path: '/:id', openapi: { summary: 'Replace' } }),
      createRoute({ method: 'patch', path: '/:id', openapi: { summary: 'Update' } }),
      createRoute({ method: 'delete', path: '/:id', openapi: { summary: 'Delete' } }),
    ]);
    const doc = gen.generate();

    // Root path has GET and POST
    expect(doc.paths['/api/resource'].get!.summary).toBe('List');
    expect(doc.paths['/api/resource'].post!.summary).toBe('Create');

    // :id path has PUT, PATCH, DELETE
    expect(doc.paths['/api/resource/{id}'].put!.summary).toBe('Replace');
    expect(doc.paths['/api/resource/{id}'].patch!.summary).toBe('Update');
    expect(doc.paths['/api/resource/{id}'].delete!.summary).toBe('Delete');
  });

  // ─── Complete Operation ────────────────────────────────────────────────

  test('fully populated operation has all fields', () => {
    const gen = new OpenAPIGenerator({
      title: 'Test API',
      version: '1.0.0',
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
      defaultSecurity: [{ bearerAuth: [] }],
    });

    gen.addRoutes('/api/products', [
      createRoute({
        method: 'post',
        path: '/',
        secure: true,
        validation: z.object({ name: z.string(), price: z.number() }),
        openapi: {
          summary: 'Create a product',
          description: 'Creates a new product in the catalog',
          tags: ['products'],
          operationId: 'createProduct',
          responses: [
            { statusCode: 201, description: 'Product created' },
            { statusCode: 400, description: 'Validation error' },
          ],
        },
      }),
    ]);
    const doc = gen.generate();

    const op = doc.paths['/api/products'].post!;
    expect(op.summary).toBe('Create a product');
    expect(op.description).toBe('Creates a new product in the catalog');
    expect(op.tags).toEqual(['products']);
    expect(op.operationId).toBe('createProduct');
    expect(op.security).toEqual([{ bearerAuth: [] }]);
    expect(op.requestBody).toBeDefined();
    expect(op.responses!['201'].description).toBe('Product created');
    expect(op.responses!['400'].description).toBe('Validation error');
  });
});
