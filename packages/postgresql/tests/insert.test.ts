import { describe, expect, test } from 'vitest';
import { PostgreSQLDatabase } from '../src/database.js';
import { PostgreSQLInsertStatement } from '../src/insert-statement.js';
import { connectionConfig } from './params.js';

interface TestUser {
  id?: number;
  name: string;
  email: string;
  age?: number;
  active?: boolean;
  created_at?: Date;
  metadata?: Record<string, any>;
}

interface TestProduct {
  id?: number;
  name: string;
  price: number;
  category: string;
  in_stock?: boolean;
}

describe('PostgreSQLInsertStatement', () => {
  test('creates insert statement instance', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const insertStatement = db.insert<TestUser>('users');

    expect(insertStatement).toBeInstanceOf(PostgreSQLInsertStatement);
    expect(insertStatement.constructor.name).toBe('PostgreSQLInsertStatement');
  });

  test('builds correct query for single column', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const insertStatement = db.insert<TestUser>('users');

    insertStatement.values({ name: 'John Doe' });

    // Access protected method for testing
    const query = (insertStatement as any).buildQuery();
    const params = (insertStatement as any).buildParameters();

    expect(query).toBe('INSERT INTO users (name) VALUES (:name)');
    expect(params).toEqual({ name: 'John Doe' });
  });

  test('builds correct query for multiple columns', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const insertStatement = db.insert<TestUser>('users');

    const userData = {
      name: 'Jane Smith',
      email: 'jane@example.com',
      age: 30,
      active: true,
    };

    insertStatement.values(userData);

    const query = (insertStatement as any).buildQuery();
    const params = (insertStatement as any).buildParameters();

    expect(query).toBe(
      'INSERT INTO users (name, email, age, active) VALUES (:name, :email, :age, :active)'
    );
    expect(params).toEqual(userData);
  });

  test('builds query with returning all fields', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const insertStatement = db.insert<TestUser>('users');

    insertStatement.values({ name: 'Return Test', email: 'return@example.com' }).returning('*');

    const query = (insertStatement as any).buildQuery();

    expect(query).toBe('INSERT INTO users (name, email) VALUES (:name, :email) RETURNING *');
  });

  test('builds query with returning specific fields', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const insertStatement = db.insert<TestUser>('users');

    insertStatement
      .values({ name: 'Return Test', email: 'return@example.com', age: 30 })
      .returning(['id', 'name', 'email'] as (keyof TestUser)[]);

    const query = (insertStatement as any).buildQuery();

    expect(query).toBe(
      'INSERT INTO users (name, email, age) VALUES (:name, :email, :age) RETURNING id, name, email'
    );
  });

  test('allows chaining values and returning methods', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const insertStatement = db.insert<TestUser>('users');

    const result = insertStatement
      .values({ name: 'Chain Test', email: 'chain@example.com' })
      .returning(['id', 'name'] as (keyof TestUser)[]);

    expect(result).toBe(insertStatement);
    expect((insertStatement as any)._values).toEqual({
      name: 'Chain Test',
      email: 'chain@example.com',
    });
    expect((insertStatement as any)._returning).toEqual(['id', 'name']);
  });
});

