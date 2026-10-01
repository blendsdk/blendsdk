> **Package**: `blendsdk/expression`

# expression API Reference

---

Complete reference for every symbol exported from the package root of `blendsdk/expression` v5.54.0. Signatures are quoted from the shipped TypeScript source: snippets fenced as `typescript fragment` are declaration references, while `typescript` blocks are complete, runnable examples that import all dependencies. All values are bound as parameters — user data is never concatenated into the generated SQL.

---

## Public Exports

Every symbol below is importable from `blendsdk/expression`:

| Export | Kind | Summary |
|--------|------|---------|
| `query` | Function | Factory that creates a new `QueryBuilder` with an empty condition tree. |
| `QueryBuilderImpl` | Class | Concrete fluent builder returned by `query()`; adds `clone()`. |
| `QueryBuilder` | Interface | Query-stage contract: `where`/`and`/`or`, `search`, `debug`, `compile`, `getAST`. |
| `ComparisonBuilder` | Interface | Comparison-stage contract: every terminal condition method. |
| `SubqueryBuilder` | Interface | Declares `select()`/`aggregate()` subquery extensions; no implementation ships in this version. |
| `PostgreSQLCompiler` | Class | Renders an AST to a PostgreSQL predicate string. |
| `ParameterManager` | Class | Parameter naming, serialization, and placeholder formatting. |
| `QueryOptions` | Type | Options accepted by `query()` and the builder constructor. |
| `SearchOptions` | Type | Full-text search mode and language. |
| `CompileResult` | Type | `compile()` result: `{ sql, params, debug? }`. |
| `DebugInfo` | Type | Compilation diagnostics attached when debug mode is active. |
| `ASTNode` | Type | Base interface for all AST nodes. |
| `ComparisonNode` | Type | AST node for comparisons. |
| `LogicalNode` | Type | AST node for `AND`/`OR`. |
| `GroupNode` | Type | AST node for parenthesized groups. |
| `JsonNode` | Type | AST node for JSON/JSONB operators. |
| `FullTextNode` | Type | AST node for full-text search. |
| `SubqueryNode` | Type | AST node for subqueries. |
| `SqlDialect` | Enum | SQL dialect constants. |
| `ComparisonOperator` | Enum | Comparison operator constants. |
| `LogicalOperator` | Enum | `AND` / `OR` constants. |
| `JsonOperator` | Enum | PostgreSQL JSON operator constants. |
| `FullTextMode` | Enum | tsquery parser mode constants. |
| `ASTNodeType` | Enum | AST node discriminator constants. |

`query`, `QueryBuilderImpl`, `PostgreSQLCompiler`, `ParameterManager`, and the six enums are runtime values. All other exports are type-only; import them with `import type`:

```typescript fragment
import { query, QueryBuilderImpl, PostgreSQLCompiler, ParameterManager, SqlDialect } from 'blendsdk/expression';
import type {
  QueryBuilder,
  ComparisonBuilder,
  SubqueryBuilder,
  QueryOptions,
  SearchOptions,
  CompileResult,
  DebugInfo,
  ASTNode,
  ComparisonNode,
  LogicalNode,
  GroupNode,
  JsonNode,
  FullTextNode,
  SubqueryNode,
} from 'blendsdk/expression';
```

---

## Functions

### `query<TSchema>(options?)`

Creates a new builder with an empty condition tree. Equivalent to `new QueryBuilderImpl<TSchema>(options)` and the recommended entry point.

```typescript fragment
query<TSchema = Record<string, unknown>>(options?: QueryOptions): QueryBuilder<TSchema>
```

**Type parameters**

| Type parameter | Default | Description |
|----------------|---------|-------------|
| `TSchema` | `Record<string, unknown>` | Row shape under filter. Column names are constrained to `keyof TSchema` and comparison values to the matching property type. |

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `options` | `QueryOptions` | No | `{}` | Builder configuration — target `dialect` (default `SqlDialect.PostgreSQL`) and `debug` mode (default `false`). |

**Returns** — `QueryBuilder<TSchema>`: a builder whose `getAST()` is `null` until the first condition is recorded; compiling it immediately yields `{ sql: '', params: {} }`.

**Example**

```typescript
import { query } from 'blendsdk/expression';
import type { QueryBuilder } from 'blendsdk/expression';

interface Account {
  id: number;
  email: string;
  balance: number;
}

const builder: QueryBuilder<Account> = query<Account>();

const { sql, params } = builder
  .where('balance')
  .greaterThan(0)
  .and('email')
  .endsWith('@example.com')
  .compile();

console.log(sql);
// balance > :p1 AND email LIKE :p2

console.log(params);
// { p1: 0, p2: '%@example.com' }
```

---

## Classes

### `QueryBuilderImpl<TSchema>`

The concrete implementation of the fluent builder. Because `query()` is typed to return the `QueryBuilder` interface, construct this class directly when you need the class type — for example, to call `clone()`, which is not declared on the interface.

```typescript fragment
class QueryBuilderImpl<TSchema = Record<string, unknown>> implements QueryBuilder<TSchema>
```

**Constructor**

