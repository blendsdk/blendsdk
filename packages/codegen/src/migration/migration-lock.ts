import type { PoolClient } from 'pg';
import { MigrationError } from './errors.js';

const LOCK_NAMESPACE = 'blendsdk:migrations:v1';
const APPLICATION_NAME = 'blendsdk-migrations';
const RETRY_INTERVAL_MS = 20;

/** Function that acquires one dedicated PostgreSQL session. */
export type MigrationClientFactory = () => Promise<PoolClient>;

/** Dedicated session that owns the database-scoped migration advisory lock. */
export interface MigrationLockHandle {
  /** Raw client retained for the complete migration command. */
  readonly client: PoolClient;
  /**
   * Releases the advisory lock and client exactly once.
   *
   * A broken session is destroyed instead of returned to its pool; PostgreSQL then releases any
   * remaining session lock when the connection closes.
   */
  readonly release: (broken?: boolean) => Promise<void>;
}

/**
 * Acquires the fixed database-scoped advisory lock before its deadline.
 *
 * @param connect - Factory for one dedicated raw PostgreSQL client.
 * @param timeoutMs - Validated positive lock deadline in milliseconds.
 * @param signal - Optional caller cancellation signal.
 * @returns A same-session handle that must be released in a `finally` block.
 * @throws {MigrationError} For cancellation, lock timeout, or a database/session failure.
 */
export async function acquireMigrationLock(
  connect: MigrationClientFactory,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<MigrationLockHandle> {
  validateTimeout(timeoutMs);
  throwIfAborted(signal);
  let client: PoolClient | undefined;
  try {
    client = await connect();
    await client.query(`SELECT set_config('application_name', $1, false)`, [APPLICATION_NAME]);
  } catch {
    client?.release(true);
    throw databaseError('Could not acquire a PostgreSQL migration session.');
  }

  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      throwIfAborted(signal);
      if (await tryLock(client)) return createHandle(client);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new MigrationError({
          kind: 'LOCKED',
          exitCode: 1,
          message: 'The PostgreSQL migration lock is held by another session.',
        });
      }
      await abortableDelay(Math.min(RETRY_INTERVAL_MS, remaining), signal);
    }
  } catch (error) {
    if (error instanceof MigrationError) {
      client.release();
      throw error;
    }
    client.release(true);
    throw databaseError('Could not acquire the PostgreSQL migration lock.');
  }
}

/**
 * Observes whether another session owns the migration lock without retaining it.
 *
 * @param client - Dedicated observation session.
 * @returns `true` when the lock is currently held elsewhere.
 */
export async function isMigrationLockHeld(client: PoolClient): Promise<boolean> {
  const acquired = await tryLock(client);
  if (!acquired) return true;
  const unlocked = await unlock(client);
  if (!unlocked) throw databaseError('Could not release the observed migration lock.');
  return false;
}

/**
 * Applies validated PostgreSQL lock and statement deadlines to the dedicated session.
 *
 * `set_config` accepts values as parameters, so timeout text never becomes executable SQL.
 */
export async function applyMigrationTimeouts(
  client: PoolClient,
  lockTimeoutMs: number,
  statementTimeoutMs: number
): Promise<void> {
  validateTimeout(lockTimeoutMs);
  validateTimeout(statementTimeoutMs);
  await client.query(`SELECT set_config('lock_timeout', $1, false)`, [`${lockTimeoutMs}ms`]);
  await client.query(`SELECT set_config('statement_timeout', $1, false)`, [
    `${statementTimeoutMs}ms`,
  ]);
}

/** Creates an idempotent release closure around one successfully locked client. */
function createHandle(client: PoolClient): MigrationLockHandle {
  let released = false;
  return {
    client,
    release: async (broken = false): Promise<void> => {
      if (released) return;
      released = true;
      if (broken) {
        client.release(true);
        return;
      }
      try {
        if (!(await unlock(client))) {
          throw databaseError('The PostgreSQL migration lock was not owned by this session.');
        }
        client.release();
      } catch (error) {
        client.release(true);
        if (error instanceof MigrationError) throw error;
        throw databaseError('Could not release the PostgreSQL migration lock.');
      }
    },
  };
}

/** Attempts the fixed two-key advisory lock on the current database. */
async function tryLock(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ acquired: boolean }>(
    `SELECT pg_try_advisory_lock(hashtext(current_database()), hashtext($1)) AS acquired`,
    [LOCK_NAMESPACE]
  );
  return result.rows[0]?.acquired === true;
}

/** Releases the fixed two-key advisory lock on the current database. */
async function unlock(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ released: boolean }>(
    `SELECT pg_advisory_unlock(hashtext(current_database()), hashtext($1)) AS released`,
    [LOCK_NAMESPACE]
  );
  return result.rows[0]?.released === true;
}

/** Waits between nonblocking attempts while honoring cancellation. */
async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise(resolve => setTimeout(resolve, milliseconds));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Rejects invalid internal timeout values before they reach control flow. */
function validateTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MigrationError({
      kind: 'INTERNAL',
      exitCode: 1,
      message: 'Migration lock timeout was outside the supported range.',
    });
  }
}

/** Stops before acquiring or retrying when the caller has cancelled. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortedError();
}

/** Creates a stable cancellation failure. */
function abortedError(): MigrationError {
  return new MigrationError({
    kind: 'ABORTED',
    exitCode: 1,
    message: 'Migration operation was cancelled.',
  });
}

/** Creates a sanitized database failure without provider detail. */
function databaseError(message: string): MigrationError {
  return new MigrationError({ kind: 'DATABASE', exitCode: 1, message });
}
