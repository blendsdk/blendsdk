import { describe, expect, it } from 'vitest';

import { compileExpression } from '../src/api.js';
import { getCompiledPayload } from '../src/compiled-expression.js';
import { evaluatePayload } from '../src/evaluator.js';

function payload(source: string, schema: Parameters<typeof compileExpression>[1]['schema']) {
  const result = compileExpression(source, { schema });
  if (!result.ok) throw new Error(result.diagnostics[0]?.code);
  return getCompiledPayload(result.expression);
}

describe('evaluator internals', () => {
  it('should execute every private node family left-to-right', () => {
    const schema = {
      A: { type: 'number' as const },
      B: { type: 'boolean' as const },
      S: { type: 'string' as const },
    };
    const data = { A: 2, B: true, S: ' x ' };
    const cases = [
      ['42', 42],
      ['A', 2],
      ['NOT B', false],
      ['A >= 2 AND B', true],
      ['S IN ("x", " x ")', true],
      ['trim(S)', 'x'],
    ] as const;
    for (const [source, expected] of cases) {
      expect(evaluatePayload(payload(source, schema), data)).toEqual({ ok: true, value: expected });
    }
  });

  it('should return the first record failure in captured schema order', () => {
    const result = evaluatePayload(
      payload('TRUE', {
        First: { type: 'string' },
        Second: { type: 'number' },
      }),
      { First: 1, Second: 'wrong' }
    );
    expect(result).toMatchObject({
      ok: false,
      diagnostic: { kind: 'record', code: 'BS_RUNTIME_TYPE_MISMATCH', field: 'First' },
    });
  });

  it('should leave compiled payload and input state unchanged across failures', () => {
    const compiledPayload = payload('trim(Text)', {
      Text: { type: 'string', nullable: true },
    });
    const data = Object.freeze({ Text: null });
    const before = JSON.stringify(compiledPayload.referencedFields);
    const first = evaluatePayload(compiledPayload, data);
    const second = evaluatePayload(compiledPayload, data);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ ok: false, diagnostic: { code: 'BS_NULL_NOT_ALLOWED' } });
    expect(JSON.stringify(compiledPayload.referencedFields)).toBe(before);
    expect(Object.isFrozen(data)).toBe(true);
  });

  it('should freeze successful and failed public results', () => {
    const compiledPayload = payload('Text == "x"', { Text: { type: 'string' } });
    const success = evaluatePayload(compiledPayload, { Text: 'x' });
    const failure = evaluatePayload(compiledPayload, {});
    expect(Object.isFrozen(success)).toBe(true);
    expect(Object.isFrozen(failure)).toBe(true);
    if (!failure.ok) expect(Object.isFrozen(failure.diagnostic)).toBe(true);
  });

  it('should let nullable numeric conversion absorb null while text conversion rejects it', () => {
    expect(evaluatePayload(payload('tryNumber(NULL)', {}), {})).toEqual({
      ok: true,
      value: null,
    });

    const textPayload = payload('text(Item)', {
      Item: { type: 'scalar', nullable: true },
    });
    expect(evaluatePayload(textPayload, { Item: null })).toMatchObject({
      ok: false,
      diagnostic: { code: 'BS_NULL_NOT_ALLOWED' },
    });
  });
});
