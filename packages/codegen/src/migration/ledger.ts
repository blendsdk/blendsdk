import type { PoolClient } from 'pg';
import { MigrationError } from './errors.js';
import type { MigrationDescriptor, MigrationStatus } from './types.js';

const MIGRATION_ID_PATTERN = /^\d{14}_[a-z][a-z0-9-]{0,62}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const EXPECTED_COLUMNS = [
  ['id', 'text', true],
  ['checksum', 'character(64)', true],
  ['from_snapshot', 'character(64)', false],
  ['to_snapshot', 'character(64)', false],
  ['state', 'text', true],
  ['applied_at', 'timestamp with time zone', false],
  ['execution_ms', 'bigint', false],
] as const;
const EXPECTED_CHECK_DEFINITIONS = new Set([
  "check (state = any (array['applied'::text, 'nontransactional_dirty'::text]))",
  'check (execution_ms >= 0)',
  "check (state = 'applied'::text and applied_at is not null and execution_ms is not null or state = 'nontransactional_dirty'::text and applied_at is null and execution_ms is null)",
]);

/** Fixed quoted PostgreSQL ledger used by every version-one migration command. */
export const MIGRATION_LEDGER = '"public"."blendsdk_migrations"';

/** Durable execution state recorded for one migration. */
export type LedgerState = 'APPLIED' | 'NONTRANSACTIONAL_DIRTY';

/** Validated immutable row read from the migration ledger. */
export interface LedgerRow {
  /** Applied migration identifier. */
  readonly id: string;
  /** SHA-256 of the exact up-file bytes. */
  readonly checksum: string;
  /** Prior generated snapshot hash, or undefined for manual history. */
  readonly fromSnapshot?: string;
  /** Resulting generated snapshot hash, or undefined for manual history. */
  readonly toSnapshot?: string;
  /** Durable execution state. */
  readonly state: LedgerState;
  /** Successful application time, absent while outcome is uncertain. */
  readonly appliedAt?: Date;
  /** Nonnegative successful execution duration, absent while outcome is uncertain. */
  readonly executionMs?: number;
}

/** Result of comparing local immutable files with recorded history. */
export interface PrefixValidationResult {
  /** Stable observed history state. */
  readonly status: Extract<MigrationStatus, 'UP_TO_DATE' | 'PENDING' | 'UNKNOWN_OUTCOME'>;
  /** Local descriptors after the exact applied prefix. */
  readonly pending: readonly MigrationDescriptor[];
}

/** Creates the fixed ledger inside a caller-owned transaction. */
export async function ensureMigrationLedger(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER} (
      id text PRIMARY KEY,
      checksum char(64) NOT NULL,
      from_snapshot char(64),
      to_snapshot char(64),
      state text NOT NULL CHECK (state IN ('APPLIED', 'NONTRANSACTIONAL_DIRTY')),
      applied_at timestamptz,
      execution_ms bigint CHECK (execution_ms >= 0),
      CHECK (
        (state = 'APPLIED' AND applied_at IS NOT NULL AND execution_ms IS NOT NULL) OR
        (state = 'NONTRANSACTIONAL_DIRTY' AND applied_at IS NULL AND execution_ms IS NULL)
      )
    )
  `);
  await validateMigrationLedgerShape(client);
}

/** Reports ledger presence without creating or changing database objects. */
export async function migrationLedgerExists(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('public.blendsdk_migrations') IS NOT NULL AS exists`
  );
  return result.rows[0]?.exists === true;
}

/**
 * Reads and validates every ledger row in identifier order.
 *
 * @throws {MigrationError} When the existing table or any returned row is not a valid v1 ledger.
 */
