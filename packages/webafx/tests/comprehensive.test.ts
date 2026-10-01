import { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ApiError,
  ApplicationSettings,
  BadRequestError,
  BaseController,
  ConflictError,
  ForbiddenError,
  InternalServerError,
  NotFoundError,
  RateLimitError,
  RouteBuilder,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from '../src/index.js';
import { ConsoleLogger } from '../src/application/console-logger.js';
import { ControllerRegistry } from '../src/application/controller-registry.js';
import { isValidUUID, requestIdMiddleware } from '../src/application/request-id-middleware.js';
import { errorHandlerMiddleware } from '../src/application/error-handler-middleware.js';

describe('ApplicationSettings', () => {
  describe('Constructor and Defaults', () => {
    it('should create with empty config when no arguments provided', () => {
      const settings = new ApplicationSettings();
      const config = settings.getAll();

      // Constructor defaults ENV_MODE to 'production' for secure-by-default
      expect(config.ENV_MODE).toBe('production');
      expect(config.DEBUG).toBeUndefined();
    });

    it('should accept initial configuration', () => {
      const settings = new ApplicationSettings({
        PORT: 3000,
        ENV_MODE: 'development',
        DEBUG: true,
      });

      const config = settings.getAll();
      expect(config.PORT).toBe(3000);
      expect(config.ENV_MODE).toBe('development');
      expect(config.DEBUG).toBe(true);
    });

    it('should use provided config values without reading environment', () => {
      const originalDebug = process.env.DEBUG;
      process.env.DEBUG = 'true';

      // Constructor doesn't read from environment - only explicit config
      const settings = new ApplicationSettings();
      expect(settings.getAll().DEBUG).toBeUndefined();

      // But explicit config works
      const settings2 = new ApplicationSettings({ DEBUG: true });
      expect(settings2.getAll().DEBUG).toBe(true);

      process.env.DEBUG = originalDebug;
    });
  });

  describe('get() method', () => {
    it('should get configuration value by key', () => {
      const settings = new ApplicationSettings({ PORT: 4000 });
      expect(settings.get('PORT')).toBe(4000);
    });

    it('should return default value when key not set', () => {
      const settings = new ApplicationSettings();
      expect(settings.get('PORT', 5000)).toBe(5000);
    });

    it('should return undefined when key not set and no default', () => {
      const settings = new ApplicationSettings();
      expect(settings.get('PORT')).toBeUndefined();
    });

    it('should support generic type parameter', () => {
      const settings = new ApplicationSettings({ PORT: 3000 });
      const port: number = settings.get<number>('PORT', 4000);
      expect(port).toBe(3000);
    });
  });

  describe('getAll() method', () => {
    it('should return shallow copy of config', () => {
      const settings = new ApplicationSettings({ PORT: 3000 });
      const config1 = settings.getAll();
      const config2 = settings.getAll();

      expect(config1).toEqual(config2);
      expect(config1).not.toBe(config2); // Different objects
    });

    it('should prevent mutations to internal config', () => {
      const settings = new ApplicationSettings({ PORT: 3000 });
      const config = settings.getAll();

      config.PORT = 5000;

      expect(settings.get('PORT')).toBe(3000); // Original unchanged
    });
  });

  describe('isProduction() method', () => {
    it('should return true for production mode', () => {
      const settings = new ApplicationSettings({ ENV_MODE: 'production' });
      expect(settings.isProduction()).toBe(true);
    });

    it('should return false for development mode', () => {
      const settings = new ApplicationSettings({ ENV_MODE: 'development' });
      expect(settings.isProduction()).toBe(false);
    });

    it('should return false for test mode', () => {
      const settings = new ApplicationSettings({ ENV_MODE: 'test' });
      expect(settings.isProduction()).toBe(false);
    });
  });

  describe('Validation (Zod Schema)', () => {
    it('should accept valid PORT values', () => {
      expect(() => {
        new ApplicationSettings({ PORT: 0 });
        new ApplicationSettings({ PORT: 3000 });
        new ApplicationSettings({ PORT: 65535 });
      }).not.toThrow();
    });

    it('should reject invalid PORT values', () => {
      expect(() => {
        new ApplicationSettings({ PORT: -1 });
      }).toThrow(/validation failed/i);

      expect(() => {
        new ApplicationSettings({ PORT: 70000 });
      }).toThrow(/validation failed/i);

      expect(() => {
        new ApplicationSettings({ PORT: 3.14 } as any);
      }).toThrow(/validation failed/i);
    });

    it('should accept valid ENV_MODE values', () => {
      expect(() => {
        new ApplicationSettings({ ENV_MODE: 'production' });
        new ApplicationSettings({ ENV_MODE: 'development' });
        new ApplicationSettings({ ENV_MODE: 'test' });
      }).not.toThrow();
    });

    it('should reject invalid ENV_MODE values', () => {
      expect(() => {
        new ApplicationSettings({ ENV_MODE: 'staging' } as any);
      }).toThrow(/validation failed/i);

      expect(() => {
        new ApplicationSettings({ ENV_MODE: 'prod' } as any);
      }).toThrow(/validation failed/i);
    });

    it('should accept valid LOG_LEVEL values', () => {
      expect(() => {
        new ApplicationSettings({ LOG_LEVEL: 'ERROR' });
        new ApplicationSettings({ LOG_LEVEL: 'WARN' });
        new ApplicationSettings({ LOG_LEVEL: 'INFO' });
        new ApplicationSettings({ LOG_LEVEL: 'DEBUG' });
      }).not.toThrow();
    });

    it('should reject invalid LOG_LEVEL values', () => {
      expect(() => {
        new ApplicationSettings({ LOG_LEVEL: 'TRACE' } as any);
      }).toThrow(/validation failed/i);

      expect(() => {
        new ApplicationSettings({ LOG_LEVEL: 'VERBOSE' } as any);
      }).toThrow(/validation failed/i);
    });

    it('should accept valid SHUTDOWN_TIMEOUT values', () => {
      expect(() => {
        new ApplicationSettings({ SHUTDOWN_TIMEOUT: 0 });
        new ApplicationSettings({ SHUTDOWN_TIMEOUT: 30 });
        new ApplicationSettings({ SHUTDOWN_TIMEOUT: 300 });
      }).not.toThrow();
    });

    it('should reject invalid SHUTDOWN_TIMEOUT values', () => {
      expect(() => {
        new ApplicationSettings({ SHUTDOWN_TIMEOUT: -1 });
      }).toThrow(/validation failed/i);

      expect(() => {
        new ApplicationSettings({ SHUTDOWN_TIMEOUT: 400 });
      }).toThrow(/validation failed/i);
    });

    it('should accept boolean DEBUG values', () => {
      expect(() => {
        new ApplicationSettings({ DEBUG: true });
        new ApplicationSettings({ DEBUG: false });
      }).not.toThrow();
    });

    it('should reject non-boolean DEBUG values', () => {
      expect(() => {
        new ApplicationSettings({ DEBUG: 'true' } as any);
      }).toThrow(/validation failed/i);

      expect(() => {
        new ApplicationSettings({ DEBUG: 1 } as any);
      }).toThrow(/validation failed/i);
    });

    it('should accept boolean CORS values', () => {
      expect(() => {
        new ApplicationSettings({ CORS: true });
        new ApplicationSettings({ CORS: false });
      }).not.toThrow();
    });

    it('should accept CORS object configuration', () => {
      expect(() => {
        new ApplicationSettings({
          CORS: {
            origin: 'https://example.com',
            methods: ['GET', 'POST'],
            credentials: true,
          },
        });
      }).not.toThrow();
    });

    it('should allow custom configuration properties', () => {
      expect(() => {
        new ApplicationSettings({
          PORT: 3000,
          CUSTOM_API_KEY: 'secret-key',
          CUSTOM_TIMEOUT: 5000,
        });
      }).not.toThrow();
    });

    it('should provide detailed error messages on validation failure', () => {
      try {
        new ApplicationSettings({ PORT: -1, SHUTDOWN_TIMEOUT: 500 });
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).toContain('Configuration validation failed');
        expect(error.message).toContain('PORT');
        expect(error.message).toContain('SHUTDOWN_TIMEOUT');
      }
    });
  });

  describe('Custom Configuration', () => {
    it('should support custom configuration properties', () => {
      const settings = new ApplicationSettings({
        CUSTOM_PROP: 'custom-value',
        ANOTHER_PROP: 123,
      });

      expect(settings.get('CUSTOM_PROP')).toBe('custom-value');
      expect(settings.get('ANOTHER_PROP')).toBe(123);
    });
  });
});

