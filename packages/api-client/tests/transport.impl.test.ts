import { describe, test, expect, vi, afterEach } from 'vitest';
import {
  createApiClient,
  createApiError,
  createTransportError,
  FetchAdapter,
  redactSensitive,
  type AdapterRequest,
  type AdapterResponse,
  type AuthStrategy,
  type RequestAdapter,
} from '../src/index.js';

/**
 * Implementation tests for the transport boundary, header precedence, and
 * credential redaction. These cover internals and edge cases that the
 * specification tests do not pin.
 */

/** A simple auth strategy that stamps two headers. */
class HeaderAuth implements AuthStrategy {
  readonly scheme = 'test';

  /**
   * @param request - The request being built.
   * @returns The request with auth headers.
   */
  async apply(request: AdapterRequest): Promise<AdapterRequest> {
    return {
      ...request,
      headers: { ...request.headers, Authorization: 'Bearer auth-token', 'X-Auth': 'auth' },
    };
  }
}

/** A recording adapter that answers with a fixed response. */
class RecordingAdapter implements RequestAdapter {
  readonly requests: AdapterRequest[] = [];

  /**
   * @returns An empty success response.
   */
  async send(request: AdapterRequest): Promise<AdapterResponse> {
    this.requests.push(request);
    return { status: 200, ok: true, body: { success: true, data: {} } };
  }
}

const operation = {
  method: 'post',
  path: '/api/things',
  envelope: 'data' as const,
  operationId: 'createThing',
};

describe('header precedence', () => {
  test('per-call headers win over auth and client defaults', async () => {
    const adapter = new RecordingAdapter();
    const client = createApiClient({
      baseUrl: 'https://x',
      adapter,
      auth: new HeaderAuth(),
      headers: { 'X-Client': 'client', 'X-Common': 'client', Authorization: 'Bearer client' },
    });

    await client.request(
      operation,
      {},
      { headers: { 'X-Common': 'call', Authorization: 'Bearer call' } }
    );

    const headers = adapter.requests[0].headers;
    expect(headers['X-Client']).toBe('client');
    expect(headers['X-Common']).toBe('call');
    expect(headers['X-Auth']).toBe('auth');
    expect(headers.Authorization).toBe('Bearer call');
  });

  test('auth headers are applied when there are no per-call headers', async () => {
    const adapter = new RecordingAdapter();
    const client = createApiClient({ baseUrl: 'https://x', adapter, auth: new HeaderAuth() });

    await client.request(operation, {});

    expect(adapter.requests[0].headers.Authorization).toBe('Bearer auth-token');
  });
});

describe('body selection', () => {
  test('GET requests never send a body', async () => {
    const adapter = new RecordingAdapter();
    const client = createApiClient({ baseUrl: 'https://x', adapter });

    await client.request(
      { method: 'get', path: '/api/things/{id}', envelope: 'data', operationId: 'getThing' },
      { id: 1, filter: 'active' }
    );

    expect(adapter.requests[0].body).toBeUndefined();
    expect(adapter.requests[0].url).toBe('https://x/api/things/1?filter=active');
  });

  test('POST requests send the remaining parameters as a JSON body', async () => {
    const adapter = new RecordingAdapter();
    const client = createApiClient({ baseUrl: 'https://x', adapter });

    await client.request(operation, { name: 'Widget', tags: ['a', 'b'] });

    expect(adapter.requests[0].body).toBe(JSON.stringify({ name: 'Widget', tags: ['a', 'b'] }));
  });
});

describe('FetchAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('parses a JSON body and forwards request fields', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new FetchAdapter();

    const response = await adapter.send({
      url: 'https://x/api',
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });

    expect(response).toEqual({ status: 200, ok: true, body: { ok: true } });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://x/api',
      expect.objectContaining({ method: 'GET', credentials: 'include' })
    );
  });

  test('returns undefined for an empty body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 }))
    );
    const adapter = new FetchAdapter();

    const response = await adapter.send({ url: 'https://x', method: 'DELETE', headers: {} });

    expect(response.body).toBeUndefined();
  });

  test('returns raw text when the body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>boom</html>', { status: 500 }))
    );
    const adapter = new FetchAdapter();

    const response = await adapter.send({ url: 'https://x', method: 'GET', headers: {} });

    expect(response.body).toBe('<html>boom</html>');
    expect(response.ok).toBe(false);
  });
});

describe('credential redaction', () => {
  test('removes bearer values from a message', () => {
    expect(redactSensitive('failed with Bearer supersecret-token')).toBe(
      'failed with Bearer [redacted]'
    );
  });

  test('redacts a token echoed by the server into the error message', () => {
    const error = createApiError(
      500,
      {
        success: false,
        error: { code: 'internal', message: 'bad Bearer abc.def.ghi', statusCode: 500 },
      },
      'getThing'
    );

    expect(error.message).toBe('bad Bearer [redacted]');
    expect(error.message).not.toContain('abc.def.ghi');
  });

  test('redacts JWT-shaped values and query credentials', () => {
    expect(redactSensitive('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef')).not.toContain(
      'eyJhbGciOiJIUzI1NiJ9'
    );
    expect(redactSensitive('GET https://x?api_key=SECRET failed')).toBe(
      'GET https://x?api_key=[redacted] failed'
    );
  });

  test('redacts string leaves of error details and requestId', () => {
    const error = createApiError(
      500,
      {
        success: false,
        error: {
          code: 'internal',
          message: 'boom',
          statusCode: 500,
          requestId: 'Bearer req.token',
          details: { header: 'Bearer detail.token' },
        },
      },
      'getThing'
    );

    expect(String(error.requestId)).not.toContain('req.token');
    expect(JSON.stringify(error.details)).not.toContain('detail.token');
  });

  test('redacts a non-Error object cause', () => {
    const error = createTransportError({ url: 'https://x?api_key=SECRET' }, 'getThing');

    expect(JSON.stringify(error.cause)).not.toContain('SECRET');
  });
});
