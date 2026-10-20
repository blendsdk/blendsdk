import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CommandLineParser,
  CommandLineValidationError,
  type ICommand,
  type ICommandOption,
  type OptionsDict,
} from '@blendsdk/cmdline';
import { formatMigrationError, MigrationError } from './errors.js';
import type { RenameHint } from './schema-diff.js';

const ACTIONS = [
  'generate',
  'create',
  'up',
  'down',
  'status',
  'validate',
  'baseline',
  'adopt-baseline',
] as const;

type MigrationAction = (typeof ACTIONS)[number];

/** Process-independent output boundary for the reusable migration CLI. */
export interface MigrationCliIo {
  /** Receives ordinary status and help text. */
  readonly stdout: (message: string) => void;
  /** Receives concise sanitized failures. */
  readonly stderr: (message: string) => void;
}

/** Parsed route information kept outside the general command parser. */
interface MigrationRoute {
  readonly action: MigrationAction;
  readonly name?: string;
  readonly parserArgv: readonly string[];
}

/** Context forwarded to each fixed action handler. */
interface MigrationCliContext {
  readonly action: MigrationAction;
  readonly name?: string;
  readonly signal: AbortSignal;
  readonly io: MigrationCliIo;
}

/**
 * Runs one BlendSDK migration CLI invocation and returns its process exit class.
 *
 * The function never calls `process.exit`, never prints SQL, and removes its signal listeners
 * before resolving. The executable wrapper owns `process.exitCode`.
 *
 * @param argv - Arguments after the executable name.
 * @param io - Caller-owned output functions.
 * @returns `0` for success, `1` for operational failure, or `2` for invalid usage/configuration.
 */
export async function main(argv: readonly string[], io: MigrationCliIo): Promise<number> {
  if (isVersionRequest(argv)) {
    io.stdout(await readPackageVersion());
    return 0;
  }
  if (isTopLevelHelp(argv)) {
    io.stdout(renderTopLevelHelp());
    return 0;
  }

  const route = parseRoute(argv);
  if (!route) {
    io.stderr('USAGE: Run `blendsdk migrate --help` for the supported commands.');
    return 2;
  }

  const controller = new AbortController();
  const handlesSignals = route.action === 'up' || route.action === 'down';
  const abort = (): void => controller.abort();
  if (handlesSignals) {
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
  }
  try {
    const parser = createParser(await readPackageVersion());
    const result = await parser.execute(
      {
        action: route.action,
        ...(route.name ? { name: route.name } : {}),
        signal: controller.signal,
        io,
      } satisfies MigrationCliContext,
      { argv: route.parserArgv, write: io.stdout }
    );
    return result === 1 ? 1 : 0;
  } catch (error) {
    if (error instanceof CommandLineValidationError) {
      io.stderr('USAGE: Invalid migration command arguments.');
      return 2;
    }
    if (error instanceof MigrationError) {
      io.stderr(formatMigrationError(error));
      return error.exitCode;
    }
    io.stderr('INTERNAL: Migration command failed unexpectedly.');
    return 1;
  } finally {
    if (handlesSignals) {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    }
  }
}

/** Creates the strict fixed-command parser without retaining invocation state. */
function createParser(version: string): CommandLineParser {
  const parser = new CommandLineParser({
    name: 'blendsdk migrate',
    version,
    strict: true,
    errorHandler: () => undefined,
  });
  for (const command of commandDefinitions()) parser.addCommand(command);
  return parser;
}

/** Defines the exact eight commands and their command-local option allowlists. */
function commandDefinitions(): readonly ICommand[] {
  const config = configOption();
  return [
    command('generate', 'Generate SQL from desired schema changes.', [
      config,
      booleanOption('allow-destructive', 'Allow reviewed destructive changes.'),
      multipleStringOption('rename-table', 'Rename hint: prior.schema=desired.schema.'),
      multipleStringOption(
        'rename-column',
        'Rename hint: prior.table.column=desired.table.column.'
      ),
    ]),
    command('create', 'Create a manual SQL migration template.', [
      config,
      booleanOption('with-down', 'Create an optional local down file.'),
      booleanOption('no-transaction', 'Run this migration outside a runner transaction.'),
    ]),
    command('up', 'Apply pending migrations.', [
      config,
      booleanOption('dry-run', 'Report pending migrations without mutation.'),
    ]),
    command('down', 'Revert exactly the latest migration.', [
      config,
      {
        ...booleanOption('allow-down', 'Confirm the guarded local down operation.'),
        required: true,
      },
    ]),
    command('status', 'Report migration status.', [config]),
    command('validate', 'Validate migration history.', [
      config,
      booleanOption('offline', 'Validate local files without PostgreSQL.'),
    ]),
    command('baseline', 'Generate the initial migration lineage.', [config]),
    command('adopt-baseline', 'Record an exact existing database baseline.', [
      config,
      {
        name: 'confirm-adoption',
        type: 'string',
        required: true,
        description: 'Exact <database>/<baseline-id> DDL-quiescence confirmation.',
      },
    ]),
  ];
}

