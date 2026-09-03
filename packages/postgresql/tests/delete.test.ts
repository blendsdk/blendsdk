import { describe, expect, test } from 'vitest';
import { PostgreSQLDatabase } from '../src/database.js';
import { PostgreSQLDeleteStatement } from '../src/delete-statement.js';
import { connectionConfig } from './params.js';

interface TestUser {
  id?: number;
  name: string;
  email: string;
  age?: number;
  active?: boolean;
  created_at?: Date;
  updated_at?: Date;
  metadata?: Record<string, any>;
}

interface TestProduct {
  id?: number;
  name: string;
  price: number;
  category: string;
  in_stock?: boolean;
  created_at?: Date;
}

interface UserFilter {
  id?: number;
  email?: string;
  active?: boolean;
  age?: number;
}

interface ProductFilter {
  id?: number;
  category?: string;
  in_stock?: boolean;
}

describe('PostgreSQLDeleteStatement', () => {
  test('creates delete statement instance', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const deleteStatement = db.delete<UserFilter>('users');

    expect(deleteStatement).toBeInstanceOf(PostgreSQLDeleteStatement);
    expect(deleteStatement.constructor.name).toBe('PostgreSQLDeleteStatement');
  });

  test('builds correct query for single filter condition', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const deleteStatement = db.delete<UserFilter>('users');

    deleteStatement.filter({ id: 1 });

    // Access protected method for testing
    const query = (deleteStatement as any).buildQuery();
    const params = (deleteStatement as any).buildParameters();

    expect(query).toBe('DELETE FROM users WHERE id = :p1');
    expect(params).toEqual({ p1: 1 });
  });

  test('builds correct query for multiple filter conditions', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const deleteStatement = db.delete<UserFilter>('users');

    deleteStatement.filter({ active: false, age: 25 });

    const query = (deleteStatement as any).buildQuery();
    const params = (deleteStatement as any).buildParameters();

    expect(query).toBe('DELETE FROM users WHERE active = :p1 AND age = :p2');
    expect(params).toEqual({
      p1: false,
      p2: 25,
    });
  });

  test('builds query without filter conditions (bulk delete)', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const deleteStatement = db.delete<UserFilter>('users');

    deleteStatement.filter({});

    const query = (deleteStatement as any).buildQuery();
    const params = (deleteStatement as any).buildParameters();

    expect(query).toBe('DELETE FROM users');
    expect(params).toEqual({});
  });

  test('builds query with returning all fields', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const deleteStatement = db.delete<UserFilter>('users');

    deleteStatement.filter({ id: 1 }).returning('*');

    const query = (deleteStatement as any).buildQuery();

    expect(query).toBe('DELETE FROM users WHERE id = :p1 RETURNING *');
  });

  test('builds query with returning specific fields', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const deleteStatement = db.delete<UserFilter>('users');

    deleteStatement
      .filter({ active: false })
      .returning(['id', 'name', 'email'] as (keyof UserFilter)[]);

    const query = (deleteStatement as any).buildQuery();

    expect(query).toBe('DELETE FROM users WHERE active = :p1 RETURNING id, name, email');
  });

  test('allows chaining filter and returning methods', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const deleteStatement = db.delete<UserFilter>('users');

    const result = deleteStatement
      .filter({ email: 'test@example.com' })
      .returning(['id', 'name', 'email'] as any);

    expect(result).toBe(deleteStatement);
    expect((deleteStatement as any)._expressionBuilder).toBeDefined();
    expect((deleteStatement as any)._returning).toEqual(['id', 'name', 'email']);
  });

  test('handles complex data types in filter', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const deleteStatement = db.delete<UserFilter>('users');

    deleteStatement.filter({ id: 1, active: true });

    const params = (deleteStatement as any).buildParameters();

    expect(params).toEqual({
      p1: 1,
      p2: true,
    });
  });

  test('prevents parameter name conflicts with expression parameters', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const deleteStatement = db.delete<UserFilter>('users');

    deleteStatement.filter({ id: 123, active: false });

    const params = (deleteStatement as any).buildParameters();

    expect(params).toEqual({
      p1: 123,
      p2: false,
    });
  });
});

