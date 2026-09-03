import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { loadMigrationConfig } from '../../src/migration/config.js';
import {
  discoverMigrations,
  parseMigrationFile,
  validateTransactionalSql,
} from '../../src/migration/migration-file.js';
import { publishArtifactPair } from '../../src/migration/artifact-writer.js';
import { formatMigrationError, MigrationError } from '../../src/migration/errors.js';

const temporaryDirectories: string[] = [];
const migrationId = '20260827120000_add-customer-status';
const previousHash = '1'.repeat(64);
const desiredHash = '2'.repeat(64);

/** Creates an isolated project directory that is removed after each test. */
async function createProject(): Promise<string> {
  const projectDirectory = await mkdtemp(join(tmpdir(), 'blendsdk-migrations-artifacts-'));
  temporaryDirectories.push(projectDirectory);
  return projectDirectory;
}

/** Builds exact migration bytes using the public version-one file contract. */
function migrationSql(
  id = migrationId,
  body = 'ALTER TABLE "customer" ADD COLUMN "status" text;\n',
  options: {
    readonly transaction?: boolean;
    readonly fromSnapshot?: string;
    readonly toSnapshot?: string;
  } = {}
): string {
  return [
    '-- blendsdk-migration: 1',
    `-- id: ${id}`,
    `-- transaction: ${options.transaction ?? true}`,
    `-- from-snapshot: ${options.fromSnapshot ?? previousHash}`,
    `-- to-snapshot: ${options.toSnapshot ?? desiredHash}`,
    body.trimEnd(),
    '',
  ].join('\n');
}

/** Writes a minimal TypeScript configuration without importing application schema code. */
async function writeConfig(projectDirectory: string, body = '{}'): Promise<string> {
  const configPath = join(projectDirectory, 'blendsdk.migrations.ts');
  await writeFile(configPath, `export default ${body};\n`, 'utf8');
  return configPath;
}

/** Captures one expected typed migration failure without depending on message prose. */
async function expectMigrationError(
  action: () => unknown | Promise<unknown>,
  expected: { readonly kind: string; readonly exitCode: 1 | 2 }
): Promise<MigrationError> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof MigrationError)) {
      throw error;
    }
    expect(error.kind).toBe(expected.kind);
    expect(error.exitCode).toBe(expected.exitCode);
    return error;
  }

  throw new Error('Expected a typed migration error.');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

