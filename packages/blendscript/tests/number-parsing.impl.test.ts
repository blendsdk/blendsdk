import { describe, expect, it } from 'vitest';

import { matchDecimalNumberPrefix, parseFiniteDecimal } from '../src/number-parsing.js';

describe('decimal number parsing internals', () => {
  it('should expose the numeric prefix needed for precise lexer diagnostics', () => {
    expect(matchDecimalNumberPrefix('12.5suffix')).toBe('12.5');
    expect(matchDecimalNumberPrefix('not-a-number')).toBeUndefined();
  });

  it('should parse only complete finite decimal values', () => {
    expect(parseFiniteDecimal('001')).toBe(1);
    expect(parseFiniteDecimal('-2.5E-2')).toBe(-0.025);
    expect(parseFiniteDecimal('1abc')).toBeNull();
    expect(parseFiniteDecimal('1e309')).toBeNull();
    expect(parseFiniteDecimal('')).toBeNull();
  });
});
