> **Package**: `blendsdk/dbcore`

# dbcore Advanced Patterns

This document goes beyond single-statement usage and covers the composition patterns that make `blendsdk/dbcore` effective in production code: dynamic filter construction shared across statement types, transactional multi-table writes with `RETURNING`, repository layers over the data-service base classes, optimistic concurrency, query lifecycle hooks, raw SQL for reporting, and extending the statement hierarchy with custom operations. It assumes the abstractions from Core Concepts — `Database`, the statement hierarchy, and the `blendsdk/expression` integration — and the day-to-day recipes from Basic Usage.

Every example imports only from the public API of `blendsdk/dbcore` and `blendsdk/expression`, and pattern functions accept the abstract `Database` type, so the same code runs against any concrete adapter. Where a pattern talks about executed SQL, it references a small recording adapter defined once below, which mirrors the approach used by the package's own test suites.

## Pattern Index

| # | Pattern | Problem It Solves | Core APIs Used |
| --- | --- | --- | --- |
| 1 | Composable filter builders | Optional search criteria; one filter definition reused by SELECT, UPDATE, and DELETE | `query()`, `byExpression()`, `filterByExpression()` |
| 2 | Transactional unit of work | Multi-table writes that must be atomic; generated ids flowing into dependent inserts | `withTransaction()`, `insert()`, `update()`, `returning()` |
| 3 | Write-through repository | Centralized, transaction-aware access to a single relation, with one normalization path | `QueryDataService`, `createQueryService()` |
| 4 | Optimistic concurrency | Lost-update protection when two editors save the same row | `filter()` + `filterByExpression()`, `executeReturnSingle()` |
| 5 | Query lifecycle hooks | Normalizing inputs and hydrating rows at the driver boundary | `beforeQuery()`, `afterQuery()`, `ExecuteQueryOptions` |
| 6 | Raw SQL for reporting | Aggregates and joins the statement builders do not express | `executeQuery<R>()`, `ExecuteQueryOptions` |
| 7 | Custom statement types | Dialect-specific operations such as UPSERT with the same fluent API | `InsertStatement` subclass, `Database` factories |

---

## Shared Example Setup — The Recording Adapter

The CRUD statement classes are abstract: concrete adapters implement `buildQuery()` and `buildParameters()`. To keep the pattern examples complete and their output observable, this document uses one shared harness — a concrete `Database` adapter that records every statement it is asked to run and answers with canned results. It follows the same shape the package's own tests use (named parameters, `RETURNING` rendering from `_returning`, and the cached compiled filter in WHERE clauses).

```typescript
import {
  Database,
  DeleteStatement,
  ExecuteQueryOptions,
  InsertStatement,
  QueryResult,
  UpdateStatement,
} from 'blendsdk/dbcore';

/** Named-parameter bag exchanged with the adapter. */
export type QueryParams = Record<string, unknown>;

interface RecordedQuery {
  query: string;
  params: QueryParams;
}

/** INSERT builder: renders named parameters plus an optional RETURNING clause. */
class RecordingInsertStatement<T> extends InsertStatement<T> {
  protected buildQuery(): string {
    const columns = Object.keys(this._values);
    const placeholders = columns.map((column) => `:${column}`);
    const returning = this._returning.length > 0 ? ` RETURNING ${this._returning.join(', ')}` : '';
    return `INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})${returning}`;
  }

  protected buildParameters(): Partial<T> {
    return this._values;
  }
}

/** UPDATE builder: SET assignments plus the cached compiled filter as the WHERE clause. */
class RecordingUpdateStatement<T, F> extends UpdateStatement<T, F> {
  protected buildQuery(): string {
    const assignments = Object.keys(this._values).map((column) => `${column} = :v_${column}`);
    const filter = this.getCompiledExpression();
    const where = filter ? ` WHERE ${filter.sql}` : '';
    const returning = this._returning.length > 0 ? ` RETURNING ${this._returning.join(', ')}` : '';
    return `UPDATE ${this.tableName} SET ${assignments.join(', ')}${where}${returning}`;
  }

  protected buildParameters(): QueryParams {
    const params: QueryParams = {};
    for (const [column, value] of Object.entries(this._values)) {
      params[`v_${column}`] = value;
    }
    const filter = this.getCompiledExpression();
    if (filter) {
      Object.assign(params, filter.params);
    }
    return params;
  }
}

/** DELETE builder: filter-only WHERE clause plus an optional RETURNING clause. */
class RecordingDeleteStatement<F> extends DeleteStatement<F> {
  protected buildQuery(): string {
    const filter = this.getCompiledExpression();
    const where = filter ? ` WHERE ${filter.sql}` : '';
    const returning = this._returning.length > 0 ? ` RETURNING ${this._returning.join(', ')}` : '';
    return `DELETE FROM ${this.tableName}${where}${returning}`;
  }

  protected buildParameters(): QueryParams {
    const filter = this.getCompiledExpression();
    return filter ? { ...filter.params } : {};
  }
}

/**
 * Minimal concrete adapter: records every statement it is asked to run and
 * answers with `nextResult`. Swap it for a real adapter (PostgreSQL, MySQL, …)
 * — the pattern code in this document only uses the public API.
 */
export class RecordingDatabase extends Database {
  /** Every query the patterns executed, in order, with the final parameters. */
  public readonly executed: RecordedQuery[] = [];

  /** Canned answer returned for every executed query. */
  public nextResult: QueryResult<unknown> = { records: [], rowCount: 0 };

  constructor() {
    super({ host: 'localhost', database: 'example' });
  }

  async connect(): Promise<void> {
    // Nothing to open for the harness.
  }

  async disconnect(): Promise<void> {
    // Nothing to release for the harness.
  }

  async executeQuery<R>(
    query: string,
    params?: QueryParams,
    options?: ExecuteQueryOptions
  ): Promise<QueryResult<R> | null> {
    let boundParams: QueryParams = params ?? {};
    if (options?.beforeQuery !== undefined) {
      boundParams = options.beforeQuery(boundParams);
    }
    this.executed.push({ query, params: boundParams });

    const stored = this.nextResult.records as R[];
    let records: R[] = stored;
    if (options?.afterQuery !== undefined) {
      records = options.afterQuery(records);
    }

    return { records, rowCount: this.nextResult.rowCount };
  }

  async withTransaction<T>(fn: (db: this) => Promise<T>): Promise<T> {
    return fn(this);
  }

  insert<T>(tableName: string): InsertStatement<T> {
    return new RecordingInsertStatement<T>(tableName, this);
  }

  update<T, F>(tableName: string): UpdateStatement<T, F> {
    return new RecordingUpdateStatement<T, F>(tableName, this);
  }

  delete<F>(tableName: string): DeleteStatement<F> {
    return new RecordingDeleteStatement<F>(tableName, this);
  }
}
```

Driving a pattern against the harness is straightforward — set the canned answer, run the function, and inspect the recorded SQL:

```typescript
// typescript fragment
const db = new RecordingDatabase();
db.nextResult = { records: [{ id: 1, email: 'ada@example.com' }], rowCount: 1 };
// ... call any pattern function below with `db`
console.log(db.executed); // the SQL the adapter was asked to run, in order
```

---

## Pattern 1 — Composable Filter Builders for Dynamic Screens

### When to Use It

- A list or search screen where filter criteria arrive optionally and any combination must work.
- The same criteria must also drive an UPDATE (bulk change) or DELETE (bulk cleanup), not just a SELECT.
- Queries need a mandatory scope — for example, soft-deleted rows must never be visible — that must not be forgotten at individual call sites.

### Complete Example

The pattern centers on a plain function type: a filter is `(q: QueryBuilder<T>) => QueryBuilder<T>`. That single abstraction compiles into a `CompileResult` for `byExpression()` on reads and can be passed directly to `filterByExpression()` on writes — one definition, three statement types.

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';
import type { QueryBuilder } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  email: string;
  age: number;
  active: boolean;
  deleted_at: string | null;
  created_at: string;
}

/** Typed, reusable filter fragment usable by reads and writes alike. */
export type UserFilter = (q: QueryBuilder<User>) => QueryBuilder<User>;

/** Mandatory scope: soft-deleted rows are never visible. */
export const onlyNotDeleted: UserFilter = (q) => q.where('deleted_at').isNull();

export interface UserSearchCriteria {
  active?: boolean;
  minAge?: number;
  createdAfter?: string;
}

/** Builds the filter from optional criteria; absent criteria are skipped entirely. */
export function userSearchFilter(criteria: UserSearchCriteria): UserFilter {
  return (q) => {
    let builder = onlyNotDeleted(q);

    if (criteria.active !== undefined) {
      builder = builder.and('active').equals(criteria.active);
    }
    if (criteria.minAge !== undefined) {
      builder = builder.and('age').greaterThan(criteria.minAge);
    }
    if (criteria.createdAfter !== undefined) {
      builder = builder.and('created_at').greaterThan(criteria.createdAfter);
    }

    return builder;
  };
}

export async function searchUsers(db: Database, criteria: UserSearchCriteria): Promise<Partial<User>[]> {
  const filter = userSearchFilter(criteria)(query<User>()).compile();

  return db
    .from<User>('users')
    .select(['id', 'name', 'email', 'active'])
    .byExpression(filter)
    .executeReturnAll();
}

export async function deactivateUsersMatching(db: Database, criteria: UserSearchCriteria): Promise<number> {
  return db
    .update<User, User>('users')
    .values({ active: false })
    .filterByExpression(userSearchFilter(criteria))
    .executeReturnCount();
}

export async function purgeUsersMatching(db: Database, criteria: UserSearchCriteria): Promise<Partial<User>[]> {
  return db
    .delete<User>('users')
    .filterByExpression(userSearchFilter(criteria))
    .returning(['id', 'email'])
    .executeReturnAll();
}
```

With `criteria = { active: true, minAge: 18 }`, the recording adapter (or any named-parameter adapter) executes:

```text
SELECT id, name, email, active FROM users
WHERE deleted_at IS NULL AND active = :p1 AND age > :p2
-- params: { p1: true, p2: 18 }
```

The exact parameter names are assigned by `blendsdk/expression`; callers only ever see the compiled `sql` and `params`, never hand-written predicate strings.

### Why It's Valuable

- **One definition, many statements.** The same `UserFilter` powers a SELECT, a bulk UPDATE, and a bulk DELETE. Soft-delete scoping and criteria logic cannot drift between the read and write paths.
- **No SQL string assembly.** Optional criteria are handled with ordinary `if` statements inside the builder; every value is parameterized end to end, so the classic injection surface of dynamic search never exists.
- **Fragments are first-class.** `onlyNotDeleted` is a named, typed constant — reusable, testable in isolation, and easy to review.
- **Compilation happens once per statement.** `FilterableStatement` caches the compiled expression, so `buildQuery()` and `buildParameters()` reuse it without compiling twice.

### Caveats and Performance Considerations

- **AND-only merging.** Chained `filter()` and `filterByExpression()` calls combine with AND; `filter()` itself also combines its keys with AND. When you need OR or nested groups, build a single expression with explicit `.or(...)` / `.and(sub => ...)` branching.
- **Fragment composition is sequential.** Design fragments that continue an existing builder (`.and(...)`) when they are meant to be appended, and start with `.where(...)` only for the leading fragment. Conditional logic inside one builder function is the most predictable route.
- **Treat criteria as immutable.** The returned builder closes over the criteria object; mutating it after the call changes what gets compiled later (compilation is lazy — it happens on first execution).
- **Do not hardcode parameter names.** `:p1`, `:p2`, … are generated; only the adapter sees them.
- **Skip the filter when there is truly nothing to filter.** A builder with no conditions is not useful; gate `byExpression()` / `filterByExpression()` on your criteria rather than compiling an empty expression.

---

## Pattern 2 — Transactional Unit of Work with RETURNING

### When to Use It

- A logical operation spans multiple tables (invoice + lines, order + items, user + settings) and must be all-or-nothing.
- Later statements depend on values the database generates (ids, timestamps) — `returning()` eliminates the follow-up SELECT and the race that comes with it.
- A failure anywhere in the flow should leave the database untouched, without manual compensating deletes.

### Complete Example

The `withTransaction()` callback receives the transactional database handle. Every builder created from that handle participates in the same transaction; throwing inside the callback is the rollback signal.

```typescript
import { Database } from 'blendsdk/dbcore';