describe('Delete Statement Integration', () => {
  test('executes simple delete successfully', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          age INTEGER,
          active BOOLEAN DEFAULT true
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_users (name, email, age) VALUES (:name, :email, :age)',
        { name: 'Delete Test', email: 'delete@example.com', age: 25 }
      );

      // Execute delete
      await transactionDb
        .delete<UserFilter>('test_users')
        .filter({ email: 'delete@example.com' })
        .execute();

      // Verify deletion
      const result = await transactionDb.executeQuery<TestUser>(
        'SELECT * FROM test_users WHERE email = :email',
        { email: 'delete@example.com' }
      );

      return result;
    });

    expect(result.rowCount).toBe(0);
    expect(result.records).toEqual([]);

    await db.disconnect();
  });

  test('executes delete with multiple conditions', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          category VARCHAR(50) NOT NULL,
          in_stock BOOLEAN DEFAULT true
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_products (name, price, category, in_stock) VALUES (:name1, :price1, :category1, :in_stock1), (:name2, :price2, :category2, :in_stock2)',
        {
          name1: 'Product 1',
          price1: 29.99,
          category1: 'Electronics',
          in_stock1: false,
          name2: 'Product 2',
          price2: 39.99,
          category2: 'Electronics',
          in_stock2: true,
        }
      );

      // Execute delete with multiple filter conditions
      await transactionDb
        .delete<ProductFilter>('test_products')
        .filter({ category: 'Electronics', in_stock: false })
        .execute();

      // Verify only the matching record was deleted
      const result = await transactionDb.executeQuery<TestProduct>(
        'SELECT * FROM test_products WHERE category = :category',
        { category: 'Electronics' }
      );

      return result;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      name: 'Product 2',
      category: 'Electronics',
      in_stock: true,
    });

    await db.disconnect();
  });

  test('executes bulk delete without filter conditions', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_bulk_delete (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          active BOOLEAN DEFAULT true
        )
      `);

      // Insert multiple test records
      await transactionDb.executeQuery(
        'INSERT INTO test_bulk_delete (name) VALUES (:name1), (:name2), (:name3)',
        { name1: 'User 1', name2: 'User 2', name3: 'User 3' }
      );

      // Execute bulk delete without filter
      await transactionDb.delete<{}>('test_bulk_delete').filter({}).execute();

      // Verify all records were deleted
      const result = await transactionDb.executeQuery<{ count: string }>(
        'SELECT COUNT(*) as count FROM test_bulk_delete'
      );

      return result;
    });

    expect(result.rowCount).toBe(1);
    expect(parseInt(result.records[0].count)).toBe(0);

    await db.disconnect();
  });

  test('handles delete within transaction', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_transaction_delete (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          status VARCHAR(20) DEFAULT 'active'
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_transaction_delete (name, email) VALUES (:name1, :email1), (:name2, :email2)',
        {
          name1: 'User 1',
          email1: 'user1@example.com',
          name2: 'User 2',
          email2: 'user2@example.com',
        }
      );

      // Execute multiple deletes within transaction
      await transactionDb
        .delete<UserFilter>('test_transaction_delete')
        .filter({ email: 'user1@example.com' })
        .execute();

      // Verify remaining records
      const result = await transactionDb.executeQuery<TestUser>(
        'SELECT * FROM test_transaction_delete ORDER BY id'
      );

      return result;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      name: 'User 2',
      email: 'user2@example.com',
    });

    await db.disconnect();
  });

  test('handles delete with no matching rows', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_no_match_delete (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL
        )
      `);

      // Execute delete with non-existent filter
      const deleteResult = await transactionDb
        .delete<UserFilter>('test_no_match_delete')
        .filter({ email: 'nonexistent@example.com' })
        .execute();

      return deleteResult;
    });

    expect(result?.rowCount).toBe(0);

    await db.disconnect();
  });
});

