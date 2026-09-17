> **Package**: `blendsdk/expression`

# expression Core Concepts

---

`blendsdk/expression` is built from a small set of collaborating abstractions: a two-stage fluent builder (`QueryBuilder` → `ComparisonBuilder`), an immutable AST, a parameter manager, and a dialect compiler. This document explains each abstraction in depth, then covers the specialized condition types — JSON/JSONB operations, full-text search, and subqueries — that sit on top of the same pipeline. For a high-level introduction to the package, see Overview.

---

## The Query Builder

**What It Is**

The `QueryBuilder` is the main fluent interface of the package and the object returned by the `query<TSchema>()` factory. It owns the condition tree for a single SQL WHERE clause and carries a schema type parameter `TSchema` that constrains every column name to `keyof TSchema` and every comparison value to the column's declared type. `QueryBuilderImpl` is the exported concrete class; `query()` is the recommended factory, and `new QueryBuilderImpl<TSchema>(options)` is available for advanced use.

**How It Works**

The builder starts with an empty tree (`getAST()` returns `null`) and accumulates conditions as immutable AST nodes. Every recorded condition either becomes the root or is combined with the existing tree:

- The column form of `where(column)` installs its comparison as the new root — use it for the first condition and continue with `and`/`or`.
- The column forms of `and(column)` / `or(column)` combine the next terminal comparison with the current tree through a `LogicalNode` (`AND` / `OR`); if no tree exists yet, the condition becomes the root.
- The callback overloads of `where`/`and`/`or` run a nested builder that shares the parent's `ParameterManager` — so parameter numbering stays continuous (`:p1`, `:p2`, …) — and wrap the nested result in a `GroupNode`, which produces parentheses.
- `search(columns, query, options?)` adds a full-text condition, combined with the existing tree using `AND`.

Compilation is lazy: `compile()` creates the dialect compiler on demand, renders the tree, and returns a `CompileResult` (`sql`, `params`, and optional `debug`). The `sql` fragment excludes the `WHERE` keyword; with no conditions recorded the result is `{ sql: '', params: {} }`.

```typescript
import { query, SqlDialect } from 'blendsdk/expression';

interface User {
  id: number;
  email: string;
  status: 'active' | 'pending' | 'suspended';
  age: number;
}

const result = query<User>({ dialect: SqlDialect.PostgreSQL })
  .where('status')
  .equals('active')
  .and('age')
  .greaterThanOrEqual(18)
  .compile();

console.log(result.sql);
// status = :p1 AND age >= :p2

console.log(result.params);
// { p1: 'active', p2: 18 }
```

**Key Methods and Properties**

`QueryBuilder` methods:

