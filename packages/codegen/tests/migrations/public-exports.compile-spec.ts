import {
  formatMigrationError,
  MigrationError,
  runMigrations,
  type MigrationCommand,
  type MigrationCommandResult,
  type MigrationConfig,
  type MigrationDescriptor,
  type MigrationErrorKind,
  type MigrationExitCode,
  type MigrationSafety,
  type MigrationStatus,
  type ResolvedMigrationConfig,
  type RunMigrationsOptions,
} from '@blendsdk/codegen';

/** A consumer can configure migration artifacts without including connection credentials. */
const config: MigrationConfig = {
  schema: './src/database/schema.ts',
  migrationsDir: './migrations',
  databaseUrlEnv: 'DATABASE_URL',
};

/** A consumer can inspect the fully resolved non-secret configuration. */
const resolvedConfig: ResolvedMigrationConfig = {
  configPath: '/project/blendsdk.migrations.ts',
  configDirectory: '/project',
  schema: '/project/src/database/schema.ts',
  migrationsDir: '/project/migrations',
  snapshotFile: '/project/migrations/schema.snapshot.json',
  databaseUrlEnv: 'DATABASE_URL',
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 900_000,
};

/** A consumer can inspect immutable migration metadata without internal parser types. */
const descriptor: MigrationDescriptor = {
  id: '20260827120000_add-customer-status',
  upPath: '/project/migrations/20260827120000_add-customer-status.up.sql',
  checksum: '1'.repeat(64),
  transactional: true,
  fromSnapshot: '2'.repeat(64),
  toSnapshot: '3'.repeat(64),
};

/** Stable unions support exhaustive handling without parsing text output. */
const command: MigrationCommand = 'validate';
const status: MigrationStatus = 'PENDING';
const safety: MigrationSafety = 'caution';
const kind: MigrationErrorKind = 'INVALID_HISTORY';
const exitCode: MigrationExitCode = 1;
const result: MigrationCommandResult = { status, migrations: [descriptor] };

/** A consumer can invoke the PostgreSQL runner through the package root. */
const runnerOptions: RunMigrationsOptions = {
  command: 'up',
  configPath: './blendsdk.migrations.ts',
  dryRun: true,
};
const runnerResult: Promise<MigrationCommandResult> = runMigrations(runnerOptions);

/** Typed errors remain usable through the package's public entry point. */
const renderedError: string = formatMigrationError(
  new MigrationError({ kind, exitCode, message: 'Migration history does not match.' })
);

void config;
void resolvedConfig;
void command;
void safety;
void result;
void runnerResult;
void renderedError;