interface Invoice {
  id: number;
  customer_id: number;
  status: string;
  total: number;
  created_at: string;
}

interface InvoiceLine {
  id: number;
  invoice_id: number;
  description: string;
  quantity: number;
  unit_price: number;
}

export interface NewInvoiceLine {
  description: string;
  quantity: number;
  unit_price: number;
}

export interface CreatedInvoice {
  invoice: Partial<Invoice>;
  lines: Partial<InvoiceLine>[];
}

/** Wraps the nullable execution helpers: a missing record aborts the transaction. */
function requireRecord<RowType>(record: Partial<RowType> | null, operation: string): Partial<RowType> {
  if (record === null) {
    throw new Error(`${operation} returned no record`);
  }
  return record;
}

export async function createInvoiceWithLines(
  db: Database,
  customerId: number,
  lineInputs: NewInvoiceLine[]
): Promise<CreatedInvoice> {
  return db.withTransaction(async (tx) => {
    const total = lineInputs.reduce((sum, line) => sum + line.quantity * line.unit_price, 0);

    // 1. Create the invoice as a draft, capturing the generated id in the same round trip.
    const invoice = requireRecord(
      await tx
        .insert<Invoice>('invoices')
        .values({ customer_id: customerId, status: 'draft', total })
        .returning(['id', 'status', 'total', 'created_at'])
        .executeReturnSingle(),
      'INSERT INTO invoices'
    );

    const invoiceId = invoice.id;
    if (invoiceId === undefined) {
      throw new Error('INSERT INTO invoices did not return id — add it to returning()');
    }

    // 2. Attach the lines, feeding the generated invoice id into each insert.
    const lines: Partial<InvoiceLine>[] = [];
    for (const line of lineInputs) {
      const saved = requireRecord(
        await tx
          .insert<InvoiceLine>('invoice_lines')
          .values({ ...line, invoice_id: invoiceId })
          .returning(['id', 'description', 'quantity', 'unit_price'])
          .executeReturnSingle(),
        'INSERT INTO invoice_lines'
      );
      lines.push(saved);
    }

    // 3. Open the invoice once all lines exist; RETURNING * yields the final state.
    const opened = requireRecord(
      await tx
        .update<Invoice, Pick<Invoice, 'id'>>('invoices')
        .values({ status: 'open' })
        .filter({ id: invoiceId })
        .returning('*')
        .executeReturnSingle(),
      'UPDATE invoices'
    );

    return { invoice: opened, lines };
  });
}
```

One call to `createInvoiceWithLines` makes the adapter execute this sequence (one line insert per input line):

```text
INSERT INTO invoices (customer_id, status, total) VALUES (:customer_id, :status, :total)
  RETURNING id, status, total, created_at
INSERT INTO invoice_lines (description, quantity, unit_price, invoice_id)
  VALUES (:description, :quantity, :unit_price, :invoice_id)
  RETURNING id, description, quantity, unit_price
UPDATE invoices SET status = :v_status WHERE id = :p1 RETURNING *
```

Any thrown error — a failed constraint on a line, the `requireRecord` guard, a connectivity failure — rolls back all three steps; without `withTransaction`, a failed line insert would leave an orphaned draft invoice behind.

### Why It's Valuable

- **Atomicity without bookkeeping.** Throwing inside the callback is the entire rollback protocol; there are no compensating deletes or cleanup paths to maintain.
- **`RETURNING` removes follow-up round trips.** Generated ids and timestamps arrive with the write, so dependent inserts use authoritative database values — never client-guessed ones.
- **The transaction handle flows through the builder factories.** `insert()`, `update()`, `delete()`, and even `from()` created from `tx` are automatically inside the transaction; no separate connection management is needed.
- **Validation failures become safe aborts.** A `requireRecord` guard that throws is both a correctness check and a rollback trigger.

### Caveats and Performance Considerations

- **Always use the callback's `tx`, never the outer `db`.** This is the most common bug: statements built from the captured outer handle execute outside the transaction and survive a rollback. Pass `tx` down to helper functions and repositories.
- **Keep transactions short and free of external I/O.** Do not send emails or call other services inside; publish events after commit (see below), or use an outbox for durability.
- **Round trips scale with line count.** N lines means N inserts inside the transaction. For large batches, prefer adapter-provided bulk facilities or dialect bulk-loading paths.
- **Nested `withTransaction` behavior is adapter-defined.** Do not assume savepoint semantics; compose units of work at the application layer instead.
- **Guard nullable results.** `executeReturnSingle()` resolves `null` when the adapter returns no records — wrap it (as shown) so a silent no-op becomes an explicit abort.

#### Integration Note — Events After Commit

Publishing inside the transaction is wrong (a later rollback still delivered the event). Publishing immediately after commit is better but has a dual-write risk (a crash between commit and publish loses the event). The robust pattern is a transactional outbox: write the event inside the transaction, dispatch outside. The publisher is a small port interface you own — any transport client (including a pub/sub client from the BlendSDK messaging packages) can implement it, and dbcore never depends on it.

```typescript
// typescript fragment — the port your transport integration implements
export interface InvoiceCreatedEvent {
  type: 'invoice.created';
  invoiceId: number;
  total: number;
}

export interface InvoiceEventPublisher {
  publish(event: InvoiceCreatedEvent): Promise<void>;
}
```

```typescript
// typescript fragment — inside the transaction: persist the event atomically with the state change
await tx
  .insert<OutboxEvent>('outbox')
  .values({ topic: 'invoice.created', payload: JSON.stringify({ invoiceId }), status: 'pending' })
  .returning(['id'])
  .executeReturnSingle();
```

A background dispatcher then reads pending rows with `db.from<OutboxEvent>('outbox').select(['id', 'topic', 'payload']).byExpression(...)` and marks them sent after the transport acknowledges — at-least-once delivery with no lost events.

---

## Pattern 3 — Write-Through Repository over QueryDataService

### When to Use It

- Multiple handlers need read and write access to the same relation, and you want one choke point for query construction and value normalization.
- Repositories must be able to join a caller's transaction without a second abstraction layer.
- You also want zero-boilerplate read services for projections, without duplicating the `db.from(...).select().byExpression(...)` chain each time.

### Complete Example

`QueryDataService<RelationType>` already provides the typed read patterns; extending it gives writes access to the protected `db` reference inherited from `DataServiceBase`, so a single class covers the whole relation. `createQueryService()` covers the pure-read case with zero subclasses.

```typescript
import { Database, QueryDataService, createQueryService } from 'blendsdk/dbcore';

export interface User {
  id: number;
  email: string;
  name: string;
  active: boolean;
  created_at: string;
}

/** Zero-boilerplate read service for the relation, produced by the factory. */
export const PublicUserService = createQueryService<User>('users', 'id');

/** Full repository: inherited reads plus explicit writes, one normalization path. */
export class UserRepository extends QueryDataService<User> {
  constructor(db: Database) {
    super('users', 'id', db);
  }

  /** Returns the record whose email matches, or null. */
  findByEmail(email: string): Promise<Partial<User> | null> {
    return this.findByExpression((q) => {
      q.where('email').equals(normalizeEmail(email));
    });
  }

  /** Returns all active users. */
  findActive(): Promise<Partial<User>[]> {
    return this.findAllByExpression((q) => {
      q.where('active').equals(true);
    });
  }

  /** Creates a user and returns the stored row, including generated columns. */
  async create(input: Pick<User, 'email' | 'name'>): Promise<Partial<User> | null> {
    return this.db
      .insert<User>('users')
      .values({ email: normalizeEmail(input.email), name: input.name, active: true })
      .returning(['id', 'email', 'name', 'created_at'])
      .executeReturnSingle();
  }

  /** Renames a user; returns null when the id does not exist. */
  async rename(id: number, name: string): Promise<Partial<User> | null> {
    return this.db
      .update<User, Pick<User, 'id'>>('users')
      .values({ name })
      .filter({ id })
      .returning(['id', 'name'])
      .executeReturnSingle();
  }

  /** Soft-deactivates a user; returns the affected row count (0 or 1). */
  async deactivate(id: number): Promise<number> {
    return this.db
      .update<User, Pick<User, 'id'>>('users')
      .values({ active: false })
      .filter({ id })
      .executeReturnCount();
  }
}

