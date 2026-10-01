import { describe, expect, test } from 'vitest';
import { PostgreSQLInsertStatement } from '../src/insert-statement.js';
import { PostgreSQLUpdateStatement } from '../src/update-statement.js';
import { PostgreSQLDeleteStatement } from '../src/delete-statement.js';
import { PostgreSQLDatabase } from '../src/database.js';

/**
 * Unit tests for PostgreSQL statement builders — SQL generation only, no database required.
 * Tests the buildQuery() and buildParameters() methods directly via protected access.
 */

// Minimal mock config (no actual connection is made)
const mockConfig = { host: 'localhost', database: 'testdb', port: 5432, user: 'test', pass: 'test' };

/**
 * Helper: Creates a PostgreSQLInsertStatement and exposes query/params for testing.
 * Uses PostgreSQLDatabase constructor but never connects.
 */
function createInsertStatement<T>(tableName: string): PostgreSQLInsertStatement<T> {
  // Create database instance without connecting — statement builders don't need a connection
  const db = new PostgreSQLDatabase(mockConfig);
  return new PostgreSQLInsertStatement<T>(tableName, db);
}

function createUpdateStatement<T, F>(tableName: string): PostgreSQLUpdateStatement<T, F> {
  const db = new PostgreSQLDatabase(mockConfig);
  return new PostgreSQLUpdateStatement<T, F>(tableName, db);
}

function createDeleteStatement<F>(tableName: string): PostgreSQLDeleteStatement<F> {
  const db = new PostgreSQLDatabase(mockConfig);
  return new PostgreSQLDeleteStatement<F>(tableName, db);
}

// Helper to access protected methods
function getQuery(stmt: any): string {
  return stmt.buildQuery();
}

function getParams(stmt: any): Record<string, any> {
  return stmt.buildParameters();
}

describe('PostgreSQLInsertStatement', () => {
  describe('buildQuery()', () => {
    test('should build INSERT with single column', () => {
      const stmt = createInsertStatement<{ name: string }>('users');
      stmt.values({ name: 'Alice' });

      expect(getQuery(stmt)).toBe('INSERT INTO users (name) VALUES (:name)');
    });

    test('should build INSERT with multiple columns', () => {
      const stmt = createInsertStatement<{ name: string; email: string; age: number }>('users');
      stmt.values({ name: 'Alice', email: 'alice@test.com', age: 30 });

      const query = getQuery(stmt);
      expect(query).toBe('INSERT INTO users (name, email, age) VALUES (:name, :email, :age)');
    });

    test('should build INSERT with RETURNING *', () => {
      const stmt = createInsertStatement<{ name: string }>('users');
      stmt.values({ name: 'Alice' }).returning('*');

      expect(getQuery(stmt)).toBe('INSERT INTO users (name) VALUES (:name) RETURNING *');
    });

    test('should build INSERT with specific RETURNING columns', () => {
      const stmt = createInsertStatement<{ name: string; email: string }>('users');
      stmt.values({ name: 'Alice', email: 'a@b.com' }).returning(['id', 'created_at'] as any);

      expect(getQuery(stmt)).toBe(
        'INSERT INTO users (name, email) VALUES (:name, :email) RETURNING id, created_at'
      );
    });

    test('should throw error for empty values object', () => {
      const stmt = createInsertStatement<{}>('users');
      stmt.values({});

      expect(() => getQuery(stmt)).toThrow(
        'Cannot build INSERT statement for table "users": no values provided'
      );
    });

    test('should handle different table names', () => {
      const stmt1 = createInsertStatement<{ title: string }>('products');
      stmt1.values({ title: 'Widget' });
      expect(getQuery(stmt1)).toContain('INSERT INTO products');

      const stmt2 = createInsertStatement<{ amount: number }>('orders');
      stmt2.values({ amount: 100 });
      expect(getQuery(stmt2)).toContain('INSERT INTO orders');
    });
  });

  describe('buildParameters()', () => {
    test('should return values as parameters', () => {
      const stmt = createInsertStatement<{ name: string; email: string }>('users');
      stmt.values({ name: 'Alice', email: 'alice@test.com' });

      expect(getParams(stmt)).toEqual({ name: 'Alice', email: 'alice@test.com' });
    });

    test('should handle numeric values', () => {
      const stmt = createInsertStatement<{ price: number; quantity: number }>('products');
      stmt.values({ price: 9.99, quantity: 100 });

      expect(getParams(stmt)).toEqual({ price: 9.99, quantity: 100 });
    });

    test('should handle boolean values', () => {
      const stmt = createInsertStatement<{ active: boolean }>('users');
      stmt.values({ active: true });

      expect(getParams(stmt)).toEqual({ active: true });
    });

    test('should handle null values', () => {
      const stmt = createInsertStatement<{ notes: string | null }>('users');
      stmt.values({ notes: null } as any);

      expect(getParams(stmt)).toEqual({ notes: null });
    });
  });
});

