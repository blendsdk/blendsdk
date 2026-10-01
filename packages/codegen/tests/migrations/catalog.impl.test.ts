import { describe, expect, test } from 'vitest';
import { compareCatalogs } from '../../src/migration/catalog-diff.js';
import {
  projectPostgreSqlCatalog,
  type CatalogQueryClient,
} from '../../src/migration/catalog-projector.js';
import type { SchemaSnapshotV1 } from '../../src/migration/snapshot-types.js';

/** Builds a small valid canonical snapshot for report-level tests. */
function snapshot(columnType = 'text', includeExtra = false): SchemaSnapshotV1 {
  return {
    formatVersion: 1,
    defaultSchema: 'public',
    extensions: [],
    schemas: [{ name: 'public' }],
    tables: [
      {
        schema: 'public',
        name: 'customer',
        columns: [{ name: 'name', type: columnType, nullable: true }],
        uniqueConstraints: [],
        checkConstraints: [],
        foreignKeys: [],
        indexes: [],
      },
      ...(includeExtra
        ? [
            {
              schema: 'public',
              name: 'audit',
              columns: [{ name: 'id', type: 'bigint', nullable: false }],
              uniqueConstraints: [],
              checkConstraints: [],
              foreignKeys: [],
              indexes: [],
            },
          ]
        : []),
    ],
    views: [],
  };
}

describe('catalog projection guards', () => {
  test('rejects malformed provider rows before constructing canonical state', async () => {
    const client: CatalogQueryClient = {
      query: async () => ({ rows: [{ name: 42 }] }),
    };

    await expect(projectPostgreSqlCatalog(client)).rejects.toMatchObject({
      kind: 'INVALID_HISTORY',
      message: 'Invalid default schema.',
    });
  });
});

describe('catalog comparison reports', () => {
  test('orders qualified modeled and unmanaged entries deterministically', () => {
    const comparison = compareCatalogs(snapshot(), snapshot('varchar', true), [
      { kind: 'trigger', identity: 'public.z_touch' },
      { kind: 'function', identity: 'public.a_touch' },
    ]);

    expect(comparison.compatible).toBe(false);
    expect(comparison.items.map(item => [item.classification, item.identity])).toEqual([
      ['EXTRA_MODELED', 'column.public.audit.id'],
      ['DIFFERENT', 'column.public.customer.name'],
      ['MATCH', 'database.defaultSchema'],
      ['UNMANAGED', 'public.a_touch'],
      ['UNMANAGED', 'public.z_touch'],
      ['MATCH', 'schema.public'],
      ['EXTRA_MODELED', 'table.public.audit'],
      ['MATCH', 'table.public.customer'],
    ]);
  });

  test('reports raw desired properties without exposing their SQL text', () => {
    const base = snapshot();
    const table = base.tables[0];
    if (!table) throw new Error('Catalog fixture is missing its customer table.');
    const desired: SchemaSnapshotV1 = {
      ...base,
      tables: [
        {
          ...table,
          columns: [
            {
              name: 'name',
              type: 'text',
              nullable: true,
              default: "current_setting('private.secret')",
            },
          ],
        },
      ],
    };

    const comparison = compareCatalogs(desired, snapshot());
    const rendered = JSON.stringify(comparison.items);

    expect(comparison.items).toContainEqual({
      classification: 'UNSUPPORTED_FOR_ADOPTION',
      identity: 'column.public.customer.name',
    });
    expect(rendered).not.toContain('private.secret');
  });

  test('treats unmanaged-only differences as compatible', () => {
    const comparison = compareCatalogs(snapshot(), snapshot(), [
      { kind: 'function', identity: 'public.keep_me' },
    ]);

    expect(comparison.compatible).toBe(true);
    expect(comparison.items).toContainEqual({
      classification: 'UNMANAGED',
      identity: 'public.keep_me',
    });
  });

  test('normalizes authoring aliases and creation-only index concurrency', () => {
    const desired = snapshot('decimal');
    const live = snapshot('numeric');
    const desiredTable = desired.tables[0];
    const liveTable = live.tables[0];
    if (!desiredTable || !liveTable) throw new Error('Catalog fixture is missing its table.');
    desiredTable.indexes.push({
      name: 'customer_name_idx',
      columns: ['name'],
      unique: false,
      concurrent: true,
      method: 'btree',
    });
    liveTable.indexes.push({
      name: 'customer_name_idx',
      columns: ['name'],
      unique: false,
      concurrent: false,
    });

    expect(compareCatalogs(desired, live).compatible).toBe(true);
  });

  test('blocks unsupported relation shapes and desired dependencies on unmanaged types', () => {
    const desired = snapshot('account_status');
    const comparison = compareCatalogs(desired, desired, [
      { kind: 'type', identity: 'public.account_status' },
      { kind: 'relation', identity: 'public.partitioned_customer', blocksAdoption: true },
    ]);

    expect(comparison.compatible).toBe(false);
    expect(comparison.items).toEqual(
      expect.arrayContaining([
        {
          classification: 'UNSUPPORTED_FOR_ADOPTION',
          identity: 'public.account_status',
        },
        {
          classification: 'UNSUPPORTED_FOR_ADOPTION',
          identity: 'public.partitioned_customer',
        },
      ])
    );
  });
});
