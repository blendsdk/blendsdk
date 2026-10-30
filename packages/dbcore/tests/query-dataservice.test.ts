import { describe, expect, test } from 'vitest';
import { Database, ExecuteQueryOptions, QueryResult } from '../src/database.js';
import { DataServiceBase } from '../src/dataservice-base.js';
import { QueryDataService, createQueryService } from '../src/query-dataservice.js';
import { DeleteStatement } from '../src/delete-statement.js';
import { FromStatement } from '../src/from-statement.js';
import { InsertStatement } from '../src/insert-statement.js';
import { UpdateStatement } from '../src/update-statement.js';

// --- Types ---

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

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
    throw new Error('Not implemented');
  }

  update<T, F>(tableName: string): UpdateStatement<T, F> {
    throw new Error('Not implemented');
  }

  delete<F>(tableName: string): DeleteStatement<F> {
    throw new Error('Not implemented');
  }
}

// --- Concrete QueryDataService for testing ---

class UserService extends QueryDataService<User> {
  constructor(db: Database) {
    super('users', 'id', db);
  }
}

// --- Tests ---

describe('DataServiceBase', () => {
  test('should store the database reference as protected', () => {
    const db = new MockDatabase();
    const service = new UserService(db);

    // Verify db is accessible from subclass (via any for testing)
    expect((service as any).db).toBe(db);
  });
});

describe('QueryDataService', () => {
  describe('constructor', () => {
    test('should store relation name', () => {
      const db = new MockDatabase();
      const service = new UserService(db);

      expect(service.relation).toBe('users');
    });

    test('should store id column name', () => {
      const db = new MockDatabase();
      const service = new UserService(db);

      expect(service.idColumn).toBe('id');
    });

    test('should extend DataServiceBase', () => {
      const db = new MockDatabase();
      const service = new UserService(db);

      expect(service).toBeInstanceOf(DataServiceBase);
    });
  });

  describe('findById()', () => {
    test('should execute a SELECT query filtered by id', async () => {
      const db = new MockDatabase();
      db.mockResult = { records: [{ id: 1, name: 'Alice', email: 'alice@test.com', active: true }], rowCount: 1 };

      const service = new UserService(db);
      const result = await service.findById(1);

      expect(result).toEqual({ id: 1, name: 'Alice', email: 'alice@test.com', active: true });
      expect(db.executedQueries).toHaveLength(1);
      expect(db.executedQueries[0].query).toContain('SELECT * FROM users');
      expect(db.executedQueries[0].query).toContain('WHERE');
    });

    test('should return null when record not found', async () => {
      const db = new MockDatabase();
      db.mockResult = { records: [], rowCount: 0 };

      const service = new UserService(db);
      const result = await service.findById(999);

      expect(result).toBeNull();
    });

    test('should pass the id value as a parameter', async () => {
      const db = new MockDatabase();
      db.mockResult = { records: [], rowCount: 0 };

      const service = new UserService(db);
      await service.findById(42);

      expect(db.executedQueries[0].params).toBeDefined();
      // The parameter value should contain 42
      const paramValues = Object.values(db.executedQueries[0].params || {});
      expect(paramValues).toContain(42);
    });

    test('should use the configured idColumn', async () => {
      const db = new MockDatabase();
      db.mockResult = { records: [], rowCount: 0 };

      // Custom id column name
      class ProductService extends QueryDataService<{ sku: string; name: string }> {
        constructor(db: Database) {
          super('products', 'sku', db);
        }
      }

      const service = new ProductService(db);
      await service.findById('ABC-123');

      expect(db.executedQueries[0].query).toContain('sku');
    });
  });

  describe('findByExpression()', () => {
    test('should execute a SELECT query with custom expression', async () => {
      const db = new MockDatabase();
      db.mockResult = { records: [{ id: 1, name: 'Alice' }], rowCount: 1 };

      const service = new UserService(db);
      const result = await service.findByExpression(q => {
        q.where('name').equals('Alice');
      });

      expect(result).toEqual({ id: 1, name: 'Alice' });
      expect(db.executedQueries[0].query).toContain('WHERE');
    });

    test('should return null when no matching record found', async () => {
      const db = new MockDatabase();
      db.mockResult = { records: [], rowCount: 0 };

      const service = new UserService(db);
      const result = await service.findByExpression(q => {
        q.where('email').equals('nonexistent@test.com');
      });

      expect(result).toBeNull();
    });

    test('should return the first record (single result)', async () => {
      const db = new MockDatabase();
      db.mockResult = {
        records: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
        rowCount: 2,
      };

      const service = new UserService(db);
      const result = await service.findByExpression(q => {
        q.where('active').equals(true);
      });

      expect(result).toEqual({ id: 1, name: 'Alice' });
    });
  });

  describe('findAllByExpression()', () => {
    test('should execute a SELECT query and return all matching records', async () => {
      const db = new MockDatabase();
      db.mockResult = {
        records: [
          { id: 1, name: 'Alice', active: true },
          { id: 3, name: 'Charlie', active: true },
        ],
        rowCount: 2,
      };

      const service = new UserService(db);
      const result = await service.findAllByExpression(q => {
        q.where('active').equals(true);
      });

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ id: 1, name: 'Alice', active: true });
      expect(result[1]).toEqual({ id: 3, name: 'Charlie', active: true });
    });

    test('should return empty array when no records match', async () => {
      const db = new MockDatabase();
      db.mockResult = { records: [], rowCount: 0 };

      const service = new UserService(db);
      const result = await service.findAllByExpression(q => {
        q.where('active').equals(false);
      });

      expect(result).toEqual([]);
    });
  });

  describe('findAll()', () => {
    test('should execute a SELECT * query without filters', async () => {
      const db = new MockDatabase();
      db.mockResult = {
        records: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
          { id: 3, name: 'Charlie' },
        ],
        rowCount: 3,
      };

      const service = new UserService(db);
      const result = await service.findAll();

      expect(result).toHaveLength(3);
      expect(db.executedQueries[0].query).toBe('SELECT * FROM users');
    });

    test('should return empty array when table is empty', async () => {
      const db = new MockDatabase();
      db.mockResult = { records: [], rowCount: 0 };

      const service = new UserService(db);
      const result = await service.findAll();

      expect(result).toEqual([]);
    });
  });
});