describe('RouteBuilder', () => {
  describe('HTTP Method Builders', () => {
    it('should build GET route', () => {
      const route = new RouteBuilder().get('/users').handle(async (req, res) => {
        res.json({ users: [] });
      });

      expect(route.method).toBe('get');
      expect(route.path).toBe('/users');
      expect(typeof route.handler).toBe('function');
    });

    it('should build POST route', () => {
      const route = new RouteBuilder().post('/users').handle(async (req, res) => {
        res.json({ created: true });
      });

      expect(route.method).toBe('post');
      expect(route.path).toBe('/users');
    });

    it('should build PUT route', () => {
      const route = new RouteBuilder().put('/users/:id').handle(async (req, res) => {
        res.json({ updated: true });
      });

      expect(route.method).toBe('put');
      expect(route.path).toBe('/users/:id');
    });

    it('should build PATCH route', () => {
      const route = new RouteBuilder().patch('/users/:id').handle(async (req, res) => {
        res.json({ patched: true });
      });

      expect(route.method).toBe('patch');
      expect(route.path).toBe('/users/:id');
    });

    it('should build DELETE route', () => {
      const route = new RouteBuilder().delete('/users/:id').handle(async (req, res) => {
        res.json({ deleted: true });
      });

      expect(route.method).toBe('delete');
      expect(route.path).toBe('/users/:id');
    });
  });

  describe('Security and Authorization', () => {
    it('should mark route as secure', () => {
      const route = new RouteBuilder()
        .get('/protected')
        .secure()
        .handle(async (req, res) => {
          res.json({ data: 'secret' });
        });

      expect(route.secure).toBe(true);
    });

    it('should add authorization function', () => {
      const authFn = (req: Request, user: any) => user.role === 'admin';

      const route = new RouteBuilder()
        .get('/admin')
        .authorize(authFn)
        .handle(async (req, res) => {
          res.json({ admin: true });
        });

      expect(route.authorize).toBe(authFn);
    });

    it('should support both secure and authorize', () => {
      const authFn = (req: Request, user: any) => user.role === 'admin';

      const route = new RouteBuilder()
        .get('/admin')
        .secure()
        .authorize(authFn)
        .handle(async (req, res) => {
          res.json({ admin: true });
        });

      expect(route.secure).toBe(true);
      expect(route.authorize).toBe(authFn);
    });
  });

  describe('Validation', () => {
    it('should add Zod validation schema', () => {
      const schema = z.object({
        email: z.string().email(),
        age: z.number().min(18),
      });

      const route = new RouteBuilder()
        .post('/users')
        .validate(schema)
        .handle(async (req, res) => {
          res.json({ created: true });
        });

      expect(route.validation).toBe(schema);
    });

    it('should support complex validation schemas', () => {
      const schema = z.object({
        name: z.string().min(1).max(100),
        email: z.string().email(),
        age: z.number().int().positive(),
        tags: z.array(z.string()).optional(),
      });

      const route = new RouteBuilder()
        .post('/users')
        .validate(schema)
        .handle(async (req, res) => {
          res.json({ created: true });
        });

      expect(route.validation).toBe(schema);
    });
  });

  describe('Method Chaining', () => {
    it('should support fluent API chaining', () => {
      const schema = z.object({ id: z.string() });
      const authFn = (req: Request, user: any) => true;

      const route = new RouteBuilder()
        .get('/resource/:id')
        .secure()
        .authorize(authFn)
        .validate(schema)
        .handle(async (req, res) => {
          res.json({ data: 'test' });
        });

      expect(route.method).toBe('get');
      expect(route.path).toBe('/resource/:id');
      expect(route.secure).toBe(true);
      expect(route.authorize).toBe(authFn);
      expect(route.validation).toBe(schema);
      expect(typeof route.handler).toBe('function');
    });
  });

  describe('Error Handling', () => {
    it('should throw error if handler is not a function', () => {
      expect(() => {
        new RouteBuilder().get('/test').handle('not a function' as any);
      }).toThrow('Route handler must be a function');
    });

    it('should throw error if method not set', () => {
      expect(() => {
        new RouteBuilder().handle(async (req, res) => {});
      }).toThrow('Route method must be set');
    });

    it('should throw error if path not set', () => {
      expect(() => {
        const builder = new RouteBuilder();
        (builder as any).definition.method = 'get';
        builder.handle(async (req, res) => {});
      }).toThrow('Route path must be set');
    });

    it('should include path and method in error message', () => {
      expect(() => {
        new RouteBuilder().get('/test').handle(null as any);
      }).toThrow(/Path: \/test/);
      expect(() => {
        new RouteBuilder().get('/test').handle(null as any);
      }).toThrow(/Method: get/);
    });
  });
});

