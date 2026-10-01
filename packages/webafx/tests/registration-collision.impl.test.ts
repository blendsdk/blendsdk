/**
 * Implementation tests for duplicate-registration handling.
 *
 * These cover internals not exercised by the specification tests: that a
 * rejected duplicate leaves the first definition in place, that the registry
 * stays usable, and that set() still overrides afterward.
 *
 * @packageDocumentation
 */

import { describe, it, expect } from 'vitest';

import { PluginRegistry } from '../src/application/plugin.js';
import type { PluginDefinition } from '../src/application/plugin.js';
import { ServiceContainer } from '../src/application/service-container.js';
import type { ServiceDefinition, ServiceRegistry } from '../src/application/service-container.js';
import { ApplicationSettings } from '../src/application/application-settings.js';

/** Minimal plugin definition with the given name. */
function plugin(name: string): PluginDefinition {
  return { name, factory: async () => ({ health: async () => true }) };
}

/** Minimal singleton service definition returning the given value. */
function service(name: string, value: unknown): ServiceDefinition {
  return { name, type: 'singleton', factory: () => value };
}

/** A fresh, empty service container, mirroring WebApplication's registry. */
function freshContainer(): ServiceContainer {
  const registry: ServiceRegistry = {
    definitions: Object.create(null) as Record<string, ServiceDefinition>,
    singletons: Object.create(null) as Record<string, unknown>,
  };
  return new ServiceContainer(registry, new ApplicationSettings());
}

describe('Implementation: duplicate registration', () => {
  it('keeps the first service definition after a rejected duplicate', async () => {
    const container = freshContainer();
    container.registerService(service('alpha', { first: true }));

    expect(() =>
      container.registerService(service('alpha', { second: true }))
    ).toThrow('Service "alpha" is already registered');

    await expect(container.get('alpha')).resolves.toEqual({ first: true });
  });

  it('still accepts a distinct plugin after a rejected duplicate', () => {
    const registry = new PluginRegistry();
    registry.register(plugin('alpha'));

    expect(() => registry.register(plugin('alpha'))).toThrow(
      'Plugin "alpha" is already registered'
    );
    expect(() => registry.register(plugin('beta'))).not.toThrow();
  });

  it('still allows set() to override after a rejected duplicate', async () => {
    const container = freshContainer();
    container.registerService(service('alpha', { first: true }));

    expect(() =>
      container.registerService(service('alpha', { second: true }))
    ).toThrow('Service "alpha" is already registered');

    const override = { override: true };
    container.set('alpha', override);

    await expect(container.get('alpha')).resolves.toBe(override);
  });
});
