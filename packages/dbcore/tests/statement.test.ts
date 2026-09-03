import { describe, expect, test, vi } from 'vitest';
import { Database, DatabaseConfig, ExecuteQueryOptions, QueryResult } from '../src/database.js';
import { Statement } from '../src/statement.js';
import { DeleteStatement } from '../src/delete-statement.js';
import { FromStatement } from '../src/from-statement.js';
import { InsertStatement } from '../src/insert-statement.js';
import { UpdateStatement } from '../src/update-statement.js';

// --- Test helpers: Concrete implementations for abstract classes ---

/**
 * Concrete Statement subclass for unit testing the abstract Statement base class.
 * Provides simple implementations of the abstract buildQuery() and buildParameters() methods.
 */
class TestStatement<T = any> extends Statement<T> {
  protected queryStr: string = 'SELECT 1';
  protected params: any = {};

  /**
   * Sets the query string for testing.
   */
  setQuery(query: string): this {
    this.queryStr = query;
    return this;
  }

  /**
   * Sets the parameters for testing.
   */
  setParams(params: any): this {
    this.params = params;
    return this;
  }

  protected buildQuery(): string {
    return this.queryStr;
  }

  protected buildParameters(): any {
    return this.params;
  }
}

/**
 * Mock Database implementation for testing Statement without a real database.
 * Tracks calls to executeQuery for assertion purposes.
 */
class MockDatabase extends Database {
  /** Records of all executeQuery calls for verification */
  public executedQueries: Array<{ query: string; params?: any; options?: ExecuteQueryOptions }> = [];
  /** The result to return from executeQuery */
  public mockResult: QueryResult<any> = { records: [], rowCount: 0 };

  constructor() {
    super({ host: 'localhost', database: 'testdb' });
  }

  async connect(): Promise<any> {
    return {};
  }

  async disconnect(): Promise<void> {
    // no-op for testing
  }

  async executeQuery<R>(
    query: string,
    params?: Record<string, any>,
    options?: ExecuteQueryOptions
  ): Promise<QueryResult<R>> {
    this.executedQueries.push({ query, params, options });
    return this.mockResult as QueryResult<R>;
  }

  async withTransaction<T>(fn: (db: this) => Promise<T>): Promise<T> {
    return fn(this);
  }

  insert<T>(tableName: string): InsertStatement<T> {
    throw new Error('Not implemented in mock');
  }

  update<T, F>(tableName: string): UpdateStatement<T, F> {
    throw new Error('Not implemented in mock');
  }

  delete<F>(tableName: string): DeleteStatement<F> {
    throw new Error('Not implemented in mock');
  }
}

// --- Tests ---