describe('Delete Statement with RETURNING Integration', () => {
  test('executes delete with returning all fields', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_returning_delete (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          age INTEGER,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_returning_delete (name, email, age) VALUES (:name, :email, :age)',
        { name: 'Returning Test', email: 'returning@example.com', age: 25 }
      );

      // Execute delete with returning all fields using raw SQL
      const deleteResult = await transactionDb.executeQuery<TestUser>(
        `DELETE FROM test_returning_delete 
         WHERE email = :f_email 
         RETURNING *`,
        { f_email: 'returning@example.com' }
      );

      return deleteResult;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      name: 'Returning Test',
      email: 'returning@example.com',
      age: 25,
    });
    expect(result.records[0].id).toBeDefined();
    expect(result.records[0].created_at).toBeDefined();

    await db.disconnect();
  });

  test('executes delete with returning specific fields', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_returning_specific (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          age INTEGER,
          active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_returning_specific (name, email, age) VALUES (:name, :email, :age)',
        { name: 'Specific Return', email: 'specific@example.com', age: 30 }
      );

      // Execute delete with returning specific fields using raw SQL
      const deleteResult = await transactionDb.executeQuery<{
        id: number;
        name: string;
        age: number;
      }>(
        `DELETE FROM test_returning_specific 
         WHERE email = :f_email 
         RETURNING id, name, age`,
        { f_email: 'specific@example.com' }
      );

      return deleteResult;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toEqual({
      id: expect.any(Number),
      name: 'Specific Return',
      age: 30,
    });
    // Should not include email, active, or created_at since they weren't in returning clause
    expect(result.records[0]).not.toHaveProperty('email');
    expect(result.records[0]).not.toHaveProperty('active');
    expect(result.records[0]).not.toHaveProperty('created_at');

    await db.disconnect();
  });

  test('executes delete with returning computed fields', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_returning_computed (
          id SERIAL PRIMARY KEY,
          first_name VARCHAR(50) NOT NULL,
          last_name VARCHAR(50) NOT NULL,
          age INTEGER,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_returning_computed (first_name, last_name, age) VALUES (:first_name, :last_name, :age)',
        { first_name: 'John', last_name: 'Doe', age: 25 }
      );

      // Execute delete with returning computed field
      const deleteResult = await transactionDb.executeQuery<{
        id: number;
        full_name: string;
        age: number;
        created_at: Date;
      }>(
        `DELETE FROM test_returning_computed 
         WHERE first_name = :f_first_name AND last_name = :f_last_name 
         RETURNING id, first_name || ' ' || last_name as full_name, age, created_at`,
        { f_first_name: 'John', f_last_name: 'Doe' }
      );

      return deleteResult;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      id: expect.any(Number),
      full_name: 'John Doe',
      age: 25,
    });
    expect(result.records[0].created_at).toBeDefined();

    await db.disconnect();
  });

  test('executes delete with returning and complex data types', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_returning_complex (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          metadata JSONB,
          tags TEXT[],
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_returning_complex (name, metadata, tags) VALUES (:name, :metadata, :tags)',
        {
          name: 'Complex Delete Test',
          metadata: { version: 1, settings: { theme: 'light' } },
          tags: ['delete', 'test'],
        }
      );

      // Execute delete with returning all fields using raw SQL
      const deleteResult = await transactionDb.executeQuery<any>(
        `DELETE FROM test_returning_complex 
         WHERE name = :f_name 
         RETURNING *`,
        { f_name: 'Complex Delete Test' }
      );

      return deleteResult;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      id: expect.any(Number),
      name: 'Complex Delete Test',
      metadata: { version: 1, settings: { theme: 'light' } },
      tags: ['delete', 'test'],
    });
    expect(result.records[0].created_at).toBeDefined();

    await db.disconnect();
  });

  test('executes multiple deletes with returning within transaction', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_multiple_delete_returning (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          category VARCHAR(50) NOT NULL,
          status VARCHAR(20) DEFAULT 'active',
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_multiple_delete_returning (name, category) VALUES (:name1, :category1), (:name2, :category2)',
        {
          name1: 'First Item',
          category1: 'Category A',
          name2: 'Second Item',
          category2: 'Category B',
        }
      );

      // Execute multiple deletes with returning using raw SQL
      const delete1 = await transactionDb.executeQuery<{
        id: number;
        name: string;
        category: string;
      }>(
        `DELETE FROM test_multiple_delete_returning 
         WHERE category = :f_category 
         RETURNING id, name, category`,
        { f_category: 'Category A' }
      );

      const delete2 = await transactionDb.executeQuery<{
        id: number;
        name: string;
        category: string;
      }>(
        `DELETE FROM test_multiple_delete_returning 
         WHERE category = :f_category 
         RETURNING id, name, category`,
        { f_category: 'Category B' }
      );

      return { delete1, delete2 };
    });

    expect(result.delete1.rowCount).toBe(1);
    expect(result.delete1.records[0]).toEqual({
      id: expect.any(Number),
      name: 'First Item',
      category: 'Category A',
    });

    expect(result.delete2.rowCount).toBe(1);
    expect(result.delete2.records[0]).toEqual({
      id: expect.any(Number),
      name: 'Second Item',
      category: 'Category B',
    });

    // Verify IDs are different
    expect(result.delete1.records[0].id).not.toBe(result.delete2.records[0].id);

    await db.disconnect();
  });

  test('executes bulk delete with returning multiple rows', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_bulk_delete_returning (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          category VARCHAR(50) NOT NULL,
          active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_bulk_delete_returning (name, category) VALUES 
         ('Item 1', 'Electronics'), 
         ('Item 2', 'Electronics'), 
         ('Item 3', 'Books')`
      );

      // Execute bulk delete with returning using raw SQL
      const deleteResult = await transactionDb.executeQuery<{
        id: number;
        name: string;
        category: string;
      }>(
        `DELETE FROM test_bulk_delete_returning 
         WHERE category = :f_category 
         RETURNING id, name, category`,
        { f_category: 'Electronics' }
      );

      return deleteResult;
    });

    expect(result.rowCount).toBe(2); // Should delete 2 Electronics items
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      id: expect.any(Number),
      name: 'Item 1',
      category: 'Electronics',
    });
    expect(result.records[1]).toMatchObject({
      id: expect.any(Number),
      name: 'Item 2',
      category: 'Electronics',
    });

    await db.disconnect();
  });
});

describe('Delete Statement Execute Return Methods', () => {
  test('executeReturnSingle returns single deleted record', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_delete_return_single (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          age INTEGER,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_delete_return_single (name, email, age) VALUES (:name, :email, :age)',
        { name: 'Single Return Test', email: 'single@example.com', age: 25 }
      );

      // Execute delete with returning and get single record
      const deletedRecord = await transactionDb
        .delete<UserFilter>('test_delete_return_single')
        .filter({ email: 'single@example.com' })
        .returning('*')
        .executeReturnSingle();

      return deletedRecord;
    });

    expect(result).toMatchObject({
      name: 'Single Return Test',
      email: 'single@example.com',
      age: 25,
    });
    expect(result?.id).toBeDefined();
    expect((result as any)?.created_at).toBeDefined();

    await db.disconnect();
  });

  test('executeReturnAll returns all deleted records', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_delete_return_all (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          category VARCHAR(50) NOT NULL,
          active BOOLEAN DEFAULT true
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_delete_return_all (name, category) VALUES 
         ('Return All Test 1', 'Test Category'), 
         ('Return All Test 2', 'Test Category')`
      );

      // Delete multiple records and return all
      const deletedRecords = await transactionDb
        .delete<{ category: string }>('test_delete_return_all')
        .filter({ category: 'Test Category' })
        .returning('*')
        .executeReturnAll();

      return deletedRecords;
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      name: 'Return All Test 1',
      category: 'Test Category',
      active: true,
    });
    expect(result[1]).toMatchObject({
      name: 'Return All Test 2',
      category: 'Test Category',
      active: true,
    });
    expect((result[0] as any).id).toBeDefined();
    expect((result[1] as any).id).toBeDefined();

    await db.disconnect();
  });

  test('executeReturnCount returns number of deleted records', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_delete_return_count (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          category VARCHAR(50) NOT NULL,
          active BOOLEAN DEFAULT true
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_delete_return_count (name, category) VALUES 
         ('Count Test 1', 'Count Category'), 
         ('Count Test 2', 'Count Category'), 
         ('Count Test 3', 'Other Category')`
      );

      // Execute delete and get count
      const deleteCount = await transactionDb
        .delete<{ category: string }>('test_delete_return_count')
        .filter({ category: 'Count Category' })
        .executeReturnCount();

      return deleteCount;
    });

    expect(result).toBe(2); // Should delete 2 records with 'Count Category'

    await db.disconnect();
  });

  test('executeReturnSingle with specific returning fields', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_delete_return_single_fields (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          age INTEGER,
          active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_delete_return_single_fields (name, email, age) VALUES (:name, :email, :age)',
        { name: 'Specific Fields Test', email: 'specific@example.com', age: 25 }
      );

      // Execute delete with specific returning fields
      const deletedRecord = await transactionDb
        .delete<UserFilter>('test_delete_return_single_fields')
        .filter({ email: 'specific@example.com' })
        .returning(['id', 'name', 'email'] as (keyof UserFilter)[])
        .executeReturnSingle();

      return deletedRecord;
    });

    expect(result).toMatchObject({
      name: 'Specific Fields Test',
      email: 'specific@example.com',
    });
    expect(result?.id).toBeDefined();
    // Should not include age, active, or created_at since they weren't in returning clause
    expect(result).not.toHaveProperty('age');
    expect(result).not.toHaveProperty('active');
    expect(result).not.toHaveProperty('created_at');

    await db.disconnect();
  });

  test('executeReturnAll with complex data types', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_delete_return_all_complex (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          metadata JSONB,
          tags TEXT[],
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_delete_return_all_complex (name, metadata, tags) VALUES (:name, :metadata, :tags)',
        {
          name: 'Complex Return All Test',
          metadata: { settings: { theme: 'light' }, preferences: ['email'] },
          tags: ['test', 'delete'],
        }
      );

      // Execute delete with complex data types
      const deletedRecords = await transactionDb
        .delete<{ name: string }>('test_delete_return_all_complex')
        .filter({ name: 'Complex Return All Test' })
        .returning('*')
        .executeReturnAll();

      return deletedRecords;
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'Complex Return All Test',
      metadata: { settings: { theme: 'light' }, preferences: ['email'] },
      tags: ['test', 'delete'],
    });
    expect((result[0] as any).id).toBeDefined();
    expect((result[0] as any).created_at).toBeDefined();

    await db.disconnect();
  });

  test('executeReturnCount with multiple operations in transaction', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_delete_return_count_multiple (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status VARCHAR(20) DEFAULT 'active',
          category VARCHAR(50) NOT NULL
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_delete_return_count_multiple (name, category) VALUES 
         ('First Delete', 'Category A'), 
         ('Second Delete', 'Category A'), 
         ('Third Delete', 'Category B')`
      );

      // Execute multiple deletes and track counts
      const count1 = await transactionDb
        .delete<{ category: string }>('test_delete_return_count_multiple')
        .filter({ category: 'Category A' })
        .executeReturnCount();

      const count2 = await transactionDb
        .delete<{ name: string }>('test_delete_return_count_multiple')
        .filter({ name: 'Third Delete' })
        .executeReturnCount();

      // Verify total records remaining
      const totalResult = await transactionDb.executeQuery<{ count: string }>(
        'SELECT COUNT(*) as count FROM test_delete_return_count_multiple'
      );

      return { count1, count2, remainingCount: parseInt(totalResult.records[0].count) };
    });

    expect(result.count1).toBe(2); // Deleted 2 records in Category A
    expect(result.count2).toBe(1); // Deleted 1 record named 'Third Delete'
    expect(result.remainingCount).toBe(0); // No records should remain

    await db.disconnect();
  });
});

