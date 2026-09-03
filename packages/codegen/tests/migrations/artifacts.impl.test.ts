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
import { publishArtifactPair } from '../../src/migration/artifact-writer.js';
import type { ArtifactWriterDependencies } from '../../src/migration/artifact-writer.js';
import { loadMigrationConfig } from '../../src/migration/config.js';
import { MigrationError } from '../../src/migration/errors.js';
import {
  createManualMigration,
  discoverMigrations,
  parseMigrationFile,
  validateTransactionalSql,
} from '../../src/migration/migration-file.js';

const temporaryDirectories: string[] = [];

/** Creates one isolated directory and registers deterministic cleanup. */
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'blendsdk-migrations-implementation-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** Builds a strict migration file for focused implementation cases. */
function migrationSql(id: string, body = 'SELECT 1;\n'): string {
  return [
    '-- blendsdk-migration: 1',
    `-- id: ${id}`,
    '-- transaction: true',
    '-- from-snapshot: none',
    '-- to-snapshot: none',
    body.trimEnd(),
    '',
  ].join('\n');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))
  );
});

describe('migration configuration implementation', () => {
  test('discovers the nearest conventional configuration while searching upward', async () => {
    const root = await temporaryDirectory();
    const nested = join(root, 'packages', 'service');
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, 'blendsdk.migrations.ts'), 'export default {};\n');

    const config = await loadMigrationConfig({ command: 'status', startDirectory: nested });

    expect(config.configDirectory).toBe(root);
  });

  test('rejects a non-object default export', async () => {
    const root = await temporaryDirectory();
    const configPath = join(root, 'blendsdk.migrations.ts');
    await writeFile(configPath, "export default 'invalid';\n");

    await expect(loadMigrationConfig({ command: 'status', configPath })).rejects.toMatchObject({
      kind: 'CONFIGURATION',
      exitCode: 2,
    });
  });
});

describe('migration file implementation', () => {
  test('creates parseable exclusive manual up/down templates', async () => {
    const root = await temporaryDirectory();
    const options = {
      migrationsDir: root,
      name: 'add-widget',
      withDown: true,
      now: new Date('2026-08-28T01:02:03Z'),
    } as const;

    const descriptor = await createManualMigration(options);
    const parsed = await parseMigrationFile(descriptor.upPath);

    expect(parsed.id).toBe('20260828010203_add-widget');
    expect(await readFile(descriptor.upPath, 'utf8')).toContain('SELECT 1;');
    await expect(createManualMigration(options)).rejects.toBeInstanceOf(MigrationError);
  });

  test('ignores owned dot-temporary files but rejects a SQL directory', async () => {
    const root = await temporaryDirectory();
    const id = '20260828010203_add-widget';
    await writeFile(join(root, `${id}.up.sql`), migrationSql(id));
    await writeFile(join(root, `.${id}.up.sql.private.tmp`), 'partial');

    await expect(discoverMigrations({ migrationsDir: root })).resolves.toHaveLength(1);

    await mkdir(join(root, 'unexpected.up.sql'));
    await expect(discoverMigrations({ migrationsDir: root })).rejects.toMatchObject({
      kind: 'INVALID_HISTORY',
    });
  });

  test('handles PostgreSQL prefixed strings without hiding transaction statements', () => {
    expect(() =>
      validateTransactionalSql("SELECT E'COMMIT\\n', B'0101', X'CAFE', U&'BEGIN';")
    ).not.toThrow();
    expect(() => validateTransactionalSql('SELECT 1; COMMIT;')).toThrow(MigrationError);
  });
});

