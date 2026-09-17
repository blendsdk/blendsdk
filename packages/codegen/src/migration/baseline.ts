import type { Pool, PoolClient } from 'pg';
import { compareCatalogs } from './catalog-diff.js';
import type { CatalogComparisonItem } from './catalog-diff.js';
import { projectPostgreSqlCatalog } from './catalog-projector.js';
import { loadMigrationConfig } from './config.js';
import { MigrationError } from './errors.js';
import { generateInitialMigration } from './generate.js';
import type { GenerateMigrationOptions } from './generate.js';
import { ensureMigrationLedger, insertAppliedMigration, readMigrationLedger } from './ledger.js';
import { acquireMigrationLock, applyMigrationTimeouts } from './migration-lock.js';
import { discoverMigrations } from './migration-file.js';
import type { SchemaChange } from './schema-diff.js';
import { hashSnapshotBytes, readSnapshot } from './snapshot.js';
import type { SchemaSnapshotV1 } from './snapshot-types.js';
import type { MigrationDescriptor } from './types.js';
import { readUnmanagedCatalogObjects } from './unmanaged-catalog.js';

/** Options for creating the first offline migration lineage. */
export interface GenerateBaselineOptions {
  /** Lowercase baseline slug. */
  readonly name: string;
  /** Explicit configuration file or discovery directory. */
  readonly configPath?: string;
  /** Deterministic clock used by tests and embedding callers. */
  readonly now?: Date;
}

/** Result from creating one initial migration and canonical snapshot. */
export interface GenerateBaselineResult {
  /** Successful baseline generation state. */
  readonly status: 'GENERATED';
  /** The one published initial migration. */
  readonly migration: MigrationDescriptor;
  /** SHA-256 of the published canonical snapshot bytes. */
  readonly snapshotHash: string;
  /** Complete desired-state additions rendered into the baseline. */
  readonly changes: readonly SchemaChange[];
}

/**
 * Creates one complete offline baseline migration and canonical snapshot.
 *
 * The operation refuses any existing snapshot or up history and never opens a database
 * connection. It uses the same canonical renderer and paired publication as normal generation.
 *
 * @example
 * ```ts
 * await generateBaseline({ name: 'initial' });
 * ```
 */
export async function generateBaseline(
  options: GenerateBaselineOptions
): Promise<GenerateBaselineResult> {
  const generationOptions: GenerateMigrationOptions = {
    name: options.name,
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  };
  const result = await generateInitialMigration(generationOptions);
  if (!result.migration) {
    throw new MigrationError({
      kind: 'INVALID_HISTORY',
      exitCode: 1,
      message: 'Initial migration generation completed without an artifact.',
    });
  }
  return {
    status: 'GENERATED',
    migration: result.migration,
    snapshotHash: result.desiredSnapshot,
    changes: result.changes,
  };
}

/** Options for proving and recording an existing database's initial lineage. */
export interface AdoptBaselineOptions {
  /** Explicit configuration file or discovery directory. */
  readonly configPath?: string;
  /** Exact `<database>/<baseline-id>` DDL-quiescence confirmation token. */
  readonly confirmation?: string;
}

/** Sanitized preview available before the authoritative adoption transaction begins. */
export interface AdoptionPreview {
  /** Target host without password or URL query values. */
  readonly host: string;
  /** Target PostgreSQL port. */
  readonly port: string;
  /** Target role name without its password. */
  readonly user: string;
  /** Target database name without host credentials or URL query values. */
  readonly database: string;
  /** Initial migration identifier that will be recorded. */
  readonly baselineId: string;
  /** Stable supported and unmanaged catalog comparison. */
  readonly comparison: readonly CatalogComparisonItem[];
}

/** Narrow lifecycle seam used to show or pause after the informational preview. */
export interface AdoptBaselineDependencies {
  /** Displays the preview and may return the target-bound confirmation collected from the user. */
  readonly afterPreview?: (preview: AdoptionPreview) => string | void | Promise<string | void>;
}

/** Result returned only after the baseline ledger row commits successfully. */
export interface AdoptBaselineResult {
  /** Successful existing-database adoption state. */
  readonly status: 'ADOPTED';
  /** Authoritative comparison, including informational unmanaged objects. */
  readonly comparison: readonly CatalogComparisonItem[];
}

