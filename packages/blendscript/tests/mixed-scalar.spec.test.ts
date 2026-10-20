import { describe, expect, it } from 'vitest';

import {
  compileExpression,
  evaluateExpression,
  validateExpression,
  type CompiledExpression,
  type ExpressionSchema,
  type ExpressionValue,
} from '../src/index.js';

// Scalar fields accept only their two documented runtime representations.
const scalarSchema = Object.freeze({ Item: Object.freeze({ type: 'scalar' as const }) });

function compile(source: string, schema: ExpressionSchema = scalarSchema): CompiledExpression {
  const result = compileExpression(source, { schema });
  if (!result.ok) {
    throw new Error(`Expected compilation success, received ${result.diagnostics[0]?.code}.`);
  }
  return result.expression;
}

function evaluate(source: string, Item: ExpressionValue): ExpressionValue {
  const result = evaluateExpression(compile(source), { Item });
  if (!result.ok) {
    throw new Error(`Expected evaluation success, received ${result.diagnostic.code}.`);
  }
  return result.value;
}

describe('BlendScript mixed scalar fields', () => {
  it('should retain string and finite-number field values without normalization', () => {
    const expression = compile('Item');

    for (const Item of [1, '1', 'ABC-1', '001'] as const) {
      expect(evaluateExpression(expression, { Item })).toEqual({ ok: true, value: Item });
    }
  });

  it('should keep scalar nullability explicit', () => {
    const required = compile('Item');
    expect(evaluateExpression(required, { Item: null })).toMatchObject({
      ok: false,
      diagnostic: { code: 'BS_RUNTIME_TYPE_MISMATCH', field: 'Item' },
    });

    const nullable = compile('Item == NULL', {
      Item: { type: 'scalar', nullable: true },
    });
    expect(evaluateExpression(nullable, { Item: null })).toEqual({ ok: true, value: true });
  });

  it('should convert finite numbers and complete decimal text with tryNumber', () => {
    const cases = [
      [1, 1],
      ['1', 1],
      ['001', 1],
      ['-12.5', -12.5],
      ['.5', 0.5],
      ['5.', 5],
      ['+2', 2],
      ['1e3', 1_000],
    ] as const;

    for (const [Item, expected] of cases) {
      expect(evaluate('tryNumber(Item)', Item)).toBe(expected);
    }
  });

  it('should return null for invalid, blank, partial, or non-finite numeric text', () => {
    for (const Item of [
      '',
      ' ',
      '\t',
      'ABC-1',
      '1abc',
      ' 1',
      '1 ',
      '0x10',
      'NaN',
      'Infinity',
      '1e309',
    ]) {
      expect(evaluate('tryNumber(Item)', Item)).toBeNull();
    }
  });

  it('should preserve text and explicitly format finite numbers with text', () => {
    expect(evaluate('text(Item)', 1)).toBe('1');
    expect(evaluate('text(Item)', '1')).toBe('1');
    expect(evaluate('text(Item)', '001')).toBe('001');
    expect(evaluate('text(Item)', 'ABC-1')).toBe('ABC-1');
  });

  it('should support safe numeric and exact textual rules without implicit coercion', () => {
    const numeric = compile('tryNumber(Item) != NULL AND tryNumber(Item) > 1');
    expect(evaluateExpression(numeric, { Item: '2' })).toEqual({ ok: true, value: true });
    expect(evaluateExpression(numeric, { Item: 'ABC-1' })).toEqual({ ok: true, value: false });

    const textual = compile('text(Item) == "001"');
    expect(evaluateExpression(textual, { Item: '001' })).toEqual({ ok: true, value: true });
    expect(evaluateExpression(textual, { Item: 1 })).toEqual({ ok: true, value: false });
  });

  it('should reject direct scalar use where an operator or built-in needs a concrete type', () => {
    for (const source of ['Item > 1', 'Item == 1', 'contains(Item, "1")']) {
      const result = validateExpression(source, { schema: scalarSchema });
      expect(result).toMatchObject({
        ok: false,
        diagnostics: [{ code: 'BS_TYPE_MISMATCH' }],
      });
      if (!result.ok) {
        expect(result.diagnostics[0]?.message).toMatch(/text\(\.\.\.\)|tryNumber\(\.\.\.\)/u);
      }
    }
  });

  it('should preserve string and evaluation-work limits for scalar conversions', () => {
    const textExpression = compile('text(Item)');
    expect(evaluateExpression(textExpression, { Item: 'a'.repeat(4_096) })).toEqual({
      ok: true,
      value: 'a'.repeat(4_096),
    });
    expect(evaluateExpression(textExpression, { Item: 'a'.repeat(4_097) })).toMatchObject({
      ok: false,
      diagnostic: { code: 'BS_STRING_VALUE_LIMIT_EXCEEDED', field: 'Item' },
    });

    const repeatedConversions = Array.from({ length: 3 }, () => 'text(Item) == "x"').join(' OR ');
    const workLimited = compile(repeatedConversions);
    expect(evaluateExpression(workLimited, { Item: 'a'.repeat(4_096) })).toMatchObject({
      ok: false,
      diagnostic: { code: 'BS_EVALUATION_STEP_LIMIT_EXCEEDED' },
    });
  });
});
