> **Package**: `blendsdk/expression`

# expression Best Practices

---

`blendsdk/expression` makes the dangerous part of dynamic SQL hard to get wrong: every value you pass becomes a bind parameter, and the fluent chain constrains what you can build next. The remaining hazards are the parts SQL cannot parameterize (identifiers, the full-text language), the parts with surprising semantics (`NULL` comparison, `LIKE` wildcards, boolean precedence), and state that outlives a single statement (builders and parameter managers). This document pairs each common failure mode with the recommended pattern.

---

## Do / Don't Pairs

### 1. Bind the schema type to the query

**❌ Wrong**

```typescript
import { query } from 'blendsdk/expression';

// Untyped query — the typo compiles and only fails when the database runs it
const { sql, params } = query()
  .where('statuz')
  .equals('active')
  .compile();

console.log(sql);    // 'statuz = :p1'
console.log(params); // { p1: 'active' }
```

**✅ Correct**

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  status: string;
  age: number;
}

const { sql, params } = query<User>()
  .where('status')
  .equals('active')
  .compile();

console.log(sql);    // 'status = :p1'
console.log(params); // { p1: 'active' }
```

**Why it matters** — With the default untyped schema, any string is accepted as a column name and any value is accepted for it; a typo (`statuz`) or a type mismatch (`equals(42)` on a string column) surfaces only when the database rejects the statement. `query<User>()` moves both checks to TypeScript compile time: `where` is limited to `keyof User`, and each comparison accepts only the column's declared type. Define the schema type once — your domain model or generated types — and reuse it for every filter over the same table.

---

### 2. Use `isNull()` / `isNotNull()` — not `equals(null)` or `equals(undefined)`

**❌ Wrong**

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  deleted_at: string | null;
}

// Emits deleted_at = :p1 with p1 = null — matches nothing
const { sql, params } = query<User>()
  .where('deleted_at')
  .equals(null)
  .compile();

console.log(sql);    // deleted_at = :p1
console.log(params); // { p1: null }
```

**✅ Correct**

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  deleted_at: string | null;
}

const { sql, params } = query<User>()
  .where('deleted_at')
  .isNull()
  .compile();

console.log(sql);    // deleted_at IS NULL
console.log(params); // {}
```

**Why it matters** — In SQL, `NULL` is not equal to anything: `deleted_at = :p1` with `p1 = null` evaluates to UNKNOWN for every row, so the filter silently returns nothing. `equals(undefined)` — where the schema (or an untyped builder) allows it — is the same trap: the parameter manager normalizes `undefined` to `null`, producing an identical never-matching predicate. `isNull()` / `isNotNull()` emit proper `IS NULL` / `IS NOT NULL` checks and register no parameters at all.

---

### 3. Call `where()` once — compose everything else with `and()` / `or()`

**❌ Wrong**

```typescript
import { query } from 'blendsdk/expression';

// The second where() replaces the AST root — status is silently dropped
const { sql, params } = query()
  .where('status').equals('active')
  .where('age').greaterThan(18)
  .compile();

console.log(sql);    // age > :p2            (the status condition is gone)
console.log(params); // { p1: 'active', p2: 18 }  (p1 is now orphaned)
```

**✅ Correct**

```typescript
import { query } from 'blendsdk/expression';

const { sql, params } = query()
  .where('status').equals('active')
  .and('age').greaterThan(18)
  .compile();

console.log(sql);    // status = :p1 AND age > :p2
console.log(params); // { p1: 'active', p2: 18 }
```

**Why it matters** — The column and callback forms of `where()` *assign* the tree root, replacing anything recorded before them, while the parameters of the dropped conditions remain in `params`. Nothing throws, so the bug shows up as missing filters and wrong result sets. Call `where()` exactly once per builder, then combine with `and()` / `or()`; when you need a genuinely new tree, create a new `query()`.

---

### 4. Wrap mixed `AND` / `OR` logic in callback groups

**❌ Wrong**

```typescript
import { query } from 'blendsdk/expression';

// Intended: (role = admin OR role = moderator) AND age > 21
const { sql } = query()
  .where('role').equals('admin')
  .or('role').equals('moderator')
  .and('age').greaterThan(21)
  .compile();

console.log(sql);
// role = :p1 OR role = :p2 AND age > :p3
// SQL parses this as: role = :p1 OR (role = :p2 AND age > :p3)
```

**✅ Correct**

```typescript
import { query } from 'blendsdk/expression';

// The grouping you intend is emitted as explicit parentheses
const { sql, params } = query()
  .where(q =>
    q
      .where('role').equals('admin')
      .or('role').equals('moderator')
  )
  .and('age').greaterThan(21)
  .compile();

console.log(sql);
// (role = :p1 OR role = :p2) AND age > :p3

console.log(params);
// { p1: 'admin', p2: 'moderator', p3: 21 }
```

**Why it matters** — Inside the builder, conditions combine left to right — `((role = admin) OR (role = moderator)) AND (age > 21)` — but plain chains are emitted without parentheses, and the database re-groups them by its own precedence rules (`AND` binds tighter than `OR`). The SQL no longer expresses what the builder recorded. The callback overloads are the only construct that emits parentheses (the nested result becomes a group node) — use them whenever `AND` and `OR` mix in the same condition.

---

### 5. Guard empty arrays before `in()` / `notIn()`

**❌ Wrong**

```typescript
import { query } from 'blendsdk/expression';

const statuses: string[] = [];

// Emits status IN () — a PostgreSQL syntax error
const { sql, params } = query()
  .where('status')
  .in(statuses)
  .compile();

console.log(sql);    // status IN ()
console.log(params); // {}
```

**✅ Correct**

```typescript
import { query } from 'blendsdk/expression';
import type { QueryBuilder } from 'blendsdk/expression';

function applyStatusFilter(builder: QueryBuilder, statuses: string[]): QueryBuilder {
  if (statuses.length === 0) {
    return builder; // no values → no condition
  }
  return builder.and('status').in(statuses);
}

const { sql, params } = applyStatusFilter(query(), []).compile();

console.log(sql);    // '' — with values it would be 'status IN (:p1, :p2)'
console.log(params); // {}
```

**Why it matters** — `in([])` compiles to `column IN ()`, which PostgreSQL rejects as a syntax error; the empty filter becomes a failed statement instead of "no matches". Guard the length in the layer that accepts the input and decide the empty semantics explicitly: skip the condition, reject the request, or short-circuit to zero rows. The same guard applies to `notIn([])`.

---

### 6. Use the pattern helpers and `like()` — don't double up wildcards

**❌ Wrong**

```typescript
import { query } from 'blendsdk/expression';

// contains() already adds % on both sides — this produces '%%intro%%'
const { params } = query()
  .where('title')
  .contains('%intro%')
  .compile();

console.log(params); // { p1: '%%intro%%' }
```

**✅ Correct**

```typescript
import { query } from 'blendsdk/expression';

// Pick one layer: a helper with a plain value…
const helper = query()
  .where('title').contains('intro')
  .compile();

// …or like() with the complete wildcard pattern
const raw = query()
  .where('title').like('%intro%')
  .compile();

console.log(helper.params); // { p1: '%intro%' }
console.log(raw.params);    // { p1: '%intro%' }
```

**Why it matters** — `startsWith`, `endsWith`, and `contains` are thin wrappers over `like` that add their own `%` wildcards; passing a value that already contains wildcards produces surprising patterns (`'%%intro%%'`) whose meaning drifts from what the caller wrote. Choose one layer: helpers for plain values, `like` / `ilike` for a complete hand-built pattern. When `%` or `_` must match literally, escape the value first (see [Security Considerations](#security-considerations)).

---

### 7. Treat column names as code, not data

**❌ Wrong**

```typescript
import { query } from 'blendsdk/expression';

// `column` arrives from a request — it is embedded into the SQL verbatim
function filterBy(column: string, value: string): string {
  return query().where(column).equals(value).compile().sql;
}

console.log(filterBy('status', 'active')); // status = :p1
```

**✅ Correct**

```typescript
import { query } from 'blendsdk/expression';

const allowedColumns = ['email', 'status'] as const;
type AllowedColumn = (typeof allowedColumns)[number];

function isAllowedColumn(value: string): value is AllowedColumn {
  return allowedColumns.some((column) => column === value);
}

function filterBy(input: string, value: string): string {
  if (!isAllowedColumn(input)) {
    throw new Error(`Unsupported filter column: ${input}`);
  }
  return query().where(input).equals(value).compile().sql;
}

console.log(filterBy('status', 'active')); // status = :p1
```

**Why it matters** — Values are always parameterized, but identifiers are not: column names passed to `where()` / `and()` / `or()`, the reference in `equalsColumn()`, and the columns given to `search()` are concatenated into the generated SQL verbatim, so an attacker-controlled name can alter the predicate's shape. A typed schema (`keyof TSchema`) is the first line of defense; for names that genuinely vary at runtime, route them through a compile-time allow-list as above. The same rule applies to the search `language` option.

---

### 8. Remember the contract: no `WHERE`, possibly empty

**❌ Wrong**

```typescript
import { query } from 'blendsdk/expression';

const { sql } = query().compile();

// sql is '' here — this produces: SELECT * FROM users WHERE
const statement = `SELECT * FROM users WHERE ${sql}`;

console.log(statement); // SELECT * FROM users WHERE
```

**✅ Correct**

```typescript
import { query } from 'blendsdk/expression';

const { sql, params } = query().compile();

const statement =
  sql.length > 0 ? `SELECT * FROM users WHERE ${sql}` : 'SELECT * FROM users';

console.log(statement); // SELECT * FROM users
console.log(params);    // {}
```

**Why it matters** — A `CompileResult` is a predicate fragment: it never contains the `WHERE` keyword, and `sql` is the empty string when no conditions were recorded. Blind concatenation produces a dangling `WHERE` for unfiltered cases — invalid SQL from what looked like a safe template. Append `WHERE` yourself, branch when `sql` is empty, and hand `params` to the driver untouched.

---

### 9. Opt into debug per query, not application-wide

**❌ Wrong**

```typescript
import { query } from 'blendsdk/expression';

// Every production result carries an AST snapshot and timing data
const result = query({ debug: true })
  .where('status').equals('active')
  .compile();

console.log(result.debug?.ast);
console.log(result.debug?.compilationTime);
```

**✅ Correct**

```typescript
import { query } from 'blendsdk/expression';

// Production path: no debug payload
const standard = query()
  .where('status').equals('active')
  .compile();

// Diagnostic path: enable only the query you are investigating
const diagnosing = query({ debug: true })
  .where('status').equals('active')
  .compile();

console.log(standard.debug);                   // undefined
console.log(diagnosing.debug?.parameterCount); // 1
```

**Why it matters** — Debug mode attaches a `DebugInfo` object — the AST (which stores the raw values you passed), warnings, parameter count, and compilation timing — to every result. In a hot path that means extra allocations and retained objects whenever results are logged or buffered. Reserve `query({ debug: true })` and `.debug()` for tests and troubleshooting.

---

### 10. Bind subquery parameters explicitly

**❌ Wrong**

```typescript
import { query } from 'blendsdk/expression';

interface Customer {
  id: number;
}

interface Order {
  id: number;
  customer_id: number;
  total: number;
}

// The subquery has its own parameter manager: 100 is stored as p1 there
const bigOrders = query<Order>().where('total').greaterThan(100);

const { sql, params } = query<Customer>()
  .where('id').inSubquery(bigOrders)
  .compile();

console.log(sql);
// id IN (SELECT * WHERE total > :p1)

console.log(params);
// {} — :p1 has no value; binding this result fails
```

**✅ Correct**

```typescript
import { query } from 'blendsdk/expression';

interface Customer {
  id: number;
}

interface Order {
  id: number;
  customer_id: number;
  total: number;
}

const bigOrders = query<Order>().where('total').greaterThan(100);
const subResult = bigOrders.compile();

const parentResult = query<Customer>()
  .where('id').inSubquery(bigOrders)
  .compile();

// inSubquery() registers no parameters of its own, so the parent map is
// empty here and the merge binds :p1 to 100.
const params = { ...subResult.params, ...parentResult.params };

console.log(parentResult.sql);
// id IN (SELECT * WHERE total > :p1)

console.log(params);
// { p1: 100 }
```

**Why it matters** — A subquery built with its own `query()` call owns its own `ParameterManager`; the parent's `compile()` returns only the parent's parameters, so the SQL references `:p1` while the parent's `params` is empty. Compile the subquery as well and bind both maps — but both managers number from `p1`, so only merge when at most one side registers parameters (or you have verified that overlapping names hold identical values). When a subquery only needs correlated references, prefer `equalsColumn()` (e.g. `where('customer_id').equalsColumn('customers.id')`) — it registers no parameters, keeping the parent's single `compile()` result self-sufficient. Note also that a subquery with no conditions throws `Subquery must have at least one condition` when the condition is added.

---

### 11. Plan for PostgreSQL only

**❌ Wrong**

```typescript
import { query, SqlDialect } from 'blendsdk/expression';

const builder = query({ dialect: SqlDialect.SQLite })
  .where('status').equals('active');

// Throws: Dialect sqlite is not yet implemented
builder.compile();
```

**✅ Correct**

```typescript
import { query, SqlDialect } from 'blendsdk/expression';

// PostgreSQL is the default — set it explicitly if you like
const { sql, params } = query({ dialect: SqlDialect.PostgreSQL })
  .where('status').equals('active')
  .compile();

