import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect } from 'vitest';
import { MigrationError } from '../../src/migration/errors.js';
import { parseMigrationFile } from '../../src/migration/migration-file.js';

/** Fixed qualified name of the runner-owned ledger. */
export const ledgerName = 'public.blendsdk_migrations';

const adminUrl = 'postgresql://postgres:postgres@127.0.0.1:5597/postgres';
const temporaryDirectories: string[] = [];
const databaseNames: string[] = [];
const databaseUrlEnvironments: string[] = [];
let adminPool: Pool | undefined;

/** Isolated database and local artifact paths owned by one test. */
export interface TestProject {
  readonly databaseUrl: string;
  readonly databaseUrlEnvironment: string;
  readonly configPath: string;
  readonly migrationsDir: string;
  readonly pool: Pool;
}

/** Optional metadata and down body used to write a migration fixture. */
export interface MigrationOptions {
  readonly transactional?: boolean;
  readonly fromSnapshot?: string;
  readonly toSnapshot?: string;
  readonly downBody?: string;
}

/** Opens the administrative pool used only for owned test-database lifecycle. */
export function setupRunnerTests(): void {
  adminPool = new Pool({ connectionString: adminUrl, max: 2 });
}

/** Creates one isolated PostgreSQL database and one local migration project. */
export async function createProject(
  config: { readonly lockTimeoutMs?: number; readonly statementTimeoutMs?: number } = {}
): Promise<TestProject> {
  if (!adminPool) throw new Error('Runner test support has not been initialized.');
  const databaseName = `blend_runner_${randomUUID().replaceAll('-', '')}`;
  const databaseUrlEnvironment = `BLENDSDK_RUNNER_${databaseName.toUpperCase()}_URL`;
  await adminPool.query(`CREATE DATABASE "${databaseName}"`);
  databaseNames.push(databaseName);

  const projectDirectory = await mkdtemp(join(tmpdir(), 'blendsdk-runner-'));
  temporaryDirectories.push(projectDirectory);
  const migrationsDir = join(projectDirectory, 'migrations');
  await mkdir(migrationsDir);
  const configPath = join(projectDirectory, 'blendsdk.migrations.ts');
  await writeFile(
    configPath,
    `export default ${JSON.stringify({
      databaseUrlEnv: databaseUrlEnvironment,
      lockTimeoutMs: config.lockTimeoutMs ?? 500,
      statementTimeoutMs: config.statementTimeoutMs ?? 30_000,
    })};\n`,
    'utf8'
  );
  const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:5597/${databaseName}`;
  process.env[databaseUrlEnvironment] = databaseUrl;
  databaseUrlEnvironments.push(databaseUrlEnvironment);
  return {
    databaseUrl,
    databaseUrlEnvironment,
    configPath,
    migrationsDir,
    pool: new Pool({ connectionString: databaseUrl, max: 4 }),
  };
}

/** Renders and writes one valid immutable migration pair. */
export async function writeMigration(
  project: TestProject,
  id: string,
  body: string,
  options: MigrationOptions = {}
) {
  const upPath = join(project.migrationsDir, `${id}.up.sql`);
  await writeFile(
    upPath,
    migrationSql(id, body, {
      transactional: options.transactional,
      fromSnapshot: options.fromSnapshot,
      toSnapshot: options.toSnapshot,
    }),
    'utf8'
  );
  if (options.downBody) {
    await writeFile(
      join(project.migrationsDir, `${id}.down.sql`),
      migrationSql(id, options.downBody, {
        transactional: options.transactional,
        fromSnapshot: options.toSnapshot,
        toSnapshot: options.fromSnapshot,
      }),
      'utf8'
    );
  }
  return parseMigrationFile(upPath);
}

/** Produces exact version-one SQL bytes with nullable snapshot lineage. */
function migrationSql(
  id: string,
  body: string,
  options: {
    readonly transactional?: boolean;
    readonly fromSnapshot?: string;
    readonly toSnapshot?: string;
  }
): string {
  return [
    '-- blendsdk-migration: 1',
    `-- id: ${id}`,
    `-- transaction: ${options.transactional ?? true}`,
    `-- from-snapshot: ${options.fromSnapshot ?? 'none'}`,
    `-- to-snapshot: ${options.toSnapshot ?? 'none'}`,
    body.trimEnd(),
    '',
  ].join('\n');
}

/** Creates the fixed ledger shape for deliberately constructed history states. */
export async function createLedger(project: TestProject): Promise<void> {
  await project.pool.query(`
    CREATE TABLE public.blendsdk_migrations (
      id text PRIMARY KEY,
      checksum char(64) NOT NULL,
      from_snapshot char(64),
      to_snapshot char(64),
      state text NOT NULL CHECK (state IN ('APPLIED', 'NONTRANSACTIONAL_DIRTY')),
      applied_at timestamptz,
      execution_ms bigint CHECK (execution_ms >= 0),
      CHECK (
        (state = 'APPLIED' AND applied_at IS NOT NULL AND execution_ms IS NOT NULL) OR
        (state = 'NONTRANSACTIONAL_DIRTY' AND applied_at IS NULL AND execution_ms IS NULL)
      )
    )
  `);
}

/** Inserts an exact applied or dirty ledger row without invoking migration SQL. */
export async function insertLedgerRow(
  project: TestProject,
  migration: Awaited<ReturnType<typeof parseMigrationFile>>,
  state: 'APPLIED' | 'NONTRANSACTIONAL_DIRTY' = 'APPLIED'
): Promise<void> {
  await project.pool.query(
    `INSERT INTO ${ledgerName}
      (id, checksum, from_snapshot, to_snapshot, state, applied_at, execution_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      migration.id,
      migration.checksum,
      migration.fromSnapshot ?? null,
      migration.toSnapshot ?? null,
      state,
      state === 'APPLIED' ? new Date() : null,
      state === 'APPLIED' ? 0 : null,
    ]
  );
}

