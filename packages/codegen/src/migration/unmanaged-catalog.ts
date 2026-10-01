import type { CatalogQueryClient } from './catalog-projector.js';
import { MigrationError } from './errors.js';

const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema'];

/** One unmodeled PostgreSQL object reported during baseline adoption. */
export interface UnmanagedCatalogObject {
  /** Stable object category. */
  readonly kind: 'function' | 'trigger' | 'type' | 'relation';
  /** Qualified identity, including a function signature or trigger owner where needed. */
  readonly identity: string;
  /** Whether this unsupported object shape prevents safe baseline adoption. */
  readonly blocksAdoption?: boolean;
}

/**
 * Reads unmodeled objects without treating unrelated application behavior as managed state.
 *
 * Unsupported relation shapes block adoption because they can occupy a modeled table identity.
 * Functions, triggers, enums, and domains remain informational unless desired modeled state
 * depends on an unmodeled type.
 */
export async function readUnmanagedCatalogObjects(
  client: CatalogQueryClient
): Promise<readonly UnmanagedCatalogObject[]> {
  const result = await client.query(
    `
      SELECT 'function' AS kind, n.nspname AS schema_name, p.proname AS object_name,
             pg_get_function_identity_arguments(p.oid) AS detail, false AS blocks_adoption
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname <> ALL($1::text[])
        AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
        AND p.prokind = 'f'
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_depend dep
          WHERE dep.classid = 'pg_catalog.pg_proc'::regclass
            AND dep.objid = p.oid AND dep.deptype = 'e'
        )
      UNION ALL
      SELECT 'trigger', n.nspname, t.tgname, c.relname, false
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname <> ALL($1::text[])
        AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
        AND NOT t.tgisinternal
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_depend dep
          WHERE dep.classid = 'pg_catalog.pg_trigger'::regclass
            AND dep.objid = t.oid AND dep.deptype = 'e'
        )
      UNION ALL
      SELECT 'type', n.nspname, typ.typname, '', false
      FROM pg_catalog.pg_type typ
      JOIN pg_catalog.pg_namespace n ON n.oid = typ.typnamespace
      WHERE n.nspname <> ALL($1::text[])
        AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
        AND (typ.typtype = 'd' OR (typ.typtype = 'e' AND typ.typelem = 0))
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_depend dep
          WHERE dep.classid = 'pg_catalog.pg_type'::regclass
            AND dep.objid = typ.oid AND dep.deptype = 'e'
        )
      UNION ALL
      SELECT 'relation', n.nspname, c.relname, '', true
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname <> ALL($1::text[])
        AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
        AND (c.relkind IN ('p', 'f') OR c.relpersistence <> 'p' OR c.relispartition)
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_depend dep
          WHERE dep.classid = 'pg_catalog.pg_class'::regclass
            AND dep.objid = c.oid AND dep.deptype = 'e'
        )
      ORDER BY kind, schema_name, object_name, detail
    `,
    [SYSTEM_SCHEMAS]
  );
  return result.rows.map((row, index) => parseUnmanaged(row, index));
}

/** Converts one untrusted catalog row into a stable display identity. */
function parseUnmanaged(row: unknown, index: number): UnmanagedCatalogObject {
  if (!isRecord(row)) {
    throw invalidCatalog(`Invalid unmanaged object ${index + 1} row.`);
  }
  const value = row;
  const kind = requiredText(value.kind, 'unmanaged kind');
  if (kind !== 'function' && kind !== 'trigger' && kind !== 'type' && kind !== 'relation') {
    throw invalidCatalog('Unknown unmanaged kind.');
  }
  const schema = requiredText(value.schema_name, 'unmanaged schema');
  const name = requiredText(value.object_name, 'unmanaged name');
  const detail = typeof value.detail === 'string' ? value.detail : '';
  const identity =
    kind === 'function'
      ? `${schema}.${name}(${detail})`
      : kind === 'trigger'
        ? `${schema}.${requiredText(value.detail, 'trigger table')}.${name}`
        : `${schema}.${name}`;
  return {
    kind,
    identity,
    ...(value.blocks_adoption === true ? { blocksAdoption: true } : {}),
  };
}

/** Narrows unknown PostgreSQL driver output to a property record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Requires a nonempty text value from an untrusted catalog row. */
function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw invalidCatalog(`Invalid ${label}.`);
  return value;
}

/** Creates a sanitized incompatible-catalog failure. */
function invalidCatalog(message: string): MigrationError {
  return new MigrationError({ kind: 'INVALID_HISTORY', exitCode: 1, message });
}
