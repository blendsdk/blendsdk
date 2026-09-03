import { describe, test, expect } from 'vitest';
import type { RouteDefinition } from '@blendsdk/webafx';
import { OpenAPIGenerator } from '../src/generator/openapi-generator.js';
import type { OpenAPIGeneratorConfig } from '../src/generator/openapi-types.js';

/**
 * Tests for OpenAPIGenerator — security mapping.
 * Covers: secure routes, default security, unsecured routes.
 */
describe('OpenAPIGenerator — Security', () => {
  /**
   * Helper to create a generator with security config.
   */
  function createSecureGenerator(overrides?: Partial<OpenAPIGeneratorConfig>): OpenAPIGenerator {
    return new OpenAPIGenerator({
      title: 'Test API',
      version: '1.0.0',
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      defaultSecurity: [{ bearerAuth: [] }],
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

  // ─── Secure Routes ─────────────────────────────────────────────────────

  test('secure: true applies default security to operation', () => {
    const gen = createSecureGenerator();
    gen.addRoutes('/api', [
      createRoute({
        path: '/protected',
        secure: true,
        openapi: { summary: 'Protected endpoint' },
      }),
    ]);
    const doc = gen.generate();

    const operation = doc.paths['/api/protected'].get!;
    expect(operation.security).toBeDefined();
    expect(operation.security).toEqual([{ bearerAuth: [] }]);
  });

  test('secure: false has no security on operation', () => {
    const gen = createSecureGenerator();
    gen.addRoutes('/api', [
      createRoute({
        path: '/public',
        secure: false,
        openapi: { summary: 'Public endpoint' },
      }),
    ]);
    const doc = gen.generate();

    const operation = doc.paths['/api/public'].get!;
    expect(operation.security).toBeUndefined();
  });

  test('route without secure property has no security', () => {
    const gen = createSecureGenerator();
    gen.addRoutes('/api', [
      createRoute({
        path: '/default',
        // No secure property
        openapi: { summary: 'Default endpoint' },
      }),
    ]);
    const doc = gen.generate();

    const operation = doc.paths['/api/default'].get!;
    expect(operation.security).toBeUndefined();
  });

  test('mixed secure and public routes in same controller', () => {
    const gen = createSecureGenerator();
    gen.addRoutes('/api/products', [
      createRoute({
        method: 'get',
        path: '/',
        // Public — no secure flag
        openapi: { summary: 'List products' },
      }),
      createRoute({
        method: 'post',
        path: '/',
        secure: true,
        openapi: { summary: 'Create product' },
      }),
    ]);
    const doc = gen.generate();

    // GET is public
    expect(doc.paths['/api/products'].get!.security).toBeUndefined();
    // POST is secured
    expect(doc.paths['/api/products'].post!.security).toEqual([{ bearerAuth: [] }]);
  });

  // ─── Security Without Default Config ───────────────────────────────────

  test('secure route with no defaultSecurity returns empty array', () => {
    const gen = new OpenAPIGenerator({
      title: 'Test API',
      version: '1.0.0',
      // No securitySchemes, no defaultSecurity
    });
    gen.addRoutes('/api', [
      createRoute({
        path: '/locked',
        secure: true,
        openapi: { summary: 'Locked' },
      }),
    ]);
    const doc = gen.generate();

    const operation = doc.paths['/api/locked'].get!;
    // Returns empty array — indicates "security required but no scheme defined"
    expect(operation.security).toEqual([]);
  });

  // ─── Multiple Security Schemes ─────────────────────────────────────────

  test('supports multiple security schemes', () => {
    const gen = new OpenAPIGenerator({
      title: 'Test API',
      version: '1.0.0',
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        apiKey: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
      },
      defaultSecurity: [{ bearerAuth: [] }, { apiKey: [] }],
    });
    gen.addRoutes('/api', [
      createRoute({
        path: '/admin',
        secure: true,
        openapi: { summary: 'Admin endpoint' },
      }),
    ]);
    const doc = gen.generate();

    const operation = doc.paths['/api/admin'].get!;
    expect(operation.security).toEqual([{ bearerAuth: [] }, { apiKey: [] }]);

    // Components should have both schemes
    expect(doc.components!.securitySchemes).toHaveProperty('bearerAuth');
    expect(doc.components!.securitySchemes).toHaveProperty('apiKey');
  });
});
