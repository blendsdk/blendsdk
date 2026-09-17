> **Package**: `blendsdk/expression`

# expression Advanced Patterns

This document covers composition patterns for `blendsdk/expression` — the multi-step ways to combine the fluent builders, reusable predicates, full-text search, JSONB operators, subqueries, and `compile()` output into production-shaped code. Every example is self-contained, and all SQL output is what the default PostgreSQL dialect emits. As always, the compiled `sql` is a predicate fragment: it never includes the `WHERE` keyword.

**Rules that govern every pattern below:**

| Rule | Consequence |
|---|---|
| `where` **replaces** the current tree; `and`/`or` **combine** with it — and become the root on an empty builder | Use `where` at most once, as a deliberate anchor. Dynamic code can chain `and` for every optional condition, including the first. |
| Callback builders share the parent's `ParameterManager`; separately created `query()` builders number from `p1` on their own | Compose across functions with fragments (callbacks). Never merge two independently built queries without a collision check. |
| Only callback groups emit parentheses | Wrap every mixed `AND`/`OR` in a callback group. SQL binds `AND` tighter than `OR`, so ungrouped chains can silently mean something else than the AST. |
| Values are always bound as parameters | Only developer-controlled strings are embedded raw: column names, `equalsColumn` targets, and the `search` language. |
| Empty state is real | `in([])` emits `col IN ()` (PostgreSQL rejects it), `equals(null)` emits `= :pN`, and an untouched builder compiles to `{ sql: '', params: {} }`. |

---

## Request-Scoped Filter Composition

Use this pattern when a request (admin grid, search API, export job, report builder) carries a set of **optional criteria** and you need one parameterized predicate per request. This is the bread-and-butter use case: every condition is optional, every condition must stay type-checked against the schema, and no value may ever be concatenated into SQL.

**Before — manual string building (unsafe):**

```typescript
interface ProductCriteria {
  nameContains?: string;
  status?: string;
}

// ⚠️ Anti-pattern: values are concatenated into the statement. A value such as
// x' OR '1'='1 rewrites the predicate, and `status` accepts any string even
// though the column only allows three values.
function buildProductFilterSql(criteria: ProductCriteria): string {
  const clauses: string[] = [];

  if (criteria.nameContains !== undefined) {
    clauses.push(`name LIKE '%${criteria.nameContains}%'`);
  }

  if (criteria.status !== undefined) {
    clauses.push(`status = '${criteria.status}'`);
  }

  return clauses.join(' AND ');
}
```

**After — parameterized builder:**

```typescript
import { query } from 'blendsdk/expression';
import type { CompileResult } from 'blendsdk/expression';

interface ProductRow {
  id: number;
  name: string;
  category: string;
  status: 'draft' | 'published' | 'archived';
  price: number;
  deleted_at: string | null;
}

interface ProductCriteria {
  nameContains?: string;
  categories?: string[];
  status?: ProductRow['status'];
  minPrice?: number;
  maxPrice?: number;
  includeDeleted?: boolean;
}

export function buildProductFilter(criteria: ProductCriteria): CompileResult {
  // `and` becomes the root when the tree is still empty, so every optional
  // criterion can be appended uniformly — no special-casing the first one.
  let builder = query<ProductRow>();

  if (criteria.includeDeleted !== true) {
    builder = builder.and('deleted_at').isNull();
  }

  if (criteria.status !== undefined) {
    builder = builder.and('status').equals(criteria.status);
  }

  if (criteria.categories !== undefined && criteria.categories.length > 0) {
    builder = builder.and('category').in(criteria.categories);
  }

  if (criteria.nameContains !== undefined) {
    builder = builder.and('name').contains(criteria.nameContains);
  }

  if (criteria.minPrice !== undefined && criteria.maxPrice !== undefined) {
    builder = builder.and('price').between(criteria.minPrice, criteria.maxPrice);
  } else if (criteria.minPrice !== undefined) {
    builder = builder.and('price').greaterThanOrEqual(criteria.minPrice);
  } else if (criteria.maxPrice !== undefined) {
    builder = builder.and('price').lessThanOrEqual(criteria.maxPrice);
  }

  return builder.compile();
}

const result = buildProductFilter({
  status: 'published',
  categories: ['hardware', 'software'],
  minPrice: 50,
  maxPrice: 500,
  nameContains: 'pro',
});

console.log(result.sql);
// deleted_at IS NULL AND status = :p1 AND category IN (:p2, :p3) AND name LIKE :p4 AND price BETWEEN :p5 AND :p6

console.log(result.params);
// { p1: 'published', p2: 'hardware', p3: 'software', p4: '%pro%', p5: 50, p6: 500 }
```

**Why this pattern is valuable**

- **Injection is impossible by construction.** Every user value goes through `ParameterManager`; only the `:pN` placeholder appears in the SQL text.
- **Type drift is impossible.** `criteria.status` is typed as `ProductRow['status']`, so it stays in lockstep with the schema, and `equals` only accepts values of that exact union.
- **One uniform chaining rule.** Because `and` on an empty builder simply becomes the root, the code never has to ask "is this the first condition?" — the `includeDeleted` check and the `status` check use the identical shape.
- **Safe defaults are composable.** A request with no criteria still produces the invariant `deleted_at IS NULL` as the sole condition; a request that opts into deleted rows and adds nothing else compiles to an empty fragment, which the repository boundary pattern handles explicitly.

**Caveats and performance**

- **Never call `where` after the first condition.** It replaces the entire tree, silently discarding everything built so far. The pattern above avoids `where` entirely so the rule cannot be broken.
- **Guard `in()` against empty arrays.** A request like `{ categories: [] }` would emit `category IN ()`, which PostgreSQL rejects at parse time. Always check `length > 0` and skip the condition.
- **`equals(null)` is not `IS NULL`.** `equals(null)` emits `status = :pN` with a `null` binding, which matches nothing in SQL. Use `isNull()` / `isNotNull()` for null semantics.
- **Large `in()` lists cost one bind parameter per element.** PostgreSQL caps a statement at 65,535 parameters, and huge lists are slow anyway — chunk the IDs, pre-filter in a staging query, or use the two-step approach described in the subquery pattern.
- **Compile once per request.** `.compile()` is pure in-memory tree work (microseconds); the database round trip dominates. The returned `CompileResult` is a plain value object you can reuse for a count query and a page query with the same predicate.
- **`params` carries the raw user values.** Redact it before logging — it may contain PII.

---

## Reusable Predicate Fragments

Use this pattern when the same business condition — "not soft-deleted", "only unassigned", "created within the SLA window" — appears in many queries and must mean exactly the same thing everywhere. A **fragment** is just a function typed to match the builder's callback overload, so fragments can be defined once, unit-tested in isolation, and composed freely.

```typescript
import { query } from 'blendsdk/expression';
import type { QueryBuilder } from 'blendsdk/expression';

interface TicketRow {
  id: number;
  status: 'open' | 'pending' | 'resolved';
  priority: 'low' | 'normal' | 'high';
  assigned_to: number | null;
  created_at: string;
}

/** A condition fragment receives a builder and returns it with conditions added. */
type Fragment<TSchema> = (builder: QueryBuilder<TSchema>) => QueryBuilder<TSchema>;

// Fragments use `and` exclusively (and `search`, which also AND-combines), so
// they behave identically whether the builder is empty or already carries a tree.
const unassigned: Fragment<TicketRow> = (builder) =>
  builder.and('assigned_to').isNull();

const highPriorityOpen: Fragment<TicketRow> = (builder) =>
  builder.and('priority').equals('high').and('status').equals('open');

function createdBefore(cutoffIso: string): Fragment<TicketRow> {
  return (builder) => builder.and('created_at').lessThan(cutoffIso);
}

const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

// `and(fragment)` accepts the fragment directly; the fragment's result is
// wrapped in a group, so explicit parentheses are emitted automatically.
const { sql, params } = query<TicketRow>()
  .and((builder) => unassigned(builder).or(highPriorityOpen))
  .and(createdBefore(cutoff))
  .compile();

console.log(sql);
// (assigned_to IS NULL OR (priority = :p1 AND status = :p2)) AND (created_at < :p3)

console.log(params);
// { p1: 'high', p2: 'open', p3: '2024-06-09T12:00:00.000Z' }  (cutoff value varies)
```

**Why this pattern is valuable**

- **Business invariants live in one place.** `unassigned` is defined once, typed against `TicketRow`, and cannot diverge between call sites.
- **Fragments are plain functions.** They compose with `and`, `or`, and `where` (the callback overloads are exactly `(q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>`), are directly unit-testable, and require no special builder plumbing.
- **Parameter numbering stays continuous.** Fragments run inside callbacks, and callback builders share the parent's `ParameterManager` — here `p1` and `p2` were registered by the inner fragment and `p3` by the outer chain, in evaluation order, with no gaps or collisions.
- **Grouping is free.** Wrapping the mixed `AND`/`OR` logic in one callback causes the compiler to emit explicit parentheses, so the SQL always matches the AST.

**Where ungrouped composition goes wrong**

Fragments that mix `AND` and `OR` must be combined inside a single callback. Chaining them at the top level produces SQL whose `AND`-before-`OR` parsing differs from the tree:

```typescript fragment
// ⚠️ Top-level chaining of fragments that mix AND and OR:
query<TicketRow>()
  .and(highPriorityOpen)
  .or(unassigned)
  .and(createdBefore(cutoff))
  .compile();

// Emits: (priority = :p1 AND status = :p2) OR (assigned_to IS NULL) AND (created_at < :p3)
// PostgreSQL binds AND tighter than OR, so this evaluates as
// ((priority = :p1 AND status = :p2)) OR ((assigned_to IS NULL) AND (created_at < :p3))
// — not the ((A OR B) AND C) structure the chain appears to express.
```

