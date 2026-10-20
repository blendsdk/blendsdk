> **Package**: `blendsdk/postgresql`

# postgresql API Reference

`blendsdk/postgresql` is the PostgreSQL adapter of the BlendSDK data stack. It implements the abstract database contract of `blendsdk/dbcore` on top of the `pg` driver and the `yesql` named-parameter compiler. This document is the complete reference for every symbol exported from the package root.

Shared contract types — `ExecuteQueryOptions`, `QueryResult<T>`, the base statement builders, and `DatabaseConfig` — appear throughout the signatures below but are **not re-exported** by this package; they are catalogued in [Related Types](#related-types-from-blendsdkdbcore-and-pg). For conceptual material, see the Overview and Core Concepts.

---

## Exports at a Glance

| Symbol | Kind | Description |
|--------|------|-------------|
| `PostgreSQLDatabase` | class | PostgreSQL adapter: owns the `pg` connection pool and provides query execution, transaction management, and statement factories. |
| `PostgreSQLInsertStatement<TableType>` | class | INSERT statement builder with `VALUES` and optional `RETURNING` support. |
| `PostgreSQLUpdateStatement<TableType, FilterType>` | class | UPDATE statement builder with `SET`, filter-based `WHERE`, and optional `RETURNING` support. |
| `PostgreSQLDeleteStatement<FilterType>` | class | DELETE statement builder with filter-based `WHERE` and optional `RETURNING` support. |
| `PostgreSQLConfig` | interface | Connection configuration; extends `DatabaseConfig` with `poolConfig` and `enableGracefulShutdown`. |
| `PoolConfig` | interface | Optional tuning of the underlying `pg` connection pool (`max` and timeout settings). |
| `PostgreSQLQueryResult<T>` | interface | Query result carrying `records`, `rowCount`, and `pg` field metadata (`fields`). |

All symbols are imported from the package root:

```typescript fragment
// Runtime exports
import {
  PostgreSQLDatabase,
  PostgreSQLDeleteStatement,
  PostgreSQLInsertStatement,
  PostgreSQLUpdateStatement,
} from 'blendsdk/postgresql';

// Type-only exports
import type {
  PoolConfig,
  PostgreSQLConfig,
  PostgreSQLQueryResult,
} from 'blendsdk/postgresql';
```

---

## PostgreSQLDatabase

`PostgreSQLDatabase` extends the abstract `Database` class from `blendsdk/dbcore` and is the only class instantiated directly by application code. One instance owns one `pg.Pool` and provides query execution, transaction management, and factories for the INSERT, UPDATE, and DELETE statement builders; the SELECT factories (`from()`, `selectAll()`) are inherited from the base class.

### Constructor

```typescript fragment
new PostgreSQLDatabase(config: PostgreSQLConfig)
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `PostgreSQLConfig` | Yes | — | Connection settings (`host`, `port`, `database`, `user`, `pass`) plus the optional `poolConfig` and `enableGracefulShutdown` settings. |

The constructor initializes the underlying `pg.Pool`: database, host, user, and password are forwarded, and a provided `port` is coerced with `Number()`. Pool settings from `poolConfig` are applied only for the properties that are present. No connection is opened at construction time — the pool connects lazily on first use — and SIGINT/SIGTERM handlers are registered only when `enableGracefulShutdown` is `true`.

### Methods

`from()` and `selectAll()` are inherited from `Database` (`blendsdk/dbcore`); all other methods are declared by `PostgreSQLDatabase`.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `executeQuery` | `executeQuery<R>(query: string, params?: Record<string, unknown>, options?: ExecuteQueryOptions): Promise<PostgreSQLQueryResult<R>>` | `Promise<PostgreSQLQueryResult<R>>` | Executes named-parameter SQL and returns typed records plus field metadata. |
| `withTransaction` | `withTransaction<T>(fn: (db: this) => Promise<T>): Promise<T>` | `Promise<T>` | Runs `fn` inside `BEGIN`/`COMMIT` on a pinned client; rolls back and rethrows when `fn` throws. |
| `connect` | `connect(): Promise<PoolClient>` | `Promise<PoolClient>` | Acquires a raw client from the pool. |
| `disconnect` | `disconnect(timeoutMs?: number): Promise<void>` | `Promise<void>` | Gracefully closes the pool with a forced-release fallback (default timeout 10000 ms). |
| `insert` | `insert<T>(tableName: string): InsertStatement<T>` | `InsertStatement<T>` | Creates an INSERT builder (the instance is a `PostgreSQLInsertStatement<T>`). |
| `update` | `update<T, F>(tableName: string): UpdateStatement<T, F>` | `UpdateStatement<T, F>` | Creates an UPDATE builder (the instance is a `PostgreSQLUpdateStatement<T, F>`). |
| `delete` | `delete<F>(tableName: string): DeleteStatement<F>` | `DeleteStatement<F>` | Creates a DELETE builder (the instance is a `PostgreSQLDeleteStatement<F>`). |
| `from` | `from<T>(tableName: string): FromStatement<T>` | `FromStatement<T>` | Creates a SELECT builder for the table. Inherited from `blendsdk/dbcore`. |
| `selectAll` | `selectAll(tableName: string): FromStatement` | `FromStatement` | Creates a `SELECT *` builder for the table. Inherited from `blendsdk/dbcore`. |

#### executeQuery()

```typescript fragment
executeQuery<R>(
  query: string,
  params?: Record<string, unknown>,
  options?: ExecuteQueryOptions
): Promise<PostgreSQLQueryResult<R>>
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | Yes | — | SQL text using `:name` placeholders, compiled into positional parameters by `yesql`. |
| `params` | `Record<string, unknown>` | No | `{}` | Values for the named placeholders. Values are never interpolated into the SQL text. |
| `options` | `ExecuteQueryOptions` | No | `{}` | Optional `beforeQuery` / `afterQuery` hooks (defined in `blendsdk/dbcore`). |

**Returns**: `Promise<PostgreSQLQueryResult<R>>`. When the query returns or affects no rows, the method resolves to `{ records: [], rowCount: 0, fields: [] }` and the `afterQuery` hook is not invoked.

**Throws**: `Error` with the message `Cannot execute query: database is shutting down` when called after `disconnect()` has begun; connection and SQL errors propagate unchanged from `pg` / PostgreSQL.

Notes:

- Outside a transaction, the query runs on a pooled client that is released in a `finally` block; inside `withTransaction()` it runs on the pinned client and participates in the active transaction.
- `beforeQuery` receives the parameter map before `yesql` compiles the statement; `afterQuery` receives the returned rows after execution.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id: number;
  name: string;
  email: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const result = await db.executeQuery<UserRow>(
    'SELECT id, name, email FROM users WHERE email = :email',
    { email: 'ADA@EXAMPLE.COM' },
    {
      beforeQuery: (params) => {
        const email = params.email;
        return typeof email === 'string' ? { ...params, email: email.toLowerCase() } : params;
      },
      afterQuery: (records) =>
        records.map((record) => ({ ...record, name: record.name.toUpperCase() })),
    }
  );

  console.log(`Matched ${result.rowCount} row(s)`);
  console.log(`Columns: ${result.fields.map((field) => field.name).join(', ')}`);

  for (const user of result.records) {
    console.log(user.id, user.name, user.email);
  }
} finally {
  await db.disconnect();
}
```

#### withTransaction()

```typescript fragment
withTransaction<T>(fn: (db: this) => Promise<T>): Promise<T>
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `fn` | `(db: this) => Promise<T>` | Yes | — | Unit of work executed inside the transaction; receives the same instance, whose statements run on the pinned client. |

