import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { MigrationError } from './errors.js';
import type { MigrationDescriptor } from './types.js';

const MIGRATION_ID_PATTERN = /^(\d{14})_([a-z][a-z0-9-]{0,62})$/u;
const MIGRATION_FILENAME_PATTERN = /^(\d{14}_[a-z][a-z0-9-]{0,62})\.(up|down)\.sql$/u;
const SNAPSHOT_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const SINGLE_TOKEN_TRANSACTION_COMMANDS = new Set([
  'ABORT',
  'BEGIN',
  'COMMIT',
  'END',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
]);
const TWO_TOKEN_TRANSACTION_COMMANDS = new Map([
  ['PREPARE', 'TRANSACTION'],
  ['SET', 'TRANSACTION'],
  ['START', 'TRANSACTION'],
]);

/** Direction encoded by a migration SQL filename. */
export type MigrationDirection = 'up' | 'down';

/** Exact metadata parsed from one migration SQL file. */
export interface ParsedMigrationFile {
  /** Sortable migration identifier. */
  readonly id: string;
  /** File direction encoded by the suffix. */
  readonly direction: MigrationDirection;
  /** Absolute path to the parsed file. */
  readonly path: string;
  /** Absolute path when this is an up file. */
  readonly upPath?: string;
  /** Absolute path when this is a down file. */
  readonly downPath?: string;
  /** Exact-byte SHA-256 for this file. */
  readonly checksum: string;
  /** Whether the runner owns a transaction around this file. */
  readonly transactional: boolean;
  /** Prior desired-state snapshot hash, when generated. */
  readonly fromSnapshot?: string;
  /** Resulting desired-state snapshot hash, when generated. */
  readonly toSnapshot?: string;
}

/** Options controlling deterministic migration discovery. */
export interface DiscoverMigrationsOptions {
  /** Directory containing migration SQL files. */
  readonly migrationsDir: string;
  /** Snapshot path to ignore during discovery and optionally verify. */
  readonly snapshotFile?: string;
  /** Whether to prove that the newest generated lineage matches snapshot bytes. */
  readonly validateLineage?: boolean;
}

/** Options for creating a developer-authored manual migration template. */
export interface CreateManualMigrationOptions {
  /** Directory where immutable migration files are stored. */
  readonly migrationsDir: string;
  /** Valid lowercase migration slug. */
  readonly name: string;
  /** Whether to create a matching local down template. */
  readonly withDown?: boolean;
  /** Whether the runner must wrap each template in its own transaction. */
  readonly transactional?: boolean;
  /** Timestamp used for the sortable identifier; defaults to the current instant. */
  readonly now?: Date;
}

/**
 * Parses and validates one immutable migration SQL file.
 *
 * @param path - Up or down migration path.
 * @returns Exact metadata and checksum derived from the file bytes.
 * @throws {MigrationError} When the filename, bytes, header, body, or transaction boundary is invalid.
 */
export async function parseMigrationFile(path: string): Promise<ParsedMigrationFile> {
  const absolutePath = resolve(path);
  const filename = basename(absolutePath);
  await assertRegularFile(absolutePath);
  const bytes = await readFile(absolutePath);
  return parseMigrationBytes(filename, bytes, absolutePath);
}

/**
 * Validates prospective migration bytes before they receive a public filesystem name.
 *
 * @param filename - Exact final migration filename.
 * @param bytes - Complete prospective file bytes.
 * @param path - Final path recorded in the returned descriptor.
 * @returns Parsed strict metadata and exact-byte checksum.
 */
