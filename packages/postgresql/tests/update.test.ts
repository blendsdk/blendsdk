import { describe, expect, test } from 'vitest';
import { PostgreSQLDatabase } from '../src/database.js';
import { PostgreSQLUpdateStatement } from '../src/update-statement.js';
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
  updated_at?: Date;
}

interface UserFilter {
  id?: number;
  email?: string;
  active?: boolean;
}

interface ProductFilter {
  id?: number;
  category?: string;
  in_stock?: boolean;
}

describe('PostgreSQLUpdateStatement', () => {
  test('creates update statement instance', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const updateStatement = db.update<TestUser, UserFilter>('users');

    expect(updateStatement).toBeInstanceOf(PostgreSQLUpdateStatement);
    expect(updateStatement.constructor.name).toBe('PostgreSQLUpdateStatement');
  });

  test('builds correct query for single column update', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const updateStatement = db.update<TestUser, UserFilter>('users');

    updateStatement.values({ name: 'Updated Name' }).filter({ id: 1 });

    // Access protected method for testing
    const query = (updateStatement as any).buildQuery();
    const params = (updateStatement as any).buildParameters();

    expect(query).toBe('UPDATE users SET name = :v_name WHERE id = :p1');
    expect(params).toEqual({ v_name: 'Updated Name', p1: 1 });
  });

  test('builds correct query for multiple columns update', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const updateStatement = db.update<TestUser, UserFilter>('users');

    const updateData = {
      name: 'Jane Smith Updated',
      age: 31,
      active: false,
    };

    updateStatement.values(updateData).filter({ email: 'jane@example.com' });

    const query = (updateStatement as any).buildQuery();
    const params = (updateStatement as any).buildParameters();

    expect(query).toBe(
      'UPDATE users SET name = :v_name, age = :v_age, active = :v_active WHERE email = :p1'
    );
    expect(params).toEqual({
      v_name: 'Jane Smith Updated',
      v_age: 31,
      v_active: false,
      p1: 'jane@example.com',
    });
  });

  test('builds query with multiple filter conditions', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const updateStatement = db.update<TestUser, UserFilter>('users');

    updateStatement.values({ name: 'Multi Filter Update' }).filter({ active: true, id: 5 });

    const query = (updateStatement as any).buildQuery();
    const params = (updateStatement as any).buildParameters();

    expect(query).toBe('UPDATE users SET name = :v_name WHERE active = :p1 AND id = :p2');
    expect(params).toEqual({
      v_name: 'Multi Filter Update',
      p1: true,
      p2: 5,
    });
  });

  test('builds query without filter conditions', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const updateStatement = db.update<TestUser, UserFilter>('users');

    updateStatement.values({ active: false });

    const query = (updateStatement as any).buildQuery();
    const params = (updateStatement as any).buildParameters();

    expect(query).toBe('UPDATE users SET active = :v_active');
    expect(params).toEqual({ v_active: false });
  });

  test('builds query with returning all fields', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const updateStatement = db.update<TestUser, UserFilter>('users');

    updateStatement.values({ name: 'Return Test', age: 25 }).filter({ id: 1 }).returning('*');

    const query = (updateStatement as any).buildQuery();

    expect(query).toBe('UPDATE users SET name = :v_name, age = :v_age WHERE id = :p1 RETURNING *');
  });

  test('builds query with returning specific fields', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const updateStatement = db.update<TestUser, UserFilter>('users');

    updateStatement
      .values({ name: 'Return Test', email: 'return@example.com', age: 30 })
      .filter({ id: 1 })
      .returning(['id', 'name', 'email', 'updated_at'] as (keyof TestUser)[]);

    const query = (updateStatement as any).buildQuery();

    expect(query).toBe(
      'UPDATE users SET name = :v_name, email = :v_email, age = :v_age WHERE id = :p1 RETURNING id, name, email, updated_at'
    );
  });

  test('allows chaining values, filter, and returning methods', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const updateStatement = db.update<TestUser, UserFilter>('users');

    const result = updateStatement
      .values({ name: 'Chained Update', active: true })
      .filter({ email: 'chain@example.com' })
      .returning(['id', 'name', 'email', 'updated_at']);

    expect(result).toBe(updateStatement);
    expect((updateStatement as any)._values).toEqual({
      name: 'Chained Update',
      active: true,
    });
    expect((updateStatement as any)._expressionBuilder).toBeDefined();
    expect((updateStatement as any)._returning).toEqual(['id', 'name', 'email', 'updated_at']);
  });

  test('handles complex data types in values', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const updateStatement = db.update<TestUser, UserFilter>('users');

    const complexData = {
      name: 'Complex Update',
      metadata: { settings: { theme: 'dark' }, version: 2 },
    };

    updateStatement.values(complexData).filter({ id: 1 });

    const params = (updateStatement as any).buildParameters();

    expect(params).toEqual({
      v_name: 'Complex Update',
      v_metadata: { settings: { theme: 'dark' }, version: 2 },
      p1: 1,
    });
  });

  test('prevents parameter name conflicts with v_ prefix and expression parameters', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const updateStatement = db.update<TestUser, UserFilter>('users');

    // Test case where both values and filter have same property name
    updateStatement.values({ active: true }).filter({ active: false });

    const params = (updateStatement as any).buildParameters();

    expect(params).toEqual({
      v_active: true, // from values with v_ prefix
      p1: false, // from filter with expression parameter
    });
  });
});

