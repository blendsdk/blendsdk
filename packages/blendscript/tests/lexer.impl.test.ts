import { describe, expect, it } from 'vitest';

import { lex } from '../src/lexer.js';

describe('lexer internals', () => {
  it('should always consume input or return one diagnostic', () => {
    for (let code = 0; code <= 0xff; code += 1) {
      const result = lex(String.fromCharCode(code));
      expect(result.ok || result.diagnostic.kind === 'source').toBe(true);
    }
  });

  it('should preserve exact token spans and decoded values', () => {
    const result = lex('[A]]B] == "\\u0041"');
    expect(result).toMatchObject({
      ok: true,
      tokens: [
        { kind: 'field', value: 'A]B', start: 0, end: 6 },
        { kind: 'equal', start: 7, end: 9 },
        { kind: 'string', value: 'A', start: 10, end: 18 },
        { kind: 'eof', start: 18, end: 18 },
      ],
    });
  });

  it('should recognize keywords without changing identifier spelling', () => {
    const result = lex('true Or Country');
    expect(result).toMatchObject({
      ok: true,
      tokens: [
        { kind: 'true', value: true },
        { kind: 'or', value: 'Or' },
        { kind: 'identifier', value: 'Country' },
        { kind: 'eof' },
      ],
    });
  });
});