console.log(sql);    // status = :p1
console.log(params); // { p1: 'active' }
```

**Why it matters** — `SqlDialect` declares `MySQL`, `MSSQL`, and `SQLite`, but only PostgreSQL has a compiler: selecting any other member throws `Dialect <name> is not yet implemented` at the very end of the pipeline, when you call `compile()`. Keep the dialect at its PostgreSQL default (or set it explicitly for clarity) and never wire dialect selection straight to request data, so an unsupported value cannot turn every query into a runtime failure.

---

## Anti-Patterns

Each of these patterns compiles, and most run for a long time before anyone notices the results are wrong.

### Unparenthesized `AND` / `OR` mixes

`.where('a').equals(1).or('b').equals(2).and('c').equals(3)` records the tree `((a OR b) AND c)` but emits `a = :p1 OR b = :p2 AND c = :p3`, which the database evaluates as `a OR (b AND c)`. The SQL no longer expresses what the builder recorded. Wrap every mixed group in a callback so the parentheses you intend are actually emitted (pair 4).

### A second `where()` — conditions vanish, parameters linger

`where()` assigns the tree root; `and()` / `or()` combine with it. Calling `where()` again replaces the root, dropping earlier conditions from the SQL while their parameter names stay in `params` — a mismatch between predicate and bindings that nothing warns about (pair 3).

### `equals(null)` / `equals(undefined)` for `NULL` checks

Both emit `column = :pN` with a `null` binding, a predicate that matches no rows — not even `NULL` ones. `isNull()` / `isNotNull()` exist for exactly this (pair 2).

### `in([])` and `notIn([])`

Empty arrays compile to `column IN ()` — a PostgreSQL syntax error waiting for the first request in which the user selects no filters. Guard the length before calling `in()`; the package cannot know what "no values" should mean (pair 5).

### Sharing one builder across requests

A builder is mutable state: every `and()` / `or()` call extends the tree, and the parameter manager keeps growing. A module-level builder used by multiple requests accumulates filters — and values — from earlier calls:

```typescript fragment
const shared = query(); // module scope — do not do this

function requestA(): string {
  return shared.where('status').equals('active').compile().sql;
}

function requestB(): string {
  return shared.and('age').greaterThan(18).compile().sql;
  // status = :p1 AND age > :p2 — request A's filter is still attached
}
```

Create a builder per statement. If you need reuse, reuse compiled *results*, not builders.

### Expecting subquery parameters in the parent's `compile()`

`exists`, `inSubquery`, and friends copy the subquery's AST into the parent — not its parameters. The parent's `params` will not contain the subquery's values even though the SQL references their placeholders. Compile the subquery separately and bind both maps, or keep subqueries parameter-free with `equalsColumn` — and remember both managers number from `p1` (pair 10).

### `clone()` as a branching tool

`clone()` shares the AST reference but starts a fresh parameter manager: placeholders already in the tree have no values in the clone, and newly added conditions renumber from `p1`, colliding with existing names:

```typescript fragment
const base = query().where('status').equals('active');
const branch = base.clone().and('age').greaterThan(18);

branch.compile();
// sql:    status = :p1 AND age > :p1
// params: { p1: 18 } — both placeholders point at the same value
```

Unless the shared tree is completely parameter-free, build each variation with its own `query()` call.

### Relying on `SubqueryBuilder.select()` / `.aggregate()`

The exported `SubqueryBuilder` interface advertises `select(...columns)` and `aggregate(func)`, but version 5.x ships no concrete implementation — `query()` never returns that type and the methods do not exist at runtime. Build subqueries with the shipped comparison-stage methods: `exists`, `notExists`, `inSubquery`, `notInSubquery`, `equalsColumn`.

---

## Performance Tips

A predicate for a single statement is cheap — a single pass over a small tree. The guidance below is about not repeating that cost and keeping generated SQL planner-friendly.

### Build and compile once per statement

Every builder call allocates and freezes a new AST node, and every `compile()` constructs a dialect compiler, walks the tree, formats every placeholder, and rebuilds the `params` record. Inside loops over rows or items, that is repeated work for an identical result. Parameter names are generated deterministically (`p1`, `p2`, … in condition order), so identical builder calls produce an identical `CompileResult` — compute it once and reuse `sql` / `params` (memoizing by filter shape is safe).

```typescript
import { query } from 'blendsdk/expression';

interface Order {
  id: number;
  status: string;
  total: number;
}

// Compile once — reuse the fragment for every statement that shares this filter
const { sql, params } = query<Order>()
  .where('status').equals('paid')
  .and('total').greaterThan(100)
  .compile();

console.log(sql);    // status = :p1 AND total > :p2
console.log(params); // { p1: 'paid', p2: 100 }
```

### Prefer `in()` over long `or()` chains

Two ways to express "column equals one of these values" produce very different trees: `.in(values)` is a single comparison node with N parameters, while `a = 1 OR a = 2 OR …` is N comparison nodes plus N−1 logical nodes — all allocated, frozen, and walked during compilation. For 100 values that is 1 node versus 199.

```typescript fragment
// ❌ 199 AST nodes (100 comparisons + 99 logical nodes)
let chain = query().where('id').equals(1);
for (let id = 2; id <= 100; id++) {
  chain = chain.or('id').equals(id);
}

// ✅ 1 AST node, 100 parameters
const ids = Array.from({ length: 100 }, (_, index) => index + 1);
const compiled = query().where('id').in(ids).compile();
```

### Bound the size of `IN` lists

Each element of `in()` / `notIn()` becomes its own placeholder and parameter, so a 10,000-value list yields a 10,000-parameter statement: SQL text, the driver's bind array, and PostgreSQL's parse/plan work all grow with it, and combined with other parameters you approach PostgreSQL's ~65,535-parameter protocol limit. Cap user-supplied arrays (a few hundred entries is a common ceiling) and switch strategies for genuinely large sets — chunk the predicate or move the values into a temporary table or join. This is also a security control (see [Security Considerations](#security-considerations)).

### Use full-text search instead of leading-wildcard `LIKE`

`contains()` renders `LIKE '%term%'`; the leading `%` prevents ordinary B-tree index usage, so the predicate scans. `search()` renders `to_tsvector(...) @@ to_tsquery(...)`, and that expression can be backed by a GIN index.

```typescript fragment
query<Post>()
  .search(['title', 'body'], 'postgres indexing')
  .compile();
// → to_tsvector('english', title || ' ' || body) @@ plainto_tsquery('english', :p1)

// Make it indexable by creating the identical expression index:
// CREATE INDEX posts_search_idx ON posts
//   USING gin (to_tsvector('english', title || ' ' || body));
```

### Keep debug mode out of hot paths

`query({ debug: true })` and `.debug()` make every `compile()` attach `DebugInfo`: an AST snapshot (with the raw values), warnings and optimizations arrays, parameter count, and timing. When results are logged or buffered, those extra objects — and the tree they reference — stay alive. The timing call itself (`performance.now()`) is negligible; retention and payload size are the cost. Enable debug on the query you are investigating, not application-wide.

---

## Security Considerations

The package's central guarantee is that user-supplied values never become SQL text. The remaining surface is everything SQL cannot parameterize — plus the pattern semantics of `LIKE`. Keep these boundaries in mind.

### Never re-inline parameter values

`compile()` returns SQL with placeholders (`:p1`) and a separate `params` map; keep them separate all the way to the driver. Substituting values back into the string — even "temporarily" — removes the guarantee the builder exists to provide.

```typescript fragment
// ❌ Undoes parameterization — this is SQL injection by hand
function inline(sql: string, value: string): string {
  return sql.replace(':p1', `'${value}'`);
}

// ✅ The placeholder stays; the value travels through params
const { sql, params } = query().where('status').equals('active').compile();
// sql: 'status = :p1'  ·  params: { p1: 'active' }
```

### Allow-list every identifier and the search language

Column names in `where()` / `and()` / `or()`, the reference in `equalsColumn()`, the columns given to `search()`, and the full-text `language` are concatenated into the generated SQL verbatim — they cannot be parameters. Route runtime-provided names through a compile-time allow-list (see pair 7); for the language option, restrict to the set you support:

```typescript fragment
const supportedLanguages: readonly string[] = ['english', 'dutch', 'german'];

function toSearchLanguage(input: string): string {
  return supportedLanguages.includes(input) ? input : 'english';
}
```

### Escape `LIKE` wildcards for literal searches

`like`, `ilike`, `startsWith`, `endsWith`, and `contains` treat `%` (any run of characters) and `_` (any single character) as pattern syntax. Parameterization stops injection but not wildcard semantics: a caller can broaden a filter, or probe values character by character with `_`. When matching literal text, escape the value first — PostgreSQL's default `LIKE` escape character is the backslash:

```typescript
import { query } from 'blendsdk/expression';

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

const { sql, params } = query()
  .where('title')
  .contains(escapeLikePattern('50%_off'))
  .compile();

console.log(sql);    // title LIKE :p1
console.log(params); // { p1: '%50\\%\\_off%' }
```

### Cap user-controlled collections

Arrays from request payloads that feed `in()` / `notIn()` become one parameter per element, and every extra element inflates the statement text and parameter map (see [Performance Tips](#performance-tips)). Validate type and length at the API boundary so a single request cannot force the construction of pathological predicates.

### Handle compiled artifacts like the data they contain

`params` holds the raw values you passed, and `DebugInfo.ast` keeps those values inside comparison nodes. A logged or exposed `CompileResult` leaks data the same way raw rows would — keep both out of logs and error messages unless the underlying data itself would be acceptable there.

---

# expression Testing Patterns

This document describes how to test code that consumes `blendsdk/expression`, based on the package's own Vitest suite (`tests/basic.test.ts` and `tests/edge-cases.test.ts` — the source of truth for expected behavior). The package is a pure, synchronous, zero-dependency SQL predicate builder: there are no external services, no I/O, and no Docker dependencies anywhere in its test setup. Every test builds queries in memory and asserts on the deterministic output of `.compile()`.

## Quick Facts

| Aspect | Detail |
|---|---|
| Test framework | Vitest 4.x (`vitest@^4.1.10`) |
| Runtime | Node.js >= 22 — ESM only, `require()` is unsupported |
| Synchrony | The entire builder API is synchronous; `compile()` returns a `CompileResult` immediately |
| External services | None — no database, network, or Docker required |
| Determinism | The same chain always compiles to the same `sql` and `params` |
| Package test files | `tests/basic.test.ts`, `tests/edge-cases.test.ts` |
| Coverage provider | `@vitest/coverage-v8` |

---

## Test Setup

### Framework, Runtime, and Commands

The package ships its own scripts; consumer projects use the same commands (adapt paths as needed):

| Command | Runs | Purpose |
|---|---|---|
| `npm test` | `vitest run --reporter=verbose` | One-shot test run (matches how the package tests itself) |
| `npm run test:watch` | `vitest watch --reporter=verbose` | Watch mode during development |
| `npm run test:coverage` | `vitest run --coverage` | V8 coverage report |

Because the package is fully in-process, there is **no** `globalSetup`, **no** `setupFiles`, and **no** Docker dependency. Each `query()` call creates its own `ParameterManager`, so there is no mutable state to reset between tests.

### Vitest Configuration

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
```

The package runs on Node.js >= 22 and uses `node:perf_hooks` internally, so keep the environment as `node` and provide `@types/node` in `devDependencies`.

### TypeScript Configuration

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "tests"]
}
```

Under `NodeNext` resolution, relative imports inside test files use the `.js` extension (`import { User } from './fixtures/schemas.js'`) — the same convention the package's own tests use. Add `tsc --noEmit` to CI so the `@ts-expect-error` type-safety tests described later actually enforce anything.

### Required Imports

Import only from the package root — the public surface is everything re-exported from `src/index.ts`. Never import from a `dist/` or `src/` path, and never from internal modules:

```typescript
// Vitest + runtime imports
import { describe, it, expect, vi } from 'vitest';
import {
  ASTNodeType,
  ComparisonOperator,
  FullTextMode,
  JsonOperator,
  LogicalOperator,
  ParameterManager,
  PostgreSQLCompiler,
  QueryBuilderImpl,
  SqlDialect,
  query,
} from 'blendsdk/expression';

// Type-only imports
import type {
  ASTNode,
  ComparisonBuilder,
  ComparisonNode,
  CompileResult,
  DebugInfo,
  GroupNode,
  JsonNode,
  LogicalNode,
  QueryBuilder,
  SearchOptions,
  SubqueryNode,
} from 'blendsdk/expression';
```

What each import is for:

| Import | Kind | Typical test use |
|---|---|---|
| `query` | function | Create builders under test — used in nearly every test |
| `QueryBuilderImpl` | class | `instanceof` checks; `clone()` tests (`clone` is not on the `QueryBuilder` interface) |
| `SqlDialect` | enum | Dialect options and "not yet implemented" error cases |
| `ASTNodeType`, `ComparisonOperator`, `LogicalOperator`, `JsonOperator`, `FullTextMode` | enums | Structural assertions on `getAST()` output |
| `ParameterManager` | class | Direct unit tests; spy target for compiler tests |
| `PostgreSQLCompiler` | class | Compiler-level tests with a hand-held AST |
| `CompileResult`, `QueryOptions`, `SearchOptions`, `DebugInfo`, AST node types | types | Annotating helpers and consumer functions |
| `QueryBuilder`, `ComparisonBuilder` | types | Typing shared test case tables and helpers |

Note what is **not** exported: AST helpers such as `isComparisonNode`, `createComparisonNode`, `nodesEqual`, and `resetNodeIdCounter` are internal. Write your own narrowing helpers (shown below) instead of reaching into internals.

### Test Helpers

These helpers remove the most common boilerplate: asserting SQL and parameters together, compiling with a fresh builder, and narrowing AST nodes safely:

```typescript
// tests/helpers/expression.ts
import { expect } from 'vitest';
import { ASTNodeType, query } from 'blendsdk/expression';
import type {
  ASTNode,
  ComparisonNode,
  CompileResult,
  LogicalNode,
  QueryBuilder,
} from 'blendsdk/expression';

