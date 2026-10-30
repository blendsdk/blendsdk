import { randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { MigrationError } from './errors.js';

/** Exact artifact bytes and final paths for one generated migration/snapshot update. */
export interface ArtifactPair {
  /** Final path for the new immutable migration file. */
  readonly migrationPath: string;
  /** Complete migration bytes, including the versioned header. */
  readonly migrationBytes: Uint8Array;
  /** Final path for the desired-state snapshot. */
  readonly snapshotPath: string;
  /** Complete canonical snapshot bytes. */
  readonly snapshotBytes: Uint8Array;
}

/** Narrow filesystem seams used to prove caught durability and publication failures. */
export interface ArtifactWriterDependencies {
  /** Writes bytes to an exclusively created private file. */
  readonly write?: (handle: FileHandle, bytes: Uint8Array) => Promise<void>;
  /** Flushes one complete private file to its storage device. */
  readonly sync?: (handle: FileHandle) => Promise<void>;
  /** Overrides both publication operations for deterministic rename-failure tests. */
  readonly rename?: (from: string, to: string) => Promise<void>;
  /** Overrides only snapshot publication while retaining production migration claiming. */
  readonly snapshotRename?: (from: string, to: string) => Promise<void>;
}

/** Tracks the private paths owned by one publication attempt. */
interface PublicationPaths {
  readonly migration: string;
  readonly snapshot: string;
}

/** Tracks which public path this process created and may therefore remove. */
interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

/** Tracks the public inode this process may remove after a caught snapshot failure. */
interface PublicationState {
  migrationIdentity?: FileIdentity;
}

/**
 * Publishes one migration and canonical snapshot with caught-failure rollback.
 *
 * Both files are written, flushed, and verified before either public path changes. If publishing
 * the snapshot fails, the migration created by this invocation is removed and the prior snapshot
 * remains untouched. A process crash between the two renames is detected later through lineage.
 *
 * @param pair - Exact final paths and bytes to publish.
 * @param dependencies - Narrow write, sync, and publication seams for deterministic failure tests.
 * @throws {MigrationError} When paths are unsafe, targets conflict, or publication fails.
 */
export async function publishArtifactPair(
  pair: ArtifactPair,
  dependencies: ArtifactWriterDependencies = {}
): Promise<void> {
  const migrationPath = resolve(pair.migrationPath);
  const snapshotPath = resolve(pair.snapshotPath);
  validateDistinctTargets(migrationPath, snapshotPath);
  await assertSafeTargets(migrationPath, snapshotPath);

  const temporaryPaths = createTemporaryPaths(migrationPath, snapshotPath);
  const state: PublicationState = {};

  try {
    const migrationIdentity = await writeDurableFile(
      temporaryPaths.migration,
      pair.migrationBytes,
      dependencies
    );
    await writeDurableFile(temporaryPaths.snapshot, pair.snapshotBytes, dependencies);
    await verifyBytes(temporaryPaths.migration, pair.migrationBytes);
    await verifyBytes(temporaryPaths.snapshot, pair.snapshotBytes);

    if (dependencies.rename) {
      await dependencies.rename(temporaryPaths.migration, migrationPath);
    } else {
      await link(temporaryPaths.migration, migrationPath);
    }
    state.migrationIdentity = migrationIdentity;
    await rm(temporaryPaths.migration, { force: true });
    await (dependencies.rename ?? dependencies.snapshotRename ?? rename)(
      temporaryPaths.snapshot,
      snapshotPath
    );
  } catch (error) {
    await rollbackOwnedFiles(temporaryPaths, migrationPath, state);
    if (error instanceof MigrationError) throw error;
    throw filesystemError(safeFilesystemContext(error));
  }
}

/** Prevents one artifact from replacing the other. */
function validateDistinctTargets(migrationPath: string, snapshotPath: string): void {
  if (migrationPath === snapshotPath) {
    throw filesystemError('Migration and snapshot targets must be different files.');
  }
}

/** Rejects symlink parents and prevents overwriting an immutable migration. */
async function assertSafeTargets(migrationPath: string, snapshotPath: string): Promise<void> {
  await assertRealDirectory(dirname(migrationPath), 'Migration directory');
  await assertRealDirectory(dirname(snapshotPath), 'Snapshot directory');

  const migrationStats = await optionalLstat(migrationPath);
  if (migrationStats)
    throw filesystemError(`Migration target already exists: ${basename(migrationPath)}.`);

  const snapshotStats = await optionalLstat(snapshotPath);
  if (snapshotStats && (snapshotStats.isSymbolicLink() || !snapshotStats.isFile())) {
    throw filesystemError('Snapshot target must be a regular file.');
  }
}

/** Requires one final target's parent to be a real directory. */
async function assertRealDirectory(path: string, label: string): Promise<void> {
  const stats = await safeLstat(path, label);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw filesystemError(`${label} must be a real directory.`);
  }
}

