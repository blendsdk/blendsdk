import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Pool, PoolClient } from 'pg';
import { loadMigrationConfig } from './config.js';
import { MigrationError } from './errors.js';
import {
  deleteAppliedMigration,
  ensureMigrationLedger,
  insertAppliedMigration,
  insertDirtyMigration,
  markMigrationApplied,
  markMigrationDirtyForDown,
  readMigrationLedger,
  validateMigrationPrefix,
} from './ledger.js';
import {
  acquireMigrationLock,
  applyMigrationTimeouts,
  isMigrationLockHeld,
} from './migration-lock.js';
import { discoverMigrations, parseMigrationBytes } from './migration-file.js';
import type {
  MigrationCommand,
  MigrationCommandResult,
  MigrationDescriptor,
  ResolvedMigrationConfig,
} from './types.js';

/** Options accepted by the PostgreSQL migration runner. */
export interface RunMigrationsOptions {
  /** Execution or observation command. */
  readonly command: Extract<MigrationCommand, 'up' | 'down' | 'status' | 'validate'>;
  /** Explicit configuration file or discovery directory. */
  readonly configPath?: string;
  /** Reports pending order while proving lock availability, without database mutation. */
  readonly dryRun?: boolean;
  /** Explicitly permits one guarded down migration. */
  readonly allowDown?: boolean;
  /** Performs validate against local files only, even when the URL environment variable is set. */
  readonly offline?: boolean;
  /** Caller-owned cancellation signal; the library installs no global handlers. */
  readonly signal?: AbortSignal;
}

/**
 * Validates local history and runs or observes PostgreSQL migrations.
 *
 * @param options - Command, configuration location, safety flags, and cancellation signal.
 * @returns A structured terminal state and the migrations relevant to that state.
 * @throws {MigrationError} When a mutating command cannot complete safely.
 *
 * @example
 * ```ts
 * await runMigrations({ command: 'up', configPath: './blendsdk.migrations.ts' });
 * ```
 */
