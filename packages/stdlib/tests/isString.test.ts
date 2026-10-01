import { describe, expect, it } from 'vitest';
import { isString } from '../src/isString.js';

describe('isString', () => {
  describe('should return true for string values', () => {
    it('should return true for empty string', () => {
      expect(isString('')).toBe(true);
    });

    it('should return true for simple strings', () => {
      expect(isString('hello')).toBe(true);
      expect(isString('world')).toBe(true);
      expect(isString('test')).toBe(true);
    });

    it('should return true for strings with spaces', () => {
      expect(isString('hello world')).toBe(true);
      expect(isString('  spaces  ')).toBe(true);
    });

    it('should return true for numeric strings', () => {
      expect(isString('0')).toBe(true);
      expect(isString('42')).toBe(true);
      expect(isString('3.14')).toBe(true);
      expect(isString('-100')).toBe(true);
    });

    it('should return true for boolean strings', () => {
      expect(isString('true')).toBe(true);
      expect(isString('false')).toBe(true);
    });

    it('should return true for special value strings', () => {
      expect(isString('null')).toBe(true);
      expect(isString('undefined')).toBe(true);
      expect(isString('NaN')).toBe(true);
    });

    it('should return true for strings with special characters', () => {
      expect(isString('hello!')).toBe(true);
      expect(isString('test@example.com')).toBe(true);
      expect(isString('$100')).toBe(true);
      expect(isString('50%')).toBe(true);
    });

    it('should return true for strings with newlines', () => {
      expect(isString('line1\nline2')).toBe(true);
      expect(isString('tab\tseparated')).toBe(true);
    });

    it('should return true for strings with unicode', () => {
      expect(isString('café')).toBe(true);
      expect(isString('日本語')).toBe(true);
      expect(isString('🎉')).toBe(true);
      expect(isString('Ñoño')).toBe(true);
    });

    it('should return true for template literals', () => {
      expect(isString(`template`)).toBe(true);
      expect(
        isString(`multi
line`)
      ).toBe(true);
    });

    it('should return true for strings with quotes', () => {
      expect(isString("it's")).toBe(true);
      expect(isString('say "hello"')).toBe(true);
      expect(isString(`both 'single' and "double"`)).toBe(true);
    });

    it('should return true for JSON strings', () => {
      expect(isString('{"key":"value"}')).toBe(true);
      expect(isString('[1,2,3]')).toBe(true);
    });

    it('should return true for HTML strings', () => {
      expect(isString('<div>content</div>')).toBe(true);
      expect(isString('<p>paragraph</p>')).toBe(true);
    });

    it('should return true for URL strings', () => {
      expect(isString('https://example.com')).toBe(true);
      expect(isString('http://localhost:3000')).toBe(true);
    });

    it('should return true for path strings', () => {
      expect(isString('/path/to/file')).toBe(true);
      expect(isString('C:\\Windows\\System32')).toBe(true);
    });

    it('should return true for whitespace strings', () => {
      expect(isString(' ')).toBe(true);
      expect(isString('   ')).toBe(true);
      expect(isString('\t')).toBe(true);
      expect(isString('\n')).toBe(true);
      expect(isString('\r\n')).toBe(true);
    });

    it('should return true for String object primitives', () => {
      expect(isString(String('hello'))).toBe(true);
      expect(isString(String(42))).toBe(true);
      expect(isString(String(true))).toBe(true);
    });

    it('should return true for concatenated strings', () => {
      expect(isString('hello' + ' ' + 'world')).toBe(true);
      expect(isString('test'.concat(' string'))).toBe(true);
    });

    it('should return true for string methods results', () => {
      expect(isString('HELLO'.toLowerCase())).toBe(true);
      expect(isString('hello'.toUpperCase())).toBe(true);
      expect(isString('  trim  '.trim())).toBe(true);
      expect(isString('hello world'.substring(0, 5))).toBe(true);
    });
  });

  describe('should return false for non-string values', () => {
    it('should return false for null', () => {
      expect(isString(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isString(undefined)).toBe(false);
    });

    it('should return false for boolean true', () => {
      expect(isString(true)).toBe(false);
    });

    it('should return false for boolean false', () => {
      expect(isString(false)).toBe(false);
    });

    it('should return false for number zero', () => {
      expect(isString(0)).toBe(false);
    });

    it('should return false for positive numbers', () => {
      expect(isString(1)).toBe(false);
      expect(isString(42)).toBe(false);
      expect(isString(3.14)).toBe(false);
    });

    it('should return false for negative numbers', () => {
      expect(isString(-1)).toBe(false);
      expect(isString(-42)).toBe(false);
      expect(isString(-3.14)).toBe(false);
    });

    it('should return false for NaN', () => {
      expect(isString(NaN)).toBe(false);
    });

    it('should return false for Infinity', () => {
      expect(isString(Infinity)).toBe(false);
      expect(isString(-Infinity)).toBe(false);
    });

    it('should return false for empty array', () => {
      expect(isString([])).toBe(false);
    });

    it('should return false for arrays', () => {
      expect(isString([1, 2, 3])).toBe(false);
      expect(isString(['hello', 'world'])).toBe(false);
    });

    it('should return false for empty object', () => {
      expect(isString({})).toBe(false);
    });

    it('should return false for objects', () => {
      expect(isString({ key: 'value' })).toBe(false);
      expect(isString({ toString: () => 'string' })).toBe(false);
    });

    it('should return false for functions', () => {
      expect(isString(() => {})).toBe(false);
      expect(isString(function () {})).toBe(false);
      expect(isString(() => 'string')).toBe(false);
    });

    it('should return false for Date objects', () => {
      expect(isString(new Date())).toBe(false);
    });

    it('should return false for RegExp objects', () => {
      expect(isString(/test/)).toBe(false);
      expect(isString(new RegExp('test'))).toBe(false);
    });

    it('should return false for Symbol', () => {
      expect(isString(Symbol('test'))).toBe(false);
      expect(isString(Symbol.for('test'))).toBe(false);
    });

    it('should return false for BigInt', () => {
      expect(isString(BigInt(123))).toBe(false);
      expect(isString(123n)).toBe(false);
    });

    it('should return false for Map', () => {
      expect(isString(new Map())).toBe(false);
      expect(isString(new Map([['key', 'value']]))).toBe(false);
    });

    it('should return false for Set', () => {
      expect(isString(new Set())).toBe(false);
      expect(isString(new Set([1, 2, 3]))).toBe(false);
    });

    it('should return false for WeakMap', () => {
      expect(isString(new WeakMap())).toBe(false);
    });

    it('should return false for WeakSet', () => {
      expect(isString(new WeakSet())).toBe(false);
    });

    it('should return false for Error objects', () => {
      expect(isString(new Error('test'))).toBe(false);
      expect(isString(new TypeError('test'))).toBe(false);
    });

    it('should return false for Promise', () => {
      expect(isString(Promise.resolve('test'))).toBe(false);
    });

    it('should return false for String constructor', () => {
      expect(isString(String)).toBe(false);
    });

    it('should return false for new String() object wrapper', () => {
      // Note: new String() creates an object, not a primitive string
      expect(isString(new String('hello'))).toBe(false);
      expect(isString(new String(''))).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle very long strings', () => {
      const longString = 'a'.repeat(10000);
      expect(isString(longString)).toBe(true);
    });

    it('should handle strings with escape sequences', () => {
      expect(isString('line1\\nline2')).toBe(true);
      expect(isString('tab\\tseparated')).toBe(true);
      expect(isString('quote\\"test')).toBe(true);
    });

    it('should work with variables', () => {
      const str = 'hello';
      const num = 42;
      const bool = true;

      expect(isString(str)).toBe(true);
      expect(isString(num)).toBe(false);
      expect(isString(bool)).toBe(false);
    });

    it('should work with function return values', () => {
      const returnString = () => 'hello';
      const returnNumber = () => 42;
      const returnBoolean = () => true;

      expect(isString(returnString())).toBe(true);
      expect(isString(returnNumber())).toBe(false);
      expect(isString(returnBoolean())).toBe(false);
    });

    it('should work with template literal expressions', () => {
      const name = 'World';
      expect(isString(`Hello ${name}`)).toBe(true);
      expect(isString(`${42}`)).toBe(true);
      expect(isString(`${true}`)).toBe(true);
    });

    it('should handle toString() results', () => {
      expect(isString((42).toString())).toBe(true);
      expect(isString(true.toString())).toBe(true);
      expect(isString([1, 2, 3].toString())).toBe(true);
    });

    it('should handle JSON.stringify results', () => {
      expect(isString(JSON.stringify({ key: 'value' }))).toBe(true);
      expect(isString(JSON.stringify([1, 2, 3]))).toBe(true);
      expect(isString(JSON.stringify('string'))).toBe(true);
    });

    it('should handle string coercion', () => {
      expect(isString(String(null))).toBe(true);
      expect(isString(String(undefined))).toBe(true);
      expect(isString(String(NaN))).toBe(true);
    });

    it('should handle array join results', () => {
      expect(isString([1, 2, 3].join(','))).toBe(true);
      expect(isString(['a', 'b', 'c'].join('-'))).toBe(true);
    });

    it('should handle string repeat', () => {
      expect(isString('abc'.repeat(3))).toBe(true);
      expect(isString('x'.repeat(0))).toBe(true);
    });

    it('should handle string replace', () => {
      expect(isString('hello world'.replace('world', 'there'))).toBe(true);
      expect(isString('test'.replace(/t/g, 'T'))).toBe(true);
    });

    it('should handle string split results', () => {
      const parts = 'a,b,c'.split(',');
      expect(isString(parts[0])).toBe(true);
      expect(isString(parts[1])).toBe(true);
    });

    it('should handle padded strings', () => {
      expect(isString('5'.padStart(3, '0'))).toBe(true);
      expect(isString('5'.padEnd(3, '0'))).toBe(true);
    });

    it('should handle trimmed strings', () => {
      expect(isString('  hello  '.trim())).toBe(true);
      expect(isString('  hello  '.trimStart())).toBe(true);
      expect(isString('  hello  '.trimEnd())).toBe(true);
    });
  });
});
