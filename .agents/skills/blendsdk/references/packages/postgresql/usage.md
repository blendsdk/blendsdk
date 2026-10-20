> **Package**: `blendsdk/postgresql`

# postgresql Core Concepts

`blendsdk/postgresql` is a thin dialect adapter over `blendsdk/dbcore`: the abstract database contract, the statement-chaining API, query hooks, and expression compilation live in the core package, while this package supplies the `pg`-based connection layer and the PostgreSQL SQL generation for the INSERT, UPDATE, and DELETE builders. This document walks through every core concept of the package — what it is, how it works, a complete example, and a reference table of its key methods and properties.

The concepts covered are:

- [PostgreSQLDatabase](#postgresqldatabase) — the adapter and its connection pool
- [Configuration and Connection Pooling](#configuration-and-connection-pooling) — `PostgreSQLConfig` and `PoolConfig`
- [Query Execution with Named Parameters](#query-execution-with-named-parameters) — `executeQuery()` and `PostgreSQLQueryResult`
- [Transactions](#transactions) — `withTransaction()`
- [INSERT Statement Builder](#insert-statement-builder) — `db.insert<T>()`
- [UPDATE Statement Builder](#update-statement-builder) — `db.update<T, F>()`
- [DELETE Statement Builder](#delete-statement-builder) — `db.delete<F>()`
- [Query Hooks](#query-hooks) — `beforeQuery` and `afterQuery`
- [Connection Lifecycle and Graceful Shutdown](#connection-lifecycle-and-graceful-shutdown) — `disconnect()` and shutdown guards

Examples in this document are written against illustrative tables (`users`, `accounts`, `sessions`); each example models the columns it uses. For a feature tour, see the Overview, and for a task-oriented walkthrough, see Basic Usage.

---

## PostgreSQLDatabase

### What It Is

`PostgreSQLDatabase` is the entry point of the package and the only class you instantiate directly. It is the PostgreSQL implementation of the abstract `Database` contract from `blendsdk/dbcore`: one instance owns one `pg.Pool` and exposes query execution, transaction management, and factories for the INSERT, UPDATE, and DELETE statement builders. Everything else in the package — the builders and the configuration types — exists to serve an instance of this class.

### How It Works

- **Inheritance.** `PostgreSQLDatabase` extends `Database` from `blendsdk/dbcore`. The base class owns the shared execution flow — parameter handling, query hooks, expression compilation and caching, and the `execute*` terminators on statements — while this class supplies the driver integration and the dialect-specific SQL generation.
- **Lazy construction.** The constructor builds a `pg.Pool` from the configuration but does not open a connection. `pg.Pool` connects on demand, so creating an instance succeeds even when the server is unreachable; connection failures surface on the first query instead.
- **Connection handling.** Every atomic operation (`executeQuery()` outside a transaction) acquires a client from the pool and releases it in a `finally` block. While a transaction is active, the pinned client stored on the protected `transactionClient` property is reused for every statement. See [Transactions](#transactions).
- **Statement factories.** `insert()`, `update()`, and `delete()` return PostgreSQL-specific builders bound to the instance, so statements execute through its pool and participate in its current transaction. The `from()` and `selectAll()` factories for SELECT statements are inherited from the base class.
- **Shutdown guard.** Once `disconnect()` has been called, the `isShuttingDown` flag rejects all further queries and transactions. See [Connection Lifecycle and Graceful Shutdown](#connection-lifecycle-and-graceful-shutdown).

### Complete Example

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
  const { records, rowCount } = await db.executeQuery<{ server_time: Date }>(
    'SELECT now() AS server_time'
  );

  console.log(`Server time: ${records[0].server_time.toISOString()} (${rowCount} row)`);
} finally {
  await db.disconnect();
}
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `constructor` | `(config: PostgreSQLConfig)` | Creates the adapter and initializes its `pg.Pool` from the configuration |
| `executeQuery` | `<R>(query: string, params?: Record<string, unknown>, options?: ExecuteQueryOptions) => Promise<PostgreSQLQueryResult<R>>` | Executes named-parameter SQL; see [Query Execution with Named Parameters](#query-execution-with-named-parameters) |
| `withTransaction` | `<T>(fn: (db: this) => Promise<T>) => Promise<T>` | Runs `fn` on a pinned client inside `BEGIN`/`COMMIT`; see [Transactions](#transactions) |
| `connect` | `() => Promise<PoolClient>` | Acquires a raw client from the pool (used internally by transactions and atomic queries) |
| `disconnect` | `(timeoutMs?: number) => Promise<void>` | Closes the pool; the default timeout is 10 000 ms |
| `insert` | `<T>(tableName: string) => InsertStatement<T>` | Creates an INSERT statement builder bound to this instance |
| `update` | `<T, F>(tableName: string) => UpdateStatement<T, F>` | Creates an UPDATE statement builder bound to this instance |
| `delete` | `<F>(tableName: string) => DeleteStatement<F>` | Creates a DELETE statement builder bound to this instance |
| `from` | `<T>(tableName: string) => FromStatement<T>` | Creates a SELECT builder for the table (inherited from `blendsdk/dbcore`) |
| `selectAll` | `(tableName: string) => FromStatement` | Creates a `SELECT *` builder for the table (inherited from `blendsdk/dbcore`) |
| `pool` | `Pool` (protected) | The underlying connection pool |
| `transactionClient` | `PoolClient \| null` (protected) | The client pinned during an active transaction |
| `isShuttingDown` | `boolean` (protected) | `true` from the moment `disconnect()` starts |

---

## Configuration and Connection Pooling

### What It Is

`PostgreSQLConfig` describes everything the adapter needs to reach a server, plus optional pool tuning and lifecycle opt-ins. It extends `DatabaseConfig` from `blendsdk/dbcore` — the connection properties shared by every backend — with the PostgreSQL-specific `poolConfig` and `enableGracefulShutdown` settings. `PoolConfig` is the nested type that controls how the underlying `pg.Pool` sizes and recycles its clients.

### How It Works

- The constructor destructures the configuration and forwards it to `pg.Pool`: `database`, `host`, `user`, and `pass` (mapped to the driver's `password`). A `port` provided as a string is coerced with `Number()`; everything else is passed through as-is.
- `poolConfig` entries are forwarded only when present. Omitted properties keep the driver defaults: `max: 10`, `idleTimeoutMillis: 30000`, and `connectionTimeoutMillis: 0` (no connect timeout). Supplying no `poolConfig` at all is fully supported.
- Construction validates nothing. An unreachable host or wrong credentials do not throw when the instance is created — the first query rejects instead, and `disconnect()` still resolves cleanly.
- `enableGracefulShutdown` registers SIGINT/SIGTERM handlers that disconnect the database and exit the process (see [Connection Lifecycle and Graceful Shutdown](#connection-lifecycle-and-graceful-shutdown)). It defaults to `false`.
- ⚠️ **Warning:** do NOT enable `enableGracefulShutdown` when the database is managed by a `WebApplication` from `blendsdk/webafx`, which has its own SIGTERM/SIGINT handling. Registering both causes signal handler conflicts and unpredictable shutdown behavior. Only enable it for standalone database usage outside the web framework.

### Complete Example

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

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
};

const db = new PostgreSQLDatabase(config);

try {
  const { records } = await db.executeQuery<{ version: string }>('SELECT version() AS version');
  console.log(records[0].version);
} finally {
  await db.disconnect();
}
```

A `port` given as a string is accepted for convenience and numerically coerced during construction:

```typescript fragment
const config: PostgreSQLConfig = {
  host: 'localhost',
  port: '5432', // coerced with Number() in the constructor
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};
```

### Key Methods and Properties

`PostgreSQLConfig` (extends `DatabaseConfig`):

| Property | Type | Description |
| --- | --- | --- |
| `host` | `string` | Hostname of the PostgreSQL server |
| `port?` | `number \| string` | Server port; strings are coerced with `Number()` |
| `database` | `string` | Name of the database to connect to |
| `user` | `string` | Database role used for authentication |
| `pass` | `string` | Password — mapped to the driver's `password` option |
| `poolConfig?` | `PoolConfig` | Optional connection-pool tuning (see below) |
| `enableGracefulShutdown?` | `boolean` | When `true`, registers SIGINT/SIGTERM handlers that disconnect and exit; default `false` |

`PoolConfig`:

| Property | Type | Description |
| --- | --- | --- |
| `max?` | `number` | Maximum number of clients in the pool (driver default: 10) |
| `idleTimeoutMillis?` | `number` | Milliseconds a client may sit idle before being closed (driver default: 30 000) |
| `connectionTimeoutMillis?` | `number` | Milliseconds to wait for a new client before timing out; `0` disables the timeout (driver default: 0) |

---

## Query Execution with Named Parameters

### What It Is

`executeQuery<R>()` is the general-purpose execution method and the engine underneath every statement builder. SQL is written with named placeholders (`:param`), which the `yesql` compiler translates into PostgreSQL positional parameters (`$1`, `$2`, …). The generic `R` types the returned records, and the method resolves to a `PostgreSQLQueryResult<R>`.

### How It Works

1. **Shutdown guard** — rejects with `Cannot execute query: database is shutting down` once `disconnect()` has been called.
2. **Connection acquisition** — if no transaction is active, a client is acquired from the pool and marked for release ("atomic" mode); inside a transaction, the pinned client is reused instead.
3. **`beforeQuery` hook** — when provided via `options`, it receives the parameter map and returns the transformed one.
4. **Compilation** — `yesql` compiles the statement: `:name` placeholders become `$1, $2, …` and the values are passed to the driver separately as positional parameters. Values are never interpolated into the SQL text, so malicious input such as `' OR 1=1 --` is treated as a literal value.
5. **Execution** — the compiled text and values are sent to the client.
6. **Empty results** — when `rowCount === 0`, the method returns `{ records: [], rowCount: 0, fields: [] }` immediately; the `afterQuery` hook is not invoked.
7. **`afterQuery` hook** — when provided, it receives the rows array and returns the transformed rows.
8. **Cleanup** — in a `finally` block, an atomically acquired client is always released back to the pool; a failure during release is logged, never thrown.

### Complete Example

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase, PostgreSQLQueryResult } from 'blendsdk/postgresql';

interface UserRow {
  id: number;
  name: string;
  active: boolean;
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
  const result: PostgreSQLQueryResult<UserRow> = await db.executeQuery<UserRow>(
    `SELECT id, name, active
       FROM users
      WHERE name = :name AND active = :active`,
    { name: "O'Reilly", active: true }
  );

  for (const user of result.records) {
    console.log(user.id, user.name);
  }

  console.log(`rows: ${result.rowCount}`);
  console.log(`columns: ${result.fields.map((field) => field.name).join(', ')}`);
} finally {
  await db.disconnect();
}
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `executeQuery` | `<R>(query: string, params?: Record<string, unknown>, options?: ExecuteQueryOptions) => Promise<PostgreSQLQueryResult<R>>` | Compiles named parameters with `yesql`, executes the SQL, applies hooks, and returns typed records |

The resolved `PostgreSQLQueryResult<R>` exposes:

| Property | Type | Description |
| --- | --- | --- |
| `records` | `R[]` | Rows returned by the query, typed by `R` |
| `rowCount` | `number` | Number of rows returned (SELECT) or affected (DML) |
| `fields` | `FieldDef[]` | Column metadata from the `pg` driver — an empty array when no rows are returned |

---

## Transactions

### What It Is

`withTransaction<T>(fn)` runs a unit of work atomically: it issues `BEGIN`, runs the callback, and then either `COMMIT`s on success or `ROLLBACK`s on failure. The callback receives the same database instance, and every statement executed through it — raw `executeQuery()` calls or builder operations — runs on one pinned client, so all of them belong to the same server-side transaction.

### How It Works

- **Shutdown guard** — throws `Cannot start transaction: database is shutting down` if `disconnect()` has begun.
- **Client pinning** — the first `withTransaction()` call acquires a client from the pool and stores it on the protected `transactionClient` property. The callback's argument is the instance itself (`this`), so the natural style is `db.withTransaction(async (txDb) => { ... })` and every `txDb.executeQuery(...)` participates in the transaction.
- **Commit path** — `BEGIN` is issued, `fn` runs, `COMMIT` is issued, and the callback's return value is passed through unchanged.
- **Rollback path** — if `fn` throws, a `ROLLBACK` is attempted (only if `COMMIT` did not already succeed) and the original error is rethrown. A failing rollback is logged via `console.error` but never replaces the original error, so the message you see is the one your code or the server produced.
- **Guaranteed cleanup** — the `finally` block always releases the client back to the pool and clears `transactionClient`, even when the rollback itself failed. A failed transaction never leaks a connection, and the instance is immediately usable again afterward.
- **Instance is busy during a transaction** — because the pinned client is instance state, treat the instance as occupied while a transaction runs: use only the callback's database argument, do not start a nested `withTransaction()` inside the callback, and avoid firing concurrent queries on the same instance during the transaction.

### Complete Example

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface BalanceRow {
  balance: string;
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
  const newBalance = await db.withTransaction(async (txDb) => {
    // Debit the source account
    await txDb.executeQuery(
      'UPDATE accounts SET balance = balance - :amount WHERE id = :id',
      { amount: 100, id: 1 }
    );

    // Re-read inside the transaction to enforce the overdraft rule
    const { records } = await txDb.executeQuery<BalanceRow>(
      'SELECT balance FROM accounts WHERE id = :id',
      { id: 1 }
    );

    if (Number(records[0].balance) < 0) {
      // Throwing rolls back the whole transaction, including the debit above
      throw new Error('insufficient funds');
    }

    // Credit the destination account
    await txDb.executeQuery(
      'UPDATE accounts SET balance = balance + :amount WHERE id = :id',
      { amount: 100, id: 2 }
    );

    return records[0].balance;
  });

  console.log(`Transfer committed. New balance: ${newBalance}`);
} catch (error) {
  console.error('Transfer rolled back:', error instanceof Error ? error.message : error);
} finally {
  await db.disconnect();
}
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `withTransaction` | `<T>(fn: (db: this) => Promise<T>) => Promise<T>` | Runs `fn` inside `BEGIN`/`COMMIT`; issues `ROLLBACK` and rethrows when `fn` throws; always releases the client |
| `transactionClient` | `PoolClient \| null` (protected) | The client pinned while a transaction is active; `null` otherwise |
| `isShuttingDown` | `boolean` (protected) | Rejects new transactions once `disconnect()` has begun |

---

## INSERT Statement Builder

### What It Is

`db.insert<T>(tableName)` returns a `PostgreSQLInsertStatement<T>` — a fluent, type-safe builder for `INSERT` statements. The generic `T` models the target row, so `.values()` and `.returning()` are checked against the table's shape. The chaining API, hooks, and `execute*` terminators come from the base class in `blendsdk/dbcore`; the PostgreSQL class overrides only the SQL and parameter generation.

### How It Works

- **Values become columns and placeholders.** Each key in `.values(record)` becomes a column name and its `:key` placeholder, producing SQL of the form `INSERT INTO users (name, email) VALUES (:name, :email)`.
- **Parameters are the values object.** `buildParameters()` returns the values object directly, since every key already matches its placeholder name.
- **Validated builder.** Building an INSERT with no values throws — `Cannot build INSERT statement for table "users": no values provided. Call .values() with at least one column before executing.` — instead of emitting invalid SQL.
- **Optional `RETURNING`.** `.returning('*')` or `.returning([...columns])` appends a `RETURNING` clause, making the inserted rows available to the `executeReturnSingle()` / `executeReturnAll()` terminators.
- **Termination.** Statements execute through the owning database instance (and its active transaction, if any), and builder hooks registered with `beforeQuery` / `afterQuery` are applied at execution time — see [Query Hooks](#query-hooks).

### Complete Example

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
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
  const created = await db
    .insert<UserRow>('users')
    .values({ name: 'Ada Lovelace', email: 'ada@example.com', active: true })
    .returning('*')
    .executeReturnSingle();

  if (created) {
    console.log(`Created user ${created.id}: ${created.name} <${created.email}>`);
  }

  const insertedCount = await db
    .insert<UserRow>('users')
    .values({ name: 'Alan Turing', email: 'alan@example.com' })
    .executeReturnCount();

  console.log(`Inserted ${insertedCount} user(s)`);
} finally {
  await db.disconnect();
}
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `values` | `(values: Partial<T>) => this` | Sets the columns and values to insert; each key becomes a `:key` parameter |
| `returning` | `(columns: '*' \| Array<keyof T>) => this` | Appends a `RETURNING` clause (`'*'` or an explicit column list) |
| `beforeQuery` | `(fn: (params: Record<string, unknown>) => Record<string, unknown>) => this` | Registers a parameter transform that runs before compilation |
| `afterQuery` | `(fn: (records: T[]) => T[]) => this` | Registers a result transform that runs before records are returned |
| `execute` | `() => Promise<QueryResult<T> \| null>` | Executes the statement and resolves with the underlying query result (`records`, `rowCount`) |
| `executeReturnSingle` | `() => Promise<T \| null>` | Resolves with the first returned row, or `null` when no row was returned |
| `executeReturnAll` | `() => Promise<T[]>` | Resolves with all returned rows |
| `executeReturnCount` | `() => Promise<number>` | Resolves with the number of inserted rows |

---

## UPDATE Statement Builder

### What It Is

`db.update<T, F>(tableName)` returns a `PostgreSQLUpdateStatement<T, F>` — a fluent builder for `UPDATE` statements with a `SET` clause typed by `T`, a `WHERE` clause typed by `F`, and optional `RETURNING` support. It shares the chaining API, hooks, and terminators of the base builder; the PostgreSQL class supplies the dialect-specific SQL generation.

### How It Works

- **`SET` clause with a dedicated parameter namespace.** Each key in `.values(record)` produces `column = :v_column`, so a column named `active` updates through `:v_active`.
- **`WHERE` clause from compiled filters.** `.filter({ id: 1 })` compiles the filter object into a parameterized condition through the BlendSDK expression engine (for example `WHERE id = :p1`), and multiple keys are joined with `AND` (`WHERE active = :p1 AND age = :p2`). The `.filterByExpression()` variant compiles a callback-built condition instead. The compiled expression is cached per statement, so query text and parameters never compile twice.
- **No name collisions.** Values use the `v_` prefix and filter parameters use `p1…pN`, so updating and filtering on the same column (`.values({ active: true }).filter({ active: false })`) produces distinct parameters: `{ v_active: true, p1: false }`.
- **Validated builder.** Building an UPDATE with no values throws — `Cannot build UPDATE statement for table "users": no values provided. Call .values() with at least one column before executing.`
- **Optional `WHERE`.** When no filter is set — or the filter object is empty — no `WHERE` clause is generated and every row in the table is updated.
- **Optional `RETURNING`.** As with INSERT, `.returning('*')` or an explicit column list makes the updated rows available to the `executeReturn*` terminators.

### Complete Example

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
    console.log(`Deactivated user ${deactivated.id}: ${deactivated.email}`);
  }

  const affected = await db
    .update<UserRow, UserFilter>('users')
    .values({ active: true })
    .filter({ active: false })
    .executeReturnCount();

  console.log(`Reactivated ${affected} user(s)`);
} finally {
  await db.disconnect();
}
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `values` | `(values: Partial<T>) => this` | Sets the columns to update; each key becomes a `:v_key` parameter |
| `filter` | `(filter: F) => this` | Builds the `WHERE` clause from the filter object (`p1…pN` parameters); an empty object means no `WHERE` |
| `filterByExpression` | `(fn) => this` | Builds the `WHERE` clause with the BlendSDK expression API; the callback receives the expression builder for `F` |
| `returning` | `(columns: '*' \| Array<keyof T>) => this` | Appends a `RETURNING` clause (`'*'` or an explicit column list) |
| `beforeQuery` | `(fn: (params: Record<string, unknown>) => Record<string, unknown>) => this` | Registers a parameter transform (`v_`-prefixed values and `p1…pN` filters) |
| `afterQuery` | `(fn: (records: T[]) => T[]) => this` | Registers a result transform that runs before records are returned |
| `execute` | `() => Promise<QueryResult<T> \| null>` | Executes the statement and resolves with the underlying query result |
| `executeReturnSingle` | `() => Promise<T \| null>` | Resolves with the first updated row, or `null` when no row was updated |
| `executeReturnAll` | `() => Promise<T[]>` | Resolves with all updated rows |
| `executeReturnCount` | `() => Promise<number>` | Resolves with the number of updated rows |

---

## DELETE Statement Builder

### What It Is

`db.delete<F>(tableName)` returns a `PostgreSQLDeleteStatement<F>` — a fluent builder for `DELETE` statements whose `WHERE` clause is typed by `F`, with optional `RETURNING` support. Unlike INSERT and UPDATE it has no `SET` clause, so it never requires values; a filter is the only input that shapes which rows are affected.

### How It Works

- **`WHERE` clause from compiled filters.** `.filter({ id: 1 })` compiles into a parameterized condition such as `WHERE id = :p1`, and multiple keys are joined with `AND` (`WHERE active = :p1 AND age = :p2`). The `.filterByExpression()` variant compiles a callback-built condition instead. Parameters are named `p1…pN` and are drawn from the cached compiled expression.
- **`WHERE` is optional.** When no filter is set — or the filter object is empty — the generated statement is a bare `DELETE FROM table` with no `WHERE` clause, which deletes every row.
- **Optional `RETURNING`.** `.returning('*')` or an explicit column list appends a `RETURNING` clause; the `executeReturnSingle()` and `executeReturnAll()` terminators then resolve with the deleted rows, and `executeReturnCount()` resolves with the affected row count.

### Complete Example

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
  const expiredCount = await db
    .delete<SessionFilter>('sessions')
    .filter({ status: 'expired' })
    .executeReturnCount();

  console.log(`Removed ${expiredCount} expired session(s)`);

  const removedForUser = await db
    .delete<SessionFilter>('sessions')
    .filter({ user_id: 42 })
    .returning(['user_id', 'status'])
    .executeReturnAll();

  for (const session of removedForUser) {
    console.log(`Removed ${session.status} session for user ${session.user_id}`);
  }
} finally {
  await db.disconnect();
}
```

A `.filter()` call with an empty object produces a full-table delete — no `WHERE` clause is generated:

```typescript fragment
// Deletes ALL rows: "DELETE FROM sessions"
await db.delete<SessionFilter>('sessions').filter({}).execute();
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `filter` | `(filter: F) => this` | Builds the `WHERE` clause from the filter object (`p1…pN` parameters); an empty object means no `WHERE` (all rows) |
| `filterByExpression` | `(fn) => this` | Builds the `WHERE` clause with the BlendSDK expression API; the callback receives the expression builder for `F` |
| `returning` | `(columns: '*' \| Array<keyof F>) => this` | Appends a `RETURNING` clause (`'*'` or an explicit column list) |
| `beforeQuery` | `(fn: (params: Record<string, unknown>) => Record<string, unknown>) => this` | Registers a parameter transform over the `p1…pN` filter parameters |
| `afterQuery` | `(fn: (records: F[]) => F[]) => this` | Registers a result transform that runs before records are returned |
| `execute` | `() => Promise<QueryResult<F> \| null>` | Executes the statement and resolves with the underlying query result |
| `executeReturnSingle` | `() => Promise<F \| null>` | Resolves with the first deleted row, or `null` when no row was deleted |
| `executeReturnAll` | `() => Promise<F[]>` | Resolves with all deleted rows |
| `executeReturnCount` | `() => Promise<number>` | Resolves with the number of deleted rows |

---

## Query Hooks

### What It Is

`beforeQuery` and `afterQuery` are the package's cross-cutting transformation points around execution. `beforeQuery` transforms the parameter map before the SQL is compiled; `afterQuery` transforms the result rows before they reach your code. They are available in two places: chained on any statement builder, or supplied as options to `executeQuery()`. Typical uses are normalizing inputs (lowercasing emails, hashing passwords), adapting TypeScript values to database formats, masking sensitive fields, and enriching rows with computed properties.

### How It Works

- **`beforeQuery(params)`** receives the parameter map before `yesql` compilation and returns the transformed map. On an INSERT the map is keyed by column name (`email`, `password_hash`); on an UPDATE, value parameters are `v_`-prefixed (`v_email`) and filter parameters are `p1…pN`; on a DELETE, parameters are `p1…pN`.
- **`afterQuery(records)`** receives the rows array after execution and before the result is returned. In `executeQuery()` it is only invoked when at least one row was returned — an empty result set short-circuits before the hook runs — so it can assume a non-empty array. On builders it runs as rows are extracted by `executeReturnSingle()` / `executeReturnAll()` (and the underlying `execute()`).
- **Errors propagate.** An exception thrown inside a hook rejects the operation exactly like a query error; inside a `withTransaction()` callback it triggers the automatic `ROLLBACK`.
- **Return new objects or mutate and return.** The returned value is what the next stage uses — returning a transformed copy keeps the hook pure; mutating the argument and returning it also works.

### Complete Example

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
    .values({ name: 'Grace Hopper', email: 'GRACE@EXAMPLE.COM', password_hash: 'plain-secret' })
    .beforeQuery((params) => {
      const transformed = { ...params };
      if (typeof transformed.email === 'string') {
        transformed.email = transformed.email.toLowerCase();
      }
      if (typeof transformed.password_hash === 'string') {
        transformed.password_hash = `hash(${transformed.password_hash})`;
      }
      return transformed;
    })
    .afterQuery((records) =>
      records.map((record) => {
        const safe = { ...record };
        delete safe.password_hash;
        return safe;
      })
    )
    .returning('*')
    .executeReturnSingle();

  if (created) {
    console.log(`Stored ${created.email} — hash hidden by the hook`);
  }
} finally {
  await db.disconnect();
}
```

The same transforms can be applied per call through `executeQuery()` options:

```typescript fragment
const result = await db.executeQuery<UserRow>(
  'SELECT id, name, email FROM users WHERE email = :email',
  { email: 'GRACE@EXAMPLE.COM' },
  {
    beforeQuery: (params) => ({ ...params, email: 'grace@example.com' }),
    afterQuery: (records) =>
      records.map((record) => ({ ...record, name: record.name.toUpperCase() })),
  }
);
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `builder.beforeQuery` | `(fn: (params: Record<string, unknown>) => Record<string, unknown>) => this` | Registers a parameter transform on any statement builder; runs before `yesql` compilation |
| `builder.afterQuery` | `(fn: (records: T[]) => T[]) => this` | Registers a result transform on any statement builder; runs before `executeReturn*` extraction |
| `ExecuteQueryOptions.beforeQuery` | `(params: Record<string, unknown>) => Record<string, unknown>` | Per-call parameter transform passed to `executeQuery()` |
| `ExecuteQueryOptions.afterQuery` | `(records: R[]) => R[]` | Per-call result transform passed to `executeQuery()`; skipped when the query returns no rows |

---

## Connection Lifecycle and Graceful Shutdown

### What It Is

The lifecycle layer is what turns a long-running process into a clean one: `disconnect()` closes the connection pool with a timeout-protected graceful path and a forceful fallback; the `isShuttingDown` flag rejects new work once shutdown begins; and the optional `enableGracefulShutdown` config registers process signal handlers for standalone applications.

### How It Works

- **`disconnect(timeoutMs = 10000)`** first sets `isShuttingDown = true`. From that moment, `executeQuery()` rejects with `Cannot execute query: database is shutting down` and `withTransaction()` rejects with `Cannot start transaction: database is shutting down`. It is safe to call on an instance that never executed a query.
- **Graceful path with a hard ceiling.** `disconnect()` races `pool.end()` against a timer. If the pool drains in time, its timer is cleared and the method resolves. If the timeout expires first, the forceful fallback runs: every pooled client is released with the driver's force flag (interrupting active queries if necessary) and the pool's internal client list is cleared, after which `disconnect()` resolves rather than rejecting. If ending the pool itself fails before the timeout, the error is rethrown.
- **The forceful fallback is a last resort.** Releasing clients forcefully may interrupt in-flight queries and transactions; the graceful path is designed to finish well within the default 10-second ceiling for a correctly written application.
- **`enableGracefulShutdown` (opt-in).** When enabled, the constructor registers `SIGINT` and `SIGTERM` handlers that log the signal, call `disconnect()`, and exit the process (`0` on success, `1` on failure). Leave it disabled when a framework such as `blendsdk/webafx` owns process shutdown — two sets of signal handlers conflict and produce unpredictable shutdown behavior. See [Configuration and Connection Pooling](#configuration-and-connection-pooling).

### Complete Example

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

await db.executeQuery('SELECT 1');

// Graceful shutdown with a 5-second ceiling; forced release afterwards if needed
await db.disconnect(5000);
console.log('Pool closed');

// Any operation after disconnect is rejected by the shutdown guard
try {
  await db.executeQuery('SELECT 1');
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message); // "Cannot execute query: database is shutting down"
  }
}
```

For standalone processes — never alongside a `WebApplication` from `blendsdk/webafx` — shutdown can be delegated to the adapter itself:

```typescript fragment
const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
  enableGracefulShutdown: true, // registers SIGINT/SIGTERM handlers
});
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `disconnect` | `(timeoutMs?: number) => Promise<void>` | Sets `isShuttingDown`, ends the pool, and force-releases clients if the timeout (default 10 000 ms) expires |
| `isShuttingDown` | `boolean` (protected) | Blocks new queries and transactions while `true` |
| `forceDisconnect` | `() => Promise<void>` (protected) | Last-resort fallback that releases every pooled client with the driver's force flag and clears the internal client list |
| `registerShutdownHandlers` | `() => void` (protected) | Wires `SIGINT`/`SIGTERM` → `disconnect()` → `process.exit()` when enabled |
| `enableGracefulShutdown` | `boolean` (config, default `false`) | Opt-in process signal handling for standalone usage outside of the web framework |

---

# postgresql Basic Usage

This guide takes you from installing the package to running queries, transactions, and statement builders — each step adding exactly one new concept to the previous one.

---

## Installation

Install the package with your preferred package manager:

**npm**

```bash
npm install blendsdk
```

**yarn**

```bash
yarn add blendsdk
```

**pnpm**

```bash
pnpm add blendsdk
```

The runtime dependencies — `blendsdk/dbcore`, `pg`, and `yesql` — are installed automatically; there are no peer dependencies to add manually.

Requirements:

- **Node.js >= 22.0.0**.
- **ESM only**: the package exposes a single ESM entry point, so use `import` syntax — `require()` is not supported.
- TypeScript in strict mode is recommended; the package ships its own type declarations.

Working inside the BlendSDK monorepo? Repository scripts use pnpm:

- `pnpm --filter blendsdk/postgresql build` — compile the package with `tsc`.
- `pnpm --filter blendsdk/postgresql test` — run the Vitest suite (manages a Docker-based PostgreSQL instance automatically).

---

## Quick Start

The minimal setup creates the adapter, runs one named-parameter query, and closes the pool:

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost', port: 5432, database: 'appdb', user: 'app', pass: 'secret',
});

const { records } = await db.executeQuery<{ answer: number }>(
  'SELECT :a::integer + :b::integer AS answer', { a: 40, b: 2 }
);
console.log(`answer = ${records[0].answer}`); // answer = 42
await db.disconnect();
```

Prerequisites: a reachable PostgreSQL server and a database matching the configured credentials. This snippet skips `try`/`finally` for brevity — in real code always close the pool. Each part is explained in the sections below.

---

## Fundamentals

The API is built in three layers: a database instance that owns the connection pool and executes queries, statement builders that construct structured statements, and hooks that transform parameters and results. The subsections below introduce one concept at a time.

The examples assume a reachable PostgreSQL server and three illustrative tables — `users (id, name, email, active, age, password_hash)`, `accounts (id, balance)`, and `sessions (user_id, status)`. Model the columns you use with small local interfaces, as shown; adapt the names to your own schema.

### Creating a Database Instance

`PostgreSQLDatabase` is the single entry point. Constructing it creates the adapter together with its `pg.Pool`; no connection is opened until the pool is first used, so the constructor succeeds even when the server is temporarily unreachable — the failure surfaces on the first query instead.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

// Creates the adapter and its connection pool — no connection is opened yet
const db = new PostgreSQLDatabase(config);

// The pool connects on first use and is closed here
await db.disconnect();
```

The `port` also accepts a numeric string — useful when reading configuration from environment variables:

```typescript fragment
const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: '5432', // coerced to 5432 with Number() in the constructor
  database: 'appdb',
  user: 'app',
  pass: 'secret',
});
```

### Running Your First Query

`executeQuery()` runs any SQL and returns the result. Statements are written with named placeholders (`:name`), which the `yesql` compiler translates into safe positional parameters — values are never concatenated into the query text.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
});

try {
  const { records } = await db.executeQuery<{ greeting: string }>(
    'SELECT :name AS greeting',
    { name: 'world' }
  );

  console.log(records[0].greeting); // world
} finally {
  await db.disconnect();
}
```

The generic parameter types the returned rows — `records[0].greeting` is a `string`. Queries with several parameters follow the same pattern; the local interface describes the rows you expect back:

```typescript fragment
interface UserRow {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

const { records } = await db.executeQuery<UserRow>(
  `SELECT id, name, email, active
     FROM users
    WHERE name = :name AND active = :active`,
  { name: "O'Reilly", active: true }
);

console.log(`Matched ${records.length} user(s)`);
```

Any input — including text such as `"'; DROP TABLE users; --"` — is passed to the server as a parameter value, never interpolated into the SQL, so it can only ever match as a literal string. For parameterless SQL, simply omit the `params` argument: `await db.executeQuery('SELECT 1')`.

### Reading the Query Result

`executeQuery<R>()` resolves to a `PostgreSQLQueryResult<R>` with three properties: `records`, `rowCount`, and `fields`.

```typescript
import { PostgreSQLDatabase, PostgreSQLQueryResult } from 'blendsdk/postgresql';

interface UserRow {
  id: number;
  name: string;
  active: boolean;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
});

try {
  const result: PostgreSQLQueryResult<UserRow> = await db.executeQuery<UserRow>(
    'SELECT 1 AS id, :name AS name, true AS active',
    { name: 'Ada' }
  );

  console.log(result.rowCount); // 1
  console.log(result.records[0].name); // Ada
  console.log(result.fields.map((field) => field.name).join(', ')); // id, name, active
} finally {
  await db.disconnect();
}
```

| Property | Type | Description |
| --- | --- | --- |
| `records` | `R[]` | Rows returned by the query, typed by the generic parameter. |
| `rowCount` | `number` | Number of rows returned (SELECT) or affected (INSERT/UPDATE/DELETE). |
| `fields` | `FieldDef[]` | Column metadata reported by the driver; an empty array when no rows are returned. |

Empty result sets are normalized — all three properties are empty rather than `undefined`:

```typescript fragment
const empty = await db.executeQuery<{ id: number }>(
  'SELECT id FROM users WHERE id = :id',
  { id: -1 }
);

console.log(empty.rowCount); // 0
console.log(empty.records); // []
console.log(empty.fields); // [] — field metadata is only present when rows are returned
```

### Selecting Rows with Builders

SELECT statements can also be built with the inherited `selectAll()` and `from()` factories instead of raw SQL. `selectAll(table)` produces a `SELECT *` statement; `from<T>(table)` starts a column-select statement.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id: number;
  name: string;
  email: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
});

try {
  // SELECT * FROM users
  const all = await db.selectAll('users').execute();
  console.log(`All users: ${all?.rowCount ?? 0}`);

  // SELECT id, name FROM users
  const partial = await db.from<UserRow>('users').select(['id', 'name']).execute();
  console.log(`Projected columns: ${partial?.rowCount ?? 0}`);
} finally {
  await db.disconnect();
}
```

`select()` accepts `'*'`, a column array, or an alias map that renames columns and can wrap computed expressions:

```typescript fragment
// SELECT id AS user_id, email AS contact_email FROM users
const aliased = await db
  .from<UserRow>('users')
  .select({ user_id: 'id', contact_email: 'email' })
  .execute();
```

### Grouping Work in Transactions

`withTransaction(fn)` runs a unit of work atomically: it issues `BEGIN`, executes your callback, then `COMMIT`s on success or `ROLLBACK`s when the callback throws. The callback receives the same database instance, so every statement executed through it — raw queries or builder operations — participates in the same transaction.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface BalanceRow {
  balance: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
});

try {
  const newBalance = await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(
      'UPDATE accounts SET balance = balance - :amount WHERE id = :id',
      { amount: 100, id: 1 }
    );

    // Re-read inside the transaction to enforce the overdraft rule
    const { records } = await txDb.executeQuery<BalanceRow>(
      'SELECT balance FROM accounts WHERE id = :id',
      { id: 1 }
    );

    if (Number(records[0].balance) < 0) {
      // Throwing rolls back the whole transaction, including the debit above
      throw new Error('insufficient funds');
    }

    await txDb.executeQuery(
      'UPDATE accounts SET balance = balance + :amount WHERE id = :id',
      { amount: 100, id: 2 }
    );

    return records[0].balance;
  });

  console.log(`Transfer committed — new balance: ${newBalance}`);
} catch (error) {
  if (error instanceof Error) {
    console.error(`Transfer rolled back: ${error.message}`);
  }
} finally {
  await db.disconnect();
}
```

Two rules keep transactions safe:

- **Use the callback argument.** Statements issued through `txDb` use the pinned client; statements issued through `db` outside the callback do not.
- **Treat the instance as busy.** Avoid parallel statements on the same instance and do not nest `withTransaction()` calls while a transaction is running.

The return value of the callback passes through unchanged, and statement builders execute inside the transaction when they are created from `txDb`:

```typescript fragment
const created = await db.withTransaction(async (txDb) =>
  txDb
    .insert<UserRow>('users')
    .values({ name: 'Ada Lovelace', email: 'ada@example.com' })
    .returning('*')
    .executeReturnSingle()
);
```

### Inserting Rows

`db.insert<T>(table)` returns a fluent INSERT builder. Each key passed to `.values()` becomes a column and a matching `:key` parameter; keys you omit are left to their database defaults.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
  active?: boolean;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
});

try {
  const created = await db
    .insert<UserRow>('users')
    .values({ name: 'Ada Lovelace', email: 'ada@example.com', active: true })
    .returning('*')
    .executeReturnSingle();

  if (created) {
    console.log(`Created user ${created.id} <${created.email}>`);
  }

  const inserted = await db
    .insert<UserRow>('users')
    .values({ name: 'Alan Turing', email: 'alan@example.com' })
    .executeReturnCount();

  console.log(`Inserted ${inserted} row(s)`);
} finally {
  await db.disconnect();
}
```

