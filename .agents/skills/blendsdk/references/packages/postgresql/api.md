> **Package**: `blendsdk/postgresql`

# postgresql API Reference

Complete reference for every public class, interface, and member exported by `blendsdk/postgresql`. For conceptual explanations and extended examples, see the Overview and Core Concepts.

---

## Exports Overview

The package entry point (`src/index.ts`) re-exports four modules:

```typescript
export * from './database.js';
export * from './insert-statement.js';
export * from './update-statement.js';
export * from './delete-statement.js';
```

| Symbol | Kind | Defined in | Description |
| --- | --- | --- | --- |
| `PostgreSQLDatabase` | class | `database.ts` | Database adapter — connection pooling, query execution, transactions, statement factories |
| `PostgreSQLConfig` | interface | `database.ts` | Connection configuration; extends `DatabaseConfig` from `blendsdk/dbcore` |
| `PoolConfig` | interface | `database.ts` | Tuning options for the underlying `pg.Pool` |
| `PostgreSQLQueryResult<T>` | interface | `database.ts` | Query result; extends `QueryResult<T>` with `pg` field metadata |
| `PostgreSQLInsertStatement<TableType>` | class | `insert-statement.ts` | PostgreSQL `INSERT` builder; extends `InsertStatement<TableType>` |
| `PostgreSQLUpdateStatement<TableType, FilterType>` | class | `update-statement.ts` | PostgreSQL `UPDATE` builder; extends `UpdateStatement<TableType, FilterType>` |
| `PostgreSQLDeleteStatement<FilterType>` | class | `delete-statement.ts` | PostgreSQL `DELETE` builder; extends `DeleteStatement<FilterType>` |

The package exports **no standalone functions, enums, or constants** — the entire public surface consists of the four classes and three interfaces listed above.

---

## Classes

### PostgreSQLDatabase

```typescript
class PostgreSQLDatabase extends Database
```

The central class of the package. A `PostgreSQLDatabase` instance owns one `pg.Pool`, executes named-parameter queries with `yesql` translation, wraps callbacks in transactions with automatic `BEGIN` / `COMMIT` / `ROLLBACK`, and creates the PostgreSQL-specific statement builders. One instance represents one configured PostgreSQL database.

Unlike the statement builders, `PostgreSQLDatabase` is instantiated directly with `new`.

#### Constructor

```typescript
constructor(config: PostgreSQLConfig)
```

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `config` | `PostgreSQLConfig` | Yes | — | Connection settings (`host`, `port`, `database`, `user`, `pass`) plus optional `poolConfig` and `enableGracefulShutdown` |

Notes:

- Initializes the internal `pg.Pool` with `database`, `host`, `password` (mapped from `pass`), `port` (coerced with `Number()` when present), `user`, and any `poolConfig` overrides.
- The pool connects lazily — constructing an instance does not open a connection; connectivity errors surface on the first query.
- When `enableGracefulShutdown` is `true`, `registerShutdownHandlers()` is called immediately.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
  poolConfig: {
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  },
};

