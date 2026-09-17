import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { WebApplication } from '../src/application/web-application.js';
import { BaseController } from '../src/application/base-controller.js';
import { ApplicationSettings } from '../src/application/application-settings.js';
import { ServiceContainer } from '../src/application/service-container.js';
import { Request, Response } from 'express';
import supertest from 'supertest';

/**
 * Test controller to verify ServiceContainer injection
 */
class TestController extends BaseController {
  routes() {
    return [
      this.route()
        .get('/')
        .handle(async (req: Request, res: Response) => {
          // Access services from req.services (per-request container)
          const customService = await req.services.get('test-service', 'default-value');
          res.json({ service: customService });
        }),
      this.route()
        .get('/settings')
        .handle(async (req: Request, res: Response) => {
          // Access settings from controller's protected property
          const env = this.settings.get('ENV_MODE');
          res.json({ env });
        }),
    ];
  }
}

describe('Architecture Improvements - Session 5.1', () => {
  let app: WebApplication;
  let shutdown: (() => Promise<void>) | null = null;

  beforeEach(() => {
    app = new WebApplication({ ENV_MODE: 'test', PORT: 0 });
  });

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = null;
    }
  });

  describe('Task 5.1.1: ServiceContainer injection to controllers', () => {
    test('should pass ServiceContainer to controller constructor', async () => {
      // Register a test service
      app.registerService({
        name: 'test-service',
        factory: async () => 'injected-service-value',
      });

      // Register controller
      app.registerController('/test', TestController);

      // Start app
      shutdown = await app.start();

      // Test that controller can access services
      const response = await supertest((app as any).expressApp)
        .get('/test')
        .expect(200);

      expect(response.body).toEqual({ service: 'injected-service-value' });
    });

    test('should allow controller to access settings', async () => {
      app.registerController('/test', TestController);
      shutdown = await app.start();

      const response = await supertest((app as any).expressApp)
        .get('/test/settings')
        .expect(200);

      expect(response.body).toEqual({ env: 'test' });
    });

    test('should allow controller to access application-level services', async () => {
      // Register a singleton service at app level
      app.registerService({
        name: 'db-connection',
        factory: async () => ({ connected: true, pool: 'main' }),
      });

      class DatabaseController extends BaseController {
        routes() {
          return [
            this.route()
              .get('/db-status')
              .handle(async (req: Request, res: Response) => {
                // Access application-level singleton service
                const db = await req.services.get('db-connection');
                res.json(db);
              }),
          ];
        }
      }

      app.registerController('/api', DatabaseController);
      shutdown = await app.start();

      const response = await supertest((app as any).expressApp)
        .get('/api/db-status')
        .expect(200);

      expect(response.body).toEqual({ connected: true, pool: 'main' });
    });
  });

  describe('Task 5.1.2: Plugin priority ordering', () => {
    test('should install plugins in priority order (lower first)', async () => {
      const installOrder: string[] = [];

      // Register plugins with different priorities
      app.use({
        name: 'plugin-high-priority',
        priority: 10,
        factory: async () => {
          installOrder.push('high-priority');
          return {};
        },
      });

      app.use({
        name: 'plugin-low-priority',
        priority: 200,
        factory: async () => {
          installOrder.push('low-priority');
          return {};
        },
      });

      app.use({
        name: 'plugin-medium-priority',
        priority: 50,
        factory: async () => {
          installOrder.push('medium-priority');
          return {};
        },
      });

      shutdown = await app.start();

      // Verify plugins installed in correct order
      expect(installOrder).toEqual(['high-priority', 'medium-priority', 'low-priority']);
    });

    test('should use default priority of 100 if not specified', async () => {
      const installOrder: string[] = [];

      app.use({
        name: 'plugin-explicit-100',
        priority: 100,
        factory: async () => {
          installOrder.push('explicit-100');
          return {};
        },
      });

      app.use({
        name: 'plugin-default',
        // No priority specified - should default to 100
        factory: async () => {
          installOrder.push('default');
          return {};
        },
      });

      app.use({
        name: 'plugin-before-default',
        priority: 50,
        factory: async () => {
          installOrder.push('before-default');
          return {};
        },
      });

      app.use({
        name: 'plugin-after-default',
        priority: 150,
        factory: async () => {
          installOrder.push('after-default');
          return {};
        },
      });

      shutdown = await app.start();

      expect(installOrder).toEqual([
        'before-default',
        'explicit-100',
        'default',
        'after-default',
      ]);
    });

    test('should handle plugins with same priority (stable sort)', async () => {
      const installOrder: string[] = [];

      app.use({
        name: 'plugin-a',
        priority: 50,
        factory: async () => {
          installOrder.push('a');
          return {};
        },
      });

      app.use({
        name: 'plugin-b',
        priority: 50,
        factory: async () => {
          installOrder.push('b');
          return {};
        },
      });

      app.use({
        name: 'plugin-c',
        priority: 50,
        factory: async () => {
          installOrder.push('c');
          return {};
        },
      });

      shutdown = await app.start();

      // Should maintain registration order for same priority
      expect(installOrder).toEqual(['a', 'b', 'c']);
    });
  });

  describe('Task 5.1.3: Lifecycle hooks', () => {
    test('should fire beforeStart hook before server starts', async () => {
      const events: string[] = [];

      app.on('beforeStart', () => {
        events.push('beforeStart');
      });

      app.on('afterStart', () => {
        events.push('afterStart');
      });

      // Add a plugin to verify ordering
      app.use({
        name: 'test-plugin',
        factory: async () => {
          events.push('plugin-install');
          return {};
        },
      });

      shutdown = await app.start();
      events.push('after-await-start');

      // beforeStart fires before plugins install
      expect(events[0]).toBe('beforeStart');
      expect(events).toContain('plugin-install');
      expect(events).toContain('afterStart');
      expect(events).toContain('after-await-start');
    });

    test('should fire afterStart hook after server starts', async () => {
      let serverReady = false;

      app.on('afterStart', () => {
        serverReady = true;
      });

      shutdown = await app.start();

      // After start() resolves, afterStart should have fired
      expect(serverReady).toBe(true);
    });

    test('should fire beforeShutdown and afterShutdown hooks', async () => {
      const events: string[] = [];

      app.on('beforeShutdown', () => {
        events.push('beforeShutdown');
      });

      app.on('afterShutdown', () => {
        events.push('afterShutdown');
      });

      shutdown = await app.start();
      await shutdown();
      shutdown = null;

      expect(events).toEqual(['beforeShutdown', 'afterShutdown']);
    });

    test('should support async lifecycle hooks', async () => {
      const events: string[] = [];

      app.on('beforeStart', async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        events.push('async-beforeStart');
      });

      app.on('afterStart', async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        events.push('async-afterStart');
      });

      shutdown = await app.start();

      expect(events).toEqual(['async-beforeStart', 'async-afterStart']);
    });

    test('should support multiple hooks for same event', async () => {
      const events: string[] = [];

      app.on('beforeStart', () => {
        events.push('hook1');
      });

      app.on('beforeStart', () => {
        events.push('hook2');
      });

      app.on('beforeStart', () => {
        events.push('hook3');
      });

      shutdown = await app.start();

      expect(events).toEqual(['hook1', 'hook2', 'hook3']);
    });

    test('should allow chaining lifecycle hooks', async () => {
      const events: string[] = [];

      app
        .on('beforeStart', () => events.push('before'))
        .on('afterStart', () => events.push('after'));

      shutdown = await app.start();

      expect(events).toEqual(['before', 'after']);
    });

    test('should fire hooks in correct order during full lifecycle', async () => {
      const events: string[] = [];

      app
        .on('beforeStart', () => events.push('1-beforeStart'))
        .on('afterStart', () => events.push('3-afterStart'))
        .on('beforeShutdown', () => events.push('4-beforeShutdown'))
        .on('afterShutdown', () => events.push('6-afterShutdown'));

      // Add plugin to track middle events
      app.use({
        name: 'tracker',
        factory: async () => {
          events.push('2-plugin-install');
          return {
            shutdown: async () => {
              events.push('5-plugin-shutdown');
            },
          };
        },
      });

      shutdown = await app.start();
      await shutdown();
      shutdown = null;

      expect(events).toEqual([
        '1-beforeStart',
        '2-plugin-install',
        '3-afterStart',
        '4-beforeShutdown',
        '5-plugin-shutdown',
        '6-afterShutdown',
      ]);
    });

    test('should use hooks for initialization tasks', async () => {
      let databaseInitialized = false;
      let cacheWarmed = false;

      app
        .on('beforeStart', async () => {
          // Simulate database initialization
          await new Promise(resolve => setTimeout(resolve, 5));
          databaseInitialized = true;
        })
        .on('afterStart', async () => {
          // Simulate cache warming
          await new Promise(resolve => setTimeout(resolve, 5));
          cacheWarmed = true;
        });

      shutdown = await app.start();

      expect(databaseInitialized).toBe(true);
      expect(cacheWarmed).toBe(true);
    });
  });

  describe('Integration: Controllers + Plugins + Hooks', () => {
    test('should work together in a realistic scenario', async () => {
      const events: string[] = [];

      // Setup lifecycle hooks
      app.on('beforeStart', () => {
        events.push('init-database');
      });

      app.on('afterStart', () => {
        events.push('ready-for-requests');
      });

      // Register high-priority plugin (auth)
      app.use({
        name: 'auth',
        priority: 10,
        factory: async () => {
          events.push('install-auth-plugin');
          return {};
        },
      });

      // Register low-priority plugin (metrics)
      app.use({
        name: 'metrics',
        priority: 50,
        factory: async () => {
          events.push('install-metrics-plugin');
          return {};
        },
      });

      // Register service
      app.registerService({
        name: 'user-service',
        factory: async () => ({ findById: (id: string) => ({ id, name: 'Test User' }) }),
      });

      // Register controller that uses service
      class UserController extends BaseController {
        routes() {
          return [
            this.route()
              .get('/:id')
              .handle(async (req: Request, res: Response) => {
                const userService = await req.services.get('user-service') as any;
                const user = userService.findById(req.params.id);
                res.json(user);
              }),
          ];
        }
      }

      app.registerController('/users', UserController);

      shutdown = await app.start();

      // Verify event order
      expect(events).toEqual([
        'init-database',
        'install-auth-plugin',
        'install-metrics-plugin',
        'ready-for-requests',
      ]);

      // Verify controller works
      const response = await supertest((app as any).expressApp)
        .get('/users/123')
        .expect(200);

      expect(response.body).toEqual({ id: '123', name: 'Test User' });
    });
  });
});
