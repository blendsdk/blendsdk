import { describe, test, expect, afterEach } from 'vitest';
import supertest from 'supertest';
import { WebApplication } from '../src/application/web-application.js';
import { BaseController } from '../src/application/base-controller.js';
import { RouteDefinition } from '../src/application/route-builder.js';
import { ApiError, ValidationError } from '../src/errors/index.js';
import { ApplicationSettings } from '../src/application/application-settings.js';
import { ServiceContainer } from '../src/application/service-container.js';

/**
 * Test controllers for HTTP integration tests
 */
class BasicController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route().get('/api/hello').handle(async (req, res) => {
        this.ok(res, { message: 'Hello, World!' });
      }),

      this.route().get('/api/items/:id').handle(async (req, res) => {
        const { id } = req.params;
        this.ok(res, { id, name: `Item ${id}` });
      }),

      this.route().post('/api/items').handle(async (req, res) => {
        const body = req.body;
        this.created(res, { id: 123, ...body });
      }),

      this.route().put('/api/items/:id').handle(async (req, res) => {
        const { id } = req.params;
        const body = req.body;
        this.ok(res, { id, ...body, updated: true });
      }),

      this.route().delete('/api/items/:id').handle(async (req, res) => {
        this.noContent(res);
      }),

      this.route().get('/api/query').handle(async (req, res) => {
        this.ok(res, { query: req.query });
      }),

      this.route().get('/api/paginated').handle(async (req, res) => {
        const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
        this.paginated(res, items, 100, 2, 50);
      }),
    ];
  }
}

class AuthController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route().get('/api/public').handle(async (req, res) => {
        this.ok(res, { public: true });
      }),

      this.authenticated().get('/api/protected').handle(async (req, res) => {
        const user = await req.services.get('user', undefined);
        this.ok(res, { protected: true, user });
      }),

      this.route()
        .get('/api/admin')
        .secure()
        .handle(async (req, res) => {
          const user = await req.services.get<{ role?: string }>('user', undefined);
          if (user?.role !== 'admin') {
            throw new ApiError(403, 'FORBIDDEN', 'Insufficient permissions');
          }
          this.ok(res, { admin: true });
        }),
    ];
  }
}

class ValidationController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route().post('/api/validate').handle(async (req, res) => {
        const { name, email, age } = req.body;

        const errors: Record<string, string> = {};

        if (!name) {
          errors.name = 'Name is required';
        }
        if (!email) {
          errors.email = 'Email is required';
        } else if (!email.includes('@')) {
          errors.email = 'Invalid email format';
        }
        if (age !== undefined && (age < 0 || age > 150)) {
          errors.age = 'Age must be between 0 and 150';
        }

        if (Object.keys(errors).length > 0) {
          throw new ValidationError('Validation failed', errors);
        }

        this.ok(res, { name, email, age });
      }),
    ];
  }
}

class ServiceController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route().get('/api/singleton').handle(async (req, res) => {
        const counter = await req.services.get<{ count: number }>('counter');
        counter.count++;
        this.ok(res, { count: counter.count });
      }),

      this.route().get('/api/per-request').handle(async (req, res) => {
        const requestId = await req.services.get<{ id: string }>('requestId');
        this.ok(res, { requestId: requestId.id });
      }),
    ];
  }
}

class ErrorController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route().get('/api/error/api').handle(async () => {
        throw new ApiError(400, 'BAD_REQUEST', 'Something went wrong');
      }),

      this.route().get('/api/error/validation').handle(async () => {
        throw new ValidationError('Invalid input', {
          field1: 'Error 1',
          field2: 'Error 2',
        });
      }),

      this.route().get('/api/error/unknown').handle(async () => {
        throw new Error('Unexpected error');
      }),

      this.route().get('/api/error/404').handle(async () => {
        throw new ApiError(404, 'NOT_FOUND', 'Resource not found');
      }),
    ];
  }
}

class InputController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .post('/api/input/:id')
        .handle(async (req, res) => {
          const input = await req.services.get<any>('input');
          this.ok(res, {
            params: input.params,
            query: input.query,
            body: input.body,
            merged: input.merged,
          });
        }),
    ];
  }
}

/**
 * Helper function to create a test app
 */
