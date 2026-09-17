import { LogLevel } from './console-logger.js';
import { Logger } from './type.js';

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
 * Structured log entry format for JSON output.
 */
export interface LogEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Log level */
  level: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
  /** Log message */
  message: string;
  /** Optional logger prefix */
  prefix?: string;
  /** Optional request ID from async context */
  requestId?: string;
  /** Optional additional data */
  data?: Record<string, unknown>;
  /** Any additional context from contextFn */
  [key: string]: unknown;
}

/**
 * Structured JSON logger implementation.
 * Outputs logs as JSON objects for production environments with log aggregation.
 *
 * @remarks
 * This logger is ideal for:
 * - Production environments with centralized logging (e.g., ELK, CloudWatch)
 * - Log parsing and filtering by log aggregation systems
 * - Structured querying of logs
 *
 * Use ConsoleLogger for development where human-readable output is preferred.
 *
 * @example
 * ```typescript
 * const logger = new StructuredLogger('API', 'INFO');
 * await logger.info('User login', { userId: 123 });
 * // Output: {"timestamp":"2026-02-08T18:30:00.000Z","level":"INFO","message":"User login","prefix":"API","data":{"userId":123}}
 * ```
 */
export class StructuredLogger implements Logger {
  protected prefix: string | undefined;
  protected level: number;
  protected contextFn?: () => Record<string, unknown>;

  /**
   * Creates a new StructuredLogger instance.
   *
   * @param prefix - Optional prefix for log messages (e.g., 'APP', 'Plugin:Auth')
   * @param logLevel - Optional log level (defaults to process.env.LOG_LEVEL or 'ERROR')
   * @param contextFn - Optional function to add dynamic context to every log entry (e.g., request ID)
   */
  constructor(prefix?: string, logLevel?: LogLevel, contextFn?: () => Record<string, unknown>) {
    this.prefix = prefix;
    // Use provided log level, fall back to process.env.LOG_LEVEL, then default to ERROR
    const levelFromEnv = (process.env.LOG_LEVEL || 'ERROR').toUpperCase() as LogLevel;
    this.level = LOG_LEVEL_MAP[logLevel || levelFromEnv] ?? 1;
    this.contextFn = contextFn;
  }

  /**
   * Logs an error message as JSON.
   *
   * @param message - Error message
   * @param data - Optional additional data to include in log entry
   */
  async error(message: string, data?: Record<string, unknown>): Promise<void> {
    if (this.shouldLog(1)) {
      this.write('ERROR', message, data);
    }
  }

  /**
   * Logs a warning message as JSON.
   *
   * @param message - Warning message
   * @param data - Optional additional data to include in log entry
   */
  async warn(message: string, data?: Record<string, unknown>): Promise<void> {
    if (this.shouldLog(2)) {
      this.write('WARN', message, data);
    }
  }

  /**
   * Logs an informational message as JSON.
   *
   * @param message - Info message
   * @param data - Optional additional data to include in log entry
   */
  async info(message: string, data?: Record<string, unknown>): Promise<void> {
    if (this.shouldLog(3)) {
      this.write('INFO', message, data);
    }
  }

  /**
   * Logs a debug message as JSON.
   *
   * @param message - Debug message
   * @param data - Optional additional data to include in log entry
   */
  async debug(message: string, data?: Record<string, unknown>): Promise<void> {
    if (this.shouldLog(4) || process.env.DEBUG === 'true') {
      this.write('DEBUG', message, data);
    }
  }

  /**
   * Determines if a message at the given level should be logged.
   *
   * @param level - Log level of the message (1=ERROR, 2=WARN, 3=INFO, 4=DEBUG)
   * @returns True if message should be logged
   * @internal
   */
  protected shouldLog(level: number): boolean {
    return level <= this.level;
  }

  /**
   * Writes a structured log entry as JSON to stdout or stderr.
   *
   * @param level - Log level string
   * @param message - Log message
   * @param data - Optional additional data
   * @internal
   */
  protected write(level: string, message: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: level as LogEntry['level'],
      message,
      // Add prefix if set
      ...(this.prefix && { prefix: this.prefix }),
      // Add dynamic context from contextFn if provided
      ...(this.contextFn && this.contextFn()),
      // Add additional data if provided
      ...(data && { data }),
    };

    const output = JSON.stringify(entry);

    // Use console.error for ERROR level, console.log for all others
    if (level === 'ERROR') {
      console.error(output);
    } else {
      console.log(output);
    }
  }
}
