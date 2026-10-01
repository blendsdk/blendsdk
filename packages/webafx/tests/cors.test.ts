import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { WebApplication } from '../src/application/web-application.js';
import { BaseController } from '../src/application/base-controller.js';

describe('CORS Middleware', () => {
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = undefined;
    }
  });

  class TestController extends BaseController {
    routes() {
      return [
        this.route()
          .get('/api/test')
          .handle((req, res) => {
            this.ok(res, { message: 'CORS test' });
          }),
      ];
    }
  }

  describe('CORS Disabled', () => {
    test('no CORS headers when CORS: false', async () => {
      const app = new WebApplication({
        PORT: 0,
        ENV_MODE: 'test',
        LOG_LEVEL: 'ERROR',
        CORS: false,
      });

      app.registerController('/', TestController);
      shutdown = await app.start();

      const res = await supertest(app.express).get('/api/test').expect(200);

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-methods']).toBeUndefined();
      expect(res.headers['access-control-allow-headers']).toBeUndefined();
    });
  });

  describe('CORS Enabled with Defaults', () => {
    test('CORS enabled with default settings when CORS: true', async () => {
      const app = new WebApplication({
        PORT: 0,
        ENV_MODE: 'test',
        LOG_LEVEL: 'ERROR',
        CORS: true,
      });

      app.registerController('/', TestController);
      shutdown = await app.start();

      const res = await supertest(app.express)
        .get('/api/test')
        .set('Origin', 'http://example.com')
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    test('preflight OPTIONS returns 204', async () => {
      const app = new WebApplication({
        PORT: 0,
        ENV_MODE: 'test',
        LOG_LEVEL: 'ERROR',
        CORS: true,
      });

      app.registerController('/', TestController);
      shutdown = await app.start();

      const res = await supertest(app.express)
        .options('/api/test')
        .set('Origin', 'http://example.com')
        .set('Access-Control-Request-Method', 'GET')
        .expect(204);

      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-methods']).toBeDefined();
    });
  });

  describe('CORS with Custom Configuration', () => {
    test('custom origin allowed', async () => {
      const app = new WebApplication({
        PORT: 0,
        ENV_MODE: 'test',
        LOG_LEVEL: 'ERROR',
        CORS: {
          origin: 'https://myapp.com',
        },
      });

      app.registerController('/', TestController);
      shutdown = await app.start();

      const res = await supertest(app.express)
        .get('/api/test')
        .set('Origin', 'https://myapp.com')
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBe('https://myapp.com');
    });

    test('disallowed origin blocked', async () => {
      const app = new WebApplication({
        PORT: 0,
        ENV_MODE: 'test',
        LOG_LEVEL: 'ERROR',
        CORS: {
          origin: 'https://myapp.com',
        },
      });

      app.registerController('/', TestController);
      shutdown = await app.start();

      const res = await supertest(app.express)
        .get('/api/test')
        .set('Origin', 'https://evil.com')
        .expect(200);

      // When origin is not allowed, cors middleware doesn't set the header
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    test('multiple origins allowed', async () => {
      const app = new WebApplication({
        PORT: 0,
        ENV_MODE: 'test',
        LOG_LEVEL: 'ERROR',
        CORS: {
          origin: ['https://app1.com', 'https://app2.com'],
        },
      });

      app.registerController('/', TestController);
      shutdown = await app.start();

      // Test first origin
      const res1 = await supertest(app.express)
        .get('/api/test')
        .set('Origin', 'https://app1.com')
        .expect(200);

      expect(res1.headers['access-control-allow-origin']).toBe('https://app1.com');

      // Test second origin
      const res2 = await supertest(app.express)
        .get('/api/test')
        .set('Origin', 'https://app2.com')
        .expect(200);

      expect(res2.headers['access-control-allow-origin']).toBe('https://app2.com');
    });

    test('credentials header present when configured', async () => {
      const app = new WebApplication({
        PORT: 0,
        ENV_MODE: 'test',
        LOG_LEVEL: 'ERROR',
        CORS: {
          origin: 'https://myapp.com',
          credentials: true,
        },
      });

      app.registerController('/', TestController);
      shutdown = await app.start();

      const res = await supertest(app.express)
        .get('/api/test')
        .set('Origin', 'https://myapp.com')
        .expect(200);

      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    test('custom allowed methods', async () => {
      const app = new WebApplication({
        PORT: 0,
        ENV_MODE: 'test',
        LOG_LEVEL: 'ERROR',
        CORS: {
          methods: ['GET', 'POST'],
        },
      });

      app.registerController('/', TestController);
      shutdown = await app.start();

      const res = await supertest(app.express)
        .options('/api/test')
        .set('Origin', 'http://example.com')
        .set('Access-Control-Request-Method', 'GET')
        .expect(204);

      expect(res.headers['access-control-allow-methods']).toBe('GET,POST');
    });

    test('custom allowed headers', async () => {
      const app = new WebApplication({
        PORT: 0,
        ENV_MODE: 'test',
        LOG_LEVEL: 'ERROR',
        CORS: {
          allowedHeaders: ['Content-Type', 'Authorization', 'X-Custom-Header'],
        },
      });

      app.registerController('/', TestController);
      shutdown = await app.start();

      const res = await supertest(app.express)
        .options('/api/test')
        .set('Origin', 'http://example.com')
        .set('Access-Control-Request-Method', 'GET')
        .set('Access-Control-Request-Headers', 'Content-Type')
        .expect(204);

      expect(res.headers['access-control-allow-headers']).toBe(
        'Content-Type,Authorization,X-Custom-Header'
      );
    });

    test('exposed headers in response', async () => {
      const app = new WebApplication({
        PORT: 0,
        ENV_MODE: 'test',
        LOG_LEVEL: 'ERROR',
        CORS: {
          exposedHeaders: ['X-Total-Count', 'X-Page-Number'],
        },
      });

      app.registerController('/', TestController);
      shutdown = await app.start();

      const res = await supertest(app.express)
        .get('/api/test')
        .set('Origin', 'http://example.com')
        .expect(200);

      expect(res.headers['access-control-expose-headers']).toBe('X-Total-Count,X-Page-Number');
    });

    test('max-age header in preflight', async () => {
      const app = new WebApplication({
        PORT: 0,
        ENV_MODE: 'test',
        LOG_LEVEL: 'ERROR',
        CORS: {
          maxAge: 7200, // 2 hours
        },
      });

      app.registerController('/', TestController);
      shutdown = await app.start();

      const res = await supertest(app.express)
        .options('/api/test')
        .set('Origin', 'http://example.com')
        .set('Access-Control-Request-Method', 'GET')
        .expect(204);

      expect(res.headers['access-control-max-age']).toBe('7200');
    });
  });

  describe('CORS with Dynamic Origin Function', () => {
    test('dynamic origin function allows specific origins', async () => {
      const app = new WebApplication({
        PORT: 0,
        ENV_MODE: 'test',
        LOG_LEVEL: 'ERROR',
        CORS: {
          origin: (origin: string, callback: (err: Error | null, allowed: boolean) => void) => {
            // Allow origins ending with .mycompany.com
            if (!origin || origin.endsWith('.mycompany.com')) {
              callback(null, true);
            } else {
              callback(null, false);
            }
          },
        },
      });

      app.registerController('/', TestController);
      shutdown = await app.start();

      // Allowed origin
      const res1 = await supertest(app.express)
        .get('/api/test')
        .set('Origin', 'https://app.mycompany.com')
        .expect(200);

      expect(res1.headers['access-control-allow-origin']).toBe('https://app.mycompany.com');

      // Disallowed origin
      const res2 = await supertest(app.express)
        .get('/api/test')
        .set('Origin', 'https://evil.com')
        .expect(200);

      expect(res2.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('CORS Integration with Routes', () => {
    test('CORS headers present on successful request', async () => {
      const app = new WebApplication({
        PORT: 0,
        ENV_MODE: 'test',
        LOG_LEVEL: 'ERROR',
        CORS: true,
      });

      app.registerController('/', TestController);
      shutdown = await app.start();

      const res = await supertest(app.express)
        .get('/api/test')
        .set('Origin', 'http://example.com')
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.body).toEqual({
        success: true,
        data: { message: 'CORS test' },
      });
    });

    test('CORS headers present on error response', async () => {
      class ErrorController extends BaseController {
        routes() {
          return [
            this.route()
              .get('/api/error')
              .handle((req, res) => {
                throw new Error('Test error');
              }),
          ];
        }
      }

      const app = new WebApplication({
        PORT: 0,
        ENV_MODE: 'test',
        LOG_LEVEL: 'ERROR',
        CORS: true,
      });

      app.registerController('/', ErrorController);
      shutdown = await app.start();

      const res = await supertest(app.express)
        .get('/api/error')
        .set('Origin', 'http://example.com')
        .expect(500);

      // CORS headers should be present even on error
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.body.success).toBe(false);
    });

    test('CORS works with all HTTP methods', async () => {
      class MultiMethodController extends BaseController {
        routes() {
          return [
            this.route()
              .post('/api/test')
              .handle((req, res) => this.ok(res, { method: 'POST' })),
            this.route()
              .put('/api/test')
              .handle((req, res) => this.ok(res, { method: 'PUT' })),
            this.route()
              .delete('/api/test')
              .handle((req, res) => this.ok(res, { method: 'DELETE' })),
          ];
        }
      }

      const app = new WebApplication({
        PORT: 0,
        ENV_MODE: 'test',
        LOG_LEVEL: 'ERROR',
        CORS: true,
      });

      app.registerController('/', MultiMethodController);
      shutdown = await app.start();

      // Test POST
      const resPost = await supertest(app.express)
        .post('/api/test')
        .set('Origin', 'http://example.com')
        .expect(200);
      expect(resPost.headers['access-control-allow-origin']).toBe('*');

      // Test PUT
      const resPut = await supertest(app.express)
        .put('/api/test')
        .set('Origin', 'http://example.com')
        .expect(200);
      expect(resPut.headers['access-control-allow-origin']).toBe('*');

      // Test DELETE
      const resDelete = await supertest(app.express)
        .delete('/api/test')
        .set('Origin', 'http://example.com')
        .expect(200);
      expect(resDelete.headers['access-control-allow-origin']).toBe('*');
    });
  });
});
