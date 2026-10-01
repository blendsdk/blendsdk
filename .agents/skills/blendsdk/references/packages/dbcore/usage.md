> **Package**: `blendsdk/dbcore`

# dbcore Core Concepts

This document is a deep dive into every core abstraction that `blendsdk/dbcore` exports. Each section covers what the abstraction is, how it works, a complete example, and a reference table of its key members. The abstractions build on one another: `Database` is the adapter contract, the `Statement` family constructs queries against it, and the data services wrap the statement layer for read-heavy use cases. Statement examples that are not the `Database` itself take a `db: Database` parameter — the same pattern used in the Overview — because CRUD statement classes are abstract and are supplied by a concrete adapter.

---

## Database — Abstract Adapter Contract

### What It Is

`Database` is the abstract base class that every database backend integrates through. It stores the connection configuration in a protected `config` property, defines the connection lifecycle (`connect()`, `disconnect()`), provides parameterized SQL execution (`executeQuery()`, `withTransaction()`), and acts as the factory for every statement builder (`insert()`, `update()`, `delete()`, `from()`, `selectAll()`). A concrete `Database` subclass — written for PostgreSQL, MySQL, or any other driver — supplies the database-specific connection handling and query execution; everything else in the package is built on top of this contract.

### How It Works

- The constructor stores the `DatabaseConfig` object in the protected `config` property. Adapters read it when they open connections.
- `connect()` opens the connection and resolves with the driver connection object (adapter-specific). `disconnect(timeoutMs?)` releases resources; the optional `timeoutMs` caps how long the adapter waits for a graceful shutdown.
- `executeQuery<R>()` is declared with three overloads — query only, query with parameters, and query with parameters plus `ExecuteQueryOptions` — that collapse into a single implementation in each adapter. It resolves with `QueryResult<R>` or `null`.
- `withTransaction<T>(fn)` executes the callback atomically: if `fn` resolves, the transaction is committed; if `fn` throws, the transaction is rolled back. The callback receives the transactional database handle (`this`), so statements built inside the callback run on the same connection.
- `insert()`, `update()`, and `delete()` are abstract factories that each adapter implements to return its own concrete statement classes. `from()` and `selectAll()` are implemented on the base class and return a `FromStatement` directly — SELECT statement building is fully implemented in this package; only query execution is adapter-specific.
- Execution options transform query parameters before execution and result rows after execution. When a statement is executed, its `beforeQuery()` / `afterQuery()` hooks are assembled into an `ExecuteQueryOptions` object by `Statement.execute()` and forwarded to `db.executeQuery()`.

### Complete Example

The example below is a complete, runnable implementation of the contract: a minimal in-memory adapter that records every executed statement, together with the concrete INSERT, UPDATE, and DELETE builders its factories return.

```typescript
import {
  Database,
  DatabaseConfig,
  DeleteStatement,
  ExecuteQueryOptions,
  InsertStatement,
  QueryResult,
  UpdateStatement,
} from 'blendsdk/dbcore';

interface Note {
  id: number;
  title: string;
  done: boolean;
}

type ParameterBag = Record<string, unknown>;

/** Concrete INSERT builder used by the adapter below. */
class MemoryInsertStatement<T> extends InsertStatement<T> {
  protected buildQuery(): string {
    const columns = Object.keys(this._values);
    const placeholders = columns.map((column) => `:${column}`);
    const returning = this._returning.length > 0 ? ` RETURNING ${this._returning.join(', ')}` : '';
    return `INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})${returning}`;
  }

  protected buildParameters(): Partial<T> {
    return this._values;
  }
}

/** Concrete UPDATE builder used by the adapter below. */
class MemoryUpdateStatement<T, F> extends UpdateStatement<T, F> {
  protected buildQuery(): string {
    const assignments = Object.keys(this._values).map((column) => `${column} = :v_${column}`);
    const filter = this.getCompiledExpression();
    const where = filter ? ` WHERE ${filter.sql}` : '';
    const returning = this._returning.length > 0 ? ` RETURNING ${this._returning.join(', ')}` : '';
    return `UPDATE ${this.tableName} SET ${assignments.join(', ')}${where}${returning}`;
  }

  protected buildParameters(): ParameterBag {
    const params: ParameterBag = {};
    for (const [column, value] of Object.entries(this._values)) {
      params[`v_${column}`] = value;
    }
    const filter = this.getCompiledExpression();
    if (filter) {
      Object.assign(params, filter.params);
    }
    return params;
  }
}

/** Concrete DELETE builder used by the adapter below. */
class MemoryDeleteStatement<F> extends DeleteStatement<F> {
  protected buildQuery(): string {
    const filter = this.getCompiledExpression();
    const where = filter ? ` WHERE ${filter.sql}` : '';
    const returning = this._returning.length > 0 ? ` RETURNING ${this._returning.join(', ')}` : '';
    return `DELETE FROM ${this.tableName}${where}${returning}`;
  }

  protected buildParameters(): ParameterBag {
    const filter = this.getCompiledExpression();
    return filter ? { ...filter.params } : {};
  }
}

/** Minimal concrete adapter that records the SQL it is asked to run. */
class InMemoryDatabase extends Database {
  readonly executed: Array<{ query: string; params: ParameterBag | undefined }> = [];
  private rows: ParameterBag[] = [];

  constructor(config: DatabaseConfig = { database: 'in-memory' }) {
    super(config);
  }

  async connect(): Promise<void> {
    this.rows = [];
  }

  async disconnect(): Promise<void> {
    this.rows = [];
  }

  async executeQuery<R>(
    query: string,
    params?: ParameterBag,
    options?: ExecuteQueryOptions
  ): Promise<QueryResult<R> | null> {
    const finalParams = options?.beforeQuery && params ? options.beforeQuery(params) : params;
    this.executed.push({ query, params: finalParams });
    return { records: this.rows as R[], rowCount: this.rows.length };
  }

  async withTransaction<T>(fn: (db: this) => Promise<T>): Promise<T> {
    return fn(this);
  }

  insert<T>(tableName: string): InsertStatement<T> {
    return new MemoryInsertStatement<T>(tableName, this);
  }

  update<T, F>(tableName: string): UpdateStatement<T, F> {
    return new MemoryUpdateStatement<T, F>(tableName, this);
  }

  delete<F>(tableName: string): DeleteStatement<F> {
    return new MemoryDeleteStatement<F>(tableName, this);
  }
}

export async function runDemo(): Promise<string[]> {
  const db = new InMemoryDatabase({ database: 'demo' });
  await db.connect();

  await db.withTransaction(async (tx) => {
    await tx
      .insert<Note>('notes')
      .values({ id: 1, title: 'Write documentation', done: false })
      .returning(['id', 'title'])
      .executeReturnSingle();

    await tx
      .update<Note, Pick<Note, 'id'>>('notes')
      .values({ done: true })
      .filter({ id: 1 })
      .returning('*')
      .executeReturnSingle();
  });

  const executed = db.executed.map((entry) => entry.query);
  await db.disconnect();
  return executed;
}
```