const db = new PostgreSQLDatabase(config);
console.log(`Adapter created for database "${config.database}"`);
```

#### Properties

The class exposes three protected properties that back the pooling and transaction mechanics, plus the inherited configuration.

| Property | Type | Description |
| --- | --- | --- |
| `pool` | `Pool` | Protected. The `pg` connection pool owned by this adapter instance |
| `transactionClient` | `PoolClient \| null` | Protected. The client pinned for the active transaction; `null` when no transaction runs |
| `isShuttingDown` | `boolean` | Protected. Set to `true` when `disconnect()` begins; blocks new queries and transactions |
| `config` | `PostgreSQLConfig` | Inherited from the base `Database` class — the configuration passed to the constructor |

#### Methods

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `connect` | `(): Promise<PoolClient>` | `Promise<PoolClient>` | Checks out a client from the connection pool |
| `executeQuery` | `<R>(query: string, params?: Record<string, any>, options?: ExecuteQueryOptions): Promise<PostgreSQLQueryResult<R>>` | `Promise<PostgreSQLQueryResult<R>>` | Executes a named-parameter SQL statement |
| `withTransaction` | `<T>(fn: (db: this) => Promise<T>): Promise<T>` | `Promise<T>` | Executes a callback inside a transaction with automatic commit/rollback |
| `insert` | `<T>(tableName: string): InsertStatement<T>` | `InsertStatement<T>` | Creates a `PostgreSQLInsertStatement<T>` for the table |
| `update` | `<T, F>(tableName: string): UpdateStatement<T, F>` | `UpdateStatement<T, F>` | Creates a `PostgreSQLUpdateStatement<T, F>` for the table |
| `delete` | `<F>(tableName: string): DeleteStatement<F>` | `DeleteStatement<F>` | Creates a `PostgreSQLDeleteStatement<F>` for the table |
| `disconnect` | `(timeoutMs?: number): Promise<void>` | `Promise<void>` | Drains the pool with timeout protection and closes all connections |

##### `connect()`

```typescript
connect(): Promise<PoolClient>
```

Checks out a single client from the connection pool. Used internally by `executeQuery()` (atomic queries) and `withTransaction()`.

Returns `Promise<PoolClient>` — a PostgreSQL client from `pg`.

When calling `connect()` directly, the client is owned by your code and must be released with `client.release()`. Prefer `executeQuery()` and `withTransaction()`, which manage check-out and release automatically, including on failure paths.

##### `executeQuery<R>()`

```typescript
executeQuery<R>(
  query: string,
  params?: Record<string, any>,
  options?: ExecuteQueryOptions
): Promise<PostgreSQLQueryResult<R>>
```

Type parameter: `R` — the record shape of the returned rows.

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `query` | `string` | Yes | — | SQL text with named `:paramName` placeholders |
| `params` | `Record<string, any>` | No | `{}` | Values for the named parameters |
| `options` | `ExecuteQueryOptions` | No | `{}` | Optional `beforeQuery` / `afterQuery` hooks |

Execution behavior:

1. **Shutdown guard** — rejects immediately if `disconnect()` has started.
2. **Client acquisition** — outside a transaction, a client is checked out for this single call (atomic); inside `withTransaction()`, the pinned transaction client is reused.
3. **`beforeQuery` hook** — `options.beforeQuery(params)` runs before parameter translation.
4. **Parameter translation** — `yesql` converts `:name` placeholders into positional parameters, so values are always bound and never interpolated into the SQL text.
5. **Execution** — when the statement returns or affects zero rows, the method short-circuits and resolves to `{ records: [], rowCount: 0, fields: [] }`.
6. **`afterQuery` hook** — `options.afterQuery(rows)` runs on the raw driver rows before the result object is assembled.
7. **Release** — atomic calls release their client; transactional calls leave the pinned client untouched.

| Error | Condition |
| --- | --- |
| `Cannot execute query: database is shutting down` | Called after `disconnect()` has started |
| `No database connection available.` | No client could be resolved for execution |
| Driver errors (syntax, constraints, connectivity) | Propagated unchanged from `pg` |

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase, PostgreSQLQueryResult } from 'blendsdk/postgresql';

interface Product {
  id: number;
  name: string;
  price: string;
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
      `SELECT id, name, price
         FROM products
        WHERE category = :category
          AND price <= :maxPrice
        ORDER BY name`,
      { category: 'books', maxPrice: 50 },
      {
        beforeQuery: (params: Record<string, unknown>) => ({
          ...params,
          category: String(params.category).toLowerCase(),
        }),
        afterQuery: (rows: Product[]) => rows.map(row => ({ ...row, name: row.name.trim() })),
      }
    );

    console.log(`Matched ${result.rowCount} product(s)`);
    console.log(`Columns: ${result.fields.map(field => field.name).join(', ')}`);
    for (const product of result.records) {
      console.log(`- ${product.name} (${product.price})`);
    }
  } finally {
    await db.disconnect();
  }
}

void main();
```

##### `withTransaction<T>()`

```typescript
withTransaction<T>(fn: (db: this) => Promise<T>): Promise<T>
```

Type parameter: `T` — the return type of the transaction callback.

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `fn` | `(db: this) => Promise<T>` | Yes | — | Async callback executed inside the transaction; receives the same database instance |

