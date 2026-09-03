import { NextFunction, Request, Response } from 'express';
import { ApplicationSettings } from './application-settings.js';

/**
 * Factory function for creating singleton services.
 * Called once during application startup and the result is cached.
 *
 * @template T - The type of service this factory creates
 */
export type SingletonFactory<T = unknown> = (
  container: ServiceContainer,
  settings: ApplicationSettings
) => T | Promise<T>;

/**
 * Factory function for creating per-request services.
 * Called for each HTTP request with the full request context.
 * The req, res, and next parameters are always provided during
 * request handling — they are required, not optional.
 *
 * @template T - The type of service this factory creates
 */
export type PerRequestFactory<T = unknown> = (
  container: ServiceContainer,
  settings: ApplicationSettings,
  req: Request,
  res: Response,
  next: NextFunction
) => T | Promise<T>;

/**
 * Service definition for dependency injection container.
 *
 * @template T - The type of service this definition creates
 */
export interface ServiceDefinition<T = unknown> {
  name: string;
  factory: SingletonFactory<T> | PerRequestFactory<T>;
  type: 'singleton' | 'per-request';
  dependencies?: string[];
  /** Optional cleanup function called on application shutdown */
  dispose?: (instance: T) => void | Promise<void>;
}

/**
 * Service registry containing service definitions and singleton instances.
 * Each WebApplication instance owns its own registry to prevent state leakage.
 */
export interface ServiceRegistry {
  /** Service definitions (blueprints) */
  definitions: Record<string, ServiceDefinition>;
  /** Cached singleton instances */
  singletons: Record<string, unknown>;
}

/**
 * Dependency injection container for managing service lifecycle.
 * Supports both singleton (application-scoped) and per-request services.
 *
 * @remarks
 * Each ServiceContainer instance is tied to a ServiceRegistry owned by a
 * WebApplication instance. This eliminates global state and ensures proper
 * isolation between application instances and test runs.
 */
export class ServiceContainer {
  protected registry: ServiceRegistry;
  protected settings: ApplicationSettings;
  protected request: Request | undefined;
  protected response: Response | undefined;
  protected next: NextFunction | undefined;
  protected services: Record<string, unknown>;
  protected resolvingServices: Set<string>;

  /**
   * Creates a new ServiceContainer instance.
   *
   * @param registry - Service registry containing definitions and singletons
   * @param settings - Application settings
   * @param req - Optional Express request (for per-request services)
   * @param res - Optional Express response (for per-request services)
   * @param next - Optional Express next function (for per-request services)
   */
  constructor(
    registry: ServiceRegistry,
    settings: ApplicationSettings,
    req?: Request,
    res?: Response,
    next?: NextFunction
  ) {
    this.registry = registry;
    this.settings = settings;
    this.request = req;
    this.response = res;
    this.next = next;
    // Pre-populate with existing singletons from registry
    this.services = { ...registry.singletons };
    this.resolvingServices = new Set();
  }

  /**
   * Get the authenticated user from the service container.
   * @returns The user object or undefined if not authenticated
   */
  getUser<T = unknown>(): T | undefined {
    return this.services['user'] as T | undefined;
  }

  /**
   * Get validated request parameters (merged from params, query, and body).
   * @returns The validated parameters object
   */
  getParams<T = unknown>(): T {
    return (this.services['request-params'] || {}) as T;
  }

  /**
   * Get separated request input sources (params, query, body).
   * Provides type-safe access to individual input sources without merging.
   *
   * @returns Object with separated params, query, and body
   *
   * @example
   * ```typescript
   * const input = req.services.getInput<{
   *   params: { id: string };
   *   query: { sort: string };
   *   body: { name: string };
   * }>();
   * console.log(input.params.id);
   * console.log(input.query.sort);
   * console.log(input.body.name);
   * ```
   */
  getInput<
    T = {
      params: Record<string, unknown>;
      query: Record<string, unknown>;
      body: Record<string, unknown>;
    }
  >(): T {
    return (this.services['request-input'] || { params: {}, query: {}, body: {} }) as T;
  }