The `executed` array returned by `runDemo()` contains the generated statements, including the `RETURNING` clauses produced from the builders and the WHERE predicate contributed by `filter({ id: 1 })`. To make this adapter talk to a real engine, replace the body of `executeQuery()` with a call to the driver.

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `config` | `protected config: DatabaseConfig` | Connection settings passed to the constructor and retained for the adapter. |
| `connect()` | `abstract connect(): Promise<any>` | Opens the connection; resolves with the driver connection object. |
| `disconnect(timeoutMs?)` | `abstract disconnect(timeoutMs?: number): Promise<void>` | Closes the connection and releases resources; optional graceful-shutdown timeout. |
| `executeQuery<R>(...)` | `abstract executeQuery<R>(query: string, params?: Record<string, any>, options?: ExecuteQueryOptions): Promise<QueryResult<R> \| null>` | Executes SQL with optional parameters and lifecycle hooks; overloads also allow query-only and query-plus-params calls. |
| `withTransaction<T>(fn)` | `abstract withTransaction<T>(fn: (db: this) => Promise<T>): Promise<T>` | Runs `fn` in a transaction; commit on success, rollback on error. |
| `insert<T>(tableName)` | `abstract insert<T>(tableName: string): InsertStatement<T>` | Creates the adapter's INSERT builder for a table. |
| `update<T, F>(tableName)` | `abstract update<T, F>(tableName: string): UpdateStatement<T, F>` | Creates the adapter's UPDATE builder for a table. |
| `delete<F>(tableName)` | `abstract delete<F>(tableName: string): DeleteStatement<F>` | Creates the adapter's DELETE builder for a table. |
| `from<T>(tableName)` | `from<T>(tableName: string): FromStatement<T>` | Creates a concrete SELECT builder. |
| `selectAll<T>(tableName)` | `selectAll<T>(tableName: string): FromStatement<T>` | Shorthand for `from(tableName).select()` — a `SELECT *` query. |

#### DatabaseConfig

| Name | Type | Description |
| --- | --- | --- |
| `host?` | `string` | Hostname or IP address of the database server. |
| `database?` | `string` | Name of the database to connect to. |
| `port?` | `string \| number` | Port the database server listens on. |
| `user?` | `string` | Username for authentication. |
| `pass?` | `string` | Password for authentication. |

---

## Query Execution Types — QueryResult and ExecuteQueryOptions

### What It Is

`QueryResult<T>`, `ExecuteQueryOptions`, and the handler aliases `QueryParamHandler` and `QueryResultHandler` describe the data flowing in and out of `Database.executeQuery()`. `QueryResult<T>` is the uniform envelope for execution output; `ExecuteQueryOptions` carries optional hooks that transform parameters before execution and result rows after execution. These types are shared by the `Database` contract and the `Statement` builder layer.

### How It Works

Execution flows through a fixed pipeline:

1. A statement builds its SQL string (`buildQuery()`) and parameter object (`buildParameters()`).
2. `Statement.execute()` gathers any registered `beforeQuery` / `afterQuery` hooks into an `ExecuteQueryOptions` object.
3. `db.executeQuery(query, params, options)` runs. The adapter invokes `beforeQuery` with the parameter object before sending the query, and applies `afterQuery` to the raw result rows before resolving.
4. The adapter resolves with `QueryResult<R>` — or `null` when the driver returns nothing.

Handler contracts are shape-preserving: `beforeQuery` receives a parameter object and must return the same shape; `afterQuery` receives the row array and must return an array of rows. `rowCount` means rows returned for SELECT queries and rows affected for INSERT, UPDATE, and DELETE queries.

### Complete Example

This example drives the pipeline directly through `executeQuery()`, transforming parameters with `beforeQuery` and result rows with `afterQuery`:

```typescript
import { Database, QueryResult } from 'blendsdk/dbcore';

interface UserRow {
  id: number;
  name: string;
  lastLogin: string;
}

export async function loadActiveUsers(db: Database): Promise<QueryResult<UserRow> | null> {
  return db.executeQuery<UserRow>(
    'SELECT id, name, last_login AS lastLogin FROM users WHERE active = :active ORDER BY name',
    { active: true },
    {
      beforeQuery: (params) => ({ ...params, tenantId: 'acme' }),
      afterQuery: (rows) => rows.map((row) => ({ ...row, name: String(row.name).toUpperCase() })),
    }
  );
}
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `QueryResult<T>.records` | `T[]` | Records returned by the query, typed by the generic parameter. |
| `QueryResult<T>.rowCount` | `number` | Rows returned (SELECT) or rows affected (INSERT/UPDATE/DELETE). |
| `ExecuteQueryOptions.beforeQuery` | `beforeQuery?: QueryParamHandler` | Handler invoked by the adapter before query execution to transform the parameter object. |
| `ExecuteQueryOptions.afterQuery` | `afterQuery?: QueryResultHandler` | Handler invoked by the adapter after query execution to transform the result rows. |
| `QueryParamHandler` | `(params: Record<string, any>) => Record<string, any>` | Parameter transformation contract. |
| `QueryResultHandler` | `(rows: any[]) => any[]` | Result-row transformation contract. |

Statement-level equivalents (`beforeQuery()` and `afterQuery()` methods) are covered in the `Statement` section below.

---

## Statement — Base Builder and Execution Helpers

### What It Is

`Statement<TableType>` is the abstract base class of every query builder in the package. It implements the Template Method pattern: `execute()` orchestrates query execution, while concrete subclasses supply `buildQuery()` and `buildParameters()`. On top of that, it provides four execution helpers (`execute`, `executeReturnSingle`, `executeReturnAll`, `executeReturnCount`) and two lifecycle hooks (`beforeQuery`, `afterQuery`) that let callers transform parameters and result rows without touching the adapter.

### How It Works

- The constructor receives the `Database` instance and stores it in the protected `db` property; `_beforeQuery` and `_afterQuery` start as `null`.
- `execute<R>()` calls `buildQuery()` and `buildParameters()`, copies any registered hooks into an `ExecuteQueryOptions` object (only when set), and delegates to `db.executeQuery()`. Errors thrown by the adapter — connection failures, constraint violations — propagate unchanged to the caller.
- The helpers unwrap the `QueryResult`: `executeReturnSingle()` returns `records[0]` or `null`, `executeReturnAll()` returns all records or `[]`, and `executeReturnCount()` returns `rowCount` or `0`. Each helper also handles an adapter that resolves `null`.
- `beforeQuery<T>(handler)` and `afterQuery<T>(handler)` register shape-preserving transformers and return `this` for fluent chaining. Statement-level hooks are the same handlers that `ExecuteQueryOptions` carries directly to `executeQuery()`.

### Complete Example

Because `Statement` is abstract, the example defines a concrete raw-SQL statement — a common adapter building block — and executes it with a parameter-normalizing hook:

```typescript
import { Database, Statement } from 'blendsdk/dbcore';

interface OrderTotal {
  total: number;
}

class RawSqlStatement<TableType> extends Statement<TableType> {
  constructor(
    private readonly sql: string,
    private readonly parameters: Record<string, unknown>,
    db: Database
  ) {
    super(db);
  }

  protected buildQuery(): string {
    return this.sql;
  }

  protected buildParameters(): Record<string, unknown> {
    return this.parameters;
  }
}

