import { FromStatement } from '@blendsdk/dbcore';
import { describe, expect, test } from 'vitest';
import { PostgreSQLDatabase } from '../src/database.js';
import { connectionConfig } from './params.js';

interface TestUser {
  id?: number;
  name: string;
  email: string;
  age?: number;
  active?: boolean;
  created_at?: Date;
}

interface TestProduct {
  id?: number;
  name: string;
  price: number;
  category: string;
  in_stock?: boolean;
}

describe('FromStatement', () => {
  test('creates from statement instance', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const fromStatement = db.from<TestUser>('users');

    expect(fromStatement).toBeInstanceOf(FromStatement);
    expect(fromStatement.constructor.name).toBe('FromStatement');
  });

  test('builds correct query for select all with wildcard', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const fromStatement = db.from<TestUser>('users');

    fromStatement.select();

    // Access protected method for testing
    const query = (fromStatement as any).buildQuery();

    expect(query).toBe('SELECT * FROM users');
  });

  test('builds correct query for select all with explicit wildcard', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const fromStatement = db.from<TestUser>('users');

    fromStatement.select(['*']);

    const query = (fromStatement as any).buildQuery();

    expect(query).toBe('SELECT * FROM users');
  });

  test('builds correct query for single column', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const fromStatement = db.from<TestUser>('users');

    fromStatement.select(['name']);

    const query = (fromStatement as any).buildQuery();

    expect(query).toBe('SELECT name FROM users');
  });

  test('builds correct query for multiple columns', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const fromStatement = db.from<TestUser>('users');

    fromStatement.select(['id', 'name', 'email']);

    const query = (fromStatement as any).buildQuery();

    expect(query).toBe('SELECT id, name, email FROM users');
  });

  test('builds correct query for all columns of a table', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const fromStatement = db.from<TestUser>('users');

    fromStatement.select(['id', 'name', 'email', 'age', 'active', 'created_at']);

    const query = (fromStatement as any).buildQuery();

    expect(query).toBe('SELECT id, name, email, age, active, created_at FROM users');
  });

  test('allows chaining selectAll method', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const fromStatement = db.from<TestUser>('users');

    const result = fromStatement.select(['id', 'name']);

    expect(result).toBe(fromStatement);
    expect((fromStatement as any)._selectColumns).toEqual(['id', 'name']);
  });

  test('selectAll can be called multiple times, last call wins', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const fromStatement = db.from<TestUser>('users');

    fromStatement.select(['id']).select(['name', 'email']);

    const query = (fromStatement as any).buildQuery();

    expect(query).toBe('SELECT name, email FROM users');
  });

  test('builds query with different table names', () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const usersQuery = (db.from<TestUser>('users').select() as any).buildQuery();
    const productsQuery = (db.from<TestProduct>('products').select() as any).buildQuery();
    const ordersQuery = (db.from('orders').select() as any).buildQuery();

    expect(usersQuery).toBe('SELECT * FROM users');
    expect(productsQuery).toBe('SELECT * FROM products');
    expect(ordersQuery).toBe('SELECT * FROM orders');
  });

  test('buildParameters returns empty object', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const fromStatement = db.from<TestUser>('users');

    fromStatement.select();

    const params = (fromStatement as any).buildParameters();

    expect(params).toEqual({});
  });

  test('builds correct query with column aliases using object syntax', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const fromStatement = db.from<TestUser>('users');

    fromStatement.select({
      user_id: 'id',
      user_name: 'name',
      user_email: 'email',
    });

    const query = (fromStatement as any).buildQuery();

    expect(query).toBe('SELECT id AS user_id, name AS user_name, email AS user_email FROM users');
  });

  test('builds correct query with single column alias', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const fromStatement = db.from<TestUser>('users');

    fromStatement.select({
      full_name: 'name',
    });

    const query = (fromStatement as any).buildQuery();

    expect(query).toBe('SELECT name AS full_name FROM users');
  });

  test('builds correct query with computed column aliases', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const fromStatement = db.from<TestUser>('users');

    fromStatement.select({
      user_count: 'COUNT(*)',
      total_age: 'SUM(age)',
    });

    const query = (fromStatement as any).buildQuery();

    expect(query).toBe('SELECT COUNT(*) AS user_count, SUM(age) AS total_age FROM users');
  });

  test('builds correct query with expression aliases', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const fromStatement = db.from<TestUser>('users');

    fromStatement.select({
      full_info: "name || ' - ' || email",
      age_group: "CASE WHEN age < 18 THEN 'minor' ELSE 'adult' END",
    });

    const query = (fromStatement as any).buildQuery();

    expect(query).toBe(
      "SELECT name || ' - ' || email AS full_info, CASE WHEN age < 18 THEN 'minor' ELSE 'adult' END AS age_group FROM users"
    );
  });

  test('allows chaining with column aliases', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const fromStatement = db.from<TestUser>('users');

    const result = fromStatement.select({
      user_id: 'id',
      user_name: 'name',
    });

    expect(result).toBe(fromStatement);
    expect((fromStatement as any)._selectColumns).toEqual(['id AS user_id', 'name AS user_name']);
  });

  test('column aliases can be overridden by subsequent selectAll calls', () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const fromStatement = db.from<TestUser>('users');

    fromStatement
      .select({
        user_id: 'id',
      })
      .select({
        person_name: 'name',
      });

    const query = (fromStatement as any).buildQuery();

    expect(query).toBe('SELECT name AS person_name FROM users');
  });
});

