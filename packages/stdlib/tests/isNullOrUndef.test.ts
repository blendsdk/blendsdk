import { describe, expect, it } from 'vitest';
import { isNullOrUndef, isNullOrUndefDefault } from '../src/isNullOrUndef.js';

describe('isNullOrUndef', () => {
  describe('should return true for null/undefined values', () => {
    it('should return true for null', () => {
      expect(isNullOrUndef(null)).toBe(true);
    });

    it('should return true for undefined', () => {
      expect(isNullOrUndef(undefined)).toBe(true);
    });
  });

  describe('should return false for defined values', () => {
    it('should return false for empty string', () => {
      expect(isNullOrUndef('')).toBe(false);
    });

    it('should return false for zero', () => {
      expect(isNullOrUndef(0)).toBe(false);
    });

    it('should return false for false boolean', () => {
      expect(isNullOrUndef(false)).toBe(false);
    });

    it('should return false for empty array', () => {
      expect(isNullOrUndef([])).toBe(false);
    });

    it('should return false for empty object', () => {
      expect(isNullOrUndef({})).toBe(false);
    });

    it('should return false for string values', () => {
      expect(isNullOrUndef('test')).toBe(false);
      expect(isNullOrUndef('null')).toBe(false);
    });

    it('should return false for string "undefined" (it is a valid string, not undefined)', () => {
      // BREAKING CHANGE: "undefined" string is no longer treated as null/undefined.
      // The string "undefined" is a legitimate string value.
      expect(isNullOrUndef('undefined')).toBe(false);
    });

    it('should return false for number values', () => {
      expect(isNullOrUndef(42)).toBe(false);
      expect(isNullOrUndef(-1)).toBe(false);
      expect(isNullOrUndef(3.14)).toBe(false);
    });

    it('should return false for boolean true', () => {
      expect(isNullOrUndef(true)).toBe(false);
    });

    it('should return false for objects', () => {
      expect(isNullOrUndef({ key: 'value' })).toBe(false);
    });

    it('should return false for arrays', () => {
      expect(isNullOrUndef([1, 2, 3])).toBe(false);
    });

    it('should return false for functions', () => {
      expect(isNullOrUndef(() => {})).toBe(false);
    });

    it('should return false for NaN', () => {
      expect(isNullOrUndef(NaN)).toBe(false);
    });
  });
});

describe('isNullOrUndefDefault', () => {
  describe('should return default value for null/undefined', () => {
    it('should return default for null', () => {
      expect(isNullOrUndefDefault(null, 'default')).toBe('default');
    });

    it('should return default for undefined', () => {
      expect(isNullOrUndefDefault(undefined, 'default')).toBe('default');
    });
  });

  describe('should return original value when defined', () => {
    it('should return empty string instead of default', () => {
      expect(isNullOrUndefDefault('', 'default')).toBe('');
    });

    it('should return zero instead of default', () => {
      expect(isNullOrUndefDefault(0, 42)).toBe(0);
    });

    it('should return false instead of default', () => {
      expect(isNullOrUndefDefault(false, true)).toBe(false);
    });

    it('should return string value instead of default', () => {
      expect(isNullOrUndefDefault('test', 'default')).toBe('test');
    });

    it('should return string "undefined" instead of default (it is a valid string)', () => {
      // BREAKING CHANGE: "undefined" string is no longer treated as null/undefined.
      expect(isNullOrUndefDefault('undefined', 'default')).toBe('undefined');
    });

    it('should return number value instead of default', () => {
      expect(isNullOrUndefDefault(42, 0)).toBe(42);
    });

    it('should return boolean true instead of default', () => {
      expect(isNullOrUndefDefault(true, false)).toBe(true);
    });

    it('should return object instead of default', () => {
      const obj = { key: 'value' };
      const defaultObj = { key: 'default' };
      expect(isNullOrUndefDefault(obj, defaultObj)).toBe(obj);
    });

    it('should return array instead of default', () => {
      const arr = [1, 2, 3];
      const defaultArr: number[] = [];
      expect(isNullOrUndefDefault(arr, defaultArr)).toBe(arr);
    });

    it('should return empty array instead of default', () => {
      const arr: number[] = [];
      const defaultArr = [1, 2, 3];
      expect(isNullOrUndefDefault(arr, defaultArr)).toBe(arr);
    });

    it('should return empty object instead of default', () => {
      const obj = {};
      const defaultObj = { key: 'default' };
      expect(isNullOrUndefDefault(obj, defaultObj)).toBe(obj);
    });
  });

  describe('should work with different types', () => {
    it('should work with string type', () => {
      expect(isNullOrUndefDefault<string>(null as any, 'fallback')).toBe('fallback');
      expect(isNullOrUndefDefault<string>('value', 'fallback')).toBe('value');
    });

    it('should work with number type', () => {
      expect(isNullOrUndefDefault<number>(null as any, 100)).toBe(100);
      expect(isNullOrUndefDefault<number>(50, 100)).toBe(50);
    });

    it('should work with boolean type', () => {
      expect(isNullOrUndefDefault<boolean>(null as any, true)).toBe(true);
      expect(isNullOrUndefDefault<boolean>(false, true)).toBe(false);
    });

    it('should work with object type', () => {
      interface TestObj {
        id: number;
        name: string;
      }
      const defaultObj: TestObj = { id: 1, name: 'default' };
      const valueObj: TestObj = { id: 2, name: 'value' };

      expect(isNullOrUndefDefault<TestObj>(null as any, defaultObj)).toBe(defaultObj);
      expect(isNullOrUndefDefault<TestObj>(valueObj, defaultObj)).toBe(valueObj);
    });

    it('should work with array type', () => {
      expect(isNullOrUndefDefault<number[]>(null as any, [1, 2, 3])).toEqual([1, 2, 3]);
      expect(isNullOrUndefDefault<number[]>([4, 5, 6], [1, 2, 3])).toEqual([4, 5, 6]);
    });
  });
});
