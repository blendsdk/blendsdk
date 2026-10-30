import { describe, expect, test } from 'vitest';
import { DatabaseSchema } from '../src/database/schema/database-schema.js';
import { PostgreSQLSchemaGenerator } from '../src/generator/postgres-schema-generator.js';
import { renderMigrationSql } from '../src/migration/migration-sql.js';
import { diffSnapshots } from '../src/migration/schema-diff.js';
import { normalizeDatabaseSchema } from '../src/migration/schema-normalizer.js';

type DeferrableMode = 'DEFERRED' | 'IMMEDIATE';

/** Builds two related tables; the foreign key is optional so the diff has a before state. */
function schemaWithForeignKey(
  includeForeignKey: boolean,
  mode?: DeferrableMode,
  tableName = 'secret_versions'
) {
  const database = new DatabaseSchema('app');
  const secrets = database.table('secrets');
  secrets.bigint('id').primaryKey();

  const versions = database.table(tableName);
  versions.bigint('id').primaryKey();
  versions.bigint('secret_id');

  if (includeForeignKey) {
    const constraint = versions.foreignKeyConstraint(secrets).from('secret_id').to('id');
    if (mode) constraint.deferrable(mode);
  }

  return database;
}

describe('deferrable foreign keys', () => {
  test('emits DEFERRABLE INITIALLY DEFERRED in generated DDL', () => {
    const ddl = new PostgreSQLSchemaGenerator(schemaWithForeignKey(true, 'DEFERRED')).generate();

    expect(ddl).toMatch(/FOREIGN KEY \( secret_id \) REFERENCES public\.secrets \( id \)/u);
    expect(ddl).toContain('DEFERRABLE INITIALLY DEFERRED');
  });

  test('emits DEFERRABLE INITIALLY IMMEDIATE in generated DDL', () => {
    const ddl = new PostgreSQLSchemaGenerator(schemaWithForeignKey(true, 'IMMEDIATE')).generate();

    expect(ddl).toContain('DEFERRABLE INITIALLY IMMEDIATE');
  });

  test('leaves a non-deferrable foreign key unchanged', () => {
    const ddl = new PostgreSQLSchemaGenerator(schemaWithForeignKey(true)).generate();

    expect(ddl).toMatch(/FOREIGN KEY \( secret_id \) REFERENCES public\.secrets \( id \)/u);
    expect(ddl).not.toContain('DEFERRABLE');
  });

  test('preserves the mode in the canonical snapshot', () => {
    const snapshot = normalizeDatabaseSchema(schemaWithForeignKey(true, 'DEFERRED'));
    const table = snapshot.tables.find(item => item.name === 'secret_versions');

    expect(table?.foreignKeys[0]).toMatchObject({
      kind: 'foreignKey',
      deferrable: true,
      initiallyDeferred: true,
    });
  });

  test('omits the optional snapshot fields for a non-deferrable key', () => {
    const snapshot = normalizeDatabaseSchema(schemaWithForeignKey(true));
    const foreignKey = snapshot.tables.find(item => item.name === 'secret_versions')
      ?.foreignKeys[0];

    expect(foreignKey).toBeDefined();
    expect(foreignKey).not.toHaveProperty('deferrable');
    expect(foreignKey).not.toHaveProperty('initiallyDeferred');
  });

  test('renders a deferred key when the constraint is added', () => {
    const before = normalizeDatabaseSchema(schemaWithForeignKey(false));
    const after = normalizeDatabaseSchema(schemaWithForeignKey(true, 'DEFERRED'));
    const diff = diffSnapshots(before, after);

    const addition = diff.changes.find(
      change => change.kind === 'constraint.add' && change.definition?.kind === 'foreignKey'
    );
    expect(addition).toMatchObject({
      safety: 'safe',
      definition: { deferrable: true, initiallyDeferred: true },
    });

    const sql = renderMigrationSql(diff.changes);
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
  });

  test('rejects a same-name mode change with reviewed-manual-SQL guidance', () => {
    const immediate = normalizeDatabaseSchema(schemaWithForeignKey(true, 'IMMEDIATE'));
    const deferred = normalizeDatabaseSchema(schemaWithForeignKey(true, 'DEFERRED'));
    const diff = diffSnapshots(immediate, deferred);

    const replacement = diff.changes.find(change => change.kind === 'constraint.add');
    expect(replacement?.safety).toBe('unsupported');
    expect(() => renderMigrationSql(diff.changes)).toThrow(/manual SQL/iu);
  });

  test('keeps a mode change visible through a hinted table rename', () => {
    const immediate = normalizeDatabaseSchema(schemaWithForeignKey(true, 'IMMEDIATE'));
    const deferred = normalizeDatabaseSchema(schemaWithForeignKey(true, 'DEFERRED', 'versions'));
    const diff = diffSnapshots(immediate, deferred, [
      { kind: 'table', from: 'public.secret_versions', to: 'public.versions' },
    ]);

    expect(diff.changes).toContainEqual(expect.objectContaining({ kind: 'table.rename' }));
    expect(diff.changes).toContainEqual(
      expect.objectContaining({
        kind: 'constraint.add',
        safety: 'unsupported',
        guidance: expect.stringMatching(/manual SQL/u),
      })
    );
  });
});
