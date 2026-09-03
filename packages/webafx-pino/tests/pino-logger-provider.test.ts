import { Writable } from 'node:stream';
import { describe, it, expect, afterEach } from 'vitest';
import {
  PinoLoggerProvider,
  normalizeLevel,
  LoggerProvider,
  DEFAULT_SERVICE_NAME,
  DEFAULT_REDACT_PATHS,
} from '../src/index.js';

// ── Test Helper: Log Collector Stream ────────────────────────────────────

/**
 * Creates a writable stream that collects log entries as parsed JSON objects.
 * Per testing strategy: capture pino output via writable streams.
 */
function createLogCollector(): { stream: Writable; entries: any[] } {
  const entries: any[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      try {
        entries.push(JSON.parse(chunk.toString()));
      } catch {
        entries.push(chunk.toString());
      }
      callback();
    },
  });
  return { stream, entries };
}

/** Create a provider with output capture */
function createTestProvider(
  overrides?: Record<string, unknown>,
): { provider: PinoLoggerProvider; entries: any[] } {
  const { stream, entries } = createLogCollector();
  const provider = new PinoLoggerProvider({
    level: 'trace', // capture all levels by default
    destination: stream,
    ...overrides,
  } as any);
  return { provider, entries };
}

// ── Cleanup ──────────────────────────────────────────────────────────────

let activeProvider: PinoLoggerProvider | null = null;

afterEach(async () => {
  if (activeProvider) {
    await activeProvider.shutdown();
    activeProvider = null;
  }
});

// ── normalizeLevel ───────────────────────────────────────────────────────

describe('normalizeLevel', () => {
  it('should pass through valid lowercase levels', () => {
    expect(normalizeLevel('info')).toBe('info');
    expect(normalizeLevel('debug')).toBe('debug');
    expect(normalizeLevel('error')).toBe('error');
    expect(normalizeLevel('warn')).toBe('warn');
    expect(normalizeLevel('fatal')).toBe('fatal');
    expect(normalizeLevel('trace')).toBe('trace');
    expect(normalizeLevel('silent')).toBe('silent');
  });

  it('should convert uppercase levels to lowercase', () => {
    expect(normalizeLevel('INFO')).toBe('info');
    expect(normalizeLevel('DEBUG')).toBe('debug');
    expect(normalizeLevel('ERROR')).toBe('error');
    expect(normalizeLevel('WARN')).toBe('warn');
  });

  it('should convert mixed-case levels to lowercase', () => {
    expect(normalizeLevel('Info')).toBe('info');
    expect(normalizeLevel('Debug')).toBe('debug');
  });

  it('should fall back to info for unrecognized levels', () => {
    expect(normalizeLevel('verbose')).toBe('info');
    expect(normalizeLevel('CRITICAL')).toBe('info');
    expect(normalizeLevel('')).toBe('info');
    expect(normalizeLevel('garbage')).toBe('info');
  });
});

// ── PinoLoggerProvider — construction ────────────────────────────────────

