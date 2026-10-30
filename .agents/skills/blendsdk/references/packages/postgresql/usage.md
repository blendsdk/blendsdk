> **Package**: `blendsdk/postgresql`

# postgresql Core Concepts

This document explains each abstraction that `blendsdk/postgresql` puts on the wire: the adapter class, its configuration surface, the query-execution pipeline, transaction isolation, query hooks, and the three PostgreSQL-dialect statement builders. Everything in this package is built on top of `blendsdk/dbcore`; the concepts below cover what this package adds to those base contracts.

This package executes SQL and manages connections. It does not define schemas, generate a bootstrap script, or run migrations.

| Concept | Exported symbol | Kind |
| --- | --- | --- |
| Adapter | `PostgreSQLDatabase` | class |
| Configuration | `PostgreSQLConfig`, `PoolConfig` | interfaces |
| Query results | `PostgreSQLQueryResult<T>` | interface |
| Transaction scope | `withTransaction()`, `TransactionOptions`, `TransactionIsolation` | method, interface, union type |
| Query hooks | `beforeQuery` / `afterQuery` (chainable on builders) | options / builder methods |
| INSERT builder | `PostgreSQLInsertStatement<T>` | class |
| UPDATE builder | `PostgreSQLUpdateStatement<T, F>` | class |
| DELETE builder | `PostgreSQLDeleteStatement<F>` | class |

The ownership flow is always the same:

```
db.executeQuery() ───────────► acquire client → executeOnClient() → release client
db.withTransaction(fn) ──────► acquire client → BEGIN → AsyncLocalStorage context → COMMIT/ROLLBACK → release
db.insert()/update()/delete() ─► PostgreSQL*Statement → execute*() → db.executeQuery()
```

Install the umbrella package and import from the adapter's path:

```bash
npm install blendsdk
```

---

## 1. `PostgreSQLDatabase` — the adapter class

**What It Is**

`PostgreSQLDatabase` is the only stateful object in the package. It extends the engine-neutral `Database` class from `blendsdk/dbcore`, owns a `pg.Pool`, implements the PostgreSQL dialect for query execution and transactions, and acts as the factory for the three dialect-specific statement builders. Application code talks to this class; everything else in the package is a pure SQL producer created by it.

**How It Works**

The constructor calls `super(config)` (so the config stays available as `this.config`) and then builds the pool from the PostgreSQL-relevant fields:

```typescript fragment
this.pool = new Pool({
  database, host, password: pass, port: port ? Number(port) : undefined, user,
  max: poolConfig?.max,
  idleTimeoutMillis: poolConfig?.idleTimeoutMillis,
  connectionTimeoutMillis: poolConfig?.connectionTimeoutMillis,
});
```

Connections are acquired lazily — constructing the class does not open a socket. From that point on, three protected members define the runtime state:

- `pool` — the node-postgres pool.
- `transactionContext` — an `AsyncLocalStorage<TransactionContext>` that carries the owning client through one transaction's async call chain.
- `isShuttingDown` — flipped to `true` by `disconnect()`, after which new queries and transactions are rejected.

`executeQuery()` and `withTransaction()` are the two overridden entry points; `insert()`, `update()` and `delete()` are factories that return `PostgreSQLInsertStatement`, `PostgreSQLUpdateStatement` and `PostgreSQLDeleteStatement` instances. The FROM/SELECT surface (`from()`, `selectAll()`) is inherited unchanged from `Database`, which is why this package only re-implements the parts that are PostgreSQL-specific. All protected members are part of the documented extension surface — subclasses can wrap `connect()` or read `this.config`.

**Complete Example**

```typescript
import {
  PostgreSQLDatabase,
  PostgreSQLConfig,
  PostgreSQLQueryResult,
} from 'blendsdk/postgresql';

interface GreetingRow {
  greeting: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const health: PostgreSQLQueryResult<GreetingRow> = await db.executeQuery<GreetingRow>(
    'SELECT :name AS greeting',
    { name: 'BlendSDK' }
  );
  console.log(`rowCount=${health.rowCount} greeting=${health.records[0]?.greeting}`);

  const computed = await db.withTransaction(async (tx) => {
    const { records } = await tx.executeQuery<{ value: number }>('SELECT 42 AS value');
    return records[0]?.value ?? 0;
  });
  console.log(`transaction returned ${computed}`);
} catch (error) {
  console.error('database operation failed', error);
  throw error;
} finally {
  await db.disconnect();
}
```

**Key Methods and Properties**

| Name | Type/Signature | Description |
| --- | --- | --- |
| `constructor` | `(config: PostgreSQLConfig)` | Stores the config and creates the `pg.Pool`. Does not connect. |
| `executeQuery` | `<R>(query: string, params?: Record<string, any>, options?: ExecuteQueryOptions) => Promise<PostgreSQLQueryResult<R>>` | Executes one named-parameter query; joins the active transaction when called inside `withTransaction()`. See concept 3. |
| `withTransaction` | `<T>(fn: (db: this) => Promise<T>, options?: TransactionOptions) => Promise<T>` | Runs `fn` inside BEGIN/COMMIT/ROLLBACK on a dedicated client. See concept 4. |
| `connect` | `() => Promise<PoolClient>` | Acquires a pooled client the caller owns and must `release()`. |
| `disconnect` | `(timeoutMs?: number) => Promise<void>` | Shuts the pool down; defaults to `10000` ms. See concept 9. |
| `insert` | `<T>(tableName: string) => InsertStatement<T>` | Returns a `PostgreSQLInsertStatement<T>` at runtime. |
| `update` | `<T, F>(tableName: string) => UpdateStatement<T, F>` | Returns a `PostgreSQLUpdateStatement<T, F>` at runtime. |
| `delete` | `<F>(tableName: string) => DeleteStatement<F>` | Returns a `PostgreSQLDeleteStatement<F>` at runtime. |
| `pool` | `Pool` (protected) | The underlying node-postgres pool. |
| `transactionContext` | `AsyncLocalStorage<TransactionContext>` (protected, readonly) | Async-scoped transaction client. |
| `transactionClient` | `PoolClient \| null` (protected getter, deprecated) | Read-only compatibility accessor; `null` outside an active transaction. |
| `isShuttingDown` | `boolean` (protected) | `true` once `disconnect()` has been invoked. |
| `executeOnClient` | `<R>(client: PoolClient, query: string, params: Record<string, any>, options: ExecuteQueryOptions) => Promise<PostgreSQLQueryResult<R>>` (protected) | Hook + placeholder + driver pipeline for one already-owned client. |
| `forceDisconnect` | `() => Promise<void>` (protected) | Force-releases every pooled client; used by the `disconnect()` timeout. |
| `registerShutdownHandlers` | `() => void` (protected) | Wires SIGINT/SIGTERM to `disconnect()`; only called from the constructor when enabled. |

---

## 2. Configuration and connection pooling

**What It Is**