describe('Statement', () => {
  describe('constructor', () => {
    test('should store the database reference', () => {
      const db = new MockDatabase();
      const stmt = new TestStatement(db);
      // Access the protected db field via any for testing
      expect((stmt as any).db).toBe(db);
    });

    test('should initialize beforeQuery handler to null', () => {
      const db = new MockDatabase();
      const stmt = new TestStatement(db);
      expect((stmt as any)._beforeQuery).toBeNull();
    });

    test('should initialize afterQuery handler to null', () => {
      const db = new MockDatabase();
      const stmt = new TestStatement(db);
      expect((stmt as any)._afterQuery).toBeNull();
    });
  });

  describe('execute()', () => {
    test('should call executeQuery with built query and parameters', async () => {
      const db = new MockDatabase();
      const stmt = new TestStatement(db);
      stmt.setQuery('SELECT * FROM users').setParams({ id: 1 });

      await stmt.execute();

      expect(db.executedQueries).toHaveLength(1);
      expect(db.executedQueries[0].query).toBe('SELECT * FROM users');
      expect(db.executedQueries[0].params).toEqual({ id: 1 });
    });

    test('should return the database result', async () => {
      const db = new MockDatabase();
      db.mockResult = { records: [{ id: 1, name: 'Alice' }], rowCount: 1 };

      const stmt = new TestStatement(db);
      const result = await stmt.execute();

      expect(result).toEqual({ records: [{ id: 1, name: 'Alice' }], rowCount: 1 });
    });

    test('should pass beforeQuery handler in options', async () => {
      const db = new MockDatabase();
      const handler = (params: any) => ({ ...params, extra: true });

      const stmt = new TestStatement(db);
      stmt.beforeQuery(handler);

      await stmt.execute();

      expect(db.executedQueries[0].options?.beforeQuery).toBe(handler);
    });

    test('should pass afterQuery handler (result rows transformer) in options', async () => {
      const db = new MockDatabase();
      const handler = (rows: any) => rows;

      const stmt = new TestStatement(db);
      stmt.afterQuery(handler);

      await stmt.execute();

      expect(db.executedQueries[0].options?.afterQuery).toBe(handler);
    });

    test('should pass both before and after handlers when both set', async () => {
      const db = new MockDatabase();
      const beforeHandler = (params: any) => params;
      const afterHandler = (rows: any) => rows;

      const stmt = new TestStatement(db);
      stmt.beforeQuery(beforeHandler).afterQuery(afterHandler);

      await stmt.execute();

      expect(db.executedQueries[0].options?.beforeQuery).toBe(beforeHandler);
      expect(db.executedQueries[0].options?.afterQuery).toBe(afterHandler);
    });

    test('should not pass handlers in options when none are set', async () => {
      const db = new MockDatabase();
      const stmt = new TestStatement(db);

      await stmt.execute();

      // Options should be an empty object (no beforeQuery/afterQuery)
      expect(db.executedQueries[0].options?.beforeQuery).toBeUndefined();
      expect(db.executedQueries[0].options?.afterQuery).toBeUndefined();
    });
  });

  describe('executeReturnSingle()', () => {
    test('should return the first record from the result', async () => {
      const db = new MockDatabase();
      db.mockResult = {
        records: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
        rowCount: 2,
      };

      const stmt = new TestStatement(db);
      const result = await stmt.executeReturnSingle();

      expect(result).toEqual({ id: 1, name: 'Alice' });
    });

    test('should return null when no records are returned', async () => {
      const db = new MockDatabase();
      db.mockResult = { records: [], rowCount: 0 };

      const stmt = new TestStatement(db);
      const result = await stmt.executeReturnSingle();

      expect(result).toBeNull();
    });

    test('should return null when execute returns null', async () => {
      const db = new MockDatabase();
      // Override executeQuery to return null
      db.executeQuery = async () => null as any;

      const stmt = new TestStatement(db);
      const result = await stmt.executeReturnSingle();

      expect(result).toBeNull();
    });
  });

  describe('executeReturnAll()', () => {
    test('should return all records from the result', async () => {
      const db = new MockDatabase();
      db.mockResult = {
        records: [{ id: 1 }, { id: 2 }, { id: 3 }],
        rowCount: 3,
      };

      const stmt = new TestStatement(db);
      const result = await stmt.executeReturnAll();

      expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
      expect(result).toHaveLength(3);
    });

    test('should return empty array when no records are returned', async () => {
      const db = new MockDatabase();
      db.mockResult = { records: [], rowCount: 0 };

      const stmt = new TestStatement(db);
      const result = await stmt.executeReturnAll();

      expect(result).toEqual([]);
    });

    test('should return empty array when execute returns null', async () => {
      const db = new MockDatabase();
      db.executeQuery = async () => null as any;

      const stmt = new TestStatement(db);
      const result = await stmt.executeReturnAll();

      expect(result).toEqual([]);
    });
  });

  describe('executeReturnCount()', () => {
    test('should return the row count from the result', async () => {
      const db = new MockDatabase();
      db.mockResult = { records: [{ id: 1 }], rowCount: 5 };

      const stmt = new TestStatement(db);
      const result = await stmt.executeReturnCount();

      expect(result).toBe(5);
    });

    test('should return 0 when no rows are affected', async () => {
      const db = new MockDatabase();
      db.mockResult = { records: [], rowCount: 0 };

      const stmt = new TestStatement(db);
      const result = await stmt.executeReturnCount();

      expect(result).toBe(0);
    });

    test('should return 0 when execute returns null', async () => {
      const db = new MockDatabase();
      db.executeQuery = async () => null as any;

      const stmt = new TestStatement(db);
      const result = await stmt.executeReturnCount();

      expect(result).toBe(0);
    });
  });

  describe('beforeQuery()', () => {
    test('should store the handler and return this for chaining', () => {
      const db = new MockDatabase();
      const stmt = new TestStatement(db);
      const handler = (params: any) => params;

      const result = stmt.beforeQuery(handler);

      expect(result).toBe(stmt);
      expect((stmt as any)._beforeQuery).toBe(handler);
    });
  });

  describe('afterQuery()', () => {
    test('should store the result rows handler and return this for chaining', () => {
      const db = new MockDatabase();
      const stmt = new TestStatement(db);
      const handler = (rows: any) => rows;

      const result = stmt.afterQuery(handler);

      expect(result).toBe(stmt);
      expect((stmt as any)._afterQuery).toBe(handler);
    });
  });

  describe('method chaining', () => {
    test('should support chaining beforeQuery and afterQuery', () => {
      const db = new MockDatabase();
      const stmt = new TestStatement(db);
      const before = (p: any) => p;
      const after = (p: any) => p;

      const result = stmt.beforeQuery(before).afterQuery(after);

      expect(result).toBe(stmt);
      expect((stmt as any)._beforeQuery).toBe(before);
      expect((stmt as any)._afterQuery).toBe(after);
    });
  });
});

describe('Database', () => {
  describe('from()', () => {
    test('should create a FromStatement for the given table', () => {
      const db = new MockDatabase();
      const stmt = db.from('users');

      expect(stmt).toBeInstanceOf(FromStatement);
    });

    test('should support generic type parameter', () => {
      const db = new MockDatabase();
      const stmt = db.from<{ id: number; name: string }>('users');

      expect(stmt).toBeInstanceOf(FromStatement);
    });
  });

  describe('selectAll()', () => {
    test('should return a FromStatement configured to select all columns', () => {
      const db = new MockDatabase();
      const stmt = db.selectAll('users');

      expect(stmt).toBeInstanceOf(FromStatement);
      // Verify the query is a SELECT * FROM table
      const query = (stmt as any).buildQuery();
      expect(query).toBe('SELECT * FROM users');
    });

    test('should support generic type parameter', () => {
      const db = new MockDatabase();
      const stmt = db.selectAll<{ id: number }>('products');

      const query = (stmt as any).buildQuery();
      expect(query).toBe('SELECT * FROM products');
    });
  });

  describe('constructor', () => {
    test('should store the database config', () => {
      const config: DatabaseConfig = {
        host: 'myhost',
        database: 'mydb',
        port: 5432,
        user: 'admin',
        pass: 'secret',
      };
      const db = new MockDatabase();
      // MockDatabase uses a hardcoded config, but we can verify the pattern
      expect((db as any).config).toBeDefined();
      expect((db as any).config.host).toBe('localhost');
    });
  });
});
