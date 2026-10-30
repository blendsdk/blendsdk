import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { DatabaseSchema } from '../../src/database/schema/database-schema.js';
import { normalizeDatabaseSchema } from '../../src/migration/schema-normalizer.js';
import { generateMigration } from '../../src/migration/generate.js';
import {
  hashSnapshotBytes,
  parseSnapshotBytes,
  readSnapshot,
  serializeSnapshot,
} from '../../src/migration/snapshot.js';
import { validateSchemaSnapshot } from '../../src/migration/snapshot-types.js';

const temporaryDirectories: string[] = [];

/** Creates one isolated directory for filesystem validation. */
async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'blendsdk-snapshot-implementation-'));
  temporaryDirectories.push(path);
  return path;
}

/** Produces the smallest valid raw version-one snapshot. */
function emptySnapshot() {
  return {
    formatVersion: 1,
    defaultSchema: 'public',
    extensions: [],
    schemas: [{ name: 'public' }],
    tables: [],
    views: [],
  } as const;
}

/** Writes one real config and schema module for generation-history guards. */
async function writeGenerationProject(directory: string, extraColumn = false): Promise<string> {
  const databaseSchemaUrl = pathToFileURL(
    join(process.cwd(), 'src/database/schema/database-schema.ts')
  ).href;
  await mkdir(join(directory, 'migrations'));
  await writeFile(
    join(directory, 'schema.ts'),
    `import { DatabaseSchema } from ${JSON.stringify(databaseSchemaUrl)};
const schema = new DatabaseSchema('ignored');
const table = schema.table('item');
table.bigint('id').primaryKey();
${extraColumn ? "table.text('label').nullable();" : ''}
export default schema;
`
  );
  const configPath = join(directory, 'blendsdk.migrations.ts');
  await writeFile(configPath, "export default { schema: './schema.ts' };\n");
  return configPath;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))
  );
});

describe('snapshot DTO validation', () => {
  test('rejects unknown keys, duplicate identities, and missing relationships', () => {
    expect(() => validateSchemaSnapshot({ ...emptySnapshot(), extra: true })).toThrow();
    expect(() =>
      validateSchemaSnapshot({
        ...emptySnapshot(),
        schemas: [{ name: 'public' }, { name: 'public' }],
      })
    ).toThrow();
    expect(() =>
      validateSchemaSnapshot({
        ...emptySnapshot(),
        tables: [
          {
            schema: 'missing',
            name: 'item',
            columns: [],
            uniqueConstraints: [],
            checkConstraints: [],
            foreignKeys: [],
            indexes: [],
          },
        ],
      })
    ).toThrow();
  });

  test('enforces PostgreSQL identity and local-column boundaries', () => {
    expect(() =>
      validateSchemaSnapshot({ ...emptySnapshot(), defaultSchema: 'missing' })
    ).toThrow();
    expect(() =>
      validateSchemaSnapshot({
        ...emptySnapshot(),
        schemas: [{ name: 'bad.schema' }],
        defaultSchema: 'bad.schema',
      })
    ).toThrow();
    expect(() =>
      validateSchemaSnapshot({
        ...emptySnapshot(),
        schemas: [{ name: 'x'.repeat(64) }],
        defaultSchema: 'x'.repeat(64),
      })
    ).toThrow();
    expect(() =>
      validateSchemaSnapshot({
        ...emptySnapshot(),
        tables: [
          {
            schema: 'public',
            name: 'item',
            columns: [
              {
                name: 'id',
                type: 'bigint',
                nullable: false,
                identityOptions: { start: 1 },
              },
            ],
            uniqueConstraints: [],
            checkConstraints: [],
            foreignKeys: [],
            indexes: [],
          },
        ],
      })
    ).toThrow();
  });

  test('rejects foreign keys whose target column is absent', () => {
    expect(() =>
      validateSchemaSnapshot({
        ...emptySnapshot(),
        tables: [
          {
            schema: 'public',
            name: 'child',
            columns: [{ name: 'parent_id', type: 'bigint', nullable: false }],
            uniqueConstraints: [],
            checkConstraints: [],
            indexes: [],
            foreignKeys: [
              {
                kind: 'foreignKey',
                name: 'child_parent_id_fkey',
                columns: ['parent_id'],
                referencedSchema: 'public',
                referencedTable: 'parent',
                referencedColumns: ['missing'],
                onUpdate: 'CASCADE',
                onDelete: 'RESTRICT',
              },
            ],
          },
        ],
      })
    ).toThrow();
  });

  test('rejects foreign keys whose target columns are not a candidate key', () => {
    expect(() =>
      validateSchemaSnapshot({
        ...emptySnapshot(),
        tables: [
          {
            schema: 'public',
            name: 'parent',
            columns: [{ name: 'label', type: 'text', nullable: false }],
            uniqueConstraints: [],
            checkConstraints: [],
            foreignKeys: [],
            indexes: [],
          },
          {
            schema: 'public',
            name: 'child',
            columns: [{ name: 'parent_label', type: 'text', nullable: false }],
            uniqueConstraints: [],
            checkConstraints: [],
            indexes: [],
            foreignKeys: [
              {
                kind: 'foreignKey',
                name: 'child_parent_label_fkey',
                columns: ['parent_label'],
                referencedSchema: 'public',
                referencedTable: 'parent',
                referencedColumns: ['label'],
                onUpdate: 'CASCADE',
                onDelete: 'RESTRICT',
              },
            ],
          },
        ],
      })
    ).toThrow();
  });

  test('rejects foreign keys whose local and referenced types differ', () => {
    const schema = new DatabaseSchema('ignored');
    const parent = schema.table('parent');
    parent.bigint('id').primaryKey();
    schema.table('child').text('parent_id').references(parent, 'id');

    expect(() => normalizeDatabaseSchema(schema)).toThrow();
  });
});