`PostgreSQLConfig` extends `DatabaseConfig` with two PostgreSQL-specific fields — `poolConfig` (a `PoolConfig` object) and `enableGracefulShutdown` (a boolean) — while the connection coordinates (`host`, `port`, `database`, `user`, `pass`) come from the base configuration. `PoolConfig` exposes the three node-postgres tuning knobs that matter for a service: pool size, idle lifetime, and connect timeout.

**How It Works**

The constructor destructures `this.config` and forwards each value explicitly. Two conversions are worth knowing:

- `port` accepts a number **or** a string; it is passed to the pool as `port ? Number(port) : undefined`, so a numeric string such as `'5432'` is legal.
- `pass` is renamed to the driver's `password` field. There is no separate `password` option on `PostgreSQLConfig`.

`poolConfig` values are forwarded field-by-field, so any omitted field is passed as `undefined` and node-postgres applies its own default: `max` 10, `idleTimeoutMillis` 30000, `connectionTimeoutMillis` 0 (no timeout).

`enableGracefulShutdown` defaults to `false`. When `true`, the constructor calls `registerShutdownHandlers()`, which attaches `SIGINT`/`SIGTERM` listeners that call `disconnect()` and then `process.exit(0)` (or `exit(1)` on failure).

> **Warning:** do **not** set `enableGracefulShutdown` on a database instance managed by a `WebApplication` from `blendsdk/webafx`. The web framework owns the SIGINT/SIGTERM lifecycle, and installing both handlers produces conflicting shutdown behavior. Enable it only for standalone database usage.

**Complete Example**

```typescript
import { PoolConfig, PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const poolConfig: PoolConfig = {
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: '5432',
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
  poolConfig,
};

const db = new PostgreSQLDatabase(config);

try {
  const { rowCount } = await db.executeQuery('SELECT 1');
  console.log(`connected, rowCount=${rowCount}`);
} finally {
  await db.disconnect();
}
```

**Key Methods and Properties**

`PostgreSQLConfig`

| Name | Type/Signature | Description |
| --- | --- | --- |
| `host` | `string` (inherited from `DatabaseConfig`) | PostgreSQL server host. |
| `port` | `number \| string` (inherited) | Server port; numeric strings are converted with `Number()`. |
| `database` | `string` (inherited) | Database name. |
| `user` | `string` (inherited) | Login role. |
| `pass` | `string` (inherited) | Password; mapped to node-postgres `password`. |
| `poolConfig` | `PoolConfig \| undefined` | Optional pool tuning; see below. |
| `enableGracefulShutdown` | `boolean \| undefined` | Registers SIGINT/SIGTERM handlers. Default `false`. Never combine with `blendsdk/webafx`. |

`PoolConfig`

| Name | Type/Signature | Description |
| --- | --- | --- |
| `max` | `number \| undefined` | Maximum clients in the pool (node-postgres default 10). |
| `idleTimeoutMillis` | `number \| undefined` | How long an idle client may sit before it is closed (default 30000). |
| `connectionTimeoutMillis` | `number \| undefined` | How long to wait for a new connection before failing (default 0 — no timeout). |

---

## 3. Query execution and named parameters

**What It Is**

`executeQuery<R>()` is the single SQL primitive of the adapter. It takes SQL text containing `:named` placeholders, a plain object of values, and optional hooks, and resolves with a `PostgreSQLQueryResult<R>` carrying the rows, the affected-row count, and the driver's column metadata. Every statement builder eventually funnels its SQL and parameters through this method.

**How It Works**

The method executes in a fixed order:

1. **Shutdown guard** — if `isShuttingDown` is set, it throws `Cannot execute query: database is shutting down`.
2. **Client selection** — if an `AsyncLocalStorage` transaction context exists on this async call chain, the query runs on that context's client and the method rejects if the context has already been closed (`Cannot execute a query after the transaction has completed…`). Otherwise it calls `connect()` and takes ownership of a fresh pooled client.
3. **`executeOnClient()`** — the protected pipeline:
   - `options.beforeQuery` transforms the parameter object.
   - `yesql` rewrites `:name` placeholders into the driver's positional `$1…$n` form and produces the `values` array. Values are always bound, never concatenated into SQL text — the SQL-injection test in the suite asserts this.
   - `client.query(text, values)` runs.
   - If `rowCount === 0`, the method returns `{ records: [], rowCount: 0, fields: [] }` immediately; `afterQuery` is **not** applied to empty result sets.
   - `options.afterQuery` transforms the returned rows.
   - The result is normalized to `{ records, rowCount, fields }`.
4. **Release** — a client acquired by this call is released in a `finally` block; a transaction client is left for `withTransaction()` to release.

Because each non-transactional call owns its client exclusively, concurrent `executeQuery()` calls never share or release each other's connections — the connection-pool test suite runs ten concurrent queries against one instance to verify this.

**Complete Example**

```typescript
import { PostgreSQLDatabase, PostgreSQLQueryResult } from 'blendsdk/postgresql';

interface OrderRow {
  id: number;
  customer: string;
  total: string;
  created_at: Date;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  const result: PostgreSQLQueryResult<OrderRow> = await db.executeQuery<OrderRow>(
    `SELECT id, customer, total, created_at
       FROM orders
      WHERE customer = :customer
        AND created_at >= :since
      ORDER BY created_at DESC`,
    { customer: 'ada@example.com', since: new Date('2024-01-01T00:00:00Z') }
  );

  for (const order of result.records) {
    console.log(`${order.id} ${order.customer} ${order.total}`);
  }

  console.log(`rows=${result.rowCount}`);
  console.log(`columns=${result.fields.map((field) => field.name).join(', ')}`);
} finally {
  await db.disconnect();
}
```

**Key Methods and Properties**

`executeQuery` and the protected pipeline

| Name | Type/Signature | Description |
| --- | --- | --- |
| `executeQuery` | `<R>(query: string, params?: Record<string, any>, options?: ExecuteQueryOptions) => Promise<PostgreSQLQueryResult<R>>` | Acquires (or reuses) a client, runs the query, normalizes the result. |
| `executeOnClient` | `<R>(client: PoolClient, query: string, params: Record<string, any>, options: ExecuteQueryOptions) => Promise<PostgreSQLQueryResult<R>>` (protected) | Hooks → named-parameter conversion → `client.query()` → normalization. Caller owns the client. |

`PostgreSQLQueryResult<T>` (extends `QueryResult<T>`)

| Name | Type/Signature | Description |
| --- | --- | --- |
| `records` | `T[]` | Rows returned by the query, typed by the generic. |
| `rowCount` | `number` | Rows returned (SELECT / RETURNING) or affected (INSERT/UPDATE/DELETE). Normalized to `0` when the driver reports `null`. |
| `fields` | `FieldDef[]` | node-postgres column metadata (`name`, `dataTypeID`, …). Empty array when `rowCount === 0`. |

> **Behavior note:** the zero-row short-circuit returns `fields: []` and skips `afterQuery`. Do not rely on column metadata or row mapping for queries that matched nothing.