A statement ends with one of the execution methods:

| Terminator | Resolves with |
| --- | --- |
| `execute()` | the underlying query result (`records`, `rowCount`) — useful when you need the raw result |
| `executeReturnSingle()` | the first returned row (`T \| null`) — requires a `RETURNING` clause |
| `executeReturnAll()` | all returned rows (`T[]`) — requires a `RETURNING` clause |
| `executeReturnCount()` | the number of affected rows (`number`) |

Add `.returning('*')` or `.returning([...columns])` before the `executeReturn*` terminators so the database sends the written rows back:

```typescript fragment
const result = await db
  .insert<UserRow>('users')
  .values({ name: 'Grace Hopper', email: 'grace@example.com' })
  .returning(['id', 'name'])
  .execute();

console.log(result?.rowCount); // 1
```

Executing an INSERT builder without calling `.values()` throws instead of emitting invalid SQL — see [Error Handling](#error-handling).

### Updating Rows

`db.update<T, F>(table)` builds an UPDATE with a `SET` clause typed by `T` and a `WHERE` clause typed by `F`. Each key in `.values()` becomes `column = :v_column`, and the filter compiles into parameterized `WHERE` conditions.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

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
  age?: number;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
});

try {
  const deactivated = await db
    .update<UserRow, UserFilter>('users')
    .values({ active: false })
    .filter({ email: 'ada@example.com' })
    .returning(['id', 'email', 'active'])
    .executeReturnSingle();

  if (deactivated) {
    console.log(`Deactivated ${deactivated.email}`);
  }

  const affected = await db
    .update<UserRow, UserFilter>('users')
    .values({ active: true })
    .filter({ active: false })
    .executeReturnCount();

  console.log(`Reactivated ${affected} user(s)`);
} finally {
  await db.disconnect();
}
```

Values and filter parameters occupy separate namespaces, so updating and filtering on the same column can never collide. When you need a condition beyond simple equality, `.filterByExpression()` compiles a callback-built condition:

```typescript fragment
// Updates every user older than 65: "UPDATE users SET active = :v_active WHERE ..."
await db
  .update<UserRow, UserFilter>('users')
  .values({ active: false })
  .filterByExpression((q) => q.where('age').greaterThan(65))
  .execute();
