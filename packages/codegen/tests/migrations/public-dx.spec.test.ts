import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, test } from 'vitest';
import { DatabaseSchema } from '../../src/database/schema/database-schema.js';
import { diffSnapshots } from '../../src/migration/schema-diff.js';
import { normalizeDatabaseSchema } from '../../src/migration/schema-normalizer.js';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const temporaryDirectories: string[] = [];
const lifecycleCommands = [
  'generate',
  'create',
  'up',
  'down',
  'status',
  'validate',
  'baseline',
  'adopt-baseline',
] as const;

/** Output boundary required by the reusable migration CLI. */
interface CliIo {
  /** Receives ordinary command output. */
  readonly stdout: (message: string) => void;
  /** Receives sanitized diagnostics. */
  readonly stderr: (message: string) => void;
}

/** Public reusable CLI entry point required by the command contract. */
type CliMain = (argv: readonly string[], io: CliIo) => Promise<number>;

/** Loads the future CLI entry without making its preimplementation absence a TypeScript error. */
async function loadCliMain(): Promise<CliMain> {
  const moduleValue: unknown = await import(
    new URL('../../src/migration/cli.js', import.meta.url).href
  );
  if (!isRecord(moduleValue) || typeof moduleValue.main !== 'function') {
    throw new Error('Migration CLI module does not export main(argv, io).');
  }
  return async (argv, io) => {
    const result: unknown = await moduleValue.main(argv, io);
    if (typeof result !== 'number')
      throw new Error('Migration CLI main did not return an exit code.');
    return result;
  };
}

/** Narrows an unknown runtime module to a property record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Captures one CLI invocation without touching process-global output. */
async function invokeCli(argv: readonly string[]): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const output: string[] = [];
  const errors: string[] = [];
  const main = await loadCliMain();
  const exitCode = await main(argv, {
    stdout: message => output.push(message),
    stderr: message => errors.push(message),
  });
  return { exitCode, stdout: output.join('\n'), stderr: errors.join('\n') };
}

/** Reads a repository text file through one stable root. */
async function repositoryText(path: string): Promise<string> {
  return readFile(join(repositoryRoot, path), 'utf8');
}

/** Creates one strict no-op migration file. */
function noOpMigration(id: string): string {
  return [
    '-- blendsdk-migration: 1',
    `-- id: ${id}`,
    '-- transaction: true',
    '-- from-snapshot: none',
    '-- to-snapshot: none',
    'SELECT 1;',
    '',
  ].join('\n');
}

/** Produces one valid sortable timestamp for a synthetic pending migration. */
function migrationTimestamp(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, offsetSeconds))
    .toISOString()
    .slice(0, 19)
    .replaceAll(/\D/gu, '');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