/**
 * Proves supported catalog equality and records one baseline without executing its SQL.
 *
 * The caller must separately quiesce application and administrative DDL, then provide the exact
 * target-specific confirmation token. BlendSDK serializes its own migration processes with the
 * normal advisory lock and repeats comparison inside the ledger transaction.
 *
 * @example
 * ```ts
 * await adoptBaseline({ confirmation: 'production/20260827090000_initial' });
 * ```
 */
export async function adoptBaseline(
  options: AdoptBaselineOptions,
  dependencies: AdoptBaselineDependencies = {}
): Promise<AdoptBaselineResult> {
  const config = await loadMigrationConfig({
    command: 'adopt-baseline',
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
  });
  const local = await readOnlyBaseline(config.migrationsDir, config.snapshotFile);
  const databaseUrl = process.env[config.databaseUrlEnv];
  if (!databaseUrl) {
    throw new MigrationError({
      kind: 'CONFIGURATION',
      exitCode: 2,
      message: `Database URL environment variable ${config.databaseUrlEnv} is not set.`,
    });
  }

  const pool = await createPool(databaseUrl);
  const target = safeTarget(databaseUrl);
  try {
    const lock = await acquireMigrationLock(() => pool.connect(), config.lockTimeoutMs);
    let broken = false;
    try {
      await applyMigrationTimeouts(lock.client, config.lockTimeoutMs, config.statementTimeoutMs);
      const lockedLocal = await readOnlyBaseline(config.migrationsDir, config.snapshotFile);
      requireSameLocalBaseline(local, lockedLocal);
      const database = await currentDatabase(lock.client);
      const previewComparison = await compareCurrentCatalog(lock.client, lockedLocal.desired);
      requireCompatible(previewComparison);
      const preview: AdoptionPreview = {
        ...target,
        database,
        baselineId: lockedLocal.migration.id,
        comparison: previewComparison,
      };
      const collectedConfirmation = await dependencies.afterPreview?.(preview);
      requireConfirmation(
        collectedConfirmation ?? options.confirmation,
        database,
        lockedLocal.migration.id
      );
      const comparison = await adoptInsideTransaction(
        lock.client,
        config.migrationsDir,
        config.snapshotFile,
        lockedLocal
      );
      return { status: 'ADOPTED', comparison };
    } catch (error) {
      broken = !(error instanceof MigrationError);
      if (error instanceof MigrationError) throw error;
      throw databaseError('PostgreSQL baseline adoption failed.');
    } finally {
      await lock.release(broken);
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/** Creates the optional PostgreSQL pool only for existing-database adoption. */
async function createPool(databaseUrl: string): Promise<Pool> {
  let postgres: typeof import('pg');
  try {
    postgres = await import('pg');
  } catch {
    throw databaseError('The optional pg package is required for baseline adoption.');
  }
  try {
    return new postgres.Pool({ connectionString: databaseUrl, max: 2 });
  } catch {
    throw databaseError('Could not initialize the PostgreSQL baseline connection.');
  }
}

/** Requires exactly one locally valid generated baseline migration. */
interface LocalBaseline {
  readonly migration: MigrationDescriptor;
  readonly desired: SchemaSnapshotV1;
  readonly snapshotHash: string;
}

/** Reads and binds the sole migration descriptor to the exact canonical snapshot bytes. */
async function readOnlyBaseline(
  migrationsDir: string,
  snapshotFile: string
): Promise<LocalBaseline> {
  const migrations = await discoverMigrations({
    migrationsDir,
    snapshotFile,
    validateLineage: true,
  });
  const migration = migrations[0];
  if (
    migrations.length !== 1 ||
    !migration ||
    migration.fromSnapshot !== undefined ||
    migration.toSnapshot === undefined
  ) {
    throw new MigrationError({
      kind: 'INVALID_HISTORY',
      exitCode: 1,
      message: 'Baseline adoption requires exactly one initial generated migration.',
    });
  }
  const snapshot = await readSnapshot(snapshotFile);
  const snapshotHash = hashSnapshotBytes(snapshot.bytes);
  if (migration.toSnapshot !== snapshotHash) {
    throw new MigrationError({
      kind: 'INVALID_HISTORY',
      exitCode: 1,
      message: 'The baseline migration does not match the canonical snapshot.',
    });
  }
  return { migration, desired: snapshot.snapshot, snapshotHash };
}

/** Rejects any local descriptor or snapshot change observed after lock acquisition. */
function requireSameLocalBaseline(expected: LocalBaseline, actual: LocalBaseline): void {
  if (
    expected.snapshotHash !== actual.snapshotHash ||
    !sameMigration(expected.migration, actual.migration)
  ) {
    throw new MigrationError({
      kind: 'INVALID_HISTORY',
      exitCode: 1,
      message: 'Local baseline history changed during adoption.',
    });
  }
}

/** Compares every immutable field used by adoption and the normal runner. */
function sameMigration(left: MigrationDescriptor, right: MigrationDescriptor): boolean {
  return (
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

/** Extracts only display-safe connection identity fields. */
function safeTarget(databaseUrl: string): Pick<AdoptionPreview, 'host' | 'port' | 'user'> {
  try {
    const parsed = new URL(databaseUrl);
    return {
      host: parsed.hostname,
      port: parsed.port || '5432',
      user: decodeURIComponent(parsed.username),
    };
  } catch {
    throw new MigrationError({
      kind: 'CONFIGURATION',
      exitCode: 2,
      message: 'Database URL is not a valid PostgreSQL connection URL.',
    });
  }
}

/** Reads one sanitized target identity from the locked connection. */
async function currentDatabase(client: PoolClient): Promise<string> {
  const result = await client.query<{ database: string }>('SELECT current_database() AS database');
  const database = result.rows[0]?.database;
  if (typeof database !== 'string' || database.length === 0) {
    throw databaseError('Could not identify the PostgreSQL adoption target.');
  }
  return database;
}

/** Requires the exact target and baseline attestation before any ledger transaction. */
function requireConfirmation(
  confirmation: string | undefined,
  database: string,
  migrationId: string
): void {
  if (confirmation !== `${database}/${migrationId}`) {
    throw new MigrationError({
      kind: 'CONFIGURATION',
      exitCode: 2,
      message:
        'Adoption requires exact target confirmation after application and admin DDL is quiesced.',
    });
  }
}

/** Reads supported and unmanaged state through the same locked database session. */
async function compareCurrentCatalog(
  client: PoolClient,
  desired: SchemaSnapshotV1
): Promise<readonly CatalogComparisonItem[]> {
  const live = await projectPostgreSqlCatalog(client);
  const unmanaged = await readUnmanagedCatalogObjects(client);
  return compareCatalogs(desired, live, unmanaged).items;
}

/** Stops before mutation and reports the first stable qualified incompatibility. */
function requireCompatible(comparison: readonly CatalogComparisonItem[]): void {
  const mismatch =
    comparison.find(item => item.classification === 'UNSUPPORTED_FOR_ADOPTION') ??
    comparison.find(item => item.classification !== 'MATCH' && item.classification !== 'UNMANAGED');
  if (mismatch) {
    throw new MigrationError({
      kind: 'UNSUPPORTED',
      exitCode: 1,
      message: `${mismatch.classification}: ${mismatch.identity}. Baseline adoption was not changed.`,
    });
  }
}

/** Rechecks catalog and ledger atomically before recording the initial lineage. */
async function adoptInsideTransaction(
  client: PoolClient,
  migrationsDir: string,
  snapshotFile: string,
  local: LocalBaseline
): Promise<readonly CatalogComparisonItem[]> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    const comparison = await compareCurrentCatalog(client, local.desired);
    requireCompatible(comparison);
    requireSameLocalBaseline(local, await readOnlyBaseline(migrationsDir, snapshotFile));
    if ((await readMigrationLedger(client)).length > 0) {
      throw new MigrationError({
        kind: 'INVALID_HISTORY',
        exitCode: 1,
        message: 'Baseline adoption requires an absent or empty migration ledger.',
      });
    }
    await ensureMigrationLedger(client);
    await insertAppliedMigration(client, local.migration, 0);
    await client.query('COMMIT');
    return comparison;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      throw databaseError('Baseline adoption failed and its transaction session was lost.');
    }
    throw error;
  }
}

/** Creates a sanitized provider failure that never retains a connection URL. */
function databaseError(message: string): MigrationError {
  return new MigrationError({ kind: 'DATABASE', exitCode: 1, message });
}