export async function countOrders(db: Database, regionInput: string): Promise<number> {
  const statement = new RawSqlStatement<OrderTotal>(
    'SELECT COUNT(*) AS total FROM orders WHERE region = :region',
    { region: regionInput },
    db
  );

  statement.beforeQuery<Record<string, unknown>>((params) => ({
    ...params,
    region: String(params.region).trim().toLowerCase(),
  }));

  const row = await statement.executeReturnSingle();
  return row?.total ?? 0;
}
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `db` | `protected db: Database` | The database instance used for execution. |
| `_beforeQuery` | `protected _beforeQuery: ((params: any) => any) \| null` | Parameter transformer registered via `beforeQuery()`; `null` when unset. |
| `_afterQuery` | `protected _afterQuery: ((rows: any) => any) \| null` | Result-row transformer registered via `afterQuery()`; `null` when unset. |
| `buildQuery()` | `protected abstract buildQuery(): string` | Produces the SQL string; implemented by every concrete builder. |
| `buildParameters()` | `protected abstract buildParameters(): any` | Produces the parameter object; implemented by every concrete builder. |
| `execute()` | `execute<R extends QueryResult<any> = QueryResult<any>>(): Promise<R \| null>` | Builds and executes the query through `db.executeQuery()` with the registered hooks. |
| `executeReturnSingle()` | `async executeReturnSingle(): Promise<Partial<TableType> \| null>` | Returns the first record, or `null` when there are no records (or the adapter resolved `null`). |
| `executeReturnAll()` | `async executeReturnAll(): Promise<Partial<TableType>[]>` | Returns all records, or `[]`. |
| `executeReturnCount()` | `async executeReturnCount(): Promise<number>` | Returns `rowCount`, or `0`. |
| `beforeQuery<T>(handler)` | `beforeQuery<T>(handler: (params: T) => T): this` | Registers a shape-preserving parameter transformer; chainable. |
| `afterQuery<T>(handler)` | `afterQuery<T>(handler: (rows: T) => T): this` | Registers a shape-preserving result-row transformer; chainable. |

---

## FromStatement — SELECT Query Builder

### What It Is

`FromStatement<TableType>` is the concrete builder for SELECT queries and the only non-abstract statement class in the package. It combines the SELECT clause (simple column lists or aliased expressions), the FROM clause, and an optional WHERE clause compiled by `blendsdk/expression` into a single parameterized statement. Instances are created exclusively through `Database.from<T>()` and `Database.selectAll<T>()`. See Basic Usage for common query recipes.

### How It Works

- `select()` normalizes its argument: no argument (or anything that is neither an array nor an object) selects `*`; an array is used verbatim as the column list; an object maps each key to an alias and each value to an expression, rendering `${value} AS ${key}` (for example, `{ total: 'price * quantity' }` becomes `price * quantity AS total`).
- `byExpression(filter)` accepts a `CompileResult` from `blendsdk/expression` (which is not re-exported by this package — import it from `blendsdk/expression`). It stores the compiled SQL as the WHERE clause and the compiled parameters for binding.
- `buildQuery()` assembles `SELECT <columns> FROM <table>` plus the optional WHERE clause; `buildParameters()` returns the stored parameter object.
- Because the builder is concrete, `FromStatement<T>` extends `Statement<T>` and inherits all execution helpers and hooks directly.

### Complete Example

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

export async function listActiveUsers(db: Database): Promise<Partial<User>[]> {
  const filter = query<User>().where('active').equals(true).compile();

  return db
    .from<User>('users')
    .select(['id', 'name', 'email'])
    .byExpression(filter)
    .executeReturnAll();
}

export async function listAllUsers(db: Database): Promise<Partial<User>[]> {
  return db.selectAll<User>('users').executeReturnAll();
}
```

Aliased projections use the object form of `select()`:

```typescript
// typescript fragment — object entries become "<expression> AS <alias>"
const statement = db.from<User>('users');
statement.select({ fullName: "first_name || ' ' || last_name", total: 'price * quantity' });
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `select(columns?)` | `select(columns?: string[] \| Record<string, any>): this` | Sets the column list; array for plain columns, object for `expression AS alias` projections, omitted for `*`. |
| `byExpression(filter)` | `byExpression(filter: CompileResult): this` | Applies a compiled WHERE clause and its bound parameters. |
| `_selectColumns` | `protected _selectColumns: string[]` | Resolved column/alias list used by `buildQuery()`. |
| `_parameters` | `protected _parameters: Record<string, any>` | Parameters carried from the compiled expression. |
| `_whereClause` | `protected _whereClause: string` | Rendered WHERE clause (empty when no filter is set). |
| `buildQuery()` | `protected buildQuery(): string` | Assembles the full `SELECT ... FROM ... [WHERE ...]` statement. |
| `buildParameters()` | `protected buildParameters(): Record<string, any>` | Returns the stored parameters for query execution. |

---

## CrudStatement — Shared CRUD Foundation

### What It Is

`CrudStatement<TableType>` is the abstract base class for the data-modification builders (INSERT, UPDATE, DELETE). It extends `Statement<TableType>` with two shared pieces of state — `_values` (the column/value payload) and `_returning` (the fields to return) — and the fluent `returning()` method that configures a `RETURNING` clause. The class itself is never instantiated; `InsertStatement` extends it directly, while `UpdateStatement` and `DeleteStatement` reach it through `FilterableStatement`.

### How It Works

- The constructor stores the protected `tableName` and initializes `_returning` to `[]` and `_values` to `{}`.
- `returning(fields)` normalizes its argument: the literal `'*'` becomes `['*']` (all columns), while an array of `keyof TableType` field names is stored as-is. It returns `this`, so it chains with `values()` and the execution helpers.
- `_values` is populated by the `values()` methods declared on `InsertStatement` and `UpdateStatement`; `CrudStatement` owns the storage contract and passes it down to concrete builders.
- Concrete adapters render the `RETURNING` clause from `_returning` in their `buildQuery()` implementations:

```typescript
// typescript fragment — adapter-side rendering of the RETURNING clause
const returning = this._returning.length > 0 ? ` RETURNING ${this._returning.join(', ')}` : '';
```

### Complete Example

Because `CrudStatement` is abstract, the example builds through the `Database` factory methods, where `returning()` is inherited by every CRUD builder:

