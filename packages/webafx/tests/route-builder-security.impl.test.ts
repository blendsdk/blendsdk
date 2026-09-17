/**
 * Implementation tests for route security helpers.
 *
 * These tests cover the RouteBuilder.secure() storage contract and the guard's
 * fail-closed handling of a hand-built route definition — edge cases and
 * internals that the specification tests do not exercise directly.
 *
 * @packageDocumentation
 */

import { describe, test, expect, afterEach } from 'vitest';
import supertest from 'supertest';
import { RouteBuilder } from '../src/application/route-builder.js';
import type { RouteDefinition } from '../src/application/route-builder.js';
import { WebApplication } from '../src/application/web-application.js';
import { BaseController } from '../src/application/base-controller.js';

/** The exact error contract for a blank service name. */
const BLANK_NAME_ERROR = 'secure() requires a non-empty user service name';

describe('Implementation: RouteBuilder.secure', () => {
  test('stores true when called without a service name', () => {
    const definition = new RouteBuilder()
      .get('/a')
      .secure()
      .handle(async () => {});

    expect(definition.secure).toBe(true);
  });

  test('stores the given service name', () => {
    const definition = new RouteBuilder()
      .get('/a')
      .secure('client')
      .handle(async () => {});

    expect(definition.secure).toBe('client');
  });

  test('trims surrounding whitespace from the service name', () => {
    const definition = new RouteBuilder()
      .get('/a')
      .secure('  client  ')
      .handle(async () => {});

    expect(definition.secure).toBe('client');
  });

  test('throws on an empty service name', () => {
    expect(() => new RouteBuilder().get('/a').secure('')).toThrow(BLANK_NAME_ERROR);
  });

  test('throws on a whitespace-only service name', () => {
    expect(() => new RouteBuilder().get('/a').secure('   ')).toThrow(BLANK_NAME_ERROR);
  });

  test('treats an explicit undefined as no argument', () => {
    const definition = new RouteBuilder()
      .get('/a')
      .secure(undefined)
      .handle(async () => {});

    expect(definition.secure).toBe(true);
  });
});

/**
 * Controller with hand-built route definitions, bypassing the builder.
 * Used to prove the guard fails closed on a blank `secure` value.
 */
class ManualSecurityController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      {
        method: 'get',
        path: '/manual/blank',
        // A blank name marks the route secure, but resolves no principal.
        secure: '',
        handler: async (_req, res) => {
          this.ok(res, { reached: true });
        },
      },
      {
        method: 'get',
        path: '/manual/public',
        // No secure field at all: the route stays public.
        handler: async (_req, res) => {
          this.ok(res, { reached: true });
        },
      },
    ];
  }
}

describe('Implementation: guard with hand-built route definitions', () => {
  let shutdown: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (shutdown) {
      await shutdown();
      shutdown = null;
    }
  });

  test('a hand-built blank secure value fails closed with 401', async () => {
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });
    app.registerController('', ManualSecurityController);
    shutdown = await app.start();

    await supertest(app.express).get('/manual/blank').expect(401);
  });

  test('a hand-built route with no secure value stays public', async () => {
    const app = new WebApplication({ PORT: 0, ENV_MODE: 'test', LOG_LEVEL: 'ERROR' });
    app.registerController('', ManualSecurityController);
    shutdown = await app.start();

    const res = await supertest(app.express).get('/manual/public').expect(200);

    expect(res.body.data).toEqual({ reached: true });
  });
});