/**
 * Assert a compile result against the exact SQL fragment and parameter map.
 * The parameter map is compared exhaustively with `toEqual`.
 */
export function expectSql(
  result: CompileResult,
  expectedSql: string,
  expectedParams: Record<string, unknown> = {}
): void {
  expect(result.sql).toBe(expectedSql);
  expect(result.params).toEqual(expectedParams);
}

/**
 * Run a callback against a fresh builder and compile the result.
 * Useful for one-liner tests of full fluent chains.
 */
export function compileWith<TSchema>(
  build: (builder: QueryBuilder<TSchema>) => QueryBuilder<TSchema>
): CompileResult {
  return build(query<TSchema>()).compile();
}

/**
 * Narrow an AST into a ComparisonNode, failing loudly for unexpected shapes.
 * The package does not export its own type guards, so tests define helpers
 * like this one instead of importing internals.
 */
export function asComparisonNode(node: ASTNode | null): ComparisonNode {
  if (node === null || node.type !== ASTNodeType.Comparison) {
    const received = node === null ? 'null' : node.type;
    throw new Error(`Expected a comparison node; received ${received}`);
  }
  return node as ComparisonNode;
}

/**
 * Narrow an AST into a LogicalNode (AND/OR).
 */
export function asLogicalNode(node: ASTNode | null): LogicalNode {
  if (node === null || node.type !== ASTNodeType.Logical) {
    const received = node === null ? 'null' : node.type;
    throw new Error(`Expected a logical node; received ${received}`);
  }
  return node as LogicalNode;
}
```

Usage:

```typescript
import { describe, it } from 'vitest';
import { query } from 'blendsdk/expression';
import { compileWith, expectSql } from './helpers/expression.js';

describe('helpers in action', () => {
  it('asserts SQL and parameters together', () => {
    const result = query().where('status').equals('active').compile();
    expectSql(result, 'status = :p1', { p1: 'active' });
  });

  it('compiles a chain in one expression', () => {
    const result = compileWith<{ status: string; age: number }>((builder) =>
      builder.where('status').equals('active').and('age').greaterThanOrEqual(18)
    );
    expectSql(result, 'status = :p1 AND age >= :p2', { p1: 'active', p2: 18 });
  });
});
```

### Shared Fixtures

Reuse one set of schema fixtures across test files so every test binds to the same column names and types:

```typescript
// tests/fixtures/schemas.ts
export type Status = 'active' | 'pending' | 'suspended';

export interface User {
  id: number;
  email: string;
  name: string;
  status: Status;
  age: number;
  verified: boolean;
  created_at: string;
  metadata: Record<string, unknown>;
  tags: string[];
}

export interface Post {
  id: number;
  title: string;
  body: string;
  author_id: number;
}
```

### Recommended Test Layout

```text
tests/
├── basic.test.ts                      # comparisons, grouping, JSON, full-text, debug
├── edge-cases.test.ts                 # null/undefined, deep nesting, parameter numbering
├── helpers/
│   ├── expression.ts                  # expectSql, compileWith, node narrowing
│   └── executor.ts                    # createFakeExecutor (see Mocking)
├── fixtures/
│   └── schemas.ts                     # User, Post, Status
└── integration/
    └── postgresql.integration.test.ts # optional PostgreSQL round-trip
```

The package's own suites live flat in `tests/` and import the source entry directly (`../src/index.js`) because they run inside the monorepo. Consumer tests must always import the built package by name: `import { query } from 'blendsdk/expression'`.

### Test Isolation Notes

- **Fresh parameter manager per builder.** Every `query()` call creates its own `ParameterManager`; nested group builders share the parent's. Nothing leaks between tests — no `beforeEach` cleanup needed.
- **Never assert node ids.** AST nodes receive generated ids (`node_1`, `node_2`, …) from a module-level counter shared across test files in the same worker. Assert the id *shape* (`/^node_\d+$/`) if you must, never an exact value — execution order would make such tests flaky.
- **Never assert exact compilation times.** `DebugInfo.compilationTime` comes from `performance.now()`; assert `toBeGreaterThanOrEqual(0)` or `typeof === 'number'` instead.
- **When testing `ParameterManager` directly**, create a new instance per test, or call `reset()` — a manager accumulates state across calls.

---

## Unit Testing

### The Assertion Contract: SQL and Parameters

Every unit test pins two outputs of `compile()`: the SQL fragment (`result.sql`, asserted with `toBe` — the output is deterministic) and the bound values (`result.params`, asserted with `toEqual` — covering both names and values). This mirrors the package's own tests exactly:

```typescript
import { describe, it, expect } from 'vitest';
import { query } from 'blendsdk/expression';

describe('simple comparisons', () => {
  it('renders equality with a bound parameter', () => {
    const result = query().where('status').equals('active').compile();

    expect(result.sql).toBe('status = :p1');
    expect(result.params).toEqual({ p1: 'active' });
  });

  it('renders IS NULL without any parameter', () => {
    const result = query().where('deleted_at').isNull().compile();

    expect(result.sql).toBe('deleted_at IS NULL');
    expect(result.params).toEqual({});
  });
});
```

Prefer explicit `toBe` expectations over snapshots: the generated SQL is deterministic, and an explicit expectation documents the behavior it protects.

### Testing the Builder Factory

The `query()` factory always returns a `QueryBuilderImpl`; a one-line `instanceof` check guards that contract:

```typescript
import { describe, it, expect } from 'vitest';
import { QueryBuilderImpl, query } from 'blendsdk/expression';

describe('query()', () => {
  it('returns a QueryBuilderImpl instance', () => {
    expect(query()).toBeInstanceOf(QueryBuilderImpl);
  });

  it('compiles an empty condition set to an empty fragment', () => {
    const result = query().compile();

    expect(result.sql).toBe('');
    expect(result.params).toEqual({});
  });
});
```

### Structural Assertions on the AST

Assert on SQL for behavior; drop to `getAST()` only when the *shape* of the tree is what you want to pin — node types, operators, columns, and parameter names. Use the narrowing helpers from the Test Setup section:

```typescript
import { describe, it, expect } from 'vitest';
import { ComparisonOperator, query } from 'blendsdk/expression';
import { asComparisonNode } from './helpers/expression.js';

describe('AST structure', () => {
  it('records a comparison node with a bound parameter name', () => {
    const ast = query().where('status').equals('active').getAST();
    const node = asComparisonNode(ast);

    expect(node.column).toBe('status');
    expect(node.operator).toBe(ComparisonOperator.Equal);
    expect(node.parameterNames).toEqual(['p1']);
  });

  it('freezes every node', () => {
    const ast = query().where('status').equals('active').getAST();
    expect(Object.isFrozen(ast)).toBe(true);
  });
});
```

### Testing Conditional Filter Builders

Most application code conditionally assembles filters from optional criteria. Test each branch, the combination, and the empty case. Given this function under test:

```typescript
// src/user-search.ts
import { query } from 'blendsdk/expression';
import type { CompileResult, QueryBuilder } from 'blendsdk/expression';

interface User {
  status: string;
  age: number;
}

export interface SearchCriteria {
  status?: string;
  minimumAge?: number;
}

export function buildUserSearch(criteria: SearchCriteria): CompileResult {
  let builder: QueryBuilder<User> = query<User>();

  if (criteria.status !== undefined) {
    builder = builder.where('status').equals(criteria.status);
  }
  if (criteria.minimumAge !== undefined) {
    builder = builder.and('age').greaterThanOrEqual(criteria.minimumAge);
  }

  return builder.compile();
}
```

Test every combination:

```typescript
import { describe, it, expect } from 'vitest';
import { buildUserSearch } from '../src/user-search.js';

describe('buildUserSearch', () => {
  it('builds a single condition', () => {
    const result = buildUserSearch({ minimumAge: 21 });

    expect(result.sql).toBe('age >= :p1');
    expect(result.params).toEqual({ p1: 21 });
  });

  it('numbers parameters in call order', () => {
    const result = buildUserSearch({ status: 'active', minimumAge: 21 });

    expect(result.sql).toBe('status = :p1 AND age >= :p2');
    expect(result.params).toEqual({ p1: 'active', p2: 21 });
  });

  it('returns an empty fragment when no criteria are provided', () => {
    const result = buildUserSearch({});

    expect(result.sql).toBe('');
    expect(result.params).toEqual({});
  });
});
```

### Error Paths

Both failure modes of the package are deterministic and testable without any mocking — use `toThrowError` with the exact message:

```typescript
import { describe, it, expect } from 'vitest';
import { SqlDialect, query } from 'blendsdk/expression';

describe('failure modes', () => {
  it('throws for dialects that are not implemented', () => {
    expect(() => query({ dialect: SqlDialect.MySQL }).where('id').equals(1).compile()).toThrowError(
      'Dialect mysql is not yet implemented'
    );
  });

  it('throws when a subquery carries no conditions', () => {
    const emptySubquery = query();

    expect(() => query().where('id').exists(emptySubquery)).toThrowError(
      'Subquery must have at least one condition'
    );
  });
});
```

### Synchronous by Design

Every builder method and `compile()` itself is synchronous — use plain `it('...', () => { ... })` callbacks. There is no reason to make unit tests async. The only genuinely asynchronous test you typically need is when *your own* code is async (see [Stub Your Execution Layer](#stub-your-execution-layer-not-the-package) for an example) or when you execute the SQL against a database (see [Integration Testing](#integration-testing)).

---

## Integration Testing

### Full-Pipeline Compilation (In-Process)

The strongest "integration" test this package supports requires no infrastructure: compile a realistic, compound filter through the real builder, real parameter manager, and real compiler, then pin the complete SQL and every bound value:

```typescript
import { describe, it, expect } from 'vitest';
import { query } from 'blendsdk/expression';
import type { User } from './fixtures/schemas.js';

describe('compound filter (end to end, in process)', () => {
  it('compiles a realistic user filter', () => {
    const result = query<User>()
      .where('status')
      .in(['active', 'pending'])
      .and((group) => group.where('age').between(18, 65).or('verified').equals(true))
      .and('created_at')
      .isNotNull()
      .compile();

    expect(result.sql).toBe(
      'status IN (:p1, :p2) AND (age BETWEEN :p3 AND :p4 OR verified = :p5) AND created_at IS NOT NULL'
    );
    expect(result.params).toEqual({ p1: 'active', p2: 'pending', p3: 18, p4: 65, p5: true });
  });
});
```

### Compiler Reuse with PostgreSQLCompiler

When you hold an AST for a custom pipeline, compile it directly with `PostgreSQLCompiler`. The compiler only *formats* placeholders through the `ParameterManager` — the values stay in the builder's manager, which is why a fresh manager is fine here:

```typescript
import { describe, it, expect } from 'vitest';
import {
  ParameterManager,
  PostgreSQLCompiler,
  SqlDialect,
  query,
} from 'blendsdk/expression';
import type { ASTNode } from 'blendsdk/expression';

describe('PostgreSQLCompiler', () => {
  it('renders an AST compiled via a shared parameter manager', () => {
    const ast: ASTNode | null = query()
      .where('status').equals('active')
      .and('age').greaterThan(18)
      .getAST();

    if (ast === null) {
      throw new Error('Expected the builder to produce an AST.');
    }

    const compiler = new PostgreSQLCompiler(new ParameterManager(SqlDialect.PostgreSQL));

    expect(compiler.compile(ast)).toBe('status = :p1 AND age > :p2');
    expect(compiler.getOptimizations()).toEqual([]);
    expect(compiler.getWarnings()).toEqual([]);
  });
});
```

### Optional: PostgreSQL Round-Trip (Async)

If your application executes the compiled SQL, add a round-trip test that proves PostgreSQL accepts the generated SQL and returns the expected rows. The package itself has **no Docker dependency** — this suite is opt-in and skips automatically unless a database is reachable.

Prerequisites:

- `npm install --save-dev pg @types/pg`
- A PostgreSQL instance and a `DATABASE_URL` (for example `postgres://postgres:postgres@localhost:5432/postgres`, e.g. via `docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:17`)

The package emits `:pN` named placeholders while `pg` expects positional `$N` values — the adapter below bridges the two:

```typescript
// tests/integration/postgresql.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { query } from 'blendsdk/expression';

type UserEmailRow = {
  email: string;
};

const connectionString = process.env.DATABASE_URL;

/**
 * Convert the package's `:pN` placeholders into the `$N` form required by
 * node-postgres, preserving binding order. Safe here because compiled
 * predicates contain no other colon-prefixed tokens.
 */
function toPositional(
  sql: string,
  params: Record<string, unknown>
): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const positions = new Map<string, number>();

  const text = sql.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    let position = positions.get(name);
    if (position === undefined) {
      values.push(params[name]);
      position = values.length;
      positions.set(name, position);
    }
    return `$${position}`;
  });

  return { text, values };
}

describe.skipIf(connectionString === undefined)('PostgreSQL round-trip', () => {
  const client = new Client({ connectionString });

  beforeAll(async () => {
    await client.connect();
    await client.query(`
      CREATE TEMP TABLE users (
        id serial PRIMARY KEY,
        email text NOT NULL,
        status text NOT NULL,
        age integer NOT NULL
      )
    `);
    await client.query(`
      INSERT INTO users (email, status, age) VALUES
        ('ada@example.com', 'active', 36),
        ('grace@example.com', 'pending', 45),
        ('alan@example.com', 'active', 17)
    `);
  });

  afterAll(async () => {
    await client.end();
  });

  it('filters rows with the compiled WHERE fragment', async () => {
    const { sql, params } = query()
      .where('status').equals('active')
      .and('age').greaterThanOrEqual(18)
      .compile();

    const { text, values } = toPositional(sql, params);
    const result = await client.query<UserEmailRow>(
      `SELECT email FROM users WHERE ${text} ORDER BY email`,
      values
    );

    expect(result.rows.map((row) => row.email)).toEqual(['ada@example.com']);
  });

  it('surfaces PostgreSQL errors as async rejections', async () => {
    const { sql, params } = query().where('unknown_column').equals(1).compile();
    const { text, values } = toPositional(sql, params);

    await expect(
      client.query(`SELECT email FROM users WHERE ${text}`, values)
    ).rejects.toThrowError(/column "unknown_column" does not exist/);
  });
});
```

