import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  adoptBaseline,
  generateBaseline,
  type AdoptionPreview,
} from '../../src/migration/baseline.js';
import { projectPostgreSqlCatalog } from '../../src/migration/catalog-projector.js';
import { formatMigrationError, MigrationError } from '../../src/migration/errors.js';
import { generateMigration } from '../../src/migration/generate.js';
import { parseMigrationFile } from '../../src/migration/migration-file.js';
import { runMigrations } from '../../src/migration/runner.js';
import { serializeSnapshot } from '../../src/migration/snapshot.js';
import type { MigrationDescriptor } from '../../src/migration/types.js';
import {
  cleanupRunnerTest,
  createLedger,
  createProject,
  expectRunnerError,
  insertLedgerRow,
  ledgerExists,
  ledgerRows,
  setupRunnerTests,
  teardownRunnerTests,
  type TestProject,
} from './runner.test-support.js';

const baselineInstant = new Date('2026-08-27T09:00:00Z');

/** Provides one compact supported schema as a TypeScript module body. */
function customerSchema(extra = ''): string {
  return `
const schema = new DatabaseSchema('app');
const customer = schema.table('customer');
customer.bigint('id').primaryKey();
customer.text('name').nullable().comment('customer name');
${extra}
export default schema;`;
}

/** Adds a schema module to an isolated runner project and updates its migration configuration. */
async function configureSchema(project: TestProject, schemaBody = customerSchema()): Promise<void> {
  const projectDirectory = dirname(project.configPath);
  const databaseSchemaUrl = pathToFileURL(
    join(process.cwd(), 'src/database/schema/database-schema.ts')
  ).href;
  await writeFile(
    join(projectDirectory, 'schema.ts'),
    `import { DatabaseSchema } from ${JSON.stringify(databaseSchemaUrl)};\n${schemaBody}\n`,
    'utf8'
  );
  await writeFile(
    project.configPath,
    `export default ${JSON.stringify({
      schema: './schema.ts',
      databaseUrlEnv: project.databaseUrlEnvironment,
      lockTimeoutMs: 200,
      statementTimeoutMs: 30_000,
    })};\n`,
    'utf8'
  );
}

