import { describe, expect, test } from 'vitest';
import { DatabaseSchema } from '../../src/database/schema/database-schema.js';
import { MigrationError } from '../../src/migration/errors.js';
import { renderMigrationSql } from '../../src/migration/migration-sql.js';
import { normalizeDatabaseSchema } from '../../src/migration/schema-normalizer.js';
import { diffSnapshots } from '../../src/migration/schema-diff.js';

/** Normalizes a schema for terse handler-level cases. */
function snapshot(schema: DatabaseSchema) {
  return normalizeDatabaseSchema(schema);
}

/** Creates one ordinary customer table. */
function customer(): DatabaseSchema {
  const schema = new DatabaseSchema('ignored');
  const table = schema.table('customer');
  table.bigint('id').primaryKey();
  table.text('label').nullable();
  return schema;
}

describe('column transition handlers', () => {
  test('renders default removal and nullable relaxation', () => {
    const before = customer();
    before.getTables()[0]?.findColumn('label')?.default("'before'");
    const after = customer();
    after.getTables()[0]?.findColumn('label')?.nullable();

    const diff = diffSnapshots(snapshot(before), snapshot(after));
    const sql = renderMigrationSql(diff.changes);

    expect(sql).toContain('ALTER COLUMN "label" DROP DEFAULT;');
  });

  test('never ignores generated, identity, or comment transitions', () => {
    const before = customer();
    const afterComment = customer();
    afterComment.getTables()[0]?.findColumn('label')?.comment('new comment');
    expect(diffSnapshots(snapshot(before), snapshot(afterComment)).changes).toEqual([
      expect.objectContaining({ kind: 'comment.set', safety: 'safe' }),
    ]);

    const generated = customer();
    generated.getTables()[0]?.findColumn('label')?.generated("'fixed'");
    const generatedDiff = diffSnapshots(snapshot(before), snapshot(generated));
    expect(generatedDiff.changes).toContainEqual(
      expect.objectContaining({ kind: 'column.generated', safety: 'unsupported' })
    );

    const identityBefore = new DatabaseSchema('ignored');
    identityBefore.table('item').bigint('id').identity('ALWAYS', { start: 1 });
    const identityAfter = new DatabaseSchema('ignored');
    identityAfter.table('item').bigint('id').identity('ALWAYS', { start: 2 });
    expect(diffSnapshots(snapshot(identityBefore), snapshot(identityAfter)).changes).toContainEqual(
      expect.objectContaining({ kind: 'column.identity', safety: 'unsupported' })
    );
  });

  test('blocks SET NOT NULL and type changes even with destructive approval', () => {
    const before = customer();
    const required = customer();
    required.getTables()[0]?.findColumn('label')?.type('text');
    const requiredColumn = required.getTables()[0]?.findColumn('label');
    if (requiredColumn) {
      const replacement = new DatabaseSchema('ignored');
      const table = replacement.table('customer');
      table.bigint('id').primaryKey();
      table.text('label');
      expect(() =>
        renderMigrationSql(diffSnapshots(snapshot(before), snapshot(replacement)).changes, {
          allowDestructive: true,
        })
      ).toThrow(/populate/iu);
    }

    const changedType = customer();
    changedType.getTables()[0]?.findColumn('label')?.type('integer');
    expect(() =>
      renderMigrationSql(diffSnapshots(snapshot(before), snapshot(changedType)).changes, {
        allowDestructive: true,
      })
    ).toThrow(/USING/iu);
  });
});