Notes:

- A single `Client` (not a `Pool`) keeps one connection for the suite, which is what makes the `TEMP TABLE` visible across queries. Use `beforeAll`/`afterAll` for connect and teardown — this is the canonical async setup/teardown pattern for this package.
- `describe.skipIf(connectionString === undefined)` keeps the suite green on machines and CI jobs without a database.
- Use `await expect(...).rejects.toThrowError(...)` to assert asynchronous failures.
- Teams often run only the in-process tests on every commit and schedule the round-trip suite for CI jobs that provision PostgreSQL as a service container.

---

## Mocking & Stubbing

### Prefer Real Instances

The package is pure, synchronous, dependency-free, and deterministic — building a real query costs microseconds and performs no I/O. For the overwhelming majority of tests, there is nothing worth mocking: call `query()` and assert on the result. Never mock `query()` in a test whose purpose is verifying generated SQL; you would be replacing the exact behavior under test.

Mock or stub only at these seams:

1. The **module boundary**, when you need to assert that *your* code called into the package (interaction tests).
2. **Class instances your code shares**, via `vi.spyOn`, when you need failure injection or call verification.
3. **Your own execution layer** (database driver wrapper), which keeps the package real while stubbing the I/O.

### Module Mocking with `vi.mock` (Passthrough)

To assert that your code creates builders — without losing real behavior — wrap `query` in a spy and keep everything else real by spreading `importOriginal`:

```typescript
// src/user-filter.ts (the module under test)
import { query } from 'blendsdk/expression';
import type { CompileResult } from 'blendsdk/expression';

export type Status = 'active' | 'pending' | 'suspended';

export interface UserFilterSchema {
  status: Status;
  age: number;
}

export function buildStatusFilter(status: Status, minimumAge: number): CompileResult {
  return query<UserFilterSchema>()
    .where('status').equals(status)
    .and('age').greaterThanOrEqual(minimumAge)
    .compile();
}
```

```typescript
// tests/user-filter.mock.test.ts
import { describe, it, expect, vi } from 'vitest';
import { query } from 'blendsdk/expression';
import type { CompileResult } from 'blendsdk/expression';
import { buildStatusFilter } from '../src/user-filter.js';

vi.mock('blendsdk/expression', async (importOriginal) => {
  const actual = await importOriginal<typeof import('blendsdk/expression')>();
  return {
    ...actual,
    query: vi.fn(actual.query),
  };
});

const mockedQuery = vi.mocked(query);

describe('buildStatusFilter (interaction test)', () => {
  it('creates one builder and keeps the real compile output', () => {
    const result: CompileResult = buildStatusFilter('active', 18);

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    expect(mockedQuery).toHaveBeenCalledWith();
    expect(result.sql).toBe('status = :p1 AND age >= :p2');
    expect(result.params).toEqual({ p1: 'active', p2: 18 });
  });
});
```

Key points:

- The factory **wraps, not replaces**: `vi.fn(actual.query)` delegates to the real factory, so compiled output stays authentic while the spy records calls.
- `vi.mock` factories are hoisted above imports and must not reference outer variables — only parameters like `importOriginal` (use `vi.hoisted` if you need shared state).
- The mock replaces the module for every importer in the test file's graph, including your SUT — that is exactly what you want here.

### Spying on Shared Instances

`ParameterManager` and `PostgreSQLCompiler` have private state, so object-literal fakes cannot satisfy their types under strict mode. Use `vi.spyOn` on real instances instead:

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
  ParameterManager,
  PostgreSQLCompiler,
  SqlDialect,
  query,
} from 'blendsdk/expression';
import type { ASTNode } from 'blendsdk/expression';

