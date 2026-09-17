import { describe, test, expect, vi } from 'vitest';
import { TokenStore, type TokenResult } from '../src/index.js';

/**
 * Implementation tests for token caching and single-flight refresh.
 */
describe('TokenStore', () => {
  test('caches a token until it is close to expiry', async () => {
    const fetchToken = vi.fn(async (): Promise<TokenResult> => ({
      token: 'one',
      expiresAt: 10_000,
    }));
    const store = new TokenStore(fetchToken, { now: () => 0, skewMs: 1000 });

    expect(await store.get()).toBe('one');
    expect(await store.get()).toBe('one');
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  test('refreshes only once the token enters the expiry skew', async () => {
    let clock = 0;
    let calls = 0;
    const fetchToken = vi.fn(async (): Promise<TokenResult> => {
      calls += 1;
      return { token: `token-${calls}`, expiresAt: 10_000 };
    });
    const store = new TokenStore(fetchToken, { now: () => clock, skewMs: 1000 });

    expect(await store.get()).toBe('token-1');
    clock = 8_000;
    expect(await store.get()).toBe('token-1');
    clock = 9_500;
    expect(await store.get()).toBe('token-2');
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  test('collapses concurrent refreshes into one token request', async () => {
    const fetchToken = vi.fn(async (): Promise<TokenResult> => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return { token: 'shared', expiresAt: 10_000 };
    });
    const store = new TokenStore(fetchToken, { now: () => 0 });

    const [a, b, c] = await Promise.all([store.get(), store.get(), store.get()]);

    expect([a, b, c]).toEqual(['shared', 'shared', 'shared']);
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  test('propagates a refresh failure and retries on the next call', async () => {
    let calls = 0;
    const fetchToken = vi.fn(async (): Promise<TokenResult> => {
      calls += 1;
      if (calls === 1) {
        throw new Error('idp unavailable');
      }
      return { token: 'recovered', expiresAt: 10_000 };
    });
    const store = new TokenStore(fetchToken, { now: () => 0 });

    await expect(store.get()).rejects.toThrow('idp unavailable');
    expect(await store.get()).toBe('recovered');
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  test('shares one rejection across concurrent callers', async () => {
    const fetchToken = vi.fn(async (): Promise<TokenResult> => {
      await new Promise(resolve => setTimeout(resolve, 5));
      throw new Error('boom');
    });
    const store = new TokenStore(fetchToken, { now: () => 0 });

    const results = await Promise.allSettled([store.get(), store.get()]);

    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });
});