export function parseMigrationBytes(
  filename: string,
  bytes: Uint8Array,
  path: string
): ParsedMigrationFile {
  const filenameMatch = MIGRATION_FILENAME_PATTERN.exec(filename);
  if (!filenameMatch) throw invalidHistory(`Invalid migration filename: ${filename}.`);

  const source = Buffer.from(bytes);
  const sql = decodeSql(source, filename);
  const id = filenameMatch[1];
  const direction = parseDirection(filenameMatch[2]);
  assertValidMigrationId(id);

  const parsedHeader = parseHeader(sql, id);
  if (parsedHeader.transactional) validateTransactionalSql(parsedHeader.body);

  return {
    id,
    direction,
    path,
    ...(direction === 'up' ? { upPath: path } : { downPath: path }),
    checksum: sha256(source),
    transactional: parsedHeader.transactional,
    ...(parsedHeader.fromSnapshot ? { fromSnapshot: parsedHeader.fromSnapshot } : {}),
    ...(parsedHeader.toSnapshot ? { toSnapshot: parsedHeader.toSnapshot } : {}),
  };
}

/**
 * Discovers ordered migration pairs and optionally verifies snapshot lineage.
 *
 * @param options - Directory, snapshot, and lineage-validation settings.
 * @returns Immutable descriptors ordered by migration identifier.
 * @throws {MigrationError} When directory contents or lineage are ambiguous.
 */
export async function discoverMigrations(
  options: DiscoverMigrationsOptions
): Promise<readonly MigrationDescriptor[]> {
  const migrationsDir = resolve(options.migrationsDir);
  const snapshotPath = options.snapshotFile ? resolve(options.snapshotFile) : undefined;
  const snapshotName = snapshotPath ? basename(snapshotPath) : undefined;
  const entries = await readDirectory(migrationsDir);
  const caseFoldedNames = new Set<string>();
  const pairs = new Map<string, { up?: ParsedMigrationFile; down?: ParsedMigrationFile }>();

  for (const entry of entries) {
    if (entry.name === snapshotName || entry.name.startsWith('.')) continue;
    if (!entry.name.toLowerCase().endsWith('.sql')) continue;

    const caseFoldedName = entry.name.toLowerCase();
    if (caseFoldedNames.has(caseFoldedName)) {
      throw invalidHistory(`Case-folded duplicate migration filename: ${entry.name}.`);
    }
    caseFoldedNames.add(caseFoldedName);

    if (!entry.isFile()) {
      throw invalidHistory(`Migration SQL must be a regular file: ${entry.name}.`);
    }
    if (!MIGRATION_FILENAME_PATTERN.test(entry.name)) {
      throw invalidHistory(`Unexpected SQL file in migration directory: ${entry.name}.`);
    }

    const parsed = await parseMigrationFile(join(migrationsDir, entry.name));
    const pair = pairs.get(parsed.id) ?? {};
    if (pair[parsed.direction]) {
      throw invalidHistory(`Duplicate ${parsed.direction} migration: ${parsed.id}.`);
    }
    pair[parsed.direction] = parsed;
    pairs.set(parsed.id, pair);
  }

  const descriptors: MigrationDescriptor[] = [];
  for (const id of [...pairs.keys()].sort()) {
    const pair = pairs.get(id);
    if (!pair?.up) throw invalidHistory(`Down migration has no matching up file: ${id}.`);
    if (pair.down) validateDownLineage(pair.up, pair.down);
    descriptors.push({
      id,
      upPath: pair.up.path,
      ...(pair.down ? { downPath: pair.down.path } : {}),
      checksum: pair.up.checksum,
      ...(pair.down ? { downChecksum: pair.down.checksum } : {}),
      transactional: pair.up.transactional,
      ...(pair.down ? { downTransactional: pair.down.transactional } : {}),
      ...(pair.up.fromSnapshot ? { fromSnapshot: pair.up.fromSnapshot } : {}),
      ...(pair.up.toSnapshot ? { toSnapshot: pair.up.toSnapshot } : {}),
    });
  }

  validateGeneratedLineage(descriptors);
  if (options.validateLineage) await validateSnapshotLineage(descriptors, snapshotPath);
  return descriptors;
}

