> **Package**: `blendsdk/postgresql`

# postgresql API Reference

The package ships inside the `blendsdk` umbrella (`npm install blendsdk`); import its symbols from the adapter subpath. This document covers every symbol exported from `src/index.ts`. The PostgreSQL adapter extends the engine-neutral contracts of `blendsdk/dbcore` — base statement classes, expression compilation, the `execute*` terminators, hooks, and configuration types all originate there and are referenced (not re-exported) here. Driver types from `pg` (`Pool`, `PoolClient`, `FieldDef`) appear in signatures but are likewise not re-exported.

---

## Exports at a Glance

| Export | Kind | Declared in | Description |
|--------|------|-------------|-------------|
| `PostgreSQLDatabase` | class | `src/database.ts` | PostgreSQL adapter: pool management, query execution, async-local transactions, statement factories. |
| `PostgreSQLConfig` | interface | `src/database.ts` | Adapter configuration; extends `DatabaseConfig` with `poolConfig` and `enableGracefulShutdown`. |
| `PoolConfig` | interface | `src/database.ts` | Connection-pool tuning forwarded to `pg.Pool`. |
| `PostgreSQLQueryResult<T>` | interface | `src/database.ts` | Query result; extends `QueryResult<T>` with the driver's `fields` column metadata. |
| `TransactionIsolation` | type alias | `src/database.ts` | Allowlisted isolation levels accepted by `withTransaction()`. |
| `TransactionOptions` | interface | `src/database.ts` | Per-transaction settings. |
| `PostgreSQLInsertStatement<TableType>` | class | `src/insert-statement.ts` | PostgreSQL INSERT builder; extends `InsertStatement<TableType>`. |
| `PostgreSQLUpdateStatement<TableType, FilterType>` | class | `src/update-statement.ts` | PostgreSQL UPDATE builder; extends `UpdateStatement<TableType, FilterType>`. |
| `PostgreSQLDeleteStatement<FilterType>` | class | `src/delete-statement.ts` | PostgreSQL DELETE builder; extends `DeleteStatement<FilterType>`. |

---

## `PostgreSQLDatabase`

Provides PostgreSQL database connectivity and query execution. Manages a `pg.Pool`, executes named-parameter SQL, runs transactions with async-local client isolation, and manufactures the three PostgreSQL statement builders. It extends `Database` from `blendsdk/dbcore` and overrides the engine-specific members.

```typescript fragment
class PostgreSQLDatabase extends Database {
  protected pool: Pool;
  protected readonly transactionContext: AsyncLocalStorage<TransactionContext>;
  protected get transactionClient(): PoolClient | null;
  protected isShuttingDown: boolean;

  constructor(config: PostgreSQLConfig);

  withTransaction<T>(fn: (db: this) => Promise<T>, options?: TransactionOptions): Promise<T>;
  executeQuery<R>(
    query: string,
    params?: Record<string, any>,
    options?: ExecuteQueryOptions
  ): Promise<PostgreSQLQueryResult<R>>;
  connect(): Promise<PoolClient>;
  disconnect(timeoutMs?: number): Promise<void>;

  insert<T>(tableName: string): InsertStatement<T>;
  update<T, F>(tableName: string): UpdateStatement<T, F>;
  delete<F>(tableName: string): DeleteStatement<F>;

  protected executeOnClient<R>(
    client: PoolClient,
    query: string,
    params: Record<string, any>,
    options: ExecuteQueryOptions
  ): Promise<PostgreSQLQueryResult<R>>;
  protected forceDisconnect(): Promise<void>;
  protected registerShutdownHandlers(): void;
}
```

`TransactionContext` is internal to the package; it is the type parameter of `transactionContext` only.

### Constructor

