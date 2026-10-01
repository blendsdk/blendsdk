> **Package**: `blendsdk/dbcore`

# dbcore API Reference

`blendsdk/dbcore` is the database core of BlendSDK. This document is the complete, signature-level reference for every class, function, interface, and type alias exported by the package root.

**Conventions used in this reference:**

- **Adapter requirement** — `Database` and most statement builders are abstract; only a concrete adapter (PostgreSQL, MySQL, or a custom implementation) provides working instances. Examples that operate on a database therefore take a `db: Database` parameter, the same convention used in the Overview and Core Concepts.
- **Expression symbols are external** — `query`, `QueryBuilder`, and `CompileResult` are *not* exported by this package. Import them from `blendsdk/expression`.
- **No enums or constants** — this package exports none.
- **Snippet style** — `typescript fragment` blocks are signature listings or partial snippets; `typescript` blocks are complete examples with all imports.

---

## Symbol Index

| Symbol | Kind | Summary |
| --- | --- | --- |
| `Database` | Abstract class | Adapter contract: connection lifecycle, query execution, transactions, and statement factory methods. |
| `DatabaseConfig` | Interface | Connection settings: `host`, `database`, `port`, `user`, `pass`. |
| `QueryResult<T>` | Interface | Query envelope with `records: T[]` and `rowCount: number`. |
| `ExecuteQueryOptions` | Interface | `beforeQuery` / `afterQuery` transformation hooks for `executeQuery()`. |
| `QueryParamHandler` | Type alias | `(params: Record<string, any>) => Record<string, any>`. |
| `QueryResultHandler` | Type alias | `(rows: any[]) => any[]`. |
| `Statement<TableType>` | Abstract class | Base builder: execution helpers and query lifecycle hooks. |
| `CrudStatement<TableType>` | Abstract class | Adds the `_values` payload and the `returning()` clause. |
| `FilterableStatement<TableType, FilterType>` | Abstract class | Adds `filter()` / `filterByExpression()` with cached compilation. |
| `InsertStatement<TableType>` | Abstract class | INSERT builder with `values()`. |
| `UpdateStatement<TableType, FilterType>` | Abstract class | UPDATE builder with `values()` and filtering. |
| `DeleteStatement<FilterType>` | Abstract class | DELETE builder with filtering. |
| `FromStatement<TableType>` | Class (concrete) | SELECT builder: `select()` and `byExpression()`. |
| `DataServiceBase` | Abstract class | Base for data services; holds the protected `db` reference. |
| `QueryDataService<RelationType>` | Abstract class | Read service: `findById`, `findByExpression`, `findAllByExpression`, `findAll`. |
| `createQueryService<RelationType>()` | Function | Factory that binds a `QueryDataService` subclass to a relation and id column. |
| `ExpressionBuilder<T>` | Type alias | `(q: QueryBuilder<T>) => void`. |
| `PromiseOfRecord<RecordType>` | Type alias | `Promise<Partial<RecordType>>`. |
| `PromiseOfRecordSet<RecordType>` | Type alias | `Promise<Partial<RecordType>[]>`. |

---

## Database and Query Types

Everything in this group belongs to the adapter contract. `Database` is the abstract class that concrete adapters implement; `DatabaseConfig`, `QueryResult<T>`, `ExecuteQueryOptions`, `QueryParamHandler`, and `QueryResultHandler` describe the configuration, results, and execution hooks that flow through it.

### Database

Abstract base class for database implementations. It provides a unified interface for connection management, parameterized query execution, transactions, and the factory methods for every statement builder in the package. Concrete adapters must implement the abstract members with database-specific connection handling and query execution; `from()` and `selectAll()` are implemented on the base class and return a concrete `FromStatement`, so SELECT construction is shared across all adapters.

**Declaration**

```typescript fragment
export abstract class Database {
  constructor(config: DatabaseConfig);

  protected config: DatabaseConfig;

  abstract connect(): Promise<any>;
  abstract disconnect(timeoutMs?: number): Promise<void>;
  abstract executeQuery<R>(query: string): Promise<QueryResult<R> | null>;
  abstract executeQuery<R>(query: string, params?: Record<string, any>): Promise<QueryResult<R> | null>;
  abstract executeQuery<R>(
    query: string,
    params: Record<string, any>,
    options?: ExecuteQueryOptions
  ): Promise<QueryResult<R> | null>;
  abstract withTransaction<T>(fn: (db: this) => Promise<T>): Promise<T>;
  abstract insert<T>(tableName: string): InsertStatement<T>;
  abstract update<T, F>(tableName: string): UpdateStatement<T, F>;
  abstract delete<F>(tableName: string): DeleteStatement<F>;

  from<T>(tableName: string): FromStatement<T>;
  selectAll<T>(tableName: string): FromStatement<T>;
}
```

