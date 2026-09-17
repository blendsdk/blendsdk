import { describe, expect, test } from 'vitest';
import * as dbcore from '../src/index.js';

describe('sanity', () => {
  test('sanity test', () => {
    expect(true).toBe(true);
  });
});

describe('exports', () => {
  test('should export CrudStatement', () => {
    expect(dbcore.CrudStatement).toBeDefined();
    expect(typeof dbcore.CrudStatement).toBe('function');
  });

  test('should export DataServiceBase', () => {
    expect(dbcore.DataServiceBase).toBeDefined();
    expect(typeof dbcore.DataServiceBase).toBe('function');
  });

  test('should export Database', () => {
    expect(dbcore.Database).toBeDefined();
  });

  test('should export Statement', () => {
    expect(dbcore.Statement).toBeDefined();
  });

  test('should export FilterableStatement', () => {
    expect(dbcore.FilterableStatement).toBeDefined();
  });

  test('should export InsertStatement', () => {
    expect(dbcore.InsertStatement).toBeDefined();
  });

  test('should export UpdateStatement', () => {
    expect(dbcore.UpdateStatement).toBeDefined();
  });

  test('should export DeleteStatement', () => {
    expect(dbcore.DeleteStatement).toBeDefined();
  });

  test('should export FromStatement', () => {
    expect(dbcore.FromStatement).toBeDefined();
  });

  test('should export QueryDataService', () => {
    expect(dbcore.QueryDataService).toBeDefined();
  });

  test('should export createQueryService factory', () => {
    expect(dbcore.createQueryService).toBeDefined();
    expect(typeof dbcore.createQueryService).toBe('function');
  });

  test('should export QueryResultHandler type (as runtime value check is not possible for types)', () => {
    // Type exports are verified at compile time via TypeScript type-checking.
    // Here we verify the module itself loaded without errors.
    expect(Object.keys(dbcore).length).toBeGreaterThan(0);
  });
});