/** Waits until both adoption and its competing runner are visible on the target database. */
async function waitForCompetingMigrationSession(project: TestProject): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await project.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM pg_stat_activity
       WHERE datname = current_database() AND application_name = 'blendsdk-migrations'`
    );
    if ((result.rows[0]?.count ?? 0) >= 2) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The competing migration session was not observable before the test deadline.');
}

/** Returns the confirmation token tied to one exact database and baseline identifier. */
function confirmationToken(project: TestProject, baselineId: string): string {
  return `${new URL(project.databaseUrl).pathname.slice(1)}/${baselineId}`;
}

/** Returns only executable SQL after the strict five-line migration header. */
async function migrationBody(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).split('\n').slice(5).join('\n');
}

/** Generates the one local baseline required by adoption fixtures. */
async function prepareBaseline(project: TestProject) {
  await configureSchema(project);
  const result = await generateBaseline({
    name: 'initial',
    configPath: project.configPath,
    now: baselineInstant,
  });
  if (!result.migration) throw new Error('Baseline generation did not return its migration.');
  return result;
}

/** Narrows a successful baseline result to its required immutable migration. */
function requiredMigration(result: {
  readonly migration?: MigrationDescriptor;
}): MigrationDescriptor {
  if (!result.migration) throw new Error('Baseline fixture is missing its migration.');
  return result.migration;
}

/** Captures invalid invocation input whose public exit class is two. */
async function expectConfigurationError(action: () => Promise<unknown>): Promise<MigrationError> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof MigrationError)) throw error;
    expect(error.kind).toBe('CONFIGURATION');
    expect(error.exitCode).toBe(2);
    return error;
  }
  throw new Error('Expected a configuration error.');
}

/** Applies baseline DDL directly to model a pre-existing database without recording history. */
async function createExistingState(project: TestProject, migrationPath: string): Promise<void> {
  await project.pool.query(await migrationBody(migrationPath));
}

beforeAll(setupRunnerTests);
afterEach(cleanupRunnerTest);
afterAll(teardownRunnerTests);

describe.sequential('offline baseline generation', () => {
  test('should create exactly one complete baseline migration and one canonical snapshot', async () => {
    // A new project starts one immutable lineage without consulting PostgreSQL.
    const project = await createProject();
    await configureSchema(project);
    delete process.env[project.databaseUrlEnvironment];

    const result = await generateBaseline({
      name: 'initial',
      configPath: project.configPath,
      now: baselineInstant,
    });
    const files = (await readdir(project.migrationsDir)).sort();
    const migrationPath = join(project.migrationsDir, '20260827090000_initial.up.sql');
    const migration = await parseMigrationFile(migrationPath);
    const snapshotBytes = await readFile(join(project.migrationsDir, 'schema.snapshot.json'));

    expect(result.status).toBe('GENERATED');
    expect(files).toEqual(['20260827090000_initial.up.sql', 'schema.snapshot.json']);
    expect(migration.fromSnapshot).toBeUndefined();
    expect(migration.toSnapshot).toBe(result.snapshotHash);
    expect(snapshotBytes.toString('utf8')).toMatch(/^\{\n  "formatVersion": 1,/u);
    const sql = await readFile(migrationPath, 'utf8');
    expect(sql).toContain('CREATE TABLE "public"."customer"');
    expect(sql).not.toMatch(/CASCADE|DROP TABLE|DROP SCHEMA/iu);
    await project.pool.end();
  });

  test.each(['snapshot', 'up migration'])(
    'should preserve existing artifacts when %s exists',
    async existing => {
      const project = await createProject();
      await configureSchema(project);
      const path =
        existing === 'snapshot'
          ? join(project.migrationsDir, 'schema.snapshot.json')
          : join(project.migrationsDir, '20260827080000_existing.up.sql');
      const bytes = Buffer.from('preserve-exactly\n');
      await writeFile(path, bytes);
      const before = (await readdir(project.migrationsDir)).sort();

      await expectRunnerError(
        () =>
          generateBaseline({
            name: 'initial',
            configPath: project.configPath,
            now: baselineInstant,
          }),
        'INVALID_HISTORY'
      );

      expect(await readFile(path)).toEqual(bytes);
      expect((await readdir(project.migrationsDir)).sort()).toEqual(before);
      await project.pool.end();
    }
  );

  test('should apply baseline DDL and exact initial lineage through the normal runner', async () => {
    const project = await createProject();
    const baseline = await prepareBaseline(project);
    const migration = requiredMigration(baseline);

    await runMigrations({ command: 'up', configPath: project.configPath });

    expect(
      (await project.pool.query(`SELECT to_regclass('public.customer') AS name`)).rows[0]?.name
    ).toBe('customer');
    expect(await ledgerRows(project)).toEqual([
      expect.objectContaining({
        id: migration.id,
        checksum: migration.checksum,
        from_snapshot: null,
        to_snapshot: baseline.snapshotHash,
        state: 'APPLIED',
      }),
    ]);
    await project.pool.end();
  });

  test('should converge a safely migrated catalog to the desired canonical snapshot', async () => {
    const project = await createProject();
    await prepareBaseline(project);
    await runMigrations({ command: 'up', configPath: project.configPath });
    await configureSchema(project, customerSchema(`customer.text('nickname').nullable();`));
    await generateMigration({
      name: 'add-nickname',
      configPath: project.configPath,
      now: new Date('2026-08-27T10:00:00Z'),
    });
    await runMigrations({ command: 'up', configPath: project.configPath });

    const client = await project.pool.connect();
    const projected = await projectPostgreSqlCatalog(client);
    client.release();
    const desired = await readFile(join(project.migrationsDir, 'schema.snapshot.json'));

    expect(Buffer.from(serializeSnapshot(projected))).toEqual(desired);
    await project.pool.end();
  });
});

describe.sequential('existing database baseline adoption', () => {
  test('should adopt exact supported state after confirmation without running baseline DDL', async () => {
    const project = await createProject();
    const baseline = await prepareBaseline(project);
    const migration = requiredMigration(baseline);
    await createExistingState(project, migration.upPath);
    await project.pool.query(`INSERT INTO public.customer (id, name) VALUES (7, 'preserve me')`);

    const result = await adoptBaseline({
      configPath: project.configPath,
      confirmation: confirmationToken(project, migration.id),
    });

    expect(result.status).toBe('ADOPTED');
    expect(result.comparison.every(item => item.classification === 'MATCH')).toBe(true);
    expect(
      (await project.pool.query(`SELECT name FROM public.customer WHERE id = 7`)).rows
    ).toEqual([{ name: 'preserve me' }]);
    expect(await ledgerRows(project)).toEqual([
      expect.objectContaining({ id: migration.id, checksum: migration.checksum, state: 'APPLIED' }),
    ]);
    await project.pool.end();
  });

  test.each([
    ['MISSING', async (_project: TestProject, _migrationPath: string) => undefined],
    [
      'DIFFERENT',
      async (project: TestProject, migrationPath: string) => {
        await createExistingState(project, migrationPath);
        await project.pool.query(`ALTER TABLE public.customer ALTER COLUMN name TYPE varchar(40)`);
      },
    ],
    [
      'EXTRA_MODELED',
      async (project: TestProject, migrationPath: string) => {
        await createExistingState(project, migrationPath);
        await project.pool.query(`CREATE TABLE public.extra_modeled (id integer)`);
      },
    ],
  ])(
    'should report qualified %s structural mismatch without inserting history',
    async (classification, arrange) => {
      const project = await createProject();
      const baseline = await prepareBaseline(project);
      const migration = requiredMigration(baseline);
      await arrange(project, migration.upPath);

      const error = await expectRunnerError(
        () =>
          adoptBaseline({
            configPath: project.configPath,
            confirmation: confirmationToken(project, migration.id),
          }),
        'UNSUPPORTED'
      );

      expect(error.message).toContain(classification);
      expect(error.message).toMatch(/public\.(customer|extra_modeled)/u);
      expect(await ledgerExists(project)).toBe(false);
      await project.pool.end();
    }
  );

  test('should reject desired raw SQL that cannot be proven structurally equivalent', async () => {
    const project = await createProject();
    await configureSchema(
      project,
      customerSchema(`customer.text('tenant').default("current_setting('app.tenant')");`)
    );
    const baseline = await generateBaseline({
      name: 'initial',
      configPath: project.configPath,
      now: baselineInstant,
    });
    const migration = requiredMigration(baseline);
    await createExistingState(project, migration.upPath);

    const error = await expectRunnerError(
      () =>
        adoptBaseline({
          configPath: project.configPath,
          confirmation: confirmationToken(project, migration.id),
        }),
      'UNSUPPORTED'
    );

    expect(error.message).toContain('UNSUPPORTED_FOR_ADOPTION');
    expect(await ledgerExists(project)).toBe(false);
    await project.pool.end();
  });

  test('should report and preserve unrelated unmanaged functions and triggers', async () => {
    const project = await createProject();
    const baseline = await prepareBaseline(project);
    const migration = requiredMigration(baseline);
    await createExistingState(project, migration.upPath);
    await project.pool.query(`
      CREATE FUNCTION public.unmanaged_touch() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN NEW; END
      $$;
      CREATE TRIGGER unmanaged_customer_touch BEFORE INSERT ON public.customer
      FOR EACH ROW EXECUTE FUNCTION public.unmanaged_touch();
    `);

    const result = await adoptBaseline({
      configPath: project.configPath,
      confirmation: confirmationToken(project, migration.id),
    });

    expect(result.comparison).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          classification: 'UNMANAGED',
          identity: 'public.unmanaged_touch()',
        }),
        expect.objectContaining({
          classification: 'UNMANAGED',
          identity: 'public.customer.unmanaged_customer_touch',
        }),
      ])
    );
    expect(
      (await project.pool.query(`SELECT to_regprocedure('public.unmanaged_touch()') AS name`))
        .rows[0]?.name
    ).not.toBeNull();
    await project.pool.end();
  });

  test('should allow an empty compatible ledger and reject a nonempty ledger', async () => {
    const emptyProject = await createProject();
    const emptyBaseline = await prepareBaseline(emptyProject);
    const emptyMigration = requiredMigration(emptyBaseline);
    await createExistingState(emptyProject, emptyMigration.upPath);
    await createLedger(emptyProject);

    await adoptBaseline({
      configPath: emptyProject.configPath,
      confirmation: confirmationToken(emptyProject, emptyMigration.id),
    });
    expect(await ledgerRows(emptyProject)).toHaveLength(1);
    await emptyProject.pool.end();

    const nonemptyProject = await createProject();
    const nonemptyBaseline = await prepareBaseline(nonemptyProject);
    const nonemptyMigration = requiredMigration(nonemptyBaseline);
    await createExistingState(nonemptyProject, nonemptyMigration.upPath);
    await createLedger(nonemptyProject);
    await insertLedgerRow(nonemptyProject, nonemptyMigration);

    await expectRunnerError(
      () =>
        adoptBaseline({
          configPath: nonemptyProject.configPath,
          confirmation: confirmationToken(nonemptyProject, nonemptyMigration.id),
        }),
      'INVALID_HISTORY'
    );
    expect(await ledgerRows(nonemptyProject)).toHaveLength(1);
    await nonemptyProject.pool.end();
  });

  test('should serialize concurrent adoption and up so at most one can mutate history', async () => {
    const project = await createProject({ lockTimeoutMs: 80 });
    await configureSchema(project);
    const baseline = await generateBaseline({
      name: 'initial',
      configPath: project.configPath,
      now: baselineInstant,
    });
    const migration = requiredMigration(baseline);
    await createExistingState(project, migration.upPath);
    let releaseConfirmation = (): void => undefined;
    let reportPreview = (): void => undefined;
    const confirmationGate = new Promise<void>(resolve => {
      releaseConfirmation = resolve;
    });
    const previewObserved = new Promise<void>(resolve => {
      reportPreview = resolve;
    });
    const adoption = adoptBaseline(
      {
        configPath: project.configPath,
        confirmation: confirmationToken(project, migration.id),
      },
      {
        afterPreview: () => {
          reportPreview();
          return confirmationGate;
        },
      }
    );
    await previewObserved;
    const up = expectRunnerError(
      () => runMigrations({ command: 'up', configPath: project.configPath }),
      'LOCKED'
    );
    try {
      await waitForCompetingMigrationSession(project);
      await up;
    } finally {
      releaseConfirmation();
    }
    await adoption;

    expect(await ledgerRows(project)).toHaveLength(1);
    await project.pool.end();
  });

  test('should roll back when the authoritative catalog differs from the confirmed preview', async () => {
    const project = await createProject();
    const baseline = await prepareBaseline(project);
    const migration = requiredMigration(baseline);
    await createExistingState(project, migration.upPath);

    await expectRunnerError(
      () =>
        adoptBaseline(
          {
            configPath: project.configPath,
            confirmation: confirmationToken(project, migration.id),
          },
          {
            afterPreview: async (_preview: AdoptionPreview) => {
              await project.pool.query(`ALTER TABLE public.customer ADD COLUMN raced integer`);
            },
          }
        ),
      'UNSUPPORTED'
    );

    expect(await ledgerExists(project)).toBe(false);
    await project.pool.end();
  });

  test('should require target-specific DDL-quiescence confirmation before ledger mutation', async () => {
    const project = await createProject();
    const baseline = await prepareBaseline(project);
    const migration = requiredMigration(baseline);
    await createExistingState(project, migration.upPath);

    const error = await expectConfigurationError(() =>
      adoptBaseline({
        configPath: project.configPath,
        confirmation: `wrong-target/${migration.id}`,
      })
    );

    expect(error.message).toMatch(/quiesc|confirm|target/iu);
    expect(await ledgerExists(project)).toBe(false);
    await project.pool.end();
  });

  test('should show a safe target preview before collecting confirmation', async () => {
    const project = await createProject();
    const baseline = await prepareBaseline(project);
    const migration = requiredMigration(baseline);
    await createExistingState(project, migration.upPath);
    let observed: AdoptionPreview | undefined;

    await adoptBaseline(
      { configPath: project.configPath },
      {
        afterPreview: preview => {
          observed = preview;
          return confirmationToken(project, migration.id);
        },
      }
    );

    expect(observed).toMatchObject({
      host: new URL(project.databaseUrl).hostname,
      port: new URL(project.databaseUrl).port,
      user: new URL(project.databaseUrl).username,
      database: new URL(project.databaseUrl).pathname.slice(1),
      baselineId: migration.id,
    });
    await project.pool.end();
  });

  test('should reject a local baseline changed after preview without inserting history', async () => {
    const project = await createProject();
    const baseline = await prepareBaseline(project);
    const migration = requiredMigration(baseline);
    await createExistingState(project, migration.upPath);

    await expectRunnerError(
      () =>
        adoptBaseline(
          { configPath: project.configPath },
          {
            afterPreview: async () => {
              await writeFile(
                migration.upPath,
                `${await readFile(migration.upPath, 'utf8')}\n-- changed\n`
              );
              return confirmationToken(project, migration.id);
            },
          }
        ),
      'INVALID_HISTORY'
    );

    expect(await ledgerExists(project)).toBe(false);
    await project.pool.end();
  });

  test('should reject deferrable constraints that share the desired identity and columns', async () => {
    const project = await createProject();
    const baseline = await prepareBaseline(project);
    const migration = requiredMigration(baseline);
    await createExistingState(project, migration.upPath);
    await project.pool.query(`
      ALTER TABLE public.customer DROP CONSTRAINT customer_id_pkey;
      ALTER TABLE public.customer ADD CONSTRAINT customer_id_pkey
        PRIMARY KEY (id) DEFERRABLE INITIALLY IMMEDIATE;
    `);

    await expectRunnerError(
      () =>
        adoptBaseline({
          configPath: project.configPath,
          confirmation: confirmationToken(project, migration.id),
        }),
      'UNSUPPORTED'
    );

    expect(await ledgerExists(project)).toBe(false);
    await project.pool.end();
  });

  test('should reject index ordering that the desired model does not express', async () => {
    const project = await createProject();
    await configureSchema(
      project,
      customerSchema(`customer.index().indexName('customer_name_idx').column('name');`)
    );
    const baseline = await generateBaseline({
      name: 'initial',
      configPath: project.configPath,
      now: baselineInstant,
    });
    const migration = requiredMigration(baseline);
    await createExistingState(project, migration.upPath);
    await project.pool.query(`
      DROP INDEX public.customer_name_idx;
      CREATE INDEX customer_name_idx ON public.customer (name DESC);
    `);

    await expectRunnerError(
      () =>
        adoptBaseline({
          configPath: project.configPath,
          confirmation: confirmationToken(project, migration.id),
        }),
      'UNSUPPORTED'
    );

    expect(await ledgerExists(project)).toBe(false);
    await project.pool.end();
  });

  test('should adopt canonical serial, decimal, and identity state', async () => {
    const project = await createProject();
    await configureSchema(
      project,
      `
