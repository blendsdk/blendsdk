> **Package**: `blendsdk/postgresql`

# postgresql Overview

---

## What It Is

`blendsdk/postgresql` is the PostgreSQL adapter for the BlendSDK data stack. It implements the abstract database contract defined by `blendsdk/dbcore` on top of the `pg` driver and the `yesql` named-parameter compiler, giving Node.js applications connection pooling, safe parameterized query execution, transaction management, and fluent, type-safe statement builders for INSERT, UPDATE, and DELETE — with read/SELECT construction supplied by the shared dbcore builders that the database class inherits. The package is ESM-only, written in strict TypeScript, requires Node.js 22 or later, and keeps SQL explicit: it is a typed query and connection layer, not a full ORM.

---

## Key Features

- **Connection pooling** — every `PostgreSQLDatabase` instance owns a `pg.Pool`; pool behavior is tunable through the optional `poolConfig` (`max`, `idleTimeoutMillis`, `connectionTimeoutMillis`).
- **Named-parameter queries** — SQL uses `:name` placeholders that `yesql` compiles into positional parameters, so values are never string-interpolated into the query text (SQL-injection safe).
- **Transactions** — `db.withTransaction(fn)` wraps `fn` in `BEGIN`/`COMMIT`, issues a `ROLLBACK` automatically when `fn` throws, and always releases the client back to the pool.
- **Typed statement builders** — `db.insert<T>()`, `db.update<T, F>()`, and `db.delete<F>()` return chainable builders with `.values()`, `.filter()`, `.filterByExpression()`, `.returning()`, and terminators `.execute()`, `.executeReturnSingle()`, `.executeReturnAll()`, `.executeReturnCount()`.
- **RETURNING support** — writer builders retrieve affected rows with `returning('*')` or an explicit column list.
- **Query hooks** — `.beforeQuery()` and `.afterQuery()` on builders (and `beforeQuery`/`afterQuery` options on `executeQuery`) transform parameters before execution and records after execution — normalization, hashing, sensitive-field masking.
- **Read queries** — SELECT construction via the inherited `db.from()` and `db.selectAll()` factories: column lists, aliases, computed expressions, and expression-based WHERE clauses.
- **Validated builders** — INSERT and UPDATE builders throw descriptive errors when `.values()` was never provided, instead of emitting invalid SQL.
- **Graceful lifecycle** — `disconnect(timeoutMs = 10000)` shuts the pool down with a forced-release fallback; opt-in SIGINT/SIGTERM handling via `enableGracefulShutdown` (standalone processes only — never alongside `blendsdk/webafx` shutdown handling).
- **Typed results** — `executeQuery<R>()` resolves to `PostgreSQLQueryResult<R>` with `records`, `rowCount`, and column `fields` metadata.

---

## When To Use

Use `blendsdk/postgresql` when:

- You are building **server-side Node.js applications** (HTTP APIs, workers, CLI services) that talk to PostgreSQL and want explicit, type-safe SQL rather than a heavyweight ORM.
- You need **transactional units of work** with automatic commit/rollback and guaranteed connection release.
- You want **structured writes** — INSERT/UPDATE/DELETE through fluent builders with filters, `RETURNING`, and hooks — while keeping raw `executeQuery` for everything else.
- You need **data-layer cross-cutting concerns**: transforming inputs before they reach the database and shaping or masking outputs before they reach application code.
- You are building **within the BlendSDK ecosystem** — this package is the PostgreSQL implementation of the `blendsdk/dbcore` contract and composes with the shared types and expression-based filters used across the stack.
- You are building an application where a framework (for example a `WebApplication` from `blendsdk/webafx`) manages process lifecycle — in that setup, let the framework own shutdown and leave `enableGracefulShutdown` disabled.

Keep in mind:

- This is **not a full ORM** — there is no entity mapping, relation loading, or migration tooling; SQL and schema lifecycle stay explicit.
- It is **PostgreSQL-specific** — other database engines require a different implementation of the dbcore contract.

---

## Architecture

`blendsdk/postgresql` is a thin dialect adapter: statement chaining, hooks, expression compilation, and execution flow live in the base classes of `blendsdk/dbcore`, while this package supplies the PostgreSQL-specific SQL generation and the concrete connection layer over `pg` and `yesql`.

```text
Application code
      │
      ▼
PostgreSQLDatabase ─── extends ───▶ Database (abstract, blendsdk/dbcore)
      │                               • statement execution flow & hooks
      │                               • expression compilation & caching
      ├─ factories: insert() · update() · delete() · from() · selectAll()
      ▼
PostgreSQL statement builders  (override buildQuery() / buildParameters())
      │
      ▼
yesql (:name → positional)  ──▶  pg.Pool / PoolClient  ──▶  PostgreSQL server
```

### Design Patterns