describe('PostgreSQLCompiler spies', () => {
  function buildAst(): ASTNode {
    const ast = query().where('status').equals('active').getAST();
    if (ast === null) {
      throw new Error('Expected the builder to produce an AST.');
    }
    return ast;
  }

  it('formats every placeholder through the parameter manager', () => {
    const paramManager = new ParameterManager(SqlDialect.PostgreSQL);
    const formatSpy = vi.spyOn(paramManager, 'formatParameterPlaceholder');

    const compiler = new PostgreSQLCompiler(paramManager);

    expect(compiler.compile(buildAst())).toBe('status = :p1');
    expect(formatSpy).toHaveBeenCalledExactlyOnceWith('p1');
  });

  it('can inject failures through a stubbed method', () => {
    const paramManager = new ParameterManager(SqlDialect.PostgreSQL);
    vi.spyOn(paramManager, 'formatParameterPlaceholder').mockImplementation(() => {
      throw new Error('placeholder formatting failed');
    });

    const compiler = new PostgreSQLCompiler(paramManager);

    expect(() => compiler.compile(buildAst())).toThrowError('placeholder formatting failed');
  });
});
```

### Stub Your Execution Layer, Not the Package

If your code runs the compiled SQL, the seam to stub is *your* executor interface — the expression package stays real, so the unit test still verifies the generated predicate:

```typescript
// src/executor.ts
export interface StatementExecutor {
  execute(sql: string, params: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}
```

```typescript
// tests/helpers/executor.ts
import { vi } from 'vitest';

export function createFakeExecutor(rows: Record<string, unknown>[] = []) {
  return {
    execute: vi.fn(async (_sql: string, _params: Record<string, unknown>) => rows),
  };
}
```

```typescript
// src/user-lookup.ts
import { query } from 'blendsdk/expression';
import type { StatementExecutor } from './executor.js';

interface User {
  status: string;
}

export function findActiveUsers(
  executor: StatementExecutor
): Promise<Record<string, unknown>[]> {
  const { sql, params } = query<User>().where('status').equals('active').compile();
  return executor.execute(`SELECT id FROM users WHERE ${sql}`, params);
}
```

```typescript
import { describe, it, expect } from 'vitest';
import { createFakeExecutor } from './helpers/executor.js';
import { findActiveUsers } from '../src/user-lookup.js';

describe('findActiveUsers', () => {
  it('executes the compiled predicate through the injected executor', async () => {
    const executor = createFakeExecutor([{ id: 1 }]);

    const rows = await findActiveUsers(executor);

    expect(rows).toEqual([{ id: 1 }]);
    expect(executor.execute).toHaveBeenCalledWith(
      'SELECT id FROM users WHERE status = :p1',
      { p1: 'active' }
    );
  });
});
```

This is also the standard async unit-test pattern: the fake executor resolves immediately, so no timers or database are needed.

### Things You Cannot (Usefully) Mock

- **Internal symbols**: `isComparisonNode`, `createComparisonNode`, `nodesEqual`, `resetNodeIdCounter` are not exported — write local helpers instead.
- **Generated node ids**: they come from a process-wide counter; assert structure, not values.
- **Class instances as object literals**: `ParameterManager`, `QueryBuilderImpl`, and `PostgreSQLCompiler` have private members, so a plain object cannot satisfy their types. Use `vi.spyOn` on real instances.
- **Compilation time**: it is wall-clock measurement; assert it exists and is non-negative rather than comparing values.

---

## Test Patterns by Feature

Every feature maps to the same three assertion levels: compiled SQL (`result.sql`), bound values (`result.params`), and AST shape (`getAST()`). The patterns below apply that ladder feature by feature. Fixture types (`User`, `Post`) come from `tests/fixtures/schemas.ts`.

### Simple Comparisons

A table-driven `it.each` keeps the operator matrix compact and exhaustive — every comparison operator gets one row:

```typescript
import { describe, it, expect } from 'vitest';
import { query } from 'blendsdk/expression';
import type { ComparisonBuilder, QueryBuilder } from 'blendsdk/expression';

interface Reading {
  value: number;
}

interface ComparisonCase {
  name: string;
  run: (builder: ComparisonBuilder<Reading, 'value'>) => QueryBuilder<Reading>;
  sql: string;
  params: Record<string, unknown>;
}

const comparisonCases: ComparisonCase[] = [
  { name: 'equals', run: (b) => b.equals(42), sql: 'value = :p1', params: { p1: 42 } },
  { name: 'notEquals', run: (b) => b.notEquals(42), sql: 'value <> :p1', params: { p1: 42 } },
  { name: 'greaterThan', run: (b) => b.greaterThan(42), sql: 'value > :p1', params: { p1: 42 } },
  { name: 'greaterThanOrEqual', run: (b) => b.greaterThanOrEqual(42), sql: 'value >= :p1', params: { p1: 42 } },
  { name: 'lessThan', run: (b) => b.lessThan(42), sql: 'value < :p1', params: { p1: 42 } },
  { name: 'lessThanOrEqual', run: (b) => b.lessThanOrEqual(42), sql: 'value <= :p1', params: { p1: 42 } },
];

describe('numeric comparison rendering', () => {
  it.each(comparisonCases)('$name renders "$sql"', ({ run, sql, params }) => {
    const result = run(query<Reading>().where('value')).compile();

    expect(result.sql).toBe(sql);
    expect(result.params).toEqual(params);
  });
});
```

### NULL, Undefined, and Value Serialization

Value normalization happens in the `ParameterManager` and is observable through `compile()`. The package's edge-case suite pins all of these behaviors — keep them covered:

```typescript
import { describe, it, expect } from 'vitest';
import { query } from 'blendsdk/expression';

describe('value normalization', () => {
  it('keeps IS NULL / IS NOT NULL parameter-free', () => {
    const result = query().where('deleted_at').isNull().and('email').isNotNull().compile();

    expect(result.sql).toBe('deleted_at IS NULL AND email IS NOT NULL');
    expect(result.params).toEqual({});
  });

  it('normalizes undefined to a null parameter', () => {
    const result = query().where('value').equals(undefined).compile();

    expect(result.sql).toBe('value = :p1');
    expect(result.params).toEqual({ p1: null });
  });

  it('serializes Date values to ISO-8601 strings', () => {
    const since = new Date('2024-01-01T00:00:00.000Z');
    const result = query().where('created_at').greaterThanOrEqual(since).compile();

    expect(result.sql).toBe('created_at >= :p1');
    expect(result.params).toEqual({ p1: '2024-01-01T00:00:00.000Z' });
  });

  it('preserves falsy primitives', () => {
    const result = query()
      .where('count').equals(0)
      .and('active').equals(false)
      .and('name').equals('')
      .compile();

    expect(result.sql).toBe('count = :p1 AND active = :p2 AND name = :p3');
    expect(result.params).toEqual({ p1: 0, p2: false, p3: '' });
  });

  it('passes quotes, backslashes, and unicode through untouched', () => {
    const result = query().where('name').equals("O'Brien\\José 日本語").compile();

    expect(result.sql).toBe('name = :p1');
    expect(result.params).toEqual({ p1: "O'Brien\\José 日本語" });
  });
});
```

Two behaviors worth documenting in test names: `equals(null)` and `equals(undefined)` still emit `= :pN` (normalized to a `null` parameter) — use `isNull()`/`isNotNull()` for SQL NULL semantics; and values are *never* inlined into SQL, so special characters need no escaping (that is the injection-safety guarantee under test). Untyped `query()` is convenient for these serialization cases where the schema would otherwise reject exotic value types.

### BETWEEN, IN, and NOT IN

Multi-parameter operators deserve explicit coverage, including the hazardous empty-array case:

```typescript
import { describe, it, expect } from 'vitest';
import { query } from 'blendsdk/expression';

describe('range and set comparisons', () => {
  it('binds both BETWEEN bounds', () => {
    const result = query().where('age').between(18, 65).compile();

    expect(result.sql).toBe('age BETWEEN :p1 AND :p2');
    expect(result.params).toEqual({ p1: 18, p2: 65 });
  });

  it('binds every IN element sequentially', () => {
    const result = query().where('status').in(['active', 'pending']).compile();

    expect(result.sql).toBe('status IN (:p1, :p2)');
    expect(result.params).toEqual({ p1: 'active', p2: 'pending' });
  });

  it('renders an empty IN list without parameters', () => {
    const result = query().where('status').in([]).compile();

    expect(result.sql).toBe('status IN ()');
    expect(result.params).toEqual({});
  });

  it('renders NOT IN', () => {
    const result = query().where('status').notIn(['banned']).compile();

    expect(result.sql).toBe('status NOT IN (:p1)');
    expect(result.params).toEqual({ p1: 'banned' });
  });
});
```

Document in the empty-array test why it matters: PostgreSQL rejects `IN ()` at parse time, so application code must skip the condition when the array is empty — the test pins the package behavior so a future change is caught, and your own filter code gets its own empty-array test.

### LIKE and Pattern Helpers

`startsWith`, `endsWith`, and `contains` are sugar that inject wildcards and delegate to `like` — assert the wildcard rewriting, not just the operator:

```typescript
import { describe, it, expect } from 'vitest';
import { query } from 'blendsdk/expression';

describe('pattern helpers', () => {
  it('rewrites startsWith, endsWith, and contains into LIKE patterns', () => {
    const result = query()
      .where('name').startsWith('Jo')
      .and('name').endsWith('hn')
      .and('bio').contains('sql')
      .compile();

    expect(result.sql).toBe('name LIKE :p1 AND name LIKE :p2 AND bio LIKE :p3');
    expect(result.params).toEqual({ p1: 'Jo%', p2: '%hn', p3: '%sql%' });
  });

  it('keeps raw like patterns verbatim', () => {
    const result = query().where('email').like('%@gmail.com').compile();

    expect(result.sql).toBe('email LIKE :p1');
    expect(result.params).toEqual({ p1: '%@gmail.com' });
  });

  it('renders ILIKE for case-insensitive matches', () => {
    const result = query().where('name').ilike('%ada%').compile();

    expect(result.sql).toBe('name ILIKE :p1');
    expect(result.params).toEqual({ p1: '%ada%' });
  });
});
```

### Logical Composition and Grouping

Grouping tests pin three things: parentheses from callback groups, sequential placeholder numbering across nested builders, and the "empty group contributes nothing" rule:

```typescript
import { describe, it, expect } from 'vitest';
import { query } from 'blendsdk/expression';

describe('logical composition', () => {
  it('combines AND and OR chains', () => {
    const result = query()
      .where('status').equals('active')
      .or('role').equals('moderator')
      .compile();

    expect(result.sql).toBe('status = :p1 OR role = :p2');
    expect(result.params).toEqual({ p1: 'active', p2: 'moderator' });
  });

  it('wraps callback groups in parentheses', () => {
    const result = query()
      .where('status').equals('active')
      .and((group) => group.where('age').greaterThan(21).or('verified').equals(true))
      .compile();

    expect(result.sql).toBe('status = :p1 AND (age > :p2 OR verified = :p3)');
    expect(result.params).toEqual({ p1: 'active', p2: 21, p3: true });
  });

  it('keeps placeholder numbering sequential across nested groups', () => {
    const result = query()
      .where('a').equals(1)
      .and((outer) =>
        outer
          .where('b').equals(2)
          .or((inner) => inner.where('c').equals(3).and('d').equals(4))
      )
      .compile();

    expect(result.sql).toBe('a = :p1 AND (b = :p2 OR (c = :p3 AND d = :p4))');
    expect(result.params).toEqual({ p1: 1, p2: 2, p3: 3, p4: 4 });
  });

  it('ignores empty callback groups', () => {
    const result = query().where('a').equals(1).and((group) => group).compile();

    expect(result.sql).toBe('a = :p1');
    expect(result.params).toEqual({ p1: 1 });
  });
});
```

The placeholder-numbering test is the most valuable one here: nested builders share the parent's `ParameterManager`, and that continuity is what makes grouped filters safe to execute.

### Type-Safe Schemas

Runtime behavior is identical for typed and untyped builders; the schema's real value is compile-time rejection. Prove it with `@ts-expect-error`, and run `tsc --noEmit` in CI so these lines have teeth (Vitest alone does not type-check test files):

```typescript
import { describe, it, expect } from 'vitest';
import { query } from 'blendsdk/expression';
import type { User } from './fixtures/schemas.js';

describe('type-safe filtering', () => {
  it('compiles typed columns and values', () => {
    const result = query<User>()
      .where('status').equals('active')
      .and('age').greaterThanOrEqual(18)
      .and('verified').equals(true)
      .compile();

    expect(result.sql).toBe('status = :p1 AND age >= :p2 AND verified = :p3');
    expect(result.params).toEqual({ p1: 'active', p2: 18, p3: true });
  });

  it('rejects unknown columns at compile time', () => {
    // @ts-expect-error - 'unknown_column' is not a key of User
    query<User>().where('unknown_column').equals('x');
  });

  it('rejects mismatched value types at compile time', () => {
    // @ts-expect-error - User['age'] is number, not string
    query<User>().where('age').equals('eighteen');
  });
});
```

### JSON/JSONB Operations

Each JSON operator maps to a PostgreSQL operator string; a case table covers all six, including the array-parameter variants:

```typescript
import { describe, it, expect } from 'vitest';
import { query } from 'blendsdk/expression';
import type { ComparisonBuilder, QueryBuilder } from 'blendsdk/expression';

interface Document {
  data: Record<string, unknown>;
}

interface JsonCase {
  name: string;
  run: (builder: ComparisonBuilder<Document, 'data'>) => QueryBuilder<Document>;
  sql: string;
  params: Record<string, unknown>;
}

const jsonCases: JsonCase[] = [
  { name: 'jsonContains', run: (b) => b.jsonContains({ role: 'admin' }), sql: 'data @> :p1', params: { p1: { role: 'admin' } } },
  { name: 'jsonContainedBy', run: (b) => b.jsonContainedBy({ role: 'admin' }), sql: 'data <@ :p1', params: { p1: { role: 'admin' } } },
  { name: 'jsonHasKey', run: (b) => b.jsonHasKey('role'), sql: 'data ? :p1', params: { p1: 'role' } },
  { name: 'jsonHasAnyKey', run: (b) => b.jsonHasAnyKey(['role', 'plan']), sql: 'data ?| :p1', params: { p1: ['role', 'plan'] } },
  { name: 'jsonHasAllKeys', run: (b) => b.jsonHasAllKeys(['role', 'plan']), sql: 'data ?& :p1', params: { p1: ['role', 'plan'] } },
  { name: 'jsonPathExists', run: (b) => b.jsonPathExists('$.role'), sql: 'data @? :p1', params: { p1: '$.role' } },
];

describe('JSONB operators', () => {
  it.each(jsonCases)('$name renders "$sql"', ({ run, sql, params }) => {
    const result = run(query<Document>().where('data')).compile();

    expect(result.sql).toBe(sql);
    expect(result.params).toEqual(params);
  });
});
```

Note that objects and arrays are stored in `params` as-is (the database driver serializes them) — `toEqual` deep-compares them correctly, so no stringification is needed in assertions.

### Full-Text Search

Search tests pin three dimensions: the mode's tsquery function, multi-column concatenation, and the embedded language:

```typescript
import { describe, it, expect } from 'vitest';
import { query } from 'blendsdk/expression';
import type { Post } from './fixtures/schemas.js';

describe.each([
  { mode: 'plain', tsquery: 'plainto_tsquery' },
  { mode: 'phrase', tsquery: 'phraseto_tsquery' },
  { mode: 'websearch', tsquery: 'websearch_to_tsquery' },
] as const)('search mode $mode', ({ mode, tsquery }) => {
  it(`renders ${tsquery}`, () => {
    const result = query<Post>().where('title').search('sql builder', { mode }).compile();

    expect(result.sql).toBe(`to_tsvector('english', title) @@ ${tsquery}('english', :p1)`);
    expect(result.params).toEqual({ p1: 'sql builder' });
  });
});

describe('full-text search composition', () => {
  it('concatenates multiple columns and ANDs the condition', () => {
    const result = query<Post>()
      .where('author_id').equals(7)
      .search(['title', 'body'], 'typescript generics', { mode: 'websearch' })
      .compile();

    expect(result.sql).toBe(
      "author_id = :p1 AND to_tsvector('english', title || ' ' || body) @@ websearch_to_tsquery('english', :p2)"
    );
    expect(result.params).toEqual({ p1: 7, p2: 'typescript generics' });
  });

  it('embeds the configured language in the SQL', () => {
    const result = query<Post>()
      .where('title')
      .search('bonjour', { language: 'french' })
      .compile();

    expect(result.sql).toBe("to_tsvector('french', title) @@ plainto_tsquery('french', :p1)");
    expect(result.params).toEqual({ p1: 'bonjour' });
  });
});
```

### Subqueries

Subquery behavior worth pinning: existence vs. membership rendering, the empty-subquery error, and parameter scope — subquery values do **not** appear in the parent's `params`:

```typescript
import { describe, it, expect } from 'vitest';
import { query } from 'blendsdk/expression';

interface Customer {
  id: number;
  name: string;
}

interface Order {
  id: number;
  customer_id: number;
  total: number;
}

describe('subqueries', () => {
  it('renders EXISTS with a correlated column reference', () => {
    const correlated = query<Order>().where('customer_id').equalsColumn('customers.id');
    const result = query<Customer>().where('id').exists(correlated).compile();

    expect(result.sql).toBe('EXISTS (SELECT 1 WHERE customer_id = customers.id)');
    expect(result.params).toEqual({});
  });

  it('throws when the subquery has no conditions', () => {
    const emptySubquery = query<Order>();

    expect(() => query<Customer>().where('id').exists(emptySubquery)).toThrowError(
      'Subquery must have at least one condition'
    );
  });

  it('keeps subquery parameters out of the parent result', () => {
    const recurring = query<Order>().where('total').greaterThan(100);
    const parent = query<Customer>().where('id').inSubquery(recurring);

    const parentResult = parent.compile();
    const subqueryResult = recurring.compile();

    expect(parentResult.sql).toBe('id IN (SELECT * WHERE total > :p1)');
    expect(parentResult.params).toEqual({});
    expect(subqueryResult.params).toEqual({ p1: 100 });
  });
});
```

The last test documents an execution hazard: the parent SQL references `:p1` but the value lives in the subquery's own `CompileResult`. When you execute such SQL, compile both builders and bind both parameter maps — and beware that each builder numbers independently from `p1`, so merge with remapping when both sides bind values.

Rendered forms for reference (all four accept any non-empty `QueryBuilder`):

| Method | Rendered SQL | Parent `params` contains |
|---|---|---|
| `exists(sub)` | `EXISTS (SELECT 1 WHERE <predicate>)` | Only parent-side values |
| `notExists(sub)` | `NOT EXISTS (SELECT 1 WHERE <predicate>)` | Only parent-side values |
| `inSubquery(sub)` | `column IN (SELECT * WHERE <predicate>)` | Only parent-side values |
| `notInSubquery(sub)` | `column NOT IN (SELECT * WHERE <predicate>)` | Only parent-side values |
| `equalsColumn(col)` | `column = <col>` — no parameter created | Nothing (column references are inlined) |

### Debug Mode and Diagnostics

Debug assertions cover presence/absence, the diagnostics payload, and the empty-query warning — but never exact timings:

```typescript
import { describe, it, expect } from 'vitest';
import { query } from 'blendsdk/expression';

describe('debug mode', () => {
  it('attaches diagnostics when enabled via options', () => {
    const result = query({ debug: true }).where('status').equals('active').compile();

    expect(result.debug).toBeDefined();
    expect(result.debug?.ast).toBeDefined();
    expect(result.debug?.parameterCount).toBe(1);
    expect(result.debug?.optimizations).toEqual([]);
    expect(result.debug?.warnings).toEqual([]);
    expect(result.debug?.compilationTime).toBeGreaterThanOrEqual(0);
  });

  it('enables diagnostics via the debug() method', () => {
    const result = query().where('status').equals('active').debug().compile();

    expect(result.debug?.parameterCount).toBe(1);
  });

  it('omits diagnostics by default', () => {
    const result = query().where('status').equals('active').compile();

    expect(result.debug).toBeUndefined();
  });

  it('flags empty queries with a warning', () => {
    const result = query({ debug: true }).compile();

    expect(result.sql).toBe('');
    expect(result.params).toEqual({});
    expect(result.debug?.parameterCount).toBe(0);
    expect(result.debug?.warnings).toEqual(['No conditions specified']);
  });
});
```

### AST Inspection

Traverse the tree with your own narrowing helpers; never assert generated ids. This fragment shows the right (stable) and wrong (order-dependent) assertions side by side:

```typescript
// ✅ Stable: structural assertions
const node = asComparisonNode(ast);
expect(node.type).toBe(ASTNodeType.Comparison);
expect(node.column).toBe('status');

// ❌ Order-dependent: node ids come from a worker-wide counter
// expect(node.id).toBe('node_1');
```

Full traversal test:

```typescript
import { describe, it, expect } from 'vitest';
import { ASTNodeType, ComparisonOperator, LogicalOperator, query } from 'blendsdk/expression';
import { asComparisonNode, asLogicalNode } from './helpers/expression.js';

describe('AST structure', () => {
  it('creates a logical node for AND chains', () => {
    const root = asLogicalNode(
      query().where('status').equals('active').and('age').greaterThan(18).getAST()
    );

    expect(root.operator).toBe(LogicalOperator.And);
    expect(asComparisonNode(root.left).column).toBe('status');
    expect(asComparisonNode(root.right).operator).toBe(ComparisonOperator.GreaterThan);
  });

  it('wraps callback groups in a group node', () => {
    const ast = query()
      .where('status').equals('active')
      .or((group) => group.where('age').greaterThan(65).and('verified').equals(true))
      .getAST();

    const root = asLogicalNode(ast);

    expect(root.operator).toBe(LogicalOperator.Or);
    expect(root.right.type).toBe(ASTNodeType.Group);
  });

  it('generates ids in a predictable shape', () => {
    const node = asComparisonNode(query().where('status').equals('active').getAST());

    expect(node.id).toMatch(/^node_\d+$/);
  });
});
```

### Dialects and Errors

PostgreSQL is the default and the only implemented dialect; the other `SqlDialect` members throw at compile time. A case table pins each message:

```typescript
import { describe, it, expect } from 'vitest';
import { SqlDialect, query } from 'blendsdk/expression';

describe.each([
  { dialect: SqlDialect.MySQL, name: 'mysql' },
  { dialect: SqlDialect.MSSQL, name: 'mssql' },
  { dialect: SqlDialect.SQLite, name: 'sqlite' },
] as const)('$name dialect', ({ dialect, name }) => {
  it('fails fast at compile time', () => {
    expect(() => query({ dialect }).where('id').equals(1).compile()).toThrowError(
      `Dialect ${name} is not yet implemented`
    );
  });
});

describe('PostgreSQL (default)', () => {
  it('compiles without an explicit dialect option', () => {
    const result = query().where('id').equals(1).compile();

    expect(result.sql).toBe('id = :p1');
    expect(result.params).toEqual({ p1: 1 });
  });
});
```

### ParameterManager Directly

When you use the utilities standalone (custom compilers, tooling), test them directly. Create a fresh manager per test:

```typescript
import { describe, it, expect } from 'vitest';
import { ParameterManager, SqlDialect } from 'blendsdk/expression';

describe('ParameterManager', () => {
  it('generates sequential names and serialized values', () => {
    const manager = new ParameterManager(SqlDialect.PostgreSQL);

    const first = manager.addParameterWithValue('active');
    const second = manager.addParameterWithValue(new Date('2024-01-01T00:00:00.000Z'));
    const third = manager.addParameterWithValue(undefined);

    expect(first).toBe('p1');
    expect(second).toBe('p2');
    expect(third).toBe('p3');
    expect(manager.getParameterCount()).toBe(3);
    expect(manager.getParameters()).toEqual({
      p1: 'active',
      p2: '2024-01-01T00:00:00.000Z',
      p3: null,
    });
  });

  it('formats placeholders per dialect', () => {
    const postgres = new ParameterManager(SqlDialect.PostgreSQL);
    const mysql = new ParameterManager(SqlDialect.MySQL);
    const mssql = new ParameterManager(SqlDialect.MSSQL);

    expect(postgres.formatParameterPlaceholder('p1')).toBe(':p1');
    expect(mysql.formatParameterPlaceholder('p1')).toBe('?');
    expect(mssql.formatParameterPlaceholder('p1')).toBe('@p1');
  });

  it('resets counters and values', () => {
    const manager = new ParameterManager();

    manager.addParameterWithValue('first');
    manager.reset();

    expect(manager.getParameterCount()).toBe(0);
    expect(manager.getParameters()).toEqual({});
    expect(manager.addParameterWithValue('second')).toBe('p1');
  });

  it('clones independently of the original', () => {
    const manager = new ParameterManager();
    manager.addParameterWithValue('first');

    const clone = manager.clone();
    clone.addParameterWithValue('second');

    expect(manager.getParameterCount()).toBe(1);
    expect(clone.getParameterCount()).toBe(2);
  });

  it('deduplicates by serialized value', () => {
    const manager = new ParameterManager();
    manager.addParameterWithValue({ role: 'admin' });

    expect(manager.deduplicateParameter({ role: 'admin' })).toBe('p1');
    expect(manager.deduplicateParameter({ role: 'user' })).toBeNull();
  });
});
```

### Branching with `clone()`

`clone()` lives on the concrete `QueryBuilderImpl` class (it is not part of the `QueryBuilder` interface) and has a deliberate quirk: the clone shares the AST reference but gets a fresh parameter manager. Pin both halves of that contract:

```typescript
import { describe, it, expect } from 'vitest';
import { QueryBuilderImpl } from 'blendsdk/expression';

describe('clone()', () => {
  it('returns a distinct builder with the same AST but a fresh parameter map', () => {
    const builder = new QueryBuilderImpl();
    builder.where('status').equals('active');

    const cloned = builder.clone();

    expect(cloned).not.toBe(builder);
    expect(cloned.compile().sql).toBe('status = :p1');
    // The clone has its own ParameterManager: values bound on the
    // original are not registered on the clone.
    expect(cloned.compile().params).toEqual({});
    expect(builder.compile().params).toEqual({ p1: 'active' });
  });
});
```

For fully independent builders, prefer creating a new `query()` — reserve `clone()` for branching variations where you compile the original for parameters.

---

# expression Troubleshooting

---

Most problems with `blendsdk/expression` fall into four buckets: errors thrown by `compile()` (unsupported dialects, empty subqueries), TypeScript errors caused by the two-stage fluent API, database errors caused by fragments that are syntactically valid JavaScript but invalid SQL, and silent behavioral traps (conditions being replaced, `NULL` semantics, parameter collisions). This document lists each group with the exact message, an explanation of the cause, and a verified fix — followed by debugging procedures and the pitfalls that are easiest to miss.

---

## Common Errors

### Errors Thrown by `compile()`

#### `Error: Dialect mysql is not yet implemented`

**Error**

```text
Error: Dialect mysql is not yet implemented
```

Thrown by `.compile()` — with `mssql` or `sqlite` in place of `mysql` when those dialects are selected.

**Cause**

`QueryBuilderImpl.compile()` switches on `SqlDialect`. Only `SqlDialect.PostgreSQL` has a compiler implementation (`PostgreSQLCompiler`); the `MySQL`, `MSSQL`, and `SQLite` enum members exist for forward compatibility but throw in their `case` branch. Note that the dialect check runs only when the AST is non-empty — an empty query returns `{ sql: '', params: {} }` before the dialect is examined, so the error surfaces the moment you add your first condition.

**Fix**

1. Omit the `dialect` option (PostgreSQL is the default) or set it explicitly to `SqlDialect.PostgreSQL`.
2. If you genuinely target another database, this package cannot render its predicate in version 5.x — generate the SQL with a supported toolchain instead.

```typescript
import { query, SqlDialect } from 'blendsdk/expression';

// ✅ PostgreSQL is fully supported — and is the default when no dialect is passed
const result = query({ dialect: SqlDialect.PostgreSQL })
  .where('status').equals('active')
  .compile();

console.log(result.sql);
// status = :p1

console.log(result.params);
// { p1: 'active' }
```

#### `Error: Unknown dialect: <value>`

**Error**

```text
Error: Unknown dialect: pg
```

**Cause**

The `dialect` option received a truthy value that is not a member of `SqlDialect` — typically from an `as SqlDialect` cast or a raw string read from configuration or environment variables. The falsy fallback (`options.dialect || SqlDialect.PostgreSQL`) protects against `undefined` and `''`, but not against strings like `'pg'` or `'postgres'`.

**Fix**

1. Never cast strings to `SqlDialect`.
2. Validate configuration values and map them to enum members before constructing the builder.

```typescript
import { query, SqlDialect } from 'blendsdk/expression';

function parseDialect(value: string): SqlDialect {
  if (value === SqlDialect.PostgreSQL) {
    return SqlDialect.PostgreSQL;
  }
  throw new Error(`Unsupported dialect value: ${value}`);
}

const result = query({ dialect: parseDialect(process.env.SQL_DIALECT ?? 'postgresql') })
  .where('status').equals('active')
  .compile();

console.log(result.sql);
// status = :p1
```

---

### Subquery Errors

#### `Error: Subquery must have at least one condition`

**Error**

```text
Error: Subquery must have at least one condition
```

**Cause**

`exists`, `notExists`, `inSubquery`, and `notInSubquery` call `subquery.getAST()` and throw when it returns `null` — meaning the passed builder never recorded a condition. Besides passing a freshly created builder, this also happens when the subquery's only condition was silently dropped by a duplicate `.where()` call (see [Pitfall 1](#1-a-second-where-silently-replaces-the-first-condition)).

**Fix**

1. Verify the subquery has a non-null AST before wiring it into the parent.
2. Build the subquery in the calling code where you can guarantee at least one condition was added.

```typescript
import { query } from 'blendsdk/expression';

interface Order {
  id: number;
  customer_id: number;
}

const empty = query<Order>();

if (empty.getAST() === null) {
  console.warn('Subquery builder has no conditions yet.');
}

const correlated = query<Order>()
  .where('customer_id').equalsColumn('customers.id');

const { sql } = query<Order>()
  .where('id').exists(correlated)
  .compile();

console.log(sql);
// EXISTS (SELECT 1 WHERE customer_id = customers.id)
```

---

### Errors From Hand-Built or Modified ASTs

#### `Error: Unknown node type: <type>` — and other compiler guard errors

**Error**

| Message | Thrown when |
|---|---|
| `Unknown node type: ${type}` | `compileNode()` encounters a node whose `type` is not one of the six `ASTNodeType` members. |
| `LIKE operator requires a parameter` | A `LIKE`/`ILIKE` comparison node has no `parameterNames`. |
| `BETWEEN operator requires two parameters` | A `BETWEEN`/`NOT BETWEEN` node does not carry exactly two parameter names. |
| `Unknown comparison operator: ${operator}` | A comparison node uses an operator outside `ComparisonOperator`. |
| `JSON operation requires a parameter` | A JSON node has no `parameterName`. |
| `Unknown JSON operator: ${operator}` | A JSON node uses an operator outside `JsonOperator`. |
| `IN subquery requires a column` / `NOT IN subquery requires a column` | An `IN`/`NOT IN` subquery node has no `column`. |
| `Unknown subquery operator: ${operator}` | A subquery node's `operator` is none of `EXISTS`, `NOT EXISTS`, `IN`, `NOT IN`. |

**Cause**

All of these are defensive checks inside `PostgreSQLCompiler`. The fluent builders always produce well-formed nodes — `between()` registers exactly two parameters, `like()` always passes a pattern, subquery methods always set a column for `IN` — so seeing these errors means an AST was hand-built, spread-copied, or otherwise modified before being passed to `new PostgreSQLCompiler(...).compile(ast)`. The internal node factories and type guards are not exported, so it is not possible to build valid nodes from outside the package.

**Fix**

1. Only compile ASTs obtained from a builder's `getAST()` — never construct or mutate nodes yourself.
2. Guard against `null` before rendering.

```typescript
import {
  ParameterManager,
  PostgreSQLCompiler,
  SqlDialect,
  query,
} from 'blendsdk/expression';
import type { ASTNode } from 'blendsdk/expression';

const builder = query().where('age').between(18, 65);

const ast: ASTNode | null = builder.getAST();
if (ast === null) {
  throw new Error('Nothing to compile — add at least one condition.');
}

// ✅ Compile the AST the builder produced — it always has two BETWEEN parameters
const compiler = new PostgreSQLCompiler(new ParameterManager(SqlDialect.PostgreSQL));

console.log(compiler.compile(ast));
// age BETWEEN :p1 AND :p2

console.log(builder.compile().params);
// { p1: 18, p2: 65 }
```

---

### TypeScript Compiler Errors

These appear in the editor or build output, before any SQL runs. Most are the type system protecting you from the two-stage fluent API.

#### `Property 'and' does not exist on type 'ComparisonBuilder<User, "status">'` (TS2339)

**Error**

```text
Property 'and' does not exist on type 'ComparisonBuilder<User, "status">'.
```

**Cause**

The fluent API alternates stages: `where`/`and`/`or` with a column return a `ComparisonBuilder`, which only exposes terminal operations (`equals`, `in`, `isNull`, …). You must complete the comparison before starting another condition. Chaining `.and('age')` directly after `.where('status')` targets the wrong stage.

**Fix**

1. Finish the comparison first — `equals`, `greaterThan`, `isNull`, etc. — which returns the `QueryBuilder`.
2. Continue with `and`/`or` from the `QueryBuilder` stage.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  status: string;
  age: number;
}

// ❌ TS2339: Property 'and' does not exist on type 'ComparisonBuilder<User, "status">'.
// query<User>().where('status').and('age');

// ✅ Complete the comparison, then continue from the QueryBuilder
const { sql, params } = query<User>()
  .where('status').equals('active')
  .and('age').greaterThan(18)
  .compile();

console.log(sql);
// status = :p1 AND age > :p2

console.log(params);
// { p1: 'active', p2: 18 }
```

#### `Argument of type '"sttaus"' is not assignable to parameter of type '"id" | "email" | "status" | "age"'` (TS2345)

**Error**

```text
Argument of type '"sttaus"' is not assignable to parameter of type '"id" | "email" | "status" | "age"'.
```

**Cause**

`query<User>()` constrains column arguments to `keyof User`. A typo is rejected at compile time. Without a schema type parameter, `query()` falls back to `Record<string, any>` and any string is accepted — the typo then fails at the database with `column "sttaus" does not exist`.

**Fix**

1. Always type the builder with your schema: `query<User>()`.
2. For columns selected dynamically (config, query strings), narrow with a type guard before passing them in.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  email: string;
  status: string;
  age: number;
}