**Constructor**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `config` | `DatabaseConfig` | Yes | — | Connection settings, stored in the protected `config` property for the adapter to use. |

**Properties**

| Property | Type | Description |
| --- | --- | --- |
| `config` | `protected DatabaseConfig` | Connection settings retained from the constructor. |

**Methods**

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `connect` | `abstract connect(): Promise<any>` | `Promise<any>` | Opens the database connection. Resolves with the adapter-specific connection object. |
| `disconnect` | `abstract disconnect(timeoutMs?: number): Promise<void>` | `Promise<void>` | Closes the connection and releases resources. The optional `timeoutMs` caps how long the adapter waits for a graceful shutdown. |
| `executeQuery` | `abstract executeQuery<R>(query: string, params?: Record<string, any>, options?: ExecuteQueryOptions): Promise<QueryResult<R> \| null>` | `Promise<QueryResult<R> \| null>` | Executes parameterized SQL. Resolves with the result envelope, or `null` when the driver returns no result. |
| `withTransaction` | `abstract withTransaction<T>(fn: (db: this) => Promise<T>): Promise<T>` | `Promise<T>` | Runs `fn` atomically: the transaction commits when `fn` resolves and rolls back when `fn` throws. The callback receives the transactional handle (`this`). |
| `insert` | `abstract insert<T>(tableName: string): InsertStatement<T>` | `InsertStatement<T>` | Creates the adapter's INSERT builder for the table. |
| `update` | `abstract update<T, F>(tableName: string): UpdateStatement<T, F>` | `UpdateStatement<T, F>` | Creates the adapter's UPDATE builder for the table. |
| `delete` | `abstract delete<F>(tableName: string): DeleteStatement<F>` | `DeleteStatement<F>` | Creates the adapter's DELETE builder for the table. |
| `from` | `from<T>(tableName: string): FromStatement<T>` | `FromStatement<T>` | Creates a concrete SELECT builder for the table. Implemented on the base class. |
| `selectAll` | `selectAll<T>(tableName: string): FromStatement<T>` | `FromStatement<T>` | Shorthand for `from(tableName).select()` — a `SELECT *` query. Implemented on the base class. |

`executeQuery` is declared with three overloads: query only; query plus parameters; and query plus parameters plus `ExecuteQueryOptions`. In the third overload, `params` is required while `options` remains optional. The adapter invokes `options.beforeQuery` on the parameter object before sending the query and applies `options.afterQuery` to the result rows before resolving.

**Example**

```typescript
import { Database } from 'blendsdk/dbcore';

export interface OrderTotal {
  customer_id: number;
  total: number;
}

export async function loadCustomerTotals(
  db: Database,
  tenantId: string
): Promise<OrderTotal[]> {
  await db.connect();
  try {
    return await db.withTransaction(async (tx) => {
      const result = await tx.executeQuery<OrderTotal>(
        'SELECT customer_id, SUM(amount) AS total FROM orders GROUP BY customer_id',
        {},
        {
          beforeQuery: (params) => ({ ...params, tenantId }),
          afterQuery: (rows) => rows.filter((row) => row.total > 0),
        }
      );
      return result?.records ?? [];
    });
  } finally {
    await db.disconnect(5000);
  }
}
```

### DatabaseConfig

Configuration settings for establishing a database connection. All properties are optional at the type level; each adapter decides which of them are required for its backend.

**Declaration**

```typescript fragment
export interface DatabaseConfig {
  host?: string;
  database?: string;
  port?: string | number;
  user?: string;
  pass?: string;
}
```

**Properties**

| Property | Type | Description |
| --- | --- | --- |
| `host?` | `string` | Hostname or IP address of the database server. |
| `database?` | `string` | Name of the database to connect to. |
| `port?` | `string \| number` | Port on which the database server is listening. |
| `user?` | `string` | Username for database authentication. |
| `pass?` | `string` | Password for database authentication. |

The config is typically supplied when constructing a concrete adapter:

```typescript fragment
const config: DatabaseConfig = {
  host: 'db.internal',
  database: 'app',
  port: 5432,
  user: 'app_user',
  pass: 's3cret',
};
```

### QueryResult

The uniform envelope for query execution results, containing the returned records and metadata about the execution.

**Declaration**

```typescript fragment
export interface QueryResult<T> {
  records: T[];
  rowCount: number;
}
```

**Properties**

| Property | Type | Description |
| --- | --- | --- |
| `records` | `T[]` | Records returned by the query, typed by the generic parameter `T`. |
| `rowCount` | `number` | Rows returned (SELECT queries) or rows affected (INSERT/UPDATE/DELETE queries). |

