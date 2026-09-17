import { describe, test, expect, vi } from 'vitest';
import {
  createApiClient,
  CookieSessionAuth,
  BearerAuth,
  ApiKeyAuth,
  OidcClientCredentialsAuth,
  ApiError,
  ApiTransportError,
  type AdapterRequest,
  type AdapterResponse,
  type RequestAdapter,
} from '../src/index.js';

/**
 * Behavioural contract for the framework-agnostic API client runtime.
 *
 * These tests are written against the public behaviour only: they drive a stub
 * transport adapter (the true external boundary) and assert the URL, method,
 * headers, error mapping, retry policy, and envelope handling a caller observes.
 */

/** A transport adapter that records every request and returns canned responses. */
class StubAdapter implements RequestAdapter {
  /** Every request the runtime submitted, in order. */
  readonly requests: AdapterRequest[] = [];

  /**
   * @param responder - Produces the response for each submitted request.
   */
  constructor(
    private readonly responder: (
      request: AdapterRequest
    ) => AdapterResponse | Promise<AdapterResponse>
  ) {}

  /**
   * Records and answers one request.
   *
   * @param request - The built request.
   * @returns The canned response.
   */
  async send(request: AdapterRequest): Promise<AdapterResponse> {
    this.requests.push(request);
    return this.responder(request);
  }
}

/**
 * Builds a successful data-envelope response.
 *
 * @param data - The payload to wrap.
 * @returns A 200 response with the standard success envelope.
 */
function dataResponse(data: unknown): AdapterResponse {
  return { status: 200, ok: true, body: { success: true, data } };
}

const getProduct = {
  method: 'get',
  path: '/api/products/{id}',
  envelope: 'data' as const,
  operationId: 'getProduct',
};

describe('runtime request execution', () => {
  test('builds the absolute URL and method from the operation', async () => {
    const adapter = new StubAdapter(() => dataResponse({ id: 42 }));
    const client = createApiClient({ baseUrl: 'https://api.example.com', adapter });

    await client.request(getProduct, { id: 42 });

    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0].method).toBe('GET');
    expect(adapter.requests[0].url).toBe('https://api.example.com/api/products/42');
  });

  test('uses the per-call base URL over the client default', async () => {
    const adapter = new StubAdapter(() => dataResponse({}));
    const client = createApiClient({ baseUrl: 'https://default.example.com', adapter });

    await client.request(getProduct, { id: 1 }, { baseUrl: 'https://override.example.com' });

    expect(adapter.requests[0].url).toBe('https://override.example.com/api/products/1');
  });

  test('serializes array query parameters as repeated keys', async () => {
    const adapter = new StubAdapter(() => dataResponse({}));
    const client = createApiClient({ baseUrl: 'https://api.example.com', adapter });

    await client.request(
      { method: 'get', path: '/api/search', envelope: 'data', operationId: 'search' },
      { tag: ['a', 'b'] }
    );

    expect(adapter.requests[0].url).toBe('https://api.example.com/api/search?tag=a&tag=b');
  });

  test('encodes path parameters', async () => {
    const adapter = new StubAdapter(() => dataResponse({}));
    const client = createApiClient({ baseUrl: 'https://api.example.com', adapter });

    await client.request(getProduct, { id: 'a/b c' });

    expect(adapter.requests[0].url).toBe('https://api.example.com/api/products/a%2Fb%20c');
  });

  test('declares a JSON content type and body for writes', async () => {
    const adapter = new StubAdapter(() => dataResponse({}));
    const client = createApiClient({ baseUrl: 'https://api.example.com', adapter });

    await client.request(
      { method: 'post', path: '/api/products', envelope: 'data', operationId: 'createProduct' },
      { name: 'Widget' }
    );

    expect(adapter.requests[0].headers['content-type']).toBe('application/json');
    expect(adapter.requests[0].body).toBe(JSON.stringify({ name: 'Widget' }));
  });

  test('rejects a missing path parameter instead of silently dropping it', async () => {
    const adapter = new StubAdapter(() => dataResponse({}));
    const client = createApiClient({ baseUrl: 'https://api.example.com', adapter });

    await expect(client.request(getProduct, {})).rejects.toThrow(/id/);
    expect(adapter.requests).toHaveLength(0);
  });

  test('omits undefined query parameters', async () => {
    const adapter = new StubAdapter(() => dataResponse({}));
    const client = createApiClient({ baseUrl: 'https://api.example.com', adapter });

    await client.request(
      { method: 'get', path: '/api/search', envelope: 'data', operationId: 'search' },
      { q: undefined, tag: 'a' }
    );

    expect(adapter.requests[0].url).toBe('https://api.example.com/api/search?tag=a');
  });
});

