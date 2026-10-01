import { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationSettings } from '../src/application/application-settings.js';
import {
  ServiceContainer,
  ServiceDefinition,
  ServiceRegistry,
} from '../src/application/service-container.js';

describe('ServiceContainer', () => {
  let settings: ApplicationSettings;
  let registry: ServiceRegistry;
  let container: ServiceContainer;

  beforeEach(() => {
    settings = new ApplicationSettings();
    // Create a fresh registry for each test (simulates WebApplication ownership)
    registry = { definitions: {}, singletons: {} };
    container = new ServiceContainer(registry, settings);
  });

  describe('Basic Service Registration and Resolution', () => {
    it('should register and resolve a singleton service', async () => {
      const service: ServiceDefinition = {
        name: 'test-service',
        type: 'singleton',
        factory: () => ({ value: 'test' }),
      };

      container.registerService(service);
      const result = await container.get('test-service');

      expect(result).toEqual({ value: 'test' });
    });

    it('should return the same instance for singleton services', async () => {
      const service: ServiceDefinition = {
        name: 'singleton',
        type: 'singleton',
        factory: () => ({ id: Math.random() }),
      };

      container.registerService(service);
      const instance1 = await container.get('singleton');
      const instance2 = await container.get('singleton');

      expect(instance1).toBe(instance2);
    });

    it('should create new instances for per-request services', async () => {
      const mockReq = {} as Request;
      const mockRes = {} as Response;
      const mockNext = vi.fn() as NextFunction;

      const service: ServiceDefinition = {
        name: 'per-request',
        type: 'per-request',
        factory: () => ({ id: Math.random() }),
      };

      // Two containers sharing the same registry (like two requests in same app)
      const container1 = new ServiceContainer(registry, settings, mockReq, mockRes, mockNext);
      const container2 = new ServiceContainer(registry, settings, mockReq, mockRes, mockNext);

      container1.registerService(service);

      const instance1 = await container1.get('per-request');
      const instance2 = await container2.get('per-request');

      expect(instance1).not.toBe(instance2);
    });

    it('should throw error when per-request service accessed without request context', async () => {
      const service: ServiceDefinition = {
        name: 'per-request',
        type: 'per-request',
        factory: () => ({ value: 'test' }),
      };

      container.registerService(service);

      await expect(container.get('per-request')).rejects.toThrow(
        'Service "per-request" is per-request and can only be accessed during HTTP request handling'
      );
    });

    it('should throw error when service not registered', async () => {
      await expect(container.get('non-existent')).rejects.toThrow(
        'Service "non-existent" is not registered'
      );
    });

    it('should return default value when service not registered', async () => {
      const defaultValue = { default: true };
      const result = await container.get('non-existent', defaultValue);

      expect(result).toBe(defaultValue);
    });
  });

  describe('Dependency Resolution', () => {
    it('should resolve dependencies in correct order', async () => {
      const callOrder: string[] = [];

      const serviceA: ServiceDefinition = {
        name: 'service-a',
        type: 'singleton',
        factory: () => {
          callOrder.push('a');
          return { name: 'a' };
        },
      };

      const serviceB: ServiceDefinition = {
        name: 'service-b',
        type: 'singleton',
        dependencies: ['service-a'],
        factory: async (container: ServiceContainer) => {
          callOrder.push('b');
          const a = await container.get('service-a');
          return { name: 'b', dependency: a };
        },
      };

      container.registerService(serviceA);
      container.registerService(serviceB);

      const result = await container.get('service-b');

      expect(callOrder).toEqual(['a', 'b']);
      expect(result.dependency).toEqual({ name: 'a' });
    });

    it('should resolve multiple dependencies', async () => {
      const serviceA: ServiceDefinition = {
        name: 'service-a',
        type: 'singleton',
        factory: () => ({ name: 'a' }),
      };

      const serviceB: ServiceDefinition = {
        name: 'service-b',
        type: 'singleton',
        factory: () => ({ name: 'b' }),
      };

      const serviceC: ServiceDefinition = {
        name: 'service-c',
        type: 'singleton',
        dependencies: ['service-a', 'service-b'],
        factory: async (container: ServiceContainer) => {
          const a = await container.get('service-a');
          const b = await container.get('service-b');
          return { name: 'c', deps: [a, b] };
        },
      };

      container.registerService(serviceA);
      container.registerService(serviceB);
      container.registerService(serviceC);

      const result = await container.get('service-c');

      expect(result.deps).toHaveLength(2);
      expect(result.deps[0]).toEqual({ name: 'a' });
      expect(result.deps[1]).toEqual({ name: 'b' });
    });

    it('should detect circular dependencies', async () => {
      const serviceA: ServiceDefinition = {
        name: 'service-a',
        type: 'singleton',
        dependencies: ['service-b'],
        factory: async (container: ServiceContainer) => {
          await container.get('service-b');
          return { name: 'a' };
        },
      };

      const serviceB: ServiceDefinition = {
        name: 'service-b',
        type: 'singleton',
        dependencies: ['service-a'],
        factory: async (container: ServiceContainer) => {
          await container.get('service-a');
          return { name: 'b' };
        },
      };

      container.registerService(serviceA);
      container.registerService(serviceB);

      await expect(container.get('service-a')).rejects.toThrow(/Circular dependency detected/);
    });

    it('should detect self-referencing circular dependency', async () => {
      const service: ServiceDefinition = {
        name: 'self-ref',
        type: 'singleton',
        dependencies: ['self-ref'],
        factory: async (container: ServiceContainer) => {
          await container.get('self-ref');
          return { name: 'self' };
        },
      };

      container.registerService(service);

      await expect(container.get('self-ref')).rejects.toThrow(/Circular dependency detected/);
    });
  });

  describe('Type Safety', () => {
    it('should support generic type parameter for get()', async () => {
      interface TestService {
        value: string;
        count: number;
      }

      const service: ServiceDefinition = {
        name: 'typed-service',
        type: 'singleton',
        factory: () => ({ value: 'test', count: 42 }),
      };

      container.registerService(service);
      const result = await container.get<TestService>('typed-service');

      expect(result.value).toBe('test');
      expect(result.count).toBe(42);
    });

    it('should support generic type for getUser()', async () => {
      interface User {
        id: number;
        email: string;
      }

      const user: User = { id: 1, email: 'test@example.com' };
      container.set('user', user);

      const result = container.getUser<User>();

      expect(result).toEqual(user);
    });

    it('should return undefined for getUser() when not set', () => {
      const result = container.getUser();
      expect(result).toBeUndefined();
    });

    it('should support generic type for getParams()', () => {
      interface Params {
        id: string;
        name: string;
      }

      const params: Params = { id: '123', name: 'test' };
      container.set('request-params', params);

      const result = container.getParams<Params>();

      expect(result).toEqual(params);
    });

    it('should return empty object for getParams() when not set', () => {
      const result = container.getParams();
      expect(result).toEqual({});
    });
  });

  describe('Manual Service Management', () => {
    it('should allow manually setting services', async () => {
      const service = { value: 'manual' };
      container.set('manual-service', service);

      const result = await container.get('manual-service');
      expect(result).toBe(service);
    });

    it('should override registered service with manual set', async () => {
      const service: ServiceDefinition = {
        name: 'override',
        type: 'singleton',
        factory: () => ({ value: 'original' }),
      };

      container.registerService(service);
      container.set('override', { value: 'manual' });

      const result = await container.get('override');
      expect(result).toEqual({ value: 'manual' });
    });
  });

  describe('Instance Methods', () => {
    it('should check if service is registered', () => {
      const service: ServiceDefinition = {
        name: 'test',
        type: 'singleton',
        factory: () => ({}),
      };

      expect(container.isRegistered('test')).toBe(false);

      container.registerService(service);

      expect(container.isRegistered('test')).toBe(true);
    });

    it('should list all registered services', () => {
      const service1: ServiceDefinition = {
        name: 'service-1',
        type: 'singleton',
        factory: () => ({}),
      };

      const service2: ServiceDefinition = {
        name: 'service-2',
        type: 'singleton',
        factory: () => ({}),
      };

      container.registerService(service1);
      container.registerService(service2);

      const services = container.getRegisteredServices();

      expect(services).toContain('service-1');
      expect(services).toContain('service-2');
      expect(services).toHaveLength(2);
    });
  });

  describe('Performance Optimizations', () => {
    it('should not recreate singleton on subsequent gets', async () => {
      let callCount = 0;

      const service: ServiceDefinition = {
        name: 'singleton',
        type: 'singleton',
        factory: () => {
          callCount++;
          return { value: 'test' };
        },
      };

      container.registerService(service);

      await container.get('singleton');
      await container.get('singleton');
      await container.get('singleton');

      expect(callCount).toBe(1);
    });

    it('should share singletons across containers with same registry', async () => {
      let callCount = 0;

      const service: ServiceDefinition = {
        name: 'shared-singleton',
        type: 'singleton',
        factory: () => {
          callCount++;
          return { id: Math.random() };
        },
      };

      // Both containers share the same registry (simulates same WebApplication instance)
      const container1 = new ServiceContainer(registry, settings);
      const container2 = new ServiceContainer(registry, settings);

      container1.registerService(service);

      const instance1 = await container1.get('shared-singleton');
      const instance2 = await container2.get('shared-singleton');

      expect(callCount).toBe(1);
      expect(instance1).toBe(instance2);
    });

    it('should initialize with existing singletons from registry', async () => {
      const service: ServiceDefinition = {
        name: 'pre-existing',
        type: 'singleton',
        factory: () => ({ value: 'test' }),
      };

      const container1 = new ServiceContainer(registry, settings);
      container1.registerService(service);
      await container1.get('pre-existing');

      // New container with same registry should have access to already-created singleton
      const container2 = new ServiceContainer(registry, settings);
      const result = await container2.get('pre-existing');

      expect(result).toEqual({ value: 'test' });
    });
  });

  describe('Request Context', () => {
    it('should pass request context to per-request factory', async () => {
      const mockReq = { url: '/test' } as Request;
      const mockRes = { status: vi.fn() } as unknown as Response;
      const mockNext = vi.fn() as NextFunction;

      let capturedReq: Request | undefined;
      let capturedRes: Response | undefined;
      let capturedNext: NextFunction | undefined;

      const service: ServiceDefinition = {
        name: 'context-service',
        type: 'per-request',
        factory: (container, settings, req, res, next) => {
          capturedReq = req;
          capturedRes = res;
          capturedNext = next;
          return { value: 'test' };
        },
      };

      const requestContainer = new ServiceContainer(registry, settings, mockReq, mockRes, mockNext);
      requestContainer.registerService(service);

      await requestContainer.get('context-service');

      expect(capturedReq).toBe(mockReq);
      expect(capturedRes).toBe(mockRes);
      expect(capturedNext).toBe(mockNext);
    });

    it('should pass container and settings to singleton factory', async () => {
      let capturedContainer: ServiceContainer | undefined;
      let capturedSettings: ApplicationSettings | undefined;

      const service: ServiceDefinition = {
        name: 'factory-test',
        type: 'singleton',
        factory: (container: ServiceContainer, settings: ApplicationSettings) => {
          capturedContainer = container;
          capturedSettings = settings;
          return { value: 'test' };
        },
      };

      container.registerService(service);
      await container.get('factory-test');

      expect(capturedContainer).toBe(container);
      expect(capturedSettings).toBe(settings);
    });
  });

  describe('Error Messages', () => {
    it('should provide clear error for unregistered service', async () => {
      await expect(container.get('missing-service')).rejects.toThrow(
        'Service "missing-service" is not registered'
      );
    });

    it('should provide clear error for per-request without context', async () => {
      const service: ServiceDefinition = {
        name: 'request-only',
        type: 'per-request',
        factory: () => ({}),
      };

      container.registerService(service);

      await expect(container.get('request-only')).rejects.toThrow(
        'Service "request-only" is per-request and can only be accessed during HTTP request handling'
      );
    });

    it('should provide dependency chain in circular dependency error', async () => {
      const serviceA: ServiceDefinition = {
        name: 'a',
        type: 'singleton',
        dependencies: ['b'],
        factory: async (container: ServiceContainer) => {
          await container.get('b');
          return {};
        },
      };

      const serviceB: ServiceDefinition = {
        name: 'b',
        type: 'singleton',
        dependencies: ['c'],
        factory: async (container: ServiceContainer) => {
          await container.get('c');
          return {};
        },
      };

      const serviceC: ServiceDefinition = {
        name: 'c',
        type: 'singleton',
        dependencies: ['a'],
        factory: async (container: ServiceContainer) => {
          await container.get('a');
          return {};
        },
      };

      container.registerService(serviceA);
      container.registerService(serviceB);
      container.registerService(serviceC);

      await expect(container.get('a')).rejects.toThrow(/a -> b -> c -> a/);
    });
  });

  describe('Service Isolation', () => {
    it('should isolate services between different registries', async () => {
      const service: ServiceDefinition = {
        name: 'isolated',
        type: 'singleton',
        factory: () => ({ value: 'app1' }),
      };

      // Two separate registries (simulates two WebApplication instances)
      const registry1: ServiceRegistry = { definitions: {}, singletons: {} };
      const registry2: ServiceRegistry = { definitions: {}, singletons: {} };

      const container1 = new ServiceContainer(registry1, settings);
      const container2 = new ServiceContainer(registry2, settings);

      container1.registerService(service);

      // container1 can access the service
      const instance1 = await container1.get('isolated');
      expect(instance1).toEqual({ value: 'app1' });

      // container2 with different registry cannot access it
      await expect(container2.get('isolated')).rejects.toThrow(
        'Service "isolated" is not registered'
      );
    });

    it('should not leak singletons between registries', async () => {
      let callCount = 0;

      const service: ServiceDefinition = {
        name: 'singleton',
        type: 'singleton',
        factory: () => {
          callCount++;
          return { id: callCount };
        },
      };

      const registry1: ServiceRegistry = { definitions: {}, singletons: {} };
      const registry2: ServiceRegistry = { definitions: {}, singletons: {} };

      const container1 = new ServiceContainer(registry1, settings);
      const container2 = new ServiceContainer(registry2, settings);

      container1.registerService(service);
      container2.registerService(service);

      const instance1 = await container1.get('singleton');
      const instance2 = await container2.get('singleton');

      // Each registry creates its own instance
      expect(callCount).toBe(2);
      expect(instance1).not.toBe(instance2);
      expect(instance1.id).toBe(1);
      expect(instance2.id).toBe(2);
    });
  });

  describe('Service Disposal', () => {
    it('should call dispose on all singletons during disposeAll', async () => {
      const disposeCalls: string[] = [];

      const service1: ServiceDefinition = {
        name: 'service-1',
        type: 'singleton',
        factory: () => ({ name: 'service-1' }),
        dispose: instance => {
          disposeCalls.push(instance.name);
        },
      };

      const service2: ServiceDefinition = {
        name: 'service-2',
        type: 'singleton',
        factory: () => ({ name: 'service-2' }),
        dispose: instance => {
          disposeCalls.push(instance.name);
        },
      };

      container.registerService(service1);
      container.registerService(service2);

      // Create the singletons
      await container.get('service-1');
      await container.get('service-2');

      // Dispose all services
      await container.disposeAll();

      expect(disposeCalls).toContain('service-1');
      expect(disposeCalls).toContain('service-2');
      expect(disposeCalls).toHaveLength(2);
    });

    it('should clear singletons after disposal', async () => {
      let createCount = 0;

      const service: ServiceDefinition = {
        name: 'disposable',
        type: 'singleton',
        factory: () => {
          createCount++;
          return { id: createCount };
        },
        dispose: () => {
          // Cleanup logic
        },
      };

      container.registerService(service);

      const instance1 = await container.get('disposable');
      expect(instance1.id).toBe(1);
      expect(createCount).toBe(1);

      await container.disposeAll();

      // After disposal, create a new container to test that registry was cleared
      // (The original container still has the instance in its local cache)
      const newContainer = new ServiceContainer(registry, settings);
      const instance2 = await newContainer.get('disposable');
      expect(instance2.id).toBe(2);
      expect(createCount).toBe(2);
    });

    it('should handle async dispose functions', async () => {
      let disposed = false;

      const service: ServiceDefinition = {
        name: 'async-disposable',
        type: 'singleton',
        factory: () => ({ value: 'test' }),
        dispose: async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          disposed = true;
        },
      };

      container.registerService(service);
      await container.get('async-disposable');

      await container.disposeAll();

      expect(disposed).toBe(true);
    });

    it('should not fail if service has no dispose function', async () => {
      const service: ServiceDefinition = {
        name: 'no-dispose',
        type: 'singleton',
        factory: () => ({ value: 'test' }),
        // No dispose function
      };

      container.registerService(service);
      await container.get('no-dispose');

      // Should not throw
      await expect(container.disposeAll()).resolves.toBeUndefined();
    });

    it('should handle errors in dispose gracefully', async () => {
      const service1: ServiceDefinition = {
        name: 'failing-dispose',
        type: 'singleton',
        factory: () => ({ name: 'service-1' }),
        dispose: () => {
          throw new Error('Dispose error');
        },
      };

      const service2: ServiceDefinition = {
        name: 'working-dispose',
        type: 'singleton',
        factory: () => ({ name: 'service-2' }),
        dispose: vi.fn(),
      };

      container.registerService(service1);
      container.registerService(service2);

      await container.get('failing-dispose');
      await container.get('working-dispose');

      // disposeAll should reject if any dispose fails
      await expect(container.disposeAll()).rejects.toThrow('Dispose error');
    });
  });

  describe('Backward Compatibility', () => {
    it('should maintain original API surface', () => {
      expect(typeof container.get).toBe('function');
      expect(typeof container.set).toBe('function');
      expect(typeof container.getUser).toBe('function');
      expect(typeof container.getParams).toBe('function');
      expect(typeof container.registerService).toBe('function');
    });

    it('should work with legacy code patterns', async () => {
      // Legacy pattern: register and get without types
      const service: ServiceDefinition = {
        name: 'legacy',
        type: 'singleton',
        factory: () => ({ value: 'legacy' }),
      };

      container.registerService(service);
      const result = await container.get('legacy');

      expect(result.value).toBe('legacy');
    });

    it('should handle undefined default value correctly', async () => {
      const result = await container.get('missing', undefined);
      expect(result).toBeUndefined();
    });
  });
});