```typescript
import { Database } from 'blendsdk/dbcore';

interface Invoice {
  id: number;
  number: string;
  status: string;
  total: number;
  created_at: string;
}

export async function createInvoice(
  db: Database,
  invoice: Partial<Invoice>
): Promise<Partial<Invoice> | null> {
  return db
    .insert<Invoice>('invoices')
    .values(invoice)
    .returning(['id', 'number', 'status', 'created_at'])
    .executeReturnSingle();
}

export async function closeInvoice(db: Database, id: number): Promise<Partial<Invoice> | null> {
  return db
    .update<Invoice, { id: number }>('invoices')
    .values({ status: 'closed' })
    .filter({ id })
    .returning('*')
    .executeReturnSingle();
}
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `tableName` | `protected tableName: string` | The table the statement operates on, captured by the constructor. |
| `_returning` | `protected _returning: string[]` | Field names for the `RETURNING` clause; `['*']` when all columns are requested. |
| `_values` | `protected _values: Partial<TableType>` | Column/value payload written by `values()`; used by concrete `buildQuery()`/`buildParameters()`. |
| `returning(fields)` | `returning(fields: (keyof TableType)[] \| '*'): this` | Configures which fields to return after the operation; chainable. |

Plus all execution helpers and hooks inherited from `Statement`.

---

## InsertStatement — INSERT Builder

### What It Is

`InsertStatement<TableType>` is the abstract builder for inserting rows. It extends `CrudStatement<TableType>` and adds a single method — `values()` — that records the column/value payload for the new row. Combined with the inherited `returning()`, it supports the full "insert and get the generated record back" workflow, including auto-generated identifiers. Concrete adapters must extend this class to produce their dialect's `INSERT` SQL and parameter syntax.

### How It Works

- `values(values)` assigns the payload to the protected `_values` field and returns `this` for chaining. It is a full replacement, not a merge: calling `values()` a second time overwrites the previous payload. Partial objects are expected — only the specified columns are included in the statement.
- The concrete adapter implementation reads `_values` and `_returning` in its `buildQuery()` / `buildParameters()` overrides. A typical PostgreSQL-style adapter renders `INSERT INTO users (name, email) VALUES (:name, :email) RETURNING id, created_at`.
- Execution uses the inherited helpers: `executeReturnSingle()` for the returned row, `executeReturnCount()` when only the affected-row count matters.

### Complete Example

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
  created_at: string;
}

export async function registerUser(
  db: Database,
  user: Pick<User, 'name' | 'email'>
): Promise<Partial<User> | null> {
  return db
    .insert<User>('users')
    .values(user)
    .returning(['id', 'created_at'])
    .executeReturnSingle();
}
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `values(values)` | `values(values: Partial<TableType>): this` | Sets the columns and values to insert; chainable, replaces any previous payload. |
| `returning(fields)` | `returning(fields: (keyof TableType)[] \| '*'): this` | Inherited from `CrudStatement`; configures the `RETURNING` clause. |
| `buildQuery()` | `protected abstract buildQuery(): string` | Supplied by the adapter; renders the dialect's `INSERT` statement. |
| `buildParameters()` | `protected abstract buildParameters(): any` | Supplied by the adapter; binds the payload values. |

Plus all execution helpers and hooks inherited from `Statement` (see above).

---

## FilterableStatement — Expression-Based Filtering

### What It Is

`FilterableStatement<TableType, FilterType>` is the abstract layer that adds WHERE-clause construction to CRUD statements. It sits between `CrudStatement` and the `UpdateStatement` / `DeleteStatement` classes and centralizes both filtering entry points: `filter()` for simple key/value equality criteria and `filterByExpression()` for complex predicates built with the `blendsdk/expression` DSL. It also owns the cached compilation of the expression builder, so the filter is compiled exactly once per statement execution.

### How It Works

- `filter(values)` converts an object of column/value pairs into an expression: the first key becomes `where(key).equals(value)`, each subsequent key is appended with `and(key).equals(value)` — all criteria combined with AND. Multiple `filter()` calls (and combinations with `filterByExpression()`) are layered with AND logic on top of the existing builder.
- `filterByExpression(builder)` gives full access to the expression DSL for comparisons, `or` branches, null checks, and nested conditions.
- `getCompiledExpression()` is the protected bridge used by concrete adapters. On first call it creates a fresh query builder, runs the registered expression builder, compiles the result with `.compile()`, and caches the `CompileResult` in `_compiledExpression`. Subsequent calls return the identical cached object — so `buildQuery()` and `buildParameters()` can both consume it without compiling twice.
- If no filter was set, `getCompiledExpression()` returns `null`, and adapters typically omit the WHERE clause entirely:

```typescript
// typescript fragment — adapter-side consumption of the cached compiled filter
const filter = this.getCompiledExpression();
const where = filter ? ` WHERE ${filter.sql}` : '';
```

### Complete Example

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  age: number;
  active: boolean;
  status: string;
  last_login: string;
}

export async function archiveInactiveUsers(db: Database, cutoff: string): Promise<number> {
  return db
    .update<User, User>('users')
    .values({ status: 'archived' })
    .filter({ active: false })
    .filterByExpression((q) => q.where('last_login').lessThan(cutoff))
    .returning(['id', 'status'])
    .executeReturnCount();
}
```

Both filter styles accept the same statement, combined with AND — the simple equality criteria from `filter()` and the compiled predicate from `filterByExpression()`:

```typescript
// typescript fragment
const statement = db.update<User, User>('users');
statement.filter({ status: 'pending', active: true });
statement.filterByExpression((q) => q.where('age').greaterThan(65).or('status').equals('inactive'));
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `filter(values)` | `filter(values: Partial<FilterType>): this` | Adds equality criteria for the given columns, combined with AND; chainable. |
| `filterByExpression(builder)` | `filterByExpression(builder: (q: QueryBuilder<FilterType>) => QueryBuilder<FilterType>): this` | Adds a complex predicate built with the `blendsdk/expression` DSL; merged with AND; chainable. |
| `getCompiledExpression()` | `protected getCompiledExpression(): CompileResult \| null` | Compiles (once) and caches the filter expression; returns `null` when no filter is set. |
| `_expressionBuilder` | `protected _expressionBuilder?: (q: QueryBuilder<FilterType>) => QueryBuilder<FilterType>` | The composed expression builder, if any filter was registered. |
| `_compiledExpression` | `protected _compiledExpression?: CompileResult` | The cached compilation result, reused by `buildQuery()` and `buildParameters()`. |

Plus all members inherited from `CrudStatement` (`_values`, `returning()`) and `Statement` (execution helpers and hooks).

---

## UpdateStatement — UPDATE Builder

### What It Is

`UpdateStatement<TableType, FilterType>` is the abstract builder for updating existing rows. It extends `FilterableStatement<TableType, FilterType>`, inheriting the complete filtering toolset, and adds `values()` for the new column values. The two generic parameters separate the table shape (`TableType`, for `values()` and `returning()`) from the filter shape (`FilterType`, for `filter()`), so you can, for example, filter by a narrow `{ id: number }` while updating full records.

### How It Works

- `values(values)` stores the partial payload in `_values` (replacing any previous payload) and returns `this`.
- Filtering uses `filter()` for equality criteria or `filterByExpression()` for DSL predicates — see [FilterableStatement](#filterablestatement--expression-based-filtering) above.
- A concrete adapter combines `_values` (rendered as `SET` assignments), the cached compiled filter (rendered as the WHERE clause), and `_returning` (rendered as `RETURNING`) into a single statement, and merges the SET parameters with the WHERE parameters in `buildParameters()`.
- `executeReturnCount()` reports how many rows were updated; `executeReturnSingle()` / `executeReturnAll()` return the updated records when a `RETURNING` clause is configured.

### Complete Example

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
  role: string;
  updated_at: string;
}

export async function promoteToAdmin(db: Database, id: number): Promise<number> {
  return db
    .update<User, { id: number }>('users')
    .values({ role: 'admin' })
    .filter({ id })
    .executeReturnCount();
}

export async function renameUser(
  db: Database,
  id: number,
  name: string
): Promise<Partial<User> | null> {
  return db
    .update<User, { id: number }>('users')
    .values({ name })
    .filter({ id })
    .returning(['id', 'name', 'updated_at'])
    .executeReturnSingle();
}
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `values(values)` | `values(values: Partial<TableType>): this` | Sets the new column values; chainable, replaces any previous payload. |
| `filter(values)` | `filter(values: Partial<FilterType>): this` | Inherited from `FilterableStatement`; selects which rows to update. |
| `filterByExpression(builder)` | `filterByExpression(builder: (q: QueryBuilder<FilterType>) => QueryBuilder<FilterType>): this` | Inherited; adds a compiled WHERE predicate. |
| `returning(fields)` | `returning(fields: (keyof TableType)[] \| '*'): this` | Inherited from `CrudStatement`; configures the `RETURNING` clause. |
| `buildQuery()` | `protected abstract buildQuery(): string` | Supplied by the adapter; renders the dialect's `UPDATE` statement. |
| `buildParameters()` | `protected abstract buildParameters(): any` | Supplied by the adapter; binds SET and WHERE parameters. |

Plus all execution helpers and hooks inherited from `Statement`.

---

## DeleteStatement — DELETE Builder

### What It Is

`DeleteStatement<FilterType>` is the abstract builder for deleting rows. It extends `FilterableStatement<FilterType, FilterType>` — the filter type parameter serves as both the statement's table type and its filter type — and adds no members of its own: deletion is entirely expressed through the inherited `filter()`, `filterByExpression()`, and `returning()` methods plus the execution helpers. Concrete adapters implement `buildQuery()` / `buildParameters()` for their dialect.

### How It Works

- Use `filter()` for equality-based criteria and `filterByExpression()` for DSL predicates; both combine with AND and are compiled once through `getCompiledExpression()`.
- Configuring `returning('*')` or `returning([...])` makes the adapter emit a `RETURNING` clause, so the deleted rows can be captured with `executeReturnSingle()` / `executeReturnAll()`.
- Without a filter, the statement builds a full-table `DELETE`; always apply a filter for targeted deletions.

### Complete Example

```typescript
import { Database } from 'blendsdk/dbcore';