---

## 4. Transaction isolation with `withTransaction()`

**What It Is**

`withTransaction<T>(fn, options?)` runs an async callback inside a PostgreSQL transaction and resolves with the callback's return value. Acceptance of the isolation level is restricted to a small union type, the owning client is scoped to the callback's async call chain via `AsyncLocalStorage`, and the client is guaranteed to be returned to the pool exactly once.

**What It Is — the isolation types**

```typescript fragment
type TransactionIsolation = 'read committed' | 'repeatable read' | 'serializable';
interface TransactionOptions { isolation?: TransactionIsolation; }
```

**How It Works**

1. **Shutdown guard** — throws `Cannot start transaction: database is shutting down` when `isShuttingDown` is set.
2. **Nesting guard** — if the current async call chain already has a transaction context, the call fails fast: PostgreSQL has no nested `BEGIN`, and silently reusing the outer transaction would hide the bug. The error is `Cannot start a nested transaction: …` while the context is active, and `Cannot start a transaction from a completed transaction context.` for a context that has already settled.
3. **Option validation** — happens **before** a client is acquired. A non-object options argument throws `Transaction options must be an object.`; an isolation level outside the union throws `Unsupported transaction isolation level. Use "read committed", "repeatable read", or "serializable".` The value is then mapped through an allowlist to its SQL spelling (`READ COMMITTED`, `REPEATABLE READ`, `SERIALIZABLE`), so the option can never inject arbitrary text into `BEGIN`.
4. **Acquire and begin** — `connect()` returns a client, `BEGIN` (optionally `BEGIN ISOLATION LEVEL …`) is issued.
5. **Run with context** — the callback receives the database handle (`tx`) and runs inside `transactionContext.run(context, () => fn(this))`. Because the context follows the async call chain — not the object — a `db.executeQuery()` issued from inside the callback also lands on the transaction client. A query issued from an unrelated concurrent task does not.
6. **Close the context first** — before `COMMIT`, `context.active` is set to `false` and `context.client` to `null`. A detached task that outlives the callback still sees the closed context and is rejected instead of using a client that is back in the pool.
7. **Commit or roll back** — `COMMIT` on success; on failure `ROLLBACK` is issued *only if `BEGIN` succeeded*. If `BEGIN` failed, or if `ROLLBACK` itself fails, the client is marked for destruction and released with `release(true)` so the pool cannot hand out a connection in an unknown state.
8. **Release exactly once** — a single `release(destroyClient)` in a `finally` block, with the error logged if the release throws.

Do not retain `tx` after the callback settles: the client is back in the pool at that point, and later use of the handle is rejected rather than joined to the finished transaction.

**Complete Example**

```typescript
import {
  PostgreSQLDatabase,
  TransactionIsolation,
  TransactionOptions,
} from 'blendsdk/postgresql';

interface BalanceRow {
  balance: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const isolation: TransactionIsolation = 'serializable';
const transferOptions: TransactionOptions = { isolation };

try {
  const destinationBalance = await db.withTransaction(async (tx) => {
    await tx.executeQuery(
      'UPDATE accounts SET balance = balance - :amount WHERE id = :fromId',
      { amount: 100, fromId: 1 }
    );
    await tx.executeQuery(
      'UPDATE accounts SET balance = balance + :amount WHERE id = :toId',
      { amount: 100, toId: 2 }
    );

    const { records } = await tx.executeQuery<BalanceRow>(
      'SELECT balance FROM accounts WHERE id = :id',
      { id: 2 }
    );
    return records[0]?.balance ?? '0';
  }, transferOptions);

  console.log(`destination balance: ${destinationBalance}`);
} catch (error) {
  console.error('transfer rolled back', error);
} finally {
  await db.disconnect();
}
```

**Key Methods and Properties**

| Name | Type/Signature | Description |
| --- | --- | --- |
| `withTransaction` | `<T>(fn: (db: this) => Promise<T>, options?: TransactionOptions) => Promise<T>` | Acquires one client, wraps `fn` in BEGIN/COMMIT/ROLLBACK, resolves with `fn`'s return value. |
| `TransactionOptions.isolation` | `TransactionIsolation \| undefined` | Omit to use PostgreSQL's default (`read committed`). |
| `transactionClient` | `PoolClient \| null` (protected getter, deprecated) | Returns the active client inside a callback, `null` otherwise. Read-only — assignment is no longer supported. |

Isolation values and their SQL rendering

| `TransactionIsolation` | Rendered as |
| --- | --- |
| `'read committed'` | `BEGIN ISOLATION LEVEL READ COMMITTED` |
| `'repeatable read'` | `BEGIN ISOLATION LEVEL REPEATABLE READ` |
| `'serializable'` | `BEGIN ISOLATION LEVEL SERIALIZABLE` |

Transaction failure modes

| Condition | Error message |
| --- | --- |
| Database is shutting down | `Cannot start transaction: database is shutting down` |
| Transaction already active on this call chain | `Cannot start a nested transaction: a transaction is already active on this database handle.` |
| Context already settled | `Cannot start a transaction from a completed transaction context.` |
| Options are not a plain object | `Transaction options must be an object.` |
| Unknown isolation value | `Unsupported transaction isolation level. Use "read committed", "repeatable read", or "serializable".` |
| Query issued after the callback settled | `Cannot execute a query after the transaction has completed. Do not use the transaction handle outside its callback.` |

---

## 5. Query hooks — `beforeQuery` and `afterQuery`

**What It Is**

Query hooks are two optional functions that run around statement execution without touching the SQL itself: `beforeQuery` rewrites the bound parameter object on the way in, and `afterQuery` rewrites the returned rows on the way out. They are available in the third argument of `executeQuery()` and as chainable methods on every statement builder.

**How It Works**

Inside `executeOnClient()`, `beforeQuery` is applied *before* `yesql` converts the object into positional values, so hooks work with the same names you wrote in the statement. `afterQuery` is applied to `res.rows` after the driver returned them and before the result is normalized into `PostgreSQLQueryResult<T>`.

Parameter names depend on the statement type, which matters when a hook inspects a key:

| Statement | Parameter keys passed to `beforeQuery` |
| --- | --- |
| `executeQuery()` (raw SQL) | Exactly the keys you supplied. |
| INSERT | Column names (`name`, `email`, …) — `buildParameters()` returns the values object verbatim. |
| UPDATE | SET values under `v_<column>`, WHERE expression values under `p1`, `p2`, … (the `v_` prefix is what prevents collisions when a column appears on both sides). |
| DELETE | WHERE expression values only, under `p1`, `p2`, …. |

Hooks are also skipped for empty result sets: because `executeQuery()` returns early when `rowCount === 0`, `afterQuery` never sees an empty array from the driver.

**Complete Example**