export async function readMigrationLedger(client: PoolClient): Promise<readonly LedgerRow[]> {
  if (!(await migrationLedgerExists(client))) return [];
  await validateMigrationLedgerShape(client);
  const result = await client.query(`
    SELECT id, checksum, from_snapshot, to_snapshot, state, applied_at, execution_ms::text
    FROM ${MIGRATION_LEDGER}
    ORDER BY id
  `);
  return result.rows.map((row, index) => parseLedgerRow(row, index));
}

/**
 * Proves that an existing ledger has the complete version-one catalog shape without altering it.
 *
 * Row guards alone cannot detect an empty incompatible table. The bounded catalog reads below
 * therefore verify every column plus the primary key and three required checks before any ledger
 * read or mutation proceeds.
 */
async function validateMigrationLedgerShape(client: PoolClient): Promise<void> {
  const columns = await client.query(
    `
    SELECT c.relkind, c.relpersistence, a.attname,
           format_type(a.atttypid, a.atttypmod) AS data_type,
           a.attnotnull, a.atthasdef, a.attidentity, a.attgenerated
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum
  `,
    ['public', 'blendsdk_migrations']
  );
  if (columns.rows.length !== EXPECTED_COLUMNS.length) throw incompatibleLedger();
  for (const [index, expected] of EXPECTED_COLUMNS.entries()) {
    const row = columns.rows[index];
    if (
      !isRecord(row) ||
      row.relkind !== 'r' ||
      row.relpersistence !== 'p' ||
      row.attname !== expected[0] ||
      row.data_type !== expected[1] ||
      row.attnotnull !== expected[2] ||
      row.atthasdef !== false ||
      row.attidentity !== '' ||
      row.attgenerated !== ''
    ) {
      throw incompatibleLedger();
    }
  }

  const constraints = await client.query(
    `
    SELECT con.contype, con.condeferrable, con.condeferred, con.convalidated,
           pg_get_constraintdef(con.oid, true) AS definition,
           ARRAY(
             SELECT att.attname::text
             FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, position)
             JOIN pg_catalog.pg_attribute att
               ON att.attrelid = con.conrelid AND att.attnum = key.attnum
             ORDER BY key.position
           ) AS columns
    FROM pg_catalog.pg_constraint con
    WHERE con.conrelid = $1::regclass
    ORDER BY con.oid
  `,
    [MIGRATION_LEDGER]
  );
  if (!hasExpectedConstraints(constraints.rows)) throw incompatibleLedger();
}

/** Recognizes exactly one ID primary key and the three version-one check responsibilities. */
function hasExpectedConstraints(rows: readonly unknown[]): boolean {
  if (rows.length !== 4) return false;
  if (
    rows.some(
      row =>
        !isRecord(row) ||
        row.condeferrable !== false ||
        row.condeferred !== false ||
        row.convalidated !== true
    )
  ) {
    return false;
  }
  const primary = rows.filter(row => isConstraint(row, 'p'));
  const checks = rows.filter(row => isConstraint(row, 'c'));
  if (primary.length !== 1 || checks.length !== 3) return false;
  const primaryColumns = primary[0]?.columns;
  if (
    !Array.isArray(primaryColumns) ||
    primaryColumns.length !== 1 ||
    primaryColumns[0] !== 'id' ||
    normalizeConstraint(primary[0]?.definition) !== 'primary key (id)'
  ) {
    return false;
  }
  const definitions = new Set(checks.map(row => normalizeConstraint(row.definition)));
  return (
    definitions.size === EXPECTED_CHECK_DEFINITIONS.size &&
    [...EXPECTED_CHECK_DEFINITIONS].every(definition => definitions.has(definition))
  );
}

/** Narrows one untrusted constraint row by its PostgreSQL discriminator. */
function isConstraint(value: unknown, type: 'p' | 'c'): value is Readonly<Record<string, unknown>> {
  return isRecord(value) && value.contype === type && typeof value.definition === 'string';
}

/** Makes PostgreSQL's harmless whitespace choices stable for bounded semantic matching. */
function normalizeConstraint(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase().replace(/\s+/gu, ' ') : '';
}