/** Single normalization rule, applied everywhere the repository touches email. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
```

Before and after, at the call site:

```typescript
// typescript fragment — before: rules duplicated per call site (and quietly diverging)
await db.insert<User>('users').values({ email: email.trim().toLowerCase(), name, active: true }).returning('*').executeReturnSingle();
await db.update<User, Pick<User, 'id'>>('users').values({ email: email.toLowerCase() }).filter({ id }).executeReturnCount(); // forgot trim()
```

```typescript
// typescript fragment — after: call sites pass intent, the repository owns the rules
const users = new UserRepository(db);
const created = await users.create({ email, name });
```

Repositories join a unit of work simply by being constructed with the transactional handle — no extra abstractions:

```typescript
// typescript fragment — construct repositories with the tx handle to join a transaction
await db.withTransaction(async (tx) => {
  const users = new UserRepository(tx);
  await users.create({ email: 'ada@example.com', name: 'Ada Lovelace' });
  await users.rename(1, 'Ada Byron');
});
```

### Why It's Valuable

- **One choke point per relation.** Normalization (`normalizeEmail`), column lists, and returning clauses are written once instead of at every call site — and they cannot diverge.
- **Reads and writes share the same class.** `findById`, `findByExpression`, `findAllByExpression`, and `findAll` are inherited; write methods reuse the protected `db` from `DataServiceBase`.
- **Transaction composition falls out naturally.** Because the repository receives its `Database` in the constructor, `new UserRepository(tx)` joins a unit of work — the same object shape works for standalone and transactional use.
- **Testable by construction.** Any `Database` can be injected; the recording adapter or a mock makes repository tests assert both behavior and generated SQL.

### Caveats and Performance Considerations

- **Transaction membership is per-instance.** A repository bound to the root `db` cannot participate in a caller's transaction; document that transactional callers must construct the repository with `tx`.
- **`findByExpression()` does not add `LIMIT`.** It returns the first record of the result set. Use it only for predicates you expect to be unique (primary key, unique email); for everything else use `findAllByExpression()` so the intent is explicit.
- **Do not hide the DSL entirely.** If consumers need complex conditions, expose methods that accept `ExpressionBuilder<RelationType>` rather than dozens of near-duplicate finder methods.
- **One repository per relation/aggregate.** Cross-aggregate workflows belong in a small domain service that composes repositories inside `withTransaction()`.
- **Instances are stateless and cheap.** Constructing a repository per request (or per transaction) is the intended usage; do not cache a shared instance that is bound to a transaction handle.

---

## Pattern 4 — Optimistic Concurrency with Version Columns

### When to Use It

- Two users can edit the same row concurrently, and the second save must not silently overwrite the first.
- You want conflict detection without pessimistic row locks or long-lived transactions.
- You need the updated row (including its new version) in the same round trip as the write.

### Complete Example

The decision — saved or not — is made by a single conditional `UPDATE`. Merging `filter()` and `filterByExpression()` produces `WHERE id = :p1 AND version = :p2` with AND semantics, and `RETURNING` hands back the new version.

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface Article {
  id: number;
  title: string;
  body: string;
  version: number;
  updated_at: string;
}

export type SaveOutcome =
  | { status: 'saved'; record: Partial<Article> }
  | { status: 'conflict' }
  | { status: 'missing' };

export interface ArticleEdit {
  id: number;
  version: number;
  title: string;
  body: string;
}

export async function saveArticle(db: Database, edit: ArticleEdit): Promise<SaveOutcome> {
  const updated = await db
    .update<Article, Pick<Article, 'id' | 'version'>>('articles')
    .values({
      title: edit.title,
      body: edit.body,
      version: edit.version + 1,
      updated_at: new Date().toISOString(),
    })
    .filter({ id: edit.id })
    .filterByExpression((q) => q.where('version').equals(edit.version))
    .returning(['id', 'version', 'updated_at'])
    .executeReturnSingle();

  if (updated !== null) {
    return { status: 'saved', record: updated };
  }

  // Not saved: distinguish "someone else won the race" from "row was deleted".
  const stillExists = await db
    .from<Article>('articles')
    .select(['id'])
    .byExpression(query<Article>().where('id').equals(edit.id).compile())
    .executeReturnSingle();

  return stillExists !== null ? { status: 'conflict' } : { status: 'missing' };
}
```

The executed statement carries both guards; exactly one concurrent writer can match both predicates:

```text
UPDATE articles
   SET title = :v_title, body = :v_body, version = :v_version, updated_at = :v_updated_at
 WHERE id = :p1 AND version = :p2
RETURNING id, version, updated_at
```

The racy alternative this replaces:

```typescript
// typescript fragment — before: another writer can commit between the read and the write
const current = await db
  .from<Article>('articles')
  .select(['id', 'version'])
  .byExpression(query<Article>().where('id').equals(edit.id).compile())
  .executeReturnSingle();

if (current?.version !== edit.version) {
  return { status: 'conflict' };
}

await db
  .update<Article, Pick<Article, 'id'>>('articles')
  .values({ title: edit.title, body: edit.body })
  .filter({ id: edit.id })
  .executeReturnCount();
```

### Why It's Valuable

- **Atomic check-and-set.** The database serializes the two concurrent UPDATEs; the losing writer's WHERE matches zero rows. There is no window between checking and writing.
- **One round trip on the happy path.** `RETURNING ['id', 'version', 'updated_at']` delivers the post-write state; no refetch is needed to keep editing.
- **Typed outcomes.** `SaveOutcome` forces callers to handle conflicts and missing rows instead of ignoring a row count.
- **Composes with the filter abstractions.** `filter()` and `filterByExpression()` merge with AND, so a version guard layers cleanly on top of any other scoping conditions (tenant, status, soft-delete).

### Caveats and Performance Considerations

- **The application owns version bookkeeping.** Increment the version in `values()` — never inside the filter, and never rely on the adapter to do it (check your adapter's documentation if it offers columns like auto-updating `updated_at`).
- **The existence check is advisory.** It runs after the failed update and is not atomic with it; it exists solely to distinguish `conflict` from `missing` for better error messages. The saved/not-saved decision itself was already made atomically.
- **Timestamps work as tokens with caveats.** If you cannot add a version column, `updated_at` string comparison is a workable alternative, but clock resolution and equal-timestamp collisions make it strictly weaker.
- **Returning counts are fine for fire-and-forget saves.** If you do not need the updated row, `executeReturnCount()` reports 1 for success and 0 for conflict — but you lose the new version value.
- **Index on the filter columns.** `(id)` plus `(version)` (or the composite used) should be indexed; the version predicate is cheap but should not force a scan on large tables.

---

## Pattern 5 — Query Lifecycle Hooks for Data Normalization

### When to Use It

- Input values need consistent normalization (trimming, case folding) before the driver sees them.
- The database returns raw column values — ISO date strings, numeric strings — that the domain type declares differently and every consumer would otherwise convert by hand.
- The same conversions must apply on both the builder path (`statement.execute()`) and the raw `executeQuery()` path.

### Complete Example

Statement-level hooks are forwarded through `ExecuteQueryOptions` to the adapter: `beforeQuery` transforms the parameter object before execution, `afterQuery` transforms the result rows array after execution. Both are shape-preserving, so the cleanest approach is to define them once as named functions.

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface Account {
  id: number;
  email: string;
  name: string;
  active: boolean;
  created_at: Date;
}

/** beforeQuery handler: normalize inbound parameter values without renaming keys. */
function normalizeAccountParams(params: Record<string, unknown>): Record<string, unknown> {
  return {
    ...params,
    email: String(params.email ?? '').trim().toLowerCase(),
  };
}

/** afterQuery handler: hydrate raw column values into the declared domain shape. */
function hydrateAccountRow(row: Partial<Account>): Partial<Account> {
  return {
    ...row,
    created_at: row.created_at !== undefined ? new Date(row.created_at) : undefined,
  };
}

export async function registerAccount(
  db: Database,
  email: string,
  name: string
): Promise<Partial<Account> | null> {
  return db
    .insert<Account>('accounts')
    .values({ email, name, active: true })
    .beforeQuery<Record<string, unknown>>(normalizeAccountParams)
    .returning(['id', 'email', 'name', 'created_at'])
    .afterQuery<Partial<Account>[]>((rows) => rows.map(hydrateAccountRow))
    .executeReturnSingle();
}

export async function findAccountByEmail(db: Database, email: string): Promise<Partial<Account> | null> {
  return db
    .from<Account>('accounts')
    .select(['id', 'email', 'name', 'created_at'])
    .byExpression(query<Account>().where('email').equals(email.trim().toLowerCase()).compile())
    .afterQuery<Partial<Account>[]>((rows) => rows.map(hydrateAccountRow))
    .executeReturnSingle();
}
```

The same named handlers apply on the raw query path, because `ExecuteQueryOptions` carries the identical contracts:

```typescript
// typescript fragment — the same handlers on the raw executeQuery() path
const result = await db.executeQuery<Account>(
  'SELECT * FROM accounts WHERE email = :email',
  { email },
  {
    beforeQuery: normalizeAccountParams,
    afterQuery: (rows: Partial<Account>[]) => rows.map(hydrateAccountRow),
  }
);
```

Without the after-query hook, every consumer performs the conversion itself:

```typescript
// typescript fragment — before: hydration logic at every call site
const created = await db.insert<Account>('accounts').values({ email, name }).returning('*').executeReturnSingle();
const account = created === null ? null : { ...created, created_at: new Date(String(created.created_at)) };
```

### Why It's Valuable

- **The boundary is the right place.** Normalization happens exactly where values cross into the driver, and hydration exactly where rows come back — no mapping layer in between, no per-call-site conversions.
- **Works for both access styles.** Builder-based statements and raw `executeQuery()` calls share `ExecuteQueryOptions`, so one pair of handlers serves all query paths.
- **Named functions beat inline lambdas here.** `normalizeAccountParams` and `hydrateAccountRow` can be unit-tested and reused; inline variants drift.
- **Fewer bugs from raw driver values.** Drivers commonly hand back numeric aggregates as strings and timestamps as strings; centralizing the fix keeps the declared types honest.

### Caveats and Performance Considerations

- **One handler per hook.** `beforeQuery()` / `afterQuery()` assign the handler — calling them again replaces the previous one rather than chaining. Compose multiple transformations inside a single function.
- **Hooks are synchronous.** The signatures are `(params: T) => T` and `(rows: T) => T`; keep them pure, fast, and free of I/O. Do asynchronous work outside the query pipeline.
- **Preserve keys and shape.** `beforeQuery` must not rename or drop keys the SQL references (the placeholder `:email` requires the `email` key to survive). `afterQuery` must return the same row shape it received — its job is to make runtime reality match the declared type.
- **Hooks run per execution, on the whole array.** `afterQuery` receives the complete rows array even when the caller consumes a single record via `executeReturnSingle()`; mapping is O(n) and runs before the first record is picked. For very large result sets, keep transformations cheap.
- **The adapter must honor the hooks.** `Statement.execute()` forwards them through `ExecuteQueryOptions`; verify with a test that your adapter invokes `beforeQuery`/`afterQuery` (the recording adapter above shows the expected wiring).

---

## Pattern 6 — Raw SQL for Aggregates and Reports

### When to Use It

- A screen or report needs joins, `GROUP BY`, aggregates, or window functions that the statement builders do not express.
- The query must still be parameterized, typed, and post-processed consistently with builder-based queries.
- The raw query should live next to the repository code it belongs to, not in an unrelated utility module.

### Complete Example

`executeQuery<R>()` returns `QueryResult<R> | null`, binds parameters, and accepts the same `ExecuteQueryOptions` pipeline the statements use — including `afterQuery` for normalizing driver output.

```typescript
import { Database } from 'blendsdk/dbcore';

export interface CustomerRevenueRow {
  customer_id: number;
  customer_name: string;
  invoice_count: number;
  total_revenue: number;
}

export interface DateRange {
  from: string;
  to: string;
}