**Caveats and performance**

- **Fragments must never call `where`.** Inside a callback the nested builder is empty, so `where` would appear to work — but apply the same fragment to a builder that already has conditions and `where` silently replaces the tree. The `and`-only rule makes fragments safe in every position.
- **Keep composition order stable if you assert on exact SQL.** Parameter names follow evaluation order; restructuring a fragment chain renumbers placeholders (correctness is unaffected, but snapshot tests will notice).
- **`search()` is fragment-compatible.** It AND-combines with an existing tree and becomes the root on an empty one, so it can appear inside fragments just like comparisons.
- **No runtime cost after compilation.** Fragments are ordinary function calls that create frozen AST nodes; there is no indirection at execution time.

---

## Multi-Tenant Guard Rails

Use this pattern when every query in a multi-tenant application must be scoped to the current tenant and a forgotten `tenant_id` filter would be a data-leak bug. The goal is a single chokepoint that makes the scope structurally impossible to omit and hard to accidentally displace.

```typescript
import { query } from 'blendsdk/expression';
import type { CompileResult, QueryBuilder } from 'blendsdk/expression';

interface InvoiceRow {
  id: number;
  tenant_id: string;
  customer_id: number;
  status: 'draft' | 'sent' | 'paid' | 'void';
  total: number;
}

type InvoiceFragment = (builder: QueryBuilder<InvoiceRow>) => QueryBuilder<InvoiceRow>;

/**
 * The only function allowed to build invoice predicates. The tenant scope is
 * the anchor of every query, and caller fragments are always parenthesized
 * behind it.
 */
export function buildInvoiceFilter(
  tenantId: string,
  callerFragment?: InvoiceFragment
): CompileResult {
  let builder = query<InvoiceRow>().where('tenant_id').equals(tenantId);

  if (callerFragment !== undefined) {
    builder = builder.and(callerFragment);
  }

  return builder.compile();
}

// ---- Application code -------------------------------------------------------

const openOrLarge: InvoiceFragment = (builder) =>
  builder.and('status').equals('draft').or('total').greaterThan(10000);

const compiled = buildInvoiceFilter('tenant-42', openOrLarge);

console.log(compiled.sql);
// tenant_id = :p1 AND (status = :p2 OR total > :p3)

console.log(compiled.params);
// { p1: 'tenant-42', p2: 'draft', p3: 10000 }

// Defense in depth: unit tests assert the scope anchor for every call path.
if (!compiled.sql.startsWith('tenant_id = :p1')) {
  throw new Error('Tenant scope is missing from the invoice predicate');
}
```

**Why this pattern is valuable**

- **The scope cannot be forgotten or displaced.** Callers never see a raw builder; they provide *fragments*, and fragments use `and`, which can only extend the anchored tree — never replace it. The `where('tenant_id')` anchor stays first.
- **The tenant value is always `p1`.** Because the guard registers it before any caller condition, audit snapshots and query logs have a stable, greppable shape: any invoice predicate that does not start with `tenant_id = :p1` is a bug, and the assertion above fails the build.
- **Fragments share the guard's parameter manager.** Numbering is continuous (`:p2`, `:p3`, …) across arbitrary caller logic with no merging step.
- **Caller logic is parenthesized automatically.** Passing the fragment via `and(...)` wraps it in a group, so even a fragment that mixes `AND` and `OR` internally cannot leak precedence changes into the tenant anchor.

**Caveats and performance**

- **Accept fragments, not builders.** A caller passing a `QueryBuilder` created with its own `query()` call carries its own numbering (`p1…`), which collides with the guard's `p1` when the two are combined — the same parameter-scope hazard described in the subquery pattern. Fragments flow through the guard's own manager and stay collision-free.
- **Keep raw builder access module-private.** Export the compiling guard (`buildInvoiceFilter`) and, if other modules need composition, additional guards — never the un-anchored `QueryBuilder`.
- **Enforce the rule with tests, not convention.** The `startsWith('tenant_id = :p1')` assertion is cheap; run it in a table-driven test over every public filter entry point.
- **Performance is unchanged.** The guard adds one condition and one parameter; building and compiling remain in-memory operations.

---

## Full-Text Search Endpoints with JSONB Filters

Use this pattern when a search box must combine free text across several columns with structured filters — including JSONB metadata — and you want compile-time diagnostics while developing. It layers `search()`, comparison helpers, and JSON operators in one request-scoped builder.

```typescript
import { query } from 'blendsdk/expression';
import type { CompileResult } from 'blendsdk/expression';

interface ArticleRow {
  id: number;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  status: 'draft' | 'published';
  published_at: string;
}

interface ArticleSearchRequest {
  text?: string;
  mode?: 'plain' | 'phrase' | 'websearch';
  mustHaveMetadataKeys?: string[];
  publishedAfter?: string;
  debug?: boolean;
}

export function buildArticleSearch(request: ArticleSearchRequest): CompileResult {
  let builder = query<ArticleRow>({ debug: request.debug === true })
    .where('status').equals('published');

  if (request.text !== undefined && request.text.trim().length > 0) {
    // `search()` AND-combines with the existing tree; mode controls how the
    // text is parsed into a tsquery. The language stays fixed and developer-chosen.
    builder = builder.search(['title', 'body'], request.text, {
      mode: request.mode ?? 'plain',
      language: 'english',
    });
  }

  if (request.mustHaveMetadataKeys !== undefined && request.mustHaveMetadataKeys.length > 0) {
    builder = builder.and('metadata').jsonHasAllKeys(request.mustHaveMetadataKeys);
  }

  if (request.publishedAfter !== undefined) {
    builder = builder.and('published_at').greaterThan(request.publishedAfter);
  }

  return builder.compile();
}

const result = buildArticleSearch({
  text: 'typescript generics',
  mode: 'websearch',
  mustHaveMetadataKeys: ['featured'],
  publishedAfter: '2026-01-01T00:00:00.000Z',
  debug: true,
});

console.log(result.sql);
// status = :p1 AND to_tsvector('english', title || ' ' || body) @@ websearch_to_tsquery('english', :p2) AND metadata ?& :p3 AND published_at > :p4

console.log(result.params);
// { p1: 'published', p2: 'typescript generics', p3: ['featured'], p4: '2026-01-01T00:00:00.000Z' }

console.log(result.debug?.parameterCount); // 4
console.log(result.debug?.compilationTime); // e.g. 0.42 (milliseconds)
console.log(result.debug?.warnings); // []
```

**Why this pattern is valuable**

- **The search text is parsed server-side, safely.** Modes map to `plainto_tsquery`, `phraseto_tsquery`, and `websearch_to_tsquery`; the request text itself is always a bound parameter (`:p2`), so operators like quotes or `-` in `websearch` mode are interpreted by PostgreSQL, not concatenated into SQL.
- **Structured and unstructured filters compose naturally.** The JSONB key check (`metadata ?& :p3`), the date comparison, and the text search all attach to the same tree with consistent `AND` semantics and continuous numbering.
- **Debug mode turns compilation into an observable step.** In development, `query({ debug: true })` (or `.debug()` before compiling) attaches the AST, parameter count, compilation time, and compiler warnings to the result, so slow or surprising predicates are visible before they hit the database.

**Caveats and performance**

- **Never pass user input as the search `language`.** The language identifier is embedded directly into the SQL text (`to_tsvector('english', …)`) — it is not parameterized. Restrict it to a developer allowlist:

  ```typescript fragment
  const SUPPORTED_LANGUAGES = ['english', 'german', 'dutch'] as const;
  type SearchLanguage = (typeof SUPPORTED_LANGUAGES)[number];

  function toSearchLanguage(value: string): SearchLanguage {
    const language = SUPPORTED_LANGUAGES.find((candidate) => candidate === value);
    if (language === undefined) {
      throw new Error(`Unsupported search language: ${value}`);
    }
    return language;
  }
  ```

- **Index the exact tsvector expression.** The generated left side is `to_tsvector('english', title || ' ' || body)` (or a single column). For large tables, create a GIN functional index whose expression matches it exactly — including the concatenation — or the predicate degrades to a sequential scan.
- **Pick the mode for your UX.** `plain` ANDs all terms; `phrase` requires adjacency; `websearch` supports `"quoted phrases"`, `or`, and `-negative` terms. Input consisting only of stop words produces an empty tsquery and zero rows — consider a `LIKE` fallback for very short queries.
- **`search()` always AND-combines at the builder level.** For OR semantics (`text match OR title LIKE`), wrap the search in a callback group: `or((group) => group.search(['title'], term))`.
- **Skip the condition when there is no text.** `plainto_tsquery('english', '')` matches nothing, so the `trim().length > 0` guard also prevents "empty search returns zero rows" bugs.
- **Enable debug only in development.** It adds AST and timing bookkeeping to every compile; the `compilationTime` reflects predicate building, not database execution.

---

## Correlated Subqueries and Parameter Scope

Use this pattern when a predicate must reference another table — "customers that have orders", "customers without refunded orders" — and you want the fluent, typed API rather than hand-written SQL. The critical design decision is what the subquery references: **column references are safe and parameter-free; literal values inside a subquery live in a separate parameter scope and require care.**

**The safe shape — correlated column references only:**

```typescript
import { query } from 'blendsdk/expression';

interface CustomerRow {
  id: number;
  name: string;
  status: 'active' | 'churned';
}

interface OrderRow {
  id: number;
  customer_id: number;
  status: 'pending' | 'paid' | 'refunded';
}

/**
 * Correlated existence check: `equalsColumn` emits a raw column reference
 * (no parameter), so this subquery contributes no values of its own.
 */
const hasOrders = query<OrderRow>()
  .where('customer_id').equalsColumn('customers.id');

const { sql, params } = query<CustomerRow>()
  .where('status').equals('active')
  .and('id').exists(hasOrders)
  .compile();

console.log(sql);
// status = :p1 AND EXISTS (SELECT 1 WHERE customer_id = customers.id)

console.log(params);
// { p1: 'active' }
```

