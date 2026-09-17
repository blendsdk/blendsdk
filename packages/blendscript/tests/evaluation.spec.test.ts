import { describe, expect, it } from 'vitest';

import {
  BlendScriptApiError,
  compileExpression,
  evaluateExpression,
  type CompiledExpression,
  type ExpressionSchema,
  type ExpressionValue,
} from '../src/index.js';

function compile(source: string, schema: ExpressionSchema = {}): CompiledExpression {
  const result = compileExpression(source, { schema });
  if (!result.ok)
    throw new Error(`Expected compilation success, received ${result.diagnostics[0]?.code}`);
  return result.expression;
}

function value(
  source: string,
  schema: ExpressionSchema,
  data: Readonly<Record<string, ExpressionValue>>
): ExpressionValue {
  const result = evaluateExpression(compile(source, schema), data);
  if (!result.ok)
    throw new Error(`Expected evaluation success, received ${result.diagnostic.code}`);
  return result.value;
}

describe('BlendScript evaluation', () => {
  it('should apply AND before OR', () => {
    const schema = { Country: { type: 'string' }, Enabled: { type: 'boolean' } } as const;
    expect(
      value('Country == "GB" OR Country == "NL" AND Enabled == TRUE', schema, {
        Country: 'GB',
        Enabled: false,
      })
    ).toBe(true);
  });

  it('should evaluate canonical and symbolic logical operators identically', () => {
    const schema = { A: { type: 'boolean' }, B: { type: 'boolean' } } as const;
    const data = { A: true, B: false };
    expect(value('NOT A OR B', schema, data)).toBe(value('!A || B', schema, data));
    expect(value('A AND NOT B', schema, data)).toBe(value('A && !B', schema, data));
  });

  it('should evaluate strict membership with duplicate literals', () => {
    const schema = { Country: { type: 'string' } } as const;
    const expression = compile('Country IN ("GB", "NL", "NL")', schema);
    expect(evaluateExpression(expression, { Country: 'NL' })).toEqual({ ok: true, value: true });
    expect(evaluateExpression(expression, { Country: 'XX' })).toEqual({ ok: true, value: false });
  });

  it('should evaluate representative equality, ordering, logic, negation, and membership', () => {
    const schema = {
      Count: { type: 'number' },
      Enabled: { type: 'boolean' },
      Code: { type: 'string' },
    } as const;
    const data = { Count: 12, Enabled: true, Code: 'A' };
    const cases = [
      ['Count == 12', true],
      ['Count != 10', true],
      ['Count < 20', true],
      ['Count <= 12', true],
      ['Count > 20', false],
      ['Count >= 12', true],
      ['Enabled AND TRUE', true],
      ['NOT Enabled', false],
      ['Code IN ("A", "B")', true],
    ] as const;
    for (const [source, expected] of cases) expect(value(source, schema, data)).toBe(expected);
  });

  it('should preflight every declared field including unreferenced fields', () => {
    const expression = compile('TRUE', {
      ReferencedByNothing: { type: 'string' },
    });
    expect(evaluateExpression(expression, {})).toEqual({
      ok: false,
      diagnostic: expect.objectContaining({
        kind: 'record',
        code: 'BS_MISSING_FIELD',
        field: 'ReferencedByNothing',
      }),
    });
  });

  it('should validate finite runtime numbers while treating negative zero as zero', () => {
    const expression = compile('Count == 0', { Count: { type: 'number' } });
    expect(evaluateExpression(expression, { Count: -0 })).toEqual({ ok: true, value: true });
    for (const Count of ['0', Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(evaluateExpression(expression, { Count } as never)).toMatchObject({
        ok: false,
        diagnostic: { code: 'BS_RUNTIME_TYPE_MISMATCH', field: 'Count' },
      });
    }
  });

  it('should enforce runtime string length inclusively', () => {
    const expression = compile('Text == Text', { Text: { type: 'string' } });
    expect(evaluateExpression(expression, { Text: 'a'.repeat(4_096) })).toEqual({
      ok: true,
      value: true,
    });
    expect(evaluateExpression(expression, { Text: 'a'.repeat(4_097) })).toMatchObject({
      ok: false,
      diagnostic: { code: 'BS_STRING_VALUE_LIMIT_EXCEEDED', field: 'Text' },
    });
  });

  it('should implement nullable equality and membership without coercion', () => {
    const schema = { Text: { type: 'string', nullable: true } } as const;
    expect(value('Text == NULL', schema, { Text: null })).toBe(true);
    expect(value('Text == "x"', schema, { Text: null })).toBe(false);
    expect(value('Text IN ("x", NULL)', schema, { Text: null })).toBe(true);
  });

  it('should return null-not-allowed at the complete operator or call span', () => {
    const cases = [
      ['Count < 2', { Count: { type: 'number', nullable: true } }, { Count: null }],
      ['Enabled AND TRUE', { Enabled: { type: 'boolean', nullable: true } }, { Enabled: null }],
      ['trim(Text)', { Text: { type: 'string', nullable: true } }, { Text: null }],
    ] as const;
    for (const [source, schema, data] of cases) {
      expect(evaluateExpression(compile(source, schema), data)).toMatchObject({
        ok: false,
        diagnostic: {
          kind: 'source',
          code: 'BS_NULL_NOT_ALLOWED',
          span: { start: 0, end: source.length },
        },
      });
    }
  });

  it('should skip unselected branches and their work', () => {
    const schema = { A: { type: 'string' }, B: { type: 'string' } } as const;
    const data = { A: 'a'.repeat(4_096), B: 'a'.repeat(4_096) };
    expect(value('TRUE OR equalsIgnoreCase(A, B)', schema, data)).toBe(true);
    expect(value('FALSE AND equalsIgnoreCase(A, B)', schema, data)).toBe(false);
  });

  it('should evaluate all string built-ins with documented semantics', () => {
    const schema = {
      Text: { type: 'string', nullable: true },
      Search: { type: 'string' },
    } as const;
    const cases = [
      ['isEmpty(Text)', { Text: null, Search: '' }, true],
      ['isEmpty(Text)', { Text: '', Search: '' }, true],
      ['isEmpty(Text)', { Text: ' ', Search: '' }, false],
      ['isBlank(Text)', { Text: ' \t', Search: '' }, true],
      ['contains(Text, Search)', { Text: 'BlendScript', Search: 'Script' }, true],
      ['startsWith(Text, Search)', { Text: 'BlendScript', Search: 'Blend' }, true],
      ['endsWith(Text, Search)', { Text: 'BlendScript', Search: 'Script' }, true],
      ['equalsIgnoreCase(Text, Search)', { Text: 'Blend', Search: 'blend' }, true],
      ['trim(Text)', { Text: '  a b  ', Search: '' }, 'a b'],
      ['lower(Text)', { Text: 'ÄBC', Search: '' }, 'äbc'],
      ['upper(Text)', { Text: 'abc', Search: '' }, 'ABC'],
      ['length(Text)', { Text: '😀a', Search: '' }, 2],
    ] as const;
    for (const [source, data, expected] of cases)
      expect(value(source, schema, data)).toBe(expected);
  });

  it('should use non-locale lowercase semantics for equalsIgnoreCase', () => {
    const schema = { A: { type: 'string' }, B: { type: 'string' } } as const;
    expect(value('equalsIgnoreCase(A, B)', schema, { A: 'İ', B: 'i' })).toBe(false);
    expect(value('equalsIgnoreCase(A, B)', schema, { A: 'ABC', B: 'abc' })).toBe(true);
  });

  it('should precharge native string work before calling it', () => {
    const expression = compile('equalsIgnoreCase(A, B)', {
      A: { type: 'string' },
      B: { type: 'string' },
    });
    expect(
      evaluateExpression(expression, { A: 'a'.repeat(4_096), B: 'a'.repeat(4_096) })
    ).toMatchObject({
      ok: false,
      diagnostic: { code: 'BS_EVALUATION_STEP_LIMIT_EXCEEDED' },
    });
  });

  it('should enforce derived string caps inside equalsIgnoreCase below the work ceiling', () => {
    const source = 'equalsIgnoreCase(A, B)';
    const expression = compile(source, {
      A: { type: 'string' },
      B: { type: 'string' },
    });
    expect(
      evaluateExpression(expression, { A: 'İ'.repeat(3_000), B: 'İ'.repeat(3_000) })
    ).toMatchObject({
      ok: false,
      diagnostic: {
        code: 'BS_STRING_VALUE_LIMIT_EXCEEDED',
        span: { start: 0, end: source.length },
      },
    });
  });

  it('should reject derived strings above the runtime string cap', () => {
    const source = 'upper(Text)';
    expect(
      evaluateExpression(compile(source, { Text: { type: 'string' } }), { Text: 'ß'.repeat(4_096) })
    ).toMatchObject({
      ok: false,
      diagnostic: {
        code: 'BS_STRING_VALUE_LIMIT_EXCEEDED',
        span: { start: 0, end: source.length },
      },
    });
  });

  it('should reuse owned handles independently and reject structural lookalikes', () => {
    const expression = compile('Enabled', { Enabled: { type: 'boolean' } });
    expect(evaluateExpression(expression, { Enabled: true })).toEqual({ ok: true, value: true });
    expect(evaluateExpression(expression, { Enabled: false })).toEqual({ ok: true, value: false });
    expect(() => evaluateExpression({} as never, {})).toThrowError(BlendScriptApiError);
    try {
      evaluateExpression({} as never, {});
    } catch (error) {
      expect(error).toMatchObject({ code: 'BS_INVALID_COMPILED_EXPRESSION' });
    }
  });

  it('should enforce the exact public-valid work boundary', () => {
    const schema = { A: { type: 'string' }, B: { type: 'string' } } as const;
    const data = { A: 'a'.repeat(4_096), B: 'b'.repeat(901) };
    expect(value('NOT contains(trim(A), trim(B))', schema, data)).toBe(true);
    expect(
      evaluateExpression(compile('NOT NOT contains(trim(A), trim(B))', schema), data)
    ).toMatchObject({
      ok: false,
      diagnostic: { code: 'BS_EVALUATION_STEP_LIMIT_EXCEEDED' },
    });
  });
});