```

⚠️ An empty filter — `.filter({})` or no `.filter()` call at all — updates **every row** in the table.

### Deleting Rows

`db.delete<F>(table)` builds a DELETE with a `WHERE` clause typed by `F` and the same `RETURNING` support. It has no `SET` clause, so it never requires values.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface SessionFilter {
  user_id?: number;
  status?: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
});

try {
  const removed = await db
    .delete<SessionFilter>('sessions')
    .filter({ status: 'expired' })
    .executeReturnCount();

  console.log(`Removed ${removed} expired session(s)`);

  const deleted = await db
    .delete<SessionFilter>('sessions')
    .filter({ user_id: 42 })
    .returning(['user_id', 'status'])
    .executeReturnAll();

  for (const session of deleted) {
    console.log(`Removed ${session.status} session for user ${session.user_id}`);
  }
} finally {
  await db.disconnect();
}
```

⚠️ As with UPDATE, an omitted or empty filter deletes **every row**:

```typescript fragment
// Deletes EVERY row: "DELETE FROM sessions"
await db.delete<SessionFilter>('sessions').filter({}).execute();
```

### Transforming Data with Hooks

`beforeQuery` transforms the parameter map before the SQL is compiled; `afterQuery` transforms the result rows before they reach your code. Chained on a statement builder, they cover the classic data-layer concerns: normalize inputs on the way in, mask sensitive fields on the way out.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
  password_hash?: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
});

