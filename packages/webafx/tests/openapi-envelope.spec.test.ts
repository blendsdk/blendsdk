import { describe, test, expect } from 'vitest';
import { RouteBuilder } from '../src/application/route-builder.js';

/**
 * Behavioural contract for the response-envelope route metadata.
 *
 * A route may declare how a generated client should read a successful response.
 * Omitting the field means the generator applies the `data` default; setting
 * `body` tells the client to return the whole response body, which is required
 * for paginated responses that also carry a `pagination` object.
 */
describe('response envelope metadata', () => {
  test('a route without an envelope records nothing, so the data default applies', () => {
    const definition = new RouteBuilder()
      .get('/')
      .openapi({ summary: 'Items' })
      .handle(() => {});

    expect(definition.openapi?.envelope).toBeUndefined();
  });

  test('a route can record the body envelope for paginated responses', () => {
    const definition = new RouteBuilder()
      .get('/')
      .openapi({ summary: 'Items', envelope: 'body' })
      .handle(() => {});

    expect(definition.openapi?.envelope).toBe('body');
  });

  test('a route can record the data envelope explicitly', () => {
    const definition = new RouteBuilder()
      .get('/')
      .openapi({ summary: 'Items', envelope: 'data' })
      .handle(() => {});

    expect(definition.openapi?.envelope).toBe('data');
  });
});
