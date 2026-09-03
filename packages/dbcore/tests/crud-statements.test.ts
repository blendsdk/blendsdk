import { describe, expect, test } from 'vitest';
import { Database, ExecuteQueryOptions, QueryResult } from '../src/database.js';
import { CrudStatement } from '../src/crud-statement.js';
import { InsertStatement } from '../src/insert-statement.js';
import { UpdateStatement } from '../src/update-statement.js';
import { DeleteStatement } from '../src/delete-statement.js';
import { FilterableStatement } from '../src/filterable-statement.js';
import { FromStatement } from '../src/from-statement.js';

// --- Mock Database ---

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
    return new TestInsertStatement<T>(tableName, this);
  }

  update<T, F>(tableName: string): UpdateStatement<T, F> {
    return new TestUpdateStatement<T, F>(tableName, this);
  }

  delete<F>(tableName: string): DeleteStatement<F> {
    return new TestDeleteStatement<F>(tableName, this);
  }
}

// --- Concrete test implementations ---

/** Concrete InsertStatement for testing (simple SQL builder) */
class TestInsertStatement<T> extends InsertStatement<T> {
  protected buildQuery(): string {
    const keys = Object.keys(this._values);
    const cols = keys.join(', ');
    const vals = keys.map(k => `:${k}`).join(', ');
    const returning = this._returning.length ? ` RETURNING ${this._returning.join(', ')}` : '';
    return `INSERT INTO ${this.tableName} (${cols}) VALUES (${vals})${returning}`.trim();
  }

  protected buildParameters(): any {
    return this._values;
  }
}

/** Concrete UpdateStatement for testing */
class TestUpdateStatement<T, F> extends UpdateStatement<T, F> {
  protected buildQuery(): string {
    const setClauses = Object.keys(this._values).map(k => `${k} = :v_${k}`);
    let q = `UPDATE ${this.tableName} SET ${setClauses.join(', ')}`;
    // No WHERE clause in this simple test impl
    const returning = this._returning.length ? ` RETURNING ${this._returning.join(', ')}` : '';
    return `${q}${returning}`.trim();
  }

  protected buildParameters(): any {
    const params: Record<string, any> = {};
    Object.keys(this._values).forEach(k => {
      params[`v_${k}`] = (this._values as any)[k];
    });
    return params;
  }
}

/** Concrete DeleteStatement for testing */
class TestDeleteStatement<F> extends DeleteStatement<F> {
  protected buildQuery(): string {
    let q = `DELETE FROM ${this.tableName}`;
    const returning = this._returning.length ? ` RETURNING ${this._returning.join(', ')}` : '';
    return `${q}${returning}`.trim();
  }

  protected buildParameters(): any {
    return {};
  }
}

// --- Tests ---

describe('CrudStatement', () => {
  describe('returning()', () => {
    test('should set returning to all fields with *', () => {
      const db = new MockDatabase();
      const stmt = new TestInsertStatement('users', db);
      stmt.returning('*');

      expect((stmt as any)._returning).toEqual(['*']);
    });

    test('should set returning to specific fields', () => {
      const db = new MockDatabase();
      const stmt = new TestInsertStatement('users', db);
      stmt.returning(['id', 'name', 'email'] as any);

      expect((stmt as any)._returning).toEqual(['id', 'name', 'email']);
    });

    test('should return this for method chaining', () => {
      const db = new MockDatabase();
      const stmt = new TestInsertStatement('users', db);
      const result = stmt.returning('*');

      expect(result).toBe(stmt);
    });

    test('should initialize empty returning and values', () => {
      const db = new MockDatabase();
      const stmt = new TestInsertStatement('users', db);

      expect((stmt as any)._returning).toEqual([]);
      expect((stmt as any)._values).toEqual({});
    });
  });
});