const USER_COLUMNS = ['id', 'email', 'status', 'age'] as const;

function isUserColumn(value: string): value is keyof User {
  return (USER_COLUMNS as readonly string[]).includes(value);
}

const requested = 'status';

if (!isUserColumn(requested)) {
  throw new Error(`Unknown column: ${requested}`);
}

const { sql } = query<User>()
  .where(requested).equals('active')
  .compile();

console.log(sql);
// status = :p1
```

#### `Argument of type 'number' is not assignable to parameter of type 'string'` (TS2345)

**Error**

```text
Argument of type 'number' is not assignable to parameter of type 'string'.
```

**Cause**

Comparison methods type their value argument as `TSchema[K]` — the column's declared type. `where('email').equals(123)` is rejected because `email: string`. (Two exceptions: `like`/`ilike` always take `string` regardless of column type, and the JSON methods take an untyped value.)

**Fix**

1. Convert or parse input at the boundary — where the data enters your application — rather than loosening the schema.
2. Pass the properly typed value to the comparison.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  email: string;
}

function parseUserId(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid user id: ${value}`);
  }
  return parsed;
}

const { sql, params } = query<User>()
  .where('id').equals(parseUserId('42'))
  .compile();

console.log(sql);
// id = :p1

console.log(params);
// { p1: 42 }
```

#### `No overload matches this call` (TS2769)

**Error**

```text
No overload matches this call.
```

**Cause**

Group callbacks passed to `where`/`and`/`or` must **return** the `QueryBuilder` whose AST becomes the group's contents. Two common mistakes trigger this error:

1. A block-bodied callback without a `return` — the callback returns `void`.
2. A callback whose last call is a column without a terminal method — it returns `ComparisonBuilder<...>`, not `QueryBuilder<...>`.

**Fix**

1. Use an expression-bodied arrow (implicit return), or add an explicit `return` to the block body.
2. Make sure the returned chain ends with a terminal comparison.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  status: string;
  age: number;
}

// ❌ TS2769: the callback returns void — the builder is never returned
// query<User>().and(q => { q.where('age').greaterThan(21); });

const { sql, params } = query<User>()
  .where('status').equals('active')
  .and(q => {
    return q
      .where('age').greaterThan(21)
      .or('status').equals('pending');
  })
  .compile();

console.log(sql);
// status = :p1 AND (age > :p2 OR status = :p3)

console.log(params);
// { p1: 'active', p2: 21, p3: 'pending' }
```