describe('artifact writer implementation', () => {
  test('publishes artifacts in separate configured directories and replaces the prior snapshot', async () => {
    const root = await temporaryDirectory();
    const migrationsDir = join(root, 'migrations');
    const snapshotsDir = join(root, 'state');
    await mkdir(migrationsDir);
    await mkdir(snapshotsDir);
    const migrationPath = join(migrationsDir, '20260828010203_add-widget.up.sql');
    const snapshotPath = join(snapshotsDir, 'schema.snapshot.json');
    await writeFile(snapshotPath, 'old\n');

    await publishArtifactPair({
      migrationPath,
      migrationBytes: Buffer.from('migration\n'),
      snapshotPath,
      snapshotBytes: Buffer.from('new\n'),
    });

    await expect(readFile(migrationPath, 'utf8')).resolves.toBe('migration\n');
    await expect(readFile(snapshotPath, 'utf8')).resolves.toBe('new\n');
  });

  test('cleans private files when the first rename fails', async () => {
    const root = await temporaryDirectory();
    const migrationPath = join(root, '20260828010203_add-widget.up.sql');
    const snapshotPath = join(root, 'schema.snapshot.json');
    await writeFile(snapshotPath, 'old\n');

    await expect(
      publishArtifactPair(
        {
          migrationPath,
          migrationBytes: Buffer.from('migration\n'),
          snapshotPath,
          snapshotBytes: Buffer.from('new\n'),
        },
        { rename: async () => Promise.reject(new Error('injected rename failure')) }
      )
    ).rejects.toMatchObject({ kind: 'FILESYSTEM' });

    expect(await readdir(root)).toEqual(['schema.snapshot.json']);
  });

  test('rolls back a production hard-link claim when snapshot publication fails', async () => {
    const root = await temporaryDirectory();
    const migrationPath = join(root, '20260828010203_add-widget.up.sql');
    const snapshotPath = join(root, 'schema.snapshot.json');
    await writeFile(snapshotPath, 'old\n');

    await expect(
      publishArtifactPair(
        {
          migrationPath,
          migrationBytes: Buffer.from('migration\n'),
          snapshotPath,
          snapshotBytes: Buffer.from('new\n'),
        },
        { snapshotRename: async () => Promise.reject(new Error('injected snapshot failure')) }
      )
    ).rejects.toMatchObject({ kind: 'FILESYSTEM' });

    await expect(readFile(migrationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(snapshotPath, 'utf8')).resolves.toBe('old\n');
    expect(await readdir(root)).toEqual(['schema.snapshot.json']);
  });

  test.each(['write', 'sync'] as const)(
    'preserves prior public bytes when an injected %s fails',
    async failure => {
      const root = await temporaryDirectory();
      const migrationPath = join(root, '20260828010203_add-widget.up.sql');
      const snapshotPath = join(root, 'schema.snapshot.json');
      await writeFile(snapshotPath, 'old\n');
      const dependencies: ArtifactWriterDependencies = {
        ...(failure === 'write'
          ? { write: async () => Promise.reject(new Error('injected write failure')) }
          : { sync: async () => Promise.reject(new Error('injected sync failure')) }),
      };

      await expect(
        publishArtifactPair(
          {
            migrationPath,
            migrationBytes: Buffer.from('migration\n'),
            snapshotPath,
            snapshotBytes: Buffer.from('new\n'),
          },
          dependencies
        )
      ).rejects.toMatchObject({ kind: 'FILESYSTEM' });

      await expect(readFile(snapshotPath, 'utf8')).resolves.toBe('old\n');
      expect(await readdir(root)).toEqual(['schema.snapshot.json']);
    }
  );

  test('allows exactly one concurrent publisher to claim an immutable migration name', async () => {
    const root = await temporaryDirectory();
    const migrationPath = join(root, '20260828010203_add-widget.up.sql');
    const snapshotPath = join(root, 'schema.snapshot.json');
    const publish = (marker: string) =>
      publishArtifactPair({
        migrationPath,
        migrationBytes: Buffer.from(`${marker}-migration\n`),
        snapshotPath,
        snapshotBytes: Buffer.from(`${marker}-snapshot\n`),
      });

    const results = await Promise.allSettled([publish('first'), publish('second')]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const migration = await readFile(migrationPath, 'utf8');
    const snapshot = await readFile(snapshotPath, 'utf8');
    expect(snapshot).toBe(migration.replace('migration', 'snapshot'));
  });

  test('never overwrites an existing migration or follows a snapshot symlink', async () => {
    const root = await temporaryDirectory();
    const migrationPath = join(root, '20260828010203_add-widget.up.sql');
    const snapshotPath = join(root, 'schema.snapshot.json');
    await writeFile(migrationPath, 'existing\n');

    await expect(
      publishArtifactPair({
        migrationPath,
        migrationBytes: Buffer.from('replacement\n'),
        snapshotPath,
        snapshotBytes: Buffer.from('snapshot\n'),
      })
    ).rejects.toMatchObject({ kind: 'FILESYSTEM' });
    await expect(readFile(migrationPath, 'utf8')).resolves.toBe('existing\n');

    await rm(migrationPath);
    const target = join(root, 'outside.json');
    await writeFile(target, 'outside\n');
    await symlink(target, snapshotPath);
    await expect(
      publishArtifactPair({
        migrationPath,
        migrationBytes: Buffer.from('migration\n'),
        snapshotPath,
        snapshotBytes: Buffer.from('snapshot\n'),
      })
    ).rejects.toMatchObject({ kind: 'FILESYSTEM' });
    await expect(readFile(target, 'utf8')).resolves.toBe('outside\n');
  });

  test('uses the narrow rename seam without changing normal rename semantics', async () => {
    const root = await temporaryDirectory();
    const migrationPath = join(root, '20260828010203_add-widget.up.sql');
    const snapshotPath = join(root, 'schema.snapshot.json');
    const renamedTargets: string[] = [];

    await publishArtifactPair(
      {
        migrationPath,
        migrationBytes: Buffer.from('migration\n'),
        snapshotPath,
        snapshotBytes: Buffer.from('snapshot\n'),
      },
      {
        rename: async (from, to) => {
          renamedTargets.push(to);
          await rename(from, to);
        },
      }
    );

    expect(renamedTargets).toEqual([migrationPath, snapshotPath]);
  });
});
