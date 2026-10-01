import type { Logger } from '@blendsdk/webafx';
import { DEFAULT_SERVICE_NAME, type LoggerProviderConfig } from './types.js';

/**
 * Abstract base class for logger providers.
 *
 * Implements the BlendSDK Logger interface and adds provider lifecycle
 * methods (health, shutdown) and request-scoped logger creation.
 *
 * Concrete implementations (e.g., PinoLoggerProvider) translate Logger
 * method calls to their underlying logging library.
 *
 * This class has NO runtime dependency on @blendsdk/webafx — only the
 * Logger type is imported for interface compliance.
 *
 * @example
 * ```typescript
 * // Standalone usage (no WebAFX required)
 * const logger = new PinoLoggerProvider({ level: 'info' });
 * await logger.info('Hello world');
 * await logger.shutdown();
 * ```
 */
export abstract class LoggerProvider implements Logger {
  /** Service name for WebAFX service container registration */
  protected _serviceName: string;

  constructor(config?: LoggerProviderConfig) {
    this._serviceName = config?.serviceName ?? DEFAULT_SERVICE_NAME;
  }

  /** Service name used for WebAFX service container registration */
  get serviceName(): string {
    return this._serviceName;
  }

  // ── Logger interface methods (abstract — concrete providers implement) ──

  /** Log an informational message */
  abstract info(message: string, data?: Record<string, any>): Promise<void>;

  /** Log an error message */
  abstract error(message: string, data?: Record<string, any>): Promise<void>;

  /** Log a warning message */
  abstract warn(message: string, data?: Record<string, any>): Promise<void>;

  /** Log a debug message */
  abstract debug(message: string, data?: Record<string, any>): Promise<void>;

  // ── Provider lifecycle methods ──────────────────────────────────────────

  /**
   * Check the health status of the logger.
   * Loggers are typically stateless, so this returns true by default.
   * Concrete implementations may override if they use external transports.
   */
  abstract health(): Promise<boolean>;

  /**
   * Gracefully shut down the logger.
   * Implementations should flush any buffered log entries.
   */
  abstract shutdown(): Promise<void>;

  // ── Request-scoped logger creation ──────────────────────────────────────

  /**
   * Create a request-scoped logger with bound context (e.g., requestId).
   *
   * Returns a Logger instance that includes the provided bindings in
   * every log entry. Used by the plugin middleware to attach `req.log`.
   *
   * @param bindings - Key-value pairs to include in every log entry
   * @returns A Logger instance with the bindings bound
   */
  abstract createRequestLogger(bindings: Record<string, unknown>): Logger;
}
