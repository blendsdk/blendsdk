import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClient } from '../src/generator/client-generator.js';
import { ClientGenerationError } from '../src/generator/client-types.js';
import {
  deriveGroupName,
  fallbackMethodName,
  pascalCase,
  sanitizeIdentifier,
} from '../src/generator/client-naming.js';
import { defaultResolveReference, schemaToType } from '../src/generator/client-schema.js';
import type { OpenAPIDocument, OpenAPISchema } from '../src/generator/openapi-types.js';

/**
 * Implementation tests for the client generator's internal rules: the schema to
 * TypeScript emitter, the naming rules, deterministic ordering, and pruning of
 * only marker-bearing files.
 *
 * @module codegen/tests/client-generator.impl
 */

/** Directories created by a test, removed after each test. */
const tempDirectories: string[] = [];

/**
 * Creates an empty temporary directory.
 *
 * @returns The absolute path of the new directory.
 */
function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blendsdk-client-impl-'));
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

/**
 * Builds a minimal document from a path map and component schemas.
 *
 * @param paths - The document paths.
 * @param schemas - Optional component schemas.
 * @returns A complete OpenAPI document.
 */
function document(
  paths: OpenAPIDocument['paths'],
  schemas?: Record<string, OpenAPISchema>
): OpenAPIDocument {
  return {
    openapi: '3.1.0',
    info: { title: 'Impl API', version: '1.0.0' },
    paths,
    ...(schemas ? { components: { schemas } } : {}),
  };
}

