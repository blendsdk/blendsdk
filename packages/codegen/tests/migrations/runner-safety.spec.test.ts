import { readFile, writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { runMigrations } from '../../src/migration/runner.js';
import {
  cleanupRunnerTest,
  createProject,
  expectRunnerError,
  ledgerExists,
  ledgerRows,
  setupRunnerTests,
  teardownRunnerTests,
  writeMigration,
} from './runner.test-support.js';

beforeAll(setupRunnerTests);
afterEach(cleanupRunnerTest);
afterAll(teardownRunnerTests);

/** Waits until the runner has completed file discovery and is polling the held advisory lock. */
async function waitForMigrationSession(
  project: Awaited<ReturnType<typeof createProject>>
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await project.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM pg_stat_activity
       WHERE datname = current_database() AND application_name = 'blendsdk-migrations'`
    );
    if ((result.rows[0]?.count ?? 0) > 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The waiting migration session was not observable before the test deadline.');
}

describe.sequential('PostgreSQL migration runner safety corrections', () => {
  test('should revalidate pending bytes after waiting for the advisory lock', async () => {
    // Files discovered before a lock wait cannot be trusted after another process had time to edit them.
    const project = await createProject({ lockTimeoutMs: 500 });
    const migration = await writeMigration(
      project,
      '20260827120100_waiting-file',
      'CREATE TABLE original_pending (id integer);'
    );
    const lockClient = await project.pool.connect();
    await lockClient.query(
      `SELECT pg_advisory_lock(hashtext(current_database()), hashtext('blendsdk:migrations:v1'))`
    );
    const waitingRunner = runMigrations({ command: 'up', configPath: project.configPath });
    await waitForMigrationSession(project);
    const original = await readFile(migration.path, 'utf8');
    await writeFile(
      migration.path,
      original.replace(
        'CREATE TABLE original_pending (id integer);',
        'CREATE TABLE replaced_pending (id integer);'
      ),
      'utf8'
    );
    await lockClient.query(
      `SELECT pg_advisory_unlock(hashtext(current_database()), hashtext('blendsdk:migrations:v1'))`
    );
    lockClient.release();

    await expectRunnerError(() => waitingRunner, 'INVALID_HISTORY');

    expect(await ledgerExists(project)).toBe(false);
    for (const table of ['original_pending', 'replaced_pending']) {
      const result = await project.pool.query(`SELECT to_regclass($1) AS name`, [
        `public.${table}`,
      ]);
      expect(result.rows[0]?.name).toBeNull();
    }
    await project.pool.end();
  });

  test('should revalidate applied history after waiting for the advisory lock', async () => {
    // A lock wait creates an edit window for applied files as well as the pending file being run.
    const project = await createProject({ lockTimeoutMs: 500 });
    const applied = await writeMigration(
      project,
      '20260827120100_applied-before-wait',
      'CREATE TABLE applied_before_wait (id integer);'
    );
    await runMigrations({ command: 'up', configPath: project.configPath });
    await writeMigration(
      project,
      '20260827120200_pending-after-wait',
      'CREATE TABLE must_not_execute_after_wait (id integer);'
    );
    const lockClient = await project.pool.connect();
    await lockClient.query(
      `SELECT pg_advisory_lock(hashtext(current_database()), hashtext('blendsdk:migrations:v1'))`
    );
    const waitingRunner = runMigrations({ command: 'up', configPath: project.configPath });
    await waitForMigrationSession(project);
    const original = await readFile(applied.path, 'utf8');
    await writeFile(
      applied.path,
      original.replace('CREATE TABLE', '/* edited */\nCREATE TABLE'),
      'utf8'
    );
    await lockClient.query(
      `SELECT pg_advisory_unlock(hashtext(current_database()), hashtext('blendsdk:migrations:v1'))`
    );
    lockClient.release();

    await expectRunnerError(() => waitingRunner, 'INVALID_HISTORY');

    expect(await ledgerRows(project)).toHaveLength(1);
    const pending = await project.pool.query(`SELECT to_regclass($1) AS name`, [
      'public.must_not_execute_after_wait',
    ]);
    expect(pending.rows[0]?.name).toBeNull();
    await project.pool.end();
  });

  test('should validate local history without a configured database URL', async () => {
    // Offline validation remains useful in development and CI without requiring database credentials.
    const project = await createProject();
    const migration = await writeMigration(project, '20260827120100_offline', 'SELECT 1;');
    delete process.env[project.databaseUrlEnvironment];

    const valid = await runMigrations({ command: 'validate', configPath: project.configPath });
    expect(valid.status).toBe('UP_TO_DATE');

    const original = await readFile(migration.path, 'utf8');
    await writeFile(migration.path, original.trimEnd(), 'utf8');
    const invalid = await runMigrations({ command: 'validate', configPath: project.configPath });
    expect(invalid).toEqual({ status: 'INVALID_HISTORY', migrations: [] });
    await project.pool.end();
  });

  test('should reject an empty incompatible ledger without altering its shape', async () => {
    const project = await createProject();
    await project.pool.query(`CREATE TABLE public.blendsdk_migrations (unexpected text)`);
    const columns = `SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'blendsdk_migrations'
      ORDER BY ordinal_position`;
    const before = await project.pool.query(columns);

    const result = await runMigrations({ command: 'status', configPath: project.configPath });

    expect(result.status).toBe('INVALID_HISTORY');
    expect((await project.pool.query(columns)).rows).toEqual(before.rows);
    await project.pool.end();
  });

  test('should reject a ledger with correct columns but weakened safety checks', async () => {
    // Column names alone are insufficient when altered predicates permit impossible lifecycle rows.
    const project = await createProject();
    await project.pool.query(`
      CREATE TABLE public.blendsdk_migrations (
        id text PRIMARY KEY,
        checksum char(64) NOT NULL,
        from_snapshot char(64),
        to_snapshot char(64),
        state text NOT NULL CHECK (state IN ('APPLIED', 'NONTRANSACTIONAL_DIRTY') OR true),
        applied_at timestamptz,
        execution_ms bigint CHECK (execution_ms >= 0 OR true),
        CHECK (
          (state = 'APPLIED' AND applied_at IS NOT NULL AND execution_ms IS NOT NULL) OR
          (state = 'NONTRANSACTIONAL_DIRTY' AND applied_at IS NULL AND execution_ms IS NULL) OR
          true
        )
      )
    `);
    const constraints = `SELECT conname, contype, condeferrable,
        pg_get_constraintdef(oid, true) AS definition
      FROM pg_constraint
      WHERE conrelid = 'public.blendsdk_migrations'::regclass
      ORDER BY conname`;
    const before = await project.pool.query(constraints);

    const result = await runMigrations({ command: 'status', configPath: project.configPath });

    expect(result.status).toBe('INVALID_HISTORY');
    expect((await project.pool.query(constraints)).rows).toEqual(before.rows);
    await project.pool.end();
  });

  test('should complete a successful nontransactional down and remove its dirty marker', async () => {
    const project = await createProject();
    await writeMigration(
      project,
      '20260827120100_nontransactional-down',
      'CREATE TABLE nontransactional_down (id integer);',
      { transactional: false, downBody: 'DROP TABLE nontransactional_down;' }
    );
    await runMigrations({ command: 'up', configPath: project.configPath });

    await runMigrations({ command: 'down', configPath: project.configPath, allowDown: true });

    expect(await ledgerRows(project)).toHaveLength(0);
    const result = await project.pool.query(`SELECT to_regclass($1) AS name`, [
      'public.nontransactional_down',
    ]);
    expect(result.rows[0]?.name).toBeNull();
    await project.pool.end();
  });

  test('should retain a dirty marker after a known nontransactional down failure', async () => {
    const project = await createProject();
    await writeMigration(
      project,
      '20260827120100_nontransactional-down-failure',
      'CREATE TABLE nontransactional_down_failure (id integer);',
      { transactional: false, downBody: 'SELECT missing_down_function();' }
    );
    await runMigrations({ command: 'up', configPath: project.configPath });

    await expectRunnerError(
      () => runMigrations({ command: 'down', configPath: project.configPath, allowDown: true }),
      'DATABASE'
    );

    expect(await ledgerRows(project)).toEqual([
      expect.objectContaining({ state: 'NONTRANSACTIONAL_DIRTY', applied: false }),
    ]);
    expect(
      (await runMigrations({ command: 'status', configPath: project.configPath })).status
    ).toBe('UNKNOWN_OUTCOME');
    await project.pool.end();
  });

  test('should report unknown outcome and retain a dirty marker after nontransactional down loses its session', async () => {
    const project = await createProject();
    await writeMigration(
      project,
      '20260827120100_nontransactional-down-unknown',
      'CREATE TABLE nontransactional_down_unknown (id integer);',
      { transactional: false, downBody: 'SELECT pg_terminate_backend(pg_backend_pid());' }
    );
    await runMigrations({ command: 'up', configPath: project.configPath });

    await expectRunnerError(
      () => runMigrations({ command: 'down', configPath: project.configPath, allowDown: true }),
      'UNKNOWN_OUTCOME'
    );

    expect(await ledgerRows(project)).toEqual([
      expect.objectContaining({ state: 'NONTRANSACTIONAL_DIRTY', applied: false }),
    ]);
    await project.pool.end();
  });
});