export async function customerRevenue(db: Database, range: DateRange): Promise<CustomerRevenueRow[]> {
  const result = await db.executeQuery<CustomerRevenueRow>(
    `SELECT c.id          AS customer_id,
            c.name        AS customer_name,
            COUNT(i.id)   AS invoice_count,
            SUM(i.total)  AS total_revenue
       FROM customers c
       JOIN invoices i ON i.customer_id = c.id
      WHERE i.created_at >= :from
        AND i.created_at <  :to
      GROUP BY c.id, c.name
      ORDER BY total_revenue DESC`,
    { from: range.from, to: range.to },
    {
      afterQuery: (rows: CustomerRevenueRow[]) =>
        rows.map((row) => ({ ...row, total_revenue: Number(row.total_revenue) })),
    }
  );

  return result?.records ?? [];
}
```

`executeQuery()` may resolve `null` depending on the adapter and driver, so the helper coalesces to `[]` — callers always receive an array. The `afterQuery` handler normalizes aggregate values, because many drivers return `SUM`/`COUNT` results as strings.

### Why It's Valuable

- **No capability ceiling.** The builders cover the common CRUD path; `executeQuery<R>()` covers everything else without leaving the abstraction — same `Database` instance, same hooks, same result envelope.
- **Still parameterized and typed.** Row shapes are declared with an interface, values are bound via parameters, and the null result is handled explicitly.
- **Consistent post-processing.** Date hydration, numeric coercion, and rename mapping use the exact same `beforeQuery`/`afterQuery` pattern as the builder path.
- **Aggregate in the database, not the app.** `GROUP BY` and `SUM` push work to the engine instead of loading rows for application-side summation.

### Caveats and Performance Considerations

- **You own the SQL dialect.** The statement builders adapt to your backend automatically; raw SQL does not. Keep queries compatible with the adapter you use (placeholder syntax, boolean literals, casing) and cover them with integration tests against the real engine.
- **Always handle the nullable result.** `result?.records ?? []` is the minimal habit; distinguish “no rows” from “adapter returned null” where it matters.
- **Normalize driver output explicitly.** Numeric aggregates as strings and timezone-less timestamps are the norm; do the coercion in `afterQuery` and document the row interface as the *post-transformation* shape.
- **No streaming.** This API resolves with the full result set; for very large reports, aggregate more aggressively in SQL rather than fetching and reducing in the application.
- **Keep predicates in sync.** If the same business filter (for example, a date range or tenant scope) exists as a builder fragment, centralize the values and reuse them for both paths to prevent divergence.

---

## Pattern 7 — Custom Statement Types for Dialect Operations

### When to Use It

- You need an operation the base hierarchy does not ship — UPSERT (`ON CONFLICT` / `ON DUPLICATE KEY`), bulk merge, dialect-specific `RETURNING` behavior.
- You are writing or extending a database adapter and want the new operation to have the same fluent surface (`values()`, `returning()`, execution helpers) as the built-in statements.
- The SQL dialect quirks should live in one class with focused tests, not be sprinkled as raw strings at call sites.

### Complete Example

Extending `InsertStatement<T>` inherits the entire fluent contract for free: `values()` from `InsertStatement`, `returning()` from `CrudStatement`, and `execute()`, `executeReturnSingle()`, `executeReturnAll()`, `executeReturnCount()` from `Statement`. The subclass only adds its own clause and rendering.

```typescript
import { InsertStatement } from 'blendsdk/dbcore';

interface DailyMetric {
  id: number;
  day: string;
  metric_name: string;
  value: number;
}

/** Dialect statement: INSERT … ON CONFLICT (…) DO UPDATE SET … RETURNING … */
export class UpsertStatement<T> extends InsertStatement<T> {
  protected conflictColumns: (keyof T)[] = [];

  /** Configures the conflict target columns for the ON CONFLICT clause. */
  onConflict(columns: (keyof T)[]): this {
    this.conflictColumns = columns;
    return this;
  }

  protected buildQuery(): string {
    const columns = Object.keys(this._values);
    const placeholders = columns.map((column) => `:${column}`);
    const conflictTargets = this.conflictColumns.map((column) => String(column));
    const updatedColumns = columns.filter((column) => !conflictTargets.includes(column));
    const assignments = updatedColumns.map((column) => `${column} = :${column}`);
    const returning = this._returning.length > 0 ? ` RETURNING ${this._returning.join(', ')}` : '';

    let conflict = '';
    if (conflictTargets.length > 0) {
      conflict =
        updatedColumns.length > 0
          ? ` ON CONFLICT (${conflictTargets.join(', ')}) DO UPDATE SET ${assignments.join(', ')}`
          : ` ON CONFLICT (${conflictTargets.join(', ')}) DO NOTHING`;
    }

    return `INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})${conflict}${returning}`;
  }

  protected buildParameters(): Partial<T> {
    return this._values;
  }
}

// RecordingDatabase is the harness adapter defined earlier in this document;
// a real adapter adds the factory the same way.
class AppDatabase extends RecordingDatabase {
  upsert<T>(tableName: string): UpsertStatement<T> {
    return new UpsertStatement<T>(tableName, this);
  }
}

export async function recordDailyMetric(
  db: AppDatabase,
  metric: Omit<DailyMetric, 'id'>
): Promise<Partial<DailyMetric> | null> {
  return db
    .upsert<DailyMetric>('daily_metrics')
    .values(metric)
    .onConflict(['day', 'metric_name'])
    .returning(['id', 'day', 'metric_name', 'value'])
    .executeReturnSingle();
}
```

For `{ day: '2025-01-01', metric_name: 'signups', value: 42 }`, the recording harness captures:

```text
INSERT INTO daily_metrics (day, metric_name, value) VALUES (:day, :metric_name, :value)
ON CONFLICT (day, metric_name) DO UPDATE SET value = :value
RETURNING id, day, metric_name, value
```

Note that the conflict target columns (`day`, `metric_name`) are excluded from the `DO UPDATE SET` assignments — they are the keys that collided and updating them would be a no-op. When every column is part of the conflict target, the statement degrades to `DO NOTHING` instead of emitting an empty assignment list.

### Why It's Valuable

- **Full fluent surface for free.** `values()`, `returning('*')`, and all four execution helpers come from the base classes; the new class adds only the dialect clause.
- **Type-safe configuration.** `onConflict(columns: (keyof T)[])` makes invalid conflict targets a compile-time error, exactly like `returning()`.
- **Dialect gravity stays in one place.** When you support multiple backends, each adapter package implements its own `UpsertStatement` (PostgreSQL `ON CONFLICT`, MySQL `ON DUPLICATE KEY`, SQL Server `MERGE`) — application code stays identical.
- **Trivially testable with a recording adapter.** The harness pattern used throughout this document asserts the generated SQL without a live database.

### Caveats and Performance Considerations

- **This SQL is dialect-specific.** The `ON CONFLICT … DO UPDATE` form shown here targets PostgreSQL-style engines; keep the class inside the adapter package, not in application code.
- **The conflict target must match a real unique index.** `ON CONFLICT (day, metric_name)` requires a unique constraint or index on exactly those columns; otherwise the engine rejects the statement at execution time.
- **Parameter keys must line up.** `buildParameters()` must return exactly the keys referenced by `buildQuery()`: here both the `VALUES` placeholders and the `SET` assignments reuse `:column` names, so returning `this._values` is sufficient. If your SQL prefix-renames placeholders, build the parameter object accordingly.
- **`values()` replaces, it does not merge.** Repeated calls overwrite the payload — same contract as the built-in statements.
- **Cover new statement types with unit tests.** SQL generation is pure string output; assert it (including the `DO NOTHING` edge case) before trusting it against a live engine. If a statement type proves broadly useful, contribute it to the adapter package rather than duplicating it per application.

---

## Integrating with the Rest of BlendSDK

`blendsdk/dbcore` deliberately has a single runtime dependency — `blendsdk/expression` — and no driver code. Every other integration happens through constructor injection or through small interfaces you own, which keeps applications testable and the package transport-agnostic.

| Layer | Integration Point | Guidance |
| --- | --- | --- |
| `blendsdk/expression` | Required compile-time dependency | Import `query`, `QueryBuilder`, and `CompileResult` directly from `blendsdk/expression`; they are not re-exported here. Patterns 1, 3, and 4 rely on it. |
| Database adapters (PostgreSQL, MySQL, …) | Extend `Database` and the abstract CRUD statements | Constructor-inject the adapter; pattern code written against the abstract `Database` type is unchanged across backends. |
| Application services and repositories | Extend `DataServiceBase` / `QueryDataService` or use `createQueryService()` | Pattern 3 shows the write-through repository; bind repositories to `tx` to join units of work (pattern 2). |
| Messaging, queue, or email clients from the wider stack | Ports you define (for example, `InvoiceEventPublisher`) | Implement the port with the client of your choice; publish after commit or via the transactional outbox shown in pattern 2. dbcore never depends on the transport. |

The key boundary rule: this package owns **query construction and execution**; everything around it — connection configuration, transaction policy, event delivery, caching — is composed at your application layer using the abstractions shown in these patterns. For the exhaustive member tables behind each pattern, see the API Reference.

---

# dbcore Common Scenarios

This document is a collection of "How do I ...?" recipes for `blendsdk/dbcore`, ordered from simple reads to implementing a complete database adapter. Every scenario contains a complete, runnable TypeScript example. Because the INSERT, UPDATE, and DELETE builders are abstract and supplied by a concrete adapter, most examples accept a `db: Database` parameter — the exact shape data-access code takes in a real application, as shown in the Overview. Expression functions such as `query()` are imported from `blendsdk/expression`, never from this package.

---

## How do I fetch all rows from a table?

**Solution** — Use `Database.selectAll<T>()` as shorthand for `from<T>(table).select()`, then finish the chain with `executeReturnAll()`, which resolves to an array of `Partial<T>` records — an empty array when the table has no rows.

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
}

export async function listAllUsers(db: Database): Promise<Partial<User>[]> {
  return db.selectAll<User>('users').executeReturnAll();
}

export async function listUsersWithExplicitBuilder(db: Database): Promise<Partial<User>[]> {
  return db.from<User>('users').select().executeReturnAll();
}
```

---

## How do I select only specific columns?

**Solution** — Pass an array of column names to `select()`; the array is rendered, in order, into the SQL column list (`SELECT id, name FROM users`). Omitting an argument selects `*`.

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
}

export async function listUserDirectory(db: Database): Promise<Partial<User>[]> {
  return db.from<User>('users').select(['id', 'name']).executeReturnAll();
}
```

---

## How do I select computed or aliased columns?

**Solution** — Pass an object to `select()`: each entry is rendered as `<expression> AS <alias>`. The values are raw SQL expressions inserted verbatim into the statement, so never build them from untrusted input.

```typescript
import { Database } from 'blendsdk/dbcore';

interface UserRow {
  id: number;
  first_name: string;
  last_name: string;
  fullName: string;
}

export async function listUsersWithFullName(db: Database): Promise<Partial<UserRow>[]> {
  return db
    .from<UserRow>('users')
    .select({
      id: 'id',
      fullName: "first_name || ' ' || last_name", // renders: first_name || ' ' || last_name AS fullName
    })
    .executeReturnAll();
}
```

---

## How do I filter a SELECT query?

**Solution** — Compile a type-safe predicate with `query()` from `blendsdk/expression` and apply it with `byExpression()`. The SQL fragment and its bound parameters travel together in the `CompileResult`, so values are always parameterized, never interpolated.

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface Product {
  id: number;
  name: string;
  price: number;
  active: boolean;
}

export async function listActiveProductsAbove(
  db: Database,
  minPrice: number
): Promise<Partial<Product>[]> {
  const filter = query<Product>()
    .where('active')
    .equals(true)
    .and('price')
    .greaterThan(minPrice)
    .compile();

  return db
    .from<Product>('products')
    .select(['id', 'name', 'price'])
    .byExpression(filter)
    .executeReturnAll();
}
```