**Returns**: `Promise<T>` — the callback's result after `COMMIT`.

**Throws**: `Error` with the message `Cannot start transaction: database is shutting down` when called after `disconnect()` has begun; the callback's own error is rethrown after `ROLLBACK`.

Notes:

- Issues `BEGIN`, runs `fn`, then issues `COMMIT`; on any error from `fn` a `ROLLBACK` is attempted and the original error is rethrown — a failure during rollback is logged with `console.error` but never replaces the original error.
- The client is always released back to the pool in a `finally` block, even when the rollback fails, so a failed transaction never leaks a connection.
- The instance is busy while the transaction is active: use only the callback's database argument, do not start nested `withTransaction()` calls, and avoid concurrent operations on the same instance.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const transferred = await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(
      'UPDATE accounts SET balance = balance - :amount WHERE id = :id',
      { amount: 100, id: 1 }
    );
    await txDb.executeQuery(
      'UPDATE accounts SET balance = balance + :amount WHERE id = :id',
      { amount: 100, id: 2 }
    );
    return 100;
  });

  console.log(`Transferred ${transferred}`);
} catch (error) {
  console.error('Transaction rolled back:', error instanceof Error ? error.message : error);
} finally {
  await db.disconnect();
}
```

#### connect()

```typescript fragment
connect(): Promise<PoolClient>
```

**Returns**: `Promise<PoolClient>` — a raw client from the pool. Used internally by `withTransaction()` and by atomic `executeQuery()` calls; callers are responsible for releasing the client when finished.

```typescript fragment
const client = await db.connect();
try {
  await client.query('SELECT 1');
} finally {
  client.release();
}
```

#### disconnect()

```typescript fragment
disconnect(timeoutMs?: number): Promise<void>
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `timeoutMs` | `number` | No | `10000` | Maximum time to wait for `pool.end()` before force-releasing all clients. |