/**
 * Rejects transaction-control statements in SQL whose transaction belongs to the runner.
 *
 * The scanner recognizes only lexical boundaries needed for this safety check. It deliberately
 * does not parse expressions, DDL, or procedural SQL semantics.
 *
 * @param sql - Exact migration SQL body.
 * @throws {MigrationError} For transaction control or malformed quoted/commented input.
 */
export function validateTransactionalSql(sql: string): void {
  scanSql(sql, true);
}

/**
 * Creates valid no-op manual migration templates with null snapshot lineage.
 *
 * The conspicuous no-op keeps the strict file contract valid while requiring review before the
 * template is committed. Existing targets are never overwritten.
 *
 * @param options - Template name, directory, direction, transaction, and clock settings.
 * @returns Descriptor for the newly created up file and optional down file.
 * @throws {MigrationError} When the name, clock, directory, or exclusive write is invalid.
 */
export async function createManualMigration(
  options: CreateManualMigrationOptions
): Promise<MigrationDescriptor> {
  assertValidSlug(options.name);
  const now = options.now ?? new Date();
  if (Number.isNaN(now.valueOf())) throw invalidHistory('Manual migration timestamp is invalid.');

  const id = `${formatTimestamp(now)}_${options.name}`;
  assertValidMigrationId(id);
  const migrationsDir = resolve(options.migrationsDir);
  await mkdir(migrationsDir, { recursive: true, mode: 0o700 });
  const directoryStats = await lstat(migrationsDir);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw filesystemError('Migration directory must be a real directory.');
  }

  const transactional = options.transactional ?? true;
  const upPath = join(migrationsDir, `${id}.up.sql`);
  const downPath = options.withDown ? join(migrationsDir, `${id}.down.sql`) : undefined;
  const upBytes = Buffer.from(manualTemplate(id, transactional, 'up'));
  let upIdentity: FileIdentity | undefined;
  try {
    upIdentity = await writeExclusiveFile(upPath, upBytes);
    if (downPath) {
      await writeExclusiveFile(downPath, Buffer.from(manualTemplate(id, transactional, 'down')));
    }
  } catch (error) {
    if (upIdentity) await removeOwnedFile(upPath, upIdentity);
    throw filesystemError(error instanceof Error ? error.message : 'Could not create migration.');
  }

  return {
    id,
    upPath,
    ...(downPath ? { downPath } : {}),
    checksum: sha256(upBytes),
    ...(downPath
      ? { downChecksum: sha256(Buffer.from(manualTemplate(id, transactional, 'down'))) }
      : {}),
    transactional,
    ...(options.withDown ? { downTransactional: transactional } : {}),
  };
}

/** Stable filesystem identity used to avoid deleting a concurrently replaced file. */
interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

/** Exclusively writes one manual file and records the inode owned by this process. */
async function writeExclusiveFile(path: string, bytes: Uint8Array): Promise<FileIdentity> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    const stats = await handle.stat();
    return { device: stats.dev, inode: stats.ino };
  } finally {
    await handle.close();
  }
}

/** Removes a manual file after failure only when its inode is still owned by this invocation. */
async function removeOwnedFile(path: string, expected: FileIdentity): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.dev === expected.device && stats.ino === expected.inode) await rm(path);
  } catch {
    // Missing or replaced paths belong to another actor and are never cleanup targets.
  }
}

/** Header fields plus the exact SQL body. */
interface ParsedHeader {
  readonly transactional: boolean;
  readonly fromSnapshot?: string;
  readonly toSnapshot?: string;
  readonly body: string;
}

