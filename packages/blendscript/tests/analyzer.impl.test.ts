import { describe, expect, it } from 'vitest';

import { analyze } from '../src/analyzer.js';
import { lex } from '../src/lexer.js';
import { parse } from '../src/parser.js';

function expressionFor(source: string) {
  const lexical = lex(source);
  if (!lexical.ok) throw new Error(lexical.diagnostic.code);
  const parsed = parse(source, lexical.tokens);
  if (!parsed.ok) throw new Error(parsed.diagnostic.code);
  return parsed.expression;
}

describe('analyzer internals', () => {
  it('should suppress cascading type findings after unknown fields', () => {
    const source = 'Missing AND AlsoMissing';
    const result = analyze(source, expressionFor(source), []);
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        { code: 'BS_UNKNOWN_FIELD', span: { start: 0, end: 7 } },
        { code: 'BS_UNKNOWN_FIELD', span: { start: 12, end: 23 } },
      ],
    });
  });

  it('should retain exact schema spelling and immutable metadata', () => {
    const source = 'B AND A AND B';
    const result = analyze(source, expressionFor(source), [
      Object.freeze({ name: 'A', type: 'boolean', nullable: false, index: 0 }),
      Object.freeze({ name: 'B', type: 'boolean', nullable: false, index: 1 }),
    ]);
    expect(result).toMatchObject({ ok: true, referencedFields: ['B', 'A'] });
    if (result.ok) {
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.resultType)).toBe(true);
      expect(Object.isFrozen(result.referencedFields)).toBe(true);
    }
  });

  it('should retain scalar types and conversion nullability in inferred metadata', () => {
    const schema = [
      Object.freeze({ name: 'Item', type: 'scalar' as const, nullable: false, index: 0 }),
    ];

    expect(analyze('Item', expressionFor('Item'), schema)).toMatchObject({
      ok: true,
      resultType: { type: 'scalar', nullable: false },
    });
    expect(analyze('tryNumber(Item)', expressionFor('tryNumber(Item)'), schema)).toMatchObject({
      ok: true,
      resultType: { type: 'number', nullable: true },
    });
    expect(analyze('text(Item)', expressionFor('text(Item)'), schema)).toMatchObject({
      ok: true,
      resultType: { type: 'string', nullable: false },
    });
  });
});
