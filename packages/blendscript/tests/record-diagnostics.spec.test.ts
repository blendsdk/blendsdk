import { describe, expect, it } from 'vitest';

import {
  compileExpression,
  evaluateExpression,
  type ExpressionFieldType,
  type RecordDiagnosticReason,
  type RecordExpressionDiagnosticCode,
  type RuntimeValueType,
} from '../src/index.js';

/** One expected record failure expressed only through the public contract. */
type RecordFailureExpectation = Readonly<{
  code: RecordExpressionDiagnosticCode;
  reason: RecordDiagnosticReason;
  actualType: RuntimeValueType;
  expectedType: ExpressionFieldType;
  nullable: boolean;
  message: string;
}>;

const MISSING_MESSAGE = 'Record is missing required field "Item".';
const ACCESSOR_MESSAGE = 'Record field "Item" must be an own data property.';
const NULL_MESSAGE = 'Record field "Item" cannot be null.';
const TYPE_MESSAGE = 'Record field "Item" does not match its declared type.';
const LENGTH_MESSAGE = 'Record field "Item" exceeds the string length limit.';

function evaluateItem(
  type: ExpressionFieldType,
  record: object,
  nullable = false
): ReturnType<typeof evaluateExpression> {
  const compilation = compileExpression('Item', { schema: { Item: { type, nullable } } });
  if (!compilation.ok) throw new Error('Expected the test expression to compile.');
  return evaluateExpression(compilation.expression, record as never);
}

/**
 * Asserts the complete public record diagnostic, including its exact own
 * member set, so no hidden value-carrying member such as `actualValue` can
 * be added alongside the structured metadata.
 */
function expectRecordFailure(
  type: ExpressionFieldType,
  record: object,
  expected: RecordFailureExpectation,
  nullable = false
): void {
  const result = evaluateItem(type, record, nullable);
  expect(result).toEqual({
    ok: false,
    diagnostic: {
      kind: 'record',
      code: expected.code,
      severity: 'error',
      message: expected.message,
      field: 'Item',
      reason: expected.reason,
      expectedType: expected.expectedType,
      nullable: expected.nullable,
      actualType: expected.actualType,
    },
  });
  if (result.ok) throw new Error('Expected a record failure.');
  expect(Reflect.ownKeys(result.diagnostic).sort()).toEqual([
    'actualType',
    'code',
    'expectedType',
    'field',
    'kind',
    'message',
    'nullable',
    'reason',
    'severity',
  ]);
}

