import { NextFunction, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleLogger, LogLevel } from '../src/application/console-logger.js';
import { StructuredLogger } from '../src/application/structured-logger.js';
import {
  getRequestContext,
  getRequestId,
  RequestContext,
  requestContextStorage,
} from '../src/application/request-context.js';
import { requestIdMiddleware } from '../src/application/request-id-middleware.js';

describe('ConsoleLogger - Constructor Log Level Injection', () => {
  let consoleLogSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should accept log level via constructor', async () => {
    const logger = new ConsoleLogger('TEST', 'INFO');

    await logger.error('error');
    await logger.warn('warn');
    await logger.info('info');
    await logger.debug('debug');

    // Should log ERROR, WARN, INFO (not DEBUG)
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).toHaveBeenCalledTimes(2); // WARN + INFO
  });

  it('should ignore process.env.LOG_LEVEL when constructor level provided', async () => {
    const originalLogLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'DEBUG'; // Set env to DEBUG

    // Constructor provides ERROR — should override env
    const logger = new ConsoleLogger('TEST', 'ERROR');

    await logger.error('error');
    await logger.warn('warn');
    await logger.info('info');

    // Only ERROR should log (constructor overrides env)
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).toHaveBeenCalledTimes(0);

    process.env.LOG_LEVEL = originalLogLevel;
  });

  it('should fall back to process.env.LOG_LEVEL when no constructor level', async () => {
    const originalLogLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'WARN';

    const logger = new ConsoleLogger('TEST'); // No log level provided

    await logger.error('error');
    await logger.warn('warn');
    await logger.info('info');

    // Should use env WARN level
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).toHaveBeenCalledTimes(1); // Only WARN

    process.env.LOG_LEVEL = originalLogLevel;
  });

  it('should default to ERROR when no constructor level and no env', async () => {
    const originalLogLevel = process.env.LOG_LEVEL;
    delete process.env.LOG_LEVEL;

    const logger = new ConsoleLogger('TEST');

    await logger.error('error');
    await logger.warn('warn');
    await logger.info('info');

    // Only ERROR should log
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).toHaveBeenCalledTimes(0);

    process.env.LOG_LEVEL = originalLogLevel;
  });

  it('should support all log levels via constructor', async () => {
    const levels: LogLevel[] = ['ERROR', 'WARN', 'INFO', 'DEBUG'];

    for (const level of levels) {
      consoleLogSpy.mockClear();
      consoleErrorSpy.mockClear();

      const logger = new ConsoleLogger('TEST', level);

      await logger.error('e');
      await logger.warn('w');
      await logger.info('i');
      await logger.debug('d');

      // Calculate expected counts
      const expectedError = 1; // ERROR always logs
      let expectedLog = 0;
      if (level === 'WARN') expectedLog = 1; // WARN
      if (level === 'INFO') expectedLog = 2; // WARN + INFO
      if (level === 'DEBUG') expectedLog = 3; // WARN + INFO + DEBUG

      expect(consoleErrorSpy).toHaveBeenCalledTimes(expectedError);
      expect(consoleLogSpy).toHaveBeenCalledTimes(expectedLog);
    }
  });

  it('should handle case-insensitive log levels from env', async () => {
    const originalLogLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'info'; // lowercase

    const logger = new ConsoleLogger('TEST');

    await logger.info('info message');
    expect(consoleLogSpy).toHaveBeenCalled();

    process.env.LOG_LEVEL = originalLogLevel;
  });
});

