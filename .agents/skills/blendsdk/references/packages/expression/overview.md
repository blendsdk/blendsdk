> **Package**: `blendsdk/expression`

# expression Overview

---

## What It Is

`blendsdk/expression` is a modern, type-safe SQL WHERE clause builder with a fluent API. It lets you describe filtering conditions against a typed schema (`query<User>().where('status').equals('active')`), assembles them into an immutable abstract syntax tree (AST), and compiles that tree into a fully parameterized, dialect-specific SQL predicate. The result of `.compile()` is a `CompileResult` — the SQL fragment (no `WHERE` keyword) plus a parameter map keyed by generated placeholder names (`p1`, `p2`, …) formatted per dialect (`:p1` for PostgreSQL) — so user values are never concatenated into the SQL string. PostgreSQL is supported end-to-end, including JSONB operators and full-text search; MySQL, MSSQL, and SQLite are declared in the `SqlDialect` enum but not yet implemented.

---

## Key Features

- **Type-safe schema binding** — `query<User>()` constrains every column reference to `keyof User` and every value argument to the matching schema type, verified at compile time.
- **Two-stage fluent API** — `where`/`and`/`or` alternate between `QueryBuilder` and `ComparisonBuilder` stages, making invalid chains unrepresentable; callback overloads add nested groups.
- **Complete comparison set** — `equals`, `notEquals`, `greaterThan(OrEqual)`, `lessThan(OrEqual)`, `between`, `notBetween`, `in`, `notIn`, `isNull`, `isNotNull`, plus `like`, `ilike` and the sugar helpers `startsWith`, `endsWith`, `contains`.
- **PostgreSQL JSON/JSONB operators** — `jsonContains` (`@>`), `jsonContainedBy` (`<@`), `jsonHasKey` (`?`), `jsonHasAnyKey` (`?|`), `jsonHasAllKeys` (`?&`), `jsonPathExists` (`@?`).
- **Full-text search** — `search()` generates `to_tsvector`/`to_tsquery` expressions in `plain`, `phrase`, or `websearch` mode, for one or many columns, with a configurable language.
- **Subqueries** — `exists`, `notExists`, `inSubquery`, `notInSubquery`, and `equalsColumn` for correlated column references.
- **Automatic parameterization** — literals become sequentially named parameters (`p1`, `p2`, …); `undefined` normalizes to `null`, `Date` values serialize to ISO strings, and PostgreSQL placeholders render as `:p1`, `:p2`, …
- **Immutable AST with lazy compilation** — nodes are frozen value objects; SQL is generated only when `.compile()` is called, returning `{ sql, params, debug? }`.
- **Debug mode** — `query({ debug: true })` or `.debug()` attaches `DebugInfo` (AST, parameter count, compilation time, optimizations, warnings) to the result.
- **Zero runtime dependencies** — implemented with the standard library and Node.js built-ins only.

---

## When To Use

Use `blendsdk/expression` when:

- You build **dynamic SQL predicates** at runtime — search filters, admin grids, report criteria — where the condition set varies per request.
- **SQL-injection safety is a requirement**: values are bound as named parameters, never concatenated into SQL.
- You want **compile-time guarantees** that column names and value types match your domain schema (`query<User>()`).
- You query **PostgreSQL JSONB data** or need **full-text search** without hand-writing `to_tsvector`/`to_tsquery` SQL.
- You compose **correlated subqueries** (`EXISTS`/`IN`) with the same fluent, typed API.
- You integrate with **`blendsdk/dbcore`** and need a composable, parameterized WHERE fragment for its query pipeline.

Look elsewhere when:

- You need a **full query builder** (SELECT list, FROM, JOIN, ORDER BY, LIMIT) — this package emits the predicate only, and the SQL excludes the `WHERE` keyword.
- You target **MySQL, MSSQL, or SQLite today** — those dialects throw `not yet implemented` at compile time.
- Your queries are **static** — plain SQL is simpler than programmatic composition.

---

## Architecture

Internally the package is a one-way pipeline: the fluent builders validate input and record conditions as immutable AST nodes; a dialect-specific compiler renders that tree to SQL while a `ParameterManager` supplies placeholder names. Builders never emit SQL; compilers never mutate the tree.

The fluent chain deliberately alternates between two interfaces:

```typescript fragment
query<User>()         // → QueryBuilder<User>
  .where('status')    // → ComparisonBuilder<User, 'status'>
  .equals('active')   // → QueryBuilder<User>          (AST: one comparison)
  .and('age')         // → ComparisonBuilder<User, 'age'>
  .greaterThan(18);   // → QueryBuilder<User>          (AST: AND of two comparisons)
```

