> **Package**: `blendsdk/postgresql`

# postgresql Overview

---

## What It Is

`blendsdk/postgresql` is the PostgreSQL adapter for BlendSDK's database layer. It exports `PostgreSQLDatabase`, a concrete implementation of the engine-neutral `Database` abstraction from `blendsdk/dbcore` that speaks PostgreSQL through the `pg` (node-postgres) driver: it owns a connection pool, executes named-parameter SQL, runs transaction-isolated work, and manufactures PostgreSQL-specific INSERT, UPDATE and DELETE statement builders. Everything that is not PostgreSQL syntax — expression-based filtering, the statement lifecycle, the `execute*` terminators, query hooks, and typed query results — is inherited from `blendsdk/dbcore`, so application code written against the base contracts stays portable across database adapters and only the import and configuration change. The package is distributed as part of the `blendsdk` umbrella package.

---

## Key Features

- **Pooled connections** — a `pg.Pool` is created in the constructor from `PostgreSQLConfig`; `poolConfig.max`, `idleTimeoutMillis` and `connectionTimeoutMillis` tune it, and `connect()` exposes a raw pooled client when you need driver-level access.
- **Named parameters, never string interpolation** — `executeQuery('SELECT :name AS name', { name })` uses `yesql` to rewrite `:name` into the driver's positional `$1…$n` form, so values are always bound, never concatenated into SQL text.
- **Async-local transaction isolation** — `withTransaction(fn, options?)` wraps BEGIN/COMMIT/ROLLBACK, carries the owning client in an `AsyncLocalStorage` context, rejects nested transactions on the same call chain, and releases each client exactly once. Concurrent requests can safely share one `PostgreSQLDatabase` instance.
- **Validated isolation levels** — `TransactionOptions.isolation` accepts `'read committed'`, `'repeatable read'` or `'serializable'` only; the value is checked against an allowlist before it is rendered into `BEGIN ISOLATION LEVEL …`, so the option can never carry injected SQL.
- **Fluent statement builders** — `db.insert()`, `db.update()` and `db.delete()` return `PostgreSQLInsertStatement`, `PostgreSQLUpdateStatement` and `PostgreSQLDeleteStatement` with `values()`, `filter()`, `filterByExpression()`, `returning()` and the `execute` / `executeReturnSingle` / `executeReturnAll` / `executeReturnCount` terminators.
- **Full `RETURNING` support** — `returning('*')` or an explicit column list, combined with the terminators to get the affected rows back in one round trip.
- **Query hooks** — `beforeQuery` transforms bound parameters before they reach the driver (handy for hashing secrets or normalizing input), `afterQuery` transforms rows on the way out (PII stripping, value coercion).
- **Typed results** — `PostgreSQLQueryResult<T>` carries `records: T[]`, `rowCount` and the driver's raw `fields: FieldDef[]` column metadata.
- **Guarded shutdown** — `disconnect(timeoutMs = 10000)` closes the pool with a forced-release fallback; once shutdown starts, new queries and transactions are rejected with clear errors. `enableGracefulShutdown` optionally wires SIGINT/SIGTERM handlers.
- **Inherited query surface** — FROM/SELECT construction (`db.from()`, `db.selectAll()`) and the expression compiler come from the `Database` base class, so this package focuses purely on the PostgreSQL dialect.

Statement builders in use:

```typescript fragment
db.insert<User>('users').values({ name: 'Ada', email: 'ada@example.com' }).returning('*');
db.update<User, UserFilter>('users').values({ active: false }).filter({ id: 1 }).returning('*');
db.delete<UserFilter>('users').filter({ active: false }).returning('*');
```

---

## When To Use

- A Node.js service needs **direct, typed PostgreSQL access** with pooled connections and no ORM in between.
- You want **parameterized INSERT/UPDATE/DELETE with RETURNING** expressed as a fluent builder instead of hand-assembled SQL strings.
- Multiple concurrent requests share **one database instance** and each request needs its own transaction with a guaranteed commit-or-rollback and no connection leaks.
- You are building on the **`blendsdk/dbcore` abstractions** and need the PostgreSQL dialect behind them — for example alongside `blendsdk/expression` for compiled WHERE clauses.
- Cross-cutting row/parameter policy (password hashing, email normalization, sensitive-field removal) should live in **query hooks** next to the statement, not scattered across handlers.
- You run a long-lived process and need **predictable shutdown** for the connection pool.

Look elsewhere when the requirement is schema migration, model definition or relationship management — this package executes SQL, it does not manage schemas — or when the target engine is not PostgreSQL (use the corresponding BlendSDK adapter).