```typescript
import { PostgreSQLDatabase, PostgreSQLQueryResult } from 'blendsdk/postgresql';

interface SafeUserRow {
  id: number;
  email: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  const result: PostgreSQLQueryResult<SafeUserRow> = await db.executeQuery<SafeUserRow>(
    'SELECT id, email, password_hash FROM users WHERE email = :email',
    { email: 'ADA@EXAMPLE.COM' },
    {
      beforeQuery: (params) => {
        const normalized = { ...params };
        if (typeof normalized.email === 'string') {
          normalized.email = normalized.email.toLowerCase();
        }
        return normalized;
      },
      afterQuery: (rows) =>
        rows.map((row) => {
          const safe: SafeUserRow = {
            id: Number(row.id),
            email: String(row.email).toLowerCase(),
          };
          return safe;
        }),
    }
  );

  for (const user of result.records) {
    console.log(`${user.id}: ${user.email}`);
  }
} finally {
  await db.disconnect();
}
```

The same hooks chain onto statement builders, where they are handed to `executeQuery()` when the terminator runs:

```typescript fragment
db.insert<User>('users')
  .values({ name: 'Ada', email: 'ADA@EXAMPLE.COM' })
  .beforeQuery((params) => ({ ...params, email: String(params.email).toLowerCase() }))
  .returning('*')
  .executeReturnSingle();
```

**Key Methods and Properties**

| Name | Type/Signature | Description |
| --- | --- | --- |
| `beforeQuery` | `(params: Record<string, any>) => Record<string, any>` | Transforms the bound parameter object before placeholder conversion. Return the object to execute with. |
| `afterQuery` | `(rows: any[]) => any[]` | Transforms returned rows after execution, before the result is normalized. Not called when `rowCount === 0`. |
| `.beforeQuery()` | `(fn) => this` (statement builders) | Attaches a parameter hook to one statement; chainable. |
| `.afterQuery()` | `(fn) => this` (statement builders) | Attaches a row hook to one statement; chainable. |

An exception thrown inside either hook propagates out of the statement terminator and, inside a transaction, causes a rollback.

---

## 6. `PostgreSQLInsertStatement<T>` — the INSERT builder

**What It Is**

`PostgreSQLInsertStatement<T>` is the dialect implementation returned by `db.insert<T>(tableName)`. It turns a `Partial<T>` value object into a parameterized `INSERT … VALUES … [RETURNING …]` statement. It extends `InsertStatement<T>` from `blendsdk/dbcore`, which owns the fluent lifecycle and the `execute*` terminators; this class contributes only `buildQuery()` and `buildParameters()`.

**How It Works**

`buildQuery()` reads `Object.keys(this._values)`:

- An empty values object throws before any SQL is produced: `Cannot build INSERT statement for table "users": no values provided. Call .values() with at least one column before executing.`
- The key list becomes both the column list and the placeholder list, so column order and parameter order always match:
  `INSERT INTO users (name, email, active) VALUES (:name, :email, :active)`.
- If `returning()` was called, `RETURNING <columns>` is appended (`'*'` or an explicit list).

`buildParameters()` returns `this._values` unchanged — the parameter names *are* the column names, which is what makes `beforeQuery` predictable on INSERTs. The terminators call `db.executeQuery()` with the built SQL and parameters, so hooks, named-parameter conversion and result normalization are shared with hand-written SQL.

**Complete Example**

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  active?: boolean;
  created_at?: Date;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  const created = await db
    .insert<User>('users')
    .values({ name: 'Ada Lovelace', email: 'ada@example.com', active: true })
    .returning('*')
    .executeReturnSingle();

  if (created) {
    console.log(`inserted user ${created.id} (${created.email})`);
  }

  const insertedRows = await db
    .insert<User>('users')
    .values({ name: 'Grace Hopper', email: 'grace@example.com' })
    .executeReturnCount();

  console.log(`inserted rows: ${insertedRows}`);
} finally {
  await db.disconnect();
}
```

Generated SQL for the first statement:

```sql
INSERT INTO users (name, email, active) VALUES (:name, :email, :active) RETURNING *
```

**Key Methods and Properties**

| Name | Type/Signature | Description |
| --- | --- | --- |
| `values` | `(values: Partial<T>) => this` | Sets the column/value map. Must be non-empty before building. |
| `returning` | `(columns: '*' \| (keyof T)[]) => this` | Appends a `RETURNING` clause. |
| `beforeQuery` | `(fn) => this` | Parameter hook; keys are column names. |
| `afterQuery` | `(fn) => this` | Row hook applied to returned rows. |
| `execute` | `() => Promise<PostgreSQLQueryResult<T> \| null>` | Runs the INSERT and returns the normalized result. |
| `executeReturnSingle` | `() => Promise<T \| null>` | Runs the INSERT and returns the first returned row, or `null`. |
| `executeReturnAll` | `() => Promise<T[]>` | Runs the INSERT and returns all returned rows (empty array if none). |
| `executeReturnCount` | `() => Promise<number>` | Runs the INSERT and returns the affected-row count. |
| `buildQuery` | `() => string` (protected) | Declared here: renders the INSERT SQL. |
| `buildParameters` | `() => Record<string, any>` (protected) | Declared here: returns `_values` verbatim. |

---

## 7. `PostgreSQLUpdateStatement<T, F>` — the UPDATE builder

**What It Is**

`PostgreSQLUpdateStatement<T, F>` is returned by `db.update<T, F>(tableName)`. It combines a `Partial<T>` SET payload, a `Partial<F>` or expression-based WHERE clause, and an optional `RETURNING` clause into one parameterized `UPDATE` statement.

**How It Works**

`buildQuery()` produces three independent pieces:

1. **SET** — one assignment per key of `_values`, each named with a `v_` prefix: `SET name = :v_name, active = :v_active`. An empty values object throws `Cannot build UPDATE statement for table "users": no values provided. Call .values() with at least one column before executing.`
2. **WHERE** — taken from the cached compiled expression (`getCompiledExpression()`). `filter({...})` and `filterByExpression(q => …)` both feed the same expression builder, whose parameters are named `p1`, `p2`, …. Omitting the filter produces an UPDATE without a WHERE clause, which affects **every row** in the table.
3. **RETURNING** — appended when `returning()` was called.

`buildParameters()` assembles the object the driver will see: `v_<column>` keys for SET values, then the expression's `p1…pN` keys merged in. The prefix scheme is what lets `values({ active: true }).filter({ active: false })` coexist — the test suite asserts exactly this case (`v_active: true` plus `p1: false`).

The compiled expression is cached, so calling `buildQuery()` and `buildParameters()` repeatedly does not recompile the WHERE clause.

**Complete Example**

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

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

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  const deactivated = await db
    .update<User, UserFilter>('users')
    .values({ active: false })
    .filter({ email: 'ada@example.com' })
    .returning('*')
    .executeReturnSingle();

  console.log(`deactivated: ${deactivated?.name ?? 'nobody'}`);

  const renamed = await db
    .update<User, UserFilter>('users')
    .values({ name: 'Ada Byron' })
    .filterByExpression((q) => q.where('id').equals(1))
    .executeReturnCount();

  console.log(`renamed rows: ${renamed}`);
} finally {
  await db.disconnect();
}
```