/** Creates unpredictable sibling names that can be cleaned without globs. */
function createTemporaryPaths(migrationPath: string, snapshotPath: string): PublicationPaths {
  const suffix = `${process.pid}-${randomUUID()}.tmp`;
  return {
    migration: `${dirname(migrationPath)}/.${basename(migrationPath)}.${suffix}`,
    snapshot: `${dirname(snapshotPath)}/.${basename(snapshotPath)}.${suffix}`,
  };
}

/** Exclusively writes, flushes, and closes one private file. */
async function writeDurableFile(
  path: string,
  bytes: Uint8Array,
  dependencies: ArtifactWriterDependencies
): Promise<FileIdentity> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await (dependencies.write ?? writeBytes)(handle, bytes);
    await (dependencies.sync ?? syncFile)(handle);
    const stats = await handle.stat();
    return { device: stats.dev, inode: stats.ino };
  } finally {
    await handle.close();
  }
}

/** Writes exact bytes through an already exclusive file handle. */
async function writeBytes(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  await handle.writeFile(bytes);
}

/** Flushes file content before a public name can reference it. */
async function syncFile(handle: FileHandle): Promise<void> {
  await handle.sync();
}

/** Re-reads one private file so publication never trusts a partial write. */
async function verifyBytes(path: string, expected: Uint8Array): Promise<void> {
  const actual = await readFile(path);
  if (!actual.equals(Buffer.from(expected))) {
    throw filesystemError(`Artifact verification failed: ${basename(path)}.`);
  }
}

/** Removes only paths explicitly created by this publication attempt. */
async function rollbackOwnedFiles(
  temporaryPaths: PublicationPaths,
  migrationPath: string,
  state: PublicationState
): Promise<void> {
  const targets = [temporaryPaths.migration, temporaryPaths.snapshot];
  for (const target of targets) {
    try {
      await rm(target, { force: true });
    } catch {
      // A failed cleanup leaves a dot-prefixed private file or an orphan detected by lineage.
    }
  }
  if (state.migrationIdentity) {
    await removeOwnedPublicFile(migrationPath, state.migrationIdentity);
  }
}

/** Removes a published migration only while its inode is still the one this process created. */
async function removeOwnedPublicFile(path: string, expected: FileIdentity): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.dev === expected.device && stats.ino === expected.inode) {
      await rm(path);
    }
  } catch {
    // Missing or externally replaced files are not owned cleanup targets.
  }
}

/** Reads path metadata while preserving a concise safe operator message. */
async function safeLstat(path: string, label: string) {
  try {
    return await lstat(path);
  } catch (error) {
    throw filesystemError(`${label} is unavailable: ${safeFilesystemContext(error)}`);
  }
}

/** Returns metadata when a target exists and only suppresses ENOENT. */
async function optionalLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw filesystemError(safeFilesystemContext(error));
  }
}

/** Narrows an unknown exception to one exact Node.js error code. */
function hasErrorCode(error: unknown, code: string): error is Error & { readonly code: string } {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Avoids including paths or file content from provider exceptions in normal output. */
function safeFilesystemContext(error: unknown): string {
  if (hasErrorCode(error, 'EEXIST')) return 'a target already exists';
  if (hasErrorCode(error, 'EACCES') || hasErrorCode(error, 'EPERM')) return 'permission denied';
  if (hasErrorCode(error, 'ENOENT')) return 'a required path does not exist';
  return 'filesystem operation failed';
}

/** Creates a stable filesystem error without retaining file content. */
function filesystemError(message: string): MigrationError {
  return new MigrationError({ kind: 'FILESYSTEM', exitCode: 1, message });
}
