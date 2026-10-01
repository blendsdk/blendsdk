/**
 * Naming rules for generated client groups and methods.
 *
 * Resolves the small set of naming decisions the generator makes: deriving a
 * group from an operation, sanitizing group and method names into valid
 * JavaScript identifiers, escaping reserved words, and building the
 * deterministic fallback method name used when an operation has no
 * `operationId`. Kept separate from the emitter so the rules can be read and
 * tested in isolation.
 *
 * @module
 */

/**
 * Words that are escaped with a trailing underscore when used as a method name.
 *
 * The list covers JavaScript reserved words plus host globals that would shadow
 * or confuse a generated method. Escaping is deterministic and never an error,
 * so an author who uses one of these names still gets a working client.
 */
const RESERVED_NAMES = new Set([
  'abstract',
  'arguments',
  'await',
  'boolean',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'class',
  'const',
  'constructor',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'double',
  'else',
  'enum',
  'eval',
  'export',
  'extends',
  'false',
  'final',
  'finally',
  'float',
  'for',
  'function',
  'goto',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'int',
  'interface',
  'let',
  'long',
  'native',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'short',
  'static',
  'super',
  'switch',
  'synchronized',
  'this',
  'throw',
  'throws',
  'transient',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'volatile',
  'while',
  'with',
  'yield',
  // TypeScript type keywords, which are invalid as type alias names.
  'any',
  'asserts',
  'bigint',
  'boolean',
  'declare',
  'infer',
  'is',
  'keyof',
  'never',
  'number',
  'object',
  'out',
  'readonly',
  'satisfies',
  'string',
  'symbol',
  'undefined',
  'unique',
  'unknown',
  // Object prototype names, which must not become group or method keys.
  '__proto__',
  'prototype',
]);

/** Matches one segment of a path that is a parameter, for example `{id}`. */
const PATH_PARAMETER = /^\{(.+)\}$/u;

/** Splits an arbitrary label into alphanumeric tokens. */
const TOKEN_SEPARATOR = /[^A-Za-z0-9]+/u;

/**
 * Converts a label into PascalCase tokens.
 *
 * @param raw - A tag, segment, or parameter name.
 * @returns The label with each token capitalized, or an empty string.
 */
export function pascalCase(raw: string): string {
  return raw
    .split(TOKEN_SEPARATOR)
    .filter(token => token.length > 0)
    .map(token => token.charAt(0).toUpperCase() + token.slice(1))
    .join('');
}

/**
 * Makes a string safe to use as a JavaScript identifier.
 *
 * Invalid characters become underscores, a leading digit is prefixed with an
 * underscore, and a reserved word gets a trailing underscore. The input's
 * casing is preserved.
 *
 * @param raw - The desired identifier.
 * @returns A valid identifier, never empty.
 */
export function sanitizeIdentifier(raw: string): string {
  const replaced = raw.replace(/[^A-Za-z0-9_$]/gu, '_');
  const prefixed = /^[0-9]/u.test(replaced) ? `_${replaced}` : replaced;
  const named = prefixed.length > 0 ? prefixed : '_operation';
  return RESERVED_NAMES.has(named) ? `${named}_` : named;
}

/**
 * Derives the client group for an operation.
 *
 * The first OpenAPI tag wins; otherwise the first path segment after `/api` is
 * used. The result is a valid identifier, so `product-catalog` becomes
 * `productCatalog`.
 *
 * @param tags - The operation tags, in document order.
 * @param path - The operation path.
 * @returns The sanitized group name.
 */
export function deriveGroupName(tags: readonly string[] | undefined, path: string): string {
  const raw = tags && tags.length > 0 ? tags[0] : firstResourceSegment(path);
  return sanitizeIdentifier(pascalCase(raw).replace(/^./u, character => character.toLowerCase()));
}

/**
 * Sanitizes an operationId into a method name.
 *
 * @param operationId - The OpenAPI operationId.
 * @returns A valid method identifier.
 */
export function sanitizeMethodName(operationId: string): string {
  return sanitizeIdentifier(operationId);
}

/**
 * Builds the deterministic fallback method name used when an operation has no
 * `operationId`.
 *
 * The name is the group, the capitalized HTTP method, then the capitalized path
 * segments after the resource. A parameter segment such as `{id}` becomes
 * `ById`. For example, `GET /api/products/{id}` in the `products` group becomes
 * `productsGetById`.
 *
 * @param group - The sanitized group name.
 * @param method - The lowercase HTTP method.
 * @param path - The operation path.
 * @returns The fallback method name.
 */
export function fallbackMethodName(group: string, method: string, path: string): string {
  const all = path.split('/').filter(segment => segment.length > 0);
  const withoutApi = all[0]?.toLowerCase() === 'api' ? all.slice(1) : all;
  // Drop the resource segment: the group already names it.
  const rendered = withoutApi.slice(1).map(renderFallbackSegment).join('');
  return sanitizeIdentifier(`${group}${pascalCase(method)}${rendered}`);
}

/**
 * Returns the first path segment after `/api`, or `default` when there is none.
 *
 * @param path - The operation path.
 * @returns The raw resource segment.
 */
function firstResourceSegment(path: string): string {
  const segments = path.split('/').filter(segment => segment.length > 0);
  const resource = segments[0]?.toLowerCase() === 'api' ? segments[1] : segments[0];
  return resource ?? 'default';
}

/**
 * Renders one path segment for the fallback method name.
 *
 * @param segment - A literal segment or a `{param}` placeholder.
 * @returns The PascalCase segment, or `By<Param>` for a parameter.
 */
function renderFallbackSegment(segment: string): string {
  const parameter = PATH_PARAMETER.exec(segment);
  return parameter ? `By${pascalCase(parameter[1])}` : pascalCase(segment);
}