  /**
   * Manually set a service instance in the container.
   * @param name - Service name
   * @param service - Service instance
   */
  set(name: string, service: unknown): void {
    this.services[name] = service;
  }

  /**
   * Resolve and return a service instance.
   * Handles dependency resolution and lifecycle management.
   * @param name - Service name
   * @param defaultValue - Optional default value if service not found
   * @returns The resolved service instance
   * @throws Error if service not registered and no default provided
   * @throws Error if circular dependency detected
   * @throws Error if per-request service accessed outside request context
   */
  async get<T = unknown>(name: string, defaultValue?: T): Promise<T> {
    // Return already resolved service
    if (this.services[name] !== undefined) {
      return this.services[name] as T;
    }

    // Check if service is registered in this instance's registry
    const serviceDef = this.registry.definitions[name];
    if (!serviceDef) {
      if (arguments.length > 1) {
        return defaultValue as T;
      }
      throw new Error(`Service "${name}" is not registered`);
    }

    // Detect circular dependencies
    if (this.resolvingServices.has(name)) {
      const chain = Array.from(this.resolvingServices).join(' -> ');
      throw new Error(`Circular dependency detected: ${chain} -> ${name}`);
    }

    // Mark service as being resolved
    this.resolvingServices.add(name);

    try {
      // Resolve dependencies first
      const dependencies = serviceDef.dependencies || [];
      for (const depName of dependencies) {
        await this.get(depName);
      }

      // Create service instance
      let instance: unknown;
      if (serviceDef.type === 'singleton') {
        // Check if singleton already exists in registry
        if (this.registry.singletons[name] !== undefined) {
          instance = this.registry.singletons[name];
        } else {
          // Safe to cast: we've verified type === 'singleton' so factory is SingletonFactory
          const factory = serviceDef.factory as SingletonFactory;
          instance = await factory(this, this.settings);
          // Cache in registry for reuse across all containers
          this.registry.singletons[name] = instance;
        }
        this.services[name] = instance;
      } else {
        // Per-request service — requires request context
        if (!this.request || !this.response || !this.next) {
          throw new Error(
            `Service "${name}" is per-request and can only be accessed during HTTP request handling`
          );
        }
        // Safe to cast: we've verified type === 'per-request' so factory is PerRequestFactory
        const factory = serviceDef.factory as PerRequestFactory;
        instance = await factory(this, this.settings, this.request, this.response, this.next);
        this.services[name] = instance;
      }

      return instance as T;
    } finally {
      // Remove from resolving set
      this.resolvingServices.delete(name);
    }
  }

  /**
   * Register a service definition in this instance's registry.
   * @param service - Service definition to register
   */
  registerService(service: ServiceDefinition): void {
    this.registry.definitions[service.name] = service;
  }

  /**
   * Check if a service is registered in this instance's registry.
   * @param name - Service name
   * @returns True if service is registered
   */
  isRegistered(name: string): boolean {
    return this.registry.definitions[name] !== undefined;
  }

  /**
   * Get all registered service names from this instance's registry.
   * @returns Array of service names
   */
  getRegisteredServices(): string[] {
    return Object.keys(this.registry.definitions);
  }

  /**
   * Dispose all singleton services in the registry.
   * Calls the optional dispose function for each singleton if provided.
   * Typically called during application shutdown.
   *
   * @returns Promise that resolves when all disposals complete
   */
  async disposeAll(): Promise<void> {
    const disposals: Promise<void>[] = [];

    for (const [name, instance] of Object.entries(this.registry.singletons)) {
      const def = this.registry.definitions[name];
      if (def?.dispose) {
        disposals.push(Promise.resolve(def.dispose(instance)));
      }
    }

    // Wait for all disposals to complete
    await Promise.all(disposals);

    // Clear singletons after disposal
    Object.keys(this.registry.singletons).forEach(key => delete this.registry.singletons[key]);
  }
}