describe('PostgreSQLUpdateStatement', () => {
  describe('buildQuery()', () => {
    test('should build UPDATE with SET clause', () => {
      const stmt = createUpdateStatement<{ name: string }, {}>('users');
      stmt.values({ name: 'Bob' });

      expect(getQuery(stmt)).toBe('UPDATE users SET name = :v_name');
    });

    test('should build UPDATE with multiple SET columns', () => {
      const stmt = createUpdateStatement<{ name: string; email: string }, {}>('users');
      stmt.values({ name: 'Bob', email: 'bob@test.com' });

      expect(getQuery(stmt)).toBe('UPDATE users SET name = :v_name, email = :v_email');
    });

    test('should build UPDATE with WHERE clause from filter', () => {
      const stmt = createUpdateStatement<{ name: string }, { id: number }>('users');
      stmt.values({ name: 'Updated' }).filter({ id: 1 });

      const query = getQuery(stmt);
      expect(query).toContain('UPDATE users SET name = :v_name');
      expect(query).toContain('WHERE');
      expect(query).toContain('id');
    });

    test('should build UPDATE with RETURNING', () => {
      const stmt = createUpdateStatement<{ name: string }, {}>('users');
      stmt.values({ name: 'Bob' }).returning('*');

      expect(getQuery(stmt)).toBe('UPDATE users SET name = :v_name RETURNING *');
    });

    test('should build UPDATE with filter and RETURNING', () => {
      const stmt = createUpdateStatement<{ name: string }, { id: number }>('users');
      stmt.values({ name: 'Updated' }).filter({ id: 1 }).returning('*');

      const query = getQuery(stmt);
      expect(query).toContain('UPDATE users SET name = :v_name');
      expect(query).toContain('WHERE');
      expect(query).toContain('RETURNING *');
    });

    test('should throw error for empty values object', () => {
      const stmt = createUpdateStatement<{}, {}>('users');
      stmt.values({});

      expect(() => getQuery(stmt)).toThrow(
        'Cannot build UPDATE statement for table "users": no values provided'
      );
    });

    test('should throw error for empty values object even with filter', () => {
      const stmt = createUpdateStatement<{}, { id: number }>('users');
      stmt.values({}).filter({ id: 1 });

      expect(() => getQuery(stmt)).toThrow(
        'Cannot build UPDATE statement for table "users": no values provided'
      );
    });

    test('should build UPDATE with filterByExpression', () => {
      const stmt = createUpdateStatement<{ status: string }, { age: number }>('users');
      stmt.values({ status: 'senior' }).filterByExpression(q => q.where('age').greaterThan(65));

      const query = getQuery(stmt);
      expect(query).toContain('UPDATE users SET status = :v_status');
      expect(query).toContain('WHERE');
    });
  });

  describe('buildParameters()', () => {
    test('should prefix value params with v_', () => {
      const stmt = createUpdateStatement<{ name: string; age: number }, {}>('users');
      stmt.values({ name: 'Bob', age: 25 });

      const params = getParams(stmt);
      expect(params.v_name).toBe('Bob');
      expect(params.v_age).toBe(25);
    });

    test('should include filter params alongside value params', () => {
      const stmt = createUpdateStatement<{ name: string }, { id: number }>('users');
      stmt.values({ name: 'Updated' }).filter({ id: 42 });

      const params = getParams(stmt);
      expect(params.v_name).toBe('Updated');
      // Filter params should also be present
      const allValues = Object.values(params);
      expect(allValues).toContain(42);
    });

    test('should not have naming conflicts between values and filter params', () => {
      const stmt = createUpdateStatement<{ name: string }, { name: string }>('users');
      stmt.values({ name: 'NewName' }).filter({ name: 'OldName' });

      const params = getParams(stmt);
      // Value param uses v_ prefix
      expect(params.v_name).toBe('NewName');
      // Filter param should be separate
      const allValues = Object.values(params);
      expect(allValues).toContain('OldName');
    });
  });

  describe('expression caching', () => {
    test('should cache compiled expression (no double compilation)', () => {
      const stmt = createUpdateStatement<{ name: string }, { id: number }>('users');
      stmt.values({ name: 'Test' }).filter({ id: 1 });

      // Call buildQuery and buildParameters — expression should compile once
      const query1 = getQuery(stmt);
      const params1 = getParams(stmt);
      const query2 = getQuery(stmt);
      const params2 = getParams(stmt);

      expect(query1).toBe(query2);
      expect(params1).toEqual(params2);
    });
  });
});