**Why this pattern is valuable**

- **Boolean logic stays typed and inspectable.** The subquery is an ordinary `QueryBuilder`; its AST is embedded in the parent tree and shows up in `DebugInfo.ast` like any other node.
- **Parameter-free subqueries need no merging.** Because `equalsColumn` emits `customer_id = customers.id` without a placeholder, the parent's `compile()` is complete on its own — the cleanest correlated form.
- **One implementation covers all four shapes.** The compiler renders each subquery method deterministically:

  | Method | Emitted SQL |
  |---|---|
  | `exists` | `EXISTS (SELECT 1 WHERE <predicate>)` |
  | `notExists` | `NOT EXISTS (SELECT 1 WHERE <predicate>)` |
  | `inSubquery` | `column IN (SELECT * WHERE <predicate>)` |
  | `notInSubquery` | `column NOT IN (SELECT * WHERE <predicate>)` |

  For `EXISTS` / `NOT EXISTS` the parent-side column is not rendered — attach the subquery to whichever comparison stage reads naturally (commonly the primary key).

**When the subquery contains literals: parameter scope**

A subquery built with its own `query()` call owns its own `ParameterManager`. The parent's `compile()` returns **only the parameters registered on the parent** — values bound inside the subquery are not included, even though the compiled SQL references their placeholder names. When the parent contributes no literals of its own, you can compile both and merge safely:

```typescript
import { query } from 'blendsdk/expression';
import type { CompileResult } from 'blendsdk/expression';

interface CustomerRow {
  id: number;
  region: string;
}

interface OrderRow {
  id: number;
  customer_id: number;
  status: 'pending' | 'paid' | 'refunded';
  total: number;
}

function mergeParams(
  ...maps: Array<Record<string, unknown>>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  for (const map of maps) {
    for (const [key, value] of Object.entries(map)) {
      if (key in merged) {
        throw new Error(
          `Parameter collision on '${key}': rebuild the subquery without literals ` +
            `or use a two-step query instead.`
        );
      }
      merged[key] = value;
    }
  }

  return merged;
}

// The subquery owns its parameter manager: `status = :p1` is registered there.
const paidOrders = query<OrderRow>()
  .where('customer_id').equalsColumn('customers.id')
  .and('status').equals('paid');

// The parent contributes no literals of its own, so names cannot collide.
const parent = query<CustomerRow>()
  .where('id').notExists(paidOrders);

const parentResult: CompileResult = parent.compile();
const subqueryResult = paidOrders.compile();
const params = mergeParams(parentResult.params, subqueryResult.params);

console.log(parentResult.sql);
// NOT EXISTS (SELECT 1 WHERE customer_id = customers.id AND status = :p1)

console.log(params);
// { p1: 'paid' }
```

**Caveats and performance**

- **Collisions are real and silent without the check.** Both builders number from `p1`. If the parent above also filtered on `region = 'NL'`, its `:p1` and the subquery's `:p1` would name the same placeholder with different values — `mergeParams` throws rather than mis-binding. If you hit the collision, restructure: move the literal out of the subquery, or run the subquery as a standalone statement, collect the matching IDs, and filter the parent with `.in(ids)` (chunked, per the large-IN guidance).
- **`equalsColumn` embeds its argument raw.** Only pass trusted, developer-controlled column references — never request input.
- **Empty subqueries throw.** `exists`, `notExists`, `inSubquery`, and `notInSubquery` raise `Error('Subquery must have at least one condition')` if `getAST()` is `null`. Construct subqueries through functions that always add at least one condition.
- **Treat the emitted subquery as a fragment.** The compiler produces a predicate container (`SELECT 1 WHERE …`, `SELECT * WHERE …`) without its own `FROM` clause — consistent with the package's fragment-oriented output. Embed or adapt it within your statement assembly the same way you do for the top-level predicate, and verify against your database layer.
- **The declared `SubqueryBuilder` extensions are not implemented in 5.x.** `select(...)` and `aggregate(...)` exist only as interface declarations; all subquery methods operate on ordinary `QueryBuilder` instances.
- **Correlated `EXISTS` runs per row candidate.** Make sure the correlation column is indexed on the subquery side (`orders(customer_id)` here).

---

## Repository Boundary Assembly and Parameter Coverage

Use this pattern at the seam where the compiled predicate becomes a real statement: a repository layer that appends the fragment as a `WHERE` clause, handles the empty-query case, and verifies that every placeholder in the SQL has a bound value before the statement is executed. This is the same boundary BlendSDK database packages such as `blendsdk/dbcore` consume — a predicate fragment plus a named parameter map.

```typescript
import { query } from 'blendsdk/expression';
import type { CompileResult } from 'blendsdk/expression';

interface UserRow {
  id: number;
  email: string;
  status: 'active' | 'invited' | 'suspended';
  deleted_at: string | null;
}

interface Statement {
  text: string;
  values: Record<string, unknown>;
}

/** Append the compiled predicate as a WHERE clause, or leave the statement untouched. */
function withWhere(statement: string, compiled: CompileResult): Statement {
  if (compiled.sql.length === 0) {
    return { text: statement, values: {} };
  }
  return { text: `${statement} WHERE ${compiled.sql}`, values: compiled.params };
}

/** Verify that every placeholder in the SQL has a bound value. */
function assertParamCoverage(compiled: CompileResult): void {
  const names = new Set<string>();

  for (const match of compiled.sql.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }

  for (const name of names) {
    if (!(name in compiled.params)) {
      throw new Error(`Missing parameter value for placeholder :${name}`);
    }
  }
}

interface UserListFilters {
  statuses?: UserRow['status'][];
}

export function buildUserListStatement(filters: UserListFilters): Statement {
  let builder = query<UserRow>().and('deleted_at').isNull();

  if (filters.statuses !== undefined && filters.statuses.length > 0) {
    builder = builder.and('status').in(filters.statuses);
  }

  const compiled = builder.compile();
  assertParamCoverage(compiled);
  return withWhere('SELECT id, email, status FROM users', compiled);
}

const list = buildUserListStatement({ statuses: ['active', 'invited'] });

console.log(list.text);
// SELECT id, email, status FROM users WHERE deleted_at IS NULL AND status IN (:p1, :p2)

console.log(list.values);
// { p1: 'active', p2: 'invited' }
```

The no-condition branch of `withWhere` is exercised by an untouched builder:

```typescript fragment
const empty = query<UserRow>().compile();

console.log(empty.sql);    // ''
console.log(empty.params); // {}
```

**Why this pattern is valuable**

- **The empty-query case is handled once, correctly.** An untouched builder compiles to `sql: ''`; a naive `WHERE ${sql}` would produce a statement ending in a dangling `WHERE`. The `withWhere` guard centralizes the decision.
- **Parameter coverage is validated mechanically.** `assertParamCoverage` scans the generated SQL for `:pN` placeholders and fails fast if any lacks a value — exactly the class of mistake that the subquery parameter scopes can introduce. Run it in development and test environments as a tripwire.
- **The boundary is explicit.** Upstream, everything is builders and fragments; downstream, everything is `{ text, values }`. That pair — predicate fragment plus named parameter map — is precisely the shape BlendSDK's database layer consumes, so the adapter is where dialect conventions (`:p1` placeholders for PostgreSQL, bare `p1` keys in the parameter map) cross into your statement pipeline.
- **The immutable AST makes the boundary safe.** Once compiled, the tree cannot change; the `Statement` you hand downstream is a stable snapshot whose SQL and values can never drift apart.

**Caveats and performance**

- **Do not renumber, rename, or mutate `params`.** The placeholder names are baked into the SQL string by the compiler; the parameter map must match them exactly as produced.
- **Coverage checks presence, not types.** `assertParamCoverage` catches missing bindings; value-type mismatches remain the database's job (or your schema validation layer's).
- **Placeholder syntax follows the dialect.** PostgreSQL renders `:p1`, and the parameter map is keyed by the bare name (`p1`). Bind the map through the database layer that consumes the same convention.
- **Compile once, reuse deliberately.** Pagination, counts, and exports can share the same `CompileResult`; only the surrounding statement (and its `LIMIT`/`OFFSET`, which this package does not generate) differs.
- **Redact before logging.** `params` contains the actual user values; keep it out of plain-text logs in production.
- **Performance is a non-issue at this layer.** Building, compiling, and scanning for placeholder coverage are linear in the number of conditions — microseconds that disappear next to the database round trip.

---

# expression Common Scenarios

Practical answers to the most common `blendsdk/expression` questions, ordered from simple to advanced. Each scenario contains a complete, runnable example; the output shown in comments reflects the compiled `CompileResult`. For the concepts behind these patterns, see Core Concepts and Basic Usage.

---

## How do I create a basic WHERE condition?

**Solution**: Create a builder with `query()`, select a column with `where(column)`, and record a comparison with a terminal method such as `equals(value)`. `compile()` returns `{ sql, params }` — the predicate without the `WHERE` keyword, with every value bound through a generated placeholder.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  email: string;
  status: string;
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

The SQL string contains no literal values — `status = :p1` with `p1` resolved from `params`.

---

## How do I combine conditions with AND and OR?

**Solution**: After the initial `where(...)` condition, chain `and(column)` or `or(column)` and complete each with a terminal comparison. Conditions are combined in the order you declare them.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  role: string;
  age: number;
  verified: boolean;
}

const activeAdults = query<User>()
  .where('age').greaterThanOrEqual(18)
  .and('verified').equals(true)
  .compile();

console.log(activeAdults.sql);
// age >= :p1 AND verified = :p2

