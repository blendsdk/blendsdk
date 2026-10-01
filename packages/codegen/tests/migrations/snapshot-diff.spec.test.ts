import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { DatabaseSchema } from '../../src/database/schema/database-schema.js';
import { MigrationError } from '../../src/migration/errors.js';
import { generateMigration } from '../../src/migration/generate.js';
import { createManualMigration } from '../../src/migration/migration-file.js';
import { renderMigrationSql } from '../../src/migration/migration-sql.js';
import { normalizeDatabaseSchema } from '../../src/migration/schema-normalizer.js';
import { diffSnapshots } from '../../src/migration/schema-diff.js';
import type { RenameHint } from '../../src/migration/schema-diff.js';
import {
  hashSnapshotBytes,
  parseSnapshotBytes,
  serializeSnapshot,
} from '../../src/migration/snapshot.js';

const temporaryDirectories: string[] = [];
const invalidRenameHintCases: readonly [string, readonly RenameHint[]][] = [
  [
    'duplicate source',
    [
      { kind: 'table', from: 'public.customer', to: 'public.account' },
      { kind: 'table', from: 'public.customer', to: 'public.member' },
    ],
  ],
  [
    'many-to-one',
    [
      { kind: 'table', from: 'public.customer', to: 'public.account' },
      { kind: 'table', from: 'public.member', to: 'public.account' },
    ],
  ],
  [
    'cycle',
    [
      { kind: 'table', from: 'public.customer', to: 'public.account' },
      { kind: 'table', from: 'public.account', to: 'public.customer' },
    ],
  ],
  ['cross-kind target', [{ kind: 'table', from: 'public.customer', to: 'public.customer.email' }]],
];

/** Creates an isolated project directory that is removed after each test. */
async function createProject(): Promise<string> {
  const projectDirectory = await mkdtemp(join(tmpdir(), 'blendsdk-migrations-snapshot-'));
  temporaryDirectories.push(projectDirectory);
  return projectDirectory;
}

/** Creates the smallest supported schema with one stable table identity. */
function customerSchema(
  options: {
    readonly tableName?: string;
    readonly columnName?: string;
    readonly nullableExtra?: boolean;
    readonly requiredExtra?: boolean;
  } = {}
): DatabaseSchema {
  const schema = new DatabaseSchema('app');
  const table = schema.table(options.tableName ?? 'customer');
  table.bigint('id').primaryKey();
  table.varchar(options.columnName ?? 'email', 255).nullable();
  if (options.nullableExtra) table.text('nickname').nullable();
  if (options.requiredExtra) table.text('status');
  return schema;
}

/** Normalizes a schema for concise semantic-diff fixtures. */
function snapshot(schema: DatabaseSchema) {
  return normalizeDatabaseSchema(schema);
}

/** Captures one typed operational failure without coupling tests to prose. */
async function expectMigrationFailure(action: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof MigrationError)) throw error;
    expect(error.exitCode).toBe(1);
    return;
  }
  throw new Error('Expected migration generation to fail.');
}

