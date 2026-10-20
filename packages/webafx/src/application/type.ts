import { ServiceContainer } from './service-container.js';

/**
 * Extends Express Request interface to include WebAFX-specific properties.
 */
declare global {
  namespace Express {
    interface Request {
      /** Service container for dependency injection */
      services: ServiceContainer;
      /** Unique request ID for tracing */
      id?: string;
    }
  }
}

/**
 * Logger interface for structured logging.
 * All log methods are async to support various logging backends.
 */
export interface Logger {
  /** Log an informational message */
  info: (message: string, data?: Record<string, any>) => Promise<void>;
  /** Log an error message */
  error: (message: string, data?: Record<string, any>) => Promise<void>;
  /** Log a warning message */
  warn: (message: string, data?: Record<string, any>) => Promise<void>;
  /** Log a debug message */
  debug: (message: string, data?: Record<string, any>) => Promise<void>;
}