---

## Architecture

```
Application code
    │  executeQuery() · withTransaction() · insert() / update() / delete()
    ▼
PostgreSQLDatabase  (extends Database from blendsdk/dbcore)
    ├─ pg.Pool  ──────────────────────────────►  PostgreSQL server
    ├─ AsyncLocalStorage<TransactionContext>     one client per transaction call chain
    ├─ executeOnClient(): beforeQuery → yesql → pg.query() → afterQuery → normalize
    └─ factories: insert() / update() / delete()
                          │
                          ▼
       PostgreSQL{Insert,Update,Delete}Statement
           buildQuery() + buildParameters()   ── supplied by the subclass
                          │
                          ▼
           execute / executeReturnSingle / executeReturnAll / executeReturnCount
                          │
                          ▼
                    PostgreSQLDatabase.executeQuery()
```

`PostgreSQLDatabase` is the only stateful component. The constructor stores the config and creates the pool; connections are acquired lazily. All SQL passes through one choke point — the protected `executeOnClient()` — which applies hooks, converts named placeholders to positional ones, executes through `pg`, and normalizes the driver result into `PostgreSQLQueryResult<T>`.

Two ownership rules keep concurrency correct:

1. **Outside a transaction**, each `executeQuery()` acquires its own client and releases it in a `finally` block — two concurrent queries can never share or release each other's connection.
2. **Inside `withTransaction()`**, the owning client lives in an `AsyncLocalStorage` context, so every statement issued by the callback runs on it. When the callback settles, the context is closed; a detached task that outlives the callback is rejected rather than borrowing a client that has already gone back to the pool.

Statement builders never touch a connection. They are pure SQL-and-parameter producers whose terminal methods delegate back to the `Database` instance passed to their constructor. The compiled WHERE expression is cached (`getCompiledExpression()`), so repeated `buildQuery()` / `buildParameters()` calls do not recompile.

| Pattern | Where it appears |
| --- | --- |
| Adapter | `PostgreSQLDatabase` adapts the engine-neutral `Database` and statement contracts to PostgreSQL syntax and the `pg` driver. |
| Factory Method | `insert()`, `update()`, `delete()` create dialect-specific builder instances. |
| Builder | Fluent statements: `values()`, `filter()`, `filterByExpression()`, `returning()`, finished by an `execute*` terminator. |
| Template Method | Base statement classes own the execution pipeline; subclasses implement `buildQuery()` and `buildParameters()`. |
| Strategy | `beforeQuery` / `afterQuery` hooks inject per-query parameter and row transformations. |
| Context Object | `TransactionContext` in `AsyncLocalStorage` scopes a transaction client to one async call chain. |

---

## Dependencies

| Direction | Package | Role |
| --- | --- | --- |
| Runtime dependency | `blendsdk/dbcore` | `Database` base class, `InsertStatement`/`UpdateStatement`/`DeleteStatement` base builders, expression compilation, `execute*` terminators, hook and config types. |
| Runtime dependency | `pg` (^8) | Connection pool, wire protocol, `PoolClient`, `FieldDef` column metadata. |
| Runtime dependency | `yesql` (^7) | Rewrites `:named` placeholders into the driver's positional parameters. |
| Depended on by | `blendsdk/webafx` | Manages `PostgreSQLDatabase` instances in web applications and owns the SIGINT/SIGTERM lifecycle (never combine it with `enableGracefulShutdown`). |
| Depended on by | `blendsdk` | The published umbrella package through which this adapter is installed and imported. |

There are **no peer dependencies**. Development-only packages include `blendsdk/expression` (builds compiled expressions in the test suite), `vitest` with `@vitest/coverage-v8`, `typescript`, and the `@types/*` packages for `node`, `pg` and `yesql`.

Install the umbrella — the PostgreSQL adapter, `pg` and `yesql` arrive with it:

```bash
npm install blendsdk
```

---

## Minimum Example

Opens a pool, runs one transactional query with a named parameter, and always closes the pool. It requires a reachable PostgreSQL server and assumes `appdb` exists (the snippet runs with top-level `await`, which ESM supports).

```typescript
import { PostgreSQLDatabase, PostgreSQLConfig } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  await db.withTransaction(async (tx) => {
    const { records } = await tx.executeQuery<{ greeting: string }>(
      'SELECT :name AS greeting',
      { name: 'BlendSDK' }
    );
    console.log(records[0]?.greeting);
  });
} finally {
  await db.disconnect();
}
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