```typescript fragment
constructor(config: PostgreSQLConfig);
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `PostgreSQLConfig` | Yes | — | Connection coordinates plus optional pool tuning and shutdown flag. |

Behavior:

- Stores the config (available as `this.config` through the base class) and creates the `pg.Pool` with `database`, `host`, `password` (from `pass`), `port` (converted with `Number()` when truthy), `user`, and the three `poolConfig` values.
- **Does not connect.** Connections are acquired lazily by `executeQuery()`, `withTransaction()`, and `connect()`.
- When `config.enableGracefulShutdown` is `true`, calls `registerShutdownHandlers()` to wire `SIGINT`/`SIGTERM`.

### Properties

| Property | Type | Visibility | Description |
|----------|------|------------|-------------|
| `pool` | `Pool` | protected | The node-postgres connection pool created in the constructor. |
| `transactionContext` | `AsyncLocalStorage<TransactionContext>` (readonly) | protected | Carries the owning client through one transaction's async call chain; keeps concurrent transactions isolated on a shared instance. |
| `transactionClient` | `PoolClient \| null` (getter) | protected, deprecated | Read-only compatibility accessor. Returns the client only while its context is active and the database is not shutting down; `null` otherwise. Assignment is no longer supported. |
| `isShuttingDown` | `boolean` | protected | `false` initially; set to `true` by `disconnect()` and never reset. Gates `executeQuery()` and `withTransaction()`. |

### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `executeQuery` | `<R>(query: string, params?: Record<string, any>, options?: ExecuteQueryOptions) => Promise<PostgreSQLQueryResult<R>>` | `Promise<PostgreSQLQueryResult<R>>` | Executes one named-parameter query; joins the active transaction when called from inside `withTransaction()`. |
| `withTransaction` | `<T>(fn: (db: this) => Promise<T>, options?: TransactionOptions) => Promise<T>` | `Promise<T>` | Runs `fn` in BEGIN/COMMIT/ROLLBACK on a dedicated, async-scoped client. |
| `connect` | `() => Promise<PoolClient>` | `Promise<PoolClient>` | Borrows one pooled client; the caller owns it and must `release()` it. |
| `disconnect` | `(timeoutMs?: number) => Promise<void>` | `Promise<void>` | Shuts the pool down; defaults to `10000` ms with a forced-release fallback. |
| `insert` | `<T>(tableName: string) => InsertStatement<T>` | `InsertStatement<T>` | INSERT builder factory; runtime instance is `PostgreSQLInsertStatement<T>`. |
| `update` | `<T, F>(tableName: string) => UpdateStatement<T, F>` | `UpdateStatement<T, F>` | UPDATE builder factory; runtime instance is `PostgreSQLUpdateStatement<T, F>`. |
| `delete` | `<F>(tableName: string) => DeleteStatement<F>` | `DeleteStatement<F>` | DELETE builder factory; runtime instance is `PostgreSQLDeleteStatement<F>`. |

### Protected Members

| Member | Signature / Type | Description |
|--------|------------------|-------------|
| `executeOnClient` | `<R>(client: PoolClient, query: string, params: Record<string, any>, options: ExecuteQueryOptions) => Promise<PostgreSQLQueryResult<R>>` | The single SQL choke point: applies `beforeQuery`, converts named placeholders with `yesql`, calls `client.query()`, applies `afterQuery`, normalizes the result. The caller owns the client. |
| `forceDisconnect` | `() => Promise<void>` | Force-releases every pooled client with `release(true)` and clears the pool's client list. Invoked by the `disconnect()` timeout. |
| `registerShutdownHandlers` | `() => void` | Attaches `SIGINT`/`SIGTERM` listeners that await `disconnect()` and call `process.exit(0)` (or `exit(1)` on failure). Called from the constructor only when `enableGracefulShutdown` is set. |

### `executeQuery<R>()`

```typescript fragment
executeQuery<R>(
  query: string,
  params?: Record<string, any>,
  options?: ExecuteQueryOptions
): Promise<PostgreSQLQueryResult<R>>;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | Yes | — | SQL text with optional named placeholders (`:name`). |
| `params` | `Record<string, any>` | No | `{}` | Values for the named placeholders. |
| `options` | `ExecuteQueryOptions` | No | `{}` | `beforeQuery` / `afterQuery` hooks. |

Execution order:

1. Rejects when `isShuttingDown` is set: `Cannot execute query: database is shutting down`.
2. **Client selection** — if the current async call chain has a transaction context, the query runs on that client; a closed context rejects with `Cannot execute a query after the transaction has completed. Do not use the transaction handle outside its callback.` Otherwise the method acquires its own client via `connect()` and releases it in a `finally` block, so concurrent calls never share or release each other's connection.
3. **Pipeline on the selected client** (`executeOnClient()`): `beforeQuery` transforms the parameter object → `yesql` rewrites `:name` placeholders into the driver's positional `$1…$n` form (values are always bound, never concatenated) → `client.query(text, values)` → zero-row short-circuit → `afterQuery` transforms rows → result normalization.
4. **Zero-row short-circuit** — when the driver reports `rowCount === 0`, the method returns `{ records: [], rowCount: 0, fields: [] }` immediately and `afterQuery` is **not** applied.
5. **Normalization** — `records` is the driver's row array (typed `R[]`), `rowCount` is `res.rowCount || 0`, `fields` is `res.fields ?? []`.

Driver errors (syntax errors, constraint violations) and exceptions thrown inside hooks propagate unchanged.

### `withTransaction<T>()`