function createTestApp(options?: {
  controllerClasses?: (new (settings: ApplicationSettings, services: ServiceContainer) => BaseController)[];
  mockAuth?: boolean;
  mockServices?: boolean;
  envMode?: 'development' | 'production' | 'test';
}) {
  const app = new WebApplication({
    PORT: 0, // Random port
    ENV_MODE: options?.envMode || 'test',
    LOG_LEVEL: 'ERROR',
  });

  // Register mock services if needed
  if (options?.mockServices) {
    const counter = { count: 0 };
    app.registerService({
      name: 'counter',
      type: 'singleton',
      factory: () => counter,
    });

    app.registerService({
      name: 'requestId',
      type: 'per-request',
      factory: () => ({
        id: Math.random().toString(36).substring(7),
      }),
    });
  }

  // Always register input service for request parameter access
  app.registerService({
    name: 'input',
    type: 'per-request',
    factory: (container, settings, req) => ({
      params: req.params,
      query: req.query,
      body: req.body,
      merged: { ...req.params, ...req.query, ...req.body },
    }),
  });

  // Mock authentication using a per-request service
  if (options?.mockAuth) {
    app.registerService({
      name: 'user',
      type: 'per-request',
      factory: (container, settings, req) => {
        const authHeader = req.headers.authorization;
        if (authHeader === 'Bearer valid-token') {
          return { id: 1, name: 'Test User', role: 'user' };
        } else if (authHeader === 'Bearer admin-token') {
          return { id: 2, name: 'Admin User', role: 'admin' };
        }
        return undefined;
      },
    });
  }

  // Register controller classes
  if (options?.controllerClasses) {
    for (const ControllerClass of options.controllerClasses) {
      app.registerController('', ControllerClass);
    }
  }

  return app;
}

/**
 * HTTP Integration Tests
 */
