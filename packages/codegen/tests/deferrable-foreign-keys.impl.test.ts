import { describe, expect, test } from 'vitest';
import { DatabaseSchema } from '../src/database/schema/database-schema.js';
import { normalizeDatabaseSchema } from '../src/migration/schema-normalizer.js';
import { validateSchemaSnapshot } from '../src/migration/snapshot-types.js';

/** Builds a two-table schema with one foreign key. */
function schemaWithForeignKey() {
  const database = new DatabaseSchema('app');
  const secrets = database.table('secrets');
  secrets.bigint('id').primaryKey();

  const versions = database.table('secret_versions');
  versions.bigint('id').primaryKey();
  versions.bigint('secret_id');
  return {
    database,
    constraint: versions.foreignKeyConstraint(secrets).from('secret_id').to('id'),
  };
}

describe('deferrable foreign key implementation details', () => {
  test('starts non-deferrable and validates the runtime mode', () => {
    const { constraint } = schemaWithForeignKey();

    expect(constraint.isDeferrable()).toBe(false);
    expect(constraint.isInitiallyDeferred()).toBe(false);
    expect(() => constraint.deferrable('SOMETIMES' as 'DEFERRED')).toThrow(
      'Unsupported foreign key deferrability'
    );
  });

  test('tracks the immediately-deferred flag separately from deferrability', () => {
    const { constraint } = schemaWithForeignKey();
    constraint.deferrable('IMMEDIATE');

    expect(constraint.isDeferrable()).toBe(true);
    expect(constraint.isInitiallyDeferred()).toBe(false);
  });

  test('rejects non-canonical deferrable states in a snapshot', () => {
    const { database, constraint } = schemaWithForeignKey();
    constraint.deferrable('DEFERRED');
    const snapshot = normalizeDatabaseSchema(database);

    const withState = (state: { deferrable?: boolean; initiallyDeferred?: boolean }) => ({
      ...snapshot,
      tables: snapshot.tables.map(table =>
        table.name === 'secret_versions'
          ? {
              ...table,
              foreignKeys: table.foreignKeys.map(foreignKey => ({
                ...foreignKey,
                deferrable: state.deferrable,
                initiallyDeferred: state.initiallyDeferred,
              })),
            }
          : table
      ),
    });

    for (const state of [
      { deferrable: undefined, initiallyDeferred: true },
      { deferrable: false },
      { deferrable: false, initiallyDeferred: true },
      { deferrable: true, initiallyDeferred: undefined },
    ]) {
      expect(() => validateSchemaSnapshot(withState(state))).toThrow(/canonical/u);
    }
  });
});