describe('InsertStatement', () => {
  describe('values()', () => {
    test('should store the values', () => {
      const db = new MockDatabase();
      const stmt = db.insert<{ name: string; email: string }>('users');
      stmt.values({ name: 'Alice', email: 'alice@test.com' });

      expect((stmt as any)._values).toEqual({ name: 'Alice', email: 'alice@test.com' });
    });

    test('should return this for method chaining', () => {
      const db = new MockDatabase();
      const stmt = db.insert('users');
      const result = stmt.values({ name: 'test' });

      expect(result).toBe(stmt);
    });

    test('should accept partial values', () => {
      const db = new MockDatabase();
      const stmt = db.insert<{ name: string; email: string; age: number }>('users');
      stmt.values({ name: 'Bob' });

      expect((stmt as any)._values).toEqual({ name: 'Bob' });
    });
  });

  describe('query building', () => {
    test('should build INSERT query with single column', () => {
      const db = new MockDatabase();
      const stmt = db.insert('users');
      stmt.values({ name: 'Alice' });

      const query = (stmt as any).buildQuery();
      expect(query).toBe('INSERT INTO users (name) VALUES (:name)');
    });

    test('should build INSERT query with multiple columns', () => {
      const db = new MockDatabase();
      const stmt = db.insert('users');
      stmt.values({ name: 'Alice', email: 'alice@test.com' });

      const query = (stmt as any).buildQuery();
      expect(query).toBe('INSERT INTO users (name, email) VALUES (:name, :email)');
    });

    test('should build INSERT query with RETURNING *', () => {
      const db = new MockDatabase();
      const stmt = db.insert('users');
      stmt.values({ name: 'Alice' }).returning('*');

      const query = (stmt as any).buildQuery();
      expect(query).toBe('INSERT INTO users (name) VALUES (:name) RETURNING *');
    });

    test('should build INSERT query with specific RETURNING fields', () => {
      const db = new MockDatabase();
      const stmt = db.insert('users');
      stmt.values({ name: 'Alice', email: 'a@b.com' }).returning(['id', 'name'] as any);

      const query = (stmt as any).buildQuery();
      expect(query).toBe('INSERT INTO users (name, email) VALUES (:name, :email) RETURNING id, name');
    });
  });

  describe('method chaining', () => {
    test('should support fluent chaining of values and returning', () => {
      const db = new MockDatabase();
      const stmt = db.insert('users');

      const result = stmt.values({ name: 'Alice' }).returning('*');

      expect(result).toBe(stmt);
      expect((stmt as any)._values).toEqual({ name: 'Alice' });
      expect((stmt as any)._returning).toEqual(['*']);
    });
  });
});

describe('FilterableStatement', () => {
  describe('filter()', () => {
    test('should store expression builder for single filter', () => {
      const db = new MockDatabase();
      const stmt = db.update<{ name: string }, { id: number }>('users');
      stmt.filter({ id: 1 });

      expect((stmt as any)._expressionBuilder).toBeDefined();
      expect(typeof (stmt as any)._expressionBuilder).toBe('function');
    });

    test('should return this for method chaining', () => {
      const db = new MockDatabase();
      const stmt = db.update('users');
      const result = stmt.filter({ id: 1 });

      expect(result).toBe(stmt);
    });

    test('should merge multiple filter calls with AND logic', () => {
      const db = new MockDatabase();
      const stmt = db.update<{ name: string }, { id: number; active: boolean }>('users');
      stmt.filter({ id: 1 }).filter({ active: true });

      // Both filters should be combined
      expect((stmt as any)._expressionBuilder).toBeDefined();
    });

    test('should work on DeleteStatement as well', () => {
      const db = new MockDatabase();
      const stmt = db.delete<{ id: number }>('users');
      stmt.filter({ id: 123 });

      expect((stmt as any)._expressionBuilder).toBeDefined();
    });

    test('should handle empty filter object gracefully', () => {
      const db = new MockDatabase();
      const stmt = db.update('users');
      stmt.filter({});

      // Should have an expression builder, but it returns builder unchanged
      expect((stmt as any)._expressionBuilder).toBeDefined();
    });
  });

  describe('filterByExpression()', () => {
    test('should store expression builder function', () => {
      const db = new MockDatabase();
      const stmt = db.update('users');
      const builder = (q: any) => q.where('age').greaterThan(18);

      stmt.filterByExpression(builder);

      expect((stmt as any)._expressionBuilder).toBeDefined();
    });

    test('should return this for method chaining', () => {
      const db = new MockDatabase();
      const stmt = db.delete('users');
      const result = stmt.filterByExpression((q: any) => q);

      expect(result).toBe(stmt);
    });

    test('should merge with existing filter', () => {
      const db = new MockDatabase();
      const stmt = db.update('users');
      stmt.filter({ id: 1 }).filterByExpression((q: any) => q.where('age').greaterThan(18));

      expect((stmt as any)._expressionBuilder).toBeDefined();
    });
  });
});

describe('UpdateStatement', () => {
  describe('values()', () => {
    test('should store values to update', () => {
      const db = new MockDatabase();
      const stmt = db.update<{ name: string; age: number }, { id: number }>('users');
      stmt.values({ name: 'Updated', age: 30 });

      expect((stmt as any)._values).toEqual({ name: 'Updated', age: 30 });
    });

    test('should return this for method chaining', () => {
      const db = new MockDatabase();
      const stmt = db.update('users');
      const result = stmt.values({ name: 'test' });

      expect(result).toBe(stmt);
    });
  });

  describe('inheritance', () => {
    test('should extend FilterableStatement', () => {
      const db = new MockDatabase();
      const stmt = db.update('users');

      expect(stmt).toBeInstanceOf(FilterableStatement);
      expect(stmt).toBeInstanceOf(CrudStatement);
    });

    test('should have filter and filterByExpression methods', () => {
      const db = new MockDatabase();
      const stmt = db.update('users');

      expect(typeof stmt.filter).toBe('function');
      expect(typeof stmt.filterByExpression).toBe('function');
    });

    test('should have returning method from CrudStatement', () => {
      const db = new MockDatabase();
      const stmt = db.update('users');

      expect(typeof stmt.returning).toBe('function');
    });
  });

  describe('fluent API', () => {
    test('should support chaining values, filter, returning', () => {
      const db = new MockDatabase();
      const stmt = db.update<{ name: string }, { id: number }>('users');

      const result = stmt
        .values({ name: 'Updated' })
        .filter({ id: 1 })
        .returning('*');

      expect(result).toBe(stmt);
      expect((stmt as any)._values).toEqual({ name: 'Updated' });
      expect((stmt as any)._expressionBuilder).toBeDefined();
      expect((stmt as any)._returning).toEqual(['*']);
    });
  });
});