describe('BaseController', () => {
  class TestController extends BaseController {
    routes() {
      return [
        this.route()
          .get('/test')
          .handle(async (req, res) => {
            res.json({ test: true });
          }),
      ];
    }
  }

  it('should create controller with settings and services', () => {
    const settings = new ApplicationSettings({ PORT: 3000 });
    // Create a minimal mock ServiceContainer for testing
    const mockServices = {} as any;
    const controller = new TestController(settings, mockServices);

    expect(controller).toBeInstanceOf(BaseController);
  });

  it('should provide route() helper', () => {
    const settings = new ApplicationSettings();
    const mockServices = {} as any;
    const controller = new TestController(settings, mockServices);

    const builder = (controller as any).route();
    expect(builder).toBeInstanceOf(RouteBuilder);
  });

  it('should provide authenticated() helper', () => {
    const settings = new ApplicationSettings();
    const mockServices = {} as any;
    const controller = new TestController(settings, mockServices);

    const route = (controller as any)
      .authenticated()
      .get('/protected')
      .handle(async (req: Request, res: Response) => {
        res.json({ protected: true });
      });

    expect(route.secure).toBe(true);
  });

  it('should require routes() implementation', () => {
    const settings = new ApplicationSettings();
    const mockServices = {} as any;
    const controller = new TestController(settings, mockServices);

    const routes = controller.routes();
    expect(Array.isArray(routes)).toBe(true);
    expect(routes.length).toBeGreaterThan(0);
  });
});

