> **Package**: `blendsdk/dbcore`

# dbcore Overview

---

## What It Is

`blendsdk/dbcore` is the database core of BlendSDK: a database-agnostic library that defines the abstractions and statement builders for working with relational databases. It provides an abstract `Database` class (connection lifecycle, parameterized query execution, transactions, and factory methods for statement builders), a fluent statement-builder hierarchy for SELECT, INSERT, UPDATE, and DELETE operations with `RETURNING` clause support and expression-based filtering, and a thin data-service layer for encapsulating read queries per relation. The package intentionally contains no driver code — concrete adapters (PostgreSQL, MySQL, etc.) extend its abstract classes to supply database-specific SQL generation and execution.

---

## Key Features

- **Abstract adapter contract** — `Database` defines `connect()`, `disconnect(timeoutMs?)`, parameterized `executeQuery<R>()`, transactional `withTransaction<T>()`, and statement factory methods.
- **Fluent statement builders** — chainable builders for SELECT (`from()`, `selectAll()`), INSERT, UPDATE, and DELETE. `FromStatement` is concrete and builds SELECT SQL directly; the CRUD statements are abstract and implemented per adapter.
- **Expression-based filtering** — `filter()` for simple key/value criteria and `filterByExpression()` / `byExpression()` for complex WHERE clauses compiled by `blendsdk/expression`, with cached compilation to avoid double work.
- **RETURNING clause support** — `returning('*')` or `returning((keyof TableType)[])` on every CRUD statement via the shared `CrudStatement` base.
- **Typed results and execution helpers** — `QueryResult<T>` (`records`, `rowCount`) plus `execute()`, `executeReturnSingle()`, `executeReturnAll()`, and `executeReturnCount()`.
- **Query lifecycle hooks** — `beforeQuery()` transforms parameters before execution; `afterQuery()` transforms result rows after execution.
- **Data services** — `DataServiceBase`, `QueryDataService` (`findById`, `findByExpression`, `findAllByExpression`, `findAll`), and the `createQueryService()` factory for binding a service class to a relation and primary-key column.

---

## When To Use

Use this package when you are:

- Building a data-access layer and want typed, composable query construction instead of string-concatenated SQL.
- Writing a database adapter — extend `Database` and implement `InsertStatement`, `UpdateStatement`, and `DeleteStatement` for your backend's SQL dialect and parameter syntax.
- Creating repository-style read services per relation with minimal boilerplate via `createQueryService()`.
- Composing dynamic, parameterized WHERE clauses at runtime with the `blendsdk/expression` DSL.

Look elsewhere when you are:

- Expecting a working database connection — this package ships no driver; a concrete `Database` adapter is required at runtime.
- Needing the expression DSL itself — import `query`, `QueryBuilder`, and `CompileResult` directly from `blendsdk/expression`.
- Looking for a full ORM (entity mapping, relationship loading) — dbcore covers query construction and execution only.

---

## Architecture

The package is organized in layers, built around two abstract contracts — `Database` for execution and `Statement` for query construction — that concrete adapters fulfill.

```text
┌──────────────────────────────────────────────────────────────────────┐
│  Data services                                                       │
│    QueryDataService · DataServiceBase · createQueryService()         │
├──────────────────────────────────────────────────────────────────────┤
│  Statement builders (fluent, chainable)                              │
│    FromStatement (SELECT)                                            │
│    InsertStatement · UpdateStatement · DeleteStatement               │
├──────────────────────────────────────────────────────────────────────┤
│  Foundations                                                         │
│    Statement → CrudStatement → FilterableStatement                   │
│    Database (abstract adapter contract)                              │
├──────────────────────────────────────────────────────────────────────┤
│  blendsdk/expression — query() · QueryBuilder · CompileResult       │
└──────────────────────────────────────────────────────────────────────┘
```

### Statement Type Hierarchy

- `Statement<TableType>` — base builder with execution helpers and query hooks; subclasses implement `buildQuery()` and `buildParameters()`.
- `CrudStatement<TableType>` — extends `Statement`, adds `_values` and `returning()`.
- `FilterableStatement<TableType, FilterType>` — extends `CrudStatement`, adds `filter()`, `filterByExpression()`, and cached expression compilation.
- `InsertStatement<T>` extends `CrudStatement<T>`; `UpdateStatement<T, F>` and `DeleteStatement<F>` extend `FilterableStatement<T, F>`.
- `FromStatement<T>` extends `Statement<T>` directly and is concrete (builds `SELECT ... FROM ...` SQL itself).
- `QueryDataService<T>` extends `DataServiceBase`; `createQueryService()` returns a concrete subclass bound to a relation.

### Design Patterns

- **Builder** — statement classes expose fluent methods (`values()`, `select()`, `filter()`, `returning()`) that mutate builder state and return `this` for chaining.
- **Template Method** — `Statement.execute()` drives query execution; concrete subclasses supply `buildQuery()` and `buildParameters()`.
- **Factory Method** — `Database.from()`, `selectAll()`, `insert()`, `update()`, and `delete()` create the appropriate statement builder; `createQueryService()` produces a ready-to-instantiate `QueryDataService` class.
- **Strategy** — user-supplied expression builders and `beforeQuery` / `afterQuery` handlers customize behavior at runtime, carried through `ExecuteQueryOptions`.
- **Memoization** — `FilterableStatement` compiles the expression builder once and reuses the cached `CompileResult`.

---

## Dependencies

| Dependency | Version | Type | Purpose |
| --- | --- | --- | --- |
| `blendsdk/expression` | `^5.x` | Runtime | Expression DSL — `query()`, `QueryBuilder`, and `CompileResult` used to compile WHERE clauses |

- **Adapter requirement** — no `peerDependencies` are declared, but a concrete `Database` implementation (PostgreSQL, MySQL, etc.) is required to execute queries; this package contains no driver.
- **Import boundary** — expression types and functions (`query`, `QueryBuilder`, `CompileResult`) must be imported from `blendsdk/expression` directly; they are not re-exported by this package.
- **Reverse dependencies** — database adapter packages extend `Database` and the abstract CRUD statements; application-level data services extend `DataServiceBase` / `QueryDataService` or use `createQueryService()`.
- **Environment** — Node.js >= 22.0.0, ESM-only (`"type": "module"`, exports map exposes only `import`). TypeScript and Vitest are dev-only tooling.

---

## Minimum Example

This example runs a fluent SELECT against a `Database` adapter: it compiles a type-safe filter with `blendsdk/expression`, applies it with `byExpression()`, and returns a single typed record with `executeReturnSingle()`.

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  email: string;
}

export async function findUserById(db: Database, id: number): Promise<Partial<User> | null> {
  const filter = query<User>().where('id').equals(id).compile();
  const user = await db
    .from<User>('users')
    .select(['id', 'name', 'email'])
    .byExpression(filter)
    .executeReturnSingle();
  return user;
}
```

The `db` parameter is an instance of a concrete `Database` adapter that implements `connect()`, `executeQuery()`, `withTransaction()`, and the abstract statement factories; everything else in the example is provided by `blendsdk/dbcore`.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