describe('migration configuration contract', () => {
  test('should resolve conventional defaults from the configuration directory', async () => {
    // A minimal project gets stable paths, environment-key metadata, and bounded timeout defaults.
    const projectDirectory = await createProject();
    const configPath = await writeConfig(projectDirectory);

    const config = await loadMigrationConfig({ configPath, command: 'up' });

    expect(config).toEqual({
      configPath,
      configDirectory: projectDirectory,
      migrationsDir: join(projectDirectory, 'migrations'),
      snapshotFile: join(projectDirectory, 'migrations', 'schema.snapshot.json'),
      databaseUrlEnv: 'DATABASE_URL',
      lockTimeoutMs: 5_000,
      statementTimeoutMs: 900_000,
    });
    expect(JSON.stringify(config)).not.toContain('postgres://');
  });

  test.each([
    ['unknown key', '{ extra: true }'],
    ['zero lock timeout', '{ lockTimeoutMs: 0 }'],
    ['invalid environment name', "{ databaseUrlEnv: 'database-url' }"],
  ])('should reject %s as a configuration usage error', async (_label, configBody) => {
    // Invalid configuration is rejected locally and classified as exit code two.
    const projectDirectory = await createProject();
    const configPath = await writeConfig(projectDirectory, configBody);

    await expectMigrationError(() => loadMigrationConfig({ configPath, command: 'up' }), {
      kind: 'CONFIGURATION',
      exitCode: 2,
    });
  });

  test('should reject relative traversal, filesystem roots, and symlink artifact paths', async () => {
    // Artifact paths may not escape the config directory or redirect through a symlink.
    const projectDirectory = await createProject();
    const linkedDirectory = join(projectDirectory, 'linked-migrations');
    await symlink(tmpdir(), linkedDirectory, 'dir');

    for (const migrationsDir of ['../outside', '/', 'linked-migrations']) {
      const configPath = await writeConfig(
        projectDirectory,
        `{ migrationsDir: ${JSON.stringify(migrationsDir)} }`
      );
      await expectMigrationError(() => loadMigrationConfig({ configPath, command: 'up' }), {
        kind: 'CONFIGURATION',
        exitCode: 2,
      });
    }
  });

  test('should not execute the configured schema module for execution-only commands', async () => {
    // Production execution reads migration artifacts without importing application schema code.
    const projectDirectory = await createProject();
    const markerPath = join(projectDirectory, 'schema-imported');
    await writeFile(
      join(projectDirectory, 'schema.ts'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(markerPath)}, 'bad');\nexport default {};\n`,
      'utf8'
    );
    const configPath = await writeConfig(projectDirectory, "{ schema: './schema.ts' }");

    await loadMigrationConfig({ configPath, command: 'validate' });

    await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('version-one migration file contract', () => {
  test('should parse exact metadata and checksum the exact up-file bytes', async () => {
    // File identity, transaction mode, lineage, and checksum come from the immutable file bytes.
    const projectDirectory = await createProject();
    const path = join(projectDirectory, `${migrationId}.up.sql`);
    const sql = migrationSql();
    await writeFile(path, sql, 'utf8');

    const descriptor = await parseMigrationFile(path);

    expect(descriptor).toMatchObject({
      id: migrationId,
      upPath: path,
      transactional: true,
      fromSnapshot: previousHash,
      toSnapshot: desiredHash,
      checksum: createHash('sha256').update(Buffer.from(sql)).digest('hex'),
    });
  });

  test.each([
    ['UTF-8 BOM', `\uFEFF${migrationSql()}`],
    [
      'reordered header',
      migrationSql()
        .replace('-- id:', '-- transaction-old:')
        .replace('-- transaction: true', `-- id: ${migrationId}`)
        .replace('-- transaction-old:', '-- transaction:'),
    ],
    ['unknown header', migrationSql().replace('-- id:', '-- owner: blendsdk\n-- id:')],
    [
      'duplicate header',
      migrationSql().replace('-- transaction: true', '-- transaction: true\n-- transaction: true'),
    ],
    ['missing final LF', migrationSql().trimEnd()],
    ['comment-only body', migrationSql(migrationId, '-- nothing to execute\n')],
  ])('should reject %s before external access', async (_label, sql) => {
    // Headers and bodies use one strict byte-level form so malformed history cannot be ambiguous.
    const projectDirectory = await createProject();
    const path = join(projectDirectory, `${migrationId}.up.sql`);
    await writeFile(path, sql, 'utf8');

    await expectMigrationError(() => parseMigrationFile(path), {
      kind: 'INVALID_HISTORY',
      exitCode: 1,
    });
  });

  test('should reject filename identifiers that disagree with header identifiers', async () => {
    // The sortable filename and embedded identifier must describe the same migration.
    const projectDirectory = await createProject();
    const path = join(projectDirectory, '20260827120001_other.up.sql');
    await writeFile(path, migrationSql(), 'utf8');

    await expectMigrationError(() => parseMigrationFile(path), {
      kind: 'INVALID_HISTORY',
      exitCode: 1,
    });
  });

  test('should reject invalid UTF-8 bytes', async () => {
    // Migration files are exact UTF-8 artifacts; replacement decoding would conceal changed history.
    const projectDirectory = await createProject();
    const path = join(projectDirectory, `${migrationId}.up.sql`);
    const validPrefix = Buffer.from(migrationSql());
    await writeFile(
      path,
      Buffer.concat([validPrefix.subarray(0, -1), Buffer.from([0xc3, 0x28, 0x0a])])
    );

    await expectMigrationError(() => parseMigrationFile(path), {
      kind: 'INVALID_HISTORY',
      exitCode: 1,
    });
  });

  test('should discover ordered pairs and reject ambiguous directory contents', async () => {
    // Discovery sorts valid pairs but rejects duplicate identities, down-only files, and unknown SQL names.
    const projectDirectory = await createProject();
    const migrationsDir = join(projectDirectory, 'migrations');
    await mkdir(migrationsDir);
    const earlierId = '20260827115959_create-customer';
    await writeFile(join(migrationsDir, `${migrationId}.up.sql`), migrationSql(), 'utf8');
    await writeFile(
      join(migrationsDir, `${earlierId}.up.sql`),
      migrationSql(earlierId, 'CREATE TABLE "customer" ("id" bigint);\n', {
        fromSnapshot: 'none',
        toSnapshot: previousHash,
      }),
      'utf8'
    );
    await writeFile(
      join(migrationsDir, `${migrationId}.down.sql`),
      migrationSql(migrationId, 'ALTER TABLE "customer" DROP COLUMN "status";\n', {
        fromSnapshot: desiredHash,
        toSnapshot: previousHash,
      }),
      'utf8'
    );

    const migrations = await discoverMigrations({ migrationsDir });

    expect(migrations.map(({ id }) => id)).toEqual([earlierId, migrationId]);
    expect(migrations[1]?.downPath).toBe(join(migrationsDir, `${migrationId}.down.sql`));

    await writeFile(
      join(migrationsDir, `${migrationId.toUpperCase()}.up.sql`),
      migrationSql(migrationId.toUpperCase()),
      'utf8'
    );
    await expectMigrationError(() => discoverMigrations({ migrationsDir }), {
      kind: 'INVALID_HISTORY',
      exitCode: 1,
    });

    await rm(join(migrationsDir, `${migrationId.toUpperCase()}.up.sql`));
    await writeFile(
      join(migrationsDir, '20260827130000_down-only.down.sql'),
      migrationSql('20260827130000_down-only'),
      'utf8'
    );
    await expectMigrationError(() => discoverMigrations({ migrationsDir }), {
      kind: 'INVALID_HISTORY',
      exitCode: 1,
    });

    await rm(join(migrationsDir, '20260827130000_down-only.down.sql'));
    await writeFile(join(migrationsDir, 'notes.sql'), 'SELECT 1;\n', 'utf8');
    await expectMigrationError(() => discoverMigrations({ migrationsDir }), {
      kind: 'INVALID_HISTORY',
      exitCode: 1,
    });
  });

  test('should reject migration symlinks', async () => {
    // Migration discovery never follows a symbolic link to executable SQL.
    const projectDirectory = await createProject();
    const migrationsDir = join(projectDirectory, 'migrations');
    await mkdir(migrationsDir);
    const target = join(projectDirectory, 'outside.sql');
    await writeFile(target, migrationSql(), 'utf8');
    await symlink(target, join(migrationsDir, `${migrationId}.up.sql`), 'file');

    await expectMigrationError(() => discoverMigrations({ migrationsDir }), {
      kind: 'INVALID_HISTORY',
      exitCode: 1,
    });
  });
});

describe('transactional SQL lexical boundary', () => {
  test('should ignore transaction words inside PostgreSQL comments and quoted forms', () => {
    // The guard recognizes lexical boundaries without pretending to understand SQL semantics.
    const sql = [
      "SELECT 'COMMIT';",
      'SELECT "ROLLBACK" FROM "BEGIN";',
      'SELECT $$ START TRANSACTION; $$;',
      'SELECT $body$ SAVEPOINT hidden; $body$;',
      '-- ABORT;',
      '/* PREPARE TRANSACTION */ SELECT 1;',
    ].join('\n');

    expect(() => validateTransactionalSql(sql)).not.toThrow();
  });

  test.each([
    'BEGIN;',
    'START TRANSACTION;',
    'COMMIT;',
    'END;',
    'ROLLBACK;',
    'ABORT;',
    'SAVEPOINT before_change;',
    'RELEASE SAVEPOINT before_change;',
    "PREPARE TRANSACTION 'migration';",
    'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;',
  ])('should reject statement-leading transaction control in transactional SQL: %s', sql => {
    // Transaction ownership belongs to the runner, never to a transactional migration body.
    expect(() => validateTransactionalSql(`SELECT 1;\n${sql}\n`)).toThrow(MigrationError);
  });

  test.each([
    "SELECT 'unterminated;",
    'SELECT "unterminated;',
    'SELECT $body$unterminated;',
    '/* unterminated',
  ])('should fail closed for malformed quoted or commented SQL: %s', sql => {
    // Malformed lexical input is rejected instead of being passed to a database for interpretation.
    expect(() => validateTransactionalSql(sql)).toThrow(MigrationError);
  });
});

describe('failure-safe artifact publication', () => {
  test('should preserve prior public bytes when the second rename fails', async () => {
    // A caught publication failure cannot expose a new migration paired with an old snapshot.
    const projectDirectory = await createProject();
    const migrationPath = join(projectDirectory, `${migrationId}.up.sql`);
    const snapshotPath = join(projectDirectory, 'schema.snapshot.json');
    const priorSnapshot = '{"formatVersion":1}\n';
    await writeFile(snapshotPath, priorSnapshot, 'utf8');
    let renameCount = 0;

    await expectMigrationError(
      () =>
        publishArtifactPair(
          {
            migrationPath,
            migrationBytes: Buffer.from(migrationSql()),
            snapshotPath,
            snapshotBytes: Buffer.from('{"formatVersion":1,"tables":[]}\n'),
          },
          {
            rename: async (from, to) => {
              renameCount += 1;
              if (renameCount === 2) {
                throw new Error('simulated second rename failure');
              }
              await rename(from, to);
            },
          }
        ),
      { kind: 'FILESYSTEM', exitCode: 1 }
    );

    await expect(readFile(migrationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(snapshotPath, 'utf8')).resolves.toBe(priorSnapshot);
    expect((await readdir(projectDirectory)).sort()).toEqual(['schema.snapshot.json']);
  });

  test('should fail closed when migration lineage shows a process-crash-torn pair', async () => {
    // A migration whose target hash is not the current snapshot reports only manual, auditable recovery choices.
    const projectDirectory = await createProject();
    const migrationsDir = join(projectDirectory, 'migrations');
    const snapshotFile = join(migrationsDir, 'schema.snapshot.json');
    await mkdir(migrationsDir);
    await writeFile(join(migrationsDir, `${migrationId}.up.sql`), migrationSql(), 'utf8');
    await writeFile(snapshotFile, '{"old":true}\n', 'utf8');

    const error = await expectMigrationError(
      () => discoverMigrations({ migrationsDir, snapshotFile, validateLineage: true }),
      { kind: 'INVALID_HISTORY', exitCode: 1 }
    );
    const rendered = formatMigrationError(error);

    expect(rendered).toMatch(/remove.+orphan/i);
    expect(rendered).toMatch(/restore.+snapshot.+version control/i);
    expect(rendered).not.toMatch(/automatic|repair command|mark applied/i);
  });
});

describe('stable migration errors', () => {
  test('should redact credentials and SQL from rendered errors', () => {
    // Operational output exposes a stable classification without leaking connection credentials or SQL bodies.
    const error = new MigrationError({
      kind: 'CONFIGURATION',
      exitCode: 2,
      message: 'Cannot use postgres://admin:super-secret@db.example/app',
      sensitiveDetail: 'ALTER TABLE customer ADD COLUMN password text;',
    });

    const rendered = formatMigrationError(error);

    expect(rendered).toContain('CONFIGURATION');
    expect(rendered).not.toContain('admin');
    expect(rendered).not.toContain('super-secret');
    expect(rendered).not.toContain('ALTER TABLE');
    expect(rendered).not.toContain('password text');
  });
});