console.log(activeAdults.params);
// { p1: 18, p2: true }

const staff = query<User>()
  .where('role').equals('admin')
  .or('role').equals('moderator')
  .compile();

console.log(staff.sql);
// role = :p1 OR role = :p2

console.log(staff.params);
// { p1: 'admin', p2: 'moderator' }
```

**Note**: Mixed `AND`/`OR` chains are emitted flat, without implicit parentheses. Use callback groups to control precedence — see the next scenario.

---

## How do I group conditions with parentheses to control precedence?

**Solution**: Pass a callback to `where`, `and`, or `or`. The callback receives a nested builder that shares the parent's parameter numbering, and whatever conditions it records are wrapped in parentheses. Use a group whenever you mix `AND` with `OR`.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  status: string;
  age: number;
  verified: boolean;
}

const { sql, params } = query<User>()
  .where((q) => q
    .where('status').equals('active')
    .or('status').equals('pending')
  )
  .and((q) => q
    .where('age').between(18, 65)
    .or('verified').equals(true)
  )
  .compile();

console.log(sql);
// (status = :p1 OR status = :p2) AND (age BETWEEN :p3 AND :p4 OR verified = :p5)

console.log(params);
// { p1: 'active', p2: 'pending', p3: 18, p4: 65, p5: true }
```

Groups nest arbitrarily deep — a callback may itself contain `and`/`or` callbacks, producing structures such as `a = :p1 AND (b = :p2 OR (c = :p3 AND d = :p4))`.

---

## How do I get compile-time type safety for columns and values?

**Solution**: Parameterize the builder with your row type — `query<User>()`. Column names are then constrained to `keyof User`, and each comparison value to the matching property type, so invalid columns or mismatched values fail at compile time.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  email: string;
  age: number;
  status: 'active' | 'pending' | 'suspended';
}

const { sql, params } = query<User>()
  .where('status').equals('active')
  .and('age').greaterThanOrEqual(18)
  .and('email').endsWith('@example.com')
  .compile();

console.log(sql);
// status = :p1 AND age >= :p2 AND email LIKE :p3

console.log(params);
// { p1: 'active', p2: 18, p3: '%@example.com' }
```

The following variations are rejected by the compiler:

```typescript fragment
// @ts-expect-error — 'user_email' is not a key of User
query<User>().where('user_email');

// @ts-expect-error — age expects a number, not a string
query<User>().where('age').greaterThan('18');
```

For joined queries, table-qualified names work as schema keys and are emitted verbatim:

```typescript fragment
interface JoinedOrderRow {
  'orders.id': number;
  'customers.email': string;
}

query<JoinedOrderRow>().where('customers.email').endsWith('@example.com');
// → customers.email LIKE :p1
```

---

## How do I search text with LIKE patterns and wildcards?

**Solution**: Use `like(pattern)` for a raw `LIKE` pattern or `ilike(pattern)` for PostgreSQL's case-insensitive match, or the wildcard helpers `startsWith`, `endsWith`, and `contains`, which wrap the value in `%` automatically. All patterns are parameterized.

```typescript
import { query } from 'blendsdk/expression';

interface Customer {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
}

const { sql, params } = query<Customer>()
  .where('first_name').startsWith('Jo')
  .and('last_name').endsWith('son')
  .and('email').like('%@example.com')
  .compile();

console.log(sql);
// first_name LIKE :p1 AND last_name LIKE :p2 AND email LIKE :p3

console.log(params);
// { p1: 'Jo%', p2: '%son', p3: '%@example.com' }
```

Pattern reference:

| Method | Emitted SQL | Pattern bound |
|---|---|---|
| `like(pattern)` | `column LIKE :pN` | `pattern` verbatim |
| `ilike(pattern)` | `column ILIKE :pN` | `pattern` verbatim |
| `startsWith(value)` | `column LIKE :pN` | `value + '%'` |
| `endsWith(value)` | `column LIKE :pN` | `'%' + value` |
| `contains(value)` | `column LIKE :pN` | `'%' + value + '%'` |

---

## How do I check for NULL or NOT NULL values?

**Solution**: Use `isNull()` and `isNotNull()` — they emit `IS NULL` / `IS NOT NULL` with no parameter. Avoid `equals(null)`: it emits `= :pN` with a `null` binding, which never matches under SQL's three-valued logic.

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

```typescript fragment
// Emits "deleted_at = :p1" with { p1: null } — evaluates to unknown and matches no rows
query<User>().where('deleted_at').equals(null);
```

---

## How do I filter by ranges and value lists?

**Solution**: `between(min, max)` / `notBetween(min, max)` build inclusive range predicates, and `in(values)` / `notIn(values)` build set membership — each list element receives its own placeholder.

```typescript
import { query } from 'blendsdk/expression';

interface Product {
  id: number;
  price: number;
  category: string;
  stock: number;
}

const { sql, params } = query<Product>()
  .where('price').between(10, 100)
  .and('category').in(['books', 'music', 'games'])
  .and('stock').notEquals(0)
  .compile();

console.log(sql);
// price BETWEEN :p1 AND :p2 AND category IN (:p3, :p4, :p5) AND stock <> :p6

console.log(params);
// { p1: 10, p2: 100, p3: 'books', p4: 'music', p5: 'games', p6: 0 }
```

**Edge case — empty lists**: an empty array compiles to `category IN ()`, which PostgreSQL rejects at parse time. Guard before calling `in`:

```typescript fragment
// ⚠️ Produces "category IN ()" — PostgreSQL rejects an empty IN list
query<Product>().where('category').in([]);
```

Decide in application code what an empty list means: "no filter" — skip the condition (see the dynamic-conditions scenario); or "match nothing" — return an empty result without compiling a query.

**Large lists**: every element becomes its own parameter, so a 100-value list produces `:p1` … `:p100` and 100 parameter entries. This works fine — just keep your database driver's bind-parameter limit in mind and batch when needed.

```typescript
import { query } from 'blendsdk/expression';

interface Item {
  id: number;
  name: string;
}

const ids = Array.from({ length: 100 }, (_, index) => index + 1);

const { sql, params } = query<Item>()
  .where('id').in(ids)
  .compile();

console.log(sql);
// id IN (:p1, :p2, …, :p100)

console.log(Object.keys(params).length);
// 100
```

---

## How do I add conditions dynamically at runtime?

**Solution**: Build the query inside a `where(callback)` and append conditions with `and(...)` only when the corresponding filter is set. If no filter is provided, the callback contributes nothing and the query compiles to an empty predicate.

```typescript
import { query } from 'blendsdk/expression';
import type { QueryBuilder } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  role: string;
  age: number;
}

interface UserFilters {
  name?: string;
  role?: string;
  minAge?: number;
}

function buildUserQuery(filters: UserFilters): QueryBuilder<User> {
  return query<User>().where((q) => {
    let builder: QueryBuilder<User> = q;

    if (filters.name !== undefined) {
      builder = builder.where('name').contains(filters.name);
    }
    if (filters.role !== undefined) {
      builder = builder.and('role').equals(filters.role);
    }
    if (filters.minAge !== undefined) {
      builder = builder.and('age').greaterThanOrEqual(filters.minAge);
    }

    return builder;
  });
}

const filtered = buildUserQuery({ role: 'admin', minAge: 30 }).compile();

console.log(filtered.sql);
// (role = :p1 AND age >= :p2)

console.log(filtered.params);
// { p1: 'admin', p2: 30 }

const unfiltered = buildUserQuery({}).compile();

console.log(unfiltered.sql);
// ''

console.log(unfiltered.params);
// {}
```

**Notes**: The callback's conditions are wrapped in one group, so the emitted SQL carries a harmless outer pair of parentheses. Check filters with `!== undefined` rather than truthiness so falsy-but-valid values like `0` are still applied. The same technique works in a loop — each terminal call returns the builder, so you can keep appending conditions.

---

## How do I query Date columns and other special values?

**Solution**: Values are stored in their original form with two normalizations: `Date` instances become ISO-8601 strings, and `undefined` becomes `null`. Falsy values — `0`, `false`, `''` — are preserved exactly, and objects/arrays are kept intact for the database driver to serialize.

```typescript
import { query } from 'blendsdk/expression';

interface Event {
  id: number;
  name: string;
  starts_at: Date;
  capacity: number;
  active: boolean;
}

const { sql, params } = query<Event>()
  .where('starts_at').greaterThan(new Date('2025-01-01T00:00:00.000Z'))
  .and('capacity').greaterThan(0)
  .and('active').equals(false)
  .compile();

console.log(sql);
// starts_at > :p1 AND capacity > :p2 AND active = :p3

console.log(params);
// {
//   p1: '2025-01-01T00:00:00.000Z',  ← Date converted to an ISO-8601 string
//   p2: 0,                           ← falsy values are kept as-is
//   p3: false
// }
```

**Note**: For SQL NULL checks, use `isNull()` / `isNotNull()` rather than `equals(null)` — see [How do I check for NULL or NOT NULL values?](#how-do-i-check-for-null-or-not-null-values).

---

## How do I keep user input safe from SQL injection?

**Solution**: Pass values through the comparison methods as-is — the builder registers every value as a bind parameter and never concatenates it into SQL, so quotes, backslashes, newlines, and unicode need no manual escaping. The only strings embedded into SQL verbatim are coordinates you control: column names, `equalsColumn` references, and the full-text `language` option — never pass untrusted input to those.

```typescript
import { query } from 'blendsdk/expression';

interface Customer {
  id: number;
  name: string;
}

const userInput = "O'Brien'; DROP TABLE customers; --";

const { sql, params } = query<Customer>()
  .where('name').equals(userInput)
  .compile();

console.log(sql);
// name = :p1