/** Writes a real configuration and schema module for generation-service tests. */
async function writeProjectSchema(projectDirectory: string, schemaBody: string): Promise<string> {
  const databaseSchemaUrl = pathToFileURL(
    join(process.cwd(), 'src/database/schema/database-schema.ts')
  ).href;
  await mkdir(join(projectDirectory, 'migrations'));
  await writeFile(
    join(projectDirectory, 'schema.ts'),
    `import { DatabaseSchema } from ${JSON.stringify(databaseSchemaUrl)};\n${schemaBody}\n`,
    'utf8'
  );
  const configPath = join(projectDirectory, 'blendsdk.migrations.ts');
  await writeFile(configPath, `export default { schema: './schema.ts' };\n`, 'utf8');
  return configPath;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

describe('canonical version-one snapshots', () => {
  test('should produce identical exact bytes and hashes for twenty declaration orders', () => {
    // Unordered modeled collections use semantic identity, never authoring insertion order.
    const outputs = Array.from({ length: 20 }, (_, index) => {
      const schema = new DatabaseSchema('app');
      const names = index % 2 === 0 ? ['zebra', 'account'] : ['account', 'zebra'];
      const extensions = index % 3 === 0 ? ['uuid-ossp', 'pgcrypto'] : ['pgcrypto', 'uuid-ossp'];
      schema.extension(...extensions);
      for (const name of names) schema.table(name).bigint('id').primaryKey();
      const bytes = serializeSnapshot(normalizeDatabaseSchema(schema));
      return { text: Buffer.from(bytes).toString('utf8'), hash: hashSnapshotBytes(bytes) };
    });

    expect(new Set(outputs.map(output => output.text))).toHaveLength(1);
    expect(new Set(outputs.map(output => output.hash))).toHaveLength(1);
  });

  test('should serialize strict data-only version-one JSON and hash its exact bytes', () => {
    const bytes = serializeSnapshot(snapshot(customerSchema()));
    const text = Buffer.from(bytes).toString('utf8');
    const parsed = parseSnapshotBytes(bytes);

    expect(parsed.formatVersion).toBe(1);
    expect(text).toMatch(/^\{\n  "formatVersion": 1,/u);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toContain('\r');
    expect(text).not.toMatch(/timestamp|createdAt|\/tmp\/|DATABASE_URL|postgres(?:ql)?:\/\//iu);
    expect(hashSnapshotBytes(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(hashSnapshotBytes(bytes)).toMatch(/^[a-f0-9]{64}$/u);
  });

  test('should reject an unknown format version without changing its source bytes', () => {
    const original = Buffer.from('{\n  "formatVersion": 2\n}\n');
    const before = Buffer.from(original);

    expect(() => parseSnapshotBytes(original)).toThrow(/upgrade|version/iu);
    expect(original.equals(before)).toBe(true);
  });

  test('should preserve falsy defaults and exact mixed-case or reserved identities', () => {
    const schema = new DatabaseSchema('app', 'Order');
    const table = schema.table('Select');
    table.integer('Zero').default(0);
    table.boolean('False').default(false);
    table.text('Empty').default('', true);

    const normalized = snapshot(schema);
    const columns = normalized.tables[0]?.columns;

    expect(normalized.tables[0]).toMatchObject({ schema: 'Order', name: 'Select' });
    expect(columns?.map(column => [column.name, column.default])).toEqual([
      ['Empty', "''"],
      ['False', false],
      ['Zero', 0],
    ]);
  });

  test('should not mutate schema arrays or objects while normalizing', () => {
    const schema = new DatabaseSchema('app');
    const second = schema.table('second');
    second.text('zeta').nullable();
    second.text('alpha').nullable();
    const first = schema.table('first');
    first.bigint('id');
    const tableOrder = schema.getTables().slice();
    const columnOrder = second.getColumns().slice();

    normalizeDatabaseSchema(schema);

    expect(schema.getTables()).toEqual(tableOrder);
    expect(second.getColumns()).toEqual(columnOrder);
    expect(schema.getTables()[0]).toBe(second);
    expect(second.getColumns()[0]?.getName()).toBe('zeta');
  });
});

describe('semantic change classification and rename decisions', () => {
  test('should classify and render one nullable column addition as targeted safe SQL', () => {
    const previous = snapshot(customerSchema());
    const desired = snapshot(customerSchema({ nullableExtra: true }));
    const diff = diffSnapshots(previous, desired);
    const sql = renderMigrationSql(diff.changes);

    expect(diff.changes).toEqual([expect.objectContaining({ kind: 'column.add', safety: 'safe' })]);
    expect(sql).toBe('ALTER TABLE "public"."customer" ADD COLUMN "nickname" text;\n');
  });

  test('should block apparent renames until supplied one-to-one hints are valid', () => {
    const previous = snapshot(customerSchema());
    const renamedTable = snapshot(customerSchema({ tableName: 'account' }));
    const unhinted = diffSnapshots(previous, renamedTable);

    expect(unhinted.changes).toEqual([
      expect.objectContaining({ kind: 'table.rename', safety: 'ambiguous' }),
    ]);
    expect(() => renderMigrationSql(unhinted.changes)).toThrow();

    const hinted = diffSnapshots(previous, renamedTable, [
      { kind: 'table', from: 'public.customer', to: 'public.account' },
    ]);
    const sql = renderMigrationSql(hinted.changes);
    expect(sql).toContain('ALTER TABLE "public"."customer" RENAME TO "account";');
    expect(sql).not.toMatch(/DROP TABLE|CREATE TABLE/iu);

    const renamedColumn = snapshot(customerSchema({ columnName: 'email_address' }));
    const columnDiff = diffSnapshots(previous, renamedColumn, [
      {
        kind: 'column',
        from: 'public.customer.email',
        to: 'public.customer.email_address',
      },
    ]);
    expect(renderMigrationSql(columnDiff.changes)).toContain(
      'ALTER TABLE "public"."customer" RENAME COLUMN "email" TO "email_address";'
    );
  });

  test.each(invalidRenameHintCases)('should reject %s rename hints', (_label, hints) => {
    const previous = snapshot(customerSchema());
    const desired = snapshot(customerSchema({ tableName: 'account' }));

    expect(() => diffSnapshots(previous, desired, hints)).toThrow();
  });

  test('should require explicit destructive approval for targeted removals', () => {
    const previous = snapshot(customerSchema({ nullableExtra: true }));
    const desired = snapshot(customerSchema());
    const diff = diffSnapshots(previous, desired);

    expect(diff.changes).toEqual([
      expect.objectContaining({ kind: 'column.drop', safety: 'destructive' }),
    ]);
    expect(() => renderMigrationSql(diff.changes)).toThrow();

    const sql = renderMigrationSql(diff.changes, { allowDestructive: true });
    expect(sql).toMatch(/destructive/iu);
    expect(sql).toContain('ALTER TABLE "public"."customer" DROP COLUMN "nickname";');
    expect(sql).not.toMatch(/CASCADE|DROP TABLE/iu);
  });

  test('should block a required column add and unsupported transition with manual guidance', () => {
    const previous = snapshot(customerSchema());
    const required = diffSnapshots(previous, snapshot(customerSchema({ requiredExtra: true })));
    expect(required.changes).toEqual([
      expect.objectContaining({ kind: 'column.add', safety: 'caution' }),
    ]);
    expect(() => renderMigrationSql(required.changes)).toThrow(/manual|population|staged/iu);

    const changedTypeSchema = customerSchema();
    changedTypeSchema.getTables()[0]?.findColumn('email')?.type('integer');
    const unsupported = diffSnapshots(previous, snapshot(changedTypeSchema));
    expect(unsupported.changes).toEqual([
      expect.objectContaining({ kind: 'column.type', safety: 'unsupported' }),
    ]);
    expect(() => renderMigrationSql(unsupported.changes)).toThrow(/manual|using|unsupported/iu);
  });
});

describe('deterministic PostgreSQL migration rendering', () => {
  test('should order supported additions by dependency and quote every identity', () => {
    const previous = snapshot(new DatabaseSchema('app'));
    const desiredSchema = new DatabaseSchema('app');
    desiredSchema.extension('pgcrypto');
    const table = desiredSchema.table('Order').scope('Sales');
    table.bigint('Id').primaryKey();
    table.text('Note').nullable().comment('customer note');
    table.uniqueConstraint().column('Note');
    table.index().indexName('Order Note idx').column('Note');
    desiredSchema.view('Current Order').scope('Sales').as('SELECT "Id" FROM "Sales"."Order"');

    const sql = renderMigrationSql(diffSnapshots(previous, snapshot(desiredSchema)).changes);

    expect(sql.indexOf('CREATE EXTENSION')).toBeLessThan(sql.indexOf('CREATE SCHEMA'));
    expect(sql.indexOf('CREATE SCHEMA')).toBeLessThan(sql.indexOf('CREATE TABLE'));
    expect(sql.indexOf('CREATE TABLE')).toBeLessThan(sql.indexOf('ADD CONSTRAINT'));
    expect(sql.indexOf('ADD CONSTRAINT')).toBeLessThan(sql.indexOf('CREATE INDEX'));
    expect(sql.indexOf('CREATE INDEX')).toBeLessThan(sql.indexOf('COMMENT ON'));
    expect(sql.indexOf('COMMENT ON')).toBeLessThan(sql.indexOf('CREATE VIEW'));
    expect(sql).toContain('"Sales"."Order"');
    expect(sql).toContain('"Order Note idx"');
    expect(sql).not.toMatch(/CASCADE|DROP TABLE IF EXISTS|DROP SCHEMA IF EXISTS/iu);
    expect(sql.endsWith('\n')).toBe(true);
    expect(renderMigrationSql(diffSnapshots(previous, snapshot(desiredSchema)).changes)).toBe(sql);
  });
});

describe('offline generation and manual coexistence', () => {
  test('should report UP_TO_DATE and leave existing artifacts byte-identical', async () => {
    const projectDirectory = await createProject();
    const configPath = await writeProjectSchema(
      projectDirectory,
      `const schema = new DatabaseSchema('app');\nschema.table('customer').bigint('id');\nexport default schema;`
    );
    const expectedSchema = new DatabaseSchema('app');
    expectedSchema.table('customer').bigint('id');
    const expected = serializeSnapshot(snapshot(expectedSchema));
    const snapshotPath = join(projectDirectory, 'migrations/schema.snapshot.json');
    await writeFile(snapshotPath, expected);
    const before = await readdir(join(projectDirectory, 'migrations'));

    const result = await generateMigration({ name: 'nothing', configPath });

    expect(result.status).toBe('UP_TO_DATE');
    expect(await readFile(snapshotPath)).toEqual(Buffer.from(expected));
    expect(await readdir(join(projectDirectory, 'migrations'))).toEqual(before);
  });

  test('should publish one generated migration and replacement snapshot with exact lineage', async () => {
    const projectDirectory = await createProject();
    const configPath = await writeProjectSchema(
      projectDirectory,
      `const schema = new DatabaseSchema('app');\nconst table = schema.table('customer');\ntable.bigint('id').primaryKey();\ntable.varchar('email', 255).nullable();\ntable.text('nickname').nullable();\nexport default schema;`
    );
    const previousBytes = serializeSnapshot(snapshot(customerSchema()));
    const snapshotPath = join(projectDirectory, 'migrations/schema.snapshot.json');
    await writeFile(snapshotPath, previousBytes);

    const result = await generateMigration({ name: 'add-nickname', configPath });
    const migrationFiles = (await readdir(join(projectDirectory, 'migrations'))).filter(file =>
      file.endsWith('.up.sql')
    );
    const sql = await readFile(
      join(projectDirectory, 'migrations', migrationFiles[0] ?? ''),
      'utf8'
    );
    const desiredBytes = await readFile(snapshotPath);

    expect(result.status).toBe('GENERATED');
    expect(migrationFiles).toHaveLength(1);
    expect(sql).toContain(`-- from-snapshot: ${hashSnapshotBytes(previousBytes)}`);
    expect(sql).toContain(`-- to-snapshot: ${hashSnapshotBytes(desiredBytes)}`);
    expect(sql).toContain('ALTER TABLE "public"."customer" ADD COLUMN "nickname" text;');
  });

  test('should write nothing when generation is blocked', async () => {
    const projectDirectory = await createProject();
    const configPath = await writeProjectSchema(
      projectDirectory,
      `const schema = new DatabaseSchema('app');\nconst table = schema.table('customer');\ntable.bigint('id').primaryKey();\ntable.varchar('email', 255).nullable();\ntable.text('status');\nexport default schema;`
    );
    const snapshotPath = join(projectDirectory, 'migrations/schema.snapshot.json');
    const previousBytes = serializeSnapshot(snapshot(customerSchema()));
    await writeFile(snapshotPath, previousBytes);

    await expectMigrationFailure(() => generateMigration({ name: 'required-status', configPath }));

    expect(await readFile(snapshotPath)).toEqual(Buffer.from(previousBytes));
    expect(await readdir(join(projectDirectory, 'migrations'))).toEqual(['schema.snapshot.json']);
  });

  test('should keep manual migration lineage null and diff later modeled changes from the snapshot', async () => {
    const projectDirectory = await createProject();
    const migrationsDir = join(projectDirectory, 'migrations');
    await mkdir(migrationsDir);
    const snapshotPath = join(migrationsDir, 'schema.snapshot.json');
    const previousBytes = serializeSnapshot(snapshot(customerSchema()));
    await writeFile(snapshotPath, previousBytes);

    const manual = await createManualMigration({
      migrationsDir,
      name: 'data-backfill',
      now: new Date('2026-08-27T12:00:00Z'),
    });
    expect(manual.fromSnapshot).toBeUndefined();
    expect(manual.toSnapshot).toBeUndefined();
    expect(await readFile(snapshotPath)).toEqual(Buffer.from(previousBytes));

    const desired = snapshot(customerSchema({ nullableExtra: true }));
    const sql = renderMigrationSql(
      diffSnapshots(parseSnapshotBytes(previousBytes), desired).changes
    );
    expect(sql).toBe('ALTER TABLE "public"."customer" ADD COLUMN "nickname" text;\n');
  });
});