**Returns**: `Promise<void>` — resolves when the pool has been closed (gracefully or after the forced fallback).

**Throws**: `Error` — if ending the pool fails before the timeout fires; the forced fallback path itself resolves rather than rejects.

Notes:

- Sets `isShuttingDown` immediately: further `executeQuery()` calls reject with `Cannot execute query: database is shutting down` and further `withTransaction()` calls reject with `Cannot start transaction: database is shutting down`.
- When the timeout expires first, every pooled client is force-released (interrupting active queries if necessary) and the pool's internal client list is cleared, after which the method resolves.
- Safe to call on an instance that never executed a query.

### Protected Members

The class declares no public properties; all instance state is `protected`.

| Property | Type | Description |
|----------|------|-------------|
| `pool` | `Pool` | The `pg` connection pool created in the constructor. |
| `transactionClient` | `PoolClient \| null` | Client pinned for the duration of an active transaction; `null` otherwise (initial value `null`). |
| `isShuttingDown` | `boolean` | Set to `true` by `disconnect()` to reject new queries and transactions (initial value `false`). |

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `forceDisconnect` | `protected forceDisconnect(): Promise<void>` | `Promise<void>` | Last-resort shutdown: force-releases every pooled client and clears the pool's internal client list. |
| `registerShutdownHandlers` | `protected registerShutdownHandlers(): void` | `void` | Registers SIGINT/SIGTERM handlers that call `disconnect()` and exit the process; invoked when `enableGracefulShutdown` is enabled. |

---

## PostgreSQLInsertStatement

`PostgreSQLInsertStatement<TableType>` extends `InsertStatement<TableType>` from `blendsdk/dbcore` and implements the PostgreSQL-specific `INSERT` SQL generation. The fluent API (`.values()`, `.returning()`), the query hooks, and the `execute*` terminators are inherited from the base builder; this class supplies `buildQuery()` and `buildParameters()`.

### Instantiation

Instances are created through the database factory — the declared return type is the `blendsdk/dbcore` base class, and the concrete instance is `PostgreSQLInsertStatement<TableType>`:

```typescript fragment
db.insert<TableType>(tableName: string): InsertStatement<TableType>
```

The constructor (inherited from the base builder in `blendsdk/dbcore`) receives the table name and the owning database instance.

### Methods

Inherited from `InsertStatement<TableType>` (`blendsdk/dbcore`):

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `values` | `values(values: Partial<TableType>): this` | `this` | Sets the columns to insert; each key becomes a column name and a `:key` placeholder. Column order follows the key insertion order of the values object. |
| `returning` | `returning(columns: '*' \| Array<keyof TableType>): this` | `this` | Appends a `RETURNING` clause — `'*'` or an explicit column list. |
| `beforeQuery` | `beforeQuery(fn: (params: Record<string, unknown>) => Record<string, unknown>): this` | `this` | Registers a parameter transform; INSERT parameters are keyed by column name. |
| `afterQuery` | `afterQuery(fn: (records: TableType[]) => TableType[]): this` | `this` | Registers a result transform, applied before rows are returned by the terminators. |
| `execute` | `execute(): Promise<QueryResult<TableType> \| null>` | `Promise<QueryResult<TableType> \| null>` | Executes the statement and resolves with the underlying query result. |
| `executeReturnSingle` | `executeReturnSingle(): Promise<TableType \| null>` | `Promise<TableType \| null>` | Resolves with the first returned row (requires a `RETURNING` clause), or `null`. |
| `executeReturnAll` | `executeReturnAll(): Promise<TableType[]>` | `Promise<TableType[]>` | Resolves with all returned rows. |
| `executeReturnCount` | `executeReturnCount(): Promise<number>` | `Promise<number>` | Resolves with the number of inserted rows. |

