import type { NextFunction, Request, Response } from 'express';
import type { Logger, PluginDefinition } from '@blendsdk/webafx';
import { LoggerProvider } from './abstract-logger-provider.js';
import { PinoLoggerProvider } from './pino-logger-provider.js';
import { DEFAULT_PLUGIN_PRIORITY, type PinoLoggerPluginOptions } from './types.js';

// ── Express augmentation ─────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      /** Request ID set by upstream middleware (e.g., express-request-id) */
      id?: string;
      /** Request-scoped logger with bound context (e.g., requestId) */
      log?: Logger;
    }
  }
}

// ── Plugin factory options ───────────────────────────────────────────────

/**
 * Options for the createLoggerPlugin factory.
 */
export interface CreateLoggerPluginOptions {
  /**
   * Plugin priority override.
   * Lower numbers install first.
   * Default: 20 (before cache at 30, mailer at 30).
   */
  priority?: number;
}

// ── Two-step plugin factory ──────────────────────────────────────────────

/**
 * Create a WebAFX plugin definition from any LoggerProvider.
 *
 * Two-step API — construct the provider first, then wrap it in a plugin:
 *
 * ```typescript
 * const provider = new PinoLoggerProvider({ level: 'debug', pretty: true });
 * app.use(createLoggerPlugin(provider));
 * ```
 *
 * The factory performs these steps during plugin installation:
 * 1. Calls `app.setLogger(provider)` to replace ConsoleLogger
 * 2. Installs request-scoped `req.log` middleware
 * 3. Registers the provider in the service container as 'logger'
 * 4. Returns health and shutdown hooks
 *
 * @param provider - LoggerProvider instance (e.g., PinoLoggerProvider)
 * @param options - Optional plugin configuration
 * @returns A PluginDefinition for WebApplication.use()
 */
export function createLoggerPlugin(
  provider: LoggerProvider,
  options?: CreateLoggerPluginOptions,
): PluginDefinition {
  return {
    name: 'pino-logger',
    priority: options?.priority ?? DEFAULT_PLUGIN_PRIORITY,
    factory: async ({ app, express: expressApp }) => {
      // Step 1: Replace the application-level logger
      app.setLogger(provider);

      // Step 2: Install request-scoped logger middleware
      expressApp.use((req: Request, _res: Response, next: NextFunction) => {
        const bindings: Record<string, unknown> = {};
        if (req.id) {
          bindings.requestId = req.id;
        }
        req.log = provider.createRequestLogger(bindings);
        next();
      });

      // Step 3: Register provider in service container as a singleton service
      app.registerService({
        name: provider.serviceName,
        type: 'singleton',
        factory: () => provider,
      });

      // Step 4: Return lifecycle hooks
      return {
        health: () => provider.health(),
        shutdown: () => provider.shutdown(),
      };
    },
  };
}

// ── Convenience one-liner ────────────────────────────────────────────────

/**
 * Create a pino logger plugin in a single call.
 *
 * Convenience function that constructs a PinoLoggerProvider and wraps it
 * in a plugin definition. For most applications, this is all you need:
 *
 * ```typescript
 * import { pinoLoggerPlugin } from '@blendsdk/webafx-pino';
 *
 * const app = new WebApplication();
 * app.use(pinoLoggerPlugin({ level: 'debug', pretty: true }));
 * ```
 *
 * @param options - Combined provider and plugin options
 * @returns A PluginDefinition for WebApplication.use()
 */
export function pinoLoggerPlugin(options?: PinoLoggerPluginOptions): PluginDefinition {
  const provider = new PinoLoggerProvider(options);
  return createLoggerPlugin(provider, { priority: options?.priority });
}
