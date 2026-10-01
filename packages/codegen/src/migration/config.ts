import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, parse, relative, resolve } from 'node:path';
import { createJiti } from 'jiti';
import { DatabaseSchema } from '../database/schema/database-schema.js';
import { MigrationError } from './errors.js';
import type { MigrationCommand, MigrationConfig, ResolvedMigrationConfig } from './types.js';

const CONFIG_FILENAME = 'blendsdk.migrations.ts';
const DEFAULT_MIGRATIONS_DIRECTORY = 'migrations';
const DEFAULT_SNAPSHOT_FILENAME = 'schema.snapshot.json';
const DEFAULT_DATABASE_URL_ENV = 'DATABASE_URL';
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 900_000;
const MAX_LOCK_TIMEOUT_MS = 300_000;
const MAX_STATEMENT_TIMEOUT_MS = 86_400_000;
const ENVIRONMENT_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
const ALLOWED_CONFIG_KEYS = new Set([
  'schema',
  'migrationsDir',
  'snapshotFile',
  'databaseUrlEnv',
  'lockTimeoutMs',
  'statementTimeoutMs',
]);
const SCHEMA_COMMANDS = new Set<MigrationCommand>(['generate', 'baseline', 'adopt-baseline']);

/** Options used to locate and load a migration configuration. */
export interface LoadMigrationConfigOptions {
  /** Explicit configuration file or directory. */
  readonly configPath?: string;
  /** Directory from which conventional upward discovery begins. */
  readonly startDirectory?: string;
  /** Command whose configuration boundary is being prepared. */
  readonly command: MigrationCommand;
}

/**
 * Provides type inference for a migration configuration without changing it at runtime.
 *
 * @param config - User-authored migration settings.
 * @returns The same immutable configuration object.
 *
 * @example
 * ```ts
 * export default defineMigrationConfig({
 *   schema: './src/database/schema.ts',
 * });
 * ```
 */
export function defineMigrationConfig<const Config extends MigrationConfig>(
  config: Config
): Config {
  return config;
}

/**
 * Discovers, loads, and validates one TypeScript migration configuration.
 *
 * This function never reads the database URL and never imports the configured schema module.
 * Schema-aware commands call {@link loadConfiguredSchema} separately.
 *
 * @param options - Command and optional discovery starting point.
 * @returns Validated non-secret settings with absolute artifact paths.
 * @throws {MigrationError} When discovery, loading, or validation fails.
 */
export async function loadMigrationConfig(
  options: LoadMigrationConfigOptions
): Promise<ResolvedMigrationConfig> {
  const configPath = await findMigrationConfig(options);
  await rejectSymlinkSegments(configPath);

  const loaded = await importDefault(configPath, 'configuration');
  const config = validateConfigObject(loaded);
  const configDirectory = dirname(configPath);
  const migrationsDir = await resolveConfiguredPath(
    config.migrationsDir ?? DEFAULT_MIGRATIONS_DIRECTORY,
    configDirectory,
    'migrationsDir'
  );
  const snapshotFile = await resolveConfiguredPath(
    config.snapshotFile ?? resolve(migrationsDir, DEFAULT_SNAPSHOT_FILENAME),
    configDirectory,
    'snapshotFile'
  );
  const schema = config.schema
    ? await resolveConfiguredPath(config.schema, configDirectory, 'schema')
    : undefined;

  if (SCHEMA_COMMANDS.has(options.command) && !schema) {
    throw configurationError(`The ${options.command} command requires a schema module.`);
  }
  if (/\.(?:up|down)\.sql$/iu.test(snapshotFile)) {
    throw configurationError('snapshotFile must not use a migration SQL filename.');
  }

  return {
    configPath,
    configDirectory,
    ...(schema ? { schema } : {}),
    migrationsDir,
    snapshotFile,
    databaseUrlEnv: config.databaseUrlEnv ?? DEFAULT_DATABASE_URL_ENV,
    lockTimeoutMs: config.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    statementTimeoutMs: config.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
  };
}

/**
 * Loads the desired schema only for commands that explicitly need modeled state.
 *
 * @param config - Validated configuration containing an absolute schema-module path.
 * @returns The module's default `DatabaseSchema` instance.
 * @throws {MigrationError} When the schema is missing, cannot load, or has the wrong type.
 */
export async function loadConfiguredSchema(
  config: ResolvedMigrationConfig
): Promise<DatabaseSchema> {
  if (!config.schema) {
    throw configurationError('This command requires a configured schema module.');
  }

  const schema = await importDefault(config.schema, 'schema');
  if (!isDatabaseSchema(schema)) {
    throw configurationError('The schema module must default-export one DatabaseSchema instance.');
  }
  return schema;
}

/** Recognizes a DatabaseSchema loaded through Jiti's isolated module graph. */
function isDatabaseSchema(value: unknown): value is DatabaseSchema {
  return (
    isObjectRecord(value) &&
    typeof value.getDefaultSchema === 'function' &&
    typeof value.getExtensions === 'function' &&
    typeof value.getTables === 'function' &&
    typeof value.getViews === 'function'
  );
}

/** Narrows any non-null object, including a class instance loaded in another module graph. */
function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

