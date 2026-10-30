import { afterEach, describe, expect, test, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { PostgreSQLDatabase, TransactionIsolation, TransactionOptions } from '../src/database.js';
import { connectionConfig } from './params.js';

/**
 * Counts acquired and released clients without changing their behaviour.
 *
 * A spy on `release()` keeps the real pool bookkeeping intact while making the
 * "released exactly once" contract observable from the test. Per-client counts
 * catch a double release that a global total would hide.
 */
class CountingDatabase extends PostgreSQLDatabase {
  connects = 0;
  releases = 0;
  doubleReleases = 0;
  readonly acquisitions: Array<{ id: number; released: boolean }> = [];
  private readonly currentAcquisition = new WeakMap<
    PoolClient,
    { id: number; released: boolean }
  >();

  override connect(): Promise<PoolClient> {
    this.connects += 1;
    const acquisition = { id: this.connects, released: false };
    this.acquisitions.push(acquisition);

    return super.connect().then(client => {
      // pg-pool replaces `client.release` on every acquisition, so re-install the
      // spy each time and resolve the current acquisition when the release happens.
      this.currentAcquisition.set(client, acquisition);
      const release = client.release.bind(client);
      vi.spyOn(client, 'release').mockImplementation((error?: Error | boolean) => {
        const current = this.currentAcquisition.get(client);
        if (current) {
          if (current.released) {
            this.doubleReleases += 1;
          } else {
            current.released = true;
            this.releases += 1;
          }
        }
        release(error);
      });
      return client;
    });
  }
}

/**
 * Minimal driver double for failure paths that cannot be produced with a healthy server.
 *
 * `connect()` is the only real dependency the transaction method needs from the adapter, so a
 * fake client keeps the test deterministic and focused on the release decision.
 */
class FailingClientDatabase extends PostgreSQLDatabase {
  readonly releases: Array<boolean | Error | undefined> = [];

  constructor(private readonly failure: 'begin' | 'rollback' | 'commit' | 'commit-rollback') {
    super(connectionConfig);
  }

  override connect(): Promise<PoolClient> {
    const client = {
      query: vi.fn(async (text: string) => {
        if (text === 'BEGIN' && this.failure === 'begin') {
          throw new Error('BEGIN failed');
        }
        if (
          text === 'COMMIT' &&
          (this.failure === 'commit' || this.failure === 'commit-rollback')
        ) {
          throw new Error('COMMIT failed');
        }
        if (
          text === 'ROLLBACK' &&
          (this.failure === 'rollback' || this.failure === 'commit-rollback')
        ) {
          throw new Error('ROLLBACK failed');
        }
        return { rows: [], rowCount: 0, fields: [] };
      }),
      release: vi.fn((destroy?: boolean | Error) => {
        this.releases.push(destroy);
      }),
    } as unknown as PoolClient;

    return Promise.resolve(client);
  }
}

/** Exposes the deprecated protected accessor for a compatibility test. */
class AccessorDatabase extends CountingDatabase {
  activeTransactionClient(): PoolClient | null {
    return this.transactionClient;
  }
}

describe('PostgreSQL transaction implementation details', () => {
  let db: PostgreSQLDatabase;

  afterEach(async () => {
    if (db) {
      await db.disconnect();
    }
  });

  test('acquires and releases one client per query and transaction', async () => {
    const counting = new CountingDatabase(connectionConfig);
    db = counting;

    await counting.executeQuery('SELECT 1');
    await counting.withTransaction(async tx => {
      await tx.executeQuery('SELECT 2');
    });
    await expect(
      counting.withTransaction(async () => {
        throw new Error('roll back');
      })
    ).rejects.toThrow('roll back');

    expect(counting.connects).toBe(3);
    expect(counting.releases).toBe(3);
    expect(counting.doubleReleases).toBe(0);
    expect(counting.acquisitions.every(acquisition => acquisition.released)).toBe(true);
  });

  test('releases each concurrent transaction client exactly once', async () => {
    const counting = new CountingDatabase(connectionConfig);
    db = counting;

    await Promise.all([
      counting.withTransaction(async tx => {
        await tx.executeQuery('SELECT pg_sleep(0.02)');
      }),
      counting.withTransaction(async tx => {
        await tx.executeQuery('SELECT pg_sleep(0.02)');
      }),
    ]);

    expect(counting.connects).toBe(2);
    expect(counting.doubleReleases).toBe(0);
    expect(counting.acquisitions.every(acquisition => acquisition.released)).toBe(true);
  });

  test('rejects invalid transaction options before acquiring a client', async () => {
    const counting = new CountingDatabase(connectionConfig);
    db = counting;

    await expect(
      counting.withTransaction(
        async () => 'never runs',
        'serializable' as unknown as TransactionOptions
      )
    ).rejects.toThrow('Transaction options must be an object.');
    await expect(
      counting.withTransaction(async () => 'never runs', [] as unknown as TransactionOptions)
    ).rejects.toThrow('Transaction options must be an object.');
    await expect(
      counting.withTransaction(async () => 'never runs', {
        isolation: 'read uncommitted' as TransactionIsolation,
      })
    ).rejects.toThrow('Unsupported transaction isolation level');
    await expect(
      counting.withTransaction(async () => 'never runs', {
        isolation: "serializable'; DROP TABLE customer; --" as TransactionIsolation,
      })
    ).rejects.toThrow('Unsupported transaction isolation level');

    expect(counting.connects).toBe(0);
    expect(counting.releases).toBe(0);
  });

  test('accepts a null-prototype options object', async () => {
    const counting = new CountingDatabase(connectionConfig);
    db = counting;
    const options = Object.assign(Object.create(null), {
      isolation: 'serializable',
    }) as TransactionOptions;

    const isolation = await counting.withTransaction(async tx => {
      const { records } = await tx.executeQuery<{ transaction_isolation: string }>(
        'SHOW transaction_isolation'
      );
      return records[0]?.transaction_isolation;
    }, options);

    expect(isolation).toBe('serializable');
  });

  test('does not leak a client when the transaction callback fails', async () => {
    const counting = new CountingDatabase(connectionConfig);
    db = counting;

    await expect(
      counting.withTransaction(async tx => {
        await tx.executeQuery('SELECT 1');
        throw new Error('callback failed');
      })
    ).rejects.toThrow('callback failed');

    // The next query must still get a usable client from the pool.
    const { rowCount } = await counting.executeQuery('SELECT 1');
    expect(rowCount).toBe(1);
    expect(counting.connects).toBe(2);
    expect(counting.releases).toBe(2);
  });

  test('destroys the client when BEGIN fails', async () => {
    const failing = new FailingClientDatabase('begin');
    db = failing;

    await expect(failing.withTransaction(async () => 'never runs')).rejects.toThrow('BEGIN failed');
    expect(failing.releases).toEqual([true]);
  });

  test('destroys the client when ROLLBACK fails', async () => {
    const failing = new FailingClientDatabase('rollback');
    db = failing;
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        failing.withTransaction(async () => {
          throw new Error('callback failed');
        })
      ).rejects.toThrow('callback failed');
      expect(failing.releases).toEqual([true]);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  test('rejects a detached task that outlives the transaction', async () => {
    const counting = new CountingDatabase(connectionConfig);
    db = counting;
    let releaseDetached!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseDetached = resolve;
    });
    let detached!: Promise<unknown>;

    await counting.withTransaction(async tx => {
      detached = gate.then(() => tx.executeQuery('SELECT 1'));
    });
    releaseDetached();

    await expect(detached).rejects.toThrow(
      'Cannot execute a query after the transaction has completed'
    );
  });

  test('rejects a detached transaction start without acquiring another client', async () => {
    const counting = new CountingDatabase(connectionConfig);
    db = counting;
    let releaseDetached!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseDetached = resolve;
    });
    let detached!: Promise<unknown>;

    await counting.withTransaction(async tx => {
      detached = gate.then(() => tx.withTransaction(async () => 'nested'));
    });
    releaseDetached();

    await expect(detached).rejects.toThrow('completed transaction context');
    expect(counting.connects).toBe(1);
  });

  test('exposes the deprecated transaction client only while the transaction is active', async () => {
    const accessor = new AccessorDatabase(connectionConfig);
    db = accessor;
    let inside: PoolClient | null = null;
    let releaseDetached!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseDetached = resolve;
    });
    let detached!: Promise<void>;

    await accessor.withTransaction(async () => {
      inside = accessor.activeTransactionClient();
      detached = gate.then(() => {
        // The detached continuation inherits the closed transaction context.
        expect(accessor.activeTransactionClient()).toBeNull();
      });
    });

    expect(inside).not.toBeNull();
    expect(accessor.activeTransactionClient()).toBeNull();

    releaseDetached();
    await detached;
  });

  test('releases normally when COMMIT fails but ROLLBACK succeeds', async () => {
    const failing = new FailingClientDatabase('commit');
    db = failing;

    await expect(failing.withTransaction(async () => 'value')).rejects.toThrow('COMMIT failed');
    expect(failing.releases).toEqual([false]);
  });

  test('destroys the client when COMMIT and ROLLBACK both fail', async () => {
    const failing = new FailingClientDatabase('commit-rollback');
    db = failing;
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(failing.withTransaction(async () => 'value')).rejects.toThrow('COMMIT failed');
      expect(failing.releases).toEqual([true]);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