describe('object handlers and SQL phases', () => {
  test('renders quoted embedded quotes without CASCADE', () => {
    const before = new DatabaseSchema('ignored', 'Odd"Schema');
    const after = new DatabaseSchema('ignored', 'Odd"Schema');
    after.table('Odd"Table').text('Odd"Column').nullable();

    const sql = renderMigrationSql(diffSnapshots(snapshot(before), snapshot(after)).changes);

    expect(sql).toContain('"Odd""Schema"."Odd""Table"');
    expect(sql).toContain('"Odd""Column"');
    expect(sql).not.toContain('CASCADE');
  });

  test('classifies extension, schema, constraint, index, comment, and view additions', () => {
    const before = new DatabaseSchema('ignored');
    const after = new DatabaseSchema('ignored');
    after.extension('pgcrypto');
    const table = after.table('item').scope('inventory').comment('stock');
    table.bigint('id').primaryKey();
    table.text('sku').unique();
    table.index().indexName('item_sku_idx').column('sku');
    after.view('item_view').scope('inventory').as('SELECT id FROM inventory.item');

    const changes = diffSnapshots(snapshot(before), snapshot(after)).changes;
    const sql = renderMigrationSql(changes);

    expect(new Set(changes.map(change => change.kind))).toEqual(
      new Set([
        'extension.add',
        'schema.add',
        'table.add',
        'constraint.add',
        'index.add',
        'comment.set',
        'view.add',
      ])
    );
    expect(sql.indexOf('CREATE EXTENSION')).toBeLessThan(sql.indexOf('CREATE SCHEMA'));
    expect(sql.indexOf('CREATE INDEX')).toBeLessThan(sql.indexOf('COMMENT ON'));
  });

  test('requires approval for targeted drops and marks each destructive statement', () => {
    const before = customer();
    const after = new DatabaseSchema('ignored');
    const changes = diffSnapshots(snapshot(before), snapshot(after)).changes;

    expect(() => renderMigrationSql(changes)).toThrow(MigrationError);
    const sql = renderMigrationSql(changes, { allowDestructive: true });
    expect(sql).toContain('-- destructive: reviewed and explicitly allowed');
    expect(sql).toContain('DROP TABLE "public"."customer";');
    expect(sql).not.toContain('CASCADE');
  });

  test('blocks changed views because opaque SQL dependencies cannot be proven', () => {
    const before = new DatabaseSchema('ignored');
    before.view('summary').as('SELECT 1 AS value');
    const after = new DatabaseSchema('ignored');
    after.view('summary').as('SELECT 2 AS value');

    const diff = diffSnapshots(snapshot(before), snapshot(after));

    expect(diff.changes).toEqual([
      expect.objectContaining({ kind: 'view.replace', safety: 'unsupported' }),
    ]);
    expect(() => renderMigrationSql(diff.changes)).toThrow(/dependency|manual/iu);
  });

  test('orders referenced constraints and removals by dependency', () => {
    const before = new DatabaseSchema('ignored');
    const after = new DatabaseSchema('ignored');
    const parent = after.table('z_parent');
    parent.bigint('id').primaryKey();
    after.table('a_child').bigint('parent_id').references(parent, 'id');
    const addSql = renderMigrationSql(diffSnapshots(snapshot(before), snapshot(after)).changes);
    expect(addSql.indexOf('z_parent_id_pkey')).toBeLessThan(
      addSql.indexOf('a_child_parent_id_fkey')
    );

    const emptyOwned = new DatabaseSchema('ignored', 'owned');
    const owned = new DatabaseSchema('ignored', 'owned');
    owned.table('item').bigint('id');
    const dropSql = renderMigrationSql(
      diffSnapshots(snapshot(owned), snapshot(new DatabaseSchema('ignored'))).changes,
      { allowDestructive: true }
    );
    expect(dropSql.indexOf('DROP TABLE')).toBeLessThan(dropSql.indexOf('DROP SCHEMA'));
    expect(snapshot(emptyOwned).schemas[0]?.name).toBe('owned');
  });

  test('targets the post-rename table and rejects cross-schema rename hints', () => {
    const before = customer();
    before.getTables()[0]?.text('legacy').nullable();
    const after = new DatabaseSchema('ignored');
    const renamed = after.table('account');
    renamed.bigint('id').primaryKey();
    renamed.text('display_name').nullable().default("'shown'");
    const changes = diffSnapshots(snapshot(before), snapshot(after), [
      { kind: 'table', from: 'public.customer', to: 'public.account' },
      { kind: 'column', from: 'public.customer.label', to: 'public.account.display_name' },
    ]).changes;
    const sql = renderMigrationSql(changes, { allowDestructive: true });
    expect(sql).toContain('ALTER TABLE "public"."account" RENAME COLUMN');
    expect(sql).toContain('ALTER TABLE "public"."account" ALTER COLUMN "display_name"');
    expect(sql).toContain('ALTER TABLE "public"."account" DROP COLUMN "legacy"');
    expect(sql).not.toContain('"customer" RENAME COLUMN');

    expect(() =>
      diffSnapshots(snapshot(before), snapshot(after), [
        { kind: 'table', from: 'public.customer', to: 'other.account' },
      ])
    ).toThrow(/Cross-schema/iu);
  });

  test('rejects a column rename that moves between tables without a table rename', () => {
    const before = new DatabaseSchema('ignored');
    before.table('source').text('legacy').nullable();
    before.table('target').bigint('id').primaryKey();
    const after = new DatabaseSchema('ignored');
    after.table('source').bigint('id').primaryKey();
    after.table('target').text('renamed').nullable();

    expect(() =>
      diffSnapshots(snapshot(before), snapshot(after), [
        { kind: 'column', from: 'public.source.legacy', to: 'public.target.renamed' },
      ])
    ).toThrow(/Cross-table/iu);
  });

  test('rejects rename hints that collide with identities retained across snapshots', () => {
    const before = customer();
    const after = new DatabaseSchema('ignored');
    after.table('customer').bigint('id').primaryKey();

    expect(() =>
      diffSnapshots(snapshot(before), snapshot(after), [
        { kind: 'column', from: 'public.customer.label', to: 'public.customer.id' },
      ])
    ).toThrow(/removed identity/iu);

    const renamedTable = new DatabaseSchema('ignored');
    renamedTable.table('account').bigint('id').primaryKey();
    const priorTables = new DatabaseSchema('ignored');
    priorTables.table('customer').bigint('id').primaryKey();
    priorTables.table('account').bigint('id').primaryKey();
    expect(() =>
      diffSnapshots(snapshot(priorTables), snapshot(renamedTable), [
        { kind: 'table', from: 'public.customer', to: 'public.account' },
      ])
    ).toThrow(/removed identity/iu);
  });

  test('renders identity options, index storage, tablespace, and view comments', () => {
    const before = new DatabaseSchema('ignored');
    const after = new DatabaseSchema('ignored');
    const table = after.table('item');
    table.bigint('id').identity('BY DEFAULT', { start: 0, increment: 2, cycle: false });
    const index = table.index().indexName('item_id_idx');
    index.column('id');
    index.with({ fillfactor: 80 }).tablespace('fast_space');
    after.view('item_view').as('SELECT id FROM item').comment('items');

    const sql = renderMigrationSql(diffSnapshots(snapshot(before), snapshot(after)).changes);
    expect(sql).toContain('START WITH 0 INCREMENT BY 2 NO CYCLE');
    expect(sql).toContain('WITH (fillfactor = 80) TABLESPACE "fast_space"');
    expect(sql.indexOf('CREATE VIEW')).toBeLessThan(sql.indexOf('COMMENT ON VIEW'));
  });

  test('uses PostgreSQL materialized-view syntax for comments', () => {
    const before = new DatabaseSchema('ignored');
    const after = new DatabaseSchema('ignored');
    after
      .view('materialized_item_view')
      .as('SELECT 1 AS id')
      .materialized(true)
      .comment('materialized items');

    const sql = renderMigrationSql(diffSnapshots(snapshot(before), snapshot(after)).changes);

    expect(sql.indexOf('CREATE MATERIALIZED VIEW')).toBeLessThan(
      sql.indexOf('COMMENT ON MATERIALIZED VIEW')
    );
    expect(sql).toContain(
      'COMMENT ON MATERIALIZED VIEW "public"."materialized_item_view" IS \'materialized items\';'
    );
  });

  test('keeps primary-key kind when its derived name must be shortened', () => {
    const before = new DatabaseSchema('ignored');
    const after = new DatabaseSchema('ignored');
    after
      .table('very_long_table_name_that_needs_bounded_constraints')
      .bigint('long_identifier')
      .primaryKey();

    const sql = renderMigrationSql(diffSnapshots(snapshot(before), snapshot(after)).changes);

    expect(sql).toContain('PRIMARY KEY');
  });

  test('blocks opaque multi-view removals', () => {
    const before = new DatabaseSchema('ignored');
    before.view('first').as('SELECT 1');
    before.view('second').as('SELECT * FROM public.first');
    const after = new DatabaseSchema('ignored');
    const changes = diffSnapshots(snapshot(before), snapshot(after)).changes;

    expect(changes.every(change => change.safety === 'unsupported')).toBe(true);
    expect(() => renderMigrationSql(changes, { allowDestructive: true })).toThrow(/View removal/iu);
  });

  test('blocks same-name constraint and index replacements', () => {
    const before = new DatabaseSchema('ignored');
    const beforeParent = before.table('parent');
    beforeParent.bigint('id').primaryKey();
    const beforeChild = before.table('child');
    beforeChild.bigint('parent_id').references(beforeParent, 'id');
    beforeChild.index().indexName('child_parent_idx').column('parent_id').where('parent_id > 0');

    const after = new DatabaseSchema('ignored');
    const afterParent = after.table('parent');
    afterParent.bigint('id').primaryKey();
    const afterChild = after.table('child');
    afterChild.bigint('parent_id').references(afterParent, 'id', undefined, 'CASCADE');
    afterChild.index().indexName('child_parent_idx').column('parent_id').where('parent_id >= 0');

    const changes = diffSnapshots(snapshot(before), snapshot(after)).changes;

    expect(changes).toContainEqual(
      expect.objectContaining({ kind: 'constraint.add', safety: 'unsupported' })
    );
    expect(changes).toContainEqual(
      expect.objectContaining({ kind: 'index.add', safety: 'unsupported' })
    );
    expect(() => renderMigrationSql(changes, { allowDestructive: true })).toThrow(/replacement/iu);
  });

  test('blocks a primary-key replacement after a hinted column rename', () => {
    const before = new DatabaseSchema('ignored');
    before.table('item').bigint('legacy_id').primaryKey();
    const after = new DatabaseSchema('ignored');
    after.table('item').bigint('id').primaryKey();

    const changes = diffSnapshots(snapshot(before), snapshot(after), [
      { kind: 'column', from: 'public.item.legacy_id', to: 'public.item.id' },
    ]).changes;

    expect(changes).toContainEqual(
      expect.objectContaining({ kind: 'constraint.add', safety: 'unsupported' })
    );
    expect(changes).not.toContainEqual(
      expect.objectContaining({
        kind: 'constraint.drop',
        definition: expect.objectContaining({ kind: 'primaryKey' }),
      })
    );
    expect(() => renderMigrationSql(changes, { allowDestructive: true })).toThrow(
      /Primary-key replacement/iu
    );
  });
});