Behavior:

1. **Shutdown guard** — rejects immediately if `disconnect()` has started.
2. **Client pinning** — one client is checked out and pinned on `transactionClient` for the whole transaction; every query issued through the callback reuses it.
3. **Commit** — `BEGIN` is issued, `fn` runs, `COMMIT` is issued on success, and `fn`'s return value is passed through to the caller.
4. **Rollback** — if `fn` throws, `ROLLBACK` is attempted (only if the transaction was not already committed) and the **original error is rethrown**. Errors during rollback itself are logged, not thrown.
5. **Cleanup** — a `finally` block always releases the client back to the pool and resets `transactionClient` to `null`.

| Error | Condition |
| --- | --- |
| `Cannot start transaction: database is shutting down` | Called after `disconnect()` has started |
| Original callback error | Rethrown to the caller after `ROLLBACK` |

⚠️ Transactions are **not re-entrant**. Do not call `withTransaction()` from inside a running transaction callback — an inner call reuses the pinned client, issues its own `BEGIN` / `COMMIT`, and releases the client, ending the outer transaction prematurely. Issue all work through the callback's database instance instead.

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

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    await db.withTransaction(async transactionDb => {
      const debit = await transactionDb.executeQuery<AccountRow>(
        `UPDATE accounts
            SET balance = balance - :amount
          WHERE id = :accountId AND balance >= :amount
          RETURNING id, balance`,
        { amount: 100, accountId: 1 }
      );

      if (debit.rowCount === 0) {
        throw new Error('Insufficient funds');
      }

      await transactionDb.executeQuery(
        'UPDATE accounts SET balance = balance + :amount WHERE id = :accountId',
        { amount: 100, accountId: 2 }
      );
    });
    console.log('Transfer committed');
  } catch (error) {
    console.error('Transfer rolled back:', error);
  } finally {
    await db.disconnect();
  }
}

void main();
```

##### `insert<T>()`

```typescript
insert<T>(tableName: string): InsertStatement<T>
```

Type parameter: `T` — the table row type used by `.values()` and the returned records.

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `tableName` | `string` | Yes | — | The table to insert into |

Returns `InsertStatement<T>` — in practice a `PostgreSQLInsertStatement<T>`. See [PostgreSQLInsertStatement](#postgresqlinssertstatement) for the fluent API.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
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
    const created: User | null = await db
      .insert<User>('users')
      .values({ name: 'Ada Lovelace', email: 'ada@example.com' })
      .returning('*')
      .executeReturnSingle();

    console.log(`Inserted user: ${created?.email ?? 'none'}`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

##### `update<T, F>()`

```typescript
update<T, F>(tableName: string): UpdateStatement<T, F>
```

Type parameters: `T` — the table row type; `F` — the filter criteria type.

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `tableName` | `string` | Yes | — | The table to update |

Returns `UpdateStatement<T, F>` — in practice a `PostgreSQLUpdateStatement<T, F>`. See [PostgreSQLUpdateStatement](#postgresqlupdatestatement) for the fluent API.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  active?: boolean;
}

interface UserFilter {
  email?: string;
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
    const updated: User | null = await db
      .update<User, UserFilter>('users')
      .values({ active: false })
      .filter({ email: 'ada@example.com' })
      .returning('*')
      .executeReturnSingle();

    console.log(`Updated user: ${updated?.email ?? 'none'}`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

##### `delete<F>()`

```typescript
delete<F>(tableName: string): DeleteStatement<F>
```

Type parameter: `F` — the filter criteria type (also used as the record type of deleted rows).

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `tableName` | `string` | Yes | — | The table to delete from |

Returns `DeleteStatement<F>` — in practice a `PostgreSQLDeleteStatement<F>`. See [PostgreSQLDeleteStatement](#postgresqldeletestatement) for the fluent API.

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
    const removed: number = await db
      .delete<UserFilter>('users')
      .filter({ active: false })
      .executeReturnCount();

    console.log(`Removed ${removed} inactive account(s)`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

##### `disconnect(timeoutMs?)`

```typescript
disconnect(timeoutMs?: number): Promise<void>
```

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `timeoutMs` | `number` | No | `10000` | Maximum time to wait for the graceful pool close, in milliseconds |

Behavior:

1. Sets `isShuttingDown = true` — from this point on, new `executeQuery()` calls reject with `Cannot execute query: database is shutting down` and new `withTransaction()` calls with `Cannot start transaction: database is shutting down`.
2. Calls `pool.end()` and resolves when all checked-out clients have been returned.
3. If the close exceeds `timeoutMs`, `forceDisconnect()` forcefully releases the remaining clients and the promise still resolves instead of hanging.
4. Rejects only when the underlying pool close itself fails.

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
    await db.executeQuery('SELECT 1');
  } finally {
    // Wait up to 5 seconds for in-flight work, then force-release remaining clients.
    await db.disconnect(5000);
  }

  // Queries after disconnect() are rejected by the shutdown guard.
  try {
    await db.executeQuery('SELECT 1');
  } catch (error) {
    console.error('Expected failure:', error);
  }
}

void main();
```