/** Parses the five fixed metadata lines without accepting aliases or reordering. */
function parseHeader(sql: string, expectedId: string): ParsedHeader {
  const lines = sql.split('\n');
  if (lines.length < 7) throw invalidHistory('Migration must contain the v1 header and SQL body.');
  if (lines[0] !== '-- blendsdk-migration: 1')
    throw invalidHistory('Invalid migration version header.');
  if (lines[1] !== `-- id: ${expectedId}`)
    throw invalidHistory('Migration header ID must match its filename.');

  const transaction = exactHeaderValue(lines[2], '-- transaction: ');
  if (transaction !== 'true' && transaction !== 'false') {
    throw invalidHistory('Migration transaction metadata must be true or false.');
  }
  const fromSnapshot = parseSnapshotHash(exactHeaderValue(lines[3], '-- from-snapshot: '));
  const toSnapshot = parseSnapshotHash(exactHeaderValue(lines[4], '-- to-snapshot: '));
  const body = lines.slice(5).join('\n');
  if (!scanSql(body, false))
    throw invalidHistory('Migration SQL body must contain a non-comment token.');

  return {
    transactional: transaction === 'true',
    ...(fromSnapshot ? { fromSnapshot } : {}),
    ...(toSnapshot ? { toSnapshot } : {}),
    body,
  };
}

/** Requires one exact header prefix and returns its value. */
function exactHeaderValue(line: string | undefined, prefix: string): string {
  if (!line?.startsWith(prefix) || line.slice(prefix.length).length === 0) {
    throw invalidHistory(`Missing or reordered migration header: ${prefix.trim()}.`);
  }
  return line.slice(prefix.length);
}

/** Converts `none` or one lowercase SHA-256 into optional lineage. */
function parseSnapshotHash(value: string): string | undefined {
  if (value === 'none') return undefined;
  if (!SNAPSHOT_HASH_PATTERN.test(value)) throw invalidHistory('Invalid snapshot hash metadata.');
  return value;
}

/** Decodes exact UTF-8 and enforces the repository's stable line-ending contract. */
function decodeSql(bytes: Buffer, filename: string): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw invalidHistory(`Migration must not contain a UTF-8 BOM: ${filename}.`);
  }
  let sql: string;
  try {
    sql = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalidHistory(`Migration is not valid UTF-8: ${filename}.`);
  }
  if (sql.includes('\r') || !sql.endsWith('\n')) {
    throw invalidHistory(`Migration must use LF endings and end with LF: ${filename}.`);
  }
  return sql;
}

/** Scans PostgreSQL comments and quoted forms while tracking statement-leading words. */
function scanSql(sql: string, rejectTransactionControl: boolean): boolean {
  let index = 0;
  let hasToken = false;
  let statementStart = true;
  let pendingSecondWord: string | undefined;

  const acceptToken = (word?: string): void => {
    hasToken = true;
    if (pendingSecondWord) {
      if (word === pendingSecondWord && rejectTransactionControl) {
        throw invalidHistory('Transactional migration SQL must not control transactions.');
      }
      pendingSecondWord = undefined;
      statementStart = false;
      return;
    }
    if (!statementStart) return;
    statementStart = false;
    if (!word) return;
    if (SINGLE_TOKEN_TRANSACTION_COMMANDS.has(word) && rejectTransactionControl) {
      throw invalidHistory('Transactional migration SQL must not control transactions.');
    }
    const secondWord = TWO_TOKEN_TRANSACTION_COMMANDS.get(word);
    if (secondWord) pendingSecondWord = secondWord;
  };

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === '-' && next === '-') {
      const newline = sql.indexOf('\n', index + 2);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index = scanBlockComment(sql, index);
      continue;
    }
    if (char === ';') {
      statementStart = true;
      pendingSecondWord = undefined;
      index += 1;
      continue;
    }

    const prefixedQuote = quotedStringPrefix(sql, index);
    if (prefixedQuote) {
      const quoteIndex = index + prefixedQuote.length;
      index = scanQuoted(sql, quoteIndex, "'", prefixedQuote.backslashEscapes);
      acceptToken();
      continue;
    }
    if (char === "'") {
      index = scanQuoted(sql, index, "'", false);
      acceptToken();
      continue;
    }
    if (char === '"') {
      index = scanQuoted(sql, index, '"', false);
      acceptToken();
      continue;
    }
    if (char === '$') {
      const dollarEnd = scanDollarQuote(sql, index);
      if (dollarEnd !== undefined) {
        index = dollarEnd;
        acceptToken();
        continue;
      }
    }
    if (/[A-Za-z_]/u.test(char)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/u.test(sql[end])) end += 1;
      acceptToken(sql.slice(index, end).toUpperCase());
      index = end;
      continue;
    }

    acceptToken();
    index += 1;
  }
  return hasToken;
}