describe('StructuredLogger', () => {
  let consoleLogSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('JSON Output Format', () => {
    it('should output valid JSON for all log levels', async () => {
      const logger = new StructuredLogger('TEST', 'DEBUG');

      await logger.error('error msg');
      await logger.warn('warn msg');
      await logger.info('info msg');
      await logger.debug('debug msg');

      // ERROR uses console.error
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const errorOutput = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(errorOutput.level).toBe('ERROR');
      expect(errorOutput.message).toBe('error msg');

      // Others use console.log
      expect(consoleLogSpy).toHaveBeenCalledTimes(3);
      const warnOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(warnOutput.level).toBe('WARN');
      expect(warnOutput.message).toBe('warn msg');
    });

    it('should include timestamp in ISO 8601 format', async () => {
      const logger = new StructuredLogger('TEST', 'INFO');

      await logger.info('test');

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('should include log level', async () => {
      const logger = new StructuredLogger('TEST', 'DEBUG');

      await logger.error('e');
      await logger.warn('w');
      await logger.info('i');
      await logger.debug('d');

      const errorOutput = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(errorOutput.level).toBe('ERROR');

      const warnOutput = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(warnOutput.level).toBe('WARN');

      const infoOutput = JSON.parse(consoleLogSpy.mock.calls[1][0]);
      expect(infoOutput.level).toBe('INFO');

      const debugOutput = JSON.parse(consoleLogSpy.mock.calls[2][0]);
      expect(debugOutput.level).toBe('DEBUG');
    });

    it('should include message', async () => {
      const logger = new StructuredLogger('TEST', 'INFO');

      await logger.info('Test message');

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.message).toBe('Test message');
    });

    it('should include prefix when set', async () => {
      const logger = new StructuredLogger('API', 'INFO');

      await logger.info('test');

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.prefix).toBe('API');
    });

    it('should not include prefix when not set', async () => {
      const logger = new StructuredLogger(undefined, 'INFO');

      await logger.info('test');

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.prefix).toBeUndefined();
    });

    it('should include additional data when provided', async () => {
      const logger = new StructuredLogger('TEST', 'INFO');

      await logger.info('User login', { userId: 123, ip: '127.0.0.1' });

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.data).toEqual({ userId: 123, ip: '127.0.0.1' });
    });

    it('should not include data property when no data provided', async () => {
      const logger = new StructuredLogger('TEST', 'INFO');

      await logger.info('Simple message');

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.data).toBeUndefined();
    });
  });

  describe('Context Function', () => {
    it('should include context from contextFn', async () => {
      const contextFn = () => ({ requestId: 'abc-123', userId: 456 });
      const logger = new StructuredLogger('TEST', 'INFO', contextFn);

      await logger.info('test');

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.requestId).toBe('abc-123');
      expect(output.userId).toBe(456);
    });

    it('should not include context when contextFn not provided', async () => {
      const logger = new StructuredLogger('TEST', 'INFO');

      await logger.info('test');

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.requestId).toBeUndefined();
    });

    it('should call contextFn for every log entry', async () => {
      const contextFn = vi.fn(() => ({ count: 1 }));
      const logger = new StructuredLogger('TEST', 'INFO', contextFn);

      await logger.info('message 1');
      await logger.info('message 2');
      await logger.info('message 3');

      expect(contextFn).toHaveBeenCalledTimes(3);
    });

    it('should support dynamic context values', async () => {
      let counter = 0;
      const contextFn = () => ({ count: ++counter });
      const logger = new StructuredLogger('TEST', 'INFO', contextFn);

      await logger.info('msg1');
      await logger.info('msg2');

      const output1 = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      const output2 = JSON.parse(consoleLogSpy.mock.calls[1][0]);

      expect(output1.count).toBe(1);
      expect(output2.count).toBe(2);
    });
  });

  describe('Log Level Filtering', () => {
    it('should respect ERROR log level', async () => {
      const logger = new StructuredLogger('TEST', 'ERROR');

      await logger.error('e');
      await logger.warn('w');
      await logger.info('i');
      await logger.debug('d');

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy).toHaveBeenCalledTimes(0);
    });

    it('should respect WARN log level', async () => {
      const logger = new StructuredLogger('TEST', 'WARN');

      await logger.error('e');
      await logger.warn('w');
      await logger.info('i');
      await logger.debug('d');

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy).toHaveBeenCalledTimes(1); // WARN only
    });

    it('should respect INFO log level', async () => {
      const logger = new StructuredLogger('TEST', 'INFO');

      await logger.error('e');
      await logger.warn('w');
      await logger.info('i');
      await logger.debug('d');

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy).toHaveBeenCalledTimes(2); // WARN + INFO
    });

    it('should respect DEBUG log level', async () => {
      const logger = new StructuredLogger('TEST', 'DEBUG');

      await logger.error('e');
      await logger.warn('w');
      await logger.info('i');
      await logger.debug('d');

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy).toHaveBeenCalledTimes(3); // WARN + INFO + DEBUG
    });

    it('should use process.env.DEBUG for debug messages when set', async () => {
      const originalDebug = process.env.DEBUG;
      process.env.DEBUG = 'true';

      const logger = new StructuredLogger('TEST', 'ERROR');

      await logger.debug('debug message');

      // DEBUG env overrides log level for debug messages
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);

      process.env.DEBUG = originalDebug;
    });

    it('should fall back to process.env.LOG_LEVEL when no constructor level', async () => {
      const originalLogLevel = process.env.LOG_LEVEL;
      process.env.LOG_LEVEL = 'INFO';

      const logger = new StructuredLogger('TEST');

      await logger.info('info message');
      await logger.debug('debug message');

      expect(consoleLogSpy).toHaveBeenCalledTimes(1); // INFO only

      process.env.LOG_LEVEL = originalLogLevel;
    });
  });

  describe('Error vs Log Output Routing', () => {
    it('should use console.error for ERROR level', async () => {
      const logger = new StructuredLogger('TEST', 'ERROR');

      await logger.error('error message');

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy).toHaveBeenCalledTimes(0);
    });

    it('should use console.log for WARN, INFO, DEBUG', async () => {
      const logger = new StructuredLogger('TEST', 'DEBUG');

      await logger.warn('w');
      await logger.info('i');
      await logger.debug('d');

      expect(consoleLogSpy).toHaveBeenCalledTimes(3);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(0);
    });
  });
});