```typescript fragment
const result: QueryResult<UserRow> | null = await db.executeQuery<UserRow>('SELECT id, name FROM users');
const rows: UserRow[] = result?.records ?? [];
const count: number = result?.rowCount ?? 0;
```

### ExecuteQueryOptions

Configuration options for executing database queries. Provides transform hooks that the adapter applies around query execution.

**Declaration**

```typescript fragment
export interface ExecuteQueryOptions {
  beforeQuery?: QueryParamHandler;
  afterQuery?: QueryResultHandler;
}
```

**Properties**

| Property | Type | Description |
| --- | --- | --- |
| `beforeQuery` | `QueryParamHandler` | Optional. Invoked before query execution to transform the parameter object — useful for validation, sanitization, or scoping values. |
| `afterQuery` | `QueryResultHandler` | Optional. Invoked after query execution to transform the raw result rows — useful for field mapping or post-processing. |

**Example**

```typescript
import { ExecuteQueryOptions } from 'blendsdk/dbcore';

export function tenantScopedOptions(tenantId: string): ExecuteQueryOptions {
  return {
    beforeQuery: (params) => ({ ...params, tenantId }),
    afterQuery: (rows) => rows.slice(0, 100),
  };
}
```

### QueryParamHandler

Function type for transforming query parameters before execution. Shape-preserving: it receives a parameter object and must return a parameter object.

**Declaration**

```typescript fragment
export type QueryParamHandler = (params: Record<string, any>) => Record<string, any>;
```

Used by `ExecuteQueryOptions.beforeQuery`; the concrete adapter invokes the handler with the built parameter object before sending the query to the database.

```typescript fragment
const handler: QueryParamHandler = (params) => ({ ...params, tenantId: 'acme' });
```

### QueryResultHandler

Function type for transforming query result rows after execution. It receives the raw row array and must return an array of rows.

**Declaration**

```typescript fragment
export type QueryResultHandler = (rows: any[]) => any[];
```

Used by `ExecuteQueryOptions.afterQuery`; the concrete adapter applies the handler to the raw result rows before resolving the `QueryResult`.

```typescript fragment
const handler: QueryResultHandler = (rows) => rows.slice(0, 100);
```

---

## Statement Builders

Every query builder in the package descends from `Statement`. The hierarchy splits into the concrete SELECT builder and the abstract CRUD builders, which adapters implement for their SQL dialect and parameter syntax:

```text
Statement<TableType>
├── FromStatement<TableType>                       (concrete — SELECT)
└── CrudStatement<TableType>                       (abstract — shared CRUD state)
    ├── InsertStatement<TableType>                 (abstract — INSERT)
    └── FilterableStatement<TableType, FilterType> (abstract — WHERE support)
        ├── UpdateStatement<TableType, FilterType> (abstract — UPDATE)
        └── DeleteStatement<FilterType>            (abstract — DELETE)
```

All CRUD builders are obtained through the `Database` factories (`insert()`, `update()`, `delete()`), which concrete adapters implement. `FromStatement` instances come from `Database.from()` and `Database.selectAll()`.

### Statement

Abstract base class for all SQL statement builders. Implements the Template Method pattern: `execute()` orchestrates query execution, while concrete subclasses supply `buildQuery()` and `buildParameters()`. On top of that, it provides four execution helpers and two lifecycle hooks for transforming parameters and result rows.

**Declaration**

```typescript fragment
export abstract class Statement<TableType = any> {
  constructor(db: Database);

  protected db: Database;
  protected _beforeQuery: ((params: any) => any) | null;
  protected _afterQuery: ((rows: any) => any) | null;

  protected abstract buildQuery(): string;
  protected abstract buildParameters(): any;

  execute<R extends QueryResult<any> = QueryResult<any>>(): Promise<R | null>;
  executeReturnSingle(): Promise<Partial<TableType> | null>;
  executeReturnAll(): Promise<Partial<TableType>[]>;
  executeReturnCount(): Promise<number>;
  beforeQuery<T>(handler: (params: T) => T): this;
  afterQuery<T>(handler: (rows: T) => T): this;
}
```

**Constructor**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `db` | `Database` | Yes | — | The database instance used to execute the built query. Stored in the protected `db` property. |

**Properties**

| Property | Type | Description |
| --- | --- | --- |
| `db` | `protected Database` | Database instance used by `execute()`. |
| `_beforeQuery` | `protected ((params: any) => any) \| null` | Parameter transformer registered through `beforeQuery()`; `null` until set. |
| `_afterQuery` | `protected ((rows: any) => any) \| null` | Result-row transformer registered through `afterQuery()`; `null` until set. |

