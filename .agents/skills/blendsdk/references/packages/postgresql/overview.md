> **Package**: `blendsdk/postgresql`

# postgresql Overview

---

## What It Is

`blendsdk/postgresql` is the PostgreSQL database adapter for the BlendSDK ecosystem. It implements the database contracts defined by `blendsdk/dbcore` on top of the `pg` driver and the `yesql` parameter translator, exposing a promise-based, strictly typed API for connection-pool management, named-parameter query execution, and transaction handling, together with PostgreSQL-specific builders for `INSERT`, `UPDATE`, and `DELETE` statements (`PostgreSQLInsertStatement`, `PostgreSQLUpdateStatement`, `PostgreSQLDeleteStatement`). The package is ESM-only, targets Node.js >= 22, and serves as the persistence layer for applications built on the BlendSDK, distributed as part of the `blendsdk` umbrella package.

---

## Key Features

- **Connection pooling** — every `PostgreSQLDatabase` instance owns a `pg.Pool`; behavior is tunable through `PoolConfig` (`max` default 10, `idleTimeoutMillis` default 30000, `connectionTimeoutMillis` default 0 = no timeout).
- **Named parameters** — queries use `:paramName` placeholders; `yesql` converts them to positional parameters, so values are always safely bound (no string concatenation, no SQL injection).
- **Typed query results** — `executeQuery<R>()` resolves to `PostgreSQLQueryResult<R>` with `records: R[]`, `rowCount`, and PostgreSQL `fields: FieldDef[]` column metadata.
- **Transactions** — `withTransaction()` wraps a callback in `BEGIN` / `COMMIT` / `ROLLBACK`, pins a single pooled client for the duration of the transaction, always releases it, and rethrows the original error after rollback.
- **Fluent statement builders** — `insert<T>()`, `update<T, F>()`, and `delete<F>()` return chainable, generically typed builders supporting `.values()`, `.filter()`, `.returning()`, `.beforeQuery()`, `.afterQuery()`, and the terminal methods `.execute()`, `.executeReturnSingle()`, `.executeReturnAll()`, and `.executeReturnCount()`.
- **Query hooks** — `beforeQuery(params)` transforms parameters immediately before execution; `afterQuery(rows)` transforms result rows before they leave the adapter (password hashing, email normalization, redaction of sensitive columns, computed fields).
- **Graceful shutdown** — `disconnect(timeoutMs = 10000)` drains the pool, falls back to a forced disconnect on timeout, and exposes an opt-in `enableGracefulShutdown` flag that registers `SIGINT` / `SIGTERM` handlers.
- **Shutdown guards** — after `disconnect()` begins, new queries and transactions fail fast with explicit errors (`Cannot execute query: database is shutting down`) instead of hanging.
- **Expression-based filtering** — statement builders integrate with the shared expression compiler from `blendsdk/expression` (`filterByExpression()`, `byExpression()`) and reuse cached compiled expressions.

---

## When To Use

Use `blendsdk/postgresql` when:

- You are building an ESM Node.js (>= 22) service whose primary datastore is PostgreSQL and you prefer explicit SQL over ORM abstraction.
- You want parameterized queries with named placeholders and typed result records.
- You need multi-statement transactional workflows with automatic rollback and guaranteed connection release.
- You want reusable, type-aware builders for `INSERT` / `UPDATE` / `DELETE`, including `RETURNING` support.
- You need centralized parameter and result transformation (hashing, normalization, redaction, audit fields) applied through hooks instead of scattered code.
- You are already working within the BlendSDK stack — including applications whose database lifecycle is managed by a `blendsdk/webafx` WebApplication — and want the PostgreSQL implementation of the shared `Database` contract.

Do not use this package when:

- You need a full ORM (entity mapping, relations, migrations, schema synchronization) — this is a query adapter, not an ORM.
- You target a database other than PostgreSQL — the API surface (query text, `RETURNING`, `pg` result metadata) is PostgreSQL-specific.

---

## Architecture

The package is a thin, strictly typed adapter layer. Its public surface is spread over four modules:

| Module | Exports | Responsibility |
| --- | --- | --- |
| `database.ts` | `PostgreSQLDatabase`, `PostgreSQLConfig`, `PoolConfig`, `PostgreSQLQueryResult` | Connection lifecycle, pooled query execution, transaction control, statement factories |
| `insert-statement.ts` | `PostgreSQLInsertStatement` | Renders `INSERT INTO ... (cols) VALUES (...) [RETURNING ...]` |
| `update-statement.ts` | `PostgreSQLUpdateStatement` | Renders `UPDATE ... SET ... [WHERE ...] [RETURNING ...]` with `:v_`-prefixed value parameters |
| `delete-statement.ts` | `PostgreSQLDeleteStatement` | Renders `DELETE FROM ... [WHERE ...] [RETURNING ...]` |

### Layered view

```text
Application code
  └─ uses ─▶ PostgreSQLDatabase                            (blendsdk/postgresql)
       ├── executeQuery() / withTransaction()              → pg.Pool → PostgreSQL server
       ├── insert()  → PostgreSQLInsertStatement           ┐
       ├── update()  → PostgreSQLUpdateStatement           ├─ extend the abstract statement
       └── delete()  → PostgreSQLDeleteStatement           ┘  base classes in blendsdk/dbcore
     Named parameters (:name) are translated to positional parameters ($n) by yesql
```

