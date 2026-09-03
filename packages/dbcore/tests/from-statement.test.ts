import { describe, expect, test } from 'vitest';
import { Database, DatabaseConfig, ExecuteQueryOptions, QueryResult } from '../src/database.js';
import { FromStatement } from '../src/from-statement.js';
import { DeleteStatement } from '../src/delete-statement.js';
import { InsertStatement } from '../src/insert-statement.js';
import { UpdateStatement } from '../src/update-statement.js';
import type { CompileResult } from '@blendsdk/expression';

/**
 * Mock Database for FromStatement unit tests.
 */
class MockDatabase extends Database {
  public executedQueries: Array<{ query: string; params?: any }> = [];
  public mockResult: QueryResult<any> = { records: [], rowCount: 0 };

  constructor() {
    super({ host: 'localhost', database: 'testdb' });
  }

  async connect(): Promise<any> {
    return {};
  }

  async disconnect(): Promise<void> {}

  async executeQuery<R>(
    query: string,
    params?: Record<string, any>,
    options?: ExecuteQueryOptions
  ): Promise<QueryResult<R>> {
    this.executedQueries.push({ query, params });
    return this.mockResult as QueryResult<R>;
  }

  async withTransaction<T>(fn: (db: this) => Promise<T>): Promise<T> {
    return fn(this);
  }

  insert<T>(tableName: string): InsertStatement<T> {
    throw new Error('Not implemented');
  }

  update<T, F>(tableName: string): UpdateStatement<T, F> {
    throw new Error('Not implemented');
  }

  delete<F>(tableName: string): DeleteStatement<F> {
    throw new Error('Not implemented');
  }
}