```typescript fragment
withTransaction<T>(
  fn: (db: this) => Promise<T>,
  options?: TransactionOptions
): Promise<T>;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `fn` | `(db: this) => Promise<T>` | Yes | — | Callback executed inside the transaction; receives the same `PostgreSQLDatabase` instance (`tx === db`). |
| `options` | `TransactionOptions` | No | `undefined` | Isolation level for this transaction; omitted means plain `BEGIN` (server default). |

Behavior:

1. **Shutdown guard** — throws `Cannot start transaction: database is shutting down` when `isShuttingDown` is set.
2. **Nesting guard** — fails fast if the current async call chain already carries a transaction context. PostgreSQL has no nested `BEGIN`; silently reusing the outer transaction would hide the mistake.
3. **Validation before acquisition** — a non-object options argument throws `Transaction options must be an object.`; an isolation value outside the allowlist throws `Unsupported transaction isolation level. Use "read committed", "repeatable read", or "serializable".` The allowlisted value is mapped to its SQL spelling, so the option can never inject text into `BEGIN`.
4. **Acquire and begin** — `connect()` then `BEGIN` or `BEGIN ISOLATION LEVEL <level>`.
5. **Run with context** — the callback runs inside `transactionContext.run(...)`, so every statement issued by the callback (even through a later `await`) executes on the transaction client. Queries started in unrelated concurrent tasks do not join it.
6. **Close the context before COMMIT** — `context.active` is set to `false` and `context.client` to `null`, so a detached task that outlives the callback is rejected instead of using a released client.
7. **Commit or roll back** — `COMMIT` on success. On failure, `ROLLBACK` is issued only if `BEGIN` succeeded; if `BEGIN` failed, or if `ROLLBACK` itself fails (logged via `console.error`), the client is marked for destruction.
8. **Release exactly once** — a single `client.release(destroyClient)` in a `finally` block; release errors are logged via `console.error` and do not replace the original error.

Returns the callback's resolved value. The original callback error is rethrown after rollback.

Do not retain `tx` after the callback settles — the client is back in the pool at that point and later use is rejected, not joined to the finished transaction.

### `connect()`

```typescript fragment
connect(): Promise<PoolClient>;
```

Delegates to `pool.connect()` and resolves with a pooled client owned by the caller. Use it only for driver-level needs: a raw client bypasses named-parameter conversion, query hooks, and result normalization, and the caller must call `client.release()`.

### `disconnect()`

```typescript fragment
disconnect(timeoutMs?: number): Promise<void>;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `timeoutMs` | `number` | No | `10000` | Maximum time to wait for a graceful pool drain before force-releasing clients. |

Behavior:

- Sets `isShuttingDown = true` **before** awaiting anything. From that moment, `executeQuery()` and `withTransaction()` reject with their shutdown messages; work is not queued.
- Races `pool.end()` against a timer. If the pool drains first, the timer is cleared and the promise resolves. If the timer fires first, `forceDisconnect()` force-releases every pooled client (even mid-transaction) and the promise resolves.
- Rejects only when `pool.end()` itself rejects.
- The shutdown flag is sticky: a `PostgreSQLDatabase` instance is not reusable after `disconnect()`; construct a new instance to reconnect.

### Statement Factories

| Method | Declared return | Runtime instance | Description |
|--------|-----------------|------------------|-------------|
| `insert<T>(tableName)` | `InsertStatement<T>` | `PostgreSQLInsertStatement<T>` | Builds `INSERT INTO <table> (cols) VALUES (:cols) [RETURNING …]`. |
| `update<T, F>(tableName)` | `UpdateStatement<T, F>` | `PostgreSQLUpdateStatement<T, F>` | Builds `UPDATE <table> SET col = :v_col [WHERE …] [RETURNING …]`. |
| `delete<F>(tableName)` | `DeleteStatement<F>` | `PostgreSQLDeleteStatement<F>` | Builds `DELETE FROM <table> [WHERE …] [RETURNING …]`. |

The declared return types are the base builder interfaces from `blendsdk/dbcore`; the concrete classes are also constructible directly as `new PostgreSQLInsertStatement<T>(tableName, db)` etc., but the factories are the intended entry point.

### Inherited Query Builders

Two members of the base `Database` class round out the surface. Their authoritative signatures live in the `blendsdk/dbcore` API reference:

| Member | Usage | Description |
|--------|-------|-------------|
| `from` | `db.from<User>('users')` | Returns a `FromStatement` for building `SELECT` queries (`select([...])`, `select({ alias: 'expr' })`, `byExpression(...)`, `execute()`). |
| `selectAll` | `db.selectAll('users')` | Returns a `FromStatement` preconfigured to select all columns. |

### Complete Example