describe('runtime envelope handling', () => {
  test('unwraps the data property for a data envelope', async () => {
    const adapter = new StubAdapter(() => dataResponse({ id: 42, name: 'Widget' }));
    const client = createApiClient({ baseUrl: 'https://x', adapter });

    const result = await client.request<{ id: number; name: string }>(getProduct, { id: 42 });

    expect(result).toEqual({ id: 42, name: 'Widget' });
  });

  test('returns the whole body for a body envelope so pagination survives', async () => {
    const body = {
      success: true,
      data: [{ id: 1 }],
      pagination: { total: 1, page: 1, limit: 10, pages: 1 },
    };
    const adapter = new StubAdapter(() => ({ status: 200, ok: true, body }));
    const client = createApiClient({ baseUrl: 'https://x', adapter });

    const result = await client.request<typeof body>(
      { method: 'get', path: '/api/products', envelope: 'body', operationId: 'listProducts' },
      {}
    );

    expect(result).toEqual(body);
    expect(result.pagination.page).toBe(1);
  });

  test('returns the body unchanged for a data envelope without a data property', async () => {
    const adapter = new StubAdapter(() => ({ status: 200, ok: true, body: { value: 1 } }));
    const client = createApiClient({ baseUrl: 'https://x', adapter });

    const result = await client.request<{ value: number }>(getProduct, { id: 1 });

    expect(result).toEqual({ value: 1 });
  });

  test('returns a non-object body for a data envelope', async () => {
    const adapter = new StubAdapter(() => ({ status: 200, ok: true, body: 'plain text' }));
    const client = createApiClient({ baseUrl: 'https://x', adapter });

    const result = await client.request<string>(getProduct, { id: 1 });

    expect(result).toBe('plain text');
  });
});