export async function runMigrations(
  options: RunMigrationsOptions
): Promise<MigrationCommandResult> {
  const config = await loadMigrationConfig({
    command: options.command,
    ...(options.configPath ? { configPath: options.configPath } : {}),
  });
  let migrations: readonly MigrationDescriptor[];
  try {
    migrations = await discoverConfiguredMigrations(config);
  } catch (error) {
    if (isObservationCommand(options.command) && isInvalidHistory(error)) {
      return { status: 'INVALID_HISTORY', migrations: [] };
    }
    throw error;
  }
  if (options.command === 'validate' && options.offline) {
    return { status: 'UP_TO_DATE', migrations: [] };
  }
  const databaseUrl = readOptionalDatabaseUrl(config);
  if (options.command === 'validate' && !databaseUrl)
    return { status: 'UP_TO_DATE', migrations: [] };
  if (!databaseUrl) throw missingDatabaseUrl(config);
  const pool = await createPool(databaseUrl);
  try {
    if (options.command === 'status' || options.command === 'validate') {
      return await observeHistory(pool, migrations);
    }
    if (options.command === 'down') return await runDown(pool, config, migrations, options);
    return await runUp(pool, config, migrations, options);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/** Creates the optional PostgreSQL pool only after an operation proves it needs a database. */
async function createPool(databaseUrl: string): Promise<Pool> {
  let postgres: typeof import('pg');
  try {
    postgres = await import('pg');
  } catch {
    throw databaseError('The optional pg package is required for database migration commands.');
  }
  try {
    return new postgres.Pool({ connectionString: databaseUrl, max: 2 });
  } catch {
    throw databaseError('Could not initialize the PostgreSQL migration connection.');
  }
}

/** Options for observing migration status without exposing the command discriminator. */
export interface GetMigrationStatusOptions {
  /** Explicit configuration file or discovery directory. */
  readonly configPath?: string;
}

/**
 * Reads the current migration status without mutating PostgreSQL.
 *
 * @example
 * ```ts
 * const { status } = await getMigrationStatus();
 * ```
 */
export function getMigrationStatus(
  options: GetMigrationStatusOptions = {}
): Promise<MigrationCommandResult> {
  return runMigrations({ command: 'status', ...options });
}

/** Options for validating migration history. */
export interface ValidateMigrationsOptions extends GetMigrationStatusOptions {
  /** Validates only local files and lineage without loading the PostgreSQL driver. */
  readonly offline?: boolean;
}

/**
 * Validates local and, unless offline, live PostgreSQL migration history.
 *
 * @example
 * ```ts
 * await validateMigrations({ offline: true });
 * ```
 */
export function validateMigrations(
  options: ValidateMigrationsOptions = {}
): Promise<MigrationCommandResult> {
  return runMigrations({ command: 'validate', ...options });
}

/** Reads history without creating the ledger or retaining an advisory lock. */
async function observeHistory(
  pool: Pool,
  migrations: readonly MigrationDescriptor[]
): Promise<MigrationCommandResult> {
  let client;
  let broken = false;
  try {
    client = await pool.connect();
    if (await isMigrationLockHeld(client)) return { status: 'LOCKED', migrations: [] };
    const prefix = validateMigrationPrefix(migrations, await readMigrationLedger(client));
    return { status: prefix.status, migrations: prefix.pending };
  } catch (error) {
    broken = isConnectionFailure(error);
    if (error instanceof MigrationError && error.kind === 'INVALID_HISTORY') {
      return { status: 'INVALID_HISTORY', migrations: [] };
    }
    if (error instanceof MigrationError) throw error;
    throw databaseError('Could not inspect PostgreSQL migration history.');
  } finally {
    client?.release(broken);
  }
}

/** Discovers the complete validated local history for one resolved configuration. */
async function discoverConfiguredMigrations(
  config: ResolvedMigrationConfig
): Promise<readonly MigrationDescriptor[]> {
  return discoverMigrations({
    migrationsDir: config.migrationsDir,
    snapshotFile: config.snapshotFile,
    validateLineage: true,
  });
}

/**
 * Rejects any whole-history change observed while waiting for the database advisory lock.
 *
 * Rechecking only the next pending file is insufficient because edits to applied files and newly
 * inserted files would leave the pre-lock prefix stale.
 */
function assertMigrationSetUnchanged(
  beforeLock: readonly MigrationDescriptor[],
  underLock: readonly MigrationDescriptor[]
): void {
  if (
    beforeLock.length !== underLock.length ||
    beforeLock.some((migration, index) => !sameMigrationDescriptor(migration, underLock[index]))
  ) {
    throw new MigrationError({
      kind: 'INVALID_HISTORY',
      exitCode: 1,
      message: 'Local migration history changed while waiting for the migration lock.',
    });
  }
}

/** Compares every execution- and lineage-relevant field of two local descriptors. */
function sameMigrationDescriptor(
  left: MigrationDescriptor,
  right: MigrationDescriptor | undefined
): boolean {
  return (
    right !== undefined &&
    left.id === right.id &&
    left.upPath === right.upPath &&
    left.downPath === right.downPath &&
    left.checksum === right.checksum &&
    left.downChecksum === right.downChecksum &&
    left.transactional === right.transactional &&
    left.downTransactional === right.downTransactional &&
    left.fromSnapshot === right.fromSnapshot &&
    left.toSnapshot === right.toSnapshot
  );
}

/** Applies pending transactional migrations while holding one dedicated session lock. */
async function runUp(
  pool: Pool,
  config: ResolvedMigrationConfig,
  migrations: readonly MigrationDescriptor[],
  options: RunMigrationsOptions
): Promise<MigrationCommandResult> {
  const lock = await acquireMigrationLock(
    () => pool.connect(),
    config.lockTimeoutMs,
    options.signal
  );
  let broken = false;
  try {
    const lockedMigrations = await discoverConfiguredMigrations(config);
    assertMigrationSetUnchanged(migrations, lockedMigrations);
    const prefix = validateMigrationPrefix(
      lockedMigrations,
      await readMigrationLedger(lock.client)
    );
    if (prefix.status === 'UNKNOWN_OUTCOME') {
      throw new MigrationError({
        kind: 'UNKNOWN_OUTCOME',
        exitCode: 1,
        message: 'The latest nontransactional migration has an unknown outcome.',
      });
    }
    if (options.dryRun) return { status: prefix.status, migrations: prefix.pending };
    for (const migration of prefix.pending) {
      throwIfAborted(options.signal);
      if (!migration.transactional) {
        await applyNontransactionalMigration(pool, lock.client, config, migration, options.signal);
      } else {
        await applyTransactionalMigration(pool, lock.client, config, migration, options.signal);
      }
    }
    return { status: 'UP_TO_DATE', migrations: prefix.pending };
  } catch (error) {
    broken = isBrokenSession(error);
    if (error instanceof MigrationError) throw error;
    throw databaseError('PostgreSQL migration execution failed.');
  } finally {
    await lock.release(broken);
  }
}

/** Runs exact SQL and its ledger insert in one caller-owned transaction. */
async function applyTransactionalMigration(
  pool: Pool,
  client: PoolClient,
  config: ResolvedMigrationConfig,
  migration: MigrationDescriptor,
  signal?: AbortSignal
): Promise<void> {
  const sql = await readVerifiedMigrationSql(migration, 'up');
  const startedAt = performance.now();
  await client.query('BEGIN');
  try {
    await applyMigrationTimeouts(client, config.lockTimeoutMs, config.statementTimeoutMs);
    await ensureMigrationLedger(client);
    await executeMigrationSql(pool, client, sql, signal);
    await insertAppliedMigration(client, migration, elapsedMilliseconds(startedAt));
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      throw databaseError(`Migration ${migration.id} failed and its session was lost.`, true);
    }
    if (error instanceof MigrationError) throw error;
    throw databaseError(`Migration ${migration.id} failed and was rolled back.`);
  }
}

/** Runs one nontransactional migration behind a committed durable uncertainty marker. */
async function applyNontransactionalMigration(
  pool: Pool,
  client: PoolClient,
  config: ResolvedMigrationConfig,
  migration: MigrationDescriptor,
  signal?: AbortSignal
): Promise<void> {
  const sql = await readVerifiedMigrationSql(migration, 'up');
  await applyMigrationTimeouts(client, config.lockTimeoutMs, config.statementTimeoutMs);
  await client.query('BEGIN');
  let commitDispatched = false;
  try {
    await ensureMigrationLedger(client);
    await insertDirtyMigration(client, migration);
    commitDispatched = true;
    await client.query('COMMIT');
  } catch (error) {
    if (commitDispatched) {
      throw unknownOutcome(
        `Could not confirm the dirty marker for migration ${migration.id}.`,
        true
      );
    }
    await rollbackOrLoseSession(client, migration.id);
    if (error instanceof MigrationError) throw error;
    throw databaseError(`Could not record migration ${migration.id} before execution.`);
  }

  const startedAt = performance.now();
  try {
    await executeMigrationSql(pool, client, sql, signal);
  } catch (error) {
    if (error instanceof MigrationError && error.kind === 'ABORTED') {
      throw unknownOutcome(`Migration ${migration.id} was cancelled after dispatch.`);
    }
    if (isConnectionFailure(error)) {
      throw unknownOutcome(`Migration ${migration.id} lost its session after dispatch.`, true);
    }
    throw databaseError(`Nontransactional migration ${migration.id} failed.`);
  }
  try {
    await markMigrationApplied(client, migration, elapsedMilliseconds(startedAt));
  } catch (error) {
    throw unknownOutcome(
      `Migration ${migration.id} completed but its ledger could not be finalized.`,
      isConnectionFailure(error)
    );
  }
}

/** Reverts exactly the newest applied migration while holding the migration lock. */
async function runDown(
  pool: Pool,
  config: ResolvedMigrationConfig,
  migrations: readonly MigrationDescriptor[],
  options: RunMigrationsOptions
): Promise<MigrationCommandResult> {
  if (!options.allowDown) {
    throw new MigrationError({
      kind: 'UNSUPPORTED',
      exitCode: 1,
      message: 'Down requires explicit allowDown confirmation.',
    });
  }
  const lock = await acquireMigrationLock(
    () => pool.connect(),
    config.lockTimeoutMs,
    options.signal
  );
  let broken = false;
  try {
    const lockedMigrations = await discoverConfiguredMigrations(config);
    assertMigrationSetUnchanged(migrations, lockedMigrations);
    const ledger = await readMigrationLedger(lock.client);
    const prefix = validateMigrationPrefix(lockedMigrations, ledger);
    if (prefix.status === 'UNKNOWN_OUTCOME') {
      throw unknownOutcome('The latest migration has an unknown outcome.');
    }
    const migration = lockedMigrations[ledger.length - 1];
    if (!migration || !migration.downPath) {
      throw new MigrationError({
        kind: 'INVALID_HISTORY',
        exitCode: 1,
        message: 'The latest applied migration has no down file.',
      });
    }
    if (migration.downTransactional === false) {
      await applyNontransactionalDown(pool, lock.client, config, migration, options.signal);
    } else {
      await applyTransactionalDown(pool, lock.client, config, migration, options.signal);
    }
    return { status: 'PENDING', migrations: [migration] };
  } catch (error) {
    broken = isBrokenSession(error);
    if (error instanceof MigrationError) throw error;
    throw databaseError('PostgreSQL down migration failed.');
  } finally {
    await lock.release(broken);
  }
}

/** Runs down SQL and its guarded ledger delete in one transaction. */
async function applyTransactionalDown(
  pool: Pool,
  client: PoolClient,
  config: ResolvedMigrationConfig,
  migration: MigrationDescriptor,
  signal?: AbortSignal
): Promise<void> {
  const sql = await readVerifiedMigrationSql(migration, 'down');
  await client.query('BEGIN');
  try {
    await applyMigrationTimeouts(client, config.lockTimeoutMs, config.statementTimeoutMs);
    await executeMigrationSql(pool, client, sql, signal);
    await deleteAppliedMigration(client, migration);
    await client.query('COMMIT');
  } catch (error) {
    await rollbackOrLoseSession(client, migration.id);
    if (error instanceof MigrationError) throw error;
    throw databaseError(`Down migration ${migration.id} failed and was rolled back.`);
  }
}

/** Runs nontransactional down SQL after durably marking its row uncertain. */
async function applyNontransactionalDown(
  pool: Pool,
  client: PoolClient,
  config: ResolvedMigrationConfig,
  migration: MigrationDescriptor,
  signal?: AbortSignal
): Promise<void> {
  const sql = await readVerifiedMigrationSql(migration, 'down');
  await applyMigrationTimeouts(client, config.lockTimeoutMs, config.statementTimeoutMs);
  await client.query('BEGIN');
  let commitDispatched = false;
  try {
    await markMigrationDirtyForDown(client, migration);
    commitDispatched = true;
    await client.query('COMMIT');
  } catch (error) {
    if (commitDispatched) {
      throw unknownOutcome(
        `Could not confirm the dirty marker for down migration ${migration.id}.`,
        true
      );
    }
    await rollbackOrLoseSession(client, migration.id);
    if (error instanceof MigrationError) throw error;
    throw databaseError(`Could not mark down migration ${migration.id} before execution.`);
  }
  try {
    await executeMigrationSql(pool, client, sql, signal);
  } catch (error) {
    if (error instanceof MigrationError && error.kind === 'ABORTED') {
      throw unknownOutcome(`Down migration ${migration.id} was cancelled after dispatch.`);
    }
    if (isConnectionFailure(error)) {
      throw unknownOutcome(`Down migration ${migration.id} lost its session after dispatch.`, true);
    }
    throw databaseError(`Nontransactional down migration ${migration.id} failed.`);
  }
  try {
    await deleteAppliedMigration(client, migration, 'NONTRANSACTIONAL_DIRTY');
  } catch (error) {
    throw unknownOutcome(
      `Down migration ${migration.id} completed but its ledger could not be finalized.`,
      isConnectionFailure(error)
    );
  }
}

/**
 * Reads, validates, and returns the exact bytes that will be sent to PostgreSQL.
 *
 * Discovery establishes local ordering and ledger comparison. This second validation closes the
 * lock-wait race: a file changed after discovery is rejected, and the returned string is decoded
 * from the same buffer whose metadata and checksum were checked.
 */
async function readVerifiedMigrationSql(
  migration: MigrationDescriptor,
  direction: 'up' | 'down'
): Promise<string> {
  const path = direction === 'up' ? migration.upPath : requiredDownPath(migration);
  const bytes = await readFile(path);
  const parsed = parseMigrationBytes(basename(path), bytes, path);
  const expectedChecksum = direction === 'up' ? migration.checksum : migration.downChecksum;
  if (
    parsed.direction !== direction ||
    parsed.id !== migration.id ||
    parsed.transactional !==
      (direction === 'up' ? migration.transactional : migration.downTransactional) ||
    parsed.fromSnapshot !== (direction === 'up' ? migration.fromSnapshot : migration.toSnapshot) ||
    parsed.toSnapshot !== (direction === 'up' ? migration.toSnapshot : migration.fromSnapshot) ||
    !expectedChecksum ||
    parsed.checksum !== expectedChecksum
  ) {
    throw new MigrationError({
      kind: 'INVALID_HISTORY',
      exitCode: 1,
      message: `Migration ${migration.id} changed after history validation.`,
    });
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Executes exact migration SQL and asks PostgreSQL to cancel it when the caller aborts.
 *
 * Cancellation uses a second pool connection because the primary connection may be busy running
 * the migration. The caller still owns the primary session and can therefore roll back a
 * transactional migration before releasing its advisory lock.
 */
async function executeMigrationSql(
  pool: Pool,
  client: PoolClient,
  sql: string,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  const backend = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = backend.rows[0]?.pid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
    throw databaseError('Could not identify the PostgreSQL migration session.');
  }

  let cancellation: Promise<void> | undefined;
  const onAbort = (): void => {
    cancellation = cancelBackend(pool, pid);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    throwIfAborted(signal);
    await client.query(sql);
  } catch (error) {
    if (signal?.aborted) throw abortedError();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await cancellation;
  }
}

/** Sends a parameterized cancellation request without surfacing provider detail. */
async function cancelBackend(pool: Pool, pid: number): Promise<void> {
  try {
    await pool.query('SELECT pg_cancel_backend($1)', [pid]);
  } catch {
    // The primary query or its statement timeout remains the authoritative terminal result.
  }
}

/** Attempts rollback and reports a broken session without exposing provider detail. */
async function rollbackOrLoseSession(client: PoolClient, migrationId: string): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    throw databaseError(`Migration ${migrationId} failed and its session was lost.`, true);
  }
}