describe('ControllerRegistry', () => {
  class TestController extends BaseController {
    routes() {
      return [];
    }
  }

  class AnotherController extends BaseController {
    routes() {
      return [];
    }
  }

  let registry: ControllerRegistry;

  beforeEach(() => {
    registry = new ControllerRegistry();
  });

  it('should register controller with base path', () => {
    registry.register('/api/users', TestController);

    const controllers = registry.getAll();
    expect(controllers).toHaveLength(1);
    expect(controllers[0].basePath).toBe('/api/users');
    expect(controllers[0].ControllerClass).toBe(TestController);
  });

  it('should register multiple controllers', () => {
    registry.register('/api/users', TestController);
    registry.register('/api/posts', AnotherController);

    const controllers = registry.getAll();
    expect(controllers).toHaveLength(2);
  });

  it('should return empty array when no controllers registered', () => {
    const controllers = registry.getAll();
    expect(controllers).toEqual([]);
  });

  it('should maintain registration order', () => {
    registry.register('/first', TestController);
    registry.register('/second', AnotherController);
    registry.register('/third', TestController);

    const controllers = registry.getAll();
    expect(controllers[0].basePath).toBe('/first');
    expect(controllers[1].basePath).toBe('/second');
    expect(controllers[2].basePath).toBe('/third');
  });
});