- **Adapter** — `PostgreSQLDatabase` adapts the `pg` connection pool and the `yesql` compiler to the abstract `Database` contract from `blendsdk/dbcore`.
- **Template Method** — `PostgreSQLInsertStatement`, `PostgreSQLUpdateStatement`, and `PostgreSQLDeleteStatement` extend the dbcore base builders and override only the protected `buildQuery()` / `buildParameters()` steps; chaining, hooks, expression caching, and the `execute*` terminators are inherited.
- **Builder** — statements are configured fluently (`.values()`, `.filter()`, `.returning()`, `.beforeQuery()`, `.afterQuery()`) and finalized with an execution method.
- **Factory Method** — `db.insert()`, `db.update()`, and `db.delete()` instantiate the matching PostgreSQL builder; `db.from()` and `db.selectAll()` come from the base class for reads.
- **Strategy** — WHERE conditions are compiled by the BlendSDK expression engine into SQL fragments plus parameter maps, cached per statement so query text and parameters share a single compilation. UPDATE values and filter parameters occupy separate namespaces (`v_`-prefixed values vs. `p1`…`pN` filters), so they can never collide.

### Layered Responsibilities

| Layer | Provided by | Responsibility |
|---|---|---|
| Contract & execution flow | `blendsdk/dbcore` | Abstract `Database`, base statement builders, hooks, `execute*` terminators, expression caching |
| PostgreSQL implementation | `blendsdk/postgresql` | Pool and transaction management, SQL/parameter generation for INSERT/UPDATE/DELETE |
| Named-parameter compilation | `yesql` | `:name` placeholders → safe positional parameters |
| Driver & pooling | `pg` | Connections, wire protocol, `FieldDef` column metadata |

### Primary Entry Points

| Entry point | Returns | Purpose |
|---|---|---|
| `new PostgreSQLDatabase(config)` | `PostgreSQLDatabase` | Creates the adapter and its connection pool |
| `db.executeQuery<R>(sql, params?, options?)` | `Promise<PostgreSQLQueryResult<R>>` | Executes parameterized SQL |
| `db.withTransaction<T>(fn)` | `Promise<T>` | Runs `fn` inside a transaction |
| `db.insert<T>(table)` | `InsertStatement<T>` | INSERT builder |
| `db.update<T, F>(table)` | `UpdateStatement<T, F>` | UPDATE builder |
| `db.delete<F>(table)` | `DeleteStatement<F>` | DELETE builder |
| `db.from<T>(table)` | `FromStatement` | SELECT builder (inherited from dbcore) |
| `db.selectAll(table)` | `FromStatement` | `SELECT *` builder (inherited from dbcore) |
| `db.disconnect(timeoutMs?)` | `Promise<void>` | Closes the pool gracefully |

Builder factories are declared against the `blendsdk/dbcore` base types; the concrete instances are the PostgreSQL-specific statement classes. Public exports from the package root are the classes `PostgreSQLDatabase`, `PostgreSQLInsertStatement`, `PostgreSQLUpdateStatement`, `PostgreSQLDeleteStatement` and the interfaces `PostgreSQLConfig`, `PoolConfig`, `PostgreSQLQueryResult`. Shared contract types (`Database`, `InsertStatement`, `ExecuteQueryOptions`, `FromStatement`, …) originate in `blendsdk/dbcore`.

---

## Dependencies

### Runtime Dependencies

| Dependency | Version | Role |
|---|---|---|
| `blendsdk/dbcore` | internal (workspace) | Abstract `Database` contract, base statement builders, execution flow, hooks |
| `pg` | `^8.22.0` | PostgreSQL driver — connection pooling, query execution, field metadata |
| `yesql` | `^7.0.0` | Named-parameter SQL compilation (`:name` → positional parameters) |

**Peer dependencies**: none — `blendsdk/dbcore`, `pg`, and `yesql` are regular runtime dependencies that install with the package.

### Development-Only Dependencies

- `blendsdk/expression` — constructs WHERE expressions in tests (`query().where(...).compile()`).
- `vitest`, `typescript`, `@types/node`, `@types/pg`, `@types/yesql`.

### Environment Requirements

- Node.js >= 22.0.0.
- ESM-only: the package exposes a single `import` entry (with a `types` condition) — there is no CommonJS `require()` entry point.

### Depended On By

- BlendSDK applications and services that target PostgreSQL use this package as their concrete database layer.
- Web frameworks in the stack interoperate with it: a `WebApplication` from `blendsdk/webafx` can manage the database lifecycle and process shutdown, in which case `enableGracefulShutdown` must remain disabled to avoid competing signal handlers.
- The package is internal to the BlendSDK monorepo (`packages/postgresql`); npm consumers receive it through the `blendsdk` umbrella distribution (MIT license, TrueSoftware B.V.).

---

## Minimum Example

The following is a complete program: it creates the adapter, runs one named-parameter query, prints the result, and closes the pool.

```typescript
import { PostgreSQLDatabase, PostgreSQLConfig } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const { records, rowCount } = await db.executeQuery<{ greeting: string }>(
    'SELECT :name AS greeting',
    { name: 'world' }
  );
  console.log(records[0].greeting, rowCount);
} finally {
  await db.disconnect();
}
```

`:name` is compiled by `yesql` into a safe positional parameter (never interpolated into the SQL text), and the `executeQuery` generic types the returned `records`. Transactions, statement builders, and hooks are covered in the dedicated documents that follow.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
