import { describe, expect, test } from 'vitest';
import { DatabaseSchema } from '../src/database/schema/database-schema.js';
import type { ColumnType } from '../src/database/schema/types.js';
import { TypeGenerator, ZodGenerator } from '../src/generator/index.js';
import { normalizeDatabaseSchema } from '../src/migration/schema-normalizer.js';
import { parseSnapshotBytes, serializeSnapshot } from '../src/migration/snapshot.js';
import { SchemaContainer } from '../src/schema/index.js';

describe('binary and network column implementation details', () => {
  test('renders a standalone BinarySchema as Buffer and z.instanceof(Buffer)', async () => {
    const container = new SchemaContainer();
    container.scope().binary().named('payload');

    const typeSource = await new TypeGenerator().generate(container);
    const zodSource = await new ZodGenerator().generate(container);

    expect(typeSource).toContain('export type Payload = Buffer;');
    expect(zodSource).toContain('export const PayloadSchema = z.instanceof(Buffer);');
  });

  test('includes bytea and inet in the ColumnType union', () => {
    const types: ColumnType[] = ['bytea', 'inet'];

    expect(types).toEqual(['bytea', 'inet']);
  });

  test('round-trips bytea and inet through snapshot bytes', () => {
    const database = new DatabaseSchema('app');
    const table = database.table('secret_versions');
    table.bigserial('id').primaryKey();
    table.bytea('ciphertext').nullable();
    table.inet('source_ip').nullable();

    const snapshot = normalizeDatabaseSchema(database);
    const parsed = parseSnapshotBytes(serializeSnapshot(snapshot));

    expect(parsed).toEqual(snapshot);
  });
});