try {
  const created = await db
    .insert<UserRow>('users')
    .values({ name: 'Grace Hopper', email: 'GRACE@EXAMPLE.COM', password_hash: 'plain-secret' })
    .beforeQuery((params) => {
      const transformed = { ...params };
      if (typeof transformed.email === 'string') {
        transformed.email = transformed.email.toLowerCase();
      }
      if (typeof transformed.password_hash === 'string') {
        transformed.password_hash = `hash(${transformed.password_hash})`;
      }
      return transformed;
    })
    .afterQuery((records) =>
      records.map((record) => {
        const safe = { ...record };
        delete safe.password_hash;
        return safe;
      })
    )
    .returning('*')
    .executeReturnSingle();

  if (created) {
    console.log(`Stored ${created.email} — password hash hidden by afterQuery`);
  }
} finally {
  await db.disconnect();
}
```

The same transforms can be supplied per call through `executeQuery()` options:

```typescript fragment
const { records } = await db.executeQuery<UserRow>(
  'SELECT id, name, email FROM users WHERE email = :email',
  { email: 'GRACE@EXAMPLE.COM' },
  {
    beforeQuery: (params) => ({ ...params, email: 'grace@example.com' }),
    afterQuery: (rows) => rows.map((row) => ({ ...row, name: row.name.toUpperCase() })),
  }
);
```

A hook that throws rejects the operation exactly like a query error — inside a transaction it triggers the automatic rollback.

### Closing the Connection

`disconnect()` sets the adapter's shutdown guard, drains the pool, and releases all clients. Call it when the application shuts down — typically in a `finally` block.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
});

await db.executeQuery('SELECT 1');

// Graceful close with a 5-second ceiling (default: 10000 ms)
await db.disconnect(5000);
console.log('Pool closed');

// The shutdown guard rejects any further work
try {
  await db.executeQuery('SELECT 1');
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message); // Cannot execute query: database is shutting down
  }
}
```

