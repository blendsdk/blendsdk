import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { formatMigrationError } from '../../src/migration/errors.js';
import { parseMigrationFile } from '../../src/migration/migration-file.js';
import { runMigrations } from '../../src/migration/runner.js';
import {
  cleanupRunnerTest,
  createLedger,
  createProject,
  expectRunnerError,
  insertLedgerRow,
  ledgerExists,
  ledgerName,
  ledgerRows,
  setupRunnerTests,
  teardownRunnerTests,
  writeMigration,
} from './runner.test-support.js';

beforeAll(setupRunnerTests);
afterEach(cleanupRunnerTest);
afterAll(teardownRunnerTests);

describe.sequential('PostgreSQL migration runner', () => {
  test('should reject an edited applied file for validate, status, and up before SQL executes', async () => {
    // Exact checksums make even a one-byte history edit a fail-closed prefix violation.
    const project = await createProject();
    const id = '20260827120000_create-edit-guard';
    const migration = await writeMigration(project, id, 'CREATE TABLE edit_guard (id integer);');
    await runMigrations({ command: 'up', configPath: project.configPath });
    const original = await readFile(migration.path, 'utf8');
    await writeFile(migration.path, original.replace('integer', 'bigint'), 'utf8');

    for (const command of ['validate', 'status'] as const) {
      const result = await runMigrations({ command, configPath: project.configPath });
      expect(result.status).toBe('INVALID_HISTORY');
    }
    const error = await expectRunnerError(
      () => runMigrations({ command: 'up', configPath: project.configPath }),
      'INVALID_HISTORY'
    );
    expect(formatMigrationError(error)).toMatch(/checksum/iu);
    expect(formatMigrationError(error)).not.toContain('CREATE TABLE');
    expect(
      (await project.pool.query('SELECT count(*)::int AS count FROM edit_guard')).rows[0]
    ).toMatchObject({ count: 0 });
    await project.pool.end();
  });

  test.each([
    ['missing', ['20260827120100_a']],
    ['inserted', ['20260827120050_x', '20260827120100_a', '20260827120200_b']],
    ['reordered', ['20260827120200_b', '20260827120100_a']],
  ])('should reject %s local history against the applied ordered prefix', async (_case, ids) => {
    // Applied rows must be the exact beginning of local history, never a set membership match.
    const project = await createProject();
    const descriptors = new Map<string, Awaited<ReturnType<typeof parseMigrationFile>>>();
    for (const id of ['20260827120050_x', '20260827120100_a', '20260827120200_b']) {
      descriptors.set(id, await writeMigration(project, id, 'SELECT 1;'));
    }
    await createLedger(project);
    const first = descriptors.get('20260827120100_a');
    const second = descriptors.get('20260827120200_b');
    if (!first || !second) throw new Error('Prefix fixtures were not created.');
    if (_case === 'reordered') {
      await project.pool.query(
        `INSERT INTO ${ledgerName}
          (id, checksum, state, applied_at, execution_ms)
         VALUES ($1, $2, 'APPLIED', now(), 0), ($3, $4, 'APPLIED', now(), 0)`,
        [first.id, second.checksum, second.id, first.checksum]
      );
    } else {
      await insertLedgerRow(project, first);
      await insertLedgerRow(project, second);
    }
    for (const [id, descriptor] of descriptors) {
      if (!ids.includes(id)) await rm(descriptor.path);
    }

    const result = await runMigrations({ command: 'validate', configPath: project.configPath });
    expect(result.status).toBe('INVALID_HISTORY');
    expect(await ledgerRows(project)).toHaveLength(2);
    await project.pool.end();
  });

  test('should treat the ledger as an exact prefix and report only the final local migration pending', async () => {
    const project = await createProject();
    const first = await writeMigration(project, '20260827120100_a', 'SELECT 1;');
    const second = await writeMigration(project, '20260827120200_b', 'SELECT 2;');
    const third = await writeMigration(project, '20260827120300_c', 'SELECT 3;');
    await createLedger(project);
    await insertLedgerRow(project, first);
    await insertLedgerRow(project, second);

    const result = await runMigrations({ command: 'status', configPath: project.configPath });

    expect(result.status).toBe('PENDING');
    expect(result.migrations.map(migration => migration.id)).toEqual([third.id]);
    await project.pool.end();
  });

  test('should dry-run pending order without creating the ledger or executing SQL', async () => {
    const project = await createProject();
    const first = await writeMigration(
      project,
      '20260827120100_first',
      'CREATE TABLE dry_run_guard (id integer);'
    );
    const second = await writeMigration(project, '20260827120200_second', 'SELECT 2;');

    const result = await runMigrations({
      command: 'up',
      configPath: project.configPath,
      dryRun: true,
    });

    expect(result.status).toBe('PENDING');
    expect(result.migrations.map(migration => migration.id)).toEqual([first.id, second.id]);
    expect(await ledgerExists(project)).toBe(false);
    expect(
      (await project.pool.query(`SELECT to_regclass('public.dry_run_guard') AS name`)).rows[0]?.name
    ).toBeNull();
    await project.pool.end();
  });

  test('should allow only one same-database runner to execute while the other times out locked', async () => {
    // A slow first migration keeps the database-scoped lock long enough to exercise contention.
    const project = await createProject({ lockTimeoutMs: 80, statementTimeoutMs: 30_000 });
    await writeMigration(
      project,
      '20260827120100_lock-race',
      'CREATE TABLE lock_race (id integer); SELECT pg_sleep(0.4);'
    );
    const first = runMigrations({ command: 'up', configPath: project.configPath });
    await new Promise(resolve => setTimeout(resolve, 40));
    const secondError = await expectRunnerError(
      () => runMigrations({ command: 'up', configPath: project.configPath }),
      'LOCKED'
    );
    await first;

    expect(secondError.kind).toBe('LOCKED');
    expect(await ledgerRows(project)).toHaveLength(1);
    await project.pool.end();
  });

  test('should stop at the lock deadline without creating a ledger or executing SQL', async () => {
    const project = await createProject({ lockTimeoutMs: 50 });
    await writeMigration(project, '20260827120100_locked', 'CREATE TABLE lock_guard (id integer);');
    const lockClient = await project.pool.connect();
    await lockClient.query(
      `SELECT pg_advisory_lock(hashtext(current_database()), hashtext('blendsdk:migrations:v1'))`
    );

    await expectRunnerError(
      () => runMigrations({ command: 'up', configPath: project.configPath }),
      'LOCKED'
    );

    expect(await ledgerExists(project)).toBe(false);
    expect(
      (await project.pool.query(`SELECT to_regclass('public.lock_guard') AS name`)).rows[0]?.name
    ).toBeNull();
    await lockClient.query(
      `SELECT pg_advisory_unlock(hashtext(current_database()), hashtext('blendsdk:migrations:v1'))`
    );
    lockClient.release();
    await project.pool.end();
  });

  test('should scope migration locks independently to each database', async () => {
    const firstProject = await createProject({ lockTimeoutMs: 80 });
    const secondProject = await createProject({ lockTimeoutMs: 80 });
    await writeMigration(firstProject, '20260827120100_first-db', 'SELECT pg_sleep(0.3);');
    await writeMigration(secondProject, '20260827120100_second-db', 'SELECT pg_sleep(0.3);');

    const first = runMigrations({ command: 'up', configPath: firstProject.configPath });
    const second = runMigrations({ command: 'up', configPath: secondProject.configPath });
    const results = await Promise.all([first, second]);

    expect(results.map(result => result.status)).toEqual(['UP_TO_DATE', 'UP_TO_DATE']);
    expect(await ledgerRows(firstProject)).toHaveLength(1);
    expect(await ledgerRows(secondProject)).toHaveLength(1);
    await firstProject.pool.end();
    await secondProject.pool.end();
  });

  test('should roll back a transactional migration and stop before the next file', async () => {
    const project = await createProject();
    await writeMigration(
      project,
      '20260827120100_broken',
      'CREATE TABLE rolled_back (id integer); SELECT missing_function();'
    );
    await writeMigration(
      project,
      '20260827120200_later',
      'CREATE TABLE not_attempted (id integer);'
    );

    await expectRunnerError(
      () => runMigrations({ command: 'up', configPath: project.configPath }),
      'DATABASE'
    );

    expect(
      (await project.pool.query(`SELECT to_regclass('public.rolled_back') AS name`)).rows[0]?.name
    ).toBeNull();
    expect(
      (await project.pool.query(`SELECT to_regclass('public.not_attempted') AS name`)).rows[0]?.name
    ).toBeNull();
    expect(await ledgerExists(project)).toBe(false);
    await project.pool.end();
  });

  test('should commit successful transactional SQL and exact ledger metadata together', async () => {
    const project = await createProject();
    const fromSnapshot = '1'.repeat(64);
    const snapshotBytes = Buffer.from('{"formatVersion":1}\n');
    const toSnapshot = createHash('sha256').update(snapshotBytes).digest('hex');
    await writeFile(join(project.migrationsDir, 'schema.snapshot.json'), snapshotBytes);
    const migration = await writeMigration(
      project,
      '20260827120100_transactional',
      'CREATE TABLE transactional_effect (id integer);',
      { fromSnapshot, toSnapshot }
    );

    await runMigrations({ command: 'up', configPath: project.configPath });

    expect(
      (await project.pool.query(`SELECT to_regclass('public.transactional_effect') AS name`))
        .rows[0]?.name
    ).toBe('transactional_effect');
    expect(await ledgerRows(project)).toEqual([
      expect.objectContaining({
        id: migration.id,
        checksum: migration.checksum,
        from_snapshot: fromSnapshot,
        to_snapshot: toSnapshot,
        state: 'APPLIED',
        applied: true,
      }),
    ]);
    await project.pool.end();
  });

  test('should promote a successful nontransactional dirty marker to APPLIED', async () => {
    const project = await createProject();
    await writeMigration(
      project,
      '20260827120100_nontransactional',
      'CREATE TABLE nontransactional_effect (id integer);',
      { transactional: false }
    );

    await runMigrations({ command: 'up', configPath: project.configPath });

    expect(await ledgerRows(project)).toEqual([
      expect.objectContaining({ state: 'APPLIED', applied: true }),
    ]);
    await project.pool.end();
  });

  test('should retain a durable dirty row when the session is lost after nontransactional dispatch', async () => {
    const project = await createProject();
    await writeMigration(
      project,
      '20260827120100_unknown',
      'SELECT pg_terminate_backend(pg_backend_pid());',
      { transactional: false }
    );

    const error = await expectRunnerError(
      () => runMigrations({ command: 'up', configPath: project.configPath }),
      'UNKNOWN_OUTCOME'
    );

    expect(error.kind).toBe('UNKNOWN_OUTCOME');
    expect(await ledgerRows(project)).toEqual([
      expect.objectContaining({ state: 'NONTRANSACTIONAL_DIRTY', applied: false }),
    ]);
    await project.pool.end();
  });

  test('should enforce statement timeout and roll back transactional effects', async () => {
    const project = await createProject({ statementTimeoutMs: 50 });
    await writeMigration(
      project,
      '20260827120100_timeout',
      'CREATE TABLE timeout_effect (id integer); SELECT pg_sleep(1);'
    );

    const error = await expectRunnerError(
      () => runMigrations({ command: 'up', configPath: project.configPath }),
      'DATABASE'
    );

    expect(formatMigrationError(error)).not.toContain('pg_sleep');
    expect(
      (await project.pool.query(`SELECT to_regclass('public.timeout_effect') AS name`)).rows[0]
        ?.name
    ).toBeNull();
    expect(await ledgerExists(project)).toBe(false);
    await project.pool.end();
  });

  test('should return all five status discriminators from observable database states', async () => {
    const project = await createProject({ lockTimeoutMs: 50 });
    expect(
      (await runMigrations({ command: 'status', configPath: project.configPath })).status
    ).toBe('UP_TO_DATE');
    const pending = await writeMigration(project, '20260827120100_pending', 'SELECT 1;');
    expect(
      (await runMigrations({ command: 'status', configPath: project.configPath })).status
    ).toBe('PENDING');
    await createLedger(project);
    await insertLedgerRow(project, pending);
    expect(
      (await runMigrations({ command: 'status', configPath: project.configPath })).status
    ).toBe('UP_TO_DATE');
    await project.pool.query(`UPDATE ${ledgerName} SET checksum = $1`, ['f'.repeat(64)]);
    expect(
      (await runMigrations({ command: 'status', configPath: project.configPath })).status
    ).toBe('INVALID_HISTORY');
    await project.pool.query(
      `UPDATE ${ledgerName} SET checksum = $1, state = 'NONTRANSACTIONAL_DIRTY', applied_at = NULL, execution_ms = NULL`,
      [pending.checksum]
    );
    expect(
      (await runMigrations({ command: 'status', configPath: project.configPath })).status
    ).toBe('UNKNOWN_OUTCOME');
    await project.pool.query(
      `UPDATE ${ledgerName} SET state = 'APPLIED', applied_at = now(), execution_ms = 0`
    );
    const lockClient = await project.pool.connect();
    await lockClient.query(
      `SELECT pg_advisory_lock(hashtext(current_database()), hashtext('blendsdk:migrations:v1'))`
    );
    expect(
      (await runMigrations({ command: 'status', configPath: project.configPath })).status
    ).toBe('LOCKED');
    await lockClient.query(
      `SELECT pg_advisory_unlock(hashtext(current_database()), hashtext('blendsdk:migrations:v1'))`
    );
    lockClient.release();
    await project.pool.end();
  });

  test('should refuse down without confirmation or without the latest down file', async () => {
    const project = await createProject();
    await writeMigration(project, '20260827120100_no-down', 'CREATE TABLE no_down (id integer);');
    await runMigrations({ command: 'up', configPath: project.configPath });

    await expectRunnerError(
      () => runMigrations({ command: 'down', configPath: project.configPath }),
      undefined
    );
    await expectRunnerError(
      () => runMigrations({ command: 'down', configPath: project.configPath, allowDown: true }),
      'INVALID_HISTORY'
    );
    expect(await ledgerRows(project)).toHaveLength(1);
    expect(
      (await project.pool.query(`SELECT to_regclass('public.no_down') AS name`)).rows[0]?.name
    ).toBe('no_down');
    await project.pool.end();
  });

  test('should transactionally revert exactly the latest migration and its row', async () => {
    const project = await createProject();
    await writeMigration(project, '20260827120100_first', 'CREATE TABLE down_first (id integer);', {
      downBody: 'DROP TABLE down_first;',
    });
    await writeMigration(
      project,
      '20260827120200_second',
      'CREATE TABLE down_second (id integer);',
      { downBody: 'DROP TABLE down_second;' }
    );
    await runMigrations({ command: 'up', configPath: project.configPath });

    await runMigrations({ command: 'down', configPath: project.configPath, allowDown: true });

    expect(
      (await project.pool.query(`SELECT to_regclass('public.down_first') AS name`)).rows[0]?.name
    ).toBe('down_first');
    expect(
      (await project.pool.query(`SELECT to_regclass('public.down_second') AS name`)).rows[0]?.name
    ).toBeNull();
    expect((await ledgerRows(project)).map(row => row.id)).toEqual(['20260827120100_first']);
    await project.pool.end();
  });

  test('should preserve completed rows and release the lock when aborted before the next migration', async () => {
    const project = await createProject();
    await writeMigration(project, '20260827120100_done', 'CREATE TABLE abort_done (id integer);');
    await runMigrations({ command: 'up', configPath: project.configPath });
    await writeMigration(
      project,
      '20260827120200_pending',
      'CREATE TABLE abort_pending (id integer);'
    );
    const controller = new AbortController();
    controller.abort();

    await expectRunnerError(
      () =>
        runMigrations({
          command: 'up',
          configPath: project.configPath,
          signal: controller.signal,
        }),
      'ABORTED'
    );

    expect((await ledgerRows(project)).map(row => row.id)).toEqual(['20260827120100_done']);
    expect(
      (await runMigrations({ command: 'status', configPath: project.configPath })).status
    ).toBe('PENDING');
    await project.pool.end();
  });

  test('should roll back an active transaction when aborted without recording success', async () => {
    const project = await createProject({ statementTimeoutMs: 10_000 });
    await writeMigration(
      project,
      '20260827120100_abort-active',
      'CREATE TABLE abort_active (id integer); SELECT pg_sleep(5);'
    );
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

    expect(
      (await project.pool.query(`SELECT to_regclass('public.abort_active') AS name`)).rows[0]?.name
    ).toBeNull();
    expect(await ledgerExists(project)).toBe(false);
    await project.pool.end();
  });

  test('should treat an absent ledger as empty for status, validate, and dry-run without creating it', async () => {
    const project = await createProject();
    await writeMigration(project, '20260827120100_absent', 'SELECT 1;');

    expect(
      (await runMigrations({ command: 'status', configPath: project.configPath })).status
    ).toBe('PENDING');
    expect(
      (await runMigrations({ command: 'validate', configPath: project.configPath })).status
    ).toBe('PENDING');
    await runMigrations({ command: 'up', configPath: project.configPath, dryRun: true });
    expect(await ledgerExists(project)).toBe(false);
    await project.pool.end();
  });

  test('should redact SQL literals and database credentials from operational failures', async () => {
    const project = await createProject();
    const credentialUrl = project.databaseUrl.replace('postgres:postgres', 'postgres:db-secret');
    process.env[project.databaseUrlEnvironment] = credentialUrl;
    await writeMigration(
      project,
      '20260827120100_secret',
      `DO $$ BEGIN RAISE EXCEPTION 'password=sql-secret'; END $$;`
    );

    const error = await expectRunnerError(
      () => runMigrations({ command: 'up', configPath: project.configPath }),
      'DATABASE'
    );
    const output = formatMigrationError(error);

    expect(output).not.toContain('sql-secret');
    expect(output).not.toContain('db-secret');
    expect(output).not.toContain('DO $$');
    await project.pool.end();
  });

  test.each([
    ['bad hash', 'not-a-hash', 'APPLIED', new Date(), 0],
    ['negative duration', 'a'.repeat(64), 'APPLIED', new Date(), -1],
    ['unknown state', 'a'.repeat(64), 'MYSTERY', new Date(), 0],
  ])(
    'should report INVALID_HISTORY for ledger row with %s',
    async (_case, checksum, state, appliedAt, executionMs) => {
      const project = await createProject();
      const migration = await writeMigration(
        project,
        '20260827120100_invalid-row',
        'CREATE TABLE must_not_run (id integer);'
      );
      await project.pool.query(`
      CREATE TABLE public.blendsdk_migrations (
        id text, checksum text, from_snapshot text, to_snapshot text,
        state text, applied_at timestamptz, execution_ms bigint
      )
    `);
      await project.pool.query(
        `INSERT INTO ${ledgerName} VALUES ($1, $2, NULL, NULL, $3, $4, $5)`,
        [migration.id, checksum, state, appliedAt, executionMs]
      );

      const result = await runMigrations({ command: 'status', configPath: project.configPath });

      expect(result.status).toBe('INVALID_HISTORY');
      expect(
        (await project.pool.query(`SELECT to_regclass('public.must_not_run') AS name`)).rows[0]
          ?.name
      ).toBeNull();
      await project.pool.end();
    }
  );

  test('should carry generated lineage across an intervening manual null-lineage migration', async () => {
    const project = await createProject();
    const firstHash = '1'.repeat(64);
    const snapshotBytes = Buffer.from('{"formatVersion":1,"marker":"second"}\n');
    const secondHash = createHash('sha256').update(snapshotBytes).digest('hex');
    await writeFile(join(project.migrationsDir, 'schema.snapshot.json'), snapshotBytes);
    await writeMigration(project, '20260827120100_generated-a', 'SELECT 1;', {
      fromSnapshot: '0'.repeat(64),
      toSnapshot: firstHash,
    });
    await writeMigration(project, '20260827120200_manual', 'SELECT 2;');
    await writeMigration(project, '20260827120300_generated-b', 'SELECT 3;', {
      fromSnapshot: firstHash,
      toSnapshot: secondHash,
    });

    await runMigrations({ command: 'up', configPath: project.configPath });

    expect((await ledgerRows(project)).map(row => [row.from_snapshot, row.to_snapshot])).toEqual([
      ['0'.repeat(64), firstHash],
      [null, null],
      [firstHash, secondHash],
    ]);
    await project.pool.end();
  });

  test('should roll back down SQL when the guarded ledger delete matches no row', async () => {
    // The down SQL removes its own row inside the transaction, forcing the runner's guard to fail.
    const project = await createProject();
    const id = '20260827120100_delete-race';
    await writeMigration(project, id, 'CREATE TABLE delete_guard (id integer);', {
      downBody: `DROP TABLE delete_guard; DELETE FROM ${ledgerName} WHERE id = '${id}';`,
    });
    await runMigrations({ command: 'up', configPath: project.configPath });

    await expectRunnerError(
      () => runMigrations({ command: 'down', configPath: project.configPath, allowDown: true }),
      'INVALID_HISTORY'
    );

    expect(
      (await project.pool.query(`SELECT to_regclass('public.delete_guard') AS name`)).rows[0]?.name
    ).toBe('delete_guard');
    expect(await ledgerRows(project)).toHaveLength(1);
    await project.pool.end();
  });
});