describe('Insert Statement Integration', () => {
  test('executes simple insert successfully', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL
        )
      `);

      // Execute insert within transaction
      await transactionDb
        .insert<TestUser>('test_users')
        .values({ name: 'Integration Test', email: 'integration@example.com' })
        .execute();

      // Verify insertion within transaction
      const result = await transactionDb.executeQuery<TestUser>(
        'SELECT * FROM test_users WHERE email = :email',
        { email: 'integration@example.com' }
      );

      return result;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      name: 'Integration Test',
      email: 'integration@example.com',
    });
    expect(result.records[0].id).toBeDefined();

    await db.disconnect();
  });

  test('executes insert with multiple columns', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const productData = {
      name: 'Test Product',
      price: 29.99,
      category: 'Electronics',
      in_stock: true,
    };

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          category VARCHAR(50) NOT NULL,
          in_stock BOOLEAN DEFAULT true
        )
      `);

      // Execute insert within transaction
      await transactionDb.insert<TestProduct>('test_products').values(productData).execute();

      // Verify insertion within transaction
      const result = await transactionDb.executeQuery<TestProduct>(
        'SELECT * FROM test_products WHERE name = :name',
        { name: 'Test Product' }
      );

      return result;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      name: 'Test Product',
      price: '29.99', // PostgreSQL returns DECIMAL as string
      category: 'Electronics',
      in_stock: true,
    });

    await db.disconnect();
  });

  test('handles insert within transaction', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_transaction_users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL
        )
      `);

      // Insert multiple records within transaction
      await transactionDb
        .insert<TestUser>('test_transaction_users')
        .values({ name: 'Transaction User 1', email: 'tx1@example.com' })
        .execute();

      await transactionDb
        .insert<TestUser>('test_transaction_users')
        .values({ name: 'Transaction User 2', email: 'tx2@example.com' })
        .execute();

      // Verify both records were inserted within transaction
      const result = await transactionDb.executeQuery<TestUser>(
        'SELECT * FROM test_transaction_users ORDER BY id'
      );

      return result;
    });

    expect(result.rowCount).toBe(2);
    expect(result.records[0].name).toBe('Transaction User 1');
    expect(result.records[1].name).toBe('Transaction User 2');

    await db.disconnect();
  });
});

describe('Insert Statement Returning Integration', () => {
  test('executes insert with returning all fields', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_returning_users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Execute insert with returning all fields using raw SQL
      const insertResult = await transactionDb.executeQuery<TestUser>(
        `INSERT INTO test_returning_users (name, email) 
         VALUES (:name, :email) 
         RETURNING *`,
        { name: 'Returning Test', email: 'returning@example.com' }
      );

      return insertResult;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      name: 'Returning Test',
      email: 'returning@example.com',
    });
    expect(result.records[0].id).toBeDefined();
    expect(result.records[0].created_at).toBeDefined();

    await db.disconnect();
  });

  test('executes insert with returning specific fields', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_returning_products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          price DECIMAL(10,2) NOT NULL,
          category VARCHAR(50) NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Execute insert with returning specific fields using raw SQL
      const insertResult = await transactionDb.executeQuery<{
        id: number;
        name: string;
        price: string;
      }>(
        `INSERT INTO test_returning_products (name, price, category) 
         VALUES (:name, :price, :category) 
         RETURNING id, name, price`,
        { name: 'Returning Product', price: 49.99, category: 'Books' }
      );

      return insertResult;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toEqual({
      id: expect.any(Number),
      name: 'Returning Product',
      price: '49.99',
    });
    // Should not include category or created_at since they weren't in returning clause
    expect(result.records[0]).not.toHaveProperty('category');
    expect(result.records[0]).not.toHaveProperty('created_at');

    await db.disconnect();
  });

  test('executes insert with returning single field', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_returning_single (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL
        )
      `);

      // Execute insert with returning only id using raw SQL
      const insertResult = await transactionDb.executeQuery<{ id: number }>(
        `INSERT INTO test_returning_single (name, email) 
         VALUES (:name, :email) 
         RETURNING id`,
        { name: 'Single Return', email: 'single@example.com' }
      );

      return insertResult;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toEqual({
      id: expect.any(Number),
    });
    // Should only include id field
    expect(result.records[0]).not.toHaveProperty('name');
    expect(result.records[0]).not.toHaveProperty('email');

    await db.disconnect();
  });

  test('executes insert with returning computed fields', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_returning_computed (
          id SERIAL PRIMARY KEY,
          first_name VARCHAR(50) NOT NULL,
          last_name VARCHAR(50) NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Execute insert with returning computed field
      const insertResult = await transactionDb.executeQuery<{
        id: number;
        full_name: string;
        created_at: Date;
      }>(
        `INSERT INTO test_returning_computed (first_name, last_name) 
         VALUES (:first_name, :last_name) 
         RETURNING id, first_name || ' ' || last_name as full_name, created_at`,
        { first_name: 'John', last_name: 'Doe' }
      );

      return insertResult;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      id: expect.any(Number),
      full_name: 'John Doe',
    });
    expect(result.records[0].created_at).toBeDefined();

    await db.disconnect();
  });

  test('executes insert with returning and complex data types', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_returning_complex (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          metadata JSONB,
          tags TEXT[],
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Execute insert with returning all fields using raw SQL
      const insertResult = await transactionDb.executeQuery<any>(
        `INSERT INTO test_returning_complex (name, metadata, tags) 
         VALUES (:name, :metadata, :tags) 
         RETURNING *`,
        {
          name: 'Complex Returning Test',
          metadata: { settings: { theme: 'light' }, version: 2 },
          tags: ['returning', 'complex', 'test'],
        }
      );

      return insertResult;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      id: expect.any(Number),
      name: 'Complex Returning Test',
      metadata: { settings: { theme: 'light' }, version: 2 },
      tags: ['returning', 'complex', 'test'],
    });
    expect(result.records[0].created_at).toBeDefined();

    await db.disconnect();
  });

  test('executes multiple inserts with returning within transaction', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_multiple_returning (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          category VARCHAR(50) NOT NULL
        )
      `);

      // Execute multiple inserts with returning using raw SQL
      const insert1 = await transactionDb.executeQuery<{ id: number; name: string }>(
        `INSERT INTO test_multiple_returning (name, category) 
         VALUES (:name, :category) 
         RETURNING id, name`,
        { name: 'First Item', category: 'Category A' }
      );

      const insert2 = await transactionDb.executeQuery<{ id: number; name: string }>(
        `INSERT INTO test_multiple_returning (name, category) 
         VALUES (:name, :category) 
         RETURNING id, name`,
        { name: 'Second Item', category: 'Category B' }
      );

      return { insert1, insert2 };
    });

    expect(result.insert1.rowCount).toBe(1);
    expect(result.insert1.records[0]).toEqual({
      id: expect.any(Number),
      name: 'First Item',
    });

    expect(result.insert2.rowCount).toBe(1);
    expect(result.insert2.records[0]).toEqual({
      id: expect.any(Number),
      name: 'Second Item',
    });

    // Verify IDs are different
    expect(result.insert1.records[0].id).not.toBe(result.insert2.records[0].id);

    await db.disconnect();
  });
});

describe('Insert Statement Execute Return Methods', () => {
  test('executeReturnSingle returns single inserted record', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_return_single (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Execute insert with returning and get single record
      const insertedRecord = await transactionDb
        .insert<TestUser>('test_return_single')
        .values({ name: 'Single Return Test', email: 'single@example.com' })
        .returning('*')
        .executeReturnSingle();

      return insertedRecord;
    });

    expect(result).toMatchObject({
      name: 'Single Return Test',
      email: 'single@example.com',
    });
    expect(result?.id).toBeDefined();
    expect(result?.created_at).toBeDefined();

    await db.disconnect();
  });

  test('executeReturnAll returns all inserted records', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_return_all (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          category VARCHAR(50) NOT NULL
        )
      `);

      // Insert single record and return all (should be array with one item)
      const insertedRecords = await transactionDb
        .insert('test_return_all')
        .values({ name: 'Return All Test', category: 'Test Category' })
        .returning('*')
        .executeReturnAll();

      return insertedRecords;
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'Return All Test',
      category: 'Test Category',
    });
    expect((result[0] as any).id).toBeDefined();

    await db.disconnect();
  });

  test('executeReturnCount returns number of inserted records', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_return_count (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          description TEXT
        )
      `);

      // Execute insert and get count
      const insertCount = await transactionDb
        .insert('test_return_count')
        .values({ name: 'Count Test', description: 'Testing count functionality' })
        .executeReturnCount();

      return insertCount;
    });

    expect(result).toBe(1);

    await db.disconnect();
  });

  test('executeReturnSingle with specific returning fields', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_return_single_fields (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          age INTEGER,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Execute insert with specific returning fields
      const insertedRecord = await transactionDb
        .insert<TestUser>('test_return_single_fields')
        .values({ name: 'Specific Fields Test', email: 'specific@example.com', age: 25 })
        .returning(['id', 'name', 'email'] as (keyof TestUser)[])
        .executeReturnSingle();

      return insertedRecord;
    });

    expect(result).toMatchObject({
      name: 'Specific Fields Test',
      email: 'specific@example.com',
    });
    expect(result?.id).toBeDefined();
    // Should not include age or created_at since they weren't in returning clause
    expect(result).not.toHaveProperty('age');
    expect(result).not.toHaveProperty('created_at');

    await db.disconnect();
  });

  test('executeReturnAll with complex data types', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_return_all_complex (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          metadata JSONB,
          tags TEXT[],
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Execute insert with complex data types
      const insertedRecords = await transactionDb
        .insert('test_return_all_complex')
        .values({
          name: 'Complex Return All Test',
          metadata: { settings: { theme: 'dark' }, preferences: ['email', 'sms'] },
          tags: ['test', 'complex', 'returning'],
        })
        .returning('*')
        .executeReturnAll();

      return insertedRecords;
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'Complex Return All Test',
      metadata: { settings: { theme: 'dark' }, preferences: ['email', 'sms'] },
      tags: ['test', 'complex', 'returning'],
    });
    expect((result[0] as any).id).toBeDefined();
    expect((result[0] as any).created_at).toBeDefined();

    await db.disconnect();
  });

  test('executeReturnCount with multiple operations in transaction', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_return_count_multiple (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status VARCHAR(20) DEFAULT 'active'
        )
      `);

      // Execute multiple inserts and track counts
      const count1 = await transactionDb
        .insert('test_return_count_multiple')
        .values({ name: 'First Insert' })
        .executeReturnCount();

      const count2 = await transactionDb
        .insert('test_return_count_multiple')
        .values({ name: 'Second Insert' })
        .executeReturnCount();

      const count3 = await transactionDb
        .insert('test_return_count_multiple')
        .values({ name: 'Third Insert' })
        .executeReturnCount();

      // Verify total records in table
      const totalResult = await transactionDb.executeQuery<{ count: string }>(
        'SELECT COUNT(*) as count FROM test_return_count_multiple'
      );

      return { count1, count2, count3, totalCount: parseInt(totalResult.records[0].count) };
    });

    expect(result.count1).toBe(1);
    expect(result.count2).toBe(1);
    expect(result.count3).toBe(1);
    expect(result.totalCount).toBe(3);

    await db.disconnect();
  });
});