/** Builds one parser command that delegates all behavior to migration services. */
function command(
  name: MigrationAction,
  description: string,
  options: readonly ICommandOption[]
): ICommand {
  return {
    name,
    description,
    options: [...options],
    handler: async values => {
      const context = migrationContext(values.context);
      return dispatch(context, values);
    },
  };
}

/** Runs one already-validated action through its owning service. */
async function dispatch(context: MigrationCliContext, options: OptionsDict): Promise<0 | 1> {
  const configPath = stringOption(options, 'config');
  switch (context.action) {
    case 'generate': {
      const { generateMigration } = await import('./generate.js');
      const result = await generateMigration({
        name: requiredName(context),
        ...(configPath ? { configPath } : {}),
        renameHints: renameHints(options),
        allowDestructive: booleanOptionValue(options, 'allow-destructive'),
      });
      writeState(context.io, result.status, result.migration?.id);
      return 0;
    }
    case 'create': {
      const [{ loadMigrationConfig }, { createManualMigration }] = await Promise.all([
        import('./config.js'),
        import('./migration-file.js'),
      ]);
      const config = await loadMigrationConfig({
        command: 'create',
        ...(configPath ? { configPath } : {}),
      });
      const migration = await createManualMigration({
        migrationsDir: config.migrationsDir,
        name: requiredName(context),
        withDown: booleanOptionValue(options, 'with-down'),
        transactional: !booleanOptionValue(options, 'no-transaction'),
      });
      writeState(context.io, 'CREATED', migration.id);
      return 0;
    }
    case 'baseline': {
      const { generateBaseline } = await import('./baseline.js');
      const result = await generateBaseline({
        name: requiredName(context),
        ...(configPath ? { configPath } : {}),
      });
      writeState(context.io, result.status, result.migration.id);
      return 0;
    }
    case 'adopt-baseline': {
      const { adoptBaseline } = await import('./baseline.js');
      const confirmation = requiredStringOption(options, 'confirm-adoption');
      const result = await adoptBaseline(
        { ...(configPath ? { configPath } : {}) },
        {
          afterPreview: preview => {
            context.io.stdout(
              `TARGET ${preview.user}@${preview.host}:${preview.port}/${preview.database}`
            );
            for (const item of preview.comparison) {
              context.io.stdout(`${item.classification} ${item.identity}`);
            }
            return confirmation;
          },
        }
      );
      writeState(context.io, result.status);
      return 0;
    }
    case 'status': {
      const { getMigrationStatus } = await import('./runner.js');
      const result = await getMigrationStatus({ ...(configPath ? { configPath } : {}) });
      return writeResult(context.io, result);
    }
    case 'validate': {
      const { validateMigrations } = await import('./runner.js');
      const result = await validateMigrations({
        ...(configPath ? { configPath } : {}),
        offline: booleanOptionValue(options, 'offline'),
      });
      return writeResult(context.io, result);
    }
    case 'up':
    case 'down': {
      const { runMigrations } = await import('./runner.js');
      const result = await runMigrations({
        command: context.action,
        ...(configPath ? { configPath } : {}),
        dryRun: context.action === 'up' && booleanOptionValue(options, 'dry-run'),
        allowDown: context.action === 'down' && booleanOptionValue(options, 'allow-down'),
        signal: context.signal,
      });
      return writeResult(context.io, result);
    }
  }
}

/** Parses the fixed `migrate <action> [name]` route before option parsing. */
function parseRoute(argv: readonly string[]): MigrationRoute | undefined {
  if (argv[0] !== 'migrate' || !isMigrationAction(argv[1])) return undefined;
  const action = argv[1];
  const needsName = action === 'generate' || action === 'create' || action === 'baseline';
  const helpRequested = argv.includes('--help') || argv.includes('-h');
  const candidateName = argv[2];
  if (needsName && !helpRequested && (!candidateName || candidateName.startsWith('-'))) {
    return undefined;
  }
  if (!needsName && candidateName && !candidateName.startsWith('-')) return undefined;
  const name =
    needsName && candidateName && !candidateName.startsWith('-') ? candidateName : undefined;
  return {
    action,
    ...(name ? { name } : {}),
    parserArgv: [action, ...argv.slice(name ? 3 : 2)],
  };
}

/** Converts repeatable typed rename options to the public hint DTO. */
function renameHints(options: OptionsDict): readonly RenameHint[] {
  return [
    ...multipleStrings(options, 'rename-table').map(value => renameHint('table', value)),
    ...multipleStrings(options, 'rename-column').map(value => renameHint('column', value)),
  ];
}