/** Returns the already-validated optional down path or fails closed. */
function requiredDownPath(migration: MigrationDescriptor): string {
  if (!migration.downPath) {
    throw new MigrationError({
      kind: 'INVALID_HISTORY',
      exitCode: 1,
      message: `Migration ${migration.id} has no down file.`,
    });
  }
  return migration.downPath;
}

/** Reads one configured secret without copying it into errors or result objects. */
function readOptionalDatabaseUrl(config: ResolvedMigrationConfig): string | undefined {
  return process.env[config.databaseUrlEnv];
}

/** Creates the connection-required configuration error without reading any secret value. */
function missingDatabaseUrl(config: ResolvedMigrationConfig): MigrationError {
  return new MigrationError({
    kind: 'CONFIGURATION',
    exitCode: 2,
    message: `Database URL environment variable ${config.databaseUrlEnv} is not set.`,
  });
}

/** Identifies commands whose history failures are returned as structured observations. */
function isObservationCommand(command: RunMigrationsOptions['command']): boolean {
  return command === 'status' || command === 'validate';
}

/** Narrows an expected local-history failure without hiding filesystem/configuration errors. */
function isInvalidHistory(error: unknown): boolean {
  return error instanceof MigrationError && error.kind === 'INVALID_HISTORY';
}

