import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MigrationError } from './errors.js';
import type { SchemaSnapshotV1 } from './snapshot-types.js';
import { validateSchemaSnapshot } from './snapshot-types.js';

/**
 * Serializes validated canonical state as exact UTF-8 JSON bytes.
 *
 * The one serializer is shared by persisted snapshots, hashes, and structural comparisons.
 *
 * @param snapshot - Version-one canonical desired state.
 * @returns UTF-8 bytes with two-space indentation, LF endings, and one final LF.
 */
export function serializeSnapshot(snapshot: SchemaSnapshotV1): Uint8Array {
  const validated = validateSchemaSnapshot(snapshot);
  return Buffer.from(`${JSON.stringify(validated, null, 2)}\n`, 'utf8');
}

/**
 * Parses strict canonical snapshot bytes without executing their content.
 *
 * @param bytes - Untrusted file bytes.
 * @returns Validated version-one data.
 * @throws {MigrationError} For encoding, version, shape, or noncanonical-byte failures.
 */
export function parseSnapshotBytes(bytes: Uint8Array): SchemaSnapshotV1 {
  const source = Buffer.from(bytes);
  if (source.length >= 3 && source[0] === 0xef && source[1] === 0xbb && source[2] === 0xbf) {
    throw invalidSnapshot('Snapshot must not contain a UTF-8 BOM.');
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(source);
  } catch {
    throw invalidSnapshot('Snapshot is not valid UTF-8.');
  }
  if (text.includes('\r') || !text.endsWith('\n')) {
    throw invalidSnapshot('Snapshot must use LF endings and end with one LF.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidSnapshot('Snapshot is not valid JSON.');
  }
  if (isRecord(parsed) && parsed.formatVersion !== 1) {
    throw unsupportedSnapshot(
      'Snapshot format version is unsupported; upgrade BlendSDK before rewriting it.'
    );
  }

  let snapshot: SchemaSnapshotV1;
  try {
    snapshot = validateSchemaSnapshot(parsed);
  } catch {
    throw invalidSnapshot('Snapshot does not match the strict version-one schema.');
  }
  if (!source.equals(Buffer.from(serializeSnapshot(snapshot)))) {
    throw invalidSnapshot('Snapshot bytes are not in canonical version-one form.');
  }
  return snapshot;
}

/**
 * Reads one regular, non-symlink snapshot file and parses its exact bytes.
 *
 * @param path - Snapshot file path.
 * @returns Validated canonical state and its original exact bytes.
 */
export async function readSnapshot(
  path: string
): Promise<{ readonly snapshot: SchemaSnapshotV1; readonly bytes: Uint8Array }> {
  const absolutePath = resolve(path);
  try {
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw invalidSnapshot('Snapshot path must be a regular file.');
    }
    const bytes = await readFile(absolutePath);
    return { snapshot: parseSnapshotBytes(bytes), bytes };
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    if (hasErrorCode(error, 'ENOENT')) throw invalidSnapshot('Snapshot file does not exist.');
    throw filesystemError('Could not read snapshot file.');
  }
}

/**
 * Computes lowercase SHA-256 from the exact serialized bytes.
 *
 * @param bytes - Exact canonical snapshot bytes.
 * @returns Lowercase hexadecimal SHA-256.
 */
export function hashSnapshotBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Narrows JSON data without trusting its property types. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrows an unknown exception to one exact Node.js error code. */
function hasErrorCode(error: unknown, code: string): error is Error & { readonly code: string } {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Creates a stable invalid-history error for malformed persisted data. */
function invalidSnapshot(message: string): MigrationError {
  return new MigrationError({ kind: 'INVALID_HISTORY', exitCode: 1, message });
}

/** Creates an upgrade-oriented unsupported-version error. */
function unsupportedSnapshot(message: string): MigrationError {
  return new MigrationError({ kind: 'UNSUPPORTED', exitCode: 1, message });
}

/** Creates a stable safe filesystem error. */
function filesystemError(message: string): MigrationError {
  return new MigrationError({ kind: 'FILESYSTEM', exitCode: 1, message });
}
