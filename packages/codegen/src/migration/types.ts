/**
 * Commands exposed by the PostgreSQL migration workflow.
 *
 * Generation commands operate on committed files. Database commands consume those files and
 * never generate schema changes from a live database.
 */
export type MigrationCommand =
  'generate' | 'create' | 'up' | 'down' | 'status' | 'validate' | 'baseline' | 'adopt-baseline';

/**
 * User-authored settings from `blendsdk.migrations.ts`.
 *
 * Connection credentials are deliberately represented by an environment-variable name rather
 * than a URL so resolved configuration can be logged safely.
 *
 * @example
 * ```ts
 * const config: MigrationConfig = {
 *   schema: './src/database/schema.ts',
 *   migrationsDir: './migrations',
 * };
 * ```
 */
export interface MigrationConfig {
  /** Module whose default export is the desired database schema. */
  readonly schema?: string;
  /** Directory containing immutable migration SQL files. */
  readonly migrationsDir?: string;
  /** Canonical desired-state snapshot file. */
  readonly snapshotFile?: string;
  /** Environment variable containing the PostgreSQL connection URL. */
  readonly databaseUrlEnv?: string;
  /** Maximum time to wait for the migration advisory lock. */
  readonly lockTimeoutMs?: number;
  /** Maximum execution time for one migration. */
  readonly statementTimeoutMs?: number;
}

/** Validated settings with conventional values resolved to absolute paths. */
export interface ResolvedMigrationConfig {
  /** Absolute path of the loaded configuration file. */
  readonly configPath: string;
  /** Absolute directory containing the configuration file. */
  readonly configDirectory: string;
  /** Absolute schema-module path, when the command needs desired schema state. */
  readonly schema?: string;
  /** Absolute directory containing migration SQL files. */
  readonly migrationsDir: string;
  /** Absolute canonical snapshot path. */
  readonly snapshotFile: string;
  /** Environment variable containing the PostgreSQL connection URL. */
  readonly databaseUrlEnv: string;
  /** Maximum advisory-lock wait in milliseconds. */
  readonly lockTimeoutMs: number;
  /** Maximum statement execution time in milliseconds. */
  readonly statementTimeoutMs: number;
}

/**
 * Stable terminal states returned by migration status operations.
 *
 * `UNKNOWN_OUTCOME` requires operator investigation before another mutation is attempted.
 */
export type MigrationStatus =
  'UP_TO_DATE' | 'PENDING' | 'INVALID_HISTORY' | 'LOCKED' | 'UNKNOWN_OUTCOME';

/**
 * Safety classifications attached to generated schema changes.
 *
 * Only supported changes produce automatic SQL. Destructive changes additionally require an
 * explicit generation-time approval.
 */
export type MigrationSafety = 'safe' | 'caution' | 'destructive' | 'ambiguous' | 'unsupported';

/** Immutable metadata derived from one validated migration file pair. */
export interface MigrationDescriptor {
  /** Sortable migration identifier. */
  readonly id: string;
  /** Absolute path to the required up migration. */
  readonly upPath: string;
  /** Absolute path to the optional down migration. */
  readonly downPath?: string;
  /** Lowercase SHA-256 of the exact up-file bytes. */
  readonly checksum: string;
  /** Lowercase SHA-256 of the exact optional down-file bytes. */
  readonly downChecksum?: string;
  /** Whether the runner must own a transaction around the migration. */
  readonly transactional: boolean;
  /** Whether an optional down file must run transactionally. */
  readonly downTransactional?: boolean;
  /** Prior canonical snapshot hash, or undefined for manual/initial history. */
  readonly fromSnapshot?: string;
  /** Resulting canonical snapshot hash, or undefined for manual history. */
  readonly toSnapshot?: string;
}

/** Stable result shared by commands that report migration history state. */
export interface MigrationCommandResult {
  /** Terminal state observed by the command. */
  readonly status: MigrationStatus;
  /** Validated migrations relevant to the result, in application order. */
  readonly migrations: readonly MigrationDescriptor[];
}

/** Failure exit classes used by the command-line adapter; success returns process exit code `0`. */
export type MigrationExitCode = 1 | 2;

/** Stable error categories that callers can handle without parsing message text. */
export type MigrationErrorKind =
  | 'CONFIGURATION'
  | 'INVALID_HISTORY'
  | 'FILESYSTEM'
  | 'DATABASE'
  | 'LOCKED'
  | 'UNKNOWN_OUTCOME'
  | 'UNSUPPORTED'
  | 'ABORTED'
  | 'INTERNAL';