describe('Error Classes', () => {
  describe('ApiError', () => {
    it('should create error with all properties', () => {
      const error = new ApiError(400, 'TEST_ERROR', 'Test message', { field: 'email' });

      expect(error.statusCode).toBe(400);
      expect(error.code).toBe('TEST_ERROR');
      expect(error.message).toBe('Test message');
      expect(error.details).toEqual({ field: 'email' });
      expect(error.name).toBe('ApiError');
    });

    it('should convert to JSON format', () => {
      const error = new ApiError(404, 'NOT_FOUND', 'Resource not found', { id: 123 });
      const json = error.toJSON();

      expect(json).toMatchObject({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found',
          details: { id: 123 },
          statusCode: 404,
          timestamp: expect.any(String),
        },
      });
    });

    it('should capture stack trace', () => {
      const error = new ApiError(500, 'ERROR', 'Test');
      expect(error.stack).toBeDefined();
      expect(typeof error.stack).toBe('string');
    });

    it('should work without details', () => {
      const error = new ApiError(400, 'ERROR', 'Test');
      expect(error.details).toBeUndefined();

      const json = error.toJSON();
      expect(json.error.details).toBeUndefined();
    });
  });

  describe('BadRequestError', () => {
    it('should create 400 error with default message', () => {
      const error = new BadRequestError();
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe('BAD_REQUEST');
      expect(error.message).toBe('Bad Request');
    });

    it('should accept custom message and details', () => {
      const error = new BadRequestError('Invalid input', { field: 'email' });
      expect(error.message).toBe('Invalid input');
      expect(error.details).toEqual({ field: 'email' });
    });
  });

  describe('UnauthorizedError', () => {
    it('should create 401 error', () => {
      const error = new UnauthorizedError();
      expect(error.statusCode).toBe(401);
      expect(error.code).toBe('UNAUTHORIZED');
      expect(error.message).toBe('Unauthorized');
    });

    it('should accept custom message', () => {
      const error = new UnauthorizedError('Invalid token');
      expect(error.message).toBe('Invalid token');
    });
  });

  describe('ForbiddenError', () => {
    it('should create 403 error', () => {
      const error = new ForbiddenError();
      expect(error.statusCode).toBe(403);
      expect(error.code).toBe('FORBIDDEN');
      expect(error.message).toBe('Forbidden');
    });

    it('should accept custom message', () => {
      const error = new ForbiddenError('Insufficient permissions');
      expect(error.message).toBe('Insufficient permissions');
    });
  });

  describe('NotFoundError', () => {
    it('should create 404 error', () => {
      const error = new NotFoundError();
      expect(error.statusCode).toBe(404);
      expect(error.code).toBe('NOT_FOUND');
      expect(error.message).toBe('Not Found');
    });

    it('should accept custom message and details', () => {
      const error = new NotFoundError('User not found', { userId: 123 });
      expect(error.message).toBe('User not found');
      expect(error.details).toEqual({ userId: 123 });
    });
  });

  describe('ConflictError', () => {
    it('should create 409 error', () => {
      const error = new ConflictError();
      expect(error.statusCode).toBe(409);
      expect(error.code).toBe('CONFLICT');
      expect(error.message).toBe('Conflict');
    });

    it('should accept custom message', () => {
      const error = new ConflictError('Email already exists');
      expect(error.message).toBe('Email already exists');
    });
  });

  describe('ValidationError', () => {
    it('should create 422 error', () => {
      const error = new ValidationError();
      expect(error.statusCode).toBe(422);
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.message).toBe('Validation Failed');
    });

    it('should accept validation details', () => {
      const details = [
        { path: 'email', message: 'Invalid email', code: 'invalid_string' },
        { path: 'age', message: 'Must be positive', code: 'too_small' },
      ];
      const error = new ValidationError('Validation failed', details);
      expect(error.details).toEqual(details);
    });
  });

  describe('RateLimitError', () => {
    it('should create 429 error', () => {
      const error = new RateLimitError();
      expect(error.statusCode).toBe(429);
      expect(error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(error.message).toBe('Rate Limit Exceeded');
    });

    it('should accept custom message', () => {
      const error = new RateLimitError('Too many requests');
      expect(error.message).toBe('Too many requests');
    });
  });

  describe('InternalServerError', () => {
    it('should create 500 error', () => {
      const error = new InternalServerError();
      expect(error.statusCode).toBe(500);
      expect(error.code).toBe('INTERNAL_SERVER_ERROR');
      expect(error.message).toBe('Internal Server Error');
    });

    it('should accept custom message', () => {
      const error = new InternalServerError('Database connection failed');
      expect(error.message).toBe('Database connection failed');
    });
  });

  describe('ServiceUnavailableError', () => {
    it('should create 503 error', () => {
      const error = new ServiceUnavailableError();
      expect(error.statusCode).toBe(503);
      expect(error.code).toBe('SERVICE_UNAVAILABLE');
      expect(error.message).toBe('Service Unavailable');
    });

    it('should accept custom message', () => {
      const error = new ServiceUnavailableError('Maintenance mode');
      expect(error.message).toBe('Maintenance mode');
    });
  });

  describe('Error Inheritance', () => {
    it('should all extend ApiError', () => {
      expect(new BadRequestError()).toBeInstanceOf(ApiError);
      expect(new UnauthorizedError()).toBeInstanceOf(ApiError);
      expect(new ForbiddenError()).toBeInstanceOf(ApiError);
      expect(new NotFoundError()).toBeInstanceOf(ApiError);
      expect(new ConflictError()).toBeInstanceOf(ApiError);
      expect(new ValidationError()).toBeInstanceOf(ApiError);
      expect(new RateLimitError()).toBeInstanceOf(ApiError);
      expect(new InternalServerError()).toBeInstanceOf(ApiError);
      expect(new ServiceUnavailableError()).toBeInstanceOf(ApiError);
    });

    it('should all extend Error', () => {
      expect(new BadRequestError()).toBeInstanceOf(Error);
      expect(new UnauthorizedError()).toBeInstanceOf(Error);
      expect(new ForbiddenError()).toBeInstanceOf(Error);
    });

    it('should have correct error names', () => {
      expect(new BadRequestError().name).toBe('BadRequestError');
      expect(new UnauthorizedError().name).toBe('UnauthorizedError');
      expect(new ForbiddenError().name).toBe('ForbiddenError');
      expect(new NotFoundError().name).toBe('NotFoundError');
      expect(new ConflictError().name).toBe('ConflictError');
      expect(new ValidationError().name).toBe('ValidationError');
      expect(new RateLimitError().name).toBe('RateLimitError');
      expect(new InternalServerError().name).toBe('InternalServerError');
      expect(new ServiceUnavailableError().name).toBe('ServiceUnavailableError');
    });
  });
});

