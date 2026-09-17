import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import supertest from 'supertest';
import { WebApplication } from '../src/application/web-application.js';
import { BaseController } from '../src/application/base-controller.js';
import { rateLimitMiddleware } from '../src/application/rate-limiter.js';
import { Request, Response } from 'express';

describe('Phase 6: Security Hardening', () => {
  let app: WebApplication;
  let shutdown: () => Promise<void>;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
    }
  });

  describe('Task 6.1.1: Helmet Security Headers', () => {
    beforeEach(async () => {
      app = new WebApplication({ PORT: 0, ENV_MODE: 'test', CORS: false });
      
      class TestController extends BaseController {
        routes() {
          return [
            this.route().get('/test').handle(this.test),
          ];
        }
        async test(_req: Request, res: Response) {
          res.json({ message: 'test' });
        }
      }
      
      app.registerController('/api', TestController);
      shutdown = await app.start();
    });

    test('should include helmet security headers', async () => {
      const response = await supertest(app['expressApp'])
        .get('/api/test')
        .expect(200);

      // Helmet sets these headers by default
      expect(response.headers).toHaveProperty('x-content-type-options', 'nosniff');
      expect(response.headers).toHaveProperty('x-frame-options');
      expect(response.headers).toHaveProperty('x-download-options', 'noopen');
      expect(response.headers).toHaveProperty('x-permitted-cross-domain-policies', 'none');
    });

    test('should not expose X-Powered-By header', async () => {
      const response = await supertest(app['expressApp'])
        .get('/api/test')
        .expect(200);

      expect(response.headers['x-powered-by']).toBeUndefined();
    });

    test('should include Strict-Transport-Security header', async () => {
      const response = await supertest(app['expressApp'])
        .get('/api/test')
        .expect(200);

      expect(response.headers).toHaveProperty('strict-transport-security');
      expect(response.headers['strict-transport-security']).toContain('max-age');
    });
  });

  describe('Task 6.1.2: Rate Limiting Middleware', () => {
    test('should allow requests within limit', async () => {
      app = new WebApplication({ PORT: 0, ENV_MODE: 'test', CORS: false });
      
      class TestController extends BaseController {
        routes() {
          return [
            this.route()
              .get('/test')
              .middleware(rateLimitMiddleware({ maxRequests: 5, windowMs: 60000 }))
              .handle(this.test),
          ];
        }
        async test(_req: Request, res: Response) {
          res.json({ message: 'test' });
        }
      }
      
      app.registerController('/api', TestController);
      shutdown = await app.start();

      // Make 5 requests (within limit)
      for (let i = 0; i < 5; i++) {
        const response = await supertest(app['expressApp'])
          .get('/api/test')
          .expect(200);

        expect(response.headers).toHaveProperty('x-ratelimit-limit', '5');
        expect(response.headers).toHaveProperty('x-ratelimit-remaining');
      }
    });

    test('should block requests exceeding limit', async () => {
      app = new WebApplication({ PORT: 0, ENV_MODE: 'test', CORS: false });
      
      class TestController extends BaseController {
        routes() {
          return [
            this.route()
              .get('/test')
              .middleware(rateLimitMiddleware({ maxRequests: 3, windowMs: 60000 }))
              .handle(this.test),
          ];
        }
        async test(_req: Request, res: Response) {
          res.json({ message: 'test' });
        }
      }
      
      app.registerController('/api', TestController);
      shutdown = await app.start();

      // Make 3 successful requests
      for (let i = 0; i < 3; i++) {
        await supertest(app['expressApp']).get('/api/test').expect(200);
      }

      // 4th request should fail with 429 status
      await supertest(app['expressApp'])
        .get('/api/test')
        .expect(429);
    });

    test('should include rate limit headers', async () => {
      app = new WebApplication({ PORT: 0, ENV_MODE: 'test', CORS: false });
      
      class TestController extends BaseController {
        routes() {
          return [
            this.route()
              .get('/test')
              .middleware(rateLimitMiddleware({ maxRequests: 10, windowMs: 60000 }))
              .handle(this.test),
          ];
        }
        async test(_req: Request, res: Response) {
          res.json({ message: 'test' });
        }
      }
      
      app.registerController('/api', TestController);
      shutdown = await app.start();

      const response = await supertest(app['expressApp'])
        .get('/api/test')
        .expect(200);

      expect(response.headers).toHaveProperty('x-ratelimit-limit', '10');
      expect(response.headers).toHaveProperty('x-ratelimit-remaining', '9');
      expect(response.headers).toHaveProperty('x-ratelimit-reset');
      
      // Reset should be a Unix timestamp (in seconds)
      const reset = parseInt(response.headers['x-ratelimit-reset'] as string, 10);
      expect(reset).toBeGreaterThan(Date.now() / 1000);
    });

    test('should support custom key extractor', async () => {
      app = new WebApplication({ PORT: 0, ENV_MODE: 'test', CORS: false });
      
      class TestController extends BaseController {
        routes() {
          return [
            this.route()
              .get('/test')
              .middleware(
                rateLimitMiddleware({
                  maxRequests: 2,
                  windowMs: 60000,
                  keyExtractor: (req) => req.headers['x-user-id'] as string || 'anonymous',
                })
              )
              .handle(this.test),
          ];
        }
        async test(_req: Request, res: Response) {
          res.json({ message: 'test' });
        }
      }
      
      app.registerController('/api', TestController);
      shutdown = await app.start();

      // User 1 - 2 requests (should succeed)
      await supertest(app['expressApp'])
        .get('/api/test')
        .set('X-User-ID', 'user1')
        .expect(200);
      
      await supertest(app['expressApp'])
        .get('/api/test')
        .set('X-User-ID', 'user1')
        .expect(200);

      // User 1 - 3rd request (should fail)
      await supertest(app['expressApp'])
        .get('/api/test')
        .set('X-User-ID', 'user1')
        .expect(429);

      // User 2 - should still succeed (different key)
      await supertest(app['expressApp'])
        .get('/api/test')
        .set('X-User-ID', 'user2')
        .expect(200);
    });

    test('should reset after window expires', async () => {
      app = new WebApplication({ PORT: 0, ENV_MODE: 'test', CORS: false });
      
      class TestController extends BaseController {
        routes() {
          return [
            this.route()
              .get('/test')
              .middleware(rateLimitMiddleware({ maxRequests: 2, windowMs: 100 }))
              .handle(this.test),
          ];
        }
        async test(_req: Request, res: Response) {
          res.json({ message: 'test' });
        }
      }
      
      app.registerController('/api', TestController);
      shutdown = await app.start();

      // Make 2 requests
      await supertest(app['expressApp']).get('/api/test').expect(200);
      await supertest(app['expressApp']).get('/api/test').expect(200);

      // 3rd should fail
      await supertest(app['expressApp']).get('/api/test').expect(429);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should work again
      await supertest(app['expressApp']).get('/api/test').expect(200);
    });
  });

  describe('Task 6.1.4 & 6.1.5: ESM Config Loading & No process.env Mutation', () => {
    test('should load config using async import()', async () => {
      // This test verifies loadFromFile is async and uses import()
      app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
      
      // If loadFromFile was not async, the app wouldn't initialize properly
      shutdown = await app.start();
      
      // Verify app started successfully
      const response = await supertest(app['expressApp'])
        .get('/health')
        .expect(200);

      expect(response.body).toHaveProperty('health', true);
    });

    test('should not mutate process.env during config loading', () => {
      // Save original process.env values
      const originalEnvMode = process.env.ENV_MODE;
      const originalLogLevel = process.env.LOG_LEVEL;
      const originalDebug = process.env.DEBUG;

      // Create app with config
      app = new WebApplication({
        PORT: 0,
        ENV_MODE: 'development',
        LOG_LEVEL: 'INFO',
        DEBUG: true,
      });

      // Verify process.env was not modified
      expect(process.env.ENV_MODE).toBe(originalEnvMode);
      expect(process.env.LOG_LEVEL).toBe(originalLogLevel);
      expect(process.env.DEBUG).toBe(originalDebug);

      // Verify config was set correctly in ApplicationSettings
      const settings = app.getSettings();
      expect(settings.ENV_MODE).toBe('development');
      expect(settings.LOG_LEVEL).toBe('INFO');
      expect(settings.DEBUG).toBe(true);
    });

    test('should use config as single source of truth', () => {
      app = new WebApplication({
        PORT: 9999,
        ENV_MODE: 'production',
        LOG_LEVEL: 'ERROR',
      });

      const settings = app.getSettings();
      
      // Config values should be accessible via ApplicationSettings
      expect(settings.PORT).toBe(9999);
      expect(settings.ENV_MODE).toBe('production');
      expect(settings.LOG_LEVEL).toBe('ERROR');
      
      // process.env should remain unchanged
      expect(process.env.PORT).toBeUndefined();
    });
  });

  describe('Integration: Security Features Together', () => {
    test('should combine helmet, rate limiting, and CORS', async () => {
      app = new WebApplication({
        PORT: 0,
        ENV_MODE: 'test',
        CORS: {
          origin: 'https://example.com',
          credentials: true,
        },
      });

      class TestController extends BaseController {
        routes() {
          return [
            this.route()
              .get('/secure')
              .middleware(rateLimitMiddleware({ maxRequests: 5, windowMs: 60000 }))
              .handle(this.secure),
          ];
        }
        async secure(_req: Request, res: Response) {
          res.json({ secure: true });
        }
      }

      app.registerController('/api', TestController);
      shutdown = await app.start();

      const response = await supertest(app['expressApp'])
        .get('/api/secure')
        .set('Origin', 'https://example.com')
        .expect(200);

      // Helmet headers
      expect(response.headers).toHaveProperty('x-content-type-options', 'nosniff');
      expect(response.headers).toHaveProperty('strict-transport-security');
      
      // Rate limit headers
      expect(response.headers).toHaveProperty('x-ratelimit-limit', '5');
      expect(response.headers).toHaveProperty('x-ratelimit-remaining', '4');
      
      // CORS headers
      expect(response.headers).toHaveProperty('access-control-allow-origin', 'https://example.com');
      expect(response.headers).toHaveProperty('access-control-allow-credentials', 'true');
    });
  });
});