Generated SQL for the first statement:

```sql
UPDATE users SET active = :v_active WHERE email = :p1 RETURNING *
```

**Key Methods and Properties**

| Name | Type/Signature | Description |
| --- | --- | --- |
| `values` | `(values: Partial<T>) => this` | Sets the SET payload. Must be non-empty before building. |
| `filter` | `(conditions: Partial<F>) => this` | Builds the WHERE clause from an object of equality comparisons. |
| `filterByExpression` | `(fn: (q) => Expression) => this` | Builds the WHERE clause from the expression builder; supports `AND`/`OR`/`IN`/`LIKE`/`BETWEEN`/`IS NULL`. |
| `returning` | `(columns: '*' \| (keyof T)[]) => this` | Appends a `RETURNING` clause. |
| `beforeQuery` | `(fn) => this` | Parameter hook; SET values appear as `v_<column>`, filter values as `p1…pN`. |
| `afterQuery` | `(fn) => this` | Row hook applied to returned rows. |
| `execute` | `() => Promise<PostgreSQLQueryResult<T> \| null>` | Runs the UPDATE and returns the normalized result. |
| `executeReturnSingle` | `() => Promise<T \| null>` | Returns the first updated row, or `null` when nothing matched. |
| `executeReturnAll` | `() => Promise<T[]>` | Returns all updated rows (empty array when nothing matched). |
| `executeReturnCount` | `() => Promise<number>` | Returns the number of updated rows. |
| `buildQuery` | `() => string` (protected) | Declared here: renders SET, WHERE and RETURNING. |
| `buildParameters` | `() => Record<string, any>` (protected) | Declared here: merges `v_<column>` values with expression parameters. |

---

## 8. `PostgreSQLDeleteStatement<F>` — the DELETE builder

**What It Is**

`PostgreSQLDeleteStatement<F>` is returned by `db.delete<F>(tableName)`. It renders `DELETE FROM <table> [WHERE …] [RETURNING …]`, where the WHERE clause comes from a filter object or an expression.

**How It Works**

`buildQuery()` is the smallest of the three:

```typescript fragment
let queryStr = `DELETE FROM ${this.tableName}`;
const compiled = this.getCompiledExpression();
if (compiled?.sql) queryStr += ` WHERE ${compiled.sql}`;
if (this._returning.length > 0) queryStr += ` RETURNING ${this._returning.join(', ')}`;
```

There is no values payload, so the empty-values validation that INSERT and UPDATE perform does not exist here. That has an important consequence: **a DELETE without a filter is an unconditional delete of every row in the table.** `filter({})` and "never called `filter`" both compile to `DELETE FROM users` with no WHERE clause — the test suite calls this "bulk delete" and asserts it removes all rows.

`buildParameters()` only merges the compiled expression's parameters, so the keys are always `p1`, `p2`, … (or empty when no filter was set). If no rows match, the terminators behave like the other builders: `executeReturnSingle()` → `null`, `executeReturnAll()` → `[]`, `executeReturnCount()` → `0`, and `execute()` → a result with `rowCount: 0`.

**Complete Example**

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface SessionFilter {
  user_id?: number;
  revoked?: boolean;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  const revokedSessions = await db
    .delete<SessionFilter>('sessions')
    .filter({ user_id: 7, revoked: false })
    .returning('*')
    .executeReturnAll();

  console.log(`revoked ${revokedSessions.length} sessions`);
  for (const session of revokedSessions) {
    console.log(JSON.stringify(session));
  }

  const purged = await db
    .delete<SessionFilter>('sessions')
    .filterByExpression((q) => q.where('revoked').equals(true))
    .executeReturnCount();

  console.log(`purged ${purged} revoked sessions`);
} finally {
  await db.disconnect();
}
```

Generated SQL for the first statement:

```sql
DELETE FROM sessions WHERE user_id = :p1 AND revoked = :p2 RETURNING *
```

**Key Methods and Properties**

| Name | Type/Signature | Description |
| --- | --- | --- |
| `filter` | `(conditions: Partial<F>) => this` | Builds the WHERE clause from an object of equality comparisons. `{}` produces no WHERE clause. |
| `filterByExpression` | `(fn: (q) => Expression) => this` | Builds the WHERE clause from the expression builder. |
| `returning` | `(columns: '*' \| (keyof F)[]) => this` | Appends a `RETURNING` clause. |
| `beforeQuery` | `(fn) => this` | Parameter hook; keys are the expression parameters `p1…pN`. |
| `afterQuery` | `(fn) => this` | Row hook applied to returned rows. |
| `execute` | `() => Promise<PostgreSQLQueryResult<F> \| null>` | Runs the DELETE and returns the normalized result. |
| `executeReturnSingle` | `() => Promise<F \| null>` | Returns the first deleted row, or `null`. |
| `executeReturnAll` | `() => Promise<F[]>` | Returns all deleted rows (empty array when nothing matched). |
| `executeReturnCount` | `() => Promise<number>` | Returns the number of deleted rows. |
| `buildQuery` | `() => string` (protected) | Declared here: renders DELETE, WHERE and RETURNING. |
| `buildParameters` | `() => Record<string, any>` (protected) | Declared here: returns only the compiled expression parameters. |

---

## 9. Connection lifecycle and shutdown

**What It Is**

The lifecycle surface is `connect()`, `disconnect(timeoutMs?)`, the protected `forceDisconnect()`, and the `enableGracefulShutdown` constructor flag. Together they define how a pooled client is borrowed, how the pool drains, and what happens to work that arrives after shutdown has started.

**How It Works**

- **`connect()`** delegates straight to `pool.connect()` and resolves with a `PoolClient` that the caller owns. Use it only when you need driver-level behavior that `executeQuery()` does not expose — a raw client bypasses named-parameter conversion, query hooks and result normalization, and you must call `client.release()` yourself.
- **`disconnect(timeoutMs = 10000)`** sets `isShuttingDown = true` *before* awaiting anything, then races `pool.end()` against a timer:
  - While the pool is still draining, new `executeQuery()` and `withTransaction()` calls are already rejected — the test suite starts `disconnect()` and immediately asserts both rejection messages.
  - If `pool.end()` completes first, the timer is cleared and the promise resolves.
  - If the timer fires first, `forceDisconnect()` iterates the pool's client list, calls `release(true)` on every client (force-destroying connections even mid-transaction), clears the list, and the promise resolves.
  - The promise rejects only if `pool.end()` itself rejects.
- **`registerShutdownHandlers()`** (called from the constructor only when `enableGracefulShutdown` is `true`) attaches `process.on('SIGINT')` and `process.on('SIGTERM')` listeners that await `disconnect()`, log the outcome, and call `process.exit(0)` or `process.exit(1)`.

Because the shutdown flag is sticky, a `PostgreSQLDatabase` instance is not reusable after `disconnect()`; construct a new instance if you need to reconnect.

**Complete Example**

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
  poolConfig: { max: 10, connectionTimeoutMillis: 5000 },
});

// Driver-level access: the caller owns this client and must release it.
const client = await db.connect();
try {
  const raw = await client.query('SELECT 1 AS value');
  console.log(`raw driver row: ${JSON.stringify(raw.rows[0])}`);
} finally {
  client.release();
}

// Drain the pool with an explicit timeout.
await db.disconnect(5000);

// The shutdown flag is sticky: later work is rejected, not queued.
try {
  await db.executeQuery('SELECT 1');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
}
```