```typescript
import {
  PostgreSQLConfig,
  PostgreSQLDatabase,
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
  poolConfig: { max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 },
};

const db = new PostgreSQLDatabase(config);

try {
  const greeting: PostgreSQLQueryResult<GreetingRow> = await db.executeQuery<GreetingRow>(
    'SELECT :name AS greeting',
    { name: 'BlendSDK' }
  );
  console.log(greeting.records[0]?.greeting);

  const value = await db.withTransaction(
    async (tx) => {
      const { records } = await tx.executeQuery<{ value: number }>('SELECT 42 AS value');
      return records[0]?.value ?? 0;
    },
    { isolation: 'serializable' }
  );

  console.log(`transaction returned ${value}`);
} finally {
  await db.disconnect(5000);
}
```

---

## `PostgreSQLInsertStatement<TableType>`

PostgreSQL-specific INSERT builder returned by `db.insert<TableType>(tableName)`. Extends `InsertStatement<TableType>` from `blendsdk/dbcore`, which owns the fluent lifecycle, hooks, and the `execute*` terminators; this class contributes only the PostgreSQL SQL rendering.

- **Generic `TableType`** — the row shape of the target table. `.values()` accepts `Partial<TableType>`; terminators return `TableType` rows.
- **Construction** — inherited `(tableName: string, db: Database)`; normally created via `db.insert<TableType>()`.

```typescript fragment
class PostgreSQLInsertStatement<TableType> extends InsertStatement<TableType> {
  protected buildQuery(): string;
  protected buildParameters(): Record<string, any>;
}
```

### Methods Declared in This Class (protected)

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `buildQuery` | `buildQuery(): string` | `string` | Renders `INSERT INTO <table> (cols) VALUES (:cols) [RETURNING …]`. Throws for an empty values object. |
| `buildParameters` | `buildParameters(): Record<string, any>` | `Record<string, any>` | Returns the values object verbatim — parameter names *are* the column names. |

### Inherited Fluent API (`InsertStatement<TableType>`)

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `values` | `values(values: Partial<TableType>) => this` | `this` | Sets the column/value map; must be non-empty before building. |
| `returning` | `returning(columns: '*' \| (keyof TableType)[]) => this` | `this` | Appends a `RETURNING` clause (`RETURNING *` or an explicit column list). |
| `beforeQuery` | `beforeQuery(fn: (params: Record<string, any>) => Record<string, any>) => this` | `this` | Parameter hook; keys are the column names. |
| `afterQuery` | `afterQuery(fn: (rows: any[]) => any[]) => this` | `this` | Row hook applied to returned rows. |
| `execute` | `execute() => Promise<PostgreSQLQueryResult<TableType> \| null>` | `Promise<PostgreSQLQueryResult<TableType> \| null>` | Runs the INSERT and returns the normalized result. |
| `executeReturnSingle` | `executeReturnSingle() => Promise<TableType \| null>` | `Promise<TableType \| null>` | First `RETURNING` row, or `null` when nothing was returned. |
| `executeReturnAll` | `executeReturnAll() => Promise<TableType[]>` | `Promise<TableType[]>` | All `RETURNING` rows; `[]` when none. |
| `executeReturnCount` | `executeReturnCount() => Promise<number>` | `Promise<number>` | Number of inserted rows. |

### SQL Rendering and Behavior

- **Aligned order** — the column list and the placeholder list derive from the same `Object.keys(values)` call, so column order and parameter order always match:

  ```sql
  INSERT INTO users (name, email, active) VALUES (:name, :email, :active) RETURNING id, name, email
  ```

- **Empty values throw** — `Cannot build INSERT statement for table "<tableName>": no values provided. Call .values() with at least one column before executing.` The throw occurs during query building; when the statement is run through a terminator, the returned promise rejects.
- **Parameter names are column names** — because `buildParameters()` returns `_values` unchanged, `beforeQuery` sees exactly the keys you passed to `values()`.
- **Terminators delegate to `db.executeQuery()`**, so named-placeholder conversion, hooks, and result normalization are identical to hand-written SQL.

### Complete Example

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
    .returning(['id', 'name', 'email'] as (keyof User)[])
    .executeReturnSingle();

  console.log(`created: ${created?.id ?? 'none'} ${created?.email ?? ''}`);

  const inserted = await db
    .insert<User>('users')
    .values({ name: 'Grace Hopper', email: 'grace@example.com' })
    .executeReturnCount();

  console.log(`inserted rows: ${inserted}`);
} finally {
  await db.disconnect();
}
```

---

## `PostgreSQLUpdateStatement<TableType, FilterType>`

PostgreSQL-specific UPDATE builder returned by `db.update<TableType, FilterType>(tableName)`. Combines a `Partial<TableType>` SET payload, an object- or expression-based WHERE clause, and an optional `RETURNING` clause. Extends `UpdateStatement<TableType, FilterType>` from `blendsdk/dbcore`.

- **Generic `TableType`** — the SET payload shape (`values()` takes `Partial<TableType>`); terminators return `TableType` rows.
- **Generic `FilterType`** — the WHERE criteria shape for `filter()`.
- **Construction** — inherited `(tableName: string, db: Database)`; normally created via `db.update<TableType, FilterType>()`.

```typescript fragment
class PostgreSQLUpdateStatement<TableType, FilterType> extends UpdateStatement<
  TableType,
  FilterType