**Methods**

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `buildQuery` | `protected abstract buildQuery(): string` | `string` | Produces the SQL string; implemented by every concrete builder. |
| `buildParameters` | `protected abstract buildParameters(): any` | `any` | Produces the parameter object; implemented by every concrete builder. |
| `execute` | `execute<R extends QueryResult<any> = QueryResult<any>>(): Promise<R \| null>` | `Promise<R \| null>` | Builds the query and parameters, attaches any registered hooks as `ExecuteQueryOptions`, and delegates to `db.executeQuery()`. |
| `executeReturnSingle` | `async executeReturnSingle(): Promise<Partial<TableType> \| null>` | `Promise<Partial<TableType> \| null>` | Executes and returns the first record, or `null` when there are no records (or the adapter resolves `null`). |
| `executeReturnAll` | `async executeReturnAll(): Promise<Partial<TableType>[]>` | `Promise<Partial<TableType>[]>` | Executes and returns all records, or `[]`. |
| `executeReturnCount` | `async executeReturnCount(): Promise<number>` | `Promise<number>` | Executes and returns `rowCount`, or `0`. |
| `beforeQuery` | `beforeQuery<T>(handler: (params: T) => T): this` | `this` | Registers a shape-preserving parameter transformer; chainable. |
| `afterQuery` | `afterQuery<T>(handler: (rows: T) => T): this` | `this` | Registers a shape-preserving result-row transformer; chainable. |

**Example**

Because `Statement` is abstract, the example defines a concrete raw-SQL statement and executes it with a registered `afterQuery` hook:

```typescript
import { Database, Statement } from 'blendsdk/dbcore';

export interface SessionRow {
  id: number;
  expires_at: string;
}

export class ExpiredSessionsStatement extends Statement<SessionRow> {
  constructor(
    private readonly cutoff: string,
    db: Database
  ) {
    super(db);
  }

  protected buildQuery(): string {
    return 'SELECT id, expires_at FROM sessions WHERE expires_at < :cutoff';
  }

  protected buildParameters(): Record<string, unknown> {
    return { cutoff: this.cutoff };
  }
}

export async function findExpiredSessions(db: Database, cutoff: string): Promise<Partial<SessionRow>[]> {
  const statement = new ExpiredSessionsStatement(cutoff, db);
  statement.afterQuery<Partial<SessionRow>[]>((rows) => rows.slice(0, 50));
  return statement.executeReturnAll();
}
```

### CrudStatement

Abstract base class for the data-modification builders (INSERT, UPDATE, DELETE). It extends `Statement` with the shared CRUD state — the `_values` payload and the `_returning` field list — and the fluent `returning()` method that configures a `RETURNING` clause. `InsertStatement` extends it directly; `UpdateStatement` and `DeleteStatement` reach it through `FilterableStatement`.

**Declaration**

```typescript fragment
export abstract class CrudStatement<TableType> extends Statement<TableType> {
  constructor(tableName: string, db: Database);

  protected tableName: string;
  protected _returning: string[];
  protected _values: Partial<TableType>;

  returning(fields: (keyof TableType)[] | '*'): this;
}
```

**Constructor**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `tableName` | `string` | Yes | — | The table the statement operates on. Stored in the protected `tableName` property. |
| `db` | `Database` | Yes | — | The database instance used to execute the built query. |

**Properties**

| Property | Type | Description |
| --- | --- | --- |
| `tableName` | `protected string` | The table the statement operates on; set via the constructor. |
| `_returning` | `protected string[]` | Field names for the `RETURNING` clause; initialized to `[]`. |
| `_values` | `protected Partial<TableType>` | Column/value payload; initialized to `{}` and written by the `values()` methods of the concrete subclasses. |

**Methods**

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `returning` | `returning(fields: (keyof TableType)[] \| '*'): this` | `this` | Configures which fields to return after the operation. The literal `'*'` is stored as `['*']` (all columns); an array of field names is stored verbatim in `_returning`. Chainable. |

```typescript fragment
statement.returning(['id', 'created_at']); // RETURNING id, created_at
statement.returning('*');                  // RETURNING *
```

**Example**

Because `CrudStatement` is abstract, the example builds through a `Database` factory, where `returning()` is inherited by every CRUD builder:

```typescript
import { Database } from 'blendsdk/dbcore';

export interface Product {
  id: number;
  sku: string;
  name: string;
  created_at: string;
}

export async function createProduct(
  db: Database,
  sku: string,
  name: string
): Promise<Partial<Product> | null> {
  return db
    .insert<Product>('products')
    .values({ sku, name })
    .returning(['id', 'created_at'])
    .executeReturnSingle();
}
```

