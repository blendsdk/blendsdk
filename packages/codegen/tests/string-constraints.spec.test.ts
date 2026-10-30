import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { TypeGenerator, ZodGenerator, convertZodToJsonSchema } from '../src/generator/index.js';
import { SchemaContainer } from '../src/schema/index.js';

const PROJECT_NAME_PATTERN = '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$';

/** Builds the constrained schema used by the generated-output tests. */
function projectNameSchema() {
  const container = new SchemaContainer();
  container
    .scope()
    .string()
    .pattern(PROJECT_NAME_PATTERN)
    .minLength(3)
    .maxLength(40)
    .named('project_name');
  return container;
}

/**
 * Evaluates generated Zod source so the test proves runtime behaviour, not only text output.
 *
 * The generator emits a single import plus exported constants. Stripping the import and the
 * `export` keywords is enough to evaluate the code inside a `new Function` with the real `z`.
 */
function evaluateZod(source: string, variableName: string): z.ZodType {
  const body = source.replace(/^import .*$/mu, '').replace(/\bexport\b/gu, '');
  const factory = new Function('z', `${body}\nreturn ${variableName};`);
  return factory(z) as z.ZodType;
}

describe('string schema constraints', () => {
  test('generated Zod accepts valid names and rejects pattern or length violations', async () => {
    const source = await new ZodGenerator().generate(projectNameSchema());
    const schema = evaluateZod(source, 'ProjectNameSchema');

    expect(schema.safeParse('abc').success).toBe(true);
    expect(schema.safeParse('a1-b2').success).toBe(true);
    expect(schema.safeParse('ab').success).toBe(false);
    expect(schema.safeParse('a'.repeat(41)).success).toBe(false);
    expect(schema.safeParse('ABC').success).toBe(false);
    expect(schema.safeParse('a_b').success).toBe(false);
  });

  test('generated TypeScript documents the constraints in JSDoc', async () => {
    const source = await new TypeGenerator().generate(projectNameSchema());

    expect(source).toContain(`@pattern ${PROJECT_NAME_PATTERN}`);
    expect(source).toContain('@minLength 3');
    expect(source).toContain('@maxLength 40');
  });

  test('generated OpenAPI contains pattern, minLength, and maxLength', async () => {
    const source = await new ZodGenerator().generate(projectNameSchema());
    const schema = evaluateZod(source, 'ProjectNameSchema');
    const json = convertZodToJsonSchema(schema, 'input') as {
      pattern?: string;
      minLength?: number;
      maxLength?: number;
    };

    expect(json.pattern).toBe(PROJECT_NAME_PATTERN);
    expect(json.minLength).toBe(3);
    expect(json.maxLength).toBe(40);
  });

  test('leaves an unconstrained string unchanged', async () => {
    const container = new SchemaContainer();
    container.scope().string().named('plain_value');

    const source = await new ZodGenerator().generate(container);

    expect(source).toContain('z.string()');
    expect(source).not.toContain('.regex(');
    expect(source).not.toContain('.min(');
    expect(source).not.toContain('.max(');
  });

  test('accepts an unflagged RegExp and stores its deterministic source', async () => {
    const container = new SchemaContainer();
    container
      .scope()
      .string()
      .pattern(/^[a-z]+$/)
      .named('slug');

    const source = await new ZodGenerator().generate(container);

    // The stored source is emitted without flags.
    expect(source).toContain('new RegExp("^[a-z]+$")');
  });

  test('rejects a RegExp with flags', () => {
    const container = new SchemaContainer();
    const value = container.scope().string();

    expect(() => value.pattern(/abc/iu)).toThrow(/flags/u);
  });

  test('enforces length constraints independently of the pattern', async () => {
    const container = new SchemaContainer();
    container.scope().string().pattern('^.*$').minLength(3).maxLength(5).named('bounded');

    const source = await new ZodGenerator().generate(container);
    const schema = evaluateZod(source, 'BoundedSchema');

    expect(schema.safeParse('abc').success).toBe(true);
    expect(schema.safeParse('ab').success).toBe(false);
    expect(schema.safeParse('abcdef').success).toBe(false);
  });

  test('accepts zero bounds and rejects an empty pattern', () => {
    const container = new SchemaContainer();
    const value = container.scope().string();

    expect(() => value.minLength(0)).not.toThrow();
    expect(() => value.maxLength(0)).not.toThrow();
    expect(() => container.scope().string().pattern('')).toThrow(/must not be empty/u);
  });

  test('rejects an invalid pattern with the schema name', () => {
    const container = new SchemaContainer();
    const value = container.scope().string().named('broken_name');

    expect(() => value.pattern('[')).toThrow(/broken_name/u);
  });

  test('rejects invalid or inconsistent length bounds', () => {
    const container = new SchemaContainer();
    const value = container.scope().string();

    expect(() => value.minLength(-1)).toThrow(/non-negative integer/u);
    expect(() => value.minLength(1.5)).toThrow(/non-negative integer/u);
    expect(() => value.maxLength(2.5)).toThrow(/non-negative integer/u);

    value.minLength(3);
    expect(() => value.maxLength(2)).toThrow(/maxLength/u);
  });
});