---

## How do I count the rows that match a condition?

**Solution** — Combine the aliased-select form with a `COUNT(*)` expression and read the single result row with `executeReturnSingle()`. Drop `byExpression()` for an unfiltered count.

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  active: boolean;
}

interface UserCount {
  count: number;
}

export async function countActiveUsers(db: Database): Promise<number> {
  const filter = query<Pick<User, 'active'>>().where('active').equals(true).compile();

  const row = await db
    .from<UserCount>('users')
    .select({ count: 'COUNT(*)' }) // renders: COUNT(*) AS count
    .byExpression(filter)
    .executeReturnSingle();

  return row?.count ?? 0;
}
```

---

## How do I fetch a single record and handle "not found"?

**Solution** — `executeReturnSingle()` resolves to the first record or `null` when no rows match. Guard the result to turn a missing record into a domain-level error instead of leaking `null` through your API.

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  email: string;
}

export async function findUserById(db: Database, id: number): Promise<Partial<User> | null> {
  const filter = query<Pick<User, 'id'>>().where('id').equals(id).compile();

  return db.from<User>('users').select().byExpression(filter).executeReturnSingle();
}

export async function requireUser(db: Database, id: number): Promise<Partial<User>> {
  const user = await findUserById(db, id);
  if (!user) {
    throw new Error(`User ${id} was not found`);
  }
  return user;
}
```

---

## How do I insert a record and get the generated values back?

**Solution** — Set the payload with `values()` and request the columns to return with `returning()`. Only the fields passed to `values()` become part of the INSERT, and `executeReturnSingle()` hands back the returned row — for example, the auto-generated `id`.

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
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

export async function registerUserAllColumns(
  db: Database,
  name: string,
  email: string
): Promise<Partial<User> | null> {
  return db
    .insert<User>('users')
    .values({ name, email })
    .returning('*')
    .executeReturnSingle();
}
```

---

## How do I update rows and check how many were affected?

**Solution** — Pair `values()` with a filter, then choose your result: `executeReturnCount()` reports the number of affected rows, while `returning()` plus `executeReturnSingle()` hands back the updated record itself.

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  status: string;
  updated_at: string;
}

export async function deactivateUser(db: Database, id: number): Promise<boolean> {
  const affected = await db
    .update<User, Pick<User, 'id'>>('users')
    .values({ status: 'inactive' })
    .filter({ id })
    .executeReturnCount();

  return affected > 0;
}

export async function deactivateUserReturningRow(
  db: Database,
  id: number
): Promise<Partial<User> | null> {
  return db
    .update<User, Pick<User, 'id'>>('users')
    .values({ status: 'inactive' })
    .filter({ id })
    .returning(['id', 'status', 'updated_at'])
    .executeReturnSingle();
}
```

---

## How do I delete rows and capture what was deleted?

**Solution** — Filter with `filter()` or `filterByExpression()`, and add `returning()` to receive the deleted rows. Always provide a filter — an unfiltered DELETE statement removes every row in the table.

```typescript
import { Database } from 'blendsdk/dbcore';

interface Session {
  id: number;
  user_id: number;
  expires_at: string;
}

export async function purgeExpiredSessions(db: Database, now: string): Promise<Partial<Session>[]> {
  return db
    .delete<Session>('sessions')
    .filterByExpression((q) => q.where('expires_at').lessThan(now))
    .returning(['id', 'user_id'])
    .executeReturnAll();
}

export async function deleteSessionById(db: Database, id: number): Promise<number> {
  return db.delete<Pick<Session, 'id'>>('sessions').filter({ id }).executeReturnCount();
}
```

---

## How do I combine multiple filter conditions?

**Solution** — Every condition accumulates with AND: chained `filter()` calls, chained `filterByExpression()` calls, and mixes of the two. Use `.or(...)` inside the expression DSL for OR branches.

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface Account {
  id: number;
  active: boolean;
  status: string;
  balance: number;
  last_login: string;
}

interface AccountCount {
  count: number;
}

export async function flagDormantAccounts(db: Database, maxBalance: number): Promise<number> {
  return (
    db
      .update<Account, Account>('accounts')
      .values({ status: 'dormant' })
      .filter({ active: false })
      // combined with AND: active = false AND (low balance OR never logged in)
      .filterByExpression((q) => q.where('balance').lessThan(maxBalance).or('last_login').isNull())
      .executeReturnCount()
  );
}

export async function countPendingOrStaleAccounts(
  db: Database,
  cutoff: string
): Promise<number> {
  const filter = query<Account>()
    .where('status')
    .equals('pending')
    .or('last_login')
    .lessThan(cutoff)
    .compile();

  const row = await db
    .from<AccountCount>('accounts')
    .select({ count: 'COUNT(*)' })
    .byExpression(filter)
    .executeReturnSingle();

  return row?.count ?? 0;
}
```

---

## How do I run multiple statements in one transaction?

**Solution** — Put the statements inside `db.withTransaction(async (tx) => ...)` and build them on `tx`, not on `db`. If the callback throws, the adapter rolls back; if it resolves, the transaction commits and the callback's return value becomes the promise result.

```typescript
import { Database } from 'blendsdk/dbcore';

interface Order {
  id: number;
  status: string;
}

interface OrderEvent {
  id: number;
  order_id: number;
  event: string;
}

export async function cancelOrder(db: Database, orderId: number): Promise<number> {
  return db.withTransaction(async (tx) => {
    const updated = await tx
      .update<Order, Pick<Order, 'id'>>('orders')
      .values({ status: 'cancelled' })
      .filter({ id: orderId })
      .executeReturnCount();

    if (updated === 0) {
      // Throwing rolls the whole transaction back
      throw new Error(`Order ${orderId} was not found`);
    }

    return tx
      .insert<OrderEvent>('order_events')
      .values({ order_id: orderId, event: 'cancelled' })
      .executeReturnCount();
  });
}
```

---

## How do I execute raw parameterized SQL?

**Solution** — Call `db.executeQuery<R>()` with `:name` placeholders and a parameter object; the adapter binds the values and resolves with `QueryResult<R>` — or `null`. This is the same entry point every statement builder uses internally.

```typescript
import { Database } from 'blendsdk/dbcore';

interface RegionTotal {
  region: string;
  total: number;
}

export async function totalOrdersInRegion(db: Database, region: string): Promise<number> {
  const result = await db.executeQuery<RegionTotal>(
    'SELECT region, COUNT(*) AS total FROM orders WHERE region = :region GROUP BY region',
    { region }
  );

  return result?.records[0]?.total ?? 0;
}
```

---

## How do I transform parameters before execution and rows after execution?

**Solution** — Chain `beforeQuery()` to normalize the parameter object just before it is sent, and `afterQuery()` to transform the resolved rows. Both handlers are shape-preserving and are applied by the adapter during execution.

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface Customer {
  id: number;
  name: string;
  email: string;
}

export async function findCustomersByEmail(
  db: Database,
  rawEmail: string
): Promise<Partial<Customer>[]> {
  const filter = query<Pick<Customer, 'email'>>().where('email').equals(rawEmail).compile();

  return db
    .from<Customer>('customers')
    .select(['id', 'name', 'email'])
    .byExpression(filter)
    .beforeQuery<Record<string, unknown>>((params) => {
      // normalize string parameters (trim, lowercase) before they are sent
      const normalized: Record<string, unknown> = { ...params };
      for (const [key, value] of Object.entries(normalized)) {
        if (typeof value === 'string') {
          normalized[key] = value.trim().toLowerCase();
        }
      }
      return normalized;
    })
    .afterQuery<Partial<Customer>[]>((rows) =>
      // transform the resolved rows (e.g. derive a display name)
      rows.map((row) => ({ ...row, name: (row.name ?? '').toUpperCase() }))
    )
    .executeReturnAll();
}
```

---

## How do I create a reusable read service for a table?

**Solution** — Extend `QueryDataService<T>` to add domain-specific finders, or bind a service class to a relation in one line with `createQueryService<T>(relation, idColumn)`. Both provide `findById()`, `findByExpression()`, `findAllByExpression()`, and `findAll()`.

```typescript
import {
  Database,
  PromiseOfRecord,
  PromiseOfRecordSet,
  QueryDataService,
  createQueryService,
} from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

class UserService extends QueryDataService<User> {
  constructor(db: Database) {
    super('users', 'id', db);
  }

  findByEmail(email: string): PromiseOfRecord<User | null> {
    return this.findByExpression((q) => q.where('email').equals(email));
  }

  findActive(): PromiseOfRecordSet<User> {
    return this.findAllByExpression((q) => q.where('active').equals(true));
  }
}

const UserQueryService = createQueryService<User>('users', 'id');

export async function loadUserSummary(db: Database, userId: number): Promise<string> {
  const byId = await new UserQueryService(db).findById(userId);
  const active = await new UserService(db).findActive();
  return byId ? `User found; ${active.length} active users in total.` : 'User not found.';
}
```

---

## How do I avoid stale state when reusing a statement builder?

**Solution** — Two behaviors matter when a builder is reused: the filter expression is compiled once and cached, and `values()` / `returning()` replace their previous state instead of merging. Create a fresh statement for each execution — the `Database` factory methods are cheap — or configure the statement completely before its first execution.

```typescript
import { Database } from 'blendsdk/dbcore';

interface Task {
  id: number;
  title: string;
  done: boolean;
}

export async function completeTaskIds(db: Database, ids: number[]): Promise<number> {
  let affected = 0;

  for (const id of ids) {
    // A fresh, fully configured statement per execution
    affected += await db
      .update<Task, Pick<Task, 'id'>>('tasks')
      .values({ done: true })
      .filter({ id })
      .executeReturnCount();
  }

  return affected;
}
```

Filters added after the first execution never reach the cached compilation result:

```typescript
// typescript fragment — the second filter is ignored: the first execution cached the WHERE clause
const statement = db.delete<Task>('tasks');
await statement.filter({ done: true }).executeReturnCount();
await statement.filter({ id: 7 }).executeReturnCount(); // still runs with done = true
```

The payload methods replace, they do not merge:

```typescript
// typescript fragment — only the last payload and the last returning list are sent
const statement = db.update<Task, Pick<Task, 'id'>>('tasks');
statement.values({ title: 'First' });
statement.values({ done: true }); // replaces { title: 'First' }
statement.returning(['id']).returning('*'); // '*' replaces ['id']
```

---

## How do I implement a `Database` adapter for my driver?

