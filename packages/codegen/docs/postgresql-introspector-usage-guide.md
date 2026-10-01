# PostgreSQL Introspector Usage Guide

`PostgreSQLIntrospector` reads an existing PostgreSQL catalog into a `SchemaContainer` so
`TypeGenerator` can produce TypeScript types. It is a read-only type-generation tool. It does not
create database objects, update `DatabaseSchema`, generate migration snapshots, or replace the
BlendSDK migration workflow.

## Install

```bash
yarn add @blendsdk/codegen @blendsdk/postgresql pg
```

Use a role with catalog and table metadata read access. Keep credentials in environment variables;
do not commit them to source.

## Generate types from a database

```ts
import { PostgreSQLIntrospector, SchemaContainer, TypeGenerator } from '@blendsdk/codegen';
import { PostgreSQLDatabase } from '@blendsdk/postgresql';

const database = new PostgreSQLDatabase({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  pass: process.env.PGPASSWORD,
});

try {
  const types = new SchemaContainer();
  await new PostgreSQLIntrospector(database).introspect(types);

  const source = await new TypeGenerator().generate(types);
  console.log(source);
} finally {
  await database.disconnect();
}
```

The current introspector reads all supported relations visible to the connected role. It does not
accept schema/view filter options. Filter or split the generated output in application tooling if
that is required.

## Customize a column type

Pass a `ColumnMapper` as the second argument to `introspect`. Return a schema object for a custom
mapping or `undefined` to use BlendSDK's built-in PostgreSQL mapping.

```ts
import type { ColumnMapper } from '@blendsdk/codegen';

const mapColumn: ColumnMapper = (column, scope) => {
  if (column.pg_type === 'jsonb' && column.relation_name === 'customer') {
    return scope.object({
      marketingOptIn: scope.boolean(),
    });
  }
  return undefined;
};

const types = new SchemaContainer();
await new PostgreSQLIntrospector(database).introspect(types, mapColumn);
```

The mapper receives the raw `ColumnIntrospection` record and the column's `SchemaScope`. JSON,
JSONB, byte arrays, intervals, ranges, and unknown extension types are intentionally good
candidates for explicit mapping.

## List relation column names

`introstectConstantTypes()` retains its historical misspelling for API compatibility. It returns a
record whose keys are qualified relation names and whose values are column names.

```ts
const introspector = new PostgreSQLIntrospector(database);
const columnsByRelation = await introspector.introstectConstantTypes();
```

## Relationship to database migrations

The introspector and migration tools solve different problems:

| Tool                        | Source of truth                          | Output                                      | Mutates PostgreSQL |
| --------------------------- | ---------------------------------------- | ------------------------------------------- | ------------------ |
| `PostgreSQLIntrospector`    | Existing live catalog                    | Type-generation schema                      | No                 |
| `PostgreSQLSchemaGenerator` | `DatabaseSchema`                         | Bootstrap schema SQL                        | No                 |
| `blendsdk migrate generate` | `DatabaseSchema` plus committed snapshot | Incremental migration SQL and next snapshot | No                 |
| `blendsdk migrate up`       | Committed migration files                | Applied ledger and schema changes           | Yes                |

For a managed application schema, edit `DatabaseSchema` once and run
`blendsdk migrate generate <name>`. Review and commit both the SQL migration and snapshot. Do not
use production introspection output to establish migration history.

## Limits

- Introspection describes columns and selected relation metadata for type generation; it is not a
  complete PostgreSQL catalog backup.
- Unsupported PostgreSQL types fall back to a deprecated `any` schema with a warning unless a
  mapper handles them.
- The introspector does not provide a temporary-database manager. Use the repository's Docker test
  setup or your own disposable PostgreSQL instance for integration tests.
- Close `PostgreSQLDatabase` with `disconnect()` so its pool does not keep the process alive.