describe('schema to TypeScript emitter', () => {
  test('converts a nullable field to a type union', () => {
    expect(schemaToType({ type: ['string', 'null'] })).toBe('string | null');
  });

  test('converts an enum to a literal union', () => {
    expect(schemaToType({ enum: ['a', 'b'] })).toBe('"a" | "b"');
  });

  test('converts a const to a literal', () => {
    expect(schemaToType({ const: 'fixed' })).toBe('"fixed"');
  });

  test('converts anyOf to a union and allOf to an intersection', () => {
    expect(schemaToType({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toBe(
      'string | number'
    );
    expect(
      schemaToType({
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
          { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
        ],
      })
    ).toBe('{ a: string; } & { b: number; }');
  });

  test('converts arrays and parenthesizes union items', () => {
    expect(schemaToType({ type: 'array', items: { type: 'string' } })).toBe('string[]');
    expect(schemaToType({ type: 'array', items: { type: ['string', 'null'] } })).toBe(
      '(string | null)[]'
    );
  });

  test('converts additionalProperties to an index signature', () => {
    expect(schemaToType({ type: 'object', additionalProperties: { type: 'string' } })).toBe(
      'Record<string, string>'
    );
  });

  test('sorts properties and quotes invalid property names', () => {
    const text = schemaToType({
      type: 'object',
      properties: { zed: { type: 'number' }, 'filter[name]': { type: 'string' } },
      required: ['filter[name]'],
    });
    expect(text).toBe('{ "filter[name]": string; zed?: number; }');
  });

  test('falls back to unknown for an unrecognized schema', () => {
    expect(schemaToType({})).toBe('unknown');
    expect(schemaToType(undefined)).toBe('unknown');
  });

  test('resolves a reference to its component name', () => {
    expect(schemaToType({ $ref: '#/components/schemas/Product' })).toBe('Product');
    expect(defaultResolveReference('#/components/schemas/Product')).toBe('Product');
  });

  test('parenthesizes a union member inside an intersection', () => {
    expect(
      schemaToType({
        allOf: [{ type: ['string', 'null'] }, { properties: { a: { type: 'string' } } }],
      })
    ).toBe('(string | null) & { a?: string; }');
  });
});

describe('naming rules', () => {
  test('escapes reserved words and prefixes leading digits', () => {
    expect(sanitizeIdentifier('delete')).toBe('delete_');
    expect(sanitizeIdentifier('2fa')).toBe('_2fa');
    expect(sanitizeIdentifier('get-product')).toBe('get_product');
  });

  test('escapes object prototype names', () => {
    expect(sanitizeIdentifier('__proto__')).toBe('__proto___');
    expect(sanitizeIdentifier('prototype')).toBe('prototype_');
    expect(sanitizeIdentifier('constructor')).toBe('constructor_');
  });

  test('derives a camelCase group from a hyphenated tag or the first path segment', () => {
    expect(deriveGroupName(['product-catalog'], '/api/ignored')).toBe('productCatalog');
    expect(deriveGroupName(undefined, '/api/products/{id}')).toBe('products');
    // A reserved fallback name is escaped per the naming rule.
    expect(deriveGroupName(undefined, '/api')).toBe('default_');
  });

  test('builds the deterministic fallback method name', () => {
    expect(fallbackMethodName('products', 'get', '/api/products/{id}')).toBe('productsGetById');
    expect(fallbackMethodName('products', 'get', '/api/products')).toBe('productsGet');
  });

  test('throws on a duplicate method name produced by sanitization', async () => {
    const directory = tempDirectory();
    const doc = document({
      '/api/a': {
        get: {
          operationId: 'delete',
          tags: ['products'],
          responses: { 200: { description: 'ok' } },
        },
      },
      '/api/b': {
        post: {
          operationId: 'delete_',
          tags: ['products'],
          responses: { 200: { description: 'ok' } },
        },
      },
    });

    await expect(generateClient(doc, { outputDir: directory })).rejects.toBeInstanceOf(
      ClientGenerationError
    );
  });
});

describe('deterministic emission and pruning', () => {
  /** A document whose paths and methods are declared in reverse order. */
  function forwardDocument(): OpenAPIDocument {
    return document(
      {
        '/api/alpha': {
          get: {
            operationId: 'getAlpha',
            tags: ['alpha'],
            responses: { 200: { description: 'ok' } },
          },
        },
        '/api/beta': {
          get: {
            operationId: 'getBeta',
            tags: ['beta'],
            responses: { 200: { description: 'ok' } },
          },
        },
      },
      { Zed: { type: 'object', properties: { z: { type: 'string' } } }, Alpha: { type: 'string' } }
    );
  }

  test('is independent of input declaration order', async () => {
    const first = tempDirectory();
    const second = tempDirectory();
    const doc = forwardDocument();
    const schemas = doc.components?.schemas ?? {};
    const reversed: OpenAPIDocument = {
      ...doc,
      paths: { '/api/beta': doc.paths['/api/beta'], '/api/alpha': doc.paths['/api/alpha'] },
      components: { schemas: { Alpha: schemas.Alpha, Zed: schemas.Zed } },
    };

    await generateClient(doc, { outputDir: first });
    await generateClient(reversed, { outputDir: second });

    expect(fs.readFileSync(path.join(first, 'types.ts'), 'utf8')).toBe(
      fs.readFileSync(path.join(second, 'types.ts'), 'utf8')
    );
    expect(fs.readFileSync(path.join(first, 'client.ts'), 'utf8')).toBe(
      fs.readFileSync(path.join(second, 'client.ts'), 'utf8')
    );
  });

  test('emits component aliases in sorted order', async () => {
    const directory = tempDirectory();
    await generateClient(forwardDocument(), { outputDir: directory });

    const types = fs.readFileSync(path.join(directory, 'types.ts'), 'utf8');
    expect(types.indexOf('export type Alpha')).toBeLessThan(types.indexOf('export type Zed'));
  });

  test('leaves a hand-written file without the marker untouched', async () => {
    const directory = tempDirectory();
    fs.writeFileSync(path.join(directory, 'hand-written.ts'), 'export const keep = true;\n');

    await generateClient(forwardDocument(), { outputDir: directory });

    expect(fs.existsSync(path.join(directory, 'hand-written.ts'))).toBe(true);
  });

  test('does not read or prune a symlink in the output directory', async () => {
    const directory = tempDirectory();
    const target = path.join(tempDirectory(), 'target.txt');
    fs.writeFileSync(target, 'not generated\n');
    fs.symlinkSync(target, path.join(directory, 'link.ts'));

    await generateClient(forwardDocument(), { outputDir: directory });

    expect(fs.existsSync(path.join(directory, 'link.ts'))).toBe(true);
  });

  test('de-duplicates a body property that shares a path parameter name', async () => {
    const directory = tempDirectory();
    const doc = document({
      '/api/products/{id}': {
        patch: {
          operationId: 'updateProduct',
          tags: ['products'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'number' }, name: { type: 'string' } },
                  required: ['id', 'name'],
                },
              },
            },
          },
          responses: {
            200: {
              description: 'ok',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    });

    const result = await generateClient(doc, { outputDir: directory });

    const types = fs.readFileSync(path.join(directory, 'types.ts'), 'utf8');
    expect(types).toContain('id: string');
    expect(types).not.toContain('id: number');
    expect(result.issues.some(issue => issue.message.includes('duplicate parameter'))).toBe(true);
  });

  test('builds a camelCase group name through pascalCase', () => {
    expect(pascalCase('product-catalog')).toBe('ProductCatalog');
  });
});
