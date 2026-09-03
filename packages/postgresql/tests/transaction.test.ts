import { describe, expect, test } from 'vitest';
import { PostgreSQLDatabase } from '../src/database.js';
import { connectionConfig } from './params.js';

describe('withTransaction', () => {
  test('commits successful transaction with data persistence', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    // Test that data persists after successful transaction
    const result = await db.withTransaction(async (transactionDb) => {
      // Create a temporary table for testing
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_users (name, email) VALUES (:name, :email)',
        { name: 'John Doe', email: 'john@example.com' }
      );

      // Return some data to verify transaction result
      const { records } = await transactionDb.executeQuery<{ id: number; name: string; email: string }>(
        'SELECT * FROM test_users WHERE email = :email',
        { email: 'john@example.com' }
      );

      return records[0];
    });

    // Verify the transaction returned the expected result
    expect(result).toEqual({
      id: expect.any(Number),
      name: 'John Doe',
      email: 'john@example.com'
    });

    // Verify data still exists after transaction (using a new query outside transaction)
    const { records, rowCount } = await db.executeQuery<{ name: string; email: string }>(
      'SELECT name, email FROM test_users WHERE email = :email',
      { email: 'john@example.com' }
    );

    expect(rowCount).toBe(1);
    expect(records[0]).toEqual({
      name: 'John Doe',
      email: 'john@example.com'
    });

    await db.disconnect();
  });

  test('rolls back transaction on error', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    // First, create the temp table outside transaction so we can verify rollback
    await db.executeQuery(`
      CREATE TEMP TABLE test_products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        price DECIMAL(10,2) NOT NULL
      )
    `);

    // Insert initial data
    await db.executeQuery(
      'INSERT INTO test_products (name, price) VALUES (:name, :price)',
      { name: 'Initial Product', price: 10.00 }
    );

    // Verify initial state
    const { rowCount: initialCount } = await db.executeQuery('SELECT * FROM test_products');
    expect(initialCount).toBe(1);

    // Attempt transaction that should fail and rollback
    await expect(async () => {
      await db.withTransaction(async (transactionDb) => {
        // Insert data that should be rolled back
        await transactionDb.executeQuery(
          'INSERT INTO test_products (name, price) VALUES (:name, :price)',
          { name: 'Should Be Rolled Back', price: 20.00 }
        );

        // Verify data was inserted within transaction
        const { rowCount } = await transactionDb.executeQuery('SELECT * FROM test_products');
        expect(rowCount).toBe(2);

        // Throw error to trigger rollback
        throw new Error('Intentional error to test rollback');
      });
    }).rejects.toThrow('Intentional error to test rollback');

    // Verify rollback - should only have initial data
    const { records, rowCount } = await db.executeQuery<{ name: string; price: number }>(
      'SELECT name, price FROM test_products ORDER BY id'
    );

    expect(rowCount).toBe(1);
    expect(records[0]).toEqual({
      name: 'Initial Product',
      price: '10.00' // PostgreSQL returns DECIMAL as string
    });

    await db.disconnect();
  });

  test('handles multiple operations in single transaction', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const results = await db.withTransaction(async (transactionDb) => {
      // Create temp table
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_orders (
          id SERIAL PRIMARY KEY,
          customer_name VARCHAR(100) NOT NULL,
          total DECIMAL(10,2) NOT NULL,
          status VARCHAR(20) DEFAULT 'pending'
        )
      `);

      // Insert multiple records
      await transactionDb.executeQuery(
        'INSERT INTO test_orders (customer_name, total) VALUES (:name1, :total1)',
        { name1: 'Alice', total1: 100.50 }
      );

      await transactionDb.executeQuery(
        'INSERT INTO test_orders (customer_name, total) VALUES (:name2, :total2)',
        { name2: 'Bob', total2: 75.25 }
      );

      // Update a record
      await transactionDb.executeQuery(
        'UPDATE test_orders SET status = :status WHERE customer_name = :name',
        { status: 'confirmed', name: 'Alice' }
      );

      // Return summary data
      const { records } = await transactionDb.executeQuery<{ 
        count: number; 
        total_sum: number; 
        confirmed_count: number 
      }>(`
        SELECT 
          COUNT(*) as count,
          SUM(total) as total_sum,
          COUNT(*) FILTER (WHERE status = 'confirmed') as confirmed_count
        FROM test_orders
      `);

      return records[0];
    });

    // Verify all operations completed successfully
    expect(results).toEqual({
      count: '2', // PostgreSQL COUNT returns string
      total_sum: '175.75',
      confirmed_count: '1'
    });

    await db.disconnect();
  });

  test('handles database constraint violations with rollback', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    // Create table with unique constraint
    await db.executeQuery(`
      CREATE TEMP TABLE test_emails (
        id SERIAL PRIMARY KEY,
        email VARCHAR(100) UNIQUE NOT NULL
      )
    `);

    // Insert initial record
    await db.executeQuery(
      'INSERT INTO test_emails (email) VALUES (:email)',
      { email: 'unique@example.com' }
    );

    // Attempt transaction with constraint violation
    await expect(async () => {
      await db.withTransaction(async (transactionDb) => {
        // This should succeed
        await transactionDb.executeQuery(
          'INSERT INTO test_emails (email) VALUES (:email)',
          { email: 'another@example.com' }
        );

        // This should fail due to unique constraint
        await transactionDb.executeQuery(
          'INSERT INTO test_emails (email) VALUES (:email)',
          { email: 'unique@example.com' }
        );
      });
    }).rejects.toThrow();

    // Verify rollback - should only have original record
    const { records, rowCount } = await db.executeQuery<{ email: string }>(
      'SELECT email FROM test_emails ORDER BY id'
    );

    expect(rowCount).toBe(1);
    expect(records[0]).toEqual({ email: 'unique@example.com' });

    await db.disconnect();
  });

  test('properly manages connection lifecycle', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    // Verify connection works before transaction
    const { rowCount: beforeCount } = await db.executeQuery('SELECT 1');
    expect(beforeCount).toBe(1);

    // Run transaction
    await db.withTransaction(async (transactionDb) => {
      await transactionDb.executeQuery('SELECT 2');
    });

    // Verify connection still works after transaction
    const { records, rowCount } = await db.executeQuery<{ result: number }>('SELECT 3 as result');
    expect(rowCount).toBe(1);
    expect(records[0]).toEqual({ result: 3 });

    await db.disconnect();
  });

  test('handles empty transaction', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    // Transaction with no operations should still work
    const result = await db.withTransaction(async () => {
      return 'empty transaction completed';
    });

    expect(result).toBe('empty transaction completed');

    await db.disconnect();
  });
});
