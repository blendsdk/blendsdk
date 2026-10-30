import { describe, expect, it } from 'vitest';
import { isNumeric } from '../src/isNumeric.js';

describe('isNumeric', () => {
  describe('should return true for finite number primitives', () => {
    it('should return true for integer zero', () => {
      expect(isNumeric(0)).toBe(true);
    });

    it('should return true for positive integers', () => {
      expect(isNumeric(1)).toBe(true);
      expect(isNumeric(42)).toBe(true);
      expect(isNumeric(1000)).toBe(true);
    });

    it('should return true for negative integers', () => {
      expect(isNumeric(-1)).toBe(true);
      expect(isNumeric(-42)).toBe(true);
      expect(isNumeric(-1000)).toBe(true);
    });

    it('should return true for positive decimals', () => {
      expect(isNumeric(3.14)).toBe(true);
      expect(isNumeric(0.5)).toBe(true);
      expect(isNumeric(99.99)).toBe(true);
    });

    it('should return true for negative decimals', () => {
      expect(isNumeric(-3.14)).toBe(true);
      expect(isNumeric(-0.5)).toBe(true);
      expect(isNumeric(-99.99)).toBe(true);
    });

    it('should return true for very large numbers', () => {
      expect(isNumeric(Number.MAX_VALUE)).toBe(true);
      expect(isNumeric(Number.MAX_SAFE_INTEGER)).toBe(true);
    });

    it('should return true for very small numbers', () => {
      expect(isNumeric(Number.MIN_VALUE)).toBe(true);
      expect(isNumeric(Number.MIN_SAFE_INTEGER)).toBe(true);
    });

    it('should return true for zero variations', () => {
      expect(isNumeric(0)).toBe(true);
      expect(isNumeric(-0)).toBe(true);
      expect(isNumeric(+0)).toBe(true);
    });

    it('should return true for mathematical operations', () => {
      expect(isNumeric(1 + 1)).toBe(true);
      expect(isNumeric(10 / 2)).toBe(true);
      expect(isNumeric(5 * 3)).toBe(true);
      expect(isNumeric(10 - 5)).toBe(true);
    });

    it('should return true for floating point results', () => {
      expect(isNumeric(0.1 + 0.2)).toBe(true);
      expect(isNumeric(0.3)).toBe(true);
    });
  });

  describe('should return true for valid numeric strings', () => {
    it('should return true for integer strings', () => {
      expect(isNumeric('0')).toBe(true);
      expect(isNumeric('42')).toBe(true);
      expect(isNumeric('-42')).toBe(true);
    });

    it('should return true for decimal strings', () => {
      expect(isNumeric('3.14')).toBe(true);
      expect(isNumeric('-3.14')).toBe(true);
      expect(isNumeric('0.5')).toBe(true);
    });

    it('should return true for strings with whitespace (trimmed)', () => {
      expect(isNumeric(' 42')).toBe(true);
      expect(isNumeric('42 ')).toBe(true);
      expect(isNumeric(' 42 ')).toBe(true);
      expect(isNumeric('  3.14  ')).toBe(true);
    });

    it('should return true for scientific notation strings', () => {
      expect(isNumeric('1e10')).toBe(true);
      expect(isNumeric('1.5e-10')).toBe(true);
      expect(isNumeric('2.5E+3')).toBe(true);
    });

    it('should return true for hexadecimal strings', () => {
      expect(isNumeric('0xFF')).toBe(true);
      expect(isNumeric('0x10')).toBe(true);
    });

    it('should return true for octal strings', () => {
      expect(isNumeric('0o10')).toBe(true);
      expect(isNumeric('0o777')).toBe(true);
    });

    it('should return true for binary strings', () => {
      expect(isNumeric('0b1010')).toBe(true);
      expect(isNumeric('0b11111111')).toBe(true);
    });

    it('should return true for numbers with leading zeros', () => {
      expect(isNumeric('007')).toBe(true);
      expect(isNumeric('00042')).toBe(true);
    });

    it('should return true for numbers with plus sign', () => {
      expect(isNumeric('+42')).toBe(true);
      expect(isNumeric('+3.14')).toBe(true);
    });

    it('should return true for decimal-only strings', () => {
      expect(isNumeric('.5')).toBe(true);
      expect(isNumeric('.99')).toBe(true);
      expect(isNumeric('-.5')).toBe(true);
    });

    it('should return true for zero string variations', () => {
      expect(isNumeric('0')).toBe(true);
      expect(isNumeric('-0')).toBe(true);
      expect(isNumeric('+0')).toBe(true);
    });
  });

  describe('should return false for non-numeric number types', () => {
    it('should return false for NaN', () => {
      expect(isNumeric(NaN)).toBe(false);
    });

    it('should return false for Infinity', () => {
      // BREAKING CHANGE: Infinity is not finite, so isNumeric returns false
      expect(isNumeric(Infinity)).toBe(false);
      expect(isNumeric(-Infinity)).toBe(false);
    });
  });

  describe('should return false for non-numeric values', () => {
    it('should return false for null', () => {
      expect(isNumeric(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isNumeric(undefined)).toBe(false);
    });

    it('should return false for boolean true', () => {
      expect(isNumeric(true)).toBe(false);
    });

    it('should return false for boolean false', () => {
      expect(isNumeric(false)).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isNumeric('')).toBe(false);
    });

    it('should return false for whitespace-only strings', () => {
      expect(isNumeric('   ')).toBe(false);
      expect(isNumeric('\t')).toBe(false);
      expect(isNumeric('\n')).toBe(false);
    });

    it('should return false for non-numeric strings', () => {
      expect(isNumeric('hello')).toBe(false);
      expect(isNumeric('test')).toBe(false);
      expect(isNumeric('abc123')).toBe(false);
    });

    it('should return false for partial numeric strings (BREAKING CHANGE)', () => {
      // BREAKING CHANGE: Unlike parseFloat, the new implementation rejects
      // strings that contain non-numeric characters after the number.
      expect(isNumeric('42px')).toBe(false);
      expect(isNumeric('3.14em')).toBe(false);
      expect(isNumeric('100%')).toBe(false);
    });

    it('should return false for strings with letters before numbers', () => {
      expect(isNumeric('px42')).toBe(false);
      expect(isNumeric('em3.14')).toBe(false);
    });

    it('should return false for empty array', () => {
      expect(isNumeric([])).toBe(false);
    });

    it('should return false for single-element numeric arrays', () => {
      // BREAKING CHANGE: Arrays are no longer accepted
      expect(isNumeric([42])).toBe(false);
      expect(isNumeric([3.14])).toBe(false);
    });

    it('should return false for multi-element arrays', () => {
      expect(isNumeric([1, 2, 3])).toBe(false);
    });

    it('should return false for empty object', () => {
      expect(isNumeric({})).toBe(false);
    });

    it('should return false for objects', () => {
      expect(isNumeric({ value: 42 })).toBe(false);
    });

    it('should return false for objects with numeric toString', () => {
      // BREAKING CHANGE: Objects are no longer accepted, even with toString
      expect(isNumeric({ toString: () => '42' })).toBe(false);
    });

    it('should return false for functions', () => {
      expect(isNumeric(() => {})).toBe(false);
      expect(isNumeric(function () {})).toBe(false);
      expect(isNumeric(() => 42)).toBe(false);
    });

    it('should return false for Date objects', () => {
      expect(isNumeric(new Date())).toBe(false);
    });

    it('should return false for RegExp objects', () => {
      expect(isNumeric(/\d+/)).toBe(false);
    });

    it('should return false for Symbol', () => {
      // Symbols are not numbers or strings, so we return false (no throw)
      expect(isNumeric(Symbol('42'))).toBe(false);
    });

    it('should return false for BigInt', () => {
      // BREAKING CHANGE: BigInt is not a number or string type
      expect(isNumeric(BigInt(123))).toBe(false);
    });

    it('should return false for strings with multiple dots', () => {
      // BREAKING CHANGE: "3.14.15" is not a valid number
      expect(isNumeric('3.14.15')).toBe(false);
      expect(isNumeric('1.2.3.4')).toBe(false);
    });

    it('should return false for strings with commas', () => {
      // BREAKING CHANGE: "1,000" is not a valid JS number literal
      expect(isNumeric('1,000')).toBe(false);
      expect(isNumeric('3,14')).toBe(false);
    });

    it('should return false for currency strings', () => {
      expect(isNumeric('$42')).toBe(false);
      expect(isNumeric('€100')).toBe(false);
      expect(isNumeric('£50')).toBe(false);
    });

    it('should return false for Number constructor', () => {
      expect(isNumeric(Number)).toBe(false);
    });

    it('should return false for Number object instances', () => {
      // BREAKING CHANGE: Number object wrappers are not number primitives
      expect(isNumeric(new Number(42))).toBe(false);
      expect(isNumeric(new Number('42'))).toBe(false);
      expect(isNumeric(new Number('hello'))).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should return false for string "NaN"', () => {
      expect(isNumeric('NaN')).toBe(false);
    });

    it('should return false for string "Infinity"', () => {
      // BREAKING CHANGE: "Infinity" parses to Infinity which is not finite
      expect(isNumeric('Infinity')).toBe(false);
      expect(isNumeric('-Infinity')).toBe(false);
    });

    it('should return false for string "null"', () => {
      expect(isNumeric('null')).toBe(false);
    });

    it('should return false for string "undefined"', () => {
      expect(isNumeric('undefined')).toBe(false);
    });

    it('should work with variables', () => {
      const num = 42;
      const str = '42';
      const nonNum = 'hello';

      expect(isNumeric(num)).toBe(true);
      expect(isNumeric(str)).toBe(true);
      expect(isNumeric(nonNum)).toBe(false);
    });

    it('should work with function return values', () => {
      const returnNumber = () => 42;
      const returnString = () => '42';
      const returnNonNumeric = () => 'hello';

      expect(isNumeric(returnNumber())).toBe(true);
      expect(isNumeric(returnString())).toBe(true);
      expect(isNumeric(returnNonNumeric())).toBe(false);
    });

    it('should return true for scientific notation number primitives', () => {
      expect(isNumeric(1e10)).toBe(true);
      expect(isNumeric(1.5e-10)).toBe(true);
    });
  });
});