describe('DeleteStatement', () => {
  describe('inheritance', () => {
    test('should extend FilterableStatement', () => {
      const db = new MockDatabase();
      const stmt = db.delete('users');

      expect(stmt).toBeInstanceOf(FilterableStatement);
      expect(stmt).toBeInstanceOf(CrudStatement);
    });

    test('should have filter and filterByExpression methods', () => {
      const db = new MockDatabase();
      const stmt = db.delete('users');

      expect(typeof stmt.filter).toBe('function');
      expect(typeof stmt.filterByExpression).toBe('function');
    });

    test('should have returning method from CrudStatement', () => {
      const db = new MockDatabase();
      const stmt = db.delete('users');

      expect(typeof stmt.returning).toBe('function');
    });
  });

  describe('fluent API', () => {
    test('should support chaining filter and returning', () => {
      const db = new MockDatabase();
      const stmt = db.delete<{ id: number }>('users');

      const result = stmt
        .filter({ id: 1 })
        .returning('*');

      expect(result).toBe(stmt);
      expect((stmt as any)._expressionBuilder).toBeDefined();
      expect((stmt as any)._returning).toEqual(['*']);
    });
  });

  describe('query building', () => {
    test('should build DELETE query', () => {
      const db = new MockDatabase();
      const stmt = db.delete('users');

      const query = (stmt as any).buildQuery();
      expect(query).toBe('DELETE FROM users');
    });

    test('should build DELETE query with RETURNING', () => {
      const db = new MockDatabase();
      const stmt = db.delete('users');
      stmt.returning('*');

      const query = (stmt as any).buildQuery();
      expect(query).toBe('DELETE FROM users RETURNING *');
    });
  });
});

describe('FilterableStatement - getCompiledExpression()', () => {
  test('should return null when no expression builder is set', () => {
    const db = new MockDatabase();
    const stmt = db.update('users');

    // Access the protected method via any for testing
    const result = (stmt as any).getCompiledExpression();
    expect(result).toBeNull();
  });

  test('should return compiled expression when filter is set', () => {
    const db = new MockDatabase();
    const stmt = db.update<{ name: string }, { id: number }>('users');
    stmt.filter({ id: 42 });

    const compiled = (stmt as any).getCompiledExpression();
    expect(compiled).not.toBeNull();
    expect(compiled).toHaveProperty('sql');
    expect(compiled).toHaveProperty('params');
    expect(compiled.sql).toContain('id');
  });

  test('should cache the compiled expression on subsequent calls', () => {
    const db = new MockDatabase();
    const stmt = db.update<{ name: string }, { id: number }>('users');
    stmt.filter({ id: 99 });

    const first = (stmt as any).getCompiledExpression();
    const second = (stmt as any).getCompiledExpression();

    // Should return the exact same object reference (cached)
    expect(first).toBe(second);
  });

  test('should return compiled expression from filterByExpression', () => {
    const db = new MockDatabase();
    const stmt = db.delete<{ status: string }>('users');
    stmt.filterByExpression((q: any) => q.where('status').equals('inactive'));

    const compiled = (stmt as any).getCompiledExpression();
    expect(compiled).not.toBeNull();
    expect(compiled.sql).toContain('status');
  });

  test('should have _compiledExpression undefined before first call', () => {
    const db = new MockDatabase();
    const stmt = db.update('users');
    stmt.filter({ id: 1 });

    // Before calling getCompiledExpression, the cache should be undefined
    expect((stmt as any)._compiledExpression).toBeUndefined();

    // After calling, it should be populated
    (stmt as any).getCompiledExpression();
    expect((stmt as any)._compiledExpression).toBeDefined();
  });
});

describe('Database CRUD factory methods', () => {
  test('insert() should create an InsertStatement', () => {
    const db = new MockDatabase();
    const stmt = db.insert('users');

    expect(stmt).toBeInstanceOf(InsertStatement);
  });

  test('update() should create an UpdateStatement', () => {
    const db = new MockDatabase();
    const stmt = db.update('users');

    expect(stmt).toBeInstanceOf(UpdateStatement);
  });

  test('delete() should create a DeleteStatement', () => {
    const db = new MockDatabase();
    const stmt = db.delete('users');

    expect(stmt).toBeInstanceOf(DeleteStatement);
  });

  test('from() should create a FromStatement', () => {
    const db = new MockDatabase();
    const stmt = db.from('users');

    expect(stmt).toBeInstanceOf(FromStatement);
  });
});