The final `catch` receives `Cannot execute query: database is shutting down`.

**Key Methods and Properties**

| Name | Type/Signature | Description |
| --- | --- | --- |
| `connect` | `() => Promise<PoolClient>` | Borrows one pooled client; the caller must release it. Bypasses hooks and named-parameter handling. |
| `disconnect` | `(timeoutMs?: number) => Promise<void>` | Sets the shutdown flag, then drains the pool; defaults to `10000` ms. |
| `forceDisconnect` | `() => Promise<void>` (protected) | Force-releases every pooled client with `release(true)`; used by the `disconnect()` timeout. |
| `registerShutdownHandlers` | `() => void` (protected) | Wires SIGINT/SIGTERM to `disconnect()` + `process.exit()`. |
| `isShuttingDown` | `boolean` (protected) | `true` from the moment `disconnect()` is invoked; gates `executeQuery()` and `withTransaction()`. |
| `enableGracefulShutdown` | `boolean` (config) | Opt-in signal handling. Never combine with `blendsdk/webafx`, which already owns those signals. |

For task-oriented recipes — opening a connection, running the first query, wiring builders into a request handler — continue with Basic Usage. For the feature-level summary and dependency map, see the Overview.

---

# postgresql Basic Usage

This guide takes you from installation to a first working query, then adds transactions, the three PostgreSQL statement builders, hook-based parameter/row shaping, configuration and error handling — one concept per step. The examples assume a reachable PostgreSQL server with a database named `appdb` and use top-level `await`, which the ESM build supports.

---

## Installation

`blendsdk/postgresql` ships inside the `blendsdk` umbrella package. Install the umbrella with your package manager:

```bash
# npm
npm install blendsdk

# yarn
yarn add blendsdk

# pnpm
pnpm add blendsdk
```

Then import from the package subpath — a subpath is an import path, not a separately installable package:

```typescript fragment
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
```

Do **not** run `npm install blendsdk/postgresql` or `npm install blendsdk/postgresql`; there is no standalone package behind this entry point.

**Requirements**

- Node.js **>= 22.0.0**.
- An **ESM** consumer: the entry point is `"type": "module"` and exposes only an `import` condition — `require('blendsdk/postgresql')` is not supported.
- A reachable PostgreSQL server. The adapter opens no socket at construction time; connectivity is exercised by the first query.
- `pg` (the node-postgres driver) and `yesql` (named-parameter rewriting) arrive as dependencies of `blendsdk`; you never install them separately.

**Working in the BlendSDK monorepo**

Repository-internal scripts are run with pnpm:

```bash
pnpm --filter blendsdk/postgresql build
pnpm --filter blendsdk/postgresql test:fast
pnpm --filter blendsdk/postgresql test
```

`test` starts and stops the Docker PostgreSQL fixture through the package's own `pnpm run db:up` / `pnpm run db:down` scripts before running the suite.

---

## Quick Start

Create the database instance, run one parameterized query, close the pool. Nine lines:

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost', port: 5432, database: 'appdb', user: 'appuser', pass: 'secret',
});
const { records } = await db.executeQuery<{ greeting: string }>('SELECT :name AS greeting', { name: 'BlendSDK' });
console.log(records[0]?.greeting);
await db.disconnect();
```

What happened:

- The constructor created a `pg.Pool`; the connection was opened lazily when `executeQuery()` ran.
- `:name` is a **named placeholder**. It was rewritten to the driver's positional form (`$1`) and the value was bound — never concatenated into the SQL text.
- `disconnect()` drained the pool so the process can exit cleanly.

---

## Fundamentals

Each step below introduces exactly one concept. Every example is complete: it carries its imports and closes the pool it opened.

### Step 1 — Create the database instance

The only stateful object in the package is `PostgreSQLDatabase`. Construct it **once per process** and share it; the async-local transaction context (Step 4) makes concurrent use safe.

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
console.log(`configured for ${config.database}`);
```

Important properties of the constructor:

- It stores the config and builds the pool. It does **not** connect, so an unreachable host will not throw here.
- `pass` is forwarded to the driver as `password`. There is no separate `password` option.
- `port` accepts a number or a numeric string (`'5432'`), because the adapter applies `Number(port)`.

The next level — pool tuning and a numeric-string port:

```typescript fragment
const config: PostgreSQLConfig = {
  host: 'localhost',
  port: '5432', // converted with Number()
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
  poolConfig: {
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  },
};
```

### Step 2 — Run the first query

`executeQuery()` is the single SQL primitive. It takes SQL text with `:named` placeholders, a plain object of values, and resolves with a normalized result.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  const result = await db.executeQuery<{ greeting: string }>(
    'SELECT :name AS greeting',
    { name: 'BlendSDK' }
  );
  console.log(result.records[0]?.greeting);
  console.log(`rows: ${result.rowCount}`);
} finally {
  await db.disconnect();
}
```

- Values are always bound through `yesql`; the SQL-injection test in the suite asserts that a hostile `:name` value is treated as data, never as SQL.
- Outside a transaction, `executeQuery()` acquires its own pooled client and releases it in a `finally` block. Ten concurrent queries on one instance never share or release each other's connection.

### Step 3 — Type the result and read metadata

The generic parameter types the rows; the returned `PostgreSQLQueryResult<T>` carries the rows, the affected-row count, and the driver's column metadata.

```typescript
import { PostgreSQLDatabase, PostgreSQLQueryResult } from 'blendsdk/postgresql';

interface OrderRow {
  id: number;
  customer: string;
  total: string;
  created_at: Date;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  const result: PostgreSQLQueryResult<OrderRow> = await db.executeQuery<OrderRow>(
    `SELECT id, customer, total, created_at
       FROM orders
      WHERE customer = :customer
        AND total >= :minTotal
      ORDER BY created_at DESC`,
    { customer: 'ada@example.com', minTotal: 50 }
  );