describe('Update Statement Integration', () => {
  test('executes simple update successfully', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          age INTEGER,
          active BOOLEAN DEFAULT true,
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_users (name, email, age) VALUES (:name, :email, :age)',
        { name: 'Original Name', email: 'update@example.com', age: 25 }
      );

      // Execute update
      await transactionDb
        .update<TestUser, UserFilter>('test_users')
        .values({ name: 'Updated Name', age: 26 })
        .filter({ email: 'update@example.com' })
        .execute();

      // Verify update
      const result = await transactionDb.executeQuery<TestUser>(
        'SELECT * FROM test_users WHERE email = :email',
        { email: 'update@example.com' }
      );

      return result;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      name: 'Updated Name',
      email: 'update@example.com',
      age: 26,
    });

    await db.disconnect();
  });

  test('executes update with multiple conditions', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          category VARCHAR(50) NOT NULL,
          in_stock BOOLEAN DEFAULT true,
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_products (name, price, category, in_stock) VALUES (:name, :price, :category, :in_stock)',
        { name: 'Test Product', price: 29.99, category: 'Electronics', in_stock: true }
      );

      // Execute update with multiple filter conditions
      await transactionDb
        .update<TestProduct, ProductFilter>('test_products')
        .values({ price: 24.99, in_stock: false })
        .filter({ category: 'Electronics', in_stock: true })
        .execute();

      // Verify update
      const result = await transactionDb.executeQuery<TestProduct>(
        'SELECT * FROM test_products WHERE name = :name',
        { name: 'Test Product' }
      );

      return result;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      name: 'Test Product',
      price: '24.99', // PostgreSQL returns DECIMAL as string
      category: 'Electronics',
      in_stock: false,
    });

    await db.disconnect();
  });

  test('executes update without filter conditions (updates all rows)', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_bulk_update (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          active BOOLEAN DEFAULT true,
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert multiple test records
      await transactionDb.executeQuery(
        'INSERT INTO test_bulk_update (name) VALUES (:name1), (:name2), (:name3)',
        { name1: 'User 1', name2: 'User 2', name3: 'User 3' }
      );

      // Execute bulk update without filter
      await transactionDb
        .update<{ active: boolean }, {}>('test_bulk_update')
        .values({ active: false })
        .execute();

      // Verify all records were updated
      const result = await transactionDb.executeQuery<{ active: boolean; count: string }>(
        'SELECT COUNT(*) as count FROM test_bulk_update WHERE active = false'
      );

      return result;
    });

    expect(result.rowCount).toBe(1);
    expect(parseInt(result.records[0].count)).toBe(3);

    await db.disconnect();
  });

  test('handles update within transaction', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_transaction_update (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          version INTEGER DEFAULT 1
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_transaction_update (name, email) VALUES (:name, :email)',
        { name: 'Transaction Test', email: 'transaction@example.com' }
      );

      // Execute multiple updates within transaction
      await transactionDb
        .update<TestUser, UserFilter>('test_transaction_update')
        .values({ name: 'Updated in Transaction 1' })
        .filter({ email: 'transaction@example.com' })
        .execute();

      await transactionDb
        .update<{ version: number }, { email: string }>('test_transaction_update')
        .values({ version: 2 })
        .filter({ email: 'transaction@example.com' })
        .execute();

      // Verify final state
      const result = await transactionDb.executeQuery<TestUser & { version: number }>(
        'SELECT * FROM test_transaction_update WHERE email = :email',
        { email: 'transaction@example.com' }
      );

      return result;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      name: 'Updated in Transaction 1',
      email: 'transaction@example.com',
      version: 2,
    });

    await db.disconnect();
  });

  test('handles update with no matching rows', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_no_match_update (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL
        )
      `);

      // Execute update with non-existent filter
      const updateResult = await transactionDb
        .update<TestUser, UserFilter>('test_no_match_update')
        .values({ name: 'Should Not Update' })
        .filter({ email: 'nonexistent@example.com' })
        .execute();

      return updateResult;
    });

    expect(result?.rowCount).toBe(0);

    await db.disconnect();
  });
});

describe('Update Statement with RETURNING Integration', () => {
  test('executes update with returning all fields', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_returning_update (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          age INTEGER,
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_returning_update (name, email, age) VALUES (:name, :email, :age)',
        { name: 'Original Name', email: 'returning@example.com', age: 25 }
      );

      // Execute update with returning all fields using raw SQL
      const updateResult = await transactionDb.executeQuery<TestUser>(
        `UPDATE test_returning_update 
         SET name = :name, age = :age 
         WHERE email = :f_email 
         RETURNING *`,
        { name: 'Updated with Returning', age: 26, f_email: 'returning@example.com' }
      );

      return updateResult;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      name: 'Updated with Returning',
      email: 'returning@example.com',
      age: 26,
    });
    expect(result.records[0].id).toBeDefined();
    expect(result.records[0].updated_at).toBeDefined();

    await db.disconnect();
  });

  test('executes update with returning specific fields', async () => {
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
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_returning_specific (name, email, age) VALUES (:name, :email, :age)',
        { name: 'Specific Return', email: 'specific@example.com', age: 30 }
      );

      // Execute update with returning specific fields using raw SQL
      const updateResult = await transactionDb.executeQuery<{
        id: number;
        name: string;
        age: number;
      }>(
        `UPDATE test_returning_specific 
         SET name = :name, age = :age, active = :active 
         WHERE email = :f_email 
         RETURNING id, name, age`,
        { name: 'Updated Specific', age: 31, active: false, f_email: 'specific@example.com' }
      );

      return updateResult;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toEqual({
      id: expect.any(Number),
      name: 'Updated Specific',
      age: 31,
    });
    // Should not include email, active, or updated_at since they weren't in returning clause
    expect(result.records[0]).not.toHaveProperty('email');
    expect(result.records[0]).not.toHaveProperty('active');
    expect(result.records[0]).not.toHaveProperty('updated_at');

    await db.disconnect();
  });

  test('executes update with returning computed fields', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_returning_computed (
          id SERIAL PRIMARY KEY,
          first_name VARCHAR(50) NOT NULL,
          last_name VARCHAR(50) NOT NULL,
          age INTEGER,
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_returning_computed (first_name, last_name, age) VALUES (:first_name, :last_name, :age)',
        { first_name: 'John', last_name: 'Doe', age: 25 }
      );

      // Execute update with returning computed field
      const updateResult = await transactionDb.executeQuery<{
        id: number;
        full_name: string;
        age: number;
        updated_at: Date;
      }>(
        `UPDATE test_returning_computed 
         SET age = :age 
         WHERE first_name = :f_first_name AND last_name = :f_last_name 
         RETURNING id, first_name || ' ' || last_name as full_name, age, updated_at`,
        { age: 26, f_first_name: 'John', f_last_name: 'Doe' }
      );

      return updateResult;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      id: expect.any(Number),
      full_name: 'John Doe',
      age: 26,
    });
    expect(result.records[0].updated_at).toBeDefined();

    await db.disconnect();
  });

  test('executes update with returning and complex data types', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_returning_complex (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          metadata JSONB,
          tags TEXT[],
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_returning_complex (name, metadata, tags) VALUES (:name, :metadata, :tags)',
        {
          name: 'Complex Update Test',
          metadata: { version: 1, settings: { theme: 'light' } },
          tags: ['original', 'test'],
        }
      );

      // Execute update with returning all fields using raw SQL
      const updateResult = await transactionDb.executeQuery<any>(
        `UPDATE test_returning_complex 
         SET metadata = :metadata, tags = :tags 
         WHERE name = :f_name 
         RETURNING *`,
        {
          metadata: { version: 2, settings: { theme: 'dark' }, updated: true },
          tags: ['updated', 'complex', 'test'],
          f_name: 'Complex Update Test',
        }
      );

      return updateResult;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      id: expect.any(Number),
      name: 'Complex Update Test',
      metadata: { version: 2, settings: { theme: 'dark' }, updated: true },
      tags: ['updated', 'complex', 'test'],
    });
    expect(result.records[0].updated_at).toBeDefined();

    await db.disconnect();
  });

  test('executes multiple updates with returning within transaction', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_multiple_update_returning (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          category VARCHAR(50) NOT NULL,
          version INTEGER DEFAULT 1,
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_multiple_update_returning (name, category) VALUES (:name1, :category1), (:name2, :category2)',
        {
          name1: 'First Item',
          category1: 'Category A',
          name2: 'Second Item',
          category2: 'Category B',
        }
      );

      // Execute multiple updates with returning using raw SQL
      const update1 = await transactionDb.executeQuery<{
        id: number;
        name: string;
        version: number;
      }>(
        `UPDATE test_multiple_update_returning 
         SET name = :name, version = :version 
         WHERE category = :f_category 
         RETURNING id, name, version`,
        { name: 'Updated First Item', version: 2, f_category: 'Category A' }
      );

      const update2 = await transactionDb.executeQuery<{
        id: number;
        name: string;
        version: number;
      }>(
        `UPDATE test_multiple_update_returning 
         SET name = :name, version = :version 
         WHERE category = :f_category 
         RETURNING id, name, version`,
        { name: 'Updated Second Item', version: 3, f_category: 'Category B' }
      );

      return { update1, update2 };
    });

    expect(result.update1.rowCount).toBe(1);
    expect(result.update1.records[0]).toEqual({
      id: expect.any(Number),
      name: 'Updated First Item',
      version: 2,
    });

    expect(result.update2.rowCount).toBe(1);
    expect(result.update2.records[0]).toEqual({
      id: expect.any(Number),
      name: 'Updated Second Item',
      version: 3,
    });

    // Verify IDs are different
    expect(result.update1.records[0].id).not.toBe(result.update2.records[0].id);

    await db.disconnect();
  });

  test('executes bulk update with returning multiple rows', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_bulk_update_returning (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          category VARCHAR(50) NOT NULL,
          active BOOLEAN DEFAULT true,
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_bulk_update_returning (name, category) VALUES 
         ('Item 1', 'Electronics'), 
         ('Item 2', 'Electronics'), 
         ('Item 3', 'Books')`
      );

      // Execute bulk update with returning using raw SQL
      const updateResult = await transactionDb.executeQuery<{
        id: number;
        name: string;
        active: boolean;
      }>(
        `UPDATE test_bulk_update_returning 
         SET active = :active 
         WHERE category = :f_category 
         RETURNING id, name, active`,
        { active: false, f_category: 'Electronics' }
      );

      return updateResult;
    });

    expect(result.rowCount).toBe(2); // Should update 2 Electronics items
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      id: expect.any(Number),
      name: 'Item 1',
      active: false,
    });
    expect(result.records[1]).toMatchObject({
      id: expect.any(Number),
      name: 'Item 2',
      active: false,
    });

    await db.disconnect();
  });
});