#### Protected Members

The members below are part of the class contract for subclasses but are not callable from outside the class.

##### `forceDisconnect()` (protected)

```typescript
protected async forceDisconnect(): Promise<void>
```

Last-resort teardown invoked by `disconnect()` when the graceful pool close exceeds the timeout. Reads the driver's client list, releases every client forcefully (`client.release(true)`), clears the list, and swallows any errors so shutdown never hangs. May interrupt in-flight queries and transactions.

##### `registerShutdownHandlers()` (protected)

```typescript
protected registerShutdownHandlers(): void
```

Registers process-level `SIGINT` and `SIGTERM` handlers. When a signal is received, the handler logs it, awaits `disconnect()`, and terminates the process with exit code `0` (success) or `1` (failure). Called automatically by the constructor when `enableGracefulShutdown` is `true`.

⚠️ Do **not** enable `enableGracefulShutdown` for databases owned by a `WebApplication` from `blendsdk/webafx` — the framework installs its own `SIGINT` / `SIGTERM` handling, and enabling both causes signal-handler conflicts with unpredictable shutdown behavior. Only enable it for standalone database usage.

#### Inherited Members

As a subclass of `Database` from `blendsdk/dbcore`, instances also expose the base-class members — including the stored `config` and the vendor-neutral SELECT builders (`from()` / `selectAll()`, which return a `FromStatement`). Those members are documented in the `blendsdk/dbcore` API reference.

---

### PostgreSQLInsertStatement

```typescript
class PostgreSQLInsertStatement<TableType> extends InsertStatement<TableType>
```

PostgreSQL-specific implementation of the base `InsertStatement` builder. It overrides only the two protected extension points of the base class — `buildQuery()` and `buildParameters()` — and inherits the fluent API (`values`, `returning`, `beforeQuery`, `afterQuery`) and the terminal `execute*` methods from `blendsdk/dbcore`. Instances are created through `PostgreSQLDatabase.insert<TableType>()`.

Type parameters:

| Type parameter | Description |
| --- | --- |
| `TableType` | Row type of the target table — types `.values()` and the records returned by `execute*` |

#### Constructor

`PostgreSQLInsertStatement` does not declare its own constructor; it inherits the base constructor from `InsertStatement<TableType>` (called internally as `new PostgreSQLInsertStatement<TableType>(tableName, db)`). Create instances via `db.insert<TableType>(tableName)`.

#### Methods

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `values` | `(values: Partial<TableType>) => this` | `this` | Sets the column/value pairs to insert; every key becomes a `:key` named parameter (inherited) |
| `returning` | `(columns: '*' \| (keyof TableType)[]) => this` | `this` | Appends a `RETURNING` clause (inherited) |
| `beforeQuery` | `(hook: (params) => params) => this` | `this` | Registers a parameter-transform hook; INSERT parameters are keyed by column name (inherited) |
| `afterQuery` | `(hook: (rows) => rows) => this` | `this` | Registers a result-transform hook (inherited) |
| `execute` | `() => Promise<QueryResult<TableType>>` | `Promise<QueryResult<TableType>>` | Executes the statement (inherited) |
| `executeReturnSingle` | `() => Promise<TableType \| null>` | `Promise<TableType \| null>` | Executes and resolves to the first returned record, or `null` |
| `executeReturnAll` | `() => Promise<TableType[]>` | `Promise<TableType[]>` | Executes and resolves to all returned records |
| `executeReturnCount` | `() => Promise<number>` | `Promise<number>` | Executes and resolves to the number of inserted rows |