console.log(params);
// { p1: "O'Brien'; DROP TABLE customers; --" }

const unicode = query<Customer>()
  .where('name').equals('José García 日本語')
  .compile();

console.log(unicode.params);
// { p1: 'José García 日本語' }
```

---

## How do I use the compiled SQL with my database driver?

**Solution**: `compile()` returns `{ sql, params }`. Append `sql` to your own statement — it excludes the `WHERE` keyword — and bind `params` with your driver or SQL layer's named-parameter support; the parameter keys (`p1`, `p2`, …) match the `:pN` placeholders in the text.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  email: string;
  status: string;
}

const { sql, params } = query<User>()
  .where('status').equals('active')
  .and('email').endsWith('@example.com')
  .compile();

const statement = `SELECT id, email FROM users WHERE ${sql}`;

console.log(statement);
// SELECT id, email FROM users WHERE status = :p1 AND email LIKE :p2

console.log(params);
// { p1: 'active', p2: '%@example.com' }
```

**Notes**: The result is only the predicate, so you own the surrounding statement (`SELECT`, `UPDATE`, `DELETE`, …). Placeholder style is dialect-specific — this build emits PostgreSQL-style `:pN` names — and BlendSDK's database packages consume the `CompileResult` directly. Check `sql` before appending a `WHERE` clause: an empty query compiles to `''`.

---

## How do I query JSON and JSONB columns?

**Solution**: Use the JSON comparison methods, which map to PostgreSQL's native JSONB operators. Containment takes an object or array and key checks take a key or key list; each operand is bound as a single parameter and left in JavaScript form for the driver to serialize.

```typescript
import { query } from 'blendsdk/expression';

interface Document {
  id: number;
  metadata: Record<string, unknown>;
  tags: string[];
}

const { sql, params } = query<Document>()
  .where('metadata').jsonContains({ plan: 'premium' })
  .and('metadata').jsonHasKey('email')
  .and('tags').jsonHasAllKeys(['typescript', 'sql'])
  .compile();

console.log(sql);
// metadata @> :p1 AND metadata ? :p2 AND tags ?& :p3

console.log(params);
// { p1: { plan: 'premium' }, p2: 'email', p3: ['typescript', 'sql'] }
```

Operator reference:

| Method | PostgreSQL operator | Example |
|---|---|---|
| `jsonContains(value)` | `@>` | `metadata @> :p1` |
| `jsonContainedBy(value)` | `<@` | `metadata <@ :p1` |
| `jsonHasKey(key)` | `?` | `metadata ? :p1` |
| `jsonHasAnyKey(keys)` | `?\|` | `metadata ?\| :p1` |
| `jsonHasAllKeys(keys)` | `?&` | `metadata ?& :p1` |
| `jsonPathExists(path)` | `@?` | `metadata @? :p1` |

---

## How do I run full-text searches?

**Solution**: Call `search(columns, query, options?)` on the builder to search one or many columns, or `.where(column).search(query, options?)` for a single column. `mode` selects the tsquery parser (`'plain'` is the default) and `language` defaults to `'english'`.

```typescript
import { query } from 'blendsdk/expression';

interface Article {
  id: number;
  title: string;
  body: string;
  published: boolean;
}

const { sql, params } = query<Article>()
  .where('published').equals(true)
  .search(['title', 'body'], 'typescript + "strict mode"', { mode: 'websearch' })
  .compile();

console.log(sql);
// published = :p1 AND to_tsvector('english', title || ' ' || body) @@ websearch_to_tsquery('english', :p2)

console.log(params);
// { p1: true, p2: 'typescript + "strict mode"' }
```

Mode reference:

| `mode` | Generated tsquery parser |
|---|---|
| `'plain'` (default) | `plainto_tsquery('<language>', :pN)` |
| `'phrase'` | `phraseto_tsquery('<language>', :pN)` |
| `'websearch'` | `websearch_to_tsquery('<language>', :pN)` |

Single-column variant:

```typescript fragment
query<Article>().where('title').search('sql injection', { mode: 'phrase' });
// → to_tsvector('english', title) @@ phraseto_tsquery('english', :p1)
```

**Note**: The language name is embedded into the SQL text — use fixed, developer-chosen identifiers only. The search terms themselves are always parameterized.

---

## How do I filter with EXISTS and IN subqueries?

**Solution**: Build the subquery with its own `query()` call and pass it to `exists`, `notExists`, `inSubquery`, or `notInSubquery`; use `equalsColumn(reference)` for correlated column-to-column comparisons.

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

// Correlated sub-query: matches orders belonging to the customer row being filtered
const hasOrders = query<Order>()
  .where('customer_id').equalsColumn('customers.id');

const { sql, params } = query<Customer>()
  .where('id').exists(hasOrders)
  .compile();

console.log(sql);
// EXISTS (SELECT 1 WHERE customer_id = customers.id)

console.log(params);
// {}
```

**Parameter caveat**: a subquery keeps its own parameter manager, so literal values inside it are not part of the parent's `compile()` result. Compile the subquery too and merge the bindings — and note that both sides number placeholders from `p1` independently:

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

const highValueOrders = query<Order>()
  .where('total').greaterThan(1000);

const customers = query<Customer>()
  .where('id').inSubquery(highValueOrders)
  .compile();

console.log(customers.sql);
// id IN (SELECT * WHERE total > :p1)

console.log(customers.params);
// {} — the sub-query's parameter lives in its own builder

const bindings = { ...customers.params, ...highValueOrders.compile().params };

console.log(bindings);
// { p1: 1000 }
```

**Notes**: If the parent query also registers literal parameters, its placeholders restart at `p1` as well and collide with the subquery's — keep at most one side of the pair parameterized, or prefer correlated (`equalsColumn`) conditions inside subqueries. Passing a subquery with no conditions throws `Subquery must have at least one condition`. The full mapping:

| Method | Rendered predicate |
|---|---|
| `exists(sub)` | `EXISTS (SELECT 1 WHERE <predicate>)` |
| `notExists(sub)` | `NOT EXISTS (SELECT 1 WHERE <predicate>)` |
| `inSubquery(sub)` | `column IN (SELECT * WHERE <predicate>)` |
| `notInSubquery(sub)` | `column NOT IN (SELECT * WHERE <predicate>)` |
| `equalsColumn(ref)` | `column = ref` (no parameter; `ref` is embedded verbatim) |

---

## How do I debug and inspect a compiled query?

**Solution**: Enable debug mode with `query({ debug: true })` or by calling `.debug()` on the builder before compiling. The result's `debug` object contains the AST, parameter count, compilation time, applied optimizations, and warnings; `getAST()` exposes the root node at any time.

```typescript
import { query } from 'blendsdk/expression';

interface Order {
  id: number;
  status: string;
  total: number;
}

const result = query<Order>({ debug: true })
  .where('status').equals('paid')
  .and('total').greaterThan(100)
  .compile();

console.log(result.sql);
// status = :p1 AND total > :p2

console.log(result.debug?.parameterCount);
// 2

console.log(result.debug?.compilationTime);
// e.g. 0.21 (milliseconds)

console.log(result.debug?.optimizations);
// []

console.log(result.debug?.warnings);
// []

console.log(result.debug?.ast.type);
// 'logical'

const builder = query<Order>()
  .where('status').equals('paid');

console.log(builder.getAST()?.type);
// 'comparison'
```

**Note**: The AST node types are the `ASTNodeType` enum values (`'comparison'`, `'logical'`, `'group'`, `'json'`, `'fulltext'`, `'subquery'`); see Core Concepts for traversal patterns.

---

## How do I handle a query with no conditions?

**Solution**: An empty builder compiles to `{ sql: '', params: {} }` — nothing is emitted — so always check `sql` before appending it to a statement. Empty callback groups are ignored as well, which lets conditionally-built queries degrade gracefully.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
}

const empty = query<User>().compile();

console.log(empty.sql);
// ''

console.log(empty.params);
// {}

// A callback group that records nothing contributes nothing
const ignored = query<User>()
  .where('id').equals(1)
  .and((q) => q)
  .compile();

console.log(ignored.sql);
// id = :p1

const debugged = query<User>({ debug: true }).compile();

console.log(debugged.debug?.warnings);
// ['No conditions specified']
```

---

## How do I create multiple query variations from the same filters?

**Solution**: Extract the shared filters into a function that returns a fresh builder on every call — `query()` gives each builder its own parameter manager, so every variation compiles with correct bindings. Avoid `QueryBuilderImpl.clone()` for this: the clone shares the original AST while starting an empty parameter manager, producing duplicate placeholders and lost bindings.

```typescript
import { query } from 'blendsdk/expression';
import type { QueryBuilder } from 'blendsdk/expression';

interface User {
  id: number;
  role: string;
  active: boolean;
}

function activeUserFilter(): QueryBuilder<User> {
  return query<User>()
    .where('active').equals(true)
    .and('role').in(['admin', 'editor']);
}

const listFilter = activeUserFilter().compile();

console.log(listFilter.sql);
// active = :p1 AND role IN (:p2, :p3)

console.log(listFilter.params);
// { p1: true, p2: 'admin', p3: 'editor' }

const countFilter = activeUserFilter().compile();

console.log(countFilter.params);
// { p1: true, p2: 'admin', p3: 'editor' } — independent builder, same correct bindings
```

Why `clone()` is the wrong tool (it is defined on the exported `QueryBuilderImpl` class, not on the `QueryBuilder` interface):

```typescript fragment
import { QueryBuilderImpl } from 'blendsdk/expression';

const base = new QueryBuilderImpl<User>();
base.where('active').equals(true);

const copy = base.clone();
copy.and('role').equals('admin');