### Protected Members

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `buildQuery` | `protected buildQuery(): string` | `string` | Builds `INSERT INTO <table> (<cols>) VALUES (:<col>, …)` with an optional `RETURNING` clause; throws when no values were provided. |
| `buildParameters` | `protected buildParameters(): Record<string, unknown>` | `Record<string, unknown>` | Returns the values object — each key already matches its `:key` placeholder. |

```typescript fragment
// .values({ name: 'Alice', email: 'alice@example.com' })
'INSERT INTO users (name, email) VALUES (:name, :email)'

// .values({ name: 'Alice' }).returning('*')
'INSERT INTO users (name) VALUES (:name) RETURNING *'
```

Building an INSERT whose `.values()` produced no columns throws an `Error` instead of emitting invalid SQL: `Cannot build INSERT statement for table "users": no values provided. Call .values() with at least one column before executing.` — the message interpolates the target table name.

### Example

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
  password_hash?: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const created = await db
    .insert<UserRow>('users')
    .values({ name: 'Ada Lovelace', email: 'Ada@Example.com', password_hash: 'plain-secret' })
    .beforeQuery((params) => {
      const email = params.email;
      return typeof email === 'string' ? { ...params, email: email.toLowerCase() } : params;
    })
    .afterQuery((records) =>
      records.map((record) => {
        const safe: UserRow = { ...record };
        delete safe.password_hash;
        return safe;
      })
    )
    .returning('*')
    .executeReturnSingle();

  if (created) {
    console.log(`Created ${created.name} <${created.email}>`);
  }
} finally {
  await db.disconnect();
}
```

---

## PostgreSQLUpdateStatement

`PostgreSQLUpdateStatement<TableType, FilterType>` extends `UpdateStatement<TableType, FilterType>` from `blendsdk/dbcore` and implements the PostgreSQL-specific `UPDATE` SQL generation: a `SET` clause whose value parameters use the reserved `v_` prefix, a `WHERE` clause compiled from the filter (parameters `p1…pN`), and an optional `RETURNING` clause. Chaining, hooks, and execution flow are inherited from the base builder.

### Instantiation

Instances are created through the database factory — the declared return type is the `blendsdk/dbcore` base class, and the concrete instance is `PostgreSQLUpdateStatement<TableType, FilterType>`:

```typescript fragment
db.update<TableType, FilterType>(tableName: string): UpdateStatement<TableType, FilterType>
```

The constructor (inherited from the base builder in `blendsdk/dbcore`) receives the table name and the owning database instance.

### Methods

Inherited from `UpdateStatement<TableType, FilterType>` (`blendsdk/dbcore`):

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `values` | `values(values: Partial<TableType>): this` | `this` | Sets the columns to update; each key becomes `column = :v_key`. |
| `filter` | `filter(filter: FilterType): this` | `this` | Builds the `WHERE` clause from the filter object; parameters are `p1…pN`. An empty filter produces no `WHERE` clause (all rows are updated). |
| `filterByExpression` | `filterByExpression(fn): this` | `this` | Builds the `WHERE` clause with the BlendSDK expression API; the callback receives the expression builder bound to `FilterType`, e.g. `.filterByExpression(q => q.where('age').greaterThan(65))`. |
| `returning` | `returning(columns: '*' \| Array<keyof TableType>): this` | `this` | Appends a `RETURNING` clause — `'*'` or an explicit column list. |
| `beforeQuery` | `beforeQuery(fn: (params: Record<string, unknown>) => Record<string, unknown>): this` | `this` | Registers a parameter transform; UPDATE parameters combine `v_`-prefixed values with `p1…pN` filters. |
| `afterQuery` | `afterQuery(fn: (records: TableType[]) => TableType[]): this` | `this` | Registers a result transform, applied before rows are returned by the terminators. |
| `execute` | `execute(): Promise<QueryResult<TableType> \| null>` | `Promise<QueryResult<TableType> \| null>` | Executes the statement and resolves with the underlying query result. |
| `executeReturnSingle` | `executeReturnSingle(): Promise<TableType \| null>` | `Promise<TableType \| null>` | Resolves with the first updated row (requires a `RETURNING` clause), or `null`. |
| `executeReturnAll` | `executeReturnAll(): Promise<TableType[]>` | `Promise<TableType[]>` | Resolves with all updated rows. |
| `executeReturnCount` | `executeReturnCount(): Promise<number>` | `Promise<number>` | Resolves with the number of updated rows. |

### Protected Members

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `buildQuery` | `protected buildQuery(): string` | `string` | Builds `UPDATE <table> SET <col> = :v_<col>, …`, appends `WHERE <compiled filter>` when a filter is set and `RETURNING …` when requested; throws when no values were provided. |
| `buildParameters` | `protected buildParameters(): Record<string, unknown>` | `Record<string, unknown>` | Merges the `v_`-prefixed value parameters with the compiled filter parameters (`p1…pN`); the prefixes prevent collisions between the two namespaces. |

```typescript fragment
// .values({ name: 'Bob' }).filter({ id: 1 }).returning('*')
'UPDATE users SET name = :v_name WHERE id = :p1 RETURNING *'
// buildParameters() → { v_name: 'Bob', p1: 1 }
```

The `WHERE` condition is compiled once by the inherited expression pipeline and cached (`getCompiledExpression()`), so `buildQuery()` and `buildParameters()` always share the same compilation. Building an UPDATE whose `.values()` produced no columns throws: `Cannot build UPDATE statement for table "users": no values provided. Call .values() with at least one column before executing.`

### Example

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
  active?: boolean;
}

interface UserFilter {
  id?: number;
  email?: string;
  active?: boolean;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const deactivated = await db
    .update<UserRow, UserFilter>('users')
    .values({ active: false })
    .filter({ email: 'ada@example.com' })
    .returning(['id', 'email', 'active'])
    .executeReturnSingle();

  if (deactivated) {
    console.log(`Deactivated ${deactivated.email} (id ${deactivated.id})`);
  }

  const reactivated = await db
    .update<UserRow, UserFilter>('users')
    .values({ active: true })
    .filter({ active: false })
    .executeReturnCount();

  console.log(`Reactivated ${reactivated} user(s)`);
} finally {
  await db.disconnect();
}
```

