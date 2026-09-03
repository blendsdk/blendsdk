import { Express } from 'express';
import { ConsoleLogger } from './console-logger.js';
import { Logger } from './type.js';
import { WebApplication } from './web-application.js';

/**
 * Parameters passed to a plugin's optional {@link Plugin.terminal} hook.
 *
 * Mirrors the {@link PluginDefinition.factory} parameter shape so terminal
 * hooks have a consistent API and access to a scoped logger.
 */
export interface PluginTerminalParams {
  /** The owning WebApplication instance */
  app: WebApplication;
  /** The underlying Express application instance */
  express: Express;
  /** A logger scoped to the plugin */
  logger: Logger;
}

/**
 * Plugin interface for extending WebApplication functionality.
 * Plugins can provide health checks and cleanup on shutdown.
 */
export interface Plugin {
  /** Optional health check function */
  health?: () => Promise<boolean>;
  /** Optional cleanup function called on application shutdown */
  shutdown?: () => Promise<void>;
  /**
   * Optional terminal hook — mounts middleware AFTER controllers and the
   * `/health` route, but BEFORE the 404 handler.
   *
   * Use this for catch-all / fallback middleware (e.g. an SPA `index.html`
   * fallback) that must NOT shadow controller routes. Middleware mounted in
   * the factory runs BEFORE controllers and can therefore swallow controller
   * routes; the terminal phase exists precisely to avoid that.
   *
   * Multiple terminal hooks run in plugin priority order (lower priority
   * value first), identical to the install order.
   *
   * @param params - {@link PluginTerminalParams} (app, express, logger)
   */
  terminal?: (params: PluginTerminalParams) => void | Promise<void>;
}


/**
 * Plugin definition for registering plugins with WebApplication.
 */
export interface PluginDefinition {
  /** Unique plugin name */
  name: string;
  /** Factory function that creates and initializes the plugin */
  factory: (params: {
    app: WebApplication;
    express: Express;
    logger: Logger;
  }) => Promise<Plugin | void>;
  /** Plugin priority. Lower numbers install first. Default: 100 */
  priority?: number;
}

/**
 * Registry for managing application plugins.
 * Handles plugin installation, health checks, and shutdown.
 *
 * @internal
 */
export class PluginRegistry {
  protected registry: Record<string, PluginDefinition>;
  protected _shutdown: { shutdown: () => Promise<void>; name: string }[];
  protected _health: { health: () => Promise<boolean>; name: string }[];
  /**
   * Collected terminal hooks, in priority order (lower first).
   * Populated during {@link PluginRegistry.install} and run by
   * {@link PluginRegistry.installTerminals}.
   */
  protected _terminals: {
    terminal: NonNullable<Plugin['terminal']>;
    name: string;
  }[];

  protected logger: ConsoleLogger;
  constructor() {
    this.registry = {};
    this._shutdown = [];
    this._health = [];
    this._terminals = [];
    this.logger = new ConsoleLogger('Plugins');
  }


  /**
   * Installs all registered plugins.
   * Plugins are installed in priority order (lower priority values first).
   *
   * @param app - WebApplication instance
   * @param express - Express application instance
   */
  async install(app: WebApplication, express: Express) {
    // Sort plugins by priority (lower numbers first)
    const items = Object.values(this.registry).sort(
      (a, b) => (a.priority ?? 100) - (b.priority ?? 100)
    );

    for (const item of items) {
      const plugin = (await item.factory({
        app,
        express,
        logger: new ConsoleLogger(`Plugin:${item.name}`),
      })) as Plugin;
      if (plugin?.shutdown) {
        this._shutdown.push({
          name: item.name,
          shutdown: plugin.shutdown,
        });
      }
      if (plugin?.health) {
        this._health.push({
          name: item.name,
          health: plugin.health,
        });
      }
      // Collect the optional terminal hook. Because `items` is already sorted
      // by priority, `_terminals` ends up in priority order (lower first).
      if (plugin?.terminal) {
        this._terminals.push({
          name: item.name,
          terminal: plugin.terminal,
        });
      }
      await this.logger.info(`Plugin ${item.name} installed.`);
    }
  }

  /**
   * Runs all collected terminal hooks in priority order (lower first).
   *
   * Called by {@link WebApplication} AFTER controllers and the `/health`
   * route are registered, but BEFORE the 404 handler — so terminal middleware
   * (e.g. an SPA fallback) cannot shadow controller routes yet can still serve
   * genuinely unmatched routes before the request falls through to 404.
   *
   * @param app - WebApplication instance
   * @param express - Express application instance
   */
  async installTerminals(app: WebApplication, express: Express) {
    for (const item of this._terminals) {
      await item.terminal({
        app,
        express,
        logger: new ConsoleLogger(`Plugin:${item.name}`),
      });
      await this.logger.info(`Plugin ${item.name} terminal installed.`);
    }
  }


  /**
   * Checks health status of all plugins.
   *
   * @returns True if all plugins are healthy, false otherwise
   */
  async health() {
    // If no health checks registered, consider system healthy
    if (this._health.length === 0) {
      return true;
    }

    let count = 0;
    for (const item of this._health) {
      const healthy = await item.health();
      if (!healthy) {
        await this.logger.debug(`${item.name} plugin is not healthy`);
      } else {
        count += 1;
      }      
    }
    return count === this._health.length;
  }

  /**
   * Shuts down all plugins in order.
   */
  async shutdown() {
    for (const item of this._shutdown) {
      await this.logger.info(`Shutting down ${item.name} plugin.`);
      await item.shutdown();
    }
  }

  /**
   * Registers a plugin definition.
   *
   * @param def - Plugin definition to register
   */
  register(def: PluginDefinition) {
    this.registry[def.name] = def;
  }
}