interface Session {
  id: number;
  user_id: number;
  expires_at: string;
}

export async function purgeExpiredSessions(db: Database, now: string): Promise<Partial<Session>[]> {
  return db
    .delete<Session>('sessions')
    .filterByExpression((q) => q.where('expires_at').lessThan(now))
    .returning(['id', 'user_id'])
    .executeReturnAll();
}

export async function deleteDrafts(db: Database): Promise<number> {
  return db
    .delete<{ status: string }>('articles')
    .filter({ status: 'draft' })
    .executeReturnCount();
}
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `filter(values)` | `filter(values: Partial<FilterType>): this` | Inherited from `FilterableStatement`; selects which rows to delete. |
| `filterByExpression(builder)` | `filterByExpression(builder: (q: QueryBuilder<FilterType>) => QueryBuilder<FilterType>): this` | Inherited; adds a compiled WHERE predicate. |
| `returning(fields)` | `returning(fields: (keyof FilterType)[] \| '*'): this` | Inherited from `CrudStatement`; returns the deleted rows when configured. |
| `getCompiledExpression()` | `protected getCompiledExpression(): CompileResult \| null` | Inherited; compiles (once) and caches the WHERE expression. |
| `buildQuery()` | `protected abstract buildQuery(): string` | Supplied by the adapter; renders the dialect's `DELETE` statement. |
| `buildParameters()` | `protected abstract buildParameters(): any` | Supplied by the adapter; binds the WHERE parameters. |

Plus all execution helpers and hooks inherited from `Statement`.

---

## QueryDataService — Read-Only Data Services

### What It Is

`QueryDataService<RelationType>` is the abstract base class for repository-style read services bound to a single relation (table or view) and a primary-key column. It provides the four common read patterns — `findById()`, `findByExpression()`, `findAllByExpression()`, and `findAll()` — on top of the `FromStatement` builder, and it delegates database access through `DataServiceBase`, which simply holds the protected `db` reference. The `createQueryService()` factory removes the remaining boilerplate by returning a ready-to-instantiate, relation-bound subclass.

### How It Works

- The constructor receives the relation name and id column (stored in the public `relation` and `idColumn` properties) plus the `Database` instance passed to `DataServiceBase`.
- `findById(id)` builds an untyped query with `query()` and `qb.where(this.idColumn).equals(id)`, compiles it, and executes `db.from(relation).select().byExpression(...).executeReturnSingle()` — returning the record or `null`.
- `findByExpression(builder)` is the same flow with a caller-supplied `ExpressionBuilder<RelationType>` for typed column references; it also returns a single record.
- `findAllByExpression(builder)` returns all matching records, and `findAll()` runs an unfiltered `SELECT *`. Both resolve to `[]` when nothing matches.
- `createQueryService<RelationType>(relationName, idColumn)` returns a concrete class whose constructor only needs the `Database` instance:

```typescript
// typescript fragment — the shape returned by createQueryService()
const UserService = createQueryService<User>('users', 'id');
const service = new UserService(db);
const user = await service.findById(123);
```

- Subclasses extend the service with domain-specific methods (like `findActive()` below) and can use the protected `db` property directly for anything the built-in methods do not cover.

### Complete Example

```typescript
import { Database, QueryDataService, createQueryService } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

class UserService extends QueryDataService<User> {
  constructor(db: Database) {
    super('users', 'id', db);
  }

  async findActive(): Promise<Partial<User>[]> {
    return this.findAllByExpression((q) => q.where('active').equals(true));
  }
}

const UserQueryService = createQueryService<User>('users', 'id');

export async function loadUsers(db: Database): Promise<Partial<User>[]> {
  const service = new UserService(db);
  const byId = await new UserQueryService(db).findById(1);
  const active = await service.findActive();
  return byId ? [byId, ...active] : active;
}
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `relation` | `public relation: string` | The relation (table/view) this service queries. |
| `idColumn` | `public idColumn: string` | The primary-key column used by `findById()`. |
| `findById<IdType>(id)` | `findById<IdType>(id: IdType): PromiseOfRecord<RelationType \| null>` | Returns the record whose primary key equals `id`, or `null`. |
| `findByExpression(builder)` | `findByExpression(builder: ExpressionBuilder<RelationType>): PromiseOfRecord<RelationType \| null>` | Returns the first record matching the compiled expression, or `null`. |
| `findAllByExpression(builder)` | `findAllByExpression(builder: ExpressionBuilder<RelationType>): PromiseOfRecordSet<RelationType>` | Returns all records matching the compiled expression; `[]` when none match. |
| `findAll()` | `findAll(): PromiseOfRecordSet<RelationType>` | Returns all records in the relation without filtering. |
| `createQueryService<T>(relationName, idColumn)` | `(relationName: string, idColumn: string) => new (db: Database) => QueryDataService<T>` | Factory returning a concrete, relation-bound service class. |
| `DataServiceBase.db` | `protected db: Database` | The database instance shared with subclasses. |
| `ExpressionBuilder<T>` | `(q: QueryBuilder<T>) => void` | Type of the expression builder callbacks accepted by the find methods. |
| `PromiseOfRecord<T>` | `Promise<Partial<T>>` | Return type alias for single-record queries. |
| `PromiseOfRecordSet<T>` | `Promise<Partial<T>[]>` | Return type alias for record-set queries. |

---

For the exhaustive, signature-level listing of every export — including types not detailed here — see the API Reference. For step-by-step usage patterns such as connecting an adapter, executing transactions, and composing filters, continue with Basic Usage.

---

# dbcore Basic Usage

This is the step-by-step getting-started guide for `blendsdk/dbcore`: from installation to a first working query, then through the fundamentals of reading, filtering, writing, transactions, query hooks, and repository-style data services.

One fact shapes everything else: `blendsdk/dbcore` contains the database abstractions and statement builders, but no driver. Queries execute against a concrete `Database` adapter — a companion package for your engine, or a subclass you write yourself. To keep the examples honest, every function below receives a `db: Database` parameter; in your application that argument is an instance of a concrete adapter.

---

## Installation

Install `blendsdk/dbcore` together with `blendsdk/expression`:

```bash
npm install blendsdk/dbcore blendsdk/expression
```

```bash
yarn add blendsdk/dbcore blendsdk/expression
```

```bash
pnpm add blendsdk/dbcore blendsdk/expression
```

`blendsdk/expression` is a runtime dependency of `dbcore`, but its symbols are never re-exported — the expression DSL (`query`, `QueryBuilder`, `CompileResult`) is imported directly from `blendsdk/expression`, so declare it explicitly in your own `package.json`.

**Requirements**

- Node.js `>= 22.0.0`
- ESM only — use `import`, this package has no CommonJS entry point
- A concrete `Database` adapter to execute queries at runtime (statement builders alone cannot connect to a database)

---

## Quick Start

Assuming a connected `Database` adapter is available, this is a complete, typed "fetch one user by id" — the smallest useful unit of dbcore code:

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  email: string;
}

export async function getUser(db: Database, id: number): Promise<Partial<User> | null> {
  const filter = query<User>().where('id').equals(id).compile();
  return db.from<User>('users').select(['id', 'name', 'email']).byExpression(filter).executeReturnSingle();
}
```