/** Converts elapsed monotonic time to a bounded whole-millisecond duration. */
function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

/** Stops at a safe runner boundary when the caller has cancelled. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortedError();
}

/** Creates the stable public cancellation failure. */
function abortedError(): MigrationError {
  return new MigrationError({
    kind: 'ABORTED',
    exitCode: 1,
    message: 'Migration operation was cancelled.',
  });
}

/** Conservatively recognizes provider failures that may indicate a broken session. */
function isConnectionFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = Reflect.get(error, 'code');
  if (typeof code !== 'string') return false;
  return (
    code.startsWith('08') ||
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03' ||
    code === '08003' ||
    code === '08006' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ENETUNREACH' ||
    code === 'EHOSTUNREACH'
  );
}

/** Identifies runner failures that must destroy the dedicated pool client. */
function isBrokenSession(error: unknown): boolean {
  return error instanceof RunnerOperationError ? error.brokenSession : isConnectionFailure(error);
}

/** Internal typed failure that carries only a client-lifecycle decision. */
class RunnerOperationError extends MigrationError {
  /** Whether the raw client must be destroyed rather than returned to its pool. */
  public readonly brokenSession: boolean;

  /** Creates one sanitized operational failure. */
  public constructor(
    kind: 'DATABASE' | 'UNKNOWN_OUTCOME',
    message: string,
    brokenSession: boolean
  ) {
    super({ kind, exitCode: 1, message });
    this.brokenSession = brokenSession;
  }
}

/** Creates a sanitized operational database failure. */
function databaseError(message: string, brokenSession = false): MigrationError {
  return new RunnerOperationError('DATABASE', message, brokenSession);
}

/** Creates a durable uncertainty result without provider or SQL detail. */
function unknownOutcome(message: string, brokenSession = false): MigrationError {
  return new RunnerOperationError('UNKNOWN_OUTCOME', message, brokenSession);
}