describe('From Statement Integration', () => {
  test('executes simple select all successfully', async () => {
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

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_users (name, email) VALUES (:name, :email)`,
        { name: 'Integration Test', email: 'integration@example.com' }
      );

      // Execute select using from statement
      const fromStatement = transactionDb.from<TestUser>('test_users');
      const query = (fromStatement.select() as any).buildQuery();
      const params = (fromStatement as any).buildParameters();

      const result = await transactionDb.executeQuery<TestUser>(query, params);

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

  test('executes select with specific columns', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

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

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_products (name, price, category, in_stock) 
         VALUES (:name, :price, :category, :in_stock)`,
        { name: 'Test Product', price: 29.99, category: 'Electronics', in_stock: true }
      );

      // Execute select with specific columns
      const fromStatement = transactionDb.from<TestProduct>('test_products');
      const query = (fromStatement.select(['id', 'name', 'price']) as any).buildQuery();
      const params = (fromStatement as any).buildParameters();

      const result = await transactionDb.executeQuery<Partial<TestProduct>>(query, params);

      return result;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      id: expect.any(Number),
      name: 'Test Product',
      price: '29.99',
    });
    // Should not include category or in_stock since they weren't selected
    expect(result.records[0]).not.toHaveProperty('category');
    expect(result.records[0]).not.toHaveProperty('in_stock');

    await db.disconnect();
  });

  test('executes select all with multiple records', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_multiple_users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL
        )
      `);

      // Insert multiple test records
      await transactionDb.executeQuery(
        `INSERT INTO test_multiple_users (name, email) VALUES (:name1, :email1)`,
        { name1: 'User One', email1: 'user1@example.com' }
      );
      await transactionDb.executeQuery(
        `INSERT INTO test_multiple_users (name, email) VALUES (:name2, :email2)`,
        { name2: 'User Two', email2: 'user2@example.com' }
      );
      await transactionDb.executeQuery(
        `INSERT INTO test_multiple_users (name, email) VALUES (:name3, :email3)`,
        { name3: 'User Three', email3: 'user3@example.com' }
      );

      // Execute select all
      const fromStatement = transactionDb.from<TestUser>('test_multiple_users');
      const query = (fromStatement.select() as any).buildQuery();
      const params = (fromStatement as any).buildParameters();

      const result = await transactionDb.executeQuery<TestUser>(query, params);

      return result;
    });

    expect(result.rowCount).toBe(3);
    expect(result.records).toHaveLength(3);
    expect(result.records[0].name).toBe('User One');
    expect(result.records[1].name).toBe('User Two');
    expect(result.records[2].name).toBe('User Three');

    await db.disconnect();
  });

  test('executes select with no matching records', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_empty_table (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL
        )
      `);

      // Execute select on empty table
      const fromStatement = transactionDb.from<TestUser>('test_empty_table');
      const query = (fromStatement.select() as any).buildQuery();
      const params = (fromStatement as any).buildParameters();

      const result = await transactionDb.executeQuery<TestUser>(query, params);

      return result;
    });

    expect(result.rowCount).toBe(0);
    expect(result.records).toEqual([]);

    await db.disconnect();
  });

  test('executes select with complex data types', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_complex_types (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          metadata JSONB,
          tags TEXT[],
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data with complex types
      await transactionDb.executeQuery(
        `INSERT INTO test_complex_types (name, metadata, tags) 
         VALUES (:name, :metadata, :tags)`,
        {
          name: 'Complex Test',
          metadata: { settings: { theme: 'dark' }, version: 2 },
          tags: ['test', 'complex', 'types'],
        }
      );

      // Execute select all
      const fromStatement = transactionDb.from('test_complex_types');
      const query = (fromStatement.select() as any).buildQuery();
      const params = (fromStatement as any).buildParameters();

      const result = await transactionDb.executeQuery<any>(query, params);

      return result;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      name: 'Complex Test',
      metadata: { settings: { theme: 'dark' }, version: 2 },
      tags: ['test', 'complex', 'types'],
    });
    expect(result.records[0].id).toBeDefined();
    expect(result.records[0].created_at).toBeDefined();

    await db.disconnect();
  });

  test('executes select with single column on multiple records', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_single_column (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          category VARCHAR(50) NOT NULL
        )
      `);

      // Insert multiple test records
      await transactionDb.executeQuery(
        `INSERT INTO test_single_column (name, category) VALUES 
         ('Product A', 'Category 1'),
         ('Product B', 'Category 2'),
         ('Product C', 'Category 1')`
      );

      // Execute select with single column
      const fromStatement = transactionDb.from('test_single_column');
      const query = (fromStatement.select(['name']) as any).buildQuery();
      const params = (fromStatement as any).buildParameters();

      const result = await transactionDb.executeQuery<{ name: string }>(query, params);

      return result;
    });

    expect(result.rowCount).toBe(3);
    expect(result.records).toHaveLength(3);
    expect(result.records[0]).toEqual({ name: 'Product A' });
    expect(result.records[1]).toEqual({ name: 'Product B' });
    expect(result.records[2]).toEqual({ name: 'Product C' });

    await db.disconnect();
  });

  test('executes select within transaction with multiple operations', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_transaction_select (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          status VARCHAR(20) DEFAULT 'active'
        )
      `);

      // Insert records
      await transactionDb.executeQuery(
        `INSERT INTO test_transaction_select (name, status) VALUES 
         ('Item 1', 'active'),
         ('Item 2', 'inactive'),
         ('Item 3', 'active')`
      );

      // Execute select all
      const fromStatement1 = transactionDb.from('test_transaction_select');
      const query1 = (fromStatement1.select() as any).buildQuery();
      const allRecords = await transactionDb.executeQuery<any>(query1, {});

      // Execute select with specific columns
      const fromStatement2 = transactionDb.from('test_transaction_select');
      const query2 = (fromStatement2.select(['id', 'name']) as any).buildQuery();
      const partialRecords = await transactionDb.executeQuery<any>(query2, {});

      return { allRecords, partialRecords };
    });

    expect(result.allRecords.rowCount).toBe(3);
    expect(result.allRecords.records[0]).toHaveProperty('status');

    expect(result.partialRecords.rowCount).toBe(3);
    expect(result.partialRecords.records[0]).not.toHaveProperty('status');
    expect(result.partialRecords.records[0]).toHaveProperty('id');
    expect(result.partialRecords.records[0]).toHaveProperty('name');

    await db.disconnect();
  });

  test('executes select with timestamp and date columns', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_timestamps (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          birth_date DATE
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_timestamps (name, birth_date) 
         VALUES (:name, :birth_date)`,
        { name: 'Timestamp Test', birth_date: '1990-01-15' }
      );

      // Execute select all
      const fromStatement = transactionDb.from('test_timestamps');
      const query = (fromStatement.select() as any).buildQuery();
      const params = (fromStatement as any).buildParameters();

      const result = await transactionDb.executeQuery<any>(query, params);

      return result;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0].name).toBe('Timestamp Test');
    expect(result.records[0].created_at).toBeInstanceOf(Date);
    expect(result.records[0].updated_at).toBeInstanceOf(Date);
    expect(result.records[0].birth_date).toBeInstanceOf(Date);

    await db.disconnect();
  });

  test('executes select with numeric and boolean columns', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_numeric_boolean (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          quantity INTEGER,
          price DECIMAL(10,2),
          discount FLOAT,
          is_active BOOLEAN DEFAULT true,
          is_featured BOOLEAN DEFAULT false
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_numeric_boolean (name, quantity, price, discount, is_active, is_featured) 
         VALUES (:name, :quantity, :price, :discount, :is_active, :is_featured)`,
        {
          name: 'Numeric Test',
          quantity: 100,
          price: 49.99,
          discount: 0.15,
          is_active: true,
          is_featured: false,
        }
      );

      // Execute select all
      const fromStatement = transactionDb.from('test_numeric_boolean');
      const query = (fromStatement.select() as any).buildQuery();
      const params = (fromStatement as any).buildParameters();

      const result = await transactionDb.executeQuery<any>(query, params);

      return result;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      name: 'Numeric Test',
      quantity: 100,
      price: '49.99',
      discount: 0.15,
      is_active: true,
      is_featured: false,
    });

    await db.disconnect();
  });

  test('executes select with column aliases', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_aliases (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) NOT NULL,
          age INTEGER
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_aliases (name, email, age) VALUES (:name, :email, :age)`,
        { name: 'Alias Test', email: 'alias@example.com', age: 30 }
      );

      // Execute select with column aliases
      const fromStatement = transactionDb.from('test_aliases');
      const query = (
        fromStatement.select({
          user_id: 'id',
          user_name: 'name',
          user_email: 'email',
        }) as any
      ).buildQuery();
      const params = (fromStatement as any).buildParameters();

      const result = await transactionDb.executeQuery<any>(query, params);

      return result;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      user_id: expect.any(Number),
      user_name: 'Alias Test',
      user_email: 'alias@example.com',
    });
    // Should not have original column names
    expect(result.records[0]).not.toHaveProperty('id');
    expect(result.records[0]).not.toHaveProperty('name');
    expect(result.records[0]).not.toHaveProperty('email');

    await db.disconnect();
  });

  test('executes select with computed column aliases', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_computed_aliases (
          id SERIAL PRIMARY KEY,
          first_name VARCHAR(50) NOT NULL,
          last_name VARCHAR(50) NOT NULL,
          age INTEGER
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_computed_aliases (first_name, last_name, age) 
         VALUES (:first_name, :last_name, :age)`,
        { first_name: 'John', last_name: 'Doe', age: 25 }
      );

      // Execute select with computed column aliases
      const fromStatement = transactionDb.from('test_computed_aliases');
      const query = (
        fromStatement.select({
          full_name: "first_name || ' ' || last_name",
          age_in_months: 'age * 12',
        }) as any
      ).buildQuery();
      const params = (fromStatement as any).buildParameters();

      const result = await transactionDb.executeQuery<any>(query, params);

      return result;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      full_name: 'John Doe',
      age_in_months: 300,
    });

    await db.disconnect();
  });

  test('executes select with CASE expression aliases', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_case_aliases (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          age INTEGER,
          status VARCHAR(20)
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_case_aliases (name, age, status) VALUES 
         ('Minor User', 15, 'active'),
         ('Adult User', 25, 'active'),
         ('Senior User', 70, 'inactive')`
      );

      // Execute select with CASE expression aliases
      const fromStatement = transactionDb.from('test_case_aliases');
      const query = (
        fromStatement.select({
          name: 'name',
          age_group:
            "CASE WHEN age < 18 THEN 'minor' WHEN age >= 65 THEN 'senior' ELSE 'adult' END",
          is_active: "CASE WHEN status = 'active' THEN true ELSE false END",
        }) as any
      ).buildQuery();
      const params = (fromStatement as any).buildParameters();

      const result = await transactionDb.executeQuery<any>(query, params);

      return result;
    });

    expect(result.rowCount).toBe(3);
    expect(result.records[0]).toMatchObject({
      name: 'Minor User',
      age_group: 'minor',
      is_active: true,
    });
    expect(result.records[1]).toMatchObject({
      name: 'Adult User',
      age_group: 'adult',
      is_active: true,
    });
    expect(result.records[2]).toMatchObject({
      name: 'Senior User',
      age_group: 'senior',
      is_active: false,
    });

    await db.disconnect();
  });

  test('executes select with aggregate function aliases', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_aggregate_aliases (
          id SERIAL PRIMARY KEY,
          category VARCHAR(50) NOT NULL,
          amount DECIMAL(10,2) NOT NULL
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_aggregate_aliases (category, amount) VALUES 
         ('Electronics', 100.00),
         ('Electronics', 200.00),
         ('Books', 50.00),
         ('Books', 75.00)`
      );

      // Execute select with aggregate function aliases
      const fromStatement = transactionDb.from('test_aggregate_aliases');
      const query = (
        fromStatement.select({
          category: 'category',
          total_amount: 'SUM(amount)',
          avg_amount: 'AVG(amount)',
          item_count: 'COUNT(*)',
        }) as any
      ).buildQuery();
      const params = (fromStatement as any).buildParameters();

      // Need to add GROUP BY for aggregates
      const fullQuery = `${query} GROUP BY category ORDER BY category`;
      const result = await transactionDb.executeQuery<any>(fullQuery, params);

      return result;
    });

    expect(result.rowCount).toBe(2);
    expect(result.records[0]).toMatchObject({
      category: 'Books',
      total_amount: '125.00',
      item_count: '2',
    });
    expect(result.records[1]).toMatchObject({
      category: 'Electronics',
      total_amount: '300.00',
      item_count: '2',
    });

    await db.disconnect();
  });

  test('executes select with mixed regular and aliased columns', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_mixed_aliases (
          id SERIAL PRIMARY KEY,
          first_name VARCHAR(50) NOT NULL,
          last_name VARCHAR(50) NOT NULL,
          email VARCHAR(100) NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_mixed_aliases (first_name, last_name, email) 
         VALUES (:first_name, :last_name, :email)`,
        { first_name: 'Jane', last_name: 'Smith', email: 'jane@example.com' }
      );

      // Execute select with mixed columns (some aliased, some not)
      const fromStatement = transactionDb.from('test_mixed_aliases');
      const query = (
        fromStatement.select({
          user_id: 'id',
          full_name: "first_name || ' ' || last_name",
          contact_email: 'email',
          registration_date: 'created_at',
        }) as any
      ).buildQuery();
      const params = (fromStatement as any).buildParameters();

      const result = await transactionDb.executeQuery<any>(query, params);

      return result;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      user_id: expect.any(Number),
      full_name: 'Jane Smith',
      contact_email: 'jane@example.com',
    });
    expect(result.records[0].registration_date).toBeInstanceOf(Date);

    await db.disconnect();
  });

  test('executes select with JSON field aliases', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_json_aliases (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          settings JSONB
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_json_aliases (name, settings) 
         VALUES (:name, :settings)`,
        {
          name: 'JSON Test',
          settings: { theme: 'dark', language: 'en', notifications: true },
        }
      );

      // Execute select with JSON field extraction aliases
      const fromStatement = transactionDb.from('test_json_aliases');
      const query = (
        fromStatement.select({
          user_name: 'name',
          user_theme: "settings->>'theme'",
          user_language: "settings->>'language'",
          notifications_enabled: "settings->>'notifications'",
        }) as any
      ).buildQuery();
      const params = (fromStatement as any).buildParameters();

      const result = await transactionDb.executeQuery<any>(query, params);

      return result;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      user_name: 'JSON Test',
      user_theme: 'dark',
      user_language: 'en',
      notifications_enabled: 'true',
    });

    await db.disconnect();
  });
});