**Solution** — Extend `Database` and implement `connect()`, `disconnect()`, `executeQuery()`, `withTransaction()`, and the `insert()` / `update()` / `delete()` factories, each returning your dialect's concrete statement classes. The in-memory adapter below shows the full contract in action, including the cached filter compilation consumed by the UPDATE and DELETE builders.

```typescript
import {
  Database,
  DatabaseConfig,
  DeleteStatement,
  ExecuteQueryOptions,
  InsertStatement,
  QueryResult,
  UpdateStatement,
} from 'blendsdk/dbcore';

type ParameterBag = Record<string, unknown>;

class MemoryInsertStatement<T> extends InsertStatement<T> {
  protected buildQuery(): string {
    const columns = Object.keys(this._values);
    const placeholders = columns.map((column) => `:${column}`);
    const returning = this._returning.length > 0 ? ` RETURNING ${this._returning.join(', ')}` : '';
    return `INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})${returning}`;
  }

  protected buildParameters(): Partial<T> {
    return this._values;
  }
}

class MemoryUpdateStatement<T, F> extends UpdateStatement<T, F> {
  protected buildQuery(): string {
    const assignments = Object.keys(this._values).map((column) => `${column} = :v_${column}`);
    // getCompiledExpression() is cached, so buildQuery() and buildParameters() share one compile
    const filter = this.getCompiledExpression();
    const where = filter ? ` WHERE ${filter.sql}` : '';
    const returning = this._returning.length > 0 ? ` RETURNING ${this._returning.join(', ')}` : '';
    return `UPDATE ${this.tableName} SET ${assignments.join(', ')}${where}${returning}`;
  }

  protected buildParameters(): ParameterBag {
    const params: ParameterBag = {};
    for (const [column, value] of Object.entries(this._values)) {
      params[`v_${column}`] = value;
    }
    const filter = this.getCompiledExpression();
    if (filter) {
      Object.assign(params, filter.params);
    }
    return params;
  }
}

class MemoryDeleteStatement<F> extends DeleteStatement<F> {
  protected buildQuery(): string {
    const filter = this.getCompiledExpression();
    const where = filter ? ` WHERE ${filter.sql}` : '';
    const returning = this._returning.length > 0 ? ` RETURNING ${this._returning.join(', ')}` : '';
    return `DELETE FROM ${this.tableName}${where}${returning}`;
  }

  protected buildParameters(): ParameterBag {
    const filter = this.getCompiledExpression();
    return filter ? { ...filter.params } : {};
  }
}

export class MemoryDatabase extends Database {
  readonly executed: Array<{ query: string; params: ParameterBag | undefined }> = [];

  constructor(config: DatabaseConfig = { database: 'memory' }) {
    super(config);
  }

  async connect(): Promise<void> {
    this.executed.length = 0;
  }

  async disconnect(_timeoutMs?: number): Promise<void> {
    this.executed.length = 0;
  }

  async executeQuery<R>(
    query: string,
    params?: ParameterBag,
    options?: ExecuteQueryOptions
  ): Promise<QueryResult<R> | null> {
    let finalParams = params;
    if (params && options?.beforeQuery) {
      finalParams = options.beforeQuery(params);
    }
    this.executed.push({ query, params: finalParams });
    return { records: [], rowCount: 0 };
  }

  async withTransaction<T>(fn: (db: this) => Promise<T>): Promise<T> {
    return fn(this);
  }

  insert<T>(tableName: string): InsertStatement<T> {
    return new MemoryInsertStatement<T>(tableName, this);
  }

  update<T, F>(tableName: string): UpdateStatement<T, F> {
    return new MemoryUpdateStatement<T, F>(tableName, this);
  }

  delete<F>(tableName: string): DeleteStatement<F> {
    return new MemoryDeleteStatement<F>(tableName, this);
  }
}

interface User {
  id: number;
  name: string;
}

export async function collectExecutedSql(): Promise<string[]> {
  const db = new MemoryDatabase({ database: 'demo' });
  await db.connect();

  await db
    .insert<User>('users')
    .values({ id: 1, name: 'Ada' })
    .returning(['id'])
    .executeReturnCount();

  await db
    .update<User, Pick<User, 'id'>>('users')
    .values({ name: 'Ada Lovelace' })
    .filter({ id: 1 })
    .executeReturnCount();

  const sql = db.executed.map((entry) => entry.query);
  await db.disconnect();
  return sql;
}
```

For a real driver, replace the body of `executeQuery()` with a call to the driver's query method (applying `options.beforeQuery` to the parameters and `options.afterQuery` to the result rows), and point `connect()` / `disconnect()` at the driver's connection lifecycle.

---

# dbcore Examples Library

This library is a categorized collection of copy-paste ready examples for `blendsdk/dbcore`. Every example is complete and self-contained: it includes all imports, declares the row interfaces it needs, and compiles under strict TypeScript.

Two conventions apply throughout:

- **The `db` parameter** — `blendsdk/dbcore` is database-agnostic. Statement examples receive a `db: Database` argument — an instance of a concrete adapter (PostgreSQL, MySQL, or any other backend) created by the host application. Category 10 contains a complete adapter implementation you can copy and run.
- **Expression imports** — the filter DSL (`query`, `QueryBuilder`, `CompileResult`) lives in `blendsdk/expression`, not in this package. Examples that build WHERE clauses import `query` from `blendsdk/expression` directly.

### Category index

| # | Category | What it covers |
| --- | --- | --- |
| 1 | Connections and Raw Queries | `connect()`, `disconnect()`, `executeQuery()`, execution options |
| 2 | SELECT Queries | `from()`, `selectAll()`, `select()`, `byExpression()` |
| 3 | INSERT Operations | `insert()`, `values()`, `returning()` |
| 4 | UPDATE Operations | `update()`, `filter()`, `filterByExpression()` |
| 5 | DELETE Operations | `delete()`, filters, and `RETURNING` |
| 6 | Expression Filtering Patterns | Comparisons, `OR` branches, nested groups |
| 7 | Statement Lifecycle Hooks | `beforeQuery()`, `afterQuery()` |
| 8 | Transactions | `withTransaction()` |
| 9 | Query Data Services | `QueryDataService`, `createQueryService()` |
| 10 | Implementing a Database Adapter | A complete concrete `Database` implementation |

---

## 1. Connections and Raw Queries

All examples in this category take a `db: Database` parameter — a concrete adapter supplied by your application.

### 1.1 Open and close a connection safely

`connect()` must run before any query and `disconnect()` releases the driver's resources. This helper guarantees the cleanup step runs and passes a five-second graceful-shutdown timeout to `disconnect()`.

```typescript
import { Database } from 'blendsdk/dbcore';

/**
 * Opens the connection, runs `fn`, and always closes the connection
 * afterwards — even when `fn` throws.
 */
export async function withConnection<T>(
  db: Database,
  fn: (db: Database) => Promise<T>
): Promise<T> {
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.disconnect(5_000);
  }
}
```

### 1.2 Execute a parameterized query

Run raw SQL and receive a typed `QueryResult<R>`. Values travel as bound parameters (`:year`), never as string-concatenated literals.

```typescript
import { Database, QueryResult } from 'blendsdk/dbcore';

interface MonthlyTotal {
  month: string;
  total: number;
}

export async function monthlyTotals(
  db: Database,
  year: number
): Promise<QueryResult<MonthlyTotal> | null> {
  return db.executeQuery<MonthlyTotal>(
    `SELECT to_char(created_at, 'YYYY-MM') AS month, SUM(total) AS total
       FROM orders
      WHERE EXTRACT(YEAR FROM created_at) = :year
      GROUP BY month
      ORDER BY month`,
    { year }
  );
}
// -> { records: [{ month: '2024-01', total: 1299.5 }, { month: '2024-02', total: 980 }], rowCount: 2 }
```

### 1.3 Transform parameters and rows with execution options

`ExecuteQueryOptions` carries two hooks: `beforeQuery` transforms the parameter object before the driver sees it, and `afterQuery` transforms the raw result rows before the promise resolves.

```typescript
import { Database, QueryResult } from 'blendsdk/dbcore';

interface UserRow {
  id: number;
  name: string;
  lastLogin: string;
}

export async function searchUsers(
  db: Database,
  term: string,
  limit: number
): Promise<QueryResult<UserRow> | null> {
  return db.executeQuery<UserRow>(
    'SELECT id, name, last_login AS lastLogin FROM users WHERE name LIKE :term ORDER BY name LIMIT :limit',
    { term, limit },
    {
      beforeQuery: (params) => ({ ...params, term: `%${String(params.term).trim()}%` }),
      afterQuery: (rows) => rows.map((row) => ({ ...row, name: String(row.name).toUpperCase() })),
    }
  );
}
// beforeQuery trims the search term and wraps it in LIKE wildcards;
// afterQuery upper-cases names before the result resolves.
// -> { records: [{ id: 3, name: 'ALICE', lastLogin: '2024-04-12T08:30:00.000Z' }], rowCount: 1 }
```

---

## 2. SELECT Queries

`FromStatement` is the only concrete statement builder in the package — SELECT building is fully implemented here; only execution is adapter-specific. SQL shown in comments is what the builder renders before the adapter binds the parameters.

### 2.1 Select all columns

`selectAll()` is a shorthand for `from().select()` — both configure `SELECT *`. `executeReturnAll()` unwraps the result to the records array (or `[]`).

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
}

export async function listUsers(db: Database): Promise<Partial<User>[]> {
  return db.selectAll<User>('users').executeReturnAll();
}

export async function listUsersExplicit(db: Database): Promise<Partial<User>[]> {
  return db.from<User>('users').select().executeReturnAll();
}
// Both execute: SELECT * FROM users
// -> [{ id: 1, name: 'Alice', email: 'alice@example.com' }, { id: 2, name: 'Bob', email: 'bob@example.com' }]
```

### 2.2 Select specific columns

An array argument to `select()` is used verbatim as the column list.

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
}

export async function listUserSummaries(db: Database): Promise<Partial<User>[]> {
  return db
    .from<User>('users')
    .select(['id', 'name'])
    .executeReturnAll();
}
// Executes: SELECT id, name FROM users
// -> [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]
```

### 2.3 Project aliased expressions

Object-form `select()` maps each key to an alias: every entry renders `<expression> AS <alias>`.

```typescript
import { Database } from 'blendsdk/dbcore';

interface UserNameProjection {
  fullName: string;
}

export async function listFullNames(db: Database): Promise<Partial<UserNameProjection>[]> {
  return db
    .from<UserNameProjection>('users')
    .select({ fullName: "first_name || ' ' || last_name" })
    .executeReturnAll();
}
// Executes: SELECT first_name || ' ' || last_name AS fullName FROM users
// -> [{ fullName: 'Alice Johnson' }, { fullName: 'Bob Smith' }]
```

### 2.4 Filter rows with a compiled expression

`byExpression()` accepts a `CompileResult` from `blendsdk/expression` and stores both its WHERE SQL and its bound parameters on the statement.

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