const schema = new DatabaseSchema('app');
const item = schema.table('item');
item.serial('id').primaryKey();
item.decimal('amount', 10, 2);
item.char('code');
item.timestamp('created_at', 6);
item.integer('sequence').identity('ALWAYS', {
  start: 1,
  increment: 1,
  minValue: 1,
  cache: 1,
  cycle: false,
});
item.index().indexName('item_amount_idx').column('amount');
export default schema;`
    );
    const baseline = await generateBaseline({
      name: 'initial',
      configPath: project.configPath,
      now: baselineInstant,
    });
    const migration = requiredMigration(baseline);
    await createExistingState(project, migration.upPath);

    const result = await adoptBaseline({
      configPath: project.configPath,
      confirmation: confirmationToken(project, migration.id),
    });

    expect(result.status).toBe('ADOPTED');
    expect(result.comparison.every(item => item.classification === 'MATCH')).toBe(true);
    await project.pool.end();
  });

  test('should reject row security that changes a modeled table', async () => {
    const project = await createProject();
    const baseline = await prepareBaseline(project);
    const migration = requiredMigration(baseline);
    await createExistingState(project, migration.upPath);
    await project.pool.query(`
      ALTER TABLE public.customer ENABLE ROW LEVEL SECURITY;
      CREATE POLICY customer_access ON public.customer USING (true);
    `);

    await expectRunnerError(
      () =>
        adoptBaseline({
          configPath: project.configPath,
          confirmation: confirmationToken(project, migration.id),
        }),
      'UNSUPPORTED'
    );

    expect(await ledgerExists(project)).toBe(false);
    await project.pool.end();
  });

  test('should reject drifted or redirected sequences behind serial shorthand', async () => {
    const project = await createProject();
    await configureSchema(
      project,
      `