describe('PinoLoggerProvider', () => {
  describe('construction', () => {
    it('should create with default config', () => {
      const provider = new PinoLoggerProvider();
      activeProvider = provider;
      expect(provider).toBeInstanceOf(PinoLoggerProvider);
      expect(provider).toBeInstanceOf(LoggerProvider);
      expect(provider.serviceName).toBe(DEFAULT_SERVICE_NAME);
    });

    it('should accept custom service name', () => {
      const provider = new PinoLoggerProvider({ serviceName: 'custom-logger' });
      activeProvider = provider;
      expect(provider.serviceName).toBe('custom-logger');
    });

    it('should accept custom log level (uppercase normalized)', () => {
      const { provider } = createTestProvider({ level: 'DEBUG' });
      activeProvider = provider;
      expect(provider).toBeInstanceOf(PinoLoggerProvider);
    });

    it('should accept custom redact paths', () => {
      const { provider } = createTestProvider({
        redact: ['req.headers.x-api-key'],
      });
      activeProvider = provider;
      expect(provider).toBeInstanceOf(PinoLoggerProvider);
    });

    it('should accept custom pino options', () => {
      const { provider } = createTestProvider({
        pinoOptions: { name: 'my-app' },
      });
      activeProvider = provider;
      expect(provider).toBeInstanceOf(PinoLoggerProvider);
    });
  });

  // ── Logger interface — structured JSON output ────────────────────────

  describe('Logger interface — structured JSON output', () => {
    it('info() produces JSON with message field', async () => {
      const { provider, entries } = createTestProvider();
      activeProvider = provider;
      await provider.info('hello world');
      expect(entries.length).toBe(1);
      expect(entries[0].msg).toBe('hello world');
      expect(entries[0].level).toBe(30); // pino info level
    });

    it('error() produces JSON with error level', async () => {
      const { provider, entries } = createTestProvider();
      activeProvider = provider;
      await provider.error('something failed');
      expect(entries.length).toBe(1);
      expect(entries[0].msg).toBe('something failed');
      expect(entries[0].level).toBe(50); // pino error level
    });

    it('warn() produces JSON with warn level', async () => {
      const { provider, entries } = createTestProvider();
      activeProvider = provider;
      await provider.warn('be careful');
      expect(entries.length).toBe(1);
      expect(entries[0].msg).toBe('be careful');
      expect(entries[0].level).toBe(40); // pino warn level
    });

    it('debug() produces JSON with debug level', async () => {
      const { provider, entries } = createTestProvider();
      activeProvider = provider;
      await provider.debug('debug details');
      expect(entries.length).toBe(1);
      expect(entries[0].msg).toBe('debug details');
      expect(entries[0].level).toBe(20); // pino debug level
    });

    it('info() with data merges data into JSON output', async () => {
      const { provider, entries } = createTestProvider();
      activeProvider = provider;
      await provider.info('server started', { port: 3000, host: 'localhost' });
      expect(entries.length).toBe(1);
      expect(entries[0].msg).toBe('server started');
      expect(entries[0].port).toBe(3000);
      expect(entries[0].host).toBe('localhost');
    });

    it('error() with data merges data into JSON output', async () => {
      const { provider, entries } = createTestProvider();
      activeProvider = provider;
      await provider.error('query failed', { table: 'users', duration: 150 });
      expect(entries[0].table).toBe('users');
      expect(entries[0].duration).toBe(150);
    });
  });

  // ── Log level filtering ──────────────────────────────────────────────

  describe('log level filtering', () => {
    it('should suppress debug messages when level is info', async () => {
      const { provider, entries } = createTestProvider({ level: 'info' });
      activeProvider = provider;
      await provider.debug('should not appear');
      await provider.info('should appear');
      expect(entries.length).toBe(1);
      expect(entries[0].msg).toBe('should appear');
    });

    it('should suppress info messages when level is warn', async () => {
      const { provider, entries } = createTestProvider({ level: 'warn' });
      activeProvider = provider;
      await provider.debug('nope');
      await provider.info('nope');
      await provider.warn('yes');
      await provider.error('yes');
      expect(entries.length).toBe(2);
      expect(entries[0].msg).toBe('yes');
      expect(entries[1].msg).toBe('yes');
    });

    it('should capture all levels when level is trace', async () => {
      const { provider, entries } = createTestProvider({ level: 'trace' });
      activeProvider = provider;
      await provider.debug('d');
      await provider.info('i');
      await provider.warn('w');
      await provider.error('e');
      expect(entries.length).toBe(4);
    });
  });

  // ── Redaction ────────────────────────────────────────────────────────

  describe('redaction', () => {
    it('should redact default paths (authorization header)', async () => {
      const { provider, entries } = createTestProvider();
      activeProvider = provider;
      await provider.info('request', {
        req: { headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' } },
      });
      expect(entries.length).toBe(1);
      // Redacted field should be replaced with [Redacted]
      expect(entries[0].req.headers.authorization).toBe('[Redacted]');
      expect(entries[0].req.headers['content-type']).toBe('application/json');
    });

    it('should redact default paths (cookie header)', async () => {
      const { provider, entries } = createTestProvider();
      activeProvider = provider;
      await provider.info('request', {
        req: { headers: { cookie: 'session=abc123' } },
      });
      expect(entries[0].req.headers.cookie).toBe('[Redacted]');
    });

    it('should redact custom paths', async () => {
      const { provider, entries } = createTestProvider({
        redact: ['user.password'],
      });
      activeProvider = provider;
      await provider.info('login', {
        user: { name: 'admin', password: 'secret123' },
      });
      expect(entries[0].user.name).toBe('admin');
      expect(entries[0].user.password).toBe('[Redacted]');
    });
  });

  // ── Lifecycle ────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('should report healthy', async () => {
      const { provider } = createTestProvider();
      activeProvider = provider;
      expect(await provider.health()).toBe(true);
    });

    it('should shutdown gracefully', async () => {
      const { provider } = createTestProvider();
      activeProvider = provider;
      await expect(provider.shutdown()).resolves.toBeUndefined();
      activeProvider = null; // already shut down
    });
  });

  // ── Request-scoped loggers ───────────────────────────────────────────

  describe('createRequestLogger', () => {
    it('should create a child logger with bindings in output', async () => {
      const { provider, entries } = createTestProvider();
      activeProvider = provider;
      const child = provider.createRequestLogger({ requestId: 'abc-123' });
      await child.info('handling request');
      expect(entries.length).toBe(1);
      expect(entries[0].msg).toBe('handling request');
      expect(entries[0].requestId).toBe('abc-123');
    });

    it('child logger includes data alongside bindings', async () => {
      const { provider, entries } = createTestProvider();
      activeProvider = provider;
      const child = provider.createRequestLogger({ requestId: 'req-456' });
      await child.info('processed', { duration: 42 });
      expect(entries[0].requestId).toBe('req-456');
      expect(entries[0].duration).toBe(42);
      expect(entries[0].msg).toBe('processed');
    });

    it('child inherits parent level', async () => {
      const { provider, entries } = createTestProvider({ level: 'warn' });
      activeProvider = provider;
      const child = provider.createRequestLogger({ requestId: 'test' });
      await child.debug('suppressed');
      await child.info('suppressed');
      await child.warn('visible');
      expect(entries.length).toBe(1);
      expect(entries[0].msg).toBe('visible');
    });

    it('multiple children are independent', async () => {
      const { provider, entries } = createTestProvider();
      activeProvider = provider;
      const child1 = provider.createRequestLogger({ requestId: 'req-1' });
      const child2 = provider.createRequestLogger({ requestId: 'req-2' });
      await child1.info('from child 1');
      await child2.info('from child 2');
      expect(entries.length).toBe(2);
      expect(entries[0].requestId).toBe('req-1');
      expect(entries[1].requestId).toBe('req-2');
    });

    it('child implements all Logger methods', async () => {
      const { provider, entries } = createTestProvider();
      activeProvider = provider;
      const child = provider.createRequestLogger({ requestId: 'test' });
      await child.info('i');
      await child.error('e');
      await child.warn('w');
      await child.debug('d');
      expect(entries.length).toBe(4);
    });
  });

  // ── getPinoInstance ──────────────────────────────────────────────────

  describe('getPinoInstance', () => {
    it('should expose the underlying pino instance', () => {
      const { provider } = createTestProvider();
      activeProvider = provider;
      const pinoInstance = provider.getPinoInstance();
      expect(pinoInstance).toBeDefined();
      expect(pinoInstance.info).toBeInstanceOf(Function);
      expect(pinoInstance.child).toBeInstanceOf(Function);
    });
  });
});

// ── Constants ────────────────────────────────────────────────────────────

describe('constants', () => {
  it('DEFAULT_SERVICE_NAME should be "logger"', () => {
    expect(DEFAULT_SERVICE_NAME).toBe('logger');
  });

  it('DEFAULT_REDACT_PATHS should include authorization and cookie', () => {
    expect(DEFAULT_REDACT_PATHS).toContain('req.headers.authorization');
    expect(DEFAULT_REDACT_PATHS).toContain('req.headers.cookie');
  });
});
