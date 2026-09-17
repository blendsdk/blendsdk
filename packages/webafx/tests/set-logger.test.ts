/**
 * Tests for WebApplication.setLogger() method.
 *
 * Verifies that the logger can be replaced at runtime by plugins
 * (e.g., webafx-pino) and that subsequent log calls use the new logger.
 *
 * Decision per AR #2: setLogger() is a small, surgical addition to
 * WebApplication enabling logger plugins to replace ConsoleLogger.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConsoleLogger } from '../src/application/console-logger.js';
import { WebApplication } from '../src/application/web-application.js';
import type { Logger } from '../src/application/type.js';

describe('WebApplication.setLogger', () => {
  /**
   * Creates a mock Logger that implements the Logger interface.
   * All methods are spied so we can verify they were called.
   */
  function createMockLogger(): Logger & {
    info: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  } {
    return {
      info: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
      warn: vi.fn().mockResolvedValue(undefined),
      debug: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('should default to ConsoleLogger in the constructor', () => {
    const app = new WebApplication({ PORT: 0 });

    // Access protected logger via cast — acceptable in test code
    const logger = (app as any).logger;
    expect(logger).toBeInstanceOf(ConsoleLogger);
  });

  it('should replace the default ConsoleLogger with a custom logger', () => {
    const app = new WebApplication({ PORT: 0 });
    const customLogger = createMockLogger();

    app.setLogger(customLogger);

    // Verify the logger was replaced
    const logger = (app as any).logger;
    expect(logger).toBe(customLogger);
    expect(logger).not.toBeInstanceOf(ConsoleLogger);
  });

  it('should use the new logger for subsequent log calls', async () => {
    const app = new WebApplication({ PORT: 0 });
    const customLogger = createMockLogger();

    app.setLogger(customLogger);

    // Access the logger and call it — simulates framework-level logging
    const logger = (app as any).logger as Logger;
    await logger.info('test info message', { key: 'value' });
    await logger.error('test error message');

    expect(customLogger.info).toHaveBeenCalledWith('test info message', { key: 'value' });
    expect(customLogger.error).toHaveBeenCalledWith('test error message');
  });

  it('should allow the logger to be replaced multiple times (last-wins)', () => {
    const app = new WebApplication({ PORT: 0 });
    const firstLogger = createMockLogger();
    const secondLogger = createMockLogger();

    app.setLogger(firstLogger);
    app.setLogger(secondLogger);

    // The second logger should be the active one
    const logger = (app as any).logger;
    expect(logger).toBe(secondLogger);
    expect(logger).not.toBe(firstLogger);
  });

  it('should not affect messages logged before setLogger is called', async () => {
    const app = new WebApplication({ PORT: 0 });
    const customLogger = createMockLogger();

    // Log a message before replacing the logger — goes through ConsoleLogger
    // (We can't easily capture ConsoleLogger output here, but we verify
    // the custom logger was NOT called)
    const originalLogger = (app as any).logger as Logger;
    await originalLogger.info('pre-replacement message');

    // Now replace
    app.setLogger(customLogger);

    // Custom logger should not have been called for the pre-replacement message
    expect(customLogger.info).not.toHaveBeenCalled();
  });
});