/** Parses one `from=to` rename value without interpreting it as SQL. */
function renameHint(kind: RenameHint['kind'], value: string): RenameHint {
  const parts = value.split('=');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw usageError('Rename hints must use exact from=to syntax.');
  }
  return { kind, from: parts[0], to: parts[1] };
}

/** Requires the typed migration context supplied by main. */
function migrationContext(value: unknown): MigrationCliContext {
  if (!isRecord(value) || !isMigrationAction(value.action) || !isRecord(value.io)) {
    throw new Error('Migration CLI context is unavailable.');
  }
  const stdout = value.io.stdout;
  const stderr = value.io.stderr;
  if (!isWriter(stdout) || !isWriter(stderr) || !(value.signal instanceof AbortSignal)) {
    throw new Error('Migration CLI context is invalid.');
  }
  return {
    action: value.action,
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    signal: value.signal,
    io: { stdout, stderr },
  };
}

/** Returns one required positional migration name. */
function requiredName(context: MigrationCliContext): string {
  if (!context.name) throw usageError('This command requires a migration name.');
  return context.name;
}

/** Reads one optional canonical string option. */
function stringOption(options: OptionsDict, name: string): string | undefined {
  const value = options[name];
  return typeof value === 'string' ? value : undefined;
}

/** Reads one required canonical string option. */
function requiredStringOption(options: OptionsDict, name: string): string {
  const value = stringOption(options, name);
  if (!value) throw usageError(`The --${name} option is required.`);
  return value;
}

/** Reads one canonical boolean option, treating absence as false. */
function booleanOptionValue(options: OptionsDict, name: string): boolean {
  return options[name] === true;
}

/** Reads one repeatable canonical string option. */
function multipleStrings(options: OptionsDict, name: string): readonly string[] {
  const value = options[name];
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value;
  throw usageError(`The --${name} option requires text values.`);
}

/** Writes one concise migration state and optional identifier. */
function writeState(io: MigrationCliIo, state: string, id?: string): void {
  io.stdout(id ? `${state} ${id}` : state);
}

/** Writes a runner result without SQL, credentials, or provider details. */
function writeResult(
  io: MigrationCliIo,
  result: { readonly status: string; readonly migrations: readonly { readonly id: string }[] }
): 0 | 1 {
  writeState(io, result.status, result.migrations.map(item => item.id).join(',') || undefined);
  return ['INVALID_HISTORY', 'LOCKED', 'UNKNOWN_OUTCOME'].includes(result.status) ? 1 : 0;
}

/** Returns true for one exact lifecycle action. */
function isMigrationAction(value: unknown): value is MigrationAction {
  return typeof value === 'string' && ACTIONS.some(action => action === value);
}

/** Returns true for a plain non-null property record. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrows an invocation boundary value to the CLI's single-string writer contract. */
function isWriter(value: unknown): value is (message: string) => void {
  return typeof value === 'function';
}

/** Recognizes successful top-level help forms. */
function isTopLevelHelp(argv: readonly string[]): boolean {
  return (
    (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) ||
    (argv.length === 2 && argv[0] === 'migrate' && (argv[1] === '--help' || argv[1] === '-h'))
  );
}

/** Recognizes the successful global version forms. */
function isVersionRequest(argv: readonly string[]): boolean {
  return argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v');
}

/** Renders the stable top-level command list and exit classes. */
function renderTopLevelHelp(): string {
  return [
    'BlendSDK PostgreSQL migrations',
    '',
    'Usage: blendsdk migrate <command> [name] [options]',
    '',
    'Commands:',
    ...ACTIONS.map(action => `  ${action}`),
    '',
    'Exit codes: 0 success, 1 operational failure, 2 usage or configuration failure.',
  ].join('\n');
}

/** Finds the nearest package version for source, workspace dist, or assembled dist layouts. */
async function readPackageVersion(): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const value: unknown = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (
        isRecord(value) &&
        typeof value.version === 'string' &&
        /^\d+\.\d+\.\d+/u.test(value.version)
      ) {
        return value.version;
      }
    } catch {
      // Continue upward until the owning package root is found.
    }
    directory = dirname(directory);
  }
  return '0.0.0';
}

/** Builds the shared config path option. */
function configOption(): ICommandOption {
  return { name: 'config', type: 'string', description: 'Config file or discovery directory.' };
}

/** Builds one strict boolean command option. */
function booleanOption(name: string, description: string): ICommandOption {
  return { name, type: 'boolean', description };
}

/** Builds one repeatable strict string command option. */
function multipleStringOption(name: string, description: string): ICommandOption {
  return { name, type: 'string', multiple: true, description };
}

/** Creates a stable usage failure for semantic option values. */
function usageError(message: string): MigrationError {
  return new MigrationError({ kind: 'CONFIGURATION', exitCode: 2, message });
}