What happens, step by step:

- `query<User>().where('id').equals(id).compile()` builds a parameterized WHERE predicate from the `blendsdk/expression` DSL.
- `db.from<User>('users')` opens a SELECT statement builder; `.select(['id', 'name', 'email'])` chooses the projected columns.
- `.byExpression(filter)` applies the compiled predicate to the statement.
- `.executeReturnSingle()` runs the statement and resolves to `Partial<User> | null`.

Every pattern in the rest of this guide is a variation on these four pieces.

---

## Fundamentals

The examples follow two conventions: each one is a complete module (imports included), and each one receives an already-connected adapter as its `db: Database` parameter — the connection lifecycle itself is covered first.

### 1. Adapters and the Connection Lifecycle

`Database` is an abstract class. Everything you do starts from a concrete subclass — from a companion adapter package or one you write — that implements `connect()`, `disconnect()`, `executeQuery()`, `withTransaction()`, and the `insert()` / `update()` / `delete()` factories. The contracts behind these classes are described in detail in Core Concepts.

The lifecycle is explicit:

- `await db.connect()` opens the connection. Call it once at application startup, before the first query.
- `await db.disconnect(timeoutMs?)` releases resources at shutdown. The optional timeout caps how long the adapter waits for a graceful close; the adapter interprets it.

This example is deliberately self-contained — it connects, runs one query, and disconnects in a `finally` block so the connection is never leaked:

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

export async function countActiveUsers(db: Database, timeoutMs = 5000): Promise<number> {
  await db.connect();
  try {
    const filter = query<User>().where('active').equals(true).compile();
    return await db.from<User>('users').select().byExpression(filter).executeReturnCount();
  } finally {
    await db.disconnect(timeoutMs);
  }
}
```

In a long-running server you would typically connect once during startup and skip the per-call wrapper — the examples below assume exactly that. The configuration an adapter receives (host, port, credentials) is covered in [Configuration](#configuration).

### 2. Reading Rows with `selectAll()` and `select()`

The simplest read is `selectAll<T>(tableName)`, a shorthand for `from<T>(tableName).select()` that produces a `SELECT *` statement:

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

export async function listUsers(db: Database): Promise<Partial<User>[]> {
  return db.selectAll<User>('users').executeReturnAll();
}
```

The next level narrows the projection so the database transfers only the columns you need:

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

export async function listUserCards(db: Database): Promise<Partial<User>[]> {
  return db.from<User>('users').select(['id', 'name', 'email']).executeReturnAll();
}
```

Row-returning helpers resolve to `Partial<T>` — a record only contains the columns that were selected. To compute aliased expressions in SQL, pass an object to `select()`; each key becomes the alias of its value:

```typescript
// typescript fragment — object keys become aliases: "<value> AS <key>"
const statement = db.from<{ fullName: string }>('users');
statement.select({ fullName: "first_name || ' ' || last_name" });
```

### 3. Filtering Rows with Expressions

WHERE clauses are built with the `blendsdk/expression` DSL, not with string concatenation. `query<T>()` starts a type-safe builder, chained comparators describe the predicate, and `.compile()` produces a result that pairs the SQL fragment with a bound parameter object. `byExpression()` applies that result to a SELECT statement:

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

export async function findUserByEmail(db: Database, email: string): Promise<Partial<User> | null> {
  const filter = query<User>().where('email').equals(email).compile();
  return db.from<User>('users').select().byExpression(filter).executeReturnSingle();
}
```

The next level combines conditions with `and()` / `or()` and comparison operators such as `greaterThan()` and `lessThan()`:

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
  role: string;
  last_login: string;
}

export async function listActiveAdmins(db: Database, since: string): Promise<Partial<User>[]> {
  const filter = query<User>()
    .where('role')
    .equals('admin')
    .and('active')
    .equals(true)
    .and('last_login')
    .greaterThan(since)
    .compile();

  return db.from<User>('users').select(['id', 'name', 'last_login']).byExpression(filter).executeReturnAll();
}
```

Values are never interpolated into the SQL text — the adapter receives the compiled SQL fragment and the parameter object separately and binds them safely. Two details to remember:

- Calling `byExpression()` a second time **replaces** the previous filter on the statement.
- A compiled filter is an object you can store and reuse; type such variables as `CompileResult`, imported from `blendsdk/expression`.

### 4. Consuming Results with the Execution Helpers

Every statement — SELECT or CRUD — offers the same four ways to execute, inherited from the `Statement` base class. Pick by what you need back:

| Helper | Resolves to | Behavior when nothing matches |
| --- | --- | --- |
| `execute()` | `Promise<QueryResult<T> \| null>` | `null` |
| `executeReturnSingle()` | `Promise<Partial<T> \| null>` | `null` |
| `executeReturnAll()` | `Promise<Partial<T>[]> ` | `[]` |
| `executeReturnCount()` | `Promise<number>` | `0` |

`execute()` hands you the full `QueryResult<T>` envelope — `records` plus `rowCount`, where `rowCount` means rows returned for SELECT and rows affected for INSERT, UPDATE, and DELETE. Pass a concrete result type to the generic to keep the records typed:

```typescript
import { Database, QueryResult } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