  for (const order of result.records) {
    console.log(`${order.id}: ${order.total}`);
  }
  console.log(`rows=${result.rowCount}`);
  console.log(`columns=${result.fields.map((field) => field.name).join(', ')}`);
} finally {
  await db.disconnect();
}
```

- `PostgreSQLQueryResult<T>` has `records: T[]`, `rowCount: number` and `fields: FieldDef[]`.
- `numeric` / `decimal` columns come back as **strings**, and `timestamp` / `date` columns as **`Date` objects** — reflect that in your row interfaces.
- When a query matches **zero rows**, the adapter returns `{ records: [], rowCount: 0, fields: [] }` immediately: `fields` is empty and `afterQuery` (Step 8) is not applied. Treat `rowCount === 0` as "no data", not as an error.

### Step 4 — Group work in a transaction

`withTransaction(fn, options?)` acquires one client, wraps the callback in `BEGIN` / `COMMIT` / `ROLLBACK`, and resolves with the callback's return value. Inside the callback, use the `tx` handle for every statement.

```typescript
import { PostgreSQLDatabase, TransactionOptions } from 'blendsdk/postgresql';

interface BalanceRow {
  balance: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const options: TransactionOptions = { isolation: 'serializable' };

try {
  const destinationBalance = await db.withTransaction(async (tx) => {
    await tx.executeQuery(
      'UPDATE accounts SET balance = balance - :amount WHERE id = :id',
      { amount: 100, id: 1 }
    );
    await tx.executeQuery(
      'UPDATE accounts SET balance = balance + :amount WHERE id = :id',
      { amount: 100, id: 2 }
    );

    const { records } = await tx.executeQuery<BalanceRow>(
      'SELECT balance FROM accounts WHERE id = :id',
      { id: 2 }
    );
    return records[0]?.balance ?? '0';
  }, options);

  console.log(`destination balance: ${destinationBalance}`);
} catch (error) {
  console.error('transfer rolled back', error);
} finally {
  await db.disconnect();
}
```

- Throwing inside the callback triggers `ROLLBACK` and rejects the promise with your error.
- Isolation is restricted to a validated union — anything else is rejected **before** a client is acquired:

```typescript fragment
type TransactionIsolation = 'read committed' | 'repeatable read' | 'serializable';
```

- Nested `withTransaction()` calls on the same async call chain fail fast; PostgreSQL has no nested `BEGIN`.
- Do not keep `tx` after the callback settles. The client is back in the pool, and a later query through that handle is rejected instead of silently joining another operation.

### Step 5 — Insert with the INSERT builder

`db.insert<T>()` returns `PostgreSQLInsertStatement<T>`. The parameter names *are* the column names, and `returning()` adds a `RETURNING` clause in the same round trip.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  active?: boolean;
  created_at?: Date;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  const created = await db
    .insert<User>('users')
    .values({ name: 'Ada Lovelace', email: 'ada@example.com', active: true })
    .returning('*')
    .executeReturnSingle();

  console.log(`inserted user ${created?.id} (${created?.email})`);

  const affected = await db
    .insert<User>('users')
    .values({ name: 'Grace Hopper', email: 'grace@example.com' })
    .executeReturnCount();

  console.log(`inserted rows: ${affected}`);
} finally {
  await db.disconnect();
}
```

Generated SQL for the first statement:

```sql
INSERT INTO users (name, email, active) VALUES (:name, :email, :active) RETURNING *
```

`values()` must contain at least one column before the statement is built; an empty object throws `Cannot build INSERT statement for table "users": no values provided…` (see Error Handling).

### Step 6 — Update with the UPDATE builder

`db.update<T, F>()` combines a SET payload (`Partial<T>`), a WHERE clause from a filter (`Partial<F>`) or expression, and an optional `RETURNING` clause.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

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

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const returningColumns: (keyof User)[] = ['id', 'name', 'email'];

try {
  const deactivated = await db
    .update<User, UserFilter>('users')
    .values({ active: false })
    .filter({ email: 'ada@example.com' })
    .returning(returningColumns)
    .executeReturnSingle();

  console.log(`deactivated: ${deactivated?.name ?? 'nobody'}`);

  const renamed = await db
    .update<User, UserFilter>('users')
    .values({ name: 'Ada Byron' })
    .filter({ id: 1 })
    .executeReturnCount();

  console.log(`renamed rows: ${renamed}`);
} finally {
  await db.disconnect();
}
```

Generated SQL for the first statement:

```sql
UPDATE users SET active = :v_active WHERE email = :p1 RETURNING id, name, email
```

- SET values are bound as `v_<column>`; WHERE values are bound as `p1`, `p2`, …. The prefix is why `values({ active: true }).filter({ active: false })` can coexist.
- **Caution:** omitting `filter()` — or calling `filter({})` — produces an UPDATE with no WHERE clause and modifies **every row** in the table.
- An empty `values()` object throws `Cannot build UPDATE statement for table "users": no values provided…`.

### Step 7 — Delete with the DELETE builder

`db.delete<F>()` renders `DELETE FROM <table> [WHERE …] [RETURNING …]`. There is no values payload, so the only inputs are the filter, an optional expression, and the returning list.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface SessionFilter {
  user_id?: number;
  revoked?: boolean;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  const revokedSessions = await db
    .delete<SessionFilter>('sessions')
    .filter({ user_id: 7, revoked: false })
    .returning('*')
    .executeReturnAll();

  console.log(`revoked ${revokedSessions.length} sessions`);

  const purged = await db
    .delete<SessionFilter>('sessions')
    .filter({ revoked: true })
    .executeReturnCount();

  console.log(`purged ${purged} revoked sessions`);
} finally {
  await db.disconnect();
}
```

Generated SQL for the first statement:

```sql
DELETE FROM sessions WHERE user_id = :p1 AND revoked = :p2 RETURNING *
```

**Caution:** the DELETE builder has no empty-values guard. `db.delete<SessionFilter>('sessions').executeReturnCount()` — no `filter()` at all — compiles to `DELETE FROM sessions` with no WHERE clause and deletes **every row**. `filter({})` behaves the same way. The test suite calls this "bulk delete"; use it deliberately.

### Step 8 — Shape parameters and rows with hooks

Hooks attach to a single statement: `beforeQuery` transforms the bound parameter object on the way in, `afterQuery` transforms returned rows on the way out. They are also available as the third argument of `executeQuery()`.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  active?: boolean;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  const created = await db
    .insert<User>('users')
    .values({ name: 'Ada Lovelace', email: 'ADA@EXAMPLE.COM' })
    .beforeQuery((params) => {
      if (typeof params.email === 'string') {
        params.email = params.email.toLowerCase();
      }
      return params;
    })
    .afterQuery((rows) =>
      rows.map((row) => ({ ...row, email: String(row.email).toLowerCase() }))
    )
    .returning('*')
    .executeReturnSingle();