describe('Request Context (AsyncLocalStorage)', () => {
  describe('getRequestContext', () => {
    it('should return undefined outside request scope', () => {
      const context = getRequestContext();
      expect(context).toBeUndefined();
    });

    it('should return context inside request scope', () => {
      const testContext: RequestContext = {
        requestId: 'test-123',
        startTime: Date.now(),
      };

      requestContextStorage.run(testContext, () => {
        const context = getRequestContext();
        expect(context).toEqual(testContext);
      });
    });

    it('should isolate contexts between concurrent requests', async () => {
      const context1: RequestContext = { requestId: 'req-1', startTime: 1000 };
      const context2: RequestContext = { requestId: 'req-2', startTime: 2000 };

      const results: (RequestContext | undefined)[] = [];

      // Simulate concurrent requests
      await Promise.all([
        new Promise<void>(resolve => {
          requestContextStorage.run(context1, () => {
            // Simulate async operation
            setTimeout(() => {
              results.push(getRequestContext());
              resolve();
            }, 10);
          });
        }),
        new Promise<void>(resolve => {
          requestContextStorage.run(context2, () => {
            setTimeout(() => {
              results.push(getRequestContext());
              resolve();
            }, 5);
          });
        }),
      ]);

      // Each context should have its own isolated data
      expect(results).toHaveLength(2);
      expect(results.some(r => r?.requestId === 'req-1')).toBe(true);
      expect(results.some(r => r?.requestId === 'req-2')).toBe(true);
    });
  });

  describe('getRequestId', () => {
    it('should return undefined outside request scope', () => {
      const requestId = getRequestId();
      expect(requestId).toBeUndefined();
    });

    it('should return request ID inside request scope', () => {
      const testContext: RequestContext = {
        requestId: 'test-456',
        startTime: Date.now(),
      };

      requestContextStorage.run(testContext, () => {
        const requestId = getRequestId();
        expect(requestId).toBe('test-456');
      });
    });

    it('should work with nested async operations', async () => {
      const testContext: RequestContext = {
        requestId: 'nested-789',
        startTime: Date.now(),
      };

      await new Promise<void>(resolve => {
        requestContextStorage.run(testContext, async () => {
          // Nested async operation
          await new Promise<void>(innerResolve => {
            setTimeout(() => {
              const requestId = getRequestId();
              expect(requestId).toBe('nested-789');
              innerResolve();
            }, 10);
          });

          // Another nested operation
          const anotherAsync = async () => {
            return new Promise<void>(innerResolve => {
              setTimeout(() => {
                const requestId = getRequestId();
                expect(requestId).toBe('nested-789');
                innerResolve();
              }, 5);
            });
          };

          await anotherAsync();
          resolve();
        });
      });
    });
  });

  describe('Custom Context Properties', () => {
    it('should support adding custom properties to context', () => {
      const testContext: RequestContext = {
        requestId: 'test-custom',
        startTime: Date.now(),
        userId: 123,
        ipAddress: '127.0.0.1',
      };

      requestContextStorage.run(testContext, () => {
        const context = getRequestContext();
        expect(context?.userId).toBe(123);
        expect(context?.ipAddress).toBe('127.0.0.1');
      });
    });
  });
});

describe('Request ID Middleware with AsyncLocalStorage', () => {
  function createMockReqResNext(headers: Record<string, string> = {}) {
    const req = {
      headers,
      id: undefined as string | undefined,
    } as unknown as Request;

    const responseHeaders: Record<string, string> = {};
    const res = {
      setHeader: (name: string, value: string) => {
        responseHeaders[name] = value;
      },
    } as unknown as Response;

    return { req, res, responseHeaders };
  }

  it('should store request context in AsyncLocalStorage', async () => {
    const { req, res } = createMockReqResNext();
    const middleware = requestIdMiddleware();

    await new Promise<void>(resolve => {
      // Create a next() function that checks context inside the AsyncLocalStorage scope
      const next = () => {
        const context = getRequestContext();
        expect(context).toBeDefined();
        expect(context?.requestId).toBe(req.id);
        expect(context?.startTime).toBeGreaterThan(0);
        resolve();
      };

      middleware(req, res, next as NextFunction);
    });
  });

  it('should make request ID accessible via getRequestId', async () => {
    const { req, res } = createMockReqResNext();
    const middleware = requestIdMiddleware();

    await new Promise<void>(resolve => {
      const next = () => {
        const requestId = getRequestId();
        expect(requestId).toBe(req.id);
        resolve();
      };

      middleware(req, res, next as NextFunction);
    });
  });

  it('should set startTime in context', async () => {
    const { req, res } = createMockReqResNext();
    const middleware = requestIdMiddleware();
    const before = Date.now();

    await new Promise<void>(resolve => {
      const next = () => {
        const context = getRequestContext();
        expect(context?.startTime).toBeGreaterThanOrEqual(before);
        expect(context?.startTime).toBeLessThanOrEqual(Date.now());
        resolve();
      };

      middleware(req, res, next as NextFunction);
    });
  });

  it('should propagate context through async operations', async () => {
    const { req, res } = createMockReqResNext();
    const middleware = requestIdMiddleware();

    await new Promise<void>(resolve => {
      const next = () => {
        // Simulate async operation inside the context
        setTimeout(() => {
          const requestId = getRequestId();
          expect(requestId).toBe(req.id);
          resolve();
        }, 10);
      };

      middleware(req, res, next as NextFunction);
    });
  });
});
