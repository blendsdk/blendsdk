import pino from 'pino';
import type { Logger as PinoLogger } from 'pino';
import type { Logger } from '@blendsdk/webafx';
import { LoggerProvider } from './abstract-logger-provider.js';
import { DEFAULT_REDACT_PATHS, type PinoLoggerProviderConfig } from './types.js';

/**
 * Valid pino log levels for normalization.
 */
const VALID_PINO_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

/**
 * Normalize a log level string to a valid pino level.
 *
 * Handles both uppercase ('INFO', 'ERROR') and lowercase ('info', 'error').
 * Returns 'info' for unrecognized values.
 *
 * Decision per AR #6: auto-map uppercase↔lowercase.
 *
 * @param level - Log level string to normalize
 * @returns Valid pino log level
 */
export function normalizeLevel(level: string): string {
  const lower = level.toLowerCase();
  return VALID_PINO_LEVELS.has(lower) ? lower : 'info';
}

/**
 * Internal adapter wrapping a pino child logger to satisfy the Logger interface.
 *
 * Not exported — used internally by PinoLoggerProvider.createRequestLogger().
 * Each instance binds context (e.g., requestId) to every log entry.
 */
class PinoChildLoggerAdapter implements Logger {
  constructor(private readonly child: PinoLogger) {}

  async info(message: string, data?: Record<string, any>): Promise<void> {
    if (data) {
      this.child.info(data, message);
    } else {
      this.child.info(message);
    }
  }

  async error(message: string, data?: Record<string, any>): Promise<void> {
    if (data) {
      this.child.error(data, message);
    } else {
      this.child.error(message);
    }
  }

  async warn(message: string, data?: Record<string, any>): Promise<void> {
    if (data) {
      this.child.warn(data, message);
    } else {
      this.child.warn(message);
    }
  }

  async debug(message: string, data?: Record<string, any>): Promise<void> {
    if (data) {
      this.child.debug(data, message);
    } else {
      this.child.debug(message);
    }
  }
}

/**
 * Pino-based logger provider for the BlendSDK Logger interface.
 *
 * Adapts pino's object-first sync API to the BlendSDK message-first async API.
 * Supports structured JSON logging, log level normalization, redaction,
 * pretty-printing, and request-scoped child loggers.
 *
 * Can be used standalone (no WebAFX required) or as a WebAFX plugin via
 * `createLoggerPlugin()` or `pinoLoggerPlugin()`.
 *
 * @example
 * ```typescript
 * // Standalone usage
 * const logger = new PinoLoggerProvider({ level: 'info', pretty: true });
 * await logger.info('Server started', { port: 3000 });
 * ```
 *
 * @example
 * ```typescript
 * // As WebAFX plugin
 * import { pinoLoggerPlugin } from '@blendsdk/webafx-pino';
 * app.use(pinoLoggerPlugin({ level: 'debug', pretty: true }));
 * ```
 */
export class PinoLoggerProvider extends LoggerProvider {
  /** The underlying pino logger instance */
  private readonly pino: PinoLogger;

  constructor(config?: PinoLoggerProviderConfig) {
    super(config);

    const level = normalizeLevel(config?.level ?? 'info');
    const redact = config?.redact ?? DEFAULT_REDACT_PATHS;

    // Build pino options
    const pinoOpts: pino.LoggerOptions = {
      level,
      ...(redact.length > 0 ? { redact } : {}),
      ...(config?.serializers ? { serializers: config.serializers } : {}),
      ...(config?.pinoOptions ?? {}),
    };

    // Enable pretty-printing for development (only when no custom destination)
    if (config?.pretty && !config?.destination) {
      pinoOpts.transport = {
        target: 'pino-pretty',
        options: { colorize: true },
      };
    }

    // Use custom destination if provided, otherwise stdout
    if (config?.destination) {
      this.pino = pino(pinoOpts, config.destination);
    } else {
      this.pino = pino(pinoOpts);
    }
  }

  // ── Logger interface implementation ─────────────────────────────────────

  async info(message: string, data?: Record<string, any>): Promise<void> {
    if (data) {
      this.pino.info(data, message);
    } else {
      this.pino.info(message);
    }
  }

  async error(message: string, data?: Record<string, any>): Promise<void> {
    if (data) {
      this.pino.error(data, message);
    } else {
      this.pino.error(message);
    }
  }

  async warn(message: string, data?: Record<string, any>): Promise<void> {
    if (data) {
      this.pino.warn(data, message);
    } else {
      this.pino.warn(message);
    }
  }

  async debug(message: string, data?: Record<string, any>): Promise<void> {
    if (data) {
      this.pino.debug(data, message);
    } else {
      this.pino.debug(message);
    }
  }

  // ── Provider lifecycle ─────────────────────────────────────────────────

  async health(): Promise<boolean> {
    return true;
  }

  async shutdown(): Promise<void> {
    // Flush buffered log entries before shutting down
    return new Promise<void>((resolve) => {
      this.pino.flush(() => resolve());
    });
  }

  // ── Request-scoped loggers ─────────────────────────────────────────────

  /**
   * Create a request-scoped logger with bound context.
   *
   * Creates a pino child logger with the given bindings (e.g., requestId).
   * All log entries from the child include the bindings automatically.
   *
   * @param bindings - Key-value pairs to include in every log entry
   * @returns A Logger-compatible adapter wrapping the child logger
   */
  createRequestLogger(bindings: Record<string, unknown>): Logger {
    const child = this.pino.child(bindings);
    return new PinoChildLoggerAdapter(child);
  }

  /**
   * Access the underlying pino instance.
   *
   * Useful for advanced scenarios like creating pino-http middleware
   * or accessing pino-specific features not exposed by the Logger interface.
   *
   * @returns The underlying pino logger
   */
  getPinoInstance(): PinoLogger {
    return this.pino;
  }
}