describe('runtime error mapping', () => {
  test('throws an ApiError carrying the server envelope', async () => {
    const adapter = new StubAdapter(() => ({
      status: 400,
      ok: false,
      body: {
        success: false,
        error: { code: 'invalid_input', message: 'Bad input', statusCode: 400 },
      },
    }));
    const client = createApiClient({ baseUrl: 'https://x', adapter });

    const error = await client.request(getProduct, { id: 1 }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('invalid_input');
    expect((error as ApiError).message).toBe('Bad input');
    expect((error as ApiError).statusCode).toBe(400);
    expect((error as ApiError).operationId).toBe('getProduct');
  });

  test('throws an ApiTransportError when the adapter rejects', async () => {
    const adapter = new StubAdapter(() => {
      throw new Error('socket hang up');
    });
    const client = createApiClient({ baseUrl: 'https://x', adapter });

    const error = await client.request(getProduct, { id: 1 }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiTransportError);
    expect((error as ApiTransportError).operationId).toBe('getProduct');
  });

  test('maps an abort to an ApiTransportError and does not retry', async () => {
    const controller = new AbortController();
    const adapter = new StubAdapter(
      request =>
        new Promise<AdapterResponse>((_resolve, reject) => {
          const signal = request.signal;
          if (!signal || signal.aborted) {
            reject(new Error('aborted'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const auth = new BearerAuth({ getToken: async () => 'token', refresh: async () => 'token' });
    const client = createApiClient({ baseUrl: 'https://x', adapter, auth });

    const promise = client.request(getProduct, { id: 1 }, { signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();
    const error = await promise.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiTransportError);
    expect(adapter.requests).toHaveLength(1);
  });

  test('does not retry a non-401 error', async () => {
    const adapter = new StubAdapter(() => ({
      status: 500,
      ok: false,
      body: { success: false, error: { code: 'boom', message: 'boom', statusCode: 500 } },
    }));
    const auth = new BearerAuth({ getToken: async () => 'token', refresh: async () => 'token' });
    const client = createApiClient({ baseUrl: 'https://x', adapter, auth });

    await expect(client.request(getProduct, { id: 1 })).rejects.toBeInstanceOf(ApiError);
    expect(adapter.requests).toHaveLength(1);
  });

  test('surfaces a failed refresh as a typed, redacted transport error', async () => {
    const adapter = new StubAdapter(() => ({
      status: 401,
      ok: false,
      body: { success: false, error: { code: 'unauthorized', message: 'no', statusCode: 401 } },
    }));
    const auth = new BearerAuth({
      getToken: async () => 'token',
      refresh: async () => {
        throw new Error('refresh failed Bearer secret.refresh.token');
      },
    });
    const client = createApiClient({ baseUrl: 'https://x', adapter, auth });

    const error = await client.request(getProduct, { id: 1 }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiTransportError);
    expect((error as ApiTransportError).message).not.toContain('secret.refresh.token');
    expect(adapter.requests).toHaveLength(1);
  });
});

describe('authentication strategies', () => {
  test('CookieSessionAuth marks the request to include credentials', async () => {
    const adapter = new StubAdapter(() => dataResponse({}));
    const client = createApiClient({
      baseUrl: 'https://x',
      adapter,
      auth: new CookieSessionAuth(),
    });

    await client.request(getProduct, { id: 1 });

    expect(adapter.requests[0].credentials).toBe('include');
  });

  test('BearerAuth sends the token and refreshes once on 401, then retries', async () => {
    let calls = 0;
    const refresh = vi.fn(async () => 'new-token');
    const adapter = new StubAdapter(() => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 401,
          ok: false,
          body: { success: false, error: { code: 'unauthorized', message: 'no', statusCode: 401 } },
        };
      }
      return dataResponse({ ok: true });
    });
    const auth = new BearerAuth({ getToken: async () => 'old-token', refresh });
    const client = createApiClient({ baseUrl: 'https://x', adapter, auth });

    const result = await client.request<{ ok: boolean }>(getProduct, { id: 1 });

    expect(result).toEqual({ ok: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1].headers.Authorization).toBe('Bearer new-token');
  });

  test('concurrent 401s trigger a single refresh', async () => {
    let refreshCalls = 0;
    let token = 'old';
    const refresh = vi.fn(async () => {
      refreshCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 5));
      token = 'new';
      return token;
    });
    const adapter = new StubAdapter(request =>
      request.headers.Authorization === 'Bearer new'
        ? dataResponse({ ok: true })
        : {
            status: 401,
            ok: false,
            body: {
              success: false,
              error: { code: 'unauthorized', message: 'no', statusCode: 401 },
            },
          }
    );
    const auth = new BearerAuth({ getToken: async () => token, refresh });
    const client = createApiClient({ baseUrl: 'https://x', adapter, auth });

    const [first, second] = await Promise.all([
      client.request<{ ok: boolean }>(getProduct, { id: 1 }),
      client.request<{ ok: boolean }>(getProduct, { id: 2 }),
    ]);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(refreshCalls).toBe(1);
  });

  test('ApiKeyAuth sends the key in a header by default', async () => {
    const adapter = new StubAdapter(() => dataResponse({}));
    const client = createApiClient({
      baseUrl: 'https://x',
      adapter,
      auth: new ApiKeyAuth({ key: 'secret-key' }),
    });

    await client.request(getProduct, { id: 1 });

    expect(adapter.requests[0].headers['X-API-Key']).toBe('secret-key');
  });

  test('ApiKeyAuth warns when query placement is requested', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = new StubAdapter(() => dataResponse({}));
    const client = createApiClient({
      baseUrl: 'https://x',
      adapter,
      auth: new ApiKeyAuth({ key: 'secret-key', in: 'query' }),
    });

    await client.request(getProduct, { id: 1 });

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('OidcClientCredentialsAuth refuses to run in a browser', () => {
    const original = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {};
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
      (globalThis as { window?: unknown }).window = original;
    }
  });
});

describe('runtime exports', () => {
  test('exposes the client factory and error classes', () => {
    expect(typeof createApiClient).toBe('function');
    expect(typeof ApiError).toBe('function');
    expect(typeof ApiTransportError).toBe('function');
  });
});