---

## PostgreSQLDeleteStatement

`PostgreSQLDeleteStatement<FilterType>` extends `DeleteStatement<FilterType>` from `blendsdk/dbcore` and implements the PostgreSQL-specific `DELETE` SQL generation: an optional `WHERE` clause compiled from the filter (parameters `p1…pN`) and an optional `RETURNING` clause. Chaining, hooks, and execution flow are inherited from the base builder.

### Instantiation

Instances are created through the database factory — the declared return type is the `blendsdk/dbcore` base class, and the concrete instance is `PostgreSQLDeleteStatement<FilterType>`:

```typescript fragment
db.delete<FilterType>(tableName: string): DeleteStatement<FilterType>
```

The constructor (inherited from the base builder in `blendsdk/dbcore`) receives the table name and the owning database instance.

### Methods

Inherited from `DeleteStatement<FilterType>` (`blendsdk/dbcore`):

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `filter` | `filter(filter: FilterType): this` | `this` | Builds the `WHERE` clause from the filter object; parameters are `p1…pN`. An empty filter (or no filter) produces no `WHERE` clause — every row is deleted. |
| `filterByExpression` | `filterByExpression(fn): this` | `this` | Builds the `WHERE` clause with the BlendSDK expression API; the callback receives the expression builder bound to `FilterType`, e.g. `.filterByExpression(q => q.where('status').equals('expired'))`. |
| `returning` | `returning(columns: '*' \| Array<keyof FilterType>): this` | `this` | Appends a `RETURNING` clause — `'*'` or an explicit column list. |
| `beforeQuery` | `beforeQuery(fn: (params: Record<string, unknown>) => Record<string, unknown>): this` | `this` | Registers a parameter transform over the `p1…pN` filter parameters. |
| `afterQuery` | `afterQuery(fn: (records: FilterType[]) => FilterType[]): this` | `this` | Registers a result transform, applied before rows are returned by the terminators. |
| `execute` | `execute(): Promise<QueryResult<FilterType> \| null>` | `Promise<QueryResult<FilterType> \| null>` | Executes the statement and resolves with the underlying query result. |
| `executeReturnSingle` | `executeReturnSingle(): Promise<FilterType \| null>` | `Promise<FilterType \| null>` | Resolves with the first deleted row (requires a `RETURNING` clause), or `null`. |
| `executeReturnAll` | `executeReturnAll(): Promise<FilterType[]>` | `Promise<FilterType[]>` | Resolves with all deleted rows. |
| `executeReturnCount` | `executeReturnCount(): Promise<number>` | `Promise<number>` | Resolves with the number of deleted rows. |