#### PostgreSQL-Specific Overrides (protected)

| Method | Signature | Description |
| --- | --- | --- |
| `buildQuery` | `protected buildQuery(): string` | Renders `INSERT INTO <table> (<columns>) VALUES (:<column>, ...) [RETURNING ...]` |
| `buildParameters` | `protected buildParameters(): { [key: string]: any }` | Returns the values object directly — column names and parameter names are identical |

Generated SQL and parameters (column order follows the key order of the values object):

| Build chain | Generated query | Parameters |
| --- | --- | --- |
| `.values({ name: 'Alice' })` | `INSERT INTO users (name) VALUES (:name)` | `{ name: 'Alice' }` |
| `.values({ name: 'Alice', email: 'alice@test.com', age: 30 })` | `INSERT INTO users (name, email, age) VALUES (:name, :email, :age)` | `{ name: 'Alice', email: 'alice@test.com', age: 30 }` |
| `.values({ name: 'Alice' }).returning('*')` | `INSERT INTO users (name) VALUES (:name) RETURNING *` | `{ name: 'Alice' }` |
| `.values({ name: 'Alice', email: 'a@b.com' }).returning(['id', 'created_at'])` | `INSERT INTO users (name, email) VALUES (:name, :email) RETURNING id, created_at` | `{ name: 'Alice', email: 'a@b.com' }` |

| Error | Condition |
| --- | --- |
| `Cannot build INSERT statement for table "<table>": no values provided. Call .values() with at least one column before executing.` | `buildQuery()` is called before any values were set |

