/**
 * Integration specification tests: two auth providers in one application.
 *
 * These tests prove that two `createAuthPlugin()` instances with distinct
 * service names route each request to their own principal, and that a route
 * selects its provider through the principal service it names. They are
 * derived from the specification: a failing case means the implementation is
 * wrong.
 *
 * @packageDocumentation
 */

import { describe, test, expect, afterEach } from 'vitest';
import supertest from 'supertest';
import { WebApplication, BaseController } from '@blendsdk/webafx';
import type { RouteDefinition } from '@blendsdk/webafx';
import { createAuthPlugin } from '../src/auth-plugin.js';
import { MemoryAuthProvider } from '../src/memory-auth-provider.js';
import type { AuthResult } from '../src/types.js';

/** Token recognised only by the user provider. */
const USER_TOKEN = 'user-token';

/** Token recognised only by the client provider. */
const CLIENT_TOKEN = 'client-token';

/** Principal returned for {@link USER_TOKEN}. */
const USER_RESULT: AuthResult = {
  sub: 'user-1',
  claims: { kind: 'user' },
  token: USER_TOKEN,
};

/** Principal returned for {@link CLIENT_TOKEN}. */
const CLIENT_RESULT: AuthResult = {
  sub: 'client-1',
  claims: { kind: 'client' },
  token: CLIENT_TOKEN,
};

/**
 * One application with a human route (default principal service) and a
 * machine route (the `client` principal service).
 */
class MultiProviderController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.authenticated()
        .get('/mp/user')
        .handle(async (req, res) => {
          const user = await req.services.get<AuthResult>('user', undefined);
          this.ok(res, { sub: user?.sub });
        }),

      this.route()
        .get('/mp/client')
        .secure('client')
        .handle(async (req, res) => {
          const client = await req.services.get<AuthResult>('client', undefined);
          this.ok(res, { sub: client?.sub });
        }),
    ];
  }
}

/**
 * Creates an application with two auth plugins.
 *
 * The plugin and singleton service names must be distinct for both plugins to
 * install; `userServiceName` selects the principal each one registers.
 */
function createTestApp(): WebApplication {
  const app = new WebApplication({
    PORT: 0,
    ENV_MODE: 'test',
    LOG_LEVEL: 'ERROR',
  });

  app.use(
    createAuthPlugin(
      new MemoryAuthProvider({ validTokens: { [USER_TOKEN]: USER_RESULT } }),
      { serviceName: 'user-auth', userServiceName: 'user' }
    )
  );

  app.use(
    createAuthPlugin(
      new MemoryAuthProvider({ validTokens: { [CLIENT_TOKEN]: CLIENT_RESULT } }),
      { serviceName: 'client-auth', userServiceName: 'client' }
    )
  );

  app.registerController('', MultiProviderController);
  return app;
}

describe('Multiple auth providers — Specification Tests', () => {
  let shutdown: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = null;
    }
  });

  test('a route naming the client service accepts the client token', async () => {
    const app = createTestApp();
    shutdown = await app.start();

    const res = await supertest(app.express)
      .get('/mp/client')
      .set('Authorization', `Bearer ${CLIENT_TOKEN}`)
      .expect(200);

    expect(res.body.data).toEqual({ sub: 'client-1' });
  });

  test('a route naming the client service rejects the user token', async () => {
    const app = createTestApp();
    shutdown = await app.start();

    await supertest(app.express)
      .get('/mp/client')
      .set('Authorization', `Bearer ${USER_TOKEN}`)
      .expect(401);
  });

  test('the default route rejects the client token', async () => {
    const app = createTestApp();
    shutdown = await app.start();

    await supertest(app.express)
      .get('/mp/user')
      .set('Authorization', `Bearer ${CLIENT_TOKEN}`)
      .expect(401);
  });

  test('the default route accepts the user token', async () => {
    const app = createTestApp();
    shutdown = await app.start();

    const res = await supertest(app.express)
      .get('/mp/user')
      .set('Authorization', `Bearer ${USER_TOKEN}`)
      .expect(200);

    expect(res.body.data).toEqual({ sub: 'user-1' });
  });
});