### FilterableStatement

Abstract statement builder that adds WHERE-clause construction to CRUD statements. It sits between `CrudStatement` and the `UpdateStatement` / `DeleteStatement` classes and centralizes both filtering entry points: `filter()` for simple key/value equality criteria and `filterByExpression()` for complex predicates built with the `blendsdk/expression` DSL. It also owns the cached compilation of the expression builder, so the filter is compiled exactly once per statement.

**Declaration**

```typescript fragment
export abstract class FilterableStatement<TableType, FilterType> extends CrudStatement<TableType> {
  constructor(tableName: string, db: Database);

  protected _expressionBuilder?: (q: QueryBuilder<FilterType>) => QueryBuilder<FilterType>;
  protected _compiledExpression?: CompileResult;

  protected getCompiledExpression(): CompileResult | null;
  filter(values: Partial<FilterType>): this;
  filterByExpression(builder: (q: QueryBuilder<FilterType>) => QueryBuilder<FilterType>): this;
}
```

**Constructor**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `tableName` | `string` | Yes | — | The table the statement operates on. |
| `db` | `Database` | Yes | — | The database instance used to execute the built query. |

**Properties**

| Property | Type | Description |
| --- | --- | --- |
| `_expressionBuilder` | `protected ((q: QueryBuilder<FilterType>) => QueryBuilder<FilterType>) \| undefined` | The composed expression builder; `undefined` until `filter()` or `filterByExpression()` is called. |
| `_compiledExpression` | `protected CompileResult \| undefined` | Cached result of compiling the expression builder; populated on the first `getCompiledExpression()` call. |

**Methods**

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `getCompiledExpression` | `protected getCompiledExpression(): CompileResult \| null` | `CompileResult \| null` | Compiles the composed expression builder once and caches the result; returns `null` when no filter is registered. Concrete adapters use this to render the WHERE clause and bind its parameters. |
| `filter` | `filter(values: Partial<FilterType>): this` | `this` | Adds equality criteria: the first key becomes `where(key).equals(value)`, each subsequent key `and(key).equals(value)` — all combined with AND. Merges with any existing filter. Chainable. |
| `filterByExpression` | `filterByExpression(builder: (q: QueryBuilder<FilterType>) => QueryBuilder<FilterType>): this` | `this` | Adds a full expression-DSL predicate; merged with any existing filter using AND. Chainable. |

```typescript fragment
// Simple equality filters (combined with AND)
statement.filter({ id: 1, active: true });

// Complex predicate via the blendsdk/expression DSL
statement.filterByExpression((q) => q.where('age').greaterThan(65).or('status').equals('inactive'));

// Both entry points can be chained — merged with AND
statement
  .filter({ active: true })
  .filterByExpression((q) => q.where('last_login').lessThan(cutoffDate));
```

**Example**

```typescript
import { Database } from 'blendsdk/dbcore';

export interface Account {
  id: number;
  status: string;
  balance: number;
  last_activity: string;
}

export interface AccountFilter {
  status: string;
  last_activity: string;
}

export async function closeDormantAccounts(db: Database, cutoff: string): Promise<number> {
  return db
    .update<Account, AccountFilter>('accounts')
    .values({ status: 'closed' })
    .filter({ status: 'active' })
    .filterByExpression((q) => q.where('last_activity').lessThan(cutoff))
    .returning(['id', 'status'])
    .executeReturnCount();
}
```

### InsertStatement

Abstract statement builder for INSERT operations. It extends `CrudStatement` and adds the `values()` method that records the column/value payload for the new row. Combined with the inherited `returning()`, it supports the full "insert a row and get the generated record back" workflow. Concrete adapters must extend this class to produce their dialect's `INSERT` SQL and parameter syntax.

**Declaration**

```typescript fragment
export abstract class InsertStatement<TableType> extends CrudStatement<TableType> {
  constructor(tableName: string, db: Database);

  values(values: Partial<TableType>): this;
}
```

**Constructor**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `tableName` | `string` | Yes | — | The table to insert into. |
| `db` | `Database` | Yes | — | The database instance used to execute the built query. |

**Methods**

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `values` | `values(values: Partial<TableType>): this` | `this` | Sets the column/value payload for the new row. Replaces any previous payload; the adapter renders these columns in the `INSERT`. Chainable. |

