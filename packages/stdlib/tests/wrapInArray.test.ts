import { describe, expect, it } from 'vitest';
import { wrapInArray } from '../src/wrapInArray.js';

describe('wrapInArray', () => {
  describe('should return empty array for null/undefined', () => {
    it('should return empty array for null', () => {
      expect(wrapInArray(null)).toEqual([]);
    });

    it('should return empty array for undefined', () => {
      expect(wrapInArray(undefined)).toEqual([]);
    });
  });

  describe('should return array as-is when input is already an array', () => {
    it('should return empty array as-is', () => {
      const arr: number[] = [];
      expect(wrapInArray(arr)).toBe(arr);
    });

    it('should return number array as-is', () => {
      const arr = [1, 2, 3];
      expect(wrapInArray(arr)).toBe(arr);
    });

    it('should return string array as-is', () => {
      const arr = ['a', 'b', 'c'];
      expect(wrapInArray(arr)).toBe(arr);
    });

    it('should return object array as-is', () => {
      const arr = [{ id: 1 }, { id: 2 }];
      expect(wrapInArray(arr)).toBe(arr);
    });

    it('should return mixed type array as-is', () => {
      const arr = [1, 'two', { three: 3 }, null];
      expect(wrapInArray(arr)).toBe(arr);
    });

    it('should return nested array as-is', () => {
      const arr = [
        [1, 2],
        [3, 4],
      ];
      expect(wrapInArray(arr)).toBe(arr);
    });
  });

  describe('should wrap non-array values in an array', () => {
    it('should wrap string in array', () => {
      expect(wrapInArray('test')).toEqual(['test']);
    });

    it('should wrap empty string in array', () => {
      expect(wrapInArray('')).toEqual(['']);
    });

    it('should wrap string "undefined" in array (it is a valid string, not undefined)', () => {
      // BREAKING CHANGE: "undefined" string is no longer treated as null/undefined
      expect(wrapInArray('undefined')).toEqual(['undefined']);
    });

    it('should wrap number in array', () => {
      expect(wrapInArray(42)).toEqual([42]);
    });

    it('should wrap zero in array', () => {
      expect(wrapInArray(0)).toEqual([0]);
    });

    it('should wrap negative number in array', () => {
      expect(wrapInArray(-5)).toEqual([-5]);
    });

    it('should wrap boolean true in array', () => {
      expect(wrapInArray(true)).toEqual([true]);
    });

    it('should wrap boolean false in array', () => {
      expect(wrapInArray(false)).toEqual([false]);
    });

    it('should wrap object in array', () => {
      const obj = { key: 'value' };
      expect(wrapInArray(obj)).toEqual([obj]);
    });

    it('should wrap empty object in array', () => {
      const obj = {};
      expect(wrapInArray(obj)).toEqual([obj]);
    });

    it('should wrap function in array', () => {
      const fn = () => {};
      expect(wrapInArray(fn)).toEqual([fn]);
    });

    it('should wrap Date in array', () => {
      const date = new Date();
      expect(wrapInArray(date)).toEqual([date]);
    });

    it('should wrap RegExp in array', () => {
      const regex = /test/;
      expect(wrapInArray(regex)).toEqual([regex]);
    });

    it('should wrap NaN in array', () => {
      expect(wrapInArray(NaN)).toEqual([NaN]);
    });

    it('should wrap Symbol in array', () => {
      const sym = Symbol('test');
      expect(wrapInArray(sym)).toEqual([sym]);
    });
  });

  describe('should work with typed arrays', () => {
    it('should work with string type', () => {
      const result: string[] = wrapInArray<string>('test');
      expect(result).toEqual(['test']);
    });

    it('should work with number type', () => {
      const result: number[] = wrapInArray<number>(42);
      expect(result).toEqual([42]);
    });

    it('should work with boolean type', () => {
      const result: boolean[] = wrapInArray<boolean>(true);
      expect(result).toEqual([true]);
    });

    it('should work with object type', () => {
      interface TestObj {
        id: number;
        name: string;
      }
      const obj: TestObj = { id: 1, name: 'test' };
      const result: TestObj[] = wrapInArray<TestObj>(obj);
      expect(result).toEqual([obj]);
    });

    it('should return typed array as-is', () => {
      const arr: number[] = [1, 2, 3];
      const result: number[] = wrapInArray<number>(arr);
      expect(result).toBe(arr);
    });

    it('should return empty array for null with type', () => {
      const result: string[] = wrapInArray<string>(null);
      expect(result).toEqual([]);
    });
  });

  describe('edge cases', () => {
    it('should handle array-like objects by wrapping them', () => {
      const arrayLike = { 0: 'a', 1: 'b', length: 2 };
      expect(wrapInArray(arrayLike)).toEqual([arrayLike]);
    });

    it('should handle Set by wrapping it', () => {
      const set = new Set([1, 2, 3]);
      expect(wrapInArray(set)).toEqual([set]);
    });

    it('should handle Map by wrapping it', () => {
      const map = new Map([['key', 'value']]);
      expect(wrapInArray(map)).toEqual([map]);
    });

    it('should handle class instances by wrapping them', () => {
      class TestClass {
        value = 42;
      }
      const instance = new TestClass();
      expect(wrapInArray(instance)).toEqual([instance]);
    });
  });
});