```text
query(options?) ──► QueryBuilderImpl ──(where/and/or with column)──► ComparisonBuilderImpl
                          ▲                                                  │
                          └───────────── returns to builder ◄────────────────┘
                          │
                          │ where/and/or callbacks ──► nested QueryBuilderImpl
                          │        (shares ParameterManager; wraps result in a GroupNode)
                          │
                          │ records immutable AST nodes
                          ▼
        AST ── ComparisonNode · LogicalNode · GroupNode · JsonNode
               FullTextNode · SubqueryNode            (all Object.freeze)
                          │
                          │ .compile() ──► dialect switch (SqlDialect)
                          ▼
        PostgreSQLCompiler ◄──── ParameterManager (p1, p2, … → ':p1', ':p2', …)
                          │
                          ▼
        CompileResult { sql, params, debug? }
```

### Design Patterns

- **Builder + Fluent Interface** — `query()` is the factory; column calls produce a short-lived `ComparisonBuilder`, and each terminal comparison returns a `QueryBuilder` again. `QueryBuilderImpl` is the concrete class (exported for advanced use).
- **Factory functions** — internal helpers (`createComparisonNode`, `createLogicalNode`, `createGroupNode`, `createJsonNode`, `createFullTextNode`, `createSubqueryNode`) create every node type as a frozen object with a unique generated id. They are not part of the public API.
- **Composite** — the AST is a true tree: `LogicalNode.{left,right}`, `GroupNode.child`, and `SubqueryNode.subquery` hold arbitrary subtrees, so boolean logic of any nesting depth is representable.
- **Strategy (dialect)** — `QueryBuilderImpl.compile()` selects a compiler based on `SqlDialect`. `PostgreSQLCompiler` is the only implemented strategy; the other enum members throw `not yet implemented`.
- **Immutable value objects** — every AST node is `Object.freeze`d; builders extend the tree with new nodes instead of mutating existing ones.
- **Shared parameter registry** — one `ParameterManager` per query; nested builders created by `where`/`and`/`or` callbacks share the parent's manager, keeping placeholder numbering sequential (`:p1`, `:p2`, …) across grouped conditions.

### Public Surface at a Glance

| Export | Kind | Role |
|---|---|---|
| `query()` | Function | Factory creating a `QueryBuilder` |
| `QueryBuilderImpl` | Class | Concrete builder implementation |
| `QueryBuilder`, `ComparisonBuilder`, `SubqueryBuilder` | Interfaces | Fluent API contracts (query stage, comparison stage, subquery extensions) |
| `PostgreSQLCompiler` | Class | Compiles the AST to a PostgreSQL predicate |
| `ParameterManager` | Class | Placeholder naming/formatting and value serialization |
| `SqlDialect`, `ComparisonOperator`, `LogicalOperator`, `JsonOperator`, `FullTextMode`, `ASTNodeType` | Enums | Dialect, operator, and mode constants |
| `CompileResult`, `QueryOptions`, `SearchOptions`, `DebugInfo`, `ASTNode`, `ComparisonNode`, `LogicalNode`, `GroupNode`, `JsonNode`, `FullTextNode`, `SubqueryNode` | Types | Data contracts for options, results, and AST nodes |

---

## Dependencies

### Runtime Dependencies

**None.** The package has zero runtime dependencies and uses only Node.js built-ins (internally, `node:perf_hooks` for compilation timing).

### Peer Dependencies

**None.**

### Environment Requirements

| Requirement | Detail |
|---|---|
| Node.js | `>= 22.0.0` |
| Module system | ESM only — the package exposes a single `import` entry point; CommonJS `require()` is not supported |
| TypeScript | `strict` mode recommended; the package ships `.d.ts` declarations with full generic types |

### Development Dependencies

| Package | Purpose |
|---|---|
| `typescript` | Build (`tsc` outputs `dist/`) |
| `vitest` | Test runner (unit tests, watch mode, coverage) |
| `@vitest/coverage-v8` | Coverage provider |
| `@types/node` | Node.js type definitions |

### Relationships

- **Depends on**: nothing inside or outside the monorepo — the AST, parameter manager, and PostgreSQL compiler are all self-contained.
- **Designed for integration with**: `blendsdk/dbcore` and related BlendSDK database packages, which consume the compiled `CompileResult` (predicate + params) within their statement pipelines. Sibling packages such as `blendsdk/postgresql` and `blendsdk/codegen` complement it in the BlendSDK stack.
- **Distribution**: marked `"private": true` in the monorepo; distributed as part of the BlendSDK package family rather than as a standalone npm artifact.

---

## Minimum Example

```typescript
import { query, SqlDialect } from 'blendsdk/expression';

interface User {
  id: number;
  email: string;
  status: string;
  age: number;
}

const { sql, params } = query<User>({ dialect: SqlDialect.PostgreSQL })
  .where('status').equals('active')
  .and('age').greaterThan(18)
  .and('email').endsWith('@example.com')
  .compile();

console.log(sql);
// status = :p1 AND age > :p2 AND email LIKE :p3

console.log(params);
// { p1: 'active', p2: 18, p3: '%@example.com' }
```

The `sql` fragment excludes the `WHERE` keyword — append it to your own statement and bind `params` with your database driver.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