describe('FromStatement with byExpression', () => {
  test('builds correct query with simple WHERE clause using expression', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const { query } = await import('@blendsdk/expression');

    const fromStatement = db.from<TestUser>('users');
    const expression = query<TestUser>().where('age').equals(25).compile();
    fromStatement.select(['id', 'name', 'email']).byExpression(expression);

    const queryStr = (fromStatement as any).buildQuery();
    const params = (fromStatement as any).buildParameters();

    expect(queryStr).toContain('SELECT id, name, email FROM users');
    expect(queryStr).toContain('WHERE');
    expect(queryStr).toContain('age = :p1');
    expect(params).toHaveProperty('p1', 25);
  });

  test('builds correct query with AND expression', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const { query } = await import('@blendsdk/expression');

    const fromStatement = db.from<TestUser>('users');
    const expression = query<TestUser>()
      .where('active')
      .equals(true)
      .and('age')
      .greaterThan(18)
      .compile();
    fromStatement.select().byExpression(expression);

    const queryStr = (fromStatement as any).buildQuery();
    const params = (fromStatement as any).buildParameters();

    expect(queryStr).toContain('WHERE');
    expect(queryStr).toContain('AND');
    expect(params).toHaveProperty('p1', true);
    expect(params).toHaveProperty('p2', 18);
  });

  test('builds correct query with OR expression', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const { query } = await import('@blendsdk/expression');

    const fromStatement = db.from<TestUser>('users');
    const expression = query<TestUser>().where('age').equals(25).or('age').equals(30).compile();
    fromStatement.select(['name', 'email']).byExpression(expression);

    const queryStr = (fromStatement as any).buildQuery();
    const params = (fromStatement as any).buildParameters();

    expect(queryStr).toContain('WHERE');
    expect(queryStr).toContain('OR');
    expect(params).toHaveProperty('p1', 25);
    expect(params).toHaveProperty('p2', 30);
  });

  test('builds correct query with IN expression', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const { query } = await import('@blendsdk/expression');

    const fromStatement = db.from<TestUser>('users');
    const expression = query<TestUser>().where('age').in([25, 30, 35]).compile();
    fromStatement.select().byExpression(expression);

    const queryStr = (fromStatement as any).buildQuery();
    const params = (fromStatement as any).buildParameters();

    expect(queryStr).toContain('WHERE');
    expect(queryStr).toContain('IN');
    expect(params).toHaveProperty('p1', 25);
    expect(params).toHaveProperty('p2', 30);
    expect(params).toHaveProperty('p3', 35);
  });

  test('builds correct query with LIKE expression', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const { query } = await import('@blendsdk/expression');

    const fromStatement = db.from<TestUser>('users');
    const expression = query<TestUser>().where('name').like('%John%').compile();
    fromStatement.select().byExpression(expression);

    const queryStr = (fromStatement as any).buildQuery();
    const params = (fromStatement as any).buildParameters();

    expect(queryStr).toContain('WHERE');
    expect(queryStr).toContain('LIKE');
    expect(params).toHaveProperty('p1', '%John%');
  });

  test('builds correct query with BETWEEN expression', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const { query } = await import('@blendsdk/expression');

    const fromStatement = db.from<TestUser>('users');
    const expression = query<TestUser>().where('age').between(18, 65).compile();
    fromStatement.select().byExpression(expression);

    const queryStr = (fromStatement as any).buildQuery();
    const params = (fromStatement as any).buildParameters();

    expect(queryStr).toContain('WHERE');
    expect(queryStr).toContain('BETWEEN');
    expect(params).toHaveProperty('p1', 18);
    expect(params).toHaveProperty('p2', 65);
  });

  test('builds correct query with IS NULL expression', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const { query } = await import('@blendsdk/expression');

    const fromStatement = db.from<TestUser>('users');
    const expression = query<TestUser>().where('email').isNull().compile();
    fromStatement.select().byExpression(expression);

    const queryStr = (fromStatement as any).buildQuery();

    expect(queryStr).toContain('WHERE');
    expect(queryStr).toContain('email IS NULL');
  });

  test('builds correct query with IS NOT NULL expression', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const { query } = await import('@blendsdk/expression');

    const fromStatement = db.from<TestUser>('users');
    const expression = query<TestUser>().where('email').isNotNull().compile();
    fromStatement.select().byExpression(expression);

    const queryStr = (fromStatement as any).buildQuery();

    expect(queryStr).toContain('WHERE');
    expect(queryStr).toContain('email IS NOT NULL');
  });

  test('builds correct query with complex nested expression', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const { query } = await import('@blendsdk/expression');

    const fromStatement = db.from<TestUser>('users');
    const expression = query<TestUser>()
      .where('active')
      .equals(true)
      .and(q => q.where('age').greaterThan(18).or('age').lessThan(65))
      .compile();
    fromStatement.select().byExpression(expression);

    const queryStr = (fromStatement as any).buildQuery();
    const params = (fromStatement as any).buildParameters();

    expect(queryStr).toContain('WHERE');
    expect(queryStr).toContain('AND');
    expect(queryStr).toContain('OR');
    // Parameters can be in any order, just verify they exist
    expect(Object.values(params)).toContain(true);
    expect(Object.values(params)).toContain(18);
    expect(Object.values(params)).toContain(65);
  });

  test('allows chaining select and byExpression', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const { query } = await import('@blendsdk/expression');

    const fromStatement = db.from<TestUser>('users');
    const expression = query<TestUser>().where('active').equals(true).compile();
    const result = fromStatement.select(['id', 'name']).byExpression(expression);

    expect(result).toBe(fromStatement);
  });
});

