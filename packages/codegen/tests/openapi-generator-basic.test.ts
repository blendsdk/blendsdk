import { describe, test, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { OpenAPIGenerator } from '../src/generator/openapi-generator.js';
import type { OpenAPIGeneratorConfig } from '../src/generator/openapi-types.js';

/**
 * Tests for OpenAPIGenerator — basic functionality.
 * Covers: empty spec generation, config options, toJSON(), toFile().
 */
describe('OpenAPIGenerator — Basic', () => {
  /** Temp file path for toFile() tests */
  const tempFilePath = path.join(import.meta.dirname, '__temp_openapi_test.json');

  /** Clean up any temp files after each test */
  afterEach(() => {
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
  });

  /**
   * Helper to create a generator with minimal config.
   */
  function createGenerator(overrides?: Partial<OpenAPIGeneratorConfig>): OpenAPIGenerator {
    return new OpenAPIGenerator({
      title: 'Test API',
      version: '1.0.0',
      ...overrides,
    });
  }

  // ─── Empty Spec ─────────────────────────────────────────────────────────

  test('empty generator produces minimal valid spec', () => {
    const gen = createGenerator();
    const doc = gen.generate();

    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('Test API');
    expect(doc.info.version).toBe('1.0.0');
    expect(doc.paths).toEqual({});
    // No servers or components when not configured
    expect(doc.servers).toBeUndefined();
    expect(doc.components).toBeUndefined();
  });

  test('empty generator includes description when configured', () => {
    const gen = createGenerator({ description: 'My API description' });
    const doc = gen.generate();

    expect(doc.info.description).toBe('My API description');
  });

  test('empty generator omits description when not configured', () => {
    const gen = createGenerator();
    const doc = gen.generate();

    expect(doc.info).not.toHaveProperty('description');
  });

  // ─── Servers ────────────────────────────────────────────────────────────

  test('includes servers when configured', () => {
    const gen = createGenerator({
      servers: [
        { url: 'http://localhost:3000', description: 'Local dev' },
        { url: 'https://api.example.com', description: 'Production' },
      ],
    });
    const doc = gen.generate();

    expect(doc.servers).toHaveLength(2);
    expect(doc.servers![0].url).toBe('http://localhost:3000');
    expect(doc.servers![1].url).toBe('https://api.example.com');
  });

  test('omits servers when empty array', () => {
    const gen = createGenerator({ servers: [] });
    const doc = gen.generate();

    expect(doc.servers).toBeUndefined();
  });

  // ─── Security Schemes ──────────────────────────────────────────────────

  test('includes security schemes in components when configured', () => {
    const gen = createGenerator({
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    });
    const doc = gen.generate();

    expect(doc.components).toBeDefined();
    expect(doc.components!.securitySchemes).toBeDefined();
    expect(doc.components!.securitySchemes!.bearerAuth).toEqual({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  test('omits components when no security schemes configured', () => {
    const gen = createGenerator();
    const doc = gen.generate();

    expect(doc.components).toBeUndefined();
  });

  // ─── toJSON ─────────────────────────────────────────────────────────────

  test('toJSON() returns valid JSON string', () => {
    const gen = createGenerator();
    const json = gen.toJSON();

    expect(typeof json).toBe('string');
    const parsed = JSON.parse(json);
    expect(parsed.openapi).toBe('3.1.0');
    expect(parsed.info.title).toBe('Test API');
  });

  test('toJSON() uses custom indent', () => {
    const gen = createGenerator();
    const json4 = gen.toJSON(4);
    const json2 = gen.toJSON(2);

    // 4-space indent produces longer output than 2-space
    expect(json4.length).toBeGreaterThan(json2.length);
    // Both are valid JSON
    expect(JSON.parse(json4).openapi).toBe('3.1.0');
    expect(JSON.parse(json2).openapi).toBe('3.1.0');
  });

  // ─── toFile ─────────────────────────────────────────────────────────────

  test('toFile() writes valid JSON to disk', () => {
    const gen = createGenerator();
    gen.toFile(tempFilePath);

    expect(fs.existsSync(tempFilePath)).toBe(true);
    const content = fs.readFileSync(tempFilePath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.openapi).toBe('3.1.0');
    expect(parsed.info.title).toBe('Test API');
  });

  test('toFile() creates parent directories if needed', () => {
    const nestedPath = path.join(import.meta.dirname, '__temp_nested', 'deep', 'api.json');

    try {
      const gen = createGenerator();
      gen.toFile(nestedPath);

      expect(fs.existsSync(nestedPath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(nestedPath, 'utf-8'));
      expect(parsed.openapi).toBe('3.1.0');
    } finally {
      // Clean up nested directories
      fs.rmSync(path.join(import.meta.dirname, '__temp_nested'), { recursive: true, force: true });
    }
  });
});