/** Consumes a nested PostgreSQL block comment and fails closed when it never terminates. */
function scanBlockComment(sql: string, start: number): number {
  let depth = 1;
  let index = start + 2;
  while (index < sql.length && depth > 0) {
    if (sql[index] === '/' && sql[index + 1] === '*') {
      depth += 1;
      index += 2;
    } else if (sql[index] === '*' && sql[index + 1] === '/') {
      depth -= 1;
      index += 2;
    } else {
      index += 1;
    }
  }
  if (depth !== 0) throw invalidHistory('Migration SQL contains an unterminated block comment.');
  return index;
}

/** Consumes one single-quoted literal or double-quoted identifier. */
function scanQuoted(
  sql: string,
  start: number,
  quote: "'" | '"',
  backslashEscapes: boolean
): number {
  let index = start + 1;
  while (index < sql.length) {
    if (backslashEscapes && sql[index] === '\\') {
      index += 2;
      continue;
    }
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  throw invalidHistory('Migration SQL contains an unterminated quoted value.');
}

/** Metadata needed to consume one PostgreSQL prefixed string. */
interface QuotedStringPrefix {
  readonly length: number;
  readonly backslashEscapes: boolean;
}

/** Returns PostgreSQL prefixed-string metadata at one token boundary. */
function quotedStringPrefix(sql: string, index: number): QuotedStringPrefix | undefined {
  const previous = index > 0 ? sql[index - 1] : undefined;
  if (previous && /[A-Za-z0-9_$]/u.test(previous)) return undefined;
  if ((sql[index] === 'E' || sql[index] === 'e') && sql[index + 1] === "'") {
    return { length: 1, backslashEscapes: true };
  }
  if (
    (sql[index] === 'U' || sql[index] === 'u') &&
    sql[index + 1] === '&' &&
    sql[index + 2] === "'"
  ) {
    return { length: 2, backslashEscapes: false };
  }
  if (/^[BbXx]$/u.test(sql[index]) && sql[index + 1] === "'") {
    return { length: 1, backslashEscapes: false };
  }
  return undefined;
}

/** Consumes one dollar-quoted body when the current dollar sign starts a valid tag. */
function scanDollarQuote(sql: string, start: number): number | undefined {
  const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(sql.slice(start));
  if (!match) return undefined;
  const tag = match[0];
  const end = sql.indexOf(tag, start + tag.length);
  if (end === -1) throw invalidHistory('Migration SQL contains an unterminated dollar quote.');
  return end + tag.length;
}

/** Proves that each generated migration continues the last known generated snapshot hash. */
function validateGeneratedLineage(descriptors: readonly MigrationDescriptor[]): void {
  let lastGeneratedHash: string | undefined;
  let hasGeneratedMigration = false;
  for (const descriptor of descriptors) {
    if (!descriptor.fromSnapshot && !descriptor.toSnapshot) continue;
    if (
      !descriptor.toSnapshot ||
      (hasGeneratedMigration && descriptor.fromSnapshot !== lastGeneratedHash)
    ) {
      throw invalidHistory(`Generated snapshot lineage is disconnected at ${descriptor.id}.`);
    }
    hasGeneratedMigration = true;
    lastGeneratedHash = descriptor.toSnapshot;
  }
}

/** Proves inverse lineage for an optional down file. */
function validateDownLineage(up: ParsedMigrationFile, down: ParsedMigrationFile): void {
  if (down.fromSnapshot !== up.toSnapshot || down.toSnapshot !== up.fromSnapshot) {
    throw invalidHistory(`Down migration lineage does not invert its up migration: ${up.id}.`);
  }
}

/** Compares the newest generated target hash with the exact current snapshot bytes. */
async function validateSnapshotLineage(
  descriptors: readonly MigrationDescriptor[],
  snapshotPath: string | undefined
): Promise<void> {
  const expectedHash = [...descriptors].reverse().find(item => item.toSnapshot)?.toSnapshot;
  if (!expectedHash) return;
  const actualHash = snapshotPath ? await readOptionalSnapshotHash(snapshotPath) : undefined;
  if (actualHash !== expectedHash) {
    throw invalidHistory(
      'Migration/snapshot lineage is torn. Remove the orphan migration or restore the snapshot from version control.'
    );
  }
}

/** Reads an optional snapshot without treating a missing first snapshot as a filesystem failure. */
async function readOptionalSnapshotHash(path: string): Promise<string | undefined> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw invalidHistory(`Snapshot path must be a regular file: ${path}.`);
    }
    return sha256(await readFile(path));
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

