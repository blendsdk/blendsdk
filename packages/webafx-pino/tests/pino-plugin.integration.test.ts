import { Writable } from 'node:stream';
import { describe, it, expect, afterEach } from 'vitest';
import {
  PinoLoggerProvider,
  pinoLoggerPlugin,
  createLoggerPlugin,
} from '../src/index.js';
import type { Logger, PluginDefinition } from '@blendsdk/webafx';

// ── Test Helpers ─────────────────────────────────────────────────────────

function createLogCollector(): { stream: Writable; entries: any[] } {
  const entries: any[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      try {
        entries.push(JSON.parse(chunk.toString()));
      } catch {
        entries.push(chunk.toString());
      }
      callback();
    },
  });
  return { stream, entries };
}

/**
 * Minimal WebApplication mock for plugin integration tests.
 * Per testing strategy: mock with setLogger(), registerService(), logger property.
 */
function createMockApp() {
  let currentLogger: Logger | null = null;
  const services: Record<string, any> = {};
  const middlewares: any[] = [];

  const mockExpress = {
    use: (mw: any) => middlewares.push(mw),
  };

  const mockApp = {
    setLogger: (logger: Logger) => {
      currentLogger = logger;
    },
    registerService: (def: { name: string; type: string; factory: () => any }) => {
      services[def.name] = def;
    },
    get logger() {
      return currentLogger;
    },
    get registeredServices() {
      return services;
    },
    get installedMiddlewares() {
      return middlewares;
    },
  };

  return { mockApp, mockExpress };
}

// ── Plugin Integration Tests ─────────────────────────────────────────────

describe('Plugin Integration', () => {
  let provider: PinoLoggerProvider | null = null;

  afterEach(async () => {
    if (provider) {
      await provider.shutdown();
      provider = null;
    }
  });

  it('plugin factory calls setLogger on the app', async () => {
    const { stream } = createLogCollector();
    provider = new PinoLoggerProvider({ level: 'silent', destination: stream });
    const plugin = createLoggerPlugin(provider);
    const { mockApp, mockExpress } = createMockApp();

    const result = await plugin.factory({
      app: mockApp as any,
      express: mockExpress as any,
      logger: { info: async () => {}, error: async () => {}, warn: async () => {}, debug: async () => {} },
    });

    // Verify setLogger was called — app.logger should now be the provider
    expect(mockApp.logger).toBe(provider);
  });

  it('plugin registers provider in service container', async () => {
    const { stream } = createLogCollector();
    provider = new PinoLoggerProvider({ level: 'silent', destination: stream });
    const plugin = createLoggerPlugin(provider);
    const { mockApp, mockExpress } = createMockApp();

    await plugin.factory({
      app: mockApp as any,
      express: mockExpress as any,
      logger: { info: async () => {}, error: async () => {}, warn: async () => {}, debug: async () => {} },
    });

    // Verify service was registered
    expect(mockApp.registeredServices['logger']).toBeDefined();
    expect(mockApp.registeredServices['logger'].type).toBe('singleton');
    expect(mockApp.registeredServices['logger'].factory()).toBe(provider);
  });

  it('plugin installs req.log middleware', async () => {
    const { stream } = createLogCollector();
    provider = new PinoLoggerProvider({ level: 'silent', destination: stream });
    const plugin = createLoggerPlugin(provider);
    const { mockApp, mockExpress } = createMockApp();

    await plugin.factory({
      app: mockApp as any,
      express: mockExpress as any,
      logger: { info: async () => {}, error: async () => {}, warn: async () => {}, debug: async () => {} },
    });

    // Verify middleware was installed
    expect(mockApp.installedMiddlewares.length).toBe(1);
    expect(typeof mockApp.installedMiddlewares[0]).toBe('function');
  });

  it('req.log middleware creates request-scoped logger', async () => {
    const { stream, entries } = createLogCollector();
    provider = new PinoLoggerProvider({ level: 'trace', destination: stream });
    const plugin = createLoggerPlugin(provider);
    const { mockApp, mockExpress } = createMockApp();

    await plugin.factory({
      app: mockApp as any,
      express: mockExpress as any,
      logger: { info: async () => {}, error: async () => {}, warn: async () => {}, debug: async () => {} },
    });

    // Simulate a request passing through the middleware
    const mockReq: any = { id: 'req-abc-123' };
    const mockRes: any = {};
    let nextCalled = false;
    const mockNext = () => { nextCalled = true; };

    mockApp.installedMiddlewares[0](mockReq, mockRes, mockNext);

    // Verify req.log was set and next() was called
    expect(nextCalled).toBe(true);
    expect(mockReq.log).toBeDefined();
    expect(mockReq.log.info).toBeInstanceOf(Function);

    // Verify child logger includes requestId binding
    await mockReq.log.info('test from request');
    expect(entries.length).toBe(1);
    expect(entries[0].requestId).toBe('req-abc-123');
    expect(entries[0].msg).toBe('test from request');
  });

  it('req.log middleware handles missing req.id gracefully', async () => {
    const { stream, entries } = createLogCollector();
    provider = new PinoLoggerProvider({ level: 'trace', destination: stream });
    const plugin = createLoggerPlugin(provider);
    const { mockApp, mockExpress } = createMockApp();

    await plugin.factory({
      app: mockApp as any,
      express: mockExpress as any,
      logger: { info: async () => {}, error: async () => {}, warn: async () => {}, debug: async () => {} },
    });

    const mockReq: any = {}; // no id
    const mockRes: any = {};
    let nextCalled = false;
    mockApp.installedMiddlewares[0](mockReq, mockRes, () => { nextCalled = true; });

    expect(nextCalled).toBe(true);
    expect(mockReq.log).toBeDefined();

    await mockReq.log.info('no request id');
    expect(entries[0].msg).toBe('no request id');
    expect(entries[0].requestId).toBeUndefined(); // no binding
  });

  it('plugin health returns true', async () => {
    const { stream } = createLogCollector();
    provider = new PinoLoggerProvider({ level: 'silent', destination: stream });
    const plugin = createLoggerPlugin(provider);
    const { mockApp, mockExpress } = createMockApp();

    const result = await plugin.factory({
      app: mockApp as any,
      express: mockExpress as any,
      logger: { info: async () => {}, error: async () => {}, warn: async () => {}, debug: async () => {} },
    });

    expect(result).toBeDefined();
    expect(await result!.health!()).toBe(true);
  });

  it('plugin shutdown flushes cleanly', async () => {
    const { stream } = createLogCollector();
    provider = new PinoLoggerProvider({ level: 'silent', destination: stream });
    const plugin = createLoggerPlugin(provider);
    const { mockApp, mockExpress } = createMockApp();

    const result = await plugin.factory({
      app: mockApp as any,
      express: mockExpress as any,
      logger: { info: async () => {}, error: async () => {}, warn: async () => {}, debug: async () => {} },
    });

    await expect(result!.shutdown!()).resolves.toBeUndefined();
    provider = null; // already shut down
  });
});
