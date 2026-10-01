/**
 * URL building and parameter serialization.
 *
 * The runtime receives one flat parameter object that mirrors the server's
 * merged validation object: path, query, and body fields together. These helpers
 * split that object using the operation path, encode path parameters, serialize
 * query parameters, and serialize a JSON body.
 *
 * @module
 */

/**
 * A single value accepted as a path, query, or body field.
 */
export type ParamValue = string | number | boolean | null | undefined;

/**
 * A JSON-serializable value, used for nested body structures.
 */
export type JsonValue = ParamValue | JsonValue[] | { [key: string]: JsonValue };

/**
 * Flat parameters: path, query, and body merged, matching the server's merged
 * validation.
 *
 * The value type is `unknown` rather than {@link JsonValue}. An OpenAPI
 * contract may describe a field with an empty schema, and a generated client
 * then types that field as `unknown`. The runtime serializes whatever it is
 * given with `JSON.stringify`, so it accepts any parameter bag; the server
 * remains responsible for validating the values it receives.
 */
export type RequestParams = Record<string, unknown>;

/**
 * Extracts the placeholder names from an OpenAPI path.
 *
 * @param path - An OpenAPI path such as `/api/products/{id}`.
 * @returns The placeholder names, in order.
 *
 * @example
 * ```typescript
 * extractPathParamNames('/api/{orgId}/users/{userId}'); // ['orgId', 'userId']
 * ```
 */
export function extractPathParamNames(path: string): string[] {
  const names: string[] = [];
  const regex = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(path)) !== null) {
    names.push(match[1]);
  }
  return names;
}

/**
 * Substitutes path placeholders with encoded parameter values.
 *
 * A missing value is an error: silently substituting an empty segment would
 * produce a different (often collection-level) URL than the caller intended.
 * The reserved `.` and `..` segments are percent-encoded so a caller-supplied
 * value cannot traverse to a parent path.
 *
 * @param path - An OpenAPI path such as `/api/products/{id}`.
 * @param params - The flat parameters.
 * @returns The resolved path.
 * @throws {Error} When a placeholder has no value.
 */
export function resolvePath(path: string, params: RequestParams): string {
  return path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_full, name: string) => {
    const value = params[name];
    if (value === undefined || value === null) {
      throw new Error(`Missing value for path parameter "${name}" in path "${path}"`);
    }
    const encoded = encodeURIComponent(stringifyValue(value));
    return encoded === '.' || encoded === '..' ? encoded.replace(/\./g, '%2E') : encoded;
  });
}

/**
 * Returns the parameters that are not consumed by the operation path.
 *
 * These are the query or body fields, depending on the HTTP method.
 *
 * @param path - An OpenAPI path with placeholders.
 * @param params - The flat parameters.
 * @returns A new parameter object without the path parameters.
 */
export function omitPathParams(path: string, params: RequestParams): RequestParams {
  const pathNames = new Set(extractPathParamNames(path));
  const rest: RequestParams = {};
  for (const [key, value] of Object.entries(params)) {
    if (pathNames.has(key) || isUnsafeKey(key)) {
      continue;
    }
    rest[key] = value;
  }
  return rest;
}

/**
 * Reports whether a parameter key could change an object's prototype.
 *
 * Parameters come from callers and, in a generated client, from parsed JSON.
 * Assigning `__proto__` with bracket syntax would mutate the object's prototype
 * instead of adding a field, so that key is dropped. Other names such as
 * `constructor` create ordinary own properties and are kept.
 *
 * @param key - A parameter name.
 * @returns True when the key is unsafe to assign.
 */
function isUnsafeKey(key: string): boolean {
  return key === '__proto__';
}

/**
 * Builds the absolute request URL, including a query string when needed.
 *
 * @param baseUrl - The base URL, with or without a trailing slash.
 * @param path - The resolved operation path.
 * @param query - The query parameters.
 * @returns The absolute URL.
 */
export function buildUrl(baseUrl: string, path: string, query: RequestParams): string {
  const base = baseUrl.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const queryString = serializeQuery(query);
  return queryString.length > 0
    ? `${base}${normalizedPath}?${queryString}`
    : `${base}${normalizedPath}`;
}

/**
 * Appends one query parameter to a URL.
 *
 * Used by authentication strategies that place a key in the query string.
 *
 * @param url - The current URL.
 * @param key - The parameter name.
 * @param value - The parameter value.
 * @returns The URL with the parameter appended.
 */
export function appendQuery(url: string, key: string, value: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

/**
 * Serializes query parameters, using repeated keys for arrays.
 *
 * @param params - The query parameters.
 * @returns The query string without a leading `?`.
 *
 * @example
 * ```typescript
 * serializeQuery({ tag: ['a', 'b'] }); // 'tag=a&tag=b'
 * ```
 */
export function serializeQuery(params: RequestParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined) {
          search.append(key, stringifyValue(item));
        }
      }
    } else {
      search.append(key, stringifyValue(value));
    }
  }
  return search.toString();
}

/**
 * Serializes the body parameters as JSON.
 *
 * @param params - The body parameters.
 * @returns The JSON body, or undefined when there is nothing to send.
 */
export function serializeBody(params: RequestParams): string | undefined {
  return Object.keys(params).length > 0 ? JSON.stringify(params) : undefined;
}

/**
 * Converts a parameter value to its wire string.
 *
 * @param value - The parameter value.
 * @returns The string form used on the wire.
 */
function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}
