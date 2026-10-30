import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { z } from 'zod';
import { ConsoleLogger } from './console-logger.js';

/**
 * Zod schema for validating application configuration.
 * Validates common configuration properties while allowing custom properties via .passthrough().
 */
const configSchema = z
  .object({
    PORT: z.number().int().min(0).max(65535).optional(),
    ENV_MODE: z.enum(['production', 'development', 'test']).optional(),
    LOG_LEVEL: z.enum(['ERROR', 'WARN', 'INFO', 'DEBUG']).optional(),
    DEBUG: z.boolean().optional(),
    TRUST_PROXY: z.boolean().optional(),
    BODY_LIMIT: z.string().optional(),
    SHUTDOWN_TIMEOUT: z.number().min(0).max(300).optional(),
    CORS: z.union([z.boolean(), z.object({}).passthrough()]).optional(),
  })
  .passthrough(); // Allow additional custom properties

/**
 * CORS configuration options
 */
export interface CorsConfig {
  /** Allowed origins (string, array, or callback function) */
  origin?: string | string[] | ((origin: string | undefined, callback: (err: Error | null, allowed: boolean) => void) => void);
  /** Allowed HTTP methods */
  methods?: string[];
  /** Allowed headers */
  allowedHeaders?: string[];
  /** Exposed headers */
  exposedHeaders?: string[];
  /** Allow credentials */
  credentials?: boolean;
  /** Max age for preflight cache */
  maxAge?: number;
}

/**
 * Application configuration interface.
 * Defines standard configuration properties with type safety.
 */
export interface ApplicationConfig {
  /** Enable debug mode */
  DEBUG?: boolean;
  /** Environment mode: production, development, or test */
  ENV_MODE?: 'production' | 'development' | 'test';
  /** Log levels */
  LOG_LEVEL?: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
  /** Server port number */
  PORT?: number;
  /** Trust proxy headers (for nginx, load balancers) */
  TRUST_PROXY?: boolean;
  /** Request body size limit */
  BODY_LIMIT?: string;
  /** Graceful shutdown timeout in seconds */
  SHUTDOWN_TIMEOUT?: number;
  /** CORS configuration (false to disable, true for defaults, or custom config) */
  CORS?: boolean | CorsConfig;
  /** Allow additional custom properties */
  [key: string]: string | number | boolean | undefined | any;
}

/**
 * Manages application configuration settings.
 * Supports loading configuration from JavaScript files and provides
 * type-safe access to configuration values.
 *
 * @example
 * ```typescript
 * const settings = new ApplicationSettings({ PORT: 3000 });
 * settings.loadFromFile('.env.js');
 * const port = settings.get<number>('PORT', 4000);
 * const isProduction = settings.isProduction();
 * ```
 */
export class ApplicationSettings {
  protected config: ApplicationConfig;
  protected logger: ConsoleLogger;

  /**
   * Creates a new ApplicationSettings instance.
   * Defaults ENV_MODE to 'production' for secure-by-default behavior.
   * This ensures stack traces are never exposed if config loading fails.
   *
   * @param config - Initial configuration object
   * @param logger - Optional logger instance for configuration loading messages
   * @throws {Error} If provided configuration fails validation
   */
  constructor(config?: ApplicationConfig, logger?: ConsoleLogger) {
    this.logger = logger || new ConsoleLogger('Settings');
    this.config = {
      ENV_MODE: 'production',
      ...(config || {}),
    };
    
    // Validate initial configuration if provided
    if (config) {
      this.validateConfig();
    }
  }

  /**
   * Loads configuration from a JavaScript file using dynamic import.
   * The file should export either a default object or a config object.
   * Silently returns if file doesn't exist.
   *
   * @param jsPath - Path to the JavaScript configuration file
   * @throws {Error} If the file exists but cannot be loaded or parsed
   *
   * @example
   * ```typescript
   * await settings.loadFromFile('.env.local.js');
   * ```
   */
  async loadFromFile(jsPath: string): Promise<void> {
    if (!jsPath) {
      return;
    }

    const resolvedPath = path.resolve(jsPath);

    if (!fs.existsSync(resolvedPath)) {
      return;
    }

    try {
      // Use dynamic import for ESM compatibility
      const fileUrl = pathToFileURL(resolvedPath).href;
      const module = await import(fileUrl);
      const config = (module?.default || module?.config || {}) as Record<string, any>;

      Object.entries(config).forEach(([key, value]) => {
        this.config[key] = value;
      });

      this.logger.info(`${path.parse(resolvedPath).base} loaded`);

      // Normalize ENV_MODE (only read from config, don't mutate process.env)
      this.config.ENV_MODE = this.config.ENV_MODE || 'production';

      // Normalize LOG_LEVEL
      let { DEBUG, LOG_LEVEL, ENV_MODE } = this.config;

      this.config.LOG_LEVEL =
        LOG_LEVEL ?? (DEBUG === true ? 'DEBUG' : ENV_MODE !== 'production' ? 'DEBUG' : 'ERROR');

      // Config is now the single source of truth - no process.env mutation

      // Validate configuration after loading
      this.validateConfig();
    } catch (error: any) {
      this.logger.error(`Failed to load configuration from ${resolvedPath}`, error);
      throw new Error(`Configuration file error: ${resolvedPath}`, { cause: error });
    }
  }

  /**
   * Validates the current configuration against the Zod schema.
   * 
   * @throws {Error} If configuration validation fails
   * @internal
   */
  protected validateConfig(): void {
    const result = configSchema.safeParse(this.config);
    if (!result.success) {
      const errors = result.error.issues.map(
        issue => `  - ${issue.path.join('.')}: ${issue.message}`
      );
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }
  }

  /**
   * Returns all configuration settings as a shallow copy.
   * This prevents direct mutations to the internal config object while
   * maintaining good performance. Note that nested objects are still
   * referenced, not cloned.
   *
   * @returns A shallow copy of the configuration object
   * @template T - Extended configuration type
   *
   * @example
   * ```typescript
   * const config = settings.getAll();
   * config.PORT = 5000; // Safe - doesn't affect internal config
   * ```
   */
  getAll<T extends ApplicationConfig>(): T {
    return { ...this.config } as T;
  }

  /**
   * Gets a configuration value by key with optional default.
   *
   * @param key - Configuration key
   * @param defaultValue - Default value if key is not set
   * @returns The configuration value or default
   * @template T - Expected value type
   *
   * @example
   * ```typescript
   * const port = settings.get<number>('PORT', 4000);
   * const debug = settings.get<boolean>('DEBUG', false);
   * const envMode = settings.get<string>('ENV_MODE', 'production');
   * ```
   */
  get<T = any>(key: keyof ApplicationConfig, defaultValue?: T): T {
    const value = this.config[key];
    return (value !== undefined ? value : defaultValue) as T;
  }

  /**
   * Checks if the application is running in production mode.
   *
   * @returns true if ENV_MODE is 'production', false otherwise
   */
  isProduction(): boolean {
    return this.config.ENV_MODE === 'production';
  }
}