> {
  protected buildQuery(): string;
  protected buildParameters(): Record<string, any>;
}
```

### Methods Declared in This Class (protected)

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `buildQuery` | `buildQuery(): string` | `string` | Renders `UPDATE <table> SET col = :v_col [, …] [WHERE …] [RETURNING …]`. Throws for an empty values object. |
| `buildParameters` | `buildParameters(): Record<string, any>` | `Record<string, any>` | Merges SET values under `v_<column>` with the compiled expression's `p1…pN` parameters. |

### Inherited Fluent API (`UpdateStatement<TableType, FilterType>`)

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `values` | `values(values: Partial<TableType>) => this` | `this` | Sets the SET payload; must be non-empty before building. |
| `filter` | `filter(conditions: Partial<FilterType>) => this` | `this` | Builds the WHERE clause from an object of equality comparisons. `{}` produces no WHERE clause. |
| `filterByExpression` | `filterByExpression(fn: (q) => Expression) => this` | `this` | Builds the WHERE clause from the expression builder; supports `AND`/`OR`/`IN`/`LIKE`/`BETWEEN`/`IS NULL`. |
| `returning` | `returning(columns: '*' \| (keyof TableType)[]) => this` | `this` | Appends a `RETURNING` clause. |
| `beforeQuery` | `beforeQuery(fn: (params: Record<string, any>) => Record<string, any>) => this` | `this` | Parameter hook; SET values appear as `v_<column>`, filter values as `p1…pN`. |
| `afterQuery` | `afterQuery(fn: (rows: any[]) => any[]) => this` | `this` | Row hook applied to returned rows. |
| `execute` | `execute() => Promise<PostgreSQLQueryResult<TableType> \| null>` | `Promise<PostgreSQLQueryResult<TableType> \| null>` | Runs the UPDATE and returns the normalized result. |
| `executeReturnSingle` | `executeReturnSingle() => Promise<TableType \| null>` | `Promise<TableType \| null>` | First updated row, or `null` when nothing matched. |
| `executeReturnAll` | `executeReturnAll() => Promise<TableType[]>` | `Promise<TableType[]>` | All updated rows; `[]` when nothing matched. |
| `executeReturnCount` | `executeReturnCount() => Promise<number>` | `Promise<number>` | Number of updated rows. |

### SQL Rendering and Behavior

- **SET clause** — one assignment per key of `_values`, each with a `v_` prefix on the parameter name:

  ```sql
  UPDATE users SET name = :v_name, active = :v_active WHERE email = :p1 RETURNING *
  ```

- **Empty values throw** — `Cannot build UPDATE statement for table "<tableName>": no values provided. Call .values() with at least one column before executing.`
- **WHERE clause** — produced only when `filter()` or `filterByExpression()` supplied a compiled expression; the compiled expression is cached (`getCompiledExpression()`), so repeated `buildQuery()` / `buildParameters()` calls do not recompile. **Omitting the filter produces an UPDATE without a WHERE clause, which affects every row in the table.**
- **No parameter collisions** — SET values use `v_<column>` and WHERE values use `p1…pN`, so `values({ active: true }).filter({ active: false })` yields `{ v_active: true, p1: false }`.
- **RETURNING** — appended when `returning()` was called; required for `executeReturnSingle()` / `executeReturnAll()` to return row data.

### Complete Example

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
  const updated = await db
    .update<User, UserFilter>('users')
    .values({ active: false })
    .filter({ email: 'ada@example.com' })
    .returning('*')
    .executeReturnSingle();

  console.log(`deactivated: ${updated?.name ?? 'no rows'}`);

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

---

## `PostgreSQLDeleteStatement<FilterType>`

PostgreSQL-specific DELETE builder returned by `db.delete<FilterType>(tableName)`. Renders `DELETE FROM <table> [WHERE …] [RETURNING …]`. Extends `DeleteStatement<FilterType>` from `blendsdk/dbcore`.

- **Generic `FilterType`** — the WHERE criteria shape for `filter()`; the class's terminators also type returned `RETURNING` rows as `FilterType`, so pick a type that covers the columns you return (the package's tests use their filter interfaces for `returning('*')`).
- **Construction** — inherited `(tableName: string, db: Database)`; normally created via `db.delete<FilterType>()`.

```typescript fragment
class PostgreSQLDeleteStatement<FilterType> extends DeleteStatement<FilterType> {
  protected buildQuery(): string;
  protected buildParameters(): Record<string, any>;
}
```

### Methods Declared in This Class (protected)

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `buildQuery` | `buildQuery(): string` | `string` | Renders `DELETE FROM <table> [WHERE …] [RETURNING …]`. |
| `buildParameters` | `buildParameters(): Record<string, any>` | `Record<string, any>` | Returns only the compiled expression's parameters (`p1…pN`), or `{}` when no filter was set. |

### Inherited Fluent API (`DeleteStatement<FilterType>`)

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `filter` | `filter(conditions: Partial<FilterType>) => this` | `this` | Builds the WHERE clause from an object of equality comparisons. `{}` produces no WHERE clause. |
| `filterByExpression` | `filterByExpression(fn: (q) => Expression) => this` | `this` | Builds the WHERE clause from the expression builder. |
| `returning` | `returning(columns: '*' \| (keyof FilterType)[]) => this` | `this` | Appends a `RETURNING` clause. |
| `beforeQuery` | `beforeQuery(fn: (params: Record<string, any>) => Record<string, any>) => this` | `this` | Parameter hook; keys are the expression parameters `p1…pN`. |
| `afterQuery` | `afterQuery(fn: (rows: any[]) => any[]) => this` | `this` | Row hook applied to returned rows. |
| `execute` | `execute() => Promise<PostgreSQLQueryResult<FilterType> \| null>` | `Promise<PostgreSQLQueryResult<FilterType> \| null>` | Runs the DELETE and returns the normalized result. |
| `executeReturnSingle` | `executeReturnSingle() => Promise<FilterType \| null>` | `Promise<FilterType \| null>` | First deleted row, or `null` when nothing matched. |
| `executeReturnAll` | `executeReturnAll() => Promise<FilterType[]>` | `Promise<FilterType[]>` | All deleted rows; `[]` when nothing matched. |
| `executeReturnCount` | `executeReturnCount() => Promise<number>` | `Promise<number>` | Number of deleted rows. |

### SQL Rendering and Behavior

- **No values payload** — there is nothing to validate, so the empty-values check that INSERT and UPDATE perform does not exist here.
- **No filter means every row** — `filter({})` and "never called `filter`" both compile to `DELETE FROM users` with no WHERE clause; the package's tests call this "bulk delete" and assert it removes all rows. Always provide a filter when a partial delete is intended.

  ```sql
  DELETE FROM sessions WHERE user_id = :p1 AND revoked = :p2 RETURNING *
  ```

- **Parameter names** — `p1…pN` from the compiled expression only; `{}` when no filter was set.
- **RETURNING** — appended when `returning()` was called; required for the row-returning terminators to return data.

### Complete Example

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface SessionFilter {
  id?: number;
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
  const purged = await db
    .delete<SessionFilter>('sessions')
    .filter({ user_id: 7, revoked: true })
    .returning('*')
    .executeReturnAll();

  console.log(`purged ${purged.length} session(s)`);

  const expiredCount = await db
    .delete<SessionFilter>('sessions')
    .filterByExpression((q) => q.where('revoked').equals(true))
    .executeReturnCount();

  console.log(`expired purged: ${expiredCount}`);
} finally {
  await db.disconnect();
}
```

