> **Package**: `blendsdk/postgresql`

# postgresql Core Concepts

This document is a deep dive into the core concepts of `blendsdk/postgresql`. Each concept below is documented with a definition, an explanation of the underlying mechanism, a complete working example, and a reference table of its key members. For a high-level tour of the package, see the Overview.

| Concept | What it covers |
| --- | --- |
| [PostgreSQLDatabase](#postgresqldatabase) | The adapter class: pool ownership, query entry point, statement factories |
| [Configuration](#configuration) | `PostgreSQLConfig` and `PoolConfig` |
| [Query Execution](#query-execution) | `executeQuery()`, named parameters, typed results |
| [Transactions](#transactions) | `withTransaction()` — `BEGIN` / `COMMIT` / `ROLLBACK` |
| [INSERT Statements](#insert-statements) | `db.insert<T>()` and `PostgreSQLInsertStatement` |
| [UPDATE Statements](#update-statements) | `db.update<T, F>()` and `PostgreSQLUpdateStatement` |
| [DELETE Statements](#delete-statements) | `db.delete<F>()` and `PostgreSQLDeleteStatement` |
| [Query Hooks](#query-hooks) | `beforeQuery` / `afterQuery` on statements and queries |
| [Graceful Shutdown](#graceful-shutdown) | `disconnect()`, shutdown guards, signal handling |

---

## PostgreSQLDatabase

### What It Is

`PostgreSQLDatabase` is the central class of the package and the entry point for every database operation. It extends the abstract `Database` class from `blendsdk/dbcore`, implements its contract against the `pg` driver, and owns a `pg.Pool` that manages all connections. One instance represents exactly one configured PostgreSQL database.

### How It Works

- The constructor stores the configuration on `this.config` (provided by the base class) and creates the internal `pg.Pool` from `database`, `host`, `password` (mapped from `pass`), `port`, and `user`, applying any `poolConfig` overrides. The constructor does **not** open a connection — the pool connects lazily on first use, and a `PostgreSQLDatabase` can be constructed even while the server is unreachable (the first query surfaces the connection error).
- Two connection modes exist per instance:
  - **Standalone** — each `executeQuery()` call checks out one pooled client, runs a single statement, and releases the client.
  - **Transactional** — while a transaction is active, the client is pinned on `transactionClient` and reused by every query issued through the same instance.
- The `isShuttingDown` flag makes the instance fail fast once [shutdown](#graceful-shutdown) begins: new queries are rejected with `Cannot execute query: database is shutting down` and new transactions with `Cannot start transaction: database is shutting down`.
- Because it extends the base `Database` class, vendor-neutral helpers such as the `from()` / `selectAll()` SELECT builders (defined in `blendsdk/dbcore`) are also available on the same instance.
- `insert()`, `update()`, and `delete()` are factory methods that override the base versions so that PostgreSQL-specific statement classes are returned.

### Complete Example

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const { records, rowCount } = await db.executeQuery<{ server_time: Date }>(
      'SELECT now() AS server_time'
    );
    console.log(`Connected - ${rowCount} row, server time ${records[0].server_time.toISOString()}`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Key Methods & Properties

| Name | Type/Signature | Description |
| --- | --- | --- |
| `constructor` | `new PostgreSQLDatabase(config: PostgreSQLConfig)` | Creates the instance and initializes the internal `pg.Pool` |
| `config` | `PostgreSQLConfig` | The connection configuration, stored on the base `Database` class |
| `pool` | `Pool` (protected) | The underlying `pg.Pool` owned by this instance |
| `transactionClient` | `PoolClient \| null` (protected) | The client pinned while a transaction is active; `null` otherwise |
| `isShuttingDown` | `boolean` (protected) | `true` once `disconnect()` starts; blocks new queries and transactions |
| `executeQuery<R>()` | `<R>(query: string, params?: Record<string, any>, options?: ExecuteQueryOptions) => Promise<PostgreSQLQueryResult<R>>` | Executes one named-parameter query — [see Query Execution](#query-execution) |
| `withTransaction<T>()` | `<T>(fn: (db: this) => Promise<T>) => Promise<T>` | Runs a callback inside a transaction — [see Transactions](#transactions) |
| `connect()` | `() => Promise<PoolClient>` | Checks out a client from the connection pool |
| `disconnect()` | `(timeoutMs?: number) => Promise<void>` | Drains and closes the pool — [see Graceful Shutdown](#graceful-shutdown) |
| `insert<T>()` | `<T>(tableName: string) => InsertStatement<T>` | Creates a PostgreSQL INSERT builder |
| `update<T, F>()` | `<T, F>(tableName: string) => UpdateStatement<T, F>` | Creates a PostgreSQL UPDATE builder |
| `delete<F>()` | `<F>(tableName: string) => DeleteStatement<F>` | Creates a PostgreSQL DELETE builder |

---

## Configuration

### What It Is

`PostgreSQLConfig` describes everything the adapter needs to open and manage connections: the connection settings inherited from `DatabaseConfig` (`host`, `port`, `database`, `user`, `pass`, plus `poolConfig` and `enableGracefulShutdown`). The nested `PoolConfig` interface tunes the behavior of the underlying `pg.Pool`.

### How It Works

- The credential fields are passed straight to the `pg.Pool` constructor. The `pass` field is mapped to the driver's `password` option.
- `port` accepts both a `number` and a numeric `string` — the constructor coerces it with `Number(port)` and passes `undefined` when omitted.
- Every `poolConfig` property is optional and is forwarded only when set; omitting the entire object keeps the documented defaults (see the table below).
- `enableGracefulShutdown` is disabled by default. When set to `true`, the constructor registers `SIGINT` / `SIGTERM` handlers that call `disconnect()` automatically — [see Graceful Shutdown](#graceful-shutdown).

### Complete Example

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'db.internal',
  port: 5432,
  database: 'orders',
  user: 'orders_service',
  pass: 'secret',
  poolConfig: {
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  },
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const { records } = await db.executeQuery<{ server_version: string }>('SHOW server_version');
    console.log(`Connected to PostgreSQL ${records[0].server_version}`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Key Methods & Properties

`PostgreSQLConfig` (extends `DatabaseConfig` from `blendsdk/dbcore`):

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `host` | `string` | — | Hostname of the PostgreSQL server |
| `port` | `number \| string` | 5432 (driver default) | Server port; numeric strings are accepted and converted |
| `database` | `string` | — | Name of the database to connect to |
| `user` | `string` | — | Database username |
| `pass` | `string` | — | Database password (passed to the driver as `password`) |
| `poolConfig` | `PoolConfig` | `undefined` | Optional tuning options for the connection pool |
| `enableGracefulShutdown` | `boolean` | `false` | Registers `SIGINT` / `SIGTERM` handlers that call `disconnect()` |

`PoolConfig`:

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `max` | `number` | 10 | Maximum number of clients in the pool |
| `idleTimeoutMillis` | `number` | 30000 | Milliseconds a client may sit idle before being closed |
| `connectionTimeoutMillis` | `number` | 0 (no timeout) | Milliseconds to wait before timing out when connecting a new client |

---

## Query Execution

### What It Is

`executeQuery<R>()` executes a single SQL statement with named parameters (`:name` placeholders) and resolves to a `PostgreSQLQueryResult<R>` — a typed result containing the returned records, the row count, and the PostgreSQL column metadata.

### How It Works

1. If `isShuttingDown` is set, the call rejects immediately with `Cannot execute query: database is shutting down`.
2. If no transaction is active, a client is checked out from the pool for this one call (an *atomic* operation); inside a transaction, the pinned client is reused.
3. The optional `beforeQuery` option transforms the parameter object before translation ([see Query Hooks](#query-hooks)).
4. `yesql` converts the `:name` placeholders into positional parameters (`$1`, `$2`, …), so values are always safely bound — never concatenated into the SQL text.
5. The statement runs on the client. If `rowCount` is `0`, the method short-circuits and resolves to `{ records: [], rowCount: 0, fields: [] }` — an explicitly empty result set.
6. The optional `afterQuery` option transforms the result rows before they are returned.
7. If the client was checked out for this single call, it is released back to the pool.

### Complete Example

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase, PostgreSQLQueryResult } from 'blendsdk/postgresql';

interface Product {
  id: number;
  name: string;
  price: string;
  category: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'shop',
  user: 'shop_service',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const result: PostgreSQLQueryResult<Product> = await db.executeQuery<Product>(
      `SELECT id, name, price, category
         FROM products
        WHERE category = :category
          AND price <= :maxPrice
        ORDER BY price`,
      { category: 'books', maxPrice: 50 }
    );

    console.log(`Matched ${result.rowCount} product(s)`);
    console.log(`Columns: ${result.fields.map(field => field.name).join(', ')}`);

    for (const product of result.records) {
      console.log(`- ${product.name}: ${product.price}`);
    }

    const empty = await db.executeQuery<Product>(
      'SELECT id, name, price, category FROM products WHERE category = :category',
      { category: 'no-such-category' }
    );
    console.log(
      `Empty result -> records: ${empty.records.length}, rowCount: ${empty.rowCount}, fields: ${empty.fields.length}`
    );
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Key Methods & Properties

| Name | Type/Signature | Description |
| --- | --- | --- |
| `executeQuery` | `<R>(query: string, params?: Record<string, any>, options?: ExecuteQueryOptions) => Promise<PostgreSQLQueryResult<R>>` | Executes a named-parameter query with optional hooks |
| `PostgreSQLQueryResult.records` | `R[]` | Typed rows; an empty array when no rows are returned or affected |
| `PostgreSQLQueryResult.rowCount` | `number` | Rows returned (SELECT) or rows affected (INSERT / UPDATE / DELETE) |
| `PostgreSQLQueryResult.fields` | `FieldDef[]` | Column metadata from the driver; an empty array when `rowCount` is `0` |
| `FieldDef.name` | `string` | Column name in the result set |
| `FieldDef.dataTypeID` | `number` | PostgreSQL OID of the column's data type |
| `FieldDef.tableID` | `number` | OID of the source table (when applicable) |
| `FieldDef.columnID` | `number` | Attribute number of the source column (when applicable) |

Because values are bound as positional parameters, user input can never alter the query structure — the same mechanism that makes the parameter translation safe against SQL injection.

---

## Transactions

### What It Is

`withTransaction<T>(fn)` runs a callback inside a PostgreSQL transaction with automatic `BEGIN`, `COMMIT`, and `ROLLBACK` handling. The callback receives the same database instance, so every statement issued through it participates in the transaction.

### How It Works

1. If `isShuttingDown` is set, the call rejects with `Cannot start transaction: database is shutting down`.
2. If no transaction is active, one client is checked out from the pool and pinned on `transactionClient` for the entire transaction; every query inside the callback reuses this client instead of checking out new ones.
3. `BEGIN` is issued, the callback runs, and `COMMIT` is issued on success. The transaction function's return value is passed through to the caller.
4. If the callback throws, `ROLLBACK` is attempted (only if the transaction was not already committed) and the **original error is rethrown**. Errors during the rollback itself are logged, not thrown.
5. A `finally` block always releases the client back to the pool and resets `transactionClient` to `null`.
6. ⚠️ Transactions are not re-entrant. Do not call `withTransaction()` from inside a running transaction callback — an inner call would issue `BEGIN` / `COMMIT` on the same pinned client and release it, ending the outer transaction prematurely. Issue all work through the callback's database instance instead.

### Complete Example

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface AccountRow {
  id: number;
  balance: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'banking',
  user: 'banking_service',
  pass: 'secret',
};

async function transfer(
  db: PostgreSQLDatabase,
  fromAccountId: number,
  toAccountId: number,
  amount: number
): Promise<void> {
  await db.withTransaction(async transactionDb => {
    const debit = await transactionDb.executeQuery<AccountRow>(
      `UPDATE accounts
          SET balance = balance - :amount
        WHERE id = :accountId AND balance >= :amount
        RETURNING id, balance`,
      { amount, accountId: fromAccountId }
    );

    if (debit.rowCount === 0) {
      throw new Error(`Insufficient funds on account ${fromAccountId}`);
    }

    await transactionDb.executeQuery(
      'UPDATE accounts SET balance = balance + :amount WHERE id = :accountId',
      { amount, accountId: toAccountId }
    );
  });
}

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    await transfer(db, 1, 2, 100);
    console.log('Transfer committed');
  } catch (error) {
    console.error('Transfer failed and was rolled back:', error);
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Key Methods & Properties

| Name | Type/Signature | Description |
| --- | --- | --- |
| `withTransaction` | `<T>(fn: (db: this) => Promise<T>) => Promise<T>` | Runs `fn` inside a transaction; resolves with `fn`'s return value |
| `transactionClient` | `PoolClient \| null` (protected) | The pinned client while the transaction runs; `null` outside of transactions |
| Guard error | `Error` | `Cannot start transaction: database is shutting down` — thrown when shutdown has started |
| Rollback semantics | — | On failure the transaction is rolled back and the original error is rethrown |

---

## INSERT Statements

### What It Is

`PostgreSQLInsertStatement<TableType>` is the PostgreSQL implementation of the shared `InsertStatement` builder. It is created through `db.insert<T>(tableName)` and renders parameterized `INSERT` statements of the form `INSERT INTO table (cols) VALUES (:cols) [RETURNING ...]`.

### How It Works

- The class overrides only the two protected extension points of the base class: `buildQuery()` renders the SQL, and `buildParameters()` returns the values object unchanged.
- `values()` stores the column/value pairs. Each column key becomes a named parameter with the same name as the column (`name` → `:name`), so the returned parameter object is keyed by column name.
- `buildQuery()` throws if no values were provided: `Cannot build INSERT statement for table "users": no values provided. Call .values() with at least one column before executing.`
- `returning()` appends a `RETURNING` clause. The terminal `executeReturnSingle()` / `executeReturnAll()` methods only yield row data when a `RETURNING` clause is present; `executeReturnCount()` works regardless (it reports the affected row count).
- Everything else — the fluent API (`values`, `returning`, `beforeQuery`, `afterQuery`) and the terminal `execute*` methods — is inherited from `blendsdk/dbcore`.

### Complete Example

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  age?: number;
  created_at?: Date;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const created = await db
      .insert<User>('users')
      .values({ name: 'Ada Lovelace', email: 'ada@example.com', age: 36 })
      .returning('*')
      .executeReturnSingle();

    if (created !== null) {
      console.log(`Inserted user #${created.id} (${created.email})`);
    }

    const insertedCount = await db
      .insert<User>('users')
      .values({ name: 'Grace Hopper', email: 'grace@example.com' })
      .executeReturnCount();

    console.log(`Rows inserted: ${insertedCount}`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Key Methods & Properties

| Name | Type/Signature | Description |
| --- | --- | --- |
| `db.insert<T>()` | `<T>(tableName: string) => InsertStatement<T>` | Factory that returns a `PostgreSQLInsertStatement<T>` |
| `values` | `(values: Partial<T>) => this` | Sets the column/value pairs; each key becomes a `:columnName` parameter |
| `returning` | `(columns: '*' \| (keyof T)[]) => this` | Appends a `RETURNING` clause — required for `executeReturn*` to yield record data |
| `beforeQuery` | `(hook: (params) => params) => this` | Parameter transform hook — [see Query Hooks](#query-hooks) |
| `afterQuery` | `(hook: (rows) => rows) => this` | Result transform hook — [see Query Hooks](#query-hooks) |
| `execute` | `() => Promise<QueryResult<T>>` | Executes the statement and resolves with the query result |
| `executeReturnSingle` | `() => Promise<T \| null>` | Executes and returns the first record, or `null` when nothing was returned |
| `executeReturnAll` | `() => Promise<T[]>` | Executes and returns all returned records |
| `executeReturnCount` | `() => Promise<number>` | Executes and returns the number of affected rows |
| `buildQuery` | `() => string` (protected) | Renders the SQL; throws when no values were provided |
| `buildParameters` | `() => { [key: string]: any }` (protected) | Returns the values object as named parameters |

---

## UPDATE Statements

### What It Is

`PostgreSQLUpdateStatement<TableType, FilterType>` is the PostgreSQL implementation of the shared `UpdateStatement` builder. It is created through `db.update<T, F>(tableName)` and renders parameterized `UPDATE` statements of the form `UPDATE table SET col = :v_col ... [WHERE ...] [RETURNING ...]`.

### How It Works

- The class overrides `buildQuery()` and `buildParameters()`. The `SET` clause is generated from the values object, where each column becomes an assignment with a **`v_`-prefixed** parameter (`name = :v_name`).
- The `WHERE` clause comes from `.filter(criteria)` or `.filterByExpression(build)` and is rendered from the compiled expression of `blendsdk/expression`. WHERE-clause parameters are named `p1`, `p2`, and so on. The `v_` prefix guarantees that SET values and WHERE parameters can never collide — for example, `values({ active: true }).filter({ active: false })` produces `v_active` and `p1` as separate parameters.
- The compiled expression is cached per statement, so rendering the query and its parameters does not compile the filter twice.
- `buildQuery()` throws if no values were provided: `Cannot build UPDATE statement for table "users": no values provided. Call .values() with at least one column before executing.`
- ⚠️ Without a filter (or with an empty filter object), the statement has no `WHERE` clause and updates **every row** in the table.

### Complete Example

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  age?: number;
  active?: boolean;
}

interface UserFilter {
  id?: number;
  email?: string;
  age?: number;
  active?: boolean;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const updated = await db
      .update<User, UserFilter>('users')
      .values({ active: false })
      .filter({ email: 'ada@example.com' })
      .returning('*')
      .executeReturnSingle();

    if (updated !== null) {
      console.log(`User #${updated.id} active=${String(updated.active)}`);
    }

    const staleCount = await db
      .update<User, UserFilter>('users')
      .values({ active: false })
      .filterByExpression(q => q.where('age').greaterThan(90))
      .executeReturnCount();

    console.log(`Accounts deactivated: ${staleCount}`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Key Methods & Properties

| Name | Type/Signature | Description |
| --- | --- | --- |
| `db.update<T, F>()` | `<T, F>(tableName: string) => UpdateStatement<T, F>` | Factory that returns a `PostgreSQLUpdateStatement<T, F>` |
| `values` | `(values: Partial<T>) => this` | Sets the `SET` assignments; each key becomes a `:v_columnName` parameter |
| `filter` | `(criteria: F) => this` | Builds the `WHERE` clause from equality conditions; parameters are named `p1`, `p2`, … |
| `filterByExpression` | `(build: (query) => CompiledExpression) => this` | Builds the `WHERE` clause with the `blendsdk/expression` builder; compiled once and cached |
| `returning` | `(columns: '*' \| (keyof T)[]) => this` | Appends a `RETURNING` clause |
| `beforeQuery` | `(hook: (params) => params) => this` | Parameter transform hook — [see Query Hooks](#query-hooks) |
| `afterQuery` | `(hook: (rows) => rows) => this` | Result transform hook — [see Query Hooks](#query-hooks) |
| `execute` | `() => Promise<QueryResult<T>>` | Executes the statement and resolves with the query result |
| `executeReturnSingle` | `() => Promise<T \| null>` | Executes and returns the first updated record, or `null` |
| `executeReturnAll` | `() => Promise<T[]>` | Executes and returns all updated records |
| `executeReturnCount` | `() => Promise<number>` | Executes and returns the number of updated rows |
| `buildQuery` | `() => string` (protected) | Renders the SQL; throws when no values were provided |
| `buildParameters` | `() => { [key: string]: any }` (protected) | Returns the merged `v_`-prefixed value parameters and WHERE parameters |

---

## DELETE Statements

### What It Is

`PostgreSQLDeleteStatement<FilterType>` is the PostgreSQL implementation of the shared `DeleteStatement` builder. It is created through `db.delete<F>(tableName)` and renders parameterized `DELETE` statements of the form `DELETE FROM table [WHERE ...] [RETURNING ...]`.

### How It Works

- The class overrides `buildQuery()` and `buildParameters()`. A DELETE statement has no values — only an optional `WHERE` clause (from `.filter()` or `.filterByExpression()`) and an optional `RETURNING` clause.
- The `WHERE` clause is rendered from the compiled expression and its parameters are named `p1`, `p2`, …; the compiled expression is cached per statement so `buildQuery()` and `buildParameters()` reuse the same compilation.
- ⚠️ Without a filter (or with an empty filter object, e.g. `.filter({})`), the statement is a bulk delete: `DELETE FROM users` with no `WHERE` clause removes **every row** in the table. Always double-check the filter before executing.
- `returning('*')` combined with the terminal `executeReturn*` methods lets you capture the deleted rows: `executeReturnSingle()` resolves to the deleted record (or `null`), `executeReturnAll()` to all deleted records, and `executeReturnCount()` to the number of deleted rows.

### Complete Example

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name?: string;
  email?: string;
  active?: boolean;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const deleted = await db
      .delete<User>('users')
      .filter({ email: 'ada@example.com' })
      .returning('*')
      .executeReturnSingle();

    if (deleted !== null) {
      console.log(`Deleted user #${deleted.id}: ${deleted.email}`);
    }

    const purgedCount = await db
      .delete<User>('users')
      .filter({ active: false })
      .executeReturnCount();

    console.log(`Purged ${purgedCount} inactive account(s)`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Key Methods & Properties

| Name | Type/Signature | Description |
| --- | --- | --- |
| `db.delete<F>()` | `<F>(tableName: string) => DeleteStatement<F>` | Factory that returns a `PostgreSQLDeleteStatement<F>` |
| `filter` | `(criteria: F) => this` | Builds the `WHERE` clause; parameters are named `p1`, `p2`, … |
| `filterByExpression` | `(build: (query) => CompiledExpression) => this` | Builds the `WHERE` clause with the `blendsdk/expression` builder; compiled once and cached |
| `returning` | `(columns: '*' \| (keyof F)[]) => this` | Appends a `RETURNING` clause to retrieve deleted row data |
| `beforeQuery` | `(hook: (params) => params) => this` | Parameter transform hook — [see Query Hooks](#query-hooks) |
| `afterQuery` | `(hook: (rows) => rows) => this` | Result transform hook — [see Query Hooks](#query-hooks) |
| `execute` | `() => Promise<QueryResult<F>>` | Executes the statement and resolves with the query result |
| `executeReturnSingle` | `() => Promise<F \| null>` | Executes and returns the first deleted record, or `null` |
| `executeReturnAll` | `() => Promise<F[]>` | Executes and returns all deleted records |
| `executeReturnCount` | `() => Promise<number>` | Executes and returns the number of deleted rows |
| `buildQuery` | `() => string` (protected) | Renders the SQL (`DELETE FROM ... [WHERE ...] [RETURNING ...]`) |
| `buildParameters` | `() => { [key: string]: any }` (protected) | Returns the WHERE-clause parameters from the cached compiled expression |

---

## Query Hooks

### What It Is

Query hooks are transformation callbacks that plug into the execution pipeline without subclassing: `beforeQuery` transforms the parameter object immediately before the SQL runs, and `afterQuery` transforms the result rows immediately after it runs. Both are available in two places — on every statement builder, and as options of `executeQuery()`.

### How It Works

- **`beforeQuery(params)`** receives the fully built parameter object — *after* the builder produced it, but *before* `yesql` converts the named placeholders into positional parameters. It must return the parameter object to execute with.
- **`afterQuery(rows)`** receives the raw row array returned by the driver and must return an array. It runs before the result is assembled, so the terminal methods (`executeReturnSingle`, `executeReturnAll`) see the transformed rows.
- Parameter names inside `beforeQuery` depend on the statement type:
  - **INSERT** — keyed by column name (e.g. `params.email`).
  - **UPDATE** — SET values are prefixed with `v_` (e.g. `params.v_password_hash`); WHERE-clause parameters are named `p1`, `p2`, ….
  - **DELETE** — WHERE-clause parameters are named `p1`, `p2`, …. Note these indices depend on the filter key order, so hooks on DELETE filters are usually written defensively.
- Hooks execute inside the normal error path: an exception thrown in a hook aborts the statement, propagates to the caller, and — when inside a [transaction](#transactions) — triggers the rollback.
- As `executeQuery` options, the hooks behave identically: `options.beforeQuery` runs before parameter translation and `options.afterQuery` runs on the rows before the result is resolved.

### Complete Example

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  password_hash?: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const created = await db
      .insert<User>('users')
      .values({
        name: 'Ada Lovelace',
        email: 'ADA@EXAMPLE.COM',
        password_hash: 'plaintext-secret',
      })
      .beforeQuery((params: Record<string, unknown>) => {
        const email = params.email;
        if (typeof email === 'string') {
          params.email = email.toLowerCase();
        }
        const passwordHash = params.password_hash;
        if (typeof passwordHash === 'string') {
          params.password_hash = `hashed(${passwordHash})`;
        }
        return params;
      })
      .afterQuery((records: User[]) =>
        records.map(record => {
          const safe = { ...record };
          delete safe.password_hash;
          return safe;
        })
      )
      .returning('*')
      .executeReturnSingle();

    console.log('Created user with redacted hash:', created);

    const { records } = await db.executeQuery<User>(
      'SELECT id, name, email FROM users WHERE email = :email',
      { email: 'ADA@EXAMPLE.COM' },
      {
        beforeQuery: (params: Record<string, unknown>) => ({
          ...params,
          email: String(params.email).toLowerCase(),
        }),
        afterQuery: (rows: User[]) =>
          rows.map(row => ({ ...row, name: row.name.trim().toUpperCase() })),
      }
    );

    console.log(`Found ${records.length} matching user(s):`);
    for (const user of records) {
      console.log(`- ${user.name}`);
    }
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Key Methods & Properties

| Name | Type/Signature | Available on | Description |
| --- | --- | --- | --- |
| `beforeQuery` | `(hook: (params) => params) => this` | All statement builders | Runs after parameter building and before `yesql` translation |
| `afterQuery` | `(hook: (rows) => rows) => this` | All statement builders | Runs on the driver rows before the result is assembled |
| `options.beforeQuery` | `(params) => params` | `executeQuery()` | Same semantics as the statement hook |
| `options.afterQuery` | `(rows) => rows` | `executeQuery()` | Same semantics as the statement hook |
| `v_` prefix | — | UPDATE statements | SET values appear in `beforeQuery` as `v_<column>` |
| `p1`, `p2`, … | — | UPDATE / DELETE statements | WHERE-clause parameters generated by the expression compiler |

---

## Graceful Shutdown

### What It Is

Graceful shutdown is the controlled teardown of the connection pool: `disconnect(timeoutMs = 10000)` drains and closes the pool with timeout protection, an internal flag (`isShuttingDown`) rejects new work while shutdown is in progress, and the opt-in `enableGracefulShutdown` config option wires `disconnect()` to the process signals.

### How It Works

1. `disconnect()` first sets `isShuttingDown = true`. From this point on, new `executeQuery()` calls reject with `Cannot execute query: database is shutting down` and new `withTransaction()` calls with `Cannot start transaction: database is shutting down`.
2. The graceful path calls `pool.end()`, which waits for checked-out clients to be returned, and clears the timeout when it resolves.
3. If the close takes longer than `timeoutMs`, the adapter force-releases the remaining clients using the driver's internal client list and resolves instead of hanging. If the pool close itself fails, the error is rethrown.
4. When `enableGracefulShutdown` is `true`, the constructor registers `SIGINT` / `SIGTERM` handlers that log the signal, call `disconnect()`, and exit the process with code `0` on success or `1` on failure.
5. ⚠️ Do **not** enable `enableGracefulShutdown` when the database is owned by a `blendsdk/webafx` WebApplication — that framework installs its own `SIGINT` / `SIGTERM` handling, and enabling both causes signal-handler conflicts and unpredictable shutdown behavior. Only enable it for standalone database usage.

### Complete Example

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
  // Only for standalone usage: blendsdk/webafx WebApplication installs its own
  // SIGINT/SIGTERM handling, and enabling both causes signal-handler conflicts.
  enableGracefulShutdown: true,
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const { records } = await db.executeQuery<{ alive: boolean }>('SELECT true AS alive');
    console.log(`Database reachable: ${records[0].alive}`);
  } finally {
    // Drain the pool, forcing release of stuck clients after 5000 ms
    await db.disconnect(5000);
  }
}

void main();
```

### Key Methods & Properties

| Name | Type/Signature | Description |
| --- | --- | --- |
| `disconnect` | `(timeoutMs?: number) => Promise<void>` | Starts shutdown, drains the pool, and force-releases clients after the timeout (default `10000` ms) |
| `isShuttingDown` | `boolean` (protected) | Set when shutdown begins; makes queries and transactions fail fast |
| `forceDisconnect` | `() => Promise<void>` (protected) | Force-releases all remaining clients; last resort when the graceful close times out |
| `registerShutdownHandlers` | `() => void` (protected) | Registers the `SIGINT` / `SIGTERM` handlers; called only when `enableGracefulShutdown` is `true` |
| `enableGracefulShutdown` | `boolean` (config, default `false`) | Opt-in automatic shutdown on process signals |
| Query guard | `Error` | `Cannot execute query: database is shutting down` |
| Transaction guard | `Error` | `Cannot start transaction: database is shutting down` |

---

For hands-on patterns built on these concepts — a first connection, everyday query flows, and builder-driven workflows — continue with Basic Usage.

---

# postgresql Basic Usage

This guide takes you from installation to a working first query and the five everyday building blocks of the package: parameterized queries, typed results, transactions, statement builders, and clean shutdown. For the conceptual background behind each piece, see the Overview and Core Concepts.

---

## Installation

Install the package with npm:

```bash
npm install blendsdk/postgresql
```

Or with Yarn:

```bash
yarn add blendsdk/postgresql
```

All runtime dependencies are installed automatically — `blendsdk/dbcore` (the shared database contracts), `pg` (the PostgreSQL driver and connection pool), and `yesql` (named-parameter translation). There is nothing else to add.

> If your project consumes the full BlendSDK umbrella distribution, `npm install blendsdk` installs this package together with the rest of the `blendsdk/*` suite.

### Requirements

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | `>= 22.0.0` | Runtime target of all `blendsdk/*` packages |
| TypeScript | 5.x | Strict mode is assumed in every example |
| PostgreSQL server | Any version supported by `pg` `^8.22.0` | Connection details go into `PostgreSQLConfig` |
| Module system | ESM | The package is ESM-only — always use `import`, never `require()` |

Because the package is ESM-only, your project should either set `"type": "module"` in `package.json` or use `.mts` files, and your `tsconfig.json` should use `"module": "NodeNext"` with `"moduleResolution": "NodeNext"` so the ESM exports resolve correctly.

---

## Quick Start

Create a database instance, run one parameterized query, and disconnect:

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost', port: 5432, database: 'appdb', user: 'appuser', pass: 'secret',
};

const db = new PostgreSQLDatabase(config);
const { records, rowCount } = await db.executeQuery<{ message: string }>(
  'SELECT :message AS message',
  { message: 'hello from BlendSDK' }
);
console.log(`Got ${rowCount} row(s):`, records[0].message);

await db.disconnect();
```

Three things to note about this snippet:

- The constructor does **not** connect — the internal connection pool opens its first connection when the query runs, so an instance can be created even while the server is unreachable (the error surfaces on the first query instead).
- `:message` is a **named parameter**. The value is bound as a positional parameter by `yesql` and never concatenated into the SQL text.
- `executeQuery<{ message: string }>()` gives you a typed `records` array — the generic describes the shape of one returned row.

(Top-level `await` is used throughout this guide; it is available by default because the package is ESM-only.)

---

## Fundamentals

Everything in this package flows through a single `PostgreSQLDatabase` instance. The table below maps the everyday tasks to their APIs — each following subsection introduces one of them with a complete, runnable example.

| Task | API | Subsection |
| --- | --- | --- |
| Create a connection pool | `new PostgreSQLDatabase(config)` | [1. Creating a Database Instance](#1-creating-a-database-instance) |
| Run a parameterized query | `db.executeQuery<R>()` | [2. Running Parameterized Queries](#2-running-parameterized-queries) |
| Read typed results | `PostgreSQLQueryResult<R>` | [3. Reading Typed Results](#3-reading-typed-results) |
| Group statements atomically | `db.withTransaction<T>()` | [4. Transactions](#4-transactions) |
| Insert / update / delete rows | `db.insert<T>()` / `db.update<T, F>()` / `db.delete<F>()` | [5](#5-inserting-rows)–[7](#7-deleting-rows) |
| Transform data in flight | `beforeQuery` / `afterQuery` hooks | [8. Transforming Data with Hooks](#8-transforming-data-with-hooks) |
| Release resources | `db.disconnect()` | [9. Disconnecting Cleanly](#9-disconnecting-cleanly) |

---

### 1. Creating a Database Instance

One `PostgreSQLDatabase` instance represents one configured database and owns one `pg.Pool`. Create it once, share it across your application, and let the pool multiplex every query over its connections.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

// No connection has been opened yet — the pool connects lazily on first use.
console.log(`Ready to query database "${config.database}"`);
```

The credentials are passed straight to the driver: `pass` becomes the driver's `password` option, and `port` accepts both a `number` and a numeric `string` (it is converted internally with `Number(port)`). Tuning the pool itself is covered in [Configuration](#configuration).

---

### 2. Running Parameterized Queries

`executeQuery<R>(sql, params?)` runs a single SQL statement with `:name` placeholders and resolves to a typed result. Every placeholder is turned into a safe positional parameter, so user input can never alter the query's structure.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface Product {
  id: number;
  name: string;
  price: string;
  category: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'shop',
  user: 'shop_service',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const { records, rowCount } = await db.executeQuery<Product>(
      `SELECT id, name, price, category
         FROM products
        WHERE category = :category
          AND price <= :maxPrice
        ORDER BY price`,
      { category: 'books', maxPrice: 50 }
    );

    console.log(`Found ${rowCount} product(s):`);
    for (const product of records) {
      console.log(`- ${product.name} (${product.price})`);
    }
  } finally {
    await db.disconnect();
  }
}

void main();
```

A few details worth knowing upfront:

- `numeric` / `DECIMAL` columns (like `price` above) are returned as **strings** by the driver, and `timestamp` columns are returned as `Date` objects — type your row interfaces accordingly.
- If the statement matches no rows, the result is explicitly empty: `{ records: [], rowCount: 0, fields: [] }`.

**Next level** — independent queries can run concurrently. When no transaction is active, each `executeQuery()` checks out its own connection from the pool:

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'shop',
  user: 'shop_service',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    // The pool checks out one connection per query (up to poolConfig.max).
    const [users, products] = await Promise.all([
      db.executeQuery<{ id: number }>('SELECT id FROM users WHERE active = :active', {
        active: true,
      }),
      db.executeQuery<{ id: number }>('SELECT id FROM products WHERE in_stock = :inStock', {
        inStock: true,
      }),
    ]);

    console.log(`Active users: ${users.rowCount}, in-stock products: ${products.rowCount}`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

### 3. Reading Typed Results

Every query resolves to a `PostgreSQLQueryResult<R>` with three members: `records` (the typed rows), `rowCount` (rows returned or affected), and `fields` (PostgreSQL column metadata such as column names).

```typescript
import {
  PostgreSQLConfig,
  PostgreSQLDatabase,
  PostgreSQLQueryResult,
} from 'blendsdk/postgresql';

interface User {
  id: number;
  name: string;
  email: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const result: PostgreSQLQueryResult<User> = await db.executeQuery<User>(
      'SELECT id, name, email FROM users ORDER BY id LIMIT :limit',
      { limit: 10 }
    );

    console.log(`rows: ${result.rowCount}`);
    console.log(`columns: ${result.fields.map(field => field.name).join(', ')}`);
    for (const user of result.records) {
      console.log(`#${user.id} ${user.name} <${user.email}>`);
    }

    // A query that matches nothing resolves to an explicitly empty result.
    const empty = await db.executeQuery<User>(
      'SELECT id, name, email FROM users WHERE id = :id',
      { id: -1 }
    );
    console.log(
      `No match -> records: ${empty.records.length}, rowCount: ${empty.rowCount}, fields: ${empty.fields.length}`
    );
  } finally {
    await db.disconnect();
  }
}

void main();
```

Because the result short-circuits to `{ records: [], rowCount: 0, fields: [] }` when `rowCount` is `0`, you can always iterate `records` without a null check — an empty match is simply an empty array.

| Member | Type | Description |
| --- | --- | --- |
| `records` | `R[]` | Typed rows; empty when nothing was returned |
| `rowCount` | `number` | Rows returned (SELECT) or rows affected (INSERT / UPDATE / DELETE) |
| `fields` | `FieldDef[]` | Column metadata from the driver (`name`, `dataTypeID`, …) |

---

### 4. Transactions

`withTransaction<T>(fn)` wraps a callback in `BEGIN` / `COMMIT` / `ROLLBACK`. Every statement issued through the callback's database instance (`txDb`) runs on the same pinned connection, and if anything throws, the transaction is rolled back and the original error is rethrown.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface Account {
  id: number;
  balance: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'banking',
  user: 'banking_service',
  pass: 'secret',
};

async function transfer(
  db: PostgreSQLDatabase,
  fromAccountId: number,
  toAccountId: number,
  amount: number
): Promise<void> {
  await db.withTransaction(async txDb => {
    const debit = await txDb.executeQuery<Account>(
      `UPDATE accounts
          SET balance = balance - :amount
        WHERE id = :accountId AND balance >= :amount
        RETURNING id, balance`,
      { amount, accountId: fromAccountId }
    );

    if (debit.rowCount === 0) {
      throw new Error(`Insufficient funds on account ${fromAccountId}`);
    }

    await txDb.executeQuery(
      'UPDATE accounts SET balance = balance + :amount WHERE id = :accountId',
      { amount, accountId: toAccountId }
    );
  });
}

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    await transfer(db, 1, 2, 100);
    console.log('Transfer committed');
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Transfer rolled back: ${error.message}`);
    }
  } finally {
    await db.disconnect();
  }
}

void main();
```

The callback's return value passes straight through — `const newBalance = await db.withTransaction(async txDb => { /* ... */ return balance; })` resolves with that value after a successful `COMMIT`.

> ⚠️ Transactions are not re-entrant. Never call `withTransaction()` from inside a running transaction callback — issue all work through `txDb` instead. An inner call would `COMMIT` on the same pinned connection and end the outer transaction prematurely.

---

### 5. Inserting Rows

`db.insert<T>(tableName)` returns a fluent INSERT builder. Each key you pass to `.values()` becomes a named parameter with the same name as the column (`name` → `:name`). Use `executeReturnCount()` for the affected row count, or add `.returning('*')` when you need the generated columns back.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  age?: number;
  created_at?: Date;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    // Simplest form: insert and take the affected row count.
    const insertedCount = await db
      .insert<User>('users')
      .values({ name: 'Grace Hopper', email: 'grace@example.com' })
      .executeReturnCount();
    console.log(`Inserted ${insertedCount} row(s)`);

    // Next level: RETURNING hands back database-generated columns.
    const created = await db
      .insert<User>('users')
      .values({ name: 'Ada Lovelace', email: 'ada@example.com', age: 36 })
      .returning('*')
      .executeReturnSingle();

    if (created !== null) {
      console.log(`Inserted user #${created.id} (${created.email})`);
    }
  } finally {
    await db.disconnect();
  }
}

void main();
```

> The builder throws if you execute it without values: `Cannot build INSERT statement for table "users": no values provided. Call .values() with at least one column before executing.`

Without a `RETURNING` clause, `executeReturnSingle()` and `executeReturnAll()` have nothing to hand back — use `executeReturnCount()` or `execute()` when you only need confirmation.

---

### 6. Updating Rows

`db.update<T, F>(tableName)` follows the same pattern, with `.values()` for the `SET` assignments and `.filter()` for the `WHERE` clause. Internally, value parameters are prefixed with `v_` (`active = :v_active`), so they can never collide with the filter's `p1`, `p2`, … parameters.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
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
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const updated = await db
      .update<User, UserFilter>('users')
      .values({ active: false })
      .filter({ email: 'ada@example.com' })
      .returning(['id', 'email', 'active'])
      .executeReturnSingle();

    if (updated !== null) {
      console.log(`User #${updated.id} is now active=${String(updated.active)}`);
    }

    const count = await db
      .update<User, UserFilter>('users')
      .values({ name: 'Grace M. Hopper' })
      .filter({ email: 'grace@example.com' })
      .executeReturnCount();
    console.log(`Rows updated: ${count}`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

> ⚠️ Without a `.filter()` call (or with an empty filter object), the UPDATE has **no `WHERE` clause and updates every row in the table**. Always double-check the filter before executing.

Complex conditions beyond equality — ranges, `IN`, `LIKE`, nested `AND`/`OR` — are expressed with `.filterByExpression(q => q.where('age').greaterThan(65))` from `blendsdk/expression`.

---

### 7. Deleting Rows

`db.delete<F>(tableName)` builds a DELETE with the same filter mechanism. Combine `.filter()` with `.returning('*')` to capture the rows you removed, or use `executeReturnCount()` for a count-only result.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserFilter {
  email?: string;
  active?: boolean;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    // RETURNING hands back the rows that were actually removed.
    const deleted = await db
      .delete<UserFilter>('users')
      .filter({ email: 'ada@example.com' })
      .returning('*')
      .executeReturnSingle();

    if (deleted !== null) {
      console.log(`Deleted user with email ${String(deleted.email)}`);
    }

    // Count-only variant for bulk cleanup.
    const purged = await db
      .delete<UserFilter>('users')
      .filter({ active: false })
      .executeReturnCount();
    console.log(`Purged ${purged} inactive account(s)`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

> ⚠️ A DELETE without a filter — or with `.filter({})` — is a **bulk delete**: `DELETE FROM users` with no `WHERE` clause removes every row in the table.

---

### 8. Transforming Data with Hooks

Statements and queries accept two transformation hooks that run inside the execution pipeline: `beforeQuery(params)` transforms the parameter object right before the SQL runs, and `afterQuery(rows)` transforms the returned rows before they reach your code. This is where normalization, hashing, and redaction belong.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  password_hash?: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const created = await db
      .insert<User>('users')
      .values({
        name: 'Ada Lovelace',
        email: 'ADA@EXAMPLE.COM',
        password_hash: 'plaintext-secret',
      })
      .beforeQuery((params: Record<string, unknown>) => {
        const email = params.email;
        if (typeof email === 'string') {
          params.email = email.toLowerCase();
        }
        const passwordHash = params.password_hash;
        if (typeof passwordHash === 'string') {
          params.password_hash = `hashed(${passwordHash})`;
        }
        return params;
      })
      .afterQuery((records: User[]) =>
        records.map(record => {
          const safe: User = { ...record };
          delete safe.password_hash;
          return safe;
        })
      )
      .returning('*')
      .executeReturnSingle();

    console.log('Inserted (sensitive fields stripped):', created);

    // The same hooks are available as executeQuery() options.
    const { records } = await db.executeQuery<User>(
      'SELECT id, name, email FROM users WHERE email = :email',
      { email: 'ADA@EXAMPLE.COM' },
      {
        beforeQuery: (params: Record<string, unknown>) => ({
          ...params,
          email: String(params.email).toLowerCase(),
        }),
      }
    );
    console.log(`Found ${records.length} user(s) by normalized email`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

Hook parameter names depend on the statement type: INSERT parameters are keyed by column name; UPDATE value parameters carry the `v_` prefix (e.g. `params.v_password_hash`); WHERE-clause parameters are named `p1`, `p2`, …. An exception thrown inside a hook aborts the statement and propagates to the caller — inside a transaction it also triggers the rollback.

---

### 9. Disconnecting Cleanly

Always call `disconnect()` when you are done — typically in a `finally` block. It sets the internal shutdown flag, drains the pool, and force-releases any remaining clients if draining exceeds the timeout (default `10000` ms).

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const { rowCount } = await db.executeQuery('SELECT 1');
    console.log(`Database reachable — ${rowCount} row(s)`);
  } finally {
    // Drain the pool; force-release any stuck clients after 5 seconds.
    await db.disconnect(5000);
  }
}

void main();
```

Key behaviors to remember:

- `disconnect()` is safe to call even if the connection was never established (for example, because the first query failed).
- Once shutdown begins, new queries fail fast with `Cannot execute query: database is shutting down` and new transactions with `Cannot start transaction: database is shutting down`.
- Teardown is one-way — a disconnected instance cannot be reused. Create a new `PostgreSQLDatabase` if you need to reconnect.

---

## Configuration

`PostgreSQLConfig` describes everything the adapter needs to open and manage connections. Every property is grouped into the connection settings inherited from `blendsdk/dbcore` and the PostgreSQL-specific pool and shutdown options.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'db.internal',
  port: 5432,
  database: 'orders',
  user: 'orders_service',
  pass: 'secret',
  poolConfig: {
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  },
  // Standalone usage only — see the warning below.
  enableGracefulShutdown: false,
};

const db = new PostgreSQLDatabase(config);
console.log(`Configured for "${config.database}" with pool max ${config.poolConfig?.max}`);

await db.disconnect();
```

### `PostgreSQLConfig`

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `host` | `string` | — (required) | Hostname of the PostgreSQL server |
| `port` | `number \| string` | `5432` (driver default) | Server port; numeric strings are converted with `Number(port)` |
| `database` | `string` | — (required) | Name of the database to connect to |
| `user` | `string` | — (required) | Database username |
| `pass` | `string` | — (required) | Database password; passed to the driver as `password` |
| `poolConfig` | `PoolConfig` | `undefined` | Optional connection-pool tuning — omitted fields use the defaults below |
| `enableGracefulShutdown` | `boolean` | `false` | Registers `SIGINT` / `SIGTERM` handlers that call `disconnect()` and exit the process |

### `PoolConfig`

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `max` | `number` | `10` | Maximum number of clients in the pool |
| `idleTimeoutMillis` | `number` | `30000` | Milliseconds a client may sit idle before being closed |
| `connectionTimeoutMillis` | `number` | `0` (no timeout) | Milliseconds to wait before timing out when connecting a new client |

> ⚠️ Do **not** set `enableGracefulShutdown: true` when the database is managed by a `blendsdk/webafx` WebApplication — that framework installs its own `SIGINT` / `SIGTERM` handling, and enabling both causes signal-handler conflicts and unpredictable shutdown behavior. Only enable it for standalone database usage.

---

## Error Handling

The package never returns error objects — every failure surfaces as a thrown (or promised-rejected) exception. There are three sources, and they are easy to tell apart:

- **Adapter errors** — plain `Error` instances with fixed messages, thrown by lifecycle guards and statement validation.
- **Driver errors** — PostgreSQL server errors and connection/network failures are rethrown **unchanged**, carrying the `pg` driver's `code`, `detail`, `constraint`, and other properties.
- **Hook errors** — anything thrown inside `beforeQuery` or `afterQuery` propagates exactly like a query error and triggers a rollback inside transactions.

The example below classifies a driver error by its PostgreSQL error code and shows how transaction failures propagate:

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
}

interface PostgreSQLErrorInfo {
  code: string;
  detail?: string;
}

function getPostgreSQLError(error: unknown): PostgreSQLErrorInfo | null {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') {
    return null;
  }
  const info: PostgreSQLErrorInfo = { code: error.code };
  if ('detail' in error && typeof error.detail === 'string') {
    info.detail = error.detail;
  }
  return info;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    // 1. A server-side error: duplicate unique key (PostgreSQL code 23505).
    try {
      await db
        .insert<User>('users')
        .values({ name: 'Ada Lovelace', email: 'ada@example.com' })
        .execute();
    } catch (error) {
      const pgError = getPostgreSQLError(error);
      if (pgError?.code === '23505') {
        console.error('That email address is already registered.');
      } else if (pgError !== null) {
        console.error(`Database error ${pgError.code}: ${pgError.detail ?? 'no details'}`);
      } else if (error instanceof Error) {
        console.error(`Request failed: ${error.message}`);
      }
    }

    // 2. A transaction error: the work is rolled back and the ORIGINAL error
    //    is rethrown, so you can handle it right here.
    try {
      await db.withTransaction(async txDb => {
        await txDb.executeQuery(
          'INSERT INTO users (name, email) VALUES (:name, :email)',
          { name: 'Grace Hopper', email: 'grace@example.com' }
        );
        throw new Error('Business rule violated - abort the transaction');
      });
    } catch (error) {
      if (error instanceof Error) {
        // The insert above has already been rolled back at this point.
        console.error(`Transaction rolled back: ${error.message}`);
      }
    }
  } finally {
    await db.disconnect();
  }
}

void main();
```

Common `pg` error codes you may want to branch on: `23505` (unique violation), `23503` (foreign-key violation), `42P01` (undefined table), `28P01` (invalid password). Connection and network failures usually carry Node-style codes such as `ECONNREFUSED`.

### Adapter error messages

These errors are thrown by the adapter itself (not the server) and always carry the exact messages below:

| Situation | Thrown message |
| --- | --- |
| `executeQuery()` after shutdown started | `Cannot execute query: database is shutting down` |
| `withTransaction()` after shutdown started | `Cannot start transaction: database is shutting down` |
| INSERT builder executed with no values | `Cannot build INSERT statement for table "users": no values provided. Call .values() with at least one column before executing.` |
| UPDATE builder executed with no values | `Cannot build UPDATE statement for table "users": no values provided. Call .values() with at least one column before executing.` |
| No client available (internal guard) | `No database connection available.` |

### Transaction and shutdown semantics

- **Rollback first, then rethrow** — when the `withTransaction()` callback throws, the transaction is rolled back and the *original* error is rethrown. Failures during the rollback itself are logged via `console.error` but never mask the original error.
- **Hook errors count as statement errors** — a throw in `beforeQuery` / `afterQuery` aborts the statement and, inside a transaction, triggers the rollback.
- **Cleanup after failure** — `disconnect()` in a `finally` block is safe even when queries failed or no connection was ever made. If draining the pool fails, `disconnect()` rejects with the driver error; if it merely times out, the adapter force-releases the remaining clients and resolves.

For a deeper treatment of everything covered here — pool internals, expression-based filtering, hook semantics, and graceful shutdown in detail — continue with Core Concepts.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