describe('schema normalization internals', () => {
  test('projects stable constraint/index names and copies nested options', () => {
    const schema = new DatabaseSchema('ignored');
    const parent = schema.table('parent');
    parent.bigint('id').primaryKey();
    const child = schema.table('child');
    child.bigint('id').identity('BY DEFAULT', { start: 0, increment: 1, cycle: false });
    child.bigint('parent_id').references(parent, 'id');
    child.text('code').unique().check('length(code) > 0');
    child.index().column('code').with({ fillfactor: 80, deduplicate_items: 'on' });

    const snapshot = normalizeDatabaseSchema(schema);
    const table = snapshot.tables.find(item => item.name === 'child');

    expect(table?.foreignKeys[0]?.name).toBe('child_parent_id_fkey');
    expect(table?.uniqueConstraints[0]?.name).toBe('child_code_key');
    expect(table?.checkConstraints[0]?.name).toMatch(/^child_[a-f0-9]{10}_check$/u);
    expect(table?.indexes[0]?.storageParams).toEqual({ deduplicate_items: 'on', fillfactor: 80 });
    expect(table?.columns.find(column => column.name === 'id')?.identityOptions).toEqual({
      start: 0,
      increment: 1,
      cycle: false,
    });
  });
});

describe('exact snapshot bytes', () => {
  test('rejects BOM, CRLF, missing LF, and noncanonical JSON', () => {
    const canonical = Buffer.from(serializeSnapshot(validateSchemaSnapshot(emptySnapshot())));
    expect(() =>
      parseSnapshotBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical]))
    ).toThrow();
    expect(() =>
      parseSnapshotBytes(Buffer.from(canonical.toString().replaceAll('\n', '\r\n')))
    ).toThrow();
    expect(() => parseSnapshotBytes(canonical.subarray(0, -1))).toThrow();
    expect(() => parseSnapshotBytes(Buffer.from(JSON.stringify(emptySnapshot()) + '\n'))).toThrow();
  });

  test('reads only regular files and hashes the original bytes', async () => {
    const directory = await temporaryDirectory();
    const snapshotPath = join(directory, 'schema.snapshot.json');
    const linkPath = join(directory, 'linked.json');
    const bytes = serializeSnapshot(validateSchemaSnapshot(emptySnapshot()));
    await writeFile(snapshotPath, bytes);
    await symlink(snapshotPath, linkPath);

    const result = await readSnapshot(snapshotPath);

    expect(hashSnapshotBytes(result.bytes)).toBe(hashSnapshotBytes(bytes));
    await expect(readSnapshot(linkPath)).rejects.toMatchObject({ kind: 'INVALID_HISTORY' });
  });
});

describe('generation history guards', () => {
  test('rejects existing migration history when its canonical snapshot is missing', async () => {
    const directory = await temporaryDirectory();
    const configPath = await writeGenerationProject(directory);
    const id = '20260828000000_existing';
    await writeFile(
      join(directory, 'migrations', `${id}.up.sql`),
      [
        '-- blendsdk-migration: 1',
        `-- id: ${id}`,
        '-- transaction: true',
        '-- from-snapshot: none',
        `-- to-snapshot: ${'1'.repeat(64)}`,
        'SELECT 1;',
        '',
      ].join('\n')
    );

    await expect(generateMigration({ name: 'next', configPath })).rejects.toMatchObject({
      kind: 'INVALID_HISTORY',
    });
    expect(await readdir(join(directory, 'migrations'))).toEqual([`${id}.up.sql`]);
  });
});
