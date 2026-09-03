import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import helmet from 'helmet';
import { Server } from 'node:http';
import path from 'node:path';
import { ZodType } from 'zod';
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '../errors/http-errors.js';
import { ApplicationConfig, ApplicationSettings, CorsConfig } from './application-settings.js';
import { ConsoleLogger, LogLevel } from './console-logger.js';
import type { Logger } from './type.js';
import { ControllerRegistry } from './controller-registry.js';
import { errorHandlerMiddleware } from './error-handler-middleware.js';
import { PluginDefinition, PluginRegistry } from './plugin.js';
import { requestIdMiddleware } from './request-id-middleware.js';
import { RouteDefinition } from './route-builder.js';
import {
  ServiceContainer,
  ServiceDefinition,
  ServiceRegistry,
} from './service-container.js';

/**
 * Lifecycle hook function type.
 * Hooks can be synchronous or asynchronous.
 */
export type LifecycleHook = () => void | Promise<void>;

/**
 * Main application class for building Express-based web applications.
 * Provides a structured framework with dependency injection, routing, plugins,
 * middleware, and error handling.
 *
 * @remarks
 * WebApplication manages the complete lifecycle of an Express application including:
 * - Configuration management via ApplicationSettings
 * - Dependency injection via ServiceContainer
 * - Plugin system for extensibility
 * - Controller-based routing
 * - Built-in middleware (CORS, body parsing, request ID, error handling)
 * - Graceful shutdown handling
 */