- If draining takes longer than the timeout, the remaining clients are force-released — which may interrupt in-flight queries — and `disconnect()` still resolves.
- `disconnect()` is safe on an instance that never executed a query.

For standalone processes — and **only** those — the adapter can handle SIGINT/SIGTERM itself:

```typescript fragment
const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
  enableGracefulShutdown: true, // registers SIGINT/SIGTERM handlers — standalone processes only
});
```

⚠️ **Warning:** do NOT enable `enableGracefulShutdown` when the database is managed by a `WebApplication` from `blendsdk/webafx`, which has its own SIGTERM/SIGINT handling. Registering both causes signal handler conflicts and unpredictable shutdown behavior.

---

## Configuration

All configuration is passed as a single `PostgreSQLConfig` object to the constructor. It extends `DatabaseConfig` from `blendsdk/dbcore` — the connection settings shared across the BlendSDK data stack — with PostgreSQL-specific pool tuning and lifecycle options. The constructor performs no validation: wrong credentials or an unreachable server surface as a rejected query, not as a construction error.

### Connection Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `host` | `string` | `'localhost'` (pg driver default) | Hostname of the PostgreSQL server. |
| `port` | `number \| string` | `5432` (pg driver default) | Server port. Numeric strings are coerced with `Number()` during construction. |
| `database` | `string` | — | Name of the database to connect to. |
| `user` | `string` | — | Database role used for authentication. |
| `pass` | `string` | — | Password; forwarded to the driver as its `password` option. |