#### Example

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
    const created: User | null = await db
      .insert<User>('users')
      .values({ name: 'Ada Lovelace', email: 'ada@example.com', age: 36 })
      .returning('*')
      .executeReturnSingle();

    if (created !== null) {
      console.log(`Inserted user #${String(created.id)}: ${created.email}`);
    }

    const insertCount: number = await db
      .insert<User>('users')
      .values({ name: 'Grace Hopper', email: 'grace@example.com' })
      .executeReturnCount();

    console.log(`Rows inserted: ${insertCount}`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

### PostgreSQLUpdateStatement

```typescript
class PostgreSQLUpdateStatement<TableType, FilterType> extends UpdateStatement<TableType, FilterType>
```

PostgreSQL-specific implementation of the base `UpdateStatement` builder. It overrides only the two protected extension points of the base class — `buildQuery()` and `buildParameters()` — and inherits the fluent API (`values`, `filter`, `filterByExpression`, `returning`, `beforeQuery`, `afterQuery`) and the terminal `execute*` methods. Instances are created through `PostgreSQLDatabase.update<TableType, FilterType>()`.

Type parameters:

| Type parameter | Description |
| --- | --- |
| `TableType` | Row type of the target table — types `.values()` and the returned records |
| `FilterType` | Shape of the `WHERE` criteria — types `.filter()` and the parameters produced by the expression compiler |

#### Constructor

`PostgreSQLUpdateStatement` does not declare its own constructor; it inherits the base constructor from `UpdateStatement<TableType, FilterType>` (called internally as `new PostgreSQLUpdateStatement<TableType, FilterType>(tableName, db)`). Create instances via `db.update<TableType, FilterType>(tableName)`.

#### Methods

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `values` | `(values: Partial<TableType>) => this` | `this` | Sets the `SET` assignments; each key becomes a `:v_<key>` named parameter (inherited) |
| `filter` | `(criteria: FilterType) => this` | `this` | Builds the `WHERE` clause from equality conditions; parameters are named `p1`, `p2`, … (inherited) |
| `filterByExpression` | `(build: (query) => CompiledExpression) => this` | `this` | Builds the `WHERE` clause with the `blendsdk/expression` builder; compiled once and cached (inherited) |
| `returning` | `(columns: '*' \| (keyof TableType)[]) => this` | `this` | Appends a `RETURNING` clause (inherited) |
| `beforeQuery` | `(hook: (params) => params) => this` | `this` | Registers a parameter-transform hook; SET values appear as `v_<column>`, WHERE parameters as `p1`, `p2`, … (inherited) |
| `afterQuery` | `(hook: (rows) => rows) => this` | `this` | Registers a result-transform hook (inherited) |
| `execute` | `() => Promise<QueryResult<TableType>>` | `Promise<QueryResult<TableType>>` | Executes the statement (inherited) |
| `executeReturnSingle` | `() => Promise<TableType \| null>` | `Promise<TableType \| null>` | Executes and resolves to the first returned record, or `null` |
| `executeReturnAll` | `() => Promise<TableType[]>` | `Promise<TableType[]>` | Executes and resolves to all returned records |
| `executeReturnCount` | `() => Promise<number>` | `Promise<number>` | Executes and resolves to the number of updated rows |

#### PostgreSQL-Specific Overrides (protected)

| Method | Signature | Description |
| --- | --- | --- |
| `buildQuery` | `protected buildQuery(): string` | Renders `UPDATE <table> SET <col> = :v_<col>, ... [WHERE ...] [RETURNING ...]` |
| `buildParameters` | `protected buildParameters(): { [key: string]: any }` | Merges the `v_`-prefixed value parameters with the WHERE parameters from the cached compiled expression |

The `v_` prefix guards against collisions between SET values and WHERE parameters — for example, `values({ active: true }).filter({ active: false })` produces `v_active` and `p1` as two separate parameters.

Generated SQL and parameters (parameter numbering follows the key order of the filter object):

| Build chain | Generated query | Parameters |
| --- | --- | --- |
| `.values({ name: 'Bob' })` | `UPDATE users SET name = :v_name` | `{ v_name: 'Bob' }` |
| `.values({ name: 'Updated' }).filter({ id: 1 })` | `UPDATE users SET name = :v_name WHERE id = :p1` | `{ v_name: 'Updated', p1: 1 }` |
| `.values({ name: 'Jane', age: 31, active: false }).filter({ email: 'jane@example.com' })` | `UPDATE users SET name = :v_name, age = :v_age, active = :v_active WHERE email = :p1` | `{ v_name: 'Jane', v_age: 31, v_active: false, p1: 'jane@example.com' }` |
| `.values({ name: 'Bob' }).returning('*')` | `UPDATE users SET name = :v_name RETURNING *` | `{ v_name: 'Bob' }` |

| Error | Condition |
| --- | --- |
| `Cannot build UPDATE statement for table "<table>": no values provided. Call .values() with at least one column before executing.` | `buildQuery()` is called before any values were set |

⚠️ Without `.filter()` — or with an empty filter object — the generated statement has no `WHERE` clause and updates **every row** in the table.

#### Example

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
    const updated: User | null = await db
      .update<User, UserFilter>('users')
      .values({ active: false })
      .filter({ email: 'ada@example.com' })
      .returning('*')
      .executeReturnSingle();

    if (updated !== null) {
      console.log(`User #${String(updated.id)} active=${String(updated.active)}`);
    }

    const deactivated: number = await db
      .update<User, UserFilter>('users')
      .values({ active: false })
      .filterByExpression(q => q.where('id').greaterThan(1000))
      .executeReturnCount();

    console.log(`Accounts deactivated: ${deactivated}`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

### PostgreSQLDeleteStatement

```typescript
class PostgreSQLDeleteStatement<FilterType> extends DeleteStatement<FilterType>
```

PostgreSQL-specific implementation of the base `DeleteStatement` builder. It overrides only the two protected extension points of the base class — `buildQuery()` and `buildParameters()` — and inherits the fluent API (`filter`, `filterByExpression`, `returning`, `beforeQuery`, `afterQuery`) and the terminal `execute*` methods. Instances are created through `PostgreSQLDatabase.delete<FilterType>()`.

Type parameters:

| Type parameter | Description |
| --- | --- |
| `FilterType` | Shape of the `WHERE` criteria — types `.filter()` and the records returned by `execute*` when a `RETURNING` clause is present |

#### Constructor

`PostgreSQLDeleteStatement` does not declare its own constructor; it inherits the base constructor from `DeleteStatement<FilterType>` (called internally as `new PostgreSQLDeleteStatement<FilterType>(tableName, db)`). Create instances via `db.delete<FilterType>(tableName)`.

#### Methods

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `filter` | `(criteria: FilterType) => this` | `this` | Builds the `WHERE` clause from equality conditions; parameters are named `p1`, `p2`, … (inherited) |
| `filterByExpression` | `(build: (query) => CompiledExpression) => this` | `this` | Builds the `WHERE` clause with the `blendsdk/expression` builder; compiled once and cached (inherited) |
| `returning` | `(columns: '*' \| (keyof FilterType)[]) => this` | `this` | Appends a `RETURNING` clause to retrieve deleted row data (inherited) |
| `beforeQuery` | `(hook: (params) => params) => this` | `this` | Registers a parameter-transform hook; WHERE parameters are `p1`, `p2`, … (inherited) |
| `afterQuery` | `(hook: (rows) => rows) => this` | `this` | Registers a result-transform hook (inherited) |
| `execute` | `() => Promise<QueryResult<FilterType>>` | `Promise<QueryResult<FilterType>>` | Executes the statement (inherited) |
| `executeReturnSingle` | `() => Promise<FilterType \| null>` | `Promise<FilterType \| null>` | Executes and resolves to the first deleted record, or `null` |
| `executeReturnAll` | `() => Promise<FilterType[]>` | `Promise<FilterType[]>` | Executes and resolves to all deleted records |
| `executeReturnCount` | `() => Promise<number>` | `Promise<number>` | Executes and resolves to the number of deleted rows |

#### PostgreSQL-Specific Overrides (protected)

| Method | Signature | Description |
| --- | --- | --- |
| `buildQuery` | `protected buildQuery(): string` | Renders `DELETE FROM <table> [WHERE ...] [RETURNING ...]` |
| `buildParameters` | `protected buildParameters(): { [key: string]: any }` | Returns the WHERE-clause parameters from the cached compiled expression; `{}` when no filter is set |

Generated SQL and parameters (parameter numbering follows the key order of the filter object):

| Build chain | Generated query | Parameters |
| --- | --- | --- |
| *(no filter)* | `DELETE FROM users` | `{}` |
| `.filter({ id: 1 })` | `DELETE FROM users WHERE id = :p1` | `{ p1: 1 }` |
| `.filter({ active: false, age: 25 })` | `DELETE FROM users WHERE active = :p1 AND age = :p2` | `{ p1: false, p2: 25 }` |
| `.filter({ id: 1 }).returning('*')` | `DELETE FROM users WHERE id = :p1 RETURNING *` | `{ p1: 1 }` |
| `.returning(['id', 'name'])` | `DELETE FROM users RETURNING id, name` | `{}` |

⚠️ Without `.filter()` — or with an empty filter object, e.g. `.filter({})` — the generated statement has no `WHERE` clause and deletes **every row** in the table (bulk delete). Always double-check the filter before executing.

#### Example

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

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
    const deleted: UserFilter | null = await db
      .delete<UserFilter>('users')
      .filter({ email: 'ada@example.com' })
      .returning('*')
      .executeReturnSingle();

    if (deleted !== null) {
      console.log(`Deleted user: ${String(deleted.email)}`);
    }

    const purged: number = await db
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

---

## Types & Interfaces

### PostgreSQLConfig

```typescript
interface PostgreSQLConfig extends DatabaseConfig
```

Configuration for PostgreSQL connections. Extends `DatabaseConfig` from `blendsdk/dbcore` with pool tuning and shutdown handling.

| Property | Type | Description |
| --- | --- | --- |
| `poolConfig` | `PoolConfig` | Optional tuning options forwarded to the `pg.Pool` constructor |
| `enableGracefulShutdown` | `boolean` | When `true`, the constructor registers `SIGINT` / `SIGTERM` handlers that call `disconnect()` (default: `false`) |

Inherited connection options (`host`, `port`, `database`, `user`, `pass`) are documented under [`DatabaseConfig`](#databaseconfig-from-blendsdkdbcore) below.

⚠️ Do not enable `enableGracefulShutdown` when the database is managed by a `WebApplication` from `blendsdk/webafx` — the framework has its own `SIGTERM` / `SIGINT` handling, and enabling both causes signal-handler conflicts and unpredictable shutdown behavior. Only enable it for standalone database usage.

```typescript
import { PostgreSQLConfig } from 'blendsdk/postgresql';

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
  enableGracefulShutdown: false,
};
```

### PoolConfig

```typescript
interface PoolConfig
```

Configuration options for the PostgreSQL connection pool. All properties are optional and have sensible driver defaults.

| Property | Type | Description |
| --- | --- | --- |
| `max` | `number` | Maximum number of clients in the pool (default: 10) |
| `idleTimeoutMillis` | `number` | Number of milliseconds a client must sit idle before being closed (default: 30000) |
| `connectionTimeoutMillis` | `number` | Number of milliseconds to wait before timing out when connecting a new client (default: 0 — no timeout) |

### PostgreSQLQueryResult<T>

```typescript
interface PostgreSQLQueryResult<T> extends QueryResult<T>
```

Represents the result of a PostgreSQL query execution. Extends the base `QueryResult<T>` with PostgreSQL-specific field definitions.

Type parameter: `T` — the record type of the returned rows (fixed by the `R` parameter of `executeQuery<R>()`).

| Property | Type | Description |
| --- | --- | --- |
| `records` | `T[]` | Rows returned by the query; an empty array when no rows are returned or affected (inherited from `QueryResult<T>`) |
| `rowCount` | `number` | Number of rows returned (SELECT) or rows affected (INSERT / UPDATE / DELETE) (inherited) |
| `fields` | `FieldDef[]` | Array of field definitions describing the returned columns; an empty array when `rowCount` is `0` |

---

## Related Types from Dependencies

The following types appear in public signatures of this package but are defined in other packages — refer to their own API references for the full contract.

### `DatabaseConfig` (from `blendsdk/dbcore`)

Base connection configuration extended by `PostgreSQLConfig`.

| Property | Type | Description |
| --- | --- | --- |
| `host` | `string` | Hostname of the PostgreSQL server |
| `port` | `number \| string` | Server port; numeric strings are accepted and converted with `Number(port)`; omitted values are passed to the driver as `undefined` |
| `database` | `string` | Name of the database to connect to |
| `user` | `string` | Database username |
| `pass` | `string` | Database password — forwarded to the driver as its `password` option |

### `QueryResult<T>` (from `blendsdk/dbcore`)

Base query result extended by `PostgreSQLQueryResult<T>`.

| Property | Type | Description |
| --- | --- | --- |
| `records` | `T[]` | Rows returned by the query |
| `rowCount` | `number` | Number of rows returned or affected |

### `ExecuteQueryOptions` (from `blendsdk/dbcore`)

Optional third argument of `executeQuery()`.

| Property | Type | Description |
| --- | --- | --- |
| `beforeQuery` | `(params) => params` | Optional hook that transforms the named-parameter object before it is translated and executed |
| `afterQuery` | `(rows) => rows` | Optional hook that transforms the raw result rows before the result object is assembled |

Hook semantics mirror the statement-builder hooks — see [Query Hooks](usage.md#query-hooks) for parameter naming rules and examples.

### `FieldDef` (from `pg`)

PostgreSQL column metadata returned in `PostgreSQLQueryResult.fields`.

| Property | Type | Description |
| --- | --- | --- |
| `name` | `string` | Column name in the result set |
| `tableID` | `number` | OID of the source table (when applicable) |
| `columnID` | `number` | Attribute number of the source column (when applicable) |
| `dataTypeID` | `number` | PostgreSQL OID of the column's data type |
| `dataTypeSize` | `number` | Size of the column's data type in bytes |
| `dataTypeModifier` | `number` | Type modifier of the column |
| `format` | `string` | Wire format of the column value (`'text'` or `'binary'`) |

---

## See Also

- Overview — package summary, architecture, and quick start.
- Core Concepts — concept-level explanations with extended examples (transactions, hooks, shutdown).

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