describe('createQueryService()', () => {
  test('should create a concrete QueryDataService class', () => {
    const UserServiceClass = createQueryService<User>('users', 'id');
    const db = new MockDatabase();
    const service = new UserServiceClass(db);

    expect(service).toBeInstanceOf(QueryDataService);
    expect(service.relation).toBe('users');
    expect(service.idColumn).toBe('id');
  });

  test('should support different relation names', () => {
    const ProductServiceClass = createQueryService<{ sku: string; name: string }>('products', 'sku');
    const db = new MockDatabase();
    const service = new ProductServiceClass(db);

    expect(service.relation).toBe('products');
    expect(service.idColumn).toBe('sku');
  });

  test('should create functional services with findAll', async () => {
    const UserServiceClass = createQueryService<User>('users', 'id');
    const db = new MockDatabase();
    db.mockResult = { records: [{ id: 1, name: 'Alice' }], rowCount: 1 };

    const service = new UserServiceClass(db);
    const result = await service.findAll();

    expect(result).toHaveLength(1);
    expect(db.executedQueries[0].query).toBe('SELECT * FROM users');
  });

  test('should create functional services with findById', async () => {
    const UserServiceClass = createQueryService<User>('users', 'id');
    const db = new MockDatabase();
    db.mockResult = { records: [{ id: 5, name: 'Eve' }], rowCount: 1 };

    const service = new UserServiceClass(db);
    const result = await service.findById(5);

    expect(result).toEqual({ id: 5, name: 'Eve' });
  });

  test('should allow multiple independent services from the same factory', () => {
    const UserServiceClass = createQueryService<User>('users', 'id');
    const db = new MockDatabase();

    const service1 = new UserServiceClass(db);
    const service2 = new UserServiceClass(db);

    expect(service1).not.toBe(service2);
    expect(service1.relation).toBe('users');
    expect(service2.relation).toBe('users');
  });
});