// copy.compile().sql    → "active = :p1 AND role = :p1"  ← duplicate placeholder
// copy.compile().params → { p1: 'admin' }                ← the `true` binding is gone
```

---

## How do I target a specific SQL dialect?

**Solution**: Pass a `SqlDialect` in the query options — PostgreSQL is the default and the only implemented dialect. Selecting `MySQL`, `MSSQL`, or `SQLite` makes `compile()` throw `<dialect> is not yet implemented`.

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

// PostgreSQL is the default and the only implemented dialect
const postgres = query<User>({ dialect: SqlDialect.PostgreSQL })
  .where('status').equals('active')
  .compile();

console.log(postgres.sql);
// status = :p1
```

---

*See also: Overview · Core Concepts · Basic Usage*

---

# expression Examples Library

A categorized collection of copy-paste ready examples for `blendsdk/expression`. Every example is complete and self-contained — include the imports, run it with Node.js (>= 22) and watch the output shown in the comments. All SQL outputs assume the default PostgreSQL dialect, and the compiled `sql` fragment never includes the `WHERE` keyword.

---

## Getting Started

### Your First Query

Build a single-condition predicate and compile it to parameterized SQL.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  email: string;
  status: string;
}

const { sql, params } = query<User>()
  .where('status').equals('active')
  .compile();

console.log(sql);
// status = :p1

console.log(params);
// { p1: 'active' }
```

### Type-Safe Columns and Values

The schema type parameter constrains both the column names you can reference and the values you can pass to each comparison. The following fragment illustrates the mistakes the compiler catches for you:

```typescript fragment
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  age: number;
}

// ✅ Columns are constrained to keyof User, values to the column's type
query<User>().where('name').equals('Ada');
query<User>().where('age').greaterThan(30);

// ❌ Type error: '"userName"' is not assignable to parameter of type 'keyof User'
query<User>().where('userName').equals('Ada');

// ❌ Type error: '"thirty"' is not assignable to parameter of type 'number'
query<User>().where('age').equals('thirty');
```

### Understanding the CompileResult

`compile()` returns a `CompileResult` with the SQL fragment, the parameter map, and — only when debug mode is enabled — a `DebugInfo` object. A query with no conditions compiles to an empty fragment.

```typescript
import { query } from 'blendsdk/expression';
import type { CompileResult } from 'blendsdk/expression';

interface User {
  id: number;
  email: string;
  status: string;
}

const result: CompileResult = query<User>()
  .where('status').equals('active')
  .and('email').endsWith('@example.com')
  .compile();

console.log(result.sql);
// status = :p1 AND email LIKE :p2

console.log(result.params);
// { p1: 'active', p2: '%@example.com' }

console.log(result.debug);
// undefined

const empty = query<User>().compile();

console.log(JSON.stringify(empty));
// {"sql":"","params":{}}
```

---

## Comparison Operators

### Equality and Inequality

Use `equals` for `=` and `notEquals` for `<>`.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  status: string;
  role: string;
}

const { sql, params } = query<User>()
  .where('status').notEquals('banned')
  .and('role').equals('admin')
  .compile();

console.log(sql);
// status <> :p1 AND role = :p2

console.log(params);
// { p1: 'banned', p2: 'admin' }
```

### Ordering Comparisons

`greaterThan`, `greaterThanOrEqual`, `lessThan`, and `lessThanOrEqual` map directly to `>`, `>=`, `<`, and `<=`.

```typescript
import { query } from 'blendsdk/expression';

interface Product {
  id: number;
  price: number;
}

const wide = query<Product>()
  .where('price').greaterThan(100)
  .and('price').lessThanOrEqual(500)
  .compile();

console.log(wide.sql);
// price > :p1 AND price <= :p2

console.log(wide.params);
// { p1: 100, p2: 500 }

const strict = query<Product>()
  .where('price').greaterThanOrEqual(100)
  .and('price').lessThan(500)
  .compile();

console.log(strict.sql);
// price >= :p1 AND price < :p2

console.log(strict.params);
// { p1: 100, p2: 500 }
```

### Range Filters with BETWEEN

`between` renders an inclusive `BETWEEN ... AND ...` with two parameters; `notBetween` is the negated form.

```typescript
import { query } from 'blendsdk/expression';

interface Product {
  id: number;
  price: number;
}

const withinRange = query<Product>()
  .where('price').between(9.99, 99.99)
  .compile();

console.log(withinRange.sql);
// price BETWEEN :p1 AND :p2

console.log(withinRange.params);
// { p1: 9.99, p2: 99.99 }

const outsideRange = query<Product>()
  .where('price').notBetween(9.99, 99.99)
  .compile();

console.log(outsideRange.sql);
// price NOT BETWEEN :p1 AND :p2

console.log(outsideRange.params);
// { p1: 9.99, p2: 99.99 }
```

### Set Membership with IN and NOT IN

`in` and `notIn` accept an array of values and register one parameter per element, keeping the values out of the SQL text.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  status: string;
}

const allowed = query<User>()
  .where('status').in(['active', 'pending', 'suspended'])
  .compile();

console.log(allowed.sql);
// status IN (:p1, :p2, :p3)

console.log(allowed.params);
// { p1: 'active', p2: 'pending', p3: 'suspended' }

const excluded = query<User>()
  .where('status').notIn(['banned', 'deleted'])
  .compile();

console.log(excluded.sql);
// status NOT IN (:p1, :p2)

console.log(excluded.params);
// { p1: 'banned', p2: 'deleted' }
```

### Putting Multiple Operators Together

Parameters are numbered sequentially across the whole query — including inside `IN` lists and `BETWEEN` ranges — and NULL checks add no parameter at all.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  bio: string;
  age: number;
  score: number;
  status: string;
  deleted_at: string | null;
}

const { sql, params } = query<User>()
  .where('status').in(['active', 'pending'])
  .and('age').between(18, 65)
  .and('score').greaterThanOrEqual(50)
  .and('name').startsWith('A')
  .and('bio').contains('typescript')
  .and('deleted_at').isNull()
  .compile();

console.log(sql);
// status IN (:p1, :p2) AND age BETWEEN :p3 AND :p4 AND score >= :p5 AND name LIKE :p6 AND bio LIKE :p7 AND deleted_at IS NULL

console.log(params);
// {
//   p1: 'active', p2: 'pending', p3: 18, p4: 65,
//   p5: 50, p6: 'A%', p7: '%typescript%'
// }
```

---

## Logical Composition and Grouping

### Chaining Conditions with AND

Column-form `and()` connects the next terminal comparison with the existing tree using `AND`.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  status: string;
  age: number;
  email_verified: boolean;
}

const { sql, params } = query<User>()
  .where('status').equals('active')
  .and('age').greaterThan(18)
  .and('email_verified').equals(true)
  .compile();

console.log(sql);
// status = :p1 AND age > :p2 AND email_verified = :p3

console.log(params);
// { p1: 'active', p2: 18, p3: true }
```

### Building OR Alternatives

Column-form `or()` connects the next comparison with the existing tree using `OR`.

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

### Grouping Mixed AND/OR Logic

Pass a callback to `and()` or `or()` to wrap a subtree in parentheses. Always use a callback group whenever a condition mixes `AND` with `OR` — plain chains are emitted without implicit parentheses.

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
    .where('age').greaterThan(21)
    .or('verified').equals(true)
  )
  .compile();

console.log(sql);
// status = :p1 AND (age > :p2 OR verified = :p3)

console.log(params);
// { p1: 'active', p2: 21, p3: true }
```

### Multiple Groups at the Same Level

Each callback group becomes a parenthesized operand; nested builders share the parent's parameter manager, so numbering stays continuous across all groups.

```typescript
import { query } from 'blendsdk/expression';

interface Ticket {
  id: number;
  priority: string;
  status: string;
  escalated: boolean;
  reopened: boolean;
}

const { sql, params } = query<Ticket>()
  .where(q => q
    .where('priority').equals('critical')
    .or('escalated').equals(true)
  )
  .and(q => q
    .where('status').equals('open')
    .or('reopened').equals(true)
  )
  .compile();

console.log(sql);
// (priority = :p1 OR escalated = :p2) AND (status = :p3 OR reopened = :p4)

console.log(params);
// { p1: 'critical', p2: true, p3: 'open', p4: true }
```

### Deeply Nested Conditions

Callbacks nest arbitrarily deep. A group callback that records no conditions is ignored entirely.

```typescript
import { query } from 'blendsdk/expression';

interface Segment {
  id: number;
  country: string;
  tier: string;
  age: number;
  verified: boolean;
}

const { sql, params } = query<Segment>()
  .where('country').equals('NL')
  .and(q1 => q1
    .where('tier').equals('gold')
    .or(q2 => q2
      .where('age').greaterThanOrEqual(18)
      .and('verified').equals(true)
    )
  )
  .compile();

console.log(sql);
// country = :p1 AND (tier = :p2 OR (age >= :p3 AND verified = :p4))

console.log(params);
// { p1: 'NL', p2: 'gold', p3: 18, p4: true }
```

---

## NULL Handling and Value Serialization

### SQL NULL Checks with isNull and isNotNull

`isNull()` and `isNotNull()` emit `IS NULL` / `IS NOT NULL` and register no parameters.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  deleted_at: string | null;
  email_verified_at: string | null;
}

const { sql, params } = query<User>()
  .where('deleted_at').isNull()
  .and('email_verified_at').isNotNull()
  .compile();

console.log(sql);
// deleted_at IS NULL AND email_verified_at IS NOT NULL

console.log(params);
// {}
```

### null and undefined Normalization

`undefined` is normalized to `null` when stored. Note that `equals(null)` still emits `= :pN` — in SQL that comparison never matches a row, so use `isNull()` for real NULL semantics.

```typescript
import { query } from 'blendsdk/expression';

interface Setting {
  id: number;
  value?: string | null;
}

const withNull = query<Setting>()
  .where('value').equals(null)
  .compile();

