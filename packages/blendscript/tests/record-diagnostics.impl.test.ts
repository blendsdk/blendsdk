import { describe, expect, it } from 'vitest';

import {
  compileExpression,
  evaluateExpression,
  type ExpressionSchema,
  type RecordExpressionDiagnostic,
} from '../src/index.js';

function failedDiagnostic(
  schema: ExpressionSchema,
  record: object,
  source = 'Item'
): RecordExpressionDiagnostic {
  const compilation = compileExpression(source, { schema });
  if (!compilation.ok) throw new Error('Expected the test expression to compile.');
  const result = evaluateExpression(compilation.expression, record as never);
  if (result.ok) throw new Error('Expected a record failure.');
  return result.diagnostic;
}

const stringItem = Object.freeze({ Item: Object.freeze({ type: 'string' as const }) });
const scalarItem = Object.freeze({ Item: Object.freeze({ type: 'scalar' as const }) });

describe('BlendScript record diagnostic internals', () => {
  it('should freeze every emitted record diagnostic', () => {
    for (const [schema, record] of [
      [stringItem, {}],
      [stringItem, { Item: 1 }],
      [scalarItem, { Item: null }],
    ] as const) {
      expect(Object.isFrozen(failedDiagnostic(schema, record))).toBe(true);
    }
  });

  it('should report failures in captured schema order, not record order', () => {
    const schema = { Zeta: { type: 'string' }, Alpha: { type: 'number' } } as const;

    expect(failedDiagnostic(schema, { Alpha: 'not-a-number' }, 'Zeta == "x"')).toMatchObject({
      field: 'Zeta',
      reason: 'missing-field',
      actualType: 'missing',
    });
    expect(
      failedDiagnostic(schema, { Zeta: 1, Alpha: 'not-a-number' }, 'Zeta == "x"')
    ).toMatchObject({
      field: 'Zeta',
      reason: 'type-mismatch',
      actualType: 'number',
    });
  });

  it('should keep the missing-versus-undefined boundary explicit', () => {
    expect(failedDiagnostic(stringItem, {})).toMatchObject({
      reason: 'missing-field',
      actualType: 'missing',
      code: 'BS_MISSING_FIELD',
    });
    expect(failedDiagnostic(stringItem, { Item: undefined })).toMatchObject({
      reason: 'type-mismatch',
      actualType: 'undefined',
      code: 'BS_RUNTIME_TYPE_MISMATCH',
    });
  });

  it('should preserve declared nullability through every failure family', () => {
    const required = { Item: { type: 'boolean' } } as const;
    const nullable = { Item: { type: 'boolean', nullable: true } } as const;

    expect(failedDiagnostic(required, {})).toMatchObject({ nullable: false });
    expect(failedDiagnostic(nullable, {})).toMatchObject({ nullable: true });
    expect(failedDiagnostic(nullable, { Item: 'true' })).toMatchObject({
      nullable: true,
      reason: 'type-mismatch',
    });
  });

  it('should expose the declared type including scalar on every failure reason', () => {
    const accessorRecord = Object.create(null) as Record<PropertyKey, unknown>;
    Object.defineProperty(accessorRecord, 'Item', { get: () => 'value', enumerable: true });
    expect(failedDiagnostic(scalarItem, accessorRecord)).toMatchObject({
      expectedType: 'scalar',
      reason: 'accessor-property',
      actualType: 'accessor',
    });
    expect(failedDiagnostic(scalarItem, {})).toMatchObject({
      expectedType: 'scalar',
      reason: 'missing-field',
    });
    expect(failedDiagnostic(scalarItem, { Item: null })).toMatchObject({
      expectedType: 'scalar',
      reason: 'null-not-allowed',
    });
    expect(failedDiagnostic(scalarItem, { Item: 'a'.repeat(4_097) })).toMatchObject({
      expectedType: 'scalar',
      reason: 'string-too-long',
    });
  });

  it('should cover the reachable reason and actual-type matrix with stable codes', () => {
    const cases = [
      ['string', 1, 'type-mismatch', 'number', 'BS_RUNTIME_TYPE_MISMATCH'],
      ['number', '1', 'type-mismatch', 'string', 'BS_RUNTIME_TYPE_MISMATCH'],
      ['boolean', 1, 'type-mismatch', 'number', 'BS_RUNTIME_TYPE_MISMATCH'],
      ['scalar', true, 'type-mismatch', 'boolean', 'BS_RUNTIME_TYPE_MISMATCH'],
      ['scalar', [1], 'type-mismatch', 'array', 'BS_RUNTIME_TYPE_MISMATCH'],
      ['string', Number.NaN, 'type-mismatch', 'non-finite-number', 'BS_RUNTIME_TYPE_MISMATCH'],
      [
        'number',
        Number.POSITIVE_INFINITY,
        'non-finite-number',
        'non-finite-number',
        'BS_RUNTIME_TYPE_MISMATCH',
      ],
      [
        'scalar',
        Number.NEGATIVE_INFINITY,
        'non-finite-number',
        'non-finite-number',
        'BS_RUNTIME_TYPE_MISMATCH',
      ],
      ['string', 'a'.repeat(4_097), 'string-too-long', 'string', 'BS_STRING_VALUE_LIMIT_EXCEEDED'],
    ] as const;

    for (const [type, value, reason, actualType, code] of cases) {
      const diagnostic = failedDiagnostic({ Item: { type } }, { Item: value });
      expect(diagnostic).toMatchObject({ reason, actualType, code });
    }
  });

  it('should accept nullable null and both scalar representations without diagnostics', () => {
    for (const [schema, record, expected] of [
      [{ Item: { type: 'string', nullable: true } }, { Item: null }, null],
      [scalarItem, { Item: 7 }, 7],
      [scalarItem, { Item: '007' }, '007'],
    ] as const) {
      const compilation = compileExpression('Item', { schema });
      if (!compilation.ok) throw new Error('Expected the test expression to compile.');
      expect(evaluateExpression(compilation.expression, record as never)).toEqual({
        ok: true,
        value: expected,
      });
    }
  });
});