describe('ConsoleLogger', () => {
  let logger: ConsoleLogger;
  let consoleLogSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    logger = new ConsoleLogger('TEST');
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  describe('Logging Methods', () => {
    it('should log info messages', async () => {
      const infoLogger = new ConsoleLogger('TEST', 'INFO');

      await infoLogger.info('Test message');
      expect(consoleLogSpy).toHaveBeenCalled();
      const logCall = consoleLogSpy.mock.calls[0][0];
      expect(logCall).toContain('[INFO:TEST]');
      expect(logCall).toContain('Test message');
    });

    it('should log debug messages when DEBUG env is set', async () => {
      vi.stubEnv('DEBUG', 'true');

      await logger.debug('Debug message');
      expect(consoleLogSpy).toHaveBeenCalled();
      const logCall = consoleLogSpy.mock.calls[0][0];
      expect(logCall).toContain('[DEBUG:TEST]');
    });

    it('should log warn messages when LOG_LEVEL allows', async () => {
      const warnLogger = new ConsoleLogger('TEST', 'WARN');

      await warnLogger.warn('Warning message');
      expect(consoleLogSpy).toHaveBeenCalled();
      const logCall = consoleLogSpy.mock.calls[0][0];
      expect(logCall).toContain('[WARN:TEST]');
    });

    it('should log error messages', async () => {
      const errorLogger = new ConsoleLogger('TEST', 'ERROR');

      await errorLogger.error('Error message');
      expect(consoleErrorSpy).toHaveBeenCalled();
      const logCall = consoleErrorSpy.mock.calls[0][0];
      expect(logCall).toContain('[ERROR:TEST]');
      expect(logCall).toContain('Error message');
    });

    it('should include context in log messages', async () => {
      const infoLogger = new ConsoleLogger('TEST', 'INFO');

      await infoLogger.info('Test', { userId: 123, action: 'login' });
      expect(consoleLogSpy).toHaveBeenCalled();
      const logCall = consoleLogSpy.mock.calls[0][0];
      expect(logCall).toContain('userId');
      expect(logCall).toContain('123');
      expect(logCall).toContain('action');
      expect(logCall).toContain('login');
    });

    it('should handle messages without context', async () => {
      const infoLogger = new ConsoleLogger('TEST', 'INFO');

      await infoLogger.info('Simple message');
      expect(consoleLogSpy).toHaveBeenCalled();
      const logCall = consoleLogSpy.mock.calls[0][0];
      expect(logCall).toBe('[INFO:TEST]: Simple message');
    });
  });

  describe('Logger Context', () => {
    it('should include logger name in uppercase in output', async () => {
      const namedLogger = new ConsoleLogger('MyService', 'INFO');
      await namedLogger.info('Test');
      expect(consoleLogSpy).toHaveBeenCalled();
      const logCall = consoleLogSpy.mock.calls[0][0];
      expect(logCall).toContain('MYSERVICE');
      expect(logCall).toContain('[INFO:MYSERVICE]');
    });

    it('should support different logger names', async () => {
      const logger1 = new ConsoleLogger('Service1', 'INFO');
      const logger2 = new ConsoleLogger('Service2', 'INFO');

      await logger1.info('Message 1');
      await logger2.info('Message 2');

      expect(consoleLogSpy).toHaveBeenCalledTimes(2);
      expect(consoleLogSpy.mock.calls[0][0]).toContain('SERVICE1');
      expect(consoleLogSpy.mock.calls[1][0]).toContain('SERVICE2');
    });
  });

  describe('Error Logging', () => {
    it('should log Error objects as data', async () => {
      const errorLogger = new ConsoleLogger('TEST', 'ERROR');

      const error = new Error('Test error');
      await errorLogger.error('Error occurred', error as any);
      expect(consoleErrorSpy).toHaveBeenCalled();
      const errorCall = consoleErrorSpy.mock.calls[0][0];
      expect(errorCall).toContain('[ERROR:TEST]');
      expect(errorCall).toContain('Error occurred');
    });

    it('should format error data as JSON', async () => {
      const errorLogger = new ConsoleLogger('TEST', 'ERROR');

      const errorData = { code: 'ERR001', message: 'Test error' };
      await errorLogger.error('Error occurred', errorData);
      expect(consoleErrorSpy).toHaveBeenCalled();
      const errorCall = consoleErrorSpy.mock.calls[0][0];
      expect(errorCall).toContain('ERR001');
      expect(errorCall).toContain('Test error');
    });
  });

  describe('shouldLog Level Filtering (Bug Fix)', () => {
    // These tests verify the fix for the shouldLog bug where
    // `return l >= level || level === 3` caused INFO to always log.
    // The correct behavior is: `return level <= configuredLevel`

    it('should only log ERROR when log level is ERROR', async () => {
      const errorLogger = new ConsoleLogger('TEST', 'ERROR');

      await errorLogger.error('error msg');
      await errorLogger.warn('warn msg');
      await errorLogger.info('info msg');

      // ERROR should be logged (level 1 <= configured 1)
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      // WARN and INFO should NOT be logged (levels 2,3 > configured 1)
      expect(consoleLogSpy).toHaveBeenCalledTimes(0);
    });

    it('should log ERROR and WARN when log level is WARN', async () => {
      const warnLogger = new ConsoleLogger('TEST', 'WARN');

      await warnLogger.error('error msg');
      await warnLogger.warn('warn msg');
      await warnLogger.info('info msg');

      // ERROR logged via console.error
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      // WARN logged via console.log, INFO should NOT be logged
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy.mock.calls[0][0]).toContain('[WARN:TEST]');
    });

    it('should log ERROR, WARN, and INFO when log level is INFO', async () => {
      const infoLogger = new ConsoleLogger('TEST', 'INFO');

      await infoLogger.error('error msg');
      await infoLogger.warn('warn msg');
      await infoLogger.info('info msg');
      await infoLogger.debug('debug msg');

      // ERROR logged via console.error
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      // WARN + INFO logged, DEBUG should NOT be logged (level 4 > configured 3)
      expect(consoleLogSpy).toHaveBeenCalledTimes(2);
    });

    it('should log all levels when log level is DEBUG', async () => {
      vi.stubEnv('DEBUG', ''); // Ensure DEBUG env doesn't interfere

      const debugLogger = new ConsoleLogger('TEST', 'DEBUG');

      await debugLogger.error('error msg');
      await debugLogger.warn('warn msg');
      await debugLogger.info('info msg');
      await debugLogger.debug('debug msg');

      // ERROR logged via console.error
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      // WARN + INFO + DEBUG all logged via console.log
      expect(consoleLogSpy).toHaveBeenCalledTimes(3);
    });

    it('should suppress INFO when log level is ERROR', async () => {
      const errorLogger = new ConsoleLogger('TEST', 'ERROR');

      // This was the core bug: INFO was always logging due to `|| level === 3`
      await errorLogger.info('this should not appear');
      expect(consoleLogSpy).toHaveBeenCalledTimes(0);
    });

    it('should treat unknown env LOG_LEVEL as ERROR only', async () => {
      vi.stubEnv('LOG_LEVEL', 'UNKNOWN_VALUE');

      const unknownLogger = new ConsoleLogger('TEST');

      await unknownLogger.error('error');
      await unknownLogger.warn('warn');
      await unknownLogger.info('info');

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy).toHaveBeenCalledTimes(0);
    });

    it('should be case-insensitive for env LOG_LEVEL', async () => {
      vi.stubEnv('LOG_LEVEL', 'info');

      const infoLogger = new ConsoleLogger('TEST');

      await infoLogger.info('info msg');
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    });
  });
});