console.log(withNull.sql);
// value = :p1

console.log(withNull.params);
// { p1: null }

const withUndefined = query<Setting>()
  .where('value').equals(undefined)
  .compile();

console.log(withUndefined.sql);
// value = :p1

console.log(withUndefined.params);
// { p1: null }
```

### Date Values Become ISO Strings

`Date` instances are serialized to ISO-8601 strings when registered as parameters.

```typescript
import { query } from 'blendsdk/expression';

interface Event {
  id: number;
  name: string;
  created_at: Date;
}

const { sql, params } = query<Event>()
  .where('created_at').greaterThan(new Date('2024-06-01T00:00:00.000Z'))
  .and('created_at').lessThan(new Date('2024-07-01T00:00:00.000Z'))
  .compile();

console.log(sql);
// created_at > :p1 AND created_at < :p2

console.log(params);
// { p1: '2024-06-01T00:00:00.000Z', p2: '2024-07-01T00:00:00.000Z' }
```

### Values Never Leak into SQL

Quotes, semicolons, backslashes, and unicode characters are bound as data, never concatenated into the statement — hostile input cannot change the query structure.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
}

const hostileInput = "O'Brien'; DROP TABLE users; --";
const unicode = 'José García 日本語';

const { sql, params } = query<User>()
  .where('name').equals(hostileInput)
  .or('name').equals(unicode)
  .compile();

console.log(sql);
// name = :p1 OR name = :p2

console.log(params);
// { p1: "O'Brien'; DROP TABLE users; --", p2: 'José García 日本語' }
```

---

## Pattern Matching

### LIKE and ILIKE

`like` emits `LIKE` with a parameterized pattern; `ilike` emits the case-insensitive PostgreSQL `ILIKE` operator.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  email: string;
}

const { sql, params } = query<User>()
  .where('email').like('%@gmail.com')
  .and('name').ilike('%smith%')
  .compile();

console.log(sql);
// email LIKE :p1 AND name ILIKE :p2

console.log(params);
// { p1: '%@gmail.com', p2: '%smith%' }
```

### startsWith, endsWith, and contains

These helpers are sugar over `like` that inject `%` wildcards around the value.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  email: string;
  bio: string;
}

const starts = query<User>().where('name').startsWith('Dr. ').compile();

console.log(starts.sql);
// name LIKE :p1

console.log(starts.params);
// { p1: 'Dr. %' }

const ends = query<User>().where('email').endsWith('@example.com').compile();

console.log(ends.sql);
// email LIKE :p1

console.log(ends.params);
// { p1: '%@example.com' }

const contains = query<User>().where('bio').contains('typescript').compile();

console.log(contains.sql);
// bio LIKE :p1

console.log(contains.params);
// { p1: '%typescript%' }
```

### Escaping LIKE Wildcards

Values pass through to the database unchanged, so `%` and `_` inside user input act as LIKE wildcards. Escape them before building the pattern if that is not desired.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}

const userInput = 'under_score';

const { sql, params } = query<User>()
  .where('name').contains(escapeLike(userInput))
  .compile();

console.log(sql);
// name LIKE :p1

console.log(params.p1);
// %under\_score%
```

---

## JSON and JSONB Operations

### JSON Containment

`jsonContains` emits the PostgreSQL `@>` operator; `jsonContainedBy` emits `<@`. Objects and arrays are stored as-is and serialized by your database driver.

```typescript
import { query } from 'blendsdk/expression';

interface Document {
  id: number;
  metadata: Record<string, unknown>;
}

const premium = query<Document>()
  .where('metadata').jsonContains({ plan: 'premium', active: true })
  .compile();

console.log(premium.sql);
// metadata @> :p1

console.log(premium.params);
// { p1: { plan: 'premium', active: true } }

const nested = query<Document>()
  .where('metadata').jsonContainedBy({
    plan: 'premium',
    active: true,
    region: 'eu',
  })
  .compile();

console.log(nested.sql);
// metadata <@ :p1
```

### JSON Key Existence

`jsonHasKey` emits `?` with a single key parameter, while `jsonHasAnyKey` (`?|`) and `jsonHasAllKeys` (`?&`) register the whole key array as one parameter.

```typescript
import { query } from 'blendsdk/expression';

interface Document {
  id: number;
  metadata: Record<string, unknown>;
  tags: string[];
}

const singleKey = query<Document>()
  .where('metadata').jsonHasKey('email')
  .compile();

console.log(singleKey.sql);
// metadata ? :p1

console.log(singleKey.params);
// { p1: 'email' }

const anyKey = query<Document>()
  .where('metadata').jsonHasAnyKey(['email', 'phone'])
  .compile();

console.log(anyKey.sql);
// metadata ?| :p1

console.log(anyKey.params);
// { p1: ['email', 'phone'] }

const allKeys = query<Document>()
  .where('tags').jsonHasAllKeys(['typescript', 'sql'])
  .compile();

console.log(allKeys.sql);
// tags ?& :p1

console.log(allKeys.params);
// { p1: ['typescript', 'sql'] }
```

### JSON Path Existence

`jsonPathExists` emits the PostgreSQL `@?` operator with the JSON path as a parameter.

```typescript
import { query } from 'blendsdk/expression';

interface Document {
  id: number;
  metadata: Record<string, unknown>;
}

const { sql, params } = query<Document>()
  .where('metadata').jsonPathExists('$.user.email')
  .compile();

console.log(sql);
// metadata @? :p1

console.log(params);
// { p1: '$.user.email' }
```

---

## Full-Text Search

### Single-Column Search

Call `search()` on a comparison builder to search a single column. The search text is parameterized; the language is embedded in the generated SQL.

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

### Multi-Column Search

`search()` on the query builder accepts an array of columns, concatenated with spaces inside a single `to_tsvector` call.

```typescript
import { query } from 'blendsdk/expression';

interface Post {
  id: number;
  title: string;
  body: string;
}

const { sql, params } = query<Post>()
  .search(['title', 'body'], 'javascript tutorial')
  .compile();

console.log(sql);
// to_tsvector('english', title || ' ' || body) @@ plainto_tsquery('english', :p1)

console.log(params);
// { p1: 'javascript tutorial' }
```

### Search Modes and Language

`mode` selects the tsquery parser (`plain`, `phrase`, or `websearch`) and `language` selects the text-search configuration. Use a fixed, developer-chosen language identifier.

```typescript
import { query } from 'blendsdk/expression';

interface Post {
  id: number;
  title: string;
  body: string;
}

const phrase = query<Post>()
  .search('body', 'database indexing strategies', { mode: 'phrase' })
  .compile();

console.log(phrase.sql);
// to_tsvector('english', body) @@ phraseto_tsquery('english', :p1)

const webSearch = query<Post>()
  .search(['title', 'body'], 'typescript or javascript -coffee', {
    mode: 'websearch',
    language: 'english',
  })
  .compile();

console.log(webSearch.sql);
// to_tsvector('english', title || ' ' || body) @@ websearch_to_tsquery('english', :p1)

console.log(webSearch.params);
// { p1: 'typescript or javascript -coffee' }

const german = query<Post>()
  .where('body').search('datenbank', { language: 'german' })
  .compile();

console.log(german.sql);
// to_tsvector('german', body) @@ plainto_tsquery('german', :p1)
```

### Combining Search with Filters

`search()` on the query builder is AND-combined with the existing condition tree.

```typescript
import { query } from 'blendsdk/expression';

interface Post {
  id: number;
  title: string;
  body: string;
  published: boolean;
}

const { sql, params } = query<Post>()
  .where('published').equals(true)
  .search(['title', 'body'], 'database indexing')
  .compile();

console.log(sql);
// published = :p1 AND to_tsvector('english', title || ' ' || body) @@ plainto_tsquery('english', :p2)

console.log(params);
// { p1: true, p2: 'database indexing' }
```

---

## Subqueries

### EXISTS with a Correlated Subquery

`exists` wraps the subquery's predicate in `EXISTS (SELECT 1 WHERE ...)`. Use `equalsColumn` inside the subquery for correlated column references — it embeds the column name directly and registers no parameter.

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

// Correlated subquery: an order row that belongs to the customer row being filtered
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

Only pass trusted, developer-controlled column references to `equalsColumn` — the string is embedded directly into the SQL text.

### IN Subqueries and Parameter Scope

`inSubquery` renders `column IN (SELECT * WHERE ...)`. Each builder owns its own parameter manager, so literals registered inside a subquery are **not** included in the parent's `params` map — compile the subquery too and bind both maps together.

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

const bigSpenders = query<Order>()
  .where('total').greaterThan(1000);

const subqueryResult = bigSpenders.compile();

console.log(subqueryResult.sql);
// total > :p1

console.log(subqueryResult.params);
// { p1: 1000 }

const customerResult = query<Customer>()
  .where('id').inSubquery(bigSpenders)
  .compile();

console.log(customerResult.sql);
// id IN (SELECT * WHERE total > :p1)

console.log(customerResult.params);
// {} — the subquery's parameters live on the subquery's own manager

const allParams = { ...subqueryResult.params, ...customerResult.params };

console.log(allParams);
// { p1: 1000 }
```

Because every builder numbers its placeholders from `p1`, keep literal values on one side of the boundary only (parent or subquery, not both) — merging two maps that both contain `p1` would collide.

### NOT EXISTS and NOT IN

The negated variants render `NOT EXISTS (...)` and `column NOT IN (SELECT * WHERE ...)`.

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

const orders = query<Order>()
  .where('total').greaterThan(0);

const notIn = query<Customer>()
  .where('id').notInSubquery(orders)
  .compile();

console.log(notIn.sql);
// id NOT IN (SELECT * WHERE total > :p1)

const correlatedOrders = query<Order>()
  .where('customer_id').equalsColumn('customers.id');

