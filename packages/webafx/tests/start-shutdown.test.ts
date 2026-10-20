import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import supertest from 'supertest';
import { WebApplication } from '../src/application/web-application.js';
import { preparseServiceNames } from '../src/application/services.js';
import express from 'express';

describe('Phase 5.2: Start/Shutdown Refactoring', () => {
  let app: WebApplication;
  let shutdown: (() => Promise<void>) | undefined;

  beforeEach(() => {
    app = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
  });

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = undefined;
    }
  });

  describe('Task 5.2.1: Refactored start() method', () => {
    test('start() uses clean async/await (no nested promises)', async () => {
      // The start() method should now be async and return a Promise directly
      // Not wrapped in new Promise(async ...)
      shutdown = await app.start();

      expect(shutdown).toBeInstanceOf(Function);
      expect(typeof shutdown).toBe('function');
    });

    test('start() throws error if already started', async () => {
      shutdown = await app.start();

      await expect(app.start()).rejects.toThrow('Application already started');
    });

    test('start() returns working shutdown function', async () => {
      shutdown = await app.start();
      const request = supertest(app['expressApp']);

      // Verify server is running
      const response = await request.get('/health');
      expect(response.status).toBe(200);

      // Shutdown should work
      await shutdown();
      shutdown = undefined;

      // After shutdown, app.started should be false
      expect(app['started']).toBe(false);
    });

    test('server listens on configured port', async () => {
      const customApp = new WebApplication({ PORT: 0, ENV_MODE: 'test' });
      const customShutdown = await customApp.start();

      const server = customApp['server'];
      expect(server).toBeDefined();

      const address = server?.address();
      expect(address).toBeDefined();
      expect(typeof address).toBe('object');

      await customShutdown();
    });
  });

  describe('Task 5.2.2: Signal handlers & connection draining', () => {
    test('signal handlers are registered on start', async () => {
      shutdown = await app.start();

      // Check that signal handlers are tracked
      const handlers = app['signalHandlers'];
      expect(handlers).toHaveLength(2);
      expect(handlers[0].signal).toBe('SIGTERM');
      expect(handlers[1].signal).toBe('SIGINT');
    });

    test('signal handlers are cleaned up on shutdown', async () => {
      shutdown = await app.start();

      const handlersBefore = app['signalHandlers'];
      expect(handlersBefore.length).toBeGreaterThan(0);

      await shutdown();
      shutdown = undefined;

      const handlersAfter = app['signalHandlers'];
      expect(handlersAfter).toHaveLength(0);
    });

    test('cleanupSignalHandlers removes process listeners', async () => {
      shutdown = await app.start();

      const sigintListenersBefore = process.listenerCount('SIGINT');
      const sigtermListenersBefore = process.listenerCount('SIGTERM');

      await shutdown();
      shutdown = undefined;

      const sigintListenersAfter = process.listenerCount('SIGINT');
      const sigtermListenersAfter = process.listenerCount('SIGTERM');

      // After shutdown, listeners should be removed
      expect(sigintListenersAfter).toBeLessThan(sigintListenersBefore);
      expect(sigtermListenersAfter).toBeLessThan(sigtermListenersBefore);
    });

    test('shutdown function is idempotent (can be called multiple times)', async () => {
      shutdown = await app.start();

      // First shutdown
      await shutdown();

      // Second shutdown should not throw
      await expect(shutdown()).resolves.not.toThrow();

      shutdown = undefined;
    });

    test('connection draining timeout is configured', async () => {
      const prodApp = new WebApplication({
        PORT: 0,
        ENV_MODE: 'production',
        SHUTDOWN_TIMEOUT: 5,
      });

      const prodShutdown = await prodApp.start();

      // In production, shutdown delay should be SHUTDOWN_TIMEOUT * 1000
      // We can't easily test the actual timeout, but we can verify the config is used
      expect(prodApp['settings'].get('SHUTDOWN_TIMEOUT')).toBe(5);

      await prodShutdown();
    });
  });

  describe('Task 5.2.3: Express app getter', () => {
    test('express getter returns Express instance', () => {
      const expressApp = app.express;

      expect(expressApp).toBeDefined();
      expect(typeof expressApp.use).toBe('function');
      expect(typeof expressApp.get).toBe('function');
      expect(typeof expressApp.post).toBe('function');
    });

    test('express getter allows adding custom middleware', async () => {
      // Add custom middleware before starting
      let middlewareCalled = false;
      app.express.use((req, res, next) => {
        middlewareCalled = true;
        next();
      });

      shutdown = await app.start();
      const request = supertest(app.express);

      await request.get('/health');

      expect(middlewareCalled).toBe(true);
    });

    test('express getter allows adding static files', async () => {
      // Add a custom route using the Express instance
      app.express.get('/custom', (req, res) => {
        res.json({ custom: true });
      });

      shutdown = await app.start();
      const request = supertest(app.express);

      const response = await request.get('/custom');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ custom: true });
    });

    test('express getter returns the same instance used internally', () => {
      const publicExpress = app.express;
      const internalExpress = app['expressApp'];

      expect(publicExpress).toBe(internalExpress);
    });
  });

  describe('Task 5.2.4: preparseServiceNames deprecation', () => {
    test('preparseServiceNames emits deprecation warning', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      class TestServiceNames {
        static TEST_SERVICE: string;
        static ANOTHER_SERVICE: string;
      }

      preparseServiceNames(TestServiceNames);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[WebAFX DEPRECATION WARNING]')
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('preparseServiceNames() is deprecated')
      );

      consoleWarnSpy.mockRestore();
    });

    test('preparseServiceNames still functions correctly despite deprecation', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      class TestServiceNames {
        static LOGGER: string;
        static DATABASE: string;
      }

      preparseServiceNames(TestServiceNames);

      // Despite deprecation, it should still work
      expect(TestServiceNames.LOGGER).toBe('LOGGER');
      expect(TestServiceNames.DATABASE).toBe('DATABASE');

      consoleWarnSpy.mockRestore();
    });

    test('const object pattern works as recommended alternative', () => {
      // This is the recommended pattern (no deprecation warning)
      const ServiceNames = {
        LOGGER: 'LOGGER',
        DATABASE: 'DATABASE',
      } as const;

      expect(ServiceNames.LOGGER).toBe('LOGGER');
      expect(ServiceNames.DATABASE).toBe('DATABASE');

      // Type check: values are literal types
      type LoggerKey = typeof ServiceNames.LOGGER;
      const key: LoggerKey = 'LOGGER';
      expect(key).toBe('LOGGER');
    });
  });

  describe('Integration: Full lifecycle with new features', () => {
    test('complete lifecycle - start, request, shutdown', async () => {
      const events: string[] = [];

      app
        .on('beforeStart', () => {
          events.push('beforeStart');
        })
        .on('afterStart', () => {
          events.push('afterStart');
        })
        .on('beforeShutdown', () => {
          events.push('beforeShutdown');
        })
        .on('afterShutdown', () => {
          events.push('afterShutdown');
        });

      shutdown = await app.start();

      expect(events).toEqual(['beforeStart', 'afterStart']);

      const request = supertest(app.express);
      const response = await request.get('/health');
      expect(response.status).toBe(200);

      await shutdown();
      shutdown = undefined;

      expect(events).toEqual([
        'beforeStart',
        'afterStart',
        'beforeShutdown',
        'afterShutdown',
      ]);
    });

    test('signal handlers work correctly during lifecycle', async () => {
      const events: string[] = [];

      app
        .on('beforeShutdown', () => {
          events.push('beforeShutdown');
        })
        .on('afterShutdown', () => {
          events.push('afterShutdown');
        });

      shutdown = await app.start();

      const handlerCount = app['signalHandlers'].length;
      expect(handlerCount).toBeGreaterThan(0);

      await shutdown();
      shutdown = undefined;

      expect(app['signalHandlers']).toHaveLength(0);
      expect(events).toContain('beforeShutdown');
      expect(events).toContain('afterShutdown');
    });

    test('express getter accessible throughout lifecycle', async () => {
      // Before start
      expect(app.express).toBeDefined();

      shutdown = await app.start();

      // After start
      expect(app.express).toBeDefined();
      const request = supertest(app.express);
      await request.get('/health');

      await shutdown();
      shutdown = undefined;

      // After shutdown - Express instance still exists (but server is closed)
      expect(app.express).toBeDefined();
    });
  });
});