describe('BlendScript record diagnostic metadata', () => {
  it('should report a missing field with a missing actual type', () => {
    expectRecordFailure(
      'string',
      {},
      {
        code: 'BS_MISSING_FIELD',
        reason: 'missing-field',
        actualType: 'missing',
        expectedType: 'string',
        nullable: false,
        message: MISSING_MESSAGE,
      }
    );
  });

  it('should report an accessor property as an accessor failure without invoking it', () => {
    let getterRuns = 0;
    const record = Object.create(null) as Record<PropertyKey, unknown>;
    Object.defineProperty(record, 'Item', {
      get() {
        getterRuns += 1;
        return 'value';
      },
      enumerable: true,
    });

    expectRecordFailure('string', record, {
      code: 'BS_RUNTIME_TYPE_MISMATCH',
      reason: 'accessor-property',
      actualType: 'accessor',
      expectedType: 'string',
      nullable: false,
      message: ACCESSOR_MESSAGE,
    });
    expect(getterRuns).toBe(0);
  });

  it('should report null on a non-nullable field as null-not-allowed', () => {
    expectRecordFailure(
      'string',
      { Item: null },
      {
        code: 'BS_RUNTIME_TYPE_MISMATCH',
        reason: 'null-not-allowed',
        actualType: 'null',
        expectedType: 'string',
        nullable: false,
        message: NULL_MESSAGE,
      }
    );
  });

  it('should keep nullable fields accepting null', () => {
    expect(evaluateItem('string', { Item: null }, true)).toEqual({ ok: true, value: null });
    expect(evaluateItem('scalar', { Item: null }, true)).toEqual({ ok: true, value: null });
  });

  it('should distinguish an own undefined value from a missing field', () => {
    expectRecordFailure(
      'string',
      { Item: undefined },
      {
        code: 'BS_RUNTIME_TYPE_MISMATCH',
        reason: 'type-mismatch',
        actualType: 'undefined',
        expectedType: 'string',
        nullable: false,
        message: TYPE_MESSAGE,
      }
    );
  });

  it('should classify each rejected concrete runtime value precisely', () => {
    const cases = [
      ['string', 1, 'number'],
      ['string', true, 'boolean'],
      ['string', 1n, 'bigint'],
      ['string', Symbol('value'), 'symbol'],
      ['string', () => 'value', 'function'],
      ['string', [1, 2], 'array'],
      ['string', { a: 1 }, 'object'],
      ['string', new Date(0), 'object'],
      ['number', '1', 'string'],
      ['number', true, 'boolean'],
      ['boolean', 'true', 'string'],
      ['boolean', 1, 'number'],
      ['scalar', true, 'boolean'],
      ['scalar', [1], 'array'],
      ['scalar', { a: 1 }, 'object'],
      ['scalar', 1n, 'bigint'],
      ['scalar', undefined, 'undefined'],
    ] as const;

    for (const [type, value, actualType] of cases) {
      expectRecordFailure(
        type,
        { Item: value },
        {
          code: 'BS_RUNTIME_TYPE_MISMATCH',
          reason: 'type-mismatch',
          actualType,
          expectedType: type,
          nullable: false,
          message: TYPE_MESSAGE,
        }
      );
    }
  });

  it('should classify non-finite numbers as non-finite-number for numeric fields', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expectRecordFailure(
        'number',
        { Item: value },
        {
          code: 'BS_RUNTIME_TYPE_MISMATCH',
          reason: 'non-finite-number',
          actualType: 'non-finite-number',
          expectedType: 'number',
          nullable: false,
          message: TYPE_MESSAGE,
        }
      );
      expectRecordFailure(
        'scalar',
        { Item: value },
        {
          code: 'BS_RUNTIME_TYPE_MISMATCH',
          reason: 'non-finite-number',
          actualType: 'non-finite-number',
          expectedType: 'scalar',
          nullable: false,
          message: TYPE_MESSAGE,
        }
      );
    }
  });

  it('should still describe a non-finite number on a non-numeric field precisely', () => {
    expectRecordFailure(
      'string',
      { Item: Number.NaN },
      {
        code: 'BS_RUNTIME_TYPE_MISMATCH',
        reason: 'type-mismatch',
        actualType: 'non-finite-number',
        expectedType: 'string',
        nullable: false,
        message: TYPE_MESSAGE,
      }
    );
  });

  it('should guard array classification against hostile values like revoked proxies', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expectRecordFailure(
      'string',
      { Item: proxy },
      {
        code: 'BS_RUNTIME_TYPE_MISMATCH',
        reason: 'type-mismatch',
        actualType: 'object',
        expectedType: 'string',
        nullable: false,
        message: TYPE_MESSAGE,
      }
    );
  });

  it('should report an oversized string with the string actual type', () => {
    const oversized = 'a'.repeat(4_097);

    expectRecordFailure(
      'string',
      { Item: oversized },
      {
        code: 'BS_STRING_VALUE_LIMIT_EXCEEDED',
        reason: 'string-too-long',
        actualType: 'string',
        expectedType: 'string',
        nullable: false,
        message: LENGTH_MESSAGE,
      }
    );
    expectRecordFailure(
      'scalar',
      { Item: oversized },
      {
        code: 'BS_STRING_VALUE_LIMIT_EXCEEDED',
        reason: 'string-too-long',
        actualType: 'string',
        expectedType: 'scalar',
        nullable: false,
        message: LENGTH_MESSAGE,
      }
    );
  });

  it('should keep the string length boundary inclusive', () => {
    expect(evaluateItem('string', { Item: 'a'.repeat(4_096) })).toEqual({
      ok: true,
      value: 'a'.repeat(4_096),
    });
    expect(evaluateItem('scalar', { Item: 'a'.repeat(4_096) })).toEqual({
      ok: true,
      value: 'a'.repeat(4_096),
    });
  });

  it('should expose the declared nullability on every failure', () => {
    expectRecordFailure(
      'number',
      { Item: 'one' },
      {
        code: 'BS_RUNTIME_TYPE_MISMATCH',
        reason: 'type-mismatch',
        actualType: 'string',
        expectedType: 'number',
        nullable: true,
        message: TYPE_MESSAGE,
      },
      true
    );
    expectRecordFailure(
      'boolean',
      {},
      {
        code: 'BS_MISSING_FIELD',
        reason: 'missing-field',
        actualType: 'missing',
        expectedType: 'boolean',
        nullable: true,
        message: MISSING_MESSAGE,
      },
      true
    );
  });
});