```typescript fragment
constructor(options: QueryOptions = {}, parentParamManager?: ParameterManager)
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `options` | `QueryOptions` | No | `{}` | `dialect` (default `SqlDialect.PostgreSQL`) and `debug` (default `false`). |
| `parentParamManager` | `ParameterManager` | No | — | Existing parameter manager to share. Used by nested builders created from `where`/`and`/`or` callbacks so placeholder numbering (`p1`, `p2`, …) stays continuous across the parent query and its groups. |

**Properties**

None public. Builder state (`ast`, `paramManager`, `dialect`, `debugMode`) is private; observe it through `getAST()` and `compile()`.

**Methods**

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `where` | `where<K extends keyof TSchema>(column: K)` | `ComparisonBuilder<TSchema, K>` | Opens the comparison stage for `column`; the recorded condition replaces the tree root. |
| `where` | `where(callback: (q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>)` | `QueryBuilder<TSchema>` | Runs `callback` with a nested builder; the resulting subtree is wrapped in a `GroupNode` and becomes the tree root. |
| `and` | `and<K extends keyof TSchema>(column: K)` | `ComparisonBuilder<TSchema, K>` | Opens the comparison stage for `column`; the recorded condition is AND-combined with the tree (or becomes the root if the tree is empty). |
| `and` | `and(callback: (q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>)` | `QueryBuilder<TSchema>` | AND-combines a parenthesized subtree produced by `callback`. |
| `or` | `or<K extends keyof TSchema>(column: K)` | `ComparisonBuilder<TSchema, K>` | Opens the comparison stage for `column`; the recorded condition is OR-combined with the tree (or becomes the root if the tree is empty). |
| `or` | `or(callback: (q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>)` | `QueryBuilder<TSchema>` | OR-combines a parenthesized subtree produced by `callback`. |
| `search` | `search(columns: string \| string[], query: string, options?: SearchOptions)` | `QueryBuilder<TSchema>` | Appends a full-text search condition, AND-combined with the tree. |
| `debug` | `debug()` | `QueryBuilder<TSchema>` | Enables debug mode for subsequent `compile()` calls; returns `this`. |
| `compile` | `compile()` | `CompileResult` | Compiles the tree to SQL and bind parameters. Throws for any dialect other than PostgreSQL. |
| `getAST` | `getAST()` | `ASTNode \| null` | Returns the current root node, or `null` when no condition was recorded. |
| `clone` | `clone()` | `QueryBuilder<TSchema>` | Returns a new builder with a fresh parameter manager that shares the AST reference — see the warning below. |

**`search` parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `columns` | `string \| string[]` | Yes | — | Column(s) whose concatenated text is searched. A single string is treated as a one-element list. |
| `query` | `string` | Yes | — | The search text; registered as exactly one parameter. |
| `options` | `SearchOptions` | No | — | `mode` (default `'plain'`) and `language` (default `'english'`). |

**Behavior notes**

- `where` installs its condition as the tree root and replaces any existing tree — use it for the first condition and record later conditions with `and`/`or`.
- Callback overloads run against a nested builder that shares the parent's `ParameterManager`, so placeholder numbering stays continuous across groups. A callback that records no condition adds nothing.
- Unlike `where`/`and`/`or`, the `columns` argument of `search` is typed as `string | string[]`, not `keyof TSchema`.
- An empty builder compiles to `{ sql: '', params: {} }`; in debug mode the `warnings` list contains `'No conditions specified'`.
- Only PostgreSQL compiles: `MySQL`, `MSSQL`, and `SQLite` throw `Error('Dialect <name> is not yet implemented')` from `compile()`.

> **⚠️ Warning — shared state.** `clone()` assigns a **new** `ParameterManager` but keeps the **same AST reference**. Conditions added afterwards to the clone keep extending the shared tree while the clone's parameter counter restarts at `p1`, which can collide with placeholder names already recorded in the AST. Use clones for branching query variations, not as independent copies; for a fully independent builder, compile the original and start a new `query()`.

**Example**

```typescript
import { QueryBuilderImpl, SqlDialect } from 'blendsdk/expression';

interface Product {
  id: number;
  name: string;
  price: number;
}

const builder = new QueryBuilderImpl<Product>({
  dialect: SqlDialect.PostgreSQL,
  debug: true,
});

const { sql, params, debug } = builder
  .where('price')
  .greaterThan(10)
  .and('name')
  .startsWith('USB')
  .and('name')
  .endsWith('Cable')
  .compile();

console.log(sql);
// price > :p1 AND name LIKE :p2 AND name LIKE :p3

console.log(params);
// { p1: 10, p2: 'USB%', p3: '%Cable' }

console.log(debug?.parameterCount); // 3
```

---

### `PostgreSQLCompiler`

Strategy that renders an AST to a PostgreSQL boolean expression. `QueryBuilderImpl.compile()` uses this class internally; instantiate it directly only when you keep your own AST (for example, a cached or hand-inspected tree).

```typescript fragment
class PostgreSQLCompiler {
  constructor(paramManager: ParameterManager);
}
```

**Constructor**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `paramManager` | `ParameterManager` | Yes | — | Supplies the placeholder syntax (`:p1`, `:p2`, …) used when rendering parameter names. |

**Methods**

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `compile` | `compile(ast: ASTNode)` | `string` | Walks the AST and returns the SQL predicate. The result never includes the `WHERE` keyword. |
| `getOptimizations` | `getOptimizations()` | `string[]` | Optimizations recorded during compilation — currently always empty. |
| `getWarnings` | `getWarnings()` | `string[]` | Compiler warnings — currently always empty. |

**Node rendering (PostgreSQL)**

| AST node | Rendered SQL |
|----------|--------------|
| `ComparisonNode` (`=`, `<>`, `>`, `>=`, `<`, `<=`, `LIKE`, `ILIKE`) | `<column> <operator> :pN` |
| `ComparisonNode` (`BETWEEN`, `NOT BETWEEN`) | `<column> BETWEEN :pN AND :pM` |
| `ComparisonNode` (`IN`, `NOT IN`) | `<column> IN (:p1, …, :pN)` |
| `ComparisonNode` (`IS NULL`, `IS NOT NULL`) | `<column> IS NULL` / `<column> IS NOT NULL` |
| `ComparisonNode` without `parameterNames` | `<column> <operator> <value>` — raw column reference (used by `equalsColumn`) |
| `LogicalNode` | `<left> AND <right>` / `<left> OR <right>` |
| `GroupNode` | `(<child>)` |
| `JsonNode` | `<column> <json-operator> :pN` (`@>`, `<@`, `?`, `?\|`, `?&`, `@?`) |
| `FullTextNode` | `to_tsvector('<language>', <columns>) @@ <mode>to_tsquery('<language>', :pN)` |
| `SubqueryNode` | `EXISTS (SELECT 1 WHERE <predicate>)`, `NOT EXISTS (…)`, `<column> IN (SELECT * WHERE <predicate>)`, `<column> NOT IN (…)` |

**Behavior notes**

- Placeholders are rendered from the names recorded in the AST nodes; the compiler holds no parameter values. When compiling an AST captured from a builder, collect the bind values through that builder's `compile()` so the SQL and `params` stay in sync.
- `getOptimizations()` and `getWarnings()` currently always return empty arrays; `compile()` surfaces them through `DebugInfo` when debug mode is on.

**Example**

```typescript
import {
  query,
  PostgreSQLCompiler,
  ParameterManager,
  SqlDialect,
} from 'blendsdk/expression';
import type { ASTNode } from 'blendsdk/expression';

interface Ticket {
  id: number;
  severity: string;
  resolved: boolean;
}

const builder = query<Ticket>()
  .where('severity')
  .equals('high')
  .and('resolved')
  .equals(false);

const ast: ASTNode | null = builder.getAST();

if (!ast) {
  throw new Error('At least one condition is required.');
}

const compiler = new PostgreSQLCompiler(new ParameterManager(SqlDialect.PostgreSQL));
const sql = compiler.compile(ast);

console.log(sql);
// severity = :p1 AND resolved = :p2

const { params } = builder.compile();

console.log(params);
// { p1: 'high', p2: false }
```

---

### `ParameterManager`

Owns parameter state for one query: generates sequential names, stores serialized values, and formats dialect placeholders. One instance is created per builder; grouped sub-builders share it; the compiler reads it for placeholder syntax.

```typescript fragment
class ParameterManager {
  constructor(dialect?: SqlDialect);
}
```

**Constructor**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `dialect` | `SqlDialect` | No | `SqlDialect.PostgreSQL` | Selects the placeholder format produced by `formatParameterPlaceholder`. |

**Methods**

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `generateParameterName` | `generateParameterName()` | `string` | Increments the counter and returns the next name (`p1`, `p2`, …). |
| `addParameter` | `addParameter(name: string, value: unknown)` | `void` | Serializes and stores a value under an explicit name. The counter is not advanced. |
| `addParameterWithValue` | `addParameterWithValue(value: unknown)` | `string` | Generates the next name, stores the serialized value, and returns the name. |
| `getParameter` | `getParameter(name: string)` | `unknown` | Returns the stored (serialized) value, or `undefined` if absent. |
| `hasParameter` | `hasParameter(name: string)` | `boolean` | Whether a parameter with `name` is registered. |
| `getParameters` | `getParameters()` | `Record<string, unknown>` | Snapshot of all parameters as a plain object — the shape of `CompileResult.params`. |
| `getParameterCount` | `getParameterCount()` | `number` | Number of names generated via `generateParameterName`/`addParameterWithValue`. |
| `reset` | `reset()` | `void` | Clears the counter and removes all stored parameters. |
| `formatParameterPlaceholder` | `formatParameterPlaceholder(name: string)` | `string` | Dialect placeholder for a name — see the table below. |
| `serializeParameter` | `serializeParameter(value: unknown)` | `unknown` | Normalizes a value: `undefined` → `null`, `Date` → ISO-8601 string; arrays, objects, and scalars pass through unchanged. |
| `deduplicateParameter` | `deduplicateParameter(value: unknown)` | `string \| null` | Name of an existing parameter whose serialized value deep-equals `value` (compared via `JSON.stringify`), or `null`. Not called automatically by the builders. |
| `clone` | `clone()` | `ParameterManager` | Independent copy of the counter and registry (same dialect). |

**Placeholder formats**

| `SqlDialect` | Placeholder | Example |
|--------------|-------------|---------|
| `PostgreSQL` | `:` + name | `:p1` |
| `MySQL` | `?` | `?` |
| `SQLite` | `?` | `?` |
| `MSSQL` | `@` + name | `@p1` |

The `:` prefix appears only in rendered SQL — `getParameters()` and `CompileResult.params` are keyed by the bare names (`p1`, `p2`, …).

**Example**

```typescript
import { ParameterManager, SqlDialect } from 'blendsdk/expression';

const manager = new ParameterManager(SqlDialect.PostgreSQL);

const first = manager.addParameterWithValue('draft');
const second = manager.addParameterWithValue(new Date('2025-03-01T12:00:00.000Z'));

console.log(first, second);
// p1 p2

console.log(manager.getParameters());
// { p1: 'draft', p2: '2025-03-01T12:00:00.000Z' }

console.log(manager.formatParameterPlaceholder(first)); // :p1
console.log(manager.deduplicateParameter('draft')); // p1
console.log(manager.getParameterCount()); // 2
```

---

## Interfaces

### `QueryBuilder<TSchema>`

The query-stage contract returned by `query()` and by every terminal comparison method. It is implemented by `QueryBuilderImpl`. The type parameter `TSchema` constrains `where`/`and`/`or` column arguments and comparison values; it defaults to a free-form record when omitted.

```typescript fragment
interface QueryBuilder<TSchema = Record<string, unknown>> {
  where<K extends keyof TSchema>(column: K): ComparisonBuilder<TSchema, K>;
  where(callback: (q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>): QueryBuilder<TSchema>;
  and<K extends keyof TSchema>(column: K): ComparisonBuilder<TSchema, K>;
  and(callback: (q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>): QueryBuilder<TSchema>;
  or<K extends keyof TSchema>(column: K): ComparisonBuilder<TSchema, K>;
  or(callback: (q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>): QueryBuilder<TSchema>;
  search(columns: string | string[], query: string, options?: SearchOptions): QueryBuilder<TSchema>;
  debug(): QueryBuilder<TSchema>;
  compile(): CompileResult;
  getAST(): ASTNode | null;
}
```

**Methods**

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `where` (column) | `where<K extends keyof TSchema>(column: K)` | `ComparisonBuilder<TSchema, K>` | Enters the comparison stage for `column`; the recorded condition becomes the root of the tree. |
| `where` (callback) | `where(callback: (q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>)` | `QueryBuilder<TSchema>` | Runs `callback` with a nested builder; the subtree is wrapped in parentheses and becomes the root. |
| `and` (column) | `and<K extends keyof TSchema>(column: K)` | `ComparisonBuilder<TSchema, K>` | The next recorded comparison is AND-combined with the current tree. |
| `and` (callback) | `and(callback: (q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>)` | `QueryBuilder<TSchema>` | A parenthesized subtree is AND-combined with the current tree. |
| `or` (column) | `or<K extends keyof TSchema>(column: K)` | `ComparisonBuilder<TSchema, K>` | The next recorded comparison is OR-combined with the current tree. |
| `or` (callback) | `or(callback: (q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>)` | `QueryBuilder<TSchema>` | A parenthesized subtree is OR-combined with the current tree. |
| `search` | `search(columns: string \| string[], query: string, options?: SearchOptions)` | `QueryBuilder<TSchema>` | Adds a full-text search condition over one or more columns, AND-combined with the current tree. |
| `debug` | `debug()` | `QueryBuilder<TSchema>` | Enables debug mode so later `compile()` calls attach `DebugInfo`. |
| `compile` | `compile()` | `CompileResult` | Compiles the tree to SQL and bind parameters. |
| `getAST` | `getAST()` | `ASTNode \| null` | Exposes the current root node for inspection or reuse. |

`clone()` is implemented by `QueryBuilderImpl` but is not declared on this interface.

**Example**

```typescript
import { query } from 'blendsdk/expression';
import type { QueryBuilder } from 'blendsdk/expression';

interface Task {
  id: number;
  owner: string;
  done: boolean;
  priority: number;
}

const builder: QueryBuilder<Task> = query<Task>();

// Column overloads build the tree; callback overloads add parenthesized groups.
const { sql, params } = builder
  .where(q => q
    .where('owner').equals('ada')
    .or('owner').equals('grace')
  )
  .and('done').equals(false)
  .and('priority').lessThan(3)
  .compile();

console.log(sql);
// (owner = :p1 OR owner = :p2) AND done = :p3 AND priority < :p4

console.log(params);
// { p1: 'ada', p2: 'grace', p3: false, p4: 3 }
```

---

### `ComparisonBuilder<TSchema, K>`

The comparison-stage contract returned by the column overloads of `where`, `and`, and `or`. It binds a single column — `K extends keyof TSchema` — and exposes the terminal operations. Every method records exactly one condition and returns the `QueryBuilder<TSchema>` so chaining can continue; the originating `where`/`and`/`or` call decides how the recorded node is attached to the tree.

```typescript fragment
interface ComparisonBuilder<TSchema, K extends keyof TSchema> {
  equals(value: TSchema[K]): QueryBuilder<TSchema>;
  notEquals(value: TSchema[K]): QueryBuilder<TSchema>;
  greaterThan(value: TSchema[K]): QueryBuilder<TSchema>;
  greaterThanOrEqual(value: TSchema[K]): QueryBuilder<TSchema>;
  lessThan(value: TSchema[K]): QueryBuilder<TSchema>;
  lessThanOrEqual(value: TSchema[K]): QueryBuilder<TSchema>;
  between(min: TSchema[K], max: TSchema[K]): QueryBuilder<TSchema>;
  notBetween(min: TSchema[K], max: TSchema[K]): QueryBuilder<TSchema>;
  in(values: TSchema[K][]): QueryBuilder<TSchema>;
  notIn(values: TSchema[K][]): QueryBuilder<TSchema>;
  like(pattern: string): QueryBuilder<TSchema>;
  ilike(pattern: string): QueryBuilder<TSchema>;
  isNull(): QueryBuilder<TSchema>;
  isNotNull(): QueryBuilder<TSchema>;
  startsWith(value: string): QueryBuilder<TSchema>;
  endsWith(value: string): QueryBuilder<TSchema>;
  contains(value: string): QueryBuilder<TSchema>;
  jsonContains(value: unknown): QueryBuilder<TSchema>;
  jsonContainedBy(value: unknown): QueryBuilder<TSchema>;
  jsonHasKey(key: string): QueryBuilder<TSchema>;
  jsonHasAnyKey(keys: string[]): QueryBuilder<TSchema>;
  jsonHasAllKeys(keys: string[]): QueryBuilder<TSchema>;
  jsonPathExists(path: string): QueryBuilder<TSchema>;
  search(query: string, options?: SearchOptions): QueryBuilder<TSchema>;
  exists(subquery: QueryBuilder): QueryBuilder<TSchema>;
  notExists(subquery: QueryBuilder): QueryBuilder<TSchema>;
  inSubquery(subquery: QueryBuilder): QueryBuilder<TSchema>;
  notInSubquery(subquery: QueryBuilder): QueryBuilder<TSchema>;
  equalsColumn(column: string): QueryBuilder<TSchema>;
}
```

**Equality and ordering**

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `equals` | `equals(value: TSchema[K])` | `QueryBuilder<TSchema>` | Equality — `column = :pN`. |
| `notEquals` | `notEquals(value: TSchema[K])` | `QueryBuilder<TSchema>` | Inequality — `column <> :pN`. |
| `greaterThan` | `greaterThan(value: TSchema[K])` | `QueryBuilder<TSchema>` | `column > :pN`. |
| `greaterThanOrEqual` | `greaterThanOrEqual(value: TSchema[K])` | `QueryBuilder<TSchema>` | `column >= :pN`. |
| `lessThan` | `lessThan(value: TSchema[K])` | `QueryBuilder<TSchema>` | `column < :pN`. |
| `lessThanOrEqual` | `lessThanOrEqual(value: TSchema[K])` | `QueryBuilder<TSchema>` | `column <= :pN`. |

**Range and set membership**

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `between` | `between(min: TSchema[K], max: TSchema[K])` | `QueryBuilder<TSchema>` | Inclusive range — `column BETWEEN :pN AND :pM`. |
| `notBetween` | `notBetween(min: TSchema[K], max: TSchema[K])` | `QueryBuilder<TSchema>` | `column NOT BETWEEN :pN AND :pM`. |
| `in` | `in(values: TSchema[K][])` | `QueryBuilder<TSchema>` | `column IN (:p1, …, :pN)`; an empty array renders `column IN ()`. |
| `notIn` | `notIn(values: TSchema[K][])` | `QueryBuilder<TSchema>` | `column NOT IN (:p1, …, :pN)`; an empty array renders `column NOT IN ()`. |

**Pattern matching and NULL checks**

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `like` | `like(pattern: string)` | `QueryBuilder<TSchema>` | `column LIKE :pN`; the pattern is always parameterized. |
| `ilike` | `ilike(pattern: string)` | `QueryBuilder<TSchema>` | Case-insensitive `column ILIKE :pN` (PostgreSQL). |
| `startsWith` | `startsWith(value: string)` | `QueryBuilder<TSchema>` | Sugar for `like` with `value + '%'` — `column LIKE :pN`. |
| `endsWith` | `endsWith(value: string)` | `QueryBuilder<TSchema>` | Sugar for `like` with `'%' + value`. |
| `contains` | `contains(value: string)` | `QueryBuilder<TSchema>` | Sugar for `like` with `'%' + value + '%'`. |
| `isNull` | `isNull()` | `QueryBuilder<TSchema>` | `column IS NULL`; no parameter is created. |
| `isNotNull` | `isNotNull()` | `QueryBuilder<TSchema>` | `column IS NOT NULL`; no parameter is created. |

**JSON and JSONB operations**

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `jsonContains` | `jsonContains(value: unknown)` | `QueryBuilder<TSchema>` | JSONB containment — `column @> :pN`. |
| `jsonContainedBy` | `jsonContainedBy(value: unknown)` | `QueryBuilder<TSchema>` | Reverse containment — `column <@ :pN`. |
| `jsonHasKey` | `jsonHasKey(key: string)` | `QueryBuilder<TSchema>` | Top-level key exists — `column ? :pN`. |
| `jsonHasAnyKey` | `jsonHasAnyKey(keys: string[])` | `QueryBuilder<TSchema>` | Any of the keys exist — `column ?\| :pN`. |
| `jsonHasAllKeys` | `jsonHasAllKeys(keys: string[])` | `QueryBuilder<TSchema>` | All of the keys exist — `column ?& :pN`. |
| `jsonPathExists` | `jsonPathExists(path: string)` | `QueryBuilder<TSchema>` | JSON path exists — `column @? :pN`. |

**Full-text search**

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `search` | `search(query: string, options?: SearchOptions)` | `QueryBuilder<TSchema>` | Full-text search on the bound column — `to_tsvector('<lang>', column) @@ <mode>to_tsquery('<lang>', :pN)`. |

**Subqueries and column references**

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `exists` | `exists(subquery: QueryBuilder)` | `QueryBuilder<TSchema>` | `EXISTS (SELECT 1 WHERE <predicate>)`. Throws `Error('Subquery must have at least one condition')` when the subquery has no conditions. |
| `notExists` | `notExists(subquery: QueryBuilder)` | `QueryBuilder<TSchema>` | `NOT EXISTS (SELECT 1 WHERE <predicate>)`; same guard. |
| `inSubquery` | `inSubquery(subquery: QueryBuilder)` | `QueryBuilder<TSchema>` | `column IN (SELECT * WHERE <predicate>)`; same guard. |
| `notInSubquery` | `notInSubquery(subquery: QueryBuilder)` | `QueryBuilder<TSchema>` | `column NOT IN (SELECT * WHERE <predicate>)`; same guard. |
| `equalsColumn` | `equalsColumn(column: string)` | `QueryBuilder<TSchema>` | Emits `column = <reference>` with **no parameter** — for correlated subqueries. The string is embedded directly into SQL, so only pass trusted, developer-controlled column references. |

**Behavior notes**

- `equals(null)` and `equals(undefined)` still emit `= :pN` (the value serializes to `null`); use `isNull()`/`isNotNull()` for SQL NULL semantics.
- `in([])`/`notIn([])` render an empty list, which PostgreSQL rejects at parse time — guard against empty arrays.
- `like` does not escape wildcards: `%` and `_` in the pattern (or in `startsWith`/`endsWith`/`contains` input) act as LIKE metacharacters.
- **Subquery parameter scope** — a subquery built with a separate `query()` call keeps its own `ParameterManager`, so the parent's `params` do not include the subquery's values. Compile the subquery too and merge both `params` maps, remembering that each builder numbers placeholders from `p1`.

**Example**

```typescript
import { query } from 'blendsdk/expression';
import type { ComparisonBuilder, QueryBuilder } from 'blendsdk/expression';

interface Invoice {
  id: number;
  status: string;
  amount: number;
  issued_at: string | null;
}

const builder = query<Invoice>();

const stage: ComparisonBuilder<Invoice, 'status'> = builder.where('status');
const afterEquals: QueryBuilder<Invoice> = stage.equals('overdue');

const { sql, params } = afterEquals
  .and('amount').greaterThan(1000)
  .compile();

console.log(sql);
// status = :p1 AND amount > :p2

console.log(params);
// { p1: 'overdue', p2: 1000 }
```

---

### `SubqueryBuilder<TSchema>`

Declares optional projection and aggregation extensions for subquery builders. It extends `QueryBuilder<TSchema>` with two additional members.

```typescript fragment
interface SubqueryBuilder<TSchema = Record<string, unknown>> extends QueryBuilder<TSchema> {
  select(...columns: (keyof TSchema)[]): SubqueryBuilder<TSchema>;
  aggregate(func: 'avg' | 'sum' | 'count' | 'min' | 'max'): SubqueryBuilder<TSchema>;
}
```

**Methods**

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `select` | `select(...columns: (keyof TSchema)[])` | `SubqueryBuilder<TSchema>` | Declares the columns the subquery should project. |
| `aggregate` | `aggregate(func: 'avg' \| 'sum' \| 'count' \| 'min' \| 'max')` | `SubqueryBuilder<TSchema>` | Declares the aggregate function applied by the subquery. |

> **Implementation status.** `SubqueryBuilder` is exported for type completeness only. Version 5.x ships no concrete class implementing it, and the subquery methods on `ComparisonBuilder` (`exists`, `notExists`, `inSubquery`, `notInSubquery`) accept ordinary `QueryBuilder` instances.

---

## Option and Result Types

### `QueryOptions`

Configuration object accepted by `query()` and the `QueryBuilderImpl` constructor.

```typescript fragment
interface QueryOptions {
  dialect?: SqlDialect;
  debug?: boolean;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `dialect` | `SqlDialect` | Target SQL dialect. Defaults to `SqlDialect.PostgreSQL`. Only PostgreSQL is implemented; other values throw from `compile()`. |
| `debug` | `boolean` | When `true`, `compile()` attaches a `DebugInfo` object to the result. Defaults to `false`. |

---

### `SearchOptions`

Full-text search configuration accepted by both `search` overloads.

```typescript fragment
interface SearchOptions {
  mode?: 'plain' | 'phrase' | 'websearch';
  language?: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `mode` | `'plain' \| 'phrase' \| 'websearch'` | tsquery parser mode: `plainto_tsquery`, `phraseto_tsquery`, or `websearch_to_tsquery`. Defaults to `'plain'`. |
| `language` | `string` | Text-search language embedded in `to_tsvector`/`to_tsquery` calls. Defaults to `'english'`. |

---

### `CompileResult`

Value returned by `compile()`.

```typescript fragment
interface CompileResult {
  sql: string;
  params: Record<string, unknown>;
  debug?: DebugInfo;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `sql` | `string` | Boolean predicate without the `WHERE` keyword; `''` when no conditions were recorded. |
| `params` | `Record<string, unknown>` | Serialized bind values keyed by placeholder name (`p1`, `p2`, …). Inside `sql` the same names are rendered with dialect syntax (`:p1` for PostgreSQL). |
| `debug` | `DebugInfo \| undefined` | Present only when debug mode is enabled — via `query({ debug: true })` or `.debug()`. |

**Example**

```typescript
import { query } from 'blendsdk/expression';
import type { CompileResult } from 'blendsdk/expression';

interface Job {
  id: number;
  state: string;
  retries: number;
}

const result: CompileResult = query<Job>({ debug: true })
  .where('state')
  .equals('failed')
  .and('retries')
  .greaterThanOrEqual(3)
  .compile();

console.log(result.sql);
// state = :p1 AND retries >= :p2

console.log(result.params);
// { p1: 'failed', p2: 3 }

console.log(result.debug?.parameterCount); // 2
```

---

### `DebugInfo`

Compilation diagnostics attached to `CompileResult.debug` when debug mode is active.

```typescript fragment
interface DebugInfo {
  ast: ASTNode;
  optimizations: string[];
  parameterCount: number;
  compilationTime: number;
  warnings: string[];
}
```

| Property | Type | Description |
|----------|------|-------------|
| `ast` | `ASTNode` | Root of the compiled tree. |
| `optimizations` | `string[]` | Optimizations applied during compilation — currently always empty. |
| `parameterCount` | `number` | Number of parameters generated for the query. |
| `compilationTime` | `number` | Compilation duration in milliseconds. |
| `warnings` | `string[]` | Warnings; contains `'No conditions specified'` for an empty query. |

---

## AST Types

### `ASTNode`

Base interface implemented by every AST node. Nodes are created by the builders as frozen (`Object.freeze`) value objects and are never mutated; obtain them via `getAST()` or `DebugInfo.ast`. The `id` is generated from a module-level counter, so ids are unique within a process but not stable across runs.

```typescript fragment
interface ASTNode {
  readonly type: ASTNodeType;
  readonly id: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `type` | `ASTNodeType` | Discriminant identifying the concrete node kind. |
| `id` | `string` | Auto-generated unique id (`node_1`, `node_2`, …). |

Feature-detection helpers for node kinds are not exported; discriminate by comparing `node.type` against `ASTNodeType` and narrow with the concrete node interfaces.

**Example**

```typescript
import { query, ASTNodeType } from 'blendsdk/expression';
import type {
  ASTNode,
  ComparisonNode,
  GroupNode,
  LogicalNode,
} from 'blendsdk/expression';

interface Session {
  id: number;
  user_id: number;
  active: boolean;
}

function collectColumns(node: ASTNode, into: Set<string> = new Set<string>()): Set<string> {
  switch (node.type) {
    case ASTNodeType.Comparison:
      into.add((node as ComparisonNode).column);
      break;
    case ASTNodeType.Logical: {
      const logical = node as LogicalNode;
      collectColumns(logical.left, into);
      collectColumns(logical.right, into);
      break;
    }
    case ASTNodeType.Group:
      collectColumns((node as GroupNode).child, into);
      break;
    default:
      break;
  }
  return into;
}

const ast: ASTNode | null = query<Session>()
  .where('active')
  .equals(true)
  .and(q =>
    q
      .where('user_id')
      .equals(42)
      .or('user_id')
      .equals(43)
  )
  .getAST();

if (ast) {
  console.log([...collectColumns(ast)]);
  // ['active', 'user_id']
}
```

---

### `ComparisonNode`

Extends `ASTNode`. Created by every terminal comparison method (`equals`, `between`, `like`, `in`, `isNull`, `equalsColumn`, …).

```typescript fragment
interface ComparisonNode extends ASTNode {
  readonly type: ASTNodeType.Comparison;
  readonly column: string;
  readonly operator: ComparisonOperator;
  readonly value?: unknown;
  readonly values?: unknown[];
  readonly parameterNames?: string[];
}
```

| Property | Type | Description |
|----------|------|-------------|
| `type` | `ASTNodeType.Comparison` | Node discriminant (`'comparison'`). |
| `id` | `string` | Inherited node id. |
| `column` | `string` | Left-hand column (or the correlated column reference produced by `equalsColumn`). |
| `operator` | `ComparisonOperator` | The recorded comparison operator. |
| `value` | `unknown` | Single operand for `equals`, `notEquals`, ordering operators, `like`, `ilike`, and `equalsColumn` (the column reference string). Optional. |
| `values` | `unknown[]` | Operand list for `between`, `notBetween`, `in`, and `notIn`. Optional. |
| `parameterNames` | `string[]` | Names of the parameters registered for this node (`['p1']`, `['p1', 'p2']`, …). Absent for `isNull`, `isNotNull`, and `equalsColumn`, which emit no parameters. Optional. |

---

### `LogicalNode`

Extends `ASTNode`. Created whenever `and`/`or` combines two subtrees, and by `search` when a tree already exists.

```typescript fragment
interface LogicalNode extends ASTNode {
  readonly type: ASTNodeType.Logical;
  readonly operator: LogicalOperator;
  readonly left: ASTNode;
  readonly right: ASTNode;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `type` | `ASTNodeType.Logical` | Node discriminant (`'logical'`). |
| `id` | `string` | Inherited node id. |
| `operator` | `LogicalOperator` | `And` or `Or`. |
| `left` | `ASTNode` | Left operand subtree (the existing tree at composition time). |
| `right` | `ASTNode` | Right operand subtree (the newly added condition or group). |

---

### `GroupNode`

Extends `ASTNode`. Wraps the subtree produced by a `where`/`and`/`or` callback; the compiler renders it with parentheses.

```typescript fragment
interface GroupNode extends ASTNode {
  readonly type: ASTNodeType.Group;
  readonly child: ASTNode;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `type` | `ASTNodeType.Group` | Node discriminant (`'group'`). |
| `id` | `string` | Inherited node id. |
| `child` | `ASTNode` | The parenthesized subtree. |

---

### `JsonNode`

Extends `ASTNode`. Created by the JSON/JSONB comparison methods (`jsonContains`, `jsonHasKey`, `jsonPathExists`, …).

```typescript fragment
interface JsonNode extends ASTNode {
  readonly type: ASTNodeType.Json;
  readonly column: string;
  readonly operator: JsonOperator;
  readonly value?: unknown;
  readonly path?: string;
  readonly keys?: string[];
  readonly parameterName?: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `type` | `ASTNodeType.Json` | Node discriminant (`'json'`). |
| `id` | `string` | Inherited node id. |
| `column` | `string` | The JSON/JSONB column. |
| `operator` | `JsonOperator` | The PostgreSQL JSON operator. |
| `value` | `unknown` | Operand for `Contains`/`ContainedBy` (object or array, stored as-is for the driver to serialize). Optional. |
| `path` | `string` | JSON path for `PathExists`. Optional. |
| `keys` | `string[]` | Keys for `HasKey`, `HasAnyKey`, and `HasAllKeys`. Optional. |
| `parameterName` | `string` | Name of the single parameter registered for the operation. Optional per the type; always set by the builders. |

---

### `FullTextNode`

Extends `ASTNode`. Created by both `search` overloads.

```typescript fragment
interface FullTextNode extends ASTNode {
  readonly type: ASTNodeType.FullText;
  readonly columns: string[];
  readonly query: string;
  readonly mode: FullTextMode;
  readonly language: string;
  readonly parameterName: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `type` | `ASTNodeType.FullText` | Node discriminant (`'fulltext'`). |
| `id` | `string` | Inherited node id. |
| `columns` | `string[]` | Columns concatenated into the `to_tsvector` expression (a single column becomes a one-element array). |
| `query` | `string` | Original search text (the parameter value). |
| `mode` | `FullTextMode` | tsquery parser mode. |
| `language` | `string` | Text-search language embedded in the generated SQL. |
| `parameterName` | `string` | Name of the parameter holding the search text. |

---

### `SubqueryNode`

Extends `ASTNode`. Created by `exists`, `notExists`, `inSubquery`, and `notInSubquery`.

```typescript fragment
interface SubqueryNode extends ASTNode {
  readonly type: ASTNodeType.Subquery;
  readonly column?: string;
  readonly operator: 'EXISTS' | 'NOT EXISTS' | 'IN' | 'NOT IN' | ComparisonOperator;
  readonly subquery: ASTNode;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `type` | `ASTNodeType.Subquery` | Node discriminant (`'subquery'`). |
| `id` | `string` | Inherited node id. |
| `column` | `string` | Left-hand column for `IN`/`NOT IN`; omitted for `EXISTS`/`NOT EXISTS`. Optional. |
| `operator` | `'EXISTS' \| 'NOT EXISTS' \| 'IN' \| 'NOT IN' \| ComparisonOperator` | The subquery operator. |
| `subquery` | `ASTNode` | Root of the nested predicate tree. |

---

## Enums

### `SqlDialect`

Selects the compilation target. Only PostgreSQL is implemented in this version.

| Member | Value | Description |
|--------|-------|-------------|
| `PostgreSQL` | `'postgresql'` | Default. Fully supported end-to-end. |
| `MySQL` | `'mysql'` | Declared only — `compile()` throws `Dialect mysql is not yet implemented`. |
| `MSSQL` | `'mssql'` | Declared only — `compile()` throws `Dialect mssql is not yet implemented`. |
| `SQLite` | `'sqlite'` | Declared only — `compile()` throws `Dialect sqlite is not yet implemented`. |

---

### `ComparisonOperator`

Stored on `ComparisonNode.operator`; each value maps to one terminal `ComparisonBuilder` method.

| Member | Value | Produced by |
|--------|-------|-------------|
| `Equal` | `'='` | `equals`, `equalsColumn` |
| `NotEqual` | `'<>'` | `notEquals` |
| `GreaterThan` | `'>'` | `greaterThan` |
| `GreaterThanOrEqual` | `'>='` | `greaterThanOrEqual` |
| `LessThan` | `'<'` | `lessThan` |
| `LessThanOrEqual` | `'<='` | `lessThanOrEqual` |
| `Like` | `'LIKE'` | `like`, `startsWith`, `endsWith`, `contains` |
| `ILike` | `'ILIKE'` | `ilike` |
| `In` | `'IN'` | `in` |
| `NotIn` | `'NOT IN'` | `notIn` |
| `Between` | `'BETWEEN'` | `between` |
| `NotBetween` | `'NOT BETWEEN'` | `notBetween` |
| `IsNull` | `'IS NULL'` | `isNull` |
| `IsNotNull` | `'IS NOT NULL'` | `isNotNull` |

---

### `LogicalOperator`

Stored on `LogicalNode.operator`.

| Member | Value | Description |
|--------|-------|-------------|
| `And` | `'AND'` | Used by `and` composition and by `search` when a tree already exists. |
| `Or` | `'OR'` | Used by `or` composition. |

---

### `JsonOperator`

Stored on `JsonNode.operator`; rendered as native PostgreSQL JSONB operators.

| Member | Value | Produced by |
|--------|-------|-------------|
| `Contains` | `'@>'` | `jsonContains` |
| `ContainedBy` | `'<@'` | `jsonContainedBy` |
| `HasKey` | `'?'` | `jsonHasKey` |
| `HasAnyKey` | `'?\|'` | `jsonHasAnyKey` |
| `HasAllKeys` | `'?&'` | `jsonHasAllKeys` |
| `PathExists` | `'@?'` | `jsonPathExists` |

---

### `FullTextMode`

Stored on `FullTextNode.mode`; selects the tsquery parser function.

| Member | Value | Generated tsquery function |
|--------|-------|----------------------------|
| `Plain` | `'plain'` | `plainto_tsquery('<lang>', :pN)` |
| `Phrase` | `'phrase'` | `phraseto_tsquery('<lang>', :pN)` |
| `WebSearch` | `'websearch'` | `websearch_to_tsquery('<lang>', :pN)` |

---

### `ASTNodeType`

Discriminant stored on `ASTNode.type`; each value maps to one concrete node interface.

| Member | Value | Node interface |
|--------|-------|----------------|
| `Comparison` | `'comparison'` | `ComparisonNode` |
| `Logical` | `'logical'` | `LogicalNode` |
| `Group` | `'group'` | `GroupNode` |
| `Json` | `'json'` | `JsonNode` |
| `FullText` | `'fulltext'` | `FullTextNode` |
| `Subquery` | `'subquery'` | `SubqueryNode` |

---

## See Also

- expression Overview — what the package is, key features, and the architecture at a glance.
- expression Core Concepts — in-depth explanations of the builder stages, the immutable AST, the parameter manager, JSON operations, full-text search, and subqueries.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
