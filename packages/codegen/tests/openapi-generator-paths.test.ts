import { describe, test, expect } from 'vitest';
import type { RouteDefinition } from '@blendsdk/webafx';
import { OpenAPIGenerator } from '../src/generator/openapi-generator.js';
import type { OpenAPIGeneratorConfig } from '../src/generator/openapi-types.js';

/**
 * Tests for OpenAPIGenerator — path conversion, route filtering, basePath combining.
 */
describe('OpenAPIGenerator — Paths & Filtering', () => {
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
   * Helper to create a minimal route definition with OpenAPI metadata.
   * The handler is a no-op since we only care about route structure.
   */
  function createRoute(overrides: Partial<RouteDefinition>): RouteDefinition {
    return {
      method: 'get',
      path: '/',
      handler: () => {},
      ...overrides,
    } as RouteDefinition;
  }

  // ─── Express → OpenAPI Path Conversion ──────────────────────────────────

  test('converts single :param to {param}', () => {
    const gen = createGenerator();
    gen.addRoutes('/users', [
      createRoute({
        path: '/:id',
        openapi: { summary: 'Get user' },
      }),
    ]);
    const doc = gen.generate();

    expect(doc.paths).toHaveProperty('/users/{id}');
    expect(doc.paths).not.toHaveProperty('/users/:id');
  });

  test('converts multiple :params to {params}', () => {
    const gen = createGenerator();
    gen.addRoutes('/users', [
      createRoute({
        path: '/:userId/posts/:postId',
        openapi: { summary: 'Get user post' },
      }),
    ]);
    const doc = gen.generate();

    expect(doc.paths).toHaveProperty('/users/{userId}/posts/{postId}');
  });

  test('handles paths without parameters', () => {
    const gen = createGenerator();
    gen.addRoutes('/api/health', [
      createRoute({
        path: '/',
        openapi: { summary: 'Health check' },
      }),
    ]);
    const doc = gen.generate();

    expect(doc.paths).toHaveProperty('/api/health');
  });

  test('handles underscored parameter names', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        path: '/:user_id',
        openapi: { summary: 'Get by user_id' },
      }),
    ]);
    const doc = gen.generate();

    expect(doc.paths).toHaveProperty('/api/{user_id}');
  });

  // ─── Base Path + Route Path Combining ───────────────────────────────────

  test('combines basePath and route path correctly', () => {
    const gen = createGenerator();
    gen.addRoutes('/api/products', [
      createRoute({
        path: '/:id',
        openapi: { summary: 'Get product' },
      }),
    ]);
    const doc = gen.generate();

    expect(doc.paths).toHaveProperty('/api/products/{id}');
  });

  test('handles root route path (/) — uses basePath only', () => {
    const gen = createGenerator();
    gen.addRoutes('/api/products', [
      createRoute({
        path: '/',
        openapi: { summary: 'List products' },
      }),
    ]);
    const doc = gen.generate();

    expect(doc.paths).toHaveProperty('/api/products');
    // Should NOT have trailing slash
    expect(doc.paths).not.toHaveProperty('/api/products/');
  });

  test('handles basePath with trailing slash', () => {
    const gen = createGenerator();
    gen.addRoutes('/api/products/', [
      createRoute({
        path: '/:id',
        openapi: { summary: 'Get product' },
      }),
    ]);
    const doc = gen.generate();

    // Should normalize: no double slashes
    expect(doc.paths).toHaveProperty('/api/products/{id}');
  });

  test('groups multiple methods on the same path', () => {
    const gen = createGenerator();
    gen.addRoutes('/api/products', [
      createRoute({
        method: 'get',
        path: '/',
        openapi: { summary: 'List products' },
      }),
      createRoute({
        method: 'post',
        path: '/',
        openapi: { summary: 'Create product' },
      }),
    ]);
    const doc = gen.generate();

    const pathItem = doc.paths['/api/products'];
    expect(pathItem).toBeDefined();
    expect(pathItem.get).toBeDefined();
    expect(pathItem.get!.summary).toBe('List products');
    expect(pathItem.post).toBeDefined();
    expect(pathItem.post!.summary).toBe('Create product');
  });

  // ─── Route Opt-In Filtering ─────────────────────────────────────────────

  test('routes without .openapi() are excluded from spec', () => {
    const gen = createGenerator();
    gen.addRoutes('/api/products', [
      // Route WITH openapi — should be included
      createRoute({
        method: 'get',
        path: '/',
        openapi: { summary: 'List products' },
      }),
      // Route WITHOUT openapi — should be excluded
      createRoute({
        method: 'get',
        path: '/internal',
        // No openapi metadata
      }),
    ]);
    const doc = gen.generate();

    expect(doc.paths).toHaveProperty('/api/products');
    expect(doc.paths).not.toHaveProperty('/api/products/internal');
  });

  test('all routes without .openapi() produces empty paths', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({ method: 'get', path: '/secret' }),
      createRoute({ method: 'post', path: '/internal' }),
    ]);
    const doc = gen.generate();

    expect(doc.paths).toEqual({});
  });

  test('routes with empty openapi object are included', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        path: '/minimal',
        openapi: {}, // Empty but present — opt-in
      }),
    ]);
    const doc = gen.generate();

    expect(doc.paths).toHaveProperty('/api/minimal');
  });

  // ─── Multiple Controllers ──────────────────────────────────────────────

  test('multiple addRoutes() calls combine into one spec', () => {
    const gen = createGenerator();

    gen.addRoutes('/api/products', [
      createRoute({
        method: 'get',
        path: '/',
        openapi: { summary: 'List products' },
      }),
    ]);

    gen.addRoutes('/api/users', [
      createRoute({
        method: 'get',
        path: '/',
        openapi: { summary: 'List users' },
      }),
    ]);

    const doc = gen.generate();

    expect(doc.paths).toHaveProperty('/api/products');
    expect(doc.paths).toHaveProperty('/api/users');
    expect(doc.paths['/api/products'].get!.summary).toBe('List products');
    expect(doc.paths['/api/users'].get!.summary).toBe('List users');
  });

  // ─── addController ─────────────────────────────────────────────────────

  test('addController() instantiates controller and collects routes', () => {
    // Minimal controller mock that returns route definitions
    class TestController {
      constructor(_settings: any, _services: any) {}
      routes(): RouteDefinition[] {
        return [
          createRoute({
            method: 'get',
            path: '/',
            openapi: { summary: 'From controller' },
          }),
          createRoute({
            method: 'get',
            path: '/hidden',
            // No openapi — should be filtered out
          }),
        ];
      }
    }

    const gen = createGenerator();
    gen.addController('/api/test', TestController);
    const doc = gen.generate();

    expect(doc.paths).toHaveProperty('/api/test');
    expect(doc.paths['/api/test'].get!.summary).toBe('From controller');
    // Hidden route should not appear
    expect(doc.paths).not.toHaveProperty('/api/test/hidden');
  });

  test('addController() is chainable', () => {
    class ControllerA {
      constructor(_s: any, _c: any) {}
      routes() {
        return [createRoute({ path: '/', openapi: { summary: 'A' } })];
      }
    }
    class ControllerB {
      constructor(_s: any, _c: any) {}
      routes() {
        return [createRoute({ path: '/', openapi: { summary: 'B' } })];
      }
    }

    const gen = createGenerator();
    const result = gen.addController('/a', ControllerA).addController('/b', ControllerB);

    // Chainable — returns the generator
    expect(result).toBe(gen);

    const doc = gen.generate();
    expect(doc.paths).toHaveProperty('/a');
    expect(doc.paths).toHaveProperty('/b');
  });

  // ─── Path Parameters Are Detected ─────────────────────────────────────

  test('path parameters are added to operation parameters', () => {
    const gen = createGenerator();
    gen.addRoutes('/api/products', [
      createRoute({
        method: 'get',
        path: '/:id',
        openapi: { summary: 'Get product' },
      }),
    ]);
    const doc = gen.generate();

    const operation = doc.paths['/api/products/{id}'].get!;
    expect(operation.parameters).toBeDefined();
    expect(operation.parameters).toHaveLength(1);
    expect(operation.parameters![0].name).toBe('id');
    expect(operation.parameters![0].in).toBe('path');
    expect(operation.parameters![0].required).toBe(true);
  });

  test('multiple path parameters are all detected', () => {
    const gen = createGenerator();
    gen.addRoutes('/api', [
      createRoute({
        method: 'get',
        path: '/:orgId/users/:userId',
        openapi: { summary: 'Get org user' },
      }),
    ]);
    const doc = gen.generate();

    const operation = doc.paths['/api/{orgId}/users/{userId}'].get!;
    expect(operation.parameters).toHaveLength(2);
    expect(operation.parameters![0].name).toBe('orgId');
    expect(operation.parameters![1].name).toBe('userId');
  });

  test('path parameter description comes from metadata', () => {
    const gen = createGenerator();
    gen.addRoutes('/api/products', [
      createRoute({
        method: 'get',
        path: '/:id',
        openapi: {
          summary: 'Get product',
          pathParams: {
            id: { schema: {} as any, description: 'Product ID' },
          },
        },
      }),
    ]);
    const doc = gen.generate();

    const param = doc.paths['/api/products/{id}'].get!.parameters![0];
    expect(param.description).toBe('Product ID');
  });
});
