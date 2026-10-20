import { describe, expect, it } from 'vitest';

import { compileExpression, evaluateExpression } from '../../src/index.js';

function compileScalar(nullable = false) {
  const result = compileExpression('TRUE', {
    schema: { Item: { type: 'scalar', nullable } },
  });
  if (!result.ok) throw new Error(result.diagnostics[0]?.code);
  return result.expression;
}

describe('BlendScript scalar record boundary', () => {
  it('should accept only strings and finite numbers for required scalar fields', () => {
    const expression = compileScalar();

    for (const Item of ['001', 'ABC-1', 0, -1, Number.MAX_VALUE]) {
      expect(evaluateExpression(expression, { Item })).toEqual({ ok: true, value: true });
    }

    for (const Item of [true, false, null, {}, [], Number.NaN, Infinity, -Infinity]) {
      const result = evaluateExpression(expression, { Item } as never);
      expect(result).toMatchObject({
        ok: false,
        diagnostic: { code: 'BS_RUNTIME_TYPE_MISMATCH', field: 'Item' },
      });
      if (!result.ok) expect(result.diagnostic).not.toHaveProperty('value');
    }
  });

  it('should accept null only when the scalar field is nullable', () => {
    expect(evaluateExpression(compileScalar(true), { Item: null })).toEqual({
      ok: true,
      value: true,
    });
  });
});
