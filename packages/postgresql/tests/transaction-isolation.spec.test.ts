import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PostgreSQLDatabase } from '../src/database.js';
import { connectionConfig } from './params.js';

/**
 * Creates a promise plus its externally callable resolve and reject functions.
 *
 * The transaction tests use this to hold one transaction open while another
 * transaction or query runs, so the concurrent behaviour is deterministic.
 */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Creates a unique table name so parallel suites sharing `testdb` cannot collide. */
function uniqueTableName(label: string) {
  const random = Math.random().toString(36).slice(2, 10);
  return `tx_${label}_${Date.now()}_${random}`;
}

describe('PostgreSQL transaction isolation on a shared instance', () => {
  let db: PostgreSQLDatabase;

  beforeEach(() => {
    db = new PostgreSQLDatabase(connectionConfig);
  });

  afterEach(async () => {
    await db.disconnect();
  });

  test('runs concurrent transactions on different PostgreSQL sessions', async () => {
    const results = await Promise.all([
      db.withTransaction(async tx => {
        const { records } = await tx.executeQuery<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid'
        );
        await tx.executeQuery('SELECT pg_sleep(0.2)');
        return records[0]?.pid;
      }),
      db.withTransaction(async tx => {
        const { records } = await tx.executeQuery<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid'
        );
        return records[0]?.pid;
      }),
    ]);

    expect(results[0]).toBeTypeOf('number');
    expect(results[1]).toBeTypeOf('number');
    expect(results[0]).not.toBe(results[1]);
  });

  test('keeps a committed transaction when a concurrent transaction rolls back', async () => {
    const table = uniqueTableName('rollback');
    await db.executeQuery(`CREATE TABLE "${table}" (label text NOT NULL)`);

    const firstInserted = deferred();
    const releaseFirst = deferred();

    try {
      const first = db.withTransaction(async tx => {
        await tx.executeQuery(`INSERT INTO "${table}" (label) VALUES ('first')`);
        firstInserted.resolve();
        await releaseFirst.promise;
        throw new Error('rollback the first transaction');
      });

      await firstInserted.promise;

      await db.withTransaction(async tx => {
        await tx.executeQuery(`INSERT INTO "${table}" (label) VALUES ('second')`);
      });

      releaseFirst.resolve();
      await expect(first).rejects.toThrow('rollback the first transaction');

      const { records } = await db.executeQuery<{ label: string }>(
        `SELECT label FROM "${table}" ORDER BY label`
      );
      expect(records.map(record => record.label)).toEqual(['second']);
    } finally {
      releaseFirst.resolve();
      await db.executeQuery(`DROP TABLE IF EXISTS "${table}"`);
    }
  });

  test('does not join an active transaction from an unrelated query', async () => {
    const transactionStarted = deferred();
    const releaseTransaction = deferred();
    let transactionPid: number | undefined;

    const transaction = db.withTransaction(async tx => {
      const { records } = await tx.executeQuery<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      transactionPid = records[0]?.pid;
      transactionStarted.resolve();
      await releaseTransaction.promise;
    });

    try {
      await transactionStarted.promise;

      const { records } = await db.executeQuery<{ pid: number }>('SELECT pg_backend_pid() AS pid');

      expect(records[0]?.pid).toBeTypeOf('number');
      expect(records[0]?.pid).not.toBe(transactionPid);
    } finally {
      releaseTransaction.resolve();
      await transaction;
    }
  });

  test('rejects a nested transaction with a clear error', async () => {
    await db.withTransaction(async () => {
      await expect(
        db.withTransaction(async () => {
          return 'nested';
        })
      ).rejects.toThrow(/nested transaction/iu);
    });
  });

  test('applies the requested isolation level', async () => {
    const isolation = await db.withTransaction(
      async tx => {
        const { records } = await tx.executeQuery<{ transaction_isolation: string }>(
          'SHOW transaction_isolation'
        );
        return records[0]?.transaction_isolation;
      },
      { isolation: 'serializable' }
    );

    expect(isolation).toBe('serializable');
  });
});