### Pool and Lifecycle Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `poolConfig` | `PoolConfig` | `undefined` (pg driver defaults apply) | Optional tuning of the underlying `pg.Pool`; may be provided partially or omitted entirely. |
| `poolConfig.max` | `number` | `10` | Maximum number of clients in the pool. |
| `poolConfig.idleTimeoutMillis` | `number` | `30000` | Milliseconds a client may sit idle before it is closed. |
| `poolConfig.connectionTimeoutMillis` | `number` | `0` (no timeout) | Milliseconds to wait for a new client to connect before timing out. |
| `enableGracefulShutdown` | `boolean` | `false` | When `true`, registers SIGINT/SIGTERM handlers that close the pool and exit the process. |

⚠️ Do not enable `enableGracefulShutdown` when a `WebApplication` from `blendsdk/webafx` manages the database lifecycle — the framework already handles SIGTERM/SIGINT, and two sets of signal handlers conflict. See [Closing the Connection](#closing-the-connection).

### Complete Configuration

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

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

const db = new PostgreSQLDatabase(config);

try {
  const { rowCount } = await db.executeQuery('SELECT 1');
  console.log(`Query succeeded (${rowCount} row)`);
} finally {
  await db.disconnect();
}
```

### Environment-Based Configuration

A common pattern is to build the configuration object from environment variables:

```typescript fragment
const config: PostgreSQLConfig = {
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? 'appdb',
  user: process.env.PGUSER ?? 'app',
  pass: process.env.PGPASSWORD ?? 'secret',
};
```

---

## Error Handling

Failures come in two families:

1. **Adapter errors** — plain `Error` instances raised by the package itself (shutdown guards and builder validation). There are no custom error classes to `instanceof`; match them by their exact `message` when you need to.
2. **Driver errors** — failures propagated unchanged from the `pg` driver: connection problems, invalid SQL, constraint violations. They carry PostgreSQL diagnostics such as the SQLSTATE code.

### Adapter Errors

| Message | Raised when |
| --- | --- |
| `Cannot execute query: database is shutting down` | `executeQuery()` — or any statement execution — is called after `disconnect()` has begun. |
| `Cannot start transaction: database is shutting down` | `withTransaction()` is called after `disconnect()` has begun. |
| `No database connection available.` | Internal guard: a pooled client could not be acquired for an atomic query. |
| `Cannot build INSERT statement for table "<name>": no values provided. Call .values() with at least one column before executing.` | An INSERT builder is executed without `.values()`. |
| `Cannot build UPDATE statement for table "<name>": no values provided. Call .values() with at least one column before executing.` | An UPDATE builder is executed without `.values()`. |

### Driver Errors

Driver errors are `Error` instances with additional diagnostics. The reliable way to branch on a specific failure is the SQLSTATE `code`, not the message text.

| Property | Type | Description |
| --- | --- | --- |
| `message` | `string` | Human-readable error text from PostgreSQL. |
| `code` | `string` | SQLSTATE code — the stable identifier for the failure class. |
| `detail` | `string \| undefined` | Additional detail, e.g. which key already exists. |
| `constraint` | `string \| undefined` | Name of the violated constraint, when applicable. |
| `table` | `string \| undefined` | Table involved, when applicable. |

Common SQLSTATE codes you will meet early:

| Code | Name | Meaning |
| --- | --- | --- |
| `23505` | `unique_violation` | Duplicate value for a unique index or primary key. |
| `23503` | `foreign_key_violation` | A referenced row is missing, or a row is still referenced. |
| `23502` | `not_null_violation` | `NULL` inserted into a `NOT NULL` column. |
| `42P01` | `undefined_table` | The table does not exist. |
| `42601` | `syntax_error` | The SQL statement could not be parsed. |

### Recovery Guarantees

- **Failed queries release their client.** The connection returns to the pool in a `finally` block; the instance stays usable after an error.
- **Failed transactions roll back and rethrow.** `withTransaction()` attempts `ROLLBACK`, then rethrows the original error; the client is always released.
- **Hook failures propagate.** A throw inside `beforeQuery` or `afterQuery` rejects the operation like a query error and rolls back an enclosing transaction.
- **Cleanup failures never mask the original error.** Problems during rollback or client release are logged via `console.error`; the error you catch is the one that caused the failure.
- **`disconnect()` is timeout-protected.** After the timeout (default 10 000 ms) remaining clients are force-released and `disconnect()` resolves; only a pool-end failure before the timeout is rethrown.

### Complete Example

The following example inserts a user and handles both error families: a unique-constraint violation from the driver and any other failure.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
}

interface PgError extends Error {
  code?: string;
  constraint?: string;
}

function isPgError(error: unknown): error is PgError {
  if (!(error instanceof Error)) {
    return false;
  }
  const candidate: Partial<PgError> = error;
  return typeof candidate.code === 'string';
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
});

try {
  await db
    .insert<UserRow>('users')
    .values({ name: 'Ada Lovelace', email: 'ada@example.com' })
    .execute();
  console.log('Inserted');
} catch (error) {
  if (isPgError(error) && error.code === '23505') {
    console.warn(`Duplicate rejected by constraint "${error.constraint}"`);
  } else if (error instanceof Error) {
    console.error(`Database operation failed: ${error.message}`);
  } else {
    console.error('Database operation failed with a non-Error value:', error);
  }
} finally {
  await db.disconnect();
}
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
