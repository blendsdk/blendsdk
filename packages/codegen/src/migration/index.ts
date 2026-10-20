/** Public PostgreSQL migration configuration helper. */
export { defineMigrationConfig } from './config.js';

/** Public baseline generation and existing-database adoption operations. */
export { adoptBaseline, generateBaseline } from './baseline.js';
export type {
  AdoptBaselineDependencies,
  AdoptBaselineOptions,
  AdoptBaselineResult,
  AdoptionPreview,
  GenerateBaselineOptions,
  GenerateBaselineResult,
} from './baseline.js';

/** Public typed migration failures and their safe formatter. */
export { formatMigrationError, MigrationError } from './errors.js';
export type { MigrationErrorOptions } from './errors.js';

/** Public offline incremental migration generation. */
export { generateMigration } from './generate.js';
export type { GenerateMigrationOptions, GenerateMigrationResult } from './generate.js';

/** Public PostgreSQL history observation and execution operations. */
export { getMigrationStatus, runMigrations, validateMigrations } from './runner.js';
export type {
  GetMigrationStatusOptions,
  RunMigrationsOptions,
  ValidateMigrationsOptions,
} from './runner.js';

/** Public semantic change descriptions used to review generated migrations. */
export type { RenameHint, SchemaChange, SchemaDiffResult } from './schema-diff.js';

/** Public configuration, descriptor, status, safety, and error contracts. */
export type {
  MigrationCommand,
  MigrationCommandResult,
  MigrationConfig,
  MigrationDescriptor,
  MigrationErrorKind,
  MigrationExitCode,
  MigrationSafety,
  MigrationStatus,
  ResolvedMigrationConfig,
} from './types.js';
