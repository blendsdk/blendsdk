import { describe, expect, it } from 'vitest';

import { compileExpression, evaluateExpression, validateExpression } from '../src/api.js';
import { BlendScriptApiError } from '../src/errors.js';
import { getCompiledPayload } from '../src/compiled-expression.js';
import { snapshotOptions } from '../src/input-validation.js';

describe('API pipeline internals', () => {
  it('should snapshot schema descriptors without retaining later mutations', () => {
    const field = { type: 'string' as const };
    const schema = { Name: field };
    const snapshot = snapshotOptions({ schema });
    field.type = 'number' as never;
    schema.Name = { type: 'boolean' } as never;

    expect(snapshot.schema).toEqual([{ name: 'Name', type: 'string', nullable: false, index: 0 }]);
    expect(Object.isFrozen(snapshot.schema)).toBe(true);
    expect(Object.isFrozen(snapshot.schema[0])).toBe(true);
  });

  it('should create fresh handles backed by immutable private payloads', () => {
    const options = { schema: { Enabled: { type: 'boolean' as const } } };
    const first = compileExpression('Enabled', options);
    const second = compileExpression('Enabled', options);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    if (!first.ok || !second.ok) return;

    expect(first.expression).not.toBe(second.expression);
    expect(Object.isFrozen(first.expression)).toBe(true);
    const payload = getCompiledPayload(first.expression);
    expect(payload).toMatchObject({ source: 'Enabled', referencedFields: ['Enabled'] });
    expect(Object.isFrozen(payload)).toBe(true);
  });

  it('should keep validation and compilation on one normalized pipeline', () => {
    const options = { schema: { Value: { type: 'number' as const } } };
    const validation = validateExpression('Value >= 10', options);
    const compilation = compileExpression('Value >= 10', options);
    expect(validation).toMatchObject({ ok: true });
    expect(compilation).toMatchObject(validation);

    expect(compileExpression('Value == "10"', options)).toEqual(
      validateExpression('Value == "10"', options)
    );
  });

  it('should reject every forged handle shape through the private identity registry', () => {
    for (const forged of [null, true, 1, 'compiled', {}, Object.freeze({})]) {
      expect(() => evaluateExpression(forged as never, {})).toThrowError(BlendScriptApiError);
      try {
        evaluateExpression(forged as never, {});
      } catch (error) {
        expect(error).toMatchObject({ code: 'BS_INVALID_COMPILED_EXPRESSION' });
      }
    }
  });

  it('should reuse one handle without retaining record state', () => {
    const result = compileExpression('Enabled', {
      schema: { Enabled: { type: 'boolean' } },
    });
    if (!result.ok) throw new Error(result.diagnostics[0]?.code);
    const first = Object.freeze({ Enabled: true });
    const second = Object.freeze({ Enabled: false });
    expect(evaluateExpression(result.expression, first)).toEqual({ ok: true, value: true });
    expect(evaluateExpression(result.expression, second)).toEqual({ ok: true, value: false });
    expect(evaluateExpression(result.expression, first)).toEqual({ ok: true, value: true });
  });
});
