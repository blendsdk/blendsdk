/**
 * Specification tests for route-level principal selection.
 *
 * These tests encode the expected behavior of routes that choose which
 * container service holds the authenticated principal. They are derived from
 * the specification, not from the implementation: a failing case means the
 * implementation is wrong.
 *
 * @packageDocumentation
 */

import { describe, test, expect, afterEach, beforeEach } from 'vitest';
import supertest from 'supertest';
import { WebApplication } from '../src/application/web-application.js';
import { BaseController } from '../src/application/base-controller.js';
import { RouteDefinition } from '../src/application/route-builder.js';

/** Minimal principal shape used by the test services. */
interface TestPrincipal {
  sub: string;
  kind: 'user' | 'client';
}

/**
 * The principal most recently passed to an `authorize` callback.
 * Reset before each test so a case cannot observe another case's value.
 */
let authorizedPrincipal: TestPrincipal | undefined;

/**
 * Controller exercising every principal-selection form in one application.
 */
class SecurePrincipalController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      // A public route resolves no principal and is always reachable.
      this.route()
        .get('/spec/public')
        .handle(async (_req, res) => {
          this.ok(res, { public: true });
        }),

      // No-argument secure() uses the default 'user' service.
      this.route()
        .get('/spec/default')
        .secure()
        .handle(async (req, res) => {
          const user = await req.services.get<TestPrincipal>('user', undefined);
          this.ok(res, { sub: user?.sub, kind: user?.kind });
        }),

      // No-argument authenticated() is the same as secure().
      this.authenticated()
        .get('/spec/authenticated')
        .handle(async (req, res) => {
          const user = await req.services.get<TestPrincipal>('user', undefined);
          this.ok(res, { sub: user?.sub, kind: user?.kind });
        }),

      // A named service is resolved instead of the default.
      this.route()
        .get('/spec/client')
        .secure('client')
        .handle(async (req, res) => {
          const client = await req.services.get<TestPrincipal>('client', undefined);
          this.ok(res, { sub: client?.sub, kind: client?.kind });
        }),

      // authenticated(name) is the same as secure(name).
      this.authenticated('client')
        .get('/spec/client-authenticated')
        .handle(async (req, res) => {
          const client = await req.services.get<TestPrincipal>('client', undefined);
          this.ok(res, { sub: client?.sub, kind: client?.kind });
        }),

      // A secure route naming a service that is not registered must reject.
      this.route()
        .get('/spec/unknown')
        .secure('unknown-principal')
        .handle(async (_req, res) => {
          this.ok(res, { ok: true });
        }),

      // authorize() receives the principal of the service the route selected.
      this.authenticated('client')
        .get('/spec/authorize-client')
        .authorize((_req, principal: TestPrincipal) => {
          authorizedPrincipal = principal;
          return true;
        })
        .handle(async (_req, res) => {
          this.ok(res, { authorized: true });
        }),

      // A rejected authorization is a 403 (the principal was present).
      this.authenticated('client')
        .get('/spec/forbidden')
        .authorize(() => false)
        .handle(async (_req, res) => {
          this.ok(res, { authorized: true });
        }),
    ];
  }
}

/**
 * Creates a test application with two independent principal services.
 *
 * The 'user' service returns a principal only when the `x-user: ok` header is
 * present; the 'client' service returns a principal only for `x-client: ok`.
 * Both are per-request services, so each request resolves its own principal.
 */
function createTestApp(): WebApplication {
  const app = new WebApplication({
    PORT: 0,
    ENV_MODE: 'test',
    LOG_LEVEL: 'ERROR',
  });

  app.registerService({
    name: 'user',
    type: 'per-request',
    factory: (_container, _settings, req) => {
      if (req.headers['x-user'] === 'ok') {
        return { sub: 'user-1', kind: 'user' } satisfies TestPrincipal;
      }
      return undefined;
    },
  });

  app.registerService({
    name: 'client',
    type: 'per-request',
    factory: (_container, _settings, req) => {
      if (req.headers['x-client'] === 'ok') {
        return { sub: 'client-1', kind: 'client' } satisfies TestPrincipal;
      }
      return undefined;
    },
  });

  app.registerController('', SecurePrincipalController);
  return app;
}