/** Captures one typed runner failure and verifies its operational exit class. */
export async function expectRunnerError(
  action: () => unknown | Promise<unknown>,
  kind?: MigrationError['kind']
): Promise<MigrationError> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof MigrationError)) throw error;
    if (kind) expect(error.kind).toBe(kind);
    expect(error.exitCode).toBe(1);
    return error;
  }
  throw new Error(`Expected ${kind ?? 'typed'} migration failure.`);
}

/** Reports whether the runner-owned ledger currently exists. */
export async function ledgerExists(project: TestProject): Promise<boolean> {
  const result = await project.pool.query<{ exists: boolean }>(
    `SELECT to_regclass('public.blendsdk_migrations') IS NOT NULL AS exists`
  );
  return result.rows[0]?.exists === true;
}

/** Returns stable ledger state without client-side bigint coercion. */
export async function ledgerRows(project: TestProject) {
  const result = await project.pool.query<{
    id: string;
    checksum: string;
    from_snapshot: string | null;
    to_snapshot: string | null;
    state: string;
    applied: boolean;
    execution_ms: string | null;
  }>(`
    SELECT id, checksum, from_snapshot, to_snapshot, state,
           applied_at IS NOT NULL AS applied, execution_ms::text
    FROM ${ledgerName}
    ORDER BY id
  `);
  return result.rows;
}

/** Removes all files, environment values, pools, and databases owned by the current test. */
export async function cleanupRunnerTest(): Promise<void> {
  if (!adminPool) return;
  for (const environmentName of databaseUrlEnvironments.splice(0)) {
    delete process.env[environmentName];
  }
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
  for (const databaseName of databaseNames.splice(0).reverse()) {
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
      [databaseName]
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  }
}

/** Closes the administrative pool after the suite owns no databases. */
export async function teardownRunnerTests(): Promise<void> {
  await adminPool?.end();
  adminPool = undefined;
}
