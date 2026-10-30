import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { TypeGenerator, ZodGenerator } from '../src/generator/index.js';
import { SchemaContainer } from '../src/schema/index.js';

/** Evaluates generated Zod source with the real `z` module. */
function evaluateZod(source: string, variableName: string): z.ZodType {
  const body = source.replace(/^import .*$/mu, '').replace(/\bexport\b/gu, '');
  const factory = new Function('z', `${body}\nreturn ${variableName};`);
  return factory(z) as z.ZodType;
}

describe('string constraint implementation details', () => {
  test('names the schema when a forced invalid pattern reaches the generator', async () => {
    const container = new SchemaContainer();
    const value = container.scope().string().named('forced_bad');
    value.setData({ pattern: '[' });

    await expect(new ZodGenerator().generate(container)).rejects.toThrow(/ForcedBadSchema/u);
  });

  test('applies constraints before optional and nullable modifiers', async () => {
    const container = new SchemaContainer();
    container
      .scope()
      .string()
      .pattern('^a+$')
      .minLength(1)
      .maxLength(5)
      .optional()
      .named('maybe_value');

    const source = await new ZodGenerator().generate(container);
    const regexIndex = source.indexOf('.regex(');
    const minIndex = source.indexOf('.min(');
    const maxIndex = source.indexOf('.max(');
    const optionalIndex = source.indexOf('.optional()');

    expect(regexIndex).toBeGreaterThanOrEqual(0);
    expect(regexIndex).toBeLessThan(minIndex);
    expect(minIndex).toBeLessThan(maxIndex);
    expect(maxIndex).toBeLessThan(optionalIndex);
  });

  test('escapes quotes and backslashes in the generated regular expression', async () => {
    const container = new SchemaContainer();
    container.scope().string().pattern('^a\\d+"$').named('quoted_value');

    const source = await new ZodGenerator().generate(container);
    const schema = evaluateZod(source, 'QuotedValueSchema');

    expect(schema.safeParse('a12"').success).toBe(true);
    expect(schema.safeParse('a12').success).toBe(false);
  });

  test('documents constraints on object properties', async () => {
    const container = new SchemaContainer();
    const scope = container.scope();
    scope
      .object({
        code: scope.string().pattern('^[A-Z]+$').minLength(2).maxLength(8),
      })
      .named('row');

    const source = await new TypeGenerator().generate(container);

    expect(source).toContain('@pattern ^[A-Z]+$');
    expect(source).toContain('@minLength 2');
    expect(source).toContain('@maxLength 8');
  });

  test('keeps a comment terminator in a pattern inside the JSDoc', async () => {
    const container = new SchemaContainer();
    container.scope().string().pattern('^[^/]*/[a-z]+$').named('path_value');

    // Without escaping, the `*/` closes the JSDoc and Prettier fails on the remainder.
    const source = await new TypeGenerator().generate(container);
    const patternLine = source.split('\n').find(line => line.includes('@pattern'));

    expect(patternLine).toBeDefined();
    expect(patternLine).toContain('*\\/');
  });

  test('does not let a pattern break out of the JSDoc', async () => {
    const container = new SchemaContainer();
    container.scope().string().pattern('[*/; globalThis.pwned = 1; /*]').named('danger');

    const source = await new TypeGenerator().generate(container);
    const patternLine = source.split('\n').find(line => line.includes('@pattern'));

    expect(patternLine).toContain('[*\\/; globalThis.pwned = 1; /*]');
    expect(patternLine).not.toMatch(/[^\\]\*\//u);
  });
});