#### `Expected 2-3 arguments, but got 1` (TS2554)

**Error**

```text
Expected 2-3 arguments, but got 1.
```

**Cause**

`search()` exists in two places with different signatures. On `QueryBuilder` it is `search(columns, query, options?)` — the column list is mandatory. The single-argument form `search(query, options?)` exists only on `ComparisonBuilder`, where the column is already bound. Writing `query().search('term')` targets the wrong stage.

**Fix**

1. For a single column, call `search()` on the comparison builder: `.where('column').search('term')`.
2. For multiple columns, call `search()` on the query builder and pass the column list first.

```typescript
import { query } from 'blendsdk/expression';

interface Article {
  id: number;
  title: string;
  body: string;
}

// Single column → comparison-builder form
const single = query<Article>()
  .where('body').search('typescript')
  .compile();

console.log(single.sql);
// to_tsvector('english', body) @@ plainto_tsquery('english', :p1)

// Multiple columns → query-builder form (columns first)
const multi = query<Article>()
  .search(['title', 'body'], 'typescript')
  .compile();

console.log(multi.sql);
// to_tsvector('english', title || ' ' || body) @@ plainto_tsquery('english', :p1)
```

#### `Property 'clone' does not exist on type 'QueryBuilder<User>'` (TS2339)

**Error**

```text
Property 'clone' does not exist on type 'QueryBuilder<User>'.
```

**Cause**

`clone()` is declared on the `QueryBuilderImpl` class only, not on the `QueryBuilder` interface. The `query()` factory returns the interface type, so `clone()` is invisible on builders obtained from it. (And as described in [Pitfall 3](#3-clone-shares-the-ast-but-not-the-parameter-manager), cloning has sharp edges — prefer rebuilding.)

**Fix**

1. If you truly need `clone()`, hold a `QueryBuilderImpl` reference — `new QueryBuilderImpl<User>()`.
2. For independent copies, build a fresh query instead; a factory function is usually the cleanest pattern.

```typescript
import { QueryBuilderImpl, query } from 'blendsdk/expression';
import type { QueryBuilder } from 'blendsdk/expression';

interface User {
  id: number;
  status: string;
  age: number;
}

// clone() is visible because the variable is typed as QueryBuilderImpl
const builder = new QueryBuilderImpl<User>();
builder.where('status').equals('active');

const cloned = builder.clone();
console.log(cloned.getAST() !== null);
// true

// ✅ For independent builders, use a factory function instead of clone()
function baseQuery(): QueryBuilder<User> {
  return query<User>().where('status').equals('active');
}

console.log(baseQuery().and('age').greaterThanOrEqual(18).compile().sql);
// status = :p1 AND age >= :p2
```

#### `'result.debug' is possibly 'undefined'` (TS18048)

**Error**

```text
'result.debug' is possibly 'undefined'.
```

**Cause**

Under `strictNullChecks`, `CompileResult.debug` is optional (`DebugInfo | undefined`) and `getAST()` returns `ASTNode | null`. Direct property access is rejected.

**Fix**

1. Use optional chaining (`result.debug?.…`) for the debug payload.
2. Narrow nullable AST values with an explicit `!== null` check before use.

```typescript
import { query } from 'blendsdk/expression';

const result = query({ debug: true })
  .where('status').equals('active')
  .compile();

// ✅ Optional chaining for the optional debug payload
console.log(result.debug?.parameterCount);
// 1

// ✅ Explicit narrowing for the nullable AST
const ast = query().where('status').equals('active').getAST();
if (ast !== null) {
  console.log(ast.type);
  // comparison
}
```

#### `Module '"blendsdk/expression"' has no exported member 'createComparisonNode'` (TS2305)

**Error**

```text
Module '"blendsdk/expression"' has no exported member 'createComparisonNode'.
```

**Cause**

The node factories (`createComparisonNode`, `createLogicalNode`, …), the type guards (`isComparisonNode`, …), and `resetNodeIdCounter` are internal. The package root does not re-export them, and the `exports` map blocks deep paths — attempting `import … from 'blendsdk/expression/dist/index.js'` fails with `Cannot find module … or its corresponding type declarations.` (TS2307) and, at runtime, `ERR_PACKAGE_PATH_NOT_EXPORTED`.

**Fix**

1. Import only symbols listed in the public API.
2. To inspect structure, switch on `node.type` with the exported `ASTNodeType` enum and annotate with the exported node interfaces.

```typescript
import { ASTNodeType, ComparisonOperator, query } from 'blendsdk/expression';
import type { ASTNode, ComparisonNode } from 'blendsdk/expression';

const ast: ASTNode | null = query().where('status').equals('active').getAST();

if (ast !== null && ast.type === ASTNodeType.Comparison) {
  const comparison = ast as ComparisonNode;
  console.log(comparison.operator === ComparisonOperator.Equal);
  // true
}
```

---

### Database Errors From the Generated SQL

The predicate produced by `compile()` is a fragment — it excludes the `WHERE` keyword and is executed by your database driver, not by this package. The errors below come back from PostgreSQL after you run the SQL. Message text varies slightly by PostgreSQL version.

#### `ERROR: syntax error at or near ")"` — empty `IN ()`

**Symptom**

```typescript
import { query } from 'blendsdk/expression';

const { sql, params } = query().where('status').in([]).compile();

console.log(sql);
// status IN ()

console.log(params);
// {}
```

Executing this fragment produces `ERROR: syntax error at or near ")"`.

**Cause**

The compiler renders an empty parameter list literally as `column IN ()`. PostgreSQL's grammar requires at least one expression inside the parentheses, so the fragment compiles fine in JavaScript but fails at the database. The same applies to `notIn([])`.

**Fix**

1. Never emit an `IN` condition for an empty array.
2. Guard the call site — either with an `if` before adding the condition, or by branching on the array length.

```typescript
import { query } from 'blendsdk/expression';
import type { CompileResult } from 'blendsdk/expression';

interface Product {
  id: number;
  status: string;
}

function buildProductQuery(statuses: string[]): CompileResult {
  const builder = query<Product>().where('id').greaterThan(0);

  // ✅ Only emit IN when there is at least one value
  if (statuses.length > 0) {
    builder.and('status').in(statuses);
  }

  return builder.compile();
}

console.log(buildProductQuery([]).sql);
// id > :p1

console.log(buildProductQuery(['active', 'pending']).sql);
// id > :p1 AND status IN (:p2, :p3)
```

#### `ERROR: syntax error at or near ";"` — empty predicate appended after `WHERE`

**Symptom**

```typescript
import { query } from 'blendsdk/expression';

const { sql } = query().compile();
console.log(`SELECT * FROM users WHERE ${sql};`);
// SELECT * FROM users WHERE ;
```

**Cause**

When no conditions were recorded, `compile()` returns `{ sql: '', params: {} }`. Concatenating the empty fragment leaves a dangling `WHERE`. A related trap is appending `WHERE` yourself when the fragment is non-empty — the fragment never contains the keyword.

**Fix**

1. Check `sql.length` (or `result.debug?.warnings.includes('No conditions specified')` in debug mode) before composing the statement.
2. Only add the `WHERE` keyword when a predicate exists.

```typescript
import { query } from 'blendsdk/expression';
import type { CompileResult } from 'blendsdk/expression';

function buildStatement(result: CompileResult): string {
  return result.sql.length > 0
    ? `SELECT * FROM users WHERE ${result.sql}`
    : 'SELECT * FROM users';
}

console.log(buildStatement(query().compile()));
// SELECT * FROM users

console.log(buildStatement(query().where('status').equals('active').compile()));
// SELECT * FROM users WHERE status = :p1
```

#### `ERROR: column "<name>" does not exist`

**Symptom**

```text
ERROR: column "sttaus" does not exist
```

**Cause**

The builder emits column names verbatim. If you used an untyped `query()` (no schema type parameter), the TypeScript compiler had no way to reject the typo. If the schema types no longer match the physical table (schema drift), even a correctly typed builder emits a name the database does not know.

**Fix**

1. Type every builder with a schema interface — `query<User>()` turns column typos into TS2345 errors at build time.
2. Keep the interface aligned with the actual table; consider generating schema types from the database (for example with `blendsdk/codegen`).
3. When a runtime error still occurs, compare the emitted column names in `result.sql` against the real table definition.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  status: string;
}

// ✅ query<User>() validates 'status' at compile time
const { sql } = query<User>().where('status').equals('active').compile();

console.log(sql);
// status = :p1
```

#### `ERROR: text search configuration "<name>" does not exist`

**Symptom**

```text
ERROR: text search configuration "englsh" does not exist
```

**Cause**

The `language` option of `search()` is embedded into the generated SQL as a string literal for `to_tsvector` and `to_tsquery`. A typo, an uninstalled configuration, or an empty/misspelled value fails at execution — and because the value is interpolated rather than parameterized, a user-controlled value is also an injection vector (see [Pitfall 5](#5-search-language-and-equalscolumn-interpolate-raw-strings)).

**Fix**

1. Use a fixed, vetted language identifier such as `'english'`.
2. Validate any externally supplied value against a whitelist before it reaches `search()`.
3. Verify the configuration exists in the database with `SELECT to_tsvector('english', 'test');`.

```typescript
import { query } from 'blendsdk/expression';

const { sql } = query()
  .where('content').search('typescript', { language: 'english' })
  .compile();

console.log(sql);
// to_tsvector('english', content) @@ plainto_tsquery('english', :p1)
```

---

## Debugging Strategies

### 1. Compile with Debug Mode and Read the `DebugInfo`

Debug mode attaches a structured snapshot of the compilation to the result.

1. Enable it with `query({ debug: true })` (constructor option) or `.debug()` on the builder.
2. Compile and inspect `result.debug`.
3. Compare `debug.parameterCount` with the number of `:pN` placeholders actually present in `sql` — a higher count means a condition was replaced after registering its parameters (see [Pitfall 1](#1-a-second-where-silently-replaces-the-first-condition)).
4. Check `debug.warnings` — it contains `'No conditions specified'` for an empty query.

```typescript
import { query } from 'blendsdk/expression';

const result = query({ debug: true })
  .where('status').equals('active')
  .and('age').greaterThan(18)
  .compile();

console.log(result.sql);
// status = :p1 AND age > :p2

console.log(result.params);
// { p1: 'active', p2: 18 }

console.log(result.debug?.parameterCount);
// 2

console.log(result.debug?.warnings);
// []

console.log(result.debug?.compilationTime);
// e.g. 0.144 (milliseconds)

const empty = query({ debug: true }).compile();

console.log(empty.debug?.warnings);
// ['No conditions specified']
```

### 2. Print the AST to See What Was Actually Recorded

The SQL you get is a direct rendering of the AST. When the output surprises you, walk the tree and read the leaves — each leaf names the parameters it references.

1. Get the tree with `builder.getAST()`.
2. Print it with a small recursive helper, switching on `node.type` and casting to the exported node interfaces.
3. Compare the leaves with the conditions you intended to add. A missing leaf means a condition was dropped or replaced; an unexpected parameter name means numbering diverged.

```typescript
import { ASTNodeType, query } from 'blendsdk/expression';
import type { ASTNode, ComparisonNode, GroupNode, LogicalNode } from 'blendsdk/expression';

interface User {
  id: number;
  status: string;
}

function printTree(node: ASTNode, depth = 0): void {
  const indent = '  '.repeat(depth);

  switch (node.type) {
    case ASTNodeType.Comparison: {
      const comparison = node as ComparisonNode;
      const names = comparison.parameterNames?.join(', ') ?? 'no parameters';
      console.log(`${indent}${comparison.column} ${comparison.operator} [${names}]`);
      break;
    }
    case ASTNodeType.Logical: {
      const logical = node as LogicalNode;
      console.log(`${indent}${logical.operator}`);
      printTree(logical.left, depth + 1);
      printTree(logical.right, depth + 1);
      break;
    }
    case ASTNodeType.Group: {
      const group = node as GroupNode;
      console.log(`${indent}(group)`);
      printTree(group.child, depth + 1);
      break;
    }
    default: {
      console.log(`${indent}${node.type}`);
    }
  }
}

const builder = query<User>()
  .where('status').equals('active')
  .and('id').greaterThan(10);

const ast: ASTNode | null = builder.getAST();

if (ast !== null) {
  printTree(ast);
}

// AND
//   status = [p1]
//   id > [p2]
```

### 3. Check Placeholder-to-Parameter Consistency

Every `:pN` in the SQL must have a matching key in `params`, and every key should be referenced. This one-liner check catches replaced conditions, hand-built ASTs, and parameters merged from separate builders.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  status: string;
}

const { sql, params } = query<User>()
  .where('status').equals('active')
  .and('id').greaterThan(10)
  .compile();

const referenced = new Set(
  Array.from(sql.matchAll(/:p(\d+)\b/g), (match) => `p${match[1]}`)
);
const provided = new Set(Object.keys(params));

const orphaned = Array.from(provided).filter((name) => !referenced.has(name));
const missing = Array.from(referenced).filter((name) => !provided.has(name));

console.log('orphaned:', orphaned);
// [] — non-empty means a condition was replaced after its parameter was registered

console.log('missing:', missing);
// [] — non-empty means a placeholder has no value (hand-built AST or cross-builder merge)
```

### 4. Reduce the Problem to a Minimal Failing Test

Because `compile()` is deterministic and synchronous, a three-line test pins down almost any bug.

1. Create a focused test file, e.g. `tests/repro.test.ts`, asserting both `sql` and `params`.
2. Run only that file with `npx vitest run tests/repro.test.ts`.
3. Once it fails, shrink the builder chain until the smallest failing example remains.
4. Run the full suite with `npm test` to confirm nothing else regressed.

```typescript
import { describe, expect, it } from 'vitest';
import { query } from 'blendsdk/expression';

describe('repro', () => {
  it('keeps the first condition when a second is added', () => {
    const { sql, params } = query()
      .where('status').equals('active')
      .and('age').greaterThan(18)
      .compile();

    expect(sql).toBe('status = :p1 AND age > :p2');
    expect(params).toEqual({ p1: 'active', p2: 18 });
  });
});
```

### 5. Bind and Run the SQL Manually Against PostgreSQL

When the fragment looks right but the database rejects it or returns wrong rows, execute it by hand.

1. Convert named placeholders to positional ones (`:p1` → `$1`) so the statement can run directly in `psql`.
2. Run the statement inside `EXPLAIN` or a transaction to inspect behavior without side effects.
3. Bind values in numeric order: `p1` → `$1`, `p2` → `$2`.

```typescript
import { query } from 'blendsdk/expression';

const { sql, params } = query()
  .where('status').equals('active')
  .and('age').greaterThan(18)
  .compile();

const positionalSql = sql.replace(/:p(\d+)\b/g, (_match: string, index: string) => `$${index}`);

console.log(`SELECT * FROM users WHERE ${positionalSql};`);
// SELECT * FROM users WHERE status = $1 AND age > $2;

console.log(params);
// { p1: 'active', p2: 18 } — bind $1 ← p1, $2 ← p2
```

---

## Known Pitfalls

### 1. A Second `.where()` Silently Replaces the First Condition

**What happens.** `where` — both the column form and the callback form — always assigns its result as the new root `this.ast`, replacing anything already recorded. The builder's parameters are *not* rolled back, so the old condition's parameters stay in `params` as orphans. TypeScript permits the call because the query stage after `.equals(...)` exposes `where` again.

**Why it matters.** The SQL silently loses a filter (wrong results, wider data exposure), and the orphaned parameter can confuse parameter-count checks. The same applies to a second `where(q => …)` group.

**Fix.** Use `where` only for the first condition; combine subsequent conditions with `and`/`or`. If you see orphaned parameters (Strategy 3), search your code for a repeated `.where()`.

```typescript
import { query } from 'blendsdk/expression';

// ❌ The second where() replaces the first condition — 'status = :p1' is dropped
const broken = query()
  .where('status').equals('active')
  .where('age').greaterThan(18)
  .compile();

console.log(broken.sql);
// age > :p2

console.log(broken.params);
// { p1: 'active', p2: 18 } — p1 is orphaned: no placeholder references it

// ✅ and()/or() combine with the existing tree
const fixed = query()
  .where('status').equals('active')
  .and('age').greaterThan(18)
  .compile();

console.log(fixed.sql);
// status = :p1 AND age > :p2

console.log(fixed.params);
// { p1: 'active', p2: 18 }
```

### 2. `equals(null)` and `equals(undefined)` Are Not `IS NULL` Checks

**What happens.** `equals(null)` and `equals(undefined)` both emit `column = :pN` with the parameter normalized to `null` (the parameter manager converts `undefined` → `null`). In SQL, `column = NULL` evaluates to unknown — the predicate matches **no rows** and reports no error. The same applies to `notEquals(null)` (`<> NULL` is also unknown) and to `undefined` elements inside an `in([...])` array, which become `NULL` parameters that can never match.

**Fix.** Use `isNull()` / `isNotNull()` for SQL NULL checks, and filter `undefined` out of `IN` lists before calling `in()`.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  deleted_at: string | null;
}