/** Ensures a path is one real regular file before reading executable SQL. */
async function assertRegularFile(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw invalidHistory(`Migration path must be a regular file: ${path}.`);
    }
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT'))
      throw invalidHistory(`Migration file does not exist: ${path}.`);
    throw error;
  }
}

/** Reads a migration directory without converting missing paths into empty history. */
async function readDirectory(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return [];
    throw filesystemError(error instanceof Error ? error.message : 'Could not read migrations.');
  }
}

/** Validates identifier syntax and its UTC timestamp component. */
function assertValidMigrationId(id: string): void {
  const match = MIGRATION_ID_PATTERN.exec(id);
  if (!match || !isValidTimestamp(match[1]))
    throw invalidHistory(`Invalid migration identifier: ${id}.`);
}

/** Narrows a filename suffix to the supported migration directions. */
function parseDirection(value: string): MigrationDirection {
  if (value === 'up' || value === 'down') return value;
  throw invalidHistory(`Invalid migration direction: ${value}.`);
}

/** Validates the developer-supplied lowercase slug. */
function assertValidSlug(slug: string): void {
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(slug))
    throw invalidHistory(`Invalid migration slug: ${slug}.`);
}

/** Checks that all timestamp fields round-trip through UTC without normalization. */
function isValidTimestamp(timestamp: string): boolean {
  const year = Number(timestamp.slice(0, 4));
  const month = Number(timestamp.slice(4, 6));
  const day = Number(timestamp.slice(6, 8));
  const hour = Number(timestamp.slice(8, 10));
  const minute = Number(timestamp.slice(10, 12));
  const second = Number(timestamp.slice(12, 14));
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return formatTimestamp(date) === timestamp;
}

/** Formats one Date as the fourteen-digit UTC migration prefix. */
function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:T]/gu, '').slice(0, 14);
}

/** Creates a strict manual file whose body is valid and harmless until reviewed. */
function manualTemplate(id: string, transactional: boolean, direction: MigrationDirection): string {
  return [
    '-- blendsdk-migration: 1',
    `-- id: ${id}`,
    `-- transaction: ${transactional}`,
    '-- from-snapshot: none',
    '-- to-snapshot: none',
    `-- Replace this ${direction} no-op with reviewed migration SQL before committing.`,
    'SELECT 1;',
    '',
  ].join('\n');
}

/** Computes lowercase SHA-256 from exact bytes. */
function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Narrows an unknown exception to one exact Node.js error code. */
function hasErrorCode(error: unknown, code: string): error is Error & { readonly code: string } {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Creates a stable local-history validation error. */
function invalidHistory(message: string): MigrationError {
  return new MigrationError({ kind: 'INVALID_HISTORY', exitCode: 1, message });
}

/** Creates a stable filesystem error without exposing SQL bytes. */
function filesystemError(message: string): MigrationError {
  return new MigrationError({ kind: 'FILESYSTEM', exitCode: 1, message });
}