describe('FromStatement', () => {
  describe('constructor', () => {
    test('should store the table name', () => {
      const db = new MockDatabase();
      const stmt = new FromStatement('users', db);

      expect((stmt as any).tableName).toBe('users');
    });

    test('should initialize empty select columns', () => {
      const db = new MockDatabase();
      const stmt = new FromStatement('users', db);

      expect((stmt as any)._selectColumns).toEqual([]);
    });

    test('should initialize empty parameters', () => {
      const db = new MockDatabase();
      const stmt = new FromStatement('users', db);

      expect((stmt as any)._parameters).toEqual({});
    });

    test('should initialize empty WHERE clause', () => {
      const db = new MockDatabase();
      const stmt = new FromStatement('users', db);

      expect((stmt as any)._whereClause).toBe('');
    });
  });

  describe('select()', () => {
    test('should default to SELECT * when no columns specified', () => {
      const db = new MockDatabase();
      const stmt = new FromStatement('users', db);
      stmt.select();

      const query = (stmt as any).buildQuery();
      expect(query).toBe('SELECT * FROM users');
    });

    test('should accept an array of column names', () => {
      const db = new MockDatabase();
      const stmt = new FromStatement('users', db);
      stmt.select(['id', 'name', 'email']);

      const query = (stmt as any).buildQuery();
      expect(query).toBe('SELECT id, name, email FROM users');
    });

    test('should accept an object for aliased columns', () => {
      const db = new MockDatabase();
      const stmt = new FromStatement('users', db);
      stmt.select({ fullName: "first_name || ' ' || last_name", total: 'price * quantity' });

      const query = (stmt as any).buildQuery();
      expect(query).toContain("first_name || ' ' || last_name AS fullName");
      expect(query).toContain('price * quantity AS total');
    });

    test('should return this for method chaining', () => {
      const db = new MockDatabase();
      const stmt = new FromStatement('users', db);

      const result = stmt.select(['id']);
      expect(result).toBe(stmt);
    });

    test('should handle single column array', () => {
      const db = new MockDatabase();
      const stmt = new FromStatement('users', db);
      stmt.select(['id']);

      const query = (stmt as any).buildQuery();
      expect(query).toBe('SELECT id FROM users');
    });
  });

  describe('byExpression()', () => {
    test('should set WHERE clause from compiled expression', () => {
      const db = new MockDatabase();
      const stmt = new FromStatement('users', db);
      const filter: CompileResult = {
        sql: 'age > :p1',
        params: { p1: 18 },
      };

      stmt.select().byExpression(filter);

      const query = (stmt as any).buildQuery();
      expect(query).toBe('SELECT * FROM users WHERE age > :p1');
    });

    test('should set parameters from compiled expression', () => {
      const db = new MockDatabase();
      const stmt = new FromStatement('users', db);
      const filter: CompileResult = {
        sql: 'status = :p1 AND age > :p2',
        params: { p1: 'active', p2: 18 },
      };

      stmt.select().byExpression(filter);

      const params = (stmt as any).buildParameters();
      expect(params).toEqual({ p1: 'active', p2: 18 });
    });

    test('should return this for method chaining', () => {
      const db = new MockDatabase();
      const stmt = new FromStatement('users', db);
      const filter: CompileResult = { sql: 'id = :p1', params: { p1: 1 } };

      const result = stmt.select().byExpression(filter);
      expect(result).toBe(stmt);
    });
  });

  describe('buildQuery()', () => {
    test('should build SELECT * FROM table without WHERE', () => {
      const db = new MockDatabase();
      const stmt = new FromStatement('products', db);
      stmt.select();

      const query = (stmt as any).buildQuery();
      expect(query).toBe('SELECT * FROM products');
    });

    test('should build SELECT with specific columns', () => {
      const db = new MockDatabase();
      const stmt = new FromStatement('orders', db);
      stmt.select(['id', 'total', 'status']);

      const query = (stmt as any).buildQuery();
      expect(query).toBe('SELECT id, total, status FROM orders');
    });

    test('should build SELECT with WHERE clause', () => {
      const db = new MockDatabase();
      const stmt = new FromStatement('users', db);
      const filter: CompileResult = { sql: 'active = :p1', params: { p1: true } };
      stmt.select(['id', 'name']).byExpression(filter);

      const query = (stmt as any).buildQuery();
      expect(query).toBe('SELECT id, name FROM users WHERE active = :p1');
    });

    test('should handle different table names', () => {
      const db = new MockDatabase();

      const stmt1 = new FromStatement('users', db).select();
      const stmt2 = new FromStatement('products', db).select();
      const stmt3 = new FromStatement('orders', db).select();

      expect((stmt1 as any).buildQuery()).toBe('SELECT * FROM users');
      expect((stmt2 as any).buildQuery()).toBe('SELECT * FROM products');
      expect((stmt3 as any).buildQuery()).toBe('SELECT * FROM orders');
    });
  });

  describe('buildParameters()', () => {
    test('should return empty object when no filter is set', () => {
      const db = new MockDatabase();
      const stmt = new FromStatement('users', db);
      stmt.select();

      const params = (stmt as any).buildParameters();
      expect(params).toEqual({});
    });

    test('should return expression parameters when filter is set', () => {
      const db = new MockDatabase();
      const stmt = new FromStatement('users', db);
      const filter: CompileResult = {
        sql: 'name = :p1 AND age = :p2',
        params: { p1: 'Alice', p2: 30 },
      };
      stmt.select().byExpression(filter);

      const params = (stmt as any).buildParameters();
      expect(params).toEqual({ p1: 'Alice', p2: 30 });
    });
  });

  describe('execute integration with MockDatabase', () => {
    test('should execute SELECT * query through database', async () => {
      const db = new MockDatabase();
      db.mockResult = {
        records: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
        rowCount: 2,
      };

      const result = await db.from('users').select().executeReturnAll();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ id: 1, name: 'Alice' });
      expect(db.executedQueries[0].query).toBe('SELECT * FROM users');
    });

    test('should execute query with specific columns', async () => {
      const db = new MockDatabase();
      db.mockResult = { records: [{ id: 1 }], rowCount: 1 };

      await db.from('users').select(['id', 'name']).executeReturnSingle();

      expect(db.executedQueries[0].query).toBe('SELECT id, name FROM users');
    });

    test('should execute query with WHERE clause and parameters', async () => {
      const db = new MockDatabase();
      db.mockResult = { records: [{ id: 1, name: 'Alice' }], rowCount: 1 };
      const filter: CompileResult = { sql: 'id = :p1', params: { p1: 1 } };

      await db.from('users').select().byExpression(filter).executeReturnSingle();

      expect(db.executedQueries[0].query).toBe('SELECT * FROM users WHERE id = :p1');
      expect(db.executedQueries[0].params).toEqual({ p1: 1 });
    });

    test('should return count from executeReturnCount', async () => {
      const db = new MockDatabase();
      db.mockResult = { records: [], rowCount: 42 };

      const count = await db.from('users').select().executeReturnCount();

      expect(count).toBe(42);
    });
  });
});
