import { describe, expect, it } from 'vitest';

import { lex } from '../src/lexer.js';
import { parse } from '../src/parser.js';

function parseSource(source: string) {
  const lexical = lex(source);
  if (!lexical.ok) throw new Error(`Unexpected lexical failure: ${lexical.diagnostic.code}`);
  return parse(source, lexical.tokens);
}

describe('parser internals', () => {
  it('should build explicit AND-before-OR precedence', () => {
    expect(parseSource('A OR B AND C')).toMatchObject({
      ok: true,
      expression: {
        kind: 'binary',
        operator: 'or',
        left: { kind: 'field', name: 'A' },
        right: {
          kind: 'binary',
          operator: 'and',
          left: { kind: 'field', name: 'B' },
          right: { kind: 'field', name: 'C' },
        },
      },
    });
  });

  it('should bind NOT tighter than comparison and grouping explicitly', () => {
    expect(parseSource('NOT A == TRUE')).toMatchObject({
      ok: true,
      expression: {
        kind: 'binary',
        operator: 'equal',
        left: { kind: 'unary', operand: { kind: 'field', name: 'A' } },
      },
    });
    expect(parseSource('NOT (A == TRUE)')).toMatchObject({
      ok: true,
      expression: { kind: 'unary', operand: { kind: 'binary', operator: 'equal' } },
    });
  });

  it('should keep membership members immutable and literal-only', () => {
    const result = parseSource('Country IN ("GB", "NL")');
    expect(result).toMatchObject({ ok: true, expression: { kind: 'membership' } });
    if (result.ok && result.expression.kind === 'membership') {
      expect(Object.isFrozen(result.expression.members)).toBe(true);
      expect(result.expression.members.map(({ value }) => value)).toEqual(['GB', 'NL']);
    }
  });

  it('should distinguish bare fields from same-named built-in calls', () => {
    expect(parseSource('Text')).toMatchObject({
      ok: true,
      expression: { kind: 'field', name: 'Text' },
    });
    expect(parseSource('text(Item)')).toMatchObject({
      ok: true,
      expression: { kind: 'call', name: 'text' },
    });
  });
});
