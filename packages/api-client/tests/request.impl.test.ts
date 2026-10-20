/**
 * Implementation tests for parameter handling.
 *
 * The runtime receives one flat parameter object and splits it into path,
 * query, and body values. These tests cover the prototype-safety edge case that
 * the specification tests do not reach.
 */

import { describe, test, expect } from 'vitest';
import { omitPathParams, type RequestParams } from '../src/index.js';

describe('omitPathParams', () => {
  test('removes the path parameters and keeps the rest', () => {
    const params: RequestParams = { id: 42, filter: 'new' };

    expect(omitPathParams('/api/products/{id}', params)).toEqual({ filter: 'new' });
  });

  test('drops an own __proto__ property instead of mutating the prototype', () => {
    const params = JSON.parse('{"__proto__": {"polluted": true}, "name": "ok"}') as RequestParams;

    const rest = omitPathParams('/api/things', params);

    expect(rest.name).toBe('ok');
    expect((rest as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(rest)).toBe(Object.prototype);
  });

  test('keeps ordinary keys named constructor and prototype', () => {
    const params: RequestParams = { constructor: 'a', prototype: 'b' };

    expect(omitPathParams('/api/things', params)).toEqual({ constructor: 'a', prototype: 'b' });
  });
});
