import { Logger } from './type.js';

/**
 * Log level enumeration for structured logging.
 */
export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';

/**
 * Map log level names to numeric values for comparison.
 * Lower numbers = higher priority (ERROR is highest).
 */
const LOG_LEVEL_MAP: Record<LogLevel, number> = {
  ERROR: 1,
  WARN: 2,
  INFO: 3,
  DEBUG: 4,
};

/**
 * Console-based logger implementation.
 * Provides structured logging with configurable log levels and prefixes.
 *
 * @remarks
 * Log levels:
 * - ERROR (1): Errors only
 * - WARN (2): Errors and warnings
 * - INFO (3): Errors, warnings, and info
 * - DEBUG (4): All messages including debug
 *
 * DEBUG mode can also be enabled via DEBUG=true environment variable.
 */
export class ConsoleLogger implements Logger {
  protected prefix: string | undefined;
  protected level: number;

  /**
   * Creates a new ConsoleLogger instance.
   *
   * @param prefix - Optional prefix for log messages (e.g., 'APP', 'Plugin:Auth')
   * @param logLevel - Optional log level (defaults to process.env.LOG_LEVEL or 'ERROR')
   */
  constructor(prefix?: string, logLevel?: LogLevel) {
    this.prefix = prefix;
    // Use provided log level, fall back to process.env.LOG_LEVEL, then default to ERROR
    const levelFromEnv = (process.env.LOG_LEVEL || 'ERROR').toUpperCase() as LogLevel;
    this.level = LOG_LEVEL_MAP[logLevel || levelFromEnv] ?? 1;
  }

  /**
   * Logs an error message.
   *
   * @param message - Error message
   * @param data - Optional additional data to log
   */
  async error(message: string, data?: Record<string, any>) {
    if (this.shouldLog(1)) {
      console.error(this.message('ERROR', message, data));
    }
  }

  /**
   * Logs a warning message.
   *
   * @param message - Warning message
   * @param data - Optional additional data to log
   */
  async warn(message: string, data?: Record<string, any>) {
    if (this.shouldLog(2)) {
      console.log(this.message('WARN', message, data));
    }
  }

  /**
   * Logs an informational message.
   *
   * @param message - Info message
   * @param data - Optional additional data to log
   */
  async info(message: string, data?: Record<string, any>) {
    if (this.shouldLog(3)) {
      console.log(this.message('INFO', message, data));
    }
  }

  /**
   * Logs a debug message.
   * Only logged if LOG_LEVEL >= 4 or DEBUG=true.
   *
   * @param message - Debug message
   * @param data - Optional additional data to log
   */
  async debug(message: string, data?: Record<string, any>) {
    if (this.shouldLog(4) || process.env.DEBUG === 'true') {
      console.log(this.message('DEBUG', message, data));
    }
  }

  /**
   * Determines if a message at the given level should be logged.
   *
   * The configured level acts as a threshold: all messages at or below
   * the configured level are logged. For example, if LOG_LEVEL=WARN (2),
   * then ERROR (1) and WARN (2) are logged, but INFO (3) and DEBUG (4) are not.
   *
   * @param level - Log level of the message (1=ERROR, 2=WARN, 3=INFO, 4=DEBUG)
   * @returns True if message should be logged
   * @internal
   */
  protected shouldLog(level: number): boolean {
    return level <= this.level;
  }

  /**
   * Formats a log message with type, prefix, and optional data.
   *
   * @param type - Log type (ERROR, WARN, INFO, DEBUG)
   * @param message - Log message
   * @param data - Optional additional data
   * @returns Formatted log message
   * @internal
   */
  protected message(type: string, message: string, data?: Record<string, any>) {
    return `[${type}${this.prefix ? `:${this.prefix.toUpperCase()}` : ''}]: ${message}${data ? ` - ${JSON.stringify(data)}` : ''}`;
  }
}