  console.log(created);
} finally {
  await db.disconnect();
}
```

Parameter keys depend on the builder, which matters when a hook inspects a name:

| Statement source | Keys passed to `beforeQuery` |
| --- | --- |
| `db.executeQuery()` | Exactly the keys you supplied. |
| `db.insert()` | Column names (`name`, `email`, …). |
| `db.update()` | `v_<column>` for SET values, `p1…pN` for WHERE values. |
| `db.delete()` | `p1…pN` for WHERE values only. |

- `afterQuery` is **not** called when `rowCount === 0`; the empty result short-circuits before it.
- An exception thrown inside either hook propagates out of the terminator and, inside a transaction, causes a rollback.

### Step 9 — Close the pool when the process ends

`disconnect(timeoutMs = 10000)` flips a sticky shutdown flag and drains the pool. While the pool is draining, new queries and transactions are rejected immediately.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  const { rowCount } = await db.executeQuery('SELECT 1 AS value');
  console.log(`connected, rowCount=${rowCount}`);
} finally {
  await db.disconnect(5000); // wait at most 5 s, then force-release clients
}

try {
  await db.executeQuery('SELECT 1 AS value');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}
```

The final `catch` logs `Cannot execute query: database is shutting down`. Notes:

- If `pool.end()` does not finish within the timeout, `forceDisconnect()` force-releases every pooled client — including clients mid-transaction — and the promise resolves.
- The shutdown flag is sticky: a `PostgreSQLDatabase` is not reusable after `disconnect()`. Construct a new instance if you must reconnect.
- `enableGracefulShutdown: true` wires `SIGINT`/`SIGTERM` to `disconnect()`. **Never** combine it with a `WebApplication` from `blendsdk/webafx`, which owns those signals; use it only for standalone processes.

---

## Configuration

Configuration is a single `PostgreSQLConfig` object passed to the constructor. PostgreSQL-specific pool tuning lives in the nested `PoolConfig`.

**`PostgreSQLConfig`**

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `host` | `string` | — (required) | Server hostname forwarded to `pg.Pool`. |
| `port` | `number \| string` | `5432` (driver default) | Server port; numeric strings are converted with `Number()`. |
| `database` | `string` | — (required) | Database name. |
| `user` | `string` | — (required) | Login role. |
| `pass` | `string` | — (required) | Password; forwarded to the driver as `password`. |
| `poolConfig` | `PoolConfig \| undefined` | `undefined` | Pool tuning; omitted fields fall back to the driver defaults below. |
| `enableGracefulShutdown` | `boolean \| undefined` | `false` | Registers SIGINT/SIGTERM handlers that call `disconnect()` and exit. Do not use with `blendsdk/webafx`. |

**`PoolConfig`**

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `max` | `number` | `10` | Maximum number of clients in the pool. |
| `idleTimeoutMillis` | `number` | `30000` | Milliseconds an idle client may sit before it is closed. |
| `connectionTimeoutMillis` | `number` | `0` (no timeout) | Milliseconds to wait for a new connection before failing. |

Only the fields above are forwarded to `pg.Pool`. Connection strings and TLS options are **not** part of `PostgreSQLConfig`.

```typescript
import { PoolConfig, PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const poolConfig: PoolConfig = {
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: '5432',
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
  poolConfig,
};

const db = new PostgreSQLDatabase(config);

try {
  const { rowCount } = await db.executeQuery('SELECT 1 AS value');
  console.log(`ready, rowCount=${rowCount}`);
} finally {
  await db.disconnect();
}
```

Standalone graceful shutdown — opt in only outside the web framework:

```typescript fragment
const standaloneConfig: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
  enableGracefulShutdown: true,
};
```

---

## Error Handling

Every failure is delivered as a thrown error or a rejected promise; nothing is returned in-band. Three sources exist: validation inside the adapter, the PostgreSQL driver, and your own hooks or transaction callbacks.

**Errors raised by the adapter**

| Message | Raised by | Meaning |
| --- | --- | --- |
| `Cannot execute query: database is shutting down` | `executeQuery()` | `disconnect()` has been called; the pool is draining. |
| `Cannot start transaction: database is shutting down` | `withTransaction()` | Shutdown started before the transaction could begin. |
| `Cannot start a nested transaction: a transaction is already active on this database handle.` | `withTransaction()` | A transaction is already open on this async call chain. |
| `Cannot start a transaction from a completed transaction context.` | `withTransaction()` | A detached task tried to start a transaction from a settled context. |
| `Transaction options must be an object.` | `withTransaction()` | The second argument was not a plain object (checked before a client is acquired). |
| `Unsupported transaction isolation level. Use "read committed", "repeatable read", or "serializable".` | `withTransaction()` | The isolation value is outside the allowlist. |
| `Cannot execute a query after the transaction has completed. Do not use the transaction handle outside its callback.` | `executeQuery()` | The `tx` handle was retained past its callback. |
| `Cannot build INSERT statement for table "<table>": no values provided…` | INSERT terminator | `values()` was never called or was empty. |
| `Cannot build UPDATE statement for table "<table>": no values provided…` | UPDATE terminator | `values()` was never called or was empty. |

**Errors originating elsewhere**

| Error | Origin | How to handle |
| --- | --- | --- |
| Driver query errors (`DatabaseError`, an `Error` subclass) | PostgreSQL server | `error.code` holds the SQLSTATE — `23505` unique violation, `23503` foreign key violation, `42P01` undefined table — with `error.constraint` / `error.detail` adding context. |
| Socket errors (e.g. `ECONNREFUSED`) | Node.js network layer | Surface on the **first query**, not at construction; the pool is lazy. |
| Errors thrown by `beforeQuery` / `afterQuery` | Application code | Rethrown unchanged; inside a transaction they cause a rollback. |
| Errors thrown by the `withTransaction` callback | Application code | Rethrown unchanged after `ROLLBACK`. |

Empty results are **not** errors: the terminators resolve with `execute()` → a result carrying `rowCount: 0`, `executeReturnSingle()` → `null`, `executeReturnAll()` → `[]`, and `executeReturnCount()` → `0`.

The example below runs a transaction that always violates a unique constraint, inspects the SQLSTATE structurally, and still closes the pool:

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

function hasSqlState(error: unknown, state: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code === state
  );
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  await db.withTransaction(async (tx) => {
    await tx.executeQuery(
      'CREATE TEMP TABLE signup (id serial PRIMARY KEY, email text UNIQUE NOT NULL)'
    );
    await tx.executeQuery('INSERT INTO signup (email) VALUES (:email)', {
      email: 'ada@example.com',
    });
    await tx.executeQuery('INSERT INTO signup (email) VALUES (:email)', {
      email: 'ada@example.com',
    });
  });
} catch (error) {
  if (hasSqlState(error, '23505')) {
    console.error('duplicate email detected; the transaction was rolled back');
  } else if (error instanceof Error) {
    console.error(`database operation failed: ${error.message}`);
  } else {
    console.error(`unexpected rejection: ${String(error)}`);
  }
} finally {
  await db.disconnect();
}
```

The second insert raises SQLSTATE `23505`; `withTransaction()` issues `ROLLBACK` and rethrows, so the catch block sees the driver error unchanged. Only the unique-violation branch executes, and `disconnect()` runs in the `finally` block regardless of the outcome.

For a detailed discussion of the execution pipeline, isolation levels and builder internals, continue with Core Concepts; for the package summary and dependency map, see the Overview.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
