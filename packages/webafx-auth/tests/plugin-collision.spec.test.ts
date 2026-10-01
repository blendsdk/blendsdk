/**
 * Specification test for the motivating two-provider misconfiguration.
 *
 * Two createAuthPlugin() calls that both use the default serviceName produce the
 * same plugin name, so the second app.use() must fail at startup instead of
 * silently replacing the first.
 *
 * @packageDocumentation
 */

import { describe, it, expect } from 'vitest';
import { WebApplication } from '@blendsdk/webafx';

import { createAuthPlugin } from '../src/auth-plugin.js';
import { MemoryAuthProvider } from '../src/memory-auth-provider.js';

describe('Plugin name collision — Specification Tests', () => {
  it('rejects a second auth plugin that uses the default service name', () => {
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });

    app.use(createAuthPlugin(new MemoryAuthProvider()));

    expect(() => app.use(createAuthPlugin(new MemoryAuthProvider()))).toThrow(
      'Plugin "auth:auth" is already registered'
    );
  });
});
