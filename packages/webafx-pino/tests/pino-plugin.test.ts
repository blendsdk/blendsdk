import { describe, it, expect } from 'vitest';
import {
  pinoLoggerPlugin,
  createLoggerPlugin,
  PinoLoggerProvider,
  DEFAULT_PLUGIN_PRIORITY,
} from '../src/index.js';

// ── pinoLoggerPlugin ─────────────────────────────────────────────────────

describe('pinoLoggerPlugin', () => {
  it('should return a valid PluginDefinition', () => {
    const plugin = pinoLoggerPlugin();
    expect(plugin).toBeDefined();
    expect(plugin.name).toBe('pino-logger');
    expect(plugin.factory).toBeInstanceOf(Function);
  });

  it('should use default priority', () => {
    const plugin = pinoLoggerPlugin();
    expect(plugin.priority).toBe(DEFAULT_PLUGIN_PRIORITY);
  });

  it('should accept custom priority', () => {
    const plugin = pinoLoggerPlugin({ priority: 10 });
    expect(plugin.priority).toBe(10);
  });

  it('should accept provider options', () => {
    const plugin = pinoLoggerPlugin({
      level: 'debug',
      pretty: false,
      redact: ['req.headers.x-custom'],
    });
    expect(plugin.name).toBe('pino-logger');
  });
});

// ── createLoggerPlugin ───────────────────────────────────────────────────

describe('createLoggerPlugin', () => {
  it('should wrap a PinoLoggerProvider in a PluginDefinition', () => {
    const provider = new PinoLoggerProvider({ level: 'silent' });
    const plugin = createLoggerPlugin(provider);
    expect(plugin).toBeDefined();
    expect(plugin.name).toBe('pino-logger');
    expect(plugin.factory).toBeInstanceOf(Function);
    expect(plugin.priority).toBe(DEFAULT_PLUGIN_PRIORITY);
  });

  it('should accept custom priority', () => {
    const provider = new PinoLoggerProvider({ level: 'silent' });
    const plugin = createLoggerPlugin(provider, { priority: 5 });
    expect(plugin.priority).toBe(5);
  });
});
