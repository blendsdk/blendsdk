/**
 * Specification tests for duplicate plugin and service registration.
 *
 * A second registration with the same name must fail immediately with a clear
 * error, instead of silently overwriting the first. Intentional instance
 * replacement stays available through `ServiceContainer.set`.
 *
 * @packageDocumentation
 */

import { describe, it, expect } from 'vitest';

import { PluginRegistry } from '../src/application/plugin.js';
import type { PluginDefinition } from '../src/application/plugin.js';
import { ServiceContainer } from '../src/application/service-container.js';
import type { ServiceDefinition, ServiceRegistry } from '../src/application/service-container.js';
import { ApplicationSettings } from '../src/application/application-settings.js';
import { WebApplication } from '../src/application/web-application.js';
import { staticFilesPlugin } from '../src/application/static-files-plugin.js';

/** Minimal plugin definition with the given name. */
function plugin(name: string): PluginDefinition {
  return { name, factory: async () => ({ health: async () => true }) };
}

/** Minimal singleton service definition with the given name. */
function service(name: string): ServiceDefinition {
  return { name, type: 'singleton', factory: () => ({ ok: true }) };
}

/** A fresh, empty service container (one per test), mirroring WebApplication. */
function freshContainer(): ServiceContainer {
  const registry: ServiceRegistry = {
    definitions: Object.create(null) as Record<string, ServiceDefinition>,
    singletons: Object.create(null) as Record<string, unknown>,
  };
  return new ServiceContainer(registry, new ApplicationSettings());
}

describe('Registration collisions — Specification Tests', () => {
  it('rejects a second plugin with the same name', () => {
    const registry = new PluginRegistry();
    registry.register(plugin('duplicate'));

    expect(() => registry.register(plugin('duplicate'))).toThrow(
      'Plugin "duplicate" is already registered'
    );
  });

  it('rejects a second service with the same name', () => {
    const container = freshContainer();
    container.registerService(service('duplicate'));

    expect(() => container.registerService(service('duplicate'))).toThrow(
      'Service "duplicate" is already registered'
    );
  });

  it('accepts a single plugin registration', () => {
    const registry = new PluginRegistry();

    expect(() => registry.register(plugin('solo'))).not.toThrow();
  });

  it('accepts and resolves a single service registration', async () => {
    const container = freshContainer();

    container.registerService(service('solo'));

    await expect(container.get('solo')).resolves.toEqual({ ok: true });
  });

  it('accepts plugins and services with distinct names', async () => {
    const registry = new PluginRegistry();
    const container = freshContainer();

    registry.register(plugin('plugin-a'));
    registry.register(plugin('plugin-b'));
    container.registerService(service('service-a'));
    container.registerService(service('service-b'));

    await expect(container.get('service-a')).resolves.toEqual({ ok: true });
    await expect(container.get('service-b')).resolves.toEqual({ ok: true });
  });

  it('still allows set() to override a resolved service instance', async () => {
    const container = freshContainer();
    container.registerService(service('cache'));
    await container.get('cache');

    const override = { ok: false };
    container.set('cache', override);

    await expect(container.get('cache')).resolves.toBe(override);
  });

  it('accepts an inherited-property name without a false positive', async () => {
    const registry = new PluginRegistry();
    const container = freshContainer();

    registry.register(plugin('constructor'));
    container.registerService(service('constructor'));

    await expect(container.get('constructor')).resolves.toEqual({ ok: true });
  });

  it('treats __proto__ as an ordinary service name and rejects a duplicate', () => {
    const container = freshContainer();
    container.registerService(service('__proto__'));

    expect(() => container.registerService(service('__proto__'))).toThrow(
      'Service "__proto__" is already registered'
    );
  });

  it('treats __proto__ as an ordinary plugin name and rejects a duplicate', () => {
    const registry = new PluginRegistry();
    registry.register(plugin('__proto__'));

    expect(() => registry.register(plugin('__proto__'))).toThrow(
      'Plugin "__proto__" is already registered'
    );
  });

  it('rejects two static-files plugins that share a prefix', () => {
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });
    app.use(staticFilesPlugin({ root: '/tmp', prefix: '/assets' }));

    expect(() => app.use(staticFilesPlugin({ root: '/tmp', prefix: '/assets' }))).toThrow(
      'Plugin "static-files:/assets" is already registered'
    );
  });
});
