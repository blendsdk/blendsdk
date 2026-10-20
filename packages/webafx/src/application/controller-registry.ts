import { ApplicationSettings } from './application-settings.js';
import { ServiceContainer } from './service-container.js';

/**
 * Controller definition for registering controllers with WebApplication.
 */
export interface ControllerDefinition {
  /** Base URL path for all controller routes */
  basePath: string;
  /** Controller class constructor */
  ControllerClass: new (settings: ApplicationSettings, services: ServiceContainer) => any;
}

/**
 * Registry for managing application controllers.
 *
 * @internal
 */
export class ControllerRegistry {
  protected controllers: ControllerDefinition[];
  constructor() {
    this.controllers = [];
  }

  /**
   * Gets all registered controllers.
   *
   * @returns Array of controller definitions
   */
  getAll() {
    return this.controllers;
  }

  /**
   * Registers a controller with a base path.
   *
   * @param basePath - Base URL path for all controller routes
   * @param ControllerClass - Controller class constructor
   */
  register(basePath: string, ControllerClass: new (settings: ApplicationSettings, services: ServiceContainer) => any) {
    this.controllers.push({
      basePath,
      ControllerClass,
    });
  }
}