---

## Statement Execution and Shared Behavior

All three builders share the same execution pipeline. Their terminators build SQL and parameters, then delegate to the owning `PostgreSQLDatabase.executeQuery()`, so hooks, named-placeholder conversion, and result normalization behave exactly like hand-written SQL.

| Terminator | Signature | When no rows are affected |
|------------|-----------|---------------------------|
| `execute()` | `() => Promise<PostgreSQLQueryResult<T> \| null>` | Resolves with a result whose `rowCount` is `0` and `records` is `[]`. |
| `executeReturnSingle()` | `() => Promise<T \| null>` | Resolves with `null`. |
| `executeReturnAll()` | `() => Promise<T[]>` | Resolves with `[]`. |
| `executeReturnCount()` | `() => Promise<number>` | Resolves with `0`. |

`T` is `TableType` for INSERT/UPDATE and `FilterType` for DELETE, per the class generic.

Shared notes:

- `executeReturnSingle()` and `executeReturnAll()` only have rows to return when the statement includes a `RETURNING` clause.
- The zero-row short-circuit in `executeQuery()` returns `{ records: [], rowCount: 0, fields: [] }` and **skips `afterQuery`** — do not rely on row mapping for statements that matched nothing.
- An exception thrown inside `beforeQuery` or `afterQuery` propagates out of the terminator and, inside a transaction, causes a rollback.
- Statements are reusable SQL producers: `buildQuery()` / `buildParameters()` may be called repeatedly (e.g., in tests) without recompiling the WHERE expression.