export async function summarizeActiveUsers(db: Database): Promise<{ total: number; sample: Partial<User>[] }> {
  const filter = query<User>().where('active').equals(true).compile();
  const result = await db
    .from<User>('users')
    .select(['id', 'name'])
    .byExpression(filter)
    .execute<QueryResult<Partial<User>>>();

  return {
    total: result?.rowCount ?? 0,
    sample: result?.records ?? [],
  };
}
```

The finite helpers normalize the edges for you: they handle an adapter that resolves `null`, return `null` / `[]` / `0` when the result set is empty, and never reject for "no rows" — only real failures reject (see [Error Handling](#error-handling)).

### 5. Inserting Rows with `insert()`

`insert<T>(tableName)` returns an INSERT builder. `values()` takes the column/value payload, and the inherited `returning()` adds a `RETURNING` clause — the standard way to get database-generated values such as an id back from the insert:

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
  created_at: string;
}

export async function registerUser(db: Database, name: string, email: string): Promise<Partial<User> | null> {
  return db
    .insert<User>('users')
    .values({ name, email, active: true })
    .returning(['id', 'created_at'])
    .executeReturnSingle();
}
```

`returning('*')` returns every column instead of a specific list. When you don't need the new row back, skip `returning()` entirely and ask for the affected-row count:

```typescript
import { Database } from 'blendsdk/dbcore';

interface AuditEntry {
  id: number;
  actor: string;
  action: string;
}

export async function recordAuditEntry(db: Database, actor: string, action: string): Promise<number> {
  return db
    .insert<AuditEntry>('audit_log')
    .values({ actor, action })
    .executeReturnCount();
}
```

Two details to remember:

- `values()` is a **full replacement**: calling it a second time keeps only the last payload.
- The payload is partial — only the specified columns are included in the statement, so database-side defaults keep working.

### 6. Updating Rows with `update()`

`update<TableType, FilterType>(tableName)` takes two generics: the table shape (used by `values()` and `returning()`) and the filter shape (used by `filter()`). The simple case updates one row selected by primary key:

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
  role: string;
  active: boolean;
  last_login: string;
}

export async function renameUser(db: Database, id: number, name: string): Promise<Partial<User> | null> {
  return db
    .update<User, { id: number }>('users')
    .values({ name })
    .filter({ id })
    .returning(['id', 'name'])
    .executeReturnSingle();
}
```

The next level combines an equality filter with a complex expression — `filter()` and `filterByExpression()` merge with AND, regardless of call order:

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  role: string;
  active: boolean;
  last_login: string;
}

export async function deactivateStaleGuests(db: Database, cutoff: string): Promise<number> {
  return db
    .update<User, User>('users')
    .values({ active: false })
    .filter({ role: 'guest' })
    .filterByExpression((q) => q.where('last_login').lessThan(cutoff))
    .executeReturnCount();
}
```

Note the warning built into the API: an UPDATE **without** any filter affects every row in the table. Always chain at least one `filter()` or `filterByExpression()` for targeted updates.

### 7. Deleting Rows with `delete()`

`delete<T>(tableName)` takes a single generic that serves as both the table and the filter type:

```typescript
import { Database } from 'blendsdk/dbcore';

interface Article {
  id: number;
  title: string;
  status: string;
}

export async function deleteDraftArticles(db: Database): Promise<number> {
  return db.delete<Article>('articles').filter({ status: 'draft' }).executeReturnCount();
}
```

The next level uses `returning()` to capture the deleted rows — useful for audit trails or undo operations — and receives them with the same execution helpers as any read:

```typescript
import { Database } from 'blendsdk/dbcore';

interface Session {
  id: number;
  user_id: number;
  expires_at: string;
}

export async function purgeExpiredSessions(db: Database, now: string): Promise<Partial<Session>[]> {
  return db
    .delete<Session>('sessions')
    .filterByExpression((q) => q.where('expires_at').lessThan(now))
    .returning(['id', 'user_id'])
    .executeReturnAll();
}
```

As with UPDATE, a DELETE without a filter removes every row in the table — always filter.

### 8. Grouping Statements in Transactions

`withTransaction<T>(fn)` executes the callback atomically. The callback receives the transactional database handle (`tx`); every statement built from `tx` runs on the same connection. If the callback resolves, the transaction commits; if anything throws — including a rejected statement — the adapter rolls back and the error propagates:

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
}

interface Profile {
  id: number;
  user_id: number;
  bio: string;
}

export async function createUserWithProfile(
  db: Database,
  name: string,
  email: string,
  bio: string
): Promise<number> {
  return db.withTransaction(async (tx) => {
    const user = await tx
      .insert<User>('users')
      .values({ name, email })
      .returning(['id'])
      .executeReturnSingle();

    if (!user || user.id === undefined) {
      throw new Error('INSERT did not return the new user id');
    }

    await tx.insert<Profile>('profiles').values({ user_id: user.id, bio }).executeReturnCount();

    return user.id;
  });
}
```

The value returned from the callback becomes the resolution of `withTransaction()` — here the new user id. If the profile insert fails (a constraint violation, for example), the user insert is rolled back too, and nothing is persisted.

### 9. Transforming Queries with Hooks

Every statement builder exposes two chainable hooks:

- `beforeQuery(handler)` — receives the parameter object before execution and returns the transformed version.
- `afterQuery(handler)` — receives the raw result rows after execution and returns the transformed rows.

Both are shape-preserving (`params` in → `params` out, rows in → rows out). When a statement executes, its hooks are forwarded to the adapter inside `ExecuteQueryOptions`, and the adapter applies them around the actual query. A common use of `afterQuery()` is normalizing data on the way out:

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

export async function listUsersWithNormalizedEmail(db: Database): Promise<Partial<User>[]> {
  return db
    .from<User>('users')
    .select(['id', 'name', 'email'])
    .afterQuery<Partial<User>[]>((rows) =>
      rows.map((row) => ({ ...row, email: row.email?.toLowerCase() ?? '' }))
    )
    .executeReturnAll();
}
```

`beforeQuery()` is the mirror image — it sanitizes values just before they are bound. This variant normalizes every string parameter, so an email lookup works regardless of whitespace or casing in the input:

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

const normalizeStringValues = (params: Record<string, unknown>): Record<string, unknown> => {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    normalized[key] = typeof value === 'string' ? value.trim().toLowerCase() : value;
  }
  return normalized;
};

export async function findUserByEmailCaseInsensitive(db: Database, email: string): Promise<Partial<User> | null> {
  const filter = query<User>().where('email').equals(email).compile();

  return db
    .from<User>('users')
    .select(['id', 'name', 'email'])
    .byExpression(filter)
    .beforeQuery(normalizeStringValues)
    .executeReturnSingle();
}
```

Hooks can be combined on one statement (`beforeQuery` plus `afterQuery`), and the same mechanism works identically on INSERT, UPDATE, and DELETE builders.

### 10. Repository-Style Reads with Data Services

A `QueryDataService<RelationType>` bundles the common read patterns for one relation and primary-key column. The quickest way to get one is the `createQueryService()` factory, which returns a class you instantiate with just a `Database`:

```typescript
import { Database, createQueryService } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

const UserService = createQueryService<User>('users', 'id');

export async function loadUserOverview(db: Database, id: number): Promise<Partial<User>[]> {
  const service = new UserService(db);
  const current = await service.findById(id);
  const active = await service.findAllByExpression((q) => q.where('active').equals(true));
  return current ? [current, ...active] : active;
}
```

The built-in methods cover the common patterns:

| Method | Description |
| --- | --- |
| `findById(id)` | Fetches the record whose primary key equals `id`; resolves to `null` when not found. |
| `findByExpression(builder)` | Fetches the first record matching the compiled expression; resolves to `null` when none match. |
| `findAllByExpression(builder)` | Fetches all matching records; resolves to `[]` when none match. |
| `findAll()` | Fetches every record in the relation without filtering. |

The next level extends `QueryDataService` directly when you want custom methods. Protected `db` access gives subclasses the full statement API:

```typescript
import { Database, QueryDataService } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