// ❌ deleted_at = NULL is never true in SQL — this matches zero rows silently
const broken = query<User>().where('deleted_at').equals(null).compile();

console.log(broken.sql);
// deleted_at = :p1

console.log(broken.params);
// { p1: null }

// ✅ NULL checks use the dedicated methods and create no parameters
const fixed = query<User>().where('deleted_at').isNull().compile();

console.log(fixed.sql);
// deleted_at IS NULL

console.log(fixed.params);
// {}
```

### 3. `clone()` Shares the AST but Not the Parameter Manager

**What happens.** `QueryBuilderImpl.clone()` creates a new builder with a **fresh** `ParameterManager` but assigns the **same** AST reference:

- Compiling a clone produces SQL that references `:p1`, `:p2`, … but the clone's `params` is empty — the values live only in the original's manager.
- Adding a condition to the clone restarts numbering at `p1`, colliding with the shared AST's existing placeholders. Both occurrences then bind to the same value, silently changing the query's meaning.

**Fix.** Do not use `clone()` as an independent copy. Rebuild variations from a shared factory function, and capture `CompileResult` values when you need snapshots (they are plain values and safe to hold).

```typescript
import { QueryBuilderImpl, query } from 'blendsdk/expression';
import type { QueryBuilder } from 'blendsdk/expression';

interface User {
  id: number;
  status: string;
  age: number;
}

// ❌ The clone shares the private AST but has no parameters of its own
const original = new QueryBuilderImpl<User>();
original.where('status').equals('active');

const cloned = original.clone();

const firstCompile = cloned.compile();
console.log(firstCompile.sql);
// status = :p1
console.log(firstCompile.params);
// {} — p1's value lives in the original's manager only

cloned.and('age').greaterThan(18);
const secondCompile = cloned.compile();
console.log(secondCompile.sql);
// status = :p1 AND age > :p1 — both placeholders share one name
console.log(secondCompile.params);
// { p1: 18 } — the status check is now bound to 18

// ✅ Rebuild from a factory function instead — each builder gets its own manager
function baseQuery(): QueryBuilder<User> {
  return query<User>().where('status').equals('active');
}

console.log(baseQuery().and('age').greaterThanOrEqual(18).compile().sql);
// status = :p1 AND age >= :p2

console.log(baseQuery().and('id').greaterThan(0).compile().sql);
// status = :p1 AND id > :p2
```

### 4. Subquery Parameters Are Isolated — and Placeholders Can Collide

**What happens.** Every `query()` call creates its own `ParameterManager`. When you pass a subquery builder to `exists`/`inSubquery`, the subquery's predicate text is embedded verbatim, but the **parent's** `compile()` returns only the **parent's** parameters. Worse, both managers start numbering at `p1`, so a parent condition and a subquery condition share the same placeholder name — and merged parameter maps silently overwrite each other.

**Fix.** Two options:

1. Keep subqueries parameter-free by using `equalsColumn()` column references — the resulting predicate needs no bindings and cannot collide.
2. If the subquery must compare against a literal value, compile both fragments separately and compose the final SQL yourself, prefixing the subquery's placeholders before merging.

```typescript
import { query } from 'blendsdk/expression';

interface Order {
  id: number;
  customer_id: number;
  status: string;
  total: number;
}

// ✅ Option A — parameter-free subquery (column reference only)
const sameCustomer = query<Order>()
  .where('customer_id').equalsColumn('customers.id');

const nested = query<Order>()
  .where('total').greaterThan(100)
  .and('customer_id').exists(sameCustomer)
  .compile();

console.log(nested.sql);
// total > :p1 AND EXISTS (SELECT 1 WHERE customer_id = customers.id)

console.log(nested.params);
// { p1: 100 }

// ✅ Option B — subquery with literals: compile separately, rename, then merge
function prefixParameters(
  sql: string,
  params: Record<string, unknown>,
  prefix: string
): { sql: string; params: Record<string, unknown> } {
  const renamedSql = sql.replace(/:p\d+\b/g, (match: string) => `:${prefix}${match.slice(1)}`);
  const renamedParams: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(params)) {
    renamedParams[`${prefix}${name}`] = value;
  }
  return { sql: renamedSql, params: renamedParams };
}

const subquery = query<Order>().where('status').equals('paid').compile();
const renamedSubquery = prefixParameters(subquery.sql, subquery.params, 'sub_');

const parent = query<Order>().where('total').greaterThan(100).compile();

const sql = `${parent.sql} AND EXISTS (SELECT 1 WHERE ${renamedSubquery.sql})`;
const params = { ...parent.params, ...renamedSubquery.params };

console.log(sql);
// total > :p1 AND EXISTS (SELECT 1 WHERE status = :sub_p1)

console.log(params);
// { p1: 100, sub_p1: 'paid' }
```

### 5. `search({ language })` and `equalsColumn()` Interpolate Raw Strings

**What happens.** The parameter manager only parameterizes *values*. Two inputs are embedded directly into the SQL text: the `language` passed to `search()` (`to_tsvector('<language>', …)`) and the column reference passed to `equalsColumn()`. Passing user-controlled data to either is a SQL-injection vector — and an invalid language name additionally fails at execution with `text search configuration "…" does not exist`.

**Fix.** Restrict both to developer-controlled values; for anything read from configuration or requests, validate against a whitelist first.

```typescript
import { query } from 'blendsdk/expression';

const ALLOWED_LANGUAGES = ['english', 'german', 'french'] as const;
type SearchLanguage = (typeof ALLOWED_LANGUAGES)[number];

function isSearchLanguage(value: string): value is SearchLanguage {
  return (ALLOWED_LANGUAGES as readonly string[]).includes(value);
}

const requested = process.env.SEARCH_LANGUAGE ?? 'english';

if (!isSearchLanguage(requested)) {
  throw new Error(`Unsupported search language: ${requested}`);
}

const { sql } = query()
  .where('content').search('typescript', { language: requested })
  .compile();

console.log(sql);
// to_tsvector('english', content) @@ plainto_tsquery('english', :p1)

// Same principle for equalsColumn — only trusted identifiers
const reference = 'customers.id';
const comparison = query().where('customer_id').equalsColumn(reference).compile();

console.log(comparison.sql);
// customer_id = customers.id
```

### 6. LIKE Metacharacters in Values Are Never Escaped

**What happens.** Values passed to `like`, `ilike`, `startsWith`, `endsWith`, and `contains` are parameterized, but the parameter *contents* are not escaped for `LIKE` semantics. A user searching for `50% off` via `contains` produces the pattern `%50% off%`, where the embedded `%` matches anything — the search silently degenerates into a much broader match. The `_` wildcard has the same effect.

**Fix.** Escape `\`, `%`, and `_` in any user input before it reaches a pattern method. PostgreSQL's default `LIKE` escape character is the backslash, which the API does not override.

```typescript
import { query } from 'blendsdk/expression';

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

const userInput = '50% off';

const { sql, params } = query()
  .where('name').contains(escapeLike(userInput))
  .compile();

console.log(sql);
// name LIKE :p1

console.log(params);
// { p1: '%50\\% off%' } — the embedded % is escaped and matches literally
```

### 7. `between()` / `notBetween()` Do Not Validate Bound Order

**What happens.** The builder emits the bounds in the order you pass them. `between(65, 18)` compiles to `age BETWEEN :p1 AND :p2` and PostgreSQL silently returns **no rows** — no error, no warning. `notBetween(65, 18)` has the mirror problem: it returns *all* rows.

**Fix.** Validate the ordering at the call site (or swap the bounds deliberately) before building the condition.

```typescript
import { query } from 'blendsdk/expression';
import type { CompileResult } from 'blendsdk/expression';

function buildPriceRange(min: number, max: number): CompileResult {
  if (min > max) {
    throw new Error(`Invalid range: min (${min}) must not exceed max (${max})`);
  }

  return query()
    .where('price').between(min, max)
    .compile();
}

console.log(buildPriceRange(10, 100).sql);
// price BETWEEN :p1 AND :p2
```

### 8. `SubqueryBuilder.select()` and `.aggregate()` Are Not Implemented

**What happens.** The exported `SubqueryBuilder` interface extends `QueryBuilder` with `select(...columns)` and `aggregate(func)` declarations, but version 5.x ships no implementation of them — every builder is a `QueryBuilderImpl`, which has neither method. If you type a value as `SubqueryBuilder` (or cast to it), the call compiles but fails at runtime:

```text
TypeError: subquery.select is not a function
```

**What to do.** Do not cast builders to `SubqueryBuilder`; use the standard `QueryBuilder` methods (`exists`, `inSubquery`, `equalsColumn`) to express subquery predicates.

```typescript
import { query } from 'blendsdk/expression';

interface Order {
  id: number;
  customer_id: number;
  total: number;
}

// ✅ The supported way to express a subquery
const bigSpenders = query<Order>()
  .where('total').equalsColumn('customers.min_order_total');

const { sql, params } = query<Order>()
  .where('customer_id').exists(bigSpenders)
  .compile();

console.log(sql);
// EXISTS (SELECT 1 WHERE total = customers.min_order_total)

console.log(params);
// {}
```

### 9. AST Node IDs Are Process-Scoped and Unstable

**What happens.** Every node gets an `id` (`node_1`, `node_2`, …) from a module-level counter that keeps incrementing for the lifetime of the process. Two structurally identical queries built at different times have different ids, and ids are not reproducible across runs. Using them as cache keys, snapshot markers, or equality checks produces flaky behavior.

**Fix.** Compare rendered output (`sql` + `params`) instead of ids; the compilation is deterministic for identical chains.

```typescript
import { query } from 'blendsdk/expression';

const first = query().where('id').equals(1).getAST();
const second = query().where('id').equals(1).getAST();

// ❌ ids depend on every query built earlier in the process — never compare or cache on them
console.log(first?.id);
// 'node_1'

console.log(second?.id);
// 'node_2'

// ✅ Compare rendered output instead
const a = query().where('id').equals(1).compile();
const b = query().where('id').equals(1).compile();

console.log(a.sql === b.sql && JSON.stringify(a.params) === JSON.stringify(b.params));
// true
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