describe('HTTP Integration Tests', () => {
  let shutdown: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = null;
    }
  });

  describe('Basic Request Lifecycle', () => {
    test('GET route returns 200 with JSON body', async () => {
      const app = createTestApp({
        controllerClasses: [BasicController],
      });
      shutdown = await app.start();

      const res = await supertest(app.express).get('/api/hello').expect(200);

      expect(res.body).toEqual({
        success: true,
        data: { message: 'Hello, World!' },
      });
    });

    test('POST route receives and returns body', async () => {
      const app = createTestApp({
        controllerClasses: [BasicController],
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .post('/api/items')
        .send({ name: 'Test Item', price: 99.99 })
        .expect(201);

      expect(res.body).toEqual({
        success: true,
        data: { id: 123, name: 'Test Item', price: 99.99 },
      });
    });

    test('PUT route updates resource', async () => {
      const app = createTestApp({
        controllerClasses: [BasicController],
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .put('/api/items/456')
        .send({ name: 'Updated Item' })
        .expect(200);

      expect(res.body).toEqual({
        success: true,
        data: { id: '456', name: 'Updated Item', updated: true },
      });
    });

    test('DELETE route returns 204', async () => {
      const app = createTestApp({
        controllerClasses: [BasicController],
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .delete('/api/items/789')
        .expect(204);

      expect(res.body).toEqual({});
    });

    test('Unknown route returns 404', async () => {
      const app = createTestApp({
        controllerClasses: [BasicController],
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .get('/api/nonexistent')
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('Authentication & Authorization', () => {
    test('Unauthenticated request to secure route returns 401', async () => {
      const app = createTestApp({
        controllerClasses: [AuthController],
        mockAuth: true,
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .get('/api/protected')
        .expect(401);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    test('Authenticated request to secure route succeeds', async () => {
      const app = createTestApp({
        controllerClasses: [AuthController],
        mockAuth: true,
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .get('/api/protected')
        .set('Authorization', 'Bearer valid-token')
        .expect(200);

      expect(res.body).toEqual({
        success: true,
        data: { protected: true, user: { id: 1, name: 'Test User', role: 'user' } },
      });
    });

    test('Unauthorized user on authorized route returns 403', async () => {
      const app = createTestApp({
        controllerClasses: [AuthController],
        mockAuth: true,
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .get('/api/admin')
        .set('Authorization', 'Bearer valid-token')
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(res.body.error.message).toBe('Insufficient permissions');
    });

    test('Authorized user passes through', async () => {
      const app = createTestApp({
        controllerClasses: [AuthController],
        mockAuth: true,
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .get('/api/admin')
        .set('Authorization', 'Bearer admin-token')
        .expect(200);

      expect(res.body).toEqual({
        success: true,
        data: { admin: true },
      });
    });
  });

  describe('Validation', () => {
    test('Valid request passes validation', async () => {
      const app = createTestApp({
        controllerClasses: [ValidationController],
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .post('/api/validate')
        .send({ name: 'John Doe', email: 'john@example.com', age: 30 })
        .expect(200);

      expect(res.body).toEqual({
        success: true,
        data: { name: 'John Doe', email: 'john@example.com', age: 30 },
      });
    });

    test('Invalid request returns 422 with validation errors', async () => {
      const app = createTestApp({
        controllerClasses: [ValidationController],
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .post('/api/validate')
        .send({ age: 200 })
        .expect(422);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toBeDefined();
    });

    test('Missing required field returns specific error', async () => {
      const app = createTestApp({
        controllerClasses: [ValidationController],
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .post('/api/validate')
        .send({ email: 'test@example.com' })
        .expect(422);

      expect(res.body.error.details.name).toBe('Name is required');
    });

    test('Multiple validation errors returned together', async () => {
      const app = createTestApp({
        controllerClasses: [ValidationController],
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .post('/api/validate')
        .send({ age: 200 })
        .expect(422);

      expect(res.body.error.details.name).toBeDefined();
      expect(res.body.error.details.email).toBeDefined();
      expect(res.body.error.details.age).toBeDefined();
    });
  });

  describe('Request Parameters', () => {
    test('URL params accessible via route params', async () => {
      const app = createTestApp({
        controllerClasses: [BasicController],
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .get('/api/items/123')
        .expect(200);

      expect(res.body.data.id).toBe('123');
    });

    test('Query params accessible via query string', async () => {
      const app = createTestApp({
        controllerClasses: [BasicController],
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .get('/api/query?page=2&limit=10')
        .expect(200);

      expect(res.body.data.query).toEqual({ page: '2', limit: '10' });
    });

    test('Body params accessible via request body', async () => {
      const app = createTestApp({
        controllerClasses: [BasicController],
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .post('/api/items')
        .send({ name: 'Test', price: 50 })
        .expect(201);

      expect(res.body.data.name).toBe('Test');
      expect(res.body.data.price).toBe(50);
    });

    test('Input service provides separated sources', async () => {
      const app = createTestApp({
        controllerClasses: [InputController],
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .post('/api/input/123?search=test')
        .send({ name: 'John' })
        .expect(200);

      expect(res.body.data.params).toEqual({ id: '123' });
      expect(res.body.data.query).toEqual({ search: 'test' });
      expect(res.body.data.body).toEqual({ name: 'John' });
    });
  });

  describe('Service Container in Requests', () => {
    test('Singleton service shared across requests', async () => {
      const app = createTestApp({
        controllerClasses: [ServiceController],
        mockServices: true,
      });
      shutdown = await app.start();

      const res1 = await supertest(app.express)
        .get('/api/singleton')
        .expect(200);
      expect(res1.body.data.count).toBe(1);

      const res2 = await supertest(app.express)
        .get('/api/singleton')
        .expect(200);
      expect(res2.body.data.count).toBe(2);

      const res3 = await supertest(app.express)
        .get('/api/singleton')
        .expect(200);
      expect(res3.body.data.count).toBe(3);
    });

    test('Per-request service created fresh per request', async () => {
      const app = createTestApp({
        controllerClasses: [ServiceController],
        mockServices: true,
      });
      shutdown = await app.start();

      const res1 = await supertest(app.express)
        .get('/api/per-request')
        .expect(200);
      const id1 = res1.body.data.requestId;

      const res2 = await supertest(app.express)
        .get('/api/per-request')
        .expect(200);
      const id2 = res2.body.data.requestId;

      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id1).not.toBe(id2);
    });
  });

  describe('Response Helpers', () => {
    test('ok() sends success envelope', async () => {
      const app = createTestApp({
        controllerClasses: [BasicController],
      });
      shutdown = await app.start();

      const res = await supertest(app.express).get('/api/hello').expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({ message: 'Hello, World!' });
    });

    test('created() sends 201 status', async () => {
      const app = createTestApp({
        controllerClasses: [BasicController],
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .post('/api/items')
        .send({ name: 'New' })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(123);
    });

    test('paginated() sends pagination metadata', async () => {
      const app = createTestApp({
        controllerClasses: [BasicController],
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .get('/api/paginated')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(3);
      expect(res.body.pagination).toEqual({
        total: 100,
        page: 2,
        limit: 50,
        pages: 2,
      });
    });

    test('noContent() sends 204 with no body', async () => {
      const app = createTestApp({
        controllerClasses: [BasicController],
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .delete('/api/items/123')
        .expect(204);

      expect(res.body).toEqual({});
    });
  });

  describe('Error Handling', () => {
    test('ApiError produces structured response', async () => {
      const app = createTestApp({
        controllerClasses: [ErrorController],
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .get('/api/error/api')
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toBe('Something went wrong');
      expect(res.body.error.requestId).toBeTruthy();
    });

    test('ValidationError includes error details', async () => {
      const app = createTestApp({
        controllerClasses: [ErrorController],
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .get('/api/error/validation')
        .expect(422);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toEqual({
        field1: 'Error 1',
        field2: 'Error 2',
      });
    });

    test('Unknown error produces 500 in production', async () => {
      const app = createTestApp({
        controllerClasses: [ErrorController],
        envMode: 'production',
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .get('/api/error/unknown')
        .expect(500);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
      expect(res.body.error.message).not.toContain('Unexpected error');
      expect(res.body.error.stack).toBeUndefined();
    });

    test('Unknown error shows details in development', async () => {
      const app = createTestApp({
        controllerClasses: [ErrorController],
        envMode: 'development',
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .get('/api/error/unknown')
        .expect(500);

      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Unexpected error');
      expect(res.body.error.stack).toBeDefined();
    });

    test('Request ID included in error response', async () => {
      const app = createTestApp({
        controllerClasses: [ErrorController],
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .get('/api/error/api')
        .expect(400);

      expect(res.body.error.requestId).toBeTruthy();
      expect(typeof res.body.error.requestId).toBe('string');
      expect(res.body.error.requestId.length).toBeGreaterThan(0);
    });

    test('404 error returns not found', async () => {
      const app = createTestApp({
        controllerClasses: [ErrorController],
      });
      shutdown = await app.start();

      const res = await supertest(app.express)
        .get('/api/error/404')
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.message).toBe('Resource not found');
    });
  });
});