describe('Request ID Middleware', () => {
  describe('isValidUUID', () => {
    it('should accept valid UUID v4 strings', () => {
      expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
      expect(isValidUUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(true);
      expect(isValidUUID('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(true);
    });

    it('should accept UUIDs with uppercase hex', () => {
      expect(isValidUUID('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
      expect(isValidUUID('F47AC10B-58CC-4372-A567-0E02B2C3D479')).toBe(true);
    });

    it('should reject malformed strings', () => {
      expect(isValidUUID('')).toBe(false);
      expect(isValidUUID('not-a-uuid')).toBe(false);
      expect(isValidUUID('550e8400e29b41d4a716446655440000')).toBe(false); // missing dashes
      expect(isValidUUID('550e8400-e29b-41d4-a716')).toBe(false); // too short
      expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000-extra')).toBe(false); // too long
    });

    it('should reject injection attempts', () => {
      expect(isValidUUID('<script>alert(1)</script>')).toBe(false);
      expect(isValidUUID('"; DROP TABLE users; --')).toBe(false);
      expect(isValidUUID('550e8400-e29b-41d4-a716-44665544000g')).toBe(false); // invalid hex char 'g'
    });
  });

  describe('requestIdMiddleware', () => {
    /**
     * Creates a minimal mock request/response/next for testing the middleware.
     */
    function createMockReqResNext(headers: Record<string, string> = {}) {
      const req = {
        headers,
        id: undefined as string | undefined,
      } as unknown as Request;

      const responseHeaders: Record<string, string> = {};
      const res = {
        setHeader: (name: string, value: string) => {
          responseHeaders[name] = value;
        },
      } as unknown as Response;

      let nextCalled = false;
      const next = () => {
        nextCalled = true;
      };

      return { req, res, next, responseHeaders, isNextCalled: () => nextCalled };
    }

    it('should generate a new UUID when no X-Request-ID header present', () => {
      const { req, res, next } = createMockReqResNext();
      const middleware = requestIdMiddleware();

      middleware(req, res, next);

      expect(req.id).toBeDefined();
      expect(isValidUUID(req.id!)).toBe(true);
    });

    it('should reuse valid UUID from X-Request-ID header', () => {
      const validUUID = '550e8400-e29b-41d4-a716-446655440000';
      const { req, res, next } = createMockReqResNext({ 'x-request-id': validUUID });
      const middleware = requestIdMiddleware();

      middleware(req, res, next);

      expect(req.id).toBe(validUUID);
    });

    it('should reject malformed X-Request-ID and generate new UUID', () => {
      const { req, res, next } = createMockReqResNext({
        'x-request-id': 'malformed-id-value',
      });
      const middleware = requestIdMiddleware();

      middleware(req, res, next);

      // Should NOT use the malformed ID
      expect(req.id).not.toBe('malformed-id-value');
      expect(isValidUUID(req.id!)).toBe(true);
    });

    it('should reject injection attempt in X-Request-ID', () => {
      const { req, res, next } = createMockReqResNext({
        'x-request-id': '<script>alert(1)</script>',
      });
      const middleware = requestIdMiddleware();

      middleware(req, res, next);

      expect(req.id).not.toContain('<script>');
      expect(isValidUUID(req.id!)).toBe(true);
    });

    it('should set X-Request-ID response header', () => {
      const { req, res, next, responseHeaders } = createMockReqResNext();
      const middleware = requestIdMiddleware();

      middleware(req, res, next);

      expect(responseHeaders['X-Request-ID']).toBe(req.id);
    });

    it('should call next()', () => {
      const { req, res, next, isNextCalled } = createMockReqResNext();
      const middleware = requestIdMiddleware();

      middleware(req, res, next);

      expect(isNextCalled()).toBe(true);
    });
  });
});

describe('Error Handler Middleware (Logger Resilience)', () => {
  /**
   * Creates minimal mock objects for testing error handler middleware.
   */
  function createMockContext() {
    const req = {
      id: 'test-request-id',
      path: '/test',
    } as unknown as Request;

    let statusCode: number | undefined;
    let jsonBody: any;
    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (body: any) => {
        jsonBody = body;
        return res;
      },
    } as unknown as Response;

    const next = vi.fn();

    return {
      req,
      res,
      next,
      getStatusCode: () => statusCode,
      getJsonBody: () => jsonBody,
    };
  }

  it('should still send error response when logger throws (ApiError)', async () => {
    // Create a logger that always throws
    const failingLogger = async () => {
      throw new Error('Logger is broken!');
    };

    const middleware = errorHandlerMiddleware(failingLogger, false);
    const { req, res, next, getStatusCode, getJsonBody } = createMockContext();
    const error = new BadRequestError('Bad input');

    // Call the middleware — it should NOT throw despite logger failure
    await (middleware as any)(error, req, res, next);

    // The client should still get the proper error response (new StandardErrorResponse format)
    expect(getStatusCode()).toBe(400);
    expect(getJsonBody()).toMatchObject({
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'Bad input',
        statusCode: 400,
      },
    });
  });

  it('should still send error response when logger throws (unknown error)', async () => {
    const failingLogger = async () => {
      throw new Error('Logger crashed!');
    };

    const middleware = errorHandlerMiddleware(failingLogger, false);
    const { req, res, next, getStatusCode, getJsonBody } = createMockContext();
    const error = new Error('Something unexpected');

    await (middleware as any)(error, req, res, next);

    // Should get 500 response even though logger failed (new StandardErrorResponse format)
    expect(getStatusCode()).toBe(500);
    expect(getJsonBody()).toMatchObject({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal Server Error',
        statusCode: 500,
      },
    });
  });

  it('should call logger when it works normally', async () => {
    const loggerSpy = vi.fn().mockResolvedValue(undefined);

    const middleware = errorHandlerMiddleware(loggerSpy, false);
    const { req, res, next } = createMockContext();
    const error = new NotFoundError('Resource missing');

    await (middleware as any)(error, req, res, next);

    // Logger should have been called
    expect(loggerSpy).toHaveBeenCalledTimes(1);
    expect(loggerSpy).toHaveBeenCalledWith(req, error, expect.any(Object));
  });

  it('should include stack trace in development mode', async () => {
    const loggerSpy = vi.fn().mockResolvedValue(undefined);

    // includeStack = true (development)
    const middleware = errorHandlerMiddleware(loggerSpy, true);
    const { req, res, next, getJsonBody } = createMockContext();
    const error = new BadRequestError('Dev error');

    await (middleware as any)(error, req, res, next);

    expect(getJsonBody().error.stack).toBeDefined();
  });

  it('should NOT include stack trace in production mode', async () => {
    const loggerSpy = vi.fn().mockResolvedValue(undefined);

    // includeStack = false (production)
    const middleware = errorHandlerMiddleware(loggerSpy, false);
    const { req, res, next, getJsonBody } = createMockContext();
    const error = new BadRequestError('Prod error');

    await (middleware as any)(error, req, res, next);

    expect(getJsonBody().error.stack).toBeUndefined();
  });

  it('should include request ID and path in response', async () => {
    const loggerSpy = vi.fn().mockResolvedValue(undefined);

    const middleware = errorHandlerMiddleware(loggerSpy, false);
    const { req, res, next, getJsonBody } = createMockContext();
    const error = new NotFoundError('Not found');

    await (middleware as any)(error, req, res, next);

    expect(getJsonBody().error.requestId).toBe('test-request-id');
    expect(getJsonBody().error.path).toBe('/test');
  });

  it('should include validation errors in response', async () => {
    const loggerSpy = vi.fn().mockResolvedValue(undefined);

    const middleware = errorHandlerMiddleware(loggerSpy, false);
    const { req, res, next, getStatusCode, getJsonBody } = createMockContext();
    const details = [{ path: 'email', message: 'Invalid', code: 'invalid_string' }];
    const error = new ValidationError('Validation failed', details);

    await (middleware as any)(error, req, res, next);

    expect(getStatusCode()).toBe(422);
    expect(getJsonBody().error.details).toEqual(details);
  });
});
