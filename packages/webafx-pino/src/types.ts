/**
 * Configuration types and constants for the webafx-pino logger plugin.
 *
 * @packageDocumentation
 */

/**
 * Default service name for the logger in the service container.
 * Used when no custom serviceName is provided.
 */
export const DEFAULT_SERVICE_NAME = 'logger';

/**
 * Default plugin priority for the logger plugin.
 * Set to 20 to install before cache (30) and mailer (30) plugins.
 *
 * Decision per AR #8.
 */
export const DEFAULT_PLUGIN_PRIORITY = 20;

/**
 * Default paths to redact from log output.
 * Masks sensitive headers to prevent credential leakage.
 */
export const DEFAULT_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
];

/**
 * Base configuration for any logger provider.
 * Concrete providers extend this with implementation-specific options.
 */
export interface LoggerProviderConfig {
  /**
   * Log level — accepts both uppercase ('INFO') and lowercase ('info').
   * Mapped internally to pino's lowercase format.
   * Default: 'info' (or from ApplicationSettings.LOG_LEVEL).
   *
   * Decision per AR #6: auto-map uppercase↔lowercase.
   */
  level?: string;

  /**
   * Service name for the WebAFX service container.
   * Default: 'logger'
   */
  serviceName?: string;
}

/**
 * Configuration specific to the Pino logger provider.
 * Extends base config with pino-specific options.
 */
export interface PinoLoggerProviderConfig extends LoggerProviderConfig {
  /**
   * Enable pretty-printed output for development.
   * Requires `pino-pretty` as a peer dependency.
   * Default: false
   */
  pretty?: boolean;

  /**
   * Paths to redact from log output.
   * Default: ['req.headers.authorization', 'req.headers.cookie']
   */
  redact?: string[];

  /**
   * Custom pino serializers for request and response objects.
   * Controls what data from req/res is included in log entries.
   */
  serializers?: {
    req?: (req: unknown) => unknown;
    res?: (res: unknown) => unknown;
  };

  /**
   * Additional pino options passed directly to the pino() constructor.
   * Typed as Record to avoid exposing pino types in the public API.
   *
   * Decision per AR #13: keep as Record<string, unknown>.
   */
  pinoOptions?: Record<string, unknown>;

  /**
   * Custom destination stream for pino output.
   * If provided, pino writes to this stream instead of stdout.
   * Useful for testing (capture output) or custom transports.
   *
   * Note: When `destination` is provided, `pretty` is ignored
   * (pino-pretty uses transport, which conflicts with custom destinations).
   */
  destination?: import('node:stream').Writable;
}

/**
 * Convenience options for pinoLoggerPlugin() one-liner.
 * Combines provider config with plugin-specific options.
 */
export interface PinoLoggerPluginOptions extends PinoLoggerProviderConfig {
  /**
   * Plugin priority override.
   * Lower numbers install first.
   * Default: 20 (before cache at 30, mailer at 30).
   *
   * Decision per AR #8.
   */
  priority?: number;
}