const schema = new DatabaseSchema('app');
schema.table('item').serial('id').primaryKey();
export default schema;`
    );
    const baseline = await generateBaseline({
      name: 'initial',
      configPath: project.configPath,
      now: baselineInstant,
    });
    const migration = requiredMigration(baseline);
    await createExistingState(project, migration.upPath);
    await project.pool.query(`ALTER SEQUENCE public.item_id_seq INCREMENT BY 2`);

    await expectRunnerError(
      () =>
        adoptBaseline({
          configPath: project.configPath,
          confirmation: confirmationToken(project, migration.id),
        }),
      'UNSUPPORTED'
    );

    await project.pool.query(`
      ALTER SEQUENCE public.item_id_seq INCREMENT BY 1;
      CREATE SEQUENCE public.redirected_item_id_seq;
      ALTER TABLE public.item ALTER COLUMN id
        SET DEFAULT nextval('public.redirected_item_id_seq'::regclass);
    `);
    await expectRunnerError(
      () =>
        adoptBaseline({
          configPath: project.configPath,
          confirmation: confirmationToken(project, migration.id),
        }),
      'UNSUPPORTED'
    );

    expect(await ledgerExists(project)).toBe(false);
    await project.pool.end();
  });

  test('should honor required TLS and redact connection credentials on failure', async () => {
    const project = await createProject();
    const baseline = await prepareBaseline(project);
    const migration = requiredMigration(baseline);
    await createExistingState(project, migration.upPath);
    process.env[project.databaseUrlEnvironment] = project.databaseUrl
      .replace('postgres:postgres', 'postgres:adoption-secret')
      .concat('?sslmode=require');

    const error = await expectRunnerError(
      () =>
        adoptBaseline({
          configPath: project.configPath,
          confirmation: confirmationToken(project, migration.id),
        }),
      'DATABASE'
    );

    expect(formatMigrationError(error)).not.toContain('adoption-secret');
    expect(await ledgerExists(project)).toBe(false);
    await project.pool.end();
  });
});