/** Creates the fail-closed error shared by every catalog-shape mismatch. */
function incompatibleLedger(): MigrationError {
  return invalidHistory('The existing migration ledger is not compatible with version one.');
}

/** Inserts one successful transactional migration inside the migration transaction. */
export async function insertAppliedMigration(
  client: PoolClient,
  migration: MigrationDescriptor,
  executionMs: number
): Promise<void> {
  await client.query(
    `INSERT INTO ${MIGRATION_LEDGER}
      (id, checksum, from_snapshot, to_snapshot, state, applied_at, execution_ms)
     VALUES ($1, $2, $3, $4, 'APPLIED', now(), $5)`,
    lineageValues(migration, executionMs)
  );
}

/** Inserts the durable uncertainty marker before nontransactional SQL is dispatched. */
export async function insertDirtyMigration(
  client: PoolClient,
  migration: MigrationDescriptor
): Promise<void> {
  await client.query(
    `INSERT INTO ${MIGRATION_LEDGER}
      (id, checksum, from_snapshot, to_snapshot, state, applied_at, execution_ms)
     VALUES ($1, $2, $3, $4, 'NONTRANSACTIONAL_DIRTY', NULL, NULL)`,
    lineageValues(migration)
  );
}

/** Promotes exactly one matching uncertainty marker after confirmed success. */
export async function markMigrationApplied(
  client: PoolClient,
  migration: MigrationDescriptor,
  executionMs: number
): Promise<void> {
  const result = await client.query(
    `UPDATE ${MIGRATION_LEDGER}
     SET state = 'APPLIED', applied_at = now(), execution_ms = $2
     WHERE id = $1 AND checksum = $3 AND state = 'NONTRANSACTIONAL_DIRTY'`,
    [migration.id, boundedDuration(executionMs), migration.checksum]
  );
  requireSingleRow(result.rowCount, 'promote');
}

/** Marks an applied migration uncertain before nontransactional down SQL is dispatched. */
export async function markMigrationDirtyForDown(
  client: PoolClient,
  migration: MigrationDescriptor
): Promise<void> {
  const result = await client.query(
    `UPDATE ${MIGRATION_LEDGER}
     SET state = 'NONTRANSACTIONAL_DIRTY', applied_at = NULL, execution_ms = NULL
     WHERE id = $1 AND checksum = $2 AND state = 'APPLIED'`,
    [migration.id, migration.checksum]
  );
  requireSingleRow(result.rowCount, 'mark dirty');
}

/** Deletes exactly one matching final row after confirmed down SQL success. */
export async function deleteAppliedMigration(
  client: PoolClient,
  migration: MigrationDescriptor,
  expectedState: LedgerState = 'APPLIED'
): Promise<void> {
  const result = await client.query(
    `DELETE FROM ${MIGRATION_LEDGER} WHERE id = $1 AND checksum = $2 AND state = $3`,
    [migration.id, migration.checksum, expectedState]
  );
  requireSingleRow(result.rowCount, 'delete');
}

/**
 * Proves the ledger is the exact ordered prefix of local immutable history.
 *
 * @throws {MigrationError} When an ID, checksum, lineage field, order, or row state is invalid.
 */
export function validateMigrationPrefix(
  local: readonly MigrationDescriptor[],
  ledger: readonly LedgerRow[]
): PrefixValidationResult {
  if (ledger.length > local.length) {
    throw invalidHistory('The migration ledger is longer than local history.');
  }
  for (const [index, row] of ledger.entries()) {
    const migration = local[index];
    if (
      !migration ||
      row.id !== migration.id ||
      row.checksum !== migration.checksum ||
      row.fromSnapshot !== migration.fromSnapshot ||
      row.toSnapshot !== migration.toSnapshot
    ) {
      throw invalidHistory(`Migration prefix or checksum mismatch at position ${index + 1}.`);
    }
    if (row.state === 'NONTRANSACTIONAL_DIRTY') {
      if (index !== ledger.length - 1) {
        throw invalidHistory('Only the final ledger row may have an uncertain outcome.');
      }
      return { status: 'UNKNOWN_OUTCOME', pending: [] };
    }
  }
  const pending = local.slice(ledger.length);
  return { status: pending.length === 0 ? 'UP_TO_DATE' : 'PENDING', pending };
}