describe('PostgreSQLDeleteStatement', () => {
  describe('buildQuery()', () => {
    test('should build simple DELETE', () => {
      const stmt = createDeleteStatement<{}>('users');

      expect(getQuery(stmt)).toBe('DELETE FROM users');
    });

    test('should build DELETE with WHERE from filter', () => {
      const stmt = createDeleteStatement<{ id: number }>('users');
      stmt.filter({ id: 1 });

      const query = getQuery(stmt);
      expect(query).toContain('DELETE FROM users');
      expect(query).toContain('WHERE');
      expect(query).toContain('id');
    });

    test('should build DELETE with RETURNING', () => {
      const stmt = createDeleteStatement<{}>('users');
      stmt.returning('*');

      expect(getQuery(stmt)).toBe('DELETE FROM users RETURNING *');
    });

    test('should build DELETE with specific RETURNING columns', () => {
      const stmt = createDeleteStatement<{}>('users');
      stmt.returning(['id', 'name'] as any);

      expect(getQuery(stmt)).toBe('DELETE FROM users RETURNING id, name');
    });

    test('should build DELETE with filter and RETURNING', () => {
      const stmt = createDeleteStatement<{ id: number }>('orders');
      stmt.filter({ id: 99 }).returning('*');

      const query = getQuery(stmt);
      expect(query).toContain('DELETE FROM orders');
      expect(query).toContain('WHERE');
      expect(query).toContain('RETURNING *');
    });

    test('should build DELETE with filterByExpression', () => {
      const stmt = createDeleteStatement<{ status: string }>('sessions');
      stmt.filterByExpression(q => q.where('status').equals('expired'));

      const query = getQuery(stmt);
      expect(query).toContain('DELETE FROM sessions');
      expect(query).toContain('WHERE');
    });
  });

  describe('buildParameters()', () => {
    test('should return empty params without filter', () => {
      const stmt = createDeleteStatement<{}>('users');

      expect(getParams(stmt)).toEqual({});
    });

    test('should return filter params', () => {
      const stmt = createDeleteStatement<{ id: number }>('users');
      stmt.filter({ id: 42 });

      const params = getParams(stmt);
      const allValues = Object.values(params);
      expect(allValues).toContain(42);
    });

    test('should return expression params from filterByExpression', () => {
      const stmt = createDeleteStatement<{ status: string }>('sessions');
      stmt.filterByExpression(q => q.where('status').equals('expired'));

      const params = getParams(stmt);
      const allValues = Object.values(params);
      expect(allValues).toContain('expired');
    });
  });

  describe('expression caching', () => {
    test('should cache compiled expression (no double compilation)', () => {
      const stmt = createDeleteStatement<{ id: number }>('users');
      stmt.filter({ id: 1 });

      const query1 = getQuery(stmt);
      const params1 = getParams(stmt);
      const query2 = getQuery(stmt);

      expect(query1).toBe(query2);
    });
  });
});