class UserRepository extends QueryDataService<User> {
  constructor(db: Database) {
    super('users', 'id', db);
  }

  async countActive(): Promise<number> {
    const filter = query<User>().where('active').equals(true).compile();
    return this.db.from<User>('users').select().byExpression(filter).executeReturnCount();
  }
}

export async function countActiveUsers(db: Database): Promise<number> {
  return new UserRepository(db).countActive();
}
```

---

## Configuration

`blendsdk/dbcore` has no global configuration. Settings live in two places: the connection options stored by the adapter, and the per-query options that control execution.

### Database connection — `DatabaseConfig`

Concrete adapters pass a `DatabaseConfig` object to the `Database` base constructor, where it is retained in the protected `config` property for the adapter to read. A typical configuration object:

```typescript
import { DatabaseConfig } from 'blendsdk/dbcore';

export const databaseConfig: DatabaseConfig = {
  host: 'db.internal.example.com',
  database: 'appdb',
  port: 5432,
  user: 'app_user',
  pass: process.env.DB_PASSWORD,
};
```

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `host` | `string` | `undefined` | Hostname or IP address of the database server. |
| `database` | `string` | `undefined` | Name of the database to connect to. |
| `port` | `string \| number` | `undefined` | Port the server listens on; may be given as a string or a number. |
| `user` | `string` | `undefined` | Username for authentication. |
| `pass` | `string` | `undefined` | Password for authentication. |

No field is required by dbcore itself — each concrete adapter decides which values are mandatory and how missing values are interpreted (for example, defaulting to a driver-specific port). Pass the object to your adapter's constructor; everything else (pool sizes, SSL modes, statement timeouts) is adapter-defined.

### Query execution — `ExecuteQueryOptions`

`ExecuteQueryOptions` carries the transformation hooks described in [Fundamentals 9](#9-transforming-queries-with-hooks). `Statement.execute()` assembles it automatically from the statement's `beforeQuery()` / `afterQuery()` registrations, but you can also pass it directly to `db.executeQuery()`:

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `beforeQuery` | `QueryParamHandler` | `undefined` | Called before execution with the parameter object; must return the transformed object. |
| `afterQuery` | `QueryResultHandler` | `undefined` | Called after execution with the raw result rows; must return the transformed rows. |

```typescript
import { Database, QueryResult } from 'blendsdk/dbcore';

interface UserRow {
  id: number;
  email: string;
}

export async function loadRawUsers(db: Database): Promise<QueryResult<UserRow> | null> {
  return db.executeQuery<UserRow>('SELECT id, email FROM users', {}, {
    afterQuery: (rows) => rows.map((row) => ({ ...row, email: String(row.email).toLowerCase() })),
  });
}
```

### Statement defaults

The builders share a small set of defaults that are worth knowing before you rely on them:

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `returning()` fields | `(keyof TableType)[] \| '*'` | `[]` — no `RETURNING` clause | Which fields the statement returns from modified rows; `'*'` selects all columns. |
| `values()` payload | `Partial<TableType>` | `{}` | Column/value pairs for INSERT and UPDATE; must be set before execution. |
| Row filter | compiled expression | none — no WHERE clause | UPDATE and DELETE statements without a filter affect every row in the table. |
| `select()` columns | `string[] \| Record<string, any>` | `'*'` (all columns) | `select()` without arguments — or `selectAll()` — projects every column. |

### Shutdown

`disconnect(timeoutMs?)` accepts an optional timeout for graceful shutdown. dbcore imposes no default value; when omitted, the adapter decides how to close. See [Fundamentals 1](#1-adapters-and-the-connection-lifecycle) for the `try`/`finally` pattern that guarantees the connection is released.

---

## Error Handling

`blendsdk/dbcore` deliberately defines no error classes of its own. Failures follow one simple contract: they become rejected promises, and dbcore never swallows or wraps them. Any `try/catch` you write around dbcore code is catching either the adapter's errors (typically driver errors) or your own — unchanged.

Where errors come from and what they mean:

| Error source | Meaning | Surfaces as |
| --- | --- | --- |
| Connection errors | The adapter could not reach the server or authenticate. | Rejected `connect()` promise. |
| Driver / query errors | Invalid SQL, constraint violations, or permission failures raised by the underlying database driver. | Rejected `executeQuery()` promise, propagating through `execute()` and every execution helper. |
| Transaction aborts | Your callback threw inside `withTransaction()`; the transaction was rolled back. | Rejected `withTransaction()` promise, carrying your original error. |
| Business-rule errors | Exceptions your own code throws — for example, validation inside a transaction. | Rejection of the surrounding promise; inside a transaction they also trigger rollback. |

Crucially, **empty results are not errors**: `executeReturnSingle()` resolves to `null`, `executeReturnAll()` to `[]`, `executeReturnCount()` to `0`, and `execute()` may resolve to `null`. Only rejections are failures. A wrapper that adds context is often all the handling you need:

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  email: string;
}

export async function loadUser(db: Database, id: number): Promise<Partial<User> | null> {
  const filter = query<User>().where('id').equals(id).compile();
  try {
    return await db.from<User>('users').select(['id', 'name', 'email']).byExpression(filter).executeReturnSingle();
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Loading user ${id} failed: ${error.message}`);
    }
    throw error;
  }
}
```

Inside transactions, throwing is the rollback mechanism — validate with thrown errors rather than flags, and decide at the call site whether to degrade gracefully:

```typescript
import { Database } from 'blendsdk/dbcore';

interface Order {
  id: number;
  customer_id: number;
  reference: string;
}

interface OrderLine {
  id: number;
  order_id: number;
  sku: string;
  quantity: number;
}

export async function createOrderWithLines(
  db: Database,
  customerId: number,
  reference: string,
  lines: Array<Pick<OrderLine, 'sku' | 'quantity'>>
): Promise<number | null> {
  try {
    return await db.withTransaction(async (tx) => {
      if (lines.length === 0) {
        throw new Error('An order must contain at least one line');
      }

      const order = await tx
        .insert<Order>('orders')
        .values({ customer_id: customerId, reference })
        .returning(['id'])
        .executeReturnSingle();

      if (!order || order.id === undefined) {
        throw new Error('INSERT did not return the new order id');
      }

      for (const line of lines) {
        await tx
          .insert<OrderLine>('order_lines')
          .values({ order_id: order.id, sku: line.sku, quantity: line.quantity })
          .executeReturnCount();
      }

      return order.id;
    });
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Order "${reference}" was rolled back: ${error.message}`);
      return null;
    }
    throw error;
  }
}
```

Guidelines worth following:

- Let errors propagate unless you can add context or offer a meaningful fallback — silently ignoring a failed write usually hides data loss.
- Inside `withTransaction()`, throw for every failure condition: a rejection is what guarantees the rollback.
- Check `error instanceof Error` before reading `.message`; rethrow anything you don't recognize unchanged.
- Treat "not found" through the resolved values (`null`, `[]`, `0`), not through exceptions.

---

For the design rationale behind these abstractions, see Core Concepts; for the exhaustive, signature-level listing of every export, see the API Reference.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