export async function listActiveUsers(db: Database): Promise<Partial<User>[]> {
  const filter = query<User>().where('active').equals(true).compile();

  return db
    .from<User>('users')
    .select(['id', 'name', 'email'])
    .byExpression(filter)
    .executeReturnAll();
}
// Executes: SELECT id, name, email FROM users WHERE active = :p1
// (the compiled filter supplies both the WHERE SQL and the bound parameters)
// -> [{ id: 1, name: 'Alice', email: 'alice@example.com' }]
```

---

## 3. INSERT Operations

INSERT, UPDATE, and DELETE builders are abstract; the SQL shown in comments reflects a typical named-parameter adapter — like the one built in category 10. Exact output is dialect-specific.

### 3.1 Insert and return generated fields

`returning()` adds a `RETURNING` clause, so auto-generated values such as IDs come back with the insert.

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
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
// Renders: INSERT INTO users (name, email) VALUES (:name, :email) RETURNING id, created_at
// -> { id: 42, created_at: '2024-05-01T10:00:00.000Z' }
```

### 3.2 Insert with partial values

`values()` accepts a partial object — only the listed columns are included in the statement; everything else falls back to database defaults. `returning('*')` retrieves the complete inserted row.

```typescript
import { Database } from 'blendsdk/dbcore';

interface Task {
  id: number;
  title: string;
  status: string;
  priority: number;
}

export async function createTask(db: Database, title: string): Promise<Partial<Task> | null> {
  return db
    .insert<Task>('tasks')
    .values({ title })
    .returning('*')
    .executeReturnSingle();
}
// Only `title` is sent; `status` and `priority` use column defaults.
// -> { id: 7, title: 'Write examples', status: 'open', priority: 3 }
```

### 3.3 Insert without a RETURNING clause

When you only need confirmation, skip `returning()` and use `executeReturnCount()` — the promise resolves with the affected-row count.

```typescript
import { Database } from 'blendsdk/dbcore';

interface AuditEvent {
  id: number;
  event: string;
  created_at: string;
}

export async function recordLogin(db: Database, userId: number): Promise<number> {
  return db
    .insert<AuditEvent>('audit_events')
    .values({ event: `user.login:${userId}`, created_at: new Date().toISOString() })
    .executeReturnCount();
}
// Renders: INSERT INTO audit_events (event, created_at) VALUES (:event, :created_at)
// -> 1
```

---

## 4. UPDATE Operations

### 4.1 Update by primary key with RETURNING

The second generic parameter (`FilterType`) is separate from the table type, so `filter()` can be narrowed to just the key column while `values()` and `returning()` use the full row shape.

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
  role: string;
}

export async function promoteUser(db: Database, id: number): Promise<Partial<User> | null> {
  return db
    .update<User, { id: number }>('users')
    .values({ role: 'admin' })
    .filter({ id })
    .returning(['id', 'role'])
    .executeReturnSingle();
}
// Renders: UPDATE users SET role = :v_role WHERE id = :p1 RETURNING id, role
// -> { id: 1, role: 'admin' }
```

### 4.2 Update with an expression filter

`filterByExpression()` gives full access to the `blendsdk/expression` DSL within `filterable-statement` operations; `executeReturnCount()` reports how many rows were updated.

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  status: string;
  last_login: string;
}

export async function archiveInactiveUsers(db: Database, cutoff: string): Promise<number> {
  return db
    .update<User, User>('users')
    .values({ status: 'archived' })
    .filterByExpression((q) => q.where('last_login').lessThan(cutoff))
    .executeReturnCount();
}
// Renders: UPDATE users SET status = :v_status WHERE last_login < :p1
// -> 12 (rows updated)
```

### 4.3 Combine simple and expression filters

`filter()` and `filterByExpression()` can be chained on the same statement — every predicate is merged with AND logic.

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  active: boolean;
  last_login: string;
}

export async function deactivateStaleUsers(db: Database, cutoff: string): Promise<number> {
  return db
    .update<User, Pick<User, 'active' | 'last_login'>>('users')
    .values({ active: false })
    .filter({ active: true })
    .filterByExpression((q) => q.where('last_login').lessThan(cutoff))
    .executeReturnCount();
}
// Both predicates combined with AND: WHERE active = true AND last_login < :p1
// -> 6
```

---

## 5. DELETE Operations

### 5.1 Delete by primary key and return the deleted row

Because `CrudStatement` provides `returning()`, a DELETE can hand back the rows it removed — useful for undo buffers and audit logs.

```typescript
import { Database } from 'blendsdk/dbcore';

interface Session {
  id: number;
  user_id: number;
  expires_at: string;
}

export async function revokeSession(db: Database, id: number): Promise<Partial<Session> | null> {
  return db
    .delete<Session>('sessions')
    .filter({ id })
    .returning('*')
    .executeReturnSingle();
}
// Renders: DELETE FROM sessions WHERE id = :p1 RETURNING *
// -> { id: 9, user_id: 4, expires_at: '2024-06-01T00:00:00.000Z' }
```

### 5.2 Delete with an expression and collect deleted rows

Combine `filterByExpression()` with `returning([...])` and `executeReturnAll()` to purge rows and capture what was removed.

```typescript
import { Database } from 'blendsdk/dbcore';

interface ExpiredSession {
  id: number;
  expires_at: string;
}

export async function purgeExpiredSessions(
  db: Database,
  now: string
): Promise<Partial<ExpiredSession>[]> {
  return db
    .delete<ExpiredSession>('sessions')
    .filterByExpression((q) => q.where('expires_at').lessThan(now))
    .returning(['id'])
    .executeReturnAll();
}
// Renders: DELETE FROM sessions WHERE expires_at < :p1 RETURNING id
// -> [{ id: 31 }, { id: 47 }]
```

### 5.3 Count deleted rows

When only the number matters, skip `returning()` and resolve the affected-row count directly.

```typescript
import { Database } from 'blendsdk/dbcore';

export async function deleteDrafts(db: Database): Promise<number> {
  return db
    .delete<{ status: string }>('articles')
    .filter({ status: 'draft' })
    .executeReturnCount();
}
// Renders: DELETE FROM articles WHERE status = :p1
// -> 5
```

---

## 6. Expression Filtering Patterns

All predicates in this category are compiled by `blendsdk/expression` and applied with `byExpression()` (SELECT) or `filterByExpression()` (UPDATE / DELETE).

### 6.1 Range comparisons

Chain comparison operators such as `greaterThan()` and `lessThan()` after `where()` or `or()` columns.

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  age: number;
}

export async function findUsersOlderThan(db: Database, age: number): Promise<Partial<User>[]> {
  const filter = query<User>().where('age').greaterThan(age).compile();

  return db
    .from<User>('users')
    .select(['id', 'name', 'age'])
    .byExpression(filter)
    .executeReturnAll();
}
// Where clause: age > :p1 (bound as a parameter, never interpolated)
// -> [{ id: 4, name: 'Dan', age: 71 }]
```

### 6.2 OR alternatives

`or()` introduces an alternative branch with the same comparison chain — `where(...)...or(...)` produces a flat OR predicate.

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  age: number;
  status: string;
}

export async function findEdgeCaseUsers(db: Database): Promise<Partial<User>[]> {
  const filter = query<User>()
    .where('age')
    .greaterThan(65)
    .or('status')
    .equals('inactive')
    .compile();

  return db
    .from<User>('users')
    .select(['id', 'age', 'status'])
    .byExpression(filter)
    .executeReturnAll();
}
// Where clause: age > 65 OR status = 'inactive'
// -> [{ id: 7, age: 68, status: 'active' }, { id: 12, age: 44, status: 'inactive' }]
```

### 6.3 Nested condition groups

`and()` accepts a callback that builds a nested group with its own `OR` branches — useful for combining a mandatory scope with optional staleness criteria, as in this purge that keeps rows untouched since they were last edited.

```typescript
import { Database } from 'blendsdk/dbcore';

interface Article {
  id: number;
  category: string;
  created_at: string;
  updated_at: string | null;
}

export async function deleteStaleArticles(db: Database, cutoff: string): Promise<number> {
  return db
    .delete<Article>('articles')
    .filterByExpression((q) =>
      q
        .where('category')
        .equals('archived')
        .and((sub) => sub.where('created_at').lessThan(cutoff).or('updated_at').isNull())
    )
    .executeReturnCount();
}
// Where clause: category = 'archived' AND (created_at < :p1 OR updated_at IS NULL)
// -> 4
```

---

## 7. Statement Lifecycle Hooks

Every statement exposes the same `beforeQuery` / `afterQuery` hooks as `ExecuteQueryOptions`. The handlers must be shape-preserving: they receive a value and return the same type.

### 7.1 Normalize parameters before execution

The `beforeQuery` hook receives the bound parameter object immediately before execution. Because parameter names are generated during compilation, write the hook name-agnostically — here it trims every string value.

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
}

export async function findUserByName(db: Database, name: string): Promise<Partial<User> | null> {
  const filter = query<User>().where('name').equals(name).compile();

  return db
    .from<User>('users')
    .select(['id', 'name'])
    .byExpression(filter)
    .beforeQuery<Record<string, unknown>>((params) =>
      Object.fromEntries(
        Object.entries(params).map(
          ([key, value]): [string, unknown] => [key, typeof value === 'string' ? value.trim() : value]
        )
      )
    )
    .executeReturnSingle();
}
// beforeQuery trims every bound string, so "  Alice  " matches the stored "Alice".
// -> { id: 1, name: 'Alice' }
```

### 7.2 Post-process result rows

The `afterQuery` hook receives the raw result-row array. This statement redacts e-mail addresses before the records leave the query layer.

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
}

export async function listMaskedUsers(db: Database): Promise<Partial<User>[]> {
  return db
    .from<User>('users')
    .select(['id', 'name', 'email'])
    .afterQuery<Partial<User>[]>((rows) =>
      rows.map((row) => ({
        ...row,
        email: row.email ? row.email.replace(/(.{2}).*(@.*)/, '$1***$2') : row.email,
      }))
    )
    .executeReturnAll();
}
// -> [{ id: 1, name: 'Alice', email: 'al***@example.com' }]
```

---

## 8. Transactions

`withTransaction<T>(fn)` executes the callback on the same connection atomically: if the callback resolves, the transaction commits; if it throws, the transaction rolls back and the error propagates.

### 8.1 Run statements atomically

The callback receives the transactional database handle (`tx`); build every statement inside it so they share one transaction.

```typescript
import { Database } from 'blendsdk/dbcore';

interface Order {
  id: number;
  customer_id: number;
  total: number;
}

interface AuditEvent {
  id: number;
  event: string;
  entity: string;
}