---

## Interfaces

### `PostgreSQLConfig`

Defines the configuration for PostgreSQL connections. Extends `DatabaseConfig` with PostgreSQL-specific settings.

```typescript fragment
interface PostgreSQLConfig extends DatabaseConfig {
  poolConfig?: PoolConfig;
  enableGracefulShutdown?: boolean;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `host` | `string` (inherited from `DatabaseConfig`) | PostgreSQL server host. |
| `port` | `number \| string` (inherited) | Server port; numeric strings are converted with `Number()`. Omit to use the driver default. |
| `database` | `string` (inherited) | Database name. |
| `user` | `string` (inherited) | Login role. |
| `pass` | `string` (inherited) | Password; mapped to the driver's `password` field. There is no separate `password` option. |
| `poolConfig` | `PoolConfig \| undefined` | Optional pool tuning; omitted fields fall back to node-postgres defaults. |
| `enableGracefulShutdown` | `boolean \| undefined` | When `true`, registers SIGINT/SIGTERM handlers that call `disconnect()` and `process.exit()`. Default `false`. |

> **Warning:** do **not** set `enableGracefulShutdown` on a database instance managed by a `WebApplication` from `blendsdk/webafx`. The web framework owns the SIGINT/SIGTERM lifecycle; installing both handlers causes signal conflicts and unpredictable shutdown behavior. Enable it only for standalone database usage.

### `PoolConfig`

Configuration options for the PostgreSQL connection pool. All properties are optional; omitted values are forwarded as `undefined` and node-postgres applies its own defaults.

```typescript fragment
interface PoolConfig {
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `max` | `number \| undefined` | Maximum number of clients in the pool (node-postgres default: 10). |
| `idleTimeoutMillis` | `number \| undefined` | Milliseconds a client must sit idle before being closed (node-postgres default: 30000). |
| `connectionTimeoutMillis` | `number \| undefined` | Milliseconds to wait when connecting a new client before timing out (node-postgres default: 0 — no timeout). |

### `PostgreSQLQueryResult<T>`

Result of a PostgreSQL query execution. Extends `QueryResult<T>` with the driver's field definitions.

```typescript fragment
interface PostgreSQLQueryResult<T> extends QueryResult<T> {
  fields: FieldDef[];
}
```

| Property | Type | Description |
|----------|------|-------------|
| `records` | `T[]` (inherited from `QueryResult<T>`) | Rows returned by the query, typed by the generic. |
| `rowCount` | `number` (inherited) | Rows returned (SELECT / RETURNING) or affected (INSERT/UPDATE/DELETE). Normalized to `0` when the driver reports `null` and for zero-row results. |
| `fields` | `FieldDef[]` | node-postgres column metadata (`name`, `dataTypeID`, …). Empty array when `rowCount === 0`. |

`FieldDef` comes from the `pg` package (`import type { FieldDef } from 'pg'`); this package does not re-export it.

### `TransactionOptions`

Optional settings for one PostgreSQL transaction.

```typescript fragment
interface TransactionOptions {
  isolation?: TransactionIsolation;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `isolation` | `TransactionIsolation \| undefined` | Isolation level for the transaction. Omit to use PostgreSQL's default (`read committed`, plain `BEGIN`). |

---

## Type Aliases

### `TransactionIsolation`

Isolation levels accepted by `withTransaction()`. The value is validated against an internal allowlist before it is rendered into SQL, so callers cannot inject arbitrary text through the option.

```typescript fragment
type TransactionIsolation = 'read committed' | 'repeatable read' | 'serializable';
```

| Value | Rendered BEGIN statement |
|-------|--------------------------|
| `'read committed'` | `BEGIN ISOLATION LEVEL READ COMMITTED` |
| `'repeatable read'` | `BEGIN ISOLATION LEVEL REPEATABLE READ` |
| `'serializable'` | `BEGIN ISOLATION LEVEL SERIALIZABLE` |

Omitting `isolation` issues a plain `BEGIN`. Any other value (including strings that resemble SQL) throws `Unsupported transaction isolation level. Use "read committed", "repeatable read", or "serializable".` — before a client is acquired.

---

## Generated SQL and Parameter Naming

Rendered SQL (before `yesql` converts `:name` placeholders into the driver's positional `$1…$n` form):

| Context | SQL shape |
|---------|-----------|
| `executeQuery()` | Your SQL text, verbatim; placeholders are named (`:name`). |
| INSERT builder | `INSERT INTO <table> (<cols>) VALUES (:<col>, …)` + ` RETURNING …` |
| UPDATE builder | `UPDATE <table> SET <col> = :v_<col>, …` + ` WHERE …` + ` RETURNING …` |
| DELETE builder | `DELETE FROM <table>` + ` WHERE …` + ` RETURNING …` |

Parameter keys visible to `beforeQuery` (and returned by `buildParameters()`):

| Context | Parameter names |
|---------|-----------------|
| `executeQuery()` (raw SQL) | Exactly the keys you supplied. |
| INSERT builder | Column names (`name`, `email`, …) — the values object is returned verbatim. |
| UPDATE builder | `v_<column>` for SET values; `p1…pN` for WHERE values. The prefix prevents collisions when a column appears on both sides (`v_active` vs `p1`). |
| DELETE builder | `p1…pN` for WHERE values only. |

Hook timing inside `executeOnClient()`: `beforeQuery` runs **before** placeholder conversion (so hooks see the names above), `afterQuery` runs **after** the driver returned rows but before result normalization — and is skipped entirely when `rowCount === 0`.

---

## Error Reference

| Thrown from | Condition | Message |
|-------------|-----------|---------|
| `withTransaction()` | Shutdown flag set | `Cannot start transaction: database is shutting down` |
| `withTransaction()` | A transaction is already active on this async call chain | `Cannot start a nested transaction: a transaction is already active on this database handle.` |
| `withTransaction()` | Context already settled on this call chain | `Cannot start a transaction from a completed transaction context.` |
| `withTransaction()` | Options argument is not a plain object | `Transaction options must be an object.` |
| `withTransaction()` | Isolation value outside the allowlist | `Unsupported transaction isolation level. Use "read committed", "repeatable read", or "serializable".` |
| `executeQuery()` | Shutdown flag set | `Cannot execute query: database is shutting down` |
| `executeQuery()` | Query issued through a completed transaction handle | `Cannot execute a query after the transaction has completed. Do not use the transaction handle outside its callback.` |
| `PostgreSQLInsertStatement.buildQuery()` | No values provided | `Cannot build INSERT statement for table "<tableName>": no values provided. Call .values() with at least one column before executing.` |
| `PostgreSQLUpdateStatement.buildQuery()` | No values provided | `Cannot build UPDATE statement for table "<tableName>": no values provided. Call .values() with at least one column before executing.` |

Additional notes:

- Driver errors (syntax errors, constraint violations, connection failures) and exceptions thrown inside `beforeQuery` / `afterQuery` propagate unchanged; inside a transaction they trigger a rollback.
- Rollback and client-release failures are logged via `console.error` (`Error during transaction rollback:`, `Error releasing transaction client:`, `Error releasing query client:`) and never replace the original error. A failed `BEGIN` or failed `ROLLBACK` marks the client for destruction so the pool cannot reuse a connection in an unknown state.
- `disconnect()` rejects only when `pool.end()` itself rejects; the timeout path resolves after force-releasing clients.

---

## Related Types from Other Packages

These symbols appear in this package's API but are not re-exported; import them from their owning package.

| Symbol | Package | Role in this API |
|--------|---------|------------------|
| `Database` | `blendsdk/dbcore` | Base class of `PostgreSQLDatabase`. |
| `DatabaseConfig` | `blendsdk/dbcore` | Base configuration type extended by `PostgreSQLConfig`. |
| `QueryResult<T>` | `blendsdk/dbcore` | Base result type; supplies `records` and `rowCount`. |
| `ExecuteQueryOptions` | `blendsdk/dbcore` | Third argument of `executeQuery()`; carries the optional `beforeQuery` / `afterQuery` hooks. |
| `InsertStatement<T>` / `UpdateStatement<T, F>` / `DeleteStatement<F>` | `blendsdk/dbcore` | Declared factory return types and base builder classes (fluent methods, hooks, terminators). |
| `FromStatement` | `blendsdk/dbcore` | Returned by the inherited `from()` / `selectAll()` builders. |
| `Pool`, `PoolClient`, `FieldDef` | `pg` | Driver types used in constructor/method signatures and query results. |

---

## See Also

- Overview — feature summary, dependency map, and minimum example.
- Core Concepts — how the adapter, pooling, transactions, hooks, and builders fit together.
- Basic Usage — task-oriented recipes for queries, transactions, and builders.
- `blendsdk/dbcore` API Reference — authoritative documentation of the base `Database` class, statement base classes, and expression builder.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