const notExists = query<Customer>()
  .where('id').notExists(correlatedOrders)
  .compile();

console.log(notExists.sql);
// NOT EXISTS (SELECT 1 WHERE customer_id = customers.id)
```

### Guarding Empty Subqueries

The subquery methods throw immediately at build time when the subquery has no conditions.

```typescript
import { query } from 'blendsdk/expression';

interface Customer {
  id: number;
}

interface Order {
  id: number;
  total: number;
}

const emptySubquery = query<Order>();

try {
  query<Customer>().where('id').inSubquery(emptySubquery).compile();
} catch (error) {
  if (error instanceof Error) {
    console.log(error.message);
    // Subquery must have at least one condition
  }
}
```

---

## Debugging and Introspection

### Debug Mode and DebugInfo

Enable debug mode with `query({ debug: true })` or `.debug()` to attach a `DebugInfo` snapshot — AST root, parameter count, optimizations, warnings, and compilation time — to the result.

```typescript
import { query } from 'blendsdk/expression';

interface Order {
  id: number;
  status: string;
  total: number;
}

const result = query<Order>({ debug: true })
  .where('status').equals('paid')
  .and('total').greaterThan(100)
  .compile();

console.log(result.sql);
// status = :p1 AND total > :p2

console.log(result.debug?.parameterCount);
// 2

console.log(result.debug?.optimizations);
// []

console.log(result.debug?.warnings);
// []

console.log(typeof result.debug?.compilationTime);
// number (milliseconds)

const empty = query<Order>().debug().compile();

console.log(JSON.stringify(empty.sql));
// ''

console.log(empty.debug?.warnings);
// ['No conditions specified']
```

### Inspecting the AST

`getAST()` returns the root AST node (`null` when no conditions were recorded). Discriminate node kinds with the `ASTNodeType` enum and annotate with the exported node interfaces.

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
  .where('published').equals(true)
  .and(q => q
    .where('title').like('%SQL%')
    .or('title').like('%database%')
  )
  .getAST();

if (ast) {
  console.log(describe(ast));
  // AND(Comparison(published =), Group(OR(Comparison(title LIKE), Comparison(title LIKE))))
}

const emptyAst = query<Article>().getAST();

console.log(emptyAst);
// null
```

---

## Advanced Usage

### Compiling an AST with PostgreSQLCompiler

`PostgreSQLCompiler` is exported for pipelines that keep an AST around and compile it separately. It only needs a `ParameterManager` to format placeholder names.

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
  .where('status').equals('active')
  .and('age').greaterThan(18);

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

console.log(compiler.getOptimizations());
// []

console.log(compiler.getWarnings());
// []
```

### Driving ParameterManager Directly

`ParameterManager` can be used standalone: it generates sequential names, serializes values (`undefined` → `null`, `Date` → ISO string), formats dialect placeholders, and can look up existing parameters with an identical value.

```typescript
import { ParameterManager, SqlDialect } from 'blendsdk/expression';

const manager = new ParameterManager(SqlDialect.PostgreSQL);

const first = manager.addParameterWithValue('active');
const second = manager.addParameterWithValue(new Date('2024-01-01T00:00:00.000Z'));
const third = manager.addParameterWithValue(undefined);

console.log(first);
// p1
console.log(second);
// p2
console.log(third);
// p3

console.log(manager.formatParameterPlaceholder(first));
// :p1

console.log(manager.getParameters());
// { p1: 'active', p2: '2024-01-01T00:00:00.000Z', p3: null }

console.log(manager.getParameterCount());
// 3

console.log(manager.deduplicateParameter('active'));
// p1

console.log(manager.deduplicateParameter('unknown'));
// null
```

### Using QueryBuilderImpl Directly

`query()` is the recommended factory, but the concrete `QueryBuilderImpl` class is also exported for advanced use.

```typescript
import { QueryBuilderImpl, SqlDialect } from 'blendsdk/expression';

interface AuditLog {
  id: number;
  actor: string;
  action: string;
  created_at: Date;
}

const builder = new QueryBuilderImpl<AuditLog>({ dialect: SqlDialect.PostgreSQL });

const { sql, params } = builder
  .where('action').equals('login')
  .and('created_at').greaterThan(new Date('2024-01-01T00:00:00.000Z'))
  .compile();

console.log(sql);
// action = :p1 AND created_at > :p2

console.log(params);
// { p1: 'login', p2: '2024-01-01T00:00:00.000Z' }
```

---

## Real-World Patterns

### Building Filters Dynamically

Build the condition tree from an optional filter object, using `where` for the first present condition and `and` for the rest.

```typescript
import { query } from 'blendsdk/expression';
import type { QueryBuilder } from 'blendsdk/expression';

interface Product {
  id: number;
  name: string;
  category: string;
  price: number;
}

interface ProductFilter {
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  nameContains?: string;
}

function buildProductQuery(filter: ProductFilter): QueryBuilder<Product> {
  let builder: QueryBuilder<Product> = query<Product>();
  let isFirstCondition = true;

  if (filter.category !== undefined) {
    builder = isFirstCondition
      ? builder.where('category').equals(filter.category)
      : builder.and('category').equals(filter.category);
    isFirstCondition = false;
  }

  if (filter.minPrice !== undefined) {
    builder = isFirstCondition
      ? builder.where('price').greaterThanOrEqual(filter.minPrice)
      : builder.and('price').greaterThanOrEqual(filter.minPrice);
    isFirstCondition = false;
  }

  if (filter.maxPrice !== undefined) {
    builder = isFirstCondition
      ? builder.where('price').lessThanOrEqual(filter.maxPrice)
      : builder.and('price').lessThanOrEqual(filter.maxPrice);
    isFirstCondition = false;
  }

  if (filter.nameContains !== undefined) {
    builder = isFirstCondition
      ? builder.where('name').contains(filter.nameContains)
      : builder.and('name').contains(filter.nameContains);
    isFirstCondition = false;
  }

  return builder;
}

const { sql, params } = buildProductQuery({
  category: 'books',
  minPrice: 10,
  nameContains: 'TypeScript',
}).compile();

console.log(sql);
// category = :p1 AND price >= :p2 AND name LIKE :p3

console.log(params);
// { p1: 'books', p2: 10, p3: '%TypeScript%' }

const unfiltered = buildProductQuery({}).compile();

console.log(JSON.stringify(unfiltered));
// {"sql":"","params":{}}
```

### Guarding Empty IN Lists

An empty array compiles to `column IN ()`, which PostgreSQL rejects at parse time. Guard against it before adding the condition.

```typescript
import { query } from 'blendsdk/expression';
import type { QueryBuilder } from 'blendsdk/expression';

interface Product {
  id: number;
  category: string;
}

function withCategories(
  builder: QueryBuilder<Product>,
  categories: string[]
): QueryBuilder<Product> {
  if (categories.length === 0) {
    // An empty IN list would compile to `category IN ()`,
    // which PostgreSQL rejects at parse time.
    return builder;
  }
  return builder.and('category').in(categories);
}

const withoutFilter = withCategories(query<Product>(), []).compile();

console.log(JSON.stringify(withoutFilter));
// {"sql":"","params":{}}

const withFilter = withCategories(query<Product>(), ['books', 'music']).compile();

console.log(withFilter.sql);
// category IN (:p1, :p2)

console.log(withFilter.params);
// { p1: 'books', p2: 'music' }

// Without the guard, the emitted fragment is invalid:
const unguarded = query<Product>().where('category').in([]).compile();

console.log(unguarded.sql);
// category IN ()

console.log(unguarded.params);
// {}
```

### Composing Full Statements and Positional Placeholders

The compiled fragment excludes the `WHERE` keyword — append it to your statement. For drivers that expect positional placeholders such as `$1`, rewrite the named placeholders and collect the values in order.

```typescript
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  email: string;
  status: string;
}

const { sql, params } = query<User>()
  .where('status').equals('active')
  .and('email').endsWith('@example.com')
  .compile();

const statement = `SELECT id, email FROM users WHERE ${sql} ORDER BY id`;

console.log(statement);
// SELECT id, email FROM users WHERE status = :p1 AND email LIKE :p2 ORDER BY id

console.log(params);
// { p1: 'active', p2: '%@example.com' }

// Rewriting helper: for SQL produced by this package, `:`-prefixed text
// only occurs in placeholder positions, so a simple scan is safe.
function toPositional(
  namedSql: string,
  namedParams: Record<string, unknown>
): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const text = namedSql.replace(/:([A-Za-z0-9_]+)/g, (_match: string, name: string) => {
    values.push(namedParams[name]);
    return `$${values.length}`;
  });
  return { text, values };
}

const { text, values } = toPositional(statement, params);

console.log(text);
// SELECT id, email FROM users WHERE status = $1 AND email LIKE $2 ORDER BY id

console.log(values);
// ['active', '%@example.com']
```

### Branching Queries with Factory Functions

When several queries share a base condition, create each branch with a factory function. Every call to `query()` produces an independent builder with its own parameter manager, so the branches never interfere.

```typescript
import { query } from 'blendsdk/expression';
import type { QueryBuilder } from 'blendsdk/expression';

interface User {
  id: number;
  status: string;
  role: string;
}

function activeUsers(): QueryBuilder<User> {
  return query<User>().where('status').equals('active');
}

const adminQuery = activeUsers().and('role').equals('admin').compile();
const editorQuery = activeUsers().and('role').equals('editor').compile();

console.log(adminQuery.sql);
// status = :p1 AND role = :p2

console.log(adminQuery.params);
// { p1: 'active', p2: 'admin' }

console.log(editorQuery.sql);
// status = :p1 AND role = :p2

console.log(editorQuery.params);
// { p1: 'active', p2: 'editor' }
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