describe('Update Statement Execute Return Methods', () => {
  test('executeReturnSingle returns single updated record', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_update_return_single (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          age INTEGER,
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_update_return_single (name, email, age) VALUES (:name, :email, :age)',
        { name: 'Single Return Test', email: 'single@example.com', age: 25 }
      );

      // Execute update with returning and get single record
      const updatedRecord = await transactionDb
        .update<TestUser, UserFilter>('test_update_return_single')
        .values({ name: 'Updated Single Return', age: 26 })
        .filter({ email: 'single@example.com' })
        .returning('*')
        .executeReturnSingle();

      return updatedRecord;
    });

    expect(result).toMatchObject({
      name: 'Updated Single Return',
      email: 'single@example.com',
      age: 26,
    });
    expect(result?.id).toBeDefined();
    expect(result?.updated_at).toBeDefined();

    await db.disconnect();
  });

  test('executeReturnAll returns all updated records', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_update_return_all (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          category VARCHAR(50) NOT NULL,
          active BOOLEAN DEFAULT true
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_update_return_all (name, category) VALUES 
         ('Return All Test 1', 'Test Category'), 
         ('Return All Test 2', 'Test Category')`
      );

      // Update multiple records and return all
      const updatedRecords = await transactionDb
        .update<{ active: boolean }, { category: string }>('test_update_return_all')
        .values({ active: false })
        .filter({ category: 'Test Category' })
        .returning('*')
        .executeReturnAll();

      return updatedRecords;
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      name: 'Return All Test 1',
      category: 'Test Category',
      active: false,
    });
    expect(result[1]).toMatchObject({
      name: 'Return All Test 2',
      category: 'Test Category',
      active: false,
    });
    expect((result[0] as any).id).toBeDefined();
    expect((result[1] as any).id).toBeDefined();

    await db.disconnect();
  });

  test('executeReturnCount returns number of updated records', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_update_return_count (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          category VARCHAR(50) NOT NULL,
          active BOOLEAN DEFAULT true
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_update_return_count (name, category) VALUES 
         ('Count Test 1', 'Count Category'), 
         ('Count Test 2', 'Count Category'), 
         ('Count Test 3', 'Other Category')`
      );

      // Execute update and get count
      const updateCount = await transactionDb
        .update<{ active: boolean }, { category: string }>('test_update_return_count')
        .values({ active: false })
        .filter({ category: 'Count Category' })
        .executeReturnCount();

      return updateCount;
    });

    expect(result).toBe(2); // Should update 2 records with 'Count Category'

    await db.disconnect();
  });

  test('executeReturnSingle with specific returning fields', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_update_return_single_fields (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          age INTEGER,
          active BOOLEAN DEFAULT true,
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_update_return_single_fields (name, email, age) VALUES (:name, :email, :age)',
        { name: 'Specific Fields Test', email: 'specific@example.com', age: 25 }
      );

      // Execute update with specific returning fields
      const updatedRecord = await transactionDb
        .update<TestUser, UserFilter>('test_update_return_single_fields')
        .values({ name: 'Updated Specific Fields', age: 26, active: false })
        .filter({ email: 'specific@example.com' })
        .returning(['id', 'name', 'email'] as (keyof TestUser)[])
        .executeReturnSingle();

      return updatedRecord;
    });

    expect(result).toMatchObject({
      name: 'Updated Specific Fields',
      email: 'specific@example.com',
    });
    expect(result?.id).toBeDefined();
    // Should not include age, active, or updated_at since they weren't in returning clause
    expect(result).not.toHaveProperty('age');
    expect(result).not.toHaveProperty('active');
    expect(result).not.toHaveProperty('updated_at');

    await db.disconnect();
  });

  test('executeReturnAll with complex data types', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_update_return_all_complex (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          metadata JSONB,
          tags TEXT[],
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_update_return_all_complex (name, metadata, tags) VALUES (:name, :metadata, :tags)',
        {
          name: 'Complex Return All Test',
          metadata: { settings: { theme: 'light' }, preferences: ['email'] },
          tags: ['test', 'original'],
        }
      );

      // Execute update with complex data types
      const updatedRecords = await transactionDb
        .update<{ metadata: any; tags: string[] }, { name: string }>(
          'test_update_return_all_complex'
        )
        .values({
          metadata: { settings: { theme: 'dark' }, preferences: ['email', 'sms'], updated: true },
          tags: ['test', 'complex', 'updated'],
        })
        .filter({ name: 'Complex Return All Test' })
        .returning('*')
        .executeReturnAll();

      return updatedRecords;
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'Complex Return All Test',
      metadata: { settings: { theme: 'dark' }, preferences: ['email', 'sms'], updated: true },
      tags: ['test', 'complex', 'updated'],
    });
    expect((result[0] as any).id).toBeDefined();
    expect((result[0] as any).updated_at).toBeDefined();

    await db.disconnect();
  });

  test('executeReturnCount with multiple operations in transaction', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_update_return_count_multiple (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status VARCHAR(20) DEFAULT 'active',
          category VARCHAR(50) NOT NULL
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_update_return_count_multiple (name, category) VALUES 
         ('First Update', 'Category A'), 
         ('Second Update', 'Category A'), 
         ('Third Update', 'Category B')`
      );

      // Execute multiple updates and track counts
      const count1 = await transactionDb
        .update<{ status: string }, { category: string }>('test_update_return_count_multiple')
        .values({ status: 'updated' })
        .filter({ category: 'Category A' })
        .executeReturnCount();

      const count2 = await transactionDb
        .update<{ status: string }, { name: string }>('test_update_return_count_multiple')
        .values({ status: 'processed' })
        .filter({ name: 'Third Update' })
        .executeReturnCount();

      // Verify total records with updated status
      const totalResult = await transactionDb.executeQuery<{ count: string }>(
        'SELECT COUNT(*) as count FROM test_update_return_count_multiple WHERE status != :status',
        { status: 'active' }
      );

      return { count1, count2, totalCount: parseInt(totalResult.records[0].count) };
    });

    expect(result.count1).toBe(2); // Updated 2 records in Category A
    expect(result.count2).toBe(1); // Updated 1 record named 'Third Update'
    expect(result.totalCount).toBe(3); // Total 3 records were updated

    await db.disconnect();
  });
});

describe('Update Statement Edge Cases and Error Handling', () => {
  test('throws error for empty values object', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const updateStatement = db.update<TestUser, UserFilter>('users');

    updateStatement.values({}).filter({ id: 1 });

    expect(() => (updateStatement as any).buildQuery()).toThrow(
      'Cannot build UPDATE statement for table "users": no values provided'
    );
  });

  test('handles empty filter object', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const updateStatement = db.update<TestUser, UserFilter>('users');

    updateStatement.values({ name: 'Test' }).filter({});

    const query = (updateStatement as any).buildQuery();
    const params = (updateStatement as any).buildParameters();

    expect(query).toBe('UPDATE users SET name = :v_name');
    expect(params).toEqual({ v_name: 'Test' });
  });

  test('handles null and undefined values', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const updateStatement = db.update<TestUser, UserFilter>('users');

    updateStatement
      .values({ name: 'Test', age: null as any, active: undefined as any })
      .filter({ id: 1 });

    const params = (updateStatement as any).buildParameters();

    expect(params).toEqual({
      v_name: 'Test',
      v_age: null,
      v_active: undefined,
      p1: 1,
    });
  });

  test('handles special characters in values', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const updateStatement = db.update<TestUser, UserFilter>('users');

    updateStatement.values({ name: "O'Connor", email: 'test@domain.com' }).filter({ id: 1 });

    const params = (updateStatement as any).buildParameters();

    expect(params).toEqual({
      v_name: "O'Connor",
      v_email: 'test@domain.com',
      p1: 1,
    });
  });

  test('handles large number of filter conditions', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const updateStatement = db.update<TestUser, TestUser>('users');

    const largeFilter = {
      id: 1,
      name: 'Test',
      email: 'test@example.com',
      age: 25,
      active: true,
    };

    updateStatement.values({ name: 'Updated' }).filter(largeFilter);

    const query = (updateStatement as any).buildQuery();

    expect(query).toBe(
      'UPDATE users SET name = :v_name WHERE id = :p1 AND name = :p2 AND email = :p3 AND age = :p4 AND active = :p5'
    );
  });

  test('executeReturnSingle returns null when no rows updated', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_update_no_match (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL
        )
      `);

      // Execute update with non-existent filter
      const updatedRecord = await transactionDb
        .update<TestUser, UserFilter>('test_update_no_match')
        .values({ name: 'Should Not Update' })
        .filter({ email: 'nonexistent@example.com' })
        .returning('*')
        .executeReturnSingle();

      return updatedRecord;
    });

    expect(result).toBeNull();

    await db.disconnect();
  });

  test('executeReturnAll returns empty array when no rows updated', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_update_no_match_all (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          category VARCHAR(50) NOT NULL
        )
      `);

      // Execute update with non-existent filter
      const updatedRecords = await transactionDb
        .update<{ name: string }, { category: string }>('test_update_no_match_all')
        .values({ name: 'Should Not Update' })
        .filter({ category: 'NonExistent' })
        .returning('*')
        .executeReturnAll();

      return updatedRecords;
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);

    await db.disconnect();
  });

  test('executeReturnCount returns 0 when no rows updated', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_update_no_match_count (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status VARCHAR(20) DEFAULT 'active'
        )
      `);

      // Execute update with non-existent filter
      const updateCount = await transactionDb
        .update<{ status: string }, { name: string }>('test_update_no_match_count')
        .values({ status: 'inactive' })
        .filter({ name: 'NonExistent' })
        .executeReturnCount();

      return updateCount;
    });

    expect(result).toBe(0);

    await db.disconnect();
  });
});
