import { describe, expect, it } from 'vitest';
import { isBoolean } from '../src/isBoolean.js';

describe('isBoolean', () => {
  describe('should return true for boolean values', () => {
    it('should return true for boolean true', () => {
      expect(isBoolean(true)).toBe(true);
    });

    it('should return true for boolean false', () => {
      expect(isBoolean(false)).toBe(true);
    });

    it('should return true for Boolean object true', () => {
      expect(isBoolean(Boolean(true))).toBe(true);
    });

    it('should return true for Boolean object false', () => {
      expect(isBoolean(Boolean(false))).toBe(true);
    });

    it('should return true for boolean from comparison', () => {
      expect(isBoolean(1 === 1)).toBe(true);
      expect(isBoolean(1 !== 1)).toBe(true);
    });

    it('should return true for boolean from logical operations', () => {
      expect(isBoolean(true && false)).toBe(true);
      expect(isBoolean(true || false)).toBe(true);
      expect(isBoolean(!true)).toBe(true);
    });
  });

  describe('should return false for non-boolean values', () => {
    it('should return false for null', () => {
      expect(isBoolean(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isBoolean(undefined)).toBe(false);
    });

    it('should return false for string "true"', () => {
      expect(isBoolean('true')).toBe(false);
    });

    it('should return false for string "false"', () => {
      expect(isBoolean('false')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isBoolean('')).toBe(false);
    });

    it('should return false for string values', () => {
      expect(isBoolean('test')).toBe(false);
      expect(isBoolean('hello')).toBe(false);
    });

    it('should return false for number 0', () => {
      expect(isBoolean(0)).toBe(false);
    });

    it('should return false for number 1', () => {
      expect(isBoolean(1)).toBe(false);
    });

    it('should return false for positive numbers', () => {
      expect(isBoolean(42)).toBe(false);
      expect(isBoolean(3.14)).toBe(false);
    });

    it('should return false for negative numbers', () => {
      expect(isBoolean(-1)).toBe(false);
      expect(isBoolean(-42.5)).toBe(false);
    });

    it('should return false for NaN', () => {
      expect(isBoolean(NaN)).toBe(false);
    });

    it('should return false for Infinity', () => {
      expect(isBoolean(Infinity)).toBe(false);
      expect(isBoolean(-Infinity)).toBe(false);
    });

    it('should return false for empty array', () => {
      expect(isBoolean([])).toBe(false);
    });

    it('should return false for arrays', () => {
      expect(isBoolean([1, 2, 3])).toBe(false);
      expect(isBoolean([true, false])).toBe(false);
    });

    it('should return false for empty object', () => {
      expect(isBoolean({})).toBe(false);
    });

    it('should return false for objects', () => {
      expect(isBoolean({ key: 'value' })).toBe(false);
      expect(isBoolean({ bool: true })).toBe(false);
    });

    it('should return false for functions', () => {
      expect(isBoolean(() => {})).toBe(false);
      expect(isBoolean(function () {})).toBe(false);
      expect(isBoolean(() => true)).toBe(false);
    });

    it('should return false for Date objects', () => {
      expect(isBoolean(new Date())).toBe(false);
    });

    it('should return false for RegExp objects', () => {
      expect(isBoolean(/test/)).toBe(false);
    });

    it('should return false for Symbol', () => {
      expect(isBoolean(Symbol('test'))).toBe(false);
    });

    it('should return false for BigInt', () => {
      expect(isBoolean(BigInt(123))).toBe(false);
    });

    it('should return false for Boolean constructor (not instance)', () => {
      expect(isBoolean(Boolean)).toBe(false);
    });

    it('should return false for new Boolean() object wrapper', () => {
      // Note: new Boolean() creates an object, not a primitive boolean
      expect(isBoolean(new Boolean(true))).toBe(false);
      expect(isBoolean(new Boolean(false))).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle truthy values that are not booleans', () => {
      expect(isBoolean('non-empty string')).toBe(false);
      expect(isBoolean(1)).toBe(false);
      expect(isBoolean({})).toBe(false);
      expect(isBoolean([])).toBe(false);
    });

    it('should handle falsy values that are not booleans', () => {
      expect(isBoolean(0)).toBe(false);
      expect(isBoolean('')).toBe(false);
      expect(isBoolean(null)).toBe(false);
      expect(isBoolean(undefined)).toBe(false);
      expect(isBoolean(NaN)).toBe(false);
    });

    it('should work with variables', () => {
      const trueVar = true;
      const falseVar = false;
      const stringVar = 'true';
      const numberVar = 1;

      expect(isBoolean(trueVar)).toBe(true);
      expect(isBoolean(falseVar)).toBe(true);
      expect(isBoolean(stringVar)).toBe(false);
      expect(isBoolean(numberVar)).toBe(false);
    });

    it('should work with function return values', () => {
      const returnTrue = () => true;
      const returnFalse = () => false;
      const returnString = () => 'true';

      expect(isBoolean(returnTrue())).toBe(true);
      expect(isBoolean(returnFalse())).toBe(true);
      expect(isBoolean(returnString())).toBe(false);
    });
  });
});