describe('FromStatement with byExpression Integration', () => {
  test('executes select with simple WHERE clause', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const { query } = await import('@blendsdk/expression');

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_expression_users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) NOT NULL,
          age INTEGER,
          active BOOLEAN DEFAULT true
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_expression_users (name, email, age, active) VALUES 
         ('John Doe', 'john@example.com', 25, true),
         ('Jane Smith', 'jane@example.com', 30, true),
         ('Bob Johnson', 'bob@example.com', 25, false)`
      );

      // Execute select with expression
      const fromStatement = transactionDb.from<TestUser>('test_expression_users');
      const expression = query<TestUser>().where('age').equals(25).compile();
      fromStatement.select().byExpression(expression);

      const queryStr = (fromStatement as any).buildQuery();
      const params = (fromStatement as any).buildParameters();

      const result = await transactionDb.executeQuery<TestUser>(queryStr, params);

      return result;
    });

    expect(result.rowCount).toBe(2);
    expect(result.records[0].age).toBe(25);
    expect(result.records[1].age).toBe(25);

    await db.disconnect();
  });

  test('executes select with AND expression', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const { query } = await import('@blendsdk/expression');

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_and_expression (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          age INTEGER,
          active BOOLEAN DEFAULT true
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_and_expression (name, age, active) VALUES 
         ('Active 25', 25, true),
         ('Inactive 25', 25, false),
         ('Active 30', 30, true)`
      );

      // Execute select with AND expression
      const fromStatement = transactionDb.from('test_and_expression');
      const expression = query().where('age').equals(25).and('active').equals(true).compile();
      fromStatement.select().byExpression(expression);

      const queryStr = (fromStatement as any).buildQuery();
      const params = (fromStatement as any).buildParameters();

      const result = await transactionDb.executeQuery<any>(queryStr, params);

      return result;
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      name: 'Active 25',
      age: 25,
      active: true,
    });

    await db.disconnect();
  });

  test('executes select with OR expression', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const { query } = await import('@blendsdk/expression');

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_or_expression (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          age INTEGER
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_or_expression (name, age) VALUES 
         ('User 25', 25),
         ('User 30', 30),
         ('User 35', 35)`
      );

      // Execute select with OR expression
      const fromStatement = transactionDb.from('test_or_expression');
      const expression = query().where('age').equals(25).or('age').equals(35).compile();
      fromStatement.select().byExpression(expression);

      const queryStr = (fromStatement as any).buildQuery();
      const params = (fromStatement as any).buildParameters();

      const result = await transactionDb.executeQuery<any>(queryStr, params);

      return result;
    });

    expect(result.rowCount).toBe(2);
    expect(result.records[0].age).toBe(25);
    expect(result.records[1].age).toBe(35);

    await db.disconnect();
  });

  test('executes select with IN expression', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const { query } = await import('@blendsdk/expression');

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_in_expression (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          category VARCHAR(50)
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_in_expression (name, category) VALUES 
         ('Item A', 'electronics'),
         ('Item B', 'books'),
         ('Item C', 'clothing'),
         ('Item D', 'electronics')`
      );

      // Execute select with IN expression
      const fromStatement = transactionDb.from('test_in_expression');
      const expression = query().where('category').in(['electronics', 'books']).compile();
      fromStatement.select().byExpression(expression);

      const queryStr = (fromStatement as any).buildQuery();
      const params = (fromStatement as any).buildParameters();

      const result = await transactionDb.executeQuery<any>(queryStr, params);

      return result;
    });

    expect(result.rowCount).toBe(3);

    await db.disconnect();
  });

  test('executes select with LIKE expression', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const { query } = await import('@blendsdk/expression');

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_like_expression (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100)
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_like_expression (name, email) VALUES 
         ('John Doe', 'john@example.com'),
         ('Jane Doe', 'jane@example.com'),
         ('Bob Smith', 'bob@test.com')`
      );

      // Execute select with LIKE expression
      const fromStatement = transactionDb.from('test_like_expression');
      const expression = query().where('email').like('%example.com%').compile();
      const result = fromStatement.select().byExpression(expression).execute();

      return result;
    });

    expect(result?.rowCount).toBe(2);

    await db.disconnect();
  });

  test('executes select with BETWEEN expression', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const { query } = await import('@blendsdk/expression');

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_between_expression (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          age INTEGER
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_between_expression (name, age) VALUES 
         ('Teen', 15),
         ('Young Adult', 25),
         ('Adult', 45),
         ('Senior', 70)`
      );

      // Execute select with BETWEEN expression
      const fromStatement = transactionDb.from('test_between_expression');
      const expression = query().where('age').between(20, 50).compile();
      fromStatement.select().byExpression(expression);

      const queryStr = (fromStatement as any).buildQuery();
      const params = (fromStatement as any).buildParameters();

      const result = await transactionDb.executeQuery<any>(queryStr, params);

      return result;
    });

    expect(result.rowCount).toBe(2);
    expect(result.records[0].name).toBe('Young Adult');
    expect(result.records[1].name).toBe('Adult');

    await db.disconnect();
  });

  test('executes select with complex nested expression', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const { query } = await import('@blendsdk/expression');

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_complex_expression (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          age INTEGER,
          active BOOLEAN,
          premium BOOLEAN
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_complex_expression (name, age, active, premium) VALUES 
         ('Active Premium Adult', 30, true, true),
         ('Inactive Premium Adult', 30, false, true),
         ('Active Regular Adult', 30, true, false),
         ('Active Premium Teen', 15, true, true)`
      );

      // Execute select with complex expression: active AND (age > 18 OR premium)
      const fromStatement = transactionDb.from('test_complex_expression');
      const expression = query()
        .where('active')
        .equals(true)
        .and(q => q.where('age').greaterThan(18).or('premium').equals(true))
        .compile();
      fromStatement.select().byExpression(expression);

      const queryStr = (fromStatement as any).buildQuery();
      const params = (fromStatement as any).buildParameters();

      const result = await transactionDb.executeQuery<any>(queryStr, params);

      return result;
    });

    expect(result.rowCount).toBe(3);

    await db.disconnect();
  });

  test('executes select with expression and column aliases', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const { query } = await import('@blendsdk/expression');

    const result = await db.withTransaction(async transactionDb => {
      // Create test table within transaction
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_expression_aliases (
          id SERIAL PRIMARY KEY,
          first_name VARCHAR(50) NOT NULL,
          last_name VARCHAR(50) NOT NULL,
          age INTEGER
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        `INSERT INTO test_expression_aliases (first_name, last_name, age) VALUES 
         ('John', 'Doe', 25),
         ('Jane', 'Smith', 25),
         ('Bob', 'Johnson', 30)`
      );

      // Execute select with expression and aliases
      const fromStatement = transactionDb.from('test_expression_aliases');
      const expression = query().where('age').equals(25).compile();
      fromStatement
        .select({
          user_id: 'id',
          full_name: "first_name || ' ' || last_name",
          user_age: 'age',
        })
        .byExpression(expression);

      const queryStr = (fromStatement as any).buildQuery();
      const params = (fromStatement as any).buildParameters();

      const result = await transactionDb.executeQuery<any>(queryStr, params);

      return result;
    });

    expect(result.rowCount).toBe(2);
    expect(result.records[0]).toMatchObject({
      user_id: expect.any(Number),
      full_name: 'John Doe',
      user_age: 25,
    });

    await db.disconnect();
  });
});