describe('Route-level principal selection — Specification Tests', () => {
  let shutdown: (() => Promise<void>) | null = null;

  beforeEach(() => {
    authorizedPrincipal = undefined;
  });

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = null;
    }
  });

  test('a no-argument secure route resolves the default user service', async () => {
    const app = createTestApp();
    shutdown = await app.start();

    const res = await supertest(app.express)
      .get('/spec/default')
      .set('x-user', 'ok')
      .expect(200);

    expect(res.body.data).toEqual({ sub: 'user-1', kind: 'user' });
  });

  test('a no-argument authenticated route resolves the default user service', async () => {
    const app = createTestApp();
    shutdown = await app.start();

    const res = await supertest(app.express)
      .get('/spec/authenticated')
      .set('x-user', 'ok')
      .expect(200);

    expect(res.body.data).toEqual({ sub: 'user-1', kind: 'user' });
  });

  test('a named secure route resolves the named service', async () => {
    const app = createTestApp();
    shutdown = await app.start();

    const res = await supertest(app.express)
      .get('/spec/client')
      .set('x-client', 'ok')
      .expect(200);

    expect(res.body.data).toEqual({ sub: 'client-1', kind: 'client' });
  });

  test('a named authenticated route resolves the named service', async () => {
    const app = createTestApp();
    shutdown = await app.start();

    const res = await supertest(app.express)
      .get('/spec/client-authenticated')
      .set('x-client', 'ok')
      .expect(200);

    expect(res.body.data).toEqual({ sub: 'client-1', kind: 'client' });
  });

  test('a secure route naming an unregistered service is rejected with 401', async () => {
    const app = createTestApp();
    shutdown = await app.start();

    await supertest(app.express)
      .get('/spec/unknown')
      .set('x-user', 'ok')
      .set('x-client', 'ok')
      .expect(401);
  });

  test('a secure route whose named service yields no principal is rejected with 401', async () => {
    const app = createTestApp();
    shutdown = await app.start();

    await supertest(app.express).get('/spec/client').expect(401);
  });

  test('authorize receives the principal selected by the route', async () => {
    const app = createTestApp();
    shutdown = await app.start();

    await supertest(app.express)
      .get('/spec/authorize-client')
      .set('x-user', 'ok')
      .set('x-client', 'ok')
      .expect(200);

    expect(authorizedPrincipal).toEqual({ sub: 'client-1', kind: 'client' });
  });

  test('an authorize callback that returns false is rejected with 403', async () => {
    const app = createTestApp();
    shutdown = await app.start();

    await supertest(app.express)
      .get('/spec/forbidden')
      .set('x-client', 'ok')
      .expect(403);
  });

  test('two routes in one application resolve their own principals', async () => {
    const app = createTestApp();
    shutdown = await app.start();

    // Each route presents only its own credential: the default route must
    // authenticate through the user service, the named route through client.
    const userRoute = await supertest(app.express)
      .get('/spec/default')
      .set('x-user', 'ok')
      .expect(200);

    const clientRoute = await supertest(app.express)
      .get('/spec/client')
      .set('x-client', 'ok')
      .expect(200);

    expect(userRoute.body.data).toEqual({ sub: 'user-1', kind: 'user' });
    expect(clientRoute.body.data).toEqual({ sub: 'client-1', kind: 'client' });
  });

  test('a public route is reachable without any principal service', async () => {
    const app = createTestApp();
    shutdown = await app.start();

    const res = await supertest(app.express).get('/spec/public').expect(200);

    expect(res.body.data).toEqual({ public: true });
  });
});
