import { describe, test, expect } from 'vitest';
import { BearerAuth, OidcClientCredentialsAuth, type AdapterRequest } from '../src/index.js';

/**
 * Implementation tests for the authentication strategies' internals: the bearer
 * token reuse window and invalidation, and the OIDC runtime/endpoint guards.
 */

/** A minimal request used to observe what a strategy applies. */
const sampleRequest: AdapterRequest = { url: 'https://x/api', method: 'GET', headers: {} };

describe('BearerAuth token reuse', () => {
  test('reuses a refreshed token within the reuse window', async () => {
    const auth = new BearerAuth({
      getToken: async () => 'old',
      refresh: async () => 'new',
      now: () => 0,
      refreshedTokenTtlMs: 1000,
    });

    await auth.refreshOnUnauthorized();
    const applied = await auth.apply(sampleRequest);

    expect(applied.headers.Authorization).toBe('Bearer new');
  });

  test('falls back to getToken once the reuse window has passed', async () => {
    let clock = 0;
    const auth = new BearerAuth({
      getToken: async () => 'old',
      refresh: async () => 'new',
      now: () => clock,
      refreshedTokenTtlMs: 1000,
    });

    await auth.refreshOnUnauthorized();
    clock = 5000;
    const applied = await auth.apply(sampleRequest);

    expect(applied.headers.Authorization).toBe('Bearer old');
  });

  test('invalidate drops the refreshed token immediately', async () => {
    const auth = new BearerAuth({
      getToken: async () => 'old',
      refresh: async () => 'new',
      now: () => 0,
    });

    await auth.refreshOnUnauthorized();
    auth.invalidate();
    const applied = await auth.apply(sampleRequest);

    expect(applied.headers.Authorization).toBe('Bearer old');
  });

  test('reports no refresh when no refresh function is provided', async () => {
    const auth = new BearerAuth({ getToken: async () => 'old' });

    expect(await auth.refreshOnUnauthorized()).toBe(false);
  });
});

describe('OidcClientCredentialsAuth guards', () => {
  test('rejects an insecure non-loopback endpoint', () => {
    expect(
      () =>
        new OidcClientCredentialsAuth({
          tokenEndpoint: 'http://idp.example.com/token',
          clientId: 'id',
          clientSecret: 'secret',
        })
    ).toThrow(/https/);
  });

  test('allows a loopback http endpoint for development', () => {
    expect(
      () =>
        new OidcClientCredentialsAuth({
          tokenEndpoint: 'http://localhost:8080/token',
          clientId: 'id',
          clientSecret: 'secret',
        })
    ).not.toThrow();
  });

  test('throws in a worker-like runtime without window', () => {
    const runtime = globalThis as { WorkerGlobalScope?: unknown };
    const original = runtime.WorkerGlobalScope;
    runtime.WorkerGlobalScope = class {};
    try {
      expect(
        () =>
          new OidcClientCredentialsAuth({
            tokenEndpoint: 'https://idp/token',
            clientId: 'id',
            clientSecret: 'secret',
          })
      ).toThrow();
    } finally {
      runtime.WorkerGlobalScope = original;
    }
  });
});