describe('Delete Statement Edge Cases and Error Handling', () => {
  test('handles empty filter object', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const deleteStatement = db.delete<UserFilter>('users');

    deleteStatement.filter({});

    const query = (deleteStatement as any).buildQuery();
    const params = (deleteStatement as any).buildParameters();

    expect(query).toBe('DELETE FROM users');
    expect(params).toEqual({});
  });

  test('handles null and undefined values in filter', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const deleteStatement = db.delete<UserFilter>('users');

    deleteStatement.filter({ id: null as any, active: undefined as any });

    const params = (deleteStatement as any).buildParameters();

    expect(params).toEqual({
      p1: null,
      p2: null,
    });
  });

  test('handles special characters in filter values', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const deleteStatement = db.delete<UserFilter>('users');

    deleteStatement.filter({ email: "test'quote@domain.com" });

    const params = (deleteStatement as any).buildParameters();

    expect(params).toEqual({
      p1: "test'quote@domain.com",
    });
  });

  test('handles large number of filter conditions', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const deleteStatement = db.delete<UserFilter>('users');

    const largeFilter = {
      id: 1,
      email: 'test@example.com',
      age: 25,
      active: true,
    };

    deleteStatement.filter(largeFilter);

    const query = (deleteStatement as any).buildQuery();

    expect(query).toBe(
      'DELETE FROM users WHERE id = :p1 AND email = :p2 AND age = :p3 AND active = :p4'
    );
  });

  test('executeReturnSingle returns null when no rows deleted', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_delete_no_match (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL
        )
      `);

      // Execute delete with non-existent filter
      const deletedRecord = await transactionDb
        .delete<UserFilter>('test_delete_no_match')
        .filter({ email: 'nonexistent@example.com' })
        .returning('*')
        .executeReturnSingle();

      return deletedRecord;
    });

    expect(result).toBeNull();

    await db.disconnect();
  });

  test('executeReturnAll returns empty array when no rows deleted', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_delete_no_match_all (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          category VARCHAR(50) NOT NULL
        )
      `);

      // Execute delete with non-existent filter
      const deletedRecords = await transactionDb
        .delete<{ category: string }>('test_delete_no_match_all')
        .filter({ category: 'NonExistent' })
        .returning('*')
        .executeReturnAll();

      return deletedRecords;
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);

    await db.disconnect();
  });

  test('executeReturnCount returns 0 when no rows deleted', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_delete_no_match_count (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status VARCHAR(20) DEFAULT 'active'
        )
      `);

      // Execute delete with non-existent filter
      const deleteCount = await transactionDb
        .delete<{ name: string }>('test_delete_no_match_count')
        .filter({ name: 'NonExistent' })
        .executeReturnCount();

      return deleteCount;
    });

    expect(result).toBe(0);

    await db.disconnect();
  });

  test('handles cascading deletes safely', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test tables with foreign key relationship
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_users_cascade (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL
        )
      `);

      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_posts_cascade (
          id SERIAL PRIMARY KEY,
          title VARCHAR(100) NOT NULL,
          user_id INTEGER REFERENCES test_users_cascade(id) ON DELETE CASCADE
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_users_cascade (name, email) VALUES (:name, :email)',
        { name: 'Cascade Test', email: 'cascade@example.com' }
      );

      const userResult = await transactionDb.executeQuery<{ id: number }>(
        'SELECT id FROM test_users_cascade WHERE email = :email',
        { email: 'cascade@example.com' }
      );

      const userId = userResult.records[0].id;

      await transactionDb.executeQuery(
        'INSERT INTO test_posts_cascade (title, user_id) VALUES (:title, :user_id)',
        { title: 'Test Post', user_id: userId }
      );

      // Execute delete on user (should cascade to posts)
      const deletedUser = await transactionDb
        .delete<UserFilter>('test_users_cascade')
        .filter({ email: 'cascade@example.com' })
        .returning('*')
        .executeReturnSingle();

      // Verify posts were also deleted due to cascade
      const postsResult = await transactionDb.executeQuery<{ count: string }>(
        'SELECT COUNT(*) as count FROM test_posts_cascade WHERE user_id = :user_id',
        { user_id: userId }
      );

      return { deletedUser, postsCount: parseInt(postsResult.records[0].count) };
    });

    expect(result.deletedUser).toMatchObject({
      name: 'Cascade Test',
      email: 'cascade@example.com',
    });
    expect(result.postsCount).toBe(0); // Posts should be deleted due to cascade

    await db.disconnect();
  });
});