describe('public migration CLI contract', () => {
  test('ST-56 lists exactly eight lifecycle commands and no repair bypass', async () => {
    const result = await invokeCli(['migrate', '--help']);

    expect(result.exitCode).toBe(0);
    for (const command of lifecycleCommands) expect(result.stdout).toContain(command);
    expect(result.stdout).not.toMatch(/\b(force|fake|repair)\b/iu);
    expect(result.stdout).toMatch(/exit.+0.+1.+2/isu);
  });

  test('ST-57 maps success and usage failures without terminating the process', async () => {
    const help = await invokeCli(['migrate', '--help']);
    const version = await invokeCli(['--version']);
    const invalid = await invokeCli(['migrate', 'unknown', '--unexpected']);
    const reusableSource = await repositoryText('packages/codegen/src/migration/cli.ts');

    expect(help.exitCode).toBe(0);
    expect(version.exitCode).toBe(0);
    expect(version.stdout).toMatch(/\d+\.\d+\.\d+/u);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stderr).not.toContain(' at ');
    expect(reusableSource).not.toMatch(/process\.exit\s*\(/u);
  });

  test('ST-57 maps an invalid local migration history to operational failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'blendsdk-cli-invalid-history-'));
    temporaryDirectories.push(directory);
    const configPath = join(directory, 'blendsdk.migrations.ts');
    await Promise.all([
      writeFile(configPath, "export default { migrationsDir: '.' };\n", 'utf8'),
      writeFile(join(directory, 'unexpected.sql'), 'SELECT 1;\n', 'utf8'),
    ]);

    const result = await invokeCli(['migrate', 'validate', '--offline', '--config', configPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('INVALID_HISTORY');
    expect(result.stderr).toBe('');
  });

  test('ST-65 rejects traversal and option-to-SQL injection without echoing payloads', async () => {
    const payload = `'; DROP TABLE private_customer; --`;
    const traversal = await invokeCli(['migrate', 'generate', '../drop']);
    const injection = await invokeCli(['migrate', 'up', '--sql', payload]);

    expect(traversal.exitCode).toBe(2);
    expect(injection.exitCode).toBe(2);
    expect(
      `${traversal.stdout}${traversal.stderr}${injection.stdout}${injection.stderr}`
    ).not.toContain(payload);
  });
});

describe('assembled package and public API contract', () => {
  test('ST-58 declares one assembled executable with a shebang-backed target', async () => {
    const packageJson: unknown = JSON.parse(await repositoryText('packages/blendsdk/package.json'));
    if (!isRecord(packageJson) || !isRecord(packageJson.bin)) {
      throw new Error('Assembled package does not declare a bin map.');
    }
    const target = packageJson.bin.blendsdk;
    expect(target).toBe('./dist/codegen/cli.js');
    expect(packageJson.dependencies).toMatchObject({ jiti: '^2.7.0' });
    expect(packageJson.peerDependencies).toMatchObject({ pg: expect.any(String) });
    expect(packageJson.peerDependenciesMeta).toMatchObject({ pg: { optional: true } });

    const cliSource = await repositoryText('packages/codegen/src/cli.ts');
    expect(cliSource.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect((await stat(join(repositoryRoot, 'packages/codegen/src/cli.ts'))).isFile()).toBe(true);
  });

  test('ST-59 exposes documented migration APIs while retaining internal boundaries', async () => {
    const publicApi: unknown = await import('../../src/index.js');
    if (!isRecord(publicApi)) throw new Error('Codegen public entry is not a module record.');
    for (const name of [
      'defineMigrationConfig',
      'generateMigration',
      'generateBaseline',
      'runMigrations',
      'getMigrationStatus',
      'validateMigrations',
      'adoptBaseline',
    ]) {
      expect(publicApi[name], name).toBeTypeOf('function');
    }
    for (const internal of [
      'projectPostgreSqlCatalog',
      'readMigrationLedger',
      'publishArtifactPair',
      'generateInitialMigration',
    ]) {
      expect(publicApi[internal], internal).toBeUndefined();
    }
  });
});

describe('documentation and playground contract', () => {
  test('ST-60 required documentation surfaces agree on the bounded daily workflow', async () => {
    const paths = [
      'packages/codegen/README.md',
      'packages/codegen/docs/postgresql-introspector-usage-guide.md',
      'packages/blendsdk-docs/docs/guides/code-generation.md',
      'packages/blendsdk-docs/docs/guides/database.md',
      'packages/blendsdk-docs/docs/guides/database-migrations.md',
      'packages/blendsdk-docs/docs/guides/database-migrations-production.md',
      'packages/blendsdk-docs/docs/packages/codegen.md',
    ];
    const corpus = (await Promise.all(paths.map(repositoryText))).join('\n');

    for (const command of lifecycleCommands) expect(corpus).toContain(command);
    expect(corpus).toMatch(/edit.{0,80}schema.{0,80}generate.{0,80}review.{0,80}commit/isu);
    expect(corpus).toMatch(/snapshot/iu);
    expect(corpus).toMatch(/schema generator.{0,160}desired.state/isu);
    expect(corpus).not.toMatch(/initializer.{0,160}(?:is|as).{0,160}migration/iu);

    const packageReference = await repositoryText(
      'packages/blendsdk-docs/docs/packages/codegen.md'
    );
    for (const publicApi of [
      'defineMigrationConfig',
      'generateMigration',
      'runMigrations',
      'getMigrationStatus',
      'validateMigrations',
      'adoptBaseline',
    ]) {
      expect(packageReference).toContain(publicApi);
    }
    expect(packageReference).toContain('blendsdk migrate');
    expect(packageReference).toContain('blendsdk/codegen');
    expect(packageReference).not.toContain('^5.42.0');
  });

  test('ST-61 provides a copyable baseline-only playground on public commands', async () => {
    const base = 'packages/playground/database-migrations';
    const paths = [
      `${base}/blendsdk.migrations.ts`,
      `${base}/schema.ts`,
      `${base}/migrations/20260827090000_initial.up.sql`,
      `${base}/migrations/schema.snapshot.json`,
      `${base}/README.md`,
      `${base}/run.ts`,
    ];
    await Promise.all(paths.map(path => stat(join(repositoryRoot, path))));
    const instructions = await repositoryText(`${base}/README.md`);

    for (const command of ['baseline', 'up', 'status', 'generate', 'create', 'validate']) {
      expect(instructions).toContain(`migrate ${command}`);
    }
    expect(instructions).toMatch(/temporary|copy/iu);
    expect(instructions).toMatch(/nullable/iu);
  });

  test('ST-62 production runbook has five stages, six failures, and forward recovery', async () => {
    const runbook = await repositoryText(
      'packages/blendsdk-docs/docs/guides/database-migrations-production.md'
    );
    const stageHeadings = runbook.match(/^## Stage \d:/gmu) ?? [];
    const failureCases = [
      'Advisory lock unavailable',
      'Validation/history mismatch',
      'Transactional SQL failure',
      'Connection loss during transaction',
      'Nontransactional interruption',
      'Application incompatible after successful migration',
    ];

    expect(stageHeadings).toHaveLength(5);
    for (const failureCase of failureCases) expect(runbook).toContain(`| ${failureCase} `);
    expect(runbook).toMatch(/forward recovery/iu);
    expect(runbook).toMatch(/zero downtime.+not guaranteed/isu);
  });
});

describe('bounded migration performance contract', () => {
  test('ST-63 validates discovery of 100 pending no-op migrations within two seconds', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'blendsdk-public-dx-'));
    temporaryDirectories.push(directory);
    for (let index = 0; index < 100; index += 1) {
      const id = `${migrationTimestamp(index)}_noop-${index}`;
      await writeFile(join(directory, `${id}.up.sql`), noOpMigration(id), 'utf8');
    }
    const { discoverMigrations } = await import('../../src/migration/migration-file.js');
    const started = performance.now();
    const migrations = await discoverMigrations({ migrationsDir: directory });

    expect(migrations).toHaveLength(100);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test('ST-64 normalizes and diffs 500 tables within time and memory bounds', () => {
    const before = normalizeDatabaseSchema(new DatabaseSchema('before'));
    const desiredSchema = new DatabaseSchema('desired');
    for (let index = 0; index < 500; index += 1) {
      desiredSchema.table(`table_${index}`).integer('id');
    }
    const beforeRss = process.memoryUsage().rss;
    const started = performance.now();
    const desired = normalizeDatabaseSchema(desiredSchema);
    const result = diffSnapshots(before, desired);
    const additionalRss = Math.max(0, process.memoryUsage().rss - beforeRss);

    expect(result.changes).toHaveLength(500);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(additionalRss).toBeLessThan(256 * 1024 * 1024);
  });
});
