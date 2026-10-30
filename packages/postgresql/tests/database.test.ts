import { describe, expect, test } from 'vitest';
import { PostgreSQLDatabase } from '../src/database.js';
import { connectionConfig } from './params.js';

describe('connection', () => {
  test('can pass parameters', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const { records, rowCount } = await db.executeQuery<{ name: string; time: Date }>(
      'SELECT :name as name, now() as time',
      { name: 'john' }
    );
    expect(rowCount).toBe(1);
    expect(records[0]).toEqual({ name: 'john', time: records[0].time });

    await db.disconnect();
  });

  test('can connect to database', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const { records, rowCount } = await db.executeQuery('SELECT 1', []);
    expect(rowCount).toBe(1);
    expect(records[0]).toEqual({ '?column?': 1 });

    await db.disconnect();
  });

  test('handles multiple connections properly', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    // Execute multiple queries sequentially to test connection handling
    for (let i = 0; i < 3; i++) {
      const result = await db.executeQuery<{ result: string }>('SELECT :value as result', {
        value: i,
      });
      expect(result.rowCount).toBe(1);
      expect(result.records[0]).toEqual({ result: i.toString() });
    }

    await db.disconnect();
  });

  test('handles connection errors gracefully', async () => {
    const invalidConfig = {
      ...connectionConfig,
      host: 'invalid-host',
      port: 9999,
    };
    const db = new PostgreSQLDatabase(invalidConfig);

    await expect(async () => {
      await db.executeQuery('SELECT 1', {});
    }).rejects.toThrow();

    // Should not throw when disconnecting even if connection failed
    await expect(db.disconnect()).resolves.not.toThrow();
  });
});

describe('executeQuery', () => {
  test('returns correct field information', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.executeQuery<{ id: number; name: string; active: boolean }>(
      'SELECT 1 as id, :name as name, true as active',
      { name: 'test' }
    );

    expect(result.fields).toBeDefined();
    expect(result.fields).toHaveLength(3);
    expect(result.fields.map(f => f.name)).toEqual(['id', 'name', 'active']);

    await db.disconnect();
  });

  test('handles empty result sets', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    // Create temp table for testing
    await db.executeQuery(
      `
      CREATE TEMP TABLE empty_test (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100)
      )
    `,
      {}
    );

    const result = await db.executeQuery<{ id: number; name: string }>(
      'SELECT * FROM empty_test WHERE id = :id',
      { id: 999 }
    );

    expect(result.records).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(result.fields).toEqual([]);

    await db.disconnect();
  });

  test('handles complex data types', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const testData = {
      text_val: 'hello world',
      int_val: 42,
      float_val: 3.14,
      bool_val: true,
      date_val: new Date('2023-01-01'),
      json_val: { key: 'value', nested: { count: 123 } },
    };

    const result = await db.executeQuery<typeof testData>(
      `SELECT 
        :text_val::text as text_val,
        :int_val::integer as int_val,
        :float_val::numeric as float_val,
        :bool_val::boolean as bool_val,
        :date_val::timestamp as date_val,
        :json_val::jsonb as json_val`,
      testData
    );

    expect(result.rowCount).toBe(1);
    const record = result.records[0];

    expect(record.text_val).toBe(testData.text_val);
    expect(record.int_val).toBe(testData.int_val);
    expect(parseFloat(record.float_val as unknown as string)).toBe(testData.float_val);
    expect(record.bool_val).toBe(testData.bool_val);
    expect(new Date(record.date_val as unknown as string)).toEqual(testData.date_val);
    expect(record.json_val).toEqual(testData.json_val);

    await db.disconnect();
  });

  test('handles SQL injection prevention', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    // Create temp table
    await db.executeQuery(
      `
      CREATE TEMP TABLE injection_test (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100)
      )
    `,
      {}
    );

    // Insert test data
    await db.executeQuery('INSERT INTO injection_test (name) VALUES (:name)', {
      name: 'legitimate_user',
    });

    // Attempt SQL injection - should be safely parameterized
    const maliciousInput = "'; DROP TABLE injection_test; --";

    const result = await db.executeQuery<{ id: number; name: string }>(
      'SELECT * FROM injection_test WHERE name = :name',
      { name: maliciousInput }
    );

    // Should return no results (injection prevented)
    expect(result.records).toEqual([]);
    expect(result.rowCount).toBe(0);

    // Verify table still exists by querying legitimate data
    const legitResult = await db.executeQuery<{ id: number; name: string }>(
      'SELECT * FROM injection_test WHERE name = :name',
      { name: 'legitimate_user' }
    );

    expect(legitResult.rowCount).toBe(1);
    expect(legitResult.records[0].name).toBe('legitimate_user');

    await db.disconnect();
  });
});

describe('implemented methods', () => {
  test('insert method returns PostgreSQLInsertStatement instance', () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const insertStatement = db.insert('test_table');

    expect(insertStatement).toBeDefined();
    expect(insertStatement.constructor.name).toBe('PostgreSQLInsertStatement');
  });

  test('update method returns PostgreSQLUpdateStatement instance', () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const updateStatement = db.update('test_table');

    expect(updateStatement).toBeDefined();
    expect(updateStatement.constructor.name).toBe('PostgreSQLUpdateStatement');
  });

  test('delete method returns PostgreSQLDeleteStatement instance', () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const deleteStatement = db.delete('test_table');

    expect(deleteStatement).toBeDefined();
    expect(deleteStatement.constructor.name).toBe('PostgreSQLDeleteStatement');
  });
});

describe('selectAll method', () => {
  test('selectAll returns a FromStatement for the given table', () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = db.selectAll('test_table');

    // selectAll is now implemented in the base Database class
    // and returns a FromStatement configured to select all columns
    expect(result).toBeDefined();
    expect(result.constructor.name).toBe('FromStatement');
  });
});

describe('configuration', () => {
  test('accepts valid configuration', () => {
    const config = {
      host: 'localhost',
      port: 5432,
      database: 'testdb',
      user: 'testuser',
      pass: 'testpass',
    };

    expect(() => {
      new PostgreSQLDatabase(config);
    }).not.toThrow();
  });

  test('handles port as string', () => {
    const config = {
      ...connectionConfig,
      port: '5400', // string instead of number
    };

    expect(() => {
      new PostgreSQLDatabase(config);
    }).not.toThrow();
  });

  test('handles missing optional port', () => {
    const config = {
      host: 'localhost',
      database: 'testdb',
      user: 'testuser',
      pass: 'testpass',
      // port is optional
    };

    expect(() => {
      new PostgreSQLDatabase(config);
    }).not.toThrow();
  });
});