export async function placeOrder(
  db: Database,
  customerId: number,
  total: number
): Promise<Partial<Order> | null> {
  return db.withTransaction(async (tx) => {
    const order = await tx
      .insert<Order>('orders')
      .values({ customer_id: customerId, total })
      .returning(['id', 'total'])
      .executeReturnSingle();

    await tx
      .insert<AuditEvent>('audit_events')
      .values({ event: 'order.created', entity: `order:${order?.id ?? 'unknown'}` })
      .executeReturnCount();

    return order;
  });
}
// Both INSERTs run in one transaction — commit on resolve, rollback on throw.
// -> { id: 51, total: 249.9 }
```

### 8.2 Roll back on business-rule failure

Throw inside the callback to trigger a rollback. Catching the error outside the transaction turns it into a domain result — the balance is untouched when the check fails.

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface Account {
  id: number;
  balance: number;
}

export async function chargeAccount(db: Database, id: number, amount: number): Promise<boolean> {
  try {
    await db.withTransaction(async (tx) => {
      const filter = query<Account>().where('id').equals(id).compile();
      const account = await tx
        .from<Account>('accounts')
        .select(['id', 'balance'])
        .byExpression(filter)
        .executeReturnSingle();

      if (!account || (account.balance ?? 0) < amount) {
        throw new Error('Insufficient funds');
      }

      await tx
        .update<Account, { id: number }>('accounts')
        .values({ balance: (account.balance ?? 0) - amount })
        .filter({ id })
        .executeReturnCount();
    });
    return true;
  } catch {
    // The transaction was rolled back — the balance is unchanged.
    return false;
  }
}
// -> true after a successful commit; false after a rollback.
```

---

## 9. Query Data Services

`QueryDataService<RelationType>` is a repository-style base class for read patterns on a single relation. All find methods return `Partial<RelationType>` records (`null` for single-record lookups, `[]` for record sets).

### 9.1 Define a service class and find by primary key

Extend `QueryDataService` with the relation name, the primary-key column, and the database instance; `findById()` then builds and executes the lookup for you.

```typescript
import { Database, QueryDataService } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

class UserService extends QueryDataService<User> {
  constructor(db: Database) {
    super('users', 'id', db);
  }
}

export async function getUserById(db: Database, id: number): Promise<Partial<User> | null> {
  const service = new UserService(db);
  return service.findById(id);
}
// Executes: SELECT * FROM users WHERE id = :p1
// -> { id: 1, name: 'Alice', email: 'alice@example.com', active: true } (null when not found)
```

### 9.2 Find a single row by expression

`findByExpression()` accepts an `ExpressionBuilder<RelationType>` callback. The callback returns `void` — configure the query builder inside the body; the first matching record (or `null`) is returned.

```typescript
import { Database, QueryDataService } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

class UserService extends QueryDataService<User> {
  constructor(db: Database) {
    super('users', 'id', db);
  }
}

export async function findUserByEmail(db: Database, email: string): Promise<Partial<User> | null> {
  const service = new UserService(db);
  return service.findByExpression((q) => {
    q.where('email').equals(email);
  });
}
// Executes: SELECT * FROM users WHERE email = :p1
// -> { id: 3, name: 'Carol', email: 'carol@example.com', active: true }
```

### 9.3 Find all matching rows by expression

`findAllByExpression()` is the record-set counterpart of `findByExpression()` — it resolves to every match, or `[]` when none exist.

```typescript
import { Database, QueryDataService } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  active: boolean;
}

class UserService extends QueryDataService<User> {
  constructor(db: Database) {
    super('users', 'id', db);
  }
}

export async function findActiveUsers(db: Database): Promise<Partial<User>[]> {
  const service = new UserService(db);
  return service.findAllByExpression((q) => {
    q.where('active').equals(true);
  });
}
// Executes: SELECT * FROM users WHERE active = :p1
// -> [{ id: 1, name: 'Alice', active: true }, { id: 3, name: 'Carol', active: true }]
```

### 9.4 Find all rows

`findAll()` runs an unfiltered `SELECT *` against the relation.

```typescript
import { Database, QueryDataService } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

class UserService extends QueryDataService<User> {
  constructor(db: Database) {
    super('users', 'id', db);
  }
}

export async function listAllUsers(db: Database): Promise<Partial<User>[]> {
  const service = new UserService(db);
  return service.findAll();
}
// Executes: SELECT * FROM users
// -> [{ id: 1, name: 'Alice', ... }, { id: 2, name: 'Bob', ... }, ...]
```

### 9.5 Create a service with the factory

`createQueryService()` removes the boilerplate of declaring a subclass — it returns a concrete class whose constructor only needs the `Database` instance. The primary-key column can be any type, such as a text `sku` here.

```typescript
import { Database, createQueryService } from 'blendsdk/dbcore';

interface Product {
  sku: string;
  name: string;
  price: number;
}

const ProductService = createQueryService<Product>('products', 'sku');

export async function getProduct(db: Database, sku: string): Promise<Partial<Product> | null> {
  const service = new ProductService(db);
  return service.findById(sku);
}
// Executes: SELECT * FROM products WHERE sku = :p1
// -> { sku: 'ABC-123', name: 'Widget', price: 9.99 }
```

### 9.6 Extend a service with domain methods

Subclasses can add domain-specific queries and reach the full statement API through the protected `db` property inherited from `DataServiceBase`.

```typescript
import { Database, QueryDataService } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  active: boolean;
}

export class UserService extends QueryDataService<User> {
  constructor(db: Database) {
    super('users', 'id', db);
  }

  async findActive(): Promise<Partial<User>[]> {
    return this.findAllByExpression((q) => {
      q.where('active').equals(true);
    });
  }

  async deactivate(id: number): Promise<number> {
    return this.db
      .update<User, { id: number }>('users')
      .values({ active: false })
      .filter({ id })
      .executeReturnCount();
  }
}

export async function deactivateUser(db: Database, id: number): Promise<number> {
  const service = new UserService(db);
  return service.deactivate(id);
}
// -> 1 (rows updated)
```

---

## 10. Implementing a Database Adapter

### 10.1 A complete recording adapter

This is the full adapter contract in one copy-paste block: concrete INSERT, UPDATE, and DELETE builders that render named-parameter SQL (including WHERE clauses from the cached compiled filter and `RETURNING` clauses), plus a `Database` subclass that records every statement it is asked to run. Swap the recording bodies for real driver calls to turn it into a production adapter — `FromStatement` needs no override because SELECT building is already implemented by the package.

```typescript
import {
  Database,
  DatabaseConfig,
  DeleteStatement,
  ExecuteQueryOptions,
  InsertStatement,
  QueryResult,
  UpdateStatement,
} from 'blendsdk/dbcore';

/** Row shape for the notes table used by the demo below. */
interface Note {
  id: number;
  title: string;
  done: boolean;
}

/** Parameters are forwarded to the driver as a plain object. */
type ParameterBag = Record<string, unknown>;

/** Concrete INSERT builder: columns, named placeholders, and RETURNING. */
class MemoryInsertStatement<T> extends InsertStatement<T> {
  protected buildQuery(): string {
    const columns = Object.keys(this._values);
    const placeholders = columns.map((column) => `:${column}`);
    const returning = this._returning.length > 0 ? ` RETURNING ${this._returning.join(', ')}` : '';
    return `INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})${returning}`;
  }

  protected buildParameters(): Partial<T> {
    return this._values;
  }
}

/** Concrete UPDATE builder: SET assignments plus the compiled WHERE clause. */
class MemoryUpdateStatement<T, F> extends UpdateStatement<T, F> {
  protected buildQuery(): string {
    const assignments = Object.keys(this._values).map((column) => `${column} = :v_${column}`);
    const filter = this.getCompiledExpression();
    const where = filter ? ` WHERE ${filter.sql}` : '';
    const returning = this._returning.length > 0 ? ` RETURNING ${this._returning.join(', ')}` : '';
    return `UPDATE ${this.tableName} SET ${assignments.join(', ')}${where}${returning}`;
  }

  protected buildParameters(): ParameterBag {
    const params: ParameterBag = {};
    for (const [column, value] of Object.entries(this._values)) {
      params[`v_${column}`] = value;
    }
    const filter = this.getCompiledExpression();
    if (filter) {
      Object.assign(params, filter.params);
    }
    return params;
  }
}

/** Concrete DELETE builder: compiled WHERE clause and optional RETURNING. */
class MemoryDeleteStatement<F> extends DeleteStatement<F> {
  protected buildQuery(): string {
    const filter = this.getCompiledExpression();
    const where = filter ? ` WHERE ${filter.sql}` : '';
    const returning = this._returning.length > 0 ? ` RETURNING ${this._returning.join(', ')}` : '';
    return `DELETE FROM ${this.tableName}${where}${returning}`;
  }

  protected buildParameters(): ParameterBag {
    const filter = this.getCompiledExpression();
    return filter ? { ...filter.params } : {};
  }
}

/** Minimal adapter that records every statement it is asked to run. */
class InMemoryDatabase extends Database {
  readonly executed: Array<{ query: string; params: ParameterBag | undefined }> = [];
  private connected = false;

  constructor(config: DatabaseConfig = { database: 'in-memory' }) {
    super(config);
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async executeQuery<R>(
    query: string,
    params?: ParameterBag,
    options?: ExecuteQueryOptions
  ): Promise<QueryResult<R> | null> {
    const finalParams = options?.beforeQuery && params ? options.beforeQuery(params) : params;
    this.executed.push({ query, params: finalParams });
    return { records: [], rowCount: 0 };
  }

  async withTransaction<T>(fn: (db: this) => Promise<T>): Promise<T> {
    return fn(this);
  }

  insert<T>(tableName: string): InsertStatement<T> {
    return new MemoryInsertStatement<T>(tableName, this);
  }

  update<T, F>(tableName: string): UpdateStatement<T, F> {
    return new MemoryUpdateStatement<T, F>(tableName, this);
  }

  delete<F>(tableName: string): DeleteStatement<F> {
    return new MemoryDeleteStatement<F>(tableName, this);
  }
}

/** Exercises the adapter and returns the SQL it recorded. */
export async function runDemo(): Promise<string[]> {
  const db = new InMemoryDatabase({ database: 'demo' });
  await db.connect();

  await db
    .insert<Note>('notes')
    .values({ title: 'First note', done: false })
    .returning(['id'])
    .executeReturnSingle();

  await db
    .update<Note, { id: number }>('notes')
    .values({ done: true })
    .filter({ id: 1 })
    .returning('*')
    .executeReturnSingle();

  await db.from<Note>('notes').select(['id', 'title']).executeReturnAll();

  await db
    .delete<Note>('notes')
    .filter({ done: true })
    .executeReturnCount();

  await db.disconnect();

  return db.executed.map((entry) => entry.query);
}
// The recorder returns empty result sets, so the demo inspects db.executed:
// -> [
//   'INSERT INTO notes (title, done) VALUES (:title, :done) RETURNING id',
//   'UPDATE notes SET done = :v_done WHERE id = :p1 RETURNING *',
//   'SELECT id, title FROM notes',
//   'DELETE FROM notes WHERE done = :p1'
// ]
```

Note how the UPDATE and DELETE builders call `getCompiledExpression()` in both `buildQuery()` and `buildParameters()` — the expression is compiled once and the cached `CompileResult` is reused, so the WHERE SQL and its parameters always stay in sync.

---

For concept-level explanations behind these examples, see Core Concepts; for the package at a glance, start with the Overview; and for signature-level details of every export, see the API Reference.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
