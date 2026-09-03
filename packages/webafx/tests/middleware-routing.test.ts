import { describe, test, expect, beforeEach, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { WebApplication } from '../src/application/web-application.js';
import { BaseController } from '../src/application/base-controller.js';
import { ApplicationSettings } from '../src/application/application-settings.js';
import { RouteDefinition } from '../src/application/route-builder.js';
import { ApiError } from '../src/errors/api-error.js';
import supertest from 'supertest';

/**
 * Tests for Phase 4: Middleware & Routing improvements
 * - Route-level middleware support
 * - Standardized error response format
 * - Response helpers (ok, created, paginated, noContent)
 * - Separated input sources
 */

describe('Phase 4: Middleware & Routing', () => {
  describe('Route-Level Middleware', () => {
    test('route with no middleware works normally', async () => {
      const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });

      class TestController extends BaseController {
        routes(): RouteDefinition[] {
          return [
            this.route()
              .get('/test')
              .handle(async (req, res) => {
                res.json({ message: 'success' });
              }),
          ];
        }
      }

      app.registerController('/api', TestController);
      const shutdown = await app.start();

      const response = await supertest((app as any).expressApp).get('/api/test');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'success' });

      await shutdown();
    });

    test('single middleware runs before handler', async () => {
      const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
      const middlewareCalls: string[] = [];

      const testMiddleware = (req: Request, res: Response, next: NextFunction) => {
        middlewareCalls.push('middleware1');
        next();
      };

      class TestController extends BaseController {
        routes(): RouteDefinition[] {
          return [
            this.route()
              .get('/test')
              .middleware(testMiddleware)
              .handle(async (req, res) => {
                middlewareCalls.push('handler');
                res.json({ message: 'success' });
              }),
          ];
        }
      }

      app.registerController('/api', TestController);
      const shutdown = await app.start();

      await supertest((app as any).expressApp).get('/api/test');

      expect(middlewareCalls).toEqual(['middleware1', 'handler']);

      await shutdown();
    });

    test('multiple middleware run in order', async () => {
      const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
      const executionOrder: string[] = [];

      const middleware1 = (req: Request, res: Response, next: NextFunction) => {
        executionOrder.push('middleware1');
        next();
      };

      const middleware2 = (req: Request, res: Response, next: NextFunction) => {
        executionOrder.push('middleware2');
        next();
      };

      class TestController extends BaseController {
        routes(): RouteDefinition[] {
          return [
            this.route()
              .get('/test')
              .middleware(middleware1)
              .middleware(middleware2)
              .handle(async (req, res) => {
                executionOrder.push('handler');
                res.json({ message: 'success' });
              }),
          ];
        }
      }

      app.registerController('/api', TestController);
      const shutdown = await app.start();

      await supertest((app as any).expressApp).get('/api/test');

      expect(executionOrder).toEqual(['middleware1', 'middleware2', 'handler']);

      await shutdown();
    });

    test('middleware can short-circuit by sending response', async () => {
      const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
      let handlerCalled = false;

      const blockingMiddleware = (req: Request, res: Response, next: NextFunction) => {
        res.status(403).json({ error: 'Blocked by middleware' });
        // Don't call next() - short circuit
      };

      class TestController extends BaseController {
        routes(): RouteDefinition[] {
          return [
            this.route()
              .get('/test')
              .middleware(blockingMiddleware)
              .handle(async (req, res) => {
                handlerCalled = true;
                res.json({ message: 'success' });
              }),
          ];
        }
      }

      app.registerController('/api', TestController);
      const shutdown = await app.start();

      const response = await supertest((app as any).expressApp).get('/api/test');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Blocked by middleware' });
      expect(handlerCalled).toBe(false);

      await shutdown();
    });

    test('middleware error propagates to error handler', async () => {
      const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });

      const errorMiddleware = (req: Request, res: Response, next: NextFunction) => {
        next(new ApiError(400, 'MIDDLEWARE_ERROR', 'Middleware failed'));
      };

      class TestController extends BaseController {
        routes(): RouteDefinition[] {
          return [
            this.route()
              .get('/test')
              .middleware(errorMiddleware)
              .handle(async (req, res) => {
                res.json({ message: 'success' });
              }),
          ];
        }
      }

      app.registerController('/api', TestController);
      const shutdown = await app.start();

      const response = await supertest((app as any).expressApp).get('/api/test');

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        success: false,
        error: {
          code: 'MIDDLEWARE_ERROR',
          message: 'Middleware failed',
          statusCode: 400,
        },
      });

      await shutdown();
    });
  });

  describe('Standard Error Response Format', () => {
    test('ApiError response matches standard envelope', async () => {
      const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });

      class TestController extends BaseController {
        routes(): RouteDefinition[] {
          return [
            this.route()
              .get('/error')
              .handle(async (req, res) => {
                throw new ApiError(404, 'NOT_FOUND', 'Resource not found');
              }),
          ];
        }
      }

      app.registerController('/api', TestController);
      const shutdown = await app.start();

      const response = await supertest((app as any).expressApp).get('/api/error');

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found',
          statusCode: 404,
          timestamp: expect.any(String),
          requestId: expect.any(String),
          path: '/api/error',
        },
      });

      await shutdown();
    });

    test('ApiError includes details when present', async () => {
      const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });

      class TestController extends BaseController {
        routes(): RouteDefinition[] {
          return [
            this.route()
              .get('/error')
              .handle(async (req, res) => {
                throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid input', {
                  field: 'email',
                  reason: 'invalid format',
                });
              }),
          ];
        }
      }

      app.registerController('/api', TestController);
      const shutdown = await app.start();

      const response = await supertest((app as any).expressApp).get('/api/error');

      expect(response.status).toBe(400);
      expect(response.body.error.details).toEqual({
        field: 'email',
        reason: 'invalid format',
      });

      await shutdown();
    });

    test('unknown error response matches standard envelope', async () => {
      const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });

      class TestController extends BaseController {
        routes(): RouteDefinition[] {
          return [
            this.route()
              .get('/error')
              .handle(async (req, res) => {
                throw new Error('Something went wrong');
              }),
          ];
        }
      }

      app.registerController('/api', TestController);
      const shutdown = await app.start();

      const response = await supertest((app as any).expressApp).get('/api/error');

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: expect.stringMatching(/Something went wrong|Internal Server Error/),
          statusCode: 500,
          timestamp: expect.any(String),
          requestId: expect.any(String),
          path: '/api/error',
        },
      });

      await shutdown();
    });

    test('ApiError.toJSON() returns standard format', () => {
      const error = new ApiError(403, 'FORBIDDEN', 'Access denied', { userId: 123 });
      const json = error.toJSON();

      expect(json).toMatchObject({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Access denied',
          statusCode: 403,
          timestamp: expect.any(String),
          details: { userId: 123 },
        },
      });
    });
  });

  describe('Response Helpers', () => {
    test('ok() sends 200 with success envelope', async () => {
      const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });

      class TestController extends BaseController {
        routes(): RouteDefinition[] {
          return [
            this.route()
              .get('/test')
              .handle(async (req, res) => {
                this.ok(res, { user: { id: 1, name: 'John' } });
              }),
          ];
        }
      }

      app.registerController('/api', TestController);
      const shutdown = await app.start();

      const response = await supertest((app as any).expressApp).get('/api/test');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        data: { user: { id: 1, name: 'John' } },
      });

      await shutdown();
    });

    test('created() sends 201 with success envelope', async () => {
      const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });

      class TestController extends BaseController {
        routes(): RouteDefinition[] {
          return [
            this.route()
              .post('/test')
              .handle(async (req, res) => {
                this.created(res, { id: 123, name: 'New Item' });
              }),
          ];
        }
      }

      app.registerController('/api', TestController);
      const shutdown = await app.start();

      const response = await supertest((app as any).expressApp).post('/api/test');

      expect(response.status).toBe(201);
      expect(response.body).toEqual({
        success: true,
        data: { id: 123, name: 'New Item' },
      });

      await shutdown();
    });

    test('paginated() sends correct pagination metadata', async () => {
      const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });

      class TestController extends BaseController {
        routes(): RouteDefinition[] {
          return [
            this.route()
              .get('/users')
              .handle(async (req, res) => {
                const users = [
                  { id: 51, name: 'User 51' },
                  { id: 52, name: 'User 52' },
                ];
                this.paginated(res, users, 150, 2, 50);
              }),
          ];
        }
      }

      app.registerController('/api', TestController);
      const shutdown = await app.start();

      const response = await supertest((app as any).expressApp).get('/api/users');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        data: [
          { id: 51, name: 'User 51' },
          { id: 52, name: 'User 52' },
        ],
        pagination: {
          total: 150,
          page: 2,
          limit: 50,
          pages: 3,
        },
      });

      await shutdown();
    });

    test('noContent() sends 204 with empty body', async () => {
      const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });

      class TestController extends BaseController {
        routes(): RouteDefinition[] {
          return [
            this.route()
              .delete('/users/:id')
              .handle(async (req, res) => {
                // Simulate deletion
                this.noContent(res);
              }),
          ];
        }
      }

      app.registerController('/api', TestController);
      const shutdown = await app.start();

      const response = await supertest((app as any).expressApp).delete('/api/users/123');

      expect(response.status).toBe(204);
      expect(response.text).toBe('');

      await shutdown();
    });
  });

  describe('Input Separation', () => {
    test('getParams() returns merged data (backward compatible)', async () => {
      const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
      let capturedParams: any;

      class TestController extends BaseController {
        routes(): RouteDefinition[] {
          return [
            this.route()
              .post('/users/:id')
              .handle(async (req, res) => {
                capturedParams = req.services.getParams();
                res.json({ success: true });
              }),
          ];
        }
      }

      app.registerController('/api', TestController);
      const shutdown = await app.start();

      await supertest((app as any).expressApp)
        .post('/api/users/123?sort=name')
        .send({ name: 'John' });

      expect(capturedParams).toEqual({
        id: '123',
        sort: 'name',
        name: 'John',
      });

      await shutdown();
    });

    test('getInput() returns separated sources', async () => {
      const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
      let capturedInput: any;

      class TestController extends BaseController {
        routes(): RouteDefinition[] {
          return [
            this.route()
              .post('/users/:id')
              .handle(async (req, res) => {
                capturedInput = req.services.getInput();
                res.json({ success: true });
              }),
          ];
        }
      }

      app.registerController('/api', TestController);
      const shutdown = await app.start();

      await supertest((app as any).expressApp)
        .post('/api/users/123?sort=name')
        .send({ name: 'John' });

      expect(capturedInput).toEqual({
        params: { id: '123' },
        query: { sort: 'name' },
        body: { name: 'John' },
      });

      await shutdown();
    });

    test('body does not override params in separated mode', async () => {
      const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
      let capturedInput: any;

      class TestController extends BaseController {
        routes(): RouteDefinition[] {
          return [
            this.route()
              .post('/users/:id')
              .handle(async (req, res) => {
                capturedInput = req.services.getInput();
                res.json({ success: true });
              }),
          ];
        }
      }

      app.registerController('/api', TestController);
      const shutdown = await app.start();

      // Body has "id" field, but should not override params.id
      await supertest((app as any).expressApp).post('/api/users/123').send({ id: 'wrong-id' });

      expect(capturedInput.params.id).toBe('123');
      expect(capturedInput.body.id).toBe('wrong-id');
      // They're separated - no conflict!

      await shutdown();
    });

    test('getInput() returns empty objects when no input provided', async () => {
      const app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
      let capturedInput: any;

      class TestController extends BaseController {
        routes(): RouteDefinition[] {
          return [
            this.route()
              .get('/test')
              .handle(async (req, res) => {
                capturedInput = req.services.getInput();
                res.json({ success: true });
              }),
          ];
        }
      }

      app.registerController('/api', TestController);
      const shutdown = await app.start();

      await supertest((app as any).expressApp).get('/api/test');

      expect(capturedInput).toEqual({
        params: {},
        query: {},
        body: {},
      });

      await shutdown();
    });
  });
});
