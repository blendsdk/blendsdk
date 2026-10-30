import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PostgreSQLDatabase } from '@blendsdk/postgresql';
import {
  PostgreSQLIntrospector,
  type ColumnMapper,
} from '../src/database/introspect/introspect.js';
import { TypeGenerator, ZodGenerator } from '../src/generator/index.js';
import { ObjectSchema, SchemaContainer } from '../src/schema/index.js';

const introspectDatabase = {
  host: process.env.CODEGEN_PG_HOST ?? 'localhost',
  port: Number(process.env.CODEGEN_PG_PORT ?? 5597),
  database: process.env.CODEGEN_PG_DATABASE ?? 'introspect',
  user: process.env.CODEGEN_PG_USER ?? 'testdb',
  pass: process.env.CODEGEN_PG_PASSWORD ?? 'testdb',
};

/** Creates a unique table so parallel suites and the shared fixture cannot collide. */
function uniqueTableName() {
  return `json_introspection_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Narrows the container entry to an object schema before reading its properties. */
function tableProperties(container: SchemaContainer, table: string) {
  const object = container.find(undefined, table);
  if (!(object instanceof ObjectSchema)) {
    throw new Error(`Introspection did not produce an object schema for ${table}.`);
  }
  return object.getProperties();
}

describe('JSON introspection', () => {
  let db: PostgreSQLDatabase;

  beforeEach(() => {
    db = new PostgreSQLDatabase(introspectDatabase);
  });

  afterEach(async () => {
    await db.disconnect();
  });

  test('maps json and jsonb to unknown without a fallback warning', async () => {
    const table = uniqueTableName();
    const container = new SchemaContainer();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await db.executeQuery(`
        CREATE TABLE public."${table}" (
          jsonb_probe jsonb NOT NULL,
          json_probe json NOT NULL,
          nullable_jsonb_probe jsonb
        )
      `);

      await new PostgreSQLIntrospector(db).introspect(container);

      const properties = tableProperties(container, table);
      expect(properties.jsonb_probe?.getData().tsType).toBe('unknown');
      expect(properties.json_probe?.getData().tsType).toBe('unknown');
      expect(properties.nullable_jsonb_probe?.getData().tsType).toBe('unknown');
      expect(properties.nullable_jsonb_probe?.getData().nullable).toBe(true);
      expect(properties.nullable_jsonb_probe?.getData().optional).toBe(true);

      const logged = logSpy.mock.calls.map(args => String(args[0]));
      const tableWarnings = logged.filter(
        line => line.includes(table) && line.includes('could not be mapped')
      );
      const jsonWarnings = logged.filter(
        line => line.includes(' -> json ') || line.includes(' -> jsonb ')
      );
      expect(tableWarnings).toEqual([]);
      expect(jsonWarnings).toEqual([]);

      const typeSource = await new TypeGenerator().generate(container);
      expect(typeSource).toContain('jsonb_probe: unknown;');
      expect(typeSource).toContain('json_probe: unknown;');
      expect(typeSource).toContain('nullable_jsonb_probe?: unknown | null;');

      const zodSource = await new ZodGenerator().generate(container);
      expect(zodSource).toContain('jsonb_probe: z.unknown()');
      expect(zodSource).toContain('json_probe: z.unknown()');
      expect(zodSource).toContain('nullable_jsonb_probe: z.unknown().optional().nullable()');
    } finally {
      logSpy.mockRestore();
      await db.executeQuery(`DROP TABLE IF EXISTS public."${table}"`);
    }
  });

  test('allows a ColumnMapper to provide a typed JSON shape', async () => {
    const table = uniqueTableName();
    const container = new SchemaContainer();

    try {
      await db.executeQuery(`
        CREATE TABLE public."${table}" (
          jsonb_probe jsonb NOT NULL,
          json_probe json NOT NULL
        )
      `);

      const mapper: ColumnMapper = (column, scope) => {
        if (column.relation_name !== table) return undefined;
        if (column.pg_type !== 'json' && column.pg_type !== 'jsonb') return undefined;
        const mapped = scope.any();
        mapped.setData({
          tsType: 'Record<string, unknown>',
          zodExpression: 'z.record(z.string(), z.unknown())',
        });
        return mapped;
      };

      await new PostgreSQLIntrospector(db).introspect(container, mapper);
      const properties = tableProperties(container, table);

      expect(properties.jsonb_probe?.getData().tsType).toBe('Record<string, unknown>');
      expect(properties.json_probe?.getData().tsType).toBe('Record<string, unknown>');

      const typeSource = await new TypeGenerator().generate(container);
      const zodSource = await new ZodGenerator().generate(container);
      expect(typeSource).toContain('jsonb_probe: Record<string, unknown>;');
      expect(zodSource).toContain('jsonb_probe: z.record(z.string(), z.unknown())');
    } finally {
      await db.executeQuery(`DROP TABLE IF EXISTS public."${table}"`);
    }
  });

  test('exposes introspectConstantTypes and keeps the historical alias', async () => {
    const table = uniqueTableName();
    const introspector = new PostgreSQLIntrospector(db);

    try {
      await db.executeQuery(`
        CREATE TABLE public."${table}" (
          id text NOT NULL,
          payload jsonb
        )
      `);

      const corrected = await introspector.introspectConstantTypes();
      const legacy = await introspector.introstectConstantTypes();

      expect(corrected[table]).toEqual(['id', 'payload']);
      expect(legacy).toEqual(corrected);
    } finally {
      await db.executeQuery(`DROP TABLE IF EXISTS public."${table}"`);
    }
  });
});
