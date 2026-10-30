import { describe, expect, test } from 'vitest';
import { PostgreSQLDatabase } from '@blendsdk/postgresql';
import { DatabaseSchema } from '../src/database/schema/database-schema.js';
import { PostgreSQLIntrospector } from '../src/database/introspect/introspect.js';
import { TypeGenerator, ZodGenerator } from '../src/generator/index.js';
import { PostgreSQLSchemaGenerator } from '../src/generator/postgres-schema-generator.js';
import { renderMigrationSql } from '../src/migration/migration-sql.js';
import { diffSnapshots } from '../src/migration/schema-diff.js';
import { normalizeDatabaseSchema } from '../src/migration/schema-normalizer.js';
import { SchemaContainer } from '../src/schema/index.js';

const introspectDatabase = {
  host: 'localhost',
  port: 5597,
  database: 'introspect',
  user: 'testdb',
  pass: 'testdb',
};

/** Builds a table with a binary column, a network column, and an optional variant. */
function binarySchema(includeColumns = true) {
  const database = new DatabaseSchema('app');
  const secrets = database.table('secret_versions');
  secrets.bigserial('id').primaryKey();
  if (includeColumns) {
    secrets.bytea('ciphertext').nullable();
    secrets.inet('source_ip').nullable();
  }
  return database;
}

describe('bytea and inet columns', () => {
  test('emits bytea and inet in generated DDL', () => {
    const ddl = new PostgreSQLSchemaGenerator(binarySchema()).generate();

    expect(ddl).toMatch(/ciphertext bytea/u);
    expect(ddl).toMatch(/source_ip inet/u);
  });

  test('preserves bytea and inet in the canonical snapshot', () => {
    const snapshot = normalizeDatabaseSchema(binarySchema());
    const table = snapshot.tables.find(item => item.name === 'secret_versions');
    const types = new Map(table?.columns.map(column => [column.name, column.type]));

    expect(types.get('ciphertext')).toBe('bytea');
    expect(types.get('source_ip')).toBe('inet');
  });

  test('renders an added bytea column and blocks an unapproved drop', () => {
    const before = normalizeDatabaseSchema(binarySchema(false));
    const after = normalizeDatabaseSchema(binarySchema(true));
    const added = diffSnapshots(before, after);
    const addedSql = renderMigrationSql(added.changes);

    expect(addedSql).toMatch(/ADD COLUMN "ciphertext" bytea/u);
    expect(addedSql).toMatch(/ADD COLUMN "source_ip" inet/u);

    const removed = diffSnapshots(after, before);
    expect(removed.changes.some(change => change.kind === 'column.drop')).toBe(true);
    expect(() => renderMigrationSql(removed.changes)).toThrow(/explicit approval/u);
    expect(renderMigrationSql(removed.changes, { allowDestructive: true })).toMatch(
      /DROP COLUMN "ciphertext"/u
    );
  });

  test('introspects bytea as Buffer and inet as string', async () => {
    const table = `binary_types_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const db = new PostgreSQLDatabase(introspectDatabase);
    const schema = new SchemaContainer();

    try {
      await db.executeQuery(
        `CREATE TABLE public."${table}" (payload bytea NOT NULL, source_ip inet, labels text[])`
      );

      await new PostgreSQLIntrospector(db).introspect(schema);

      const object = schema.find(undefined, table);
      expect(object).toBeDefined();
      const properties = object!.getProperties();
      expect(properties.payload?.getData().tsType).toBe('Buffer');
      expect(properties.source_ip?.getData().tsType).toBe('string');

      const typeSource = await new TypeGenerator().generate(schema);
      expect(typeSource).toContain('payload: Buffer;');
      expect(typeSource).toContain('source_ip?: string | null;');

      const zodSource = await new ZodGenerator().generate(schema);
      expect(zodSource).toContain('payload: z.instanceof(Buffer)');
      expect(zodSource).toContain('source_ip: z.string().optional().nullable()');
    } finally {
      await db.executeQuery(`DROP TABLE IF EXISTS public."${table}"`);
      await db.disconnect();
    }
  });
});