/** Converts one untrusted PostgreSQL row into the exact v1 ledger contract. */
function parseLedgerRow(value: unknown, index: number): LedgerRow {
  if (!isRecord(value)) throw invalidLedgerRow(index);
  const id = value.id;
  const checksum = value.checksum;
  const fromSnapshot = optionalHash(value.from_snapshot);
  const toSnapshot = optionalHash(value.to_snapshot);
  const state = value.state;
  const appliedAt = value.applied_at;
  const executionMs = parseDuration(value.execution_ms);
  if (
    typeof id !== 'string' ||
    !MIGRATION_ID_PATTERN.test(id) ||
    typeof checksum !== 'string' ||
    !HASH_PATTERN.test(checksum) ||
    fromSnapshot === null ||
    toSnapshot === null ||
    (state !== 'APPLIED' && state !== 'NONTRANSACTIONAL_DIRTY')
  ) {
    throw invalidLedgerRow(index);
  }
  if (state === 'APPLIED') {
    if (!(appliedAt instanceof Date) || Number.isNaN(appliedAt.valueOf()) || executionMs === null) {
      throw invalidLedgerRow(index);
    }
    return {
      id,
      checksum,
      ...(fromSnapshot ? { fromSnapshot } : {}),
      ...(toSnapshot ? { toSnapshot } : {}),
      state,
      appliedAt,
      executionMs,
    };
  }
  if (appliedAt !== null || value.execution_ms !== null) throw invalidLedgerRow(index);
  return {
    id,
    checksum,
    ...(fromSnapshot ? { fromSnapshot } : {}),
    ...(toSnapshot ? { toSnapshot } : {}),
    state,
  };
}

/** Returns an optional validated hash, using null only as an invalid sentinel. */
function optionalHash(value: unknown): string | undefined | null {
  if (value === null) return undefined;
  return typeof value === 'string' && HASH_PATTERN.test(value) ? value : null;
}

/** Converts PostgreSQL bigint text into one bounded duration. */
function parseDuration(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return null;
  const duration = Number(value);
  return Number.isSafeInteger(duration) ? duration : null;
}

/** Builds the parameter values shared by ledger inserts. */
function lineageValues(migration: MigrationDescriptor, executionMs?: number): unknown[] {
  return [
    migration.id,
    migration.checksum,
    migration.fromSnapshot ?? null,
    migration.toSnapshot ?? null,
    ...(executionMs === undefined ? [] : [boundedDuration(executionMs)]),
  ];
}

/** Validates a measured duration before it crosses the SQL boundary. */
function boundedDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MigrationError({
      kind: 'INTERNAL',
      exitCode: 1,
      message: 'Migration duration was outside the supported range.',
    });
  }
  return value;
}

/** Requires one guarded state transition without accepting concurrent drift. */
function requireSingleRow(rowCount: number | null, operation: string): void {
  if (rowCount !== 1) {
    throw invalidHistory(`Could not ${operation} the expected migration ledger row.`);
  }
}

/** Narrows an unknown database value to a property record. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

/** Creates a stable invalid-row error without returning row contents. */
function invalidLedgerRow(index: number): MigrationError {
  return invalidHistory(`Migration ledger row ${index + 1} is invalid.`);
}

/** Creates a stable history error without exposing SQL or credentials. */
function invalidHistory(message: string): MigrationError {
  return new MigrationError({ kind: 'INVALID_HISTORY', exitCode: 1, message });
}