/** Locates an explicit configuration or searches parent directories for the conventional name. */
async function findMigrationConfig(options: LoadMigrationConfigOptions): Promise<string> {
  if (options.configPath) {
    const explicitPath = resolve(options.configPath);
    const explicitKind = await pathKind(explicitPath);
    if (explicitKind === 'file') {
      return explicitPath;
    }
    if (explicitKind === 'directory') {
      return searchParents(explicitPath);
    }
    throw configurationError(`Migration configuration was not found at ${explicitPath}.`);
  }

  return searchParents(resolve(options.startDirectory ?? process.cwd()));
}

/** Searches each parent once and stops at the filesystem root. */
async function searchParents(startDirectory: string): Promise<string> {
  let currentDirectory = startDirectory;
  while (true) {
    const candidate = resolve(currentDirectory, CONFIG_FILENAME);
    if ((await pathKind(candidate)) === 'file') {
      return candidate;
    }
    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      throw configurationError(`Could not find ${CONFIG_FILENAME}.`);
    }
    currentDirectory = parentDirectory;
  }
}

/** Loads exactly the module's default value with both Jiti caches disabled. */
async function importDefault(path: string, label: string): Promise<unknown> {
  try {
    const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
    return await jiti.import(path, { default: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown loader failure';
    throw configurationError(`Could not load the migration ${label}: ${detail}`);
  }
}

/** Converts an unknown module value into the small supported configuration shape. */
function validateConfigObject(value: unknown): MigrationConfig {
  if (!isRecord(value)) {
    throw configurationError('Migration configuration must default-export an object.');
  }

  for (const key of Object.keys(value)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      throw configurationError(`Unknown migration configuration key: ${key}.`);
    }
  }

  const schema = optionalString(value, 'schema');
  const migrationsDir = optionalString(value, 'migrationsDir');
  const snapshotFile = optionalString(value, 'snapshotFile');
  const databaseUrlEnv = optionalString(value, 'databaseUrlEnv');
  const lockTimeoutMs = optionalInteger(value, 'lockTimeoutMs', 1, MAX_LOCK_TIMEOUT_MS);
  const statementTimeoutMs = optionalInteger(
    value,
    'statementTimeoutMs',
    1,
    MAX_STATEMENT_TIMEOUT_MS
  );

  if (databaseUrlEnv && !ENVIRONMENT_NAME_PATTERN.test(databaseUrlEnv)) {
    throw configurationError('databaseUrlEnv must be an uppercase environment-variable name.');
  }

  return {
    ...(schema ? { schema } : {}),
    ...(migrationsDir ? { migrationsDir } : {}),
    ...(snapshotFile ? { snapshotFile } : {}),
    ...(databaseUrlEnv ? { databaseUrlEnv } : {}),
    ...(lockTimeoutMs !== undefined ? { lockTimeoutMs } : {}),
    ...(statementTimeoutMs !== undefined ? { statementTimeoutMs } : {}),
  };
}

/** Resolves one configured path and enforces the relative config-directory boundary. */
async function resolveConfiguredPath(
  configuredPath: string,
  configDirectory: string,
  field: string
): Promise<string> {
  if (configuredPath.length === 0) {
    throw configurationError(`${field} must not be empty.`);
  }

  const absolutePath = resolve(configDirectory, configuredPath);
  if (!isAbsolute(configuredPath)) {
    const relativePath = relative(configDirectory, absolutePath);
    if (
      relativePath === '..' ||
      relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    ) {
      throw configurationError(`${field} must not escape the configuration directory.`);
    }
  }
  if (absolutePath === parse(absolutePath).root) {
    throw configurationError(`${field} must not be a filesystem root.`);
  }

  await rejectSymlinkSegments(
    absolutePath,
    isAbsolute(configuredPath) ? undefined : configDirectory
  );
  return absolutePath;
}

/** Rejects every existing symbolic-link segment between a path and its trusted boundary. */
async function rejectSymlinkSegments(path: string, boundary?: string): Promise<void> {
  let currentPath = path;
  while (true) {
    try {
      const stats = await lstat(currentPath);
      if (stats.isSymbolicLink()) {
        throw configurationError(
          `Configured path must not contain a symbolic link: ${currentPath}.`
        );
      }
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }
    }

    if (currentPath === boundary || currentPath === parse(currentPath).root) {
      return;
    }
    currentPath = dirname(currentPath);
  }
}

/** Returns the existing filesystem kind needed by deterministic discovery. */
async function pathKind(path: string): Promise<'file' | 'directory' | 'missing'> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw configurationError(`Configured path must not be a symbolic link: ${path}.`);
    }
    if (stats.isFile()) return 'file';
    if (stats.isDirectory()) return 'directory';
    return 'missing';
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return 'missing';
    throw error;
  }
}

/** Reads an optional non-empty string without weakening unknown input types. */
function optionalString(
  record: Readonly<Record<string, unknown>>,
  key: string
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw configurationError(`${key} must be a non-empty string.`);
  }
  return value;
}

/** Reads an optional bounded integer without accepting numeric coercion. */
function optionalInteger(
  record: Readonly<Record<string, unknown>>,
  key: string,
  minimum: number,
  maximum: number
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw configurationError(`${key} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

/** Narrows an unknown module export to a plain key/value object. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Narrows an unknown exception to one exact Node.js error code. */
function hasErrorCode(error: unknown, code: string): error is Error & { readonly code: string } {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Creates a stable usage/configuration error. */
function configurationError(message: string): MigrationError {
  return new MigrationError({ kind: 'CONFIGURATION', exitCode: 2, message });
}
