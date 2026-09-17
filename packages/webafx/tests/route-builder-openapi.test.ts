/**
 * Unit tests for RouteBuilder OpenAPI metadata support.
 *
 * Tests the `.openapi()` method and `OpenAPIRouteMetadata` interface
 * on the RouteBuilder fluent API. Ensures backward compatibility
 * with existing routes that don't use `.openapi()`.
 *
 * @module webafx/tests/route-builder-openapi
 */

import { describe, test, expect } from 'vitest';
import { z } from 'zod';
import { RouteBuilder } from '../src/application/route-builder.js';
import type {
  OpenAPIRouteMetadata,
  OpenAPIResponseDefinition,
  RouteDefinition,
} from '../src/application/route-builder.js';

/** Dummy handler for test routes */
const dummyHandler = async () => {};

describe('RouteBuilder OpenAPI metadata', () => {
  test('route without .openapi() has no openapi field', () => {
    const route = new RouteBuilder()
      .get('/users')
      .handle(dummyHandler);

    expect(route.openapi).toBeUndefined();
  });

  test('route with .openapi() carries metadata', () => {
    const route = new RouteBuilder()
      .get('/products')
      .openapi({
        summary: 'List products',
        tags: ['products'],
      })
      .handle(dummyHandler);

    expect(route.openapi).toBeDefined();
    expect(route.openapi!.summary).toBe('List products');
    expect(route.openapi!.tags).toEqual(['products']);
  });

  test('.openapi() is chainable before .handle()', () => {
    // Ensure the fluent chain works: method → openapi → validate → handle
    const schema = z.object({ name: z.string() });

    const route = new RouteBuilder()
      .post('/products')
      .openapi({ summary: 'Create product' })
      .validate(schema)
      .handle(dummyHandler);

    expect(route.method).toBe('post');
    expect(route.path).toBe('/products');
    expect(route.openapi).toBeDefined();
    expect(route.openapi!.summary).toBe('Create product');
    expect(route.validation).toBeDefined();
  });

  test('.openapi() is chainable after .secure()', () => {
    const route = new RouteBuilder()
      .get('/admin')
      .secure()
      .openapi({ summary: 'Admin panel', tags: ['admin'] })
      .handle(dummyHandler);

    expect(route.secure).toBe(true);
    expect(route.openapi!.summary).toBe('Admin panel');
    expect(route.openapi!.tags).toEqual(['admin']);
  });

  test('.openapi() with all fields populates correctly', () => {
    const responseSchema = z.object({ id: z.number(), name: z.string() });
    const pathParamSchema = z.coerce.number().int();

    const metadata: OpenAPIRouteMetadata = {
      summary: 'Get product by ID',
      description: 'Returns detailed information about a single product',
      tags: ['products', 'public'],
      operationId: 'getProductById',
      deprecated: false,
      pathParams: {
        id: { schema: pathParamSchema, description: 'Product ID' },
      },
      responses: [
        { statusCode: 200, description: 'Product details', schema: responseSchema },
        { statusCode: 404, description: 'Product not found' },
      ],
    };

    const route = new RouteBuilder()
      .get('/:id')
      .openapi(metadata)
      .handle(dummyHandler);

    expect(route.openapi).toEqual(metadata);
    expect(route.openapi!.summary).toBe('Get product by ID');
    expect(route.openapi!.description).toContain('detailed information');
    expect(route.openapi!.tags).toHaveLength(2);
    expect(route.openapi!.operationId).toBe('getProductById');
    expect(route.openapi!.deprecated).toBe(false);
    expect(route.openapi!.pathParams!.id.description).toBe('Product ID');
    expect(route.openapi!.responses).toHaveLength(2);
    expect(route.openapi!.responses![0].statusCode).toBe(200);
    expect(route.openapi!.responses![1].statusCode).toBe(404);
  });

  test('.openapi() with deprecated flag', () => {
    const route = new RouteBuilder()
      .get('/legacy')
      .openapi({
        summary: 'Legacy endpoint',
        deprecated: true,
      })
      .handle(dummyHandler);

    expect(route.openapi!.deprecated).toBe(true);
  });

  test('.openapi() with minimal metadata (summary only)', () => {
    const route = new RouteBuilder()
      .delete('/:id')
      .openapi({ summary: 'Delete item' })
      .handle(dummyHandler);

    expect(route.openapi!.summary).toBe('Delete item');
    expect(route.openapi!.tags).toBeUndefined();
    expect(route.openapi!.description).toBeUndefined();
    expect(route.openapi!.responses).toBeUndefined();
  });

  test('existing route functionality is unaffected by openapi addition', () => {
    // Verify all existing RouteDefinition fields still work
    const schema = z.object({ name: z.string() });
    const authFn = () => true;

    const route = new RouteBuilder()
      .put('/items/:id')
      .secure()
      .authorize(authFn)
      .validate(schema)
      .handle(dummyHandler);

    // All existing fields should be present and correct
    expect(route.method).toBe('put');
    expect(route.path).toBe('/items/:id');
    expect(route.secure).toBe(true);
    expect(route.authorize).toBe(authFn);
    expect(route.validation).toBeDefined();
    expect(route.handler).toBe(dummyHandler);
    // openapi should be undefined since we didn't call .openapi()
    expect(route.openapi).toBeUndefined();
  });
});