| Name | Signature | Description |
|---|---|---|
| `where` (column form) | `<K extends keyof TSchema>(column: K): ComparisonBuilder<TSchema, K>` | Starts the condition tree with a comparison on `column`; installs the result as the root AST. |
| `where` (callback form) | `(callback: (q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>): QueryBuilder<TSchema>` | Builds a grouped subtree (parentheses) and installs it as the root AST. |
| `and` (column form) | `<K extends keyof TSchema>(column: K): ComparisonBuilder<TSchema, K>` | Adds a comparison combined with the current tree via `AND`. |
| `and` (callback form) | `(callback: (q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>): QueryBuilder<TSchema>` | Adds a parenthesized group combined via `AND`. |
| `or` (column form) | `<K extends keyof TSchema>(column: K): ComparisonBuilder<TSchema, K>` | Adds a comparison combined via `OR`. |
| `or` (callback form) | `(callback: (q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>): QueryBuilder<TSchema>` | Adds a parenthesized group combined via `OR`. |
| `search` | `(columns: string \| string[], query: string, options?: SearchOptions): QueryBuilder<TSchema>` | Adds a full-text search condition, AND-combined with the tree (see [Full-Text Search](#full-text-search)). |
| `debug` | `(): QueryBuilder<TSchema>` | Enables debug mode for subsequent compiles; returns the builder. |
| `compile` | `(): CompileResult` | Renders the tree to SQL and returns `{ sql, params, debug? }`. |
| `getAST` | `(): ASTNode \| null` | Returns the root AST node, or `null` when no condition was recorded. |
| `clone` | `(): QueryBuilder<TSchema>` | `QueryBuilderImpl` only. Returns a new builder with a fresh parameter manager that shares this builder's AST reference. Intended for branching variations; for a fully independent builder, create a new `query()`. |

`QueryOptions` properties:

| Property | Type | Description |
|---|---|---|
| `dialect` | `SqlDialect` | Target SQL dialect. Defaults to `SqlDialect.PostgreSQL`; only PostgreSQL compiles today (see [The PostgreSQL Compiler and Dialects](#the-postgresql-compiler-and-dialects)). |
| `debug` | `boolean` | When `true`, `compile()` attaches a `DebugInfo` object to the result. Defaults to `false`. |

For a guided introduction to building conditions step by step, see Basic Usage.

---

## The Comparison Builder

**What It Is**

`ComparisonBuilder<TSchema, K>` is the intermediate stage returned by the column forms of `where`, `and`, and `or`. It binds a single column (typed as `K extends keyof TSchema`) and exposes the terminal operations — comparisons, pattern matches, JSON operators, full-text search, and subqueries — each of which records one condition and returns the `QueryBuilder` so chaining can continue.

**How It Works**

`ComparisonBuilderImpl` holds the column name, a reference to the parent `QueryBuilder`, the shared `ParameterManager`, and an `addNode` callback supplied by whichever of `where`/`and`/`or` created it — that callback decides how the recorded node is attached (as the root, AND-combined, or OR-combined). Every terminal method follows the same three steps: register the operand value(s) with the parameter manager (which returns a generated name such as `p1`), create a frozen AST node through the package's internal factories, and hand the node to `addNode`, returning the parent builder.

`startsWith`, `endsWith`, and `contains` are sugar: they inject `%` wildcards and delegate to `like`. Two behaviors are worth remembering:

- `equals(null)` and `equals(undefined)` still emit `= :pN` (the parameter manager normalizes the value to `null`); use `isNull()` / `isNotNull()` for SQL NULL checks.
- An empty `in([])` emits `column IN ()`; guard against empty arrays, because PostgreSQL rejects an empty `IN` list at parse time.

```typescript
import { query } from 'blendsdk/expression';

interface Product {
  id: number;
  name: string;
  price: number;
  category: string;
  stock: number;
  discontinued_at: string | null;
}

const { sql, params } = query<Product>()
  .where('price').between(10, 100)
  .and('category').in(['books', 'music'])
  .and('name').startsWith('The ')
  .and('discontinued_at').isNull()
  .compile();

console.log(sql);
// price BETWEEN :p1 AND :p2 AND category IN (:p3, :p4) AND name LIKE :p5 AND discontinued_at IS NULL

console.log(params);
// { p1: 10, p2: 100, p3: 'books', p4: 'music', p5: 'The %' }
```

**Key Methods and Properties**

Core comparison methods — every method returns `QueryBuilder<TSchema>`:

| Name | Signature | Description |
|---|---|---|
| `equals` | `(value: TSchema[K])` | Equality: `column = :pN`. |
| `notEquals` | `(value: TSchema[K])` | Inequality: `column <> :pN`. |
| `greaterThan` | `(value: TSchema[K])` | `column > :pN`. |
| `greaterThanOrEqual` | `(value: TSchema[K])` | `column >= :pN`. |
| `lessThan` | `(value: TSchema[K])` | `column < :pN`. |
| `lessThanOrEqual` | `(value: TSchema[K])` | `column <= :pN`. |
| `between` | `(min: TSchema[K], max: TSchema[K])` | Inclusive range: `column BETWEEN :pN AND :pM`. |
| `notBetween` | `(min: TSchema[K], max: TSchema[K])` | `column NOT BETWEEN :pN AND :pM`. |
| `in` | `(values: TSchema[K][])` | Set membership: `column IN (:p1, …, :pN)`; an empty array emits `column IN ()`. |
| `notIn` | `(values: TSchema[K][])` | `column NOT IN (:p1, …, :pN)`. |
| `isNull` | `()` | `column IS NULL`; no parameter is created. |
| `isNotNull` | `()` | `column IS NOT NULL`; no parameter is created. |

Pattern helpers:

| Name | Signature | Description |
|---|---|---|
| `like` | `(pattern: string)` | `column LIKE :pN`; the pattern is always parameterized. |
| `ilike` | `(pattern: string)` | Case-insensitive `column ILIKE :pN` (PostgreSQL). |
| `startsWith` | `(value: string)` | Sugar for `like` with `value + '%'`. |
| `endsWith` | `(value: string)` | Sugar for `like` with `'%' + value`. |
| `contains` | `(value: string)` | Sugar for `like` with `'%' + value + '%'`. |

Each method above stores its operator as a `ComparisonOperator` enum member — `Equal` (`'='`), `NotEqual` (`'<>'`), `GreaterThan` (`'>'`), `GreaterThanOrEqual` (`'>='`), `LessThan` (`'<'`), `LessThanOrEqual` (`'<='`), `Like` (`'LIKE'`), `ILike` (`'ILIKE'`), `In` (`'IN'`), `NotIn` (`'NOT IN'`), `Between` (`'BETWEEN'`), `NotBetween` (`'NOT BETWEEN'`), `IsNull` (`'IS NULL'`), `IsNotNull` (`'IS NOT NULL'`) — visible on `ComparisonNode.operator` when you inspect the AST. The remaining comparison-stage methods have dedicated sections: [JSON and JSONB Operations](#json-and-jsonb-operations), [Full-Text Search](#full-text-search), and [Subqueries](#subqueries).

---

## Logical Composition and Grouping

**What It Is**

Logical composition is the mechanism that combines multiple conditions into a boolean expression: the `and`/`or` methods (with column or callback arguments) and the parentheses produced by callback groups. `LogicalOperator` (`AND`, `OR`) is the enum stored on every `LogicalNode`.

**How It Works**

- **Column form** — `.and('x').equals(1)` asks the comparison builder for column `x`; its `addNode` callback wraps the current tree and the new node in `LogicalNode(And, current, node)`. The `or` form uses `LogicalOperator.Or` instead.
- **Callback form** — `.and(q => …)` creates a nested builder that shares the parent's `ParameterManager`, runs the callback to build a subtree, wraps it in a `GroupNode`, and combines that group with the parent tree using the requested operator. Because the manager is shared, placeholders remain sequential across all groups (`:p1`, `:p2`, …).
- **Empty groups** — a callback that records no conditions contributes nothing; `and(q => q)` is ignored.
- **Precedence** — plain `and`/`or` chains are emitted without implicit parentheses, so callback groups are the only construct that emits them. Whenever a condition mixes `AND` with `OR`, wrap the mixed part in a callback group so the emitted SQL has explicit parentheses.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  role: string;
  age: number;
  verified: boolean;
}

const { sql, params } = query<User>()
  .where('role').equals('admin')
  .or(q => q
    .where('age').greaterThan(65)
    .and('verified').equals(true)
  )
  .compile();

console.log(sql);
// role = :p1 OR (age > :p2 AND verified = :p3)

console.log(params);
// { p1: 'admin', p2: 65, p3: true }
```

**Key Methods and Properties**

Combination methods — both overloads return either a `ComparisonBuilder` (to continue with a terminal method) or the `QueryBuilder` (when a callback is supplied):

| Name | Signature | Description |
|---|---|---|
| `and` (column form) | `<K extends keyof TSchema>(column: K): ComparisonBuilder<TSchema, K>` | The next terminal comparison is AND-combined with the current tree. |
| `and` (callback form) | `(callback: (q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>): QueryBuilder<TSchema>` | The callback's subtree is wrapped in parentheses and AND-combined. |
| `or` (column form) | `<K extends keyof TSchema>(column: K): ComparisonBuilder<TSchema, K>` | The next terminal comparison is OR-combined with the current tree. |
| `or` (callback form) | `(callback: (q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>): QueryBuilder<TSchema>` | The callback's subtree is wrapped in parentheses and OR-combined. |

`LogicalOperator` values:

| Member | Value | Description |
|---|---|---|
| `LogicalOperator.And` | `'AND'` | Stored on logical nodes created by `and(...)`. |
| `LogicalOperator.Or` | `'OR'` | Stored on logical nodes created by `or(...)`. |

---

## The Immutable AST

**What It Is**

The abstract syntax tree (AST) is the intermediate representation that every builder method produces: a tree of frozen node objects describing comparisons, boolean operators, groups, JSON operations, full-text searches, and subqueries. Every node extends the `ASTNode` base interface (fields `type` and `id`) and implements one of six shapes keyed by the `ASTNodeType` enum.

**How It Works**

Nodes are created by internal factory functions and immediately frozen with `Object.freeze` — they are never mutated after creation. Extending a query creates new logical and group nodes that reference existing subtrees, so any AST reference you capture (via `getAST()`, `DebugInfo.ast`, or a stored builder) remains a stable snapshot. Each node receives a generated id (`node_1`, `node_2`, …) from a module-level counter; ids are unique within a process but are not stable across runs.

Discriminate node kinds by comparing `node.type` against the `ASTNodeType` enum, then annotate with the corresponding public interface (`ComparisonNode`, `LogicalNode`, `GroupNode`, `JsonNode`, `FullTextNode`, `SubqueryNode`) when writing your own traversal helpers.

```typescript
import { query, ASTNodeType } from 'blendsdk/expression';
import type {
  ASTNode,
  ComparisonNode,
  GroupNode,
  LogicalNode,
} from 'blendsdk/expression';

interface Article {
  id: number;
  title: string;
  published: boolean;
}

function describe(node: ASTNode): string {
  switch (node.type) {
    case ASTNodeType.Comparison: {
      const comparison = node as ComparisonNode;
      return `Comparison(${comparison.column} ${comparison.operator})`;
    }
    case ASTNodeType.Logical: {
      const logical = node as LogicalNode;
      return `${logical.operator}(${describe(logical.left)}, ${describe(logical.right)})`;
    }
    case ASTNodeType.Group: {
      const group = node as GroupNode;
      return `Group(${describe(group.child)})`;
    }
    default:
      return node.type;
  }
}

const ast: ASTNode | null = query<Article>()
  .where('published')
  .equals(true)
  .and(q =>
    q
      .where('title')
      .like('%SQL%')
      .or('title')
      .like('%database%')
  )
  .getAST();

if (ast) {
  console.log(describe(ast));
  // AND(Comparison(published =), Group(OR(Comparison(title LIKE), Comparison(title LIKE))))
}
```

**Key Methods and Properties**

Node types, their shapes, and where they come from:

| `ASTNodeType` | Interface | Shape / key fields | Produced by |
|---|---|---|---|
| `Comparison` (`'comparison'`) | `ComparisonNode` | `column`, `operator` (`ComparisonOperator`), `value?`, `values?`, `parameterNames?` | Column comparisons (`equals`, `between`, `like`, `in`, …) and `equalsColumn`. |
| `Logical` (`'logical'`) | `LogicalNode` | `operator` (`LogicalOperator`), `left`, `right` | `and`/`or` composition. |
| `Group` (`'group'`) | `GroupNode` | `child` | Callback overloads of `where`/`and`/`or`. |
| `Json` (`'json'`) | `JsonNode` | `column`, `operator` (`JsonOperator`), `value?`, `path?`, `keys?`, `parameterName?` | `jsonContains`, `jsonHasKey`, `jsonPathExists`, … |
| `FullText` (`'fulltext'`) | `FullTextNode` | `columns`, `query`, `mode`, `language`, `parameterName` | `search(...)`. |
| `Subquery` (`'subquery'`) | `SubqueryNode` | `column?`, `operator`, `subquery` | `exists`, `notExists`, `inSubquery`, `notInSubquery`. |

---

## The Parameter Manager

**What It Is**

`ParameterManager` is the component that turns every user-supplied value into a bind parameter. It generates sequential names (`p1`, `p2`, …), stores serialized values, and formats placeholders per dialect. A `query()` call creates one manager per builder; nested group builders share it; the compiler consults it for placeholder syntax, and `compile()` returns its parameter map as `CompileResult.params`.

**How It Works**

`addParameterWithValue(value)` increments the counter, generates the next name, serializes the value, and stores it in a `Map`. Serialization normalizes `undefined` to `null`, converts `Date` instances to ISO-8601 strings, and keeps arrays and objects as-is so the database driver can serialize them (for example, as JSONB). `formatParameterPlaceholder(name)` renders the dialect-specific placeholder: `:p1` for PostgreSQL, `?` for MySQL/SQLite, `@p1` for MSSQL. Note that the `:` prefix appears only in the rendered SQL — `compile()` keys `params` by the bare names (`p1`, `p2`, …).

`deduplicateParameter(value)` is available for manual reuse of an existing parameter with an identical serialized value, but the builders do not call it: identical literals each receive their own placeholder. `clone()` produces an independent copy of the registry state (counter plus values).

```typescript
import { ParameterManager, SqlDialect } from 'blendsdk/expression';

const manager = new ParameterManager(SqlDialect.PostgreSQL);

const firstName = manager.addParameterWithValue('active');
const secondName = manager.addParameterWithValue(new Date('2024-01-01T00:00:00.000Z'));
const thirdName = manager.addParameterWithValue(undefined);

console.log(firstName);  // p1
console.log(secondName); // p2
console.log(thirdName);  // p3

console.log(manager.formatParameterPlaceholder(firstName)); // :p1
console.log(manager.getParameters());
// { p1: 'active', p2: '2024-01-01T00:00:00.000Z', p3: null }
console.log(manager.getParameterCount()); // 3
```

**Key Methods and Properties**

Constructor: `new ParameterManager(dialect?: SqlDialect)` — defaults to `SqlDialect.PostgreSQL`.

| Name | Signature | Description |
|---|---|---|
| `generateParameterName` | `(): string` | Increments the counter and returns the next name (`p1`, `p2`, …). |
| `addParameter` | `(name: string, value: unknown): void` | Serializes and stores a value under a specific name. |
| `addParameterWithValue` | `(value: unknown): string` | Generates a name, stores the value, and returns the name. |
| `getParameter` | `(name: string): unknown` | Returns the stored (serialized) value, or `undefined` if absent. |
| `hasParameter` | `(name: string): boolean` | Whether a parameter with the given name exists. |
| `getParameters` | `(): Record<string, unknown>` | All parameters as a plain object — the shape used by `CompileResult.params`. |
| `getParameterCount` | `(): number` | Number of parameter names generated so far. |
| `reset` | `(): void` | Clears the counter and all stored values. |
| `formatParameterPlaceholder` | `(name: string): string` | Dialect placeholder for a name: `:p1` (PostgreSQL), `?` (MySQL/SQLite), `@p1` (MSSQL). |
| `serializeParameter` | `(value: unknown): unknown` | Normalizes a value: `undefined` → `null`, `Date` → ISO string, arrays and objects unchanged. |
| `deduplicateParameter` | `(value: unknown): string \| null` | Returns the name of an existing parameter with an identical serialized value, or `null`. Not used automatically by the builders. |
| `clone` | `(): ParameterManager` | Returns an independent copy of the registry state. |

---

## The PostgreSQL Compiler and Dialects

**What It Is**

`PostgreSQLCompiler` is the strategy that renders an AST into a PostgreSQL predicate string. `SqlDialect` selects the target dialect; the enum declares `PostgreSQL`, `MySQL`, `MSSQL`, and `SQLite`, but only PostgreSQL is implemented — the other members throw at compile time.

**How It Works**

`QueryBuilderImpl.compile()` picks a compiler based on the dialect and hands it the builder's `ParameterManager`. The compiler walks the tree in a single pass, dispatching on node type, and builds the SQL text; placeholders are formatted through the manager, so every literal appears as `:pN` instead of an inline value. The compiler also exposes diagnostics — `getOptimizations()` and `getWarnings()` — which `compile()` surfaces through `DebugInfo`; the current compiler never populates either list. You can use the compiler directly when you keep an AST around for custom pipelines; it needs a parameter manager only to format placeholder names.

```typescript
import {
  query,
  PostgreSQLCompiler,
  ParameterManager,
  SqlDialect,
} from 'blendsdk/expression';
import type { ASTNode } from 'blendsdk/expression';

interface User {
  id: number;
  status: string;
  age: number;
}

const builder = query<User>()
  .where('status')
  .equals('active')
  .and('age')
  .greaterThan(18);

const ast: ASTNode | null = builder.getAST();
const { params } = builder.compile();

if (!ast) {
  throw new Error('Add at least one condition before compiling the AST.');
}

const compiler = new PostgreSQLCompiler(new ParameterManager(SqlDialect.PostgreSQL));
const sql = compiler.compile(ast);

console.log(sql);
// status = :p1 AND age > :p2

console.log(params);
// { p1: 'active', p2: 18 }

console.log(compiler.getOptimizations()); // []
console.log(compiler.getWarnings()); // []
```

**Key Methods and Properties**

Dialect support:

| `SqlDialect` member | Value | Compilation status |
|---|---|---|
| `PostgreSQL` | `'postgresql'` | Fully supported (the default). |
| `MySQL` | `'mysql'` | Not implemented — `compile()` throws `Dialect mysql is not yet implemented`. |
| `MSSQL` | `'mssql'` | Not implemented — `compile()` throws `Dialect mssql is not yet implemented`. |
| `SQLite` | `'sqlite'` | Not implemented — `compile()` throws `Dialect sqlite is not yet implemented`. |

Compiler methods — constructor: `new PostgreSQLCompiler(paramManager: ParameterManager)`:

| Name | Signature | Description |
|---|---|---|
| `compile` | `(ast: ASTNode): string` | Renders the AST to SQL text; placeholders are formatted via the parameter manager. |
| `getOptimizations` | `(): string[]` | Optimization notes recorded during compilation (currently always empty). |
| `getWarnings` | `(): string[]` | Compiler warnings (currently always empty). |

Node-to-SQL mapping (PostgreSQL):

| AST node | Rendered SQL |
|---|---|
| Comparison (`=`, `<>`, `>`, `>=`, `<`, `<=`, `LIKE`, `ILIKE`) | `column op :pN` |
| Comparison (`BETWEEN` / `NOT BETWEEN`) | `column BETWEEN :pN AND :pM` |
| Comparison (`IN` / `NOT IN`) | `column IN (:p1, …, :pN)` |
| Comparison (`IS NULL` / `IS NOT NULL`) | `column IS NULL` / `column IS NOT NULL` |
| Comparison without parameter (column reference) | `column = other_column` — no placeholder, used by `equalsColumn` |
| Logical | `left AND right` / `left OR right` |
| Group | `(child)` |
| JSON | `column @> :pN`, `<@`, `?`, `?\|`, `?&`, `@?` according to `JsonOperator` |
| FullText | `to_tsvector('<lang>', <columns>) @@ <mode>to_tsquery('<lang>', :pN)` |
| Subquery | `EXISTS (SELECT 1 WHERE <predicate>)` / `column IN (SELECT * WHERE <predicate>)` |

---

## Compilation Results and Debug Mode

**What It Is**

`CompileResult` is the value returned by `compile()`: the SQL predicate fragment, the parameter bindings, and — in debug mode — a `DebugInfo` object. Debug mode is enabled either with `query({ debug: true })` or by calling `.debug()` on the builder before compiling.

**How It Works**

`compile()` measures the operation with `performance.now()` (from `node:perf_hooks`) and, when debug mode is on, attaches a `DebugInfo` snapshot: the root `ast`, the compiler's `optimizations` and `warnings` lists, the `parameterCount`, and the `compilationTime` in milliseconds. For an empty query, `sql` is an empty string, `params` is `{}`, and the debug warnings contain `'No conditions specified'`. The `sql` string never contains the `WHERE` keyword — append it to your own statement and bind `params` through your database driver (placeholder style is dialect-specific; PostgreSQL uses `:p1`).

```typescript
import { query } from 'blendsdk/expression';

interface Order {
  id: number;
  total: number;
  status: string;
}

const result = query<Order>({ debug: true })
  .where('status')
  .equals('paid')
  .and('total')
  .greaterThan(100)
  .compile();

console.log(result.sql);
// status = :p1 AND total > :p2

console.log(result.params);
// { p1: 'paid', p2: 100 }

console.log(result.debug?.parameterCount); // 2
console.log(result.debug?.warnings); // []
console.log(result.debug?.compilationTime); // e.g. 0.35 (milliseconds)

const empty = query<Order>({ debug: true }).compile();

console.log(empty.sql); // ''
console.log(empty.debug?.warnings); // ['No conditions specified']
```

**Key Methods and Properties**

`CompileResult` properties:

| Property | Type | Description |
|---|---|---|
| `sql` | `string` | Generated predicate fragment without the `WHERE` keyword; `''` when no conditions were recorded. |
| `params` | `Record<string, unknown>` | Serialized parameter values keyed by placeholder name (`p1`, `p2`, …). |
| `debug` | `DebugInfo \| undefined` | Present only when debug mode is enabled. |

`DebugInfo` properties:

| Property | Type | Description |
|---|---|---|
| `ast` | `ASTNode` | Root of the compiled tree. |
| `optimizations` | `string[]` | Optimizations applied by the compiler (currently none). |
| `parameterCount` | `number` | Number of parameters generated for the query. |
| `compilationTime` | `number` | Time spent compiling, in milliseconds. |
| `warnings` | `string[]` | Warnings, for example `'No conditions specified'` for an empty query. |

---

## JSON and JSONB Operations

**What It Is**

JSON operations are comparison-stage methods that map to PostgreSQL's native JSON/JSONB operators: containment (`@>`, `<@`), key existence (`?`, `?|`, `?&`), and JSON path existence (`@?`). Each method is exposed on `ComparisonBuilder` and records a `JsonNode` carrying a `JsonOperator`.

**How It Works**

Each method registers its operand — an object, an array, a key name, or a path — as a single parameter, creates a `JsonNode` with the column and operator, and attaches it to the tree like any other condition. Values are stored in their original form: the builder does not stringify objects or arrays, leaving JSON serialization to the database driver. The compiler renders the operator with the placeholder, for example `metadata @> :p1`.

```typescript
import { query } from 'blendsdk/expression';

interface Document {
  id: number;
  metadata: Record<string, unknown>;
  tags: string[];
}

const { sql, params } = query<Document>()
  .where('metadata').jsonContains({ published: true })
  .and('tags').jsonHasAllKeys(['typescript', 'sql'])
  .compile();

console.log(sql);
// metadata @> :p1 AND tags ?& :p2

console.log(params);
// { p1: { published: true }, p2: ['typescript', 'sql'] }
```

**Key Methods and Properties**

JSON comparison methods — every method returns `QueryBuilder<TSchema>`:

| Name | Signature | Description |
|---|---|---|
| `jsonContains` | `(value: unknown)` | JSONB containment: `column @> :pN`. |
| `jsonContainedBy` | `(value: unknown)` | Reverse containment: `column <@ :pN`. |
| `jsonHasKey` | `(key: string)` | Top-level key exists: `column ? :pN`. |
| `jsonHasAnyKey` | `(keys: string[])` | Any of the keys exist: `column ?\| :pN` (array parameter). |
| `jsonHasAllKeys` | `(keys: string[])` | All of the keys exist: `column ?& :pN` (array parameter). |
| `jsonPathExists` | `(path: string)` | JSON path exists: `column @? :pN`. |

`JsonOperator` values (stored on `JsonNode.operator`):

| Member | Value | Used by |
|---|---|---|
| `Contains` | `'@>'` | `jsonContains` |
| `ContainedBy` | `'<@'` | `jsonContainedBy` |
| `HasKey` | `'?'` | `jsonHasKey` |
| `HasAnyKey` | `'?\|'` | `jsonHasAnyKey` |
| `HasAllKeys` | `'?&'` | `jsonHasAllKeys` |
| `PathExists` | `'@?'` | `jsonPathExists` |

---

## Full-Text Search

**What It Is**

`search()` builds a PostgreSQL text-search predicate (`to_tsvector(...) @@ to_tsquery(...)`) for one or more columns. It is available in two places: on `QueryBuilder` for searching across multiple columns, and on `ComparisonBuilder` for a single column. `SearchOptions` controls the mode and language; `FullTextMode` enumerates the three query-parsing modes.

**How It Works**

`search()` registers the search text as a parameter and creates a `FullTextNode` with the column list (a single column becomes a one-element array), the mode (default `Plain`), the language (default `'english'`), and the parameter name. The compiler builds `to_tsvector('<language>', <column>)` — or, for multiple columns, `to_tsvector('<language>', col1 || ' ' || col2)` with the columns joined by spaces — and compares it with `@@` against the mode-specific tsquery function: `plainto_tsquery`, `phraseto_tsquery`, or `websearch_to_tsquery`. For example, `.where('content').search('javascript')` produces `to_tsvector('english', content) @@ plainto_tsquery('english', :p1)`.

The language name is embedded directly into the generated SQL text (not parameterized), so use a fixed developer-chosen language identifier such as `'english'`; the search text itself is always parameterized. On `QueryBuilder`, `search()` is AND-combined with existing conditions.

```typescript
import { query } from 'blendsdk/expression';

interface Post {
  id: number;
  title: string;
  body: string;
}

const { sql, params } = query<Post>()
  .search(['title', 'body'], 'typescript generics', {
    mode: 'websearch',
    language: 'english',
  })
  .compile();

console.log(sql);
// to_tsvector('english', title || ' ' || body) @@ websearch_to_tsquery('english', :p1)

console.log(params);
// { p1: 'typescript generics' }
```

**Key Methods and Properties**

Search methods — each returns `QueryBuilder<TSchema>`:

| Name | Signature | Description |
|---|---|---|
| `QueryBuilder.search` | `(columns: string \| string[], query: string, options?: SearchOptions)` | Full-text search across one or more columns; AND-combined with the current tree. |
| `ComparisonBuilder.search` | `(query: string, options?: SearchOptions)` | Full-text search on the bound column (a one-column search). |

`SearchOptions` properties:

| Property | Type | Description |
|---|---|---|
| `mode` | `'plain' \| 'phrase' \| 'websearch'` | Tsquery parser mode. Defaults to `'plain'`. |
| `language` | `string` | Text-search language embedded in the SQL. Defaults to `'english'`. |

`FullTextMode` values (stored on `FullTextNode.mode`):

| Member | Value | Generated tsquery function |
|---|---|---|
| `Plain` | `'plain'` | `plainto_tsquery('<lang>', :pN)` |
| `Phrase` | `'phrase'` | `phraseto_tsquery('<lang>', :pN)` |
| `WebSearch` | `'websearch'` | `websearch_to_tsquery('<lang>', :pN)` — supports web-style search operators. |

---

## Subqueries

**What It Is**

Subqueries let a condition reference another query: `exists` / `notExists` for correlated existence checks, `inSubquery` / `notInSubquery` for membership against a subquery, and `equalsColumn` for comparing a column against another column (the correlated reference used inside a subquery). All four subquery methods accept any `QueryBuilder` and record a `SubqueryNode`; `equalsColumn` records a regular comparison whose right side is a raw column reference.

**How It Works**

Each subquery method extracts the subquery's AST with `getAST()` and throws `Error('Subquery must have at least one condition')` if the subquery is empty. For `EXISTS` / `NOT EXISTS` the compiler renders `EXISTS (SELECT 1 WHERE <sub-predicate>)` — the parent-side column is not used in the output. For `IN` / `NOT IN` it renders `column IN (SELECT * WHERE <sub-predicate>)` using the column the subquery method was called on. `equalsColumn` compiles to `customer_id = customers.id` with no parameter; because the string is embedded directly into the SQL, only pass trusted, developer-controlled column references.

**Parameter scope.** Parameter values live in the builder that registered them. A subquery constructed with its own `query()` call has its own `ParameterManager` (see [The Parameter Manager](#the-parameter-manager)), so the parent's `compile()` returns only the parent's `params`. When a subquery filters on literal values, compile the subquery as well and bind its `params` together with the parent's; since each builder numbers placeholders independently from `p1`, check the merged maps for name collisions.

```typescript
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

// Correlated sub-query: orders that belong to the customer row being filtered
const correlatedOrders = query<Order>()
  .where('customer_id').equalsColumn('customers.id');

const { sql, params } = query<Customer>()
  .where('id').exists(correlatedOrders)
  .compile();

console.log(sql);
// EXISTS (SELECT 1 WHERE customer_id = customers.id)

console.log(params);
// {}
```

**Key Methods and Properties**

Subquery methods — each returns `QueryBuilder<TSchema>`:

| Name | Signature | Description |
|---|---|---|
| `exists` | `(subquery: QueryBuilder)` | `EXISTS (SELECT 1 WHERE <predicate>)`; the parent-side column is not used in the output. |
| `notExists` | `(subquery: QueryBuilder)` | `NOT EXISTS (SELECT 1 WHERE <predicate>)`. |
| `inSubquery` | `(subquery: QueryBuilder)` | `column IN (SELECT * WHERE <predicate>)`. |
| `notInSubquery` | `(subquery: QueryBuilder)` | `column NOT IN (SELECT * WHERE <predicate>)`. |
| `equalsColumn` | `(column: string): QueryBuilder<TSchema>` | Emits `column = <reference>` with no parameter (correlated column comparison). |

The exported `SubqueryBuilder` type extends `QueryBuilder` with `select(...columns)` and `aggregate(func)` declarations, but version 5.x ships no concrete implementation of those subquery extensions — all subquery methods above operate on ordinary `QueryBuilder` instances.

---

# expression Basic Usage

---

This guide walks from installation to a working, parameterized SQL predicate: the fluent builder workflow (`query()` → `where` / `and` / `or` → `compile()`), the shape of the compile result, the comparison methods, and the errors you may encounter along the way. For the package's design — immutable AST, parameter manager, and compiler — see Core Concepts.

---

## Installation

Add the package with your package manager of choice:

```bash
# npm
npm install blendsdk/expression

# yarn
yarn add blendsdk/expression

# pnpm
pnpm add blendsdk/expression
```

> **Note**: `blendsdk/expression` is distributed as part of the BlendSDK package family; inside the BlendSDK monorepo the dependency is resolved through the workspace. See the Overview for distribution details.

Environment requirements:

| Requirement | Detail |
|---|---|
| Node.js | `>= 22.0.0` |
| Module system | ESM only — use `import`; CommonJS `require()` is not supported |
| TypeScript | `strict` mode recommended so the schema types fully apply; declarations ship with the package |
| Runtime dependencies | None |

In `tsconfig.json`, use `"module": "NodeNext"` (with the matching `"moduleResolution": "NodeNext"`) so the ESM entry point and its type declarations resolve correctly.

---

## Quick Start

The whole workflow in one snippet — create a typed builder, chain conditions, compile to a parameterized SQL fragment:

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  status: string;
  age: number;
}

const { sql, params } = query<User>()
  .where('status').equals('active')
  .and('age').greaterThan(18)
  .compile();

console.log(sql);
// status = :p1 AND age > :p2

console.log(params);
// { p1: 'active', p2: 18 }
```

The `sql` fragment never contains the `WHERE` keyword and never contains literal values — values travel separately in `params`, so user input can never be injected into the statement. Append the fragment to your own SQL and bind the parameters with your database driver.

---

## Fundamentals

The sections below introduce the API one concept at a time, starting from the simplest query and adding one capability per step. Every example is complete — imports included — and can be run as-is.

### Creating a Query Builder

`query<TSchema>(options?)` creates a `QueryBuilder<TSchema>` — the object that owns the condition tree for a single SQL WHERE clause. The builder starts empty: `getAST()` returns `null` until the first condition is recorded.

```typescript
import { query } from 'blendsdk/expression';
import type { QueryBuilder } from 'blendsdk/expression';

interface User {
  id: number;
  email: string;
  status: string;
  age: number;
}

const builder: QueryBuilder<User> = query<User>();

console.log(builder.getAST());
// null — no conditions recorded yet
```

The exported `QueryBuilderImpl` class is an equivalent, advanced alternative to the factory:

```typescript fragment
import { query, QueryBuilderImpl } from 'blendsdk/expression';

interface User {
  id: number;
  status: string;
}

const fromFactory = query<User>();               // recommended
const fromClass = new QueryBuilderImpl<User>();  // equivalent, advanced use
```

### Typing Your Schema

The schema type argument enables compile-time verification of both sides of every comparison: column names are constrained to `keyof TSchema`, and once a column is bound, its values are constrained to that column's declared type. Typos and mismatched values fail before any SQL is generated.

```typescript fragment
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  email: string;
  age: number;
  status: 'active' | 'pending' | 'suspended';
}

// Column names are constrained to keyof User:
query<User>().where('staus');
// Error: 'staus' is not a key of User

// Values are constrained to the bound column's type:
query<User>().where('age').equals('old');
// Error: 'old' is not assignable to number

query<User>().where('status').equals('deleted');
// Error: 'deleted' is not assignable to the status union
```

Narrowed union types (`status` above) and nullable columns (`string | null`) are enforced the same way. Supplying a schema type is optional, but it is the main reason to use this package over hand-written SQL.

### Your First Condition

The fluent API alternates between two stages. `where('status')` returns a `ComparisonBuilder<User, 'status'>` — an intermediate stage bound to exactly one column. Calling a terminal method such as `equals(value)` records the comparison in the tree and returns the `QueryBuilder`, so the chain can continue.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  email: string;
  status: string;
  age: number;
}

const { sql, params } = query<User>()
  .where('status')
  .equals('active')
  .compile();

console.log(sql);
// status = :p1

console.log(params);
// { p1: 'active' }
```

Notice that the value `'active'` never appears in the SQL text: it is registered as parameter `p1`, and `:p1` is embedded in its place. `where` also has a callback overload for grouping — covered in [Grouping Conditions with Callbacks](#grouping-conditions-with-callbacks).

### Reading the Compile Result

`compile()` returns a `CompileResult`:

| Field | Type | Description |
|---|---|---|
| `sql` | `string` | The generated predicate fragment, without the `WHERE` keyword; `''` when no conditions were recorded. |
| `params` | `Record<string, unknown>` | Serialized parameter values keyed by placeholder name (`p1`, `p2`, …). |
| `debug` | `DebugInfo \| undefined` | Included only when debug mode is enabled — see [Configuration](#configuration). |

Append `sql` to your own statement and bind `params` with your driver:

```typescript
import { query } from 'blendsdk/expression';

interface Order {
  id: number;
  total: number;
  status: string;
}

const result = query<Order>()
  .where('status').equals('paid')
  .and('total').greaterThan(100)
  .compile();

const statement = `SELECT id, total FROM orders WHERE ${result.sql}`;

console.log(statement);
// SELECT id, total FROM orders WHERE status = :p1 AND total > :p2

console.log(result.params);
// { p1: 'paid', p2: 100 }
```

The `params` keys are the bare parameter names (`p1`, `p2`, …) — the `:` prefix appears only in the rendered SQL text.

### Combining Conditions with AND

`and(column)` returns a fresh comparison stage for the next column; the resulting comparison is combined with the accumulated tree through an `AND` node. (If no condition exists yet, the comparison simply becomes the root, so `and` also works as the first call.)

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  status: string;
  age: number;
  verified: boolean;
}

const { sql, params } = query<User>()
  .where('status').equals('active')
  .and('age').greaterThan(18)
  .and('verified').equals(true)
  .compile();

console.log(sql);
// status = :p1 AND age > :p2 AND verified = :p3

console.log(params);
// { p1: 'active', p2: 18, p3: true }
```

### Combining Conditions with OR

`or(column)` works exactly like `and(column)`, but combines with `OR`:

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  role: string;
}

const { sql, params } = query<User>()
  .where('role').equals('admin')
  .or('role').equals('moderator')
  .compile();

console.log(sql);
// role = :p1 OR role = :p2

console.log(params);
// { p1: 'admin', p2: 'moderator' }
```

Chain methods are applied left to right, and no implicit parentheses are added, so mixing `AND` and `OR` in a single chain relies on SQL operator precedence rather than on the order of your calls. The next section shows how to control grouping explicitly.

### Grouping Conditions with Callbacks

Every chain method has a callback overload: `where(q => ...)`, `and(q => ...)`, and `or(q => ...)`. The callback receives a nested `QueryBuilder`; everything it records is wrapped in parentheses and combined with the rest of the query through the enclosing chain method. Used as the first call, `where(q => ...)` installs the group as the root of the tree; `and(q => ...)` / `or(q => ...)` combine the group with the accumulated conditions using `AND` / `OR`.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  status: string;
  age: number;
  verified: boolean;
}

const { sql, params } = query<User>()
  .where('status').equals('active')
  .and(q => q
    .where('age').greaterThan(65)
    .or('verified').equals(true)
  )
  .compile();

console.log(sql);
// status = :p1 AND (age > :p2 OR verified = :p3)

console.log(params);
// { p1: 'active', p2: 65, p3: true }
```

Nested builders share the parent's parameter manager, so placeholder numbering stays sequential across groups. Groups can be nested as deeply as needed, and a callback that records no conditions is ignored.

### Ordering Comparisons

While `equals` and `notEquals` map to `=` and `<>`, the ordering family covers ranges of values: `greaterThan`, `greaterThanOrEqual`, `lessThan`, and `lessThanOrEqual`.

```typescript
import { query } from 'blendsdk/expression';

interface Product {
  id: number;
  price: number;
  stock: number;
  category: string;
}

const { sql, params } = query<Product>()
  .where('price').greaterThanOrEqual(10)
  .and('price').lessThan(100)
  .and('stock').greaterThan(0)
  .and('category').notEquals('clearance')
  .compile();

console.log(sql);
// price >= :p1 AND price < :p2 AND stock > :p3 AND category <> :p4

console.log(params);
// { p1: 10, p2: 100, p3: 0, p4: 'clearance' }
```

The same column can appear in several conditions — each comparison is its own node and receives its own parameter.

### Ranges and Sets

Two methods cover multi-value comparisons in a single call:

- `between(min, max)` — inclusive range; registers two parameters and renders `column BETWEEN :pN AND :pM`.
- `in(values)` — set membership; registers one parameter per element and renders `column IN (:p1, …, :pN)`.

Both have negated twins: `notBetween` and `notIn`.

```typescript
import { query } from 'blendsdk/expression';

interface Order {
  id: number;
  total: number;
  status: string;
}

const { sql, params } = query<Order>()
  .where('total').between(50, 500)
  .and('status').in(['paid', 'shipped'])
  .compile();

console.log(sql);
// total BETWEEN :p1 AND :p2 AND status IN (:p3, :p4)

console.log(params);
// { p1: 50, p2: 500, p3: 'paid', p4: 'shipped' }
```

> **Warning**: `in([])` renders `column IN ()`, which PostgreSQL rejects at parse time. Guard against empty arrays before calling `in` or `notIn`.

### Pattern Matching

`startsWith`, `endsWith`, and `contains` are the simple options — they wrap the value with the appropriate `%` wildcards and delegate to `LIKE`:

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  email: string;
}

const { sql, params } = query<User>()
  .where('name').startsWith('Jo')
  .and('name').contains('han')
  .and('email').ilike('%@example.com')
  .compile();

console.log(sql);
// name LIKE :p1 AND name LIKE :p2 AND email ILIKE :p3

console.log(params);
// { p1: 'Jo%', p2: '%han%', p3: '%@example.com' }
```

For full control over the pattern, use `like(pattern)` — the pattern is passed through unchanged and always parameterized. `ilike(pattern)` is the case-insensitive PostgreSQL variant.

### NULL Checks

`isNull()` and `isNotNull()` render `IS NULL` / `IS NOT NULL` checks and register no parameters:

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  email: string;
  deleted_at: string | null;
}

const { sql, params } = query<User>()
  .where('deleted_at').isNull()
  .and('email').isNotNull()
  .compile();

console.log(sql);
// deleted_at IS NULL AND email IS NOT NULL

console.log(params);
// {}
```

> **Note**: `equals(null)` and `equals(undefined)` are normalized by the parameter manager and still render `deleted_at = :p1` with a `null` parameter — they are not SQL `IS NULL` checks. Use `isNull()` / `isNotNull()` for null semantics.

### JSON and JSONB Filters

The comparison stage exposes PostgreSQL's JSON/JSONB operators. Each method registers exactly one parameter whose value is passed to the database driver unchanged — the driver handles JSON serialization.

```typescript
import { query } from 'blendsdk/expression';

interface Document {
  id: number;
  metadata: Record<string, unknown>;
  tags: string[];
}

const { sql, params } = query<Document>()
  .where('metadata').jsonContains({ published: true })
  .and('tags').jsonHasAllKeys(['typescript', 'sql'])
  .compile();

console.log(sql);
// metadata @> :p1 AND tags ?& :p2

console.log(params);
// { p1: { published: true }, p2: ['typescript', 'sql'] }
```

| Method | Operator | Checks |
|---|---|---|
| `jsonContains(value)` | `@>` | The column contains the given JSON value. |
| `jsonContainedBy(value)` | `<@` | The column is contained by the given JSON value. |
| `jsonHasKey(key)` | `?` | A top-level key exists. |
| `jsonHasAnyKey(keys)` | `?\|` | Any of the given keys exist. |
| `jsonHasAllKeys(keys)` | `?&` | All of the given keys exist. |
| `jsonPathExists(path)` | `@?` | A JSON path matches. |

### Full-Text Search

Full-text search is available on both stages. On a single column, use `search(query)` from the comparison stage — the simplest form:

```typescript
import { query } from 'blendsdk/expression';

interface Post {
  id: number;
  title: string;
  body: string;
}

const { sql, params } = query<Post>()
  .where('body').search('javascript')
  .compile();

console.log(sql);
// to_tsvector('english', body) @@ plainto_tsquery('english', :p1)

console.log(params);
// { p1: 'javascript' }
```

The next level is `search(columns, query, options)` on the builder itself, which searches across multiple columns (joined with spaces) and is combined with the rest of the tree using `AND`:

```typescript
import { query } from 'blendsdk/expression';

interface Post {
  id: number;
  title: string;
  body: string;
}

const { sql, params } = query<Post>()
  .search(['title', 'body'], 'typescript generics', {
    mode: 'websearch',
    language: 'english',
  })
  .compile();

console.log(sql);
// to_tsvector('english', title || ' ' || body) @@ websearch_to_tsquery('english', :p1)

console.log(params);
// { p1: 'typescript generics' }
```

`SearchOptions`:

| Name | Type | Default | Description |
|---|---|---|---|
| `mode` | `'plain' \| 'phrase' \| 'websearch'` | `'plain'` | Selects `plainto_tsquery`, `phraseto_tsquery`, or `websearch_to_tsquery`. |
| `language` | `string` | `'english'` | Text-search configuration embedded directly in the SQL — use a fixed, developer-chosen identifier. |

### Subqueries

`exists`, `notExists`, `inSubquery`, `notInSubquery`, and `equalsColumn` let a condition reference another builder:

```typescript
import { query } from 'blendsdk/expression';

interface Customer {
  id: number;
  name: string;
}

interface Order {
  id: number;
  customer_id: number;
}

const correlatedOrders = query<Order>()
  .where('customer_id').equalsColumn('customers.id');

const { sql, params } = query<Customer>()
  .where('id').exists(correlatedOrders)
  .compile();

console.log(sql);
// EXISTS (SELECT 1 WHERE customer_id = customers.id)

console.log(params);
// {}
```

`equalsColumn` emits a raw column-to-column comparison with no parameter — pass trusted, developer-controlled column references only. `exists` / `notExists` render an `EXISTS` guard and ignore the column they are called on; `inSubquery` / `notInSubquery` render `column IN (SELECT * WHERE …)` using it. A subquery must contain at least one condition, otherwise the call throws (see [Error Handling](#error-handling)). Each builder numbers its parameters independently, so compile the subquery alongside the parent and bind both `params` maps — Core Concepts covers the details.

---

## Configuration

Configuration is passed to the `query()` factory — or to `new QueryBuilderImpl(...)` — as a `QueryOptions` object. Both options are optional:

| Name | Type | Default | Description |
|---|---|---|---|
| `dialect` | `SqlDialect` | `SqlDialect.PostgreSQL` | Target SQL dialect used by the compiler. PostgreSQL is the only dialect implemented today. |
| `debug` | `boolean` | `false` | When `true`, `compile()` attaches a `DebugInfo` object (AST, parameter count, compilation time, optimizations, warnings) to the result. |

```typescript
import { query, SqlDialect } from 'blendsdk/expression';

interface Order {
  id: number;
  total: number;
  status: string;
}

const result = query<Order>({
  dialect: SqlDialect.PostgreSQL,
  debug: true,
})
  .where('status').equals('paid')
  .and('total').greaterThan(100)
  .compile();

console.log(result.sql);
// status = :p1 AND total > :p2

console.log(result.params);
// { p1: 'paid', p2: 100 }

console.log(result.debug?.parameterCount);
// 2

console.log(result.debug?.compilationTime);
// e.g. 0.35 (milliseconds)
```

The dialect is fixed when the builder is created; debug mode can also be enabled later with `.debug()`:

```typescript fragment
import { query } from 'blendsdk/expression';

interface Order {
  id: number;
  total: number;
  status: string;
}

const builder = query<Order>().debug(); // enable debug mode after creation
```

Dialect support:

| `SqlDialect` member | Value | Compilation status |
|---|---|---|
| `SqlDialect.PostgreSQL` | `'postgresql'` | Supported — used by default. |
| `SqlDialect.MySQL` | `'mysql'` | Declared, but `compile()` throws `Dialect mysql is not yet implemented`. |
| `SqlDialect.MSSQL` | `'mssql'` | Declared, but `compile()` throws `Dialect mssql is not yet implemented`. |
| `SqlDialect.SQLite` | `'sqlite'` | Declared, but `compile()` throws `Dialect sqlite is not yet implemented`. |

---

## Error Handling

`blendsdk/expression` throws standard `Error` instances — there are no custom error classes or error codes, and nothing in the package is asynchronous, so plain synchronous `try` / `catch` blocks are all you need. Errors surface in two phases: **build time** (thrown immediately while recording a condition) and **compile time** (thrown inside `compile()`).

Errors reachable through the fluent API and their meanings:

| Error message | When it occurs | Recommended handling |
|---|---|---|
| `Subquery must have at least one condition` | Build time — `exists`, `notExists`, `inSubquery`, or `notInSubquery` receives a subquery with no conditions (`getAST()` is `null`); thrown by the method call itself, before `compile()` | Add at least one condition to the subquery builder, or guard with `subquery.getAST() !== null` before attaching it |
| `Dialect mysql is not yet implemented` (likewise `mssql`, `sqlite`) | Compile time — `compile()` runs with a dialect other than PostgreSQL | Compile with `SqlDialect.PostgreSQL`; if the dialect is user-selectable, validate it before building the query |
| `Unknown dialect: <value>` | Compile time — `compile()` receives a value outside the `SqlDialect` enum, possible only when bypassing the type system | Validate the value against `SqlDialect` before passing it to `query()` |

Discriminate with `error instanceof Error` and, where needed, `error.message`. A build-time error:

```typescript
import { query } from 'blendsdk/expression';

interface Customer {
  id: number;
  email: string;
}

interface Order {
  id: number;
  customer_id: number;
}

const ordersFilter = query<Order>(); // no conditions yet — getAST() returns null

try {
  query<Customer>()
    .where('id')
    .exists(ordersFilter);
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message);
    // Subquery must have at least one condition
  }
}
```

The fix is to record at least one condition on `ordersFilter` — for example `.where('customer_id').greaterThan(0)` — before attaching it. A compile-time error:

```typescript
import { query, SqlDialect } from 'blendsdk/expression';

interface User {
  id: number;
  status: string;
}

try {
  const { sql } = query<User>({ dialect: SqlDialect.MySQL })
    .where('status').equals('active')
    .compile();

  console.log(sql);
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message);
    // Dialect mysql is not yet implemented
  }
}
```

The compiler also has a set of defensive checks. These are not reachable through the fluent builder API — they surface only if you drive the public `PostgreSQLCompiler` directly with manually assembled AST objects:

| Error message | Meaning |
|---|---|
| `Unknown node type: <type>`, `Unknown comparison operator: <op>`, `Unknown JSON operator: <op>`, `Unknown subquery operator: <op>` | The compiler met a node or operator outside the known enums. |
| `LIKE operator requires a parameter`, `BETWEEN operator requires two parameters`, `JSON operation requires a parameter`, `IN subquery requires a column`, `NOT IN subquery requires a column` | A node is missing the parameter names or column that its operator needs. |

**Empty queries are not errors.** Calling `compile()` on a builder with no conditions returns an empty result; in debug mode the warnings report the missing conditions:

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
}

const result = query<User>({ debug: true }).compile();

console.log(result.sql);
// ''

console.log(result.params);
// {}

console.log(result.debug?.warnings);
// ['No conditions specified']
```

When you append the fragment to a statement, skip the `WHERE` keyword whenever `sql` is empty.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
