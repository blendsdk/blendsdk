import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebApplication } from '../src/application/web-application.js';
import type { Plugin, PluginDefinition } from '../src/application/plugin.js';

describe('Plugin System', () => {
  let app: WebApplication;
  let shutdown: (() => Promise<void>) | undefined;

  beforeEach(() => {
    app = new WebApplication({
      PORT: 0,
      ENV_MODE: 'test',
      LOG_LEVEL: 'ERROR',
    });
  });

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = undefined;
    }
  });

  describe('Plugin Installation', () => {
    test('plugin factory receives app, express, and logger', async () => {
      const factorySpy = vi.fn(async ({ app, express, logger }) => {
        expect(app).toBeDefined();
        expect(app).toBeInstanceOf(WebApplication);
        expect(express).toBeDefined();
        expect(express).toHaveProperty('use'); // Express app
        expect(logger).toBeDefined();
        expect(logger).toHaveProperty('info');
        expect(logger).toHaveProperty('error');
        return {};
      });

      app.use({
        name: 'test-plugin',
        factory: factorySpy,
      });

      shutdown = await app.start();

      expect(factorySpy).toHaveBeenCalledTimes(1);
    });

    test('plugin installs successfully', async () => {
      let installed = false;

      app.use({
        name: 'simple-plugin',
        factory: async () => {
          installed = true;
          return {};
        },
      });

      shutdown = await app.start();

      expect(installed).toBe(true);
    });

    test('plugin can add Express middleware', async () => {
      let middlewareCalled = false;

      app.use({
        name: 'middleware-plugin',
        factory: async ({ express }) => {
          express.use((req, res, next) => {
            middlewareCalled = true;
            next();
          });
          return {};
        },
      });

      shutdown = await app.start();

      // Use supertest instead of fetch (works with PORT=0)
      const supertest = await import('supertest');
      const res = await supertest.default(app.express).get('/health').expect(200);
      expect(middlewareCalled).toBe(true);
    });

    test('plugin without health or shutdown still installs', async () => {
      let installed = false;

      app.use({
        name: 'minimal-plugin',
        factory: async () => {
          installed = true;
          // Return nothing (void)
        },
      });

      shutdown = await app.start();

      expect(installed).toBe(true);
    });
  });

  describe('Plugin Health Checks', () => {
    test('plugin with health check can be registered', async () => {
      let healthCalled = false;

      app.use({
        name: 'healthy-plugin',
        factory: async () => ({
          health: async () => {
            healthCalled = true;
            return true;
          },
        }),
      });

      shutdown = await app.start();

      // Plugin successfully registered and started
      expect(shutdown).toBeDefined();
    });

    test('plugin without health check does not cause errors', async () => {
      app.use({
        name: 'no-health-plugin',
        factory: async () => ({}),
      });

      shutdown = await app.start();

      // Plugin without health check successfully registered
      expect(shutdown).toBeDefined();
    });
  });

  describe('Plugin Shutdown', () => {
    test('plugin shutdown called on app shutdown', async () => {
      const shutdownSpy = vi.fn(async () => {});

      app.use({
        name: 'shutdown-plugin',
        factory: async () => ({
          shutdown: shutdownSpy,
        }),
      });

      shutdown = await app.start();
      await shutdown();
      shutdown = undefined;

      expect(shutdownSpy).toHaveBeenCalledTimes(1);
    });

    test('multiple plugins shut down in order', async () => {
      const shutdownOrder: string[] = [];

      app.use({
        name: 'plugin-1',
        factory: async () => ({
          shutdown: async () => {
            shutdownOrder.push('plugin-1');
          },
        }),
      });

      app.use({
        name: 'plugin-2',
        factory: async () => ({
          shutdown: async () => {
            shutdownOrder.push('plugin-2');
          },
        }),
      });

      shutdown = await app.start();
      await shutdown();
      shutdown = undefined;

      expect(shutdownOrder).toEqual(['plugin-1', 'plugin-2']);
    });

    test('plugin without shutdown does not cause errors', async () => {
      app.use({
        name: 'no-shutdown-plugin',
        factory: async () => ({}),
      });

      shutdown = await app.start();
      await expect(shutdown()).resolves.not.toThrow();
      shutdown = undefined;
    });
  });

  describe('Plugin Priority Ordering', () => {
    test('plugins install in priority order (lower first)', async () => {
      const installOrder: string[] = [];

      app.use({
        name: 'high-priority',
        priority: 10,
        factory: async () => {
          installOrder.push('high-priority');
          return {};
        },
      });

      app.use({
        name: 'low-priority',
        priority: 100,
        factory: async () => {
          installOrder.push('low-priority');
          return {};
        },
      });

      app.use({
        name: 'medium-priority',
        priority: 50,
        factory: async () => {
          installOrder.push('medium-priority');
          return {};
        },
      });

      shutdown = await app.start();

      expect(installOrder).toEqual(['high-priority', 'medium-priority', 'low-priority']);
    });

    test('plugins with same priority maintain registration order', async () => {
      const installOrder: string[] = [];

      app.use({
        name: 'plugin-a',
        priority: 50,
        factory: async () => {
          installOrder.push('plugin-a');
          return {};
        },
      });

      app.use({
        name: 'plugin-b',
        priority: 50,
        factory: async () => {
          installOrder.push('plugin-b');
          return {};
        },
      });

      app.use({
        name: 'plugin-c',
        priority: 50,
        factory: async () => {
          installOrder.push('plugin-c');
          return {};
        },
      });

      shutdown = await app.start();

      expect(installOrder).toEqual(['plugin-a', 'plugin-b', 'plugin-c']);
    });

    test('plugins without priority default to 100', async () => {
      const installOrder: string[] = [];

      app.use({
        name: 'explicit-100',
        priority: 100,
        factory: async () => {
          installOrder.push('explicit-100');
          return {};
        },
      });

      app.use({
        name: 'default-priority',
        // No priority specified
        factory: async () => {
          installOrder.push('default-priority');
          return {};
        },
      });

      app.use({
        name: 'priority-50',
        priority: 50,
        factory: async () => {
          installOrder.push('priority-50');
          return {};
        },
      });

      shutdown = await app.start();

      // priority-50 (50), then explicit-100 and default-priority in registration order
      expect(installOrder).toEqual(['priority-50', 'explicit-100', 'default-priority']);
    });
  });

  describe('Plugin Error Handling', () => {
    test('plugin factory error propagates during start', async () => {
      app.use({
        name: 'failing-plugin',
        factory: async () => {
          throw new Error('Plugin initialization failed');
        },
      });

      // Plugin errors propagate during app.start()
      await expect(app.start()).rejects.toThrow('Plugin initialization failed');
    });
  });
});
