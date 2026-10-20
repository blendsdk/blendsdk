import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { MigrationError, formatMigrationError } from '../../src/migration/errors.js';
import { markMigrationApplied } from '../../src/migration/ledger.js';
import { isMigrationLockHeld } from '../../src/migration/migration-lock.js';
import { runMigrations } from '../../src/migration/runner.js';
import {
  cleanupRunnerTest,
  createLedger,
  createProject,
  expectRunnerError,
  insertLedgerRow,
  ledgerRows,
  setupRunnerTests,
  teardownRunnerTests,
  writeMigration,
} from './runner.test-support.js';

beforeAll(setupRunnerTests);
afterEach(cleanupRunnerTest);
afterAll(teardownRunnerTests);

describe.sequential('PostgreSQL migration runner implementation', () => {
  test('closes the runner pool after a failed migration releases its dedicated client', async () => {
    const project = await createProject();
    await writeMigration(project, '20260828021100_failure', 'SELECT missing_runner_function();');

    await expectRunnerError(
      () => runMigrations({ command: 'up', configPath: project.configPath }),
      'DATABASE'
    );

    const result = await project.pool.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = 'blendsdk-migrations'
    `);
    expect(result.rows[0]?.count).toBe(0);
    await project.pool.end();
  });

  test('rejects a guarded state transition when the row is no longer dirty', async () => {
    const project = await createProject();
    const migration = await writeMigration(project, '20260828021200_guard', 'SELECT 1;');
    await createLedger(project);
    await insertLedgerRow(project, migration);
    const client = await project.pool.connect();

    await expect(markMigrationApplied(client, migration, 1)).rejects.toMatchObject({
      kind: 'INVALID_HISTORY',
    });
    client.release();

    expect(await ledgerRows(project)).toEqual([
      expect.objectContaining({ state: 'APPLIED', execution_ms: '0' }),
    ]);
    await project.pool.end();
  });

  test('cancels active SQL without leaking the lock-owning client', async () => {
    const project = await createProject({ statementTimeoutMs: 10_000 });
    await writeMigration(project, '20260828021300_abort', 'SELECT pg_sleep(5);');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 80);

    await expectRunnerError(
      () =>
        runMigrations({
          command: 'up',
          configPath: project.configPath,
          signal: controller.signal,
        }),
      'ABORTED'
    );
    clearTimeout(timer);

    const retry = await runMigrations({
      command: 'up',
      configPath: project.configPath,
      dryRun: true,
    });
    expect(retry.status).toBe('PENDING');
    await project.pool.end();
  });

  test('preserves provider identity when an observation client loses its connection', async () => {
    const project = await createProject();
    const client = await project.pool.connect();
    client.on('error', () => undefined);
    const backend = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = backend.rows[0]?.pid;
    if (!pid) throw new Error('PostgreSQL did not return the observation backend PID.');
    await project.pool.query('SELECT pg_terminate_backend($1)', [pid]);

    try {
      await isMigrationLockHeld(client);
      throw new Error('Expected the terminated observation client to reject.');
    } catch (error) {
      expect(error).not.toBeInstanceOf(MigrationError);
    } finally {
      client.release(true);
    }
    await project.pool.end();
  });

  test('redacts database URLs and credential assignments at the error boundary', () => {
    const error = new MigrationError({
      kind: 'DATABASE',
      exitCode: 1,
      message:
        'Connection postgresql://operator:secret@example.test/db failed with password=second-secret',
    });

    expect(error.message).not.toContain('operator');
    expect(formatMigrationError(error)).toBe(
      'DATABASE: Connection [REDACTED_DATABASE_URL] failed with password=[REDACTED]'
    );
  });
});