### Primary API surface

| Member | Kind | Description |
| --- | --- | --- |
| `PostgreSQLDatabase` | class | Main entry point: pool management, query execution, transactions, statement factories |
| `executeQuery<R>(query, params?, options?)` | method | Executes named-parameter SQL with optional hooks; resolves to `PostgreSQLQueryResult<R>` |
| `withTransaction<T>(fn)` | method | Executes `fn` inside a transaction with automatic commit/rollback |
| `insert<T>()` / `update<T, F>()` / `delete<F>()` | methods | Factory methods returning PostgreSQL statement builders |
| `disconnect(timeoutMs?)` | method | Drains and closes the connection pool with timeout protection |
| `PostgreSQLConfig` | interface | Connection settings plus `poolConfig` and `enableGracefulShutdown` |
| `PoolConfig` | interface | `max`, `idleTimeoutMillis`, `connectionTimeoutMillis` |
| `PostgreSQLQueryResult<R>` | interface | `records: R[]`, `rowCount: number`, `fields: FieldDef[]` |

Because `PostgreSQLDatabase` extends the base `Database` class, the shared capabilities of `blendsdk/dbcore` are also available on the same instance — for example `from()` / `selectAll()` SELECT builders and compiled expression integration.

### Key design patterns

- **Adapter** — wraps the `pg` driver and `yesql` translation behind the vendor-neutral `Database` contract from `blendsdk/dbcore`.
- **Factory Method** — `insert()`, `update()`, and `delete()` instantiate the PostgreSQL-specific statement classes rather than the base classes.
- **Template Method** — each statement class overrides only the protected extension points `buildQuery()` and `buildParameters()`; the base classes own the fluent API, expression compilation caching (`getCompiledExpression()`), `RETURNING` state, and the `execute*` terminal methods.
- **Builder** — statements are assembled with fluent chains (`values → filter → returning → hooks → execute`) that produce query text plus a parameter object at build time.
- **Strategy (callbacks)** — `beforeQuery` and `afterQuery` hooks plug parameter/row transformation strategies into execution without subclassing.
- **Object Pool** — one `pg.Pool` per database instance; standalone queries check out a client for a single interaction (atomic), while `withTransaction()` pins one client for the whole transaction and reuses it for every nested statement.
- **Guard clauses** — an internal `isShuttingDown` flag rejects new queries and transactions once shutdown begins.

### Query execution flow (`executeQuery`)

1. Reject the call if shutdown has started.
2. Check out a pool client (unless a transaction client is already pinned).
3. Apply the optional `beforeQuery(params)` transformation.
4. Convert `:name` placeholders to positional parameters via `yesql`.
5. Execute the query; if rows are returned and an `afterQuery` hook exists, transform the rows.
6. Release the client if it was checked out for this call, then return `{ records, rowCount, fields }`.

---

## Dependencies

### Runtime dependencies

| Package | Version | Purpose |
| --- | --- | --- |
| `blendsdk/dbcore` | `^5.x` | Base `Database` class, `DatabaseConfig`, `QueryResult`, `ExecuteQueryOptions`, and the abstract statement classes this package extends |
| `pg` | `^8.22.0` | PostgreSQL driver and connection pool (`Pool`, `PoolClient`, `FieldDef`) |
| `yesql` | `^7.0.0` | Translates named (`:name`) parameters to positional parameters |

**Peer dependencies:** none — every driver dependency is a regular dependency.

### Environment requirements

- Node.js `>= 22.0.0`
- ESM-only (`"type": "module"`); always import with `import { ... } from 'blendsdk/postgresql'`

### Downstream consumers

- Applications built on the BlendSDK use this package as their PostgreSQL persistence layer; it ships as part of the `blendsdk` umbrella distribution.
- Within the monorepo it sits directly on top of `blendsdk/dbcore`. Compiled expressions from `blendsdk/expression` can be attached to statements (`filterByExpression()`, `byExpression()`) — that package is a companion, not a runtime dependency of this one.
- ⚠️ When the database instance is owned by a `blendsdk/webafx` WebApplication (which registers its own `SIGINT` / `SIGTERM` handling), leave `enableGracefulShutdown` at its default (`false`) to avoid conflicting signal handlers.

### Development tooling

- Tests run with Vitest; full integration tests use a Dockerized PostgreSQL instance (managed via the `db:up` / `db:down` scripts), while `test:fast` runs SQL-generation unit tests without a database.

---

## Minimum Example

The following program connects to PostgreSQL, runs one named-parameter query, prints the typed result, and disconnects cleanly:

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
    const { records, rowCount } = await db.executeQuery<{ id: number; name: string }>(
      'SELECT id, name FROM users WHERE active = :active',
      { active: true }
    );
    console.log(`Fetched ${rowCount} row(s):`, records);
  } finally {
    await db.disconnect();
  }
}

void main();
```

The same `db` instance is the entry point for everything else: `withTransaction()` for transactional work, and `insert()` / `update()` / `delete()` for builder-based statements.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