### Protected Members

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `buildQuery` | `protected buildQuery(): string` | `string` | Builds `DELETE FROM <table>`, appends `WHERE <compiled filter>` when a filter is set and `RETURNING …` when requested. |
| `buildParameters` | `protected buildParameters(): Record<string, unknown>` | `Record<string, unknown>` | Returns the compiled filter parameters (`p1…pN`); an empty object when no filter is set. |

```typescript fragment
// .filter({ id: 1 }).returning('*')
'DELETE FROM users WHERE id = :p1 RETURNING *'
// .filter({}) — no WHERE clause, deletes all rows
'DELETE FROM users'
```

The `WHERE` condition is compiled once by the inherited expression pipeline and cached (`getCompiledExpression()`), so `buildQuery()` and `buildParameters()` always share the same compilation.

### Example

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface SessionFilter {
  user_id?: number;
  status?: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const removed = await db
    .delete<SessionFilter>('sessions')
    .filter({ status: 'expired' })
    .returning(['user_id', 'status'])
    .executeReturnAll();

  for (const session of removed) {
    console.log(`Removed ${session.status} session for user ${session.user_id}`);
  }
} finally {
  await db.disconnect();
}
```

---

## PoolConfig

Optional tuning for the `pg` pool created by `PostgreSQLDatabase`. Every property is optional; properties that are omitted are not forwarded, leaving the `pg` driver defaults in place.

| Property | Type | Description |
|----------|------|-------------|
| `max?` | `number` | Maximum number of clients in the pool. Driver default: `10`. |
| `idleTimeoutMillis?` | `number` | Milliseconds a client may sit idle before being closed. Driver default: `30000`. |
| `connectionTimeoutMillis?` | `number` | Milliseconds to wait for a new client before timing out; `0` disables the timeout. Driver default: `0`. |

```typescript fragment
import type { PoolConfig } from 'blendsdk/postgresql';

const poolConfig: PoolConfig = {
  max: 20,
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 5000,
};
```

---

## PostgreSQLConfig

The configuration accepted by the `PostgreSQLDatabase` constructor. It extends `DatabaseConfig` from `blendsdk/dbcore` (connection properties) with PostgreSQL-specific pool and lifecycle settings.

| Property | Type | Description |
|----------|------|-------------|
| `poolConfig?` | `PoolConfig` | Optional tuning for the underlying connection pool — see [PoolConfig](#poolconfig). |
| `enableGracefulShutdown?` | `boolean` | When `true`, the constructor registers SIGINT/SIGTERM handlers that disconnect the database and exit the process. Default: `false`. |

> **⚠️ Warning:** Do NOT enable `enableGracefulShutdown` when the database is managed by a `WebApplication` (from `blendsdk/webafx`), which has its own shutdown handling via SIGTERM/SIGINT. Enabling both causes signal handler conflicts and unpredictable shutdown behavior. Only enable it for standalone database usage outside of the web framework.

Properties inherited from `DatabaseConfig` (`blendsdk/dbcore`):

| Property | Type | Description |
|----------|------|-------------|
| `host` | `string` | Hostname of the PostgreSQL server. |
| `port?` | `number \| string` | Server port; a string value is coerced with `Number()` by the constructor. When omitted, the driver default applies. |
| `database` | `string` | Name of the database to connect to. |
| `user` | `string` | Database role used for authentication. |
| `pass` | `string` | Password; mapped to the driver's `password` option. |

```typescript fragment
import type { PostgreSQLConfig } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
  poolConfig: {
    max: 20,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 5000,
  },
  enableGracefulShutdown: false,
};
```

---

## PostgreSQLQueryResult

The result of `executeQuery<R>()`, extending `QueryResult<T>` from `blendsdk/dbcore`.

| Property | Type | Description |
|----------|------|-------------|
| `records` | `T[]` | Rows returned by the query, typed by `T`. Inherited from `QueryResult<T>`. |
| `rowCount` | `number` | Number of rows returned (SELECT) or affected (DML). Inherited from `QueryResult<T>`. |
| `fields` | `FieldDef[]` | `pg` field definitions describing the returned columns (for example `field.name`); an empty array when the query returns no rows. |

```typescript fragment
const result: PostgreSQLQueryResult<{ id: number; name: string }> =
  await db.executeQuery<{ id: number; name: string }>(
    'SELECT id, name FROM users WHERE active = :active',
    { active: true }
  );