Also inherits `returning()` from [CrudStatement](#crudstatement) and all execution helpers and hooks from [Statement](#statement).

**Example**

```typescript
import { Database } from 'blendsdk/dbcore';

export interface User {
  id: number;
  name: string;
  email: string;
  created_at: string;
}

export async function registerUser(
  db: Database,
  name: string,
  email: string
): Promise<Partial<User> | null> {
  return db
    .insert<User>('users')
    .values({ name, email })
    .returning(['id', 'created_at'])
    .executeReturnSingle();
}
```

### UpdateStatement

Abstract statement builder for UPDATE operations. It extends `FilterableStatement`, inheriting the complete filtering toolset, and adds `values()` for the new column values. The two generic parameters separate the table shape (`TableType`, used by `values()` and `returning()`) from the filter shape (`FilterType`, used by `filter()`), so you can filter by a narrow criterion object while updating full records.

**Declaration**

```typescript fragment
export abstract class UpdateStatement<TableType, FilterType> extends FilterableStatement<TableType, FilterType> {
  constructor(tableName: string, db: Database);

  values(values: Partial<TableType>): this;
}
```

**Constructor**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `tableName` | `string` | Yes | — | The table to update. |
| `db` | `Database` | Yes | — | The database instance used to execute the built query. |

**Methods**

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `values` | `values(values: Partial<TableType>): this` | `this` | Sets the new column values for the `UPDATE`. Replaces any previous payload; the adapter renders these columns as `SET` assignments. Chainable. |

Also inherits `filter()` and `filterByExpression()` from [FilterableStatement](#filterablestatement) and `returning()` from [CrudStatement](#crudstatement).

**Example**

```typescript
import { Database } from 'blendsdk/dbcore';

export interface Article {
  id: number;
  title: string;
  status: string;
  updated_at: string;
}

export async function publishArticle(db: Database, id: number): Promise<Partial<Article> | null> {
  return db
    .update<Article, { id: number }>('articles')
    .values({ status: 'published' })
    .filter({ id })
    .returning(['id', 'status', 'updated_at'])
    .executeReturnSingle();
}
```

### DeleteStatement

Abstract statement builder for DELETE operations. It extends `FilterableStatement<FilterType, FilterType>` — the filter type serves as both the statement's table type and its filter type — and adds no members of its own: deletion is expressed entirely through the inherited `filter()`, `filterByExpression()`, and `returning()` methods plus the execution helpers. Concrete adapters implement `buildQuery()` / `buildParameters()` for their dialect.

**Declaration**

```typescript fragment
export abstract class DeleteStatement<FilterType> extends FilterableStatement<FilterType, FilterType> {
  constructor(tableName: string, db: Database);
}
```

**Constructor**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `tableName` | `string` | Yes | — | The table to delete from. |
| `db` | `Database` | Yes | — | The database instance used to execute the built query. |

**Members**

`DeleteStatement` declares no methods or properties beyond those inherited from [FilterableStatement](#filterablestatement) and [Statement](#statement). Without a filter the statement targets the entire table; apply `filter()` or `filterByExpression()` for targeted deletions.

**Example**

```typescript
import { Database } from 'blendsdk/dbcore';

export interface Session {
  id: number;
  user_id: number;
  expires_at: string;
}

export async function purgeSessions(db: Database, now: string): Promise<Partial<Session>[]> {
  return db
    .delete<Session>('sessions')
    .filterByExpression((q) => q.where('expires_at').lessThan(now))
    .returning(['id', 'user_id'])
    .executeReturnAll();
}
```

### FromStatement

Statement builder for SELECT queries and the only concrete statement class in the package. It combines the SELECT clause (plain column lists or aliased expressions), the FROM clause, and an optional WHERE clause compiled by `blendsdk/expression` into a single parameterized statement. Instances are created exclusively through `Database.from<T>()` and `Database.selectAll<T>()`.

**Declaration**

```typescript fragment
export class FromStatement<TableType> extends Statement<TableType> {
  constructor(tableName: string, db: Database);

  protected tableName: string;
  protected _selectColumns: string[];
  protected _parameters: Record<string, any>;
  protected _whereClause: string;

  protected buildParameters(): Record<string, any>;
  protected buildQuery(): string;

  select(columns?: string[] | Record<string, any>): this;
  byExpression(filter: CompileResult): this;
}
```

**Constructor**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `tableName` | `string` | Yes | — | The name of the table to select from. Stored in the protected `tableName` property. |
| `db` | `Database` | Yes | — | The database instance used to execute the built query. |

**Properties**

| Property | Type | Description |
| --- | --- | --- |
| `tableName` | `protected string` | The table to select from; set via the constructor. |
| `_selectColumns` | `protected string[]` | Resolved column list used by `buildQuery()`; initialized to `[]` and written by `select()`. |
| `_parameters` | `protected Record<string, any>` | Parameters bound from the compiled expression; initialized to `{}`. |
| `_whereClause` | `protected string` | Rendered WHERE clause; initialized to `''` (omitted from the query). |

**Methods**

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `select` | `select(columns?: string[] \| Record<string, any>): this` | `this` | Sets the column list. Omitted → `*`; an array is used verbatim as plain columns; an object maps each key to an alias and each value to an expression, rendering `${value} AS ${key}`. Chainable. |
| `byExpression` | `byExpression(filter: CompileResult): this` | `this` | Applies a compiled WHERE clause and its bound parameters (from `blendsdk/expression`). Chainable. |
| `buildQuery` | `protected buildQuery(): string` | `string` | Assembles `SELECT <columns> FROM <table>[ WHERE ...]`. |
| `buildParameters` | `protected buildParameters(): Record<string, any>` | `Record<string, any>` | Returns the stored parameters for execution. |

```typescript fragment
statement.select();                          // SELECT * FROM users
statement.select(['id', 'name']);            // SELECT id, name FROM users
statement.select({ total: 'price * qty' });  // SELECT price * qty AS total FROM ...
```

**Example**

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

export interface Order {
  id: number;
  customer_id: number;
  total: number;
  status: string;
}

export async function listPaidOrders(db: Database, customerId: number): Promise<Partial<Order>[]> {
  const filter = query<Order>()
    .where('customer_id')
    .equals(customerId)
    .and('status')
    .equals('paid')
    .compile();

  return db
    .from<Order>('orders')
    .select(['id', 'total', 'status'])
    .byExpression(filter)
    .executeReturnAll();
}
```

---

## Data Services

The data-service layer wraps read queries into repository-style classes. `DataServiceBase` holds the protected `db` reference; `QueryDataService` builds the common read patterns on top of the `FromStatement` builder; `createQueryService()` removes the last bit of boilerplate by returning a ready-to-instantiate, relation-bound subclass.

### DataServiceBase

Abstract base class for data services. It provides subclasses with the protected `db` reference and nothing else — the class exists so that any service, read or write, shares a single, consistent way to reach the database.

**Declaration**

```typescript fragment
export abstract class DataServiceBase {
  constructor(db: Database);

  protected db: Database;
}
```

**Constructor**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `db` | `Database` | Yes | — | The database instance shared with subclasses. Stored in the protected `db` property. |

**Properties**

| Property | Type | Description |
| --- | --- | --- |
| `db` | `protected Database` | The database instance used by this data service. Protected to enforce encapsulation: subclasses access it directly, external consumers interact through the service's public API. |

**Example**

```typescript
import { DataServiceBase, Database } from 'blendsdk/dbcore';

export class HealthService extends DataServiceBase {
  constructor(db: Database) {
    super(db);
  }

  async ping(): Promise<boolean> {
    const result = await this.db.executeQuery<{ alive: number }>('SELECT 1 AS alive');
    return (result?.rowCount ?? 0) > 0;
  }
}

export async function checkDatabase(db: Database): Promise<boolean> {
  return new HealthService(db).ping();
}
```

### QueryDataService

Abstract base class for read-only data services bound to a single relation (table or view) and a primary-key column. It provides the four common read patterns — `findById()`, `findByExpression()`, `findAllByExpression()`, and `findAll()` — constructed with the `blendsdk/expression` builder and executed through the `FromStatement` builder. Extend this class directly for custom behavior, or use `createQueryService()` to obtain a concrete subclass without any boilerplate.

**Declaration**

```typescript fragment
export abstract class QueryDataService<RelationType> extends DataServiceBase {
  constructor(relation: string, idColumn: string, db: Database);

  public relation: string;
  public idColumn: string;

  findById<IdType>(id: IdType): PromiseOfRecord<RelationType | null>;
  findByExpression(builder: ExpressionBuilder<RelationType>): PromiseOfRecord<RelationType | null>;
  findAllByExpression(builder: ExpressionBuilder<RelationType>): PromiseOfRecordSet<RelationType>;
  findAll(): PromiseOfRecordSet<RelationType>;
}
```

**Constructor**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `relation` | `string` | Yes | — | The name of the database relation (table or view) to query. Stored in the public `relation` property. |
| `idColumn` | `string` | Yes | — | The name of the primary-key column used by `findById()`. Stored in the public `idColumn` property. |
| `db` | `Database` | Yes | — | The database instance used to execute queries. Passed through to `DataServiceBase`. |

**Properties**

| Property | Type | Description |
| --- | --- | --- |
| `relation` | `public string` | The relation (table or view) this service queries. |
| `idColumn` | `public string` | The primary-key column used by `findById()`. |

**Methods**

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `findById` | `findById<IdType>(id: IdType): PromiseOfRecord<RelationType \| null>` | `PromiseOfRecord<RelationType \| null>` | Selects the record whose `idColumn` equals `id`; resolves with the record or `null`. |
| `findByExpression` | `findByExpression(builder: ExpressionBuilder<RelationType>): PromiseOfRecord<RelationType \| null>` | `PromiseOfRecord<RelationType \| null>` | Selects the first record matching the compiled expression; resolves with the record or `null`. |
| `findAllByExpression` | `findAllByExpression(builder: ExpressionBuilder<RelationType>): PromiseOfRecordSet<RelationType>` | `PromiseOfRecordSet<RelationType>` | Selects all records matching the compiled expression; resolves with `[]` when none match. |
| `findAll` | `findAll(): PromiseOfRecordSet<RelationType>` | `PromiseOfRecordSet<RelationType>` | Selects all records without filtering; resolves with `[]` for an empty relation. |

Return values are typed through the `PromiseOfRecord` / `PromiseOfRecordSet` aliases, which wrap `Partial<RelationType>`.

**Example**

```typescript
import { Database, QueryDataService } from 'blendsdk/dbcore';

export interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

export class UserService extends QueryDataService<User> {
  constructor(db: Database) {
    super('users', 'id', db);
  }

  findActive(): Promise<Partial<User>[]> {
    return this.findAllByExpression((q) => q.where('active').equals(true));
  }
}

export async function loadUser(db: Database, id: number): Promise<Partial<User> | null> {
  const service = new UserService(db);
  return service.findById(id);
}

export async function loadActiveUsers(db: Database): Promise<Partial<User>[]> {
  const service = new UserService(db);
  const byId = await service.findById(1);
  const active = await service.findActive();
  return byId ? [byId, ...active] : active;
}
```

### createQueryService

Factory function that creates a concrete `QueryDataService` subclass for a specific relation. The returned class only requires a `Database` instance in its constructor — the relation name and id column are bound at creation time.

**Declaration**

```typescript fragment
export function createQueryService<RelationType>(
  relationName: string,
  idColumn: string
): new (db: Database) => QueryDataService<RelationType>;
```

**Parameters**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `relationName` | `string` | Yes | — | The name of the relation (table or view) the service queries. |
| `idColumn` | `string` | Yes | — | The name of the primary-key column used by `findById()`. |

**Returns**

`new (db: Database) => QueryDataService<RelationType>` — a concrete subclass of `QueryDataService<RelationType>` whose constructor takes only a `Database` instance.

**Example**

```typescript
import { Database, createQueryService } from 'blendsdk/dbcore';

export interface Invoice {
  id: number;
  number: string;
  total: number;
}

const InvoiceService = createQueryService<Invoice>('invoices', 'id');

export async function loadLargeInvoices(db: Database): Promise<Partial<Invoice>[]> {
  const service = new InvoiceService(db);
  return service.findAllByExpression((q) => q.where('total').greaterThan(1000));
}
```

### ExpressionBuilder

Function type for building query expressions with type-safe column references, as accepted by `QueryDataService.findByExpression()` and `QueryDataService.findAllByExpression()`. The callback receives a `QueryBuilder<T>` instance and configures it in place; the service then compiles the builder and applies it to the SELECT query.

**Declaration**

```typescript fragment
export type ExpressionBuilder<T = any> = (q: QueryBuilder<T>) => void;
```

The source declares `T = any` as the default type parameter; supply a concrete relation type in new code. `QueryBuilder` is exported by `blendsdk/expression` and is referenced here only.

```typescript fragment
const builder: ExpressionBuilder<User> = (q) => q.where('active').equals(true);
```

### PromiseOfRecord

Promise type alias for a single partial record from a relation. Used as the return type of `QueryDataService.findById()` and `QueryDataService.findByExpression()` (instantiated there as `PromiseOfRecord<RelationType | null>`).

**Declaration**

```typescript fragment
export type PromiseOfRecord<RecordType> = Promise<Partial<RecordType>>;
```

### PromiseOfRecordSet

Promise type alias for a set of partial records from a relation. Used as the return type of `QueryDataService.findAllByExpression()` and `QueryDataService.findAll()`.

**Declaration**

```typescript fragment
export type PromiseOfRecordSet<RecordType> = Promise<Partial<RecordType>[]>;
```

---

## Related Resources

- Overview — package summary, architecture, and dependencies.
- Core Concepts — conceptual deep dives with a complete adapter implementation.
- Basic Usage — step-by-step usage patterns.
- `blendsdk/expression` — the expression DSL (`query`, `QueryBuilder`, `CompileResult`) consumed by `filterByExpression()` and `byExpression()`. These symbols are not re-exported by `blendsdk/dbcore` and must be imported from their own package.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
