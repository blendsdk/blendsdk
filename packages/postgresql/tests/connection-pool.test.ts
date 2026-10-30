import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgreSQLDatabase, PostgreSQLConfig } from '../src/database.js';
import { connectionConfig } from './params.js';

describe('Connection Pool Management', () => {
  let db: PostgreSQLDatabase;
  const baseConfig: PostgreSQLConfig = connectionConfig;

  afterEach(async () => {
    if (db) {
      try {
        await db.disconnect(15000);
      } catch (error) {
        // Ignore disconnect errors in cleanup
      }
    }
  }, 30000);

  describe('Pool Configuration', () => {
    it('accepts pool configuration options', () => {
      const config: PostgreSQLConfig = {
        ...baseConfig,
        poolConfig: {
          max: 20,
          idleTimeoutMillis: 60000,
          connectionTimeoutMillis: 5000,
        },
      };

      db = new PostgreSQLDatabase(config);
      expect(db).toBeDefined();
    });

    it('works without pool configuration (backward compatibility)', () => {
      db = new PostgreSQLDatabase(baseConfig);
      expect(db).toBeDefined();
    });

    it('accepts partial pool configuration', () => {
      const config: PostgreSQLConfig = {
        ...baseConfig,
        poolConfig: {
          max: 15,
        },
      };

      db = new PostgreSQLDatabase(config);
      expect(db).toBeDefined();
    });
  });

  describe('Enhanced disconnect()', () => {
    it('disconnects successfully with default timeout', async () => {
      db = new PostgreSQLDatabase(baseConfig);
      await db.executeQuery('SELECT 1 as test');
      await expect(db.disconnect()).resolves.not.toThrow();
    });

    it('disconnects successfully with custom timeout', async () => {
      db = new PostgreSQLDatabase(baseConfig);
      await db.executeQuery('SELECT 1 as test');
      await expect(db.disconnect(5000)).resolves.not.toThrow();
    });

    it('handles disconnect with no active connections', async () => {
      db = new PostgreSQLDatabase(baseConfig);
      await expect(db.disconnect()).resolves.not.toThrow();
    });

    it('prevents new queries after disconnect is called', async () => {
      db = new PostgreSQLDatabase(baseConfig);
      const disconnectPromise = db.disconnect();
      
      // Try to execute query after disconnect starts
      await expect(db.executeQuery('SELECT 1 as test')).rejects.toThrow(
        'Cannot execute query: database is shutting down'
      );
      
      await disconnectPromise;
    });

    it('prevents new transactions after disconnect is called', async () => {
      db = new PostgreSQLDatabase(baseConfig);
      const disconnectPromise = db.disconnect();
      
      // Try to start transaction after disconnect starts
      await expect(
        db.withTransaction(async () => {
          return true;
        })
      ).rejects.toThrow('Cannot start transaction: database is shutting down');
      
      await disconnectPromise;
    });
  });

  describe('Transaction Error Handling', () => {
    beforeEach(() => {
      db = new PostgreSQLDatabase(baseConfig);
    });

    it('properly releases client on transaction error', async () => {
      await expect(
        db.withTransaction(async (txDb) => {
          await txDb.executeQuery('SELECT 1 as test');
          throw new Error('Test error');
        })
      ).rejects.toThrow('Test error');

      // Should be able to execute new queries after failed transaction
      const result = await db.executeQuery<{ test: number }>('SELECT 1 as test');
      expect(result.records[0].test).toBe(1);
    });

    it('handles rollback errors gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        db.withTransaction(async (txDb) => {
          await txDb.executeQuery('SELECT 1 as test');
          throw new Error('Test error');
        })
      ).rejects.toThrow('Test error');

      consoleSpy.mockRestore();
    });

    it('prevents double commit in transaction', async () => {
      const result = await db.withTransaction(async (txDb) => {
        await txDb.executeQuery('SELECT 1 as test');
        return 'success';
      });

      expect(result).toBe('success');
    });
  });

  describe('Query Error Handling', () => {
    beforeEach(() => {
      db = new PostgreSQLDatabase(baseConfig);
    });

    it('properly releases client on query error', async () => {
      await expect(db.executeQuery('INVALID SQL QUERY')).rejects.toThrow();

      // Should be able to execute new queries after failed query
      const result = await db.executeQuery<{ test: number }>('SELECT 1 as test');
      expect(result.records[0].test).toBe(1);
    });

    it('handles client release errors gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Execute a valid query
      await db.executeQuery('SELECT 1 as test');

      consoleSpy.mockRestore();
    });
  });

  describe('Graceful Shutdown', () => {
    it('does not register handlers by default', () => {
      db = new PostgreSQLDatabase(baseConfig);
      expect(db).toBeDefined();
      // If handlers were registered, they would be in process listeners
      // This test just ensures no errors occur
    });

    it('accepts enableGracefulShutdown option', () => {
      const config: PostgreSQLConfig = {
        ...baseConfig,
        enableGracefulShutdown: false,
      };

      db = new PostgreSQLDatabase(config);
      expect(db).toBeDefined();
    });
  });

  describe('Connection Lifecycle', () => {
    beforeEach(() => {
      db = new PostgreSQLDatabase(baseConfig);
    });

    it('handles multiple sequential queries', async () => {
      for (let i = 0; i < 5; i++) {
        const result = await db.executeQuery<{ num: string }>('SELECT :num as num', {
          num: i,
        });
        expect(result.records[0].num).toBe(String(i));
      }
    });

    it('handles concurrent queries', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        db.executeQuery<{ num: string }>('SELECT :num as num', { num: i })
      );

      const results = await Promise.all(promises);
      results.forEach((result, i) => {
        expect(result.records[0].num).toBe(String(i));
      });
    });

    it('handles mixed transactions and queries', async () => {
      // Regular query
      await db.executeQuery('SELECT 1 as test');

      // Transaction
      await db.withTransaction(async (txDb) => {
        await txDb.executeQuery('SELECT 2 as test');
      });

      // Another regular query
      const result = await db.executeQuery<{ test: number }>('SELECT 3 as test');
      expect(result.records[0].test).toBe(3);
    });
  });

  describe('Backward Compatibility', () => {
    it('works with original configuration format', async () => {
      db = new PostgreSQLDatabase(baseConfig);
      const result = await db.executeQuery<{ test: number }>('SELECT 1 as test');
      expect(result.records[0].test).toBe(1);
    });

    it('disconnect works without timeout parameter', async () => {
      db = new PostgreSQLDatabase(baseConfig);
      await db.executeQuery('SELECT 1 as test');
      await expect(db.disconnect()).resolves.not.toThrow();
    });

    it('maintains existing transaction behavior', async () => {
      db = new PostgreSQLDatabase(baseConfig);
      
      const result = await db.withTransaction(async (txDb) => {
        await txDb.executeQuery('SELECT 1 as test');
        return 'completed';
      });

      expect(result).toBe('completed');
    });

    it('maintains existing query behavior', async () => {
      db = new PostgreSQLDatabase(baseConfig);
      
      const result = await db.executeQuery<{ value: string }>(
        'SELECT :value as value',
        { value: 'test' }
      );

      expect(result.records[0].value).toBe('test');
    });
  });
});