const names = result.records.map((user) => user.name);
const columnNames = result.fields.map((field) => field.name);
```

---

## Related Types from blendsdk/dbcore and pg

These types appear in the signatures above but are **not exported** from `blendsdk/postgresql`; import them from their owning package when you need to annotate against them.

| Type | Origin | Appears as |
|------|--------|-----------|
| `Database` | `blendsdk/dbcore` | Base class of `PostgreSQLDatabase`. |
| `DatabaseConfig` | `blendsdk/dbcore` | Base interface of `PostgreSQLConfig` (`host`, `port`, `database`, `user`, `pass`). |
| `ExecuteQueryOptions` | `blendsdk/dbcore` | Third parameter of `executeQuery()`. |
| `QueryResult<T>` | `blendsdk/dbcore` | Base interface of `PostgreSQLQueryResult<T>`. |
| `InsertStatement<T>` | `blendsdk/dbcore` | Declared return type of `db.insert<T>()` (instances are `PostgreSQLInsertStatement<T>`). |
| `UpdateStatement<T, F>` | `blendsdk/dbcore` | Declared return type of `db.update<T, F>()`. |
| `DeleteStatement<F>` | `blendsdk/dbcore` | Declared return type of `db.delete<F>()`. |
| `FromStatement` | `blendsdk/dbcore` | Return type of the inherited `db.from<T>()` and `db.selectAll()`. |
| `Pool` | `pg` | Type of the protected `pool` property on `PostgreSQLDatabase`. |
| `PoolClient` | `pg` | Type of the protected `transactionClient` property and of `connect()`'s result. |
| `FieldDef` | `pg` | Element type of `PostgreSQLQueryResult.fields`. |

### ExecuteQueryOptions

Optional hooks accepted by `executeQuery()` (defined in `blendsdk/dbcore`):

| Property | Type | Description |
|----------|------|-------------|
| `beforeQuery?` | `(params: Record<string, unknown>) => Record<string, unknown>` | Transforms the parameter map before the SQL is compiled. |
| `afterQuery?` | `(records: R[]) => R[]` | Transforms the returned rows before the result is resolved; skipped when the query returns no rows. `R` matches the `executeQuery<R>()` type argument. |

---

## Error Messages

Conditions raised by the adapter and their exact messages:

| Condition | Message |
|-----------|---------|
| `executeQuery()` called after `disconnect()` has begun | `Cannot execute query: database is shutting down` |
| `withTransaction()` called after `disconnect()` has begun | `Cannot start transaction: database is shutting down` |
| INSERT built without values | `Cannot build INSERT statement for table "<tableName>": no values provided. Call .values() with at least one column before executing.` |
| UPDATE built without values | `Cannot build UPDATE statement for table "<tableName>": no values provided. Call .values() with at least one column before executing.` |

Connection failures, constraint violations, and SQL errors propagate unchanged from the `pg` driver and the PostgreSQL server.

---

## Enums and Constants

`blendsdk/postgresql` exports no enums or runtime constant values. Behavior is configured through `PostgreSQLConfig` / `PoolConfig`, the statement builder methods, and the `beforeQuery` / `afterQuery` hooks.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
