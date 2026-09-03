import { mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { publishArtifactPair } from './artifact-writer.js';
import { loadConfiguredSchema, loadMigrationConfig } from './config.js';
import { MigrationError } from './errors.js';
import { discoverMigrations, parseMigrationBytes } from './migration-file.js';
import { renderMigrationSql } from './migration-sql.js';
import { normalizeDatabaseSchema } from './schema-normalizer.js';
import { diffSnapshots } from './schema-diff.js';
import type { RenameHint, SchemaChange } from './schema-diff.js';
import { hashSnapshotBytes, readSnapshot, serializeSnapshot } from './snapshot.js';
import type { SchemaSnapshotV1 } from './snapshot-types.js';
import type { MigrationDescriptor } from './types.js';

/** Options for one offline desired-schema migration generation. */
export interface GenerateMigrationOptions {
  /** Lowercase migration slug. */
  readonly name: string;
  /** Explicit configuration file or discovery directory. */
  readonly configPath?: string;
  /** Explicit one-to-one table or column renames. */
  readonly renameHints?: readonly RenameHint[];
  /** Allows only targeted changes already classified as destructive. */
  readonly allowDestructive?: boolean;
  /** Deterministic clock used by tests and embedding callers. */
  readonly now?: Date;
}

/** Result from one offline generation attempt. */
export interface GenerateMigrationResult {
  /** Whether a pair was published or desired state was already current. */
  readonly status: 'GENERATED' | 'UP_TO_DATE';
  /** Published migration descriptor when state changed. */
  readonly migration?: MigrationDescriptor;
  /** Hash of the prior comparison state. */
  readonly previousSnapshot: string;
  /** Hash of the desired comparison state. */
  readonly desiredSnapshot: string;
  /** Complete reviewed semantic change list. */
  readonly changes: readonly SchemaChange[];
}

/**
 * Generates and atomically publishes reviewed SQL plus a canonical desired-state snapshot.
 *
 * This operation is offline: it imports the configured schema module but never opens a database
 * connection or compares against a live catalog.
 *
 * @param options - Name, config, hints, approval, and optional deterministic clock.
 * @returns Generated artifact metadata or `UP_TO_DATE` without rewriting files.
 * @throws {MigrationError} When input, history, or a requested automatic change is unsafe.
 *
 * @example
 * ```ts
 * const result = await generateMigration({ name: 'add-customer-email' });
 * if (result.status === 'GENERATED') console.log(result.migration?.id);
 * ```
 */
export async function generateMigration(
  options: GenerateMigrationOptions
): Promise<GenerateMigrationResult> {
  return generateMigrationArtifacts(options, false);
}

/**
 * Generates the first immutable lineage artifact while requiring no prior snapshot or history.
 *
 * This narrow entry point lets baseline generation share the normal renderer and atomic writer
 * without exposing baseline-specific switches in the public incremental-generation options.
 */
export async function generateInitialMigration(
  options: GenerateMigrationOptions
): Promise<GenerateMigrationResult> {
  return generateMigrationArtifacts(options, true);
}

/** Composes the shared offline generation pipeline for incremental and initial artifacts. */
async function generateMigrationArtifacts(
  options: GenerateMigrationOptions,
  requireInitialLineage: boolean
): Promise<GenerateMigrationResult> {
  assertSlug(options.name);
  const config = await loadMigrationConfig({ command: 'generate', configPath: options.configPath });
  const desiredSchema = normalizeDatabaseSchema(await loadConfiguredSchema(config));
  const desiredBytes = serializeSnapshot(desiredSchema);
  const desiredHash = hashSnapshotBytes(desiredBytes);
  const prior = await loadPriorSnapshot(config.snapshotFile, desiredSchema.defaultSchema);
  const previousHash = hashSnapshotBytes(prior.bytes);

  const history = await discoverMigrations({
    migrationsDir: config.migrationsDir,
    snapshotFile: config.snapshotFile,
    validateLineage: prior.exists,
  });
  if (requireInitialLineage && (prior.exists || history.length > 0)) {
    throw invalidHistory('Baseline generation requires no snapshot or up migration history.');
  }
  if (!prior.exists && history.length > 0) {
    throw invalidHistory('Migration history exists without its canonical snapshot.');
  }

  const diff = diffSnapshots(prior.snapshot, desiredSchema, options.renameHints);
  if (diff.changes.length === 0 && !requireInitialLineage) {
    return {
      status: 'UP_TO_DATE',
      previousSnapshot: previousHash,
      desiredSnapshot: desiredHash,
      changes: diff.changes,
    };
  }

  const body =
    diff.changes.length === 0
      ? 'SELECT 1;\n'
      : renderMigrationSql(diff.changes, {
          allowDestructive: options.allowDestructive,
        });
  const now = options.now ?? new Date();
  if (Number.isNaN(now.valueOf())) throw configurationError('Migration timestamp is invalid.');
  const id = `${formatTimestamp(now)}_${options.name}`;
  const transactional = !diff.changes.some(
    change => change.kind === 'index.add' && change.definition?.concurrent === true
  );
  const migrationBytes = Buffer.from(
    migrationSql(id, transactional, prior.exists ? previousHash : undefined, desiredHash, body)
  );
  const migrationPath = join(config.migrationsDir, `${id}.up.sql`);
  const latest = history.at(-1);
  if (latest && id <= latest.id) {
    throw invalidHistory('New migration identifiers must follow existing history.');
  }
  const parsed = parseMigrationBytes(basename(migrationPath), migrationBytes, migrationPath);
  const descriptor: MigrationDescriptor = {
    id: parsed.id,
    upPath: migrationPath,
    checksum: parsed.checksum,
    transactional: parsed.transactional,
    ...(parsed.fromSnapshot ? { fromSnapshot: parsed.fromSnapshot } : {}),
    ...(parsed.toSnapshot ? { toSnapshot: parsed.toSnapshot } : {}),
  };

  await mkdir(config.migrationsDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(config.snapshotFile), { recursive: true, mode: 0o700 });
  await publishArtifactPair({
    migrationPath,
    migrationBytes,
    snapshotPath: config.snapshotFile,
    snapshotBytes: desiredBytes,
  });

  return {
    status: 'GENERATED',
    migration: descriptor,
    previousSnapshot: previousHash,
    desiredSnapshot: desiredHash,
    changes: diff.changes,
  };
}

/** Prior snapshot data plus whether its bytes were already committed. */
interface PriorSnapshot {
  readonly snapshot: SchemaSnapshotV1;
  readonly bytes: Uint8Array;
  readonly exists: boolean;
}

/** Reads committed state or creates an in-memory empty comparison state. */
async function loadPriorSnapshot(path: string, defaultSchema: string): Promise<PriorSnapshot> {
  try {
    const prior = await readSnapshot(path);
    return { ...prior, exists: true };
  } catch (error) {
    if (!(error instanceof MigrationError) || !error.message.includes('does not exist'))
      throw error;
    const snapshot: SchemaSnapshotV1 = {
      formatVersion: 1,
      defaultSchema,
      extensions: [],
      schemas: [{ name: defaultSchema }],
      tables: [],
      views: [],
    };
    return { snapshot, bytes: serializeSnapshot(snapshot), exists: false };
  }
}

/** Builds one strict generated migration file. */
function migrationSql(
  id: string,
  transactional: boolean,
  fromSnapshot: string | undefined,
  toSnapshot: string,
  body: string
): string {
  return [
    '-- blendsdk-migration: 1',
    `-- id: ${id}`,
    `-- transaction: ${transactional}`,
    `-- from-snapshot: ${fromSnapshot ?? 'none'}`,
    `-- to-snapshot: ${toSnapshot}`,
    body.trimEnd(),
    '',
  ].join('\n');
}

/** Validates the immutable filename slug before any import or write. */
function assertSlug(value: string): void {
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(value)) {
    throw configurationError('Migration name must be a lowercase slug.');
  }
}

/** Formats one UTC instant as the sortable migration prefix. */
function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:T]/gu, '').slice(0, 14);
}

/** Creates a stable usage error. */
function configurationError(message: string): MigrationError {
  return new MigrationError({ kind: 'CONFIGURATION', exitCode: 2, message });
}

/** Creates a stable local-history validation error. */
function invalidHistory(message: string): MigrationError {
  return new MigrationError({ kind: 'INVALID_HISTORY', exitCode: 1, message });
}