export class WebApplication {
  protected settings: ApplicationSettings;
  protected expressApp: Express;
  protected server: Server<any> | undefined;
  protected started: boolean;
  protected serviceRegistry: ServiceRegistry;
  protected services: ServiceContainer;
  protected plugins: PluginRegistry;
  protected controllers: ControllerRegistry;
  protected logger: Logger;
  protected lifecycleHooks: {
    beforeStart: LifecycleHook[];
    afterStart: LifecycleHook[];
    beforeShutdown: LifecycleHook[];
    afterShutdown: LifecycleHook[];
  };
  protected signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }>;

  /**
   * Creates a new WebApplication instance.
   *
   * @param config - Optional application configuration
   */
  constructor(config?: ApplicationConfig) {
    this.settings = new ApplicationSettings(config);
    this.expressApp = express();
    this.started = false;
    // Create service registry owned by this application instance
    this.serviceRegistry = { definitions: {}, singletons: {} };
    this.services = new ServiceContainer(this.serviceRegistry, this.getSettings());
    this.plugins = new PluginRegistry();
    this.controllers = new ControllerRegistry();
    // Pass log level from settings to logger constructor
    const logLevel = this.settings.get<LogLevel>('LOG_LEVEL', 'ERROR');
    this.logger = new ConsoleLogger('APP', logLevel);
    // Initialize lifecycle hooks
    this.lifecycleHooks = {
      beforeStart: [],
      afterStart: [],
      beforeShutdown: [],
      afterShutdown: [],
    };
    this.signalHandlers = [];
  }

  /**
   * Registers a lifecycle hook.
   *
   * @param event - The lifecycle event to hook into
   * @param hook - The hook function to execute
   * @returns This application instance for method chaining
   *
   * @example
   * ```typescript
   * app
   *   .on('beforeStart', async () => {
   *     await initializeDatabase();
   *   })
   *   .on('afterStart', () => {
   *     console.log('Server is ready!');
   *   });
   * ```
   */
  on(event: keyof typeof this.lifecycleHooks, hook: LifecycleHook): this {
    this.lifecycleHooks[event].push(hook);
    return this;
  }

  /**
   * Runs all hooks registered for a specific lifecycle event.
   *
   * @param event - The lifecycle event to run hooks for
   * @internal
   */
  protected async runHooks(event: keyof typeof this.lifecycleHooks): Promise<void> {
    for (const hook of this.lifecycleHooks[event]) {
      await hook();
    }
  }

  /**
   * Registers a service in the dependency injection container.
   *
   * @param service - Service definition to register
   * @returns This application instance for method chaining
   */
  registerService(service: ServiceDefinition) {
    this.services.registerService(service);
    return this;
  }

  /**
   * Gets all application settings.
   *
   * @returns Application settings object
   * @template T - Extended ApplicationSettings type
   */
  getSettings<T extends ApplicationSettings>() {
    return this.settings.getAll<T>() as T;
  }

  /**
   * Loads configuration from .env.js and .env.local.js files in the current working directory.
   *
   * @internal
   */
  protected async loadConfiguration(): Promise<void> {
    const configFiles = [
      path.join(process.cwd(), '.env.js'),
      path.join(process.cwd(), '.env.local.js'),
    ];
    
    for (const f of configFiles) {
      await this.settings.loadFromFile(f);
    }
  }

  /**
   * Sets up core Express middleware including trust proxy, CORS, body parsers,
   * request ID, and security headers.
   *
   * @internal
   */
  protected async setupCoreMiddleware() {
    // Trust proxy (required for nginx, load balancers)
    // Enables proper IP detection, secure cookies, etc.
    const { TRUST_PROXY = true, ENV_MODE, BODY_LIMIT = '10mb', CORS } = this.settings.getAll();
    if (TRUST_PROXY) {
      this.expressApp.set('trust proxy', 1);
      await this.logger.info('Setting trust proxy to true');
    }

    this.expressApp.set('x-powered-by', false);

    await this.logger.info(`Setting ENV to ${ENV_MODE}`);
    this.expressApp.set('env', ENV_MODE);

    // CORS middleware (if enabled)
    if (CORS !== false && CORS !== undefined) {
      const corsOptions = this.buildCorsOptions(CORS);
      this.expressApp.use(cors(corsOptions));
      await this.logger.info('CORS is enabled');
    }

    this.expressApp.use(cookieParser());

    // Body parsers with configurable size limits

    this.expressApp.use(express.json({ limit: BODY_LIMIT }));
    this.expressApp.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));
    await this.logger.info(`Request BODY_LIMIT is set to ${BODY_LIMIT}`);

    this.expressApp.use(requestIdMiddleware());

    // Request timing middleware - logs request duration after response completes
    this.expressApp.use((req: Request, res: Response, next: NextFunction) => {
      const start = Date.now();

      // Log after response finishes
      res.on('finish', () => {
        const duration = Date.now() - start;
        this.logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`, {
          method: req.method,
          url: req.originalUrl,
          statusCode: res.statusCode,
          duration,
          requestId: req.id,
        });
      });

      next();
    });

    // Security headers via helmet (comprehensive, production-ready)
    // Disable CSP and COEP to allow applications to configure them as needed
    this.expressApp.use(
      helmet({
        contentSecurityPolicy: false, // Let apps configure CSP themselves
        crossOriginEmbedderPolicy: false, // May break APIs and embedded resources
      })
    );
    await this.logger.info('Security headers enabled via helmet');
  }

  /**
   * Builds CORS options for the cors package from WebAFX CORS configuration.
   *
   * @param config - CORS configuration (true for defaults or custom config object)
   * @returns Options object compatible with the cors package
   * @internal
   */
  protected buildCorsOptions(config: true | CorsConfig): cors.CorsOptions {
    if (config === true) {
      // Sensible defaults: allow all origins with wildcard
      return {
        origin: '*', // Wildcard - returns '*' in Access-Control-Allow-Origin header
        credentials: true,
        optionsSuccessStatus: 204, // Respond with 204 for OPTIONS preflight
        preflightContinue: false, // Let cors handle OPTIONS
      };
    }

    // Map WebAFX CorsConfig to cors.CorsOptions
    // Only include properties that are actually defined to avoid passing undefined to cors package
    const corsOptions: cors.CorsOptions = {
      optionsSuccessStatus: 204, // Respond with 204 for OPTIONS preflight
      preflightContinue: false, // Let cors handle OPTIONS
    };

    // Handle origin configuration
    if (config.origin !== undefined) {
      // The cors package behavior with strings is to set them directly without validation
      // We need to convert single strings to validation functions for proper origin checking
      if (typeof config.origin === 'string') {
        const allowedOrigin = config.origin;
        corsOptions.origin = (requestOrigin, callback) => {
          // Allow if request origin matches the configured origin
          if (requestOrigin === allowedOrigin) {
            callback(null, true);
          } else {
            callback(null, false);
          }
        };
      } else {
        // Arrays and functions can be passed through directly
        corsOptions.origin = config.origin;
      }
    } else {
      // If no origin specified in config, default to wildcard (allow all)
      corsOptions.origin = '*';
    }

    if (config.methods !== undefined) {
      corsOptions.methods = config.methods;
    }

    if (config.allowedHeaders !== undefined) {
      corsOptions.allowedHeaders = config.allowedHeaders;
    }

    if (config.exposedHeaders !== undefined) {
      corsOptions.exposedHeaders = config.exposedHeaders;
    }

    if (config.credentials !== undefined) {
      corsOptions.credentials = config.credentials;
    }

    if (config.maxAge !== undefined) {
      corsOptions.maxAge = config.maxAge;
    }

    return corsOptions;
  }

  /**
   * Sets up global error handling middleware.
   *
   * @internal
   */
  protected setupErrorHandling(): void {
    this.expressApp.use(
      errorHandlerMiddleware(async (req: Request, err: Error, data: Record<any, string>) => {
        const logger = await req.services.get('logger', this.logger);
        await logger.error(data.error, data);
      }, !this.settings.isProduction())
    );
  }

  /**
   * Attaches the service container to each request.
   *
   * @internal
   */
  protected setupServiceContainer() {
    this.expressApp.use((req: Request, res: Response, next: NextFunction) => {
      // Create per-request container with shared registry
      req.services = new ServiceContainer(this.serviceRegistry, this.getSettings(), req, res, next);
      next();
    });
  }

  /**
   * Validates request data against a Zod schema.
   *
   * @param schema - Zod validation schema
   * @param merged - Merged request data (params, query, body)
   * @returns Validated data
   * @throws {ValidationError} If validation fails
   * @internal
   */
  protected async validateRequest(
    schema: ZodType,
    merged: Record<string, unknown>
  ): Promise<unknown> {
    try {
      // Note: Zod schemas should be defined with .strip() if you want to remove unknown properties
      // Calling strip() here has no effect on already-created schemas
      return await schema.parseAsync(merged);
    } catch (error: unknown) {
      // Zod errors have 'issues' property, format them for the response
      const zodError = error as {
        issues?: Array<{ path: (string | number)[]; message: string; code: string }>;
      };
      const formattedErrors =
        zodError.issues?.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })) || [];
      await this.logger.debug(`[ERROR]`, formattedErrors);
      throw new ValidationError('Validation failed', formattedErrors);
    }
  }

  /**
   * Wraps a route handler with authentication, authorization, and validation logic.
   *
   * @param controller - Controller instance
   * @param route - Route definition
   * @returns Express request handler
   * @internal
   */
  protected wrapRouteHandler(controller: unknown, route: RouteDefinition): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        // 1. Check authentication - resolve user service if secure route
        if (route.secure) {
          const user = await req.services.get('user', undefined);
          if (!user) {
            throw new UnauthorizedError('Authentication required');
          }
        }

        // 2. Check authorization
        if (route.authorize) {
          const user = await req.services.get('user', undefined);
          const authorized = await route.authorize(req, user);
          if (!authorized) {
            throw new ForbiddenError('Access denied');
          }
        }

        // Separate input sources for type-safe access
        const requestInput = {
          params: req.params || {},
          query: req.query || {},
          body: req.body || {},
        };

        // Merged parameters for validation (backward compatible)
        let parameters = {
          ...requestInput.params,
          ...requestInput.query,
          ...requestInput.body,
        };

        // 3. Validate request
        if (route.validation) {
          parameters = await this.validateRequest(route.validation, parameters);
        }

        // Store both merged and separated input
        req.services.set('request-params', parameters);
        req.services.set('request-input', requestInput);

        // 4. Call controller method
        await route.handler.call(controller, req, res, next);
      } catch (error) {
        next(error);
      }
    };
  }

  /**
   * Registers all controllers and their routes with Express.
   * Logs per-controller route count and a final total for clarity.
   *
   * @internal
   */
  protected async setupControllers(): Promise<void> {
    const controllers = this.controllers.getAll();
    let totalRouteCount = 0;

    for (const { basePath, ControllerClass } of controllers) {
      const router = express.Router();

      // Create controller instance with settings and services
      const controller = new ControllerClass(this.settings, this.services);

      // Get routes from controller
      const routes = controller.routes() as RouteDefinition[];

      // Register each route
      for (const route of routes) {
        const handler = this.wrapRouteHandler(controller, route);
        
        // Combine route-level middleware with the handler
        const handlers: RequestHandler[] = [
          ...(route.middleware || []),
          handler,
        ];
        
        // Type-safe route registration with middleware support
        switch (route.method) {
          case 'get':
            router.get(route.path, ...handlers);
            break;
          case 'post':
            router.post(route.path, ...handlers);
            break;
          case 'put':
            router.put(route.path, ...handlers);
            break;
          case 'patch':
            router.patch(route.path, ...handlers);
            break;
          case 'delete':
            router.delete(route.path, ...handlers);
            break;
        }
        this.logger.debug(
          `Routing ${basePath}/${route.path} through ${route.method}->${ControllerClass.name}->${route.handler.name}`
            .replace(/\/\//g, '/')
            .replace(/\/\//g, '/')
        );
      }

      // Log per-controller route count for debugging
      const controllerRouteCount = routes.length;
      totalRouteCount += controllerRouteCount;
      this.logger.info(
        `${controllerRouteCount} route${controllerRouteCount !== 1 ? 's' : ''} registered for ${ControllerClass.name}.`
      );
      this.expressApp.use(basePath, router);
    }

    // Log total across all controllers
    if (controllers.length > 0) {
      this.logger.info(
        `Total: ${totalRouteCount} route${totalRouteCount !== 1 ? 's' : ''} registered.`
      );
    }
  }

  /**
   * Installs all registered plugins.
   *
   * @internal
   */
  protected async setupPlugins() {
    await this.plugins.install(this, this.expressApp);
  }

  /**
   * Runs the terminal plugin phase.
   *
   * Mounts each plugin's optional `terminal` hook (in priority order) AFTER
   * controllers and the `/health` route, but BEFORE the 404 handler. This lets
   * plugins register catch-all / fallback middleware (e.g. the SPA index.html
   * fallback) that must not shadow controller routes.
   *
   * @internal
   */
  protected async setupPluginTerminals() {
    await this.plugins.installTerminals(this, this.expressApp);
  }


  /**
   * Initializes the application by setting up middleware, plugins, controllers, and error handling.
   *
   * @internal
   */
  protected async initialize() {
    await this.loadConfiguration();
    await this.runHooks('beforeStart');
    await this.setupCoreMiddleware();
    this.setupServiceContainer();
    await this.setupPlugins();
    await this.setupControllers();
    this.setupHealth();
    // Terminal plugin phase: catch-all middleware (e.g. SPA fallback) mounted
    // AFTER controllers and /health, but BEFORE the 404 handler, so it cannot
    // shadow controller routes.
    await this.setupPluginTerminals();
    this.setup404Handler();
    this.setupErrorHandling();
  }

  /**
   * Registers a plugin with the application.
   *
   * @param plugin - Plugin definition
   * @returns This application instance for method chaining
   */
  use(plugin: PluginDefinition) {
    this.plugins.register(plugin);
    return this;
  }

  /**
   * Replace the application logger.
   *
   * Called by logger plugins (e.g., webafx-pino) during plugin installation
   * to replace the default ConsoleLogger with a structured logging backend.
   *
   * Messages logged before this method is called (during constructor and
   * early initialization) will still go through the original ConsoleLogger.
   *
   * @param logger - New Logger implementation to use
   */
  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  /**
   * Registers a controller with a base path.
   *
   * @param basePath - Base URL path for all controller routes
   * @param ControllerClass - Controller class constructor
   */
  registerController(
    basePath: string,
    ControllerClass: new (settings: ApplicationSettings, services: ServiceContainer) => any
  ) {
    this.controllers.register(basePath, ControllerClass);
  }

  /**
   * Performs graceful shutdown of the application and all plugins.
   * Disposes all singleton services before shutting down plugins.
   *
   * @internal
   */
  protected async shutdown() {
    if (this.started) {
      this.started = false;
      await this.runHooks('beforeShutdown');
      // Dispose services before plugin shutdown
      await this.services.disposeAll();
      await this.plugins.shutdown();
      await this.runHooks('afterShutdown');
    }
  }

  /**
   * Sets up the /health endpoint for health checks.
   *
   * @internal
   */
  protected setupHealth() {
    this.expressApp.get('/health', async (req, res) => {
      const health = await this.plugins.health();
      res.status(health ? 200 : 503).json({
        health,
        timestamp: Date.now(),
      });
    });
  }

  /**
   * Sets up 404 catch-all handler for unknown routes.
   * Must be called after setupControllers() but before setupErrorHandling().
   *
   * @internal
   */
  protected setup404Handler() {
    this.expressApp.use((req, res, next) => {
      next(new NotFoundError(`Cannot ${req.method} ${req.path}`));
    });
  }

  /**
   * Access the underlying Express application instance.
   * Use this for features not directly exposed by WebApplication,
   * such as static file serving, view engines, or WebSocket integration.
   *
   * @returns The Express application instance
   *
   * @example
   * ```typescript
   * const app = new WebApplication();
   * // Add static file serving
   * app.express.use(express.static('public'));
   * ```
   */
  get express(): Express {
    return this.expressApp;
  }

  /**
   * Sets up signal handlers (SIGTERM, SIGINT) for graceful shutdown.
   *
   * @param shutdown - The shutdown function to call when signal is received
   * @internal
   */
  protected setupSignalHandlers(shutdown: () => Promise<void>): void {
    const createHandler = (signal: NodeJS.Signals) => {
      const handler = () => {
        shutdown();
      };
      process.on(signal, handler);
      this.signalHandlers.push({ signal, handler });
    };

    createHandler('SIGTERM');
    createHandler('SIGINT');
  }

  /**
   * Cleans up registered signal handlers.
   * This prevents memory leaks and duplicate handler execution.
   *
   * @internal
   */
  protected cleanupSignalHandlers(): void {
    for (const { signal, handler } of this.signalHandlers) {
      process.removeListener(signal, handler);
    }
    this.signalHandlers = [];
  }

  /**
   * Creates a shutdown function for graceful application termination.
   *
   * @param server - The HTTP server instance
   * @param shutdownDelay - Maximum time to wait before forcing shutdown (milliseconds)
   * @returns Shutdown function that performs graceful shutdown
   * @internal
   */
  protected createShutdownFn(server: Server, shutdownDelay: number): () => Promise<void> {
    let shuttingDown = false;

    return async () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;

      await this.logger.info(
        `Shutting down gracefully (timeout: ${shutdownDelay / 1000}s)...`
      );

      // Stop accepting new connections and wait for completion
      await new Promise<void>((resolve) => {
        server.close(async () => {
          await this.shutdown();
          await this.logger.info('Shutdown complete.');
          resolve();
        });

        // Force-close connections after timeout
        setTimeout(() => {
          server.closeIdleConnections();
          server.closeAllConnections();
        }, shutdownDelay);
      });

      // Clean up signal handlers to prevent duplicate calls
      this.cleanupSignalHandlers();
    };
  }

  /**
   * Starts the web server and begins listening for requests.
   * Sets up graceful shutdown handlers for SIGTERM and SIGINT signals.
   *
   * @returns Promise that resolves to a shutdown function that performs graceful shutdown
   * @throws {Error} If application is already started
   *
   * @example
   * ```typescript
   * const app = new WebApplication({ PORT: 3000 });
   * const shutdown = await app.start();
   *
   * // Later, to shutdown:
   * await shutdown();
   * ```
   */
  async start(): Promise<() => Promise<void>> {
    if (this.started) {
      throw new Error('Application already started');
    }

    const { PORT = 4000, SHUTDOWN_TIMEOUT = 7, ENV_MODE } = this.settings.getAll();
    const shutdownDelay = this.settings.isProduction() ? SHUTDOWN_TIMEOUT * 1000 : 1000;

    await this.initialize();

    return new Promise((resolve, reject) => {
      const server = this.expressApp.listen(PORT, async (err?: Error) => {
        if (err) {
          return reject(err);
        }

        this.server = server;
        this.started = true;

        await this.logger.info(`Server listening on http://localhost:${PORT} (${ENV_MODE})`);
        await this.runHooks('afterStart');

        const shutdown = this.createShutdownFn(server, shutdownDelay);
        this.setupSignalHandlers(shutdown);
        resolve(shutdown);
      });
    });
  }
}
